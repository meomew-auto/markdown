# db-03 — Order DB fault and recovery

> **Case ID:** `db-03-order-db-fault-recovery`
> **Script:** `../app/10-production-mix-order-db-fault-recovery.js`
> **Profile:** `full-no-cdn`, requires `OPS_AUTH_TOKEN`
> **Workload:** 1 VU, 1 iteration (sequential)
> **Proof:** DB fault mode (`tcp_reset` hoặc `dns_fail`) injected → affected APIs trả về 5xx **có chủ đích** → unaffected APIs vẫn 200 → reset → tất cả recovered về 200. **5xx là expected — không judge fail bằng `http_req_failed`.**

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [DB capability được chứng minh](#2-db-capability-được-chứng-minh)
3. [Vì sao phải test ở DB layer](#3-vì-sao-phải-test-ở-db-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Service mechanism deep-dive: DB fault mode và fail contract](#6-service-mechanism-deep-dive-db-fault-mode-và-fail-contract)
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

### 1.1 Bối cảnh

3:00 AM. Hệ thống monitoring báo: "Postgres không phản hồi — connection timeout". Order service bắt đầu trả về 502/503. Team on-call được page.

Câu hỏi quan trọng: **Order service có thực sự fail đúng cách khi DB chết không?** Nếu service nuốt lỗi và trả về 200 với data rỗng, hệ thống payment có thể charge khách hàng mà không có order trong DB. Đây là catastrophic failure.

Ngược lại, nếu service fail với 5xx rõ ràng, load balancer có thể route sang instance khác, circuit breaker có thể mở, và team được alert đúng cách.

### 1.2 Hai fault mode

```text
dns_fail:   DB hostname không resolve được
            → Connection error ngay lập tức
            → 5xx response

tcp_reset:  DB connection bị reset (giống như DB crash)
            → Query đang chạy bị abort
            → 5xx response
```

### 1.3 Tại sao 5xx là TỐT trong case này?

```text
┌──────────────────────────────────────────────────────┐
│ FAULT WINDOW (có chủ đích)                           │
│                                                      │
│  5xx từ affected APIs  = ĐÚNG ← service bảo vệ data │
│  200 từ unaffected APIs = ĐÚNG ← isolation đúng      │
│                                                      │
│  Nếu affected APIs trả 200 trong fault window:       │
│    → Service NUỐT lỗi → catastrophic                │
│    → Data integrity bị vi phạm                       │
└──────────────────────────────────────────────────────┘
```

---

## 2. DB capability được chứng minh

### 2.1 Phát biểu capability

> **Khi DB bị fault (tcp_reset/dns_fail), order service fail đúng contract — affected APIs trả về 5xx, unaffected APIs vẫn 200. Sau khi reset DB profile, tất cả APIs trở về 200. Fault mode được clear hoàn toàn.**

### 2.2 Fail contract

| API | Fault window | Recovery |
| --- | --- | --- |
| `GET /api/sim/orders/:id` | **5xx** (expected) | 200 |
| `POST /api/sim/checkout` | **5xx** (expected) | 200 |
| `POST /api/sim/orders/:id/confirm` | **5xx** (expected) | 200 |
| `POST /api/sim/orders/webhooks/payment` | **5xx** (expected) | 200 |
| `GET /api/sim/products` | 200 (unaffected) | 200 |
| `GET /api/sim/report` | 200 (unaffected) | 200 |

### 2.3 Payment-sensitive protection

Script đặc biệt chú ý **payment-sensitive APIs** (`checkout`, `order_confirm`): trong fault window, các API này **phải fail** để tránh tạo order/charge mà không có DB record.

---

## 3. Vì sao phải test ở DB layer

Chỉ DB layer mới có:
- **Control plane** để inject fault mode (`postgres_fault_mode`)
- **Fail contract verification**: 5xx expected vs 5xx bug — khác biệt nằm ở script expectations
- **Scope verification**: Affected vs unaffected APIs
- **Recovery verification**: Reset → tất cả 200

---

## 4. Topology

```text
Script: ../app/10-production-mix-order-db-fault-recovery.js
Executor: 1 VU, 1 iteration (sequential)
Topology: full-no-cdn
Requires: OPS_AUTH_TOKEN
Fault mode: tcp_reset (default) hoặc dns_fail
```

---

## 5. Script deep-dive

```javascript
const FAULT_MODE = envString('PROD_MIX_ORDER_DB_FAULT_MODE', 'dns_fail');
// Chỉ chấp nhận: 'dns_fail', 'tcp_reset'

const affectedApis = new Set(['order_status', 'checkout', 'order_confirm', 'payment_webhook']);
const paymentSensitiveApis = new Set(['checkout', 'order_confirm']);
// Payment-sensitive APIs PHẢI fail trong fault window

// Custom counters
const faultCheckFailures = new Counter('prod_mix_order_db_fault_check_failures');
const degradedObserved = new Rate('prod_mix_order_db_fault_degraded_observed');
const recoveredObserved = new Rate('prod_mix_order_db_fault_recovered_observed');
```

---

## 6. Mechanism deep-dive

### 6.1 Fault injection

```text
PUT /ops/order/db/profile
  Body: { "postgres_fault_mode": "tcp_reset" }
  → Order service cấu hình DB driver để reset connection
  → Mọi query sau đó sẽ fail với "connection reset"
  → Response: { success: true, data: { postgres_fault_mode: "tcp_reset" } }
```

### 6.2 Fail contract logic

```text
Script KHÔNG dùng http_req_failed để judge.
Thay vào đó, script check:
  - Trong fault window: affected APIs có status 5xx → ĐÚNG
  - Trong fault window: unaffected APIs có status 200 → ĐÚNG
  - Sau recovery: TẤT CẢ APIs có status 200 → ĐÚNG

faultCheckFailures chỉ tính:
  - Affected API trả 200 trong fault window → FAIL (sai contract)
  - Unaffected API trả 5xx trong fault window → FAIL (sai scope)
  - Bất kỳ API nào trả 5xx sau recovery → FAIL (chưa recover)
```

---

## 7. Request sequence flow

```text
Phase 1 — Baseline (~20 requests):
  Verify tất cả 200, fault_mode empty

Phase 2 — Fault (~80 requests):
  PUT /ops/order/db/profile { fault_mode: "tcp_reset" }
  → Affected APIs → expect 5xx ✓
  → Unaffected APIs → expect 200 ✓
  → Payment-sensitive APIs → expect 5xx ✓ (bảo vệ data)

Phase 3 — Recovery (~60 requests):
  POST /ops/order/db/reset
  → Tất cả APIs → expect 200 ✓
  → Verify fault_mode empty
```

---

## 8. Key signals

| Signal | Fault window | Recovery |
| --- | --- | --- |
| Affected APIs status | **5xx** (expected!) | 200 |
| Unaffected APIs status | 200 | 200 |
| `postgres_fault_mode` | `tcp_reset` | empty |
| `prod_mix_order_db_fault_check_failures` | 0 | 0 |
| `degraded_observed` | > 0 | 0 |
| `recovered_observed` | 0 | > 0 |

---

## 9. Pass/fail criteria

```text
✅ faultCheckFailures = 0
✅ Fault window: affected APIs = 5xx (KHÔNG tính là fail)
✅ Fault window: unaffected APIs = 200
✅ Fault window: payment-sensitive APIs = 5xx
✅ Recovery: TẤT CẢ = 200
✅ Profile fault_mode empty sau reset
❌ KHÔNG judge bằng http_req_failed — nó PHẢI > 0 trong fault window
```

---

## 10. Cách chạy + output mẫu

```powershell
$env:BASE_URL = "http://localhost:80"
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
$env:PROD_MIX_ORDER_DB_FAULT_CONTROL_BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_FAULT_MODE = "tcp_reset"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/10-production-mix-order-db-fault-recovery.js
```

### Output mẫu (Run #119)

```text
checks_total.......: 224
checks_succeeded...: 100% 224 out of 224
http_req_failed....: 4.8% (8/166) ← EXPECTED trong fault window!
prod_mix_order_db_fault_check_failures: 0
```

---

## 11. 4 output → decision scenarios

### Scenario A: Fault window có 5xx, recovery có 200

```text
→ Hoàn hảo. Service fail đúng contract và recover đúng cách.
```

### Scenario B: Fault window KHÔNG có 5xx (tất cả 200)

```text
→ Service NUỐT lỗi — catastrophic.
→ DB fault mode không được áp dụng hoặc service ignore fault.
→ Kiểm tra version order-service.
```

### Scenario C: Unaffected APIs cũng 5xx

```text
→ Fault scope sai — ảnh hưởng toàn bộ service thay vì chỉ order-service DB.
→ DB fault mode được áp dụng ở wrong level.
```

### Scenario D: Sau recovery vẫn 5xx

```text
→ Reset không hoạt động.
→ Cần restart order-service.
→ Hoặc DB thật sự có vấn đề (không phải injected).
```

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "http_req_failed > 0 = bug"

```text
SAI. Trong case này, http_req_failed > 0 là PROOF fault mode hoạt động.
4.8% fail rate trong run #119 là bằng chứng service bảo vệ data đúng cách.
```

### Nghịch lý 2: "Service luôn phải trả 200"

```text
SAI. Service PHẢI trả 5xx khi dependency không hoạt động.
Trả 200 khi DB chết = data corruption risk.
```

---

## 13. Checklist

- [ ] `OPS_AUTH_TOKEN` đã source
- [ ] DB profile sạch trước test
- [ ] Fault window: affected = 5xx, unaffected = 200
- [ ] Recovery: tất cả = 200
- [ ] `faultCheckFailures = 0`
- [ ] Đã reset sau test

---

## 14. Variations

- `PROD_MIX_ORDER_DB_FAULT_MODE=dns_fail` — test DNS failure
- `PROD_MIX_ORDER_DB_FAULT_RECOVERY_TOLERANCE_MS=100` — strict recovery timing

---

## 15. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Judge fail vì `http_req_failed > 0`** | Bỏ lỡ evidence fault mode hoạt động |
| **Không reset sau test** | Mọi test sau fail vì DB còn fault |
| **Không verify unaffected APIs** | Không biết fault scope |

---

## 16. Real validation data

### Run #119 (2026-06-25)

```json
{
  "run_id": "119",
  "checks_passes": 224, "checks_fails": 0, "checks_rate": 1.0,
  "http_req_failed_rate": 0.048, "http_reqs": 166, "iterations": 1,
  "http_req_duration_avg": 16.3, "http_req_duration_med": 7.1,
  "http_req_duration_p95": 51.8
}
```

---

## 17. Reference

- **Script**: `k6/app/10-production-mix-order-db-fault-recovery.js`
- **Catalog**: `k6/db/case-catalog.json`
- **Dashboard**: `http://localhost:13001/` → run #119
- **Next case**: db-04 (DB pool contention)
