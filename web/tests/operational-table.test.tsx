/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OperationalTable } from '../src/ui/antd/OperationalTable';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

describe('OperationalTable', () => {
  const columns = [
    { key: 'name', title: 'Ürün' },
    { key: 'unit', title: 'Birim' },
    { key: 'qty', title: 'Miktar' },
  ] as const;

  const rows = [
    { key: 'r1', cells: { name: 'İmplant', unit: 'Kutu', qty: '12.500' } },
    { key: 'r2', cells: { name: 'Membran', unit: 'Adet', qty: '3.000' } },
  ];

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
    expect(html).toContain('İmplant');
    expect(html).toContain('12.500');
    expect(html).toContain('servora-operational-table__desktop');
    expect(html).toContain('servora-operational-table__mobile');
  });

  it('renders a full-field mobile card list from the same prepared rows', () => {
    const html = renderToStaticMarkup(
      <OperationalTable
        caption="Teslim miktarları"
        columns={[...columns]}
        rows={rows}
      />,
    );
    expect(html).toContain('aria-label="Teslim miktarları"');
    expect(html).toContain('<dt>Ürün</dt>');
    expect(html).toContain('<dd>Membran</dd>');
    expect(html).toContain('<dt>Miktar</dt>');
    expect(html).toContain('<dd>3.000</dd>');
  });

  it('does not invent metrics or transform cell values', () => {
    const html = renderToStaticMarkup(
      <OperationalTable
        caption="c"
        columns={[{ key: 'q', title: 'Miktar' }]}
        rows={[{ key: '1', cells: { q: '0.500' } }]}
      />,
    );
    expect(html).toContain('0.500');
    expect(html).not.toMatch(/parseFloat|NaN|0\.5(?!00)/);
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
  });
});
