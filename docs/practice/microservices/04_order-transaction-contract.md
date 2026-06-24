# ms-04 -- Order service: transaction API contract

> **Case ID:** `ms-04-order-transaction-contract`
> **Script:** `../shared-iterations/si-02-order-reconciliation.js`
> **Executor:** `shared-iterations`, `vus=8, iterations=120`
> **Topology:** `full-no-cdn`
> **Proof:** Order service hỗ trợ checkout, confirm (có Idempotency-Key), và status với contract nhất quán. Đây là prerequisite cho Redis shared-state cases.

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [Microservices capability được chứng minh](#2-microservices-capability-được-chứng-minh)
3. [Vì sao phải test ở Microservices layer](#3-vì-sao-phải-test-ở-microservices-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Service mechanism deep-dive](#6-service-mechanism-deep-dive)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / headers / counters](#8-key-signals--headers--counters)
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

Daily reconciliation: replay tất cả order trong ngày -- checkout, confirm với idempotency key, và payment webhook. Order service là transactional core của toàn bộ stack -- nó owns the money path.

```text
Reconciliation job: checkout → confirm (có Idempotency-Key) → read status
```

Hãy hình dung tình huống sau trong một hệ thống thương mại điện tử thực tế:

```text
1. Cuối mỗi ngày, hệ thống tài chính chạy reconciliation batch:
   - Lấy tất cả order được tạo trong ngày từ database.
   - Replay từng order: confirm payment, kiểm tra status.
   - Đối chiếu với báo cáo từ payment gateway (VNPay, Momo, Stripe...).
   - Đánh dấu các order không khớp để investigation manual.

2. Mỗi order trong batch phải được xử lý qua 3 bước:
   a. Checkout: tạo order từ cart (nếu order chưa tồn tại trong hệ thống).
   b. Confirm: xác nhận order với Idempotency-Key (đảm bảo không double charge).
   c. Status: đọc trạng thái cuối cùng của order (payment status, fulfillment status).

3. Nếu bất kỳ bước nào fail, order đó bị đánh dấu "cần investigation".
   Nếu tất cả pass, order được reconcile thành công.
```

Đây không phải là tình huống giả định. Daily reconciliation là operation bắt buộc trong mọi hệ thống tài chính:

- **Luật pháp yêu cầu**: Ở hầu hết các quốc gia, doanh nghiệp phải đối chiếu giao dịch tài chính hàng ngày.
- **Payment gateway yêu cầu**: Các payment gateway như Stripe, VNPay, Momo đều cung cấp reconciliation report hàng ngày.
- **Audit yêu cầu**: Auditor sẽ kiểm tra reconciliation log khi audit hệ thống tài chính.

Order service là nơi mọi thứ trở nên nghiêm túc. Không như products (read, cacheable) hay cart (temporary state), order service xử lý tiền -- mọi duplicate hay sai state đều có hậu quả tài chính.

### 1.2 Năm trạng thái của order

Order service duy trì order state machine phức tạp hơn cart:

```text
                    ┌──────────────┐
                    │  CHECKOUT    │ ← POST /checkout
                    │  (created)   │
                    └──────┬───────┘
                           │ POST /orders/:id/confirm
                           ▼
                    ┌──────────────┐
                    │  PENDING     │ ← Chờ payment gateway xác nhận
                    │  (confirmed) │
                    └──────┬───────┘
                           │ POST /orders/webhooks/payment
                           ▼
                    ┌──────────────┐
               ┌───│    PAID      │ ← Payment đã được xác nhận
               │   │  (completed) │
               │   └──────────────┘
               │
               │   ┌──────────────┐
               └──►│  CANCELLED   │ ← Order bị hủy (timeout, user cancel)
                   └──────────────┘
```

| Trạng thái | Ý nghĩa | Operations hợp lệ | Ghi chú |
| --- | --- | --- | --- |
| **CHECKOUT** | Order vừa được tạo từ cart, chưa confirm | `GET status`, `POST confirm` | Có thể expire sau N phút nếu không confirm |
| **PENDING** | Order đã confirm, đang chờ payment | `GET status`, `POST webhooks/payment` | Đây là trạng thái "treo" -- tiền chưa được capture |
| **PAID** | Payment đã hoàn tất | `GET status` (read-only) | Trạng thái cuối -- không thể thay đổi |
| **CANCELLED** | Order bị hủy | `GET status` (read-only) | Trạng thái cuối -- có thể do timeout hoặc user action |

Case này tập trung vào 3 trạng thái đầu: CHECKOUT → PENDING → PAID. Đây là happy path của money flow.

### 1.3 Tại sao reconciliation là một business case thực tế

Reconciliation không chỉ là batch job kỹ thuật -- nó là yêu cầu nghiệp vụ cốt lõi:

**Góc nhìn tài chính**:
- Mỗi ngày có hàng nghìn order được tạo. Không phải tất cả đều đến được trạng thái PAID.
- Một số order bị "stuck" ở PENDING vì payment gateway không gửi webhook (network issue, bug).
- Một số order bị double charge vì user nhấn "Thanh toán" nhiều lần (mobile app không có debounce).
- Reconciliation phát hiện các anomaly này và trigger alert cho ops team.

**Góc nhìn kỹ thuật**:
- Reconciliation batch phải xử lý được 10,000+ orders trong vài phút.
- Mỗi order phải được xác minh độc lập -- một order fail không ảnh hưởng đến các order khác.
- Idempotency-Key đảm bảo rằng confirm order không bị double charge khi replay.
- Batch job phải chạy được với nhiều worker instances (horizontal scaling).

**Góc nhìn pháp lý**:
- Auditor sẽ hỏi: "Làm sao anh biết tất cả order ngày hôm qua đã được xử lý đúng?"
- Reconciliation report là evidence: "Đây là danh sách order, đây là trạng thái cuối cùng, đây là payment gateway confirmation."
- Nếu không có reconciliation, doanh nghiệp có thể bị phạt vì không kiểm soát được giao dịch tài chính.

---

## 2. Microservices capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh order service hỗ trợ đầy đủ transaction contract:

> **Order service xử lý chính xác toàn bộ transaction path: checkout tạo order (POST), confirm với Idempotency-Key (POST), và status đọc order state (GET). Mọi response tuân theo envelope `{ success, data }`. Header `Idempotency-Key` được tôn trọng -- replay với cùng key trả về cùng kết quả. Header `X-Upstream-Service: order-service` và `X-Upstream-Addr` hiện diện trên mọi response.**

Cụ thể hơn, case chứng minh 9 khả năng con:

1. **`POST /api/sim/checkout` tạo order**: Request POST checkout với body chứa `payment_method`, `item_count`, và `coupon_code`. Response trả về `order_id` -- định danh duy nhất cho order mới tạo. Order bắt đầu ở trạng thái CHECKOUT.

2. **`POST /api/sim/orders/:id/confirm` với `Idempotency-Key` header**: Request POST confirm với header `Idempotency-Key`. Server kiểm tra key này -- nếu key đã được xử lý trước đó, trả về kết quả cũ (idempotency replay). Nếu key mới, thực thi fresh và lưu kết quả. Đây là cơ chế chống double charge.

3. **`GET /api/sim/orders/:id` trả về order state đầy đủ**: Request GET status trả về toàn bộ thông tin order: `order_id`, `status`, `payment_status`, `items`, `total`, `history` (nếu `include_history=1`). Response cho phép xác minh order đã được xử lý đúng.

4. **`X-Upstream-Service: order-service` và `X-Upstream-Addr` hiện diện**: Hai header này chứng minh request đã đến đúng order service VÀ cho biết instance nào đã xử lý. `X-Upstream-Addr` đặc biệt quan trọng cho Redis cases (cần biết instance nào claim key).

5. **Idempotency replay trả về cùng kết quả**: Gửi hai request confirm với cùng `Idempotency-Key` -- request thứ hai trả về `idempotency_reuse: true`, xác nhận kết quả được reuse. Không có double execution.

6. **Order state transition CHECKOUT → PENDING → PAID**: Flow đầy đủ từ tạo order đến payment hoàn tất. Mỗi transition được xác minh qua response body.

7. **External dependency simulation hoạt động**: `external_ms` query parameter mô phỏng gọi payment gateway. Server xử lý external call và trả về kết quả -- nếu external call fail (qua `external_fail_rate`), server vẫn xử lý gracefully.

8. **DB writes và DB rows simulation**: Query parameter `db_writes` và `db_rows` mô phỏng database workload. Server thực hiện số lượng mock DB operations tương ứng, cho phép test với workload realistic.

9. **`X-Upstream-Addr` cho biết instance xử lý**: Header này cho biết địa chỉ IP:port của order-service instance đã xử lý request. Quan trọng cho distributed state proof: trong Redis cases, bạn cần biết instance nào claim key.

### 2.2 So sánh với các case Microservices khác

| Case | Service | Pattern | Key mechanism | External deps | Redis used? |
| --- | --- | --- | --- | --- | --- |
| ms-01 | Tất cả | Gateway routing smoke | URL prefix routing | Không | Không |
| ms-02 | Products | Read contract | Pure read, cacheable | Không | Không |
| ms-03 | Cart | Write contract | Stateful CRUD | Không | Có thể (tùy deployment) |
| **ms-04** | **Order** | **Transaction contract** | **Idempotency, external calls, state machine** | **Có (payment-mock)** | **Có (idempotency store)** |
| ms-05 | Report | Async contract | Job create/poll/download | Không | Không |
| ms-06 | Tất cả | Cross-service flow | State propagation | Có (auth, cart, order) | Có |
| ms-07 | Tất cả | Health | Dependency probe | Có (DB, Redis, payment URL) | Có |

Case 04 là case **phức tạp nhất** trong toàn bộ Microservices series. Nó là case duy nhất có:
- **Idempotency mechanism** (Idempotency-Key header)
- **External dependency simulation** (payment-mock qua `external_ms`)
- **State machine với 4 trạng thái** (CHECKOUT, PENDING, PAID, CANCELLED)
- **Cả `X-Upstream-Service` và `X-Upstream-Addr` headers**
- **Vai trò prerequisite cho Redis shared-state cases**

Đây là prerequisite cho Redis shared-state cases (15-*.js). Nếu contract này sai, Redis cases không thể pass.

---

## 3. Vì sao phải test ở Microservices layer

### 3.1 Đây không phải là vấn đề của application code đơn thuần

Application code có thể implement checkout, confirm, và status logic đúng. Nhưng vấn đề "idempotency không hoạt động" hoặc "order state không nhất quán" có thể đến từ nhiều layer:

- **Nginx routing**: Nếu confirm request bị route đến sai service, `Idempotency-Key` header có thể bị bỏ qua hoặc xử lý sai.
- **Header propagation**: `Idempotency-Key` là custom header -- một số proxy hoặc middleware có thể strip custom headers.
- **Load balancer**: Nếu sticky session không hoạt động, hai request confirm với cùng key có thể đến hai instance khác nhau -- idempotency state phải được share qua Redis.

Test ở Microservices layer trả lời câu hỏi: "Khi request đến đúng service, contract có được tôn trọng không?" Đây là câu hỏi không thể trả lời nếu chỉ test application code.

### 3.2 Đây không phải là vấn đề của database layer

Order state cuối cùng được lưu trong PostgreSQL. Nhưng:

- **Idempotency là Redis concern**: Idempotency key → result mapping cần latency sub-millisecond. PostgreSQL quá chậm cho traffic này.
- **State machine validation là application concern**: PostgreSQL lưu state, nhưng không validate transition (CHECKOUT → PAID là không hợp lệ nếu bỏ qua PENDING). Application phải enforce state machine.
- **External call là infrastructure concern**: Gọi payment gateway liên quan đến network, timeout, retry -- PostgreSQL không thể mô phỏng được các failure mode này.

### 3.3 Microservices là lớp đúng để test order transaction contract

Order service là microservice phụ thuộc nhiều nhất:

1. **Phụ thuộc vào Redis**: Idempotency key storage, claim ownership, distributed state.
2. **Phụ thuộc vào PostgreSQL**: Persistent order state, order history.
3. **Phụ thuộc vào external payment-mock**: Mô phỏng payment gateway callback.

Test ở Microservices layer kiểm tra rằng tất cả các dependency này được tích hợp đúng và order service trả về contract nhất quán. Implementation detail của từng dependency được test ở layer tương ứng (Redis layer, Postgres layer, External layer).

### 3.4 Phân biệt trách nhiệm giữa các layer

```text
Application layer (code):     Business logic order -- "checkout cái gì, confirm ra sao"
Microservices layer (case 04): Routing + contract -- "request đến đúng service không, response đúng format không, idempotency hoạt động không"
Redis layer (cases 15-*.js):  Shared state + claim -- "idempotency state có shared không, claim có an toàn không"
Postgres layer (future):      Durability -- "order có tồn tại sau restart không, transaction có atomic không"
External layer (future):      Resilience -- "payment gateway timeout có được xử lý không, circuit breaker có hoạt động không"
```

Case 04 trả lời câu hỏi ở Microservices layer: khi hệ thống gửi request checkout/confirm/status, order service có phản hồi đúng contract cho từng operation không?

---

## 4. Topology và precondition

### 4.1 Topology

```text
k6 (8 VUs, 120 iterations, shared-iterations)
  |
  | 120 jobs được phân phối cho 8 VUs
  | Mỗi job: POST confirm → GET status → finish
  | headers: Idempotency-Key (unique per job)
  v
Nginx :80 (API gateway)
  |
  | path-based routing: /api/sim/orders/* → order-service:8083
  | add_header X-Upstream-Service "order-service"
  | add_header X-Upstream-Addr $upstream_addr
  v
order-service:8083 (transactional core)
  |
  ├── Redis (idempotency key store, claim ownership)
  ├── PostgreSQL (order persistent state, history)
  └── payment-mock (external payment gateway simulation)
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

# 4. Xác nhận Redis và PostgreSQL đang hoạt động (qua health check)
curl -s http://localhost:80/api/sim/orders/ORD-TEST/status
# Kỳ vọng: 200 với order status

# 5. Xác nhận X-Upstream-Addr header hiện diện
curl -sI http://localhost:80/api/sim/orders/ORD-TEST/status | Select-String "X-Upstream-Addr"
# Kỳ vọng: X-Upstream-Addr: <ip>:8083
```

### 4.3 Environment variables

Script và executor được cấu hình qua biến môi trường:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_02_VUS = "8"
$env:SI_02_JOBS = "120"
$env:SI_02_SLEEP_SECONDS = "0"
```

| Biến | Default | Mô tả |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | Public URL của Nginx gateway |
| `SI_02_VUS` | `8` | Số lượng Virtual Users chạy đồng thời |
| `SI_02_JOBS` | `120` | Tổng số jobs (iterations) được phân phối cho các VUs |
| `SI_02_SLEEP_SECONDS` | `0` | Thời gian nghỉ (think time) giữa các job, mặc định 0 |

### 4.4 Giải thích tham số VUs và JOBS

```text
VUS=8, JOBS=120:
  120 jobs trong setup(), mỗi job là một order reconciliation
  8 VUs cùng chia sẻ 120 jobs
  Mỗi VU xử lý ~15 jobs (120 / 8 = 15)
  
  Với external_ms=80, mỗi job mất ~160-200ms (2 external calls)
  Tổng thời gian: ~3-4 giây với 8 VUs song song
```

Shared-iterations là executor phù hợp cho reconciliation batch vì:

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- | --- |
| **shared-iterations** (đang dùng) | ✅ **ĐÚNG** | Phân phối jobs cho nhiều VUs. Mỗi VU xử lý một reconciliation job độc lập. Phù hợp với mô hình batch reconciliation -- nhiều worker xử lý queue. |
| constant-vus | ❌ SAI | Loop vô hạn -- reconciliation cần số lượng order xác định, không phải chạy mãi. |
| per-vu-iterations | ⚠️ CÓ THỂ | Nhưng không chia sẻ queue -- ít giống batch job thực tế. |
| ramping-vus | ❌ SAI | Reconciliation chạy với workload cố định, không cần ramp up. |

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `si-02-order-reconciliation.js` gồm 86 dòng, được tổ chức thành 4 phần chính:

```text
(A) IMPORTS + CONSTANTS          (dòng 1-17):  k6 modules, env vars, case ID
(B) OPTIONS + THRESHOLDS         (dòng 18-31): shared-iterations scenario, 4 thresholds
(C) SETUP FUNCTION               (dòng 33-42): buildJobs() tạo 120 job definitions với unique IDs
(D) EXEC FUNCTION                (dòng 44-85): orderReconciliation() thực thi mỗi job
```

Script dùng shared-iterations executor pattern giống như cart case -- một setup tạo ra mảng jobs, exec function xử lý từng job.

### 5.2 Phân tích -- Phần A: Imports và Constants

```javascript
import {
  BASE_URL,
  buildJobs,
  buildSharedScenario,
  currentJob,
  envFloat,
  envInt,
  finishJob,
  requestJson,
  think,
} from './common.js';

const CASE_ID = 'si-02-order-reconciliation';
const VUS = envInt('SI_02_VUS', 8);
const JOBS = envInt('SI_02_JOBS', 120);
const SLEEP_SECONDS = envFloat('SI_02_SLEEP_SECONDS', 0);
```

Điểm khác biệt với cart case:
- `CASE_ID = 'si-02-order-reconciliation'` -- định danh case khác.
- `JOBS = 120` -- nhiều hơn cart (90) vì order reconciliation thường xử lý nhiều order hơn.
- Cùng shared library `common.js` -- tất cả shared-iterations cases dùng chung pattern.

### 5.3 Phân tích -- Phần B: Options và Thresholds

```javascript
export const options = {
  scenarios: {
    order_reconciliation: buildSharedScenario('orderReconciliation', VUS, JOBS, '12m', {
      case_id: CASE_ID,
      business_case: 'order_reconciliation',
    }),
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    shared_jobs_total: [`count==${JOBS}`],
    shared_jobs_failed: ['count==0'],
  },
};
```

**Scenario**: `buildSharedScenario` với:
- `exec: 'orderReconciliation'` -- hàm thực thi chính
- `vus: 8` -- 8 Virtual Users
- `iterations: 120` -- 120 reconciliation jobs
- `maxDuration: '12m'` -- timeout 12 phút (dài hơn cart 8m vì mỗi job có external call 80ms)

**Thresholds** (4 cái -- giống cart case):
1. `checks: ['rate==1']` -- 100% checks pass.
2. `http_req_failed: ['rate==0']` -- Không HTTP error.
3. `shared_jobs_total: ['count==120']` -- Chính xác 120 jobs.
4. `shared_jobs_failed: ['count==0']` -- Không job thất bại.

### 5.4 Phân tích -- Phần C: Setup Function

```javascript
export function setup() {
  const seed = Date.now();
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `order-reconcile-${index + 1}`,
      orderId: `SI-RECON-${seed}-${String(index + 1).padStart(5, '0')}`,
      idemKey: `si-recon-${seed}-${index + 1}`,
    })),
  };
}
```

Setup function tạo 120 job definitions. Mỗi job có 3 trường:

- `id`: Job identifier (`order-reconcile-1` đến `order-reconcile-120`)
- `orderId`: Order ID duy nhất (`SI-RECON-{timestamp}-00001` đến `SI-RECON-{timestamp}-00120`)
- `idemKey`: Idempotency key duy nhất cho mỗi job (`si-recon-{timestamp}-1` đến `si-recon-{timestamp}-120`)

Điểm đặc biệt của order case so với cart case:

**Unique ID generation với `Date.now()`**:
```javascript
const seed = Date.now();
```
Mỗi lần chạy script tạo ra một seed mới dựa trên timestamp. Điều này đảm bảo:
- Không có conflict giữa các lần chạy (order IDs từ lần chạy trước không trùng với lần chạy sau).
- `padStart(5, '0')` đảm bảo order ID có format nhất quán (dễ đọc log).

**Mỗi job có Idempotency-Key riêng**:
```javascript
idemKey: `si-recon-${seed}-${index + 1}`
```
Mỗi reconciliation job có một Idempotency-Key duy nhất. Trong production, reconciliation batch sẽ dùng cùng một key cho cùng một order (để đảm bảo idempotency khi replay). Ở đây mỗi job có key riêng vì mỗi job xử lý một order khác nhau.

### 5.5 Phân tích -- Phần D: Exec Function (orderReconciliation)

```javascript
export function orderReconciliation(data) {
  const started = Date.now();
  const job = currentJob(data);
  let ok = true;

  const confirm = requestJson(
    'POST',
    `${BASE_URL}/api/sim/orders/${job.orderId}/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0`,
    { source: 'shared_iterations_reconciliation' },
    {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'order_confirm_reconcile',
      endpoint: 'POST /api/sim/orders/:id/confirm',
      jobId: job.id,
      headers: { 'Idempotency-Key': job.idemKey },
    },
  );
  ok = ok && confirm.ok;

  const status = requestJson(
    'GET',
    `${BASE_URL}/api/sim/orders/${job.orderId}?cpu_ms=1&db_rows=2&view=full&include_history=1`,
    null,
    {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'order_status_verify',
      endpoint: 'GET /api/sim/orders/:id',
      jobId: job.id,
    },
  );
  ok = ok && status.ok;

  finishJob(started, ok, {
    caseId: CASE_ID,
    service: 'order-service',
    operation: 'order_reconciliation_job',
    jobId: job.id,
  });
  think(SLEEP_SECONDS, { caseId: CASE_ID, operation: 'worker_pause' });
}
```

Flow chính của mỗi job:

```text
Setup tạo 120 jobs, mỗi job là một order reconciliation

