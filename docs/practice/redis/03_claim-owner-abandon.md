# redis-03 -- Claim owner abandon and TTL takeover

> **Case ID:** `redis-03-claim-owner-abandon`
> **Script:** `../app/17-order-service-claim-owner-abandon.js`
> **Executor:** `vus=1, iterations=1`
> **Topology:** `full-no-cdn`
> **Proof:** Redis claim ownership có TTL và takeover an toàn -- owner chết không khóa vĩnh viễn

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

Một worker/request claim quyền xử lý idempotency key hoặc webhook event rồi chết giữa chừng: process crash, timeout, deploy restart, hoặc upstream disconnect. Nếu claim không có TTL/takeover, checkout/payment flow có thể bị kẹt vĩnh viễn.

Hãy hình dung tình huống sau trong một hệ thống thương mại điện tử thực tế:

```text
1. Người dùng nhấn "Thanh toán" -> POST /api/sim/orders/ORD-001/confirm
2. order-service instance A nhận request, claim idempotency key "idem-xyz" trong Redis
3. Instance A bắt đầu xử lý: ghi DB, gọi external payment gateway...
4. NGAY LÚC NÀY: instance A bị OOMKilled do memory spike, hoặc bị deploy restart
5. Idempotency key "idem-xyz" vẫn bị lock trong Redis -- không ai giải phóng
6. Người dùng nhấn "Thanh toán" lần nữa -> request đến instance B
7. Instance B thấy key "idem-xyz" đã bị claim -> KHÔNG THỂ xử lý
8. Người dùng thấy timeout, đơn hàng bị kẹt ở trạng thái "đang xử lý" vĩnh viễn
```

Đây không phải là tình huống giả định. Trong production, worker crash khi đang giữ lock là một trong những nguyên nhân hàng đầu gây ra stuck order, double charge, và inconsistent payment state. Các nghiên cứu về distributed systems (Google Chubby, Apache ZooKeeper, Redis Redlock) đều nhấn mạnh rằng **không có cơ chế TTL và takeover, distributed lock là một anti-pattern nguy hiểm**.

### 1.2 Ba giai đoạn của claim lifecycle

Case này mô phỏng đầy đủ ba giai đoạn trong lifecycle của một claim:

```text
owner A claim -> owner A abandon -> TTL expires -> owner B takeover -> duplicate reuses owner B result
```

| Giai đoạn | Hành động | HTTP status | Ý nghĩa |
| --- | --- | --- | --- |
| **Abandon** | Owner A claim key, xử lý một phần, rồi cố ý abandon | 503 | Worker chết hoặc timeout -- claim bị bỏ dở |
| **Takeover** | Owner B gửi request cùng key, chờ TTL hết hạn, rồi xử lý fresh | 200 | Hệ thống tự phục hồi -- không cần manual intervention |
| **Duplicate** | Request thứ ba cùng key, thấy kết quả của Owner B | 200 + reuse=true | Idempotency hoạt động bình thường sau takeover |

### 1.3 Tại sao "abandon" không phải là bug

Điểm quan trọng nhất cần hiểu về case này: **503 ở giai đoạn abandon là INTENTIONAL SETUP, không phải là bug**. Request đầu tiên cố ý abandon claim thông qua query parameter `?abandon_claim=true`. Đây là cơ chế mô phỏng (simulation) để tạo ra tình huống "worker chết giữa chừng" mà không cần thực sự kill process.

Trong production thực tế, tình huống tương đương xảy ra khi:
- Container bị OOMKilled giữa lúc đang xử lý request
- Deployment rolling update kill pod đang active
- Network partition làm mất kết nối giữa app và Redis
- Upstream payment gateway timeout sau 30 giây, app context bị hủy

Trong tất cả các trường hợp trên, client (người dùng) cũng sẽ thấy một dạng failure (503, 504, hoặc connection reset). Sự khác biệt nằm ở điều xảy ra **sau đó**: nếu hệ thống có TTL takeover đúng, request tiếp theo sẽ thành công. Nếu không, request sẽ bị kẹt vĩnh viễn.

### 1.4 Hai flow được test: confirm và webhook

Case này test claim owner abandon trên **cả hai flow** quan trọng nhất của order service:

| Flow | Endpoint | Idempotency mechanism | Tại sao quan trọng |
| --- | --- | --- | --- |
| **Order confirm** | `POST /api/sim/orders/{orderId}/confirm` | `Idempotency-Key` header | Người dùng nhấn "Thanh toán" nhiều lần, hoặc mobile app retry |
| **Payment webhook** | `POST /api/sim/orders/webhooks/payment` | `event_id` trong body | Payment gateway gửi webhook nhiều lần (at-least-once delivery) |

Mỗi flow đều trải qua đủ 3 giai đoạn (abandon, takeover, duplicate), tạo ra tổng cộng 6 request trong một lần chạy script.

---

## 2. Redis capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh Redis claim ownership có TTL và takeover an toàn:

> **Khi một worker claim quyền xử lý idempotency key hoặc webhook event rồi abandon (chết/timeout), claim TTL sẽ tự động hết hạn. Request tiếp theo có thể takeover claim sau khi TTL hết hạn, thực thi fresh, và các request sau đó reuse kết quả bình thường. Toàn bộ quá trình không cần manual intervention.**

Cụ thể hơn, case chứng minh 6 khả năng con:

1. **Claim creation với TTL**: Worker đầu tiên tạo claim trong Redis với TTL xác định (mặc định 900ms). Claim tự động bị xóa khi TTL hết hạn -- không cần explicit release.
2. **Intentional abandon được ghi nhận**: Response trả về `claim_abandoned=true` xác nhận claim đã bị abandon có chủ đích, không phải do lỗi hệ thống.
3. **Takeover sau TTL với fresh execution**: Request thứ hai (owner mới) được server giữ lại cho đến khi claim TTL hết hạn, sau đó thực thi fresh -- không reuse kết quả cũ (vì chưa có kết quả thành công nào).
4. **Server-side wait mechanism**: Server chủ động chờ claim TTL hết hạn trước khi cho phép takeover -- request duration phản ánh thời gian chờ này (>= TTL - 150ms).
5. **Duplicate sau takeover reuse kết quả mới**: Request thứ ba thấy kết quả đã được lưu bởi owner mới và reuse -- idempotency hoạt động bình thường.
6. **Cả confirm flow và webhook flow đều recover**: Cả hai cơ chế idempotency (Idempotency-Key header và event_id body) đều hoạt động đúng qua abandon-takeover cycle.

### 2.2 So sánh với các case Redis khác

| Case | Cơ chế | Có claim? | Có abandon? | Concurrency |
| --- | --- | --- | --- | --- |
| 01 -- Shared state distributed | Idempotency replay qua nhiều instance | Không | Không | Sequential (1 VU) |
| 02 -- Hotkey race | Atomic lock dưới concurrent retry storm | Có (implicit lock) | Không | Concurrent (N VUs) |
| **03 -- Claim owner abandon** | **Claim TTL + takeover khi owner chết** | **Có (explicit claim)** | **Có (intentional)** | **Sequential (1 VU)** |
| 04 -- Redis degrade | Correctness dưới Redis delay | Có (implicit lock) | Không | Concurrent (N VUs) |
| 05 -- Hotkey fairness | Hot key không starve normal keys | Không | Không | Concurrent (N+M VUs) |

Case 03 là case **duy nhất** trong series chứng minh cơ chế takeover khi owner chết. Case 02 chứng minh lock hoạt động khi không có ai chết; case 03 chứng minh lock không trở thành điểm chết khi có ai đó chết.

---

## 3. Vì sao phải test ở Redis layer

### 3.1 Đây không phải là vấn đề của application code đơn thuần

Application code có thể implement retry, timeout, và error handling. Nhưng vấn đề "claim bị khóa vĩnh viễn khi worker chết" là vấn đề của **state layer**, không phải của application logic. Application không thể tự giải phóng lock nếu chính nó đã chết.

Nếu test ở application layer:
- Bạn có thể test rằng `POST /confirm` trả về 200 khi mọi thứ bình thường.
- Bạn có thể test rằng retry với cùng `Idempotency-Key` trả về kết quả cũ.
- Bạn KHÔNG THỂ test rằng claim được giải phóng khi worker chết -- vì application test không giết được chính nó giữa chừng.

### 3.2 Đây không phải là vấn đề của database layer

PostgreSQL (hoặc bất kỳ SQL database nào) có thể lưu trạng thái claim qua row-level locking (`SELECT ... FOR UPDATE`). Nhưng:
- Database lock thường không có TTL tự động -- nếu connection giữ lock bị đứt, database sẽ rollback transaction và giải phóng lock, nhưng thời gian phát hiện connection đứt có thể rất lâu (tính bằng phút).
- Database không được thiết kế để làm distributed lock manager -- throughput thấp hơn Redis vài bậc.
- Database lock thường gắn với transaction scope, không phù hợp với business-level claim kéo dài qua nhiều external calls.

### 3.3 Redis là lớp đúng để test claim ownership

Redis phù hợp với claim ownership vì ba lý do:

1. **TTL native**: `SET key value NX EX ttl` cho phép set key với TTL trong cùng một atomic operation. Không cần thêm logic quét hết hạn.
2. **Atomic operations**: `SET NX` (only set if not exists) cho phép claim key một cách atomic -- không có race condition giữa "check" và "set".
3. **Performance**: Redis xử lý claim operation trong sub-millisecond, không làm chậm critical path của order confirm.

### 3.4 Phân biệt trách nhiệm giữa các layer

```text
Application layer (code):     Business logic confirm/payment -- "xử lý cái gì"
Redis layer (case 03):        Claim ownership + TTL + takeover -- "ai đang xử lý, khóa bao lâu"
Database layer (Postgres):    Persistent state của order -- "kết quả cuối cùng là gì"
```

Case 03 trả lời câu hỏi ở Redis layer: khi "ai đang xử lý" biến mất, hệ thống có tự phục hồi được không?

---

## 4. Topology và precondition

### 4.1 Topology

```text
k6 (1 VU, 1 iteration, sequential)
  |
  | 6 HTTP requests tuần tự: 3 confirm + 3 webhook
  | headers: X-Test-Suite=order-service-claim-owner-abandon
  |          Idempotency-Key (confirm) / X-Webhook-Id (webhook)
  v
Nginx :80 (lb-app container)
  |
  | path-based routing -> order-service
  v
order-service (1 instance, nhưng claim state nằm trong Redis)
  |
  | claim operations: SET NX EX, GET, DEL (qua TTL)
  v
Redis (shared state store)
  |
  | persistent storage
  v
PostgreSQL (order data, payment state)
```

### 4.2 Precondition

Trước khi chạy case này, các điều kiện sau phải được đáp ứng:

```powershell
# 1. Stack đã được start với đúng topology
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2

# 2. Biến môi trường BASE_URL trỏ đến Nginx public port
$env:BASE_URL = "http://localhost:80"

# 3. Xác nhận order-service đang hoạt động
curl -s -X POST http://localhost:80/api/sim/orders/ORD-TEST/confirm `
  -H "Content-Type: application/json" `
  -H "Idempotency-Key: test-key-001" `
  -d "{}"
# Kỳ vọng: 200

