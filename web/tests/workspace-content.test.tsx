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
  it('uses stable typed IDs and contains no calendar, messaging or invented legal content', () => {
    const ids = [...productDocumentation, ...helpArticles].map((article) => article.id);
    expect(new Set(ids).size).toBe(ids.length);
    const content = JSON.stringify([productDocumentation, helpArticles]).toLocaleLowerCase('tr-TR');
    expect(content).not.toContain('kvkk');
    expect(content).not.toContain('gizlilik politikası');
    expect(content).not.toContain('takvim');
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
});
