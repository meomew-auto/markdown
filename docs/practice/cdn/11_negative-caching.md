# Case 11: Negative Caching

> **Case ID:** `cdn-11-negative-caching`
> **Script:** `11-negative-caching.js`
> **Layer:** CDN / Varnish
> **Proof:** expected 404 is cached briefly, expires correctly, protects origin from repeated invalid requests

## 1. Tinh huong thuc te

### Ke tan cong va may khach buggy

Mot ke tan cong — hoac don gian la mot con bot crawl bi cau hinh sai, mot client SDK bi
loop retry, hay mot trinh duyet cu cua nguoi dung lien tuc goi lai URL bi hong — bat dau
bom request den nhung product ID khong ton tai:

```text
GET /api/products/9999999 -> 404
GET /api/products/9999999 -> 404  (lai)
GET /api/products/9999999 -> 404  (lai nua)
GET /api/products/8888888 -> 404  (ID khac cung khong ton tai)
GET /api/products/8888888 -> 404  (lai)
... 10,000 requests nua cho hang nghin ID khong ton tai khac
```

Tuong tuong 10,000 requests, 10,000 product IDs khac nhau, tat ca deu 404.
Khong mot request nao co san pham thuc su. Khong mot request nao dem lai doanh thu.

### Dieu gi xay ra neu KHONG CO negative caching?

```text
Client                CDN/Varnish              Origin (App + DB)
  |                      |                         |
  |--- GET /prd/9999 -->|                         |
  |                      |--- GET /prd/9999 ------>|
  |                      |                         |--- SELECT * FROM products WHERE id=9999
  |                      |                         |--- DB tra ve: 0 rows (not found)
  |                      |                         |--- App logic: kiem tra cache, check cache
  |                      |                         |          warmer, validate input, build
  |                      |                         |          response body, log, metrics
  |                      |<--- 404 JSON -----------|
  |<--- 404 MISS -------|                         |
  |                      |                         |
  |--- GET /prd/9999 -->|  (lai, request thu 2)   |
  |                      |--- GET /prd/9999 ------>|  <-- LAI VAO ORIGIN!
  |                      |                         |--- LAI SELECT * FROM products...
  |                      |                         |--- LAI 0 rows
  |                      |                         |--- LAI toan bo pipeline xu ly
  |                      |<--- 404 JSON -----------|
  |<--- 404 MISS -------|                         |
  |                      |                         |
  |--- GET /prd/8888 -->|  (ID khac, cung loi)    |
  |                      |--- GET /prd/8888 ------>|  <-- VAO ORIGIN LAN NUA!
  |                      |                         |--- LAI SELECT... LAI 0 rows...
```

**Moi request 404 deu MISS va di thang toi origin.** Origin phai:

```text
1. Nhan HTTP request tu Varnish
2. Parse URL, extract product ID
3. Validate input (ID co hop le khong?)
4. Query database: SELECT * FROM products WHERE id = ?
5. Database scan index, tra ve 0 rows
6. App tao JSON response body: { "success": false, "error": "not found" }
7. Serialize JSON
8. Gui response ve Varnish
9. Ghi log
10. Emit metrics
```

Moi buoc tren tieu ton CPU, memory, database connection, I/O. Voi 10,000 request
404, origin tieu ton **tai nguyen nhu phuc vu 10,000 request 200** — nhung gia tri
kinh doanh mang lai **bang 0**.

### Hậu quả cụ thể của việc không negative-cache

```text
Tình huống thực tế: 3h sáng, bot Google indexing crawl site của bạn.
Bot follow broken links cũ -> 50,000 requests 404 trong 10 phút.

Không có negative caching:
  -> 50,000 request 404 đến origin
  -> DB bị 50,000 query SELECT vô ích
  -> Connection pool cạn kiệt -> request 200 bắt đầu chậm
  -> Real users đang browse sản phẩm bị ảnh hưởng
  -> P50 latency của product detail từ 50ms -> 800ms
  -> Alert: "product service latency spike"
  -> On-call engineer bị đánh thức lúc 3h sáng
  -> Root cause: bot crawl broken links — không phải lỗi hệ thống

Có negative caching (404 được cache 15s):
  -> Request 1: 404 MISS -> origin (1 hit)
  -> Request 2-5000 (cùng URL, trong 15s): 404 HIT từ cache
  -> Tổng origin hits: ~1 (cho mỗi URL duy nhất, không phải mỗi request)
  -> Nếu bot gọi 100 URL khác nhau: 100 origin hits — vẫn ít hơn 50,000
  -> Origin DB không bị ảnh hưởng
  -> Real users không bị chậm
  -> On-call engineer ngủ ngon
```

### Negative caching là CƠ CHẾ PHÒNG THỦ

Khác với positive caching (cache 200 để tăng tốc độ), negative caching là **lá chắn**:

```text
POSITIVE CACHING                     NEGATIVE CACHING
─────────────────────────────────    ─────────────────────────────────
Mục đích: Performance                Mục đích: Defense
Cache 200 OK để serve nhanh hơn      Cache 404 để origin không bị
                                     spam bởi request rác

Ai hưởng lợi: End user               Ai hưởng lợi: Origin server
(thấy trang nhanh hơn)               (không bị quá tải bởi traffic vô ích)

Nếu không có: Web chậm               Nếu không có: Origin bị DDoS
                                     bởi chính traffic bình thường
```

Negative caching là **CDN đứng ra hứng chịu impact của traffic xấu/lỗi** thay cho
origin. CDN nói: "404 này tao đã thấy rồi, tao sẽ trả lời thay mày trong X giây,
đừng làm phiền origin nữa."

### Phan biet cac nguon goc cua 404 traffic

404 requests co the den tu nhieu nguon khac nhau, va moi nguon co anh huong
khac nhau den origin:

```text
NGUON 404                    TAN SUAT        ANH HUONG DEN ORIGIN
───────────────────────────  ──────────────  ──────────────────────────
Broken internal links        Thap - Trung    Tuong doi thap
(app link sai)                               (chi user click moi bi)

Old external links           Trung - Cao     Cao
(SEO backlink cu)                            (Google bot crawl lien tuc)

Bot scanning / crawling      Cao             Rat cao
(Googlebot, Ahrefs, ...)                     (50k+ requests/ngay)

Malicious scanning           Khong doan      RAT CAO
(DDoS, vulnerability probe)  truoc duoc      (Co the la tan cong thuc su)

Client retry loop            Dot bien        Cao dot bien
(SDK bug, network error)                     (Co the 10k requests/s)

Deleted product IDs          Vua phai        Vua phai
(business-as-usual)                          (Traffic tu user that)
```

Neu khong co negative caching, TAT CA cac nguon nay deu bi origin xu ly nhu nhau.
Origin khong the phan biet "request nay la tu user that click broken link" hay
"request nay la tu bot tan cong".

### "Expected 404" — không phải 404 nào cũng là lỗi

Một khái niệm quan trọng trong negative caching: **expected 404**.

```text
UNEXPECTED 404 (không nên cache):
  /api/products/this-is-not-an-id  -> 404 vì URL sai format
  /api/products/../../etc/passwd   -> 404 vì path traversal
  Các trường hợp này có thể là attack probe, rate-limit thì tốt hơn cache

EXPECTED 404 (NÊN cache):
  /api/products/12345              -> product ID hợp lệ, nhưng không tồn tại
  /api/products/67890              -> product cũ đã bị xóa
  /api/images/deleted-banner.jpg   -> resource đã bị gỡ xuống
  Đây là business-as-usual: app nhận request hợp lệ, xử lý bình thường,
  kết quả là "không tìm thấy". Response này cache được.
```

Case 11 này test chính xác **expected 404**: request gửi đến một product ID được
sinh ra động (`missing-{timestamp}`), application xử lý bình thường, trả về 404
với `cacheable_not_found: true`. CDN phải cache response này.

## 2. CDN capability being proved

### Contract cần chứng minh

```text
CAPABILITY: Expected 404 responses are cached with a short negative TTL.

CONTRACT:
  ┌─────────────────────────────────────────────────────────────┐
  │ 1. First request for missing resource -> 404 MISS          │
  │    Origin nhận request, xử lý, trả 404                      │
  │    CDN lưu object với negative TTL (mặc định 15s trong VCL) │
  │    Response có header X-Negative-Cache: true                │
  │                                                             │
  │ 2. Second request for SAME missing resource, within TTL    │
  │    -> 404 HIT                                               │
  │    CDN serve từ cache, KHÔNG gọi origin                     │
  │    Response vẫn có X-Negative-Cache: true                   │
  │    Response vẫn là 404 (CDN không đổi status code)          │
  │                                                             │
  │ 3. Wait past negative TTL                                   │
  │    Object hết hạn trong cache                               │
  │                                                             │
  │ 4. Third request for same resource, after TTL              │
  │    -> 404 MISS                                              │
  │    Cache expired -> CDN phải gọi origin lại                 │
  │    Origin trả 404 mới -> CDN cache lại với negative TTL mới │
  │                                                             │
  │ 5. Origin request count proves the offload:                │
  │    count = 1 (sau lần đầu)                                  │
  │    count = 1 (trong negative cache window)                  │
  │    count = 2 (sau khi negative TTL hết hạn)                 │
  └─────────────────────────────────────────────────────────────┘
```

### Sequence proof bằng sơ đồ thời gian

