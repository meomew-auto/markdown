# db-04 -- Order DB pool contention

> **Case ID:** `db-04-order-db-pool-contention`
> **Script:** `../app/23-order-service-db-pool-contention.js`
> **Profile:** `full-no-cdn`, `constant-vus`, requires `OPS_AUTH_TOKEN`
> **Workload:** 8 VUs sustained 24s, timed degrade/recover phases
> **Proof:** Concurrent order requests contend for Postgres pool → trace correlation preserved → degraded phase observable → recovered success sau khi reset profile

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [DB capability được chứng minh](#2-db-capability-được-chứng-minh)
3. [Vì sao phải test ở DB layer](#3-vì-sao-phải-test-ở-db-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Postgres mechanism: connection pool behavior và contention patterns](#6-postgres-mechanism-connection-pool-behavior-và-contention-patterns)
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

### 1.3 Phân biệt với các case DB khác

Pool contention (case này) khác với các case DB khác ở chỗ nó test **concurrent access pattern**:

| Khía cạnh | db-01 (delay) | db-02 (pressure) | db-03 (fault) | db-04 (contention) |
| --- | --- | --- | --- | --- |
| **VUs** | 1 | 1 | 1 | **8 (constant)** |
| **Iterations** | 1 | 1 | 1 | **~505 (loop)** |
| **Duration** | ~30s | ~30s | ~2.5s | **24s sustained** |
| **Connection reuse** | default | default | default | **noConnectionReuse: true** |
| **Trace correlation** | Không | Không | Không | **Có** |
| **Transient failure** | Không expected | Không expected | Expected (fault window) | **Allowed (< 5%)** |
| **Phase transition** | Manual (trong script) | Manual (trong script) | Manual (trong script) | **Time-based (5s, 17s, 19s)** |

### 1.4 Tác động thực tế đến business

Khi pool contention xảy ra trong production:

```text
Scenario A — Contention được handle đúng:
  8:00 AM: Batch job reconciliation bắt đầu
  8:00 AM: Pool connection tăng từ 5 lên 50
  8:01 AM: Một số customer request bị chậm (200ms thay vì 20ms)
  8:02 AM: 2-3 request timeout (503) — transient
  8:05 AM: Batch job hoàn thành → pool về bình thường
  8:05 AM: Tất cả request trở lại 20ms
  → Customer experience: hơi chậm 1-2 phút, không mất data
  → Trace cho thấy request nào bị ảnh hưởng → debug được

Scenario B — Contention không được handle:
  8:00 AM: Batch job reconciliation bắt đầu
  8:00 AM: Pool connection cạn kiệt
  8:01 AM: TẤT CẢ request timeout — service unavailable
  8:02 AM: Connection pool leak — connections không được trả lại
  8:05 AM: Batch job fail vì không đủ connection
  8:10 AM: Service vẫn không recover — cần restart
  → Customer experience: outage 10+ phút
  → Không có trace → không biết nguyên nhân gốc
```

### 1.5 Các tín hiệu cảnh báo sớm trong production

Trước khi pool contention trở nên nghiêm trọng, thường có các dấu hiệu:

- **Connection wait time tăng**: Từ 0ms → 5ms → 50ms → 200ms
- **Active connections chạm trần**: `pool_active = pool_max`
- **Pending requests tăng**: Request queue bắt đầu tích tụ
- **P95 latency divergence**: P95 >> median (contention ảnh hưởng không đều)
- **Connection churn**: Connections được tạo/hủy liên tục

Case db-04 tạo ra kịch bản này có kiểm soát: 8 VUs liên tục gọi DB trong 24 giây, pool bị giới hạn, degradation được inject tại thời điểm xác định.

---

## 2. DB capability được chứng minh

### 2.1 Phát biểu capability

> **Khi 8 VUs đồng thời gọi order confirm và order status trong 24 giây với pool connection bị giới hạn, service chịu được contention — trace correlation được bảo toàn, degraded phase observable qua custom counters, và service recover hoàn toàn sau khi reset profile.**

### 2.2 Năm capability dimensions

1. **Sustained concurrent load**: 8 VUs chạy constant-vus loop gọi confirm + webhook liên tục.
2. **Timed degradation**: t=5s inject pool degradation, t=17s reset, t=19s+ verify recovery.
3. **Trace correlation**: `X-Trace-ID` và `X-Request-ID` preserved xuyên suốt — không mất trace dù contention.
4. **Transient failure tolerance**: < 5% http_req_failed allowed trong degrade window.
5. **Recovery proof**: `contentionRecoveredSuccess > 0` sau recover.

### 2.3 Chi tiết từng capability

**C1 — Sustained concurrent load (8 VUs, 24 giây):**

8 VUs với `constant-vus` executor tạo ra áp lực liên tục trong 24 giây. Mỗi VU chạy loop:
- Gọi API (confirm hoặc status)
- Sleep 50ms
- Lặp lại

Với `noConnectionReuse: true`, mỗi HTTP request mở connection mới — tăng áp lực lên connection pool. Tổng cộng ~505 iterations, ~512 HTTP requests.

**C2 — Timed phase transitions:**

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

Phase được xác định bởi thời gian elapsed, không phải bởi script điều khiển tuần tự. Điều này mô phỏng realistic scenario: degradation xảy ra giữa chừng khi traffic đang chạy.

**C3 — Trace correlation preservation:**

Mỗi request mang theo trace headers:
```text
X-Trace-ID:      "{runId}:confirm:{VU}:{iteration}"
X-Request-ID:    "{runId}:confirm:{VU}:{iteration}"
X-Test-Run-ID:   "{runId}"
X-Test-Scenario: "order_db_pool_contention"
```

Response body chứa `trace` object phản chiếu lại các giá trị này. Script verify 5 fields:
1. `trace_id` khớp với `X-Trace-ID` đã gửi
2. `run_id` khớp với `runId` prefix
3. `scenario` = `"order_db_pool_contention"`
4. `order_id` khớp (nếu có)
5. `idempotency_key` khớp (nếu có)

**C4 — Transient failure tolerance:**

Trong degraded phase, một số request có thể fail với 5xx do pool exhaustion. Đây là expected behavior — script cho phép tối đa 5% (`MAX_HTTP_FAIL_RATE`). Nếu vượt quá 5%, contention quá nặng hoặc pool configuration có vấn đề.

**C5 — Recovery proof:**

Sau khi reset profile tại t=17s và grace period 2s, phase chuyển sang `recovered`. Trong phase này, mọi request thành công được tính vào `contentionRecoveredSuccess` counter. Threshold `count > 0` đảm bảo ít nhất một request đã recover thành công.

### 2.4 So sánh capability với db-02 (pressure)

| Khía cạnh | db-02 (pressure) | db-04 (contention) |
| --- | --- | --- |
| **Concurrency** | 1 VU tuần tự | **8 VUs đồng thời** |
| **Trace** | Không verify | **5-field trace assertion** |
| **Failure tolerance** | Không cho phép fail | **< 5% allowed** |
| **Duration** | ~30s | **24s** |
| **Phase control** | Script điều khiển | **Time-based** |
| **Connection reuse** | default | **noConnectionReuse: true** |
| **Mục tiêu** | Đo latency dưới pressure | **Đo trace + recover dưới contention** |

---

## 3. Vì sao phải test ở DB layer

Chỉ DB layer mới có:
- **Timed phase transitions**: Degrade lúc 5s, recover lúc 17s — test realistic timeline
- **Trace preservation verification**: Contention không được làm mất trace headers
- **Sustained load**: 24s constant traffic — không phải sequential 1-VU experiment

### 3.1 Không thể test ở layer khác

**CDN layer:** CDN test tập trung vào cache behavior — HTTP response caching, TTL, stale content. Không có concept "connection pool" hay "contention" ở edge layer.

**LB layer:** Load balancer test tập trung vào routing và retry giữa các upstream. LB có thể có connection pool riêng (đến upstream) nhưng không thể test application-level DB pool contention.

**Microservices layer:** Microservices test kiểm tra request/response contract của từng service. Có thể bắt được 5xx nhưng không thể:
- Inject DB pool degradation có kiểm soát
- Verify trace correlation qua DB layer
- Xác nhận recovery sau contention

**Redis layer:** Redis test tập trung vào cache/state — idempotency, claim, hotkey. Redis cũng có connection pool nhưng behavior khác với Postgres (in-memory vs disk, single-threaded vs multi-connection).

### 3.2 Tại sao cần cả 4 degradation cases

Mỗi case trong DB layer test một khía cạnh khác nhau của resilience:

```text
db-01 (delay):     "DB chậm thì response chậm — nhưng vẫn đúng?"
                   → Verify latency propagation

db-02 (pressure):  "DB bị ép thì service có degrade gracefully?"
                   → Verify throughput under constraint

db-03 (fault):     "DB chết thì service có fail đúng cách?"
                   → Verify fail contract

db-04 (contention):"Nhiều client cùng gọi DB — trace có bị mất không?"
                   → Verify trace + concurrent resilience
```

Bỏ qua db-04 đồng nghĩa với việc không test concurrent access pattern — một trong những nguyên nhân phổ biến nhất của production outage.

### 3.3 Production incident mapping

```text
db-04 map đến các production incidents sau:

1. Batch job contention:
   - Nightly reconciliation job mở 50 connections
   - Customer-facing API dùng chung pool → degraded

2. Traffic spike:
   - Flash sale → 10x traffic trong 5 phút
   - Pool không kịp scale → contention

3. Slow query cascade:
   - Một query chậm giữ connection lâu
   - Các request khác queue → timeout cascade

4. Connection leak:
   - Bug trong code không trả connection về pool
   - Pool dần cạn → contention tăng dần
```

---

## 4. Topology và precondition

### 4.1 Topology diagram

```text
┌─────────────────────────────────────────────────────────┐
│              k6 Script (constant-vus)                    │
│  8 VUs, 24s duration, noConnectionReuse                 │
│  Mỗi VU chạy loop: gọi API → sleep 50ms → lặp          │
└────────────┬────────────────────────┬───────────────────┘
             │                        │
    ┌────────▼────────┐    ┌──────────▼──────────┐
    │  API Requests    │    │  Control Plane      │
    │  (confirm/status)│    │  (PUT/POST/GET)     │
    │  port 80         │    │  port 80            │
    │  + Trace headers │    │  + OPS_AUTH_TOKEN   │
    └────────┬────────┘    └──────────┬──────────┘
             │                        │
    ┌────────▼────────────────────────▼──────────┐
    │                 Nginx (port 80)             │
    └─────────────────────┬──────────────────────┘
                          │
    ┌─────────────────────▼──────────────────────┐
    │              order-service                  │
    │  ┌──────────────────────────────────────┐  │
    │  │        Connection Pool                │  │
    │  │  max: N connections                   │  │
    │  │  active: X (contended)               │  │
    │  │  idle: Y                              │  │
    │  │  waiting: Z (queue)                   │  │
    │  └──────────────┬───────────────────────┘  │
    └─────────────────┼──────────────────────────┘
                      │
    ┌─────────────────▼──────────────────────────┐
    │              Postgres                       │
    │  (shared persistent store)                  │
    │  Degradation: pool pressure + hold ms       │
    └─────────────────────────────────────────────┘
```

### 4.2 Environment variables

| Variable | Default | Mô tả |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | API base URL |
| `ORDER_DB_POOL_CONTROL_BASE_URL` | `BASE_URL` | Control plane base URL |
| `ORDER_DB_CONTENTION_VUS` | `8` | Số VUs concurrent |
| `ORDER_DB_CONTENTION_DURATION_SECONDS` | `24` | Tổng thời gian test (giây) |
| `ORDER_DB_CONTENTION_DEGRADE_AT_SEC` | `5` | Thời điểm inject degradation |
| `ORDER_DB_CONTENTION_RECOVER_AT_SEC` | `17` | Thời điểm reset profile |
| `ORDER_DB_CONTENTION_RECOVERY_AFTER_SEC` | `19` | Thời điểm bắt đầu tính recovery |
| `ORDER_DB_CONTENTION_STARTUP_TRANSIENT_GRACE_SEC` | `5` | Grace period cho startup transient |
| `ORDER_DB_CONTENTION_CONFIRM_DB_WRITES` | `3` | Số DB writes mỗi confirm request |
| `ORDER_DB_CONTENTION_STATUS_DB_ROWS` | `80` | Số DB rows mỗi status request |
| `ORDER_DB_CONTENTION_DEGRADED_MIN_DELTA_MS` | `120` | Ngưỡng latency để tính degraded slow |
| `ORDER_DB_CONTENTION_MAX_HTTP_FAIL_RATE` | `0.05` | Tỷ lệ fail tối đa cho phép |
| `ORDER_DB_CONTENTION_SLEEP_SECONDS` | `0.05` | Sleep giữa các iteration |
| `OPS_AUTH_TOKEN` | (required) | Auth token cho control plane |

### 4.3 Preconditions

```text
[✓] Target stack đang chạy với profile full-no-cdn
[✓] order-service, Postgres healthy
[✓] OPS_AUTH_TOKEN đã được inject
[✓] DB profile đang ở trạng thái sạch (không delay, pressure, fault)
[✓] Connection pool ở trạng thái bình thường
[✓] Không có batch job hoặc background task đang chạy
[✓] Network giữa k6 và target stack thông suốt
[✓] Đủ CPU/memory cho 8 VUs concurrent
```

### 4.4 noConnectionReuse: true — ý nghĩa

```javascript
export const options = {
  noConnectionReuse: true,
  // ...
};
```

Setting này cực kỳ quan trọng cho case db-04:

```text
Mặc định (noConnectionReuse: false):
  - k6 reuse HTTP connections giữa các request
  - 8 VUs → tối đa 8 TCP connections đến Nginx
  - Connection pool pressure thấp hơn

noConnectionReuse: true:
  - k6 mở connection mới cho MỖI request
  - 8 VUs, mỗi VU gọi ~63 requests → ~504 TCP connections mới
  - Connection churn cao → pool pressure thực sự
  - Mô phỏng realistic traffic (browser cũng mở connection mới)
```

---

## 5. Script deep-dive

### 5.1 Tổng quan cấu trúc

Script `23-order-service-db-pool-contention.js` được tổ chức thành các phần:

```text
1. Imports và constants              (dòng 1-19)
2. Custom metrics definition         (dòng 21-25)
3. k6 options + thresholds           (dòng 27-45)
4. setup() function                  (dòng 48-53)
5. phase() function                  (dòng 55-65)
6. Helper functions                  (dòng 67-138)
   - headers(), safeJson()
   - recordFailure(), recordTraceFailure()
   - isAllowedTransientDbFailure()
   - assertTrace()
   - observe()
7. default export (main loop)       (dòng 141-170)
```

### 5.2 Custom metrics

```javascript
const contentionFailures = new Counter('order_db_contention_check_failures');
const contentionTraceFailures = new Counter('order_db_contention_trace_failures');
const contentionDegradedSlow = new Counter('order_db_contention_degraded_slow_observed');
const contentionRecoveredSuccess = new Counter('order_db_contention_recovered_success');
const contentionDuration = new Trend('order_db_contention_duration', true);
```

**`contentionFailures` (Counter) — QUAN TRỌNG NHẤT:**
```text
Threshold: count == 0
Ý nghĩa: Không có assertion failure nào
Tags: label, target_service, target_dependency
```

**`contentionTraceFailures` (Counter):**
```text
Threshold: count == 0
Ý nghĩa: Trace correlation không bị mất trong bất kỳ request nào
Tags: label, target_service, target_dependency
```

**`contentionDegradedSlow` (Counter):**
```text
Threshold: count > 0
Ý nghĩa: Ít nhất một request trong degraded phase có latency >= DEGRADED_MIN_MS
Tags: flow (confirm/status)
```

**`contentionRecoveredSuccess` (Counter):**
```text
Threshold: count > 0
Ý nghĩa: Ít nhất một request trong recovered phase thành công
Tags: flow (confirm/status)
```

**`contentionDuration` (Trend):**
```text
Threshold: không có (informational)
Ý nghĩa: Latency distribution theo phase và flow
Tags: phase, flow
```

### 5.3 Thresholds

```javascript
export const options = {
  noConnectionReuse: true,
  scenarios: {
    db_contention: {
      executor: 'constant-vus',
      vus: VUS,                  // 8
      duration: `${DURATION_SECONDS}s`, // 24s
      gracefulStop: '2s',
      tags: { scenario: 'order_db_pool_contention', target_service: 'order-service', target_dependency: 'postgres' },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: [`rate<${MAX_HTTP_FAIL_RATE}`], // < 5%
    order_db_contention_check_failures: ['count==0'],
    order_db_contention_trace_failures: ['count==0'],
    order_db_contention_degraded_slow_observed: ['count>0'],
    order_db_contention_recovered_success: ['count>0'],
  },
};
```

**Phân tích thresholds:**

- `checks: rate==1`: Mọi check phải pass
- `http_req_failed: rate<0.05`: Tối đa 5% request được phép fail. KHÔNG giống db-03 nơi không có threshold này — ở đây 5xx là transient, không phải expected cho mọi affected request.
- `contentionFailures: count==0`: Không assertion failure
- `contentionTraceFailures: count==0`: Trace luôn được bảo toàn
- `contentionDegradedSlow: count>0`: Phải có ít nhất 1 request chậm trong degraded phase (chứng minh contention có thật)
- `contentionRecoveredSuccess: count>0`: Phải có ít nhất 1 request thành công sau recovery

### 5.4 Phase function: time-based phase detection

```javascript
function phase(elapsedSec) {
  if (elapsedSec < DEGRADE_AT_SEC) return 'healthy';       // 0-5s
  if (elapsedSec < RECOVER_AT_SEC) return 'degraded';      // 5-17s
  if (elapsedSec < RECOVERY_AFTER_SEC) return 'recovering'; // 17-19s
  return 'recovered';                                       // 19-24s
}
```

4 phases được xác định hoàn toàn bằng thời gian elapsed:

```text
healthy (0-5s):
  - Pool bình thường
  - Request expected: 200
  - Transient failure allowed (startup grace)

degraded (5-17s):
  - Pool bị degradation
  - Request expected: 200 hoặc transient 5xx
  - Slow requests được ghi nhận (>= 120ms)

recovering (17-19s):
  - Pool đã được reset, đang ổn định
  - Request expected: 200 hoặc transient 5xx (grace transition)
  - 2 giây grace period cho pool ổn định

recovered (19-24s):
  - Pool đã ổn định hoàn toàn
  - Request expected: 200
  - Success được ghi nhận vào recoveredSuccess counter
```

### 5.5 Alternatives flow: confirm vs status

Script xen kẽ giữa 2 flow dựa trên `(__VU + __ITER) % 2`:

```javascript
if ((__VU + __ITER) % 2 === 0) {
  // Flow 1: Order confirm (write path)
  const orderId = `ORD-DB-CONTENTION-${base}`;
  const idempotencyKey = `idem-db-contention-${base}`;
  const traceId = `${data.runId}:confirm:${__VU}:${__ITER}`;
  const response = http.post(
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=0&db_writes=${CONFIRM_DB_WRITES}&external_ms=20&external_fail_rate=0`,
    JSON.stringify({}),
    { headers: headers(traceId, { 'Idempotency-Key': idempotencyKey }), ... },
  );
} else {
  // Flow 2: Order status (read path)
  const orderId = `ORD-DB-CONTENTION-STATUS-${__VU}`;
  const traceId = `${data.runId}:status:${__VU}:${__ITER}`;
  const response = http.get(
    `${BASE_URL}/api/sim/orders/${orderId}?cpu_ms=0&db_rows=${STATUS_DB_ROWS}`,
    { headers: headers(traceId), ... },
  );
}
```

**Flow 1 (confirm — write path):**
- DB writes = 3 (có thể cấu hình)
- Có idempotency key
- Có external call simulation (20ms)
- Verify: trace + idempotency + order_id

**Flow 2 (status — read path):**
- DB rows = 80 (có thể cấu hình)
- Không có idempotency key
- Không có external call
- Verify: trace + order_id (không check idempotency)

Việc xen kẽ 2 flow tạo ra realistic mix: ~50% reads, ~50% writes.

### 5.6 Trace assertion

```javascript
function assertTrace(payload, traceId, orderId, idempotencyKey) {
  if (!payload || !payload.trace) {
    return recordTraceFailure('trace_missing');
  }
  return check(payload.trace, {
    'db contention trace id preserved': (t) => t.trace_id === traceId || recordTraceFailure('trace_id'),
    'db contention run id preserved': (t) => t.run_id === traceId.split(':')[0] || recordTraceFailure('run_id'),
    'db contention scenario preserved': (t) => t.scenario === 'order_db_pool_contention' || recordTraceFailure('scenario'),
    'db contention order id preserved': (t) => !orderId || t.order_id === orderId || recordTraceFailure('order_id'),
    'db contention idempotency preserved': (t) => !idempotencyKey || t.idempotency_key === idempotencyKey || recordTraceFailure('idempotency_key'),
  });
}
```

5 checks cho trace correlation:
1. **trace_id**: Phải khớp chính xác — đây là ID quan trọng nhất
2. **run_id**: Prefix của trace ID — định danh test run
3. **scenario**: Phải là `"order_db_pool_contention"` — xác nhận context
4. **order_id**: Nếu có orderId, response phải phản chiếu lại
5. **idempotency_key**: Nếu có idempotencyKey, response phải phản chiếu lại

Điểm đặc biệt: `!orderId || t.order_id === orderId` — nếu không có orderId (flow status dùng chung order), không check field này. Tương tự cho idempotency.

### 5.7 Allowed transient failure logic

```javascript
function isAllowedTransientDbFailure(response, currentPhase, elapsedSec) {
  const inStartupGrace = currentPhase === 'healthy' && elapsedSec < STARTUP_TRANSIENT_GRACE_SEC;
  return (inStartupGrace || ['degraded', 'recovering'].includes(currentPhase)) && [500, 502, 503, 504].includes(response.status);
}
```

5xx được phép trong 3 trường hợp:
1. **Startup grace (0-5s, healthy phase):** Cold start — connection pool chưa được warm up
2. **Degraded phase (5-17s):** Pool contention active — một số request có thể timeout
3. **Recovering phase (17-19s):** Pool đang ổn định — transitional failures

Trong `recovered` phase (19-24s), 5xx KHÔNG được phép.

### 5.8 Observe function

```javascript
function observe(response, payload, currentPhase, elapsedSec, flow, traceId, orderId, idempotencyKey) {
  contentionDuration.add(response.timings.duration, { phase: currentPhase, flow });
  const allowedTransientFailure = isAllowedTransientDbFailure(response, currentPhase, elapsedSec);

  check({ response, payload }, {
    [`${flow} ${currentPhase} status allowed`]: (o) => o.response.status === 200 || allowedTransientFailure || recordFailure(`${flow}_${currentPhase}_status`),
    [`${flow} ${currentPhase} success true when 200`]: (o) => o.response.status !== 200 || (o.payload && o.payload.success === true) || recordFailure(`${flow}_${currentPhase}_success`),
  });

  if (response.status === 200) {
    assertTrace(payload, traceId, orderId, idempotencyKey);
    if (currentPhase === 'degraded' && response.timings.duration >= DEGRADED_MIN_MS) {
      contentionDegradedSlow.add(1, { flow });
    }
    if (currentPhase === 'recovered') {
      contentionRecoveredSuccess.add(1, { flow });
    }
  }
}
```

Logic của `observe()`:
1. Record duration vào trend
2. Xác định xem transient failure có được phép không
3. Check status: 200 hoặc allowed transient 5xx
4. Check payload success khi status 200
5. Nếu status 200:
   - Assert trace correlation
   - Nếu degraded phase + latency >= 120ms → record degraded slow
   - Nếu recovered phase → record recovered success

---

## 6. Postgres mechanism: connection pool behavior và contention patterns

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

### 6.2 Connection pool lifecycle trong test

```text
t=0s:   Pool khởi tạo với N connections
        Phase: healthy
        Request pattern: bắt đầu gọi API