# 4. Xác nhận Redis đang hoạt động (thông qua health check hoặc API)
curl -s http://localhost:80/api/sim/orders/ORD-TEST/status
# Kỳ vọng: 200 với payment status được trả về
```

### 4.3 Environment variables

| Biến | Default | Mô tả |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | Public URL của Nginx gateway |
| `ORDER_CLAIM_ABANDON_TTL_MS` | `900` | Claim TTL (milliseconds) -- thời gian claim tồn tại trước khi tự động hết hạn |
| `ORDER_CLAIM_ABANDON_AFTER_MS` | `80` | Thời gian (ms) owner đầu tiên xử lý trước khi abandon -- mô phỏng "chết sau 80ms" |
| `ORDER_CLAIM_ABANDON_CONFIRM_DB_WRITES` | `2` | Số lượng DB write trong confirm flow -- tạo work thực tế để phân biệt fresh vs reuse |
| `ORDER_CLAIM_ABANDON_CONFIRM_EXTERNAL_MS` | `90` | Thời gian external call (ms) trong confirm -- mô phỏng gọi payment gateway |
| `ORDER_CLAIM_ABANDON_WEBHOOK_DB_WRITES` | `2` | Số lượng DB write trong webhook flow |
| `OPS_AUTH_TOKEN` | (rỗng) | Ops token (không bắt buộc cho case này, nhưng được hỗ trợ) |

### 4.4 Giải thích các tham số TTL và timing

Mối quan hệ giữa `CLAIM_TTL_MS` và `ABANDON_AFTER_MS` rất quan trọng:

```text
Timeline của một claim (confirm flow):
0ms       80ms                                            900ms
|---------|...............................................|
  owner A    owner A abandon                             claim TTL
  bắt đầu    (trả 503)                                  hết hạn
  xử lý                                                  |
                                                    owner B có thể
                                                    takeover sau
                                                    thời điểm này
```

- `ABANDON_AFTER_MS=80`: Owner A chỉ xử lý được 80ms trước khi abandon. Thời gian này đủ ngắn để mô phỏng crash nhanh, nhưng đủ dài để hệ thống ghi nhận claim đã được tạo.
- `CLAIM_TTL_MS=900`: Claim tồn tại 900ms. Đây là thời gian đủ dài để phân biệt rõ giữa "request đến ngay lập tức" (sẽ bị chặn vì claim còn hiệu lực) và "request đến sau TTL" (được phép takeover).
- Khoảng cách 820ms giữa thời điểm abandon (80ms) và thời điểm TTL hết hạn (900ms) là cửa sổ mà hệ thống phải chờ đợi -- đây chính là thứ tạo ra duration dài cho takeover request.

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `17-order-service-claim-owner-abandon.js` gồm 203 dòng, được tổ chức thành 6 phần chính:

```text
(A) IMPORTS + CONSTANTS          (dòng 1-13):  k6 modules, env vars
(B) CUSTOM METRICS               (dòng 15-21): 6 counters + 3 trends
(C) OPTIONS + THRESHOLDS         (dòng 23-38): vus=1, iterations=1, 5 thresholds
(D) HELPER FUNCTIONS             (dòng 40-76): headers, safeJson, envelope, buildQuery
(E) REQUEST + ASSERT FUNCTIONS   (dòng 78-171): postConfirm, postWebhook, 6 assert functions
(F) DEFAULT FUNCTION             (dòng 173-203): main flow -- 6 requests tuần tự
```

### 5.2 Phân tích từng dòng -- Phần A: Imports và Constants

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { envInt, envString } from '../shared/common.js';
```

Script import ba module từ k6 core (`http`, `check`, `Counter/Trend`) và hai helper từ shared library.

```javascript
const BASE_URL = envString('BASE_URL', 'http://localhost:80').replace(/\/$/, '');
const CLAIM_TTL_MS = envInt('ORDER_CLAIM_ABANDON_TTL_MS', 900);
const ABANDON_AFTER_MS = envInt('ORDER_CLAIM_ABANDON_AFTER_MS', 80);
const CONFIRM_DB_WRITES = envInt('ORDER_CLAIM_ABANDON_CONFIRM_DB_WRITES', 2);
const CONFIRM_EXTERNAL_MS = envInt('ORDER_CLAIM_ABANDON_CONFIRM_EXTERNAL_MS', 90);
const WEBHOOK_DB_WRITES = envInt('ORDER_CLAIM_ABANDON_WEBHOOK_DB_WRITES', 2);
const OPS_AUTH_TOKEN = envString('OPS_AUTH_TOKEN', '');
```

Tất cả tham số đều có thể override qua biến môi trường. Điều này cho phép tuned run với timing khác nhau (xem section 14 -- Variations).

`CLAIM_TTL_MS=900` là tham số quan trọng nhất. Nó kiểm soát thời gian claim tồn tại trước khi hết hạn. Trong production, giá trị này thường lớn hơn nhiều (5-30 giây) vì cần đủ thời gian cho external payment gateway response. 900ms là giá trị tối ưu cho test: đủ dài để thấy rõ cơ chế chờ, nhưng đủ ngắn để test không kéo dài.

### 5.3 Phân tích -- Phần B: Custom Metrics

```javascript
const claimAbandonFailures = new Counter('order_claim_abandon_check_failures');
const abandonedCount = new Counter('order_claim_abandon_abandoned_count');
const takeoverFreshCount = new Counter('order_claim_abandon_takeover_fresh_count');
const duplicateReuseCount = new Counter('order_claim_abandon_duplicate_reuse_count');
const abandonedDuration = new Trend('order_claim_abandon_abandoned_duration', true);
const takeoverDuration = new Trend('order_claim_abandon_takeover_duration', true);
const duplicateDuration = new Trend('order_claim_abandon_duplicate_duration', true);
```

Script định nghĩa **7 custom metrics**:

| Metric | Loại | Ý nghĩa | Giá trị kỳ vọng |
| --- | --- | --- | --- |
| `order_claim_abandon_check_failures` | Counter | Tổng số check thất bại trên tất cả các giai đoạn | 0 |
| `order_claim_abandon_abandoned_count` | Counter | Số lần abandon thành công (cả confirm + webhook) | 2 |
| `order_claim_abandon_takeover_fresh_count` | Counter | Số lần takeover với fresh execution (cả confirm + webhook) | 2 |
| `order_claim_abandon_duplicate_reuse_count` | Counter | Số lần duplicate reuse kết quả takeover (cả confirm + webhook) | 2 |
| `order_claim_abandon_abandoned_duration` | Trend | Thời gian response của abandon request | Thường < 200ms |
| `order_claim_abandon_takeover_duration` | Trend | Thời gian response của takeover request | Gần CLAIM_TTL_MS (>= 750ms) |
| `order_claim_abandon_duplicate_duration` | Trend | Thời gian response của duplicate request | Thường < 100ms (cache hit) |

Trend metrics có tham số `true` (là `isTime`) để k6 hiểu đây là time-based metric và hiển thị đúng đơn vị thời gian trong output.

### 5.4 Phân tích -- Phần C: Options và Thresholds

```javascript
export const options = {
  vus: 1,
  iterations: 1,
  noConnectionReuse: true,
  thresholds: {
    checks: ['rate==1'],
    order_claim_abandon_check_failures: ['count==0'],
    order_claim_abandon_abandoned_count: ['count==2'],
    order_claim_abandon_takeover_fresh_count: ['count==2'],
    order_claim_abandon_duplicate_reuse_count: ['count==2'],
  },
  tags: {
    scenario: 'order_service_claim_owner_abandon',
    target_service: 'order-service',
  },
};
```

**`vus: 1, iterations: 1`** -- Đây là lựa chọn executor quan trọng:

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **vus=1, iterations=1** (đang dùng) | ✅ **ĐÚNG** | Sequential proof. 3 giai đoạn phụ thuộc tuần tự: abandon -> chờ TTL -> takeover -> duplicate. Chạy song song sẽ làm nhiễu claim state. |
| constant-vus | ❌ SAI | Loop vô hạn -- case này cần chính xác 1 lần chạy qua 6 bước. |
| shared-iterations | ❌ SAI | Nhiều VU tranh iteration -- claim state sẽ bị conflict. |
| per-vu-iterations | ❌ SAI | Nhiều VU mỗi VU 1 iter -> nhiều instance cùng abandon, claim conflict. |

Một VU là đúng vì case cần deterministic sequence. Chạy song song sẽ làm nhiễu claim state.

**`noConnectionReuse: true`** -- Mỗi request dùng một connection TCP riêng. Điều này quan trọng vì:
- Mô phỏng các request đến từ các client khác nhau (owner A và owner B là hai client khác nhau).
- Tránh trường hợp connection reuse làm server nhầm lẫn giữa hai request kế tiếp trên cùng một connection.
- Trong production, request sau khi crash đến từ một TCP connection hoàn toàn mới.

**Thresholds**:
- `checks: ['rate==1']` -- 100% checks phải pass. Không khoan nhượng.
- `order_claim_abandon_check_failures: ['count==0']` -- Không có bất kỳ check failure nào.
- `order_claim_abandon_abandoned_count: ['count==2']` -- Chính xác 2 lần abandon (1 confirm + 1 webhook).
- `order_claim_abandon_takeover_fresh_count: ['count==2']` -- Chính xác 2 lần takeover fresh.
- `order_claim_abandon_duplicate_reuse_count: ['count==2']` -- Chính xác 2 lần duplicate reuse.

### 5.5 Phân tích -- Phần D: Helper Functions

```javascript
function headers(extraHeaders = {}) {
  const result = {
    'Content-Type': 'application/json',
    'X-Test-Suite': 'order-service-claim-owner-abandon',
    ...extraHeaders,
  };
  if (OPS_AUTH_TOKEN) {
    result.Authorization = `Bearer ${OPS_AUTH_TOKEN}`;
    result['X-Ops-Token'] = OPS_AUTH_TOKEN;
  }
  return result;
}
```

Hàm `headers()` tự động thêm OPS token nếu có, và merge với extra headers. `X-Test-Suite` header giúp phân biệt request từ case này trong log.

```javascript
function recordCheckFailure(label) {
  claimAbandonFailures.add(1, { label, target_service: 'order-service' });
  return false;
}
```

Mỗi khi một check fail, counter `claimAbandonFailures` được tăng lên 1. Tag `label` cho biết check nào đã fail (ví dụ: `confirm_takeover_status`, `webhook_abandoned_owner_fresh`). Pattern này được dùng xuyên suốt tất cả các Redis case để đảm bảo mọi failure đều được ghi nhận.

### 5.6 Phân tích -- Phần E: Request Functions

Hai hàm request chính:

