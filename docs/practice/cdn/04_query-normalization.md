# Case 04: Query Normalization -- Tracking Params Không Fragment Cache

> **Case ID:** `cdn-04-query-normalization`
> **Script:** `04-query-normalization.js`
> **Layer:** CDN / Varnish
> **Proof:** Tracking params (`utm_*`, `fbclid`, `gclid`) không tạo cache object riêng; business params (`q`, `sort`, `page`) tạo cache object riêng biệt.
> **Khái niệm cốt lõi:** Phân biệt tracking params (cache-neutral) và business params (cache-significant).

---

## 1. Tình huống thực tế

### Marketing gắn UTM, CDN hứng hậu quả

Một buổi sáng thứ Hai, team marketing launch chiến dịch email mới:

```text
Email #1 gửi 50,000 subscribers:
  https://shop.example.com/products?utm_source=newsletter&utm_medium=email&utm_campaign=summer_sale

Email #2 gửi 30,000 subscribers (cùng landing page, khác tracking):
  https://shop.example.com/products?utm_source=newsletter&utm_medium=email&utm_campaign=summer_sale&utm_content=hero_banner

Facebook ad chạy song song:
  https://shop.example.com/products?fbclid=IwAR1abc123xyz...

Google Ads cũng chạy:
  https://shop.example.com/products?gclid=CjwKCAiA_vKeBhAdEiw...

Bạn bè share link qua Messenger:
  https://shop.example.com/products?utm_source=facebook&utm_medium=social&utm_campaign=summer_sale&utm_term=shoes
```

Tất cả các link này đều trỏ về **cùng một trang** `/products`. Response từ origin **giống hệt nhau** cho tất cả các URL trên. Nhưng mỗi URL có query string **khác nhau**.

### Cache fragmentation: thảm họa thầm lặng

Nếu CDN **không normalize** query params:

```text
Request #1: /products?utm_source=newsletter&utm_medium=email...
  -> CDN: URL chưa có trong cache -> MISS -> hỏi origin -> lưu object #1

Request #2: /products?utm_source=newsletter&utm_medium=email&utm_content=hero_banner...
  -> CDN: URL KHÁC với object #1 -> MISS -> hỏi origin -> lưu object #2
     (DÙ RESPONSE GIỐNG HỆT OBJECT #1)

Request #3: /products?fbclid=IwAR1abc123...
  -> CDN: URL KHÁC -> MISS -> lưu object #3

Request #4: /products?gclid=CjwKCAiA...
  -> CDN: URL KHÁC -> MISS -> lưu object #4

Request #5: /products?utm_source=facebook&utm_medium=social...
  -> CDN: URL KHÁC -> MISS -> lưu object #5
```

**Hậu quả**: 50,000 email recipients, mỗi người click tạo một URL tracking khác nhau (do `utm_content` personalization, `fbclid` per-user unique, `gclid` per-click unique). CDN tạo **50,000 cache objects** cho cùng một page. Mỗi object là một MISS. Cache hit ratio = **0%**.

```text
CONSEQUENCE CHAIN (chuỗi hậu quả):
==============================================================
 1. Cache hit ratio từ 95% -> 0% trong vòng vài phút
 2. 100% requests MISS -> 100% requests hit origin
 3. Origin server nhận 50,000 requests trong 2 phút
 4. Origin quá tải -> response time tăng từ 20ms -> 8,000ms
 5. Connection pool cạn -> 502 Bad Gateway bắt đầu xuất hiện
 6. User thấy trang load 20 giây hoặc trắng xóa
 7. Marketing: "Sao campaign bán ít thế?" — không biết do CDN
 8. DevOps: "Sao origin CPU 100%?" — không biết do tracking params
 9. Customer support: "Sao web chậm thế?" — không biết trả lời sao
10. Business: MẤT DOANH THU trong chính giờ cao điểm campaign
==============================================================
```

### Cơ chế gây fragmentation: từng bước một

```text
CÁCH MỘT URL TRACKING GÂY FRAGMENTATION:

Bước 1: User click link từ Facebook
  URL: /products?fbclid=IwAR1abc123xyz...
  CDN cache key: "/products?fbclid=IwAR1abc123xyz..."
  -> Cache key KHÁC với canonical "/products"
  -> Đây là MISS

Bước 2: CDN không có object -> forward request lên origin
  Origin: "Tôi trả về /products giống mọi lần thôi"
  Nhưng CDN: "Tôi lưu object này với key /products?fbclid=..."

Bước 3: User thứ hai click link từ Google Ads
  URL: /products?gclid=CjwKCAiA...
  CDN cache key: "/products?gclid=CjwKCAiA..."
  -> Cache key KHÁC với object fbclid ở trên
  -> Lại MISS

Bước 4: Lặp lại 50,000 lần
  -> 50,000 cache objects
  -> 50,000 MISS
  -> Origin bị đập 50,000 lần
```

### Không chỉ UTM -- tracking params đến từ nhiều nguồn

```text
Nguồn tracking params trong thực tế:

GOOGLE ADS:
  gclid         - Google Click ID (unique per click)
  gclsrc        - Google Click Source
  gad_source    - Google Ads source (Google Ads measurement)

FACEBOOK / INSTAGRAM:
  fbclid        - Facebook Click ID (unique per click)
  fb_source     - Facebook source identifier

MICROSOFT ADS (Bing):
  msclkid       - Microsoft Click ID (unique per click)

MAILCHIMP / MARKETING PLATFORMS:
  utm_source    - Nguồn traffic (newsletter, facebook, google)
  utm_medium    - Kênh (email, social, cpc, organic)
  utm_campaign  - Tên chiến dịch (summer_sale, black_friday)
  utm_term      - Từ khóa (shoes, running-shoes)
  utm_content   - Phiên bản nội dung (hero_banner, text_link, button_cta)

TIKTOK / AMAZON / LINKEDIN:
  ttclid        - TikTok Click ID
  amzn_tracking - Amazon tracking params
  li_fat_id     - LinkedIn tracking

TikTok, Snapchat, Pinterest -- mỗi nền tảng thêm tracking params riêng
```

### Tại sao không phải cứ "strip hết query params" là xong?

```text
CÓ NHỮNG QUERY PARAMS PHẢI GIỮ LẠI:

/search?q=shoe              <- "q" thay đổi kết quả tìm kiếm -> PHẢI GIỮ
/search?q=shoe&page=2       <- "page" thay đổi trang -> PHẢI GIỮ
/search?q=shoe&sort=price   <- "sort" thay đổi thứ tự -> PHẢI GIỮ
/products?category=shoes    <- "category" thay đổi danh sách -> PHẢI GIỮ
/products?view=grid         <- "view" thay đổi layout -> PHẢI GIỮ (nếu response khác)

Đây là BUSINESS PARAMS -- chúng thay đổi RESPONSE CONTENT.
Nếu strip hết -> mọi người tìm "shoe" hay "hat" đều nhận kết quả giống nhau -> SAI.
```

### Bài toán thực sự

```text
Làm sao để CDN phân biệt được:

  PARAMS CẦN STRIP (tracking):
    utm_source, utm_medium, utm_campaign, utm_term, utm_content,
    fbclid, gclid, msclkid, gad_source, ...
    -> Không ảnh hưởng response content
    -> Phải bị loại khỏi cache key

  PARAMS CẦN GIỮ (business):
    q, page, sort, limit, category, view, ...
    -> Ảnh hưởng response content
    -> Phải có mặt trong cache key

Đây chính là QUERY NORMALIZATION tại CDN layer.
```

---

## 2. CDN capability being proven

Case này chứng minh **hai chiều ngược nhau** của query normalization:

### Chiều (a): Tracking params bị strip khỏi cache key

```text
SCENARIO: Cùng một page, khác tracking params

  Bước 1: Request canonical
    GET /api/sim/products/search?q=shoe
    -> MISS (lần đầu) -> lưu object với key: /api/sim/products/search?q=shoe

  Bước 2: Request canonical lần 2
    GET /api/sim/products/search?q=shoe
    -> HIT (cache key trùng khớp)

  Bước 3: Request với tracking params
    GET /api/sim/products/search?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123
    -> HIT (cache key sau khi strip tracking params = canonical key)
    -> CHỨNG MINH: Tracking params không tạo cache object riêng
```

### Chiều (b): Business params được giữ trong cache key

```text
SCENARIO: Cùng base path, khác business params

  Bước 4: Request với business param mới
    GET /api/sim/products/search?q=shoe&sort=price
    -> MISS (cache key KHÁC với canonical vì có sort=price)
    -> lưu object riêng

  Bước 5: Lặp lại business param
    GET /api/sim/products/search?q=shoe&sort=price
    -> HIT (cache key trùng với object vừa lưu)
    -> CHỨNG MINH: Business params tạo cache object riêng biệt
```

### Tóm tắt capability

| Chiều | Điều cần chứng minh | Cách chứng minh |
|-------|---------------------|-----------------|
| (a) Tracking-neutral | Tracking params không fragment cache | Canonical MISS -> canonical HIT -> tracking HIT |
| (b) Business-significant | Business params tạo cache object riêng | Canonical object tồn tại -> business param khác -> MISS |

**Pass cả hai chiều cùng lúc** mới là chuẩn. Pass một chiều, fail chiều kia là **sai contract**.

---

## 3. Vì sao test ở CDN layer

### Application có thể đúng, CDN có thể sai

Đây là điểm tinh tế nhất của case này:

```text
TÌNH HUỐNG THỰC TẾ:

Application (Nginx + backend):
  - Bỏ qua utm_source, fbclid, gclid trong business logic
  - Response cho /search?q=shoe và /search?q=shoe&utm_source=x GIỐNG NHAU
  - Application logic: ĐÚNG

CDN (Varnish) nếu KHÔNG strip tracking params:
  - Cache key cho /search?q=shoe: "/search?q=shoe"
  - Cache key cho /search?q=shoe&utm_source=x: "/search?q=shoe&utm_source=x"
  - Cache key KHÁC NHAU -> MISS mặc dù response giống hệt
  - CDN behavior: SAI (cache fragmentation)
```

