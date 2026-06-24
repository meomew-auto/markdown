# redis-01 -- Shared state across order-service instances

> **Case ID:** `redis-01-shared-state-distributed`
> **Script:** `../app/15-order-service-shared-state-distributed.js`
> **Layer:** Redis / Shared State
> **Proof:** Idempotency replay, webhook dedupe, và payment state nhất quán qua nhiều upstream instances khác nhau

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [Redis capability được chứng minh](#2-redis-capability-được-chứng-minh)
3. [Vì sao phải test ở Redis/shared state layer](#3-vì-sao-phải-test-ở-redisshared-state-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Redis mechanism deep-dive](#6-redis-mechanism-deep-dive)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / counters cần verify](#8-key-signals--counters-cần-verify)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output → decision scenarios](#11-4-output--decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist trước khi chạy](#13-checklist-trước-khi-chạy)
14. [4-5 Variations với code mẫu](#14-4-5-variations-với-code-mẫu)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh nghiệp vụ

Một user confirm order, payment provider gửi webhook, rồi UI/API đọc lại order status. Trong production, các request này có thể đi qua nhiều `order-service` instances khác nhau vì LB phân phối upstream.

```text
confirm order -> duplicate confirm retry -> payment webhook -> duplicate webhook -> stale webhook -> status read
```

Nếu state chỉ nằm trong memory từng instance, request đổi upstream sẽ làm idempotency replay hoặc webhook dedupe bị sai.

### 1.2 Ba thao tác nghiệp vụ cốt lõi

Hệ thống order-service xử lý ba thao tác chính trong vòng đời một đơn hàng. Mỗi thao tác đều có yêu cầu riêng về tính nhất quán của state:

**Thao tác A -- Order Confirm (POST + Idempotency-Key):**

```text
Người dùng nhấn nút "Đặt hàng" trên mobile app. Do network không ổn định,
app tự động retry request với cùng Idempotency-Key. Nếu không có cơ chế
idempotency, mỗi lần retry sẽ tạo ra một side effect mới: trừ kho 2 lần,
gửi email xác nhận 2 lần, tạo payment intent 2 lần.
```

Hậu quả nếu idempotency sai:

| Hậu quả | Ví dụ cụ thể | Mức độ ảnh hưởng |
| --- | --- | --- |
| Trừ kho nhiều lần | Một sản phẩm chỉ còn 1 tồn kho, retry 3 lần → tồn kho âm 2 | Mất kiểm soát inventory, bán quá số lượng |
| Tạo nhiều payment intent | User bị charge 3 lần cho 1 đơn hàng | Khiếu nại tài chính, hoàn tiền phức tạp |
| Gửi nhiều email xác nhận | User nhận 3 email "Đơn hàng đã xác nhận" | Trải nghiệm người dùng kém, mất uy tín |

**Thao tác B -- Payment Webhook (POST + event_id):**

```text
Payment provider (Stripe, VNPay, Momo) gửi webhook báo thanh toán thành công.
Payment provider cũng có retry policy: nếu không nhận được 200 trong 5 giây,
họ sẽ gửi lại webhook với cùng event_id. Nếu webhook dedupe không hoạt động,
order sẽ bị apply payment nhiều lần.
```

**Thao tác C -- Order Status Read (GET):**

```text
Sau khi confirm và webhook đã xử lý, UI/API cần đọc trạng thái hiện tại của
đơn hàng. Status read phải thấy được payment state mới nhất do webhook ghi,
không phải state cũ từ lúc confirm.
```

### 1.3 Vấn đề distributed state

Trong môi trường production, nhiều `order-service` instances chạy song song sau một Load Balancer:

```text
Request 1 (confirm):   client -> LB -> order-service-instance-1 (state trong memory của instance 1)
Request 2 (retry):     client -> LB -> order-service-instance-3 (KHÔNG thấy state của instance 1)
Request 3 (webhook):   provider -> LB -> order-service-instance-2 (KHÔNG thấy state của instance 1 và 3)
Request 4 (status):    client -> LB -> order-service-instance-1 (có thấy state từ request 3 không?)
```

Nếu mỗi instance lưu state trong memory riêng:

- Request 2 (retry) đến instance 3 → instance 3 không biết instance 1 đã xử lý confirm → tạo duplicate side effect
- Request 3 (webhook) đến instance 2 → instance 2 không thấy state confirm → có thể xử lý sai
- Request 4 (status) đến instance 1 → instance 1 có thể có state cũ, không thấy webhook update

**Giải pháp:** State phải được lưu trong Redis/shared store -- nơi tất cả instances cùng đọc/ghi. Dù request đi qua instance nào, state vẫn nhất quán.

---

## 2. Redis capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh Redis/shared state là centralized:

- cùng `Idempotency-Key` replay kết quả confirm đầu tiên;
- cùng webhook `event_id` chỉ apply một lần;
- stale payment event không ghi đè trạng thái mới hơn;
- status read thấy payment state do webhook ghi;
- retry qua upstream khác vẫn giữ state đúng.

### 2.2 Phân tích từng capability

| # | Capability | Cách chứng minh | Tại sao cần Redis |
| --- | --- | --- | --- |
| 1 | Idempotency replay | Gửi 2 request confirm với cùng `Idempotency-Key`. Request đầu có `idempotency_reuse=false`, request sau có `idempotency_reuse=true`. | Redis lưu mapping `key -> kết quả`. Request sau lookup Redis thay vì thực thi lại. |
| 2 | Webhook dedupe | Gửi 2 webhook với cùng `event_id`. Request đầu có `webhook_duplicate=false`, request sau có `webhook_duplicate=true`. | Redis lưu set các `event_id` đã xử lý. Request sau thấy `event_id` đã tồn tại → dedupe. |
| 3 | Payment state regression protection | Gửi stale `payment.failed` event sau khi đã có `payment.captured`. State vẫn là `paid`, không bị ghi đè. | Redis lưu timestamp của payment state hiện tại. Stale event có timestamp cũ hơn → bị ignore. |
| 4 | Cross-instance state consistency | Dùng `findDistinctUpstream` để đảm bảo retry đi qua upstream khác nhau. State vẫn đúng. | State không nằm ở memory instance nào cả -- nằm ở Redis. |
| 5 | Status read consistency | GET order status sau tất cả các bước. Thấy `payment_status=paid`, `payment_state_source=webhook`. | Status read lookup Redis cho payment state, không đọc từ memory instance. |

### 2.3 Bảng so sánh: memory instance vs Redis shared state

| Khía cạnh | Memory instance (sai) | Redis shared state (đúng) |
| --- | --- | --- |
| Idempotency scope | Chỉ trong 1 instance | Toàn bộ cluster |
| Retry qua instance khác | Tạo duplicate side effect | Trả về kết quả cũ (replay) |
| Webhook dedupe scope | Chỉ trong 1 instance | Toàn bộ cluster |
| Stale event protection | Không có hoặc không nhất quán | Dựa trên timestamp trong Redis |
| Status read | Có thể đọc state cũ/không đầy đủ | Luôn đọc state mới nhất từ Redis |
| Instance crash | Mất toàn bộ state đang xử lý | State vẫn tồn tại trong Redis |

---

## 3. Vì sao phải test ở Redis/shared state layer

### 3.1 Redis là điểm tập trung state cho toàn bộ cluster

```text
client/k6 -> http://localhost:80 -> Nginx LB/Gateway -> app/order-service -> Redis -> Postgres/external simulation
```

Sau khi CDN đã cache đúng và LB đã route đúng, câu hỏi tiếp theo là: **state dùng chung có nhất quán không?** Đây là câu hỏi mà chỉ Redis/shared state layer mới trả lời được.

### 3.2 Không thể test distributed state ở tầng app đơn lẻ

Nếu chỉ test API bằng cách gọi thẳng một instance:

```text
Test sai:  curl http://localhost:8081/api/sim/orders/ORD-1/confirm  (đi thẳng 1 instance, không qua LB)
Test đúng: curl http://localhost:80/api/sim/orders/ORD-1/confirm      (đi qua LB → có thể đến instance bất kỳ)
```

Chỉ request qua `:80` mới đi qua LB và mới có khả năng đến các instance khác nhau. Hơn nữa, `X-Upstream-Addr` header cho biết request đã đến instance nào -- bằng chứng cho việc state distributed.

### 3.3 Không phải CDN, không phải LB

| Layer | Test cái gì | Không test cái gì |
| --- | --- | --- |
| CDN/Varnish | Cache hit/miss, stale content, invalidation | State consistency giữa các app instances |
| LB/Gateway | Routing, sticky sessions, failover | Idempotency, webhook dedupe, payment state |
| **Redis/Shared State** | **Idempotency, dedupe, state consistency, regression protection** | **Cache hit/miss, routing correctness** |

Mỗi layer có trách nhiệm riêng. Một hệ thống có thể CDN đúng, LB đúng nhưng vẫn sai idempotency nếu state không được shared qua Redis.

### 3.4 Hệ quả nếu bỏ qua test ở layer này

```text
Tình huống thực tế:
  1. CDN test pass: cache hit đúng, invalidation đúng
  2. LB test pass: routing đúng, health check đúng
  3. KHÔNG test Redis layer
  4. Triển khai production
  5. Ngày thứ 2: một user nhấn "Đặt hàng" 3 lần (do app lag)
     → 3 order được tạo thay vì 1
     → Kho bị trừ 3 lần
     → User bị charge 3 lần
  6. Incident P0
```

Đây không phải là tình huống giả định. Nhiều incident production liên quan đến idempotency và dedupe bắt nguồn từ việc bỏ qua test ở shared state layer.

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌──────────────────────────────┐
                          │     k6 test script            │
                          │  (15-order-service-shared-    │
                          │   state-distributed.js)       │
                          └──────────┬───────────────────┘
                                     │
                                     │ HTTP (qua LB :80)
                                     ▼
┌────────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx LB/Gateway)                               │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  Upstream: order-service                              │     │
│  │  - instance 1 (172.20.0.x:8081)                       │     │
│  │  - instance 2 (172.20.0.x:8081)                       │     │
│  │  - instance N                                         │     │
│  └──────────┬───────────────────────────────────────────┘     │
│             │ forward                                          │
│             ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  order-service instances (N instances)                │     │
│  │  ┌──────────┐  ┌──────────┐       ┌──────────┐       │     │
│  │  │ instance │  │ instance │  ...  │ instance │       │     │
│  │  │    1     │  │    2     │       │    N     │       │     │
│  │  └────┬─────┘  └────┬─────┘       └────┬─────┘       │     │
│  │       │             │                  │              │     │
│  │       └─────────────┼──────────────────┘              │     │
│  │                     │                                  │     │
│  │                     ▼                                  │     │
│  │  ┌──────────────────────────────────────────┐        │     │
│  │  │  Redis (shared state store)               │        │     │
│  │  │  - Idempotency key → result mapping       │        │     │
│  │  │  - Webhook event_id → processed set       │        │     │
│  │  │  - Payment state (status, timestamp, src) │        │     │
│  │  └──────────────────────────────────────────┘        │     │
│  │                     │                                  │     │
│  │                     ▼                                  │     │
│  │  ┌──────────────────────────────────────────┐        │     │
│  │  │  Postgres / external simulation           │        │     │
│  │  └──────────────────────────────────────────┘        │     │
│  └──────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `full-no-cdn` (bắt buộc) | `docker ps` thấy order-service và Redis containers |
| `BASE_URL` | `http://localhost:80` | `curl http://localhost:80/health` |
| Số lượng order-service instances | Tối thiểu 2 (để chứng minh distributed) | Set `ORDER_SHARED_STATE_EXPECTED_INSTANCES=2` hoặc hơn |
| `ORDER_SHARED_STATE_REQUIRE_DISTINCT_UPSTREAM` | `true` để bắt buộc chứng minh distributed | Nếu `false`, script sẽ skip qua bước verify distinct upstream |
| Redis | Phải đang chạy và kết nối được từ order-service | Không cần kiểm tra trực tiếp; nếu Redis chết, script sẽ fail |

### 4.3 Stack khởi động

```powershell
# Khởi động full-no-cdn stack (không có Varnish/CDN)
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 3
```

Đợi tất cả service healthy (khoảng 30-60 giây). Kiểm tra:

```powershell
# Xác nhận order-service instances đang chạy
docker ps --filter "name=order-service"

# Xác nhận Redis đang chạy
docker ps --filter "name=redis"

# Xác nhận public path hoạt động
curl http://localhost:80/health
```

### 4.4 Precondition của script

Script KHÔNG có `setup()` function -- mỗi lần chạy tạo một order ID mới dựa trên timestamp:

```javascript
const base = `${Date.now()}-${__VU}-${__ITER}`;
const orderId = `${ORDER_ID_PREFIX}-${base}`;
const confirmKey = `idem-${base}`;
const capturedEventId = `evt-${base}-captured`;
```

Điều này có nghĩa: **không cần precondition thủ công**. Mỗi lần chạy là một test hoàn toàn mới với order ID mới, idempotency key mới, event ID mới. State trong Redis cho các key này chưa từng tồn tại trước đó.

Tuy nhiên, cần lưu ý: nếu Redis đã có quá nhiều key từ các lần chạy trước, memory có thể bị ảnh hưởng. Redis TTL sẽ tự động dọn dẹp.

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\app\15-order-service-shared-state-distributed.js
```

### 5.2 Script và executor

```text
Script: ../app/15-order-service-shared-state-distributed.js
Executor: per-vu-iterations implicit via options vus=1, iterations=1
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

Đây là deterministic sequence, không phải load test. Một VU đủ vì case cần kiểm chuỗi phụ thuộc state.

### 5.3 Import và dependency

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { envFloat, envInt, envString } from '../shared/common.js';
```

Script sử dụng các built-in module của k6 (`http`, `check`, `sleep`, `Counter`, `Trend`) và shared helper `common.js` để đọc biến môi trường với type safety.

### 5.4 Custom metrics

Script định nghĩa các custom metrics để đo lường chính xác từng giai đoạn:

```javascript
// Trend metrics -- đo latency cho từng stage
const confirmFirstDuration = new Trend('order_service_shared_state_confirm_first_duration', true);
const confirmDuplicateDuration = new Trend('order_service_shared_state_confirm_duplicate_duration', true);
const webhookAppliedDuration = new Trend('order_service_shared_state_webhook_applied_duration', true);
const webhookDuplicateDuration = new Trend('order_service_shared_state_webhook_duplicate_duration', true);
const webhookStaleDuration = new Trend('order_service_shared_state_webhook_stale_duration', true);
const statusDuration = new Trend('order_service_shared_state_status_duration', true);
const distinctUpstreamAttempts = new Trend('order_service_shared_state_distinct_upstream_attempts', true);

// Counter metrics -- đếm số lần các sự kiện quan trọng
const distributedCheckFailures = new Counter('order_service_shared_state_distributed_check_failures');
const distinctUpstreamObserved = new Counter('order_service_shared_state_distinct_upstream_observed');
const distinctUpstreamSkipped = new Counter('order_service_shared_state_distinct_upstream_skipped');
const distinctUpstreamMissing = new Counter('order_service_shared_state_distinct_upstream_required_missing');
```

**Phân tích ý nghĩa từng metric:**

| Metric | Loại | Ý nghĩa |
| --- | --- | --- |
| `confirm_first_duration` | Trend | Thời gian xử lý confirm đầu tiên (fresh path -- có external + DB work) |
| `confirm_duplicate_duration` | Trend | Thời gian xử lý confirm duplicate (replay path -- không có external/DB work) |
| `webhook_applied_duration` | Trend | Thời gian xử lý webhook đầu tiên (fresh path) |
| `webhook_duplicate_duration` | Trend | Thời gian xử lý webhook duplicate (dedupe path) |
| `webhook_stale_duration` | Trend | Thời gian xử lý stale webhook (regression check path) |
| `status_duration` | Trend | Thời gian đọc order status |
| `distinct_upstream_attempts` | Trend | Số lần retry để tìm thấy upstream khác |
| `distributed_check_failures` | Counter | Tổng số check failures -- threshold bắt buộc `count==0` |
| `distinct_upstream_observed` | Counter | Số lần phát hiện được upstream khác (evidence distributed) |
| `distinct_upstream_skipped` | Counter | Số lần bỏ qua distinct upstream check (khi `REQUIRE_DISTINCT_UPSTREAM=false`) |
| `distinct_upstream_required_missing` | Counter | Số lần yêu cầu distinct upstream nhưng không tìm thấy |

### 5.5 Cấu hình biến môi trường

Script hỗ trợ nhiều biến môi trường để tùy chỉnh hành vi:

```javascript
const BASE_URL = envString('BASE_URL', 'http://localhost:80');
const ORDER_ID_PREFIX = envString('ORDER_SHARED_STATE_DISTRIBUTED_ORDER_PREFIX', 'ORD-SHARED-DIST');
const CONFIRM_CPU_MS = envInt('ORDER_SHARED_STATE_DISTRIBUTED_CONFIRM_CPU_MS', 20);
const CONFIRM_DB_WRITES = envInt('ORDER_SHARED_STATE_DISTRIBUTED_CONFIRM_DB_WRITES', 6);
const CONFIRM_EXTERNAL_MS = envInt('ORDER_SHARED_STATE_DISTRIBUTED_CONFIRM_EXTERNAL_MS', 240);
const WEBHOOK_CPU_MS = envInt('ORDER_SHARED_STATE_DISTRIBUTED_WEBHOOK_CPU_MS', 10);
const WEBHOOK_DB_WRITES = envInt('ORDER_SHARED_STATE_DISTRIBUTED_WEBHOOK_DB_WRITES', 3);
const STATUS_CPU_MS = envInt('ORDER_SHARED_STATE_DISTRIBUTED_STATUS_CPU_MS', 5);
const STATUS_DB_ROWS = envInt('ORDER_SHARED_STATE_DISTRIBUTED_STATUS_DB_ROWS', 5);
const MAX_UPSTREAM_ATTEMPTS = envInt('ORDER_SHARED_STATE_DISTRIBUTED_MAX_UPSTREAM_ATTEMPTS', 10);
const RETRY_SLEEP_SECONDS = envFloat('ORDER_SHARED_STATE_DISTRIBUTED_RETRY_SLEEP_SECONDS', 0.1);
const EXPECTED_INSTANCES = envInt('ORDER_SHARED_STATE_EXPECTED_INSTANCES', 1);
const REQUIRE_DISTINCT_UPSTREAM = envBool('ORDER_SHARED_STATE_REQUIRE_DISTINCT_UPSTREAM', EXPECTED_INSTANCES >= 2);
```

| Biến | Mặc định | Vai trò |
| --- | --- | --- |
| `CONFIRM_EXTERNAL_MS` | 240 | Simulate external delay (gọi payment provider). Fresh path phải có delay này. |
| `CONFIRM_DB_WRITES` | 6 | Số DB write operations. Fresh path phải có `db_write_ms` present. |
| `MAX_UPSTREAM_ATTEMPTS` | 10 | Số lần retry tối đa để tìm upstream khác. Mỗi lần cách nhau `RETRY_SLEEP_SECONDS`. |
| `REQUIRE_DISTINCT_UPSTREAM` | `true` nếu `EXPECTED_INSTANCES >= 2` | Nếu `true`, script bắt buộc tìm thấy ít nhất 2 upstream khác nhau. |
| `OPS_AUTH_TOKEN` | `''` | Token cho control plane (không bắt buộc với case này). |

### 5.6 options block

```javascript
export const options = {
  vus: 1,
  iterations: 1,
  noConnectionReuse: true,
  thresholds: {
    checks: ['rate==1'],
    order_service_shared_state_distributed_check_failures: ['count==0'],
  },
  tags: {
    scenario: 'order_service_shared_state_distributed',
    target_service: 'order-service',
    target_flow: 'shared_state_distributed',
  },
};
```

**Tại sao `vus: 1` và `iterations: 1`?**

Đây là **deterministic sequence proof**, không phải load test. Mỗi bước trong test phụ thuộc vào kết quả của bước trước:

```text
confirm first -> confirm duplicate -> webhook first -> webhook duplicate ->
stale webhook -> status read
```

Nếu có nhiều VU chạy song song, trình tự bị phá vỡ và không thể quy kết nguyên nhân thất bại. Một VU đủ vì case cần kiểm chuỗi phụ thuộc state.

**`noConnectionReuse: true`**: Quan trọng cho case distributed. Nếu k6 reuse connection, tất cả request có thể đi qua cùng một upstream instance (do HTTP keep-alive). `noConnectionReuse: true` buộc mỗi request tạo connection mới, tăng khả năng được LB phân phối đến instance khác nhau.

##### Phân tích executor: vì sao dùng `per-vu-iterations` cho case này?

Config dùng bare form `vus=1, iterations=1` → k6 tự động chọn `per-vu-iterations`. Đây là pattern chuẩn cho Redis/shared state correctness proof.

**Yêu cầu của case:**

```text
1. Sequential proof chain: confirm → retry → webhook → duplicate webhook → stale → status
   → Mỗi bước PHỤ THUỘC kết quả bước trước
   → Nếu 2+ VU: VU A confirm, VU B webhook trước khi confirm xong → race

2. 1 VU, 1 iteration: toàn bộ 6 bước trong 1 lần default()
   → Số request deterministic, không phụ thuộc response time
   → Mỗi step có thể retry đến MAX_UPSTREAM_ATTEMPTS lần để tìm distinct upstream
```

**So sánh executor:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **per-vu-iterations** (đang dùng) | ✅ **ĐÚNG** | 1 VU x 1 iter. Sequence tuần tự chuẩn xác. Correctness proof, không phải load test. |
| shared-iterations | ⚠️ Kết quả giống | Với `vus=1`, output giống hệt. Nhưng semantic khác: shared ngụ ý "kho chung nhiều worker". |
| constant-vus | ❌ SAI | Cần `duration`. Case này KHÔNG biết trước thời gian -- có thể retry đến 10 lần x 0.1s sleep. |
| constant-arrival-rate | ❌ SAI | Ép rate. Không cần -- mỗi bước phải đợi bước trước. |
| ramping-vus | ❌ SAI | Cần stage. 1 VU ổn định, không ramp. |

### 5.7 Hàm `findDistinctUpstream()` -- cốt lõi của distributed proof

Đây là hàm quan trọng nhất trong script, chịu trách nhiệm chứng minh state thực sự distributed:

```javascript
function findDistinctUpstream(label, referenceUpstream, requestFactory, assertFn) {
  let latest = null;
  let attemptsUsed = 0;
  let observedDistinct = false;
  const referenceIdentity = referenceUpstream || '';

  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    latest = requestFactory(attempt);
    attemptsUsed = attempt;
    assertFn(latest, attempt);

    const latestIdentity = upstreamIdentity(latest);
    if (referenceIdentity && latestIdentity && latestIdentity !== referenceIdentity) {
      observedDistinct = true;
      break;
    }

    if (attempt < MAX_UPSTREAM_ATTEMPTS && RETRY_SLEEP_SECONDS > 0) {
      sleep(RETRY_SLEEP_SECONDS);
    }
  }
  // ... ghi nhận metrics
}
```

**Cách hoạt động:**

1. Nhận `referenceUpstream` -- upstream identity của request trước đó
2. Gửi request qua `requestFactory`, kiểm tra kết quả qua `assertFn`
3. So sánh upstream identity của request mới với reference
4. Nếu khác → `observedDistinct = true` → dừng retry → chứng minh distributed
5. Nếu giống → retry với sleep `RETRY_SLEEP_SECONDS` giữa các lần
6. Sau `MAX_UPSTREAM_ATTEMPTS` lần, nếu vẫn không thấy upstream khác:
   - Nếu `REQUIRE_DISTINCT_UPSTREAM=true` → fail check
   - Nếu `REQUIRE_DISTINCT_UPSTREAM=false` → skip (warning)

### 5.8 Các hàm helper chính

Script định nghĩa các hàm helper được tổ chức rõ ràng:

| Hàm | Vai trò |
| --- | --- |
| `requestHeaders(requestId, extraHeaders)` | Tạo HTTP headers chuẩn cho mọi request, bao gồm `X-Test-Suite`, `X-Request-Id`, và auth token nếu có |
| `safeJson(response)` | Parse JSON an toàn -- trả về `null` nếu parse fail thay vì throw |
| `normalizeHeaderValue(value)` | Chuẩn hóa header value (xử lý array, null, undefined, CSV) |
| `getHeader(response, name)` | Lấy header từ response (case-insensitive) |
| `responseEnvelope(response)` | Đóng gói response + parsed JSON + các header quan trọng |
| `upstreamIdentity(result)` | Trả về upstream identity (instance hoặc address) |
| `postConfirm(orderId, idempotencyKey, stage)` | Gửi POST confirm với Idempotency-Key |
| `postWebhook(eventType, eventId, orderId, stage)` | Gửi POST webhook với event_id |
| `getOrderStatus(orderId, stage)` | Gửi GET order status |
| `assertUpstream(result, label)` | Assert upstream service và address |
| `assertConfirm(result, label, ...)` | Assert kết quả confirm (status, success, idempotency_reuse, v.v.) |
| `assertWebhook(result, label, ...)` | Assert kết quả webhook (status, success, webhook_duplicate, v.v.) |
| `assertStatus(result, label, ...)` | Assert kết quả status read (payment_status, source, v.v.) |
| `recordCheckFailure(label)` | Ghi nhận 1 check failure vào counter |

### 5.9 `default()` -- logic chính

Hàm `default()` thực thi 6 bước tuần tự:

#### Bước 1: Confirm đầu tiên (fresh)

```javascript
const firstConfirm = postConfirm(orderId, confirmKey, 'confirm_first');
const firstConfirmBreakdown = assertConfirm(firstConfirm, 'confirm first', orderId, confirmKey, false);
confirmFirstDuration.add(firstConfirm.response.timings.duration, { stage: 'confirm_first' });

// Verify fresh path có external work và DB write
check(firstConfirm, {
  [`confirm first breakdown external_ms >= ${CONFIRM_EXTERNAL_MS}`]: ...,
  'confirm first breakdown db_write_ms present': ...,
});
```

Expected:
- `idempotency_reuse = false` (đây là lần đầu tiên)
- `external_ms >= CONFIRM_EXTERNAL_MS` (có external delay)
- `db_write_ms` present (có DB write)
- `confirmed_at` present (có timestamp xác nhận)

#### Bước 2: Confirm duplicate (idempotency replay)

```javascript
const duplicateConfirm = findDistinctUpstream(
  'confirm duplicate',
  upstreamIdentity(firstConfirm),
  (attempt) => postConfirm(orderId, confirmKey, `confirm_duplicate_${attempt}`),
  (result) => {
    const duplicateBreakdown = assertConfirm(result, 'confirm duplicate', orderId, confirmKey, true);
    check({...}, {
      'confirm duplicate confirmed_at reused': ...,
      'confirm duplicate breakdown external_ms cleared': () => Number(duplicateBreakdown.external_ms || 0) === 0,
      'confirm duplicate breakdown db_write_ms cleared': () => Number(duplicateBreakdown.db_write_ms || 0) === 0,
    });
  },
);
```

Expected:
- `idempotency_reuse = true` ( replay kết quả cũ)
- `confirmed_at` giống hệt lần đầu
- `external_ms = 0` (không làm lại external work)
- `db_write_ms = 0` (không làm lại DB write)
- Upstream có thể khác với lần đầu (distributed proof)

#### Bước 3: Webhook đầu tiên (fresh)

```javascript
const captured = postWebhook(CAPTURE_EVENT_TYPE, capturedEventId, orderId, 'webhook_captured_first');
const capturedBreakdown = assertWebhook(captured, 'webhook captured first', CAPTURE_EVENT_TYPE, capturedEventId, orderId, false);
webhookAppliedDuration.add(captured.response.timings.duration, { stage: 'webhook_captured_first' });

check(captured, {
  'webhook captured first payment_status paid': ...,
  'webhook captured first payment_regression_ignored false': ...,
  'webhook captured first payment_state_reused false': ...,
  'webhook captured first payment_state_updated_at present': ...,
  'webhook captured first breakdown db_write_ms present': ...,
});
```

Expected:
- `webhook_duplicate = false` (lần đầu tiên)
- `payment_status = 'paid'` (webhook đã cập nhật trạng thái)
- `payment_regression_ignored = false` (không phải regression case)
- `payment_state_reused = false` (state mới được tạo)
- `payment_state_updated_at` present
- `db_write_ms` present

#### Bước 4: Webhook duplicate (dedupe)

```javascript
const duplicateCaptured = findDistinctUpstream(
  'webhook duplicate',
  upstreamIdentity(captured),
  (attempt) => postWebhook(CAPTURE_EVENT_TYPE, capturedEventId, orderId, `webhook_duplicate_${attempt}`),
  (result) => {
    const duplicateBreakdown = assertWebhook(result, 'webhook duplicate', CAPTURE_EVENT_TYPE, capturedEventId, orderId, true);
    check({...}, {
      'webhook duplicate processed_at reused': ...,
      'webhook duplicate payment_status paid': ...,
      'webhook duplicate breakdown db_write_ms cleared': () => Number(duplicateBreakdown.db_write_ms || 0) === 0,
    });
  },
);
```

Expected:
- `webhook_duplicate = true` (event_id đã tồn tại)
- `processed_at` giống hệt lần đầu
- `payment_status` vẫn là `paid`
- `db_write_ms = 0` (không write lại DB)

#### Bước 5: Stale webhook (regression protection)

```javascript
const stale = findDistinctUpstream(
  'webhook stale',
  upstreamIdentity(captured),
  (attempt) => {
    const eventId = `evt-${base}-stale-${attempt}`;
    const result = postWebhook(STALE_EVENT_TYPE, eventId, orderId, `webhook_stale_${attempt}`);
    result.requestEventId = eventId;
    return result;
  },
  (result) => {
    assertWebhook(result, 'webhook stale', STALE_EVENT_TYPE, result.requestEventId, orderId, false);
    check(result, {
      'webhook stale keeps payment_status paid': ...,
      'webhook stale incoming_payment_status failed': ...,
      'webhook stale payment_regression_ignored true': ...,
      'webhook stale payment_state_reused true': ...,
      'webhook stale effective_event_type stays captured': ...,
      'webhook stale payment_state_updated_at preserved': ...,
      'webhook stale breakdown db_write_ms cleared': () => Number(staleBreakdown.db_write_ms || 0) === 0,
    });
  },
);
```

Expected:
- `payment_status` vẫn là `paid` (không bị ghi đè thành `failed`)
- `incoming_payment_status = 'failed'` (stale event báo failed)
- `payment_regression_ignored = true` (hệ thống đã phát hiện và bỏ qua regression)
- `payment_state_reused = true` (state hiện tại được giữ nguyên)
- `effective_event_type` vẫn là `CAPTURE_EVENT_TYPE` (không đổi thành `STALE_EVENT_TYPE`)
- `payment_state_updated_at` giữ nguyên timestamp cũ

#### Bước 6: Status read (cross-instance consistency)

```javascript
const status = findDistinctUpstream(
  'order status',
  upstreamIdentity(stale.result),
  (attempt) => getOrderStatus(orderId, `status_${attempt}`),
  (result) => assertStatus(result, 'order status', orderId, 'paid', CAPTURE_EVENT_TYPE, stateUpdatedAt),
);
```

Expected:
- `payment_status = 'paid'`
- `payment_event_type = CAPTURE_EVENT_TYPE`
- `payment_state_source = 'webhook'` (state đến từ webhook, không phải từ confirm)
- `payment_state_updated_at` khớp với timestamp từ bước 3

### 5.10 Sơ đồ tổ chức toàn bộ script

```text
┌─ options: vus=1, iterations=1, noConnectionReuse, thresholds checks rate==1
│
├─ Custom metrics (Trend + Counter)
│   ├─ confirm_first_duration, confirm_duplicate_duration
│   ├─ webhook_applied_duration, webhook_duplicate_duration, webhook_stale_duration
│   ├─ status_duration
│   ├─ distinct_upstream_attempts
│   └─ distributed_check_failures, distinct_upstream_observed/skipped/missing
│
├─ Helpers
│   ├─ requestHeaders(), safeJson(), normalizeHeaderValue(), getHeader()
│   ├─ responseEnvelope(), upstreamIdentity()
│   ├─ postConfirm(), postWebhook(), getOrderStatus()
│   ├─ assertUpstream(), assertConfirm(), assertWebhook(), assertStatus()
│   ├─ recordCheckFailure()
│   └─ findDistinctUpstream() ← cốt lõi distributed proof
│
└─ default()
    ├─ Bước 1: confirm_first → assert fresh (external_ms + db_write_ms)
    ├─ Bước 2: confirm_duplicate → findDistinctUpstream → assert reuse
    ├─ Bước 3: webhook_captured_first → assert fresh webhook
    ├─ Bước 4: webhook_duplicate → findDistinctUpstream → assert dedupe
    ├─ Bước 5: webhook_stale → findDistinctUpstream → assert regression protection
    └─ Bước 6: order_status → findDistinctUpstream → assert cross-instance read
```

---

## 6. Redis mechanism deep-dive

### 6.1 Tổng quan ba mechanism

Case này kiểm chứng ba mechanism của Redis shared state cho order-service:

| Mechanism | Redis data structure | Key pattern | Mục đích |
| --- | --- | --- | --- |
| Idempotency key storage | String (JSON value) | `idem:{orderId}:{key}` | Lưu kết quả confirm đầu tiên; retry tra cứu thay vì thực thi lại |
| Webhook event dedupe | Set | `webhook:events:{orderId}` | Lưu set các event_id đã xử lý; duplicate bị từ chối |
| Payment state với timestamp | Hash | `payment:{orderId}` | Lưu payment_status, event_type, source, updated_at; stale event bị ignore nếu timestamp cũ hơn |

### 6.2 Idempotency key storage -- chi tiết

**Luồng xử lý trong order-service:**

```text
POST /api/sim/orders/{orderId}/confirm
Header: Idempotency-Key: idem-xxx

1. order-service nhận request
2. Tạo Redis key: "idem:{orderId}:{idempotencyKey}"
3. Kiểm tra Redis: key đã tồn tại chưa?
   
   NẾU CHƯA TỒN TẠI (first request):
   4a. Thực thi business logic (external call + DB write)
   5a. Lưu kết quả vào Redis: SET "idem:{orderId}:{key}" = {result JSON}
   6a. Set TTL cho key (vd: 24h)
   7a. Trả về response với idempotency_reuse = false
   
   NẾU ĐÃ TỒN TẠI (retry request):
   4b. Đọc kết quả từ Redis: GET "idem:{orderId}:{key}"
   5b. KHÔNG thực thi business logic
   6b. KHÔNG write DB
   7b. KHÔNG gọi external service
   8b. Trả về response với idempotency_reuse = true
```

**Redis command flow cho idempotency:**

```text
# First request (fresh):
SET idem:ORD-SHARED-DIST-xxx:idem-xxx '{"success":true,"data":{...}}' EX 86400
→ OK

# Retry request (reuse):
GET idem:ORD-SHARED-DIST-xxx:idem-xxx
→ '{"success":true,"data":{...}}'
→ Trả về kết quả cũ, idempotency_reuse=true
```

**Điểm quan trọng:** Script KHÔNG dùng `SETNX` (SET if Not eXists) ở đây vì order-service app xử lý logic check-and-set. Redis chỉ là storage engine. Tuy nhiên, trong production, pattern phổ biến là dùng `SETNX` để atomic:

```text
SETNX idem:ORD-xxx:idem-xxx '{"status":"processing","timestamp":...}'
→ Nếu OK: request này là first, tiến hành xử lý
→ Nếu FAIL: key đã tồn tại, đọc kết quả và trả về
```

### 6.3 Webhook event dedupe -- chi tiết

**Luồng xử lý trong order-service:**

```text
POST /api/sim/orders/webhooks/payment
Body: { event_type: "payment.captured", event_id: "evt-xxx", order_id: "ORD-xxx" }

1. order-service nhận webhook
2. Kiểm tra Redis Set: "webhook:events:{orderId}"
3. Dùng SISMEMBER để kiểm tra event_id đã tồn tại chưa
   
   NẾU CHƯA TỒN TẠI (first webhook):
   4a. Thực thi business logic (cập nhật payment_status, DB write)
   5a. Thêm event_id vào Redis Set: SADD "webhook:events:{orderId}" "evt-xxx"
   6a. Cập nhật payment state hash
   7a. Trả về response với webhook_duplicate = false
   
   NẾU ĐÃ TỒN TẠI (duplicate webhook):
   4b. KHÔNG thực thi business logic
   5b. KHÔNG write DB
   6b. Trả về response với webhook_duplicate = true
```

**Redis command flow cho webhook dedupe:**

```text
# First webhook:
SISMEMBER webhook:events:ORD-xxx "evt-xxx-captured"
→ 0 (chưa tồn tại)
SADD webhook:events:ORD-xxx "evt-xxx-captured"
→ 1 (đã thêm)
HSET payment:ORD-xxx payment_status "paid" event_type "payment.captured" source "webhook" updated_at "2024-..."
→ OK

# Duplicate webhook:
SISMEMBER webhook:events:ORD-xxx "evt-xxx-captured"
→ 1 (đã tồn tại)
→ KHÔNG làm gì thêm, trả về webhook_duplicate=true
```

### 6.4 Payment state regression protection -- chi tiết

Đây là mechanism tinh vi nhất trong ba mechanism:

```text
POST /api/sim/orders/webhooks/payment
Body: { event_type: "payment.failed", event_id: "evt-xxx-stale", order_id: "ORD-xxx" }

1. order-service nhận stale webhook
2. Đọc payment state hiện tại từ Redis: HGETALL payment:ORD-xxx
   → payment_status: "paid"
   → updated_at: "2024-01-15T10:30:00Z"
   
3. So sánh timestamp:
   - Stale event timestamp: từ event_id hoặc thời gian hiện tại
   - Current state timestamp: từ Redis hash field "updated_at"
   
4. NẾU current state mới hơn stale event:
   5a. KHÔNG ghi đè payment_status
   5b. Trả về response với:
       - payment_regression_ignored = true
       - payment_state_reused = true
       - effective_event_type = event_type hiện tại (payment.captured)
       - payment_status vẫn = "paid"
```

**Redis perspective:**

```text
# State hiện tại trong Redis:
HGETALL payment:ORD-xxx
→ payment_status: "paid"
→ event_type: "payment.captured"
→ source: "webhook"
→ updated_at: "2024-01-15T10:30:00.000Z"

# Stale event đến (payment.failed):
→ App logic kiểm tra: current event_type ("payment.captured") "thắng" stale event ("payment.failed")
→ KHÔNG thay đổi gì trong Redis
→ Trả về payment_regression_ignored=true
```

### 6.5 Tại sao dùng `noConnectionReuse: true`

Đây là một chi tiết quan trọng trong script:

```javascript
noConnectionReuse: true,
```

**Vấn đề:** Nếu k6 reuse HTTP connection (keep-alive), tất cả request từ một VU sẽ đi qua cùng một TCP connection. LB (Nginx) thường dùng round-robin hoặc least-connections, nhưng với HTTP keep-alive, connection đã được thiết lập sẽ tiếp tục được dùng -- dẫn đến tất cả request đến cùng một upstream instance.

**Giải pháp:** `noConnectionReuse: true` buộc k6 tạo connection mới cho mỗi request. Điều này:
- Tăng khả năng LB phân phối request đến các instance khác nhau
- Làm cho `findDistinctUpstream` có cơ hội tìm thấy upstream khác cao hơn
- Phản ánh đúng hơn hành vi thực tế (production traffic từ nhiều client khác nhau)

---

## 7. Request sequence flow

### 7.1 Timeline toàn bộ script

```text
T0: k6 start
│
├─ DEFAULT phase ────────────────────────────────────────
│
│  ═══ Bước 1: Confirm đầu tiên (fresh) ═══
│  T1: POST /api/sim/orders/{orderId}/confirm
│      Header: Idempotency-Key = idem-xxx (MỚI)
│      Query: cpu_ms=20, db_writes=6, external_ms=240
│      → 200 OK, upstream=A
│      → idempotency_reuse=false ✓
│      → external_ms >= 240 ✓
│      → db_write_ms present ✓
│      → confirmed_at = "2024-01-15T10:30:00.000Z"
│
│  ═══ Bước 2: Confirm duplicate (retry, tìm distinct upstream) ═══
│  T2-Tn: POST /api/sim/orders/{orderId}/confirm (retry loop)
│      Header: Idempotency-Key = idem-xxx (CÙNG key)
│      → Retry cho đến khi upstream != A hoặc MAX_UPSTREAM_ATTEMPTS
│      → 200 OK, upstream=B (khác A) ✓
│      → idempotency_reuse=true ✓
│      → confirmed_at = "2024-01-15T10:30:00.000Z" (giống T1) ✓
│      → external_ms = 0 ✓
│      → db_write_ms = 0 ✓
│
│  ═══ Bước 3: Webhook đầu tiên (fresh) ═══
│  Tn+1: POST /api/sim/orders/webhooks/payment
│      Body: { event_type: "payment.captured", event_id: "evt-xxx-captured", ... }
│      → 200 OK, upstream=C
│      → webhook_duplicate=false ✓
│      → payment_status=paid ✓
│      → payment_state_updated_at = "2024-01-15T10:30:05.000Z"
│      → db_write_ms present ✓
│
│  ═══ Bước 4: Webhook duplicate (dedupe, tìm distinct upstream) ═══
│  Tn+2-Tm: POST /api/sim/orders/webhooks/payment (retry loop)
│      Body: { event_type: "payment.captured", event_id: "evt-xxx-captured" (CÙNG) }
│      → Retry cho đến khi upstream != C hoặc MAX_UPSTREAM_ATTEMPTS
│      → 200 OK, upstream=D (khác C) ✓
│      → webhook_duplicate=true ✓
│      → processed_at giống Tn+1 ✓
│      → db_write_ms = 0 ✓
│
│  ═══ Bước 5: Stale webhook (regression protection) ═══
│  Tm+1-Tk: POST /api/sim/orders/webhooks/payment (retry loop)
│      Body: { event_type: "payment.failed" (STALE), event_id: "evt-xxx-stale-N" (MỚI) }
│      → 200 OK
│      → payment_status vẫn = paid ✓
│      → payment_regression_ignored = true ✓
│      → payment_state_reused = true ✓
│      → effective_event_type = payment.captured (không đổi) ✓
│      → db_write_ms = 0 ✓
│
│  ═══ Bước 6: Status read ═══
│  Tk+1-Tx: GET /api/sim/orders/{orderId} (retry loop)
│      → 200 OK
│      → payment_status = paid ✓
│      → payment_event_type = payment.captured ✓
│      → payment_state_source = webhook ✓
│      → payment_state_updated_at = "2024-01-15T10:30:05.000Z" (khớp Tn+1) ✓
│
└─ Tx+1: k6 end (checks rate==1 → exit 0)
```

### 7.2 Phân tích từng giai đoạn

#### Giai đoạn CONFIRM (T1-Tn)

```text
Mục đích: Chứng minh idempotency hoạt động + state distributed qua upstream khác nhau

T1: POST confirm với key MỚI
    Redis state trước request: EMPTY (chưa có key này)
    → order-service thực thi business logic (external_ms=240, db_writes=6)
    → Lưu kết quả vào Redis: SET idem:ORD-xxx:idem-xxx = {result}
    → idempotency_reuse=false

T2-Tn: POST confirm với CÙNG key, retry tìm distinct upstream
    Redis state trước request: KEY EXISTS (từ T1)
    → order-service đọc từ Redis: GET idem:ORD-xxx:idem-xxx
    → KHÔNG thực thi business logic (external_ms=0, db_write_ms=0)
    → Trả về kết quả cũ: idempotency_reuse=true
    → Upstream khác T1 → chứng minh distributed
```

#### Giai đoạn WEBHOOK (Tn+1-Tm)

```text
Mục đích: Chứng minh webhook dedupe hoạt động + state distributed

Tn+1: POST webhook với event_id MỚI
    Redis state trước request: webhook:events:ORD-xxx = EMPTY
    → order-service xử lý webhook (db_write)
    → SADD webhook:events:ORD-xxx "evt-xxx-captured"
    → Cập nhật payment state trong Redis Hash
    → webhook_duplicate=false

Tn+2-Tm: POST webhook với CÙNG event_id, retry tìm distinct upstream
    Redis state trước request: webhook:events:ORD-xxx CHỨA "evt-xxx-captured"
    → SISMEMBER → 1 → dedupe
    → KHÔNG db_write
    → webhook_duplicate=true
```

#### Giai đoạn STALE WEBHOOK (Tm+1-Tk)

```text
Mục đích: Chứng minh payment state regression protection

Tm+1-Tk: POST webhook với STALE event_type (payment.failed)
    Redis state hiện tại: payment_status=paid, updated_at=Tn+1
    → order-service so sánh event
    → payment.failed không ghi đè payment.captured
    → payment_regression_ignored=true
    → payment_state_reused=true
    → KHÔNG thay đổi payment_status trong Redis
```

#### Giai đoạn STATUS READ (Tk+1-Tx)

```text
Mục đích: Chứng minh status read nhất quán qua instance khác

Tk+1-Tx: GET order status
    → order-service đọc từ Redis cho payment state
    → payment_status=paid (từ webhook, không phải từ confirm)
    → payment_state_source=webhook (chứng minh state đến từ webhook)
    → payment_state_updated_at khớp với timestamp từ Tn+1
```

### 7.3 State machine của idempotency key

```text
┌──────────┐   POST confirm (lần đầu)   ┌──────────────┐
│  EMPTY   │ ─────────────────────────→ │  PROCESSING  │
│ (Redis   │                            │  (đang xử lý) │
│  chưa có │                            └──────┬───────┘
│  key)    │                                   │
└──────────┘                            hoàn thành
                                            │
                                            ▼
                                     ┌──────────────┐
                                     │  COMPLETED   │
                                     │  (có kết quả │
                                     │   trong Redis)│
                                     └──────┬───────┘
                                            │
                              POST confirm (retry)
                              với cùng key
                                            │
                                            ▼
                                     ┌──────────────┐
                                     │  REPLAY      │
                                     │  (trả về kết │
                                     │   quả cũ,    │
                                     │   không thực  │
                                     │   thi lại)    │
                                     └──────────────┘
```

### 7.4 State machine của payment state

```text
┌──────────┐   webhook payment.captured   ┌──────────────┐
│  EMPTY   │ ───────────────────────────→ │  PAID         │
│ (chưa có │                              │  (source:     │
│  payment │                              │   webhook)    │
│  state)  │                              └──────┬───────┘
└──────────┘                                     │
                                         webhook payment.failed
                                         (STALE event)
                                                 │
                                                 ▼
                                         ┌──────────────┐
                                         │  PAID         │
                                         │  (UNCHANGED)  │
                                         │  regression   │
                                         │  ignored=true │
                                         └──────────────┘
```

---

## 8. Key signals / counters cần verify

### 8.1 Bảng custom metrics đầy đủ

| Metric | Loại | Expected | Ý nghĩa |
| --- | --- | --- | --- |
| `order_service_shared_state_distributed_check_failures` | Counter | `count==0` | Không có bất kỳ check failure nào |
| `order_service_shared_state_distinct_upstream_attempts` | Trend | Ghi nhận số attempt cho mỗi distinct upstream check | Cho biết cần bao nhiêu retry để tìm thấy upstream khác |
| `order_service_shared_state_distinct_upstream_observed` | Counter | `>0` nếu tìm thấy distinct upstream | Bằng chứng state thực sự distributed |
| `order_service_shared_state_distinct_upstream_skipped` | Counter | `>0` nếu `REQUIRE_DISTINCT_UPSTREAM=false` | Đã bỏ qua distinct upstream check |
| `order_service_shared_state_distinct_upstream_required_missing` | Counter | `count==0` | Nếu `>0`: yêu cầu distinct nhưng không tìm thấy |
| `order_service_shared_state_confirm_first_duration` | Trend | Cao hơn duplicate (có external + DB) | Fresh path latency |
| `order_service_shared_state_confirm_duplicate_duration` | Trend | Thấp hơn first (chỉ Redis read) | Replay path latency |
| `order_service_shared_state_webhook_applied_duration` | Trend | Cao hơn duplicate (có DB write) | Fresh webhook latency |
| `order_service_shared_state_webhook_duplicate_duration` | Trend | Thấp hơn applied (chỉ Redis check) | Dedupe latency |
| `order_service_shared_state_webhook_stale_duration` | Trend | Thấp (chỉ so sánh timestamp) | Stale check latency |
| `order_service_shared_state_status_duration` | Trend | Thấp (chỉ Redis read) | Status read latency |

### 8.2 Bảng body flags cần verify

| Flag | Vị trí | Expected value theo stage |
| --- | --- | --- |
| `idempotency_reuse` | `response.data` | `false` cho confirm first; `true` cho confirm duplicate |
| `webhook_duplicate` | `response.data` | `false` cho webhook first; `true` cho webhook duplicate |
| `payment_regression_ignored` | `response.data` | `true` cho stale webhook |
| `payment_state_reused` | `response.data` | `false` cho webhook first; `true` cho stale webhook |
| `payment_status` | `response.data` | `paid` sau webhook; vẫn `paid` sau stale |
| `payment_state_source` | `response.data` | `webhook` trong status read |
| `confirmed_at` | `response.data` | Giống nhau giữa first và duplicate confirm |
| `processed_at` | `response.data` | Giống nhau giữa first và duplicate webhook |

### 8.3 Bảng header cần verify

| Header | Expected | Xuất hiện ở đâu |
| --- | --- | --- |
| `X-Upstream-Service` | `order-service` | Tất cả các request |
| `X-Upstream-Addr` | Present, khác nhau giữa các request (nếu distinct upstream thành công) | Tất cả các request |
| `X-Upstream-Instance` | Present | Tất cả các request (nếu app gửi header này) |

### 8.4 Bảng breakdown metrics cần verify

| Breakdown field | Fresh path | Reuse/Dedupe path |
| --- | --- | --- |
| `external_ms` | `>= CONFIRM_EXTERNAL_MS` (vd: >= 240) | `0` |
| `db_write_ms` | Present (>0) | `0` hoặc cleared |
| `cpu_ms` | Có thể >0 | Có thể >0 (CPU vẫn dùng để parse request) |

Duration fresh thường cao hơn duplicate/reuse vì fresh path có DB/external work. Đây là expected.

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Case được coi là PASS khi **tất cả** các điều kiện sau đều đúng:

| # | Tiêu chí | Cách xác minh | Định lượng |
| --- | --- | --- | --- |
| 1 | k6 exit code = 0 | `$LASTEXITCODE` hoặc CI job status | `exit 0` |
| 2 | Tất cả checks pass | k6 output: `checks... 100%` | `checks rate = 1.0` |
| 3 | `distributed_check_failures = 0` | Custom counter | `count==0` |
| 4 | Confirm first: `idempotency_reuse=false` | Check trong output | Body flag đúng |
| 5 | Confirm first: `external_ms >= CONFIRM_EXTERNAL_MS` | Check trong output | Có external work |
| 6 | Confirm first: `db_write_ms present` | Check trong output | Có DB write |
| 7 | Confirm duplicate: `idempotency_reuse=true` | Check trong output | Idempotency replay |
| 8 | Confirm duplicate: `external_ms=0, db_write_ms=0` | Check trong output | Không làm lại work |
| 9 | Confirm duplicate: `confirmed_at` giống first | Check trong output | Timestamp nhất quán |
| 10 | Webhook first: `webhook_duplicate=false` | Check trong output | Fresh webhook |
| 11 | Webhook first: `payment_status=paid` | Check trong output | State được cập nhật |
| 12 | Webhook duplicate: `webhook_duplicate=true` | Check trong output | Dedupe hoạt động |
| 13 | Webhook duplicate: `processed_at` giống first | Check trong output | Timestamp nhất quán |
| 14 | Stale webhook: `payment_status` vẫn `paid` | Check trong output | Regression protection |
| 15 | Stale webhook: `payment_regression_ignored=true` | Check trong output | Phát hiện regression |
| 16 | Stale webhook: `payment_state_reused=true` | Check trong output | Giữ state cũ |
| 17 | Status read: `payment_state_source=webhook` | Check trong output | State đến từ webhook |
| 18 | Status read: `payment_status=paid` | Check trong output | Đọc đúng state |
| 19 | Distinct upstream observed (nếu `REQUIRE_DISTINCT_UPSTREAM=true`) | Counter | `distinct_upstream_observed > 0` |

### 9.2 Tiêu chí FAIL

Case FAIL khi **bất kỳ** điều kiện nào sau đây xảy ra:

| # | Dấu hiệu FAIL | Nguyên nhân khả dĩ | Cách debug |
| --- | --- | --- | --- |
| A | Duplicate confirm không `idempotency_reuse=true` | Idempotency state không shared hoặc không atomic | Kiểm tra Redis kết nối, key pattern |
| B | Duplicate confirm có `external_ms > 0` hoặc `db_write_ms > 0` | Hệ thống thực thi lại business logic thay vì replay | Idempotency implementation sai -- không check Redis trước khi thực thi |
| C | Duplicate webhook không `webhook_duplicate=true` | Webhook dedupe sai, có thể apply payment nhiều lần | Kiểm tra SISMEMBER/SADD logic |
| D | Stale failed event đổi `payment_status` từ paid sang failed | Payment state regression bug nghiêm trọng | Kiểm tra timestamp comparison logic |
| E | Status read không thấy webhook state | Shared state/status read không nhất quán | Kiểm tra Redis key cho payment state |
| F | `payment_state_source` không phải `webhook` | Status read đọc sai nguồn state | Kiểm tra cách state được lưu trong Redis |
| G | Không thấy upstream khác sau nhiều attempts | Có thể LB chưa phân phối hoặc sample nhỏ; không tự kết luận Redis sai, nhưng evidence distributed yếu | Tăng `EXPECTED_INSTANCES`, giảm `RETRY_SLEEP_SECONDS`, kiểm tra LB config |
| H | `checks rate < 1.0` | Có ít nhất 1 check fail | Đọc danh sách check thất bại |
| I | `distributed_check_failures > 0` | Có check failure được ghi nhận | Kiểm tra label của failure để xác định stage |

### 9.3 Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| Duplicate confirm không `idempotency_reuse=true` | Idempotency state không shared hoặc không atomic. |
| Duplicate webhook không `webhook_duplicate=true` | Webhook dedupe sai, có thể apply payment nhiều lần. |
| Stale failed event đổi `payment_status` từ paid sang failed | Payment state regression bug nghiêm trọng. |
| Status read không thấy webhook state | Shared state/status read không nhất quán. |
| Không thấy upstream khác sau nhiều attempts | Có thể LB chưa phân phối hoặc sample nhỏ; không tự kết luận Redis sai, nhưng evidence distributed yếu. |

### 9.4 Cách đọc kết quả FAIL chi tiết

Giả sử k6 output có dòng:

```text
✗ confirm duplicate idempotency reuse true
  ↳ 0% -- expected idempotency_reuse=true, got false
```

Phân tích:

1. Request `confirm duplicate` -- tức là request retry confirm với cùng `Idempotency-Key`
2. Expected `idempotency_reuse=true` -- vì key đã được dùng ở confirm first
3. Got `false` -- hệ thống không nhận ra đây là retry
4. Kết luận: Idempotency state không được shared qua Redis → kiểm tra Redis connection, key pattern, TTL

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy

Script: `../app/15-order-service-shared-state-distributed.js`
Executor: `per-vu-iterations implicit via options vus=1, iterations=1`
Topology: `full-no-cdn`
BASE_URL: `http://localhost:80`

```powershell
# 1. Di chuyển đến thư mục gốc
cd E:\Projects\k6\k6-metrics-server

# 2. Set biến môi trường cơ bản
$env:BASE_URL = "http://localhost:80"

# 3. Set biến để yêu cầu distinct upstream proof (nếu có >= 2 instances)
$env:ORDER_SHARED_STATE_EXPECTED_INSTANCES = "3"
$env:ORDER_SHARED_STATE_REQUIRE_DISTINCT_UPSTREAM = "true"

# 4. Chạy script
k6 run .\load-target\k6\app\15-order-service-shared-state-distributed.js
```

### 10.2 Output mẫu mong đợi (PASS)

```text
         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: .\load-target\k6\app\15-order-service-shared-state-distributed.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations for each of 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)


     data_received..................: 12 kB   ...
     data_sent......................: 5.2 kB  ...
     http_req_blocked...............: avg=0.50ms  ...
     http_req_connecting............: avg=0.30ms  ...
     http_req_duration..............: avg=85.00ms ...
     http_req_receiving.............: avg=0.10ms  ...
     http_req_sending...............: avg=0.02ms  ...
     http_req_waiting...............: avg=84.88ms ...
     http_reqs......................: 15      ...
     iteration_duration.............: avg=2.50s   ...
     iterations.....................: 1        ...
     vus............................: 1        ...
     vus_max........................: 1        ...


█ checks...
  ✓ confirm first upstream service order-service
  ✓ confirm first upstream addr present
  ✓ confirm first status 200
  ✓ confirm first success true
  ✓ confirm first order id preserved
  ✓ confirm first idempotency key preserved
  ✓ confirm first idempotency reuse false
  ✓ confirm first confirmed_at present
  ✓ confirm first breakdown external_ms >= 240
  ✓ confirm first breakdown db_write_ms present
  ✓ confirm duplicate upstream service order-service
  ✓ confirm duplicate upstream addr present
  ✓ confirm duplicate status 200
  ✓ confirm duplicate success true
  ✓ confirm duplicate order id preserved
  ✓ confirm duplicate idempotency key preserved
  ✓ confirm duplicate idempotency reuse true
  ✓ confirm duplicate confirmed_at present
  ✓ confirm duplicate confirmed_at reused
  ✓ confirm duplicate breakdown external_ms cleared
  ✓ confirm duplicate breakdown db_write_ms cleared
  ✓ confirm duplicate distinct upstream observed
  ✓ webhook captured first upstream service order-service
  ✓ webhook captured first upstream addr present
  ✓ webhook captured first status 200
  ✓ webhook captured first success true
  ✓ webhook captured first event type preserved
  ✓ webhook captured first event id preserved
  ✓ webhook captured first order id preserved
  ✓ webhook captured first acknowledged true
  ✓ webhook captured first webhook duplicate false
  ✓ webhook captured first processed_at present
  ✓ webhook captured first payment_status paid
  ✓ webhook captured first payment_regression_ignored false
  ✓ webhook captured first payment_state_reused false
  ✓ webhook captured first payment_state_updated_at present
  ✓ webhook captured first breakdown db_write_ms present
  ✓ webhook duplicate upstream service order-service
  ✓ webhook duplicate upstream addr present
  ✓ webhook duplicate status 200
  ✓ webhook duplicate success true
  ✓ webhook duplicate event type preserved
  ✓ webhook duplicate event id preserved
  ✓ webhook duplicate order id preserved
  ✓ webhook duplicate acknowledged true
  ✓ webhook duplicate webhook duplicate true
  ✓ webhook duplicate processed_at present
  ✓ webhook duplicate processed_at reused
  ✓ webhook duplicate payment_status paid
  ✓ webhook duplicate breakdown db_write_ms cleared
  ✓ webhook duplicate distinct upstream observed
  ✓ webhook stale upstream service order-service
  ✓ webhook stale upstream addr present
  ✓ webhook stale status 200
  ✓ webhook stale success true
  ✓ webhook stale event type preserved
  ✓ webhook stale event id preserved
  ✓ webhook stale order id preserved
  ✓ webhook stale acknowledged true
  ✓ webhook stale webhook duplicate false
  ✓ webhook stale processed_at present
  ✓ webhook stale keeps payment_status paid
  ✓ webhook stale incoming_payment_status failed
  ✓ webhook stale payment_regression_ignored true
  ✓ webhook stale payment_state_reused true
  ✓ webhook stale effective_event_type stays captured
  ✓ webhook stale payment_state_updated_at preserved
  ✓ webhook stale breakdown db_write_ms cleared
  ✓ webhook stale distinct upstream observed
  ✓ order status upstream service order-service
  ✓ order status upstream addr present
  ✓ order status status 200
  ✓ order status success true
  ✓ order status order id preserved
  ✓ order status payment status paid
  ✓ order status payment event captured
  ✓ order status payment state source webhook
  ✓ order status payment_state_updated_at preserved
  ✓ order status distinct upstream observed

   ✓ checks........................: 100.00% ✓ 74   ✗ 0
     ✓ { scenario:order_service_shared_state_distributed }...: 100.00% ✓ 74   ✗ 0


running (00m02.5s), 1/1 VUs, 1 complete and 0 interrupted iterations
default ✓ [======================================] 1 VUs  00m02.5s/10m0s  1/1 iters, 1 per VU
```

### 10.3 Output mẫu khi FAIL (idempotency không hoạt động)

```text
█ checks...
  ✓ confirm first status 200
  ✓ confirm first idempotency reuse false
  ✓ confirm first breakdown external_ms >= 240
  ✓ confirm first breakdown db_write_ms present
  ✗ confirm duplicate idempotency reuse true
    ↳ 0% -- expected true, got false
  ✗ confirm duplicate breakdown external_ms cleared
    ↳ 0% -- expected 0, got 245
  ✗ confirm duplicate breakdown db_write_ms cleared
    ↳ 0% -- expected 0, got 12

   ✗ checks........................: 95.94% ✓ 71   ✗ 3
     ✗ { scenario:order_service_shared_state_distributed }...: 95.94% ✓ 71   ✗ 3

ERRO[0005] thresholds on metrics 'checks' were crossed; at least one has failed
```

Phân tích:
- Confirm first pass → request đầu tiên OK, state đã được lưu
- Confirm duplicate fail → retry không thấy state cũ → idempotency KHÔNG hoạt động
- Cả `external_ms` và `db_write_ms` đều >0 → hệ thống đã thực thi lại toàn bộ business logic
- Đây là lỗi nghiêm trọng: duplicate side effect đã xảy ra

---

## 11. 4 output → decision scenarios

### Scenario 1: ALL PASS

```text
✓ checks 100% -- tất cả checks xanh
✓ distributed_check_failures = 0
✓ distinct_upstream_observed > 0 (distributed evidence có)
```

**Kết luận:** Redis shared state hoạt động chính xác cho idempotency, webhook dedupe, và payment state regression protection. State thực sự distributed qua nhiều upstream instances.

**Quyết định:** Hệ thống đã sẵn sàng cho production với confidence cao về shared state correctness. Có thể triển khai thêm order-service instances mà không lo mất consistency.

### Scenario 2: Idempotency FAIL, Webhook OK

```text
✓ Webhook first + duplicate: pass
✓ Stale webhook: pass
✓ Status read: pass
✗ Confirm duplicate: idempotency_reuse=false (expected true)
✗ Confirm duplicate: external_ms > 0 (expected 0)
```

**Phân tích:**
- Webhook dedupe hoạt động → Redis connection OK, set operation OK
- Nhưng idempotency replay không hoạt động → vấn đề nằm ở idempotency key storage riêng

**Nguyên nhân khả dĩ:**
1. Idempotency key lưu ở memory instance thay vì Redis
2. Key pattern khác với webhook event set → hai mechanism dùng hai Redis instance khác nhau?
3. TTL cho idempotency key quá ngắn → hết hạn trước khi retry đến

**Quyết định:**
- KHÔNG triển khai idempotency cho đến khi fix
- Tạm thời dùng webhook dedupe (đã pass) để bảo vệ payment
- Debug pattern: kiểm tra Redis keys `idem:*` sau khi chạy test

### Scenario 3: Webhook Dedupe FAIL

```text
✓ Confirm first + duplicate: pass
✗ Webhook duplicate: webhook_duplicate=false (expected true)
✗ Webhook duplicate: db_write_ms > 0 (expected 0)
```

**Phân tích:**
- Idempotency hoạt động → Redis string operation OK
- Webhook dedupe không hoạt động → vấn đề ở Redis set operation

**Nguyên nhân khả dĩ:**
1. `SADD` không được gọi sau lần đầu → event_id không được thêm vào set
2. `SISMEMBER` check sai key name → check set A, write set B
3. Webhook event set bị xóa bởi TTL quá ngắn

**Quyết định:**
- **Nguy hiểm:** Mỗi webhook retry có thể tạo duplicate payment → incident tài chính
- Dừng triển khai webhook, fix ngay Redis set logic
- Thêm alert monitoring cho `webhook_duplicate_count > 0` trong production

### Scenario 4: Regresion Protection FAIL

```text
✓ Confirm first + duplicate: pass
✓ Webhook first + duplicate: pass
✗ Stale webhook: payment_status=failed (expected paid)
✗ Stale webhook: payment_regression_ignored=false (expected true)
```

**Phân tích:**
- Idempotency và dedupe hoạt động → Redis cơ bản OK
- Regression protection không hoạt động → stale event đã ghi đè state mới

**Nguyên nhân khả dĩ:**
1. Không có timestamp comparison → event nào đến sau cùng cũng ghi đè
2. Timestamp logic sai → dùng thời gian event thay vì thời gian state được tạo
3. Không có logic "captured thắng failed" → mọi event đều được apply

**Quyết định:**
- **Cực kỳ nguy hiểm:** Payment provider retry failed event cũ có thể đảo ngược trạng thái thành công
- Dừng triển khai ngay, fix regression protection
- Thêm test case: gửi chuỗi event captured → failed → captured → failed và verify state cuối cùng

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Status 200 là đủ -- retry thành công"

```text
Sai:    "Retry confirm trả về 200, vậy là idempotency hoạt động"
Đúng:   Status 200 chỉ nói request được xử lý, không nói NÓ ĐƯỢC XỬ LÝ THẾ NÀO.
        Phải đọc idempotency_reuse flag và breakdown (external_ms, db_write_ms).
```

**Giải thích:** Một hệ thống không có idempotency vẫn có thể trả về 200 cho retry confirm -- nó sẽ tạo một order mới, trừ kho lần nữa, và trả về 200. Chỉ `idempotency_reuse=true` và `external_ms=0, db_write_ms=0` mới chứng minh retry KHÔNG tạo duplicate side effect.

### Nghịch lý 2: "Cùng upstream cho mọi request = Redis không hoạt động"

```text
Sai:    "Tất cả request đến cùng một instance → state không distributed"
Đúng:   Điều này có thể do LB config (sticky session, ip_hash) hoặc sample nhỏ.
        Không thể kết luận Redis sai từ việc không thấy distinct upstream.
```

**Giải thích:** Việc không thấy distinct upstream có thể do nhiều nguyên nhân:
- Chỉ có 1 instance đang chạy (`EXPECTED_INSTANCES=1`)
- LB dùng sticky session
- Sample quá nhỏ (chỉ 2-3 request)
- Tất cả instance khác bị crash/unhealthy

Script đã xử lý đúng: nếu `REQUIRE_DISTINCT_UPSTREAM=false`, distinct upstream chỉ là "nice to have", không phải fail criteria.

### Nghịch lý 3: "External delay trong fresh path là dấu hiệu hệ thống chậm"

```text
Sai:    "confirm_first_duration cao (300ms) → hệ thống chậm, cần optimize"
Đúng:   External delay 240ms là SIMULATED (query param external_ms=240).
        Fresh path PHẢI có delay này. Latency cao ở fresh path là EXPECTED.
```

**Giải thích:** Script cố tình thêm `external_ms=240` để mô phỏng gọi external service (payment provider). Đây là một phần của test: fresh path phải có delay này, reuse path phải không có. Đừng báo động khi thấy fresh path chậm.

### Nghịch lý 4: "Dùng chung Redis cho mọi thứ thì không cần test"

```text
Sai:    "Đã dùng Redis rồi thì mặc nhiên idempotency và dedupe đúng"
Đúng:   Redis là infrastructure. Implementation (key pattern, SETNX, SISMEMBER,
        timestamp comparison) mới quyết định correctness.
```

**Giải thích:** Có vô số cách implement sai trên Redis:
- Dùng sai key pattern → lookup miss
- Không atomic (check rồi set, có race window)
- TTL quá ngắn → mất state trước khi retry đến
- Không có regression protection → event mới ghi đè event cũ bất kể timestamp

Redis là công cụ. Implementation mới là thứ cần test.

### Nghịch lý 5: "Case này chỉ cần 1 VU nên không test được concurrency"

```text
Sai:    "1 VU không đủ để test race condition"
Đúng:   Case này test SEQUENTIAL consistency (không phải concurrency).
        Case 02 (hotkey-race) mới là case test concurrency.
```

**Giải thích:** Mỗi case có mục đích riêng:
- Case 01: Sequential proof -- state có giữ đúng qua nhiều upstream không?
- Case 02: Concurrency proof -- atomicity dưới concurrent retry storm

Đây là thiết kế có chủ đích, không phải thiếu sót.

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=order-service"` | Có ít nhất 2 container order-service | Khởi động stack với `-ScaleApp 3` |
| 2 | Redis đang chạy | `docker ps --filter "name=redis"` | Có container Redis | Khởi động stack |
| 3 | Public path hoạt động | `curl http://localhost:80/health` | HTTP 200 | Kiểm tra Nginx config |
| 4 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại biến môi trường |
| 5 | Số lượng instance đủ để test distributed | `docker ps --filter "name=order-service" \| Measure-Object` | >= 2 | Set `ORDER_SHARED_STATE_EXPECTED_INSTANCES` đúng |
| 6 | `TargetLayer` đúng | Kiểm tra cách stack được khởi động | `full-no-cdn` | Khởi động lại với `-TargetLayer full-no-cdn` |
| 7 | Không có stale data trong Redis | Không cần kiểm tra thủ công (order ID mới mỗi lần chạy) | N/A | N/A |
| 8 | Không có test khác đang chạy | `docker stats --no-stream` | Chỉ có stack services | Đợi test khác hoàn thành |

### 13.2 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 9 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\app\15-order-service-shared-state-distributed.js"` |
| 10 | `common.js` tồn tại | Import đúng path, không có lỗi syntax |
| 11 | API endpoints hoạt động | `curl -X POST http://localhost:80/api/sim/orders/test/confirm -H 'Content-Type: application/json' -H 'Idempotency-Key: test' -d '{}'` → 200 |
| 12 | `REQUIRE_DISTINCT_UPSTREAM` được set đúng | `true` nếu có >= 2 instances, `false` nếu chỉ có 1 |
| 13 | `OPS_AUTH_TOKEN` không cần thiết cho case này | Case này không gọi control plane |

### 13.3 K6 checklist

| # | Mục kiểm tra |
| --- | --- |
| 14 | k6 đã được cài đặt: `k6 version` |
| 15 | Không có biến môi trường nào conflict (`K6_*` env vars) |
| 16 | Terminal/CI có đủ timeout (script chạy < 5 giây nếu distinct upstream nhanh, có thể lâu hơn nếu retry đến MAX_UPSTREAM_ATTEMPTS) |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Nhiều idempotency keys khác nhau cho cùng order

Mở rộng để kiểm tra nhiều idempotency key khác nhau cùng trỏ đến một order -- tất cả đều phải được replay đúng.

```javascript
// Variation 1: Multiple idempotency keys for same order
// Thêm vào default() hoặc tạo script mới

const orderId = `ORD-MULTI-${Date.now()}`;
const keys = ['idem-key-1', 'idem-key-2', 'idem-key-3'];

// Lần lượt confirm với các key khác nhau
for (const key of keys) {
  const first = postConfirm(orderId, key, `multi_first_${key}`);
  assertConfirm(first, `multi first ${key}`, orderId, key, false);

  const duplicate = postConfirm(orderId, key, `multi_dup_${key}`);
  assertConfirm(duplicate, `multi dup ${key}`, orderId, key, true);

  // Verify confirmed_at reused
  check({ first, duplicate }, {
    [`multi ${key} confirmed_at reused`]: (o) =>
      o.first.payload.data.confirmed_at === o.duplicate.payload.data.confirmed_at,
  });
}
```

**Điểm học:** Mỗi `Idempotency-Key` là một key riêng trong Redis, nhưng tất cả đều trỏ đến cùng một order. Hệ thống phải replay đúng cho từng key.

### Variation 2: Thay đổi thứ tự webhook events

Kiểm tra rằng hệ thống xử lý đúng khi events đến không theo thứ tự thời gian.

```javascript
// Variation 2: Out-of-order webhook events
// Gửi failed trước, rồi captured sau

const orderId = `ORD-OOO-${Date.now()}`;

// Gửi failed event trước
const failedFirst = postWebhook('payment.failed', `evt-failed-${Date.now()}`, orderId, 'failed_first');
check(failedFirst, {
  'failed first payment_status failed': (o) =>
    o.payload.data.payment_status === 'failed',
});

// Gửi captured event sau (phải thắng failed vì đây là event mới hơn theo business logic)
const capturedLater = postWebhook('payment.captured', `evt-captured-${Date.now()}`, orderId, 'captured_later');
check(capturedLater, {
  'captured later payment_status paid': (o) =>
    o.payload.data.payment_status === 'paid',
  'captured later overrides failed': (o) =>
    o.payload.data.payment_regression_ignored === false,
});

// Status read phải thấy paid
const status = getOrderStatus(orderId, 'ooo_status');
assertStatus(status, 'ooo status', orderId, 'paid', 'payment.captured', null);
```

**Điểm học:** Payment state không chỉ dựa trên timestamp đơn thuần, mà còn dựa trên business rule (captured thắng failed). Test này chứng minh hệ thống không đơn giản là "last-write-wins".

### Variation 3: Concurrent webhooks khác event_id nhưng cùng order

```javascript
// Variation 3: Multiple different webhooks for same order
// Mô phỏng payment provider gửi nhiều event khác nhau cho cùng order

const orderId = `ORD-MULTI-WEBHOOK-${Date.now()}`;
const events = [
  { type: 'payment.authorized', id: `evt-auth-${Date.now()}` },
  { type: 'payment.captured', id: `evt-cap-${Date.now()}` },
  { type: 'payment.settled', id: `evt-set-${Date.now()}` },
];

for (const evt of events) {
  const result = postWebhook(evt.type, evt.id, orderId, `multi_${evt.type}`);
  check(result, {
    [`webhook ${evt.type} success`]: (o) => o.payload.success === true,
    [`webhook ${evt.type} not duplicate`]: (o) =>
      o.payload.data.webhook_duplicate === false,
  });

  // Mỗi event khác nhau phải được apply (không phải duplicate)
  const duplicate = postWebhook(evt.type, evt.id, orderId, `multi_dup_${evt.type}`);
  check(duplicate, {
    [`webhook ${evt.type} duplicate is duplicate`]: (o) =>
      o.payload.data.webhook_duplicate === true,
  });
}
```

**Điểm học:** Mỗi `event_id` khác nhau là một webhook khác nhau và phải được xử lý riêng. Dedupe chỉ hoạt động khi cùng `event_id`.

### Variation 4: Status read sau mỗi bước

Mở rộng script để đọc status sau TỪNG bước -- không chỉ sau bước cuối cùng.

```javascript
// Variation 4: Status read after each step
// Thêm status read sau mỗi bước thay vì chỉ cuối cùng

// Sau confirm (chưa có webhook)
const statusAfterConfirm = getOrderStatus(orderId, 'after_confirm');
check(statusAfterConfirm, {
  'after confirm payment_status not set': (o) =>
    o.payload.data.payment_status === null || o.payload.data.payment_status === '',
  'after confirm no payment_state_source': (o) =>
    !o.payload.data.payment_state_source,
});

// Sau webhook captured
// ... (webhook logic)
const statusAfterWebhook = getOrderStatus(orderId, 'after_webhook');
check(statusAfterWebhook, {
  'after webhook payment_status paid': (o) =>
    o.payload.data.payment_status === 'paid',
  'after webhook source webhook': (o) =>
    o.payload.data.payment_state_source === 'webhook',
});

// Sau stale webhook
// ... (stale logic)
const statusAfterStale = getOrderStatus(orderId, 'after_stale');
check(statusAfterStale, {
  'after stale payment_status still paid': (o) =>
    o.payload.data.payment_status === 'paid',
});
```

**Điểm học:** State evolution qua từng bước phải đúng: ban đầu chưa có payment, sau webhook có payment, sau stale vẫn giữ payment. Mỗi bước đều có thể verify.

### Variation 5: Custom TTL verification

Kiểm tra rằng idempotency key có TTL và hết hạn đúng.

```javascript
// Variation 5: TTL verification
// Yêu cầu: app hỗ trợ query param ttl_seconds cho idempotency key

const orderId = `ORD-TTL-${Date.now()}`;
const shortKey = `idem-ttl-short-${Date.now()}`;

// Confirm với TTL ngắn (vd: 2 giây)
const first = http.post(
  `${BASE_URL}/api/sim/orders/${orderId}/confirm?ttl_seconds=2`,
  JSON.stringify({}),
  { headers: requestHeaders('ttl-test', { 'Idempotency-Key': shortKey }) },
);
check(first, { 'ttl first status 200': (r) => r.status === 200 });

// Đợi TTL hết hạn
sleep(3);

// Retry sau khi TTL hết hạn → phải là MISS (key đã bị xóa)
const afterTTL = http.post(
  `${BASE_URL}/api/sim/orders/${orderId}/confirm?ttl_seconds=2`,
  JSON.stringify({}),
  { headers: requestHeaders('ttl-test-2', { 'Idempotency-Key': shortKey }) },
);

const afterTTLJson = afterTTL.json();
check(afterTTLJson, {
  'after TTL idempotency_reuse should be false': (o) =>
    o.data.idempotency_reuse === false,
});
```

**Điểm học:** TTL là con dao hai lưỡi. Quá ngắn → mất idempotency protection. Quá dài → tốn Redis memory. Cần chọn TTL phù hợp với business requirement (vd: 24h cho order confirm, 7 ngày cho payment webhook).

---

## 15. Anti-patterns

### Anti-pattern 1: Chỉ check HTTP status, bỏ qua body flags

```javascript
// SAI -- anti-pattern
const res = http.post(url, body, params);
check(res, { 'status 200': (r) => r.status === 200 });
// Không check idempotency_reuse, webhook_duplicate, payment_regression_ignored

// ĐÚNG -- luôn check body flags
const res = http.post(url, body, params);
const payload = res.json();
check(res, { 'status 200': (r) => r.status === 200 });
check(payload, {
  'idempotency_reuse đúng': (p) => p.data.idempotency_reuse === expectReuse,
  'external_ms cleared': (p) => p.performance.breakdown.external_ms === 0,
  'db_write_ms cleared': (p) => p.performance.breakdown.db_write_ms === 0,
});
```

Hậu quả: Status 200 không chứng minh idempotency. Hệ thống có thể tạo duplicate side effect nhưng vẫn trả 200.

### Anti-pattern 2: Dùng chung order ID cho nhiều lần chạy

```javascript
// SAI -- anti-pattern
const orderId = 'ORD-FIXED-001';  // Cố định, dùng lại mỗi lần chạy
// Lần chạy thứ 2: idempotency key đã tồn tại trong Redis từ lần 1
// → không test được fresh path

// ĐÚNG -- mỗi lần chạy tạo order ID mới
const orderId = `${ORDER_ID_PREFIX}-${Date.now()}-${__VU}-${__ITER}`;
```

Hậu quả: Lần chạy thứ 2 trở đi, tất cả request đều thấy `idempotency_reuse=true` vì key đã tồn tại từ lần 1 → false positive (tưởng idempotency hoạt động nhưng thực ra chỉ là replay từ lần chạy trước).

### Anti-pattern 3: Bỏ qua `noConnectionReuse`

```javascript
// SAI -- anti-pattern
export const options = {
  vus: 1,
  iterations: 1,
  // Thiếu: noConnectionReuse: true
};

// ĐÚNG
export const options = {
  vus: 1,
  iterations: 1,
  noConnectionReuse: true,  // Bắt buộc cho distributed proof
};
```

Hậu quả: Tất cả request dùng chung TCP connection → đến cùng một upstream instance → không chứng minh được distributed.

### Anti-pattern 4: Chạy case này với `TargetLayer=full`

```powershell
# SAI -- anti-pattern
.\scripts\stack.ps1 -Stack target -Action up -TargetLayer full
# Có Varnish/CDN phía trước → cache có thể trả về response cũ
# → idempotency_reuse có thể đến từ CDN cache, không phải từ Redis

# ĐÚNG
.\scripts\stack.ps1 -Stack target -Action up -TargetLayer full-no-cdn
```

Hậu quả: CDN cache có thể làm nhiễu signal Redis. Nếu CDN cache response của confirm first, request retry có thể được CDN trả về từ cache (HIT) thay vì đi đến order-service → không test được Redis idempotency.

### Anti-pattern 5: Không verify breakdown metrics

```javascript
// SAI -- anti-pattern: chỉ check body flags
check(payload, {
  'idempotency_reuse': (p) => p.data.idempotency_reuse === true,
});
// Không check external_ms và db_write_ms

// ĐÚNG -- check cả breakdown
const breakdown = payload.performance.breakdown;
check(payload, {
  'idempotency_reuse': (p) => p.data.idempotency_reuse === true,
  'external_ms zero': () => Number(breakdown.external_ms || 0) === 0,
  'db_write_ms zero': () => Number(breakdown.db_write_ms || 0) === 0,
});
```

Hậu quả: `idempotency_reuse=true` có thể được set nhưng hệ thống vẫn thực thi business logic (external call, DB write) -- đây là "fake idempotency". Breakdown metrics là bằng chứng duy nhất cho thấy work không bị lặp lại.

---

## 16. Real validation data

### 16.1 Dữ liệu xác thực từ case catalog

Case catalog (`case-catalog.json`) định nghĩa các giá trị mong đợi cho case này:

```json
{
  "id": "redis-01-shared-state-distributed",
  "script": "../app/15-order-service-shared-state-distributed.js",
  "title": "Shared state across order-service instances",
  "businessCase": "Verify that order confirmation, payment webhook dedupe and status reads stay consistent even when requests are routed across different order-service instances.",
  "whatItTeaches": "Redis/shared state must be centralized; per-instance memory would break idempotency replay and webhook state when the LB changes upstream.",
  "run": {
    "env": {
      "BASE_URL": "http://localhost:80"
    }
  },
  "calls": [
    {
      "operation": "order_confirm",
      "method": "POST",
      "path": "/api/sim/orders/{orderId}/confirm",
      "expectedStatus": 200,
      "stateExpectation": "same Idempotency-Key replays the first successful result"
    },
    {
      "operation": "payment_webhook",
      "method": "POST",
      "path": "/api/sim/orders/webhooks/payment",
      "expectedStatus": 200,
      "stateExpectation": "same event_id is applied once and duplicates are deduped"
    },
    {
      "operation": "order_status",
      "method": "GET",
      "path": "/api/sim/orders/{orderId}/status",
      "expectedStatus": 200,
      "stateExpectation": "status read sees the payment state written by webhook"
    }
  ],
  "expected": {
    "customMetrics": [
      "order_service_shared_state_distributed_check_failures count==0",
      "order_service_shared_state_distinct_upstream_attempts records upstream spread"
    ],
    "signals": [
      "X-Upstream-Service=order-service",
      "X-Upstream-Addr present",
      "idempotency replay remains stable across upstream instances"
    ]
  }
}
```

### 16.2 So sánh expected vs actual

Khi chạy case thành công, so sánh các giá trị:

| Metric | Expected (catalog) | Actual (PASS run) | Match? |
| --- | --- | --- | --- |
| `distributed_check_failures` | `count==0` | `count==0` | ✅ |
| `checks rate` | `rate==1` | `1.0` | ✅ |
| `idempotency_reuse` (first) | `false` | `false` | ✅ |
| `idempotency_reuse` (duplicate) | `true` | `true` | ✅ |
| `webhook_duplicate` (first) | `false` | `false` | ✅ |
| `webhook_duplicate` (duplicate) | `true` | `true` | ✅ |
| `payment_regression_ignored` (stale) | `true` | `true` | ✅ |
| `X-Upstream-Service` | `order-service` | `order-service` | ✅ |
| `X-Upstream-Addr` | present | different across requests | ✅ |

### 16.3 Dữ liệu latency điển hình (local Docker)

| Stage | Duration (avg) | Ghi chú |
| --- | --- | --- |
| `confirm_first` | ~260-280ms | Bao gồm 240ms external delay + 20ms CPU + DB writes |
| `confirm_duplicate` | ~5-15ms | Chỉ Redis GET + JSON parse |
| `webhook_applied` | ~15-25ms | DB write (3 writes) + CPU |
| `webhook_duplicate` | ~3-8ms | Chỉ Redis SISMEMBER |
| `webhook_stale` | ~3-8ms | Redis HGETALL + timestamp comparison |
| `status_read` | ~5-10ms | Redis HGETALL + DB read |

Lưu ý: Đây là latency trong môi trường local Docker (không có network delay thực). Production latency sẽ cao hơn, đặc biệt cho external call.

### 16.4 Số lượng request trong một lần chạy điển hình

| Stage | Số request tối thiểu | Số request với distinct upstream |
| --- | --- | --- |
| `confirm_first` | 1 | 1 |
| `confirm_duplicate` | 1-10 | 2-3 (tìm thấy distinct upstream sau vài retry) |
| `webhook_captured_first` | 1 | 1 |
| `webhook_duplicate` | 1-10 | 2-3 |
| `webhook_stale` | 1-10 | 2-3 |
| `order_status` | 1-10 | 2-3 |
| **Tổng** | **6-42** | **10-14** |

---

## 17. Reference

### 17.1 Source files

| File | Đường dẫn |
| --- | --- |
| Script chính | `E:\Projects\k6\k6-metrics-server\load-target\k6\app\15-order-service-shared-state-distributed.js` |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\redis\case-catalog.json` |
| Overview Redis series | `E:\Khoa hoc\k6\docs\practice\redis\00_overview.md` |
| Shared helper | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` |

### 17.2 Related cases

| Case | Mối liên hệ |
| --- | --- |
| `redis-02-hotkey-race` | Mở rộng lên concurrency: cùng key được gửi đồng thời bởi nhiều VU |
| `redis-03-claim-owner-abandon` | Mở rộng lên claim ownership: worker abandon và TTL takeover |
| `redis-04-redis-degrade` | Mở rộng lên degraded Redis: idempotency + dedupe vẫn đúng dù Redis chậm |

### 17.3 Layer roadmap context

```text
Layer 1: CDN/Varnish → cache hit/miss, invalidation
Layer 2: LB/Gateway → routing, sticky sessions, failover
Layer 3: Redis/Shared State → idempotency, dedupe, consistency ← CASE NÀY
Layer 4: App/Service → business logic correctness
Layer 5: DB/Storage → data persistence, transactions
```

### 17.4 Concepts cần nắm vững trước khi đọc case này

| Concept | Định nghĩa ngắn |
| --- | --- |
| Idempotency key | Token client gửi kèm request để đảm bảo retry không tạo duplicate side effect |
| Idempotency replay | Hành động trả về kết quả đã lưu thay vì thực thi lại |
| Webhook dedupe | Cơ chế đảm bảo cùng webhook event_id chỉ được xử lý một lần |
| Payment regression | Stale/lỗi thời event ghi đè state mới hơn (đây là bug) |
| Regression protection | Cơ chế ngăn stale event ghi đè state mới |
| Distributed state | State được lưu ở nơi tất cả instances đều truy cập được (Redis), không nằm trong memory instance |
| Upstream identity | Định danh của instance đã xử lý request (địa chỉ IP:port hoặc instance ID) |
| Breakdown metrics | Các số liệu đo lường từng phần của quá trình xử lý (CPU, DB write, external call) |

---

## 8. Dashboard/chart reading (bổ sung)

Chart hữu ích:

- latency theo stage: fresh confirm/webhook cao hơn duplicate/stale/status;
- checks rate 100%;
- timeline sequence theo `target_flow`;
- distinct upstream attempts để biết retry có đi qua nhiều instance hay không.

Không đọc aggregate p95 để kết luận. Fresh path có external delay nên p95 cao là bình thường.

---

## 9. Production lesson (bổ sung)

Shared state distributed là nền của order/payment correctness. Nếu idempotency và webhook dedupe không sống ở Redis/shared store, LB distribution sẽ biến retry bình thường thành duplicate side effect.

### Hệ quả trong production thực tế

```text
Ngày Black Friday, một user nhấn "Đặt hàng" 5 lần do app bị lag.
Nếu idempotency hoạt động: 1 order được tạo, 4 lần retry replay kết quả cũ.
Nếu idempotency KHÔNG hoạt động: 5 order được tạo, kho bị trừ 5 lần,
user bị charge 5 lần, 5 email xác nhận được gửi.

Khác biệt: 1 order vs 5 orders. Đây không phải là "corner case" --
đây là điều XẢY RA HÀNG NGÀY với bất kỳ hệ thống có mobile app + network không ổn định.
```

### Mối liên hệ với các case khác trong series

```text
Case 01 (này): chứng minh state distributed qua instances khác nhau
Case 02: chứng minh state atomic dưới concurrent retry storm
Case 03: chứng minh claim ownership + TTL takeover khi worker chết
Case 04: chứng minh correctness counters vẫn đúng khi Redis bị degrade

Cả 4 case = bộ bằng chứng toàn diện cho shared state correctness.
```

### Điều gì xảy ra nếu không có shared state?

| Scenario | Không shared state | Có shared state |
| --- | --- | --- |
| Retry confirm qua instance khác | Duplicate order | Idempotency replay |
| Retry webhook qua instance khác | Duplicate payment processing | Webhook dedupe |
| Instance crash khi đang xử lý | Mất state, không biết đã xử lý chưa | State trong Redis, instance khác takeover |
| Stale event đến instance khác | Có thể ghi đè state mới | Regression protection dựa trên centralized timestamp |
| Status read từ instance khác | Có thể đọc state cũ | Luôn đọc state mới nhất từ Redis |