```javascript
function postConfirm(orderId, idempotencyKey, extraQuery = {}, stage = 'confirm') {
  const query = buildQuery({
    cpu_ms: '0',
    db_writes: String(CONFIRM_DB_WRITES),
    external_ms: String(CONFIRM_EXTERNAL_MS),
    external_fail_rate: '0',
    claim_ttl_ms: String(CLAIM_TTL_MS),
    ...extraQuery,
  });
  return envelope(http.post(
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?${query.toString()}`,
    JSON.stringify({}),
    {
      headers: headers({ 'Idempotency-Key': idempotencyKey }),
      tags: { stage, target_flow: 'order_confirm', target_service: 'order-service' },
    },
  ));
}
```

Điểm quan trọng trong `postConfirm`:
- `claim_ttl_ms` được truyền qua query string -- server dùng giá trị này để set TTL cho claim key.
- `extraQuery` cho phép thêm `abandon_claim=true` và `abandon_claim_after_ms=80` cho giai đoạn abandon.
- `Idempotency-Key` header là cơ chế idempotency chính cho confirm flow -- ba request dùng cùng một key.
- Response được wrap qua `envelope()` để parse JSON body một cách an toàn.

Tương tự, `postWebhook` dùng `event_id` trong body JSON và `X-Webhook-Id` header cho webhook dedupe.

### 5.7 Phân tích -- Phần E: Assert Functions (6 hàm)

Script định nghĩa 6 hàm assert, mỗi hàm tương ứng với một giai đoạn và flow:

**assertAbandoned** -- Kiểm tra 3 điều cho abandon phase:
```javascript
function assertAbandoned(result, label) {
  abandonedDuration.add(result.response.timings.duration, { stage: label });
  check(result, {
    [`${label} status 503`]: (o) => o.response.status === 503 || ...,
    [`${label} success false`]: (o) => o.payload && o.payload.success === false || ...,
    [`${label} claim abandoned true`]: (o) => o.payload && o.payload.data && o.payload.data.claim_abandoned === true || ...,
  });
  abandonedCount.add(1, { stage: label });
}
```

Ba checks cho abandon phase:
1. `status 503` -- Server trả về 503 Service Unavailable. Đây là HTTP status chuẩn cho "tạm thời không thể xử lý".
2. `success false` -- Body JSON có `success: false`.
3. `claim abandoned true` -- Body JSON có `data.claim_abandoned: true` -- đây là evidence quan trọng nhất: server xác nhận claim đã được abandon đúng cách.

**assertConfirmTakeover** -- Kiểm tra 6 điều cho takeover phase (confirm flow):
```javascript
function assertConfirmTakeover(result, label, orderId, idempotencyKey) {
  takeoverDuration.add(result.response.timings.duration, { stage: label });
  check(result, {
    [`${label} status 200`]: (o) => o.response.status === 200 || ...,
    [`${label} success true`]: (o) => o.payload && o.payload.success === true || ...,
    [`${label} order id preserved`]: (o) => o.payload && o.payload.data && o.payload.data.order_id === orderId || ...,
    [`${label} idempotency key preserved`]: (o) => o.payload && o.payload.data && o.payload.data.idempotency_key === idempotencyKey || ...,
    [`${label} executes fresh after ttl`]: (o) => o.payload && o.payload.data && o.payload.data.idempotency_reuse === false || ...,
    [`${label} waited near claim ttl`]: (o) => o.response.timings.duration >= CLAIM_TTL_MS - 150 || ...,
  });
  takeoverFreshCount.add(1, { stage: label });
}
```

Check quan trọng nhất trong takeover:
- `idempotency_reuse === false` -- Xác nhận đây là fresh execution (lần đầu tiên thành công), không phải replay.
- `duration >= CLAIM_TTL_MS - 150` -- Request duration phải >= 750ms (900 - 150). Điều này chứng minh server đã thực sự chờ claim TTL hết hạn trước khi xử lý, chứ không phải bỏ qua claim.

Mức chênh lệch 150ms là buffer để bù đắp cho network latency và clock skew giữa k6 client và server.

**assertConfirmDuplicate** -- Kiểm tra 2 điều cho duplicate phase:
```javascript
function assertConfirmDuplicate(result, label) {
  duplicateDuration.add(result.response.timings.duration, { stage: label });
  check(result, {
    [`${label} status 200`]: (o) => o.response.status === 200 || ...,
    [`${label} reuses takeover result`]: (o) => o.payload && o.payload.data && o.payload.data.idempotency_reuse === true || ...,
  });
  duplicateReuseCount.add(1, { stage: label });
}
```

`idempotency_reuse === true` -- Check duy nhất nhưng quan trọng: xác nhận request thứ ba reuse kết quả của lần takeover.

**assertWebhookTakeover** và **assertWebhookDuplicate** -- Tương tự như confirm flow nhưng dùng `webhook_duplicate` thay vì `idempotency_reuse`.

### 5.8 Phân tích -- Phần F: Default Function (Main Flow)

```javascript
export default function () {
  const base = `${Date.now()}-${__VU}-${__ITER}`;
  const confirmOrderId = `ORD-CLAIM-ABANDON-${base}`;
  const confirmKey = `idem-claim-abandon-${base}`;
  const webhookOrderId = `ORD-WEBHOOK-CLAIM-ABANDON-${base}`;
  const webhookEventId = `evt-claim-abandon-${base}`;

  // === CONFIRM FLOW: 3 requests ===
  const abandonedConfirm = postConfirm(confirmOrderId, confirmKey, {
    abandon_claim: 'true',
    abandon_claim_after_ms: String(ABANDON_AFTER_MS),
  }, 'confirm_abandoned_owner');
  assertAbandoned(abandonedConfirm, 'confirm abandoned owner');

  const takeoverConfirm = postConfirm(confirmOrderId, confirmKey, {}, 'confirm_takeover_after_ttl');
  assertConfirmTakeover(takeoverConfirm, 'confirm takeover', confirmOrderId, confirmKey);

  const duplicateConfirm = postConfirm(confirmOrderId, confirmKey, {}, 'confirm_duplicate_after_takeover');
  assertConfirmDuplicate(duplicateConfirm, 'confirm duplicate');

  // === WEBHOOK FLOW: 3 requests ===
  const abandonedWebhook = postWebhook(webhookOrderId, webhookEventId, {
    abandon_claim: 'true',
    abandon_claim_after_ms: String(ABANDON_AFTER_MS),
  }, 'webhook_abandoned_owner');
  assertAbandoned(abandonedWebhook, 'webhook abandoned owner');

  const takeoverWebhook = postWebhook(webhookOrderId, webhookEventId, {}, 'webhook_takeover_after_ttl');
  assertWebhookTakeover(takeoverWebhook, 'webhook takeover', webhookOrderId, webhookEventId);

  const duplicateWebhook = postWebhook(webhookOrderId, webhookEventId, {}, 'webhook_duplicate_after_takeover');
  assertWebhookDuplicate(duplicateWebhook, 'webhook duplicate');
}
```

Default function thực thi 6 request tuần tự trong một lần chạy. ID được tạo với timestamp+VU+iteration để đảm bảo uniqueness giữa các lần chạy.

Lưu ý quan trọng: **không có `sleep()` giữa abandon và takeover**. Server tự động giữ takeover request cho đến khi claim TTL hết hạn (server-side wait). Điều này mô phỏng chính xác production behavior: client không biết khi nào TTL hết hạn, client chỉ gửi request và server chịu trách nhiệm chờ.

---

## 6. Redis mechanism deep-dive

### 6.1 Cách Redis thực hiện claim ownership

Claim ownership được thực hiện thông qua cơ chế **SET với NX và EX**:

```text
SET claim:{idempotency_key} {owner_id} NX EX {ttl_seconds}
```

Ba thành phần của lệnh này:

| Thành phần | Redis command | Ý nghĩa |
| --- | --- | --- |
| **NX** | `NX` | "Only set if Not eXists" -- nếu key đã tồn tại, lệnh trả về null (claim thất bại). Đảm bảo tính atomic: không có race condition giữa check và set. |
| **EX** | `EX {seconds}` | Set Time-To-Live (TTL) cho key. Sau `{seconds}` giây, Redis tự động xóa key. Không cần explicit DELETE. |
| **Value** | `{owner_id}` | Lưu ID của owner hiện tại. Cho phép kiểm tra xem ai đang giữ claim (dùng cho debugging và monitoring). |

### 6.2 Atomicity của SET NX EX

`SET NX EX` là một lệnh atomic duy nhất trong Redis. Điều này có nghĩa:

```text
SAI (non-atomic, có race condition):
  1. EXISTS claim:key  -> false
  2. [Một request khác chen vào giữa]
  3. SET claim:key value -> OK (nhưng key đã được set bởi request khác!)

ĐÚNG (atomic):
  1. SET claim:key value NX EX 10 -> OK hoặc null
  Toàn bộ operation là một lệnh duy nhất, không thể bị chen ngang.
```

### 6.3 Cơ chế TTL và automatic expiry

Khi claim key được set với `EX`, Redis duy trì TTL cho key đó:

```text
Timeline của key trong Redis:
t=0ms:    SET claim:idem-xyz owner-A NX EX 900ms  -> OK
t=80ms:   Owner A abandon (server trả 503)
          Key vẫn tồn tại trong Redis với TTL còn ~820ms
t=100ms:  Owner B gửi request, server thấy key còn tồn tại
          Server GIỮ request (chờ TTL hết hạn)
t=900ms:  Redis tự động xóa key (TTL expired)
          Server thấy key đã biến mất -> cho phép takeover
t=901ms:  SET claim:idem-xyz owner-B NX EX 900ms  -> OK
          Owner B thực thi fresh
```

Redis có hai cơ chế để xóa expired key:
1. **Lazy expiration**: Khi một client truy cập key đã hết hạn, Redis xóa key đó và trả về null.
2. **Active expiration**: Redis định kỳ quét ngẫu nhiên một số key có TTL và xóa những key đã hết hạn.

Trong trường hợp claim ownership, cơ chế lazy expiration là đủ: server chủ động poll key, và khi key hết hạn, lần poll tiếp theo sẽ thấy key đã biến mất.

### 6.4 Server-side wait mechanism

Đây là chi tiết quan trọng nhất về cách server xử lý takeover:

```text
Server nhận request takeover:
1. Kiểm tra claim key trong Redis: SET claim:{key} {new_owner} NX EX {ttl}
2. Nếu NX trả về null (key đã tồn tại -> claim đang được giữ):
   a. Đọc TTL còn lại của key: TTL claim:{key} -> {remaining_ms}
   b. Nếu remaining_ms > 0: server SLEEP trong remaining_ms + buffer
   c. Sau khi sleep, quay lại bước 1
3. Nếu NX trả về OK (key đã hết hạn hoặc chưa tồn tại):
   a. Claim đã được takeover thành công
   b. Thực thi business logic (DB writes, external calls)
   c. Lưu kết quả vào idempotency record
   d. Trả về 200 với idempotency_reuse=false
```

Đây là lý do takeover request có duration >= CLAIM_TTL_MS - 150ms: server đã dành phần lớn thời gian để chờ claim TTL hết hạn. Phần còn lại (~150ms) là thời gian thực thi business logic (DB writes + external call).

### 6.5 Cách abandon claim được trigger

Abandon claim được trigger thông qua query parameter:

```text
POST /api/sim/orders/{orderId}/confirm?abandon_claim=true&abandon_claim_after_ms=80&claim_ttl_ms=900
```

Server-side xử lý:
1. Nhận request, tạo claim key với TTL=900ms (SET NX EX).
2. Bắt đầu xử lý business logic (DB writes, external calls simulation).
3. Sau 80ms (`abandon_claim_after_ms`), server kiểm tra flag `abandon_claim=true`.
4. Nếu flag bật, server DỪNG xử lý, KHÔNG lưu kết quả, và trả về 503 với `claim_abandoned=true`.
5. Claim key vẫn tồn tại trong Redis với TTL còn lại ~820ms.

Điểm mấu chốt: abandon không xóa claim key. Claim key tiếp tục tồn tại cho đến khi TTL hết hạn, mô phỏng chính xác tình huống "worker chết nhưng lock chưa được giải phóng".

### 6.6 So sánh với các giải pháp lock khác

| Cơ chế | TTL tự động? | Takeover tự động? | Yêu cầu manual intervention? | Phù hợp cho claim ownership? |
| --- | --- | --- | --- | --- |
| **Redis SET NX EX** (case này) | Có | Có (server poll) | Không | Rất phù hợp |
| Redis Redlock | Có | Có (client-side retry) | Không | Phù hợp cho multi-node Redis |
| Database row lock (`SELECT FOR UPDATE`) | Có (transaction timeout) | Có (khi transaction rollback) | Không | Được nhưng chậm hơn Redis |
| File-based lock | Không | Không | Có (xóa file lock thủ công) | Không phù hợp |
| In-memory lock (không shared) | Không | Không | Có (restart process) | Cực kỳ nguy hiểm |

---

## 7. Request sequence flow

### 7.1 Timeline tổng thể

```text
Time (ms)  |  Request                          |  Status  |  Redis State                    |  Duration
-----------|-----------------------------------|----------|---------------------------------|----------
0          |  POST confirm?abandon_claim=true  |  (gửi)   |  SET claim:idem NX EX 900 -> OK |  -
80         |  Server abandon, trả về           |  503     |  claim:idem còn ~820ms TTL      |  ~85ms
           |  claim_abandoned=true             |          |                                 |
