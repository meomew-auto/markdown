# Case 01: Cache HIT smoke

> **Case ID:** `cdn-01-hit-smoke` | **Script:** `01-hit-smoke.js` | **Layer:** CDN / Varnish
> **Proof:** MISS -> HIT cho product detail anonymous read

---

## 1. Tình huống thực tế

### 1.1. Bối cảnh kinh doanh

Một trang thương mại điện tử có hàng triệu người dùng truy cập mỗi ngày. Trang chi tiết sản phẩm (`/products/1`) là một trong những endpoint được gọi nhiều nhất. Người dùng liên tục xem đi xem lại cùng một sản phẩm trong một phiên mua sắm — họ mở tab mới, nhấn back, refresh trang, hoặc đơn giản là quay lại sản phẩm đó vài phút sau khi đã xem vài sản phẩm khác.

Nếu mỗi lần người dùng xem sản phẩm đều phải gọi xuống origin server, chi phí infrastructure sẽ tăng tuyến tính với traffic. Tệ hơn, origin server trở thành điểm nghẽn: khi có flash sale hoặc chiến dịch marketing lớn, hàng trăm nghìn người cùng xem một sản phẩm cùng lúc có thể làm sập toàn bộ hệ thống backend.

Đây là bài toán kinh điển mà mọi hệ thống CDN được thiết kế để giải quyết: **đọc nhiều, ghi ít, dữ liệu ít thay đổi trong khoảng thời gian ngắn**.

### 1.2. Ngữ cảnh người dùng

Trong case này, người dùng là **anonymous shopper** (khách vãng lai chưa đăng nhập) đang duyệt sản phẩm trên điện thoại từ Việt Nam. Họ không có session cookie, không có auth token, và tất cả request đều là GET read-only. Đây là loại traffic "dễ cache nhất" và cũng là traffic chiếm tỷ trọng lớn nhất trong tổng lượng request của một site thương mại điện tử.

### 1.3. Câu hỏi kiểm tra cốt lõi

> **Khi một anonymous user gọi GET product detail lần đầu tiên, CDN có cache object đó không? Và lần thứ hai gọi cùng URL với cùng variant headers, CDN có trả về từ cache (HIT) không?**

Nếu câu trả lời là "có" cho cả hai, hệ thống đã vượt qua smoke test cơ bản nhất của CDN layer. Nếu không, mọi thứ phức tạp hơn (variant keys, invalidation, TTL...) đều vô nghĩa vì nền tảng cơ bản nhất đã không hoạt động.

---

## 2. CDN capability được chứng minh

### 2.1. Capability chính

Case này chứng minh **hai capability nền tảng** của CDN/Varnish:

| # | Capability | Mô tả | Cách chứng minh |
|---|-----------|-------|-----------------|
| 1 | **Cache fill (MISS -> store)** | Object được fetch từ origin và lưu vào cache sau MISS đầu tiên | Request 1: `X-Cache: MISS` -> status 200 -> object được lưu |
| 2 | **Cache serve (HIT)** | Object đã cache được phục vụ trực tiếp không qua origin | Request 2+: `X-Cache: HIT` -> status 200 -> không gọi origin |

### 2.2. Capability phụ được xác nhận gián tiếp

| Capability | Cách xác nhận |
|-----------|---------------|
| **Cache key normalization** | `X-Cache-Key-Language`, `X-Cache-Key-Geo`, `X-Cache-Key-Device`, `X-Cache-Key-AB` khớp với giá trị expected từ profile |
| **Upstream routing** | `X-Upstream-Service: products-service` xác nhận request đi đúng service |
| **Sustained HIT stability** | default function chạy liên tục trong 18 giây, mỗi request đều trả HIT |
| **Ban URL invalidation** | Setup gọi `ban-url` trước khi warm để đảm bảo trạng thái cache sạch |

### 2.3. Tại sao capability này là nền tảng

Cache HIT là atomic unit của mọi CDN test. Mọi case phức tạp hơn (variant keys, TTL, stale, coalescing) đều xây dựng trên nền tảng MISS/HIT cơ bản. Nếu case 01 fail, không case nào khác có thể pass một cách có ý nghĩa — vì tất cả đều dựa trên giả định cache hoạt động.

---

## 3. Vì sao phải test ở CDN layer

### 3.1. Phân biệt với application layer cache

Application layer cache (như Redis, Memcached, hoặc in-memory cache trong app) hoạt động khác biệt về bản chất:

| Khía cạnh | CDN/Varnish cache | Application cache |
|-----------|-------------------|-------------------|
| **Vị trí** | Edge, trước khi request vào app | Bên trong app, sau khi request đã vào |
| **Phạm vi** | Shared cache cho mọi user | Có thể là private hoặc shared |
| **Key** | URL + variant headers | Thường là key tự định nghĩa trong code |
| **Invalidation** | Purge/Ban qua control plane | TTL expire hoặc code-level delete |
| **Header contract** | `X-Cache`, `Cache-Control`, `s-maxage` | Không có header contract chuẩn |
| **Lợi ích chính** | Giảm tải origin, giảm latency | Giảm tải database, tăng tốc compute |

Test ở CDN layer là bắt buộc vì:
1. **Bạn không thể giả lập CDN behavior bằng app cache** — Varnish có VCL riêng, cache key model riêng, và control plane riêng.
2. **Header contract là public** — `X-Cache`, `X-Cache-Key-*` là những header mà CDN trả về cho client, và client (hoặc lớp trung gian khác) có thể dựa vào chúng.
3. **Control plane là tách biệt** — Purge/ban qua `:8088` không liên quan gì đến app code.

### 3.2. Hậu quả nếu không test ở CDN layer

- **False confidence**: App test pass (trả 200) nhưng CDN không cache -> production vẫn bị origin quá tải.
- **Header mismatch**: App trả `Cache-Control: private` nhưng developer không biết -> CDN không cache dù app test "thấy 200".
- **Key collision**: CDN cache key khác với key developer tưởng tượng -> cache leak giữa các tenant/user.

---

## 4. Topology và precondition

### 4.1. Sơ đồ topology

```text
                      PUBLIC PATH (port 80)
                      =====================
k6 client ──> http://localhost:80 ──> Varnish CDN ──> Nginx ──> products-service
                                          │
                                          │ cache storage
                                          │ (in-memory / file)
                                          │
                      CONTROL PATH (port 8088)
                      =======================
k6 client ──> http://localhost:8088 ──> app control plane
                                          │
                                          ├── POST /ops/app/cdn/cache/ban-url
                                          ├── POST /ops/app/cdn/cache/purge
                                          ├── GET  /ops/app/cdn/origin/request-counts
                                          └── PATCH /ops/app/cdn/origin/profile
```

### 4.2. Required topology

```text
requiredTargetLayer = full
BASE_URL              = http://localhost:80
CONTROL_BASE_URL      = http://localhost:8088
CATALOG_EVENTS_BASE_URL = http://localhost:9091
OPS_AUTH_TOKEN        = <ops-token>
```

Target layer phải là `full` vì case cần Varnish CDN chạy thật trên port 80. Nếu chạy với `TargetLayer=app`, request sẽ đi thẳng vào Nginx mà không qua Varnish, và `X-Cache` header sẽ không tồn tại — toàn bộ test trở nên vô nghĩa.

### 4.3. Precondition trước khi chạy

| # | Điều kiện | Cách kiểm tra | Nếu không thỏa |
|---|-----------|---------------|----------------|
| 1 | `localhost:80` có Varnish đang chạy | `curl -I http://localhost:80/api/sim/products/1` phải có `X-Cache` header | Case không thể pass |
| 2 | `localhost:8088` có control plane | `curl http://localhost:8088/ops/app/cdn/origin/profile` trả JSON | Setup phase fail |
| 3 | `OPS_AUTH_TOKEN` hợp lệ | Control API trả 200, không phải 401/403 | Ban URL fail, cache state không sạch |
| 4 | `products-service` healthy | Origin health check pass | MISS request trả 503 |
| 5 | Không có object nào trong cache trước khi chạy | Setup gọi `ban-url` để clear | Kết quả HIT/MISS có thể sai |

### 4.4. Cơ chế setup trong script

Script không dùng `setup()` để kiểm tra precondition một cách thụ động. Thay vào đó, `setup()` **chủ động thiết lập trạng thái ban đầu**:

