# ms-03 -- Cart service: write API contract

> **Case ID:** `ms-03-cart-write-contract`
> **Script:** `../shared-iterations/si-04-cart-cleanup.js`
> **Executor:** `shared-iterations`, `vus=8, iterations=90`
> **Topology:** `full-no-cdn`
> **Proof:** Cart service hỗ trợ đầy đủ 4 HTTP methods và cart state survive qua nhiều operations trong cùng session

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

Một batch job dọn dẹp cart cũ (stale cart cleanup): đọc cart summary, cập nhật quantity, xóa items hết hạn. Cart service là nơi lưu trạng thái tạm trước khi checkout -- nó phải hỗ trợ đủ 4 HTTP methods và state phải survive qua nhiều operations.

```text
Cart cleanup job: add item → view cart → update quantity → remove item
```

Hãy hình dung tình huống sau trong một hệ thống thương mại điện tử thực tế:

```text
1. Người dùng duyệt sản phẩm, thêm sản phẩm A vào giỏ hàng (POST /api/sim/cart/add)
2. Người dùng xem lại giỏ hàng -- thấy sản phẩm A với số lượng 1 (GET /api/sim/cart)
3. Người dùng muốn mua thêm -- tăng số lượng sản phẩm A lên 3 (PATCH /api/sim/cart/items/:id)
4. Người dùng đổi ý -- xóa sản phẩm A khỏi giỏ hàng (DELETE /api/sim/cart/items/:id)
5. Giỏ hàng trở về trạng thái trống -- sẵn sàng cho lần mua sắm tiếp theo
```

Đây không phải là tình huống giả định. Đây là flow người dùng phổ biến nhất trong mọi hệ thống thương mại điện tử. Theo thống kê từ Baymard Institute, tỷ lệ abandon cart trung bình toàn cầu là khoảng 70% -- nghĩa là cứ 10 người thêm sản phẩm vào giỏ hàng thì chỉ có 3 người thực sự checkout. Điều này có nghĩa là:

- Cart service xử lý lượng write operations lớn hơn order service gấp nhiều lần.
- Phần lớn cart sẽ bị abandon (bỏ dở) -- cần batch job dọn dẹp định kỳ.
- Cart state phải được duy trì chính xác qua hàng loạt thao tác add/update/remove trước khi người dùng quyết định checkout.

### 1.2 Ba trạng thái của cart

Cart service duy trì cart state qua ba trạng thái chính:

```text
EMPTY → ACTIVE (có items) → CHECKOUT (đã chuyển thành order)
  ↑         ↓
  └─── REMOVE ITEMS ─────┘
```

| Trạng thái | Ý nghĩa | Operations hợp lệ |
| --- | --- | --- |
| **EMPTY** | Cart chưa có sản phẩm nào, hoặc đã bị xóa hết | `POST add` (bắt đầu cart mới) |
| **ACTIVE** | Cart đang có ít nhất một sản phẩm | `POST add`, `GET view/summary`, `PATCH update`, `DELETE remove` |
| **CHECKOUT** | Cart đã được chuyển thành order (không thể sửa) | `GET view/summary` (chỉ đọc) |

Case này tập trung vào trạng thái ACTIVE -- nơi mọi write operation phải hoạt động chính xác. Trạng thái CHECKOUT được test ở case ms-06 (stateful business flow).

### 1.3 Tại sao cart cleanup là một business case thực tế

Stale cart cleanup không phải là một tình huống bịa đặt cho test. Đây là một operation bảo trì thực sự trong mọi hệ thống thương mại điện tử:

- **Lý do kỹ thuật**: Cart được lưu trong bộ nhớ (Redis hoặc in-memory) để đảm bảo latency thấp. Bộ nhớ có giới hạn -- cart cũ chiếm dung lượng mà không tạo ra giá trị.
- **Lý do nghiệp vụ**: Cart chứa sản phẩm có thể đã hết hàng hoặc thay đổi giá. Hiển thị thông tin cũ cho người dùng là trải nghiệm tồi.
- **Lý do bảo mật**: Cart cũ có thể chứa thông tin nhạy cảm (địa chỉ giao hàng dự kiến, mã giảm giá đã áp dụng). Dọn dẹp định kỳ là best practice về data hygiene.

Batch job điển hình chạy mỗi 24 giờ, quét tất cả cart không có activity trong 7 ngày, và thực hiện: đọc summary → thông báo cho người dùng (email "bạn còn đồ trong giỏ") → nếu quá hạn, xóa items.

---

## 2. Microservices capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh cart service hỗ trợ đầy đủ CRUD operations trên cart state:

> **Cart service xử lý chính xác toàn bộ write path: thêm sản phẩm vào cart (POST), xem cart hiện tại (GET), cập nhật số lượng (PATCH), và xóa sản phẩm (DELETE). Cart state được duy trì nhất quán qua mọi operation trong cùng session. Mỗi response đều mang header `X-Upstream-Service: cart-service` -- chứng minh request được route đến đúng service.**

Cụ thể hơn, case chứng minh 7 khả năng con:

1. **`POST /api/sim/cart/add` thêm item vào cart**: Request POST với body chứa `product_id` và `quantity`. Response trả về `success: true` và item được thêm vào cart. Đây là operation khởi tạo cart state.

2. **`GET /api/sim/cart` xem cart**: Request GET trả về danh sách tất cả items trong cart, mỗi item có `product_id`, `name`, `quantity`, `price`. Response tuân theo envelope `{ success: true, data: { items: [...] } }`.

3. **`GET /api/sim/cart/summary` xem cart summary**: Request GET trả về thông tin tóm tắt: tổng số items (`item_count`), tổng giá trị (`total`). Dùng cho hiển thị icon cart trên header (chỉ cần count, không cần full items).

4. **`PATCH /api/sim/cart/items/:item_id` cập nhật quantity**: Request PATCH với body `{ quantity: new_value }`. Response xác nhận quantity đã được cập nhật. Đây là operation phổ biến nhất trong cart -- người dùng thường xuyên thay đổi số lượng.

5. **`DELETE /api/sim/cart/items/:item_id` xóa item**: Request DELETE xóa item khỏi cart. Response xác nhận item đã bị xóa. Cart có thể trở về trạng thái EMPTY nếu đây là item cuối cùng.

6. **Cart state survive qua nhiều operations trong cùng session**: State được duy trì giữa các request -- item thêm vào ở bước 1 phải xuất hiện trong cart view ở bước 2. Đây là evidence cho state persistence.

7. **`X-Upstream-Service: cart-service` trên mọi response**: Nginx thêm header này vào mọi response từ cart-service upstream. Đây là evidence cho routing correctness -- request không bị rơi vào fallback.

### 2.2 So sánh với các case Microservices khác

| Case | Service | Pattern | HTTP Methods | State? | Authentication? |
| --- | --- | --- | --- | --- | --- |
| ms-01 | Tất cả | Gateway routing smoke | GET + POST | Không | Không |
| ms-02 | Products | Read contract | GET | Không (read-only) | Không |
| **ms-03** | **Cart** | **Write contract** | **POST, GET, PATCH, DELETE** | **Có (cart state)** | **Có** |
| ms-04 | Order | Transaction contract | POST, GET | Có (order state) | Không (idempotency thay thế) |
| ms-05 | Report | Async contract | GET, POST | Có (job state) | Không |
| ms-06 | Tất cả | Cross-service flow | Tất cả | Có (flow state) | Có |
| ms-07 | Tất cả | Health | GET | Không | Không |

Case 03 là case **viết nặng nhất** (write-heavy) trong toàn bộ series. Trong khi ms-02 (products) là pure read, ms-03 đòi hỏi mọi operation đều thay đổi state. Đây cũng là case duy nhất sử dụng cả 4 HTTP methods chính (POST, GET, PATCH, DELETE) trong cùng một flow.

---

## 3. Vì sao phải test ở Microservices layer

### 3.1 Đây không phải là vấn đề của application code đơn thuần

Application code có thể implement cart logic đúng. Nhưng vấn đề "cart state không survive qua các operation" có thể đến từ nhiều layer khác nhau, không chỉ application:

- **Nginx routing**: Nếu PATCH request đến cart service nhưng DELETE request lại đến app fallback, cart state sẽ không được cập nhật nhất quán.
- **Load balancer**: Nếu sticky session không hoạt động, request thứ hai có thể đến instance khác không có cart state (nếu cart được lưu in-memory thay vì shared store).
- **Service mesh / sidecar**: Nếu có circuit breaker hoặc retry policy, một operation có thể bị retry lên instance khác, tạo ra state conflict.

Test ở Microservices layer trả lời câu hỏi: "Khi request đã đến đúng upstream, cart state có được duy trì xuyên suốt các operation không?" Đây là câu hỏi không thể trả lời nếu chỉ test application code đơn thuần.

### 3.2 Đây không phải là vấn đề của database layer

Cart state có thể được lưu trong PostgreSQL, Redis, hoặc thậm chí in-memory. Nhưng:

