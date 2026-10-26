import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { validateImageStructure } from '../validation/image';
export class ImageProcessingError extends Error {
  constructor(readonly code: 'PROCESSING_INVALID' | 'PROCESSING_TIMEOUT' | 'PROCESSING_MEMORY_LIMIT' | 'PROCESSING_CANCELLED' | 'PROCESSING_UNAVAILABLE') { super(code); this.name = 'ImageProcessingError'; }
}
export interface ProcessedImage { normalized: Buffer; thumbnail: Buffer; width: number; height: number; thumbnailWidth: number; thumbnailHeight: number; peakRssBytes: number }
interface Options { temporaryRoot?: string; workerFile?: string; deadlineMs?: number }
/** Resource limits are watchdogs, not an OS process/network sandbox. Enablement requires exact Linux runtime gates. */
export class ImageProcessor {
  private closed = false;
  private readonly children = new Set<ChildProcess>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly root: string;
  private readonly worker: string;
  private readonly deadline: number;
  constructor(options: Options = {}) {
    this.root = resolve(options.temporaryRoot ?? tmpdir());
    this.worker = options.workerFile ?? join(__dirname, 'image-worker.js');
    if (!isAbsolute(this.worker) || !this.worker.endsWith('.js')) throw new ImageProcessingError('PROCESSING_UNAVAILABLE');
    this.deadline = options.deadlineMs ?? 30000;
    if (!Number.isSafeInteger(this.deadline) || this.deadline < 1 || this.deadline > 30000) throw new ImageProcessingError('PROCESSING_UNAVAILABLE');
  }
  process(bytes: Buffer, declaration: { filename: string; mime: string }, signal?: AbortSignal): Promise<ProcessedImage> {
    if (this.closed || signal?.aborted) return Promise.reject(new ImageProcessingError('PROCESSING_CANCELLED'));
    if (this.active.size) return Promise.reject(new ImageProcessingError('PROCESSING_UNAVAILABLE'));
    const task = this.run(bytes, declaration, signal);
    this.active.add(task);
    void task.finally(() => this.active.delete(task)).catch(() => undefined);
    return task;
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const child of this.children) child.kill('SIGKILL');
    await Promise.allSettled([...this.active]);
  }
  private async run(bytes: Buffer, declaration: { filename: string; mime: string }, signal?: AbortSignal): Promise<ProcessedImage> {
    // Validate before disk allocation/native loading; copy prevents caller mutation after admission.
    const structure = validateImageStructure(bytes, declaration), input = Buffer.from(bytes);
    const directory = await mkdtemp(join(this.root, 'attachment-image-'));
    try {
      await chmod(directory, 0o700);
      if (this.closed || signal?.aborted) throw new ImageProcessingError('PROCESSING_CANCELLED');
      await writeFile(join(directory, 'input'), input, { mode: 0o600, flag: 'wx' });
      const peakRssBytes = await this.execute(directory, structure.format, signal);
      const readOutput = async (name: string, maximum: number): Promise<Buffer> => {
        const path = join(directory, name), info = await stat(path);
        if (!info.isFile() || info.size < 1 || info.size > maximum) throw new ImageProcessingError('PROCESSING_INVALID');
        return readFile(path);
      };
      const normalized = await readOutput('normalized.webp', 4194304), thumbnail = await readOutput('thumbnail.webp', 262144);
      const normal = validateImageStructure(normalized, { filename: 'normalized.webp', mime: 'image/webp' });
      const thumb = validateImageStructure(thumbnail, { filename: 'thumbnail.webp', mime: 'image/webp' });
      if (normal.metadataBytes || thumb.metadataBytes || Math.max(thumb.width, thumb.height) > 320) throw new ImageProcessingError('PROCESSING_INVALID');
      if (this.closed || signal?.aborted) throw new ImageProcessingError('PROCESSING_CANCELLED');
      return { normalized, thumbnail, width: normal.width, height: normal.height, thumbnailWidth: thumb.width, thumbnailHeight: thumb.height, peakRssBytes };
    } finally {
      // Only a path returned by this mkdtemp call, never a caller filename/prefix listing.
      if (resolve(directory).startsWith(this.root + sep) && directory.startsWith(join(this.root, 'attachment-image-'))) await rm(directory, { recursive: true, force: true });
    }
  }
  private execute(directory: string, format: string, signal?: AbortSignal): Promise<number> {
    return new Promise((accept, reject) => {
      if (this.closed || signal?.aborted) { reject(new ImageProcessingError('PROCESSING_CANCELLED')); return; }
      const environment: NodeJS.ProcessEnv = { UV_THREADPOOL_SIZE: '1', VIPS_CONCURRENCY: '1', OMP_NUM_THREADS: '1', TMPDIR: directory, TMP: directory, TEMP: directory };
      // Windows native DLL loading needs the system root, but never inherits secrets, NODE_OPTIONS, PATH or proxy variables.
      if (process.platform === 'win32' && process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
      const child = spawn(process.execPath, ['--max-old-space-size=64', '--max-semi-space-size=4', this.worker, directory, format], { shell: false, windowsHide: true, cwd: directory, env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      this.children.add(child);
      let peak = 0, failure: ImageProcessingError | undefined, finished = false, sampling = false;
      const stop = (code: ImageProcessingError['code']) => { failure ??= new ImageProcessingError(code); child.kill('SIGKILL'); };
      const observe = (rss: number) => {
        if (!Number.isSafeInteger(rss) || rss < 1) { stop('PROCESSING_UNAVAILABLE'); return; }
        peak = Math.max(peak, rss); if (rss > 192 * 1024 * 1024) stop('PROCESSING_MEMORY_LIMIT');
      };
      const cancel = () => stop('PROCESSING_CANCELLED');
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const timer = setTimeout(() => stop('PROCESSING_TIMEOUT'), this.deadline);
      const monitor = setInterval(() => {
        if (process.platform !== 'linux' || !child.pid || sampling || finished) return;
        sampling = true;
        void readFile('/proc/' + child.pid + '/status', 'utf8').then(status => {
          const rss = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
          if (rss) observe(Number(rss[1]) * 1024);
        }).catch(error => { if (!finished && error.code !== 'ENOENT') stop('PROCESSING_UNAVAILABLE'); }).finally(() => { sampling = false; });
      }, 25);
      child.on('message', message => {
        if (!message || typeof message !== 'object' || !('rss' in message)) { stop('PROCESSING_INVALID'); return; }
        if (typeof message.rss !== 'number') { stop('PROCESSING_UNAVAILABLE'); return; }
        observe(message.rss);
        if ('failure' in message) stop(message.failure === 'PROCESSING_TIMEOUT' ? 'PROCESSING_TIMEOUT' : 'PROCESSING_INVALID');
      });
      child.once('error', () => { failure ??= new ImageProcessingError('PROCESSING_UNAVAILABLE'); });
      child.once('close', code => {
        finished = true; signal?.removeEventListener('abort', cancel); clearTimeout(timer); clearInterval(monitor); this.children.delete(child);
        if (this.closed) reject(new ImageProcessingError('PROCESSING_CANCELLED'));
        else if (failure) reject(failure);
        else if (code !== 0 || !peak) reject(new ImageProcessingError('PROCESSING_INVALID'));
        else accept(peak);
      });
    });
  }
}