1. **Bước 1 — Ban URL**: Gọi `banUrl(paths.productDetail)` để xóa mọi object đang cache cho path `/api/sim/products/1`. Điều này đảm bảo không có HIT "bẩn" từ lần chạy trước.
2. **Bước 2 — Warm request (MISS)**: Gọi GET lần đầu tiên, expected `X-Cache: MISS`. Đây vừa là verification rằng ban đã hoạt động, vừa là cache fill.
3. **Bước 3 — Verify HIT**: Gọi GET lần thứ hai với cùng profile, expected `X-Cache: HIT`. Đây là proof rằng object đã được cache.

---

## 5. Script deep-dive

### 5.1. Tổng quan cấu trúc

Script `01-hit-smoke.js` gồm 4 phần chính:

```text
01-hit-smoke.js
├── Imports & environment knobs (dòng 1-8)
├── options block (dòng 10-20)
├── setup() function (dòng 22-47)
└── default function (dòng 49-63)
```

### 5.2. Phần 1: Imports và environment knobs

```javascript
import { sleep } from 'k6';
import { envFloat, envInt, envString } from '../shared/common.js';
import { paths, profiles, expectedCacheKey, banUrl, requestCdn, assertCacheKeyHeaders, assertCacheState, assertStatus, assertUpstream } from './shared.js';

const HIT_SMOKE_VUS = envInt('HIT_SMOKE_VUS', 4);
const HIT_SMOKE_DURATION = envString('HIT_SMOKE_DURATION', '18s');
const HIT_SMOKE_SLEEP_SECONDS = envFloat('HIT_SMOKE_SLEEP_SECONDS', 0.025);
```

**Phân tích từng dòng:**

| Dòng | Thành phần | Mục đích |
|------|-----------|----------|
| 1 | `import { sleep } from 'k6'` | Hàm `sleep()` để tạo pause giữa các iteration trong default function |
| 2 | `envFloat, envInt, envString` | Helper đọc biến môi trường với default value và type coercion |
| 4 | `paths, profiles, expectedCacheKey, banUrl, requestCdn` | Import từ `shared.js` — toàn bộ CDN helper library |
| 4 | `assertCacheKeyHeaders, assertCacheState, assertStatus, assertUpstream` | Import assertion helpers từ `shared.js` |
| 6 | `HIT_SMOKE_VUS` | Số VU chạy song song, default `4` — đủ để tạo sustained traffic nhưng không quá cao gây nhiễu |
| 7 | `HIT_SMOKE_DURATION` | Thời gian chạy default function, default `18s` |
| 8 | `HIT_SMOKE_SLEEP_SECONDS` | Sleep giữa các iteration, default `0.025s` (~40 req/s/VU) |

**Thiết kế env knobs:**

Mỗi tham số đều có thể override qua biến môi trường. Điều này cho phép:
- **CI pipeline**: Tăng duration để test stability lâu hơn
- **Debug cục bộ**: Giảm VUs xuống 1 để dễ đọc log
- **Stress test nhẹ**: Tăng VUs để kiểm tra cache vẫn HIT dưới concurrent load

### 5.3. Phần 2: options block

```javascript
export const options = {
  vus: HIT_SMOKE_VUS,
  duration: HIT_SMOKE_DURATION,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
  tags: {
    scenario: 'cdn_hit_smoke',
  },
};
```

**Phân tích chi tiết:**

| Field | Giá trị | Ý nghĩa |
|-------|---------|---------|
| `vus` | `4` | 4 virtual users chạy song song. Đủ để test concurrent HIT mà không gây race condition |
| `duration` | `'18s'` | default function chạy trong 18 giây. Setup và teardown không tính vào duration này |
| `thresholds.checks` | `['rate==1']` | **Cứng** — mọi check phải pass. Một check fail duy nhất -> k6 exit code khác 0 |
| `thresholds.http_req_failed` | `['rate==0']` | **Cứng** — không được có bất kỳ HTTP error nào (5xx, timeout, connection refused) |
| `tags.scenario` | `'cdn_hit_smoke'` | Tag để phân biệt metrics của case này trong dashboard/report |

**Tại sao `checks: ['rate==1']` là quan trọng:**

Trong CDN test, "pass" không phải là "không có lỗi HTTP". Một request hoàn toàn có thể trả về status 200 nhưng fail check vì `X-Cache` sai. Threshold `checks: ['rate==1']` đảm bảo rằng:
- Nếu một request trả HIT thay vì MISS -> check fail -> threshold fail -> k6 exit 1
- Nếu cache key header không khớp expected -> check fail -> k6 exit 1
- Nếu upstream service sai -> check fail -> k6 exit 1

### 5.4. Phần 3: setup() function

```javascript
export function setup() {
  const profile = profiles.guestVNMobileControl;
  const expected = expectedCacheKey(profile);

  banUrl(paths.productDetail);

  const first = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'detail_first' },
  });
  assertStatus(first, 200, 'first detail request');
  assertUpstream(first, 'products-service', 'first detail request');
  assertCacheState(first, 'MISS', 'first detail request');
  assertCacheKeyHeaders(first, expected, 'first detail request');

  const second = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'detail_second' },
  });
  assertStatus(second, 200, 'second detail request');
  assertUpstream(second, 'products-service', 'second detail request');
  assertCacheState(second, 'HIT', 'second detail request');
  assertCacheKeyHeaders(second, expected, 'second detail request');

  return { profile, expected };
}
```

**Sequence diagram của setup():**

```text
setup() bắt đầu
  │
  ├─ [1] Chọn profile: guestVNMobileControl
  │     headers: { Accept-Language: vi, X-Geo-Country: VN,
  │                X-Device-Class: mobile, X-Ab-Variant: control,
  │                X-User-Segment: guest }
  │
  ├─ [2] Tính expected cache key:
  │     { language: vi, geo: VN, device: mobile, ab: control }
  │
  ├─ [3] POST :8088/ops/app/cdn/cache/ban-url
  │     body: { url: "/api/sim/products/1" }
  │     -> Xóa mọi object đang cache cho URL này
  │
  ├─ [4] GET :80/api/sim/products/1 (lần 1 - "first")
  │     headers: guestVNMobileControl headers
  │     ├── assertStatus 200
  │     ├── assertUpstream products-service
  │     ├── assertCacheState MISS          ← key assertion: phải MISS
  │     └── assertCacheKeyHeaders matches {vi, VN, mobile, control}
  │
  ├─ [5] GET :80/api/sim/products/1 (lần 2 - "second")
  │     headers: giống hệt lần 1
  │     ├── assertStatus 200
  │     ├── assertUpstream products-service
  │     ├── assertCacheState HIT           ← key assertion: phải HIT
  │     └── assertCacheKeyHeaders matches {vi, VN, mobile, control}
  │
  └─ [6] return { profile, expected }
         -> data được truyền vào default function
```

**Tại sao setup() warm 2 lần thay vì 1 lần:**

Một số người hỏi: "Tại sao không warm 1 lần rồi để default function verify HIT?" Câu trả lời là:

1. **Tách biệt proof và sustained test**: Setup chứng minh toàn bộ chuỗi MISS -> HIT trong môi trường controlled (single-VU, deterministic). Default function chỉ cần verify sustained HIT.
2. **Fail fast**: Nếu cache không hoạt động, setup fail ngay lập tức — không cần đợi 18 giây default function chạy xong mới biết.
3. **Return data**: `setup()` return `{ profile, expected }` để default function dùng lại mà không cần tính toán lại.

### 5.5. Phần 4: default function

```javascript
export default function (data) {
  const profile = data?.profile || profiles.guestVNMobileControl;
  const expected = data?.expected || expectedCacheKey(profile);

  const res = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'detail_sustained_hit' },
  });
  assertStatus(res, 200, 'sustained detail request');
  assertUpstream(res, 'products-service', 'sustained detail request');
  assertCacheState(res, 'HIT', 'sustained detail request');
  assertCacheKeyHeaders(res, expected, 'sustained detail request');

  sleep(HIT_SMOKE_SLEEP_SECONDS);
}
```

**Cơ chế hoạt động của default function:**

```text
default function chạy trong 18 giây, 4 VUs song song
Mỗi VU thực hiện vòng lặp:
  │
  ├─ [1] Nhận data từ setup() (fallback nếu data null)
  ├─ [2] GET :80/api/sim/products/1 với profile guestVNMobileControl
  ├─ [3] Assert status 200
  ├─ [4] Assert upstream = products-service
  ├─ [5] Assert X-Cache = HIT            ← key: sustained HIT
  ├─ [6] Assert cache key headers
  ├─ [7] sleep(0.025s) = 25ms
  └─ Quay lại [2]

Tổng số request ~= 4 VUs × (18s / 0.025s) ≈ 2,880 requests
Tất cả đều phải HIT.
```

**Tại sao cần sustained HIT test:**

