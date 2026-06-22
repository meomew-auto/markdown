# Case 04: Query normalization

> **Case ID:** `cdn-04-query-normalization`
> **Script:** `04-query-normalization.js`
> **Layer:** CDN / Varnish
> **Proof:** tracking params không phá cache; business params tạo object riêng

---

## 1. Tình huống thực tế

### 1.1. Bối cảnh doanh nghiệp

Một hệ thống thương mại điện tử chạy chiến dịch marketing đa kênh. Mỗi kênh marketing gắn tracking parameters vào URL để đo lường hiệu quả:

| Kênh | Tracking param | Ví dụ URL |
| --- | --- | --- |
| Email marketing | `utm_source=newsletter`, `utm_medium=email`, `utm_campaign=flash_sale` | `/search?q=shoe&utm_source=newsletter&utm_medium=email&utm_campaign=flash_sale` |
| Facebook Ads | `fbclid=abc123` | `/search?q=shoe&fbclid=abc123` |
| Google Ads | `gclid=paid123` | `/search?q=shoe&gclid=paid123` |
| Social sharing | `ref=twitter`, `utm_source=twitter` | `/search?q=shoe&ref=twitter&utm_source=twitter` |

Mỗi user click vào link từ một kênh khác nhau sẽ có URL khác nhau, **nhưng họ đều tìm kiếm cùng một thứ**: sản phẩm "shoe". Nếu CDN cache mỗi URL tracking riêng biệt, hiệu quả cache sẽ rất thấp.

Ngược lại, một số query parameters mang ý nghĩa nghiệp vụ thực sự:

| Business param | Ý nghĩa | Ví dụ URL |
| --- | --- | --- |
| `sort=price` | Sắp xếp theo giá | `/search?q=shoe&sort=price` |
| `sort=newest` | Sắp xếp theo mới nhất | `/search?q=shoe&sort=newest` |
| `page=2` | Phân trang | `/search?q=shoe&page=2` |
| `filter=brand:nike` | Lọc theo thương hiệu | `/search?q=shoe&filter=brand:nike` |

Hai kết quả `?q=shoe&sort=price` và `?q=shoe&sort=newest` **khác nhau về nội dung** — chúng phải tạo ra hai cache object riêng biệt.

### 1.2. Bài toán "cache fragmentation"

Cache fragmentation xảy ra khi nhiều URL khác nhau về mặt cú pháp nhưng giống nhau về mặt ngữ nghĩa (cùng một response) lại tạo ra nhiều cache object riêng biệt:

```text
Không có normalization (FRAGMENTATION):
  /search?q=shoe                                          ──▶ Cache object #1
  /search?q=shoe&utm_source=newsletter                     ──▶ Cache object #2
  /search?q=shoe&utm_source=facebook&fbclid=abc            ──▶ Cache object #3
  /search?q=shoe&utm_source=google&gclid=xyz               ──▶ Cache object #4
  /search?q=shoe&utm_source=email&utm_campaign=sale        ──▶ Cache object #5

  => 5 cache object cho CÙNG MỘT kết quả tìm kiếm "shoe"
  => Hit rate giảm 80%: mỗi user từ kênh khác nhau nhận MISS
  => Cache storage bị lãng phí
  => Origin bị gọi nhiều lần không cần thiết
```

```text
Có normalization (TỐI ƯU):
  /search?q=shoe                                ──▶ Cache object #1
  /search?q=shoe&utm_source=newsletter           ──▶ Cache object #1 (HIT)
  /search?q=shoe&fbclid=abc                      ──▶ Cache object #1 (HIT)
  /search?q=shoe&gclid=xyz                       ──▶ Cache object #1 (HIT)
  /search?q=shoe&utm_source=email&utm_campaign=sale ──▶ Cache object #1 (HIT)

  => 1 cache object cho tất cả biến thể tracking
  => Hit rate gần 100% sau lần warm đầu tiên
```

### 1.3. Hành vi mong đợi

Hai quy tắc vàng của query normalization:

| Quy tắc | Mô tả | Ví dụ |
| --- | --- | --- |
| **Tracking params bị loại bỏ** | Các param như `utm_*`, `fbclid`, `gclid`, `ref` bị strip khỏi cache key | `?q=shoe&utm=...&fbclid=...` normalizes thành `?q=shoe` |
| **Business params được giữ lại** | Các param như `sort`, `filter`, `page`, `q` được giữ trong cache key | `?q=shoe&sort=price` và `?q=shoe&sort=newest` là 2 cache object khác nhau |

---

