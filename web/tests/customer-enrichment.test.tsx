/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe,expect,it } from 'vitest';
import { CustomerDetailView } from '../src/CustomerDetail';
import type { CustomerDetail } from '../src/services/crm-api';
const customer:CustomerDetail={id:'customer-1',organizationId:'org-1',name:'Protected clinic',customerType:'clinic',taxNumber:'PROTECTED',phone:'santral 555',email:null,city:'Ankara',district:null,address:null,assignedStaffUserId:'another-staff',assignedStaffName:'Another Staff',status:'active',version:1,contacts:[],primaryContact:null,hasOperationHistory:false,openJobCount:0,completedJobCount:0};
const staff={id:'staff-1',organizationId:'org-1',name:'Staff',email:'staff@test.local',role:'STAFF' as const,mustChangePassword:false};
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
it('renders only the five enrichment fields using a server-confirmed capability for another Staff customer',async()=>{
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 try{await act(async()=>root.render(<MemoryRouter><CustomerDetailView customer={customer} user={staff} staff={[]} pending={false} error="" notice="" enrichmentScope={{canEnrich:true,canCreateContact:true}} enrichmentEditing={true} onBack={()=>{}} onSave={()=>{}} onCreateContact={()=>{}} /></MemoryRouter>));
 expect(container.textContent).toContain('İletişim bilgilerini tamamla');
 const form=container.querySelector('form[aria-labelledby="customer-enrichment-title"]')!;
 expect(Array.from(form.querySelectorAll('input,textarea')).map(e=>e.getAttribute('name'))).toEqual(['phone','email','city','district','address']);
 expect((form.querySelector('[name="phone"]') as HTMLInputElement).value).toBe('santral 555');
 expect(container.querySelector('input[name="name"],select[name="assignedStaffUserId"]')).toBeNull();
 }finally{await act(async()=>root.unmount());container.remove();}
});
