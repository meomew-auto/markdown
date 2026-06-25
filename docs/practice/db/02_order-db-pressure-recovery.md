# db-02 — Order DB pressure recovery

> **Case ID:** `db-02-order-db-pressure-recovery`
> **Script:** `../app/08-production-mix-order-db-pressure-recovery.js`
> **Profile:** `full-no-cdn`, requires `OPS_AUTH_TOKEN`
> **Workload:** 1 VU, 1 iteration (sequential)
> **Proof:** Postgres connection pool bị ép (limit + hold time) → latency spike, pool stats thay đổi → reset → recovery. DB pressure observable và recoverable.

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [DB capability được chứng minh](#2-db-capability-được-chứng-minh)
3. [Vì sao phải test ở DB layer](#3-vì-sao-phải-test-ở-db-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Service mechanism deep-dive: Pool pressure và connection contention](#6-service-mechanism-deep-dive-pool-pressure-và-connection-contention)
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

Black Friday. Lưu lượng order tăng 10x. Postgres connection pool bắt đầu bão hòa — mỗi connection bị giữ lâu hơn vì `db_writes` và `db_rows` cao. Application thấy latency tăng đột biến, một số request bị timeout vì không có connection available.

Đây là **pool exhaustion pattern** — khác với delay (db-01) ở chỗ:
- Delay: mỗi query đều chậm hơn N ms (đều, predictable)
- Pressure: pool cạn → request phải **chờ** connection → spike không đều, có thể timeout

### 1.2 Pool pressure vs DB delay

| Khía cạnh | db-01 (delay) | db-02 (pressure — case này) |
| --- | --- | --- |
| **Injection** | `postgres_delay_ms` | `postgres_pressure_limit` + `postgres_pressure_hold_ms` |
| **Cơ chế** | Mỗi query +N ms | Giới hạn connection, giữ lâu hơn |
| **Triệu chứng** | Latency tăng đều | Latency spike, có thể timeout |
| **Pool stats** | Không thay đổi | `pressure` fields thay đổi |
| **Recovery** | Tức thì sau reset | Cần thời gian drain queue |

### 1.3 Burst pattern

Script dùng **burst pattern**: gửi N rounds, mỗi round gọi tất cả affected + unaffected APIs. Điều này mô phỏng chính xác traffic pattern trong production: từng đợt request đến, không phải đều đặn.

---

## 2. DB capability được chứng minh

### 2.1 Phát biểu capability

> **Khi Postgres pool bị ép (giới hạn connection, tăng hold time), service vẫn hoạt động nhưng latency tăng đáng kể. Pool stats phản ánh chính xác trạng thái pressure. Unaffected APIs không bị ảnh hưởng. Sau khi reset, pool trở về bình thường và latency recovered.**

### 2.2 Các khía cạnh được verify

1. **Pressure injection**: `PUT /ops/order/db/profile` với `postgres_pressure_limit=1`, `postgres_pressure_hold_ms=180`, `postgres_pressure_waits_min=2`.
2. **Burst handling**: Service xử lý burst N rounds mà không crash.
3. **Pool stats observable**: `postgres_pressure_limit`, `postgres_pressure_hold_ms` visible trong profile.
4. **Recovery**: Sau reset, pool stats = 0, latency trở về baseline.

---

## 3. Vì sao phải test ở DB layer

Chỉ DB layer có:
- **Control plane** để set pool pressure parameters
- **Pool stats** visibility qua `/ops/order/db/profile`
- **Burst pattern** để mô phỏng realistic traffic dưới pressure

---

## 4. Topology

```text
Script: ../app/08-production-mix-order-db-pressure-recovery.js
Executor: 1 VU, 1 iteration (sequential)
Topology: full-no-cdn
Requires: OPS_AUTH_TOKEN
Env knobs: PRESSURE_LIMIT, PRESSURE_HOLD_MS, PRESSURE_WAITS_MIN, BURST_ROUNDS
```

---

## 5. Script deep-dive

```javascript
const burstApis = [
  { name: 'order_status',  method: 'GET',  path: '/api/sim/orders/ORD-123?cpu_ms=20&db_rows=60' },
  { name: 'order_status',  method: 'GET',  path: '/api/sim/orders/ORD-456?cpu_ms=20&db_rows=60' },
  { name: 'checkout',      method: 'POST', path: '/api/sim/checkout?cpu_ms=40&db_writes=6&disk_kb=20&external_ms=40' },
  { name: 'order_confirm', method: 'POST', path: '/api/sim/orders/.../confirm?db_writes=4&external_ms=40' },
  { name: 'payment_webhook', method: 'POST', path: '/api/sim/orders/webhooks/payment?db_writes=4' },
];

// Custom counters
const pressureCheckFailures = new Counter('prod_mix_order_db_pressure_check_failures');
const degradedObserved = new Rate('prod_mix_order_db_pressure_degraded_observed');
const recoveredObserved = new Rate('prod_mix_order_db_pressure_recovered_observed');
```

---

## 6. Mechanism deep-dive

### 6.1 Pool pressure parameters

```text
postgres_pressure_limit:   Số connection tối đa (1 = cực kỳ hạn chế)
postgres_pressure_hold_ms: Thời gian giữ connection (180ms)
postgres_pressure_waits_min: Số lần request phải chờ connection ít nhất
```

Với `limit=1, hold=180ms`:
- Chỉ 1 connection available cho tất cả request
- Mỗi request giữ connection 180ms
- Request thứ 2 phải chờ ít nhất 180ms

### 6.2 Burst impact

```text
Burst 3 rounds, mỗi round 10 requests:
  Round 1: 10 requests cạnh tranh 1 connection
  Round 2: Queue từ round 1 chưa xong → thêm 10 requests
  Round 3: Queue tích lũy → latency spike nghiêm trọng

p95 latency: 3170ms (run #118) — 63x so với baseline ~50ms
```

---

## 7. Request sequence flow

```text
Phase 1 — Baseline:
  GET /ops/order/db/profile → verify pressure_limit=0
  Burst 1 round affected + unaffected APIs

Phase 2 — Pressure:
  PUT /ops/order/db/profile { pressure_limit:1, hold_ms:180, waits_min:2 }
  Burst 3 rounds affected + unaffected APIs
  → pool stats show pressure > 0

Phase 3 — Recovery:
  POST /ops/order/db/reset
  Burst 1 round → latency recovered
```

---

## 8. Key signals

| Signal | Phase | Expected |
| --- | --- | --- |
| `pressure_check_failures` | All | 0 |
| `degraded_observed` | Pressure | > 0 |
| `recovered_observed` | Recovery | > 0 |
| Pool `postgres_pressure_limit` | Pressure | 1 |
| Pool `postgres_pressure_hold_ms` | Pressure | 180 |
| Pool stats | Recovery | All 0 |
| `http_req_duration` p95 | Pressure | >> baseline (3170ms observed) |

---

## 9. Pass/fail

```text
✅ pressureCheckFailures = 0
✅ degradedObserved > 0
✅ recoveredObserved > 0
✅ Pool pressure = 0 sau reset
✅ Unaffected APIs không degraded quá mức
```

---

## 10. Cách chạy + output mẫu

```powershell
$env:BASE_URL = "http://localhost:80"
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
$env:PROD_MIX_ORDER_DB_PRESSURE_CONTROL_BASE_URL = "http://localhost:80"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/08-production-mix-order-db-pressure-recovery.js
```

### Output mẫu (Run #118)

```text
checks_total.......: 236
checks_succeeded...: 100% 236 out of 236
pressure_check_failures: 0
http_req_duration..: avg=342.6ms med=9.4ms p95=3170.3ms
                                     ↑        ↑
                            bimodal rõ       pressure spike!
```

---

## 11. 4 output → decision scenarios

### Scenario A: p95 spike trong pressure, recovered sau reset

```text
→ Hoàn hảo. Service chịu được pressure và recover.
```

### Scenario B: Không có latency spike

```text
→ Pressure không được áp dụng.
→ Pool limit có thể quá cao hoặc service dùng connection pool riêng.
```

### Scenario C: Request timeout (không recover được)

```text
→ Pool limit quá thấp + hold time quá dài.
→ Service không handle được extreme pressure.
→ Cần tăng pool size hoặc thêm circuit breaker.
```

---

## 12. Nghịch lý

### "avg=342ms, med=9.4ms — chênh lệch khủng"

```text
ĐÚNG. Đây là bimodal: P50 (baseline requests) vẫn 9ms,
nhưng P95 (pressure requests) lên tới 3170ms.
avg bị kéo lên bởi extreme tail latency.
```

---

## 13. Checklist

- [ ] `OPS_AUTH_TOKEN` đã source
- [ ] DB profile sạch
- [ ] `pressureCheckFailures = 0`
- [ ] `degradedObserved > 0`, `recoveredObserved > 0`
- [ ] Đã reset sau test

---

## 14. Variations

- `PROD_MIX_ORDER_DB_PRESSURE_LIMIT=0` — extreme (0 connections)
- `PROD_MIX_ORDER_DB_PRESSURE_HOLD_MS=500` — giữ connection lâu hơn
- `PROD_MIX_ORDER_DB_PRESSURE_BURST_ROUNDS=6` — nhiều burst hơn

---

## 15. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Dùng avg latency để judge** | Che giấu P95 spike |
| **Không reset sau test** | Pool còn pressure → test sau fail |
| **Không check unaffected APIs** | Bỏ sót pressure scope sai |

---

## 16. Real validation data

### Run #118 (2026-06-25)

```json
{
  "run_id": "118",
  "checks_passes": 236, "checks_fails": 0, "checks_rate": 1.0,
  "http_req_failed_rate": 0, "http_reqs": 134, "iterations": 1,
  "http_req_duration_avg": 342.6, "http_req_duration_med": 9.4,
  "http_req_duration_p95": 3170.3
}
```

p95 = 3170ms là bằng chứng pool pressure hoạt động.

---

## 17. Reference

- **Script**: `k6/app/08-production-mix-order-db-pressure-recovery.js`
- **Catalog**: `k6/db/case-catalog.json`
- **Dashboard**: `http://localhost:13001/` → run #118
- **Next case**: db-03 (DB fault recovery)
