/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { DocumentationPage } from '../src/content/DocumentationPage';
import { HelpCenterPage } from '../src/content/HelpCenterPage';
import { helpArticles, productDocumentation } from '../src/content/workspace-content';
import type { CurrentUser } from '../src/services/api';

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe',
  email: 'ayse@example.test', role: 'STAFF', mustChangePassword: false,
  isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'Sistem yöneticiniz', email: null, helpUrl: null },
};

function renderDocs(user = staff) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <DocumentationPage user={user} />
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function cleanup({ container, root }: { container: HTMLElement; root: Root }) {
  act(() => root.unmount());
  container.remove();
}

function getCheckbox(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

function getCollapseHeaders(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[class*=\"collapse-header\"]'));
}

function getActivePanels(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('[class*=\"collapse-item-active\"]'));
}

function getCollapseHeadersInArticle(container: HTMLElement, articleId: string): HTMLElement[] {
  const article = container.querySelector(`article[id="${articleId}"]`);
  if (!article) return [];
  return Array.from(article.querySelectorAll('[class*=\"collapse-header\"]'));
}

function clickCollapseHeader(header: HTMLElement) {
  header.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  header.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('repository-managed workspace content', () => {
  it('uses stable typed IDs and contains no messaging or invented legal content', () => {
    const ids = [...productDocumentation, ...helpArticles].map((article) => article.id);
    expect(new Set(ids).size).toBe(ids.length);
    const content = JSON.stringify([productDocumentation, helpArticles]).toLocaleLowerCase('tr-TR');
    expect(content).not.toContain('kvkk');
    expect(content).not.toContain('gizlilik politikası');
    expect(content).not.toContain('mesajlaşma');
  });

  it('filters management documentation from Staff and provides neutral support fallback', () => {
    const docsHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><DocumentationPage user={staff} /></MemoryRouter>,
    );
    expect(docsHTML).not.toContain('Yönetici ve admin rollerinin mevcut operasyon raporları');
    const helpHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><HelpCenterPage user={staff} /></MemoryRouter>,
    );
    expect(helpHTML).toContain('İletişim kanalı yapılandırılmamış');
    expect(helpHTML).not.toContain('mailto:');
    expect(helpHTML).not.toContain('target="_blank"');
  });

  it('renders only validated support link forms with noreferrer', () => {
    const helpHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><HelpCenterPage user={{
        ...staff,
        support: { displayLabel: 'Sentetik destek', email: 'support@example.test', helpUrl: 'https://support.example.test/help' },
      }} /></MemoryRouter>,
    );
    expect(helpHTML).toContain('href="mailto:support@example.test"');
    expect(helpHTML).toContain('href="https://support.example.test/help"');
    expect(helpHTML).toContain('rel="noreferrer"');
  });

  it('renders search input in documentation page', () => {
    const docsHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><DocumentationPage user={staff} /></MemoryRouter>,
    );
    expect(docsHTML).toContain('type="search"');
    expect(docsHTML).toContain('Dokümantasyonda ara');
  });

  it('renders search input in help center page', () => {
    const helpHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><HelpCenterPage user={staff} /></MemoryRouter>,
    );
    expect(helpHTML).toContain('type="search"');
    expect(helpHTML).toContain('Yardım konularında ara');
  });

  it('renders category filter buttons with aria-pressed in documentation page', () => {
    const docsHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><DocumentationPage user={staff} /></MemoryRouter>,
    );
    expect(docsHTML).toContain('aria-pressed="true"');
    expect(docsHTML).toContain('aria-pressed="false"');
    expect(docsHTML).toContain('Tümü');
    expect(docsHTML).toContain('İş akışı');
  });

  it('hides help category controls when only one real category exists', () => {
    const helpHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><HelpCenterPage user={staff} /></MemoryRouter>,
    );
    expect(helpHTML).not.toContain('aria-pressed');
    expect(helpHTML).not.toContain('Kategori filtresi');
    expect(helpHTML).toContain('Sorun giderme');
  });

  it('renders articles using OperationalCard and ContentCollapse in documentation page', () => {
    const docsHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><DocumentationPage user={staff} /></MemoryRouter>,
    );
    expect(docsHTML).toContain('servora-operational-card');
    expect(docsHTML).toContain('servora-content-collapse');
    expect(docsHTML).toContain('content-summary');
    expect(docsHTML).toContain('content-meta');
  });

  it('renders articles using OperationalCard and ContentCollapse in help center page', () => {
    const helpHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><HelpCenterPage user={staff} /></MemoryRouter>,
    );
    expect(helpHTML).toContain('servora-operational-card');
    expect(helpHTML).toContain('servora-content-collapse');
    expect(helpHTML).toContain('content-summary');
    expect(helpHTML).toContain('content-meta');
  });

  it('renders support contact with OperationalCard and RecordDescriptions when contact is configured', () => {
    const helpHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><HelpCenterPage user={{
        ...staff,
        support: { displayLabel: 'Sentetik destek', email: 'support@example.test', helpUrl: 'https://support.example.test/help' },
      }} /></MemoryRouter>,
    );
    expect(helpHTML).toContain('Destek iletişimi');
    expect(helpHTML).toContain('servora-operational-card');
    expect(helpHTML).toContain('servora-record-descriptions');
  });

  it('renders support contact fallback when no contact is configured', () => {
    const helpHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><HelpCenterPage user={staff} /></MemoryRouter>,
    );
    expect(helpHTML).toContain('Destek iletişimi');
    expect(helpHTML).toContain('İletişim kanalı yapılandırılmamış');
    expect(helpHTML).toContain('servora-operational-card--attention');
  });

  it('renders static (non-alert) security notice with product-neutral wording', () => {
    const helpHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><HelpCenterPage user={staff} /></MemoryRouter>,
    );
    expect(helpHTML).toContain('Güvenlik bildirimi');
    expect(helpHTML).toContain('Hesap ve veri güvenliğiniz kurum politikalarına tabidir');
    expect(helpHTML).not.toContain('role="alert"');
  });

  it('renders troubleshooting-oriented help intro without documentation positioning', () => {
    const helpHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><HelpCenterPage user={staff} /></MemoryRouter>,
    );
    expect(helpHTML).toContain('Karşılaştığınız sorunlar için çözüm adımlarını inceleyin');
  });

  it('renders product-neutral documentation intro', () => {
    const docsHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><DocumentationPage user={staff} /></MemoryRouter>,
    );
    expect(docsHTML).toContain('İş akışları, kayıtlar, bildirimler ve raporlar için kullanım kılavuzları');
    expect(docsHTML).not.toContain('Servora iş akışları');
  });

  it('does not render internal update labels or implementation terminology in article metadata', () => {
    const docsHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><DocumentationPage user={staff} /></MemoryRouter>,
    );
    expect(docsHTML).not.toContain('U1');
    expect(docsHTML).not.toContain('U2');
    const content = JSON.stringify([productDocumentation, helpArticles]);
    expect(content).not.toContain('JobCard');
    expect(content).not.toContain('Web Push');
    expect(content).toContain('iş kaydı');
  });

  it('renders reading mode toggle in documentation page', () => {
    const docsHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><DocumentationPage user={staff} /></MemoryRouter>,
    );
    expect(docsHTML).toContain('type="checkbox"');
    expect(docsHTML).toContain('Okuma modu');
  });

  it('shows EmptyState when search yields no results (initial state renders articles)', () => {
    const docsHTML = require('react-dom/server').renderToStaticMarkup(
      <MemoryRouter><DocumentationPage user={staff} /></MemoryRouter>,
    );
    expect(docsHTML).toContain('Ürün dokümantasyonu');
  });
});

