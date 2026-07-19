# Servora-Med Kalan UI Teknik İşler Uygulama Planı

> **Kodlama ajanı için zorunlu çalışma modu:** Bu belge onaylanmış tasarım ve uygulama planıdır. Brainstorming, writing-plans veya benzeri planlama skill’lerini çağırma. Kullanıcıya soru sorma. Karar seçenekleri üretme. Adımları sırayla uygula ve her PR sonunda dur.

**Goal:** Servora-Med web uygulamasında route bazlı code-splitting uygulamak, 500 kB bundle uyarısını ölçülebilir bir bütçeyle kaldırmak, yalnız kanıtlanmış düşük riskli “Birincil kişi yap” komutuna owned Popconfirm adapter’ı eklemek ve UI uygulama planını kapatmak.

**Architecture:** Ana `/jobs` çalışma alanı eager kalacak; diğer feature ekranları `React.lazy` ile route bazlı yüklenecek. Bundle bütçesi bir Node script’i ve GitHub Actions adımıyla korunacak. Kısa ve geri alınabilir confirmation işlemi owned Ant adapter üzerinden sunulacak; domain komutu, pending state ve hata yönetimi feature katmanında kalacak.

**Tech Stack:** React 19.2.7, React Router 7.18.1, Ant Design 6.5.1, TypeScript 5.9.3, Vite 8.1.4, Vitest 4.1.10, Playwright.

## Global Constraints

* Doğrudan `main` üzerinde çalışma yapma.
* Her plan için temiz `main` üzerinden ayrı branch aç.
* Yeni npm dependency ekleme.
* Backend, API, DTO, database veya domain contract değiştirme.
* `build.chunkSizeWarningLimit` değerini yükseltme veya uyarıyı gizleme.
* `manualChunks` ekleme; route split sonrasında bütçe hâlâ geçilmiyorsa ölçümle birlikte dur.
* `JobWorkspace` eager kalacak.
* Raw `antd` importu yalnız `web/src/ui/antd` altında bulunabilir.
* Mevcut `ConfirmationAction` modalını değiştirme.
* Popconfirm yalnız “Birincil kişi yap” komutunda kullanılacak.
* Approval, revision, cancel, delete veya lifecycle komutlarını Popconfirm’a taşıma.
* Deferred işlere başlama: drag/drop, dark mode, yeni chart, Ayarlar, warehouse/accounting veya generic chart extraction.
* Kapsam dışı dosyaları formatlama veya düzenleme.
* Draft PR aç; ready, approve veya merge yapma.

##  Bloker Politikası

Yalnız şu üç durumda uygulamayı durdur:

1. Başlangıçta temiz `main` üzerinde test veya build başarısızsa.
2. Planın belirttiği dosya repo içinde yoksa.
3. Route split sonrasında `npm run bundle:check` hâlâ başarısızsa.

Durduğunda soru sorma. Şu formatta rapor ver:

```text
BLOCKED
Step:
Command:
Exit code:
Exact error:
Changed files:
Recommended next investigation:
```

---

# PLAN 1 — PR L: Route Code-Splitting ve Bundle Budget

## Goal

Ana iş ekranını eager bırakarak diğer route’ları lazy-load etmek, her JavaScript chunk’ını 500.000 byte altında tutmak ve bu sınırı CI içinde korumak.

## Allowed Files

* Create: `web/scripts/report-bundle-sizes.mjs`
* Create: `web/tests/bundle-route-splitting.test.ts`
* Modify: `web/package.json`
* Modify: `web/src/AppRouter.tsx`
* Modify: `.github/workflows/ci.yml`

Başka dosya değiştirme.

---

## Task 1: Temiz branch ve başlangıç doğrulaması

* [ ] **Step 1: Güncel main’e geç**

```bash
cd /Users/emrah/Documents/Servora-Med
git switch main
git pull --ff-only
git status --short
```

Expected:

```text
çıkış boş olmalı
```

* [ ] **Step 2: Başlangıç testlerini çalıştır**

```bash
cd /Users/emrah/Documents/Servora-Med/web
npm test -- --run
npm run build
npm run smoke:responsive
```

Expected:

```text
tüm komutlar exit code 0
```

Başlangıç komutlarından biri başarısızsa hiçbir dosyayı değiştirme ve `BLOCKED` raporu ver.

* [ ] **Step 3: Branch aç**

```bash
cd /Users/emrah/Documents/Servora-Med
git switch -c feature/route-code-splitting
```

---

## Task 2: Önce failing architecture contract yaz

* [ ] **Step 1: `web/tests/bundle-route-splitting.test.ts` dosyasını oluştur**

