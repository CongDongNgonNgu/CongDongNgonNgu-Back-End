import { describe, expect, it } from '@jest/globals';
import {
  MAX_PHASE06_CONTEXT_CODE_POINTS,
  MAX_PHASE06_SOURCE_CODE_POINTS,
  normalizePhase06OptionalText,
  normalizePhase06Text,
  normalizeCorrectionIntent,
} from './corrections.normalization';

describe('Phase 06 text contracts', () => {
  it('preserves multilingual source text and only canonicalizes line endings', () => {
    expect(normalizePhase06Text('  Xin chào\r\n世界\t🙂  ')).toBe('  Xin chào\n世界\t🙂  ');
  });

  it('rejects whitespace-only source text without destroying meaningful whitespace', () => {
    expect(() => normalizePhase06Text(' \n\t ')).toThrow('PHASE06_TEXT_EMPTY');
    expect(normalizePhase06Text('  source  ')).toBe('  source  ');
  });

  it('counts Unicode code points at the source and context boundaries', () => {
    const source = '😀'.repeat(MAX_PHASE06_SOURCE_CODE_POINTS);
    expect(normalizePhase06Text(source)).toBe(source);
    expect(() => normalizePhase06Text(source + '😀')).toThrow('PHASE06_TEXT_TOO_LONG');

    const context = '界'.repeat(MAX_PHASE06_CONTEXT_CODE_POINTS);
    expect(normalizePhase06OptionalText(context)).toBe(context);
    expect(() => normalizePhase06OptionalText(context + '界')).toThrow('PHASE06_TEXT_TOO_LONG');
  });

  it('keeps correction intents bounded and typed', () => {
    expect(normalizeCorrectionIntent(' naturalness ')).toBe('NATURALNESS');
    expect(() => normalizeCorrectionIntent('TRANSLATION')).toThrow('CORRECTION_INTENT_INVALID');
  });
});