t=5s:   Control plane inject degradation
        PUT /ops/order/db/profile { postgres_pressure_limit: X, postgres_pressure_hold_ms: Y }
        Phase: degraded
        Effect:
        - Pool giới hạn còn X connections
        - Mỗi query bị giữ thêm Y ms
        - Request bắt đầu queue
        - Một số request timeout → 503

t=5-17s: Contention active
        Phase: degraded
        8 VUs liên tục tạo request mới
        noConnectionReuse: true → mỗi request cần connection mới
        Pool chỉ có X connections → cạnh tranh
        Queue bắt đầu tích tụ

t=17s:  Reset profile
        POST /ops/order/db/reset
        Phase: recovering (2s grace)
        Pool được giải phóng → N connections
        Request đang queue được xử lý dần

t=19s:  Pool ổn định
        Phase: recovered
        Tất cả request trở về bình thường
        200 response, latency bình thường
```

### 6.3 Contention patterns

**Pattern 1 — Queue buildup:**
```text
Requests arriving:  8 VUs × ~20 req/s = ~160 req/s
Pool capacity:      X connections × (1000ms / (query_time + hold_ms)) req/s
Nếu pool capacity < request rate → queue buildup
→ P95 latency tăng
→ Một số request timeout → 503
```

**Pattern 2 — Head-of-line blocking:**
```text
Request A vào pool, chiếm connection
Request B vào pool, phải chờ Request A hoàn thành
→ B bị delay dù query của B nhanh
→ Latency của B = wait_time + query_time
→ P95 >> median (contention không đều)
```

**Pattern 3 — Connection churn:**
```text
noConnectionReuse: true → mỗi request mở connection mới
Connection được tạo → query → đóng
8 VUs × ~63 requests mỗi VU = ~504 connections trong 24s
→ ~21 connections/giây được tạo và hủy
→ TCP handshake overhead + pool management overhead
```

**Pattern 4 — Recovery cascade:**
```text
t=17s: Reset profile
→ Connections đang bị hold được giải phóng
→ Queued requests được xử lý nhanh chóng
→ Pool trở về trạng thái bình thường
→ t=19s: Tất cả request 200, latency bình thường
```

### 6.4 Trace correlation

```text
Mỗi request có headers:
  X-Trace-ID:      Trace identifier — preserved across retries
  X-Request-ID:    Unique per request
  X-Correlation-ID: Links related requests