```text
Timeline (với NEGATIVE_TTL_SECONDS = 5):

t=0s    Request #1: GET /api/cached/missing/missing-1734567890
        -> Origin nhận request -> xử lý -> 404
        -> CDN cache object, TTL = 5s
        -> Response: 404 MISS, X-Negative-Cache: true
        -> Origin counter: 1

t=1s    Request #2: GET /api/cached/missing/missing-1734567890
        -> CDN hit cache (TTL còn 4s)
        -> Response: 404 HIT, X-Negative-Cache: true
        -> Origin counter: VẪN 1 (không gọi origin)

        === SLEEP 6s (NEGATIVE_TTL + 1) ===
        === Object expired at t=5s ===

t=7s    Request #3: GET /api/cached/missing/missing-1734567890
        -> Object hết hạn -> CDN MISS
        -> Origin nhận request lần thứ 2 -> xử lý -> 404
        -> CDN cache object mới, TTL = 5s
        -> Response: 404 MISS, X-Negative-Cache: true
        -> Origin counter: 2 (tăng từ 1 lên 2)
```

## 3. Vi sao test o CDN layer

### Negative caching la chinh sach CUA CDN

Day la mot diem quan trong ma nhieu nguoi bo qua:

```text
App/Origin                     CDN/Varnish                   Client
───────────────                ────────────────               ─────────
App chi biet:                  CDN quyet dinh:               Client thay:
"Co request,                   404 nay co cache            "404 Not Found"
tao xu ly,                      khong?
tra ve 404"                    Cache bao lau?
                               (bao nhieu giay?)

App KHONG quyet dinh           CDN LA NOI DUY NHAT           Client khong biet
404 co duoc cache              quyet dinh chinh             (va khong can biet)
hay khong                      sach negative               CDN da cache response
                               caching                      nay hay chua
```

App chi tra ve HTTP 404. App khong the ra lenh: "hay cache cai 404 nay."
CDN/Varnish la noi quyet dinh:

1. **Co cache 404 khong?** — Quyet dinh trong `vcl_backend_response`:
   ```vcl
   if (beresp.status == 404 || beresp.status == 410) {
       set beresp.ttl = 15s;   // <-- CDN quyet dinh cache 15s
   }
   ```

2. **Cache bao lau?** — TTL la policy cua CDN, khong phai cua app:
   - 404 (not found): 15s — ngu, resource co the duoc tao ra sau vai giay
   - 410 (gone): 86400s (24h) — resource da bi xoa vinh vien, cache lau hon
   - 403 (forbidden): 0s (khong cache) — vi authorization co the thay doi

3. **Header X-Negative-Cache** — CDN danh dau de observability:
   ```vcl
   set beresp.http.X-Negative-Cache = "true";
   ```

### Tai sao KHONG TEST O APP LAYER?

```text
NEU TEST O APP LAYER:
  -> App tra 404 -> test pass
  -> Nhung KHONG BIET CDN co cache 404 nay khong
  -> Nhung KHONG BIET TTL cua negative cache la bao nhieu
  -> Nhung KHONG BIET X-Negative-Cache header co duoc them vao khong
  -> Nhung KHONG BIET negative cache co expire dung han khong
  -> App-layer test khong the tra loi bat ky cau hoi CDN nao

TEST O CDN LAYER:
  -> Request qua CDN (http://localhost:80)
  -> Kiem tra X-Cache: HIT hay MISS
  -> Kiem tra X-Negative-Cache: true
  -> Kiem tra origin counter: 1 -> 1 -> 2
  -> Kiem tra status code van la 404 (khong bi CDN bien thanh 200)
  -> Day la nhung thong tin CHI CO O CDN layer
```

Negative caching thuoc ve **CDN-edge behavior**. No la mot chinh sach ma CDN
van hanh doc lap voi application. Test o app layer co the biet app tra 404 dung,
nhung khong the biet CDN co bao ve origin khoi 404 traffic lap lai hay khong.

### VCL la noi duy nhat quyet dinh

```text
BOX: AI QUYET DINH VIEC NEGATIVE CACHING?

 App (Go/Python/Node)  -->  Chi tra ve HTTP status code
                             App khong the set "hay cache
                             cai 404 nay trong 15s"
                             (App co the set Cache-Control
                             nhung CDN override trong VCL)

 VCL (Varnish config)  -->  LA NOI QUYET DINH DUY NHAT:
                             - Status code nao duoc negative-cache?
                             - TTL bao nhieu?
                             - Co tag X-Negative-Cache khong?
                             - Co cho phep grace (stale serving)
                               cho negative cache khong?

 => VCL la single source of truth cho negative caching policy
 => Test CDN layer la cach DUY NHAT de verify policy nay hoat dong
```

## 4. Topology & precondition

### Runtime path

```text
Public path (cho request 404):
  k6 -> http://localhost:80 -> Varnish -> Nginx -> Go app (GetCachedMissing)
  URL: /api/cached/missing/missing-{timestamp}?ttl_seconds=5

Control path (cho origin counter):
  k6 -> http://localhost:8088/ops/app/cdn/origin/request-counts
  k6 -> http://localhost:8088/ops/app/cdn/origin/request-counts/reset

Event path: khong su dung trong case nay
```

### Precondition

```text
1. Origin counters duoc reset ve 0
   POST /ops/app/cdn/origin/request-counts/reset

2. Origin profile duoc reset ve default
   POST /ops/app/cdn/origin/reset

3. Duong dan missing duoc tao dong de dam bao isolated test:
   buildCachedMissingPath("missing-{timestamp}", { ttl_seconds: 5 })
   -> /api/cached/missing/missing-1734567890?ttl_seconds=5

   Tai sao can dynamic path?
   - Tranh pollution tu previous runs
   - Moi lan chay la mot test sach, khong bi anh huong boi cache cu
   - Timestamp dam bao uniqueness

4. Ban URL de xoa cache cu (neu co):
   POST /ops/app/cdn/cache/ban-url { url: "/api/cached/missing/missing-..." }
```

### buildCachedMissingPath() — path tao 404 expected

```text
buildCachedMissingPath(key, params) tra ve:

  /api/cached/missing/{key}?ttl_seconds={n}&stale_if_error_seconds={m}

Handler Go (GetCachedMissing):
  1. Nhan request
  2. Increment origin counter cho path nay
  3. Neu co origin_delay_ms -> sleep
  4. Set Cache-Control header: public, max-age={ttl}, s-maxage={ttl},
     stale-if-error={stale_if_error}
  5. Set X-Negative-Cache: true
  6. Set X-Origin-Request-Count: {count}
  7. Tra ve HTTP 404 JSON: { success: false, error: "cached object not found",
     cacheable_not_found: true, request_key: "..." }

Day LA expected 404: app xu ly binh thuong, tra ve loi "khong tim thay",
danh dau object nay co the cache duoc (cacheable_not_found: true).
```

## 5. Script deep-dive

### Tong quan script

Script `11-negative-caching.js` (84 lines) la mot sequence test chinh xac, tuong tu
nhu case 08 (TTL expiry) va case 09 (stale-while-error): `vus=1, iterations=1`.
No chay mot sequence cac request chinh xac, kiem tra tung response mot.

```text
vus: 1, iterations: 1  -->  Mot VU duy nhat chay toan bo sequence
                            Khong can nhieu VU vi day la correctness test,
                            khong phai load test
```

### setup() — Chuan bi moi truong sach

```javascript
export function setup() {
  // Tao dynamic path de tranh cache pollution
  const path = buildCachedMissingPath(`missing-${Date.now()}`, {
    ttl_seconds: NEGATIVE_TTL_SECONDS,  // default: 5
  });
  // Kết quả: /api/cached/missing/missing-1734567890123?ttl_seconds=5

  // Reset origin profile + counters để bắt đầu test sạch
  resetOriginProfile();
  resetOriginRequestCounts();

  // Ban URL cũ nếu có từ lần chạy trước
  banUrl(path);

  return { path };
}
```

### Default function — 3 phase test

**Phase 1: Tao negative cache + verify HIT**

```javascript
// --- REQUEST #1: MISS (cold) ---
const first = requestCdn('GET', path, {
  tags: { case: 'negative_first' },
});
assertStatus(first, 404, 'negative first');
assertCacheState(first, 'MISS', 'negative first');
assertHeaderEquals(first, 'X-Negative-Cache', 'true', 'negative first');
// Lúc này origin counter = 1

// --- REQUEST #2: HIT (negative cache đã có) ---
const second = requestCdn('GET', path, {
  tags: { case: 'negative_second' },
});
assertStatus(second, 404, 'negative second');
assertCacheState(second, 'HIT', 'negative second');
assertHeaderEquals(second, 'X-Negative-Cache', 'true', 'negative second');
// Vẫn X-Negative-Cache: true vì cache object giữ nguyên response headers
```

**Verification #1: Origin count chỉ là 1**

```javascript
let counts = getOriginRequestCounts();
let requestCount = findOriginRequestCount(counts, path);
if (requestCount !== 1) {
  throw new Error(
    `expected negative cached path ${path} to hit origin once before expiry, got ${requestCount}`
  );
}
```

**Phase 2: Wait negative TTL hết hạn + verify MISS**

```javascript
// Các env knobs:
// NEGATIVE_TTL_SECONDS: default 5 (TTL của negative cache)
// NEGATIVE_WAIT_SECONDS: default NEGATIVE_TTL_SECONDS + 1 = 6
//    => Đảm bảo chờ đủ lâu để object hết hạn

sleep(NEGATIVE_WAIT_SECONDS);  // Sleep 6s

// --- REQUEST #3: MISS (cache hết hạn) ---
const afterExpiry = requestCdn('GET', path, {
  tags: { case: 'negative_after_expiry' },
});
assertStatus(afterExpiry, 404, 'negative after expiry');
assertCacheState(afterExpiry, 'MISS', 'negative after expiry');
// Không assert X-Negative-Cache ở đây vì đây là MISS mới,
// nhưng vẫn có X-Negative-Cache: true từ response origin
```

