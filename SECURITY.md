# Güvenlik Durumu

Bu proje şu aşamada **production-ready değildir**. Aşağıda güvenlik katmanları, bilinen kısıtlamalar ve kalan riskler açıklanmaktadır.

## Threat Model

Renderer güvenilmeyen URL'leri Chromium ile ziyaret eder. Başlıca tehditler:

- **SSRF**: Renderer'ın iç ağ, metadata servisleri veya localhost'a erişmesi
- **DNS rebinding**: DNS çözümlemesi ile gerçek bağlantı arasında IP değişmesi
- **Resource exhaustion**: Kötü niyetli sayfaların CPU/RAM/disk tüketmesi
- **Container escape**: Chromium exploit'lerinin host'a ulaşması
- **Data leakage**: Render'lar arası cookie/storage sızıntısı

## Güvenlik Katmanları

### 1. Application URL Validation

`assertSafePublicUrl` fonksiyonu her URL için:
- Yalnızca `http:` ve `https:` protokollerine izin verir
- Yalnızca 80 (HTTP) ve 443 (HTTPS) portlarına izin verir
- Private/reserved IP aralıklarını reddeder (IPv4 + IPv6)
- IPv4-mapped IPv6 adreslerini IPv4'e normalize ederek kontrol eder
- Blocked hostname'leri (localhost, metadata, .local) reddeder
- Trailing dot hostname normalizasyonu yapar
- DNS çözümleme sonuçlarını IP düzeyinde doğrular
- Username/password içeren URL'leri reddeder

### 2. Browser Request Filtering

Playwright `context.route()` ile tüm alt kaynak istekleri tekrar URL doğrulamasından geçer. Navigasyon sonrası `page.url()` ile final URL doğrulanır. Media ve font kaynakları engellenir.

**Kısıtlama**: `context.route()` HTTP redirect zincirindeki her adımı bağlantı öncesinde güvenilir şekilde yakalayamayabilir. Bu kontrol TCP bağlantısı kurulduktan sonra çalışır.

### 3. Internal Renderer Network (Hardened Mode)

Hardened Docker compose'da renderer yalnızca `internal` Docker network'e bağlıdır. Bu network `internal: true` ile tanımlanmıştır — doğrudan dış internet erişimi yoktur.

### 4. Forced Outbound Proxy

Renderer'ın tüm outbound trafiği Squid egress proxy üzerinden geçer. Proxy:
- Yalnızca 80 ve 443 portlarına izin verir
- Private/reserved IP destination'larını reddeder (hem IPv4 hem IPv6)
- Metadata hostname'lerini reddeder
- Docker internal servis adlarını reddeder
- Cache yapmaz, SSL bump yapmaz
- Yalnızca HTTP CONNECT forward proxy olarak çalışır

### 5. Proxy Destination IP ACL

Proxy DNS çözümleme sonrası ulaşılan **gerçek destination IP** adresini kontrol eder. Bu, application-level DNS kontrolünden farklı bir zamanda çalışır ve SSRF/DNS rebinding için ek bir katman sağlar.

### 6. Container Sandbox ve Resource Limits

