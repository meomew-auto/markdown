# Case 11: Negative Caching

> **Case ID:** `cdn-11-negative-caching`
> **Script:** `11-negative-caching.js`
> **Layer:** CDN / Varnish
> **Proof:** expected 404 is cached briefly, expires correctly, protects origin from repeated invalid requests

## 1. Tình huống thực tế

### Kẻ tấn công và máy khách buggy

Một kẻ tấn công — hoặc đơn giản là một con bot crawl bị cấu hình sai, một client SDK bị
loop retry, hay một trình duyệt cũ của người dùng liên tục gọi lại URL bị hỏng — bắt đầu
bom request đến những product ID không tồn tại:

```text
GET /api/products/9999999 -> 404
GET /api/products/9999999 -> 404  (lại)
GET /api/products/9999999 -> 404  (lại nữa)
GET /api/products/8888888 -> 404  (ID khác cũng không tồn tại)
GET /api/products/8888888 -> 404  (lại)
... 10,000 requests nữa cho hàng nghìn ID không tồn tại khác
```

Tưởng tượng 10,000 requests, 10,000 product IDs khác nhau, tất cả đều 404.
Không một request nào có sản phẩm thực sự. Không một request nào đem lại doanh thu.

### Điều gì xảy ra nếu KHÔNG CÓ negative caching?

```text
Client                CDN/Varnish              Origin (App + DB)
  |                      |                         |
  |--- GET /prd/9999 -->|                         |
  |                      |--- GET /prd/9999 ------>|
  |                      |                         |--- SELECT * FROM products WHERE id=9999
  |                      |                         |--- DB trả về: 0 rows (not found)
  |                      |                         |--- App logic: kiểm tra cache, check cache
  |                      |                         |          warmer, validate input, build
  |                      |                         |          response body, log, metrics
  |                      |<--- 404 JSON -----------|
  |<--- 404 MISS -------|                         |
  |                      |                         |
  |--- GET /prd/9999 -->|  (lại, request thứ 2)   |
  |                      |--- GET /prd/9999 ------>|  <-- LẠI VÀO ORIGIN!
  |                      |                         |--- LẠI SELECT * FROM products...
  |                      |                         |--- LẠI 0 rows
  |                      |                         |--- LẠI toàn bộ pipeline xử lý
  |                      |<--- 404 JSON -----------|
  |<--- 404 MISS -------|                         |
  |                      |                         |
  |--- GET /prd/8888 -->|  (ID khác, cùng lỗi)    |
  |                      |--- GET /prd/8888 ------>|  <-- VÀO ORIGIN LẦN NỮA!
  |                      |                         |--- LẠI SELECT... LẠI 0 rows...
```

**Mỗi request 404 đều MISS và đi thẳng tới origin.** Origin phải:

```text
1. Nhận HTTP request từ Varnish
2. Parse URL, extract product ID
3. Validate input (ID có hợp lệ không?)
4. Query database: SELECT * FROM products WHERE id = ?
5. Database scan index, trả về 0 rows
6. App tạo JSON response body: { "success": false, "error": "not found" }
7. Serialize JSON
8. Gửi response về Varnish
9. Ghi log
10. Emit metrics
```

Mỗi bước trên tiêu tốn CPU, memory, database connection, I/O. Với 10,000 request
404, origin tiêu tốn **tài nguyên như phục vụ 10,000 request 200** — nhưng giá trị
kinh doanh mang lại **bằng 0**.

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

### Phân biệt các nguồn gốc của 404 traffic

404 requests có thể đến từ nhiều nguồn khác nhau, và mỗi nguồn có ảnh hưởng
khác nhau đến origin:

```text
NGUỒN 404                    TẦN SUẤT        ẢNH HƯỞNG ĐẾN ORIGIN
───────────────────────────  ──────────────  ──────────────────────────
Broken internal links        Thấp - Trung    Tương đối thấp
(app link sai)                               (chỉ user click mới bị)

Old external links           Trung - Cao     Cao
(SEO backlink cũ)                            (Google bot crawl liên tục)

Bot scanning / crawling      Cao             Rất cao
(Googlebot, Ahrefs, ...)                     (50k+ requests/ngày)

Malicious scanning           Không đoán      RẤT CAO
(DDoS, vulnerability probe)  trước được      (Có thể là tấn công thực sự)

Client retry loop            Đột biến        Cao đột biến
(SDK bug, network error)                     (Có thể 10k requests/s)

Deleted product IDs          Vừa phải        Vừa phải
(business-as-usual)                          (Traffic từ user thật)
```

Nếu không có negative caching, TẤT CẢ các nguồn này đều bị origin xử lý như nhau.
Origin không thể phân biệt "request này là từ user thật click broken link" hay
"request này là từ bot tấn công".

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

## 3. Vì sao test ở CDN layer

### Negative caching là chính sách CỦA CDN

Đây là một điểm quan trọng mà nhiều người bỏ qua:

```text
App/Origin                     CDN/Varnish                   Client
───────────────                ────────────────               ─────────
App chỉ biết:                  CDN quyết định:               Client thấy:
"Có request,                   404 này có cache              "404 Not Found"
tao xử lý,                      không?
trả về 404"                    Cache bao lâu?
                               (bao nhiêu giây?)

App KHÔNG quyết định           CDN LÀ NƠI DUY NHẤT           Client không biết
404 có được cache              quyết định chính              (và không cần biết)
hay không                       sách negative               CDN đã cache response
                               caching                      này hay chưa
```

App chỉ trả về HTTP 404. App không thể ra lệnh: "hãy cache cái 404 này."
CDN/Varnish là nơi quyết định:

1. **Có cache 404 không?** — Quyết định trong `vcl_backend_response`:
   ```vcl
   if (beresp.status == 404 || beresp.status == 410) {
       set beresp.ttl = 15s;   // <-- CDN quyết định cache 15s
   }
   ```

2. **Cache bao lâu?** — TTL là policy của CDN, không phải của app:
   - 404 (not found): 15s — ngắn, resource có thể được tạo ra sau vài giây
   - 410 (gone): 86400s (24h) — resource đã bị xóa vĩnh viễn, cache lâu hơn
   - 403 (forbidden): 0s (không cache) — vì authorization có thể thay đổi

3. **Header X-Negative-Cache** — CDN đánh dấu để observability:
   ```vcl
   set beresp.http.X-Negative-Cache = "true";
   ```

### Tại sao KHÔNG TEST Ở APP LAYER?

```text
NẾU TEST Ở APP LAYER:
  -> App trả 404 -> test pass
  -> Nhưng KHÔNG BIẾT CDN có cache 404 này không
  -> Nhưng KHÔNG BIẾT TTL của negative cache là bao nhiêu
  -> Nhưng KHÔNG BIẾT X-Negative-Cache header có được thêm vào không
  -> Nhưng KHÔNG BIẾT negative cache có expire đúng hạn không
  -> App-layer test không thể trả lời bất kỳ câu hỏi CDN nào

TEST Ở CDN LAYER:
  -> Request qua CDN (http://localhost:80)
  -> Kiểm tra X-Cache: HIT hay MISS
  -> Kiểm tra X-Negative-Cache: true
  -> Kiểm tra origin counter: 1 -> 1 -> 2
  -> Kiểm tra status code vẫn là 404 (không bị CDN biến thành 200)
  -> Đây là những thông tin CHỈ CÓ Ở CDN layer
```

Negative caching thuộc về **CDN-edge behavior**. Nó là một chính sách mà CDN
vận hành độc lập với application. Test ở app layer có thể biết app trả 404 đúng,
nhưng không thể biết CDN có bảo vệ origin khỏi 404 traffic lặp lại hay không.

### VCL là nơi duy nhất quyết định