### Hai tầng logic độc lập

```text
┌─────────────────────────────────────────────────────────┐
│                   REQUEST FLOW                          │
│                                                         │
│  Client                                                 │
│    │                                                    │
│    ▼                                                    │
│  ┌──────────────────────────────────────┐               │
│  │  CDN LAYER (Varnish)                 │               │
│  │                                      │               │
│  │  1. Nhận URL gốc:                    │               │
│  │     /search?q=shoe&utm_source=x      │               │
│  │                                      │               │
│  │  2. Normalize query (strip tracking): │              │
│  │     /search?q=shoe                   │               │
│  │                                      │               │
│  │  3. Tính cache key từ URL đã normalize│              │
│  │  ┌──────────────────────────┐        │               │
│  │  │ Cache key =              │        │               │
│  │  │   hash(req.url)          │        │               │
│  │  │   + hash(host)           │        │               │
│  │  │   + hash(variant headers)│        │               │
│  │  └──────────────────────────┘        │               │
│  │                                      │               │
│  │  4. Lookup cache -> HIT hoặc MISS    │               │
│  └──────────────────────────────────────┘               │
│    │                                                    │
│    ▼ (chỉ khi MISS)                                     │
│  ┌──────────────────────────────────────┐               │
│  │  APPLICATION LAYER (Nginx + backend) │               │
│  │                                      │               │
│  │  1. Nhận URL gốc (KHÔNG bị strip):   │               │
│  │     /search?q=shoe&utm_source=x      │               │
│  │                                      │               │
│  │  2. Parse business params: q=shoe    │               │
│  │  3. Ignore utm_source (không dùng)   │               │
│  │  4. Return response                  │               │
│  └──────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────┘
```

### Tại sao phải test TẠI CDN layer, không phải application layer

```text
LÝ DO 1: CDN cache key logic ĐỘC LẬP với application logic
  - Application có thể ignore tracking params đúng
  - Nhưng CDN có thể không strip chúng khỏi cache key
  -> Phải verify cache key behavior tại EDGE, không phải tại origin

LÝ DO 2: Cache fragmentation xảy ra ở CDN, không phải ở application
  - Application không biết cache đang bị fragmentation
  - CDN mới là nơi quyết định HIT hay MISS
  -> Phải đọc X-Cache header để biết cache behavior

LÝ DO 3: Ứng dụng có thể nhận URL gốc (không bị strip)
  - Varnish strip param cho cache key nhưng forward URL gốc lên backend
  - Application vẫn thấy utm_source=... trong request
  -> Application không thể biết cache key đã được normalize hay chưa

LÝ DO 4: Chỉ CDN mới có X-Cache header
  - Application không set X-Cache
  - Chỉ Varnish mới set X-Cache = HIT hoặc MISS
  -> Phải gọi qua :80 (public CDN path) để đọc header này
```

### Hậu quả nếu chỉ test ở application layer

```text
NẾU CHỈ TEST ỨNG DỤNG:
  - Test API /search?q=shoe -> 200 OK
  - Test API /search?q=shoe&utm_source=x -> 200 OK (application ignore)
  -> Test PASS
  -> Nhưng CDN đang fragment cache âm thầm
  -> Production: 50,000 MISS, origin sập
  -> "Sao test pass mà production chết?" -> Vì test sai layer

NẾU TEST Ở CDN LAYER:
  - Request qua CDN: /search?q=shoe -> MISS -> HIT
  - Request qua CDN: /search?q=shoe&utm_source=x -> HIT (nếu strip đúng)
  -> Test thực sự verify cache contract
  -> Production: cache hoạt động đúng, origin được bảo vệ
```

---

## 4. Topology & precondition

### Runtime path

```text
Public path:    http://localhost:80  -> Varnish -> Nginx -> app
Control path:   http://localhost:8088 (ban-prefix, origin profile, counters)
Event path:     http://localhost:9091 (không dùng trong case này)
```

### Topology diagram

```text
┌──────────┐     ┌──────────────┐     ┌────────┐     ┌─────────────┐
│  k6      │────>│  Varnish CDN │────>│ Nginx  │────>│  App/Origin │
│  client  │     │  port :80    │     │        │     │             │
└──────────┘     └──────────────┘     └────────┘     └─────────────┘
                       │
                       │ query normalization xảy ra ở đây
                       │ (strip tracking params trước khi tính cache key)
                       │
┌──────────┐     ┌──────────────┐
│  k6      │────>│  Control     │
│  setup   │     │  port :8088  │  ban-prefix /api/sim/products/search
└──────────┘     └──────────────┘
```

### Precondition: warm cache từ canonical URL

```text
SEQUENCE ĐỂ ĐẢM BẢO PROOF CHÍNH XÁC:

Bước 0: Ban prefix /api/sim/products/search
  -> Xóa toàn bộ cache objects dưới search prefix
  -> Đảm bảo không có stale cache từ lần chạy trước
  -> Sử dụng control path :8088

Bước 1: Request canonical search (warm cache)
  GET /api/sim/products/search?q=shoe
  -> MISS (cache trống) -> object được lưu
  -> Cache key (đã normalize): /api/sim/products/search?q=shoe

Bước 2: Request canonical lần 2 (verify warm)
  GET /api/sim/products/search?q=shoe
  -> HIT (khẳng định object đã có trong cache)

Bước 3: Request với tracking params
  GET /api/sim/products/search?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123
  -> Sau normalize: /api/sim/products/search?q=shoe
  -> HIT (cache key trùng với canonical object)
  -> Nếu MISS -> strip tracking params bị lỗi

Bước 4: Request với business param mới
  GET /api/sim/products/search?q=shoe&sort=price
  -> Sau normalize: /api/sim/products/search?q=shoe&sort=price
  -> Khác với canonical cache key
  -> MISS (object riêng được tạo)
  -> Nếu HIT -> strip quá aggressive (đã strip cả sort)
```

### Tại sao phải ban prefix trước khi chạy?

```text
NẾU KHÔNG BAN PREFIX:
  - Có thể còn cache object từ lần chạy trước hoặc từ case khác
  - Canonical request đầu tiên có thể HIT thay vì MISS
  -> Không chứng minh được MISS->HIT transition
  -> Proof không clean

NẾU BAN PREFIX:
  - Toàn bộ /api/sim/products/search* bị xóa
  - Mọi request đầu tiên chắc chắn MISS
  -> Proof clean, reproducible
```

---

## 5. Script deep-dive

### Cấu trúc script

`04-query-normalization.js` được tổ chức thành **3 nhóm test** trong một iteration duy nhất:

```text
SCRIPT STRUCTURE:
================================================
 options:  { vus: 1, iterations: 1 }
           -> Chạy đúng 1 lần, tuần tự từng bước
           -> Mỗi bước là một HTTP request + assertions

 setup():  banPrefix('/api/sim/products/search')
           -> Xóa cache trước khi test

 default(): 3 nhóm test tuần tự:
   Nhóm A: CANONICAL (2 requests)
   Nhóm B: TRACKING PARAMS (1 request)
   Nhóm C: BUSINESS PARAMS (2 requests)
================================================
```

### Import và options

```javascript
import {
  paths, profiles, banPrefix,
  requestCdn, assertCacheKeyHeaders,
  assertCacheState, assertStatus,
  expectedCacheKey
} from './shared.js';

export const options = {
  vus: 1,              // 1 VU duy nhất
  iterations: 1,       // Chạy đúng 1 lần
  thresholds: {
    checks: ['rate==1'], // TẤT CẢ checks phải pass
  },
  tags: {
    scenario: 'cdn_query_normalization',
  },
};
```

**Tại sao VU=1, iterations=1?**

```text
Case này là PROOF, không phải LOAD TEST:
  - Mỗi request assertion là một check
  - Cần chạy tuần tự để đảm bảo thứ tự MISS -> HIT
  - Không cần nhiều VU hay nhiều iteration
  - threshold checks rate==1: nếu bất kỳ check nào fail -> toàn bộ test fail
```

### Setup phase

```javascript
export function setup() {
  banPrefix(paths.searchPrefix);
  // paths.searchPrefix = '/api/sim/products/search'
  // Gửi POST /ops/app/cdn/cache/ban với prefix này
  // -> Varnish thực hiện ban("req.url ~ ^/api/sim/products/search")
  // -> Xóa toàn bộ cache objects dưới search prefix
}
```

### Nhóm A: Canonical requests (warm + verify)

```javascript
const profile = profiles.guestUSDesktopControl;
const expected = expectedCacheKey(profile);
// expected = { language: 'en', geo: 'US', device: 'desktop', ab: 'control', segment: 'guest' }

// --- Request A1: Canonical first read (MISS) ---
const canonicalFirst = requestCdn('GET', paths.search, {
  profile,
  tags: { case: 'canonical_first' },
});
// paths.search = '/api/sim/products/search?q=shoe'
// requestCdn -> gửi GET tới http://localhost:80/api/sim/products/search?q=shoe
// Với headers: Accept-Language: en, X-Geo-Country: US, X-Device-Class: desktop,
//               X-Ab-Variant: control, X-User-Segment: guest

assertStatus(canonicalFirst, 200, 'canonical first');
// Check: response status === 200

assertCacheState(canonicalFirst, 'MISS', 'canonical first');
// Check: X-Cache header === 'MISS'
// Lần đầu cache trống -> phải MISS

assertCacheKeyHeaders(canonicalFirst, expected, 'canonical first');
// Check: X-Cache-Key-Language = 'en', X-Cache-Key-Geo = 'US',
//        X-Cache-Key-Device = 'desktop', X-Cache-Key-AB = 'control'
// Cache key variant isolation vẫn được giữ

// --- Request A2: Canonical repeat (HIT) ---
const canonicalSecond = requestCdn('GET', paths.search, {
  profile,
  tags: { case: 'canonical_second' },
});

assertStatus(canonicalSecond, 200, 'canonical second');
// Vẫn 200

assertCacheState(canonicalSecond, 'HIT', 'canonical second');
// Lần 2: cache đã có object -> HIT
// Đây là baseline: canonical request được cache bình thường

assertCacheKeyHeaders(canonicalSecond, expected, 'canonical second');
// Cache key headers giống hệt lần đầu
```