- **Warmup artifact detection**: Một số CDN implementation có TTL rất ngắn mặc định. Nếu object expire sau 5 giây, sustained test sẽ bắt được vì một trong các request sẽ MISS thay vì HIT.
- **Memory pressure**: Dưới sustained load, CDN có thể evict object nếu memory đầy. 2,880 request là đủ để phát hiện eviction bất thường.
- **Concurrency correctness**: 4 VUs song song gọi cùng một key — đảm bảo không có race condition trong cache lookup.

### 5.6. Hàm helper `requestCdn` — trace một request hoàn chỉnh

Để hiểu rõ mỗi request đi qua những gì, đây là trace của `requestCdn` trong `shared.js`:

```text
requestCdn('GET', '/api/sim/products/1', { profile, tags })
  │
  ├─> buildHeaders(profile, {})
  │     └─> { Accept: 'application/json',
  │           Accept-Language: 'vi',
  │           X-Geo-Country: 'VN',
  │           X-Device-Class: 'mobile',
  │           X-Ab-Variant: 'control',
  │           X-User-Segment: 'guest' }
  │
  ├─> http.request('GET', 'http://localhost:80/api/sim/products/1',
  │                 null, { headers, tags })
  │
  └─> Response object trả về:
        {
          status: 200,
          headers: {
            'X-Cache': 'HIT',
            'X-Cache-Key-Language': 'vi',
            'X-Cache-Key-Geo': 'VN',
            'X-Cache-Key-Device': 'mobile',
            'X-Cache-Key-AB': 'control',
            'X-Upstream-Service': 'products-service',
            'Content-Type': 'application/json',
            ...
          },
          body: '{"id":1,"name":"...","price":...}',
          ...
        }
```

---

## 6. Cache key model / VCL deep-dive

### 6.1. Cache key là gì

Cache key là định danh duy nhất mà CDN dùng để tra cứu object trong cache storage. Nếu hai request có cùng cache key, chúng share cùng một cached object. Nếu khác cache key, chúng có object riêng biệt.

Trong Varnish, cache key mặc định chỉ gồm `host + URL`. Nhưng trong hệ thống này, cache key được mở rộng với **variant headers** để phân biệt nội dung theo ngôn ngữ, quốc gia, loại thiết bị, và A/B test variant.

### 6.2. Cấu trúc cache key trong case này

```text
Cache Key = hash(
    host + path + query (normalized)
    + Accept-Language (normalized: vi|en|ja)
    + X-Geo-Country    (normalized: VN|US|SG|JP)
    + X-Device-Class   (normalized: mobile|tablet|desktop)
    + X-Ab-Variant     (normalized: control|variant-a|variant-b)
)
```

**Quan trọng:** `X-User-Segment` không có trong cache key cho product detail. Segment chỉ được thêm vào cache key cho một số endpoint đặc biệt như homefeed (xem case 02).

### 6.3. Logic VCL rút gọn

VCL (Varnish Configuration Language) của hệ thống này có logic đại khái như sau:

```vcl
sub vcl_hash {
    hash_data(req.url);
    hash_data(req.http.X-Cache-Key-Language);
    hash_data(req.http.X-Cache-Key-Geo);
    hash_data(req.http.X-Cache-Key-Device);
    hash_data(req.http.X-Cache-Key-AB);
    # X-Cache-Key-Segment chỉ được hash khi có mặt và endpoint yêu cầu
    if (req.http.X-Cache-Key-Segment) {
        hash_data(req.http.X-Cache-Key-Segment);
    }
}
```

Trước `vcl_hash`, `vcl_recv` đã normalize các header:

```vcl
sub vcl_recv {
    # Normalize Accept-Language -> X-Cache-Key-Language
    set req.http.X-Cache-Key-Language = "vi";  # hoặc "en", "ja"
    # Normalize X-Geo-Country -> X-Cache-Key-Geo
    set req.http.X-Cache-Key-Geo = "VN";       # hoặc "US", "SG", "JP"
    # Normalize X-Device-Class -> X-Cache-Key-Device
    set req.http.X-Cache-Key-Device = "mobile"; # hoặc "tablet", "desktop"
    # Normalize X-Ab-Variant -> X-Cache-Key-AB
    set req.http.X-Cache-Key-AB = "control";    # hoặc "variant-a", "variant-b"
}
```

### 6.4. Quy tắc normalization

Hàm `expectedCacheKey()` trong `shared.js` mô phỏng chính xác logic VCL normalization:

| Header gốc | Giá trị gốc | Normalized thành | Quy tắc |
|-----------|-------------|------------------|---------|
| `Accept-Language` | `vi` | `vi` | Lấy 2 ký tự đầu, lowercase. Nếu không phải `vi`/`en`/`ja` -> `en` |
| `Accept-Language` | `vi-VN,vi;q=0.9` | `vi` | Cắt 2 ký tự đầu |
| `Accept-Language` | `fr` | `en` | Fallback về `en` |
| `Accept-Language` | (không có) | `en` | Default `en` |
| `X-Geo-Country` | `VN` | `VN` | Uppercase. Nếu không phải VN/US/SG/JP -> `VN` |
| `X-Geo-Country` | `vn` | `VN` | Normalize về uppercase |
| `X-Geo-Country` | (trống) | `VN` | Default `VN` |
| `X-Device-Class` | `mobile` | `mobile` | Lowercase. Nếu không phải mobile/tablet/desktop -> `desktop` |
| `X-Device-Class` | `Mobile` | `mobile` | Normalize về lowercase |
| `X-Ab-Variant` | `control` | `control` | Lowercase. Nếu không phải control/variant-a/variant-b -> `control` |
| `X-Ab-Variant` | (trống) | `control` | Default `control` |
| `X-User-Segment` | `guest` | `guest` | Lowercase. guest/new_user/returning/vip, else `guest` |

### 6.5. Tại sao normalization quan trọng

Nếu không có normalization:
- `Accept-Language: vi-VN` và `Accept-Language: vi` sẽ tạo ra **hai cache key khác nhau** cho cùng một nội dung tiếng Việt -> cache fragmentation.
- `X-Geo-Country: vn` và `X-Geo-Country: VN` sẽ là hai object khác nhau -> lãng phí cache storage.
- Client gửi header không chuẩn (vd: `X-Device-Class: phone`) sẽ tạo ra object riêng -> cache pollution.

---

## 7. Request sequence flow

### 7.1. Timeline tổng thể

```text
Time ──────────────────────────────────────────────────────────────>
      │
      │  SETUP PHASE (tuần tự, single-VU)
      │
      ├─ T+0.0s   [Control] POST :8088/ops/app/cdn/cache/ban-url
      │            └─> Xóa object /api/sim/products/1 khỏi cache
      │
      ├─ T+0.1s   [Public]  GET :80/api/sim/products/1  (lần 1)
      │            ├─> Varnish: cache lookup -> EMPTY
      │            ├─> Varnish: forward to Nginx -> products-service
      │            ├─> Varnish: store response in cache
      │            └─> Response: 200, X-Cache: MISS
      │
      ├─ T+0.2s   [Public]  GET :80/api/sim/products/1  (lần 2)
      │            ├─> Varnish: cache lookup -> FOUND
      │            ├─> Varnish: serve from cache (NO origin call)
      │            └─> Response: 200, X-Cache: HIT
      │
      │  DEFAULT PHASE (song song, 4 VUs, 18 giây)
      │
      ├─ T+0.3s   [Public×4] GET :80/api/sim/products/1 (VU 1-4, iteration 1)
      │            └─> Tất cả: X-Cache: HIT
      │
      ├─ T+0.325s [Public×4] GET :80/api/sim/products/1 (VU 1-4, iteration 2)
      │            └─> Tất cả: X-Cache: HIT
      │
      ├─ ...      (tiếp tục trong 18 giây, ~2,880 requests)
      │
      └─ T+18.3s  Kết thúc. Tất cả request default phase đều HIT.
```

### 7.2. State machine của cache object

```text
                    ban-url
                 ┌──────────┐
                 │          ▼
             ┌───┴───────────┐
             │   NOT EXIST   │  (object chưa tồn tại trong cache)
             └───┬───────────┘
                 │ GET /api/sim/products/1 (lần đầu)
                 │ -> MISS
                 ▼
             ┌───────────────┐
             │    CACHED     │  (object đã được lưu, TTL còn hiệu lực)
             │   (FRESH)     │
             └───┬───────────┘
                 │ GET /api/sim/products/1 (lần 2+)
                 │ -> HIT
                 ▼
             ┌───────────────┐
             │    CACHED     │  (vẫn HIT, TTL chưa hết)
             │   (FRESH)     │
             └───────────────┘
                 │
                 │ ... TTL expire (không test trong case này)
                 ▼
             ┌───────────────┐
             │    EXPIRED    │  (hết TTL, request tiếp theo sẽ MISS)
             └───────────────┘
```