**Verification #2: Origin count tang len 2**

```javascript
counts = getOriginRequestCounts();
requestCount = findOriginRequestCount(counts, path);
if (requestCount !== 2) {
  throw new Error(
    `expected negative cached path ${path} to hit origin twice after expiry, got ${requestCount}`
  );
}
```

**Teardown: Don dep**

```javascript
export function teardown() {
  resetOriginProfile();
  resetOriginRequestCounts();
}
```

### Bang tong ket sequence

```text
PHASE  | REQUEST | EXPECTED STATUS | EXPECTED CACHE | X-NEG-CACHE | ORIGIN COUNT
───────┼─────────┼─────────────────┼────────────────┼─────────────┼─────────────
setup  | reset   | -               | -              | -           | 0
───────┼─────────┼─────────────────┼────────────────┼─────────────┼─────────────
  1    |   #1    | 404             | MISS           | true        | 1
  1    |   #2    | 404             | HIT            | true        | 1 (không đổi)
───────┼─────────┼─────────────────┼────────────────┼─────────────┼─────────────
 WAIT  | sleep   |                 | 6s sleep        |             |
───────┼─────────┼─────────────────┼────────────────┼─────────────┼─────────────
  2    |   #3    | 404             | MISS           | true        | 2
```

### Env knobs

```text
NEGATIVE_TTL_SECONDS  (default: 5)
  -> TTL cho negative cache. Object 404 se duoc cache trong N giay nay.
  -> Truyen vao buildCachedMissingPath() de set Cache-Control header cua origin.

NEGATIVE_WAIT_SECONDS  (default: NEGATIVE_TTL_SECONDS + 1, tuc la 6)
  -> Thoi gian sleep de dam bao negative cache da het han.
  -> +1s la safety margin — dam bao object chac chan da expired.
  -> NOTE: Trong VCL, negative TTL mac dinh la 15s. Nhung script override
     bang cach set ?ttl_seconds=5 trong query string, origin set Cache-Control
     tuong ung, VCL ton trong Cache-Control tu origin.
```

### Luu y ve TTL interaction

```text
Mat xich quan trong: TTL tu origin (qua Cache-Control header) vs VCL default.

Origin (GetCachedMissing handler):
  -> Set Cache-Control: public, max-age={ttl}, s-maxage={ttl}
  -> Voi ttl_seconds=5: max-age=5, s-maxage=5

VCL (vcl_backend_response):
  -> Doc beresp.ttl tu Cache-Control cua origin
  -> Neu beresp.status == 404 && beresp.ttl <= 0s:
     set beresp.ttl = 15s  (VCL default)
  -> Neu beresp.status == 404 && beresp.ttl > 0s:
     KHONG override — ton trong TTL tu origin

  => Khi origin set max-age=5, VCL ton trong, negative TTL = 5s
  => Khi origin khong set (ttl <= 0), VCL set default = 15s
```

## 6. Negative caching model deep-dive

### Status codes nao nen duoc negative-cache

Day la cau hoi kien truc quan trong nhat cua negative caching.
**Khong phai error code nao cung nen cache.** Quyet dinh dua vao
y nghia kinh doanh va kha nang thay doi cua resource.

```text
BANG: STATUS CODE VA QUYET DINH NEGATIVE CACHING
──────────────────────────────────────────────────────────────────────

NÊN NEGATIVE-CACHE (expected business outcomes):
──────────────────────────────────────────────
  STATUS    | Y NGHIA              | TTL GOI Y    | LY DO
  ──────────┼──────────────────────┼──────────────┼──────────────────
  404       | Not Found            | 1s - 60s     | Resource chua
            |                      | (thuong 15s) | ton tai, nhung co
            |                      |              | the duoc tao ra
            |                      |              | SOM. TTL ngan de
            |                      |              | tranh stale 404.
  ──────────┼──────────────────────┼──────────────┼──────────────────
  410       | Gone                 | 1h - 24h     | Resource da bi xoa
            |                      |              | VINH VIEN. Khong
            |                      |              | co kha nang xuat
            |                      |              | hien tro lai.
            |                      |              | TTL dai hon 404.
  ──────────┼──────────────────────┼──────────────┼──────────────────
  403       | Forbidden            | 0s - 10s     | CÂN NHAC KY.
            | (carefully)          |              | Authorization co
            |                      |              | the thay doi khi
            |                      |              | user login. Chi
            |                      |              | cache 403 neu la
            |                      |              | resource that su
            |                      |              | khong the truy
            |                      |              | cap (blocked geo).
  ──────────┼──────────────────────┼──────────────┼──────────────────
  400       | Bad Request          | HAU NHU      | Request bi loi do
            | (rarely)             | KHONG BAO GIO| client sai format.
            |                      |              | Moi bad request
            |                      |              | la unique. Cache
            |                      |              | khong co y nghia.

KHÔNG ĐƯỢC NEGATIVE-CACHE (server errors):
──────────────────────────────────────────
  STATUS    | Y NGHIA              | LY DO KHONG DUOC CACHE
  ──────────┼──────────────────────┼────────────────────────────────
  500       | Internal Server      | Day la LOI HE THONG. Cache 500
            | Error                | se CHE GIAU loi, khien team
            |                      | khong phat hien ra van de.
            |                      | Origin can thay moi 500 de debug.
  ──────────┼──────────────────────┼────────────────────────────────
  502       | Bad Gateway          | Upstream service dang down.
            |                      | Cache 502 = fake "OK" khi
            |                      | upstream that su chet.
            |                      | Dung stale-if-error thay vi cache.
  ──────────┼──────────────────────┼────────────────────────────────
  503       | Service Unavailable  | Maintenance hoac overload.
            |                      | Neu cache 503, user se tuong
            |                      | service down vinh vien.
            |                      | Dung stale-if-error thay vi cache.
  ──────────┼──────────────────────┼────────────────────────────────
  504       | Gateway Timeout      | Khong cache — can retry.
```

### Cach VCL hien thuc hoa negative caching

VCL la single source of truth cho negative caching policy. Day la logic
trong `vcl_backend_response` cua du an:

```vcl
sub vcl_backend_response {
    // (1) Server errors (500+) — TUYET DOI KHONG CACHE
    if (beresp.status >= 500) {
        set beresp.ttl = 0s;
        set beresp.uncacheable = true;
        return (deliver);
    }

    // (2) Negative caching cho 404 va 410
    if (beresp.status == 404 || beresp.status == 410) {
        if (beresp.ttl <= 0s) {
            set beresp.ttl = 15s;  // Default negative TTL
        }
        set beresp.grace = 30s;    // Cho phep stale serving khi
        set beresp.keep = 120s;    // origin unhealthy
        set beresp.http.X-Negative-Cache = "true";
        return (deliver);
    }

    // (3) Response co Set-Cookie -> private, khong cache
    if (beresp.http.Set-Cookie) {
        set beresp.ttl = 0s;
        set beresp.uncacheable = true;
        return (deliver);
    }

    // (4) Cache-Control: no-store|private -> tuan thu
    if (beresp.http.Cache-Control ~ "(?i)no-store|private") {
        set beresp.ttl = 0s;
        set beresp.uncacheable = true;
        return (deliver);
    }

    // (5) Fallback TTLs cho cac path khong co cache header
    // ...
}
```

### Phan tich VCL logic

```text
THU TU XU LY (quan trong):
───────────────────────────
1. 500+ -> KHONG cache (exit som nhat)
   Dieu nay DAM BAO server errors khong bao gio bi cache, du app co
   set Cache-Control the nao di nua. VCL override app cho 5xx.

2. 404/410 -> NEGATIVE cache
   - Neu app da set TTL (qua Cache-Control) -> ton trong TTL cua app
   - Neu app khong set TTL -> VCL set default 15s
   - Luon set X-Negative-Cache: true (observability)
   - Luon set grace=30s (cho phep stale serving)
   - Luon set keep=120s (giu object trong cache de phuc vu grace)

   Grace cho negative cache? Tai sao?
   -> Neu origin gap loi (500), CDN co the serve 404 tu cache
      thay vi pass error 500 den client. Day la "stale-if-error"
      nhung ap dung cho ca negative cache.
   -> 404 stale van la 404 — tot hon la 500.

3. Set-Cookie -> KHONG cache
   Response co Set-Cookie la private, khong the cache o shared cache.

4. no-store|private -> KHONG cache
   Tuan thu Cache-Control directive tu origin.

5. Fallback TTLs -> Chi cho path cu the
```

### TTL cho negative cache: tai sao NGAN?