**Tại sao cần A1 + A2?**

```text
Nếu bỏ qua A2:
  - A1 MISS chỉ chứng minh cache đã bị xóa (ban prefix hoạt động)
  - Chưa chứng minh canonical request ĐƯỢC CACHE
  - Nếu canonical không được cache -> tracking request HIT cũng vô nghĩa

Có A2:
  - A1 MISS: cache trống
  - A2 HIT:  canonical ĐÃ được cache
  -> Baseline đã được thiết lập
  -> Các test tracking/business có cơ sở để so sánh
```

### Nhóm B: Tracking params request

```javascript
const trackedPath =
  '/api/sim/products/search?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123';

const tracked = requestCdn('GET', trackedPath, {
  profile,
  tags: { case: 'tracked_query' },
});

assertStatus(tracked, 200, 'tracked query');
// Response vẫn 200 (tracking params không làm thay đổi response)

assertCacheState(tracked, 'HIT', 'tracked query');
// *** KEY ASSERTION ***
// Mặc dù URL có utm_source, fbclid, gclid
// Nhưng Varnish đã strip các param này khỏi cache key
// -> Cache key = /api/sim/products/search?q=shoe
// -> Trùng với cache key của A1
// -> HIT từ object canonical

assertCacheKeyHeaders(tracked, expected, 'tracked query');
// Cache key headers không đổi với canonical
```

**Phân tích trackedPath:**

```text
URL gốc:
  /api/sim/products/search?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123

Sau VCL normalize (strip tracking params):
  /api/sim/products/search?q=shoe

Cache key tính từ URL đã normalize:
  hash("/api/sim/products/search?q=shoe") + hash(host) + hash(variant headers)

Cache object canonical (từ A1) có cùng cache key:
  -> HIT
```

### Nhóm C: Business params requests

```javascript
const businessParamPath =
  '/api/sim/products/search?q=shoe&sort=price';

// --- Request C1: Business param first read (MISS) ---
const businessFirst = requestCdn('GET', businessParamPath, {
  profile,
  tags: { case: 'business_param_first' },
});

assertStatus(businessFirst, 200, 'business param first');
// Response 200, nhưng có thể khác với canonical
// (sort=price -> thứ tự sản phẩm theo giá)

assertCacheState(businessFirst, 'MISS', 'business param first');
// *** KEY ASSERTION ***
// Cache key: /api/sim/products/search?q=shoe&sort=price
// KHÁC với canonical cache key: /api/sim/products/search?q=shoe
// -> MISS -> object mới được tạo
// -> CHỨNG MINH: sort=price ĐƯỢC GIỮ trong cache key

assertCacheKeyHeaders(businessFirst, expected, 'business param first');
// Variant headers vẫn đúng

// --- Request C2: Business param repeat (HIT) ---
const businessSecond = requestCdn('GET', businessParamPath, {
  profile,
  tags: { case: 'business_param_second' },
});

assertStatus(businessSecond, 200, 'business param second');

assertCacheState(businessSecond, 'HIT', 'business param second');
// Object với key q=shoe&sort=price đã được lưu từ C1
// -> HIT
// -> CHỨNG MINH: Business param object được cache bình thường

assertCacheKeyHeaders(businessSecond, expected, 'business param second');
```

**Phân tích businessParamPath:**

```text
URL gốc:
  /api/sim/products/search?q=shoe&sort=price

Sau VCL normalize:
  sort=price KHÔNG nằm trong strip list
  -> sort=price ĐƯỢC GIỮ trong URL
  -> URL sau normalize: /api/sim/products/search?q=shoe&sort=price

Cache key:
  hash("/api/sim/products/search?q=shoe&sort=price")

So với canonical cache key:
  hash("/api/sim/products/search?q=shoe")
  -> KHÁC NHAU
  -> Phải MISS
```

### Toàn bộ request timeline

```text
TIMELINE (1 iteration, ~300ms tổng thời gian):

  t=0ms    setup(): banPrefix('/api/sim/products/search')
  t=50ms   A1: canonical first  -> MISS (cache trống)
  t=100ms  A2: canonical second -> HIT  (cache đã warm)
  t=150ms  B:  tracked query    -> HIT  (tracking params stripped)
  t=200ms  C1: business first   -> MISS (sort=price là cache key mới)
  t=250ms  C2: business second  -> HIT  (business object đã warm)

  KẾT QUẢ MONG ĐỢI:
    MISS -> HIT -> HIT -> MISS -> HIT
```

---

## 6. VCL query normalization deep-dive

Đây là phần quan trọng nhất của case. Toàn bộ logic nằm trong `default.vcl`, function `vcl_recv`, lines 145-153.

### Vị trí trong VCL flow

```text
VCL RECV FLOW:
================================================
 1. PURGE / BAN handling
 2. Method check (only GET/HEAD)
 3. Health/metrics/ops bypass
 4. _nocache / cache_bust bypass
 5. no-cache / Authorization / Cookie bypass
 6. Auth token bypass for products
 7. *** QUERY NORMALIZATION ***  <-- CASE NÀY
 8. querysort
 9. Route to hash (cache) hoặc pass (bypass)
================================================
```

Query normalization xảy ra **trước** `return (hash)`. Điều này có nghĩa URL được normalize trước khi dùng để tính cache key trong `vcl_hash`.

### Bước 1: Strip tracking params

```vcl
if (req.url ~ "\\?") {
    set req.url = regsuball(req.url, "(\\?|&)(utm_[^=]+|fbclid|gclid)=[^&]*", "\1");
```

**Giải thích từng phần của regex:**

```text
PATTERN: (\\?|&)(utm_[^=]+|fbclid|gclid)=[^&]*

 (\\?|&)              -> Bắt ký tự ? hoặc & trước param
                         (đây là separator: bắt đầu query string hoặc phân cách các param)

 (utm_[^=]+|fbclid|gclid) -> Tên param cần strip:
                         utm_[^=]+ : tất cả param bắt đầu bằng "utm_"
                                     (utm_source, utm_medium, utm_campaign,
                                      utm_term, utm_content, utm_id, ...)
                         fbclid    : Facebook Click ID
                         gclid     : Google Click ID

 =[^&]*               -> Dấu = và giá trị của param (mọi ký tự không phải &)

REPLACEMENT: \1       -> Chỉ giữ lại separator (? hoặc &)
                         -> XÓA tên param + dấu = + giá trị
```

**Ví dụ từng bước regex hoạt động:**

```text
INPUT:  /search?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123

PASS 1 - regex match đầu tiên:
  Tìm thấy: &utm_source=lesson
  Xóa thành: &  (giữ lại separator &)
  URL hiện tại: /search?q=shoe&&fbclid=abc123&gclid=paid123
                (có && vì giữ & trước và & sau utm_source)

PASS 2 - regsuball tiếp tục:
  Tìm thấy: &fbclid=abc123
  Xóa thành: &
  URL hiện tại: /search?q=shoe&&&gclid=paid123

PASS 3 - regsuball tiếp tục:
  Tìm thấy: &gclid=paid123
  Xóa thành: &
  URL hiện tại: /search?q=shoe&&&&

Kết thúc regsuball: không còn match nào.
```

### Bước 2: Cleanup double separators

```vcl
    set req.url = regsuball(req.url, "&{2,}", "&");
```

**Giải thích:**

```text
PATTERN: &{2,}  -> 2 hoặc nhiều dấu & liên tiếp

INPUT:  /search?q=shoe&&&&
OUTPUT: /search?q=shoe&

(Xóa các && thừa, chỉ giữ 1 dấu &)
```

### Bước 3: Fix leading ampersand after question mark

```vcl
    set req.url = regsub(req.url, "^([^?]+)&", "\1?");
```

**Giải thích:**

```text
PATTERN: ^([^?]+)&
  ^       -> đầu chuỗi
  ([^?]+) -> mọi ký tự không phải ? (phần path)
  &       -> dấu & ngay sau path

REPLACEMENT: \1?  -> path + dấu ?

Xử lý trường hợp: /search&q=shoe
  (xảy ra khi param ĐẦU TIÊN trong query bị strip,
   và separator của nó là ? -- nhưng ? đã bị xóa vì
   regex ở bước 1 match ?utm_source=...)

Thực tế regex ở bước 1: (\\?|&)(utm_...)=...
  Khi utm_source là param ĐẦU TIÊN:
    /search?utm_source=x&q=shoe
    -> ?utm_source=x bị xóa, còn lại ?
    Nhưng \1 chỉ giữ separator, nếu separator là ?
    thì ? được giữ -> /search?&q=shoe

  Fix: /search?&q=shoe -> /search?q=shoe
```

### Bước 4: Fix question-mark-ampersand

```vcl
    set req.url = regsub(req.url, "\\?&", "?");
```

**Giải thích:**

```text
PATTERN: \?&  -> ?& (question mark ngay trước ampersand)

INPUT:  /search?&q=shoe
OUTPUT: /search?q=shoe

Xảy ra khi tracking param ĐẦU TIÊN bị strip:
  /search?utm_source=x&q=shoe
  -> ?utm_source=x bị xóa, \1 = ?
  -> /search?&q=shoe
  -> Fix thành /search?q=shoe
```