## 2. CDN capability được chứng minh

### 2.1. Phát biểu capability

> **tracking params không phá cache; business params tạo object riêng**

CDN có khả năng normalize query string trước khi tính cache key. Các tracking parameter chỉ dùng cho analytics được loại bỏ khỏi cache key, trong khi các business parameter quyết định nội dung response được giữ nguyên.

### 2.2. Phạm vi proof

Case này chứng minh bốn hành vi:

| # | Hành vi | Cách chứng minh |
| --- | --- | --- |
| 1 | **Canonical MISS -> HIT** | Request `?q=shoe` lần 1 MISS, lần 2 HIT |
| 2 | **Tracking param HIT canonical** | Request `?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123` trả về HIT (cache key trùng canonical) |
| 3 | **Business param MISS** | Request `?q=shoe&sort=price` trả về MISS (cache key khác canonical) |
| 4 | **Business param HIT chính nó** | Request `?q=shoe&sort=price` lần 2 HIT (cache key riêng được tạo) |

### 2.3. Tại sao cần control plane (ban prefix)

Query normalization là phép biến đổi ở cache key level — không thể test nếu cache đã có object từ lần chạy trước. `setup()` gọi `banPrefix(paths.searchPrefix)` để xóa **tất cả object** dưới prefix `/api/sim/products/search`, đảm bảo:

- Không có artifact từ lần chạy trước
- Request canonical đầu tiên LUÔN là MISS (không thể là HIT do warm sẵn)
- Mọi HIT sau đó là do normalization hoạt động, không phải do cache cũ

### 2.4. Profile `guestUSDesktopControl` — tại sao dùng profile này

Script dùng `profiles.guestUSDesktopControl` (US, desktop, English, control) thay vì VN mobile như case 03:

```javascript
profiles.guestUSDesktopControl = {
  name: 'guest_us_desktop_control',
  headers: {
    'Accept-Language': 'en',
    'X-Geo-Country': 'US',
    'X-Device-Class': 'desktop',
    'X-Ab-Variant': 'control',
    'X-User-Segment': 'guest',
  },
};
```

Lý do: profile này có `Accept-Language: en` để chứng minh cache key normalization hoạt động đồng thời ở cả query string level và header level. `expectedCacheKey(profile)` sẽ tính ra `language: 'en'` thay vì `'vi'` — kiểm tra `assertCacheKeyHeaders` xác nhận cả query normalization lẫn header normalization cùng đúng.

---

## 3. Vì sao phải test ở CDN layer

### 3.1. App layer không biết về tracking params

| Tầng | Tracking param behavior | Vấn đề |
| --- | --- | --- |
| **Browser/Client** | Thêm tracking params vào URL khi user click ad link | Không kiểm soát được |
| **App Server** | Parse `?q=` và `?sort=`, ignore `utm_*` (không dùng) | Response giống nhau cho mọi tracking variant — nhưng app không kiểm soát cache key |
| **CDN (Varnish)** | Quyết định cache key từ URL | **Đây là nơi duy nhất** có thể strip tracking params trước khi hash |

Nếu app server được gọi với `?utm_source=...`, nó vẫn xử lý bình thường và trả về kết quả. Vấn đề là CDN coi mỗi URL khác nhau là một object khác nhau. App không thể tự "nói" với CDN rằng "hãy ignore utm_*".

### 3.2. Những thứ có thể sai ở CDN layer

| Vấn đề | Nguyên nhân khả dĩ |
| --- | --- |
| Tracking params làm vỡ cache | VCL `vcl_hash` không strip tracking params trước khi hash URL |
| Business params bị strip | VCL strip quá aggressive — xóa cả `sort`, `filter`, `page` |
| Normalization order sai | Strip tracking params nhưng không sort lại remaining params → `?q=shoe&sort=price` vs `?sort=price&q=shoe` tạo 2 key khác nhau |
| Chỉ strip `utm_*` mà quên `fbclid`/`gclid` | Danh sách tracking params không đầy đủ |
| Normalization không áp dụng khi có variant headers | Cache key kết hợp URL đã normalize + variant headers bị sai |

### 3.3. Tác động đến hệ thống nếu không phát hiện

| Vấn đề | Hậu quả kinh doanh |
| --- | --- |
| Cache fragmentation do tracking | Hit rate giảm từ 95% xuống 30-40% cho search traffic. Origin bị quá tải. |
| Business params bị ignore | User chọn `sort=price` nhưng nhận cache của `sort=newest` → UX sai. |
| Normalization không nhất quán | CDN và app có cache key khác nhau → purge/ban không hoạt động đúng. |

