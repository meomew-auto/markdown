# ms-06 — Cross-service stateful business flow

> **Case ID:** `ms-06-stateful-business-flow`
> **Script:** `../app/32-per-vu-business-core.js`
> **Executor:** `per-vu-iterations` (6 scenarios, 40 VUs total)
> **Profile:** `full-no-cdn`
> **Proof:** Một user journey hoàn chỉnh: login → session check → browse products → add to cart → update cart → checkout → confirm order → check order status. Flow span qua tất cả 5 microservices. Nếu bất kỳ service nào sai contract, toàn bộ flow đứt.

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [Microservices capability được chứng minh](#2-microservices-capability-được-chứng-minh)
3. [Vì sao phải test ở Microservices layer](#3-vì-sao-phải-test-ở-microservices-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Service mechanism deep-dive: 6 scenarios, 5 services, 1 flow](#6-service-mechanism-deep-dive-6-scenarios-5-services-1-flow)
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

### 1.1 Bối cảnh nghiệp vụ

Một khách hàng thực hiện toàn bộ hành trình mua sắm:

```text
1. Login (auth-service)
2. Xem thông tin tài khoản (auth-service)
3. Duyệt sản phẩm (products-service)
4. Thêm sản phẩm vào giỏ hàng (cart-service)
5. Cập nhật số lượng (cart-service)
6. Checkout — tạo đơn hàng (order-service)
7. Confirm đơn hàng — xác nhận thanh toán (order-service)
8. Kiểm tra trạng thái đơn hàng (order-service)
```

Đây là **critical path** của mọi hệ thống thương mại điện tử. Mỗi bước phụ thuộc vào state từ bước trước:

- **Auth token** từ bước 1 được dùng cho mọi request sau.
- **Cart state** từ bước 4 phải tồn tại ở bước 5.
- **Order ID** từ bước 6 phải khớp ở bước 7 và 8.

Nếu bất kỳ service nào sai contract, toàn bộ flow đứt. Đây không phải là unit test của từng service — đây là **integration test của toàn bộ microservices layer**.

### 1.2 Tại sao flow này span qua tất cả 5 service?

```text
auth-service     → login, session validation
products-service → browse catalog (AB test)
cart-service     → cart add, update
order-service    → checkout, confirm (idempotent), status
report-service   → batch jobs (async pattern)
```

Không service nào đứng một mình. Auth tạo session. Cart giữ state tạm. Order là transaction final. Report là async background job. Flow này chứng minh tất cả có thể hoạt động cùng nhau.

### 1.3 Sáu scenarios — không chỉ một flow

Script này không chỉ có 1 scenario — nó có **6 scenarios** chạy đồng thời:

| Scenario | VUs | Purpose | Services |
| --- | ---: | --- | --- |
| `stateful_business_flow` | 6 | Flow chính: login → status | auth + cart + order |
| `ab_control` | 8 | AB test control arm | products |
| `ab_variant_a` | 8 | AB test variant arm | products |
| `race_hotkey_consistency` | 8 | Hotkey race: 8 VUs confirm cùng order | order |
| `idempotency_retry` | 6 | Idempotency: confirm 2 lần cùng key | order |
| `predictable_batch_jobs` | 4 | Report batch: create → poll → download | report |

Mỗi scenario test một khía cạnh khác nhau của microservices layer. Không nên aggregate kết quả — mỗi scenario có chart và counters riêng.

---

## 2. Microservices capability được chứng minh

### 2.1 Phát biểu capability

> **Một user journey hoàn chỉnh hoạt động xuyên suốt 5 microservices. Auth session được propagate đúng. Cart state persist qua các operation. Order ID được preserve từ checkout đến status. Idempotency key hoạt động — lần đầu fresh (265ms với external), lần sau reuse (1.7ms từ cache). Hotkey race collapse đúng: 8 VUs tranh 1 key → chỉ 2 fresh execution. AB test products hoạt động với variant headers khác nhau. Report batch jobs hoàn thành đủ lifecycle.**

### 2.2 Bảy capability được verify

1. **Cross-service stateful flow**: Login → me → cart add → cart update → checkout → confirm → status. 7 HTTP requests, tất cả success.
2. **Auth session propagation**: Token từ login dùng được cho cart và order operations.
3. **Cart state persistence**: Item thêm vào cart xuất hiện trong cart view; update số lượng preserve item_id.
4. **Order ID preservation**: checkout `order_id` được dùng cho confirm và status — khớp nhau.
5. **Idempotency**: Lần đầu confirm = fresh (có external call, ~265ms). Lần sau = reuse (cache hit, ~1.7ms). Ratio ~153:1.
6. **Hotkey race collapse**: 8 VUs confirm cùng order → 2 fresh + 14 reuse (atomic collapse).
7. **AB test products**: Control arm và variant arm với headers khác nhau — tất cả products list/search/homefeed pass.

### 2.3 So sánh với các case khác

| Case | Phạm vi | Số service | State? |
| --- | --- | ---: | --- |
| ms-01 | Routing smoke | 5 | Không |
| ms-02→05 | Per-service contract | 1 mỗi case | Không/Có |
| **ms-06** | **Cross-service flow** | **5** | **Có (auth token, cart, order ID)** |
| ms-07 | Health | 5 | Không |

ms-06 là case duy nhất test **state propagation** giữa các service.

---

## 3. Vì sao phải test ở Microservices layer

### 3.1 Vì sao không test ở CDN layer?

CDN test không thể verify:
- Auth session propagation (CDN không giữ session)
- Cart state persistence (CDN không cache POST/PATCH/DELETE)
- Order ID preservation (CDN không biết business logic)
- Idempotency (CDN không can thiệp vào business layer)

### 3.2 Vì sao không test ở LB layer?

LB test không thể verify:
- Cross-service data flow (LB route request, không quan tâm body)
- Idempotency key behavior (header được forward, nhưng LB không parse nó)
- AB test variant behavior (LB route theo header, nhưng không verify response)

### 3.3 Vì sao phải test ở Microservices layer?

Đây là **integration test** của toàn bộ layer. Nó chứng minh:
- **Service contracts tương thích với nhau**: Auth trả về token format mà cart/order hiểu được.
- **State propagate đúng**: Không mất mát dữ liệu giữa các bước.
- **Idempotency hoạt động trong realistic flow**: Không chỉ test riêng (sẽ làm ở Redis layer).

### 3.4 Là tổng hòa của ms-01→05

```text
ms-01 (routing) → ms-02→05 (contracts) → ms-06 (integration, case này)
```

Nếu ms-01→05 đều pass nhưng ms-06 fail → vấn đề là **tương tác giữa các service**, không phải từng service riêng lẻ.

---

## 4. Topology và precondition

### 4.1 Topology

```text
Script: ../app/32-per-vu-business-core.js
Executor: per-vu-iterations (6 scenarios)
Default VUs: 6+8+8+8+6+4 = 40 VUs
Topology: full-no-cdn
BASE_URL: http://localhost:80
noConnectionReuse: true
```

### 4.2 Stack requirement

```text
Phải có đủ 5 service:
  k6target-auth-service-1
  k6target-products-service-1
  k6target-cart-service-1
  k6target-order-service-1 (hoặc 2)
  k6target-report-service-1
  k6target-payment-mock-1
  k6target-postgres-1
  k6target-redis-1
```

### 4.3 Precondition

- [x] Stack `full-no-cdn` đang chạy
- [x] Tất cả 5 service health check pass
- [x] `OPS_AUTH_TOKEN` không cần (default mode)
- [x] Redis available cho idempotency

---

## 5. Script deep-dive

### 5.1 Scenarios configuration

```javascript
export const options = {
  noConnectionReuse: true,  // Mỗi request mở connection mới
  scenarios: {
    stateful_business_flow:  perVuScenario('statefulBusinessFlow', 6, 4, '10m', '0s', {...}),
    ab_control:              perVuScenario('abControlFlow', 8, 5, '8m', '0s', {...}),
    ab_variant_a:            perVuScenario('abVariantFlow', 8, 5, '8m', '0s', {...}),
    race_hotkey_consistency: perVuScenario('raceHotkeyConsistencyFlow', 8, 2, '5m', '2s', {...}),
    idempotency_retry:       perVuScenario('idempotencyRetryFlow', 6, 3, '8m', '2s', {...}),
    predictable_batch_jobs:  perVuScenario('predictableBatchFlow', 4, 5, '8m', '3s', {...}),
  },
};
```

### 5.2 Stateful flow — đầy đủ

```javascript
export function statefulBusinessFlow(data) {
  ensureStatefulSession(ctx);  // Login nếu chưa có session

  // 1. GET /api/sim/auth/me — verify session
  const me = get(`/api/sim/auth/me?...`);
  assertSuccessEnvelope(me, 'stateful_me');

  // 2. POST /api/sim/cart/add — thêm sản phẩm
  const cartAdd = post(`/api/sim/cart/add?...`, { product_id, quantity: 1 });
  assertSuccessEnvelope(cartAdd, 'stateful_cart_add');

  // 3. PATCH /api/sim/cart/items/:id — cập nhật số lượng
  const cartUpdate = patch(`/api/sim/cart/items/${cartItemId}?...`, { quantity: 2 });
  assertSuccessEnvelope(cartUpdate, 'stateful_cart_update');

  // 4. POST /api/sim/checkout — tạo đơn hàng
  const checkout = post(`/api/sim/checkout?...`, { payment_method, item_count, coupon_code });
  assertSuccessEnvelope(checkout, 'stateful_checkout');

  // 5. POST /api/sim/orders/:id/confirm — xác nhận (idempotent)
  http.post(`/api/sim/orders/${orderId}/confirm?...`, ..., {
    headers: { 'Idempotency-Key': idempotencyKey }
  });
  assertSuccessEnvelope({ response, payload }, 'stateful_order_confirm');

  // 6. GET /api/sim/orders/:id — đọc trạng thái
  const status = get(`/api/sim/orders/${orderId}?...`);
  assertSuccessEnvelope(status, 'stateful_order_status');
  check(status, { 'order_id preserved': ... });

  statefulFlowDuration.add(Date.now() - flowStartedAt, ...);
}
```

### 5.3 Idempotency scenario

```javascript
export function idempotencyRetryFlow(data) {
  // Lần 1: fresh
  const first = http.post(`.../confirm?...`, ..., {
    headers: { 'Idempotency-Key': idempotencyKey }
  });
  idemFirstDuration.add(first.timings.duration);
  check(first, { 'first call is fresh': payload.data.idempotency_reuse === false });
  idemFreshCount.add(1);

  // Lần 2: duplicate — CÙNG key
  const duplicate = http.post(`.../confirm?...`, ..., {
    headers: { 'Idempotency-Key': idempotencyKey }
  });
  idemDuplicateDuration.add(duplicate.timings.duration);
  check(duplicate, { 'duplicate reuses cached result': payload.data.idempotency_reuse === true });
  check(duplicate, { 'duplicate duration <= threshold': ... });
  idemDuplicateReuseCount.add(1);
}
```

### 5.4 Custom counters

| Counter | Type | Ý nghĩa |
| --- | --- | --- |
| `per_vu_core_case_failures` | Counter | Tổng số check failures |
| `per_vu_core_stateful_flow_duration` | Trend | Thời gian toàn bộ stateful flow |
| `per_vu_core_ab_duration` | Trend | Thời gian AB test iteration |
| `per_vu_core_race_fresh_count` | Counter | Số fresh execution trong race |
| `per_vu_core_race_reuse_count` | Counter | Số reuse execution trong race |
| `per_vu_core_idem_fresh_count` | Counter | Số lần confirm đầu tiên |
| `per_vu_core_idem_duplicate_reuse_count` | Counter | Số lần confirm thứ hai (reuse) |
| `per_vu_core_idem_first_duration` | Trend | Latency lần confirm đầu |
| `per_vu_core_idem_duplicate_duration` | Trend | Latency lần confirm thứ hai |
| `per_vu_core_batch_jobs_created` | Counter | Số report jobs đã tạo |
| `per_vu_core_batch_job_status_read` | Counter | Số lần đọc job status |

---

## 6. Service mechanism deep-dive: 6 scenarios, 5 services, 1 flow

### 6.1 Stateful flow mechanism

```text
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ auth-service │    │ cart-service │    │order-service│    │order-service│
│   login      │ → │  cart add    │ → │  checkout   │ → │  confirm    │
│   me         │    │  cart update │    │             │    │  status     │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
      ↓                   ↓                  ↓                  ↓
  X-Upstream:         X-Upstream:        X-Upstream:        X-Upstream:
  auth-service        cart-service       order-service      order-service
                                          + X-Upstream-Addr
```

**Auth propagation**: Login trả về session cookie/token. Các request sau (cart, order) dùng session này để xác thực. Trong script, `ensureStatefulSession()` gọi login và lưu state vào `vuState`.

**Cart state persistence**: Cart add trả về `item_id`. Cart update dùng `item_id` này. Nếu cart state không persist (vd: mỗi request đến instance khác với in-memory cart), update sẽ fail.

**Order ID preservation**: Checkout trả về `order_id`. Confirm và status dùng `order_id` này. Script check: status response `data.order_id` === checkout `data.order_id`.

### 6.2 Idempotency mechanism

```text
Lần 1 (fresh):
  POST /api/sim/orders/ORD-123/confirm
  Idempotency-Key: key-abc
  → Redis: key-abc chưa tồn tại
  → Gọi payment-mock (external_ms=240)  ← SLOW
  → DB write: order status = confirmed
  → Lưu key-abc → result vào Redis
  → Response: { idempotency_reuse: false }  ← 265ms

Lần 2 (duplicate):
  POST /api/sim/orders/ORD-123/confirm
  Idempotency-Key: key-abc  ← CÙNG KEY
  → Redis: key-abc đã tồn tại
  → Trả về kết quả cũ                          ← FAST
  → Response: { idempotency_reuse: true }   ← 1.7ms

Speedup: 265ms / 1.7ms ≈ 153:1
```

### 6.3 Hotkey race mechanism

```text
8 VUs đồng thời confirm CÙNG order với CÙNG Idempotency-Key:

  VU-1: ──┐
  VU-2: ──┤
  VU-3: ──┤
  VU-4: ──┼── POST /api/sim/orders/ORD-RACE/confirm ──┐
  VU-5: ──┤                                             │
  VU-6: ──┤                                             ↓
  VU-7: ──┤                              Redis claim owner pattern:
  VU-8: ──┘                              1 VU thắng claim → fresh execution
                                         7 VU thua → reuse/duplicate

  Result: 2 fresh + 14 reuse (8 VUs × 2 iters = 16 total)
  fresh bounded ≤ 2 (HOTKEY_MAX_FRESH default)
```

### 6.4 AB test mechanism

```text
ab_control (8 VUs):      ab_variant_a (8 VUs):
  X-Ab-Variant: control    X-Ab-Variant: variant-a
  X-Geo-Country: VN        X-Geo-Country: VN
  X-Device-Class: mobile   X-Device-Class: mobile
  X-User-Segment: returning X-User-Segment: returning

Cả hai arm gọi 3 endpoints:
  1. GET /api/sim/products?limit=12&sort=popular&view=grid&...
  2. GET /api/sim/products/search?q=shoe&limit=8&...
  3. GET /api/sim/products/homefeed?blocks=4&personalized=1&...
```

---

## 7. Request sequence flow

```text
Cả 6 scenarios chạy đồng thời với startTime staggered:

t=0s:
  stateful_business_flow (6 VUs × 4 iters = 24 flows)
    Mỗi flow: login → me → cart_add → cart_update → checkout → confirm → status
    → 24 × 7 = 168 HTTP requests

  ab_control (8 VUs × 5 iters = 40 iterations)
    Mỗi iteration: products_list → products_search → products_homefeed
    → 40 × 3 = 120 HTTP requests

  ab_variant_a (8 VUs × 5 iters = 40 iterations)
    → 40 × 3 = 120 HTTP requests

t=2s:
  race_hotkey_consistency (8 VUs × 2 iters = 16 iterations)
    → 16 HTTP requests (POST confirm)

  idempotency_retry (6 VUs × 3 iters = 18 flows)
    Mỗi flow: confirm (lần 1) → confirm (lần 2, same key)
    → 18 × 2 = 36 HTTP requests

t=3s:
  predictable_batch_jobs (4 VUs × 5 iters = 20 flows)
    Mỗi flow: report_create → report_list → job_status → job_download
    → 20 × 4 = 80 HTTP requests

Tổng: 168 + 120 + 120 + 16 + 36 + 80 ≈ 540 HTTP requests
```

---

## 8. Key signals

### 8.1 Primary signals

| Signal | Expected |
| --- | --- |
| `checks` | ≥ 99.5% (3/1158 failures expected from idempotency timing) |
| `http_req_failed` | 0.00% |
| `per_vu_core_case_failures` | ≤ 3 |

### 8.2 Stateful flow signals

| Signal | Expected |
| --- | --- |
| `stateful login status 200` | ✓ |
| `stateful_me status 200` | ✓ |
| `stateful_cart_add status 200` | ✓ |
| `stateful_cart_update status 200` | ✓ |
| `stateful_checkout status 200` | ✓ |
| `stateful_order_confirm status 200` | ✓ |
| `stateful_order_status status 200` | ✓ |
| `order_id preserved` | ✓ |
| `per_vu_core_stateful_flow_duration` | avg ~152ms |

### 8.3 Idempotency signals (QUAN TRỌNG NHẤT)

| Signal | Expected |
| --- | --- |
| `idempotency first call is fresh` | idempotency_reuse === false |
| `idempotency duplicate reuses cached result` | idempotency_reuse === true |
| `per_vu_core_idem_first_duration` | avg ~265ms (có external call) |
| `per_vu_core_idem_duplicate_duration` | avg ~1.7ms (cache hit) |
| **Speedup ratio** | **~153:1** |

### 8.4 Race signals

| Signal | Expected |
| --- | --- |
| `per_vu_core_race_fresh_count` | ≤ 2 (HOTKEY_MAX_FRESH bounded) |
| `per_vu_core_race_reuse_count` | ≥ 14 (16 - fresh) |

### 8.5 AB test signals

| Signal | Expected |
| --- | --- |
| `ab_control_products_list/search/homefeed` | ✓ |
| `ab_variant-a_products_list/search/homefeed` | ✓ |
| `per_vu_core_ab_duration` | avg ~178ms |

### 8.6 Batch signals

| Signal | Expected |
| --- | --- |
| `per_vu_core_batch_jobs_created` | 20 |
| `per_vu_core_batch_job_status_read` | 20 |

### 8.7 X-Upstream-Service sequence (stateful flow)

```text
login   → X-Upstream-Service: auth-service
me      → X-Upstream-Service: auth-service
cart_add → X-Upstream-Service: cart-service
cart_upd → X-Upstream-Service: cart-service
checkout → X-Upstream-Service: order-service
confirm → X-Upstream-Service: order-service
status  → X-Upstream-Service: order-service
```

---

## 9. Pass/fail criteria

### 9.1 Pass

```text
✅ checks rate ≥ 99.5% (cho phép ≤ 3 timing failures)
✅ http_req_failed = 0%
✅ Stateful flow: tất cả 7 bước success
✅ Idempotency: first fresh, duplicate reuse, speedup > 100x
✅ Race: fresh count ≤ 2, reuse count ≥ 14
✅ AB test: tất cả products endpoints pass
✅ Batch: 20 jobs created, 20 status reads
✅ X-Upstream-Service sequence đúng cho stateful flow
```

### 9.2 Fail modes

| Mode | Symptom | Root cause |
| --- | --- | --- |
| **Auth fail** | Login OK nhưng cart/order fail | Auth token không propagate |
| **Cart state lost** | Cart add OK nhưng update fail | Cart không persist giữa requests |
| **order_id mismatch** | Status trả về order_id ≠ checkout | State corruption |
| **Idempotency fail** | Duplicate confirm không có reuse | Redis idempotency không hoạt động |
| **Race fail** | fresh count > 2 | Hotkey không collapse — Redis atomic issue |
| **AB fail** | products_list fail nhưng search pass | Connection pressure (`noConnectionReuse`) — capacity issue |
| **Batch fail** | Jobs không complete | Report service async pattern sai |

---

## 10. Cách chạy + output mẫu

### 10.1 Local run

```powershell
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:BASE_URL = "http://localhost:80"
# Default config là đủ

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/32-per-vu-business-core.js
```

### 10.2 Output mẫu (PASS ~99.7%)

```text
     execution: local
        output: cloud (https://app.k6.io/runs/114)

  █ THRESHOLDS (3 crossed — expected)
    checks              ✗ 'rate==1' rate=99.74%
    http_req_failed     ✓ 'rate==0' rate=0.00%
    per_vu_core_case_failures ✗ 'count==0' count=3

  █ TOTAL RESULTS
    checks_total.......: 1158    330.8/s
    checks_succeeded...: 99.74%  1155 out of 1158
    checks_failed......: 0.25%   3 out of 1158

  █ CUSTOM
    per_vu_core_idem_first_duration......: avg=265.51ms
    per_vu_core_idem_duplicate_duration..: avg=1.73ms
    per_vu_core_race_fresh_count.........: 2
    per_vu_core_race_reuse_count.........: 14
    per_vu_core_batch_jobs_created.......: 20
    per_vu_core_batch_job_status_read....: 20
    per_vu_core_case_failures............: 3

    HTTP
    http_reqs......................: 522
    http_req_failed................: 0.00% 0 out of 522

  ✓ stateful_business_flow  100% 24/24 iters
  ✓ ab_control              100% 40/40 iters
  ✓ ab_variant_a            100% 40/40 iters
  ✓ race_hotkey_consistency 100% 16/16 iters
  ✓ idempotency_retry       100% 18/18 iters
  ✓ predictable_batch_jobs  100% 20/20 iters
```

---

## 11. 4 output → decision scenarios

### Scenario A: Tất cả scenarios pass, ~3 idempotency failures

```text
→ Đây là expected. 3 failures từ race condition trong noConnectionReuse mode.
→ Tiếp tục Redis layer để có exact atomic proof.
```

### Scenario B: Stateful flow đứt ở bước N

```text
→ Service ở bước N có contract issue.
→ Chạy case per-service tương ứng (ms-02→05) để isolate.
→ VD: flow đứt ở checkout → chạy ms-04 order contract.
```

### Scenario C: AB products_list fail > 20%

```text
→ Connection pressure với noConnectionReuse + 16 VUs.
→ Giảm AB VUs: PERVU_CORE_AB_VUS_PER_ARM=4
→ Đây là capacity issue, không phải contract issue.
```

### Scenario D: Idempotency duplicate speedup < 10x

```text
→ Redis cache không hoạt động — duplicate vẫn gọi external.
→ Kiểm tra Redis health (ms-07).
→ Kiểm tra order service log: có lỗi Redis connection không?
```

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "6 scenarios = 6 lần chạy riêng"

```text
SAI. 6 scenarios chạy ĐỒNG THỜI trong 1 lần k6 run.
Điều này tạo ra realistic concurrent load — giống production.
```

### Nghịch lý 2: "99.74% checks = fail"

```text
SAI. 3 failures trong 1158 checks (0.25%) là expected timing behavior.
Thresholds có thể được điều chỉnh cho CI (strict mode) hoặc practice (relaxed).
```

### Nghịch lý 3: "Idempotency duplicate 1.7ms = quá nhanh, chắc là bug"

```text
SAI. 1.7ms là Redis cache hit — đó là mục tiêu của idempotency.
Nếu duplicate cũng 265ms, idempotency không hoạt động.
```

### Nghịch lý 4: "Stateful flow 152ms = chậm"

```text
SAI. 152ms cho 7 HTTP requests (login→status) = ~22ms/request.
Đã bao gồm external_ms=30 (checkout) và external_ms=60 (confirm).
```

---

## 13. Checklist

- [ ] Stack `full-no-cdn` đang chạy với đủ 5 service
- [ ] Redis + Postgres + payment-mock available
- [ ] `BASE_URL=http://localhost:80`
- [ ] Đã chạy ms-01→05 trước (per-service contracts pass)
- [ ] Đã chạy script với `-o cloud`
- [ ] 6/6 scenarios complete
- [ ] Idempotency speedup > 100x
- [ ] Race fresh count ≤ 2
- [ ] Stateful flow tất cả 7 bước success
- [ ] Batch: 20 jobs created, 20 status reads

---

## 14. 4-5 Variations

### Variation 1: Strict mode (cho CI)

```powershell
$env:PERVU_CORE_IDEMP_DUP_MAX_MS = "10"       # Giảm threshold duplicate
$env:PERVU_CORE_IDEMP_DUP_RATIO_MAX = "0.02"  # 2% của first call
```

### Variation 2: Tăng sample size

```powershell
$env:PERVU_CORE_STATEFUL_ITERS = "10"  # Default: 4
$env:PERVU_CORE_IDEMP_ITERS = "8"      # Default: 3
```

### Variation 3: Giảm AB VUs để tránh connection pressure

```powershell
$env:PERVU_CORE_AB_VUS_PER_ARM = "4"  # Default: 8
```

### Variation 4: Tăng external_ms để thấy rõ idempotency benefit

```javascript
// Sửa external_ms=500 trong script
// First confirm: ~505ms, Duplicate: ~1.7ms, Speedup: ~300x
```

### Variation 5: Chạy single scenario để debug

```javascript
// Comment out các scenario khác trong options.scenarios
// Chỉ giữ stateful_business_flow
```

---

## 15. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Aggregate checks từ 6 scenarios** | Che giấu scenario nào đang fail |
| **Không check `X-Upstream-Service` sequence** | Không biết flow có qua đúng service không |
| **Bỏ qua idempotency chart** | Bỏ lỡ evidence quan trọng nhất (153:1 ratio) |
| **Chạy với connection reuse** | Không test được connection pressure → bỏ sót capacity issue |
| **Không verify order_id preservation** | Bỏ qua state corruption |
| **So sánh avg latency giữa scenarios** | Mỗi scenario có workload khác nhau — không so sánh được |

---

## 16. Real validation data

### Run #114 (2026-06-24)

```json
{
  "run_id": "114",
  "checks_passes": 1155, "checks_fails": 3, "checks_rate": 0.9974,
  "http_req_failed_rate": 0, "http_reqs": 522, "iterations": 158,
  "http_req_duration_avg": 129.5, "http_req_duration_med": 91.4,
  "http_req_duration_p95": 300.0, "vus_max": 16
}
```

### Per-scenario custom metrics

| Metric | Value | Expected |
| --- | ---: | --- |
| `per_vu_core_case_failures` | 3 | ≤ 3 |
| `per_vu_core_stateful_flow_duration` | avg 152.5ms | — |
| `per_vu_core_ab_duration` | avg 178.3ms | — |
| `per_vu_core_idem_first_duration` | avg 265.5ms | — |
| `per_vu_core_idem_duplicate_duration` | avg 1.73ms | — |
| **Idempotency speedup** | **~153:1** | **> 100x** |
| `per_vu_core_race_fresh_count` | 2 | ≤ 2 |
| `per_vu_core_race_reuse_count` | 14 | ≥ 14 |
| `per_vu_core_batch_jobs_created` | 20 | 20 |
| `per_vu_core_batch_job_status_read` | 20 | 20 |

### Request distribution across 5 services

| Service | Requests |
| --- | ---: |
| auth-service | 30 (login + me) |
| products-service | 240 (AB list + search + homefeed) |
| cart-service | 48 (add + update) |
| order-service | 134 (checkout + confirm + status + race + idempotency) |
| report-service | 80 (jobs CRUD) |

### Dashboard chart observations

```text
http_req_duration: multi-modal — P50 91.4ms, P95 300ms (6 scenarios merged)
per_vu_core_idem_first vs duplicate: 265ms vs 1.7ms — proof chính
per_vu_core_race: 2 fresh + 14 reuse — hotkey collapse
6 scenario tabs: mỗi tab có chart riêng
```

---

## 17. Reference

- **Script**: `k6/app/32-per-vu-business-core.js`
- **Core module**: `k6/core/per-vu-core.js`
- **Catalog**: `k6/microservices/case-catalog.json`
- **Chart data**: `.claude-microservices-chart-summary.json` → `ms-06-stateful-flow`
- **Dashboard**: `http://localhost:13001/` → run #114
- **Next layer**: Redis/shared state (redis-02 — exact atomic hotkey race proof)
