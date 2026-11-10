import {validateFixtureInventory} from './fixture-inventory';
import {parseInitiation} from '../initiation/initiation-input';
import type {ActivationEnvelope} from './guard';
const id=(n:number)=>n.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111';
const envelope:ActivationEnvelope={schema:1,runId:id(1),activationId:id(2),notBefore:'2026-11-10T00:00:00.000Z',expiresAt:'2026-11-10T00:10:00.000Z',budgets:{durationMs:600000,attachments:4,videos:1,declaredBytes:16777216,authenticatedRequests:120,anonymousRequests:20,ingressBytes:33554432,authenticatedEgressBytes:67108864,anonymousEgressBytes:16777216,processingAttempts:4,processingConcurrency:1}};
const initiation=(n=0)=>({clientUploadId:id(100+n),scope:{kind:'COMMUNITY',postType:'DISCUSSION',languageId:id(200),visibility:'PUBLIC'},filename:' image.jpg ',mime:'image/jpeg',bytes:1024});
const attachment=(n=0)=>({id:id(20+n),ownerId:id(3),generation:null as string|null,parent:null as unknown,initiation:initiation(n),sourceSha256:'a'.repeat(64)});
const fixture=()=>({actors:[{id:id(3),sessionIds:[id(4)]}],attachments:[attachment()]});
const reject=(v:unknown,e=envelope)=>expect(()=>validateFixtureInventory(v,e)).toThrow('TEST_ADMISSION_INVENTORY');
describe('pure fixture inventory declarations only',()=>{
 it('reuses normalized initiation/fingerprint and detaches/freezes every returned layer',()=>{const f=fixture(),r=validateFixtureInventory(f,envelope);expect(r.attachments[0].initiation).toEqual(parseInitiation(f.attachments[0].initiation));expect(r.attachments[0].initiation.caption).toBe('');expect(Object.isFrozen(r.attachments[0].initiation.intent)).toBe(true);expect(Object.isFrozen(r.actors[0].sessionIds)).toBe(true);f.actors[0].sessionIds[0]=id(99);f.attachments[0].initiation.filename='changed.jpg';expect(r.actors[0].sessionIds).toEqual([id(4)]);expect(r.attachments[0].initiation.filename).toBe('image.jpg');});
 it('accepts explicit private/draft typed declarations but grants no authority',()=>{const f=fixture();Object.assign(f.attachments[0],{generation:id(300),parent:{kind:'STUDY_GROUP',groupId:id(201),textId:id(202)}});f.attachments[0].initiation.scope={kind:'STUDY_GROUP',groupId:id(201)} as never;expect(validateFixtureInventory(f,envelope).attachments[0].parent).toEqual(f.attachments[0].parent);f.attachments[0].parent=null;expect(validateFixtureInventory(f,envelope).attachments[0].generation).toBe(id(300));});
 it('rejects unknown keys, missing DTO fields, null metadata and foreign scope keys',()=>{reject({...fixture(),extra:true});for(const change of [{extra:1},{caption:null},{scope:{...initiation().scope,groupId:id(201)}}]){const f=fixture();Object.assign(f.attachments[0].initiation,change);reject(f);}const f=fixture();delete (f.attachments[0].initiation as Partial<ReturnType<typeof initiation>>).filename;reject(f);});
 it('requires canonical UUIDv4 and collision-free ownership roles including envelope',()=>{for(const mutate of [(f:ReturnType<typeof fixture>)=>f.actors[0].id=id(1),(f:ReturnType<typeof fixture>)=>f.actors[0].sessionIds[0]=id(3),(f:ReturnType<typeof fixture>)=>f.attachments[0].id=id(4),(f:ReturnType<typeof fixture>)=>f.attachments[0].ownerId=id(99),(f:ReturnType<typeof fixture>)=>f.attachments[0].initiation.clientUploadId=id(20),(f:ReturnType<typeof fixture>)=>f.attachments[0].initiation.scope.languageId=id(3),(f:ReturnType<typeof fixture>)=>f.attachments[0].sourceSha256='A'.repeat(64),(f:ReturnType<typeof fixture>)=>f.actors[0].id='AAAAAAAA-1111-4111-8111-111111111111']){const f=fixture();mutate(f);reject(f);}});
 it('checks typed parents and generation even for unbound private drafts',()=>{for(const [scope,parent,generation]of [[initiation().scope,{kind:'STUDY_GROUP',groupId:id(201),textId:id(202)},null],[initiation().scope,null,id(300)],[{kind:'STUDY_GROUP',groupId:id(201)},null,null],[{kind:'STUDY_GROUP',groupId:id(201)},{kind:'STUDY_GROUP',groupId:id(203),textId:id(202)},id(300)],[{kind:'DIRECT_MESSAGE',conversationId:id(210)},{kind:'DIRECT_MESSAGE',conversationId:id(211),messageId:id(212)},id(300)]]){const f=fixture();Object.assign(f.attachments[0],{parent,generation});f.attachments[0].initiation.scope=scope as never;reject(f);}});
 it('rejects inconsistent shared parent facts while allowing repeated foreign references',()=>{const f=fixture();f.attachments.push(attachment(1));for(const a of f.attachments)a.parent={kind:'COMMUNITY',postId:id(205)};expect(validateFixtureInventory(f,envelope).attachments).toHaveLength(2);f.attachments[1].initiation.scope.visibility='PRIVATE';reject(f);});
 it('enforces envelope counts/source ceilings and frozen per-file/format policy',()=>{const f=fixture();reject(f,{...envelope,budgets:{...envelope.budgets,declaredBytes:1023}});f.attachments.push(attachment(1));reject(f,{...envelope,budgets:{...envelope.budgets,attachments:1}});const tooMany=fixture();tooMany.attachments=Array.from({length:5},(_,i)=>attachment(i));reject(tooMany);const over=fixture();over.attachments[0].initiation.bytes=4194305;reject(over);const bad=fixture();bad.attachments[0].initiation.filename='x.svg';reject(bad);const video=fixture();video.attachments=[attachment(0),attachment(1)];for(const a of video.attachments)Object.assign(a.initiation,{filename:'x.mp4',mime:'video/mp4'});reject(video);});
 it('bounds actors/sessions and rejects holes/accessors/prototype or symbol properties without invoking getters',()=>{const many=fixture();many.actors=Array.from({length:9},(_,i)=>({id:id(300+i),sessionIds:[]}));reject(many);const sessions=fixture();sessions.actors[0].sessionIds=Array.from({length:17},(_,i)=>id(400+i));reject(sessions);const hole=fixture();delete hole.actors[0].sessionIds[0];reject(hole);const accessor=fixture();Object.defineProperty(accessor.attachments[0].initiation,'filename',{get(){throw Error('private getter');},enumerable:true});reject(accessor);const inherited=fixture();Object.setPrototypeOf(inherited.actors[0],{extra:1});reject(inherited);const symbol=fixture();Object.assign(symbol,{[Symbol('extra')]:1});reject(symbol);const hidden=fixture();Object.defineProperty(hidden.actors[0],'id',{value:id(3),enumerable:false});reject(hidden);});
});