### Bước 5: Remove trailing separators

```vcl
    set req.url = regsub(req.url, "[\\?&]+$", "");
```

**Giải thích:**

```text
PATTERN: [\?&]+$  -> một hoặc nhiều ? hoặc & ở CUỐI URL

Xử lý trường hợp: /search?q=shoe&
  (nếu tracking param CUỐI CÙNG bị strip,
   để lại dấu & thừa ở cuối)

Hoặc: /search?
  (nếu TẤT CẢ param đều là tracking,
   sau khi strip hết chỉ còn dấu ?)

OUTPUT: /search?q=shoe  hoặc  /search
```

### Bước 6: Sort query params alphabetically

```vcl
set req.url = std.querysort(req.url);
```

**Giải thích:**

```text
std.querysort() sắp xếp query params theo thứ tự alphabet:

INPUT:  /search?sort=price&q=shoe&page=2
OUTPUT: /search?page=2&q=shoe&sort=price

Tại sao cần?
  - /search?q=shoe&sort=price và /search?sort=price&q=shoe
    Là CÙNG MỘT request về mặt business
  - Nhưng nếu không sort -> 2 cache key khác nhau
  - Querysort đảm bảo thứ tự params không ảnh hưởng cache key

Lưu ý: std.querysort CHỈ sort params, KHÔNG strip tracking params.
        Tracking params đã bị strip ở các bước trên trước khi querysort chạy.
```

### Toàn bộ quy trình normalize

```text
COMPLETE NORMALIZATION PIPELINE:

INPUT URL: /api/sim/products/search?utm_source=email&q=shoe&sort=price&fbclid=abc&utm_medium=cpc

STEP 1 (regsuball strip tracking):
  Strip: ?utm_source=email  -> ? (giữ)
  Strip: &fbclid=abc        -> &
  Strip: &utm_medium=cpc    -> &
  Result: /api/sim/products/search?&q=shoe&sort=price&

STEP 2 (collapse &&):
  Không có && liên tiếp -> giữ nguyên
  Result: /api/sim/products/search?&q=shoe&sort=price&

STEP 3 (fix ^path&):
  Không match (có ? trước &)
  Result: /api/sim/products/search?&q=shoe&sort=price&

STEP 4 (fix ?&):
  Match: ?& -> ?
  Result: /api/sim/products/search?q=shoe&sort=price&

STEP 5 (strip trailing ?&):
  Match: & cuối chuỗi
  Result: /api/sim/products/search?q=shoe&sort=price

STEP 6 (querysort):
  q trước sort trong alphabet -> giữ nguyên
  Result: /api/sim/products/search?q=shoe&sort=price

FINAL NORMALIZED URL: /api/sim/products/search?q=shoe&sort=price
```

### req.url gốc vs req.url normalized

```text
MỘT ĐIỂM QUAN TRỌNG:

req.url được MODIFY IN-PLACE trong vcl_recv.
Sau khi normalize, req.url ĐÃ THAY ĐỔI.

Khi request forwarded đến backend (Nginx):
  -> req.url đã là normalized URL
  -> Backend KHÔNG thấy utm_source, fbclid, gclid
  -> Backend chỉ thấy: /api/sim/products/search?q=shoe

Cache key (vcl_hash) sử dụng req.url:
  -> hash_data(req.url) dùng URL ĐÃ NORMALIZE
  -> Đây là lý do tracking params không fragment cache

SO SÁNH:
  URL gốc client gửi:
    /api/sim/products/search?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123
  URL sau normalize (req.url):
    /api/sim/products/search?q=shoe
  Cache key:
    hash("/api/sim/products/search?q=shoe")
```

### Strip list hiện tại và giới hạn

```vcl
PATTERN HIỆN TẠI:
  (utm_[^=]+|fbclid|gclid)

CÁC PARAM BỊ STRIP:
  utm_source, utm_medium, utm_campaign, utm_term, utm_content,
  utm_id, utm_cid, ... (bất kỳ param nào bắt đầu bằng utm_)
  fbclid
  gclid

CÁC PARAM KHÔNG BỊ STRIP:
  q, page, sort, limit, category, view, ...
  (tất cả business params)

CÁC PARAM CHƯA CÓ TRONG STRIP LIST (cần bổ sung trong tương lai):
  msclkid     - Microsoft Click ID
  gad_source  - Google Ads source
  gclsrc      - Google Click Source
  ttclid      - TikTok Click ID
  li_fat_id   - LinkedIn tracking
  epik        - Pinterest tracking
```

---

## 7. Tracking vs business params table

### Phân loại đầy đủ

| Param | Loại | Strip? | Lý do |
|-------|------|--------|-------|
| `q` | Business | **KHÔNG** | Từ khóa tìm kiếm -- thay đổi response content. `q=shoe` khác `q=hat`. |
| `page` | Business | **KHÔNG** | Số trang -- thay đổi danh sách sản phẩm trả về. |
| `sort` | Business | **KHÔNG** | Thứ tự sắp xếp -- `sort=price` khác `sort=name`. |
| `limit` | Business | **KHÔNG** | Số lượng item mỗi trang -- thay đổi response size. |
| `category` | Business | **KHÔNG** | Danh mục sản phẩm -- thay đổi hoàn toàn danh sách. |
| `view` | Business | **KHÔNG** | Kiểu hiển thị (grid/list) -- có thể thay đổi response format. |
| `utm_source` | Tracking | **CÓ** | Nguồn traffic (newsletter, facebook, google). Không ảnh hưởng nội dung. |
| `utm_medium` | Tracking | **CÓ** | Kênh marketing (email, social, cpc). Không ảnh hưởng nội dung. |
| `utm_campaign` | Tracking | **CÓ** | Tên chiến dịch. Không ảnh hưởng nội dung. |
| `utm_term` | Tracking | **CÓ** | Từ khóa quảng cáo. Không ảnh hưởng nội dung response. |
| `utm_content` | Tracking | **CÓ** | Phiên bản nội dung quảng cáo (A/B test creative). Không ảnh hưởng nội dung. |
| `utm_id` | Tracking | **CÓ** | Campaign ID. Không ảnh hưởng nội dung. |
| `utm_cid` | Tracking | **CÓ** | Custom campaign ID. Không ảnh hưởng nội dung. |
| `fbclid` | Tracking | **CÓ** | Facebook Click ID -- unique per click. Gây fragmentation nặng nhất. |
| `gclid` | Tracking | **CÓ** | Google Click ID -- unique per click. Gây fragmentation nặng. |
| `msclkid` | Tracking | **CHƯA** | Microsoft Click ID. Chưa có trong strip list -> SẼ GÂY FRAGMENTATION. |
| `gad_source` | Tracking | **CHƯA** | Google Ads source. Chưa có trong strip list. |
| `gclsrc` | Tracking | **CHƯA** | Google Click Source. Chưa có trong strip list. |
| `ttclid` | Tracking | **CHƯA** | TikTok Click ID. Chưa có trong strip list. |
| `fb_source` | Tracking | **CHƯA** | Facebook source. Chưa có trong strip list. |

### Ví dụ normalize cho từng trường hợp

```text
CASE 1: Chỉ có tracking params
  INPUT:  /search?utm_source=email&utm_medium=cpc&fbclid=abc
  OUTPUT: /search
  Cache key: hash("/search")
  -> Tất cả biến thể tracking đều HIT object /search

CASE 2: Mix tracking + business
  INPUT:  /search?q=shoe&utm_source=email&fbclid=abc&sort=price
  OUTPUT: /search?q=shoe&sort=price
  Cache key: hash("/search?q=shoe&sort=price")
  -> Tracking bị strip, business được giữ

CASE 3: Chỉ có business params
  INPUT:  /search?q=shoe&page=2&sort=price
  OUTPUT: /search?page=2&q=shoe&sort=price  (sau querysort)
  Cache key: hash("/search?page=2&q=shoe&sort=price")
  -> Không có tracking -> không thay đổi (chỉ sort)

CASE 4: Tracking params ở đầu query string
  INPUT:  /search?utm_source=x&q=shoe&sort=price
  OUTPUT: /search?q=shoe&sort=price
  -> ?utm_source=x bị strip, cleanup ?& thành ?

CASE 5: Tracking params ở cuối query string
  INPUT:  /search?q=shoe&sort=price&fbclid=abc
  OUTPUT: /search?q=shoe&sort=price
  -> &fbclid=abc bị strip, trailing & bị xóa

CASE 6: Tất cả params đều là tracking
  INPUT:  /search?utm_source=x&fbclid=y&gclid=z
  OUTPUT: /search
  -> Tất cả bị strip -> query string biến mất hoàn toàn
```

### Edge cases

```text
EDGE CASE A: Business param trùng prefix với tracking param
  Param "utm_campaign_id" -> bắt đầu bằng "utm_" -> BỊ STRIP
  Param "fbclid_token"    -> không match "fbclid" chính xác -> KHÔNG BỊ STRIP
  -> VCL regex: (utm_[^=]+|fbclid|gclid) là exact match cho fbclid/gclid

EDGE CASE B: Empty value
  /search?q=shoe&utm_source=
  -> utm_source= vẫn bị strip (value rỗng nhưng param vẫn match)
  -> OK: empty value cũng không ảnh hưởng response

EDGE CASE C: URL-encoded params
  /search?q=shoe&utm_source=%65%6D%61%69%6C
  -> utm_source= vẫn bị strip vì regex match key, không quan tâm value encoding
  -> Nhưng nếu KEY bị encode (%75%74%6D_... = utm_...) -> KHÔNG match
  -> Cần thêm rule cho encoded keys nếu CDN nhận URL-encoded keys

EDGE CASE D: Duplicate params
  /search?q=shoe&sort=price&sort=name
  -> std.querysort không deduplicate
  -> Varnish thường lấy param value cuối cùng
  -> Nên tránh duplicate params nếu có thể

EDGE CASE E: Fragment (#)
  /search?q=shoe#section
  -> Fragment (#) không được gửi đến server (browser-only)
  -> Không ảnh hưởng cache key
```

