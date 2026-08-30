import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { paths } from '../paths';
import type { CurrentUser } from '../services/api';
import {
  getDataManagementSummary,
  type DataManagementCount,
  type DataManagementSummary,
} from '../services/data-management-api';
import { LoadingSkeleton } from '../ui/antd/LoadingSkeleton';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { ResultState } from '../ui/antd/ResultState';

export const DATA_MANAGEMENT_SUBTITLE =
  'Kuruluşunuzdaki iş kayıtlarını ve demo verilerini güvenli yaşam döngüsü kurallarıyla yönetin.';

type DataManagementPageProps = {
  user: CurrentUser;
  load?: () => Promise<DataManagementSummary>;
};

type CountKey = keyof DataManagementCount | 'prospect';
type CountSource = DataManagementCount & { prospect?: number };

function CountList({ count, labels }: {
  count: CountSource;
  labels: ReadonlyArray<readonly [CountKey, string]>;
}) {
  const values = count as Record<CountKey, number | undefined>;
  return <dl className="data-management-counts">
    {labels.map(([key, label]) => <div key={key}>
      <dt>{label}</dt>
      <dd>{values[key] ?? 0}</dd>
    </div>)}
  </dl>;
}

function CardTitle({ children }: { children: string }) {
  return <h2 className="data-management-card-title">{children}</h2>;
}

export function DataManagementPage({ user, load = getDataManagementSummary }: DataManagementPageProps) {
  const [summary, setSummary] = useState<DataManagementSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  function loadSummary() {
    let active = true;
    setLoading(true);
    setError('');
    void load()
      .then((next) => { if (active) setSummary(next); })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Veri özeti yüklenemedi.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }

  useEffect(() => loadSummary(), [load]);

  if (loading && !summary) {
    return <main className="workspace settings-workspace data-management-workspace">
      <LoadingSkeleton title="Veri Yönetimi yükleniyor" headingLevel={1} rows={5} />
    </main>;
  }

  if (error && !summary) {
    return <main className="workspace settings-workspace data-management-workspace">
      <ResultState
        status="error"
        title="Veri özeti yüklenemedi"
        description={error}
        headingLevel={1}
        action={<button className="secondary-button" type="button" onClick={loadSummary}>Tekrar dene</button>}
      />
    </main>;
  }

  if (!summary) return null;

  return <main className="workspace settings-workspace data-management-workspace">
    <header className="workspace-heading">
      <div>
        <h1>Veri Yönetimi</h1>
        <p className="workspace-heading-copy">{DATA_MANAGEMENT_SUBTITLE}</p>
      </div>
      <Link className="ghost-button" to={paths.settings}>Ayarlar</Link>
    </header>

    {error && <p className="form-error" role="alert">{error}</p>}

    <section className="data-management-grid" aria-label="Veri yaşam döngüsü bölümleri">
      <article>
        <OperationalCard title={<CardTitle>Müşteriler</CardTitle>}>
          <CountList count={summary.customers} labels={[
            ['total', 'Toplam'], ['active', 'Aktif'], ['prospect', 'Aday'], ['inactive', 'Pasif'],
          ]} />
          <p className="data-management-card-copy">
            Normal yaşam döngüsü pasifleştirmedir. Kalıcı kaldırma yalnızca yönetici tarafından ve işlem geçmişi olmayan hatalı kayıtlar için müşteri detayından yapılabilir.
          </p>
          <Link className="secondary-button" to={paths.customers}>Müşterileri yönet</Link>
        </OperationalCard>
      </article>

      <article>
        <OperationalCard title={<CardTitle>İlgili kişiler</CardTitle>}>
          <CountList count={summary.contacts} labels={[
            ['total', 'Toplam'], ['active', 'Aktif'], ['inactive', 'Pasif'],
          ]} />
          <p className="data-management-card-copy">
            İlgili kişiler, bağlı oldukları Müşteri içinde yönetilir; ayrı bir kayıt alanı değildir.
          </p>
          <Link className="secondary-button" to={paths.customers}>Müşterileri yönet</Link>
        </OperationalCard>
      </article>

      <article>
        <OperationalCard title={<CardTitle>Ürünler</CardTitle>}>
          <CountList count={summary.products} labels={[
            ['total', 'Toplam'], ['active', 'Aktif'], ['inactive', 'Pasif'],
          ]} />
          <p className="data-management-card-copy">
            Ürün yaşam döngüsünde normal yol pasifleştirmedir. Kalıcı kaldırma yalnızca uygun ürün detayından yürütülür.
          </p>
          <Link className="secondary-button" to={paths.products}>Ürünleri yönet</Link>
        </OperationalCard>
      </article>

      <article>
        <OperationalCard title={<CardTitle>Personel</CardTitle>}>
          <CountList count={summary.staff} labels={[
            ['total', 'Toplam'], ['active', 'Aktif'], ['inactive', 'Pasif'],
          ]} />
          <p className="data-management-card-copy">
            Personel kaydı kaldırılmaz; erişim ve sorumluluklar mevcut offboarding akışıyla güvenli biçimde sonlandırılır.
          </p>
          <div className="data-management-card-actions">
            <Link className="secondary-button" to={paths.staff}>Personeli yönet</Link>
            <Link className="inline-action" to={paths.users}>Kullanıcı yönetimine git</Link>
          </div>
        </OperationalCard>
      </article>

      <article>
        <OperationalCard title={<CardTitle>Demo verileri</CardTitle>}>
          <dl className="data-management-counts">
            <div><dt>Toplam</dt><dd>{summary.demoDataset.total}</dd></div>
            <div><dt>Aktif</dt><dd>{summary.demoDataset.active}</dd></div>
          </dl>
          <p className="data-management-card-copy">
            Demo veri kümeleri BUSINESS kayıtlarından ayrı tutulur ve kendi yönetim ekranındaki kontrollü yaşam döngüsüyle ele alınır.
          </p>
          <p className="data-management-empty" role="status">
            {summary.demoDataset.active > 0
              ? `${summary.demoDataset.active} aktif demo veri kümesi bulunuyor.`
              : 'Aktif demo veri kümesi yok.'}
          </p>
          <Link className="secondary-button" to={paths.settingsDemoData}>Demo verilerini yönet</Link>
        </OperationalCard>
      </article>
    </section>

    {user.capabilities?.backup === true && <section className="data-management-infrastructure" aria-labelledby="data-management-infrastructure-title">
      <OperationalCard title={<CardTitle>Yedekleme ve Kurtarma</CardTitle>}>
        <h3 id="data-management-infrastructure-title" className="sr-only">Altyapı yönetimi</h3>
        <p className="data-management-card-copy">
          Bu alan kuruluş kayıtlarının yaşam döngüsünden ayrı, installation-level altyapı yedekleme durumunu gösterir.
        </p>
        <Link className="secondary-button" to={paths.settingsBackupRecovery}>Yedekleme durumunu görüntüle</Link>
      </OperationalCard>
    </section>}
  </main>;
}
