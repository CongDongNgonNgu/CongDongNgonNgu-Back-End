import { formatLibrarySourceInvalidationNote } from './library.source-reconciliation';

describe('library source reconciliation audit notes', () => {
  it('deduplicates and orders transactional reason codes deterministically', () => {
    expect(formatLibrarySourceInvalidationNote([
      'PARENT_NOT_PUBLIC',
      'RESPONSE_INACTIVE_OR_MISSING',
      'PARENT_NOT_PUBLIC',
    ], 'reviewer note')).toBe(
      'Phase 06 source invalid: RESPONSE_INACTIVE_OR_MISSING, PARENT_NOT_PUBLIC — reviewer note',
    );
  });

  it('keeps the complete system reason section and truncates only the reviewer note', () => {
    const note = formatLibrarySourceInvalidationNote(
      ['PARENT_NOT_PUBLIC', 'RESPONSE_INACTIVE_OR_MISSING'],
      '🙂'.repeat(3_000),
    );
    expect(Array.from(note).length).toBeLessThanOrEqual(2_000);
    expect(note.startsWith('Phase 06 source invalid: RESPONSE_INACTIVE_OR_MISSING, PARENT_NOT_PUBLIC — ')).toBe(true);
  });
});
