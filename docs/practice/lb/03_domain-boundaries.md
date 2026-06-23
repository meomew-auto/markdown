# Case 03: Domain boundary routing

> **Case ID:** `lb-03-domain-boundaries`
> **Script:** `03-domain-boundaries.js`
> **Profile:** `full-no-cdn` / `TargetLayer=full-no-cdn`
> **Proof:** Nginx route đúng boundary app/auth/cart/order/products/report

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

Một nền tảng thương mại điện tử ban đầu được xây dựng dưới dạng **monolith**: toàn bộ logic nghiệp vụ -- xác thực người dùng, giỏ hàng, đơn hàng, sản phẩm, báo cáo -- đều nằm trong cùng một ứng dụng. Mọi request từ người dùng đều được forward đến một backend duy nhất.

Sau ba năm tăng trưởng, kiến trúc monolith bộc lộ ba vấn đề:

| Vấn đề | Biểu hiện cụ thể | Hệ quả |
| --- | --- | --- |
| Điểm chết đơn lẻ (single point of failure) | Auth service bị quá tải trong đợt flash sale, kéo sập cả giỏ hàng và thanh toán | Toàn bộ nền tảng ngừng hoạt động dù chỉ một module lỗi |
| Không thể scale độc lập | Product list cần 20 instance nhưng auth chỉ cần 2 -- không thể scale riêng từng phần | Lãng phí tài nguyên hoặc thiếu capacity |
| Vận hành rủi ro | Một thay đổi nhỏ ở report service có thể gây regression ở thanh toán | Mỗi lần deploy là một lần "cầu nguyện" |

Giải pháp được kiến trúc sư đề xuất: **phân rã monolith thành microservices**, mỗi domain nghiệp vụ là một service riêng biệt. Nhưng để người dùng cuối không thấy sự thay đổi, cần một **Gateway/LB layer** đứng trước để route request đến đúng service dựa trên URL path.

### 1.2 Bài toán routing thực tế

Sau khi phân rã, hệ thống có 6 service:

```text
app               → Trang chủ, thông tin chung (cổng vào chính)
auth-service      → Xác thực, refresh token
cart-service      → Giỏ hàng: xem, thêm, sửa, xóa
order-service     → Đặt hàng: checkout, xác nhận đơn, webhook thanh toán
products-service  → Danh sách sản phẩm, chi tiết, tìm kiếm, danh mục
report-service    → Báo cáo: tạo job báo cáo bất đồng bộ, xem danh sách job
```

Mỗi service lắng nghe trên một cổng nội bộ riêng, nhưng người dùng cuối chỉ biết đến một URL duy nhất: `http://localhost:80`. Nhiệm vụ của LB/Gateway là đọc URL path và quyết định:

```text
GET  /                              → app
GET  /api/sim/auth/me               → auth-service
GET  /api/sim/cart/summary           → cart-service
POST /api/sim/checkout               → order-service
GET  /api/sim/products               → products-service
GET  /api/sim/report/jobs?limit=5    → report-service
```

### 1.3 Hậu quả khi route sai domain

Nếu LB route sai, hậu quả có thể rất nghiêm trọng:

| Lỗi routing | Hậu quả thực tế | Mức độ |
| --- | --- | --- |
| Request auth đi sang cart-service | Cart service không hiểu request auth → trả 404 hoặc 500 → người dùng không đăng nhập được | Nghiêm trọng |
| Request checkout đi sang app monolith | App không có logic đặt hàng → trả 200 với dữ liệu rỗng → người dùng tưởng đã đặt hàng thành công nhưng thực tế chưa | Rất nghiêm trọng (mất đơn hàng) |
| Request report đi sang products-service | Products service trả danh sách sản phẩm thay vì danh sách job báo cáo → dashboard ops hiển thị sai dữ liệu | Trung bình |
| Route nhầm sang service không tồn tại | Request đi vào "hố đen" → timeout hoặc 502 → trải nghiệm người dùng kém | Nghiêm trọng |

Đây chính là lý do case 03 tồn tại: **xác minh rằng mỗi route đi đúng service ngay từ lần request đầu tiên, trước khi bất kỳ logic nghiệp vụ nào được thực thi.**

---

## 2. LB capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh một khả năng cốt lõi của Gateway/LB:

> **Nginx route đúng upstream service cho từng domain boundary dựa trên URL path**

Cụ thể hơn, case này chứng minh 6 boundary mapping:

| # | Endpoint | Method | Path | Expected upstream | Loại request |
| --- | --- | --- | --- | --- | --- |
| 1 | `home` | GET | `/` | `app` | Trang chủ -- entrypoint chính |
| 2 | `auth_me` | GET | `/api/sim/auth/me` | `auth-service` | Xác thực người dùng hiện tại |
| 3 | `cart_summary` | GET | `/api/sim/cart/summary` | `cart-service` | Tóm tắt giỏ hàng |
| 4 | `checkout` | POST | `/api/sim/checkout` | `order-service` | Đặt hàng (có body JSON) |
| 5 | `products_list` | GET | `/api/sim/products` | `products-service` | Danh sách sản phẩm |
| 6 | `report_job_list` | GET | `/api/sim/report/jobs?limit=5` | `report-service` | Danh sách job báo cáo |

### 2.2 Phân biệt các loại boundary

Sáu boundary này không giống nhau về bản chất. Chúng được chia thành ba nhóm:

**Nhóm 1 -- Entrypoint app (1 route):**

```text
GET / → app
```

Đây là route "catch-all" -- bất kỳ request nào không khớp với các rule cụ thể hơn sẽ rơi vào app. `expectedUpstreamForPath()` trong `shared.js` thể hiện điều này qua `return 'app'` ở cuối hàm (default case).

**Nhóm 2 -- Prefix routing (4 routes):**

```text
/api/sim/auth/*     → auth-service
/api/sim/cart*      → cart-service
/api/sim/products*  → products-service
/api/sim/report*    → report-service
```

Đây là routing dựa trên **prefix path**. Mọi request có path bắt đầu bằng prefix tương ứng đều được route đến service đó. Ví dụ: `/api/sim/auth/me`, `/api/sim/auth/refresh`, `/api/sim/auth/login` đều đi đến `auth-service`.

**Nhóm 3 -- Exact path routing (1 route):**

```text
/api/sim/checkout (exact)   → order-service
/api/sim/orders/*  (prefix) → order-service
```

`/api/sim/checkout` là exact match -- chỉ có path chính xác này mới route đến order-service. Các path `/api/sim/orders/*` là prefix match trong cùng một upstream block. Cả hai đều trỏ đến `order-service`.

### 2.3 Tại sao capability này quan trọng

Nếu boundary routing không đúng:

```text
Không có boundary:    Mọi request đi vào một chỗ → monolith, mất hết lợi ích của microservices
Boundary sai:         Request đi nhầm service → lỗi nghiệp vụ khó phát hiện
Boundary đúng:        Mỗi request đến đúng service → isolation, independent scaling, an toàn deploy
```

Case 03 là **nền tảng cho mọi case LB khác**. Nếu boundary routing sai, tất cả các case sau (failover, canary, pressure, timeout) đều vô nghĩa vì request đã không đến được đúng service ngay từ đầu.

---

## 3. Vì sao phải test ở LB layer

### 3.1 LB là điểm quyết định routing

```text
Người dùng → Nginx (:80) → [quyết định upstream] → auth / cart / order / products / report
                ↑
           Điểm phân nhánh duy nhất
```

Mọi request từ bên ngoài đều đi qua Nginx tại cổng 80. Nginx là **điểm quyết định duy nhất** cho việc request sẽ được forward đến service nào. Nếu Nginx cấu hình sai upstream block, không tầng nào khác có thể sửa được -- request đã đi sai đường ngay từ đầu.

### 3.2 Không thể test boundary ở tầng app

Nếu chỉ test API ở tầng app (bỏ qua LB):

```text
Test sai:   curl http://localhost:8080/api/sim/auth/me    (đi thẳng app, không qua Nginx route)
Test đúng:  curl http://localhost:80/api/sim/auth/me       (đi qua Nginx → Nginx route → auth-service)
```

Khi gọi thẳng app qua cổng 8080, bạn bỏ qua hoàn toàn lớp routing của Nginx. Bạn chỉ kiểm tra được app có trả về 200 hay không -- không kiểm tra được rằng **Nginx có route đúng service hay không**.

### 3.3 Evidence từ header, không phải từ response body