### 7.3. Decision tree trong Varnish cho mỗi request

```text
Request đến Varnish :80
  │
  ├─ Là GET/HEAD?
  │   ├─ NO  ──> PASS (không cache) -> forward đến origin
  │   └─ YES ──> Tiếp tục
  │
  ├─ Có Authorization header?
  │   ├─ YES ──> PASS (không cache) -> forward đến origin
  │   └─ NO  ──> Tiếp tục (guest user, không có auth)
  │
  ├─ Có Cookie session?
  │   ├─ YES ──> PASS (không cache) -> forward đến origin
  │   └─ NO  ──> Tiếp tục (anonymous user)
  │
  ├─ Cache-Control request header = no-cache?
  │   ├─ YES ──> PASS (không cache) -> forward đến origin
  │   └─ NO  ──> Tiếp tục
  │
  ├─ Cache lookup: object tồn tại và còn fresh?
  │   ├─ YES ──> HIT: trả object từ cache
  │   └─ NO  ──> MISS: forward đến origin
  │               │
  │               ├─ Origin response có Cache-Control: s-maxage/public?
  │               │   ├─ YES ──> Lưu vào cache, trả cho client
  │               │   └─ NO  ──> Không lưu cache, chỉ trả cho client
  │               └─> Trả response cho client với X-Cache: MISS
```

---

## 8. Key signals / headers cần verify

### 8.1. Bảng tổng hợp headers

| Header | Xuất hiện khi | Expected value (case này) | Ý nghĩa |
|--------|--------------|--------------------------|---------|
| `X-Cache` | Mọi response qua Varnish | `MISS` (lần 1), `HIT` (lần 2+) | Cache status của request này |
| `X-Cache-Key-Language` | Mọi response qua Varnish | `vi` | Ngôn ngữ trong cache key |
| `X-Cache-Key-Geo` | Mọi response qua Varnish | `VN` | Quốc gia trong cache key |
| `X-Cache-Key-Device` | Mọi response qua Varnish | `mobile` | Loại thiết bị trong cache key |
| `X-Cache-Key-AB` | Mọi response qua Varnish | `control` | A/B variant trong cache key |
| `X-Cache-Key-Segment` | Một số endpoint | (không có trong case này) | Segment trong cache key |
| `X-Upstream-Service` | Request đi qua Nginx | `products-service` | Service xử lý request |
| `Cache-Control` | Response từ origin | `public, s-maxage=...` | Directive cho CDN cache |
| `Content-Type` | Mọi response | `application/json` | Định dạng response |

### 8.2. Cách đọc `X-Cache` header

| Giá trị | Ý nghĩa | Hàm test tương ứng |
|---------|---------|-------------------|
| `HIT` | Object được phục vụ từ cache, không gọi origin | `assertCacheState(res, 'HIT', ...)` |
| `MISS` | Object không có trong cache, phải gọi origin | `assertCacheState(res, 'MISS', ...)` |
| `BYPASS` | Request không được phép cache (auth/cookie/no-cache) | `assertNotHit(res, ...)` |
| `STALE` | Object hết TTL nhưng origin lỗi, phục vụ bản cũ | (case 09) |
| `EXPIRED` | Object hết TTL, cần revalidate với origin | (case 08) |

### 8.3. Cách đọc `X-Cache-Key-*` headers

Các header này cho biết CDN đã dùng giá trị gì để tạo cache key. Chúng là evidence quan trọng để debug cache leakage:

```text
Nếu X-Cache-Key-Language = 'vi':
  -> CDN đã normalize Accept-Language thành 'vi'
  -> Object này sẽ được serve cho mọi request có Accept-Language normalized = 'vi'

Nếu X-Cache-Key-Device = 'mobile':
  -> Object này KHÔNG được serve cho desktop request
  -> Desktop request sẽ có cache key device='desktop' -> object riêng
```

---

## 9. Pass/fail criteria

### 9.1. Điều kiện PASS

Tất cả các điều kiện sau phải đồng thời đúng:

| # | Điều kiện | Cách verify | Mức độ |
|---|-----------|-------------|--------|
| 1 | `k6` exit code = 0 | Shell: `echo $?` hoặc `%ERRORLEVEL%` | **Cứng** |
| 2 | Threshold `checks: rate==1` pass | k6 output: `checks................: 100.00% ✓` | **Cứng** |
| 3 | Threshold `http_req_failed: rate==0` pass | k6 output: `http_req_failed........: 0.00% ✓` | **Cứng** |
| 4 | Setup: ban-url trả 200 | Check log: `purge /api/sim/products/1 status 200` | **Cứng** |
| 5 | Setup: first request = MISS | `assertCacheState(first, 'MISS', ...)` pass | **Cứng** |
| 6 | Setup: second request = HIT | `assertCacheState(second, 'HIT', ...)` pass | **Cứng** |
| 7 | Default: mọi sustained request = HIT | 2,880+ checks pass | **Cứng** |
| 8 | Upstream luôn = `products-service` | `assertUpstream(res, 'products-service', ...)` pass | **Cứng** |
| 9 | Cache key headers đúng expected | Language=`vi`, Geo=`VN`, Device=`mobile`, AB=`control` | **Cứng** |

### 9.2. Điều kiện FAIL

### FAIL-1: Lần 2 vẫn MISS

```text
first:  X-Cache: MISS ✓
second: X-Cache: MISS ✗  (expected HIT)
```

**Nguyên nhân có thể:**

| # | Nguyên nhân | Cách chẩn đoán |
|---|-------------|----------------|
| 1 | Origin không trả `Cache-Control: public` hoặc `s-maxage` | Kiểm tra response header của first request |
| 2 | Response có `Vary: Cookie` hoặc `Set-Cookie` header | Kiểm tra response header |
| 3 | VCL có rule bypass cho path này | Kiểm tra VCL config |
| 4 | Cache storage full, object bị evict ngay lập tức | Kiểm tra cache size/memory |
| 5 | Cache key khác nhau giữa 2 request (dù profile giống) | So sánh `X-Cache-Key-*` headers giữa 2 response |

### FAIL-2: HIT nhưng upstream header sai

```text
X-Cache: HIT ✓
X-Upstream-Service: unknown-service ✗  (expected products-service)
```

**Nguyên nhân có thể:** Nginx routing sai, service discovery trả sai target.

### FAIL-3: HIT nhưng cache key headers sai

```text
X-Cache: HIT ✓
X-Cache-Key-Language: en ✗  (expected vi)
```

**Nguyên nhân có thể:**
- VCL normalization không khớp với `expectedCacheKey()` trong shared.js
- Profile gửi sai `Accept-Language` header
- Có middleware khác ghi đè header trước khi đến VCL

### FAIL-4: Control ban-url fail

```text
POST :8088/ops/app/cdn/cache/ban-url -> 401/403/500
```

**Nguyên nhân có thể:**
- `OPS_AUTH_TOKEN` không được set hoặc sai
- Control plane không chạy trên port 8088
- Token đúng nhưng không có quyền CDN ops

### FAIL-5: Một vài sustained request fail (intermittent)

```text
iteration 1-500: HIT ✓
iteration 501:   MISS ✗
iteration 502+:  HIT ✓
```

**Nguyên nhân có thể:**
- TTL quá ngắn, object expire giữa chừng
- Background eviction do memory pressure
- Race condition trong Varnish (hiếm)

### FAIL-6: http_req_failed > 0

```text
http_req_failed: 2.5% ✗
```

**Nguyên nhân có thể:**
- Origin crash giữa chừng
- Network issue giữa Varnish và origin
- K6 client gửi request quá nhanh gây connection refused

---

## 10. Cách chạy + output mẫu

### 10.1. Lệnh chạy

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scripts\run-cdn-capabilities.ps1 -Scenarios 01-hit-smoke
```

Hoặc chạy trực tiếp với k6:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:OPS_AUTH_TOKEN = "<ops-token>"
k6 run load-target/k6/cdn/01-hit-smoke.js
```

### 10.2. Output mẫu — k6 console

