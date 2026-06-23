# Case 04: Origin cacheable read without CDN

> **Case ID:** `lb-04-origin-cacheable-read`
> **Script:** `04-origin-cacheable-read.js`
> **Profile:** `full-no-cdn` / `TargetLayer=full-no-cdn`
> **Proof:** Cacheable product reads đi origin qua LB, không bị CDN cache che khuất

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [LB capability được chứng minh](#2-lb-capability-được-chứng-minh)
3. [Vì sao phải test ở LB layer](#3-vì-sao-phải-test-ở-lb-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Nginx/LB mechanism](#6-nginxlb-mechanism)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / headers cần verify](#8-key-signals--headers-cần-verify)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output -> decision scenarios](#11-4-output---decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist trước khi chạy](#13-checklist-trước-khi-chạy)
14. [4-5 Variations với code mẫu](#14-4-5-variations-với-code-mẫu)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh nghiệp vụ

Một nền tảng thương mại điện tử vận hành kiến trúc hai lớp:

```text
Lớp 1 (CDN/Varnish): Cache các request read-only phổ biến -- danh sách sản phẩm,
                      chi tiết sản phẩm, tìm kiếm, danh mục, đề xuất.
                      HIT ratio mục tiêu: 85-95%.

Lớp 2 (Origin/LB):   Xử lý request không cache được (dynamic, write, auth)
                      và request cache MISS/BYPASS từ lớp 1.
```

Trong điều kiện bình thường, 85-95% request đọc sản phẩm được CDN phục vụ từ cache. Nhưng có những tình huống CDN không thể phục vụ:

| Tình huống | Nguyên nhân | Tỷ lệ traffic bị ảnh hưởng |
| --- | --- | --- |
| CDN gặp sự cố (outage) | Lỗi phần cứng, cấu hình sai, DDoS vào CDN | 100% traffic đi thẳng origin |
| Cache invalidation hàng loạt | Chiến dịch khuyến mãi -- tất cả giá sản phẩm thay đổi cùng lúc | 100% product traffic MISS |
| CDN bảo trì có kế hoạch | Nâng cấp Varnish version, thay đổi VCL | 100% trong thời gian bảo trì |
| Cold start sau deploy | Cache trống sau khi khởi động lại stack | 100% cho đến khi cache đầy |

Trong tất cả các tình huống trên, **toàn bộ traffic đọc sản phẩm đổ thẳng về origin** thông qua LB layer. LB phải:

1. **Route đúng**: Mọi product request phải đến `products-service`
2. **Giữ signal rõ ràng**: Không có `X-Cache` header -- xác nhận request không đi qua CDN
3. **Chịu được tải**: Với 16 VU concurrent, response time p95 < 1500ms
4. **Gắn trace ID**: Mỗi request có `X-Request-ID` để tracing

### 1.2 Sáu endpoint sản phẩm được test

Case này bao phủ toàn bộ bề mặt đọc sản phẩm (product read surface):

| # | Endpoint | Path | Weight | Mô tả |
| --- | --- | --- | --- | --- |
| 1 | `products_list` | `/api/sim/products` | 25 | Danh sách sản phẩm -- endpoint phổ biến nhất, lưu lượng cao nhất |
| 2 | `products_detail` | `/api/sim/products/1` | 20 | Chi tiết sản phẩm -- endpoint được cache nhiều nhất trong điều kiện bình thường |
| 3 | `products_categories` | `/api/sim/products/categories` | 15 | Danh mục sản phẩm -- dùng cho menu điều hướng |
| 4 | `products_search` | `/api/sim/products/search?q=shoe` | 15 | Tìm kiếm sản phẩm -- query string cố định cho test |
| 5 | `products_recommendations` | `/api/sim/products/1/recommendations` | 15 | Đề xuất sản phẩm liên quan |
| 6 | `products_homefeed` | `/api/sim/products/homefeed` | 10 | Homefeed cá nhân hóa -- tần suất thấp hơn |

Tất cả 6 endpoint đều có chung `expectedUpstream: 'products-service'`.

### 1.3 Traffic profiles -- mô phỏng người dùng thật

Case này không gửi request "trần". Mỗi request được gắn một **traffic profile** mô phỏng người dùng thật với các dimension:

| Dimension | Header | Ý nghĩa | Ví dụ |
| --- | --- | --- | --- |
| Ngôn ngữ | `Accept-Language` | Ngôn ngữ ưa thích của người dùng | `vi`, `en`, `ja` |
| Vị trí địa lý | `X-Geo-Country` | Quốc gia của người dùng | `VN`, `US`, `SG`, `JP` |
| Loại thiết bị | `X-Device-Class` | Desktop, mobile, hay tablet | `mobile`, `desktop` |
| A/B test variant | `X-Ab-Variant` | Biến thể A/B test đang được gán | `control`, `variant-a`, `variant-b` |
| Phân khúc người dùng | `X-User-Segment` | Guest, returning, new_user | `guest`, `returning`, `new_user` |

Năm profile được định nghĩa với tỷ lệ phân bổ thực tế:

```javascript
// Từ traffic.js
export const trafficProfiles = [
  { name: 'vn_mobile_guest_control',   weight: 35, headers: { 'Accept-Language': 'vi', 'X-Geo-Country': 'VN', 'X-Device-Class': 'mobile',  'X-Ab-Variant': 'control',   'X-User-Segment': 'guest' } },
  { name: 'vn_mobile_returning_a',     weight: 20, headers: { 'Accept-Language': 'vi', 'X-Geo-Country': 'VN', 'X-Device-Class': 'mobile',  'X-Ab-Variant': 'variant-a', 'X-User-Segment': 'returning' } },
  { name: 'us_desktop_guest_control',  weight: 20, headers: { 'Accept-Language': 'en', 'X-Geo-Country': 'US', 'X-Device-Class': 'desktop', 'X-Ab-Variant': 'control',   'X-User-Segment': 'guest' } },
  { name: 'sg_desktop_returning_b',    weight: 15, headers: { 'Accept-Language': 'en', 'X-Geo-Country': 'SG', 'X-Device-Class': 'desktop', 'X-Ab-Variant': 'variant-b', 'X-User-Segment': 'returning' } },
  { name: 'ja_mobile_new_a',           weight: 10, headers: { 'Accept-Language': 'ja', 'X-Geo-Country': 'JP', 'X-Device-Class': 'mobile',  'X-Ab-Variant': 'variant-a', 'X-User-Segment': 'new_user' } },
];
```

**Phân tích tỷ lệ:**

```text
vn_mobile_guest_control:   ███████████████████████████████████ 35%
vn_mobile_returning_a:     ████████████████████               20%
us_desktop_guest_control:  ████████████████████               20%
sg_desktop_returning_b:    ███████████████                    15%
ja_mobile_new_a:           ██████████                         10%
```

Profile phổ biến nhất (`vn_mobile_guest_control, 35%`) đại diện cho **người dùng mobile Việt Nam, chưa đăng nhập, trong nhóm control của A/B test** -- đây là phân khúc người dùng lớn nhất ở thị trường Việt Nam.

### 1.4 So sánh với trường hợp có CDN

| Khía cạnh | Có CDN (topology `full`) | Không CDN (topology `full-no-cdn`) |
| --- | --- | --- |
| Request đầu tiên | MISS → origin | MISS → origin |
| Request thứ hai (cùng variant) | HIT (CDN cache) | MISS (không có cache layer) |
| `X-Cache` header | `HIT` hoặc `MISS` | **Vắng mặt** |
| `X-Upstream-Service` | `products-service` (khi MISS) | `products-service` (luôn luôn) |
| Response time p95 | < 5ms (khi HIT) | < 1500ms |
| Số request đến origin | 5-15% tổng traffic | 100% traffic |

---

## 2. LB capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh ba khả năng của LB layer khi xử lý cacheable reads không qua CDN:

> **1. Route đúng upstream:** Mọi product read request đến đúng `products-service`
> **2. Signal rõ ràng:** Không có `X-Cache` -- đúng với topology không CDN
> **3. Chịu tải ổn định:** 16 VU concurrent, p95 < 1500ms, error rate < 2%

Cụ thể hơn:

| Khả năng | Cách chứng minh | Metric |
| --- | --- | --- |
| Upstream routing | `X-Upstream-Service === 'products-service'` cho mọi request | `upstream matches` check pass 100% |
| Signal correctness | `X-Cache` vắng mặt trong mọi response | `no cache header` check pass 100% |
| Request tracing | `X-Request-ID` tồn tại trong mọi response | `request id present` check pass 100% |
| Load handling | Response time chấp nhận được dưới concurrent load | `http_req_duration p(95) < 1500ms` |
| Error tolerance | Hầu hết request thành công | `http_req_failed rate < 0.02` |

### 2.2 Phân biệt với case 03 (domain boundaries)

Case 03 và case 04 đều test routing, nhưng khác nhau về mục đích:

| Khía cạnh | Case 03 (domain boundaries) | Case 04 (origin cacheable read) |
| --- | --- | --- |
| Số service được test | 6 service (app, auth, cart, order, products, report) | 1 service (products-service) |
| Số endpoint | 6 (mỗi service 1 endpoint) | 6 (tất cả đều là product endpoints) |
| Workload pattern | 1 VU, 1 iteration, sequential | 2 scenarios: warmup (6 VU) + measurement (16 VU) |
| Duration | < 1 giây | 45 giây (15s warmup + 30s measurement) |
| Traffic profiles | Không dùng | Có -- 5 profile với phân bổ weighted |
| Mục đích chính | Chứng minh routing đa dạng | Chứng minh routing + chịu tải cho một service |
| HTTP method | GET + POST | Chỉ GET |

Case 04 là **phiên bản chịu tải (load-bearing)** của phần product routing trong case 03.

### 2.3 Tại sao capability này quan trọng

Trong production, khi CDN gặp sự cố:

```text
Bình thường:      10,000 req/s → CDN (85% HIT) → 1,500 req/s đến origin
CDN sự cố:        10,000 req/s → CDN (0% HIT)  → 10,000 req/s đến origin (tăng 6.7x)
```

LB và products-service phải hấp thụ lượng traffic tăng đột biến này. Nếu LB route sai hoặc products-service không chịu nổi tải:

- Request bị route sang service khác → service đó cũng bị quá tải (hiệu ứng domino)
- Request bị timeout → người dùng thấy lỗi → rời bỏ nền tảng
- Không có trace ID → không thể debug hoặc đo lường impact

Case 04 xác minh rằng LB có thể **route đúng và chịu tải** trong điều kiện không có CDN -- tức là điều kiện tồi tệ nhất cho origin.

---

## 3. Vì sao phải test ở LB layer

### 3.1 LB là điểm vào duy nhất khi không có CDN

```text
Có CDN:    Người dùng → CDN (:80) → [HIT: trả cache] hoặc [MISS: forward] → LB → Origin
Không CDN: Người dùng → LB (:80) → Origin
```

Khi topology là `full-no-cdn`, LB là **điểm tiếp xúc đầu tiên và duy nhất** với người dùng. Không có CDN để che chắn. Mọi request -- dù là 1 hay 10,000 req/s -- đều đi thẳng vào LB.

Test ở LB layer trong điều kiện này trả lời câu hỏi: **"Nếu ngày mai CDN chết, người dùng có còn mua được hàng không?"**

### 3.2 So sánh với test ở CDN layer

| Khía cạnh | Test ở CDN layer (case cdn-01, cdn-02...) | Test ở LB layer (case này) |
| --- | --- | --- |
| Điểm quan sát | CDN/Varnish | Nginx LB |
| Cache state | Có (`X-Cache: HIT/MISS`) | Không có cache |
| Request flow | Client → Varnish → Nginx → Service | Client → Nginx → Service |
| Mục tiêu | Cache hit ratio, variant key, stale-while-error | Routing đúng, chịu tải, không có cache signal |
| Header quan trọng nhất | `X-Cache` | `X-Upstream-Service` |

Case 04 là **phần bổ sung** cho CDN test. CDN test chứng minh cache hoạt động; case 04 chứng minh rằng ngay cả khi cache không hoạt động, hệ thống vẫn hoạt động.

### 3.3 Evidence từ sự vắng mặt của `X-Cache`

Không giống như CDN test (nơi `X-Cache: HIT` là tin tốt), case này coi `X-Cache` là **tin xấu**:

```text
Nếu X-Cache xuất hiện:  Request đang đi qua CDN → không test được khả năng chịu tải của LB một mình
Nếu X-Cache vắng mặt:   Request đi thẳng LB → đúng topology → evidence có giá trị
```

Đây là một ví dụ của "negative signal" -- tín hiệu phủ định quan trọng không kém tín hiệu khẳng định.

### 3.4 Traffic profiles -- tại sao phải test với variant headers

Trong môi trường thực tế, không phải mọi request đều giống hệt nhau. Người dùng từ Việt Nam dùng mobile có thể thấy sản phẩm khác với người dùng từ US dùng desktop. Các header variant (`Accept-Language`, `X-Geo-Country`, `X-Device-Class`, `X-Ab-Variant`, `X-User-Segment`) mô phỏng sự đa dạng này.

Khi không có CDN, các variant header này **vẫn được gửi** vì:

- Service có thể dùng chúng để cá nhân hóa response (ngay cả khi không có cache)
- Trong tương lai, nếu CDN được khôi phục, cache key đã được tính đúng từ đầu
- Test với variant header giúp phát hiện lỗi routing liên quan đến header (vd: Nginx route dựa trên header thay vì path)

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌─────────────────────────┐
                          │    k6 test script        │
                          │  (04-origin-cacheable-   │
                          │   read.js)               │
                          └──────────┬──────────────┘
                                     │
                          GET qua :80 với variant headers
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx LB/Gateway)                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Nginx location /api/sim/products                         │  │
│  │  ├─ Match tất cả product paths                            │  │
│  │  ├─ proxy_pass http://products-service                    │  │
│  │  ├─ Thêm X-Upstream-Service: products-service            │  │
│  │  └─ Thêm X-Request-ID: $request_id                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│             │                                                    │
│             ▼                                                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  products-service (internal :8084)                        │  │
│  │  ├─ /api/sim/products              → danh sách sản phẩm   │  │
│  │  ├─ /api/sim/products/1            → chi tiết sản phẩm    │  │
│  │  ├─ /api/sim/products/categories   → danh mục             │  │
│  │  ├─ /api/sim/products/search       → tìm kiếm             │  │
│  │  ├─ /api/sim/products/1/recommendations → đề xuất         │  │
│  │  └─ /api/sim/products/homefeed     → homefeed             │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `full-no-cdn` (bắt buộc) | `docker ps` thấy Nginx + products-service |
| `BASE_URL` | `http://localhost:80` | `curl -sI http://localhost:80/api/sim/products` thấy `Server: nginx/...` |
| `ScaleApp` | Tối thiểu 2 | `docker ps --filter "name=app"` thấy 2+ container app |
| Products service | Đang chạy và healthy | `curl http://localhost:80/api/sim/products` trả về JSON |
| Không CDN | Không có Varnish container | `docker ps --filter "name=varnish"` không có kết quả |

### 4.3 Stack khởi động

```powershell
# Điều hướng đến thư mục gốc của project
cd E:\Projects\k6\k6-metrics-server

# Khởi động stack full-no-cdn với 2 app instance
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
```

Đợi tất cả service healthy (khoảng 30-60 giây). Kiểm tra:

```powershell
# Xác nhận Nginx đang chạy
docker ps --filter "name=nginx"

# Xác nhận products-service đang chạy
docker ps --filter "name=products-service"

# Xác nhận product endpoints hoạt động
curl -s http://localhost:80/api/sim/products | ConvertFrom-Json | Select-Object -First 1
curl -s http://localhost:80/api/sim/products/1 | ConvertFrom-Json
curl -s http://localhost:80/api/sim/products/search?q=shoe | ConvertFrom-Json
```

### 4.4 Biến môi trường

```powershell
# Bắt buộc
$env:BASE_URL = "http://localhost:80"

# Tùy chỉnh (có default)
$env:LB_CACHEABLE_WARMUP_VUS = "6"              # Default: 6
$env:LB_CACHEABLE_MEASUREMENT_VUS = "16"        # Default: 16
$env:LB_CACHEABLE_WARMUP_DURATION = "15s"       # Default: 15s
$env:LB_CACHEABLE_MEASUREMENT_DURATION = "30s"  # Default: 30s
$env:LB_CACHEABLE_SLEEP_MAX = "0.2"             # Default: 0.2 (giây)
```

### 4.5 Precondition

Script case 04 **không có `setup()` function**. Không cần precondition như warmup cache (vì không có cache layer). Hai scenario trong script (warmup và measurement) tự quản lý trạng thái:

- **Warmup scenario**: Chạy 6 VU trong 15 giây -- mục đích là "làm nóng" connection pool giữa Nginx và products-service, không phải làm nóng cache
- **Measurement scenario**: Chạy 16 VU trong 30 giây -- đây là phase thu thập metrics chính

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\lb\04-origin-cacheable-read.js
```

Script dài 79 dòng, phức tạp hơn case 03 đáng kể. Nó sử dụng **2 scenario** (warmup + measurement) với **constant-vus executor**, weighted random API selection, và weighted random traffic profile selection.

### 5.2 Import và dependency

```javascript
import { sleep } from 'k6';

import { envFloat, envInt, envString } from '../shared/common.js';
import { assertLBResponse, lbTrafficProfiles, pickOriginCacheableApi, requestLB } from './shared.js';
```

| Import | Nguồn | Vai trò |
| --- | --- | --- |
| `sleep` | `k6` | Built-in -- tạm dừng VU giữa các request |
| `envFloat`, `envInt`, `envString` | `../shared/common.js` | Đọc biến môi trường với fallback |
| `assertLBResponse` | `./shared.js` | Assert 5-6 checks cho mỗi response |
| `lbTrafficProfiles` | `./shared.js` | Alias của `trafficProfiles` từ `traffic.js` (5 traffic profiles) |
| `pickOriginCacheableApi` | `./shared.js` | Chọn weighted-random một product API từ `lbOriginCacheableApis` |
| `requestLB` | `./shared.js` | Gửi HTTP request đến LB |

### 5.3 `lbOriginCacheableApis` -- dữ liệu cốt lõi

Được định nghĩa trong `shared.js` (dòng 23-26):

```javascript
export const lbOriginCacheableApis = cacheableApis.map((api) => ({
  ...api,
  expectedUpstream: 'products-service',
}));
```

`cacheableApis` từ `traffic.js` định nghĩa 6 product endpoints với weights. `lbOriginCacheableApis` kế thừa tất cả thuộc tính và **ghi đè** `expectedUpstream` thành `'products-service'`:

| Endpoint | Path | Weight | expected (status) | expectedUpstream |
| --- | --- | --- | --- | --- |
| `products_list` | `/api/sim/products` | 25 | 200 | `products-service` |
| `products_detail` | `/api/sim/products/1` | 20 | 200 | `products-service` |
| `products_categories` | `/api/sim/products/categories` | 15 | 200 | `products-service` |
| `products_search` | `/api/sim/products/search?q=shoe` | 15 | 200 | `products-service` |
| `products_recommendations` | `/api/sim/products/1/recommendations` | 15 | 200 | `products-service` |
| `products_homefeed` | `/api/sim/products/homefeed` | 10 | 200 | `products-service` |

**Phân tích weight distribution:**

```text
products_list:            █████████████████████████ 25  (có query string rỗng, response lớn nhất)
products_detail:          ████████████████████     20  (response trung bình)
products_search:          ███████████████          15  (có query string)
products_categories:      ███████████████          15  (response nhỏ)
products_recommendations: ███████████████          15  (response trung bình)
products_homefeed:        ██████████              10  (response lớn, ít phổ biến hơn)
```

Tổng weight = 100, nên weight đồng thời là phần trăm. `pickOriginCacheableApi()` dùng hàm `chooseWeighted()` từ `common.js`, thực hiện weighted random selection.

### 5.4 Hàm `chooseProfile()` -- chọn traffic profile ngẫu nhiên

```javascript
function chooseProfile() {
  const total = lbTrafficProfiles.reduce((sum, item) => sum + item.weight, 0);
  const pick = Math.random() * total;
  let current = 0;
  for (const profile of lbTrafficProfiles) {
    current += profile.weight;
    if (pick <= current) {
      return profile;
    }
  }
  return lbTrafficProfiles[0];
}
```

Đây là implementation của **weighted random selection**. Cách hoạt động:

1. Tính tổng weight: 35 + 20 + 20 + 15 + 10 = 100
2. Chọn một số ngẫu nhiên trong khoảng [0, 100)
3. Duyệt qua các profile, cộng dồn weight cho đến khi vượt qua số đã chọn
4. Trả về profile tại vị trí đó

**Ví dụ cụ thể:**

```text
pick = 42.7

Duyệt:
  vn_mobile_guest_control:    current = 0 + 35 = 35    (42.7 > 35 → tiếp tục)
  vn_mobile_returning_a:      current = 35 + 20 = 55   (42.7 <= 55 → CHỌN)

→ Profile được chọn: vn_mobile_returning_a (20%)
```

### 5.5 `options` block

```javascript
export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-vus',
      vus: WARMUP_VUS,
      duration: WARMUP_DURATION,
      exec: 'runCacheableTraffic',
      tags: {
        phase: 'warmup',
        scenario: 'lb_origin_cacheable_read',
        target_layer: 'lb',
        lb_profile: 'full-no-cdn',
      },
    },
    measurement: {
      executor: 'constant-vus',
      vus: MEASUREMENT_VUS,
      duration: MEASUREMENT_DURATION,
      startTime: MEASUREMENT_START,
      exec: 'runCacheableTraffic',
      tags: {
        phase: 'measurement',
        scenario: 'lb_origin_cacheable_read',
        target_layer: 'lb',
        lb_profile: 'full-no-cdn',
      },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<1500'],
  },
};
```

Phân tích từng phần:

#### Scenarios

**Warmup scenario:**

| Thuộc tính | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `executor` | `constant-vus` | Giữ số VU không đổi trong suốt duration |
| `vus` | `6` (default) | 6 VU chạy đồng thời |
| `duration` | `15s` (default) | Chạy trong 15 giây |
| `exec` | `runCacheableTraffic` | Hàm thực thi (không phải `default`) |
| `tags.phase` | `warmup` | Phân biệt metrics warmup vs measurement |

Mục đích của warmup: **làm nóng connection pool** giữa Nginx và products-service. Khi bắt đầu measurement, các TCP connection đã được thiết lập sẵn, tránh cold-start latency ảnh hưởng đến kết quả.

**Measurement scenario:**

| Thuộc tính | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `executor` | `constant-vus` | Giữ số VU không đổi |
| `vus` | `16` (default) | 16 VU chạy đồng thời |
| `duration` | `30s` (default) | Chạy trong 30 giây |
| `startTime` | `15s` (default, bằng warmup duration) | Bắt đầu SAU KHI warmup kết thúc |
| `exec` | `runCacheableTraffic` | Cùng hàm với warmup |

**Timeline của 2 scenario:**

```text
T0                     T15s                    T45s
├──────────────────────┼───────────────────────┤
│    warmup (6 VU)     │  measurement (16 VU)  │
│    exec: runCacheable│  exec: runCacheable   │
│    phase: warmup     │  phase: measurement   │
└──────────────────────┴───────────────────────┘
```

#### Thresholds

| Threshold | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `checks` | `rate==1` | 100% checks phải pass -- contract cứng cho correctness |
| `http_req_failed` | `rate<0.02` | Cho phép tối đa 2% request thất bại (mềm hơn case 03 vì có tải) |
| `http_req_duration` | `p(95)<1500` | 95% request phải hoàn thành dưới 1.5 giây |

**Tại sao `http_req_failed` mềm hơn case 03?**

Case 04 chạy với 16 VU concurrent trong 30 giây -- có thể tạo ra hàng nghìn request. Trong môi trường local, một tỷ lệ nhỏ request có thể bị ảnh hưởng bởi:

- Docker network congestion
- Rate limiting ở products-service
- Connection pool exhaustion tạm thời

`rate<0.02` cho phép tối đa 2% request thất bại mà không làm fail case. Đây là ngưỡng thực tế: nếu > 2% thất bại, có vấn đề systematic; nếu < 2%, có thể là noise.

### 5.6 `runCacheableTraffic()` -- hàm thực thi chính

```javascript
export function runCacheableTraffic() {
  const api = pickOriginCacheableApi();
  const profile = chooseProfile();
  const res = requestLB(api, {
    headers: {
      Accept: 'application/json',
      ...profile.headers,
    },
    tags: {
      endpoint: api.name,
      profile: profile.name,
      lb_profile: 'full-no-cdn',
    },
  });

  assertLBResponse(res, api, `${api.name} via lb origin`);
  sleep(Math.random() * SLEEP_MAX);
}
```

Mỗi lần được gọi (bởi mỗi VU, trong mỗi iteration), hàm này thực hiện:

**Bước 1 -- Chọn API ngẫu nhiên:**

```javascript
const api = pickOriginCacheableApi();
```

Gọi `chooseWeighted(lbOriginCacheableApis)` -- weighted random từ 6 product endpoint. `products_list` (weight 25) được chọn nhiều nhất, `products_homefeed` (weight 10) ít nhất.

**Bước 2 -- Chọn traffic profile ngẫu nhiên:**

```javascript
const profile = chooseProfile();
```

Gọi `chooseProfile()` -- weighted random từ 5 traffic profiles. `vn_mobile_guest_control` (weight 35) phổ biến nhất.

**Bước 3 -- Gửi request với variant headers:**

```javascript
const res = requestLB(api, {
  headers: {
    Accept: 'application/json',
    ...profile.headers,
  },
  tags: { ... },
});
```

Headers được merge: `Accept: application/json` (mặc định) + các variant headers từ profile (spread operator `...profile.headers`).

Ví dụ, nếu profile là `vn_mobile_guest_control`, headers sẽ là:

```text
Accept: application/json
Accept-Language: vi
X-Geo-Country: VN
X-Device-Class: mobile
X-Ab-Variant: control
X-User-Segment: guest
```

**Tags được gắn kèm:**

| Tag | Giá trị | Mục đích |
| --- | --- | --- |
| `endpoint` | Tên API (vd: `products_list`) | Lọc metrics theo endpoint |
| `profile` | Tên profile (vd: `vn_mobile_guest_control`) | Lọc metrics theo nhóm người dùng |
| `lb_profile` | `full-no-cdn` | Xác nhận topology |

**Bước 4 -- Assert response:**

```javascript
assertLBResponse(res, api, `${api.name} via lb origin`);
```

Label có dạng `"products_list via lb origin"` để phân biệt với các case LB khác.

5 checks được thực thi:

1. Status = 200
2. Served by nginx
3. `X-Upstream-Service === 'products-service'`
4. `X-Request-ID` present
5. `X-Cache` absent

**Bước 5 -- Sleep:**

```javascript
sleep(Math.random() * SLEEP_MAX);
```

Mỗi VU ngủ một khoảng ngẫu nhiên từ 0 đến 0.2 giây giữa các request. Mục đích:

- Tránh tất cả VU gửi request cùng một thời điểm chính xác (spike đồng bộ)
- Mô phỏng hành vi người dùng thực tế (không phải bot)

### 5.7 Sơ đồ tổ chức toàn bộ script

```text
┌─ Constants (từ env vars)
│   ├─ WARMUP_VUS = 6
│   ├─ MEASUREMENT_VUS = 16
│   ├─ WARMUP_DURATION = '15s'
│   ├─ MEASUREMENT_DURATION = '30s'
│   ├─ MEASUREMENT_START = '15s'
│   └─ SLEEP_MAX = 0.2
│
├─ chooseProfile()
│   └─ Weighted random selection từ 5 traffic profiles
│
├─ options
│   ├─ scenarios.warmup:   constant-vus, 6 VU, 15s, exec: runCacheableTraffic
│   ├─ scenarios.measurement: constant-vus, 16 VU, 30s, startTime: 15s, exec: runCacheableTraffic
│   └─ thresholds
│       ├─ checks: rate==1
│       ├─ http_req_failed: rate<0.02
│       └─ http_req_duration: p(95)<1500
│
└─ runCacheableTraffic()  ← exec function cho cả 2 scenario
    ├─ api = pickOriginCacheableApi()
    │   └─ chooseWeighted(lbOriginCacheableApis) → 1 trong 6 product endpoints
    ├─ profile = chooseProfile()
    │   └─ Weighted random → 1 trong 5 traffic profiles
    ├─ res = requestLB(api, headers + tags)
    ├─ assertLBResponse(res, api, label)
    │   ├─ check status
    │   ├─ check nginx
    │   ├─ check upstream = products-service
    │   ├─ check request-id present
    │   └─ check X-Cache absent
    └─ sleep(random * 0.2s)
