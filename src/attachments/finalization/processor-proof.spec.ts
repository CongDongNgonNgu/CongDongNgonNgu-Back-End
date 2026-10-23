import { createProcessorProof, processorProofArtifacts } from './processor-proof';
describe('internal finalization proof boundary',()=>{
 it('does not accept client-shaped proof data',()=>expect(()=>processorProofArtifacts({} as never)).toThrow());
 it('validates inert text bytes and strips only an initial BOM',()=>{const p=createProcessorProof(Buffer.from([239,187,191,97,98,99]),{filename:'x.txt',mime:'text/plain'},{format:'TEXT'},'ALLOW');expect(processorProofArtifacts(p)).toMatchObject([{variant:'normalized',contentType:'application/octet-stream',bytes:Buffer.from('abc')}]);});
 it('rejects unsupported bytes and moderation failures',()=>{expect(()=>createProcessorProof(Buffer.from('%PDF-1.7'),{filename:'x.txt',mime:'text/plain'},{format:'TEXT'},'ALLOW')).toThrow();expect(()=>createProcessorProof(Buffer.from('abc'),{filename:'x.txt',mime:'text/plain'},{format:'TEXT'},'DENY' as never)).toThrow();});
 it('does not allow callers to mutate sealed artifact bytes',()=>{const p=createProcessorProof(Buffer.from('abc'),{filename:'x.txt',mime:'text/plain'},{format:'TEXT'},'ALLOW');processorProofArtifacts(p)[0].bytes.fill(0);expect(processorProofArtifacts(p)[0].bytes.toString()).toBe('abc');});

 it('seals only bounded WebP image derivatives and rejects missing thumbnail or excessive RSS',async()=>{
  const sharp=(await import('sharp')).default;
  const source=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer(),normal=await sharp(source).webp().toBuffer();
  const result={normalized:normal,thumbnail:normal,width:2,height:2,thumbnailWidth:2,thumbnailHeight:2,peakRssBytes:1000000};
  const p=createProcessorProof(source,{filename:'x.png',mime:'image/png'},{format:'IMAGE',result},'ALLOW');
  expect(processorProofArtifacts(p).map(x=>[x.variant,x.contentType])).toEqual([['normalized','image/webp'],['thumbnail','image/webp']]);
  expect(()=>createProcessorProof(source,{filename:'x.png',mime:'image/png'},{format:'IMAGE',result:{...result,thumbnail:Buffer.alloc(0)}},'ALLOW')).toThrow();
  expect(()=>createProcessorProof(source,{filename:'x.png',mime:'image/png'},{format:'IMAGE',result:{...result,peakRssBytes:201326593}},'ALLOW')).toThrow();
 });
 it('seals MP4 plus clean JPEG thumbnail only for the VIDEO family',async()=>{
  const sharp=(await import('sharp')).default,{syntheticMp4}=await import('../video/synthetic-fixtures'),{stripImageMetadata}=await import('../processing/strip-image-metadata');
  const source=Buffer.from(syntheticMp4.videoOnly.base64,'base64'),thumbnail=stripImageMetadata(await sharp({create:{width:2,height:2,channels:3,background:'navy'}}).jpeg().toBuffer(),'jpeg').bytes;
  // Controlled trusted-server result fixture: this unit exercises proof framing,
  // not native execution; the separate native pipeline tests establish that gate.
  const result={normalized:source,thumbnail,width:128,height:72,durationSeconds:0.5,thumbnailWidth:2,thumbnailHeight:2,peakRssBytes:1000000,nativeRssObserved:false};
  const p=createProcessorProof(source,{filename:'x.mp4',mime:'video/mp4'},{format:'VIDEO',result},'ALLOW');
  expect(processorProofArtifacts(p).map(x=>[x.variant,x.contentType])).toEqual([['normalized','video/mp4'],['thumbnail','image/jpeg']]);
  expect(()=>createProcessorProof(source,{filename:'x.mp4',mime:'video/mp4'},{format:'VIDEO',result:{...result,thumbnail:source}},'ALLOW')).toThrow();
 });

});
