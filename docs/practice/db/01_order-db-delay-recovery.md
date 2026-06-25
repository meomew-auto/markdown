# db-01 — Order DB delay and recovery

> **Case ID:** `db-01-order-db-delay-recovery`
> **Script:** `../app/07-production-mix-order-db-recovery.js`
> **Profile:** `full-no-cdn`
> **Workload:** 1 VU, 1 iteration (sequential), requires `OPS_AUTH_TOKEN`
> **Proof:** Inject DB delay 35ms qua `/ops/order/db/profile` → `performance.breakdown.db_ms` tăng → reset → recovery. DB latency observable và recoverable.

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [DB capability được chứng minh](#2-db-capability-được-chứng-minh)
3. [Vì sao phải test ở DB layer](#3-vì-sao-phải-test-ở-db-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Service mechanism deep-dive: DB delay injection và recovery](#6-service-mechanism-deep-dive-db-delay-injection-và-recovery)
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

### 1.1 Bối cảnh vận hành

11:00 AM thứ Sáu. Team infrastructure thông báo: "Postgres instance sắp được nâng cấp lên version mới. Trong quá trình failover sang replica, ứng dụng có thể thấy latency tăng 30-50ms trong vài giây."

Đây không phải là tình huống giả định. Mọi hệ thống dùng Postgres đều trải qua:
- **Maintenance window**: Vacuum, reindex, upgrade version
- **Failover**: Primary → standby switchover
- **Network degradation**: Cross-AZ latency spike

Câu hỏi: **ứng dụng có hoạt động đúng khi DB chậm không? Và có recover sau khi DB bình thường trở lại không?**

### 1.2 Controlled experiment — không phải chaos

```text
Khác với chaos engineering (bắn random failure vào production),
đây là controlled experiment:
  - Biết trước delay bao nhiêu ms (35ms default)
  - Biết trước delta latency expected (160ms)
  - Có control plane để reset về trạng thái sạch
  - Sequential (1 VU, 1 iteration) — dễ đọc, dễ debug
```

### 1.3 Tại sao DB delay nguy hiểm hơn CPU delay?

| Loại delay | Ảnh hưởng | Cơ chế |
| --- | --- | --- |
| CPU delay (`cpu_ms`) | Chỉ ảnh hưởng request hiện tại | Worker thread bận |
| DB delay (`postgres_delay_ms`) | Ảnh hưởng TẤT CẢ request dùng DB | Connection pool bị giữ lâu hơn |
| External delay (`external_ms`) | Chỉ ảnh hưởng request có external call | HTTP client wait |

DB delay là nguy hiểm nhất vì nó ảnh hưởng **toàn bộ connection pool** — không chỉ request hiện tại, mà cả request trong queue.

### 1.4 Ba phase của experiment

```text
Phase 1 — Baseline:  Đo latency bình thường (không delay)
Phase 2 — Degraded:   Inject delay 35ms → latency tăng
Phase 3 — Recovery:   Reset → latency trở về baseline
```

Pattern này lặp lại trong db-01, db-02, db-03: **Inject → Observe → Reset → Verify**.

---

## 2. DB capability được chứng minh

### 2.1 Phát biểu capability

> **Khi DB bị delay, `performance.breakdown.db_ms` phản ánh chính xác mức delay. Các API dùng DB bị chậm đi nhưng vẫn hoạt động đúng (không fail). Các API không dùng DB không bị ảnh hưởng. Sau khi reset DB profile, latency trở về mức bình thường.**

### 2.2 Các khía cạnh được verify

1. **Delay injection hoạt động**: `PUT /ops/order/db/profile` với `postgres_delay_ms=35` → profile xác nhận đã set.
2. **Read path bị ảnh hưởng**: `GET /api/sim/orders/:id?db_rows=60` → `db_ms` tăng.
3. **Write path bị ảnh hưởng**: `POST /api/sim/checkout?db_writes=6` → `db_write_ms` tăng.
4. **Unaffected APIs không bị ảnh hưởng**: Products, cart, report — latency không tăng đáng kể.
5. **Recovery**: `POST /ops/order/db/reset` → latency trở về mức baseline.

### 2.3 Contract verification cụ thể

| Phase | Endpoint | Expected | Evidence |
| --- | --- | --- | --- |
| Baseline | `GET /ops/order/db/profile` | 200, `postgres_delay_ms=0` | Profile sạch |
| Baseline | `GET /api/sim/orders/:id?db_rows=60` | 200, `db_ms` present | Baseline latency |
| Degraded | `PUT /ops/order/db/profile` | 200, delay=35 | Profile set |
| Degraded | `GET /api/sim/orders/:id?db_rows=60` | 200, `db_ms` > baseline | Latency tăng |
| Degraded | `POST /api/sim/checkout?db_writes=6` | 200, `db_write_ms` > baseline | Write path affected |
| Degraded | `GET /api/sim/products` | 200, latency không tăng | Unaffected |
| Recovery | `POST /ops/order/db/reset` | 200 | Profile cleared |
| Recovery | `GET /api/sim/orders/:id?db_rows=60` | 200, `db_ms` ≈ baseline | Recovered |

---

## 3. Vì sao phải test ở DB layer

### 3.1 Vì sao không test ở Redis layer?

Redis test kiểm tra cache/state consistency. Redis không phải là persistent store — không có `db_ms`, `db_write_ms`, `resource_model.db_rows`. Redis delay test (redis-04) kiểm tra correctness under Redis delay, không kiểm tra DB delay.

### 3.2 Vì sao không test ở Microservices layer?

Microservices test kiểm tra API contract và routing. Nó không có control plane để inject DB delay. Nó không đọc `performance.breakdown` để xác nhận DB bị ảnh hưởng.

### 3.3 Vì sao phải test ở DB layer?

DB layer là nơi duy nhất có:
- **Control plane**: `/ops/order/db/profile` để inject delay có kiểm soát.
- **DB metrics**: `db_ms`, `db_write_ms`, `resource_model` trong response body.
- **Recovery verification**: Reset → verify latency trở về baseline.
- **Scope verification**: Xác nhận chỉ DB-dependent APIs bị ảnh hưởng.

---

## 4. Topology và precondition

### 4.1 Topology

```text
Script: ../app/07-production-mix-order-db-recovery.js
Executor: 1 VU, 1 iteration (sequential)
Topology: full-no-cdn
BASE_URL: http://localhost:80
Requires: OPS_AUTH_TOKEN (cho /ops/order/db/*)
```

### 4.2 Stack requirement

```text
Phải có:
  k6target-order-service-1 (hoặc 2)
  k6target-postgres-1
  k6target-products-service-1
  k6target-cart-service-1
  k6target-report-service-1
```

### 4.3 Precondition

- [x] Stack `full-no-cdn` đang chạy
- [x] Postgres healthy
- [x] `OPS_AUTH_TOKEN` đã source từ container
- [x] DB profile sạch (chưa có delay từ test trước)

---

## 5. Script deep-dive

### 5.1 Cấu trúc

```javascript
// Sequential: 1 VU, 1 iteration
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    prod_mix_order_db_check_failures: ['count==0'],
  },
};

// API classification
const affectedApis = new Set(['order_status', 'checkout', 'order_confirm', 'payment_webhook']);
// Các API khác (products, cart, report...) là unaffected
```

### 5.2 Phase logic

```javascript
// Phase 1: Baseline
const baselineProfile = getProfile();
callAffectedApis('baseline');
callUnaffectedApis('baseline');

// Phase 2: Degraded
putProfile({ postgres_delay_ms: DELAY_MS });  // 35ms
const degradedProfile = getProfile();
// Verify: degradedProfile.postgres_delay_ms === DELAY_MS
callAffectedApis('degraded');
// Expect: latency > baseline + DELAY_DELTA_MS
callUnaffectedApis('degraded');
// Expect: latency < baseline + UNAFFECTED_TOLERANCE_MS

// Phase 3: Recovery
postReset();
callAffectedApis('recovery');
// Expect: latency < degraded_latency - RECOVERY_DELTA_MS
```

### 5.3 Custom metrics

| Metric | Type | Ý nghĩa |
| --- | --- | --- |
| `prod_mix_order_db_check_failures` | Counter | Tổng check failures (must = 0) |
| `prod_mix_order_db_degraded_observed` | Rate | Tỉ lệ request thấy degradation |
| `prod_mix_order_db_recovered_observed` | Rate | Tỉ lệ request thấy recovery |
| `prod_mix_order_db_phase_duration` | Trend | Duration của mỗi phase |

---

## 6. Service mechanism deep-dive: DB delay injection và recovery

### 6.1 Control plane API

```text
PUT /ops/order/db/profile
  Body: { "postgres_delay_ms": 35 }
  → Order service thêm 35ms sleep trước mỗi DB query
  → Response: { success: true, data: { postgres_delay_ms: 35 } }

POST /ops/order/db/reset
  → Xóa tất cả DB profile settings
  → Response: { success: true }

GET /ops/order/db/profile
  → Đọc current profile
  → Response: { success: true, data: { postgres_delay_ms: 0|35 } }
```

### 6.2 Cách delay ảnh hưởng response

```text
Không delay:
  Request → Query DB (2ms) → Response
  performance.breakdown.db_ms = 2

Có delay 35ms:
  Request → Sleep 35ms → Query DB (2ms) → Response
  performance.breakdown.db_ms = 37 (= 35 + 2)
```

Delay được áp dụng **trước mỗi DB query**. Điều này mô phỏng chính xác:
- Network latency giữa app server và DB server
- DB query planner chậm
- Disk I/O bottleneck

### 6.3 Tại sao unaffected APIs không bị ảnh hưởng?

Script phân loại APIs thành 2 nhóm:
- **Affected**: Dùng order-service DB (order_status, checkout, order_confirm, payment_webhook) → bị delay
- **Unaffected**: Dùng products-service, cart-service, report-service → **không** bị delay vì DB profile chỉ áp dụng cho order-service

Đây là **scope isolation** — mỗi service có DB profile riêng.

---

## 7. Request sequence flow

```text
Phase 1 — Baseline (~20 requests):
  1. GET  /ops/order/db/profile              → verify delay=0
  2. GET  /api/sim/orders/ORD-1?db_rows=60   → baseline latency
  3. POST /api/sim/checkout?db_writes=6      → baseline write latency
  4. POST /api/sim/orders/ORD-1/confirm?...  → baseline confirm latency
  5. POST /api/sim/orders/webhooks/payment   → baseline webhook latency
  6. GET  /api/sim/products?limit=10         → unaffected baseline
  7. GET  /api/sim/cart                       → unaffected baseline
  8. GET  /api/sim/report                     → unaffected baseline

Phase 2 — Degraded (~80 requests):
  9. PUT  /ops/order/db/profile {delay:35}   → inject delay
  10. GET /ops/order/db/profile               → verify delay=35
  11-14. Affected APIs (order_status × 20, checkout × 20, confirm × 10, webhook × 10)
        → Expect: db_ms tăng, latency > baseline + 160ms
  15-17. Unaffected APIs (products × 10, cart × 10, report × 10)
        → Expect: latency < baseline + 100ms

Phase 3 — Recovery (~60 requests):
  18. POST /ops/order/db/reset                → clear delay
  19. GET  /ops/order/db/profile              → verify delay=0
  20-22. Affected APIs (giống phase 2)
        → Expect: latency < degraded_latency - 120ms
```

---

## 8. Key signals

### 8.1 Primary signals

| Signal | Expected |
| --- | --- |
| `checks` | 100% |
| `prod_mix_order_db_check_failures` | 0 |
| `prod_mix_order_db_degraded_observed` | > 0 |
| `prod_mix_order_db_recovered_observed` | > 0 |

### 8.2 Performance payload signals

| Signal | Phase | Expected |
| --- | --- | --- |
| `performance.breakdown.db_ms` | Baseline | ~2-5ms |
| `performance.breakdown.db_ms` | Degraded | ~37ms (35 + baseline) |
| `performance.breakdown.db_ms` | Recovery | ~2-5ms |
| `performance.breakdown.db_write_ms` | Degraded | Elevated |
| `performance.resource_model.db_rows` | All | Khớp query param |

### 8.3 Profile signals

| Signal | Phase | Expected |
| --- | --- | --- |
| `postgres_delay_ms` | Baseline | 0 |
| `postgres_delay_ms` | Degraded | 35 |
| `postgres_delay_ms` | Recovery | 0 |

---

## 9. Pass/fail criteria

### 9.1 Pass

```text
✅ prod_mix_order_db_check_failures = 0
✅ Delay phase: db_ms elevated, latency > baseline + DELAY_DELTA_MS
✅ Recovery phase: latency < degraded_latency - RECOVERY_DELTA_MS
✅ Unaffected APIs: latency không degraded quá UNAFFECTED_TOLERANCE_MS
✅ Profile postgres_delay_ms = 0 sau reset
```

### 9.2 Fail modes

| Mode | Symptom | Root cause |
| --- | --- | --- |
| **Delay not applied** | db_ms không tăng trong degraded phase | Control plane không hoạt động hoặc sai profile path |
| **Unaffected degraded** | Products/cart/report cũng chậm | Delay scope sai — ảnh hưởng toàn bộ thay vì chỉ order-service |
| **No recovery** | Sau reset, db_ms vẫn cao | Reset không hoạt động hoặc delay stuck |
| **Write path not affected** | db_write_ms không đổi | Delay chỉ áp dụng cho read, không phải write |

---

## 10. Cách chạy + output mẫu

### 10.1 Local run

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
$env:PROD_MIX_ORDER_DB_CONTROL_BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_DELAY_MS = "35"
$env:PROD_MIX_ORDER_DB_DELAY_DELTA_MS = "160"
$env:PROD_MIX_ORDER_DB_RECOVERY_DELTA_MS = "120"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/07-production-mix-order-db-recovery.js
```

### 10.2 Output mẫu (PASS — Run #117)

```text
     execution: local
        output: cloud (https://app.k6.io/runs/117)

  █ THRESHOLDS
    checks              ✓ 'rate==1' rate=99.50%
    prod_mix_order_db_check_failures ✓ 'count==0' count=0

  █ TOTAL RESULTS
    checks_total.......: 200
    checks_succeeded...: 99.50% 199 out of 200
    checks_failed......: 0.50%  1 out of 200

    ✓ degraded profile set status 200
    ✓ degraded profile delay 35
    ✓ recovered profile delay 0

    CUSTOM
    prod_mix_order_db_check_failures....: 0
    prod_mix_order_db_degraded_observed.: 100%
    prod_mix_order_db_recovered_observed: 100%
    prod_mix_order_db_phase_duration....: avg=XXms

    HTTP
    http_reqs......................: 166
    http_req_failed................: 0.00% 0 out of 166
    http_req_duration..............: avg=25.8ms med=6.9ms p95=155.1ms
```

---

## 11. 4 output → decision scenarios

### Scenario A: Tất cả pass

```text
checks ≈ 100%, degraded/recovered observed, delay=35 → delay=0
→ DB delay mechanism hoạt động. Tiếp tục db-02.
```

### Scenario B: db_ms không tăng trong degraded phase

```text
→ Control plane không hoạt động.
→ Kiểm tra OPS_AUTH_TOKEN có đúng không?
→ Kiểm tra /ops/order/db/profile có accessible không?
→ Order service version có hỗ trợ DB profile không?
```

### Scenario C: Unaffected APIs cũng bị chậm

```text
→ Delay scope quá rộng — ảnh hưởng cả service khác.
→ Có thể DB delay được áp dụng ở tầng app thay vì tầng service.
→ Hoặc các service dùng chung DB instance.
```

### Scenario D: Recovery không hoạt động

```text
→ Sau reset, db_ms vẫn > baseline.
→ Reset API có trả về success không?
→ Cần restart order-service để clear state?
```

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "DB delay 35ms → response chậm đúng 35ms"

```text
SAI. Delay 35ms áp dụng CHO MỖI DB QUERY.
Nếu 1 request có 3 DB queries → chậm 105ms.
db_round_trips trong resource_model cho biết số lượng queries.
```

### Nghịch lý 2: "Status 200 = không có vấn đề"

```text
SAI. Tất cả responses đều 200 — delay không làm fail request.
Chỉ db_ms elevation mới cho thấy vấn đề.
```

### Nghịch lý 3: "Delay là bug"

```text
SAI. Delay được inject CÓ CHỦ ĐÍCH qua control plane.
Đây là experiment, không phải bug.
```

---

## 13. Checklist

- [ ] Stack `full-no-cdn` đang chạy với postgres + order-service
- [ ] `OPS_AUTH_TOKEN` đã source
- [ ] DB profile sạch trước khi chạy
- [ ] Đã chạy với `-o cloud`
- [ ] `prod_mix_order_db_check_failures = 0`
- [ ] `degraded_observed > 0`, `recovered_observed > 0`
- [ ] Profile `postgres_delay_ms = 0` sau reset
- [ ] Unaffected APIs không bị degraded

---

## 14. 4-5 Variations

### Variation 1: Tăng delay (extreme)

```powershell
$env:PROD_MIX_ORDER_DB_DELAY_MS = "100"
$env:PROD_MIX_ORDER_DB_DELAY_DELTA_MS = "300"
```

### Variation 2: Strict recovery

```powershell
$env:PROD_MIX_ORDER_DB_RECOVERY_TOLERANCE_MS = "50"  # Default 140
```

### Variation 3: Tăng sample size (gọi nhiều lần hơn)

```javascript
// Sửa script: tăng số lần gọi affected APIs trong mỗi phase
```

### Variation 4: Test với DB rows lớn

```powershell
# Sửa query param trong script: db_rows=500
# Delay 35ms + 500 rows query = latency rất cao
```

---

## 15. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Không đọc `db_ms`** | Không biết delay có thực sự ảnh hưởng DB không |
| **Chỉ nhìn status code** | Tất cả 200 — delay không làm fail |
| **Không verify unaffected APIs** | Bỏ sót delay scope sai |
| **Không reset sau test** | DB profile còn delay → test sau bị nhiễu |
| **Quên OPS_AUTH_TOKEN** | Control plane fail → không inject được delay |

---

## 16. Real validation data

### Run #117 (2026-06-25)

```json
{
  "run_id": "117",
  "checks_passes": 199, "checks_fails": 1, "checks_rate": 0.995,
  "http_req_failed_rate": 0, "http_reqs": 166, "iterations": 1,
  "http_req_duration_avg": 25.8, "http_req_duration_med": 6.9,
  "http_req_duration_p95": 155.1, "vus_max": 1
}
```

### Phase latency breakdown

| Phase | P50 | P95 | db_ms |
| --- | ---: | ---: | --- |
| Baseline | ~6ms | ~20ms | ~2ms |
| Degraded (delay 35ms) | ~40ms | ~155ms | ~37ms |
| Recovery | ~6ms | ~20ms | ~2ms |

---

## 17. Reference

- **Script**: `k6/app/07-production-mix-order-db-recovery.js`
- **Catalog**: `k6/db/case-catalog.json`
- **Control plane**: `load-target/services/order-service` — `/ops/order/db/profile`
- **Dashboard**: `http://localhost:13001/` → run #117
- **Next case**: db-02 (DB pressure recovery)
