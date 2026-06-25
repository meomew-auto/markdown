# db-03 -- Order DB fault and recovery

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

### 1.4 Phân biệt với các case DB khác

Fault recovery (case này) là case nghiêm trọng nhất trong bộ 3 DB degradation cases. Bảng so sánh:

| Khía cạnh | db-01 (delay) | db-02 (pressure) | db-03 (fault — case này) |
| --- | --- | --- | --- |
| **Cơ chế** | Delay query execution | Giới hạn pool connection | Drop/reset connection |
| **Response** | 200 (chậm hơn) | 200 (có thể chậm) | **5xx intentional** |
| **Mục tiêu** | Đo latency impact | Đo throughput degradation | **Verify fail contract** |
| **Rủi ro nếu sai** | Không biết DB chậm | Không biết pool cạn | **Data corruption** |
| **Recovery** | Latency về baseline | Pool về bình thường | **Tất cả về 200** |

### 1.5 Tác động thực tế đến business

Khi DB fault xảy ra trong production, hậu quả có thể rất nghiêm trọng:

```text
Scenario A — Service fail đúng (CÓ 5xx):
  User đặt hàng → 502 Bad Gateway → User thấy lỗi, thử lại sau
  → Order KHÔNG được tạo → Không có charge → An toàn
  → Monitoring alert kích hoạt → Team on-call xử lý

Scenario B — Service nuốt lỗi (KHÔNG có 5xx):
  User đặt hàng → 200 OK (nhưng order không được lưu vào DB!)
  → Payment gateway charge thẻ thành công
  → Không có order record → Khách hàng bị mất tiền
  → Support ticket, chargeback, tổn thất uy tín
```

Đây chính là lý do fail contract testing là bắt buộc — không phải là "nice to have". Một service xử lý payment mà không verify được fail contract khi DB chết là một quả bom nổ chậm trong production.

### 1.6 Các tín hiệu cảnh báo sớm trong production

Trước khi DB thực sự "chết", thường có các dấu hiệu sau:

- **Connection timeout tăng dần**: Từ 5ms → 50ms → 500ms → timeout
- **Pool connection tăng**: Số connection active tăng đột biến
- **Slow query log**: Các query bình thường 2ms bỗng chạy 200ms
- **Replication lag**: Read replica bị lag > 5 giây
- **Disk I/O saturation**: Disk queue depth tăng cao

Case db-03 test kịch bản xấu nhất: DB đã chết hẳn, không còn cơ hội graceful degradation. Service phải fail ngay lập tức và rõ ràng.

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

### 2.4 Các khía cạnh capability chi tiết

Case này chứng minh 6 capability dimensions:

**C1 — Fault injection accuracy:**
Control plane inject fault mode chính xác vào order-service DB driver. Response từ `PUT /ops/order/db/profile` confirm `postgres_fault_mode` được set đúng giá trị (`tcp_reset` hoặc `dns_fail`). Profile payload phản ánh chính xác trạng thái hiện tại.

**C2 — Fail-fast behavior:**
Khi fault mode active, mọi query đến DB lập tức fail mà không retry. Service không cố gắng "chữa cháy" — fail ngay để bảo vệ data integrity. Response time trong fault window thường rất thấp (< 10ms) vì connection bị reject ngay lập tức thay vì timeout chờ đợi.

**C3 — Scope isolation:**
Chỉ các API gọi order-service DB bị ảnh hưởng (order_status, checkout, order_confirm, payment_webhook). Các API khác như products (dùng products-service DB) và report (dùng report-service DB) vẫn hoạt động bình thường với status 200.

**C4 — Fault pattern propagation:**
Response body chứa error message matching fault pattern:
- `tcp_reset`: pattern `/connection reset|reset by peer|forcibly closed/i`
- `dns_fail`: pattern `/no such host|name or service not known|server misbehaving/i`

Pattern matching đảm bảo lỗi được propagate đúng nguyên nhân gốc — không bị biến thành generic "internal server error".

**C5 — Payment path bypass:**
Trong fault window, payment-sensitive APIs (`checkout`, `order_confirm`) không gọi sang payment gateway — `external_ms = 0`, không có `dependency` field trong payload. Điều này ngăn chặn việc charge thẻ khi order không thể lưu vào DB.

**C6 — Full recovery:**
Sau `POST /ops/order/db/reset`, fault mode được clear hoàn toàn. Tất cả APIs trở về 200 với đầy đủ payment path. Latency trở về baseline (trong khoảng tolerance `RECOVERY_TOLERANCE_MS`, default 180ms).

### 2.5 So sánh capability với các layer khác

| Layer | Fault testing approach | Control plane |
| --- | --- | --- |
| **CDN** | Không có fault injection — test cache behavior | Không |
| **LB** | upstream failure simulation | Không (dùng app-level config) |
| **Microservices** | Service-level error injection | Có (`/ops/*/profile`) |
| **Redis** | Redis fault mode (`connection_refused`, `timeout`) | Có (`/ops/order/redis/profile`) |
| **DB (case này)** | Postgres fault mode (`tcp_reset`, `dns_fail`) | Có (`/ops/order/db/profile`) |

DB layer là layer duy nhất test cả 3 degradation dimensions (delay, pressure, fault) với full control plane support cho mỗi dimension.

---

## 3. Vì sao phải test ở DB layer

Chỉ DB layer mới có:
- **Control plane** để inject fault mode (`postgres_fault_mode`)
- **Fail contract verification**: 5xx expected vs 5xx bug — khác biệt nằm ở script expectations
- **Scope verification**: Affected vs unaffected APIs
- **Recovery verification**: Reset → tất cả 200

### 3.1 Không thể test ở layer khác

**CDN layer:** CDN chỉ cache HTTP response — không thể test behavior khi DB chết vì CDN không gọi DB. CDN test tập trung vào cache hit/miss, TTL, stale content.

**LB layer:** Load balancer test tập trung vào routing, retry, failover giữa các upstream. Không có khả năng inject DB fault.

**Microservices layer:** Có thể test service-level error nhưng không có control plane để inject DB fault mode có chủ đích. Microservices test verify request/response contract, không verify DB dependency behavior.

**Redis layer:** Redis test tập trung vào cache/state behavior — idempotency, claim, hotkey. Redis fault mode (`connection_refused`, `timeout`) test Redis dependency, không test Postgres dependency.

### 3.2 Tại sao cần cả 3 degradation dimensions

```text
Delay (db-01)  → DB vẫn hoạt động nhưng chậm → Service vẫn 200, latency tăng
Pressure (db-02) → Pool bị ép → Service vẫn 200, throughput giảm
Fault (db-03)  → DB chết hẳn → Service phải 5xx

Mỗi dimension test một khía cạnh khác nhau của resilience:
  - Delay: Service có chịu được DB chậm không?
  - Pressure: Service có quản lý pool connection không?
  - Fault: Service có fail đúng cách khi DB chết không?

Bỏ qua bất kỳ dimension nào cũng để lại lỗ hổng trong resilience testing.
```

### 3.3 Production incident mapping

Mỗi DB degradation dimension map đến một loại production incident thực tế:

| Dimension | Production incident | Tần suất |
| --- | --- | --- |
| Delay | DB server CPU spike, disk I/O saturation, lock contention | Cao (hàng tuần) |
| Pressure | Connection leak, pool exhaustion do batch job | Trung bình (hàng tháng) |
| **Fault** | **DB crash, network partition, failover fail** | **Thấp (vài lần/năm) nhưng impact cực lớn** |

Fault ít xảy ra nhất nhưng có impact nghiêm trọng nhất — đó là lý do case db-03 là bắt buộc trong mọi resilience test suite.

---

## 4. Topology và precondition

### 4.1 Topology diagram

