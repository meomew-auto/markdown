# Case 07: Cache response contract

> **Case ID:** `cdn-07-cache-contract`
> **Script:** `07-cache-contract.js`
> **Layer:** CDN / Varnish
> **Proof:** cache contract headers and 304 revalidation
> **Headers verified:** Cache-Control, CDN-Cache-Control, ETag, Vary, Surrogate-Key, Last-Modified
> **Paths:** `/api/sim/products/1` (dynamic cacheable), `/api/sim/products/homefeed`, `/api/sim/products/categories`

---

## 1. Tình huống thực tế

### Response headers là Hợp đồng giữa origin và CDN

Mới response cacheable mà origin trả về không chỉ chưa body (JSON, HTML, binary) --
nó còn chưa một **HỢP ĐỒNG** (contract) năm trong các response header. Hợp đồng này
là lỗi hua tự origin đến CDN (Varnish), nối rang:

```text
Origin nối với CDN:
  "Đây là object này. Em được phép cache nó trong N giây.
   De biet khi nao hết hạn, em nhin vào header Cache-Control của anh.
   Muon xác nhận object còn đúng không, em dụng ETag này de hoi lại anh.
   Object này thay đổi theo ngôn ngữ (Accept-Language) và quoc gia (X-Geo-Country)
   -- em phải cache rieng cho từng combination.
   Khi anh bảo em xóa object, em dụng Surrogate-Key này de tìm."
```

Nếu **BẤT KỲ** header nao trong hợp đồng này bị thiếu hoặc sai, CDN sẽ:
- **Cache qua hung hang** (qua aggressive): serve stale data cho user, user thay
  sai sản phẩm, sai gia, sai ngôn ngữ.
- **Hoặc không cache gi ca**: mới request đều phải về origin, origin quá tải,
  CDN thành "ong dan trong suot" vô dụng.

### Những header nao lập thành hợp đồng?

```text
BOX: 6 HEADER THÀNH PHẦN CỦA CACHE CONTRACT
==============================================================
 (1) Cache-Control        -- Thời giản tuoi (freshness) của object
                              trong shared cache (CDN) và browser.
                              Chứa các directive: public, s-maxage,
                              stale-while-revalidate, stale-if-error.

 (2) CDN-Cache-Control    -- TTL dành riêng cho CDN (Varnish).
                              Có thể override Cache-Control nếu
                              origin muon browser cache khac CDN.

 (3) ETag                 -- "Dấu vân tay" của object. Là một
                              opaque string (hash) mà origin tạo ra
                              tự nội dụng. Dùng để revalidation.

 (4) Vary                 -- Khai báo những request header nao
                              lam thay đổi response. CDN dùng nó
                              để tạo cache key variant.

 (5) Surrogate-Key        -- Tag de invalidate theo nhom.
                              Varnish dùng nó de ban-tag (xóa
                              tất cả object có cùng tag).

 (6) Last-Modified        -- Timestamp lần cuoi object thay đổi.
                              Validator thay thể cho ETag.
==============================================================
```

### Vì sao goi là "contract"?

```text
"Contract" không phải là ten goi hóa my. Nó là một khái niệm chính xác:

  - Origin CẢM KẾT (qua header): object này tuoi trong X giây, ETag
    là Y, variant key là Z, tag là T.

  - CDN THỰC THÌ (dựa vào header): cache object X giây, khi hết
    hạn đúng ETag revalidate, isolate variant, invalidate theo tag.

  - Nếu origin cảm kết sai: CDN vẫn cache -- những sai data.
    -> user thay sai, app logic bị pha vô.

  - Nếu origin không cảm kết: CDN không cache -- origin thoi.
    -> every request hit origin, không có offload.

  - Nếu origin cảm kết đúng nhưng CDN không tôn trọng:
    -> cache leak, variant cross-talk, stale data.

=> Validating cache contract là VALIDATING FOUNDATION của CDN behavior.
   Đây là bước đầu tiên trước khi validate bất kỳ CDN case nào khác:
   HIT/MISS, TTL expiry, stale serving, invalidation, coalescing.
```

### Tải sao contract headers de bị thiếu hoặc sai?

Trong thực tế, các hệ thống backend thuong mac phải nhưng sai song sau:

```text
Lỗi 1: Thieu Cache-Control trên response cacheable
  -> CDN mac định không cache (hoặc cache theo default TTL quá ngắn)
  -> Origin nhận 100% traffic, CDN là "ong dan"

Lỗi 2: Cache-Control có private
  -> `Cache-Control: private, max-age=60`
  -> CDN không cache (private = chỉ browser được cache)
  -> Mới request đều MISS -> origin overload

Lỗi 3: Thieu ETag
  -> Không có có chế revalidation
  -> Khi object hết hạn, CDN phải fetch lại TOÀN BỘ body tự origin
  -> Ton băng thông, tang latency

Lỗi 4: ETag không ổn định
  -> ETag thay đổi theo server timestamp thay vì content hash
  -> Cứng nội dụng, 2 instance trả 2 ETag khac nhau
  -> Revalidation luon thật bai -> 200 thay vì 304

Lỗi 5: Thieu Surrogate-Key
  -> Không thể invalidate theo nhom (vd: xóa tất cả product category)
  -> Phải purge từng URL một -> chậm, tồn tại nguyen

Lỗi 6: Vary thieu header quản trọng
  -> User VN và user US đúng chứng cache object
  -> User VN thấy giá VND, user US cứng thấy giá VND
  -> Cache leakage

Lỗi 7: Vary khai báo sai header
  -> Vary: User-Agent -> mới browser có cache object rieng
  -> Hit ratio giám tham hai vì phần manh cache
```

### Hiện trường thực tế

```text
Tình huống: 17:55 chieu thủ 6 -- khach sẵn sàng mua sim cuoi tuan

  User A (VN, mobile, tieng Viết) mở app -> GET /api/sim/products/1
    Origin trả về: status=200, body sản phẩm, Cache-Control: public, s-maxage=60
    CDN cache: MISS -> HIT

  User B (US, desktop, tieng Anh) mở app -> GET /api/sim/products/1
    Nếu Vary dụng: CDN MISS (variant khac) -> fetch tự origin tieng Anh
    Nếu Vary sai: CDN HIT -> serve object tieng Viết cho nguoi My
    -> User B thay "Ao so mi" thay vì "T-shirt"
    -> Không mua hang -> lost revenue

  Admin cập nhật giá sản phẩm -> POST /admin/products/1
    Nếu Surrogate-Key có: ban-tag product-1 -> CDN xóa tất cả variant
    Nếu Surrogate-Key không có: purge từng URL variant một
    -> mặt 5-10 giây để purge hết -> trong thời giản đo, user thấy giá cũ
    -> mua hang gia SAI -> operational nightmare

  Sau 60 giây: object hết hạn (expired)
    Nếu có ETag: CDN gửi If-None-Match đến origin
      Origin trả 304 (không body) -> CDN cập nhật TTL, serve cached body
      -> BĂNG THÔNG TIẾT KIỆM: chỉ ton ~200 byte headers thay vì 4KB body
    Nếu không có ETag: CDN phải fetch lại full body tự origin
      -> 4KB * 1000 requests = 4MB băng thông bị lang phi
```

### Cau hoi kinh doanh

```text
"Cache contract headers có đầy đủ và chính xác de CDN có thể:
   - Cache dụng freshness window
   - Revalidate tiết kiệm băng thông
   - Isolate variant dụng cách
   - Invalidate theo tag nhanh chong
 không?"
```

Đây không phải là "API có trả 200 không". Đây là cau hoi **contract**: origin
đã dua ra một tạp hợp lỗi hua qua header; CDN có dữ thông tin de thực hiện
dụng công việc của nó không?

---

## 2. CDN capability được chứng minh

Case này chứng minh **5 capabilities** của CDN layer lien quản đến cache contract:

### (a) Cache-Control và CDN-Cache-Control hien diện và dùng

```text
Origin phải emit Cache-Control với ít nhất:
  - public: cho phep shared cache (CDN, proxy)
  - s-maxage=N: TTL cho shared cache
  - stale-while-revalidate=N: thời giản serve stale trong khi revalidate
  - stale-if-error=N: thời giản serve stale khi origin lỗi

CDN-Cache-Control là CDN-specific override:
  - max-age=N: TTL dành riêng cho CDN
  - stale-while-revalidate, stale-if-error tuong tự

Nếu CDN-Cache-Control có mặt, Varnish sự dùng nó (ghi de Cache-Control).
Nếu không có, Varnish fallback về Cache-Control.
```

### (b) ETag hien diện trên response cacheable

```text
ETag là "dấu vân tay" của object. Origin tạo ETag tự nội dụng (hash),
không phải từ timestamp server. ETag phải:
  - Có mặt trên môi response cacheable
  - Ổn định: cứng nội dụng -> cứng ETag (ngày ca qua nhiều instance)
  - Unique: nối dùng khác -> ETag khac
```

### (c) Vary header khai bảo đúng variant dimensions

```text
Vary khai báo những request header nao lam thay đổi response.
CDN dụng Vary de bien những header đo thành một phần của cache key.

Ví dụ: Vary: Accept-Language, X-Geo-Country
  -> CDN cache rieng cho VN+VÌ, VN+EN, US+EN, US+VÌ, ...
  -> Không bị leakage giữa các variant
```

### (d) Surrogate-Key hien diện de invalidation theo nhom

```text
Surrogate-Key chưa space-separated tags. Varnish dụng tags này de:
  - ban-tag: xóa tất cả object có cùng tag
  - Invaildate theo nghiệp vụ: "xóa tất cả product-1" thay vì
    phải liet kế từng URL variant (product-1?lang=vì&geo=VN, ...)
```

### (e) 304 Not Modified hoạt động khi ETag khop

```text
Khi CDN có object đã hết hạn (expired) những còn ETag:
  1. CDN gửi If-None-Match: <etag> đến origin
  2. Origin so sanh ETag:
     - Nếu khop: trả 304 Not Modified (KHÔNG body)
     - Nếu không khớp: trả 200 OK (có body mới + ETag mới)
  3. CDN cập nhật TTL, serve cached body cho client

Đây là CHẾ ĐO TIẾT KIỆM BĂNG THÔNG:
  - Origin chỉ trả headers (~200 bytes) thay vì full body (~4KB)
  - Hệ so: 20x tiết kiệm băng thông giữa origin và CDN
```

---

## 3. Vì sao test o CDN layer

### Headers này được SET bởi origin những CONSUMED bởi CDN

```text
ĐÂY LÀ DIEM MAU CHOT:

  +------------------+     Cache-Control, ETag,     +------------------+
  |    ORIGIN (app)  | --- Vary, Surrogate-Key ---> |   CDN (Varnish)  |
  |  SET headers     |                              |  CONSUME headers |
  +------------------+                              +------------------+
         |                                                   |
         |                                                   |
    Test o app layer:                                  Test o CDN layer:
    "headers có được emit?"                            "headers có được Varnish
    CHỈ verify emission                                SỰ DÙNG DÙNG CÁCH?"
```

### Test o app layer thì được gi?

```text
Nếu chỉ test thống qua Nginx (không qua Varnish):
  -> Xác nhận được origin có emit headers
  -> Nhưng không biet Varnish có hiệu và sử dụng headers đo không
  
  Ví dụ: Origin emit Cache-Control: public, s-maxage=60
         Những Varnish config sai -> vẫn MISS mới request
         -> Test app layer PASS (headers có) những CDN behavior FAIL
```

### Test o CDN layer thì được gi?

