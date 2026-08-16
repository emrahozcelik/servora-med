import { describe, expect, it } from 'vitest';

import { CANONICAL_DOCUMENT_TITLE, resolveDocumentTitle } from '../src/document-title';

describe('document title contract', () => {
  it('keeps the canonical browser title and uses a route-only standalone title', () => {
    expect(resolveDocumentTitle('Giriş', false)).toBe(CANONICAL_DOCUMENT_TITLE);
    expect(resolveDocumentTitle('Giriş', true)).toBe('Giriş');
    expect(resolveDocumentTitle('İşler', true)).toBe('İşler');
  });
});
