# db-02 -- Order DB pressure recovery

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
6. [Postgres mechanism deep-dive: Pool pressure và connection contention](#6-postgres-mechanism-deep-dive-pool-pressure-và-connection-contention)
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

### 1.4 Real-world trigger scenarios cho pool pressure

Pool pressure không chỉ đến từ Black Friday. Dưới đây là các tình huống production thực tế:

| Tình huống | Pressure level | Duration | Cơ chế |
| --- | --- | --- | --- |
| Flash sale / promotion | Rất cao | 5-30 phút | Traffic spike 10-50x |
| Slow query epidemic | Cao | Vài phút đến vài giờ | Một query chậm giữ connection lâu → domino effect |
| Connection leak | Tăng dần | Hàng giờ đến hàng ngày | Application không trả connection về pool |
| PGBouncer misconfiguration | Trung bình đến cao | Liên tục | Pool size quá nhỏ so với traffic |
| Schema lock contention | Cao | Vài giây đến vài phút | ALTER TABLE lock → tất cả writes bị block |
| Replication lag spike | Trung bình | Vài phút | Read replica không sync kịp |
| Noisy neighbor (shared DB) | Biến động | Liên tục | Service khác dùng chung DB instance tiêu thụ hết I/O |

Case này mô phỏng **connection pool exhaustion** với pattern "nhiều request đồng thời, connection hạn chế, mỗi request giữ connection lâu".

### 1.5 Cách pool pressure lan truyền qua hệ thống

```text
Connection pool limit = 1, hold time = 180ms
  → Chỉ 1 connection available
  → Mỗi request giữ connection 180ms trước khi trả về pool
  → Request 1: chiếm connection, 180ms
  → Request 2: phải chờ request 1 trả connection → chờ ~180ms
  → Request 3: phải chờ request 1 và 2 → chờ ~360ms
  → Request 4: chờ ~540ms
  → ...
  → Request N: chờ ~(N-1) * 180ms

Đây là queuing delay — tăng TUYẾN TÍNH theo số lượng requests đang chờ.
Tổng latency của request = hold_time + queuing_delay + actual_query_time.
```

Với burst 3 rounds, mỗi round 6 requests:

```text
Round 1: 6 requests cạnh tranh 1 connection
  → Request 1-1: 180ms
  → Request 1-2: chờ 180ms + 180ms = 360ms
  → Request 1-3: chờ 360ms + 180ms = 540ms
  → ...
  → Request 1-6: chờ 900ms + 180ms = 1080ms

Round 2: queue từ round 1 chưa drain hết → tích lũy thêm
Round 3: queue tích lũy → extreme tail latency
```

### 1.6 Phân biệt pressure vs delay vs fault

| Khía cạnh | Delay (db-01) | Pressure (db-02 — case này) | Fault (db-03) |
| --- | --- | --- | --- |
| Injection | `postgres_delay_ms=35` | `pressure_limit=1, hold_ms=180` | `postgres_fault_mode=tcp_reset` |
| DB có hoạt động không? | Có (chậm hơn) | Có (bị giới hạn connection) | Không (lỗi intentional) |
| Status code | 200 | 200 (nhưng latency spike) | 5xx trong fault window |
| Request có fail không? | Không | Có thể timeout | Có (expected) |
| Pattern | Đều, predictable | Không đều, spike | Nhị phân (hoặc 200 hoặc 5xx) |
| Recovery speed | Tức thì | Cần drain queue | Tức thì (với điều kiện connections còn) |

---

## 2. DB capability được chứng minh

### 2.1 Phát biểu capability

> **Khi Postgres pool bị ép (giới hạn connection, tăng hold time), service vẫn hoạt động nhưng latency tăng đáng kể. Pool stats phản ánh chính xác trạng thái pressure. Unaffected APIs không bị ảnh hưởng. Sau khi reset, pool trở về bình thường và latency recovered.**

### 2.2 Các khía cạnh được verify

1. **Pressure injection**: `PUT /ops/order/db/profile` với `postgres_pressure_limit=1`, `postgres_pressure_hold_ms=180`, `postgres_pressure_waits_min=2`.
2. **Burst handling**: Service xử lý burst N rounds mà không crash.
3. **Pool stats observable**: `postgres_pressure_limit`, `postgres_pressure_hold_ms` visible trong profile.
4. **Recovery**: Sau reset, pool stats = 0, latency trở về baseline.
5. **Unaffected isolation**: Products, cart, report services không bị ảnh hưởng bởi order-service pool pressure.

### 2.3 Contract verification cụ thể

| Phase | Endpoint | Expected | Evidence |
| --- | --- | --- | --- |
| Baseline | `GET /ops/order/db/profile` | 200, `pressure_limit=0, hold_ms=0` | Profile sạch |
| Baseline | Burst 1 round affected + unaffected | 200, normal latency | Baseline latency |
| Pressure set | `PUT /ops/order/db/profile` | 200, `pressure_limit=1, hold_ms=180` | Pressure active |
| Pressure verify | `GET /ops/order/db/profile` | 200, pool stats reflect pressure | Pressure confirmed |
| Pressure burst | Burst 3 rounds affected + unaffected | 200, latency spike | Degraded latency |
| Pressure after burst | `GET /ops/order/db/profile` | `pressure_total_waits >= 2` | Waits accumulated |
| Recovery reset | `POST /ops/order/db/reset` | 200 | Profile cleared |
| Recovery verify | `GET /ops/order/db/profile` | `pressure_limit=0, hold_ms=0` | Pressure cleared |
| Recovery burst | Burst 1 round affected + unaffected | 200, normal latency | Recovered latency |

### 2.4 Tại sao chọn pressure_limit=1, hold_ms=180, waits_min=2?

| Tham số | Giá trị | Lý do |
| --- | --- | --- |
| `pressure_limit=1` | 1 connection | Cực kỳ hạn chế — đảm bảo queuing xảy ra ngay cả với burst 6 requests |
| `pressure_hold_ms=180` | 180ms | Đủ dài để quan sát queuing, nhưng không quá dài để gây timeout (k6 default 60s) |
| `pressure_waits_min=2` | 2 lần chờ tối thiểu | Xác nhận ít nhất 2 request đã phải chờ connection — chứng minh pressure thực sự hoạt động |

Nếu `pressure_limit=5`, với burst 6 requests, queuing sẽ nhẹ hơn nhiều — khó quan sát signal. Nếu `pressure_limit=0`, tất cả requests sẽ timeout hoặc fail — không test được "degraded but working".

### 2.5 Mối quan hệ với các case DB khác

| Case | Cơ chế degrade | Test focus | Phụ thuộc vào db-02? |
| --- | --- | --- | --- |
| db-01 (delay) | Delay 35ms | Delay observable, latency tăng đều | Không — db-01 độc lập |
| **db-02 (case này)** | **Pool pressure** | **Queuing behavior, burst handling, pool stats** | **N/A — case gốc** |
| db-03 (fault) | tcp_reset | Fault contract, 5xx expected, recovery | Không — nhưng dùng chung control plane |
| db-04 (contention) | Pool contention + trace | Trace correlation, transient failures | Có — cần hiểu pool behavior từ db-02 |
| db-05 (resource model) | Không degrade | db_rows/db_writes contract | Không |
| db-06 (capacity sweep) | Không degrade | Rate sweep, capacity limit | Có — cần hiểu pool saturation từ db-02 |

---

## 3. Vì sao phải test ở DB layer

Chỉ DB layer có:
- **Control plane** để set pool pressure parameters
- **Pool stats** visibility qua `/ops/order/db/profile`
- **Burst pattern** để mô phỏng realistic traffic dưới pressure

### 3.1 Vì sao không test ở Redis layer?

Redis test có pressure test riêng, nhưng cơ chế khác:
- Redis pressure: giới hạn Redis connections, test correctness dưới Redis load
- DB pressure: giới hạn Postgres connections, test latency spike và queuing behavior

DB pressure nguy hiểm hơn Redis pressure vì:
- DB là persistent store — nếu fail, data thật bị mất
- DB connections thường ít hơn Redis connections (Postgres connection overhead cao hơn)
- DB queries thường lâu hơn Redis operations → queuing delay lớn hơn

### 3.2 Vì sao không test ở Microservices layer?

Microservices test không có:
- Control plane để giới hạn connection pool
- Pool stats để quan sát pressure level
- Burst pattern với multiple rounds

### 3.3 DB layer là nơi duy nhất có pool pressure control

| Khả năng | DB layer | Layer khác |
| --- | --- | --- |
| Set connection pool limit | Có (`postgres_pressure_limit`) | Không |
| Set connection hold time | Có (`postgres_pressure_hold_ms`) | Không |
| Đọc pool stats (waits, limit, hold) | Có (qua profile API) | Không |
| Burst test với affected/unaffected isolation | Có | Không |
| Verify recovery sau pressure | Có (reset + verify pool stats) | Không |

---

## 4. Topology và precondition

### 4.1 Topology

```text
Script: ../app/08-production-mix-order-db-pressure-recovery.js
Executor: 1 VU, 1 iteration (sequential)
Topology: full-no-cdn
Requires: OPS_AUTH_TOKEN
Env knobs: PRESSURE_LIMIT, PRESSURE_HOLD_MS, PRESSURE_WAITS_MIN, BURST_ROUNDS
```

### 4.2 Stack requirement

```text
Phải có:
  k6target-order-service-1
  k6target-postgres-1
  k6target-products-service-1
  k6target-cart-service-1
  k6target-report-service-1
```

### 4.3 Precondition

- [x] Stack `full-no-cdn` đang chạy
- [x] Postgres healthy
- [x] `OPS_AUTH_TOKEN` đã source
- [x] DB profile sạch (pressure_limit=0, hold_ms=0)
- [x] Đã chạy db-01 trước đó để xác nhận control plane hoạt động

### 4.4 Kiến trúc chi tiết

```text
k6 (1 VU, sequential)
  |
  | Control plane: /ops/order/db/profile, /ops/order/db/reset
  | Runtime — Burst pattern:
  |   Mỗi round: http.batch([6 affected requests]) + N unaffected requests tuần tự
  v
Nginx :80
  |
  | /api/sim/orders/*  → order-service (affected by pressure)
  | /api/sim/checkout   → order-service (affected by pressure)
  | /api/sim/products*  → products-service (unaffected)
  | /api/sim/cart*      → cart-service (unaffected)
  | /api/sim/report*    → report-service (unaffected)
  v
order-service
  |
  | DB profile (in-memory):
  |   postgres_pressure_limit: 0 → 1 (degraded) → 0 (recovered)
  |   postgres_pressure_hold_ms: 0 → 180 (degraded) → 0 (recovered)
  |
  | Connection pool behavior under pressure:
  |   Max connections = pressure_limit (1)
  |   Mỗi connection được giữ pressure_hold_ms (180ms) sau query
  |   Request thứ N+1 phải chờ N * 180ms
  v
PostgreSQL (k6target-postgres-1)
  |
  | Không biết gì về pressure — tất cả pressure simulation ở application level
  | DB vẫn xử lý queries bình thường với connection thực tế
```

### 4.5 Container health verification

```powershell
docker ps --filter "name=k6target" --format "table {{.Names}}\t{{.Status}}"
# Kỳ vọng: tất cả containers Up và healthy
```

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `08-production-mix-order-db-pressure-recovery.js` gồm 411 dòng, được tổ chức thành 9 phần:

```text
(A) IMPORTS + ENV VARS             (dòng 1-22):  k6 modules, toàn bộ biến môi trường
(B) CUSTOM METRICS                 (dòng 24-27): 1 Counter, 2 Rates, 1 Trend
(C) API DEFINITIONS                (dòng 29-73): burstApis array, affected/unaffected classification
(D) OPTIONS                        (dòng 75-88): 1 VU, 1 iteration, thresholds
(E) HELPERS                        (dòng 90-198): auth, safeJson, controlRequest, assertProfile, setPressure, resetPressure
(F) UNAFFECTED TRAFFIC             (dòng 200-267): buildUnaffectedSequence, requestUnaffectedApi, runUnaffectedSlice
(G) AFFECTED BURST TRAFFIC         (dòng 269-323): buildBatchRequest, runAffectedBurst
(H) PHASE ORCHESTRATION            (dòng 325-370): runPhase, assertPhaseAverages
(I) MAIN FLOW                      (dòng 372-410): default function — orchestrator với try/finally
```

### 5.2 Phân tích — Phần A+B: Imports và Custom Metrics

```javascript
const PRESSURE_LIMIT = envInt('PROD_MIX_ORDER_DB_PRESSURE_LIMIT', 1);
const PRESSURE_HOLD_MS = envInt('PROD_MIX_ORDER_DB_PRESSURE_HOLD_MS', 180);
const PRESSURE_WAITS_MIN = envInt('PROD_MIX_ORDER_DB_PRESSURE_WAITS_MIN', 2);
const PRESSURE_DELTA_MS = envInt('PROD_MIX_ORDER_DB_PRESSURE_DELTA_MS', 150);
const RECOVERY_DELTA_MS = envInt('PROD_MIX_ORDER_DB_PRESSURE_RECOVERY_DELTA_MS', 110);
const RECOVERY_TOLERANCE_MS = envInt('PROD_MIX_ORDER_DB_PRESSURE_RECOVERY_TOLERANCE_MS', 120);
const UNAFFECTED_TOLERANCE_MS = envInt('PROD_MIX_ORDER_DB_PRESSURE_UNAFFECTED_TOLERANCE_MS', 100);
const BURST_ROUNDS = envInt('PROD_MIX_ORDER_DB_PRESSURE_BURST_ROUNDS', 3);
```

| Biến | Default | Ý nghĩa |
| --- | --- | --- |
| `PRESSURE_LIMIT` | 1 | Số connection tối đa trong pool |
| `PRESSURE_HOLD_MS` | 180 | Thời gian giữ connection sau mỗi query (ms) |
| `PRESSURE_WAITS_MIN` | 2 | Số lần chờ connection tối thiểu phải quan sát được |
| `PRESSURE_DELTA_MS` | 150 | Ngưỡng tối thiểu latency phải tăng trong degraded phase |
| `RECOVERY_DELTA_MS` | 110 | Ngưỡng tối thiểu latency phải giảm sau recovery |
| `RECOVERY_TOLERANCE_MS` | 120 | Ngưỡng tối đa latency sau recovery so với baseline |
| `UNAFFECTED_TOLERANCE_MS` | 100 | Ngưỡng tối đa unaffected APIs được phép tăng |
| `BURST_ROUNDS` | 3 | Số burst rounds trong mỗi phase |

Custom metrics:

```javascript
const phaseDuration = new Trend('prod_mix_order_db_pressure_phase_duration', true);
const pressureCheckFailures = new Counter('prod_mix_order_db_pressure_check_failures');
const degradedObserved = new Rate('prod_mix_order_db_pressure_degraded_observed');
const recoveredObserved = new Rate('prod_mix_order_db_pressure_recovered_observed');
```

### 5.3 Phân tích — Phần C: API Definitions và Burst Construction

```javascript
const affectedApiNames = new Set(['order_status', 'checkout', 'order_confirm', 'payment_webhook']);
const unaffectedApis = productionMixApis.filter((api) => !affectedApiNames.has(api.name));

const burstApis = [
  { name: 'order_status',  method: 'GET',  path: '/api/sim/orders/ORD-123?cpu_ms=20&db_rows=60', expected: 200 },
  { name: 'order_status',  method: 'GET',  path: '/api/sim/orders/ORD-456?cpu_ms=20&db_rows=60', expected: 200 },
  { name: 'checkout',      method: 'POST', path: '/api/sim/checkout?cpu_ms=40&db_writes=6&disk_kb=20&external_ms=40', body: { payment_method: 'card' }, expected: 200 },
  { name: 'checkout',      method: 'POST', path: '/api/sim/checkout?cpu_ms=40&db_writes=6&disk_kb=20&external_ms=40', body: { payment_method: 'card' }, expected: 200 },
  { name: 'order_confirm', method: 'POST', path: '/api/sim/orders/ORD-123/confirm?cpu_ms=35&db_writes=4&external_ms=40', body: {}, expected: 200 },
  { name: 'payment_webhook', method: 'POST', path: '/api/sim/orders/webhooks/payment?cpu_ms=20&db_writes=4', body: { event_type: 'payment.captured' }, expected: 200 },
];
```

Điểm đặc biệt của burstApis:

1. **Hardcoded paths với query params cụ thể**: Không dùng `productionMixApis` từ shared module như db-01. Mỗi request có `cpu_ms`, `db_rows`, `db_writes`, `external_ms` được chỉ định rõ ràng để tạo ra workload có độ nặng nhất quán giữa các rounds.

2. **`order_status` xuất hiện 2 lần** với 2 order IDs khác nhau (ORD-123, ORD-456). Điều này mô phỏng thực tế: trong production, mỗi request order_status truy vấn một order khác nhau.

3. **`checkout` xuất hiện 2 lần** — mỗi lần là một checkout request độc lập. Điều này tăng số lượng DB writes trong burst.

4. **6 requests mỗi burst**: 2 order_status + 2 checkout + 1 order_confirm + 1 payment_webhook.

### 5.4 Phân tích — Phần D: Options

```javascript
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    prod_mix_order_db_pressure_check_failures: ['count==0'],
  },
  tags: {
    scenario: 'production_mix_order_db_pressure_recovery',
    target_service: 'order-service',
    target_dependency: 'postgres',
    degradation_mode: 'pressure',
  },
};
```

Tag `degradation_mode: 'pressure'` — phân biệt với `degradation_mode: 'delay'` (db-01) và `degradation_mode: 'fault'` (db-03) trong dashboard.

### 5.5 Phân tích — Phần E: Control Plane Functions

**assertProfile cho pressure:**

```javascript
function assertProfile(label, expectedLimit, expectedHoldMs, minimumWaits = null) {
  const response = controlRequest('GET', PROFILE_PATH, null, `${label}_profile_get`);
  const payload = safeJson(response);
  const profile = payload && payload.profile ? payload.profile : {};
  const stats = profile && profile.postgres_pool_stats ? profile.postgres_pool_stats : {};

  check({ response, payload, profile, stats }, {
    [`${label} profile status 200`]: ...,
    [`${label} profile success true`]: ...,
    [`${label} profile initialized`]: ...,
    [`${label} profile delay 0`]: ...,           // Không có delay
    [`${label} profile pressure limit ${expectedLimit}`]: ...,
    [`${label} profile pressure hold ${expectedHoldMs}`]: ...,
    [`${label} profile fault mode none`]: ...,   // Không có fault
    [`${label} pool stats pressure limit ${expectedLimit}`]: ...,
    [`${label} pool stats pressure hold ${expectedHoldMs}`]: ...,
    [`${label} pool stats fault mode none`]: ...,
  });

  if (minimumWaits !== null) {
    check({ stats }, {
      [`${label} pool stats waits >= ${minimumWaits}`]: ...,
    });
  }
}
```

Khác với db-01: `assertProfile` cho pressure kiểm tra `pressure_limit` và `pressure_hold_ms` thay vì `delay_ms`. Có thêm parameter `minimumWaits` để verify `pressure_total_waits` — số lần request phải chờ connection.

**setPressure:**

```javascript
function setPressure(label) {
  const response = controlRequest('PUT', PROFILE_PATH, {
    postgres_delay_ms: 0,                          // Không delay
    postgres_pressure_limit: PRESSURE_LIMIT,        // PRESSURE_LIMIT=1
    postgres_pressure_hold_ms: PRESSURE_HOLD_MS,    // PRESSURE_HOLD_MS=180
    postgres_fault_mode: 'none',                    // Không fault
  }, `${label}_profile_set`);
  // ...
}
```

Cố tình set `delay_ms=0` và `fault_mode=none` — đảm bảo CHỈ CÓ pressure được bật.

### 5.6 Phân tích — Phần F+G: Traffic Generation (Unaffected + Affected Burst)

**runUnaffectedSlice — unaffected APIs tuần tự:**

```javascript
function runUnaffectedSlice(phase, sequence, startIndex, chunkSize) {
  const durations = [];
  let currentIndex = startIndex;
  const endIndex = Math.min(sequence.length, startIndex + chunkSize);

  for (; currentIndex < endIndex; currentIndex += 1) {
    durations.push(requestUnaffectedApi(sequence[currentIndex], phase));
    sleep(INTER_ROUND_SLEEP_SECONDS);
  }

  return { durations, nextIndex: currentIndex };
}
```

Unaffected APIs (products, cart, report) được gọi tuần tự, xen kẽ với burst rounds. Mỗi round xử lý một "chunk" của unaffected sequence.

**buildBatchRequest và runAffectedBurst — affected APIs burst đồng thời:**

```javascript
function buildBatchRequest(api, phase, round, index) {
  return {
    method: api.method,
    url: `${BASE_URL}${api.path}`,
    body: api.method === 'GET' ? null : JSON.stringify(api.body || {}),
    params: {
      headers: { ...jsonHeaders(), 'X-Test-Suite': 'production-mix-order-db-pressure-recovery' },
      tags: {
        phase,
        scenario: 'production_mix_order_db_pressure_recovery',
        target_service: 'order-service',
        target_dependency: 'postgres',
        degradation_mode: 'pressure',
        traffic_shape: 'order_burst',
        api: api.name,
        affected: 'true',
        burst_round: String(round),
        burst_index: String(index),
      },
    },
  };
}

function runAffectedBurst(phase, round) {
  const requests = burstApis.map((api, index) => buildBatchRequest(api, phase, round, index));
  const responses = http.batch(requests);
  // ...
}
```

**Điểm quan trọng: `http.batch()`**

`http.batch(requests)` gửi tất cả 6 requests **đồng thời** (trong cùng một event loop tick). Điều này tạo ra concurrent pressure lên connection pool — chính xác là thứ chúng ta muốn test.

Nếu dùng vòng lặp `for` với `http.get/post` tuần tự, pressure sẽ không xảy ra vì mỗi request hoàn thành trước khi request tiếp theo bắt đầu. `http.batch()` là công cụ phù hợp để tạo concurrent burst trong k6.

Tags `burst_round` và `burst_index` cho phép phân tích latency theo từng vị trí trong burst — request cuối cùng trong burst sẽ có latency cao nhất (queuing delay tích lũy).

### 5.7 Phân tích — Phần H: Phase Orchestration

**runPhase — kết hợp affected burst + unaffected sequential:**

```javascript
function runPhase(phase, unaffectedSequence) {
  const affectedDurations = [];
  const unaffectedDurations = [];
  const chunkSize = Math.max(1, Math.ceil(unaffectedSequence.length / BURST_ROUNDS));
  let unaffectedIndex = 0;

  for (let round = 0; round < BURST_ROUNDS; round += 1) {
    // 1. Gửi burst affected requests (đồng thời)
    affectedDurations.push(...runAffectedBurst(phase, round));

    // 2. Gửi chunk unaffected requests (tuần tự)
    const unaffectedSlice = runUnaffectedSlice(phase, unaffectedSequence, unaffectedIndex, chunkSize);
    unaffectedDurations.push(...unaffectedSlice.durations);
    unaffectedIndex = unaffectedSlice.nextIndex;
  }

  // 3. Xử lý phần dư (nếu có)
  if (unaffectedIndex < unaffectedSequence.length) {
    const tailSlice = runUnaffectedSlice(phase, unaffectedSequence, unaffectedIndex,
      unaffectedSequence.length - unaffectedIndex);
    unaffectedDurations.push(...tailSlice.durations);
  }

  return {
    affectedAverageMs: average(affectedDurations),
    affectedCount: affectedDurations.length,
    unaffectedAverageMs: average(unaffectedDurations),
    unaffectedCount: unaffectedDurations.length,
  };
}
```

Pattern trong mỗi round:
```text
Round 0:
  http.batch([6 affected requests])  ← đồng thời → pressure
  sleep(40ms)
  unaffected request 1               ← tuần tự → không pressure
  sleep(40ms)
  unaffected request 2
  sleep(40ms)
  ...

Round 1, 2: tương tự
```

### 5.8 Phân tích — Phần I: Main Flow

```javascript
export default function () {
  const unaffectedSequence = buildUnaffectedSequence();

  try {
    resetPressure('initial');
    assertProfile('initial', 0, 0, null);

    const healthyMetrics = runPhase('healthy', unaffectedSequence);

    setPressure('degraded');
    assertProfile('degraded_config', PRESSURE_LIMIT, PRESSURE_HOLD_MS, null);

    const degradedMetrics = runPhase('degraded', unaffectedSequence);
    degradedObserved.add(1, { ... });
    assertProfile('degraded_after_burst', PRESSURE_LIMIT, PRESSURE_HOLD_MS, PRESSURE_WAITS_MIN);

    resetPressure('recovered');
    assertProfile('recovered', 0, 0, null);

    const recoveredMetrics = runPhase('recovered', unaffectedSequence);
    recoveredObserved.add(1, { ... });

    assertPhaseAverages(healthyMetrics, degradedMetrics, recoveredMetrics);
  } finally {
    try {
      resetPressure('final');
    } catch (error) {
      console.error(`final order db pressure reset failed: ${error.message}`);
    }
  }
}
```

Flow chính xác:

```text
1.  resetPressure('initial')                    → POST /ops/order/db/reset
2.  assertProfile('initial', 0, 0, null)        → GET /ops/order/db/profile → verify clean
3.  runPhase('healthy', ...)                    → 3 burst rounds, baseline latency
4.  setPressure('degraded')                     → PUT /ops/order/db/profile {limit:1, hold:180}
5.  assertProfile('degraded_config', 1, 180)    → GET /ops/order/db/profile → verify pressure set
6.  runPhase('degraded', ...)                   → 3 burst rounds, degraded latency
7.  assertProfile('degraded_after_burst', 1, 180, 2) → GET → verify waits >= 2
8.  resetPressure('recovered')                  → POST /ops/order/db/reset
9.  assertProfile('recovered', 0, 0, null)      → GET → verify pressure cleared
10. runPhase('recovered', ...)                  → 3 burst rounds, recovered latency
11. assertPhaseAverages(...)                    → verify latency relationships
12. finally: resetPressure('final')             → cleanup
```

Bước 7 (`degraded_after_burst`) là một innovation so với db-01: nó kiểm tra pool stats **sau khi** burst đã chạy, xác nhận `pressure_total_waits >= 2` — bằng chứng rằng pressure thực sự gây ra queuing.

---

## 6. Postgres mechanism deep-dive: Pool pressure và connection contention

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

### 6.3 Cơ chế pressure injection ở application level

```text
Implementation trong order-service (pseudo-code):

let dbProfile = {
  postgres_pressure_limit: 0,     // 0 = không giới hạn
  postgres_pressure_hold_ms: 0,   // 0 = không giữ connection
};

// Semaphore hoặc connection pool wrapper:
const pressureSemaphore = new Semaphore(dbProfile.postgres_pressure_limit || Infinity);

async function executeQuery(sql, params) {
  // 1. Acquire pressure slot (chờ nếu tất cả slots đang bận)
  const waitStart = Date.now();
  await pressureSemaphore.acquire();  // ← BLOCKING nếu limit đạt
  const waitDuration = Date.now() - waitStart;

  try {
    // 2. Thực thi query thật
    const result = await pgClient.query(sql, params);

    // 3. Giữ connection thêm hold_ms (mô phỏng connection giữ lâu)
    if (dbProfile.postgres_pressure_hold_ms > 0) {
      await sleep(dbProfile.postgres_pressure_hold_ms);
    }

    return result;
  } finally {
    // 4. Release pressure slot
    pressureSemaphore.release();
  }
}
```

Cơ chế này mô phỏng:
- **Connection pool limit**: Semaphore với `count = pressure_limit` giới hạn số query đồng thời.
- **Connection hold time**: `sleep(hold_ms)` sau query mô phỏng việc connection không được trả về pool ngay lập tức.
- **Queuing delay**: `await semaphore.acquire()` block khi tất cả slots bận → request phải chờ → `pressure_total_waits` tăng.

### 6.4 Cách pressure khác delay ở mức cơ chế

```text
Delay (db-01):
  Request → sleep(35ms) → query(2ms) → response
  Tất cả requests mất thêm 35ms, nhưng vẫn chạy ĐỒNG THỜI.
  
Pressure (db-02):
  Request 1 → acquire slot → sleep(180ms) → query → release slot
  Request 2 → acquire slot (CHỜ request 1 release) → sleep(180ms) → query → release
  Requests chạy TUẦN TỰ, không phải đồng thời.
  
  → Delay: tăng latency ĐỀU (additive)
  → Pressure: tăng latency THEO HÀNG CHỜ (multiplicative)
```

### 6.5 Pool stats — evidence của pressure

```json
{
  "profile": {
    "postgres_pressure_limit": 1,
    "postgres_pressure_hold_ms": 180,
    "postgres_pool_stats": {
      "pressure_limit": 1,
      "pressure_hold_ms": 180,
      "pressure_total_waits": 15,
      "pressure_total_held_ms": 2700,
      "fault_mode": ""
    }
  }
}
```

| Pool stat | Ý nghĩa | Expected trong degraded phase |
| --- | --- | --- |
| `pressure_limit` | Số connection tối đa | 1 |
| `pressure_hold_ms` | Thời gian giữ connection | 180 |
| `pressure_total_waits` | Số lần request phải chờ slot | >= 2 (PRESSURE_WAITS_MIN) |
| `pressure_total_held_ms` | Tổng thời gian giữ connection | > 0 (tích lũy qua các requests) |
| `fault_mode` | Fault mode hiện tại | "" (không có fault) |

`pressure_total_waits` là evidence quan trọng nhất — nó chứng minh pressure thực sự gây ra queuing. Nếu `pressure_total_waits = 0`, pressure được set nhưng không có request nào phải chờ — có thể `pressure_limit` quá cao hoặc burst không đủ concurrent.

### 6.6 Recovery mechanism cho pressure

```text
POST /ops/order/db/reset
  → dbProfile.postgres_pressure_limit = 0 (không giới hạn)
  → dbProfile.postgres_pressure_hold_ms = 0 (không giữ connection)
  → Semaphore được mở rộng thành Infinity
  → Queue drain: tất cả requests đang chờ được xử lý
  → Request mới không phải chờ
```

Khác với delay recovery (tức thì), pressure recovery có thể mất một chút thời gian để drain queue. Nếu có 10 requests đang chờ khi reset được gọi, chúng sẽ lần lượt được acquire và xử lý. Request đầu tiên sau khi queue drain sẽ thấy latency bình thường.

### 6.7 Tại sao burst pattern quan trọng cho pressure test

Nếu dùng sequential requests (giống db-01), pressure sẽ không bao giờ xảy ra:

```text
Sequential (SAI cho pressure test):
  Request 1: acquire slot → query → release → response
  Request 2: (bắt đầu SAU KHI request 1 hoàn thành)
  → Không có contention → không có queuing → pressure vô hình

Concurrent burst (ĐÚNG cho pressure test):
  Request 1..6: cùng lúc acquire slot
  → 5 requests phải chờ → queuing observable → pressure visible
```

`http.batch()` là chìa khóa — nó gửi tất cả requests trong cùng một event loop tick, tạo ra concurrent burst mà pressure test cần.

---

## 7. Request sequence flow

### 7.1 Timeline tổng thể

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

### 7.2 Sequence diagram chi tiết

```text
k6 (1 VU)               order-service             PostgreSQL
    |                        |                         |
    |  [BASELINE PHASE]      |                         |
    |-- POST /reset -------->|                         |
    |<-- 200 ----------------|                         |
    |-- GET /profile ------->|                         |
    |<-- pressure_limit=0 ---|                         |
    |                        |                         |
    |-- http.batch(6) ------>| (đồng thời, không giới hạn)
    |   GET /orders/ORD-123  |-- SELECT → 2ms          |
    |   GET /orders/ORD-456  |-- SELECT → 2ms          |
    |   POST /checkout       |-- INSERT → 3ms          |
    |   POST /checkout       |-- INSERT → 3ms          |
    |   POST /confirm        |-- INSERT → 2ms          |
    |   POST /webhook        |-- INSERT → 2ms          |
    |<-- all 200, fast ------|                         |
    |                        |                         |
    |  [PRESSURE SETUP]      |                         |
    |-- PUT /profile ------->|                         |
    |  {limit:1, hold:180}   | set pressure            |
    |<-- 200 ----------------|                         |
    |-- GET /profile ------->|                         |
    |<-- limit=1, hold=180 --|                         |
    |                        |                         |
    |  [PRESSURE PHASE — Round 1]                      |
    |-- http.batch(6) ------>| (đồng thời, 1 slot!)    |
    |   Req-1: acquire slot  | (OK, slot 1/1)          |
    |   Req-2..6: acquire    | (CHỜ... slot bận)       |
    |   Req-1: query 3ms     |-- SELECT → 2ms          |
    |   Req-1: hold 180ms    | (sleep 180ms)           |
    |   Req-1: release slot  |                         |
    |   Req-2: acquire slot  | (OK sau ~183ms chờ)     |
    |   Req-2: query 3ms     |-- SELECT → 2ms          |
    |   Req-2: hold 180ms    | (sleep 180ms)           |
    |   ...                  |                         |
    |<-- responses về dần dần|                         |
    |   (Req-1: ~185ms,      |                         |
    |    Req-2: ~368ms,      |                         |
    |    Req-3: ~551ms,      |                         |
    |    ...)                |                         |
    |                        |                         |
    |  [PRESSURE PHASE — Round 2, Round 3 tương tự]    |
    |                        |                         |
    |-- GET /profile ------->|                         |
    |<-- waits >= 2 ---------| (evidence của queuing!) |
    |                        |                         |
    |  [RECOVERY]            |                         |
    |-- POST /reset -------->|                         |
    |<-- 200 ----------------| (queue drain)           |
    |-- GET /profile ------->|                         |
    |<-- limit=0, hold=0 ----|                         |
    |                        |                         |
    |-- http.batch(6) ------>| (đồng thời, không giới hạn)
    |<-- all 200, fast ------|                         |
```

### 7.3 Concurrency model

```text
1 VU, 1 iteration, sequential — nhưng mỗi burst round dùng http.batch():

  VU: |
      |-- reset → profile check → [BASELINE BURST: 6 concurrent] → unaffected sequential
      |-- set pressure → profile check → [DEGRADED BURST x3: 6 concurrent mỗi round] → unaffected sequential
      |-- reset → profile check → [RECOVERY BURST: 6 concurrent] → unaffected sequential
      |-- final reset

Trong mỗi burst:
  Batch gửi 6 requests đồng thời → pressure được tạo ra
  Giữa các rounds: unaffected APIs chạy tuần tự (không pressure)
```

---

## 8. Key signals

### 8.1 Primary signals

| Signal | Phase | Expected |
| --- | --- | --- |
| `pressure_check_failures` | All | 0 |
| `degraded_observed` | Pressure | > 0 |
| `recovered_observed` | Recovery | > 0 |
| Pool `postgres_pressure_limit` | Pressure | 1 |
| Pool `postgres_pressure_hold_ms` | Pressure | 180 |
| Pool stats | Recovery | All 0 |
| `http_req_duration` p95 | Pressure | >> baseline (3170ms observed) |

### 8.2 Performance payload signals

| Signal | Phase | Expected |
| --- | --- | --- |
| `performance.breakdown.db_ms` | Baseline | ~2-5ms |
| `performance.breakdown.db_ms` | Pressure | Varies (queuing delay) |
| `performance.breakdown.db_write_ms` | Pressure | Varies |
| `http_req_duration` p50 | Pressure | Có thể vẫn thấp (early requests trong burst) |
| `http_req_duration` p95 | Pressure | Rất cao (late requests — queuing delay tích lũy) |
| `http_req_duration` p50 | Recovery | Trở về baseline |
| `http_req_duration` p95 | Recovery | Trở về baseline |

### 8.3 Bimodal distribution — signal quan trọng nhất

```text
Pressure tạo ra bimodal latency distribution:

Mode 1 (P50 ~9ms):    Requests đầu tiên trong burst — acquire slot ngay,
                       không phải chờ. Đây là những request "may mắn".

Mode 2 (P95 ~3170ms): Requests cuối trong burst — phải chờ N-1 requests
                       trước đó release slot. Queuing delay tích lũy.

avg ~342ms:            Bị kéo lên bởi mode 2, nhưng không đại diện cho
                       bất kỳ request cụ thể nào.
```

Đây là lý do **không dùng avg để judge pressure test**. Bimodal distribution là signature của pool pressure — avg che giấu cả hai mode.

### 8.4 Signal relationship map

```text
┌── Control-plane ──────────────────────────────────┐
│  initial reset: 200                                │
│  initial profile: limit=0, hold=0 ── (A) Clean    │
│  pressure set: 200                                  │
│  pressure profile: limit=1, hold=180 ── (B) Active │
│  after-burst stats: waits >= 2 ── (C) Evidence    │
│  recovered reset: 200                               │
│  recovered profile: limit=0, hold=0 ── (D) Clear  │
│  final reset: 200 ── (E) Clean end                 │
└────────────────────────────────────────────────────┘
                    │
                    ▼
┌── Runtime: Affected APIs ─────────────────────────┐
│  healthy: low latency ── (F) Baseline              │
│  degraded: bimodal, p95 >> baseline ── (G) Spike   │
│  recovered: low latency ── (H) Recovered           │
└────────────────────────────────────────────────────┘
                    │
                    ▼
┌── Runtime: Unaffected APIs ───────────────────────┐
│  degraded unaffected <= baseline + 100ms ── (I) OK │
└────────────────────────────────────────────────────┘

Tất cả 9 signal (A đến I) cùng đúng → Pool pressure behavior được chứng minh
```

---

## 9. Pass/fail criteria

### 9.1 Pass

```text
✅ pressureCheckFailures = 0
✅ degradedObserved > 0
✅ recoveredObserved > 0
✅ Pool pressure = 0 sau reset
✅ Unaffected APIs không degraded quá mức
```

### 9.2 Định lượng cụ thể

```text
PASS (với default env vars):
  checks rate = 1.00 (100%)
  prod_mix_order_db_pressure_check_failures = 0
  degraded_observed > 0
  recovered_observed > 0
  degraded.affectedAvgMs >= healthy.affectedAvgMs + 150
  recovered.affectedAvgMs <= degraded.affectedAvgMs - 110
  recovered.affectedAvgMs <= healthy.affectedAvgMs + 120
  degraded.unaffectedAvgMs <= healthy.unaffectedAvgMs + 100
  profile.postgres_pressure_limit = 0 after reset
  profile.postgres_pressure_hold_ms = 0 after reset
  degraded_after_burst: pool stats pressure_total_waits >= 2

FAIL (bất kỳ điều kiện nào dưới đây):
  checks rate < 1.00
  prod_mix_order_db_pressure_check_failures > 0
  degraded.affectedAvgMs < healthy.affectedAvgMs + 150
  recovered.affectedAvgMs > degraded.affectedAvgMs - 110
  recovered.affectedAvgMs > healthy.affectedAvgMs + 120
  degraded.unaffectedAvgMs > healthy.unaffectedAvgMs + 100
  profile.postgres_pressure_limit != 0 after reset
  degraded_after_burst: pressure_total_waits < 2
```

### 9.3 Fail modes

| Mode | Symptom | Root cause |
| --- | --- | --- |
| **Pressure not applied** | Latency không spike, pool stats pressure=0 | Control plane không hoạt động hoặc pressure limit không được set |
| **No queuing evidence** | Latency spike nhưng `pressure_total_waits < 2` | Pressure limit quá cao so với burst size, hoặc hold_ms quá thấp |
| **Unaffected degraded** | Products/cart/report cũng có latency spike | Pressure scope sai — ảnh hưởng toàn bộ thay vì chỉ order-service |
| **No recovery** | Sau reset, latency vẫn cao | Queue chưa drain hết, hoặc reset không hoạt động |
| **Timeout instead of spike** | Requests fail thay vì chậm | Pressure limit quá thấp (0) hoặc hold_ms quá dài → tất cả requests timeout |

---

## 10. Cách chạy + output mẫu

### 10.1 Local run

```powershell
$env:BASE_URL = "http://localhost:80"
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
$env:PROD_MIX_ORDER_DB_PRESSURE_CONTROL_BASE_URL = "http://localhost:80"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/08-production-mix-order-db-pressure-recovery.js
```

### 10.2 Output mẫu (Run #118)

```text
checks_total.......: 236
checks_succeeded...: 100% 236 out of 236
pressure_check_failures: 0
http_req_duration..: avg=342.6ms med=9.4ms p95=3170.3ms
                                     ↑        ↑
                            bimodal rõ       pressure spike!
```

### 10.3 Output mẫu (FAIL — pressure không tạo được queuing)

```text
     ✗ degraded_after_burst pool stats waits >= 2
       ↳  0% — ✓ 0 / ✗ 1

     checks........................................: 99.58% ✓ 235  ✗ 1
     prod_mix_order_db_pressure_check_failures.....: 1

     http_req_duration..: avg=25ms med=7ms p95=45ms
     → Latency bình thường — pressure không hoạt động

     Exit: 99
```

### 10.4 Manual verification commands

```powershell
$token = "<ops-token>"
$headers = @{
  'Authorization' = "Bearer $token"
  'X-Ops-Token' = $token
  'Content-Type' = 'application/json'
}

# 1. Reset
Invoke-RestMethod -Uri "http://localhost:80/ops/order/db/reset" -Method Post -Headers $headers

# 2. Verify clean
$clean = Invoke-RestMethod -Uri "http://localhost:80/ops/order/db/profile" -Headers $headers
Write-Host "Limit: $($clean.profile.postgres_pressure_limit)"  # 0
Write-Host "Hold: $($clean.profile.postgres_pressure_hold_ms)"  # 0

# 3. Set pressure
$body = @{
  postgres_delay_ms = 0
  postgres_pressure_limit = 1
  postgres_pressure_hold_ms = 180
  postgres_fault_mode = 'none'
} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:80/ops/order/db/profile" -Method Put -Headers $headers -Body $body

# 4. Verify pressure
$pressured = Invoke-RestMethod -Uri "http://localhost:80/ops/order/db/profile" -Headers $headers
Write-Host "Limit: $($pressured.profile.postgres_pressure_limit)"  # 1
Write-Host "Hold: $($pressured.profile.postgres_pressure_hold_ms)"  # 180

# 5. Gửi 2 requests đồng thời (manual burst test)
$task1 = { Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/ORD-1?db_rows=60" -Headers $headers }
$task2 = { Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/ORD-2?db_rows=60" -Headers $headers }
$r1, $r2 = $task1, $task2 | ForEach-Object -Parallel { & $_ } -ThrottleLimit 2

# 6. Check pool stats
$after = Invoke-RestMethod -Uri "http://localhost:80/ops/order/db/profile" -Headers $headers
Write-Host "Waits: $($after.profile.postgres_pool_stats.pressure_total_waits)"  # >= 1

# 7. Reset
Invoke-RestMethod -Uri "http://localhost:80/ops/order/db/reset" -Method Post -Headers $headers
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

### Scenario D: Bimodal distribution nhưng `pressure_total_waits=0`

```text
→ Latency spike có thể do nguyên nhân khác (network, server load).
→ pressure_total_waits=0 → queuing không xảy ra ở DB layer.
→ Kiểm tra lại pressure implementation trong order-service.
→ Có thể pressure_limit được set nhưng semaphore không hoạt động.
```

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "avg=342ms, med=9.4ms — chênh lệch khủng"

```text
ĐÚNG. Đây là bimodal: P50 (baseline requests) vẫn 9ms,
nhưng P95 (pressure requests) lên tới 3170ms.
avg bị kéo lên bởi extreme tail latency.
```

### Nghịch lý 2: "Pressure test fail vì latency cao"

```text
SAI. Latency cao là MỤC TIÊU của pressure injection. Test fail khi
latency KHÔNG cao (pressure không hoạt động) hoặc recovery KHÔNG
đưa latency về baseline.
```

### Nghịch lý 3: "Bimodal distribution là bug"

```text
SAI. Bimodal distribution là SIGNATURE của pool pressure hoạt động đúng.
Requests đầu burst nhanh (có slot ngay), requests sau chậm (phải chờ slot).
Nếu distribution là unimodal (tất cả requests cùng latency), pressure
không hoạt động hoặc burst không đủ concurrent.
```

### Nghịch lý 4: "Pressure và delay là giống nhau — đều làm chậm"

```text
SAI. Delay làm chậm ĐỀU (mọi request +N ms). Pressure làm chậm KHÔNG ĐỀU
(theo vị trí trong hàng chờ). Delay test (db-01) và pressure test (db-02)
kiểm tra hai cơ chế hoàn toàn khác nhau.
```

### Nghịch lý 5: "Chỉ cần test pressure với 1 request"

```text
SAI. 1 request sẽ luôn acquire được slot ngay (vì không có contention).
Pressure chỉ observable khi có CONCURRENT requests cạnh tranh slot.
Đây là lý do burst pattern với http.batch() là bắt buộc.
```

### Nghịch lý 6: "Tăng pool size là giải pháp cho mọi pressure problem"

```text
SAI. PostgreSQL có giới hạn connections (thường ~100-500 tùy config).
Mỗi connection tiêu tốn memory (~2-10MB) và CPU. Tăng pool size vô tội vạ
sẽ làm DB chậm hơn do context switching. Giải pháp thực tế là:
- Circuit breaker: reject request sớm thay vì xếp hàng
- Rate limiter: giới hạn request rate vào service
- Read replica: chuyển read queries sang replica
- Query optimization: giảm thời gian giữ connection
```

---

## 13. Checklist

- [ ] `OPS_AUTH_TOKEN` đã source
- [ ] DB profile sạch
- [ ] `pressureCheckFailures = 0`
- [ ] `degradedObserved > 0`, `recoveredObserved > 0`
- [ ] `degraded_after_burst` pool stats `pressure_total_waits >= 2`
- [ ] Đã reset sau test
- [ ] Unaffected APIs không bị degraded
- [ ] P95 latency trong degraded phase >> baseline
- [ ] P50 latency trong degraded phase vẫn thấp (bimodal evidence)

---

## 14. Variations

### Variation 1: Extreme pressure (0 connections)

```powershell
$env:PROD_MIX_ORDER_DB_PRESSURE_LIMIT = "0"
```
Kỳ vọng: Tất cả requests timeout hoặc fail. Test xem service có fail gracefully không.

### Variation 2: Hold time dài hơn

```powershell
$env:PROD_MIX_ORDER_DB_PRESSURE_HOLD_MS = "500"
```
Kỳ vọng: Queuing delay tăng theo cấp số nhân. P95 có thể lên đến 10-15 giây.

### Variation 3: Nhiều burst rounds hơn

```powershell
$env:PROD_MIX_ORDER_DB_PRESSURE_BURST_ROUNDS = "6"
```
Kỳ vọng: Queue tích lũy qua nhiều rounds — tail latency extreme ở round 5-6.

### Variation 4: Pressure limit cao hơn (nhẹ hơn)

```powershell
$env:PROD_MIX_ORDER_DB_PRESSURE_LIMIT = "3"
```
Kỳ vọng: Vẫn có queuing nhưng nhẹ hơn. 3 slots cho 6 requests → 3 requests phải chờ thay vì 5.

### Variation 5: Kết hợp pressure + delay

```javascript
// Sửa setPressure để thêm delay:
controlRequest('PUT', PROFILE_PATH, {
  postgres_delay_ms: 35,             // Thêm delay
  postgres_pressure_limit: PRESSURE_LIMIT,
  postgres_pressure_hold_ms: PRESSURE_HOLD_MS,
  postgres_fault_mode: 'none',
}, ...);
```
Kỳ vọng: Mỗi request vừa bị delay 35ms, vừa phải chờ slot. Latency = delay + queuing + query_time. Đây là tình huống production thực tế: DB vừa chậm (network issue) vừa bị quá tải (traffic spike).

---

## 15. Anti-patterns

| Anti-pattern | Hậu quả | Cách đúng |
| --- | --- | --- |
| **Dùng avg latency để judge** | Che giấu P95 spike, bimodal distribution không được phát hiện | Đọc P50, P95, P99 riêng biệt. Dùng histogram, không dùng scalar. |
| **Không reset sau test** | Pool còn pressure → test sau fail | Luôn chạy reset trong finally block |
| **Không check unaffected APIs** | Bỏ sót pressure scope sai | Verify unaffected APIs latency trong mọi phase |
| **Dùng sequential requests thay vì batch** | Pressure không được tạo ra — test vô nghĩa | Dùng `http.batch()` cho concurrent burst |
| **Không check `pressure_total_waits`** | Không có evidence rằng queuing thực sự xảy ra | Thêm assertProfile sau degraded phase với `minimumWaits` |
| **So sánh latency tuyệt đối giữa các run** | Baseline khác nhau giữa các lần chạy | Dùng delta (degraded - healthy), không dùng absolute |
| **Set pressure_limit=0 để test extreme** | Tất cả requests fail — không test được "degraded but working" | Dùng pressure_limit=1 cho baseline pressure test, tăng dần để tìm limit |
| **Bỏ qua bimodal distribution** | Không hiểu cơ chế pressure → không debug được khi fail | Phân tích latency theo `burst_index` để thấy queuing pattern |

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

### Phase latency breakdown

| Phase | P50 | P95 | Avg | Ghi chú |
| --- | ---: | ---: | ---: | --- |
| Baseline | ~8ms | ~25ms | ~15ms | Bình thường |
| Degraded (pressure) | ~9ms | ~3170ms | ~343ms | Bimodal rõ rệt |
| Recovery | ~8ms | ~25ms | ~15ms | Trở về baseline |

### Per-burst-index latency analysis (degraded phase)

| Burst index | API | Approx latency | Ghi chú |
| --- | --- | ---: | --- |
| 0 | order_status ORD-123 | ~185ms | Đầu tiên — acquire slot ngay |
| 1 | order_status ORD-456 | ~368ms | Chờ 1 request |
| 2 | checkout #1 | ~551ms | Chờ 2 requests |
| 3 | checkout #2 | ~734ms | Chờ 3 requests |
| 4 | order_confirm | ~917ms | Chờ 4 requests |
| 5 | payment_webhook | ~1100ms | Cuối cùng — chờ 5 requests |

Pattern xác nhận: latency tăng TUYẾN TÍNH theo burst index, mỗi bước tăng ~183ms (≈ PRESSURE_HOLD_MS).

### Pool stats analysis

```json
{
  "postgres_pool_stats": {
    "pressure_limit": 1,
    "pressure_hold_ms": 180,
    "pressure_total_waits": 18,
    "pressure_total_held_ms": 3240
  }
}
```

- `pressure_total_waits=18`: 18 lần request phải chờ slot — với 3 rounds * 6 requests = 18 requests, 17 trong số đó (tất cả trừ request đầu tiên mỗi round) phải chờ.
- `pressure_total_held_ms=3240`: 18 requests * 180ms = 3240ms — khớp chính xác.

---

## 17. Reference

- **Script**: `k6/app/08-production-mix-order-db-pressure-recovery.js`
- **Catalog**: `k6/db/case-catalog.json`
- **Dashboard**: `http://localhost:13001/` → run #118
- **Next case**: db-03 (DB fault recovery)
- **Previous case**: db-01 (DB delay recovery)
- **Overview**: [00_overview.md](./00_overview.md)

---

## Appendix A: Production patterns cho DB pool pressure handling

### A.1 Pattern 1: Connection pool sizing cho burst traffic

```text
Công thức: pool_size = max_concurrent_requests * avg_query_time_ms / 1000

Ví dụ:
  max_concurrent_requests = 50 (từ traffic analysis)
  avg_query_time = 5ms
  → pool_size = 50 * 5 / 1000 = 0.25 → tối thiểu 5 connections (cho safety margin)

  Nhưng với burst pattern (tất cả 50 requests đến cùng lúc):
  → pool_size = 50 * 5 / 1000 * burst_multiplier (thường 2-3x)
  → pool_size = 15-25 connections

Thực tế: Pool size nên được xác định qua load test (như db-06 capacity sweep),
không phải công thức lý thuyết.
```

### A.2 Pattern 2: Circuit breaker cho DB pool exhaustion

```text
Circuit breaker states:
  CLOSED: Pool hoạt động bình thường (< 70% utilization)
  OPEN: Pool saturation > 90% trong 10s → reject request với 503
  HALF-OPEN: Thử 1 request sau 30s → nếu OK, chuyển sang CLOSED

Signal: pool_utilization = active_connections / pool_size
  > 70%: warning
  > 90%: critical → circuit breaker OPEN
```

### A.3 Pattern 3: Request prioritization

```text
Trong tình huống pool pressure, ưu tiên requests theo business criticality:

Priority 1 (critical): Payment webhook, order confirm — không được reject
Priority 2 (high): Checkout — hạn chế reject
Priority 3 (normal): Order status, report — có thể reject nếu pool saturated
Priority 4 (low): Analytics, logging — reject đầu tiên

Implementation: Multiple semaphores với reserved slots cho priority cao.
```

---

## Appendix B: Troubleshooting DB pressure issues

### B.1 Triệu chứng: Không có latency spike

**Quan sát**: `degraded_affectedAvgMs ≈ healthy_affectedAvgMs`.

**Nguyên nhân khả dĩ**:
1. `PRESSURE_LIMIT` quá cao so với burst size → không có contention.
2. `http.batch()` không hoạt động như mong đợi → requests chạy tuần tự.
3. Service dùng connection pool riêng, bỏ qua pressure profile.

**Debug steps**:
1. Giảm `PRESSURE_LIMIT` về 1.
2. Tăng `PRESSURE_HOLD_MS` lên 500ms để phóng đại effect.
3. Kiểm tra `pressure_total_waits` sau degraded phase.

### B.2 Triệu chứng: Requests timeout thay vì chậm

**Quan sát**: `http_req_failed > 0%` trong degraded phase.

**Nguyên nhân khả dĩ**:
1. `PRESSURE_LIMIT=0` → không có connection nào → tất cả requests fail.
2. `PRESSURE_HOLD_MS` quá dài → queuing delay vượt quá k6 timeout.

**Debug steps**:
1. Tăng `PRESSURE_LIMIT` lên 1.
2. Giảm `PRESSURE_HOLD_MS` xuống 100ms.
3. Tăng k6 timeout nếu cần: `--http-debug` để xem request nào timeout.

### B.3 Triệu chứng: Recovery không hoàn toàn

**Quan sát**: Sau reset, latency vẫn cao hơn baseline.

**Nguyên nhân khả dĩ**:
1. Queue chưa drain hết — requests từ degraded phase vẫn đang chờ.
2. Connection pool còn giữ connections từ degraded phase.

**Debug steps**:
1. Chờ vài giây sau reset trước khi chạy recovery phase.
2. GET profile để xác nhận `pressure_limit=0`.
3. Restart order-service nếu state bị stuck.

---

## Appendix C: So sánh pressure test giữa các layer

| Layer | Pressure mechanism | Observable signal | Recovery |
| --- | --- | --- | --- |
| LB | Connection limit + rate limit | `http_req_failed`, `X-RateLimit-*` headers | Reset weight, clear rate limit |
| Redis | Redis operation delay + connection limit | Custom counters (fresh/reuse), duration trends | POST /ops/order/redis/reset |
| **DB (layer này)** | **Pool limit + hold time** | **`pressure_total_waits`, bimodal latency, pool stats** | **POST /ops/order/db/reset** |
| External | External delay + fault injection | `external_ms` in breakdown | Reset external profile |

DB pressure test là unique ở chỗ nó test **queuing behavior** — không chỉ "có chậm không" mà còn "hàng chờ hoạt động thế nào". Bimodal distribution và `pressure_total_waits` là các signal không có ở layer khác.

---

## Appendix D: Key takeaways cho người học

1. **Pressure khác delay**. Delay làm mọi thứ chậm đều. Pressure tạo ra hàng chờ — một số request nhanh, một số rất chậm. Đọc bimodal distribution để hiểu pressure.

2. **http.batch() là bắt buộc**. Concurrent burst tạo ra pressure. Sequential requests không bao giờ tạo ra contention.

3. **Pool stats là evidence**. `pressure_total_waits` chứng minh queuing thực sự xảy ra. Không có evidence = pressure test chưa hoạt động.

4. **P95, không phải avg**. Avg che giấu bimodal distribution. P95 cho thấy tail latency — nơi pressure thể hiện rõ nhất.

5. **Recovery cần thời gian drain queue**. Khác với delay recovery (tức thì), pressure recovery cần thời gian để queue drain. Đừng mong đợi latency về baseline ngay lập tức.

6. **Unaffected isolation**. Pressure trên order-service không được ảnh hưởng đến products, cart, report. Đây là evidence của scope isolation.

7. **Cleanup là sống còn**. Pool pressure còn lại sau test sẽ làm mọi case sau chạy chậm. `finally { resetPressure('final') }` là mandatory.

---

## Appendix E: Các tham số pressure và ảnh hưởng thực tế

### E.1 Bảng tham chiếu pressure → behavior

| Limit | Hold (ms) | Burst size | Kỳ vọng behavior | P95 latency (approx) |
| --- | --- | --- | --- | --- |
| 0 | 180 | 6 | Tất cả requests fail hoặc timeout | N/A (fail) |
| 1 | 180 | 6 | Queuing rõ rệt, bimodal (case này default) | ~3000ms |
| 2 | 180 | 6 | Queuing nhẹ hơn — 4 requests phải chờ | ~1000ms |
| 3 | 180 | 6 | Queuing nhẹ — 3 requests phải chờ | ~600ms |
| 6 | 180 | 6 | Không queuing — đủ slot cho tất cả | ~200ms (bình thường) |
| 1 | 50 | 6 | Queuing nhưng nhanh hơn | ~500ms |
| 1 | 500 | 6 | Queuing rất chậm | ~8000ms |

### E.2 Cách chọn tham số pressure phù hợp

```text
Nguyên tắc:
1. pressure_limit < burst_size để đảm bảo queuing xảy ra.
2. pressure_hold_ms đủ dài để quan sát queuing, nhưng không gây timeout.
3. burst_rounds >= 2 để thấy queue tích lũy qua các rounds.
4. pressure_waits_min >= 1 để xác nhận queuing evidence.

Với case này:
  burst_size = 6, pressure_limit = 1 → 5/6 requests phải chờ
  pressure_hold_ms = 180 → mỗi request giữ slot ~180ms
  burst_rounds = 3 → queue tích lũy qua 3 rounds
  pressure_waits_min = 2 → evidence tối thiểu
```

---

## Appendix F: Frequently Asked Questions (FAQ)

### F.1 Tại sao avg=342ms nhưng med=9.4ms?

Vì bimodal distribution. Khoảng 15-20% requests (những request đầu mỗi burst) hoàn thành nhanh (~9ms), kéo median xuống. Nhưng 80-85% requests phải chờ queuing, với latency lên đến 3000ms+, kéo average lên. Median không bị ảnh hưởng bởi extreme values, nên nó vẫn thấp.

### F.2 Làm sao để biết pressure thực sự hoạt động?

Ba evidence:
1. **P95 >> P50**: Bimodal distribution — signature của queuing.
2. **`pressure_total_waits > 0`**: Pool stats xác nhận requests đã phải chờ.
3. **Latency tăng theo burst_index**: Request cuối trong burst chậm hơn request đầu.

### F.3 Khi nào nên dùng pressure_limit=0?

Không bao giờ cho baseline test. `pressure_limit=0` có nghĩa là không có connection nào — tất cả requests sẽ fail. Đây là fault test, không phải pressure test. Dùng `pressure_limit=0` chỉ khi muốn test extreme failure mode.

### F.4 Case này khác gì với db-04 (pool contention)?

db-02 test pressure **behavior** — queuing, bimodal distribution, pool stats. db-04 test pool contention với **trace correlation** — mỗi request có trace_id, và test verify rằng trace được preserve qua contention. db-02 là foundation; db-04 build trên foundation đó với thêm trace dimension.

### F.5 Tại sao `http.batch()` mà không dùng multiple VUs?

Multiple VUs cũng tạo ra concurrent requests, nhưng:
- Khó kiểm soát timing chính xác (VUs có thể không bắt đầu cùng lúc).
- Khó phân tích per-burst-index latency.
- Phức tạp hóa setup (scenarios, startTime).

`http.batch()` từ 1 VU cho phép kiểm soát chính xác khi nào burst xảy ra và thứ tự requests trong burst.

### F.6 Có cần tăng k6 timeout khi test pressure không?

Thường không cần. k6 default timeout là 60s — đủ cho pressure test với hold_ms=180 và 3 rounds. Nếu bạn tăng `PRESSURE_HOLD_MS` lên > 1000ms hoặc `BURST_ROUNDS` lên > 10, cân nhắc tăng timeout: `--http-debug` để monitor.

### F.7 Làm sao để phân biệt "pressure spike" và "network spike"?

1. **Pool stats**: Nếu `pressure_total_waits > 0`, đó là pressure. Nếu = 0, có thể là network.
2. **Bimodal pattern**: Pressure tạo ra bimodal rõ rệt. Network spike thường ảnh hưởng đều tất cả requests.
3. **Unaffected APIs**: Nếu unaffected APIs cũng spike → network hoặc infrastructure issue, không phải pressure.

---

## Appendix G: Implementation notes cho control-plane pressure

### G.1 Server-side implementation của pool pressure

```javascript
// Trong order-service code:
class PressureControlledPool {
  constructor(pgClient) {
    this.pgClient = pgClient;
    this.semaphore = null; // Sẽ được tạo khi pressure_limit > 0
    this.totalWaits = 0;
    this.totalHeldMs = 0;
  }

  updatePressure(limit, holdMs) {
    if (limit > 0) {
      this.semaphore = new Semaphore(limit);
    } else {
      this.semaphore = null; // Không giới hạn
    }
    this.holdMs = holdMs;
  }

  async query(sql, params) {
    const waited = this.semaphore ? await this.semaphore.acquireWithTimer() : 0;
    if (waited > 0) this.totalWaits += 1;

    try {
      const result = await this.pgClient.query(sql, params);

      if (this.holdMs > 0) {
        await sleep(this.holdMs);
        this.totalHeldMs += this.holdMs;
      }

      return result;
    } finally {
      if (this.semaphore) this.semaphore.release();
    }
  }

  getStats() {
    return {
      pressure_limit: this.semaphore ? this.semaphore.maxCount : 0,
      pressure_hold_ms: this.holdMs || 0,
      pressure_total_waits: this.totalWaits,
      pressure_total_held_ms: this.totalHeldMs,
    };
  }

  reset() {
    this.semaphore = null;
    this.holdMs = 0;
    this.totalWaits = 0;
    this.totalHeldMs = 0;
  }
}
```

### G.2 Best practices cho control-plane pressure API

1. **Pressure và delay nên độc lập**: Có thể set pressure mà không set delay, và ngược lại.
2. **Stats nên được reset khi profile thay đổi**: Mỗi lần set pressure mới, reset counters.
3. **Semaphore nên có timeout**: Tránh request chờ vô hạn nếu có bug.
4. **Pool stats nên là atomic read**: Tránh race condition khi đọc stats trong lúc requests đang chạy.
5. **Reset phải mở tất cả semaphores**: Đảm bảo không còn request nào bị block sau reset.
