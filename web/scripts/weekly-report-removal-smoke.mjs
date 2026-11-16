import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..',import.meta.url));
const baseline = process.argv.includes('--baseline');
const output = process.env.WEEKLY_REMOVAL_CAPTURE_DIR;
assert.ok(output,'Set WEEKLY_REMOVAL_CAPTURE_DIR to a task-owned evidence directory');
await mkdir(output,{ recursive: true });
const temporary = await mkdtemp(join(tmpdir(),'servora-weekly-removal-bundle-'));
await build({ root,configFile: false,plugins: [react()],logLevel:'error',build: {
  outDir: temporary,emptyOutDir: false,rollupOptions: { input: resolve(root,'scripts/weekly-report-removal-fixture.tsx'),
    output: { entryFileNames:'fixture.js',assetFileNames:'[name][extname]' } },
} });
const styles = (await readdir(temporary)).filter(name=>name.endsWith('.css'));
const html = `<!doctype html><html lang="tr"><head><meta name="viewport" content="width=device-width, initial-scale=1">${styles.map(name=>`<link rel="stylesheet" href="/${name}">`).join('')}</head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`;
const types = { '.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml' };
const server = createServer(async (request,response)=>{
  try {
    const path = new URL(request.url,'http://localhost').pathname;
    if (path==='/') { response.setHeader('content-type','text/html');response.end(html);return; }
    const file = resolve(temporary,'.'+path);
    if (!file.startsWith(temporary+'/')) { response.writeHead(404).end();return; }
    response.setHeader('content-type',types[extname(file)]??'application/octet-stream');response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  const cases = baseline ? [{ name:'desktop',width:1440 },{ name:'mobile',width:390 }] : [
    { name:'desktop',width:1440 },{ name:'mobile',width:390,touch:true },
    { name:'tablet',width:768 },{ name:'small-desktop',width:1024 },
    { name:'reflow-320',width:320 },{ name:'text-200',width:1440,textScale:true },
    { name:'admin-cancelled',width:390,state:'CANCELLED' },
    { name:'manager',width:390,role:'MANAGER' },{ name:'staff',width:390,role:'STAFF' },
    { name:'uncertain',width:390,scenario:'uncertain' },{ name:'pending',width:390,scenario:'pending' },
  ];
  for (const scenario of cases) {
    const { width } = scenario;
    const context = await browser.newContext({ viewport:{ width,height:width<768 ? 844 : 960 },locale:'tr-TR',timezoneId:'Europe/Istanbul',reducedMotion:'reduce',hasTouch:!!scenario.touch });
    const page = await context.newPage();
    const errors = [];page.on('pageerror',error=>errors.push(error.message));
    const query = new URLSearchParams({ role:scenario.role??'ADMIN',...(baseline?{ baseline:'' }:{}),
      ...(scenario.state?{ state:scenario.state }:{}),...(scenario.scenario?{ scenario:scenario.scenario }:{}) });
    await page.goto(`http://127.0.0.1:${server.address().port}/?${query}`);
    await page.locator('.weekly-history').waitFor();await page.evaluate(()=>document.fonts.ready);
    if (scenario.textScale) await page.addStyleTag({ content:'html { font-size: 200%; }' });
    const canRemove = !baseline && !scenario.role;
    if (canRemove) {
      const trigger = page.getByRole('button',{ name:'Raporu kaldır',exact:true });
      await trigger.focus();await page.keyboard.press('Enter');
      await page.getByLabel('Kaldırma gerekçesi').waitFor();
      await page.waitForFunction(()=>document.activeElement?.tagName==='TEXTAREA');
      await page.getByLabel('Kaldırma gerekçesi').fill('Yanlış raporlama haftası seçildi.');
      const next = page.getByRole('button',{ name:'Devam et',exact:true });
      await next.focus();await page.keyboard.press('Enter');
      await page.getByRole('dialog').waitFor();
      assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Vazgeç','Safe default focus');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Raporu kaldır ve haftayı aç','Backward focus trap');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Vazgeç','Forward focus trap');
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog').count(),0);
      assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Devam et','Confirmation returns focus');
      await page.keyboard.press('Enter');await page.getByRole('dialog').waitFor();
    } else if (!baseline) {
      assert.equal(await page.getByRole('button',{ name:'Raporu kaldır',exact:true }).count(),0,'Role visibility');
    }
    const geometry = await page.evaluate(()=>({ viewport:innerWidth,document:document.documentElement.scrollWidth,
      body:document.body.scrollWidth,unexpected:window.weeklyRemovalUnexpected,
      reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
      controls:[...document.querySelectorAll('[role="dialog"] button')].map(button=>{
        const box=button.getBoundingClientRect(),style=getComputedStyle(button);
        return { label:button.textContent,width:box.width,height:box.height,color:style.color,background:style.backgroundColor,
          outline:style.outline,animation:style.animationDuration,transition:style.transitionDuration };
      }),
    }));
    assert.ok(geometry.document<=width+1 && geometry.body<=width+1,`Horizontal overflow at ${width}: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.reducedMotion);assert.deepEqual(geometry.unexpected,[]);assert.deepEqual(errors,[]);
    for (const button of geometry.controls) assert.ok(button.width>=44 && button.height>=44,`Touch target ${JSON.stringify(button)}`);
    await page.screenshot({ path:join(output,`${scenario.name}.png`),fullPage:baseline });
    if (canRemove) {
      await page.getByRole('dialog').getByRole('button',{ name:'Raporu kaldır ve haftayı aç',exact:true }).click();
      if (scenario.scenario==='uncertain') {
        const retry = page.getByRole('button',{ name:'Özgün işlemi tekrar dene' });
        await retry.waitFor();assert.equal(await page.getByLabel('Kaldırma gerekçesi').isDisabled(),true);
        await page.screenshot({ path:join(output,'uncertain-retry.png') });
        await retry.click();
      }
      if (scenario.scenario==='pending') {
        await page.waitForFunction(()=>typeof window.releaseWeeklyRemoval==='function');
        assert.equal(await page.getByRole('dialog').getByRole('button',{ name:'Vazgeç' }).isDisabled(),true);
        await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),1);
        await page.screenshot({ path:join(output,'pending-locked.png') });
        await page.evaluate(()=>window.releaseWeeklyRemoval());
      }
      await page.getByText('Bu rapor kaldırıldı.',{ exact:true }).waitFor();
      const link = page.getByRole('link',{ name:'Aynı hafta için yeni rapor oluştur' });
      assert.equal(await link.count(),1);
      assert.ok((await link.getAttribute('href')).includes('periodStart=2026-11-02&staffUserId='));
      if (!scenario.state) assert.equal(await page.getByText('Dental ürün katalog takip görevi',{ exact:true }).count()>0,true);
      const requests = await page.evaluate(()=>window.weeklyRemovalRequests);
      assert.equal(requests.length,scenario.scenario==='uncertain'?2:1);
      if (requests.length===2) assert.deepEqual(requests[0],requests[1],'Exact uncertain retry');
      if (['desktop','mobile','admin-cancelled','reflow-320','text-200'].includes(scenario.name)) {
        await page.getByText('Bu rapor kaldırıldı.',{ exact:true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path:join(output,`${scenario.name}-removed.png`),fullPage:scenario.name==='desktop' });
      }
      assert.deepEqual(await page.evaluate(()=>window.weeklyRemovalUnexpected),[]);assert.deepEqual(errors,[]);
    }
    results.push({ ...scenario,baseline,geometry,errors,result:'PASS' });
    await context.close();
  }
  await writeFile(join(output,'checks.json'),JSON.stringify({ baseline,browser:browser.version(),results },null,2)+'\n');
  console.log(JSON.stringify({ result:'PASS',output,baseline,cases:results.length,browser:browser.version() }));
} finally { await browser.close();await new Promise(resolve=>server.close(resolve));await rm(temporary,{ recursive:true,force:true }); }
