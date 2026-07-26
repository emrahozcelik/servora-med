import type { CurrentUser } from '../services/api';
import { productDocumentation } from './workspace-content';

export function DocumentationPage({ user }: { user: CurrentUser }) {
  const articles = productDocumentation.filter((article) => article.audience.includes(user.role));
  return <main className="workspace content-workspace">
    <header className="workspace-heading"><div><p className="eyebrow">Ürün rehberi</p><h1>Dokümantasyon</h1>
      <p>Servora-Med’in mevcut operasyon akışları için kısa ve doğrulanmış rehberler.</p></div></header>
    <div className="content-list">{articles.map((article) => <article key={article.id} id={article.id}>
      <p className="eyebrow">{article.category} · {article.updatedLabel}</p>
      <h2>{article.title}</h2><p>{article.summary}</p>
      {article.sections.map((section) => <section key={section.heading}><h3>{section.heading}</h3>
        {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</section>)}
    </article>)}</div>
  </main>;
}
