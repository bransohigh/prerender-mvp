# Observability

Bu doküman Phase 5'te eklenen metrics, structured logging ve health/readiness
davranışını açıklar. Kapsam dışı: Redis/BullMQ, PostgreSQL, kullanıcı paneli,
domain doğrulama, sitemap, ödeme, kalıcı cache, OpenTelemetry collector,
Prometheus server container.

## Health endpoint'leri

| Endpoint | Amaç | Kontrol ettikleri |
|----------|------|--------------------|
| `GET /livez` | Liveness — process ayakta mı | Hiçbir şey; yalnızca Fastify cevap veriyor mu. I/O, kapasite kontrolü veya browser etkileşimi yapmaz. |
| `GET /readyz` | Readiness — yeni render isteği kabul edilebilir mi | Capacity controller kapalı mı, uygulama shutdown sürecinde mi. Hazırsa `200 {"status":"ready"}`, değilse `503 {"status":"not_ready"}`. Chromium'un o anda açık olması gerekmez — lazy launch korunur. |
| `GET /health` | Geriye dönük uyumluluk | `/livez` ile aynı davranış. **Deprecated** — yeni entegrasyonlar `/livez` + `/readyz` kullanmalı. |

Docker healthcheck (`Dockerfile`, `compose.hardened.yml`) `/readyz` kullanır.

## Metrics

