import { mkdtemp,writeFile,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';import { join,resolve,sep } from 'node:path';
const { PIN, packageArchive } = require('../../../scripts/package-phase30-processors.cjs');
describe('pinned processor packaging admission',()=>{
 it('selects only the approved release and complete archive checksum',()=>{expect(PIN).toMatchObject({version:'n9.0.2-29-g6dfaba896f',bytes:137943568,sha256:'5ae5939260c72671383f0a0d8785695bfe06c94c27d4daac2e63eb8576417927'});});
 it('rejects an unverified archive before creating an install target',async()=>{const root=await mkdtemp(join(tmpdir(),'video-package-test-'));try{const file=join(root,'invalid.tar.xz');await writeFile(file,Buffer.from('invalid'));await expect(packageArchive(file,join(root,'install'))).rejects.toThrow('PROCESSOR_ARCHIVE_SIZE');expect(await readdir(root)).toEqual(['invalid.tar.xz']);}finally{if(!resolve(root).startsWith(resolve(tmpdir())+sep+'video-package-test-'))throw Error('unsafe cleanup');await rm(root,{recursive:true,force:true});}});
});