describe('Documentation reading mode interaction', () => {
  let ctx: ReturnType<typeof renderDocs>;

  afterEach(() => {
    if (ctx) cleanup(ctx);
  });

  it('reading mode starts disabled', () => {
    ctx = renderDocs();
    expect(getCheckbox(ctx.container).checked).toBe(false);
    expect(getActivePanels(ctx.container)).toHaveLength(0);
  });

  it('collapse panel headers are present with expected section text', () => {
    ctx = renderDocs();
    const headers = getCollapseHeaders(ctx.container);
    expect(headers.length).toBeGreaterThanOrEqual(4);
    const headingTexts = headers.map((h) => h.textContent?.trim());
    expect(headingTexts).toContain('İş ve kişisel plan ayrımı');
    expect(headingTexts).toContain('Yetki ve bildirim');
  });

  it('calendar-planning article has two collapse headers', () => {
    ctx = renderDocs();
    const cpHeaders = getCollapseHeadersInArticle(ctx.container, 'calendar-planning');
    expect(cpHeaders).toHaveLength(2);
  });

  it('keeps panels in different articles independently expanded', () => {
    ctx = renderDocs();

    const calendarHeaders = getCollapseHeadersInArticle(ctx.container, 'calendar-planning');
    expect(calendarHeaders.length).toBeGreaterThanOrEqual(1);
    act(() => { clickCollapseHeader(calendarHeaders[0]); });
    expect(getActivePanels(ctx.container)).toHaveLength(1);

    const jobFlowHeaders = getCollapseHeadersInArticle(ctx.container, 'job-flow');
    expect(jobFlowHeaders.length).toBeGreaterThanOrEqual(1);
    act(() => { clickCollapseHeader(jobFlowHeaders[0]); });
    expect(getActivePanels(ctx.container)).toHaveLength(2);

    act(() => { clickCollapseHeader(jobFlowHeaders[0]); });
    expect(getActivePanels(ctx.container)).toHaveLength(1);
  });

  it('reading mode ON opens all visible section panels', () => {
    ctx = renderDocs();
    act(() => { getCheckbox(ctx.container).click(); });
    expect(getCheckbox(ctx.container).checked).toBe(true);
    expect(getActivePanels(ctx.container).length).toBeGreaterThanOrEqual(4);
  });

  it('reading mode ON prevents closing panels via header click', () => {
    ctx = renderDocs();
    act(() => { getCheckbox(ctx.container).click(); });
    const activeBefore = getActivePanels(ctx.container).length;
    expect(activeBefore).toBeGreaterThanOrEqual(4);
    const headers = getCollapseHeaders(ctx.container);
    if (headers.length > 0) {
      act(() => { clickCollapseHeader(headers[0] as HTMLElement); });
    }
    expect(getActivePanels(ctx.container)).toHaveLength(activeBefore);
  });

  it('reading mode OFF closes all panels', () => {
    ctx = renderDocs();
    const checkbox = getCheckbox(ctx.container);
    act(() => { checkbox.click(); });
    expect(getActivePanels(ctx.container).length).toBeGreaterThanOrEqual(4);
    act(() => { checkbox.click(); });
    expect(getCheckbox(ctx.container).checked).toBe(false);
    expect(getActivePanels(ctx.container)).toHaveLength(0);
  });

  it('restores independent per-article interaction after leaving reading mode', () => {
    ctx = renderDocs();
    const checkbox = getCheckbox(ctx.container);

    act(() => { checkbox.click(); });
    expect(getActivePanels(ctx.container).length).toBeGreaterThanOrEqual(4);
    act(() => { checkbox.click(); });
    expect(getCheckbox(ctx.container).checked).toBe(false);
    expect(getActivePanels(ctx.container)).toHaveLength(0);

    const calendarHeaders = getCollapseHeadersInArticle(ctx.container, 'calendar-planning');
    const jobFlowHeaders = getCollapseHeadersInArticle(ctx.container, 'job-flow');
    act(() => { clickCollapseHeader(calendarHeaders[0]); });
    expect(getActivePanels(ctx.container)).toHaveLength(1);
    act(() => { clickCollapseHeader(jobFlowHeaders[0]); });
    expect(getActivePanels(ctx.container)).toHaveLength(2);
  });

  it('anchor only appears on calendar-planning article (2 sections)', () => {
    ctx = renderDocs();
    act(() => { getCheckbox(ctx.container).click(); });
    const anchorSections = ctx.container.querySelectorAll('.content-anchor-sidebar');
    expect(anchorSections.length).toBe(1);
    const anchorArticle = anchorSections[0].closest('article');
    expect(anchorArticle?.id).toBe('calendar-planning');
  });

  it('single-section articles do not receive anchor class', () => {
    ctx = renderDocs();
    act(() => { getCheckbox(ctx.container).click(); });
    const articles = ctx.container.querySelectorAll('article');
    const singleSectionIds = ['job-flow', 'records', 'notifications'];
    for (const article of Array.from(articles)) {
      if (singleSectionIds.includes(article.id)) {
        expect(article.classList.contains('content-article--with-anchor')).toBe(false);
      }
    }
  });

  it('search filter change shows EmptyState and does not crash', () => {
    ctx = renderDocs();
    const searchInput = ctx.container.querySelector('input[type="search"]') as HTMLInputElement;
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value',
      )!.set!;
      nativeInputValueSetter.call(searchInput, 'raporla');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(ctx.container.querySelectorAll('article').length).toBe(0);
    expect(ctx.container.textContent).toContain('Sonuç bulunamadı');
  });

  it('checkbox receives keyboard focus', () => {
    ctx = renderDocs();
    const checkbox = getCheckbox(ctx.container);
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);
  });
});
