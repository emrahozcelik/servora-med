import { useMemo, useState } from 'react';
import type { CurrentUser } from '../services/api';
import { ContentCollapse, EmptyState, OperationalCard, RecordDescriptions } from '../ui/antd';
import { helpArticles } from './workspace-content';

const ALL_CATEGORIES = 'Tümü';

export function HelpCenterPage({ user }: { user: CurrentUser }) {
  const [search, setSearch] = useState('');

  const articles = useMemo(() => {
    return helpArticles.filter((a) => a.audience.includes(user.role));
  }, [user.role]);

  const categories = useMemo(() => {
    const cats = new Set(articles.map((a) => a.category));
    return [ALL_CATEGORIES, ...Array.from(cats)];
  }, [articles]);

  const [activeCategory, setActiveCategory] = useState(ALL_CATEGORIES);

  const filteredArticles = useMemo(() => {
    const searchLower = search.toLocaleLowerCase('tr-TR').trim();
    let result = articles;

    if (activeCategory !== ALL_CATEGORIES) {
      result = result.filter((a) => a.category === activeCategory);
    }

    if (searchLower) {
      result = result.filter((a) => {
        const inTitle = a.title.toLocaleLowerCase('tr-TR').includes(searchLower);
        const inSummary = a.summary.toLocaleLowerCase('tr-TR').includes(searchLower);
        const inSections = a.sections.some((s) =>
          s.heading.toLocaleLowerCase('tr-TR').includes(searchLower) ||
          s.paragraphs.some((p) => p.toLocaleLowerCase('tr-TR').includes(searchLower)),
        );
        return inTitle || inSummary || inSections;
      });
    }

    return result;
  }, [articles, search, activeCategory]);

  const supportItems = [
    { key: 'label', label: 'Kanal', content: user.support.displayLabel },
    ...(user.support.email ? [{
      key: 'email',
      label: 'E-posta',
      content: <a href={`mailto:${user.support.email}`}>{user.support.email}</a>,
    }] : []),
    ...(user.support.helpUrl ? [{
      key: 'web',
      label: 'Web',
      content: <a href={user.support.helpUrl} target="_blank" rel="noreferrer">Yardım sayfasını aç</a>,
    }] : []),
  ];

  const hasSupportContact = user.support.email || user.support.helpUrl;

  return (
    <main className="workspace content-workspace">
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">Yardım</p>
          <h1>Yardım Merkezi</h1>
          <p>Sık sorulan sorular, kullanım kılavuzları ve destek iletişimi.</p>
        </div>
      </header>

      <div className="content-search">
        <input
          type="search"
          className="form-control"
          placeholder="Yardım konularında ara…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Yardım konularında ara"
        />
      </div>

      <div className="content-categories" role="group" aria-label="Kategori filtresi">
        {categories.map((cat) => (
          <button
            key={cat}
            aria-pressed={activeCategory === cat}
            onClick={() => setActiveCategory(cat)}
          >
            {cat}
          </button>
        ))}
      </div>

      {filteredArticles.length === 0 ? (
        <EmptyState
          title="Sonuç bulunamadı"
          description="Farklı bir arama terimi deneyin veya kategori filtresini değiştirin."
        />
      ) : (
        <div className="content-list">
          {filteredArticles.map((article) => (
            <article key={article.id}>
              <OperationalCard title={article.title}>
                <p className="content-summary">{article.summary}</p>
                <small className="content-meta">{article.updatedLabel} · {article.category}</small>
                <ContentCollapse
                  accordion
                  items={article.sections.map((s) => ({
                    key: s.heading,
                    label: s.heading,
                    children: s.paragraphs.map((p) => (
                      <p key={p.slice(0, 20)} className="content-paragraph">{p}</p>
                    )),
                  }))}
                />
              </OperationalCard>
            </article>
          ))}
        </div>
      )}

      <section className="support-contact" aria-labelledby="support-contact-title">
        <OperationalCard
          tone={hasSupportContact ? 'default' : 'attention'}
          title={<h2 id="support-contact-title" style={{ margin: 0, fontSize: '1.15rem' }}>Destek iletişimi</h2>}
        >
          {hasSupportContact ? (
            <RecordDescriptions
              ariaLabel="Destek iletişim bilgileri"
              items={supportItems}
            />
          ) : (
            <p>İletişim kanalı yapılandırılmamış. Yöneticinizle kurumunuzun onaylı kanalı üzerinden iletişime geçin.</p>
          )}
        </OperationalCard>
      </section>

      <section className="content-security-notice" role="alert">
        <div className="content-security-notice__body">
          <strong>Güvenlik bildirimi</strong>
          <p>Servora hesap ve veri güvenliğiniz kurum politikalarına tabidir.</p>
        </div>
      </section>
    </main>
  );
}
