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

##### Phân tích executor: vì sao dùng `per-vu-iterations` cho case này?

Config hiện tại dùng bare form `vus` + `iterations` — với `vus=1, iterations=1`,
k6 tự động chọn `per-vu-iterations`. Đây là lựa chọn ĐÚNG cho CDN query
normalization.

**Yêu cầu của case:**

```text
1. Deterministic sequence: query params khác nhau tạo cache key khác nhau
   → Cần kiểm tra TUẦN TỰ: warm base → HIT base → query variant MISS → HIT
   → Trình tự request QUYẾT ĐỊNH kết quả test
   → KHÔNG phải sustained traffic, KHÔNG cần nhiều VU

2. 1 VU, 1 iteration: toàn bộ kịch bản trong 1 lần chạy default()
   → Setup làm warm, default() gọi từng bước kiểm tra tuần tự
   → Số request deterministic, không phụ thuộc response time
```

**So sánh executor:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **per-vu-iterations** (đang dùng) | ✅ **ĐÚNG** | 1 VU chạy đúng 1 iteration. Sequence tuần tự chuẩn xác. Đây là correctness proof, không phải load test. |
| shared-iterations | ⚠️ Được (kết quả giống) | Với `vus=1`, shared và per-vu cho cùng output. Nhưng semantic khác: shared ngụ ý "kho chung", case này là "1 người làm 1 việc". |
| constant-vus | ❌ SAI | Cần duration. Case này không biết trước thời gian — mỗi step có sleep/wait khác nhau. `duration` có thể cắt ngang giữa chừng. |
| constant-arrival-rate | ❌ SAI | Ép rate cố định. Case này không cần rate — mỗi step phải đợi step trước hoàn thành. Thêm complexity thừa. |
| ramping-vus | ❌ SAI | Cần stage. 1 VU ổn định, không ramp. |

**Key insight**: CDN correctness test = "làm đúng 1 lần, đủ các bước, tuần tự".
Không phải "làm nhiều lần trong X giây". `per-vu-iterations` với `vus=1,
iterations=1` là pattern chuẩn cho mọi CDN correctness proof.

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

---

## 10. Cách chạy + output mẫu

### 10.1. Lệnh chạy

```powershell
cd E:\Projects\k6\k6-metrics-server\load-target

$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

k6 run .\k6\cdn\04-query-normalization.js
```

Hoặc dùng runner script:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scripts\run-cdn-capabilities.ps1 -Scenarios 04-query-normalization
```

### 10.2. Output mẫu -- PASS

```text

         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: .\k6\cdn\04-query-normalization.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations shared among 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)


running (00m00.2s), 0/1 VUs, 1 complete and 0 interrupted iterations
default   [   0%] 0 VUs  00m00.2s/10m0s

running (00m00.4s), 1/1 VUs, 1 complete and 0 interrupted iterations
default   [ 100%] 1 VUs  00m00.4s/10m0s  1/1 shared iters

     █ setup
       ✓ ban-prefix /api/sim/products/search status 200

     █ canonical_first
       ✓ canonical first status 200
       ✓ canonical first cache state MISS
       ✓ canonical first cache language en
       ✓ canonical first cache geo US
       ✓ canonical first cache device desktop
       ✓ canonical first cache ab control

     █ canonical_second
       ✓ canonical second status 200
       ✓ canonical second cache state HIT
       ✓ canonical second cache language en
       ✓ canonical second cache geo US
       ✓ canonical second cache device desktop
       ✓ canonical second cache ab control

     █ tracked_query
       ✓ tracked query status 200
       ✓ tracked query cache state HIT
       ✓ tracked query cache language en
       ✓ tracked query cache geo US
       ✓ tracked query cache device desktop
       ✓ tracked query cache ab control

     █ business_param_first
       ✓ business param first status 200
       ✓ business param first cache state MISS
       ✓ business param first cache language en
       ✓ business param first cache geo US
       ✓ business param first cache device desktop
       ✓ business param first cache ab control

     █ business_param_second
       ✓ business param second status 200
       ✓ business param second cache state HIT
       ✓ business param second cache language en
       ✓ business param second cache geo US
       ✓ business param second cache device desktop
       ✓ business param second cache ab control

     ✓ checks.........................: 100.00%  ✓ 31  ✗ 0
     data_received....................: 8.5 kB   42 kB/s
     data_sent........................: 2.4 kB   12 kB/s
     http_req_blocked.................: avg=1.87ms  min=1.21ms med=1.65ms  max=3.8ms   p(90)=3.12ms  p(95)=3.46ms
     http_req_duration................: avg=17.3ms  min=12.8ms med=16.5ms  max=24.1ms  p(90)=22.3ms  p(95)=23.2ms
     http_reqs........................: 6        30/s
     iteration_duration..............: avg=245.12ms min=245.12ms med=245.12ms max=245.12ms p(90)=245.12ms p(95)=245.12ms
     iterations.......................: 1        5/s
     vus..............................: 1        min=1 max=1