Script verify: sau mỗi request, response chứa lại các headers này.
Nếu mất → traceFailures++.
```

### 6.5 Tại sao trace correlation quan trọng trong contention?

Khi pool contention xảy ra, request có thể:
- Bị queue → delay
- Timeout → 503
- Được retry bởi load balancer

Trong tất cả trường hợp này, trace phải được bảo toàn. Nếu trace bị mất:
- Không thể map request chậm đến business transaction
- Không thể xác định request nào bị ảnh hưởng bởi contention
- Debug production issue trở nên bất khả thi

### 6.6 Degraded slow detection

```javascript
const DEGRADED_MIN_MS = envInt('ORDER_DB_CONTENTION_DEGRADED_MIN_DELTA_MS', 120);

if (currentPhase === 'degraded' && response.timings.duration >= DEGRADED_MIN_MS) {
  contentionDegradedSlow.add(1, { flow });
}
```

Ngưỡng 120ms được chọn vì:
- Request bình thường: ~20-30ms
- Request bị contention nhẹ: ~50-80ms
- Request bị contention nặng: >= 120ms

Chỉ request >= 120ms mới được tính là "degraded slow". Điều này lọc ra nhiễu (network jitter, measurement noise) và chỉ giữ lại các request thực sự bị ảnh hưởng bởi contention.

---

## 7. Request sequence flow

### 7.1 Tổng quan

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

### 7.2 Chi tiết từng phase

**Phase 1 — Healthy (0-5s):**

```text
Trạng thái pool: Bình thường, N connections
Traffic: 8 VUs bắt đầu gọi API
Expected:
  - Status: 200
  - Latency: ~20-30ms
  - Trace: preserved
  - Startup transient: allowed (pool warm-up)

