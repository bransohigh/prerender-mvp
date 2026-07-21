# Domain Verification

## Amaç

Bir domain için render/sitemap işlemi yapılabilmesi için, o domain'in
gerçek sahibi olduğunuzu kanıtlamanız gerekir. Doğrulanmamış (`pending`,
`failed`, `suspended`) domain'lerde render veya sitemap keşfi **yapılamaz**.

## Token üretimi ve saklama

- `POST /v1/projects/:projectId/domains` çağrıldığında, sunucu
  `crypto.randomBytes(32)` ile 256-bit (64 hex karakter) kriptografik
  rastgele bir token üretir.
- Token'ın **yalnızca SHA-256 hash'i** veritabanında saklanır
  (`verification_token_hash` sütunu). Plaintext token hiçbir zaman
  diske/veritabanına yazılmaz.
- Plaintext token, oluşturma (`POST .../domains`) ve rotasyon
  (`POST /v1/domains/:id/rotate-verification-token`) response'larında
  **yalnızca bir kez** gösterilir. Sonrasında hiçbir endpoint token'ı veya
  hash'ini geri döndürmez.
- Doğrulama sırasında, DNS TXT değerinden veya HTML dosya içeriğinden
  çıkarılan aday token, `timingSafeEqual` ile stored hash'e karşı
  karşılaştırılır (`verifyTokenAgainstHash`) — plaintext token hiçbir zaman
  tekrar üretilmesi/saklanması gerekmez.

## DNS TXT doğrulama

```
_prerender-verification.<normalizedHostname>  TXT  "prerender-verification=<token>"
```

- Node.js `dns.resolveTxt()` kullanılır — hiçbir HTTP isteği yapılmaz.
- Birden fazla TXT record segment'i (`string[]`) birleştirilip
  karşılaştırılır.
- Birden fazla TXT record'dan herhangi biri eşleşirse doğrulama başarılı
  sayılır.
- Karşılaştırma **case-sensitive** ve **exact match**'tir (substring match
  yapılmaz).
- Hata kodları: `dns_nxdomain` (ENOTFOUND/ENODATA), `dns_timeout`
  (EAI_AGAIN/timeout), `dns_servfail`, `dns_not_found` (record var ama
  eşleşmiyor), `dns_error` (diğer).
- Apex (`example.com`) ve `www.example.com` **ayrı domain kayıtları**
  olarak ele alınır — biri doğrulanınca diğeri otomatik doğrulanmaz.

## HTML file doğrulama

```
https://<normalizedHostname>/.well-known/prerender-verification.txt
```

- İstek hedefi **sabit** — kullanıcı arbitrary bir URL veremez.
- HTTPS zorunlu, yalnızca port 443, mevcut SSRF/public-URL kontrolü
  (`assertSafePublicUrl`) her hop'ta çalışır.
- Egress proxy (varsa) kullanılır — üretimde doğrudan internet bypass'ı
  yoktur.
- Maksimum redirect: 2. Redirect başka hostname'e giderse reddedilir.
  HTTP'ye downgrade reddedilir.
- Maksimum response boyutu: 8 KB (doğrulama dosyası tek satırlık olmalı).
- `content-type: text/plain` tercih edilir; farklı content-type
  `html_unexpected_content_type` ile reddedilir.
- TLS doğrulaması **asla** kapatılmaz (`rejectUnauthorized` varsayılan
  `true`).
- Cookie kabul edilmez/saklanmaz (Node'un `https` client'ı zaten
  otomatik cookie yönetimi yapmaz).
- Küçük bir HTTP client kullanılır (Node core `https`/`net`/`tls` —
  browser kullanılmaz).

## Rate limit ve concurrency

- `POST /v1/domains/:id/verify`, domain başına **dakikada 3 deneme**
  ile sınırlıdır (process-içi, `createVerificationRateLimiter`).
- Aynı domain için eş zamanlı verify çağrıları `DOMAIN_VERIFICATION_IN_PROGRESS`
  ile reddedilir (single-flight, `createInFlightGuard`) — hem
  brute-force hem de gereksiz outbound istek fan-out'unu engeller.

## Durum geçişleri

| Durum | Anlamı |
|-------|--------|
| `pending` | Oluşturuldu, henüz doğrulanmadı veya token rotate edildi |
| `verified` | Doğrulama başarılı |
| `failed` | Son doğrulama denemesi başarısız (tekrar denenebilir) |
| `suspended` | Manuel olarak askıya alındı — hostname başka bir domain kaydı için serbest kalır |

- Başarılı doğrulama: `status=verified`, `verifiedAt` set edilir,
  `verificationFailureCount` sıfırlanır.
- Başarısız doğrulama: `status=failed` (zaten `verified` ise durum
  korunur), `lastVerificationAttemptAt` güncellenir,
  `verificationFailureCount` artırılır.
- Token rotate edilirse: `verified` domain `pending`'e döner,
  `verifiedAt` temizlenir.

## Yeniden doğrulama politikası (henüz eklenmedi)

Bu MVP'de domain bir kez doğrulandıktan sonra süresiz `verified` kalır.
Periyodik yeniden doğrulama (DNS TXT kaydının silinip silinmediğini
kontrol etme) **henüz eklenmedi** — bkz. SECURITY.md "Kalan Riskler".