```

---

## 6. Nginx/LB mechanism

### 6.1 Upstream block cho products-service

```nginx
upstream products-service {
    server products-service:8084;
}
```

Products-service là một upstream riêng biệt, lắng nghe trên cổng nội bộ 8084.

### 6.2 Location block cho product paths

```nginx
# Tất cả product path đều đi qua một location block
location /api/sim/products {
    proxy_pass http://products-service;
    proxy_set_header X-Upstream-Service "products-service";
    proxy_set_header X-Request-ID $request_id;
    proxy_set_header Accept-Language $http_accept_language;
    proxy_set_header X-Geo-Country $http_x_geo_country;
    proxy_set_header X-Device-Class $http_x_device_class;
    proxy_set_header X-Ab-Variant $http_x_ab_variant;
    proxy_set_header X-User-Segment $http_x_user_segment;
}
```

Phân tích:

| Directive | Ý nghĩa |
| --- | --- |
| `location /api/sim/products` | Prefix match -- mọi path bắt đầu bằng `/api/sim/products` đều match |
| `proxy_pass http://products-service` | Forward request đến upstream products-service |
| `proxy_set_header X-Upstream-Service "products-service"` | Gắn upstream identifier |
| `proxy_set_header X-Request-ID $request_id` | Gắn trace ID |
| `proxy_set_header Accept-Language $http_accept_language` | Forward ngôn ngữ người dùng |
| `proxy_set_header X-Geo-Country $http_x_geo_country` | Forward vị trí địa lý |
| `proxy_set_header X-Device-Class $http_x_device_class` | Forward loại thiết bị |
| `proxy_set_header X-Ab-Variant $http_x_ab_variant` | Forward A/B test variant |
| `proxy_set_header X-User-Segment $http_x_user_segment` | Forward phân khúc người dùng |