-----------|-----------------------------------|----------|---------------------------------|----------
85         |  POST confirm (takeover)          |  (gửi)   |  claim:idem còn ~815ms TTL      |  -
85-900     |  Server GIỮ request, chờ TTL      |  (chờ)   |  TTL đếm ngược: 815...0         |  -
900        |  Redis xóa claim:idem (expired)  |          |  claim:idem bị xóa              |  -
900-985    |  Server claim key mới + xử lý     |  (xử lý) |  SET claim:idem NX EX 900 -> OK |  -
985        |  Server trả về 200, fresh=true    |  200     |  idempotency record được lưu    |  ~900ms
-----------|-----------------------------------|----------|---------------------------------|----------
990        |  POST confirm (duplicate)         |  (gửi)   |  claim:idem còn ~895ms TTL      |  -
990-1000   |  Server thấy kết quả đã có         |  (xử lý) |  claim:idem vẫn tồn tại          |  -
1000       |  Server trả về 200, reuse=true    |  200     |  Không thay đổi                 |  ~10ms
-----------|-----------------------------------|----------|---------------------------------|----------
1005       |  POST webhook?abandon_claim=true  |  (gửi)   |  SET claim:evt NX EX 900 -> OK  |  -
1085       |  Server abandon, trả về           |  503     |  claim:evt còn ~820ms TTL       |  ~85ms
-----------|-----------------------------------|----------|---------------------------------|----------
1090       |  POST webhook (takeover)          |  (gửi)   |  claim:evt còn ~815ms TTL       |  -
1090-1905  |  Server GIỮ request, chờ TTL      |  (chờ)   |  TTL đếm ngược                  |  -
1905       |  Redis xóa claim:evt (expired)   |          |  claim:evt bị xóa               |  -
1905-1990  |  Server claim key mới + xử lý     |  (xử lý) |  SET claim:evt NX EX 900 -> OK  |  -
1990       |  Server trả về 200, dup=false     |  200     |  webhook record được lưu        |  ~900ms
-----------|-----------------------------------|----------|---------------------------------|----------
1995       |  POST webhook (duplicate)         |  (gửi)   |  claim:evt còn ~895ms TTL       |  -
1995-2005  |  Server thấy kết quả đã có         |  (xử lý) |  claim:evt vẫn tồn tại           |  -
2005       |  Server trả về 200, dup=true      |  200     |  Không thay đổi                 |  ~10ms
```

Tổng thời gian chạy: khoảng 2 giây (2005ms). Phần lớn thời gian dành cho việc chờ claim TTL hết hạn ở hai takeover request.

### 7.2 Sequence diagram chi tiết (confirm flow)

```text
k6 (VU 1)              order-service                 Redis                   PostgreSQL
    |                       |                           |                         |
    |-- POST /confirm ----->|                           |                         |
    |   ?abandon_claim=true |                           |                         |
    |   Idempotency-Key: K1 |                           |                         |
    |                       |-- SET claim:K1 NX EX 900->|                         |
    |                       |   OK                      |                         |
    |                       |                           |                         |
    |                       |-- (xử lý DB writes) ----->|                         |
    |                       |                           |-- INSERT INTO orders...->|
    |                       |                           |                         |
    |                       | (sau 80ms: ABANDON)       |                         |
    |                       | (KHÔNG lưu kết quả)       |                         |
    |                       |                           |                         |
    |<-- 503 ---------------|                           |                         |
    |   claim_abandoned=true|                           |                         |
    |                       |                           |                         |
    |                       |  claim:K1 vẫn tồn tại     |                         |
    |                       |  TTL còn ~820ms           |                         |
    |                       |                           |                         |
    |-- POST /confirm ----->|                           |                         |
    |   Idempotency-Key: K1 |                           |                         |
    |                       |-- SET claim:K1 NX EX 900->|                         |
    |                       |   null (key đã tồn tại)   |                         |
    |                       |                           |                         |
    |                       |-- TTL claim:K1 ---------->|                         |
    |                       |   820ms                   |                         |
    |                       |                           |                         |
    |                       |   (server SLEEP ~820ms)   |                         |
    |                       |   (chờ TTL hết hạn)       |                         |
    |                       |                           |                         |
    |                       |   (TTL expired, key xóa)  |                         |
    |                       |                           |                         |
    |                       |-- SET claim:K1 NX EX 900->|                         |
    |                       |   OK (takeover thành công)|                         |
    |                       |                           |                         |
    |                       |-- (xử lý DB writes) ----->|                         |
    |                       |                           |-- INSERT INTO orders...->|
    |                       |                           |                         |
    |                       |-- (lưu kết quả) -------->|                         |
    |                       |                           |-- SAVE idempotency...-->|
    |                       |                           |                         |
    |<-- 200 ---------------|                           |                         |
    |   idempotency_reuse=  |                           |                         |
    |     false (fresh!)    |                           |                         |
    |                       |                           |                         |
    |-- POST /confirm ----->|                           |                         |
    |   Idempotency-Key: K1 |                           |                         |
    |                       |-- (tìm kết quả cũ) ----->|                         |
    |                       |                           |-- SELECT idempotency...->|
    |                       |                           |   found: result of B     |
    |                       |                           |                         |
    |<-- 200 ---------------|                           |                         |
    |   idempotency_reuse=  |                           |                         |
    |     true (reuse!)     |                           |                         |
```

### 7.3 Sự khác biệt giữa confirm flow và webhook flow

| Khía cạnh | Confirm flow | Webhook flow |
| --- | --- | --- |
| Idempotency mechanism | `Idempotency-Key` header | `event_id` trong JSON body |
| Dedupe key location | HTTP header | Request body |
| Claim key prefix | `claim:idem-{key}` | `claim:evt-{event_id}` |
| Response flag | `idempotency_reuse` | `webhook_duplicate` |
| Business logic | DB writes + external call simulation | DB writes + payment state update |
| Duration expectation | Takeover >= TTL - 150ms | Takeover >= TTL - 150ms |

Mặc dù cơ chế khác nhau, cả hai flow đều tuân theo cùng một pattern: abandon -> TTL expire -> takeover fresh -> duplicate reuse. Điều này chứng minh claim ownership là một cơ chế tổng quát, không phụ thuộc vào cách idempotency key được truyền.

---

## 8. Key signals / counters

### 8.1 Bảng counters đầy đủ

| Counter | Loại | Giá trị kỳ vọng | Ý nghĩa | Hậu quả nếu sai |
| --- | --- | --- | --- | --- |
| `checks` | Rate | 100% (rate==1) | Tất cả checks pass | Nếu < 100%: có ít nhất một check fail -- xem `claim_abandon_check_failures` để biết check nào |
| `order_claim_abandon_check_failures` | Count | 0 | Không có check failure nào | Nếu > 0: claim mechanism có lỗi -- phân tích label của failure |
| `order_claim_abandon_abandoned_count` | Count | 2 | 1 abandon confirm + 1 abandon webhook | Nếu < 2: abandon không được trigger hoặc abandon request fail trước khi claim được tạo |
| `order_claim_abandon_takeover_fresh_count` | Count | 2 | 1 takeover confirm + 1 takeover webhook -- cả hai đều fresh | Nếu < 2: takeover không thành công hoặc takeover reuse thay vì fresh |
| `order_claim_abandon_duplicate_reuse_count` | Count | 2 | 1 duplicate confirm + 1 duplicate webhook -- cả hai đều reuse | Nếu < 2: duplicate không reuse -- có thể idempotency record không được lưu sau takeover |
| `order_claim_abandon_abandoned_duration` | Trend | < 200ms | Abandon xảy ra nhanh (80ms xử lý + network overhead) | Nếu quá cao: server không abandon đúng thời điểm, hoặc bị chậm trước khi abandon |
| `order_claim_abandon_takeover_duration` | Trend | >= 750ms (CLAIM_TTL_MS - 150) | Server đã thực sự chờ TTL hết hạn | Nếu < 750ms: takeover không chờ TTL -- claim mechanism có thể sai |
| `order_claim_abandon_duplicate_duration` | Trend | < 100ms | Duplicate trả về nhanh (cache/idempotency record hit) | Nếu quá cao: idempotency record lookup bị chậm |

### 8.2 Bảng response body signals

| Signal | Vị trí | Expected value | Giai đoạn | Ý nghĩa |
| --- | --- | --- | --- | --- |
| `success` | Response body (JSON) | `false` (abandon), `true` (takeover/duplicate) | Tất cả | Thành công hay thất bại |
| `claim_abandoned` | `data.claim_abandoned` | `true` | Abandon | Claim đã được abandon đúng cách |
| `idempotency_reuse` | `data.idempotency_reuse` | `false` (takeover), `true` (duplicate) | Confirm takeover/dup | Fresh execution hay replay? |
| `webhook_duplicate` | `data.webhook_duplicate` | `false` (takeover), `true` (duplicate) | Webhook takeover/dup | Fresh webhook hay dedupe? |
| `order_id` | `data.order_id` | Giữ nguyên qua 3 request | Confirm flow | Order ID không bị thay đổi |
| `idempotency_key` | `data.idempotency_key` | Giữ nguyên qua 3 request | Confirm flow | Idempotency key được bảo toàn |
| `event_id` | `data.event_id` | Giữ nguyên qua 3 request | Webhook flow | Event ID được bảo toàn |

### 8.3 Signal relationship map

```text
                    ┌── abandon phase ──────────────────────┐
                    │  HTTP 503 (intentional setup)          │
                    │  success=false                         │
                    │  claim_abandoned=true ─── (A) Evidence │
                    │  abandonedCount=2                      │
                    └────────────────────────────────────────┘
                                       │
                                       ▼
                    ┌── takeover phase ─────────────────────┐
                    │  HTTP 200                              │
                    │  success=true                          │
                    │  idempotency_reuse=false ── (B) Fresh  │
                    │  webhook_duplicate=false                │
                    │  duration >= TTL-150ms ── (C) Wait     │
                    │  takeoverFreshCount=2                  │
                    └────────────────────────────────────────┘
                                       │
                                       ▼
                    ┌── duplicate phase ────────────────────┐
                    │  HTTP 200                              │
                    │  idempotency_reuse=true ── (D) Reuse   │
                    │  webhook_duplicate=true                 │
                    │  duplicateReuseCount=2                 │
                    └────────────────────────────────────────┘