it('allows distinct member generations on shared group text but rejects cross-group reuse of the same text',()=>{
 const f=fixture();f.actors.push({id:id(5),sessionIds:[id(6)]});f.attachments.push(attachment(1));f.attachments[1].ownerId=id(5);
 for(const [index,a]of f.attachments.entries()){a.generation=id(300+index);a.parent={kind:'STUDY_GROUP',groupId:id(201),textId:id(202)};a.initiation.scope={kind:'STUDY_GROUP',groupId:id(201)} as never;}
 expect(validateFixtureInventory(f,envelope).attachments).toHaveLength(2);
 f.attachments[1].parent={kind:'STUDY_GROUP',groupId:id(203),textId:id(202)};f.attachments[1].initiation.scope={kind:'STUDY_GROUP',groupId:id(203)} as never;reject(f);
});
it('rejects late owned-ID collisions with previously observed foreign references and extended arrays',()=>{
 const f=fixture();f.attachments.push(attachment(1));f.attachments[1].id=id(200);reject(f);
 const extra=fixture();Object.assign(extra.actors,{extra:'unreviewed'});reject(extra);
 const symbol=fixture();Object.assign(symbol.attachments,{[Symbol('unreviewed')]:true});reject(symbol);
});
it('normalizes optional metadata through existing parser without inventing raw whitespace constraints',()=>{
 const f=fixture();Object.assign(f.attachments[0].initiation,{caption:'  e\u0301  ',alt:'  text  '});
 const r=validateFixtureInventory(f,envelope);expect(r.attachments[0].initiation.caption).toBe('\u00e9');expect(r.attachments[0].initiation.alt).toBe('text');
});

