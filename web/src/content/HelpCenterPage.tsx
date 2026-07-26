import type { CurrentUser } from '../services/api';
import { helpArticles } from './workspace-content';

export function HelpCenterPage({ user }: { user: CurrentUser }) {
  const articles = helpArticles.filter((article) => article.audience.includes(user.role));
  return <main className="workspace content-workspace">
    <header className="workspace-heading"><div><p className="eyebrow">Sorun giderme</p><h1>Yardım Merkezi</h1>
      <p>Güvenli ilk adımlar ve ne zaman yöneticinizden destek istemeniz gerektiği.</p></div></header>
    <section className="support-contact" aria-labelledby="support-contact-title">
      <h2 id="support-contact-title">Destek kanalı</h2>
      <p>{user.support.displayLabel}</p>
      {user.support.email && <a href={`mailto:${user.support.email}`}>{user.support.email}</a>}
      {user.support.helpUrl && <a href={user.support.helpUrl} target="_blank" rel="noreferrer">Yardım sayfasını aç</a>}
      {!user.support.email && !user.support.helpUrl && <p>İletişim kanalı yapılandırılmamış. Yöneticinizle kurumunuzun onaylı kanalı üzerinden iletişime geçin.</p>}
    </section>
    <div className="content-list">{articles.map((article) => <article key={article.id}>
      <h2>{article.title}</h2><p>{article.summary}</p>
      {article.sections.map((section) => <section key={section.heading}><h3>{section.heading}</h3>
        {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</section>)}
    </article>)}</div>
  </main>;
}
