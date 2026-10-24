import { AttachmentValidationError } from './validation-error';
export interface ImageStructure { format: 'jpeg' | 'png' | 'webp'; width: number; height: number; metadataBytes: number }
export function dimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 2000 || height > 2000 || width * height > 3000000) throw new AttachmentValidationError('ATTACHMENT_LIMIT_EXCEEDED');
}
export function metadataLimit(bytes: number): void {
  if (bytes > 262144) throw new AttachmentValidationError('ATTACHMENT_LIMIT_EXCEEDED');
}
