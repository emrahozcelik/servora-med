/**
 * /messages geometry and content smoke (UI audit F-07 / F-08 / F-11).
 *
 * Renders the real MessagingPage with the real CSS, a synthetic API and the
 * production Ant provider. Verifies the shared workspace gutter, the single
 * empty state, 44px view targets, the 12px text floor and empty-state contrast.
 *
 * Usage: node scripts/messaging-geometry.mjs
 * Captures (when MESSAGING_CAPTURE_DIR is set) are review artifacts only.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

import { assertNoSubMinimumText, collectSubMinimumText, MIN_READABLE_TEXT_PX } from './min-text-size.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const captureDir = process.env.MESSAGING_CAPTURE_DIR;
if (captureDir) mkdirSync(captureDir, { recursive: true });

const fixtureHtml = `<!doctype html><html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  /* Fixture-only shell frame: the desktop sidebar footprint (17rem) and the
     desktop top bar height, so the page column matches the production shell.
     No shell control is reproduced here. */
  .shell-content-frame { min-width: 0; }
  @media (min-width: 64rem) {
    [data-fixture-desktop="true"] {
      width: calc(100vw - 17rem);
      margin-inline-start: 17rem;
      margin-top: 4.75rem;
    }
  }
</style>
</head><body><div id="root"></div>
<script type="module" src="/scripts/messaging-geometry-fixture.tsx"></script></body></html>`;

const fixedTime = '2026-11-18T09:15:00.000Z';
const now = Date.parse(fixedTime);
const minutesAgo = (minutes) => new Date(now - minutes * 60_000).toISOString();

const staff = { userId: 'staff-ayse', name: 'Ayşe Yılmaz', isActive: true };
const manager = { userId: 'fixture-manager', name: 'Deniz Yönetici', isActive: true };

const conversations = [
  {
    id: 'conv-long',
    directKey: 'conv-long',
    contextType: 'GENERAL',
    jobId: null,
    jobTitle: null,
    customerId: null,
    customerName: null,
    title: 'Bostancı bölgesi çok uzun başlıklı konuşma başlığı örneği',
    participantName: 'Ayşe Yılmaz',
    participantId: 'staff-ayse',
    participantIsActive: true,
    participants: [
      manager,
      staff,
      { userId: 'staff-mehmet', name: 'Mehmet Kaya', isActive: true },
      { userId: 'staff-zeynep', name: 'Zeynep Şahin', isActive: true },
      { userId: 'staff-ali', name: 'Ali Demir', isActive: true },
      { userId: 'staff-fatma', name: 'Fatma Çelik', isActive: true },
    ],
    unreadCount: 0,
    lastActivityAt: minutesAgo(240),
    updatedAt: minutesAgo(240),
  },
  {
    id: 'conv-job',
    directKey: 'conv-job',
    contextType: 'JOB',
    jobId: 'job-1',
    jobTitle: 'Ataşehir Klinik — dijital röntgen kurulumu',
    customerId: 'cust-1',
    customerName: 'Bostancı Ağız ve Diş Sağlığı Polikliniği',
    title: null,
    participantName: 'Ayşe Yılmaz',
    participantId: 'staff-ayse',
    participantIsActive: true,
    participants: [manager, staff],
    unreadCount: 2,
    lastActivityAt: minutesAgo(12),
    updatedAt: minutesAgo(12),
  },
  {
    id: 'conv-customer',
    directKey: 'conv-customer',
    contextType: 'CUSTOMER',
    jobId: null,
    jobTitle: null,
    customerId: 'cust-1',
    customerName: 'Bostancı Ağız ve Diş Sağlığı Polikliniği',
    title: 'Yeni ünit teslimi planı',
    participantName: 'Mehmet Kaya',
    participantId: 'staff-mehmet',
    participantIsActive: true,
    participants: [manager, { userId: 'staff-mehmet', name: 'Mehmet Kaya', isActive: true }],
    unreadCount: 0,
    lastActivityAt: minutesAgo(95),
    updatedAt: minutesAgo(95),
  },
  {
    id: 'conv-general',
    directKey: 'conv-general',
    contextType: 'GENERAL',
    jobId: null,
    jobTitle: null,
    customerId: null,
    customerName: null,
    title: 'Bölge ziyaret programı',
    participantName: 'Zeynep Şahin',
    participantId: 'staff-zeynep',
    participantIsActive: false,
    participants: [
      manager,
      staff,
      { userId: 'staff-mehmet', name: 'Mehmet Kaya', isActive: true },
      { userId: 'staff-zeynep', name: 'Zeynep Şahin', isActive: false },
    ],
    unreadCount: 0,
    lastActivityAt: minutesAgo(60 * 26),
    updatedAt: minutesAgo(60 * 26),
  },
];

const messages = [
  {
    id: 'msg-1',
    conversationId: 'conv-job',
    organizationId: 'fixture-org',
    senderUserId: 'staff-ayse',
    senderName: 'Ayşe Yılmaz',
    clientActionId: 'fixture-action-1',
    body: 'Kurulum için kliniğe 10:30’da varacağım, resepsiyondan haber verdim.',
    createdAt: minutesAgo(40),
  },
  {
    id: 'msg-2',
    conversationId: 'conv-job',
    organizationId: 'fixture-org',
    senderUserId: 'fixture-manager',
    senderName: 'Deniz Yönetici',
    clientActionId: 'fixture-action-2',
    body: 'Teşekkürler. Sensör kalibrasyon tutanağını da iletebilir misin?',
    createdAt: minutesAgo(12),
  },
];

function json(response, body) {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

// The fixture owns its dev WebSocket on the same HTTP server, so a parallel
// worktree run cannot hold the shared HMR port.
let vite;
const server = createServer((request, response) => {
  const requestUrl = request.url ?? '/';
  if (requestUrl.split('?')[0] === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fixtureHtml);
    return;
  }
  vite.middlewares(request, response, () => {
    response.writeHead(404);
    response.end();
  });
});
vite = await createViteServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    middlewareMode: true,
    hmr: false,
    ws: { server, host: '127.0.0.1' },
  },
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const checks = [];
const failures = [];

function oklchToSrgb(lightness, chroma, hueDegrees) {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((channel) => {
    const encoded = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(encoded * 255)));
  });
}

/** Chromium keeps oklch() in computed styles; normalise both spaces to sRGB. */
function parseColor(value) {
  const rgb = /rgba?\(([^)]+)\)/.exec(value);
  if (rgb) {
    const parts = rgb[1].split(',').map((part) => Number.parseFloat(part));
    return [parts[0], parts[1], parts[2]];
  }
  const oklch = /oklch\(([^)]+)\)/.exec(value);
  assert.ok(oklch, `Expected a supported color, received ${value}`);
  const [lightness, chroma, hue] = oklch[1].split(/[\s/]+/).map((part) => Number.parseFloat(part));
  return oklchToSrgb(lightness, chroma, hue);
}

function relativeLuminance([r, g, b]) {
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function visit({ width, height, state, selected }) {
  const page = await browser.newPage({
    viewport: { width, height },
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    reducedMotion: 'reduce',
    hasTouch: width < 768,
  });
  page.setDefaultTimeout(15_000);
  await page.clock.setFixedTime(new Date(fixedTime));
  page.on('pageerror', (error) => failures.push(`${state}-${width}: pageerror ${error.message}`));
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/messaging/conversations') {
      const empty = state === 'empty';
      return route.fulfill({ json: { items: empty ? [] : conversations, nextCursor: null } });
    }
    if (url.pathname === '/api/messaging/unread-count') {
      return route.fulfill({ json: { unreadCount: state === 'empty' ? 0 : 2 } });
    }
    const messagesMatch = /^\/api\/messaging\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
    if (messagesMatch) {
      return route.fulfill({ json: { items: messages, nextCursor: null } });
    }
    // Selecting a conversation marks it read and reconciles its notifications;
    // both are mocked acknowledgements, never real writes.
    if (/^\/api\/messaging\/conversations\/[^/]+\/read$/.test(url.pathname)) {
      return route.fulfill({ status: 204, body: '' });
    }
    if (url.pathname === '/api/notifications/read-by-entity') {
      return route.fulfill({ status: 204, body: '' });
    }
    failures.push(`unexpected request ${url.pathname}`);
    return route.abort();
  });
  const query = new URLSearchParams({ role: 'MANAGER' });
  if (selected) query.set('selected', 'true');
  await page.goto(`${origin}/?${query}`);
  await page.locator('.messaging-container').waitFor();
  if (selected) {
    await page.locator('.conversation-item').first().click();
    await page.locator('.message-bubble').first().waitFor();
  }
  return page;
}

async function measure(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      return element ? element.getBoundingClientRect() : null;
    };
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    };
    const emptyStates = [...document.querySelectorAll('[data-servora-empty-state="true"]')].filter(isVisible);
    const emptyTitle = emptyStates[0]?.querySelector('h1, h2, h3') ?? null;
    const tab = document.querySelector('.conversation-view-tab');
    const box = (element) => (element ? {
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    } : null);
    const emptyTitleBox = emptyTitle ? box(emptyTitle) : null;
    const longTitle = [...document.querySelectorAll('.conversation-name-text')]
      .find((element) => element.textContent?.includes('Bostancı bölgesi'));
    const longTitleStyle = longTitle ? getComputedStyle(longTitle) : null;
    const participantCount = document.querySelector('.conversation-participants-count');
    const participantCountRow = participantCount?.closest('.conversation-row');
    const selectedRow = document.querySelector('.conversation-row:has(.conversation-item.selected)');
    const selectedItem = document.querySelector('.conversation-item.selected');
    const visibleRouteTitles = [...document.querySelectorAll('body *')]
      .filter((element) => element.children.length === 0 && element.textContent?.trim() === 'Mesajlar')
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (style.clipPath === 'inset(50%)') return false;
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      });
    const firstMeta = document.querySelector('.conversation-meta');
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      emptyStateCount: emptyStates.length,
      emptyStateDomCount: document.querySelectorAll('[data-servora-empty-state="true"]').length,
      emptyStateTitles: emptyStates.map((element) => element.querySelector('h1, h2, h3')?.textContent ?? ''),
      emptyTitleColor: emptyTitle ? getComputedStyle(emptyTitle).color : null,
      emptyTitleBackground: emptyTitle
        ? (() => {
            let node = emptyTitle;
            while (node) {
              const background = getComputedStyle(node).backgroundColor;
              if (background && background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') return background;
              node = node.parentElement;
            }
            return getComputedStyle(document.body).backgroundColor;
          })()
        : null,
      emptyTitlePixels: emptyTitle ? Number.parseFloat(getComputedStyle(emptyTitle).fontSize) : null,
      emptyTitleBox,
      pageHeader: box(document.querySelector('.page-header')),
      workspace: box(document.querySelector('.messaging-workspace')),
      container: box(document.querySelector('.messaging-container')),
      sidebar: box(document.querySelector('.messaging-sidebar')),
      thread: box(document.querySelector('.messaging-thread')),
      threadVisible: document.querySelector('.messaging-thread')
        ? getComputedStyle(document.querySelector('.messaging-thread')).display !== 'none'
        : false,
      longTitle: longTitle ? {
        clientWidth: longTitle.clientWidth,
        scrollWidth: longTitle.scrollWidth,
        overflow: longTitleStyle?.overflow,
        textOverflow: longTitleStyle?.textOverflow,
        whiteSpace: longTitleStyle?.whiteSpace,
      } : null,
      participantCount: participantCount && participantCountRow ? {
        text: participantCount.textContent?.trim() ?? '',
        width: participantCount.getBoundingClientRect().width,
        insideRow: participantCount.getBoundingClientRect().right <= participantCountRow.getBoundingClientRect().right + 1,
      } : null,
      conversationMetaWidth: firstMeta ? firstMeta.clientWidth : null,
      selectedRow: selectedRow ? {
        outlineStyle: getComputedStyle(selectedRow).outlineStyle,
        outlineWidth: getComputedStyle(selectedRow).outlineWidth,
        outlineColor: getComputedStyle(selectedRow).outlineColor,
      } : null,
      selectedItemBoxShadow: selectedItem ? getComputedStyle(selectedItem).boxShadow : null,
      visibleRouteTitles: visibleRouteTitles.map((element) => element.className || element.tagName),
      sidebarAccessibleName: document.querySelector('.messaging-sidebar')?.getAttribute('aria-label') ?? null,
      tabs: [...document.querySelectorAll('.conversation-view-tab')].map((element) => ({
        text: element.textContent?.trim() ?? '',
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        pixels: Number.parseFloat(getComputedStyle(element).fontSize),
      })),
      tabFontPixels: tab ? Number.parseFloat(getComputedStyle(tab).fontSize) : null,
      chatChips: [...document.querySelectorAll('.context-chip')].map(
        (element) => Number.parseFloat(getComputedStyle(element).fontSize),
      ),
      composerBottom: rect('.thread-composer')?.bottom ?? null,
    };
  });
}

function assertGutter(measurement, label) {
  const gutter = Math.min(
    measurement.pageHeader?.left ?? Number.POSITIVE_INFINITY,
    measurement.container?.left ?? Number.POSITIVE_INFINITY,
  );
  if (!(gutter >= 16)) failures.push(`${label}: workspace gutter is ${gutter}px (expected >= 16px)`);
  const workspace = measurement.workspace;
  if (!workspace) {
    failures.push(`${label}: messaging workspace missing`);
    return;
  }
  if (workspace.right > measurement.width + 1) {
    failures.push(`${label}: workspace escapes the viewport (${workspace.right} > ${measurement.width})`);
  }
}

try {
  for (const [state, width, height] of [
    ['empty', 390, 844],
    ['empty', 1440, 900],
    ['populated', 390, 844],
    ['populated', 1440, 900],
    ['selected', 390, 844],
    ['selected', 1440, 900],
  ]) {
    const label = `${state}-${width}`;
    const page = await visit({ width, height, state, selected: state === 'selected' });
    try {
      const measurement = {
        ...(await measure(page)),
        subMinimumText: await page.evaluate(collectSubMinimumText, { min: MIN_READABLE_TEXT_PX }),
      };
      checks.push({ label, ...measurement });
      // Capture before assertions so a failing state still leaves reviewable evidence.
      if (captureDir) {
        await page.screenshot({ path: resolve(captureDir, `messages-${state}-${width}.png`), fullPage: false });
      }
      assert.equal(measurement.pageOverflow, 0, `${label}: horizontal overflow`);
      assertGutter(measurement, label);

      // Empty list: the list pane owns the only empty state. Populated list on
      // mobile: the thread pane is hidden. Populated desktop: one neutral prompt.
      // One visible route title only (PageHeader or MobileTopBar), and the list
      // region keeps an accessible name.
      assert.equal(measurement.visibleRouteTitles.length, 1, `${label}: expected one visible "Mesajlar" title, found ${measurement.visibleRouteTitles.length}`);
      assert.equal(measurement.sidebarAccessibleName, 'Konuşmalar', `${label}: list accessible name`);

      if (state !== 'empty') {
        // Long titles truncate with an ellipsis instead of clipping mid-glyph.
        assert.ok(measurement.longTitle, `${label}: long-title fixture missing`);
        assert.equal(measurement.longTitle.overflow, 'hidden', `${label}: title overflow`);
        assert.equal(measurement.longTitle.textOverflow, 'ellipsis', `${label}: title ellipsis`);
        assert.ok(
          measurement.longTitle.scrollWidth > measurement.longTitle.clientWidth + 1,
          `${label}: long title is not actually truncating (${measurement.longTitle.scrollWidth} <= ${measurement.longTitle.clientWidth})`,
        );

        // The "+ N kişi" count survives the name truncation.
        assert.ok(measurement.participantCount, `${label}: participant count missing`);
        assert.match(measurement.participantCount.text, /\+ \d+ kişi/, `${label}: participant count text`);
        assert.ok(measurement.participantCount.width > 0, `${label}: participant count has no width`);
        assert.ok(measurement.participantCount.insideRow, `${label}: participant count overflows its row`);

        if (width >= 1024) {
          assert.ok(
            (measurement.conversationMetaWidth ?? 0) >= 150,
            `${label}: conversation meta width ${measurement.conversationMetaWidth}px (expected >= 150px)`,
          );
        }
      }

      const visibleEmptyStates = state === 'selected'
        ? 0
        : state === 'empty'
          ? 1
          : width >= 1024 ? 1 : 0;
      assert.equal(
        measurement.emptyStateCount,
        visibleEmptyStates,
        `${label}: expected ${visibleEmptyStates} visible empty state(s), found ${measurement.emptyStateCount} (${measurement.emptyStateTitles.join(' / ')})`,
      );
      assert.equal(
        measurement.emptyStateDomCount,
        state === 'selected' ? 0 : 1,
        `${label}: expected one empty-state region, found ${measurement.emptyStateDomCount}`,
      );

      for (const tab of measurement.tabs) {
        assert.ok(tab.height >= 44, `${label}: ${tab.text} selector is ${tab.height}px tall`);
        assert.ok(tab.width >= 44, `${label}: ${tab.text} selector is ${tab.width}px wide`);
        assert.ok(tab.pixels >= MIN_READABLE_TEXT_PX, `${label}: ${tab.text} selector type ${tab.pixels}px`);
      }

      for (const pixels of measurement.chatChips) {
        assert.ok(pixels >= MIN_READABLE_TEXT_PX, `${label}: context chip type ${pixels}px`);
      }

      if (measurement.emptyTitleColor) {
        const ratio = contrastRatio(
          parseColor(measurement.emptyTitleColor),
          parseColor(measurement.emptyTitleBackground ?? 'rgb(255, 255, 255)'),
        );
        assert.ok(
          ratio >= 4.5,
          `${label}: empty-state title contrast ${ratio.toFixed(2)}:1 (expected >= 4.5:1)`,
        );
        checks.push({ label: `${label}-empty-title-contrast`, ratio });
      }

      assertNoSubMinimumText(measurement.subMinimumText, label);

      if (state === 'selected' && width >= 1024) {
        assert.ok(measurement.selectedRow, `${label}: selected row missing`);
        assert.equal(measurement.selectedRow.outlineStyle, 'solid', `${label}: selection ring style`);
        assert.equal(measurement.selectedRow.outlineWidth, '2px', `${label}: selection ring width`);
        assert.equal(measurement.selectedItemBoxShadow, 'none', `${label}: item still draws its own ring`);
      }

      if (width === 390) {
        assert.equal(measurement.threadVisible, state === 'selected', `${label}: thread overlay visibility`);
        // The visible band ends above the fixed 3.75rem bottom navigation.
        const navBand = 60;
        assert.ok(
          measurement.workspace.bottom <= measurement.height - navBand + 1,
          `${label}: workspace bottom ${measurement.workspace.bottom}px sits under the bottom navigation`,
        );
        // The selected mobile thread is a deliberate full-screen overlay above
        // the bottom navigation, so only the list workspace is bounded here.
      }
    } catch (error) {
      // Keep measuring the remaining states so one regression cannot mask another.
      failures.push(String(error?.message ?? error));
    } finally {
      await page.close();
    }
  }
} catch (error) {
  failures.push(String(error?.stack ?? error));
} finally {
  await browser.close();
  server.close();
  await vite.close();
}

for (const check of checks) {
  console.log(JSON.stringify(check));
}

if (failures.length) {
  console.error('MESSAGING GEOMETRY SMOKE FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}

console.log('messaging geometry smoke OK');