---

## 8. Key signals/headers

### Headers cần đọc

| Header | Ý nghĩa | Cách đọc trong case này |
|--------|---------|------------------------|
| `X-Cache` | Trạng thái cache: `HIT` hoặc `MISS` | Signal QUAN TRỌNG NHẤT. Quyết định pass/fail. |
| `X-Cache-Hits` | Số lần object được hit | Bonus: thấy canonical object được hit bởi tracking request. |
| `X-Cache-Key-Language` | Ngôn ngữ trong cache key | Xác nhận variant isolation vẫn đúng. |
| `X-Cache-Key-Geo` | Geo trong cache key | Xác nhận geo không bị leak. |
| `X-Cache-Key-Device` | Device class trong cache key | Xác nhận device isolation. |
| `X-Cache-Key-AB` | A/B variant trong cache key | Xác nhận AB isolation. |
| `X-Served-By` | CDN node phục vụ request | Luôn `varnish` trong setup này. |
| `Cache-Control` | Cache directive từ origin | `s-maxage` hoặc `max-age` cho biết TTL. |
| `Content-Type` | Loại nội dung | `application/json` cho search API. |

### Cách đọc X-Cache sequence

```text
SEQUENCE MONG ĐỢI:

  Request A1 (canonical first):    X-Cache: MISS
  Request A2 (canonical second):   X-Cache: HIT, X-Cache-Hits: 1
  Request B  (tracking params):    X-Cache: HIT, X-Cache-Hits: 2
                                   ^^^ QUAN TRỌNG: HIT từ object canonical
                                   X-Cache-Hits tăng từ 1 lên 2
                                   Chứng tỏ tracking request DÙNG CHUNG object
  Request C1 (business first):     X-Cache: MISS
                                   ^^^ Object riêng cho sort=price
  Request C2 (business second):    X-Cache: HIT, X-Cache-Hits: 1
                                   ^^^ Object mới, hits mới bắt đầu từ 1
```

### Response content verification

```text
Ngoài headers, response body cũng cần được verify:

Request A1 (canonical: q=shoe):
  -> Response: danh sách sản phẩm liên quan đến "shoe"
  -> Mỗi item có id, name, price, ...

Request B (tracking: q=shoe + utm_source=...):
  -> Response: GIỐNG HỆT A1
  -> Cùng object -> response body identical

Request C1 (business: q=shoe + sort=price):
  -> Response: danh sách sản phẩm "shoe" SẮP XẾP THEO GIÁ
  -> KHÁC với A1 (thứ tự khác)
  -> Object khác -> response body khác

Nếu B trả về response KHÁC A1:
  -> Có thể B bị MISS (cache fragmentation)
  -> Hoặc B nhận object từ key khác (variant leak)
```

---

## 9. Pass/fail criteria

### PASS criteria

```text
PASS KHI TẤT CẢ CÁC ĐIỀU KIỆN SAU ĐÚNG:

 [P1] k6 exit code = 0 (tất cả checks pass)
 [P2] Canonical first request: status=200, X-Cache=MISS
 [P3] Canonical second request: status=200, X-Cache=HIT
      -> Baseline: canonical search được cache bình thường
 [P4] Tracking params request: status=200, X-Cache=HIT
      -> Tracking params không tạo cache object riêng
      -> Dùng chung object với canonical
 [P5] Business params first request: status=200, X-Cache=MISS
      -> Business param sort=price tạo cache object riêng
      -> Không reuse canonical object
 [P6] Business params second request: status=200, X-Cache=HIT
      -> Object business được cache bình thường
 [P7] Tất cả cache key headers đúng với expected profile
 [P8] Ban prefix setup hoàn tất không lỗi
```

### FAIL criteria

```text
FAIL KHI BẤT KỲ ĐIỀU KIỆN NÀO SAU ĐÂY XẢY RA:

 [F1] Tracking params request trả về MISS
      -> VCL strip tracking params không hoạt động
      -> Cache fragmentation trong production
      -> NGUY HIỂM NHẤT: cache hit ratio = 0% khi có campaign

 [F2] Business params request trả về HIT (thay vì MISS)
      -> VCL strip QUÁ aggressive -> đã strip cả sort=price
      -> Các request với sort khác nhau dùng chung object
      -> User thấy sai thứ tự sản phẩm

 [F3] Canonical request trả về MISS ở lần 2
      -> Cache không hoạt động hoặc TTL quá ngắn
      -> Cần kiểm tra cache policy

 [F4] Ban prefix setup fail
      -> Stale cache từ lần chạy trước làm nhiễu kết quả
      -> Có thể thấy HIT ở canonical first -> false positive

 [F5] Cache key headers không khớp expected
      -> Variant isolation bị sai
      -> Có thể phục vụ sai audience

 [F6] Bất kỳ check nào fail -> threshold checks rate==1 bị vi phạm
      -> k6 exit code != 0
```

### Ma trận pass/fail

```text
                          | Canonical HIT | Tracking HIT | Business MISS
--------------------------+---------------+---------------+---------------
Mọi thứ đúng              |     PASS      |     PASS      |     PASS
Strip không hoạt động      |     PASS      |   **FAIL**    |     PASS
Strip quá aggressive       |     PASS      |     PASS      |   **FAIL**
Cache không hoạt động      |   **FAIL**    |   **FAIL**    |     PASS*
Business = canonical       |     PASS      |     PASS      |     PASS
                           |               |               | (cùng key do
                           |               |               |  thiếu sort)
```

---

## 10. Cách chạy + output

### Cách chạy

```powershell
cd E:/Projects/k6/k6-metrics-server

$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

./scripts/run-cdn-capabilities.ps1 -Scenarios 04-query-normalization
```

### Hoặc chạy trực tiếp bằng k6

```powershell
k6 run `
  -e BASE_URL=http://localhost:80 `
  -e CONTROL_BASE_URL=http://localhost:8088 `
  -e CATALOG_EVENTS_BASE_URL=http://localhost:9091 `
  -e OPS_AUTH_TOKEN=<ops-token> `
  E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/04-query-normalization.js
```

### Output mong đợi (pass)

```text
         /\      |‾‾|  /‾‾/  /‾/
    /\  /  \     |  |_/  /  / /
   /  \/    \    |      |  /  ‾‾\
  /          \   |  |‾\  \ | (_) |
 / __________ \  |__|  \__\ \___/ .io

  execution: local
     script: E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\04-query-normalization.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations shared among 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)

running (0m00.3s), 1/1 VUs, 0 complete and 0 interrupted iterations
default   [   0% ] 1 VUs  0m00.3s/10m0s  0/1 shared iters

     ✓ canonical first status 200
     ✓ canonical first cache state MISS
     ✓ canonical first cache language en
     ✓ canonical first cache geo US
     ✓ canonical first cache device desktop
     ✓ canonical first cache ab control
     ✓ canonical second status 200
     ✓ canonical second cache state HIT
     ✓ canonical second cache language en
     ✓ canonical second cache geo US
     ✓ canonical second cache device desktop
     ✓ canonical second cache ab control
     ✓ tracked query status 200
     ✓ tracked query cache state HIT
     ✓ tracked query cache language en
     ✓ tracked query cache geo US
     ✓ tracked query cache device desktop
     ✓ tracked query cache ab control
     ✓ business param first status 200
     ✓ business param first cache state MISS
     ✓ business param first cache language en
     ✓ business param first cache geo US
     ✓ business param first cache device desktop
     ✓ business param first cache ab control
     ✓ business param second status 200
     ✓ business param second cache state HIT
     ✓ business param second cache language en
     ✓ business param second cache geo US
     ✓ business param second cache device desktop
     ✓ business param second cache ab control

     ✓ checks.........................: 100.00% ✓ 30       ✗ 0
     data_received..................: 15 kB   49 kB/s
     data_sent......................: 3.2 kB  11 kB/s
     http_req_duration.............: avg=12ms  min=3ms  max=25ms
     http_reqs......................: 5       16.7/s
     iteration_duration............: avg=260ms min=260ms max=260ms
     iterations.....................: 1       3.3/s

all checks passed
```

### Output khi fail (tracking MISS)

```text
  ✗ tracked query cache state HIT
    ↳  53% — ✓ 0 / ✗ 1
       (expected HIT, got MISS)

  checks...: 96.66% ✓ 29 ✗ 1
  ✗ checks rate threshold: rate=1 not met (got 0.9666)

ERRO[0002] thresholds on metrics 'checks' have been crossed
```

### Cách đọc output

```text
KIỂM TRA THEO THỨ TỰ:

1. checks rate: phải = 100% (rate==1)
2. canonical first: MISS -> OK
3. canonical second: HIT -> OK, baseline đã warm
4. tracked query: HIT -> KEY CHECK, nếu MISS là CRITICAL FAIL
5. business param first: MISS -> KEY CHECK, nếu HIT là FAIL (quá aggressive)
6. business param second: HIT -> OK, business object được cache

Nếu fail ở bước 4:
  -> Tracking params gây cache fragmentation
  -> VCL strip rule có vấn đề
  -> Cần kiểm tra regsuball regex

Nếu fail ở bước 5:
  -> VCL strip quá aggressive, xóa cả sort=price
  -> Cần kiểm tra regex có match nhầm business params không
```

---

## 11. 4 output -> decision scenarios