All checks passed
```

### 10.3. Output mẫu -- FAIL (tracking params không bị strip)

```text
     █ canonical_first
       ✓ canonical first status 200
       ✓ canonical first cache state MISS
       ✓ canonical first cache language en
       ✓ canonical first cache geo US
       ✓ canonical first cache device desktop
       ✓ canonical first cache ab control

     █ canonical_second
       ✓ canonical second status 200
       ✓ canonical second cache state HIT
       ✓ canonical second cache language en
       ✓ canonical second cache geo US
       ✓ canonical second cache device desktop
       ✓ canonical second cache ab control

     █ tracked_query
       ✓ tracked query status 200
       ✗ tracked query cache state HIT      <-- FAIL: expected HIT, got MISS
       ✓ tracked query cache language en
       ✓ tracked query cache geo US
       ✓ tracked query cache device desktop
       ✓ tracked query cache ab control

     ✓ checks.........................: 96.77%   ✓ 30  ✗ 1

ERRO[0003] thresholds on metrics 'checks' have been crossed
```

Trong output này: canonical MISS -> HIT bình thường. Nhưng tracked query trả về MISS thay vì HIT -- chứng tỏ CDN không strip `utm_source`/`fbclid`/`gclid`, dẫn đến cache key khác canonical. Cache fragmentation đang xảy ra.

### 10.4. Output mẫu -- FAIL (business param bị strip quá aggressive)

```text
     █ business_param_first
       ✓ business param first status 200
       ✗ business param first cache state MISS   <-- FAIL: expected MISS, got HIT
       ✓ business param first cache language en
       ✓ business param first cache geo US
       ✓ business param first cache device desktop
       ✓ business param first cache ab control

     ✓ checks.........................: 96.77%   ✓ 30  ✗ 1