describe('inventory generation identity and policy boundaries',()=>{
 const groupFixture=()=>{const f=fixture();f.attachments[0].generation=id(300);f.attachments[0].initiation.scope={kind:'STUDY_GROUP',groupId:id(201)} as never;return f;};
 it('rejects generation aliasing each owned role including later attachment allocation',()=>{
  for(const collision of [envelope.runId,envelope.activationId,id(3),id(4),id(20),id(100),id(21),id(101)]){const f=groupFixture();f.attachments[0].generation=collision;f.attachments.push(attachment(1));reject(f);}
 });
 it('allows repeated legitimate generations and exact DM parent or unbound draft',()=>{
  const f=fixture();f.attachments.push(attachment(1));for(const a of f.attachments){a.generation=id(300);a.initiation.scope={kind:'DIRECT_MESSAGE',conversationId:id(210)} as never;a.parent={kind:'DIRECT_MESSAGE',conversationId:id(210),messageId:id(211)};}
  expect(validateFixtureInventory(f,envelope).attachments).toHaveLength(2);f.attachments[1].parent=null;expect(validateFixtureInventory(f,envelope).attachments[1].parent).toBeNull();
 });
 it('accepts exact actor/session/file maxima with one video and enforces lower envelope caps',()=>{
  const f=fixture();f.actors=Array.from({length:8},(_,i)=>({id:id(500+i),sessionIds:[id(600+i*2),id(601+i*2)]}));f.attachments=Array.from({length:4},(_,i)=>attachment(i));for(const a of f.attachments)a.ownerId=id(500);
  Object.assign(f.attachments[0].initiation,{filename:'video.mp4',mime:'video/mp4',bytes:3145728});
  const r=validateFixtureInventory(f,envelope);expect(r.actors).toHaveLength(8);expect(r.actors.flatMap(a=>a.sessionIds)).toHaveLength(16);expect(r.attachments).toHaveLength(4);
  reject(f,{...envelope,budgets:{...envelope.budgets,attachments:3}});
  const total=f.attachments.reduce((sum,a)=>sum+a.initiation.bytes,0);reject(f,{...envelope,budgets:{...envelope.budgets,declaredBytes:total-1}});expect(validateFixtureInventory(f,{...envelope,budgets:{...envelope.budgets,declaredBytes:total}}).attachments).toHaveLength(4);
 });
 it.each([['image.jpg','image/jpeg',4194304],['image.png','image/png',4194304],['image.webp','image/webp',4194304],['video.mp4','video/mp4',3145728],['text.txt','text/plain',65536]] as const)('enforces declared byte boundary for %s', (filename,mime,limit)=>{
  for(const bytes of [limit-1,limit]){const f=fixture();Object.assign(f.attachments[0].initiation,{filename,mime,bytes});expect(validateFixtureInventory(f,envelope).attachments[0].initiation.bytes).toBe(bytes);}
  for(const bytes of [0,limit+1]){const f=fixture();Object.assign(f.attachments[0].initiation,{filename,mime,bytes});reject(f);}
 });
});