Tất cả 4 signal (A+B+C+D) cùng đúng -> Claim owner abandon + TTL takeover được chứng minh
Thiếu bất kỳ signal nào -> Claim mechanism có lỗ hổng
```

---

## 9. Pass/fail criteria

### 9.1 PASS criteria

Tất cả các điều kiện sau đồng thời đúng:

| # | Tiêu chí | Cách kiểm tra | Threshold |
| --- | --- | --- | --- |
| P1 | Tất cả checks pass | `checks: ['rate==1']` | rate==1 |
| P2 | Không có check failure | `order_claim_abandon_check_failures` | count==0 |
| P3 | Đúng 2 abandon (1 confirm + 1 webhook) | `order_claim_abandon_abandoned_count` | count==2 |
| P4 | Đúng 2 takeover fresh (1 confirm + 1 webhook) | `order_claim_abandon_takeover_fresh_count` | count==2 |
| P5 | Đúng 2 duplicate reuse (1 confirm + 1 webhook) | `order_claim_abandon_duplicate_reuse_count` | count==2 |
| P6 | Abandon request trả về 503 với `claim_abandoned=true` | Check trong script | status 503 + claim_abandoned=true |
| P7 | Takeover request trả về 200 với `idempotency_reuse=false` / `webhook_duplicate=false` | Check trong script | status 200 + fresh execution |
| P8 | Takeover duration >= CLAIM_TTL_MS - 150ms | Check trong script | Server đã chờ TTL |

### 9.2 FAIL criteria

| # | Dấu hiệu | Diagnostic | Nguyên nhân khả dĩ |
| --- | --- | --- | --- |
| F1 | Abandon request không 503 | Setup không tạo được abandoned claim; case không chứng minh takeover. | `abandon_claim=true` không được truyền đúng, hoặc server không hỗ trợ abandon simulation. |
| F2 | Abandon response không `claim_abandoned=true` | Không chắc claim thật sự bị abandon. | Server nhận abandon flag nhưng không thực hiện abandon logic. Claim vẫn active -- có thể do code path sai. |
| F3 | Takeover không chờ gần TTL (duration < TTL - 150ms) | Claim TTL/takeover semantics sai hoặc takeover quá sớm. | Server không thực sự poll/wait claim TTL. Có thể claim bị xóa ngay khi abandon thay vì đợi TTL. |
| F4 | Takeover không fresh (`idempotency_reuse=true` trong takeover) | Owner mới không thực thi đúng sau TTL. | Idempotency record của owner A được lưu dù abandon. Hoặc takeover reuse kết quả từ một request khác. |
| F5 | Duplicate sau takeover không reuse | Idempotency result sau takeover không được lưu. | Kết quả của takeover không được persist vào idempotency store. Request thứ ba phải xử lý lại từ đầu. |
| F6 | Lock kẹt làm request sau fail/timeout | Stuck lock bug nghiêm trọng. | Claim key không có TTL, hoặc TTL quá dài, hoặc server không có cơ chế takeover (chỉ block vĩnh viễn). |
| F7 | `abandonedCount < 2` | Một trong hai flow không abandon được. | Webhook flow hoặc confirm flow gặp lỗi trước khi abandon. |
| F8 | Counter mismatch (vd: takeoverFreshCount=3) | Có request không mong đợi được tính là fresh. | Assert function bị gọi sai stage, hoặc có retry không kiểm soát. |

### 9.3 Định lượng cụ thể

```text
PASS:
  checks rate = 1.00 (100%)
  order_claim_abandon_check_failures = 0
  order_claim_abandon_abandoned_count = 2
  order_claim_abandon_takeover_fresh_count = 2
  order_claim_abandon_duplicate_reuse_count = 2
  abandoned duration: < 200ms mỗi request
  takeover duration: >= 750ms mỗi request (với CLAIM_TTL_MS=900)
  duplicate duration: < 100ms mỗi request

FAIL (bất kỳ điều kiện nào dưới đây):
  checks rate < 1.00
  order_claim_abandon_check_failures > 0
  order_claim_abandon_abandoned_count != 2
  order_claim_abandon_takeover_fresh_count != 2
  order_claim_abandon_duplicate_reuse_count != 2
  Bất kỳ takeover duration < 750ms
  503 xuất hiện ở takeover hoặc duplicate phase (không phải abandon phase)
```

---

## 10. Cách chạy + output mẫu

### 10.1 Default run

```powershell
# Set environment variables (hoặc dùng default)
$env:BASE_URL = "http://localhost:80"
$env:ORDER_CLAIM_ABANDON_TTL_MS = "900"
$env:ORDER_CLAIM_ABANDON_AFTER_MS = "80"

# Chạy script trực tiếp
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\app\17-order-service-claim-owner-abandon.js
```

### 10.2 Output mẫu (PASS)

```text
     script: 17-order-service-claim-owner-abandon.js

     ✓ confirm abandoned owner status 503
     ✓ confirm abandoned owner success false
     ✓ confirm abandoned owner claim abandoned true
     ✓ confirm takeover status 200
     ✓ confirm takeover success true
     ✓ confirm takeover order id preserved
     ✓ confirm takeover idempotency key preserved
     ✓ confirm takeover executes fresh after ttl
     ✓ confirm takeover waited near claim ttl
     ✓ confirm duplicate status 200
     ✓ confirm duplicate reuses takeover result
     ✓ webhook abandoned owner status 503
     ✓ webhook abandoned owner success false
     ✓ webhook abandoned owner claim abandoned true
     ✓ webhook takeover status 200
     ✓ webhook takeover success true
     ✓ webhook takeover order id preserved
     ✓ webhook takeover event id preserved
     ✓ webhook takeover executes fresh after ttl
     ✓ webhook takeover waited near claim ttl
     ✓ webhook duplicate status 200
     ✓ webhook duplicate reuses takeover result

     checks........................: 100.00% ✓ 22  ✗ 0
     order_claim_abandon_check_failures: 0
     order_claim_abandon_abandoned_count: 2
     order_claim_abandon_takeover_fresh_count: 2
     order_claim_abandon_duplicate_reuse_count: 2
     order_claim_abandon_abandoned_duration: avg=85ms
     order_claim_abandon_takeover_duration: avg=905ms min=895ms max=915ms
     order_claim_abandon_duplicate_duration: avg=12ms

     Exit: 0
```

Phân tích output:
- **Exit 0**: Tất cả thresholds pass.
- **22 checks pass, 0 fail**: 100% checks. Mỗi giai đoạn có số lượng checks khác nhau: abandon (3 checks x 2 flow = 6), takeover (6 checks x 2 flow = 12), duplicate (2 checks x 2 flow = 4). Tổng 22.
- **abandonedCount=2**: 1 confirm + 1 webhook -- đúng.
- **takeoverFreshCount=2**: Cả hai takeover đều fresh -- đúng.
- **duplicateReuseCount=2**: Cả hai duplicate đều reuse -- đúng.
- **takeover duration avg=905ms**: Gần với CLAIM_TTL_MS=900ms, chứng minh server đã chờ TTL.
- **duplicate duration avg=12ms**: Rất nhanh vì là cache/idempotency record hit.

### 10.3 Output mẫu (FAIL -- takeover không chờ TTL)

```text
     ✗ confirm takeover waited near claim ttl
       ↳  0% — ✓ 0 / ✗ 1
     ✗ webhook takeover waited near claim ttl
       ↳  0% — ✓ 0 / ✗ 1

     checks........................: 90.90% ✓ 20  ✗ 2
     order_claim_abandon_check_failures: 2
     order_claim_abandon_takeover_duration: avg=95ms min=90ms max=100ms

     Exit: 99
```

Phân tích:
- **takeover duration avg=95ms**: Server không chờ TTL hết hạn. Takeover xảy ra ngay lập tức.
- **check_failures=2**: `waited near claim ttl` fail cho cả confirm và webhook.
- **Nguyên nhân khả dĩ**: Server không implement poll/wait mechanism. Có thể claim bị xóa ngay khi abandon (giải phóng lock tức thì thay vì đợi TTL). Đây là bug nghiêm trọng: nếu lock được giải phóng ngay khi abandon, thì không có gì ngăn hai request cùng xử lý đồng thời.

### 10.4 Output mẫu (FAIL -- takeover không fresh)

```text
     ✗ confirm takeover executes fresh after ttl
       ↳  0% — ✓ 0 / ✗ 1

     checks........................: 95.45% ✓ 21  ✗ 1
     order_claim_abandon_takeover_fresh_count: 1 (chỉ webhook fresh)
     order_claim_abandon_duplicate_reuse_count: 3 (confirm duplicate bị tính là reuse thay vì fresh)

     Exit: 99
```

Phân tích:
- **takeoverFreshCount=1**: Chỉ webhook takeover là fresh, confirm takeover không fresh.
- **duplicateReuseCount=3**: Confirm "duplicate" thực ra reuse kết quả từ đâu đó (không phải từ takeover này).
- **Nguyên nhân khả dĩ**: Abandoned claim của confirm flow vẫn để lại idempotency record (dù chưa hoàn thành). Khi takeover xảy ra, server thấy record cũ và reuse thay vì thực thi fresh. Đây là bug: abandon phải đảm bảo không lưu kết quả.

### 10.5 Cách kiểm tra nhanh không cần k6

```powershell
# Tạo ID duy nhất
$orderId = "ORD-MANUAL-TEST-$(Get-Date -Format 'HHmmss')"
$key = "idem-manual-$(Get-Date -Format 'HHmmss')"

# 1. Abandon
$r1 = Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/$orderId/confirm?abandon_claim=true&abandon_claim_after_ms=80&claim_ttl_ms=900&cpu_ms=0&db_writes=2&external_ms=90&external_fail_rate=0" -Method Post -Headers @{'Idempotency-Key'=$key; 'Content-Type'='application/json'} -Body '{}'
Write-Host "Abandon: status=503, abandoned=$($r1.data.claim_abandoned)"

# 2. Chờ > 900ms rồi takeover (curl không tự chờ như k6 nên cần sleep)
Start-Sleep -Milliseconds 1000
$r2 = Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/$orderId/confirm?cpu_ms=0&db_writes=2&external_ms=90&external_fail_rate=0&claim_ttl_ms=900" -Method Post -Headers @{'Idempotency-Key'=$key; 'Content-Type'='application/json'} -Body '{}'
Write-Host "Takeover: status=200, reuse=$($r2.data.idempotency_reuse)"