### Scenario A: "Tracking param gây cache MISS" -- VCL strip bị hỏng

```text
OUTPUT:
  ✓ canonical first cache state MISS
  ✓ canonical second cache state HIT
  ✗ tracked query cache state HIT         <- expected HIT, got MISS
  ✓ business param first cache state MISS
  ✓ business param second cache state HIT

ANALYSIS:
  Canonical search cache hoạt động bình thường.
  Nhưng tracking params request bị MISS -> tracking params KHÔNG bị strip.
  Business params vẫn hoạt động đúng -> strip rule không quá aggressive.
  Vấn đề: strip rule không hoạt động hoặc strip list thiếu param.

ROOT CAUSE (các khả năng):
  a) Regex trong regsuball bị sai syntax
  b) VCL file chưa được reload sau khi sửa
  c) req.url không match điều kiện "\\?" (hiếm)
  d) Tracking param key bị URL-encoded (%75%74%6D_...)
  e) Strip list chưa có param mới (msclkid, ttclid, ...)

BUSINESS IMPACT:
  CRITICAL. Cache hit ratio giảm về gần 0% trong campaign traffic.
  Origin server bị quá tải. Response time tăng 100x.
  User thấy timeout hoặc 502.
  Doanh thu mất trong giờ cao điểm.

DECISION:
  1. Kiểm tra VCL regex pattern có đúng không
  2. Xác nhận VCL đã được deploy và reload (varnishadm vcl.list)
  3. Kiểm tra log Varnish (varnishlog -g request -q "ReqUrl ~ 'utm_'")
  4. Nếu regex đúng nhưng không khớp -> kiểm tra URL encoding
  5. Kiểm tra strip list đã cover hết tracking params chưa
  6. Rerun test sau khi fix
```

### Scenario B: "Business param gây HIT" -- VCL strip quá aggressive

```text
OUTPUT:
  ✓ canonical first cache state MISS
  ✓ canonical second cache state HIT
  ✓ tracked query cache state HIT
  ✗ business param first cache state MISS  <- expected MISS, got HIT
  ✓ business param second cache state HIT

ANALYSIS:
  Tracking params bị strip đúng (HIT).
  Business params request LẼ RA phải MISS nhưng lại HIT.
  -> Business param sort=price đã bị strip khỏi cache key.
  -> Cache key của /search?q=shoe&sort=price = cache key của /search?q=shoe.
  -> User tìm "shoe" sort theo "price" nhưng nhận response của "shoe" không sort.

ROOT CAUSE (các khả năng):
  a) Regex strip QUÁ RỘNG: match cả sort, page, limit, ...
     Ví dụ: regsuball(req.url, "([?&])([^=]+)=[^&]*", "\1")
            -> strip TẤT CẢ query params (sai!)
  b) Cleanup bước sau xóa nhầm business params
  c) Ai đó thêm sort vào strip list vì nghĩ "sort cũng là metadata"
  d) VCL bị thay thế bởi phiên bản generic strip-all

BUSINESS IMPACT:
  CRITICAL. User nhận sai nội dung.
  /search?q=shoe&sort=price -> thấy kết quả mặc định (sort by relevance)
                               thay vì sort by price.
  /search?q=shoe&page=3      -> thấy trang 1 thay vì trang 3.
  User không tìm được sản phẩm mong muốn -> mất conversion.

DECISION:
  1. Audit VCL strip regex: phải CHỈ strip tracking params,
     KHÔNG strip business params
  2. Dùng whitelist approach thay vì blacklist:
     Chỉ strip các param đã biết là tracking (utm_*, fbclid, gclid, ...)
     KHÔNG strip tất cả param không rõ nguồn gốc
  3. Thêm test case cho TẤT CẢ business params (q, page, sort, limit,
     category, view) để đảm bảo không param nào bị strip nhầm
  4. Rerun test sau khi fix
```

### Scenario C: "New tracking param chưa có trong strip list" -- cache bắt đầu fragment

```text
OUTPUT (sau khi thêm gad_source vào URL test):
  ✓ canonical first cache state MISS
  ✓ canonical second cache state HIT
  ✓ tracked query cache state HIT           <- utm, fbclid, gclid vẫn bị strip OK
  ✗ gad_source query cache state HIT        <- expected HIT, got MISS
  ✓ business param first cache state MISS

ANALYSIS:
  Team marketing bắt đầu chạy Google Ads measurement.
  Google thêm param "gad_source" vào URL.
  gad_source KHÔNG có trong VCL strip list.
  -> Mỗi click từ Google Ads tạo cache object riêng.
  -> Cache fragmentation bắt đầu xảy ra.

ROOT CAUSE:
  Strip list trong VCL chỉ có: utm_*, fbclid, gclid.
  Các nền tảng quảng cáo mới thêm tracking params mới liên tục.
  gad_source, msclkid, ttclid, ... chưa được cập nhật vào strip list.

BUSINESS IMPACT:
  MEDIUM -> CRITICAL (tăng dần theo adoption của nền tảng mới).
  Khi Google Ads measurement được adopt rộng rãi:
    - Mỗi click tạo cache MISS
    - Cache hit ratio giảm dần
    - Không sudden drop như scenario A, mà degradation từ từ
    - Khó phát hiện hơn vì "vẫn còn HIT từ traffic organic"

DECISION:
  1. Cập nhật VCL strip regex để thêm param mới:
     (utm_[^=]+|fbclid|gclid|gad_source|msclkid|ttclid|gclsrc|li_fat_id|epik)
  2. Setup monitoring: alert khi cache hit ratio giảm dưới ngưỡng
  3. Định kỳ review query params xuất hiện trong log để phát hiện
     tracking params mới
  4. Cân nhắc: thay vì hardcode từng param, dùng pattern-based approach
     (ví dụ: strip tất cả param kết thúc bằng "clid" hoặc "clkid")
  5. Thêm test case cho param mới
  6. Rerun test sau khi cập nhật VCL
```

### Scenario D: "Querysort không hoạt động" -- query param order gây fragmentation

```text
OUTPUT (khi test query params với thứ tự khác nhau):
  ✓ /search?q=shoe&sort=price        -> MISS -> HIT
  ✗ /search?sort=price&q=shoe        -> expected HIT, got MISS

ANALYSIS:
  Cùng business params, chỉ khác thứ tự.
  Nếu không có std.querysort:
    Cache key 1: /search?q=shoe&sort=price
    Cache key 2: /search?sort=price&q=shoe
    -> 2 cache objects cho cùng một response
    -> Cache fragmentation do thứ tự params

ROOT CAUSE:
  std.querysort(req.url) không được gọi, hoặc bị comment out,
  hoặc bị đặt sai vị trí (trước khi strip tracking params).

BUSINESS IMPACT:
  MEDIUM. Cache bị fragment gấp N! lần (N = số params).
  Với 4 business params: 4! = 24 cache objects cho cùng response.
  Cache hit ratio giảm nhưng không về 0 (vẫn có HIT cho cùng thứ tự).

DECISION:
  1. Kiểm tra std.querysort có trong VCL không
  2. Đảm bảo querysort được gọi SAU strip tracking params
  3. Đảm bảo querysort được gọi TRƯỚC return(hash)
  4. Test với nhiều hoán vị params khác nhau
```

---

## 12. Nghịch lý / misconceptions

### Misconception 1: "Strip càng nhiều param càng tốt"

```text
SUY NGHĨ SAI:
  "Query params gây cache fragmentation. Vậy strip hết tất cả query params đi.
   Cache key chỉ còn path -> cache hit ratio tối đa."

THỰC TẾ:
  Strip hết query params -> cache key = path thuần
  /search?q=shoe  -> cache key: /search
  /search?q=hat   -> cache key: /search
  -> CÙNG CACHE KEY
  -> User tìm "shoe" nhận kết quả của "hat"
  -> SAI NGHIÊM TRỌNG

NGUYÊN TẮC ĐÚNG:
  CHỈ strip params không ảnh hưởng response content.
  GIỮ params ảnh hưởng response content.
  Đây là sự khác biệt giữa QUERY NORMALIZATION và QUERY STRIPPING.
```

### Misconception 2: "Query params luôn fragment cache"

```text
SUY NGHĨ SAI:
  "Có query params là cache bị fragment. Nên disable cache cho mọi URL có
   query string, hoặc dùng POST thay vì GET."

THỰC TẾ:
  Query params CHỈ fragment cache nếu CDN không normalize.
  Với query normalization đúng:
    - Tracking params không fragment cache
    - Business params tạo cache object riêng -> ĐÂY LÀ HÀNH VI MONG MUỐN
    - Mỗi business param combination CẦN một cache object riêng
      vì response khác nhau

NGUYÊN TẮC ĐÚNG:
  Không sợ query params. Sợ CDN thiếu query normalization.
```

### Misconception 3: "UTM params là đủ, không cần lo các params khác"

```text
SUY NGHĨ SAI:
  "Chỉ cần strip utm_* là đủ. Mấy params như fbclid, gclid ít gặp."

THỰC TẾ:
  fbclid XUẤT HIỆN TRÊN MỌI CLICK TỪ FACEBOOK.
  gclid XUẤT HIỆN TRÊN MỌI CLICK TỪ GOOGLE ADS.
  Đây là HAI NGUỒN TRAFFIC LỚN NHẤT cho hầu hết e-commerce sites.

  Nếu không strip fbclid và gclid:
    - Mọi click từ Facebook Ads -> MISS
    - Mọi click từ Google Ads -> MISS
    - Cache hit ratio cho paid traffic = 0%

  Ngoài ra, các nền tảng MỚI liên tục thêm tracking params mới:
    - TikTok: ttclid
    - Microsoft Ads: msclkid
    - Pinterest: epik
    - LinkedIn: li_fat_id

NGUYÊN TẮC ĐÚNG:
  Strip list phải được cập nhật LIÊN TỤC.
  Cân nhắc pattern-based approach: strip tất cả param kết thúc bằng "clid",
  "clkid", "source", hoặc match pattern tracking phổ biến.
```