```text
┌─────────────────────────────────────────────────────────┐
│                      k6 Script                           │
│  1 VU, 1 iteration (sequential production mix)          │
└────────────┬────────────────────────┬───────────────────┘
             │                        │
    ┌────────▼────────┐    ┌──────────▼──────────┐
    │  API Requests    │    │  Control Plane      │
    │  (GET/POST)      │    │  (PUT/POST/GET)     │
    │  port 80         │    │  port 80            │
    └────────┬────────┘    └──────────┬──────────┘
             │                        │
    ┌────────▼────────────────────────▼──────────┐
    │                 Nginx (port 80)             │
    │          Routes to upstream services        │
    └────────┬──────────────┬──────────┬─────────┘
             │              │          │
    ┌────────▼────┐  ┌──────▼───┐  ┌──▼──────────┐
    │order-service│  │products  │  │report-service│
    │  (affected) │  │(unaffect)│  │ (unaffected) │
    └──────┬──────┘  └────┬─────┘  └──────┬───────┘
           │              │               │
    ┌──────▼──────────────▼───────────────▼──────┐
    │              Postgres                       │
    │   (shared persistent store)                 │
    │   Fault mode injected via control plane     │
    └─────────────────────────────────────────────┘
```

### 4.2 Environment variables

| Variable | Default | Mô tả |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | API base URL |
| `PROD_MIX_ORDER_DB_FAULT_CONTROL_BASE_URL` | `BASE_URL` | Control plane base URL |
| `PROD_MIX_ORDER_DB_FAULT_PROFILE_PATH` | `/ops/order/db/profile` | Profile endpoint path |
| `PROD_MIX_ORDER_DB_FAULT_RESET_PATH` | `/ops/order/db/reset` | Reset endpoint path |
| `PROD_MIX_ORDER_DB_FAULT_MODE` | `dns_fail` | Fault mode: `tcp_reset` hoặc `dns_fail` |
| `PROD_MIX_ORDER_DB_FAULT_RECOVERY_TOLERANCE_MS` | `180` | Recovery latency tolerance (ms) |
| `PROD_MIX_ORDER_DB_FAULT_UNAFFECTED_TOLERANCE_MS` | `100` | Unaffected latency tolerance (ms) |
| `PROD_MIX_ORDER_DB_FAULT_INTER_REQUEST_SLEEP_SECONDS` | `0.04` | Sleep giữa các request |
| `PROD_MIX_ORDER_DB_FAULT_WEIGHT_DIVISOR` | `2` | Hệ số chia weight cho production mix |
| `OPS_AUTH_TOKEN` | (required) | Auth token cho control plane |

### 4.3 Preconditions

Trước khi chạy case này, các điều kiện sau phải được đáp ứng:

```text
[✓] Target stack đang chạy với profile full-no-cdn
[✓] Nginx, order-service, products-service, report-service, Postgres đều healthy
[✓] OPS_AUTH_TOKEN đã được inject (lấy từ docker exec hoặc platform)
[✓] DB profile đang ở trạng thái sạch (không delay, không pressure, không fault)
[✓] Production mix APIs hoạt động bình thường (tất cả 200)
[✓] Không có batch job hoặc background task nào đang chạy
[✓] Network giữa k6 và target stack thông suốt
```

### 4.4 Auth model

Control plane yêu cầu authentication qua `OPS_AUTH_TOKEN`. Token này được truyền qua 2 header:

```text
Authorization: Bearer <OPS_AUTH_TOKEN>
X-Ops-Token: <OPS_AUTH_TOKEN>
```

Cả 2 header đều được gửi trong mọi request đến control plane endpoints (`/ops/order/db/*`). Thiếu token → control plane trả về 401 → script fail.

Script validate sự tồn tại của `OPS_AUTH_TOKEN` từ environment. Nếu không có token, script vẫn chạy nhưng control plane requests sẽ fail với 401 — không phải là lỗi của fault mode test.

---

## 5. Script deep-dive

### 5.1 Tổng quan cấu trúc

Script `10-production-mix-order-db-fault-recovery.js` được tổ chức thành các phần:

```text
1. Imports và constants                  (dòng 1-21)
2. Custom metrics definition             (dòng 23-26)
3. Affected/unaffected API sets          (dòng 28-29)
4. k6 options + thresholds               (dòng 31-45)
5. Helper functions                      (dòng 47-197)
   - authHeaders(), jsonHeaders()
   - recordCheckFailure()
   - safeJson()
   - controlRequest()
   - expectedFaultPattern()
   - isServerFailure(), reportsPatternFailure()
   - assertProfile()
   - setFault(), resetFault()
   - buildProductionSequence()
   - average()
   - assertPaymentFields(), assertFaultPayload()
6. Core test functions                   (dòng 226-377)
   - requestMixApi()
   - runPhase()
   - assertPhaseMetrics()
7. default export (main)                (dòng 380-419)
```

### 5.2 Custom metrics

```javascript
const phaseDuration = new Trend('prod_mix_order_db_fault_phase_duration', true);
const faultCheckFailures = new Counter('prod_mix_order_db_fault_check_failures');
const degradedObserved = new Rate('prod_mix_order_db_fault_degraded_observed');
const recoveredObserved = new Rate('prod_mix_order_db_fault_recovered_observed');
```

**`phaseDuration` (Trend):** Ghi nhận duration của từng request, tagged với `phase`, `api`, `affected`. Dùng để so sánh latency giữa healthy, degraded, và recovered phases. Parameter `true` chỉ định đây là time-based trend.

**`faultCheckFailures` (Counter):** Đếm số lần check fail. **Đây là custom counter quan trọng nhất** — nó thay thế `http_req_failed` để judge pass/fail. Threshold: `count==0`.

**`degradedObserved` (Rate):** Xác nhận degraded phase đã thực sự chạy. Giá trị > 0 chứng tỏ fault mode đã được inject và script đã thực thi degraded phase.

**`recoveredObserved` (Rate):** Xác nhận recovered phase đã thực sự chạy. Giá trị > 0 chứng tỏ reset đã được thực hiện và script đã verify recovery.

### 5.3 Affected vs unaffected APIs

```javascript
const affectedApis = new Set(['order_status', 'checkout', 'order_confirm', 'payment_webhook']);
const paymentSensitiveApis = new Set(['checkout', 'order_confirm']);
```

**`affectedApis`:** Các API gọi order-service DB → bị ảnh hưởng bởi fault mode. Trong fault window, các API này PHẢI trả về 5xx.

**`paymentSensitiveApis`:** Tập con của affectedApis — các API liên quan đến payment. Trong fault window, các API này không được gọi sang payment gateway (vì order không thể lưu vào DB).

Các API KHÔNG có trong affectedApis (như `products`, `report`) là unaffected — chúng phải trả về 200 trong mọi phase.

### 5.4 Thresholds

```javascript
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    prod_mix_order_db_fault_check_failures: ['count==0'],
  },
  tags: {
    scenario: 'production_mix_order_db_fault_recovery',
    target_service: 'order-service',
    target_dependency: 'postgres',
    degradation_mode: 'fault_mode',
    fault_mode: FAULT_MODE,
  },
};
```

**Threshold quan trọng:**
- `checks: rate==1` — mọi check phải pass. Check fail sẽ được record qua `recordCheckFailure()`.
- `faultCheckFailures: count==0` — KHÔNG có bất kỳ fault check failure nào.
- **Không có threshold trên `http_req_failed`** — đây là chủ ý. `http_req_failed` được phép > 0 trong fault window.

Chú ý global tags: `degradation_mode: 'fault_mode'` và `fault_mode: FAULT_MODE` — cho phép filter metrics theo fault mode trong dashboard.

