# db-04 — Order DB pool contention

> **Case ID:** `db-04-order-db-pool-contention`
> **Script:** `../app/23-order-service-db-pool-contention.js`
> **Profile:** `full-no-cdn`, `constant-vus`, requires `OPS_AUTH_TOKEN`
> **Proof:** Concurrent order requests contend for Postgres pool → trace correlation preserved → recovered success sau degrade window

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Một batch job đêm chạy reconciliation — 50 workers cùng query DB. Pool connection cạn kiệt. Request bắt đầu queue, một số timeout. Customer-facing API (vẫn đang phục vụ) bị ảnh hưởng vì dùng chung pool. Làm sao để:

- **Biết được** request nào bị delay do pool contention?
- **Trace được** correlation giữa business request và DB wait?
- **Xác nhận** service recover sau khi batch job hoàn thành?

Case này mô phỏng pool contention dưới sustained concurrent load.

### 1.2 Contention vs Pressure (db-02)

| Khía cạnh | db-02 (pressure) | db-04 (contention — case này) |
| --- | --- | --- |
| **Pattern** | Sequential, 1 VU | Concurrent, 8 VUs sustained |
| **Injection** | Pool pressure profile | Timed degrade/recover phases |
| **Trace** | Không | Có — `X-Trace-ID`, `X-Request-ID` |
| **Transient fail** | Không expected | Allowed (< 5%) |

---

## 2. Flow chính

```text
t=0s:  8 VUs bắt đầu constant-vus loop gọi confirm + webhook
t=5s:  Inject pool degradation (pool limit)
t=5-17s: Degraded phase — contention observable, transient 5xx allowed
t=17s: Reset pool profile
t=19s+: Recovery phase — success restored
```

---

## 3. Key signals

| Signal | Expected |
| --- | --- |
| `order_db_contention_check_failures` | 0 |
| `order_db_contention_trace_failures` | 0 |
| `order_db_contention_degraded_slow_observed` | > 0 |
| `order_db_contention_recovered_success` | > 0 |
| `http_req_failed` | < 5% (transient trong degrade window) |
| `X-Trace-ID` header | Preserved |
| `order_db_contention_duration` | Trend — show contention latency |

---

## 4. Pass/fail

```text
✅ contentionCheckFailures = 0
✅ traceFailures = 0 (trace correlation không mất)
✅ degradedSlowObserved > 0 (contention có thật)
✅ recoveredSuccess > 0 (recovery thành công)
✅ http_req_failed < 5%
```

---

## 5. Cách chạy

```powershell
$env:BASE_URL = "http://localhost:80"
$env:ORDER_DB_POOL_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_DB_CONTENTION_VUS = "8"
$env:ORDER_DB_CONTENTION_DURATION_SECONDS = "24"
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/23-order-service-db-pool-contention.js
```

---

## 6. Variations

- **Tăng VUs**: `ORDER_DB_CONTENTION_VUS=16` — more contention
- **Thay đổi degrade window**: `ORDER_DB_CONTENTION_DEGRADE_AT_SEC=10`, `RECOVER_AT_SEC=20`
- **Giảm pool limit**: Sửa script để set limit thấp hơn

---

## 7. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Không check trace correlation** | Không biết request nào bị contention |
| **Judge fail vì transient 5xx** | 5xx dưới 5% là expected |
| **Không verify recovered phase** | Không biết service có tự recover không |