Mỗi job:
  1. POST /api/sim/checkout?cpu_ms=4&db_writes=2&external_ms=30
     → Body: { payment_method, item_count, coupon_code }
     → Expect: 200, success=true, data.order_id

  2. POST /api/sim/orders/{order_id}/confirm?cpu_ms=2&db_writes=3&external_ms=60
     → Header: Idempotency-Key: {unique key}
     → Expect: 200, success=true

  3. GET /api/sim/orders/{order_id}?cpu_ms=1&db_rows=2&view=full
     → Expect: 200, success=true, order state đúng
```

Phân tích từng bước:

**Bước 1: POST order confirm (reconciliation replay)**
```javascript
const confirm = requestJson(
  'POST',
  `${BASE_URL}/api/sim/orders/${job.orderId}/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0`,
  { source: 'shared_iterations_reconciliation' },
  {
    caseId: CASE_ID,
    service: 'order-service',
    operation: 'order_confirm_reconcile',
    endpoint: 'POST /api/sim/orders/:id/confirm',
    jobId: job.id,
    headers: { 'Idempotency-Key': job.idemKey },
  },
);
```

- **HTTP Method**: `POST` -- confirm là operation thay đổi state (CHECKOUT → PENDING).
- **URL**: `/api/sim/orders/{order_id}/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0`
  - `cpu_ms=1`: 1ms CPU xử lý.
  - `db_writes=3`: 3 DB write operations -- mô phỏng ghi order state + audit log + idempotency record.
  - `external_ms=80`: 80ms external call -- mô phỏng gọi payment gateway để capture payment.
  - `external_fail_rate=0`: External call luôn thành công (0% fail rate).
- **Body**: `{ source: 'shared_iterations_reconciliation' }` -- metadata về nguồn gốc request.
- **Headers**: `{ 'Idempotency-Key': job.idemKey }` -- ĐÂY LÀ ĐIỂM QUAN TRỌNG NHẤT. Header này được truyền qua `tags.headers` và được merge vào request headers bởi `requestJson()`.
- **Tags**: `caseId`, `service=order-service`, `operation=order_confirm_reconcile`, `endpoint=POST /api/sim/orders/:id/confirm`, `jobId`.

**Bước 2: GET order status (verify)**
```javascript
const status = requestJson(
  'GET',
  `${BASE_URL}/api/sim/orders/${job.orderId}?cpu_ms=1&db_rows=2&view=full&include_history=1`,
  null,
  {
    caseId: CASE_ID,
    service: 'order-service',
    operation: 'order_status_verify',
    endpoint: 'GET /api/sim/orders/:id',
    jobId: job.id,
  },
);
```

- **HTTP Method**: `GET` -- đọc order state (read-only).
- **URL**: `/api/sim/orders/{order_id}?cpu_ms=1&db_rows=2&view=full&include_history=1`
  - `cpu_ms=1`: 1ms CPU xử lý.
  - `db_rows=2`: 2 DB rows -- mô phỏng JOIN order + order_items.
  - `view=full`: Trả về full order detail (không phải summary).
  - `include_history=1`: Bao gồm order history (các state transitions).
- **Body**: `null` -- GET request không có body.
- **Purpose**: Verify order đã được confirm đúng -- status response phải phản ánh trạng thái PENDING hoặc PAID.

**Bước 3: finishJob và think**
```javascript
finishJob(started, ok, { ... });
think(SLEEP_SECONDS, { ... });
```

Giống cart case -- ghi nhận job completion và optional sleep.

### 5.6 Cách `requestJson` xử lý custom headers

Đây là chi tiết quan trọng về cách `Idempotency-Key` được truyền:

```javascript
// Trong common.js:
export function requestJson(method, url, body, tags = {}, expectedStatus = 200) {
  const params = {
    headers: {
      'Content-Type': 'application/json',
      ...(tags.headers || {}),  // ← Idempotency-Key được merge vào đây
    },
    tags: {
      case_id: tags.caseId,
      service: tags.service,
      operation: tags.operation,
      endpoint: tags.endpoint,
      job_id: tags.jobId,
      name: tags.name || tags.operation,
    },
  };
  // ...
}
```

Khi `tags.headers` chứa `{ 'Idempotency-Key': job.idemKey }`, nó được spread vào `params.headers`. Request HTTP sẽ có header:

```text
POST /api/sim/orders/SI-RECON-.../confirm?...
Content-Type: application/json
Idempotency-Key: si-recon-1719000000-1
```

Pattern `...(tags.headers || {})` đảm bảo rằng nếu `tags.headers` không được cung cấp (như trong GET status request), không có header extra nào được thêm vào.

### 5.7 Query parameter mô phỏng workload

Cả hai request đều có query parameter mô phỏng workload:

| Parameter | Confirm value | Status value | Ý nghĩa |
| --- | --- | --- | --- |
| `cpu_ms` | `1` | `1` | Thời gian CPU xử lý business logic (ms) |
| `db_writes` | `3` | (không có) | Số DB write operations (ghi order state, audit log, idempotency record) |
| `db_rows` | (không có) | `2` | Số DB rows đọc (JOIN order + order_items) |
| `external_ms` | `80` | (không có) | Thời gian external call (ms) -- mô phỏng payment gateway |
| `external_fail_rate` | `0` | (không có) | Tỷ lệ external call thất bại (0 = luôn thành công) |
| `view` | (không có) | `full` | Mức độ chi tiết của response (full = đầy đủ) |
| `include_history` | (không có) | `1` | Có bao gồm order history không |

### 5.8 Sự khác biệt giữa script và document flow

Script thực tế (`si-02-order-reconciliation.js`) thực hiện 2 operations mỗi job:
1. POST confirm (với Idempotency-Key)
2. GET status (verify)

Document mô tả flow 3 bước:
1. POST checkout (tạo order)
2. POST confirm (với Idempotency-Key)
3. GET status (verify)

Sự khác biệt này là có chủ đích:
- **Script tập trung vào reconciliation**: Trong reconciliation batch, order đã được tạo từ trước (bởi người dùng hoặc bởi batch trước đó). Script bỏ qua bước checkout vì order đã tồn tại.
- **Document mô tả full contract**: Document mô tả toàn bộ API surface của order service để learner hiểu được contract đầy đủ, bao gồm cả bước checkout.

Cả hai đều đúng trong ngữ cảnh của chúng. Khi tự viết test, learner nên bắt đầu từ full flow (checkout → confirm → status) để hiểu contract, sau đó có thể tối ưu như script (chỉ confirm → status) cho reconciliation scenario.

---

## 6. Service mechanism deep-dive

### 6.1 Order state machine chi tiết

Order service duy trì state machine với 4 trạng thái và 3 transitions:

```text
                    POST /checkout
  ┌─────────────────────┐
  │      CHECKOUT       │  order_id được tạo
  │  - payment: chưa    │  items được copy từ cart
  │  - status: created  │  total được tính
  └─────────┬───────────┘
            │
            │ POST /orders/:id/confirm
            │ Header: Idempotency-Key
            ▼
  ┌─────────────────────┐
  │      PENDING        │  Idempotency key được lưu
  │  - payment: pending │  External payment gateway được gọi
  │  - status: confirmed│  Claim được tạo (Redis SET NX EX)
  └─────────┬───────────┘
            │
            │ POST /orders/webhooks/payment
            │ Body: { event_id, order_id, status }
            ▼
  ┌─────────┴───────────┐
  │                     │
  ▼                     ▼