```text

          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: load-target/k6/cdn/01-hit-smoke.js
     output: -

  scenarios: (100.00%) 1 scenario, 4 max VUs, 48s max duration (incl. graceful stop):
           * default: 4 looping VUs for 18s (exec: default, gracefulStop: 30s)

  running (18.0s), 4/4 VUs, 2872 complete and 0 interrupted iterations

  █ setup

  ✓ first detail request status 200
  ✓ first detail request upstream products-service
  ✓ first detail request cache state MISS
  ✓ first detail request cache language vi
  ✓ first detail request cache geo VN
  ✓ first detail request cache device mobile
  ✓ first detail request cache ab control

  ✓ second detail request status 200
  ✓ second detail request upstream products-service
  ✓ second detail request cache state HIT
  ✓ second detail request cache language vi
  ✓ second detail request cache geo VN
  ✓ second detail request cache device mobile
  ✓ second detail request cache ab control

  █ default

  ✓ sustained detail request status 200
  ✓ sustained detail request upstream products-service
  ✓ sustained detail request cache state HIT
  ✓ sustained detail request cache language vi
  ✓ sustained detail request cache geo VN
  ✓ sustained detail request cache device mobile
  ✓ sustained detail request cache ab control

     ✓ checks.........................: 100.00% ✓ 22990      ✗ 0
     ✓ http_req_failed................: 0.00%   ✓ 0          ✗ 2872

  running (00m18.3s), 0/4 VUs, 2872 complete and 0 interrupted iterations
  default ✓ [======================================] 4 VUs  18s
```

### 10.3. Output mẫu — summary JSON (trích)

```json
{
  "metrics": {
    "checks": {
      "type": "rate",
      "contains": "default",
      "values": { "rate": 1, "passes": 22990, "fails": 0 }
    },
    "http_req_failed": {
      "type": "rate",
      "contains": "default",
      "values": { "rate": 0, "passes": 0, "fails": 2872 }
    },
    "http_reqs": {
      "type": "counter",
      "contains": "default",
      "values": { "count": 2872, "rate": 157 }
    }
  }
}
```

### 10.4. Cách đọc output

1. **Dòng `checks: 100.00%`**: Đây là dòng quan trọng nhất. Nếu con số này không phải 100%, case đã fail.
2. **Dòng `http_req_failed: 0.00%`**: Nếu > 0%, có vấn đề về kết nối hoặc origin.
3. **Danh sách checks**: Mỗi check có format `<label> <điều kiện>`. Đọc từng dòng để biết chính xác cái gì đã pass/fail.

---

## 11. Bốn output -> decision scenarios

### 11.1. Scenario A: Pass thật (True Positive)

```text
Kết quả:
  ✓ k6 exit 0
  ✓ checks 100%
  ✓ first = MISS, second = HIT
  ✓ sustained = all HIT

Kết luận: CDN hoạt động đúng. Object được cache và phục vụ ổn định.

Hành động: Chuyển sang case 02.
```

### 11.2. Scenario B: Fail thật (True Negative — phát hiện lỗi thật)

```text
Kết quả:
  ✗ k6 exit 1
  ✗ first = MISS, second = MISS
  ✗ checks fail

Kết luận: CDN không cache object. Cần debug.

Các bước debug:
  1. Kiểm tra Varnish có đang chạy trên port 80 không
  2. Kiểm tra VCL config: có rule bypass nào không
  3. Kiểm tra response origin có Cache-Control header không
  4. Kiểm tra response origin có Set-Cookie không
  5. Kiểm tra cache storage: có đủ dung lượng không
```

### 11.3. Scenario C: Pass giả (False Positive — test pass nhưng thực tế sai)

```text
Kết quả:
  ✓ k6 exit 0
  ✓ checks pass
  ✓ first = MISS, second = HIT

Nhưng thực tế:
  - Varnish đã bị bypass do cấu hình nhầm
  - "MISS" và "HIT" là do một proxy khác (không phải Varnish) chèn vào
  - Response thực sự luôn gọi origin mỗi lần

Cách phát hiện:
  - Kiểm tra origin request count: nếu tăng theo mỗi request -> cache không hoạt động
  - Kiểm tra response time: HIT thật phải < 5ms, HIT giả vẫn ~100ms+
  - Kiểm tra header source: ai đang chèn X-Cache header?

Phòng tránh:
  - Luôn chạy case với origin request count được reset trước
  - Verify response time của HIT < 10ms (cache hit trong memory)
  - Dùng tcpdump/Wireshark để xác nhận request không đến origin
```

### 11.4. Scenario D: Fail giả (False Negative — test fail nhưng CDN hoạt động đúng)

```text
Kết quả:
  ✗ k6 exit 1
  ✗ second = MISS (expected HIT)

Nhưng thực tế:
  - OPS_AUTH_TOKEN sai -> ban-url fail -> cache vẫn có object cũ
  - Object cũ đã HIT nhưng cache key không khớp profile mới
  - Có ai đó chạy case khác cùng lúc và invalidated object này

Cách phát hiện:
  - Kiểm tra kết quả ban-url: có trả 200 không?
  - Kiểm tra cache key headers của second request
  - Chạy lại case một mình, không có process nào khác truy cập :80

Phòng tránh:
  - Luôn chạy CDN cases tuần tự, không song song
  - Verify OPS_AUTH_TOKEN trước khi chạy
  - Dùng dedicated environment, không share với developer khác
```

---

## 12. Nghịch lý / misconceptions

### 12.1. "Status 200 là đủ — không cần kiểm tra X-Cache"

**SAI.** Đây là misconception nguy hiểm nhất.

Một request có thể trả 200 nhưng:
- Không được cache (BYPASS) -> origin bị gọi mỗi lần
- Được cache sai key -> user nhận nhầm nội dung
- Được cache nhưng trả từ origin (MISS) -> latency cao

**CDN test không phải là functional test.** 200 OK là điều kiện cần, không phải điều kiện đủ.

### 12.2. "Cache HIT là chuyện đương nhiên, không cần test"

**SAI.** Cache HIT phụ thuộc vào hàng chục yếu tố:

- VCL config có đúng không
- Origin có trả đúng cache headers không
- Response có Set-Cookie không
- URL có query params không chuẩn không
- Request có header gây bypass không

Một thay đổi nhỏ trong app code (thêm `Vary: Cookie` chẳng hạn) có thể phá vỡ toàn bộ cache behavior mà functional test không phát hiện ra.

### 12.3. "Setup warm là không cần thiết — để default function tự warm"

**SAI.** Tách biệt warm và sustained test là best practice vì:

1. **Fail fast**: Nếu cache không hoạt động, biết ngay trong setup (dưới 1 giây) thay vì đợi 18 giây default function.
2. **Controlled environment**: Setup chạy single-VU, tuần tự, dễ debug.
3. **Clear separation of concerns**: Setup = "prove cache works", Default = "prove cache stays working under load".

### 12.4. "Càng nhiều VUs càng tốt — test kỹ hơn"

**SAI cho CDN correctness test.** CDN correctness không phụ thuộc vào load. Thêm VUs:
- Tăng nguy cơ race condition làm sai sequence MISS/HIT
- Làm output khó đọc
- Không chứng minh thêm được gì về cache behavior

Với correctness test, 1-4 VUs là đủ. Load test là một loại test khác.

### 12.5. "HIT ratio 100% nghĩa là cache hoàn hảo"

**CHƯA CHẮC.** HIT ratio cao có thể là:
- Đúng: cache hoạt động tốt
- Sai: chỉ có 1 user test, luôn gọi cùng URL -> tự nhiên HIT cao

HIT ratio có ý nghĩa trong production với traffic thật đa dạng. Trong test, tập trung vào sequence MISS/HIT, không phải ratio.

### 12.6. "Chỉ cần test localhost — không cần test production CDN"

**SAI.** Development CDN (Varnish trên localhost) và production CDN (Fastly, CloudFront, Cloudflare) có behavior khác biệt:

| Khía cạnh | Local Varnish | Production CDN |
|-----------|--------------|----------------|
| Cache key model | VCL-controlled | Vendor-specific (Fastly: custom VCL, CloudFront: cache policy) |
| TTL interpretation | Chuẩn RFC | Có thể có default override (vd: CloudFront min TTL) |
| Invalidation latency | Instant (single node) | Có thể mất vài giây đến vài phút (global distribution) |
| Header propagation | Đầy đủ (self-controlled) | Một số header bị strip (vd: CloudFront strip `X-Cache-Key-*`) |
| Coalescing behavior | Varnish built-in | Vendor-specific (CloudFront: regional edge caches) |

Local test là **necessary but not sufficient**. Sau khi pass trên local Varnish, cần verify trên staging CDN với vendor thật.

### 12.7. "Ban URL là đủ — không cần setup MISS->HIT sequence"

**SAI.** Ban URL chỉ xóa object khỏi cache. Nó không chứng minh:
- Object mới có được cache không (cần MISS đầu tiên)
- Object cache có được reuse không (cần HIT thứ hai)
- Cache key có đúng không (cần assert cache key headers)

