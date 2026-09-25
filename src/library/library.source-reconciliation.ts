import {
  PHASE06_SOURCE_HEALTH_REASONS,
  type Phase06SourceHealthReason,
} from '../corrections/corrections.source-health';

export const LIBRARY_REVIEW_AUDIT_NOTE_MAX_LENGTH = 2_000;

const REASON_ORDER = new Map(
  PHASE06_SOURCE_HEALTH_REASONS.map((reason, index) => [reason, index]),
);

export function formatLibrarySourceInvalidationNote(
  reasons: readonly Phase06SourceHealthReason[],
  reviewerNote: string | null,
): string {
  const orderedReasons = [...new Set(reasons.filter((reason) => reason !== 'VALID'))]
    .sort((left, right) => REASON_ORDER.get(left)! - REASON_ORDER.get(right)!);
  const systemNote = orderedReasons.length > 0
    ? `Phase 06 source invalid: ${orderedReasons.join(', ')}`
    : 'Phase 06 source invalid';
  const normalizedReviewerNote = reviewerNote?.normalize('NFKC').trim() ?? '';
  if (!normalizedReviewerNote) return systemNote;

  const separator = ' — ';
  const availableReviewerNoteLength = LIBRARY_REVIEW_AUDIT_NOTE_MAX_LENGTH
    - Array.from(systemNote + separator).length;
  if (availableReviewerNoteLength <= 0) return systemNote;

  const safeReviewerNote = Array.from(normalizedReviewerNote)
    .slice(0, availableReviewerNoteLength)
    .join('');
  return safeReviewerNote ? `${systemNote}${separator}${safeReviewerNote}` : systemNote;
}