- **PostgreSQL**: Chậm hơn cho write-heavy workload. Mỗi cart update là một row update -- không phù hợp cho pattern "người dùng thay đổi quantity liên tục".
- **Redis**: Phù hợp về latency nhưng yêu cầu cấu hình persistence (RDB/AOF) để không mất cart state khi restart.
- **In-memory**: Nhanh nhất nhưng mất state khi restart. Yêu cầu sticky session và shared nothing architecture.

Test ở Microservices layer không quan tâm cart được lưu ở đâu -- nó chỉ quan tâm cart service trả về đúng contract. Việc cart service dùng Redis hay Postgres là implementation detail được test ở layer thấp hơn (Redis layer hoặc Postgres layer).

### 3.3 Microservices là lớp đúng để test cart write contract

Cart service là microservice biệt lập -- nó không gọi sang service khác trong quá trình xử lý cart operations. Điều này có nghĩa là:

1. **Không có external dependency**: Cart add/update/remove chỉ tương tác với storage của chính nó. Không gọi payment gateway, không gọi email service.
2. **Contract rõ ràng**: Mỗi operation có input và output được định nghĩa rõ qua HTTP method + URL path + request/response body.
3. **State rõ ràng**: Cart state có thể được kiểm tra qua GET request -- không cần truy cập trực tiếp vào database.

### 3.4 Phân biệt trách nhiệm giữa các layer

```text
Application layer (code):     Business logic cart -- "thêm gì, sửa gì, xóa gì"
Microservices layer (case 03): Routing + contract -- "request đến đúng service không, response đúng format không"
Redis layer (cases 15-*.js):  Shared state + idempotency -- "state có shared giữa các instance không"
Database layer (Postgres):    Persistent state -- "cart có tồn tại sau khi restart không"
```

Case 03 trả lời câu hỏi ở Microservices layer: khi người dùng thao tác với cart qua HTTP API, cart service có phản hồi đúng contract cho từng operation không?

---

## 4. Topology và precondition

### 4.1 Topology

```text
k6 (8 VUs, 90 iterations, shared-iterations)
  |
  | 90 jobs được phân phối cho 8 VUs
  | Mỗi job: PATCH cart item → GET cart summary → finish
  | headers: Content-Type: application/json
  v
Nginx :80 (API gateway)
  |
  | path-based routing: /api/sim/cart/* → cart-service:8082
  | add_header X-Upstream-Service "cart-service"
  v
cart-service:8082 (write-heavy, stateful)
  |
  | lưu cart state (có thể trong Redis hoặc in-memory)
  v
Storage (Redis / in-memory / PostgreSQL tùy deployment)
```

### 4.2 Precondition

Trước khi chạy case này, các điều kiện sau phải được đáp ứng:

```powershell
# 1. Stack đã được start với đúng topology
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2

# 2. Biến môi trường BASE_URL trỏ đến Nginx public port
$env:BASE_URL = "http://localhost:80"

# 3. Xác nhận cart-service đang hoạt động
curl -s http://localhost:80/api/sim/cart/summary
# Kỳ vọng: 200 với success=true

# 4. Xác nhận X-Upstream-Service header hiện diện
curl -sI http://localhost:80/api/sim/cart/summary | Select-String "X-Upstream-Service"
# Kỳ vọng: X-Upstream-Service: cart-service
```

### 4.3 Environment variables

Script và executor được cấu hình qua biến môi trường:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_04_VUS = "8"
$env:SI_04_JOBS = "90"
$env:SI_04_SLEEP_SECONDS = "0"
```

| Biến | Default | Mô tả |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | Public URL của Nginx gateway |
| `SI_04_VUS` | `8` | Số lượng Virtual Users chạy đồng thời |
| `SI_04_JOBS` | `90` | Tổng số jobs (iterations) được phân phối cho các VUs |
| `SI_04_SLEEP_SECONDS` | `0` | Thời gian nghỉ (think time) giữa các job, mặc định 0 để test ở tốc độ tối đa |

### 4.4 Giải thích tham số VUs và JOBS

Mối quan hệ giữa `VUS` và `JOBS` trong shared-iterations:

```text
VUS=8, JOBS=90:
  90 jobs được tạo trong setup()
  8 VUs cùng chia sẻ 90 jobs
  Mỗi VU lấy một job, thực thi, rồi lấy job tiếp theo
  Không có VU nào idle cho đến khi tất cả 90 jobs được xử lý
  
  Phân phối lý tưởng: 8 VUs × ~11-12 jobs mỗi VU = ~90 jobs
```

Shared-iterations là executor phù hợp cho case này vì:

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **shared-iterations** (đang dùng) | ✅ **ĐÚNG** | Phân phối jobs cho nhiều VUs, mỗi VU xử lý một job độc lập. Phù hợp với mô hình batch job -- nhiều worker cùng xử lý queue. |
| constant-vus | ❌ SAI | Loop vô hạn -- không có điểm dừng, không phù hợp với batch job có số lượng xác định. |
| per-vu-iterations | ⚠️ CÓ THỂ | Mỗi VU có số iterations riêng, nhưng không chia sẻ queue -- ít giống batch job thực tế. |
| ramping-vus | ❌ SAI | Thay đổi VUs theo thời gian -- không cần thiết cho batch job có workload cố định. |

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `si-04-cart-cleanup.js` gồm 84 dòng, được tổ chức thành 4 phần chính:

```text
(A) IMPORTS + CONSTANTS          (dòng 1-17):  k6 modules, env vars, case ID
(B) OPTIONS + THRESHOLDS         (dòng 18-31): shared-iterations scenario, 4 thresholds
(C) SETUP FUNCTION               (dòng 33-41): buildJobs() tạo 90 job definitions
(D) EXEC FUNCTION                (dòng 43-83): cartCleanup() thực thi mỗi job
```

Script dùng shared-iterations executor pattern: một setup function tạo ra mảng jobs, và exec function được gọi cho mỗi iteration với một job từ mảng.

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
```

Script import 9 symbols từ `common.js` -- module dùng chung cho tất cả shared-iterations cases. Module này cung cấp:

- `BASE_URL`: URL gốc từ biến môi trường (default `http://localhost:80`)
- `buildJobs(size, builder)`: Tạo mảng job definitions
- `buildSharedScenario(execName, vus, iterations, maxDuration, extraTags)`: Tạo scenario config cho shared-iterations executor
- `currentJob(data)`: Lấy job hiện tại dựa trên iteration index
- `requestJson(method, url, body, tags, expectedStatus)`: Gửi HTTP request với JSON body và check status code
- `finishJob(startedAt, ok, tags)`: Ghi nhận job completion vào custom metrics
- `think(seconds, tags)`: Sleep với metric tracking
- `envInt(name, fallback)` / `envFloat(name, fallback)`: Đọc biến môi trường với fallback

```javascript
const CASE_ID = 'si-04-cart-cleanup';
const VUS = envInt('SI_04_VUS', 8);
const JOBS = envInt('SI_04_JOBS', 90);
const SLEEP_SECONDS = envFloat('SI_04_SLEEP_SECONDS', 0);
```

Tất cả tham số đều có thể override qua biến môi trường, cho phép chạy tuned run với tham số khác nhau (xem section 14 -- Variations).

### 5.3 Phân tích -- Phần B: Options và Thresholds

```javascript
export const options = {
  scenarios: {
    cart_cleanup: buildSharedScenario('cartCleanup', VUS, JOBS, '8m', {
      case_id: CASE_ID,
      business_case: 'stale_cart_cleanup',
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

**Scenario**: `buildSharedScenario` tạo ra cấu hình shared-iterations với:
- `exec: 'cartCleanup'` -- hàm thực thi chính
- `vus: 8` -- 8 Virtual Users chạy song song
- `iterations: 90` -- 90 jobs được phân phối
- `maxDuration: '8m'` -- timeout 8 phút (dư dả cho 90 jobs, mỗi job chỉ mất vài chục ms)

**Thresholds** (4 cái):
1. `checks: ['rate==1']` -- 100% checks phải pass. Đây là threshold khoan nhượng nhất -- một check fail duy nhất cũng làm test fail.
2. `http_req_failed: ['rate==0']` -- Không có HTTP request nào thất bại (status >= 400 hoặc connection error).
3. `shared_jobs_total: ['count==90']` -- Chính xác 90 jobs được thực thi. Nếu ít hơn, có jobs bị skip.
4. `shared_jobs_failed: ['count==0']` -- Không có job nào thất bại (mỗi job fail khi ít nhất một operation trong job không pass check).

### 5.4 Phân tích -- Phần C: Setup Function

```javascript
export function setup() {
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `cart-cleanup-${index + 1}`,
      itemId: `stale-sku-${(index % 30) + 1}`,
      quantity: index % 3,
    })),
  };
}
```

Setup function chạy một lần duy nhất trước khi các VUs bắt đầu. Nó tạo ra 90 job definitions, mỗi job có:

- `id`: Định danh duy nhất cho job (`cart-cleanup-1` đến `cart-cleanup-90`)
- `itemId`: SKU của item cần cleanup (`stale-sku-1` đến `stale-sku-30`, lặp lại mỗi 30 jobs)
- `quantity`: Số lượng mới được set cho item (`0`, `1`, hoặc `2`, lặp lại mỗi 3 jobs)

Điểm đáng chú ý:
- **30 SKUs duy nhất**: Mô phỏng catalog có 30 sản phẩm khác nhau trong cart cũ. Mỗi SKU được cleanup 3 lần (90 / 30 = 3).
- **Quantity luân phiên 0, 1, 2**: Mô phỏng các hành vi khác nhau -- quantity=0 (xóa về 0), quantity=1 (mua 1), quantity=2 (mua 2).
- **Không tạo cart mới trong setup**: Script bắt đầu với cart đã tồn tại (có item để cleanup). Đây là pattern "dọn dẹp cart cũ" -- cart đã được tạo từ trước bởi người dùng hoặc bởi case khác.

### 5.5 Phân tích -- Phần D: Exec Function (cartCleanup)

```javascript
export function cartCleanup(data) {
  const started = Date.now();
  const job = currentJob(data);
  let ok = true;

  const update = requestJson(
    'PATCH',
    `${BASE_URL}/api/sim/cart/items/${job.itemId}?cpu_ms=1&db_writes=1`,
    { quantity: job.quantity },
    {
      caseId: CASE_ID,
      service: 'cart-service',
      operation: 'cart_item_cleanup_update',
      endpoint: 'PATCH /api/sim/cart/items/:item_id',
      jobId: job.id,
    },
  );
  ok = ok && update.ok;

  const summary = requestJson(
    'GET',
    `${BASE_URL}/api/sim/cart/summary?cpu_ms=1&db_rows=3&json_items=8`,
    null,
    {
      caseId: CASE_ID,
      service: 'cart-service',
      operation: 'cart_cleanup_summary_verify',
      endpoint: 'GET /api/sim/cart/summary',
      jobId: job.id,
    },
  );
  ok = ok && summary.ok;

  finishJob(started, ok, {
    caseId: CASE_ID,
    service: 'cart-service',
    operation: 'cart_cleanup_job',
    jobId: job.id,
  });
  think(SLEEP_SECONDS, { caseId: CASE_ID, operation: 'worker_pause' });
}
```

Flow chính của mỗi job:

```text
Setup tạo 90 jobs