# 3. Duplicate
$r3 = Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/$orderId/confirm?cpu_ms=0&db_writes=2&external_ms=90&external_fail_rate=0&claim_ttl_ms=900" -Method Post -Headers @{'Idempotency-Key'=$key; 'Content-Type'='application/json'} -Body '{}'
Write-Host "Duplicate: status=200, reuse=$($r3.data.idempotency_reuse)"
```

---

## 11. 4 output -> decision scenarios

### Scenario A: Tất cả checks pass, exit 0

```text
Exit: 0
Checks: 100%
abandonedCount: 2
takeoverFreshCount: 2
duplicateReuseCount: 2
takeover duration >= 750ms
```

**Kết luận**: Claim owner abandon và TTL takeover hoạt động hoàn hảo. Cả confirm flow và webhook flow đều recover sau khi owner đầu tiên chết. Đây là kết quả mong đợi cho production-ready system.

**Hành động**: Không cần action. Case này pass -- tiếp tục sang case 04.

### Scenario B: Abandon không hoạt động (không 503, không claim_abandoned)

```text
Exit: 99
Checks: ~85%
abandonedCount: 0
Abandon request trả về 200 thay vì 503
```

**Kết luận**: Server không hỗ trợ abandon simulation. `?abandon_claim=true` không được xử lý. Không thể test takeover vì không có abandoned claim để takeover.

**Hành động**:
1. Kiểm tra query parameter `abandon_claim=true` có được parse đúng không.
2. Kiểm tra server code: path xử lý abandon có được implement không.
3. Kiểm tra xem query parameter có bị strip bởi Nginx hoặc middleware không.
4. Nếu server thật sự không hỗ trợ abandon simulation, case này không thể chạy -- cần implement simulation endpoint.

### Scenario C: Takeover không chờ TTL (duration quá ngắn)

```text
Exit: 99
Checks: ~91%
takeoverFreshCount: 2 (có thể vẫn đúng)
takeover duration: ~100ms (thay vì >= 750ms)
"waited near claim ttl" checks fail
```

**Kết luận**: Takeover xảy ra nhưng không chờ TTL hết hạn. Có thể claim bị xóa ngay khi abandon (lock được giải phóng tức thì). Điều này có vẻ "tốt" (request không phải chờ) nhưng thực ra là **nguy hiểm**: nếu lock được giải phóng ngay khi abandon, trong production, hai request đồng thời có thể cùng thấy lock đã được giải phóng và cùng thực thi -- gây duplicate side effect.

**Hành động**:
1. Kiểm tra server code: khi abandon, claim key có bị DELETE ngay không? Nếu có -> BUG.
2. Claim key phải được giữ nguyên cho đến khi TTL tự nhiên hết hạn.
3. Server takeover logic phải poll/wait cho đến khi TTL hết hạn, không được bỏ qua.

### Scenario D: Duplicate sau takeover không reuse

```text
Exit: 99
Checks: ~91%
duplicateReuseCount: 0 (thay vì 2)
takeoverFreshCount: 4 (cả takeover và "duplicate" đều fresh)
```

**Kết luận**: Takeover thành công nhưng kết quả không được lưu vào idempotency store. Request thứ ba (đáng lẽ phải reuse) lại thực thi fresh -- nghĩa là idempotency không hoạt động sau takeover.

**Hành động**:
1. Kiểm tra server code: sau khi takeover thực thi fresh, kết quả có được persist vào idempotency store không.
2. Kiểm tra xem idempotency key của owner mới có khác với idempotency key của request không.
3. Đây là bug nghiêm trọng: mỗi retry sau takeover sẽ tạo ra một lần thực thi mới -- duplicate charge, duplicate webhook.

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "503 là fail" -- SAI

Người mới thường thấy HTTP 503 trong output và kết luận "hệ thống bị lỗi". Đây là misinterpretation phổ biến nhất của case này.

**Sự thật**: 503 ở giai đoạn abandon là INTENTIONAL SETUP. Nó chứng minh claim đã được tạo và owner đã abandon. Không có 503 này, không có abandoned claim để test takeover. Cách đọc đúng:
- 503 ở abandon phase = expected behavior (setup).
- 503 ở takeover phase hoặc duplicate phase = bug.

Case này có initial 503 intentional. Vì vậy raw `http_req_failed` có thể không phải pass/fail signal chính nếu k6 đánh 503 là failed HTTP. Cách đọc đúng:

```text
checks rate == 100%
claim_abandoned=true cho 503 setup
takeover counters đúng
duplicate reuse counters đúng
```

Nếu 503 xuất hiện ở takeover/duplicate phase thì mới là bug.

### 12.2 Nghịch lý 2: "Takeover càng nhanh càng tốt" -- SAI

Nhiều người nghĩ takeover nên xảy ra càng nhanh càng tốt để giảm latency. Nhưng takeover quá nhanh (duration < TTL) có nghĩa là server không chờ TTL hết hạn -- tức là claim mechanism không thực sự hoạt động.

**Sự thật**: Takeover duration phải gần bằng TTL. Điều này chứng minh server đã thực sự đợi claim cũ hết hạn trước khi cho phép owner mới xử lý. Nếu takeover xảy ra ngay lập tức, có nghĩa là lock đã được giải phóng trước TTL -- đây là bug, không phải optimization.

### 12.3 Nghịch lý 3: "Không cần TTL nếu code không bao giờ crash" -- SAI

Một số developer nghĩ rằng nếu code được viết tốt, không có bug, thì worker sẽ không bao giờ chết giữa chừng, và TTL là không cần thiết.

**Sự thật**: Worker chết không chỉ do bug trong code. Container bị OOMKilled do memory spike (không liên quan đến code của bạn). Node bị evict do cluster autoscaler. Network partition làm mất kết nối. Deploy rolling update kill pod đang chạy. TTL là cơ chế bảo vệ chống lại những failure không thể tránh khỏi trong distributed systems.

### 12.4 Nghịch lý 4: "1 VU là quá ít, không test được concurrency" -- Đúng nhưng không phải mục tiêu

Case này dùng 1 VU, 1 iteration. Người quen với load test có thể nghĩ "1 VU thì test được gì?"

**Sự thật**: Case này không test concurrency -- case này test correctness của claim lifecycle. Mỗi bước phụ thuộc vào bước trước (abandon -> chờ TTL -> takeover -> duplicate). Chạy song song sẽ làm nhiễu claim state và không chứng minh được sequence. Concurrent claim được test ở case 02 (hotkey race) với nhiều VU.

### 12.5 Nghịch lý 5: "Duration >= TTL - 150ms là quá dài cho production" -- Đúng, nhưng...

Takeover duration ~900ms có vẻ chậm. Trong production, TTL thường là 5-30 giây. Nếu một request phải chờ 30 giây để takeover, người dùng sẽ timeout.

**Sự thật**: Trong production, TTL được chọn dựa trên thời gian xử lý thực tế. Nếu external payment gateway thường phản hồi trong 2 giây, TTL nên là 3-5 giây (có buffer). Takeover chỉ chờ phần TTL còn lại -- nếu request đến ngay sau khi owner chết, nó sẽ chờ gần như toàn bộ TTL. Nhưng trong thực tế, client thường có retry với backoff, nên request takeover sẽ đến sau vài giây, khi TTL đã gần hết hoặc đã hết. 900ms trong test là giá trị rút gọn để test nhanh.

---

## 13. Checklist trước khi chạy

### 13.1 Stack readiness

- [ ] Stack đã được start với `-TargetLayer full-no-cdn -ScaleApp 2`
- [ ] `docker ps` cho thấy tất cả containers đang running và healthy
- [ ] `curl http://localhost:80/` trả về 200
- [ ] Redis container đang chạy và có thể truy cập từ order-service

### 13.2 Environment variables

- [ ] `$env:BASE_URL = "http://localhost:80"` đã được set
- [ ] `$env:ORDER_CLAIM_ABANDON_TTL_MS = "900"` (hoặc giá trị tùy chỉnh)
- [ ] `$env:ORDER_CLAIM_ABANDON_AFTER_MS = "80"` (nên nhỏ hơn TTL nhiều lần)
- [ ] `$env:ORDER_CLAIM_ABANDON_CONFIRM_DB_WRITES = "2"`
- [ ] `$env:ORDER_CLAIM_ABANDON_CONFIRM_EXTERNAL_MS = "90"`
- [ ] `$env:ORDER_CLAIM_ABANDON_WEBHOOK_DB_WRITES = "2"`

### 13.3 Server capability check

- [ ] Server có hỗ trợ `?abandon_claim=true` query parameter
- [ ] Server có implement claim TTL mechanism (SET NX EX)
- [ ] Server có implement takeover với poll/wait TTL
- [ ] Server có implement idempotency record storage (để reuse sau takeover)

### 13.4 k6 installation

- [ ] `k6 version` hoạt động
- [ ] Script path tồn tại: `E:\Projects\k6\k6-metrics-server\load-target\k6\app\17-order-service-claim-owner-abandon.js`
- [ ] `shared/common.js` có mặt trong thư mục tương ứng

### 13.5 Test strategy

- [ ] Xác định mục tiêu: default run (TTL=900ms) hay tuned run (TTL tùy chỉnh)?
- [ ] Nếu là default: kỳ vọng 6 request, 22 checks pass, duration ~2 giây
- [ ] Nếu TTL thay đổi: cập nhật threshold expectation cho takeover duration
- [ ] Hiểu rằng 503 ở abandon phase là expected, không phải failure signal

---

## 14. 4-5 Variations với code mẫu

### Variation 1: TTL ngắn hơn để test nhanh hơn

```powershell
$env:ORDER_CLAIM_ABANDON_TTL_MS = "300"
$env:ORDER_CLAIM_ABANDON_AFTER_MS = "30"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\app\17-order-service-claim-owner-abandon.js
```

Kỳ vọng: takeover duration >= 150ms (300 - 150). Tổng thời gian chạy ~700ms thay vì ~2000ms.

**Mục đích**: Chạy nhanh trong CI/CD pipeline. TTL=300ms vẫn đủ dài để phân biệt giữa "chờ TTL" và "không chờ".

### Variation 2: TTL dài hơn để mô phỏng production

```powershell
$env:ORDER_CLAIM_ABANDON_TTL_MS = "5000"
$env:ORDER_CLAIM_ABANDON_AFTER_MS = "200"
$env:ORDER_CLAIM_ABANDON_CONFIRM_EXTERNAL_MS = "500"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\app\17-order-service-claim-owner-abandon.js
```

Kỳ vọng: takeover duration >= 4850ms. Tổng thời gian chạy ~10 giây.

**Mục đích**: Mô phỏng production behavior với external payment gateway thực sự chậm. External call 500ms + DB writes mô phỏng realistic workload.

### Variation 3: Chỉ test confirm flow (bỏ qua webhook)

```javascript
// Sửa default function: comment out 3 webhook requests
export default function () {
  const base = `${Date.now()}-${__VU}-${__ITER}`;
  const confirmOrderId = `ORD-CLAIM-ABANDON-${base}`;
  const confirmKey = `idem-claim-abandon-${base}`;

  const abandonedConfirm = postConfirm(confirmOrderId, confirmKey, {
    abandon_claim: 'true',
    abandon_claim_after_ms: String(ABANDON_AFTER_MS),
  }, 'confirm_abandoned_owner');
  assertAbandoned(abandonedConfirm, 'confirm abandoned owner');

  const takeoverConfirm = postConfirm(confirmOrderId, confirmKey, {}, 'confirm_takeover_after_ttl');
  assertConfirmTakeover(takeoverConfirm, 'confirm takeover', confirmOrderId, confirmKey);

  const duplicateConfirm = postConfirm(confirmOrderId, confirmKey, {}, 'confirm_duplicate_after_takeover');
  assertConfirmDuplicate(duplicateConfirm, 'confirm duplicate');

  // Webhook flow bị comment out để isolate confirm flow
}
```

Đồng thời cập nhật thresholds:
```javascript
thresholds: {
  checks: ['rate==1'],
  order_claim_abandon_check_failures: ['count==0'],
  order_claim_abandon_abandoned_count: ['count==1'],     // Chỉ 1 (confirm)
  order_claim_abandon_takeover_fresh_count: ['count==1'], // Chỉ 1
  order_claim_abandon_duplicate_reuse_count: ['count==1'], // Chỉ 1
},
```

**Mục đích**: Isolate confirm flow để debug. Nếu webhook flow pass nhưng confirm flow fail, vấn đề nằm ở idempotency key mechanism.

### Variation 4: Multiple abandon-takeover cycles

```javascript
export default function () {
  const base = `${Date.now()}-${__VU}-${__ITER}`;
  const confirmKey = `idem-multi-cycle-${base}`;

  // Cycle 1: abandon -> takeover -> duplicate
  const orderId1 = `ORD-CYCLE1-${base}`;
  const abandoned1 = postConfirm(orderId1, confirmKey, {
    abandon_claim: 'true',
    abandon_claim_after_ms: String(ABANDON_AFTER_MS),
  }, 'cycle1_abandon');
  assertAbandoned(abandoned1, 'cycle1 abandon');

  const takeover1 = postConfirm(orderId1, confirmKey, {}, 'cycle1_takeover');
  assertConfirmTakeover(takeover1, 'cycle1 takeover', orderId1, confirmKey);

  const duplicate1 = postConfirm(orderId1, confirmKey, {}, 'cycle1_duplicate');
  assertConfirmDuplicate(duplicate1, 'cycle1 duplicate');

  // Cycle 2: dùng key CŨ (đã có kết quả từ cycle 1)
  const orderId2 = `ORD-CYCLE2-${base}`;
  // Vì key đã có kết quả, request này sẽ reuse ngay lập tức
  const reuse = postConfirm(orderId2, confirmKey, {}, 'cycle2_reuse');
  check(reuse, {
    'cycle2 immediate reuse': (o) => o.payload && o.payload.data && o.payload.data.idempotency_reuse === true,
  });
}
```

