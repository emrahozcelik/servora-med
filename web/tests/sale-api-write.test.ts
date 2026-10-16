import { afterEach, expect, it, vi } from 'vitest';
import { createSaleFromVisit, correctSale } from '../src/jobs/sale-api';
afterEach(()=>vi.unstubAllGlobals());
it('sends each dedicated Sale intent with opt-in, exact key/version/body and persisted item identity',async()=>{
 const fetch=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({jobCardId:'sale',version:4}),{status:200,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetch);
 const create={clientActionId:'create-key',expectedSourceVersion:3,title:'Sale',description:null,soldAt:'2026-10-16T08:00:00.000Z',saleContactId:null,items:[{productId:'p',quantity:15}]};
 await createSaleFromVisit('visit',create);
 const corrections=[{kind:'details',input:{clientActionId:'details',expectedVersion:1,saleContactId:null}},
  {kind:'add',input:{clientActionId:'add',expectedVersion:2,productId:'p',quantity:1}},
  {kind:'quantity',itemId:'line/id',input:{clientActionId:'quantity',expectedVersion:3,quantity:15}},
  {kind:'remove',itemId:'line/id',input:{clientActionId:'remove',expectedVersion:4}}] as const;
 for(const value of corrections)await correctSale('sale',value);
 expect(fetch.mock.calls.map(([url,init])=>[url,init.method,JSON.parse(init.body)])).toEqual([
  ['/api/job-cards/visit/sales?includeSaleCapability=true','POST',create],
  ['/api/job-cards/sale/sale-details?includeSaleCapability=true','PATCH',corrections[0].input],
  ['/api/job-cards/sale/sale-items?includeSaleCapability=true','POST',corrections[1].input],
  ['/api/job-cards/sale/sale-items/line%2Fid?includeSaleCapability=true','PATCH',corrections[2].input],
  ['/api/job-cards/sale/sale-items/line%2Fid?includeSaleCapability=true','DELETE',corrections[3].input],
 ]);
});
