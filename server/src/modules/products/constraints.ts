export const PRODUCT_TEXT_LIMITS = {
  name: 255,
  sku: 100,
  brand: 100,
  category: 100,
  model: 100,
  unit: 30,
} as const;

export const PRODUCT_REFERENCE_PRICE_MAX = 9_999_999_999.99;

export type ProductTextField = keyof typeof PRODUCT_TEXT_LIMITS;

export const PRODUCT_FIELD_LABELS: Record<ProductTextField, string> = {
  name: 'Ürün adı',
  sku: 'SKU',
  brand: 'Marka',
  category: 'Kategori',
  model: 'Model',
  unit: 'Birim',
};