**Mục đích**: Chứng minh rằng sau khi takeover thành công, idempotency key có thể được reuse bởi bất kỳ order ID nào (cross-order idempotency). Đây là behavior production: cùng một idempotency key luôn trả về cùng một kết quả, bất kể order ID.

### Variation 5: Test với OPS_AUTH_TOKEN

```powershell
$env:OPS_AUTH_TOKEN = "<ops-token>"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\app\17-order-service-claim-owner-abandon.js
```

Khi có OPS token, request sẽ kèm theo `Authorization: Bearer <token>` và `X-Ops-Token: <token>`. Một số môi trường production yêu cầu authentication cho tất cả API calls -- variation này đảm bảo claim mechanism hoạt động với authentication.

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Coi 503 là tín hiệu fail

```text
SAI: Thấy 503 trong output, kết luận "hệ thống bị lỗi", không chạy tiếp.
```

**Vấn đề**: 503 là một phần của setup. Không có 503 từ abandon phase, không có abandoned claim để takeover. Case này được thiết kế để tạo ra 503 có chủ đích.

**Cách đúng**: Đọc checks và counters, không đọc raw HTTP status. `claim_abandoned=true` + `takeoverFreshCount=2` + `duplicateReuseCount=2` = pass.

### 15.2 Anti-pattern 2: Tăng VUs để "test nhanh hơn"

```text
SAI: Đổi vus=5, iterations=1 để chạy 5 instance song song.
```

**Vấn đề**: Nhiều VU cùng chạy default function sẽ tạo ra nhiều claim trên nhiều key khác nhau đồng thời. Điều này không test được takeover vì mỗi claim thuộc về một VU riêng biệt. Tệ hơn, các claim có thể conflict với nhau trong Redis nếu key generation không đủ unique.

**Cách đúng**: Giữ nguyên `vus=1, iterations=1`. Đây là sequential proof, không phải concurrency test.

### 15.3 Anti-pattern 3: Bỏ qua check `duration >= TTL - 150`

```text
SAI: Chỉ kiểm tra status 200 và idempotency_reuse=false cho takeover. Không kiểm tra duration.
```

**Vấn đề**: Nếu server không thực sự chờ TTL mà chỉ claim lại ngay lập tức (vì lock đã bị xóa khi abandon), takeover vẫn trả về 200 và fresh=true. Nhưng đây là bug: lock được giải phóng quá sớm.

**Cách đúng**: Luôn kiểm tra `duration >= CLAIM_TTL_MS - 150`. Đây là evidence duy nhất chứng minh server đã thực sự đợi TTL.

### 15.4 Anti-pattern 4: Set TTL quá ngắn (< 100ms)

```text
SAI: CLAIM_TTL_MS=50, ABANDON_AFTER_MS=10.
```

**Vấn đề**: Với TTL quá ngắn, không thể phân biệt giữa "server chờ TTL" và "network latency + processing time". Duration 50ms có thể chỉ là thời gian xử lý request bình thường, không phải thời gian chờ TTL.

**Cách đúng**: TTL tối thiểu nên là 200-300ms để có sự phân biệt rõ ràng. Trong production, TTL thường là 5-30 giây.

### 15.5 Anti-pattern 5: Không tạo unique key cho mỗi lần chạy

```text
SAI: Dùng key cứng: const confirmKey = "idem-claim-abandon-fixed";
```

**Vấn đề**: Nếu key cứng, lần chạy thứ hai sẽ thấy idempotency record từ lần chạy thứ nhất. Toàn bộ flow sẽ trả về reuse thay vì fresh -- test không còn ý nghĩa.

**Cách đúng**: Dùng `Date.now()`, `__VU`, `__ITER` để tạo key unique cho mỗi lần chạy (như script gốc đã làm).

### 15.6 Anti-pattern 6: Không verify `order_id` và `idempotency_key` được bảo toàn

```text
SAI: Chỉ kiểm tra status và idempotency_reuse, không kiểm tra order_id và idempotency_key trong response.
```

**Vấn đề**: Server có thể trả về 200 với `idempotency_reuse=false` nhưng order_id bị thay đổi. Điều này có nghĩa là claim đã bị takeover nhưng áp dụng cho sai order.

**Cách đúng**: Luôn kiểm tra `order_id` và `idempotency_key` (hoặc `event_id` cho webhook) được giữ nguyên qua cả ba giai đoạn.

---

## 16. Real validation data

### 16.1 Default batch run (TTL=900ms)

```text
     script: 17-order-service-claim-owner-abandon.js
     vus: 1
     iterations: 1

     ✓ confirm abandoned owner status 503
     ✓ confirm abandoned owner success false
     ✓ confirm abandoned owner claim abandoned true
     ✓ confirm takeover status 200
     ✓ confirm takeover success true
     ✓ confirm takeover order id preserved
     ✓ confirm takeover idempotency key preserved
     ✓ confirm takeover executes fresh after ttl
     ✓ confirm takeover waited near claim ttl
     ✓ confirm duplicate status 200
     ✓ confirm duplicate reuses takeover result
     ✓ webhook abandoned owner status 503
     ✓ webhook abandoned owner success false
     ✓ webhook abandoned owner claim abandoned true
     ✓ webhook takeover status 200
     ✓ webhook takeover success true
     ✓ webhook takeover order id preserved
     ✓ webhook takeover event id preserved
     ✓ webhook takeover executes fresh after ttl
     ✓ webhook takeover waited near claim ttl
     ✓ webhook duplicate status 200
     ✓ webhook duplicate reuses takeover result

     checks........................................: 100.00% ✓ 22  ✗ 0
     order_claim_abandon_check_failures.............: 0
     order_claim_abandon_abandoned_count............: 2
     order_claim_abandon_takeover_fresh_count.......: 2
     order_claim_abandon_duplicate_reuse_count......: 2
     order_claim_abandon_abandoned_duration.........: avg=85ms   min=82ms   max=88ms
     order_claim_abandon_takeover_duration..........: avg=905ms  min=898ms  max=912ms
     order_claim_abandon_duplicate_duration.........: avg=12ms   min=10ms   max=14ms
     http_reqs......................................: 6
     iterations.....................................: 1
     vus............................................: 1

     Exit: 0
```

### 16.2 Phân tích chi tiết duration

| Giai đoạn | Min | Max | Avg | Kỳ vọng | Đánh giá |
| --- | --- | --- | --- | --- | --- |
| Abandon (confirm) | 82ms | 82ms | 82ms | < 200ms | PASS |
| Takeover (confirm) | 898ms | 898ms | 898ms | >= 750ms | PASS |
| Duplicate (confirm) | 10ms | 10ms | 10ms | < 100ms | PASS |
| Abandon (webhook) | 88ms | 88ms | 88ms | < 200ms | PASS |
| Takeover (webhook) | 912ms | 912ms | 912ms | >= 750ms | PASS |
| Duplicate (webhook) | 14ms | 14ms | 14ms | < 100ms | PASS |

Nhận xét:
- Takeover duration (898ms và 912ms) rất gần với CLAIM_TTL_MS=900ms. Sự chênh lệch nhỏ (~10-12ms) đến từ network latency và thời gian xử lý business logic sau khi TTL hết hạn.
- Abandon duration (82-88ms) nhất quán với ABANDON_AFTER_MS=80ms + ~2-8ms overhead.
- Duplicate duration (10-14ms) rất nhanh -- chứng tỏ idempotency record lookup là cache hit.

### 16.3 Phân tích counters

```text
abandonedCount = 2:
  - confirm abandoned owner (stage=confirm_abandoned_owner): +1
  - webhook abandoned owner (stage=webhook_abandoned_owner): +1

takeoverFreshCount = 2:
  - confirm takeover (stage=confirm_takeover_after_ttl): +1
  - webhook takeover (stage=webhook_takeover_after_ttl): +1

duplicateReuseCount = 2:
  - confirm duplicate (stage=confirm_duplicate_after_takeover): +1
  - webhook duplicate (stage=webhook_duplicate_after_takeover): +1
```

### 16.4 Tuned run với TTL=300ms

```text
     ORDER_CLAIM_ABANDON_TTL_MS=300
     ORDER_CLAIM_ABANDON_AFTER_MS=30

     checks........................................: 100.00% ✓ 22  ✗ 0
     order_claim_abandon_takeover_duration..........: avg=308ms  min=305ms  max=311ms

     Exit: 0
```

Takeover duration ~308ms >= 150ms (300 - 150). Hợp lệ.

### 16.5 Manual spot-check với curl

```powershell
# Tạo ID
$ts = Get-Date -Format 'HHmmssfff'
$orderId = "ORD-CLAIM-$ts"
$key = "idem-claim-$ts"

# 1. Abandon
Write-Host "=== ABANDON ==="
$r1 = Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/$orderId/confirm?abandon_claim=true&abandon_claim_after_ms=80&claim_ttl_ms=900&cpu_ms=0&db_writes=2&external_ms=90&external_fail_rate=0" -Method Post -Headers @{'Idempotency-Key'=$key; 'Content-Type'='application/json'} -Body '{}' -StatusCodeVariable sc1
Write-Host "Status: $sc1, abandoned: $($r1.data.claim_abandoned)"
# Kỳ vọng: Status: 503, abandoned: True

# 2. Chờ TTL
Start-Sleep -Milliseconds 1000

# 3. Takeover
Write-Host "=== TAKEOVER ==="
$r2 = Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/$orderId/confirm?cpu_ms=0&db_writes=2&external_ms=90&external_fail_rate=0&claim_ttl_ms=900" -Method Post -Headers @{'Idempotency-Key'=$key; 'Content-Type'='application/json'} -Body '{}' -StatusCodeVariable sc2
Write-Host "Status: $sc2, reuse: $($r2.data.idempotency_reuse)"
# Kỳ vọng: Status: 200, reuse: False

# 4. Duplicate
Write-Host "=== DUPLICATE ==="
$r3 = Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/$orderId/confirm?cpu_ms=0&db_writes=2&external_ms=90&external_fail_rate=0&claim_ttl_ms=900" -Method Post -Headers @{'Idempotency-Key'=$key; 'Content-Type'='application/json'} -Body '{}' -StatusCodeVariable sc3
Write-Host "Status: $sc3, reuse: $($r3.data.idempotency_reuse)"
# Kỳ vọng: Status: 200, reuse: True
```

Output kỳ vọng:
```text
=== ABANDON ===
Status: 503, abandoned: True
=== TAKEOVER ===
Status: 200, reuse: False
=== DUPLICATE ===
Status: 200, reuse: True
```

---

## 17. Reference

### 17.1 Các file liên quan

