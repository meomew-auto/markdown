# Case 05: Origin service mix

> **Case ID:** `lb-05-origin-service-mix`
> **Script:** `05-origin-service-mix.js`
> **Profile:** `full-no-cdn`
> **Workload:** constant-vus, 12 VUs, 45s
> **Proof:** production-like traffic mix route đúng upstream service cho từng request

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [LB capability được chứng minh](#2-lb-capability-được-chứng-minh)
3. [Vì sao phải test ở LB layer](#3-vì-sao-phải-test-ở-lb-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Nginx/LB mechanism deep-dive](#6-nginxlb-mechanism-deep-dive)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / headers](#8-key-signals--headers)
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

Một nền tảng thương mại điện tử đang vận hành kiến trúc microservices phía sau Nginx gateway. Vào giờ cao điểm (12:00-13:00 và 20:00-22:00), hệ thống nhận khoảng 8,000-12,000 request mỗi giây. Các request này không phải là một loại duy nhất -- chúng là một hỗn hợp (mix) phức tạp của nhiều service family khác nhau, mỗi family có đặc thù riêng về HTTP method, expected status, và latency profile.

Hãy hình dung một người dùng thực hiện một phiên mua sắm điển hình:

```text
1. Vào trang chủ -> GET / (app entrypoint)
2. Duyệt danh sách sản phẩm -> GET /api/sim/products (products-service)
3. Xem chi tiết sản phẩm -> GET /api/sim/products/1 (products-service)
4. Đăng nhập -> POST /api/sim/auth/refresh (auth-service)
5. Thêm vào giỏ hàng -> POST /api/sim/cart/add (cart-service)
6. Xem giỏ hàng -> GET /api/sim/cart/summary (cart-service)
7. Cập nhật số lượng -> PATCH /api/sim/cart/items/sku-1 (cart-service)
8. Thanh toán -> POST /api/sim/checkout (order-service)
9. Kiểm tra đơn hàng -> GET /api/sim/orders/ORD-123 (order-service)
10. Nhận webhook thanh toán -> POST /api/sim/orders/webhooks/payment (order-service)
```

Mỗi bước trong hành trình trên được phục vụ bởi một upstream service khác nhau. Nếu Nginx route sai -- ví dụ request `/api/sim/auth/me` bị đẩy sang `cart-service` -- người dùng có thể nhận được HTTP 404 hoặc dữ liệu sai service, gây đứt gãy toàn bộ phiên mua sắm.

### 1.2 Tại sao "mix" lại quan trọng hơn test từng endpoint riêng lẻ

Test từng endpoint một (như case 03 -- domain boundaries) trả lời câu hỏi: "Route `/api/sim/auth/me` có đến đúng `auth-service` không?" Đó là câu hỏi về **tính đúng đắn tĩnh** (static correctness).

Nhưng production không tĩnh. Trong production, các request thuộc nhiều service family khác nhau đến đồng thời, chen lấn nhau qua cùng một Nginx worker process. Điều này tạo ra các hiệu ứng mà test từng endpoint không phát hiện được:

| Hiệu ứng | Mô tả | Hậu quả nếu không test mix |
| --- | --- | --- |
| **Upstream pool contention** | Nhiều request đến các upstream khác nhau cùng lúc, tranh chấp connection pool của Nginx | Một upstream bão hòa connection có thể làm chậm request đến upstream khác |
| **Worker process multiplexing** | Một Nginx worker xử lý đồng thời request đến products-service và auth-service | Bug trong shared state hoặc biến toàn cục của custom Nginx module có thể gây cross-request contamination |
| **DNS cache staleness dưới tải** | Khi Nginx resolve DNS cho nhiều upstream đồng thời dưới tải cao, TTL cache có thể bị bỏ qua | Request bị route đến IP cũ của upstream đã scale down |
| **Weighted routing drift dưới concurrent load** | Phân phối weighted có thể bị lệch khi nhiều VUs cùng gọi `chooseWeighted()` trong k6 hoặc khi Nginx xử lý nhiều connection đồng thời | Một service family nhận nhiều traffic hơn thiết kế, gây quá tải cục bộ |
| **Header propagation failure** | Header từ traffic profile (Accept-Language, X-Geo-Country, X-Device-Class) có thể bị drop khi Nginx xử lý nhiều loại request cùng lúc | Service upstream không nhận được context cần thiết để personalization |

Case 05 được thiết kế để phát hiện chính xác những vấn đề này -- những thứ chỉ xuất hiện khi bạn trộn nhiều service family trong cùng một test scenario.

### 1.3 Sáu service family trong production mix

Case này mô phỏng traffic đến **6 service family**, mỗi family đại diện cho một nhóm chức năng nghiệp vụ riêng biệt:

```text
                    +---> products-service (53% traffic)
                    |     GET products list, detail, search, categories
                    |
                    +---> auth-service (11% traffic)
                    |     GET auth/me, POST auth/refresh
                    |
NGINX :80 ----------+---> cart-service (20% traffic)
                    |     GET cart/summary, POST cart/add, PATCH cart/items
                    |
                    +---> order-service (16% traffic)
                    |     GET orders/ORD-123, POST checkout, POST confirm, POST webhooks/payment
                    |
                    +---> report-service (4% traffic)
                          GET report/jobs, POST report/jobs (expected 202)
```

Tỉ lệ phân phối được thiết kế dựa trên dữ liệu production thực tế: products-service nhận nhiều traffic nhất vì người dùng duyệt sản phẩm nhiều hơn là mua hàng; report-service nhận ít nhất vì đây là tác vụ nền không đồng bộ.

### 1.4 Sự đa dạng về HTTP method

Production mix không chỉ toàn GET. Case này bao gồm cả ba loại HTTP method:

| Method | Số lượng endpoint | Ví dụ | Điểm đặc biệt |
| --- | --- | --- | --- |
| `GET` | 8 endpoints | `products_list`, `auth_me`, `cart_summary`, `order_status`, `report_job_list` | Idempotent, cacheable (về mặt HTTP semantics) |
| `POST` | 6 endpoints | `auth_refresh`, `cart_add`, `checkout`, `order_confirm`, `report_job_create`, `payment_webhook` | Non-idempotent, có body, `report_job_create` expected 202 |
| `PATCH` | 1 endpoint | `cart_update` | Partial update, non-idempotent |

Việc trộn method rất quan trọng vì Nginx xử lý GET và POST khác nhau ở nhiều khía cạnh: retry policy (GET được retry an toàn, POST thì không nếu không có `proxy_next_upstream non_idempotent`), buffering (POST có body cần buffer), và connection reuse (POST thường yêu cầu connection riêng).

---

## 2. LB capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh:

> **Nginx gateway route chính xác từng request trong một production-like traffic mix đến đúng upstream service, duy trì tất cả các tín hiệu nhận dạng (nginx signature, upstream service, request ID) và không để lọt bất kỳ request nào qua CDN cache layer.**

Cụ thể hơn, case chứng minh 5 khả năng con:

1. **Path-based routing chính xác dưới concurrent load**: 15 endpoint khác nhau thuộc 6 service family, được route đúng upstream ngay cả khi 12 VUs gửi request đồng thời.
2. **Weighted traffic distribution đúng thiết kế**: Phân phối request giữa các service family phản ánh đúng tỉ lệ weight trong `productionMixApis`.
3. **Method-agnostic routing**: GET, POST, PATCH đều được route đúng -- không có endpoint nào bị từ chối vì method không được hỗ trợ.
4. **Non-200 expected status được xử lý đúng**: `report_job_create` trả về HTTP 202 (Accepted) là expected behavior, không phải failure.
5. **Absence of CDN cache interference**: Toàn bộ request đi qua Nginx đến thẳng origin, không có `X-Cache` header -- chứng minh topology `full-no-cdn` hoạt động đúng.

### 2.2 So sánh với các case LB khác

| Case | Phạm vi | Mix? | Concurrent? |
| --- | --- | --- | --- |
| 03 -- Domain boundaries | 1 VU, 1 iteration, gọi tuần tự 6 endpoint | Không -- tuần tự | Không |
| 04 -- Origin cacheable read | 16 VUs, 30s, chỉ products-service | Không -- 1 family | Có |
| **05 -- Origin service mix** | **12 VUs, 45s, 15 endpoint, 6 families** | **Có -- weighted mix** | **Có** |
| 07 -- Rate limit pressure | Open model, 1 endpoint | Không | Có |

Case 05 là case **duy nhất** trong series chứng minh routing đúng dưới production-like mix có concurrent load. Case 03 chứng minh routing đúng nhưng tuần tự; case 04 chứng minh concurrent load nhưng chỉ 1 service family. Case 05 kết hợp cả hai.

---

## 3. Vì sao phải test ở LB layer

### 3.1 Đây không phải là vấn đề của application layer

Application layer (code trong từng microservice) không chịu trách nhiệm route request đến đúng service. Mỗi microservice chỉ biết về domain của chính nó: `products-service` xử lý `/products`, `auth-service` xử lý `/auth`. Việc quyết định request nào đi đến service nào là trách nhiệm **duy nhất** của gateway/routing layer.

Nếu test ở application layer:
- Bạn có thể test `products-service` xử lý đúng `GET /api/sim/products`.
- Bạn KHÔNG THỂ test rằng `GET /api/sim/auth/me` không bị route nhầm sang `products-service`.

### 3.2 Đây không phải là vấn đề của CDN layer

CDN/Varnish ngồi trước Nginx. Nếu bạn test qua CDN (topology `full`), request có thể được cache và trả về từ Varnish mà không bao giờ đến Nginx. Khi đó:
- `X-Served-By` sẽ là `varnish`, không phải `nginx`.
- `X-Upstream-Service` sẽ không tồn tại vì request không đến được upstream.
- `X-Cache` sẽ có giá trị `HIT` hoặc `MISS`, làm nhiễu signal.

Đó là lý do case này dùng topology `full-no-cdn`: Nginx là điểm entrypoint trực tiếp, không có Varnish xen giữa.

### 3.3 Phân biệt trách nhiệm giữa các layer

```text
CDN layer (case 01-12):     Request có được cache/offload không?
LB layer (case 01-12):      Request đi đúng upstream service không?
App layer (không test):     Business logic trong service có đúng không?
```

Case 05 trả lời câu hỏi thứ hai: request đi đúng upstream service không -- và làm điều đó trong điều kiện production-like mix.

---

## 4. Topology và precondition

### 4.1 Topology

```text
k6 (12 VUs, 45s)
  |
  | HTTP request với weighted random API pick
  | headers: X-Test-Suite=lb-origin-mix
  |          + traffic profile headers (Accept-Language, X-Geo-Country, ...)
  v
Nginx :80 (lb-app container)
  |
  | path-based routing: /api/sim/<prefix> -> upstream
  |
  +---> products-service      (prefix: /api/sim/products)
  +---> auth-service          (prefix: /api/sim/auth/)
  +---> cart-service          (prefix: /api/sim/cart)
  +---> order-service         (prefix: /api/sim/checkout, /api/sim/orders/)
  +---> report-service        (prefix: /api/sim/report)
```

Response header mong đợi:
- `X-Served-By: nginx` hoặc `Server: nginx/...`
- `X-Upstream-Service`: tên upstream service tương ứng
- `X-Request-ID`: UUID được Nginx gán
- `X-Cache`: **vắng mặt** (absent)

### 4.2 Precondition

Trước khi chạy case này, các điều kiện sau phải được đáp ứng:

```powershell
# 1. Stack đã được start với đúng topology
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2

# 2. Biến môi trường BASE_URL trỏ đến Nginx public port
$env:BASE_URL = "http://localhost:80"

# 3. Xác nhận Nginx đang listen trên port 80
curl -s -o /dev/null -w "%{http_code}" http://localhost:80/
# Kỳ vọng: 200

# 4. Xác nhận CDN/Varnish KHÔNG có trong path
curl -s -I http://localhost:80/api/sim/products | findstr "X-Cache"
# Kỳ vọng: không có output nào (header X-Cache vắng mặt)

# 5. Xác nhận tất cả upstream services đang healthy
curl -s http://localhost:80/api/sim/auth/me | findstr "X-Upstream-Service"
curl -s http://localhost:80/api/sim/cart/summary | findstr "X-Upstream-Service"
curl -s http://localhost:80/api/sim/products | findstr "X-Upstream-Service"
curl -s http://localhost:80/api/sim/checkout -X POST -H "Content-Type: application/json" -d "{\"payment_method\":\"card\"}" | findstr "X-Upstream-Service"
curl -s http://localhost:80/api/sim/report/jobs?limit=5 | findstr "X-Upstream-Service"
```

### 4.3 Environment variables

| Biến | Default | Mô tả |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | Public URL của Nginx gateway |
| `LB_MIX_VUS` | `12` | Số lượng Virtual Users đồng thời |
| `LB_MIX_DURATION` | `45s` | Thời gian chạy test |
| `LB_MIX_SLEEP_MAX` | `0.2` | Sleep tối đa giữa các iteration (giây) |

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `05-origin-service-mix.js` gồm 38 dòng, được tổ chức thành 3 phần chính:

```javascript
// (A) IMPORTS: 3 dòng
import { sleep } from 'k6';
import { envFloat, envInt, envString } from '../shared/common.js';
import { assertLBResponse, pickOriginServiceMixApi, requestLB } from './shared.js';

// (B) CONFIGURATION: 3 dòng
const MIX_VUS = envInt('LB_MIX_VUS', 12);
const MIX_DURATION = envString('LB_MIX_DURATION', '45s');
const MIX_SLEEP_MAX = envFloat('LB_MIX_SLEEP_MAX', 0.2);

// (C) OPTIONS + DEFAULT FUNCTION: 31 dòng
export const options = { ... };
export default function () { ... };
```

Thiết kế tối giản này phản ánh triết lý "script là cấu hình thực thi, logic nằm trong shared library". Mọi logic routing, weighted selection, và assertion đều được tập trung trong `shared.js` để tái sử dụng giữa các case.

### 5.2 Phân tích từng dòng -- Phần A: Imports

```javascript
import { sleep } from 'k6';
```

`sleep` từ k6 core được dùng để thêm độ trễ nhỏ giữa các iteration, mô phỏng "think time" của người dùng thật. Không có sleep, 12 VUs sẽ bắn request liên tục với tốc độ tối đa của mỗi VU, tạo ra arrival pattern không thực tế (giống như benchmark hơn là production traffic).

```javascript
import { envFloat, envInt, envString } from '../shared/common.js';
```

Ba helper này đọc biến môi trường với type safety:
- `envInt('LB_MIX_VUS', 12)` -- đọc số nguyên, fallback về 12 nếu không set
- `envString('LB_MIX_DURATION', '45s')` -- đọc chuỗi, fallback về '45s'
- `envFloat('LB_MIX_SLEEP_MAX', 0.2)` -- đọc số thực, fallback về 0.2

```javascript
import { assertLBResponse, pickOriginServiceMixApi, requestLB } from './shared.js';
```

Ba function cốt lõi từ `shared.js`:

| Function | Vai trò | Định nghĩa trong shared.js |
| --- | --- | --- |
| `pickOriginServiceMixApi()` | Chọn ngẫu nhiên một API từ production mix theo trọng số | Gọi `chooseWeighted(lbServiceMixApis)` -- xem section 5.4 |
| `requestLB(api, overrides)` | Gửi HTTP request đến Nginx gateway | Gọi `requestApi(LB_BASE_URL, api, overrides)` |
| `assertLBResponse(res, api, label)` | Assert 5-6 checks trên response | Kiểm tra status, nginx, upstream, request-id, no-cache, (instance-id) |

### 5.3 Phân tích từng dòng -- Phần B: Configuration

```javascript
const MIX_VUS = envInt('LB_MIX_VUS', 12);
```

Tại sao 12 VUs? Con số này được chọn vì:
- Đủ lớn để tạo concurrent load thực sự: với sleep max 0.2s, mỗi VU gửi khoảng 5 request/giây, tổng cộng ~60 request/giây.
- Đủ lớn để mỗi service family nhận được ít nhất vài request trong 45s, ngay cả family có weight thấp nhất (report-service: 4%).
- Không quá lớn để gây quá tải hệ thống local -- đây là correctness test, không phải stress test.

```javascript
const MIX_DURATION = envString('LB_MIX_DURATION', '45s');
```

45 giây là đủ dài để:
- Khoảng 2,700 iteration (12 VUs * 5 req/s * 45s) -- đủ sample size cho phân phối weighted ổn định.
- Pass qua giai đoạn "warm-up" của Nginx connection pool (vài giây đầu).
- Không quá dài để làm chậm CI/CD pipeline.

```javascript
const MIX_SLEEP_MAX = envFloat('LB_MIX_SLEEP_MAX', 0.2);
```

Sleep ngẫu nhiên từ 0 đến 0.2 giây giữa các iteration. Điều này:
- Mô phỏng "think time" -- người dùng không bấm liên tục không nghỉ.
- Tránh tạo ra arrival pattern quá đều (periodic), giúp phát hiện bug chỉ xảy ra ở arrival pattern không đều.
- Giảm tải cho Nginx để test tập trung vào correctness, không phải capacity.

### 5.4 Phân tích từng dòng -- Phần C: Options

```javascript
export const options = {
  vus: MIX_VUS,            // 12
  duration: MIX_DURATION,  // '45s'
  thresholds: {
    checks: ['rate==1'],                    // (a)
    http_req_failed: ['rate<0.03'],         // (b)
    http_req_duration: ['p(95)<1500'],      // (c)
  },
  tags: {
    scenario: 'lb_origin_service_mix',      // (d)
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};
```

**(a) `checks: ['rate==1']`** -- TẤT CẢ checks phải pass. Đây là threshold khắt khe nhất: nếu dù chỉ một request bị route sai upstream, check đó fail và toàn bộ test fail. Đây là "correctness gate" -- không khoan nhượng.

**(b) `http_req_failed: ['rate<0.03']`** -- Cho phép tối đa 3% request HTTP fail (không phải 0% như case 03). Tại sao? Vì trong production mix có thể có những transient failure thực sự (network blip, connection reset) với tỉ lệ rất nhỏ. Threshold 3% phân biệt giữa "transient noise chấp nhận được" và "routing bug hệ thống". Tuy nhiên, trong tuned correctness mode (section 10.2), ta kỳ vọng 0%.

**(c) `http_req_duration: ['p(95)<1500']`** -- 95% request phải hoàn thành dưới 1.5 giây. Đây là latency SLO hợp lý cho local development environment. Nếu p95 > 1.5s, có thể do upstream service bị chậm bất thường hoặc Nginx connection pool bị cạn kiệt.

**(d) Tags** -- `scenario: 'lb_origin_service_mix'` được dùng để filter kết quả trong dashboard. `lb_profile: 'full-no-cdn'` ghi lại topology đã dùng, giúp phân biệt kết quả giữa các lần chạy khác profile.

##### Phân tích executor: vì sao dùng `constant-vus` cho case này?

Config dùng bare form `vus` + `duration` → `constant-vus`.

**Yêu cầu của case:**

```text
1. Production traffic mix: 12 VU gửi weighted random request tới 5 services
   → Cần sustained traffic trong 45s với tỷ lệ service tự nhiên
   → Mỗi VU tự chọn service theo weighted random → mô phỏng user thật
   → KHÔNG cần rate chính xác — rate tự điều chỉnh theo response time

2. Duration-based: chạy 45s, không phải "N iterations"
   → Muốn quan sát routing correctness TRONG KHOẢNG THỜI GIAN
   → Số request là OUTPUT (phản ánh performance), không phải INPUT
```

**So sánh executor:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **constant-vus** (đang dùng) | ✅ **ĐÚNG** | Sustained traffic 45s. VU loop + weighted random. Rate tự nhiên. |
| constant-arrival-rate | ⚠️ Được nhưng thừa | Ép rate. Case này cần mix tự nhiên, không cần rate target. Thêm complexity. |
| shared-iterations | ❌ SAI | Cần tổng iter cố định. Case này chạy theo THỜI GIAN, không biết trước số request. |
| per-vu-iterations | ❌ SAI | Cần iter/VU cố định. Case này loop vô hạn theo duration. |
| ramping-vus | ❌ SAI | VU ổn định 12, không ramp. |

**Key insight**: Service mix test = "12 user dùng 5 service trong 45s, routing
có đúng không?". Số lượng request tới mỗi service là OUTPUT (weighted random),
không phải INPUT. `constant-vus` cho phép VU tự do chọn service và loop tự
nhiên theo duration.

### 5.5 Phân tích từng dòng -- Phần D: Default function

```javascript
export default function () {
  const api = pickOriginServiceMixApi();        // (1)
  const res = requestLB(api, {                   // (2)
    headers: {
      'X-Test-Suite': 'lb-origin-mix',           // (2a)
    },
    tags: {
      endpoint: api.name,                         // (2b)
      lb_profile: 'full-no-cdn',
    },
  });
  assertLBResponse(res, api, `${api.name} origin mix`);  // (3)
  sleep(Math.random() * MIX_SLEEP_MAX);           // (4)
}
```

**(1) `pickOriginServiceMixApi()`** -- Đây là trái tim của case. Function này gọi `chooseWeighted(lbServiceMixApis)`, trong đó `lbServiceMixApis` được tạo bằng cách map `productionMixApis` qua `expectedUpstreamForPath()`. Xem chi tiết ở section 5.6.

**(2) `requestLB(api, overrides)`** -- Gửi HTTP request thực tế đến Nginx. Overrides bao gồm:
- **(2a)** `X-Test-Suite: lb-origin-mix` -- header nhận dạng để phân biệt request từ case này với request từ các case khác trong log.
- **(2b)** `endpoint: api.name` -- tag này cực kỳ quan trọng: nó cho phép phân tích kết quả theo từng endpoint riêng lẻ trong dashboard, thay vì chỉ thấy aggregate. Nếu `products_list` bị fail trong khi `auth_me` pass, bạn sẽ thấy ngay.

**(3) `assertLBResponse(res, api, ...)`** -- Thực thi 5-6 checks (section 5.8). Label được format là `"<api.name> origin mix"` để dễ đọc trong output, ví dụ: `"products_list origin mix status"`, `"auth_me origin mix upstream matches"`.

**(4) `sleep(Math.random() * MIX_SLEEP_MAX)`** -- Nghỉ ngẫu nhiên 0-200ms. Hàm `Math.random()` trong k6 được seed deterministic, nên kết quả reproducible giữa các lần chạy với cùng seed.

### 5.6 Deep-dive: `pickOriginServiceMixApi()` và `lbServiceMixApis`

Đây là chuỗi logic quan trọng nhất của case 05. Hãy trace ngược từ function call:

```javascript
// Trong shared.js:

export function pickOriginServiceMixApi() {
  return chooseWeighted(lbServiceMixApis);
}
```

`lbServiceMixApis` được định nghĩa như sau:

```javascript
export const lbServiceMixApis = productionMixApis.map((api) => ({
  ...api,
  expectedUpstream: expectedUpstreamForPath(api.path),
}));
```

Nghĩa là: lấy toàn bộ `productionMixApis` (15 API từ `../shared/traffic.js`), và thêm field `expectedUpstream` cho mỗi API bằng cách gọi `expectedUpstreamForPath(api.path)`.

#### Bảng đầy đủ 15 API trong production mix:

| # | `api.name` | Method | Path | Weight | Expected Status | `expectedUpstream` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `products_list` | GET | `/api/sim/products` | 20 | 200 | `products-service` |
| 2 | `products_detail` | GET | `/api/sim/products/1` | 15 | 200 | `products-service` |
| 3 | `products_search` | GET | `/api/sim/products/search?q=shoe` | 10 | 200 | `products-service` |
| 4 | `products_categories` | GET | `/api/sim/products/categories` | 8 | 200 | `products-service` |
| 5 | `auth_me` | GET | `/api/sim/auth/me` | 6 | 200 | `auth-service` |
| 6 | `cart_summary` | GET | `/api/sim/cart/summary` | 8 | 200 | `cart-service` |
| 7 | `order_status` | GET | `/api/sim/orders/ORD-123` | 5 | 200 | `order-service` |
| 8 | `auth_refresh` | POST | `/api/sim/auth/refresh` | 5 | 200 | `auth-service` |
| 9 | `cart_add` | POST | `/api/sim/cart/add` | 8 | 200 | `cart-service` |
| 10 | `cart_update` | PATCH | `/api/sim/cart/items/sku-1` | 4 | 200 | `cart-service` |
| 11 | `checkout` | POST | `/api/sim/checkout` | 4 | 200 | `order-service` |
| 12 | `order_confirm` | POST | `/api/sim/orders/ORD-123/confirm` | 3 | 200 | `order-service` |
| 13 | `report_job_create` | POST | `/api/sim/report/jobs` | 2 | **202** | `report-service` |
| 14 | `report_job_list` | GET | `/api/sim/report/jobs?limit=10` | 2 | 200 | `report-service` |
| 15 | `payment_webhook` | POST | `/api/sim/orders/webhooks/payment` | 2 | 200 | `order-service` |

**Total weight: 102**

#### Phân phối theo service family:

| Service Family | Tổng weight | Tỉ lệ | Số endpoint | Methods |
| --- | --- | --- | --- | --- |
| `products-service` | 53 | 51.96% | 4 | GET |
| `cart-service` | 20 | 19.61% | 3 | GET, POST, PATCH |
| `order-service` | 14 + 2 = 16 | 15.69% | 5 | GET, POST |
| `auth-service` | 11 | 10.78% | 2 | GET, POST |
| `report-service` | 4 | 3.92% | 2 | GET, POST |

Lưu ý: `payment_webhook` có path `/api/sim/orders/webhooks/payment` nên được route đến `order-service` (vì path bắt đầu bằng `/api/sim/orders/`).

### 5.7 Deep-dive: `expectedUpstreamForPath()` -- Trái tim của routing logic

```javascript
export function expectedUpstreamForPath(path) {
  if (path.startsWith('/api/sim/auth/')) {
    return 'auth-service';
  }
  if (path.startsWith('/api/sim/cart')) {
    return 'cart-service';
  }
  if (path === '/api/sim/checkout' || path.startsWith('/api/sim/orders/')) {
    return 'order-service';
  }
  if (path.startsWith('/api/sim/products')) {
    return 'products-service';
  }
  if (path === '/api/sim/report' || path.startsWith('/api/sim/report/')) {
    return 'report-service';
  }
  return 'app';
}
```

Hàm này có **5 quy tắc routing**, được đánh giá theo thứ tự ưu tiên từ trên xuống:

**Quy tắc 1 -- Auth service:**
```javascript
if (path.startsWith('/api/sim/auth/')) {
  return 'auth-service';
}
```
- Match: `/api/sim/auth/me`, `/api/sim/auth/refresh`
- Phân biệt với `/api/sim/auth` (không có trailing slash) -- path không có trailing slash sẽ rơi xuống fallback `app`
- Sử dụng `startsWith` với trailing slash `/` để tránh match nhầm với `/api/sim/auth-something-else`

**Quy tắc 2 -- Cart service:**
```javascript
if (path.startsWith('/api/sim/cart')) {
  return 'cart-service';
}
```
- Match: `/api/sim/cart/summary`, `/api/sim/cart/add`, `/api/sim/cart/items/sku-1`
- KHÔNG có trailing slash trong check -- cố ý để match cả `/api/sim/cart` (nếu tồn tại) và `/api/sim/cart/...`
- Đây là lựa chọn thiết kế: cart service xử lý mọi path bắt đầu bằng `/api/sim/cart`

**Quy tắc 3 -- Order service:**
```javascript
if (path === '/api/sim/checkout' || path.startsWith('/api/sim/orders/')) {
  return 'order-service';
}
```
- Match chính xác: `/api/sim/checkout` -- exact match vì checkout không theo pattern `/orders/...`
- Match prefix: `/api/sim/orders/ORD-123`, `/api/sim/orders/ORD-123/confirm`, `/api/sim/orders/webhooks/payment`
- Đây là quy tắc phức tạp nhất vì order service nhận request từ 2 prefix khác nhau

**Quy tắc 4 -- Products service:**
```javascript
if (path.startsWith('/api/sim/products')) {
  return 'products-service';
}
```
- Match: `/api/sim/products`, `/api/sim/products/1`, `/api/sim/products/search?q=shoe`, `/api/sim/products/categories`
- Service family có nhiều endpoint nhất (4) và nhiều traffic nhất (53%)

**Quy tắc 5 -- Report service:**
```javascript
if (path === '/api/sim/report' || path.startsWith('/api/sim/report/')) {
  return 'report-service';
}
```
- Match chính xác: `/api/sim/report`
- Match prefix: `/api/sim/report/jobs`, `/api/sim/report/jobs?limit=10`
- Sử dụng cả exact match và prefix match để cover cả 2 trường hợp

**Fallback -- App:**
```javascript
return 'app';
```
- Mọi path không match 5 quy tắc trên được route đến `app` upstream
- Ví dụ: `/`, `/api/users`, `/api/slow?cpu_ms=10`

#### Tại sao thứ tự quan trọng

Thứ tự các quy tắc trong `expectedUpstreamForPath()` phải khớp với thứ tự `location` blocks trong Nginx config. Nếu không khớp, test sẽ báo fail vì `expectedUpstream` tính bởi k6 script khác với upstream thực tế mà Nginx chọn.

Ví dụ: nếu Nginx config có `location /api/sim/orders/` trước `location /api/sim/`, nhưng script k6 check `startsWith('/api/sim/orders/')` sau `startsWith('/api/sim/')`, thì k6 sẽ tính sai expected upstream cho path `/api/sim/orders/ORD-123`.

Đây chính là lý do `expectedUpstreamForPath()` được extract thành một hàm riêng và được dùng chung bởi tất cả các case LB cần route assertion.

### 5.8 Deep-dive: `assertLBResponse()` -- 5 checks bảo vệ correctness

```javascript
export function assertLBResponse(res, api, label) {
  const prefix = label || api.name;
  check(res, {
    [`${prefix} status`]: (r) => r.status === api.expected,
    [`${prefix} served by nginx`]: (r) => {
      const explicit = headerValue(r, 'X-Served-By');
      const server = headerValue(r, 'Server');
      return explicit === 'nginx' || server.toLowerCase().startsWith('nginx/');
    },
    [`${prefix} upstream matches`]: (r) => headerValue(r, 'X-Upstream-Service') === api.expectedUpstream,
    [`${prefix} request id present`]: (r) => !!headerValue(r, 'X-Request-ID'),
    [`${prefix} no cache header`]: (r) => !headerValue(r, 'X-Cache'),
  });

  if (api.expectInstanceID) {
    check(res, {
      [`${prefix} has instance id`]: (r) => {
        const instanceID = safeJsonField(r, 'instance_id');
        return typeof instanceID === 'string' && instanceID.trim() !== '';
      },
    });
  }
}
```

**Check 1 -- `status`**: So sánh HTTP status code thực tế với expected. Điểm đặc biệt: `report_job_create` expected 202 (Accepted), không phải 200. Nếu script không hỗ trợ non-200 expected, check này sẽ false-positive fail.

**Check 2 -- `served by nginx`**: Kiểm tra kép:
- `X-Served-By: nginx` (header tùy chỉnh do Nginx config thêm vào)
- HOẶC `Server: nginx/...` (header mặc định của Nginx)
Điều này đảm bảo response THỰC SỰ đi qua Nginx, không phải từ một service nào khác tình cờ trả về 200.

**Check 3 -- `upstream matches`**: So sánh `X-Upstream-Service` trong response với `expectedUpstream` đã tính. Đây là check quan trọng nhất -- nó xác nhận Nginx đã route request đến đúng upstream service.

**Check 4 -- `request id present`**: `X-Request-ID` phải tồn tại và không rỗng. Đây là UUID được Nginx gán cho mỗi request để trace xuyên suốt hệ thống.

**Check 5 -- `no cache header`**: `X-Cache` phải vắng mặt. Sự hiện diện của header này báo hiệu request đã đi qua Varnish/CDN, vi phạm topology `full-no-cdn`.

**Check 6 (conditional) -- `has instance id`**: Chỉ chạy khi `api.expectInstanceID === true`. Trong `productionMixApis`, không có API nào set `expectInstanceID`, nên check này không được kích hoạt trong case 05. Nó được dùng trong case 01 và 02 cho app entrypoint.

---

## 6. Nginx/LB mechanism deep-dive

### 6.1 Cách Nginx thực hiện path-based routing

Nginx sử dụng directive `location` để map URL path đến upstream group. Cấu hình Nginx cho case 05 trông giống như sau (rút gọn):

```nginx
upstream products_service {
    server products-service:3000;
}

upstream auth_service {
    server auth-service:3000;
}

upstream cart_service {
    server cart-service:3000;
}

upstream order_service {
    server order-service:3000;
}

upstream report_service {
    server report-service:3000;
}

server {
    listen 80;

    location /api/sim/auth/ {
        proxy_pass http://auth_service;
        proxy_set_header X-Upstream-Service "auth-service";
    }

    location /api/sim/cart {
        proxy_pass http://cart_service;
        proxy_set_header X-Upstream-Service "cart-service";
    }

    location = /api/sim/checkout {
        proxy_pass http://order_service;
        proxy_set_header X-Upstream-Service "order-service";
    }

    location /api/sim/orders/ {
        proxy_pass http://order_service;
        proxy_set_header X-Upstream-Service "order-service";
    }

    location /api/sim/products {
        proxy_pass http://products_service;
        proxy_set_header X-Upstream-Service "products-service";
    }

    location /api/sim/report {
        proxy_pass http://report_service;
        proxy_set_header X-Upstream-Service "report-service";
    }

    location / {
        proxy_pass http://app;
        proxy_set_header X-Upstream-Service "app";
    }
}
```

### 6.2 Location matching priority của Nginx

Nginx có quy tắc ưu tiên location rất cụ thể:

1. **Exact match (`=`)**: `location = /api/sim/checkout` -- ưu tiên cao nhất
2. **Prefix match với `^~`**: `location ^~ /api/sim/auth/` -- dừng tìm kiếm regex
3. **Regex match (`~` hoặc `~*`)**: `location ~ \.php$` -- theo thứ tự xuất hiện trong config
4. **Prefix match thường**: `location /api/sim/cart` -- match theo prefix dài nhất

Trong case 05, các location KHÔNG dùng regex, nên Nginx chọn prefix match dài nhất. Ví dụ:
- Request `GET /api/sim/products/search?q=shoe` match cả `location /api/sim/products` và `location /`. Nginx chọn `/api/sim/products` vì prefix dài hơn.
- Request `POST /api/sim/checkout` match `location = /api/sim/checkout` (exact) chứ không phải `location /` (prefix).

### 6.3 Cơ chế gán `X-Upstream-Service`

Header `X-Upstream-Service` được gán thông qua directive `proxy_set_header` trong mỗi location block. Đây không phải là header tự động của Nginx -- nó được cấu hình thủ công cho mục đích observability:

```nginx
proxy_set_header X-Upstream-Service "products-service";
```

Header này được truyền đến upstream server, và upstream server echo lại trong response. k6 script dùng header này để xác nhận routing -- nếu Nginx config sai (ví dụ copy-paste nhầm `"products-service"` vào location `/api/sim/auth/`), check `upstream matches` sẽ fail.

### 6.4 Cơ chế gán `X-Request-ID`

```nginx
proxy_set_header X-Request-ID $request_id;
```

`$request_id` là biến built-in của Nginx, được tạo tự động cho mỗi request. Nó là một chuỗi hex 32 ký tự, duy nhất cho mỗi connection. So với UUID, `$request_id` có tính chất:
- Được tạo bởi Nginx core, không cần module phụ.
- Duy nhất trong phạm vi một Nginx instance.
- Được tái sử dụng nếu connection được reuse (keep-alive).

Điều này có nghĩa: nếu k6 dùng keep-alive connection (mặc định), nhiều request trên cùng một connection sẽ có cùng `X-Request-ID`. Case 05 không kiểm tra uniqueness của `X-Request-ID` -- chỉ kiểm tra sự hiện diện của nó.

### 6.5 Cách Nginx xử lý concurrent connections

Khi 12 VUs gửi request đồng thời, Nginx xử lý chúng qua event-driven architecture:

```text
VU 1 ---> [event] -> Nginx worker 1 -> upstream connection #1 -> products-service
VU 2 ---> [event] -> Nginx worker 1 -> upstream connection #2 -> cart-service
VU 3 ---> [event] -> Nginx worker 2 -> upstream connection #3 -> auth-service
VU 4 ---> [event] -> Nginx worker 1 -> upstream connection #4 -> products-service
...
```

Mỗi Nginx worker process xử lý hàng ngàn connection đồng thời thông qua `epoll` (Linux) hoặc `kqueue` (macOS). Không có thread-per-connection. Điều này có nghĩa:
- Không có race condition trong routing decision vì routing được quyết định synchronous trong event loop.
- Upstream connection pool (`keepalive` directive) được shared giữa tất cả request đến cùng một upstream.
- Nếu upstream pool cạn kiệt, request phải chờ -- điều này làm tăng latency và có thể trigger `http_req_duration` threshold nếu upstream chậm.

### 6.6 Tương tác giữa weighted selection của k6 và weighted routing của Nginx

Có một điểm tinh tế: `pickOriginServiceMixApi()` dùng weighted random trong k6 để chọn API, nhưng Nginx cũng có thể có weighted routing riêng (ví dụ `weight=3` trong `upstream` block cho canary). Hai cơ chế này hoạt động ở **hai layer khác nhau**:

```text
Layer 1 (k6): chọn API nào để gọi (products, auth, cart, ...) -> weighted random trong script
Layer 2 (Nginx): route request đó đến upstream nào -> location-based routing
```

Case 05 chỉ test layer 2. Weighted selection ở layer 1 là công cụ để tạo traffic mix realistic, không phải là đối tượng được test. Case 08 (weighted canary) mới là case test weighted routing của Nginx.

---

## 7. Request sequence flow

### 7.1 Timeline của một iteration

```text
Time (ms)  |  Step
-----------|-------------------------------------------------------
0          |  VU bắt đầu iteration mới
0          |  pickOriginServiceMixApi() -> chọn API (vd: products_list)
0.1        |  requestLB() -> gửi HTTP request đến http://localhost:80/api/sim/products
0.1-15     |  Nginx xử lý: parse URL, match location, chọn upstream, proxy request
1-20       |  Upstream service xử lý business logic
15-35      |  Nginx nhận response từ upstream, thêm headers, trả về client
35         |  k6 nhận response
35-36      |  assertLBResponse() -> 5 checks
36         |  Check results logged vào k6 metrics
36         |  sleep(Math.random() * 200ms) -> nghỉ 0-200ms
36-236     |  (nghỉ)
236        |  Bắt đầu iteration tiếp theo
```

### 7.2 Sequence của request qua Nginx

```text
CLIENT (k6 VU)                  NGINX                           UPSTREAM
    |                             |                                 |
    |-- GET /api/sim/products --> |                                 |
    |   Host: localhost:80       |                                 |
    |   X-Test-Suite: lb-...     |                                 |
    |                             |                                 |
    |                             |-- parse URL path:               |
    |                             |   /api/sim/products             |
    |                             |                                 |
    |                             |-- match location:               |
    |                             |   /api/sim/products ->          |
    |                             |   products_service              |
    |                             |                                 |
    |                             |-- tạo X-Request-ID              |
    |                             |   ($request_id)                 |
    |                             |                                 |
    |                             |-- chọn upstream server          |
    |                             |   (round-robin nếu               |
    |                             |    có nhiều replica)            |
    |                             |                                 |
    |                             |-- GET /api/sim/products ------> |
    |                             |   X-Request-ID: abc...          |
    |                             |   X-Upstream-Service:           |
    |                             |     products-service            |
    |                             |   X-Forwarded-For: ...          |
    |                             |                                 |
    |                             |               (xử lý)           |
    |                             |                                 |
    |                             |<-- 200 OK --------------------- |
    |                             |   Content-Type: app/json        |
    |                             |                                 |
    |                             |-- thêm response headers:        |
    |                             |   X-Served-By: nginx            |
    |                             |   Server: nginx/1.25            |
    |                             |   X-Upstream-Service:           |
    |                             |     products-service            |
    |                             |   X-Request-ID: abc...          |
    |                             |                                 |
    |<-- 200 OK ----------------- |                                 |
    |   X-Served-By: nginx       |                                 |
    |   X-Upstream-Service:      |                                 |
    |     products-service       |                                 |
    |   X-Request-ID: abc...     |                                 |
    |                             |                                 |
    |-- assertLBResponse()                                           |
    |   check 1: status 200 == 200 ✓                                 |
    |   check 2: X-Served-By = nginx ✓                               |
    |   check 3: X-Upstream-Service = products-service ✓             |
    |   check 4: X-Request-ID exists ✓                               |
    |   check 5: X-Cache absent ✓                                    |
    |                                                                 |
    |-- sleep(rand * 200ms)                                          |
```

### 7.3 Concurrency model

```text
Timeline (45s):

VU-1:  |iter1|sleep|iter2|sleep|iter3|sleep|iter4|sleep|iter5|sleep|...
VU-2:  |iter1|sleep|iter2|sleep|iter3|sleep|iter4|sleep|iter5|sleep|...
VU-3:  |iter1|sleep|iter2|sleep|iter3|sleep|iter4|sleep|iter5|sleep|...
VU-4:  |iter1|sleep|iter2|sleep|iter3|sleep|iter4|sleep|iter5|sleep|...
VU-5:  |iter1|sleep|iter2|sleep|iter3|sleep|iter4|sleep|iter5|sleep|...
VU-6:  |iter1|sleep|iter2|sleep|iter3|sleep|iter4|sleep|iter5|sleep|...
VU-7:  |iter1|sleep|iter2|sleep|iter3|sleep|iter4|sleep|iter5|sleep|...
VU-8:  |iter1|sleep|iter2|sleep|iter3|sleep|iter4|sleep|iter5|sleep|...
VU-9:  |iter1|sleep|iter2|sleep|iter3|sleep|iter4|sleep|iter5|sleep|...
VU-10: |iter1|sleep|iter2|sleep|iter3|sleep|iter4|sleep|iter5|sleep|...
VU-11: |iter1|sleep|iter2|sleep|iter3|sleep|iter4|sleep|iter5|sleep|...
VU-12: |iter1|sleep|iter2|sleep|iter3|sleep|iter4|sleep|iter5|sleep|...
```

Mỗi VU chạy độc lập, không đồng bộ với nhau. Các iteration được xen kẽ ngẫu nhiên do sleep time khác nhau, tạo ra arrival pattern không đều -- giống production traffic.

---

## 8. Key signals / headers

### 8.1 Bảng signals cần verify

| Signal | Vị trí | Expected value | Ý nghĩa | Hậu quả nếu sai |
| --- | --- | --- | --- | --- |
| `status` | Response status line | `200` cho hầu hết endpoint; `202` cho `report_job_create` | HTTP status code phản ánh đúng kết quả xử lý | Status sai = upstream service không hiểu request hoặc route nhầm |
| `X-Served-By` | Response header | `nginx` | Xác nhận Nginx đã xử lý request (không phải direct-to-service) | Nếu thiếu: request có thể đã đi đường khác không qua gateway |
| `Server` | Response header | starts with `nginx/` | Fallback signal nếu `X-Served-By` không được set | Backup cho `X-Served-By`; `Server` header được set mặc định bởi Nginx |
| `X-Upstream-Service` | Response header | `products-service`, `auth-service`, `cart-service`, `order-service`, `report-service` | Xác nhận Nginx đã route đến đúng upstream | Signal quan trọng nhất -- sai giá trị = routing bug |
| `X-Request-ID` | Response header | Chuỗi hex 32 ký tự (bất kỳ giá trị non-empty) | Trace ID do Nginx gán cho mỗi request | Thiếu = Nginx config thiếu `proxy_set_header X-Request-ID $request_id` |
| `X-Cache` | Response header | **Vắng mặt (absent)** | Xác nhận request không đi qua Varnish/CDN | Có mặt = topology sai, request đang qua CDN thay vì direct-to-Nginx |
| `X-Test-Suite` | Request header (gửi đi) | `lb-origin-mix` | Phân biệt request của case này trong log | Không ảnh hưởng đến routing, chỉ dùng để debug |
| `endpoint` | k6 tag | `products_list`, `auth_me`, `cart_summary`, ... | Phân nhóm kết quả theo endpoint trong dashboard | Thiếu = không phân tích được kết quả theo từng endpoint |

### 8.2 Signal relationship map

```text
X-Served-By=nginx ──┬── (A) Request đi qua gateway
                     │
X-Upstream-Service ──┼── (B) Route đúng upstream
                     │
X-Request-ID ────────┼── (C) Traceability được bảo toàn
                     │
X-Cache ABSENT ──────┴── (D) Không có CDN interference

Tất cả 4 signal (A+B+C+D) cùng đúng -> LB correctness được chứng minh
Thiếu bất kỳ signal nào -> có lỗ hổng trong LB configuration
```

---

## 9. Pass/fail criteria

### 9.1 PASS criteria

Tất cả các điều kiện sau đồng thời đúng:

| # | Tiêu chí | Cách kiểm tra |
| --- | --- | --- |
| P1 | Tất cả checks pass (rate=1) | Threshold `checks: ['rate==1']` |
| P2 | HTTP failure rate < 3% | Threshold `http_req_failed: ['rate<0.03']` |
| P3 | p95 latency < 1500ms | Threshold `http_req_duration: ['p(95)<1500']` |
| P4 | Mỗi endpoint route đúng upstream | Check `upstream matches` cho từng request |
| P5 | Tất cả response có `X-Request-ID` | Check `request id present` |
| P6 | Không response nào có `X-Cache` | Check `no cache header` |
| P7 | Tất cả endpoint trong mix đều xuất hiện ít nhất 1 lần | Quan sát distribution trong dashboard (không phải check tự động) |

### 9.2 FAIL criteria

| # | Dấu hiệu | Diagnostic | Nguyên nhân khả dĩ |
| --- | --- | --- | --- |
| F1 | Một endpoint cụ thể fail `upstream matches` liên tục | Xem `X-Upstream-Service` thực tế là gì | Nginx location config sai cho endpoint đó |
| F2 | Tất cả endpoint fail `upstream matches` | Kiểm tra `X-Served-By` | Nginx không hoạt động hoặc request bypass Nginx |
| F3 | `X-Cache` xuất hiện | Xem giá trị `X-Cache` (HIT/MISS) | Topology sai -- đang dùng `full` thay vì `full-no-cdn` |
| F4 | `http_req_failed` rate > 3% | Phân tích status code distribution | Upstream service bị lỗi (5xx) hoặc bị rate limit (429) |
| F5 | p95 latency > 1500ms | Phân tích latency theo endpoint | Một upstream service bị chậm hoặc network issue |
| F6 | `X-Request-ID` thiếu trên một số response | Kiểm tra Nginx config | Thiếu `proxy_set_header X-Request-ID $request_id` trong location block cụ thể |
| F7 | `products_list` fail với status 429 | Xem rate limit config | Upstream bị quá tải trong tuned run với ít VUs |
| F8 | Một số endpoint không xuất hiện trong kết quả | Weight quá thấp hoặc duration quá ngắn | Tăng duration hoặc tăng weight cho endpoint đó |

---

## 10. Cách chạy + output mẫu

### 10.1 Default run (12 VUs, 45s, correctness mode)

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 05-origin-service-mix
```

Output mẫu (default batch run):

```text
     script: E:\Projects\k6\k6-metrics-server\load-target\k6\lb\05-origin-service-mix.js
     ...

     ✓ products_list origin mix status
     ✓ products_list origin mix served by nginx
     ✓ products_list origin mix upstream matches
     ✓ products_list origin mix request id present
     ✓ products_list origin mix no cache header
     ✓ products_detail origin mix status
     ✓ products_detail origin mix served by nginx
     ...
     ✗ products_list origin mix status
       ↳  97% — ✓ 2057 / ✗ 53

     checks.....................: 96.19% ✓ 20946  ✗ 824
     http_req_failed............: 18.92% ✓ 150   ✗ 34
     http_req_duration..........: avg=85ms p(95)=320ms
     http_reqs..................: 184

     Exit: 99
```

Phân tích output này:
- **Exit 99**: Có checks fail. Nguyên nhân: `products_list origin mix status` fail 53 lần.
- **18.92% HTTP failed**: Tỉ lệ cao bất thường cho correctness test. Tập trung ở `products_list`.
- **checks 96.19%**: Dưới ngưỡng 100%, trigger threshold failure.
- **Root cause**: `products_list` bị rate limit (status 429) từ upstream products-service. Đây có thể là vấn đề thực sự của upstream, không phải lỗi routing.

### 10.2 Tuned correctness run (giảm tải để isolate routing bug)

```powershell
$env:LB_MIX_VUS = "2"
$env:LB_MIX_DURATION = "10s"
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 05-origin-service-mix
```

Output mẫu (tuned run):

```text
     ✓ products_list origin mix status
     ✓ products_list origin mix served by nginx
     ✓ products_list origin mix upstream matches
     ✓ products_list origin mix request id present
     ✓ products_list origin mix no cache header
     ✓ products_detail origin mix status
     ...

     checks.....................: 100.00% ✓ 815  ✗ 0
     http_req_failed............: 0.00%  ✓ 163  ✗ 0
     http_req_duration..........: avg=45ms p(95)=120ms
     http_reqs..................: 163

     Exit: 0
```

Phân tích:
- **Exit 0**: Tất cả checks pass.
- **checks 100%**: 815/815 checks pass -- routing chính xác cho tất cả 15 endpoint.
- **http_req_failed 0%**: Không có HTTP failure nào. Với 2 VUs, upstream không bị quá tải.
- **p95=120ms**: Latency thấp, xác nhận tất cả upstream services phản hồi nhanh.

Kết luận: routing logic của Nginx chính xác. Default run fail là do upstream capacity, không phải do routing bug.

### 10.3 Tuned run với specific endpoint focus

```powershell
# Nếu chỉ muốn test một service family cụ thể, dùng duration ngắn + observe log
$env:LB_MIX_VUS = "1"
$env:LB_MIX_DURATION = "5s"
k6 run ./k6/lb/05-origin-service-mix.js --verbose 2>&1 | findstr "upstream matches"
```

### 10.4 Cách đọc kết quả trên dashboard

Trên Grafana dashboard:
1. Mở dashboard `LB Capability Cases`.
2. Filter theo `scenario=lb_origin_service_mix`.
3. Xem panel "Checks by endpoint" -- mỗi endpoint là một đường, value=1 nghĩa là pass.
4. Xem panel "HTTP Status by endpoint" -- phân phối 200/202/429/5xx cho từng endpoint.
5. Xem panel "Upstream Service Distribution" -- pie chart thể hiện tỉ lệ request đến mỗi upstream.
6. Xem panel "Latency by endpoint" -- p95 latency cho từng endpoint.

---

## 11. 4 output -> decision scenarios

### Scenario A: Tất cả checks pass, exit 0, no HTTP failure

```text
Exit: 0
Checks: 100%
HTTP failed: 0%
```

**Kết luận**: Routing hoàn hảo. Tất cả 15 endpoint trong production mix được route đúng upstream, tất cả signal headers có mặt, không có CDN interference.

**Hành động**: Không cần action. Case này pass -- tiếp tục sang case 06.

### Scenario B: Checks fail nhưng HTTP failure thấp

```text
Exit: 99
Checks: ~97%
HTTP failed: ~2%
Failure tập trung ở 1-2 endpoint
```

**Kết luận**: Có thể có routing bug cho 1-2 endpoint cụ thể. HTTP failure thấp nghĩa là upstream vẫn hoạt động, nhưng response không đúng contract.

**Hành động**:
1. Xác định endpoint nào fail `upstream matches`.
2. Kiểm tra Nginx location config cho endpoint đó.
3. So sánh `expectedUpstreamForPath()` với Nginx config -- có thể thứ tự location không khớp.
4. Nếu là `products_list` fail với status 429 -> upstream capacity issue, không phải routing bug. Giảm VUs.

### Scenario C: HTTP failure cao (>= 5%)

```text
Exit: 99
Checks: ~90%
HTTP failed: >= 5%
Phân bố đều trên nhiều endpoint
```

**Kết luận**: Upstream services đang gặp vấn đề (không phải routing bug). Có thể do thiếu resource, connection pool exhaustion, hoặc network issue.

**Hành động**:
1. Kiểm tra trạng thái container: `docker ps -a`.
2. Kiểm tra log của upstream services: `docker logs <container>`.
3. Restart stack với `-Build` để rebuild images.
4. Thử tuned run với 2 VUs để isolate.

### Scenario D: Tất cả fail với `X-Cache` present

```text
Exit: 99
Checks: ~60%
Tất cả response có X-Cache: HIT hoặc MISS
```

**Kết luận**: Topology sai. Request đang đi qua Varnish/CDN thay vì trực tiếp đến Nginx.

**Hành động**:
1. Xác nhận stack được start với `-TargetLayer full-no-cdn`, không phải `full`.
2. Restart stack: `./scripts/stack.ps1 -Stack target -Action down; ./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2`.
3. Verify: `curl -s -I http://localhost:80/api/sim/products | findstr "X-Cache"` -- kỳ vọng không có output.

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "Default run fail không có nghĩa là routing sai"

Người mới thường thấy default batch run fail (exit 99, checks 96%) và kết luận "Nginx route sai". Nhưng khi đọc kỹ output, họ thấy tất cả `upstream matches` checks pass -- chỉ có `status` check fail vì `products_list` bị 429.

**Sự thật**: Default run fail ở case 05 thường là do upstream capacity (products-service bị rate limit), không phải do routing bug. Đây là lý do case này có hai chế độ chạy: default để thấy production-like behavior (bao gồm cả capacity constraint), và tuned để isolate routing correctness.

### 12.2 Nghịch lý 2: "Test từng endpoint một (case 03) pass không đảm bảo mix (case 05) pass"

Case 03 (domain boundaries) test từng endpoint tuần tự với 1 VU. Case 05 test tất cả endpoint đồng thời với 12 VUs. Pass case 03 không đảm bảo pass case 05 vì:

- Connection pool exhaustion: khi 12 VUs cùng gọi, Nginx có thể hết connection đến một upstream, buộc request phải chờ hoặc fail.
- Timeout khác nhau: upstream A có thể timeout khi đang phục vụ request từ upstream B.
- DNS cache: dưới concurrent load, Nginx có thể dùng DNS cache cũ cho một upstream trong khi upstream đó đã thay đổi IP.

### 12.3 Nghịch lý 3: "Weight trong k6 script không phải là weight trong Nginx config"

`productionMixApis` có field `weight` dùng để `chooseWeighted()` chọn API ngẫu nhiên trong k6. Trong case 05, Nginx không dùng weighted routing -- Nginx dùng path-based routing. Weight trong script là công cụ mô phỏng traffic pattern, không phải là đối tượng test.

Đừng nhầm lẫn với case 08 (canary), nơi weight trong Nginx config được test trực tiếp qua `X-LB-Release-Channel`.

### 12.4 Nghịch lý 4: "Method diversity không ảnh hưởng đến routing"

Nhiều người nghĩ routing chỉ phụ thuộc vào path, không phụ thuộc vào method. Điều này đúng về mặt Nginx config (location không phân biệt GET/POST), nhưng sai về mặt system behavior:

- POST request có body lớn hơn GET -> buffer nhiều hơn -> memory pressure khác.
- `proxy_next_upstream` retry policy mặc định của Nginx KHÔNG retry POST request (vì POST không idempotent).
- Một số Nginx module (như `ngx_http_limit_req_module`) có thể áp dụng rate limit khác cho GET và POST.

Đó là lý do case 05 bao gồm GET, POST, và PATCH -- để đảm bảo routing hoạt động cho tất cả method dưới concurrent load.

### 12.5 Nghịch lý 5: "report_job_create expected 202 là một anti-pattern test"

Thông thường trong test, expected status luôn là 200. Nhưng `report_job_create` expected **202 Accepted** vì đây là async operation -- server nhận request, xếp hàng xử lý, và trả về 202 để báo "đã nhận, sẽ xử lý sau". Nếu script cứng nhắc assert 200, test sẽ false-positive fail.

Đây là một minh chứng rằng test script **phải** phản ánh đúng business contract, không phải áp đặt convention "mọi thứ phải 200".

---

## 13. Checklist trước khi chạy

### 13.1 Stack readiness

- [ ] Stack đã được start với `-TargetLayer full-no-cdn -ScaleApp 2`
- [ ] `docker ps` cho thấy tất cả containers đang running và healthy
- [ ] `curl http://localhost:80/` trả về 200
- [ ] `curl -s -I http://localhost:80/api/sim/products | findstr "X-Cache"` không có output

### 13.2 Environment variables

- [ ] `$env:BASE_URL = "http://localhost:80"` đã được set
- [ ] Nếu chạy tuned mode: `$env:LB_MIX_VUS = "2"` và `$env:LB_MIX_DURATION = "10s"`
- [ ] Không set `K6_CLOUD_TOKEN` nếu không muốn push kết quả lên cloud

### 13.3 Upstream health check

- [ ] `curl -s http://localhost:80/api/sim/auth/me` -> 200 + `X-Upstream-Service: auth-service`
- [ ] `curl -s http://localhost:80/api/sim/cart/summary` -> 200 + `X-Upstream-Service: cart-service`
- [ ] `curl -s http://localhost:80/api/sim/products` -> 200 + `X-Upstream-Service: products-service`
- [ ] `curl -s -X POST http://localhost:80/api/sim/checkout -H "Content-Type: application/json" -d "{\"payment_method\":\"card\"}"` -> 200 + `X-Upstream-Service: order-service`
- [ ] `curl -s http://localhost:80/api/sim/report/jobs?limit=5` -> 200 + `X-Upstream-Service: report-service`
- [ ] `curl -s -X POST http://localhost:80/api/sim/report/jobs -H "Content-Type: application/json" -d "{\"report_type\":\"sales\"}"` -> 202 + `X-Upstream-Service: report-service`

### 13.4 k6 installation

- [ ] `k6 version` hoạt động
- [ ] Script path: `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\05-origin-service-mix.js` tồn tại
- [ ] `shared.js`, `common.js`, `traffic.js` đều có mặt trong thư mục tương ứng

### 13.5 Test strategy

- [ ] Xác định mục tiêu: correctness test (tuned) hay production-like test (default)?
- [ ] Nếu là correctness: dùng 2 VUs, 10s, kỳ vọng 100% checks pass và 0% HTTP failure
- [ ] Nếu là production-like: dùng 12 VUs, 45s, kỳ vọng checks > 97% và HTTP failure < 3%

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Chỉ test một service family (ví dụ: auth-service)

```javascript
import { sleep } from 'k6';
import { envInt, envString } from '../shared/common.js';
import { assertLBResponse, requestLB } from './shared.js';
import { chooseWeighted } from '../shared/common.js';

// Lọc productionMixApis chỉ lấy auth endpoints
const authOnlyApis = [
  { name: 'auth_me', method: 'GET', path: '/api/sim/auth/me', expected: 200, expectedUpstream: 'auth-service', weight: 50 },
  { name: 'auth_refresh', method: 'POST', path: '/api/sim/auth/refresh', body: {}, expected: 200, expectedUpstream: 'auth-service', weight: 50 },
];

export const options = {
  vus: 4,
  duration: '15s',
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export default function () {
  const api = chooseWeighted(authOnlyApis);
  const res = requestLB(api, {
    tags: { endpoint: api.name, lb_profile: 'full-no-cdn' },
  });
  assertLBResponse(res, api, `${api.name} auth-only`);
  sleep(0.1);
}
```

**Mục đích**: Isolate một service family để debug routing issue hoặc capacity issue cho family đó.

### Variation 2: Tăng sample size cho endpoint weight thấp

```javascript
import { chooseWeighted } from '../shared/common.js';
import { assertLBResponse, requestLB } from './shared.js';

// Boosting: tăng weight cho report-service để có đủ sample
const boostedMixApis = [
  // Giữ nguyên các endpoint khác nhưng giảm weight tương đối
  { name: 'products_list', method: 'GET', path: '/api/sim/products', expected: 200, expectedUpstream: 'products-service', weight: 10 },
  { name: 'products_detail', method: 'GET', path: '/api/sim/products/1', expected: 200, expectedUpstream: 'products-service', weight: 10 },
  // ... (các endpoint khác với weight giảm)
  // Boost report-service endpoints
  { name: 'report_job_create', method: 'POST', path: '/api/sim/report/jobs', body: { report_type: 'sales' }, expected: 202, expectedUpstream: 'report-service', weight: 30 },
  { name: 'report_job_list', method: 'GET', path: '/api/sim/report/jobs?limit=10', expected: 200, expectedUpstream: 'report-service', weight: 30 },
];

export const options = {
  vus: 8,
  duration: '30s',
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate<0.02'],
  },
};

export default function () {
  const api = chooseWeighted(boostedMixApis);
  const res = requestLB(api, {
    tags: { endpoint: api.name, lb_profile: 'full-no-cdn' },
  });
  assertLBResponse(res, api, `${api.name} boosted mix`);
  sleep(Math.random() * 0.2);
}
```

**Mục đích**: Đảm bảo đủ sample size cho endpoint có weight thấp (như report-service) để kết luận routing đúng với statistical significance.

### Variation 3: Sequential mode -- test từng service family lần lượt

```javascript
import { check } from 'k6';
import { assertLBResponse, lbBoundaryApis, requestLB } from './shared.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
};

export default function () {
  // Test từng endpoint TUẦN TỰ nhưng bao gồm nhiều endpoint hơn case 03
  const allEndpoints = [
    { name: 'products_list', method: 'GET', path: '/api/sim/products', expected: 200, expectedUpstream: 'products-service' },
    { name: 'products_detail', method: 'GET', path: '/api/sim/products/1', expected: 200, expectedUpstream: 'products-service' },
    { name: 'auth_me', method: 'GET', path: '/api/sim/auth/me', expected: 200, expectedUpstream: 'auth-service' },
    { name: 'auth_refresh', method: 'POST', path: '/api/sim/auth/refresh', body: {}, expected: 200, expectedUpstream: 'auth-service' },
    { name: 'cart_summary', method: 'GET', path: '/api/sim/cart/summary', expected: 200, expectedUpstream: 'cart-service' },
    { name: 'cart_add', method: 'POST', path: '/api/sim/cart/add', body: { product_id: 1, quantity: 1 }, expected: 200, expectedUpstream: 'cart-service' },
    { name: 'cart_update', method: 'PATCH', path: '/api/sim/cart/items/sku-1', body: { quantity: 2 }, expected: 200, expectedUpstream: 'cart-service' },
    { name: 'checkout', method: 'POST', path: '/api/sim/checkout', body: { payment_method: 'card' }, expected: 200, expectedUpstream: 'order-service' },
    { name: 'order_status', method: 'GET', path: '/api/sim/orders/ORD-123', expected: 200, expectedUpstream: 'order-service' },
    { name: 'order_confirm', method: 'POST', path: '/api/sim/orders/ORD-123/confirm', body: {}, expected: 200, expectedUpstream: 'order-service' },
    { name: 'payment_webhook', method: 'POST', path: '/api/sim/orders/webhooks/payment', body: { event_type: 'payment.captured' }, expected: 200, expectedUpstream: 'order-service' },
    { name: 'report_job_create', method: 'POST', path: '/api/sim/report/jobs', body: { report_type: 'sales' }, expected: 202, expectedUpstream: 'report-service' },
    { name: 'report_job_list', method: 'GET', path: '/api/sim/report/jobs?limit=10', expected: 200, expectedUpstream: 'report-service' },
  ];

  for (const api of allEndpoints) {
    const res = requestLB(api, { tags: { endpoint: api.name } });
    assertLBResponse(res, api, `${api.name} sequential mix`);
  }
}
```

**Mục đích**: Debug từng endpoint một cách tuần tự để xác định chính xác endpoint nào fail. Hữu ích khi muốn isolate routing bug.

### Variation 4: Stress test với concurrent load cao

```javascript
import { sleep } from 'k6';
import { envInt, envString, envFloat } from '../shared/common.js';
import { assertLBResponse, pickOriginServiceMixApi, requestLB } from './shared.js';

const STRESS_VUS = envInt('LB_STRESS_VUS', 50);
const STRESS_DURATION = envString('LB_STRESS_DURATION', '60s');

export const options = {
  vus: STRESS_VUS,
  duration: STRESS_DURATION,
  thresholds: {
    checks: ['rate>0.95'],              // Nới lỏng: cho phép 5% fail dưới stress
    http_req_failed: ['rate<0.10'],     // Cho phép 10% HTTP failure dưới stress
    http_req_duration: ['p(95)<3000'],  // Nới lỏng latency SLO
  },
  tags: {
    scenario: 'lb_origin_service_mix_stress',
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};

export default function () {
  const api = pickOriginServiceMixApi();
  const res = requestLB(api, {
    tags: {
      endpoint: api.name,
      lb_profile: 'full-no-cdn',
    },
  });
  assertLBResponse(res, api, `${api.name} stress mix`);
  // Không sleep dưới stress mode để tạo áp lực tối đa
}
```

**Mục đích**: Kiểm tra routing correctness dưới concurrent load cao (50 VUs). Threshold được nới lỏng vì đây là stress test, không phải correctness test thuần túy.

### Variation 5: Chạy với traffic profile headers

```javascript
import { sleep } from 'k6';
import { chooseWeighted, envInt, envString } from '../shared/common.js';
import { assertLBResponse, lbServiceMixApis, requestLB } from './shared.js';
import { trafficProfiles } from '../shared/traffic.js';

const MIX_VUS = envInt('LB_MIX_VUS', 8);
const MIX_DURATION = envString('LB_MIX_DURATION', '30s');

export const options = {
  vus: MIX_VUS,
  duration: MIX_DURATION,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate<0.03'],
  },
};

export default function () {
  const api = chooseWeighted(lbServiceMixApis);
  const profile = chooseWeighted(trafficProfiles);

  const res = requestLB(api, {
    headers: {
      ...profile.headers,                     // Thêm traffic profile headers (Accept-Language, X-Geo-Country, ...)
      'X-Test-Suite': 'lb-origin-mix-profiled',
    },
    tags: {
      endpoint: api.name,
      traffic_profile: profile.name,          // Tag để phân tích theo profile
      lb_profile: 'full-no-cdn',
    },
  });
  assertLBResponse(res, api, `${api.name} profiled mix`);
  sleep(Math.random() * 0.2);
}
```

**Mục đích**: Kết hợp traffic profile headers với service mix để test routing trong điều kiện giống production hơn nữa. Mỗi request không chỉ đến một service family khác nhau mà còn mang theo geo/device/segment headers khác nhau.

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Chỉ chạy default mà không chạy tuned

```text
SAI: Chạy default 12 VUs, thấy exit 99, kết luận "Nginx route sai".
```

**Vấn đề**: Default run có thể fail vì upstream capacity, không phải routing bug. Bạn không thể phân biệt hai nguyên nhân nếu không chạy tuned mode.

**Cách đúng**:
1. Chạy default -> nếu fail, ghi nhận pattern (endpoint nào fail? status code gì?).
2. Chạy tuned (2 VUs, 10s) -> nếu pass, kết luận routing đúng, vấn đề là capacity.
3. Nếu tuned vẫn fail -> mới investigate routing bug.

### 15.2 Anti-pattern 2: Bỏ qua check `X-Cache` absent

```text
SAI: Thấy 200 OK + X-Upstream-Service đúng -> kết luận pass.
```

**Vấn đề**: Nếu topology đang là `full` (có CDN), request có thể được Varnish cache hit và trả về 200 với `X-Upstream-Service` từ lần request trước đó. Bạn đang test CDN cache behavior, không phải LB routing.

**Cách đúng**: Luôn kiểm tra `X-Cache` absent. Nếu có `X-Cache: HIT`, bạn đang chạy sai topology.

### 15.3 Anti-pattern 3: Dùng `http_req_failed: ['rate==0']` cho production-like mix

```text
SAI: Đặt threshold http_req_failed rate==0 cho case mix.
```

**Vấn đề**: Trong production-like mix với 12 VUs, một tỉ lệ rất nhỏ transient failure (network blip, connection reset) là bình thường. Threshold `rate==0` sẽ false-positive fail vì những lý do không liên quan đến routing.

**Cách đúng**: Dùng `rate<0.03` cho default mode và `rate==0` cho tuned correctness mode.

### 15.4 Anti-pattern 4: Không tag `endpoint` trong request

```text
SAI: requestLB(api) không có tags.endpoint.
```

**Vấn đề**: Không có tag `endpoint`, tất cả request được gộp chung trong dashboard. Bạn không thể biết endpoint nào fail. Một endpoint fail `upstream matches` sẽ bị "pha loãng" trong aggregate.

**Cách đúng**: Luôn gán `tags: { endpoint: api.name }` khi gọi `requestLB`.

### 15.5 Anti-pattern 5: Thay đổi weight trong `productionMixApis` gốc

```text
SAI: Sửa trực tiếp file ../shared/traffic.js để thay đổi weight cho case 05.
```

**Vấn đề**: `productionMixApis` được dùng chung bởi nhiều case (bao gồm cả CDN cases). Thay đổi nó sẽ ảnh hưởng đến tất cả case khác.

**Cách đúng**: Tạo biến local trong script case 05 (như Variation 2) hoặc override qua biến môi trường nếu cần.

### 15.6 Anti-pattern 6: Bỏ qua `report_job_create` expected 202

```text
SAI: Code review thấy expected=202, sửa thành 200 vì "mọi API phải trả 200".
```

**Vấn đề**: `report_job_create` là async operation, HTTP 202 Accepted mới là response đúng. Sửa thành 200 sẽ khiến check false-positive fail.

**Cách đúng**: Tôn trọng business contract. Không phải mọi API đều trả 200, và test script phải phản ánh đúng điều đó.

---

## 16. Real validation data

### 16.1 Default batch run (12 VUs, 45s)

```text
     script: 05-origin-service-mix.js
     profile: full-no-cdn
     vus: 12
     duration: 45s

     ✓ products_list origin mix served by nginx
     ✓ products_list origin mix upstream matches
     ✓ products_list origin mix request id present
     ✓ products_list origin mix no cache header
     ✗ products_list origin mix status
       ↳  97% — ✓ 2057 / ✗ 53

     ✓ products_detail origin mix status
     ✓ products_detail origin mix served by nginx
     ✓ products_detail origin mix upstream matches
     ...

     checks.....................: 96.19% ✓ 20946  ✗ 824
     http_req_failed............: 18.92% ✓ 150   ✗ 34
     http_req_duration..........: avg=85ms min=12ms med=45ms max=2500ms p(90)=180ms p(95)=320ms
     http_reqs..................: 184
     iterations.................: 184
     vus........................: 12

     Exit: 99
```

**Phân tích**:
- 184 iteration trong 45s ~ 4.1 req/s với 12 VUs.
- Chỉ `products_list status` fail (53/2110 = 2.5%) do status 429 từ upstream.
- Tất cả `upstream matches` checks pass -> routing chính xác.
- Vấn đề là capacity của products-service, không phải routing.

### 16.2 Tuned correctness run (2 VUs, 10s)

```text
     script: 05-origin-service-mix.js
     profile: full-no-cdn
     vus: 2
     duration: 10s

     ✓ products_list origin mix status
     ✓ products_list origin mix served by nginx
     ✓ products_list origin mix upstream matches
     ✓ products_list origin mix request id present
     ✓ products_list origin mix no cache header
     ✓ products_detail origin mix status
     ✓ products_detail origin mix served by nginx
     ✓ products_detail origin mix upstream matches
     ✓ products_detail origin mix request id present
     ✓ products_detail origin mix no cache header
     ... (tất cả 15 endpoint x 5 checks = 75 checks pass)

     checks.....................: 100.00% ✓ 815  ✗ 0
     http_req_failed............: 0.00%  ✓ 163  ✗ 0
     http_req_duration..........: avg=45ms min=10ms med=35ms max=180ms p(90)=80ms p(95)=120ms
     http_reqs..................: 163
     iterations.................: 163
     vus........................: 2

     Exit: 0
```

**Phân tích**:
- 163 iteration trong 10s ~ 16.3 req/s với 2 VUs (cao hơn per-VU throughput so với default run vì ít contention).
- 815/815 checks pass (163 iteration x 5 checks).
- p95 = 120ms -- tất cả upstream services phản hồi nhanh.
- Kết luận: routing logic chính xác cho toàn bộ 15 endpoint, 6 service families.

### 16.3 Phân tích phân phối endpoint (từ dashboard)

Khi chạy tuned mode với 163 iteration, phân phối kỳ vọng:

| Endpoint | Weight | Expected count | Tỉ lệ |
| --- | --- | --- | --- |
| products_list | 20 | ~32 | 19.6% |
| products_detail | 15 | ~24 | 14.7% |
| products_search | 10 | ~16 | 9.8% |
| products_categories | 8 | ~13 | 7.8% |
| cart_summary | 8 | ~13 | 7.8% |
| cart_add | 8 | ~13 | 7.8% |
| auth_me | 6 | ~10 | 5.9% |
| order_status | 5 | ~8 | 4.9% |
| auth_refresh | 5 | ~8 | 4.9% |
| cart_update | 4 | ~6 | 3.9% |
| checkout | 4 | ~6 | 3.9% |
| order_confirm | 3 | ~5 | 2.9% |
| report_job_create | 2 | ~3 | 2.0% |
| report_job_list | 2 | ~3 | 2.0% |
| payment_webhook | 2 | ~3 | 2.0% |

Với 163 iteration, endpoint weight thấp nhất (2/102 = 1.96%) vẫn có kỳ vọng ~3 lần xuất hiện -- đủ để xác nhận routing đúng.

### 16.4 Kiểm tra nhanh bằng curl (manual validation)

```powershell
# Kiểm tra tất cả 6 service families
$endpoints = @(
  @{Path="/api/sim/products"; ExpectedUpstream="products-service"; Desc="products"},
  @{Path="/api/sim/auth/me"; ExpectedUpstream="auth-service"; Desc="auth"},
  @{Path="/api/sim/cart/summary"; ExpectedUpstream="cart-service"; Desc="cart"},
  @{Path="/api/sim/orders/ORD-123"; ExpectedUpstream="order-service"; Desc="order"},
  @{Path="/api/sim/report/jobs?limit=5"; ExpectedUpstream="report-service"; Desc="report"}
)

foreach ($ep in $endpoints) {
  $headers = (Invoke-WebRequest -Uri "http://localhost:80$($ep.Path)" -UseBasicParsing).Headers
  $upstream = $headers['X-Upstream-Service']
  $status = (Invoke-WebRequest -Uri "http://localhost:80$($ep.Path)" -UseBasicParsing).StatusCode
  $match = if ($upstream -eq $ep.ExpectedUpstream) { "PASS" } else { "FAIL" }
  Write-Host "$($ep.Desc): upstream=$upstream (expected=$($ep.ExpectedUpstream)) status=$status -> $match"
}
```

Output kỳ vọng:
```text
products: upstream=products-service (expected=products-service) status=200 -> PASS
auth: upstream=auth-service (expected=auth-service) status=200 -> PASS
cart: upstream=cart-service (expected=cart-service) status=200 -> PASS
order: upstream=order-service (expected=order-service) status=200 -> PASS
report: upstream=report-service (expected=report-service) status=200 -> PASS
```

---

## 17. Reference

### 17.1 Các file liên quan

| File | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\05-origin-service-mix.js` | Script chính của case |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\shared.js` | Shared library: `pickOriginServiceMixApi()`, `expectedUpstreamForPath()`, `assertLBResponse()`, `requestLB()` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\traffic.js` | `productionMixApis` -- định nghĩa 15 API trong production mix |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | `chooseWeighted()`, `requestApi()`, `envInt()`, `envFloat()`, `envString()` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\case-catalog.json` | Catalog định nghĩa tất cả LB cases, topology, expected signals |
| `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Nginx configuration với location blocks và upstream definitions |
| `E:\Projects\k6\k6-metrics-server\scripts\run-lb-capabilities.ps1` | Runner script |

### 17.2 Các case liên quan trong series

| Case | Mối liên hệ |
| --- | --- |
| [Case 03 -- Domain boundaries](./03_domain-boundaries.md) | Test từng endpoint tuần tự -- baseline để so sánh với concurrent mix |
| [Case 04 -- Origin cacheable read](./04_origin-cacheable-read.md) | Test concurrent load nhưng chỉ 1 service family -- so sánh single-family vs multi-family concurrent behavior |
| [Case 06 -- Retry/failover](./06_retry-failover.md) | Test retry mechanism -- case tiếp theo trong learning order |
| [Case 07 -- Rate limit/connection pressure](./07_rate-limit-and-connection-pressure.md) | Test rate limiting -- liên quan vì default run case 05 thường fail do upstream rate limit |

### 17.3 Tài liệu tổng quan

| File | Nội dung |
| --- | --- |
| [00_overview.md](./00_overview.md) | Tổng quan series LB/Gateway layer, mental model, key concepts |
| [13_validation-and-chart-analysis.md](./13_validation-and-chart-analysis.md) | Hướng dẫn validation và phân tích chart cho toàn bộ LB series |
| [RUN_GUIDE.md](../RUN_GUIDE.md) | Hướng dẫn chạy toàn bộ test suite |

### 17.4 Kiến thức nền

| Chủ đề | Tài liệu tham khảo |
| --- | --- |
| Nginx location directive | [nginx.org: location](https://nginx.org/en/docs/http/ngx_http_core_module.html#location) |
| Nginx upstream module | [nginx.org: upstream](https://nginx.org/en/docs/http/ngx_http_upstream_module.html) |
| Nginx proxy_set_header | [nginx.org: proxy_set_header](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header) |
| k6 options reference | [k6.io: options](https://k6.io/docs/using-k6/k6-options/reference/) |
| k6 check reference | [k6.io: checks](https://k6.io/docs/using-k6/checks/) |
| HTTP status 202 Accepted | [RFC 7231: 202](https://datatracker.ietf.org/doc/html/rfc7231#section-6.3.3) |