### 6.3 Forward variant headers

Không giống như CDN (nơi variant headers được dùng để tính cache key và phân biệt cache object), ở LB layer, variant headers đơn giản là được **forward nguyên vẹn** đến upstream service:

```text
Client gửi:        Accept-Language: vi
Nginx nhận:        $http_accept_language = "vi"
Nginx forward:     proxy_set_header Accept-Language "vi"
Service nhận:      Accept-Language: vi
Service dùng:      Cá nhân hóa response dựa trên ngôn ngữ (nếu có implement)
```

`$http_<header_name>` là cú pháp của Nginx để truy cập incoming request header. `$http_accept_language` tương ứng với header `Accept-Language` từ client.

### 6.4 Load balancing trong upstream

Với `upstream products-service { server products-service:8084; }`, nếu products-service được scale lên nhiều instance (vd: 3 instance), Nginx sẽ tự động round-robin giữa các instance. Case 04 không yêu cầu scale products-service (chỉ yêu cầu scale app), nhưng nếu muốn test thêm, có thể scale:

```powershell
docker compose up -d --scale products-service=3
```

### 6.5 Tại sao không có `X-Cache`

Trong topology `full-no-cdn`, request flow là:

```text
k6 → Nginx (:80) → products-service (:8084)
```

Không có Varnish ở giữa. Varnish là thành phần duy nhất thêm `X-Cache` header. Vì vậy, trong LB test với `full-no-cdn`, `X-Cache` phải vắng mặt.

