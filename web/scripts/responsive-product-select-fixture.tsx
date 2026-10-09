import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { ProductSelect } from '../src/ProductSelect';
import type { Product } from '../src/services/products-api';

const products: Product[] = ['ml', 'set'].map((unit, index) => ({
  id: `quantity-product-${index}`, organizationId: 'synthetic-org',
  name: index === 0 ? 'Uzun dental restorasyon malzemesi hassas klinik kullanım için ayrıntılı ürün adı '.repeat(3) : 'Vida seti',
  sku: `SYNTHETIC-${'1234567890'.repeat(8)}`, brand: 'Sentetik Dental',
  category: null, model: 'LONGMODEL'.repeat(10), unit, referencePrice: null,
  isActive: true, version: 1, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
}));

const root = document.getElementById('responsive-product-select-root');
if (root) {
  flushSync(() => createRoot(root).render(<ProductSelect selectedProducts={products}
    onAdd={() => {}} onRemove={() => {}}
    renderQuantity={(product) => <>
      <label htmlFor={`quantity-${product.id}`}>Miktar<span className="sr-only">: {product.name}</span></label>
      <input className="form-control" id={`quantity-${product.id}`} type="number" min="0.001" step="0.001"
        inputMode="decimal" value={product.id === products[0]!.id ? 0.001 : 0.5} readOnly />
    </>} />));
}
