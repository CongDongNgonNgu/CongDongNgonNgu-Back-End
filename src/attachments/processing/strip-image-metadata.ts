/** Input already passed exact framing. Drop all metadata before native processing, including compressed PNG metadata. */
export function stripImageMetadata(input: Buffer, format: 'jpeg' | 'png' | 'webp'): { bytes: Buffer; orientation: number } {
  let orientation = 1;
  const exif = (data: Buffer) => {
    let bytes = data;
    if (data.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) bytes = data.subarray(6);
    if (bytes.length < 8) throw Error('invalid');
    const little = bytes[0] === 0x49 && bytes[1] === 0x49;
    if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) throw Error('invalid');
    const u16 = (offset: number) => little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
    const u32 = (offset: number) => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    if (u16(2) !== 42) throw Error('invalid');
    const offset = u32(4);
    if (!offset) return;
    if (offset < 8 || offset + 2 > bytes.length) throw Error('invalid');
    const count = u16(offset);
    if (count > 4096 || offset + 2 + count * 12 + 4 > bytes.length) throw Error('invalid');
    let found = false;
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (u16(entry) !== 0x112) continue;
      if (found || u16(entry + 2) !== 3 || u32(entry + 4) !== 1) throw Error('invalid');
      found = true; orientation = u16(entry + 8);
      if (orientation < 1 || orientation > 8) throw Error('invalid');
    }
    // Other EXIF tags are never traversed, decompressed or copied into outputs.
  };
  const parts: Buffer[] = [];
  if (format === 'png') {
    parts.push(input.subarray(0, 8));
    for (let offset = 8; offset < input.length;) {
      const size = input.readUInt32BE(offset), end = offset + 12 + size, type = input.toString('latin1', offset + 4, offset + 8);
      if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) parts.push(input.subarray(offset, end));
      else if (type === 'eXIf') exif(input.subarray(offset + 8, end - 4));
      offset = end;
    }
  } else if (format === 'webp') {
    for (let offset = 12; offset < input.length;) {
      const size = input.readUInt32LE(offset + 4), end = offset + 8 + size + size % 2, type = input.toString('latin1', offset, offset + 4);
      if (type === 'EXIF') exif(input.subarray(offset + 8, offset + 8 + size));
      if (['VP8X', 'VP8 ', 'VP8L', 'ALPH'].includes(type)) {
        const chunk = Buffer.from(input.subarray(offset, end));
        if (type === 'VP8X') chunk[8] &= ~(0x20 | 8 | 4);
        parts.push(chunk);
      }
      offset = end;
    }
    const body = Buffer.concat([Buffer.from('WEBP'), ...parts]), header = Buffer.alloc(8);
    header.write('RIFF'); header.writeUInt32LE(body.length, 4);
    return { bytes: Buffer.concat([header, body]), orientation };
  } else {
    parts.push(input.subarray(0, 2));
    let offset = 2;
    while (offset < input.length) {
      const start = offset;
      while (input[offset] === 0xff) offset++;
      const marker = input[offset++];
      if (marker === 0xd9) { parts.push(input.subarray(start)); break; }
      const length = input.readUInt16BE(offset), end = offset + length;
      if (marker === 0xe1 && input.subarray(offset + 2, offset + 8).equals(Buffer.from('Exif\0\0'))) exif(input.subarray(offset + 2, end));
      if (marker < 0xe0 || marker === 0xee) parts.push(input.subarray(start, end));
      offset = end;
      if (marker === 0xda) {
        const entropy = offset;
        while (offset < input.length) {
          if (input[offset] !== 0xff) { offset++; continue; }
          if (input[offset + 1] === 0 || (input[offset + 1] >= 0xd0 && input[offset + 1] <= 0xd7)) { offset += 2; continue; }
          break;
        }
        parts.push(input.subarray(entropy, offset));
      }
    }
  }
  return { bytes: Buffer.concat(parts), orientation };
}
