# Servora-Med — Geliştirme Runtime Kurulumu

Bu döküman, implementer ajanın sıfırdan bir geliştirme ortamını ayağa kaldırması için
adım adım talimatları içerir. Tek komutla veritabanı, kullanıcılar ve test verisi hazırlanır.

---

## Ön Koşullar

- Node.js >= 22.12.0
- PostgreSQL (çalışıyor olmalı — `pg_isready` ile kontrol edin)
- Proje bağımlılıkları kurulu (`cd server && npm install`, `cd web && npm install`)

---

## Hızlı Başlangıç (3 adım)

### 1. `.env` dosyasını oluşturun

```bash
cd server
cp .env.example .env
```

`.env` içindeki `DATABASE_URL`'i PostgreSQL kurulumunuza göre düzenleyin.
Homebrew PostgreSQL için varsayılan socket yolu `/tmp`'dir:

```
DATABASE_URL=postgresql:///servora_med_dev?host=/tmp
```

### 2. Veritabanını sıfırlayın ve seed edin

```bash
cd server
npx tsx --env-file=.env scripts/dev-runtime-setup.ts
```

Bu komut şunları yapar:
- Eski `servora_med_dev` veritabanını siler, yenisini oluşturur
- Tüm migration'ları (001-021) sırayla uygular
- 4 sentetik kullanıcı oluşturur (Admin, Manager, Staff, Inactive Manager)
- ACCEPTED durumunda bir GENERAL_TASK JobCard oluşturur
- Tüm ID'leri, email'leri ve şifreyi ekrana yazdırır

**Çıktı örneği:**

```
━━━ Seed Complete ━━━

  Shared password for all users:
    TestPass12345!

  Users:
  ┌──────────────────┬───────────────────────────────┬──────────────────────────────────────┐
  │ Role             │ Email                         │ ID                                   │
  ├──────────────────┼───────────────────────────────┼──────────────────────────────────────┤
  │ ADMIN            │ admin@servora.local           │ 550e8400-e29b-41d4-a716-446655440000 │
  │ MANAGER          │ manager@servora.local         │ 550e8400-e29b-41d4-a716-446655440001 │
  │ STAFF            │ staff@servora.local           │ 550e8400-e29b-41d4-a716-446655440002 │
  │ INACTIVE MANAGER │ inactive@servora.local        │ 550e8400-e29b-41d4-a716-446655440003 │
  └──────────────────┴───────────────────────────────┴──────────────────────────────────────┘

  Test JobCard:
    ID     : 660e8400-e29b-41d4-a716-446655440100
    Status : ACCEPTED (GENERAL_TASK)
    URL    : /jobs/660e8400-e29b-41d4-a716-446655440100
```

### 3. Sunucuları başlatın

**Terminal 1 — API sunucusu:**

```bash
cd server
npx tsx --env-file=.env src/index.ts
```

API `http://localhost:3000` adresinde başlar. Health check:

```bash
curl http://localhost:3000/api/health
# → {"status":"ok"}
```

**Terminal 2 — Vite dev sunucusu:**

```bash
cd web
npx vite --port 5173
```

Web `http://localhost:5173` adresinde başlar. Vite proxy'si `/api/*` isteklerini
otomatik olarak `http://127.0.0.1:3000` adresine yönlendirir.

---

## Sentetik Kullanıcı Matrisi

| Rol | Email | Aktif | Açıklama |
|-----|-------|-------|----------|
| ADMIN | admin@servora.local | ✅ | Sistem yöneticisi, tüm yetkiler |
| MANAGER | manager@servora.local | ✅ | Yönetici, onay yetkisi |
| STAFF | staff@servora.local | ✅ | Personel, JobCard atanmış |
| INACTIVE_MANAGER | inactive@servora.local | ❌ | Pasif yönetici (bildirim/bildirim dışlama testleri için) |

**Tüm kullanıcıların şifresi:** `TestPass12345!` (`.env` içinde `DEV_SEED_PASSWORD` ile değiştirilebilir)

**Test JobCard:**
- Staff kullanıcısına atanmış, ACCEPTED durumunda
- Not ekleme, workflow geçişleri ve realtime testleri için hazır

---

## Sık Kullanılan Komutlar

```bash
# Login (Manager)
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"manager@servora.local","password":"TestPass12345!"}'

# Not ekle (Manager, önce login olup cookie alın)
curl -s -X POST http://localhost:3000/api/job-cards/<JOB_ID>/notes \
  -H 'Content-Type: application/json' \
  -b /tmp/cookies.txt \
  -d '{"clientActionId":"test-1","note":"Test notu"}'

# Migration'ları tekrar çalıştır (seed sonrası gerekmez)
npx tsx --env-file=.env src/db/migrate.ts

# Testleri çalıştır
npm test -- --run
```

---

## Ortamı Sıfırlama

Geliştirme sırasında veritabanını sıfırlamak gerekirse, 2. adımı tekrar çalıştırın:

```bash
npx tsx --env-file=.env scripts/dev-runtime-setup.ts
```

Bu komut veritabanını siler, yeniden oluşturur ve seed eder. **Idempotent değildir** —
her çalıştırmada yeni UUID'ler üretilir.

---

## Web Push Testi için

Web Push senaryolarını test etmek için `.env` dosyasında şunları ekleyin:

```
WEB_PUSH_ENABLED=true
WEB_PUSH_VAPID_SUBJECT=mailto:test@servora.local
WEB_PUSH_VAPID_PUBLIC_KEY=<public-key>
WEB_PUSH_VAPID_PRIVATE_KEY=<private-key>
```

VAPID anahtarları oluşturmak için:
```bash
npx tsx -e "
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('Public:', keys.publicKey);
console.log('Private:', keys.privateKey);
"
```

---

## Port Yapılandırması

Varsayılan portlar:
- API: **3000** (`server/.env` → `PORT`)
- Web: **5173** (Vite varsayılanı)

Vite proxy yapılandırması `web/vite.config.ts` içinde:
```ts
proxy: {
  '/api': { target: 'http://127.0.0.1:3000' }
}
```

API portunu değiştirirseniz, Vite proxy target'ını da güncelleyin.
