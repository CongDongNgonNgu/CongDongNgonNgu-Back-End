import { normalizeMessagePayload } from './message-context';

const id = 'a18fa91a-8230-45b9-9362-073849628322';

describe('Canonical direct-message context boundary', () => {
  it('preserves existing text-only semantics', () => {
    expect(normalizeMessagePayload({ text: '  Cafe\u0301 🌏  ' }))
      .toEqual({ text: 'Café 🌏', context: null });
    expect(() => normalizeMessagePayload({ text: '  ' }))
      .toThrow(expect.objectContaining({ code: 'MESSAGE_INVALID_TEXT' }));
  });

  it.each(['LIBRARY_RESOURCE', 'COMMUNITY_POST'])('accepts canonical %s plus an optional note', contextType => {
    expect(normalizeMessagePayload({ contextType, contextId: id.toUpperCase(), text: '  Explain?  ' }))
      .toEqual({ text: 'Explain?', context: { type: contextType, id } });
    for (const text of [undefined, null, '', ' \n ']) {
      expect(normalizeMessagePayload({ contextType, contextId: id, text }))
        .toEqual({ text: '', context: { type: contextType, id } });
    }
  });

  it.each([
    { contextType: 'LIBRARY_RESOURCE' }, { contextId: id },
    { contextType: null, contextId: null }, { contextType: '', contextId: id },
    { contextType: 'VOCABULARY', contextId: id }, { contextType: 'RELATED_RESOURCE', contextId: id },
    { contextType: 'COMMUNITY_POST', contextId: 'https://example.invalid/post' },
    { contextType: 'COMMUNITY_POST', contextId: 'not-a-uuid' },
    { contextType: ['LIBRARY_RESOURCE'], contextId: id },
  ])('denies malformed/unsupported references without inspecting content: %j', context => {
    expect(() => normalizeMessagePayload({ text: 'note', ...context }))
      .toThrow(expect.objectContaining({ code: 'MESSAGE_INVALID_CONTEXT' }));
  });

  it('retains Unicode size and storage safety for optional notes', () => {
    const context = { contextType: 'LIBRARY_RESOURCE', contextId: id };
    expect(normalizeMessagePayload({ ...context, text: '🌏'.repeat(4000) }).text).toHaveLength(8000);
    for (const text of ['🌏'.repeat(4001), '\u0000', '\ud800', 3, {}]) {
      expect(() => normalizeMessagePayload({ ...context, text }))
        .toThrow(expect.objectContaining({ code: 'MESSAGE_INVALID_TEXT' }));
    }
  });

  it('never treats a syntactically valid reference as content authorization', () => {
    expect(normalizeMessagePayload({ contextType: 'LIBRARY_RESOURCE', contextId: id })).toEqual({
      text: '', context: { type: 'LIBRARY_RESOURCE', id },
    });
    // Current canonical target eligibility is a separate send-time resolver check.
  });
});