---

## 4. Topology và precondition

### 4.1. Runtime topology

```text
┌─────────┐     ┌──────────────┐     ┌───────┐     ┌─────────────────┐
│  k6     │────▶│  Varnish CDN │────▶│ Nginx │────▶│  App            │
│  client │     │  :80         │     │       │     │  Microservices  │
└─────────┘     └──────────────┘     └───────┘     └─────────────────┘
                       │
                       │ control plane
                       ▼
                ┌──────────────┐
                │  Control     │
                │  :8088       │──▶ ban prefix
                └──────────────┘
```

Khác với case 03 (không cần control plane), case 04 **bắt buộc** có control plane cho `setup()`:

- `setup()` gọi `POST /ops/app/cdn/cache/ban` với prefix `/api/sim/products/search` để xóa toàn bộ cache object dưới search prefix.
- Điều này cần `OPS_AUTH_TOKEN` được set đúng.

### 4.2. Precondition

| Điều kiện | Mô tả | Cách xác nhận |
| --- | --- | --- |
| Stack full | `TargetLayer=full` — Varnish + Nginx + App | `curl http://localhost:80/api/sim/products/search?q=shoe` trả về 200 |
| Control plane sẵn sàng | `:8088` chấp nhận request với token hợp lệ | `curl -H "Authorization: Bearer $OPS_AUTH_TOKEN" http://localhost:8088/ops/app/cdn/cache/ban` trả về 200 |
| OPS token được set | `OPS_AUTH_TOKEN` hoặc `OPS_TOKEN` có giá trị | Script fail với message nếu thiếu |
| Search endpoint hoạt động | App trả về kết quả tìm kiếm cho `?q=shoe` | Response JSON chứa mảng products |

### 4.3. Setup: banPrefix

```javascript
export function setup() {
  banPrefix(paths.searchPrefix);
  // paths.searchPrefix = '/api/sim/products/search'
}
```

Hàm `banPrefix` trong shared.js:

```javascript
export function banPrefix(prefix) {
  const res = controlRequest(
    'POST',
    '/ops/app/cdn/cache/ban',
    { prefix },
    { scenario: 'cdn_capability', control: 'ban_prefix' }
  );
  assertStatus(res, 200, `ban-prefix ${prefix}`);
  return res;
}
```

Khác biệt giữa ban và purge:

| Operation | Endpoint | Scope | Dùng cho |
| --- | --- | --- | --- |
| `banPrefix(prefix)` | `POST /ops/app/cdn/cache/ban` `{prefix}` | Tất cả object có URL bắt đầu bằng prefix | Xóa toàn bộ search cache trước proof |
| `purgeUrl(url)` | `POST /ops/app/cdn/cache/purge` `{url}` | Một object chính xác (exact URL + variant) | Xóa một product detail cụ thể |
| `banUrl(url)` | `POST /ops/app/cdn/cache/ban-url` `{url}` | Tất cả variant của một URL | Xóa mọi phiên bản ngôn ngữ/geo của product |

### 4.4. Không cần teardown

Case này không có `teardown()`. Sau khi script chạy xong, cache sẽ có:
- 1 object canonical (`?q=shoe` với profile guestUSDesktopControl)
- 1 object business param (`?q=shoe&sort=price` với cùng profile)

Các object này không ảnh hưởng đến case khác vì mỗi case có profile hoặc path khác nhau. Tuy nhiên, nếu chạy lại case 04, `setup()` sẽ ban prefix và xóa sạch.

---

## 5. Script deep-dive

### 5.1. Cấu trúc file

```javascript
import {
  paths,               // Object chứa các path mẫu
  profiles,            // Object chứa các profile variant
  banPrefix,           // Hàm xóa cache theo prefix (control plane)
  requestCdn,          // Hàm gửi request qua CDN public path
  assertCacheKeyHeaders, // Hàm kiểm tra cache key headers đúng expected
  assertCacheState,    // Hàm kiểm tra X-Cache state (HIT/MISS)
  assertStatus,        // Hàm kiểm tra HTTP status code
  expectedCacheKey,    // Hàm tính expected cache key từ profile
} from './shared.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
  tags: {
    scenario: 'cdn_query_normalization',
  },
};
```

### 5.2. Options breakdown

| Option | Giá trị | Lý do |
| --- | --- | --- |
| `vus` | `1` | Deterministic sequence — 1 VU tuần tự kiểm tra cache state chain |
| `iterations` | `1` | Mỗi VU chạy 1 lần default function |
| `thresholds.checks` | `['rate==1']` | Tất cả checks phải pass |
| `tags.scenario` | `'cdn_query_normalization'` | Tag để phân biệt trong dashboard/cloud output |

