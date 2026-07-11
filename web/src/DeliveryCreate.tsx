import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  addDeliveryItem,
  createJobCard,
  type CurrentUser,
  type DeliveryPurpose,
  type ReferenceCustomer,
  type ReferenceProduct,
} from './services/api';

export type DeliveryFormValues = {
  customerId: string;
  customerName: string;
  productId: string;
  deliveryPurpose: DeliveryPurpose;
  quantity: number;
  deliveredAt: string;
  deliveryNote?: string;
};

type FlowDependencies = {
  createJob: (input: Parameters<typeof createJobCard>[0]) => Promise<{ id: string; version: number }>;
  addItem: (jobId: string, input: Parameters<typeof addDeliveryItem>[1]) => Promise<{ jobCardVersion: number }>;
  createActionId: () => string;
};

const defaultDependencies: FlowDependencies = {
  createJob: createJobCard,
  addItem: addDeliveryItem,
  createActionId: () => crypto.randomUUID(),
};

export async function createProductDelivery(
  user: CurrentUser,
  values: DeliveryFormValues,
  dependencies: FlowDependencies = defaultDependencies,
) {
  const job = await dependencies.createJob({
    clientActionId: dependencies.createActionId(),
    type: 'PRODUCT_DELIVERY',
    title: `${values.customerName} ürün teslimi`,
    customerId: values.customerId,
    assignedTo: user.id,
    priority: 'normal',
  });
  const delivery = await dependencies.addItem(job.id, {
    clientActionId: dependencies.createActionId(),
    expectedVersion: job.version,
    productId: values.productId,
    deliveryPurpose: values.deliveryPurpose,
    deliveredAt: new Date(values.deliveredAt).toISOString(),
    quantity: values.quantity,
    deliveryNote: values.deliveryNote?.trim() || null,
  });
  return { jobCardId: job.id, version: delivery.jobCardVersion };
}

export function DeliveryCreateView({ user, customers, products, onCancel, onCreated }: {
  user: CurrentUser;
  customers: ReferenceCustomer[];
  products: ReferenceProduct[];
  onCancel: () => void;
  onCreated: (result: { jobCardId: string; version: number }) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError('');
    const data = new FormData(event.currentTarget);
    const customerId = String(data.get('customerId') ?? '');
    const customer = customers.find((item) => item.id === customerId);
    try {
      if (!customer) throw new Error('Geçerli bir müşteri seçin.');
      const result = await createProductDelivery(user, {
        customerId,
        customerName: customer.name,
        productId: String(data.get('productId') ?? ''),
        deliveryPurpose: String(data.get('deliveryPurpose') ?? '') as DeliveryPurpose,
        quantity: Number(data.get('quantity')),
        deliveredAt: String(data.get('deliveredAt') ?? ''),
        deliveryNote: String(data.get('deliveryNote') ?? ''),
      });
      onCreated(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Teslim kaydı oluşturulamadı. Tekrar deneyin.');
      setPending(false);
    }
  }

  const unavailable = customers.length === 0 || products.length === 0;
  return <main className="delivery-create">
    <div className="delivery-heading"><div><p className="eyebrow">Yeni kayıt</p><h1>Ürün teslimi</h1></div>
      <button className="secondary-button" type="button" onClick={onCancel} disabled={pending}>Vazgeç</button></div>
    <p className="form-intro">Teslim edilen ürünü ve işlem amacını kaydedin. Tüm alanlar zorunludur.</p>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
    {unavailable && <div className="form-error" role="status">Teslim oluşturmak için aktif müşteri ve ürün kaydı gereklidir.</div>}
    <form className="delivery-form" onSubmit={submit}>
      <div className="field-group"><label htmlFor="delivery-customer">Müşteri</label>
        <select id="delivery-customer" name="customerId" required disabled={pending || unavailable} defaultValue="">
          <option value="" disabled>Seçin</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></div>
      <div className="field-group"><label htmlFor="delivery-product">Ürün</label>
        <select id="delivery-product" name="productId" required disabled={pending || unavailable} defaultValue="">
          <option value="" disabled>Seçin</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}
        </select></div>
      <div className="delivery-pair">
        <div className="field-group"><label htmlFor="delivery-purpose">Teslim amacı</label>
          <select id="delivery-purpose" name="deliveryPurpose" required disabled={pending} defaultValue="SALE">
            <option value="SALE">Satış</option><option value="SAMPLE">Numune</option><option value="CONSIGNMENT">Konsinye</option><option value="RETURN">İade</option><option value="OTHER">Diğer</option>
          </select></div>
        <div className="field-group"><label htmlFor="delivery-quantity">Miktar</label>
          <input id="delivery-quantity" name="quantity" type="number" min="0.001" step="0.001" inputMode="decimal" required disabled={pending} /></div>
      </div>
      <div className="field-group"><label htmlFor="delivered-at">Teslim zamanı</label>
        <input id="delivered-at" name="deliveredAt" type="datetime-local" required disabled={pending} /></div>
      <div className="field-group"><label htmlFor="delivery-note">Teslim notu (isteğe bağlı)</label>
        <textarea id="delivery-note" name="deliveryNote" rows={3} disabled={pending} /></div>
      <button className="primary-button" type="submit" disabled={pending || unavailable}>{pending ? 'Kaydediliyor…' : 'Teslimi kaydet'}</button>
    </form>
  </main>;
}