```text
SO SANH TTL:

Positive cache (200 OK):
  /api/sim/products/1              TTL = 90s
  /api/sim/products/categories     TTL = 300s
  /api/sim/products/homefeed       TTL = 20s
  Muc dich: serve nhanh, giam origin load

Negative cache (404/410):
  /api/cached/missing/*            TTL = 15s (default)
  /api/sim/products/999999         TTL = 15s (default)
  Muc dich: bao ve origin, nhung khong block resource moi

  Tai sao TTL NGAN?
  ┌──────────────────────────────────────────────────────────────┐
  │ Tinh huong: Product ID 99999 chua ton tai luc 10:00:00      │
  │ CDN cache 404 voi TTL = 15s                                  │
  │                                                              │
  │ Neu TTL = 300s (5 phut):                                     │
  │   Admin tao product ID 99999 luc 10:00:30                    │
  │   User request ID 99999 luc 10:01:00                         │
  │   -> Van thay 404 HIT (stale!)                               │
  │   -> Product that su da ton tai nhung CDN van tra 404        │
  │   -> Mat doanh thu trong 4.5 phut                            │
  │                                                              │
  │ Neu TTL = 15s:                                               │
  │   Admin tao product ID 99999 luc 10:00:30                    │
  │   User request ID 99999 luc 10:01:00                         │
  │   -> Cache da expire -> MISS -> origin -> 200 OK             │
  │   -> User thay product that                                  │
  │   -> Chi mat toi da 15s, khong phai 5 phut                   │
  │                                                              │
  │ Rule of thumb:                                               │
  │   TTL negative = MIN(thoi gian toi da co the co resource     │
  │                      moi duoc tao, 60s)                      │
  │   404: 1-60s vi resource co the duoc tao moi                 │
  │   410: 86400s+ vi resource da bi xoa vinh vien               │
  └──────────────────────────────────────────────────────────────┘
```

### X-Negative-Cache header — observability signal

```text
X-Negative-Cache: true

Header nay duoc VCL them vao CHO MOI RESPONSE co nguon goc tu negative cache,
du la HIT hay MISS. No la co hieu de monitoring tools biet:

  "Response nay la 404, va no CO THE da duoc cache."
  (Khac voi 404 tu app ma CDN quyet dinh KHONG cache.)

Su dung X-Negative-Cache:
  - Alert: neu ti le X-Negative-Cache HIT giam -> negative caching broken
  - Debug: biet ngay response tu negative cache hay tu origin
  - Dashboard: theo doi negative cache hit ratio rieng biet voi positive cache

Luu y: Resonse MISS van co X-Negative-Cache: true vi origin da set header
nay. VCL chi ADD header nay neu chua co tu origin, hoac OVERRIDE neu origin
khong set.
```

### Grace va Keep cho negative cache

```text
GRACE (30s) cho negative cache:
  Neu origin unhealthy (backend probe fail):
    -> CDN serve 404 stale TU CACHE
    -> Client van nhan 404 (dung voi thuc te)
    -> KHONG pass error 503/502 den client
  Grace cho negative cache it quan trong hon grace cho positive cache
  (404 stale khong co gia tri kinh doanh), nhung van tot hon 500.

KEEP (120s) cho negative cache:
  Giữ object trong cache sau khi het han de co the serve grace.
  Sau 120s, object bi xoa hoan toan khoi cache.
```

### Cach set negative TTL theo status code

### Tuong tac giua origin Cache-Control va VCL default TTL

Mot diem quan trong trong negative caching la **ai la nguon su that cho TTL**:
origin (qua Cache-Control header) hay VCL (qua `set beresp.ttl`)?

```text
THU TU UU TIEN:

1. Origin Cache-Control header (uu tien cao nhat)
   Neu origin set Cache-Control: max-age=5, s-maxage=5
   -> beresp.ttl = 5s (Varnish tu dong parse)
   -> VCL kiem tra: if (beresp.ttl <= 0s) => FALSE (5 > 0)
   -> VCL KHONG override => TTL = 5s
   => Origin quyet dinh TTL

2. VCL default (fallback)
   Neu origin KHONG set Cache-Control headers
   -> beresp.ttl = 0s (Varnish default)
   -> VCL kiem tra: if (beresp.ttl <= 0s) => TRUE
   -> VCL set: set beresp.ttl = 15s
   => VCL quyet dinh TTL = 15s

3. VCL override (kiem soat tuyet doi - can than!)
   Neu VCL muon LUON set TTL rieng, bat chap origin:
   set beresp.ttl = 15s;  // Khong kiem tra dieu kien
   => VCL LUON quyet dinh TTL
   => Nhung mat di su linh hoat cua origin
```

### Tai sao ton trong origin Cache-Control la quan trong?

```text
Loi ich cua viec origin set TTL:
  - App developer biet ro nhat TTL phu hop
  - Vi du: product detail page -> 90s
  - Vi du: health check -> 1s
  - Vi du: negative cache -> 5s (theo script)
  - VCL chi la safety net (default 15s khi origin khong set)

Loi ich cua viec VCL co default:
  - Origin developer co the QUEN set Cache-Control
  - VCL default dam bao negative cache luon hoat dong
  - Giam operational risk
  - Tranh truong hop "quen set -> khong cache -> origin bi tan cong"

Pattern toi uu (nhu trong du an nay):
  Origin: set Cache-Control voi TTL phu hop
  VCL:    if (beresp.ttl <= 0s) { set beresp.ttl = 15s; }
         // Chi override khi origin khong set
         // Ton trong origin khi origin set

  => Origin developer control TTL
  => VCL la safety net
```

### Loi thuong gap: VCL LUON set TTL ma khong kiem tra

```text
ANTI-PATTERN:
  if (beresp.status == 404) {
      set beresp.ttl = 15s;  // LUON set, bo qua origin Cache-Control
  }

  Voi cach nay:
  - Origin set Cache-Control: max-age=2 -> VAN bi VCL override thanh 15s
  - Origin set Cache-Control: max-age=60 -> VAN bi VCL override thanh 15s
  - Origin KHONG the kiem soat TTL
  - Case 11 script set ?ttl_seconds=5 -> bi VCL ignore -> TTL that su la 15s
    -> NEGATIVE_WAIT_SECONDS=6 < 15s -> test FAIL vi chua expire!

PATTERN DUNG (nhu du an nay):
  if (beresp.status == 404 || beresp.status == 410) {
      if (beresp.ttl <= 0s) {
          set beresp.ttl = 15s;  // Chi set khi origin KHONG set
      }
  }

  Voi cach nay:
  - Origin set Cache-Control: max-age=5 -> beresp.ttl = 5s (ton trong origin)
  - Origin KHONG set -> beresp.ttl = 0s -> VCL set 15s (safety net)
  - Case 11 script set ?ttl_seconds=5 -> TTL dung = 5s -> test PASS
```

### Cach set negative TTL theo status code

```text
PATTERN: Phan biet TTL theo status code:

404 (Not Found):
  Default TTL: 15s
  Ly do: resource co the duoc tao moi bat cu luc nao
  Config VCL: set beresp.ttl = 15s

410 (Gone):
  Default TTL: 86400s (24h) hoac dai hon
  Ly do: resource da bi xoa vinh vien, khong quay lai
  Config VCL (them vao):
    if (beresp.status == 410) {
        set beresp.ttl = 86400s;
    }

403 (Forbidden) — chi khi chac chan:
  Default TTL: 5s (rat ngan)
  Ly do: authorization co the thay doi (user login)
  Chir cache 403 cho geo-blocked noi dung hoac IP-ban
  Them dieu kien kiem tra truoc khi cache 403.

5xx: KHONG BAO GIO CACHE
  Config VCL: set beresp.ttl = 0s; set beresp.uncacheable = true
```

## 7. Negative vs Positive cache comparison

### Bang so sanh toan dien

```text
THUOC TINH          POSITIVE CACHE              NEGATIVE CACHE
─────────────────── ─────────────────────────── ───────────────────────────
Status code        200 (OK), 304 (Not Modified) 404 (Not Found), 410 (Gone)

TTL                20s - 300s (phut)            1s - 60s (giay), 410: dai hon

Muc dich chinh     PERFORMANCE                  DEFENSE
                   Tang toc do serve,           Bao ve origin khoi
                   giam origin load cho          traffic xau/loi lap lai
                   noi dung thuc su

Surrogate-Key      CO                           THUONG KHONG CAN
                   De invalidate khi            Vi 404 khong co noi dung
                   noi dung thay doi             de invalidate; TTL ngan
                                                tu giai quyet

Grace (stale)      120s (phuc vu khi            30s (phong ho)
                   origin unhealthy)            It quan trong hon nhung
                                                van co mat

Keep               600s (giu trong cache)       120s

Header danh dau    Khong can header dac biet    X-Negative-Cache: true

Cache key          Path + variant headers       Path (thuong khong can
                   (language, geo, device...)    variant vi 404 la 404)

Hit ratio target   90-99% (cao)                 Khong dat target cao vi
                                                TTL ngan + it traffic 404

Rui ro neu qua     STALE DATA                   STALE 404
TTL dai            User thay noi dung cu        Resource moi da duoc tao
                   (gia sai, ton kho sai)       nhung CDN van tra 404
                   -> Mat doanh thu             -> Mat doanh thu
                                                (nhung window ngan hon)

Rui ro neu qua     Origin phai xu ly them       Origin bi spam 404
TTL ngan           200 requests                 -> Ton tai nguyen
                   -> Ton tai nguyen            -> Giam performance

Chi phi neu        Nang (origin load cho        Nang (origin load cho
KHONG CO           200 requests)                404 requests)
                   User cham hon                User thay 404 sau hon
                                                Origin de bi tan cong hon

Tam quan trong     RAT CAO                      TRUNG BINH - CAO
cho production     Moi request 200 deu          Neu khong co, origin
                   huong loi tu cache           co the bi DDoS boi
                                                chinh traffic 404
```

### Hai muc dich, hai cach nghi

```text
POSITIVE CACHING                      NEGATIVE CACHING
─────────────────────                 ─────────────────────
"Lam sao de serve nhanh nhat?"        "Lam sao de origin khong bi
                                       ton hai boi request rai rac?"

Optimization mindset                  Defense mindset
Truoc focus: FE, user experience      Truoc focus: Backend stability,
                                       resource protection

KPIs:                                 KPIs:
- Cache hit ratio                     - Negative hit ratio
- Time to first byte                  - Origin request count
- Page load time                      - 404 origin offload %
- Origin offload % (positive)         - False 200 rate (= 404 la 200)

Tool: CDN monitoring dashboard        Tool: Origin counter + CDN logs
                                       + X-Negative-Cache header
```