Nếu `X-Cache` xuất hiện, chỉ có hai khả năng:

1. Đang chạy sai topology (`full` thay vì `full-no-cdn`)
2. Có một reverse proxy khác (không phải Varnish) thêm header này

---

## 7. Request sequence flow

### 7.1 Timeline toàn bộ script

```text
T0: k6 start
│
├─ WARMUP PHASE (T0 → T15s) ───────────────────────
│  executor: constant-vus, 6 VU
│
│  Mỗi VU, trong mỗi iteration:
│  ├─ pickOriginCacheableApi() → chọn 1 trong 6 product endpoints (weighted)
│  ├─ chooseProfile() → chọn 1 trong 5 traffic profiles (weighted)
│  ├─ GET LB_BASE_URL + api.path với profile.headers
│  │   ├─ Nginx nhận request
│  │   ├─ Match location /api/sim/products
│  │   ├─ Forward đến products-service:8084
│  │   ├─ Products-service xử lý, trả về 200
│  │   └─ Nginx thêm X-Upstream-Service, X-Request-ID
│  ├─ assertLBResponse: status, nginx, upstream, request-id, no-cache
│  └─ sleep(Math.random() * 0.2s)
│
├─ MEASUREMENT PHASE (T15s → T45s) ─────────────────
│  executor: constant-vus, 16 VU
│  startTime: 15s (bắt đầu ngay khi warmup kết thúc)
│
│  Logic giống hệt warmup, nhưng với 16 VU thay vì 6
│  Tags có phase=measurement để phân biệt metrics
│
└─ T45s: k6 end
```

### 7.2 Phân tích request flow cho một request đơn lẻ

Lấy ví dụ một request trong measurement phase:

```text
VU #3, iteration #42:
  1. pickOriginCacheableApi() → products_search (weight 15)
  2. chooseProfile() → us_desktop_guest_control (weight 20)
  3. Build request:
     URL:    http://localhost:80/api/sim/products/search?q=shoe
     Method: GET
     Headers:
       Accept: application/json
       Accept-Language: en
       X-Geo-Country: US
       X-Device-Class: desktop
       X-Ab-Variant: control
       X-User-Segment: guest
     Tags:
       endpoint: products_search
       profile: us_desktop_guest_control
       lb_profile: full-no-cdn
       phase: measurement

  4. Nginx nhận request:
     - Match location /api/sim/products (prefix match)
     - Forward đến products-service:8084
     - Thêm: X-Upstream-Service: products-service
     - Thêm: X-Request-ID: f3a8b2c1d4e5...
     - Forward variant headers

  5. Products-service xử lý:
     - Query "shoe" trong database
     - Trả về JSON array kết quả
     - Status: 200

  6. k6 nhận response → assertLBResponse:
     - ✓ products_search via lb origin status (200)
     - ✓ products_search via lb origin served by nginx
     - ✓ products_search via lb origin upstream matches (products-service)
     - ✓ products_search via lb origin request id present
     - ✓ products_search via lb origin no cache header

  7. VU #3 sleep(Math.random() * 0.2) → ~0.13s
  8. VU #3 bắt đầu iteration #43
```

### 7.3 Ước tính số lượng request

Với default config:

```text
Warmup:  6 VU  x 15s / (response_time + sleep_time)
         ≈ 6 x 15 / (0.005 + 0.1)
         ≈ 6 x 15 / 0.105
         ≈ 857 requests

Measurement: 16 VU x 30s / (response_time + sleep_time)
            ≈ 16 x 30 / 0.105
            ≈ 4,571 requests

Tổng cộng: ≈ 5,428 requests
```

Đây chỉ là ước tính -- số lượng thực tế phụ thuộc vào response time và sleep time ngẫu nhiên.

---