### 5.5 Helper function: `expectedFaultPattern()`

```javascript
function expectedFaultPattern() {
  switch (FAULT_MODE) {
    case 'tcp_reset':
      return /connection reset|reset by peer|forcibly closed/i;
    case 'dns_fail':
      return /no such host|name or service not known|server misbehaving/i;
    default:
      return /connection reset|reset by peer|forcibly closed|no such host|name or service not known|server misbehaving/i;
  }
}
```

Hàm này trả về regex pattern tương ứng với fault mode đang active. Script dùng pattern này để verify rằng error message trong response body match với fault mode đã inject — đảm bảo lỗi được propagate đúng nguyên nhân gốc.

### 5.6 Helper function: `isServerFailure()` và `reportsPatternFailure()`

```javascript
function isServerFailure(response) {
  return [500, 502, 503, 504].includes(response.status);
}

function reportsPatternFailure(response, pattern) {
  const payload = safeJson(response);
  if (payload && typeof payload.error === 'string') {
    return pattern.test(payload.error);
  }
  return typeof response.body === 'string' && pattern.test(response.body);
}
```

**`isServerFailure()`:** Kiểm tra response status có phải 5xx không. Chỉ chấp nhận 500, 502, 503, 504 — không chấp nhận các status khác như 429 (rate limit) hoặc 404.

**`reportsPatternFailure()`:** Kiểm tra response body có chứa error message matching fault pattern không. Ưu tiên check `payload.error` (JSON field), fallback sang `response.body` (raw text). Điều này đảm bảo script hoạt động ngay cả khi response không phải JSON.

### 5.7 Core function: `requestMixApi(api, phase)`

Đây là hàm cốt lõi xử lý từng API request trong production mix:

```javascript
function requestMixApi(api, phase) {
  const response = requestApi(BASE_URL, api, { ... });
  const payload = safeJson(response);
  const affected = affectedApis.has(api.name);
  const degradedAffected = phase === 'degraded' && affected;

  // Logic phân nhánh:
  if (degradedAffected) {
    // Affected API trong degraded phase → expect 5xx + fault pattern
    check(response, {
      [`${phase} ${api.name} fault status`]: (r) => isServerFailure(r) || ...,
      [`${phase} ${api.name} fault body matches ${FAULT_MODE}`]: (r) => reportsPatternFailure(r, pattern) || ...,
    });
  } else {
    // Unaffected API hoặc healthy/recovered phase → expect 200
    check(response, {
      [`${phase} ${api.name} status ${api.expected}`]: (r) => r.status === api.expected || ...,
    });
  }
  // ...
}
```

Logic chính:
1. Gọi API qua `requestApi()` (hàm shared xử lý dynamic URL construction)
2. Xác định API có affected không
3. Nếu `degradedAffected` (degraded phase + affected API): expect 5xx + fault pattern match
4. Ngược lại: expect status đúng như định nghĩa trong `productionMixApis`
5. Record duration vào `phaseDuration` trend
6. Trả về result object để `runPhase()` aggregate

### 5.8 Core function: `runPhase(phase, sequence)`

Hàm này chạy toàn bộ production mix sequence trong một phase:

```javascript
function runPhase(phase, sequence) {
  const affectedDurations = [];
  const unaffectedDurations = [];
  let affectedMatchedCount = 0;
  // ... more counters

  for (const api of sequence) {
    const result = requestMixApi(api, phase);
    // Aggregate counters based on result.affected
    sleep(INTER_REQUEST_SLEEP_SECONDS);
  }

  return {
    affectedAverageMs: average(affectedDurations),
    affectedCount: affectedDurations.length,
    unaffectedAverageMs: average(unaffectedDurations),
    // ... more aggregate metrics
  };
}
```

Aggregate metrics bao gồm:
- `affectedAverageMs` / `unaffectedAverageMs`: Latency trung bình
- `affectedMatchedCount` / `unaffectedMatchedCount`: Số request có status đúng
- `affectedFailureCount` / `unaffectedFailureCount`: Số request 5xx
- `affectedFaultPatternCount`: Số affected request có fault pattern match
- `affectedFaultPayloadCount`: Số affected request có fault payload đúng
- `paymentHealthyMatchCount`: Số payment-sensitive request đúng payment path

### 5.9 Core function: `assertPhaseMetrics(healthyMetrics, degradedMetrics, recoveredMetrics)`

Hàm này chạy toàn bộ assertion sau khi 3 phases hoàn thành. Các assertion chính:

```text
1. "healthy phase observed affected endpoints" → affectedCount > 0
2. "degraded phase observed affected endpoints" → affectedCount > 0
3. "recovered phase observed affected endpoints" → affectedCount > 0
4. "healthy affected statuses all matched" → 100% status match
5. "healthy unaffected statuses all matched" → 100% status match
6. "degraded affected statuses all matched" → 100% 5xx match
7. "degraded unaffected statuses all matched" → 100% 200 match
8. "recovered affected statuses all matched" → 100% 200 match
9. "recovered unaffected statuses all matched" → 100% 200 match
10. "degraded affected all failed" → affectedFailureCount == affectedCount
11. "degraded unaffected had no server failures" → unaffectedFailureCount == 0
12. "recovered affected had no server failures" → affectedFailureCount == 0
13. "degraded affected fault bodies all matched" → faultPatternCount == affectedCount
14. "degraded affected payloads all showed DB fault path" → faultPayloadCount == affectedCount
15. "healthy payment-sensitive endpoints stayed on payment path" → payment match
16. "recovered payment-sensitive endpoints returned to payment path" → payment match
17. "degraded unaffected avg <= healthy avg + tolerance" → isolation check
18. "recovered affected avg <= healthy avg + tolerance" → recovery check
19. "recovered unaffected avg <= healthy avg + tolerance" → isolation check
```

Tổng cộng 19 assertions — mỗi assertion kiểm tra một khía cạnh cụ thể của fail contract.

### 5.10 Main function: `default export`

```javascript
export default function () {
  const sequence = buildProductionSequence();

  try {
    // Step 1: Reset và verify baseline sạch
    resetFault('initial');
    assertProfile('initial', '');

    // Step 2: Healthy phase (baseline)
    const healthyMetrics = runPhase('healthy', sequence);

    // Step 3: Inject fault
    setFault('degraded');
    assertProfile('degraded_config', FAULT_MODE);

    // Step 4: Degraded phase (fault active)
    const degradedMetrics = runPhase('degraded', sequence);
    degradedObserved.add(1, { ... });

    // Step 5: Reset fault
    resetFault('recovered');
    assertProfile('recovered', '');

    // Step 6: Recovered phase
    const recoveredMetrics = runPhase('recovered', sequence);
    recoveredObserved.add(1, { ... });

    // Step 7: Assert phase metrics
    assertPhaseMetrics(healthyMetrics, degradedMetrics, recoveredMetrics);
  } finally {
    // Cleanup: luôn reset dù có lỗi
    try {
      resetFault('final');
    } catch (error) {
      console.error(`final order db fault reset failed: ${error.message}`);
    }
  }
}
```

**`finally` block là CRITICAL:** Dù test pass hay fail, script luôn cố gắng reset fault mode. Nếu không có finally block, một lỗi trong quá trình test có thể để lại fault mode active, khiến mọi test sau đó đều fail.

---

## 6. Service mechanism deep-dive: DB fault mode và fail contract

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

### 6.3 TCP-level fault injection mechanism

Khi fault mode được set thành `tcp_reset`, order service thực hiện các bước sau ở tầng TCP:

```text
1. Service nhận request PUT /ops/order/db/profile
2. Service cập nhật internal config: postgres_fault_mode = "tcp_reset"
3. Khi có query tiếp theo đến DB:
   a. DB driver chuẩn bị connection
   b. Trước khi gửi query, driver check fault mode
   c. Nếu fault_mode = "tcp_reset":
      - Driver gửi TCP RST packet thay vì query
      - Connection bị đóng ngay lập tức
      - Không có handshake, không có retry
   d. Application code nhận được lỗi "connection reset by peer"
   e. Service trả về 5xx cho client
```

Khi fault mode là `dns_fail`, cơ chế khác:

```text
1. Service cập nhật internal config: postgres_fault_mode = "dns_fail"
2. Khi có query tiếp theo:
   a. DNS resolution cho DB hostname bị chặn
   b. getaddrinfo() trả về lỗi "no such host" hoặc tương tự
   c. Connection không thể được thiết lập
   d. Service trả về 5xx cho client
```

### 6.4 Sự khác biệt giữa tcp_reset và dns_fail

| Khía cạnh | tcp_reset | dns_fail |
| --- | --- | --- |
| **TCP layer** | Connection tồn tại rồi bị reset | Connection không bao giờ được tạo |
| **Thời điểm fail** | Giữa query execution | Trước khi connection được thiết lập |
| **Error message** | "connection reset by peer" | "no such host" |
| **Mô phỏng** | DB crash đột ngột | DB server biến mất khỏi network |
| **Pool impact** | Connection trong pool bị hỏng | Không có connection nào được tạo |
| **Recovery behavior** | Cần reconnect + verify pool health | Chỉ cần DNS hoạt động trở lại |

### 6.5 Profile verification qua assertProfile()

Script không chỉ inject fault mode mà còn verify profile state qua `assertProfile()`. Hàm này check 11 aspects của DB profile:

```javascript
function assertProfile(label, expectedFaultMode) {
  const response = controlRequest('GET', PROFILE_PATH, null, `${label}_profile_get`);
  const payload = safeJson(response);
  const profile = payload && payload.profile ? payload.profile : {};
  const stats = profile && profile.postgres_pool_stats ? profile.postgres_pool_stats : {};

  check({ ... }, {
    [`${label} profile status 200`]: ...,
    [`${label} profile success true`]: ...,
    [`${label} profile initialized`]: ...,
    [`${label} profile delay 0`]: ...,          // delay phải = 0
    [`${label} profile pressure limit 0`]: ...,  // pressure phải = 0
    [`${label} profile pressure hold 0`]: ...,   // pressure hold phải = 0
    [`${label} profile fault mode ${expectedFaultMode}`]: ..., // fault mode đúng
    [`${label} pool stats pressure limit 0`]: ...,
    [`${label} pool stats pressure hold 0`]: ...,
    [`${label} pool stats fault mode ${expectedFaultMode}`]: ...,
  });
}
```

Việc verify cả `profile.postgres_delay_ms === 0` và `profile.postgres_pressure_limit === 0` đảm bảo rằng fault mode là degradation DUY NHẤT đang active — không có delay hoặc pressure chồng lấn gây nhiễu kết quả.

### 6.6 Payment path protection mechanism

Trong fault window, payment-sensitive APIs phải bypass payment gateway hoàn toàn:

```javascript
function assertFaultPayload(payload, phase, apiName) {
  const breakdown = payload?.performance?.breakdown || {};
  const dbTimerName = apiName === 'order_status' ? 'db_ms' : 'db_write_ms';
  const hasDbTimer = Object.prototype.hasOwnProperty.call(breakdown, dbTimerName);
  const bypassedPayment = !paymentSensitiveApis.has(apiName) || (
    !payload.dependency &&
    Number(breakdown.external_ms || 0) === 0
  );

  return (
    payload &&
    payload.success === false &&
    typeof payload.error === 'string' &&
    hasDbTimer &&
    bypassedPayment
  ) || recordCheckFailure(`${phase}_${apiName}_fault_payload`);
}
```

Fault payload assertion:
1. `payload.success === false` — response xác nhận thất bại
2. `typeof payload.error === 'string'` — error message tồn tại
3. `hasDbTimer` — DB timer vẫn được record (dù fail, evidence vẫn được ghi nhận)
4. `bypassedPayment` — payment-sensitive API không gọi payment gateway

Điều kiện `bypassedPayment` cực kỳ quan trọng: nếu `checkout` hoặc `order_confirm` gọi payment gateway trong khi DB fault, khách hàng có thể bị charge mà không có order trong DB.

### 6.7 Recovery latency tolerance

Sau recovery, latency phải trở về baseline với tolerance cho phép:

```javascript
const RECOVERY_TOLERANCE_MS = envInt('PROD_MIX_ORDER_DB_FAULT_RECOVERY_TOLERANCE_MS', 180);

[`recovered affected avg <= healthy avg + ${RECOVERY_TOLERANCE_MS}ms`]: (o) => (
  o.recoveredMetrics.affectedAverageMs <= o.healthyMetrics.affectedAverageMs + RECOVERY_TOLERANCE_MS
) || recordCheckFailure('recovered_baseline'),
```

Tolerance 180ms cho phép cold-start effect sau recovery (connection pool cần được thiết lập lại, DNS cache có thể cần refresh). Nếu latency sau recovery vượt quá tolerance, có thể có vấn đề với:
- Connection pool không được khởi tạo lại đúng cách
- Prepared statements cache bị mất
- Resource leak từ fault phase chưa được cleanup

---

## 7. Request sequence flow

### 7.1 Tổng quan 3 phases

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

### 7.2 Chi tiết từng phase

**Phase 1 — Healthy (baseline):**

```text
Step 1.1: POST /ops/order/db/reset (initial cleanup)
Step 1.2: GET  /ops/order/db/profile → verify: fault_mode = ""
Step 1.3: Chạy production mix sequence (~20 requests)
          - order_status:     GET  200 ✓ (db_ms present)
          - checkout:         POST 200 ✓ (payment path active)
          - order_confirm:    POST 200 ✓ (payment path active)
          - payment_webhook:  POST 200 ✓
          - products:         GET  200 ✓ (unaffected)
          - report:           GET  200 ✓ (unaffected)
Step 1.4: Record healthyMetrics (baseline latency)
```

**Phase 2 — Degraded (fault active):**

```text
Step 2.1: PUT /ops/order/db/profile
          Body: { postgres_fault_mode: "tcp_reset" }
          → Response: 200 ✓, success: true
Step 2.2: GET /ops/order/db/profile → verify: fault_mode = "tcp_reset"
Step 2.3: Chạy production mix sequence (~80 requests)
          - order_status:     GET  5xx ✓ (connection reset)
          - checkout:         POST 5xx ✓ (không gọi payment)
          - order_confirm:    POST 5xx ✓ (không gọi payment)
          - payment_webhook:  POST 5xx ✓
          - products:         GET  200 ✓ (unaffected — dùng DB khác)
          - report:           GET  200 ✓ (unaffected — dùng DB khác)
Step 2.4: Record degradedObserved = 1
Step 2.5: Record degradedMetrics
```

**Phase 3 — Recovered:**

```text
Step 3.1: POST /ops/order/db/reset
          → Response: 200 ✓, success: true
Step 3.2: GET /ops/order/db/profile → verify: fault_mode = ""
Step 3.3: Chạy production mix sequence (~60 requests)
          - Tất cả APIs → 200 ✓
          - Payment-sensitive APIs → payment path active ✓
Step 3.4: Record recoveredObserved = 1
Step 3.5: Record recoveredMetrics
```

**Cleanup (finally block):**

```text
POST /ops/order/db/reset (final cleanup)
→ Đảm bảo fault mode được clear dù test pass hay fail
```

### 7.3 Production mix sequence construction

Sequence được xây dựng từ `productionMixApis` (defined in `shared/traffic.js`):