## 8. Origin request counting proof

### Origin counters — THE evidence

Giong nhu case 09 (stale-while-error) va case 10 (request coalescing),
**origin request counters la bang chung khong the tranh cai** cho negative caching.

```text
NGUYEN TAC:
  - Moi MISS -> origin nhan request -> counter++ (qua incrementCDNOriginCount)
  - Moi HIT -> origin KHONG nhan request -> counter KHONG tang
  - Dua vao counter, ta biet CHINH XAC so lan origin bi goi

PATH DEM:
  GET  /ops/app/cdn/origin/request-counts        -> lay counter hien tai
  POST /ops/app/cdn/origin/request-counts/reset  -> reset ve 0
```

### Increment logic trong Go handler

```go
func (h *Handler) GetCachedMissing(c *gin.Context) {
    // Tao key tu URL path de dem
    requestKey := normalizeCDNOriginRequestKey(c.Request.URL.RequestURI())

    // INCREMENT COUNTER TRUOC KHI XU LY
    requestCount, _ := h.incrementCDNOriginCount(ctx, requestKey)

    // Sau do moi xu ly delay, set headers, tra 404
    // ...
    c.Header("X-Origin-Request-Count", strconv.FormatInt(requestCount, 10))
    c.Header("X-Negative-Cache", "true")
    c.JSON(http.StatusNotFound, gin.H{
        "success": false,
        "error": "cached object not found",
        "cacheable_not_found": true,
        "request_key": requestKey,
    })
}
```

### Increment la atomic va truoc khi xu ly

```text
Tại sao increment TRƯỚC khi xử lý request?
  -> Đảm bảo counter luôn đếm đúng, kể cả khi handler panic hoặc
     request bị cancel giữa chừng
  -> Nếu increment sau xử lý, request fail giữa chừng se khong duoc dem
     -> "Origin khong bi hit" la sai (origin da bi hit, chi la khong
        hoan thanh request)

Tại sao dùng requestKey = normalize URL?
  -> De tim chinh xac counter cho path cu the
  -> Tranh bi anh huong boi query string khac nhau
  -> findOriginRequestCount(counts, path) tim trong array counts
     theo request_key
```

### Count verification sequence

```text
Phase-by-phase verification:

AFTER SETUP (reset):
  getOriginRequestCounts() -> findOriginRequestCount(counts, path) = 0

AFTER PHASE 1 (request #1 MISS, request #2 HIT):
  getOriginRequestCounts() -> findOriginRequestCount(counts, path) PHẢI = 1
  Neu = 0: origin chua bao gio duoc goi (khong the co 404 MISS)
  Neu = 2: negative cache khong hoat dong (MISS ca 2 lan)
  Neu = 1: DUNG -> chi 1 origin hit, lan 2 la HIT tu negative cache

AFTER PHASE 2 (request #3 sau sleep):
  getOriginRequestCounts() -> findOriginRequestCount(counts, path) PHẢI = 2
  Neu = 1: negative cache chua expire? sleep chua du? TTL dai hon du kien?
  Neu = 3: co them request nao do khong mong muon?
  Neu = 2: DUNG -> them 1 origin hit sau khi negative cache expire
```

### Counter la bang chung cua offload

```text
OFFLOAD PROOF:

Neu khong co negative caching:
  3 requests -> 3 origin hits -> counter = 3
  Offload = 0%

Co negative caching:
  3 requests -> 2 origin hits -> counter = 2
  Offload = 1/3 = 33%

Neu scale len 10,000 requests trong 15s window (cung URL):
  Khong co negative cache: 10,000 origin hits
  Co negative cache:       1 origin hit     -> offload = 99.99%

  Do la suc manh cua negative caching: 1 request toi origin,
  9,999 requests duoc CDN hap thu.
```

## 9. Key signals/headers

### Response headers can kiem tra

```text
HEADER                 Y NGHIA                            GIA TRI MONG DOI
────────────────────── ────────────────────────────────── ──────────────────
X-Cache                Cache state                        MISS -> HIT -> MISS
                        HIT = CDN serve tu cache
                        MISS = CDN goi origin

X-Negative-Cache       Response nay la negative cache     "true" cho ca
                       (du HIT hay MISS)                  HIT va MISS

X-Cache-Hits           So lan object da duoc hit          > 0 cho HIT
                       trong cache truoc khi expire

Status Code            HTTP status                        404 (luon 404,
                                                          khong bao gio 200)

X-Served-By            Node CDN da serve                  "varnish"

X-Origin-Request-Count So lan origin da nhan request      Tang sau moi MISS
                       cho path nay (tu origin)           Khong tang khi HIT

Age                    Thoi gian object da o trong        Tang dan tu 0
                       cache (giay)                       Reset ve 0 sau MISS

Cache-Control          Chinh sach cache tu origin         public, max-age=5,
                                                          s-maxage=5

CDN-Cache-Control      Chinh sach cache danh cho CDN      max-age=5,
                                                          stale-if-error=120
```

### Cach doc sequence tu headers

```text
Request #1 (MISS):
  X-Cache: MISS
  X-Negative-Cache: true         <-- origin set
  X-Origin-Request-Count: 1      <-- vua duoc dem
  Age: 0 (hoac khong co)         <-- vua moi tao

Request #2 (HIT):
  X-Cache: HIT
  X-Cache-Hits: 1                 <-- lan dau object duoc hit
  X-Negative-Cache: true          <-- van con (luu tu origin)
  X-Origin-Request-Count: 1       <-- VAN LA 1 (khong tang)
  Age: ~1                          <-- da ton tai 1s

Sleep 6s...

Request #3 (MISS, sau expire):
  X-Cache: MISS
  X-Negative-Cache: true          <-- origin set lai
  X-Origin-Request-Count: 2       <-- tang len 2
  Age: 0 (hoac khong co)          <-- object moi duoc tao lai
```

### Header warning signs

```text
DANGER SIGNALS:

1. X-Cache: HIT nhung KHONG CO X-Negative-Cache
   -> Co the la positive cache (200), khong phai negative cache
   -> Kiem tra status code

2. X-Cache: HIT nhung status = 200
   -> Object da bi overwrite boi positive cache?
   -> Hoac path nay dang tra 200 thay vi 404

3. X-Cache: MISS nhung X-Origin-Request-Count khong tang
   -> Origin counter bi broken
   -> Khong the verify offload

4. X-Cache: HIT nhung X-Origin-Request-Count tang
   -> Co request khac den origin cho cung path
   -> Co the do variant headers khac?
```

## 10. Pass/fail criteria

### Dieu kien PASS

```text
PASS KHI TAT CA CAC DIEU KIEN SAU DUNG:

1. k6 exit code = 0
   -> checks rate = 1 (tat ca check deu pass)
   -> Khong co throw Error nao

2. Cache-state sequence DUNG:
   404 MISS -> 404 HIT -> wait -> 404 MISS
   -> Chuyen tiep MISS->HIT chung minh negative cache da duoc luu
   -> Chuyen tiep HIT->MISS sau sleep chung minh negative cache da expire

3. Origin count DUNG:
   -> Sau phase 1: count = 1 (origin chi bi goi 1 lan)
   -> Sau phase 2: count = 2 (them 1 lan sau khi expire)
   -> Neu count khong dung pattern -> negative cache khong offload origin
      hoac khong expire

4. Status code BAO TOAN:
   -> Luon la 404 (khong bao gio 200, 500, hay status khac)
   -> CDN khong duoc thay doi status code cua negative cache

5. X-Negative-Cache header HIEN DIEN:
   -> Co tren ca MISS va HIT responses
   -> Chứng minh CDN gán tag negative caching cho object nay
```

### Dieu kien FAIL

```text
FAIL KHI BAT KY DIEU KIEN NAO SAU DAY SAI:

1. 404 bi coi la FAILURE do status code
   -> k6 assertion: assertStatus(first, 404) khong pass
   -> Nguyen nhan: k6 config hoac script khong accept 404 la expected
   -> Fix: dam bao script dung assertStatus (k6 check) khong phai
      http.expectedStatuses (k6 throw error)

2. Request #2 la MISS thay vi HIT
   -> "negative second cache state HIT" check fail
   -> Nguyen nhan kha nang:
      a) VCL khong cache 404 -> kiem tra vcl_backend_response
      b) Cache key khong match -> kiem tra URL normalization
      c) Object bi evict truoc TTL -> cache memory qua nho
      d) Request headers khac nhau tao cache key khac

3. Request #3 la HIT thay vi MISS sau sleep
   -> "negative after expiry cache state MISS" check fail
   -> Nguyen nhan kha nang:
      a) NEGATIVE_WAIT_SECONDS < TTL thuc te
      b) TTL duoc set dai hon du kien (kiem tra VCL default 15s)
      c) Grace period van con hoat dong

4. Origin count KHONG DUNG:
   -> Sau phase 1: count != 1
   -> Sau phase 2: count != 2
   -> Nguyen nhan: counter khong reset dung, hoac co request khac
      cung path chay song song

5. Khong co X-Negative-Cache header:
   -> VCL khong set header nay cho 404 responses
   -> Kiem tra vcl_backend_response -> phai co
      set beresp.http.X-Negative-Cache = "true"
```

### Partial pass patterns