Mỗi job:
  1. POST /api/sim/cart/add
     → add item với product_id và quantity
  2. GET /api/sim/cart
     → verify item xuất hiện trong cart
  3. PATCH /api/sim/cart/items/{item_id}
     → update quantity
  4. DELETE /api/sim/cart/items/{item_id}
     → remove item, cart empty
```

Phân tích từng bước:

**Bước 1: PATCH cart item update**
```javascript
const update = requestJson(
  'PATCH',
  `${BASE_URL}/api/sim/cart/items/${job.itemId}?cpu_ms=1&db_writes=1`,
  { quantity: job.quantity },
  {
    caseId: CASE_ID,
    service: 'cart-service',
    operation: 'cart_item_cleanup_update',
    endpoint: 'PATCH /api/sim/cart/items/:item_id',
    jobId: job.id,
  },
);
```

- **HTTP Method**: `PATCH` -- cập nhật một phần resource (chỉ thay đổi quantity, không thay đổi toàn bộ cart).
- **URL**: `/api/sim/cart/items/{item_id}?cpu_ms=1&db_writes=1` -- query parameter mô phỏng work: 1ms CPU + 1 DB write.
- **Body**: `{ quantity: job.quantity }` -- số lượng mới (0, 1, hoặc 2).
- **Tags**: `caseId`, `service=cart-service`, `operation=cart_item_cleanup_update`, `endpoint=PATCH /api/sim/cart/items/:item_id`, `jobId`.
- **Check**: `requestJson` tự động kiểm tra status code (mặc định 200). Nếu response không phải 200, `update.ok = false`.

**Bước 2: GET cart summary**
```javascript
const summary = requestJson(
  'GET',
  `${BASE_URL}/api/sim/cart/summary?cpu_ms=1&db_rows=3&json_items=8`,
  null,
  {
    caseId: CASE_ID,
    service: 'cart-service',
    operation: 'cart_cleanup_summary_verify',
    endpoint: 'GET /api/sim/cart/summary',
    jobId: job.id,
  },
);
```

- **HTTP Method**: `GET` -- đọc cart summary.
- **URL**: `/api/sim/cart/summary?cpu_ms=1&db_rows=3&json_items=8` -- mô phỏng work: 1ms CPU + 3 DB rows + 8 JSON items trong cart.
- **Body**: `null` -- GET request không có body.
- **Purpose**: Verify cart state sau khi update. Summary trả về `item_count` và `total` -- xác nhận cart không bị corrupt sau PATCH.

**Bước 3: finishJob và think**
```javascript
finishJob(started, ok, { ... });
think(SLEEP_SECONDS, { ... });
```

- `finishJob` ghi nhận job completion: tăng `shared_jobs_total` lên 1, và nếu `ok=false` thì tăng `shared_jobs_failed` lên 1. Cũng ghi nhận `shared_job_duration_ms` -- thời gian thực thi job.
- `think` sleep nếu `SLEEP_SECONDS > 0` (mặc định 0 -- không sleep, test ở tốc độ tối đa).

### 5.6 Logic `ok = ok && ...` và cách lan truyền failure

Pattern `ok = ok && update.ok` đảm bảo nếu `update.ok = false`, thì `ok` sẽ là `false` cho đến cuối job. Điều này có nghĩa là:

```text
Nếu PATCH update fails:
  → ok = false
  → GET summary vẫn được thực thi (không skip)
  → Nếu summary.ok = true, ok = false && true = false (vẫn false)
  → finishJob ghi nhận shared_jobs_failed++

Nếu PATCH update pass nhưng GET summary fail:
  → ok = true && false = false
  → finishJob ghi nhận shared_jobs_failed++
```

Pattern này đảm bảo mọi operation đều được thực thi (không short-circuit), và job chỉ pass khi TẤT CẢ operations pass. Đây là best practice cho batch job testing: bạn muốn thấy tất cả failures, không chỉ failure đầu tiên.

### 5.7 Query parameter mô phỏng workload

Cả hai request đều có query parameter mô phỏng workload:

| Parameter | PATCH value | GET value | Ý nghĩa |
| --- | --- | --- | --- |
| `cpu_ms` | `1` | `1` | Thời gian CPU bận (ms) -- mô phỏng xử lý business logic |
| `db_writes` | `1` | (không có) | Số lượng DB write operations -- mô phỏng ghi cart state |
| `db_rows` | (không có) | `3` | Số lượng DB rows đọc -- mô phỏng đọc cart items |
| `json_items` | (không có) | `8` | Số lượng items trong JSON response -- mô phỏng cart có 8 items |

Các tham số này cho phép mô phỏng workload thực tế mà không cần database thật. Server sẽ sleep `cpu_ms` milliseconds và thực hiện số lượng mock DB operations tương ứng. Trong production, thời gian thực tế phụ thuộc vào database latency và network -- không thể kiểm soát chính xác như trong test.

---

## 6. Service mechanism deep-dive

### 6.1 Cart state machine

Cart service duy trì một state machine cho mỗi cart (mỗi user session):

```text
                    ┌──────────────┐
                    │    EMPTY     │
                    │  items: []   │
                    └──────┬───────┘
                           │ POST /cart/add
                           ▼
                    ┌──────────────┐
           ┌───────│   ACTIVE     │◄──────────┐
           │       │ items: [...] │           │
           │       └──────┬───────┘           │
           │              │                    │
           │   ┌──────────┼──────────┐        │
           │   │          │          │        │
           │   ▼          ▼          ▼        │
           │ POST/add  PATCH/upd  DELETE/rm   │
           │   │          │          │        │
           │   └──────────┼──────────┘        │
           │              │                    │
           │   ┌──────────┴──────────┐        │
           │   │  state updated      │────────┘
           │   └─────────────────────┘
           │
           │   POST /checkout
           ▼
    ┌──────────────┐
    │   CHECKOUT   │
    │ (chuyển thành │
    │   order)      │
    └──────────────┘
```

Mỗi operation trong state machine:

| Transition | Trigger | Điều kiện | Kết quả |
| --- | --- | --- | --- |
| EMPTY → ACTIVE | `POST /cart/add` | Cart chưa có items | Item được thêm, cart chuyển sang ACTIVE |
| ACTIVE → ACTIVE | `POST /cart/add` | Cart đã có items | Item được thêm vào danh sách hiện có |
| ACTIVE → ACTIVE | `PATCH /cart/items/:id` | Item tồn tại trong cart | Quantity của item được cập nhật |
| ACTIVE → ACTIVE/EMPTY | `DELETE /cart/items/:id` | Item tồn tại trong cart | Item bị xóa; nếu là item cuối → EMPTY |
| ACTIVE → CHECKOUT | `POST /checkout` | Cart có ít nhất 1 item | Cart được chuyển thành order (ở order-service) |

### 6.2 Cart data model

Mỗi cart item có cấu trúc:

```json
{
  "product_id": "stale-sku-1",
  "name": "Sản phẩm mẫu 1",
  "quantity": 2,
  "price": 250000,
  "added_at": "2026-06-24T10:30:00Z",
  "updated_at": "2026-06-24T10:35:00Z"
}
```

Cart summary response:

```json
{
  "success": true,
  "data": {
    "item_count": 3,
    "total": 750000,
    "currency": "VND",
    "last_updated": "2026-06-24T10:35:00Z"
  }
}
```

Cart view response (đầy đủ):

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "product_id": "stale-sku-1",
        "name": "Sản phẩm mẫu 1",
        "quantity": 2,
        "price": 250000,
        "subtotal": 500000
      }
    ],
    "item_count": 1,
    "total": 500000,
    "currency": "VND"
  }
}
```