```

Trong output này: business param request trả về HIT thay vì MISS -- chứng tỏ CDN đã strip `sort=price` (coi nó như tracking param), khiến cache key trùng canonical. Đây là lỗi over-normalization: người dùng yêu cầu sắp xếp theo giá nhưng nhận cache của kết quả mặc định.

---

## 11. 4 output -> decision scenarios

### 11.1. Scenario A: Tất cả PASS (lý tưởng)

| Quan sát | Giá trị |
| --- | --- |
| Exit code | `0` |
| Checks | 31/31 ✓ (hoặc 30/30 tùy version) |
| Canonical sequence | MISS -> HIT |
| Tracked query | HIT |
| Business sequence | MISS -> HIT |

**Quyết định**: CDN query normalization hoạt động chính xác. Tracking params bị strip đúng, business params được giữ đúng. Triển khai production với confidence cao cho search endpoints.

### 11.2. Scenario B: Tracking params vẫn MISS

| Quan sát | Giá trị |
| --- | --- |
| Exit code | `≠ 0` |
| canonical | MISS -> HIT (OK) |
| tracked | MISS (FAIL) |
| business | MISS -> HIT (OK) |

**Quyết định**: Danh sách tracking params trong VCL thiếu `utm_source`, `fbclid`, hoặc `gclid`. Cần cập nhật VCL `normalize_query`:

```vcl
// Thêm vào danh sách strip
if (req.url ~ "[?&](utm_source|utm_medium|utm_campaign|utm_term|utm_content|fbclid|gclid|dclid|msclkid)=") {
  set req.url = regsuball(req.url, "[?&](utm_source|utm_medium|utm_campaign|utm_term|utm_content|fbclid|gclid|dclid|msclkid)=[^&]*", "");
}
```

### 11.3. Scenario C: Business params HIT canonical

| Quan sát | Giá trị |
| --- | --- |
| Exit code | `≠ 0` |
| canonical | MISS -> HIT (OK) |
| tracked | HIT (OK) |
| business_first | HIT (FAIL -- mong đợi MISS) |

**Quyết định**: VCL normalization quá aggressive -- đang strip `sort` hoặc các business param khác cùng với tracking params. Cần chuyển từ "whitelist approach" (chỉ giữ param đã biết) sang "blacklist approach" (chỉ xóa param đã biết là tracking). Hoặc cập nhật whitelist để bao gồm `sort`, `filter`, `page`, `limit`, `q`.

### 11.4. Scenario D: Canonical không cache được

| Quan sát | Giá trị |
| --- | --- |
| Exit code | `≠ 0` |
| canonical_second | MISS (FAIL -- mong đợi HIT) |
| Các request sau | Tất cả MISS |

**Quyết định**: Cache layer không hoạt động hoặc origin không trả về cache headers phù hợp. Không phải vấn đề query normalization -- cần kiểm tra case 01 (HIT smoke) và case 07 (cache contract) trước khi debug case 04.

---

## 12. Nghịch lý / misconceptions

### 12.1. Nghịch lý 1: "Tất cả query params nên được giữ lại để an toàn"

**Lầm tưởng**: Không nên strip bất kỳ param nào -- mỗi URL khác nhau là một tài nguyên khác nhau. CDN nên cache chính xác những gì client yêu cầu.

**Sự thật**: HTTP spec cho phép CDN normalize URL trước khi cache. Các tracking params như `utm_source`, `fbclid`, `gclid` được thêm bởi bên thứ ba (marketing platform) và **không ảnh hưởng đến response từ server**. Giữ chúng trong cache key là cache fragmentation vô ích. Varnish khuyến nghị strip chúng:

```text
"HTTP aware caching proxies such as Varnish will... potentially normalize the URL 
before storing it in cache." — Varnish docs on cache variations
```

### 12.2. Nghịch lý 2: "Sorting params sau khi strip là không cần thiết"

**Lầm tưởng**: Sau khi strip tracking params, URL đã "đủ sạch" -- không cần sort lại thứ tự params.

**Sự thật**: Nếu không sort, `?q=shoe&sort=price` và `?sort=price&q=shoe` tạo ra 2 cache object khác nhau cho cùng nội dung. Mặc dù cả hai đều không có tracking params, thứ tự params khác nhau dẫn đến cache key khác nhau. Sorting đảm bảo canonical form.

### 12.3. Nghịch lý 3: "Chỉ cần strip params ở VCL, không cần quan tâm app"

**Lầm tưởng**: CDN strip tracking params là đủ -- app không cần biết về chúng.

**Sự thật**: App vẫn cần nhất quán với CDN:

| Vấn đề | Nếu app không đồng bộ |
| --- | --- |
| **Internal redirect** | App redirect `?utm_source=x` thành `?sort=price` -- CDN strip `utm_source` nhưng cache key từ URL gốc không khớp redirect target |
| **Canonical URL trong HTML** | App render `<link rel="canonical">` với tracking params -- CDN cache phiên bản canonical, browser thấy URL khác |
| **Sitemap** | Sitemap chứa URL có tracking params -- search engine index URL tracking, CDN cache canonical |

### 12.4. Nghịch lý 4: "Tracking params list là cố định -- chỉ có UTM, FBCLID, GCLID"

**Lầm tưởng**: Danh sách tracking params không thay đổi theo thời gian.

**Sự thật**: Mỗi marketing platform thêm param riêng:

| Platform | Param | Thời điểm xuất hiện |
| --- | --- | --- |
| Google Ads | `gclid` | Luôn có |
| Google Analytics 4 | `_gl`, `_ga` | GA4 migration |
| Facebook | `fbclid` | Luôn có |
| Microsoft Ads | `msclkid` | 2021+ |
| DoubleClick | `dclid` | Legacy |
| HubSpot | `hsa_*` | Tùy integration |
| Marketo | `mkt_tok` | Tùy integration |

Cần review và cập nhật danh sách tracking params định kỳ. Tốt hơn: dùng whitelist approach (chỉ giữ business params đã biết) để tự động chặn tracking params mới.

### 12.5. Nghịch lý 5: "Query normalization chỉ áp dụng cho search endpoint"

**Lầm tưởng**: Query params chỉ quan trọng cho search API -- các endpoint khác (product detail, category) không có query params phức tạp.

**Sự thật**: Tracking params có thể xuất hiện trên **bất kỳ URL nào**:

```text
Không có normalization:
  /products/1?utm_source=email                    ──▶ Cache object riêng (lãng phí)
  /products/1                                      ──▶ Cache object riêng
  /categories?utm_source=fb&fbclid=abc            ──▶ Cache object riêng (lãng phí)
  /categories                                      ──▶ Cache object riêng