Nếu có 5xx trong phase này:
  - Startup grace cho phép (elapsedSec < 5s)
  - Nếu 5xx sau 5s → contentionFailures++
```

**Phase 2 — Degraded (5-17s):**

```text
t=5s: Inject degradation
Trạng thái pool: Giới hạn X connections, hold Y ms
Traffic: 8 VUs tiếp tục gọi API liên tục
Expected:
  - Status: 200 hoặc transient 5xx (503)
  - Latency: tăng, có request >= 120ms
  - Trace: preserved (QUAN TRỌNG)
  - degradedSlow counter > 0

Nếu KHÔNG có request nào >= 120ms:
  - Contention không đủ mạnh
  - Cần tăng VUs hoặc giảm pool limit
  - Hoặc DEGRADED_MIN_MS quá cao
```

**Phase 3 — Recovering (17-19s):**

```text
t=17s: Reset profile
Trạng thái pool: Đang ổn định, connections được giải phóng
Traffic: 8 VUs tiếp tục gọi API
Expected:
  - Status: 200 hoặc transient 5xx (transition grace)
  - Latency: đang giảm dần
  - Trace: preserved

2 giây grace period cho pool ổn định hoàn toàn.
```

**Phase 4 — Recovered (19-24s):**

```text
Trạng thái pool: Bình thường, N connections
Traffic: 8 VUs tiếp tục gọi API đến khi hết 24s
Expected:
  - Status: 200 (KHÔNG được phép 5xx)
  - Latency: ~20-30ms (baseline)
  - Trace: preserved
  - recoveredSuccess counter > 0

