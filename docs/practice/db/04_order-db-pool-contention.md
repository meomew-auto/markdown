# db-04 — Order DB pool contention

> **Case ID:** `db-04-order-db-pool-contention`
> **Script:** `../app/23-order-service-db-pool-contention.js`
> **Profile:** `full-no-cdn`, `constant-vus`, requires `OPS_AUTH_TOKEN`
> **Workload:** 8 VUs sustained 24s, timed degrade/recover phases
> **Proof:** Concurrent order requests contend for Postgres pool → trace correlation preserved → degraded phase observable → recovered success sau khi reset profile

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Một batch job đêm chạy reconciliation — 50 workers cùng query DB. Pool connection cạn kiệt. Request bắt đầu queue, một số timeout. Customer-facing API (vẫn đang phục vụ) bị ảnh hưởng vì dùng chung pool.

Làm sao để:
- **Biết được** request nào bị delay do pool contention?
- **Trace được** correlation giữa business request và DB wait?
- **Xác nhận** service recover sau khi batch job hoàn thành?

### 1.2 Contention vs Pressure (db-02)

| Khía cạnh | db-02 (pressure) | db-04 (contention — case này) |
| --- | --- | --- |
| **Pattern** | Sequential, 1 VU | **Concurrent, 8 VUs sustained 24s** |
| **Injection** | Pool pressure profile | Timed degrade/recover phases |
| **Trace** | Không | **Có — `X-Trace-ID`, `X-Request-ID`** |
| **Transient fail** | Không expected | **Allowed (< 5%)** |
| **Duration** | ~30s | **24 seconds sustained** |

---

## 2. DB capability được chứng minh

1. **Sustained concurrent load**: 8 VUs chạy constant-vus loop gọi confirm + webhook liên tục.
2. **Timed degradation**: t=5s inject pool degradation, t=17s reset, t=19s+ verify recovery.
3. **Trace correlation**: `X-Trace-ID` và `X-Request-ID` preserved xuyên suốt — không mất trace dù contention.
4. **Transient failure tolerance**: < 5% http_req_failed allowed trong degrade window.
5. **Recovery proof**: `contentionRecoveredSuccess > 0` sau recover.

---

## 3. Vì sao phải test ở DB layer

Chỉ DB layer mới có:
- **Timed phase transitions**: Degrade lúc 5s, recover lúc 17s — test realistic timeline
- **Trace preservation verification**: Contention không được làm mất trace headers
- **Sustained load**: 24s constant traffic — không phải sequential 1-VU experiment

---

## 4. Topology

```text
Script: ../app/23-order-service-db-pool-contention.js
Executor: constant-vus, 8 VUs, 24s duration
Topology: full-no-cdn
Requires: OPS_AUTH_TOKEN
noConnectionReuse: true (mỗi request mở connection mới)
```

---

## 5. Script deep-dive

```javascript
export const options = {
  noConnectionReuse: true,
  scenarios: {
    db_contention: {
      executor: 'constant-vus',
      vus: VUS,                  // 8
      duration: `${DURATION_SECONDS}s`, // 24s
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: [`rate<${MAX_HTTP_FAIL_RATE}`], // < 5%
  },
};

// Timeline:
// t=0-5s:    Normal operation
// t=5s:      Inject pool degradation
// t=5-17s:   Degraded phase (contention observable)
// t=17s:     Reset pool profile
// t=19s+:    Recovery phase (success restored)

// Custom counters:
const contentionFailures = new Counter('order_db_contention_check_failures');
const contentionTraceFailures = new Counter('order_db_contention_trace_failures');
const contentionDegradedSlow = new Counter('order_db_contention_degraded_slow_observed');
const contentionRecoveredSuccess = new Counter('order_db_contention_recovered_success');
```

---

## 6. Mechanism deep-dive

### 6.1 Timed phase transitions

```text
Timeline (24 seconds):
  0s ──────────────────────────────────────────────── 24s
  │          │                    │          │
  │ startup  │ DEGRADED PHASE     │ recover  │ RECOVERED
  │ grace    │ (pool contention)  │ transition│ PHASE
  │          │                    │          │
  0s        5s                   17s       19s       24s

Phase behavior:
  Startup (0-5s):    Allowed transient failures (cold start)
  Degraded (5-17s):  Contention observable, slow requests expected
  Recovery (19-24s): Success restored, recovered_success counter active
```

### 6.2 Trace correlation

