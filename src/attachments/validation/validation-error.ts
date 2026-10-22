export class AttachmentValidationError extends Error {
  constructor(readonly code: 'ATTACHMENT_INVALID_METADATA' | 'ATTACHMENT_TYPE_MISMATCH' | 'ATTACHMENT_INVALID_CONTENT' | 'ATTACHMENT_LIMIT_EXCEEDED') {
    super(code);
    this.name = 'AttachmentValidationError';
  }
}
export function content(condition: unknown): asserts condition {
  if (!condition) throw new AttachmentValidationError('ATTACHMENT_INVALID_CONTENT');
}