```text
MOT SO PATTERN CHI PASS MOT PHAN:

Pattern A: MISS->HIT DUNG, nhung count = 2 o phase 1
  -> Negative cache hoat dong (co HIT)
  -> Nhung origin bi goi 2 lan thay vi 1
  -> Co the request #1 bi goi lai do retry hoac redirect

Pattern B: MISS->HIT DUNG, count = 1 o phase 1,
           nhung sau sleep van HIT
  -> Negative cache hoat dong nhung chua expire
  -> TTL thuc te > NEGATIVE_WAIT_SECONDS
  -> Hoac grace period dang serve stale

Pattern C: 404 MISS -> 404 MISS (khong co HIT),
           nhung count = 1 o phase 1
  -> Origin chi bi goi 1 lan nhung CDN khong cache
  -> Co the VCL khong nhan dien duoc 404 nay
     (vi du: 404 tu path khac /api/sim thay vi /api/cached)
```

## 11. Cach chay + output

### Cach chay co ban

```powershell
cd E:/Projects/k6/k6-metrics-server

$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

./scripts/run-cdn-capabilities.ps1 -Scenarios 11-negative-caching
```

### Override TTL va wait time (tuy chon)

```powershell
# Negative TTL = 3 giay, wait = 5 giay
$env:NEGATIVE_TTL_SECONDS = "3"
$env:NEGATIVE_WAIT_SECONDS = "5"
./scripts/run-cdn-capabilities.ps1 -Scenarios 11-negative-caching

# Negative TTL = 10 giay, wait = 12 giay (dai hon de test TTL dai)
$env:NEGATIVE_TTL_SECONDS = "10"
$env:NEGATIVE_WAIT_SECONDS = "12"
./scripts/run-cdn-capabilities.ps1 -Scenarios 11-negative-caching
```

### Luu y ve thoi gian chay

```text
Case nay CAN THOI GIAN do sleep NEGATIVE_WAIT_SECONDS:
  - Default: 6s sleep -> tong thoi gian ~8-10s
  - Neu set NEGATIVE_TTL_SECONDS=30 -> sleep 31s -> tong ~35s
  - Can kien nhan khi chay case nay

So voi cac case khac:
  - Case 01 (hit-smoke): <1s
  - Case 08 (ttl-expiry): ~22s (sleep 21s)
  - Case 11 (negative-caching): ~8s (sleep 6s default)
```

### Output dien hinh

```text
PASS output dien hinh:

  execution: local
     script: 11-negative-caching.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations shared among 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)

  running (0m00.0s), 0/1 VUs, 0 complete and 0 interrupted iterations
  default   [   0% ] 0/1 VUs  0m00.0s/10m0s  0m00.0s setup

  █ setup

  running (0m01.0s), 0/1 VUs, 0 complete and 0 interrupted iterations
  default   [   0% ] 1/1 VUs  0m01.0s/10m0s  0m00.0s

  running (0m08.0s), 1/1 VUs, 1 complete and 0 interrupted iterations
  default   [ 100% ] 1/1 VUs  0m08.0s/10m0s  0m00.0s

  █ teardown

  checks........................: 100.00% ✓ 7   ✗ 0
     ✓ negative first status 404
     ✓ negative first cache state MISS
     ✓ negative first X-Negative-Cache equals true
     ✓ negative second status 404
     ✓ negative second cache state HIT
     ✓ negative second X-Negative-Cache equals true
     ✓ negative after expiry status 404
     ✓ negative after expiry cache state MISS

  http_req_duration.............: avg=XXms min=XXms med=XXms max=XXms
  http_reqs.....................: 3 (3 requests total)
  iterations....................: 1
  vus............................: 1
```

### Cach doc output

```text
KIEM TRA TRONG OUTPUT:

1. checks rate = 100%: TAT CA check pass -> sequence dung

2. So request = 3:
   - 1 cho MISS ban dau
   - 1 cho HIT (tu cache)
   - 1 cho MISS sau expire
   - Day la 3 requests tu k6 den CDN, KHONG PHAI 3 origin hits

3. Origin counters (khong hien thi trong k6 output):
   - Phai kiem tra qua control path hoac dashboard
   - GET /ops/app/cdn/origin/request-counts
   - Tim request_key tuong ung -> count phai = 2

4. Neu FAIL:
   - Xem check nao fail -> biet duoc buoc nao bi loi
   - "negative second cache state HIT" fail -> negative cache ko hoat dong
   - "negative after expiry cache state MISS" fail -> TTL chua expire
   - Error message tu origin count check -> biet actual count vs expected
```

## 12. 4 output->decision scenarios

### Scenario A: Perfect negative caching

```text
OUTPUT:
  ✓ negative first status 404
  ✓ negative first cache state MISS
  ✓ negative first X-Negative-Cache equals true
  ✓ negative second status 404
  ✓ negative second cache state HIT
  ✓ negative second X-Negative-Cache equals true
  ✓ negative after expiry status 404
  ✓ negative after expiry cache state MISS
  Origin count: 1 (phase1) -> 2 (phase2)

KET LUAN:
  "CDN hap thu 404 traffic, origin duoc bao ve."

  TAT CA hoat dong dung:
  - Negative cache luu 404 voi TTL dung
  - Cache hit tra 404 tu CDN, KHONG goi origin
  - TTL expire dung han
  - Origin counter xac nhan offload: 3 request -> 2 origin hits
    (offload 33% cho 3 request, se la 99%+ voi high traffic)

HANH DONG TIEP THEO:
  - Production ready cho negative caching
  - Co the tune TTL (tang/giam) dua vao business requirement
  - Document lai TTL values cho tung status code
  - Setup monitoring cho negative cache hit ratio
```

### Scenario B: 404 never HIT

```text
OUTPUT:
  ✓ negative first status 404
  ✓ negative first cache state MISS
  ✓ negative first X-Negative-Cache equals true
  ✓ negative second status 404
  ✗ negative second cache state HIT       <-- FAIL
  (expected HIT, got MISS)

  Origin count: co the la 2 ngay o phase 1
  (moi 404 deu MISS -> moi lan deu goi origin)

KET LUAN:
  "Negative caching KHONG DUOC CAU HINH trong VCL —
   tat ca 404 deu hit origin."

  Nguyen nhan kha nang:
  a) thieu logic 404 trong vcl_backend_response
     -> Kiem tra: khong co "if (beresp.status == 404)"
  b) 404 path khong duoc include trong cache path
     -> vcl_recv: return (pass) thay vi return (hash)
  c) Object bi set uncacheable = true do condition khac
     -> Kiem tra: Set-Cookie? no-store? private?
  d) Origin khong set Cache-Control headers
     -> VCL default TTL = 0s, object khong duoc cache

HANH DONG TIEP THEO:
  - Kiem tra VCL: vcl_backend_response phai co dieu kien
    if (beresp.status == 404 || beresp.status == 410)
  - Kiem tra vcl_recv: path cho 404 co duoc hash khong?
  - Kiem tra response origin co Cache-Control header khong
  - THEM VCL config cho negative caching
  - Rerun case 11 -> verify PASS
```

### Scenario C: Negative TTL qua dai

```text
OUTPUT:
  ✓ negative first status 404
  ✓ negative first cache state MISS
  ✓ negative second status 404
  ✓ negative second cache state HIT
  ✗ negative after expiry status 404
  ✗ negative after expiry cache state MISS   <-- FAIL
  (expected MISS, got HIT — van con HIT sau sleep)

  Origin count: 1 (phase1) -> 1 (phase2) — khong tang!

KET LUAN:
  "404 duoc cache voi TTL QUA DAI —
   resource co the duoc tao moi nhung CDN van tra 404 cu."

  Nguyen nhan kha nang:
  a) NEGATIVE_WAIT_SECONDS < TTL thuc te
     -> Vi du: NEGATIVE_TTL_SECONDS=5 nhung VCL set TTL=15s
        (vì Cache-Control tu origin khong duoc ton trong?)
  b) Grace period dang serve stale
     -> Object het TTL nhung grace = 30s van con
     -> CDN serve stale vi backend healthy
        (nhung vcl_hit chi serve stale khi backend unhealthy:
         if (!std.healthy(req.backend_hint) && obj.ttl + obj.grace > 0s))
  c) Keep time giu object trong cache qua lau

  Dac biet nguy hiem:
  Neu production co TTL negative = 300s (5 phut):
    -> Admin tao product moi
    -> Push notification den user
    -> User click -> 404 HIT (stale!) -> mat sale
    -> Fix bang invalidation thu cong -> operational toil

HANH DONG TIEP THEO:
  - Kiem tra TTL thuc te: VCL default 15s? Origin set bao nhieu?
  - Giam TTL xuong: 5-15s cho 404
  - Dam bao NEGATIVE_WAIT_SECONDS > TTL thuc te + grace (neu co)
  - Phan biet TTL 404 (ngan) vs TTL 410 (dai)
  - Rerun case 11 -> verify TTL expire dung han
```

### Scenario D: 500 responses bi negative-cached

