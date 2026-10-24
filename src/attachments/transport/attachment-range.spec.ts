import {attachmentRange,attachmentDownloadHeaders} from './attachment-range';
describe('private attachment response transport',()=>{
 it('accepts single explicit, suffix and open ranges within exact stored bytes',()=>{
  expect(attachmentRange(undefined,10)).toBeUndefined();expect(attachmentRange('bytes=0-3',10)).toEqual({start:0,end:3});
  expect(attachmentRange('bytes=8-',10)).toEqual({start:8,end:9});expect(attachmentRange('bytes=-3',10)).toEqual({start:7,end:9});
  expect(attachmentRange('bytes=0-99',10)).toEqual({start:0,end:9});expect(attachmentRange('bytes=-99',10)).toEqual({start:0,end:9});
 });
 it.each(['bytes=10-','bytes=4-2','bytes=0-1,3-4','items=0-2','bytes=-0','bytes=-','bytes=1e3-','bytes=9007199254740992-','bytes= 0-2','bytes=0-2\r\nX:bad'])('rejects invalid or unsupported range %s',header=>{expect(()=>attachmentRange(header,10)).toThrow('ATTACHMENT_RANGE_INVALID');});
 it('serves normalized derivatives only and keeps text inert',()=>{
  const txt=attachmentDownloadHeaders('TEXT','normalized','vi.txt');expect(txt['Content-Type']).toBe('application/octet-stream');expect(txt['Content-Disposition']).toContain('attachment;');
  const image=attachmentDownloadHeaders('IMAGE','normalized','photo.webp');expect(image['Content-Type']).toBe('image/webp');expect(image['Cache-Control']).toBe('private, no-store');expect(image['X-Content-Type-Options']).toBe('nosniff');
  expect(()=>attachmentDownloadHeaders('TEXT','thumbnail','a.txt')).toThrow();
 });
 it('does not put caller display filenames into the ASCII filename fallback',()=>{
  const h=attachmentDownloadHeaders('IMAGE','normalized','../../evil\r\nX:injected');expect(h['Content-Disposition']).not.toContain('injected');expect(h['Content-Disposition']).toContain('filename="attachment.webp"');
 });
});
