// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SaleCorrectionSection } from '../src/jobs/SaleCorrection';
import type { SaleDetails } from '../src/jobs/sale-api';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('../src/services/products-api', () => ({ listProducts: vi.fn() }));
vi.mock('../src/services/crm-api', () => ({ listContacts: vi.fn().mockResolvedValue({items:[],total:0,limit:20,offset:0}) }));
vi.mock('../src/jobs/sale-api', () => ({ correctSale: vi.fn() }));
const details: SaleDetails = {jobCardId:'sale',jobCardVersion:2,soldAt:'2026-10-15T08:00:00.000Z',saleContact:null,
 sourceVisit:{access:'RESTRICTED',kind:'SALE_FROM_VISIT'},items:[{id:'line',productId:'product',name:'Tarihsel pasif ürün',sku:'OLD',brand:'Eski marka',model:null,unit:'ml',quantity:'5'}]};
let host:HTMLDivElement; let root:ReturnType<typeof createRoot>;
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.clearAllMocks();});
it('edits snapshot identities using persisted item IDs without fetching live product metadata', async()=>{
 const {correctSale}=await import('../src/jobs/sale-api'); vi.mocked(correctSale).mockResolvedValue({jobCardId:'sale',version:3});
 const changed=vi.fn().mockResolvedValue(undefined);
 await act(async()=>root.render(<SaleCorrectionSection details={details} customerId="customer" disabled={false} onLockChange={vi.fn()} onChanged={changed} />));
 const input=host.querySelector('input[aria-label="Tarihsel pasif ürün satış adedi"]') as HTMLInputElement;
 expect(input).not.toBeNull();
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'15');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>{([...host.querySelectorAll('button')].find((b)=>b.textContent==='Adedi kaydet')!).click();});
 expect(correctSale).toHaveBeenCalledWith('sale',expect.objectContaining({kind:'quantity',itemId:'line',input:{clientActionId:expect.any(String),expectedVersion:2,quantity:15}}));
 expect(changed).toHaveBeenCalled();
 expect(host.textContent).toContain('Eski marka');
});

it('freezes a quantity correction through response loss and a newer realtime projection',async()=>{
 const {correctSale}=await import('../src/jobs/sale-api');
 vi.mocked(correctSale).mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({jobCardId:'sale',version:3});
 const changed=vi.fn().mockResolvedValue(undefined),lock=vi.fn();
 const render=(value:SaleDetails)=>root.render(<SaleCorrectionSection details={value} customerId="customer" disabled={false} onLockChange={lock} onChanged={changed} />);
 await act(async()=>render(details));
 const input=host.querySelector('input[aria-label="Tarihsel pasif ürün satış adedi"]') as HTMLInputElement;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'15');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>{([...host.querySelectorAll('button')].find((b)=>b.textContent==='Adedi kaydet')!).click();});
 const original=structuredClone(vi.mocked(correctSale).mock.calls[0]![1]);
 expect(input.matches(':disabled')).toBe(true);
 await act(async()=>render({...details,jobCardVersion:9,items:details.items.map((i)=>({...i,quantity:'100'}))}));
 expect(input.value).toBe('15');
 await act(async()=>{([...host.querySelectorAll('button')].find((b)=>b.textContent==='Özgün düzeltmeyi tekrar dene')!).click();});
 expect(vi.mocked(correctSale).mock.calls[1]![1]).toEqual(original);
 expect(lock).toHaveBeenLastCalledWith(false);
});

it('keeps all correction controls disabled under the parent lifecycle lock',async()=>{
 await act(async()=>root.render(<SaleCorrectionSection details={details} customerId="customer" disabled={true} onLockChange={vi.fn()} onChanged={vi.fn()} />));
 for(const control of host.querySelectorAll('input,select,button'))expect(control.matches(':disabled')).toBe(true);
});

it('requires a canonical reload after a definitive version conflict',async()=>{
 const {correctSale}=await import('../src/jobs/sale-api');const {ApiError}=await import('../src/services/api');
 vi.mocked(correctSale).mockRejectedValueOnce(new ApiError(409,'VERSION_CONFLICT','Changed'));
 const changed=vi.fn().mockResolvedValue(undefined),lock=vi.fn();
 await act(async()=>root.render(<SaleCorrectionSection details={details} customerId="customer" disabled={false} onLockChange={lock} onChanged={changed} />));
 const input=host.querySelector('input[aria-label="Tarihsel pasif ürün satış adedi"]') as HTMLInputElement;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'15');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>{([...host.querySelectorAll('button')].find((b)=>b.textContent==='Adedi kaydet')!).click();});
 expect(input.matches(':disabled')).toBe(true);expect(changed).not.toHaveBeenCalled();
 await act(async()=>{([...host.querySelectorAll('button')].find((b)=>b.textContent==='Güncel kaydı yükle ve düzeltmeye devam et')!).click();});
 expect(changed).toHaveBeenCalledTimes(1);expect(lock).toHaveBeenLastCalledWith(false);expect(input.value).toBe('5');
});

it('does not reset an unsent draft on a same-version realtime projection',async()=>{
 const contact={id:'c',name:'Historical contact',title:null};const original={...details,saleContact:contact};
 const render=(value:SaleDetails)=>root.render(<SaleCorrectionSection details={value} customerId="customer" disabled={false} onLockChange={vi.fn()} onChanged={vi.fn()} />);
 await act(async()=>render(original));
 const input=host.querySelector('input[aria-label="Tarihsel pasif ürün satış adedi"]') as HTMLInputElement;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'15');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>render({...original,saleContact:{...contact}}));
 expect(input.value).toBe('15');
});
