import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toErrorResponse } from '../src/errors/index.js';
import { PostgresCrmRepository, type CrmRepository } from '../src/modules/crm/repository.js';
import { CrmService } from '../src/modules/crm/service.js';
import { crmRoutes } from '../src/modules/crm/routes.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import type { JobCardStatus } from '../src/modules/job-cards/types.js';

const url=process.env.TEST_DATABASE_URL;
const applicationName=`servora_crm_enrichment_${process.pid}`;
const schema=`crm_enrichment_${randomUUID().replaceAll('-', '')}`;
const adminPool=url ? new Pool({connectionString:url}) : null;
const pool=url ? new Pool({connectionString:url,application_name:applicationName,options:`-c search_path=${schema},public`}) : null;
beforeAll(async()=>{
  if(!pool||!adminPool)return;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  await runMigrations({migrationsDirectory:fileURLToPath(new URL('../src/db/migrations',import.meta.url)),store:new PostgresMigrationStore(pool)});
});
const apps: FastifyInstance[]=[];
afterAll(async()=>{
  await Promise.all(apps.map(a=>a.close()));await pool?.end();
  if(adminPool){await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);await adminPool.end();}
});
async function fixture(status: JobCardStatus | null=null, directlyAssigned=true) {
  const organizationId=randomUUID(), staffId=randomUUID(), otherId=randomUUID(), managerId=randomUUID(), customerId=randomUUID(), jobId=randomUUID();
  await pool!.query(`INSERT INTO organizations(id,name) VALUES($1,'Synthetic enrichment')`,[organizationId]);
  await pool!.query(`INSERT INTO users(id,organization_id,name,email,password_hash,role) VALUES
    ($1,$4,'Staff',$5,'synthetic','STAFF'),($2,$4,'Other',$6,'synthetic','STAFF'),($3,$4,'Manager',$7,'synthetic','MANAGER')`,[staffId,otherId,managerId,organizationId,staffId+'@test.local',otherId+'@test.local',managerId+'@test.local']);
  await pool!.query(`INSERT INTO customers(id,organization_id,name,customer_type,status,assigned_staff_user_id,phone,city,tax_number)
    VALUES($1,$2,'Protected clinic','clinic','active',$3,'historical switchboard','Ankara','PROTECTED')`,[customerId,organizationId,directlyAssigned?staffId:otherId]);
  if(status) {
    await pool!.query(`INSERT INTO job_cards(id,organization_id,type,title,customer_id,assigned_to,created_by,status,accepted_at,accepted_by,started_at,staff_completed_at,staff_completed_by,manager_approved_at,manager_approved_by,revision_requested_at,revision_requested_by,revision_reason,cancelled_at,cancelled_by,cancel_reason,invalidated_at,invalidated_by,invalidation_reason_code)
      VALUES($1,$2,'GENERAL_TASK','Synthetic job',$3,$4,$5,$6::text,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [jobId,organizationId,customerId,staffId,managerId,status,
        status==='ACCEPTED'?new Date():null,status==='ACCEPTED'?staffId:null,
        ['IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED','COMPLETED'].includes(status)?new Date():null,
        ['WAITING_APPROVAL','REVISION_REQUESTED','COMPLETED'].includes(status)?new Date():null,['WAITING_APPROVAL','REVISION_REQUESTED','COMPLETED'].includes(status)?staffId:null,
        status==='COMPLETED'?new Date():null,status==='COMPLETED'?managerId:null,
        status==='REVISION_REQUESTED'?new Date():null,status==='REVISION_REQUESTED'?managerId:null,status==='REVISION_REQUESTED'?'Synthetic revision':null,
        status==='CANCELLED'?new Date():null,status==='CANCELLED'?managerId:null,status==='CANCELLED'?'Synthetic cancellation':null,
        status==='INVALIDATED'?new Date():null,status==='INVALIDATED'?managerId:null,status==='INVALIDATED'?'OTHER':null]);
  }
  const staff={id:staffId,organizationId,role:'STAFF' as const};
  const repository=new PostgresCrmRepository(pool!);const service=new CrmService(repository);
  const app=Fastify({logger:false});
  app.setErrorHandler((error,_request,reply)=>{const response=toErrorResponse(error);reply.code(response.statusCode).send(response.body);});
  await app.register(crmRoutes,{prefix:'/api',service,authenticate:async request=>{request.currentUser={...staff,name:'Staff',email:staffId+'@test.local',mustChangePassword:false,isActive:true,version:1};}});apps.push(app);
  const state=async()=>{
    const c=(await pool!.query('SELECT * FROM customers WHERE id=$1',[customerId])).rows[0];
    const audits=(await pool!.query('SELECT actor_user_id,subject_id,event_type,metadata,old_value,new_value FROM audit_events WHERE organization_id=$1 ORDER BY created_at,id',[organizationId])).rows;
    const contacts=(await pool!.query('SELECT * FROM contacts WHERE customer_id=$1 ORDER BY id',[customerId])).rows;
    return {c,audits,contacts};
  };
  return {organizationId,staffId,otherId,managerId,customerId,jobId,staff,service,repository,app,state};
}

describe.skipIf(!url)('STAFF enrichment PostgreSQL and HTTP boundary',()=>{
  it('updates whitelisted contact fields atomically through HTTP and records actor/field names in SQL audit',async()=>{
    const f=await fixture();
    const response=await f.app.inject({method:'POST',url:`/api/customers/${f.customerId}/enrichment`,payload:{expectedVersion:1,phone:'0532 123 45 67',email:' Staff@Example.COM ',district:'Çankaya',address:null}});
    expect(response.statusCode).toBe(200);
    const {c,audits}=await f.state();
    expect(c).toMatchObject({phone:'+905321234567',email:'staff@example.com',city:'Ankara',district:'Çankaya',address:null,name:'Protected clinic',tax_number:'PROTECTED',assigned_staff_user_id:f.staffId,status:'active',version:2});
    expect(audits).toMatchObject([{actor_user_id:f.staffId,subject_id:f.customerId,event_type:'CUSTOMER_FIELDS_UPDATED',metadata:{action:'STAFF_ENRICHMENT',authorization:'customer-assignment',jobCardId:null,changedFields:['phone','email','district']},old_value:null,new_value:null}]);
    expect(JSON.stringify(audits)).not.toContain('staff@example.com');
  });
});

describe.skipIf(!url)('Enrichment eligibility matrix',()=>{
  it.each(['NEW','ACCEPTED','IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED'] as const)('grants only current active %s ownership and exposes the same server scope',async status=>{
    const f=await fixture(status,false);
    expect((await f.app.inject({method:'GET',url:`/api/customers/${f.customerId}/enrichment`})).json()).toEqual({canEnrich:true,canCreateContact:true});
    const response=await f.app.inject({method:'POST',url:`/api/customers/${f.customerId}/enrichment`,payload:{expectedVersion:1,city:'İzmir'}});
    expect(response.statusCode).toBe(200);
    const {c,audits}=await f.state();expect(c.city).toBe('İzmir');expect(c.assigned_staff_user_id).toBe(f.otherId);
    expect(audits).toMatchObject([{actor_user_id:f.staffId,metadata:{jobCardId:f.jobId,authorization:'active-job-assignment',changedFields:['city']}}]);
  });
});

describe.skipIf(!url)('Enrichment denied relationships',()=>{
  it.each(['unrelated','completed','cancelled','invalidated','reassigned','creator-only','inactive','foreign-organization','tampered-customer'] as const)('denies %s without any SQL customer/contact/audit mutation',async reason=>{
    const statuses={completed:'COMPLETED',cancelled:'CANCELLED',invalidated:'INVALIDATED'} as const;
    const status=reason in statuses ? statuses[reason as keyof typeof statuses] : ['reassigned','creator-only','tampered-customer'].includes(reason)?'NEW':null;
    const f=await fixture(status,reason==='inactive'||reason==='foreign-organization');
    if(reason==='inactive') await pool!.query("UPDATE customers SET status='inactive' WHERE id=$1",[f.customerId]);
    if(reason==='reassigned'||reason==='creator-only') await pool!.query('UPDATE job_cards SET assigned_to=$2,created_by=$3 WHERE id=$1',[f.jobId,f.otherId,reason==='creator-only'?f.staffId:f.managerId]);
    let target=f.customerId; let targetState:typeof f.state|undefined;
    if(reason==='foreign-organization'){const foreign=await fixture();target=foreign.customerId;targetState=foreign.state;}
    if(reason==='tampered-customer'){target=randomUUID();await pool!.query("INSERT INTO customers(id,organization_id,name,customer_type,status,assigned_staff_user_id) VALUES($1,$2,'Other customer','clinic','active',$3)",[target,f.organizationId,f.otherId]);}
    const before=await f.state(),foreignBefore=await targetState?.();
    const scope=await f.app.inject({method:'GET',url:`/api/customers/${target}/enrichment`});
    if(reason==='foreign-organization')expect(scope.statusCode).toBe(404);else expect(scope.json()).toEqual({canEnrich:false,canCreateContact:false});
    const response=await f.app.inject({method:'POST',url:`/api/customers/${target}/enrichment`,payload:{expectedVersion:1,phone:'0532 123 45 67'}});
    expect(response.statusCode).toBe(reason==='foreign-organization'?404:403);
    expect(await f.state()).toEqual(before);
    const contactResponse=await f.app.inject({method:'POST',url:`/api/customers/${target}/enrichment/contacts`,payload:{expectedVersion:1,name:'Unauthorized'}});
    expect(await targetState?.()).toEqual(foreignBefore);
    expect(contactResponse.statusCode).toBe(reason==='foreign-organization'?404:403);
    expect(await f.state()).toEqual(before);
    if(target!==f.customerId&&reason!=='foreign-organization') expect((await pool!.query('SELECT phone,version FROM customers WHERE id=$1',[target])).rows[0]).toEqual({phone:null,version:1});
  });
});

describe.skipIf(!url)('Enrichment HTTP field boundary',()=>{
  it.each(['name','customerType','taxNumber','assignedStaffUserId','status','organizationId','version','jobId','customerId','eligible'] as const)('rejects privileged/client-trusted %s rather than dropping it',async key=>{
    const f=await fixture();const before=await f.state();
    const response=await f.app.inject({method:'POST',url:`/api/customers/${f.customerId}/enrichment`,payload:{expectedVersion:1,city:'Unauthorized side effect',[key]:'tampered'}});
    expect(response.statusCode).toBe(400);expect(response.json().code).toBe('VALIDATION_ERROR');expect(await f.state()).toEqual(before);
  });
});

describe.skipIf(!url)('Generic mutation permissions preserved',()=>{
  it('rejects STAFF generic customer PATCH and every generic Contact mutation with no SQL side effect',async()=>{
    const f=await fixture();const before=await f.state();const id=randomUUID();
    const full={expectedVersion:1,name:'Forbidden',customerType:'clinic',taxNumber:null,phone:null,email:null,city:null,district:null,address:null,assignedStaffUserId:null};
    const calls=[{method:'PATCH' as const,url:`/api/customers/${f.customerId}`,payload:full},
      {method:'POST' as const,url:`/api/customers/${f.customerId}/contacts`,payload:{name:'Forbidden'}},
      {method:'PATCH' as const,url:`/api/customers/${f.customerId}/contacts/${id}`,payload:{expectedVersion:1,name:'Forbidden'}},
      ...['activate','deactivate','make-primary'].map(action=>({method:'POST' as const,url:`/api/customers/${f.customerId}/contacts/${id}/${action}`,payload:{expectedVersion:1}})),
      {method:'DELETE' as const,url:`/api/customers/${f.customerId}/contacts/${id}`,payload:{expectedVersion:1}}];
    for(const request of calls){const response=await f.app.inject(request);expect(response.statusCode,request.url).toBe(403);expect(await f.state()).toEqual(before);}
  });
});

async function waitForLock() {
 const deadline=Date.now()+3000;
 while(Date.now()<deadline){const result=await pool!.query<{n:string}>(`SELECT COUNT(*)::text AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`,[applicationName]);if(Number(result.rows[0]!.n)>0)return;await new Promise(resolve=>setTimeout(resolve,10));}
 throw new Error('Expected a real PostgreSQL lock waiter');
}
describe.skipIf(!url)('Enrichment concurrent revocation',()=>{
 it('re-evaluates direct ownership after waiting for a concurrent committed reassignment',async()=>{
  const f=await fixture();const blocker=await pool!.connect();let pending:Promise<unknown>|undefined;
  try{await blocker.query('BEGIN');await blocker.query('UPDATE customers SET assigned_staff_user_id=$2,version=version+1 WHERE id=$1',[f.customerId,f.otherId]);
   pending=f.service.enrichCustomer(f.staff,f.customerId,{expectedVersion:1,city:'Unauthorized write'}).catch(error=>error);
   await waitForLock();await blocker.query('COMMIT');expect(await pending).toMatchObject({code:'FORBIDDEN'});
   const state=await f.state();expect(state.c).toMatchObject({city:'Ankara',phone:'historical switchboard',assigned_staff_user_id:f.otherId,version:2});expect(state.audits).toHaveLength(0);
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
 });
});

describe.skipIf(!url)('Enrichment job witness serialization',()=>{
 it('fails closed without an inverse wait when a current authorizing job is being reassigned',async()=>{
  const f=await fixture('NEW',false);const blocker=await pool!.connect();
  try{await blocker.query('BEGIN');await blocker.query('UPDATE job_cards SET assigned_to=$2 WHERE id=$1',[f.jobId,f.otherId]);
   const response=await f.app.inject({method:'POST',url:`/api/customers/${f.customerId}/enrichment`,payload:{expectedVersion:1,city:'Unauthorized write'}});
   expect(response.statusCode).toBe(409);expect(response.json().code).toBe('VERSION_CONFLICT');await blocker.query('COMMIT');
   await expect(f.service.enrichCustomer(f.staff,f.customerId,{expectedVersion:1,city:'Unauthorized write'})).rejects.toMatchObject({code:'FORBIDDEN'});
   const state=await f.state();expect(state.c).toMatchObject({city:'Ankara',version:1});expect(state.audits).toHaveLength(0);
  }finally{await blocker.query('ROLLBACK');blocker.release();}
 });
});

describe.skipIf(!url)('Enrichment witness held until commit',()=>{
 it('keeps the authorizing job locked so concurrent reassignment cannot revoke ownership before commit',async()=>{
  const f=await fixture('NEW',false);let entered!:()=>void,release!:()=>void;
  const reached=new Promise<void>(r=>{entered=r;}),resume=new Promise<void>(r=>{release=r;});
  const service=new CrmService({ ...f.repository,execute:work=>f.repository.execute(tx=>work(new Proxy(tx,{get(target,key){if(key==='enrichCustomer')return async (...args:Parameters<typeof tx.enrichCustomer>)=>{const result=await target.enrichCustomer(...args);entered();await resume;return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}))) } as CrmRepository);
  let pending:Promise<unknown>|undefined,reassignment:Promise<unknown>|undefined;
  try{pending=service.enrichCustomer(f.staff,f.customerId,{expectedVersion:1,city:'Authorized at commit'});await reached;
   reassignment=pool!.query('UPDATE job_cards SET assigned_to=$2 WHERE id=$1',[f.jobId,f.otherId]);await waitForLock();
   release();await pending;await reassignment;
   const {c,audits}=await f.state();expect(c.city).toBe('Authorized at commit');expect(audits).toMatchObject([{metadata:{jobCardId:f.jobId,changedFields:['city']}}]);
   await expect(f.service.enrichCustomer(f.staff,f.customerId,{expectedVersion:2,city:'Forbidden afterwards'})).rejects.toMatchObject({code:'FORBIDDEN'});
   expect((await f.state()).c.city).toBe('Authorized at commit');
  }finally{release();await Promise.allSettled([pending,reassignment]);}
 });
});

describe.skipIf(!url)('Enrichment optimistic version boundary',()=>{
 it('allows one of two concurrent equal-version updates and records only the winner',async()=>{
  const f=await fixture();const results=await Promise.allSettled([
   f.service.enrichCustomer(f.staff,f.customerId,{expectedVersion:1,city:'Winner one'}),
   f.service.enrichCustomer(f.staff,f.customerId,{expectedVersion:1,city:'Winner two'})]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'VERSION_CONFLICT'}});
  const {c,audits}=await f.state();expect(['Winner one','Winner two']).toContain(c.city);expect(c.version).toBe(2);expect(audits).toHaveLength(1);
 });
});


describe.skipIf(!url)('Enrichment optional values and aggregate atomicity', () => {
  it('preserves prospect, historical phone, omitted fields and nullable edit normalization', async () => {
    const f = await fixture();
    await pool!.query("UPDATE customers SET status='prospect' WHERE id=$1", [f.customerId]);
    const response = await f.app.inject({method:'POST',url:`/api/customers/${f.customerId}/enrichment`,payload:{expectedVersion:1,phone:'  historical switchboard  ',email:' Mixed@Example.COM ',district:' ',address:null}});
    expect(response.statusCode).toBe(200);
    expect((await f.state()).c).toMatchObject({status:'prospect',phone:'historical switchboard',email:'mixed@example.com',city:'Ankara',district:null,address:null,version:2});
    const clear = await f.app.inject({method:'POST',url:`/api/customers/${f.customerId}/enrichment`,payload:{expectedVersion:2,phone:null,email:null,city:null}});
    expect(clear.statusCode).toBe(200);
    expect((await f.state()).c).toMatchObject({phone:null,email:null,city:null,version:3});
  });
  it.each([{city:45,expectedVersion:1},{city:'x',expectedVersion:0},{city:'x',expectedVersion:1.5},{city:'x'},{expectedVersion:1}])('rejects malformed input %j atomically', async payload => {
    const f=await fixture(), before=await f.state();
    const response=await f.app.inject({method:'POST',url:`/api/customers/${f.customerId}/enrichment`,payload});
    expect(response.statusCode).toBe(400);expect(await f.state()).toEqual(before);
  });
  it('does not use an actual historical assignment as a current grant', async () => {
    const f=await fixture('NEW',false);
    await pool!.query('UPDATE job_cards SET assigned_to=$2 WHERE id=$1',[f.jobId,f.otherId]);
    await pool!.query(`INSERT INTO job_card_assignment_history(organization_id,job_card_id,from_user_id,to_user_id,changed_by,source,changed_at)
      VALUES($1,$2,NULL,$3,$5,'CREATE',now()-interval '1 day'),($1,$2,$3,$4,$5,'PATCH_REASSIGN',now())`,[f.organizationId,f.jobId,f.staffId,f.otherId,f.managerId]);
    const before=await f.state();
    await expect(f.service.enrichCustomer(f.staff,f.customerId,{expectedVersion:1,city:'Unauthorized'})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(await f.state()).toEqual(before);
  });
  it.each(['ADMIN','MANAGER'] as const)('preserves %s generic editing', async role => {
    const f=await fixture();
    await pool!.query('UPDATE users SET role=$2 WHERE id=$1',[f.managerId,role]);
    const updated=await f.service.updateCustomer({id:f.managerId,organizationId:f.organizationId,role},f.customerId,{expectedVersion:1,name:'Manager changed name',customerType:'clinic',taxNumber:'PROTECTED',phone:'historic phone',email:null,city:'Bursa',district:null,address:null,assignedStaffUserId:f.staffId});
    expect(updated.name).toBe('Manager changed name');expect((await f.state()).c).toMatchObject({name:'Manager changed name',city:'Bursa',version:2});
  });
  it('rolls back customer, contact and version if audit persistence fails', async () => {
    const f=await fixture(), before=await f.state();
    const repository:CrmRepository={...f.repository,execute:work=>f.repository.execute(tx=>work(new Proxy(tx,{get(target,key){if(key==='appendAudit')return async()=>{throw new Error('Synthetic audit failure');};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}})))} as CrmRepository;
    const service=new CrmService(repository);
    await expect(service.enrichCustomer(f.staff,f.customerId,{expectedVersion:1,city:'Must roll back'})).rejects.toThrow('Synthetic audit failure');
    expect(await f.state()).toEqual(before);
    await expect(service.createEnrichmentContact(f.staff,f.customerId,{expectedVersion:1,name:'Must roll back',title:null,phone:null,email:null})).rejects.toThrow('Synthetic audit failure');
    expect(await f.state()).toEqual(before);
  });
});

describe.skipIf(!url)('Scoped contact creation',()=>{
  it.each([true,false])('creates active secondary contacts with direct assignment=%s and rejects a lost-response retry',async direct=>{
    const f=await fixture(direct?null:'NEW',direct);
    const primary=randomUUID();
    await pool!.query("INSERT INTO contacts(id,organization_id,customer_id,name,is_primary,is_active) VALUES($1,$2,$3,'Original primary',true,true)",[primary,f.organizationId,f.customerId]);
    const response=await f.app.inject({method:'POST',url:`/api/customers/${f.customerId}/enrichment/contacts`,payload:{expectedVersion:1,name:' Dr. Synthetic ',title:' Doctor ',phone:'extension 12',email:' CONTACT@Example.COM '}});
    expect(response.statusCode).toBe(201);expect(response.json().customer.version).toBe(2);
    const state=await f.state();expect(state.contacts).toHaveLength(2);
    expect(state.contacts.find(c=>c.id===primary)).toMatchObject({is_primary:true,version:1});
    expect(state.contacts.find(c=>c.id!==primary)).toMatchObject({name:'Dr. Synthetic',title:'Doctor',phone:'extension 12',email:'contact@example.com',is_primary:false,is_active:true,version:1});
    expect(state.c).toMatchObject({version:2,phone:'historical switchboard',city:'Ankara',assigned_staff_user_id:direct?f.staffId:f.otherId});
    expect(state.audits).toMatchObject([{actor_user_id:f.staffId,event_type:'CONTACT_CREATED',metadata:{action:'STAFF_ENRICHMENT',customerId:f.customerId,jobCardId:direct?null:f.jobId,changedFields:['name','title','phone','email']}}]);
    const retry=await f.app.inject({method:'POST',url:`/api/customers/${f.customerId}/enrichment/contacts`,payload:{expectedVersion:1,name:'Dr. Synthetic'}});
    expect(retry.statusCode).toBe(409);expect(retry.json().code).toBe('VERSION_CONFLICT');expect(await f.state()).toEqual(state);
  });
  it('does not assign primary status even to a first scoped contact',async()=>{
    const f=await fixture();
    await f.service.createEnrichmentContact(f.staff,f.customerId,{expectedVersion:1,name:'Secondary',title:null,phone:null,email:null});
    expect((await f.state()).contacts).toMatchObject([{is_primary:false,is_active:true}]);
  });
  it.each(['isPrimary','isActive','customerId','organizationId','jobId','version'])('rejects scoped contact %s escalation without consuming version',async key=>{
    const f=await fixture(),before=await f.state();
    const response=await f.app.inject({method:'POST',url:`/api/customers/${f.customerId}/enrichment/contacts`,payload:{expectedVersion:1,name:'Synthetic',[key]:'tampered'}});
    expect(response.statusCode).toBe(400);expect(await f.state()).toEqual(before);
  });
});


describe.skipIf(!url)('Existing JobCard contact selection boundary',()=>{
  it('selects a scoped-created active contact using existing GENERAL_TASK rules and rejects foreign/inactive contacts and delivery associations',async()=>{
    const f=await fixture();const created=await f.service.createEnrichmentContact(f.staff,f.customerId,{expectedVersion:1,name:'Scoped selectable',title:null,phone:null,email:null});
    const jobs=new JobCardService(new PostgresJobCardRepository(pool!));
    const input={clientActionId:randomUUID(),type:'GENERAL_TASK' as const,title:'Synthetic contact selection',description:null,customerId:f.customerId,contactId:created.contact.id,assignedTo:f.staffId,priority:'normal' as const,dueDate:null,scheduledAt:null};
    const job=await jobs.create(f.staff,input);
    expect(job.contactId).toBe(created.contact.id);expect((await pool!.query('SELECT contact_id FROM job_cards WHERE id=$1',[job.id])).rows[0].contact_id).toBe(created.contact.id);
    const other=randomUUID();await pool!.query("INSERT INTO customers(id,organization_id,name,customer_type,status) VALUES($1,$2,'Another customer','clinic','active')",[other,f.organizationId]);
    await expect(jobs.create(f.staff,{...input,clientActionId:randomUUID(),customerId:other})).rejects.toMatchObject({code:'CONTACT_NOT_IN_CUSTOMER'});
    await pool!.query('UPDATE contacts SET is_active=false WHERE id=$1',[created.contact.id]);
    await expect(jobs.create(f.staff,{...input,clientActionId:randomUUID()})).rejects.toMatchObject({code:'CONTACT_INACTIVE'});
    await expect(jobs.create(f.staff,{...input,clientActionId:randomUUID(),type:'PRODUCT_DELIVERY',scheduledAt:'2026-10-12T08:00:00Z',contactId:created.contact.id} as never)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect((await pool!.query('SELECT COUNT(*)::int AS count FROM job_cards WHERE organization_id=$1',[f.organizationId])).rows[0].count).toBe(1);
  });
});