## 8. Key signals / headers cần verify

### 8.1 Bảng header cần kiểm tra

| Header | Vị trí | Giá trị cần verify | Hàm assert | Xuất hiện ở request nào |
| --- | --- | --- | --- | --- |
| `X-Upstream-Service` | Response | `products-service` | `headerValue(r, 'X-Upstream-Service') === 'products-service'` | Tất cả request |
| `X-Served-By` | Response | `nginx` | `headerValue(r, 'X-Served-By') === 'nginx'` | Tất cả request |
| `Server` | Response | Bắt đầu bằng `nginx/` | `server.startsWith('nginx/')` | Tất cả request (backup) |
| `X-Request-ID` | Response | Chuỗi không rỗng | `!!headerValue(r, 'X-Request-ID')` | Tất cả request |
| `X-Cache` | Response | **PHẢI VẮNG MẶT** | `!headerValue(r, 'X-Cache')` | Tất cả request |
| `Accept-Language` | Request | `vi`, `en`, `ja` (tùy profile) | Không assert -- được gửi bởi profile | Tất cả request |
| `X-Geo-Country` | Request | `VN`, `US`, `SG`, `JP` (tùy profile) | Không assert | Tất cả request |
| `X-Device-Class` | Request | `mobile`, `desktop` | Không assert | Tất cả request |
| `X-Ab-Variant` | Request | `control`, `variant-a`, `variant-b` | Không assert | Tất cả request |
| `X-User-Segment` | Request | `guest`, `returning`, `new_user` | Không assert | Tất cả request |

### 8.2 Chi tiết từng signal

#### `X-Upstream-Service: products-service` -- primary signal

```text
X-Upstream-Service: products-service
```

Khác với case 03 (nơi mỗi request có upstream khác nhau), case 04 có **cùng một expected upstream** cho tất cả request: `products-service`. Điều này có nghĩa:

- Nếu **bất kỳ** request nào có upstream khác → FAIL
- Nếu upstream **thiếu** → FAIL
- Chỉ khi **tất cả** request có upstream = `products-service` → PASS

#### `X-Cache` (vắng mặt) -- negative signal

```text
X-Cache: (header này hoàn toàn không tồn tại trong response)
```

So sánh với case CDN tương ứng (sẽ thấy `X-Cache: HIT` hoặc `MISS`):

| Case | `X-Cache` có xuất hiện? | Ý nghĩa |
| --- | --- | --- |
| cdn-01 (hit smoke) | Có (`HIT` hoặc `MISS`) | Request đi qua Varnish |
| lb-04 (case này) | **Không** | Request đi thẳng Nginx |

#### Variant request headers

Mặc dù không được assert trực tiếp, các variant headers đóng vai trò quan trọng:

1. Chúng mô phỏng traffic thực tế (không phải request "trần")
2. Chúng được forward đến products-service (qua `proxy_set_header`)
3. Chúng được gắn vào k6 tags → cho phép phân tích metrics theo profile

Ví dụ, bạn có thể query k6 metrics để so sánh response time giữa các profile:

```text
http_req_duration{profile:"vn_mobile_guest_control"}  → p95=12ms
http_req_duration{profile:"us_desktop_guest_control"}  → p95=14ms
http_req_duration{profile:"ja_mobile_new_a"}           → p95=11ms
```

### 8.3 Cách đọc header từ k6 output

```text
█ checks...
  ✓ products_list via lb origin status
  ✓ products_list via lb origin served by nginx
  ✓ products_list via lb origin upstream matches
  ✓ products_list via lb origin request id present
  ✓ products_list via lb origin no cache header
  ✓ products_detail via lb origin status
  ...
```

Pattern: `{api.name} via lb origin {check_name}`. "via lb origin" nhấn mạnh rằng request đi qua LB thẳng đến origin, không qua CDN.

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Case được coi là PASS khi **tất cả** các điều kiện sau đều đúng:

| # | Tiêu chí | Cách xác minh | Định lượng |
| --- | --- | --- | --- |
| 1 | k6 exit code = 0 | `$LASTEXITCODE` hoặc CI job status | `exit 0` |
| 2 | Tất cả checks pass | k6 output: `checks... 100%` | `checks rate = 1.0` |
| 3 | HTTP failure rate trong ngưỡng | `http_req_failed rate < 0.02` | < 2% request failed |
| 4 | Response time trong ngưỡng | `http_req_duration p(95) < 1500ms` | p95 < 1500ms |
| 5 | Tất cả upstream = `products-service` | `upstream matches` check pass 100% | 100% upstream correct |
| 6 | Không có `X-Cache` | `no cache header` check pass 100% | 100% no-cache |
| 7 | Tất cả request có `X-Request-ID` | `request id present` check pass 100% | 100% request-id present |

### 9.2 Tiêu chí FAIL

Case FAIL khi **bất kỳ** điều kiện nào sau đây xảy ra:

| # | Dấu hiệu FAIL | Nguyên nhân khả dĩ | Cách debug |
| --- | --- | --- | --- |
| A | `X-Upstream-Service` không phải `products-service` | Nginx location config sai | Kiểm tra `nginx.conf` location `/api/sim/products` |
| B | Có `X-Cache` header | Đang chạy topology `full` (có Varnish) | `docker ps` -- nếu có Varnish, chạy lại với `full-no-cdn` |
| C | Một endpoint trả về 429 | Products-service bị rate limit | Xem xét giảm `MEASUREMENT_VUS` hoặc tăng rate limit |
| D | Một endpoint trả về 404 | Path không tồn tại trong products-service | Kiểm tra API definition trong `cacheableApis` |
| E | `http_req_duration p95 > 1500ms` | Products-service quá tải hoặc network chậm | Giảm VUs, kiểm tra `docker stats` |
| F | `http_req_failed rate >= 0.02` | Quá nhiều request thất bại | Xem k6 output để biết pattern failure |
| G | Thiếu `X-Request-ID` | Nginx config thiếu `proxy_set_header X-Request-ID` | Kiểm tra `nginx.conf` |
| H | `checks rate < 1.0` | Có check fail | Đọc danh sách check ✗ |

### 9.3 Phân biệt FAIL do rate limit vs FAIL do routing

Một trong những thách thức của case 04 là phân biệt giữa hai loại failure:

```text
Loại 1: FAIL do rate limit (acceptable trong một số ngữ cảnh)
  - Chỉ ảnh hưởng endpoint có lưu lượng cao (products_list)
  - Status = 429
  - Check "status" fail, nhưng "upstream matches" vẫn pass

Loại 2: FAIL do routing sai (không bao giờ acceptable)
  - Có thể ảnh hưởng bất kỳ endpoint nào
  - X-Upstream-Service != 'products-service'
  - Check "upstream matches" fail
```

Nếu bạn thấy failure chỉ ở `products_list` status check và upstream vẫn đúng → đây là rate limit. Nếu bạn thấy failure ở `upstream matches` → đây là routing sai, cần fix ngay.

### 9.4 Ma trận quyết định

| Tình trạng | Upstream đúng? | Response time p95 | Failed rate | Kết luận | Hành động |
| --- | --- | --- | --- | --- | --- |
| A | Có | < 1500ms | < 2% | PASS hoàn toàn | Không cần làm gì |
| B | Có | < 1500ms | >= 2% (toàn 429) | Rate limit -- giảm tải | Giảm `MEASUREMENT_VUS` |
| C | Có | >= 1500ms | < 2% | Service chậm | Tăng resource cho products-service |
| D | Không | Bất kỳ | Bất kỳ | Routing sai | Sửa `nginx.conf` |
| E | Có | Bất kỳ | Bất kỳ (có X-Cache) | Sai topology | Chạy lại với `full-no-cdn` |

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy

```powershell
# 1. Di chuyển đến thư mục gốc
cd E:\Projects\k6\k6-metrics-server

# 2. Set biến môi trường
$env:BASE_URL = "http://localhost:80"

# 3. Chạy với default config
.\scripts\run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 04-origin-cacheable-read

# Hoặc chạy trực tiếp bằng k6:
k6 run .\load-target\k6\lb\04-origin-cacheable-read.js
```

### 10.2 Tuned correctness run (khuyến nghị cho môi trường local)

Default config (6+16 VU) có thể gây rate limit trong môi trường local. Để chạy correctness-only:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:LB_CACHEABLE_WARMUP_VUS = "1"
$env:LB_CACHEABLE_MEASUREMENT_VUS = "2"
$env:LB_CACHEABLE_WARMUP_DURATION = "5s"
$env:LB_CACHEABLE_MEASUREMENT_DURATION = "10s"

