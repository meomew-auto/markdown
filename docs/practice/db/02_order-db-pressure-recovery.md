# db-02 — Order DB pressure recovery

> **Case ID:** `db-02-order-db-pressure-recovery`
> **Script:** `../app/08-production-mix-order-db-pressure-recovery.js`
> **Profile:** `full-no-cdn`, requires `OPS_AUTH_TOKEN`
> **Proof:** Postgres pool pressure injected → latency tăng, pool stats thay đổi → reset → recovery

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Black Friday. Lưu lượng order tăng 10x. Postgres connection pool bắt đầu bão hòa — mỗi connection bị giữ lâu hơn vì `db_writes` và `db_rows` cao. Application bắt đầu thấy latency tăng, một số request bị timeout. Team ops quyết định tăng pool size và optimize query. Nhưng làm sao để **test trước** rằng service có thể sống sót qua pool pressure và recover?

Case này mô phỏng: inject pool pressure (giới hạn connection, tăng hold time), verify degradation observable, rồi reset và verify recovery.

### 1.2 Pool pressure vs delay

| Khía cạnh | db-01 (delay) | db-02 (pressure — case này) |
| --- | --- | --- |
| **Injection** | `postgres_delay_ms` | `postgres_pressure_limit` + `postgres_pressure_hold_ms` |
| **Cơ chế** | Mỗi query chậm hơn N ms | Giới hạn số connection, giữ lâu hơn |
| **Triệu chứng** | Latency tăng đều | Latency spike, có thể timeout |
| **Pool stats** | Không thay đổi | `pressure` fields thay đổi |

---

## 2. DB capability được chứng minh

1. **Pool pressure injection**: `PUT /ops/order/db/profile` với `postgres_pressure_limit` và `postgres_pressure_hold_ms`.
2. **Mixed production flow chịu được pressure**: Cả affected và unaffected APIs được gọi trong degraded phase.
3. **Burst pattern**: Gửi burst N rounds, mỗi round gọi affected APIs + unaffected APIs.
4. **Recovery**: Sau reset, pool stats trở về 0, latency trở về baseline.

---

## 3. Flow chính

```text
Phase 1 — Baseline:
  1. GET /ops/order/db/profile → đọc pool stats baseline
  2. Gọi burst affected APIs (order_status, checkout, order_confirm, payment_webhook)
  3. Gọi unaffected APIs (products, cart, report)

Phase 2 — Pressure:
  4. PUT /ops/order/db/profile { postgres_pressure_limit: 1, postgres_pressure_hold_ms: 180, postgres_pressure_waits_min: 2 }
  5. Burst 3 rounds affected + unaffected APIs
     → Expect: pool pressure observable, latency tăng

Phase 3 — Recovery:
  6. POST /ops/order/db/reset
  7. Burst affected APIs
     → Expect: latency giảm, pool pressure = 0
```

---

## 4. Key signals

| Signal | Expected |
| --- | --- |
| `prod_mix_order_db_pressure_check_failures` | 0 |
| `prod_mix_order_db_pressure_degraded_observed` | > 0 |
| `prod_mix_order_db_pressure_recovered_observed` | > 0 |
| Pool `postgres_pressure_limit` | Non-zero trong degraded phase |
| Pool `postgres_pressure_hold_ms` | Non-zero trong degraded phase |
| Pool stats sau reset | 0 (sạch) |

---

## 5. Pass/fail criteria

```text
✅ prod_mix_order_db_pressure_check_failures = 0
✅ Degraded phase: degradedObserved > 0
✅ Recovery phase: recoveredObserved > 0
✅ Pool stats pressure = 0 sau reset
✅ Unaffected APIs không bị ảnh hưởng quá mức
```

---

## 6. Cách chạy

```powershell
$env:BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_PRESSURE_CONTROL_BASE_URL = "http://localhost:80"
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN

k6 run E:/Projects/k6/k6-metrics-server/load-target/k6/app/08-production-mix-order-db-pressure-recovery.js
```

---

## 7. Variations

- **Tăng pressure**: `PROD_MIX_ORDER_DB_PRESSURE_LIMIT=0` (cực đoan — 0 connections)
- **Tăng burst rounds**: `PROD_MIX_ORDER_DB_PRESSURE_BURST_ROUNDS=6`
- **Tăng hold time**: `PROD_MIX_ORDER_DB_PRESSURE_HOLD_MS=500`