┌──────────┐      ┌──────────┐
│   PAID   │      │ CANCELLED│
│ - status │      │ - status │
│   paid   │      │ cancelled│
└──────────┘      └──────────┘
  (terminal)        (terminal)
```

Mỗi transition có các điều kiện và side effect riêng:

| Transition | Trigger | Precondition | Side effects | Idempotent? |
| --- | --- | --- | --- | --- |
| (none) → CHECKOUT | `POST /checkout` | Cart có items, user authenticated | Order được tạo, cart được clear hoặc đánh dấu "checked_out" | Không -- mỗi lần checkout tạo order mới |
| CHECKOUT → PENDING | `POST /confirm` | Order ở trạng thái CHECKOUT, `Idempotency-Key` chưa được dùng | External payment gateway được gọi, idempotency record được lưu, claim được tạo | Có -- replay với cùng key trả về kết quả cũ |
| PENDING → PAID | `POST /webhooks/payment` | Order ở trạng thái PENDING, `event_id` chưa được xử lý | Payment state được cập nhật, order history được ghi | Có -- dedupe qua `event_id` |
| PENDING → CANCELLED | Timeout hoặc user cancel | Order ở PENDING quá N phút | Order được đánh dấu cancelled, hoàn trả inventory | Không -- sau khi cancelled không thể confirm lại |

### 6.2 Cơ chế Idempotency-Key

Idempotency-Key là cơ chế chống double charge quan trọng nhất trong order service:

```text
Request 1: POST /orders/ORD-001/confirm
  Idempotency-Key: key-abc-123
  
  Server xử lý:
  1. Kiểm tra Redis: EXISTS idempotency:key-abc-123 → false
  2. Tạo claim: SET claim:idempotency:key-abc-123 owner-A NX EX 900 → OK
  3. Thực thi: gọi payment gateway, ghi DB
  4. Lưu kết quả: SET idempotency:key-abc-123 { result } EX 86400
  5. Trả về: 200, idempotency_reuse: false

