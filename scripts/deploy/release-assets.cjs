'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
function mergeAssets(source,target){
 if(!fs.existsSync(source))return;
 if(!fs.lstatSync(source).isDirectory()||fs.lstatSync(source).isSymbolicLink())throw Error('Unsafe asset directory');
 fs.mkdirSync(target,{recursive:true,mode:0o755});
 for(const entry of fs.readdirSync(source,{withFileTypes:true})){
  const from=path.join(source,entry.name),to=path.join(target,entry.name);
  if(entry.isDirectory()){mergeAssets(from,to);continue;}
  if(!entry.isFile()||fs.lstatSync(from).nlink!==1)throw Error('Unsafe asset entry');
  if(fs.existsSync(to)){
   if(!fs.lstatSync(to).isFile()||fs.lstatSync(to).isSymbolicLink()||!fs.readFileSync(from).equals(fs.readFileSync(to)))throw Error('Asset collision');
  }else{fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);fs.chmodSync(to,0o644);}
 }
}
function checkDependencies(entry,release){
 const req=createRequire(path.resolve(entry)),root=fs.realpathSync(path.join(release,'node_modules'))+path.sep;
 const pkg=JSON.parse(fs.readFileSync(path.join(release,'package.json'),'utf8'));
 for(const name of Object.keys(pkg.dependencies||{}))if(!fs.realpathSync(req.resolve(name)).startsWith(root))throw Error('Dependency escaped retained release');
}
function indexDigest(dir){return require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(dir,'index.html'))).digest('hex');}
function reserve(base){const s=fs.statfsSync(base);if(s.bavail*s.bsize<2147483648)throw Error('Insufficient pre-build disk reserve');}
function syncPaths(files){for(const file of files){const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}
function spaceBudget(base,previous,next){
 const size=dir=>{let total=0;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);const s=fs.lstatSync(p);total+=e.isDirectory()?size(p):Math.ceil(s.size/512)*512+512;}return total;};
 const stat=fs.statfsSync(base);
 if(stat.bavail*stat.bsize < 2*size(previous)+size(next)+536870912)throw Error('Insufficient release/rollback disk reserve');
}
module.exports={mergeAssets,checkDependencies,indexDigest,spaceBudget};
if(require.main===module){try{
 const [mode,...args]=process.argv.slice(2);
 if(mode==='assets')mergeAssets(...args);
 else if(mode==='dependencies')checkDependencies(...args);
 else if(mode==='index-digest')console.log(indexDigest(...args));
 else if(mode==='space')spaceBudget(...args);
 else if(mode==='reserve')reserve(...args);
 else if(mode==='sync')syncPaths(args);
 else throw Error('Unknown release file operation');
}catch{console.error('Release artifact safety check failed');process.exitCode=1;}}