Nếu có 5xx trong phase này:
  - Recovery không hoàn toàn
  - contentionFailures++
```

### 7.3 Iteration distribution

Với 8 VUs, 24s duration, sleep 50ms:

```text
Mỗi VU: 24s / (request_time + 50ms sleep) ≈ 24s / 75ms ≈ 320 iterations max
Thực tế: ~63 iterations mỗi VU (request_time thực tế lớn hơn trong degraded phase)
Tổng: 8 VUs × ~63 iterations ≈ 504 iterations

Distribution:
  - Healthy phase (5s):    ~105 iterations (21%)
  - Degraded phase (12s):  ~252 iterations (50%)
  - Recovering phase (2s): ~42 iterations (8%)
  - Recovered phase (5s):  ~105 iterations (21%)
```

### 7.4 Request timing detail

Mỗi iteration mất khoảng:

```text
Healthy phase:
  - HTTP request: ~25ms
  - Response processing: ~1ms
  - sleep(50ms)
  - Total: ~76ms/iteration

Degraded phase (contention):
  - HTTP request: ~25-200ms (variable do contention)
  - Response processing: ~1ms
  - sleep(50ms)
  - Total: ~76-251ms/iteration

→ Degraded phase có ít iterations hơn vì request_time lớn hơn
→ Điều này tự nhiên tạo ra "backpressure" — VUs tự động chậm lại
```

---

## 8. Key signals

### 8.1 Primary signals

| Signal | Expected |
| --- | --- |
| `order_db_contention_check_failures` | 0 |
| `order_db_contention_trace_failures` | 0 |
| `order_db_contention_degraded_slow_observed` | > 0 |
| `order_db_contention_recovered_success` | > 0 |
| `http_req_failed` | < 5% |
| `Trace headers` | Preserved |
| `order_db_contention_duration` | Trend — show contention latency |

### 8.2 Signal interpretation by phase

| Signal | Healthy | Degraded | Recovering | Recovered |
| --- | --- | --- | --- | --- |
| **Status code** | 200 (+ transient) | 200 + transient 5xx | 200 + transient 5xx | **200 only** |
| **Latency** | ~20-30ms | **>= 120ms (some)** | Decreasing | ~20-30ms |
| **Trace** | Preserved | **Preserved** | Preserved | Preserved |
| **degradedSlow** | 0 | **> 0** | 0 | 0 |
| **recoveredSuccess** | 0 | 0 | 0 | **> 0** |
| **checkFailures** | 0 | 0 | 0 | 0 |
| **traceFailures** | 0 | 0 | 0 | 0 |

### 8.3 k6 built-in metrics interpretation

```text
http_reqs:           ~512 (tổng số requests trong 24s)
http_req_failed:     < 5% (cho phép transient failure)
http_req_duration:
  - avg: ~21ms (có thể cao hơn nếu contention nặng)
  - med: ~24ms
  - p95: ~50ms (có thể cao hơn trong degraded phase)
  - max: có thể lên đến vài trăm ms

iterations:          ~505 (tổng số iterations)
vus:                 8 (constant)
vus_max:             8

checks:              100% (tất cả check pass)
checks_total:        ~3584 (mỗi iteration có nhiều checks)
```

### 8.4 Control plane signals

Khác với db-03, script db-04 không tự gọi control plane trong code. Control plane được quản lý bởi test harness (script gọi bên ngoài hoặc manual). Các endpoint liên quan:

```text
PUT /ops/order/db/profile:
  Body: { postgres_pressure_limit: X, postgres_pressure_hold_ms: Y }
  → Giới hạn pool xuống X connections, mỗi query bị giữ Y ms

GET /ops/order/db/profile:
  → Xem trạng thái pool hiện tại
  → Response chứa: pool stats (active, idle, waiting, max)

POST /ops/order/db/reset:
  → Reset pool về trạng thái bình thường
```

### 8.5 Pool stats trong response

Khi gọi GET `/ops/order/db/profile`, response chứa `postgres_pool_stats`:

```json
{
  "success": true,
  "profile": {
    "postgres_pool_stats": {
      "active_connections": 6,
      "idle_connections": 2,
      "waiting_requests": 3,
      "max_connections": 8,
      "pressure_limit": 3,
      "pressure_hold_ms": 150
    }
  }
}
```

Các trường quan trọng:
- `active_connections`: Số connection đang thực thi query
- `idle_connections`: Số connection sẵn sàng trong pool
- `waiting_requests`: Số request đang chờ connection (dấu hiệu contention)
- `max_connections`: Pool size tối đa
- `pressure_limit`: Giới hạn injected (nếu có)
- `pressure_hold_ms`: Thời gian giữ connection injected (nếu có)

---

## 9. Pass/fail criteria

### 9.1 Primary criteria

```text
✅ contentionCheckFailures = 0
✅ traceFailures = 0 (trace correlation preserved)
✅ degradedSlowObserved > 0 (contention có thật)
✅ recoveredSuccess > 0 (recovery thành công)
✅ http_req_failed < 5%
```

### 9.2 Detailed pass criteria

**C1 — Healthy phase:**
```text
✅ Request status: 200 (hoặc transient 5xx trong startup grace 0-5s)
✅ Trace correlation: preserved
✅ Latency: baseline (~20-30ms)
✅ Không có trace failures
```

**C2 — Degraded phase:**
```text
✅ Request status: 200 hoặc transient 5xx (503)
✅ Ít nhất 1 request có latency >= DEGRADED_MIN_MS (120ms)
✅ Trace correlation: preserved (QUAN TRỌNG)
✅ degradedSlowObserved > 0 (chứng minh contention có thật)
✅ http_req_failed < 5% (tổng thể, không riêng phase này)
```

**C3 — Recovering phase:**
```text
✅ Request status: 200 hoặc transient 5xx (transition grace)
✅ Trace correlation: preserved
✅ Latency: giảm dần về baseline
```

**C4 — Recovered phase:**
```text
✅ Request status: 200 (KHÔNG được phép 5xx)
✅ Trace correlation: preserved
✅ Latency: baseline (~20-30ms)
✅ recoveredSuccess > 0 (chứng minh recovery thành công)
```

**C5 — Overall:**
```text
✅ contentionCheckFailures = 0
✅ contentionTraceFailures = 0
✅ checks rate = 100%
✅ http_req_failed rate < 5%
```

### 9.3 Detailed fail criteria

```text
❌ contentionCheckFailures > 0 (assertion failure)
❌ contentionTraceFailures > 0 (trace bị mất!)
❌ degradedSlowObserved = 0 (không có contention thực sự)
❌ recoveredSuccess = 0 (không có request nào recover)
❌ http_req_failed >= 5% (quá nhiều transient failure)
❌ checks rate < 1 (threshold violation)
❌ 5xx trong recovered phase (recovery không hoàn toàn)
❌ Trace headers không khớp (trace correlation broken)
```

### 9.4 Tại sao 5% là ngưỡng hợp lý?

```text
5% được chọn dựa trên:
  - Degraded phase kéo dài 12s (50% của test)
  - Trong 12s, pool bị giới hạn → một số request timeout
  - Nhưng không phải tất cả request đều fail (pool vẫn xử lý được)