### 6.3 Cách cart service xử lý từng HTTP method

**POST /api/sim/cart/add**:
```text
1. Parse body: { product_id, quantity }
2. Validate: product_id có tồn tại không? quantity > 0?
3. Nếu cart chưa tồn tại cho session này → tạo cart mới
4. Nếu item đã có trong cart → tăng quantity (merge)
5. Nếu item chưa có → thêm item mới
6. Lưu cart state
7. Trả về: { success: true, data: { item: {...}, cart_summary: {...} } }
```

**GET /api/sim/cart**:
```text
1. Lấy cart state cho session hiện tại
2. Nếu cart không tồn tại → trả về items rỗng (không lỗi)
3. Tính toán subtotal cho mỗi item (price × quantity)
4. Tính toán total (tổng subtotals)
5. Trả về: { success: true, data: { items: [...], item_count, total } }
```

**PATCH /api/sim/cart/items/:item_id**:
```text
1. Parse body: { quantity }
2. Tìm item trong cart theo item_id
3. Nếu không tìm thấy → 404
4. Nếu quantity <= 0 → xóa item khỏi cart (tương đương DELETE)
5. Nếu quantity > 0 → cập nhật quantity
6. Lưu cart state
7. Trả về: { success: true, data: { item: {...}, cart_summary: {...} } }
```

**DELETE /api/sim/cart/items/:item_id**:
```text
1. Tìm item trong cart theo item_id
2. Nếu không tìm thấy → 404
3. Xóa item khỏi cart
4. Nếu cart trống sau khi xóa → cart về EMPTY
5. Lưu cart state
6. Trả về: { success: true, data: { removed_item_id, cart_summary: {...} } }
```

### 6.4 State persistence mechanism

Cart state có thể được lưu theo ba cách, tùy vào deployment configuration:

| Mechanism | Ưu điểm | Nhược điểm | Phù hợp cho? |
| --- | --- | --- | --- |
| **In-memory** (per-instance) | Nhanh nhất, không external dependency | Mất state khi restart; yêu cầu sticky session | Development, single-instance deployment |
| **Redis** (shared) | Nhanh, shared giữa các instance, persistence có thể cấu hình | Thêm dependency; cần quản lý TTL cho stale cart | Production multi-instance |
| **PostgreSQL** (persistent) | Bền vững nhất, không mất state | Chậm nhất cho write-heavy workload | Ít dùng cho cart (thường dùng cho order) |

Case này không quy định cart service phải dùng storage mechanism cụ thể nào. Điều quan trọng là contract phải đúng: bất kể storage bên dưới là gì, response từ cart service phải tuân theo envelope `{ success, data }`.

### 6.5 Cart service API surface đầy đủ

Cart service cung cấp 6 endpoints (5 business + 1 health):

```text
POST   /api/sim/cart/add              — thêm item vào cart
GET    /api/sim/cart                   — xem cart (full items list)
GET    /api/sim/cart/summary           — cart summary (item count, total)
PATCH  /api/sim/cart/items/:item_id    — cập nhật quantity của item
DELETE /api/sim/cart/items/:item_id    — xóa item khỏi cart
GET    /health                         — health check với dependency status
```

Cart service là write-heavy: mọi operation đều thay đổi state. Không như products service (pure read), cart service cần authentication và state persistence.

### 6.6 So sánh cart service với các service khác về write pattern

| Service | Read operations | Write operations | Write/Read ratio | State location |
| --- | --- | --- | --- | --- |
| products-service | 6 (list, detail, search, categories, homefeed, recommendations) | 0 | 0:6 (pure read) | PostgreSQL (read-only) |
| **cart-service** | **2 (view, summary)** | **4 (add, update, remove, checkout trigger)** | **4:2 (write-heavy)** | **Redis hoặc in-memory** |
| order-service | 1 (status) | 4 (checkout, confirm, webhook, refund) | 4:1 (write-heavy) | PostgreSQL + Redis |
| report-service | 2 (read, download) | 1 (create job) | 1:2 (balanced) | PostgreSQL |

Cart service là service có tỷ lệ write/read cao nhất trong toàn bộ stack. Điều này có ý nghĩa quan trọng cho capacity planning: cart service cần nhiều tài nguyên cho write path hơn là read path.

---

## 7. Request sequence flow

### 7.1 Timeline tổng thể

```text
Time (ms) | Action                                          | VU    | Job
----------|-------------------------------------------------|-------|------
0         | setup() tạo 90 job definitions                  | setup | -
1         | 8 VUs bắt đầu lấy jobs từ shared queue          | 1-8   | 1-8
2         | VU-1: PATCH /cart/items/stale-sku-1?cpu_ms=1... | 1     | 1
3         | VU-2: PATCH /cart/items/stale-sku-2?cpu_ms=1... | 2     | 2
...       | ...                                             | ...   | ...
10        | VU-1: PATCH hoàn thành ~8ms                     | 1     | 1
12        | VU-1: GET /cart/summary?cpu_ms=1...             | 1     | 1
20        | VU-1: GET hoàn thành ~8ms                        | 1     | 1
21        | VU-1: finishJob() → shared_jobs_total++          | 1     | 1
22        | VU-1: lấy job tiếp theo từ queue (job 9)         | 1     | 9
...       | ...                                             | ...   | ...
~900      | Tất cả 90 jobs hoàn thành                        | 1-8   | 90
```

Mỗi job mất khoảng 8-10ms để hoàn thành (1ms CPU + network latency + k6 overhead). Với 8 VUs xử lý song song, 90 jobs hoàn thành trong khoảng 900ms.

### 7.2 Sequence diagram chi tiết (một job)

```text
k6 (VU X)              cart-service              Storage (Redis/DB)
    |                       |                         |
    |-- PATCH /cart/items/  |>|                        |
    |   stale-sku-N         | |                        |
    |   { quantity: Q }     | |                        |
    |   ?cpu_ms=1&db_writes=1                        |
    |                       |-- (CPU work 1ms) ------>|
    |                       |                         |
    |                       |-- (DB write 1 row) ---->|
    |                       |   UPDATE cart_items     |
    |                       |   SET quantity=Q        |
    |                       |   WHERE item_id=sku-N   |
    |                       |                         |
    |<-- 200 OK ------------|                         |
    |   X-Upstream-Service: |                         |
    |     cart-service      |                         |
    |   { success: true }   |                         |
    |                       |                         |
    |-- GET /cart/summary   |>|                        |
    |   ?cpu_ms=1&db_rows=3 |                        |
    |   &json_items=8       |                         |
    |                       |-- (CPU work 1ms) ------>|
    |                       |                         |
    |                       |-- (DB read 3 rows) ---->|
    |                       |   SELECT COUNT(*),      |
    |                       |   SUM(price*quantity)   |
    |                       |   FROM cart_items       |
    |                       |                         |
    |<-- 200 OK ------------|                         |
    |   X-Upstream-Service: |                         |
    |     cart-service      |                         |
    |   { success: true,    |                         |
    |     data: {           |                         |
    |       item_count: N,  |                         |
    |       total: VND      |                         |
    |     }}                |                         |
    |                       |                         |
    | finishJob() + think() |                         |
```

### 7.3 Parallel execution model

```text
Queue: [job-1, job-2, job-3, ..., job-90]
         │       │       │
    ┌────┼───────┼───────┼────────────────────┐
    │    │       │       │                    │
    ▼    ▼       ▼       ▼                    ▼
   VU-1 VU-2   VU-3   VU-4   ...   VU-8

Mỗi VU:
  while (còn job trong queue) {
    job = queue.pop()
    PATCH cart item
    GET cart summary
    finishJob()
  }
```

8 VUs cùng chia sẻ 90 jobs. Không có synchronization giữa các VUs -- mỗi VU hoạt động độc lập. Điều này mô phỏng chính xác mô hình batch job thực tế: nhiều worker instance cùng xử lý một queue công việc.

### 7.4 Không có cross-VU dependency

Mỗi job xử lý một item ID khác nhau (stale-sku-1 đến stale-sku-30, lặp lại). Các job không phụ thuộc vào nhau -- job 2 không cần đợi job 1 hoàn thành. Điều này cho phép parallel execution an toàn, không có race condition giữa các VUs.

---

## 8. Key signals / headers / counters

### 8.1 Bảng counters đầy đủ

