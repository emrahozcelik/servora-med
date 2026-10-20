# CRM Slice 4A — Data Model and Query Contract

**Domain SSOT:** [Design](CRM_SLICE4A_DESIGN.md), SD-3–SD-6. Bu belge fiziksel karşılığı tanımlar.  
**Durum:** SQL taslağı; hiçbir SQL çalıştırılmadı, migration dosyası oluşturulmadı.

## DM-1 — Catalog and scope

İncelenen repository catalog son dosyası `058_sale_integer_quantity.sql`. Live DB head sorgulanmadı. Uygulama sırasında catalog loader, bütün migration listesi ve eşzamanlı işler tekrar kontrol edilecek; **sonraki numara bugün rezerve edilmedi**.

Additive kapsam:

- Read tarafı için iki ordinary B-tree index.
- Review aggregate ve append-only review events için iki yeni tablo.
- `audit_events` CHECK vocabulary'sine doğru subject ve iki event eklenmesi.
- `processed_actions`, Customer/Contact/JobCard kolonları ve business constraint'leri aynen kalır.
- Yeni enum type, fuzzy/pgcrypto extension, materialized view, worker, cache veya normalized-key tablosu yok.

SQL blokları tamamlanmış sözleşme taslaklarıdır; uygulamada catalog'a göre seçilen migration'lara yerleştirilmeden önce bağımsız inceleme ve gerçek PG17 testleri gerektirir. CREATE INDEX bloklarının migration transaction'ı içinde ordinary build lock maliyeti vardır; production çalışma penceresi ayrıca değerlendirilir.

## DM-2 — Logical separation

| Kavram | Fiziksel / hesaplanan sahibi |
| --- | --- |
| Aday pair | SD-3 read-time algorithm; persisted queue değil |
| Review aggregate | customer_duplicate_reviews; canonical pair, stable ID, current version |
| Güncel state/decision | Aggregate version'ına karşılık gelen current history event; ikinci status/evidence kopyası yok |
| History | customer_duplicate_review_events; append-only uygulama sözleşmesi |
| Audit | audit_events; subject review ID; ham kanıt yok |
| Retry receipt | Mevcut processed_actions; command sonucu; candidate/history kaynağı değil |

ReviewStatus, currentDecision, evidenceRevision, rule version, actor ve decision timestamp API'de current event join'inden gelir. `version=0` yalnız aggregate'siz DTO durumudur; DB review satırı 1'den başlar.

## DM-3 — Source read indexes

```sql
CREATE INDEX customers_duplicate_business_scan_idx
  ON customers (organization_id, id)
  WHERE data_class = 'BUSINESS';

CREATE INDEX contacts_duplicate_membership_idx
  ON contacts (organization_id, customer_id, id);
```

İlki çok sayıda DEMO kaydının BUSINESS scan planını bozmasını önler. İkincisi her parent için ordered LIMIT+sentinel okumayı destekler. Mevcut Contact (org,customer) index'i, büyük bir Contact grubunda ID sıralaması için bütün grubun sort edilmesini önlediği varsayılamaz. Yeni index'ler isim/telefon eşleştirme index'i değildir; JavaScript canonicalizer'ı kopyalamaz.

Index kullanımını planner'a zorlayan GUC/hint konulmaz. EXPLAIN ANALYZE/BUFFERS ve test hacimleriyle plan doğrulanır; uygun index varken kötü plan seçilirse timeout ile sessizce “başarılı boş sonuç” dönülmez. Index adı/varlığı tek başına performance PASS değildir.

## DM-4 — Review and event DDL

