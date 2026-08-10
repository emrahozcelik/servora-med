import { useCallback, useMemo, useState } from 'react';
import type { CurrentUser } from '../services/api';
import { ContentCollapse, ContentAnchor, EmptyState, OperationalCard } from '../ui/antd';
import type { ContentAnchorItem } from '../ui/antd';
import { productDocumentation, type WorkspaceContent } from './workspace-content';

const ALL_CATEGORIES = 'Tümü';
const ANCHOR_MIN_SECTIONS = 2;

export function DocumentationPage({ user }: { user: CurrentUser }) {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState(ALL_CATEGORIES);
  const [readingMode, setReadingMode] = useState(false);
  const [expandedByArticle, setExpandedByArticle] = useState<Record<string, string[]>>({});

  const articles = useMemo(() => {
    return productDocumentation.filter((a) => a.audience.includes(user.role));
  }, [user.role]);

  const categories = useMemo(() => {
    const cats = new Set(articles.map((a) => a.category));
    return [ALL_CATEGORIES, ...Array.from(cats)];
  }, [articles]);

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

  const handleReadingMode = useCallback((checked: boolean) => {
    setReadingMode(checked);
    if (!checked) {
      setExpandedByArticle({});
    }
  }, []);

  const anchorItems = (article: WorkspaceContent): ContentAnchorItem[] =>
    article.sections.map((s) => ({
      key: `${article.id}-${s.heading}`,
      href: `#${article.id}-${encodeURIComponent(s.heading)}`,
      title: s.heading,
    }));

  return (
    <main className="workspace content-workspace">
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">Dokümantasyon</p>
          <h1>Ürün dokümantasyonu</h1>
          <p>İş akışları, kayıtlar, bildirimler ve raporlar için kullanım kılavuzları.</p>
        </div>
      </header>

      <div className="content-search">
        <input
          type="search"
          className="form-control"
          placeholder="Dokümantasyonda ara…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Dokümantasyon ara"
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

      <div className="content-reading-toggle">
        <label>
          <input
            type="checkbox"
            checked={readingMode}
            onChange={(e) => handleReadingMode(e.target.checked)}
          />
          {' '}Okuma modu (tüm bölümler açık)
        </label>
      </div>

      {filteredArticles.length === 0 ? (
        <EmptyState
          title="Sonuç bulunamadı"
          description="Farklı bir arama terimi deneyin veya kategori filtresini değiştirin."
        />
      ) : (
        <div className="content-list">
          {filteredArticles.map((article) => {
            const hasAnchor = readingMode && article.sections.length >= ANCHOR_MIN_SECTIONS;
            const anchors = hasAnchor ? anchorItems(article) : null;
            const sectionKeys = article.sections.map((s) => s.heading);
            const articleExpanded = expandedByArticle[article.id] ?? [];
            const activeKey = readingMode ? sectionKeys : articleExpanded;
            const handleCollapseChange = readingMode
              ? undefined
              : (keys: string[]) => setExpandedByArticle((prev) => ({ ...prev, [article.id]: keys }));
            return (
              <article
                key={article.id}
                id={article.id}
                className={hasAnchor ? 'content-article--with-anchor' : undefined}
              >
                {anchors && (
                  <aside className="content-anchor-sidebar">
                    <ContentAnchor
                      items={anchors}
                      ariaLabel={`${article.title} bölümleri`}
                    />
                  </aside>
                )}
                <div className="content-article-body">
                  <OperationalCard title={article.title}>
                    <p className="content-summary">{article.summary}</p>
                    <small className="content-meta">{article.category}</small>
                    <ContentCollapse
                      activeKey={activeKey}
                      onChange={handleCollapseChange as (keys: string[]) => void}
                      items={article.sections.map((s) => ({
                        key: s.heading,
                        label: s.heading,
                        children: (
                          <div id={`${article.id}-${encodeURIComponent(s.heading)}`}>
                            {s.paragraphs.map((p) => (
                              <p key={p.slice(0, 20)} className="content-paragraph">{p}</p>
                            ))}
                          </div>
                        ),
                      }))}
                    />
                  </OperationalCard>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