Setup sequence MISS -> HIT là **atomic proof**. Ban URL chỉ là bước dọn dẹp trước khi proof.

### 12.8. "Case 01 quá đơn giản — có thể bỏ qua để học case phức tạp hơn"

**SAI.** Case 01 là nền tảng. Nếu bạn không chứng minh được cache HIT cơ bản:
- Case 02 (variant keys): Làm sao biết variant MISS -> HIT là do cache key đúng, không phải do cache không hoạt động?
- Case 08 (TTL expiry): Làm sao biết MISS sau TTL là do expire, không phải do cache chưa bao giờ hoạt động?
- Case 09 (stale): Làm sao biết stale HIT là do grace mode, không phải do object chưa bao giờ được cache?

Case 01 là **single point of failure** cho toàn bộ CDN test suite. Nếu case 01 fail, mọi case khác đều vô nghĩa.

### 12.9. "Origin trả 200 + Cache-Control: public -> CDN sẽ cache"

**KHÔNG HẲN.** CDN có thể không cache dù origin trả đúng headers, vì:

1. **Response quá lớn**: Varnish có giới hạn object size (mặc định thường vài MB). Object vượt quá -> không cache.
2. **Response có `Vary: *`**: Dấu hiệu response là private, Varnish thường không cache.
3. **Request method không phải GET/HEAD**: POST/PUT/DELETE không được cache.
4. **Request có `Authorization` header**: Mặc định Varnish bypass cache.
5. **Request có `Cookie` header**: Tùy VCL config, có thể bypass.
6. **Cache storage full**: Object mới không thể lưu.

Case 01 kiểm tra chính xác những điều kiện này bằng cách xác nhận sequence MISS -> HIT thực tế.

### 13.1. Infrastructure checklist

| # | Mục kiểm tra | Lệnh/Phương pháp | Expected |
|---|-------------|-----------------|----------|
| 1 | Varnish đang chạy trên port 80 | `curl -I http://localhost:80/api/sim/products/1` | Response có `X-Cache` header |
| 2 | Control plane chạy trên port 8088 | `curl http://localhost:8088/ops/app/cdn/origin/profile` | JSON response (có thể cần auth) |
| 3 | Products service healthy | Gọi qua :80 hoặc health check endpoint | Status 200 |
| 4 | OPS_AUTH_TOKEN hợp lệ | `curl -H "Authorization: Bearer $OPS_AUTH_TOKEN" http://localhost:8088/ops/app/cdn/cache/ban-url -X POST -H "Content-Type: application/json" -d '{"url":"/test"}'` | Status 200 |

### 13.2. Environment checklist

| # | Mục kiểm tra | Lệnh | Expected |
|---|-------------|------|----------|
| 1 | `BASE_URL` được set | `echo $env:BASE_URL` | `http://localhost:80` |
| 2 | `CONTROL_BASE_URL` được set | `echo $env:CONTROL_BASE_URL` | `http://localhost:8088` |
| 3 | `OPS_AUTH_TOKEN` được set | `echo $env:OPS_AUTH_TOKEN` | Token string (không rỗng) |
| 4 | Không ai đang chạy CDN case khác | Kiểm tra process k6 | Không có process k6 nào khác |
| 5 | Working directory đúng | `pwd` | `E:\Projects\k6\k6-metrics-server` |

### 13.3. Code checklist (trước khi sửa script)

| # | Mục kiểm tra | Cách |
|---|-------------|------|
| 1 | Profile `guestVNMobileControl` không bị sửa | Đọc `shared.js` dòng 36-45 |
| 2 | `paths.productDetail` = `/api/sim/products/1` | Đọc `shared.js` dòng 18 |
| 3 | `expectedCacheKey()` logic khớp VCL | So sánh `shared.js` dòng 123-133 với VCL file |
| 4 | Không có hardcode URL hoặc token trong script | Search `01-hit-smoke.js` cho `localhost`, `token` |

### 13.4. Post-run verification checklist

| # | Mục kiểm tra | Cách |
|---|-------------|------|
| 1 | k6 exit code = 0 | `echo $LASTEXITCODE` (PowerShell) |
| 2 | checks rate = 100% | Đọc dòng checks trong output |
| 3 | http_req_failed = 0% | Đọc dòng http_req_failed trong output |
| 4 | Tất cả sustained request HIT | Search output: không có dòng `cache state HIT ✗` |
| 5 | Không có warning bất thường | Đọc toàn bộ stderr |

---

## 14. Variations với code

### 14.1. Variation 1: Single-VU debug mode

Giảm VUs xuống 1 và tăng sleep để dễ đọc log từng request:

```javascript
export const options = {
  vus: 1,
  duration: '10s',
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
  tags: {
    scenario: 'cdn_hit_smoke_debug',
  },
};

// Trong default function, thêm log:
export default function (data) {
  const res = requestCdn('GET', paths.productDetail, {
    profile: data.profile,
    tags: { case: 'detail_debug' },
  });
  console.log(`[VU=${__VU}][Iter=${__ITER}] status=${res.status} cache=${res.headers['X-Cache']}`);
  assertStatus(res, 200, 'debug detail');
  assertCacheState(res, 'HIT', 'debug detail');
  sleep(1);  // 1 giây giữa các request để dễ đọc
}
```

### 14.2. Variation 2: Multiple product IDs

Test cache cho nhiều product ID khác nhau:

```javascript
const PRODUCT_IDS = [1, 2, 3, 4, 5];

export default function (data) {
  const productId = PRODUCT_IDS[Math.floor(Math.random() * PRODUCT_IDS.length)];
  const path = `/api/sim/products/${productId}`;

  const res = requestCdn('GET', path, {
    profile: data.profile,
    tags: { case: 'multi_product' },
  });
  assertStatus(res, 200, `product ${productId}`);
  assertCacheState(res, 'HIT', `product ${productId}`);
  sleep(HIT_SMOKE_SLEEP_SECONDS);
}
```

**Lưu ý:** Setup cần ban-url cho tất cả product IDs trước khi warm.

### 14.3. Variation 3: Thêm origin count verification

Thêm bước verify rằng sustained HIT không làm tăng origin request count:

```javascript
export function setup() {
  // ... existing setup code ...

  // Reset origin counter SAU KHI warm
  const resetResult = controlRequest('POST', '/ops/app/cdn/origin/request-counts/reset', null);
  console.log(`Origin counters reset: ${resetResult.status}`);

  return { profile, expected };
}

export function teardown(data) {
  // Verify origin count = 0 (không có request nào đến origin trong sustained phase)
  const counts = controlRequest('GET', '/ops/app/cdn/origin/request-counts', null);
  const payload = counts.json();
  const detailCount = findOriginRequestCount(payload, '/api/sim/products/1');
  console.log(`Origin count for /api/sim/products/1: ${detailCount}`);
  // Phải = 0 vì tất cả sustained request đều HIT
  if (detailCount !== 0) {
    console.error(`FAIL: Origin was called ${detailCount} times during sustained HIT phase!`);
  }
}
```

### 14.4. Variation 4: Test với nhiều profile khác nhau

Warm 2 profile khác nhau và verify chúng có cache object riêng:

```javascript
export function setup() {
  const profile1 = profiles.guestVNMobileControl;
  const profile2 = profiles.guestUSDesktopControl;

  // Clear cache
  banUrl(paths.productDetail);

  // Warm profile 1
  const p1first = requestCdn('GET', paths.productDetail, { profile: profile1, tags: { case: 'p1_first' } });
  assertCacheState(p1first, 'MISS', 'p1 first');
  const p1second = requestCdn('GET', paths.productDetail, { profile: profile1, tags: { case: 'p1_second' } });
  assertCacheState(p1second, 'HIT', 'p1 second');

  // Warm profile 2
  const p2first = requestCdn('GET', paths.productDetail, { profile: profile2, tags: { case: 'p2_first' } });
  assertCacheState(p2first, 'MISS', 'p2 first');

  return { profiles: [profile1, profile2] };
}

export default function (data) {
  // Luân phiên giữa 2 profile
  const profile = data.profiles[__ITER % 2];
  const res = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'multi_profile_sustained' },
  });
  assertCacheState(res, 'HIT', `profile ${profile.name}`);
  sleep(HIT_SMOKE_SLEEP_SECONDS);
}
```

### 14.5. Variation 5: Response body comparison

Thêm verification rằng cached response body giống với origin response:

