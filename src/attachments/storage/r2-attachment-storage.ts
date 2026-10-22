import { createHash } from 'node:crypto';
import { Readable, Transform, pipeline } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, type HeadObjectCommandOutput, type GetObjectCommandOutput, type ListObjectsV2CommandOutput, type PutObjectCommandOutput } from '@aws-sdk/client-s3';
import { AttachmentStorageError, type AttachmentObjectLocator, type AttachmentStoredObject, type AttachmentByteRange, type AttachmentStorage } from './attachment-storage.port';

const PREFIX = 'attachments/test/v1/';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const KINDS = new Set(['source', 'normalized', 'thumbnail']);
type Command = PutObjectCommand | HeadObjectCommand | GetObjectCommand | DeleteObjectCommand | ListObjectsV2Command;
export interface AttachmentStorageTransport { send(command: Command, options: { abortSignal: AbortSignal }): Promise<unknown>; destroy(): void }
export interface R2AttachmentStorageConfiguration { classification: 'approved-test'; endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }
function fail(code: ConstructorParameters<typeof AttachmentStorageError>[0]): never { throw new AttachmentStorageError(code); }
function maxBytes(locator: AttachmentObjectLocator): number { return locator.kind === 'thumbnail' ? 256 * 1024 : 4 * 1024 * 1024; }
export function attachmentObjectKey(locator: AttachmentObjectLocator): string {
  if (!locator || !UUID.test(locator.attachmentId) || !UUID.test(locator.attemptId) || !UUID.test(locator.objectId) || !KINDS.has(locator.kind)) fail('INVALID_INPUT');
  return `${PREFIX}${locator.attachmentId}/${locator.attemptId}/${locator.kind}/${locator.objectId}`;
}
function metadataFor(locator: AttachmentObjectLocator, sha256: string): Record<string, string> { return { 'attachment-id': locator.attachmentId, 'attempt-id': locator.attemptId, 'object-id': locator.objectId, kind: locator.kind, sha256 }; }
function validateSize(locator: AttachmentObjectLocator, size: number): void { if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes(locator)) fail('INVALID_INPUT'); }
function validateVersion(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value)) fail('INTEGRITY'); }
function status(error: unknown): number | undefined { return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode; }
function safeError(error: unknown): AttachmentStorageError { if (error instanceof AttachmentStorageError) return error; return new AttachmentStorageError(status(error) === 404 ? 'NOT_FOUND' : status(error) === 409 || status(error) === 412 ? 'CONFLICT' : 'UNAVAILABLE'); }
function ownedHead(locator: AttachmentObjectLocator, result: HeadObjectCommandOutput): AttachmentStoredObject {
  const metadata = result.Metadata;
  if (!metadata || !SHA256.test(metadata.sha256 || '')) fail('OWNERSHIP');
  const expected = metadataFor(locator, metadata.sha256);
  if (Object.entries(expected).some(([key, value]) => metadata[key] !== value)) fail('OWNERSHIP');
  if (!Number.isSafeInteger(result.ContentLength) || result.ContentLength! < 1 || result.ContentLength! > maxBytes(locator)) fail('INTEGRITY');
  validateVersion(result.ETag);
  return { locator: { ...locator }, sizeBytes: result.ContentLength!, sha256: metadata.sha256, version: result.ETag };
}
/** A size/digest guard whose final failure prevents a successful completed PUT/read. */
function byteGuard(size: number, checksum?: string): Transform {
  let received = 0; const digest = createHash('sha256');
  return new Transform({ highWaterMark: 64 * 1024, transform(chunk: Buffer, _encoding, callback) {
    received += chunk.length;
    if (received > size) { callback(new AttachmentStorageError('INTEGRITY')); return; }
    digest.update(chunk); callback(null, chunk);
  }, flush(callback) {
    callback(received !== size || (checksum && digest.digest('hex') !== checksum) ? new AttachmentStorageError('INTEGRITY') : undefined);
  }, destroy(error, callback) { callback(error ? safeError(error) : null); } });
}