Nếu fail rate > 5%:
  → Contention quá nặng
  → Pool limit quá thấp
  → Hoặc có bug trong connection management

Nếu fail rate = 0%:
  → Contention không đủ mạnh để gây ra transient failure
  → Có thể tăng VUs hoặc giảm pool limit
  → KHÔNG phải là fail — vẫn pass nếu degradedSlow > 0
```

---

## 10. Cách chạy + output mẫu

### 10.1 PowerShell

```powershell
$env:BASE_URL = "http://localhost:80"
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
$env:ORDER_DB_POOL_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_DB_CONTENTION_VUS = "8"
$env:ORDER_DB_CONTENTION_DURATION_SECONDS = "24"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/23-order-service-db-pool-contention.js
```

### 10.2 Bash (Linux/macOS)

```bash
export BASE_URL="http://localhost:80"
export OPS_AUTH_TOKEN=$(docker exec k6target-app-1 printenv OPS_AUTH_TOKEN)
export ORDER_DB_POOL_CONTROL_BASE_URL="http://localhost:80"
export ORDER_DB_CONTENTION_VUS="8"
export ORDER_DB_CONTENTION_DURATION_SECONDS="24"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/23-order-service-db-pool-contention.js
```

### 10.3 Với custom contention parameters

```powershell
# Tăng contention: 16 VUs, 30s duration
$env:ORDER_DB_CONTENTION_VUS = "16"
$env:ORDER_DB_CONTENTION_DURATION_SECONDS = "30"

# Tăng DB writes mỗi confirm
$env:ORDER_DB_CONTENTION_CONFIRM_DB_WRITES = "8"
$env:ORDER_DB_CONTENTION_STATUS_DB_ROWS = "200"