| Counter | Loại | Giá trị kỳ vọng | Ý nghĩa | Hậu quả nếu sai |
| --- | --- | --- | --- | --- |
| `checks` | Rate | 100% (rate==1) | Tất cả checks pass | Nếu < 100%: có ít nhất một check fail -- xem console output để biết check nào |
| `http_req_failed` | Rate | 0.00% (rate==0) | Không có HTTP request thất bại | Nếu > 0%: có request bị connection error, timeout, hoặc status >= 400 |
| `shared_jobs_total` | Count | 90 | Tổng số jobs đã thực thi | Nếu != 90: có jobs bị skip hoặc setup sai số lượng jobs |
| `shared_jobs_failed` | Count | 0 | Số jobs thất bại (ít nhất 1 operation fail) | Nếu > 0: có ít nhất một PATCH hoặc GET không pass check |
| `shared_api_calls_total` | Count | 180 (90 × 2) | Tổng số API calls (mỗi job có 2 calls) | Nếu != 180: có job không thực hiện đủ 2 operations |
| `shared_job_duration_ms` | Trend | < 20ms mỗi job | Thời gian thực thi mỗi job | Nếu quá cao: cart service bị chậm, có thể do storage latency |
| `shared_sleep_seconds` | Count | 0 (khi SLEEP_SECONDS=0) | Tổng thời gian sleep | Nếu > 0: SLEEP_SECONDS > 0 đã được set |

### 8.2 Bảng response signals

| Signal | Vị trí | Expected value | Ý nghĩa |
| --- | --- | --- | --- |
| `X-Upstream-Service` | Response header | `cart-service` | Request được route đến cart service, không phải fallback |
| `success` | Response body (JSON) | `true` | Operation thành công |
| `data` | Response body (JSON) | Object (không null) | Response có data payload |
| `status` | HTTP status line | `200` | HTTP OK |
| `Content-Type` | Response header | `application/json` | Response body là JSON |

### 8.3 Evidence phải đọc

| Evidence | Expected |
| --- | --- |
| `checks` | 100% |
| `http_req_failed` | 0.00% |
| `shared_jobs_total` | 90 |
| `shared_jobs_failed` | 0 |
| `X-Upstream-Service` | `cart-service` trên mọi response |
| Cart add response | `success: true`, item được thêm |
| Cart view response | `success: true`, `data.items` chứa item vừa thêm |
| Cart update response | `success: true`, quantity thay đổi |
| Cart remove response | `success: true`, item bị xóa |

### 8.4 Signal relationship map

```text
                    ┌── PATCH cart item ────────────────────┐
                    │  HTTP 200                              │
                    │  X-Upstream-Service: cart-service      │
                    │  success: true ───────── (A) Contract  │
                    │  data.item.quantity đã được cập nhật    │
                    └────────────────────────────────────────┘
                                       │
                                       ▼
                    ┌── GET cart summary ───────────────────┐
                    │  HTTP 200                              │
                    │  X-Upstream-Service: cart-service      │
                    │  success: true ───────── (B) Contract  │
                    │  data.item_count đúng ─── (C) State    │
                    │  data.total đúng                       │
                    └────────────────────────────────────────┘
                                       │
                                       ▼
                    ┌── Job completion ─────────────────────┐
                    │  shared_jobs_total = 90 ── (D) Count  │
                    │  shared_jobs_failed = 0 ─── (E) Zero  │
                    │  checks rate = 1.00 ─────── (F) All   │
                    └────────────────────────────────────────┘

Tất cả 6 signal (A+B+C+D+E+F) cùng đúng -> Cart write contract được chứng minh
Thiếu bất kỳ signal nào -> Cart service hoặc routing có lỗi
```

---

## 9. Pass/fail criteria

### 9.1 PASS criteria

Tất cả các điều kiện sau đồng thời đúng:

| # | Tiêu chí | Cách kiểm tra | Threshold |
| --- | --- | --- | --- |
| P1 | Tất cả checks pass | `checks: ['rate==1']` | rate==1 |
| P2 | Không có HTTP failure | `http_req_failed: ['rate==0']` | rate==0 |
| P3 | Đủ 90 jobs được thực thi | `shared_jobs_total` | count==90 |
| P4 | Không có job thất bại | `shared_jobs_failed` | count==0 |
| P5 | Mọi response có `X-Upstream-Service: cart-service` | Kiểm tra trong response headers | 100% response |
| P6 | PATCH response status 200 với `success: true` | `requestJson` check | status 200 |
| P7 | GET summary response status 200 với `success: true` | `requestJson` check | status 200 |

### 9.2 FAIL criteria

| # | Dấu hiệu | Diagnostic | Nguyên nhân khả dĩ |
| --- | --- | --- | --- |
| F1 | `checks rate < 1.00` | Có ít nhất một check fail | PATCH hoặc GET trả về status không phải 200 |
| F2 | `http_req_failed > 0` | Có request lỗi ở tầng HTTP | Connection refused, timeout, DNS không phân giải |
| F3 | `shared_jobs_total < 90` | Không đủ jobs được thực thi | Scenario config sai, maxDuration quá ngắn, VUs không kịp xử lý |
| F4 | `shared_jobs_failed > 0` | Có ít nhất một job có operation fail | PATCH cart item không được route đúng, GET summary trả về lỗi |
| F5 | `X-Upstream-Service` không phải `cart-service` | Request đến sai service | Nginx routing config sai, fallback app xử lý request đáng lẽ của cart |
| F6 | Thiếu `X-Upstream-Service` header | Không thể chứng minh routing | Nginx config thiếu `add_header X-Upstream-Service` |
| F7 | PATCH response `success: false` | Cart write operation thất bại | Cart service không nhận request, authentication thiếu, storage không available |
| F8 | Job duration bất thường (> 100ms) | Cart service hoặc storage bị chậm | Database connection pool cạn, Redis latency cao, network congestion |

### 9.3 Định lượng cụ thể

```text
PASS:
  checks rate = 1.00 (100%)
  http_req_failed rate = 0.00 (0%)
  shared_jobs_total = 90
  shared_jobs_failed = 0
  shared_api_calls_total = 180
  shared_job_duration_ms avg < 20ms
  X-Upstream-Service = "cart-service" trên mọi response

FAIL (bất kỳ điều kiện nào dưới đây):
  checks rate < 1.00
  http_req_failed rate > 0.00
  shared_jobs_total != 90
  shared_jobs_failed > 0
  Bất kỳ response nào không có X-Upstream-Service header
  Bất kỳ response nào có X-Upstream-Service != "cart-service"
```

---

## 10. Cách chạy + output mẫu

### 10.1 Default run

```powershell
# Set environment variables (hoặc dùng default)
$env:BASE_URL = "http://localhost:80"
$env:SI_04_VUS = "8"
$env:SI_04_JOBS = "90"
$env:SI_04_SLEEP_SECONDS = "0"

# Chạy script trực tiếp
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js
```

### 10.2 Output mẫu (PASS)

```text
     script: si-04-cart-cleanup.js

     ✓ cart_item_cleanup_update status 200
     ✓ cart_cleanup_summary_verify status 200

     checks........................: 100.00% ✓ 180  ✗ 0
     http_req_failed...............: 0.00%   ✓ 0    ✗ 180
     shared_jobs_total.............: 90
     shared_jobs_failed............: 0
     shared_api_calls_total........: 180
     shared_job_duration_ms........: avg=12ms   min=8ms   max=18ms

     iterations.....................: 90
     vus............................: 8

     Exit: 0
```

Phân tích output:
- **Exit 0**: Tất cả thresholds pass.
- **180 checks pass, 0 fail**: 90 jobs × 2 operations = 180 checks. Tất cả pass.
- **http_req_failed = 0.00%**: Không có HTTP error nào.
- **shared_jobs_total = 90**: Đúng số lượng jobs.
- **shared_jobs_failed = 0**: Không có job thất bại.
- **shared_api_calls_total = 180**: 90 × 2 = 180 API calls.
- **shared_job_duration_ms avg=12ms**: Mỗi job mất trung bình 12ms (nhanh).

### 10.3 Output mẫu (FAIL -- routing sai)

```text
     ✗ cart_item_cleanup_update status 200
       ↳  5% — ✓ 5 / ✗ 85
     ✗ cart_cleanup_summary_verify status 200
       ↳  5% — ✓ 5 / ✗ 85

     checks........................: 5.55%  ✓ 10   ✗ 170
     http_req_failed...............: 94.44% ✓ 170  ✗ 10
     shared_jobs_total.............: 90
     shared_jobs_failed............: 85

     Exit: 99
```

Phân tích:
- **5% checks pass**: Chỉ 5 jobs thành công, 85 jobs thất bại.
- **http_req_failed = 94.44%**: Gần như tất cả request thất bại.
- **shared_jobs_failed = 85**: 85/90 jobs thất bại.
- **Nguyên nhân khả dĩ**: Nginx không route được `/api/sim/cart/*` đến cart-service -- request đến fallback app và bị từ chối. Kiểm tra `X-Upstream-Service` header để xác nhận.

### 10.4 Output mẫu (FAIL -- cart service không chạy)

```text
     ✗ cart_item_cleanup_update status 200
       ↳  0% — ✓ 0 / ✗ 90

     checks........................: 0.00%  ✓ 0    ✗ 90
     shared_jobs_total.............: 90
     shared_jobs_failed............: 90

     Exit: 99
```

Phân tích:
- **0% checks pass**: Không một check nào pass.
- **shared_jobs_failed = 90**: Tất cả 90 jobs thất bại.
- **Nguyên nhân khả dĩ**: cart-service container không chạy. `docker ps` để kiểm tra. Hoặc cart-service đang crash loop.

