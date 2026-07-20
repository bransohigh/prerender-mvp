# MVP Yol Haritası

## Milestone 0 — Çalışan çekirdek
- [x] Fastify API
- [x] API key kontrolü
- [x] Playwright renderer
- [x] İlk SSRF kontrolü
- [x] Timeout ve HTML boyutu sınırı
- [x] Docker başlangıç yapısı
- [x] Temel testler

## Milestone 1 — Güvenlik sertleştirmesi
- [ ] Redirect zincirindeki her hedefi doğrula
- [ ] DNS rebinding karşıtı bağlantı politikası
- [ ] IPv4-mapped IPv6 kontrolü
- [ ] İzin verilen port politikası
- [ ] Response indirme/boyut limitleri
- [ ] WebSocket ve service worker bloklama testleri
- [ ] Container network egress politikası

## Milestone 2 — Render doğruluğu
- [ ] `networkidle` yerine ayarlanabilir bekleme stratejileri
- [ ] Meta, canonical, robots, H1, JSON-LD çıktıları
- [ ] Ekran görüntüsü ve render logları
- [ ] Kullanıcı HTML’i ile rendered HTML karşılaştırması
- [ ] Başarısız istek ve console error raporu

## Milestone 3 — Queue ve cache
- [ ] Redis + BullMQ
- [ ] URL deduplication
- [ ] Retry ve dead-letter queue
- [ ] Cache TTL ve purge
- [ ] Render hash ve değişiklik algılama

## Milestone 4 — SaaS temeli
- [ ] PostgreSQL
- [ ] Kullanıcı ve proje modeli
- [ ] Domain doğrulama
- [ ] Sitemap keşfi
- [ ] Kullanım sayacı ve kota

## Milestone 5 — Entegrasyon
- [ ] Cloudflare Worker
- [ ] Nginx middleware
- [ ] Apache/PHP middleware
- [ ] Bot doğrulama ve user-agent politikası