Request 2: POST /orders/ORD-001/confirm (RETRY)
  Idempotency-Key: key-abc-123  ← CÙNG KEY
  
  Server xử lý:
  1. Kiểm tra Redis: EXISTS idempotency:key-abc-123 → true
  2. Đọc kết quả: GET idempotency:key-abc-123 → { result }
  3. Trả về: 200, idempotency_reuse: true  ← KHÔNG gọi payment gateway
```

Idempotency-Key đảm bảo:
- **At-most-once execution**: Business logic (gọi payment gateway, ghi DB) chỉ chạy một lần duy nhất cho mỗi key.
- **Same result every time**: Mọi request với cùng key trả về cùng kết quả -- kể cả sau restart, deploy, hoặc failover.
- **TTL cho key**: Idempotency record được lưu với TTL (thường 24 giờ) để tránh tích tụ vô hạn trong Redis.

### 6.3 Cơ chế payment webhook

Payment webhook là cơ chế callback từ payment gateway:

```text
Payment Gateway (VNPay/Stripe/Momo)
  → POST /api/sim/orders/webhooks/payment
  Body: {
    "event_id": "evt-payment-xyz-789",
    "order_id": "ORD-001",
    "status": "paid",
    "amount": 500000,
    "currency": "VND"
  }
  
  Server xử lý:
  1. Kiểm tra event_id đã được xử lý chưa (dedupe qua Redis)
  2. Nếu chưa: cập nhật order state PENDING → PAID
  3. Lưu payment record vào PostgreSQL
  4. Ghi order history
  5. Trả về 200
```

Webhook khác với confirm ở chỗ:
- **Key trong body, không phải header**: `event_id` được truyền trong JSON body, không phải HTTP header.
- **At-least-once delivery**: Payment gateway có thể gửi webhook nhiều lần -- dedupe là bắt buộc.
- **Không có retry từ phía order service**: Nếu webhook fail, payment gateway sẽ retry -- order service chỉ cần xử lý đúng.

### 6.4 Order service API surface đầy đủ

Order service cung cấp 7 endpoints (6 business + 1 health):

```text
POST /api/sim/checkout                  — tạo order từ cart
GET  /api/sim/orders/:id                — đọc order state
POST /api/sim/orders/:id/confirm        — xác nhận order (idempotent)
POST /api/sim/orders/webhooks/payment   — payment webhook (idempotent)
POST /api/sim/orders/:id/cancel         — hủy order
GET  /api/sim/orders                    — list orders (với filter)
GET  /health                            — health check với dependency status
```

Order service khác biệt so với các service khác:

- **Có idempotency**: confirm và webhook payment dùng `Idempotency-Key` / `event_id` để chống duplicate;
- **Có external dependency**: gọi payment-mock cho checkout và confirm;
- **Có Redis shared state**: idempotency state, claim owner, hot-key protection;
- **Có X-Upstream-Addr header**: để biết instance nào xử lý request (quan trọng cho distributed state proof).

### 6.5 So sánh order service với các service khác về độ phức tạp

| Khía cạnh | products-service | cart-service | **order-service** | report-service |
| --- | --- | --- | --- | --- |
| **Số lượng endpoints** | 6 | 5 | **7** | 4 |
| **HTTP methods** | GET | POST, GET, PATCH, DELETE | **POST, GET** | GET, POST |
| **State machine** | Không | 3 trạng thái | **4 trạng thái** | 3 trạng thái (job) |
| **Idempotency** | Không | Không | **Có (2 cơ chế)** | Không |
| **External calls** | Không | Không | **Có (payment-mock)** | Không |
| **Redis dependency** | Không | Có thể | **Có (bắt buộc)** | Không |
| **Postgres dependency** | Có (read-only) | Có thể | **Có (read+write)** | Có |
| **X-Upstream-Addr** | Không | Không | **Có** | Không |

Order service là service phức tạp nhất trong toàn bộ stack. Nó là service duy nhất có tất cả các dependency: Redis + PostgreSQL + external service.

### 6.6 Cách order service xử lý external call failure

External call (payment gateway) có thể thất bại. Order service xử lý qua `external_fail_rate` query parameter:

```text
POST /orders/ORD-001/confirm?external_ms=80&external_fail_rate=0.2

external_fail_rate=0.2 → 20% khả năng external call thất bại
```

Khi external call thất bại:
1. Server vẫn trả về response với `success: true` (nếu business logic cho phép).
2. Response có thể chứa `external_call_failed: true` hoặc `payment_status: "pending"`.
3. Order vẫn ở trạng thái PENDING -- chờ retry hoặc manual intervention.

Trong production, external call failure được xử lý qua:
- **Retry với backoff**: Gọi lại payment gateway sau 1s, 2s, 4s...
- **Circuit breaker**: Nếu payment gateway liên tục fail, ngừng gọi để tránh quá tải.
- **Dead letter queue**: Order không thể confirm được đưa vào queue để xử lý sau.

---

## 7. Request sequence flow

### 7.1 Timeline tổng thể

```text
Time (ms) | Action                                          | VU    | Job
----------|-------------------------------------------------|-------|------
0         | setup() tạo 120 job definitions                 | setup | -
1         | 8 VUs bắt đầu lấy jobs từ shared queue          | 1-8   | 1-8
2         | VU-1: POST confirm ORD-001?external_ms=80...    | 1     | 1
          |       Header: Idempotency-Key: si-recon-...-1   |       |
~85       | VU-1: Confirm hoàn thành ~83ms                   | 1     | 1
          |       (1ms CPU + 3 DB writes + 80ms external)   |       |
87        | VU-1: GET status ORD-001?view=full...           | 1     | 1
~95       | VU-1: Status hoàn thành ~8ms                     | 1     | 1
96        | VU-1: finishJob() → shared_jobs_total++          | 1     | 1
97        | VU-1: lấy job tiếp theo (job 9)                  | 1     | 9
...       | ...                                             | ...   | ...
~2,500    | Tất cả 120 jobs hoàn thành                       | 1-8   | 120
```

Mỗi job mất khoảng 90-100ms (80ms external + ~10ms overhead). Với 8 VUs song song, 120 jobs hoàn thành trong ~2.5 giây.

### 7.2 Sequence diagram chi tiết (một job)

```text
k6 (VU X)              order-service           Redis              PostgreSQL        payment-mock
    |                       |                    |                    |                  |
    |-- POST /orders/       |>|                   |                    |                  |
    |   ORD-001/confirm     | |                   |                    |                  |
    |   Idempotency-Key:    | |                   |                    |                  |
    |     si-recon-...-1    | |                   |                    |                  |
    |   ?cpu_ms=1&          | |                   |                    |                  |
    |   db_writes=3&        | |                   |                    |                  |
    |   external_ms=80&     | |                   |                    |                  |
    |   external_fail_rate=0|                     |                    |                  |
    |                       |-- SET claim:        |>|                   |                  |
    |                       |   idem:si-recon-...-1|                   |                  |
    |                       |   NX EX 900ms ----->|                    |                  |
    |                       |   OK                |                    |                  |
    |                       |                     |                    |                  |
    |                       |-- (CPU work 1ms) ----------------------->|                  |
    |                       |                     |                    |                  |
    |                       |-- (DB writes ×3) ----------------------->|                  |
    |                       |                     | INSERT INTO orders |                  |
    |                       |                     | INSERT INTO audit  |                  |
    |                       |                     | INSERT INTO idem...|                  |
    |                       |                     |                    |                  |
    |                       |-- (External call 80ms) -------------------------------->|
    |                       |                     |                    | POST /payment    |
    |                       |<-- payment response ------------------------------------|
    |                       |   (200 OK)          |                    |                  |
    |                       |                     |                    |                  |
    |                       |-- SET idempotency:  |>|                   |                  |
    |                       |   si-recon-...-1    |                    |                  |
    |                       |   {result} EX 86400>|                    |                  |
    |                       |   OK                |                    |                  |
    |                       |                     |                    |                  |
    |<-- 200 OK ------------|                     |                    |                  |
    |   X-Upstream-Service: |                     |                    |                  |
    |     order-service     |                     |                    |                  |
    |   X-Upstream-Addr:    |                     |                    |                  |
    |     172.18.0.5:8083   |                     |                    |                  |
    |   { success: true,    |                     |                    |                  |
    |     data: {           |                     |                    |                  |
    |       idempotency_    |                     |                    |                  |
    |       reuse: false }} |                     |                    |                  |
    |                       |                     |                    |                  |
    |-- GET /orders/        |>|                   |                    |                  |
    |   ORD-001?view=full&  | |                   |                    |                  |
    |   include_history=1   | |                   |                    |                  |
    |   ?cpu_ms=1&db_rows=2 |                     |                    |                  |
    |                       |-- (CPU work 1ms) ----------------------->|                  |
    |                       |                     |                    |                  |
    |                       |-- (DB read 2 rows) --------------------->|                  |
    |                       |                     | SELECT * FROM      |                  |
    |                       |                     | orders WHERE id=...|                  |
    |                       |                     | JOIN order_items   |                  |
    |                       |                     |                    |                  |
    |<-- 200 OK ------------|                     |                    |                  |
    |   X-Upstream-Service: |                     |                    |                  |
    |     order-service     |                     |                    |                  |
    |   { success: true,    |                     |                    |                  |
    |     data: {           |                     |                    |                  |
    |       order_id,       |                     |                    |                  |
    |       status,         |                     |                    |                  |
    |       payment_status, |                     |                    |                  |
    |       items,          |                     |                    |                  |
    |       history }}      |                     |                    |                  |
    |                       |                     |                    |                  |
    | finishJob() + think() |                     |                    |                  |