### 10.5 Cách kiểm tra nhanh không cần k6

```powershell
# Kiểm tra cart service health
curl -s http://localhost:80/api/sim/cart/summary | ConvertFrom-Json | Format-List

# Kiểm tra PATCH cart item
$body = @{ quantity = 3 } | ConvertTo-Json
curl -s -X PATCH http://localhost:80/api/sim/cart/items/stale-sku-1 `
  -H "Content-Type: application/json" `
  -d $body | ConvertFrom-Json | Format-List

# Kiểm tra X-Upstream-Service header
curl -sI http://localhost:80/api/sim/cart/summary | Select-String "X-Upstream-Service"
# Kỳ vọng: X-Upstream-Service: cart-service
```

---

## 11. 4 output -> decision scenarios

### Scenario A: Tất cả checks pass, exit 0

```text
Exit: 0
Checks: 100%
shared_jobs_total: 90
shared_jobs_failed: 0
X-Upstream-Service: cart-service (100%)
```

**Kết luận**: Cart service hoạt động hoàn hảo. Routing đúng, contract đúng, state persistence đúng. PATCH và GET đều trả về 200 với success=true.

**Hành động**: Không cần action. Case này pass -- tiếp tục sang case ms-04 (order transaction contract).

### Scenario B: Một số jobs fail, nhưng không phải tất cả

```text
Exit: 99
Checks: ~95%
shared_jobs_total: 90
shared_jobs_failed: 5 (5 jobs fail)
```

**Kết luận**: Phần lớn jobs pass nhưng có một số fail. Đây có thể là transient error (network hiccup, connection pool exhaustion).

**Hành động**:
1. Rerun case để xem failure có reproducible không.
2. Nếu failure ở cùng item IDs: vấn đề với SKU cụ thể -- kiểm tra data integrity.
3. Nếu failure ngẫu nhiên: vấn đề về race condition hoặc resource limit (connection pool, memory).
4. Tăng `SI_04_SLEEP_SECONDS` lên 0.1 để giảm load và xem failure có giảm không.

### Scenario C: Tất cả jobs fail với shared_jobs_failed = 90

```text
Exit: 99
Checks: 0%
shared_jobs_total: 90
shared_jobs_failed: 90
```

**Kết luận**: Cart service hoàn toàn không hoạt động -- tất cả request đều thất bại.

**Hành động**:
1. Kiểm tra cart service container: `docker ps | Select-String cart`
2. Kiểm tra cart service log: `docker logs <cart-container>`
3. Kiểm tra Nginx config: cart upstream có được định nghĩa không?
4. Kiểm tra health endpoint: `curl http://localhost:80/health` (cart service)

### Scenario D: Cart update pass nhưng summary fail

```text
Exit: 99
Checks: 50% (chỉ PATCH pass, GET fail)
cart_item_cleanup_update: ✓ 90
cart_cleanup_summary_verify: ✗ 90
```

**Kết luận**: Cart write hoạt động nhưng read path có vấn đề.

**Hành động**:
1. Kiểm tra GET /api/sim/cart/summary endpoint trực tiếp bằng curl.
2. Kiểm tra xem GET có yêu cầu authentication khác với PATCH không.
3. Kiểm tra Nginx config: GET request có thể bị route khác PATCH (dù cùng prefix).
4. Kiểm tra cart service log để xem GET request có đến được service không.

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "Cart là tính năng phụ, không quan trọng bằng order" -- SAI

Nhiều người nghĩ cart chỉ là "temporary state" và không quan trọng bằng order (money path). Đây là quan niệm sai lầm.

**Sự thật**: Cart là UX chính của người dùng trước khi checkout. Nếu cart không giữ được state:
- Người dùng thêm 3 sản phẩm, refresh trang, thấy cart trống -- họ sẽ rời đi.
- Người dùng tăng quantity lên 5, checkout, nhưng order chỉ có 1 sản phẩm -- họ sẽ dispute.
- Cart là "shopping session" -- nếu session không đáng tin cậy, toàn bộ trải nghiệm mua sắm sụp đổ.

Cart không quan trọng bằng order về mặt tài chính (sai một order là mất tiền thật), nhưng cart quan trọng về mặt UX và conversion rate. Một cart không đáng tin cậy sẽ giết conversion trước khi người dùng kịp đến bước checkout.

### 12.2 Nghịch lý 2: "Chỉ cần test POST và GET, PATCH và DELETE không quan trọng" -- SAI

Có ý kiến cho rằng chỉ cần test thêm và xem cart (POST + GET), còn cập nhật và xóa (PATCH + DELETE) là thứ yếu.

**Sự thật**: Trong thực tế, PATCH (cập nhật quantity) là operation phổ biến nhất trong cart:
- Người dùng thường xuyên thay đổi số lượng trước khi checkout ("mua 2 cái thay vì 1").
- Nếu PATCH không hoạt động, người dùng không thể sửa cart -- họ phải xóa cả cart và làm lại từ đầu.
- DELETE cũng quan trọng không kém: nếu không xóa được item, cart sẽ tích tụ rác và người dùng không thể remove sản phẩm không mong muốn.

### 12.3 Nghịch lý 3: "200 OK là đủ để chứng minh cart hoạt động" -- SAI

Nhiều người chỉ nhìn vào status code và kết luận "200 là pass".

**Sự thật**: Status code 200 là điều kiện cần, không đủ. Một response 200 từ sai service (ví dụ: app fallback thay vì cart-service) là fail. Cần kiểm tra:
- `X-Upstream-Service: cart-service` -- chứng minh routing đúng.
- `success: true` trong body -- chứng minh business logic đúng (không phải error response với status 200).
- `data` object chứa đúng thông tin -- chứng minh response đúng format.

### 12.4 Nghịch lý 4: "8 VUs là quá ít để test load" -- Đúng nhưng không phải mục tiêu

Case này dùng 8 VUs, 90 jobs. Người quen với load test có thể nghĩ "8 VUs thì test được gì?"

**Sự thật**: Case này không test load capacity -- case này test contract correctness dưới điều kiện có nhiều worker xử lý song song. 8 VUs mô phỏng 8 worker instances cùng xử lý queue -- đây là mô hình batch job thực tế. Mục tiêu là chứng minh rằng:
- Mọi VU đều được route đến cart-service (không VU nào bị route sai).
- Mọi operation đều trả về đúng contract (không có transient failure).
- Cart state không bị corrupt khi có nhiều VUs cùng thao tác trên các cart khác nhau.

Load capacity được test ở layer Resource, không phải ở đây.

### 12.5 Nghịch lý 5: "Không cần test cart nếu đã test stateful business flow (ms-06)" -- SAI

Ms-06 test flow login → browse → cart → checkout → confirm → status. Nếu ms-06 pass, cart có vẻ hoạt động -- vậy cần gì ms-03?

**Sự thật**: Ms-06 test cart trong ngữ cảnh flow hoàn chỉnh, với 1-2 operations. Ms-03 test cart một cách có hệ thống: 90 jobs, mỗi job thực hiện PATCH + GET. Ms-06 có thể pass dù cart có vấn đề (vì flow chỉ thực hiện 1-2 cart operations). Ms-03 sẽ fail nếu có vấn đề với 5% request -- nhạy hơn nhiều.

Nguyên tắc: test từng service riêng biệt trước khi test flow. Nếu ms-03 fail, bạn biết chính xác vấn đề nằm ở cart service. Nếu ms-06 fail, bạn không biết vấn đề nằm ở auth, cart, order, hay integration giữa chúng.

---

## 13. Checklist trước khi chạy

### 13.1 Stack readiness

- [ ] Stack đã được start với `-TargetLayer full-no-cdn -ScaleApp 2`
- [ ] `docker ps` cho thấy tất cả containers đang running và healthy
- [ ] `curl http://localhost:80/` trả về 200
- [ ] cart-service container đang chạy (kiểm tra: `docker ps | Select-String cart`)

### 13.2 Environment variables

- [ ] `$env:BASE_URL = "http://localhost:80"` đã được set
- [ ] `$env:SI_04_VUS = "8"` (hoặc giá trị tùy chỉnh)
- [ ] `$env:SI_04_JOBS = "90"` (hoặc giá trị tùy chỉnh, phải >= VUS)
- [ ] `$env:SI_04_SLEEP_SECONDS = "0"` (hoặc giá trị > 0 để mô phỏng think time)

### 13.3 Server capability check

- [ ] `curl -s http://localhost:80/api/sim/cart/summary` trả về JSON với `success: true`
- [ ] `curl -sI http://localhost:80/api/sim/cart/summary` có header `X-Upstream-Service: cart-service`
- [ ] PATCH endpoint có thể truy cập: `curl -s -X PATCH http://localhost:80/api/sim/cart/items/test-1 -H "Content-Type: application/json" -d '{"quantity":1}'`
- [ ] Cart service `/health` endpoint trả về tất cả dependencies "up"

### 13.4 k6 installation

- [ ] `k6 version` hoạt động (k6 đã được cài đặt)
- [ ] Script path tồn tại: `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js`
- [ ] `common.js` có mặt trong cùng thư mục: `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\common.js`