```text
BOX: AI QUYẾT ĐỊNH VIỆC NEGATIVE CACHING?

 App (Go/Python/Node)  -->  Chỉ trả về HTTP status code
                             App không thể set "hãy cache
                             cái 404 này trong 15s"
                             (App có thể set Cache-Control
                             nhưng CDN override trong VCL)

 VCL (Varnish config)  -->  LÀ NƠI QUYẾT ĐỊNH DUY NHẤT:
                             - Status code nào được negative-cache?
                             - TTL bao nhiêu?
                             - Có tag X-Negative-Cache không?
                             - Có cho phép grace (stale serving)
                               cho negative cache không?

 => VCL là single source of truth cho negative caching policy
 => Test CDN layer là cách DUY NHẤT để verify policy này hoạt động
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

Event path: không sử dụng trong case này
```

### Precondition

```text
1. Origin counters được reset về 0
   POST /ops/app/cdn/origin/request-counts/reset

2. Origin profile được reset về default
   POST /ops/app/cdn/origin/reset

3. Đường dẫn missing được tạo động để đảm bảo isolated test:
   buildCachedMissingPath("missing-{timestamp}", { ttl_seconds: 5 })
   -> /api/cached/missing/missing-1734567890?ttl_seconds=5

   Tại sao cần dynamic path?
   - Tránh pollution từ previous runs
   - Mỗi lần chạy là một test sạch, không bị ảnh hưởng bởi cache cũ
   - Timestamp đảm bảo uniqueness

4. Ban URL để xóa cache cũ (nếu có):
   POST /ops/app/cdn/cache/ban-url { url: "/api/cached/missing/missing-..." }
```

### buildCachedMissingPath() — path tạo 404 expected

```text
buildCachedMissingPath(key, params) trả về:

  /api/cached/missing/{key}?ttl_seconds={n}&stale_if_error_seconds={m}

Handler Go (GetCachedMissing):
  1. Nhận request
  2. Increment origin counter cho path này
  3. Nếu có origin_delay_ms -> sleep
  4. Set Cache-Control header: public, max-age={ttl}, s-maxage={ttl},
     stale-if-error={stale_if_error}
  5. Set X-Negative-Cache: true
  6. Set X-Origin-Request-Count: {count}
  7. Trả về HTTP 404 JSON: { success: false, error: "cached object not found",
     cacheable_not_found: true, request_key: "..." }

Đây LÀ expected 404: app xử lý bình thường, trả về lỗi "không tìm thấy",
đánh dấu object này có thể cache được (cacheable_not_found: true).
```

## 5. Script deep-dive

### Tổng quan script

Script `11-negative-caching.js` (84 lines) là một sequence test chính xác, tương tự
như case 08 (TTL expiry) và case 09 (stale-while-error): `vus=1, iterations=1`.
Nó chạy một sequence các request chính xác, kiểm tra từng response một.

```text
vus: 1, iterations: 1  -->  Một VU duy nhất chạy toàn bộ sequence
                            Không cần nhiều VU vì đây là correctness test,
                            không phải load test
```

### setup() — Chuẩn bị môi trường sạch

```javascript
export function setup() {
  // Tạo dynamic path để tránh cache pollution
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

**Phase 1: Tạo negative cache + verify HIT**

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

**Verification #2: Origin count tăng lên 2**

```javascript
counts = getOriginRequestCounts();
requestCount = findOriginRequestCount(counts, path);
if (requestCount !== 2) {
  throw new Error(
    `expected negative cached path ${path} to hit origin twice after expiry, got ${requestCount}`
  );
}
```

**Teardown: Dọn dẹp**

```javascript
export function teardown() {
  resetOriginProfile();
  resetOriginRequestCounts();
}
```

### Bảng tổng kết sequence

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
  -> TTL cho negative cache. Object 404 sẽ được cache trong N giây này.
  -> Truyền vào buildCachedMissingPath() để set Cache-Control header của origin.

NEGATIVE_WAIT_SECONDS  (default: NEGATIVE_TTL_SECONDS + 1, tức là 6)
  -> Thời gian sleep để đảm bảo negative cache đã hết hạn.
  -> +1s là safety margin — đảm bảo object chắc chắn đã expired.
  -> NOTE: Trong VCL, negative TTL mặc định là 15s. Nhưng script override
     bằng cách set ?ttl_seconds=5 trong query string, origin set Cache-Control
     tương ứng, VCL tôn trọng Cache-Control từ origin.
```

### Lưu ý về TTL interaction

```text
Mắt xích quan trọng: TTL từ origin (qua Cache-Control header) vs VCL default.

Origin (GetCachedMissing handler):
  -> Set Cache-Control: public, max-age={ttl}, s-maxage={ttl}
  -> Với ttl_seconds=5: max-age=5, s-maxage=5

VCL (vcl_backend_response):
  -> Đọc beresp.ttl từ Cache-Control của origin
  -> Nếu beresp.status == 404 && beresp.ttl <= 0s:
     set beresp.ttl = 15s  (VCL default)
  -> Nếu beresp.status == 404 && beresp.ttl > 0s:
     KHÔNG override — tôn trọng TTL từ origin

  => Khi origin set max-age=5, VCL tôn trọng, negative TTL = 5s
  => Khi origin không set (ttl <= 0), VCL set default = 15s
```

## 6. Negative caching model deep-dive

### Status codes nào nên được negative-cache

Đây là câu hỏi kiến trúc quan trọng nhất của negative caching.
**Không phải error code nào cũng nên cache.** Quyết định dựa vào
ý nghĩa kinh doanh và khả năng thay đổi của resource.

```text
BẢNG: STATUS CODE VÀ QUYẾT ĐỊNH NEGATIVE CACHING
──────────────────────────────────────────────────────────────────────

NÊN NEGATIVE-CACHE (expected business outcomes):
──────────────────────────────────────────────
  STATUS    | Ý NGHĨA              | TTL GỢI Ý    | LÝ DO
  ──────────┼──────────────────────┼──────────────┼──────────────────
  404       | Not Found            | 1s - 60s     | Resource chưa
            |                      | (thường 15s) | tồn tại, nhưng có
            |                      |              | thể được tạo ra
            |                      |              | SỚM. TTL ngắn để
            |                      |              | tránh stale 404.
  ──────────┼──────────────────────┼──────────────┼──────────────────
  410       | Gone                 | 1h - 24h     | Resource đã bị xóa
            |                      |              | VĨNH VIỄN. Không
            |                      |              | có khả năng xuất
            |                      |              | hiện trở lại.
            |                      |              | TTL dài hơn 404.
  ──────────┼──────────────────────┼──────────────┼──────────────────
  403       | Forbidden            | 0s - 10s     | CÂN NHẮC KỸ.
            | (carefully)          |              | Authorization có
            |                      |              | thể thay đổi khi
            |                      |              | user login. Chỉ
            |                      |              | cache 403 nếu là
            |                      |              | resource thực sự
            |                      |              | không thể truy
            |                      |              | cập (blocked geo).
  ──────────┼──────────────────────┼──────────────┼──────────────────
  400       | Bad Request          | HẦU NHƯ      | Request bị lỗi do
            | (rarely)             | KHÔNG BAO GIỜ| client sai format.
            |                      |              | Mỗi bad request
            |                      |              | là unique. Cache
            |                      |              | không có ý nghĩa.

KHÔNG ĐƯỢC NEGATIVE-CACHE (server errors):
──────────────────────────────────────────
  STATUS    | Ý NGHĨA              | LÝ DO KHÔNG ĐƯỢC CACHE
  ──────────┼──────────────────────┼────────────────────────────────
  500       | Internal Server      | Đây là LỖI HỆ THỐNG. Cache 500
            | Error                | sẽ CHE GIẤU lỗi, khiến team
            |                      | không phát hiện ra vấn đề.
            |                      | Origin cần thấy mọi 500 để debug.
  ──────────┼──────────────────────┼────────────────────────────────
  502       | Bad Gateway          | Upstream service đang down.
            |                      | Cache 502 = fake "OK" khi
            |                      | upstream thực sự chết.
            |                      | Dùng stale-if-error thay vì cache.
  ──────────┼──────────────────────┼────────────────────────────────
  503       | Service Unavailable  | Maintenance hoặc overload.
            |                      | Nếu cache 503, user sẽ tưởng
            |                      | service down vĩnh viễn.
            |                      | Dùng stale-if-error thay vì cache.
  ──────────┼──────────────────────┼────────────────────────────────
  504       | Gateway Timeout      | Không cache — cần retry.
```

