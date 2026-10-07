import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { OperationalCard } from '../src/ui/antd/OperationalCard';
import { ServoraAntProvider } from '../src/ui/antd';

const params = new URLSearchParams(window.location.search);
const fixtureCase = params.get('case') ?? 'create-terminal';

const LONG_TITLE = 'Ataşehir bölgesi klinik ziyaret turu ve ürün tanıtım planı hazırlığı çalışması';
const LONG_CUSTOMER = 'Özel Akademik Ağız ve Diş Sağlığı Merkezi Ataşehir Şubesi ve Çene Cerrahisi Kliniği';

/**
 * Static, class-faithful replicas of the JobDetail / Overview compositions.
 * Content is representative; the rules under test are pure CSS margins and
 * title wrapping on these exact classes, so no domain objects are fabricated.
 */
function Heading() {
  return (
    <div data-job-detail-section="heading">
      <header className="page-header">
        <div className="page-header-main">
          <h1 className="page-header-title">Fixture işi</h1>
        </div>
      </header>
      <div className="detail-heading-meta" data-job-detail-meta="true">
        <span className="status-chip status-chip--completed" data-status="COMPLETED">
          <span className="status-chip-shape" aria-hidden="true" />
          Tamamlandı
        </span>
        <span className="priority-chip priority-chip--high" data-priority="high">Yüksek öncelik</span>
      </div>
    </div>
  );
}

function Terminal() {
  return (
    <div data-job-detail-section="terminal">
      <section className="completed-job-banner surface job-workflow-panel" data-terminal-state="COMPLETED">
        <h2>Tamamlandı</h2>
        <p>İş yönetici kontrolünden geçerek tamamlandı.</p>
      </section>
    </div>
  );
}

function Steps() {
  return (
    <div data-job-detail-section="lifecycle">
      <section className="servora-workflow-steps" aria-label="İş süreci">
        <p>Adım 5 / 5 · Tamamlandı</p>
      </section>
    </div>
  );
}

function LatenessStub() {
  return (
    <section className="detail-summary surface-flat" data-submission-lateness="open" aria-label="Onaya gönderme gecikmesi">
      <p>
        <span className="job-overdue-signal">Onaya gönderme gecikti · 1 gün 2 saat</span>
      </p>
    </section>
  );
}

function JobDetailShell({ children }: { children: React.ReactNode }) {
  return <main className="job-detail" data-job-detail="true">{children}</main>;
}

function LateCardCase() {
  return (
    <main className="workspace overview-workspace">
      <div className="overview-main-grid">
        <section className="overview-section" aria-labelledby="submission-late-title">
          <h2 id="submission-late-title">Onaya göndermesi geciken işler</h2>
          <div className="overview-card-stack" id="late-stack">
            <OperationalCard
              title={<a href="/jobs/fixture-late-1">{LONG_TITLE}</a>}
              tone="attention"
              className="submission-late-card"
            >
              <span>{`Denetim Personeli · ${LONG_CUSTOMER} · 1 gün 2 saat gecikti`}</span>
            </OperationalCard>
            <OperationalCard
              title={<a href="/jobs/fixture-late-2">Kısa başlık</a>}
              tone="attention"
              className="submission-late-card"
            >
              <span>Denetim Personeli · Müşteri belirtilmedi · 3 saat gecikti</span>
            </OperationalCard>
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * Shared OperationalCard title contract cases (Slice B). Plain adapter cards
 * with no surface-scoped classes: long titles must wrap (including 200%
 * text), grids must not overflow, title+extra must not collide, and short
 * titles with actions must stay visually stable.
 */
function SharedTitleCase() {
  return (
    <main className="workspace overview-workspace">
      <div className="overview-card-stack" id="shared-title-stack">
        <OperationalCard
          title={<a href="/jobs/fixture-shared-1">{LONG_TITLE}</a>}
        >
          <span>{`Denetim Personeli · ${LONG_CUSTOMER}`}</span>
        </OperationalCard>
      </div>
    </main>
  );
}

function SharedExtraCase() {
  return (
    <main className="workspace overview-workspace">
      <div className="overview-card-stack" id="shared-extra-stack">
        <OperationalCard
          title={<a href="/jobs/fixture-shared-2">{LONG_TITLE}</a>}
          extra={<span data-shared-extra="true">Ek bilgi</span>}
        >
          <span>Gövde metni.</span>
        </OperationalCard>
      </div>
    </main>
  );
}

function SharedGridCase() {
  return (
    <main className="workspace settings-workspace">
      <nav className="settings-card-grid" id="shared-grid-stack" aria-label="Ayar kartları">
        {[0, 1, 2, 3].map((i) => (
          <OperationalCard
            key={i}
            title={<a href={`/ayar/fixture-${i}`}>{`${LONG_TITLE} ${i}`}</a>}
          >
            <small>{`Kart gövdesi ${i}.`}</small>
          </OperationalCard>
        ))}
      </nav>
    </main>
  );
}

function SharedActionsCase() {
  return (
    <main className="workspace overview-workspace">
      <div className="overview-card-stack" id="shared-actions-stack">
        <OperationalCard
          tone="attention"
          title={<h2>Takip gerekli</h2>}
          actions={<button type="button" className="secondary-button">Takip işi oluştur</button>}
        >
          <p>Personel bu görüşmenin ardından yeni bir takip işi önerdi.</p>
        </OperationalCard>
      </div>
    </main>
  );
}

function Case() {
  switch (fixtureCase) {
    case 'recommendation-terminal':
      return (
        <JobDetailShell>
          <section className="follow-up-recommendation" aria-label="Takip önerisi">
            <OperationalCard tone="attention" title={<h2>Takip gerekli</h2>}>
              <p>Personel bu görüşmenin ardından yeni bir takip işi önerdi.</p>
            </OperationalCard>
          </section>
          <Terminal />
        </JobDetailShell>
      );
    case 'source-terminal':
      return (
        <JobDetailShell>
          <section className="follow-up-source-context" aria-label="Takip kaynağı">
            <p>Önceki iş özeti</p>
          </section>
          <Terminal />
        </JobDetailShell>
      );
    case 'heading-steps':
      return (
        <JobDetailShell>
          <Heading />
          <Steps />
        </JobDetailShell>
      );
    case 'heading-lateness':
      return (
        <JobDetailShell>
          <Heading />
          <LatenessStub />
        </JobDetailShell>
      );
    case 'late-card':
      return <LateCardCase />;
    case 'shared-title':
      return <SharedTitleCase />;
    case 'shared-extra':
      return <SharedExtraCase />;
    case 'shared-grid':
      return <SharedGridCase />;
    case 'shared-actions':
      return <SharedActionsCase />;
    case 'create-terminal':
    default:
      return (
        <JobDetailShell>
          <section className="follow-up-create-action surface-flat" aria-label="Takip işi işlemi">
            <div>
              <h2>Sonraki işi planlayın</h2>
              <p>Tamamlanan kaydı değiştirmeden yeni ve bağlantılı bir iş oluşturun.</p>
            </div>
          </section>
          <Terminal />
        </JobDetailShell>
      );
  }
}

function App() {
  useEffect(() => {
    document.documentElement.dataset.smokeJobSpacingReady = 'true';
  }, []);
  return (
    <ServoraAntProvider>
      <Case />
    </ServoraAntProvider>
  );
}

const root = document.getElementById('job-detail-spacing-root');
if (root) {
  createRoot(root).render(<App />);
}