- **Non-root**: Renderer `pwuser` (UID 1000) olarak çalışır
- **Chromium sandbox**: Linux'ta `chromiumSandbox: true` ile user namespace sandbox aktif
- **Seccomp profili**: Docker'ın resmi varsayılan profili (moby/profiles) temel alınarak, Chromium'un unprivileged user-namespace sandbox'ı için gereken `clone3`/`unshare`/`setns`/`chroot` syscall'larına ek olarak izin verir. `seccomp=unconfined` veya `SYS_ADMIN`/`SYS_CHROOT` capability'si kullanılmaz — kernel, yeni namespace içindeki yetkileri syscall anında ayrıca doğrular.
- **AppArmor profili**: Ubuntu 23.10+/24.04+ üzerinde `kernel.apparmor_restrict_unprivileged_userns=1` sysctl'i, container'ların `userns,` kuralına sahip olmayan AppArmor profilleriyle unprivileged user namespace oluşturmasını engeller (Docker'ın `docker-default` profili bu kuralı içermez). `docker/security/chromium-apparmor.profile`, Docker'ın kendi `docker-default` şablonuna (moby/profiles) tek ek kural olarak `userns,` ekler; host'ta `apparmor_parser -Kr` ile yüklenip `security_opt: apparmor=chromium-hardened` ile referans alınır. `apparmor=unconfined` kullanılmaz.
- **Read-only filesystem**: Root filesystem read-only, yalnızca `/tmp` ve `/home/pwuser` tmpfs
- **cap_drop ALL**: Tüm Linux capabilities kaldırılır
- **no-new-privileges**: Privilege escalation engellenir
- **Resource limits**: CPU, RAM, PID, tmpfs boyutu sınırlıdır
- **init: true**: Zombie process temizliği
- **acceptDownloads: false**: Download engeli
- **serviceWorkers: block**: Service worker engeli
- **Ayrı browser context**: Her render izole context'te çalışır

## Kapasite Kontrolü

Process-içi kapasite kontrolü (`RenderCapacityController`) bir güvenlik sınırıdır ancak container CPU/RAM limitlerinin yerine geçmez:

- Bir process'in çökmesi durumunda memory queue kaybolur
- Production'da process ve container limitleri ayrıca uygulanmalıdır
- Bu kuyruk kalıcı iş kuyruğu değildir

## Test Ortamı

Integration testlerde kullanılan yerel test validator, production SSRF politikasının parçası değildir. Test validator yalnızca belirli bir test sunucusu origin'ine izin verir ve production kodunda aktif bir bypass oluşturmaz. Uygulama seviyesindeki testler, production ortamında gerekli olan egress firewall ve network policy gereksinimini ortadan kaldırmaz.

## Observability Güvenlik Kuralları

Ayrıntılar için bkz. [OBSERVABILITY.md](OBSERVABILITY.md).

- **`/metrics` public açılmamalı**: Bu repoda ayrı bir public gateway yok —
  `renderer-api` yalnızca `127.0.0.1:3000`'e publish edilir, dolayısıyla
  `/metrics` zaten internet'ten erişilemez. `src/routes/metrics.ts` içinde
  ayrıca bir private/loopback IP guard'ı vardır (savunma katmanı). İleride
  bir public gateway eklenirse, o katman `/metrics`'i açıkça bloklamalıdır
  (`docker/gateway/nginx.conf`'taki hazır kural kullanılabilir).
- **Prometheus label'larında URL, domain veya request ID kullanılmaz**:
  `prerender_url_rejections_total`'ın `reason` label'ı ve
  `prerender_render_requests_total`'ın `result` label'ı yalnızca sabit,
  önceden tanımlı literal değerler alır (TypeScript union tipleriyle
  zorlanır) — arbitrary/yüksek cardinality veri metric label'ı olamaz.
- **Loglarda query string, cookie, API key veya HTML bulunmaz**: URL'ler
  yalnızca `protocol://hostname:port` özeti olarak loglanır
  (`safeUrlOrigin()`). Pino redact kuralları `authorization`, `x-api-key`,
  `cookie`, `set-cookie` header'larını kapsar.
- **Log toplama sistemi ayrıca erişim kontrolü gerektirir**: Structured
  loglar stdout/stderr'e yazılır; bu repo bir log aggregation/erişim
  kontrolü çözümü içermez — üretimde loglara erişim ayrıca yetkilendirilmelidir.
- **Request ID bir authentication mekanizması değildir**: `x-request-id`
  yalnızca log korelasyonu içindir; client tarafından sağlanan değer katı
  bir formatla (`^[a-zA-Z0-9_-]{1,64}$`) sınırlanır ama kimlik doğrulama
  veya yetkilendirme amacıyla kullanılmamalıdır.

## Domain Sahipliği Threat Model

Ayrıntılar için bkz. [DOMAIN_VERIFICATION.md](DOMAIN_VERIFICATION.md) ve
[SITEMAP_SECURITY.md](SITEMAP_SECURITY.md).

- **Doğrulanmadan render/sitemap yapılamaz**: `POST /v1/render` ve
  `POST /v1/domains/:id/discover-sitemaps` / `POST /v1/sitemap-sources/:id/fetch`
  yalnızca `status=verified` domain'lerde çalışır — kod seviyesinde her iki
  yolda da açık kontrol vardır (`DOMAIN_NOT_VERIFIED` / 409).
- **Verification token asla plaintext saklanmaz**: Yalnızca SHA-256 hash
  saklanır; doğrulama sırasında DNS/HTTP'den bulunan aday token
  timing-safe olarak hash'e karşı karşılaştırılır. Token, oluşturma/rotate
  response'unda yalnızca bir kez gösterilir.
- **DNS doğrulama riskleri**: DNS spoofing/cache poisoning (nadir, resolver
  güvenilirliğine bağlı), DNS propagation gecikmesi (yanlış negatif sonuç
  verebilir — kullanıcı tekrar deneyebilir), stale/silinmiş TXT kaydına
  rağmen `verified` durumunun süresiz kalması (bkz. "Kalan Riskler").
- **HTML file doğrulama redirect kuralları**: Maksimum 2 redirect,
  cross-host redirect reddedilir, HTTP downgrade reddedilir, TLS
  doğrulaması asla kapatılmaz, response boyutu 8 KB ile sınırlıdır — bir
  saldırganın büyük/yanıltıcı bir yanıtla doğrulamayı manipüle etmesi
  engellenir.
- **Sitemap parser XXE/compression-bomb koruması**: `sax` streaming parser
  (entity expansion code path'i yok) + explicit DOCTYPE reddi + streaming
  gzip decompression ile sabit üst limit (50 MB) — bkz. SITEMAP_SECURITY.md.
- **Tenant isolation şu an yalnızca API key seviyesindedir**: Kullanıcı
  authentication/multi-tenant sistemi henüz yok (kapsam dışı — Phase 6).
  `ADMIN_API_KEY` sahibi TÜM proje/domain'lere erişebilir; gerçek
  multi-tenant izolasyon (kullanıcı bazlı yetkilendirme) sonraki bir
  aşamada eklenmelidir.
- **Domain re-verification politikası henüz yok**: Bir domain doğrulandıktan
  sonra süresiz `verified` kalır — DNS TXT kaydı silinse veya domain el
  değiştirse bile mevcut kod bunu tekrar kontrol etmez. Periyodik
  yeniden doğrulama (örn. günlük/haftalık cron) ileride eklenmelidir.
- **Database credential güvenliği**: `DATABASE_URL` API key'lerle aynı
  redact/log-hygiene kurallarına tabi değildir çünkü hiçbir zaman
  request-scope bir değer olarak loglanmaz (yalnızca `env.ts` içinde,
  process başlangıcında okunur). Yine de production'da bir secret manager
  ile yönetilmelidir — bkz. README.md "Secret yönetimi".

## Kalan Riskler

- **Application DNS ile proxy DNS farklı zamanlarda çalışır**: Nadir durumlarda tutarsız sonuç üretebilir
- **Proxy yanlış yapılandırılırsa koruma zayıflar**: Proxy ACL'lerinin doğru olduğu smoke test ile doğrulanmalıdır
- **Compose mimarisi Kubernetes NetworkPolicy veya cloud egress firewall yerine geçmez**
- **IPv6 proxy tarafında `dns_v4_first on` ile deprioritize edilmiştir**: Tamamen devre dışı bırakmak yerine IPv4 öncelikli çözümleme kullanılır
- **Chromium zero-day exploit'leri sandbox'ı aşabilir**: Defense in depth katmanları bunu zorlaştırır ancak garanti etmez
- **Domain re-verification periyodik olarak yapılmıyor** (yukarıya bakın)
- **Tenant isolation kullanıcı authentication'ı olmadan yalnızca API key seviyesindedir** (yukarıya bakın)
- **`src/lib/safe-http-client.ts`'in TLS/CONNECT-tunnel transport katmanı için otomatik network-level testi yok**: Redirect/downgrade/host-mismatch mantığı saf fonksiyonlara ayrılıp unit test edildi (`test/safe-http-client.test.ts`), ancak gerçek TLS handshake + proxy CONNECT tünel kodu yalnızca statik analiz + service-layer fake injection ile doğrulandı — self-signed sertifika altyapısı gerektiren gerçek bir network-level test eklenmedi.

## Production Deployment Checklist

- [ ] Container CPU/RAM limitleri iş yükü için optimize edildi
- [ ] Egress proxy ACL'leri smoke test ile doğrulandı
- [ ] `ADMIN_API_KEY` ve `RENDER_API_KEY` güçlü, ayrı ve gizli saklanıyor (secret manager)
- [ ] `POSTGRES_PASSWORD` güçlü ve gizli saklanıyor
- [ ] `DATABASE_URL` production connection string'i TLS ile yapılandırıldı (`sslmode=require` vb.)
- [ ] Database backup/restore stratejisi kuruldu (henüz eklenmedi)
- [ ] TLS termination (reverse proxy/load balancer) eklendi
- [ ] `trustProxy` ayarı proxy arkasında uygun yapılandırıldı
- [ ] Kubernetes NetworkPolicy veya cloud firewall ek katmanı
- [ ] Log aggregation ve monitoring
- [ ] Container image vulnerability scanning
- [ ] Seccomp profili hedef kernel ile test edildi
- [ ] Domain re-verification (periyodik) politikası kuruldu

## Sonraki Adımlar

- Kullanıcı authentication / multi-tenant sistemi
- Periyodik domain re-verification
- Container image vulnerability scanning
- Kubernetes NetworkPolicy entegrasyonu
- Content Security Policy sertleştirmesi
- OpenTelemetry collector / distributed tracing
- Redis + BullMQ tabanlı dağıtık kuyruk ve render cache (mevcut process-içi metrikler/kuyruk yatay ölçeklemede paylaşılmaz)
- Database backup/restore otomasyonu