k6 run .\load-target\k6\lb\04-origin-cacheable-read.js
```

### 10.3 Output mẫu mong đợi (PASS -- tuned correctness)

```text

         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: .\load-target\k6\lb\04-origin-cacheable-read.js
     output: -

  scenarios: (100.00%) 2 scenarios, 16 max VUs, 1m0s max duration (incl. graceful stop):
           * warmup: 1 looping VUs for 5s (exec: runCacheableTraffic, startTime: 0s, gracefulStop: 30s)
           * measurement: 2 looping VUs for 10s (exec: runCacheableTraffic, startTime: 5s, gracefulStop: 30s)


     checks........................: 100.00% ✓ 1160   ✗ 0
     data_received..................: 1.2 MB  ...
     data_sent......................: 280 kB  ...
     http_req_blocked...............: avg=0.00ms  ...
     http_req_connecting............: avg=0.00ms  ...
     http_req_duration..............: avg=3.20ms  p(95)=8.50ms
     http_req_failed................: 0.00%  ✓ 0      ✗ 232
     http_req_receiving.............: avg=0.12ms  ...
     http_req_sending...............: avg=0.01ms  ...
     http_req_waiting...............: avg=3.07ms  ...
     http_reqs......................: 232     ...
     iteration_duration.............: avg=3.45ms  ...
     iterations.....................: 232     ...
     vus............................: 1       min=1  max=2
     vus_max........................: 16      min=16 max=16


█ checks...
  ✓ products_list via lb origin status
  ✓ products_list via lb origin served by nginx
  ✓ products_list via lb origin upstream matches
  ✓ products_list via lb origin request id present
  ✓ products_list via lb origin no cache header
  ✓ products_detail via lb origin status
  ✓ products_detail via lb origin served by nginx
  ✓ products_detail via lb origin upstream matches
  ✓ products_detail via lb origin request id present
  ✓ products_detail via lb origin no cache header
  ...

   ✓ checks........................: 100.00% ✓ 1160   ✗ 0
     ✓ { phase:measurement, scenario:lb_origin_cacheable_read }...: 100.00% ✓ 900    ✗ 0
     ✓ { phase:warmup, scenario:lb_origin_cacheable_read }...: 100.00% ✓ 260    ✗ 0


running (0m15.0s), 0/2 VUs, 232 complete and 0 interrupted iterations
warmup     ✓ [======================================] 1 VUs   5s
measurement ✓ [======================================] 2 VUs  10s
```

### 10.4 Output mẫu khi FAIL (rate limit với default config)

```text
█ checks...
  ✓ products_list via lb origin served by nginx
  ✓ products_list via lb origin upstream matches
  ✗ products_list via lb origin status
    ↳ 94% — ✓ 423 / ✗ 27
  ...

   ✗ checks........................: 95.54%  ✓ 11396   ✗ 534
     ✗ { phase:measurement, scenario:lb_origin_cacheable_read }...: 95.54%  ✓ 11396   ✗ 534

ERRO[0047] thresholds on metrics 'checks' were crossed; at least one has failed
```

Lưu ý: `upstream matches` **vẫn pass** -- chỉ `status` fail. Đây là dấu hiệu của rate limit (status 429), không phải routing sai.

### 10.5 Cách đọc output

| Phần output | Ý nghĩa | Hành động |
| --- | --- | --- |
| `scenarios: 2 scenarios` | Warmup + measurement | Đúng |
| `http_req_duration p(95)=8.50ms` | Response time rất thấp | Tốt -- service hoạt động nhanh |
| `http_req_failed: 0.00%` | Không request nào thất bại | Tốt |
| `✓ checks...: 100.00%` | Tất cả checks pass | Case PASS |
| `phase:measurement` và `phase:warmup` | Metrics được phân tách theo phase | Hữu ích để so sánh warmup vs measurement |
| `vus_max: 16` | Số VU tối đa được cấp phát | Đúng (warmup 6 + measurement 16, nhưng chỉ measurement chạy sau warmup) |

---

## 11. 4 output -> decision scenarios

### Scenario 1: ALL PASS (tuned correctness)

```text
✓ checks 100%
http_req_failed: 0.00%
http_req_duration p95: 8.50ms
```

**Kết luận:** Products-service được route đúng, không có CDN interference, response time tốt dưới tải thấp.

**Quyết định:** Hệ thống sẵn sàng cho production với điều kiện tải thấp đến trung bình. Có thể tự tin rằng khi CDN gặp sự cố, product reads vẫn hoạt động bình thường qua LB.

### Scenario 2: Rate limit với default config

```text
✗ checks 95.54% (chỉ fail ở status check của products_list)
http_req_failed: 22.38% (toàn bộ là 429)
http_req_duration p95: ~5ms (request bị chặn nhanh)
upstream matches: VẪN PASS 100%
```

**Phân tích:**
- Upstream vẫn đúng → routing OK
- Chỉ `products_list` bị ảnh hưởng (endpoint có weight cao nhất)
- Status 429 → products-service có rate limiter
- Response time vẫn thấp → rate limiter trả về 429 nhanh, không làm chậm hệ thống

**Quyết định:**
- Đây là **expected behavior** trong môi trường local với default config
- KHÔNG phải là bug -- rate limiter đang làm đúng nhiệm vụ
- Để có PASS, dùng tuned config với VU thấp hơn
- Nếu muốn test chịu tải thực sự, cần môi trường production-like (nhiều CPU, nhiều instance hơn)

### Scenario 3: Routing sai -- upstream không phải products-service

```text
✗ products_search via lb origin upstream matches
  (expected products-service, got cart-service)

Tất cả product endpoints đều bị sai upstream
```

**Phân tích:**
- Toàn bộ product traffic bị route nhầm sang cart-service
- Đây là lỗi nghiêm trọng -- người dùng không thể xem sản phẩm

**Nguyên nhân khả dĩ:**
1. `location /api/sim/products` có `proxy_pass http://cart-service` (copy-paste error)
2. upstream `products-service` block trỏ đến sai cổng
3. Thiếu `location /api/sim/products` → request rơi vào default → route đến app

**Quyết định:**
- **Dừng triển khai ngay** -- sửa `nginx.conf`
- Reload Nginx: `docker exec <nginx-container> nginx -s reload`
- Chạy lại case 03 + case 04 để xác nhận fix

### Scenario 4: Có `X-Cache` -- sai topology

```text
✗ products_list via lb origin no cache header
✗ products_detail via lb origin no cache header
... (tất cả request fail no-cache check)

Nhưng upstream matches VẪN PASS
```

**Phân tích:**
- Có `X-Cache` header → request đang đi qua Varnish
- Upstream vẫn đúng → Varnish forward đúng đến products-service

**Nguyên nhân:**
- Stack được khởi động với `-TargetLayer full` thay vì `full-no-cdn`

**Quyết định:**
- Khởi động lại stack với `-TargetLayer full-no-cdn`
- Xác nhận: `curl -sI http://localhost:80/api/sim/products | grep -i x-cache` → không có output

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Case này test cache, nhưng không có cache"

```text
Sai:    "Case 04 test cacheable reads → phải có cache để test"
Đúng:   Case 04 test cacheable reads TRONG ĐIỀU KIỆN KHÔNG CÓ CACHE.
        Nó trả lời câu hỏi: "Khi CDN không hoạt động, product reads có hoạt động không?"
```

**Giải thích:** "Cacheable" trong tên case không có nghĩa là "đang được cache", mà có nghĩa là "đây là những endpoint mà trong điều kiện bình thường SẼ ĐƯỢC cache bởi CDN". Case này test điều kiện bất thường: CDN không có mặt.

### Nghịch lý 2: "429 là bug"

```text
Sai:    "Case fail vì có 429 → phải fix"
Đúng:   429 có thể là expected behavior của rate limiter. Vấn đề là case
        được thiết kế cho correctness, không phải cho capacity benchmark.
        Nếu muốn test capacity, cần điều chỉnh config.
```

**Giải thích:** Case 07 (rate limit and connection pressure) được thiết kế riêng để test rate limiting -- case đó có custom metrics `lb_pressure_200`, `lb_pressure_429`, `lb_pressure_unexpected` để phân loại. Case 04 không có custom metrics cho 429 -- vì vậy 429 làm fail case. Nhưng điều này không có nghĩa rate limiter sai -- nó có nghĩa bạn cần giảm tải hoặc dùng case khác.

### Nghịch lý 3: "Warmup scenario là để warm cache"

```text
Sai:    Warmup scenario để làm nóng cache (như CDN case)
Đúng:   Trong full-no-cdn, KHÔNG CÓ CACHE. Warmup scenario để làm nóng
        CONNECTION POOL giữa Nginx và products-service.
```

**Giải thích:** Trong CDN case, warmup có nghĩa là gửi request để fill cache (MISS → HIT). Trong LB case, warmup có nghĩa là thiết lập TCP connection, DNS resolution, và để hệ thống ổn định trước khi bắt đầu thu thập metrics.

### Nghịch lý 4: "Variant headers không có ý nghĩa khi không có cache"

```text
Sai:    Không có cache thì variant headers vô dụng
Đúng:   Variant headers vẫn quan trọng vì:
        1. Service có thể dùng chúng để cá nhân hóa response
        2. Test với header thật giúp phát hiện lỗi routing liên quan đến header
        3. Mô phỏng traffic thực tế (không phải traffic "phòng thí nghiệm")
```

### Nghịch lý 5: "Case 04 giống case 03 nhưng chỉ test 1 service"

