import { content } from './validation-error';
import { dimensions, metadataLimit, type ImageStructure } from './structure';
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); return c >>> 0; });
function checksum(bytes: Buffer): number { let c = 0xffffffff; for (const b of bytes) c = (c >>> 8) ^ table[(c ^ b) & 255]; return (c ^ 0xffffffff) >>> 0; }
function keyword(data: Buffer): number { const end = data.indexOf(0); content(end >= 1 && end <= 79); const key = data.subarray(0, end); content(!key.some(b => b < 32 || (b >= 127 && b <= 160)) && key[0] !== 32 && key[key.length - 1] !== 32 && !key.toString('latin1').includes('  ')); return end; }
function zlibHeader(data: Buffer): void { content(data.length >= 6 && (data[0] & 15) === 8 && (data[0] >>> 4) <= 7 && (data[1] & 32) === 0 && ((data[0] << 8) | data[1]) % 31 === 0); }
function utf8(data: Buffer): void { try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { content(false); } }
function textMetadata(type: string, data: Buffer): void {
  const end = keyword(data);
  if (type === 'tEXt') { content(!data.subarray(end + 1).includes(0)); return; }
  if (type === 'zTXt' || type === 'iCCP') { content(data.length > end + 2 && data[end + 1] === 0); zlibHeader(data.subarray(end + 2)); return; }
  content(data.length >= end + 5 && data[end + 1] <= 1 && data[end + 2] === 0);
  const languageEnd = data.indexOf(0, end + 3); content(languageEnd >= end + 3);
  const translatedEnd = data.indexOf(0, languageEnd + 1); content(translatedEnd >= languageEnd + 1);
  content(/^[A-Za-z0-9-]*$/.test(data.subarray(end + 3, languageEnd).toString('latin1')));
  utf8(data.subarray(languageEnd + 1, translatedEnd));
  if (data[end + 1] === 1) zlibHeader(data.subarray(translatedEnd + 1));
  else { const text = data.subarray(translatedEnd + 1); content(!text.includes(0)); utf8(text); }
}
/** CRC/framing only: compressed IDAT/metadata must subsequently pass bounded fatal full native decoding. */
export function parsePng(bytes: Buffer): ImageStructure {
  content(bytes.subarray(0, 8).equals(signature));
  let offset = 8, width = 0, height = 0, color = -1, paletteEntries = 0, metadataBytes = 0;
  let sawData = false, dataEnded = false, dataBytes = 0;
  const seen = new Set<string>();
  const disposable = new Set(['pHYs', 'sRGB', 'gAMA', 'cHRM', 'iCCP', 'eXIf', 'tEXt', 'zTXt', 'iTXt']);
  while (offset < bytes.length) {
    content(offset + 12 <= bytes.length);
    const length = bytes.readUInt32BE(offset), type = bytes.toString('latin1', offset + 4, offset + 8), end = offset + 12 + length;
    content(/^[A-Za-z]{4}$/.test(type) && end <= bytes.length);
    content(checksum(bytes.subarray(offset + 4, offset + 8 + length)) === bytes.readUInt32BE(offset + 8 + length));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    content(type === 'IHDR' || seen.has('IHDR'));
    if (type === 'IHDR') {
      content(offset === 8 && !seen.has(type) && length === 13);
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); dimensions(width, height); color = data[9];
      content(data[8] === 8 && [0, 2, 3, 4, 6].includes(color) && data[10] === 0 && data[11] === 0 && data[12] <= 1);
    } else if (type === 'PLTE') {
      content(!seen.has(type) && !sawData && !seen.has('tRNS') && ![0, 4].includes(color) && length > 0 && length % 3 === 0 && length <= 768);
      paletteEntries = length / 3;
    } else if (type === 'tRNS') {
      content(!seen.has(type) && !sawData && ((color === 0 && length === 2) || (color === 2 && length === 6) || (color === 3 && paletteEntries > 0 && length > 0 && length <= paletteEntries)));
      if (color === 0 || color === 2) for (let i = 0; i < data.length; i += 2) content(data.readUInt16BE(i) <= 255);
    } else if (type === 'IDAT') {
      content(!dataEnded && (color !== 3 || paletteEntries > 0)); sawData = true; dataBytes += length;
    } else if (type === 'IEND') {
      content(length === 0 && sawData && dataBytes > 0 && end === bytes.length);
      return { format: 'png', width, height, metadataBytes };
    } else {
      content(disposable.has(type)); metadataBytes += length; metadataLimit(metadataBytes);
      if (!['tEXt', 'zTXt', 'iTXt'].includes(type)) content(!seen.has(type));
      if (['pHYs', 'sRGB', 'gAMA', 'cHRM', 'iCCP'].includes(type)) content(!sawData);
      if (['sRGB', 'gAMA', 'cHRM', 'iCCP'].includes(type)) content(!seen.has('PLTE'));
      if (type === 'pHYs') content(length === 9 && data[8] <= 1);
      if (type === 'sRGB') content(length === 1 && data[0] <= 3 && !seen.has('iCCP'));
      if (type === 'gAMA') content(length === 4 && data.readUInt32BE() > 0);
      if (type === 'cHRM') content(length === 32);
      if (type === 'eXIf') content(length >= 8 && (data.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 42, 0])) || data.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0, 42]))));
      if (type === 'iCCP') content(!seen.has('sRGB'));
      if (['tEXt', 'zTXt', 'iTXt', 'iCCP'].includes(type)) textMetadata(type, data);
    }
    if (sawData && type !== 'IDAT') dataEnded = true;
    seen.add(type); offset = end;
  }
  content(false);
}
