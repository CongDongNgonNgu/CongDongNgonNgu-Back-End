const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const backend=fs.existsSync(path.join(__dirname,'runtime-snapshot.cjs'));
const cases=backend?['none','build','health','swap','stop','restart','drift']:['none','build','health','swap'];
for(const failure of cases)test('real-directory release and recovery: '+failure,{skip:process.platform!=='linux'},()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'cdnn-dir-release-'));
 try{
  const sha='a'.repeat(40),release=path.join(base,'.releases',sha+'-1-1'),old=path.join(base,'dist'),bin=path.join(base,'bin');
  fs.mkdirSync(path.join(old,'assets'),{recursive:true});fs.mkdirSync(path.join(release,'scripts','deploy'),{recursive:true});fs.mkdirSync(path.join(release,'node_modules'));fs.mkdirSync(bin);
  fs.writeFileSync(path.join(old,'index.html'),'old index');fs.writeFileSync(path.join(old,'assets','old-hash.js'),'old asset');
  fs.writeFileSync(path.join(base,'.env'),'PRIVATE_FIXTURE_UNCHANGED=yes\n',{mode:0o600});const envStat=fs.statSync(path.join(base,'.env'));
  fs.writeFileSync(path.join(release,'.source-sha'),sha);fs.writeFileSync(path.join(release,'package.json'),'{"dependencies":{}}');
  const oldInode=fs.statSync(old).ino;
  for(const name of ['exchange.py','release-assets.cjs'])fs.copyFileSync(path.join(__dirname,name),path.join(release,'scripts','deploy',name));
  fs.writeFileSync(path.join(release,'scripts','deploy','verify.cjs'),`const fs=require('node:fs');if(process.env.FAILURE==='health'&&fs.readFileSync(process.env.TEST_BASE+'/dist/index.html','utf8')==='new index')process.exitCode=1;`);
  const scripts={
   id:'echo cdnn-deploy',
   npm:'if [ "$1" = run ] && [ "$2" = build ]; then [ "$FAILURE" != build ] || exit 1; mkdir -p dist/assets; printf "new index" > dist/index.html; printf "new asset" > dist/assets/new-hash.js; printf "" > dist/main.js; fi',
   node:'if [ "$1" = -p ]; then echo 24; elif [ "$1" = scripts/deploy/check-migrations.cjs ] || [[ "$1" == --env-file=* ]]; then exit 0; elif [ "$1" = scripts/deploy/runtime-snapshot.cjs ]; then case "$2" in capture) printf "{}" > "$3";; unchanged) test ! -f "$TEST_BASE/stopped";; recoverable) if [ "$FAILURE" = drift ] && grep -q "new index" "$TEST_BASE/dist/index.html"; then exit 1; fi;; esac; else exec "$NODE_EXE" "$@"; fi',
   sleep:'exit 0',
   pm2:'printf "%s %s\\n" "$1" "$2" >> "$TEST_BASE/lifecycle"; test "$2" = cdnn-backend; if [ "$1" = stop ]; then [ "$FAILURE" != stop ] || exit 1; touch "$TEST_BASE/stopped"; else if [ "$FAILURE" = restart ] && [ ! -f "$TEST_BASE/restart-failed" ]; then touch "$TEST_BASE/restart-failed"; exit 1; fi; rm -f "$TEST_BASE/stopped"; fi',
   python3:'if [ "$FAILURE" = swap ] && [ "$2" = "$TEST_BASE/dist" ] && [ ! -f "$TEST_BASE/swap-failed" ]; then touch "$TEST_BASE/swap-failed"; exit 1; fi; exec /usr/bin/python3 "$@"'
  };
  for(const [name,body] of Object.entries(scripts))fs.writeFileSync(path.join(bin,name),'#!/usr/bin/env bash\nset -eu\n'+body+'\n',{mode:0o755});
  const source=fs.readFileSync(path.join(__dirname,'release.sh'),'utf8').replace(/base=\/var\/www\/congdongngonngu\/(backend|frontend)/,'base='+base);
  const script=path.join(release,'release-under-test.sh');fs.writeFileSync(script,source);
  const r=spawnSync('bash',[script,sha,'1-1'],{cwd:release,env:{...process.env,PATH:bin+':'+process.env.PATH,FAILURE:failure,TEST_BASE:base,NODE_EXE:process.execPath},encoding:'utf8',timeout:20000});
  assert.equal(r.error,undefined);assert.equal(r.status===0,failure==='none',r.stdout+'\n'+r.stderr);
  assert.equal(fs.lstatSync(old).isDirectory(),true);assert.equal(fs.lstatSync(old).isSymbolicLink(),false);
  assert.equal(fs.readFileSync(path.join(base,'.env'),'utf8'),'PRIVATE_FIXTURE_UNCHANGED=yes\n');assert.equal(fs.statSync(path.join(base,'.env')).ino,envStat.ino);assert.equal(fs.statSync(path.join(base,'.env')).mode,envStat.mode);
  const expectedNew=failure==='none'||failure==='drift';assert.equal(fs.readFileSync(path.join(old,'index.html'),'utf8'),expectedNew?'new index':'old index');
  if(failure==='none'){
   const original=path.join(base,'.cdnn-next-'+sha+'-1-1');assert.equal(fs.statSync(original).ino,oldInode);assert.equal(fs.readFileSync(path.join(original,'index.html'),'utf8'),'old index');
   if(backend)assert.equal(fs.realpathSync(path.join(old,'node_modules')),path.join(release,'node_modules'));
   else assert.equal(JSON.parse(fs.readFileSync(path.join(old,'cdnn-release.json'))).sha,sha);
  }
  if(!backend&&failure==='health')for(const name of ['old-hash.js','new-hash.js'])assert.equal(fs.existsSync(path.join(old,'assets',name)),true);
  if(backend&&['health','swap','restart'].includes(failure))assert.equal(fs.statSync(old).ino,oldInode);
  if(failure==='build')assert.equal(fs.existsSync(path.join(base,'lifecycle')),false);
  if(!backend)assert.equal(fs.existsSync(path.join(base,'lifecycle')),false);
  if(failure==='drift')assert.equal(JSON.parse(fs.readFileSync(path.join(base,'.deployment-ledger.jsonl'),'utf8').trim()).result,'rollback_failed');
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
