import type { Readable } from 'node:stream';

/** Internal server port: these locators/versions are never public API DTOs or access grants. */
export interface AttachmentObjectLocator {
  attachmentId: string;
  attemptId: string;
  objectId: string;
  kind: 'source' | 'normalized' | 'thumbnail';
}
export interface AttachmentStoredObject {
  locator: AttachmentObjectLocator;
  sizeBytes: number;
  sha256: string;
  version: string;
}
export interface AttachmentByteRange { start: number; end: number }
export interface AttachmentStorage {
  putTemporary(input: { locator: AttachmentObjectLocator; body: Readable; sizeBytes: number; sha256: string; signal?: AbortSignal }): Promise<AttachmentStoredObject>;
  head(locator: AttachmentObjectLocator): Promise<AttachmentStoredObject | null>;
  openRead(expected: AttachmentStoredObject, range?: AttachmentByteRange, signal?: AbortSignal): Promise<AttachmentStoredObject & { body: Readable; responseBytes: number }>;
  /** Caller must own a fresh durable cleanup claim and guarantee no producer can reuse this key. R2 DELETE is not CAS. */
  deleteOwned(expected: AttachmentStoredObject): Promise<void>;
  listOwnedPrefix(cursor?: string): Promise<{ objects: Array<{ locator: AttachmentObjectLocator; sizeBytes: number }>; unrecognizedObjects: number; cursor?: string }>;
  /** Fresh independent exact-key HEAD/list observation; never settles an uncertain producer. */
  confirmAbsent(locator: AttachmentObjectLocator): Promise<{headMissing:true;ownedListingResidual:0}>;
  close(): void;
}
export type AttachmentStorageErrorCode = 'INVALID_CONFIGURATION' | 'INVALID_INPUT' | 'INTEGRITY' | 'OWNERSHIP' | 'NOT_FOUND' | 'CONFLICT' | 'UNAVAILABLE';
export class AttachmentStorageError extends Error {
  constructor(public readonly code: AttachmentStorageErrorCode,public readonly producerQuiesced:boolean=true) { super(`ATTACHMENT_STORAGE_${code}`); this.name = 'AttachmentStorageError'; }
}

/** Internal actual SDK-send observer; it is not proof that file/native producers
 * stopped or that a remote write is absent. Issue before one consumed PUT claim. */
export interface AttachmentPutSupervision {
  readonly id:string;
  retireUnsent():import('./put-supervision-proof').PutUnsentCertificate;
  waitForActualSendSettlement():Promise<void>;
  release():void;
}
export interface SupervisableAttachmentStorage extends AttachmentStorage {
  supervisePut(locator:AttachmentObjectLocator):AttachmentPutSupervision;
  putSupervised(handle:AttachmentPutSupervision,input:Parameters<AttachmentStorage['putTemporary']>[0]):Promise<AttachmentStoredObject>;
}