```text
OUTPUT:
  Neu VCL bi cau hinh sai, cho phep negative-cache 5xx:

  (Neu test bang mot 500 path tuong tu 404 path...)
  ✓ 500 first status 500
  ✓ 500 first cache state MISS
  ✓ 500 second cache state HIT       <-- DANGER! 500 bi cache!
  ✓ 500 third sau sleep: HIT hoac MISS

KET LUAN:
  "DANGER — server errors bi negative-cached, CHE GIAU loi that su."

  Day la SAI LAM NGHIEM TRONG:
  - 500 la server error -> origin dang gap loi THAT SU
  - Neu cache 500, CDN tra 500 HIT thay vi goi origin
  - Origin khong nhan duoc request -> developer khong thay error
  - Monitoring: "CDN health = OK" (dang tra 500 HIT)
  - Reality: origin service da crash

  Hậu quả:
  - Service that su down nhung CDN van tra 500
    -> Khong ai nhan duoc alert
  - Origin tu recovery nhung CDN van tra 500 cu
    -> Stale 500 keo dai, user thay service down
  - Khi origin da up, nhung CDN van 500 HIT
    -> Den khi 500 TTL expire, user moi thay 200 lai

HANH DONG TIEP THEO (KHAN CAP):
  - KIEM TRA VCL NGAY: phai co
    if (beresp.status >= 500) {
        set beresp.ttl = 0s;
        set beresp.uncacheable = true;
    }
  - Dieu nay PHAI o TREN dieu kien 404/410
    (dam bao 5xx bi block truoc khi den negative cache logic)
  - Kiem tra TAT CA cac VCL deployment
  - Them test case: verify 500 khong bao gio HIT
  - Them monitoring alert: "X-Cache: HIT + status >= 500"
```

## 13. Nghich ly / misconceptions

### Nghich ly 1: "404 la loi, khong nen cache"

```text
SAI LAM PHO BIEN NHAT:
  "404 la HTTP error, cache error la sai."

THUC TE:
  404 co 2 loai:

  1. UNEXPECTED 404: URL sai format, path traversal, attack probe
     -> Khong nen cache, nen rate-limit

  2. EXPECTED 404: Product ID khong ton tai, resource da bi xoa
     -> NEN cache. Day la business response binh thuong, khong phai loi.
     -> App da xu ly thanh cong (success=false la ket qua dung)
     -> Cache 404 NAY giam origin load

  "Expected 404" la khai niem quan trong:
  - App da thuc thi day du logic: parse input, query DB, xu ly ket qua
  - Ket qua "khong tim thay" la ket qua DUNG, khong phai exception
  - Khong co gi "broken" o day
  - Tieu ton tai nguyen de xu ly -> cache de tranh xu ly lai
```

### Nghich ly 2: "Negative cache TTL = positive cache TTL"

```text
SAI LAM:
  "404 cung la mot cache object, TTL nen giong 200."

THUC TE:
  TTL cho negative cache PHAI NGAN HON RAT NHIEU:

  Positive cache (200): 60-300s
    -> Data co the stale nhung user van thay noi dung cu
    -> Stale 200 van co gia tri (product van ton tai, chi la gia thay doi)

  Negative cache (404): 5-15s
    -> Neu stale 404, user thay "khong tim thay" trong khi resource DA TON TAI
    -> Stale 404 la MAT DOANH THU (user thay 404 -> roi di)
    -> Admin tao product, user khong thay -> mat sale

  Quy tac:
    TTL_negative <= thoi gian toi thieu giua "resource duoc tao" va
                    "user dau tien request"
    -> Thuong 5-15s la an toan
    -> 410 (gone vinh vien) la ngoai le: co the cache 24h
```

### Nghich ly 3: "Tat ca error code nen duoc negative cache"

```text
SAI LAM:
  "Cache tat ca 4xx va 5xx de giam origin load."

THUC TE:
  CHI CACHE 4xx CO Y NGHIA BUSINESS, TUYET DOI KHONG CACHE 5xx.

  5xx (500, 502, 503, 504):
    -> La server errors
    -> Cache 500 = che giaU loi
    -> Origin khong nhan request -> khong phat hien broken
    -> Monitoring se thay "moi thu OK" nhung thuc te da chet
    -> Dung stale-if-error (serve stale 200 khi origin 500),
       KHONG PHAI negative cache cho 500

  4xx can phan biet:
    400 (Bad Request)   -> KHONG cache (moi bad request unique)
    401 (Unauthorized)  -> KHONG cache (auth thay doi)
    403 (Forbidden)     -> CAN NHAC KY (co the cache 5s)
    404 (Not Found)     -> CACHE (short TTL)
    410 (Gone)          -> CACHE (long TTL)
```

### Nghich ly 4: "Negative cache khong can observable"

```text
SAI LAM:
  "404 la 404, khong can X-Negative-Cache header."

THUC TE:
  Khong co X-Negative-Cache, monitoring khong the phan biet:

  "404 nay tu negative cache hay tu origin?"
  -> Khong biet duoc
  "Negative cache co dang offload origin khong?"
  -> Khong biet duoc
  "404 HIT ratio la bao nhieu?"
  -> Khong biet duoc

  X-Negative-Cache header la KEY cho observability:
  - Tach biet negative cache metrics khoi positive cache
  - Alert khi negative cache hit ratio thay doi
  - Debug khi co van de ve 404
```

## 14. Checklist

### Checklist chuan bi test

```text
TRUOC KHI CHAY CASE 11:

[ ] Topology TargetLayer=full da chay du
[ ] Varnish, Nginx, Go app deu healthy
    -> Kiem tra: GET http://localhost:80/health
[ ] Control path :8088 accessible
    -> Kiem tra: GET http://localhost:8088/health
[ ] OPS_AUTH_TOKEN da duoc set
[ ] Origin counters dang hoat dong
    -> Kiem tra: GET http://localhost:8088/ops/app/cdn/origin/request-counts
[ ] VCL chua negative caching logic
    -> Doc: E:/Projects/k6/k6-metrics-server/load-target/varnish/default.vcl
    -> Phai co: if (beresp.status == 404 || beresp.status == 410) { ... }
[ ] VCL khong cache 5xx
    -> Phai co: if (beresp.status >= 500) { set beresp.uncacheable = true; }
[ ] Handler GetCachedMissing hoat dong
    -> Kiem tra: GET http://localhost:80/api/cached/missing/test?ttl_seconds=5
    -> Phai tra 404 + X-Negative-Cache: true
```

### Checklist kiem tra ket qua

```text
TRONG KHI DOC OUTPUT:

[ ] k6 exit code = 0
[ ] Tat ca 7 checks PASS (100%)
[ ] Sequence: 404 MISS -> 404 HIT -> sleep -> 404 MISS
[ ] X-Negative-Cache: true tren MISS va HIT
[ ] Origin count = 1 sau phase 1
[ ] Origin count = 2 sau phase 2
[ ] Status code luon la 404 (khong bao gio 200)
[ ] Khong co unexpected errors trong log

NEU FAIL:

[ ] Xac dinh check nao fail?
[ ] "negative second cache state HIT" fail -> VCL khong cache 404
[ ] "negative after expiry cache state MISS" fail -> TTL dai qua / sleep ngan qua
[ ] Origin count sai -> counter logic hoac co concurrent requests
[ ] Khong co X-Negative-Cache -> VCL khong set header nay
```

## 15. 4-5 variations

### Variation 1: Negative TTL rat ngan (1-2s)

```text
MUC DICH: Test negative cache voi TTL cuc ngan de verify
         expire chinh xac o bien duoi.

THAY DOI:
  $env:NEGATIVE_TTL_SECONDS = "2"
  $env:NEGATIVE_WAIT_SECONDS = "3"

MONG DOI:
  - Negative cache van MISS -> HIT -> MISS
  - Origin count van 1 -> 2
  - Thoi gian chay nhanh hon (~5s)

Y NGHIA:
  - Chứng minh TTL duoc ton trong ngay ca o gia tri cuc nho
  - Phu hop cho resource co kha nang duoc tao rat nhanh
    (vi du: auto-generated content)
```

### Variation 2: Negative TTL dai (30s)

```text
MUC DICH: Test negative cache voi TTL dai hon de verify
         offload keo dai trong production.

THAY DOI:
  $env:NEGATIVE_TTL_SECONDS = "30"
  $env:NEGATIVE_WAIT_SECONDS = "32"

MONG DOI:
  - Negative cache MISS -> HIT -> (sleep 32s) -> MISS
  - Trong 30s, nhieu request deu HIT
  - Origin count van 1 -> 2

Y NGHIA:
  - Phu hop cho 410 Gone (resource da bi xoa vinh vien)
  - Cang TTL dai, cang offload tot nhung rui ro stale 404
  - Can balance giua offload va freshness
```

### Variation 3: Nhieu missing paths dong thoi

```text
MUC DICH: Test negative cache voi nhieu URL 404 khac nhau,
         dam bao isolation giua cac cache keys.

THAY DOI:
  Tao nhieu path khac nhau trong setup():

  const paths = [
    buildCachedMissingPath(`missing-a-${Date.now()}`, { ttl_seconds: 5 }),
    buildCachedMissingPath(`missing-b-${Date.now()}`, { ttl_seconds: 5 }),
    buildCachedMissingPath(`missing-c-${Date.now()}`, { ttl_seconds: 5 }),
  ];

  Sau do test MISS -> HIT -> origin count cho TUNG path.

MONG DOI:
  - Moi path co MISS -> HIT rieng biet
  - Origin count rieng cho tung path
  - Cache isolation: HIT cho path A KHONG anh huong path B

Y NGHIA:
  - Chứng minh cache key isolation cho negative cache
  - Moi URL 404 la mot cache object rieng
  - Khong bi leakage giua cac path khac nhau
```

### Variation 4: 410 Gone test