```sql
CREATE TABLE customer_duplicate_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  customer_a_id UUID NOT NULL,
  customer_b_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customer_duplicate_reviews_canonical_pair_check
    CHECK (customer_a_id < customer_b_id),
  CONSTRAINT customer_duplicate_reviews_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT customer_duplicate_reviews_pair_unique
    UNIQUE (organization_id, customer_a_id, customer_b_id)
);

CREATE TABLE customer_duplicate_review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  review_id UUID NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  event_kind VARCHAR(32) NOT NULL,
  resulting_status VARCHAR(32) NOT NULL,
  reason_code VARCHAR(48) NOT NULL,
  actor_user_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  evidence_schema_version SMALLINT NOT NULL
    CHECK (evidence_schema_version > 0),
  matching_rule_version VARCHAR(64) NOT NULL
    CHECK (matching_rule_version ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  evidence_key_id VARCHAR(32) NOT NULL
    CHECK (evidence_key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  evidence_digest BYTEA NOT NULL
    CHECK (octet_length(evidence_digest) = 32),
  matching_codes TEXT[] NOT NULL,
  conflicting_tax_numbers BOOLEAN NOT NULL,
  CONSTRAINT customer_duplicate_review_events_owner_fk
    FOREIGN KEY (organization_id, review_id)
    REFERENCES customer_duplicate_reviews (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT customer_duplicate_review_events_sequence_unique
    UNIQUE (organization_id, review_id, seq),
  CONSTRAINT customer_duplicate_review_events_codes_check CHECK (
    matching_codes <@ ARRAY[
      'SAME_NAME_AND_PHONE', 'SAME_NAME_AND_EMAIL',
      'SAME_NAME_AND_ADDRESS', 'SAME_PHONE', 'SAME_NAME'
    ]::text[]
  ),
  CONSTRAINT customer_duplicate_review_events_state_reason_check CHECK (
    (
      event_kind = 'DECISION_RECORDED'
      AND (
        (
          resulting_status = 'CONFIRMED_DUPLICATE'
          AND reason_code = 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'
        )
        OR
        (
          resulting_status = 'DISMISSED'
          AND reason_code IN (
            'DISTINCT_BRANCH', 'DISTINCT_CUSTOMER',
            'SHARED_CONTACT_DETAILS', 'INSUFFICIENT_EVIDENCE'
          )
        )
      )
    )
    OR
    (
      event_kind = 'REVIEW_REOPENED'
      AND resulting_status = 'PENDING_REVIEW'
      AND reason_code = 'RECHECK_REQUESTED'
    )
  )
);

ALTER TABLE customer_duplicate_reviews
  ADD CONSTRAINT customer_duplicate_reviews_current_event_fk
  FOREIGN KEY (organization_id, id, version)
  REFERENCES customer_duplicate_review_events
    (organization_id, review_id, seq)
  DEFERRABLE INITIALLY DEFERRED;
```

UNIQUE bütün aggregate ömrü için geçerlidir; pending/confirmed/dismissed diye ayrı aktif satır açılmaz. A/B yer değiştirmek UPDATE edilebilir alan değildir. Aynı pair farklı UUID ile tekrar insert edilemez. UUID CHECK DB'nin canonical sırasını, API lowercase UUID sırasını korur.

Current event FK'si current version için aynı org/review altında bir event bulunmasını commit'te zorunlu kılar. İlk review insert'i version 1 ile yapılır, sonra seq 1 event'i aynı transaction'da eklenir. Sonraki komut event(seq=v+1) append edip head'i `WHERE version=v` ile v+1 yapar. Başarısız audit/receipt veya deferred constraint tüm transaction'ı geri alır.

Bu FK yalnız head'in işaret ettiği same-org/version event'inin varlığını kanıtlar; max(seq), kesintisiz history veya state alternation'ını tek başına kanıtlamaz. Bunlar locked service + expected-version CAS + append-only repository yüzeyiyle korunur; trigger/CHECK ile cross-row state machine varmış gibi raporlanmaz. İlk head version=1 + event seq=1 tek transaction'dadır. Event owner FK'si immediate, current-event FK'si deferred olduğundan circular insert sırası uygulanabilirdir.

History event UUID'si audit/receipt tarafından referans kimliği olarak kullanılır. Sequence UNIQUE index'i history'nin geriye doğru sayfalaması için de yeterlidir; aynı index'in redundant DESC kopyası eklenmez.

