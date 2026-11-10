/** Bounded JSON syntax and per-object decoded-key uniqueness. No I/O. */
export function strictJson(bytes: Buffer): unknown {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 65536 ||
      (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) throw Error('INVALID_JSON');
  const text = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  let at = 0;
  const whitespace = (c: string | undefined) => c !== undefined && [9,10,13,32].includes(c.charCodeAt(0));
  const skip = () => { while (whitespace(text[at])) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const c = text.charCodeAt(at++);
      if (c === 34) return JSON.parse(text.slice(start, at)) as string;
      if (c === 92) at++;
    }
    throw Error('INVALID_JSON');
  };
  const value = (depth: number): void => {
    if (depth > 16) throw Error('INVALID_JSON');
    skip(); const c = text[at];
    if (c === '{') {
      at++; skip(); const keys = new Set<string>();
      if (text[at] === '}') { at++; return; }
      while (at < text.length) {
        skip(); const key = string();
        if (keys.has(key)) throw Error('INVALID_JSON');
        keys.add(key); skip(); at++; value(depth + 1); skip();
        if (text[at++] === '}') return;
      }
    } else if (c === '[') {
      at++; skip(); if (text[at] === ']') { at++; return; }
      while (at < text.length) { value(depth + 1); skip(); if (text[at++] === ']') return; }
    } else if (c === '"') string();
    else while (at < text.length && !whitespace(text[at]) && !',]}'.includes(text[at])) at++;
  };
  value(0);
  return parsed;
}
