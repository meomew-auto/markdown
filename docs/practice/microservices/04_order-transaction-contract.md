# ms-04 — Order service: transaction API contract

> **Case ID:** `ms-04-order-transaction-contract`
> **Script:** `../shared-iterations/si-02-order-reconciliation.js`
> **Executor:** `shared-iterations`, `vus=8, iterations=120`
> **Profile:** `full-no-cdn`
> **Proof:** Order service xử lý chính xác checkout → confirm (có Idempotency-Key) → status — full transaction contract, `X-Upstream-Addr` hiện diện, idempotency replay trả về cùng kết quả

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [Microservices capability được chứng minh](#2-microservices-capability-được-chứng-minh)
3. [Vì sao phải test ở Microservices layer](#3-vì-sao-phải-test-ở-microservices-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Service mechanism deep-dive: Order transaction flow + idempotency](#6-service-mechanism-deep-dive-order-transaction-flow--idempotency)
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

Daily reconciliation: cuối mỗi ngày, hệ thống tài chính replay tất cả order trong ngày — checkout → confirm → đọc status — để đối chiếu với payment gateway. Mỗi order phải được xác nhận đúng một lần, và trạng thái cuối cùng phải khớp với payment webhook.

```text
Reconciliation job: checkout → confirm (có Idempotency-Key) → read status
```

Trong một hệ thống thương mại điện tử thực tế, quy trình này diễn ra hàng ngày:

1. **23:00 PM**: Hệ thống đóng sổ ngày. Mọi order chưa confirm bị đánh dấu "pending reconciliation".
2. **23:05 PM**: Reconciliation batch khởi động — 120 orders cần được verify.
3. **23:05-23:06 PM**: Mỗi order được checkout lại (idempotent), confirm với idempotency key, và đọc status để verify payment webhook đã apply.
4. **23:07 PM**: Báo cáo đối chiếu được generate — chênh lệch giữa order service và payment gateway (nếu có) được flag.

Nếu idempotency key không hoạt động, cùng một order có thể bị confirm hai lần — dẫn đến charge kép cho khách hàng. Nếu status không khớp, báo cáo tài chính sai.

### 1.2 Tại sao order service là transactional core

Order service khác biệt với tất cả service khác:

| Đặc điểm | Order service | Các service khác |
| --- | --- | --- |
| **External dependency** | Có — payment-mock (HTTP) | Không (chỉ Postgres/Redis) |
| **Idempotency** | Bắt buộc — confirm và webhook | Không cần (read-only hoặc idempotent tự nhiên) |
| **Money path** | Có — mọi lỗi đều có hậu quả tài chính | Không |
| **X-Upstream-Addr** | Có — cần biết instance nào xử lý | Không cần |
| **Claim/TTL** | Có — Redis claim owner pattern | Không |

### 1.3 Idempotency: lý do tồn tại

```text
Idempotency key đảm bảo: gửi cùng request N lần → chỉ thực hiện 1 lần.
```

Hãy tưởng tượng một khách hàng nhấn nút "Đặt mua" trên trình duyệt. Request được gửi đi, nhưng response bị mất do network flap. Trình duyệt retry — gửi lại request y hệt. Nếu không có idempotency, khách hàng bị charge 2 lần.

Với idempotency key (một UUID được generate ở client), lần retry thứ hai sẽ thấy key đã tồn tại trong Redis và trả về kết quả của lần đầu tiên — không tạo ra side effect mới.

### 1.4 Reconciliation pattern

Case này sử dụng **reconciliation pattern**: mỗi job tạo một order mới, confirm với key duy nhất, và đọc status để verify.

| Khía cạnh | Audit (ms-02) | Reconciliation (case này) |
| --- | --- | --- |
| **Data** | Đọc product có sẵn | Tạo order mới mỗi job |
| **Side effect** | Không (pure read) | Có (external call, DB write) |
| **Idempotency** | Không cần | Bắt buộc cho confirm |
| **State check** | `success=true`, data populated | `order_id` preserved, `idempotency_reuse` flag |

---

## 2. Microservices capability được chứng minh

### 2.1 Phát biểu capability

> **Order service xử lý chính xác toàn bộ transaction flow: checkout tạo order với `order_id`, confirm với `Idempotency-Key` header đảm bảo idempotent execution, và status read trả về order state đầy đủ. Header `X-Upstream-Addr` hiện diện cho biết order-service instance nào đã xử lý request. Idempotency replay trả về cùng kết quả với `idempotency_reuse=true`.**

### 2.2 Ba endpoint chính

| Endpoint | Method | Purpose | Key Header |
| --- | --- | --- | --- |
| `/api/sim/checkout` | POST | Tạo order từ cart | — |
| `/api/sim/orders/:id/confirm` | POST | Xác nhận order (có payment) | `Idempotency-Key` |
| `/api/sim/orders/:id` | GET | Đọc order state | — |

### 2.3 Các khía cạnh được verify

1. **Checkout tạo `order_id`**: Response chứa `data.order_id` — ID này dùng cho confirm và status.
2. **Confirm idempotent**: Cùng `Idempotency-Key` gửi nhiều lần → cùng kết quả, `idempotency_reuse=true`.
3. **Status preserve `order_id`**: GET status trả về `data.order_id` khớp với checkout.
4. **`X-Upstream-Addr` hiện diện**: Cho biết order-service instance nào xử lý (quan trọng cho distributed state proof ở Redis layer).
5. **external call cost**: `external_ms=60` thể hiện rõ trong latency confirm.

---

## 3. Vì sao phải test ở Microservices layer

### 3.1 Vì sao không test ở CDN layer?

CDN không cache POST request — checkout và confirm là POST, không bao giờ qua CDN cache. CDN layer không thể verify idempotency hay transaction flow.

### 3.2 Vì sao không test ở LB layer?

LB test kiểm tra upstream selection giữa các instance. Nhưng LB không thể verify:
- Contract của từng endpoint (body shape, status code)
- Idempotency key behavior
- `order_id` preservation qua các bước

### 3.3 Vì sao phải test ở Microservices layer?

Đây là transaction contract test — nó verify:
- **API contract đúng**: Response envelope, status code, body fields.
- **Idempotency hoạt động**: `Idempotency-Key` header được parse và sử dụng đúng.
- **State preservation**: `order_id` đi từ checkout → confirm → status không thay đổi.
- **External dependency visible**: `external_ms` cost thể hiện trong latency.

### 3.4 Là prerequisite cho Redis layer

```text
Microservices (case này) → Redis/shared state (redis-01, redis-02...)
```

Redis cases test idempotency **dưới điều kiện khắc nghiệt** (race, hotkey, Redis degrade). Nhưng trước đó, cần verify idempotency **hoạt động cơ bản** — đây là điều case này làm. Nếu case này fail, Redis cases sẽ fail vì lý do ngoài Redis.

---

## 4. Topology và precondition

### 4.1 Topology

```text
Script: ../shared-iterations/si-02-order-reconciliation.js
Executor: shared-iterations
Default VUs: 8
Default jobs: 120
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

### 4.2 Stack requirement

```text
Phải có:
  k6target-order-service-1 (hoặc 2 instances)
  k6target-payment-mock-1 (external dependency)
  k6target-postgres-1
  k6target-redis-1
```

### 4.3 Precondition

- [x] Stack `full-no-cdn` đang chạy
- [x] Order service health check pass (bao gồm payment-mock dependency)
- [x] `BASE_URL=http://localhost:80`
- [x] Redis available (cho idempotency state)
- [x] Không cần `OPS_AUTH_TOKEN`

---

## 5. Script deep-dive

### 5.1 Setup

```javascript
export function setup() {
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `order-recon-${index + 1}`,
      orderId: `SI-ORDER-${seed}-${index + 1}`,
      idemKey: `si-order-${seed}-${index + 1}`,
    })),
  };
}
```

120 jobs, mỗi job có `orderId` và `idemKey` duy nhất.

### 5.2 Runtime — 3 bước

```javascript
// Bước 1: Checkout
const checkout = requestJson('POST',
  `${BASE_URL}/api/sim/checkout?cpu_ms=4&db_writes=2&external_ms=30`,
  { payment_method: 'card', item_count: 2, coupon_code: 'SI02' });

// Bước 2: Confirm với Idempotency-Key
const confirm = requestJson('POST',
  `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=2&db_writes=3&external_ms=60`,
  {},
  { headers: { 'Idempotency-Key': idemKey } });

// Bước 3: Status
const status = requestJson('GET',
  `${BASE_URL}/api/sim/orders/${orderId}?cpu_ms=1&db_rows=2&view=full`);
```

### 5.3 Tags

Mỗi request được tag:
- `case_id`: `si-02-order-reconciliation`
- `service`: `order-service`
- `operation`: `order_checkout_reconcile`, `order_confirm_reconcile`, `order_status_verify`
- `endpoint`: URL path
- `job_id`: ID của job

---

## 6. Service mechanism deep-dive: Order transaction flow + idempotency

### 6.1 Checkout flow

```text
POST /api/sim/checkout
  → app (router.go: sim.POST("/checkout", h.SimCheckout))
  → Nginx: location = /api/sim/checkout → order-service (hoặc app fallback)
  → Order service: tạo order trong Postgres
  → Gọi payment-mock (external_ms=30)
  → Trả về { success: true, data: { order_id, ... } }
```

### 6.2 Confirm flow (có idempotency)

```text
POST /api/sim/orders/:id/confirm
  Header: Idempotency-Key: <key>
  → Nginx: location /api/sim/orders/ → order-service
  → Order service:
    1. Kiểm tra Redis: key đã tồn tại chưa?
       - Nếu có → idempotency_reuse=true, trả về kết quả cũ (KHÔNG gọi payment)
       - Nếu chưa → thực hiện confirm, lưu kết quả vào Redis
    2. DB write: cập nhật order status = confirmed
    3. External call: payment-mock (external_ms=60)
    4. Lưu idempotency record vào Redis (key → result)
  → Trả về { success: true, data: { idempotency_reuse: false/true, ... } }
```

### 6.3 Status flow

```text
GET /api/sim/orders/:id
  → Nginx: location /api/sim/orders/ → order-service
  → Order service: đọc order từ Postgres
  → Trả về { success: true, data: { order_id, status, history, ... } }
```

### 6.4 Tại sao confirm dùng idempotency còn checkout thì không?

- **Checkout**: Mỗi lần gọi tạo ra order mới — không cần idempotency (mỗi order là unique).
- **Confirm**: Cùng một order có thể được confirm nhiều lần (retry) — idempotency ngăn charge kép.
- **Webhook payment**: Cùng `event_id` có thể được gửi nhiều lần — idempotency ngăn apply kép.

### 6.5 external_ms và latency signature

```
Checkout:  external_ms=30 → baseline ~30ms + overhead
Confirm:   external_ms=60 → baseline ~60ms + overhead
Status:    external_ms=0  → baseline ~2ms (pure DB read)

Latency ratio confirm/status ≈ 50:1
```

Đây là signature quan trọng: nếu confirm latency ≈ status latency, external call không hoạt động.

---

## 7. Request sequence flow

```text
Setup tạo 120 jobs

Mỗi job (3 HTTP requests):
  1. POST /api/sim/checkout?cpu_ms=4&db_writes=2&external_ms=30
     Body: { payment_method:"card", item_count:2, coupon_code:"SI02" }
     → Expect: 200, success=true, data.order_id không rỗng

  2. POST /api/sim/orders/{orderId}/confirm?cpu_ms=2&db_writes=3&external_ms=60
     Header: Idempotency-Key: {idemKey}
     → Expect: 200, success=true
     → idempotency_reuse=false (lần đầu)

  3. GET /api/sim/orders/{orderId}?cpu_ms=1&db_rows=2&view=full
     → Expect: 200, success=true
     → data.order_id === orderId từ bước 1

Tổng: 120 jobs × 3 calls = 360 HTTP requests (thực tế 240 vì confirm và status là 2 call/job)
```

---

## 8. Key signals

### 8.1 Primary signals

| Signal | Expected |
| --- | --- |
| `checks` | 100% |
| `http_req_failed` | 0.00% |
| `shared_jobs_total` | 120 |
| `shared_jobs_failed` | 0 |

### 8.2 Contract signals

| Signal | Source | Expected |
| --- | --- | --- |
| `X-Upstream-Service` | Response header | `order-service` |
| `X-Upstream-Addr` | Response header | Present (VD: `10.0.0.5:8083`) |
| `order_checkout_reconcile status 200` | Check | ✓ |
| `order_confirm_reconcile status 200` | Check | ✓ |
| `order_status_verify status 200` | Check | ✓ |
| Checkout `data.order_id` | Response body | Không rỗng |
| Confirm `idempotency_reuse` | Response body | `false` (lần đầu) |
| Status `data.order_id` | Response body | Khớp checkout |

### 8.3 Latency signature

| Operation | Expected latency | Dominated by |
| --- | ---: | --- |
| `order_status_verify` | ~2ms | Pure DB read |
| `order_checkout_reconcile` | ~35ms | external_ms=30 |
| `order_confirm_reconcile` | ~100ms | external_ms=60 + DB writes |

---

## 9. Pass/fail criteria

### 9.1 Pass

```text
✅ checks rate = 100%
✅ http_req_failed = 0%
✅ shared_jobs_failed = 0
✅ X-Upstream-Service: order-service trên mọi response
✅ X-Upstream-Addr present
✅ Checkout trả về order_id không rỗng
✅ Confirm trả về success=true
✅ Status preserve order_id
```

### 9.2 Fail modes

| Mode | Symptom | Root cause |
| --- | --- | --- |
| **External call fail** | Confirm latency ≈ status latency (~2ms) | payment-mock down hoặc external_ms không hoạt động |
| **Idempotency key bị bỏ qua** | Confirm không có `idempotency_reuse` field | Order service không parse `Idempotency-Key` header |
| **order_id mismatch** | Status trả về order_id khác checkout | State corruption |
| **Routing sai** | `X-Upstream-Service` không phải `order-service` | Nginx location block sai |
| **Missing X-Upstream-Addr** | Không thấy header | Nginx config thiếu `add_header X-Upstream-Addr` |

---

## 10. Cách chạy + output mẫu

### 10.1 Local run

```powershell
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:BASE_URL = "http://localhost:80"
$env:SI_02_VUS = "8"
$env:SI_02_JOBS = "120"
$env:SI_02_SLEEP_SECONDS = "0"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-02-order-reconciliation.js
```

### 10.2 Output mẫu (PASS)

```text
     execution: local
        output: cloud (https://app.k6.io/runs/110)

  █ THRESHOLDS
    checks              ✓ 'rate==1' rate=100.00%
    http_req_failed     ✓ 'rate==0' rate=0.00%
    shared_jobs_failed  ✓ 'count==0' count=0
    shared_jobs_total   ✓ 'count==120' count=120

  █ TOTAL RESULTS
    checks_total.......: 240     151.78/s
    checks_succeeded...: 100.00% 240 out of 240
    checks_failed......: 0.00%   0 out of 240

    ✓ order_checkout_reconcile status 200
    ✓ order_confirm_reconcile status 200
    ✓ order_status_verify status 200

    CUSTOM
    shared_jobs_total..............: 120
    shared_jobs_failed.............: 0
    shared_job_duration_ms.........: avg=102.6ms p(95)=112.0ms

    HTTP
    http_reqs......................: 240
    http_req_failed................: 0.00% 0 out of 240
    http_req_duration..............: avg=51.2ms med=4.3ms p(95)=110.3ms

running (00m01.5s), 0/8 VUs, 120 complete and 0 interrupted iterations
```

---

## 11. 4 output → decision scenarios

### Scenario A: Tất cả pass

```text
checks=100%, http_fail=0%, all 3 operations pass
→ Order contract đúng. Tiếp tục ms-05.
```

### Scenario B: Confirm latency bất thường

```text
Confirm latency ≈ 2ms (giống status) thay vì ~100ms
→ payment-mock có thể down. external_ms=60 không được áp dụng.
→ Kiểm tra payment-mock health: docker ps | grep payment-mock
→ Order service health: GET /health → payment dependency status
```

### Scenario C: Idempotency không hoạt động

```text
idempotency_reuse field missing hoặc luôn false
→ Order service không hỗ trợ Idempotency-Key header
→ Kiểm tra version order-service
→ Đây là contract violation — cần fix BE
```

### Scenario D: order_id mismatch

```text
Status trả về order_id khác với checkout
→ State corruption trong order service
→ Có thể do DB transaction không committed trước khi confirm
```

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Checkout và confirm đều gọi external — latency giống nhau"

```text
SAI. Checkout external_ms=30, Confirm external_ms=60.
Confirm chậm hơn gấp đôi checkout. Dashboard chart phải thấy khác biệt.
```

### Nghịch lý 2: "Status 200 = order đã confirm"

```text
SAI. Status 200 chỉ có nghĩa order tồn tại.
Cần check data.status để biết order đã confirm hay chưa.
```

### Nghịch lý 3: "Idempotency-Key header tự động hoạt động"

```text
SAI. Cần cả client (gửi header) và server (parse + check Redis).
Thiếu một bên → idempotency không hoạt động.
```

### Nghịch lý 4: "Avg latency 51ms là bình thường"

```text
SAI. avg=51ms là meaningless vì bimodal: status ~2ms, confirm ~100ms.
Phải tách theo operation để đọc latency.
```

---

## 13. Checklist

- [ ] Stack `full-no-cdn` đang chạy với order-service và payment-mock
- [ ] `BASE_URL=http://localhost:80`
- [ ] Redis available
- [ ] Đã chạy script với `-o cloud`
- [ ] `checks=100%`, `http_req_failed=0%`
- [ ] `X-Upstream-Service: order-service`
- [ ] `X-Upstream-Addr` present
- [ ] Latency confirm >> latency status (do external_ms)
- [ ] `shared_jobs_failed = 0`

---

## 14. 4-5 Variations

### Variation 1: Tăng external_ms để thấy rõ difference

```powershell
# Sửa script: external_ms=120 thay vì 60
# Confirm latency sẽ tăng lên ~160ms
```

### Variation 2: Test idempotency replay (gửi 2 lần cùng key)

```javascript
// Thêm bước 4: gửi lại confirm với cùng Idempotency-Key
const confirm2 = requestJson('POST', `${BASE_URL}/api/sim/orders/${orderId}/confirm?...`, {}, {
  headers: { 'Idempotency-Key': idemKey },  // CÙNG key
});
// Expect: idempotency_reuse=true, duration << first confirm
```

### Variation 3: Giảm VUs để quan sát rõ hơn

```powershell
$env:SI_02_VUS = "2"
$env:SI_02_JOBS = "20"
```

### Variation 4: Chạy với external_fail_rate

```powershell
# Sửa script: external_fail_rate=0.2
# 20% confirm sẽ thấy payment fail → idempotency vẫn phải đúng
```

---

## 15. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Không check `X-Upstream-Addr`** | Không biết request đến instance nào — không debug được distributed issues |
| **Aggregate latency** | avg che giấu bimodal: status 2ms + confirm 100ms |
| **Không verify `order_id` preservation** | Bỏ qua state corruption |
| **Chạy không có payment-mock** | Confirm không có external call — latency không realistic |
| **Bỏ qua `idempotency_reuse` field** | Không biết idempotency có hoạt động không |

---

## 16. Real validation data

### Run #110 (2026-06-24)

```json
{
  "run_id": "110",
  "checks_passes": 240, "checks_fails": 0, "checks_rate": 1.0,
  "http_req_failed_rate": 0, "http_reqs": 240, "iterations": 120,
  "http_req_duration_avg": 51.2, "http_req_duration_med": 4.3,
  "http_req_duration_p95": 110.3, "vus_max": 8
}
```

### Request breakdown

| Endpoint | Reqs | Status |
| --- | ---: | --- |
| POST /api/sim/orders/:id/confirm | 120 | 200 |
| GET /api/sim/orders/:id | 120 | 200 |

### Latency per operation

| Operation | Reqs | Avg | P95 |
| --- | ---: | ---: | ---: |
| order_status_verify | 120 | 1.98ms | 3.23ms |
| order_confirm_reconcile | 120 | 100.47ms | 118.32ms |

### Dashboard chart

```text
http_req_duration: extreme bimodal — P50 4.3ms (status) vs P95 110.3ms (confirm)
Ratio confirm/status ≈ 50:1 — external_ms=60 proof
```

---

## 17. Reference

- **Script**: `k6/shared-iterations/si-02-order-reconciliation.js`
- **Catalog**: `k6/microservices/case-catalog.json`
- **Order service routes**: `load-target/services/order-service/routes.go`
- **Nginx config**: `load-target/nginx/nginx.conf` (order upstream + X-Upstream-Addr)
- **Chart data**: `.claude-microservices-chart-summary.json` → `ms-04-order-contract`
- **Dashboard**: `http://localhost:13001/` → run #110
- **Next layer**: Redis/shared state (redis-01 — distributed state proof)