### DM-4.1 — Historical identifiers and lifecycle

Customer pair ID'leri **tarihsel kimlik referansıdır; canlı Customer FK'si değildir**. Actor ID de olay anı kimliğidir; görüntüleme için varsa same-org User'a LEFT JOIN yapılır. Bu seçim:

- Review kaydını yeni Customer pristine-delete blocker'ına dönüştürmez.
- Customer/Contact deletion'a cascade edip review history'sini yok etmez.
- Mevcut silme/pasifleştirme kurallarını yeniden tasarlamaz.
- Pair creation/command anında iki Customer'ın org/BUSINESS/existence kontrolünü SD-6 kilitli servis protokolüne bırakır.

İlgili Customer sonradan mevcut yetkili pristine-delete akışıyla silinirse review/event kalır. Register `sourceAvailability=UNAVAILABLE` döndürür; sadece tarihsel ID ve güvenli event alanları vardır. Full comparison/decision/reopen 404 olur. DEMO'ya çevrilmiş veya artık org kapsamından çıkmış kaynaklar için de aynı unavailable şekli; DEMO raw alanı sızdırılmaz.

Böylece DB'nin bu tarihsel ID'ler için canlı Customer ownership FK'si sağladığı iddia edilmez. Bu tradeoff T2 olarak kabul edildi; geçmiş ID herhangi bir canlı Customer erişim yetkisi sağlamaz. Her current read/command org/BUSINESS/existence'i yeniden doğrular. Yeni FK blocker'ı eklenmez.

History'nin UPDATE/DELETE endpoint/repository metodu yoktur; append-only mevcut DOM-005 tarzı uygulama sözleşmesidir. Fiziksel her-yetkili SQL immutability iddiası veya yeni trigger yok. Service, head'i en son committed seq ile birlikte ilerletir; keyfi manual history append'i desteklenen yol değildir.

## DM-5 — Audit vocabulary and payload

Yeni subject: `CUSTOMER_DUPLICATE_REVIEW`. Yeni event'ler:

- `CUSTOMER_DUPLICATE_REVIEW_DECIDED`
- `CUSTOMER_DUPLICATE_REVIEW_REOPENED`

DDL taslağı mevcut head'deki allowed değerleri korur:

```sql
ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_subject_type_check,
  DROP CONSTRAINT audit_events_event_type_check;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_subject_type_check CHECK (subject_type IN (
    'USER', 'STAFF_PROFILE', 'CUSTOMER', 'CONTACT', 'PRODUCT',
    'STAFF_CONFIDENTIAL_NOTE', 'BACKUP_RUN', 'BACKUP_POLICY',
    'JOB_CARD', 'DEMO_DATASET', 'CUSTOMER_DUPLICATE_REVIEW'
  )),
  ADD CONSTRAINT audit_events_event_type_check CHECK (event_type IN (
    'USER_CREATED', 'USER_DELETED', 'USER_ROLE_CHANGED',
    'USER_ACTIVATED', 'USER_DEACTIVATED', 'USER_PASSWORD_RESET',
    'USER_OFFBOARDED', 'STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED',
    'CUSTOMER_CREATED', 'CUSTOMER_FIELDS_UPDATED',
    'CUSTOMER_ASSIGNEE_CHANGED', 'CUSTOMER_ACTIVATED',
    'CUSTOMER_DEACTIVATED', 'CONTACT_CREATED', 'CONTACT_FIELDS_UPDATED',
    'CONTACT_MADE_PRIMARY', 'CONTACT_ACTIVATED', 'CONTACT_DEACTIVATED',
    'CONTACT_DELETED', 'PRODUCT_CREATED', 'PRODUCT_FIELDS_UPDATED',
    'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED', 'CUSTOMER_DELETED',
    'PRODUCT_DELETED', 'STAFF_CONFIDENTIAL_NOTE_CREATED',
    'BACKUP_REQUESTED', 'BACKUP_POLICY_UPDATED', 'BACKUP_STARTED',
    'BACKUP_VERIFIED', 'BACKUP_COMPLETED', 'BACKUP_FAILED',
    'JOB_CARD_INVALIDATED', 'DEMO_DATASET_CREATED',
    'DEMO_DATASET_PURGED',
    'CUSTOMER_DUPLICATE_REVIEW_DECIDED',
    'CUSTOMER_DUPLICATE_REVIEW_REOPENED'
  ));
```

