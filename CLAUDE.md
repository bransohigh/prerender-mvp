# Crawler Visibility MVP — Claude Code Talimatları

## Ürün amacı
JavaScript ile üretilen web sayfalarını güvenli biçimde render edip botlara sunulabilecek HTML çıktısı oluşturan bir SaaS çekirdeği geliştirmek.

## İlk kilometre taşı
Tek domain ve düşük trafik için çalışan, güvenli bir `POST /v1/render` servisi.

## Değişmez kurallar
1. TypeScript strict mode kapatılmayacak.
2. Kullanıcı tarafından verilen URL doğrudan Chromium'a gönderilmeyecek; her ana istek ve alt kaynak SSRF kontrolünden geçecek.
3. `localhost`, private IP, link-local, metadata servisleri ve desteklenmeyen protokoller bloklanacak.
4. Her render ayrı browser context içinde çalışacak.
5. Render süresi, HTML boyutu ve kaynak tüketimi sınırlandırılacak.
6. Güvenlik kontrolü zayıflatılmadan önce açık gerekçe ve test yazılacak.
7. Her görev sonunda sırasıyla `npm run typecheck`, `npm test`, `npm run build` çalıştırılacak.
8. Test geçmeden görev tamamlandı denmeyecek.
9. Büyük refactor yerine küçük ve doğrulanabilir commit boyutları tercih edilecek.
10. Kullanıcı onayı olmadan ödeme, gerçek production deploy veya veri silme işlemi yapılmayacak.

## Mimari yön
- API: Fastify + TypeScript
- Renderer: Playwright Chromium
- Validation: Zod
- Kuyruk: sonraki aşamada Redis + BullMQ
- Veritabanı: sonraki aşamada PostgreSQL + Drizzle
- Cache/storage: sonraki aşamada Redis + R2/S3

## Şu anda yapılmaması gerekenler
- SaaS dashboard
- Üyelik ve ödeme
- Çoklu tenant
- Otomatik bot proxy
- Sitemap crawler
- Dağıtık worker mimarisi

Önce render çekirdeğinin güvenliği, doğruluğu ve ölçümleri kanıtlanacak.