### Cách VCL hiện thực hóa negative caching

VCL là single source of truth cho negative caching policy. Đây là logic
trong `vcl_backend_response` của dự án:

```vcl
sub vcl_backend_response {
    // (1) Server errors (500+) — TUYỆT ĐỐI KHÔNG CACHE
    if (beresp.status >= 500) {
        set beresp.ttl = 0s;
        set beresp.uncacheable = true;
        return (deliver);
    }

    // (2) Negative caching cho 404 và 410
    if (beresp.status == 404 || beresp.status == 410) {
        if (beresp.ttl <= 0s) {
            set beresp.ttl = 15s;  // Default negative TTL
        }
        set beresp.grace = 30s;    // Cho phép stale serving khi
        set beresp.keep = 120s;    // origin unhealthy
        set beresp.http.X-Negative-Cache = "true";
        return (deliver);
    }

    // (3) Response có Set-Cookie -> private, không cache
    if (beresp.http.Set-Cookie) {
        set beresp.ttl = 0s;
        set beresp.uncacheable = true;
        return (deliver);
    }

    // (4) Cache-Control: no-store|private -> tuân thủ
    if (beresp.http.Cache-Control ~ "(?i)no-store|private") {
        set beresp.ttl = 0s;
        set beresp.uncacheable = true;
        return (deliver);
    }

    // (5) Fallback TTLs cho các path không có cache header
    // ...
}
```

### Phân tích VCL logic

```text
THỨ TỰ XỬ LÝ (quan trọng):
───────────────────────────
1. 500+ -> KHÔNG cache (exit sớm nhất)
   Điều này ĐẢM BẢO server errors không bao giờ bị cache, dù app có
   set Cache-Control thế nào đi nữa. VCL override app cho 5xx.

2. 404/410 -> NEGATIVE cache
   - Nếu app đã set TTL (qua Cache-Control) -> tôn trọng TTL của app
   - Nếu app không set TTL -> VCL set default 15s
   - Luôn set X-Negative-Cache: true (observability)
   - Luôn set grace=30s (cho phép stale serving)
   - Luôn set keep=120s (giữ object trong cache để phục vụ grace)

   Grace cho negative cache? Tại sao?
   -> Nếu origin gặp lỗi (500), CDN có thể serve 404 từ cache
      thay vì pass error 500 đến client. Đây là "stale-if-error"
      nhưng áp dụng cho cả negative cache.
   -> 404 stale vẫn là 404 — tốt hơn là 500.

3. Set-Cookie -> KHÔNG cache
   Response có Set-Cookie là private, không thể cache ở shared cache.

4. no-store|private -> KHÔNG cache
   Tuân thủ Cache-Control directive từ origin.

5. Fallback TTLs -> Chỉ cho path cụ thể
```

### TTL cho negative cache: tại sao NGẮN?

```text
SO SÁNH TTL:

Positive cache (200 OK):
  /api/sim/products/1              TTL = 90s
  /api/sim/products/categories     TTL = 300s
  /api/sim/products/homefeed       TTL = 20s
  Mục đích: serve nhanh, giảm origin load

Negative cache (404/410):
  /api/cached/missing/*            TTL = 15s (default)
  /api/sim/products/999999         TTL = 15s (default)
  Mục đích: bảo vệ origin, nhưng không block resource mới

  Tại sao TTL NGẮN?
  ┌──────────────────────────────────────────────────────────────┐
  │ Tình huống: Product ID 99999 chưa tồn tại lúc 10:00:00      │
  │ CDN cache 404 với TTL = 15s                                  │
  │                                                              │
  │ Nếu TTL = 300s (5 phút):                                     │
  │   Admin tạo product ID 99999 lúc 10:00:30                    │
  │   User request ID 99999 lúc 10:01:00                         │
  │   -> Vẫn thấy 404 HIT (stale!)                               │
  │   -> Product thực sự đã tồn tại nhưng CDN vẫn trả 404        │
  │   -> Mất doanh thu trong 4.5 phút                            │
  │                                                              │
  │ Nếu TTL = 15s:                                               │
  │   Admin tạo product ID 99999 lúc 10:00:30                    │
  │   User request ID 99999 lúc 10:01:00                         │
  │   -> Cache đã expire -> MISS -> origin -> 200 OK             │
  │   -> User thấy product thật                                  │
  │   -> Chỉ mất tối đa 15s, không phải 5 phút                   │
  │                                                              │
  │ Rule of thumb:                                               │
  │   TTL negative = MIN(thời gian tối đa có thể có resource     │
  │                      mới được tạo, 60s)                      │
  │   404: 1-60s vì resource có thể được tạo mới                 │
  │   410: 86400s+ vì resource đã bị xóa vĩnh viễn               │
  └──────────────────────────────────────────────────────────────┘
```

### X-Negative-Cache header — observability signal

```text
X-Negative-Cache: true

Header này được VCL thêm vào CHO MỌI RESPONSE có nguồn gốc từ negative cache,
dù là HIT hay MISS. Nó là cờ hiệu để monitoring tools biết:

  "Response này là 404, và nó CÓ THỂ đã được cache."
  (Khác với 404 từ app mà CDN quyết định KHÔNG cache.)

Sử dụng X-Negative-Cache:
  - Alert: nếu tỉ lệ X-Negative-Cache HIT giảm -> negative caching broken
  - Debug: biết ngay response từ negative cache hay từ origin
  - Dashboard: theo dõi negative cache hit ratio riêng biệt với positive cache

Lưu ý: Response MISS vẫn có X-Negative-Cache: true vì origin đã set header
này. VCL chỉ ADD header này nếu chưa có từ origin, hoặc OVERRIDE nếu origin
không set.
```

### Grace và Keep cho negative cache

```text
GRACE (30s) cho negative cache:
  Nếu origin unhealthy (backend probe fail):
    -> CDN serve 404 stale TỪ CACHE
    -> Client vẫn nhận 404 (đúng với thực tế)
    -> KHÔNG pass error 503/502 đến client
  Grace cho negative cache ít quan trọng hơn grace cho positive cache
  (404 stale không có giá trị kinh doanh), nhưng vẫn tốt hơn 500.

KEEP (120s) cho negative cache:
  Giữ object trong cache sau khi hết hạn để có thể serve grace.
  Sau 120s, object bị xóa hoàn toàn khỏi cache.
```

### Cách set negative TTL theo status code

### Tương tác giữa origin Cache-Control và VCL default TTL

Một điểm quan trọng trong negative caching là **ai là nguồn sự thật cho TTL**:
origin (qua Cache-Control header) hay VCL (qua `set beresp.ttl`)?

```text
THỨ TỰ ƯU TIÊN:

1. Origin Cache-Control header (ưu tiên cao nhất)
   Nếu origin set Cache-Control: max-age=5, s-maxage=5
   -> beresp.ttl = 5s (Varnish tự động parse)
   -> VCL kiểm tra: if (beresp.ttl <= 0s) => FALSE (5 > 0)
   -> VCL KHÔNG override => TTL = 5s
   => Origin quyết định TTL

2. VCL default (fallback)
   Nếu origin KHÔNG set Cache-Control headers
   -> beresp.ttl = 0s (Varnish default)
   -> VCL kiểm tra: if (beresp.ttl <= 0s) => TRUE
   -> VCL set: set beresp.ttl = 15s
   => VCL quyết định TTL = 15s

3. VCL override (kiểm soát tuyệt đối - cẩn thận!)
   Nếu VCL muốn LUÔN set TTL riêng, bất chấp origin:
   set beresp.ttl = 15s;  // Không kiểm tra điều kiện
   => VCL LUÔN quyết định TTL
   => Nhưng mất đi sự linh hoạt của origin
```

### Tại sao tôn trọng origin Cache-Control là quan trọng?