```text
Sai:    Case 04 là phiên bản rút gọn của case 03
Đúng:   Case 04 test một khía cạnh hoàn toàn khác: khả năng chịu tải
        của routing trong điều kiện không CDN. Case 03 test tính đa dạng
        của routing (6 service). Cả hai bổ trợ cho nhau.
```

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=nginx"` | Có container Nginx | Khởi động stack |
| 2 | Products-service đang chạy | `docker ps --filter "name=products-service"` | Có container products-service | Khởi động lại stack với `-TargetLayer full-no-cdn` |
| 3 | App có ít nhất 2 instance | `docker ps --filter "name=app"` | 2+ container app | `-ScaleApp 2` |
| 4 | Public path hoạt động | `curl -sI http://localhost:80/api/sim/products` | HTTP 200, `Server: nginx/...` | Kiểm tra Nginx config |
| 5 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại biến môi trường |
| 6 | Không có Varnish | `docker ps --filter "name=varnish"` | Không có kết quả | Dừng stack, khởi động lại với `-TargetLayer full-no-cdn` |
| 7 | Tất cả product endpoints hoạt động | Chạy curl cho từng endpoint trong `lbOriginCacheableApis` | Tất cả trả 200 | Kiểm tra products-service |
| 8 | Không có test khác đang chạy | Kiểm tra k6 process | Không có | Đợi test khác hoàn thành |

### 13.2 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 9 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\lb\04-origin-cacheable-read.js"` |
| 10 | `shared.js` export đúng `lbOriginCacheableApis`, `pickOriginCacheableApi`, `lbTrafficProfiles` | Import không lỗi |
| 11 | `cacheableApis` có 6 endpoint với weight tổng = 100 | Xác nhận weighted selection hoạt động đúng |
| 12 | `trafficProfiles` có 5 profile với weight tổng = 100 | Xác nhận phân bổ traffic đúng |
| 13 | Default config có gây rate limit không? | Nếu có, chuẩn bị tuned config |

### 13.3 K6 checklist

| # | Mục kiểm tra |
| --- | --- |
| 14 | k6 đã được cài đặt: `k6 version` |
| 15 | Không có biến môi trường nào conflict (`K6_*` env vars) |
| 16 | Script chạy khoảng 45 giây với default config, 15 giây với tuned config |
| 17 | Terminal/CI có đủ timeout (> 60 giây) |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Thêm endpoint dynamic (không cacheable) vào mix

```javascript
// Variation 1: Mixed cacheable + dynamic reads
// Thêm một endpoint dynamic (auth me) vào mix để test routing isolation

import { lbBoundaryApis, pickOriginCacheableApi } from './shared.js';

const mixedApis = [
  ...lbOriginCacheableApis,
  { name: 'auth_me', method: 'GET', path: '/api/sim/auth/me', expected: 200, expectedUpstream: 'auth-service', weight: 10 },
];

function pickMixedApi() {
  return chooseWeighted(mixedApis);
}

export function runCacheableTraffic() {
  const api = pickMixedApi();  // Có thể là product HOẶC auth
  const profile = chooseProfile();
  const res = requestLB(api, {
    headers: { Accept: 'application/json', ...profile.headers },
    tags: { endpoint: api.name, profile: profile.name, lb_profile: 'full-no-cdn' },
  });
  assertLBResponse(res, api, `${api.name} via lb origin`);
  sleep(Math.random() * SLEEP_MAX);
}
```

**Điểm học:** Khi bạn thêm endpoint không phải products-service, `assertLBResponse` vẫn hoạt động đúng vì nó so sánh `X-Upstream-Service` với `api.expectedUpstream` (có thể khác `products-service`). Điều này chứng minh tính linh hoạt của shared helper.

### Variation 2: Chỉ dùng một traffic profile duy nhất

```javascript
// Variation 2: Single profile -- cô lập ảnh hưởng của variant headers

export function runCacheableTraffic() {
  const api = pickOriginCacheableApi();

  // Luôn dùng profile vn_mobile_guest_control
  const profile = lbTrafficProfiles[0];  // vn_mobile_guest_control (35%)

  const res = requestLB(api, {
    headers: {
      Accept: 'application/json',
      ...profile.headers,
    },
    tags: {
      endpoint: api.name,
      profile: 'vn_mobile_guest_control_fixed',
      lb_profile: 'full-no-cdn',
    },
  });

  assertLBResponse(res, api, `${api.name} via lb origin`);
  sleep(Math.random() * SLEEP_MAX);
}
```

**Điểm học:** Khi chỉ dùng một profile, bạn loại bỏ biến số "profile khác nhau có thể gây response time khác nhau". Hữu ích khi debug một vấn đề cụ thể.

### Variation 3: Tăng dần số VU để tìm breaking point

```javascript
// Variation 3: Ramping VUs -- tìm điểm breaking point
// Đổi executor từ constant-vus sang ramping-vus

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 2,
      stages: [
        { duration: '10s', target: 5 },
        { duration: '10s', target: 10 },
        { duration: '10s', target: 20 },
        { duration: '10s', target: 30 },
        { duration: '10s', target: 0 },
      ],
      exec: 'runCacheableTraffic',
      tags: {
        phase: 'ramp',
        scenario: 'lb_origin_cacheable_read_ramp',
        target_layer: 'lb',
        lb_profile: 'full-no-cdn',
      },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate<0.05'],  // Mềm hơn cho ramp test
    http_req_duration: ['p(95)<2000'],
  },
};
```

**Điểm học:** Ramping VUs giúp tìm ra giới hạn của products-service. Khi response time p95 vượt ngưỡng hoặc failed rate tăng đột biến, bạn đã tìm thấy breaking point.

### Variation 4: So sánh response time giữa các endpoint

```javascript
// Variation 4: Endpoint-specific latency comparison
// Thêm Trend metrics cho từng endpoint

import { Trend } from 'k6/metrics';

const productsListDuration = new Trend('products_list_duration', true);
const productsDetailDuration = new Trend('products_detail_duration', true);
const productsSearchDuration = new Trend('products_search_duration', true);

export function runCacheableTraffic() {
  const api = pickOriginCacheableApi();
  const profile = chooseProfile();
  const res = requestLB(api, {
    headers: { Accept: 'application/json', ...profile.headers },
    tags: { endpoint: api.name, profile: profile.name, lb_profile: 'full-no-cdn' },
  });

  // Ghi nhận duration riêng cho từng endpoint
  if (api.name === 'products_list') {
    productsListDuration.add(res.timings.duration);
  } else if (api.name === 'products_detail') {
    productsDetailDuration.add(res.timings.duration);
  } else if (api.name === 'products_search') {
    productsSearchDuration.add(res.timings.duration);
  }

  assertLBResponse(res, api, `${api.name} via lb origin`);
  sleep(Math.random() * SLEEP_MAX);
}
```

**Điểm học:** Custom Trend metrics cho phép so sánh response time giữa các endpoint mà không cần lọc bằng tag. Trong k6 output, bạn sẽ thấy:

```text
products_list_duration....: avg=5.2ms   p(95)=12.1ms
products_detail_duration..: avg=3.1ms   p(95)=7.5ms
products_search_duration..: avg=6.8ms   p(95)=14.3ms
```

### Variation 5: Chỉ test một endpoint (targeted stress test)

```javascript
// Variation 5: Single endpoint targeted stress
// Chỉ test products_search -- endpoint có query string

export function runCacheableTraffic() {
  // Luôn chọn products_search
  const api = lbOriginCacheableApis.find(a => a.name === 'products_search');
  const profile = chooseProfile();
  const res = requestLB(api, {
    headers: { Accept: 'application/json', ...profile.headers },
    tags: { endpoint: api.name, profile: profile.name, lb_profile: 'full-no-cdn' },
  });
  assertLBResponse(res, api, `${api.name} via lb origin`);
  sleep(Math.random() * SLEEP_MAX);
}
```

**Điểm học:** Khi debug một endpoint cụ thể (vd: `products_search` có response time cao bất thường), việc cô lập endpoint đó giúp tăng số lượng sample và giảm nhiễu từ các endpoint khác.

---

## 15. Anti-patterns

### Anti-pattern 1: Chạy default config trong môi trường local và mong đợi PASS

```text
SAI:    Dùng default 16 VU, thấy 429, kết luận "hệ thống có bug"
ĐÚNG:   Hiểu rằng default config được thiết kế cho môi trường production-like.
        Trong local, dùng tuned config (2 VU measurement).
```

**Hậu quả:** Mất thời gian debug một "vấn đề" không tồn tại (rate limit là expected behavior).

### Anti-pattern 2: Bỏ qua `X-Cache` check

```text
SAI:    Xóa dòng check `no cache header` khỏi assertLBResponse
        → Case luôn PASS, nhưng không phát hiện được sai topology
ĐÚNG:   Giữ check `no cache header`
        → Nếu sai topology, case FAIL → phát hiện sớm
```

**Hậu quả:** Bạn có thể vô tình chạy case với topology `full` (có CDN) mà không biết. Metrics sẽ đẹp (vì CDN cache) nhưng không có giá trị cho LB capability proof.

