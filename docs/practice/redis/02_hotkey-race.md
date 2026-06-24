# redis-02 -- Hot-key idempotency race

> **Case ID:** `redis-02-hotkey-race`
> **Script:** `../app/16-order-service-shared-state-hotkey-race.js`
> **Layer:** Redis / Shared State
> **Proof:** Atomic idempotency -- chính xác 1 fresh execution + (VUS-1) reuse/duplicate dưới concurrent retry storm

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

Một payment/order retry storm xảy ra: nhiều client gửi cùng order confirm key hoặc cùng webhook event id gần như đồng thời. Đây là tình huống hay gặp khi mobile app retry, payment provider retry, hoặc network timeout làm client không biết request trước đã thành công chưa.

```text
8 VUs cùng POST một Idempotency-Key
8 VUs cùng POST một webhook event_id
```

Nếu Redis lock/idempotency không atomic, nhiều request có thể cùng fresh execution và tạo duplicate side effect.

### 1.2 Hai tình huống retry storm điển hình

**Tình huống A -- Mobile app retry storm (confirm hotkey):**

```text
Một người dùng trên mobile app nhấn "Đặt hàng". Network 3G không ổn định,
request đầu tiên bị timeout sau 5 giây (dù server đã xử lý xong). App
tự động retry. Không chỉ 1 lần -- app retry 3 lần trong 15 giây.

Đồng thời, user cũng nhấn nút trên một tab khác của app (hoặc user khác
trên cùng tài khoản). Kết quả: 5-8 request với cùng Idempotency-Key đến
server gần như đồng thời.
```

**Tình huống B -- Payment provider webhook retry (webhook hotkey):**

```text
Payment provider (vd: Stripe) gửi webhook báo payment.captured. Nhưng do
network congestion, webhook request không nhận được response 200 trong
timeout 3 giây. Stripe retry policy: gửi lại sau 5s, 10s, 15s, 30s, 60s...

Trong lúc đó, một webhook khác từ cùng payment intent cũng được gửi
(do internal Stripe retry). Kết quả: 4-8 webhook request với cùng event_id
đến server gần như đồng thời.
```

### 1.3 Hậu quả nếu race condition xảy ra

| Hậu quả | Cơ chế gây ra | Mức độ ảnh hưởng |
| --- | --- | --- |
| Nhiều order được tạo từ 1 Idempotency-Key | Nhiều request cùng vượt qua check "key chưa tồn tại" trước khi key được SET | Duplicate order, trừ kho nhiều lần, charge nhiều lần |
| Nhiều payment được apply từ 1 event_id | Nhiều request cùng thấy SISMEMBER trả về 0 trước khi SADD được gọi | Payment state bị cập nhật nhiều lần, trigger nhiều notification |
| DB write conflict | Nhiều request cùng ghi vào cùng record | Data corruption, optimistic lock failure |
| External call bị gọi nhiều lần | Mỗi request gọi payment provider, email service, SMS service riêng | Tăng chi phí, spam user, rate limit từ provider |

### 1.4 Vì sao đây là case quan trọng nhất trong Redis series

Case 01 (shared-state-distributed) chứng minh state **có thể** được chia sẻ qua nhiều instances. Nhưng case 01 chạy sequential (1 VU) -- nó không chứng minh state **an toàn dưới concurrency**.

Case 02 này giải quyết câu hỏi còn lại: "Khi 8 request cùng đến một lúc, Redis có đảm bảo chỉ 1 request thắng không?"

Đây là khác biệt giữa **correctness trong điều kiện lý tưởng** (case 01) và **correctness trong điều kiện thực tế** (case 02).

---

## 2. Redis capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh hot-key race được collapse đúng:

```text
confirm: exactly 1 fresh + HOTKEY_VUS-1 reuse
webhook: exactly 1 fresh + HOTKEY_VUS-1 duplicate
```

Không cần tất cả request nhanh; cần tất cả request đúng side-effect semantics.

### 2.2 Phân tích chi tiết capability

| # | Capability | Cách chứng minh | Tại sao khó |
| --- | --- | --- | --- |
| 1 | Atomic idempotency check-and-set | 8 VU đồng thời POST confirm với cùng `Idempotency-Key`. Chỉ 1 VU có `idempotency_reuse=false`. | Nếu không atomic: 2+ VU cùng đọc "key chưa tồn tại" → cả 2 cùng SET → cả 2 cùng thực thi business logic |
| 2 | Atomic webhook dedupe | 8 VU đồng thời POST webhook với cùng `event_id`. Chỉ 1 VU có `webhook_duplicate=false`. | Nếu không atomic: 2+ VU cùng SISMEMBER=0 → cả 2 cùng SADD → cả 2 cùng DB write |
| 3 | Breakdown verification | Fresh path có `external_ms >= threshold` và `db_write_ms present`. Reuse path có `external_ms=0` và `db_write_ms=0`. | Chứng minh reuse path thực sự không làm lại work |
| 4 | Cross-VU status consistency | Sau webhook, tất cả VU (cả fresh và duplicate) đều đọc status và thấy `payment_status=paid`, `source=webhook`. | Chứng minh state nhất quán cho mọi observer |
| 5 | Multi-scenario coordination | Hai scenario `confirm_hotkey` và `webhook_hotkey` chạy độc lập với `startTime` khác nhau, dùng data từ `setup()`. | Mô phỏng thực tế: confirm storm và webhook storm xảy ra ở các thời điểm khác nhau |

### 2.3 Cơ chế atomicity -- trái tim của case này

Để đảm bảo "exactly 1 fresh", cần cơ chế atomic check-and-set. Có hai cách implement phổ biến:

**Cách 1: SETNX (SET if Not eXists) -- Redis native atomic**

```text
SETNX idem:ORD-xxx:idem-xxx '{"status":"processing"}' EX 86400
→ Trả về 1: key chưa tồn tại, đã SET thành công → request này LÀ FRESH
→ Trả về 0: key đã tồn tại → request này LÀ REUSE
```

SETNX là atomic -- Redis đảm bảo chỉ 1 trong N client đồng thời nhận được `1`.

**Cách 2: Lua script -- multi-step atomic**

```lua
-- Redis Lua script (atomic execution)
local key = KEYS[1]
local value = ARGV[1]
local ttl = ARGV[2]

local exists = redis.call('EXISTS', key)
if exists == 0 then
  redis.call('SET', key, value, 'EX', ttl)
  return {1, 'fresh'}  -- first request
else
  local existing = redis.call('GET', key)
  return {0, existing}  -- replay
end
```

Lua script chạy atomic trong Redis -- không client nào khác có thể xen vào giữa `EXISTS` và `SET`.

### 2.4 Bảng so sánh: không atomic vs có atomic

| Khía cạnh | Không atomic (race bug) | Có atomic (đúng) |
| --- | --- | --- |
| Số request thực thi business logic | 2-8 (không đoán trước được) | Chính xác 1 |
| Số DB write | 2-8 lần | 1 lần |
| Số external call | 2-8 lần | 1 lần |
| `confirm_fresh_count` | > 1 | == 1 |
| `confirm_reuse_count` | < VUS-1 | == VUS-1 |
| Người dùng thấy gì? | Nhiều email xác nhận, nhiều lần trừ kho | 1 email, 1 lần trừ kho |

---

## 3. Vì sao phải test ở Redis/shared state layer

### 3.1 Redis là nơi duy nhất có thể cung cấp atomicity

```text
client/k6 -> http://localhost:80 -> Nginx LB/Gateway -> app/order-service -> Redis
```

Khi 8 request đến 8 instance khác nhau (hoặc cùng instance nhưng 8 thread), không có cơ chế nào trong app memory có thể đảm bảo atomicity:

- **Memory lock (mutex/synchronized)**: Chỉ hoạt động trong cùng 1 process. 8 instance = 8 process = 8 lock riêng biệt.
- **Database unique constraint**: Có thể hoạt động, nhưng chậm và không phù hợp cho idempotency key (cần TTL).
- **File lock**: Không hoạt động qua network.
- **Redis SETNX / Lua script**: Atomic, nhanh, hỗ trợ TTL, hoạt động qua network.

### 3.2 Không phải LB, không phải App

| Layer | Có thể giải quyết race condition? | Vì sao |
| --- | --- | --- |
| LB/Gateway | Không | LB chỉ route request, không biết gì về business logic hay idempotency key |
| App (single instance) | Một phần | Dùng in-memory lock (mutex) chỉ hoạt động trong 1 instance. Không hoạt động khi scale ngang |
| App (multi-instance) | Không | Mỗi instance có bộ nhớ riêng, không thấy lock của nhau |
| Database | Một phần | Unique constraint có thể ngăn duplicate insert, nhưng chậm và không hỗ trợ TTL tự nhiên |
| **Redis** | **Có** | SETNX/Lua script atomic, nhanh (sub-millisecond), hỗ trợ TTL, hoạt động xuyên instance |

### 3.3 Vì sao case này dùng `per-vu-iterations` với 8 VU

Đây là điểm khác biệt cốt lõi với case 01 (1 VU sequential):

```text
Case 01: 1 VU, sequential → chứng minh state distributed QUA instances
Case 02: 8 VU, concurrent → chứng minh state atomic DƯỚI race
```

`per-vu-iterations` với `vus=8, iterations=1` có nghĩa: 8 VU khởi động gần như đồng thời, mỗi VU chạy đúng 1 iteration. Điều này tạo ra **race condition thật** -- tất cả 8 request đến server trong khoảng thời gian rất ngắn (vài ms).

Nếu dùng `constant-vus` với duration, các request sẽ trải đều theo thời gian → không tạo race.

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌──────────────────────────────────────┐
                          │         k6 test script                │
                          │  (16-order-service-shared-state-      │
                          │   hotkey-race.js)                     │
                          │                                       │
                          │  Scenario 1: confirm_hotkey           │
                          │    8 VUs, 1 iter, startTime=0s        │
                          │  Scenario 2: webhook_hotkey           │
                          │    8 VUs, 1 iter, startTime=4s        │
                          └──────────┬───────────────────────────┘
                                     │
                                     │ HTTP (qua LB :80)
                                     ▼
