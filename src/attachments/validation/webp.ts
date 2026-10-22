import { content } from './validation-error';
import { dimensions, metadataLimit, type ImageStructure } from './structure';
function u24(bytes: Buffer, offset: number): number { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16); }
/** RIFF/chunk/bitstream-header framing; compressed pixels still require fatal full native decoding. */
export function parseWebp(bytes: Buffer): ImageStructure {
  content(bytes.length >= 20 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === bytes.length - 8);
  let offset = 12, width = 0, height = 0, metadataBytes = 0, extendedWidth = 0, extendedHeight = 0, flags = 0, imageCount = 0, alpha = false;
  let alphaData: Buffer | undefined, previous = '';
  const seen = new Set<string>();
  while (offset < bytes.length) {
    content(offset + 8 <= bytes.length);
    const type = bytes.toString('latin1', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), end = offset + 8 + size, paddedEnd = end + size % 2;
    content(paddedEnd <= bytes.length && (! (size % 2) || bytes[end] === 0));
    content(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type) && !seen.has(type));
    const data = bytes.subarray(offset + 8, end);
    if (type === 'VP8X') {
      content(offset === 12 && size === 10 && (data[0] & ~0x3c) === 0 && data[1] === 0 && data[2] === 0 && data[3] === 0);
      flags = data[0]; extendedWidth = u24(data, 4) + 1; extendedHeight = u24(data, 7) + 1; dimensions(extendedWidth, extendedHeight);
    } else if (type === 'VP8 ' || type === 'VP8L') {
      content(++imageCount === 1);
      if (type === 'VP8 ') {
        content(size > 10 && (data[0] & 1) === 0 && ((data[0] >>> 1) & 7) <= 3 && (data[0] & 16) !== 0 && data.subarray(3, 6).equals(Buffer.from([0x9d, 1, 0x2a])));
        const partitionBytes = u24(data, 0) >>> 5; content(partitionBytes > 0 && partitionBytes <= size - 10);
        const w = data.readUInt16LE(6), h = data.readUInt16LE(8); content((w >>> 14) === 0 && (h >>> 14) === 0); width = w & 0x3fff; height = h & 0x3fff; alpha = !!alphaData;
      } else {
        content(!alphaData && size > 5 && data[0] === 0x2f);
        const bits = data.readUInt32LE(1); content((bits >>> 29) === 0);
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; alpha = !!(bits & 0x10000000);
      }
      dimensions(width, height);
      if (seen.has('VP8X')) content(width === extendedWidth && height === extendedHeight);
      if (alphaData && (alphaData[0] & 3) === 0) content(alphaData.length === 1 + width * height);
    } else {
      content(seen.has('VP8X'));
      if (type === 'ALPH') { content(!imageCount && size >= 2 && (data[0] & 0xc0) === 0 && (data[0] & 3) <= 1 && ((data[0] >>> 4) & 3) <= 1); alphaData = data; }
      else {
        metadataBytes += size; metadataLimit(metadataBytes); content(size > 0);
        if (type === 'ICCP') content(!imageCount && !alphaData);
      }
    }
    previous = type; seen.add(type); offset = paddedEnd;
  }
  content(offset === bytes.length && imageCount === 1 && previous !== 'ALPH');
  if (seen.has('VP8X')) content(!!(flags & 0x20) === seen.has('ICCP') && !!(flags & 0x10) === alpha && !!(flags & 8) === seen.has('EXIF') && !!(flags & 4) === seen.has('XMP '));
  else content(seen.size === 1);
  return { format: 'webp', width, height, metadataBytes };
}
