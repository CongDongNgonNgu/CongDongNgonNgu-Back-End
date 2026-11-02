'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const packaging=require('./package-phase30-processors.cjs');
test('minimal software manifest binds actual measured pair and retains original distribution metadata',()=>{
 const manifest=packaging.runtimeManifest();
 assert.equal(manifest.format,1);assert.equal(manifest.platform,'linux');assert.equal(manifest.arch,'x64');assert.equal(manifest.version,'9.0.2');assert.equal(manifest.sourceCommit,'6dfaba896fddaea098abec8ac84ff67375a7c6f1');
 assert.deepEqual(manifest.binaryHashes,{'bin/ffmpeg':'2af1963c499a3005ad4d6037794b9e4bc383c7a1c0f545267297195d68f9ccee','bin/ffprobe':'64c3340d0325afa37fff5015bfacf162095103dc2cbd319d799d70cc9633d24e'});
 assert.deepEqual(manifest.binaryBytes,{'bin/ffmpeg':6470992,'bin/ffprobe':6249632});assert.equal(manifest.distributionManifest,'distribution-manifest.json');
 assert.equal(packaging.PIN.bytes,42802980);assert.equal(packaging.PIN.sha256,'55a940a8015848021aa5340171eba6cf6dcec1b86852bbe533f80eae47b195d1');
 const pins=require('./phase30-minimal-distribution.json');assert.equal(pins.members.length,50);
 for(const name of ['source/ffmpeg.tar.gz','source/glibc/glibc_2.36.orig.tar.xz','source/glibc/glibc_2.36-9+deb12u10.debian.tar.xz','source/glibc/glibc_2.36-9+deb12u10.dsc','source/gcc/libgcc2.c','source/gcc/crtstuff.c','source/gcc/Makefile.in','notices/gcc/COPYING.RUNTIME','notices/glibc/COPYING.LIB'])assert.ok(pins.members.some(pin=>pin.path===name));
});
test('unapproved archive fails before any output directory or runtime manifest',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'phase30-minimal-package-')),archive=path.join(root,'wrong.tar.gz'),destination=path.join(root,'processors');
 try{await fs.writeFile(archive,'unapproved');await assert.rejects(packaging.packageArchive(archive,destination),/PROCESSOR_STAGE_SIZE/);await assert.rejects(fs.stat(destination),{code:'ENOENT'});}finally{await fs.unlink(archive);await fs.rmdir(root);}
});