### Anti-pattern 3: Không phân biệt phase warmup và measurement

```text
SAI:    Nhìn vào metrics tổng hợp, thấy response time trung bình thấp → kết luận "tốt"
ĐÚNG:   Phân tách metrics theo phase: measurement phase mới là phase chính.
        Warmup phase metrics có thể đẹp hơn vì ít VU hơn.
```

**Hậu quả:** Kết luận sai về hiệu năng. Warmup (6 VU) có thể có response time thấp hơn measurement (16 VU). Nếu bạn nhìn average của cả hai, bạn đánh giá thấp impact của tải cao.

### Anti-pattern 4: Bỏ `sleep()` giữa các request

```text
SAI:    Xóa dòng sleep(Math.random() * SLEEP_MAX)
        → Tất cả VU gửi request liên tục không nghỉ → tải cao hơn thực tế
ĐÚNG:   Giữ sleep với jitter
        → Mô phỏng hành vi người dùng thực tế (có khoảng nghĩ giữa các request)
```

**Hậu quả:** Không có sleep, bạn đang test "busy loop" thay vì traffic pattern thực tế. Điều này có thể kích hoạt rate limit sớm hơn dự kiến.

### Anti-pattern 5: Dùng topology `lb-app` thay vì `full-no-cdn`

```text
SAI:    -TargetLayer lb-app
        → Chỉ có app, không có products-service → request thất bại
ĐÚNG:   -TargetLayer full-no-cdn
        → Có đầy đủ services bao gồm products-service
```

---

## 16. Real validation data

### 16.1 Kết quả thực tế -- default config

```text
Case: lb-04-origin-cacheable-read
Date: 2026-06-21
Stack: full-no-cdn, ScaleApp=2
Config: WARMUP_VUS=6, MEASUREMENT_VUS=16, WARMUP_DURATION=15s, MEASUREMENT_DURATION=30s

Exit code: 99 (FAIL)
Checks: 11396/11930 (95.54%)
HTTP requests: 2386
HTTP failed: 22.38% (534/2386)
Duration: ~47s

Failure analysis:
  534 failures, tất cả là status check fail trên products_list
  Status code thực tế: 429 (Too Many Requests)
  Upstream matches: VẪN PASS 100% (X-Upstream-Service = products-service)
  No cache header: VẪN PASS 100%

Kết luận: Rate limit ở products_list -- không phải routing error.
          Default config quá cao cho môi trường local.
```

### 16.2 Kết quả thực tế -- tuned correctness config

```text
Case: lb-04-origin-cacheable-read
Date: 2026-06-21
Stack: full-no-cdn, ScaleApp=2
Config: WARMUP_VUS=1, MEASUREMENT_VUS=2, WARMUP_DURATION=5s, MEASUREMENT_DURATION=10s

Exit code: 0 (PASS)
Checks: 1160/1160 (100%)
HTTP requests: 232
HTTP failed: 0.00% (0/232)
Duration: ~15s
http_req_duration: avg=3.20ms, p95=8.50ms

Endpoint distribution (ước tính từ weight):
  products_list:            ~58 requests (25%)
  products_detail:          ~46 requests (20%)
  products_categories:      ~35 requests (15%)
  products_search:          ~35 requests (15%)
  products_recommendations: ~35 requests (15%)
  products_homefeed:        ~23 requests (10%)

Profile distribution (ước tính từ weight):
  vn_mobile_guest_control:   ~81 requests (35%)
  vn_mobile_returning_a:     ~46 requests (20%)
  us_desktop_guest_control:  ~46 requests (20%)
  sg_desktop_returning_b:    ~35 requests (15%)
  ja_mobile_new_a:           ~23 requests (10%)

Result: PASS
```

### 16.3 Manual probe -- xác nhận từng endpoint

```powershell
# Xác nhận tất cả product endpoints hoạt động qua LB
$endpoints = @(
  "/api/sim/products",
  "/api/sim/products/1",
  "/api/sim/products/categories",
  "/api/sim/products/search?q=shoe",
  "/api/sim/products/1/recommendations",
  "/api/sim/products/homefeed"
)

foreach ($ep in $endpoints) {
  $response = Invoke-WebRequest -Uri "http://localhost:80$ep" -UseBasicParsing
  $upstream = $response.Headers['X-Upstream-Service']
  $requestId = $response.Headers['X-Request-ID']
  $cache = $response.Headers['X-Cache']
  Write-Host "$ep → upstream=$upstream, requestId=$($requestId -ne $null), cache=$($cache -eq $null ? 'ABSENT' : $cache)"
}

# Expected output:
# /api/sim/products → upstream=products-service, requestId=True, cache=ABSENT
# /api/sim/products/1 → upstream=products-service, requestId=True, cache=ABSENT
# /api/sim/products/categories → upstream=products-service, requestId=True, cache=ABSENT
# /api/sim/products/search?q=shoe → upstream=products-service, requestId=True, cache=ABSENT
# /api/sim/products/1/recommendations → upstream=products-service, requestId=True, cache=ABSENT
# /api/sim/products/homefeed → upstream=products-service, requestId=True, cache=ABSENT
```

### 16.4 Manual probe -- xác nhận variant headers hoạt động

```powershell
# Gửi request với variant headers và kiểm tra chúng được forward
$headers = @{
  "Accept-Language" = "vi"
  "X-Geo-Country" = "VN"
  "X-Device-Class" = "mobile"
  "X-Ab-Variant" = "control"
  "X-User-Segment" = "guest"
}

$response = Invoke-WebRequest -Uri "http://localhost:80/api/sim/products" -Headers $headers -UseBasicParsing

Write-Host "Status: $($response.StatusCode)"
Write-Host "Upstream: $($response.Headers['X-Upstream-Service'])"
Write-Host "Request-ID: $($response.Headers['X-Request-ID'])"
Write-Host "Content-Type: $($response.Headers['Content-Type'])"

# Expected: Status 200, Upstream=products-service, Request-ID present, Content-Type=application/json
```

### 16.5 Concurrent load probe

```powershell
# Gửi 120 request đồng thời để kiểm tra rate limit threshold
1..120 | ForEach-Object -Parallel {
  try {
    $res = Invoke-WebRequest -Uri "http://localhost:80/api/sim/products" -UseBasicParsing -TimeoutSec 5
    return "200"
  } catch {
    return $_.Exception.Response.StatusCode.value__
  }
} -ThrottleLimit 120

# Expected (với môi trường local): ~100 x 200, ~20 x 429
# Điều này xác nhận rate limiter hoạt động và giải thích tại sao default config FAIL
```

---

## 17. Reference

### 17.1 File liên quan

| File | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\04-origin-cacheable-read.js` | Script k6 chính |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\shared.js` | Shared helpers: `lbOriginCacheableApis`, `lbTrafficProfiles`, `pickOriginCacheableApi`, `requestLB`, `assertLBResponse` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\traffic.js` | `cacheableApis` (6 product endpoints), `trafficProfiles` (5 traffic profiles) |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Base helpers: `requestApi`, `chooseWeighted`, `envString`, `envInt`, `envFloat` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\case-catalog.json` | Catalog định nghĩa tất cả 12 LB case (xem case `lb-04-origin-cacheable-read`) |
| `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Nginx config với upstream `products-service` và location `/api/sim/products` |

### 17.2 Case liên quan

| Case | Mối quan hệ |
| --- | --- |
| `lb-03-domain-boundaries` | Test routing cho 6 service khác nhau; case 04 tập trung vào 1 service (products) |
| `lb-05-origin-service-mix` | Giống case 04 nhưng mở rộng ra TẤT CẢ service (auth, cart, order, products, report) với production-like mix |
| `cdn-01-hit-smoke` | Test cacheable reads QUA CDN (có cache); case 04 test cùng endpoints KHÔNG qua CDN |
| `cdn-02-variant-keys` | Test variant cache keys; case 04 dùng variant headers nhưng không có cache |
| `lb-07-rate-limit-and-connection-pressure` | Test riêng về rate limiting; case 04 có thể gặp rate limit với default config |

### 17.3 Tài liệu tham khảo

| Tài liệu | Nội dung |
| --- | --- |
| `./00_overview.md` | Tổng quan series LB -- mental model, key concepts, case inventory |
| `./RUN_GUIDE.md` | Hướng dẫn chạy toàn bộ LB suite |
| `./13_validation-and-chart-analysis.md` | Validation report và phân tích chart cho tất cả LB case |
| `./03_domain-boundaries.md` | Case 03 -- domain boundary routing (nền tảng cho case 04) |
| Nginx upstream module | [nginx.org/en/docs/http/ngx_http_upstream_module.html](https://nginx.org/en/docs/http/ngx_http_upstream_module.html) |
| K6 constant-vus executor | [k6.io/docs/using-k6/scenarios/executors/constant-vus/](https://k6.io/docs/using-k6/scenarios/executors/constant-vus/) |
| K6 scenarios | [k6.io/docs/using-k6/scenarios/](https://k6.io/docs/using-k6/scenarios/) |
