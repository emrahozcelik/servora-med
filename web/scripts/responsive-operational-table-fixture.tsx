import { createRoot } from 'react-dom/client';

import { OperationalTable } from '../src/ui/OperationalTable';

const root = document.getElementById('responsive-operational-table-root');
if (root) {
  createRoot(root).render(
    <OperationalTable
      caption="Teslim miktarları (birim kırılımları birleştirilmez)"
      columns={[
        { key: 'product', title: 'Ürün' },
        { key: 'sku', title: 'SKU' },
        { key: 'model', title: 'Model' },
        { key: 'unit', title: 'Birim' },
        { key: 'quantity', title: 'Miktar' },
      ]}
      rows={[
        {
          key: 'smoke-product-1',
          cells: {
            product: 'Uzun ürün adı',
            sku: 'DENTAL-IMPLANT-SUPER-LONG-SKU-2026-000123',
            model: 'PROFESSIONAL-MODEL-WITHOUT-BREAKS',
            unit: 'Kutu',
            quantity: '12.500',
          },
        },
        {
          key: 'smoke-product-2',
          cells: {
            product: 'İkinci ürün satırı',
            sku: 'SECOND-SKU-THAT-IS-ALSO-LONG-FOR-OVERFLOW',
            model: 'SECOND-MODEL-WITHOUT-BREAKS-2026',
            unit: 'Adet',
            quantity: '3.000',
          },
        },
      ]}
    />,
  );
}
