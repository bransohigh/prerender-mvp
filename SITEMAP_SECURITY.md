# Sitemap Discovery & Fetch Security

## Kapsam

Sitemap keşfi ve fetch işlemleri **yalnızca `verified` durumundaki
domain'lerde** çalışır. `pending`/`failed`/`suspended` domain'lerde
`DOMAIN_NOT_VERIFIED` (409) döner.

## Discovery (`POST /v1/domains/:domainId/discover-sitemaps`)

Sıra:
1. `https://<hostname>/robots.txt` — `Sitemap:` direktifleri (case-insensitive,
   yorum satırları ve fazladan boşluk güvenli şekilde atlanır)
2. `https://<hostname>/sitemap.xml` (varsayılan konum)
3. `https://<hostname>/sitemap_index.xml` (varsayılan konum)

Kurallar:
- robots.txt'ten yalnızca `Sitemap:` satırları okunur — `Disallow`/`Allow`/
  `User-agent` gibi diğer direktifler **yorumlanmaz/uygulanmaz**.
- Keşfedilen her URL `normalizeTargetUrl()` ile doğrulanır: HTTPS zorunlu,
  aynı normalized hostname zorunlu, port 443, credentials yok, fragment yok.
- Domain dışı (farklı hostname) sitemap URL'leri **sessizce atlanır**
  (hata fırlatılmaz — robots.txt üçüncü taraf/yanlış yapılandırılmış
  olabilir).
- Maksimum keşfedilecek kaynak sayısı: 20.
- Duplicate normalized URL'ler tekilleştirilir (aynı domain+URL için tek
  `sitemap_sources` satırı, `onConflictDoUpdate`).

## Fetch & Parse (`POST /v1/sitemap-sources/:sourceId/fetch`)

### XML parsing — XXE ve DTD koruması

- `sax` (streaming, strict mode) kullanılır — DOM tabanlı bir parser değil,
  **entity expansion/resolution code path'i hiç yok**. XXE saldırı yüzeyi
  yapısal olarak yoktur.
- Ek savunma katmanı: herhangi bir `<!DOCTYPE ...>` bulunursa parse
  **derhal reddedilir** (`dtd_rejected`), entity'lerin çözümlenip
  çözünmediğine bakılmaksızın.
- Tüm sitemap dosyası sınırsız şekilde memory'ye alınmaz — parser
  streaming çalışır ve `maxUrls` limitine ulaşınca event işlemeyi durdurur
  (`truncated: true`).

### Gzip / compression bomb koruması

- Response `content-encoding: gzip`, `.gz` uzantısı veya gzip magic
  byte'ları (`0x1f 0x8b`) ile tespit edilir.
- `zlib.createGunzip()` **streaming** olarak decompress edilir; çıktı
  byte sayısı sürekli izlenir ve `maxDecompressedBytes` (50 MB) aşılır
  aşılmaz decompression **anında durdurulur** — tüm dosyanın açılmasını
  beklemez. Bu, decompression-bomb saldırılarına karşı asıl savunmadır.

### Limitler (`SITEMAP_FETCH_LIMITS`)

| Limit | Değer |
|-------|-------|
| Maksimum ham response boyutu | 20 MB |
| Maksimum decompressed boyut | 50 MB |
| Sitemap başına maksimum URL | 50.000 (sitemaps.org standardı) |
| Domain başına toplam URL limiti | 200.000 |
| Sitemap index recursion derinliği | 3 |
| Index başına maksimum nested sitemap | 500 |
| Fetch timeout | 15 saniye |
| Maksimum redirect | 2 |

Limit aşımı `SITEMAP_LIMIT_EXCEEDED` (422) döner.

### Network güvenliği

- Browser kullanılmaz — küçük bir Node core HTTP client (`safeFetch`,
  `src/lib/safe-http-client.ts`).
- Egress proxy (varsa) kullanılır — `OUTBOUND_PROXY_URL` üzerinden CONNECT
  tunnel.
- HTTPS zorunlu, aynı hostname zorunlu (redirect dahil — cross-host
  redirect `redirect_host_mismatch` ile reddedilir).
- Her hop'ta `assertSafePublicUrl` (mevcut SSRF/private-IP kontrolü)
  çalışır.
- TLS doğrulaması asla kapatılmaz.

### URL normalizasyonu

Parse edilen her `<loc>` değeri, discovered_urls'e kaydedilmeden önce
`normalizeTargetUrl()` ile yeniden doğrulanır:
- Domain dışı veya credential/fragment içeren URL'ler **atlanır** (sessizce,
  tüm fetch işlemini başarısız kılmaz)
- Query string korunur, sırası değiştirilmez (tracking parametreleri bu
  aşamada silinmez)
- Percent-encoding çift decode edilmez
- Hash fragment kaldırılır, default port (443) normalize edilir

### Idempotency

- `discovered_urls` tablosunda `(domain_id, normalized_url)` unique
  constraint'i vardır — tekrarlanan fetch'ler upsert yapar (yeni satır
  oluşturmaz), `lastDiscoveredAt` güncellenir.
- `upsertMany` tek bir transaction içinde çalışır — kısmi başarı/rollback
  senaryoları test edilmiştir (bkz. `test/db/sitemaps-and-urls.test.ts`).

## Metrikler

`prerender_sitemap_fetch_total{type,result}`,
`prerender_sitemap_fetch_duration_seconds`,
`prerender_sitemap_urls_discovered_total` — bkz. OBSERVABILITY.md.
Sitemap URL'leri veya domain hostname'i hiçbir metric label'ında
kullanılmaz.