```

Query normalization nên được áp dụng toàn cục trong `vcl_recv`, không chỉ cho search path. Nếu không, mọi endpoint có thể bị cache fragmentation do tracking params.

---

## 13. Checklist trước khi chạy

### 13.1. Topology checklist

```text
[ ] TargetLayer = full (Varnish + Nginx + App)
[ ] localhost:80 trả về response có X-Cache header
[ ] localhost:80/api/sim/products/search?q=shoe trả về 200
[ ] localhost:8088 chấp nhận request POST với OPS token
[ ] CATALOG_EVENTS_BASE_URL = http://localhost:9091 (dù case này không dùng)
```

### 13.2. Env checklist

```text
[ ] BASE_URL = "http://localhost:80" (REQUIRED - phải qua Varnish)
[ ] CONTROL_BASE_URL = "http://localhost:8088" (REQUIRED - cần cho ban prefix)
[ ] OPS_AUTH_TOKEN được set (REQUIRED - cần cho control plane)
[ ] Token có quyền POST /ops/app/cdn/cache/ban
```

### 13.3. Pre-run validation

```text
[ ] Chạy case 01 PASS trước — xác nhận cache hoạt động
[ ] Chạy case 02 PASS trước — xác nhận cache key variant hoạt động
[ ] Kiểm tra search endpoint thủ công:
    curl -H "Accept-Language: en" \
         -H "X-Geo-Country: US" \
         -H "X-Device-Class: desktop" \
         -H "X-Ab-Variant: control" \
         -H "X-User-Segment: guest" \
         "http://localhost:80/api/sim/products/search?q=shoe"
    → 200, X-Cache header present
[ ] Xác nhận ban prefix hoạt động:
    curl -X POST \
         -H "Authorization: Bearer $env:OPS_AUTH_TOKEN" \
         -H "Content-Type: application/json" \
         -d '{"prefix":"/api/sim/products/search"}' \
         "http://localhost:8088/ops/app/cdn/cache/ban"
    → 200
```

### 13.4. Post-run checklist

```text
[ ] k6 exit code = 0
[ ] checks = 100.00% (30 hoặc 31 checks tùy version)
[ ] canonical_first = MISS
[ ] canonical_second = HIT
[ ] tracked_query = HIT (ĐÂY LÀ TRỌNG TÂM)
[ ] business_param_first = MISS (ĐÂY LÀ TRỌNG TÂM)
[ ] business_param_second = HIT
[ ] Tất cả cache key headers = {language:en, geo:US, device:desktop, ab:control}
[ ] Không có dòng "ERRO" trong output
```

---

## 14. 4-5 Variations với code mẫu

### 14.1. Variation 1: Test với nhiều tracking params platform khác nhau

Script gốc chỉ test 3 tracking params (`utm_source`, `fbclid`, `gclid`). Variation này mở rộng cho nhiều platform hơn.

```javascript
export default function () {
  const profile = profiles.guestUSDesktopControl;
  const expected = expectedCacheKey(profile);

  // Warm canonical
  warmCanonical(profile, expected);

  // Test từng platform tracking param riêng biệt
  const trackingTests = [
    { label: 'google_ads', params: 'gclid=EAIaIQobChMI' },
    { label: 'facebook', params: 'fbclid=IwAR123abc' },
    { label: 'microsoft', params: 'msclkid=abc123def456' },
    { label: 'doubleclick', params: 'dclid=CM-wx7u8pNcCFQUIaAod' },
    { label: 'hubspot', params: 'hsa_acc=12345&hsa_cam=67890&hsa_grp=11111' },
    { label: 'all_combined', params: 'utm_source=email&utm_medium=newsletter&utm_campaign=sale&fbclid=abc&gclid=xyz&msclkid=def' },
  ];

  for (const test of trackingTests) {
    const trackedPath = `${paths.searchPrefix}?q=shoe&${test.params}`;
    const res = requestCdn('GET', trackedPath, {
      profile,
      tags: { case: `tracked_${test.label}` },
    });
    assertStatus(res, 200, `tracked ${test.label}`);
    assertCacheState(res, 'HIT', `tracked ${test.label}`);
    assertCacheKeyHeaders(res, expected, `tracked ${test.label}`);
  }
}