`GET /metrics` — Prometheus text format, `prom-client@15.1.3` (ayrı `Registry`,
global default registry'ye dokunulmaz).

**Erişim:**
- API key gerektirmez (network-level internal erişim varsayımıyla).
- `cache-control: no-store`.
- Rate limit'e tabi değil (bkz. aşağıdaki "Rate limit" bölümü).
- Uygulama seviyesinde bir private/loopback IP guard'ı var (`src/routes/metrics.ts`) — savunma katmanı. **Asıl sınır**: `renderer-api` yalnızca `127.0.0.1:3000`'e publish edilir (bkz. `compose.hardened.yml`), yani bu MVP'de public internet'ten zaten erişilemez. Bu repoda ayrı bir public gateway container'ı **yok**; ileride biri eklenirse `/metrics`'i o katmanda da açıkça bloklamalıdır (bkz. `docker/gateway/nginx.conf` — kullanılmayan ama hazır referans kural).
- Development'ta `curl http://localhost:3000/metrics` ile test edilebilir.

**Rate limit:** `/metrics`, `/livez`, `/readyz` global rate limit'ten (`30/dakika`)
muaftır (`config: { rateLimit: false }`). Bu endpoint'ler orkestratör/Prometheus
tarafından sık sık pollanır ve `/v1/render` çağıranlarla aynı bütçeyi paylaşmamalıdır.

### Metrik listesi

| Metrik | Tip | Label'lar | Açıklama |
|--------|-----|-----------|----------|
| `prerender_render_requests_total` | Counter | `result` | Render sonucu: `success`, `render_error`, `validation_error`, `queue_full`, `queue_timeout`, `capacity_closed`, `unauthorized`, `bad_request` |
| `prerender_render_duration_seconds` | Histogram | — | Render süresi (yalnızca browser render adımı) |
| `prerender_queue_wait_duration_seconds` | Histogram | — | Capacity controller'da bekleme süresi (kuyruğa hiç girmeyen task ~0 kaydeder) |
| `prerender_render_active` | Gauge | — | O an çalışan render sayısı |
| `prerender_render_queued` | Gauge | — | O an kuyrukta bekleyen render sayısı |
| `prerender_render_max_concurrent` | Gauge | — | Yapılandırılmış `MAX_CONCURRENT_RENDERS` |
| `prerender_render_max_queued` | Gauge | — | Yapılandırılmış `MAX_QUEUED_RENDERS` |
| `prerender_browser_launches_total` | Counter | — | Başarılı Chromium launch sayısı |
| `prerender_browser_disconnects_total` | Counter | — | Beklenmeyen disconnect sayısı (graceful `close()` hariç) |
| `prerender_browser_launch_failures_total` | Counter | — | Başarısız launch denemesi sayısı |
| `prerender_url_rejections_total` | Counter | `reason` | SSRF/güvenlik reddi nedeni: `protocol`, `credentials`, `hostname`, `port`, `private_ip`, `dns`, `redirect`, `resource`, `unknown` |

`collectDefaultMetrics` açık (Node.js process/event-loop/GC/heap metrikleri,
`prerender_` prefix'i ile). Ekstra runtime flag gerekmez (`--expose-gc` GC
histogramlarını zenginleştirir ama zorunlu değildir). Bu metrikler process
geneli sabit isimlerdir, per-request label içermez — cardinality riski yok.
Hassas environment bilgisi expose edilmez (yalnızca standart Node.js runtime
sayaçları).

**Asla label olarak kullanılmaz:** ham URL, hostname, domain, path, query
string, request ID, API key. `result` ve `reason` sabit, önceden tanımlı
literal union tipleridir (TypeScript seviyesinde de zorlanır) — çağıran
kod arbitrary string geçemez.

### Histogram bucket'ları

```
render_duration_seconds:      0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 20, 30
queue_wait_duration_seconds:  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 60
```

`render_duration_seconds` varsayılan 15s render timeout'una göre (max 60s)
kısa/uzun render'ları ayırt edecek şekilde seçildi. `queue_wait_duration_seconds`
varsayılan 10s queue timeout'una göre (max 120s) ölçeklendi.

### Prometheus scrape örneği

```yaml
scrape_configs:
  - job_name: prerender-renderer
    scrape_interval: 15s
    static_configs:
      - targets: ['renderer-api:3000']   # yalnızca internal Docker network'ten erişilebilir
    metrics_path: /metrics
```

**Önemli:** Bu metrikler **tek bir process'e** aittir — process-içi `RenderCapacityController`
ve tek bir Chromium browser instance'ı ile birebir eşleşir. Yatay ölçeklemede
(birden fazla renderer-api instance'ı) her instance ayrı ayrı scrape edilmelidir;
metrikler instance'lar arasında toplanmaz/paylaşılmaz. Bu MVP'de Prometheus
server container'ı yok — yalnızca `/metrics` endpoint'i mevcut.

### Metrics implementasyonu ve dependency injection

`src/lib/metrics.ts` küçük bir `Metrics` interface'i tanımlar
(`observeRenderDuration`, `observeQueueWait`, `incrementRenderResult`,
`setCapacitySnapshot`, `incrementBrowserLaunch`, `incrementBrowserDisconnect`,
`incrementBrowserLaunchFailure`, `incrementUrlRejection`, `getMetrics`,
`getContentType`, `reset`). Production kod `createMetrics()` (prom-client
tabanlı) kullanır; testler izole bir registry için tekrar `createMetrics()`
çağırabilir veya no-op `createNoopMetrics()` enjekte edebilir. Her çağrı
noktası (`render-capacity.ts`, `renderer.ts`, `browser-launch.ts`,
`routes/render.ts`) metrik çağrılarını `safeMetricsCall()` ile sarar —
enjekte edilen bir `Metrics` implementasyonu throw etse bile render isteği
etkilenmez.

## Structured logging

Fastify'nin yerleşik Pino logger'ı kullanılır (ek bir logging framework
eklenmedi). Her render isteğinde en az şu alanlar loglanır:

```
requestId, event, result, renderTimeMs, queueWaitMs, statusCode,
finalUrlOrigin, errorCode, activeRenders, queuedRenders
```

`queueWaitMs` başarılı render log satırında `totalTimeMs - renderTimeMs`
olarak hesaplanır — küçük context/page kurulum overhead'ini de içeren bir
yaklaşık değerdir. Tam kapasite-kuyruğu bekleme süresi ayrıca
`prerender_queue_wait_duration_seconds` histogram'ında (capacity
controller'ın kendi ölçtüğü, daha kesin değer) mevcuttur.

`event` değerleri: `render_completed`, `render_rejected`, `render_failed`.

### URL loglama politikası

Loglanan URL'ler **yalnızca** `protocol://hostname:port` biçimindedir
(`safeUrlOrigin()`, `src/lib/url-security.ts`). Path, query string, fragment
ve userinfo **asla** loglanmaz.

```
Örnek: https://example.com:443
```

### Asla loglanmayan alanlar

- API key
- `Authorization` header
- Cookie / `Set-Cookie`
- Tam HTML içerik
- Request body'nin tamamı
- URL username/password
- URL query string / fragment
- Kullanıcının verdiği tam URL (yalnızca origin özeti)
- Proxy credential

### Pino redact

```
req.headers.authorization
req.headers["x-api-key"]
req.headers.cookie
res.headers["set-cookie"]
req.headers["proxy-authorization"]
```

Not: Fastify'nin varsayılan `req`/`res` serializer'ı zaten header'ları
loglamaz (yalnızca `method`, `url` path'i, `host`, `remoteAddress` gibi
alanlar) — redact kuralları, ileride manuel olarak header logu eklenirse
diye ikinci bir savunma katmanıdır.

### Hata seviyeleri

- Beklenen validation/capacity hataları: `warn` veya `info`
- Beklenmeyen internal hatalar (`render_error`): `error` — pino'nun
  varsayılan error serializer'ı ile stack trace **yalnızca sunucu loguna**
  yazılır, HTTP response'a asla sızmaz (mevcut testler bunu doğrular).

## Request ID

Fastify'nin `genReqId` mekanizması özelleştirildi:

- Client'ın gönderdiği `x-request-id` yalnızca `^[a-zA-Z0-9_-]{1,64}$`
  desenine uyuyorsa kabul edilir; aksi halde sunucu `crypto.randomUUID()`
  ile yeni bir ID üretir (log injection / arbitrary uzun değer riski yok).
- Her response'a `x-request-id` header'ı eklenir.
- Hata response body'lerinde `requestId` alanı bulunur.
- Request ID **hiçbir Prometheus label'ında kullanılmaz** (yüksek cardinality
  riski).
- Request ID bir authentication mekanizması **değildir** — yalnızca log
  korelasyonu içindir.

## Browser lifecycle metrikleri

- Her başarılı `chromium.launch()` çağrısı `browser_launches_total`'ı artırır
  (launch *denemesi* değil, başarılı sonuç).
- Başarısız launch `browser_launch_failures_total`'ı artırır.
- `disconnected` event'i yalnızca **beklenmeyen** disconnect'te sayılır —
  `renderer.close()` çağrısı sırasında bir `closingIntentionally` flag'i
  set edilir, bu durumda disconnect sayaç artırılmaz. Browser singleton
  davranışı (lazy launch, tekrar kullanım) değişmedi.

## Docker / Nginx

`docker/gateway/nginx.conf` şu an **kullanılmıyor** (compose.hardened.yml'de
ayrı bir gateway servisi yok — Phase 4'te Docker'ın internal-only network'lerde
port publish edemediği tespit edilip kaldırıldı). Dosya, ileride bir public
gateway eklenirse referans olarak güncellendi: `/metrics` → 404, `/livez`
`/readyz` `/health` `/v1/render` → proxy_pass, bilinmeyen path → 404.

`compose.hardened.yml` ve `Dockerfile`'daki `HEALTHCHECK` artık `/readyz`
kullanıyor (önceden `/health`).

## Log rotation

Değişmedi: `json-file` driver, `max-size: 10m`, `max-file: 3`
(`compose.hardened.yml`). Structured loglar yalnızca stdout/stderr'e yazılır;
container içine log dosyası yazılmaz — read-only root filesystem davranışı
korunur.