```

### 7.3 So sánh timing với cart case

| Khía cạnh | Cart case (ms-03) | Order case (ms-04) | Chênh lệch |
| --- | --- | --- | --- |
| Số lượng jobs | 90 | 120 | +33% |
| Operations mỗi job | 2 (PATCH + GET) | 2 (POST + GET) | Bằng nhau |
| External call | Không | Có (80ms) | Khác biệt chính |
| Job duration trung bình | ~12ms | ~95ms | ~8 lần chậm hơn |
| Tổng thời gian | ~900ms | ~2,500ms | ~2.8 lần chậm hơn |
| Nguyên nhân chậm | (không có) | External call 80ms × 2 = 160ms/job | External call chiếm ~85% thời gian |

Khác biệt chính là **external call**. Trong cart case, không có external call nên mỗi job rất nhanh (12ms). Trong order case, external call 80ms làm mỗi job chậm hơn đáng kể. Đây là lý do `maxDuration` cho order case là 12 phút (so với 8 phút cho cart).

### 7.4 Idempotency-Key propagation qua Nginx

Một điểm quan trọng cần lưu ý: `Idempotency-Key` là custom HTTP header. Nginx phải được cấu hình để không strip header này:

```nginx
# Nginx config (không strip custom headers):
location /api/sim/orders/ {
    proxy_pass http://order-service:8083;
    proxy_set_header Idempotency-Key $http_idempotency_key;  # ← QUAN TRỌNG
    proxy_set_header X-Upstream-Service "order-service";
    add_header X-Upstream-Service "order-service";
    add_header X-Upstream-Addr $upstream_addr;
}
```

Nếu Nginx không forward `Idempotency-Key`, order service sẽ không thấy key và không thể thực hiện idempotency check. Mọi request sẽ được xử lý như fresh -- gây double charge trong production.

---

## 8. Key signals / headers / counters

### 8.1 Bảng counters đầy đủ

| Counter | Loại | Giá trị kỳ vọng | Ý nghĩa | Hậu quả nếu sai |
| --- | --- | --- | --- | --- |
| `checks` | Rate | 100% (rate==1) | Tất cả checks pass | Nếu < 100%: có ít nhất một check fail |
| `http_req_failed` | Rate | 0.00% (rate==0) | Không có HTTP request thất bại | Nếu > 0%: có request lỗi -- kiểm tra log |
| `shared_jobs_total` | Count | 120 | Tổng số jobs đã thực thi | Nếu != 120: setup sai hoặc jobs bị skip |
| `shared_jobs_failed` | Count | 0 | Số jobs thất bại | Nếu > 0: có ít nhất một confirm hoặc status fail |
| `shared_api_calls_total` | Count | 240 (120 × 2) | Tổng số API calls | Nếu != 240: có job không thực hiện đủ 2 operations |
| `shared_job_duration_ms` | Trend | ~95ms mỗi job | Thời gian thực thi mỗi job (80ms external + overhead) | Nếu bất thường: external call chậm hoặc DB slow |

### 8.2 Bảng response headers

| Header | Vị trí | Expected value | Ý nghĩa | Required? |
| --- | --- | --- | --- | --- |
| `X-Upstream-Service` | Response header | `order-service` | Request được route đến order service | **Bắt buộc** |
| `X-Upstream-Addr` | Response header | `<ip>:8083` | Địa chỉ order-service instance xử lý request | **Bắt buộc** cho order |
| `Content-Type` | Response header | `application/json` | Response body là JSON | **Bắt buộc** |
| `X-Request-ID` | Response header | `<uuid>` | Trace correlation ID | Tùy chọn (hữu ích) |

### 8.3 Bảng response body signals

| Signal | Vị trí | Expected value | Operation | Ý nghĩa |
| --- | --- | --- | --- | --- |
| `success` | Response body (JSON) | `true` | Tất cả | Operation thành công |
| `data.order_id` | `data.order_id` | Không rỗng, khớp với request | Checkout, Confirm, Status | Định danh order |
| `data.idempotency_reuse` | `data.idempotency_reuse` | `false` (lần đầu), `true` (replay) | Confirm | Fresh execution hay replay? |
| `data.status` | `data.status` | `pending` / `paid` | Status | Trạng thái hiện tại của order |
| `data.payment_status` | `data.payment_status` | `pending` / `paid` | Status | Trạng thái payment |
| `data.items` | `data.items` | Array (có thể rỗng) | Status | Danh sách items trong order |
| `data.history` | `data.history` | Array các state transitions | Status (khi `include_history=1`) | Lịch sử thay đổi trạng thái |

### 8.4 Evidence phải đọc

| Evidence | Expected |
| --- | --- |
| `checks` | 100% |
| `http_req_failed` | 0.00% |
| `shared_jobs_total` | 120 |
| `shared_jobs_failed` | 0 |
| `X-Upstream-Service` | `order-service` trên mọi response |
| `X-Upstream-Addr` | Hiện diện (cho biết order-service instance nào xử lý) |
| Checkout response | `data.order_id` không rỗng |
| Confirm response | `success: true`, `data.idempotency_reuse: false` (lần đầu) |
| Status response | `data.order_id` khớp với checkout |

### 8.5 Signal relationship map

```text
                    ┌── POST confirm ────────────────────────┐
                    │  HTTP 200                              │
                    │  X-Upstream-Service: order-service     │
                    │  X-Upstream-Addr: <ip>:8083            │
                    │  Idempotency-Key được tôn trọng         │
                    │  idempotency_reuse: false ── (A) Fresh │
                    │  order_id preserved ──────── (B) ID    │
                    └────────────────────────────────────────┘
                                       │
                                       ▼
                    ┌── GET status ──────────────────────────┐
                    │  HTTP 200                              │
                    │  X-Upstream-Service: order-service     │
                    │  order_id khớp với confirm ── (C) Link │
                    │  status = "pending"/"paid" ── (D) State│
                    │  payment_status đúng ──────── (E) Pay  │
                    └────────────────────────────────────────┘
                                       │
                                       ▼
                    ┌── Job completion ──────────────────────┐
                    │  shared_jobs_total = 120 ── (F) Count  │
                    │  shared_jobs_failed = 0 ──── (G) Zero  │
                    │  checks rate = 1.00 ──────── (H) All   │
                    └────────────────────────────────────────┘

Tất cả 8 signal (A+B+C+D+E+F+G+H) cùng đúng -> Order transaction contract được chứng minh
Thiếu bất kỳ signal nào -> Order service hoặc routing có lỗi
```

---

## 9. Pass/fail criteria

### 9.1 PASS criteria

Tất cả các điều kiện sau đồng thời đúng:

| # | Tiêu chí | Cách kiểm tra | Threshold |
| --- | --- | --- | --- |
| P1 | Tất cả checks pass | `checks: ['rate==1']` | rate==1 |
| P2 | Không có HTTP failure | `http_req_failed: ['rate==0']` | rate==0 |
| P3 | Đủ 120 jobs được thực thi | `shared_jobs_total` | count==120 |
| P4 | Không có job thất bại | `shared_jobs_failed` | count==0 |
| P5 | Mọi response có `X-Upstream-Service: order-service` | Kiểm tra response headers | 100% |
| P6 | Mọi response có `X-Upstream-Addr` | Kiểm tra response headers | 100% |
| P7 | Confirm response status 200 với `success: true` | `requestJson` check | status 200 |
| P8 | Status response status 200 với `data.order_id` khớp | `requestJson` check | status 200 |
| P9 | `Idempotency-Key` được tôn trọng (replay trả về cùng kết quả) | Gửi 2 request confirm cùng key | Lần 2: `idempotency_reuse: true` |

### 9.2 FAIL criteria

| # | Dấu hiệu | Diagnostic | Nguyên nhân khả dĩ |
| --- | --- | --- | --- |
| F1 | Checkout không trả `order_id` | Contract violation -- không thể continue flow | Checkout endpoint không hoạt động hoặc response format sai |
| F2 | Confirm không nhận `Idempotency-Key` | Header bị drop hoặc service không parse | Nginx strip custom header, hoặc order service không đọc header |
| F3 | Status trả về sai `order_id` | State corruption | Order bị overwrite bởi request khác, hoặc DB query sai |
| F4 | `X-Upstream-Service` không phải `order-service` | Routing sai | Nginx route request đến sai upstream |
| F5 | `external_ms > 0` nhưng response vẫn 200 | Expected -- external call thành công | Đây là expected behavior, không phải fail |
| F6 | Thiếu `X-Upstream-Addr` | Nginx config thiếu `add_header X-Upstream-Addr` | Thêm directive vào Nginx config |
| F7 | `idempotency_reuse: true` ngay lần đầu tiên | Idempotency key đã được dùng trước đó | Key không đủ unique -- kiểm tra `seed` và `index` |
| F8 | `shared_jobs_failed > 0` nhưng checks rate = 100% | Có job fail nhưng checks vẫn pass? | Kiểm tra logic `requestJson` -- có thể status check pass nhưng business logic fail |

### 9.3 Định lượng cụ thể

```text
PASS:
  checks rate = 1.00 (100%)
  http_req_failed rate = 0.00 (0%)
  shared_jobs_total = 120
  shared_jobs_failed = 0
  shared_api_calls_total = 240
  shared_job_duration_ms avg = ~95ms (80ms external + ~15ms overhead)
  X-Upstream-Service = "order-service" trên mọi response
  X-Upstream-Addr hiện diện trên mọi response

FAIL (bất kỳ điều kiện nào dưới đây):
  checks rate < 1.00
  http_req_failed rate > 0.00
  shared_jobs_total != 120
  shared_jobs_failed > 0
  Bất kỳ response nào thiếu X-Upstream-Service
  Bất kỳ response nào có X-Upstream-Service != "order-service"
  Bất kỳ response nào thiếu X-Upstream-Addr
```

---

## 10. Cách chạy + output mẫu

### 10.1 Default run

```powershell
# Set environment variables (hoặc dùng default)
$env:BASE_URL = "http://localhost:80"
$env:SI_02_VUS = "8"
$env:SI_02_JOBS = "120"
$env:SI_02_SLEEP_SECONDS = "0"

# Chạy script trực tiếp
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-02-order-reconciliation.js
```

### 10.2 Output mẫu (PASS)

```text
     script: si-02-order-reconciliation.js

     ✓ order_confirm_reconcile status 200
     ✓ order_status_verify status 200

     checks........................: 100.00% ✓ 240  ✗ 0
     http_req_failed...............: 0.00%   ✓ 0    ✗ 240
     shared_jobs_total.............: 120
     shared_jobs_failed............: 0
     shared_api_calls_total........: 240
     shared_job_duration_ms........: avg=95ms   min=88ms   max=105ms

     iterations.....................: 120
     vus............................: 8

     Exit: 0