### Misconception 4: "Application ignore tracking params -> CDN cũng tự động ignore"

```text
SUY NGHĨ SAI:
  "Application đã ignore utm_source, fbclid. CDN cache chắc cũng tự biết
   mà ignore thôi."

THỰC TẾ:
  Application logic và CDN cache key logic là HAI TẦNG ĐỘC LẬP.
  CDN tính cache key từ RAW URL, không biết application ignore cái gì.
  Nếu không cấu hình VCL strip tracking params -> cache key vẫn bao gồm
  toàn bộ query string -> cache fragmentation.

  Application: "Tôi không quan tâm utm_source" -> response giống nhau
  CDN:        "Tôi thấy URL khác -> cache key khác -> MISS"
  -> Cache fragmentation mặc dù application logic đúng.

NGUYÊN TẮC ĐÚNG:
  Query normalization phải được cấu hình ở CDN layer.
  Application ignore là chưa đủ.
```

### Misconception 5: "Chỉ cần test canonical search là đủ"

```text
SUY NGHĨ SAI:
  "Search API cache hoạt động (MISS -> HIT) là pass. Không cần test
   tracking params."

THỰC TẾ:
  Search API cache hoạt động với canonical URL là baseline.
  Nhưng chưa chứng minh được tracking params không fragment cache.
  Production: canonical search HIT 100%, tracking search MISS 100%.
  Cache hit ratio trung bình vẫn thấp vì phần lớn traffic là từ ads
  (có tracking params).

NGUYÊN TẮC ĐÚNG:
  Phải test CẢ canonical VÀ tracking params.
  Đây là lý do case này có 3 nhóm test (canonical, tracking, business).
```

---

## 13. Checklist

Trước khi chạy case:

```text
 [ ] BASE_URL=http://localhost:80 (public CDN path)
 [ ] CONTROL_BASE_URL=http://localhost:8088 (ban-prefix hoạt động)
 [ ] OPS_AUTH_TOKEN được set
 [ ] Varnish đang chạy và healthy
 [ ] Backend (Nginx + app) healthy
 [ ] Không có cache objects cũ dưới /api/sim/products/search
 [ ] VCL file đã được deploy và reload
```

Trong lúc case chạy, xác nhận:

```text
 [ ] Setup ban prefix: HTTP 200 từ control path
 [ ] A1 (canonical first):  status=200, X-Cache=MISS
 [ ] A2 (canonical second): status=200, X-Cache=HIT
 [ ] B  (tracking params):  status=200, X-Cache=HIT
 [ ] C1 (business first):   status=200, X-Cache=MISS
 [ ] C2 (business second):  status=200, X-Cache=HIT
 [ ] Cache key headers nhất quán giữa tất cả requests
 [ ] Không có X-Cache-Stale (không serve stale object)
```

Sau khi case chạy, verify:

```text
 [ ] k6 exit code = 0
 [ ] checks rate = 100% (30/30 checks pass)
 [ ] http_reqs = 5 (đúng 5 requests: A1, A2, B, C1, C2)
 [ ] Không có request failure (http_req_failed = 0)
 [ ] Response time < 100ms (cache HIT phải rất nhanh)
```

Debug nếu fail:

```text
 [ ] Kiểm tra VCL regsuball regex trên URL test
 [ ] varnishlog -g request -q "ReqUrl ~ 'utm_'"
 [ ] varnishlog -g request -q "ReqUrl ~ 'fbclid'"
 [ ] Kiểm tra X-Cache header từng request
 [ ] So sánh cache key hash nếu có thể
 [ ] Kiểm tra ban-prefix có thực sự xóa cache không
 [ ] Kiểm tra TTL của search cache objects
```

---

## 14. 4-5 Variations

### Variation 1: New tracking params (gad_source, msclkid, ttclid)

```javascript
// Thêm vào script test
const newTrackingPath = '/api/sim/products/search?q=shoe&gad_source=1&msclkid=abc&ttclid=xyz';

const newTracking = requestCdn('GET', newTrackingPath, {
  profile,
  tags: { case: 'new_tracking_params' },
});
assertStatus(newTracking, 200, 'new tracking params');
assertCacheState(newTracking, 'HIT', 'new tracking params');
// Nếu VCL chưa cập nhật strip list -> SẼ MISS
// Đây là cách phát hiện strip list thiếu param
```

**Mục đích**: Phát hiện tracking params mới từ các nền tảng quảng cáo chưa được strip.

### Variation 2: Custom business params

```javascript
// Test business params đặc thù của ứng dụng
const customBusinessPaths = [
  '/api/sim/products/search?q=shoe&category=running',
  '/api/sim/products/search?q=shoe&view=grid',
  '/api/sim/products/search?q=shoe&limit=50',
  '/api/sim/products/search?q=shoe&page=2',
];

for (const path of customBusinessPaths) {
  const first = requestCdn('GET', path, {
    profile,
    tags: { case: `custom_business_first_${path}` },
  });
  assertCacheState(first, 'MISS', `custom business first: ${path}`);
  // Mỗi business param combination phải tạo object riêng

  const second = requestCdn('GET', path, {
    profile,
    tags: { case: `custom_business_second_${path}` },
  });
  assertCacheState(second, 'HIT', `custom business second: ${path}`);
  // Lần 2 phải HIT
}
```

**Mục đích**: Đảm bảo TẤT CẢ business params đều không bị strip nhầm.

### Variation 3: Query param ordering variance

```javascript
// Test thứ tự params khác nhau -> phải cùng cache key
const orderVariants = [
  '/api/sim/products/search?q=shoe&sort=price&page=2',
  '/api/sim/products/search?page=2&q=shoe&sort=price',
  '/api/sim/products/search?sort=price&page=2&q=shoe',
];

// Warm cache với variant đầu tiên
const warm = requestCdn('GET', orderVariants[0], {
  profile,
  tags: { case: 'order_warm' },
});
assertCacheState(warm, 'MISS', 'order warm');
// MISS vì là lần đầu

// Các variant còn lại phải HIT (std.querysort đảm bảo cùng cache key)
for (let i = 1; i < orderVariants.length; i++) {
  const req = requestCdn('GET', orderVariants[i], {
    profile,
    tags: { case: `order_variant_${i}` },
  });
  assertCacheState(req, 'HIT', `order variant ${i}`);
  // Phải HIT vì std.querysort đã sort params
}
```

**Mục đích**: Xác nhận std.querysort hoạt động -- thứ tự params không ảnh hưởng cache key.

### Variation 4: Empty vs absent params

```javascript
// Test param rỗng vs không có param
const emptyParamPath = '/api/sim/products/search?q=shoe&sort=';
const absentParamPath = '/api/sim/products/search?q=shoe';

const emptyFirst = requestCdn('GET', emptyParamPath, {
  profile,
  tags: { case: 'empty_param_first' },
});
assertCacheState(emptyFirst, 'MISS', 'empty param first');

const absentFirst = requestCdn('GET', absentParamPath, {
  profile,
  tags: { case: 'absent_param_first' },
});
assertCacheState(absentFirst, 'HIT', 'absent param first');
// ?q=shoe&sort= và ?q=shoe CÓ CÙNG cache key không?
// Tùy thuộc vào VCL cleanup: nếu empty param bị strip -> HIT
// Nếu empty param được giữ -> MISS
// Cần xác định behavior mong muốn
```

**Mục đích**: Xác định edge case behavior cho params rỗng.

### Variation 5: Smoke -- tracking params trên nhiều endpoint

```javascript
// Test query normalization trên nhiều path khác nhau
const smokePaths = [
  '/api/sim/products/search?q=shoe&utm_source=test',
  '/api/sim/products/categories?utm_source=test',
  '/api/sim/products?category=shoes&utm_source=test',
  '/api/sim/products/1?utm_source=test',
];

for (const path of smokePaths) {
  const req = requestCdn('GET', path, {
    profile,
    tags: { case: `smoke_${path}` },
  });
  assertStatus(req, 200, `smoke status: ${path}`);
  // Cache state có thể HIT hoặc MISS tùy endpoint và cache state hiện tại
  // Mục đích: đảm bảo tracking params không gây lỗi trên endpoint nào
}
```

**Mục đích**: Sanity check nhanh -- tracking params không làm hỏng request ở bất kỳ endpoint nào.

---

## 15. Anti-patterns

### Anti-pattern 1: Strip tất cả query params

```vcl
# SAI -- ĐỪNG LÀM
if (req.url ~ "\?") {
    set req.url = regsub(req.url, "\?.*$", "");
}
```

```text
HẬU QUẢ:
  /search?q=shoe&sort=price -> cache key: /search
  /search?q=hat&page=3      -> cache key: /search
  -> Mọi search query dùng chung một cache object
  -> User luôn nhận kết quả của request đầu tiên
  -> SAI HOÀN TOÀN

CÁCH ĐÚNG:
  Chỉ strip tracking params cụ thể, giữ business params.
```

### Anti-pattern 2: Không cập nhật strip list cho nền tảng mới

```vcl
# THIẾU -- strip list cũ, thiếu params mới
set req.url = regsuball(req.url, "(\?|&)(utm_[^=]+|fbclid|gclid)=[^&]*", "\1");
# Thiếu: msclkid, ttclid, gad_source, gclsrc, li_fat_id, epik, ...
```