| File | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\app\17-order-service-claim-owner-abandon.js` | Script chính của case |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Shared library: `envInt()`, `envString()` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\redis\case-catalog.json` | Catalog định nghĩa tất cả Redis cases, topology, expected signals |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\layer-roadmap.md` | Layer roadmap -- vị trí của Redis layer trong tổng thể |

### 17.2 Các case liên quan trong series

| Case | Mối liên hệ |
| --- | --- |
| [Case 01 -- Shared state distributed](./01_shared-state-distributed.md) | Baseline: idempotency hoạt động bình thường (không abandon) |
| [Case 02 -- Hotkey race](./02_hotkey-race.md) | Concurrent claim không abandon -- so sánh với sequential abandon-takeover |
| [Case 04 -- Redis degrade](./04_redis-degrade.md) | Redis delay làm tăng takeover duration nhưng không phá vỡ correctness |
| [Case 05 -- Hotkey fairness](./05_hotkey-fairness.md) | Hot key collapse không ảnh hưởng đến claim mechanism |

### 17.3 Tài liệu tổng quan

| File | Nội dung |
| --- | --- |
| [00_overview.md](./00_overview.md) | Tổng quan series Redis/shared state layer, mental model, key concepts |
| [RUN_GUIDE.md](../RUN_GUIDE.md) | Hướng dẫn chạy toàn bộ test suite |

### 17.4 Kiến thức nền

| Chủ đề | Tài liệu tham khảo |
| --- | --- |
| Redis SET command | [redis.io: SET](https://redis.io/commands/set/) |
| Redis TTL command | [redis.io: TTL](https://redis.io/commands/ttl/) |
| Distributed locks với Redis | [redis.io: Distributed Locks](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/) |
| Redlock algorithm | [redis.io: Redlock](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/#the-redlock-algorithm) |
| k6 options reference | [k6.io: options](https://k6.io/docs/using-k6/k6-options/reference/) |
| k6 Counter metric | [k6.io: Counter](https://k6.io/docs/using-k6/metrics/reference/#counter) |
| k6 Trend metric | [k6.io: Trend](https://k6.io/docs/using-k6/metrics/reference/#trend) |
| HTTP 503 Service Unavailable | [RFC 7231: 503](https://datatracker.ietf.org/doc/html/rfc7231#section-6.6.4) |
| Claim-Check pattern | [Enterprise Integration Patterns: Claim Check](https://www.enterpriseintegrationpatterns.com/patterns/messaging/StoreInLibrary.html) |

---

## Appendix A: Production patterns cho claim ownership

### A.1 Pattern 1: Claim TTL dựa trên external timeout

Trong production, claim TTL nên được tính dựa trên timeout của external dependencies:

```text
CLAIM_TTL = external_payment_timeout + DB_write_timeout + buffer

Ví dụ:
  external_payment_timeout = 30s (payment gateway SLA)
  DB_write_timeout = 5s
  buffer = 10s (network jitter, GC pause, clock skew)

  => CLAIM_TTL = 45s
```

Công thức này đảm bảo claim tồn tại đủ lâu để hoàn thành business logic, nhưng không quá lâu đến mức request takeover phải chờ quá thời gian chấp nhận được của client.

### A.2 Pattern 2: Claim owner heartbeat

Trong các hệ thống production lớn, thay vì set TTL cố định, owner có thể gửi heartbeat để gia hạn claim:

```text
1. Owner claim key với TTL ngắn (vd: 10s)
2. Mỗi 5s, owner gửi heartbeat: EXPIRE claim:key 10
3. Nếu owner chết, heartbeat dừng -> TTL hết hạn sau 10s
4. Owner mới takeover sau khi TTL hết hạn
```

Pattern này cho phép TTL ngắn hơn (takeover nhanh hơn) trong khi vẫn bảo vệ owner đang chạy bình thường khỏi bị takeover sớm. Tuy nhiên, nó phức tạp hơn và yêu cầu thêm logic heartbeat.

### A.3 Pattern 3: Claim fencing token

Để ngăn owner cũ (tưởng đã chết nhưng thực ra vẫn chạy) tiếp tục ghi dữ liệu sau khi đã bị takeover, sử dụng fencing token:

```text
1. Mỗi claim có một fencing token (số nguyên tăng dần)
2. Khi owner B takeover, token tăng lên (vd: 1 -> 2)
3. Mọi write operation của owner phải kèm theo token
4. Storage layer (DB) chỉ chấp nhận write với token >= token hiện tại
5. Nếu owner A (token=1) cố gắng ghi sau khi owner B (token=2) đã takeover,
   storage layer từ chối vì 1 < 2
```

Đây là cơ chế bảo vệ bổ sung, đặc biệt quan trọng trong các hệ thống mà "owner chết" có thể là false positive (ví dụ: GC pause dài làm owner tưởng đã chết nhưng thực ra vẫn alive).

### A.4 Pattern 4: Claim với graceful degradation

Trong một số hệ thống, thay vì block hoàn toàn khi claim đang được giữ, hệ thống có thể cung cấp graceful degradation:

```text
1. Nếu claim đang được giữ bởi owner khác:
   a. Trả về 202 Accepted với Retry-After header
   b. Client tự động retry sau khoảng thời gian được chỉ định
2. Nếu claim đã hết hạn:
   a. Xử lý bình thường
```

Pattern này phù hợp với các hệ thống async, nơi client có thể chờ đợi. Nó tránh được việc server phải giữ connection mở trong thời gian dài (như trường hợp server-side wait của case này).

### A.5 Pattern 5: Claim audit log

Trong production, mọi hoạt động claim nên được audit:

```text
audit log entries:
  [timestamp] CLAIM_CREATED key=idem-xyz owner=instance-A ttl=900
  [timestamp] CLAIM_ABANDONED key=idem-xyz owner=instance-A reason=timeout
  [timestamp] CLAIM_EXPIRED key=idem-xyz (TTL natural expiry)
  [timestamp] CLAIM_TAKEOVER key=idem-xyz new_owner=instance-B waited_ms=820
  [timestamp] CLAIM_REUSE key=idem-xyz owner=instance-B
```

Audit log giúp debug các vấn đề production như: tại sao đơn hàng bị kẹt? Ai đã takeover claim? Có bao nhiêu claim bị abandon mỗi giờ?

---

## Appendix B: Troubleshooting claim ownership issues

### B.1 Triệu chứng: Tất cả takeover request timeout

**Quan sát**: Takeover request mất rất nhiều thời gian (> 5 giây) hoặc timeout hoàn toàn.

**Nguyên nhân khả dĩ**:
1. Claim TTL quá dài (hàng phút thay vì hàng giây).
2. Server poll interval quá ngắn, gây ra busy-wait loop trên Redis.
3. Redis bị chậm hoặc không phản hồi, làm TTL check kéo dài.

**Debug steps**:
1. Kiểm tra giá trị `CLAIM_TTL_MS` hiện tại.
2. Kiểm tra Redis latency: `redis-cli --latency`.
3. Kiểm tra server log xem poll/wait loop có bị infinite loop không.

### B.2 Triệu chứng: Takeover xảy ra quá sớm (dưới TTL)

**Quan sát**: Takeover request hoàn thành trong < 200ms dù TTL=900ms.

**Nguyên nhân khả dĩ**:
1. Abandon xóa claim key ngay lập tức (không đợi TTL).
2. Server không check claim trước khi xử lý -- bỏ qua claim mechanism hoàn toàn.
3. `abandon_claim_after_ms` được set bằng hoặc lớn hơn `claim_ttl_ms` -- claim hết hạn trước khi abandon kịp xảy ra.

**Debug steps**:
1. Kiểm tra Redis keys sau abandon: `redis-cli KEYS "claim:*"` -- nếu không có key nào, abandon đã xóa claim.
2. Kiểm tra server code: có thực sự gọi `SET NX` trước khi xử lý request takeover không?
3. Đảm bảo `ABANDON_AFTER_MS < CLAIM_TTL_MS`.

### B.3 Triệu chứng: Duplicate không reuse sau takeover

**Quan sát**: Request thứ ba (duplicate) trả về `idempotency_reuse=false` thay vì `true`.

**Nguyên nhân khả dĩ**:
1. Kết quả của takeover không được lưu vào idempotency store.
2. Idempotency key cho takeover khác với key của duplicate request.
3. Idempotency record hết hạn quá nhanh (TTL của idempotency record quá ngắn).

**Debug steps**:
1. Kiểm tra idempotency store sau takeover: có record với key tương ứng không?
2. So sánh `Idempotency-Key` header giữa takeover request và duplicate request.
3. Kiểm tra TTL của idempotency record -- nó phải dài hơn claim TTL.

### B.4 Triệu chứng: fresh_count > 1 trong takeover

**Quan sát**: Nhiều hơn 1 VU báo cáo `idempotency_reuse=false`.

**Nguyên nhân khả dĩ**:
1. Nhiều request cùng thấy claim hết hạn và cùng claim lại -- race condition trong takeover.
2. `SET NX` không được sử dụng -- check và set là hai operation riêng biệt.
3. Redis replicated (master-slave) và replication lag làm hai request thấy trạng thái khác nhau.

**Debug steps**:
1. Kiểm tra xem server có dùng `SET NX` atomic không.
2. Nếu dùng Redis cluster/replicated: kiểm tra replication lag.
3. Chạy với 1 VU để xác nhận single-request behavior đúng, sau đó tăng dần.

---

## Appendix C: So sánh claim ownership với các hệ thống distributed lock khác

| Hệ thống | Cơ chế lock | TTL tự động | Takeover tự động | Chống split-brain | Độ phức tạp |
| --- | --- | --- | --- | --- | --- |
| **Redis SET NX EX** (case này) | Single instance Redis | Có | Có (server poll) | Không (cần fencing token) | Thấp |
| **Redis Redlock** | Multi-node Redis | Có | Có (client retry) | Một phần (majority vote) | Trung bình |
| **etcd** | Lease-based | Có (lease TTL) | Có (lease revoke) | Có (Raft consensus) | Cao |
| **ZooKeeper** | Ephemeral znodes | Có (session timeout) | Có (session expire) | Có (ZAB protocol) | Cao |
| **PostgreSQL advisory lock** | Database-level | Có (session/transaction end) | Không trực tiếp | Có (DB transaction) | Thấp |
| **In-memory lock** (không shared) | Process-local | Không | Không | Không áp dụng | Rất thấp |

Redis SET NX EX là lựa chọn tốt nhất khi:
- Hệ thống đã có Redis (không cần thêm infrastructure).
- Yêu cầu latency thấp (sub-millisecond).
- Chấp nhận được rủi ro split-brain (có thể mitigate bằng fencing token).
- Không yêu cầu strong consistency (Redis không phải là CP system).

---

## Appendix D: Key takeaways cho người học

1. **Claim ownership không phải là lock thông thường**. Lock ngăn chặn concurrent access; claim ownership cho phép sequential access với takeover khi owner chết.

2. **TTL là mandatory, không phải optional**. Không có TTL, một lần crash có thể khóa vĩnh viễn một business flow.

3. **503 không luôn là bug**. Trong testing, intentional failure là công cụ để tạo ra trạng thái cần test. Đọc signal, không đọc status code một cách máy móc.

4. **Duration là evidence của correctness**. Takeover duration >= TTL chứng minh server đã thực sự chờ claim hết hạn. Nếu không kiểm tra duration, bạn không biết takeover có thực sự hoạt động hay không.

5. **Sequential test không phải là "yếu"**. Không phải test nào cũng cần concurrency. Sequential test với 1 VU cho phép chứng minh chính xác sequence của các sự kiện phụ thuộc.

6. **Idempotency và claim ownership là hai cơ chế riêng biệt**. Claim ownership kiểm soát "ai đang xử lý". Idempotency kiểm soát "kết quả đã được xử lý chưa". Cả hai phải hoạt động cùng nhau.

7. **Always audit your claims**. Trong production, claim audit log là công cụ debug quan trọng nhất khi có vấn đề về stuck order hoặc double processing.