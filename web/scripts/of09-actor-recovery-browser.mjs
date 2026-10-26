import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from 'playwright/test';
import { createServer, preview } from 'vite';
import { withRetirementFixture } from '../../server/scripts/acceptance/weekly-report-retirement.mjs';

const evidence = resolve(process.env.OF09_EVIDENCE_DIRECTORY ?? '/private/tmp/of09-browser');
await mkdir(evidence, { recursive: true });
const prefix = 'servora:r4b:staff-offboarding-attempt:v1';
const results = [];
const engines = process.env.OF09_BROWSER === 'chrome' ? ['chrome'] : ['chromium'];
const modes = process.env.OF09_MODE ? [process.env.OF09_MODE] : ['vite', 'dist'];
const widths = process.env.OF09_WIDTH ? [Number(process.env.OF09_WIDTH)] : [1440, 390];
const motions = process.env.OF09_MOTION ? [process.env.OF09_MOTION] : ['no-preference', 'reduce'];
const faults = process.env.OF09_FAULT ? [process.env.OF09_FAULT] : ['before-dispatch', 'after-commit', 'late-after-commit'];

// One API/schema per profile preserves the real login rate limit unchanged.
for (const engine of engines) for (const mode of modes) for (const width of widths)
  for (const motion of motions) for (const fault of faults) {
    const id = `${mode}-${engine}-${width}-${motion}-${fault}`;
    await withRetirementFixture(async (f) => {
      const hash = (await f.pool.query('SELECT password_hash FROM users WHERE id=$1', [f.administrator.id])).rows[0].password_hash;
      async function user(org, role, name) {
        const row = (await f.pool.query(`INSERT INTO users(organization_id,name,email,password_hash,role,is_active,must_change_password)
          VALUES($1,$2,$3,$4,$5,true,false) RETURNING id,name,email,role`, [org, name, `${randomUUID()}@of09.local`, hash, role])).rows[0];
        if (role === 'STAFF') await f.pool.query('INSERT INTO staff_profiles(organization_id,user_id,title) VALUES($1,$2,$3)', [org,row.id,'Saha temsilcisi']);
        return row;
      }
      const adminB = await user(f.org, 'ADMIN', 'OF09 Admin B');
      const otherOrg = (await f.pool.query("INSERT INTO organizations(name,timezone) VALUES('OF09 ikinci firma','Europe/Istanbul') RETURNING id")).rows[0].id;
      const adminC = await user(otherOrg, 'ADMIN', 'OF09 Admin C');
      const targetC = await user(otherOrg, 'STAFF', 'OF09 diğer firma personeli');
      const scopedKey = (actor, org = f.org) => `${prefix}:${encodeURIComponent(org)}:${encodeURIComponent(actor.id)}`;
      const browser = await chromium.launch({ ...(engine === 'chrome' ? {channel:'chrome',headless:false} : {headless:true}) });
      try {
        const config = {root:resolve('web'),[mode === 'vite' ? 'server' : 'preview']:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.origin,changeOrigin:true}}}};
        const frontend = mode === 'vite' ? await createServer(config) : await preview(config);
        if (mode === 'vite') await frontend.listen();
        const origin = frontend.resolvedUrls.local[0].replace(/\/$/, '');
        try {
          const target = await user(f.org, 'STAFF', `OF09 Klinik ${id}`);
          const context = await browser.newContext({baseURL:origin,viewport:{width,height:900},hasTouch:width===390,isMobile:width===390,reducedMotion:motion});
          const page = await context.newPage();
          const errors = []; page.on('pageerror',e=>errors.push(e.message));
          page.on('dialog', dialog => dialog.accept());
          const activate = async locator => width === 390 ? locator.tap() : locator.click();
          const go = async path => { await page.goto(`${origin}${path}`); };
          async function login(actor, path = `/users/${target.id}`) {
            await go(path);
            await expect(page.locator('#email')).toBeVisible();
            if (process.env.VITE_SERVORA_BUILD_SHA) assert.equal(await page.locator('.build-identity').first().getAttribute('data-build-sha'),process.env.VITE_SERVORA_BUILD_SHA);
            await page.locator('#email').fill(actor.email); await page.locator('#password').fill(f.password);
            await activate(page.getByRole('button',{name:'Giriş yap',exact:true}));
            await expect(page.locator('#email')).toHaveCount(0);
            const me = await context.request.get(`${origin}/api/auth/me`);
            assert.equal((await me.json()).user.id, actor.id);
            await go(path);
          }
          async function logout() {
            assert.equal((await context.request.post(`${origin}/api/auth/logout`)).status(),204);
          }
          async function snapshot() {
            const actions = (await f.pool.query('SELECT user_id,organization_id,client_action_id,status,request_hash,response_body FROM processed_actions WHERE operation_key=$1 ORDER BY user_id',[`USER_OFFBOARDING:${target.id}`])).rows;
            const audit = (await f.pool.query("SELECT actor_user_id,organization_id,event_type,subject_id FROM audit_events WHERE subject_id=$1 AND event_type='USER_OFFBOARDED'",[target.id])).rows;
            const active = (await f.pool.query('SELECT is_active,version FROM users WHERE id=$1',[target.id])).rows[0];
            return {actions,audit,user:active};
          }
          try {
            await login(f.administrator);
            await activate(page.getByRole('button',{name:'Personeli devre dışı bırak',exact:true}));
            await page.locator('[name="reasonCode"]').selectOption('ACCESS_ENDED');
            await activate(page.getByRole('button',{name:'Kararları onayla',exact:true}));
            let intercepted = 0; const bodies = [];
            let releaseLateResponse; let observeCommit;
            const lateResponse = new Promise(r=>{releaseLateResponse=r;});
            const committed = new Promise(r=>{observeCommit=r;});
            const endpoint = `**/api/users/${target.id}/offboarding/execute`;
            await page.route(endpoint, async route => {
              intercepted++; bodies.push(route.request().postDataJSON());
              if (fault !== 'before-dispatch' && intercepted === 1) {
                const real = await route.fetch(); assert.equal(real.status(),200);
                observeCommit();
                if (fault === 'late-after-commit') await lateResponse;
              }
              try { await route.abort('failed'); } catch (error) { if (fault !== 'late-after-commit') throw error; }
            });
            await activate(page.getByRole('button',{name:'Erişimi sonlandır',exact:true}));
            if (fault === 'late-after-commit') await committed;
            else await expect(page.getByRole('button',{name:'Aynı işlemi yeniden doğrula',exact:true})).toBeVisible();
            assert.equal(intercepted,fault === 'late-after-commit' ? 1 : 2);
            if (intercepted === 2) assert.deepEqual(bodies[0],bodies[1]);
            const keyA = scopedKey(f.administrator);
            const stored = await page.evaluate(key=>sessionStorage.getItem(key),keyA);
            const parsed = JSON.parse(stored); assert.equal(parsed.schemaVersion,3); assert.equal(parsed.actorId,f.administrator.id);
            assert.equal(parsed.organizationId,f.org); assert.equal(parsed.targetUserId,target.id);
            assert.deepEqual(parsed.request,bodies[0]);
            const uncertain = await snapshot();
            assert.equal(uncertain.actions.length, fault !== 'before-dispatch' ? 1 : 0);
            assert.equal(uncertain.audit.length, fault !== 'before-dispatch' ? 1 : 0);
            if (fault !== 'late-after-commit') await page.unroute(endpoint);
            await logout(); await login(adminB);
            releaseLateResponse();
            if (fault === 'late-after-commit') await page.unroute(endpoint);
            assert.equal(await page.getByRole('button',{name:'Aynı işlemi yeniden doğrula',exact:true}).count(),0);
            assert.equal(await page.getByRole('button',{name:'Erişimi sonlandır',exact:true}).count(),0);
            assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),keyA),stored);
            assert.deepEqual(await snapshot(),uncertain);
            let otherActorStatus = null;
            if (fault !== 'before-dispatch') {
              const otherActor = await context.request.post(`${origin}/api/users/${target.id}/offboarding/execute`,{data:bodies[0]});
              otherActorStatus = otherActor.status(); assert.equal(otherActorStatus,409);
              assert.equal((await otherActor.json()).code,'USER_ALREADY_INACTIVE');
              assert.deepEqual(await snapshot(),uncertain);
            }
            await page.screenshot({path:resolve(evidence,`${id}-B.png`),fullPage:true});
            await logout(); await login(adminC,`/users/${targetC.id}`);
            assert.equal(await page.getByRole('button',{name:'Aynı işlemi yeniden doğrula',exact:true}).count(),0);
            assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),keyA),stored);
            // Actual backend refuses another organization's target and non-Admin execution.
            const crossOrg = await context.request.post(`${origin}/api/users/${target.id}/offboarding/execute`,{data:bodies[0]});
            assert.equal(crossOrg.status(),404);
            const manager = await f.request(f.manager,`/api/users/${target.id}/offboarding/execute`,bodies[0]);
            assert.equal(manager.status,403);
            await logout(); await login(f.administrator);
            await expect(page.getByRole('button',{name:'Aynı işlemi yeniden doğrula',exact:true})).toBeVisible();
            // Keyboard focus and the native confirmation work after session recovery.
            const retry = page.getByRole('button',{name:'Aynı işlemi yeniden doğrula',exact:true});
            await retry.focus(); await expect(retry).toBeFocused();
            await page.keyboard.press('Enter');
            const confirm = page.getByRole('button',{name:'Erişimi sonlandır',exact:true});
            const rect = await confirm.boundingBox(); assert(rect.height>=44);
            let recoveredBody;
            page.on('request',request=>{ if(request.url().endsWith(`/api/users/${target.id}/offboarding/execute`)) recoveredBody=request.postDataJSON(); });
            await activate(confirm);
            await expect(page.getByText('Personel devre dışı bırakıldı',{exact:true})).toBeVisible();
            assert.deepEqual(recoveredBody,bodies[0]);
            assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),keyA),null);
            const final = await snapshot();
            assert.equal(final.actions.length,1); assert.equal(final.actions[0].user_id,f.administrator.id);
            assert.equal(final.actions[0].organization_id,f.org); assert.equal(final.actions[0].status,'completed');
            assert.equal(final.audit.length,1); assert.equal(final.audit[0].actor_user_id,f.administrator.id);
            assert.equal(final.user.is_active,false);
            const geometry = await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,motion:matchMedia('(prefers-reduced-motion: reduce)').matches}));
            assert(geometry.scroll<=geometry.width+1); assert.equal(geometry.motion,motion==='reduce');
            await page.screenshot({path:resolve(evidence,`${id}-A-success.png`),fullPage:true});
            const legacy = {schemaVersion:2,status:'ACTIVE',targetUserId:target.id,request:parsed.request,createdAt:parsed.createdAt};
            const legacyBytes = JSON.stringify(legacy);
            await page.evaluate(({key,value})=>sessionStorage.setItem(key,value),{key:prefix,value:legacyBytes});
            await go(`/users/${target.id}?offboarding=refresh`);
            await expect(page.getByText('Önceki işlem güvenle geri yüklenemedi',{exact:true})).toBeVisible();
            assert.equal(await page.getByRole('button',{name:'Aynı işlemi yeniden doğrula',exact:true}).count(),0);
            assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),prefix),legacyBytes);
            const close = page.getByRole('button',{name:'Kapat',exact:true}).last();
            await close.focus(); await expect(close).toBeFocused();
            const closeRect = await close.boundingBox(); assert(closeRect.height>=44);
            await page.screenshot({path:resolve(evidence,`${id}-legacy.png`),fullPage:true});
            await page.addStyleTag({content:'html { font-size: 200% !important; }'});
            const textZoom = await page.locator('.form-drawer').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));
            assert(textZoom.scroll<=textZoom.width+1);
            await page.screenshot({path:resolve(evidence,`${id}-text200.png`),fullPage:true});
            await page.setViewportSize({width:320,height:900});
            const reflow = await page.locator('.form-drawer').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));
            assert(reflow.scroll<=reflow.width+1);
            await page.screenshot({path:resolve(evidence,`${id}-reflow320.png`),fullPage:true});
            assert.deepEqual(await snapshot(),final);
            assert.deepEqual(errors,[]);
            results.push({id,status:'PASS',realLogin:['A','B','C','A'],fault,intercepted,exactRequest:true,syntheticTouch:width===390,
              backend:{crossOrg:crossOrg.status(),manager:manager.status,otherActor:otherActorStatus,uncertain,final},geometry,legacyPreserved:true,textZoom,reflow});
          } catch (error) {
            await page.screenshot({path:resolve(evidence,`${id}-failure.png`),fullPage:true}).catch(()=>{});
            results.push({id,status:'FAIL',error:String(error)}); throw error;
          } finally { await context.close(); await writeFile(resolve(evidence,'results.json'),JSON.stringify(results,null,2)); }
        } finally { if (mode === 'vite') await frontend.close(); else await new Promise(r=>frontend.httpServer.close(r)); }
      } finally { await browser.close(); }
    },resolve(evidence,id,'fixture'));
  }
console.log(JSON.stringify({passed:results.filter(r=>r.status==='PASS').length,total:results.length,evidence}));
