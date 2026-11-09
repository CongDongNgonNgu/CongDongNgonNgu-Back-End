'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const packaging=require('./package-phase30-processors.cjs');
test('minimal software manifest binds actual measured pair and retains original distribution metadata',()=>{
 const manifest=packaging.runtimeManifest();
 assert.equal(manifest.format,1);assert.equal(manifest.platform,'linux');assert.equal(manifest.arch,'x64');assert.equal(manifest.version,'9.0.2');assert.equal(manifest.sourceCommit,'6dfaba896fddaea098abec8ac84ff67375a7c6f1');
 assert.deepEqual(manifest.binaryHashes,{'bin/ffmpeg':'031ffb3a5ccd03437daf983c121b9f01d3974ed8e295057faa912925f84db5f3','bin/ffprobe':'36e837d351e47d525dd6438f0141c2c7dc4bc7d49e27e3836acff137a601b9b3'});
 assert.deepEqual(manifest.binaryBytes,{'bin/ffmpeg':7081296,'bin/ffprobe':6868128});assert.equal(manifest.distributionManifest,'distribution-manifest.json');
 assert.equal(packaging.PIN.bytes,45088234);assert.equal(packaging.PIN.sha256,'0ef73781d602d1a91f6d774604d401e7602174f17f06c0610d6af8b6a848eebb');
 const pins=require('./phase30-minimal-distribution.json');assert.equal(pins.members.length,28);assert.equal(pins.sourceCi,42555671199);
 assert.equal(packaging.PIN.tag,'phase30-processors-simd-20261109');assert.equal(packaging.PIN.file,'phase30-minimal-simd-linux-x64.tar.gz');
 assert.equal(packaging.PIN.source,'https://github.com/CongDongNgonNgu/CongDongNgonNgu-Workspace/releases/download/phase30-processors-simd-20261109/phase30-minimal-simd-linux-x64.tar.gz');
 for(const name of ['source/nasm.tar.gz','notices/nasm/LICENSE','notices/nasm/AUTHORS','notices/ffmpeg/LICENSE.md','notices/ffmpeg/CREDITS','build/native-build-inputs.json','evidence/observations.json','manifest.json'])assert.ok(pins.members.some(pin=>pin.path===name),name);
 assert.equal(new Set(pins.members.map(pin=>pin.path)).size,28);
 for(const pin of pins.members)assert.equal(pin.mode,pin.path.startsWith('bin/')?0o500:0o400);
 for(const name of ['source/ffmpeg.tar.gz','source/glibc/glibc_2.36.orig.tar.xz','source/glibc/glibc_2.36-9+deb12u10.debian.tar.xz','source/glibc/glibc_2.36-9+deb12u10.dsc','source/gcc/libgcc2.c','source/gcc/crtstuff.c','source/gcc/Makefile.in','notices/gcc/COPYING.RUNTIME','notices/glibc/COPYING.LIB'])assert.ok(pins.members.some(pin=>pin.path===name));
});
test('unapproved archive fails before any output directory or runtime manifest',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'phase30-minimal-package-')),archive=path.join(root,'wrong.tar.gz'),destination=path.join(root,'processors');
 try{await fs.writeFile(archive,'unapproved');await assert.rejects(packaging.packageArchive(archive,destination),/PROCESSOR_STAGE_SIZE/);await assert.rejects(fs.stat(destination),{code:'ENOENT'});}finally{await fs.unlink(archive);await fs.rmdir(root);}
});