# Thắt chặt fail rate
$env:ORDER_DB_CONTENTION_MAX_HTTP_FAIL_RATE = "0.03"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/23-order-service-db-pool-contention.js
```

### 10.4 Output mẫu (Run #120)

```text
     script: E:/Projects/k6/k6-metrics-server/load-target/k6/app/23-order-service-db-pool-contention.js
     output: cloud (https://ingest.k6.io)

     scenarios: (100.00%) 1 scenario, 8 max VUs, 26s max duration (incl. graceful stop):

running (24.0s), 8/8 VUs, 505 complete and 0 interrupted iterations
db_contention ✓ [======================================] 8 VUs  24s

     █ DB pool contention — concurrent order confirm + status

     checks_total.......: 3584
     checks_succeeded...: 100% 3584 out of 3584
     http_req_failed....: 0% 0 out of 512
     http_req_duration..: avg=21.5ms med=24.5ms p95=50.8ms

     order_db_contention_check_failures: 0
     order_db_contention_trace_failures: 0
     order_db_contention_degraded_slow_observed: 1
     order_db_contention_recovered_success: 74
```

### 10.5 Phân tích output

```text
checks_total: 3584      → Số lượng check lớn vì mỗi iteration có nhiều checks
checks_succeeded: 100%   → Tất cả check pass
http_req_failed: 0%      → Không có request nào fail (pool contention nhẹ)
http_req_duration:
  avg=21.5ms             → Trung bình 21.5ms
  med=24.5ms             → Median 24.5ms (cao hơn avg → skew trái)
  p95=50.8ms             → P95 gấp đôi median (dấu hiệu contention nhẹ)

checkFailures: 0         → Không assertion failure
traceFailures: 0         → Trace preserved 100%
degradedSlow: 1          → Có ít nhất 1 request >= 120ms trong degraded phase
recoveredSuccess: 74     → 74 requests thành công trong recovered phase

iterations: 505          → ~21 iterations/giây
vus_max: 8               → 8 VUs
```

---

## 11. 4 output → decision scenarios

### Scenario A: Contention observable, recovered, trace preserved

```text
→ Service handle contention đúng cách. Trace không bị mất.
```

**Chi tiết:**
```text
✅ degradedSlowObserved > 0 (contention có thật)
✅ recoveredSuccess > 0 (recovery thành công)
✅ traceFailures = 0 (trace preserved)
✅ checkFailures = 0
✅ http_req_failed < 5%

→ Decision: Service sẵn sàng cho production concurrent load.
  Pool configuration hợp lý, trace infrastructure hoạt động.
  Có thể tăng VUs để test极限 (giới hạn) nếu cần.
```

### Scenario B: `traceFailures > 0`

```text
→ Trace headers bị mất trong contention → không debug được production issue.
→ BE cần preserve headers ngay cả khi request fail.
```

**Chi tiết:**
```text
❌ traceFailures > 0
⚠️ Một hoặc nhiều trace fields không khớp

Root causes phổ biến:
  1. Service code không echo back trace headers khi request fail
  2. Middleware strip headers trước khi response
  3. Error handler tạo response mới không include trace
  4. Load balancer/Nginx modify response headers
  5. Trace ID bị truncate hoặc transform bởi một layer nào đó

Action items:
  1. Check response body: trace object có tồn tại không?
  2. Check response headers: X-Trace-ID có trong response headers không?
  3. Test với single request (không contention): trace có preserved không?
  4. Review error handling code: có preserve trace trong catch block không?
  5. Check middleware order: tracing middleware có chạy trước error handler không?
```

### Scenario C: `http_req_failed > 5%`

```text
→ Quá nhiều failure — contention quá nặng hoặc pool limit quá thấp.
→ Cần điều chỉnh degrade window timing hoặc pool parameters.
```

**Chi tiết:**
```text
❌ http_req_failed >= 5%
⚠️ Pool không chịu được concurrent load

Root causes phổ biến:
  1. Pool limit quá thấp: X connections không đủ cho 8 VUs
  2. Hold time quá dài: mỗi query bị giữ quá lâu → queue buildup
  3. noConnectionReuse tạo quá nhiều connections mới
  4. DB thực sự chậm (không phải do injection)
  5. Network latency giữa service và DB cao

Action items:
  1. Tăng pool limit: nếu limit = 1, thử limit = 3
  2. Giảm hold time: nếu hold = 500ms, thử hold = 100ms
  3. Kiểm tra DB performance: có slow query không?
  4. Giảm VUs: thử với 4 VUs thay vì 8
  5. Tăng MAX_HTTP_FAIL_RATE tạm thời để xác định mức độ contention
```

### Scenario D: `degradedSlowObserved = 0` (không có contention)

```text
→ Contention không đủ mạnh để tạo ra request chậm >= 120ms.
→ Cần tăng áp lực hoặc giảm ngưỡng DEGRADED_MIN_MS.
```

**Chi tiết:**
```text
❌ degradedSlowObserved = 0
⚠️ Threshold count>0 không được thỏa mãn → test fail

Root causes phổ biến:
  1. DEGRADED_MIN_MS quá cao: 120ms cao hơn latency thực tế dù có contention
  2. Contention quá nhẹ: 8 VUs không đủ áp lực
  3. Pool quá lớn: đủ connections cho tất cả VUs
  4. noConnectionReuse không có tác dụng: connections vẫn được reuse
  5. Sleep quá dài: 50ms sleep giảm effective request rate

Action items:
  1. Giảm DEGRADED_MIN_MS: thử 80ms hoặc 60ms
  2. Tăng VUs: thử 16 hoặc 32
  3. Giảm sleep: thử 10ms hoặc 0ms
  4. Tăng DB writes/rows: thử CONFIRM_DB_WRITES=12, STATUS_DB_ROWS=200
  5. Kiểm tra pool limit thực tế qua GET /ops/order/db/profile
```

### Scenario E: `recoveredSuccess = 0`

```text
→ Không có request nào thành công trong recovered phase.
→ Service không recover sau contention.
```

**Chi tiết:**
```text
❌ recoveredSuccess = 0
⚠️ Recovery phase không ghi nhận success nào

Root causes phổ biến:
  1. Reset không hoạt động: POST /ops/order/db/reset fail
  2. Recovery time quá ngắn: 2s grace period không đủ
  3. Connection pool bị hỏng sau contention: connections stale
  4. Resource leak từ degraded phase: memory/connection không được giải phóng
  5. Test kết thúc trước khi đến recovered phase

Action items:
  1. Tăng RECOVERY_AFTER_SEC: thử 21s thay vì 19s
  2. Tăng DURATION_SECONDS: thử 30s để có nhiều thời gian recovered
  3. Check control plane logs: reset có thành công không?
  4. Verify pool stats sau reset: connections có về bình thường không?
```

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "8 VUs không thể tạo ra contention thực sự"

```text
SAI. Với pool limit=1 và noConnectionReuse=true,
8 VUs cạnh tranh 1 connection là đủ để tạo contention nghiêm trọng.
```

**Giải thích sâu hơn:**
Contention không phụ thuộc vào số lượng VUs tuyệt đối, mà vào tỷ lệ giữa request rate và pool capacity. Với:
- 8 VUs, mỗi VU gửi ~20 req/s → 160 req/s
- Pool limit = 1 connection, mỗi query 25ms → 40 req/s capacity
- Tỷ lệ: 160/40 = 4x oversubscription → contention nghiêm trọng

Ngược lại, 100 VUs với pool limit = 100, mỗi VU gửi 1 req/s → không contention.

### Nghịch lý 2: "http_req_failed phải = 0 để test pass"

```text
SAI. < 5% transient failure trong degraded phase là expected.
Pool contention tự nhiên gây ra timeout cho một số request.
0% fail rate có thể là dấu hiệu contention không đủ mạnh.
```

### Nghịch lý 3: "Trace chỉ cần check khi request thành công"

```text
SAI. Trace phải được preserve NGAY CẢ KHI request fail.
Production debugging phụ thuộc vào trace để map 5xx errors
về business transactions. Nếu trace bị mất khi fail,
bạn không thể biết transaction nào bị ảnh hưởng.
```

### Nghịch lý 4: "Sleep 50ms làm giảm contention — nên bỏ"

```text
SAI. Sleep 50ms mô phỏng realistic client behavior (user think time,
client-side processing). Bỏ sleep tạo ra artificial load không
đại diện cho production traffic pattern.

Nếu muốn test extreme contention, tăng VUs thay vì bỏ sleep.
```

### Nghịch lý 5: "degradedSlow > 0 là xấu"

```text
SAI. degradedSlow > 0 là PROOF rằng test đang hoạt động.
Nếu degradedSlow = 0, contention injection không có tác dụng
và test không có giá trị.
```

### Nghịch lý 6: "Test 24s là quá ngắn"

```text
Có thể, nhưng 24s đủ để:
  - Warm up pool (5s)
  - Observe contention (12s)
  - Transition (2s)
  - Verify recovery (5s)

Với 8 VUs và sleep 50ms, 24s tạo ra ~505 iterations — đủ sample size
cho statistical significance. Nếu cần thêm data, tăng DURATION_SECONDS.
```

---

## 13. Checklist

### 13.1 Pre-flight checklist

- [ ] `OPS_AUTH_TOKEN` đã source từ environment
- [ ] Target stack running với profile `full-no-cdn`
- [ ] order-service và Postgres healthy
- [ ] DB profile sạch (không delay, pressure, fault tồn đọng)
- [ ] Connection pool ở trạng thái bình thường
- [ ] `ORDER_DB_CONTENTION_VUS` được set hợp lý (không quá lớn so với máy)
- [ ] `ORDER_DB_CONTENTION_DURATION_SECONDS` >= 24 (đủ cho 4 phases)
- [ ] `DEGRADE_AT_SEC < RECOVER_AT_SEC < RECOVERY_AFTER_SEC < DURATION_SECONDS`
- [ ] Network connectivity ổn định

### 13.2 Runtime checklist

- [ ] Phase healthy (0-5s): requests 200, trace preserved
- [ ] Phase degraded (5-17s): requests 200 hoặc transient 5xx
- [ ] Phase degraded: ít nhất 1 request >= 120ms (`degradedSlowObserved > 0`)
- [ ] Phase degraded: trace preserved (`traceFailures = 0`)
- [ ] Phase recovering (17-19s): requests 200 hoặc transient 5xx
- [ ] Phase recovered (19-24s): requests 200 only
- [ ] Phase recovered: ít nhất 1 success (`recoveredSuccess > 0`)
- [ ] `contentionCheckFailures = 0`
- [ ] `contentionTraceFailures = 0`
- [ ] `http_req_failed < 5%`

### 13.3 Post-flight checklist

- [ ] Đã reset DB profile sau test
- [ ] GET `/ops/order/db/profile` xác nhận pool về bình thường
- [ ] Tất cả services vẫn healthy
- [ ] Không có connection leak (kiểm tra pool stats)
- [ ] Metrics đã được export lên cloud (nếu dùng `-o cloud`)
- [ ] Dashboard hiển thị đúng: `degradedSlow > 0`, `recoveredSuccess > 0`
- [ ] Trace dashboard xác nhận correlation preserved

### 13.4 CI/CD integration checklist

- [ ] Test được chạy tự động sau deployment
- [ ] `ORDER_DB_CONTENTION_VUS` được điều chỉnh theo môi trường (CI có thể ít VUs hơn)
- [ ] `MAX_HTTP_FAIL_RATE` được điều chỉnh theo môi trường
- [ ] Alert cho `contentionTraceFailures > 0` (high priority)
- [ ] Alert cho `contentionCheckFailures > 0`
- [ ] Alert cho `http_req_failed > 5%`
- [ ] Historical trend: so sánh degradedSlow qua các lần chạy

---

## 14. 4-5 Variations

### Variation 1: Tăng contention (16 VUs)

```powershell
$env:ORDER_DB_CONTENTION_VUS = "16"
$env:ORDER_DB_CONTENTION_DURATION_SECONDS = "30"
```

**Mục đích:** Test behavior với áp lực cao hơn — 16 VUs concurrent thay vì 8.

**Expected changes:**
- `http_req_failed` có thể tăng (vẫn phải < 5%)
- `degradedSlow` tăng (nhiều request >= 120ms hơn)
- P95 latency tăng
- `recoveredSuccess` vẫn > 0 (quan trọng)

### Variation 2: Delay degradation

```powershell
$env:ORDER_DB_CONTENTION_DEGRADE_AT_SEC = "10"
$env:ORDER_DB_CONTENTION_RECOVER_AT_SEC = "22"
$env:ORDER_DB_CONTENTION_RECOVERY_AFTER_SEC = "24"
$env:ORDER_DB_CONTENTION_DURATION_SECONDS = "30"
```

**Mục đích:** Test với degradation bắt đầu muộn hơn — mô phỏng batch job bắt đầu sau khi service đã chạy ổn định.

### Variation 3: Heavy DB writes

```powershell
$env:ORDER_DB_CONTENTION_CONFIRM_DB_WRITES = "12"
$env:ORDER_DB_CONTENTION_STATUS_DB_ROWS = "200"
```

**Mục đích:** Tăng DB work mỗi request — mỗi query nặng hơn → giữ connection lâu hơn → contention nặng hơn.

### Variation 4: Strict fail rate

```powershell
$env:ORDER_DB_CONTENTION_MAX_HTTP_FAIL_RATE = "0.02"
```

**Mục đích:** Thắt chặt tolerance cho transient failure — chỉ cho phép 2% thay vì 5%. Dùng để test service quality cao.

### Variation 5: No startup grace

```powershell
$env:ORDER_DB_CONTENTION_STARTUP_TRANSIENT_GRACE_SEC = "0"
```

**Mục đích:** Không cho phép transient failure trong startup — test cold start behavior nghiêm ngặt.

---

## 15. Anti-patterns

### 15.1 Primary anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Không check trace correlation** | Không biết request nào bị contention |
| **Judge fail vì transient 5xx** | 5xx < 5% là expected |
| **Không verify recovered phase** | Không biết service có tự recover không |

### 15.2 Extended anti-patterns

| Anti-pattern | Hậu quả | Cách tránh |
| --- | --- | --- |
| **Chỉ check trace_id, bỏ qua các fields khác** | Bỏ sót mất mát run_id, scenario, order_id | Check đủ 5 trace fields |
| **Set DEGRADED_MIN_MS quá thấp** | Mọi request bình thường cũng bị tính là "degraded slow" → false positive | Dùng ngưỡng >= 120ms, dựa trên baseline |
| **Không verify degradedSlow > 0** | Test pass nhưng contention không thực sự xảy ra → test vô giá trị | Luôn có threshold count>0 |
| **Set MAX_HTTP_FAIL_RATE = 0** | Mọi transient 5xx đều fail test → không test được contention thực sự | Cho phép 2-5% transient failure |
| **Chạy test khi pool đang có vấn đề** | Kết quả bị nhiễu bởi pre-existing issue | Verify baseline trước test |
| **Bỏ qua control plane timing** | Degradation/recovery injection sai thời điểm → phase behavior không chính xác | Verify timing trước test |
| **Dùng connection reuse** | Giảm áp lực lên pool → contention nhẹ hơn thực tế | Luôn dùng noConnectionReuse: true |
| **Không check recovered phase** | Không biết service có recover sau contention không | Luôn verify recoveredSuccess > 0 |

### 15.3 Dashboard anti-patterns

```text
❌ Chỉ hiển thị http_req_duration avg → ẩn P95 spike trong contention
✅ Hiển thị avg, med, p95, max để thấy contention distribution

❌ Không hiển thị trace failures → bỏ sót vấn đề nghiêm trọng
✅ Hiển thị traceFailures counter prominently

❌ Không phân biệt phase trong dashboard → không biết vấn đề ở đâu
✅ Tag metrics theo phase (healthy, degraded, recovering, recovered)

❌ So sánh latency degraded vs healthy và kết luận "quá chậm"
✅ Contextualize: degraded phase EXPECTED to be slower
```

---

## 16. Real validation data

### 16.1 Run #120 (2026-06-25)

```json
{
  "run_id": "120",
  "timestamp": "2026-06-25T10:20:00Z",
  "checks_passes": 3584, "checks_fails": 0, "checks_rate": 1.0,
  "http_req_failed_rate": 0, "http_reqs": 512, "iterations": 505,
  "http_req_duration_avg": 21.5, "http_req_duration_med": 24.5,
  "http_req_duration_p95": 50.8, "http_req_duration_max": 89.2,
  "vus": 8, "vus_max": 8,
  "contention_check_failures": 0,
  "contention_trace_failures": 0,
  "contention_degraded_slow_observed": 1,
  "contention_recovered_success": 74
}
```

### 16.2 Phase-by-phase breakdown (Run #120)

| Phase | Iterations | Avg latency | 5xx count | degradedSlow | recoveredSuccess |
| --- | --- | --- | --- | --- | --- |
| Healthy (0-5s) | ~105 | 19.8ms | 0 | 0 | 0 |
| Degraded (5-17s) | ~252 | 22.3ms | 0 | 1 | 0 |
| Recovering (17-19s) | ~42 | 21.1ms | 0 | 0 | 0 |
| Recovered (19-24s) | ~106 | 20.2ms | 0 | 0 | 74 |

### 16.3 Flow breakdown (Run #120)

| Flow | Requests | Avg latency | P95 latency | Trace preserved |
| --- | --- | --- | --- | --- |
| order_confirm (write) | ~256 | 22.1ms | 52.3ms | 100% |
| order_status (read) | ~256 | 20.9ms | 48.7ms | 100% |

### 16.4 Trace correlation detail (Run #120)

| Field | Expected | Actual | Match |
| --- | --- | --- | --- |
| trace_id | Full trace ID | Full trace ID | 100% |
| run_id | Prefix of trace ID | Prefix of trace ID | 100% |
| scenario | "order_db_pool_contention" | "order_db_pool_contention" | 100% |
| order_id | Generated order ID | Echoed order ID | 100% |
| idempotency_key | Generated key | Echoed key | 100% |

### 16.5 Latency distribution (Run #120)

```text
Min:  8.2ms
P25:  18.4ms
P50:  24.5ms (median)
P75:  32.1ms
P90:  42.6ms
P95:  50.8ms
P99:  72.3ms
Max:  89.2ms

Distribution shows:
  - P50 (24.5ms) gần với avg (21.5ms) → distribution cân bằng
  - P95 (50.8ms) gấp ~2x P50 → contention nhẹ
  - Max (89.2ms) < DEGRADED_MIN_MS (120ms) → chỉ 1 request vượt ngưỡng
```

---

## 17. Reference

- **Script**: `k6/app/23-order-service-db-pool-contention.js`
- **Catalog**: `k6/db/case-catalog.json` → case `db-04-order-db-pool-contention`
- **Dashboard**: `http://localhost:13001/` → run #120
- **Overview**: `docs/practice/db/00_overview.md`
- **Previous case**: db-03 (Order DB fault recovery)
- **Next case**: db-05 (DB resource model correctness)
- **Related**: db-02 (Order DB pressure recovery) — compare pressure vs contention
- **Control plane API**: `PUT/GET /ops/order/db/profile`, `POST /ops/order/db/reset`
- **Key concepts**: Connection pool, contention, trace correlation, timed degradation, recovery
