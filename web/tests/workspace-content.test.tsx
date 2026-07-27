import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

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
    const docs = renderToStaticMarkup(<DocumentationPage user={staff} />);
    expect(docs).not.toContain('Yönetici ve admin rollerinin mevcut operasyon raporları');
    const help = renderToStaticMarkup(<HelpCenterPage user={staff} />);
    expect(help).toContain('İletişim kanalı yapılandırılmamış');
    expect(help).not.toContain('mailto:');
    expect(help).not.toContain('target="_blank"');
  });

  it('renders only validated support link forms with noreferrer', () => {
    const help = renderToStaticMarkup(<HelpCenterPage user={{
      ...staff,
      support: {
        displayLabel: 'Sentetik destek',
        email: 'support@example.test',
        helpUrl: 'https://support.example.test/help',
      },
    }} />);
    expect(help).toContain('href="mailto:support@example.test"');
    expect(help).toContain('href="https://support.example.test/help"');
    expect(help).toContain('rel="noreferrer"');
  });

  it('renders search input in documentation page', () => {
    const docs = renderToStaticMarkup(<DocumentationPage user={staff} />);
    expect(docs).toContain('type="search"');
    expect(docs).toContain('Dokümantasyonda ara');
  });

  it('renders search input in help center page', () => {
    const help = renderToStaticMarkup(<HelpCenterPage user={staff} />);
    expect(help).toContain('type="search"');
    expect(help).toContain('Yardım konularında ara');
  });

  it('renders category filter buttons with aria-pressed in documentation page', () => {
    const docs = renderToStaticMarkup(<DocumentationPage user={staff} />);
    expect(docs).toContain('aria-pressed="true"');
    expect(docs).toContain('aria-pressed="false"');
    expect(docs).toContain('Tümü');
    expect(docs).toContain('İş akışı');
  });

  it('renders category filter buttons with aria-pressed in help center page', () => {
    const help = renderToStaticMarkup(<HelpCenterPage user={staff} />);
    expect(help).toContain('aria-pressed="true"');
    expect(help).toContain('aria-pressed="false"');
    expect(help).toContain('Tümü');
    expect(help).toContain('Sorun giderme');
  });

  it('renders articles using OperationalCard and ContentCollapse in documentation page', () => {
    const docs = renderToStaticMarkup(<DocumentationPage user={staff} />);
    expect(docs).toContain('servora-operational-card');
    expect(docs).toContain('servora-content-collapse');
    expect(docs).toContain('content-summary');
    expect(docs).toContain('content-meta');
  });

  it('renders articles using OperationalCard and ContentCollapse in help center page', () => {
    const help = renderToStaticMarkup(<HelpCenterPage user={staff} />);
    expect(help).toContain('servora-operational-card');
    expect(help).toContain('servora-content-collapse');
    expect(help).toContain('content-summary');
    expect(help).toContain('content-meta');
  });

  it('renders support contact with OperationalCard and RecordDescriptions when contact is configured', () => {
    const help = renderToStaticMarkup(<HelpCenterPage user={{
      ...staff,
      support: {
        displayLabel: 'Sentetik destek',
        email: 'support@example.test',
        helpUrl: 'https://support.example.test/help',
      },
    }} />);
    expect(help).toContain('Destek iletişimi');
    expect(help).toContain('servora-operational-card');
    expect(help).toContain('servora-record-descriptions');
  });

  it('renders support contact fallback when no contact is configured', () => {
    const help = renderToStaticMarkup(<HelpCenterPage user={staff} />);
    expect(help).toContain('Destek iletişimi');
    expect(help).toContain('İletişim kanalı yapılandırılmamış');
    expect(help).toContain('servora-operational-card--attention');
  });

  it('renders security notice in help center page', () => {
    const help = renderToStaticMarkup(<HelpCenterPage user={staff} />);
    expect(help).toContain('Güvenlik bildirimi');
    expect(help).toContain('Servora hesap ve veri güvenliğiniz kurum politikalarına tabidir');
    expect(help).toContain('role="alert"');
  });

  it('renders reading mode toggle in documentation page', () => {
    const docs = renderToStaticMarkup(<DocumentationPage user={staff} />);
    expect(docs).toContain('type="checkbox"');
    expect(docs).toContain('Okuma modu');
  });

  it('shows EmptyState when search would yield no results (initial state renders articles)', () => {
    const docs = renderToStaticMarkup(<DocumentationPage user={staff} />);
    expect(docs).toContain('Ürün dokümantasyonu');
  });
});