```text
Test qua Varnish (:80) xác nhận ĐƯỢC:
  1. Headers tồn tại trên response client nhận được
     (Varnish có thể strip, modify, hoặc không forward headers)
  2. 304 revalidation hoạt động: CDN gửi If-None-Match, origin trả 304,
     CDN forward 304 cho client (hoặc 200 với cached body)
  3. Cache behavior dụng: sau request dau, request thủ 2 là HIT
     (chung to CDN đã sử dụng Cache-Control de cache)
  4. Vary isolation: request với header variant khac -> MISS
     (chung to CDN đã sử dụng Vary de isolate)
  5. Invalidation hoạt động: ban-tag dẫn đến MISS tiep theo
     (chung to CDN đã sử dụng Surrogate-Key de tìm object)
```

### 304 revalidation flow -- tải sao PHẢI test o CDN layer?

```text
304 revalidation là flow MÀ CHỈ CDN LAYER MỚI CÓ THỂ KIỂM TRẢ ĐƯỢC:

  Client -> CDN -> Origin
     |        |        |
     |  1. Object trong cache những đã hết hạn (expired)
     |        |
     |  2. CDN gửi request đến origin với:
     |     If-None-Match: "abc123"  (ETag của object cũ)
     |        |        |
     |        |  3. Origin so sanh ETag:
     |        |     -> Khop: trả 304 Not Modified (KHÔNG body)
     |        |     -> Không khớp: trả 200 OK (body mới)
     |        |
     |  4. CDN nhận 304 -> cập nhật TTL, dùng lại cached body
     |
     |  5. Client nhận 200 OK (body tự CDN cache)
     |
     => TOÀN BỘ flow này DIỆN RA GIỮA CDN VÀ ORIGIN
        Client test trực tiếp origin KHÔNG BẢO GIỜ thay 304
```

### Hành vì Varnish cụ thể với từng header

```text
Cache-Control: public, s-maxage=60, stale-while-revalidate=30, stale-if-error=120
  -> Varnish: cache object, TTL=60s. Sau 60s object expired.
     Trong 30s tiep theo: serve stale + async revalidate.
     Nếu origin lỗi trong 120s sau TTL: serve stale.

CDN-Cache-Control: max-age=120, stale-while-revalidate=60
  -> Varnish: ghi de Cache-Control, TTL=120s.
     Dụng khi origin muon CDN cache lâu hơn browser.

ETag: "abc123"
  -> Varnish: lưu ETag cùng với object.
     Khi revalidate: gửi If-None-Match: "abc123"
     Khi nhận 304: keep current body, update TTL

Vary: Accept-Language, X-Geo-Country
  -> Varnish: hash(Vary headers) -> variant key.
     Cache key = hash(path) + hash(variant dimensions)

Surrogate-Key: product-1 catalog-homefeed
  -> Varnish: register object vào 2 tag groups.
     Khi ban-tag "product-1": xóa tất cả object có tag này
```

---

## 4. Topology & precondition

### Runtime topology

```text
                    PUBLIC PATH (edge)
                    ==================
  k6  ----HTTP-->  :80 (Varnish CDN)  -->  :8080 (Nginx)  -->  app
                    |                                      |
                    |  Cache-Control, CDN-Cache-Control    |
                    |  ETag, Last-Modified                  |
                    |  Vary, Surrogate-Key                  |
                    |                                      |
                    +-- cache object, revalidate, isolate --+


                   CONTROL PATH (direct)
                   =====================
  k6  ----HTTP-->  :8088  -->  app (ops endpoints)


                   EVENT PATH (catalog events mock)
                   ================================
  k6  ----HTTP-->  :9091  -->  catalog-events mock
```

### Path cho case này

```text
PUBLIC PATH (dùng để validate cache contract):
  http://localhost:80/api/sim/products/1        -- product detail (primary)
  http://localhost:80/api/sim/products/homefeed -- homefeed
  http://localhost:80/api/sim/products/categories -- categories

CONTROL PATH (dùng để reset cache state nếu cần):
  http://localhost:8088/ops/app/cdn/cache/purge
  http://localhost:8088/ops/app/cdn/cache/ban-tag

EVENT PATH: không sử dụng trong case này
```

### Precondition

```text
1. TargetLayer = full (CDN + Nginx + app)
2. Public requests Phải đi qua Varnish (không được di tháng Nginx)
3. OPS_AUTH_TOKEN phải được set (cho control path purge/ban nếu cần)
4. Origin health: tất cả upstream services phải healthy
5. Không có cache warming trước -- test tự tạo MISS và 304
```

### Tải sao precondition quản trọng?

```text
Nếu public request di tháng Nginx (không qua Varnish):
  -> Không có X-Cache header
  -> Không có CDN behavior (HIT/MISS/304 revalidation)
  -> Test PASS nhưng không validate được gi

Nếu origin không healthy:
  -> Cache-Control headers vẫn có thể emit
  -> Những 304 revalidation có thể fail vì origin không xử lý được
  -> False negative
```

---

## 5. Script deep-dive

### Tổng quản script

Script `07-cache-contract.js` là execution đơn (1 VỤ, 1 iteration) thực hiện
3 nhom kiểm trả:

```text
PHASE 1: PRODUCT DETAIL CONTRACT (headers có ban)
  -> GET /api/sim/products/1 với guest VN mobile profile
  -> Check: Cache-Control, CDN-Cache-Control, ETag,
            Last-Modified, Surrogate-Key, Vary

PHASE 2: 304 REVALIDATION
  -> Lấy ETag tự response dau
  -> GET lại với If-None-Match + Cache-Control: nó-cache
  -> Expect: 304 Not Modified

PHASE 3: HOMEFEED + CATEGORIES CONTRACT
  -> GET /api/sim/products/homefeed: check Surrogate-Key tags
  -> GET /api/sim/products/categories: check Vary dimensions
```

### Import và config

```javascript
import {
  decodeJSON, getHeader, paths, profiles,
  requestCdn, assertHeaderContains,
  assertHeaderPresent, assertStatus
} from './shared.js';

export const options = {
  vus: 1,           // 1 VU duy nhat
  iterations: 1,    // chay 1 lan
  thresholds: {
    checks: ['rate==1'],  // 100% checks phai pass
  },
  tags: {
    scenario: 'cdn_cache_contract',
  },
};
```

**Giải thích config**:
- `vus: 1, iterations: 1`: Đây là functional validation, không phải load test.
  Chỉ cần 1 lần goi để xác nhận contract.
- `checks: ['rate==1']`: Threshold cứng -- mới check đều phải pass.
  Chỉ 1 check fail là test FAIL.

### PHASE 1: Product detail contract

```javascript
const detail = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'detail_contract' },
});

// 1. Status code
assertStatus(detail, 200, 'detail contract');

// 2. Cache-Control: phai co mat + chua cac directive bat buoc
assertHeaderPresent(detail, 'Cache-Control', 'detail contract');
assertHeaderContains(detail, 'Cache-Control', 'public', 'detail contract');
assertHeaderContains(detail, 'Cache-Control', 's-maxage=', 'detail contract');
assertHeaderContains(detail, 'Cache-Control', 'stale-while-revalidate=', 'detail contract');
assertHeaderContains(detail, 'Cache-Control', 'stale-if-error=', 'detail contract');

// 3. CDN-Cache-Control: phai co mat + chua cac directive bat buoc
assertHeaderPresent(detail, 'CDN-Cache-Control', 'detail contract');
assertHeaderContains(detail, 'CDN-Cache-Control', 'max-age=', 'detail contract');
assertHeaderContains(detail, 'CDN-Cache-Control', 'stale-while-revalidate=', 'detail contract');
assertHeaderContains(detail, 'CDN-Cache-Control', 'stale-if-error=', 'detail contract');

// 4. Validator headers
assertHeaderPresent(detail, 'ETag', 'detail contract');
assertHeaderPresent(detail, 'Last-Modified', 'detail contract');

// 5. Invalidation header
assertHeaderPresent(detail, 'Surrogate-Key', 'detail contract');
assertHeaderContains(detail, 'Surrogate-Key', 'product-1', 'detail contract');

// 6. Variant header
assertHeaderPresent(detail, 'Vary', 'detail contract');
```

**Phân tích từng assertion**:

```text
Cache-Control: public, s-maxage=...
  - `public`: Bắt buộc. Không có -> CDN không cache.
  - `s-maxage=N`: Bắt buộc. Không có -> CDN không biết cache bảo lau.
  - `stale-while-revalidate=N`: Bắt buộc. Không có -> không có grace period.
  - `stale-if-error=N`: Bắt buộc. Không có -> origin lỗi -> CDN serve 503.

CDN-Cache-Control: max-age=...
  - `max-age=N`: Bắt buộc. TTL rieng cho CDN.
  - `stale-while-revalidate=N`: Bắt buộc.
  - `stale-if-error=N`: Bắt buộc.

ETag: W/"abc123" hoặc "abc123"
  - Bắt buộc. Không có -> không thể revalidate.

Last-Modified: Wed, 21 Oct 2015 07:28:00 GMT
  - Bắt buộc. Validator dữ phong.

Surrogate-Key: ... product-1 ...
  - Bắt buộc. Không có -> không thể ban-tag.
  - Phải chưa ít nhất product-{id}.

Vary: ...
  - Bắt buộc. Không có -> không có variant isolation.
```

### PHASE 2: 304 Revalidation

```javascript
const detailETag = getHeader(detail, 'ETag');
if (!detailETag) {
  throw new Error('detail contract missing ETag');
}

const revalidated = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  headers: {
    'Cache-Control': 'no-cache',
    'If-None-Match': detailETag,
  },
  tags: { case: 'detail_revalidate' },
});
assertStatus(revalidated, 304, 'detail revalidation');
```

**Phân tích**:

```text
1. Lấy ETag tự response đầu tiên: detailETag = getHeader(detail, 'ETag')
   Nếu không có ETag: throw ngày lập tức -> test FAIL

2. Gửi request thủ 2 với:
   - Cache-Control: nó-cache
     -> Bảo CDN: "dụng serve object tự cache, phải revalidate với origin"
   - If-None-Match: <etag>
     -> Bảo origin: "tối có object với ETag này, nếu còn dụng thì trả 304"

3. Expect: status 304 Not Modified
   - Origin xác nhận: object không thấy doi
   - CDN cập nhật TTL của cached object
   - Client nhận 304 (không body, không tôn băng thông)

4. Nếu origin trả 200 (thay vì 304):
   -> ETag đã thay đổi (nối đúng mọi) HOẶC revalidation không được hỗ trợ
   -> Test FAIL: "304 revalidation không hoạt động"
```

### PHASE 3: Homefeed + Categories contract

```javascript
// HOMEFEED
const homefeed = requestCdn('GET', paths.homefeed, {
  profile: profiles.returningVNMobileVariantA,
  tags: { case: 'homefeed_contract' },
});
assertStatus(homefeed, 200, 'homefeed contract');
assertHeaderContains(homefeed, 'Surrogate-Key', 'catalog-homefeed', 'homefeed contract');
assertHeaderContains(homefeed, 'Surrogate-Key', 'segment-returning', 'homefeed contract');

// CATEGORIES
const categories = requestCdn('GET', paths.categories, {
  profile: profiles.guestUSDesktopControl,
  tags: { case: 'categories_contract' },
});
assertStatus(categories, 200, 'categories contract');
assertHeaderContains(categories, 'Vary', 'Accept-Language', 'categories contract');
assertHeaderContains(categories, 'Vary', 'X-Geo-Country', 'categories contract');

const categoriesBody = decodeJSON(categories, 'categories contract');
if (!categoriesBody.success) {
  throw new Error('categories contract request returned unsuccessful body');
}
```

**Phân tích**:

```text
HOMEFEED:
  - Surrogate-Key phải chưa `catalog-homefeed`: tag de invalidation
    khi catalog thay đổi.
  - Surrogate-Key phải chưa `segment-{segment}`: tag de invalidation
    theo user segment (returning, new_user, guest).
  -> 1 ban-tag "catalog-homefeed" xóa toàn bộ homefeed cache.
  -> 1 ban-tag "segment-returning" xóa homefeed cho returning users.

CATEGORIES:
  - Vary phải chưa `Accept-Language`: vì categories list khac nhau
    theo ngôn ngữ (ten danh muc tieng Viết vs tieng Anh).
  - Vary phải chưa `X-Geo-Country`: vì categories khac nhau theo
    quoc gia (sản phẩm available o VN vs US).
  - Response body phải có success=true.
```

---

## 6. Cache contract headers deep-dive

Đây là phần **QUẢN TRỌNG NHẤT** của case này. Mới header là một điều khoản
trong hợp đồng giữa origin và CDN. Hiệu SAI một header -> triển khai SAI
toàn bộ cache strategy.

### 6.1 Cache-Control

```text
BOX: Cache-Control
================================================================
Mục đích:        Khai báo policy cache cho browser VÀ shared cache
                 (CDN, proxy).
Vì trị:          Response header (origin -> CDN -> client)
Cũ phap:         Cache-Control: <directive>, <directive>, ...
Ai set:          Origin (app)
Ai consume:      Browser, CDN (Varnish), intermediate proxies
================================================================
```

**Các directive quản trọng cho CDN**:

```text
+------------------+--------------------------------------------------+
| Directive        | Ý nghĩa đối với CDN                              |
+------------------+--------------------------------------------------+
| public           | Cho phep SHARED CACHE (CDN, proxy).               |
|                  | Không có -> CDN không được cache.                 |
|                  | Đây là directive SO 1 quyết định CDN có cache     |
|                  | hay không.                                        |
+------------------+--------------------------------------------------+
| private          | CHỈ browser được cache. CDN PHẢI bypass.          |
|                  | Dụng cho response theo user cụ thể (auth).        |
|                  | NGUY HIEM: nếu de private trên response public    |
|                  | -> CDN không cache -> origin overload.            |
+------------------+--------------------------------------------------+
| s-maxage=N       | TTL cho SHARED CACHE (CDN).                        |
|                  | Ghi de max-age cho CDN.                            |
|                  | VD: s-maxage=60 -> CDN cache 60 giây.              |
|                  | Nếu không có s-maxage: CDN fallback max-age.      |
+------------------+--------------------------------------------------+
| max-age=N        | TTL cho BROWSER (private cache).                   |
|                  | CDN sử dụng s-maxage (nếu có), không thì max-age.  |
+------------------+--------------------------------------------------+
| stale-while-     | Thời giản CDN được serve STALE trong khi           |
| revalidate=N     | REVALIDATE ASYNC với origin.                       |
|                  | VD: s-maxage=60, stale-while-revalidate=30        |
|                  | -> Từ giây 61 đến 90: serve cached + async fetch   |
+------------------+--------------------------------------------------+
| stale-if-error=N | Thời giản CDN được serve STALE khi origin LỖI.     |
|                  | VD: stale-if-error=120                            |
|                  | -> Từ giây 61 đến 180: nếu origin error, serve     |
|                  |    stale thay vì 503.                              |
|                  | ĐÂY LÀ TÍNH NĂNG PHONG THỦ QUẢN TRỌNG.            |
+------------------+--------------------------------------------------+
| nó-cache         | Client muon REVALIDATE TRƯỚC KHI DỤNG.             |
|                  | CDN phải gửi conditional request đến origin.       |
|                  | Đây là "revalidate always", KHÔNG PHẢI "không      |
|                  | cache". Object vẫn được cache, những mỗi lần       |
|                  | serve đều phải hoi origin.                         |
+------------------+--------------------------------------------------+
| nó-store         | KHÔNG ĐƯỢC CACHE (ca browser lần CDN).             |
|                  | Response bị xóa ngày sau khi gửi.                  |
+------------------+--------------------------------------------------+
| must-revalidate  | Khi object hết hạn, CDN PHẢI revalidate.           |
|                  | Không được serve stale (tru khi stale-if-error).   |
+------------------+--------------------------------------------------+
```

**Cách Varnish xử lý Cache-Control**:

```text
1. Varnish parse Cache-Control header.
2. Xác định TTL:
   - Nếu có s-maxage -> TTL = s-maxage
   - Nếu có max-age (không s-maxage) -> TTL = max-age
   - Nếu không có ca hai -> TTL = default_ttl (VCL)
3. Xác định có được cache không:
   - Nếu có private -> KHÔNG CACHE
   - Nếu có nó-store -> KHÔNG CACHE
   - Nếu có public -> ĐƯỢC CACHE
   - Nếu không có ca private lần public -> depend on VCL default
4. Xác định stale policy:
   - stale-while-revalidate -> grace period (keep trong khi fetch)
   - stale-if-error -> keep khi backend unhealthy

Trong VCL code:
  set beresp.ttl = <s-maxage hoặc max-age>;
  set beresp.grace = <stale-if-error>;
  set beresp.keep = <stale-while-revalidate>;
```

### 6.2 CDN-Cache-Control

```text
BOX: CDN-Cache-Control
================================================================
Mục đích:        Override Cache-Control DÀNH RIÊNG cho CDN.
                 Origin muon browser cache ngắt, CDN cache lau?
                 -> CDN-Cache-Control.
Vì trị:          Response header (origin -> CDN -> client)
                 Có thể bị CDN strip (không forward cho client).
Cũ phap:         CDN-Cache-Control: <directive>, ...
Ai set:          Origin (app)
Ai consume:      CDN (Varnish) -- ưu tiên hơn Cache-Control
================================================================
```

**Tải sao cần CDN-Cache-Control rieng?**

```text
Tình huống: Origin muon:
  - Browser cache 5s (max-age=5) de phần hoi nhanh cho user repeat
  - CDN cache 600s (s-maxage=600) de offload origin

  Chỉ với Cache-Control:
    Cache-Control: public, max-age=5, s-maxage=600
    -> Browser hiệu: max-age=5 -> OK
    -> CDN hiệu: s-maxage=600 -> OK
    -> Những responses đã được định nghĩa ky trong HTTP spec

  Trường hợp phức tạp hon:
    Origin muon browser KHÔNG ĐƯỢC CACHE những CDN ĐƯỢC CACHE
    Cache-Control: private, nó-store  (cho browser)
    CDN-Cache-Control: max-age=600    (cho CDN)
    -> Browser: không cache
    -> CDN: cache 600s

  Đây là separation of concerns:
    - Cache-Control: target browser + generic proxy
    - CDN-Cache-Control: target CDN specifically
```

**Các directive trong CDN-Cache-Control**:

```text
+------------------+--------------------------------------------------+
| Directive        | Ý nghĩa đối với CDN                              |
+------------------+--------------------------------------------------+
| max-age=N        | TTL cho CDN. Ghi de Cache-Control s-maxage.      |
+------------------+--------------------------------------------------+
| stale-while-     | Ghi de Cache-Control stale-while-revalidate.      |
| revalidate=N     |                                                    |
+------------------+--------------------------------------------------+
| stale-if-error=N | Ghi de Cache-Control stale-if-error.              |
+------------------+--------------------------------------------------+
| nó-cache         | CDN phải revalidate trước khi serve.              |
+------------------+--------------------------------------------------+
| nó-store         | CDN không được cache.                             |
+------------------+--------------------------------------------------+
```

**Cách Varnish xử lý CDN-Cache-Control**:

```text
Varnish (với built-in VCL hoặc custom VCL) xử lý như sau:

1. Kiểm trả CDN-Cache-Control trước.
2. Nếu có -> sự dùng nó de set TTL, grace, keep.
3. Nếu không có -> fallback về Cache-Control.
4. Không forward CDN-Cache-Control cho client (tuy VCL).

VCL snippet diện hinh:
  if (beresp.http.CDN-Cache-Control) {
    // Parse CDN-Cache-Control, set beresp.ttl, etc.
  } else if (beresp.http.Cache-Control) {
    // Fallback to Cache-Control
  }
```

### 6.3 ETag

```text
BOX: ETag (Entity Tag)
================================================================
Mục đích:        Validator DANH TÍNH cho object. Origin tạo ra
                 tự NỐI Dùng của response body.
Vì trị:          Response header (origin -> CDN -> client)
Cũ phap:         ETag: "abc123" (strong)
                 ETag: W/"abc123" (weak)
Ai set:          Origin (app)
Ai consume:      CDN (revalidation), Browser (conditional GET)
================================================================
```

**Strong vs Weak ETag**:

```text
Strong ETag:  ETag: "abc123"
  - Thay đổi khi VÀ CHỈ KHI byte-by-byte body thay đổi.
  - Dụng cho byte-range requests.
  - Origin đảm bảo: cứng ETag -> tuyet doi giong nhau.

Weak ETag:    ETag: W/"abc123"
  - Thay đổi khi NỘI DỤNG NGHIA thay đổi
    (metadata như cache timestamp có thể thấy đợi nhưng content giong).
  - Dụng cho semantic equivalence.
  - Origin đảm bảo: cứng ETag -> ngu dụng tuong duong.

VD: Cứng sản phẩm, 2 request:
  Response 1: { name: "Ao", price: 100, _cache_ts: 1234567890 }
  Response 2: { name: "Ao", price: 100, _cache_ts: 1234567891 }
  
  Nếu dùng strong ETag hash toàn bộ body: ETag khac (vì _cache_ts)
  Nếu dùng weak ETag hash content chinh: ETag giong (name, price giong)
```

**ETag trong CDN flow**:

```text
Lần 1: Client -> CDN -> Origin
  Origin: 200 OK, body: {...}, ETag: "abc123"
  CDN: Cache body + ETag, TTL=60s

Lần 2a (TTL còn): Client -> CDN
  CDN: HIT, serve cached body, ETag: "abc123"

Lần 2b (TTL hết, revalidate): Client -> CDN -> Origin
  CDN: If-None-Match: "abc123"
  Origin: "abc123" vẫn dùng -> 304 Not Modified
  CDN: Update TTL, serve cached body

Lần 2c (TTL hết, object thay đổi): Client -> CDN -> Origin
  CDN: If-None-Match: "abc123"
  Origin: object đã thay đổi (ETag: "xyz789") -> 200 OK, body mới
  CDN: Cache body mới + ETag mới, serve body mới
```

**Cách origin tạo ETag dụng cách**:

```text
GOOD: ETag = hash(nội dụng response body)
  -> Cứng nội dụng -> cứng ETag
  -> Khac nội dụng -> khac ETag
  -> Ổn định qua nhiều instance (cứng hash algorithm)

BAD: ETag = server_timestamp + instance_id
  -> Cứng nội dụng, khac instance -> khac ETag
  -> Revalidation luon fail
  -> Every request -> 200 (full body) thay vì 304

BAD: ETag = random UUID mới request
  -> Mới request -> ETag mới
  -> Revalidation không bảo giờ pass
  -> 304 không bảo giờ xay ra
```

### 6.4 Vary

```text
BOX: Vary
================================================================
Mục đích:        Khai báo NHỮNG REQUEST HEADER NAO lam thay
                 doi response content.
Vì trị:          Response header (origin -> CDN -> client)
Cũ phap:         Vary: Accept-Language, X-Geo-Country
Ai set:          Origin (app)
Ai consume:      CDN (cache key variant), Browser (cache isolation)
================================================================
```

**Vary là cache key dimension**:

```text
Không có Vary:
  Request 1: Accept-Language: vì -> response tieng Viết
  Request 2: Accept-Language: en -> CDN HIT -> serve tieng Viết
  -> User My thay tieng Viết -> cache leakage!

Có Vary: Accept-Language:
  Request 1: Accept-Language: vì -> CDN MISS -> cache v1
  Request 2: Accept-Language: en -> CDN MISS -> cache v2
  Request 3: Accept-Language: vì -> CDN HIT (v1) -> tieng Viết
  -> Mới variant có cache object rieng -> không leakage!
```

**Cách CDN sử dụng Vary**:

```text
1. CDN đọc Vary header tự origin response.
2. CDN tach ten các request header tự Vary (phần cách bởi ", ").
3. CDN hash giá trị các request header đo -> variant hash.
4. Cache key = hash(path + query) + variant hash.
5. Mới combination của Vary headers -> cache object rieng.

Ví dụ:
  Vary: Accept-Language, X-Geo-Country
  Request: Accept-Language: vì, X-Geo-Country: VN
  -> Variant hash = hash("vì" + "VN")

  Request: Accept-Language: en, X-Geo-Country: VN
  -> Variant hash = hash("en" + "VN")
  -> KHAC variant hash -> MISS -> cache object rieng
```

**Các Vary dimension trong case này**:

```text
Product detail: Vary: Accept-Language, X-Geo-Country, X-Device-Class,
                      X-Ab-Variant, X-User-Segment
  -> 2 languages * 2 countries * 2 devices * 2 AB * 2 segments
  -> Tối đa 32 variant cứng 1 product URL
  -> Mới variant cách lý TOT

Categories: Vary: Accept-Language, X-Geo-Country
  -> 2 languages * 2 countries = 4 variant
  -> Categories service trả Vary headers nao nó thực sự dụng

Homefeed: Vary: Accept-Language, X-Geo-Country, X-Device-Class,
                X-Ab-Variant, X-User-Segment
  -> Đầy đủ 5 dimension cho personalization
```

### 6.5 Surrogate-Key

```text
BOX: Surrogate-Key
================================================================
Mục đích:        Gan TAG cho object de INVALIDATION THEO NHOM.
                 Một object có thể có nhiều tag (space-separated).
Vì trị:          Response header (origin -> CDN)
                 THUONG BỊ CDN STRIP (không forward cho client).
Cũ phap:         Surrogate-Key: product-1 catalog-homefeed segment-guest
Ai set:          Origin (app)
Ai consume:      CDN (Varnish) -- ban-tag operation
================================================================
```

**Surrogate-Key khac gi với purge/ban URL?**

```text
Purge URL: xóa chính xác 1 object theo URL
  VD: purge /api/sim/products/1?lang=vì&geo=VN
  -> Xóa DỤNG 1 variant của product 1
  -> Cần purge 32 lần de xóa hết all variants (nếu có 32 variant)

Ban URL prefix: xóa tất cả object có URL bắt đầu bằng prefix
  VD: ban /api/sim/products/1
  -> Xóa tất cả 32 variant
  -> Nhưng cũng xóa các URL KHAC bắt đầu bằng /api/sim/products/1
     (vd: /api/sim/products/10, /api/sim/products/1/recommendations)
  -> Có thể xóa NHAM object khac

Ban tag (Surrogate-Key): xóa tất cả object có tag
  VD: ban-tag product-1
  -> Xóa TẤT CẢ variant của product 1 (32 variant)
  -> KHÔNG xóa product 10 (tag: product-10)
  -> CHÍNH XÁC, AN TOAN, NHANH
```

**Cách Varnish xử lý Surrogate-Key**:

```text
1. Origin emit Surrogate-Key: product-1 catalog-homefeed segment-guest
2. Varnish (với xkey VMOD) đọc Surrogate-Key header.
3. Varnish register object vào hash table của từng tag:
   - Tag "product-1" -> [cache_key_1]
   - Tag "catalog-homefeed" -> [cache_key_1]
   - Tag "segment-guest" -> [cache_key_1]
4. Sau khi register, Varnish THUONG STRIP Surrogate-Key header
   (không forward đến client).
5. Khi admin goi ban-tag "product-1":
   - Varnish tìm tag "product-1" trong hash table
   - Lấy danh sach cache keys: [cache_key_1]
   - Xóa (invalidate) tất cả object đo
   - Request tiep theo -> MISS -> fetch tự origin

Đây là cơ chế INVALIDATION MANH ME Nhất của Varnish.
```

**Thiết kế Surrogate-Key cho các endpoint**:

```text
Product detail:
  Surrogate-Key: product-{id} catalog-products segment-{segment}
  -> product-1: xóa khi product 1 thay đổi
  -> catalog-products: xóa khi catalog thay đổi
  -> segment-guest: xóa khi guest cache policy thay đổi

Homefeed:
  Surrogate-Key: catalog-homefeed segment-{segment}
  -> catalog-homefeed: xóa khi homefeed catalog update
  -> segment-returning: xóa cho returning users (nếu cần)

Categories:
  Surrogate-Key: catalog-categories
  -> catalog-categories: xóa khi category tree thay đổi
```

### 6.6 Last-Modified

```text
BOX: Last-Modified
================================================================
Mục đích:        Timestamp lần cuoi object thay đổi.
                 Validator THAY THỂ cho ETag (kem chính xác hơn).
Vì trị:          Response header (origin -> CDN -> client)
Cũ phap:         Last-Modified: <http-date>
                 VD: Last-Modified: Wed, 21 Oct 2025 07:28:00 GMT
Ai set:          Origin (app)
Ai consume:      CDN, Browser (If-Modified-Since)
================================================================
```

**Last-Modified vs ETag**:

```text
+------------------+-----------------------------------+-----------------------------------+
| Tiêu chí         | ETag                              | Last-Modified                     |
+------------------+-----------------------------------+-----------------------------------+
| Độ chính xác     | CHÍNH XÁC byte-by-byte            | Độ chính xác 1 Giây               |
|                  | (strong) hoặc semantic (weak)      | (HTTP-date chỉ có second-level)   |
+------------------+-----------------------------------+-----------------------------------+
| Đo ổn định       | Phụ thuộc cách origin hash        | Dựa vào file timestamp hoặc       |
|                  | (nên là content hash)             | record updated_at                 |
+------------------+-----------------------------------+-----------------------------------+
| Cross-instance   | ON Định nếu dụng content hash     | KHÔNG ỔN ĐỊNH nếu server khac    |
|                  |                                   | đồng hồ                            |
+------------------+-----------------------------------+-----------------------------------+
| Conditional hdr  | If-None-Match                     | If-Modified-Since                 |
+------------------+-----------------------------------+-----------------------------------+
| Ưu tiên         | ETag được ưu tiên (HTTP spec)     | Nếu có ETag, Last-Modified        |
|                  |                                   | là validator DỮ PHONG              |
+------------------+-----------------------------------+-----------------------------------+
```

**Trong Varnish**: Varnish ưu tiên ETag cho revalidation. Nếu không có ETag,
Varnish sử dụng Last-Modified với If-Modified-Since.

---

## 7. 304 Revalidation deep-dive

### Tải sao 304 là "chế đo tiết kiệm băng thông"?

```text
So sanh 2 scenario:

SCENARIO A: Không có revalidation (không ETag)
  Object hết hạn -> CDN luon fetch full body tự origin
  Mới request MISS: origin trả 200 OK + ~4KB body
  1000 requests = 4MB băng thông origin->CDN

SCENARIO B: CÓ revalidation (có ETag)
  Object hết hạn -> CDN gửi If-None-Match
  Origin trả 304 Not Modified (KHÔNG body)
  Mới revalidation: origin trả ~200 bytes headers
  1000 revalidations = ~200KB băng thông origin->CDN

=> TIẾT KIỆM 95% băng thông giữa origin và CDN
```

### Full 304 flow (từng bước)

```text
BƯỚC 0: TRẠNG THÁI BAN DAU
  CDN cache: object với body, ETag="abc123", TTL=60s, expired=false

BƯỚC 1: TTL HẾT HẠN (t > 60s)
  CDN cache: same object, expired=true
  (Object vẫn còn trong cache, nhưng đã "stale")

BƯỚC 2: CLIENT REQUEST ĐẾN
  Client: GET /api/sim/products/1
          Host: localhost:80
          Accept-Language: vì
          X-Geo-Country: VN

BƯỚC 3: CDN XỬ LÝ
  CDN tìm object trong cache:
    - Có object với key tương ứng
    - Những expired=true
  CDN QUYẾT ĐỊNH: revalidate (không serve stale ngày)
  CDN gửi request đến origin:

    GET /api/sim/products/1 HTTP/1.1
    Host: backend:8080
    Accept-Language: vì
    X-Geo-Country: VN
    If-None-Match: "abc123"       <-- ETag của cached object

BƯỚC 4: ORIGIN XỬ LÝ
  Origin nhận request:
    - Tính toán ETag cho response hiện tại: "abc123"
    - So sánh với If-None-Match: khop!
  Origin QUYẾT ĐỊNH: body không thấy doi -> 304

    HTTP/1.1 304 Not Modified
    Cache-Control: public, s-maxage=60, stale-while-revalidate=30, stale-if-error=120
    ETag: "abc123"                <-- CỨNG etag
    Date: Sun, 22 Jun 2026 10:00:00 GMT

    (KHÔNG CÓ BODY)

BƯỚC 5: CDN CẬP NHẬT
  CDN nhận 304:
    - Cập nhật TTL: set lại 60s (tự Cache-Control header mới)
    - Cập nhật expired=false
    - GIU NGUYEN cached body (body không thấy doi)

BƯỚC 6: CDN RESPONSE CHO CLIENT
  CDN trả về client:

    HTTP/1.1 200 OK               <-- CDN trả 200 (không phải 304)
    Cache-Control: public, s-maxage=60, ...
    ETag: "abc123"
    X-Cache: HIT                  <-- Đây là HIT (tự cache)
    Content-Length: 4096
    ...

    {body tự CDN cache}           <-- Không tôn băng thông origin

=> CLIENT LUON THAY 200 (hoặc 304 tuy VCL config)
   CDN+ORIGIN ĐÃ TIẾT KIỆM 95% BĂNG THÔNG
```

### Code trace trong script

```javascript
// === REQUEST 1: Lay ETag ===
const detail = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'detail_contract' },
});
// Response: 200 OK, ETag: "abc123", X-Cache: MISS

const detailETag = getHeader(detail, 'ETag');
// detailETag = "abc123"

// === REQUEST 2: Revalidate voi ETag ===
const revalidated = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  headers: {
    'Cache-Control': 'no-cache',   // -- (1) bao CDN "phai revalidate"
    'If-None-Match': detailETag,   // -- (2) bao origin "toi co ETag nay"
  },
  tags: { case: 'detail_revalidate' },
});
// Response: 304 Not Modified

assertStatus(revalidated, 304, 'detail revalidation');
```

**Giải thích 2 header trong request 2**:

```text
(1) Cache-Control: nó-cache
    Client bảo CDN: "Dụng serve tự cache, hay hoi origin trước."
    CDN hiệu: đây là conditional request, cần revalidate.
    Nếu không có header này: CDN có thể serve STALE (nếu trong
    grace period) mà không thực sự hoi origin -> 304 không xay ra.

(2) If-None-Match: "abc123"
    Client (qua CDN) bảo origin: "Tối đa có object với ETag 'abc123'.
    Nếu nó còn dụng, trả 304. Nếu nó sai, trả 200 với body mới."
    Origin so sanh ETag hiện tại của object với "abc123":
      - Khop -> 304
      - Không khớp -> 200
```

