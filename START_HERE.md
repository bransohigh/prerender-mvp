# Buradan Başla

## 1. Projeyi aç

```bash
cd prerender-mvp-starter
cp .env.example .env
```

`.env` içerisindeki `API_KEY=change-me` değerini uzun ve rastgele bir anahtarla değiştir.

## 2. Bağımlılıkları kur

```bash
npm install
npx playwright install chromium
```

Linux sunucuda ek sistem bağımlılıkları gerekiyorsa:

```bash
npx playwright install --with-deps chromium
```

## 3. İlk kontroller

```bash
npm run typecheck
npm test
npm run build
npm run dev
```

Başka terminalde:

```bash
curl http://localhost:3000/health
```

Render testi:

```bash
curl -X POST http://localhost:3000/v1/render \
  -H 'content-type: application/json' \
  -H 'x-api-key: .env-dosyasindaki-anahtar' \
  -d '{"url":"https://example.com"}'
```

## 4. Claude Code'u başlat

Proje klasörünün içindeyken:

```bash
claude
```

Ardından şu görevi ver:

```text
Önce repodaki README.md, START_HERE.md, CLAUDE.md ve docs/MVP_ROADMAP.md dosyalarını oku.
Mevcut kodu değiştirmeden önce mimari ve güvenlik incelemesi yap.
Özellikle SSRF, DNS rebinding, redirect, IPv4-mapped IPv6, port kontrolü, alt kaynak istekleri ve Chromium izolasyonu açıklarını değerlendir.

Sonra Milestone 1'in yalnızca şu üç maddesini küçük ve test edilebilir değişikliklerle uygula:
1. IPv4-mapped IPv6 adreslerini doğru şekilde sınıflandır ve private IPv4 adreslerinin bu formatla aşılmasını engelle.
2. Yalnızca yapılandırılmış portlara izin veren bir URL port politikası ekle. Varsayılan olarak HTTP 80 ve HTTPS 443 kabul edilsin.
3. Ana sayfa ve tüm redirect hedefleri için güvenlik doğrulamasını testlerle güvenceye al.

Her güvenlik düzeltmesi için pozitif ve negatif test yaz.
TypeScript strict modunu koru.
İşlem sonunda npm run typecheck, npm test ve npm run build çalıştır.
Komutlardan biri başarısızsa görevi tamamlandı sayma; hatayı düzelt veya açıkça raporla.
Henüz panel, üyelik, ödeme, veritabanı veya Redis ekleme.
```