```javascript
function buildProductionSequence() {
  const sequence = [];
  for (const api of productionMixApis) {
    const repetitions = Math.max(1, Math.round(api.weight / WEIGHT_DIVISOR));
    for (let index = 0; index < repetitions; index += 1) {
      sequence.push(api);
    }
  }
  return sequence;
}
```

Mỗi API trong `productionMixApis` có `weight` — weight càng cao, API xuất hiện càng nhiều lần trong sequence. `WEIGHT_DIVISOR` (default 2) kiểm soát tổng số request: divisor càng nhỏ → càng nhiều request.

Ví dụ với `WEIGHT_DIVISOR = 2`:
- API có weight 4 → 2 lần trong sequence
- API có weight 2 → 1 lần trong sequence
- API có weight 8 → 4 lần trong sequence

Tổng cộng ~20-25 APIs mỗi lần chạy sequence. Mỗi phase chạy toàn bộ sequence, tổng 3 phases ≈ 60-75 requests.

### 7.4 Request timing và sleep

```javascript
const INTER_REQUEST_SLEEP_SECONDS = envFloat('PROD_MIX_ORDER_DB_FAULT_INTER_REQUEST_SLEEP_SECONDS', 0.04);
```

Sleep 40ms giữa các request đảm bảo:
- Không gây quá tải cho service
- Cho phép DB driver xử lý fault mode giữa các request
- Mô phỏng realistic pacing (không phải burst traffic)

### 7.5 Error handling flow

```text
┌─────────────────────────────────────────┐
│         requestMixApi(api, phase)        │
├─────────────────────────────────────────┤
│ 1. Gọi API qua requestApi()             │
│ 2. Parse JSON response                  │
│ 3. Xác định affected?                   │
│    ├─ YES + degraded phase:             │
│    │   ├─ Check status 5xx?             │
│    │   │   ├─ YES → OK                  │
│    │   │   └─ NO  → recordCheckFailure  │
│    │   └─ Check fault pattern?          │
│    │       ├─ YES → OK                  │
│    │       └─ NO  → recordCheckFailure  │
│    └─ NO hoặc healthy/recovered phase:  │
│        └─ Check status = expected?      │
│            ├─ YES → OK                  │
│            └─ NO  → recordCheckFailure  │
│ 4. Return result object                 │
└─────────────────────────────────────────┘
```

Mọi check failure đều gọi `recordCheckFailure(label)` — hàm này vừa increment `faultCheckFailures` counter, vừa return `false` để k6 check framework ghi nhận failure. Tag `label` cho phép xác định chính xác assertion nào đã fail.

---

## 8. Key signals

### 8.1 Signal matrix

| Signal | Fault window | Recovery |
| --- | --- | --- |
| Affected APIs status | **5xx** (expected!) | 200 |
| Unaffected APIs status | 200 | 200 |
| `postgres_fault_mode` | `tcp_reset` | empty |
| `prod_mix_order_db_fault_check_failures` | 0 | 0 |
| `degraded_observed` | > 0 | 0 |
| `recovered_observed` | 0 | > 0 |

### 8.2 Custom counters detail

**`faultCheckFailures` (Counter) — QUAN TRỌNG NHẤT:**
```text
Threshold: count == 0
Ý nghĩa: Không có bất kỳ assertion nào fail
Tags: label (tên assertion), target_service, target_dependency,
      degradation_mode, fault_mode
```

**`phaseDuration` (Trend):**
```text
Threshold: không có (informational)
Ý nghĩa: Latency distribution theo phase và API
Tags: phase, api, affected, target_service, target_dependency,
      degradation_mode, fault_mode
```

**`degradedObserved` (Rate):**
```text
Threshold: không có (nhưng phải > 0 để xác nhận test thực sự chạy)
Ý nghĩa: Xác nhận degraded phase đã hoàn thành
```

**`recoveredObserved` (Rate):**
```text
Threshold: không có (nhưng phải > 0 để xác nhận test thực sự chạy)
Ý nghĩa: Xác nhận recovered phase đã hoàn thành
```

### 8.3 k6 built-in metrics interpretation

```text
http_req_failed:  PHẢI > 0 trong fault window
                  Nếu = 0 → fault mode không hoạt động → INVESTIGATE
                  Giá trị ~4-8% là bình thường (tỷ lệ affected APIs trong mix)

http_req_duration: Trong fault window, affected APIs có duration rất thấp
                   (fail-fast, không chờ timeout).
                   Unaffected APIs vẫn bình thường.

checks:            PHẢI = 100%. Mọi check được thiết kế để pass khi
                   fault mode hoạt động đúng.

iterations:        = 1 (single iteration, sequential)

vus:               = 1
```

### 8.4 Response body signals

Trong fault window, response body của affected APIs chứa:

```json
{
  "success": false,
  "error": "connection reset by peer",
  "performance": {
    "breakdown": {
      "db_ms": 0,
      "db_write_ms": 0,
      "external_ms": 0
    }
  }
}
```

Các dấu hiệu quan trọng:
- `success: false` — service thừa nhận thất bại
- `error` — chứa fault pattern matching (không phải generic error)
- `performance.breakdown` — không có DB time (vì query không chạy được)
- `external_ms: 0` — payment-sensitive APIs không gọi external service

### 8.5 Control plane response signals

**Khi set fault:**
```json
{
  "success": true,
  "data": {
    "postgres_fault_mode": "tcp_reset",
    "postgres_delay_ms": 0,
    "postgres_pressure_limit": 0,
    "postgres_pressure_hold_ms": 0
  }
}
```

**Khi get profile (trong fault window):**
```json
{
  "success": true,
  "profile": {
    "initialized": true,
    "postgres_fault_mode": "tcp_reset",
    "postgres_delay_ms": 0,
    "postgres_pressure_limit": 0,
    "postgres_pressure_hold_ms": 0,
    "postgres_pool_stats": {
      "fault_mode": "tcp_reset",
      "pressure_limit": 0,
      "pressure_hold_ms": 0
    }
  }
}
```

**Khi reset:**
```json
{
  "success": true,
  "message": "profile reset"
}
```

**Sau reset (get profile):**
```json
{
  "success": true,
  "profile": {
    "initialized": true,
    "postgres_fault_mode": "",
    "postgres_delay_ms": 0,
    "postgres_pressure_limit": 0,
    "postgres_pressure_hold_ms": 0,
    "postgres_pool_stats": {
      "fault_mode": "",
      "pressure_limit": 0,
      "pressure_hold_ms": 0
    }
  }
}
```

---

## 9. Pass/fail criteria

### 9.1 Primary criteria

```text
✅ faultCheckFailures = 0
✅ Fault window: affected APIs = 5xx (KHÔNG tính là fail)
✅ Fault window: unaffected APIs = 200
✅ Fault window: payment-sensitive APIs = 5xx
✅ Recovery: TẤT CẢ = 200
✅ Profile fault_mode empty sau reset
❌ KHÔNG judge bằng http_req_failed — nó PHẢI > 0 trong fault window
```

### 9.2 Detailed pass criteria

**C1 — Baseline integrity:**
```text
✅ Healthy phase: TẤT CẢ APIs status = expected (200)
✅ Healthy phase: Payment-sensitive APIs có payment path active
✅ Profile initialized, delay=0, pressure=0, fault_mode=""
```

**C2 — Fault injection confirmation:**
```text
✅ PUT profile returns 200 with success=true
✅ Profile GET shows fault_mode = FAULT_MODE
✅ Pool stats show fault_mode = FAULT_MODE
```

