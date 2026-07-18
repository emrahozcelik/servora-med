/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OperationalTable } from '../src/ui/OperationalTable';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

describe('OperationalTable', () => {
  const columns = [
    { key: 'name', title: 'Ürün' },
    { key: 'sku', title: 'SKU' },
    { key: 'model', title: 'Model' },
    { key: 'unit', title: 'Birim' },
    { key: 'qty', title: 'Miktar' },
  ] as const;

  const rows = [
    {
      key: 'r1',
      cells: {
        name: 'Uzun ürün adı',
        sku: 'DENTAL-IMPLANT-SUPER-LONG-SKU-2026-000123',
        model: 'PROFESSIONAL-MODEL-WITHOUT-BREAKS',
        unit: 'Kutu',
        qty: '0.500',
      },
    },
    {
      key: 'r2',
      cells: {
        name: 'Membran',
        sku: 'MEM-01',
        model: 'M2',
        unit: 'Adet',
        qty: '3.000',
      },
    },
  ];

  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });

  it('renders caption, column headers, and row headers on the desktop table', () => {
    const html = renderToStaticMarkup(
      <OperationalTable
        caption="Teslim miktarları (birim kırılımları birleştirilmez)"
        columns={[...columns]}
        rows={rows}
      />,
    );
    expect(html).toContain('data-servora-operational-table="true"');
    expect(html).toContain('<caption>Teslim miktarları (birim kırılımları birleştirilmez)</caption>');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('servora-operational-table__desktop');
    expect(html).toContain('servora-operational-table__mobile-caption');
  });

  it('exposes caption as a visible text node on the mobile surface', () => {
    const html = renderToStaticMarkup(
      <OperationalTable
        caption="Teslim miktarları (birim kırılımları birleştirilmez)"
        columns={[...columns]}
        rows={rows}
      />,
    );
    expect(html).toMatch(
      /class="servora-operational-table__mobile-caption"[^>]*>Teslim miktarları \(birim kırılımları birleştirilmez\)</,
    );
    expect(html).toContain('aria-labelledby=');
    // Product meaning must not live only inside aria-label on the list.
    expect(html).not.toMatch(
      /<ul[^>]*aria-label="Teslim miktarları \(birim kırılımları birleştirilmez\)"/,
    );
  });

  it('keeps desktop and mobile field values identical for every column', async () => {
    await act(async () => {
      root.render(
        <OperationalTable
          caption="Teslim miktarları (birim kırılımları birleştirilmez)"
          columns={[...columns]}
          rows={rows}
        />,
      );
    });

    const desktopHeaders = Array.from(
      host.querySelectorAll('.servora-operational-table__desktop thead th'),
    ).map((el) => el.textContent);
    expect(desktopHeaders).toEqual(['Ürün', 'SKU', 'Model', 'Birim', 'Miktar']);

    const firstDesktopCells = Array.from(
      host.querySelectorAll('.servora-operational-table__desktop tbody tr:first-child th, .servora-operational-table__desktop tbody tr:first-child td'),
    ).map((el) => el.textContent);
    expect(firstDesktopCells).toEqual([
      'Uzun ürün adı',
      'DENTAL-IMPLANT-SUPER-LONG-SKU-2026-000123',
      'PROFESSIONAL-MODEL-WITHOUT-BREAKS',
      'Kutu',
      '0.500',
    ]);

    const mobileFields = host.querySelectorAll(
      '.servora-operational-table__card:first-child .servora-operational-table__field',
    );
    expect(mobileFields).toHaveLength(5);
    const mobilePairs = Array.from(mobileFields).map((field) => ({
      title: field.querySelector('dt')?.textContent,
      value: field.querySelector('dd')?.textContent,
    }));
    expect(mobilePairs).toEqual([
      { title: 'Ürün', value: 'Uzun ürün adı' },
      { title: 'SKU', value: 'DENTAL-IMPLANT-SUPER-LONG-SKU-2026-000123' },
      { title: 'Model', value: 'PROFESSIONAL-MODEL-WITHOUT-BREAKS' },
      { title: 'Birim', value: 'Kutu' },
      { title: 'Miktar', value: '0.500' },
    ]);

    const desktopQty = host.querySelector(
      '.servora-operational-table__desktop tbody tr:first-child td:last-child',
    );
    const mobileQty = host.querySelector(
      '.servora-operational-table__card:first-child .servora-operational-table__field:last-child dd',
    );
    expect(desktopQty?.textContent).toBe('0.500');
    expect(mobileQty?.textContent).toBe('0.500');
  });

  it('uses the 720px report-specific breakpoint for table/card switch', () => {
    expect(css).toMatch(
      /\.servora-operational-table__mobile\s*\{[^}]*display:\s*none/s,
    );
    expect(css).toMatch(
      /@media\s*\(\s*max-width:\s*720px\s*\)[\s\S]*\.servora-operational-table__desktop[\s\S]*display:\s*none/,
    );
    expect(css).toMatch(
      /@media\s*\(\s*max-width:\s*720px\s*\)[\s\S]*\.servora-operational-table__mobile[\s\S]*display:\s*grid/,
    );
    expect(css).toMatch(
      /\.servora-operational-table__desktop th,\s*\.servora-operational-table__desktop td\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    );
  });
});
