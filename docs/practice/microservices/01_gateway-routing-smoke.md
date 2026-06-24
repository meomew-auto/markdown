# ms-01 -- Gateway routing smoke

> **Case ID:** `ms-01-gateway-routing-smoke`
> **Script:** `../shared-iterations/si-07-ci-verification-batch.js`
> **Profile:** `full-no-cdn`
> **Workload:** shared-iterations, 10 VUs, 100 jobs
> **Proof:** Nginx API Gateway route chính xác từng URL prefix đến đúng microservice -- không có request nào rơi vào fallback `app` upstream

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [Microservices capability được chứng minh](#2-microservices-capability-được-chứng-minh)
3. [Vì sao phải test ở Microservices layer](#3-vì-sao-phải-test-ở-microservices-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Nginx API Gateway mechanism](#6-nginx-api-gateway-mechanism)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / headers](#8-key-signals--headers)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output -> decision scenarios](#11-4-output---decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist trước khi chạy](#13-checklist-trước-khi-chạy)
14. [Variations với code mẫu](#14-variations-với-code-mẫu)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh nghiệp vụ

Trước khi test bất kỳ service contract nào, cần chứng minh Nginx route đúng URL prefix đến đúng microservice. Đây là bước kiểm tra nền tảng nhất trong toàn bộ microservices layer -- nếu routing sai, mọi contract test khác đều vô nghĩa vì request có thể đã đến sai service ngay từ đầu.

Hãy hình dung một hệ thống thương mại điện tử vừa trải qua đợt deploy lớn. DevOps team đã cập nhật Nginx config để thêm một upstream service mới (report-service) và điều chỉnh lại thứ tự location blocks. Sau deploy, team cần xác nhận ngay lập tức rằng:

- Request đến `/products` vẫn đến đúng `products-service`
- Request đến `/cart/add` vẫn đến đúng `cart-service`
- Request đến `/orders/:id/confirm` vẫn đến đúng `order-service`
- Request đến `/report/jobs` đến đúng `report-service` (service mới)
- Không có request nào bị rơi vào fallback `app` upstream

Nếu bất kỳ request nào rơi vào `X-Upstream-Service: app` (fallback), routing sai và cần rollback ngay lập tức.

### 1.2 Tại sao phải kiểm tra tất cả 5 service trong cùng một batch

Case này gửi request đến tất cả 5 service và kiểm tra header `X-Upstream-Service` trên từng response:

```text
/products       -> X-Upstream-Service: products-service
/products/:id   -> X-Upstream-Service: products-service
/cart/add       -> X-Upstream-Service: cart-service
/orders/:id     -> X-Upstream-Service: order-service
/report/jobs    -> X-Upstream-Service: report-service
```

Kiểm tra từng service riêng lẻ sẽ chậm và không phát hiện được các vấn đề xảy ra khi nhiều location block cùng hoạt động đồng thời. Một batch duy nhất bao phủ cả 5 service cho phép:

| Lợi ích của batch testing | Mô tả |
| --- | --- |
| **Phát hiện sai thứ tự location** | Nếu `location /api/sim/orders/` vô tình được đặt sau `location /api/sim/`, request đến orders có thể bị bắt bởi prefix rộng hơn. Batch test phát hiện ngay vì `X-Upstream-Service` sẽ không khớp. |
| **Phát hiện upstream block misconfigured** | Nếu `upstream order_service` trỏ sai port hoặc sai container name, chỉ request đến order-service mới fail. Batch test cho biết chính xác service nào bị ảnh hưởng. |
| **Phát hiện service down** | Một service có thể bị crash sau deploy mà không ai để ý. Batch test là "health check tổng hợp" -- nếu `shared_jobs_failed > 0` và chỉ fail ở một job type, service đó đang gặp vấn đề. |
| **Phát hiện fallback chiếm traffic** | Fallback `location /` có thể vô tình match các path mới nếu prefix không được định nghĩa đúng. Batch test phát hiện qua `X-Upstream-Service: app`. |

### 1.3 Năm service family trong batch

Case này gửi request đến **5 service**, mỗi service đại diện cho một nhóm chức năng nghiệp vụ riêng biệt:

```text
                    +---> products-service
                    |     GET /api/sim/products (list)
                    |     GET /api/sim/products/:id (detail)
                    |
                    +---> cart-service
                    |     POST /api/sim/cart/add
                    |
NGINX :80 ----------+---> order-service
                    |     POST /api/sim/orders/:id/confirm
                    |
                    +---> report-service
                    |     POST /api/sim/report/jobs (expected 202)
                    |
                    +---> app (fallback -- KHÔNG ĐƯỢC XUẤT HIỆN)
```

Products service xuất hiện 2 lần trong batch (list + detail) vì đây là service có nhiều endpoint nhất và cũng là service được gọi nhiều nhất trong hệ thống. Hai loại request đến cùng một service nhưng qua 2 URL pattern khác nhau (`/products` và `/products/:id`) giúp xác nhận rằng Nginx prefix matching hoạt động đúng cho cả 2.

### 1.4 Sự đa dạng về HTTP method trong batch

Batch không chỉ toàn GET. Case này bao gồm cả hai loại method:

| Method | Số lượng operation | Ví dụ | Điểm đặc biệt |
| --- | --- | --- | --- |
| `GET` | 2 operations | `product_list`, `product_detail` | Idempotent, cacheable, an toàn để retry |
| `POST` | 3 operations | `cart_add`, `order_confirm`, `report_generate` | Non-idempotent, có body, `report_generate` expected 202 |

Việc trộn method rất quan trọng vì Nginx xử lý GET và POST khác nhau ở nhiều khía cạnh: POST có body cần buffer, POST không được retry an toàn bởi `proxy_next_upstream` (trừ khi bật `non_idempotent`), và một số Nginx module có thể áp dụng rate limit khác cho GET và POST. Batch test đảm bảo routing hoạt động cho cả hai loại method.

### 1.5 Mối quan hệ với CI/CD pipeline

Case này được thiết kế như một **smoke test** cho CI/CD pipeline. Sau mỗi lần deploy, trước khi chạy toàn bộ test suite (có thể mất hàng giờ), case này chạy trong vài giây và trả lời câu hỏi quan trọng nhất: "Hệ thống có routing đúng không?"

```text
Deploy -> ms-01 Gateway routing smoke (vài giây)
  -> Nếu FAIL: rollback ngay, đừng chạy gì khác
  -> Nếu PASS: tiếp tục ms-02 -> ms-05 (per-service contracts)
    -> ms-06 (cross-service flow) -> ms-07 (health)
```

Đây là "canary trong CI/CD" -- rẻ nhất, nhanh nhất, và trả lời câu hỏi nền tảng nhất.

---

## 2. Microservices capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh:

> **Nginx API Gateway route chính xác từng URL prefix đến đúng microservice upstream. Tất cả 5 service đều alive và trả về response hợp lệ. Không có request nào rơi vào fallback `app` upstream. Header `X-Upstream-Service` là bằng chứng duy nhất và đầy đủ cho routing correctness.**

Cụ thể hơn, case chứng minh 7 khả năng con:

1. **Nginx location block khớp đúng URL prefix**: Mỗi URL pattern (`/products`, `/cart/add`, `/orders/:id/confirm`, `/report/jobs`) được Nginx match đến đúng `location` block tương ứng.

2. **Mỗi prefix route đến đúng upstream block**: `location /api/sim/products` trỏ đến `upstream products_service`, `location /api/sim/cart` trỏ đến `upstream cart_service`, v.v.

3. **`X-Upstream-Service` header được set đúng cho từng service**: `proxy_set_header X-Upstream-Service "products-service"` trong mỗi location block -- không có sự nhầm lẫn copy-paste giữa các block.

4. **Không có request nào rơi vào fallback `location /`**: Fallback `location /` route đến `upstream app` với `X-Upstream-Service: app`. Sự xuất hiện của giá trị này là tín hiệu routing sai.

5. **Tất cả 5 service đều alive và trả về response hợp lệ**: Mỗi service phải trả về HTTP 200 (hoặc 202 cho report job create) -- chứng minh service process đang chạy và xử lý được request.

6. **Shared-iterations executor xử lý batch job đúng**: Worker pool 10 VUs pick job từ backlog 100 jobs, mỗi job gọi 1-2 API calls đến service tương ứng. Không có job nào bị bỏ sót hoặc xử lý sai.

7. **Custom metrics `shared_jobs_total` và `shared_jobs_failed` phản ánh đúng thực tế**: 100 jobs hoàn thành, 0 jobs thất bại -- chứng minh tất cả operation trong batch đều thành công.

### 2.2 So sánh với các case Microservices khác

| Case | Phạm vi | Executor | Mục tiêu chính |
| --- | --- | --- | --- |
| **ms-01 -- Gateway routing smoke** | **5 service, 1 batch** | **shared-iterations** | **Chứng minh routing đúng trước khi test gì khác** |
| ms-02 -- Products read contract | 1 service (products) | shared-iterations | Audit catalog list + detail contract |
| ms-03 -- Cart write contract | 1 service (cart) | shared-iterations | Kiểm tra add/view/update/remove contract |
| ms-04 -- Order transaction contract | 1 service (order) | shared-iterations | Kiểm tra checkout/confirm/status contract |
| ms-05 -- Report async contract | 1 service (report) | shared-iterations | Kiểm tra sync read + async job contract |
| ms-06 -- Stateful business flow | 5 services, per-VU flow | per-vu-iterations | Flow xuyên suốt login->browse->cart->checkout->confirm->status |
| ms-07 -- Service health | 5 services health | constant-vus | Kiểm tra dependency status của từng service |

ms-01 là case **nền tảng** -- nó phải pass trước khi bất kỳ case nào khác được chạy. Nếu ms-01 fail, mọi case khác đều có thể fail vì lý do routing, không phải vì contract sai.

---

## 3. Vì sao phải test ở Microservices layer

### 3.1 Đây không phải là vấn đề của CDN layer

CDN/Varnish ngồi trước Nginx. CDN layer (cases 01-12 trong CDN series) trả lời câu hỏi "response có được edge cache không". Nhưng CDN không biết gì về routing giữa các microservice -- CDN chỉ thấy Nginx như một origin duy nhất.

Nếu test qua CDN (topology `full`), request có thể được cache và trả về từ Varnish mà không bao giờ đến Nginx. Khi đó:
- `X-Served-By` sẽ là `varnish`, không phải `nginx`
- `X-Upstream-Service` sẽ không tồn tại vì request không đến được upstream
- Bạn không thể xác nhận routing đúng vì request chưa từng đến gateway

Đó là lý do case này dùng topology `full-no-cdn`: Nginx là điểm entrypoint trực tiếp, không có Varnish xen giữa.

### 3.2 Đây không phải là vấn đề của LB layer

LB layer (cases 01-12 trong LB series) tập trung vào việc request có đến đúng upstream container không, nhưng ở mức độ thô hơn. LB test kiểm tra Nginx route request đến đúng upstream group (`products_service`, `auth_service`, v.v.) -- nhưng LB test không quan tâm đến API contract bên trong mỗi service.

Microservices layer tiến thêm một bước: sau khi đã xác nhận routing đúng ở LB layer, layer này kiểm tra **contract** của từng service -- response body shape, success flag, data structure. ms-01 là cầu nối giữa hai layer: nó xác nhận routing đúng trong ngữ cảnh microservices, với expected behavior cụ thể cho từng service.

### 3.3 Phân biệt trách nhiệm giữa các layer

```text
CDN layer (cases 01-12):    Request có được cache/offload không?
LB layer (cases 01-12):     Request đi đúng upstream container không?
Microservices layer (ms-01): Request đến đúng microservice không?
Microservices layer (ms-02..07): Service contract có đúng không?
```

ms-01 nằm ở ranh giới giữa "routing" và "contract". Nó chứng minh routing đúng, nhưng cũng đồng thời là smoke test cho contract -- nếu một service trả về 500, `shared_jobs_failed` sẽ tăng.

### 3.4 Tại sao phải làm trước Redis layer

```text
Redis cases (15-*.js) test idempotency, claim owner, hotkey race
-- tất cả đều nằm trong order-service.

Nếu gateway route sai (request đến app fallback thay vì order-service),
hoặc order-service contract sai (thiếu Idempotency-Key header),
thì Redis cases không thể pass vì lý do ngoài Redis.
```

Thứ tự đúng trong learning path: **ms-01 (route đúng service) -> ms-02..05 (contract đúng) -> ms-06 (state nhất quán) -> Redis layer**.

---

## 4. Topology và precondition

### 4.1 Topology

```text
k6 (10 VUs, shared-iterations, 100 jobs)
  |
  | HTTP request với job type xác định service đích
  | Mỗi job gọi 1-2 API calls qua common.js requestJson()
  v
Nginx :80 (API Gateway)
  |
  | path-based routing: /api/sim/<prefix> -> upstream
  |
  +---> products-service      (prefix: /api/sim/products)
  +---> cart-service          (prefix: /api/sim/cart)
  +---> order-service         (prefix: /api/sim/orders/)
  +---> report-service        (prefix: /api/sim/report)
  +---> app:8080 (fallback)   (prefix: /* -- KHÔNG ĐƯỢC SỬ DỤNG)
```

Response header mong đợi:
- `X-Upstream-Service`: tên upstream service tương ứng (`products-service`, `cart-service`, `order-service`, `report-service`)
- Không bao giờ là `app`

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
curl -s http://localhost:80/api/sim/products | findstr "X-Upstream-Service"
curl -s -X POST http://localhost:80/api/sim/cart/add -H "Content-Type: application/json" -d "{\"product_id\":1,\"quantity\":1}" | findstr "X-Upstream-Service"
curl -s -X POST http://localhost:80/api/sim/orders/SI-TEST-1/confirm -H "Content-Type: application/json" -H "Idempotency-Key: test-key-1" -d "{}" | findstr "X-Upstream-Service"
curl -s -X POST http://localhost:80/api/sim/report/jobs -H "Content-Type: application/json" -d "{\"report_type\":\"sales\"}" | findstr "X-Upstream-Service"
```

### 4.3 Environment variables

| Biến | Default | Mô tả |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | Public URL của Nginx API Gateway |
| `SI_07_VUS` | `10` | Số lượng Virtual Users trong worker pool |
| `SI_07_JOBS` | `100` | Tổng số job trong batch (iterations) |
| `SI_07_SLEEP_SECONDS` | `0` | Thời gian nghỉ giữa các job (mặc định 0 để chạy nhanh nhất) |

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `si-07-ci-verification-batch.js` gồm 105 dòng, được tổ chức thành 4 phần chính:

```javascript
// (A) IMPORTS: 11 dòng
import {
  BASE_URL, buildJobs, buildSharedScenario, currentJob,
  envFloat, envInt, finishJob, requestJson, think,
} from './common.js';

// (B) CONFIGURATION: 3 dòng
const CASE_ID = 'si-07-ci-verification-batch';
const VUS = envInt('SI_07_VUS', 10);
const JOBS = envInt('SI_07_JOBS', 100);
const SLEEP_SECONDS = envFloat('SI_07_SLEEP_SECONDS', 0);

// (C) OPTIONS + SETUP: 27 dòng
export const options = { ... };
export function setup() { ... }

// (D) EXEC FUNCTION: 58 dòng
export function ciVerificationBatch(data) { ... }
```

Thiết kế này phản ánh pattern chung của tất cả shared-iterations scripts: setup tạo jobs, exec xử lý từng job qua `currentJob()`, và `finishJob()` ghi nhận kết quả. Mọi logic HTTP request, check, và metrics đều được tập trung trong `common.js`.

### 5.2 Phân tích từng dòng -- Phần A: Imports

```javascript
import {
  BASE_URL,
  buildJobs,
  buildSharedScenario,
  currentJob,
  envFloat,
  envInt,
  finishJob,
  requestJson,
  think,
} from './common.js';
```

Chín function được import từ `common.js`, mỗi function có một vai trò cụ thể trong batch processing pattern:

| Function | Vai trò | Chi tiết |
| --- | --- | --- |
| `BASE_URL` | URL gốc của Nginx gateway | Đọc từ `__ENV.BASE_URL`, fallback `http://localhost:80` |
| `buildJobs(size, builder)` | Tạo mảng jobs từ builder function | `Array.from({ length: size }, (_, i) => builder(i))` |
| `buildSharedScenario(execName, vus, iterations, maxDuration, extraTags)` | Tạo scenario config cho shared-iterations | Trả về object với `executor: 'shared-iterations'` |
| `currentJob(data)` | Lấy job hiện tại theo iteration index | `data.jobs[exec.scenario.iterationInTest]` |
| `envInt(name, fallback)` | Đọc biến môi trường kiểu integer | An toàn với giá trị NaN hoặc âm |
| `envFloat(name, fallback)` | Đọc biến môi trường kiểu float | An toàn với giá trị NaN hoặc âm |
| `finishJob(startedAt, ok, tags)` | Ghi nhận job hoàn thành | Tăng `shared_jobs_total`, nếu fail tăng `shared_jobs_failed` |
| `requestJson(method, url, body, tags, expectedStatus)` | Gửi HTTP request và check status | Trả về `{ response, ok, durationMs }` |
| `think(seconds, tags)` | Sleep có tracking | Chỉ sleep nếu `seconds > 0`, có ghi metric `shared_sleep_seconds` |

### 5.3 Phân tích từng dòng -- Phần B: Configuration

```javascript
const CASE_ID = 'si-07-ci-verification-batch';
```

`CASE_ID` được dùng làm tag `case_id` trong tất cả metrics. Điều này cho phép lọc kết quả theo case trên dashboard và phân biệt metrics từ case này với các case khác dùng chung script pattern (như ms-02 dùng `si-01-catalog-audit`).

```javascript
const VUS = envInt('SI_07_VUS', 10);
```

Tại sao 10 VUs? Trong shared-iterations, VUs là kích thước worker pool. 10 VUs nghĩa là có tối đa 10 worker xử lý đồng thời 100 jobs. Con số này được chọn vì:
- Đủ lớn để xử lý 100 jobs trong thời gian ngắn (vài giây với SLEEP_SECONDS=0)
- Đủ lớn để tạo concurrent load -- nhiều worker gọi đồng thời đến các service khác nhau
- Không quá lớn để gây quá tải hệ thống local -- đây là correctness test, không phải stress test

```javascript
const JOBS = envInt('SI_07_JOBS', 100);
```

100 jobs, phân bố đều cho 5 loại (20 jobs mỗi loại). Đây là sample size đủ lớn để:
- Mỗi service được gọi ít nhất 20 lần -- đủ để phát hiện intermittent routing bug
- Tổng thời gian chạy ngắn (vài giây) -- phù hợp cho CI/CD smoke test
- Dễ dàng điều chỉnh: tăng lên 500 để stress test, giảm xuống 20 để debug

```javascript
const SLEEP_SECONDS = envFloat('SI_07_SLEEP_SECONDS', 0);
```

Mặc định 0 -- không nghỉ giữa các job. Trong smoke test, ta muốn kết quả nhanh nhất có thể. Trong debugging mode, có thể set SLEEP_SECONDS > 0 để quan sát từng request một.

### 5.4 Phân tích từng dòng -- Phần C: Options và Scenarios

```javascript
export const options = {
  scenarios: {
    ci_verification_batch: buildSharedScenario('ciVerificationBatch', VUS, JOBS, '10m', {
      case_id: CASE_ID,
      business_case: 'ci_api_contract_verification',
    }),
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    shared_jobs_total: [`count==${JOBS}`],
    shared_jobs_failed: ['count==0'],
  },
};
```

#### Phân tích `buildSharedScenario`

Hàm `buildSharedScenario('ciVerificationBatch', 10, 100, '10m', {...})` tạo ra:

```javascript
{
  executor: 'shared-iterations',
  exec: 'ciVerificationBatch',
  vus: 10,
  iterations: 100,
  maxDuration: '10m',
  tags: {
    executor_family: 'shared_iterations',
    workload_shape: 'fixed_backlog',
    case_id: 'si-07-ci-verification-batch',
    business_case: 'ci_api_contract_verification',
  },
}
```

**Tại sao dùng `shared-iterations`?**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **shared-iterations** (đang dùng) | **DUNG** | Có 100 jobs cố định cần xử lý. Worker pool 10 VUs pick job từ backlog. Mỗi job là một iteration độc lập. Tổng số iteration biết trước (= JOBS). Jobs được phân phối tự động giữa các VUs -- VU nhanh hơn sẽ pick nhiều job hơn. |
| constant-vus | SAI | Sẽ loop vô hạn trong duration, không biết khi nào đủ 100 jobs. Cần logic dừng thủ công. |
| constant-arrival-rate | SAI | Ép rate -- case này không cần rate cố định. Mỗi job xử lý xong mới pick job tiếp theo. |
| per-vu-iterations | SAI | Mỗi VU có số iteration cố định -- không linh hoạt như shared pool. VU chậm sẽ giữ iteration không dùng đến. |

**Key insight**: `shared-iterations` là executor lý tưởng cho batch processing. Job pool là fixed-size backlog, worker pool pick job tự do. VU nhanh xử lý nhiều job hơn, VU chậm xử lý ít hơn -- tổng thời gian được tối ưu tự nhiên.

#### Phân tích thresholds

```javascript
thresholds: {
  checks: ['rate==1'],                            // (a)
  http_req_failed: ['rate==0'],                   // (b)
  shared_jobs_total: [`count==${JOBS}`],           // (c)
  shared_jobs_failed: ['count==0'],                // (d)
},
```

**(a) `checks: ['rate==1']`** -- TẤT CẢ checks phải pass. Không khoan nhượng. Đây là "correctness gate" cho CI/CD: nếu dù chỉ một check fail, pipeline fail. `requestJson()` trong `common.js` tự động tạo check cho status code; nếu status không khớp expected, check fail và threshold này bị trigger.

**(b) `http_req_failed: ['rate==0']`** -- Không chấp nhận bất kỳ HTTP failure nào. Khác với case LB 05 (cho phép 3% transient failure trong production-like mix), case này là correctness test thuần túy -- 0% failure là yêu cầu cứng.

**(c) `shared_jobs_total: ['count==' + JOBS]`** -- Xác nhận tất cả 100 jobs đã được xử lý. Nếu count < 100, có job bị bỏ sót (có thể do `maxDuration` bị vượt quá hoặc script crash giữa chừng).

**(d) `shared_jobs_failed: ['count==0']`** -- Không có job nào thất bại. Một job fail khi `ok = false` trong `finishJob()` -- nghĩa là ít nhất một API call trong job đó không trả về expected status.

#### Tại sao `maxDuration` là `'10m'`?

10 phút là generous timeout. Với 100 jobs và SLEEP_SECONDS=0, case này thường hoàn thành trong vài giây. `maxDuration` 10 phút là safety net -- nếu test kéo dài hơn 10 phút, có điều gì đó sai nghiêm trọng (service treo, network partition, v.v.) và k6 sẽ dừng test.

### 5.5 Phân tích từng dòng -- Phần D: Setup function

```javascript
export function setup() {
  const seed = Date.now();
  const cases = ['product_list', 'product_detail', 'cart_add', 'order_confirm', 'report_generate'];
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `ci-verify-${index + 1}`,
      type: cases[index % cases.length],
      productId: (index % 50) + 1,
      orderId: `SI-CI-${seed}-${index + 1}`,
      idemKey: `si-ci-${seed}-${index + 1}`,
    })),
  };
}
```

#### Cơ chế phân phối job type

```javascript
const cases = ['product_list', 'product_detail', 'cart_add', 'order_confirm', 'report_generate'];
type: cases[index % cases.length]
```

Với 100 jobs và 5 loại, mỗi loại xuất hiện chính xác 20 lần:
- Job 0, 5, 10, 15, ..., 95 -> `product_list` (20 jobs)
- Job 1, 6, 11, 16, ..., 96 -> `product_detail` (20 jobs)
- Job 2, 7, 12, 17, ..., 97 -> `cart_add` (20 jobs)
- Job 3, 8, 13, 18, ..., 98 -> `order_confirm` (20 jobs)
- Job 4, 9, 14, 19, ..., 99 -> `report_generate` (20 jobs)

Phân phối round-robin này đảm bảo:
- Mỗi service được test với sample size bằng nhau (20 jobs)
- Không có service nào bị "thiếu sample" do phân phối ngẫu nhiên
- Dễ dàng debug: nếu job thứ 42 fail, biết ngay đó là `cart_add` (vì 42 % 5 = 2 -> index 2 trong cases array)

#### `seed` và tính duy nhất của order ID

```javascript
const seed = Date.now();
orderId: `SI-CI-${seed}-${index + 1}`,
idemKey: `si-ci-${seed}-${index + 1}`,
```

`seed = Date.now()` được tính một lần duy nhất trong `setup()`. Tất cả 100 jobs dùng chung một seed, đảm bảo:
- `orderId` và `idemKey` là duy nhất cho lần chạy hiện tại (không trùng với lần chạy trước)
- Có thể trace ngược: nếu thấy `SI-CI-1711234567890-42` trong log, biết ngay đây là job thứ 42 của lần chạy lúc timestamp 1711234567890
- `idemKey` cho `order_confirm` đảm bảo mỗi request là idempotent -- nếu retry, server sẽ trả về kết quả cũ thay vì xử lý lại

#### `productId` cycle

```javascript
productId: (index % 50) + 1,
```

Product ID từ 1 đến 50, lặp lại mỗi 50 jobs. Với 100 jobs, mỗi product ID xuất hiện đúng 2 lần. Điều này test rằng:
- Products service có thể xử lý request đến nhiều product ID khác nhau
- Không có hardcoded logic chỉ hoạt động với một vài ID cụ thể

### 5.6 Phân tích từng dòng -- Phần E: Exec function

```javascript
export function ciVerificationBatch(data) {
  const started = Date.now();
  const job = currentJob(data);
  let result;

  if (job.type === 'product_list') {
    result = requestJson('GET', `${BASE_URL}/api/sim/products?limit=10&cpu_ms=1&db_rows=2`, null, {
      caseId: CASE_ID,
      service: 'products-service',
      operation: 'ci_product_list',
      endpoint: 'GET /api/sim/products',
      jobId: job.id,
    });
  } else if (job.type === 'product_detail') {
    result = requestJson('GET', `${BASE_URL}/api/sim/products/${job.productId}?view=full&cpu_ms=1&db_rows=1`, null, {
      caseId: CASE_ID,
      service: 'products-service',
      operation: 'ci_product_detail',
      endpoint: 'GET /api/sim/products/:id',
      jobId: job.id,
    });
  } else if (job.type === 'cart_add') {
    result = requestJson('POST', `${BASE_URL}/api/sim/cart/add?cpu_ms=1&db_writes=1`, {
      product_id: job.productId,
      quantity: 1,
    }, {
      caseId: CASE_ID,
      service: 'cart-service',
      operation: 'ci_cart_add',
      endpoint: 'POST /api/sim/cart/add',
      jobId: job.id,
    });
  } else if (job.type === 'order_confirm') {
    result = requestJson('POST', `${BASE_URL}/api/sim/orders/${job.orderId}/confirm?cpu_ms=1&db_writes=1&external_ms=1&external_fail_rate=0`, {}, {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'ci_order_confirm',
      endpoint: 'POST /api/sim/orders/:id/confirm',
      jobId: job.id,
      headers: { 'Idempotency-Key': job.idemKey },
    });
  } else {
    result = requestJson('GET', `${BASE_URL}/api/sim/report?cpu_ms=1&db_rows=1&gzip_kb=1`, null, {
      caseId: CASE_ID,
      service: 'report-service',
      operation: 'ci_report_generate',
      endpoint: 'GET /api/sim/report',
      jobId: job.id,
    });
  }

  finishJob(started, result.ok, {
    caseId: CASE_ID,
    service: 'mixed-services',
    operation: 'ci_verification_job',
    jobId: job.id,
  });
  think(SLEEP_SECONDS, { caseId: CASE_ID, operation: 'worker_pause' });
}
```

#### Cấu trúc if-else theo job type

Function dùng if-else chain để phân nhánh theo `job.type`. Mỗi nhánh gọi `requestJson()` với các tham số khác nhau. Đây là pattern "dispatcher" -- job type quyết định service nào được gọi.

#### Phân tích từng operation

**Operation 1: `product_list`**
```javascript
requestJson('GET', `${BASE_URL}/api/sim/products?limit=10&cpu_ms=1&db_rows=2`, null, {
  service: 'products-service',
  operation: 'ci_product_list',
  endpoint: 'GET /api/sim/products',
})
```
- GET request đến `/api/sim/products` với query params mô phỏng CPU delay 1ms và 2 database rows
- Tag `service: 'products-service'` -- dùng để filter metrics theo service
- Tag `endpoint: 'GET /api/sim/products'` -- dùng để phân tích theo URL pattern
- Expected status: 200 (mặc định của `requestJson`)

**Operation 2: `product_detail`**
```javascript
requestJson('GET', `${BASE_URL}/api/sim/products/${job.productId}?view=full&cpu_ms=1&db_rows=1`, null, {
  service: 'products-service',
  operation: 'ci_product_detail',
  endpoint: 'GET /api/sim/products/:id',
})
```
- GET request với product ID động (`${job.productId}`) -- mỗi job có thể gọi product khác nhau
- Query params `view=full` yêu cầu response đầy đủ thông tin sản phẩm
- Cùng `service: 'products-service'` nhưng khác `operation` và `endpoint` -- cho phép phân biệt list vs detail trong metrics

**Operation 3: `cart_add`**
```javascript
requestJson('POST', `${BASE_URL}/api/sim/cart/add?cpu_ms=1&db_writes=1`, {
  product_id: job.productId,
  quantity: 1,
}, {
  service: 'cart-service',
  operation: 'ci_cart_add',
  endpoint: 'POST /api/sim/cart/add',
})
```
- POST request với JSON body `{ product_id, quantity }`
- `db_writes=1` -- mô phỏng 1 database write operation
- Đây là operation duy nhất trong case có body -- test rằng Nginx xử lý POST body đúng khi proxy

**Operation 4: `order_confirm`**
```javascript
requestJson('POST', `${BASE_URL}/api/sim/orders/${job.orderId}/confirm?cpu_ms=1&db_writes=1&external_ms=1&external_fail_rate=0`, {}, {
  service: 'order-service',
  operation: 'ci_order_confirm',
  endpoint: 'POST /api/sim/orders/:id/confirm',
  headers: { 'Idempotency-Key': job.idemKey },
})
```
- POST request với `Idempotency-Key` header -- đây là header bắt buộc cho order confirm
- `external_ms=1&external_fail_rate=0` -- mô phỏng gọi external service (payment mock) với 0% fail rate
- `orderId` được tạo trong setup với seed + index -- đảm bảo duy nhất
- Đây là operation phức tạp nhất -- nó test routing + idempotency header propagation

**Operation 5: `report_generate` (else branch)**
```javascript
requestJson('GET', `${BASE_URL}/api/sim/report?cpu_ms=1&db_rows=1&gzip_kb=1`, null, {
  service: 'report-service',
  operation: 'ci_report_generate',
  endpoint: 'GET /api/sim/report',
})
```
- GET request đến `/api/sim/report` với `gzip_kb=1` -- mô phỏng response được nén gzip
- Đây là else branch -- bất kỳ job type nào không match 4 case trên sẽ vào đây
- Trong thực tế, với 5 loại job được phân phối round-robin, nhánh này luôn xử lý `report_generate`

Lưu ý: case catalog định nghĩa operation `report_generate` là POST đến `/api/sim/report/jobs` với expected 202. Nhưng script thực tế dùng GET đến `/api/sim/report` với default expected 200. Đây là sự khác biệt giữa catalog (định nghĩa intent) và script (implementation thực tế). Cả hai đều test report-service routing -- chỉ khác endpoint cụ thể.

#### `finishJob()` -- Ghi nhận kết quả job

```javascript
finishJob(started, result.ok, {
  caseId: CASE_ID,
  service: 'mixed-services',
  operation: 'ci_verification_job',
  jobId: job.id,
});
```

`finishJob()` trong `common.js` thực hiện:
1. `sharedJobsTotal.add(1, metricTags)` -- tăng counter tổng số job đã hoàn thành
2. `sharedJobDurationMs.add(Date.now() - startedAt, metricTags)` -- ghi nhận thời gian xử lý job
3. Nếu `!ok`: `sharedJobsFailed.add(1, metricTags)` -- tăng counter job thất bại

Tag `service: 'mixed-services'` cho biết job này có thể gọi nhiều service khác nhau (tùy theo type). Metric này dùng để theo dõi overall job success rate, trong khi metric từ `requestJson` theo dõi per-service success rate.

#### `think()` -- Worker pause

```javascript
think(SLEEP_SECONDS, { caseId: CASE_ID, operation: 'worker_pause' });
```

Với `SLEEP_SECONDS = 0`, `think()` không làm gì (check `if (!(seconds > 0)) return`). Điều này có nghĩa worker xử lý xong job này sẽ lập tức pick job tiếp theo -- tối đa throughput cho smoke test.

### 5.7 Deep-dive: `requestJson()` -- Trái tim của HTTP request

```javascript
export function requestJson(method, url, body, tags = {}, expectedStatus = 200) {
  const started = Date.now();
  const params = {
    headers: {
      'Content-Type': 'application/json',
      ...(tags.headers || {}),
    },
    tags: {
      case_id: tags.caseId,
      service: tags.service,
      operation: tags.operation,
      endpoint: tags.endpoint,
      job_id: tags.jobId,
      name: tags.name || tags.operation,
    },
  };
  let response;
  const normalized = method.toUpperCase();

  if (normalized === 'POST') {
    response = http.post(url, JSON.stringify(body || {}), params);
  } else if (normalized === 'PATCH') {
    response = http.patch(url, JSON.stringify(body || {}), params);
  } else if (normalized === 'DELETE') {
    response = http.del(url, null, params);
  } else {
    response = http.get(url, params);
  }

  sharedApiCallsTotal.add(1, params.tags);

  const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const ok = check(response, {
    [`${tags.operation} status ${allowed.join('/')}`]: (r) => allowed.includes(r.status),
  });

  return { response, ok, durationMs: Date.now() - started };
}
```

Các điểm quan trọng:

1. **Method dispatch**: `requestJson` hỗ trợ GET, POST, PATCH, DELETE -- tự động chọn function tương ứng từ `k6/http`. POST và PATCH tự động `JSON.stringify(body)`.

2. **Tags structure**: Mỗi request được tag với `case_id`, `service`, `operation`, `endpoint`, `job_id`. Tags này xuất hiện trong tất cả metrics (checks, http_req_duration, http_req_failed, shared_api_calls_total) -- cho phép filter và group kết quả theo bất kỳ dimension nào.

3. **Check generation**: Check được đặt tên theo pattern `` `${operation} status ${expectedStatus}` `` -- ví dụ `"ci_product_list status 200"`. Tên check này xuất hiện trong console output và dashboard, giúp xác định chính xác operation nào fail.

4. **Return value**: `{ response, ok, durationMs }` -- `ok` là boolean tổng hợp từ tất cả checks. Script dùng `ok` để quyết định `finishJob` có tính job này là fail không.

### 5.8 Custom metrics

Script tạo ra 5 custom metrics thông qua `common.js`:

| Metric | Loại | Ý nghĩa | Tag |
| --- | --- | --- | --- |
| `shared_jobs_total` | Counter | Tổng số job đã hoàn thành | case_id, service, operation, job_id |
| `shared_jobs_failed` | Counter | Số job thất bại (ít nhất 1 API call fail) | case_id, service, operation, job_id |
| `shared_job_duration_ms` | Trend | Thời gian xử lý mỗi job (ms) | case_id, service, operation, job_id |
| `shared_api_calls_total` | Counter | Tổng số API calls đã gửi | case_id, service, operation, endpoint, job_id |
| `shared_sleep_seconds` | Counter | Tổng thời gian sleep (seconds) | case_id, operation |

Mối quan hệ giữa các metrics:
- `shared_api_calls_total` >= `shared_jobs_total` vì mỗi job có thể gọi nhiều API calls (case này mỗi job gọi 1 call)
- `shared_jobs_failed` = số job có `ok = false` -- thường bằng số API calls fail (vì mỗi job chỉ có 1 call)
- `shared_job_duration_ms` bao gồm thời gian HTTP request + thời gian check + overhead -- là end-to-end job latency

---

## 6. Nginx API Gateway mechanism

### 6.1 Cách Nginx thực hiện path-based routing cho 5 service

Nginx sử dụng directive `location` để map URL path đến upstream group. Cấu hình Nginx cho case này trông giống như sau (rút gọn):

```nginx
upstream products_service {
    server products-service:3000;
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

upstream app {
    server app:8080;
}

server {
    listen 80;

    location /api/sim/products {
        proxy_pass http://products_service;
        proxy_set_header X-Upstream-Service "products-service";
    }

    location /api/sim/cart {
        proxy_pass http://cart_service;
        proxy_set_header X-Upstream-Service "cart-service";
    }

    location /api/sim/checkout {
        proxy_pass http://order_service;
        proxy_set_header X-Upstream-Service "order-service";
    }

    location /api/sim/orders/ {
        proxy_pass http://order_service;
        proxy_set_header X-Upstream-Service "order-service";
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

### 6.2 Location matching priority

Nginx có quy tắc ưu tiên location rất cụ thể:

1. **Exact match (`=`)**: `location = /api/sim/checkout` -- ưu tiên cao nhất
2. **Prefix match với `^~`**: `location ^~ /api/sim/auth/` -- dừng tìm kiếm regex
3. **Regex match (`~` hoặc `~*`)**: `location ~ \.php$` -- theo thứ tự xuất hiện trong config
4. **Prefix match thường**: `location /api/sim/cart` -- match theo prefix dài nhất

Trong cấu hình trên, các location KHÔNG dùng regex, nên Nginx chọn prefix match dài nhất:

- Request `GET /api/sim/products?limit=10` match cả `location /api/sim/products` và `location /`. Nginx chọn `/api/sim/products` vì prefix dài hơn.
- Request `POST /api/sim/orders/SI-CI-1711234567890-42/confirm` match `location /api/sim/orders/` (không match `location /` vì có prefix cụ thể hơn).
- Request `GET /api/sim/report?cpu_ms=1` match `location /api/sim/report` (không match `location /`).

### 6.3 Cơ chế gán `X-Upstream-Service`

Header `X-Upstream-Service` được gán thông qua directive `proxy_set_header` trong mỗi location block. Đây không phải là header tự động của Nginx -- nó được cấu hình thủ công cho mục đích observability:

```nginx
proxy_set_header X-Upstream-Service "products-service";
```

Header này được truyền từ Nginx đến upstream server, và upstream server echo lại trong response. k6 script không trực tiếp check header này (script chỉ check status code) -- nhưng trong manual verification và dashboard analysis, đây là evidence chính cho routing correctness.

**Tại sao không dùng biến built-in của Nginx?** Nginx có biến `$upstream_addr` (địa chỉ IP:port của upstream được chọn), nhưng biến này không có sẵn trong response header. `X-Upstream-Service` là giải pháp explicit -- tên service được hardcode trong config, dễ đọc, và không phụ thuộc vào IP động của container.

### 6.4 Fallback `location /` và tại sao nó nguy hiểm

```nginx
location / {
    proxy_pass http://app;
    proxy_set_header X-Upstream-Service "app";
}
```

`location /` match TẤT CẢ các path không được match bởi location cụ thể hơn. Nếu một service prefix bị thiếu trong config (ví dụ: quên định nghĩa `location /api/sim/report`), request đến service đó sẽ rơi vào fallback và được xử lý bởi `app` -- service không biết gì về business logic của report.

Hậu quả:
- `app` có thể trả về 200 với response mặc định -- trông giống như service hoạt động bình thường
- Chỉ có `X-Upstream-Service: app` là tín hiệu duy nhất cho thấy routing sai
- Nếu không check header này, bạn có thể nghĩ mọi thứ ổn trong khi report service thực sự chưa từng nhận được request nào

### 6.5 Tương tác giữa shared-iterations và Nginx connection pool

Khi 10 VUs gửi request đồng thời qua `shared-iterations`, Nginx xử lý chúng qua event-driven architecture:

```text
VU 1 (job: product_list)    -> [event] -> Nginx worker -> upstream products_service
VU 2 (job: product_detail)  -> [event] -> Nginx worker -> upstream products_service
VU 3 (job: cart_add)        -> [event] -> Nginx worker -> upstream cart_service
VU 4 (job: order_confirm)   -> [event] -> Nginx worker -> upstream order_service
VU 5 (job: report_generate) -> [event] -> Nginx worker -> upstream report_service
VU 6 (job: product_list)    -> [event] -> Nginx worker -> upstream products_service
...
```

Mỗi Nginx worker process xử lý hàng ngàn connection đồng thời thông qua `epoll` (Linux). Không có thread-per-connection. Điều này có nghĩa:
- Routing decision được quyết định synchronous trong event loop -- không có race condition
- Upstream connection pool được shared giữa tất cả request đến cùng một upstream
- 10 VUs không gây áp lực đáng kể lên Nginx -- đây là correctness test, không phải stress test

---

## 7. Request sequence flow

### 7.1 Timeline của một job

```text
Time (ms)  |  Step
-----------|-------------------------------------------------------
0          |  VU pick job từ shared pool (data.jobs[iterationInTest])
0          |  currentJob(data) -> lấy job object
0          |  if-else chain: xác định job type
0.1        |  requestJson() -> gửi HTTP request đến Nginx
0.1-10     |  Nginx xử lý: parse URL, match location, chọn upstream, proxy request
1-15       |  Upstream service xử lý business logic (cpu_ms=1, db_rows=1-2)
10-25      |  Nginx nhận response từ upstream, thêm headers, trả về client
25         |  k6 nhận response
25-26      |  requestJson() check status code -> ok = true/false
26         |  finishJob(started, ok, tags) -> increment counters
26         |  think(0) -> no-op
26         |  Worker quay lại pool, pick job tiếp theo
```

### 7.2 Sequence của một request qua Nginx (ví dụ: cart_add)

```text
CLIENT (k6 VU)                  NGINX                           UPSTREAM
    |                             |                                 |
    |-- POST /api/sim/cart/add ->|                                 |
    |   Content-Type: app/json   |                                 |
    |   Body: {product_id, qty}  |                                 |
    |                             |                                 |
    |                             |-- parse URL path:               |
    |                             |   /api/sim/cart/add             |
    |                             |                                 |
    |                             |-- match location:               |
    |                             |   /api/sim/cart ->              |
    |                             |   cart_service                  |
    |                             |                                 |
    |                             |-- chọn upstream server          |
    |                             |   (round-robin nếu              |
    |                             |    có nhiều replica)            |
    |                             |                                 |
    |                             |-- POST /api/sim/cart/add -----> |
    |                             |   X-Upstream-Service:           |
    |                             |     cart-service                |
    |                             |   X-Forwarded-For: ...          |
    |                             |                                 |
    |                             |               (xử lý)           |
    |                             |                                 |
    |                             |<-- 200 OK --------------------- |
    |                             |   Content-Type: app/json        |
    |                             |                                 |
    |                             |-- thêm response headers:        |
    |                             |   X-Upstream-Service:           |
    |                             |     cart-service                |
    |                             |                                 |
    |<-- 200 OK ----------------- |                                 |
    |   X-Upstream-Service:      |                                 |
    |     cart-service           |                                 |
    |                             |                                 |
    |-- requestJson() check:                                         |
    |   "ci_cart_add status 200" ✓                                   |
    |                                                                 |
    |-- finishJob() -> shared_jobs_total++                           |
```

### 7.3 Concurrency model với shared-iterations

```text
Job backlog (100 jobs, fixed order):
[job-1: product_list] [job-2: product_detail] [job-3: cart_add] [job-4: order_confirm] [job-5: report_generate]
[job-6: product_list] ... [job-100: report_generate]

Worker pool (10 VUs):
VU-1:  pick job-1  -> process -> finish -> pick job-11 -> process -> finish -> ...
VU-2:  pick job-2  -> process -> finish -> pick job-12 -> process -> finish -> ...
VU-3:  pick job-3  -> process -> finish -> pick job-13 -> process -> finish -> ...
...
VU-10: pick job-10 -> process -> finish -> pick job-20 -> process -> finish -> ...

Jobs được pick theo thứ tự iteration index (0..99).
Mỗi VU xử lý khoảng 10 jobs (100 jobs / 10 VUs).
VU nhanh hơn (gặp service response nhanh) sẽ pick nhiều job hơn từ cuối backlog.
```

Đặc điểm quan trọng của shared-iterations:
- **Không có idle VU**: Khi một VU hoàn thành job, nó lập tức pick job tiếp theo từ backlog. Không có VU nào đứng chờ.
- **Phân phối không đồng đều**: VU xử lý `product_list` (response nhanh) có thể hoàn thành 15 jobs, trong khi VU xử lý `order_confirm` (external call) chỉ hoàn thành 5 jobs. Đây là behavior mong đợi -- pool tự cân bằng.
- **Thứ tự job cố định**: Job được đánh index 0..99 và VU pick theo `iterationInTest`. Điều này đảm bảo mỗi job được xử lý đúng một lần, không bỏ sót, không trùng lặp.

---

## 8. Key signals / headers

### 8.1 Bảng signals cần verify

| Signal | Vị trí | Expected value | Ý nghĩa | Hậu quả nếu sai |
| --- | --- | --- | --- | --- |
| `status` | Response status line | `200` cho hầu hết operation; có thể `202` cho report | HTTP status code phản ánh đúng kết quả xử lý | Status sai = upstream service không hiểu request hoặc route nhầm |
| `X-Upstream-Service` | Response header | `products-service`, `cart-service`, `order-service`, `report-service` | Xác nhận Nginx đã route đến đúng upstream | Signal quan trọng nhất -- sai giá trị = routing bug |
| `X-Upstream-Service: app` | Response header | **KHÔNG ĐƯỢC XUẤT HIỆN** | Fallback upstream -- request không match bất kỳ location cụ thể nào | Xuất hiện = routing sai, request rơi vào fallback |
| `Content-Type` | Response header | `application/json` | Response body là JSON | Sai = upstream service trả về format không mong đợi |
| `shared_jobs_total` | k6 custom metric | `count == 100` | Tất cả 100 jobs đã được xử lý | < 100 = có job bị bỏ sót hoặc test bị timeout |
| `shared_jobs_failed` | k6 custom metric | `count == 0` | Không có job nào thất bại | > 0 = ít nhất một service không reachable hoặc trả lỗi |
| `shared_api_calls_total` | k6 custom metric | >= 100 | Mỗi job gửi ít nhất 1 API call | < 100 = một số job không gửi được request |
| `http_req_failed` | k6 built-in metric | `rate == 0` | Không có HTTP failure nào (connection refused, timeout, DNS failure) | > 0 = network hoặc infrastructure problem |

### 8.2 Signal relationship map

```text
X-Upstream-Service = expected  ──┬── (A) Routing đúng
                                  │
status = 200 (hoặc 202)      ────┼── (B) Service alive + xử lý đúng
                                  │
shared_jobs_failed = 0       ────┼── (C) Toàn bộ batch pass
                                  │
shared_jobs_total = 100      ────┴── (D) Không bỏ sót job nào

Tất cả 4 signal (A+B+C+D) cùng đúng -> Gateway routing correctness được chứng minh
Thiếu bất kỳ signal nào -> có lỗ hổng trong gateway configuration hoặc service health
```

### 8.3 Tại sao `X-Upstream-Service` là evidence quan trọng nhất

Không có header này, bạn không thể phân biệt được request được xử lý bởi service nào. Status 200 từ `app` fallback trông giống hệt status 200 từ `order-service`. `X-Upstream-Service` là bằng chứng duy nhất cho routing correctness trong toàn bộ microservices layer.

Header này được set bởi Nginx `proxy_set_header X-Upstream-Service "service-name";` trong mỗi location block -- không phải bởi application code. Điều này có nghĩa:
- Application developer không thể vô tình sửa giá trị header này
- Header phản ánh cấu hình Nginx, không phải application state
- Nếu header sai, vấn đề nằm ở Nginx config, không phải application code

---

## 9. Pass/fail criteria

### 9.1 PASS criteria

Tất cả các điều kiện sau đồng thời đúng:

| # | Tiêu chí | Cách kiểm tra |
| --- | --- | --- |
| P1 | Tất cả checks pass (rate=1) | Threshold `checks: ['rate==1']` |
| P2 | HTTP failure rate = 0% | Threshold `http_req_failed: ['rate==0']` |
| P3 | Tất cả 100 jobs hoàn thành | Threshold `shared_jobs_total: ['count==100']` |
| P4 | Không có job nào thất bại | Threshold `shared_jobs_failed: ['count==0']` |
| P5 | Mỗi service trả về đúng expected status | Check tự động trong `requestJson()` |
| P6 | `X-Upstream-Service` khớp service cho từng URL prefix | Manual verification qua dashboard hoặc console |
| P7 | Không có `X-Upstream-Service: app` nào xuất hiện | Manual verification -- đây là tín hiệu fail quan trọng nhất |

### 9.2 FAIL criteria

| # | Dấu hiệu | Diagnostic | Nguyên nhân khả dĩ |
| --- | --- | --- | --- |
| F1 | `shared_jobs_failed > 0` | Phân tích operation nào fail | Service cụ thể không reachable hoặc trả lỗi |
| F2 | `X-Upstream-Service: app` xuất hiện | Kiểm tra URL path của request đó | Nginx location config thiếu prefix cho service đó |
| F3 | `X-Upstream-Service` không phải giá trị mong đợi | So sánh expected vs actual | Copy-paste sai trong `proxy_set_header` của location block |
| F4 | Thiếu `X-Upstream-Service` | Kiểm tra Nginx config | Thiếu directive `proxy_set_header` trong location block |
| F5 | Status code sai (vd: 404 thay vì 200) | Kiểm tra URL path | URL pattern không khớp hoặc service không implement endpoint đó |
| F6 | `shared_jobs_total < 100` | Kiểm tra `maxDuration` | Test bị timeout -- có thể có service bị treo |
| F7 | Chỉ thấy 1-2 service thay vì 5 trong metrics | Phân tích distribution của `service` tag | Một số service down hoặc Nginx upstream config sai |
| F8 | `http_req_failed > 0` | Kiểm tra loại lỗi (connection refused, timeout, DNS) | Infrastructure problem -- không phải routing bug |

---

## 10. Cách chạy + output mẫu

### 10.1 Default run (10 VUs, 100 jobs, CI/CD smoke test)

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_07_VUS = "10"
$env:SI_07_JOBS = "100"
$env:SI_07_SLEEP_SECONDS = "0"

k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-07-ci-verification-batch.js
```

Output mẫu (pass):

```text
     script: si-07-ci-verification-batch.js
     scenarios: ci_verification_batch (shared-iterations, 10 VUs, 100 iterations)

     ✓ ci_product_list status 200
     ✓ ci_product_detail status 200
     ✓ ci_cart_add status 200
     ✓ ci_order_confirm status 200
     ✓ ci_report_generate status 200

     checks.....................: 100.00% ✓ 100   ✗ 0
     http_req_failed............: 0.00%   ✓ 100   ✗ 0
     http_req_duration..........: avg=15ms min=5ms med=12ms max=45ms p(95)=28ms
     http_reqs..................: 100
     shared_jobs_total.........: 100
     shared_jobs_failed........: 0
     shared_api_calls_total....: 100
     iterations.................: 100
     vus........................: 10

     Exit: 0
```

Phân tích output này:
- **Exit 0**: Tất cả thresholds pass.
- **checks 100%**: 100/100 checks pass -- mỗi API call trả về đúng expected status.
- **http_req_failed 0%**: Không có HTTP failure nào.
- **shared_jobs_total = 100**: Tất cả 100 jobs đã được xử lý.
- **shared_jobs_failed = 0**: Không có job nào thất bại.
- **http_reqs = 100**: Chính xác 100 HTTP requests được gửi (mỗi job 1 request).
- **vus = 10**: Worker pool 10 VUs.

### 10.2 Tuned run (giảm tải để debug)

```powershell
$env:SI_07_VUS = "2"
$env:SI_07_JOBS = "20"
$env:SI_07_SLEEP_SECONDS = "0.1"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-07-ci-verification-batch.js
```

Giảm xuống 2 VUs và 20 jobs (4 jobs mỗi service) để:
- Dễ dàng quan sát output từng dòng
- `SLEEP_SECONDS=0.1` thêm 100ms delay giữa các job để tránh rate limit
- Phù hợp khi debug một service cụ thể

### 10.3 Stress test mode (tăng load để kiểm tra capacity)

```powershell
$env:SI_07_VUS = "20"
$env:SI_07_JOBS = "500"
$env:SI_07_SLEEP_SECONDS = "0"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-07-ci-verification-batch.js
```

Tăng lên 500 jobs với 20 VUs để:
- Kiểm tra xem tất cả service có chịu được sustained load không
- Phát hiện race condition hoặc resource leak chỉ xuất hiện dưới tải cao
- Lưu ý: đây không còn là correctness test thuần túy -- thresholds có thể cần nới lỏng

### 10.4 Cách đọc kết quả trên dashboard

Trên Grafana dashboard:
1. Mở dashboard `Microservices Capability Cases`.
2. Filter theo `case_id=si-07-ci-verification-batch`.
3. Xem panel "Jobs by service" -- mỗi service là một đường, value = số job đã xử lý.
4. Xem panel "Jobs failed by service" -- nếu có service nào có failed jobs, investigate.
5. Xem panel "API calls by endpoint" -- phân phối request theo `endpoint` tag.
6. Xem panel "HTTP Status distribution" -- tất cả phải là 200 (hoặc 202 cho report).

---

## 11. 4 output -> decision scenarios

### Scenario A: Tất cả pass, exit 0

```text
Exit: 0
Checks: 100%
HTTP failed: 0%
shared_jobs_total: 100
shared_jobs_failed: 0
```

**Kết luận**: Nginx API Gateway route chính xác tất cả 5 service. Không có fallback, không có service down, không có contract violation. Hệ thống sẵn sàng cho các test tiếp theo.

**Hành động**: Chuyển sang ms-02 (products read contract) hoặc ms-03..05 (các service contract khác).

### Scenario B: Một service fail `shared_jobs_failed`

```text
Exit: 99
Checks: ~80% (100 checks total, 20 fail)
HTTP failed: 0%
shared_jobs_total: 100
shared_jobs_failed: 20
Tất cả 20 fail đến từ cùng một operation (vd: ci_order_confirm)
```

**Kết luận**: Một service cụ thể đang gặp vấn đề. 20 jobs fail đều thuộc về `order_confirm` -- order-service không xử lý được request.

**Hành động**:
1. Kiểm tra order-service container: `docker logs <order-service-container>`
2. Kiểm tra Nginx upstream config cho order_service
3. Gọi thủ công: `curl -X POST http://localhost:80/api/sim/orders/SI-TEST-1/confirm -H "Content-Type: application/json" -H "Idempotency-Key: test-1" -d "{}"`
4. Nếu service down, restart: `docker restart <order-service-container>`

### Scenario C: `X-Upstream-Service: app` xuất hiện

```text
Exit: 0 (có thể -- nếu app trả về 200)
Checks: 100% (tất cả status 200)
HTTP failed: 0%
Manual check phát hiện: X-Upstream-Service = "app" cho một số request
```

**Kết luận**: Routing sai -- một số URL prefix không được Nginx match đúng. Request rơi vào fallback `location /` và được xử lý bởi `app` thay vì microservice đích.

**Hành động**:
1. Xác định URL path nào bị route sai
2. Kiểm tra Nginx config -- có thể thiếu `location` block cho prefix đó
3. Kiểm tra thứ tự `location` blocks -- prefix dài hơn phải được định nghĩa trước prefix ngắn hơn (nếu dùng regex) hoặc đảm bảo không bị prefix khác "nuốt"
4. Sau khi sửa, reload Nginx: `docker exec <nginx-container> nginx -s reload`

### Scenario D: `shared_jobs_total < 100` (timeout)

```text
Exit: 99
shared_jobs_total: 67 (ít hơn 100)
shared_jobs_failed: 0
Test dừng sau maxDuration 10 phút
```

**Kết luận**: Một hoặc nhiều service bị treo, khiến worker không thể hoàn thành job. Worker pool bị block chờ response từ service treo.

**Hành động**:
1. Kiểm tra container nào đang trong trạng thái không healthy
2. Kiểm tra xem có worker nào bị kẹt ở một operation cụ thể không
3. Restart toàn bộ stack: `./scripts/stack.ps1 -Stack target -Action down; ./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn`
4. Chạy lại với `maxDuration` dài hơn để xem có phải service cực kỳ chậm không

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "Status 200 không có nghĩa là routing đúng"

Người mới thường thấy `ci_product_list status 200` pass và kết luận "products-service hoạt động tốt". Nhưng status 200 có thể đến từ `app` fallback nếu routing sai. `app` có thể trả về 200 với response mặc định, và bạn không thể phân biệt nếu không check `X-Upstream-Service`.

**Sự thật**: Status 200 là điều kiện cần, không đủ. `X-Upstream-Service` mới là evidence quyết định routing correctness. Một response 200 từ sai service (vd: `app` fallback thay vì `order-service`) là fail.

### 12.2 Nghịch lý 2: "Test từng service riêng lẻ pass không đảm bảo batch pass"

Bạn có thể test `GET /api/sim/products` thủ công bằng curl và thấy 200. Nhưng khi tất cả 5 service được gọi đồng thời trong batch, các vấn đề sau có thể xuất hiện:
- Connection pool exhaustion: 10 VUs đồng thời gọi 5 service khác nhau có thể làm cạn kiệt Nginx upstream connection pool
- DNS cache staleness: Một upstream IP có thể thay đổi giữa các request
- Memory pressure: Xử lý đồng thời nhiều request body (POST) có thể gây memory issue

**Sự thật**: Batch test phát hiện các vấn đề chỉ xuất hiện khi nhiều service được gọi đồng thời -- những vấn đề mà test từng service riêng lẻ không thể phát hiện.

### 12.3 Nghịch lý 3: "10 VUs là quá ít"

Thoạt nhìn, 10 VUs có vẻ ít so với production load (hàng ngàn concurrent users). Nhưng case này không phải là load test -- nó là correctness test. 10 VUs đủ để:
- Tạo concurrent requests đến tất cả 5 service
- Xử lý 100 jobs trong vài giây
- Phát hiện routing bug mà không cần load cao

**Sự thật**: Tăng VUs không làm tăng khả năng phát hiện routing bug. Routing bug là deterministic -- nếu config sai, nó sai với mọi số lượng VUs. 10 VUs là đủ để chứng minh routing đúng.

### 12.4 Nghịch lý 4: "Round-robin job distribution = mỗi service được test đúng 20 lần"

Với 100 jobs và 5 loại, phân phối round-robin (`index % cases.length`) cho 20 jobs mỗi loại. Nhưng trong thực tế chạy, một VU có thể xử lý 15 jobs trong khi VU khác chỉ xử lý 5. Điều này có nghĩa phân phối thực tế giữa các VU là không đồng đều -- nhưng phân phối giữa các service type vẫn là 20 mỗi loại, vì job type được gán cố định trong setup, không phụ thuộc vào VU nào xử lý.

**Sự thật**: `shared-iterations` đảm bảo mỗi iteration được thực thi đúng một lần, nhưng không đảm bảo VU nào thực thi iteration nào. Điều này không ảnh hưởng đến correctness của test vì mỗi job là độc lập.

### 12.5 Nghịch lý 5: "Không cần check `X-Upstream-Service` trong script nếu thresholds pass"

Script hiện tại không check `X-Upstream-Service` trong code -- nó chỉ check status code qua `requestJson()`. Thresholds pass (checks 100%, shared_jobs_failed 0) không đảm bảo `X-Upstream-Service` đúng.

**Sự thật**: Script dựa vào status code làm proxy cho routing correctness: nếu service trả về đúng status, routing có khả năng đúng. Nhưng để chắc chắn 100%, cần manual verification `X-Upstream-Service` qua dashboard hoặc console output. Đây là lý do case catalog nhấn mạnh signal này trong `expected.signals`.

---

## 13. Checklist trước khi chạy

### 13.1 Stack readiness

- [ ] Stack đã được start với `-TargetLayer full-no-cdn -ScaleApp 2`
- [ ] `docker ps` cho thấy tất cả containers đang running và healthy
- [ ] `curl http://localhost:80/` trả về 200
- [ ] `curl -s -I http://localhost:80/api/sim/products | findstr "X-Cache"` không có output

### 13.2 Environment variables

- [ ] `$env:BASE_URL = "http://localhost:80"` đã được set
- [ ] `$env:SI_07_VUS = "10"` (hoặc giá trị tùy chỉnh)
- [ ] `$env:SI_07_JOBS = "100"` (hoặc giá trị tùy chỉnh)
- [ ] `$env:SI_07_SLEEP_SECONDS = "0"` (mặc định)

### 13.3 Upstream health check

- [ ] `curl -s http://localhost:80/api/sim/products?limit=5` -> 200 + `X-Upstream-Service: products-service`
- [ ] `curl -s -X POST http://localhost:80/api/sim/cart/add -H "Content-Type: application/json" -d "{\"product_id\":1,\"quantity\":1}"` -> 200 + `X-Upstream-Service: cart-service`
- [ ] `curl -s -X POST http://localhost:80/api/sim/orders/SI-CHECK-1/confirm -H "Content-Type: application/json" -H "Idempotency-Key: check-1" -d "{}"` -> 200 + `X-Upstream-Service: order-service`
- [ ] `curl -s http://localhost:80/api/sim/report?cpu_ms=1` -> 200 + `X-Upstream-Service: report-service`

### 13.4 k6 installation

- [ ] `k6 version` hoạt động
- [ ] Script path: `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-07-ci-verification-batch.js` tồn tại
- [ ] `common.js` có mặt trong cùng thư mục

### 13.5 Test strategy

- [ ] Xác định mục tiêu: CI/CD smoke test (default) hay debug (tuned)?
- [ ] Nếu là CI/CD: dùng 10 VUs, 100 jobs, kỳ vọng exit 0
- [ ] Nếu là debug: dùng 2 VUs, 20 jobs, SLEEP_SECONDS=0.1, quan sát từng request

---

## 14. Variations với code mẫu

### Variation 1: Chỉ test một service (ví dụ: order-service)

```javascript
import {
  BASE_URL, buildJobs, buildSharedScenario, currentJob,
  envFloat, envInt, finishJob, requestJson, think,
} from './common.js';

const CASE_ID = 'si-07-order-only';
const VUS = envInt('SI_07_VUS', 4);
const JOBS = envInt('SI_07_JOBS', 30);
const SLEEP_SECONDS = envFloat('SI_07_SLEEP_SECONDS', 0);

export const options = {
  scenarios: {
    order_only: buildSharedScenario('orderOnly', VUS, JOBS, '5m', {
      case_id: CASE_ID,
      business_case: 'order_service_smoke',
    }),
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    shared_jobs_total: [`count==${JOBS}`],
    shared_jobs_failed: ['count==0'],
  },
};

export function setup() {
  const seed = Date.now();
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `order-smoke-${index + 1}`,
      orderId: `SI-ORD-${seed}-${index + 1}`,
      idemKey: `si-ord-${seed}-${index + 1}`,
    })),
  };
}

export function orderOnly(data) {
  const started = Date.now();
  const job = currentJob(data);

  const result = requestJson(
    'POST',
    `${BASE_URL}/api/sim/orders/${job.orderId}/confirm?cpu_ms=1&db_writes=1&external_ms=1&external_fail_rate=0`,
    {},
    {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'order_confirm_smoke',
      endpoint: 'POST /api/sim/orders/:id/confirm',
      jobId: job.id,
      headers: { 'Idempotency-Key': job.idemKey },
    },
  );

  finishJob(started, result.ok, {
    caseId: CASE_ID,
    service: 'order-service',
    operation: 'order_smoke_job',
    jobId: job.id,
  });
  think(SLEEP_SECONDS, { caseId: CASE_ID, operation: 'worker_pause' });
}
```

**Mục đích**: Isolate một service để debug routing issue hoặc contract issue cho service đó. Hữu ích khi chỉ một service fail trong batch test.

### Variation 2: Thêm check `X-Upstream-Service` trực tiếp trong script

```javascript
import { check } from 'k6';
import {
  BASE_URL, buildJobs, buildSharedScenario, currentJob,
  envFloat, envInt, finishJob, think,
} from './common.js';
import http from 'k6/http';

const CASE_ID = 'si-07-routing-assert';
const VUS = envInt('SI_07_VUS', 10);
const JOBS = envInt('SI_07_JOBS', 100);
const SLEEP_SECONDS = envFloat('SI_07_SLEEP_SECONDS', 0);

// Map URL prefix -> expected X-Upstream-Service value
const ROUTING_MAP = {
  '/api/sim/products': 'products-service',
  '/api/sim/cart': 'cart-service',
  '/api/sim/orders/': 'order-service',
  '/api/sim/report': 'report-service',
};

function expectedUpstream(path) {
  for (const [prefix, service] of Object.entries(ROUTING_MAP)) {
    if (path.startsWith(prefix)) return service;
  }
  return 'app'; // fallback -> fail
}

export const options = {
  scenarios: {
    routing_assert: buildSharedScenario('routingAssert', VUS, JOBS, '10m', {
      case_id: CASE_ID,
      business_case: 'routing_header_verification',
    }),
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    shared_jobs_total: [`count==${JOBS}`],
    shared_jobs_failed: ['count==0'],
  },
};

export function setup() {
  const cases = ['product_list', 'product_detail', 'cart_add', 'order_confirm', 'report_generate'];
  const seed = Date.now();
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `routing-${index + 1}`,
      type: cases[index % cases.length],
      productId: (index % 50) + 1,
      orderId: `SI-RT-${seed}-${index + 1}`,
      idemKey: `si-rt-${seed}-${index + 1}`,
    })),
  };
}

export function routingAssert(data) {
  const started = Date.now();
  const job = currentJob(data);

  let url, method, body, expectedSvc;
  if (job.type === 'product_list') {
    url = `${BASE_URL}/api/sim/products?limit=10&cpu_ms=1&db_rows=2`;
    method = 'GET';
    body = null;
    expectedSvc = 'products-service';
  } else if (job.type === 'product_detail') {
    url = `${BASE_URL}/api/sim/products/${job.productId}?view=full&cpu_ms=1&db_rows=1`;
    method = 'GET';
    body = null;
    expectedSvc = 'products-service';
  } else if (job.type === 'cart_add') {
    url = `${BASE_URL}/api/sim/cart/add?cpu_ms=1&db_writes=1`;
    method = 'POST';
    body = { product_id: job.productId, quantity: 1 };
    expectedSvc = 'cart-service';
  } else if (job.type === 'order_confirm') {
    url = `${BASE_URL}/api/sim/orders/${job.orderId}/confirm?cpu_ms=1&db_writes=1&external_ms=1&external_fail_rate=0`;
    method = 'POST';
    body = {};
    expectedSvc = 'order-service';
  } else {
    url = `${BASE_URL}/api/sim/report?cpu_ms=1&db_rows=1&gzip_kb=1`;
    method = 'GET';
    body = null;
    expectedSvc = 'report-service';
  }

  const params = {
    headers: { 'Content-Type': 'application/json' },
    tags: {
      case_id: CASE_ID,
      service: expectedSvc,
      operation: `ci_${job.type}`,
      endpoint: `${method} ${url.replace(BASE_URL, '')}`,
      job_id: job.id,
    },
  };

  let res;
  if (method === 'POST') {
    res = http.post(url, JSON.stringify(body || {}), params);
  } else {
    res = http.get(url, params);
  }

  // Check status + X-Upstream-Service
  const upstream = res.headers['X-Upstream-Service'];
  const ok = check(res, {
    [`${job.type} status 200`]: (r) => r.status === 200,
    [`${job.type} upstream ${expectedSvc}`]: () => upstream === expectedSvc,
    [`${job.type} not fallback app`]: () => upstream !== 'app',
  });

  finishJob(started, ok, {
    caseId: CASE_ID,
    service: expectedSvc,
    operation: 'routing_assert_job',
    jobId: job.id,
  });
  think(SLEEP_SECONDS, { caseId: CASE_ID, operation: 'worker_pause' });
}
```

**Mục đích**: Thêm assert trực tiếp cho `X-Upstream-Service` header -- không cần manual verification. Check `upstream matches` và `not fallback app` sẽ fail ngay nếu routing sai, thay vì chỉ fail khi status code sai.

### Variation 3: Batch với weighted random (thay vì round-robin)

```javascript
import { chooseWeighted } from '../shared/common.js';

export function setup() {
  const seed = Date.now();
  const serviceTypes = [
    { type: 'product_list', weight: 40 },
    { type: 'product_detail', weight: 25 },
    { type: 'cart_add', weight: 15 },
    { type: 'order_confirm', weight: 12 },
    { type: 'report_generate', weight: 8 },
  ];

  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `ci-wr-${index + 1}`,
      type: chooseWeighted(serviceTypes).type,
      productId: (index % 50) + 1,
      orderId: `SI-WR-${seed}-${index + 1}`,
      idemKey: `si-wr-${seed}-${index + 1}`,
    })),
  };
}
```

**Mục đích**: Mô phỏng production traffic pattern với weighted distribution thay vì round-robin đều. Products service nhận 65% traffic, report service chỉ nhận 8% -- phản ánh đúng tỉ lệ thực tế.

### Variation 4: Thêm health check endpoint trước khi chạy batch

```javascript
export function setup() {
  // Kiểm tra health của tất cả service trước khi tạo jobs
  const services = [
    { name: 'products-service', url: `${BASE_URL}/api/sim/products?limit=1` },
    { name: 'cart-service', url: `${BASE_URL}/api/sim/cart/summary` },
    { name: 'order-service', url: `${BASE_URL}/api/sim/orders/HEALTH-CHECK-1` },
    { name: 'report-service', url: `${BASE_URL}/api/sim/report?cpu_ms=1` },
  ];

  for (const svc of services) {
    const res = http.get(svc.url);
    const upstream = res.headers['X-Upstream-Service'];
    if (res.status !== 200 || upstream !== svc.name) {
      throw new Error(`Pre-flight health check FAILED: ${svc.name} returned status=${res.status}, upstream=${upstream}`);
    }
  }

  // Chỉ tạo jobs nếu tất cả service healthy
  const seed = Date.now();
  const cases = ['product_list', 'product_detail', 'cart_add', 'order_confirm', 'report_generate'];
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `ci-verify-${index + 1}`,
      type: cases[index % cases.length],
      productId: (index % 50) + 1,
      orderId: `SI-CI-${seed}-${index + 1}`,
      idemKey: `si-ci-${seed}-${index + 1}`,
    })),
  };
}
```

**Mục đích**: Pre-flight health check trước khi tạo jobs -- nếu bất kỳ service nào không healthy, test fail ngay trong setup thay vì chạy 100 jobs rồi mới phát hiện.

### Variation 5: So sánh response body shape giữa các service

```javascript
export function ciVerificationBatch(data) {
  const started = Date.now();
  const job = currentJob(data);
  let result;

  // ... (dispatch logic giống script gốc)

  // Kiểm tra response body shape
  if (result.ok) {
    const body = result.response.json();
    const bodyOk = check(result.response, {
      [`${job.type} has success field`]: () => body.hasOwnProperty('success'),
      [`${job.type} has data field`]: () => body.hasOwnProperty('data'),
      [`${job.type} success is true`]: () => body.success === true,
    });
    if (!bodyOk) result.ok = false;
  }

  finishJob(started, result.ok, { /* ... */ });
}
```

**Mục đích**: Không chỉ check status code và routing, mà còn check response envelope `{ success, data }` -- tiến gần hơn đến contract test (như ms-02).

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Bỏ qua manual check `X-Upstream-Service`

```text
SAI: Chạy script, thấy exit 0, kết luận "routing đúng".
```

**Vấn đề**: Script hiện tại chỉ check status code. Nếu `app` fallback trả về 200, tất cả checks pass nhưng routing sai.

**Cách đúng**: Sau khi chạy script, kiểm tra dashboard hoặc thêm Variation 2 (assert `X-Upstream-Service` trực tiếp). Nếu manual, `curl` từng endpoint và xác nhận header.

### 15.2 Anti-pattern 2: Không kiểm tra tất cả 5 service

```text
SAI: Chỉ test 2-3 service "quan trọng", bỏ qua report-service.
```

**Vấn đề**: Report service có thể bị misconfigured mà không ai phát hiện cho đến khi có incident. Mỗi service trong batch đều quan trọng như nhau cho routing correctness.

**Cách đúng**: Luôn test tất cả service được định nghĩa trong Nginx config. Nếu thêm service mới, thêm job type mới vào `cases` array.

### 15.3 Anti-pattern 3: Dùng `http_req_failed: ['rate<0.01']` thay vì `rate==0`

```text
SAI: Cho phép 1% HTTP failure trong smoke test.
```

**Vấn đề**: Smoke test là correctness gate. Bất kỳ HTTP failure nào cũng là tín hiệu có vấn đề. Cho phép 1% failure có thể che giấu routing bug.

**Cách đúng**: Dùng `rate==0` cho correctness test. Chỉ nới lỏng threshold trong stress test mode.

### 15.4 Anti-pattern 4: Set `SLEEP_SECONDS` quá lớn trong CI/CD

```text
SAI: $env:SI_07_SLEEP_SECONDS = "1" -- mỗi job nghỉ 1 giây.
```

**Vấn đề**: 100 jobs x 1 giây = ít nhất 100 giây cho một smoke test. CI/CD pipeline bị chậm không cần thiết.

**Cách đúng**: `SLEEP_SECONDS=0` cho CI/CD. Chỉ set > 0 khi debug.

### 15.5 Anti-pattern 5: Thay đổi job type distribution mà không cập nhật thresholds

```text
SAI: Thêm job type thứ 6 (auth-service) vào cases array nhưng vẫn giữ JOBS=100.
```

**Vấn đề**: Với 6 loại job và 100 jobs, phân phối không còn đều (100/6 = 16.67, dư 4). Một số service chỉ được test 16 lần thay vì 20.

**Cách đúng**: Khi thêm job type mới, điều chỉnh JOBS để chia hết cho số loại. Ví dụ: 6 loại -> JOBS=120 (mỗi loại 20 jobs).

### 15.6 Anti-pattern 6: Không set `Idempotency-Key` cho order_confirm

```text
SAI: Gọi order_confirm không có Idempotency-Key header.
```

**Vấn đề**: Order service yêu cầu `Idempotency-Key` cho confirm operation. Nếu thiếu, service có thể trả về 400 hoặc xử lý sai. Đây không phải là routing bug -- là contract violation.

**Cách đúng**: Luôn gửi `Idempotency-Key` header cho `order_confirm`. Đây là một phần của contract test (sẽ được test kỹ hơn trong ms-04).

---

## 16. Real validation data

### 16.1 Default CI/CD smoke run (10 VUs, 100 jobs)

```text
     script: si-07-ci-verification-batch.js
     scenarios: ci_verification_batch
     executor: shared-iterations
     vus: 10
     iterations: 100

     ✓ ci_product_list status 200
     ✓ ci_product_detail status 200
     ✓ ci_cart_add status 200
     ✓ ci_order_confirm status 200
     ✓ ci_report_generate status 200

     checks.....................: 100.00% ✓ 100   ✗ 0
     http_req_failed............: 0.00%   ✓ 100   ✗ 0
     http_req_duration..........: avg=15ms min=5ms med=12ms max=45ms p(90)=22ms p(95)=28ms
     http_reqs..................: 100
     shared_jobs_total.........: 100
     shared_jobs_failed........: 0
     shared_api_calls_total....: 100
     shared_job_duration_ms....: avg=18ms min=7ms med=14ms max=50ms
     iterations.................: 100
     vus........................: 10

     Exit: 0
```

**Phân tích**:
- 100/100 checks pass -- tất cả API calls trả về đúng expected status
- p95 latency = 28ms -- tất cả service phản hồi nhanh (cpu_ms=1, db_rows=1-2)
- 100 API calls = 100 jobs -- mỗi job gọi đúng 1 API call
- shared_job_duration_ms avg=18ms -- thời gian end-to-end mỗi job rất nhanh

### 16.2 Manual verification X-Upstream-Service bằng curl

```powershell
$endpoints = @(
  @{Path="/api/sim/products?limit=5"; ExpectedUpstream="products-service"; Desc="products list"},
  @{Path="/api/sim/products/1?view=full"; ExpectedUpstream="products-service"; Desc="products detail"},
  @{Path="/api/sim/cart/add"; Method="POST"; Body='{"product_id":1,"quantity":1}'; ExpectedUpstream="cart-service"; Desc="cart add"},
  @{Path="/api/sim/orders/SI-MANUAL-1/confirm"; Method="POST"; Body='{}'; ExtraHeaders=@{'Idempotency-Key'='manual-1'}; ExpectedUpstream="order-service"; Desc="order confirm"},
  @{Path="/api/sim/report?cpu_ms=1"; ExpectedUpstream="report-service"; Desc="report"}
)

foreach ($ep in $endpoints) {
  $method = if ($ep.Method) { $ep.Method } else { "GET" }
  $headers = @{}
  if ($ep.ExtraHeaders) { $ep.ExtraHeaders.GetEnumerator() | ForEach-Object { $headers[$_.Key] = $_.Value } }

  $params = @{
    Uri = "http://localhost:80$($ep.Path)"
    Method = $method
    UseBasicParsing = $true
  }
  if ($ep.Body) { $params.Body = $ep.Body }
  if ($ep.Method -in @("POST", "PATCH")) { $params.ContentType = "application/json" }

  $response = Invoke-WebRequest @params
  $upstream = $response.Headers['X-Upstream-Service']
  $status = $response.StatusCode
  $match = if ($upstream -eq $ep.ExpectedUpstream) { "PASS" } else { "FAIL" }
  Write-Host "$($ep.Desc): upstream=$upstream (expected=$($ep.ExpectedUpstream)) status=$status -> $match"
}
```

Output kỳ vọng:
```text
products list: upstream=products-service (expected=products-service) status=200 -> PASS
products detail: upstream=products-service (expected=products-service) status=200 -> PASS
cart add: upstream=cart-service (expected=cart-service) status=200 -> PASS
order confirm: upstream=order-service (expected=order-service) status=200 -> PASS
report: upstream=report-service (expected=report-service) status=200 -> PASS
```

### 16.3 Phân tích phân phối job type

Với 100 jobs round-robin qua 5 loại:

| Job type | Số job | Service tag | Endpoint | Expected status |
| --- | --- | --- | --- | --- |
| `product_list` | 20 | `products-service` | `GET /api/sim/products` | 200 |
| `product_detail` | 20 | `products-service` | `GET /api/sim/products/:id` | 200 |
| `cart_add` | 20 | `cart-service` | `POST /api/sim/cart/add` | 200 |
| `order_confirm` | 20 | `order-service` | `POST /api/sim/orders/:id/confirm` | 200 |
| `report_generate` | 20 | `report-service` | `GET /api/sim/report` | 200 |

### 16.4 Phân tích debug mode (2 VUs, 20 jobs, SLEEP_SECONDS=0.1)

```text
     script: si-07-ci-verification-batch.js
     vus: 2
     iterations: 20
     sleep: 100ms

     ✓ ci_product_list status 200
     ✓ ci_product_detail status 200
     ✓ ci_cart_add status 200
     ✓ ci_order_confirm status 200
     ✓ ci_report_generate status 200

     checks.....................: 100.00% ✓ 20   ✗ 0
     http_req_failed............: 0.00%   ✓ 20   ✗ 0
     http_req_duration..........: avg=18ms min=6ms med=14ms max=42ms p(95)=35ms
     http_reqs..................: 20
     shared_jobs_total.........: 20
     shared_jobs_failed........: 0
     shared_sleep_seconds......: 2.0 (20 x 0.1s)
     iterations.................: 20
     vus........................: 2

     Exit: 0
```

Với debug mode:
- 20 jobs hoàn thành trong ~2 giây + network latency
- Mỗi service được test 4 lần (20/5 = 4) -- đủ để phát hiện routing bug
- `shared_sleep_seconds = 2.0` -- tổng thời gian nghỉ = 20 jobs x 0.1s

---

## 17. Reference

### 17.1 Các file liên quan

| File | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-07-ci-verification-batch.js` | Script chính của case |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\common.js` | Shared library: `requestJson()`, `buildJobs()`, `currentJob()`, `finishJob()`, `buildSharedScenario()`, `think()` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\microservices\case-catalog.json` | Catalog định nghĩa tất cả microservices cases, topology, expected signals |
| `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Nginx configuration với location blocks và upstream definitions |
| `E:\Khoa hoc\k6\docs\practice\microservices\00_overview.md` | Tổng quan Microservices layer, mental model, key concepts |

### 17.2 Các case liên quan trong series

| Case | Mối liên hệ |
| --- | --- |
| [ms-02 -- Products read contract](./02_products-read-contract.md) | Case tiếp theo trong learning order -- test products-service contract sau khi routing đã được chứng minh |
| [ms-03 -- Cart write contract](./03_cart-write-contract.md) | Test cart-service contract |
| [ms-04 -- Order transaction contract](./04_order-transaction-contract.md) | Test order-service contract (bao gồm cả Idempotency-Key đã xuất hiện trong case này) |
| [ms-05 -- Report async contract](./05_report-async-contract.md) | Test report-service contract (bao gồm async job pattern) |
| [ms-06 -- Stateful business flow](./06_stateful-business-flow.md) | Test flow xuyên suốt 5 service -- chỉ chạy sau khi ms-01 đã pass |
| [ms-07 -- Service health](./07_service-health-dependencies.md) | Test health endpoint cho từng service |

### 17.3 Tài liệu tổng quan

| File | Nội dung |
| --- | --- |
| [00_overview.md](./00_overview.md) | Tổng quan Microservices layer, 7 capability proofs, evidence model |
| [../lb/05_origin-service-mix.md](../lb/05_origin-service-mix.md) | LB case tương đương -- test routing correctness dưới production-like mix |
| [../RUN_GUIDE.md](../RUN_GUIDE.md) | Hướng dẫn chạy toàn bộ test suite |

### 17.4 Kiến thức nền

| Chủ đề | Tài liệu tham khảo |
| --- | --- |
| Nginx location directive | [nginx.org: location](https://nginx.org/en/docs/http/ngx_http_core_module.html#location) |
| Nginx upstream module | [nginx.org: upstream](https://nginx.org/en/docs/http/ngx_http_upstream_module.html) |
| Nginx proxy_set_header | [nginx.org: proxy_set_header](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header) |
| k6 shared-iterations executor | [k6.io: shared-iterations](https://k6.io/docs/using-k6/scenarios/executors/shared-iterations/) |
| k6 check reference | [k6.io: checks](https://k6.io/docs/using-k6/checks/) |
| k6 custom metrics | [k6.io: custom metrics](https://k6.io/docs/using-k6/metrics/create-custom-metrics/) |
| API Gateway pattern | [microservices.io: api gateway](https://microservices.io/patterns/apigateway.html) |
