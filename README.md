# Crawler Visibility MVP Starter

JavaScript tabanlı sayfaları Playwright ile render eden güvenli bir MVP başlangıç projesi.

> Bu sürüm üretim için hazır değildir. Detaylar için [SECURITY.md](SECURITY.md) dosyasına bakın.

## Kurulum

```bash
cp .env.example .env
# .env içindeki API_KEY değerini değiştir
npm install
npx playwright install chromium
```

## Sağlık kontrolü

```bash
npm run dev
curl http://localhost:3000/livez     # process ayakta mı
curl http://localhost:3000/readyz    # render isteği kabul edebilir mi
curl http://localhost:3000/health    # geriye dönük uyumluluk (deprecated, /livez ile aynı davranış)
```

Ayrıntılar için bkz. [OBSERVABILITY.md](OBSERVABILITY.md).

## Render isteği

```bash
curl -X POST http://localhost:3000/v1/render \
  -H 'content-type: application/json' \
  -H 'x-api-key: .env-dosyasindaki-anahtar' \
  -d '{"url":"https://example.com"}'
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
| `API_KEY` | — | Zorunlu. Minimum 8 karakter |

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

Development compose proxy veya sandbox zorlaması yapmaz.

### Hardened Docker

Hardened mod renderer'ı izole bir ağ arkasında egress proxy üzerinden çalıştırır.

```bash
export API_KEY="guclu-bir-api-anahtari-en-az-8-karakter"
sudo apparmor_parser -Kr docker/security/chromium-apparmor.profile
docker compose -f compose.hardened.yml up --build -d
```

> Ubuntu 23.10+/24.04+ host'larda Chromium'un sandbox'ı için `chromium-hardened` AppArmor profilinin önceden yüklenmesi gerekir — bkz. [SECURITY.md](SECURITY.md).

Mimari:

```
┌───────────────────────────────────────────┐
│         internal network (isolated)         │
│  ┌───────────┐      ┌──────────────┐       │
│  │ renderer  │ ───→ │ egress-proxy │ ───┼──→ Internet
│  │ (non-root)│      │   (Squid)    │       │   (external net)
│  └───────────┘      └──────────────┘       │
│   127.0.0.1:3000                            │
└───────────────────────────────────────────┘
```

- Renderer: non-root, read-only filesystem, sandbox Chromium, cap_drop ALL, seccomp + AppArmor profili, yalnızca `127.0.0.1:3000` üzerinden erişilebilir
- Egress proxy: Squid 6, yalnızca 80/443 portları, private IP ACL'leri, cache yok
- Renderer'ın doğrudan internet erişimi yok — yalnızca proxy üzerinden

### Container limitleri

| Servis | RAM | CPU | PID | tmpfs |
|--------|-----|-----|-----|-------|
| renderer-api | 2 GB | 2 | 200 | 512 MB (/tmp) + 64 MB (/home) |
| egress-proxy | 256 MB | 0.5 | 50 | 64 MB |

### Security smoke testleri

```bash
# Hardened stack çalışırken:
bash scripts/security-smoke.sh
```

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

### Test komutları

```bash
npm test              # Tüm testler (unit + integration)
npm run test:unit     # Yalnızca unit testleri
npm run test:integration  # Yalnızca integration testleri
```

### Test mimarisi

- **Unit testleri** (`test/*.test.ts`): URL güvenlik, route/API, kapasite, browser launch, metrics testleri. DNS mock kullanır, Chromium başlatmaz.
- **Integration testleri** (`test/integration/*.test.ts`): Gerçek Playwright Chromium ile render, E2E ve metrics testleri. Production SSRF kontrolünü kapatmak yerine özel test validator enjekte eder.

## Observability

Metrics, structured logging, `/livez` ve `/readyz` için bkz. [OBSERVABILITY.md](OBSERVABILITY.md).