İmplementation migration'ı o anki catalog'dan allowed-set eşitliğini tekrar doğrulamalı. Bu taslağı eski main'e kör kopyalayıp daha yeni bir event'i silmek yasaktır.

Audit subject_id review ID. old/new değerler sadece eski/yeni review status; metadata sadece `historyEventId`, `reviewVersion`, pair ID'leri, matchingRuleVersion ve reasonCode. Actor/time mevcut audit kolonlarında. Raw isim/telefon/e-posta/adres/Contact tuple, request body, evidence token veya digest metadata'ya kopyalanmaz. Yeni olayı CUSTOMER_FIELDS_UPDATED ya da JobCard activity şeklinde yazmak yoktur. Her successful command için bir event + bir audit + bir receipt completion.

## DM-6 — Read SQL contracts

Aşağıdaki parametre limitleri Design SD-3.3 sabitlerinden gelir; client limiti artıramaz. Sorgular Node pg parametreleriyle yürütülür. ORM/new query framework yok.

### DM-6.1 — Candidate source scan

```sql
SELECT id, name, phone, status
FROM customers
WHERE organization_id = $1
  AND data_class = 'BUSINESS'
  AND status IN ('prospect', 'active', 'inactive')
  AND (
    $3::uuid IS NULL OR EXISTS (
      SELECT 1 FROM customers anchor
      WHERE anchor.organization_id = $1
        AND anchor.id = $3
        AND anchor.data_class = 'BUSINESS'
    )
  )
ORDER BY id
LIMIT $2;
```

`$2 = SOURCE_CUSTOMER_LIMIT + 1`. 20.001'inci satır-sentinel sonucu sadece overflow tespitinde kullanılır, normalize edilip kısmi başarılı listeye katılmaz. Global scope tam okunamıyorsa 422 CANDIDATE_SCAN_LIMIT; anchor filtresi cap'i kaldırmaz. Comparison/register global source scan yapmaz; iki ID veya bounded review head üzerinden çalışır. $3 optional anchor ID'dir; EXISTS uncorrelated org/id point probe'dur, bütün source satırlarını anchor'a filtrelemez. Anchor geçersizse gate false olur ve source sonucu boş gelir; non-null anchor + sıfır satır 404'tür. Böylece missing/foreign/DEMO anchor cap üstünde de aynı 404, uygun anchor + 20.001 source ise 422 alır. Ek SELECT yoktur; EXPLAIN'de eligibility probe'unun bir kez/bounded çalıştığı doğrulanır. ILIKE, SQL lower/regexp veya customer self-JOIN yok.

### DM-6.2 — Bounded facts

```sql
SELECT id, name, customer_type, tax_number, phone, email, city, district,
       CASE WHEN octet_length(COALESCE(address,'')) <= $3
            THEN address ELSE NULL END AS address,
       octet_length(COALESCE(address,'')) > $3 AS address_overflow,
       assigned_staff_user_id, status, version
FROM customers
WHERE organization_id = $1
  AND data_class = 'BUSINESS'
  AND id = ANY($2::uuid[])
ORDER BY id;
```

Candidate batch'te en fazla 64 source ID; comparison'da iki ID. Uzun adresin null dönmesi yalnız overflow işaretidir, “adres eksik” eşleşmesi/digest'i değildir.

### DM-6.3 — Contact membership/facts batch