```javascript
export function setup() {
  banUrl(paths.productDetail);

  const first = requestCdn('GET', paths.productDetail, {
    profile: profiles.guestVNMobileControl,
    tags: { case: 'detail_first' },
  });
  const firstBody = first.body;

  const second = requestCdn('GET', paths.productDetail, {
    profile: profiles.guestVNMobileControl,
    tags: { case: 'detail_second' },
  });
  const secondBody = second.body;

  // Verify body identical
  if (firstBody !== secondBody) {
    fail('Cached response body differs from origin response body!');
  }

  return { profile: profiles.guestVNMobileControl, expected: expectedCacheKey(profiles.guestVNMobileControl), firstBody };
}

export default function (data) {
  const res = requestCdn('GET', paths.productDetail, {
    profile: data.profile,
    tags: { case: 'detail_sustained_hit' },
  });
  assertCacheState(res, 'HIT', 'sustained detail');
  // Verify body matches original
  if (res.body !== data.firstBody) {
    fail(`Iteration ${__ITER}: cached body differs from original!`);
  }
  sleep(HIT_SMOKE_SLEEP_SECONDS);
}
```

---

## 15. Anti-patterns

### 15.1. Anti-pattern 1: Bỏ qua setup warm

```javascript
// SAI — default function gọi thẳng, không biết trạng thái cache ban đầu
export default function () {
  const res = requestCdn('GET', paths.productDetail, { profile: profiles.guestVNMobileControl });
  assertCacheState(res, 'HIT', 'detail');  // Có thể HIT vì object cũ, không phải vì cache hoạt động
}
```

**Vấn đề:** Nếu object đã có trong cache từ lần chạy trước, test sẽ pass dù CDN có thể đã bị disable. Bạn không chứng minh được MISS -> HIT, chỉ chứng minh được "có gì đó trong cache".

**Cách đúng:** Luôn có setup phase với ban/purge + explicit warm.

### 15.2. Anti-pattern 2: Không assert cache key headers

```javascript
// SAI — chỉ check X-Cache, bỏ qua cache key
assertCacheState(res, 'HIT', 'detail');
// Thiếu: assertCacheKeyHeaders(res, expected, 'detail');
```

**Vấn đề:** Cache HIT nhưng sai key -> user VN mobile nhận response của user US desktop. Case 02 sẽ bắt được, nhưng case 01 cũng nên assert để phát hiện sớm.

### 15.3. Anti-pattern 3: Tăng VUs để "test nhanh hơn"

```javascript
// SAI — 100 VUs cho CDN correctness test
export const options = {
  vus: 100,
  duration: '18s',
};
```

**Vấn đề:**
- 100 VUs gọi cùng lúc cold object -> request coalescing kích hoạt -> behavior khác với test đơn giản
- Log output khổng lồ, khó debug
- Có thể gây race condition trong Varnish
- Không chứng minh thêm được gì về correctness

**Cách đúng:** 1-4 VUs cho correctness, scale VUs chỉ khi test load/stress.

### 15.4. Anti-pattern 4: Chạy song song nhiều CDN case

```powershell
# SAI — chạy nhiều case cùng lúc
k6 run 01-hit-smoke.js &
k6 run 02-variant-keys.js &
```

**Vấn đề:** Các case chia sẻ chung cache storage. Case này ban-url object mà case kia đang test. Kết quả không deterministic.

**Cách đúng:** Chạy tuần tự từng case một.

### 15.5. Anti-pattern 5: Dùng `sleep(0)` để "tối đa throughput"

```javascript
// SAI
export default function () {
  const res = requestCdn('GET', paths.productDetail, ...);
  // Không sleep -> request liên tục không nghỉ
}
```

**Vấn đề:**
- Tạo áp lực không cần thiết lên CDN và network
- Có thể gây connection exhaustion
- Không mô phỏng được traffic pattern thực tế

**Cách đúng:** Luôn có sleep hợp lý (dù nhỏ, như `0.025s`).

### 15.6. Anti-pattern 6: Chỉ nhìn status code để đánh giá pass/fail

```javascript
// SAI
const res = requestCdn('GET', paths.productDetail, { profile });
if (res.status === 200) {
  console.log('PASS');  // Chỉ check status
}
```

**Vấn đề:** Status 200 không có nghĩa là cache hoạt động. Request có thể 200 nhưng:
- `X-Cache: BYPASS` -> không cache được
- `X-Cache: MISS` -> gọi origin mỗi lần
- `X-Cache: HIT` nhưng sai key -> phục vụ nhầm người dùng

**Cách đúng:** Assert đầy đủ: status, cache state, upstream, cache key headers.

### 15.7. Anti-pattern 7: Bỏ qua `X-Upstream-Service` header

```javascript
// SAI — chỉ check cache, không check upstream
assertCacheState(res, 'HIT', 'detail');
// Thiếu: assertUpstream(res, 'products-service', 'detail');
```

**Vấn đề:** Cache HIT nhưng `X-Upstream-Service` sai -> request đã đi qua sai service trước khi được cache. Những request sau HIT sẽ trả response từ service sai.

**Cách đúng:** Luôn assert upstream service, đặc biệt trong setup warm.

### 15.8. Anti-pattern 8: Hardcode URL thay vì dùng `paths` object

```javascript
// SAI
const res = requestCdn('GET', '/api/sim/products/1', { profile });
```

**Vấn đề:**
- URL thay đổi -> phải sửa nhiều nơi
- Dễ typo -> request 404 nhưng không ai biết
- Không consistent với các case khác

**Cách đúng:**
```javascript
const res = requestCdn('GET', paths.productDetail, { profile });
```

---

## 15b. Troubleshooting guide

### 15b.1. Sơ đồ chẩn đoán nhanh

```text
Case 01 fail
  │
  ├─ k6 không chạy được?
  │   ├─ "Cannot find module" -> Kiểm tra import paths
  │   ├─ "envInt is not a function" -> Kiểm tra shared/common.js
  │   └─ "connect ECONNREFUSED" -> localhost:80 hoặc :8088 không chạy
  │
  ├─ Setup fail?
  │   ├─ banUrl fail (401/403)?
  │   │   ├─ OPS_AUTH_TOKEN chưa set -> set env var
  │   │   ├─ OPS_AUTH_TOKEN sai -> kiểm tra token
  │   │   └─ Control plane không chạy -> khởi động :8088
  │   │
  │   ├─ first request fail (không phải 200)?
  │   │   ├─ 503 -> Origin không healthy -> kiểm tra products-service
  │   │   ├─ 404 -> Path sai -> kiểm tra paths.productDetail
  │   │   └─ 502 -> Varnish không kết nối được Nginx
  │   │
  │   ├─ first request = HIT (expected MISS)?
  │   │   ├─ banUrl không hoạt động -> object cũ vẫn trong cache
  │   │   ├─ Có process khác vừa warm object này
  │   │   └─ Cache key không như expected -> kiểm tra X-Cache-Key-*
  │   │
  │   └─ second request = MISS (expected HIT)?
  │       ├─ Origin trả Cache-Control: private -> CDN không cache
  │       ├─ Response có Set-Cookie -> CDN bypass
  │       ├─ TTL = 0 -> object expire ngay lập tức
  │       └─ Cache storage full -> object bị evict
  │
  └─ Default function fail?
      ├─ Một vài request MISS (intermittent)?
      │   ├─ TTL ngắn hơn duration -> object expire giữa chừng
      │   ├─ Cache eviction do memory pressure
      │   └─ Có process khác invalidate object này
      │
      └─ Toàn bộ request fail?
          ├─ Origin crash trong lúc test -> http_req_failed > 0
          ├─ Network partition giữa Varnish và origin
          └─ Varnish crash/restart -> mất toàn bộ cache
```

### 15b.2. Các câu lệnh chẩn đoán thủ công

```powershell
# 1. Kiểm tra Varnish có đang chạy không
curl -I http://localhost:80/api/sim/products/1 2>&1 | Select-String "X-Cache"

# 2. Kiểm tra control plane
curl http://localhost:8088/ops/app/cdn/origin/profile -H "Authorization: Bearer $env:OPS_AUTH_TOKEN"

# 3. Kiểm tra ban-url hoạt động
curl -X POST http://localhost:8088/ops/app/cdn/cache/ban-url `
  -H "Authorization: Bearer $env:OPS_AUTH_TOKEN" `
  -H "Content-Type: application/json" `
  -d '{"url":"/api/sim/products/1"}'