### 5.3. `expectedCacheKey` — cách tính cache key từ profile

```javascript
export function expectedCacheKey(profile) {
  const headers = profile ? profile.headers : {};
  const language = ((headers['Accept-Language'] || 'en').trim().slice(0, 2).toLowerCase() || 'en');
  return {
    language: ['vi', 'en', 'ja'].includes(language) ? language : 'en',
    geo: normalizeGeo(headers['X-Geo-Country']),
    device: normalizeDevice(headers['X-Device-Class']),
    ab: normalizeAB(headers['X-Ab-Variant']),
    segment: normalizeSegment(headers['X-User-Segment']),
  };
}
```

Với `profiles.guestUSDesktopControl`:

| Input header | Raw value | Normalized |
| --- | --- | --- |
| `Accept-Language` | `en` | `en` (2 ký tự đầu, lowercase) |
| `X-Geo-Country` | `US` | `US` (uppercase, whitelist: SG/US/JP, default VN) |
| `X-Device-Class` | `desktop` | `desktop` (lowercase, whitelist: mobile/tablet/desktop, default desktop) |
| `X-Ab-Variant` | `control` | `control` (lowercase, whitelist: variant-a/variant-b, default control) |
| `X-User-Segment` | `guest` | `guest` (lowercase, whitelist: new_user/returning/vip, default guest) |

Kết quả `expectedCacheKey(profiles.guestUSDesktopControl)`:

```javascript
{
  language: 'en',
  geo: 'US',
  device: 'desktop',
  ab: 'control',
  segment: 'guest',
}
```

### 5.4. Hàm `assertCacheKeyHeaders` — cách kiểm tra

```javascript
export function assertCacheKeyHeaders(res, expected, label, options = {}) {
  const withDevice = options.withDevice !== false;
  const withAB = options.withAB !== false;
  const withSegment = options.withSegment === true;  // Mặc định FALSE
  check(res, {
    [`${label} cache language ${expected.language}`]: (r) => getHeader(r, 'X-Cache-Key-Language') === expected.language,
    [`${label} cache geo ${expected.geo}`]: (r) => getHeader(r, 'X-Cache-Key-Geo') === expected.geo,
    [`${label} cache device ${expected.device}`]: (r) => !withDevice || getHeader(r, 'X-Cache-Key-Device') === expected.device,
    [`${label} cache ab ${expected.ab}`]: (r) => !withAB || getHeader(r, 'X-Cache-Key-AB') === expected.ab,
    [`${label} cache segment ${expected.segment}`]: (r) => !withSegment || getHeader(r, 'X-Cache-Key-Segment') === expected.segment,
  });
}
```

Lưu ý: `withSegment` mặc định là `false` — segment không được kiểm tra trừ khi explicit set `withSegment: true`. Case 04 không set `withSegment: true`, nên chỉ kiểm tra 4/5 cache key headers (language, geo, device, AB).

### 5.5. Default function — toàn bộ flow

```javascript
export default function () {
  const profile = profiles.guestUSDesktopControl;
  const expected = expectedCacheKey(profile);
  const trackedPath =
    '/api/sim/products/search?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123';
  const businessParamPath = '/api/sim/products/search?q=shoe&sort=price';

  // Bước 1: Canonical request — MISS rồi HIT
  const canonicalFirst = requestCdn('GET', paths.search, {
    profile,
    tags: { case: 'canonical_first' },
  });
  assertStatus(canonicalFirst, 200, 'canonical first');
  assertCacheState(canonicalFirst, 'MISS', 'canonical first');
  assertCacheKeyHeaders(canonicalFirst, expected, 'canonical first');

  const canonicalSecond = requestCdn('GET', paths.search, {
    profile,
    tags: { case: 'canonical_second' },
  });
  assertStatus(canonicalSecond, 200, 'canonical second');
  assertCacheState(canonicalSecond, 'HIT', 'canonical second');
  assertCacheKeyHeaders(canonicalSecond, expected, 'canonical second');

  // Bước 2: Tracked request với tracking params — phải HIT canonical
  const tracked = requestCdn('GET', trackedPath, {
    profile,
    tags: { case: 'tracked_query' },
  });
  assertStatus(tracked, 200, 'tracked query');
  assertCacheState(tracked, 'HIT', 'tracked query');
  assertCacheKeyHeaders(tracked, expected, 'tracked query');

  // Bước 3: Business param request — MISS (key mới) rồi HIT
  const businessFirst = requestCdn('GET', businessParamPath, {
    profile,
    tags: { case: 'business_param_first' },
  });
  assertStatus(businessFirst, 200, 'business param first');
  assertCacheState(businessFirst, 'MISS', 'business param first');
  assertCacheKeyHeaders(businessFirst, expected, 'business param first');

  const businessSecond = requestCdn('GET', businessParamPath, {
    profile,
    tags: { case: 'business_param_second' },
  });
  assertStatus(businessSecond, 200, 'business param second');
  assertCacheState(businessSecond, 'HIT', 'business param second');
  assertCacheKeyHeaders(businessSecond, expected, 'business param second');
}
```

