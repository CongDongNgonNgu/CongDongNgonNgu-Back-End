import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import sharp from 'sharp';
import { ImageProcessor, ImageProcessingError } from './image-processor';
import { validateImageStructure } from '../validation/image';

describe('bounded isolated image processor', () => {
  let compiled: string;
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'attachment-image-tests-'));
    compiled = resolve('.image-worker-test-' + randomUUID());
    for (const directory of ['processing', 'validation']) {
      await mkdir(join(compiled, directory), { recursive: true });
      for (const name of await readdir(join(__dirname, '..', directory))) {
        if (!name.endsWith('.ts') || name.endsWith('.spec.ts')) continue;
        const source = await readFile(join(__dirname, '..', directory, name), 'utf8');
        await writeFile(join(compiled, directory, name.replace(/\.ts$/, '.js')), transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
      }
    }
  });
  afterAll(async () => {
    for (const path of [root, compiled]) {
      const absolute = resolve(path);
      if (!(absolute.startsWith(resolve(tmpdir()) + require('node:path').sep) || absolute.startsWith(process.cwd() + require('node:path').sep + '.image-worker-test-'))) throw Error('unsafe test cleanup');
      await rm(absolute, { recursive: true, force: true });
    }
  });
  function processor(options: { deadlineMs?: number } = {}) { return new ImageProcessor({ temporaryRoot: root, workerFile: join(compiled, 'processing/image-worker.js'), ...options }); }
  async function syntheticWorker(message: string, delayMs = 0): Promise<string> {
    const pixel = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).webp().toBuffer();
    const path = join(compiled, 'controlled-' + randomUUID() + '.js');
    // Controlled protocol injection only: RSS values below are NOT actual allocation measurements.
    await writeFile(path, [
      "const fs = require('node:fs'); const path = require('node:path'); const directory = process.argv[2];",
      "const bytes = Buffer.from('" + pixel.toString('base64') + "', 'base64');",
      "fs.writeFileSync(path.join(directory, 'worker-ready'), 'ready');",
      "setTimeout(() => { fs.writeFileSync(path.join(directory, 'normalized.webp'), bytes); fs.writeFileSync(path.join(directory, 'thumbnail.webp'), bytes); process.send(" + message + ", () => process.disconnect()); }, " + delayMs + ");",
    ].join('\n'));
    return path;
  }
  async function waitForReady(): Promise<void> {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const jobs = await readdir(root);
      for (const job of jobs) {
        try { if ((await readFile(join(root, job, 'worker-ready'), 'utf8')) === 'ready') return; } catch { /* Child has not reached its controlled readiness point. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('synthetic worker did not become ready');
  }
  it.each([
    ['above-threshold synthetic report', '{ rss: 201326593 }', 'PROCESSING_MEMORY_LIMIT'],
    ['missing RSS', '{}', 'PROCESSING_INVALID'],
    ['nonobject IPC', "'malformed'", 'PROCESSING_INVALID'],
    ['negative RSS', '{ rss: -1 }', 'PROCESSING_UNAVAILABLE'],
    ['fractional RSS', '{ rss: 1.5 }', 'PROCESSING_UNAVAILABLE'],
    ['numeric-string RSS', "{ rss: '123456' }", 'PROCESSING_UNAVAILABLE'],
    ['boolean RSS', '{ rss: true }', 'PROCESSING_UNAVAILABLE'],
  ])('rejects %s without publishing any derivative or leaving owned files', async (_name, message, code) => {
    const workerFile = await syntheticWorker(message);
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
    const service = new ImageProcessor({ temporaryRoot: root, workerFile });
    await expect(service.process(bytes, { filename: 'x.png', mime: 'image/png' })).rejects.toMatchObject({ code });
    expect(await readdir(root)).toEqual([]);
  });
  it.each(['timeout', 'cancel'] as const)('kills a ready worker with delayed success after %s and prevents late resurrection', async reason => {
    const workerFile = await syntheticWorker('{ rss: 1000000 }', 900);
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
    const controller = new AbortController();
    const service = new ImageProcessor({ temporaryRoot: root, workerFile, deadlineMs: reason === 'timeout' ? 700 : 2000 });
    const outcome = service.process(bytes, { filename: 'x.png', mime: 'image/png' }, controller.signal).then(() => ({ succeeded: true, code: '' }), error => ({ succeeded: false, code: error.code }));
    await waitForReady();
    if (reason === 'cancel') controller.abort();
    expect(await outcome).toEqual({ succeeded: false, code: reason === 'timeout' ? 'PROCESSING_TIMEOUT' : 'PROCESSING_CANCELLED' });
    expect(await readdir(root)).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 950));
    expect(await readdir(root)).toEqual([]);
  }, 5000);
  it.each(['jpeg', 'png', 'webp'] as const)('fully decodes %s, strips metadata and returns verified bounded derivatives', async format => {
    const input = await sharp({ create: { width: 500, height: 350, channels: 3, background: '#18436b' } }).withExif({ IFD0: { Artist: 'synthetic-private-marker' } }).withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
    const result = await processor().process(input, { filename: 'synthetic.' + (format === 'jpeg' ? 'jpg' : format), mime: 'image/' + format });
    for (const bytes of [result.normalized, result.thumbnail]) {
      const frame = validateImageStructure(bytes, { filename: 'safe.webp', mime: 'image/webp' });
      expect(frame.metadataBytes).toBe(0);
      expect(bytes.includes(Buffer.from('synthetic-private-marker'))).toBe(false);
      const metadata = await sharp(bytes, { failOn: 'warning' }).metadata();
      expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined(); expect(metadata.xmp).toBeUndefined();
      await expect(sharp(bytes, { failOn: 'warning' }).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
    }
    expect([result.width, result.height]).toEqual([350, 500]);
    expect(result.normalized.length).toBeLessThanOrEqual(4194304);
    expect(result.thumbnail.length).toBeLessThanOrEqual(262144);
    expect(Math.max(result.thumbnailWidth, result.thumbnailHeight)).toBeLessThanOrEqual(320);
    expect(result.peakRssBytes).toBeGreaterThan(0);
    expect(await readdir(root)).toEqual([]);
  }, 15000);
  it('bounds high entropy work and refuses simultaneous workers in one process', async () => {
    const pixels = Buffer.alloc(1000 * 1000 * 3); let seed = 123;
    for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = seed >>> 24; }
    const input = await sharp(pixels, { raw: { width: 1000, height: 1000, channels: 3 } }).png().toBuffer();
    const service = processor();
    const work = service.process(input, { filename: 'noise.png', mime: 'image/png' });
    await expect(service.process(input, { filename: 'noise.png', mime: 'image/png' })).rejects.toMatchObject({ code: 'PROCESSING_UNAVAILABLE' });
    const result = await work;
    expect(result.normalized.length).toBeLessThanOrEqual(4194304);
    expect(result.peakRssBytes).toBeLessThanOrEqual(192 * 1024 * 1024);
    expect(await readdir(root)).toEqual([]);
  }, 15000);
  it('rejects valid framing with corrupt compressed pixels rather than publishing a fallback', async () => {
    const input = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toBuffer();
    const offset = input.indexOf(Buffer.from('IDAT')) + 4;
    input[offset] = 0;
    // Repair CRC so framing passes and the full decoder must reject the entropy stream.
    let c = 0xffffffff; const typeOffset = offset - 4, size = input.readUInt32BE(typeOffset - 4);
    for (const b of input.subarray(typeOffset, offset + size)) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
    input.writeUInt32BE((c ^ 0xffffffff) >>> 0, offset + size);
    expect(validateImageStructure(input, { filename: 'x.png', mime: 'image/png' }).width).toBe(32);
    await expect(processor().process(input, { filename: 'x.png', mime: 'image/png' })).rejects.toBeInstanceOf(ImageProcessingError);
    expect(await readdir(root)).toEqual([]);
  });
  it('cancels one job through its caller signal and releases owned files', async () => {
    const bytes = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: 'red' } }).png().toBuffer();
    const controller = new AbortController();
    const service = processor();
    const work = service.process(bytes, { filename: 'x.png', mime: 'image/png' }, controller.signal);
    controller.abort();
    await expect(work).rejects.toMatchObject({ code: 'PROCESSING_CANCELLED' });
    expect(await readdir(root)).toEqual([]);
  });
  it('rejects excessive dimensions before spawning a decoder', async () => {
    const bytes = await sharp({ create: { width: 2001, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
    await expect(processor().process(bytes, { filename: 'x.png', mime: 'image/png' })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
  it('kills a deadline-expired child and cleans only its owned job directory', async () => {
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toBuffer();
    await writeFile(join(root, 'unrelated'), 'retain');
    await expect(processor({ deadlineMs: 1 }).process(bytes, { filename: 'x.png', mime: 'image/png' })).rejects.toMatchObject({ code: 'PROCESSING_TIMEOUT' });
    expect(await readFile(join(root, 'unrelated'), 'utf8')).toBe('retain');
    await rm(join(root, 'unrelated'));
    expect(await readdir(root)).toEqual([]);
  });
  it('cancels active work and refuses new work after shutdown', async () => {
    const bytes = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: 'red' } }).png().toBuffer();
    const service = processor();
    const work = service.process(bytes, { filename: 'x.png', mime: 'image/png' });
    await service.shutdown();
    await expect(work).rejects.toMatchObject({ code: 'PROCESSING_CANCELLED' });
    await expect(service.process(bytes, { filename: 'x.png', mime: 'image/png' })).rejects.toMatchObject({ code: 'PROCESSING_CANCELLED' });
    expect(await readdir(root)).toEqual([]);
  });
});
