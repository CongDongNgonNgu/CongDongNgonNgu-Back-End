const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {mergeAssets,checkDependencies}=require('./release-assets.cjs');
test('retains both asset generations and refuses same-name different bytes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cdnn-assets-'));
 try{const a=path.join(dir,'a'),b=path.join(dir,'b');fs.mkdirSync(a);fs.mkdirSync(b);fs.writeFileSync(path.join(a,'old-hash.js'),'old');fs.writeFileSync(path.join(b,'new-hash.js'),'new');mergeAssets(a,b);assert.equal(fs.readFileSync(path.join(b,'old-hash.js'),'utf8'),'old');assert.equal(fs.readFileSync(path.join(b,'new-hash.js'),'utf8'),'new');fs.writeFileSync(path.join(a,'new-hash.js'),'collision');assert.throws(()=>mergeAssets(a,b),/collision/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('relocated backend entry resolves dependencies in retained release, not root',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cdnn-resolution-'));
 try{const release=path.join(dir,'release'),live=path.join(dir,'dist');fs.mkdirSync(path.join(release,'node_modules','fixture-dependency'),{recursive:true});fs.mkdirSync(live);fs.writeFileSync(path.join(release,'package.json'),JSON.stringify({dependencies:{'fixture-dependency':'1.0.0'}}));fs.writeFileSync(path.join(release,'node_modules','fixture-dependency','index.js'),'module.exports=1');fs.writeFileSync(path.join(live,'main.js'),'');fs.symlinkSync(path.join(release,'node_modules'),path.join(live,'node_modules'),process.platform==='win32'?'junction':'dir');checkDependencies(path.join(live,'main.js'),release);assert.throws(()=>checkDependencies(path.join(live,'main.js'),path.join(dir,'wrong')));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
