# Crawler Visibility MVP Starter

JavaScript tabanlı sayfaları Playwright ile render eden güvenli bir MVP başlangıç projesi.

> Bu sürüm üretim için hazır değildir. Detaylar için [SECURITY.md](SECURITY.md) dosyasına bakın.

## Kurulum

```bash
cp .env.example .env
# .env içindeki ADMIN_API_KEY, RENDER_API_KEY ve DATABASE_URL değerlerini güncelle
npm install
npx playwright install chromium
```

## PostgreSQL kurulumu

Drizzle ORM + `node-postgres` (`pg`) kullanılır. Migration dosyaları
repository içinde (`drizzle/`) tutulur; production'da otomatik schema push
**yapılmaz**.

```bash
# Development compose ile PostgreSQL de gelir:
docker compose up --build -d postgres

# veya yerel bir PostgreSQL instance'ına karşı:
npm run db:migrate
```

### Migration komutları

```bash
npm run db:generate   # Şema değişikliklerinden yeni migration dosyası üretir (development)
npm run db:migrate    # drizzle/ altındaki migration'ları çalıştırır (dev + CI + production)
npm run db:seed:dev   # Yalnızca NODE_ENV=development iken çalışan development seed (gerçek domain/secret içermez)
```

Uygulama başlarken migration'ı **otomatik çalıştırmaz** — ayrı bir adım
olarak (`npm run db:migrate` veya hardened compose'daki `migrate` servisi)
çalıştırılmalıdır.

## Sağlık kontrolü

```bash
npm run dev
curl http://localhost:3000/livez     # process ayakta mı (DB'den bağımsız)
curl http://localhost:3000/readyz    # render isteği kabul edebilir mi (capacity + database + proxy config)
curl http://localhost:3000/health    # geriye dönük uyumluluk (deprecated, /livez ile aynı davranış)
```

Ayrıntılar için bkz. [OBSERVABILITY.md](OBSERVABILITY.md).

## Project API

Admin endpoint'leri `x-admin-api-key` header'ı gerektirir.

```bash
curl -X POST http://localhost:3000/v1/projects \
  -H 'content-type: application/json' \
  -H 'x-admin-api-key: <ADMIN_API_KEY>' \
  -d '{"name":"Example Project","slug":"example-project"}'

curl http://localhost:3000/v1/projects?limit=20 \
  -H 'x-admin-api-key: <ADMIN_API_KEY>'

curl http://localhost:3000/v1/projects/:projectId \
  -H 'x-admin-api-key: <ADMIN_API_KEY>'

curl -X PATCH http://localhost:3000/v1/projects/:projectId \
  -H 'content-type: application/json' \
  -H 'x-admin-api-key: <ADMIN_API_KEY>' \
  -d '{"name":"Renamed"}'

# Soft delete — status=deleted olur, bağlı domain/URL'ler fiziksel silinmez
curl -X DELETE http://localhost:3000/v1/projects/:projectId \
  -H 'x-admin-api-key: <ADMIN_API_KEY>'
```

## Domain API

```bash
curl -X POST http://localhost:3000/v1/projects/:projectId/domains \
  -H 'content-type: application/json' \
  -H 'x-admin-api-key: <ADMIN_API_KEY>' \
  -d '{"hostname":"www.example.com","verificationMethod":"dns_txt"}'
```

Yanıt, doğrulama token'ını **yalnızca bu response'ta bir kez** içerir:

```json
{
  "domain": { "id": "...", "hostname": "www.example.com", "status": "pending" },
  "verification": {
    "method": "dns_txt",
    "recordName": "_prerender-verification.www.example.com",
    "recordType": "TXT",
    "recordValue": "prerender-verification=<token>",
    "token": "<token>"
  }
}
```

`GET` endpoint'leri (`/v1/projects/:id/domains`, `/v1/domains/:id`) token'ı
veya hash'ini **asla** döndürmez. Token'ı kaybettiyseniz:

```bash
curl -X POST http://localhost:3000/v1/domains/:domainId/rotate-verification-token \
  -H 'x-admin-api-key: <ADMIN_API_KEY>'
```

Doğrulama:

```bash
curl -X POST http://localhost:3000/v1/domains/:domainId/verify \
  -H 'x-admin-api-key: <ADMIN_API_KEY>'
```

Ayrıntılar için bkz. [DOMAIN_VERIFICATION.md](DOMAIN_VERIFICATION.md).

## Sitemap discovery/fetch

```bash
# Yalnızca verified domain'lerde çalışır (409 DOMAIN_NOT_VERIFIED aksi halde)
curl -X POST http://localhost:3000/v1/domains/:domainId/discover-sitemaps \
  -H 'x-admin-api-key: <ADMIN_API_KEY>'

curl -X POST http://localhost:3000/v1/sitemap-sources/:sourceId/fetch \
  -H 'x-admin-api-key: <ADMIN_API_KEY>'
```

Ayrıntılar için bkz. [SITEMAP_SECURITY.md](SITEMAP_SECURITY.md).

## Render isteği

Render artık yalnızca URL kabul etmez — doğrulanmış bir `domainId`
gerektirir ve `x-render-api-key` kullanır (`x-api-key` **artık kabul
edilmez**).

```bash
curl -X POST http://localhost:3000/v1/render \
  -H 'content-type: application/json' \
  -H 'x-render-api-key: <RENDER_API_KEY>' \
  -d '{"domainId":"<verified-domain-id>","url":"https://www.example.com/product/1"}'
```

## Yapılandırma

| Değişken | Varsayılan | Açıklama |
|----------|-----------|----------|
| `HOST` | `0.0.0.0` | Dinleme adresi |
| `PORT` | `3000` | Dinleme portu |
| `LOG_LEVEL` | `info` | Fastify log seviyesi |
| `RENDER_TIMEOUT_MS` | `15000` | Tek render için maksimum süre (ms) |
| `MAX_HTML_BYTES` | `5000000` | Render edilmiş HTML boyut limiti (byte) |
| `MAX_CONCURRENT_RENDERS` | `2` | Aynı anda çalışabilecek maksimum render sayısı |
| `MAX_QUEUED_RENDERS` | `20` | Sıraya alınabilecek maksimum bekleyen render sayısı |
| `RENDER_QUEUE_TIMEOUT_MS` | `10000` | Kuyrukta maksimum bekleme süresi (ms) |
| `OUTBOUND_PROXY_URL` | — | Egress proxy URL (hardened modda zorunlu) |
| `REQUIRE_OUTBOUND_PROXY` | `false` | `true` ise proxy olmadan başlamayı reddeder |
| `ADMIN_API_KEY` | — | Zorunlu. Minimum 32 karakter. Proje/domain/sitemap yönetim endpoint'leri için (`x-admin-api-key`) |
| `RENDER_API_KEY` | — | Zorunlu. Minimum 32 karakter. Yalnızca `POST /v1/render` için (`x-render-api-key`) |
| `DATABASE_URL` | — | Zorunlu. `postgres://` veya `postgresql://` connection string |

**Migration notu:** Eski tek `API_KEY` değişkeni kaldırıldı ve artık hiçbir
yerde okunmuyor. Yükseltirken hem `ADMIN_API_KEY` hem `RENDER_API_KEY`
ayarlanmalıdır.

### Kapasite ve kuyruk davranışı

Render istekleri process-içi FIFO kuyruğuyla yönetilir. Aynı anda en fazla `MAX_CONCURRENT_RENDERS` kadar render işlemi çalışır; fazlası sıraya alınır. Kuyruk `MAX_QUEUED_RENDERS` sınırına ulaşınca veya bir istek `RENDER_QUEUE_TIMEOUT_MS` süresini aşınca `503 Service Unavailable` ve `Retry-After` header'ı döner.

Bu kuyruk tek process içinde çalışır — yatay ölçeklemede instance'lar arasında paylaşılmaz. Redis/BullMQ tabanlı dağıtık kuyruk sonraki ölçek aşamasında değerlendirilecektir.

### Kaynak engelleme politikası

Render sırasında `font` ve `media` (audio/video) kaynakları engellenir. `image` kaynakları şu anda engellenmemektedir — bu politika gerçek kullanım ölçümleri sonrasında yeniden değerlendirilecektir. `script` ve `stylesheet` kaynakları yüklenir.

## Docker

### Development

```bash
cp .env.example .env
docker compose up --build
```

Development compose PostgreSQL servisini içerir (host'a `127.0.0.1:5432`
üzerinden publish edilir, yalnızca local development için). Proxy veya
sandbox zorlaması yapılmaz.

### Hardened Docker

Hardened mod renderer'ı izole bir ağ arkasında egress proxy üzerinden çalıştırır. PostgreSQL ayrı bir `database` network'ünde çalışır — host'a publish edilmez, egress-proxy bu network'e üye değildir, PostgreSQL'in dışarı internet erişimi yoktur.

```bash
export ADMIN_API_KEY="guclu-bir-admin-anahtari-en-az-32-karakter"
export RENDER_API_KEY="guclu-bir-render-anahtari-en-az-32-karakter"
export POSTGRES_PASSWORD="guclu-bir-postgres-sifresi"
sudo apparmor_parser -Kr docker/security/chromium-apparmor.profile

docker compose -f compose.hardened.yml up --build -d postgres
docker compose -f compose.hardened.yml run --rm migrate
docker compose -f compose.hardened.yml up --build -d renderer-api egress-proxy
```

> Ubuntu 23.10+/24.04+ host'larda Chromium'un sandbox'ı için `chromium-hardened` AppArmor profilinin önceden yüklenmesi gerekir — bkz. [SECURITY.md](SECURITY.md).

### Migration ve başlangıç sırası

1. PostgreSQL sağlıklı olana kadar bekle (`healthcheck`)
2. `migrate` one-shot servisini çalıştır — başarısız olursa renderer **başlamamalı**
3. `renderer-api` ve `egress-proxy` başlar
4. `/readyz` `200` döner

`migrate` servisi renderer-api ile **aynı image'ı** kullanır (farklı
`command`), root çalışmaz, `database` network'ü dışında hiçbir network'e
üye değildir.