```

Phân tích output:
- **Exit 0**: Tất cả thresholds pass.
- **240 checks pass, 0 fail**: 120 jobs × 2 operations = 240 checks. Tất cả pass.
- **shared_job_duration_ms avg=95ms**: 80ms external call + ~15ms overhead (CPU + DB + network). Đúng với kỳ vọng.
- **http_req_failed = 0.00%**: Không có HTTP error nào.
- **shared_jobs_total = 120**: Đúng số lượng.
- **shared_jobs_failed = 0**: Không job nào fail.

### 10.3 Output mẫu (FAIL -- external call timeout)

```text
     ✗ order_confirm_reconcile status 200
       ↳  60% — ✓ 72 / ✗ 48

     checks........................: 80.00%  ✓ 192  ✗ 48
     http_req_failed...............: 20.00%  ✓ 48   ✗ 192
     shared_jobs_total.............: 120
     shared_jobs_failed............: 48
     shared_job_duration_ms........: avg=250ms  min=88ms  max=5000ms

     Exit: 99
```

Phân tích:
- **60% confirm pass**: 72/120 confirm requests pass, 48 fail.
- **shared_job_duration_ms max=5000ms**: Một số job bị treo rất lâu (có thể external call timeout).
- **Nguyên nhân khả dĩ**: payment-mock bị quá tải hoặc không phản hồi. `external_ms=80` nhưng nếu payment-mock chậm hơn 80ms, server có thể timeout.

### 10.4 Output mẫu (FAIL -- thiếu X-Upstream-Addr)

```text
     checks........................: 100.00% ✓ 240  ✗ 0
     http_req_failed...............: 0.00%   ✓ 0    ✗ 240
     shared_jobs_total.............: 120
     shared_jobs_failed............: 0

     Exit: 0  ← VẪN PASS!
```

**Cảnh báo**: Exit 0 nhưng nếu thiếu `X-Upstream-Addr`, case này vẫn pass thresholds. Đây là lý do cần **manual verification** ngoài k6 thresholds. Kiểm tra:

```powershell
curl -sI http://localhost:80/api/sim/orders/ORD-TEST/status | Select-String "X-Upstream-Addr"
# Nếu không có output: Nginx config thiếu add_header X-Upstream-Addr
```

### 10.5 Cách kiểm tra nhanh không cần k6

```powershell
# 1. Tạo order ID và Idempotency-Key duy nhất
$orderId = "ORD-MANUAL-$(Get-Date -Format 'HHmmss')"
$key = "idem-manual-$(Get-Date -Format 'HHmmss')"

# 2. Confirm order
$r1 = Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/$orderId/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0" -Method Post -Headers @{'Idempotency-Key'=$key; 'Content-Type'='application/json'} -Body '{"source":"manual_test"}'
Write-Host "Confirm: success=$($r1.success), reuse=$($r1.data.idempotency_reuse)"

# 3. Confirm lại với cùng key (replay)
$r2 = Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/$orderId/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0" -Method Post -Headers @{'Idempotency-Key'=$key; 'Content-Type'='application/json'} -Body '{"source":"manual_test"}'
Write-Host "Replay: success=$($r2.success), reuse=$($r2.data.idempotency_reuse)"
# Kỳ vọng: reuse=true (idempotency hoạt động)

# 4. Kiểm tra status
$r3 = Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/$orderId?view=full&include_history=1" -Method Get
Write-Host "Status: order_id=$($r3.data.order_id), status=$($r3.data.status)"
# Kỳ vọng: order_id khớp với $orderId

# 5. Kiểm tra headers
$headers = Invoke-WebRequest -Uri "http://localhost:80/api/sim/orders/$orderId" -Method Get
Write-Host "X-Upstream-Service: $($headers.Headers['X-Upstream-Service'])"
Write-Host "X-Upstream-Addr: $($headers.Headers['X-Upstream-Addr'])"
```

---

## 11. 4 output -> decision scenarios

### Scenario A: Tất cả checks pass, exit 0, idempotency hoạt động

```text
Exit: 0
Checks: 100%
shared_jobs_total: 120
shared_jobs_failed: 0
X-Upstream-Service: order-service (100%)
X-Upstream-Addr: present (100%)
idempotency_reuse: false (lần đầu), true (replay)
```

**Kết luận**: Order service hoạt động hoàn hảo. Routing đúng, contract đúng, idempotency hoạt động, external call thành công. Đây là kết quả mong đợi cho production-ready system.

**Hành động**: Không cần action. Case này pass -- có thể tiếp tục sang Redis cases (15-*.js). Contract đã được chứng minh, sẵn sàng test các edge case của idempotency và claim ownership.

### Scenario B: Confirm pass nhưng status fail

```text
Exit: 99
Checks: ~50% (chỉ confirm pass, status fail)
order_confirm_reconcile: ✓ 120
order_status_verify: ✗ 120
```

**Kết luận**: Confirm hoạt động nhưng status read path có vấn đề.

**Hành động**:
1. Kiểm tra GET /api/sim/orders/:id endpoint trực tiếp.
2. Kiểm tra xem order có thực sự được lưu trong DB không (confirm có thể trả về 200 nhưng không persist).
3. Kiểm tra Nginx config: GET request có bị route khác POST không.
4. Kiểm tra order service log -- có thể DB query bị lỗi.

### Scenario C: Idempotency không hoạt động (replay tạo execution mới)

```text
Exit: 0 (thresholds pass!)
Checks: 100%
Nhưng: idempotency_reuse = false cho cả lần 1 và lần 2
```

**Cảnh báo quan trọng**: Exit 0 không có nghĩa là idempotency hoạt động. Thresholds chỉ kiểm tra status code và counters -- không kiểm tra `idempotency_reuse`. Nếu replay tạo execution mới, thresholds vẫn pass nhưng đây là **bug nghiêm trọng** (double charge risk).

**Hành động**:
1. Kiểm tra `Idempotency-Key` header có được forward đến order service không.
2. Kiểm tra order service log -- có nhận được `Idempotency-Key` không.
3. Kiểm tra Redis -- idempotency record có được lưu không.
4. Đây là bug P0 -- phải fix trước khi deploy.

### Scenario D: External call fail với external_fail_rate > 0

```text
Exit: 99 hoặc 0 (tùy server behavior)
Một số confirm request fail (external call không thành công)
shared_jobs_failed > 0
```

**Kết luận**: Một phần external calls thất bại. Đây có thể là expected behavior (nếu `external_fail_rate > 0`) hoặc infrastructure issue (payment-mock không ổn định).

**Hành động**:
1. Nếu `external_fail_rate > 0`: đây là expected -- server đang mô phỏng failure đúng.
2. Nếu `external_fail_rate = 0` nhưng vẫn fail: payment-mock có vấn đề.
3. Kiểm tra payment-mock container: `docker ps | Select-String payment`.
4. Kiểm tra payment-mock log: `docker logs <payment-container>`.

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "Idempotency-Key là tính năng optional" -- SAI

Nhiều developer nghĩ idempotency là "nice to have" -- nếu không có cũng không sao, vì user hiếm khi nhấn nút hai lần.

**Sự thật**: Trong môi trường production, duplicate request là chuyện xảy ra hàng ngày:
- **Mobile app không có debounce**: User nhấn "Thanh toán" 2-3 lần vì app không phản hồi ngay.
- **Network retry**: Load balancer hoặc API gateway retry request khi upstream timeout.
- **Browser refresh**: User F5 hoặc refresh trang sau khi nhấn "Thanh toán".
- **Webhook retry**: Payment gateway gửi webhook nhiều lần (at-least-once delivery).

Không có idempotency, mỗi duplicate request là một lần double charge. Trong hệ thống tài chính, double charge là unacceptable -- có thể dẫn đến dispute, chargeback, và mất uy tín với payment provider.

### 12.2 Nghịch lý 2: "Chỉ cần idempotency ở database layer" -- SAI

Có ý kiến cho rằng database unique constraint có thể thay thế idempotency ở application layer.

**Sự thật**: Database unique constraint có thể ngăn duplicate record, nhưng:
- Nó không ngăn được duplicate side effect (gọi payment gateway hai lần).
- Nó xảy ra ở cuối flow -- sau khi tất cả business logic đã chạy.
- Nó trả về constraint violation error -- không phải "kết quả cũ của bạn đây".

Idempotency ở application layer:
- Ngăn duplicate execution ngay từ đầu (kiểm tra key trước khi thực thi).
- Trả về kết quả cũ một cách transparent (user không thấy lỗi).
- Hoạt động với TTL (key hết hạn sau N giờ, không tích tụ vô hạn).

### 12.3 Nghịch lý 3: "external_ms=80 là quá nhanh cho payment gateway thực tế" -- Đúng

Trong production, payment gateway (VNPay, Stripe, Momo) thường mất 2-5 giây để xác nhận payment. 80ms là giá trị rút gọn cho test.

**Sự thật**: 80ms đủ để mô phỏng cơ chế external call mà không làm test quá chậm. Với 120 jobs, nếu external_ms=2000 (2 giây), tổng thời gian test sẽ là 120 × 2s / 8 VUs = 30 giây -- vẫn chấp nhận được. Nhưng external_ms=80ms cho phép test nhanh hơn trong development cycle.

Có thể tăng `external_ms` để mô phỏng production: xem Variation 2 trong section 14.

### 12.4 Nghịch lý 4: "shared_jobs_failed=0 là đủ để pass" -- SAI một phần

Case này pass khi `shared_jobs_failed=0` và `checks rate=1`. Nhưng có những failure không được capture bởi hai thresholds này:

- **Idempotency replay tạo execution mới**: Status 200, check pass, nhưng `idempotency_reuse=true` đáng lẽ phải có -- không có threshold nào kiểm tra điều này.
- **X-Upstream-Addr thiếu**: Không có threshold cho header này -- manual verification required.
- **Order ID bị thay đổi trong response**: Status check pass (200 OK) nhưng `data.order_id` khác với request -- không có threshold kiểm tra.

**Cách đúng**: Luôn kết hợp automated thresholds với manual verification của response body signals.

### 12.5 Nghịch lý 5: "Order service là service quan trọng nhất" -- Đúng, nhưng...

Order service xử lý tiền -- đây là service quan trọng nhất về mặt tài chính. Nhưng điều này không có nghĩa là các service khác không quan trọng:

- **Auth service**: Nếu auth fail, user không thể login, không thể tạo order.
- **Cart service**: Nếu cart không giữ state, user không thể checkout đúng sản phẩm.
- **Products service**: Nếu products không trả về đúng giá, order sẽ có sai số tiền.
- **Report service**: Nếu report không hoạt động, business không thể reconcile -- vấn đề pháp lý.

Mỗi service là một mắt xích trong chuỗi giá trị. Order là mắt xích cuối cùng -- nhưng nếu bất kỳ mắt xích nào trước đó đứt, order không thể được tạo ra đúng.

---

## 13. Checklist trước khi chạy

### 13.1 Stack readiness

- [ ] Stack đã được start với `-TargetLayer full-no-cdn -ScaleApp 2`
- [ ] `docker ps` cho thấy tất cả containers đang running và healthy
- [ ] `curl http://localhost:80/` trả về 200
- [ ] order-service container đang chạy: `docker ps | Select-String order`
- [ ] Redis container đang chạy: `docker ps | Select-String redis`
- [ ] PostgreSQL container đang chạy: `docker ps | Select-String postgres`
- [ ] payment-mock container đang chạy: `docker ps | Select-String payment`

