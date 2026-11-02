import { mkdtemp,writeFile,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';import { join,resolve,sep } from 'node:path';
const { PIN, packageArchive } = require('../../../scripts/package-phase30-processors.cjs');
describe('pinned processor packaging admission',()=>{
 it('selects only the reviewed minimal software identity and complete archive checksum',()=>{expect(PIN).toMatchObject({version:'9.0.2',bytes:42802980,sha256:'55a940a8015848021aa5340171eba6cf6dcec1b86852bbe533f80eae47b195d1'});});
 it('rejects an unverified archive before creating an install target',async()=>{const root=await mkdtemp(join(tmpdir(),'video-package-test-'));try{const file=join(root,'invalid.tar.gz');await writeFile(file,Buffer.from('invalid'));await expect(packageArchive(file,join(root,'install'))).rejects.toThrow('PROCESSOR_STAGE_SIZE');expect(await readdir(root)).toEqual(['invalid.tar.gz']);}finally{if(!resolve(root).startsWith(resolve(tmpdir())+sep+'video-package-test-'))throw Error('unsafe cleanup');await rm(root,{recursive:true,force:true});}});
});