```ts
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appRouterSource = readFileSync(
  new URL('../src/AppRouter.tsx', import.meta.url),
  'utf8',
);

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  scripts: Record<string, string>;
};

const ciWorkflow = readFileSync(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);

const lazyModules = [
  './DeliveryCreate',
  './GeneralTaskCreate',
  './SalesMeetingCreate',
  './CustomerList',
  './CustomerDetail',
  './ContactManagement',
  './JobDetail',
  './StaffProfiles',
  './UserManagement',
  './ProductForm',
  './ProductDetail',
  './ProductList',
  './reports/StaffOperationalReport',
  './reports/ReportsDashboard',
  './reports/DeliveryReport',
  './reports/ApprovalReport',
] as const;

describe('route code-splitting contract', () => {
  it('keeps the primary jobs workspace eager', () => {
    expect(appRouterSource).toContain(
      "import { JobWorkspace } from './jobs/JobWorkspace';",
    );
  });

  it('lazy loads every non-primary route module', () => {
    for (const modulePath of lazyModules) {
      expect(appRouterSource).toContain(`import('${modulePath}')`);

      const escaped = modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(appRouterSource).not.toMatch(
        new RegExp(`from\\s+['"]${escaped}['"]`),
      );
    }
  });

  it('uses one accessible Suspense fallback around the route tree', () => {
    expect(appRouterSource).toContain(
      '<Suspense fallback={<RouteLoading />}>',
    );
    expect(appRouterSource).toContain(
      'title="Sayfa yükleniyor"',
    );
    expect(appRouterSource).toContain(
      'headingLevel={1}',
    );
  });

  it('defines and runs the bundle budget in CI', () => {
    expect(packageJson.scripts['bundle:report']).toBe(
      'node scripts/report-bundle-sizes.mjs',
    );
    expect(packageJson.scripts['bundle:check']).toBe(
      'BUNDLE_ENFORCE=1 node scripts/report-bundle-sizes.mjs',
    );
    expect(ciWorkflow).toContain('- run: npm run bundle:check');
  });
});
```

* [ ] **Step 2: Testin kırmızı olduğunu doğrula**

```bash
cd /Users/emrah/Documents/Servora-Med/web
npm test -- --run tests/bundle-route-splitting.test.ts
```

Expected:

```text
FAIL
bundle scripts bulunmuyor
lazy import sözleşmesi sağlanmıyor
Suspense fallback bulunmuyor
```

Test beklenmedik bir syntax veya dosya yolu hatasıyla düşerse yalnız test dosyasındaki yolu düzelt. Production koduna henüz dokunma.

---

## Task 3: Bundle raporlama ve CI bütçesini ekle

* [ ] **Step 1: `web/scripts/report-bundle-sizes.mjs` dosyasını oluştur**

```js
import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const assetsDirectory = new URL('../dist/assets/', import.meta.url);
const rawLimitBytes = 500_000;
const enforce = process.env.BUNDLE_ENFORCE === '1';

let entries;
try {
  entries = await readdir(assetsDirectory, { withFileTypes: true });
} catch (error) {
  console.error(
    'dist/assets bulunamadı. Önce `npm run build` çalıştırın.',
    error,
  );
  process.exit(1);
}

const javascriptFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => entry.name)
  .sort();

const rows = [];

for (const filename of javascriptFiles) {
  const content = await readFile(new URL(filename, assetsDirectory));
  rows.push({
    file: filename,
    rawBytes: content.byteLength,
    rawKiB: Number((content.byteLength / 1024).toFixed(2)),
    gzipKiB: Number((gzipSync(content).byteLength / 1024).toFixed(2)),
  });
}

rows.sort((left, right) => right.rawBytes - left.rawBytes);

console.log('JavaScript bundle sizes');
console.table(
  rows.map(({ file, rawKiB, gzipKiB }) => ({
    file,
    rawKiB,
    gzipKiB,
  })),
);

const oversized = rows.filter((row) => row.rawBytes > rawLimitBytes);

if (!enforce) {
  if (oversized.length > 0) {
    console.log(
      `Measurement only: ${oversized.length} JavaScript chunk 500.000 byte sınırını geçiyor.`,
    );
  }
  process.exit(0);
}

const failures = [];

if (rows.length < 2) {
  failures.push(
    `Route split kanıtlanmadı: yalnız ${rows.length} JavaScript chunk üretildi.`,
  );
}

for (const row of oversized) {
  failures.push(
    `${row.file}: ${row.rawBytes} byte; izin verilen en yüksek değer ${rawLimitBytes} byte.`,
  );
}