```text
Lợi ích của việc origin set TTL:
  - App developer biết rõ nhất TTL phù hợp
  - Ví dụ: product detail page -> 90s
  - Ví dụ: health check -> 1s
  - Ví dụ: negative cache -> 5s (theo script)
  - VCL chỉ là safety net (default 15s khi origin không set)

Lợi ích của việc VCL có default:
  - Origin developer có thể QUÊN set Cache-Control
  - VCL default đảm bảo negative cache luôn hoạt động
  - Giảm operational risk
  - Tránh trường hợp "quên set -> không cache -> origin bị tấn công"

Pattern tối ưu (như trong dự án này):
  Origin: set Cache-Control với TTL phù hợp
  VCL:    if (beresp.ttl <= 0s) { set beresp.ttl = 15s; }
         // Chỉ override khi origin không set
         // Tôn trọng origin khi origin set

  => Origin developer control TTL
  => VCL là safety net
```

### Lỗi thường gặp: VCL LUÔN set TTL mà không kiểm tra

```text
ANTI-PATTERN:
  if (beresp.status == 404) {
      set beresp.ttl = 15s;  // LUÔN set, bỏ qua origin Cache-Control
  }

  Với cách này:
  - Origin set Cache-Control: max-age=2 -> VẪN bị VCL override thành 15s
  - Origin set Cache-Control: max-age=60 -> VẪN bị VCL override thành 15s
  - Origin KHÔNG thể kiểm soát TTL
  - Case 11 script set ?ttl_seconds=5 -> bị VCL ignore -> TTL thực sự là 15s
    -> NEGATIVE_WAIT_SECONDS=6 < 15s -> test FAIL vì chưa expire!

PATTERN ĐÚNG (như dự án này):
  if (beresp.status == 404 || beresp.status == 410) {
      if (beresp.ttl <= 0s) {
          set beresp.ttl = 15s;  // Chỉ set khi origin KHÔNG set
      }
  }

  Với cách này:
  - Origin set Cache-Control: max-age=5 -> beresp.ttl = 5s (tôn trọng origin)
  - Origin KHÔNG set -> beresp.ttl = 0s -> VCL set 15s (safety net)
  - Case 11 script set ?ttl_seconds=5 -> TTL đúng = 5s -> test PASS
```

### Cách set negative TTL theo status code

```text
PATTERN: Phân biệt TTL theo status code:

404 (Not Found):
  Default TTL: 15s
  Lý do: resource có thể được tạo mới bất cứ lúc nào
  Config VCL: set beresp.ttl = 15s

410 (Gone):
  Default TTL: 86400s (24h) hoặc dài hơn
  Lý do: resource đã bị xóa vĩnh viễn, không quay lại
  Config VCL (thêm vào):
    if (beresp.status == 410) {
        set beresp.ttl = 86400s;
    }

403 (Forbidden) — chỉ khi chắc chắn:
  Default TTL: 5s (rất ngắn)
  Lý do: authorization có thể thay đổi (user login)
  Chỉ cache 403 cho geo-blocked nội dung hoặc IP-ban
  Thêm điều kiện kiểm tra trước khi cache 403.

5xx: KHÔNG BAO GIỜ CACHE
  Config VCL: set beresp.ttl = 0s; set beresp.uncacheable = true
```

## 7. Negative vs Positive cache comparison

### Bảng so sánh toàn diện

```text
THUỘC TÍNH          POSITIVE CACHE              NEGATIVE CACHE
─────────────────── ─────────────────────────── ───────────────────────────
Status code        200 (OK), 304 (Not Modified) 404 (Not Found), 410 (Gone)

TTL                20s - 300s (phút)            1s - 60s (giây), 410: dài hơn

Mục đích chính     PERFORMANCE                  DEFENSE
                   Tăng tốc độ serve,           Bảo vệ origin khỏi
                   giảm origin load cho          traffic xấu/lỗi lặp lại
                   nội dung thực sự

Surrogate-Key      CÓ                           THƯỜNG KHÔNG CẦN
                   Để invalidate khi            Vì 404 không có nội dung
                   nội dung thay đổi             để invalidate; TTL ngắn
                                                tự giải quyết

Grace (stale)      120s (phục vụ khi            30s (phòng hờ)
                   origin unhealthy)            Ít quan trọng hơn nhưng
                                                vẫn có mặt

Keep               600s (giữ trong cache)       120s

Header đánh dấu    Không cần header đặc biệt    X-Negative-Cache: true

Cache key          Path + variant headers       Path (thường không cần
                   (language, geo, device...)    variant vì 404 là 404)

Hit ratio target   90-99% (cao)                 Không đặt target cao vì
                                                TTL ngắn + ít traffic 404

Rủi ro nếu quá     STALE DATA                   STALE 404
TTL dài            User thấy nội dung cũ        Resource mới đã được tạo
                   (giá sai, tồn kho sai)       nhưng CDN vẫn trả 404
                   -> Mất doanh thu             -> Mất doanh thu
                                                (nhưng window ngắn hơn)

Rủi ro nếu quá     Origin phải xử lý thêm       Origin bị spam 404
TTL ngắn           200 requests                 -> Tốn tài nguyên
                   -> Tốn tài nguyên            -> Giảm performance

Chi phí nếu        Nặng (origin load cho        Nặng (origin load cho
KHÔNG CÓ           200 requests)                404 requests)
                   User chậm hơn                User thấy 404 sau hơn
                                                Origin dễ bị tấn công hơn

Tầm quan trọng     RẤT CAO                      TRUNG BÌNH - CAO
cho production     Mọi request 200 đều          Nếu không có, origin
                   hưởng lợi từ cache           có thể bị DDoS bởi
                                                chính traffic 404
```

### Hai mục đích, hai cách nghĩ

```text
POSITIVE CACHING                      NEGATIVE CACHING
─────────────────────                 ─────────────────────
"Làm sao để serve nhanh nhất?"        "Làm sao để origin không bị
                                       tổn hại bởi request rải rác?"

Optimization mindset                  Defense mindset
Trước focus: FE, user experience      Trước focus: Backend stability,
                                       resource protection

KPIs:                                 KPIs:
- Cache hit ratio                     - Negative hit ratio
- Time to first byte                  - Origin request count
- Page load time                      - 404 origin offload %
- Origin offload % (positive)         - False 200 rate (= 404 là 200)

Tool: CDN monitoring dashboard        Tool: Origin counter + CDN logs
                                       + X-Negative-Cache header
```

## 8. Origin request counting proof

### Origin counters — THE evidence

Giống như case 09 (stale-while-error) và case 10 (request coalescing),
**origin request counters là bằng chứng không thể tranh cãi** cho negative caching.

```text
NGUYÊN TẮC:
  - Mỗi MISS -> origin nhận request -> counter++ (qua incrementCDNOriginCount)
  - Mỗi HIT -> origin KHÔNG nhận request -> counter KHÔNG tăng
  - Dựa vào counter, ta biết CHÍNH XÁC số lần origin bị gọi

PATH ĐẾM:
  GET  /ops/app/cdn/origin/request-counts        -> lấy counter hiện tại
  POST /ops/app/cdn/origin/request-counts/reset  -> reset về 0
```

### Increment logic trong Go handler

```go
func (h *Handler) GetCachedMissing(c *gin.Context) {
    // Tạo key từ URL path để đếm
    requestKey := normalizeCDNOriginRequestKey(c.Request.URL.RequestURI())

    // INCREMENT COUNTER TRƯỚC KHI XỬ LÝ
    requestCount, _ := h.incrementCDNOriginCount(ctx, requestKey)

    // Sau đó mới xử lý delay, set headers, trả 404
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

### Increment là atomic và trước khi xử lý

```text
Tại sao increment TRƯỚC khi xử lý request?
  -> Đảm bảo counter luôn đếm đúng, kể cả khi handler panic hoặc
     request bị cancel giữa chừng
  -> Nếu increment sau xử lý, request fail giữa chừng sẽ không được đếm
     -> "Origin không bị hit" là sai (origin đã bị hit, chỉ là không
        hoàn thành request)

