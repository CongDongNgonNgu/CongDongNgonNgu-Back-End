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
  close(): void;
}
export type AttachmentStorageErrorCode = 'INVALID_CONFIGURATION' | 'INVALID_INPUT' | 'INTEGRITY' | 'OWNERSHIP' | 'NOT_FOUND' | 'CONFLICT' | 'UNAVAILABLE';
export class AttachmentStorageError extends Error {
  constructor(public readonly code: AttachmentStorageErrorCode) { super(`ATTACHMENT_STORAGE_${code}`); this.name = 'AttachmentStorageError'; }
}