```sql
SELECT parent.customer_id, ct.id, ct.name, ct.title, ct.phone, ct.email,
       ct.is_primary, ct.is_active, ct.version
FROM unnest($2::uuid[]) AS parent(customer_id)
CROSS JOIN LATERAL (
  SELECT id, name, title, phone, email, is_primary, is_active, version
  FROM contacts
  WHERE organization_id = $1
    AND customer_id = parent.customer_id
  ORDER BY id
  LIMIT $3
) ct
ORDER BY parent.customer_id, ct.id;
```

`$3 = CONTACT_LIMIT + 1`. Input parent ID'leri deduplicated. En fazla parentCount × 201 satır; frontend N+1 HTTP/SQL yok. LATERAL her parent için bounded index probe yapar; sorgu sayısı bir olsa da probe maliyeti ayrıca ölçülür. Parent başına 201 satır varsa o pair bütünlüğü doğrulanamaz. Son canonical serialization Contact ID'lerini global UUID sıralar; SQL taşıma sırası digest sırası diye varsayılmaz.

### DM-6.4 — Review heads for candidate batch

```sql
SELECT wanted.customer_a_id, wanted.customer_b_id,
       r.id, r.version, r.created_at,
       e.id AS event_id, e.event_kind, e.resulting_status, e.reason_code,
       e.actor_user_id, e.occurred_at, e.evidence_schema_version,
       e.matching_rule_version, e.evidence_key_id, e.evidence_digest,
       e.matching_codes, e.conflicting_tax_numbers,
       previous_decision.id AS previous_decision_id,
       previous_decision.seq AS previous_decision_seq,
       previous_decision.resulting_status AS previous_decision_status,
       previous_decision.reason_code AS previous_decision_reason,
       previous_decision.actor_user_id AS previous_decision_actor_id,
       previous_decision.occurred_at AS previous_decision_at
FROM unnest($2::uuid[], $3::uuid[])
     AS wanted(customer_a_id, customer_b_id)
LEFT JOIN customer_duplicate_reviews r
  ON r.organization_id = $1
 AND r.customer_a_id = wanted.customer_a_id
 AND r.customer_b_id = wanted.customer_b_id
LEFT JOIN customer_duplicate_review_events e
  ON e.organization_id = r.organization_id
 AND e.review_id = r.id
 AND e.seq = r.version
LEFT JOIN customer_duplicate_review_events previous_decision
  ON previous_decision.organization_id = r.organization_id
 AND previous_decision.review_id = r.id
 AND previous_decision.seq = r.version - 1
 AND previous_decision.event_kind = 'DECISION_RECORDED'
 AND e.event_kind = 'REVIEW_REOPENED'
ORDER BY wanted.customer_a_id, wanted.customer_b_id;
```

İki input array uzunluğu eşit, en fazla PAIR_EVALUATION_BUDGET ve unique canonical pair içermeli. LEFT JOIN sonucu pair başına en fazla bir head/event. Freshness JS'de batch facts'tan hesaplanır; SQL'de sadece `status='DISMISSED'` filtresiyle eski retler önceden elenmez.

Current event bir karar ise lastDecision=currentDecision; reopened ise strict state alternation nedeniyle previous_decision, lastDecision kaynağıdır. Sequence UNIQUE iki event join'inin cardinality'sini birde tutar. Reopened head'in önceki kararının bulunmaması desteklenen state chain'ini ihlal eder; sessiz null fallback yerine integrity error üretir. Ek pair-başına history sorgusu yoktur. Comparison da aynı bounded head projection'ını kullanır.

### DM-6.5 — Register and history