Tại sao dùng requestKey = normalize URL?
  -> Để tìm chính xác counter cho path cụ thể
  -> Tránh bị ảnh hưởng bởi query string khác nhau
  -> findOriginRequestCount(counts, path) tìm trong array counts
     theo request_key
```

### Count verification sequence

```text
Phase-by-phase verification:

AFTER SETUP (reset):
  getOriginRequestCounts() -> findOriginRequestCount(counts, path) = 0

AFTER PHASE 1 (request #1 MISS, request #2 HIT):
  getOriginRequestCounts() -> findOriginRequestCount(counts, path) PHẢI = 1
  Nếu = 0: origin chưa bao giờ được gọi (không thể có 404 MISS)
  Nếu = 2: negative cache không hoạt động (MISS cả 2 lần)
  Nếu = 1: ĐÚNG -> chỉ 1 origin hit, lần 2 là HIT từ negative cache

AFTER PHASE 2 (request #3 sau sleep):
  getOriginRequestCounts() -> findOriginRequestCount(counts, path) PHẢI = 2
  Nếu = 1: negative cache chưa expire? sleep chưa đủ? TTL dài hơn dự kiến?
  Nếu = 3: có thêm request nào đó không mong muốn?
  Nếu = 2: ĐÚNG -> thêm 1 origin hit sau khi negative cache expire
```

### Counter là bằng chứng của offload

```text
OFFLOAD PROOF:

Nếu không có negative caching:
  3 requests -> 3 origin hits -> counter = 3
  Offload = 0%

Có negative caching:
  3 requests -> 2 origin hits -> counter = 2
  Offload = 1/3 = 33%

Nếu scale lên 10,000 requests trong 15s window (cùng URL):
  Không có negative cache: 10,000 origin hits
  Có negative cache:       1 origin hit     -> offload = 99.99%

  Đó là sức mạnh của negative caching: 1 request tới origin,
  9,999 requests được CDN hấp thụ.
```

## 9. Key signals/headers

### Response headers cần kiểm tra

```text
HEADER                 Ý NGHĨA                            GIÁ TRỊ MONG ĐỢI
────────────────────── ────────────────────────────────── ──────────────────
X-Cache                Cache state                        MISS -> HIT -> MISS
                       HIT = CDN serve từ cache
                       MISS = CDN gọi origin

X-Negative-Cache       Response này là negative cache     "true" cho cả
                       (dù HIT hay MISS)                  HIT và MISS

X-Cache-Hits           Số lần object đã được hit          > 0 cho HIT
                       trong cache trước khi expire

Status Code            HTTP status                        404 (luôn 404,
                                                          không bao giờ 200)

X-Served-By            Node CDN đã serve                  "varnish"

X-Origin-Request-Count Số lần origin đã nhận request      Tăng sau mỗi MISS
                       cho path này (từ origin)           Không tăng khi HIT

Age                    Thời gian object đã ở trong        Tăng dần từ 0
                       cache (giây)                       Reset về 0 sau MISS

Cache-Control          Chính sách cache từ origin         public, max-age=5,
                                                          s-maxage=5

CDN-Cache-Control      Chính sách cache dành cho CDN      max-age=5,
                                                          stale-if-error=120
```

### Cách đọc sequence từ headers

```text
Request #1 (MISS):
  X-Cache: MISS
  X-Negative-Cache: true         <-- origin set
  X-Origin-Request-Count: 1      <-- vừa được đếm
  Age: 0 (hoặc không có)         <-- vừa mới tạo

Request #2 (HIT):
  X-Cache: HIT
  X-Cache-Hits: 1                 <-- lần đầu object được hit
  X-Negative-Cache: true          <-- vẫn còn (lưu từ origin)
  X-Origin-Request-Count: 1       <-- VẪN LÀ 1 (không tăng)
  Age: ~1                          <-- đã tồn tại 1s

Sleep 6s...

Request #3 (MISS, sau expire):
  X-Cache: MISS
  X-Negative-Cache: true          <-- origin set lại
  X-Origin-Request-Count: 2       <-- tăng lên 2
  Age: 0 (hoặc không có)          <-- object mới được tạo lại
```

### Header warning signs

```text
DANGER SIGNALS:

1. X-Cache: HIT nhưng KHÔNG CÓ X-Negative-Cache
   -> Có thể là positive cache (200), không phải negative cache
   -> Kiểm tra status code

2. X-Cache: HIT nhưng status = 200
   -> Object đã bị overwrite bởi positive cache?
   -> Hoặc path này đang trả 200 thay vì 404

3. X-Cache: MISS nhưng X-Origin-Request-Count không tăng
   -> Origin counter bị broken
   -> Không thể verify offload

4. X-Cache: HIT nhưng X-Origin-Request-Count tăng
   -> Có request khác đến origin cho cùng path
   -> Có thể do variant headers khác?
```

## 10. Pass/fail criteria

### Điều kiện PASS

```text
PASS KHI TẤT CẢ CÁC ĐIỀU KIỆN SAU ĐÚNG:

1. k6 exit code = 0
   -> checks rate = 1 (tất cả check đều pass)
   -> Không có throw Error nào

2. Cache-state sequence ĐÚNG:
   404 MISS -> 404 HIT -> wait -> 404 MISS
   -> Chuyển tiếp MISS->HIT chứng minh negative cache đã được lưu
   -> Chuyển tiếp HIT->MISS sau sleep chứng minh negative cache đã expire

3. Origin count ĐÚNG:
   -> Sau phase 1: count = 1 (origin chỉ bị gọi 1 lần)
   -> Sau phase 2: count = 2 (thêm 1 lần sau khi expire)
   -> Nếu count không đúng pattern -> negative cache không offload origin
      hoặc không expire

4. Status code BẢO TOÀN:
   -> Luôn là 404 (không bao giờ 200, 500, hay status khác)
   -> CDN không được thay đổi status code của negative cache

5. X-Negative-Cache header HIỆN DIỆN:
   -> Có trên cả MISS và HIT responses
   -> Chứng minh CDN gán tag negative caching cho object này
```

### Điều kiện FAIL

```text
FAIL KHI BẤT KỲ ĐIỀU KIỆN NÀO SAU ĐÂY SAI:

1. 404 bị coi là FAILURE do status code
   -> k6 assertion: assertStatus(first, 404) không pass
   -> Nguyên nhân: k6 config hoặc script không accept 404 là expected
   -> Fix: đảm bảo script dùng assertStatus (k6 check) không phải
      http.expectedStatuses (k6 throw error)

2. Request #2 là MISS thay vì HIT
   -> "negative second cache state HIT" check fail
   -> Nguyên nhân khả năng:
      a) VCL không cache 404 -> kiểm tra vcl_backend_response
      b) Cache key không match -> kiểm tra URL normalization
      c) Object bị evict trước TTL -> cache memory quá nhỏ
      d) Request headers khác nhau tạo cache key khác

3. Request #3 là HIT thay vì MISS sau sleep
   -> "negative after expiry cache state MISS" check fail
   -> Nguyên nhân khả năng:
      a) NEGATIVE_WAIT_SECONDS < TTL thực tế
      b) TTL được set dài hơn dự kiến (kiểm tra VCL default 15s)
      c) Grace period vẫn còn hoạt động

4. Origin count KHÔNG ĐÚNG:
   -> Sau phase 1: count != 1
   -> Sau phase 2: count != 2
   -> Nguyên nhân: counter không reset đúng, hoặc có request khác
      cùng path chạy song song

5. Không có X-Negative-Cache header:
   -> VCL không set header này cho 404 responses
   -> Kiểm tra vcl_backend_response -> phải có
      set beresp.http.X-Negative-Cache = "true"
```

### Partial pass patterns

```text
MỘT SỐ PATTERN CHỈ PASS MỘT PHẦN:

Pattern A: MISS->HIT ĐÚNG, nhưng count = 2 ở phase 1
  -> Negative cache hoạt động (có HIT)
  -> Nhưng origin bị gọi 2 lần thay vì 1
  -> Có thể request #1 bị gọi lại do retry hoặc redirect

