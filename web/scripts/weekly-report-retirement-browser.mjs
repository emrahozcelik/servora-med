import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from 'playwright/test';
import { createServer } from 'vite';
import { withRetirementFixture, port } from '../../server/scripts/acceptance/weekly-report-retirement.mjs';

const evidence = resolve(process.env.WRRET_EVIDENCE_DIRECTORY);
await mkdir(evidence,{recursive:true});
const results=[];
await withRetirementFixture(async f => {
  const vite=await createServer({server:{host:'127.0.0.1',port:await port(),strictPort:true,proxy:{'/api':{target:f.origin,changeOrigin:true}}}});
  let browser;
  try {
    await vite.listen(); const origin=vite.resolvedUrls.local[0]; browser=await chromium.launch();
    for(const width of [1440,390]) {
      for(const user of [f.staff,f.manager,f.administrator]) {
        const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
        const cookie=await f.login(user); const split=cookie.indexOf('=');
        await context.addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),url:origin,httpOnly:true,sameSite:'Lax'}]);
        const page=await context.newPage(); const requests=[]; const errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('request',request=> {if(request.url().includes('/api/')) requests.push({method:request.method(),path:new URL(request.url()).pathname,body:request.postDataJSON()});});
        const week=width===1440?(user.role==='STAFF'?'2026-11-02':user.role==='MANAGER'?'2026-11-09':'2026-11-16'):(user.role==='STAFF'?'2026-11-23':user.role==='MANAGER'?'2026-11-30':'2026-12-07');
        async function open() {
          await page.goto(`${origin}jobs/new-weekly-report`); await page.locator('#weekly-period').waitFor();
          await expect(page.locator('#weekly-period')).not.toHaveValue('');
          await expect(page.locator('#weekly-mode, .recurrence-manager')).toHaveCount(0);
          assert.equal(await page.getByText('Her hafta otomatik',{exact:true}).count(),0);
        }
        async function usable(label) {
          const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,focused:document.activeElement?.tagName}));
          assert(geometry.scroll<=geometry.width+1,JSON.stringify(geometry));
          const submit=page.locator('button[type="submit"]');
          if(await submit.count()){await submit.scrollIntoViewIfNeeded(); const box=await submit.boundingBox(); assert(box.height>=44);}
          await page.screenshot({path:resolve(evidence,`${width}-${user.role}-${label}.png`),fullPage:true});
        }
        await open();
        await page.locator('#weekly-period').fill(''); await page.locator('button[type="submit"]').click();
        await expect(page.getByRole('alert')).toBeFocused(); await usable('validation');
        await page.locator('#weekly-period').fill(week); await page.locator('#weekly-period').focus();await page.keyboard.press('Tab');
        assert.notEqual(await page.evaluate(()=>document.activeElement.tagName),'BODY');
        if(user.role!=='STAFF') {
          await page.locator('#weekly-select-all-staff').click();
          await expect(page.locator('#weekly-assignee-count')).toHaveText('2 personel seçildi');
          await page.locator('#weekly-clear-staff-selection').click();
          const combo=page.locator('#weekly-assignees');await combo.focus();await combo.press('ArrowDown');await combo.press('Enter');
          await page.locator('#weekly-select-all-staff').click();
          await expect(page.locator('#weekly-assignee-count')).toHaveText('2 personel seçildi');
        }
        await usable('form');
        const path=user.role==='STAFF'?'/api/job-cards/weekly-reports':'/api/job-cards/weekly-reports/bulk-request';
        await page.locator('#weekly-period').fill('2026-10-06');
        const rejected=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST');
        await page.locator('button[type="submit"]').click(); assert.equal((await rejected).status(),400);
        await expect(page.getByRole('alert')).toBeFocused();
        await page.locator('#weekly-period').fill(week);
        // A real server commit whose response is lost, not a fake API success.
        let lost=false;
        await page.route(url=>url.pathname===path,async route=>{
          if(route.request().method()==='POST'&&!lost){lost=true;const response=await route.fetch();assert.equal(response.status(),201);await route.abort('connectionfailed');}
          else await route.continue();
        });
        await page.locator('button[type="submit"]').click();
        try { await expect(page.getByRole('button',{name:'Özgün isteği tekrar dene'})).toBeVisible(); } catch(error) {await page.screenshot({path:resolve(evidence,`${width}-${user.role}-failure.png`),fullPage:true});await writeFile(resolve(evidence,'failure.json'),JSON.stringify({requests,errors,lost,url:page.url(),text:await page.locator('body').innerText()},null,2));throw error;}
        await expect(page.getByRole('alert')).toBeFocused();await usable('ambiguous');
        await page.getByRole('button',{name:'Özgün isteği tekrar dene'}).click();
        if(user.role==='STAFF') await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);
        else {await expect(page.locator('#weekly-bulk-result-title')).toHaveText('2 haftalık rapor isteği işlendi');await expect(page.locator('#weekly-bulk-created')).toHaveText('2 oluşturuldu');}
        const posts=requests.filter(r=>r.method==='POST'&&r.path===path&&r.body.periodStart===week);
        assert.equal(posts.length,2);assert.deepEqual(posts[0].body,posts[1].body);
        assert.equal(posts[0].body.periodStart,week);assert(!('startPeriodStart'in posts[0].body));
        if(user.role!=='STAFF')assert.deepEqual([...posts[0].body.staffUserIds].sort(),[f.staff.id,f.secondStaff.id].sort());
        await page.screenshot({path:resolve(evidence,`${width}-${user.role}-success.png`),fullPage:true});
        await open(); await page.locator('#weekly-period').fill(week);
        if(user.role!=='STAFF')await page.locator('#weekly-select-all-staff').click();
        await page.locator('button[type="submit"]').click();
        if(user.role==='STAFF'){await expect(page.getByRole('link',{name:'Mevcut rapora git'})).toBeVisible();await expect(page.getByRole('alert')).toBeFocused();}
        else await expect(page.locator('#weekly-bulk-existing')).toHaveText('2 zaten mevcuttu');
        await page.screenshot({path:resolve(evidence,`${width}-${user.role}-existing.png`),fullPage:true});
        await open(); await page.setViewportSize({width:320,height:900});
        await page.addStyleTag({content:'html { font-size: 200% !important; }'}); await usable('reflow-200pct-320px');
        assert.equal(requests.filter(r=>r.path.includes('/recurrences')).length,0);assert.deepEqual(errors,[]);
        await f.unchanged(`${width}-${user.role}-browser`);
        results.push({width,role:user.role,status:'PASS',requests,assertions:['real-login','date-selection','staff-selection','validation-focus','keyboard','lost-real-commit-verbatim-retry','success','existing','no-recurrence','320px-reflow-200pct','legacy-row-equality']});
        await context.close();
      }
    }
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM weekly_reports')).rows[0].n,11,'only the historical and ten explicit browser-created reports');
  } finally {await browser?.close();await vite.close();await writeFile(resolve(evidence,'browser-results.json'),JSON.stringify(results,null,2));}
},resolve(evidence,'database'));
console.log('WRRET_BROWSER_PASS',results.length);