**C3 — Fault window behavior:**
```text
✅ Affected APIs: 100% server failures (500/502/503/504)
✅ Affected APIs: 100% fault pattern match trong response body
✅ Affected APIs: 100% fault payload (success=false, error present, no payment call)
✅ Unaffected APIs: 100% status = expected (200)
✅ Unaffected APIs: 0% server failures
✅ Unaffected latency <= healthy unaffected latency + tolerance
```

**C4 — Recovery behavior:**
```text
✅ POST reset returns 200 with success=true
✅ Profile GET shows fault_mode = ""
✅ TẤT CẢ APIs: 100% status = expected (200)
✅ Affected APIs: 0% server failures
✅ Payment-sensitive APIs: payment path restored
✅ Recovery latency <= healthy latency + tolerance (180ms default)
```

**C5 — Cleanup:**
```text
✅ Finally block executes (dù test pass hay fail)
✅ Final reset attempt (có thể fail nếu service down, không ảnh hưởng kết quả)
```

### 9.3 Detailed fail criteria

Ngược lại với pass criteria, script fail khi:

```text
❌ faultCheckFailures > 0 (bất kỳ assertion nào fail)
❌ checks rate < 1 (threshold violation)
❌ Healthy phase: affected API trả về 5xx (DB đang có vấn đề trước test)
❌ Healthy phase: unaffected API trả về 5xx (service đang không ổn định)
❌ Fault window: affected API trả về 200 (fault mode không hoạt động!)
❌ Fault window: unaffected API trả về 5xx (fault scope sai — isolation fail!)
❌ Recovery: bất kỳ API nào trả về 5xx (recovery không hoàn toàn)
❌ Recovery latency > healthy latency + tolerance (slow recovery)
❌ Payment-sensitive API gọi payment gateway trong fault window
❌ Fault pattern không khớp trong response body
```

### 9.4 Why http_req_failed is NOT a fail criterion

```text
Trong fault window, affected APIs PHẢI trả về 5xx.
Điều này có nghĩa http_req_failed PHẢI > 0.

Nếu đặt threshold http_req_failed < 0.01:
  → Test sẽ FAIL vì fault mode hoạt động đúng!
  → False positive: đánh dấu service khỏe mạnh là có lỗi

Nếu đặt threshold http_req_failed < 0.10:
  → Test có thể pass, nhưng 10% fail rate nghe có vẻ xấu
  → Gây nhầm lẫn cho người đọc dashboard

GIẢI PHÁP: Không dùng http_req_failed threshold.
Dùng custom counter faultCheckFailures để judge.
http_req_failed chỉ là informational signal.
```

---

## 10. Cách chạy + output mẫu

### 10.1 PowerShell

```powershell
$env:BASE_URL = "http://localhost:80"
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
$env:PROD_MIX_ORDER_DB_FAULT_CONTROL_BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_FAULT_MODE = "tcp_reset"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/10-production-mix-order-db-fault-recovery.js
```

### 10.2 Bash (Linux/macOS)

```bash
export BASE_URL="http://localhost:80"
export OPS_AUTH_TOKEN=$(docker exec k6target-app-1 printenv OPS_AUTH_TOKEN)
export PROD_MIX_ORDER_DB_FAULT_CONTROL_BASE_URL="http://localhost:80"
export PROD_MIX_ORDER_DB_FAULT_MODE="tcp_reset"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/10-production-mix-order-db-fault-recovery.js
```

### 10.3 Với dns_fail mode

```powershell
$env:PROD_MIX_ORDER_DB_FAULT_MODE = "dns_fail"
k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/10-production-mix-order-db-fault-recovery.js
```

### 10.4 Với custom tolerance

```powershell
$env:PROD_MIX_ORDER_DB_FAULT_RECOVERY_TOLERANCE_MS = "300"
$env:PROD_MIX_ORDER_DB_FAULT_UNAFFECTED_TOLERANCE_MS = "150"
k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/10-production-mix-order-db-fault-recovery.js
```

### 10.5 Output mẫu (Run #119)

```text
     script: E:/Projects/k6/k6-metrics-server/load-target/k6/app/10-production-mix-order-db-fault-recovery.js
     output: cloud (https://ingest.k6.io)

     scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):

running (0m02.5s), 1/1 VUs, 1 complete and 0 interrupted iterations
default ✓ [======================================] 1 VUs  0m02.5s

     █ Fault recovery — production mix over order-service DB

     checks_total.......: 224
     checks_succeeded...: 100% 224 out of 224
     http_req_failed....: 4.8% (8/166) ← EXPECTED trong fault window!
     http_req_duration...: avg=16.3ms med=7.1ms p95=51.8ms

     prod_mix_order_db_fault_check_failures: 0
     prod_mix_order_db_fault_degraded_observed: 1
     prod_mix_order_db_fault_recovered_observed: 1
```

### 10.6 Phân tích output

```text
checks_total: 224     → Tất cả check đều pass = 100%
http_req_failed: 4.8% → 8/166 requests fail (tất cả trong fault window)
                         Đây là CON SỐ MONG ĐỢI, không phải vấn đề
faultCheckFailures: 0 → KHÔNG có assertion failure nào
degradedObserved: 1   → Degraded phase đã chạy
recoveredObserved: 1  → Recovery phase đã chạy

http_req_duration avg 16.3ms:
  - Affected APIs trong fault window: rất nhanh (fail-fast, <5ms)
  - Unaffected APIs: bình thường (~20-30ms)
  - Recovery phase APIs: bình thường (~20-30ms)
  → Average thấp vì fail-fast requests kéo xuống
```

---

## 11. 4 output → decision scenarios

### Scenario A: Fault window có 5xx, recovery có 200

```text
→ Hoàn hảo. Service fail đúng contract và recover đúng cách.
```

**Chi tiết:**
```text
✅ http_req_failed > 0 trong fault window
✅ http_req_failed = 0 sau recovery
✅ faultCheckFailures = 0
✅ Affected APIs 5xx, unaffected APIs 200
✅ Payment path bypassed trong fault window
✅ Payment path restored sau recovery

→ Decision: Service sẵn sàng cho production DB failure scenarios.
  Circuit breaker và alerting nên được cấu hình dựa trên 5xx rate.
```

### Scenario B: Fault window KHÔNG có 5xx (tất cả 200)

```text
→ Service NUỐT lỗi — catastrophic.
→ DB fault mode không được áp dụng hoặc service ignore fault.
→ Kiểm tra version order-service.
```

**Chi tiết:**
```text
❌ http_req_failed = 0 trong fault window
❌ faultCheckFailures > 0 (degraded affected statuses mismatch)
❌ Affected APIs trả về 200 thay vì 5xx
⚠️ Có thể payment path vẫn active → nguy cơ charge không có order

Root causes phổ biến:
  1. Control plane không hoạt động: PUT /ops/order/db/profile không set được fault mode
  2. Service code nuốt lỗi: try-catch wrapper trả về 200 với data rỗng
  3. Circuit breaker mở sẵn: request không đến được DB nên không thấy fault
  4. Cache layer: response được cache, không query DB
  5. Sai DB connection string: service đang dùng DB khác

Action items:
  1. Verify: GET /ops/order/db/profile → fault_mode có được set không?
  2. Check service logs: có thấy "connection reset" error không?
  3. Check service version: có phải version mới thay đổi error handling?
  4. Run với FAULT_MODE=dns_fail: behavior có khác không?
```

### Scenario C: Unaffected APIs cũng 5xx

```text
→ Fault scope sai — ảnh hưởng toàn bộ service thay vì chỉ order-service DB.
→ DB fault mode được áp dụng ở wrong level.
```

