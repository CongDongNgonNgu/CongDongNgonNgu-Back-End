import { content } from './validation-error';
import { dimensions, metadataLimit, type ImageStructure } from './structure';
function starts(data: Buffer, prefix: string): boolean { return data.subarray(0, Buffer.byteLength(prefix, 'ascii')).equals(Buffer.from(prefix, 'ascii')); }
function quantization(data: Buffer, tables: Set<number>): void {
  let offset = 0;
  while (offset < data.length) {
    const id = data[offset++]; content(id <= 3 && offset + 64 <= data.length);
    content(!data.subarray(offset, offset + 64).includes(0)); tables.add(id); offset += 64;
  }
  content(offset > 0);
}
function huffman(data: Buffer, tables: Set<number>): void {
  let offset = 0;
  while (offset < data.length) {
    content(offset + 17 <= data.length);
    const id = data[offset++], kind = id >>> 4; content(kind <= 1 && (id & 15) <= 3);
    const counts = data.subarray(offset, offset + 16); offset += 16;
    let count = 0, available = 1;
    for (const n of counts) { count += n; available = available * 2 - n; content(available >= 0); }
    content(count > 0 && count <= 256 && available > 0 && offset + count <= data.length);
    for (const symbol of data.subarray(offset, offset + count)) content(kind === 0 ? symbol <= 11 : ((symbol & 15) >= 1 && (symbol & 15) <= 10) || symbol === 0 || symbol === 0xf0);
    tables.add(id); offset += count;
  }
  content(offset > 0);
}
/** Baseline marker/table/scan framing; entropy must still pass fatal full native decoding. */
export function parseJpeg(bytes: Buffer): ImageStructure {
  content(bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8);
  let offset = 2, width = 0, height = 0, metadataBytes = 0, restart = 0;
  const components = new Map<number, number>(), scanned = new Set<number>(), qt = new Set<number>(), ht = new Set<number>();
  const iccParts = new Set<number>(); let iccTotal = 0;
  while (offset < bytes.length) {
    content(bytes[offset++] === 0xff);
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    content(offset < bytes.length); const marker = bytes[offset++];
    if (marker === 0xd9) {
      content(offset === bytes.length && components.size > 0 && scanned.size === components.size && (!iccTotal || iccParts.size === iccTotal));
      return { format: 'jpeg', width, height, metadataBytes };
    }
    content([0xc0, 0xc4, 0xdb, 0xdd, 0xda, 0xe0, 0xe1, 0xe2, 0xee, 0xfe].includes(marker) && offset + 2 <= bytes.length);
    const length = bytes.readUInt16BE(offset); content(length >= 2 && offset + length <= bytes.length);
    const data = bytes.subarray(offset + 2, offset + length); offset += length;
    if (marker === 0xdb) quantization(data, qt);
    else if (marker === 0xc4) huffman(data, ht);
    else if (marker === 0xc0) {
      content(!components.size && data.length >= 6 && data[0] === 8 && [1, 3].includes(data[5]) && data.length === 6 + 3 * data[5]);
      height = data.readUInt16BE(1); width = data.readUInt16BE(3); dimensions(width, height);
      let blocks = 0;
      for (let i = 6; i < data.length; i += 3) {
        const id = data[i], horizontal = data[i + 1] >>> 4, vertical = data[i + 1] & 15;
        content(!components.has(id) && horizontal >= 1 && horizontal <= 4 && vertical >= 1 && vertical <= 4 && data[i + 2] <= 3);
        blocks += horizontal * vertical; components.set(id, data[i + 2]);
      }
      content(blocks <= 10);
    } else if (marker === 0xdd) { content(data.length === 2); restart = data.readUInt16BE(); }
    else if (marker === 0xda) {
      content(components.size > 0 && data.length >= 6 && data[0] >= 1 && data[0] <= components.size && data.length === 1 + data[0] * 2 + 3);
      content(data[data.length - 3] === 0 && data[data.length - 2] === 63 && data[data.length - 1] === 0);
      for (let i = 1; i < 1 + data[0] * 2; i += 2) {
        const id = data[i], table = data[i + 1]; content(components.has(id) && !scanned.has(id) && qt.has(components.get(id)!) && ht.has(table >>> 4) && ht.has(0x10 | (table & 15)));
        scanned.add(id);
      }
      let entropy = 0, nextRestart = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; entropy++; continue; }
        content(offset + 1 < bytes.length);
        if (bytes[offset + 1] === 0) { offset += 2; entropy++; continue; }
        if (bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7) { content(restart > 0 && bytes[offset + 1] === 0xd0 + nextRestart); nextRestart = (nextRestart + 1) % 8; offset += 2; continue; }
        break;
      }
      content(entropy > 0);
    } else {
      metadataBytes += data.length; metadataLimit(metadataBytes);
      if (marker === 0xe0) content(data.length >= 14 && starts(data, 'JFIF\0') && data[5] === 1 && data[7] <= 2 && data.readUInt16BE(8) > 0 && data.readUInt16BE(10) > 0 && data.length === 14 + 3 * data[12] * data[13]);
      if (marker === 0xe1) content(starts(data, 'Exif\0\0') || starts(data, 'http://ns.adobe.com/xap/1.0/\0'));
      if (marker === 0xe2) {
        content(data.length >= 14 && starts(data, 'ICC_PROFILE\0') && data[12] >= 1 && data[13] >= 1 && data[12] <= data[13] && (!iccTotal || iccTotal === data[13]) && !iccParts.has(data[12]));
        iccTotal = data[13]; iccParts.add(data[12]);
      }
      if (marker === 0xee) content(data.length === 12 && starts(data, 'Adobe') && data[11] <= 1);
    }
  }
  content(false);
}