Pattern B: MISS->HIT ĐÚNG, count = 1 ở phase 1,
           nhưng sau sleep vẫn HIT
  -> Negative cache hoạt động nhưng chưa expire
  -> TTL thực tế > NEGATIVE_WAIT_SECONDS
  -> Hoặc grace period đang serve stale

Pattern C: 404 MISS -> 404 MISS (không có HIT),
           nhưng count = 1 ở phase 1
  -> Origin chỉ bị gọi 1 lần nhưng CDN không cache
  -> Có thể VCL không nhận diện được 404 này
     (ví dụ: 404 từ path khác /api/sim thay vì /api/cached)
```

## 11. Cách chạy + output

### Cách chạy cơ bản

```powershell
cd E:/Projects/k6/k6-metrics-server

$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

./scripts/run-cdn-capabilities.ps1 -Scenarios 11-negative-caching
```

### Override TTL và wait time (tùy chọn)

```powershell
# Negative TTL = 3 giây, wait = 5 giây
$env:NEGATIVE_TTL_SECONDS = "3"
$env:NEGATIVE_WAIT_SECONDS = "5"
./scripts/run-cdn-capabilities.ps1 -Scenarios 11-negative-caching

# Negative TTL = 10 giây, wait = 12 giây (dài hơn để test TTL dài)
$env:NEGATIVE_TTL_SECONDS = "10"
$env:NEGATIVE_WAIT_SECONDS = "12"
./scripts/run-cdn-capabilities.ps1 -Scenarios 11-negative-caching
```

### Lưu ý về thời gian chạy

```text
Case này CẦN THỜI GIAN do sleep NEGATIVE_WAIT_SECONDS:
  - Default: 6s sleep -> tổng thời gian ~8-10s
  - Nếu set NEGATIVE_TTL_SECONDS=30 -> sleep 31s -> tổng ~35s
  - Cần kiên nhẫn khi chạy case này

So với các case khác:
  - Case 01 (hit-smoke): <1s
  - Case 08 (ttl-expiry): ~22s (sleep 21s)
  - Case 11 (negative-caching): ~8s (sleep 6s default)
```

### Output điển hình

```text
PASS output điển hình:

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

### Cách đọc output

```text
KIỂM TRA TRONG OUTPUT:

1. checks rate = 100%: TẤT CẢ check pass -> sequence đúng

2. Số request = 3:
   - 1 cho MISS ban đầu
   - 1 cho HIT (từ cache)
   - 1 cho MISS sau expire
   - Đây là 3 requests từ k6 đến CDN, KHÔNG PHẢI 3 origin hits

3. Origin counters (không hiển thị trong k6 output):
   - Phải kiểm tra qua control path hoặc dashboard
   - GET /ops/app/cdn/origin/request-counts
   - Tìm request_key tương ứng -> count phải = 2

4. Nếu FAIL:
   - Xem check nào fail -> biết được bước nào bị lỗi
   - "negative second cache state HIT" fail -> negative cache ko hoạt động
   - "negative after expiry cache state MISS" fail -> TTL chưa expire
   - Error message từ origin count check -> biết actual count vs expected
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

KẾT LUẬN:
  "CDN hấp thụ 404 traffic, origin được bảo vệ."

  TẤT CẢ hoạt động đúng:
  - Negative cache lưu 404 với TTL đúng
  - Cache hit trả 404 từ CDN, KHÔNG gọi origin
  - TTL expire đúng hạn
  - Origin counter xác nhận offload: 3 request -> 2 origin hits
    (offload 33% cho 3 request, sẽ là 99%+ với high traffic)

HÀNH ĐỘNG TIẾP THEO:
  - Production ready cho negative caching
  - Có thể tune TTL (tăng/giảm) dựa vào business requirement
  - Document lại TTL values cho từng status code
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

  Origin count: có thể là 2 ngay ở phase 1
  (mỗi 404 đều MISS -> mỗi lần đều gọi origin)

KẾT LUẬN:
  "Negative caching KHÔNG ĐƯỢC CẤU HÌNH trong VCL —
   tất cả 404 đều hit origin."

  Nguyên nhân khả năng:
  a) thiếu logic 404 trong vcl_backend_response
     -> Kiểm tra: không có "if (beresp.status == 404)"
  b) 404 path không được include trong cache path
     -> vcl_recv: return (pass) thay vì return (hash)
  c) Object bị set uncacheable = true do condition khác
     -> Kiểm tra: Set-Cookie? no-store? private?
  d) Origin không set Cache-Control headers
     -> VCL default TTL = 0s, object không được cache

HÀNH ĐỘNG TIẾP THEO:
  - Kiểm tra VCL: vcl_backend_response phải có điều kiện
    if (beresp.status == 404 || beresp.status == 410)
  - Kiểm tra vcl_recv: path cho 404 có được hash không?
  - Kiểm tra response origin có Cache-Control header không
  - THÊM VCL config cho negative caching
  - Rerun case 11 -> verify PASS
```

### Scenario C: Negative TTL quá dài

```text
OUTPUT:
  ✓ negative first status 404
  ✓ negative first cache state MISS
  ✓ negative second status 404
  ✓ negative second cache state HIT
  ✗ negative after expiry status 404
  ✗ negative after expiry cache state MISS   <-- FAIL
  (expected MISS, got HIT — vẫn còn HIT sau sleep)

  Origin count: 1 (phase1) -> 1 (phase2) — không tăng!

KẾT LUẬN:
  "404 được cache với TTL QUÁ DÀI —
   resource có thể được tạo mới nhưng CDN vẫn trả 404 cũ."

  Nguyên nhân khả năng:
  a) NEGATIVE_WAIT_SECONDS < TTL thực tế
     -> Ví dụ: NEGATIVE_TTL_SECONDS=5 nhưng VCL set TTL=15s
        (vì Cache-Control từ origin không được tôn trọng?)
  b) Grace period đang serve stale
     -> Object hết TTL nhưng grace = 30s vẫn còn
     -> CDN serve stale vì backend healthy
        (nhưng vcl_hit chỉ serve stale khi backend unhealthy:
         if (!std.healthy(req.backend_hint) && obj.ttl + obj.grace > 0s))
  c) Keep time giữ object trong cache quá lâu

  Đặc biệt nguy hiểm:
  Nếu production có TTL negative = 300s (5 phút):
    -> Admin tạo product mới
    -> Push notification đến user
    -> User click -> 404 HIT (stale!) -> mất sale
    -> Fix bằng invalidation thủ công -> operational toil

HÀNH ĐỘNG TIẾP THEO:
  - Kiểm tra TTL thực tế: VCL default 15s? Origin set bao nhiêu?
  - Giảm TTL xuống: 5-15s cho 404
  - Đảm bảo NEGATIVE_WAIT_SECONDS > TTL thực tế + grace (nếu có)
  - Phân biệt TTL 404 (ngắn) vs TTL 410 (dài)
  - Rerun case 11 -> verify TTL expire đúng hạn
```

### Scenario D: 500 responses bị negative-cached

```text
OUTPUT:
  Nếu VCL bị cấu hình sai, cho phép negative-cache 5xx:

  (Nếu test bằng một 500 path tương tự 404 path...)
  ✓ 500 first status 500
  ✓ 500 first cache state MISS
  ✓ 500 second cache state HIT       <-- DANGER! 500 bị cache!
  ✓ 500 third sau sleep: HIT hoặc MISS

KẾT LUẬN:
  "DANGER — server errors bị negative-cached, CHE GIẤU lỗi thực sự."

  Đây là SAI LẦM NGHIÊM TRỌNG:
  - 500 là server error -> origin đang gặp lỗi THẬT SỰ
  - Nếu cache 500, CDN trả 500 HIT thay vì gọi origin
  - Origin không nhận được request -> developer không thấy error
  - Monitoring: "CDN health = OK" (đang trả 500 HIT)
  - Reality: origin service đã crash

  Hậu quả:
  - Service thực sự down nhưng CDN vẫn trả 500
    -> Không ai nhận được alert
  - Origin tự recovery nhưng CDN vẫn trả 500 cũ
    -> Stale 500 kéo dài, user thấy service down
  - Khi origin đã up, nhưng CDN vẫn 500 HIT
    -> Đến khi 500 TTL expire, user mới thấy 200 lại

HÀNH ĐỘNG TIẾP THEO (KHẨN CẤP):
  - KIỂM TRA VCL NGAY: phải có
    if (beresp.status >= 500) {
        set beresp.ttl = 0s;
        set beresp.uncacheable = true;
    }
  - Điều này PHẢI ở TRÊN điều kiện 404/410
    (đảm bảo 5xx bị block trước khi đến negative cache logic)
  - Kiểm tra TẤT CẢ các VCL deployment
  - Thêm test case: verify 500 không bao giờ HIT
  - Thêm monitoring alert: "X-Cache: HIT + status >= 500"
```