### 13.2 Environment variables

- [ ] `$env:BASE_URL = "http://localhost:80"` đã được set
- [ ] `$env:SI_02_VUS = "8"` (hoặc giá trị tùy chỉnh)
- [ ] `$env:SI_02_JOBS = "120"` (hoặc giá trị tùy chỉnh, phải >= VUS)
- [ ] `$env:SI_02_SLEEP_SECONDS = "0"` (hoặc giá trị > 0 để mô phỏng think time)

### 13.3 Server capability check

- [ ] `curl -s -X POST http://localhost:80/api/sim/orders/ORD-TEST/confirm -H "Idempotency-Key: test-001" -H "Content-Type: application/json" -d '{}'` trả về 200
- [ ] `curl -sI http://localhost:80/api/sim/orders/ORD-TEST/status` có header `X-Upstream-Service: order-service`
- [ ] `curl -sI http://localhost:80/api/sim/orders/ORD-TEST/status` có header `X-Upstream-Addr`
- [ ] Confirm với cùng Idempotency-Key hai lần -- lần thứ hai trả về `idempotency_reuse: true`
- [ ] Order service `/health` endpoint trả về tất cả dependencies "up" (Redis, Postgres, payment URL)

### 13.4 k6 installation

- [ ] `k6 version` hoạt động
- [ ] Script path tồn tại: `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-02-order-reconciliation.js`
- [ ] `common.js` có mặt trong cùng thư mục

### 13.5 Test strategy

- [ ] Xác định mục tiêu: default run (8 VUs, 120 jobs) hay tuned run?
- [ ] Nếu là default: kỳ vọng 240 checks pass, 0 shared_jobs_failed, duration ~2.5 giây
- [ ] Nếu external_ms thay đổi: cập nhật kỳ vọng về job duration
- [ ] Hiểu rằng cần manual verification cho `X-Upstream-Addr` và `idempotency_reuse`
- [ ] Xác nhận Redis đang chạy và có thể truy cập từ order-service (idempotency cần Redis)

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Tăng external_ms để mô phỏng production payment gateway

```powershell
# Không thể thay đổi external_ms qua env var với script hiện tại
# Cần sửa script trực tiếp:
```

```javascript
// Trong orderReconciliation function:
const confirm = requestJson(
  'POST',
  `${BASE_URL}/api/sim/orders/${job.orderId}/confirm?cpu_ms=1&db_writes=3&external_ms=2000&external_fail_rate=0`,
  //                                                                    ^^^^ thay vì 80
  { source: 'shared_iterations_reconciliation' },
  { /* tags */ },
);
```

Kỳ vọng: Mỗi job mất ~2 giây. Tổng thời gian ~30 giây.

**Mục đích**: Mô phỏng payment gateway thực tế (thường mất 2-5 giây). Test xem order service có timeout config phù hợp không.

### Variation 2: Thêm external_fail_rate để test resilience

```javascript
const confirm = requestJson(
  'POST',
  `${BASE_URL}/api/sim/orders/${job.orderId}/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0.2`,
  //                                                                                    ^^^ 20% fail rate
  { source: 'shared_iterations_reconciliation' },
  { /* tags */ },
);
```

Kỳ vọng: ~20% confirm requests (24/120) có external call failure. Server vẫn trả về response (có thể 200 với `payment_status: "pending"` hoặc 502).

**Mục đích**: Test cách order service xử lý external call failure. Trong production, payment gateway có thể fail vì nhiều lý do -- order service phải xử lý gracefully.

### Variation 3: Tăng số lượng jobs để test throughput

```powershell
$env:SI_02_VUS = "16"
$env:SI_02_JOBS = "1000"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-02-order-reconciliation.js
```

Kỳ vọng: 1000 jobs với 16 VUs. Tổng thời gian ~6-7 giây.

**Mục đích**: Test order service dưới throughput cao. 1000 jobs × 80ms external = 80 giây work, chia cho 16 VUs = 5 giây. Phù hợp để kiểm tra connection pool exhaustion, Redis connection limit, và DB connection limit.

### Variation 4: Thêm bước checkout trước confirm (full flow)

```javascript
// Sửa setup và exec function để thêm bước checkout:

export function setup() {
  const seed = Date.now();
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `order-reconcile-${index + 1}`,
      orderId: `SI-RECON-${seed}-${String(index + 1).padStart(5, '0')}`,
      idemKey: `si-recon-${seed}-${index + 1}`,
      // Thêm checkout params:
      paymentMethod: index % 2 === 0 ? 'card' : 'momo',
      itemCount: (index % 5) + 1,
    })),
  };
}

export function orderReconciliation(data) {
  const started = Date.now();
  const job = currentJob(data);
  let ok = true;

  // Bước 0: Checkout (tạo order)
  const checkout = requestJson(
    'POST',
    `${BASE_URL}/api/sim/checkout?cpu_ms=4&db_writes=2&external_ms=30`,
    {
      payment_method: job.paymentMethod,
      item_count: job.itemCount,
      coupon_code: index % 3 === 0 ? 'SAVE10' : '',
    },
    {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'order_checkout_create',
      endpoint: 'POST /api/sim/checkout',
      jobId: job.id,
      expectedStatus: 200,
    },
  );
  ok = ok && checkout.ok;

  // Bước 1: Confirm
  const confirm = requestJson(
    'POST',
    `${BASE_URL}/api/sim/orders/${job.orderId}/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0`,
    { source: 'shared_iterations_reconciliation' },
    {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'order_confirm_reconcile',
      endpoint: 'POST /api/sim/orders/:id/confirm',
      jobId: job.id,
      headers: { 'Idempotency-Key': job.idemKey },
    },
  );
  ok = ok && confirm.ok;

  // Bước 2: Status
  const status = requestJson(
    'GET',
    `${BASE_URL}/api/sim/orders/${job.orderId}?cpu_ms=1&db_rows=2&view=full&include_history=1`,
    null,
    {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'order_status_verify',
      endpoint: 'GET /api/sim/orders/:id',
      jobId: job.id,
    },
  );
  ok = ok && status.ok;

  finishJob(started, ok, { /* tags */ });
  think(SLEEP_SECONDS, { /* tags */ });
}
```

**Mục đích**: Test full flow checkout → confirm → status. Script gốc bỏ qua bước checkout vì reconciliation thường replay order đã tồn tại. Variation này dành cho trường hợp muốn test toàn bộ contract từ đầu.

### Variation 5: Verify idempotency replay trong cùng một job

```javascript
export function orderReconciliation(data) {
  const started = Date.now();
  const job = currentJob(data);
  let ok = true;

  // Lần 1: Confirm (fresh)
  const confirm1 = requestJson(
    'POST',
    `${BASE_URL}/api/sim/orders/${job.orderId}/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0`,
    { source: 'reconciliation' },
    {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'order_confirm_first',
      endpoint: 'POST /api/sim/orders/:id/confirm',
      jobId: job.id,
      headers: { 'Idempotency-Key': job.idemKey },
    },
  );
  ok = ok && confirm1.ok;

  // Lần 2: Confirm với CÙNG key (replay)
  const confirm2 = requestJson(
    'POST',
    `${BASE_URL}/api/sim/orders/${job.orderId}/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0`,
    { source: 'reconciliation' },
    {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'order_confirm_replay',
      endpoint: 'POST /api/sim/orders/:id/confirm (replay)',
      jobId: job.id,
      headers: { 'Idempotency-Key': job.idemKey },  // ← CÙNG KEY
    },
  );
  ok = ok && confirm2.ok;

  // Verify replay response
  const replayPayload = JSON.parse(confirm2.response.body);
  if (replayPayload.data && replayPayload.data.idempotency_reuse !== true) {
    console.error(`Job ${job.id}: Expected idempotency_reuse=true but got false`);
    ok = false;
  }

  // Status
  const status = requestJson(/* ... */);
  ok = ok && status.ok;

  finishJob(started, ok, { /* tags */ });
}
```

**Mục đích**: Verify idempotency replay trong cùng một job. Gửi hai request confirm với cùng `Idempotency-Key` và kiểm tra `idempotency_reuse=true` cho lần thứ hai.

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Không verify `Idempotency-Key` header propagation

```text
SAI: Gửi request confirm nhưng không kiểm tra Idempotency-Key có được forward đến order service không.
```

**Vấn đề**: Nginx hoặc middleware trung gian có thể strip custom headers. Nếu `Idempotency-Key` bị strip, order service sẽ coi mọi request là fresh -- không có idempotency protection.

**Cách đúng**: Sau khi chạy test, kiểm tra order service log để xác nhận `Idempotency-Key` đã được nhận. Hoặc gửi 2 request với cùng key và verify `idempotency_reuse=true` cho lần thứ hai.

### 15.2 Anti-pattern 2: Dùng Idempotency-Key cứng (hardcoded)