Mimari:

```
┌──────────────────────────────────────────────────────────┐
│         internal network (isolated)                        │
│  ┌───────────┐      ┌──────────────┐                       │
│  │ renderer  │ ───→ │ egress-proxy │ ───────┼──→ Internet   │
│  │ (non-root)│      │   (Squid)    │           (external)   │
│  └─────┬─────┘      └──────────────┘                       │
│   127.0.0.1:3000                                            │
└────────┼─────────────────────────────────────────────────┘
         │  database network (renderer + migrate only)
    ┌────▼──────┐
    │ postgres  │   no host port, no external network access
    └───────────┘
```

- Renderer: non-root, read-only filesystem, sandbox Chromium, cap_drop ALL, seccomp + AppArmor profili, yalnızca `127.0.0.1:3000` üzerinden erişilebilir
- Egress proxy: Squid 6, yalnızca 80/443 portları, private IP ACL'leri, cache yok
- PostgreSQL: host'a publish edilmez, egress-proxy erişemez, internet erişimi yok
- Renderer'ın doğrudan internet erişimi yok — yalnızca proxy üzerinden

### Container limitleri

| Servis | RAM | CPU | PID | tmpfs |
|--------|-----|-----|-----|-------|
| renderer-api | 2 GB | 2 | 200 | 512 MB (/tmp) + 64 MB (/home) |
| egress-proxy | 256 MB | 0.5 | 50 | 64 MB |
| postgres | 512 MB | 1 | 100 | — |
| migrate | 256 MB | 0.5 | 50 | 32 MB (/tmp) |