function warmCanonical(profile, expected) {
  const first = requestCdn('GET', paths.search, {
    profile,
    tags: { case: 'canonical_warm' },
  });
  // Warm đủ để canonical có trong cache
}
```

### 14.2. Variation 2: Test với nhiều business params

```javascript
export default function () {
  const profile = profiles.guestUSDesktopControl;
  const expected = expectedCacheKey(profile);

  // Warm canonical
  const canonical = requestCdn('GET', paths.search, { profile, tags: { case: 'canonical' } });

  // Mỗi business param KHÁC NHAU phải tạo cache key riêng
  const businessTests = [
    { label: 'sort_price', params: 'sort=price' },
    { label: 'sort_newest', params: 'sort=newest' },
    { label: 'page_2', params: 'page=2' },
    { label: 'filter_brand', params: 'filter=brand:nike' },
    { label: 'combined', params: 'sort=price&page=1&filter=brand:adidas' },
  ];

  for (const test of businessTests) {
    const path = `${paths.searchPrefix}?q=shoe&${test.params}`;
    const first = requestCdn('GET', path, {
      profile,
      tags: { case: `${test.label}_first` },
    });
    assertStatus(first, 200, `${test.label} first`);
    assertCacheState(first, 'MISS', `${test.label} first`);
    assertCacheKeyHeaders(first, expected, `${test.label} first`);

    const second = requestCdn('GET', path, {
      profile,
      tags: { case: `${test.label}_second` },
    });
    assertStatus(second, 200, `${test.label} second`);
    assertCacheState(second, 'HIT', `${test.label} second`);
    assertCacheKeyHeaders(second, expected, `${test.label} second`);
  }
}
```

### 14.3. Variation 3: Test param order independence

```javascript
// Chứng minh rằng thứ tự params không ảnh hưởng đến cache key
const profile = profiles.guestUSDesktopControl;
const expected = expectedCacheKey(profile);

const base = requestCdn('GET', '/api/sim/products/search?q=shoe&sort=price&page=1', {
  profile,
  tags: { case: 'order_base' },
});
assertCacheState(base, 'MISS', 'order base');

const reversed = requestCdn('GET', '/api/sim/products/search?page=1&sort=price&q=shoe', {
  profile,
  tags: { case: 'order_reversed' },
});
assertCacheState(reversed, 'HIT', 'order reversed');
// HIT chứng tỏ URL đã được sort -> cache key giống base

const withTracking = requestCdn('GET',
  '/api/sim/products/search?utm_source=fb&q=shoe&fbclid=abc&sort=price&page=1&gclid=xyz', {
  profile,
  tags: { case: 'order_with_tracking' },
});
assertCacheState(withTracking, 'HIT', 'order with tracking');
// HIT chứng tỏ sau khi strip tracking + sort, cache key giống base
```

### 14.4. Variation 4: Test cross-profile với cùng query

```javascript
export default function () {
  // Mỗi profile KHÁC NHAU tạo cache key khác nhau, NGAY CẢ khi query giống nhau
  const profiles_to_test = [
    { profile: profiles.guestUSDesktopControl, label: 'us_desktop_en' },
    { profile: profiles.guestVNMobileControl, label: 'vn_mobile_vi' },
  ];

  for (const { profile, label } of profiles_to_test) {
    const expected = expectedCacheKey(profile);

    const first = requestCdn('GET', paths.search, {
      profile,
      tags: { case: `${label}_first` },
    });
    assertCacheState(first, 'MISS', `${label} first`);
    assertCacheKeyHeaders(first, expected, `${label} first`);

    const second = requestCdn('GET', paths.search, {
      profile,
      tags: { case: `${label}_second` },
    });
    assertCacheState(second, 'HIT', `${label} second`);
  }
}
```

### 14.5. Variation 5: Dùng origin request counter để verify

```javascript
import { resetOriginRequestCounts, getOriginRequestCounts, findOriginRequestCount } from './shared.js';

