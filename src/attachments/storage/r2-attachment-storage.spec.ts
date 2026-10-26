import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { R2AttachmentStorage, attachmentObjectKey } from './r2-attachment-storage';
import type { AttachmentObjectLocator } from './attachment-storage.port';

const locator: AttachmentObjectLocator = { attachmentId: '11111111-1111-4111-8111-111111111111', attemptId: '22222222-2222-4222-8222-222222222222', objectId: '33333333-3333-4333-8333-333333333333', kind: 'source' };
const bytes = Buffer.from('synthetic only');
const checksum = createHash('sha256').update(bytes).digest('hex');
const config = { classification: 'approved-test' as const, endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', bucket: 'congdongngonngu', accessKeyId: 'fake-key', secretAccessKey: 'fake-secret' };
const metadata = { 'attachment-id': locator.attachmentId, 'attempt-id': locator.attemptId, 'object-id': locator.objectId, kind: locator.kind, sha256: checksum };
const head = () => ({ ContentLength: bytes.length, Metadata: metadata, ETag: '"opaque-etag"' });
const stored = () => ({ locator, sizeBytes: bytes.length, sha256: checksum, version: '"opaque-etag"' });
const missing = () => Object.assign(new Error('PRIVATE PROVIDER DETAILS'), { $metadata: { httpStatusCode: 404 } });
async function drain(body: AsyncIterable<Uint8Array>): Promise<Buffer> { const chunks: Buffer[] = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
function setup(handler: (command: object) => Promise<object> = async () => head()) {
  const send = jest.fn((command: object, _options: { abortSignal: AbortSignal }) => handler(command)), destroy = jest.fn();
  return { storage: new R2AttachmentStorage(config, { send, destroy }), send, destroy };
}
describe('private TEST attachment storage', () => {
  it('generates an exact namespace from UUIDs; rejects paths, foreign kinds and backups', () => {
    expect(attachmentObjectKey(locator)).toBe(`attachments/test/v1/${locator.attachmentId}/${locator.attemptId}/source/${locator.objectId}`);
    for (const bad of ['../backups', '', locator.objectId + '/x']) expect(() => attachmentObjectKey({ ...locator, objectId: bad })).toThrow('ATTACHMENT_STORAGE_INVALID_INPUT');
    expect(() => attachmentObjectKey({ ...locator, kind: 'backups' as never })).toThrow('ATTACHMENT_STORAGE_INVALID_INPUT');
  });
  it('rejects foreign configuration and secret-bearing endpoints safely', () => {
    for (const change of [{ classification: 'production' }, { bucket: 'eduai-storage' }, { endpoint: config.endpoint + '/?token=PRIVATE' }, { endpoint: 'http://example.invalid' }, { secretAccessKey: '' }]) expect(() => new R2AttachmentStorage({ ...config, ...change } as typeof config)).toThrow('ATTACHMENT_STORAGE_INVALID_CONFIGURATION');
  });
  it('uses conditional writes, private metadata, exact length, SHA256 and a deadline', async () => {
    const { storage, send } = setup(async command => { expect(command).toBeInstanceOf(PutObjectCommand); expect(await drain((command as PutObjectCommand).input.Body as Readable)).toEqual(bytes); return { ETag: '"opaque-etag"' }; });
    await expect(storage.putTemporary({ locator, body: Readable.from([bytes]), sizeBytes: bytes.length, sha256: checksum })).resolves.toMatchObject({ sizeBytes: bytes.length, sha256: checksum });
    expect(send.mock.calls[0][0]).toMatchObject({ input: { IfNoneMatch: '*', ContentLength: bytes.length, CacheControl: 'private, no-store', ContentType: 'application/octet-stream', Metadata: metadata } });
    expect(send.mock.calls[0][1]).toEqual({ abortSignal: expect.any(AbortSignal) });
  });
  it('rejects too many, too few and checksum-mismatched upload bytes', async () => {
    for (const input of [Buffer.concat([bytes, Buffer.from('x')]), bytes.subarray(1), Buffer.alloc(bytes.length)]) {
      const { storage } = setup(async command => { await drain((command as PutObjectCommand).input.Body as Readable); return {}; });
      await expect(storage.putTemporary({ locator, body: Readable.from([input]), sizeBytes: bytes.length, sha256: checksum })).rejects.toThrow('ATTACHMENT_STORAGE_INTEGRITY');
    }
  });
  it('rejects unbounded writes before transport', async () => {
    const { storage, send } = setup();
    await expect(storage.putTemporary({ locator, body: Readable.from([bytes]), sizeBytes: 4 * 1024 * 1024 + 1, sha256: checksum })).rejects.toThrow('ATTACHMENT_STORAGE_INVALID_INPUT'); expect(send).not.toHaveBeenCalled();
  });
  it('does not trust foreign ownership metadata', async () => {
    const { storage } = setup(async () => ({ ...head(), Metadata: { ...metadata, 'attempt-id': locator.objectId } }));
    await expect(storage.head(locator)).rejects.toThrow('ATTACHMENT_STORAGE_OWNERSHIP');
  });
  it('streams full reads and verifies exact bytes and checksum', async () => {
    const { storage } = setup(async command => command instanceof HeadObjectCommand ? head() : { ...head(), Body: Readable.from([bytes]) });
    const result = await storage.openRead(stored()); expect(await drain(result.body)).toEqual(bytes);
  });
  it('does not close the returned read before its hidden provider source has actually closed',async()=>{
    let beginClose!:()=>void,completeClose!:()=>void;
    const closing=new Promise<void>(resolve=>{beginClose=resolve;});
    const source=new Readable({read(){},destroy(error,callback){beginClose();completeClose=()=>callback(error);}});
    const {storage}=setup(async command=>command instanceof HeadObjectCommand?head():{...head(),Body:source});
    const result=await storage.openRead(stored());
    let settled=false;
    const bodyClosed=finished(result.body,{cleanup:true}).then(()=>{settled=true;},()=>{settled=true;});
    const providerClosed=finished(source,{cleanup:true}).catch(()=>undefined);
    result.body.destroy();await closing;await new Promise<void>(resolve=>setImmediate(resolve));
    const returnedBodyClosedBeforeProvider=settled;
    completeClose();await Promise.all([bodyClosed,providerClosed]);storage.close();
    expect(returnedBodyClosedBeforeProvider).toBe(false);
    expect(source.closed).toBe(true);expect(result.body.closed).toBe(true);
  });
  it('does not finish rejected read headers before the hidden provider source has actually closed',async()=>{
    let beginClose!:()=>void,completeClose!:()=>void;
    const closing=new Promise<void>(resolve=>{beginClose=resolve;});
    const source=new Readable({read(){},destroy(error,callback){beginClose();completeClose=()=>callback(error);}});
    const {storage}=setup(async command=>command instanceof HeadObjectCommand?head():{...head(),ContentLength:bytes.length+1,Body:source});
    let settled=false;
    const work=storage.openRead(stored()).then(()=>{settled=true;},()=>{settled=true;});
    await closing;await Promise.resolve();await Promise.resolve();
    const failedBeforeProviderClose=settled;
    completeClose();await work;storage.close();
    expect(failedBeforeProviderClose).toBe(false);expect(source.closed).toBe(true);
  });
  it('uses a bounded single range and checks Content-Range and length', async () => {
    const { storage, send } = setup(async command => command instanceof HeadObjectCommand ? head() : { ...head(), ContentLength: 3, ContentRange: `bytes 1-3/${bytes.length}`, Body: Readable.from([bytes.subarray(1, 4)]) });
    const result = await storage.openRead(stored(), { start: 1, end: 3 }); expect(await drain(result.body)).toEqual(bytes.subarray(1, 4));
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand); expect(send.mock.calls[1][0]).toMatchObject({ input: { Range: 'bytes=1-3', IfMatch: '"opaque-etag"' } });
  });
  it('rejects invalid ranges and mismatched provider range responses', async () => {
    const { storage } = setup(); for (const range of [{ start: -1, end: 0 }, { start: 0, end: bytes.length }, { start: 2, end: 1 }]) await expect(storage.openRead(stored(), range)).rejects.toThrow('ATTACHMENT_STORAGE_INVALID_INPUT');
    const { storage: wrong } = setup(async command => command instanceof HeadObjectCommand ? head() : { ...head(), ContentLength: 3, ContentRange: 'bytes 0-2/999', Body: Readable.from([bytes]) });
    await expect(wrong.openRead(stored(), { start: 1, end: 3 })).rejects.toThrow('ATTACHMENT_STORAGE_INTEGRITY');
  });
  it('deletes only the exact owned version and confirms absence', async () => {
    let calls = 0; const { storage, send } = setup(async command => { if (command instanceof HeadObjectCommand && calls++ > 0) throw missing(); return head(); });
    await expect(storage.deleteOwned(stored())).resolves.toBeUndefined();
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand); expect(send.mock.calls[1][0]).toMatchObject({ input: { Key: attachmentObjectKey(locator) } });
    expect(send.mock.calls[1][0]).not.toHaveProperty('input.IfMatch');
  });
  it('refuses changed versions or foreign owners before deletion', async () => {
    const { storage, send } = setup(); await expect(storage.deleteOwned({...stored(),version:'changed'})).rejects.toThrow('ATTACHMENT_STORAGE_OWNERSHIP'); expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
  });
  it('confirms exact-owned absence using separate HEAD and bounded exact-key listing', async()=>{
    const {storage,send}=setup(async command=>{if(command instanceof HeadObjectCommand)throw missing();return {Contents:[],IsTruncated:false};});
    await expect(storage.confirmAbsent(locator)).resolves.toEqual({headMissing:true,ownedListingResidual:0});
    expect(send.mock.calls[1][0]).toMatchObject({input:{Prefix:attachmentObjectKey(locator),MaxKeys:2}});
    for(const result of [{Contents:[{Key:attachmentObjectKey(locator),Size:bytes.length}],IsTruncated:false},{Contents:[],IsTruncated:true},{Contents:[{Key:'backups/unrelated',Size:1}],IsTruncated:false}]){const {storage:s}=setup(async command=>{if(command instanceof HeadObjectCommand)throw missing();return result;});await expect(s.confirmAbsent(locator)).rejects.toThrow('ATTACHMENT_STORAGE_INTEGRITY');}
  });
  it('lists only the owned namespace, at most100 objects and valid locators', async () => {
    const { storage, send } = setup(async () => ({ Contents: [{ Key: attachmentObjectKey(locator), Size: bytes.length }], IsTruncated: false }));
    await expect(storage.listOwnedPrefix()).resolves.toEqual({ objects: [{ locator, sizeBytes: bytes.length }], unrecognizedObjects: 0 });
    expect(send.mock.calls[0][0]).toBeInstanceOf(ListObjectsV2Command); expect(send.mock.calls[0][0]).toMatchObject({ input: { Prefix: 'attachments/test/v1/', MaxKeys: 100 } });
  });
  it('compares the persisted checksum and size even if the provider ETag stays identical', async () => {
    for (const mismatch of [{sha256:'f'.repeat(64)},{sizeBytes:bytes.length+1}]) {
      const {storage,send}=setup();
      await expect(storage.deleteOwned({...stored(),...mismatch})).rejects.toThrow('ATTACHMENT_STORAGE_OWNERSHIP');
      expect(send.mock.calls.some(([command])=>command instanceof DeleteObjectCommand)).toBe(false);
    }
  });
  it('does not return or delete injected backup listings', async () => {
    const { storage } = setup(async () => ({ Contents: [{ Key: 'backups/uat/database/private.dump', Size: 10 }] })); await expect(storage.listOwnedPrefix()).rejects.toThrow('ATTACHMENT_STORAGE_INTEGRITY');
  });
  it('maps provider errors without leaking keys, credentials, URLs or messages', async () => {
    const { storage } = setup(async () => { throw Error('https://private.test?secret=VERY_SECRET'); }); await expect(storage.head(locator)).rejects.toThrow(/^ATTACHMENT_STORAGE_UNAVAILABLE$/);
  });
  it('refuses persisted checksum/version mismatch before any content read', async () => {
    const { storage, send } = setup();
    const expected = { locator, sizeBytes: bytes.length, sha256: checksum, version: 'different-persisted-version' };
    await expect(storage.openRead(expected)).rejects.toThrow('ATTACHMENT_STORAGE_INTEGRITY');
    expect(send.mock.calls.some(([command]) => command instanceof GetObjectCommand)).toBe(false);
  });
  it('redacts errors arriving from the response stream after headers', async () => {
    const { storage } = setup(async command => command instanceof HeadObjectCommand ? head() : { ...head(), Body: Readable.from((async function* () { throw Error('https://secret.test/private?token=SECRET'); })()) });
    const result = await storage.openRead(stored()); await expect(drain(result.body)).rejects.toThrow(/^ATTACHMENT_STORAGE_UNAVAILABLE$/);
  });
  it('rejects tampered complete reads and destroys their streams', async () => {
    const source = Readable.from([Buffer.alloc(bytes.length)]); const { storage } = setup(async command => command instanceof HeadObjectCommand ? head() : { ...head(), Body: source });
    const result = await storage.openRead(stored()); await expect(drain(result.body)).rejects.toThrow('ATTACHMENT_STORAGE_INTEGRITY'); expect(source.destroyed).toBe(true);
  });
  it('fails cleanup if the supposedly deleted object still exists', async () => {
    const { storage } = setup(); await expect(storage.deleteOwned(stored())).rejects.toThrow('ATTACHMENT_STORAGE_INTEGRITY');
  });
  it('preserves unknown owned keys without exposing an arbitrary deletion path', async () => {
    const { storage } = setup(async () => ({ Contents: [{ Key: 'attachments/test/v1/not-a-generated-key', Size: 10 }], IsTruncated: true, NextContinuationToken: 'opaque-cursor' }));
    await expect(storage.listOwnedPrefix()).resolves.toEqual({ objects: [], unrecognizedObjects: 1, cursor: 'opaque-cursor' });
  });
  it('rejects list overflow and truncated listings without a cursor', async () => {
    for (const result of [{ Contents: Array.from({ length: 101 }, () => ({ Key: attachmentObjectKey(locator), Size: 10 })) }, { Contents: [], IsTruncated: true }]) { const { storage } = setup(async () => result); await expect(storage.listOwnedPrefix()).rejects.toThrow('ATTACHMENT_STORAGE_INTEGRITY'); }
  });
  it('enforces the10second transport deadline even when a transport stalls', async () => {
    jest.useFakeTimers(); try { const { storage } = setup(() => new Promise(() => undefined)); const pending = storage.head(locator); const assertion = expect(pending).rejects.toThrow('ATTACHMENT_STORAGE_UNAVAILABLE'); await jest.advanceTimersByTimeAsync(10000); await assertion; } finally { jest.useRealTimers(); }
  });
  it.each(['caller', 'deadline', 'shutdown'] as const)('destroys a response body arriving after %s cancellation', async reason => {
    jest.useFakeTimers();
    try {
      let complete!: (value: object) => void;
      const { storage, send } = setup(async command => command instanceof HeadObjectCommand ? head() : new Promise(resolve => { complete = resolve; }));
      const controller = new AbortController();
      const pending = storage.openRead(stored(), undefined, controller.signal);
      const assertion = expect(pending).rejects.toThrow('ATTACHMENT_STORAGE_UNAVAILABLE');
      await jest.advanceTimersByTimeAsync(0); expect(send).toHaveBeenCalledTimes(2);
      if (reason === 'caller') controller.abort(); else if (reason === 'shutdown') storage.close(); else await jest.advanceTimersByTimeAsync(10000);
      await assertion;
      const lateBody = new Readable({ read() {} }); complete({ ...head(), Body: lateBody });
      await jest.advanceTimersByTimeAsync(0);
      expect(lateBody.destroyed).toBe(true); storage.close();
    } finally { jest.useRealTimers(); }
  });
  it('cancels stalled read bodies after10seconds and on shutdown', async () => {
    jest.useFakeTimers(); try { const source = new Readable({ read() {} }); const { storage } = setup(async command => command instanceof HeadObjectCommand ? head() : { ...head(), Body: source }); const result = await storage.openRead(stored()); const assertion = expect(drain(result.body)).rejects.toThrow('ATTACHMENT_STORAGE_UNAVAILABLE'); await jest.advanceTimersByTimeAsync(10000); await assertion; expect(source.destroyed).toBe(true); storage.close(); } finally { jest.useRealTimers(); }
    const { storage, send, destroy } = setup(); storage.close(); await expect(storage.head(locator)).rejects.toThrow('ATTACHMENT_STORAGE_UNAVAILABLE'); expect(send).not.toHaveBeenCalled(); expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('actual R2 PUT send supervision',()=>{
 it.each(['caller','deadline','shutdown'] as const)('does not confuse %s foreground failure with actual SDK send settlement',async reason=>{
  jest.useFakeTimers();try{
   let complete!:(value:object)=>void;const {storage,send}=setup(()=>new Promise(resolve=>{complete=resolve;}));
   const handle=storage.supervisePut(locator),controller=new AbortController();let stopped=false;
   const actual=handle.waitForActualSendSettlement().then(()=>{stopped=true;});
   const pending=storage.putTemporary({locator,body:Readable.from([bytes]),sizeBytes:bytes.length,sha256:checksum,signal:controller.signal});
   const rejected=expect(pending).rejects.toThrow('ATTACHMENT_STORAGE_UNAVAILABLE');
   await jest.advanceTimersByTimeAsync(0);expect(send).toHaveBeenCalledTimes(1);
   if(reason==='caller')controller.abort();else if(reason==='shutdown')storage.close();else await jest.advanceTimersByTimeAsync(10000);
   await rejected;expect(stopped).toBe(false);
   const lateBody=new Readable({read(){}});complete({ETag:'"late-etag"',Body:lateBody});await actual;
   expect(stopped).toBe(true);expect(lateBody.destroyed).toBe(true);handle.release();storage.close();
  }finally{jest.useRealTimers();}
 });
 it('observes actual SDK rejection after a foreground timeout without exposing provider details',async()=>{
  jest.useFakeTimers();try{let reject!:(error:Error)=>void;const {storage}=setup(()=>new Promise((_,r)=>{reject=r;}));const handle=storage.supervisePut(locator);let stopped=false;const actual=handle.waitForActualSendSettlement().then(()=>{stopped=true;});const pending=storage.putTemporary({locator,body:Readable.from([bytes]),sizeBytes:bytes.length,sha256:checksum});const rejected=expect(pending).rejects.toThrow(/^ATTACHMENT_STORAGE_UNAVAILABLE$/);await jest.advanceTimersByTimeAsync(10000);await rejected;expect(stopped).toBe(false);reject(Error('PRIVATE SDK DETAILS'));await expect(actual).resolves.toBeUndefined();expect(stopped).toBe(true);handle.release();storage.close();}finally{jest.useRealTimers();}
 });
 it('keeps an issued but never dispatched claim unresolved, including pre-aborted requests',async()=>{
  const {storage,send}=setup(),handle=storage.supervisePut(locator);let stopped=false;void handle.waitForActualSendSettlement().then(()=>{stopped=true;});const c=new AbortController();c.abort();await expect(storage.putTemporary({locator,body:Readable.from([bytes]),sizeBytes:bytes.length,sha256:checksum,signal:c.signal})).rejects.toThrow('ATTACHMENT_STORAGE_UNAVAILABLE');await Promise.resolve();expect(stopped).toBe(false);expect(send).not.toHaveBeenCalled();handle.release();await expect(handle.waitForActualSendSettlement()).rejects.toThrow('ATTACHMENT_STORAGE_UNAVAILABLE');storage.close();
 });
 it('records one positive SDK settlement and rejects duplicate PUT consumption under one handle',async()=>{
  const {storage,send}=setup(async command=>{await drain((command as PutObjectCommand).input.Body as Readable);return {ETag:'"opaque-etag"'};});const handle=storage.supervisePut(locator);expect(()=>storage.supervisePut({...locator})).toThrow('ATTACHMENT_STORAGE_CONFLICT');await storage.putTemporary({locator,body:Readable.from([bytes]),sizeBytes:bytes.length,sha256:checksum});await expect(handle.waitForActualSendSettlement()).resolves.toBeUndefined();await expect(storage.putTemporary({locator,body:Readable.from([bytes]),sizeBytes:bytes.length,sha256:checksum})).rejects.toThrow('ATTACHMENT_STORAGE_CONFLICT');expect(send).toHaveBeenCalledTimes(1);handle.release();handle.release();const next=storage.supervisePut(locator);next.release();storage.close();
 });
 it('bounds issued handles and frees exact released entries',()=>{
  const {storage}=setup();const handles=Array.from({length:512*3},(_,i)=>storage.supervisePut({...locator,objectId:('00000000-0000-4000-8000-'+i.toString(16).padStart(12,'0'))}));expect(()=>storage.supervisePut(locator)).toThrow('ATTACHMENT_STORAGE_UNAVAILABLE');for(const handle of handles)handle.release();const next=storage.supervisePut(locator);next.release();storage.close();
 });
});

describe('read transport closure before response headers',()=>{
 it('does not equate late SDK headers with closure while an aborted response body is still closing',async()=>{
  let beginClose!:()=>void,completeClose!:()=>void;
  const closing=new Promise<void>(resolve=>{beginClose=resolve;});
  const source=new Readable({read(){},destroy(error,callback){beginClose();completeClose=()=>callback(error);}});
  const controller=new AbortController();
  const {storage}=setup(async command=>{
   if(command instanceof HeadObjectCommand)return head();
   controller.abort();return {...head(),Body:source};
  });
  const work=storage.openRead(stored(),undefined,controller.signal).catch(error=>error);
  await closing;const error=await work;
  const providerClosed=finished(source,{cleanup:true}).catch(()=>undefined);
  expect(source.closed).toBe(false);
  completeClose();await providerClosed;storage.close();
  expect(error).toMatchObject({code:'UNAVAILABLE',producerQuiesced:false});
 });
 it('marks a foreground abort as unquiesced until the actual GET send has settled',async()=>{
  let complete!:(value:object)=>void;
  const {storage,send}=setup(async command=>command instanceof HeadObjectCommand?head():new Promise<object>(resolve=>{complete=resolve;}));
  const controller=new AbortController();
  const work=storage.openRead(stored(),undefined,controller.signal).catch(error=>error);
  while(send.mock.calls.length<2)await new Promise<void>(resolve=>setImmediate(resolve));
  controller.abort();const error=await work;
  const lateBody=new Readable({read(){}}),closed=finished(lateBody,{cleanup:true}).catch(()=>undefined);
  complete({...head(),Body:lateBody});await closed;storage.close();
  expect(error).toMatchObject({code:'UNAVAILABLE',producerQuiesced:false});
 });
 it('marks actual SDK rejection as quiesced without exposing provider error details',async()=>{
  const {storage}=setup(async command=>{if(command instanceof HeadObjectCommand)return head();throw Error('PRIVATE_PROVIDER_DETAILS');});
  const error=await storage.openRead(stored()).catch(value=>value);storage.close();
  expect(error).toMatchObject({code:'UNAVAILABLE',producerQuiesced:true});
  expect(error.message).toBe('ATTACHMENT_STORAGE_UNAVAILABLE');
 });
});

describe('PUT supervisor reservation retirement',()=>{
 it('does not reclaim capacity for a released handle until its actual send settles',async()=>{
  jest.useFakeTimers();try{
   let complete!:(value:object)=>void;const {storage}=setup(()=>new Promise(resolve=>{complete=resolve;}));const handle=storage.supervisePut(locator),actual=handle.waitForActualSendSettlement();
   const pending=storage.putTemporary({locator,body:Readable.from([bytes]),sizeBytes:bytes.length,sha256:checksum});const rejected=expect(pending).rejects.toThrow('ATTACHMENT_STORAGE_UNAVAILABLE');await jest.advanceTimersByTimeAsync(10000);await rejected;handle.release();
   const held=Array.from({length:512*3-1},(_,i)=>storage.supervisePut({...locator,objectId:'00000000-0000-4000-8000-'+i.toString(16).padStart(12,'0')}));
   expect(()=>storage.supervisePut(locator)).toThrow('ATTACHMENT_STORAGE_UNAVAILABLE');complete({ETag:'"late"'});await actual;
   const next=storage.supervisePut(locator);next.release();for(const h of held)h.release();storage.close();
  }finally{jest.useRealTimers();}
 });
 it('does not mark malformed input dispatched or let unrelated provider calls satisfy a PUT handle',async()=>{
  const {storage,send}=setup(),handle=storage.supervisePut(locator);let stopped=false;void handle.waitForActualSendSettlement().then(()=>{stopped=true;});
  await expect(storage.putTemporary({locator,body:Readable.from([bytes]),sizeBytes:4*1048576+1,sha256:checksum})).rejects.toThrow('ATTACHMENT_STORAGE_INVALID_INPUT');await storage.head(locator);await Promise.resolve();expect(stopped).toBe(false);expect(send).toHaveBeenCalledTimes(1);handle.release();storage.close();
 });
});

describe('captured original-entry mandatory PUT dispatch',()=>{
 it('rejects a retired handle before SDK send',async()=>{const {storage,send}=setup();const h=storage.supervisePut(locator);h.retireUnsent();await expect(storage.putSupervised(h,{locator,body:Readable.from([bytes]),sizeBytes:bytes.length,sha256:checksum})).rejects.toThrow('ATTACHMENT_STORAGE_CONFLICT');expect(send).not.toHaveBeenCalled();h.release();storage.close();});
 it('rejects released and cross-locator handles without legacy fallback',async()=>{const {storage,send}=setup();const h=storage.supervisePut(locator);h.release();const next=storage.supervisePut(locator);await expect(storage.putSupervised(h,{locator,body:Readable.from([bytes]),sizeBytes:bytes.length,sha256:checksum})).rejects.toThrow('ATTACHMENT_STORAGE_CONFLICT');await expect(storage.putSupervised(next,{locator:{...locator,objectId:locator.attemptId},body:Readable.from([bytes]),sizeBytes:bytes.length,sha256:checksum})).rejects.toThrow('ATTACHMENT_STORAGE_CONFLICT');expect(send).not.toHaveBeenCalled();next.release();storage.close();});
 it('disallows unsent retirement after actual SDK rejection',async()=>{const {storage,send}=setup(async()=>{throw Error('private');});const h=storage.supervisePut(locator);await expect(storage.putSupervised(h,{locator,body:Readable.from([bytes]),sizeBytes:bytes.length,sha256:checksum})).rejects.toThrow('ATTACHMENT_STORAGE_UNAVAILABLE');expect(send).toHaveBeenCalledTimes(1);expect(()=>h.retireUnsent()).toThrow('ATTACHMENT_STORAGE_CONFLICT');h.release();storage.close();});
 it('preserves original identity when a released locator gets a replacement',()=>{const {storage}=setup();const old=storage.supervisePut(locator);old.release();const next=storage.supervisePut(locator);expect(next.id).not.toBe(old.id);expect(()=>old.retireUnsent()).toThrow();next.release();storage.close();});
});
