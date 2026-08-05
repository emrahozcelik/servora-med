import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  parsePilotProductDocument,
  planPilotProductMerge,
  type ExistingPilotProduct,
} from '../src/modules/products/pilot-import.js';

const sourcePath = new URL('../../pilot-products.example.json', import.meta.url);

const EXPECTED_PRODUCT_COUNT = 781;
const EXPECTED_NON_NULL_SKU_COUNT = 368;
const SIMULATED_EXISTING_COUNT = 48;

describe('pilot Product import planning', () => {
  it('parses the tracked version-1 catalog through canonical Product validation', async () => {
    const parsed = parsePilotProductDocument(JSON.parse(await readFile(sourcePath, 'utf8')));
    expect(parsed.products).toHaveLength(EXPECTED_PRODUCT_COUNT);
    expect(parsed.products.filter((product) => product.sku !== null))
      .toHaveLength(EXPECTED_NON_NULL_SKU_COUNT);
    expect(new Set(parsed.products.flatMap((product) => product.sku ? [product.sku] : [])))
      .toHaveLength(EXPECTED_NON_NULL_SKU_COUNT);
    expect(parsed.products.every((product) => product.isActive)).toBe(true);
  });

  it('plans exact SKU and null-SKU/name matches without updates', async () => {
    const parsed = parsePilotProductDocument(JSON.parse(await readFile(sourcePath, 'utf8')));
    const existing: ExistingPilotProduct[] = parsed.products.slice(0, SIMULATED_EXISTING_COUNT)
      .map((product, index) => ({
        id: `existing-${index}`, ...product,
      }));

    const plan = planPilotProductMerge(parsed, existing);

    expect(plan.sourceCount).toBe(EXPECTED_PRODUCT_COUNT);
    expect(plan.matched).toHaveLength(SIMULATED_EXISTING_COUNT);
    expect(plan.inserts).toHaveLength(EXPECTED_PRODUCT_COUNT - SIMULATED_EXISTING_COUNT);
    expect(plan.matched.every((match) => match.source === match.existing)).toBe(false);
  });

  it('keeps the raw catalog canonical: unique keys, no unsupported fields, valid categories', async () => {
    const raw = JSON.parse(await readFile(sourcePath, 'utf8'));
    const parsed = parsePilotProductDocument(raw);
    const keys = new Set(parsed.products.map((product) =>
      product.sku === null ? `NAME:${product.name}` : `SKU:${product.sku}`));
    expect(keys.size).toBe(EXPECTED_PRODUCT_COUNT);
    expect(raw.products.every((product: Record<string, unknown>) =>
      Object.keys(product).every((field) =>
        ['name', 'sku', 'brand', 'category', 'model', 'unit', 'referencePrice', 'isActive']
          .includes(field)))).toBe(true);
    expect(parsed.products.every((product) =>
      product.category === null || parsed.categories.includes(product.category))).toBe(true);
    expect(raw.products.every((product: Record<string, unknown>) =>
      ['name', 'sku', 'brand', 'category', 'model', 'unit']
        .every((field) => typeof product[field] !== 'string' || product[field] === product[field].trim())
        && ['sku', 'brand', 'category', 'model', 'unit']
          .every((field) => product[field] !== ''))).toBe(true);
  });

  it('documents the accepted Euroseal correction as a fail-closed prior-catalog conflict', async () => {
    const parsed = parsePilotProductDocument(JSON.parse(await readFile(sourcePath, 'utf8')));
    const euroseal = parsed.products.find((product) => product.name === 'Euroseal Termal Kapama Cihazı');
    expect(euroseal).toBeDefined();
    expect(euroseal?.model).toBe('Euroseal 2001 Plus termal kapama cihazı');
    const priorFixture: ExistingPilotProduct = {
      id: 'existing-euroseal',
      name: 'Euroseal Termal Kapama Cihazı',
      sku: null,
      brand: 'Euronda',
      category: 'Sarrafiye / Sarf',
      model: 'Termal kapama ruloları',
      unit: 'adet',
      referencePrice: null,
      isActive: true,
    };
    expect(() => planPilotProductMerge(parsed, [priorFixture]))
      .toThrowError(expect.objectContaining({ code: 'PILOT_PRODUCT_IMPORT_CONFLICT' }));
    let message = '';
    try {
      planPilotProductMerge(parsed, [priorFixture]);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('Euroseal Termal Kapama Cihazı');
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