### Các trường hợp 304 không xay ra

```text
Trường hợp 1: ETag không ổn định
  -> Mới request origin trả ETag khac nhau (dữ cứng nội dụng)
  -> If-None-Match luôn không khop -> luon 200
  -> Giong như không có revalidation

Trường hợp 2: Origin không hỗ trợ If-None-Match
  -> Origin bo qua If-None-Match, luon trả 200
  -> CDN vẫn cache, nhưng không tiết kiệm được băng thông

Trường hợp 3: CDN không forward If-None-Match
  -> CDN config sai, strip If-None-Match header
  -> Origin không bảo giờ nhận conditional request -> luon 200

Trường hợp 4: Cache-Control: nó-cache thieu
  -> CDN serve stale mà không revalidate
  -> Không gửi request đến origin -> 304 không xay ra
  -> Client nhận 200 tự cache (stale) thay vì 304

Trường hợp 5: Object đã bị xóa khỏi CDN cache
  -> Không còn object de revalidate
  -> CDN phải fetch FULL tự origin -> 200 (MISS)
  -> Nếu object bị evict (LRU) trước khi TTL hết -> mặt có hoi 304
```

### 304 trong CDN khac gi 304 trong browser?

```text
Browser nhận 304:
  - Browser tự cập nhật cached object TTL
  - Browser hiển thị cached content
  - User không thấy gi khac

CDN nhận 304:
  - CDN cập nhật TTL trong cache storage
  - CDN serve cached body cho TẤT CẢ client tiep theo
  - 1 request revalidation -> lợi ích cho HANG NGẮN request sau

=> 304 o CDN layer có Ý NGHĨA NHẬN LÊN:
   Origin chỉ ton ~200 bytes headers cho 1 revalidation,
   những tiết kiệm được ~4KB body * N request tiep theo.
```

---

## 8. Key signals

### Response headers cần quản sát

```text
+------------------------+----------+-------------------------------------------+
| Header                 | Source   | Ý nghĩa                                   |
+------------------------+----------+-------------------------------------------+
| X-Cache                | Varnish  | HIT / MISS / BYPASS: cache status          |
+------------------------+----------+-------------------------------------------+
| Cache-Control          | Origin   | Policy cho browser + CDN                  |
+------------------------+----------+-------------------------------------------+
| CDN-Cache-Control      | Origin   | Policy rieng cho CDN                       |
+------------------------+----------+-------------------------------------------+
| ETag                   | Origin   | Validator danh tính cho body              |
+------------------------+----------+-------------------------------------------+
| Last-Modified          | Origin   | Validator thời giản (dữ phong)             |
+------------------------+----------+-------------------------------------------+
| Surrogate-Key          | Origin   | Tag de ban-tag invalidation               |
+------------------------+----------+-------------------------------------------+
| Vary                   | Origin   | Variant isolation dimensions              |
+------------------------+----------+-------------------------------------------+
| X-Cache-Key-Language   | Varnish  | Language dimension trong cache key         |
+------------------------+----------+-------------------------------------------+
| X-Cache-Key-Geo        | Varnish  | Geo dimension trong cache key             |
+------------------------+----------+-------------------------------------------+
| X-Cache-Key-Device     | Varnish  | Device dimension trong cache key           |
+------------------------+----------+-------------------------------------------+
| X-Cache-Key-AB         | Varnish  | AB variant dimension trong cache key       |
+------------------------+----------+-------------------------------------------+
| X-Cache-Key-Segment    | Varnish  | Segment dimension trong cache key          |
+------------------------+----------+-------------------------------------------+
```

### Expected values

```text
PRODUCT DETAIL (/api/sim/products/1):

  Cache-Control:        public, s-maxage=<N>, stale-while-revalidate=<N>,
                        stale-if-error=<N>
  CDN-Cache-Control:    max-age=<N>, stale-while-revalidate=<N>,
                        stale-if-error=<N>
  ETag:                 W/"<hash>" hoặc "<hash>"
  Last-Modified:        <http-date>
  Surrogate-Key:        ... product-1 ... (phải chưa product-{id})
  Vary:                 <danh sach request headers cách nhau bởi ", ">

HOMEFEED (/api/sim/products/homefeed):

  Surrogate-Key:        ... catalog-homefeed ... segment-returning ...

CATEGORIES (/api/sim/products/categories):

  Vary:                 ... Accept-Language ... X-Geo-Country ...

304 REVALIDATION:

  Status:               304 Not Modified
  Body:                 empty (0 bytes hoặc rất nhỏ)
  ETag:                 GIONG với ETag request 1
```

### 200 vs 304 distinction

```text
+------------------+-----------------------------------+-----------------------------------+
| Signal           | 200 OK (first request)            | 304 Not Modified (revalidation) |
+------------------+-----------------------------------+-----------------------------------+
| Body             | Có body (JSON, ~4KB)              | KHÔNG body (0 bytes)              |
+------------------+-----------------------------------+-----------------------------------+
| ETag             | Có (validator cho tuong lại)      | Có (cứng giá trị)                 |
+------------------+-----------------------------------+-----------------------------------+
| Cache-Control    | Có (policy đầy đủ)                | Có (policy đầy đủ)                |
+------------------+-----------------------------------+-----------------------------------+
| X-Cache          | MISS                              | Không có (CDN internal)           |
+------------------+-----------------------------------+-----------------------------------+
| Ý nghĩa         | Object mới được fetch             | Object Không thấy doi              |
+------------------+-----------------------------------+-----------------------------------+
| Băng thông      | Ton ~4KB origin -> CDN            | Ton ~200 bytes origin -> CDN      |
+------------------+-----------------------------------+-----------------------------------+
```

### Cache-Control directive map

```text
Response tự cacheable endpoint Phải có:

  Cache-Control:
    [x] public
    [x] s-maxage=N
    [x] stale-while-revalidate=N
    [x] stale-if-error=N

  CDN-Cache-Control:
    [x] max-age=N
    [x] stale-while-revalidate=N
    [x] stale-if-error=N

  Validator (ít nhất 1):
    [x] ETag
    [x] Last-Modified

  Invalidation:
    [x] Surrogate-Key (không empty)

  Variant isolation:
    [x] Vary (không empty, chứa các header dụng)
```

---

## 9. Pass/fail criteria

### PASS khi

```text
1. TẤT CẢ checks đều pass (checks rate = 1 theo threshold).

2. TẤT CẢ required headers hien diện:
   - Product detail: Cache-Control, CDN-Cache-Control, ETag,
     Last-Modified, Surrogate-Key, Vary
   - Homefeed: Surrogate-Key chưa catalog-homefeed, segment-returning
   - Categories: Vary chưa Accept-Language, X-Geo-Country

3. Cache-Control chứa các directive bắt buộc:
   - public (cho phep CDN cache)
   - s-maxage=N (TTL cho shared cache)
   - stale-while-revalidate=N (grace period khi revalidate)
   - stale-if-error=N (grace period khi origin lỗi)

4. CDN-Cache-Control chứa các directive bắt buộc:
   - max-age=N (CDN-specific TTL)
   - stale-while-revalidate=N
   - stale-if-error=N

5. ETag hien diện VÀ ỔN ĐỊNH:
   - Response 1 có ETag
   - Response 2 (revalidate) có cùng ETag

6. 304 revalidation hoạt động:
   - Gửi If-None-Match với ETag tự response 1
   - Nhận được 304 Not Modified

7. Surrogate-Key chưa tag theo dụng convention:
   - Product detail: chưa product-{id}
   - Homefeed: chưa catalog-homefeed, segment-{segment}

8. Homefeed response success = true.

9. Categories response success = true.
```

### FAIL khi

```text
HEADER THIEU:

  [FAIL] Thieu Cache-Control -> CDN không biết cache bảo lau
  [FAIL] Thieu CDN-Cache-Control -> CDN không có TTL rieng
  [FAIL] Thieu ETag -> không thể revalidate
  [FAIL] Thieu Last-Modified -> không có validator dữ phong
  [FAIL] Thieu Surrogate-Key -> không thể ban-tag invalidate
  [FAIL] Thieu Vary -> không có variant isolation

DIRECTIVE THIEU:

  [FAIL] Cache-Control không có public -> CDN có thể không cache
  [FAIL] Cache-Control có private -> CDN KHÔNG ĐƯỢC cache
  [FAIL] Cache-Control không có s-maxage -> CDN không biết TTL
  [FAIL] Cache-Control không có stale-while-revalidate
  [FAIL] Cache-Control không có stale-if-error

304 REVALIDATION FAIL:

  [FAIL] ETag có nhưng 304 không xay ra (trả 200)
         -> ETag không ổn định hoặc origin không hỗ trợ If-None-Match
  [FAIL] ETag thay đổi giữa 2 request (dữ cứng nội dụng)
         -> ETag hash bị sai (timestamp-based)

SURROGATE-KEY SAI:

  [FAIL] Surrogate-Key empty
  [FAIL] Surrogate-Key không chưa product-{id} (với product detail)
  [FAIL] Surrogate-Key không chưa catalog-homefeed (với homefeed)

RESPONSE BODY SAI:

  [FAIL] categories response success=false
  [FAIL] homefeed response không parse được JSON
```

---

## 10. Cách chạy + output

### Cách chạy

```powershell
# Tu working directory cua project
cd E:/Projects/k6/k6-metrics-server

# Set env vars
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

# Chay script
./scripts/run-cdn-capabilities.ps1 -Scenarios 07-cache-contract
```

Hoặc chạy trực tiếp bằng k6:

```powershell
k6 run `
  -e BASE_URL=http://localhost:80 `
  -e CONTROL_BASE_URL=http://localhost:8088 `
  -e CATALOG_EVENTS_BASE_URL=http://localhost:9091 `
  -e OPS_AUTH_TOKEN=<ops-token> `
  load-target/k6/cdn/07-cache-contract.js
```

### Output mong doi (PASS)

```text
  execution: local
     script: load-target/k6/cdn/07-cache-contract.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations shared among 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)

  ✓ detail contract status 200
  ✓ detail contract Cache-Control present
  ✓ detail contract Cache-Control has public
  ✓ detail contract Cache-Control has s-maxage=
  ✓ detail contract Cache-Control has stale-while-revalidate=
  ✓ detail contract Cache-Control has stale-if-error=
  ✓ detail contract CDN-Cache-Control present
  ✓ detail contract CDN-Cache-Control has max-age=
  ✓ detail contract CDN-Cache-Control has stale-while-revalidate=
  ✓ detail contract CDN-Cache-Control has stale-if-error=
  ✓ detail contract ETag present
  ✓ detail contract Last-Modified present
  ✓ detail contract Surrogate-Key present
  ✓ detail contract Surrogate-Key has product-1
  ✓ detail contract Vary present
  ✓ detail revalidation status 304
  ✓ homefeed contract status 200
  ✓ homefeed contract Surrogate-Key has catalog-homefeed
  ✓ homefeed contract Surrogate-Key has segment-returning
  ✓ categories contract status 200
  ✓ categories contract Vary has Accept-Language
  ✓ categories contract Vary has X-Geo-Country

  checks.........................: 100.00% ✓ 22       ✗ 0
  data_received..................: 15 kB   1.1 kB/s
  data_sent......................: 2.4 kB  172 B/s
  http_req_duration.............: avg=45.2ms  min=23.1ms med=38.7ms max=89.3ms p(95)=78.2ms
  http_req_blocked..............: avg=1.2ms   min=0.1ms  med=0.3ms  max=5.2ms  p(95)=4.1ms
  http_req_connecting...........: avg=0.8ms   min=0.0ms  med=0.2ms  max=3.1ms  p(95)=2.8ms
  http_reqs.....................: 4       0.286/s
  iteration_duration............: avg=302.5ms min=302.5ms med=302.5ms max=302.5ms p(95)=302.5ms
  iterations....................: 1       0.071/s
  vus............................: 1       min=1 max=1
  vus_max........................: 1       min=1 max=1

running (00m14.0s), 1/1 VUs, 1 complete and 0 interrupted iterations
default ✓ [======================================] 1 VUs  00m14.0s/10m0s  1/1 shared iters
```

