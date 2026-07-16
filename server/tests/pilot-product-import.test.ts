import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  parsePilotProductDocument,
  planPilotProductMerge,
  type ExistingPilotProduct,
} from '../src/modules/products/pilot-import.js';

const sourcePath = new URL('../../pilot-products.example.json', import.meta.url);

describe('pilot Product import planning', () => {
  it('parses the tracked version-1 catalog through canonical Product validation', async () => {
    const parsed = parsePilotProductDocument(JSON.parse(await readFile(sourcePath, 'utf8')));
    expect(parsed.products).toHaveLength(81);
    expect(parsed.products.filter((product) => product.sku !== null)).toHaveLength(39);
    expect(new Set(parsed.products.flatMap((product) => product.sku ? [product.sku] : []))).toHaveLength(39);
    expect(parsed.products.every((product) => product.isActive)).toBe(true);
  });

  it('plans exact SKU and null-SKU/name matches without updates', async () => {
    const parsed = parsePilotProductDocument(JSON.parse(await readFile(sourcePath, 'utf8')));
    const existing: ExistingPilotProduct[] = parsed.products.slice(0, 48).map((product, index) => ({
      id: `existing-${index}`, ...product,
    }));

    const plan = planPilotProductMerge(parsed, existing);

    expect(plan.sourceCount).toBe(81);
    expect(plan.matched).toHaveLength(48);
    expect(plan.inserts).toHaveLength(33);
    expect(plan.matched.every((match) => match.source === match.existing)).toBe(false);
  });

  it('rejects duplicate source keys, unknown categories, unsupported versions, and unknown fields', () => {
    const base = {
      version: 1,
      description: 'test',
      fieldGuide: {},
      categories: ['Protez'],
      products: [{
        name: 'Ürün', sku: 'SKU-1', brand: null, category: 'Protez', model: null,
        unit: 'adet', referencePrice: null, isActive: true,
      }],
    };
    for (const invalid of [
      { ...base, version: 2 },
      { ...base, hidden: true },
      { ...base, products: [{ ...base.products[0], category: 'Bilinmeyen' }] },
      { ...base, products: [...base.products, { ...base.products[0] }] },
      { ...base, products: [{ ...base.products[0], isActive: false }] },
      { ...base, products: [{ ...base.products[0], name: 'x'.repeat(256) }] },
    ]) {
      expect(() => parsePilotProductDocument(invalid)).toThrowError(expect.objectContaining({
        code: 'PILOT_PRODUCT_IMPORT_INVALID', statusCode: 400,
      }));
    }
  });

  it('rejects ambiguous and differing database matches', () => {
    const source = parsePilotProductDocument({
      version: 1, description: 'test', fieldGuide: {}, categories: ['Protez'],
      products: [{
        name: 'Ürün', sku: 'SKU-1', brand: 'Marka', category: 'Protez', model: null,
        unit: 'adet', referencePrice: null, isActive: true,
      }],
    });
    const exact: ExistingPilotProduct = { id: 'p1', ...source.products[0]! };
    expect(() => planPilotProductMerge(source, [exact, { ...exact, id: 'p2' }]))
      .toThrowError(expect.objectContaining({ code: 'PILOT_PRODUCT_IMPORT_AMBIGUOUS' }));
    expect(() => planPilotProductMerge(source, [{ ...exact, name: 'Farklı ad' }]))
      .toThrowError(expect.objectContaining({ code: 'PILOT_PRODUCT_IMPORT_CONFLICT' }));
  });
});
