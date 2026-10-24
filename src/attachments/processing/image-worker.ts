import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { validateImageStructure } from '../validation/image';
import { stripImageMetadata } from './strip-image-metadata';
sharp.cache(false);
sharp.concurrency(1);
function currentRss(): number {
  if (process.platform !== 'linux') return process.memoryUsage().rss;
  // Fresh-exec /proc high-water RSS, never inherited getrusage.ru_maxrss.
  const status = readFileSync('/proc/self/status', 'utf8');
  const highWater = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
  if (!highWater) throw Error('invalid memory observation');
  return Number(highWater[1]) * 1024;
}
const rss = () => process.send?.({ rss: currentRss() });
const heartbeat = setInterval(rss, 25);
rss();
async function stage<T>(work: Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await work;
  if (performance.now() - started > 10000) throw Error('PROCESSING_TIMEOUT');
  rss(); return result;
}
async function main(): Promise<void> {
  if (sharp.versions.sharp !== '0.35.5') throw Error('invalid processor version');
  const directory = process.argv[2], format = process.argv[3];
  if (!directory || resolve(directory) !== directory || !['jpeg', 'png', 'webp'].includes(format)) throw Error('invalid');
  const inputPath = join(directory, 'input');
  const inputStat = await stat(inputPath);
  if (!inputStat.isFile() || inputStat.size > 4194304) throw Error('invalid');
  const input = await readFile(inputPath);
  const declaration = { filename: 'source.' + (format === 'jpeg' ? 'jpg' : format), mime: 'image/' + format };
  const structure = validateImageStructure(input, declaration);
  const cleaned = stripImageMetadata(input, structure.format);
  const options: sharp.SharpOptions = { failOn: 'warning', limitInputPixels: 3000000, sequentialRead: true, animated: false, pages: 1, ignoreIcc: true };
  const create = () => {
    let image = sharp(cleaned.bytes, options).toColourspace('srgb');
    if (cleaned.orientation === 2) image = image.flop();
    if (cleaned.orientation === 3) image = image.rotate(180);
    if (cleaned.orientation === 4) image = image.flip();
    if (cleaned.orientation === 5) image = image.rotate(90).flip();
    if (cleaned.orientation === 6) image = image.rotate(90);
    if (cleaned.orientation === 7) image = image.rotate(90).flop();
    if (cleaned.orientation === 8) image = image.rotate(270);
    return image;
  };
  async function derivative(thumbnail: boolean): Promise<Buffer> {
    const started = performance.now();
    let image = create();
    if (thumbnail) image = image.resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true });
    const output = await image.webp({ quality: 82, effort: 2 }).timeout({ seconds: 10 }).toBuffer();
    if (output.length > (thumbnail ? 262144 : 4194304)) throw Error('invalid');
    const frame = validateImageStructure(output, { filename: 'output.webp', mime: 'image/webp' });
    if (frame.metadataBytes || (thumbnail && Math.max(frame.width, frame.height) > 320)) throw Error('invalid');
    // Force complete decoding of the generated derivative, not just a metadata probe.
    await sharp(output, options).raw().timeout({ seconds: 10 }).toBuffer();
    if (performance.now() - started > 10000) throw Error('PROCESSING_TIMEOUT');
    return output;
  }
  const normal = await stage(derivative(false));
  const thumb = await stage(derivative(true));
  if (input.length + normal.length + thumb.length > 64 * 1024 * 1024) throw Error('invalid');
  await writeFile(join(directory, 'normalized.webp'), normal, { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'thumbnail.webp'), thumb, { flag: 'wx', mode: 0o600 });
}
void main().then(() => { clearInterval(heartbeat); rss(); process.disconnect?.(); }).catch(error => {
  clearInterval(heartbeat);
  process.send?.({ rss: process.memoryUsage().rss, failure: error?.message === 'PROCESSING_TIMEOUT' ? 'PROCESSING_TIMEOUT' : 'PROCESSING_INVALID' }, () => process.exit(1));
  if (!process.send) process.exit(1);
});