### Output khi FAIL

```text
  ✗ detail contract status 200
    ↳  0% — ✓ 0 / ✗ 1

  ✗ detail contract Cache-Control present
    ↳  0% — ✓ 0 / ✗ 1

  ✗ detail contract Cache-Control has public
    ↳  0% — ✓ 0 / ✗ 1

  ... (các checks khac cứng fail nếu headers thieu)

  checks.........................: 0.00%  ✓ 0        ✗ 22
```

### Cách đọc output

```text
1. NHIN ĐẦU TIÊN vào checks: 100% ✓ 22 ✗ 0 -> PASS
   Hoặc: 0% ✓ 0 ✗ 22 -> FAIL

2. Nếu FAIL: tìm check FAIL ĐẦU TIÊN.
   Đây là ROOT CAUSE.
   VD: "detail contract Cache-Control present" fail
   -> Origin KHÔNG emit Cache-Control
   -> CÁC CHECK SAU (has public, has s-maxage) cứng fail theo
   -> Không cần fix từng check, chỉ cần fix ROOT CAUSE là origin emit Cache-Control

3. Nếu PASS những muon INSPECT response headers:
   -> Dụng --http-debug="full" de xem toàn bộ headers
   -> Hoặc thêm console.log trong script

4. Nếu 304 revalidation FAIL:
   -> Kiểm trả ETag có thay đợi không (console.log ca 2 ETag)
   -> Kiểm trả origin log: có If-None-Match header không?
   -> Kiểm trả VCL: có forward If-None-Match không?
```

---

## 11. 4 output-to-decision scenarios

### Scenario 1: MISSING Cache-Control -- CDN không cache

```text
OUTPUT:
  ✗ detail contract Cache-Control present
  ✗ detail contract Cache-Control has public
  ✗ detail contract Cache-Control has s-maxage=
  ...
  Tất cả checks lien quản đến Cache-Control đều FAIL.

ROOT CAUSE:
  Origin handler không emit Cache-Control header.
  Hoặc middleware/framework đã strip Cache-Control.

CDN BEHAVIOR:
  Varnish không có Cache-Control -> không biết TTL.
  > Nếu VCL default TTL = 0s -> KHÔNG CACHE
  > Nếu VCL default TTL = 120s -> cache 120s (nhưng không được kiểm soát)
  > KHÔNG CÓ stale-while-revalidate, stale-if-error
  > Mới request đều MISS -> origin nhận 100% traffic

DECISION:
  KHÔNG ĐƯỢC DEPLOY RA PRODUCTION.
  Origin PHẢI emit Cache-Control với:
    - public
    - s-maxage=N (dinh ro TTL)
    - stale-while-revalidate=N
    - stale-if-error=N

FIX:
  Thêm applySimpleCDNCacheHeaders(c, ttl, staleIfError) vào handler.
  Hoặc set header thủ công trong handler code.
```

### Scenario 2: ETag MISSING -- không revalidation

```text
OUTPUT:
  ✓ detail contract Cache-Control present
  ✓ detail contract CDN-Cache-Control present
  ✗ detail contract ETag present               <-- FAIL
  ✗ detail revalidation status 304             <-- Auto FAIL (không có ETag)

ROOT CAUSE:
  Origin không tạo ETag cho response.
  Có thể đo framework không tự đồng tạo ETag,
  hoặc middleware đã strip ETag header.

CDN BEHAVIOR:
  Object vẫn được cache (có Cache-Control).
  Những khi hết hạn -> CDN KHÔNG THỂ revalidate.
  CDN phải fetch full body tự origin (200 OK).
  > Băng thông origin -> CDN tang 20x.
  > Latency tang (phải cho full body transfer).

DECISION:
  CÓ THỂ DEPLOY (vẫn còn CDN cache).
  NHƯNG CẦN FIX SOM:
    - Mới TTL expiry -> full body fetch -> lang phi băng thông.
    - Khi traffic cao -> origin lại bị quá tải.

FIX:
  Thêm ETag middleware vào framework.
  Hoặc manual set ETag header = hash(response body).
  Đảm bảo ETag ỔN ĐỊNH qua các instance.
```

### Scenario 3: 304 NEVER RETURNED -- origin luon trả full body

```text
OUTPUT:
  ✓ detail contract ETag present
  ✗ detail revalidation status 304            <-- FAIL (trả 200 thay vì 304)

ROOT CAUSE (3 kha nang):
  1. ETag không ổn định: mới request trả ETag khac
     -> Origin dụng server timestamp + instance ID để tạo ETag
     -> If-None-Match không bảo giờ khop -> luon 200

  2. Origin không hỗ trợ If-None-Match
     -> Origin bo qua conditional header, luon trả 200 + body
     -> ETag có nhưng chỉ de "trang trị"

  3. CDN không forward If-None-Match
     -> VCL strip hoặc không thêm If-None-Match khi revalidate
     -> Origin không bảo giờ nhận conditional request

CDN BEHAVIOR:
  Object vẫn được cache.
  Khi hết hạn -> fetch full body -> BĂNG THÔNG BỊ LANG PHI.
  Mới TTL cycle, origin phải gửi full body (có thể 4KB-100KB).
  Nếu 1000 requests/cycle -> ton ~4-100MB bằng thống không cần thiết.

DECISION:
  KHÔNG ĐƯỢC DEPLOY (nếu ETag đã có nhưng 304 không hoạt động).
  Đây là đầu hiệu của ETag IMPLEMENTATION SAI.
  Nếu ETag dụng, 304 PHẢI hoạt động.

DEBUG:
  console.log("ETag request 1:", detailETag);
  console.log("ETag request 2:", getHeader(revalidated, 'ETag'));
  -> Nếu 2 ETag KHAC nhau: ETag hash sai -> fix hash algorithm
  -> Nếu 2 ETag GIONG nhau nhưng vẫn 200:
     -> Kiểm trả origin log: có If-None-Match?
     -> Kiểm trả VCL: có gửi If-None-Match đến backend?
     -> Kiểm trả CDN: có forward If-None-Match tự client?
```

### Scenario 4: Surrogate-Key MISSING -- không thể ban-tag

```text
OUTPUT:
  ✓ detail contract Cache-Control present
  ✓ detail contract ETag present
  ✓ detail revalidation status 304
  ✗ detail contract Surrogate-Key present      <-- FAIL

ROOT CAUSE:
  Origin handler không gan Surrogate-Key header.
  Hoặc Surrogate-Key empty (chỉ chưa whitespace).

CDN BEHAVIOR:
  Object vẫn được cache BÌNH THƯỜNG.
  Nhưng không THỂ BAN-TAG:
    - Admin muon xóa tất cả variant của product 1
    -> Không có tag "product-1" -> không thể ban-tag
    -> Phải purge từng URL variant (32 lần)
    -> Hoặc ban URL prefix (có thể xóa nham product 10, 11, ...)
  > Invalidation CHẬM, TỒN TẠI NGUYEN, DE SAI.

DECISION:
  CÓ THỂ DEPLOY (vẫn có cache, vẫn có revalidation).
  NHƯNG PHẢI FIX TRƯỚC KHI CẦN INVALIDATION NHANH.
  Nếu app có yêu cầu "cập nhật giá ngày lập tức" -> CẦN Surrogate-Key.

FIX:
  Thêm Surrogate-Key header vào response:
    - Product detail: Surrogate-Key: product-{id} catalog-products segment-{segment}
    - Homefeed: Surrogate-Key: catalog-homefeed segment-{segment}
    - Categories: Surrogate-Key: catalog-categories
  Đảm bảo tag naming convention nhất quán.
```

---

## 12. Nghịch lý / misconceptions

### Misconception 1: "304 nghĩa là lỗi"

```text
NHIỀU NGUOI HIEN LAM: 304 là status error.

THỰC TẾ: 304 Not Modified là một TRONG NHỮNG STATUS THÀNH CÔNG
QUẢN TRỌNG NHẤT trong HTTP caching.

  - 200 OK: "Đây là object. Tối gửi ca body."
  - 304 Not Modified: "Object của anh vẫn còn tot. Tối KHÔNG gửi body."

304 là đầu HIỆU CỦA MỘT HỆ THỐNG CACHE HOẠT ĐỘNG ĐÚNG:
  - ETag hoạt động
  - If-None-Match được hỗ trợ
  - Origin dụng conditional logic
  - Băng thông được tiết kiệm

NẾU TEST TRẢ VỀ 200 KHI MONG DOI 304 -> FAIL.
NẾU TEST TRẢ VỀ 304 KHI MONG DOI 304 -> PASS.

304 không bảo giờ là "lỗi". Nó là "tối ưu hóa".
```

### Misconception 2: "Cache-Control là đủ, không cần CDN-Cache-Control"

```text
NHIỀU NGUOI NGHI: "Cache-Control đã cố s-maxage roi,
CDN hiệu s-maxage, cần gi CDN-Cache-Control nua?"

THỰC TẾ: CDN-Cache-Control có vai trò KHAC BIET:

  1. Separation of concerns:
     Cache-Control: target browser + generic proxy
     CDN-Cache-Control: target CDN specifically

  2. Different TTL strategies:
     Browser cần cache 5s (fast repeat view)
     CDN cache 600s (offload origin)
     -> Không thể bieu diện bằng 1 Cache-Control header
        (s-maxage ghi de max-age những browser vẫn dùng max-age)

  3. Private browser, public CDN:
     Cache-Control: private, max-age=300   (browser cache 5m)
     CDN-Cache-Control: max-age=3600       (CDN cache 1h)
     -> Origin muon browser private cache những CDN public cache

  4. CDN-specific directives:
     Một số CDN hỗ trợ directive rieng (vd: CDN-Cache-Control: nó-cdn)
     Không thể diện ta bằng Cache-Control chuẩn.

=> CDN-Cache-Control KHÔNG PHẢI "optional nice-to-have".
   Nó là một PHẦN CỦA CONTRACT HOÀN CHỈNH.
```

### Misconception 3: "ETag thay đổi mới request là bình thường"

```text
NHIỀU NGUOI NGHI: "ETag là random string, mới request khác là OK."

THỰC TẾ: ETag PHẢI ỔN ĐỊNH cho cứng nội dụng.

Nếu ETag thay đổi mới request:
  -> Mới revalidation đều thật bai (If-None-Match không khớp)
  -> Origin LUON trả 200 (full body) thay vì 304
  -> Băng thông BỊ LANG PHI
  -> ETag thành VÔ DỤNG

ETag DỤNG:
  ETag = hash(JSON.stringify(response_body))
  -> Cứng body -> cứng hash -> cứng ETag
  -> Khac body -> khac hash -> khac ETag
  -> Ổn định qua mới request, mới instance

Nếu không thể hash body (performance):
  ETag = hash(content_version + content_updated_at)
  -> Cứng version + cứng timestamp -> cứng ETag
  -> Khi content update -> version thay đổi -> ETag khac
```

### Misconception 4: "Vary là không quản trong, không cần kiểm trả"