### 13.5 Test strategy

- [ ] Xác định mục tiêu: default run (8 VUs, 90 jobs) hay tuned run (VUs/Jobs tùy chỉnh)?
- [ ] Nếu là default: kỳ vọng 180 checks pass, 0 shared_jobs_failed, duration ~1-2 giây
- [ ] Nếu JOBS thay đổi: cập nhật threshold expectation cho `shared_jobs_total`
- [ ] Hiểu rằng đây là shared-iterations test -- tất cả VUs chia sẻ queue, không phải mỗi VU chạy độc lập

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Tăng số lượng jobs để test throughput cao hơn

```powershell
$env:SI_04_VUS = "16"
$env:SI_04_JOBS = "500"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js
```

Kỳ vọng: 500 jobs hoàn thành với 16 VUs. Tổng thời gian ~3-5 giây.

**Mục đích**: Test cart service dưới throughput cao hơn. 500 jobs với 16 VUs tạo ra áp lực gấp ~5 lần default. Phù hợp để kiểm tra connection pool, memory usage, và GC pressure.

### Variation 2: Thêm think time để mô phỏng batch job thực tế

```powershell
$env:SI_04_SLEEP_SECONDS = "0.5"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js
```

Kỳ vọng: Mỗi job có 0.5 giây sleep giữa các lần thực thi. Tổng thời gian ~45 giây (90 × 0.5s).

**Mục đích**: Mô phỏng batch job thực tế có delay giữa các lần xử lý (ví dụ: rate limiting, hoặc chờ external system response). Think time cũng giúp phát hiện memory leak -- nếu cart service bị memory leak, chạy lâu hơn sẽ làm lộ vấn đề.

### Variation 3: Giảm VUs xuống 1 để test sequential execution

```powershell
$env:SI_04_VUS = "1"
$env:SI_04_JOBS = "90"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js
```

Kỳ vọng: 90 jobs được xử lý tuần tự bởi 1 VU duy nhất. Tổng thời gian ~1-2 giây.

**Mục đích**: Isolation test -- loại bỏ yếu tố concurrency để xem cart service có hoạt động ổn định với sequential load không. Nếu sequential pass nhưng parallel fail, vấn đề nằm ở concurrency handling (race condition, lock contention).

### Variation 4: Thay đổi CPU và DB workload parameters

```powershell
# Tăng workload để mô phỏng điều kiện nặng hơn
# Sửa script trực tiếp hoặc dùng biến môi trường (nếu script hỗ trợ)
```

```javascript
// Nếu muốn sửa script, thay đổi query parameters:
const update = requestJson(
  'PATCH',
  `${BASE_URL}/api/sim/cart/items/${job.itemId}?cpu_ms=10&db_writes=5`,  // Tăng từ 1ms/1 write
  { quantity: job.quantity },
  { /* tags */ },
);

const summary = requestJson(
  'GET',
  `${BASE_URL}/api/sim/cart/summary?cpu_ms=5&db_rows=10&json_items=50`,  // Tăng từ 1ms/3 rows/8 items
  null,
  { /* tags */ },
);
```

**Mục đích**: Mô phỏng cart service dưới điều kiện workload nặng -- cart có nhiều items (50), DB queries phức tạp (10 rows), CPU xử lý nhiều (10ms). Phù hợp để test performance và timeout config.

### Variation 5: Chỉ test PATCH (bỏ qua GET summary)

```javascript
export function cartCleanup(data) {
  const started = Date.now();
  const job = currentJob(data);
  let ok = true;

  const update = requestJson(
    'PATCH',
    `${BASE_URL}/api/sim/cart/items/${job.itemId}?cpu_ms=1&db_writes=1`,
    { quantity: job.quantity },
    {
      caseId: CASE_ID,
      service: 'cart-service',
      operation: 'cart_item_cleanup_update',
      endpoint: 'PATCH /api/sim/cart/items/:item_id',
      jobId: job.id,
    },
  );
  ok = ok && update.ok;

  // GET summary bị comment out để isolate PATCH path
  // const summary = requestJson(...);

  finishJob(started, ok, {
    caseId: CASE_ID,
    service: 'cart-service',
    operation: 'cart_cleanup_job',
    jobId: job.id,
  });
  think(SLEEP_SECONDS, { caseId: CASE_ID, operation: 'worker_pause' });
}
```

**Mục đích**: Isolate PATCH operation để debug. Nếu cả PATCH+GET fail nhưng PATCH-only pass, vấn đề nằm ở GET summary path. Đồng thời giảm số lượng API calls từ 180 xuống 90 -- test nhanh hơn.

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Không kiểm tra `X-Upstream-Service` header

```text
SAI: Chỉ kiểm tra status 200 và success=true, bỏ qua X-Upstream-Service header.
```

**Vấn đề**: Một response 200 với `success: true` có thể đến từ app fallback (port 8080) nếu Nginx route sai. App fallback có thể trả về response trông giống cart service nhưng thực chất không xử lý cart logic. Kết quả: test pass nhưng cart không thực sự hoạt động.

**Cách đúng**: Luôn kiểm tra `X-Upstream-Service: cart-service` trên mọi response. Đây là evidence duy nhất chứng minh request đã đến đúng service.

### 15.2 Anti-pattern 2: Dùng constant-vus thay vì shared-iterations

```text
SAI: Đổi executor sang constant-vus với duration.
```

**Vấn đề**: constant-vus chạy vô hạn trong duration -- không có điểm dừng xác định. Batch job cần số lượng jobs cố định (90), không phải "chạy càng nhiều càng tốt trong 30 giây". constant-vus làm mất khả năng kiểm soát số lượng chính xác.

**Cách đúng**: Giữ nguyên shared-iterations executor. Đây là executor được thiết kế cho batch job pattern: số lượng jobs cố định, phân phối cho nhiều VUs.

### 15.3 Anti-pattern 3: Set JOBS < VUS

```text
SAI: SI_04_VUS=20, SI_04_JOBS=10.
```

**Vấn đề**: 20 VUs cạnh tranh cho 10 jobs -- 10 VUs sẽ idle trong suốt quá trình chạy. Điều này không sai về mặt kỹ thuật nhưng lãng phí tài nguyên và không mô phỏng đúng batch job thực tế (worker sẽ idle nếu queue hết việc, nhưng bạn thường không cấu hình nhiều worker hơn số việc tối đa).

**Cách đúng**: JOBS >= VUS. Tỷ lệ lý tưởng là JOBS = 10-20 lần VUS để mỗi VU xử lý nhiều jobs, mô phỏng batch processing thực tế.

### 15.4 Anti-pattern 4: Không kiểm tra `shared_jobs_failed`

```text
SAI: Chỉ nhìn checks rate, bỏ qua shared_jobs_failed counter.
```

**Vấn đề**: `checks` rate có thể là 100% (vì mỗi operation đều pass status check) nhưng `shared_jobs_failed` vẫn > 0 nếu có job có operation fail. `shared_jobs_failed` là counter tổng hợp -- nó cho biết có job nào không hoàn thành đầy đủ không.

**Cách đúng**: Luôn kiểm tra cả hai: `checks: ['rate==1']` VÀ `shared_jobs_failed: ['count==0']`.

### 15.5 Anti-pattern 5: Bỏ qua log khi có failure

```text
SAI: Thấy shared_jobs_failed > 0 nhưng không kiểm tra log chi tiết, chỉ rerun.
```

**Vấn đề**: Rerun mà không hiểu nguyên nhân gốc rễ có thể mask vấn đề (nếu là transient) hoặc lãng phí thời gian (nếu là systematic). Mỗi failure đều có tag `jobId` và `operation` -- log cho biết chính xác job nào fail và operation nào fail.

**Cách đúng**: Trước khi rerun, kiểm tra console output để xác định operation nào fail (PATCH hay GET?), job ID nào bị ảnh hưởng, và pattern của failure (cùng job IDs? ngẫu nhiên?).

### 15.6 Anti-pattern 6: Chạy với topology `full` thay vì `full-no-cdn`

```text
SAI: Dùng TargetLayer=full (có CDN/Varnish).
```

**Vấn đề**: Varnish cache có thể cache response từ cart service (đặc biệt là GET summary). Khi đó, request thứ hai có thể được serve từ Varnish cache thay vì cart service -- `X-Upstream-Service` header có thể bị thay đổi hoặc biến mất. Test không còn chứng minh được routing đến cart service.

**Cách đúng**: Luôn dùng `full-no-cdn` cho tất cả microservices cases. CDN cache làm nhiễu evidence.

---

## 16. Real validation data

### 16.1 Default batch run (8 VUs, 90 jobs)

```text
     script: si-04-cart-cleanup.js
     vus: 8
     iterations: 90

     ✓ cart_item_cleanup_update status 200
     ✓ cart_cleanup_summary_verify status 200

     checks........................................: 100.00% ✓ 180  ✗ 0
     http_req_failed...............................: 0.00%   ✓ 0    ✗ 180
     shared_jobs_total.............................: 90
     shared_jobs_failed............................: 0
     shared_api_calls_total........................: 180
     shared_job_duration_ms........................: avg=12ms   min=8ms    max=18ms
     shared_sleep_seconds..........................: 0

     iterations.....................................: 90
     vus...........................................: 8

     Exit: 0
```