```sql
SELECT r.id, r.customer_a_id, r.customer_b_id, r.version,
       e.id AS event_id, e.event_kind, e.resulting_status,
       e.reason_code, e.actor_user_id, e.occurred_at,
       e.evidence_schema_version, e.matching_rule_version,
       e.evidence_key_id, e.evidence_digest, e.matching_codes,
       e.conflicting_tax_numbers,
       previous_decision.id AS previous_decision_id,
       previous_decision.seq AS previous_decision_seq,
       previous_decision.resulting_status AS previous_decision_status,
       previous_decision.reason_code AS previous_decision_reason,
       previous_decision.actor_user_id AS previous_decision_actor_id,
       previous_decision.occurred_at AS previous_decision_at
FROM customer_duplicate_reviews r
JOIN customer_duplicate_review_events e
  ON e.organization_id = r.organization_id
 AND e.review_id = r.id AND e.seq = r.version
LEFT JOIN customer_duplicate_review_events previous_decision
  ON previous_decision.organization_id = r.organization_id
 AND previous_decision.review_id = r.id
 AND previous_decision.seq = r.version - 1
 AND previous_decision.event_kind = 'DECISION_RECORDED'
 AND e.event_kind = 'REVIEW_REOPENED'
WHERE r.organization_id = $1
  AND (
    $2::uuid IS NULL
    OR (r.customer_a_id, r.customer_b_id) > ($2::uuid, $3::uuid)
  )
ORDER BY r.customer_a_id, r.customer_b_id
LIMIT $4;
```

Register'da bounded 32 head + sentinel okunur; source facts ve Contact'lar iki toplu sorguyla alınır. Global Customer scan yok. Stale/missing pair'ler current candidate uzayından düşmüş olsa da bu kayıtlar üzerinden bulunur.

```sql
SELECT e.id, e.seq, e.event_kind, e.resulting_status, e.reason_code,
       e.actor_user_id, e.occurred_at, e.matching_rule_version,
       e.matching_codes, e.conflicting_tax_numbers
FROM customer_duplicate_review_events e
JOIN customer_duplicate_reviews r
  ON r.organization_id = e.organization_id AND r.id = e.review_id
WHERE r.organization_id = $1 AND r.id = $2
  AND e.seq <= $3
  AND ($4::integer IS NULL OR e.seq < $4)
ORDER BY e.seq DESC
LIMIT $5;
```

History cursor `upperSeq` sabitler; append edilen yeni event eski sayfaları kaydırmaz. Wire'a raw digest veya Source PII çıkmaz. İlk history isteğinde org-scoped head varlığı doğrulanır; boş sayfa foreign/missing review'ü gizlemek için 200'e çevrilmez.

## DM-7 — Command SQL and consistency

Tam sıra SD-6'dadır. Source locks:

```sql
SELECT id, role, is_active
FROM users
WHERE organization_id = $1 AND id = $2
FOR SHARE NOWAIT;

SELECT id, name, customer_type, tax_number, phone, email, city, district,
       address, status, data_class, version
FROM customers
WHERE organization_id = $1 AND id = ANY($2::uuid[])
ORDER BY id
FOR UPDATE NOWAIT;
```

İkinci sorgunun gerçek uygulaması DM-6.2 adres overflow guard'ını da kullanır. Lock'tan sonra BUSINESS check yapılır; başka data class'ın alanları response/log'a taşınmaz.

Membership sorgusu parent lock'ları altında DM-6.3 ile iki parent için yapılır. Fazla üye yoksa bilinen bütün Contact ID'leri:

```sql
SELECT id, customer_id, name, title, phone, email,
       is_primary, is_active, version
FROM contacts
WHERE organization_id = $1
  AND customer_id = ANY($2::uuid[])
  AND id = ANY($3::uuid[])
ORDER BY id
FOR SHARE NOWAIT;
```

Bu final sonuç signature kaynağıdır. Ön-okumada olup finalde bulunmayan Contact eski değerle geri doldurulmaz. Yeni üyelik mevcut immediate composite Contact FK'si ve parent FOR UPDATE kilidiyle engellenir. deleteContact parent kilidi almadığından ön/final okuma arasındaki silinme özellikle test edilir; final share kilidinden sonra deletion bekler. FOR SHARE parent veya FOR KEY SHARE Contact bu sözleşmenin eşdeğeri değildir.

Head read:

```sql
SELECT id, version
FROM customer_duplicate_reviews
WHERE organization_id = $1
  AND customer_a_id = $2 AND customer_b_id = $3
FOR UPDATE NOWAIT;
```