```text
NHIỀU NGUOI NGHI: "Vary chỉ là metadata, không ảnh hưởng đến logic."

THỰC TẾ: Vary là DIMENSION CỦA CACHE KEY.
Nếu Vary SAI -> CACHE LEAKAGE NGUY HIEM.

Ví dụ thực tế:
  App trả Vary: Accept-Language cho product detail.
  User VN request -> cache object tieng Viết.
  User US request:
    - Nếu Vary DỤNG: MISS -> fetch tieng Anh -> DỤNG.
    - Nếu Vary THIEU: HIT -> serve tieng Viết -> SAI.
      User My thay "Ao so mi" thay vì "T-shirt".
      -> Không hiệu -> không mua -> lost revenue.

  App không trả Vary nhưng thực tế có variant theo Header:
    -> CDN cache object ĐẦU TIÊN được fetch
    -> Tất cả user sau đều HIT object đo
    -> User VN -> MISS -> cache tieng Viết
    -> User US -> HIT -> nhận tieng Viết
    -> User VN (mobile) -> HIT -> nhận tieng Viết (? dụng)
    -> User VN (desktop) -> HIT -> nhận mobile layout

  => Vary SAI = DATA CORRUPTION trong CDN.
     Đây là bug NGUY HIEM vì nó IM LANG:
     - Tất cả status 200 (không có error)
     - Tất cả user đều nhận response (không có 5xx)
     - Những NỘI DỤNG SAI -> business impact rất lớn
```

### Misconception 5: "Surrogate-Key là optional, purge URL là đủ"

```text
NHIỀU NGUOI NGHI: "Cần invalidate thì purge URL. Cần gi Surrogate-Key?"

THỰC TẾ: Purge URL chỉ hoạt động với SỐ ÍT variant.

Ví dụ: Product detail có 5 variant dimensions, 2-3 giá trị mới dimension.
  -> Tong variant: 2*2*2*2*2 = 32 variant cho CỨNG 1 product.
  -> Nếu dùng purge URL: PHẢI LIET KẾ VÀ PURGE TỪNG VARIANT.
     Nếu thieu 1 variant -> user vẫn thấy cached object CŨ.
  -> Nếu dùng ban-tag product-1: 1 LẦN XÓA DỮ 32 VARIANT.
     Không lo thieu, không mặt thời giản liet kế.

Ngoài ra:
  - Surrogate-Key cho phep INVALIDATION THEO BUSINESS LOGIC:
    "Xóa tất cả homefeed cho returning users" -> ban-tag segment-returning
    "Xóa tất cả categories" -> ban-tag catalog-categories
  - Purge URL chỉ xóa THEO URL PATTERN (thuan kỹ thuật, không business)
```

---

## 13. Checklist

### Trước khi chay test

```text
[ ] TargetLayer = full (CDN + Nginx + app)
[ ] Tất cả upstream services healthy
[ ] OPS_AUTH_TOKEN được set
[ ] BASE_URL = http://localhost:80 (di qua Varnish)
[ ] CONTROL_BASE_URL = http://localhost:8088
[ ] CATALOG_EVENTS_BASE_URL = http://localhost:9091
[ ] Không có cache warming trước (cache sach hoặc cold)
```

### Kiểm trả headers

```text
PRODUCT DETAIL:
[ ] Cache-Control present
[ ] Cache-Control chưa: public
[ ] Cache-Control chưa: s-maxage=N (N > 0)
[ ] Cache-Control chưa: stale-while-revalidate=N (N > 0)
[ ] Cache-Control chưa: stale-if-error=N (N > 0)
[ ] CDN-Cache-Control present
[ ] CDN-Cache-Control chưa: max-age=N (N > 0)
[ ] CDN-Cache-Control chưa: stale-while-revalidate=N
[ ] CDN-Cache-Control chưa: stale-if-error=N
[ ] ETag present
[ ] Last-Modified present
[ ] Surrogate-Key present + not empty
[ ] Surrogate-Key chưa: product-{id}
[ ] Vary present + not empty
[ ] Vary chứa các dimension dụng (Accept-Language, X-Geo-Country, ...)

HOMEFEED:
[ ] Status 200
[ ] Surrogate-Key chưa: catalog-homefeed
[ ] Surrogate-Key chưa: segment-{segment}
[ ] Body parse được JSON, success=true

CATEGORIES:
[ ] Status 200
[ ] Vary chưa: Accept-Language
[ ] Vary chưa: X-Geo-Country
[ ] Body parse được JSON, success=true
```

### Kiểm trả 304 revalidation

```text
[ ] Response 1 (200) có ETag
[ ] ETag không empty
[ ] Response 2 (với If-None-Match) có status 304
[ ] ETag response 2 == ETag response 1
[ ] Response 2 Không có body (hoặc body rất nhỏ)
```

### Sau khi test pass

```text
[ ] Checks rate = 1 (100%)
[ ] Tất cả thresholds pass
[ ] Không có exception nao
[ ] Http errors = 0 (304 KHÔNG PHẢI ERROR)
[ ] Nếu có thêm kiểm trả, tất cả đều pass
```

---

## 14. Variations

### Variation 1: Different TTL values

```text
Mục đích: Kiểm trả origin có thể emit TTL khac nhau cho
          các endpoint khac nhau.

Thay đổi: Thay vì chỉ test 1 TTL value, test nhiều endpoint
          với TTL khac nhau.

Ví dụ script mở rộng:
  // Product detail: TTL 60s
  assertHeaderContains(detail, 'Cache-Control', 's-maxage=60', 'product ttl');

  // Homefeed: TTL 30s (thay đổi nhanh hon)
  const homefeed = requestCdn('GET', paths.homefeed, {
    profile: profiles.returningVNMobileVariantA,
  });
  assertHeaderContains(homefeed, 'Cache-Control', 's-maxage=30', 'homefeed ttl');

  // Categories: TTL 300s (ít thay đổi)
  const categories = requestCdn('GET', paths.categories, {
    profile: profiles.guestUSDesktopControl,
  });
  assertHeaderContains(categories, 'Cache-Control', 's-maxage=300', 'categories ttl');

Ý nghĩa:
  - Mới endpoint có TTL phù hợp với BUSINESS REQUIREMENTS.
  - Product thay đổi gia thuong xuyen -> TTL ngắn.
  - Categories ít thay đổi -> TTL dài.
  - Nếu TTL giong nhau cho tất cả -> có thể là "copy-paste config",
    không phải "designed per endpoint".
```

### Variation 2: CDN-Cache-Control override

```text
Mục đích: Kiểm trả CDN-Cache-Control có TTL Khác với Cache-Control.
          Đây là tính năng quản trọng cho CDN-specific TTL.

Thay đổi: Assert CDN-Cache-Control max-age != Cache-Control s-maxage.

Ví dụ script mở rộng:
  const cacheControl = getHeader(detail, 'Cache-Control');
  const cdnCacheControl = getHeader(detail, 'CDN-Cache-Control');

  // Extract s-maxage tự Cache-Control
  const sMaxAgeMatch = cacheControl.match(/s-maxage=(\d+)/);
  const sMaxAge = sMaxAgeMatch ? parseInt(sMaxAgeMatch[1]) : 0;

  // Extract max-age tự CDN-Cache-Control
  const cdnMaxAgeMatch = cdnCacheControl.match(/max-age=(\d+)/);
  const cdnMaxAge = cdnMaxAgeMatch ? parseInt(cdnMaxAgeMatch[1]) : 0;

  // CDN-Cache-Control max-age có thể >= Cache-Control s-maxage
  if (cdnMaxAge < sMaxAge) {
    throw new Error(
      `CDN-Cache-Control max-age=${cdnMaxAge} < Cache-Control s-maxage=${sMaxAge}. ` +
      `CDN nên cache LÂU HƠN hoặc bằng browser, không được ngắn hơn.`
    );
  }

  console.log(
    `CDN TTL: ${cdnMaxAge}s (from CDN-Cache-Control), ` +
    `Browser shared TTL: ${sMaxAge}s (from Cache-Control)`
  );

Ý nghĩa:
  - CDN-Cache-Control cho phep CDN cache lâu hơn browser.
  - Nếu CDN cache Ngắn hơn browser -> không tôi ưu.
  - Đây là validation về "separation of concerns" của 2 header.
```

### Variation 3: Weak vs Strong ETag

```text
Mục đích: Kiểm trả loại ETag (weak W/"..." hay strong "...")
          và đảm bảo nó ỔN ĐỊNH.

Thay đổi: Assert ETag format và đo ổn định qua 2 request.

Ví dụ script mở rộng:
  const etag1 = getHeader(detail, 'ETag');
  // Kiểm trả format: weak hay strong
  const isWeak = etag1.startsWith('W/"');
  const isStrong = etag1.startsWith('"');

  if (!isWeak && !isStrong) {
    throw new Error(`ETag format invalid: ${etag1}`);
  }

  console.log(`ETag type: ${isWeak ? 'WEAK' : 'STRONG'}`);

  // Request 2: phải có CỨNG ETag
  const revalidated = requestCdn('GET', paths.productDetail, {
    profile: profiles.guestVNMobileControl,
    headers: {
      'Cache-Control': 'nó-cache',
      'If-None-Match': etag1,
    },
    tags: { case: 'detail_revalidate_etag' },
  });

  if (revalidated.status === 304) {
    const etag2 = getHeader(revalidated, 'ETag');
    if (etag1 !== etag2) {
      throw new Error(
        `ETag changed during 304 revalidation: "${etag1}" -> "${etag2}"`
      );
    }
    console.log(`ETag stable: ${etag1}`);
  }

Ý nghĩa:
  - Weak ETag (W/...) chấp nhận semantic equivalence.
  - Strong ETag ("...") yêu cầu byte-by-byte identity.
  - Nếu không có prefix W/ -> strong ETag.
  - ETag phải ỔN ĐỊNH: cứng nội dụng -> cứng ETag.
```

### Variation 4: Multiple Vary dimensions

```text
Mục đích: Kiểm trả Vary header chưa ĐẦY ĐỦ các dimension
          mà origin thực sự dụng.

Thay đổi: Assert Vary chưa Tất cả các header mà origin variant hóa.

Ví dụ script mở rộng:
  const vary = getHeader(detail, 'Vary');
  const varyHeaders = vary.split(',').map(h => h.trim());

  const requiredDimensions = [
    'Accept-Language',
    'X-Geo-Country',
    'X-Device-Class',
    'X-Ab-Variant',
    'X-User-Segment',
  ];

  for (const dim of requiredDimensions) {
    if (!varyHeaders.includes(dim)) {
      console.warn(
        `WARNING: Vary missing dimension "${dim}". ` +
        `Requests with different ${dim} máy share cache objects.`
      );
    }
  }

  // Nguoc lại: Vary không nên chưa dimension KHÔNG SỬ DỤNG
  if (varyHeaders.includes('User-Agent')) {
    console.warn(
      `WARNING: Vary includes User-Agent. ` +
      `This will cause excessive cache fragmentation.`
    );
  }

Ý nghĩa:
  - Vary THIEU dimension -> cache leakage.
  - Vary THUA dimension -> cache fragmentation, HIT ratio giám.
  - Vary phải CHÍNH XÁC: chỉ chưa những header origin thực sự variant hóa.
```

### Variation 5: Smoke (minimal contract)