export function setup() {
  banPrefix(paths.searchPrefix);
  resetOriginRequestCounts();
}

export default function () {
  const profile = profiles.guestUSDesktopControl;
  const expected = expectedCacheKey(profile);

  // ... canonical warm ...

  // Sau khi warm canonical, origin count cho search endpoint = 1
  const counts1 = getOriginRequestCounts();
  const searchReqs1 = findOriginRequestCount(counts1, 'GET/search');
  // searchReqs1 phải = 1 (chỉ canonical_first gọi origin)

  // Gửi tracked query
  const tracked = requestCdn('GET', '/api/sim/products/search?q=shoe&utm_source=fb&fbclid=abc', {
    profile,
    tags: { case: 'tracked' },
  });
  assertCacheState(tracked, 'HIT', 'tracked');

  // Origin count KHÔNG tăng vì tracked query HIT cache
  const counts2 = getOriginRequestCounts();
  const searchReqs2 = findOriginRequestCount(counts2, 'GET/search');
  // searchReqs2 vẫn phải = 1 (tracked query không gọi origin)
}
```

---

## 15. Anti-patterns

### 15.1. Anti-pattern 1: Strip tất cả query params (kể cả business)

```text
SAI:
  sub normalize_query {
    set req.url = regsub(req.url, "\?.*$", "");
    // Xóa TOÀN BỘ query string!
  }
```

**Vấn đề**: Mọi request `/search?q=shoe&sort=price` trở thành `/search`. User không thể sắp xếp kết quả vì cache trả về object đầu tiên được cache. Business logic bị phá hủy.

**Cách đúng**: Dùng blacklist tracking params cụ thể, hoặc whitelist business params.

### 15.2. Anti-pattern 2: Chỉ strip khi URL khớp pattern cụ thể

```text
SAI:
  if (req.url ~ "^/api/sim/products/search") {
    set req.url = normalize_query(req.url);
  }
```

**Vấn đề**: Tracking params có thể xuất hiện trên bất kỳ URL nào (product detail, category, homefeed). Chỉ normalize search path để lộ các endpoint khác.

**Cách đúng**: Áp dụng normalization toàn cục trong `vcl_recv`, trước khi cache key được tính.

### 15.3. Anti-pattern 3: Không test với URL đã encode

```text
SAI: Chỉ test với query params ASCII thuần túy
  /search?q=shoe&utm_source=facebook
```

**Vấn đề**: URL trong thực tế có thể được encode:
- `/search?q=gi%C3%A0y&utm_source=facebook` (giày được encode)
- `/search?q=shoe&utm_campaign=flash%20sale` (space được encode)
- `/search?q=shoe&utm_source=fb&fbclid=abc%3D%3D` (base64 padding)

VCL normalization phải xử lý được URL encoded params.

```javascript
// Variation test cho URL encoded params
const encodedPath = '/api/sim/products/search?q=shoe&utm_source=fb&utm_campaign=flash%20sale';
const res = requestCdn('GET', encodedPath, { profile, tags: { case: 'encoded_tracking' } });
assertCacheState(res, 'HIT', 'encoded tracking');
```

### 15.4. Anti-pattern 4: Dùng regex "quá rộng" để strip params

```text
SAI:
  set req.url = regsuball(req.url, "[?&][a-zA-Z0-9_]+=[^&]*", "");
  // Xóa MỌI param — kể cả q, sort, filter!
```

**Vấn đề**: Regex match mọi param. Sau khi strip, URL mất tất cả query.

**Cách đúng**: Dùng regex với alternation của tracking param names cụ thể:

```text
set req.url = regsuball(req.url, 
  "[?&](utm_source|utm_medium|utm_campaign|utm_term|utm_content|fbclid|gclid|dclid|msclkid|ref|referrer|source)=[^&]*", 
  "");
