import { normalizeMessageText, parseSequence, compareSequences } from './message-validation';

describe('Direct message boundary validation', () => {
  it('preserves Unicode and internal newlines while trimming and normalizing text', () => {
    expect(normalizeMessageText('  Học 🌏\n一緒に学ぶ  ')).toBe('Học 🌏\n一緒に学ぶ');
  });

  it('allows 4000 Unicode code points including astral characters', () => {
    expect(normalizeMessageText('🌏'.repeat(4000))).toBe('🌏'.repeat(4000));
  });

  it.each(['🌏'.repeat(4001), 'a'.repeat(4001), ' \n\t ', '', '\u0000', '\ud800', '\udc00'])
    ('rejects oversized, empty or non-storable Unicode text', text => {
      expect(() => normalizeMessageText(text)).toThrow(expect.objectContaining({
        code: 'MESSAGE_INVALID_TEXT',
      }));
    });

  it('does not interpret HTML or transform legitimate message content', () => {
    expect(normalizeMessageText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });

  it('keeps exact bigint ordering above JavaScript safe integer range', () => {
    expect(parseSequence('9007199254740993')).toBe(9007199254740993n);
    expect(compareSequences('10', '9')).toBe(1);
    expect(compareSequences('9007199254740992', '9007199254740993')).toBe(-1);
    expect(compareSequences('9223372036854775807', '9223372036854775807')).toBe(0);
  });

  it('permits zero only for the initial history/read/version boundary', () => {
    expect(parseSequence('0')).toBe(0n);
  });

  it.each(['-1', '01', '+1', '1.0', '1e3', ' 1', '9223372036854775808', '', 'NaN', '1'.repeat(1000)])
    ('rejects noncanonical or out-of-range sequence strings', value => {
      expect(() => parseSequence(value)).toThrow(expect.objectContaining({
        code: 'MESSAGE_INVALID_SEQUENCE',
      }));
    });
});