## 13. Nghịch lý / misconceptions

### Nghịch lý 1: "404 là lỗi, không nên cache"

```text
SAI LẦM PHỔ BIẾN NHẤT:
  "404 là HTTP error, cache error là sai."

THỰC TẾ:
  404 có 2 loại:

  1. UNEXPECTED 404: URL sai format, path traversal, attack probe
     -> Không nên cache, nên rate-limit

  2. EXPECTED 404: Product ID không tồn tại, resource đã bị xóa
     -> NÊN cache. Đây là business response bình thường, không phải lỗi.
     -> App đã xử lý thành công (success=false là kết quả đúng)
     -> Cache 404 NÀY giảm origin load

  "Expected 404" là khái niệm quan trọng:
  - App đã thực thi đầy đủ logic: parse input, query DB, xử lý kết quả
  - Kết quả "không tìm thấy" là kết quả ĐÚNG, không phải exception
  - Không có gì "broken" ở đây
  - Tiêu tốn tài nguyên để xử lý -> cache để tránh xử lý lại
```

### Nghịch lý 2: "Negative cache TTL = positive cache TTL"

```text
SAI LẦM:
  "404 cũng là một cache object, TTL nên giống 200."

THỰC TẾ:
  TTL cho negative cache PHẢI NGẮN HƠN RẤT NHIỀU:

  Positive cache (200): 60-300s
    -> Data có thể stale nhưng user vẫn thấy nội dung cũ
    -> Stale 200 vẫn có giá trị (product vẫn tồn tại, chỉ là giá thay đổi)

  Negative cache (404): 5-15s
    -> Nếu stale 404, user thấy "không tìm thấy" trong khi resource ĐÃ TỒN TẠI
    -> Stale 404 là MẤT DOANH THU (user thấy 404 -> rời đi)
    -> Admin tạo product, user không thấy -> mất sale

  Quy tắc:
    TTL_negative <= thời gian tối thiểu giữa "resource được tạo" và
                    "user đầu tiên request"
    -> Thường 5-15s là an toàn
    -> 410 (gone vĩnh viễn) là ngoại lệ: có thể cache 24h
```

### Nghịch lý 3: "Tất cả error code nên được negative cache"

```text
SAI LẦM:
  "Cache tất cả 4xx và 5xx để giảm origin load."

THỰC TẾ:
  CHỈ CACHE 4xx CÓ Ý NGHĨA BUSINESS, TUYỆT ĐỐI KHÔNG CACHE 5xx.

  5xx (500, 502, 503, 504):
    -> Là server errors
    -> Cache 500 = che giấu lỗi
    -> Origin không nhận request -> không phát hiện broken
    -> Monitoring sẽ thấy "mọi thứ OK" nhưng thực tế đã chết
    -> Dùng stale-if-error (serve stale 200 khi origin 500),
       KHÔNG PHẢI negative cache cho 500

  4xx cần phân biệt:
    400 (Bad Request)   -> KHÔNG cache (mỗi bad request unique)
    401 (Unauthorized)  -> KHÔNG cache (auth thay đổi)
    403 (Forbidden)     -> CÂN NHẮC KỸ (có thể cache 5s)
    404 (Not Found)     -> CACHE (short TTL)
    410 (Gone)          -> CACHE (long TTL)
```

### Nghịch lý 4: "Negative cache không cần observable"

```text
SAI LẦM:
  "404 là 404, không cần X-Negative-Cache header."

THỰC TẾ:
  Không có X-Negative-Cache, monitoring không thể phân biệt:

  "404 này từ negative cache hay từ origin?"
  -> Không biết được
  "Negative cache có đang offload origin không?"
  -> Không biết được
  "404 HIT ratio là bao nhiêu?"
  -> Không biết được

  X-Negative-Cache header là KEY cho observability:
  - Tách biệt negative cache metrics khỏi positive cache
  - Alert khi negative cache hit ratio thay đổi
  - Debug khi có vấn đề về 404
```

## 14. Checklist

### Checklist chuẩn bị test

```text
TRƯỚC KHI CHẠY CASE 11:

[ ] Topology TargetLayer=full đã chạy đủ
[ ] Varnish, Nginx, Go app đều healthy
    -> Kiểm tra: GET http://localhost:80/health
[ ] Control path :8088 accessible
    -> Kiểm tra: GET http://localhost:8088/health
[ ] OPS_AUTH_TOKEN đã được set
[ ] Origin counters đang hoạt động
    -> Kiểm tra: GET http://localhost:8088/ops/app/cdn/origin/request-counts
[ ] VCL chứa negative caching logic
    -> Đọc: E:/Projects/k6/k6-metrics-server/load-target/varnish/default.vcl
    -> Phải có: if (beresp.status == 404 || beresp.status == 410) { ... }
[ ] VCL không cache 5xx
    -> Phải có: if (beresp.status >= 500) { set beresp.uncacheable = true; }
[ ] Handler GetCachedMissing hoạt động
    -> Kiểm tra: GET http://localhost:80/api/cached/missing/test?ttl_seconds=5
    -> Phải trả 404 + X-Negative-Cache: true
```

### Checklist kiểm tra kết quả

```text
TRONG KHI ĐỌC OUTPUT:

[ ] k6 exit code = 0
[ ] Tất cả 7 checks PASS (100%)
[ ] Sequence: 404 MISS -> 404 HIT -> sleep -> 404 MISS
[ ] X-Negative-Cache: true trên MISS và HIT
[ ] Origin count = 1 sau phase 1
[ ] Origin count = 2 sau phase 2
[ ] Status code luôn là 404 (không bao giờ 200)
[ ] Không có unexpected errors trong log

NẾU FAIL:

[ ] Xác định check nào fail?
[ ] "negative second cache state HIT" fail -> VCL không cache 404
[ ] "negative after expiry cache state MISS" fail -> TTL dài quá / sleep ngắn quá
[ ] Origin count sai -> counter logic hoặc có concurrent requests
[ ] Không có X-Negative-Cache -> VCL không set header này
```

## 15. 4-5 variations

### Variation 1: Negative TTL rất ngắn (1-2s)

```text
MỤC ĐÍCH: Test negative cache với TTL cực ngắn để verify
         expire chính xác ở biên dưới.

THAY ĐỔI:
  $env:NEGATIVE_TTL_SECONDS = "2"
  $env:NEGATIVE_WAIT_SECONDS = "3"

MONG ĐỢI:
  - Negative cache vẫn MISS -> HIT -> MISS
  - Origin count vẫn 1 -> 2
  - Thời gian chạy nhanh hơn (~5s)

Ý NGHĨA:
  - Chứng minh TTL được tôn trọng ngay cả ở giá trị cực nhỏ
  - Phù hợp cho resource có khả năng được tạo rất nhanh
    (ví dụ: auto-generated content)
```

### Variation 2: Negative TTL dài (30s)