### 5.6. Phân tích từng bước

#### 5.6.1. Bước 1: Canonical request (path: `?q=shoe`)

```text
canonical_first:
  path: /api/sim/products/search?q=shoe
  profile: guestUSDesktopControl
  expected: MISS (lần đầu, cache trống sau ban)
  cache key headers: { language: 'en', geo: 'US', device: 'desktop', ab: 'control' }

canonical_second:
  path: /api/sim/products/search?q=shoe
  profile: guestUSDesktopControl
  expected: HIT (lấy từ cache của canonical_first)
  cache key headers: giống canonical_first
```

Điểm quan trọng: `paths.search` = `'/api/sim/products/search?q=shoe'` — đây chính là canonical URL sau khi strip tất cả tracking params. Đây là "dạng thuần khiết" của search query.

#### 5.6.2. Bước 2: Tracked request (path: `?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123`)

```text
tracked:
  path: /api/sim/products/search?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123
  profile: guestUSDesktopControl
  expected: HIT (vì tracking params bị strip → cache key trùng canonical)
  cache key headers: giống canonical
```

Đây là **trọng tâm của proof**: Mặc dù URL có thêm 3 tracking parameters (`utm_source`, `fbclid`, `gclid`), cache key sau khi normalize giống hệt canonical `?q=shoe`. Request trả về HIT và cache key headers giống canonical.

#### 5.6.3. Bước 3: Business param request (path: `?q=shoe&sort=price`)

```text
business_first:
  path: /api/sim/products/search?q=shoe&sort=price
  profile: guestUSDesktopControl
  expected: MISS (sort=price là business param → cache key mới)
  cache key headers: giống canonical (cùng profile)

business_second:
  path: /api/sim/products/search?q=shoe&sort=price
  profile: guestUSDesktopControl
  expected: HIT (lấy từ cache của business_first)
  cache key headers: giống
```

Điểm quan trọng: Business param `sort=price` được giữ trong cache key, khiến cache key khác với canonical `?q=shoe`. Do đó request trả về MISS (object chưa có trong cache). Lần 2 trả về HIT (object vừa được warm).

### 5.7. Chuỗi cache state mong đợi

```text
canonical_first   ──▶ MISS  (warm canonical object)
canonical_second  ──▶ HIT   (serve từ canonical cache)
tracked           ──▶ HIT   (tracking params stripped → same key as canonical)
business_first    ──▶ MISS  (sort=price → different cache key from canonical)
business_second   ──▶ HIT   (serve từ business param cache)
```

---

## 6. Cache key model / VCL deep-dive

### 6.1. VCL flow cho query normalization

```vcl
sub vcl_recv {
  // ... bypass checks (Authorization, Cookie, method) ...

  // Query normalization
  set req.url = normalize_query(req.url);

  // ... cache key construction ...
}

sub vcl_hash {
  hash_data(req.url);                    // URL đã normalize
  hash_data(req.http.X-Hash-Language);   // Language variant
  hash_data(req.http.X-Hash-Geo);        // Geo variant
  hash_data(req.http.X-Hash-Device);     // Device variant
  hash_data(req.http.X-Hash-AB);         // AB variant
  // (segment optional — chỉ hash khi cần)
}
```

### 6.2. Hàm normalize query — pseudo-code

```javascript
// Pseudo-code của VCL query normalization
function normalize_query(url) {
  // 1. Parse URL
  const [path, queryString] = url.split('?');

  // 2. Parse query params
  const params = new URLSearchParams(queryString);

  // 3. Xóa tracking params
  const TRACKING_PARAMS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'dclid', 'msclkid',
    'ref', 'referrer', 'source',
    '_ga', '_gl', '_gcl_aw', '_gcl_dc',
  ];
  for (const param of TRACKING_PARAMS) {
    params.delete(param);
  }

  // 4. Sort alphabetically remaining params
  params.sort();

  // 5. Reconstruct URL
  const normalizedQuery = params.toString();
  return normalizedQuery ? `${path}?${normalizedQuery}` : path;
}
```