if (failures.length > 0) {
  console.error('Bundle budget failure:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Bundle budget OK: ${rows.length} JavaScript chunk, her biri en fazla ${rawLimitBytes} byte.`,
);
```

* [ ] **Step 2: `web/package.json` scripts alanına iki script ekle**

Mevcut `smoke:responsive` satırından sonra virgül kullanarak şunları ekle:

```json
"bundle:report": "node scripts/report-bundle-sizes.mjs",
"bundle:check": "BUNDLE_ENFORCE=1 node scripts/report-bundle-sizes.mjs"
```

Scripts bölümü şu yapıda olmalı:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "preview": "vite preview",
  "test": "vitest",
  "smoke:responsive": "node scripts/responsive-smoke.mjs",
  "bundle:report": "node scripts/report-bundle-sizes.mjs",
  "bundle:check": "BUNDLE_ENFORCE=1 node scripts/report-bundle-sizes.mjs"
}
```

* [ ] **Step 3: GitHub Actions web job’una budget kontrolü ekle**

`.github/workflows/ci.yml` içinde web job’unda build’den hemen sonra ekle:

```yaml
      - run: npm run build
      - run: npm run bundle:check
      - run: npm test -- --run
```

`npm run build` veya test adımlarını silme.

* [ ] **Step 4: Mevcut bundle’ı ölç**

```bash
cd /Users/emrah/Documents/Servora-Med/web
npm run build
npm run bundle:report
```

Expected:

```text
rapor üretilmeli
komut ölçüm modunda exit code 0 dönmeli
mevcut büyük chunk görünür kalmalı
```

* [ ] **Step 5: Contract testini tekrar çalıştır**

```bash
npm test -- --run tests/bundle-route-splitting.test.ts
```

Expected:

```text
route lazy-loading testleri hâlâ FAIL
bundle script ve CI testleri PASS
```

* [ ] **Step 6: İlk commit**

```bash
cd /Users/emrah/Documents/Servora-Med
git add \
  web/scripts/report-bundle-sizes.mjs \
  web/tests/bundle-route-splitting.test.ts \
  web/package.json \
  .github/workflows/ci.yml
git commit -m "test(web): add bundle budget and route split contract"
```

---

## Task 4: Non-primary route’ları lazy-load et

* [ ] **Step 1: `AppRouter.tsx` statik importlarını kaldır**

`web/src/AppRouter.tsx` dosyasının başındaki feature screen importlarını kaldır.

Şunlar statik kalmalı:

```ts
import { lazy, Suspense } from 'react';
import {
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom';

import { JobWorkspace } from './jobs/JobWorkspace';
import { paths } from './paths';
import type { CurrentUser } from './services/api';
import { LoadingSkeleton } from './ui/antd';
```

* [ ] **Step 2: Importların altına lazy component tanımlarını ekle**

```ts
const DeliveryCreateView = lazy(() =>
  import('./DeliveryCreate').then((module) => ({
    default: module.DeliveryCreateView,
  })),
);

const GeneralTaskCreateScreen = lazy(() =>
  import('./GeneralTaskCreate').then((module) => ({
    default: module.GeneralTaskCreateScreen,
  })),
);

const SalesMeetingCreateScreen = lazy(() =>
  import('./SalesMeetingCreate').then((module) => ({
    default: module.SalesMeetingCreateScreen,
  })),
);

const CustomerListScreen = lazy(() =>
  import('./CustomerList').then((module) => ({
    default: module.CustomerListScreen,
  })),
);

const CustomerCreateScreen = lazy(() =>
  import('./CustomerList').then((module) => ({
    default: module.CustomerCreateScreen,
  })),
);

const CustomerDetailScreen = lazy(() =>
  import('./CustomerDetail').then((module) => ({
    default: module.CustomerDetailScreen,
  })),
);

const ContactDetailScreen = lazy(() =>
  import('./ContactManagement').then((module) => ({
    default: module.ContactDetailScreen,
  })),
);

const JobDetailScreen = lazy(() =>
  import('./JobDetail').then((module) => ({
    default: module.JobDetailScreen,
  })),
);

const StaffProfilesScreen = lazy(() =>
  import('./StaffProfiles').then((module) => ({
    default: module.StaffProfilesScreen,
  })),
);

const UserListScreen = lazy(() =>
  import('./UserManagement').then((module) => ({
    default: module.UserListScreen,
  })),
);

const UserCreateScreen = lazy(() =>
  import('./UserManagement').then((module) => ({
    default: module.UserCreateScreen,
  })),
);

const UserDetailScreen = lazy(() =>
  import('./UserManagement').then((module) => ({
    default: module.UserDetailScreen,
  })),
);

const ProductCreateScreen = lazy(() =>
  import('./ProductForm').then((module) => ({
    default: module.ProductCreateScreen,
  })),
);

const ProductDetailScreen = lazy(() =>
  import('./ProductDetail').then((module) => ({
    default: module.ProductDetailScreen,
  })),
);

const ProductListScreen = lazy(() =>
  import('./ProductList').then((module) => ({
    default: module.ProductListScreen,
  })),
);

const StaffOperationalReportScreen = lazy(() =>
  import('./reports/StaffOperationalReport').then((module) => ({
    default: module.StaffOperationalReportScreen,
  })),
);

const ReportsDashboard = lazy(() =>
  import('./reports/ReportsDashboard').then((module) => ({
    default: module.ReportsDashboard,
  })),
);

const DeliveryReport = lazy(() =>
  import('./reports/DeliveryReport').then((module) => ({
    default: module.DeliveryReport,
  })),
);

const ApprovalReport = lazy(() =>
  import('./reports/ApprovalReport').then((module) => ({
    default: module.ApprovalReport,
  })),
);
```

* [ ] **Step 3: Accessible route fallback ekle**

Lazy tanımlarından sonra ekle:

```tsx
function RouteLoading() {
  return (
    <main className="workspace" data-route-loading="true">
      <LoadingSkeleton
        title="Sayfa yükleniyor"
        headingLevel={1}
        rows={4}
      />
    </main>
  );
}
```

Yeni CSS ekleme.

* [ ] **Step 4: Route ağacını Suspense ile sar**

`AppRouter` dönüşünü şu yapıya çevir:

```tsx
export function AppRouter({
  user,
  notice,
  onClearNotice,
  onDeliveryCreated,
}: AppRouterProps) {
  const navigate = useNavigate();

  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        {/* Mevcut Route satırlarının tamamı burada aynı sırada kalacak. */}
      </Routes>
    </Suspense>
  );
}
```

Route path’lerini, role kontrollerini, navigate callback’lerini veya component prop’larını değiştirme.

* [ ] **Step 5: Architecture contract testini çalıştır**

```bash
cd /Users/emrah/Documents/Servora-Med/web
npm test -- --run tests/bundle-route-splitting.test.ts
```

Expected:

```text
PASS
```

* [ ] **Step 6: Router kaynaklı mevcut test kırılmalarını düzelt**

Önce tam suite’i çalıştır:

```bash
npm test -- --run
```

Lazy import tamamlanmadan assertion yapan testler varsa yalnız ilgili render helper’ını şu pattern ile değiştir:

```ts
await act(async () => {
  root.render(
    // mevcut JSX değişmeden kalacak
  );
  await vi.dynamicImportSettled();
});
```

Bu nedenle `vi` importu eksikse mevcut Vitest importuna `vi` ekle.

Şunları yapma:

* timeout artırma,

* `setTimeout` ekleme,

* test silme,

* assertion gevşetme,

* component’ı tekrar eager import etme.

* [ ] **Step 7: Bundle budget doğrulaması**

```bash
npm run build
npm run bundle:check
npm run smoke:responsive
```

Expected:

```text
en az 2 JavaScript chunk
her JavaScript chunk en fazla 500.000 byte
bundle:check exit code 0
Vite 500 kB chunk uyarısı görünmemeli
```

`bundle:check` başarısızsa:

* `chunkSizeWarningLimit` değiştirme.

* `manualChunks` ekleme.

* Yeni dependency ekleme.

* Mevcut ölçüm tablosunu kopyala.

* `BLOCKED` raporu ver ve dur.

* [ ] **Step 8: Full verification**

```bash
npm test -- --run
npm run build
npm run bundle:check
npm run smoke:responsive
npm audit --omit=dev
```

Ardından:

```bash
cd /Users/emrah/Documents/Servora-Med/server
npm run build
npm test -- --run
npm audit --omit=dev
```

Expected:

```text
tüm komutlar exit code 0
```

* [ ] **Step 9: İkinci commit**

```bash
cd /Users/emrah/Documents/Servora-Med
git add web/src/AppRouter.tsx web/tests
git commit -m "perf(web): lazy load non-primary routes"
```

* [ ] **Step 10: Branch’i push et**

```bash
git push -u origin feature/route-code-splitting
```

* [ ] **Step 11: Draft PR aç**

```bash
gh pr create \
  --draft \
  --base main \
  --head feature/route-code-splitting \
  --title "perf(web): split non-primary routes and enforce bundle budget" \
  --body "$(cat <<'EOF'
## Summary

- keep the primary Jobs workspace eager
- lazy-load create, detail, CRM, product, user, staff, and report routes
- reuse the owned LoadingSkeleton as the accessible route fallback
- add a dependency-free bundle size report
- enforce a 500,000-byte raw JavaScript chunk budget in CI

## Scope boundaries

- no backend, API, DTO, domain, or database changes
- no route path or authorization behavior changes
- no dependency changes
- no manualChunks configuration
- no chunk warning suppression
- no production CSS changes

## Verification

- cd web && npm test -- --run
- cd web && npm run build
- cd web && npm run bundle:check
- cd web && npm run smoke:responsive
- cd web && npm audit --omit=dev
- cd server && npm run build
- cd server && npm test -- --run
- cd server && npm audit --omit=dev
EOF
)"
```

PR açıldıktan sonra dur. Ready veya merge yapma.
