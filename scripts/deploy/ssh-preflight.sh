#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${CDNN_SSH_PRIVATE_KEY:?Existing production SSH key is missing}"
: "${CDNN_KNOWN_HOSTS:?Existing pinned host key is missing}"
[[ "$CDNN_SSH_USER" == cdnn-deploy && "$CDNN_SSH_HOST" == 103.173.226.189 ]]
scratch=$(mktemp -d)
trap 'rm -f -- "$scratch/key" "$scratch/known_hosts"; rmdir -- "$scratch"' EXIT
printf '%s\n' "$CDNN_SSH_PRIVATE_KEY" > "$scratch/key"
printf '%s\n' "$CDNN_KNOWN_HOSTS" > "$scratch/known_hosts"
unset CDNN_SSH_PRIVATE_KEY CDNN_KNOWN_HOSTS
ssh-keygen -y -P '' -f "$scratch/key" > /dev/null
ssh-keygen -F "$CDNN_SSH_HOST" -f "$scratch/known_hosts" > /dev/null
ssh -i "$scratch/key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o "UserKnownHostsFile=$scratch/known_hosts" "$CDNN_SSH_USER@$CDNN_SSH_HOST" 'bash -seu' <<'REMOTE'
test "$(id -un)" = cdnn-deploy
printf 'SSH_EXISTING_SECRETS=PASS\n'
command -v node
node --version
command -v npm
command -v pm2 || true
node <<'NODE'
const fs=require('node:fs');
for(const app of ['backend','frontend']){
 const base='/var/www/congdongngonngu/'+app;
 const report={app};
 for(const name of ['','.releases','dist']){
  try{const s=fs.lstatSync(base+(name?'/'+name:''));report[name||'base']={type:s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':'other',uid:s.uid,mode:(s.mode&511).toString(8),target:s.isSymbolicLink()?fs.realpathSync(base+'/'+name):undefined};}
  catch(e){report[name||'base']={error:e.code};}
 }
 try{report.sourceSha=fs.readFileSync(base+'/.source-sha','utf8').trim();}catch{}
 try{report.activeReleaseSha=fs.readFileSync(fs.realpathSync(base+'/dist')+'/../.source-sha','utf8').trim();}catch{}
 if(app==='backend'){
  try{const s=fs.lstatSync(base+'/.env');report.envMetadata={regular:s.isFile(),symlink:s.isSymbolicLink(),uid:s.uid,mode:(s.mode&511).toString(8)};}catch(e){report.envMetadata={error:e.code};}
 }
 console.log(JSON.stringify(report));
}
for(const name of ['pm2.pid','rpc.sock','dump.pm2','dump.pm2.bak']){
 try{const s=fs.lstatSync('/home/cdnn-deploy/.pm2/'+name);console.log(JSON.stringify({pm2File:name,exists:true,uid:s.uid,mode:(s.mode&511).toString(8)}));}catch(e){console.log(JSON.stringify({pm2File:name,error:e.code}));}
}
NODE
systemctl is-active pm2-cdnn-deploy || true
printf 'READONLY_PREFLIGHT=COMPLETE; NO_RESTART_OR_FILESYSTEM_MUTATION\n'
REMOTE
