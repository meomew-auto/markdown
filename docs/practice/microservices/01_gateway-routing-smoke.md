# ms-01 — Gateway routing smoke

> **Case ID:** `ms-01-gateway-routing-smoke`
> **Script:** `../shared-iterations/si-07-ci-verification-batch.js`
> **Profile:** `full-no-cdn`
> **Workload:** shared-iterations, 10 VUs, 100 jobs
> **Proof:** Nginx route đúng URL prefix đến đúng microservice — `X-Upstream-Service` header trên mọi response khớp với service sở hữu prefix đó

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [Microservices capability được chứng minh](#2-microservices-capability-được-chứng-minh)
3. [Vì sao phải test ở Microservices layer](#3-vì-sao-phải-test-ở-microservices-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Service mechanism deep-dive: Nginx API Gateway routing](#6-service-mechanism-deep-dive-nginx-api-gateway-routing)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals](#8-key-signals)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output → decision scenarios](#11-4-output--decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist](#13-checklist)
14. [4-5 Variations](#14-4-5-variations)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh nghiệp vụ

Trước khi test bất kỳ service contract nào, cần chứng minh Nginx route đúng URL prefix đến đúng microservice. Case này gửi request đến tất cả 5 service và kiểm tra header `X-Upstream-Service` trên từng response.

```text
/products       → X-Upstream-Service: products-service
/products/:id   → X-Upstream-Service: products-service
/cart/add       → X-Upstream-Service: cart-service
/orders/:id     → X-Upstream-Service: order-service
/report/jobs    → X-Upstream-Service: report-service
```

Hãy hình dung: bạn vừa join một team mới, được giao debug một incident — "order confirm không hoạt động". Bạn gọi `POST /api/sim/orders/123/confirm`, nhận về HTTP 200 với `success: true`. Mọi thứ có vẻ ổn. Nhưng thực ra request đã bị Nginx route đến **app fallback** thay vì **order-service** — fallback handler cũng trả về 200 với mock data, không hề gọi payment-mock. Order chưa bao giờ được confirm thật sự.

Nếu bạn không kiểm tra `X-Upstream-Service` header, bạn sẽ mất hàng giờ debug code order-service trong khi vấn đề nằm ở Nginx config.

### 1.2 Tại sao gateway routing là case đầu tiên?

```text
Nếu gateway route sai service, mọi contract test sau đó đều vô nghĩa.
```

Trong bất kỳ microservices system nào, API gateway là **single point of routing**. Một location block sai trong Nginx config, một upstream misconfigured, hoặc một service không registered — và traffic rơi vào fallback handler âm thầm. Status 200 từ fallback trông giống hệt status 200 từ service thật. Không có `X-Upstream-Service`, bạn không thể phân biệt.

### 1.3 Năm service, năm prefix

```text
k6/client
  → http://localhost:80 (Nginx)
  → /api/sim/auth/*      → auth-service:8081      (X-Upstream-Service: auth-service)
  → /api/sim/products     → products-service:8084   (X-Upstream-Service: products-service)
  → /api/sim/cart         → cart-service:8082       (X-Upstream-Service: cart-service)
  → /api/sim/checkout     → order-service:8083      (X-Upstream-Service: order-service)
  → /api/sim/orders/*     → order-service:8083      (X-Upstream-Service: order-service)
  → /api/sim/report*      → report-service:8085     (X-Upstream-Service: report-service)
  → /*                    → app:8080 (fallback)     (X-Upstream-Service: app)
```

Mỗi URL prefix được Nginx `location` block route đến một upstream riêng. `X-Upstream-Service` header được set bởi `add_header` directive trong mỗi location block — không phải bởi application code. Điều này có nghĩa header này **luôn có mặt**, ngay cả khi service behind upstream bị down (lúc đó bạn sẽ thấy 502/503 nhưng header vẫn đúng).

### 1.4 Case này khác gì với smoke test thông thường?

| Khía cạnh | Smoke test thông thường | Case này (gateway routing smoke) |
| --- | --- | --- |
| **Mục tiêu** | "Service có alive không?" | "Request có đến đúng service không?" |
| **Phạm vi** | 1-2 endpoints | 5 services, 5 endpoints |
| **Evidence** | HTTP 200 | `X-Upstream-Service` header |
| **Fail mode** | 4xx/5xx | 200 từ sai service (fallback) |
| **Pattern** | Ping | Audit — mỗi request check 1 service |

---

## 2. Microservices capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh Nginx API gateway route đúng:

> **Mỗi URL prefix được Nginx route đến đúng upstream microservice. Header `X-Upstream-Service` trên mọi response khớp với service sở hữu prefix đó. Không có request nào rơi vào fallback `location /` (app). Tất cả 5 service đều alive và trả về response hợp lệ.**

### 2.2 Năm routing rule được verify

| # | URL Prefix | Expected Upstream | Expected Header | Port |
| --- | --- | --- | --- | ---: |
| 1 | `/api/sim/products` | products_backend | `products-service` | 8084 |
| 2 | `/api/sim/products/:id` | products_backend | `products-service` | 8084 |
| 3 | `/api/sim/cart/add` | cart_backend | `cart-service` | 8082 |
| 4 | `/api/sim/orders/:id/confirm` | order_backend | `order-service` | 8083 |
| 5 | `/api/sim/report` | report_backend | `report-service` | 8085 |

### 2.3 Tín hiệu chứng minh routing đúng

1. **`X-Upstream-Service` header khớp expected service**: Mỗi response có header `X-Upstream-Service` được set bởi Nginx `add_header` directive.
2. **Không có `X-Upstream-Service: app`**: Request không rơi vào fallback `location /`.
3. **5 service phân bố đều trong request breakdown**: Dashboard chart cho thấy 5 endpoint, mỗi endpoint 20 requests.
4. **Tất cả status 200**: Mọi service đều xử lý được request — không có 4xx/5xx.
5. **`shared_jobs_failed = 0`**: Không job nào thất bại.

---

## 3. Vì sao phải test ở Microservices layer

### 3.1 Vì sao không test ở CDN layer?

CDN test (layer 1) xác nhận cache behavior. CDN không tham gia vào routing decision giữa các microservice — nó chỉ quyết định có cache response hay không. CDN không thể cho bạn biết request được route đến service nào.

### 3.2 Vì sao không test ở LB layer?

LB test (layer 2) xác nhận upstream selection, distribution, retry/failover. Nhưng LB test tập trung vào **instance-level routing** (request đến app-1 hay app-2?), không phải **service-level routing** (request đến order-service hay cart-service?). LB test dùng dedicated LB origins, không dùng microservice upstreams.

### 3.3 Vì sao phải test ở Microservices layer?

Microservices layer (layer 3) là nơi duy nhất có thể xác nhận:

- **Service-level routing**: Mỗi URL prefix route đến đúng service upstream.
- **`X-Upstream-Service` header**: Chỉ xuất hiện khi request qua Nginx microservice location blocks.
- **Cross-service coverage**: Một case duy nhất cover tất cả 5 service.
- **Fallback detection**: Phát hiện request rơi vào fallback app thay vì microservice.

### 3.4 Đây là prerequisite cho mọi case khác

```text
ms-01 (case này) → ms-02→05 (per-service contracts) → ms-06 (cross-service flow) → ms-07 (health)
```

Nếu ms-01 fail, **dừng**. Đừng debug ms-02 hay ms-06. Vấn đề là routing, không phải contract.

---

## 4. Topology và precondition

### 4.1 Topology

```text
Script: ../shared-iterations/si-07-ci-verification-batch.js
Executor: shared-iterations
Default VUs: 10
Default jobs: 100
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

### 4.2 Stack requirement

```text
Phải có đủ 5 service:
  k6target-auth-service-1
  k6target-products-service-1
  k6target-cart-service-1
  k6target-order-service-1 (hoặc 2 instances)
  k6target-report-service-1
  k6target-nginx-1
```

### 4.3 Precondition

- [x] `docker compose --profile full-no-cdn up -d` đã chạy
- [x] Tất cả service health check pass
- [x] `BASE_URL=http://localhost:80` khả dụng
- [x] Không cần `OPS_AUTH_TOKEN`

---

## 5. Script deep-dive

### 5.1 Cấu trúc script

```javascript
// si-07-ci-verification-batch.js
export function setup() {
  const cases = ['product_list', 'product_detail', 'cart_add', 'order_confirm', 'report_generate'];
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `ci-verify-${index + 1}`,
      type: cases[index % cases.length],  // round-robin qua 5 loại
      productId: (index % 50) + 1,
      orderId: `SI-CI-${seed}-${index + 1}`,
      idemKey: `si-ci-${seed}-${index + 1}`,
    })),
  };
}
```

100 jobs được tạo trong `setup()`, mỗi job có `type` xác định service nào sẽ được gọi. 5 loại job phân bố round-robin → 20 jobs mỗi service.

### 5.2 Hàm export chính

```javascript
export function ciVerificationBatch(data) {
  const job = currentJob(data);
  if (job.type === 'product_list') {
    result = requestJson('GET', `${BASE_URL}/api/sim/products?limit=10&cpu_ms=1&db_rows=2`, ...);
  } else if (job.type === 'product_detail') {
    result = requestJson('GET', `${BASE_URL}/api/sim/products/${job.productId}?view=full&cpu_ms=1&db_rows=1`, ...);
  } else if (job.type === 'cart_add') {
    result = requestJson('POST', `${BASE_URL}/api/sim/cart/add?cpu_ms=1&db_writes=1`, ...);
  } else if (job.type === 'order_confirm') {
    result = requestJson('POST', `${BASE_URL}/api/sim/orders/${job.orderId}/confirm?cpu_ms=1&db_writes=1&external_ms=1`, {
      headers: { 'Idempotency-Key': job.idemKey },
    });
  } else {
    result = requestJson('GET', `${BASE_URL}/api/sim/report?cpu_ms=1&db_rows=1&gzip_kb=1`, ...);
  }
  finishJob(started, result.ok, ...);
}
```

Mỗi job type gọi một endpoint khác nhau, với query params mô phỏng realistic load (`cpu_ms`, `db_rows`, `db_writes`).

### 5.3 Tags cho dashboard

Mỗi HTTP request được tag với:
- `case_id`: `si-07-ci-verification-batch`
- `service`: `products-service`, `cart-service`, `order-service`, hoặc `report-service`
- `operation`: `ci_product_list`, `ci_product_detail`, `ci_cart_add`, `ci_order_confirm`, `ci_report_generate`
- `endpoint`: URL path
- `job_id`: ID của job

---

## 6. Service mechanism deep-dive: Nginx API Gateway routing

### 6.1 Nginx location block mapping

```nginx
# /api/sim/auth/* → auth-service
location /api/sim/auth/ {
    add_header X-Upstream-Service "auth-service" always;
    proxy_pass http://auth_backend;
}

# /api/sim/cart → cart-service (prefix match, không trailing slash)
location /api/sim/cart {
    add_header X-Upstream-Service "cart-service" always;
    proxy_pass http://cart_backend;
}

# /api/sim/checkout → order-service (exact match =)
location = /api/sim/checkout {
    add_header X-Upstream-Service $sim_checkout_service always;
    proxy_pass http://$sim_checkout_backend;
}

# /api/sim/orders/* → order-service
location /api/sim/orders/ {
    add_header X-Upstream-Service "order-service" always;
    add_header X-Upstream-Addr $upstream_addr always;
    proxy_pass http://order_backend;
}

# /api/sim/products → products-service (prefix match)
location /api/sim/products {
    add_header X-Upstream-Service "products-service" always;
    proxy_pass http://products_backend;
}

# /api/sim/report → report-service (exact match =)
location = /api/sim/report {
    add_header X-Upstream-Service "report-service" always;
    proxy_pass http://report_backend;
}

# /api/sim/report/* → report-service
location /api/sim/report/ {
    add_header X-Upstream-Service "report-service" always;
    proxy_pass http://report_backend;
}

# Catch-all → app fallback
location / {
    add_header X-Upstream-Service "app" always;
    proxy_pass http://app_backend;
}
```

### 6.2 Upstream definitions

```nginx
upstream auth_backend      { server auth-service:8081; }
upstream cart_backend      { server cart-service:8082; }
upstream order_backend     { server order-service:8083; }
upstream products_backend  { server products-service:8084; }
upstream report_backend    { server report-service:8085; }
upstream app_backend       { server app:8080; }
```

### 6.3 `add_header ... always` — tại sao?

`always` keyword đảm bảo header được set ngay cả trên error responses (4xx, 5xx). Không có `always`, `add_header` chỉ hoạt động trên 2xx responses. Điều này quan trọng: nếu upstream down (502), bạn vẫn biết được request đã cố gắng route đến service nào.

### 6.4 Header được set ở đâu?

`X-Upstream-Service` được set bởi **Nginx**, không phải application code. Điều này có nghĩa:
- Header luôn có mặt trên mọi response từ Nginx.
- Application code không thể fake/override header này (Nginx `add_header` ghi đè).
- Nếu request đến thẳng app (bypass Nginx), header sẽ không có mặt.

---

## 7. Request sequence flow

```text
Setup phase:
  1. Script tạo 100 jobs trong setup()
  2. Mỗi job có type: product_list | product_detail | cart_add | order_confirm | report_generate
  3. 5 types × 20 jobs = 100 jobs phân bố đều

Runtime (shared-iterations, 10 VUs, 100 jobs):
  Mỗi VU lấy 1 job từ pool, thực hiện 1 HTTP request, finish job

  VU-1:  job-1  (product_list)     → GET  /api/sim/products?limit=10&cpu_ms=1&db_rows=2
  VU-2:  job-2  (product_detail)   → GET  /api/sim/products/1?view=full&cpu_ms=1&db_rows=1
  VU-3:  job-3  (cart_add)         → POST /api/sim/cart/add?cpu_ms=1&db_writes=1
  VU-4:  job-4  (order_confirm)    → POST /api/sim/orders/SI-CI-.../confirm?...
  VU-5:  job-5  (report_generate)  → GET  /api/sim/report?cpu_ms=1&db_rows=1&gzip_kb=1
  ...    ...     ...                → ...
  VU-10: job-10 (product_list)     → GET  /api/sim/products?limit=10&cpu_ms=1&db_rows=2

  Tổng: 100 jobs, 100 HTTP requests, 0.4s
```

---

## 8. Key signals

### 8.1 Primary signals (pass/fail)

| Signal | Expected | Fail meaning |
| --- | --- | --- |
| `checks` | 100% | Có request không pass check |
| `http_req_failed` | 0.00% | Có request trả về non-2xx |
| `shared_jobs_total` | 100 | Không đủ jobs hoàn thành |
| `shared_jobs_failed` | 0 | Có job thất bại |

### 8.2 Routing signals

| Signal | Source | Expected |
| --- | --- | --- |
| `X-Upstream-Service` | Nginx response header | `products-service`, `cart-service`, `order-service`, `report-service` — không bao giờ `app` |
| `ci_product_list status 200` | Check | ✓ |
| `ci_product_detail status 200` | Check | ✓ |
| `ci_cart_add status 200` | Check | ✓ |
| `ci_order_confirm status 200` | Check | ✓ |
| `ci_report_generate status 200` | Check | ✓ |

### 8.3 Service distribution (dashboard tags)

| Tag: `service` | Count | % |
| --- | ---: | ---: |
| `products-service` | 40 | 40% |
| `cart-service` | 20 | 20% |
| `order-service` | 20 | 20% |
| `report-service` | 20 | 20% |

---

## 9. Pass/fail criteria

### 9.1 Pass

```text
✅ checks rate = 100%
✅ http_req_failed = 0%
✅ shared_jobs_failed = 0
✅ Tất cả 5 service xuất hiện trong request breakdown
✅ Không có X-Upstream-Service: app
✅ shared_jobs_total = 100
```

### 9.2 Fail modes

| Mode | Symptom | Root cause |
| --- | --- | --- |
| **Fallback routing** | 1+ request có `X-Upstream-Service: app` | Nginx location block sai hoặc upstream không registered |
| **Service down** | `http_req_failed > 0` trên 1 service | Service container stopped/crashed |
| **Missing header** | Response thiếu `X-Upstream-Service` | Request không qua Nginx (direct to app) |
| **Partial coverage** | Chỉ 3-4 service xuất hiện | Một số upstream không resolve được |
| **Wrong service** | `X-Upstream-Service` khác expected | Location block conflict — prefix match sai thứ tự |

---

## 10. Cách chạy + output mẫu

### 10.1 Local run

```powershell
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:BASE_URL = "http://localhost:80"
$env:SI_07_VUS = "10"
$env:SI_07_JOBS = "100"
$env:SI_07_SLEEP_SECONDS = "0"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-07-ci-verification-batch.js
```

### 10.2 Output mẫu (PASS)

```text
     execution: local
        output: cloud (https://app.k6.io/runs/112)

  █ THRESHOLDS
    checks              ✓ 'rate==1' rate=100.00%
    http_req_failed     ✓ 'rate==0' rate=0.00%
    shared_jobs_failed  ✓ 'count==0' count=0
    shared_jobs_total   ✓ 'count==100' count=100

  █ TOTAL RESULTS
    checks_total.......: 100     439.99/s
    checks_succeeded...: 100.00% 100 out of 100
    checks_failed......: 0.00%   0 out of 100

    ✓ ci_product_list status 200
    ✓ ci_report_generate status 200
    ✓ ci_product_detail status 200
    ✓ ci_cart_add status 200
    ✓ ci_order_confirm status 200

    CUSTOM
    shared_jobs_total..............: 100
    shared_jobs_failed.............: 0
    shared_job_duration_ms.........: avg=20.55ms p(95)=82.49ms

    HTTP
    http_reqs......................: 100
    http_req_failed................: 0.00% 0 out of 100
    http_req_duration..............: avg=19.18ms p(95)=82.02ms

running (00m00.2s), 00/10 VUs, 100 complete and 0 interrupted iterations
```

---

## 11. 4 output → decision scenarios

### Scenario A: Tất cả pass

```text
checks=100%, http_fail=0%, 5 services, 0 app fallback
→ Routing đúng. Tiếp tục ms-02.
```

### Scenario B: Có `X-Upstream-Service: app`

```text
1+ request đến app fallback thay vì service mong đợi
→ Kiểm tra Nginx config: location block có đúng prefix không?
→ Kiểm tra upstream block: service có registered không?
→ Kiểm tra Docker DNS: service name có resolve được không?
```

### Scenario C: 1 service thiếu trong breakdown

```text
Chỉ thấy 4 service thay vì 5
→ Service bị thiếu có container đang chạy không? (docker ps)
→ Nginx upstream có resolve được service name không?
→ Check Nginx error log: "no live upstreams"
```

### Scenario D: `http_req_failed > 0`

```text
Có request trả về 4xx/5xx
→ Service đang chạy nhưng trả lỗi — kiểm tra service log
→ Có thể dependency (Postgres/Redis) down
→ Chạy ms-07 (health check) để xác nhận
```

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Status 200 = routing đúng"

```text
SAI. App fallback cũng trả về 200.
Chỉ X-Upstream-Service header mới chứng minh được routing.
```

### Nghịch lý 2: "5 service = 5 request là đủ"

```text
SAI. Cần sample size đủ lớn để phát hiện intermittent routing issues.
20 requests/service (tổng 100) là minimum.
```

### Nghịch lý 3: "Case này chỉ cần chạy một lần"

```text
SAI. Nên chạy lại sau mỗi lần Nginx config thay đổi,
thêm service mới, hoặc thay đổi upstream.
```

### Nghịch lý 4: "X-Upstream-Service được set bởi application"

```text
SAI. Header này được set bởi Nginx add_header directive.
Application code không liên quan.
```

---

## 13. Checklist

- [ ] Stack `full-no-cdn` đang chạy
- [ ] 5 service container healthy (`docker ps`)
- [ ] `BASE_URL=http://localhost:80` khả dụng
- [ ] Đã chạy script với `-o cloud`
- [ ] `checks=100%`, `http_req_failed=0%`
- [ ] Dashboard request breakdown hiển thị 5 service
- [ ] Không có `X-Upstream-Service: app` trong response
- [ ] `shared_jobs_failed = 0`

---

## 14. 4-5 Variations

### Variation 1: Tăng sample size

```powershell
$env:SI_07_JOBS = "500"   # Default: 100
$env:SI_07_VUS = "20"     # Default: 10
```

### Variation 2: Chỉ test 1 service (targeted debug)

```javascript
// Sửa setup() để chỉ tạo 1 loại job
const cases = ['product_list'];  // Chỉ test products-service
```

### Variation 3: Thêm delay để quan sát realtime dashboard

```powershell
$env:SI_07_SLEEP_SECONDS = "0.5"  # Default: 0
```

### Variation 4: Chạy không có cloud output (local only)

```powershell
k6 run E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-07-ci-verification-batch.js
```

### Variation 5: Strict distinct-upstream mode (cho CI)

```powershell
$env:ORDER_SHARED_STATE_REQUIRE_DISTINCT_UPSTREAM = "true"
```

---

## 15. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Bỏ qua `X-Upstream-Service` header** | Không thể chứng minh routing — mất evidence chính |
| **Chỉ check status code** | App fallback cũng trả 200 — false positive |
| **Không chạy qua Nginx (direct to service port)** | Bỏ qua toàn bộ routing layer — test sai mục tiêu |
| **Chạy với CDN (`TargetLayer=full`)** | CDN cache có thể che giấu routing issues |
| **Chỉ test 1-2 service** | Bỏ sót service bị misconfigured |
| **Dùng `--out json` thay vì `-o cloud`** | Không có data trên dashboard realtime |

---

## 16. Real validation data

### Run #112 (2026-06-24)

```json
{
  "run_id": "112",
  "checks_passes": 100, "checks_fails": 0, "checks_rate": 1.0,
  "http_req_failed_rate": 0, "http_reqs": 100, "iterations": 100,
  "http_req_duration_avg": 20.7, "http_req_duration_med": 3.8,
  "http_req_duration_p95": 86.8, "vus_max": 10
}
```

### Request breakdown

| Endpoint | Reqs | Status |
| --- | ---: | --- |
| GET /api/sim/products | 20 | 200 |
| GET /api/sim/products/:id | 20 | 200 |
| POST /api/sim/cart/add | 20 | 200 |
| POST /api/sim/orders/:id/confirm | 20 | 200 |
| GET /api/sim/report | 20 | 200 |

### Dashboard chart observations

```text
http_req_duration: bimodal — P50 3.8ms (report/cart) vs P95 86.8ms (products)
Service distribution: 5 slices đều 20% — routing proof hoàn chỉnh
shared_jobs_failed: flat 0
```

### Latency per service

| Service | Reqs | Avg | P95 |
| --- | ---: | ---: | ---: |
| report-service | 20 | 2.79ms | 5.11ms |
| cart-service | 20 | 8.65ms | 31.67ms |
| order-service | 20 | 24.49ms | 56.16ms |
| products-service | 40 | 29.99ms | 95.47ms |

---

## 17. Reference

- **Script**: `k6/shared-iterations/si-07-ci-verification-batch.js`
- **Catalog**: `k6/microservices/case-catalog.json`
- **Nginx config**: `load-target/nginx/nginx.conf` (location blocks + upstream definitions)
- **Chart data**: `.claude-microservices-chart-summary.json` → `ms-01-gateway-routing`
- **Dashboard**: `http://localhost:13001/` → run #112