### 6.3. Ví dụ normalization

| Input URL | Sau khi strip tracking | Sau khi sort | Cache key URL |
| --- | --- | --- | --- |
| `/search?q=shoe` | `?q=shoe` | `?q=shoe` | `/search?q=shoe` |
| `/search?q=shoe&utm_source=fb&fbclid=abc` | `?q=shoe` | `?q=shoe` | `/search?q=shoe` |
| `/search?q=shoe&sort=price` | `?q=shoe&sort=price` | `?q=shoe&sort=price` | `/search?q=shoe&sort=price` |
| `/search?sort=price&q=shoe` | `?sort=price&q=shoe` | `?q=shoe&sort=price` | `/search?q=shoe&sort=price` |
| `/search?q=shoe&utm_source=fb&sort=price&fbclid=abc` | `?q=shoe&sort=price` | `?q=shoe&sort=price` | `/search?q=shoe&sort=price` |

### 6.4. Tại sao sorting quan trọng

Nếu không sort lại params sau khi strip tracking, thứ tự params có thể tạo ra cache key khác nhau cho cùng một nội dung:

```text
Không sort:
  /search?q=shoe&sort=price ──▶ hash("/search?q=shoe&sort=price") ──▶ cache key A
  /search?sort=price&q=shoe ──▶ hash("/search?sort=price&q=shoe") ──▶ cache key B
  => 2 cache object khác nhau cho cùng nội dung!

Có sort:
  /search?q=shoe&sort=price ──▶ normalize_sort ──▶ hash("/search?q=shoe&sort=price") ──▶ cache key A
  /search?sort=price&q=shoe ──▶ normalize_sort ──▶ hash("/search?q=shoe&sort=price") ──▶ cache key A
  => 1 cache object
```

### 6.5. Cache key composition

Cache key cho search endpoint = `hash(normalized_url + language + geo + device + AB)`:

```text
Cache key = md5(
  "/api/sim/products/search?q=shoe" +  // normalized URL (no tracking params)
  "en" +                               // language from Accept-Language
  "US" +                               // geo from X-Geo-Country
  "desktop" +                          // device from X-Device-Class
  "control"                            // AB variant from X-Ab-Variant
)
```

Tracking request `?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123` sau khi normalize có URL giống hệt canonical, nên cache key giống hệt — giải thích tại sao tracked request trả về HIT.

### 6.6. Phân biệt tracking param và business param trong VCL

```vcl
sub normalize_query {
  // Cách đơn giản: whitelist business params, xóa mọi thứ khác
  // Chỉ giữ lại các param trong danh sách KNOWN_BUSINESS_PARAMS
  set req.http.X-Normalized-Query = "";
  // ... logic parse query, giữ q, sort, filter, page, limit ...
}

// HOẶC: blacklist tracking params (phổ biến hơn)
sub normalize_query {
  // Xóa các param đã biết là tracking
  // Giữ lại TẤT CẢ param khác (an toàn hơn — không vô tình xóa business param mới)
}
```

### 6.7. Bảng tổng hợp VCL decision

| URL pattern | VCL action | Cache key | Kết quả |
| --- | --- | --- | --- |
| `?q=shoe` | Strip: không có tracking param | `hash(url + variants)` | Object canonical |
| `?q=shoe&utm_source=X&fbclid=Y` | Strip: `utm_source`, `fbclid` | `hash("/search?q=shoe" + variants)` — giống canonical | HIT canonical |
| `?q=shoe&sort=price` | Strip: không có tracking param. Keep: `sort` (business). Sort: `q`, `sort` | `hash("/search?q=shoe&sort=price" + variants)` — khác canonical | Object mới |
| `?q=shoe&sort=price&utm_source=X` | Strip: `utm_source`. Keep: `sort`. Sort: `q`, `sort` | `hash("/search?q=shoe&sort=price" + variants)` — giống business | HIT business |

---

## 7. Request sequence flow (timeline)

### 7.1. Timeline tổng thể

```text
Time ───────────────────────────────────────────────────▶

[setup]: ban prefix /api/sim/products/search ──▶ 200

[default]:
  t0: canonical first ──▶ MISS (warm canonical)
  t1: canonical second ──▶ HIT (proof: canonical cacheable)
  t2: tracked query ──▶ HIT (proof: tracking params stripped)
  t3: business first ──▶ MISS (proof: business param = new key)
  t4: business second ──▶ HIT (proof: business param cacheable)
```