```text
HẬU QUẢ:
  Khi team marketing bắt đầu dùng TikTok Ads:
    - Mỗi click có ttclid=... unique
    - ttclid không bị strip -> mỗi click tạo cache object riêng
    - Cache hit ratio giảm từ 95% xuống 5% cho traffic từ TikTok
    - Khó phát hiện vì "tổng thể vẫn 80% hit ratio"
      (organic traffic vẫn HIT bình thường)

CÁCH ĐÚNG:
  - Cập nhật strip list ĐỊNH KỲ (mỗi quý)
  - Monitor query params mới xuất hiện trong access log
  - Cân nhắc pattern-based approach: strip param match pattern clid$, clkid$, source$
```

### Anti-pattern 3: Normalize query param ORDER nhưng không VALUES

```vcl
# CHỈ SORT, KHÔNG STRIP -- không đủ
set req.url = std.querysort(req.url);
# Thiếu strip tracking params
```

```text
HẬU QUẢ:
  Thứ tự params được sort -> cache key nhất quán cho cùng bộ params.
  Nhưng tracking params VẪN trong cache key.
  /search?fbclid=abc&q=shoe -> cache key: /search?fbclid=abc&q=shoe
  /search?fbclid=xyz&q=shoe -> cache key: /search?fbclid=xyz&q=shoe
  -> Vẫn 2 cache objects cho cùng response
  -> Querysort không giải quyết được vấn đề tracking param values khác nhau

CÁCH ĐÚNG:
  Strip tracking params TRƯỚC, querysort SAU.
  Thứ tự: strip -> cleanup -> querysort.
```

### Anti-pattern 4: Dùng URL gốc cho cache key, normalize cho backend

```vcl
# SAI -- normalize sai chỗ
sub vcl_recv {
    # Normalize req.url cho backend
    set req.http.X-Original-Url = req.url;
    set req.url = regsuball(req.url, "(\?|&)(utm_[^=]+|fbclid|gclid)=[^&]*", "\1");
    # ... cleanup ...
}
sub vcl_hash {
    hash_data(req.http.X-Original-Url);  # <-- DÙNG URL GỐC
}
```

```text
HẬU QUẢ:
  Backend nhận URL đã normalize (tốt).
  Nhưng cache key dùng URL GỐC (có tracking params).
  -> Cache vẫn bị fragmentation.
  -> Backend behavior đúng, CDN behavior sai.

CÁCH ĐÚNG:
  Cache key phải dùng URL ĐÃ NORMALIZE.
  Trong VCL hiện tại: normalize xong -> return(hash) -> hash_data(req.url).
  req.url lúc này đã là URL đã normalize.
```

### Anti-pattern 5: Strip tracking params ở application layer thay vì CDN layer

```text
SUY NGHĨ SAI:
  "Để Nginx/application strip tracking params trước khi xử lý business logic.
   CDN cứ cache theo URL gốc."

HẬU QUẢ:
  Application strip tracking params -> response giống nhau cho mọi tracking URL.
  Nhưng CDN cache key vẫn từ URL GỐC (có tracking params).
  -> Vẫn 50,000 cache objects cho cùng response.
  -> Application logic đúng nhưng CDN cache vẫn bị fragmentation.

CÁCH ĐÚNG:
  CDN phải normalize TRƯỚC KHI tính cache key.
  Application có thể normalize lại cho business logic (nhưng không bắt buộc
  nếu CDN đã strip trước khi forward).
```

---

## 16. Real validation data

### Dữ liệu từ case chạy thực tế

```text
CASE ID:        cdn-04-query-normalization
THỜI GIAN:      2026-06-21
MÔI TRƯỜNG:     TargetLayer=full, localhost
SCRIPT:          04-query-normalization.js
VUS:             1
ITERATIONS:      1

KẾT QUẢ:        PASS (30/30 checks)

CHECK RESULTS:
  canonical_first_status_200:           PASS
  canonical_first_cache_state_MISS:     PASS
  canonical_first_cache_language_en:    PASS
  canonical_first_cache_geo_US:         PASS
  canonical_first_cache_device_desktop: PASS
  canonical_first_cache_ab_control:     PASS

  canonical_second_status_200:          PASS
  canonical_second_cache_state_HIT:     PASS
  canonical_second_cache_language_en:   PASS
  canonical_second_cache_geo_US:        PASS
  canonical_second_cache_device_desktop:PASS
  canonical_second_cache_ab_control:    PASS

  tracked_query_status_200:             PASS
  tracked_query_cache_state_HIT:        PASS  <-- KEY: tracking không fragment
  tracked_query_cache_language_en:      PASS
  tracked_query_cache_geo_US:           PASS
  tracked_query_cache_device_desktop:   PASS
  tracked_query_cache_ab_control:       PASS

  business_param_first_status_200:      PASS
  business_param_first_cache_state_MISS:PASS  <-- KEY: business tạo object riêng
  business_param_first_cache_language_en:PASS
  business_param_first_cache_geo_US:    PASS
  business_param_first_cache_device_desktop:PASS
  business_param_first_cache_ab_control:PASS

  business_param_second_status_200:     PASS
  business_param_second_cache_state_HIT:PASS
  business_param_second_cache_language_en:PASS
  business_param_second_cache_geo_US:   PASS
  business_param_second_cache_device_desktop:PASS
  business_param_second_cache_ab_control:PASS

METRICS:
  http_reqs:              5
  http_req_duration_avg:  12ms
  http_req_failed:        0
  iteration_duration:     260ms
  checks_rate:            1.0 (100%)

X-CACHE SEQUENCE:  MISS -> HIT -> HIT -> MISS -> HIT
                   (A1)   (A2)   (B)   (C1)   (C2)
                   ĐÚNG CONTRACT
```

### So sánh canonical vs tracking vs business

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                         CACHE BEHAVIOR COMPARISON                       │
├──────────────────────────┬──────────────┬───────────────┬───────────────┤
│                          │  CANONICAL   │   TRACKING    │   BUSINESS    │
├──────────────────────────┼──────────────┼───────────────┼───────────────┤
│ URL                      │ /search?     │ /search?      │ /search?      │
│                          │ q=shoe       │ q=shoe&       │ q=shoe&       │
│                          │              │ utm_source=.. │ sort=price    │
│                          │              │ &fbclid=..    │               │
│                          │              │ &gclid=..     │               │
├──────────────────────────┼──────────────┼───────────────┼───────────────┤
│ URL sau VCL normalize    │ /search?     │ /search?      │ /search?      │
│                          │ q=shoe       │ q=shoe        │ q=shoe&       │
│                          │              │               │ sort=price    │
├──────────────────────────┼──────────────┼───────────────┼───────────────┤
│ Cache key (so với       │ = canonical   │ = canonical   │ != canonical  │
│ canonical)               │              │ (HIT)         │ (MISS)        │
├──────────────────────────┼──────────────┼───────────────┼───────────────┤
│ First request            │ MISS         │ HIT           │ MISS          │
│ Second request           │ HIT          │ (không cần    │ HIT           │
│                          │              │  test riêng)  │               │
├──────────────────────────┼──────────────┼───────────────┼───────────────┤
│ Response content         │ shoes mặc    │ GIỐNG HỆT     │ shoes sắp xếp │
│                          │ định         │ canonical     │ theo giá      │
├──────────────────────────┼──────────────┼───────────────┼───────────────┤
│ Cache fragmentation risk │ Không         │ CÓ nếu VCL    │ Không (đây là │
│                          │              │ không strip  │ behavior      │
│                          │              │               │ mong muốn)    │
└──────────────────────────┴──────────────┴───────────────┴───────────────┘
```

---

## 17. Reference

### Liên kết nội bộ

| Tài liệu | Đường dẫn |
|----------|-----------|
| Run guide | `../RUN_GUIDE.md` |
| Overview CDN series | `./00_overview.md` |
| Case catalog | `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/case-catalog.json` |
| Source README | `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md` |
| Layer roadmap | `E:/Projects/k6/k6-metrics-server/load-target/k6/layer-roadmap.md` |

### Liên kết source code

| File | Đường dẫn |
|------|-----------|
| Test script | `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/04-query-normalization.js` |
| Shared helpers | `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js` |
| VCL config | `E:/Projects/k6/k6-metrics-server/load-target/varnish/default.vcl` |

### Case liên quan trong series

| Case | Mối liên hệ |
|------|-------------|
| `cdn-01-hit-smoke` | Baseline: hiểu cold MISS -> HIT trước khi test normalization |
| `cdn-02-variant-keys` | Cache key variant isolation -- query normalization là một phần của cache key |
| `cdn-03-bypass-rules` | Private/write traffic không cache -- ngược lại với public GET search |
| `cdn-05-invalidation-ops` | Purge/ban sau khi warm cache -- query normalized URLs cũng phải invalidate được |

### External references

```text
- Varnish docs: std.querysort
  https://varnish-cache.org/docs/trunk/reference/vmod/std.html#std-querysort

- Varnish docs: regsub / regsuball
  https://varnish-cache.org/docs/trunk/reference/vcl.html#functions

- Google Analytics: UTM parameters
  https://support.google.com/analytics/answer/1033863

- Facebook: fbclid parameter
  https://developers.facebook.com/docs/marketing-api/click-tracking

- Google Ads: gclid parameter
  https://support.google.com/google-ads/answer/9028762

- Microsoft Advertising: msclkid parameter
  https://help.ads.microsoft.com/apex/index/3/en/60001
```

---

> **Tóm tắt**: Case `cdn-04-query-normalization` chứng minh CDN phân biệt đúng tracking params (cache-neutral) và business params (cache-significant). Tracking params bị strip khỏi cache key -- mọi biến thể UTM, fbclid, gclid đều HIT từ canonical object. Business params được giữ trong cache key -- mỗi tổ hợp `q`, `sort`, `page` tạo object riêng. Đây là nền tảng chống cache fragmentation trong traffic marketing, bảo vệ origin khỏi stampede trong giờ cao điểm campaign.