┌────────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx LB/Gateway)                               │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  Upstream: order-service (N instances)                │     │
│  │  - Round-robin hoặc least-connections                 │     │
│  └──────────┬───────────────────────────────────────────┘     │
│             │                                                   │
│             ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  order-service instances                              │     │
│  │  ┌──────────┐  ┌──────────┐       ┌──────────┐       │     │
│  │  │ instance │  │ instance │  ...  │ instance │       │     │
│  │  │    1     │  │    2     │       │    N     │       │     │
│  │  └────┬─────┘  └────┬─────┘       └────┬─────┘       │     │
│  │       │             │                  │              │     │
│  │       └─────────────┼──────────────────┘              │     │
│  │                     │                                  │     │
│  │                     ▼                                  │     │
│  │  ┌──────────────────────────────────────────┐        │     │
│  │  │  Redis                                     │        │     │
│  │  │  ┌─────────────────────────────────────┐  │        │     │
│  │  │  │  SETNX idem:ORD-xxx:idem-xxx        │  │        │     │
│  │  │  │  → Chỉ 1 trong 8 VU nhận OK         │  │        │     │
│  │  │  └─────────────────────────────────────┘  │        │     │
│  │  │  ┌─────────────────────────────────────┐  │        │     │
│  │  │  │  SISMEMBER webhook:events:ORD-xxx   │  │        │     │
│  │  │  │  → Chỉ 1 trong 8 VU thấy 0           │  │        │     │
│  │  │  └─────────────────────────────────────┘  │        │     │
│  │  └──────────────────────────────────────────┘        │     │
│  └──────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `full-no-cdn` (bắt buộc) | `docker ps` thấy order-service và Redis |
| `BASE_URL` | `http://localhost:80` | `curl http://localhost:80/health` |
| `ORDER_SHARED_STATE_HOTKEY_VUS` | `8` (mặc định) | Set env var nếu muốn thay đổi |
| Redis | Phải hỗ trợ SETNX hoặc Lua script | Mặc định Redis có sẵn SETNX |

### 4.3 Stack khởi động

```powershell
# Khởi động full-no-cdn stack
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 3
```

### 4.4 Precondition từ `setup()`

Script có `setup()` function, chạy MỘT LẦN trước khi tất cả VU bắt đầu:

```javascript
export function setup() {
  const base = `${Date.now()}`;
  return {
    confirmOrderId: `ORD-HOTKEY-CONFIRM-${base}`,
    confirmKey: `idem-hotkey-${base}`,
    webhookOrderId: `ORD-HOTKEY-WEBHOOK-${base}`,
    webhookEventId: `evt-hotkey-${base}`,
  };
}
```

**Điểm quan trọng:**
- `setup()` chạy 1 lần → tạo order ID, key, event ID **giống nhau cho tất cả VU**
- Tất cả 8 VU dùng chung `data.confirmKey` → đây chính là "hot key"
- Tất cả 8 VU dùng chung `data.webhookEventId` → đây chính là "hot event"
- `Date.now()` đảm bảo mỗi lần chạy tạo key mới → không bị nhiễu từ lần chạy trước

Không cần precondition thủ công. Setup tự động và sạch.

---

## 5. Script deep-dive

### 5.1 File nguồn

Script: `../app/16-order-service-shared-state-hotkey-race.js`
Executor: `per-vu-iterations`
Scenarios:
  `confirm_hotkey`: `HOTKEY_VUS` VUs, 1 iteration
  `webhook_hotkey`: `HOTKEY_VUS` VUs, 1 iteration, `startTime=4s`
Default `HOTKEY_VUS`: 8
Topology: `full-no-cdn`
BASE_URL: `http://localhost:80`

Executor dùng nhiều VU để tạo race thật trên cùng key.

### 5.2 Import và dependency

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { envInt, envString } from '../shared/common.js';
```

Script sử dụng các built-in module của k6 và shared helper `common.js`.

### 5.3 Custom metrics

Script định nghĩa các custom metrics được thiết kế đặc biệt cho race condition verification:

```javascript
// Counter metrics -- quan trọng nhất cho pass/fail
const hotkeyCheckFailures = new Counter('order_service_shared_state_hotkey_check_failures');
const confirmFreshCount = new Counter('order_service_shared_state_hotkey_confirm_fresh_count');
const confirmReuseCount = new Counter('order_service_shared_state_hotkey_confirm_reuse_count');
const webhookFreshCount = new Counter('order_service_shared_state_hotkey_webhook_fresh_count');
const webhookDuplicateCount = new Counter('order_service_shared_state_hotkey_webhook_duplicate_count');