Một điểm quan trọng: case này không kiểm tra nội dung response body có "đúng" hay không. Nó kiểm tra **header signal** -- cụ thể là `X-Upstream-Service`. Lý do:

```text
Không đủ:  GET /api/sim/cart/summary → 200 → "chắc là đúng service rồi"
Đủ:        GET /api/sim/cart/summary → 200 + X-Upstream-Service: cart-service → "chắc chắn đúng service"
```

Một response 200 từ `/api/sim/cart/summary` có thể đến từ bất kỳ service nào nếu service đó tình cờ có route handler trùng path. `X-Upstream-Service` là bằng chứng không thể chối cãi rằng request đã đến đúng upstream.

### 3.4 Mối quan hệ với topology `full-no-cdn`

Case này yêu cầu `TargetLayer=full-no-cdn`, không phải `lb-app`. Lý do:

| Topology | Những gì chạy | Phù hợp cho case 03? |
| --- | --- | --- |
| `lb-app` | Nginx + app | Không -- thiếu auth, cart, order, products, report service |
| `full-no-cdn` | Nginx + app + auth + cart + order + products + report | Có -- đầy đủ tất cả service cần test boundary |
| `full` | Varnish + Nginx + tất cả service | Không -- có CDN/Varnish làm nhiễu signal `X-Cache` |

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌─────────────────────────┐
                          │    k6 test script        │
                          │    (03-domain-boundaries) │
                          └──────────┬──────────────┘
                                     │
                          GET/POST qua :80
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx LB/Gateway)                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Nginx location-based router                              │  │
│  │                                                           │  │
│  │  /                  → upstream app                        │  │
│  │  /api/sim/auth/*    → upstream auth-service               │  │
│  │  /api/sim/cart*     → upstream cart-service               │  │
│  │  /api/sim/checkout  → upstream order-service              │  │
│  │  /api/sim/orders/*  → upstream order-service              │  │
│  │  /api/sim/products* → upstream products-service           │  │
│  │  /api/sim/report*   → upstream report-service             │  │
│  └──────────┬───────────────────────────────────────────────┘  │
│             │                                                    │
│             ▼                                                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │               Microservices (internal ports)              │  │
│  │                                                           │  │
│  │  app               :8080    (trang chủ, thông tin chung)  │  │
│  │  auth-service      :8081    (xác thực)                    │  │
│  │  cart-service      :8082    (giỏ hàng)                    │  │
│  │  order-service     :8083    (đơn hàng, thanh toán)        │  │
│  │  products-service  :8084    (sản phẩm)                    │  │
│  │  report-service    :8085    (báo cáo bất đồng bộ)         │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `full-no-cdn` (bắt buộc) | `docker ps` thấy Nginx + tất cả 6 service |
| `BASE_URL` | `http://localhost:80` | `curl -sI http://localhost:80/` thấy `Server: nginx/...` |
| `ScaleApp` | Tối thiểu 2 | `docker ps --filter "name=app"` thấy 2+ container app |
| Nginx config | Upstream blocks cho 6 service | Đọc `nginx.conf` xác nhận 6 upstream blocks |
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

# Xác nhận public path hoạt động
curl -sI http://localhost:80/

# Kiểm tra từng upstream service có sẵn sàng không
curl -sI http://localhost:80/api/sim/auth/me
curl -sI http://localhost:80/api/sim/cart/summary
curl -sI http://localhost:80/api/sim/products
curl -sI http://localhost:80/api/sim/report/jobs?limit=5
```

### 4.4 Biến môi trường

```powershell
$env:BASE_URL = "http://localhost:80"
```

Đây là biến duy nhất cần set. Script case 03 không có tham số tùy chỉnh VU hay duration vì nó là single-shot correctness probe (1 VU, 1 iteration).

### 4.5 Precondition logic

Script case 03 **không có `setup()` function**. Điều này có nghĩa:

- Không cần precondition thủ công
- Không cần warmup cache (vì `full-no-cdn` không có cache layer)
- Mỗi lần chạy là độc lập và không phụ thuộc trạng thái trước đó

Đây là điểm khác biệt quan trọng so với các case CDN (nơi cần warm cache trước khi test). Ở LB layer, request luôn đi thẳng đến origin, không có cache state cần quản lý.

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\lb\03-domain-boundaries.js
```

Script cực kỳ ngắn gọn -- chỉ 27 dòng. Đây là một trong những script ngắn nhất trong toàn bộ suite, nhưng sức mạnh của nó nằm ở dữ liệu được định nghĩa trong `shared.js`.

### 5.2 Import và dependency

```javascript
import { assertLBResponse, lbBoundaryApis, requestLB } from './shared.js';
```

Ba import từ `shared.js`:

| Import | Loại | Vai trò |
| --- | --- | --- |
| `lbBoundaryApis` | `Array<ApiDef>` | Mảng 6 API definition, mỗi phần tử định nghĩa path, method, expected status, và expected upstream |
| `requestLB(api, overrides)` | `function` | Gửi HTTP request đến LB (`BASE_URL`), tự động build URL, headers, body từ `api` definition |
| `assertLBResponse(res, api, label)` | `function` | Thực thi 5-6 `check()` assertions: status, nginx server, upstream match, request ID, no cache, và instance_id (nếu có) |

### 5.3 `lbBoundaryApis` -- dữ liệu cốt lõi

Đây là mảng được định nghĩa trong `shared.js` (dòng 14-21), không phải trong script case. Nó là "contract" của case 03:

```javascript
export const lbBoundaryApis = [
  { name: 'home', method: 'GET', path: '/', expected: 200, expectedUpstream: 'app', expectInstanceID: true },
  { name: 'auth_me', method: 'GET', path: '/api/sim/auth/me', expected: 200, expectedUpstream: 'auth-service' },
  { name: 'cart_summary', method: 'GET', path: '/api/sim/cart/summary', expected: 200, expectedUpstream: 'cart-service' },
  { name: 'checkout', method: 'POST', path: '/api/sim/checkout', body: { payment_method: 'card' }, expected: 200, expectedUpstream: 'order-service' },
  { name: 'products_list', method: 'GET', path: '/api/sim/products', expected: 200, expectedUpstream: 'products-service' },
  { name: 'report_job_list', method: 'GET', path: '/api/sim/report/jobs?limit=5', expected: 200, expectedUpstream: 'report-service' },
];
```

Phân tích từng field:

| Field | Ý nghĩa | Ví dụ |
| --- | --- | --- |
| `name` | Tên định danh cho API -- dùng làm tag `endpoint` trong k6 metrics | `'auth_me'` |
| `method` | HTTP method | `'GET'`, `'POST'` |
| `path` | URL path (không bao gồm base URL) | `'/api/sim/auth/me'` |
| `expected` | HTTP status code mong đợi | `200` |
| `expectedUpstream` | Giá trị mong đợi của response header `X-Upstream-Service` | `'auth-service'` |
| `body` | (optional) Request body cho POST/PATCH | `{ payment_method: 'card' }` |
| `expectInstanceID` | (optional) Nếu `true`, assert thêm rằng response body có field `instance_id` không rỗng | Chỉ có ở `home` |

**Điểm đặc biệt:** `checkout` là endpoint DUY NHẤT dùng method POST và có body. Điều này có chủ đích -- nó chứng minh rằng Nginx route đúng không chỉ cho GET request mà còn cho POST request (có body).

### 5.4 `options` block

```javascript
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
  tags: {
    scenario: 'lb_domain_boundaries',
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};
```

Phân tích từng thiết lập:

**`vus: 1, iterations: 1`:**

Đây là **correctness probe**, không phải load test. Một VU duy nhất chạy đúng 1 iteration. Trong iteration đó, script gọi tuần tự 6 request (mỗi request đến một service). Tổng cộng 6 HTTP requests.

Tại sao không dùng nhiều VU? Vì:

- Các request là **sequential proof**, không phải concurrent load
- Nếu có nhiều VU, request của VU A có thể xen giữa request của VU B → khó đọc kết quả
- Mỗi request assertion có label chứa tên API -- nếu nhiều VU cùng chạy, các check sẽ bị trộn lẫn

**`checks: ['rate==1']`:**

Contract cứng: **100% checks phải pass**. Mỗi request tạo ra 5-6 checks. Với 6 request, tổng cộng khoảng 31 checks (6 request x 5 checks + 1 extra check cho `home` instance_id). Nếu dù chỉ 1 check fail, k6 exit code != 0.

**`http_req_failed: ['rate==0']`:**

Không một request nào được phép thất bại ở tầng HTTP. Lưu ý: `http_req_failed` trong k6 mặc định coi status >= 400 là "failed". Threshold này đảm bảo mọi response đều có status < 400.

**`tags` block:**

Tags được gắn vào mọi metric mà script tạo ra. Chúng dùng để:

- Lọc metrics trên dashboard: `{scenario: "lb_domain_boundaries"}`
- Phân biệt với các case LB khác
- Xác nhận topology đúng: `lb_profile: 'full-no-cdn'`

### 5.5 `default()` function -- logic chính

```javascript
export default function () {
  for (const api of lbBoundaryApis) {
    const res = requestLB(api, {
      tags: {
        endpoint: api.name,
        lb_profile: 'full-no-cdn',
      },
    });
    assertLBResponse(res, api, `${api.name} boundary`);
  }
}
```

Vòng lặp `for...of` duyệt qua từng phần tử trong `lbBoundaryApis`. Với mỗi API:

**Bước 1 -- Gửi request:**

```javascript
const res = requestLB(api, {
  tags: {
    endpoint: api.name,
    lb_profile: 'full-no-cdn',
  },
});
```

`requestLB(api, overrides)` làm gì?

1. Lấy `BASE_URL` (`http://localhost:80`) + `api.path` → build full URL
2. Set `Content-Type: application/json`
3. Merge `overrides.headers` nếu có
4. Dựa vào `api.method` để gọi `http.get()`, `http.post()`, `http.patch()`, hoặc `http.del()`
5. Với POST/PATCH, serialize `api.body` thành JSON string
6. Gắn `overrides.tags` vào request params
7. Gọi `recordTargetResourceMetrics()` để thu thập metrics từ response body

Tags được truyền vào gồm:

- `endpoint: api.name` -- cho phép lọc metrics theo từng endpoint (ví dụ: `http_req_duration{endpoint:"auth_me"}`)
- `lb_profile: 'full-no-cdn'` -- xác nhận topology

**Bước 2 -- Assert response:**

```javascript
assertLBResponse(res, api, `${api.name} boundary`);
```

`assertLBResponse(res, api, label)` thực thi 5 assertion checks:

```javascript
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
```

Và nếu `api.expectInstanceID === true`, thêm check thứ 6:

```javascript
check(res, {
  [`${prefix} has instance id`]: (r) => {
    const instanceID = safeJsonField(r, 'instance_id');
    return typeof instanceID === 'string' && instanceID.trim() !== '';
  },
});
```

**Phân tích từng check:**

| Check | Ý nghĩa | Tại sao quan trọng |
| --- | --- | --- |
| `status` | HTTP status code đúng như expected | Cơ bản nhất -- xác nhận service trả về response hợp lệ |
| `served by nginx` | Response được phục vụ bởi Nginx | Xác nhận request ĐÃ đi qua Nginx, không phải direct đến service |
| `upstream matches` | `X-Upstream-Service` khớp với expected | **Check quan trọng nhất** -- xác nhận route đúng service |
| `request id present` | Có `X-Request-ID` header | Chứng minh Gateway đã gắn trace ID |
| `no cache header` | KHÔNG có `X-Cache` header | Xác nhận request không đi qua CDN/Varnish |
| `has instance id` | Response body có `instance_id` | Chỉ cho `home` -- xác nhận request đến được app instance thật |

### 5.6 Hàm `headerValue(res, name)` -- case-insensitive lookup

Được định nghĩa trong `shared.js`, hàm này tìm kiếm header **không phân biệt hoa thường**:

```javascript
function headerValue(res, name) {
  const headers = res.headers || {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return headers[key];
    }
  }
  return '';
}
```

Tại sao cần case-insensitive lookup? Vì HTTP header name là case-insensitive theo chuẩn RFC 7230. `X-Upstream-Service` và `x-upstream-service` là cùng một header. Nếu dùng `res.headers['X-Upstream-Service']` trực tiếp, có thể bỏ sót nếu server gửi về dạng lowercase.

### 5.7 `expectedUpstreamForPath(path)` -- hàm mapping trong shared.js

Hàm này không được sử dụng trực tiếp trong case 03 (vì `lbBoundaryApis` đã hardcode `expectedUpstream`), nhưng nó là **companion function** thể hiện logic routing:

```javascript
export function expectedUpstreamForPath(path) {
  if (path.startsWith('/api/sim/auth/'))      return 'auth-service';
  if (path.startsWith('/api/sim/cart'))        return 'cart-service';
  if (path === '/api/sim/checkout' || path.startsWith('/api/sim/orders/')) return 'order-service';
  if (path.startsWith('/api/sim/products'))    return 'products-service';
  if (path === '/api/sim/report' || path.startsWith('/api/sim/report/'))  return 'report-service';
  return 'app';
}
```

Hàm này được dùng trong case 05 (`lbServiceMixApis`) để tự động tính `expectedUpstream` từ path. Ở case 03, giá trị được hardcode để cho phép kiểm soát chính xác và độc lập từng endpoint.

### 5.8 Sơ đồ tổ chức toàn bộ script

```text
┌─ options: vus=1, iterations=1, thresholds checks rate==1 + http_req_failed rate==0
│
└─ default()
    ├─ for each api in lbBoundaryApis:
    │   ├─ requestLB(api, tags)
    │   │   ├─ http.get/post(BASE_URL + api.path, headers, body)
    │   │   └─ recordTargetResourceMetrics(res)
    │   └─ assertLBResponse(res, api, label)
    │       ├─ check status === api.expected
    │       ├─ check X-Served-By === 'nginx' OR Server starts with 'nginx/'
    │       ├─ check X-Upstream-Service === api.expectedUpstream
    │       ├─ check X-Request-ID present
    │       ├─ check X-Cache absent
    │       └─ check instance_id (only if api.expectInstanceID)
    │
    └─ end → 6 requests, ~31 checks
```

---

## 6. Nginx/LB mechanism

### 6.1 Mô hình upstream trong Nginx

Nginx sử dụng chỉ thị `upstream` để định nghĩa một nhóm backend servers:

```nginx
# Định nghĩa upstream block cho từng service
upstream app {
    server app:8080;
}

upstream auth-service {
    server auth-service:8081;
}

upstream cart-service {
    server cart-service:8082;
}

upstream order-service {
    server order-service:8083;
}

upstream products-service {
    server products-service:8084;
}

upstream report-service {
    server report-service:8085;
}
```

Mỗi `upstream` block định nghĩa:

- **Tên upstream**: Dùng để tham chiếu trong `proxy_pass`
- **Server address**: `service_name:port` -- tên service trong Docker network + cổng nội bộ
- **Load balancing algorithm**: Mặc định là round-robin (không cần khai báo thêm)

### 6.2 Location-based routing

Nginx dùng chỉ thị `location` để map URL path vào upstream:

```nginx
server {
    listen 80;

    # Route chính xác: checkout
    location = /api/sim/checkout {
        proxy_pass http://order-service;
        proxy_set_header X-Upstream-Service "order-service";
        proxy_set_header X-Request-ID $request_id;
    }

    # Route prefix: auth
    location /api/sim/auth/ {
        proxy_pass http://auth-service;
        proxy_set_header X-Upstream-Service "auth-service";
        proxy_set_header X-Request-ID $request_id;
    }

    # Route prefix: cart
    location /api/sim/cart {
        proxy_pass http://cart-service;
        proxy_set_header X-Upstream-Service "cart-service";
        proxy_set_header X-Request-ID $request_id;
    }

    # Route prefix: orders
    location /api/sim/orders/ {
        proxy_pass http://order-service;
        proxy_set_header X-Upstream-Service "order-service";
        proxy_set_header X-Request-ID $request_id;
    }

    # Route prefix: products
    location /api/sim/products {
        proxy_pass http://products-service;
        proxy_set_header X-Upstream-Service "products-service";
        proxy_set_header X-Request-ID $request_id;
    }

    # Route prefix: report
    location /api/sim/report {
        proxy_pass http://report-service;
        proxy_set_header X-Upstream-Service "report-service";
        proxy_set_header X-Request-ID $request_id;
    }

    # Default: app
    location / {
        proxy_pass http://app;
        proxy_set_header X-Upstream-Service "app";
        proxy_set_header X-Request-ID $request_id;
    }
}
```

### 6.3 Thứ tự ưu tiên của Nginx location matching

Nginx chọn `location` block theo thứ tự ưu tiên sau:

| Ưu tiên | Loại location | Ví dụ | Khi nào dùng |
| --- | --- | --- | --- |
| 1 (cao nhất) | Exact match (`=`) | `location = /api/sim/checkout` | Path chính xác, không có variant |
| 2 | Preferential prefix (`^~`) | `location ^~ /api/sim/auth/` | Prefix match ưu tiên cao, dừng tìm kiếm regex |
| 3 | Regex match (`~` hoặc `~*`) | `location ~* \.png$` | Pattern match bằng regex |
| 4 (thấp nhất) | Prefix match (thường) | `location /api/sim/cart` | Prefix match thông thường |

Trong case này:

- `/api/sim/checkout` dùng exact match (`=`) vì path này có cả POST method -- cần đảm bảo route chính xác, không bị prefix khác "nuốt"
- `/api/sim/products` dùng prefix match -- mọi path con như `/api/sim/products/1`, `/api/sim/products/search?q=shoe` đều match
- `/` là catch-all (default) -- mọi path không match các rule trên đều rơi vào đây

### 6.4 Cách Nginx thêm header `X-Upstream-Service`

`X-Upstream-Service` không phải là header tự động của Nginx. Nó được thêm thủ công qua `proxy_set_header`:

```nginx
proxy_set_header X-Upstream-Service "products-service";
```

Điều này có nghĩa:

- **Nginx thêm header này vào request forward đến upstream**, nhưng upstream (service) có thể đọc hoặc bỏ qua nó
- **Upstream service echo lại header này** trong response (trong implementation hiện tại, service đọc header này và trả về trong response)
- **k6 đọc header này từ response** để xác minh routing

Nếu một ngày service ngừng echo `X-Upstream-Service`, tất cả LB test sẽ fail -- không phải vì Nginx route sai, mà vì signal bị mất. Đây là lý do `assertLBResponse` còn check `X-Served-By` và `Server` header làm backup signal.

### 6.5 Cách Nginx gắn `X-Request-ID`

```nginx
proxy_set_header X-Request-ID $request_id;
```

`$request_id` là biến nội bộ của Nginx, được tạo tự động cho mỗi request đến. Nó là một chuỗi unique 32 ký tự hex. Biến này tồn tại từ Nginx 1.11.0+.

Việc gắn `X-Request-ID` cho phép:

- **Tracing**: Theo dõi một request xuyên suốt từ Nginx → upstream service → response
- **Debugging**: Khi có lỗi, dùng request ID để tìm log tương ứng trong Nginx access log và service log
- **Deduplication**: Nếu client retry, request ID khác sẽ được tạo → phân biệt được retry với request gốc

### 6.6 `X-Served-By` và `Server` header

Đây là hai cách độc lập để xác nhận response đi qua Nginx:

```text
Cách 1: X-Served-By: nginx          ← header tùy chỉnh được thêm có chủ đích
Cách 2: Server: nginx/1.25.3        ← header mặc định của Nginx
```

`assertLBResponse` chấp nhận một trong hai:

```javascript
return explicit === 'nginx' || server.toLowerCase().startsWith('nginx/');
```

Điều này tăng tính linh hoạt: nếu `X-Served-By` không được thêm (vd: phiên bản Nginx cũ), `Server` header cũng đủ để xác nhận.

---

## 7. Request sequence flow

### 7.1 Timeline toàn bộ script

```text
T0: k6 start
│
├─ T1: GET  /                              → app
│   ├─ Nginx nhận request
│   ├─ Match location / (default)
│   ├─ Forward đến upstream app (app:8080)
│   ├─ App trả về 200 + instance_id
│   ├─ Nginx thêm X-Upstream-Service: app, X-Request-ID
│   └─ k6 nhận response → assert 5+1 checks
│
├─ T2: GET  /api/sim/auth/me              → auth-service
│   ├─ Nginx nhận request
│   ├─ Match location /api/sim/auth/
│   ├─ Forward đến upstream auth-service (auth-service:8081)
│   ├─ Auth service trả về 200
│   ├─ Nginx thêm X-Upstream-Service: auth-service, X-Request-ID
│   └─ k6 nhận response → assert 5 checks
│
├─ T3: GET  /api/sim/cart/summary          → cart-service
│   ├─ Match location /api/sim/cart
│   ├─ Forward đến upstream cart-service (cart-service:8082)
│   └─ assert 5 checks
│
├─ T4: POST /api/sim/checkout              → order-service
│   ├─ Body: {"payment_method":"card"}
│   ├─ Match exact location = /api/sim/checkout
│   ├─ Forward đến upstream order-service (order-service:8083)
│   └─ assert 5 checks
│
├─ T5: GET  /api/sim/products              → products-service
│   ├─ Match location /api/sim/products
│   ├─ Forward đến upstream products-service (products-service:8084)
│   └─ assert 5 checks
│
├─ T6: GET  /api/sim/report/jobs?limit=5  → report-service
│   ├─ Match location /api/sim/report
│   ├─ Forward đến upstream report-service (report-service:8085)
│   └─ assert 5 checks
│
└─ T7: k6 end (tổng 6 requests, ~31 checks)
```

### 7.2 Phân tích từng request

#### T1: `GET /` → app

```text
Đây là request đặc biệt nhất trong case vì 3 lý do:
1. Dùng location / (catch-all) -- nếu các rule khác không match, request rơi vào đây
2. expectInstanceID: true -- kiểm tra thêm instance_id trong response body
3. Là entrypoint chính -- nếu route này sai, tất cả traffic đều sai

Request flow:
  1. k6 gửi GET http://localhost:80/
  2. Nginx location matching: không match /api/sim/auth/, /api/sim/cart, ...
     → rơi vào location / (default)
  3. Nginx proxy_pass http://app → forward đến upstream app
  4. App xử lý, trả về JSON: {"message": "...", "instance_id": "app-1"}
  5. Nginx thêm response headers: X-Upstream-Service: app, X-Request-ID: ...
  6. k6 assert: status 200, served by nginx, upstream=app, request_id present, no cache, instance_id present
```

#### T2: `GET /api/sim/auth/me` → auth-service

```text
Request flow:
  1. k6 gửi GET http://localhost:80/api/sim/auth/me
  2. Nginx location matching:
     - /api/sim/checkout? Không (exact match, không khớp)
     - /api/sim/auth/? CÓ (prefix match)
  3. Nginx proxy_pass http://auth-service
  4. Auth service xử lý, trả về thông tin user
  5. k6 assert: upstream=auth-service
```

#### T4: `POST /api/sim/checkout` → order-service

```text
Đây là request POST DUY NHẤT trong case. Nó chứng minh:
- Nginx route đúng không chỉ dựa trên path mà còn xử lý đúng HTTP method
- POST request có body JSON được forward nguyên vẹn
- Body được serialize từ {payment_method: 'card'} thành '{"payment_method":"card"}'

Request flow:
  1. k6 gửi POST http://localhost:80/api/sim/checkout
     Body: {"payment_method":"card"}
     Headers: Content-Type: application/json
  2. Nginx location matching: /api/sim/checkout → exact match (=)
  3. Nginx proxy_pass http://order-service
  4. Order service nhận POST + body, xử lý checkout, trả về 200
  5. k6 assert: status 200, upstream=order-service
```

### 7.3 Luồng dữ liệu qua các tầng

```text
┌─────────────────────────────────────────────────────────────────────┐
│ k6 (VU)                                                             │
│ ├─ requestLB(api)                                                   │
│ │   ├─ Build URL: BASE_URL + api.path                              │
│ │   ├─ Set Content-Type: application/json                          │
│ │   ├─ POST: serialize api.body → JSON string                      │
│ │   └─ http.get/post/patch/del(url, body, {headers, tags})         │
│ └─ assertLBResponse(res, api, label)                                │
│     ├─ check status                                                 │
│     ├─ check X-Served-By / Server                                  │
│     ├─ check X-Upstream-Service === api.expectedUpstream           │
│     ├─ check X-Request-ID !== ''                                   │
│     ├─ check X-Cache === '' (absent)                               │
│     └─ check instance_id (nếu expectInstanceID)                    │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ HTTP request qua :80
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Nginx (:80)                                                         │
│ ├─ Nhận request                                                     │
│ ├─ Location matching → chọn location block                         │
│ ├─ proxy_pass → forward đến upstream                               │
│ ├─ Thêm X-Upstream-Service header (proxy_set_header)               │
│ ├─ Thêm X-Request-ID header (proxy_set_header)                     │
│ ├─ Nhận response từ upstream                                       │
│ └─ Trả response về cho client (k6)                                  │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ HTTP request qua internal network
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Upstream service (auth/cart/order/products/report/app)              │
│ ├─ Nhận request từ Nginx                                            │
│ ├─ Xử lý logic nghiệp vụ                                           │
│ ├─ Echo X-Upstream-Service trong response (nếu được implement)     │
│ └─ Trả response (status + body + headers)                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 8. Key signals / headers cần verify

### 8.1 Bảng header cần kiểm tra

| Header | Vị trí | Giá trị cần verify | Hàm assert | Xuất hiện ở request nào |
| --- | --- | --- | --- | --- |
| `X-Upstream-Service` | Response | `app`, `auth-service`, `cart-service`, `order-service`, `products-service`, `report-service` | `headerValue(r, 'X-Upstream-Service') === api.expectedUpstream` | Tất cả 6 request |
| `X-Served-By` | Response | `nginx` | `headerValue(r, 'X-Served-By') === 'nginx'` | Tất cả 6 request |
| `Server` | Response | Bắt đầu bằng `nginx/` | `server.startsWith('nginx/')` | Tất cả 6 request (backup signal) |
| `X-Request-ID` | Response | Chuỗi không rỗng (32 ký tự hex) | `!!headerValue(r, 'X-Request-ID')` | Tất cả 6 request |
| `X-Cache` | Response | **PHẢI VẮNG MẶT** | `!headerValue(r, 'X-Cache')` | Tất cả 6 request |
| `Content-Type` | Request | `application/json` | Không assert (được set mặc định trong `requestApi`) | Tất cả 6 request |
| `instance_id` | Response body | Chuỗi không rỗng | `safeJsonField(r, 'instance_id')` | Chỉ `home` (`GET /`) |

### 8.2 Chi tiết từng header

#### `X-Upstream-Service` -- header quan trọng nhất

```text
X-Upstream-Service: auth-service
```

Đây là **primary signal** của case 03. Nó trả lời câu hỏi duy nhất: "Request này đã được route đến service nào?"

Mỗi request trong case này có một expected upstream khác nhau:

| Request | Expected `X-Upstream-Service` |
| --- | --- |
| `GET /` | `app` |
| `GET /api/sim/auth/me` | `auth-service` |
| `GET /api/sim/cart/summary` | `cart-service` |
| `POST /api/sim/checkout` | `order-service` |
| `GET /api/sim/products` | `products-service` |
| `GET /api/sim/report/jobs?limit=5` | `report-service` |

Nếu `X-Upstream-Service` không khớp, đó là dấu hiệu **Nginx location config sai** hoặc **upstream block trỏ nhầm service**.

#### `X-Cache` -- header của sự vắng mặt

```text
X-Cache: (không tồn tại)
```

Trong LB test với `full-no-cdn`, `X-Cache` **phải vắng mặt hoàn toàn**. Nếu xuất hiện, có nghĩa là request đã đi qua Varnish/CDN -- tức là đang chạy sai topology. Đây là "negative signal" (tín hiệu phủ định) quan trọng.

So sánh với CDN test: ở CDN test, `X-Cache: HIT` hoặc `X-Cache: MISS` là expected. Ở LB test, sự hiện diện của `X-Cache` là **FAIL**.

### 8.3 Cách đọc header từ k6 output

```text
█ checks...
  ✓ home boundary status
  ✓ home boundary served by nginx
  ✓ home boundary upstream matches
  ✓ home boundary request id present
  ✓ home boundary no cache header
  ✓ home boundary has instance id
  ✓ auth_me boundary status
  ✓ auth_me boundary served by nginx
  ✓ auth_me boundary upstream matches
  ...
```

Mỗi dòng `✓` là một `check()` pass. Pattern đặt tên là `${api.name} boundary ${check_name}`. Ví dụ `auth_me boundary upstream matches` có nghĩa là request `auth_me` đã pass check "upstream matches" (X-Upstream-Service === 'auth-service').

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Case được coi là PASS khi **tất cả** các điều kiện sau đều đúng:

| # | Tiêu chí | Cách xác minh | Định lượng |
| --- | --- | --- | --- |
| 1 | k6 exit code = 0 | `$LASTEXITCODE` hoặc CI job status | `exit 0` |
| 2 | Tất cả checks pass | k6 output: `checks... 100%` | `checks rate = 1.0` (31/31 checks) |
| 3 | Tất cả HTTP status đúng | `http_req_failed rate = 0` | 0% request failed (0/6) |
| 4 | 6/6 upstream đúng | Xem named checks: `upstream matches` | 6/6 upstream matches pass |
| 5 | Không có `X-Cache` | `no cache header` check pass cho tất cả 6 request | 6/6 no-cache checks pass |
| 6 | Tất cả request có `X-Request-ID` | `request id present` check pass | 6/6 request-id checks pass |
| 7 | `home` có `instance_id` | `has instance id` check pass | 1/1 instance-id check pass |

### 9.2 Tiêu chí FAIL

Case FAIL khi **bất kỳ** điều kiện nào sau đây xảy ra:

| # | Dấu hiệu FAIL | Nguyên nhân khả dĩ | Cách debug |
| --- | --- | --- | --- |
| A | `X-Upstream-Service` sai | Nginx location config sai hoặc upstream block trỏ nhầm | Kiểm tra `nginx.conf`: `location` blocks và `proxy_pass` directives |
| B | `X-Upstream-Service` thiếu | Service không echo lại header, hoặc Nginx không thêm `proxy_set_header` | Kiểm tra `nginx.conf`: có `proxy_set_header X-Upstream-Service ...` không? |
| C | Có `X-Cache` header | Đang chạy qua topology `full` (có Varnish) thay vì `full-no-cdn` | Kiểm tra `docker ps` -- nếu có Varnish container là sai topology |
| D | Status không phải 200 | Service không healthy hoặc không tồn tại | `docker ps` kiểm tra service đang chạy; `docker logs <service>` xem lỗi |
| E | Thiếu `X-Request-ID` | Nginx version cũ (< 1.11.0) không có `$request_id` | `nginx -v` kiểm tra version |
| F | `http_req_failed > 0` | Có request trả về status >= 400 | Xem k6 output để biết request nào failed + status code thực tế |
| G | `checks rate < 1.0` | Có ít nhất 1 check fail | Đọc danh sách check ✗ để xác định check nào fail |
| H | `home` thiếu `instance_id` | App service không trả về `instance_id` trong response body | Kiểm tra response body: `curl http://localhost:80/` |
| I | Connection refused / timeout | Nginx hoặc service không chạy | `docker ps`, `docker logs nginx` |

### 9.3 Cách đọc kết quả FAIL chi tiết

Giả sử k6 output có dòng:

```text
✗ cart_summary boundary upstream matches
  ↳ 0% — expected X-Upstream-Service=cart-service, got products-service
```

Phân tích:

1. Request `cart_summary` -- tức là `GET /api/sim/cart/summary`
2. Expected upstream: `cart-service`
3. Got upstream: `products-service`
4. Kết luận: Nginx location `/api/sim/cart` trỏ nhầm sang products-service upstream
5. Hành động: Kiểm tra `nginx.conf` -- tìm `location /api/sim/cart` và xem `proxy_pass` directive

### 9.4 Ma trận quyết định

| Tình trạng | Upstream đúng? | X-Cache absent? | checks rate | Kết luận | Hành động |
| --- | --- | --- | --- | --- | --- |
| A | Có (6/6) | Có | 1.0 | PASS hoàn toàn | Không cần làm gì |
| B | Không (1+ route sai) | Có | < 1.0 | Nginx config sai upstream | Sửa `nginx.conf` location + proxy_pass |
| C | Có (6/6) | Không (có X-Cache) | < 1.0 | Sai topology (đang dùng `full`) | Chạy lại với `-TargetLayer full-no-cdn` |
| D | Không xác định được (503/502) | Không | < 1.0 | Service không chạy | `docker ps`, khởi động lại stack |
| E | Có (6/6) | Có nhưng thiếu request-id | < 1.0 | Nginx version cũ hoặc config thiếu | Kiểm tra `$request_id` availability |

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy

```powershell
# 1. Di chuyển đến thư mục gốc
cd E:\Projects\k6\k6-metrics-server

# 2. Set biến môi trường
$env:BASE_URL = "http://localhost:80"

# 3. Chạy script (dùng runner script)
.\scripts\run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 03-domain-boundaries

# Hoặc chạy trực tiếp bằng k6:
k6 run .\load-target\k6\lb\03-domain-boundaries.js
```

### 10.2 Output mẫu mong đợi (PASS)

```text

         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: .\load-target\k6\lb\03-domain-boundaries.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations for each of 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)


     data_received..................: 8.5 kB  ...
     data_sent......................: 3.2 kB  ...
     http_req_blocked...............: avg=0.00ms  ...
     http_req_connecting............: avg=0.00ms  ...
     http_req_duration..............: avg=2.80ms  ...
     http_req_receiving.............: avg=0.10ms  ...
     http_req_sending...............: avg=0.02ms  ...
     http_req_waiting...............: avg=2.68ms  ...
     http_reqs......................: 6       ...
     iteration_duration.............: avg=25.30ms ...
     iterations.....................: 1        ...
     vus............................: 1        ...
     vus_max........................: 1        ...


█ checks...
  ✓ home boundary status
  ✓ home boundary served by nginx
  ✓ home boundary upstream matches
  ✓ home boundary request id present
  ✓ home boundary no cache header
  ✓ home boundary has instance id
  ✓ auth_me boundary status
  ✓ auth_me boundary served by nginx
  ✓ auth_me boundary upstream matches
  ✓ auth_me boundary request id present
  ✓ auth_me boundary no cache header
  ✓ cart_summary boundary status
  ✓ cart_summary boundary served by nginx
  ✓ cart_summary boundary upstream matches
  ✓ cart_summary boundary request id present
  ✓ cart_summary boundary no cache header
  ✓ checkout boundary status
  ✓ checkout boundary served by nginx
  ✓ checkout boundary upstream matches
  ✓ checkout boundary request id present
  ✓ checkout boundary no cache header
  ✓ products_list boundary status
  ✓ products_list boundary served by nginx
  ✓ products_list boundary upstream matches
  ✓ products_list boundary request id present
  ✓ products_list boundary no cache header
  ✓ report_job_list boundary status
  ✓ report_job_list boundary served by nginx
  ✓ report_job_list boundary upstream matches
  ✓ report_job_list boundary request id present
  ✓ report_job_list boundary no cache header

   ✓ checks........................: 100.00% ✓ 31   ✗ 0
     ✓ { scenario:lb_domain_boundaries }...: 100.00% ✓ 31   ✗ 0


running (00m00.0s), 1/1 VUs, 1 complete and 0 interrupted iterations
default ✓ [======================================] 1 VUs  00m00.0s/10m0s  1/1 iters, 1 per VU
```

### 10.3 Output mẫu khi FAIL (upstream sai)

```text
█ checks...
  ✓ home boundary status
  ✓ home boundary served by nginx
  ✓ home boundary upstream matches
  ✓ home boundary request id present
  ✓ home boundary no cache header
  ✓ home boundary has instance id
  ✓ auth_me boundary status
  ✓ auth_me boundary served by nginx
  ✗ auth_me boundary upstream matches
    ↳  0% — ✓ 0 / ✗ 1
  ✓ auth_me boundary request id present
  ✓ auth_me boundary no cache header
  ...

   ✗ checks........................: 96.77%  ✓ 30   ✗ 1
     ✗ { scenario:lb_domain_boundaries }...: 96.77%  ✓ 30   ✗ 1

ERRO[0002] thresholds on metrics 'checks' were crossed; at least one has failed
```

### 10.4 Cách đọc output

| Phần output | Ý nghĩa | Hành động |
| --- | --- | --- |
| `http_reqs: 6` | Tổng cộng 6 HTTP requests đã được gửi | Đúng -- 6 endpoint, mỗi cái 1 request |
| `http_req_failed: 0.00%` | Không request nào thất bại ở tầng HTTP | Tốt |
| `✓ checks...: 100.00% ✓ 31 ✗ 0` | Tất cả 31 checks pass | Case PASS |
| `✗ checks...: XX% ✓ N ✗ M` | Có M checks fail | Đọc tên từng check ✗ để xác định endpoint + loại lỗi |
| `ERRO[...] thresholds on metrics 'checks' were crossed` | checks rate < 1.0 → k6 exit code != 0 | Case FAIL |

---

## 11. 4 output -> decision scenarios

### Scenario 1: ALL PASS

```text
✓ checks 100% -- tất cả 31 checks xanh
http_req_failed: 0.00%
```

**Kết luận:** Nginx route đúng tất cả 6 domain boundary. Gateway đã sẵn sàng cho microservices routing trong production.

**Quyết định:** Có thể tự tin triển khai thêm các case LB nâng cao (failover, canary, pressure, timeout) vì nền tảng routing đã đúng. Mọi request đến đúng service -- không có "nhầm nhọt" ở tầng gateway.

### Scenario 2: Một route sai upstream

```text
✗ auth_me boundary upstream matches
  (expected auth-service, got cart-service)

Tất cả các route khác: PASS
```

**Phân tích:**
- Chỉ 1/6 route sai → vấn đề nằm ở location block cụ thể cho `/api/sim/auth/`
- Các route khác đúng → Nginx hoạt động bình thường, chỉ sai config ở một chỗ

**Nguyên nhân khả dĩ:**
1. `location /api/sim/auth/` có `proxy_pass http://cart-service` (copy-paste error)
2. upstream `auth-service` block trỏ đến sai cổng (vd: `server cart-service:8082`)
3. Thiếu `location /api/sim/auth/` hoàn toàn → request rơi vào default `location /` → route đến app

**Quyết định:**
- Sửa `nginx.conf`: kiểm tra `location /api/sim/auth/` block
- Reload Nginx config: `docker exec <nginx-container> nginx -s reload`
- Chạy lại case 03 để xác nhận fix

### Scenario 3: Có `X-Cache` header

```text
✗ home boundary no cache header
✗ auth_me boundary no cache header
... (tất cả 6 request đều fail no-cache check)

Nhưng upstream matches VẪN PASS
```

**Phân tích:**
- Upstream vẫn đúng → Nginx config OK
- Có `X-Cache` ở tất cả request → request đang đi qua Varnish/CDN

**Nguyên nhân khả dĩ:**
1. Stack được khởi động với `-TargetLayer full` thay vì `full-no-cdn`
2. Có một Varnish instance "sót lại" từ lần chạy trước

**Quyết định:**
- Dừng stack hiện tại: `.\scripts\stack.ps1 -Stack target -Action down`
- Khởi động lại với đúng topology: `-TargetLayer full-no-cdn`
- Xác nhận: `docker ps --filter "name=varnish"` phải không có kết quả

### Scenario 4: Service không phản hồi (503/502/timeout)

```text
✗ report_job_list boundary status
  (expected 200, got 502)

✗ report_job_list boundary upstream matches
  (X-Upstream-Service header missing)
```

**Phân tích:**
- Status 502 (Bad Gateway) → Nginx không kết nối được đến upstream
- `X-Upstream-Service` thiếu → Nginx không forward được request đến service

**Nguyên nhân khả dĩ:**
1. `report-service` container không chạy hoặc đã crash
2. upstream `report-service` block trỏ đến sai hostname hoặc cổng
3. Docker network không cho phép Nginx kết nối đến report-service

**Quyết định:**
- `docker ps -a` kiểm tra report-service container status
- `docker logs report-service` xem log lỗi
- `docker exec nginx ping report-service` kiểm tra network connectivity
- Khởi động lại service nếu cần: `docker compose up -d report-service`

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Response 200 nghĩa là route đúng"

```text
Sai:    GET /api/sim/auth/me → 200 → "Auth service đã xử lý request này"
Đúng:   GET /api/sim/auth/me → 200 + X-Upstream-Service: cart-service
        → Cart service tình cờ có handler cho path này và trả về 200
        → Nhưng logic xác thực không hề được chạy
```

**Giải thích:** Trong môi trường thực tế, một service có thể trả về 200 cho bất kỳ path nào nếu nó có wildcard route handler (vd: Express.js `app.get('*', ...)`). Response 200 không phải là bằng chứng của việc route đúng -- chỉ `X-Upstream-Service` mới là bằng chứng đó.

### Nghịch lý 2: "Tất cả upstream đều là app"

```text
Sai:    "App service xử lý được tất cả request, cần gì microservices?"
Đúng:   App có thể xử lý được, nhưng điều đó có nghĩa là bạn vẫn đang chạy monolith
        và toàn bộ công sức phân rã microservices trở nên vô nghĩa.
```

**Giải thích:** Trong quá trình chuyển đổi từ monolith sang microservices, có một giai đoạn "strangler fig" khi một số route vẫn được xử lý bởi monolith cũ. Case 03 giúp xác minh rằng **từng route đã được chuyển đúng sang service mới**, không còn route nào "rò rỉ" về monolith.

### Nghịch lý 3: "Chỉ cần test GET, POST cũng sẽ hoạt động"

```text
Sai:    Tất cả GET request route đúng → POST cũng sẽ đúng
Đúng:   Nginx location matching hoạt động dựa trên URI path, không phụ thuộc method.
        Nhưng POST request có body → cần xác minh body được forward nguyên vẹn.
```

**Giải thích:** Mặc dù Nginx location matching không phân biệt GET/POST, việc case 03 include checkout (POST) là có chủ đích. Nó xác minh rằng:

- `proxy_pass` không strip body của POST request
- `Content-Type: application/json` được giữ nguyên
- Service nhận được body JSON hợp lệ

### Nghịch lý 4: "X-Upstream-Service là header tự động của Nginx"

```text
Sai:    Nginx tự động thêm X-Upstream-Service khi proxy_pass
Đúng:   X-Upstream-Service được thêm thủ công qua proxy_set_header.
        Nếu thiếu directive này, header sẽ không tồn tại.
```

**Giải thích:** Đây là lý do `assertLBResponse` có backup check `Server` header. Nếu một ngày ai đó xóa `proxy_set_header X-Upstream-Service` khỏi config, case sẽ fail ở check `upstream matches` nhưng vẫn pass `served by nginx` (nhờ `Server: nginx/...`). Điều này giúp phân biệt giữa "Nginx không hoạt động" và "Nginx hoạt động nhưng không gắn upstream header".

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=nginx"` | Có container Nginx | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2` |
| 2 | Tất cả 6 service đang chạy | `docker ps --filter "name=auth-service" --filter "name=cart-service" --filter "name=order-service" --filter "name=products-service" --filter "name=report-service"` | 5 container (auth, cart, order, products, report) | Khởi động lại stack với `-TargetLayer full-no-cdn` |
| 3 | App có ít nhất 2 instance | `docker ps --filter "name=app"` | 2+ container app | `-ScaleApp 2` |
| 4 | Public path hoạt động | `curl -sI http://localhost:80/` | HTTP 200, `Server: nginx/...` | Kiểm tra Nginx config |
| 5 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại biến môi trường |
| 6 | Không có Varnish | `docker ps --filter "name=varnish"` | Không có kết quả | Dừng stack, khởi động lại với `-TargetLayer full-no-cdn` |
| 7 | Từng upstream trả về đúng header | `curl -sI http://localhost:80/api/sim/auth/me \| grep -i x-upstream-service` | `X-Upstream-Service: auth-service` | Kiểm tra Nginx config |
| 8 | Không có test khác đang chạy | Kiểm tra không có process k6 nào đang chạy | Không có k6 process | Đợi test khác hoàn thành |

### 13.2 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 9 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\lb\03-domain-boundaries.js"` |
| 10 | `shared.js` tồn tại và export đúng | Import `lbBoundaryApis`, `requestLB`, `assertLBResponse` không lỗi |
| 11 | `lbBoundaryApis` có 6 phần tử | Mỗi phần tử có `expectedUpstream` tương ứng |
| 12 | `expectedUpstreamForPath()` map đúng | Test thủ công: gọi hàm với từng path để xác nhận mapping |
| 13 | `checkout` endpoint có body | POST request cần body `{payment_method: 'card'}` |

### 13.3 K6 checklist

| # | Mục kiểm tra |
| --- | --- |
| 14 | k6 đã được cài đặt: `k6 version` |
| 15 | Không có biến môi trường nào conflict (`K6_*` env vars) |
| 16 | Script chạy < 5 giây (1 VU, 6 requests) |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Thêm endpoint mới vào boundary test

Khi team thêm một microservice mới (ví dụ: `notification-service`), cần thêm nó vào `lbBoundaryApis`:

```javascript
// Variation 1: Add new service boundary
// Thêm vào lbBoundaryApis trong shared.js

export const lbBoundaryApis = [
  // ... 6 endpoint gốc ...

  // Thêm notification service
  {
    name: 'notification_list',
    method: 'GET',
    path: '/api/sim/notifications',
    expected: 200,
    expectedUpstream: 'notification-service',
  },
  {
    name: 'notification_send',
    method: 'POST',
    path: '/api/sim/notifications/send',
    body: { title: 'Test', body: 'Hello' },
    expected: 200,
    expectedUpstream: 'notification-service',
  },
];
```

**Điểm học:** Việc thêm boundary mới đơn giản là thêm object vào mảng `lbBoundaryApis`. Không cần sửa script case. Đây là lợi ích của kiến trúc data-driven: script chỉ là vòng lặp, logic nằm trong dữ liệu.

### Variation 2: Boundary test với method coverage đầy đủ

Mở rộng case để test tất cả HTTP methods cho một service:

```javascript
// Variation 2: Full method coverage for cart-service
// Kiểm tra cart service với GET, POST, PATCH, DELETE

const cartMethodApis = [
  { name: 'cart_view', method: 'GET', path: '/api/sim/cart', expected: 200, expectedUpstream: 'cart-service' },
  { name: 'cart_add', method: 'POST', path: '/api/sim/cart/add', body: { product_id: 1, quantity: 1 }, expected: 200, expectedUpstream: 'cart-service' },
  { name: 'cart_update', method: 'PATCH', path: '/api/sim/cart/items/sku-1', body: { quantity: 2 }, expected: 200, expectedUpstream: 'cart-service' },
  { name: 'cart_delete', method: 'DELETE', path: '/api/sim/cart/items/sku-1', expected: 200, expectedUpstream: 'cart-service' },
];

export default function () {
  for (const api of cartMethodApis) {
    const res = requestLB(api, {
      tags: { endpoint: api.name, lb_profile: 'full-no-cdn' },
    });
    assertLBResponse(res, api, `${api.name} boundary`);
  }
}
```

**Điểm học:** Boundary routing hoạt động độc lập với HTTP method. Cùng một path prefix có thể nhận GET, POST, PATCH, DELETE và tất cả đều được route đến đúng service.

### Variation 3: Negative test -- xác nhận route sai bị phát hiện

```javascript
// Variation 3: Negative boundary test
// Cố tình assert sai upstream để xác nhận hệ thống phát hiện lỗi

const wrongUpstreamApi = {
  name: 'auth_me_wrong_expectation',
  method: 'GET',
  path: '/api/sim/auth/me',
  expected: 200,
  expectedUpstream: 'cart-service',  // Cố tình sai! Auth service không phải cart
};

export default function () {
  const res = requestLB(wrongUpstreamApi, {
    tags: { endpoint: 'auth_me_wrong' },
  });

  // Check này SẼ FAIL -- nhưng đó là điều mong muốn
  // Nó chứng minh rằng assertLBResponse thực sự kiểm tra upstream
  assertLBResponse(res, wrongUpstreamApi, 'negative test');
  // Expected: ✗ negative test upstream matches
  //          (expected cart-service, got auth-service)
}
```

**Điểm học:** Negative test xác nhận rằng assertion thực sự hoạt động. Nếu negative test PASS (tức là `auth_me` trả về `X-Upstream-Service: cart-service`), thì có vấn đề thực sự với Nginx config.

### Variation 4: Boundary test với custom header xác thực

```javascript
// Variation 4: Boundary routing with auth headers
// Một số service yêu cầu header xác thực -- xác nhận route vẫn đúng

export default function () {
  for (const api of lbBoundaryApis) {
    const res = requestLB(api, {
      headers: {
        Authorization: 'Bearer test-token-123',
        'X-User-Id': 'user-42',
      },
      tags: {
        endpoint: api.name,
        lb_profile: 'full-no-cdn',
        auth: 'authenticated',
      },
    });
    assertLBResponse(res, api, `${api.name} boundary with auth`);
  }
}
```

**Điểm học:** Thêm header xác thực không ảnh hưởng đến Nginx routing (vì Nginx route dựa trên URL path, không dựa trên header). Nhưng một số service có thể trả về 401/403 nếu thiếu token. Variation này xác minh rằng:

- Route vẫn đúng khi có auth header
- Service xử lý đúng auth header (trả 200 nếu token hợp lệ, 401 nếu không)

### Variation 5: Boundary test với nhiều iteration để phát hiện route flakiness

```javascript
// Variation 5: Multi-iteration boundary consistency
// Chạy 100 iteration để đảm bảo routing nhất quán

export const options = {
  vus: 1,
  iterations: 100,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
  tags: {
    scenario: 'lb_domain_boundaries_consistency',
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};

export default function () {
  for (const api of lbBoundaryApis) {
    const res = requestLB(api, {
      tags: {
        endpoint: api.name,
        iteration: `${__VU}-${__ITER}`,
      },
    });
    assertLBResponse(res, api, `${api.name} boundary iter=${__ITER}`);
  }
}
```

**Điểm học:** Chạy 100 iteration giúp phát hiện các vấn đề intermittent:

- Round-robin không hoạt động đúng (một instance luôn bị bỏ qua)
- Timeout ngẫu nhiên ở một service
- DNS resolution fail trong Docker network

---

## 15. Anti-patterns

### Anti-pattern 1: Test boundary qua app port thay vì Nginx port

```text
SAI:    $env:BASE_URL = "http://localhost:8080"   // Gọi thẳng app, bỏ qua Nginx
        Kết quả: Mọi request đều đến app → không test được boundary

ĐÚNG:   $env:BASE_URL = "http://localhost:80"      // Gọi qua Nginx
        Kết quả: Request được Nginx route đến đúng service
```

**Hậu quả:** Khi test qua app port, mọi request đều đến app (vì không có Nginx route). Case vẫn PASS (checks đều xanh) nhưng thực tế boundary routing chưa từng được test. Đây là **false positive nguy hiểm**.

### Anti-pattern 2: Chỉ test GET, bỏ qua POST/PATCH/DELETE

```text
SAI:    Chỉ test GET request → "POST chắc cũng hoạt động thôi"
ĐÚNG:   Test cả POST -- case 03 có checkout endpoint là POST
```

**Hậu quả:** Một số Nginx config có thể có `limit_except` directive giới hạn method. Nếu chỉ test GET, bạn bỏ sót trường hợp POST bị chặn.

### Anti-pattern 3: Chạy case 03 với topology `full`

```text
SAI:    -TargetLayer full → có Varnish → X-Cache xuất hiện
ĐÚNG:   -TargetLayer full-no-cdn → không Varnish → X-Cache vắng mặt
```

**Hậu quả:** `X-Cache` xuất hiện làm fail check `no cache header`. Bạn có thể bị cám dỗ xóa check này khỏi assertion -- đừng làm vậy. Sự vắng mặt của `X-Cache` là một phần của contract.

### Anti-pattern 4: Thêm `expectedUpstream` sai vào `lbBoundaryApis`

```text
SAI:    { name: 'auth_me', ..., expectedUpstream: 'app' }
        → Check pass (X-Upstream-Service: auth-service khớp với expected: app? KHÔNG!)

ĐÚNG:   { name: 'auth_me', ..., expectedUpstream: 'auth-service' }
```

**Giải thích:** Đây là lỗi "garbage in, garbage out". Nếu bạn định nghĩa expected sai, case vẫn FAIL (vì actual upstream không khớp expected sai). Nhưng nếu Nginx cũng được cấu hình sai theo cùng một cách, case sẽ PASS trong khi thực tế routing sai.

### Anti-pattern 5: Bỏ qua check `instance_id` cho `home`

```text
SAI:    Xóa expectInstanceID khỏi home endpoint → thiếu check
ĐÚNG:   Giữ expectInstanceID: true → xác minh request đến được app instance thật
```

**Hậu quả:** `instance_id` là bằng chứng bổ sung rằng request không chỉ được route đến upstream app, mà còn được xử lý bởi một instance cụ thể. Nếu không có check này, bạn không biết được app có thực sự xử lý request hay không.

---

## 16. Real validation data

### 16.1 Kết quả thực tế

```text
Case: lb-03-domain-boundaries
Date: 2026-06-21
Stack: full-no-cdn, ScaleApp=2

Exit code: 0
Checks: 31/31 (100%)
HTTP requests: 6
HTTP failed: 0.00% (0/6)
Duration: ~25ms

Upstream verification (manual probe):
  GET  /                              → X-Upstream-Service: app               ✓
  GET  /api/sim/auth/me               → X-Upstream-Service: auth-service      ✓
  GET  /api/sim/cart/summary           → X-Upstream-Service: cart-service      ✓
  POST /api/sim/checkout               → X-Upstream-Service: order-service     ✓
  GET  /api/sim/products               → X-Upstream-Service: products-service  ✓
  GET  /api/sim/report/jobs?limit=5    → X-Upstream-Service: report-service    ✓

Result: PASS
```

### 16.2 Manual probe từng endpoint

```powershell
# Kiểm tra thủ công từng endpoint
curl -sI http://localhost:80/                              | grep -i x-upstream-service
# → X-Upstream-Service: app

curl -sI http://localhost:80/api/sim/auth/me               | grep -i x-upstream-service
# → X-Upstream-Service: auth-service

curl -sI http://localhost:80/api/sim/cart/summary           | grep -i x-upstream-service
# → X-Upstream-Service: cart-service

curl -sI -X POST http://localhost:80/api/sim/checkout       | grep -i x-upstream-service
# → X-Upstream-Service: order-service

curl -sI http://localhost:80/api/sim/products               | grep -i x-upstream-service
# → X-Upstream-Service: products-service

curl -sI http://localhost:80/api/sim/report/jobs?limit=5    | grep -i x-upstream-service
# → X-Upstream-Service: report-service
```

### 16.3 Xác nhận negative signals

```powershell
# Xác nhận không có X-Cache
curl -sI http://localhost:80/ | grep -i x-cache
# → (không có output -- X-Cache vắng mặt) ✓

# Xác nhận có X-Request-ID
curl -sI http://localhost:80/ | grep -i x-request-id
# → X-Request-ID: a1b2c3d4e5f6... ✓

# Xác nhận Server header là nginx
curl -sI http://localhost:80/ | grep -i server
# → Server: nginx/1.25.3 ✓
```

### 16.4 Kết quả khi cố tình cấu hình sai (negative validation)

```text
Thử nghiệm: Sửa nginx.conf -- đổi location /api/sim/auth/ proxy_pass thành http://cart-service

Kết quả:
  ✓ home boundary upstream matches        (app → app)
  ✗ auth_me boundary upstream matches     (expected auth-service, got cart-service)
  ✓ cart_summary boundary upstream matches (cart-service → cart-service)
  ✓ checkout boundary upstream matches     (order-service → order-service)
  ✓ products_list boundary upstream matches (products-service → products-service)
  ✓ report_job_list boundary upstream matches (report-service → report-service)

Checks: 30/31 (96.77%)
Exit code: 99 (FAIL)

Kết luận: Hệ thống phát hiện chính xác route sai -- chỉ auth_me bị ảnh hưởng,
các route khác không bị ảnh hưởng. Điều này chứng minh tính isolation của Nginx location blocks.
```

---

## 17. Reference

### 17.1 File liên quan

| File | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\03-domain-boundaries.js` | Script k6 chính |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\shared.js` | Shared helpers: `lbBoundaryApis`, `requestLB`, `assertLBResponse`, `expectedUpstreamForPath` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Base helpers: `requestApi`, `chooseWeighted`, `envString`, `envInt`, `envFloat` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\traffic.js` | Traffic profiles và API definitions (cacheable, dynamic, write, async) |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\case-catalog.json` | Catalog định nghĩa tất cả 12 LB case |
| `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Nginx config với upstream blocks và location directives |

### 17.2 Case liên quan

| Case | Mối quan hệ |
| --- | --- |
| `lb-01-entry-smoke` | Case cơ bản hơn -- chỉ test entrypoint qua Nginx (chưa có microservices) |
| `lb-04-origin-cacheable-read` | Dùng chung `products-service` upstream, nhưng tập trung vào cacheable reads |
| `lb-05-origin-service-mix` | Dùng `expectedUpstreamForPath()` và `lbServiceMixApis` để test toàn bộ service mix |
| `lb-06-retry-failover` | Dựa trên boundary routing đúng để test failover |
| `lb-08-weighted-routing-canary` | Dựa trên boundary routing đúng để test canary routing |

### 17.3 Tài liệu tham khảo

| Tài liệu | Nội dung |
| --- | --- |
| `./00_overview.md` | Tổng quan series LB -- mental model, key concepts, case inventory |
| `./RUN_GUIDE.md` | Hướng dẫn chạy toàn bộ LB suite |
| `./13_validation-and-chart-analysis.md` | Validation report và phân tích chart cho tất cả LB case |
| Nginx documentation | `location` directive: [nginx.org/en/docs/http/ngx_http_core_module.html#location](https://nginx.org/en/docs/http/ngx_http_core_module.html#location) |
| Nginx upstream module | [nginx.org/en/docs/http/ngx_http_upstream_module.html](https://nginx.org/en/docs/http/ngx_http_upstream_module.html) |
