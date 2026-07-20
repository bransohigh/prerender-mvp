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

## Kalan Riskler

- **Application DNS ile proxy DNS farklı zamanlarda çalışır**: Nadir durumlarda tutarsız sonuç üretebilir
- **Proxy yanlış yapılandırılırsa koruma zayıflar**: Proxy ACL'lerinin doğru olduğu smoke test ile doğrulanmalıdır
- **Compose mimarisi Kubernetes NetworkPolicy veya cloud egress firewall yerine geçmez**
- **IPv6 proxy tarafında `dns_v4_first on` ile deprioritize edilmiştir**: Tamamen devre dışı bırakmak yerine IPv4 öncelikli çözümleme kullanılır
- **Chromium zero-day exploit'leri sandbox'ı aşabilir**: Defense in depth katmanları bunu zorlaştırır ancak garanti etmez
- **Domain sahipliği doğrulaması henüz yok**

## Production Deployment Checklist

- [ ] Container CPU/RAM limitleri iş yükü için optimize edildi
- [ ] Egress proxy ACL'leri smoke test ile doğrulandı
- [ ] API key güçlü ve gizli saklanıyor
- [ ] TLS termination (reverse proxy/load balancer) eklendi
- [ ] `trustProxy` ayarı proxy arkasında uygun yapılandırıldı
- [ ] Kubernetes NetworkPolicy veya cloud firewall ek katmanı
- [ ] Log aggregation ve monitoring
- [ ] Container image vulnerability scanning
- [ ] Seccomp profili hedef kernel ile test edildi

## Sonraki Adımlar

- Domain sahipliği doğrulaması
- Container image vulnerability scanning
- Kubernetes NetworkPolicy entegrasyonu
- Content Security Policy sertleştirmesi
- Metrics ve observability