```text
MUC DICH: Test negative cache cho 410 Gone (resource da bi xoa vinh vien).

THAY DOI:
  Tao handler cho 410 Gone response:
  - Path: /api/cached/gone/{key}
  - Tra ve 410 Gone
  - Cache-Control: max-age=86400 (24h)
  - X-Negative-Cache: true

  Script:
  - Request 1: 410 MISS
  - Request 2: 410 HIT (ngay lap tuc)
  - Sleep 1s: van 410 HIT (vi TTL dai)
  - Origin count: 1 -> 1

MONG DOI:
  - 410 duoc cache voi TTL dai
  - Origin count chi = 1
  - Khac voi 404: TTL dai hon, khong can wait expire

Y NGHIA:
  - 410 Gone la use case hoan hao cho negative cache TTL dai
  - Resource da bi xoa -> khong co rui ro stale 404
  - Nen phan biet 404 vs 410 trong VCL
```

### Variation 5: Smoke — verify negative cache KHONG bi expire som

```text
MUC DICH: Verify negative cache giu object trong SUOT TTL window.

THAY DOI:
  - Request 1: 404 MISS
  - Request lien tuc moi 1s trong TTL window
  - Tat ca request giua deu phai HIT
  - Chi MISS lai sau TTL + grace

  for (let i = 0; i < NEGATIVE_TTL_SECONDS; i++) {
    const res = requestCdn('GET', path);
    assertStatus(res, 404);
    assertCacheState(res, 'HIT');  // Van HIT trong TTL
    sleep(1);
  }

MONG DOI:
  - Tat ca request trong TTL window deu HIT
  - Khong co unexpected eviction
  - Origin count van = 1

Y NGHIA:
  - Dam bao cache memory du lon, khong evict object som
  - Verifies consistency cua negative cache trong suot TTL
```

## 16. Anti-patterns

### Anti-pattern 1: Caching 500 errors

```text
ANTI-PATTERN:
  if (beresp.status >= 500) {
      set beresp.ttl = 10s;  // <-- SAI! Cache server error
  }

TAI SAO SAI:
  - 500 la server error, cache no = che giaU broken service
  - Origin co the crash roi tu recover nhung CDN van tra 500 cu
  - Monitoring se khong phat hien

CACH DUNG:
  if (beresp.status >= 500) {
      set beresp.ttl = 0s;
      set beresp.uncacheable = true;  // TUYET DOI KHONG CACHE
      return (deliver);
  }
  // Logic cho negative caching (404, 410) o DUOI
```

### Anti-pattern 2: Set negative TTL = positive TTL

```text
ANTI-PATTERN:
  // Ap dung cung TTL cho TAT CA status codes
  set beresp.ttl = 300s;  // 5 phut cho ca 200, 404, 410...

TAI SAO SAI:
  - 404 TTL = 5 phut -> resource moi tao trong 5 phut nay van thay 404
  - User click push notification -> 404 -> mat sale
  - Khong phan biet duoc expected vs stale 404

CACH DUNG:
  if (beresp.status == 404) {
      set beresp.ttl = 15s;   // Ngan
  } else if (beresp.status == 410) {
      set beresp.ttl = 86400s; // Dai (gone vinh vien)
  } else {
      set beresp.ttl = 60s;   // Positive cache
  }
```

### Anti-pattern 3: Khong phan biet 404 va 410

```text
ANTI-PATTERN:
  if (beresp.status == 404) {  // Chi cache 404, bo qua 410
      set beresp.ttl = 15s;
  }
  // 410 khong duoc cache -> MISS moi lan -> origin load

TAI SAO SAI:
  - 410 Gone la resource da bi xoa VINH VIEN
  - Khong co kha nang resource xuat hien tro lai
  - Day la use case HOAN HAO cho negative cache TTL dai
  - Khong cache 410 = bo phi co hoi offload

CACH DUNG:
  if (beresp.status == 404 || beresp.status == 410) {
      if (beresp.ttl <= 0s) {
          set beresp.ttl = (beresp.status == 410) ? 86400s : 15s;
      }
      set beresp.grace = 30s;
      set beresp.http.X-Negative-Cache = "true";
  }
```

### Anti-pattern 4: Khong co X-Negative-Cache header

```text
ANTI-PATTERN:
  if (beresp.status == 404) {
      set beresp.ttl = 15s;   // Cache nhung khong tag
  }
  // Thieu: set beresp.http.X-Negative-Cache = "true";

TAI SAO SAI:
  - Khong the phan biet 404 tu negative cache vs 404 tu origin
  - Monitoring khong the track negative cache hit ratio
  - Debug: khong biet 404 nay la HIT hay MISS
  - Khong the alert khi negative caching broken

CACH DUNG:
  if (beresp.status == 404 || beresp.status == 410) {
      set beresp.ttl = 15s;
      set beresp.http.X-Negative-Cache = "true";  // <-- PHAI CO
  }
```

### Anti-pattern 5: Khong xu ly grace cho negative cache

```text
ANTI-PATTERN:
  if (beresp.status == 404) {
      set beresp.ttl = 15s;
      // Thieu: khong set grace
  }

TAI SAO KHONG TOI UU:
  - Khong set grace -> khi origin unhealthy, 404 response khong
    duoc serve stale
  - Client co the nhan 503 thay vi 404
  - Trong truong hop nay, 404 grace van co ich:
    origin unhealthy -> serve 404 stale thay vi error

CACH DUNG (theo VCL hien tai):
  if (beresp.status == 404 || beresp.status == 410) {
      set beresp.ttl = 15s;
      set beresp.grace = 30s;   // Cho phep stale serving
      set beresp.keep = 120s;
      set beresp.http.X-Negative-Cache = "true";
  }
```

## 17. Real validation data

### Case catalog entry

```text
Case ID:          cdn-11-negative-caching
Script:           11-negative-caching.js (84 lines)
VUs:              1
Iterations:       1
Duration:         ~8-10s (default TTL=5, wait=6)
Sleep time:       6s (configurable via env)
Requests to CDN:  3 (1 MISS + 1 HIT + 1 MISS)
Origin hits:      2 (initial MISS + after-expiry MISS)
Checks:           7 (all must pass)
Thresholds:       checks rate == 1

Env vars:
  NEGATIVE_TTL_SECONDS   = 5 (default)  -- TTL of negative cache
  NEGATIVE_WAIT_SECONDS  = 6 (default)  -- wait time = TTL + 1
  BASE_URL               = http://localhost:80
  CONTROL_BASE_URL       = http://localhost:8088
  OPS_AUTH_TOKEN         = <ops-token>
```

### Key paths used

```text
Public path:
  /api/cached/missing/{key}?ttl_seconds={n}
  -> Handler: GetCachedMissing
  -> Tra ve: 404 JSON, X-Negative-Cache: true

Control paths:
  GET  /ops/app/cdn/origin/request-counts
  POST /ops/app/cdn/origin/request-counts/reset
  POST /ops/app/cdn/origin/reset
  POST /ops/app/cdn/cache/ban-url
```

### Shared helpers used

```text
buildCachedMissingPath(key, params)  -> /api/cached/missing/{key}?...
requestCdn(method, path, options)    -> HTTP request to CDN
banUrl(url)                          -> Invalidate specific URL
assertStatus(res, expected, label)   -> Check HTTP status
assertCacheState(res, expected, label) -> Check HIT/MISS
assertHeaderEquals(res, name, expected, label) -> Check header value
getOriginRequestCounts()             -> Get all origin counters
findOriginRequestCount(counts, key)  -> Find specific counter
resetOriginRequestCounts()           -> Reset all counters to 0
resetOriginProfile()                 -> Reset origin profile
```

### VCL contract verified

```text
vcl_backend_response lines 211-219:
  if (beresp.status == 404 || beresp.status == 410) {
      if (beresp.ttl <= 0s) {
          set beresp.ttl = 15s;
      }
      set beresp.grace = 30s;
      set beresp.keep = 120s;
      set beresp.http.X-Negative-Cache = "true";
      return (deliver);
  }

vcl_backend_response lines 205-209:
  if (beresp.status >= 500) {
      set beresp.ttl = 0s;
      set beresp.uncacheable = true;
      return (deliver);
  }

Contract verified:
  - 404/410: cached with default 15s TTL + X-Negative-Cache header
  - 5xx: never cached (uncacheable=true)
  - Origin-set TTL honored over VCL default
```

### Go handler contract verified

```text
GetCachedMissing (cdn_cached_endpoints.go lines 117-139):
  - Path: /api/cached/missing/:key
  - Increments origin counter (atomically, before processing)
  - Supports query params: ttl_seconds, stale_if_error_seconds, origin_delay_ms
  - Sets Cache-Control with requested TTL
  - Sets X-Negative-Cache: true
  - Sets X-Origin-Request-Count: {count}
  - Returns 404 JSON: { success: false, error: "cached object not found",
    cacheable_not_found: true }
```

## 18. Reference

- **Run guide:** `./RUN_GUIDE.md`
- **Overview:** `./00_overview.md`
- **Source case catalog:** `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/case-catalog.json`
- **Source script:** `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/11-negative-caching.js`
- **Shared helpers:** `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js`
- **VCL source:** `E:/Projects/k6/k6-metrics-server/load-target/varnish/default.vcl`
- **Go handler:** `E:/Projects/k6/k6-metrics-server/load-target/handlers/cdn_cached_endpoints.go`
- **Series roadmap:** `E:/Projects/k6/k6-metrics-server/load-target/k6/layer-roadmap.md`

---

> **Mental model:** Negative caching la mot CO CHE PHONG THU. Trong khi positive cache
> giup serve 200 nhanh hon, negative cache bao ve origin khoi bi spam boi 404 traffic
> lap lai. CDN dung ra hứng chiu impact cua traffic xau thay cho origin. Day la
> pure CDN-edge behavior: app chi tra ve 404, CDN la noi quyet dinh co cache 404
> do hay khong. Origin request counters la bang chung khong the tranh cai cho
> viec offload nay.