```

### 15.5. Anti-pattern 5: Không xử lý edge case "chỉ có tracking params"

```text
URL: /search?utm_source=fb&fbclid=abc
Sau khi strip: /search?
hoặc: /search (nếu clean trailing ?)
```

Nếu không clean trailing `?` hoặc `&`, cache key có thể chứa ký tự thừa. Cần test edge case này:

```javascript
const onlyTrackingPath = '/api/sim/products/search?utm_source=fb&fbclid=abc';
const res = requestCdn('GET', onlyTrackingPath, { profile, tags: { case: 'only_tracking' } });
assertCacheState(res, 'HIT', 'only tracking');
// Phải HIT canonical /search?q=shoe (nếu đã warm) hoặc ít nhất không crash
```

### 15.6. Anti-pattern 6: Bypass case 04 vì "app cũng ignore tracking params"

```text
SAI:
  "App của tôi không dùng utm_source nên response giống nhau.
   Không cần CDN normalize — app tự lo."
```

**Vấn đề**: Mặc dù app ignore tracking params và response giống nhau, CDN vẫn coi mỗi URL là một cache key khác nhau. Cache fragmentation xảy ra ở CDN layer, không phải app layer. App không thể "nói" cho CDN biết param nào là tracking — chỉ VCL mới làm được.

---

## 16. Real validation data

### 16.1. Request/response mẫu -- canonical

**Request canonical first:**
```http
GET /api/sim/products/search?q=shoe HTTP/1.1
Host: localhost:80
Accept: application/json
Accept-Language: en
X-Geo-Country: US
X-Device-Class: desktop
X-Ab-Variant: control
X-User-Segment: guest
```

**Response canonical first:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Cache: MISS
X-Cache-Key-Language: en
X-Cache-Key-Geo: US
X-Cache-Key-Device: desktop
X-Cache-Key-AB: control

{"products": [...], "total": 42, "query": "shoe"}
```

**Response canonical second:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Cache: HIT
X-Cache-Key-Language: en
X-Cache-Key-Geo: US
X-Cache-Key-Device: desktop
X-Cache-Key-AB: control

{"products": [...], "total": 42, "query": "shoe"}
```

### 16.2. Request/response mẫu -- tracked query HIT canonical

**Request:**
```http
GET /api/sim/products/search?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123 HTTP/1.1
Host: localhost:80
Accept: application/json
Accept-Language: en
X-Geo-Country: US
X-Device-Class: desktop
X-Ab-Variant: control
X-User-Segment: guest
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Cache: HIT
X-Cache-Key-Language: en
X-Cache-Key-Geo: US
X-Cache-Key-Device: desktop
X-Cache-Key-AB: control

{"products": [...], "total": 42, "query": "shoe"}
```

Lưu ý: `X-Cache: HIT` dù URL có `utm_source`, `fbclid`, `gclid`. Response body và cache key headers giống hệt canonical. Đây là bằng chứng tracking params đã bị strip, cache key trùng canonical.

### 16.3. Request/response mẫu -- business param MISS

**Request business first:**
```http
GET /api/sim/products/search?q=shoe&sort=price HTTP/1.1
Host: localhost:80
Accept: application/json
Accept-Language: en
X-Geo-Country: US
X-Device-Class: desktop
X-Ab-Variant: control
X-User-Segment: guest
```

**Response business first:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Cache: MISS
X-Cache-Key-Language: en
X-Cache-Key-Geo: US
X-Cache-Key-Device: desktop
X-Cache-Key-AB: control

{"products": [...], "total": 15, "query": "shoe", "sort": "price"}
```

Lưu ý: `X-Cache: MISS` -- đây là cache key mới, KHÁC canonical. Response body có `total: 15` (khác với canonical `total: 42`), chứng tỏ `sort=price` tạo kết quả khác.

**Response business second:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Cache: HIT
X-Cache-Key-Language: en
X-Cache-Key-Geo: US
X-Cache-Key-Device: desktop
X-Cache-Key-AB: control

