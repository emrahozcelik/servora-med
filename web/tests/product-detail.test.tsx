/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProductDetailScreen } from '../src/ProductDetail';
import { ApiError, type CurrentUser } from '../src/services/api';
import type { Product } from '../src/services/products-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};
const staff: CurrentUser = { ...manager, id: 'staff-1', role: 'STAFF' };
const product: Product = {
  id: 'product-1', organizationId: 'org-1', name: 'Dental İmplant', sku: null,
  brand: null, category: null, model: null, unit: null, referencePrice: null,
  isActive: true, version: 3, createdAt: '2026-07-13T08:00:00.000Z',
  updatedAt: '2026-07-13T08:00:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('Product detail', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks();
  });

  async function render(load = vi.fn().mockResolvedValue(product), user: CurrentUser = manager, overrides = {}) {
    const props = {
      productId: product.id, user, load, update: vi.fn(), activate: vi.fn(), deactivate: vi.fn(), ...overrides,
    };
    await act(async () => root.render(<ProductDetailScreen {...props} />));
    return props;
  }

  it('renders loading, not-found, forbidden, and retryable generic error states explicitly', async () => {
    const request = deferred<Product>();
    await render(vi.fn().mockReturnValue(request.promise));
    expect(container.textContent).toContain('Ürün detayı yükleniyor');
    await act(async () => request.reject(new ApiError(404, 'PRODUCT_NOT_FOUND', 'Ürün bulunamadı.')));
    expect(container.textContent).toContain('Ürün bulunamadı');

    const forbiddenLoad = vi.fn().mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Yetkiniz yok.'));
    await render(forbiddenLoad);
    expect(container.textContent).toContain('Bu ürünü görüntüleme yetkiniz yok');

    const retryLoad = vi.fn()
      .mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'Şu anda ulaşılamıyor.', true))
      .mockResolvedValueOnce(product);
    await render(retryLoad);
    expect(container.textContent).toContain('Ürün yüklenemedi');
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Tekrar dene')!;
    await act(async () => retry.click());
    expect(retryLoad).toHaveBeenCalledTimes(2); expect(container.textContent).toContain(product.name);
  });

  it('renders every nullable field as meaningful absence without fabricated values', async () => {
    await render();
    for (const label of ['SKU', 'Marka', 'Kategori', 'Model', 'Birim', 'Referans fiyat']) {
      expect(container.textContent).toContain(label);
    }
    expect(container.querySelectorAll('dd')).toHaveLength(9);
    expect(Array.from(container.querySelectorAll('dd')).filter((node) => node.textContent === 'Belirtilmedi')).toHaveLength(6);
    expect(container.textContent).not.toContain('adet');
    expect(container.textContent).not.toContain('₺');
  });

  it('keeps Staff read-only while Manager can enter edit mode', async () => {
    await render(undefined, staff);
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).not.toContain('Ürünü düzenle');
    expect(container.textContent).not.toContain('Pasifleştir');

    await render(undefined, manager);
    const edit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Ürünü düzenle')!;
    await act(async () => edit.click());
    expect(container.querySelector<HTMLInputElement>('[name="name"]')?.value).toBe(product.name);
  });

  it('patches with the displayed version and refreshes detail with the returned version', async () => {
    const updated = { ...product, name: 'Güncel İmplant', version: 4 };
    const update = vi.fn().mockResolvedValue(updated);
    await render(undefined, manager, { update });
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Ürünü düzenle')!.click());
    const name = container.querySelector<HTMLInputElement>('[name="name"]')!; name.value = updated.name;
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(update).toHaveBeenCalledWith(product.id, expect.objectContaining({ name: updated.name, expectedVersion: 3 }));
    expect(container.textContent).toContain(updated.name); expect(container.textContent).toContain('Sürüm 4');
    expect(container.querySelector('form')).toBeNull();
  });

  it('preserves every dirty field on conflict until the user explicitly reloads current values', async () => {
    const current = { ...product, name: 'Sunucudaki Ürün', sku: 'SERVER', version: 7 };
    const load = vi.fn().mockResolvedValueOnce(product).mockResolvedValueOnce(current);
    const update = vi.fn().mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Kayıt başka bir kullanıcı tarafından güncellendi.', false, { currentVersion: 7 }));
    await render(load, manager, { update });
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Ürünü düzenle')!.click());
    const values = { name: 'Yerel Ürün', sku: 'LOCAL', brand: 'Yerel Marka', category: 'Yerel Kategori', model: 'Yerel Model', unit: 'kutu', referencePrice: '125.50' };
    for (const [field, value] of Object.entries(values)) container.querySelector<HTMLInputElement>(`[name="${field}"]`)!.value = value;
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(load).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Güncel sürüm: 7');
    for (const [field, value] of Object.entries(values)) expect(container.querySelector<HTMLInputElement>(`[name="${field}"]`)!.value).toBe(value);

    const reload = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Güncel değerleri yükle')!;
    await act(async () => reload.click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe(current.name);
    expect(container.querySelector<HTMLInputElement>('[name="sku"]')!.value).toBe(current.sku);
  });

  it('keeps dirty edit values and the reload action when explicit conflict reload fails', async () => {
    const load = vi.fn().mockResolvedValueOnce(product)
      .mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'Güncel değerler alınamadı.', true));
    const update = vi.fn().mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Güncel değil.', false, { currentVersion: 8 }));
    await render(load, manager, { update });
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Ürünü düzenle')!.click());
    const name = container.querySelector<HTMLInputElement>('[name="name"]')!; name.value = 'Korunan yerel ad';
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Güncel değerleri yükle')!.click());
    expect(name.value).toBe('Korunan yerel ad');
    expect(container.textContent).toContain('Güncel değerler alınamadı.');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Güncel değerleri yükle')).toBe(true);
  });

  it('associates an invalid edit price error and focuses the edit error summary', async () => {
    await render();
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Ürünü düzenle')!.click());
    const price = container.querySelector<HTMLInputElement>('[name="referencePrice"]')!; price.value = '-1';
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(price.getAttribute('aria-invalid')).toBe('true');
    expect(price.getAttribute('aria-describedby')).toContain('product-reference-price-error');
    expect(container.textContent).toContain('Referans fiyat sıfırdan küçük olamaz.');
    expect(document.activeElement).toBe(container.querySelector('[role="alert"]'));
  });

  it('associates a blank edit name error and focuses the required field', async () => {
    await render();
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Ürünü düzenle')!.click());
    const name = container.querySelector<HTMLInputElement>('[name="name"]')!; name.value = '   ';
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toContain('product-name-error');
    expect(document.activeElement).toBe(name);
  });

  it('focuses the first backend-invalid edit field', async () => {
    const update = vi.fn().mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'Alanları kontrol edin.', false, {
      fieldErrors: { name: 'Ürün adı kullanılamaz.', referencePrice: 'Referans fiyat geçersiz.' },
    }));
    await render(undefined, manager, { update });
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Ürünü düzenle')!.click());
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    const name = container.querySelector<HTMLInputElement>('[name="name"]')!;
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('Ürün adı kullanılamaz.');
    expect(document.activeElement).toBe(name);
  });

  it('names the product and explains deactivation consequences before requiring explicit confirmation', async () => {
    const deactivate = vi.fn().mockResolvedValue({ ...product, isActive: false, version: 4 });
    await render(undefined, manager, { deactivate });
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Pasifleştir')!;
    trigger.focus(); await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain(product.name);
    expect(dialog.textContent).toContain('yeni seçimlerde kullanılamaz');
    expect(dialog.textContent).toContain('geçmiş kayıtlar değişmeden kalır');
    expect(deactivate).not.toHaveBeenCalled();
    expect((document.activeElement as HTMLButtonElement).textContent).toBe('Vazgeç');
    await act(async () => Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === 'Pasifleştir')!.click());
    expect(deactivate).toHaveBeenCalledWith(product.id, 3);
    expect(container.textContent).toContain('Ürün pasifleştirildi');
  });

  it('traps dialog focus, closes on Escape, and restores trigger focus', async () => {
    await render();
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Pasifleştir')!;
    trigger.focus(); await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const buttons = Array.from(dialog.querySelectorAll('button'));
    buttons[buttons.length - 1].focus();
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })));
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  });

  it('redirects real external focus while open and removes the guard after close', async () => {
    await render();
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Pasifleştir')!;
    trigger.focus(); await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const outside = document.createElement('button'); document.body.append(outside);
    await act(async () => outside.focus());
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.activeElement).toBe(trigger);
    await act(async () => outside.focus());
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('keeps focus inside the dialog while deactivation is pending', async () => {
    const request = deferred<Product>();
    await render(undefined, manager, { deactivate: vi.fn().mockReturnValue(request.promise) });
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Pasifleştir')!;
    await act(async () => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === 'Pasifleştir')!;
    confirm.focus(); await act(async () => confirm.click());
    expect(container.querySelector('[role="dialog"]')).toBe(dialog);
    const outside = document.createElement('button'); document.body.append(outside);
    await act(async () => outside.focus());
    expect(dialog.contains(document.activeElement)).toBe(true);
    outside.remove();
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })));
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => request.resolve({ ...product, isActive: false, version: 4 }));
  });

  it('offers explicit recovery for lifecycle conflict without auto-refetching', async () => {
    const inactive = { ...product, isActive: false, version: 5 };
    const current = { ...inactive, isActive: true, version: 8 };
    const load = vi.fn().mockResolvedValueOnce(inactive).mockResolvedValueOnce(current);
    const activate = vi.fn().mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Unsafe server copy.', false, { currentVersion: 8 }));
    await render(load, manager, { activate });
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Etkinleştir')!.click());
    expect(load).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Pasif'); expect(container.textContent).toContain('Sürüm 5');
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(container.textContent).toContain('Güncel sürüm: 8');
    expect(container.textContent).not.toContain('Unsafe server copy.');
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Güncel değerleri yükle')!.click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Aktif'); expect(container.textContent).toContain('Sürüm 8');
  });

  it('keeps lifecycle snapshot and recovery available when explicit reload fails', async () => {
    const inactive = { ...product, isActive: false, version: 5 };
    const load = vi.fn().mockResolvedValueOnce(inactive)
      .mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'Güncel ürün yüklenemedi.', true));
    const activate = vi.fn().mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Güncel değil.', false, { currentVersion: 8 }));
    await render(load, manager, { activate });
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Etkinleştir')!.click());
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Güncel değerleri yükle')!.click());
    expect(container.textContent).toContain('Pasif'); expect(container.textContent).toContain('Sürüm 5');
    expect(container.textContent).toContain('Güncel ürün yüklenemedi.');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Güncel değerleri yükle')).toBe(true);
  });

  it('activates directly, waits for backend success, and preserves truth on lifecycle failure', async () => {
    const inactive = { ...product, isActive: false, version: 5 };
    const request = deferred<Product>(); const activate = vi.fn().mockReturnValue(request.promise);
    await render(vi.fn().mockResolvedValue(inactive), manager, { activate });
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Etkinleştir')!;
    await act(async () => button.click());
    expect(activate).toHaveBeenCalledWith(product.id, 5); expect(button.disabled).toBe(true);
    expect(container.textContent).not.toContain('Ürün etkinleştirildi');
    await act(async () => request.resolve({ ...inactive, isActive: true, version: 6 }));
    expect(container.textContent).toContain('Ürün etkinleştirildi'); expect(container.textContent).toContain('Sürüm 6');

    const failedDeactivate = vi.fn().mockRejectedValue(new ApiError(503, 'SERVICE_UNAVAILABLE', 'İşlem tamamlanamadı.', true));
    await render(undefined, manager, { deactivate: failedDeactivate });
    await act(async () => Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Pasifleştir')!.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => Array.from(dialog.querySelectorAll('button')).find((item) => item.textContent === 'Pasifleştir')!.click());
    expect(container.textContent).toContain('İşlem tamamlanamadı.');
    expect(container.textContent).not.toContain('Ürün pasifleştirildi');
    expect(container.textContent).toContain('Aktif');
  });
});
