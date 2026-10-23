import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';

const server = fileURLToPath(new URL('../../', import.meta.url));
const load = (file) => import(pathToFileURL(resolve(server, 'dist', file)).href);
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error(`Observation deadline: ${label}`);
}
export async function port() {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const value = socket.address().port; await new Promise((r) => socket.close(r)); return value;
}
export async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try { await until(async () => child.exitCode !== null || child.signalCode !== null, 'graceful child shutdown', 10000); }
  catch (error) { child.kill('SIGKILL'); await once(child, 'exit'); throw error; }
  assert.equal(child.exitCode, 0, 'owned child must shut down without force');
}
export async function withRetirementFixture(run, evidenceDirectory) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  const ciService = process.env.CI === 'true' && url.hostname === 'servora-localci-pg';
  assert(ciService || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert(url.password && (/^\/servora_med_test_[a-z0-9_]+$/i.test(url.pathname) || (process.env.CI === 'true' && url.pathname === '/servora_med_test')), 'explicit isolated test DB required');
  const admin = new Pool({ connectionString: url.href });
  const schema = `wrret_accept_${randomUUID().replaceAll('-', '')}`;
  let pool, child;
  let logs = '';
  const snapshots = [];
  const applicationName = schema;
  try {
    assert.equal((await admin.query('SHOW server_version_num')).rows[0].server_version_num.slice(0, 2), '17');
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    pool = new Pool({ connectionString: url.href });
    const { runMigrations } = await load('db/migrate-runner.js');
    const { PostgresMigrationStore } = await load('db/index.js');
    await runMigrations({ migrationsDirectory: resolve(server, 'dist/db/migrations'), store: new PostgresMigrationStore(pool) });
    const { hashPassword } = await load('modules/auth/crypto.js');
    const password = `Acceptance-${randomUUID()}!`;
    const hash = await hashPassword(password);
    const org = (await pool.query("INSERT INTO organizations(name,timezone) VALUES ('WR retirement acceptance','Europe/Istanbul') RETURNING id")).rows[0].id;
    const users = [];
    for (const role of ['MANAGER', 'ADMIN', 'STAFF', 'STAFF']) {
      const i = users.length;
      const user = (await pool.query(`INSERT INTO users(organization_id,name,email,password_hash,role,is_active,must_change_password)
        VALUES($1,$2,$3,$4,$5,true,false) RETURNING id,name,email,role`, [org, `Retirement ${role} ${i}`, `${randomUUID()}@acceptance.local`, hash, role])).rows[0];
      if (role === 'STAFF') await pool.query('INSERT INTO staff_profiles(organization_id,user_id,title) VALUES($1,$2,$3)', [org,user.id,'Saha temsilcisi']);
      users.push(user);
    }
    const [manager, administrator, staff, secondStaff] = users;
    const { JobCardService } = await load('modules/job-cards/service.js');
    const { PostgresJobCardRepository } = await load('modules/job-cards/repository.js');
    const service = new JobCardService(new PostgresJobCardRepository(pool));
    const actor = (u) => ({id:u.id,organizationId:org,role:u.role});
    const { parseWeeklyReportCreateInput } = await load('modules/weekly-reports/create-input.js');
    const old = await service.createWeeklyReport(actor(staff), parseWeeklyReportCreateInput({clientActionId:randomUUID(),periodStart:'2026-08-03'}));
    await service.start(actor(staff),old.jobCardId,{clientActionId:randomUUID(),expectedVersion:1});
    await service.updateWeeklyReportDraft(actor(staff),old.jobCardId,{expectedVersion:1,draft:{summary:'Tarihsel klinik ziyaret özeti',nextWeekPlan:'Dental ürün takibi',blockers:null,highlights:null,fieldObservations:null,supportNeeded:null},answers:[]});
    await service.submitForApproval(actor(staff),old.jobCardId,{clientActionId:randomUUID(),expectedVersion:2,note:'Tarihsel haftalık rapor onaya sunuldu.'});
    await service.approve(actor(manager),old.jobCardId,{clientActionId:randomUUID(),expectedVersion:3});
    for (const [user, enabled] of [[staff,true],[secondStaff,false]]) {
      await pool.query(`INSERT INTO weekly_report_recurrences(organization_id,staff_user_id,requested_by_user_id,enabled,disabled_reason,next_period_start,
        manager_questions,instructions,version,lease_token,lease_until,next_attempt_at,failure_count,last_error_code,last_processed_period_start,last_outcome,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'2026-08-10',$6,$7,7,$8,NOW()-INTERVAL '2 days',NOW()-INTERVAL '1 day',2,'TEST_RETRY','2026-08-03','existing','2026-08-01T09:00:00.123456Z','2026-08-02T10:00:00.654321Z')`,
      [org,user.id,manager.id,enabled,enabled?null:'MANUAL',JSON.stringify([{key:'q1',prompt:'Hangi klinikler ziyaret edildi?'}]),'Klinik ve dental ürün sonuçlarını raporlayın.',randomUUID()]);
    }
    const rules = async () => (await pool.query('SELECT to_jsonb(r) AS row FROM weekly_report_recurrences r ORDER BY id')).rows;
    const history = async () => (await pool.query('SELECT to_jsonb(s) AS row FROM weekly_report_submissions s ORDER BY id')).rows;
    const baseline = await rules(); const historical = await history();
    const submission = (await service.listWeeklyReportSubmissions(actor(staff), old.jobCardId))[0];
    const { buildWeeklyReportPdfDocumentModel } = await load('modules/weekly-reports/pdf/document-model.js');
    const pdfModel = buildWeeklyReportPdfDocumentModel({submission,staffName:staff.name});
    async function unchanged(label) {
      const current = await rules(); assert.deepEqual(current, baseline, `all persisted recurrence columns: ${label}`);
      assert.deepEqual(await history(), historical, `immutable submission: ${label}`);
      snapshots.push({label,rules:current,history:await history()});
    }
    await unchanged('before-bootstrap');
    const childUrl = new URL(url); childUrl.searchParams.set('application_name', applicationName);
    const httpPort = await port(); const origin = `http://127.0.0.1:${httpPort}`;
    const childRoot = resolve(process.env.WRRET_BASE_SERVER ?? server);
    child = spawn(process.execPath, ['dist/index.js'], {cwd:childRoot,env:{...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(httpPort),DATABASE_URL:childUrl.href,CORS_ORIGIN:'http://127.0.0.1:5173',HEALTH_SCHEMA_VERSION:'',SERVORA_RELEASE_SHA:'dev',WEB_PUSH_ENABLED:'false',BACKUP_PROVIDER:'none',OVERDUE_SCANNER_ENABLED:'false',OVERDUE_REMINDER_ENABLED:'false',ACTION_SCOPED_GEOLOCATION_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
    for (const stream of [child.stdout,child.stderr]) stream.on('data', b => { logs += b.toString(); });
    await until(async () => { assert.equal(child.exitCode,null,logs); try {return (await fetch(`${origin}/api/health`)).ok;}catch{return false;} },'actual dist/index.js HTTP readiness');
    const cookies = new Map();
    async function login(user) {
      if(cookies.has(user.id)) return cookies.get(user.id);
      const response = await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:user.email,password})});
      assert.equal(response.status,200,await response.clone().text());
      const cookie=response.headers.get('set-cookie').split(';')[0]; cookies.set(user.id,cookie); return cookie;
    }
    async function request(user,path,body,method=body?'POST':'GET') {
      const cookie = await login(user);
      return fetch(`${origin}${path}`,{method,headers:{cookie,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    }
    try { await run({pool,users,manager,administrator,staff,secondStaff,org,old,origin,password,request,login,unchanged,baseline,pdfModel,service,actor}); }
    finally {
      await stop(child);
      assert.equal((await pool.query('SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1',[applicationName])).rows[0].n,0,'no abandoned bootstrap DB sessions');
      if(evidenceDirectory) {
        await mkdir(evidenceDirectory,{recursive:true});
        await writeFile(resolve(evidenceDirectory,'snapshots.json'), JSON.stringify({baseline,historical,pdfModel,snapshots,finalRules:await rules(),finalHistory:await history(),shutdown:{exit:child.exitCode,abandonedSessions:0}},null,2));
        await writeFile(resolve(evidenceDirectory,'bootstrap.log'),logs);
      }
    }
  } finally {
    await stop(child);
    if (evidenceDirectory) {await mkdir(evidenceDirectory,{recursive:true});await writeFile(resolve(evidenceDirectory,'startup.log'),logs);}
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  }
}
export async function verifyRetirement(f) {
  const cookie = await f.login(f.manager);
  const ruleId = f.baseline[0].row.id;
  const routes = [['GET',''],['POST','/bulk'],['PUT',`/${ruleId}/template`],['POST',`/${ruleId}/pause`],['POST',`/${ruleId}/resume`]];
  const observed=[];
  for(const [method,suffix] of routes) {
    const response=await fetch(`${f.origin}/api/job-cards/weekly-reports/recurrences${suffix}`,{method,headers:{cookie}});
    observed.push({method,suffix,status:response.status});
  }
  assert.deepEqual(observed.map(r=>r.status),[404,404,404,404,404],JSON.stringify(observed));
  await f.unchanged('authenticated-route-probes');
  // Readiness is reached only after Fastify onReady hooks, including any worker
  // start hook. Each real command below adds a bounded DB/HTTP observation.
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM weekly_reports')).rows[0].n,1);
  for(const [user,body] of [[f.staff,{periodStart:'2026-09-07'}],[f.manager,{periodStart:'2026-09-14',staffUserIds:[f.staff.id,f.secondStaff.id]}],[f.administrator,{periodStart:'2026-09-21',staffUserIds:[f.staff.id,f.secondStaff.id]}]]) {
    const bulk=!!body.staffUserIds;const path=`/api/job-cards/weekly-reports${bulk?'/bulk-request':''}`;
    const response=await f.request(user,path,{clientActionId:randomUUID(),...body});
    assert.equal(response.status,201,await response.clone().text());
    const duplicate=await f.request(user,path,{clientActionId:randomUUID(),...body});
    assert.equal(duplicate.status,bulk?201:409,await duplicate.clone().text());
    if(bulk) assert((await duplicate.json()).items.every(i=>i.outcome==='existing'));
    await f.unchanged(`${user.role}-manual-and-duplicate`);
  }
  const read=await f.request(f.manager,`/api/job-cards/${f.old.jobCardId}/weekly-report/submissions`);
  assert.equal(read.status,200); assert((await read.text()).includes(f.staff.id));
  const pdf=await f.request(f.manager,`/api/job-cards/${f.old.jobCardId}/weekly-report/submissions/1/pdf`);
  assert.equal(pdf.status,200); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
  const submission=(await f.service.listWeeklyReportSubmissions(f.actor(f.staff),f.old.jobCardId))[0];
  const { buildWeeklyReportPdfDocumentModel }=await load('modules/weekly-reports/pdf/document-model.js');
  assert.deepEqual(buildWeeklyReportPdfDocumentModel({submission,staffName:f.staff.name}),f.pdfModel);
  await f.unchanged('historical-read-and-pdf');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM weekly_reports')).rows[0].n,6,'only explicit historical and manual reports');
}