### Security smoke testleri

```bash
# Hardened stack çalışırken:
ADMIN_API_KEY=... RENDER_API_KEY=... POSTGRES_PASSWORD=... bash scripts/security-smoke.sh
```

### Secret yönetimi

`compose.hardened.yml` hiçbir secret'ı plaintext içermez — `POSTGRES_PASSWORD`,
`ADMIN_API_KEY`, `RENDER_API_KEY` ortam değişkeni olarak sağlanmalıdır
(`${VAR:?...}` sözdizimi, değişken yoksa compose'un başlamayı reddetmesini
sağlar). CI, her run için geçici/rastgele üretilmiş credential kullanır.
**Production'da gerçek bir secret manager (AWS Secrets Manager, Vault, vb.)
kullanılmalıdır** — bu repo bir secret manager entegrasyonu içermez.

### Database backup

**Henüz eklenmedi.** Bu MVP aşamasında otomatik yedekleme yoktur —
production kullanımından önce eklenmelidir.

### Playwright ve Docker image sürüm eşleşmesi

Playwright npm paketi ve Docker base image sürümü birebir eşleşmelidir. Güncelleme yaparken her ikisini birlikte güncelleyin:

1. `package.json` içindeki `playwright` sürümünü güncelleyin
2. `Dockerfile` içindeki `mcr.microsoft.com/playwright:v{VERSION}-noble` sürümünü güncelleyin
3. `npm install && npx playwright install chromium` çalıştırın
4. Tüm testleri çalıştırın

Mevcut sürüm: **Playwright 1.61.1**

### Hardened mode notları

- Reverse proxy/TLS sonraki deployment katmanıdır
- Hardened compose tam production platformu değildir — Kubernetes/cloud firewall katmanı önerilir
- `REQUIRE_OUTBOUND_PROXY=true` proxy olmadan başlamayı reddeder

## Testler

### Gereksinimler

Integration testleri gerçek Chromium browser açar:

```bash
npx playwright install chromium
```

Database integration testleri gerçek PostgreSQL gerektirir (migrasyonlu):

```bash
npm run db:migrate
npm run test:db
```

### Test komutları

```bash
npm test                  # Unit + integration (PostgreSQL gerektirmez)
npm run test:unit         # Yalnızca unit testleri
npm run test:integration  # Yalnızca integration testleri (gerçek Chromium)
npm run test:db           # Yalnızca database integration testleri (gerçek PostgreSQL gerektirir)
```

### Test mimarisi

- **Unit testleri** (`test/*.test.ts`): URL/domain normalizasyon, verification token, DNS parsing, robots/sitemap XML parsing, repository davranışları (fake in-memory implementasyonlarla), route/API, kapasite, browser launch, metrics testleri. Gerçek PostgreSQL veya network gerektirmez.
- **Integration testleri** (`test/integration/*.test.ts`): Gerçek Playwright Chromium ile render, E2E ve metrics testleri. Production SSRF kontrolünü kapatmak yerine özel test validator enjekte eder.
- **Database testleri** (`test/db/*.test.ts`): Gerçek PostgreSQL üzerinde migration, CRUD, foreign key, unique constraint, transaction rollback, concurrent duplicate create senaryoları. CI'da PostgreSQL service container kullanılır.

## Observability

Metrics, structured logging, `/livez` ve `/readyz` için bkz. [OBSERVABILITY.md](OBSERVABILITY.md).