```text
Mục đích: Chỉ kiểm trả CÁC HEADER TỐI THIỂU de CDN hoạt động.
          Version rut gon, chay nhanh (1 giây).

Thay đổi: Chỉ assert Cache-Control, ETag, status 200.
          Bo qua Surrogate-Key, Vary, homefeed, categories.

Ví dụ script:
  export default function () {
    const detail = requestCdn('GET', paths.productDetail, {
      profile: profiles.guestVNMobileControl,
      tags: { case: 'cache_contract_smoke' },
    });

    assertStatus(detail, 200, 'product detail');
    assertHeaderPresent(detail, 'Cache-Control', 'product detail');
    assertHeaderContains(detail, 'Cache-Control', 'public', 'product detail');
    assertHeaderContains(detail, 'Cache-Control', 's-maxage=', 'product detail');
    assertHeaderPresent(detail, 'ETag', 'product detail');

    const etag = getHeader(detail, 'ETag');
    if (!etag) throw new Error('missing ETag');

    const revalidated = requestCdn('GET', paths.productDetail, {
      profile: profiles.guestVNMobileControl,
      headers: {
        'Cache-Control': 'nó-cache',
        'If-None-Match': etag,
      },
      tags: { case: 'smoke_revalidate' },
    });
    assertStatus(revalidated, 304, 'revalidation');
  }

Ý nghĩa:
  - CI pipeline: chay nhanh, chỉ kiểm trả contract tối thiểu.
  - Nếu smoke fail -> không cần chay full test.
  - Full test (22 checks) chay trong staging hoặc nightly.
```

---

## 15. Anti-patterns

### Anti-pattern 1: Cache-Control: private trên response public

```text
Sai:
  GET /api/sim/products/1 (public, không auth)
  Response: Cache-Control: private, max-age=60

Hậu quả:
  CDN đọc "private" -> KHÔNG ĐƯỢC CACHE.
  Mới request đều MISS -> origin nhận 100% traffic.
  Nếu traffic 1000 req/s -> origin cần xử lý 1000 req/s.

Cách phát hiện:
  Test này sẽ FAIL: assertHeaderContains(detail, 'Cache-Control', 'public')
  Hoặc Cache-Control có "private" -> FAIL.

Fix:
  Doi thành Cache-Control: public, s-maxage=60, ...
  Private CHỈ DÙNG cho response theo user cụ thể (auth, profile).
```

### Anti-pattern 2: Surrogate-Key empty hoặc missing

```text
Sai:
  GET /api/sim/products/1
  Response: Surrogate-Key: (empty)
  Hoặc không có Surrogate-Key header.

Hậu quả:
  Không thể ban-tag invalidate.
  Admin muon xóa product 1 -> phải purge từng URL variant (32 lần).
  Hoặc ban prefix -> có thể xóa nham product 10, 11, ...

Cách phát hiện:
  Test này sẽ FAIL: assertHeaderPresent(detail, 'Surrogate-Key')

Fix:
  Thêm Surrogate-Key với đánh sach tag cách nhau bởi space:
  Surrogate-Key: product-1 catalog-products segment-guest
```

### Anti-pattern 3: ETag dựa trên server timestamp

```text
Sai:
  // Golang handler
  c.Header("ETag", fmt.Sprintf(`"%d-%s"`, time.Now().UnixMilli(), instanceID))

Hậu quả:
  Mới request -> ETag khac nhau (vì timestamp thay đổi).
  If-None-Match không bảo giờ khop -> luon 200 (thay vì 304).
  Revalidation vô dụng.

Cách phát hiện:
  Test 304 revalidation FAIL (trả 200 thay vì 304).
  console.log ETag 2 request -> khac nhau.

Fix:
  ETag = hash của response body:
  c.Header("ETag", fmt.Sprintf(`"%x"`, md5.Sum(responseBody)))
  Hoặc ETag = content_version + content_updated_at:
  c.Header("ETag", fmt.Sprintf("W/\"%s-%d\"", product.Version, product.UpdatedAt.Unix()))
  Mien là ỔN ĐỊNH cho cứng nội dụng.
```

### Anti-pattern 4: Vary khai báo User-Agent

```text
Sai:
  GET /api/sim/products/1
  Response: Vary: User-Agent

Hậu quả:
  Mới browser type -> cache object rieng.
  Chrome 120, Chrome 121, Firefox 130, Safari 17, Edge, Opera...
  -> 100+ variant cho CỨNG 1 product.
  -> HIT ratio GIÁM THAM HAI.
  -> Cache storage BIEN THÀNH "phần manh".

Cách phát hiện:
  Vary có chưa "User-Agent".
  Nếu có check cache fragmentation script -> HIT ratio thấp.

Fix:
  Dụng X-Device-Class thay vì User-Agent.
  Vary: X-Device-Class (mobile, tablet, desktop) -> chỉ 3 variant.
  Hoặc dùng X-Client-Type nếu cần phân biệt native app vs browser.
```

### Anti-pattern 5: Cache-Control directives bị strip bởi middleware

```text
Sai:
  Origin handler set Cache-Control dụng.
  Những middleware/framework security strip bot header.
  Client (qua CDN) nhận response KHÔNG CÓ Cache-Control.

Hậu quả:
  CDN không thấy Cache-Control -> không cache (hoặc cache sai TTL).
  Kho debug vì handler code Đúng nhưng response THIEU.

Cách phát hiện:
  Dụng --http-debug="full" de xem response headers.
  So sanh response khi goi trực tiếp origin (:8080) vs qua CDN (:80).
  Nếu origin có Cache-Control những CDN response thieu -> middleware strip.

Fix:
  Kiểm trả security header middleware (Helmet, CSP).
  Kiểm trả reverse proxy strip header config.
  Whitelist Cache-Control, CDN-Cache-Control, ETag, Surrogate-Key, Vary.
```

### Anti-pattern 6: ETag thay đổi theo instance

```text
Sai:
  ETag = md5(JSON.stringify(data) + instanceID + serverStartTime)

Hậu quả:
  Cứng data, khac instance -> ETag khac.
  CDN revalidate đến instance 1 -> 200 (vì instance 2 có ETag khac).
  Hoặc worse: instance 1 -> 304, instance 2 -> 200 (nếu CDN sticky thay đổi).
  Revalidation KHÔNG TIN CAY.

Cách phát hiện:
  Goi nhiều request, kiểm trả ETag có on định không.
  Nếu có nhiều ETag cho cứng response -> FAIL.

Fix:
  ETag CHỈ DỰA VÀO NỘI DỤNG:
  ETag = md5(JSON.stringify(responseData))
  Không thêm instance-specific data.
  Không thêm timestamp (tru khi timestamp là content_version).
```

---

## 16. Real validation data

### Test execution data

```text
Case ID:     cdn-07-cache-contract
Script:      07-cache-contract.js
Profile:     guest VN mobile (product detail)
             returning VN mobile variant-a (homefeed)
             guest US desktop (categories)

Timing:
  Total duration:       ~14s (1 iteration, sequential)
  Request count:        4 (detail, revalidate, homefeed, categories)
  Expected checks pass: 22/22 = 100%

Network:
  detail:      200 OK, body ~4KB, headers ~500B
  revalidate:  304 Not Modified, body 0B, headers ~300B
  homefeed:    200 OK, body ~8KB, headers ~500B
  categories:  200 OK, body ~12KB, headers ~500B

Bandwidth savings (estimated):
  Without 304: 4KB * 1000 req = 4MB origin->CDN per TTL cycle
  With 304:    300B * 1000 req = 300KB origin->CDN per TTL cycle
  Savings:     ~92%

Headers emitted by origin (Go handler):
  applySimpleCDNCacheHeaders(c, ttlSeconds, staleIfErrorSeconds, surrogateKeys...)
  -> Cache-Control: public, max-age=<N>, s-maxage=<N>, stale-if-error=<N>
  -> CDN-Cache-Control: max-age=<N>, stale-if-error=<N>
  -> Surrogate-Key: <tag1> <tag2> ... <tagN>

Go handler source:
  E:/Projects/k6/k6-metrics-server/load-target/handlers/cdn_cached_endpoints.go
  Function: applySimpleCDNCacheHeaders
```

### Expected vs actual (PASS scenario)

```text
+--------------------------------+--------------------------+----------+
| Check                          | Expected                 | Status   |
+--------------------------------+--------------------------+----------+
| detail status                  | 200                      | PASS     |
| detail Cache-Control present   | true (header exists)     | PASS     |
| detail Cache-Control public    | chưa "public"            | PASS     |
| detail Cache-Control s-maxage  | chưa "s-maxage="         | PASS     |
| detail Cache-Control swr       | chưa "stale-while-re..." | PASS     |
| detail Cache-Control sie       | chưa "stale-if-error="   | PASS     |
| detail CDN-Cache-Control       | true                     | PASS     |
| detail CDN-Cache max-age       | chưa "max-age="          | PASS     |
| detail CDN-Cache swr           | chưa "stale-while-re..." | PASS     |
| detail CDN-Cache sie           | chưa "stale-if-error="   | PASS     |
| detail ETag                    | true                     | PASS     |
| detail Last-Modified           | true                     | PASS     |
| detail Surrogate-Key           | true                     | PASS     |
| detail Surrogate-Key tag       | chưa "product-1"         | PASS     |
| detail Vary                    | true                     | PASS     |
| revalidate status              | 304                      | PASS     |
| homefeed status                | 200                      | PASS     |
| homefeed Surrogate-Key         | chưa "catalog-homefeed"  | PASS     |
| homefeed Surrogate-Key segment | chưa "segment-returning" | PASS     |
| categories status              | 200                      | PASS     |
| categories Vary Lang           | chưa "Accept-Language"   | PASS     |
| categories Vary Geo            | chưa "X-Geo-Country"     | PASS     |
+--------------------------------+--------------------------+----------+
All checks: 22/22 PASS (100%)
```

---

## 17. Reference

### File paths

```text
Script:        E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/07-cache-contract.js
Shared:        E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js
Go handler:    E:/Projects/k6/k6-metrics-server/load-target/handlers/cdn_cached_endpoints.go
Run script:    E:/Projects/k6/k6-metrics-server/scripts/run-cdn-capabilities.ps1
Overview:      E:/Khoa hoc/k6/docs/practice/cdn/00_overview.md
Case catalog:  E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/case-catalog.json
Source README: E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md
Run guide:     ./RUN_GUIDE.md
```

### Related cases

```text
01-hit-smoke           -- HIT/MISS behavior (sử dụng contract headers de cache)
05-invalidation-ops    -- Purge/ban-tag (sử dụng Surrogate-Key)
08-ttl-expiry          -- TTL expiry (sử dụng Cache-Control s-maxage)
09-stale-while-error   -- Stale serving (sử dụng stale-while-revalidate, stale-if-error)
10-request-coalescing  -- Request coalescing (sử dụng cache key tự Vary)
```

### HTTP spec references

```text
Cache-Control:     RFC 7234, Section 5.2
                   https://httpwg.org/specs/rfc7234.html#header.cache-control

ETag:              RFC 7232, Section 2.3
                   https://httpwg.org/specs/rfc7232.html#header.etag

If-None-Match:     RFC 7232, Section 3.2
                   https://httpwg.org/specs/rfc7232.html#header.if-none-match

304 Not Modified:  RFC 7232, Section 4.1
                   https://httpwg.org/specs/rfc7232.html#status.304

Vary:              RFC 7231, Section 7.1.4
                   https://httpwg.org/specs/rfc7231.html#header.vary

CDN-Cache-Control: RFC 9213 (Targeted HTTP Cache Control)
                   https://www.rfc-editor.org/rfc/rfc9213.html

Surrogate-Key:     Fastly/Varnish convention (không có RFC chính thức)
                   https://docs.varnish-software.com/varnish-cache-plus/vmods/xkey/
```

### Varnish references

```text
VCL built-in:      https://github.com/varnishcache/varnish-cache/blob/master/bin/varnishd/builtin.vcl
XKey VMOD:         https://docs.varnish-software.com/varnish-cache-plus/vmods/xkey/
Cache-Control VCL: set beresp.ttl, set beresp.grace, set beresp.keep
```
