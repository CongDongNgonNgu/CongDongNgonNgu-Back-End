
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
for(const failure of ['none','build','health','swap','external'])test('isolated release activation/rollback: '+failure,{skip:process.platform!=='linux'},()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'cdnn-release-test-'));
 try{
  const sha='a'.repeat(40),oldSha='b'.repeat(40),release=path.join(base,'.releases',sha+'-1-1'),old=path.join(base,'.releases','previous','dist'),bin=path.join(base,'bin');
  fs.mkdirSync(old,{recursive:true});fs.mkdirSync(release,{recursive:true});fs.mkdirSync(bin);
  fs.writeFileSync(path.join(old,'cdnn-release.json'),JSON.stringify({sha:oldSha}));
  const original=failure==='external'?path.join(base,'outside','dist'):old;
  fs.mkdirSync(original,{recursive:true});
  fs.symlinkSync(original,path.join(base,'dist'));
  fs.writeFileSync(path.join(base,'.env'),'TEST_ONLY=yes\n',{mode:0o600});
  fs.writeFileSync(path.join(release,'.source-sha'),sha);
  const scripts={
   id:'echo cdnn-deploy',
   stat:'if [ "$2" = "%a" ]; then echo 600; else echo cdnn-deploy; fi',
   npm:'if [ "$1" = run ] && [ "$2" = build ]; then [ "$FAILURE" != build ] || exit 1; mkdir -p dist/assets; printf "<html>" > dist/index.html; fi',
   node:'if [ "$1" = -p ]; then case "$2" in *process.versions*) echo 24;; *) printf "%s" "$OLD_SHA";; esac; elif [ "$1" = scripts/deploy/verify.cjs ] && [ "$FAILURE" = health ]; then case "$(readlink -f "$TEST_BASE/dist")" in *previous*) exit 0;; *) exit 1;; esac; fi',
   sleep:'exit 0',
   pm2:'echo restart >> "$TEST_BASE/restarts"',
   mv:'if [ "$FAILURE" = swap ] && [ ! -f "$TEST_BASE/swap-failed" ]; then touch "$TEST_BASE/swap-failed"; exit 1; fi; exec /usr/bin/mv "$@"'
  };
  for(const [name,body] of Object.entries(scripts))fs.writeFileSync(path.join(bin,name),'#!/usr/bin/env bash\nset -eu\n'+body+'\n',{mode:0o755});
  const source=fs.readFileSync(path.join(__dirname,'release.sh'),'utf8').replace(/base=\/var\/www\/congdongngonngu\/(backend|frontend)/,'base='+base);
  const script=path.join(release,'release-under-test.sh');fs.writeFileSync(script,source);
  const r=spawnSync('bash',[script,sha,'1-1'],{cwd:release,env:{...process.env,PATH:bin+':'+process.env.PATH,FAILURE:failure,TEST_BASE:base,OLD_SHA:oldSha},encoding:'utf8',timeout:15000});
  assert.equal(r.error,undefined);
  assert.equal(r.status===0,failure==='none',r.stderr);
  assert.equal(fs.realpathSync(path.join(base,'dist')),failure==='none'?path.join(release,'dist'):original);
  if(failure==='build'||failure==='external')assert.equal(fs.existsSync(path.join(base,'restarts')),false);
  else {
   const ledger=fs.readFileSync(path.join(base,'.deployment-ledger.jsonl'),'utf8');
   assert.equal(JSON.parse(ledger.trim()).result,failure==='none'?'verified':'rolled_back');
  }
  if(__dirname.includes('Front-End')&&failure==='none'){
   assert.equal(fs.statSync(release).mode&0o777,0o711);
   assert.equal(fs.statSync(path.join(release,'dist','index.html')).mode&0o777,0o644);
  }
 } finally {fs.rmSync(base,{recursive:true,force:true});}
});
