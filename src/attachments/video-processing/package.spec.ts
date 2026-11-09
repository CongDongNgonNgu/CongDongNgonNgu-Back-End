import { mkdtemp,writeFile,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';import { join,resolve,sep } from 'node:path';
const { PIN, packageArchive } = require('../../../scripts/package-phase30-processors.cjs');
describe('pinned processor packaging admission',()=>{
 it('selects only the reviewed minimal software identity and complete archive checksum',()=>{expect(PIN).toMatchObject({version:'9.0.2',bytes:45088234,sha256:'0ef73781d602d1a91f6d774604d401e7602174f17f06c0610d6af8b6a848eebb'});});
 it('rejects an unverified archive before creating an install target',async()=>{const root=await mkdtemp(join(tmpdir(),'video-package-test-'));try{const file=join(root,'invalid.tar.gz');await writeFile(file,Buffer.from('invalid'));await expect(packageArchive(file,join(root,'install'))).rejects.toThrow('PROCESSOR_STAGE_SIZE');expect(await readdir(root)).toEqual(['invalid.tar.gz']);}finally{if(!resolve(root).startsWith(resolve(tmpdir())+sep+'video-package-test-'))throw Error('unsafe cleanup');await rm(root,{recursive:true,force:true});}});
});
