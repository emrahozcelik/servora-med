// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SaleCorrectionSection } from '../src/jobs/SaleCorrection';
import type { SaleDetails } from '../src/jobs/sale-api';
import { isoInstantToLocalDateTime } from '../src/jobs/scheduling';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('../src/services/products-api', () => ({ listProducts: vi.fn() }));
vi.mock('../src/services/crm-api', () => ({ listContacts: vi.fn().mockResolvedValue({items:[],total:0,limit:20,offset:0}) }));
vi.mock('../src/jobs/sale-api', () => ({ correctSale: vi.fn() }));

const CONTACT_A = { id: 'a', name: 'First contact', title: null };
const CONTACT_B = { id: 'b', name: 'Other contact', title: null };
const SOLD_T1 = '2026-10-15T08:00:00.000Z';
const SOLD_T2 = '2026-10-16T10:30:00.000Z';
const base: SaleDetails = {jobCardId:'sale',jobCardVersion:2,soldAt:SOLD_T1,saleContact:CONTACT_A,
  sourceVisit:{access:'RESTRICTED',kind:'SALE_FROM_VISIT'},items:[{id:'line',productId:'product',name:'Historical product',sku:'SKU',brand:'Brand',model:null,unit:'adet',quantity:'5'}]};

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.clearAllMocks();});

function soldInput(): HTMLInputElement { return host.querySelector('input[type="datetime-local"]') as HTMLInputElement; }
function contactSelect(): HTMLSelectElement { return host.querySelector('select.sale-contact-select') as HTMLSelectElement; }
function quantityInput(): HTMLInputElement { return host.querySelector('input[aria-label="Historical product satış adedi"]') as HTMLInputElement; }
function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b)=>b.textContent===text);
  if (!button) throw new Error('button not found: ' + text);
  return act(async()=>{button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
}
async function typeQuantity(value: string) {
  const input = quantityInput();
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
}

it('refreshes untouched correction fields from a version skipped during a quantity attempt', async()=>{
  const {correctSale}=await import('../src/jobs/sale-api');
  let resolveCorrection!: (value:{jobCardId:string;version:number})=>void;
  vi.mocked(correctSale).mockImplementationOnce(()=>new Promise((done)=>{resolveCorrection=done;}));
  // Another user updates soldAt and sale contact while our attempt is in flight (realtime V3).
  const v3: SaleDetails = {...base,jobCardVersion:3,soldAt:SOLD_T2,saleContact:CONTACT_B};
  // Canonical GET merges the other user's details change with our quantity (version V4).
  const v4: SaleDetails = {...v3,jobCardVersion:4,items:v3.items.map((i)=>({...i,quantity:'15'}))};
  const render=(value:SaleDetails)=>{ root.render(<SaleCorrectionSection details={value} customerId="customer" disabled={false} onLockChange={vi.fn()} onChanged={changed} />); };
  // The parent applies the canonical GET *during* onChanged, before our attempt releases.
  // Parked (not nested-act): the test drives each interleaving step in its own act() scope.
  let releaseChanged!: ()=>void;
  const changed=vi.fn().mockImplementation(()=>new Promise<void>((done)=>{ releaseChanged=done; render(v4); }));
  await act(async()=>render(base));
  expect(soldInput().value).toBe(isoInstantToLocalDateTime(SOLD_T1));
  expect(contactSelect().value).toBe('a');
  await typeQuantity('15');
  await click('Adedi kaydet');
  // Frozen payload pins the pre-attempt version and quantity.
  expect(correctSale).toHaveBeenCalledWith('sale', expect.objectContaining({kind:'quantity',itemId:'line',input:{clientActionId:expect.any(String),expectedVersion:2,quantity:15}}));
  await act(async()=>render(v3));
  // Frozen in-flight correction is untouched.
  expect(quantityInput().value).toBe('15');
  // Resolve the server call, then flush: the parent render (V4) lands while sending is still true.
  await act(async()=>{ resolveCorrection({jobCardId:'sale',version:4}); });
  expect(changed).toHaveBeenCalledTimes(1);
  // Release the parked canonical GET and flush the reconciliation.
  await act(async()=>{ releaseChanged(); });
  // Frozen payload never changed.
  expect(vi.mocked(correctSale).mock.calls).toHaveLength(1);
  // Untouched fields now show the authoritative server values.
  expect(soldInput().value).toBe(isoInstantToLocalDateTime(SOLD_T2));
  expect(contactSelect().value).toBe('b');
  // A details save with no further edits must not rewrite the other user's values.
  await click('Satış bilgilerini kaydet');
  expect(host.textContent).toContain('Kaydedilecek değişiklik yok.');
  expect(vi.mocked(correctSale).mock.calls).toHaveLength(1);
});

it('refreshes untouched fields on the conflict-reload path without touching the frozen retry', async()=>{
  const {correctSale}=await import('../src/jobs/sale-api');
  const {ApiError}=await import('../src/services/api');
  vi.mocked(correctSale).mockRejectedValueOnce(new ApiError(409,'VERSION_CONFLICT','Changed'));
  // The canonical reload returns the other user's authoritative values at a newer version.
  const v3: SaleDetails = {...base,jobCardVersion:3,soldAt:SOLD_T2,saleContact:CONTACT_B};
  const render=(value:SaleDetails)=>{ root.render(<SaleCorrectionSection details={value} customerId="customer" disabled={false} onLockChange={vi.fn()} onChanged={changed} />); };
  let releaseChanged!: ()=>void;
  const changed=vi.fn().mockImplementation(()=>new Promise<void>((done)=>{ releaseChanged=done; render(v3); }));
  await act(async()=>render(base));
  await typeQuantity('15');
  await click('Adedi kaydet');
  expect(host.textContent).toContain('Güncel kaydı yükle ve düzeltmeye devam et');
  await click('Güncel kaydı yükle ve düzeltmeye devam et');
  expect(changed).toHaveBeenCalledTimes(1);
  await act(async()=>{ releaseChanged(); });
  expect(soldInput().value).toBe(isoInstantToLocalDateTime(SOLD_T2));
  expect(contactSelect().value).toBe('b');
  await click('Satış bilgilerini kaydet');
  expect(host.textContent).toContain('Kaydedilecek değişiklik yok.');
  expect(vi.mocked(correctSale).mock.calls).toHaveLength(1);
});

it('keeps unsent user edits when a newer version arrives', async()=>{
  const render=(value:SaleDetails)=>root.render(<SaleCorrectionSection details={value} customerId="customer" disabled={false} onLockChange={vi.fn()} onChanged={vi.fn()} />);
  await act(async()=>render(base));
  const sold = soldInput();
  const edited = '2026-10-17T09:15';
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(sold,edited);sold.dispatchEvent(new Event('input',{bubbles:true}));});
  // A newer version with unchanged server values must not wipe the unsent edit.
  await act(async()=>render({...base,jobCardVersion:3}));
  expect(soldInput().value).toBe(edited);
  // A newer version with changed server values still preserves the user's own edit.
  await act(async()=>render({...base,jobCardVersion:4,soldAt:SOLD_T2,saleContact:CONTACT_B}));
  expect(soldInput().value).toBe(edited);
});
