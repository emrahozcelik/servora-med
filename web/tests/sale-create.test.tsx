// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SaleCreateScreen } from '../src/SaleCreate';
import * as api from '../src/jobs/sale-api';
import { ApiError } from '../src/services/api';
import { listProducts, type Product } from '../src/services/products-api';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const realtime = vi.hoisted(() => ({ invalidate: () => {} }));
vi.mock('../src/realtime/RealtimeProvider', () => ({useRealtimeInvalidation: (_keys: string[], callback: () => void) => { realtime.invalidate = callback; }}));
vi.mock('../src/jobs/sale-api', () => ({ getSaleCreateContext: vi.fn(), createSaleFromVisit: vi.fn() }));
vi.mock('../src/services/crm-api', () => ({ listContacts: vi.fn().mockResolvedValue({items: [], total: 0, limit: 20, offset: 0}) }));
vi.mock('../src/services/products-api', () => ({ listProducts: vi.fn() }));
const context = { sourceVisitId: 'visit', sourceVersion: 3, eligible: true, blockedReason: null,
 customer: {id:'customer',name:'Dental Klinik'},assignee:{id:'staff',name:'Sorumlu Personel'},
 plannedContact:{id:'planned',name:'Planlanan Doktor',title:null}, metContact:{id:'met',name:'Görüşülen Doktor',title:null},activeSale:null };
const product = (id:string): Product => ({id,organizationId:'org',name:'Ürün '+id,sku:id,brand:'Dental',model:null,unit:'ml',category:null,referencePrice:null,isActive:true,version:1,createdAt:'',updatedAt:''});
let host:HTMLDivElement; let root:ReturnType<typeof createRoot>;
const cancelled=vi.fn(),created=vi.fn();
beforeEach(()=>{
 vi.stubGlobal('matchMedia',vi.fn().mockReturnValue({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn(),addListener:vi.fn(),removeListener:vi.fn()}));
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
 vi.mocked(api.getSaleCreateContext).mockResolvedValue(context);
 vi.mocked(listProducts).mockResolvedValue({items:[product('p1'),product('p2')],total:2,limit:6,offset:0});
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.clearAllMocks();vi.unstubAllGlobals();});
async function render(){await act(async()=>root.render(<SaleCreateScreen visitId="visit" user={{id:'staff',organizationId:'org',role:'STAFF'} as never} onCancel={cancelled} onCreated={created} />));}
function button(label:string){return [...host.querySelectorAll('button')].find((b)=>b.textContent===label)!;}
async function input(selector:string,value:string){await act(async()=>{const node=host.querySelector(selector) as HTMLInputElement;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});}
async function add(id:string){await input('.product-select input[type="search"]','dental');await act(async()=>button('Ürün ara').click());await act(async()=>{(host.querySelector('[data-product-id="'+id+'"]') as HTMLButtonElement).click();});}
async function submit(){await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});}