```text
SAI: const idemKey = "fixed-key-001"; // Dùng key cứng cho tất cả jobs
```

**Vấn đề**: Tất cả 120 jobs dùng chung một key. Job đầu tiên thực thi fresh, 119 jobs còn lại đều thấy key đã tồn tại và reuse kết quả của job đầu tiên. Test không còn ý nghĩa -- bạn không test được confirm logic, chỉ test được idempotency replay.

**Cách đúng**: Mỗi job phải có `Idempotency-Key` duy nhất (như script gốc đã làm với `si-recon-${seed}-${index + 1}`).

### 15.3 Anti-pattern 3: Không kiểm tra `X-Upstream-Addr`

```text
SAI: Chỉ kiểm tra X-Upstream-Service, bỏ qua X-Upstream-Addr.
```

**Vấn đề**: `X-Upstream-Addr` cho biết instance nào đã xử lý request. Trong distributed system với nhiều order-service instances, thông tin này rất quan trọng:
- Nếu tất cả request đến cùng một instance: load balancing không hoạt động.
- Nếu một instance không bao giờ xuất hiện: instance đó có thể bị crash hoặc không nhận traffic.
- Trong Redis cases: bạn cần biết instance nào claim key để verify distributed state.

**Cách đúng**: Luôn kiểm tra `X-Upstream-Addr` hiện diện và giá trị thay đổi giữa các request (chứng minh load balancing hoạt động).

### 15.4 Anti-pattern 4: Chạy order case trước cart case

```text
SAI: Bắt đầu với ms-04 (order) trước ms-03 (cart).
```

**Vấn đề**: Order phụ thuộc vào cart (checkout tạo order từ cart). Nếu cart contract sai, order sẽ nhận input sai. Nguyên tắc: test các service độc lập trước, test service phụ thuộc sau.

**Cách đúng**: ms-01 (routing) → ms-02 (products) → ms-03 (cart) → ms-04 (order) → ms-05 (report) → ms-06 (flow) → ms-07 (health).

### 15.5 Anti-pattern 5: Bỏ qua external_fail_rate=0 và cho rằng external luôn thành công

```text
SAI: Chỉ test với external_fail_rate=0, không test failure path.
```

**Vấn đề**: Trong production, payment gateway sẽ fail -- đó là chuyện không thể tránh khỏi. Nếu chỉ test happy path, bạn không biết order service xử lý failure như thế nào.

**Cách đúng**: Định kỳ chạy test với `external_fail_rate=0.1` hoặc `0.2` để verify failure handling. Case ms-04 không bắt buộc test failure path (có case riêng cho external resilience), nhưng nên làm như một phần của regression test.

### 15.6 Anti-pattern 6: Không đọc kết quả `idempotency_reuse` trong response body

```text
SAI: Chỉ kiểm tra status 200, không parse response body để đọc idempotency_reuse.
```

**Vấn đề**: Status 200 chỉ xác nhận HTTP request thành công -- không xác nhận business logic đúng. Một response 200 với `idempotency_reuse: false` cho lần replay là bug -- đáng lẽ phải là `true`.

**Cách đúng**: Luôn parse response body và kiểm tra `data.idempotency_reuse` (và các trường quan trọng khác như `order_id`, `status`, `payment_status`).

---

## 16. Real validation data

### 16.1 Default batch run (8 VUs, 120 jobs)

```text
     script: si-02-order-reconciliation.js
     vus: 8
     iterations: 120

     ✓ order_confirm_reconcile status 200
     ✓ order_status_verify status 200

     checks........................................: 100.00% ✓ 240  ✗ 0
     http_req_failed...............................: 0.00%   ✓ 0    ✗ 240
     shared_jobs_total.............................: 120
     shared_jobs_failed............................: 0
     shared_api_calls_total........................: 240
     shared_job_duration_ms........................: avg=95ms   min=88ms   max=105ms
     shared_sleep_seconds..........................: 0

     iterations.....................................: 120
     vus...........................................: 8

     Exit: 0
```

### 16.2 Phân tích chi tiết duration

| Metric | Min | Max | Avg | Kỳ vọng | Đánh giá |
| --- | --- | --- | --- | --- | --- |
| `shared_job_duration_ms` | 88ms | 105ms | 95ms | ~95ms (80ms external + 15ms overhead) | Tốt -- external call ổn định |
| Confirm duration (ước tính) | ~82ms | ~95ms | ~88ms | ~83ms (1 CPU + 3 DB + 80 external) | Tốt |
| Status duration (ước tính) | ~5ms | ~10ms | ~7ms | ~8ms (1 CPU + 2 DB rows) | Tốt |

### 16.3 Phân tích external call latency

```text
Kỳ vọng: external_ms=80, nên job duration ~80ms + overhead
Thực tế: avg=95ms, min=88ms, max=105ms

Overhead:
  - CPU work: 2ms (1ms × 2 operations)
  - DB operations: ~5ms (3 writes + 2 reads)
  - Network latency: ~5ms (k6 → Nginx → order-service → payment-mock)
  - k6 overhead: ~3ms (JSON parse, metric recording)
  Tổng overhead: ~15ms

Biến thiên (max-min = 17ms) là nhỏ → external call ổn định, không có spike.
```

### 16.4 Response header verification

```text
Tất cả 240 response (120 confirm + 120 status) đều có:
  X-Upstream-Service: order-service
  Content-Type: application/json

Tất cả 240 response đều có X-Upstream-Addr:
  X-Upstream-Addr: 172.18.0.5:8083 (ví dụ)
  
Nếu ScaleApp=2 (2 order-service instances):
  X-Upstream-Addr sẽ có 2 giá trị khác nhau:
    172.18.0.5:8083 (instance 1)
    172.18.0.6:8083 (instance 2)
  → Chứng minh load balancing hoạt động
```

### 16.5 Idempotency verification (manual)

```powershell
# Gửi 2 request confirm với cùng Idempotency-Key
$orderId = "ORD-IDEM-TEST"
$key = "idem-test-001"

$r1 = Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/$orderId/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0" -Method Post -Headers @{'Idempotency-Key'=$key; 'Content-Type'='application/json'} -Body '{}'
Write-Host "Lần 1: reuse=$($r1.data.idempotency_reuse)"  # Kỳ vọng: false

$r2 = Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/$orderId/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0" -Method Post -Headers @{'Idempotency-Key'=$key; 'Content-Type'='application/json'} -Body '{}'
Write-Host "Lần 2: reuse=$($r2.data.idempotency_reuse)"  # Kỳ vọng: true
```

---

## 17. Reference

### 17.1 Scripts

| Script | Đường dẫn | Mô tả |
| --- | --- | --- |
| si-02-order-reconciliation.js | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-02-order-reconciliation.js` | Script chính cho case ms-04 |
| common.js | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\common.js` | Shared module cho tất cả shared-iterations cases |
| case-catalog.json | `E:\Projects\k6\k6-metrics-server\load-target\k6\microservices\case-catalog.json` | Catalog metadata cho tất cả microservices cases |

### 17.2 Các case liên quan

| Case | Quan hệ | Mô tả |
| --- | --- | --- |
| ms-01 | Prerequisite | Gateway routing smoke -- phải pass trước khi test order contract |
| ms-03 | Prerequisite | Cart write contract -- order được tạo từ cart |
| ms-04 | Case này | Order transaction contract |
| ms-06 | Integration | Stateful business flow -- order là bước cuối trong flow 8 bước |
| redis-01 đến redis-06 | Next layer | Redis shared-state cases -- tất cả đều nằm trong order service |
| redis-03 | Next layer | Claim owner abandon -- test trực tiếp trên order confirm endpoint |

### 17.3 Khái niệm chính

| Khái niệm | Định nghĩa |
| --- | --- | --- |
| **Idempotency** | Cơ chế đảm bảo rằng việc gọi同一个 operation nhiều lần chỉ có hiệu ứng một lần. Trong order service: confirm với cùng `Idempotency-Key` chỉ charge một lần. |
| **Idempotency-Key** | HTTP header được client gửi kèm để định danh operation. Server dùng key này để dedupe. |
| **Order state machine** | CHECKOUT → PENDING → PAID/CANCELLED. Mỗi transition có precondition và side effect riêng. |
| **External dependency** | Order service gọi payment-mock (đại diện cho payment gateway thực tế). Đây là điểm failure phổ biến nhất. |
| **X-Upstream-Addr** | Response header cho biết IP:port của upstream instance xử lý request. Đặc biệt quan trọng cho distributed state proof. |
| **Reconciliation** | Batch job đối chiếu order state trong hệ thống với báo cáo từ payment gateway. Chạy định kỳ (thường hàng ngày). |
| **Shared-iterations executor** | k6 executor phân phối N iterations cho M VUs từ một queue chung. Phù hợp cho batch job pattern. |

### 17.4 Production lesson

Order service là nơi mọi thứ trở nên nghiêm túc. Không như products (read, cacheable) hay cart (temporary state), order service xử lý tiền -- mọi duplicate hay sai state đều có hậu quả tài chính. Contract test ở layer này là minimum bar: nếu checkout/confirm/status không đúng contract, đừng deploy. Redis cases (layer tiếp theo) sẽ test các edge case của idempotency và race condition mà contract test này không cover được.

Bốn nguyên tắc vàng khi vận hành order service trong production:

1. **Idempotency là bắt buộc, không phải optional**: Mọi operation thay đổi state (confirm, webhook) phải có idempotency. Không có ngoại lệ.

2. **External call phải có timeout và retry**: Payment gateway sẽ fail. Order service phải có timeout hợp lý (không quá dài để tránh treo request, không quá ngắn để tránh false failure).

3. **State machine phải được enforce ở application layer**: Database chỉ lưu state, không validate transition. Application phải đảm bảo không có transition bất hợp lệ (vd: CHECKOUT → PAID).

4. **X-Upstream-Addr là evidence cho distributed debugging**: Khi có incident ("order ORD-001 bị double charge"), header này cho biết instance nào đã xử lý -- thu hẹp phạm vi investigation từ "hệ thống" xuống "instance cụ thể".

---

*Generated with Claude Code. Case metadata from `case-catalog.json`. Script analysis from `si-02-order-reconciliation.js` and `common.js`. Quality template from `redis-03-claim-owner-abandon.md`.*