```text
MỤC ĐÍCH: Test negative cache với TTL dài hơn để verify
         offload kéo dài trong production.

THAY ĐỔI:
  $env:NEGATIVE_TTL_SECONDS = "30"
  $env:NEGATIVE_WAIT_SECONDS = "32"

MONG ĐỢI:
  - Negative cache MISS -> HIT -> (sleep 32s) -> MISS
  - Trong 30s, nhiều request đều HIT
  - Origin count vẫn 1 -> 2

Ý NGHĨA:
  - Phù hợp cho 410 Gone (resource đã bị xóa vĩnh viễn)
  - Càng TTL dài, càng offload tốt nhưng rủi ro stale 404
  - Cần balance giữa offload và freshness
```

### Variation 3: Nhiều missing paths đồng thời

```text
MỤC ĐÍCH: Test negative cache với nhiều URL 404 khác nhau,
         đảm bảo isolation giữa các cache keys.

THAY ĐỔI:
  Tạo nhiều path khác nhau trong setup():

  const paths = [
    buildCachedMissingPath(`missing-a-${Date.now()}`, { ttl_seconds: 5 }),
    buildCachedMissingPath(`missing-b-${Date.now()}`, { ttl_seconds: 5 }),
    buildCachedMissingPath(`missing-c-${Date.now()}`, { ttl_seconds: 5 }),
  ];

  Sau đó test MISS -> HIT -> origin count cho TỪNG path.

MONG ĐỢI:
  - Mỗi path có MISS -> HIT riêng biệt
  - Origin count riêng cho từng path
  - Cache isolation: HIT cho path A KHÔNG ảnh hưởng path B

Ý NGHĨA:
  - Chứng minh cache key isolation cho negative cache
  - Mỗi URL 404 là một cache object riêng
  - Không bị leakage giữa các path khác nhau
```

### Variation 4: 410 Gone test

```text
MỤC ĐÍCH: Test negative cache cho 410 Gone (resource đã bị xóa vĩnh viễn).

THAY ĐỔI:
  Tạo handler cho 410 Gone response:
  - Path: /api/cached/gone/{key}
  - Trả về 410 Gone
  - Cache-Control: max-age=86400 (24h)
  - X-Negative-Cache: true

  Script:
  - Request 1: 410 MISS
  - Request 2: 410 HIT (ngay lập tức)
  - Sleep 1s: vẫn 410 HIT (vì TTL dài)
  - Origin count: 1 -> 1

MONG ĐỢI:
  - 410 được cache với TTL dài
  - Origin count chỉ = 1
  - Khác với 404: TTL dài hơn, không cần wait expire

Ý NGHĨA:
  - 410 Gone là use case hoàn hảo cho negative cache TTL dài
  - Resource đã bị xóa -> không có rủi ro stale 404
  - Nên phân biệt 404 vs 410 trong VCL
```

### Variation 5: Smoke — verify negative cache KHÔNG bị expire sớm

```text
MỤC ĐÍCH: Verify negative cache giữ object trong SUỐT TTL window.

THAY ĐỔI:
  - Request 1: 404 MISS
  - Request liên tục mỗi 1s trong TTL window
  - Tất cả request giữa đều phải HIT
  - Chỉ MISS lại sau TTL + grace

  for (let i = 0; i < NEGATIVE_TTL_SECONDS; i++) {
    const res = requestCdn('GET', path);
    assertStatus(res, 404);
    assertCacheState(res, 'HIT');  // Vẫn HIT trong TTL
    sleep(1);
  }

MONG ĐỢI:
  - Tất cả request trong TTL window đều HIT
  - Không có unexpected eviction
  - Origin count vẫn = 1

Ý NGHĨA:
  - Đảm bảo cache memory đủ lớn, không evict object sớm
  - Verifies consistency của negative cache trong suốt TTL
```

## 16. Anti-patterns

### Anti-pattern 1: Caching 500 errors

```text
ANTI-PATTERN:
  if (beresp.status >= 500) {
      set beresp.ttl = 10s;  // <-- SAI! Cache server error
  }

TẠI SAO SAI:
  - 500 là server error, cache nó = che giấu broken service
  - Origin có thể crash rồi tự recover nhưng CDN vẫn trả 500 cũ
  - Monitoring sẽ không phát hiện

CÁCH ĐÚNG:
  if (beresp.status >= 500) {
      set beresp.ttl = 0s;
      set beresp.uncacheable = true;  // TUYỆT ĐỐI KHÔNG CACHE
      return (deliver);
  }
  // Logic cho negative caching (404, 410) ở DƯỚI
```

### Anti-pattern 2: Set negative TTL = positive TTL

```text
ANTI-PATTERN:
  // Áp dụng cùng TTL cho TẤT CẢ status codes
  set beresp.ttl = 300s;  // 5 phút cho cả 200, 404, 410...

TẠI SAO SAI:
  - 404 TTL = 5 phút -> resource mới tạo trong 5 phút này vẫn thấy 404
  - User click push notification -> 404 -> mất sale
  - Không phân biệt được expected vs stale 404

CÁCH ĐÚNG:
  if (beresp.status == 404) {
      set beresp.ttl = 15s;   // Ngắn
  } else if (beresp.status == 410) {
      set beresp.ttl = 86400s; // Dài (gone vĩnh viễn)
  } else {
      set beresp.ttl = 60s;   // Positive cache
  }
```

### Anti-pattern 3: Không phân biệt 404 và 410

```text
ANTI-PATTERN:
  if (beresp.status == 404) {  // Chỉ cache 404, bỏ qua 410
      set beresp.ttl = 15s;
  }
  // 410 không được cache -> MISS mỗi lần -> origin load

TẠI SAO SAI:
  - 410 Gone là resource đã bị xóa VĨNH VIỄN
  - Không có khả năng resource xuất hiện trở lại
  - Đây là use case HOÀN HẢO cho negative cache TTL dài
  - Không cache 410 = bỏ phí cơ hội offload

CÁCH ĐÚNG:
  if (beresp.status == 404 || beresp.status == 410) {
      if (beresp.ttl <= 0s) {
          set beresp.ttl = (beresp.status == 410) ? 86400s : 15s;
      }
      set beresp.grace = 30s;
      set beresp.http.X-Negative-Cache = "true";
  }
```

### Anti-pattern 4: Không có X-Negative-Cache header

```text
ANTI-PATTERN:
  if (beresp.status == 404) {
      set beresp.ttl = 15s;   // Cache nhưng không tag
  }
  // Thiếu: set beresp.http.X-Negative-Cache = "true";

TẠI SAO SAI:
  - Không thể phân biệt 404 từ negative cache vs 404 từ origin
  - Monitoring không thể track negative cache hit ratio
  - Debug: không biết 404 này là HIT hay MISS
  - Không thể alert khi negative caching broken

CÁCH ĐÚNG:
  if (beresp.status == 404 || beresp.status == 410) {
      set beresp.ttl = 15s;
      set beresp.http.X-Negative-Cache = "true";  // <-- PHẢI CÓ
  }
```

### Anti-pattern 5: Không xử lý grace cho negative cache

```text
ANTI-PATTERN:
  if (beresp.status == 404) {
      set beresp.ttl = 15s;
      // Thiếu: không set grace
  }

TẠI SAO KHÔNG TỐI ƯU:
  - Không set grace -> khi origin unhealthy, 404 response không
    được serve stale
  - Client có thể nhận 503 thay vì 404
  - Trong trường hợp này, 404 grace vẫn có ích:
    origin unhealthy -> serve 404 stale thay vì error

CÁCH ĐÚNG (theo VCL hiện tại):
  if (beresp.status == 404 || beresp.status == 410) {
      set beresp.ttl = 15s;
      set beresp.grace = 30s;   // Cho phép stale serving
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
  -> Trả về: 404 JSON, X-Negative-Cache: true

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

> **Mental model:** Negative caching là một CƠ CHẾ PHÒNG THỦ. Trong khi positive cache
> giúp serve 200 nhanh hơn, negative cache bảo vệ origin khỏi bị spam bởi 404 traffic
> lặp lại. CDN đứng ra hứng chịu impact của traffic xấu thay cho origin. Đây là
> pure CDN-edge behavior: app chỉ trả về 404, CDN là nơi quyết định có cache 404
> đó hay không. Origin request counters là bằng chứng không thể tranh cãi cho
> việc offload này.