```text
Mỗi request có headers:
  X-Trace-ID:      Trace identifier — preserved across retries
  X-Request-ID:    Unique per request
  X-Correlation-ID: Links related requests

Script verify: sau mỗi request, response chứa lại các headers này.
Nếu mất → traceFailures++.
```

---

## 7. Request sequence flow

```text
8 VUs chạy loop liên tục trong 24s:

  Mỗi iteration:
    1. POST /api/sim/orders/{orderId}/confirm?db_writes={3-6}
       Header: Idempotency-Key, X-Trace-ID, X-Request-ID
       → verify: success hoặc transient 5xx (trong degrade window)

    2. POST /api/sim/orders/webhooks/payment?db_writes={3-6}
       Header: X-Trace-ID, X-Request-ID
       → verify: success hoặc transient 5xx

    sleep(0.05s)

  Tổng: ~505 iterations, ~512 HTTP requests trong 24s
```

---

## 8. Key signals

| Signal | Expected |
| --- | --- |
| `order_db_contention_check_failures` | 0 |
| `order_db_contention_trace_failures` | 0 |
| `order_db_contention_degraded_slow_observed` | > 0 |
| `order_db_contention_recovered_success` | > 0 |
| `http_req_failed` | < 5% |
| `Trace headers` | Preserved |
| `order_db_contention_duration` | Trend — show contention latency |

---

## 9. Pass/fail

```text
✅ contentionCheckFailures = 0
✅ traceFailures = 0 (trace correlation preserved)
✅ degradedSlowObserved > 0 (contention có thật)
✅ recoveredSuccess > 0 (recovery thành công)
✅ http_req_failed < 5%
```

---

## 10. Cách chạy + output

```powershell
$env:BASE_URL = "http://localhost:80"
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
$env:ORDER_DB_POOL_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_DB_CONTENTION_VUS = "8"
$env:ORDER_DB_CONTENTION_DURATION_SECONDS = "24"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/23-order-service-db-pool-contention.js
```

### Output mẫu (Run #120)

```text
checks_total.......: 3584
checks_succeeded...: 100% 3584 out of 3584
http_req_failed....: 0% 0 out of 512
http_req_duration..: avg=21.5ms med=24.5ms p95=50.8ms
```

---

## 11. 4 output → decision scenarios

### Scenario A: Contention observable, recovered, trace preserved

```text
→ Service handle contention đúng cách. Trace không bị mất.
```

### Scenario B: `traceFailures > 0`

```text
→ Trace headers bị mất trong contention → không debug được production issue.
→ BE cần preserve headers ngay cả khi request fail.
```

### Scenario C: `http_req_failed > 5%`

```text
→ Quá nhiều failure — contention quá nặng hoặc pool limit quá thấp.
→ Cần điều chỉnh degrade window timing hoặc pool parameters.
```

---

## 12. Nghịch lý

### "8 VUs không thể tạo ra contention thực sự"

```text
SAI. Với pool limit=1 và noConnectionReuse=true,
8 VUs cạnh tranh 1 connection là đủ để tạo contention nghiêm trọng.
```

---

## 13. Checklist

- [ ] `OPS_AUTH_TOKEN` đã source
- [ ] `contentionCheckFailures = 0`
- [ ] `traceFailures = 0`
- [ ] `degradedSlowObserved > 0`
- [ ] `recoveredSuccess > 0`
- [ ] `http_req_failed < 5%`

---

## 14. Variations

- `ORDER_DB_CONTENTION_VUS=16` — tăng contention
- `ORDER_DB_CONTENTION_DEGRADE_AT_SEC=10` — delay degradation
- `ORDER_DB_CONTENTION_CONFIRM_DB_WRITES=8` — tăng DB writes mỗi confirm

---

## 15. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Không check trace correlation** | Không biết request nào bị contention |
| **Judge fail vì transient 5xx** | 5xx < 5% là expected |
| **Không verify recovered phase** | Không biết service có tự recover không |

---

## 16. Real validation data

### Run #120 (2026-06-25)

```json
{
  "run_id": "120",
  "checks_passes": 3584, "checks_fails": 0, "checks_rate": 1.0,
  "http_req_failed_rate": 0, "http_reqs": 512, "iterations": 505,
  "http_req_duration_avg": 21.5, "http_req_duration_med": 24.5,
  "http_req_duration_p95": 50.8, "vus_max": 8
}
```

---

## 17. Reference

- **Script**: `k6/app/23-order-service-db-pool-contention.js`
- **Catalog**: `k6/db/case-catalog.json`
- **Dashboard**: `http://localhost:13001/` → run #120
- **Next case**: db-06 (capacity sweep)
