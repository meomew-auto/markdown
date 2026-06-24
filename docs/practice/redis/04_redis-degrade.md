# redis-04 -- Redis delay degradation

> **Case ID:** `redis-04-redis-degrade`
> **Script:** `../app/18-order-service-shared-state-redis-degrade.js`
> **Executor:** `per-vu-iterations`, 2 scenarios, HOTKEY_VUS VUs
> **Topology:** `full-no-cdn`
> **Proof:** Redis chậm không phá vỡ correctness -- latency tăng nhưng counters vẫn exact

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [Redis capability được chứng minh](#2-redis-capability-được-chứng-minh)
3. [Vì sao phải test ở Redis layer](#3-vì-sao-phải-test-ở-redis-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Redis mechanism deep-dive](#6-redis-mechanism-deep-dive)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / counters](#8-key-signals--counters)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output -> decision scenarios](#11-4-output---decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist trước khi chạy](#13-checklist-trước-khi-chạy)
14. [4-5 Variations với code mẫu](#14-4-5-variations-với-code-mẫu)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh nghiệp vụ

Redis nằm trên critical path của order idempotency, webhook dedupe và claim ownership. Khi Redis chậm, latency tăng là expected, nhưng correctness không được hỏng: không duplicate confirm, không duplicate webhook, không để profile degrade ảnh hưởng case sau.

Hãy hình dung một tình huống production điển hình:

```text
1. Hệ thống đang hoạt động bình thường: Redis response time ~1ms.
2. 12:00 -- giờ cao điểm: traffic tăng 3x, Redis bắt đầu bão hòa.
3. Redis response time tăng lên 80ms (thay vì 1ms).
4. Một payment webhook retry storm ập đến: 6 requests cùng event_id.
5. Nếu Redis lock/idempotency mechanism bị race condition do latency cao:
   - 2 requests cùng thấy "chưa có kết quả" -> 2 lần fresh execution.
   - Payment bị apply 2 lần (double charge).
6. Sau khi cao điểm qua đi, Redis trở lại bình thường.
```

Đây không phải là tình huống giả định. Trong các hệ thống thương mại điện tử lớn, Redis degradation là một trong những nguyên nhân hàng đầu gây ra:
- **Double charge**: Payment webhook được xử lý nhiều lần do lock timeout.
- **Duplicate order confirm**: Idempotency key bị race, tạo ra nhiều đơn hàng trùng lặp.
- **Inconsistent state**: Một request thấy Redis có kết quả, request khác thấy Redis chưa có kết quả -- dẫn đến split-brain ở application layer.

### 1.2 Mô hình degrade của case này

Case này mô phỏng Redis degradation thông qua control-plane API:

```text
setup Redis delay -> hotkey confirm race -> hotkey webhook race -> reset Redis profile
```

Khác với case 02 (hotkey race bình thường), case 04 cố tình làm Redis chậm trước khi chạy hotkey race. Điều này cho phép kiểm tra xem correctness có được giữ nguyên khi latency tăng.

| Giai đoạn | Hành động | Mục đích |
| --- | --- | --- |
| **Setup** | Reset Redis profile, set delay=80ms | Tạo môi trường degraded |
| **Confirm race** | HOTKEY_VUS VUs cùng confirm một key | Kiểm tra idempotency dưới degrade |
| **Webhook race** | HOTKEY_VUS VUs cùng gửi một event | Kiểm tra webhook dedupe dưới degrade |
| **Teardown** | Reset Redis profile | Dọn dẹp -- không để ảnh hưởng case sau |

### 1.3 Tại sao "latency tăng" là expected, không phải failure

Nguyên tắc cốt lõi của case này:

> **Khi một dependency (Redis) bị chậm, application PHẢI chậm theo. Điều này là expected behavior. Điều quan trọng là application không được trả về kết quả SAI khi dependency chậm.**

Nếu Redis bị delay 80ms mà application vẫn trả về response trong 10ms, điều đó có nghĩa là application đã bỏ qua Redis -- có thể nó đã fallback sang in-memory cache hoặc bỏ qua idempotency check hoàn toàn. Cả hai đều là hành vi nguy hiểm trong production.

Ngược lại, nếu Redis delay 80ms và application response time tăng từ 50ms lên 130ms, đó là dấu hiệu application đang hoạt động đúng: nó vẫn đi qua Redis, vẫn chờ Redis, và vẫn trả về kết quả chính xác.

### 1.4 Tính chất "shared state" làm tăng rủi ro khi degrade

Redis trong kiến trúc này không phải là cache đơn thuần -- nó là **shared state store**. Nếu Redis là cache và bị chậm, application có thể bỏ qua cache và lấy dữ liệu từ database gốc. Nhưng với shared state (idempotency records, claim ownership, webhook dedupe), application **không thể** bỏ qua Redis vì không có nguồn dữ liệu thay thế.

```text
Cache pattern:              Redis miss -> fallback to DB -> OK (chậm hơn nhưng vẫn đúng)
Shared state pattern:       Redis chậm -> KHÔNG CÓ fallback -> PHẢI chờ Redis
```

Đây là lý do degrade testing cho shared state quan trọng hơn degrade testing cho cache. Cache miss có fallback path; shared state miss không có fallback path.

---

## 2. Redis capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh Redis degrade được kiểm soát:

> **Dưới điều kiện Redis bị delay nhân tạo, hệ thống vẫn duy trì correctness tuyệt đối: đúng 1 fresh confirm và N-1 reuse, đúng 1 fresh webhook và N-1 duplicate. Latency tăng phản ánh chính xác mức độ degrade. Teardown reset sạch profile, không để ảnh hưởng đến case sau.**

Cụ thể hơn, case chứng minh 5 khả năng con:

1. **Control-plane set Redis profile delay thành công**: PUT `/ops/order/redis/profile` với `redis_delay_ms=80` được áp dụng và xác nhận qua GET profile.
2. **Under Redis delay, hotkey confirm race vẫn exact**: Với HOTKEY_VUS=6, đúng 1 fresh confirm + 5 reuse confirm. Không có duplicate side effect.
3. **Under Redis delay, hotkey webhook race vẫn exact**: Với HOTKEY_VUS=6, đúng 1 fresh webhook + 5 duplicate webhook. Không có duplicate payment processing.
4. **Latency trends phản ánh Redis delay**: `order_shared_state_redis_confirm_duration` và `order_shared_state_redis_webhook_duration` tăng so với baseline (case 02) -- chứng minh degrade thực sự được inject.
5. **Teardown reset Redis profile thành công**: POST `/ops/order/redis/reset` trả về 200, đảm bảo profile degrade không rò rỉ sang case sau.

### 2.2 So sánh với các case Redis khác

| Case | Có degrade? | Control-plane? | Cần OPS token? | Focus |
| --- | --- | --- | --- | --- |
| 01 -- Shared state distributed | Không | Không | Không | Idempotency qua nhiều instance |
| 02 -- Hotkey race | Không | Không | Không | Concurrent lock correctness (baseline) |
| 03 -- Claim owner abandon | Không | Không | Không | TTL takeover khi owner chết |
| **04 -- Redis degrade** | **Có (delay injection)** | **Có** | **Có** | **Correctness under latency degradation** |
| 05 -- Hotkey fairness | Không | Không | Không | Hot key không starve normal keys |

Case 04 là case **duy nhất** trong series sử dụng control-plane API để thay đổi behavior của Redis. Điều này làm cho nó trở thành case phức tạp nhất về mặt setup/teardown, và cũng là case duy nhất yêu cầu `OPS_AUTH_TOKEN`.

### 2.3 Baseline comparison: case 02 vs case 04

Case 02 (hotkey race không degrade) là baseline cho case 04:

| Metric | Case 02 (baseline) | Case 04 (degraded) | Kỳ vọng |
| --- | --- | --- | --- |
| `confirm_fresh_count` | 1 | 1 | Giữ nguyên |
| `confirm_reuse_count` | VUS-1 | VUS-1 | Giữ nguyên |
| `webhook_fresh_count` | 1 | 1 | Giữ nguyên |
| `webhook_duplicate_count` | VUS-1 | VUS-1 | Giữ nguyên |
| `confirm_duration` avg | ~50ms | ~130ms (50 + 80) | Tăng ~80ms |
| `webhook_duration` avg | ~40ms | ~120ms (40 + 80) | Tăng ~80ms |

Sự khác biệt duy nhất phải là **latency**. Mọi counter về correctness phải giữ nguyên. Đây chính là định nghĩa của "degraded but correct".

---

## 3. Vì sao phải test ở Redis layer

### 3.1 Đây không phải là vấn đề của application code đơn thuần

Application code có thể có timeout, retry, circuit breaker -- nhưng những cơ chế này được thiết kế để đối phó với failure, không phải với degradation. Khi Redis chậm nhưng không chết:

- Timeout có thể chưa được kích hoạt (Redis vẫn trả lời, chỉ chậm hơn).
- Circuit breaker có thể chưa mở (error rate vẫn thấp).
- Retry có thể làm tình hình tệ hơn (retry storm khi Redis đã chậm sẵn).

Application layer test không thể mô phỏng được tình huống này vì không có cách nào để làm chậm Redis từ bên trong application code.

### 3.2 Control-plane API: khả năng độc nhất của Redis layer testing

Điều làm cho case này đặc biệt là sự tồn tại của **control-plane API**:

```text
PUT /ops/order/redis/profile
{
  "redis_delay_ms": 80,
  "redis_fault_mode": "none",
  "redis_pressure_limit": 0,
  "redis_pressure_hold_ms": 0
}
```

API này cho phép thay đổi behavior của Redis **mà không cần restart container, không cần network manipulation (tc, iptables), và không ảnh hưởng đến các service khác**. Đây là một khả năng testability quan trọng:

| Cách inject delay | Ưu điểm | Nhược điểm |
| --- | --- | --- |
| `tc qdisc` (network delay) | Sát với thực tế | Ảnh hưởng đến tất cả connections; cần root; khó tự động hóa |
| Proxy delay (toxiproxy) | Linh hoạt | Cần thêm container; thêm điểm failure |
| **Control-plane API** (case này) | Chính xác, không ảnh hưởng service khác, dễ tự động hóa | Yêu cầu server hỗ trợ; chỉ test được delay trong app code, không test được network delay thực sự |

### 3.3 Phân biệt với network-level degrade testing

Network-level degrade (dùng `tc` hoặc toxiproxy) test xem application có xử lý được network latency không. Control-plane degrade test xem application có xử lý được **logical latency** không -- tức là Redis operation mất nhiều thời gian hơn dù network vẫn nhanh.

Cả hai đều quan trọng, nhưng control-plane degrade test có lợi thế:
- Có thể test chính xác mức delay (80ms, 200ms, 500ms) mà không bị nhiễu bởi network jitter.
- Có thể kết hợp với fault mode (ví dụ: `redis_fault_mode=timeout` để mô phỏng Redis timeout hoàn toàn).
- Không ảnh hưởng đến các service khác dùng chung network interface.

---

## 4. Topology và precondition

### 4.1 Topology

```text
k6 (HOTKEY_VUS VUs, 2 scenarios, per-vu-iterations)
  |
  | Setup: control-plane operations
  |   POST /ops/order/redis/reset
  |   PUT  /ops/order/redis/profile  { redis_delay_ms: 80 }
  |   GET  /ops/order/redis/profile  (verify)
  |
  | Scenario 1 (t=0s): HOTKEY_VUS confirm requests đồng thời
  |   POST /api/sim/orders/{orderId}/confirm
  |   Idempotency-Key: same key for all VUs
  |
  | Scenario 2 (t=4s): HOTKEY_VUS webhook requests đồng thời
  |   POST /api/sim/orders/webhooks/payment
  |   event_id: same for all VUs
  |
  | Teardown: control-plane cleanup
  |   POST /ops/order/redis/reset
  v
Nginx :80 (lb-app container)
  |
  | path-based routing
  |   /api/sim/orders/* -> order-service
  |   /ops/order/redis/* -> order-service (ops endpoint)
  v
order-service
  |
  | Business logic: DB writes, external call simulation
  | Redis operations: SET NX, GET idempotency record
  v
Redis (shared state store)
  |
  | Control-plane profile: delay injected at application level
  | Mỗi Redis operation bị delay thêm redis_delay_ms
  v
PostgreSQL (persistent state)
```

### 4.2 Precondition

Trước khi chạy case này, các điều kiện sau phải được đáp ứng:

```powershell
# 1. Stack đã được start với đúng topology
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2

# 2. Biến môi trường
$env:BASE_URL = "http://localhost:80"
$env:ORDER_SHARED_STATE_REDIS_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_SHARED_STATE_REDIS_CONTROL_MODE = "http"
$env:ORDER_SHARED_STATE_REDIS_DELAY_MS = "80"
$env:ORDER_SHARED_STATE_REDIS_HOTKEY_VUS = "6"
$env:OPS_AUTH_TOKEN = "<ops-token>"

# 3. Xác nhận control-plane hoạt động
curl -s -X POST http://localhost:80/ops/order/redis/reset `
  -H "Authorization: Bearer <ops-token>" `
  -H "X-Ops-Token: <ops-token>"
# Kỳ vọng: 200

# 4. Xác nhận Redis profile có thể đọc được
curl -s http://localhost:80/ops/order/redis/profile `
  -H "Authorization: Bearer <ops-token>"
# Kỳ vọng: 200 với profile JSON
```

### 4.3 Token/control-plane requirement

Case này cần ops token khi `ORDER_SHARED_STATE_REDIS_CONTROL_MODE=http` vì gọi:

```text
POST /ops/order/redis/reset
PUT  /ops/order/redis/profile
GET  /ops/order/redis/profile
POST /ops/order/redis/reset   # teardown
```

Env:

```powershell
$env:ORDER_SHARED_STATE_REDIS_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_SHARED_STATE_REDIS_CONTROL_MODE = "http"
$env:ORDER_SHARED_STATE_REDIS_DELAY_MS = "80"
$env:ORDER_SHARED_STATE_REDIS_HOTKEY_VUS = "6"
$env:OPS_AUTH_TOKEN = "<ops-token>"
```

Không in token thật trong docs/report.

### 4.4 Environment variables đầy đủ

| Biến | Default | Mô tả |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | Public URL của Nginx gateway |
| `ORDER_SHARED_STATE_REDIS_CONTROL_BASE_URL` | `http://localhost:80` | Base URL cho control-plane API (thường giống BASE_URL) |
| `ORDER_SHARED_STATE_REDIS_CONTROL_MODE` | `http` | `http` = gọi API thật; nếu khác `http` thì skip control-plane (dùng cho môi trường không có ops endpoint) |
| `ORDER_SHARED_STATE_REDIS_PROFILE_PATH` | `/ops/order/redis/profile` | Path cho profile management |
| `ORDER_SHARED_STATE_REDIS_RESET_PATH` | `/ops/order/redis/reset` | Path cho reset Redis profile |
| `ORDER_SHARED_STATE_REDIS_DELAY_MS` | `80` | Độ trễ (ms) được inject vào mỗi Redis operation |
| `ORDER_SHARED_STATE_REDIS_HOTKEY_VUS` | `6` | Số VU cho mỗi scenario (confirm và webhook) |
| `ORDER_SHARED_STATE_REDIS_CONFIRM_DB_WRITES` | `2` | Số DB writes trong confirm flow |
| `ORDER_SHARED_STATE_REDIS_CONFIRM_EXTERNAL_MS` | `100` | Thời gian external call (ms) trong confirm flow |
| `ORDER_SHARED_STATE_REDIS_WEBHOOK_DB_WRITES` | `2` | Số DB writes trong webhook flow |
| `OPS_AUTH_TOKEN` | (rỗng) | **Bắt buộc** khi `CONTROL_MODE=http` |

### 4.5 Cơ chế hoạt động của control-plane

Control-plane API hoạt động ở application level, không phải ở Redis level:

```text
PUT /ops/order/redis/profile { redis_delay_ms: 80 }
  -> order-service nhận request
  -> order-service set biến internal: REDIS_DELAY_MS = 80
  -> Mỗi lần gọi Redis operation, order-service thêm sleep(80ms)
  -> Không có thay đổi gì trong Redis server thực tế
```

Điều này có nghĩa:
- Delay được thêm vào **trước hoặc sau** Redis operation (tùy implement), không phải trong quá trình truyền network.
- Các service khác dùng chung Redis instance không bị ảnh hưởng.
- Delay có thể được set về 0 thông qua reset.

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `18-order-service-shared-state-redis-degrade.js` gồm 208 dòng, được tổ chức thành 8 phần:

```text
(A) IMPORTS + CONSTANTS          (dòng 1-17):  k6 modules, env vars
(B) CUSTOM METRICS               (dòng 19-25): 5 counters + 2 trends
(C) OPTIONS + SCENARIOS          (dòng 27-57): 2 scenarios, 6 thresholds
(D) HELPER FUNCTIONS             (dòng 59-98): authHeaders, safeJson, controlRequest, assertRedisProfile
(E) LIFECYCLE: SETUP             (dòng 112-138): reset + set delay + verify
(F) LIFECYCLE: TEARDOWN          (dòng 140-149): reset Redis profile
(G) REQUEST FUNCTIONS            (dòng 151-173): postConfirm, postWebhook
(H) SCENARIO EXEC FUNCTIONS      (dòng 175-208): confirmHotkey, webhookHotkey
```

### 5.2 Phân tích -- Phần A: Imports và Constants

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { envInt, envString } from '../shared/common.js';
```

```javascript
const BASE_URL = envString('BASE_URL', 'http://localhost:80').replace(/\/$/, '');
const CONTROL_BASE_URL = envString('ORDER_SHARED_STATE_REDIS_CONTROL_BASE_URL', BASE_URL).replace(/\/$/, '');
const REDIS_CONTROL_MODE = envString('ORDER_SHARED_STATE_REDIS_CONTROL_MODE', 'http').toLowerCase();
const REDIS_DELAY_MS = envInt('ORDER_SHARED_STATE_REDIS_DELAY_MS', 80);
const HOTKEY_VUS = envInt('ORDER_SHARED_STATE_REDIS_HOTKEY_VUS', 6);
const OPS_AUTH_TOKEN = envString('OPS_AUTH_TOKEN', '');
```

`REDIS_CONTROL_MODE` là biến quan trọng: nếu là `'http'`, script sẽ gọi control-plane API thật. Nếu là giá trị khác (ví dụ `'none'` hoặc `'direct'`), script bỏ qua setup/teardown -- hữu ích khi chạy trong môi trường không có ops endpoint.

`CONTROL_BASE_URL` mặc định bằng `BASE_URL`, nhưng có thể được override để trỏ đến một endpoint quản lý riêng (ví dụ: internal admin port).

### 5.3 Phân tích -- Phần B: Custom Metrics

```javascript
const redisDegradeFailures = new Counter('order_shared_state_redis_degrade_check_failures');
const confirmFreshCount = new Counter('order_shared_state_redis_confirm_fresh_count');
const confirmReuseCount = new Counter('order_shared_state_redis_confirm_reuse_count');
const webhookFreshCount = new Counter('order_shared_state_redis_webhook_fresh_count');
const webhookDuplicateCount = new Counter('order_shared_state_redis_webhook_duplicate_count');
const confirmDuration = new Trend('order_shared_state_redis_confirm_duration', true);
const webhookDuration = new Trend('order_shared_state_redis_webhook_duration', true);
```

| Metric | Loại | Ý nghĩa | Giá trị kỳ vọng (HOTKEY_VUS=6) |
| --- | --- | --- | --- |
| `order_shared_state_redis_degrade_check_failures` | Counter | Tổng số check thất bại | 0 |
| `order_shared_state_redis_confirm_fresh_count` | Counter | Số lần confirm fresh execution | 1 |
| `order_shared_state_redis_confirm_reuse_count` | Counter | Số lần confirm reuse | 5 (HOTKEY_VUS - 1) |
| `order_shared_state_redis_webhook_fresh_count` | Counter | Số lần webhook fresh | 1 |
| `order_shared_state_redis_webhook_duplicate_count` | Counter | Số lần webhook duplicate | 5 (HOTKEY_VUS - 1) |
| `order_shared_state_redis_confirm_duration` | Trend | Thời gian xử lý confirm (ms) | Cao hơn baseline ~80ms |
| `order_shared_state_redis_webhook_duration` | Trend | Thời gian xử lý webhook (ms) | Cao hơn baseline ~80ms |

### 5.4 Phân tích -- Phần C: Options và Scenarios

```javascript
export const options = {
  noConnectionReuse: true,
  scenarios: {
    confirm_hotkey_redis_degrade: {
      executor: 'per-vu-iterations',
      exec: 'confirmHotkey',
      vus: HOTKEY_VUS,
      iterations: 1,
      maxDuration: '1m',
      tags: { scenario: 'order_shared_state_redis_degrade', phase: 'confirm_hotkey' },
    },
    webhook_hotkey_redis_degrade: {
      executor: 'per-vu-iterations',
      exec: 'webhookHotkey',
      vus: HOTKEY_VUS,
      iterations: 1,
      startTime: '4s',
      maxDuration: '1m',
      tags: { scenario: 'order_shared_state_redis_degrade', phase: 'webhook_hotkey' },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    order_shared_state_redis_degrade_check_failures: ['count==0'],
    order_shared_state_redis_confirm_fresh_count: ['count==1'],
    order_shared_state_redis_confirm_reuse_count: [`count==${Math.max(HOTKEY_VUS - 1, 0)}`],
    order_shared_state_redis_webhook_fresh_count: ['count==1'],
    order_shared_state_redis_webhook_duplicate_count: [`count==${Math.max(HOTKEY_VUS - 1, 0)}`],
  },
};
```

**Executor choice -- `per-vu-iterations`:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **per-vu-iterations** (đang dùng) | ✅ **ĐÚNG** | Mỗi VU gửi đúng 1 request, tất cả VUs cùng chạy đồng thời. Tạo ra chính xác HOTKEY_VUS requests đồng thời với cùng một key. |
| constant-vus | ❌ SAI | Loop vô hạn -- mỗi VU gửi nhiều request, không kiểm soát được số lượng fresh/reuse. |
| shared-iterations | ❌ SAI | Iterations được chia cho VUs -- không đảm bảo tất cả VUs cùng gửi request một lúc. |
| constant-arrival-rate | ❌ SAI | Ép rate -- case này cần burst đồng thời, không phải rate ổn định. |

**Hai scenarios tách biệt với `startTime: '4s'`:**

```text
Timeline:
t=0s:  Scenario 1 bắt đầu -- HOTKEY_VUS VUs cùng confirm
t~=1s: Scenario 1 kết thúc (tất cả response đã về)
t=4s:  Scenario 2 bắt đầu -- HOTKEY_VUS VUs cùng webhook
t~=5s: Scenario 2 kết thúc
```

`startTime: '4s'` đảm bảo hai scenarios không chạy đồng thời. Nếu không có `startTime`, cả hai scenarios sẽ bắt đầu cùng lúc và Redis sẽ phải xử lý 2*HOTKEY_VUS requests đồng thời -- gây nhiễu latency signal.

**Thresholds**:
- `checks: ['rate==1']` -- 100% checks pass.
- `http_req_failed: ['rate==0']` -- 0% HTTP failure (khắt khe hơn case 02 vì đây là correctness test).
- `confirm_fresh_count: ['count==1']` -- Chính xác 1 fresh.
- `confirm_reuse_count: ['count==HOTKEY_VUS-1']` -- Chính xác HOTKEY_VUS-1 reuse.
- Tương tự cho webhook.

### 5.5 Phân tích -- Phần D: Helper Functions

**authHeaders:**
```javascript
function authHeaders(extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Test-Suite': 'order-service-shared-state-redis-degrade',
    ...extraHeaders,
  };
  if (OPS_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${OPS_AUTH_TOKEN}`;
    headers['X-Ops-Token'] = OPS_AUTH_TOKEN;
  }
  return headers;
}
```

OPS token được gửi qua cả `Authorization` header (Bearer token) và `X-Ops-Token` header (custom header). Cả hai đều được gửi để tương thích với các implementation khác nhau của ops authentication.

**controlRequest:**
```javascript
function controlRequest(method, path, body, step) {
  const params = {
    headers: authHeaders(),
    tags: { step, control_plane: 'order_redis', target_service: 'order-service', target_dependency: 'redis' },
  };
  const url = `${CONTROL_BASE_URL}${path}`;
  if (method === 'POST') {
    return http.post(url, JSON.stringify(body || {}), params);
  }
  if (method === 'PUT') {
    return http.put(url, JSON.stringify(body || {}), params);
  }
  return http.get(url, params);
}
```

Hàm này hỗ trợ GET, POST, PUT cho control-plane operations. Tag `control_plane: 'order_redis'` cho phép lọc control-plane requests trong dashboard.

**assertRedisProfile:**
```javascript
function assertRedisProfile(label, expectedDelayMs) {
  const response = controlRequest('GET', REDIS_PROFILE_PATH, null, `${label}_redis_profile`);
  const payload = safeJson(response);
  const profile = payload && payload.profile ? payload.profile : {};
  check({ response, payload, profile }, {
    [`${label} redis profile status 200`]: (o) => o.response.status === 200 || recordCheckFailure(...),
    [`${label} redis profile success true`]: (o) => o.payload && o.payload.success === true || recordCheckFailure(...),
    [`${label} redis delay ${expectedDelayMs}`]: (o) => Number(o.profile.redis_delay_ms || 0) === expectedDelayMs || recordCheckFailure(...),
    [`${label} redis fault none`]: (o) => String(o.profile.redis_fault_mode || '') === '' || recordCheckFailure(...),
  });
}
```

Hàm này không chỉ kiểm tra delay được set đúng, mà còn kiểm tra `redis_fault_mode` là empty/none. Điều này đảm bảo không có fault mode (như timeout injection) vô tình được bật từ lần chạy trước.

### 5.6 Phân tích -- Phần E+F: Setup và Teardown

**Setup function:**

```javascript
export function setup() {
  if (REDIS_CONTROL_MODE === 'http') {
    const reset = controlRequest('POST', REDIS_RESET_PATH, {}, 'setup_redis_reset');
    check(reset, {
      'setup redis reset status 200': (r) => r.status === 200 || recordCheckFailure('setup_redis_reset_status'),
    });

    const set = controlRequest('PUT', REDIS_PROFILE_PATH, {
      redis_delay_ms: REDIS_DELAY_MS,
      redis_pressure_limit: 0,
      redis_pressure_hold_ms: 0,
      redis_fault_mode: 'none',
    }, 'setup_redis_delay');
    check(set, {
      'setup redis delay status 200': (r) => r.status === 200 || recordCheckFailure('setup_redis_delay_status'),
    });
    assertRedisProfile('setup', REDIS_DELAY_MS);
  }

  const base = `${Date.now()}`;
  return {
    confirmOrderId: `ORD-REDIS-DEGRADE-CONFIRM-${base}`,
    confirmKey: `idem-redis-degrade-${base}`,
    webhookOrderId: `ORD-REDIS-DEGRADE-WEBHOOK-${base}`,
    webhookEventId: `evt-redis-degrade-${base}`,
  };
}
```

Setup thực hiện 3 bước tuần tự:
1. **Reset** -- đảm bảo bắt đầu từ trạng thái sạch (không có delay/fault từ lần chạy trước).
2. **Set delay** -- PUT profile với `redis_delay_ms=80` và `redis_fault_mode=none`.
3. **Verify** -- GET profile để xác nhận delay đã được áp dụng.

Data được return từ setup (order IDs, keys) sẽ được truyền vào mỗi VU executor function.

**Teardown function:**

```javascript
export function teardown() {
  if (REDIS_CONTROL_MODE !== 'http') {
    return;
  }

  const reset = controlRequest('POST', REDIS_RESET_PATH, {}, 'teardown_redis_reset');
  check(reset, {
    'teardown redis reset status 200': (r) => r.status === 200 || recordCheckFailure('teardown_redis_reset_status'),
  });
}
```

Teardown reset Redis profile. **Đây là bước bắt buộc sống còn**: nếu không reset, tất cả các case Redis sau đó sẽ chạy dưới điều kiện degraded mà không ai biết. Kết quả của chúng sẽ bị sai một cách âm thầm.

### 5.7 Phân tích -- Phần G+H: Request và Exec Functions

**postConfirm / postWebhook** -- Tương tự case 02:

```javascript
function postConfirm(orderId, idempotencyKey) {
  const response = http.post(
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=0&db_writes=${CONFIRM_DB_WRITES}&external_ms=${CONFIRM_EXTERNAL_MS}&external_fail_rate=0`,
    JSON.stringify({}),
    {
      headers: authHeaders({ 'Idempotency-Key': idempotencyKey }),
      tags: { flow: 'order_confirm_redis_degrade', target_service: 'order-service', target_dependency: 'redis' },
    },
  );
  return { response, payload: safeJson(response) };
}
```

Khác biệt chính so với case 02: `target_dependency: 'redis'` được thêm vào tags. Tag này cho phép filter và so sánh latency giữa baseline và degraded trong dashboard.

**confirmHotkey exec function:**

```javascript
export function confirmHotkey(data) {
  const result = postConfirm(data.confirmOrderId, data.confirmKey);
  confirmDuration.add(result.response.timings.duration);
  check(result, {
    'confirm redis degrade status 200': (o) => o.response.status === 200 || recordCheckFailure('confirm_status'),
    'confirm redis degrade success true': (o) => o.payload && o.payload.success === true || recordCheckFailure('confirm_success'),
    'confirm redis degrade order id preserved': (o) => o.payload && o.payload.data && o.payload.data.order_id === data.confirmOrderId || recordCheckFailure('confirm_order_id'),
  });

  const reuse = !!(result.payload && result.payload.data && result.payload.data.idempotency_reuse === true);
  if (reuse) {
    confirmReuseCount.add(1);
  } else {
    confirmFreshCount.add(1);
  }
}
```

Pattern tương tự case 02: dùng `idempotency_reuse` để phân biệt fresh vs reuse, và tăng counter tương ứng. Mỗi VU chạy hàm này đúng 1 lần (per-vu-iterations), nên tổng counters = HOTKEY_VUS.

---

## 6. Redis mechanism deep-dive

### 6.1 Cách delay được inject ở application level

Delay được inject **trong application code**, không phải ở Redis server hay network layer:

```text
Mỗi lần order-service gọi Redis operation:
1. (optional) Pre-delay: sleep(REDIS_DELAY_MS) trước khi gọi Redis
2. Redis operation thực tế (SET NX, GET, DEL, TTL, ...)
3. (optional) Post-delay: sleep(REDIS_DELAY_MS) sau khi gọi Redis

Hoặc:
1. Redis operation thực tế
2. sleep(REDIS_DELAY_MS) -- mô phỏng Redis chậm
```

Cả hai cách đều tạo ra delay nhân tạo trong critical path của request. Điều quan trọng là delay được áp dụng **cho tất cả Redis operations** trong phạm vi order-service, không chỉ cho một operation cụ thể.

### 6.2 So sánh delay injection vs network delay

| Khía cạnh | Application-level delay (case này) | Network delay (tc/toxiproxy) |
| --- | --- | --- |
| Phạm vi ảnh hưởng | Chỉ order-service | Tất cả services dùng chung network |
| Độ chính xác | Chính xác đến ms | Bị ảnh hưởng bởi jitter, buffer |
| Cần quyền root? | Không | Có (tc) hoặc cần thêm container (toxiproxy) |
| Test được logic race? | Có -- delay ảnh hưởng đến timing giữa lock check và lock acquire | Có nhưng khó kiểm soát chính xác |
| Test được TCP behavior? | Không | Có (TCP retransmit, congestion window, ...) |
| Phù hợp cho CI/CD? | Rất phù hợp | Khó tự động hóa |

### 6.3 Cách hotkey race hoạt động dưới degrade

Khi HOTKEY_VUS=6 VUs cùng gửi request với cùng `Idempotency-Key`:

```text
Timing với Redis delay = 80ms và confirm external = 100ms:

VU-1: gửi request -> Redis SET NX (delay 80ms) -> OK -> DB writes (2) -> external (100ms)
      -> lưu kết quả -> Redis SET idempotency record (delay 80ms) -> response ~260ms

VU-2: gửi request -> Redis SET NX (delay 80ms) -> FAIL (key đã tồn tại)
      -> Redis GET idempotency record (delay 80ms) -> chưa có (VU-1 chưa lưu xong)
      -> RETRY: chờ một chút rồi thử lại
      -> Redis GET idempotency record (delay 80ms) -> có rồi! -> reuse -> response ~300ms

VU-3...VU-6: tương tự VU-2, nhưng nhanh hơn vì idempotency record đã có sẵn
      -> Redis GET idempotency record (delay 80ms) -> có -> reuse -> response ~120ms
```

Với Redis delay 80ms, mỗi Redis operation mất thêm 80ms. Nhưng cơ chế retry/poll của server đảm bảo rằng:
- VU-1 (đầu tiên) sẽ thực thi fresh và lưu kết quả.
- Các VU khác sẽ thấy kết quả (có thể phải retry vài lần) và reuse.

Số lần retry tăng khi delay tăng, nhưng kết quả cuối cùng vẫn chính xác: 1 fresh + N-1 reuse.

### 6.4 Race condition window dưới degrade

Race condition window là khoảng thời gian giữa "VU-1 claim key" và "VU-1 lưu kết quả". Dưới degrade, window này mở rộng:

```text
Không degrade (Redis ~1ms):
  [claim]---2ms---[lưu kết quả]
  window = 2ms -> rất nhỏ, ít VU phải retry

Có degrade (Redis +80ms):
  [claim]---160ms---[lưu kết quả]
  window = 160ms -> lớn hơn, nhiều VU phải retry hơn
```

Các VU đến trong window này sẽ không thấy kết quả và phải retry. Nhưng miễn là cơ chế retry/poll hoạt động đúng, cuối cùng tất cả VU (trừ VU đầu tiên) sẽ thấy kết quả và reuse.

### 6.5 Tại sao `redis_fault_mode` phải là `none`

Case này chỉ test delay, không test fault. `redis_fault_mode` phải được set về `'none'` để đảm bảo:
- Redis operation không bị fail giả lập (timeout, connection refused).
- Chỉ có delay được inject.
- Các VU không bị 5xx do fault injection.

Nếu `redis_fault_mode` khác `'none'`, một số Redis operation có thể fail, dẫn đến một số request fail thay vì reuse -- counters sẽ sai.

### 6.6 Teardown: tại sao reset là bắt buộc

```text
Không có teardown:
  Case 04 chạy xong -> Redis profile còn delay=80ms
  -> Case 05 (hotkey fairness) chạy với delay=80ms
  -> Case 05 latency cao hơn bình thường
  -> Người đọc tưởng fairness mechanism làm chậm, nhưng thực ra là residual delay từ case 04
  -> Debug mất hàng giờ

Có teardown:
  Case 04 chạy xong -> Redis profile được reset
  -> Case 05 chạy bình thường
  -> Không có cross-case contamination
```

Đây là lý do `teardown_redis_reset` là một phần không thể thiếu của case này, và teardown check (status 200) được đưa vào thresholds.

---

## 7. Request sequence flow

### 7.1 Timeline tổng thể

```text
Time (s)  |  Phase                        |  Actor              |  Redis profile
----------|-------------------------------|---------------------|------------------
0.0       |  setup() bắt đầu              |  k6 setup           |  (unknown)
0.0-0.1   |  POST /ops/order/redis/reset  |  k6 setup           |  delay=0, fault=none
0.1-0.2   |  PUT /ops/order/redis/profile |  k6 setup           |  delay=80, fault=none
0.2-0.3   |  GET /ops/order/redis/profile |  k6 setup           |  verify delay=80
0.3       |  setup() hoàn thành           |  k6 setup           |  delay=80, fault=none
----------|-------------------------------|---------------------|------------------
0.3       |  Scenario 1 bắt đầu           |  6 VUs confirm      |  delay=80
0.3       |  6 VUs cùng POST /confirm     |  confirmHotkey()    |  delay=80
0.3-1.0   |  1 VU fresh, 5 VU reuse       |  order-service      |  delay=80
1.0       |  Scenario 1 kết thúc          |  confirmHotkey()    |  delay=80
----------|-------------------------------|---------------------|------------------
4.0       |  Scenario 2 bắt đầu           |  6 VUs webhook      |  delay=80
4.0       |  6 VUs cùng POST /webhook     |  webhookHotkey()    |  delay=80
4.0-4.7   |  1 VU fresh, 5 VU duplicate   |  order-service      |  delay=80
4.7       |  Scenario 2 kết thúc          |  webhookHotkey()    |  delay=80
----------|-------------------------------|---------------------|------------------
4.7       |  teardown() bắt đầu           |  k6 teardown        |  delay=80
4.7-4.8   |  POST /ops/order/redis/reset  |  k6 teardown        |  delay=0, fault=none
4.8       |  teardown() hoàn thành        |  k6 teardown        |  delay=0, fault=none
```

### 7.2 Sequence diagram chi tiết (confirm flow)

```text
SETUP:
k6 setup            order-service             Redis (shared state)
    |                    |                         |
    |-- POST /reset ---->|                         |
    |<-- 200 ------------|                         |
    |                    |                         |
    |-- PUT /profile --->|                         |
    |  delay=80          |                         |
    |<-- 200 ------------| (set internal delay=80) |
    |                    |                         |
    |-- GET /profile --->|                         |
    |<-- 200, delay=80 --|                         |
    |                    |                         |
    | (return data)      |                         |
    |                    |                         |

RUNTIME (Scenario 1):
k6 VU1..VU6         order-service             Redis (shared state)
    |                    |                         |
    | (6 requests đồng thời, cùng Idempotency-Key)|
    |                    |                         |
VU1:|- POST /confirm -->|                         |
    |                    |-- SET NX (+80ms) ------>|
    |                    |<-- OK ------------------|
    |                    |                         |
VU2:|- POST /confirm -->|                         |
    |                    |-- SET NX (+80ms) ------>|
    |                    |<-- null (key exists) ---|
    |                    |-- GET result (+80ms) -->|
    |                    |<-- null (chưa có) ------|
    |                    | (retry...)              |
    |                    |                         |
VU1:                    |-- (xử lý business)       |
    |                    |-- DB writes, external    |
    |                    |-- LƯU kết quả (+80ms) ->|
    |<-- 200, reuse=false|                         |
    |                    |                         |
VU2:                    |-- GET result (+80ms) -->|
    |                    |<-- có kết quả! ---------|
    |<-- 200, reuse=true |                         |
    |                    |                         |
VU3..VU6: (tương tự VU2, nhưng nhanh hơn vì      |
    kết quả đã có sẵn)                             |

TEARDOWN:
k6 teardown         order-service
    |                    |
    |-- POST /reset ---->|
    |<-- 200 ------------|
    |                    | (reset internal delay=0)
```

### 7.3 Concurrency model

```text
Scenario 1 (confirm_hotkey_redis_degrade):
VU-1: |--- fresh (delay 80ms) ---|
VU-2: |--- retry -> reuse -------|
VU-3: |--- reuse -----------------|
VU-4: |--- reuse -----------------|
VU-5: |--- reuse -----------------|
VU-6: |--- reuse -----------------|

Tất cả 6 VUs bắt đầu đồng thời tại t=0.3s.
VU-1 hoàn thành fresh sau ~260ms.
Các VU khác hoàn thành reuse trong khoảng 100-300ms tùy vào việc có phải retry không.

Scenario 2 (webhook_hotkey_redis_degrade):
Tương tự, bắt đầu tại t=4s.

Tổng thời gian chạy: ~5 giây (setup 0.3s + scenario 1 ~0.7s + gap 4s + scenario 2 ~0.7s)
```

### 7.4 Tại sao `startTime: '4s'` là cần thiết

Nếu không có `startTime`, cả hai scenarios sẽ bắt đầu đồng thời:

```text
SAI (không có startTime):
t=0.3s: 6 VUs confirm + 6 VUs webhook = 12 requests đồng thời
-> Redis phải xử lý 12 concurrent operations
-> Lock contention giữa confirm và webhook (khác key nhưng cùng Redis instance)
-> Latency signal bị nhiễu: không biết delay đến từ Redis degrade hay đến từ contention

ĐÚNG (có startTime: '4s'):
t=0.3s: 6 VUs confirm
t=4.0s: 6 VUs webhook
-> Mỗi thời điểm chỉ có 6 requests
-> Latency signal sạch: chỉ phản ánh Redis degrade
```

---

## 8. Key signals / counters

### 8.1 Bảng counters đầy đủ

| Counter | Loại | Giá trị kỳ vọng (HOTKEY_VUS=6) | Ý nghĩa | Hậu quả nếu sai |
| --- | --- | --- | --- | --- |
| `checks` | Rate | 100% (rate==1) | Tất cả checks pass | Nếu < 100%: có check fail |
| `http_req_failed` | Rate | 0% (rate==0) | Không có HTTP failure | Nếu > 0%: có request fail -- có thể do Redis degrade gây timeout |
| `order_shared_state_redis_degrade_check_failures` | Count | 0 | Không có check failure | Nếu > 0: correctness bị ảnh hưởng bởi degrade |
| `order_shared_state_redis_confirm_fresh_count` | Count | 1 | Đúng 1 fresh confirm | Nếu > 1: duplicate side effect -- Redis degrade làm hỏng lock |
| `order_shared_state_redis_confirm_reuse_count` | Count | 5 (HOTKEY_VUS-1) | Đúng 5 reuse confirm | Nếu < 5: một số request không reuse được -- có thể fail hoặc fresh sai |
| `order_shared_state_redis_webhook_fresh_count` | Count | 1 | Đúng 1 fresh webhook | Nếu > 1: duplicate payment processing |
| `order_shared_state_redis_webhook_duplicate_count` | Count | 5 (HOTKEY_VUS-1) | Đúng 5 duplicate webhook | Nếu < 5: một số webhook không được dedupe |
| `order_shared_state_redis_confirm_duration` | Trend | Cao hơn baseline ~80ms | Latency confirm dưới degrade | Nếu không tăng: degrade chưa thực sự được inject |
| `order_shared_state_redis_webhook_duration` | Trend | Cao hơn baseline ~80ms | Latency webhook dưới degrade | Nếu không tăng: kiểm tra lại control-plane setup |

### 8.2 Bảng control-plane signals

| Signal | Vị trí | Expected value | Ý nghĩa |
| --- | --- | --- | --- |
| Setup reset status | Response status | 200 | Redis profile được reset về mặc định |
| Setup delay status | Response status | 200 | Delay được set thành công |
| Profile `redis_delay_ms` | Response body JSON | 80 (hoặc giá trị `REDIS_DELAY_MS`) | Xác nhận delay đã được áp dụng |
| Profile `redis_fault_mode` | Response body JSON | `''` hoặc `'none'` | Không có fault injection đang active |
| Teardown reset status | Response status | 200 | Profile được reset sạch sau khi test |

### 8.3 Bảng response body signals (runtime)

| Signal | Vị trí | Flow | Expected |
| --- | --- | --- | --- |
| `success` | Response body JSON | Confirm + Webhook | `true` cho tất cả requests |
| `idempotency_reuse` | `data.idempotency_reuse` | Confirm | `false` cho 1 VU, `true` cho 5 VU |
| `webhook_duplicate` | `data.webhook_duplicate` | Webhook | `false` cho 1 VU, `true` cho 5 VU |
| `order_id` | `data.order_id` | Confirm | Giữ nguyên cho tất cả VU |
| `event_id` | `data.event_id` | Webhook | Giữ nguyên cho tất cả VU |
| `payment_status` | `data.payment_status` | Webhook | `'paid'` cho tất cả VU |

### 8.4 Signal relationship map

```text
┌── Control-plane ──────────────────────────────────┐
│  setup reset: 200                                  │
│  setup delay: 200                                  │
│  profile redis_delay_ms == 80 ── (A) Degrade ON    │
│  profile redis_fault_mode == '' ── (B) No fault    │
└────────────────────────────────────────────────────┘
                    │
                    ▼
┌── Runtime: Confirm ───────────────────────────────┐
│  fresh_count == 1 ── (C) Atomic lock OK            │
│  reuse_count == VUS-1 ── (D) Dedupe OK             │
│  duration > baseline ── (E) Latency reflects delay │
└────────────────────────────────────────────────────┘
                    │
                    ▼
┌── Runtime: Webhook ───────────────────────────────┐
│  fresh_count == 1 ── (F) Atomic lock OK            │
│  duplicate_count == VUS-1 ── (G) Dedupe OK         │
│  duration > baseline ── (H) Latency reflects delay │
└────────────────────────────────────────────────────┘
                    │
                    ▼
┌── Control-plane ──────────────────────────────────┐
│  teardown reset: 200 ── (I) Profile cleared        │
└────────────────────────────────────────────────────┘

Tất cả 9 signal (A đến I) cùng đúng -> Redis degrade behavior được chứng minh
```

---

## 9. Pass/fail criteria

### 9.1 PASS criteria

Tất cả các điều kiện sau đồng thời đúng:

| # | Tiêu chí | Cách kiểm tra | Threshold |
| --- | --- | --- | --- |
| P1 | Tất cả checks pass | `checks` | rate==1 |
| P2 | Không có HTTP failure | `http_req_failed` | rate==0 |
| P3 | Không có check failure | `order_shared_state_redis_degrade_check_failures` | count==0 |
| P4 | Setup reset Redis profile thành công | Check trong script | status 200 |
| P5 | Setup set delay thành công | Check trong script | status 200 |
| P6 | Profile delay đúng giá trị | Check `assertRedisProfile` | `redis_delay_ms == REDIS_DELAY_MS` |
| P7 | Profile fault mode empty/none | Check `assertRedisProfile` | `redis_fault_mode == ''` |
| P8 | Đúng 1 fresh confirm | `order_shared_state_redis_confirm_fresh_count` | count==1 |
| P9 | Đúng HOTKEY_VUS-1 reuse confirm | `order_shared_state_redis_confirm_reuse_count` | count==5 (với 6 VUs) |
| P10 | Đúng 1 fresh webhook | `order_shared_state_redis_webhook_fresh_count` | count==1 |
| P11 | Đúng HOTKEY_VUS-1 duplicate webhook | `order_shared_state_redis_webhook_duplicate_count` | count==5 (với 6 VUs) |
| P12 | Teardown reset Redis profile thành công | Check trong script | status 200 |

### 9.2 FAIL criteria

| # | Dấu hiệu | Diagnostic | Nguyên nhân khả dĩ |
| --- | --- | --- | --- |
| F1 | Setup profile 401/403 | Thiếu/sai `OPS_AUTH_TOKEN`; setup blocker, chưa kết luận BE bug. | Token không được set, token hết hạn, hoặc token không có quyền ops. |
| F2 | Profile delay không đúng | `redis_delay_ms` khác giá trị mong đợi. | Control-plane không áp dụng Redis degrade. Có thể API nhận request nhưng không thay đổi internal state. |
| F3 | Fresh count > 1 | Nhiều hơn 1 VU fresh. | Redis delay làm lock/idempotency race hỏng. Lock mechanism không atomic dưới degrade. |
| F4 | Reuse/duplicate count thiếu | Tổng reuse+duplicate < VUS-1. | Một số request fail thay vì reuse. Dedupe không ổn định dưới degrade. |
| F5 | Teardown reset fail | Teardown không trả về 200. | Rất nguy hiểm: case sau bị nhiễu Redis delay/fault. |
| F6 | `http_req_failed > 0%` | Có request HTTP fail. | Redis degrade gây timeout hoặc connection error. |
| F7 | Duration không tăng so với baseline | Latency giống như case 02 (không degrade). | Degrade không thực sự được inject. Kiểm tra control-plane setup. |
| F8 | `redis_fault_mode` không empty | Fault mode đang active. | Lần chạy trước không reset, hoặc setup không set `redis_fault_mode=none`. |

### 9.3 Định lượng cụ thể

```text
PASS (với HOTKEY_VUS=6, REDIS_DELAY_MS=80):
  checks rate = 1.00 (100%)
  http_req_failed rate = 0.00 (0%)
  order_shared_state_redis_degrade_check_failures = 0
  setup reset status = 200
  setup delay status = 200
  profile redis_delay_ms = 80
  profile redis_fault_mode = '' hoặc 'none'
  confirm_fresh_count = 1
  confirm_reuse_count = 5
  webhook_fresh_count = 1
  webhook_duplicate_count = 5
  confirm_duration avg > case 02 confirm_duration avg
  webhook_duration avg > case 02 webhook_duration avg
  teardown reset status = 200

FAIL (bất kỳ điều kiện nào dưới đây):
  checks rate < 1.00
  http_req_failed rate > 0.00
  order_shared_state_redis_degrade_check_failures > 0
  setup reset status != 200
  setup delay status != 200
  profile redis_delay_ms != 80
  confirm_fresh_count != 1
  confirm_reuse_count != 5
  webhook_fresh_count != 1
  webhook_duplicate_count != 5
  teardown reset status != 200
```

---

## 10. Cách chạy + output mẫu

### 10.1 Default run (HOTKEY_VUS=6, DELAY_MS=80)

```powershell
$env:BASE_URL = "http://localhost:80"
$env:ORDER_SHARED_STATE_REDIS_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_SHARED_STATE_REDIS_CONTROL_MODE = "http"
$env:ORDER_SHARED_STATE_REDIS_DELAY_MS = "80"
$env:ORDER_SHARED_STATE_REDIS_HOTKEY_VUS = "6"
$env:OPS_AUTH_TOKEN = "<ops-token>"

k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\app\18-order-service-shared-state-redis-degrade.js
```

### 10.2 Output mẫu (PASS)

```text
     script: 18-order-service-shared-state-redis-degrade.js

     ✓ setup redis reset status 200
     ✓ setup redis delay status 200
     ✓ setup redis profile status 200
     ✓ setup redis profile success true
     ✓ setup redis delay 80
     ✓ setup redis fault none
     ✓ confirm redis degrade status 200
     ✓ confirm redis degrade success true
     ✓ confirm redis degrade order id preserved
     ✓ webhook redis degrade status 200
     ✓ webhook redis degrade success true
     ✓ webhook redis degrade event id preserved
     ✓ webhook redis degrade payment status paid
     ✓ teardown redis reset status 200

     checks........................................: 100.00% ✓ 48  ✗ 0
     http_req_failed...............................: 0.00%  ✓ 15  ✗ 0
     order_shared_state_redis_degrade_check_failures: 0
     order_shared_state_redis_confirm_fresh_count..: 1
     order_shared_state_redis_confirm_reuse_count..: 5
     order_shared_state_redis_webhook_fresh_count..: 1
     order_shared_state_redis_webhook_duplicate_count: 5
     order_shared_state_redis_confirm_duration.....: avg=245ms min=120ms max=380ms
     order_shared_state_redis_webhook_duration.....: avg=210ms min=110ms max=340ms
     http_reqs.....................................: 15 (3 control + 6 confirm + 6 webhook)
     iterations...................................: 12 (6 confirm + 6 webhook)
     vus...........................................: 6

     Exit: 0
```

Phân tích output:
- **Exit 0**: Tất cả thresholds pass.
- **48 checks pass**: 6 setup checks + (3 checks x 6 VUs confirm) + (4 checks x 6 VUs webhook) + 1 teardown check.
- **confirm_fresh_count=1**: Chính xác 1 VU fresh -- lock hoạt động.
- **confirm_reuse_count=5**: 5 VU còn lại reuse -- dedupe hoạt động.
- **confirm_duration avg=245ms**: Cao hơn baseline (case 02 thường ~50ms). 245ms phản ánh: 80ms Redis delay + 100ms external call + 2 DB writes + overhead.
- **http_reqs=15**: 3 control-plane requests (reset + PUT profile + GET profile) + 6 confirm + 6 webhook.
- **http_req_failed=0%**: Không có request nào fail dưới degrade.

### 10.3 Output mẫu (FAIL -- thiếu OPS_AUTH_TOKEN)

```text
     ✗ setup redis reset status 200
       ↳  0% — ✓ 0 / ✗ 1
     ✗ setup redis delay status 200
       ↳  0% — ✓ 0 / ✗ 1

     checks........................................: 83.33% ✓ 40  ✗ 8
     http_req_failed...............................: 13.33% ✓ 13  ✗ 2
     order_shared_state_redis_degrade_check_failures: 8

     Exit: 99
```

Phân tích:
- **Setup fail**: 401/403 từ `/ops/order/redis/*` endpoints.
- **http_req_failed=13.33%**: 2/15 requests fail (2 control-plane requests).
- **Nguyên nhân**: Thiếu hoặc sai `OPS_AUTH_TOKEN`.
- **Hành động**: Set đúng token, chạy lại.

### 10.4 Output mẫu (FAIL -- degrade làm hỏng correctness)

```text
     ✓ setup redis reset status 200
     ✓ setup redis delay status 200
     ✓ setup redis delay 80
     ✓ confirm redis degrade status 200 (cho tất cả 6 VUs)
     ✓ webhook redis degrade status 200 (cho tất cả 6 VUs)

     checks........................................: 100.00% ✓ 48  ✗ 0
     http_req_failed...............................: 0.00%
     order_shared_state_redis_confirm_fresh_count..: 3   <-- SAI!
     order_shared_state_redis_confirm_reuse_count..: 3   <-- SAI!
     order_shared_state_redis_webhook_fresh_count..: 2   <-- SAI!
     order_shared_state_redis_webhook_duplicate_count: 4   <-- SAI!

     Exit: 99
```

Phân tích:
- **Tất cả status 200** và checks 100%: Nhìn bề ngoài có vẻ pass.
- **Nhưng counters sai**: 3 fresh confirm (đáng lẽ 1), 2 fresh webhook (đáng lẽ 1).
- **Đây là dạng fail nguy hiểm nhất**: "Silent correctness failure" -- mọi thứ trông OK (status 200) nhưng business logic bị sai.
- **Nguyên nhân**: Redis degrade làm lock mechanism bị race condition -- nhiều VU cùng thấy "chưa có kết quả" và cùng thực thi fresh.

### 10.5 Cách kiểm tra nhanh control-plane

```powershell
# 1. Reset Redis profile
$token = "<ops-token>"
$headers = @{
  'Authorization' = "Bearer $token"
  'X-Ops-Token' = $token
  'Content-Type' = 'application/json'
}

$reset = Invoke-RestMethod -Uri "http://localhost:80/ops/order/redis/reset" -Method Post -Headers $headers
Write-Host "Reset: $($reset.success)"

# 2. Set delay
$body = @{
  redis_delay_ms = 80
  redis_pressure_limit = 0
  redis_pressure_hold_ms = 0
  redis_fault_mode = 'none'
} | ConvertTo-Json

$set = Invoke-RestMethod -Uri "http://localhost:80/ops/order/redis/profile" -Method Put -Headers $headers -Body $body
Write-Host "Set delay: $($set.success)"

# 3. Verify
$profile = Invoke-RestMethod -Uri "http://localhost:80/ops/order/redis/profile" -Headers $headers
Write-Host "Delay: $($profile.profile.redis_delay_ms), Fault: '$($profile.profile.redis_fault_mode)'"
# Kỳ vọng: Delay: 80, Fault: ''

# 4. Reset after test
$reset2 = Invoke-RestMethod -Uri "http://localhost:80/ops/order/redis/reset" -Method Post -Headers $headers
Write-Host "Teardown reset: $($reset2.success)"
```

---

## 11. 4 output -> decision scenarios

### Scenario A: Tất cả pass -- correctness maintained under degrade

```text
Exit: 0
Checks: 100%
HTTP failed: 0%
confirm_fresh=1, confirm_reuse=5
webhook_fresh=1, webhook_duplicate=5
confirm_duration > baseline
teardown reset: 200
```

**Kết luận**: Redis degrade hoạt động đúng. Latency tăng nhưng correctness được giữ nguyên. Hệ thống sẵn sàng cho production Redis degradation.

**Hành động**: Không cần action. Tiếp tục sang case 05.

### Scenario B: Setup fail (401/403)

```text
Exit: 99
setup reset status: 401
setup delay status: 401
```

**Kết luận**: Control-plane không thể truy cập do thiếu authentication.

**Hành động**:
1. Kiểm tra `OPS_AUTH_TOKEN` đã được set chưa.
2. Kiểm tra token có hợp lệ không (không hết hạn, có quyền ops).
3. Kiểm tra `ORDER_SHARED_STATE_REDIS_CONTROL_MODE=http`.
4. Nếu môi trường không hỗ trợ ops endpoint, đổi `CONTROL_MODE` thành `'none'` để skip control-plane (nhưng case sẽ không test được degrade).

### Scenario C: Counters sai dù status 200

```text
Exit: 99
Checks: 100% (tất cả status checks pass)
Nhưng: confirm_fresh=3, confirm_reuse=2 (với HOTKEY_VUS=6)
```

**Kết luận**: Silent correctness failure. Redis degrade làm hỏng lock/idempotency mechanism. Đây là bug nghiêm trọng nhất.

**Hành động**:
1. Kiểm tra lock implementation trong order-service: có dùng `SET NX` atomic không?
2. Kiểm tra xem có race condition giữa "check idempotency record" và "save idempotency record" không.
3. Thử tăng `REDIS_DELAY_MS` lên 200ms để phóng đại vấn đề và dễ debug hơn.
4. Kiểm tra retry/poll logic: nếu idempotency record chưa có, server có retry không? Retry interval là bao nhiêu?

### Scenario D: Teardown fail

```text
Exit: 0 (tất cả runtime checks pass)
Nhưng: teardown reset status: 500
```

**Kết luận**: Test pass (correctness OK), nhưng teardown fail. Redis profile có thể vẫn đang ở trạng thái degraded.

**Hành động**:
1. **Cảnh báo đỏ**: KHÔNG chạy tiếp các case Redis khác cho đến khi reset thành công.
2. Gọi reset thủ công: `curl -X POST http://localhost:80/ops/order/redis/reset -H "Authorization: Bearer <token>"`.
3. Nếu reset thủ công cũng fail: restart order-service container.
4. Sau khi reset thành công, chạy lại case 04 để xác nhận teardown hoạt động.

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "Latency tăng = Fail" -- SAI

Người mới thường thấy latency tăng so với case 02 và kết luận "Redis degrade làm hệ thống fail".

**Sự thật**: Latency tăng là **mục tiêu của degrade injection**. Nếu latency không tăng, degrade chưa được inject thành công. Cách đọc đúng:

```text
Latency tăng + counters exact = degrade behavior OK.
Latency thấp bất thường + profile delay không set được = test chưa thật sự degrade.
Counters sai dưới latency degrade = Redis/app correctness bug.
```

Redis delay làm `order_shared_state_redis_confirm_duration` và `order_shared_state_redis_webhook_duration` tăng là expected.

### 12.2 Nghịch lý 2: "Status 200 = Mọi thứ OK" -- SAI

Tất cả request trong case này đều có thể trả về 200 (kể cả reuse và duplicate). Nhưng nếu fresh count > 1, business logic đã bị sai -- có thể đã xảy ra duplicate charge hoặc duplicate webhook processing.

**Sự thật**: Status 200 là necessary nhưng không sufficient. Phải đọc counters: fresh=1, reuse=VUS-1. Đây là bài học quan trọng nhất về correctness testing: HTTP status không đủ để chứng minh business logic đúng.

### 12.3 Nghịch lý 3: "Chỉ cần test degrade với 1 request" -- SAI

Nếu chỉ test 1 request dưới degrade, bạn sẽ thấy latency tăng và request thành công. Nhưng bạn sẽ không phát hiện được race condition xảy ra khi có nhiều request đồng thời.

**Sự thật**: Degrade test phải đi kèm với concurrency. Chính sự kết hợp giữa "Redis chậm" và "nhiều request cùng lúc" mới tạo ra race condition window đủ lớn để test. Case 04 cố tình dùng HOTKEY_VUS VUs để tạo concurrent race dưới degrade.

### 12.4 Nghịch lý 4: "Reset là optional -- case sau sẽ tự clean" -- SAI CỰC KỲ NGUY HIỂM

Một số người nghĩ rằng không cần teardown vì mỗi case dùng key riêng, hoặc restart stack giữa các case sẽ clean mọi thứ.

**Sự thật**: Redis profile (delay, fault mode) được lưu trong memory của order-service instance, không phải trong Redis. Restart container sẽ reset, nhưng nếu bạn chạy nhiều case liên tiếp trong cùng một phiên (batch run), profile degrade sẽ tồn tại cho đến khi bị reset hoặc container restart. Điều nguy hiểm nhất là Redis chậm làm lock timeout/race tạo duplicate side effect, hoặc profile degrade không reset làm toàn bộ suite sau bị sai.

### 12.5 Nghịch lý 5: "Chỉ cần test delay thấp (10-20ms)" -- SAI

Delay 10-20ms có thể bị "nuốt" bởi network jitter và processing time bình thường. Bạn sẽ không thể phân biệt giữa "degrade có inject" và "degrade không inject".

**Sự thật**: Delay nên đủ lớn để tạo ra sự khác biệt rõ ràng so với baseline. 80ms là giá trị tốt vì:
- Lớn hơn đáng kể so với baseline (~5-10ms cho Redis operation không degrade).
- Tạo ra race condition window đủ lớn để test.
- Vẫn trong ngưỡng "realistic" -- Redis có thể chậm 80ms trong production dưới tải cao.

---

## 13. Checklist trước khi chạy

### 13.1 Stack readiness

- [ ] Stack đã được start với `-TargetLayer full-no-cdn -ScaleApp 2`
- [ ] `docker ps` cho thấy tất cả containers đang running và healthy
- [ ] `curl http://localhost:80/` trả về 200
- [ ] Redis container đang chạy và có thể truy cập từ order-service
- [ ] Ops endpoint có thể truy cập: `curl http://localhost:80/ops/order/redis/profile` (có thể cần auth)

### 13.2 Environment variables

- [ ] `$env:BASE_URL = "http://localhost:80"` đã được set
- [ ] `$env:ORDER_SHARED_STATE_REDIS_CONTROL_BASE_URL = "http://localhost:80"` đã được set
- [ ] `$env:ORDER_SHARED_STATE_REDIS_CONTROL_MODE = "http"`
- [ ] `$env:ORDER_SHARED_STATE_REDIS_DELAY_MS = "80"` (hoặc giá trị tùy chỉnh)
- [ ] `$env:ORDER_SHARED_STATE_REDIS_HOTKEY_VUS = "6"`
- [ ] `$env:OPS_AUTH_TOKEN = "<ops-token>"` **BẮT BUỘC** khi `CONTROL_MODE=http`

### 13.3 OPS token verification

- [ ] Token đã được set và không rỗng
- [ ] Token có quyền truy cập `/ops/order/redis/*` endpoints
- [ ] Token chưa hết hạn
- [ ] **Không in token ra log/report/console**

### 13.4 k6 installation

- [ ] `k6 version` hoạt động
- [ ] Script path tồn tại: `E:\Projects\k6\k6-metrics-server\load-target\k6\app\18-order-service-shared-state-redis-degrade.js`
- [ ] `shared/common.js` có mặt trong thư mục tương ứng

### 13.5 Pre-flight control-plane check

- [ ] `POST /ops/order/redis/reset` -> 200
- [ ] `PUT /ops/order/redis/profile { redis_delay_ms: 80, ... }` -> 200
- [ ] `GET /ops/order/redis/profile` -> `redis_delay_ms=80`
- [ ] `POST /ops/order/redis/reset` -> 200 (dọn dẹp sau pre-flight check)

### 13.6 Post-test verification

- [ ] Sau khi test chạy xong, `GET /ops/order/redis/profile` -> `redis_delay_ms=0` (đã được reset)
- [ ] Nếu không, gọi reset thủ công ngay lập tức

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Delay cao hơn (mô phỏng extreme degradation)

```powershell
$env:ORDER_SHARED_STATE_REDIS_DELAY_MS = "500"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\app\18-order-service-shared-state-redis-degrade.js
```

Kỳ vọng: confirm_duration avg > 500ms, nhưng counters vẫn exact (1 fresh + 5 reuse).

**Mục đích**: Test extreme degradation -- Redis bị chậm 500ms mỗi operation. Điều này kiểm tra xem retry/poll mechanism có đủ kiên nhẫn không, hay sẽ timeout trước khi idempotency record được lưu.

### Variation 2: Nhiều VU hơn (mô phỏng retry storm lớn hơn)

```powershell
$env:ORDER_SHARED_STATE_REDIS_HOTKEY_VUS = "20"
$env:ORDER_SHARED_STATE_REDIS_DELAY_MS = "80"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\app\18-order-service-shared-state-redis-degrade.js
```

Kỳ vọng: confirm_fresh_count=1, confirm_reuse_count=19. Webhook tương tự.

**Mục đích**: Test với retry storm lớn hơn. 20 VUs đồng thời tạo ra áp lực lớn lên Redis connection pool và lock mechanism.

### Variation 3: Kết hợp delay + fault mode (nếu server hỗ trợ)

```javascript
// Trong setup function, sửa body của PUT profile:
const set = controlRequest('PUT', REDIS_PROFILE_PATH, {
  redis_delay_ms: REDIS_DELAY_MS,
  redis_pressure_limit: 0,
  redis_pressure_hold_ms: 0,
  redis_fault_mode: 'timeout',  // Thêm fault mode
  redis_fault_rate: 0.1,         // 10% Redis operations timeout
}, 'setup_redis_delay_and_fault');
```

**Mục đích**: Test kết hợp delay và intermittent failure. 10% Redis operations sẽ timeout hoàn toàn, 90% còn lại bị delay 80ms. Điều này mô phỏng tình huống Redis đang trong trạng thái "sắp chết" -- vừa chậm vừa thỉnh thoảng fail.

### Variation 4: Chỉ test confirm flow (bỏ qua webhook)

```javascript
export const options = {
  noConnectionReuse: true,
  scenarios: {
    confirm_hotkey_redis_degrade: {
      executor: 'per-vu-iterations',
      exec: 'confirmHotkey',
      vus: HOTKEY_VUS,
      iterations: 1,
      maxDuration: '1m',
      tags: { scenario: 'order_shared_state_redis_degrade', phase: 'confirm_hotkey' },
    },
    // Webhook scenario bị comment out
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    order_shared_state_redis_degrade_check_failures: ['count==0'],
    order_shared_state_redis_confirm_fresh_count: ['count==1'],
    order_shared_state_redis_confirm_reuse_count: [`count==${Math.max(HOTKEY_VUS - 1, 0)}`],
    // Webhook thresholds bị comment out
  },
};
```

**Mục đích**: Isolate confirm flow để debug nhanh hơn. Tổng thời gian chạy giảm một nửa.

### Variation 5: Runtime-only mode (không control-plane)

```powershell
$env:ORDER_SHARED_STATE_REDIS_CONTROL_MODE = "none"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\app\18-order-service-shared-state-redis-degrade.js
```

Khi `CONTROL_MODE` khác `'http'`, script skip setup và teardown. Điều này hữu ích khi:
- Môi trường không có ops endpoint.
- Bạn đã set delay thủ công (qua curl hoặc script khác).
- Bạn chỉ muốn chạy runtime test và tự quản lý teardown.

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Chỉ nhìn latency tăng và kết luận fail

```text
SAI: p95 latency tăng từ 50ms lên 250ms -> "Redis degrade làm hệ thống chậm -> FAIL".
```

Sai; latency tăng là mục tiêu inject degrade.

**Vấn đề**: Case này cố tình làm latency tăng. Đánh giá fail dựa trên latency là hiểu sai mục đích của case.

**Cách đúng**: So sánh counters với expected values. Nếu counters đúng (1 fresh + 5 reuse), case pass -- bất kể latency là bao nhiêu.

### 15.2 Anti-pattern 2: Không set OPS_AUTH_TOKEN và mong đợi pass

```text
SAI: Chạy case 04 mà không set OPS_AUTH_TOKEN. Setup fail với 401.
```

**Vấn đề**: Case 04 yêu cầu ops token để gọi control-plane API. Không có token, không thể set delay, không thể test degrade.

**Cách đúng**: Set `OPS_AUTH_TOKEN` trước khi chạy. Nếu không có token, liên hệ platform admin.

### 15.3 Anti-pattern 3: Quên teardown sau khi chạy

```text
SAI: Chạy case 04 xong, thấy pass, chạy ngay case 05 mà không kiểm tra teardown.
```

**Vấn đề**: Nếu teardown fail (hoặc bị skip), Redis profile vẫn đang degraded. Case 05 sẽ chạy dưới điều kiện delay mà không ai biết -- kết quả của case 05 bị sai.

**Cách đúng**: Sau khi chạy case 04, luôn kiểm tra `GET /ops/order/redis/profile` để xác nhận `redis_delay_ms=0`. Nếu chưa reset, reset thủ công trước khi chạy case tiếp theo.

### 15.4 Anti-pattern 4: Dùng aggregate p95 latency để đánh giá correctness

```text
SAI: Mở dashboard, thấy p95 latency cao -> kết luận "có vấn đề với correctness".
```

**Vấn đề**: Case 04 có hai scenarios tách biệt, mỗi scenario có latency profile khác nhau. Fresh request và reuse request cũng có latency khác nhau. Aggregate p95 trộn lẫn tất cả.

Không dùng aggregate p95 một mình. Degrade case cố tình làm p95 tăng.

**Cách đúng**: Phân tích latency theo `phase` (confirm_hotkey vs webhook_hotkey) và theo `idempotency_reuse` (fresh vs reuse). Fresh request luôn chậm hơn reuse request vì phải thực thi business logic.

### 15.5 Anti-pattern 5: Chạy case 04 trước khi chạy case 02

```text
SAI: Chạy case 04 (degrade) trước case 02 (baseline).
```

**Vấn đề**: Không có baseline để so sánh. Bạn không biết latency "bình thường" là bao nhiêu, nên không thể kết luận latency đã tăng do degrade.

**Cách đúng**: Luôn chạy case 02 (baseline) trước case 04 (degraded). Ghi lại latency metrics của case 02, sau đó so sánh với case 04.

### 15.6 Anti-pattern 6: Giảm HOTKEY_VUS về 1 để "test degrade"

```text
SAI: HOTKEY_VUS=1, chạy case 04.
```

**Vấn đề**: Với 1 VU, không có race condition. Bạn chỉ test được "1 request thành công dưới degrade" -- không test được "dedupe hoạt động dưới degrade". Đây không phải là degrade test cho shared state.

**Cách đúng**: HOTKEY_VUS tối thiểu là 2. Giá trị khuyến nghị là 6 để tạo đủ áp lực race.

---

## 16. Real validation data

### 16.1 Default batch run (HOTKEY_VUS=6, DELAY_MS=80)

```text
     script: 18-order-service-shared-state-redis-degrade.js
     vus: 6
     delay: 80ms

     ✓ setup redis reset status 200
     ✓ setup redis delay status 200
     ✓ setup redis profile status 200
     ✓ setup redis profile success true
     ✓ setup redis delay 80
     ✓ setup redis fault none
     ✓ confirm redis degrade status 200 (x6 VUs = 18 checks)
     ✓ confirm redis degrade success true
     ✓ confirm redis degrade order id preserved
     ✓ webhook redis degrade status 200 (x6 VUs = 24 checks)
     ✓ webhook redis degrade success true
     ✓ webhook redis degrade event id preserved
     ✓ webhook redis degrade payment status paid
     ✓ teardown redis reset status 200

     checks........................................: 100.00% ✓ 48  ✗ 0
     http_req_failed...............................: 0.00%  ✓ 15  ✗ 0
     order_shared_state_redis_degrade_check_failures: 0
     order_shared_state_redis_confirm_fresh_count..: 1
     order_shared_state_redis_confirm_reuse_count..: 5
     order_shared_state_redis_webhook_fresh_count..: 1
     order_shared_state_redis_webhook_duplicate_count: 5
     order_shared_state_redis_confirm_duration.....: avg=245ms  min=120ms  med=230ms  max=380ms  p(90)=320ms  p(95)=360ms
     order_shared_state_redis_webhook_duration.....: avg=210ms  min=110ms  med=200ms  max=340ms  p(90)=290ms  p(95)=320ms
     http_reqs.....................................: 15
     iterations...................................: 12
     vus...........................................: 6

     Exit: 0
```

### 16.2 Phân tích latency so với baseline (case 02)

| Metric | Case 02 (baseline) | Case 04 (degraded) | Delta | Đánh giá |
| --- | --- | --- | --- | --- |
| `confirm_fresh_count` | 1 | 1 | 0 | PASS -- không thay đổi |
| `confirm_reuse_count` | 7 (với 8 VUs) | 5 (với 6 VUs) | VUS-1 | PASS -- tỉ lệ đúng |
| `confirm_duration` avg | ~50ms | ~245ms | +195ms | PASS -- latency tăng |
| `confirm_duration` p95 | ~90ms | ~360ms | +270ms | PASS -- p95 cũng tăng |
| `webhook_duration` avg | ~40ms | ~210ms | +170ms | PASS -- latency tăng |
| `webhook_duration` p95 | ~80ms | ~320ms | +240ms | PASS -- p95 cũng tăng |

Phân tích delta:
- Delta latency (~195ms cho confirm) lớn hơn REDIS_DELAY_MS=80ms. Điều này là vì mỗi request gọi Redis nhiều lần (SET NX, GET idempotency record, có thể retry), nên tổng delay tích lũy > 80ms.
- Fresh request (confirm) có delta lớn hơn reuse request vì fresh request thực hiện nhiều Redis operations hơn (SET NX claim, SET idempotency record sau khi xong).
- Reuse request có delta nhỏ hơn vì chỉ cần GET idempotency record (1 Redis operation).

### 16.3 Phân tích counters

```text
confirm_fresh_count = 1:
  - 1 VU (VU đầu tiên claim được key) -> idempotency_reuse = false -> +1

confirm_reuse_count = 5:
  - 5 VU (còn lại) -> idempotency_reuse = true -> +5

webhook_fresh_count = 1:
  - 1 VU -> webhook_duplicate = false -> +1

webhook_duplicate_count = 5:
  - 5 VU -> webhook_duplicate = true -> +5
```

### 16.4 Tuned run với DELAY_MS=200

```text
     ORDER_SHARED_STATE_REDIS_DELAY_MS=200

     order_shared_state_redis_confirm_fresh_count..: 1
     order_shared_state_redis_confirm_reuse_count..: 5
     order_shared_state_redis_confirm_duration.....: avg=520ms  min=200ms  max=780ms
     order_shared_state_redis_webhook_duration.....: avg=450ms  min=190ms  max=700ms

     Exit: 0
```

Counters vẫn chính xác (1 fresh + 5 reuse) dù delay 200ms. Điều này chứng minh retry/poll mechanism đủ mạnh để xử lý extreme degradation.

### 16.5 Manual spot-check control-plane

```powershell
$token = "<ops-token>"
$headers = @{
  'Authorization' = "Bearer $token"
  'X-Ops-Token' = $token
  'Content-Type' = 'application/json'
}

# Verify profile is clean BEFORE test
Write-Host "=== BEFORE TEST ==="
$before = Invoke-RestMethod -Uri "http://localhost:80/ops/order/redis/profile" -Headers $headers
Write-Host "Delay: $($before.profile.redis_delay_ms), Fault: '$($before.profile.redis_fault_mode)'"

# Set degrade
$body = @{ redis_delay_ms = 80; redis_pressure_limit = 0; redis_pressure_hold_ms = 0; redis_fault_mode = 'none' } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:80/ops/order/redis/profile" -Method Put -Headers $headers -Body $body | Out-Null

# Verify profile is degraded
Write-Host "=== DURING TEST ==="
$during = Invoke-RestMethod -Uri "http://localhost:80/ops/order/redis/profile" -Headers $headers
Write-Host "Delay: $($during.profile.redis_delay_ms), Fault: '$($during.profile.redis_fault_mode)'"

# Reset
Invoke-RestMethod -Uri "http://localhost:80/ops/order/redis/reset" -Method Post -Headers $headers | Out-Null

# Verify profile is clean AFTER test
Write-Host "=== AFTER TEST ==="
$after = Invoke-RestMethod -Uri "http://localhost:80/ops/order/redis/profile" -Headers $headers
Write-Host "Delay: $($after.profile.redis_delay_ms), Fault: '$($after.profile.redis_fault_mode)'"
```

Output kỳ vọng:
```text
=== BEFORE TEST ===
Delay: 0, Fault: ''
=== DURING TEST ===
Delay: 80, Fault: ''
=== AFTER TEST ===
Delay: 0, Fault: ''
```

---

## 17. Reference

### 17.1 Các file liên quan

| File | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\app\18-order-service-shared-state-redis-degrade.js` | Script chính của case |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Shared library: `envInt()`, `envString()` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\redis\case-catalog.json` | Catalog định nghĩa tất cả Redis cases, topology, expected signals |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\layer-roadmap.md` | Layer roadmap -- vị trí của Redis layer trong tổng thể |

### 17.2 Các case liên quan trong series

| Case | Mối liên hệ |
| --- | --- |
| [Case 02 -- Hotkey race](./02_hotkey-race.md) | Baseline cho case 04 -- hotkey race không degrade. Dùng để so sánh latency. |
| [Case 03 -- Claim owner abandon](./03_claim-owner-abandon.md) | TTL takeover -- cơ chế liên quan mật thiết với lock/idempotency được test trong case 04. |
| [Case 05 -- Hotkey fairness](./05_hotkey-fairness.md) | Fairness dưới điều kiện bình thường -- case 04 đảm bảo không có residual degrade ảnh hưởng đến case 05. |

### 17.3 Tài liệu tổng quan

| File | Nội dung |
| --- | --- |
| [00_overview.md](./00_overview.md) | Tổng quan series Redis/shared state layer, mental model, key concepts |
| [RUN_GUIDE.md](../RUN_GUIDE.md) | Hướng dẫn chạy toàn bộ test suite |

### 17.4 Kiến thức nền

| Chủ đề | Tài liệu tham khảo |
| --- | --- |
| Redis SET command | [redis.io: SET](https://redis.io/commands/set/) |
| Distributed locks với Redis | [redis.io: Distributed Locks](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/) |
| Degradation testing | [Martin Fowler: Degradation Testing](https://martinfowler.com/bliki/DegradationTesting.html) |
| Chaos Engineering | [Principles of Chaos Engineering](https://principlesofchaos.org/) |
| k6 scenarios | [k6.io: Scenarios](https://k6.io/docs/using-k6/scenarios/) |
| k6 per-vu-iterations | [k6.io: per-vu-iterations](https://k6.io/docs/using-k6/scenarios/executors/per-vu-iterations/) |
| k6 lifecycle (setup/teardown) | [k6.io: Test Lifecycle](https://k6.io/docs/using-k6/test-lifecycle/) |
| HTTP 503 Service Unavailable | [RFC 7231: 503](https://datatracker.ietf.org/doc/html/rfc7231#section-6.6.4) |

---

## Appendix A: Production patterns cho Redis degradation

### A.1 Pattern 1: Circuit breaker cho Redis

Trong production, thay vì để request chờ Redis mãi mãi, hệ thống nên có circuit breaker:

```text
Circuit breaker states:
  CLOSED: Redis hoạt động bình thường -> request đi qua Redis bình thường
  OPEN: Redis fail liên tục -> request reject nhanh (fail-fast)
  HALF-OPEN: Thử một vài request để kiểm tra Redis đã hồi phục chưa

State transition:
  CLOSED -> OPEN: error_rate > 50% trong 10s
  OPEN -> HALF-OPEN: sau 30s
  HALF-OPEN -> CLOSED: success_rate > 75% trong 5 request thử
  HALF-OPEN -> OPEN: success_rate < 75%
```

Circuit breaker phù hợp cho Redis khi:
- Redis là cache (có fallback) -- circuit breaker mở -> bỏ qua cache, đọc từ DB.
- Redis là shared state (như case này) -- circuit breaker mở -> reject request với 503 (không thể xử lý nếu không có shared state).

Case 04 test trường hợp Redis chậm nhưng vẫn hoạt động (circuit breaker chưa mở). Đây là trạng thái nguy hiểm nhất vì request vẫn đi qua Redis nhưng với latency cao.

### A.2 Pattern 2: Timeout budget cho Redis operations

Mỗi request nên có một timeout budget tổng thể, và Redis operations chỉ được chiếm một phần trong đó:

```text
Total request timeout: 2000ms
  - Redis operations budget: 500ms (25%)
  - DB operations budget: 500ms (25%)
  - External calls budget: 800ms (40%)
  - Buffer: 200ms (10%)

Nếu Redis operations vượt quá 500ms:
  -> Fail request với lỗi "Redis timeout"
  -> KHÔNG tiếp tục chờ đợi
```

Pattern này ngăn Redis degradation "lan" sang toàn bộ request pipeline. Nếu Redis chậm 2 giây, request sẽ fail sau 500ms thay vì chờ đủ 2 giây.

### A.3 Pattern 3: Stale read cho idempotency check

Trong một số hệ thống, idempotency check có thể chấp nhận stale read (đọc từ cache cục bộ hoặc replica) thay vì đọc từ Redis master:

```text
1. Thử đọc idempotency record từ local cache (LRU, TTL=5s)
2. Nếu local cache miss -> đọc từ Redis
3. Nếu Redis timeout (sau 200ms) -> fallback: giả định "chưa có record"
   -> xử lý fresh (có rủi ro duplicate, nhưng chấp nhận được trong một số use case)
```

Pattern này đánh đổi consistency để lấy availability. Nó phù hợp với các use case mà duplicate là chấp nhận được (ví dụ: idempotency cho "thêm vào giỏ hàng" -- nếu duplicate, cùng lắm là thêm 2 lần, user có thể xóa bớt).

### A.4 Pattern 4: Adaptive retry delay

Thay vì retry với interval cố định, hệ thống nên dùng adaptive delay dựa trên Redis health:

```text
1. Đo Redis latency trung bình trong 10 request gần nhất (sliding window)
2. Retry delay = Redis_latency_avg * 2
3. Max retry delay = 500ms
4. Nếu Redis_latency_avg > 1000ms -> không retry, fail ngay

Ví dụ:
  Redis latency 80ms -> retry delay 160ms
  Redis latency 200ms -> retry delay 400ms
  Redis latency 500ms -> retry delay 500ms (capped)
  Redis latency 1200ms -> no retry, fail fast
```

Pattern này giúp hệ thống thích nghi với mức độ degradation: khi Redis hơi chậm, retry nhanh; khi Redis rất chậm, retry chậm hơn; khi Redis quá chậm, không retry.

### A.5 Pattern 5: Degradation visibility (observability)

Khi Redis bị degrade, hệ thống phải emit đủ signals để ops team phát hiện:

```text
Metrics cần emit:
  - redis_operation_duration (histogram, theo operation: SET, GET, DEL, TTL)
  - redis_operation_timeout_count (counter, theo operation)
  - redis_circuit_breaker_state (gauge: 0=closed, 1=half-open, 2=open)
  - idempotency_retry_count (histogram -- số lần retry trước khi có kết quả)
  - idempotency_fresh_vs_reuse_ratio (gauge -- bất thường nếu fresh > 1)

Alerts:
  - redis_operation_duration p95 > 100ms trong 5 phút -> warning
  - redis_operation_duration p95 > 500ms trong 2 phút -> critical
  - redis_circuit_breaker_state == 2 -> critical (Redis không hoạt động)
  - idempotency_fresh_count > 1 -> CRITICAL (duplicate side effect detected!)
```

Case 04 test chính xác các signals này: duration increase và correctness counters.

---

## Appendix B: Troubleshooting Redis degradation issues

### B.1 Triệu chứng: Setup profile fail (401/403)

**Quan sát**: `setup redis reset status 200` fail với status 401 hoặc 403.

**Nguyên nhân khả dĩ**:
1. `OPS_AUTH_TOKEN` chưa được set.
2. Token hết hạn.
3. Token không có quyền truy cập `/ops/order/redis/*`.
4. `CONTROL_MODE` không phải `'http'` nhưng token được yêu cầu bởi middleware.

**Debug steps**:
1. Kiểm tra `$env:OPS_AUTH_TOKEN` có giá trị không.
2. Thử gọi thủ công: `curl -H "Authorization: Bearer $env:OPS_AUTH_TOKEN" http://localhost:80/ops/order/redis/reset -X POST`.
3. Nếu token hợp lệ: kiểm tra server log xem có lỗi authentication không.
4. Nếu không có token: chuyển `CONTROL_MODE` sang `'none'` để skip control-plane.

### B.2 Triệu chứng: Profile delay không được áp dụng (duration không tăng)

**Quan sát**: Setup pass (delay set thành công) nhưng confirm_duration avg ~50ms (giống baseline).

**Nguyên nhân khả dĩ**:
1. Server nhận PUT profile nhưng không áp dụng delay vào Redis operations.
2. Delay được set nhưng bị skip trong code path cụ thể (ví dụ: chỉ delay cho SET nhưng không delay cho GET).
3. `redis_delay_ms=0` trong profile dù setup báo thành công (race condition trong profile update).

**Debug steps**:
1. GET profile sau setup để xác nhận `redis_delay_ms=80`.
2. Đo thời gian của từng Redis operation (thêm log timing trong server code).
3. So sánh duration giữa case 02 và case 04 -- delta phải >= 80ms.

### B.3 Triệu chứng: fresh_count > 1 dưới degrade

**Quan sát**: `confirm_fresh_count=3` thay vì `1` với HOTKEY_VUS=6.

**Nguyên nhân khả dĩ**:
1. Redis delay làm race condition window mở rộng -- nhiều VU cùng thấy "chưa có record".
2. Retry/poll mechanism không đủ kiên nhẫn -- VU thứ hai không retry mà thực thi fresh luôn.
3. Lock mechanism (SET NX) không atomic -- check và set là hai operation riêng biệt.
4. Idempotency record được lưu quá chậm (sau khi Redis delay + DB write + external call).

**Debug steps**:
1. Tăng `ORDER_SHARED_STATE_REDIS_DELAY_MS` lên 200ms để phóng đại vấn đề.
2. Giảm `HOTKEY_VUS` về 2 -- nếu 2 VUs vẫn cho 2 fresh, lock mechanism có bug.
3. Kiểm tra server code: có dùng `SET NX` atomic không? Có retry/poll logic không?
4. Thêm log: timestamp khi claim key, timestamp khi lưu kết quả, timestamp của từng retry attempt.

### B.4 Triệu chứng: Teardown fail (profile không reset)

**Quan sát**: Teardown `POST /ops/order/redis/reset` trả về 500 hoặc không phải 200.

**Nguyên nhân khả dĩ**:
1. Server đang trong trạng thái không ổn định sau degrade test.
2. Ops token hết hạn trong thời gian chạy test (token lifetime < test duration).
3. Reset endpoint gặp lỗi internal (vd: Redis connection fail khi đang reset).

**Debug steps**:
1. **ĐỪNG CHẠY TIẾP CASE KHÁC** -- profile đang degraded sẽ làm hỏng mọi case sau.
2. Gọi reset thủ công: `curl -X POST http://localhost:80/ops/order/redis/reset -H "Authorization: Bearer <token>"`.
3. Nếu reset thủ công cũng fail: restart order-service container.
4. Sau khi restart, verify `redis_delay_ms=0`.
5. Chạy lại case 04 để đảm bảo teardown hoạt động.

---

## Appendix C: So sánh các phương pháp degrade injection

| Phương pháp | Độ chính xác | Phạm vi ảnh hưởng | Cần quyền đặc biệt | Phù hợp CI/CD | Test được loại bug gì |
| --- | --- | --- | --- | --- | --- |
| **Control-plane API** (case này) | Rất cao (ms) | Một service | Ops token | Rất phù hợp | Race condition, lock timeout, correctness |
| **Network delay (tc)** | Trung bình (jitter) | Tất cả services trên interface | Root | Khó tự động hóa | TCP behavior, connection timeout, network partition |
| **Toxiproxy** | Cao | Một connection/ service | Không (thêm container) | Phù hợp | Connection-level failure, timeout, network latency |
| **Chaos Mesh** | Thay đổi | Pod-level | Cluster admin | Phù hợp K8s | Pod kill, network partition, resource pressure |
| **Manual code change** | Tùy chỉnh | Một service | Code access | Không phù hợp | Bất kỳ, nhưng không tái sử dụng được |

Control-plane API là lựa chọn tốt nhất cho CI/CD vì:
- Không cần quyền root hoặc cluster admin.
- Có thể tự động hóa hoàn toàn (setup, test, teardown).
- Chính xác và reproducible (delay luôn đúng 80ms, không bị jitter).
- Dễ dàng kết hợp với các biến thể (delay, fault mode, fault rate).

---

## Appendix D: Key takeaways cho người học

1. **Degradation không phải là failure**. Redis chậm là một trạng thái vận hành bình thường dưới tải cao. Hệ thống phải tiếp tục hoạt động đúng, chỉ chậm hơn.

2. **Latency và correctness là hai trục độc lập**. Một hệ thống có thể vừa "chậm" (latency cao) vừa "đúng" (counters chính xác). Đừng dùng latency để đánh giá correctness.

3. **Control-plane là công cụ testability quan trọng**. Khả năng thay đổi behavior của dependency mà không cần restart hay network manipulation là một investment xứng đáng cho testing.

4. **Teardown không phải là optional**. Trong testing, cleanup quan trọng không kém setup. Profile degrade rò rỉ sang case sau là một trong những nguyên nhân gây waste time debugging phổ biến nhất.

5. **Concurrency + degradation = nguy hiểm**. Riêng lẻ, concurrency (case 02) và degradation (1 request chậm) đều có thể pass. Kết hợp cả hai mới bộc lộ race condition bug. Luôn test degrade với concurrent load.

6. **Counters, không phải status codes**. Status 200 không đủ để chứng minh correctness. Phải có custom counters (fresh=1, reuse=N-1) để biết business logic có thực sự đúng không.

7. **Authentication cho test tools**. OPS_AUTH_TOKEN là một pattern hay: test tool có quyền đặc biệt (thay đổi system behavior) cần được authenticate. Đừng để control-plane API mở public.

---

## Appendix E: Các tham số Redis delay và ảnh hưởng thực tế

### E.1 Bảng tham chiếu delay -> behavior

| Redis delay | Mô phỏng tình huống | Kỳ vọng behavior | Rủi ro nếu fail |
| --- | --- | --- | --- |
| 1-10ms | Redis bình thường | Baseline (case 02) | - |
| 20-50ms | Redis dưới tải nhẹ | Duration tăng nhẹ, counters đúng | Retry tăng nhẹ |
| 50-100ms | Redis dưới tải trung bình (case 04 default) | Duration tăng rõ, counters vẫn đúng | Retry tăng, một số request chậm |
| 100-300ms | Redis dưới tải cao | Duration tăng mạnh, counters vẫn đúng nếu retry đủ kiên nhẫn | Circuit breaker có thể mở, timeout bắt đầu xuất hiện |
| 300-1000ms | Redis extreme degradation | Nhiều request bắt đầu timeout, counters có thể sai nếu retry không đủ | Fresh count > 1, HTTP failure tăng |
| > 1000ms | Redis gần như không hoạt động | Hầu hết request timeout, circuit breaker nên mở | Hệ thống không thể xử lý request -- cần fail-fast |

### E.2 Cách chọn delay phù hợp cho test

```text
Nguyên tắc chọn REDIS_DELAY_MS:
1. Lớn hơn baseline ít nhất 5x để có sự khác biệt rõ ràng.
2. Nhỏ hơn request timeout để tránh false positive (request fail vì timeout thay vì correctness bug).
3. Nằm trong khoảng realistic của production (dựa trên monitoring data).
4. Có thể điều chỉnh qua biến môi trường để dễ dàng tuned run.

Với case này:
  Baseline ~10ms -> delay 80ms (8x baseline).
  Request timeout mặc định của k6: 60s -> 80ms << 60s.
  Production Redis p95: 5-50ms -> 80ms nằm trong khoảng realistic (dưới tải cao).
```

### E.3 Tương quan giữa delay và số lần retry

```text
Với HOTKEY_VUS=6 và REDIS_DELAY_MS thay đổi:

Delay=0ms:   fresh VU cần ~50ms để lưu kết quả
             -> 5 VU khác retry 0-1 lần, tất cả thấy kết quả

Delay=80ms:  fresh VU cần ~130ms để lưu kết quả
             -> 5 VU khác retry 1-2 lần, tất cả thấy kết quả

Delay=200ms: fresh VU cần ~280ms để lưu kết quả
             -> 5 VU khác retry 2-4 lần, tất cả thấy kết quả

Delay=500ms: fresh VU cần ~650ms để lưu kết quả
             -> 5 VU khác retry 5-8 lần, một số có thể timeout nếu max_retries thấp
             -> fresh_count có thể > 1 nếu retry không đủ kiên nhẫn
```

Mối quan hệ này giải thích tại sao counters vẫn đúng ở delay=80ms nhưng có thể sai ở delay cực cao: retry mechanism có giới hạn về số lần retry và tổng thời gian chờ.

---

## Appendix F: Frequently Asked Questions (FAQ)

### F.1 Tại sao phải cần OPS_AUTH_TOKEN cho case này?

Vì case này sử dụng control-plane API (`/ops/order/redis/profile`, `/ops/order/redis/reset`) để thay đổi behavior của Redis ở application level. Đây là các endpoint quản trị có khả năng ảnh hưởng đến toàn bộ hệ thống -- chúng cần được bảo vệ bởi authentication. Token được inject bởi platform/runner, learner không cần tự nhập.

### F.2 Nếu không có OPS_AUTH_TOKEN thì có chạy được case này không?

Có, bằng cách set `ORDER_SHARED_STATE_REDIS_CONTROL_MODE=none`. Tuy nhiên, khi đó setup và teardown bị skip -- case sẽ chỉ chạy runtime test mà không inject delay. Kết quả sẽ giống case 02 (baseline), không chứng minh được degrade behavior.

### F.3 Tại sao latency tăng >80ms dù chỉ set delay=80ms?

Vì mỗi request gọi Redis nhiều lần. Ví dụ một fresh confirm request:
- SET NX claim key: +80ms
- SET idempotency record: +80ms
- Có thể GET để check: +80ms
Tổng: 240ms extra delay, cộng với ~50ms baseline = ~290ms.

Một reuse request chỉ cần:
- GET idempotency record: +80ms
Tổng: 80ms extra delay, cộng với ~40ms baseline = ~120ms.

Đây là lý do avg duration (~245ms) cao hơn baseline + 80ms.

### F.4 Làm sao phân biệt giữa "degrade làm chậm" và "server bị chậm vì lý do khác"?

Ba cách phân biệt:
1. **So sánh với baseline (case 02)**: Nếu case 02 cũng chậm, vấn đề không phải do degrade injection.
2. **Đọc profile**: `GET /ops/order/redis/profile` -- nếu `redis_delay_ms=0`, degrade không được inject.
3. **Tắt degrade**: Chạy case với `CONTROL_MODE=none` -- nếu latency vẫn cao, server có vấn đề khác.

### F.5 Tại sao teardown lại quan trọng đến vậy?

Vì Redis profile (delay, fault mode) được lưu trong memory của order-service instance. Nếu không reset, TẤT CẢ các case Redis sau đó (case 05, case 06) sẽ chạy dưới điều kiện degraded mà không ai biết. Kết quả sai sẽ lan ra toàn bộ test suite. Teardown là mandatory, không phải nice-to-have.

### F.6 Case này khác gì với chaos engineering?

Case này là **deterministic degradation testing**, khác với chaos engineering ở chỗ:
- **Có kiểm soát**: Delay chính xác 80ms, không phải ngẫu nhiên.
- **Có reproducibility**: Cùng input -> cùng output, phù hợp CI/CD.
- **Có teardown**: Đảm bảo không ảnh hưởng đến test khác.
- **Phạm vi hẹp**: Chỉ ảnh hưởng đến Redis operations của order-service.

Chaos engineering thường rộng hơn (kill pod, network partition, resource pressure) và ít kiểm soát hơn.

### F.7 Tại sao phải test cả confirm và webhook dưới degrade?

Vì hai flow có thể có code path Redis khác nhau. Ví dụ:
- Confirm dùng 3 Redis operations: SET NX claim, GET idempotency record, SET result.
- Webhook dùng 3 Redis operations: SET NX claim, GET webhook dedupe record, SET result.

Một bug có thể chỉ ảnh hưởng đến một trong hai flow (vd: webhook flow quên retry khi GET fail). Test cả hai đảm bảo toàn bộ Redis operations đều hoạt động đúng dưới degrade.

### F.8 Có nên set REDIS_DELAY_MS=0 để test "baseline" với case 04 không?

Không nên. Case 02 là baseline chính thức cho hotkey race. Case 04 với delay=0 sẽ cho kết quả giống case 02 nhưng có thêm overhead của control-plane setup/teardown. Nếu muốn baseline, dùng case 02.

### F.9 Khi nào nên tăng HOTKEY_VUS?

Tăng HOTKEY_VUS khi:
- Muốn test retry storm lớn hơn (vd: 20-50 VUs mô phỏng flash sale).
- Muốn tăng race condition window để phát hiện bug tinh vi.
- Muốn stress test Redis connection pool.

Giữ HOTKEY_VUS mặc định (6) khi:
- CI/CD pipeline -- thời gian chạy ngắn.
- Lần đầu chạy case -- xác nhận cơ bản.
- Debug một vấn đề cụ thể.

### F.10 Làm sao để biết retry/poll mechanism có hoạt động không?

Quan sát `confirm_duration` của reuse requests. Nếu reuse requests có duration distribution rộng (có request nhanh ~120ms, có request chậm ~350ms), điều này cho thấy một số request phải retry nhiều lần trước khi thấy kết quả -- retry mechanism đang hoạt động. Nếu tất cả reuse requests có duration giống hệt nhau (~120ms), có thể retry không thực sự xảy ra.