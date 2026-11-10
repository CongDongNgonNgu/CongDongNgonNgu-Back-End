import {createHash} from 'node:crypto';
import {validateActivationEnvelope,validatePinnedLiteral,validateEnvelopeValue} from './guard';
import {strictJson} from './strict-json';
const SHA='a'.repeat(40),DEP='dep-synthetic-test-activation';
const budgets={durationMs:600000,attachments:4,videos:1,declaredBytes:16777216,authenticatedRequests:120,anonymousRequests:20,ingressBytes:33554432,authenticatedEgressBytes:67108864,anonymousEgressBytes:16777216,processingAttempts:4,processingConcurrency:1};
const envelope=()=>({schema:1,runId:'11111111-1111-4111-8111-111111111111',activationId:'22222222-2222-4222-8222-222222222222',notBefore:'2026-11-10T00:00:00.000Z',expiresAt:'2026-11-10T00:10:00.000Z',budgets:{...budgets}});
function fixture(value:unknown=envelope()){
 const manifest=Buffer.from(JSON.stringify(value));return{activation:{expectedSourceSha:SHA,expectedManifestSha256:createHash('sha256').update(manifest).digest('hex'),expectedDeploymentId:DEP},env:{NODE_ENV:'test',RENDER_GIT_BRANCH:'dev',RENDER_GIT_COMMIT:SHA,RENDER_SERVICE_ID:'srv-dahnerh594qs73fp3420',ATTACHMENTS_ENABLED:'false',ATTACHMENTS_IMAGE_ENABLED:'false',ATTACHMENTS_VIDEO_ENABLED:'false',ATTACHMENTS_TEXT_ENABLED:'false'},config:{environment:'test',attachments:{enabled:false,image:false,video:false,text:false}},platform:'linux',arch:'x64',execArgv:[] as string[],manifest,receipt:{service:'srv-dahnerh594qs73fp3420',branch:'dev',sha:SHA,deploymentId:DEP,observedAt:'2026-11-10T00:01:00.000Z'},nowMs:Date.parse('2026-11-10T00:02:00.000Z')};
}
const reject=(f:unknown)=>expect(()=>validateActivationEnvelope(f as Parameters<typeof validateActivationEnvelope>[0])).toThrow('TEST_ADMISSION_REJECTED');
describe('inert TEST activation envelope only',()=>{
 it('accepts exact lifetime and freshness boundaries but no expiry or stale extension',()=>{const f=fixture();f.nowMs=Date.parse('2026-11-10T00:05:00.000Z');f.receipt.observedAt='2026-11-10T00:00:00.000Z';expect(validateActivationEnvelope(f)).not.toBeNull();f.nowMs++;reject(f);const first=fixture();first.nowMs=Date.parse('2026-11-10T00:00:00.000Z');first.receipt.observedAt='2026-11-10T00:00:00.000Z';expect(validateActivationEnvelope(first)).not.toBeNull();const short=envelope();short.budgets.durationMs=599999;reject(fixture(short));});
 it('JSON duplicate checks are object-scoped and decode escaped names',()=>{expect(strictJson(Buffer.from('{"a":{"x":1},"b":{"x":2},"quote":"escaped\\\"value"}'))).toEqual({a:{x:1},b:{x:2},quote:'escaped"value'});for(const raw of ['{"a":{"x":1,"x":2}}','{"a":{"x":1,"\\u0078":2}}'])expect(()=>strictJson(Buffer.from(raw))).toThrow();});
 it('mutating caller objects from an accessor cannot alias returned data',()=>{const f=fixture();const config=f.config;Object.defineProperty(f.receipt,'observedAt',{get(){throw Error('private accessor');}});reject(f);expect(config.attachments.enabled).toBe(false);});
 it('default no activation returns null without observing any other options',()=>{const options=new Proxy({activation:undefined},{get(target,key){if(key==='activation')return target.activation;throw Error('must not observe');}});expect(validateActivationEnvelope(options as never)).toBeNull();expect(validateActivationEnvelope()).toBeNull();});
 it('validates detached deeply frozen inert data without request capability',()=>{const input=fixture(),result=validateActivationEnvelope(input)!;expect(result.envelope).toEqual(envelope());expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.envelope)).toBe(true);expect(Object.isFrozen(result.envelope.budgets)).toBe(true);expect(Object.keys(result).sort()).toEqual(['deploymentId','envelope','manifestSha256','sourceSha']);input.manifest.fill(0);input.config.attachments.enabled=true;expect(result.envelope.budgets.attachments).toBe(4);});
 it('rejects partial activation, hostile accessors and foreign identities opaquely',()=>{reject({activation:{}});reject({get activation(){throw Error('private');}});for(const field of ['expectedSourceSha','expectedManifestSha256','expectedDeploymentId'] as const){const f=fixture();f.activation[field]='wrong';reject(f);}for(const patch of [{platform:'win32'},{arch:'arm64'},{execArgv:['--inspect']},{nowMs:NaN},{nowMs:Infinity}])reject({...fixture(),...patch});});
 it('requires raw and effective default-off TEST identity and no loader injection',()=>{for(const [key,value]of Object.entries({NODE_ENV:'production',RENDER_GIT_BRANCH:'main',RENDER_GIT_COMMIT:'b'.repeat(40),RENDER_SERVICE_ID:'other',ATTACHMENTS_ENABLED:'true',ATTACHMENTS_IMAGE_ENABLED:'False',ATTACHMENTS_VIDEO_ENABLED:'',ATTACHMENTS_TEXT_ENABLED:'0',NODE_OPTIONS:'--require private',NODE_PATH:'private',LD_PRELOAD:'private',LD_LIBRARY_PATH:'private'})){const f=fixture();Object.assign(f.env,{[key]:value});reject(f);}const f=fixture();f.config.attachments.video=true;reject(f);reject({...fixture(),config:{environment:'production',attachments:{enabled:false,image:false,video:false,text:false}}});});
 it('requires independently supplied fresh deployment receipt exact identity',()=>{for(const patch of [{sha:'b'.repeat(40)},{service:'other'},{branch:'main'},{deploymentId:'dep-other'},{observedAt:'2026-11-10T00:02:00.001Z'},{observedAt:'2026-11-09T23:56:59.999Z'}]){const f=fixture();Object.assign(f.receipt,patch);reject(f);}});
 it('enforces canonical dates, nonrenewing bounds, UUIDv4 and every budget',()=>{for(const key of Object.keys(budgets) as (keyof typeof budgets)[]){for(const value of [0,-1,1.5,Number.MAX_SAFE_INTEGER]){const e=envelope();e.budgets[key]=value;reject(fixture(e));}}for(const patch of [{schema:2},{runId:'11111111-1111-1111-8111-111111111111'},{activationId:'bad'},{notBefore:'2026-11-10T00:00:00Z'},{expiresAt:'2026-11-10T00:10:00.001Z'},{expiresAt:'2026-11-10T00:00:00.000Z'},{extra:true},{sourceSha:SHA},{manifestSha256:'a'.repeat(64)}])reject(fixture({...envelope(),...patch}));reject({...fixture(),nowMs:Date.parse('2026-11-10T00:10:00.000Z')});reject({...fixture(),nowMs:Date.parse('2026-11-09T23:59:59.999Z')});});
 it('rejects literal hash drift, BOM, malformed UTF8, oversize and duplicate escaped keys',()=>{for(const raw of [Buffer.from('{"schema":1,"schema":1}'),Buffer.from('{"schema":1,"sch\\u0065ma":1}'),Buffer.concat([Buffer.from([239,187,191]),fixture().manifest]),Buffer.from([255]),Buffer.alloc(65537,32),Buffer.from('['.repeat(40)+'0'+']'.repeat(40))]){const f=fixture();f.manifest=raw;f.activation.expectedManifestSha256=createHash('sha256').update(raw).digest('hex');reject(f);}const f=fixture();f.manifest[0]^=1;reject(f);});
 it('rejects unknown nested keys and prototype-shaped records without pollution',()=>{const e=envelope();reject(fixture({...e,budgets:{...e.budgets,extra:1}}));const raw=Buffer.from(JSON.stringify(e).replace('{','{"__proto__":{"polluted":true},'));const f=fixture();f.manifest=raw;f.activation.expectedManifestSha256=createHash('sha256').update(raw).digest('hex');reject(f);expect(({} as {polluted?:boolean}).polluted).toBeUndefined();});
});