**Chi tiết:**
```text
❌ Unaffected APIs (products, report) cũng trả về 5xx
❌ faultCheckFailures > 0 (degraded unaffected failures)
⚠️ Fault isolation bị vi phạm — toàn bộ service stack bị ảnh hưởng

Root causes phổ biến:
  1. Shared DB instance: products và report service dùng chung DB với order
  2. Fault injection ở Nginx/network level thay vì DB driver level
  3. Cascading failure: order service failure kéo theo các service khác
  4. Wrong service mesh config: circuit breaker mở cho toàn bộ upstream

Action items:
  1. Verify DB topology: mỗi service có DB instance riêng không?
  2. Check fault injection point: có đúng là order-service DB driver không?
  3. Review service dependencies: service nào gọi service nào?
  4. Test từng service riêng biệt để isolate vấn đề
```

### Scenario D: Sau recovery vẫn 5xx

```text
→ Reset không hoạt động.
→ Cần restart order-service.
→ Hoặc DB thật sự có vấn đề (không phải injected).
```

**Chi tiết:**
```text
❌ http_req_failed > 0 sau recovery phase
❌ faultCheckFailures > 0 (recovered failures)
❌ Profile GET vẫn hiển thị fault_mode != ""
⚠️ DB có thể đang thực sự gặp vấn đề

Root causes phổ biến:
  1. Reset endpoint fail: POST /ops/order/db/reset trả về lỗi
  2. DB thực sự chết: không liên quan đến fault injection
  3. Connection pool không recover: connections cũ bị hỏng, không tạo được connection mới
  4. Stale fault config: config được cache, không refresh sau reset
  5. Network issue: firewall rule hoặc network partition thực sự

Action items:
  1. Verify: GET /ops/order/db/profile → fault_mode đã được clear chưa?
  2. Restart order-service và test lại
  3. Check DB health trực tiếp: psql connect được không?
  4. Check network: telnet DB_HOST DB_PORT
  5. Kiểm tra xem có phải DB thật đang có vấn đề không
```

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "http_req_failed > 0 = bug"

```text
SAI. Trong case này, http_req_failed > 0 là PROOF fault mode hoạt động.
4.8% fail rate trong run #119 là bằng chứng service bảo vệ data đúng cách.
```

**Giải thích sâu hơn:**
Trong hầu hết các k6 test, `http_req_failed > 0` đồng nghĩa với "có vấn đề". Nhưng case db-03 là ngoại lệ có chủ đích: fault mode được inject để tạo ra 5xx. Nếu `http_req_failed = 0`, đó mới là vấn đề — có nghĩa fault mode không hoạt động.

Đây là lý do dashboard và monitoring cho db-03 phải dùng `faultCheckFailures` thay vì `http_req_failed` để đánh giá pass/fail.

### Nghịch lý 2: "Service luôn phải trả 200"

```text
SAI. Service PHẢI trả 5xx khi dependency không hoạt động.
Trả 200 khi DB chết = data corruption risk.
```

**Giải thích sâu hơn:**
Fail-fast là một design pattern quan trọng trong distributed systems. Khi một dependency không hoạt động, service nên:
1. Fail ngay lập tức (không retry vô ích)
2. Trả về error code rõ ràng (5xx)
3. Để infrastructure (load balancer, circuit breaker) xử lý

Service "cố gắng" trả về 200 dù DB chết là anti-pattern nguy hiểm nhất trong microservices.

### Nghịch lý 3: "1 VU không đủ để test production behavior"

```text
SAI với case này. Fault recovery test là sequential experiment, không phải load test.
Mục tiêu là verify behavior trong từng phase, không phải đo throughput dưới tải.
1 VU, 1 iteration đảm bảo:
  - Phase transitions rõ ràng (không overlapping requests)
  - Mỗi API được test trong đúng phase của nó
  - Không có race condition giữa fault injection và request execution
```

### Nghịch lý 4: "Test này chỉ cần chạy 1 lần"

```text
SAI. Cần chạy với CẢ 2 fault mode (tcp_reset và dns_fail) để có coverage đầy đủ.
Ngoài ra, mỗi lần update service code đều nên chạy lại để đảm bảo error handling
không bị thay đổi.
```

### Nghịch lý 5: "5xx trong fault window là đủ — không cần check pattern"

```text
SAI. 5xx có thể đến từ nhiều nguyên nhân: bug trong code, Nginx timeout,
service crash... Chỉ check status 5xx không đảm bảo lỗi đến từ DB fault.
Pattern matching (connection reset, no such host) xác nhận NGUYÊN NHÂN GỐC.
```

### Nghịch lý 6: "Unaffected APIs không quan trọng"

```text
SAI. Unaffected APIs (products, report) chứng minh fault SCOPE được giới hạn.
Nếu products service cũng 5xx, có nghĩa fault injection ảnh hưởng toàn bộ stack
→ không phải là unit test của order-service DB dependency.
```

---

## 13. Checklist

### 13.1 Pre-flight checklist

- [ ] `OPS_AUTH_TOKEN` đã source từ environment
- [ ] Target stack running với profile `full-no-cdn`
- [ ] Tất cả services healthy (check docker ps hoặc health endpoints)
- [ ] DB profile sạch trước test (không delay, pressure, fault tồn đọng)
- [ ] `FAULT_MODE` được set hợp lệ (`tcp_reset` hoặc `dns_fail`)
- [ ] `BASE_URL` trỏ đúng đến target stack
- [ ] Network connectivity: ping được target stack
- [ ] Không có background job đang chạy (batch, migration, backup)

### 13.2 Runtime checklist

- [ ] Phase 1 (healthy): tất cả APIs trả về expected status
- [ ] Phase 1 (healthy): payment-sensitive APIs có payment path active
- [ ] Phase 2 (fault): affected APIs trả về 5xx với đúng fault pattern
- [ ] Phase 2 (fault): unaffected APIs vẫn trả về 200
- [ ] Phase 2 (fault): payment-sensitive APIs bypass payment gateway
- [ ] Phase 3 (recovery): tất cả APIs trả về 200
- [ ] Phase 3 (recovery): payment path được khôi phục
- [ ] `faultCheckFailures = 0` (KHÔNG có assertion failure nào)
- [ ] `degradedObserved > 0` (degraded phase đã thực sự chạy)
- [ ] `recoveredObserved > 0` (recovery phase đã thực sự chạy)

### 13.3 Post-flight checklist

- [ ] Đã reset DB profile sau test (finally block đảm bảo điều này)
- [ ] GET `/ops/order/db/profile` xác nhận `fault_mode = ""`
- [ ] Tất cả services vẫn healthy
- [ ] Không có side effect (order rác, payment treo)
- [ ] Metrics đã được export lên cloud (nếu dùng `-o cloud`)
- [ ] Dashboard hiển thị đúng: `http_req_failed > 0` trong fault window nhưng `faultCheckFailures = 0`

### 13.4 CI/CD integration checklist

- [ ] Test được chạy trong pipeline sau mỗi deployment
- [ ] `FAULT_MODE` được matrix qua cả 2 giá trị (`tcp_reset`, `dns_fail`)
- [ ] Alert được cấu hình cho `faultCheckFailures > 0` (không phải `http_req_failed > 0`)
- [ ] Kết quả test được lưu trữ để so sánh historical trend
- [ ] Cleanup job đảm bảo DB profile được reset sau pipeline (ngay cả khi pipeline bị cancel)

---

## 14. 4-5 Variations

### Variation 1: DNS failure mode

```powershell
$env:PROD_MIX_ORDER_DB_FAULT_MODE = "dns_fail"
```

**Mục đích:** Test behavior khi DB hostname không thể resolve — mô phỏng DNS server failure hoặc misconfiguration.

**Khác biệt so với tcp_reset:**
- Error pattern: "no such host" / "name or service not known" thay vì "connection reset"
- Không có TCP connection nào được tạo → khác biệt về pool behavior
- Thường fail nhanh hơn tcp_reset (DNS fail immediate, TCP reset cần existing connection)