### 7.2. Timeline chi tiết

```text
Client                    CDN (Varnish)              Origin
  │                          │                            │
  │── [setup phase] ─────────│                            │
  │                          │                            │
  │── POST /ops/app/cdn/cache/ban ──▶ (control:8088)    │
  │   { prefix: "/api/sim/products/search" }            │
  │◀── 200 OK ──────────────│                            │
  │                          │                            │
  │── [default phase] ───────│                            │
  │                          │                            │
  │── GET /search?q=shoe ───▶│                            │
  │   profile: US/desktop/en │                            │
  │                          │── vcl_recv: normalize      │
  │                          │   URL: /search?q=shoe      │
  │                          │── vcl_hash: hash(URL+var)  │
  │                          │── lookup: MISS             │
  │                          │── backend request ────────▶│
  │                          │◀── 200 OK ────────────────│
  │                          │── store in cache           │
  │                          │── vcl_deliver: X-Cache=MISS│
  │◀── 200, X-Cache:MISS ───│                            │
  │                          │                            │
  │── GET /search?q=shoe ───▶│                            │
  │   (giống hệt lần 1)      │                            │
  │                          │── vcl_hash: same key       │
  │                          │── lookup: HIT!             │
  │                          │── vcl_deliver: X-Cache=HIT │
  │◀── 200, X-Cache:HIT ────│                            │
  │                          │                            │
  │── GET /search?q=shoe     │                            │
  │   &utm_source=lesson     │                            │
  │   &fbclid=abc123         │                            │
  │   &gclid=paid123 ───────▶│                            │
  │                          │── vcl_recv: normalize      │
  │                          │   strip: utm_source,       │
  │                          │   fbclid, gclid            │
  │                          │   URL: /search?q=shoe      │
  │                          │── vcl_hash: SAME key!      │
  │                          │── lookup: HIT!             │
  │◀── 200, X-Cache:HIT ────│                            │
  │                          │                            │
  │── GET /search?q=shoe     │                            │
  │   &sort=price ──────────▶│                            │
  │                          │── vcl_recv: normalize      │
  │                          │   strip: (none)            │
  │                          │   sort: q, sort            │
  │                          │   URL: /search?q=shoe      │
  │                          │         &sort=price        │
  │                          │── vcl_hash: DIFFERENT key  │
  │                          │── lookup: MISS             │
  │                          │── backend request ────────▶│
  │                          │◀── 200 OK ────────────────│
  │                          │── store in cache           │
  │◀── 200, X-Cache:MISS ───│                            │
  │                          │                            │
  │── GET /search?q=shoe     │                            │
  │   &sort=price ──────────▶│                            │
  │                          │── vcl_hash: same business  │
  │                          │   key (vừa warm)           │
  │                          │── lookup: HIT!             │
  │◀── 200, X-Cache:HIT ────│                            │
```

### 7.3. Cache key evolution qua các bước

```text
Cache storage state:

Sau ban:        {}                                          (trống)
Sau canonical_first:
                { "hash(/search?q=shoe|en|US|desktop|control)": object_A }
Sau canonical_second:
                { ... object_A (không thay đổi) }
Sau tracked:
                { ... object_A (tracked query HIT object_A) }
Sau business_first:
                { ... object_A,
                  "hash(/search?q=shoe&sort=price|en|US|desktop|control)": object_B }
Sau business_second:
                { ... object_A, object_B (không thay đổi) }
```

---

## 8. Key signals / headers cần verify

### 8.1. Bảng tín hiệu chính

| Request | Path | Status | `X-Cache` | Cache key headers | Signal |
| --- | --- | --- | --- | --- | --- |
| `canonical_first` | `/search?q=shoe` | 200 | **MISS** | language:`en` geo:`US` device:`desktop` ab:`control` | Warm canonical |
| `canonical_second` | `/search?q=shoe` | 200 | **HIT** | language:`en` geo:`US` device:`desktop` ab:`control` | Canonical cached |
| `tracked_query` | `/search?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123` | 200 | **HIT** | language:`en` geo:`US` device:`desktop` ab:`control` | **Tracking stripped** |
| `business_param_first` | `/search?q=shoe&sort=price` | 200 | **MISS** | language:`en` geo:`US` device:`desktop` ab:`control` | **Business = new key** |
| `business_param_second` | `/search?q=shoe&sort=price` | 200 | **HIT** | language:`en` geo:`US` device:`desktop` ab:`control` | Business cached |