# 4. Xem toàn bộ response headers (không chỉ body)
curl -v http://localhost:80/api/sim/products/1 `
  -H "Accept-Language: vi" `
  -H "X-Geo-Country: VN" `
  -H "X-Device-Class: mobile" `
  -H "X-Ab-Variant: control" 2>&1 | Select-String "X-"

# 5. Kiểm tra origin request count
curl http://localhost:8088/ops/app/cdn/origin/request-counts `
  -H "Authorization: Bearer $env:OPS_AUTH_TOKEN" | ConvertFrom-Json | ConvertTo-Json -Depth 5
```

### 15b.3. Các symptom thường gặp và root cause

| Symptom | Root cause phổ biến nhất | Tần suất gặp |
|---------|--------------------------|-------------|
| first request HIT thay vì MISS | banUrl fail (token sai / control plane down) | Cao |
| second request MISS thay vì HIT | Origin response có `Cache-Control: private` hoặc `Set-Cookie` | Cao |
| `X-Cache` header không tồn tại | Target layer không phải `full` — request không qua Varnish | Trung bình |
| `X-Cache-Key-*` headers rỗng hoặc sai | VCL `vcl_recv` không set header trước `vcl_hash` | Trung bình |
| Timeout khi gọi control plane | `CONTROL_BASE_URL` sai port hoặc service không chạy | Thấp |
| Response có status 200 nhưng body rỗng | Origin trả 200 với Content-Length: 0 | Thấp |
| k6 crash với "connection reset" | Quá nhiều request/giây, OS hết ephemeral ports | Thấp |

### 15b.4. Khi nào cần xóa cache thủ công trước khi chạy

```powershell
# Nếu ban-url không hoạt động (control plane down), 
# có thể restart Varnish để xóa toàn bộ cache:
docker restart varnish  # nếu dùng Docker
# hoặc
sudo systemctl restart varnish  # nếu cài trực tiếp

# Sau đó chạy lại case 01
k6 run load-target/k6/cdn/01-hit-smoke.js
```

**Lưu ý:** Restart Varnish chỉ dùng trong development/local. Trong production, dùng control plane để invalidate có chủ đích.

### 16.1. Môi trường test

| Thuộc tính | Giá trị |
|-----------|--------|
| Thời gian chạy | 2026-06 |
| Target version | `full` stack local |
| Varnish version | (theo deployment) |
| OS | Windows 11 |
| k6 version | 0.52+ |

### 16.2. Kết quả chạy thực tế

```text
Scenario: cdn-01-hit-smoke
  VUs:           4
  Duration:      18s
  Iterations:    2,872
  Checks pass:   22,990 / 22,990 (100%)
  HTTP fails:    0 / 2,872 (0%)

Cache sequence verified:
  [setup]    ban-url              -> 200 OK
  [setup]    first request        -> 200, X-Cache: MISS, upstream: products-service
  [setup]    second request       -> 200, X-Cache: HIT,  upstream: products-service
  [default]  2,870 requests       -> all 200, all X-Cache: HIT

Cache key: language=vi, geo=VN, device=mobile, ab=control
Response time (HIT):  avg ~2ms, p95 ~5ms, p99 ~8ms
Response time (MISS): ~45ms (single occurrence in setup)
```

### 16.3. Những điều cần lưu ý từ kết quả thực tế

1. **Response time của HIT rất thấp** (~2ms trung bình): Đây là dấu hiệu object được phục vụ từ in-memory cache. Nếu HIT mà response time > 50ms, có thể object đang được fetch từ disk cache hoặc đang bị revalidate.
2. **Không có HIT nào bị "rơi" thành MISS**: 2,870 sustained requests đều HIT, chứng tỏ TTL đủ dài cho duration test.
3. **Cache key headers nhất quán**: Mọi response đều có `X-Cache-Key-Language: vi`, `X-Cache-Key-Geo: VN`, `X-Cache-Key-Device: mobile`, `X-Cache-Key-AB: control`.

### 16.4. Bảng kiểm chứng từng assertion

| # | Assertion | Phase | Kết quả thực tế | Trạng thái |
|---|-----------|-------|-----------------|------------|
| 1 | `banUrl` trả 200 | setup | 200 OK | PASS |
| 2 | `first detail request` status 200 | setup | 200 | PASS |
| 3 | `first detail request` upstream = `products-service` | setup | `products-service` | PASS |
| 4 | `first detail request` X-Cache = `MISS` | setup | `MISS` | PASS |
| 5 | `first detail request` X-Cache-Key-Language = `vi` | setup | `vi` | PASS |
| 6 | `first detail request` X-Cache-Key-Geo = `VN` | setup | `VN` | PASS |
| 7 | `first detail request` X-Cache-Key-Device = `mobile` | setup | `mobile` | PASS |
| 8 | `first detail request` X-Cache-Key-AB = `control` | setup | `control` | PASS |
| 9 | `second detail request` X-Cache = `HIT` | setup | `HIT` | PASS |
| 10 | 2,870 sustained requests X-Cache = `HIT` | default | 2,870/2,870 HIT | PASS |
| 11 | `checks` rate = 100% | all | 22,990/22,990 | PASS |
| 12 | `http_req_failed` rate = 0% | all | 0/2,872 | PASS |
| 13 | k6 exit code = 0 | all | 0 | PASS |

### 16.5. Điều kiện tái lập kết quả

Để tái lập được kết quả trên, cần đảm bảo:

1. **Target layer đúng**: `TargetLayer=full`, Varnish chạy trên port 80
2. **Token hợp lệ**: `OPS_AUTH_TOKEN` có quyền gọi control plane CDN ops
3. **Origin healthy**: `products-service` trả 200 với JSON body hợp lệ
4. **Cache storage trống**: Không có object nào trong cache trước khi chạy
5. **Không có traffic khác**: Chỉ có k6 client truy cập :80 trong lúc chạy test
6. **VCL config chuẩn**: `vcl_recv` normalize headers, `vcl_hash` hash đủ dimensions, `vcl_backend_response` set TTL > 18s

### 16.6. Các yếu tố có thể làm sai lệch kết quả

| Yếu tố | Ảnh hưởng | Cách kiểm soát |
|--------|-----------|---------------|
| Object đã có trong cache từ trước | first request HIT thay vì MISS -> test pass giả | Luôn gọi `banUrl` trong setup |
| TTL < 18s (duration) | Một vài sustained request MISS -> test fail giả | Đảm bảo origin trả `s-maxage >= 30` |
| Nhiều process cùng chạy case 01 | Ban URL của nhau -> intermittent fail | Chạy một instance duy nhất |
| Network latency cao | Response time HIT cao bất thường | Chạy local, không qua VPN/proxy |
| Cache storage giới hạn thấp | Eviction sớm -> MISS giữa chừng | Cấu hình Varnish storage đủ lớn (tối thiểu 100MB) |

---

## 17. Reference

### 17.1. Source files

| File | Path | Vai trò |
|------|------|---------|
| Script chính | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\01-hit-smoke.js` | Test case script |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` | CDN helper library |
| Common helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Env variable helpers |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json` | Case registry |
| CDN README | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md` | Source documentation |
| Layer roadmap | `E:\Projects\k6\k6-metrics-server\load-target\k6\layer-roadmap.md` | Layer-level overview |

### 17.2. Related docs

| Document | Path | Liên quan |
|----------|------|-----------|
| Series overview | `E:\Khoa hoc\k6\docs\practice\cdn\00_overview.md` | Tổng quan 11 CDN cases |
| Case 02 | `E:\Khoa hoc\k6\docs\practice\cdn\02_variant-keys.md` | Case tiếp theo — variant cache keys |
| Case 03 | `E:\Khoa hoc\k6\docs\practice\cdn\03_bypass-rules.md` | Bypass rules |
| Run guide | `E:\Khoa hoc\k6\RUN_GUIDE.md` | Hướng dẫn chạy chung |
| Validation report | `E:\Khoa hoc\k6\docs\practice\cdn\12_validation-and-chart-analysis.md` | Tổng hợp validation |

### 17.3. Key concepts reference

| Concept | Case liên quan | Mô tả ngắn |
|---------|---------------|------------|
| Cache HIT/MISS | Case 01 (này) | Nền tảng cache serving |
| Variant keys | Case 02 | Phân biệt cache theo dimensions |
| Bypass rules | Case 03 | Auth/Cookie/no-cache bypass |
| Query normalization | Case 04 | Tracking params vs business params |
| Manual invalidation | Case 05 | Purge/ban/tag |
| Event invalidation | Case 06 | Event-driven invalidation |
| Cache contract | Case 07 | Headers và 304 |
| TTL expiry | Case 08 | Hết hạn cache |
| Stale serving | Case 09 | Phục vụ object cũ khi origin lỗi |
| Request coalescing | Case 10 | Gộp request cold |
| Negative caching | Case 11 | Cache 404 |