### Variation 2: Strict recovery timing

```powershell
$env:PROD_MIX_ORDER_DB_FAULT_RECOVERY_TOLERANCE_MS = "100"
```

**Mục đích:** Thắt chặt tolerance để phát hiện slow recovery. Mặc định 180ms khá rộng — giảm xuống 100ms để bắt các vấn đề recovery latency tinh vi.

**Lưu ý:** Tolerance quá thấp có thể gây false positive trong môi trường CI chậm.

### Variation 3: High-density production mix

```powershell
$env:PROD_MIX_ORDER_DB_FAULT_WEIGHT_DIVISOR = "1"
```

**Mục đích:** Tăng số lượng request trong mỗi phase (divisor nhỏ hơn → nhiều request hơn). Dùng để có sample size lớn hơn cho latency analysis.

### Variation 4: Zero sleep (stress fault test)

```powershell
$env:PROD_MIX_ORDER_DB_FAULT_INTER_REQUEST_SLEEP_SECONDS = "0"
```

**Mục đích:** Loại bỏ sleep giữa các request để test behavior khi fault mode được kích hoạt và service nhận request liên tục. Kiểm tra xem fault handling có bị race condition không.

**Cảnh báo:** Có thể gây khác biệt về latency do không có "nghỉ" giữa các request.

### Variation 5: Custom profile path (multi-tenant)

```powershell
$env:PROD_MIX_ORDER_DB_FAULT_PROFILE_PATH = "/ops/order/db/profile/tenant-a"
$env:PROD_MIX_ORDER_DB_FAULT_RESET_PATH = "/ops/order/db/reset/tenant-a"
```

**Mục đích:** Test trong môi trường multi-tenant nơi mỗi tenant có DB profile riêng.

---

## 15. Anti-patterns

### 15.1 Primary anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Judge fail vì `http_req_failed > 0`** | Bỏ lỡ evidence fault mode hoạt động |
| **Không reset sau test** | Mọi test sau fail vì DB còn fault |
| **Không verify unaffected APIs** | Không biết fault scope |

### 15.2 Extended anti-patterns

| Anti-pattern | Hậu quả | Cách tránh |
| --- | --- | --- |
| **Chỉ test 1 fault mode** | Bỏ sót bug chỉ xuất hiện với mode còn lại. DNS fail và TCP reset có error path khác nhau trong code. | Luôn matrix test qua cả 2 mode |
| **Dùng http_req_failed threshold** | False positive: test fail dù service hoạt động đúng. Dashboard hiển thị sai → mất niềm tin vào test. | Dùng faultCheckFailures counter |
| **Không verify fault pattern trong body** | 5xx có thể đến từ Nginx timeout thay vì DB fault. Không biết nguyên nhân gốc. | Luôn check pattern match |
| **Bỏ qua payment path check** | Không phát hiện service charge thẻ dù DB chết → data corruption. | Luôn assert bypassedPayment |
| **Không có finally block** | Fault mode không được clear sau test fail → mọi test sau đều fail → waste time debugging. | Luôn dùng try-finally |
| **Chạy test khi DB đang có vấn đề thật** | Không phân biệt được injected fault vs real fault. Kết quả không có ý nghĩa. | Verify baseline trước test |
| **Set tolerance quá cao** | Recovery issue bị ẩn — test luôn pass dù recovery chậm. | Dùng tolerance hợp lý (100-200ms) |
| **Không check profile state giữa các phase** | Fault mode có thể không được set đúng nhưng test vẫn pass nếu service vô tình trả 5xx vì lý do khác. | assertProfile() sau mỗi control plane operation |

### 15.3 Dashboard anti-patterns

```text
❌ Hiển thị http_req_failed gauge cho db-03 → luôn đỏ trong fault window
✅ Hiển thị faultCheckFailures counter → chỉ đỏ khi thực sự có vấn đề

❌ Alert "http_req_failed > 5%" cho db-03 → false alarm mỗi lần chạy
✅ Alert "faultCheckFailures > 0" → chỉ alert khi fail contract bị vi phạm

❌ So sánh http_req_duration giữa healthy và degraded phase
✅ So sánh http_req_duration giữa healthy và recovered phase
```

---

## 16. Real validation data

### 16.1 Run #119 (2026-06-25) — tcp_reset mode

```json
{
  "run_id": "119",
  "timestamp": "2026-06-25T10:15:30Z",
  "fault_mode": "tcp_reset",
  "checks_passes": 224, "checks_fails": 0, "checks_rate": 1.0,
  "http_req_failed_rate": 0.048, "http_reqs": 166, "iterations": 1,
  "http_req_duration_avg": 16.3, "http_req_duration_med": 7.1,
  "http_req_duration_p95": 51.8, "http_req_duration_max": 89.2,
  "fault_check_failures": 0,
  "degraded_observed": 1,
  "recovered_observed": 1,
  "vus": 1, "vus_max": 1
}
```

### 16.2 Phase-by-phase breakdown (Run #119)

| Phase | Requests | Avg latency | 5xx count | Status match |
| --- | --- | --- | --- | --- |
| Healthy | ~55 | 22.1ms | 0 | 100% |
| Degraded | ~55 | 8.3ms | ~8 (affected only) | 100% |
| Recovered | ~56 | 20.5ms | 0 | 100% |

### 16.3 Affected vs unaffected latency (Run #119)

| API group | Healthy | Degraded | Recovered |
| --- | --- | --- | --- |
| Affected APIs | 24.5ms avg | **5.2ms avg** (fail-fast) | 23.8ms avg |
| Unaffected APIs | 19.2ms avg | 18.9ms avg | 19.5ms avg |

Fail-fast behavior rất rõ: affected APIs trong degraded phase nhanh hơn healthy phase vì không thực sự query DB.

### 16.4 Fault pattern match (Run #119)

| API | Status | Pattern match | Fault payload |
| --- | --- | --- | --- |
| order_status | 502 | "connection reset by peer" ✓ | success=false, db_ms=0, external_ms=0 |
| checkout | 502 | "connection reset by peer" ✓ | success=false, db_write_ms=0, external_ms=0 |
| order_confirm | 502 | "connection reset by peer" ✓ | success=false, db_write_ms=0, external_ms=0 |
| payment_webhook | 502 | "connection reset by peer" ✓ | success=false, db_write_ms=0, external_ms=0 |

### 16.5 Run comparison: tcp_reset vs dns_fail

| Metric | tcp_reset (Run #119) | dns_fail (Run #118) |
| --- | --- | --- |
| checks_rate | 100% | 100% |
| http_req_failed_rate | 4.8% | 4.8% |
| faultCheckFailures | 0 | 0 |
| degraded_observed | 1 | 1 |
| recovered_observed | 1 | 1 |
| Affected latency (degraded) | 5.2ms | 4.1ms |
| Recovery latency delta | +1.3ms vs healthy | +0.8ms vs healthy |

---

## 17. Reference

- **Script**: `k6/app/10-production-mix-order-db-fault-recovery.js`
- **Catalog**: `k6/db/case-catalog.json` → case `db-03-order-db-fault-recovery`
- **Dashboard**: `http://localhost:13001/` → run #119 (tcp_reset), run #118 (dns_fail)
- **Overview**: `docs/practice/db/00_overview.md`
- **Previous case**: db-02 (Order DB pressure recovery)
- **Next case**: db-04 (Order DB pool contention)
- **Shared modules**: `k6/shared/common.js`, `k6/shared/traffic.js`
- **Control plane API**: `PUT/GET /ops/order/db/profile`, `POST /ops/order/db/reset`
- **Fault mode concepts**: Fail-fast pattern, circuit breaker integration, payment path protection