export class R2AttachmentStorage implements AttachmentStorage {
  private readonly bucket = 'congdongngonngu';
  private readonly transport: AttachmentStorageTransport;
  private readonly active = new Set<AbortController>();
  private readonly streams = new Set<Readable>();
  private closed = false;
  constructor(configuration: R2AttachmentStorageConfiguration, transport?: AttachmentStorageTransport) {
    let endpoint: URL;
    try { endpoint = new URL(configuration.endpoint); } catch { fail('INVALID_CONFIGURATION'); }
    if (configuration.classification !== 'approved-test' || configuration.bucket !== 'congdongngonngu' || endpoint.protocol !== 'https:' || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || !configuration.accessKeyId?.trim() || !configuration.secretAccessKey?.trim()) fail('INVALID_CONFIGURATION');
    const client = transport ? undefined : new S3Client({ endpoint: endpoint.origin, region: 'auto', forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', credentials: { accessKeyId: configuration.accessKeyId, secretAccessKey: configuration.secretAccessKey } });
    this.transport = transport || { send: client!.send.bind(client!) as AttachmentStorageTransport['send'], destroy: () => client!.destroy() };
  }
  private async call<T>(command: Command, signal?: AbortSignal): Promise<T> {
    if (this.closed) fail('UNAVAILABLE');
    const controller = new AbortController(); this.active.add(controller);
    const abort = () => controller.abort(); const timer = setTimeout(abort, 10000);
    signal?.addEventListener('abort', abort, { once: true });
    const interrupted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new AttachmentStorageError('UNAVAILABLE')), { once: true }));
    try {
      if (signal?.aborted) fail('UNAVAILABLE');
      // A transport can finish after abort won the race. Its eventual response
      // still belongs to this request and must not leave a socket/body alive.
      const operation = this.transport.send(command, { abortSignal: controller.signal }).then(result => {
        if (controller.signal.aborted || this.closed) {
          const body = (result as { Body?: unknown } | null)?.Body;
          if (body instanceof Readable) body.destroy();
          fail('UNAVAILABLE');
        }
        return result;
      });
      return await Promise.race([operation, interrupted]) as T;
    }
    catch (error) { throw safeError(error); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active.delete(controller); }
  }
  async putTemporary(input: { locator: AttachmentObjectLocator; body: Readable; sizeBytes: number; sha256: string; signal?: AbortSignal }): Promise<AttachmentStoredObject> {
    const key = attachmentObjectKey(input.locator); validateSize(input.locator, input.sizeBytes); if (!SHA256.test(input.sha256) || !(input.body instanceof Readable)) fail('INVALID_INPUT');
    const guarded = byteGuard(input.sizeBytes, input.sha256); let streamFailure: unknown;
    // Consume errors immediately even if transport fails before reading its request body.
    guarded.on('error', error => { streamFailure = error; });
    pipeline(input.body, guarded, error => { if (error) streamFailure = error; });
    try {
      const result = await this.call<PutObjectCommandOutput>(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: guarded, ContentLength: input.sizeBytes, ContentType: 'application/octet-stream', CacheControl: 'private, no-store', IfNoneMatch: '*', Metadata: metadataFor(input.locator, input.sha256) }), input.signal);
      if (streamFailure) throw streamFailure;
      // A transport returning before the stream finishes cannot establish a successful persisted upload.
      if (!guarded.readableEnded) fail('INTEGRITY');
      validateVersion(result.ETag); return { locator: { ...input.locator }, sizeBytes: input.sizeBytes, sha256: input.sha256, version: result.ETag };
    } catch (error) { throw safeError(streamFailure || error); }
    finally { guarded.destroy(); input.body.destroy(); }
  }
  async head(locator: AttachmentObjectLocator): Promise<AttachmentStoredObject | null> {
    const key = attachmentObjectKey(locator);
    try { return ownedHead(locator, await this.call<HeadObjectCommandOutput>(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))); }
    catch (error) { if (error instanceof AttachmentStorageError && error.code === 'NOT_FOUND') return null; throw safeError(error); }
  }
  async openRead(expected: AttachmentStoredObject, range?: AttachmentByteRange, signal?: AbortSignal): Promise<AttachmentStoredObject & { body: Readable; responseBytes: number }> {
    const locator = expected.locator; const key = attachmentObjectKey(locator); validateSize(locator, expected.sizeBytes); validateVersion(expected.version); if (!SHA256.test(expected.sha256)) fail('INVALID_INPUT'); if (signal?.aborted) fail('UNAVAILABLE');
    const object = await this.head(locator); if (!object) fail('NOT_FOUND');
    if (object.version !== expected.version || object.sha256 !== expected.sha256 || object.sizeBytes !== expected.sizeBytes) fail('INTEGRITY');
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= object.sizeBytes)) fail('INVALID_INPUT');
    const response = await this.call<GetObjectCommandOutput>(new GetObjectCommand({ Bucket: this.bucket, Key: key, IfMatch: object.version, ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }), signal);
    const source = response.Body;
    if (!(source instanceof Readable)) fail('INTEGRITY');
    try {
      if (ownedHead(locator, { ...response, ContentLength: object.sizeBytes }).version !== object.version || response.Metadata?.sha256 !== object.sha256) fail('INTEGRITY');
      const responseBytes = range ? range.end - range.start + 1 : object.sizeBytes;
      if (response.ContentLength !== responseBytes || (range ? response.ContentRange !== `bytes ${range.start}-${range.end}/${object.sizeBytes}` : response.ContentRange !== undefined)) fail('INTEGRITY');
      const body = byteGuard(responseBytes, range ? undefined : object.sha256);
      // Keep timers alive through body consumption, independently of SDK header completion.
      const abort = () => { source.destroy(new AttachmentStorageError('UNAVAILABLE')); body.destroy(new AttachmentStorageError('UNAVAILABLE')); };
      let idle = setTimeout(abort, 10000); const total = setTimeout(abort, 60000);
      const onData = () => { clearTimeout(idle); idle = setTimeout(abort, 10000); };
      const cleanup = () => { clearTimeout(idle); clearTimeout(total); source.removeListener('data', onData); signal?.removeEventListener('abort', abort); this.streams.delete(body); source.destroy(); };
      body.on('error', () => undefined); source.on('error', () => undefined);
      body.once('close', cleanup); source.on('data', onData); signal?.addEventListener('abort', abort, { once: true }); this.streams.add(body);
      pipeline(source, body, error => { if (error) body.destroy(safeError(error)); });
      if (signal?.aborted || this.closed) abort();
      return { ...object, body, responseBytes };
    } catch (error) { source.destroy(); throw safeError(error); }
  }
  async deleteOwned(expected: AttachmentStoredObject): Promise<void> {
    const locator=expected.locator, key=attachmentObjectKey(locator);
    validateSize(locator,expected.sizeBytes);validateVersion(expected.version);
    if(!SHA256.test(expected.sha256))fail('INVALID_INPUT');
    const object=await this.head(locator);if(!object)return;
    if(object.version!==expected.version || object.sha256!==expected.sha256 || object.sizeBytes!==expected.sizeBytes)fail('OWNERSHIP');
    // Executed R2 TEST probe ignored DeleteObject IfMatch. Safety requires the
    // caller's durable single-use-key/producer fence, not an atomic provider CAS.
    await this.call(new DeleteObjectCommand({Bucket:this.bucket,Key:key}));
    if(await this.head(locator))fail('INTEGRITY');
  }
  async listOwnedPrefix(cursor?: string): Promise<{ objects: Array<{ locator: AttachmentObjectLocator; sizeBytes: number }>; unrecognizedObjects: number; cursor?: string }> {
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 2048 || /[\u0000-\u0020\u007f]/.test(cursor))) fail('INVALID_INPUT');
    const result = await this.call<ListObjectsV2CommandOutput>(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: PREFIX, MaxKeys: 100, ...(cursor ? { ContinuationToken: cursor } : {}) }));
    if ((result.Contents?.length || 0) > 100) fail('INTEGRITY');
    const objects: Array<{ locator: AttachmentObjectLocator; sizeBytes: number }> = []; let unrecognizedObjects = 0;
    for (const item of result.Contents || []) {
      if (!item.Key?.startsWith(PREFIX)) fail('INTEGRITY');
      const [attachmentId, attemptId, kind, objectId, extra] = item.Key.slice(PREFIX.length).split('/');
      const locator = { attachmentId, attemptId, kind, objectId } as AttachmentObjectLocator;
      try { if (extra !== undefined || attachmentObjectKey(locator) !== item.Key) fail('INVALID_INPUT'); validateSize(locator, item.Size!); } catch { unrecognizedObjects++; continue; }
      objects.push({ locator, sizeBytes: item.Size! });
    }
    if (result.IsTruncated && (!result.NextContinuationToken || result.NextContinuationToken.length > 2048)) fail('INTEGRITY');
    return { objects, unrecognizedObjects, ...(result.IsTruncated ? { cursor: result.NextContinuationToken } : {}) };
  }
  close(): void { this.closed = true; for (const controller of this.active) controller.abort(); for (const stream of this.streams) stream.destroy(new AttachmentStorageError('UNAVAILABLE')); this.transport.destroy(); }
}