### 8.2. Cấu trúc checks

Tổng cộng: **20 checks** (mỗi request 4 checks: status + cache state + 2 cache key header checks = 4, thực tế nhiều hơn do `assertCacheKeyHeaders` tạo 4 checks cho language, geo, device, ab).

```text
canonical_first:  1 (status) + 1 (cache:MISS) + 4 (cache key) = 6 checks
canonical_second: 1 (status) + 1 (cache:HIT) + 4 (cache key) = 6 checks
tracked_query:    1 (status) + 1 (cache:HIT) + 4 (cache key) = 6 checks
business_first:   1 (status) + 1 (cache:MISS) + 4 (cache key) = 6 checks
business_second:  1 (status) + 1 (cache:HIT) + 4 (cache key) = 6 checks
─────────────────────────────────────────────────────────────
Total: 30 checks
```

### 8.3. Signal interpretation matrix

| `X-Cache` | Cache key = canonical | URL có tracking params | Kết luận |
| --- | --- | --- | --- |
| `MISS` | Có | Không | Bình thường — warm canonical |
| `HIT` | Có | Không | Bình thường — canonical đã cache |
| `HIT` | Có | Có | **PASS** — tracking params bị strip đúng |
| `MISS` | Có | Có | **FAIL** — tracking params không bị strip (cache key khác canonical) |
| `MISS` | Có | Có (business) | **PASS** — business param tạo key mới |
| `HIT` | Có | Có (business) | **FAIL** — business param bị strip sai (key trùng canonical) |

### 8.4. Cache key headers invariants

Với cùng profile `guestUSDesktopControl`, tất cả 5 request (dù URL khác nhau) đều phải trả về cache key headers giống nhau:

```text
X-Cache-Key-Language: en
X-Cache-Key-Geo: US
X-Cache-Key-Device: desktop
X-Cache-Key-AB: control
```

Điều này chứng minh cache key variant (headers) không bị ảnh hưởng bởi query string.

---

## 9. Pass/fail criteria

### 9.1. Điều kiện PASS

```text
TẤT CẢ các điều kiện sau đồng thời đúng:

1. k6 exit code = 0 (threshold checks đạt 100%)
2. 30/30 named checks pass
3. setup: ban prefix trả về 200
4. canonical_first: MISS, canonical_second: HIT (baseline working)
5. tracked_query: HIT (PROOF: tracking params không phá cache)
6. business_first: MISS (PROOF: business param tạo cache key riêng)
7. business_second: HIT (PROOF: business param cache hoạt động)
8. Tất cả request có cache key headers giống nhau (cùng profile)
```

### 9.2. Điều kiện FAIL

| # | Dấu hiệu FAIL | Ý nghĩa | Hành động khắc phục |
| --- | --- | --- | --- |
| F1 | `tracked_query` = MISS | Tracking params không bị strip → cache fragmentation | Cập nhật danh sách tracking params trong VCL |
| F2 | `business_first` = HIT | Business param bị strip quá aggressive → sai nội dung | Điều chỉnh whitelist/blacklist trong VCL |
| F3 | `canonical_second` = MISS | Canonical không được cache → cache layer không hoạt động | Kiểm tra cache headers từ origin (case 07) |
| F4 | Cache key headers thay đổi giữa các request | Profile không được áp dụng nhất quán | Kiểm tra VCL header normalization |
| F5 | Setup ban prefix fail | Control plane không sẵn sàng hoặc token sai | Kiểm tra OPS_AUTH_TOKEN |
| F6 | Bất kỳ request nào status != 200 | App search endpoint lỗi | Kiểm tra app log |
| F7 | canonical_first = HIT | Cache chưa được clean trước khi chạy | Kiểm tra setup ban prefix có hoạt động không |

### 9.3. Phân biệt FALSE PASS

| Kịch bản | Tại sao có thể PASS giả | Cách phát hiện |
| --- | --- | --- |
| Chạy khi cache đã warm canonical từ trước | canonical_first = HIT (thay vì MISS) | Nếu canonical_first = HIT, check vẫn pass (status 200, cache key đúng) — nhưng cache state sai ⇒ tổng checks fail vì `assertCacheState(canonicalFirst, 'MISS')` |
| Chạy khi tracking params trùng canonical do app ignore params | tracked MISS dù CDN không strip | Không thể phát hiện từ CDN layer — cần kiểm tra app access log |
| Chạy với profile không có variant | Cache key headers đơn giản hơn, dễ pass hơn | So sánh với expectedCacheKey |