{"products": [...], "total": 15, "query": "shoe", "sort": "price"}
```

### 16.4. Bảng so sánh response -- 3 loại request

| Thuộc tính | Canonical (lần 2) | Tracked (utm+fbclid+gclid) | Business sort=price (lần 2) |
| --- | --- | --- | --- |
| URL request | `/search?q=shoe` | `/search?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123` | `/search?q=shoe&sort=price` |
| URL sau normalize | `/search?q=shoe` | `/search?q=shoe` | `/search?q=shoe&sort=price` |
| `X-Cache` | `HIT` | `HIT` | `HIT` |
| Cache key = canonical? | Có (chính nó) | **Có** (normalized) | **Không** (business param) |
| `total` trong response | 42 | 42 | 15 |
| Origin được gọi? | Không | Không | Không (đã warm) |

### 16.5. Latency comparison

| Request type | Lần 1 (ms) | Lần 2 (ms) | Chênh lệch |
| --- | --- | --- | --- |
| Canonical | ~18ms (MISS) | ~3ms (HIT) | HIT nhanh hơn ~6x |
| Tracked | ~3ms (HIT canonical) | N/A | Bằng canonical HIT |
| Business | ~18ms (MISS) | ~3ms (HIT) | HIT nhanh hơn ~6x |

Tracked query lần đầu tiên đã là HIT (vì canonical đã warm), nên latency ~3ms -- nhanh hơn nhiều so với nếu phải gọi origin. Đây là lợi ích trực tiếp của query normalization: user từ ad campaign nhận response nhanh như user trực tiếp.

---

## 17. Reference

### 17.1. Source code

| File | Path |
| --- | --- |
| Script | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\04-query-normalization.js` |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` |
| Common utilities | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json` |
| Scenario README | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md` |

### 17.2. Documents

| Document | Path |
| --- | --- |
| CDN Overview | `E:\Khoa hoc\k6\docs\practice\cdn\00_overview.md` |
| Case 01 (HIT smoke) | `E:\Khoa hoc\k6\docs\practice\cdn\01_hit-smoke.md` |
| Case 02 (Variant keys) | `E:\Khoa hoc\k6\docs\practice\cdn\02_variant-keys.md` |
| Case 03 (Bypass rules) | `E:\Khoa hoc\k6\docs\practice\cdn\03_bypass-rules.md` |
| Run guide | `E:\Khoa hoc\k6\docs\practice\cdn\RUN_GUIDE.md` |

### 17.3. External references

| Resource | URL / Description |
| --- | --- |
| Varnish `vcl_hash` docs | `https://varnish-cache.org/docs/trunk/reference/vcl.html#hash` |
| Varnish URL normalization best practices | `https://info.varnish-software.com/blog/normalizing-urls-in-varnish` |
| Google UTM parameters | `https://support.google.com/analytics/answer/1033863` |
| Facebook `fbclid` documentation | `https://developers.facebook.com/docs/marketing-api/click-id/` |
| Microsoft `msclkid` documentation | `https://help.ads.microsoft.com/apex/index/3/en/60000` |
| RFC 3986 — URI Generic Syntax | `https://datatracker.ietf.org/doc/html/rfc3986` |
| RFC 7234 — HTTP Caching (Section 4: Cache Key) | `https://datatracker.ietf.org/doc/html/rfc7234` |

### 17.4. Related cases

```text
cdn-01-hit-smoke              ──▶ Hiểu baseline cache HIT trước khi test normalization
cdn-02-variant-keys           ──▶ Cache key dimensions (headers) — normalization áp dụng cho cả URL và headers
cdn-03-bypass-rules           ──▶ Bypass rules (ngược lại: request không được cache)
cdn-05-invalidation-ops       ──▶ Purge/ban object — cần normalize URL trước khi gửi invalidation command
cdn-07-cache-contract         ──▶ Origin cache headers (Cache-Control) — response vẫn phải có cache headers dù URL được normalize
```

### 17.5. Ghi chú về interoperability

Query normalization trong CDN phải đồng bộ với:

| Component | Yêu cầu đồng bộ |
| --- | --- |
| **App server** | App không nên redirect dựa trên tracking params, không nhúng tracking params vào canonical URL |
| **Control plane** | Khi purge/ban URL, phải dùng URL đã normalize (không có tracking params) hoặc control plane cũng normalize trước khi gửi lệnh |
| **CDN log/analytics** | Log URL gốc (trước normalize) cho analytics, nhưng cache với URL đã normalize |
| **Sitemap / SEO** | Sitemap dùng canonical URL (không có tracking params) |
| **Client-side analytics** | JavaScript analytics vẫn đọc tracking params từ `window.location.search` — không bị ảnh hưởng bởi CDN normalization |