describe('SaleCreate',()=>{
 it('loads a deep link through server context and shows immutable identity and distinct contacts',async()=>{
  await render();expect(api.getSaleCreateContext).toHaveBeenCalledWith('visit');
  expect(host.textContent).toContain('Dental Klinik');expect(host.textContent).toContain('Planlanan Doktor');expect(host.textContent).toContain('Görüşülen Doktor');
  expect(host.querySelector('input[name="customerId"]')).toBeNull();expect(host.querySelector('input[name="assignedTo"]')).toBeNull();
  expect(host.querySelector('input[type="datetime-local"]')).not.toBeNull();
 });
 it('keeps BUSINESS search and 1/15 product identity pairing, with remove/re-add reset',async()=>{
  vi.mocked(api.createSaleFromVisit).mockResolvedValue({jobCardId:'sale',version:1});
  await render();await add('p1');await add('p2');
  await input('[aria-label="Ürün p2 satış adedi"]','15');
  await act(async()=>{(host.querySelector('[aria-label="Kaldır: Ürün p1"]') as HTMLButtonElement).click();});
  await add('p1');await submit();
  expect(listProducts).toHaveBeenCalledWith(expect.objectContaining({status:'active',dataClass:'BUSINESS',limit:6,offset:0}));
  expect(api.createSaleFromVisit).toHaveBeenCalledWith('visit',expect.objectContaining({expectedSourceVersion:3,saleContactId:null,items:[{productId:'p2',quantity:15},{productId:'p1',quantity:1}]}));
  expect(created).toHaveBeenCalledWith('sale');
 });
 it.each(['','0','-1','0.001','0.5','1.5','1000000000'])('rejects quantity %s before sending',async(value)=>{
  await render();await add('p1');await input('[aria-label="Ürün p1 satış adedi"]',value);await submit();
  expect(api.createSaleFromVisit).not.toHaveBeenCalled();expect(host.querySelector('[role="alert"]')).not.toBeNull();
 });
 it.each([new ApiError(0,'NETWORK_ERROR','Network',true),new ApiError(503,'UNAVAILABLE','Unavailable',true),new ApiError(409,'ACTION_IN_PROGRESS','In progress')])('freezes and retries the exact unresolved request (%s)',async(error)=>{
  vi.mocked(api.createSaleFromVisit).mockRejectedValueOnce(error).mockResolvedValueOnce({jobCardId:'sale',version:1});
  await render();await add('p1');await submit();
  const original=structuredClone(vi.mocked(api.createSaleFromVisit).mock.calls[0]![1]);
  expect(button('Vazgeç').disabled).toBe(true);
  expect((host.querySelector('[aria-label="Ürün p1 satış adedi"]') as HTMLInputElement).matches(':disabled')).toBe(true);
  expect((host.querySelector('.product-select input[type="search"]') as HTMLInputElement).matches(':disabled')).toBe(true);
  await submit();expect(api.createSaleFromVisit).toHaveBeenCalledTimes(1);
  await act(async()=>button('Özgün isteği tekrar dene').click());
  expect(vi.mocked(api.createSaleFromVisit).mock.calls[1]![1]).toEqual(original);
  expect(created).toHaveBeenCalledTimes(1);
 });
 it('prevents duplicate submit while awaiting a committed response',async()=>{
  let resolve!:(v:{jobCardId:string;version:number})=>void;
  vi.mocked(api.createSaleFromVisit).mockImplementationOnce(()=>new Promise((r)=>{resolve=r;}));
  await render();await add('p1');await submit();await submit();
  expect(api.createSaleFromVisit).toHaveBeenCalledTimes(1);expect(button('Vazgeç').disabled).toBe(true);
  await act(async()=>resolve({jobCardId:'sale',version:1}));expect(created).toHaveBeenCalledWith('sale');
 });
 it('refreshes authoritative version after a definitive conflict before a deliberate new intent',async()=>{
  vi.mocked(api.createSaleFromVisit).mockRejectedValueOnce(new ApiError(409,'VERSION_CONFLICT','Changed')).mockResolvedValueOnce({jobCardId:'sale',version:1});
  await render();await add('p1');vi.mocked(api.getSaleCreateContext).mockResolvedValue({...context,sourceVersion:9});
  await submit();await submit();
  const calls=vi.mocked(api.createSaleFromVisit).mock.calls;
  expect(calls[1]![1].expectedSourceVersion).toBe(9);expect(calls[1]![1].clientActionId).not.toBe(calls[0]![1].clientActionId);
 });
 it.each(['FULL','RESTRICTED'] as const)('suppresses creation for an active %s Sale',async(access)=>{
  vi.mocked(api.getSaleCreateContext).mockResolvedValue({...context,eligible:false,blockedReason:'ACTIVE_SALE_EXISTS',activeSale:access==='FULL'?{access,id:'sale',title:'Mevcut satış',status:'ACCEPTED'}:{access}});
  await render();expect(host.querySelector('form')).toBeNull();expect(host.textContent).not.toContain('Satış kaydını oluştur');
  expect(host.querySelector('a[href="/jobs/sale"]')!==null).toBe(access==='FULL');
 });
 it('does not expose a form when deep-link authorization is revoked',async()=>{
  vi.mocked(api.getSaleCreateContext).mockRejectedValue(new ApiError(404,'JOB_CARD_NOT_FOUND','Bulunamadı'));
  await render();expect(host.querySelector('form')).toBeNull();expect(host.textContent).toContain('Bulunamadı');
 });
});

it('clears revoked source context on realtime while preserving the unresolved request',async()=>{
 vi.mocked(api.createSaleFromVisit).mockRejectedValueOnce(new ApiError(0,'NETWORK_ERROR','Lost',true));
 await render();await add('p1');await submit();
 vi.mocked(api.getSaleCreateContext).mockRejectedValue(new ApiError(404,'JOB_CARD_NOT_FOUND','Bulunamadı'));
 await act(async()=>realtime.invalidate());
 expect(host.textContent).not.toContain('Dental Klinik');
 expect(button('Özgün isteği tekrar dene')).toBeDefined();
 expect(api.createSaleFromVisit).toHaveBeenCalledTimes(1);
});