Mevcut head update'i:

```sql
UPDATE customer_duplicate_reviews
SET version = version + 1
WHERE organization_id = $1 AND id = $2 AND version = $3
RETURNING id, version;
```

Sıfır satır VERSION_CONFLICT. Insert edilen yeni event seq'si dönen version ile eşittir. Initial head için `INSERT ... version=1` ve named pair unique constraint kullanılır; expected version 0 dışında absent head oluşturulmaz. Hiçbir Customer/Contact UPDATE veya new JobCard SQL'i bu repository'de bulunmaz.

Audit append'i aynı PoolClient üzerindedir. Receipt-completion UPDATE RETURNING id tam bir satır döndürmelidir; aksi throw + rollback. `SET CONSTRAINTS customer_duplicate_reviews_current_event_fk IMMEDIATE` ardından COMMIT uygulanır. Receipt, audit veya constraint hatasında head/event/fresh claim için committed değişim yoktur. Rollback/commit sonucu bağlantı nedeniyle belirsizse 5xx unresolved kalır; doğrulanmış no-commit yerine geçirilmez. Expected-token key yokluğu ancak receipt replay kontrolü ve başarılı rollback sonrasında 409 EVIDENCE_KEY_UNAVAILABLE olarak döner.

GET READ ONLY REPEATABLE READ snapshot'ı; fresh command READ COMMITTED + row locks. Deferred FK tasarımı [PostgreSQL 17 constraints](https://www.postgresql.org/docs/17/ddl-constraints.html) sözleşmesine dayanır; SQL burada yürütülmedi.

## DM-8 — Query budgets and implementation checks

Candidate: en fazla dört data SELECT; comparison: üç; register: üç; history: head + history için iki. BEGIN/SET/COMMIT ve auth sorguları ayrı sayılır. Optional operations paneli mevcut iki bounded summary endpoint'ini lazy çağırır; candidate batch'e JobCard join'i eklenmez.

Bütün sorgular source scope/limit parametreleriyle aynı read transaction client'ında çalışır. Pool üzerinden ayrı query'leri aynı snapshot sanmak yok. Query count testleri 1/20/32 pair ile sabit sayıyı doğrular; EXPLAIN testleri index, rows, buffers, sort/temp maliyetini ayrıca inceler.

DDL/check setleri, semantic enums ve wire alanları Test Matrix'te çapraz doğrulanır. Mevcut tax index/CHECK ve bütün eski migration dosyalarının byte hash'leri korunur. Test ve performans sonuçları şu an **NOT_RUN**.


## DM-9 — Key dependencies and rollout boundary

T3 custody/rotation/recovery SSOT: Design SD-4.4. Online iki key sınırı arşiv retention sınırı değildir. Operatörün rutin rotation preflight'ı yalnız current-head keyId/count metadata'sına bakar; müşteri alanlarını export etmez. Örnek sorgu sözleşmesi (çalıştırılmadı):

```sql
SELECT e.evidence_key_id, COUNT(*) AS current_head_count
FROM customer_duplicate_reviews r
JOIN customer_duplicate_review_events e
  ON e.organization_id = r.organization_id
 AND e.review_id = r.id AND e.seq = r.version
WHERE r.organization_id = $1
GROUP BY e.evidence_key_id
ORDER BY e.evidence_key_id;
```

Bu sorgu PR1'de yoktur; review tabloları PR2'de gelir. Operator timeout/gerçek release head'i doğrulanmadan sonuç varsayılmaz; customer source cap'i bu count sorgusunun performans kanıtı değildir. DB restore ile secret archive restore ayrı ama koordineli süreçtir; audit/processed_actions içinde secret saklanmaz. PR1 yalnız DM-3 read index'lerini kapsar; review/event/audit migration'ı ve command helper extract'i PR2'ye aittir. Bu görevde migration dosyası, numarası veya SQL execution yoktur.