// Trend metrics -- đo latency cho từng path
const confirmDuration = new Trend('order_service_shared_state_hotkey_confirm_duration', true);
const confirmFreshDuration = new Trend('order_service_shared_state_hotkey_confirm_fresh_duration', true);
const confirmReuseDuration = new Trend('order_service_shared_state_hotkey_confirm_reuse_duration', true);
const webhookDuration = new Trend('order_service_shared_state_hotkey_webhook_duration', true);
const webhookFreshDuration = new Trend('order_service_shared_state_hotkey_webhook_fresh_duration', true);
const webhookDuplicateDuration = new Trend('order_service_shared_state_hotkey_webhook_duplicate_duration', true);
const statusDuration = new Trend('order_service_shared_state_hotkey_status_duration', true);
```

**Phân tích từng counter metric:**

| Counter | Expected (với HOTKEY_VUS=8) | Ý nghĩa nếu sai |
| --- | --- | --- |
| `confirm_fresh_count` | `1` | Nếu `>1`: Nhiều VU cùng thực thi fresh → atomicity fail |
| `confirm_reuse_count` | `7` | Nếu `<7`: Một số VU không nhận được replay (có thể bị lỗi hoặc timeout) |
| `webhook_fresh_count` | `1` | Nếu `>1`: Nhiều VU cùng apply webhook → dedupe fail |
| `webhook_duplicate_count` | `7` | Nếu `<7`: Một số VU không được dedupe |
| `hotkey_check_failures` | `0` | Nếu `>0`: Có ít nhất 1 check failure |

**Phân tích từng trend metric:**

| Trend | Fresh path | Reuse/Dedupe path |
| --- | --- | --- |
| `confirm_fresh_duration` | Cao hơn (có external_ms + DB write) | -- |
| `confirm_reuse_duration` | -- | Thấp hơn (chỉ Redis lookup) |
| `webhook_fresh_duration` | Cao hơn (có DB write) | -- |
| `webhook_duplicate_duration` | -- | Thấp hơn (chỉ Redis lookup) |

### 5.4 options block -- hai scenarios

```javascript
export const options = {
  noConnectionReuse: true,
  scenarios: {
    confirm_hotkey: {
      executor: 'per-vu-iterations',
      exec: 'confirmHotkey',
      vus: HOTKEY_VUS,
      iterations: 1,
      maxDuration: '1m',
      tags: {
        scenario: 'order_service_shared_state_hotkey_race',
        phase: 'confirm_hotkey',
        target_service: 'order-service',
      },
    },
    webhook_hotkey: {
      executor: 'per-vu-iterations',
      exec: 'webhookHotkey',
      vus: HOTKEY_VUS,
      iterations: 1,
      startTime: '4s',
      maxDuration: '1m',
      tags: {
        scenario: 'order_service_shared_state_hotkey_race',
        phase: 'webhook_hotkey',
        target_service: 'order-service',
      },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    order_service_shared_state_hotkey_check_failures: ['count==0'],
    order_service_shared_state_hotkey_confirm_fresh_count: [`count==1`],
    order_service_shared_state_hotkey_confirm_reuse_count: [`count==${Math.max(HOTKEY_VUS - 1, 0)}`],
    order_service_shared_state_hotkey_webhook_fresh_count: [`count==1`],
    order_service_shared_state_hotkey_webhook_duplicate_count: [`count==${Math.max(HOTKEY_VUS - 1, 0)}`],
  },
};
```

**Phân tích thiết kế scenarios:**

##### Tại sao hai scenarios riêng biệt?

```text
confirm_hotkey và webhook_hotkey là hai bài test độc lập:
- Mỗi bài cần VU riêng, key riêng, timing riêng
- Nếu gộp chung: không kiểm soát được thứ tự (VU confirm và VU webhook xen kẽ)
- Tách riêng: confirm xong → webhook bắt đầu → clear evidence chain
```

##### Tại sao `startTime: '4s'` cho webhook?

```text
- confirm_hotkey bắt đầu ở T=0s, kết thúc trong < 1s
- webhook_hotkey bắt đầu ở T=4s → đảm bảo confirm đã xong
- Nếu webhook bắt đầu cùng lúc confirm: có thể xảy ra race giữa
  confirm và webhook (không phải mục tiêu test của case này)
```

##### Tại sao dùng `per-vu-iterations`?

Đây là executor phù hợp nhất cho race condition test:

```text
per-vu-iterations, vus=8, iterations=1:
  - 8 VU khởi động đồng thời (trong k6, các VU được schedule gần như cùng lúc)
  - Mỗi VU chạy đúng 1 iteration → gửi 1 request → xong
  - Tất cả 8 request đến server trong khoảng vài ms → RACE THẬT
```

| Executor | Tạo race? | Vì sao |
| --- | --- | --- |
| **per-vu-iterations** (đang dùng) | ✅ **CÓ** | 8 VU start simultaneously, 1 iter mỗi VU |
| constant-vus | ⚠️ Một phần | Request trải đều theo duration → không tập trung |
| constant-arrival-rate | ⚠️ Một phần | Có thể ép rate cao, nhưng không đảm bảo đồng thời |
| shared-iterations | ❌ Không | Nhiều VU chia sẻ iterations → request sequential |

##### Thresholds quan trọng:

```javascript
thresholds: {
  checks: ['rate==1'],                                                    // (1)
  http_req_failed: ['rate==0'],                                           // (2)
  order_service_shared_state_hotkey_check_failures: ['count==0'],         // (3)
  order_service_shared_state_hotkey_confirm_fresh_count: [`count==1`],    // (4)
  order_service_shared_state_hotkey_confirm_reuse_count: [`count==7`],    // (5)
  order_service_shared_state_hotkey_webhook_fresh_count: [`count==1`],    // (6)
  order_service_shared_state_hotkey_webhook_duplicate_count: [`count==7`], // (7)
}
```

| # | Threshold | Vai trò |
| --- | --- | --- |
| (1) | `checks rate==1` | Tất cả check() phải pass -- không có ngoại lệ |
| (2) | `http_req_failed rate==0` | Không request nào fail (network, timeout) |
| (3) | `check_failures count==0` | Backup: nếu check() pass nhưng logic sai → counter sẽ khác 0 |
| (4)-(5) | `confirm_fresh==1, confirm_reuse==7` | **Atomicity proof cho confirm** |
| (6)-(7) | `webhook_fresh==1, webhook_duplicate==7` | **Atomicity proof cho webhook** |

Threshold (4)-(7) là **core contract** của case này. Nếu bất kỳ threshold nào fail, k6 exit code != 0.

### 5.5 `setup()` -- tạo shared data

```javascript
export function setup() {
  const base = `${Date.now()}`;
  return {
    confirmOrderId: `ORD-HOTKEY-CONFIRM-${base}`,
    confirmKey: `idem-hotkey-${base}`,
    webhookOrderId: `ORD-HOTKEY-WEBHOOK-${base}`,
    webhookEventId: `evt-hotkey-${base}`,
  };
}
```

Data từ `setup()` được truyền vào mỗi VU qua tham số `data`. Tất cả 8 VU trong `confirm_hotkey` nhận cùng `data.confirmKey` → race trên cùng một key. Tất cả 8 VU trong `webhook_hotkey` nhận cùng `data.webhookEventId` → race trên cùng một event.

### 5.6 `confirmHotkey(data)` -- logic confirm race

```javascript
export function confirmHotkey(data) {
  const result = postConfirm(data.confirmOrderId, data.confirmKey);
  confirmDuration.add(result.response.timings.duration, { stage: 'confirm' });

  assertUpstream(result, 'confirm hotkey');
  check(result, {
    'confirm hotkey status 200': (o) => o.response.status === 200,
    'confirm hotkey success true': (o) => o.payload && o.payload.success === true,
    'confirm hotkey order id preserved': ...,
    'confirm hotkey idempotency key preserved': ...,
    'confirm hotkey confirmed_at present': ...,
  });

  const breakdown = result.payload && result.payload.performance
    ? result.payload.performance.breakdown || {} : {};
  const reuse = !!(result.payload && result.payload.data
    && result.payload.data.idempotency_reuse === true);

  if (reuse) {
    confirmReuseCount.add(1);
    confirmReuseDuration.add(result.response.timings.duration, { stage: 'confirm_reuse' });
    check(result, {
      'confirm hotkey reuse breakdown external_ms cleared': () =>
        Number(breakdown.external_ms || 0) === 0,
      'confirm hotkey reuse breakdown db_write_ms cleared': () =>
        Number(breakdown.db_write_ms || 0) === 0,
    });
  } else {
    confirmFreshCount.add(1);
    confirmFreshDuration.add(result.response.timings.duration, { stage: 'confirm_fresh' });
    check(result, {
      [`confirm hotkey fresh breakdown external_ms >= ${CONFIRM_EXTERNAL_MS}`]: () =>
        Number(breakdown.external_ms || 0) >= CONFIRM_EXTERNAL_MS,
      'confirm hotkey fresh breakdown db_write_ms present': () =>
        Object.prototype.hasOwnProperty.call(breakdown, 'db_write_ms'),
    });
  }
}
```

**Logic rẽ nhánh theo `idempotency_reuse`:**

```text
Mỗi VU gọi postConfirm() → nhận response → kiểm tra idempotency_reuse:

NẾU idempotency_reuse === true (REUSE PATH):
  - confirmReuseCount += 1
  - Ghi nhận reuse duration
  - VERIFY: external_ms == 0 (không gọi external service lại)
  - VERIFY: db_write_ms == 0 (không write DB lại)

NẾU idempotency_reuse === false (FRESH PATH):
  - confirmFreshCount += 1
  - Ghi nhận fresh duration
  - VERIFY: external_ms >= CONFIRM_EXTERNAL_MS (đã thực hiện external call)
  - VERIFY: db_write_ms present (đã write DB)
```

### 5.7 `webhookHotkey(data)` -- logic webhook race

```javascript
export function webhookHotkey(data) {
  const result = postWebhook(data.webhookOrderId, data.webhookEventId);
  webhookDuration.add(result.response.timings.duration, { stage: 'webhook' });

  assertUpstream(result, 'webhook hotkey');
  check(result, {
    'webhook hotkey status 200': ...,
    'webhook hotkey success true': ...,
    'webhook hotkey event type preserved': ...,
    'webhook hotkey event id preserved': ...,
    'webhook hotkey order id preserved': ...,
    'webhook hotkey processed_at present': ...,
    'webhook hotkey payment status paid': ...,
  });

  const breakdown = ...;
  const duplicate = !!(result.payload && result.payload.data
    && result.payload.data.webhook_duplicate === true);

  if (duplicate) {
    webhookDuplicateCount.add(1);
    webhookDuplicateDuration.add(result.response.timings.duration, { stage: 'webhook_duplicate' });
    check(result, {
      'webhook hotkey duplicate breakdown db_write_ms cleared': () =>
        Number(breakdown.db_write_ms || 0) === 0,
    });
  } else {
    webhookFreshCount.add(1);
    webhookFreshDuration.add(result.response.timings.duration, { stage: 'webhook_fresh' });
    check(result, {
      'webhook hotkey fresh breakdown db_write_ms present': () =>
        Object.prototype.hasOwnProperty.call(breakdown, 'db_write_ms'),
    });
  }

  // Status verification: TẤT CẢ VU (cả fresh và duplicate) đều đọc status
  const status = getOrderStatus(data.webhookOrderId, duplicate ? 'after_duplicate' : 'after_fresh');
  statusDuration.add(status.response.timings.duration, { stage: ... });
  assertUpstream(status, 'status after webhook hotkey');
  check(status, {
    'status after webhook hotkey status 200': ...,
    'status after webhook hotkey success true': ...,
    'status after webhook hotkey order id preserved': ...,
    'status after webhook hotkey payment status paid': ...,
    'status after webhook hotkey payment event captured': ...,
    'status after webhook hotkey source webhook': ...,
  });
}
```

**Điểm đặc biệt của `webhookHotkey`:**

Sau khi xử lý webhook (dù fresh hay duplicate), **mỗi VU đều gọi thêm GET order status**. Điều này chứng minh:

1. State được shared: dù VU nào thực hiện fresh, tất cả VU đều thấy `payment_status=paid`
2. Source đúng: tất cả VU đều thấy `payment_state_source=webhook`
3. Consistency: không có VU nào thấy state cũ hoặc state không nhất quán

### 5.8 Sơ đồ tổ chức toàn bộ script

```text
┌─ options: 2 scenarios (confirm_hotkey, webhook_hotkey), per-vu-iterations
│   ├─ thresholds: checks rate==1, http_req_failed rate==0
│   ├─ thresholds: confirm_fresh==1, confirm_reuse==7
│   └─ thresholds: webhook_fresh==1, webhook_duplicate==7
│
├─ Custom metrics (Counter + Trend)
│   ├─ hotkeyCheckFailures
│   ├─ confirmFreshCount, confirmReuseCount
│   ├─ webhookFreshCount, webhookDuplicateCount
│   ├─ confirmDuration, confirmFreshDuration, confirmReuseDuration
│   ├─ webhookDuration, webhookFreshDuration, webhookDuplicateDuration
│   └─ statusDuration
│
├─ Helpers
│   ├─ requestHeaders(), recordCheckFailure(), safeJson()
│   ├─ normalizeHeaderValue(), getHeader(), responseEnvelope()
│   ├─ postConfirm(), postWebhook(), getOrderStatus()
│   └─ assertUpstream()
│
├─ setup()
│   └─ Tạo shared data: confirmOrderId, confirmKey, webhookOrderId, webhookEventId
│
├─ confirmHotkey(data) ← 8 VUs chạy đồng thời
│   ├─ postConfirm() với data.confirmKey
│   ├─ Assert cơ bản (status, success, order_id, key, confirmed_at)
│   ├─ Nếu reuse → confirmReuseCount++, verify external_ms=0, db_write_ms=0
│   └─ Nếu fresh → confirmFreshCount++, verify external_ms>=threshold, db_write_ms present
│
└─ webhookHotkey(data) ← 8 VUs chạy đồng thời (sau 4s)
    ├─ postWebhook() với data.webhookEventId
    ├─ Assert cơ bản (status, success, event type/id, payment_status)
    ├─ Nếu duplicate → webhookDuplicateCount++, verify db_write_ms=0
    ├─ Nếu fresh → webhookFreshCount++, verify db_write_ms present
    └─ getOrderStatus() → TẤT CẢ VU verify payment_status=paid, source=webhook
```

---

## 6. Redis mechanism deep-dive

### 6.1 Tổng quan atomicity mechanism

Case này kiểm chứng khả năng atomicity của Redis dưới concurrent access. Có hai pattern chính:

| Pattern | Redis command | Độ phức tạp | Use case |
| --- | --- | --- | --- |
| SETNX | `SETNX key value` + `EXPIRE key ttl` | Thấp | Idempotency key đơn giản |
| Lua script | `EVAL "script" 1 key value ttl` | Trung bình | Logic phức tạp hơn (check-and-set nhiều bước) |
| Redlock | Multi-instance lock | Cao | Distributed lock giữa nhiều Redis instances |

Case này tập trung vào SETNX và Lua script.

### 6.2 SETNX deep-dive

**Cú pháp:**

```text
SETNX key value
→ Trả về 1 nếu key chưa tồn tại và SET thành công
→ Trả về 0 nếu key đã tồn tại (không thay đổi gì)
```

**Tính chất quan trọng:**
- **Atomic**: Redis xử lý từng command một cách tuần tự (single-threaded event loop). Khi một client gửi `SETNX`, không client nào khác có thể xen vào giữa.
- **Nhanh**: O(1) operation, thường dưới 1ms.
- **Đơn giản**: Chỉ cần 1 command.

**Flow trong order-service cho confirm hotkey:**

```text
8 VUs đồng thời gửi POST /api/sim/orders/{orderId}/confirm
với cùng Idempotency-Key: "idem-hotkey-xxx"

Tại order-service (cho TỪNG request):

1. Tính Redis key: "idem:ORD-HOTKEY-CONFIRM-xxx:idem-hotkey-xxx"
2. Gửi SETNX đến Redis:
   SETNX idem:ORD-HOTKEY-CONFIRM-xxx:idem-hotkey-xxx '{"status":"processing","timestamp":...}'

3. Redis xử lý TUẦN TỰ 8 request SETNX:
   Request 1 (đến đầu tiên): SETNX → key chưa tồn tại → trả về 1 → FRESH
   Request 2-8 (đến sau): SETNX → key đã tồn tại → trả về 0 → REUSE

4. Request 1 (FRESH):
   - Thực thi business logic (external call + DB write)
   - SET key với kết quả cuối cùng (ghi đè status "processing")
   - Trả về idempotency_reuse=false

5. Request 2-8 (REUSE):
   - Đợi request 1 hoàn thành (có thể poll Redis GET cho đến khi status != "processing")
   - GET key → nhận kết quả cuối cùng
   - KHÔNG thực thi business logic
   - Trả về idempotency_reuse=true
```

**Tại sao SETNX đủ cho case này?**

Vì business logic cho idempotency key đơn giản: "chỉ 1 request được xử lý, còn lại replay". SETNX cung cấp chính xác semantic này một cách atomic.

**Cạm bẫy với SETNX:**

```text
Sai: SETNX key value      // (1) set key
     EXPIRE key ttl        // (2) set TTL

Vấn đề: Nếu process crash giữa (1) và (2) → key tồn tại vĩnh viễn, không có TTL
→ key không bao giờ hết hạn → memory leak

Đúng: SET key value EX ttl NX   // SET với EX (TTL) và NX (chỉ set nếu chưa tồn tại)
→ Atomic: cả SET và TTL trong 1 command
```

Script k6 không kiểm tra TTL behavior (để lại cho Variation 5 của case 01), nhưng đây là điều quan trọng trong production.

### 6.3 Webhook dedupe atomicity

**Flow trong order-service cho webhook hotkey:**

```text
8 VUs đồng thời gửi POST /api/sim/orders/webhooks/payment
với cùng event_id: "evt-hotkey-xxx"

Tại order-service:

1. Tính Redis key: "webhook:events:ORD-HOTKEY-WEBHOOK-xxx"
2. Kiểm tra và thêm atomic (dùng Lua script hoặc SETNX pattern tương tự):

Lua script (atomic):
  local key = KEYS[1]
  local event_id = ARGV[1]
  local is_member = redis.call('SISMEMBER', key, event_id)
  if is_member == 0 then
    redis.call('SADD', key, event_id)
    return 1  -- FRESH: event_id chưa tồn tại, đã thêm
  else
    return 0  -- DUPLICATE: event_id đã tồn tại
  end

3. Nếu script trả về 1 (FRESH):
   - Thực thi business logic (DB write)
   - Trả về webhook_duplicate=false

4. Nếu script trả về 0 (DUPLICATE):
   - KHÔNG thực thi business logic
   - Trả về webhook_duplicate=true
```

**Tại sao cần Lua script cho webhook dedupe?**

Với webhook dedupe, cần check (`SISMEMBER`) rồi add (`SADD`) -- hai thao tác. Nếu không atomic:

```text
Không atomic (race bug):
  VU 1: SISMEMBER → 0 (chưa có)
  VU 2: SISMEMBER → 0 (chưa có) ← CÙNG LÚC, trước khi VU 1 kịp SADD
  VU 1: SADD → thêm event_id
  VU 2: SADD → thêm event_id (đã có, nhưng SADD trả về 0, không sao)
  → Cả 2 VU đều thực thi business logic → DUPLICATE SIDE EFFECT

Có atomic (Lua script):
  VU 1: EVAL script → SISMEMBER=0 → SADD → return 1 (FRESH)
  VU 2: EVAL script → SISMEMBER=1 → return 0 (DUPLICATE) ← ĐÃ THẤY event_id
  → Chỉ VU 1 thực thi business logic
```

### 6.4 Flow visualization -- cuộc đua đến Redis

```text
Timeline (microseconds):

T=0μs:   8 VUs bắt đầu gửi HTTP request
T=500μs: 8 request đến Nginx
T=600μs: Nginx forward 8 request đến order-service instances
T=700μs: 8 request đến Redis (SETNX hoặc EVAL)

Redis xử lý TUẦN TỰ (single-threaded):

T=701μs: Request từ VU-3 đến Redis đầu tiên
         → SETNX trả về 1 → VU-3 LÀ FRESH
         
T=702μs: Request từ VU-7 đến Redis thứ hai
         → SETNX trả về 0 → VU-7 LÀ REUSE
         
T=703μs: Request từ VU-1 → SETNX=0 → REUSE
T=704μs: Request từ VU-5 → SETNX=0 → REUSE
T=705μs: Request từ VU-2 → SETNX=0 → REUSE
T=706μs: Request từ VU-8 → SETNX=0 → REUSE
T=707μs: Request từ VU-4 → SETNX=0 → REUSE
T=708μs: Request từ VU-6 → SETNX=0 → REUSE

Kết quả: 1 FRESH, 7 REUSE ✓
```

**Điểm mấu chốt:** Redis single-threaded event loop là ĐẶC ĐIỂM, không phải HẠN CHẾ. Chính vì single-threaded mà SETNX và Lua script mới atomic -- không có race condition nào có thể xảy ra BÊN TRONG Redis.

---

## 7. Request sequence flow

### 7.1 Timeline toàn bộ script (2 scenarios, 16 VUs total)

```text
T0: k6 start
│
├─ SETUP phase ──────────────────────────────────────
│  setup() chạy 1 lần
│  → Tạo confirmOrderId, confirmKey, webhookOrderId, webhookEventId
│  → Data được share cho tất cả VUs
│
├─ SCENARIO 1: confirm_hotkey (8 VUs, startTime=0s) ─
│
│  T=0.0s: 8 VUs khởi động đồng thời
│  T=0.0-0.1s: 8 VUs gửi POST confirm với CÙNG Idempotency-Key
│
│  VU-1: POST /api/sim/orders/ORD-HOTKEY-CONFIRM-xxx/confirm
│         Header: Idempotency-Key = idem-hotkey-xxx
│         → Redis SETNX → 1 (FRESH) → external + DB → 200 OK
│         → idempotency_reuse = false
│         → external_ms >= 240, db_write_ms present
│
│  VU-2: POST ... (cùng key) → Redis SETNX → 0 (REUSE) → 200 OK
│         → idempotency_reuse = true
│         → external_ms = 0, db_write_ms = 0
│
│  VU-3 đến VU-8: tương tự VU-2 → REUSE
│
│  Kết quả confirm:
│    confirm_fresh_count = 1
│    confirm_reuse_count = 7
│
├─ SCENARIO 2: webhook_hotkey (8 VUs, startTime=4s) ─
│
│  T=4.0s: 8 VUs khởi động đồng thời
│  T=4.0-4.1s: 8 VUs gửi POST webhook với CÙNG event_id
│
│  VU-9:  POST /api/sim/orders/webhooks/payment
│         Body: { event_type: "payment.captured", event_id: "evt-hotkey-xxx", ... }
│         → Redis EVAL (SISMEMBER + SADD) → 1 (FRESH) → DB write → 200 OK
│         → webhook_duplicate = false
│         → db_write_ms present
│         → GET order status → payment_status=paid, source=webhook ✓
│
│  VU-10: POST ... (cùng event_id) → Redis EVAL → 0 (DUPLICATE) → 200 OK
│         → webhook_duplicate = true
│         → db_write_ms = 0
│         → GET order status → payment_status=paid, source=webhook ✓
│
│  VU-11 đến VU-16: tương tự VU-10 → DUPLICATE
│
│  Kết quả webhook:
│    webhook_fresh_count = 1
│    webhook_duplicate_count = 7
│    Tất cả 8 VUs đọc status: payment_status=paid ✓, source=webhook ✓
│
└─ T=5.0s: k6 end (tất cả thresholds pass → exit 0)
```

### 7.2 Phân tích timing chi tiết cho confirm_hotkey

```text
T=0.000s: k6 scheduler khởi động 8 VUs
T=0.001s: 8 VUs bắt đầu thực thi confirmHotkey(data)
T=0.002s: 8 HTTP requests được gửi đi (không blocking)
T=0.005s: 8 requests đến Nginx :80
T=0.006s: Nginx forward 8 requests đến order-service instances
          (có thể cùng instance hoặc khác instance)
T=0.007s: 8 requests đến order-service handlers
T=0.008s: 8 Redis SETNX commands được gửi
T=0.009s: Redis xử lý tuần tự → 1 được 1, 7 được 0
T=0.010s: VU fresh bắt đầu external call (240ms)
T=0.250s: VU fresh hoàn thành external call + DB write
T=0.255s: VU fresh trả về response → idempotency_reuse=false
T=0.010-0.260s: 7 VU reuse đợi (poll Redis GET hoặc block)
T=0.260s: 7 VU reuse nhận kết quả từ Redis → trả về response
T=0.270s: Tất cả 8 responses về đến k6
T=0.280s: k6 checks hoàn thành → counters được ghi nhận
```

### 7.3 Phân tích timing chi tiết cho webhook_hotkey

```text
T=4.000s: k6 scheduler khởi động 8 VUs (startTime=4s)
T=4.001s: 8 VUs bắt đầu thực thi webhookHotkey(data)
T=4.005s: 8 HTTP POST webhook requests đến Nginx
T=4.008s: 8 Redis EVAL scripts được gửi (SISMEMBER + SADD atomic)
T=4.009s: Redis xử lý tuần tự → 1 được FRESH, 7 được DUPLICATE
T=4.015s: VU fresh hoàn thành DB write
T=4.020s: VU fresh trả về response → webhook_duplicate=false
T=4.020s: 7 VU duplicate trả về response → webhook_duplicate=true
T=4.025s: Tất cả 8 VU gửi GET order status
T=4.030s: Tất cả status responses về → payment_status=paid, source=webhook
T=4.040s: k6 checks hoàn thành → counters được ghi nhận
```

### 7.4 State machine cho hot-key race

```text
                    8 VUs đồng thời gửi request
                              │
                              ▼
                    ┌─────────────────────┐
                    │  Redis SETNX / EVAL  │
                    │  (atomic check)      │
                    └──────────┬──────────┘
                               │
               ┌───────────────┴───────────────┐
               │                               │
               ▼                               ▼
      ┌──────────────┐                ┌──────────────┐
      │  VU THẮNG    │                │  7 VU THUA   │
      │  (FRESH)     │                │  (REUSE/     │
      │              │                │   DUPLICATE) │
      └──────┬───────┘                └──────┬───────┘
             │                               │
             ▼                               ▼
      ┌──────────────┐                ┌──────────────┐
      │  Thực thi    │                │  Đợi kết quả │
      │  business    │                │  từ Redis     │
      │  logic       │                │  (poll GET)   │
      │  - external  │                │               │
      │  - DB write  │                │               │
      └──────┬───────┘                └──────┬───────┘
             │                               │
             ▼                               ▼
      ┌──────────────┐                ┌──────────────┐
      │  Lưu kết quả │                │  Nhận kết quả│
      │  vào Redis   │                │  (idempotency│
      │              │                │   _reuse=true│
      └──────┬───────┘                │   hoặc       │
             │                        │   webhook_   │
             │                        │   duplicate= │
             │                        │   true)      │
             │                        └──────┬───────┘
             │                               │
             └───────────────┬───────────────┘
                             │
                             ▼
                    ┌─────────────────────┐
                    │  Tất cả 8 VUs:      │
                    │  - Nhận 200 OK      │
                    │  - Status đúng      │
                    │  - Nhưng chỉ 1 VU   │
                    │    thực sự làm việc │
                    └─────────────────────┘
```

---

## 8. Key signals / counters cần verify

### 8.1 Bảng custom counters -- CỐT LÕI CỦA CASE

Đây là bảng quan trọng nhất. **Mọi quyết định pass/fail đều dựa trên các counter này:**

| Counter | Expected (HOTKEY_VUS=8) | Ý nghĩa nếu đúng | Ý nghĩa nếu sai |
| --- | --- | --- | --- |
| `confirm_fresh_count` | **1** | Chỉ 1 VU thực sự thực thi confirm | Nếu >1: atomicity fail -- duplicate side effect |
| `confirm_reuse_count` | **7** | 7 VU còn lại replay kết quả | Nếu <7: có VU không nhận được replay |
| `webhook_fresh_count` | **1** | Chỉ 1 VU thực sự apply webhook | Nếu >1: dedupe fail -- payment bị apply nhiều lần |
| `webhook_duplicate_count` | **7** | 7 VU còn lại bị dedupe | Nếu <7: có VU không được dedupe |
| `hotkey_check_failures` | **0** | Không có check failure nào | Nếu >0: có ít nhất 1 check thất bại |

### 8.2 Bảng breakdown verification

| Check | Fresh path | Reuse/Duplicate path |
| --- | --- | --- |
| `external_ms` | `>= CONFIRM_EXTERNAL_MS` (vd: >= 240) | `== 0` |
| `db_write_ms` | Present (>0) | `== 0` hoặc cleared |
| `confirmed_at` | Present (timestamp mới) | Present (giống fresh) |
| `processed_at` | Present (timestamp mới) | Present (giống fresh) |

### 8.3 Bảng body flags

| Flag | Fresh confirm | Reuse confirm | Fresh webhook | Duplicate webhook |
| --- | --- | --- | --- | --- |
| `idempotency_reuse` | `false` | `true` | N/A | N/A |
| `webhook_duplicate` | N/A | N/A | `false` | `true` |
| `payment_status` | N/A | N/A | `paid` | `paid` |
| `payment_state_source` | N/A | N/A | `webhook` | `webhook` |

### 8.4 Evidence phải đọc

| Evidence | Expected default |
| --- | ---: |
| `checks` | 100% |
| `http_req_failed` | 0.00% |
| `order_service_shared_state_hotkey_check_failures` | 0 |
| `order_service_shared_state_hotkey_confirm_fresh_count` | 1 |
| `order_service_shared_state_hotkey_confirm_reuse_count` | 7 nếu `HOTKEY_VUS=8` |
| `order_service_shared_state_hotkey_webhook_fresh_count` | 1 |
| `order_service_shared_state_hotkey_webhook_duplicate_count` | 7 nếu `HOTKEY_VUS=8` |
| `X-Upstream-Service` | `order-service` |
| `X-Upstream-Addr` | present |

### 8.5 Fresh vs reuse khác nhau thế nào?

Fresh confirm path phải có work thật:

```text
external_ms >= ORDER_SHARED_STATE_HOTKEY_CONFIRM_EXTERNAL_MS
breakdown db_write_ms present
```

Reuse confirm path phải không làm lại work:

```text
external_ms = 0
db_write_ms = 0
```

Webhook tương tự: fresh có DB write, duplicate không DB write.

### 8.6 Bảng latency so sánh (dữ liệu tham khảo)

| Metric | Fresh (avg) | Reuse/Duplicate (avg) | Tỉ lệ |
| --- | --- | --- | --- |
| `confirm_duration` | ~260ms | ~10ms | ~26x |
| `webhook_duration` | ~20ms | ~5ms | ~4x |
| `status_duration` | N/A (giống nhau) | N/A (giống nhau) | ~1x |

Fresh path luôn chậm hơn vì có external call (confirm) hoặc DB write (webhook). Tỉ lệ chênh lệch càng lớn càng chứng tỏ reuse/duplicate path thực sự bỏ qua work.

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Case được coi là PASS khi **tất cả** các điều kiện sau đều đúng:

| # | Tiêu chí | Cách xác minh | Định lượng |
| --- | --- | --- | --- |
| 1 | k6 exit code = 0 | `$LASTEXITCODE` | `exit 0` |
| 2 | Tất cả checks pass | k6 output: `checks... 100%` | `checks rate = 1.0` |
| 3 | `http_req_failed = 0` | k6 output | `rate==0` |
| 4 | `hotkey_check_failures = 0` | Custom counter | `count==0` |
| 5 | `confirm_fresh_count = 1` | Custom counter | `count==1` |
| 6 | `confirm_reuse_count = VUS-1` | Custom counter | `count==7` khi `HOTKEY_VUS=8` |
| 7 | `webhook_fresh_count = 1` | Custom counter | `count==1` |
| 8 | `webhook_duplicate_count = VUS-1` | Custom counter | `count==7` khi `HOTKEY_VUS=8` |
| 9 | Fresh confirm có `external_ms >= threshold` và `db_write_ms present` | Check trong output | Breakdown đúng |
| 10 | Reuse confirm có `external_ms = 0` và `db_write_ms = 0` | Check trong output | Breakdown cleared |
| 11 | Fresh webhook có `db_write_ms present` | Check trong output | Có DB write |
| 12 | Duplicate webhook có `db_write_ms = 0` | Check trong output | Không DB write |
| 13 | Status sau webhook: `payment_status=paid`, `source=webhook` (tất cả VU) | Check trong output | State nhất quán |

### 9.2 Tiêu chí FAIL

Case FAIL khi **bất kỳ** điều kiện nào sau đây xảy ra:

| # | Dấu hiệu FAIL | Nguyên nhân khả dĩ | Cách debug |
| --- | --- | --- | --- |
| A | `confirm_fresh_count > 1` | Race bug: nhiều request cùng thực hiện side effect confirm | Kiểm tra SETNX/Lua script implementation |
| B | `confirm_reuse_count < HOTKEY_VUS-1` | Dedupe/replay thiếu request | Có VU bị lỗi? Timeout? |
| C | `webhook_fresh_count > 1` | Payment webhook có thể apply nhiều lần | Kiểm tra SISMEMBER+SADD atomicity |
| D | `webhook_duplicate_count < HOTKEY_VUS-1` | Webhook dedupe không ổn định | Lua script không atomic? |
| E | Status 200 toàn bộ nhưng counter sai | Đây vẫn là fail; status không chứng minh side effect | Đọc counters, không chỉ status |
| F | `http_req_failed > 0` | Không expected ở case này; cần debug app/Redis/LB | Kiểm tra timeout, network |
| G | `hotkey_check_failures > 0` | Có check failure | Đọc check names để xác định stage |
| H | Reuse path có `external_ms > 0` hoặc `db_write_ms > 0` | "Fake idempotency" -- hệ thống báo reuse nhưng vẫn làm work | Breakdown implementation sai |
| I | Status read thấy `payment_status != paid` | Payment state không được apply hoặc bị sai | Kiểm tra Redis hash state |

### 9.3 Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| `confirm_fresh_count > 1` | Race bug: nhiều request cùng thực hiện side effect confirm. |
| `confirm_reuse_count < HOTKEY_VUS-1` | Dedupe/replay thiếu request. |
| `webhook_fresh_count > 1` | Payment webhook có thể apply nhiều lần. |
| `webhook_duplicate_count < HOTKEY_VUS-1` | Webhook dedupe không ổn định. |
| Status 200 toàn bộ nhưng counter sai | Đây vẫn là fail; status không chứng minh side effect. |
| `http_req_failed > 0` | Không expected ở case này; cần debug app/Redis/LB. |

### 9.4 Cách đọc kết quả FAIL chi tiết

Giả sử k6 output có:

```text
✗ confirm_fresh_count threshold: count==1, got 3
✗ confirm_reuse_count threshold: count==7, got 5
```

Phân tích:

1. `confirm_fresh_count = 3` → 3 VU đã thực thi fresh confirm
2. `confirm_reuse_count = 5` → chỉ 5 VU được replay (và 3 VU fresh = 8 VU total)
3. Nguyên nhân: 3 VU cùng thấy "key chưa tồn tại" → cả 3 cùng SETNX thành công → cả 3 cùng thực thi
4. Điều này có nghĩa SETNX không atomic hoặc có race window giữa check và set

Hành động: Kiểm tra Redis command được dùng. Nếu dùng 2 commands riêng (`EXISTS` rồi `SET`), thay bằng `SET key value EX ttl NX` hoặc Lua script.

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy

```powershell
# 1. Di chuyển đến thư mục gốc
cd E:\Projects\k6\k6-metrics-server

# 2. Set biến môi trường
$env:BASE_URL = "http://localhost:80"
$env:ORDER_SHARED_STATE_HOTKEY_VUS = "8"

# 3. Chạy script
k6 run .\load-target\k6\app\16-order-service-shared-state-hotkey-race.js
```

### 10.2 Output mẫu mong đợi (PASS)

```text
         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: .\load-target\k6\app\16-order-service-shared-state-hotkey-race.js
     output: -

  scenarios: (100.00%) 2 scenarios, 16 max VUs, 1m30s max duration (incl. graceful stop):
           * confirm_hotkey: 1 iterations for each of 8 VUs (maxDuration: 1m0s, startTime: 0s)
           * webhook_hotkey: 1 iterations for each of 8 VUs (maxDuration: 1m0s, startTime: 4s)


     data_received..................: 45 kB   ...
     data_sent......................: 18 kB   ...
     http_req_blocked...............: avg=0.20ms  ...
     http_req_connecting............: avg=0.10ms  ...
     http_req_duration..............: avg=45.00ms ...
     http_req_receiving.............: avg=0.10ms  ...
     http_req_sending...............: avg=0.02ms  ...
     http_req_waiting...............: avg=44.88ms ...
     http_reqs......................: 24      ...
     iteration_duration.............: avg=0.28s   ...
     iterations.....................: 16       ...
     vus............................: 8        ...
     vus_max........................: 16       ...


█ checks...
  ✓ confirm hotkey upstream service order-service (8/8)
  ✓ confirm hotkey upstream addr present (8/8)
  ✓ confirm hotkey status 200 (8/8)
  ✓ confirm hotkey success true (8/8)
  ✓ confirm hotkey order id preserved (8/8)
  ✓ confirm hotkey idempotency key preserved (8/8)
  ✓ confirm hotkey confirmed_at present (8/8)
  ✓ confirm hotkey fresh breakdown external_ms >= 240 (1/1)
  ✓ confirm hotkey fresh breakdown db_write_ms present (1/1)
  ✓ confirm hotkey reuse breakdown external_ms cleared (7/7)
  ✓ confirm hotkey reuse breakdown db_write_ms cleared (7/7)
  ✓ webhook hotkey upstream service order-service (8/8)
  ✓ webhook hotkey upstream addr present (8/8)
  ✓ webhook hotkey status 200 (8/8)
  ✓ webhook hotkey success true (8/8)
  ✓ webhook hotkey event type preserved (8/8)
  ✓ webhook hotkey event id preserved (8/8)
  ✓ webhook hotkey order id preserved (8/8)
  ✓ webhook hotkey processed_at present (8/8)
  ✓ webhook hotkey payment status paid (8/8)
  ✓ webhook hotkey fresh breakdown db_write_ms present (1/1)
  ✓ webhook hotkey duplicate breakdown db_write_ms cleared (7/7)
  ✓ status after webhook hotkey status 200 (8/8)
  ✓ status after webhook hotkey success true (8/8)
  ✓ status after webhook hotkey order id preserved (8/8)
  ✓ status after webhook hotkey payment status paid (8/8)
  ✓ status after webhook hotkey payment event captured (8/8)
  ✓ status after webhook hotkey source webhook (8/8)

   ✓ checks........................: 100.00% ✓ 160  ✗ 0
     ✓ { scenario:order_service_shared_state_hotkey_race }...: 100.00% ✓ 160  ✗ 0

  ✓ http_req_failed................: 0.00%  ✓ 0    ✗ 24
  ✓ order_service_shared_state_hotkey_check_failures...: 0
  ✓ order_service_shared_state_hotkey_confirm_fresh_count...: 1
  ✓ order_service_shared_state_hotkey_confirm_reuse_count...: 7
  ✓ order_service_shared_state_hotkey_webhook_fresh_count...: 1
  ✓ order_service_shared_state_hotkey_webhook_duplicate_count...: 7


running (00m05.0s), 0/16 VUs, 16 complete and 0 interrupted iterations
confirm_hotkey ✓ [===================================] 8 VUs  00m00.3s/1m0s  8/8 iters, 1 per VU
webhook_hotkey ✓ [===================================] 8 VUs  00m00.3s/1m0s  8/8 iters, 1 per VU
```

**Đọc output:**

- `confirm hotkey fresh breakdown ... (1/1)` → chỉ 1 VU chạy fresh check → confirm_fresh_count=1
- `confirm hotkey reuse breakdown ... (7/7)` → 7 VU chạy reuse check → confirm_reuse_count=7
- `webhook hotkey fresh breakdown ... (1/1)` → chỉ 1 VU chạy fresh check → webhook_fresh_count=1
- `webhook hotkey duplicate breakdown ... (7/7)` → 7 VU chạy duplicate check → webhook_duplicate_count=7
- Tất cả 6 thresholds pass (dấu ✓ ở đầu dòng)

### 10.3 Output mẫu khi FAIL (race bug)

```text
█ checks...
  ✓ confirm hotkey status 200 (8/8)
  ✓ confirm hotkey fresh breakdown external_ms >= 240 (3/3)   ← 3 VU fresh! (SAI)
  ✓ confirm hotkey reuse breakdown external_ms cleared (5/5)  ← 5 VU reuse (SAI)

  ✗ order_service_shared_state_hotkey_confirm_fresh_count...: 3 (expected 1)
  ✗ order_service_shared_state_hotkey_confirm_reuse_count...: 5 (expected 7)

ERRO[0005] thresholds on metrics were crossed
```

Phân tích:
- 3 VU fresh (expected 1) → atomicity fail
- 5 VU reuse (expected 7) → không đủ
- 3 + 5 = 8 VU → tất cả VU đều OK, nhưng phân phối fresh/reuse sai
- Đây là race bug: SETNX không atomic hoặc có race window

---

## 11. 4 output → decision scenarios

### Scenario 1: ALL PASS

```text
✓ checks 100%
✓ confirm_fresh_count = 1, confirm_reuse_count = 7
✓ webhook_fresh_count = 1, webhook_duplicate_count = 7
✓ Tất cả thresholds pass
```

**Kết luận:** Redis atomicity hoạt động chính xác. Dù 8 request đến đồng thời, chỉ 1 request được thực thi. Hệ thống an toàn trước retry storm.

**Quyết định:** Triển khai production với confidence cao. Có thể scale order-service instances mà không lo race condition.

### Scenario 2: confirm_fresh_count = 2 (hoặc hơn)

```text
✗ confirm_fresh_count = 2 (expected 1)
✗ confirm_reuse_count = 6 (expected 7)
✓ webhook OK
```

**Phân tích:**
- Webhook atomic → Redis và Lua script hoạt động
- Confirm không atomic → vấn đề nằm ở confirm idempotency implementation, không phải Redis

**Nguyên nhân khả dĩ:**
1. Confirm dùng `EXISTS` + `SET` thay vì `SETNX` → race window giữa 2 commands
2. Confirm dùng distributed lock nhưng lock timeout quá ngắn → 2 VU cùng acquire lock
3. Two-phase commit không atomic

**Quyết định:**
- **Nguy hiểm:** Mỗi retry storm có thể tạo duplicate order
- Fix ngay: thay `EXISTS` + `SET` bằng `SET key value EX ttl NX`
- Thêm alert: nếu `confirm_fresh_count > 1` trong production → incident

### Scenario 3: webhook_duplicate_count = 0

```text
✓ confirm OK
✗ webhook_fresh_count = 8 (expected 1)
✗ webhook_duplicate_count = 0 (expected 7)
```

**Phân tích:**
- Tất cả 8 VU đều thấy `webhook_duplicate=false` → dedupe hoàn toàn không hoạt động
- Mỗi VU đều thực thi DB write

**Nguyên nhân khả dĩ:**
1. Webhook dedupe không được implement (thiếu SISMEMBER check)
2. Mỗi request tạo event_id khác nhau (script bug -- dùng `Date.now()` trong mỗi VU thay vì từ `setup()`)
3. Redis set bị xóa giữa các request (TTL quá ngắn hoặc manual delete)

**Quyết định:**
- **Cực kỳ nguy hiểm:** Mỗi webhook retry tạo duplicate payment → incident tài chính
- Dừng triển khai, fix webhook dedupe ngay
- Verify event_id từ `setup()` được share đúng qua tất cả VU

### Scenario 4: http_req_failed > 0

```text
✗ http_req_failed = 12.5% (3/24 requests failed)
✗ Một số VUs timeout hoặc nhận 503
```

**Phân tích:**
- Không phải lỗi correctness -- là lỗi infrastructure
- Một số VU không nhận được response → counters có thể thấp hơn expected

**Nguyên nhân khả dĩ:**
1. Timeout quá ngắn so với external delay (240ms) + retry
2. Redis quá tải → connection timeout
3. order-service instances không đủ để xử lý 8 concurrent requests

**Quyết định:**
- Tăng timeout hoặc giảm `HOTKEY_VUS`
- Kiểm tra Redis connection pool size
- Scale order-service instances

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Tất cả request đều 200 → hệ thống đúng"

```text
Sai:    "8 request, 8 status 200 → idempotency hoạt động"
Đúng:   8 status 200 nhưng confirm_fresh_count=8 → TẤT CẢ đều tạo side effect.
        Status 200 không chứng minh atomicity.
```

Đây là misconception **nguy hiểm nhất** trong toàn bộ Redis series. Một hệ thống không có idempotency vẫn trả về 200 cho mọi request -- nhưng mỗi request đều tạo ra một order mới. Chỉ counters mới nói lên sự thật.

### Nghịch lý 2: "8 VU concurrent luôn tạo race -- nếu không thấy race thì test sai"

```text
Sai:    "Nếu confirm_fresh_count=1, tức là các request đến tuần tự, không phải race"
Đúng:   confirm_fresh_count=1 là KẾT QUẢ MONG MUỐN của atomicity, không phải dấu hiệu
        test không tạo race. Redis đã collapse race thành 1 fresh + 7 reuse.
```

**Giải thích:** Mục tiêu không phải là "tạo ra race và thấy hệ thống fail", mà là "tạo ra race và thấy hệ thống xử lý đúng". `confirm_fresh_count=1` chứng minh atomicity hoạt động, không phải test thiếu race.

### Nghịch lý 3: "Nếu Redis nhanh thì không cần atomicity"

```text
Sai:    "Redis nhanh (sub-ms) nên xác suất race rất thấp, không cần SETNX"
Đúng:   Xác suất thấp != không thể xảy ra. Trên production với millions of requests,
        xác suất 0.01% vẫn có nghĩa là hàng trăm duplicate orders mỗi ngày.
```

**Tính toán thực tế:**
- 1 triệu order/ngày, 5% retry rate = 50,000 retry
- Nếu không atomic: 0.1% retry bị race = 50 duplicate orders/ngày
- 50 duplicate orders x 365 ngày = 18,250 duplicate orders/năm
- Mỗi duplicate order có thể tốn $10-$1000 để hoàn tiền + customer service

### Nghịch lý 4: "Cần nhiều VU hơn để test race tốt hơn"

```text
Sai:    "8 VU không đủ, cần 100 VU mới tạo race thật"
Đúng:   Với per-vu-iterations, 8 VU khởi động đồng thời đủ để tạo race.
        Tăng VU chỉ làm tăng reuse/duplicate count, không thay đổi bản chất test.
```

**Giải thích:** Mục tiêu là "exactly 1 fresh", không phải "nhiều fresh nhất có thể". 8 VU concurrent đủ để chứng minh atomicity. Nếu muốn test extreme case, có thể tăng `HOTKEY_VUS` lên 20, 50, hoặc 100, nhưng expected vẫn là `confirm_fresh_count=1`.

### Nghịch lý 5: "webhook_hotkey startTime=4s là thừa"

```text
Sai:    "Có thể chạy confirm và webhook cùng lúc để tiết kiệm thời gian"
Đúng:   Nếu confirm và webhook chạy cùng lúc, có thể xảy ra race giữa confirm
        và webhook (cùng order) -- không phải mục tiêu test của case này.
```

**Giải thích:** Mục tiêu là test race giữa các request CÙNG LOẠI (cùng confirm key, hoặc cùng event_id). Race giữa confirm và webhook là một bài test khác (cross-operation race). `startTime=4s` đảm bảo confirm đã xong trước khi webhook bắt đầu.

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=order-service"` | Có ít nhất 2 container | Khởi động stack |
| 2 | Redis đang chạy | `docker ps --filter "name=redis"` | Có container Redis | Khởi động stack |
| 3 | Public path hoạt động | `curl http://localhost:80/health` | HTTP 200 | Kiểm tra config |
| 4 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại |
| 5 | `TargetLayer` đúng | Kiểm tra cách stack được khởi động | `full-no-cdn` | Khởi động lại |
| 6 | Không có stale data | Không cần (setup() tạo key mới) | N/A | N/A |
| 7 | Không có test khác đang chạy | `docker stats --no-stream` | Chỉ có stack services | Đợi |

### 13.2 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 8 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\app\16-order-service-shared-state-hotkey-race.js"` |
| 9 | `HOTKEY_VUS` được set (nếu muốn khác 8) | `$env:ORDER_SHARED_STATE_HOTKEY_VUS = "8"` |
| 10 | API endpoints hoạt động | Test thủ công POST confirm và webhook |
| 11 | `OPS_AUTH_TOKEN` không cần cho case này | Case này không gọi control plane |

### 13.3 K6 checklist

| # | Mục kiểm tra |
| --- | --- |
| 12 | k6 đã được cài đặt: `k6 version` |
| 13 | Không có biến môi trường conflict (`K6_*` env vars) |
| 14 | Terminal/CI có đủ timeout (script chạy ~5-10 giây) |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Tăng số lượng VUs

```javascript
// Variation 1: Stress test với nhiều VUs hơn
// Set ORDER_SHARED_STATE_HOTKEY_VUS=50

// Expected:
//   confirm_fresh_count = 1
//   confirm_reuse_count = 49
//   webhook_fresh_count = 1
//   webhook_duplicate_count = 49

// Thresholds tự động điều chỉnh theo HOTKEY_VUS:
//   confirm_reuse_count: count==${Math.max(HOTKEY_VUS - 1, 0)}
//   webhook_duplicate_count: count==${Math.max(HOTKEY_VUS - 1, 0)}
```

**Điểm học:** Dù 50 VU hay 500 VU, expected vẫn là `fresh=1`. Đây là bản chất của atomicity.

### Variation 2: Thêm delay vào reuse path

```javascript
// Variation 2: Custom check để xác nhận reuse path nhanh hơn fresh path
// Thêm vào confirmHotkey():

const duration = result.response.timings.duration;

if (reuse) {
  confirmReuseCount.add(1);
  confirmReuseDuration.add(duration, { stage: 'confirm_reuse' });

  // Thêm check: reuse phải nhanh hơn ngưỡng
  check(result, {
    'confirm reuse duration under 50ms': () => duration < 50,
  });
} else {
  confirmFreshCount.add(1);
  confirmFreshDuration.add(duration, { stage: 'confirm_fresh' });

  // Thêm check: fresh phải chậm hơn ngưỡng (do external delay)
  check(result, {
    'confirm fresh duration above 200ms': () => duration > 200,
  });
}
```

**Điểm học:** Fresh path luôn chậm hơn reuse path. Nếu reuse path cũng chậm tương đương fresh path → có thể hệ thống vẫn đang thực thi business logic (dù báo `idempotency_reuse=true`).

### Variation 3: Concurrent confirm + webhook (cross-operation race)

```javascript
// Variation 3: Cross-operation race -- confirm và webhook cùng lúc
// Sửa options: bỏ startTime của webhook_hotkey

export const options = {
  scenarios: {
    confirm_hotkey: {
      executor: 'per-vu-iterations',
      exec: 'confirmHotkey',
      vus: 8,
      iterations: 1,
      // Không set startTime → bắt đầu ngay
    },
    webhook_hotkey: {
      executor: 'per-vu-iterations',
      exec: 'webhookHotkeyCross',
      vus: 8,
      iterations: 1,
      // KHÔNG startTime → chạy CÙNG LÚC với confirm
    },
  },
};

// Hàm webhookHotkeyCross cần dùng chung orderId với confirm
// để tạo race giữa confirm và webhook trên cùng order
export function webhookHotkeyCross(data) {
  // Dùng data từ setup() nhưng phải share orderId với confirm
  // Đây là advanced test: xác nhận hệ thống xử lý đúng khi
  // confirm và webhook đến đồng thời
}
```

**Điểm học:** Đây là cross-operation race test, khó hơn case 02. Mục tiêu: confirm và webhook cho cùng order đến đồng thời → hệ thống phải xử lý tuần tự hoặc atomic.

### Variation 4: Custom breakdown assertion

```javascript
// Variation 4: Assert chi tiết từng trường trong breakdown
// Thêm vào confirmHotkey():

const breakdown = result.payload.performance.breakdown;

if (reuse) {
  check(result, {
    'reuse cpu_ms still present': () => Number(breakdown.cpu_ms || 0) > 0,
    // CPU vẫn dùng để parse request, JSON decode, Redis GET
    'reuse external_ms zero': () => Number(breakdown.external_ms || 0) === 0,
    'reuse db_write_ms zero': () => Number(breakdown.db_write_ms || 0) === 0,
    'reuse db_read_ms may be present': () => true, // DB read để lấy thông tin order
  });
} else {
  check(result, {
    'fresh cpu_ms present': () => Number(breakdown.cpu_ms || 0) > 0,
    'fresh external_ms meets minimum': () => Number(breakdown.external_ms || 0) >= 240,
    'fresh db_write_ms present': () => Object.prototype.hasOwnProperty.call(breakdown, 'db_write_ms'),
    'fresh db_read_ms may be present': () => true,
  });
}
```

**Điểm học:** Breakdown metrics cung cấp insight chi tiết về từng phần của quá trình xử lý. CPU vẫn được dùng cho cả fresh và reuse path (parse request, JSON), nhưng external và DB write chỉ có ở fresh path.

### Variation 5: Verify Redis keys sau khi chạy

```javascript
// Variation 5: Sau khi chạy, verify Redis keys tồn tại
// Thêm teardown() function:

export function teardown(data) {
  // Gọi API để kiểm tra Redis keys (nếu có endpoint debug)
  const checkKey = http.get(
    `${BASE_URL}/api/sim/orders/${data.confirmOrderId}/debug/redis-keys`
  );

  const keys = checkKey.json();
  check(keys, {
    'idempotency key exists in Redis': (k) => k.idempotency_key_exists === true,
    'idempotency key has TTL': (k) => k.idempotency_key_ttl > 0,
    'webhook events set exists': (k) => k.webhook_events_set_exists === true,
    'webhook event_id in set': (k) => k.webhook_event_in_set === true,
  });
}
```

**Điểm học:** Sau khi tất cả VU hoàn thành, Redis phải chứa state đúng: idempotency key với kết quả, webhook event set với event_id đã xử lý. Đây là "post-mortem" verification.

---

## 15. Anti-patterns

### Anti-pattern 1: Chỉ đọc status, bỏ qua counters

```javascript
// SAI -- anti-pattern
// "Tất cả request đều 200, vậy pass"

// ĐÚNG
// Phải đọc confirm_fresh_count, confirm_reuse_count,
// webhook_fresh_count, webhook_duplicate_count
```

Hậu quả: Hệ thống có thể đang tạo duplicate side effect nhưng tất cả request vẫn 200 → false PASS.

### Anti-pattern 2: Dùng `constant-vus` thay vì `per-vu-iterations`

```javascript
// SAI -- anti-pattern
export const options = {
  scenarios: {
    confirm_hotkey: {
      executor: 'constant-vus',
      vus: 8,
      duration: '10s',
    },
  },
};
// Request trải đều trong 10s → không tạo race đồng thời

// ĐÚNG
export const options = {
  scenarios: {
    confirm_hotkey: {
      executor: 'per-vu-iterations',
      vus: 8,
      iterations: 1,  // Mỗi VU 1 request, tất cả đồng thời
    },
  },
};
```

Hậu quả: Request đến tuần tự → không có race → `confirm_fresh_count=1` không phải vì atomicity mà vì không có concurrent request. False PASS.

### Anti-pattern 3: Tạo key mới trong mỗi VU

```javascript
// SAI -- anti-pattern
export function confirmHotkey() {
  const myKey = `idem-${Date.now()}-${__VU}`;  // MỖI VU CÓ KEY RIÊNG!
  const result = postConfirm(orderId, myKey);
  // Tất cả VU đều fresh → không test được race
}

// ĐÚNG
export function confirmHotkey(data) {
  const result = postConfirm(data.confirmOrderId, data.confirmKey);
  // Tất cả VU dùng CHUNG key từ setup() → RACE THẬT
}
```

Hậu quả: Mỗi VU có key riêng → mỗi VU đều fresh → `confirm_fresh_count=8` → tưởng là race bug nhưng thực ra là script bug.

### Anti-pattern 4: Không set `noConnectionReuse`

```javascript
// SAI -- anti-pattern
export const options = {
  scenarios: { ... },
  // Thiếu: noConnectionReuse: true
};

// ĐÚNG
export const options = {
  noConnectionReuse: true,
  scenarios: { ... },
};
```

Hậu quả: Request từ nhiều VU có thể bị dồn vào cùng một TCP connection → giảm tính concurrent của test.

### Anti-pattern 5: Quên set thresholds cho counters

```javascript
// SAI -- anti-pattern
export const options = {
  thresholds: {
    checks: ['rate==1'],  // Chỉ check checks, không check counters!
  },
};

// ĐÚNG
export const options = {
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    order_service_shared_state_hotkey_check_failures: ['count==0'],
    order_service_shared_state_hotkey_confirm_fresh_count: ['count==1'],
    order_service_shared_state_hotkey_confirm_reuse_count: ['count==7'],
    order_service_shared_state_hotkey_webhook_fresh_count: ['count==1'],
    order_service_shared_state_hotkey_webhook_duplicate_count: ['count==7'],
  },
};
```

Hậu quả: Checks pass nhưng counters sai → k6 vẫn exit 0 → CI xanh → false PASS.

---

## 16. Real validation data

### 16.1 Dữ liệu xác thực từ case catalog

```json
{
  "id": "redis-02-hotkey-race",
  "script": "../app/16-order-service-shared-state-hotkey-race.js",
  "title": "Hot-key idempotency race",
  "businessCase": "Many clients retry the same order confirmation key and webhook event at the same time during a payment or mobile-client retry storm.",
  "whatItTeaches": "Redis locking and shared idempotency records should collapse concurrent duplicates into one fresh execution plus reuses/duplicates.",
  "run": {
    "env": {
      "BASE_URL": "http://localhost:80",
      "ORDER_SHARED_STATE_HOTKEY_VUS": "8"
    }
  },
  "calls": [
    {
      "operation": "confirm_hotkey",
      "method": "POST",
      "path": "/api/sim/orders/{orderId}/confirm",
      "expectedStatus": 200,
      "stateExpectation": "exactly one fresh confirm and the rest reuse"
    },
    {
      "operation": "webhook_hotkey",
      "method": "POST",
      "path": "/api/sim/orders/webhooks/payment",
      "expectedStatus": 200,
      "stateExpectation": "exactly one fresh webhook and the rest duplicate"
    }
  ],
  "expected": {
    "customMetrics": [
      "order_service_shared_state_hotkey_check_failures count==0",
      "order_service_shared_state_hotkey_confirm_fresh_count count==1",
      "order_service_shared_state_hotkey_confirm_reuse_count count==HOTKEY_VUS-1",
      "order_service_shared_state_hotkey_webhook_fresh_count count==1",
      "order_service_shared_state_hotkey_webhook_duplicate_count count==HOTKEY_VUS-1"
    ],
    "signals": [
      "fresh path has DB/write work",
      "reuse/duplicate path avoids repeated side effects"
    ]
  }
}
```

### 16.2 Dữ liệu latency điển hình (local Docker, HOTKEY_VUS=8)

| Metric | Fresh (avg, 1 sample) | Reuse/Duplicate (avg, 7 samples) | Tỉ lệ |
| --- | --- | --- | --- |
| `confirm_duration` | ~265ms | ~8ms | ~33x |
| `confirm_fresh_duration` | ~265ms | -- | -- |
| `confirm_reuse_duration` | -- | ~8ms | -- |
| `webhook_duration` | ~18ms | ~4ms | ~4.5x |
| `webhook_fresh_duration` | ~18ms | -- | -- |
| `webhook_duplicate_duration` | -- | ~4ms | -- |
| `status_duration` | ~6ms | ~6ms | ~1x |

### 16.3 Dữ liệu counter cho các giá trị HOTKEY_VUS khác nhau

| HOTKEY_VUS | confirm_fresh | confirm_reuse | webhook_fresh | webhook_duplicate | Total VUs |
| --- | --- | --- | --- | --- | --- |
| 4 | 1 | 3 | 1 | 3 | 8 |
| 8 | 1 | 7 | 1 | 7 | 16 |
| 16 | 1 | 15 | 1 | 15 | 32 |
| 32 | 1 | 31 | 1 | 31 | 64 |

Pattern: `fresh_count = 1`, `reuse/duplicate_count = HOTKEY_VUS - 1`. Luôn luôn.

### 16.4 Dữ liệu checks count cho HOTKEY_VUS=8

| Phase | Checks per VU | Số VU | Tổng checks |
| --- | --- | --- | --- |
| confirm cơ bản (status, success, order_id, key, confirmed_at) | 5 | 8 | 40 |
| confirm upstream (service + addr) | 2 | 8 | 16 |
| confirm fresh breakdown (external_ms + db_write_ms) | 2 | 1 | 2 |
| confirm reuse breakdown (external_ms + db_write_ms) | 2 | 7 | 14 |
| webhook cơ bản (status, success, event_type, event_id, order_id, processed_at, payment_status) | 7 | 8 | 56 |
| webhook upstream | 2 | 8 | 16 |
| webhook fresh breakdown | 1 | 1 | 1 |
| webhook duplicate breakdown | 1 | 7 | 7 |
| status after webhook (status, success, order_id, payment_status, event_type, source) | 6 | 8 | 48 |
| **Tổng** | | | **200** |

---

## 17. Reference

### 17.1 Source files

| File | Đường dẫn |
| --- | --- |
| Script chính | `E:\Projects\k6\k6-metrics-server\load-target\k6\app\16-order-service-shared-state-hotkey-race.js` |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\redis\case-catalog.json` |
| Overview Redis series | `E:\Khoa hoc\k6\docs\practice\redis\00_overview.md` |
| Shared helper | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` |

### 17.2 Related cases

| Case | Mối liên hệ |
| --- | --- |
| `redis-01-shared-state-distributed` | Case nền tảng: sequential state proof qua nhiều instances. Case 02 mở rộng lên concurrent. |
| `redis-03-claim-owner-abandon` | Cũng dùng Redis lock/claim nhưng cho TTL takeover, không phải hot-key race. |
| `redis-04-redis-degrade` | Case 02 + Redis delay. Counters vẫn exact nhưng latency tăng. |
| `redis-05-hotkey-fairness` | Mở rộng: hot key race + normal keys trong cùng test. Hot key không được starve normal keys. |

### 17.3 Layer roadmap context

```text
Layer 1: CDN/Varnish → cache correctness
Layer 2: LB/Gateway → routing correctness
Layer 3: Redis/Shared State → atomicity + consistency
  ├── Case 01: Sequential distributed proof
  ├── Case 02: Concurrent atomicity proof ← CASE NÀY
  ├── Case 03: Claim TTL takeover
  ├── Case 04: Degraded Redis atomicity
  ├── Case 05: Hot-key fairness
  └── Case 06: Cache hot/cold toggle
```

### 17.4 Concepts cần nắm vững

| Concept | Định nghĩa ngắn |
| --- | --- |
| Race condition | Nhiều request cùng truy cập shared state và kết quả phụ thuộc vào thứ tự thực thi |
| Atomicity | Một operation hoặc thành công hoàn toàn hoặc thất bại hoàn toàn, không có trạng thái trung gian |
| SETNX | SET if Not eXists -- Redis command atomic, trả về 1 nếu key được tạo, 0 nếu key đã tồn tại |
| Hot key | Một key được nhiều client truy cập đồng thời, gây contention |
| Race collapse | Cơ chế biến nhiều concurrent request thành 1 fresh + (N-1) replay -- đây là mục tiêu của case |
| Breakdown metrics | Số liệu chi tiết về thời gian từng phần của request (CPU, DB write, external call) |
| per-vu-iterations | k6 executor: mỗi VU chạy đúng N iterations. Lý tưởng cho race test vì tất cả VU start đồng thời |
| Counter | k6 custom metric dạng đếm tích lũy -- dùng để đếm số lần fresh/reuse/duplicate |

---

## Dashboard/chart reading (bổ sung từ bản gốc)

Chart nên đọc:

- request burst ở hai phase `confirm_hotkey` và `webhook_hotkey`;
- fresh duration cao hơn reuse/duplicate duration;
- checks rate 100%;
- custom counters fresh/reuse/duplicate.

Không dùng RPS cao/thấp để pass/fail. Mục tiêu là exact count.

---

## Production lesson (bổ sung từ bản gốc)

Hot-key race là bài test quan trọng nhất cho Redis/shared state. Hệ thống đúng không phải vì trả 200 cho mọi retry, mà vì chỉ tạo side effect một lần. Đây là khác biệt giữa API availability và business correctness.

### Mối liên hệ với case 01

```text
Case 01: "State có được share đúng qua nhiều instances không?" → YES (sequential)
Case 02: "State có an toàn khi 8 request đến cùng lúc không?" → YES (concurrent)

Cả hai = bộ bằng chứng toàn diện cho shared state correctness.
Case 01 trả lời "where is the state?"
Case 02 trả lời "is the state safe under pressure?"
```

### Hệ quả trong production thực tế

```text
Đợt flash sale 12/12, 10,000 người dùng cùng nhấn "Mua ngay" cho một sản phẩm
chỉ còn 100 tồn kho. Trong số đó, ước tính 30% request bị retry do network
(timeout, lag, mobile app auto-retry).

Nếu idempotency atomic: 10,000 confirm requests → 10,000 idempotency keys →
10,000 orders được tạo (mỗi người 1 order). 100 orders đầu tiên thành công,
9,900 orders còn lại hết hàng.

Nếu idempotency KHÔNG atomic: retry tạo duplicate orders → một người có thể
có 2-3 orders → người thứ 50 đã thấy hết hàng, nhưng thực tế chỉ có 30
orders thật → 70 đơn hàng "ma" do duplicate.

Kết quả: 100 sản phẩm, 70 người nhận được hàng, 30 người bị hoàn tiền +
customer service. Đây là incident P0 trị giá hàng chục nghìn USD.
```

### Điều gì làm case này khác biệt

Case 02 không giống bất kỳ case nào khác trong toàn bộ suite:

- **Không phải load test**: Không quan tâm RPS hay p95. Chỉ quan tâm exact counters.
- **Không phải sequential test**: 1 VU không thể chạy case này. Cần ít nhất 2 VU để tạo race.
- **Không phải integration test thông thường**: Kiểm tra atomicity ở mức Redis command, không phải business logic.
- **Là contract test cho Redis implementation**: Nếu fail, vấn đề nằm ở cách app dùng Redis (SETNX, Lua script), không phải ở business logic.

Đây là lý do case 02 được coi là **bài test nền tảng cho race/atomicity** và là một trong hai bài tiêu biểu nhất để dạy Redis/shared state.
