# Servora-Med Documentation Consolidation Design

> Date: 2026-07-10  
> Status: Implemented and documentation-validated  
> Scope: Documentation only; no application code, migration, or dependency changes

## 1. Objective

Servora-Med dokümanlarını tek kaynaklı, çelişkisiz ve uygulamaya hazır bir yapıya dönüştürmek. Ürünün mevcut mimari yönü korunacak; yalnızca doğrulanmış eksikler giderilecek, belirsiz kararlar kesinleştirilecek ve tekrar eden eski girdiler arşivlenecek.

Servora-Med, medikal/dental firmalar için JobCard merkezli saha operasyonu, ürün teslimi, CRM ve personel iş takibi uygulamasıdır. Yönetici onayı olmadan bir JobCard `COMPLETED` olamaz. Depo, muhasebe, fiyat/gelir takibi, native mobil uygulama ve gelişmiş BI MVP dışında kalır.

## 2. Documentation Hierarchy

Aktif belgeler şu sorumluluklara ayrılacak:

| Document | Single responsibility |
| --- | --- |
| `AGENTS.md` | Ajan ve katkıcı çalışma disiplini |
| `PRODUCT_REQUIREMENTS.md` | Ürün amacı, kullanıcılar, iş akışları, MVP kapsamı ve başarı ölçütleri |
| `SERVORA_MED_ARCHITECTURE_PLAN.md` | Teknik ve mimari kararların SSOT'u |
| `SERVORA_MED_SCHEMA_DRAFT.md` | Veri modeli, constraint'ler ve domain invariant'ları |
| `SERVORA_MED_API_DRAFT.md` | REST kontratı, hata modeli, yetki ve concurrency davranışı |
| `SERVORA_MED_MVP_SLICES.md` | Uygulama sırası, bağımlılıklar ve acceptance criteria |
| `DECISIONS.md` | Tarihli, kısa ve değiştirilemez karar kayıtları |

Eski girdi ve tekrar belgeleri `docs/archive/inputs/` altında korunacak:

- `ilkplan.md`
- `teknoloji.md`
- `gem-doc.txt`
- `SERVORA_MED_AGENT_PLAN.md`

Arşiv belgeleri aktif karar kaynağı sayılmayacak. Aktif belgeler arşive yalnızca tarihsel bağlam için bağlantı verebilir.

## 3. Approved Product Decisions

### 3.1 Delivery tracking

`PRODUCT_DELIVERY` için teslim amacı yapılandırılmış olarak tutulacak:

```text
SALE
SAMPLE
CONSIGNMENT
RETURN
OTHER
```

MVP performans ölçümü teslim amacı ve ürün adedi üzerinden yapılacak. Aşağıdaki alanlar MVP'ye eklenmeyecek:

- unit price snapshot
- discount
- line total
- invoice or payment state
- revenue, margin, or commission metrics

`CONSIGNMENT` ve `RETURN` yalnızca operasyonel sınıflandırmadır; MVP'de stok hareketi üretmez.

Her ürün tesliminde gerçek gerçekleşme zamanı `delivered_at TIMESTAMPTZ` ile tutulacak. `staff_completed_at`, yalnızca personelin işi onaya gönderdiği zamanı ifade etmeye devam edecek.

### 3.2 Active JobCard types

İlk tracer bullet ve pilot çekirdeğinde aktif türler:

- `PRODUCT_DELIVERY`
- `GENERAL_TASK`

`SALES_MEETING`, yapılandırılmış görüşme modeliyle daha sonraki ayrı slice'a alınacak:

```text
job_card_meeting_details
- job_card_id
- meeting_at
- outcome
- next_follow_up_at
- meeting_summary
```

`QUOTE_FOLLOW_UP` ve `COLLECTION_FOLLOW_UP` MVP dışında kalacak. Pasif enum değerleri veya geleceğe dönük tablo iskeletleri ilk migration'a eklenmeyecek.

### 3.3 Concurrency

`job_cards` tablosunda optimistic concurrency kullanılacak:

```text
version INTEGER NOT NULL DEFAULT 1
```

JobCard alan güncellemeleri ve transition komutları `expectedVersion` taşıyacak. Eşleşmeyen sürümde API `409 VERSION_CONFLICT` dönecek. Başarılı her mutasyon version değerini atomik olarak artıracak.

Idempotency aynı komutun tekrarını; versioning ise farklı istemcilerin çakışan güncellemelerini çözer. İki mekanizma birbirinin yerine geçmez.

### 3.4 Authentication and sessions

MVP session modeli:

- yüksek entropili opaque token
- veritabanında yalnızca `token_hash`
- `HttpOnly`, `Secure`, `SameSite=Lax` cookie
- açık session expiry
- logout/revoke
- login rate limit
- auth ve cookie için production CORS/CSRF değerlendirmesi

Frontend token'ı `sessionStorage` veya `localStorage` içinde tutmayacak. Raw session token loglanmayacak veya veritabanına yazılmayacak.

### 3.5 Organization boundary

V1 tek firma kurulumudur; SaaS multi-tenancy değildir. `organization_id`, veri sahipliği sınırı olarak korunacak.

- Login email'i sistem genelinde case-insensitive unique olacak.
- API organization kimliğini client payload'ından kabul etmeyecek.
- JobCard, customer, contact, product ve assigned user aynı organization'a ait olmak zorunda olacak.
- Çapraz organization ilişkileri service testleriyle; uygun yerlerde composite constraint/FK ile korunacak.

### 3.6 Commands and write paths

State transition için yalnızca named command endpoint'leri kullanılacak:

```text
POST /api/job-cards/:id/plan
POST /api/job-cards/:id/start
POST /api/job-cards/:id/submit-for-approval
POST /api/job-cards/:id/approve
POST /api/job-cards/:id/request-revision
POST /api/job-cards/:id/resume
POST /api/job-cards/:id/cancel
```

Generic `/transitions` endpoint'i belgelerden çıkarılacak.

`POST /api/job-cards` delivery item kabul etmeyecek. Kart oluşturma ve delivery item ekleme ayrı komutlar olacak. İlk tracer bullet gerekirse seed/reference data kullanacak; atomik quick-create MVP'ye eklenmeyecek.

### 3.7 Idempotency

Tam processed-action idempotency yalnızca önemli iş olayı üreten komutlarda zorunlu olacak:

- JobCard creation
- delivery item creation
- submit for approval
- manager approval
- revision request
- cancellation

Sıradan profil, müşteri veya katalog alan güncellemelerinde validation ve gerekli concurrency kontrolü kullanılacak; processed response cache tüm CRUD katmanına yayılmayacak.

### 3.8 Activity events and immutability

Canonical activity event sözlüğü:

```text
JOB_CREATED
JOB_ASSIGNED
JOB_PLANNED
JOB_STARTED
JOB_SUBMITTED_FOR_APPROVAL
JOB_APPROVED
JOB_REVISION_REQUESTED
JOB_RESUMED
JOB_CANCELLED
JOB_FIELDS_UPDATED
DELIVERY_ITEM_ADDED
DELIVERY_ITEM_UPDATED
DELIVERY_ITEM_REMOVED
NOTE_ADDED
```

Lifecycle event'leri old/new status değerlerini taşır. Ayrı bir genel `STATUS_CHANGED` satırı üretilmez.

`WAITING_APPROVAL` durumunda staff ve manager ticari alanları değiştiremez. Manager yalnızca approve veya request-revision komutu verebilir. `COMPLETED` ve `CANCELLED` kartlar MVP'de immutable'dır; admin override yoktur.

## 4. Schema Simplifications

Şema taslağından şu erken veya çakışmalı alanlar çıkarılacak:

- `customers.is_active`; customer lifecycle yalnızca `status` ile yönetilecek
- `staff_profiles.is_active`; kullanıcı aktifliği `users.is_active` ile yönetilecek
- `staff_profiles.monthly_target`; hedef modeli tanımlanana kadar ertelenecek
- `products.track_lot`, `track_serial`, `track_expiry`; compliance/inventory slice'a ertelenecek
- `backup_log`; backup sonucu dış operasyon loglarında tutulacak

Lot, serial ve expiry teslim satırında opsiyonel kalabilir; MVP submit invariant'ı olmayacak.

Development/demo seed production migration'ına konmayacak:

- `npm run db:seed:dev` yalnızca development/test ortamında çalışacak
- production ilk admin kurulumu ayrı bootstrap CLI/env süreci olacak
- migration'lar gerçek slice bağımlılıklarına göre küçük fakat gereksiz parçalanmamış gruplara ayrılacak

## 5. Revised Slice Strategy

Uygulama sırası erken risk doğrulamasını hedefleyecek:

1. Scaffold, migration runner ve test harness
2. Secure auth, organization ownership ve admin bootstrap
3. Product-delivery tracer bullet backend: minimum reference data, delivery item, approval, activity, idempotency ve versioning
4. Mobile tracer bullet UI: staff submit, manager approve/revision
5. Users and staff profiles
6. Customers and contacts
7. Product catalog
8. Notes, timeline and Kanban/list
9. Staff profile reports
10. General Task
11. Sales Meeting structured detail
12. Deployment, backup and hardening
13. WebSocket only if polling proves insufficient

Her slice backend build/test ve web build gibi ilgili doğrulama komutlarına sahip olacak. Acceptance criteria, role boundary, failure case ve veri invariant'ını açıkça belirtecek.

## 6. Documentation Editing Rules

- Aynı karar birden fazla belgede tekrar açıklanmayacak; belgeler ilgili SSOT'a bağlantı verecek.
- Taslaklarda “veya”, “opsiyonel olabilir” gibi uygulamaya bırakılmış alternatifler kaldırılacak.
- Ürün gereksinimleri teknik uygulama ayrıntılarından ayrılacak.
- Mimari belge şema kolonlarını tekrar listelemeyecek.
- API belgesi yalnızca implement edilecek endpoint ve davranışları gösterecek.
- Slice belgesi ürün kapsamını yeniden tanımlamayacak; kabul edilen gereksinimlere referans verecek.
- Arşiv belgelerinin başına tarihsel girdi olduklarını ve aktif SSOT olmadıklarını belirten kısa not eklenecek.

## 7. Validation

Dokümantasyon değişiklikleri şu kontrollerden geçirilecek:

1. Placeholder taraması: `TBD`, `TODO`, açık alternatifler ve kararsız ifadeler.
2. Terim taraması: restoran POS domain'inin aktif belgelerde bulunmaması.
3. Çapraz belge kontrolü: JobCard tipleri, status'lar, event isimleri, endpoint'ler ve slice sırası.
4. Kapsam kontrolü: fiyat, muhasebe, stok hareketi, native mobil ve WebSocket'in MVP çekirdeğine sızmaması.
5. Link/path kontrolü: aktif ve arşiv belgelerine verilen yolların var olması.
6. `git diff` kontrolü yalnızca bir Git deposu bulunduğunda yapılacak.

## 8. Constraints and Known Limitation

Bu dizin 2026-07-10 tarihinde bir Git çalışma ağacı değildir. Bu nedenle tasarım belgesi veya sonraki doküman değişiklikleri bu konumda commit edilemez. Dosya değişiklikleri yapılabilir ve içerik doğrulanabilir; commit ancak proje Git deposuna alındığında gerçekleştirilebilir.
