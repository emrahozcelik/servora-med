/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { CANONICAL_DOCUMENT_TITLE, resolveDocumentTitle, setDocumentTitle } from '../src/document-title';

describe('document title contract', () => {
  it('uses the unified resolved-title rule in every display mode', () => {
    expect(resolveDocumentTitle('İşler')).toBe('İşler · Dünya Dental');
    expect(resolveDocumentTitle('Ürün detayı')).toBe('Ürün detayı · Dünya Dental');
  });

  it('falls back to the canonical boot title without a resolved identity', () => {
    setDocumentTitle(null);
    expect(document.title).toBe(CANONICAL_DOCUMENT_TITLE);
    setDocumentTitle('Güvenlik');
    expect(document.title).toBe('Güvenlik · Dünya Dental');
  });
});