describe('composable full-literal identity prerequisite only',()=>{
 it('retains external FULL hash and validates nested envelope without child serialization',()=>{
  const full={envelope:envelope(),resources:{placeholder:'not a validated full manifest'}};
  const f=fixture(full),fullHash=f.activation.expectedManifestSha256;
  const pinned=validatePinnedLiteral(f)!;
  expect(pinned.manifestSha256).toBe(fullHash);expect(pinned.value).toEqual(full);
  expect(pinned.manifestSha256).not.toBe(createHash('sha256').update(Buffer.from(JSON.stringify(full.envelope))).digest('hex'));
  const validated=validateEnvelopeValue((pinned.value as typeof full).envelope,f.nowMs);
  expect(validated).toEqual(envelope());expect(Object.isFrozen(validated.budgets)).toBe(true);
  f.manifest.fill(0);expect((pinned.value as typeof full).envelope.runId).toBe(full.envelope.runId);
  expect(Object.isFrozen(pinned)).toBe(true);expect(Object.isFrozen(pinned.value)).toBe(true);expect(Object.isFrozen((pinned.value as typeof full).resources)).toBe(true);
 });
 it('never substitutes nested bytes for the external full hash',()=>{
  const full={envelope:envelope(),resources:[]};const f=fixture(full);
  f.activation.expectedManifestSha256=createHash('sha256').update(Buffer.from(JSON.stringify(full.envelope))).digest('hex');
  expect(()=>validatePinnedLiteral(f)).toThrow('TEST_ADMISSION_REJECTED');
 });
 it('preserves cold default and receipt-time rejection before exposing parsed data',()=>{
  const cold=new Proxy({activation:undefined},{get(target,key){if(key==='activation')return target.activation;throw Error('private getter');}});
  expect(validatePinnedLiteral(cold as never)).toBeNull();
  const f=fixture({envelope:envelope()});f.receipt.observedAt='2026-11-10T00:02:00.001Z';expect(()=>validatePinnedLiteral(f)).toThrow('TEST_ADMISSION_REJECTED');
 });
 it('rejects duplicates across complete literal and malformed nested envelope opaquely',()=>{
  const f=fixture();f.manifest=Buffer.from('{"envelope":{},"envelope":{}}');f.activation.expectedManifestSha256=createHash('sha256').update(f.manifest).digest('hex');
  expect(()=>validatePinnedLiteral(f)).toThrow('TEST_ADMISSION_REJECTED');
  expect(()=>validateEnvelopeValue({...envelope(),extra:true},f.nowMs)).toThrow('TEST_ADMISSION_REJECTED');
  expect(()=>validateEnvelopeValue(envelope(),NaN)).toThrow('TEST_ADMISSION_REJECTED');
 });
});

it('compatibility wrapper validates against the same once-read server time',()=>{
 const f=fixture();let reads=0;const time=f.nowMs;
 Object.defineProperty(f,'nowMs',{get(){reads++;if(reads>1)throw Error('private second time');return time;}});
 expect(validateActivationEnvelope(f)).not.toBeNull();expect(reads).toBe(1);
});