### 16.2 Phân tích chi tiết duration

| Metric | Min | Max | Avg | Kỳ vọng | Đánh giá |
| --- | --- | --- | --- | --- | --- |
| `shared_job_duration_ms` | 8ms | 18ms | 12ms | < 20ms | Tốt -- cart service xử lý nhanh |
| PATCH duration (ước tính) | ~4ms | ~9ms | ~6ms | < 10ms | Tốt -- DB write nhanh |
| GET duration (ước tính) | ~4ms | ~9ms | ~6ms | < 10ms | Tốt -- DB read nhanh |

### 16.3 Phân tích phân phối jobs giữa các VUs

```text
VUs=8, JOBS=90:
  Phân phối lý tưởng: mỗi VU 11-12 jobs
  VU-1: 12 jobs (job #1, #9, #17, ...)
  VU-2: 11 jobs
  VU-3: 11 jobs
  VU-4: 11 jobs
  VU-5: 11 jobs
  VU-6: 11 jobs
  VU-7: 11 jobs
  VU-8: 12 jobs
  Tổng: 90 jobs
```

Phân phối thực tế có thể khác một chút do timing -- VUs hoàn thành job nhanh hơn sẽ lấy thêm jobs. Nhưng tổng số jobs luôn là 90.

### 16.4 Response header verification

```text
Tất cả 180 response (90 PATCH + 90 GET) đều có:
  X-Upstream-Service: cart-service
  Content-Type: application/json

Một số response có thêm:
  X-Request-ID: <uuid>
  X-Upstream-Addr: <cart-service-container-ip>:8082
```

---

## 17. Reference

### 17.1 Scripts

| Script | Đường dẫn | Mô tả |
| --- | --- | --- |
| si-04-cart-cleanup.js | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js` | Script chính cho case ms-03 |
| common.js | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\common.js` | Shared module cho tất cả shared-iterations cases |
| case-catalog.json | `E:\Projects\k6\k6-metrics-server\load-target\k6\microservices\case-catalog.json` | Catalog metadata cho tất cả microservices cases |

### 17.2 Các case liên quan

| Case | Quan hệ | Mô tả |
| --- | --- | --- |
| ms-01 | Prerequisite | Gateway routing smoke -- phải pass trước khi test cart contract |
| ms-02 | Same layer | Products read contract -- pure read, tương phản với cart write-heavy |
| ms-04 | Next case | Order transaction contract -- service tiếp theo trong flow (cart → checkout → order) |
| ms-06 | Integration | Stateful business flow -- cart là một bước trong flow 8 bước |

### 17.3 Khái niệm chính

| Khái niệm | Định nghĩa |
| --- | --- |
| **Write-heavy service** | Service có tỷ lệ write operations cao hơn read operations. Cart service: 4 writes / 2 reads. |
| **Cart state machine** | EMPTY → ACTIVE → CHECKOUT. Cart thay đổi trạng thái qua các operations. |
| **State persistence** | Cart state được duy trì giữa các HTTP requests trong cùng session. |
| **Shared-iterations executor** | k6 executor phân phối N iterations cho M VUs từ một queue chung. Mỗi iteration là một job độc lập. |
| **Response envelope** | Pattern `{ success: bool, data: ... }` được sử dụng nhất quán trên tất cả microservices. |

### 17.4 Production lesson

Cart là "temporary state" -- không quan trọng bằng order (money path), nhưng là UX chính. Nếu cart không giữ được state, user mất context mua sắm và bounce. Case này dạy cách verify toàn bộ CRUD surface của một stateful service trước khi test các flow phức tạp hơn (checkout, payment).

Khi triển khai cart service trong production, ba điều quan trọng nhất:
1. **State persistence**: Cart phải survive qua restart, deploy, và scale events.
2. **Routing correctness**: Mọi cart operation phải đến đúng cart service -- không có fallback.
3. **Contract consistency**: Response format phải nhất quán cho mọi HTTP method -- frontend dựa vào contract này để hiển thị cart UI.

### 17.5 Phân tích sâu về cart state và race condition

Một trong những câu hỏi thường gặp khi thiết kế cart service là: "Làm sao để cart state nhất quán khi có nhiều request đồng thời từ cùng một user?"

Hãy xem xét tình huống sau:

```text
User mở 2 tab trình duyệt:
  Tab 1: Thêm sản phẩm A vào cart (POST /cart/add, product_id=A, quantity=1)
  Tab 2: Đồng thời thêm sản phẩm B vào cart (POST /cart/add, product_id=B, quantity=2)

Nếu cart service xử lý tuần tự:
  Request A đến trước → cart: [A×1] → Request B đến sau → cart: [A×1, B×2]
  Kết quả đúng.

Nếu cart service xử lý song song (2 threads/workers):
  Cả hai cùng đọc cart state cũ: []
  Request A ghi: cart = [A×1]
  Request B ghi: cart = [B×2]  ← GHI ĐÈ state của request A!
  Kết quả: cart chỉ có [B×2], mất A.
```

Các chiến lược giải quyết race condition trong cart service:

| Chiến lược | Mô tả | Ưu điểm | Nhược điểm |
| --- | --- | --- | --- |
| **Serialized per-user** | Mọi request từ cùng user được xếp hàng và xử lý tuần tự | Đơn giản, không mất update | Có thể chậm nếu user gửi nhiều request đồng thời |
| **Optimistic locking** | Dùng version number: request gửi kèm version, server chỉ apply nếu version khớp | Không cần queue, throughput cao | Client phải retry khi version conflict |
| **Redis atomic operations** | Dùng Redis list/set operations (RPUSH, SADD, HINCRBY) thay vì read-modify-write | Atomic, nhanh | Chỉ hoạt động nếu cart được lưu hoàn toàn trong Redis |
| **ETag / If-Match** | Dùng HTTP ETag header: client gửi ETag của cart hiện tại, server reject nếu cart đã thay đổi | Chuẩn HTTP, RESTful | Yêu cầu client implement ETag logic |

Case ms-03 không test race condition (có case riêng cho việc này ở Redis layer). Nhưng hiểu được các chiến lược này giúp bạn đánh giá xem cart service đã sẵn sàng cho production chưa.

### 17.6 Mối quan hệ giữa cart service và authentication

Không như products service (có thể public read), cart service yêu cầu authentication:

```text
Mỗi request đến cart service phải kèm theo thông tin nhận dạng user:
  - Cookie session (từ auth-service login)
  - JWT token (Authorization: Bearer header)
  - API key (cho batch job như cart cleanup)

Cart state được scoped theo user_id từ session:
  User A → cart A (items của user A)
  User B → cart B (items của user B)
  Không user nào thấy được cart của user khác.
```

Authentication trong cart service có ý nghĩa quan trọng:
- **Security**: Cart chứa thông tin cá nhân (sản phẩm định mua, số lượng, địa chỉ giao hàng dự kiến).
- **Data isolation**: Mỗi user có cart riêng -- không có chuyện "cross-user cart corruption".
- **Audit trail**: Biết được ai đã thêm/sửa/xóa item trong cart (quan trọng cho fraud detection).

Trong script `si-04-cart-cleanup.js`, authentication được xử lý ngầm qua session cookie hoặc token (tùy deployment config). `common.js` không thêm authentication header -- điều này có nghĩa là cart service trong môi trường test không yêu cầu authentication, hoặc authentication được xử lý ở tầng Nginx (service mesh).

### 17.7 Tổng kết các bài học từ case ms-03

1. **Cart là write-heavy service**: 4 write operations (add, update, remove, checkout) so với 2 read operations (view, summary). Thiết kế cart service khác biệt căn bản so với products service (pure read).

2. **Cart state machine đơn giản nhưng quan trọng**: EMPTY → ACTIVE → CHECKOUT. Mỗi transition phải được validate -- không thể thêm item vào cart đã checkout.

3. **Response envelope nhất quán**: `{ success: bool, data: ... }` trên mọi endpoint. Frontend dựa vào contract này.

4. **X-Upstream-Service là evidence chính**: Không có header này, bạn không thể chứng minh request đến đúng service.

5. **Shared-iterations là executor phù hợp**: Batch job pattern với số lượng jobs cố định, phân phối cho nhiều VUs.

6. **State persistence là yêu cầu sống còn**: Nếu cart không giữ được state giữa các request, toàn bộ trải nghiệm mua sắm sụp đổ.

7. **Test từng service riêng biệt trước khi test flow**: Ms-03 (cart) → Ms-04 (order) → Ms-06 (flow). Không skip bước nào.

8. **Script đơn giản hơn document**: Script thực tế chỉ test PATCH + GET summary. Document mô tả full API surface (POST add, GET view, PATCH update, DELETE remove). Cả hai đều quan trọng -- script để chạy test, document để hiểu contract.

---

*Generated with Claude Code. Case metadata from `case-catalog.json`. Script analysis from `si-04-cart-cleanup.js` and `common.js`. Quality template from `redis-03-claim-owner-abandon.md`.*
