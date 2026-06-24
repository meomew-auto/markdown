# ms-06 -- Cross-service stateful business flow

> **Case ID:** `ms-06-stateful-business-flow`\
> **Script:** `../app/32-per-vu-business-core.js`\
> **Layer:** App Gateway & Microservices\
> **Executor:** `per-vu-iterations` (6 scenarios)\
> **Topology:** `full-no-cdn`\
> **Proof:** Integration test của toàn bộ microservices layer -- flow login đến order status xuyên suốt 5 service, mỗi bước phụ thuộc state từ bước trước

---

## Mục lục

1. [Tình huống thực tế](#1-tinh-huống-thực-tế)
2. [Microservices capability được chứng minh](#2-microservices-capability-được-chứng-minh)
3. [Vì sao phải test stateful flow](#3-vì-sao-phải-test-stateful-flow)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Cross-service mechanism deep-dive](#6-cross-service-mechanism-deep-dive)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / counters](#8-key-signals--counters)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output -> decision scenarios](#11-4-output---decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist trước khi chạy](#13-checklist-trước-khi-chạy)
14. [5+ Variations với code mẫu](#14-5-variations-với-code-mẫu)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh nghiệp vụ

Một user journey hoàn chỉnh: login -> check session -> browse products -> add to cart -> update cart -> checkout -> confirm order -> check order status. Mỗi bước phụ thuộc vào state từ bước trước. Flow này span qua tất cả 5 microservices.

```text
auth-service -> cart-service -> products-service -> order-service -> order-service -> order-service
   (login)       (cart add)     (browse)         (checkout)     (confirm)      (status)
```

Nếu bất kỳ service nào sai contract, toàn bộ flow đứt.

### 1.2 Một ngày thứ Sáu điển hình -- deploy phiên bản mới

Hãy hình dung tình huống sau, xảy ra vào 16:30 thứ Sáu tuần trước:

```text
16:30  Đội backend deploy phiên bản mới của cart-service.
       Thay đổi: cấu trúc response của PATCH /api/sim/cart/items/:item_id
       thay đổi từ { success: true, data: { updated: true } }
       thành { success: true, data: { item: { ... } } }.
       Unit test cart-service: PASS. Integration test cart-service: PASS.

16:35  Deploy hoàn tất. Health check cart-service: 200 OK.
       Đội vận hành xác nhận "cart service khỏe mạnh".

16:42  Khách hàng đầu tiên thử checkout.
       Flow: login (auth) -> OK
             add to cart (cart) -> OK
             update cart (cart) -> response thay đổi, code parse sai
             -> PATCH trả lỗi 500 ở tầng app vì parse response mới sai
             -> checkout KHÔNG ĐƯỢC GỌI
       Khách hàng thấy "Đã xảy ra lỗi, vui lòng thử lại".

16:43  Thêm 12 khách hàng gặp lỗi tương tự.
       Cart-service health check: VẪN 200 OK.
       Unit test cart-service: VẪN PASS.

16:50  Cảnh báo: tỉ lệ checkout giảm 40% so với cùng giờ hôm qua.
       Đội ngũ vận hành bắt đầu điều tra.

17:05  Phát hiện: PATCH response contract thay đổi, app không parse được
       item_id từ response mới -> checkout không có cart -> flow đứt.

17:15  Rollback cart-service về phiên bản cũ.
       Flow hoạt động trở lại.

TỔNG THIỆT HẠI: 33 phút checkout bị gián đoạn.
                  ~220 khách hàng bị ảnh hưởng.
                  Không một unit test nào fail.
                  Không một health check nào báo lỗi.
```

### 1.3 Vì sao unit test và health check không phát hiện được

| Lớp kiểm tra | Kết quả khi sự cố xảy ra | Vì sao không phát hiện được |
|---|---|---|
| Unit test cart-service | PASS | Unit test kiểm tra PATCH trả về 200 và success=true -- cả hai đều đúng. Chỉ cấu trúc `data` thay đổi |
| Integration test cart-service | PASS | Integration test gọi PATCH độc lập, không có flow checkout sau đó |
| Health check cart-service | 200 OK | Service vẫn chạy, database vẫn kết nối, Redis vẫn hoạt động |
| Monitoring dashboard | Không alert | HTTP 200, latency bình thường, error rate thấp (chỉ fail ở tầng app, không phải tầng HTTP) |
| **Stateful flow test (case này)** | **FAIL** | `stateful_cart_update` check pass nhưng `stateful_checkout` fail vì không parse được `item_id` từ response mới |

Đây chính là lý do case ms-06 tồn tại: **chỉ có test flow xuyên suốt mới phát hiện được contract thay đổi ở một service làm đứt flow toàn bộ**.

### 1.4 User journey đầy đủ -- 7 bước

Mỗi VU, mỗi iteration thực hiện toàn bộ hành trình người dùng:

| Bước | Hành động | Endpoint | Service xử lý | State tạo ra | State tiêu thụ |
|---|---|---|---|---|---|
| 1 | Đăng nhập | `POST /api/sim/auth/login` | auth-service | Auth session | -- |
| 2 | Xác minh phiên | `GET /api/sim/auth/me` | auth-service | -- | Auth session |
| 3 | Thêm vào giỏ | `POST /api/sim/cart/add` | cart-service | Cart item ID | Auth session |
| 4 | Cập nhật giỏ | `PATCH /api/sim/cart/items/:id` | cart-service | -- | Cart item ID |
| 5 | Thanh toán | `POST /api/sim/checkout` | order-service | Order ID | Cart state |
| 6 | Xác nhận đơn | `POST /api/sim/orders/:id/confirm` | order-service | -- | Order ID |
| 7 | Kiểm tra đơn | `GET /api/sim/orders/:id` | order-service | -- | Order ID |

Mỗi bước từ 2 đến 7 đều phụ thuộc vào state được tạo ra từ ít nhất một bước trước đó. Nếu bất kỳ bước nào thất bại, toàn bộ flow từ bước đó trở đi không thể tiếp tục.

### 1.5 Ma trận phụ thuộc state

```text
                    ┌─────────┐
                    │  Login  │
                    └────┬────┘
                         │ auth session
                         ▼
                    ┌─────────┐
                    │   Me    │
                    └────┬────┘
                         │ auth session (verified)
                         ▼
                    ┌─────────┐
                    │Cart Add │
                    └────┬────┘
                         │ cart item ID
                         ▼
                    ┌─────────┐
                    │Cart Upd │
                    └────┬────┘
                         │ cart state (confirmed)
                         ▼
                    ┌─────────┐
                    │Checkout │
                    └────┬────┘
                         │ order ID
                         ▼
                    ┌─────────┐
                    │Confirm  │
                    └────┬────┘
                         │ order ID (confirmed)
                         ▼
                    ┌─────────┐
                    │ Status  │
                    └─────────┘
```

### 1.6 Các ứng dụng thực tế của stateful flow test

| Mục đích | Mô tả | Tần suất chạy |
|---|---|---|
| Smoke test sau deploy | Chạy ngay sau mỗi lần deploy bất kỳ service nào. Nếu fail, rollback ngay | Mỗi lần deploy |
| Health check nâng cao | Không chỉ kiểm tra service "còn sống", mà kiểm tra "còn hoạt động đúng" | Mỗi 5 phút trong production |
| Regression test | Phát hiện thay đổi contract không tương thích ngược giữa các phiên bản service | Mỗi PR, mỗi nightly build |
| Onboarding test | Người mới vào team chạy case này để hiểu toàn bộ flow hệ thống | Một lần khi onboarding |
| Capacity planning baseline | Đo toàn bộ flow duration để làm baseline cho capacity planning | Mỗi sprint |

---

## 2. Microservices capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh 6 capabilities trong 1 case duy nhất:

> **Microservices layer duy trì state xuyên suốt flow người dùng: auth session được propagate, cart state được persist, order ID được preserve, và tất cả các scenario con (AB test, race condition, idempotency, async batch) đều hoạt động đúng.**

### 2.2 Bảng 6 capabilities

| # | Capability | Scenario | Câu hỏi được trả lời |
|---|---|---|---|
| C1 | **Stateful flow xuyên service** | `stateful_business_flow` | Auth session có được dùng cho cart và order không? Cart state có persist qua update không? Order ID có preserve qua confirm và status không? |
| C2 | **AB test routing** | `ab_control` + `ab_variant_a` | Nginx có route đúng variant dựa trên header `X-Ab-Variant` không? Response giữa control và variant có nhất quán không? |
| C3 | **Race condition consistency** | `race_hotkey_consistency` | Khi nhiều VU confirm cùng một order (hotkey race), idempotency key có được preserve không? Kết quả có nhất quán giữa các VU không? |
| C4 | **Idempotency guarantee** | `idempotency_retry` | Gọi confirm 2 lần với cùng `Idempotency-Key`: lần 1 tạo mới, lần 2 trả về cached result. Response có nhanh hơn lần 2 không? |
| C5 | **Async job lifecycle** | `predictable_batch_jobs` | Report service có tạo job (202), cho phép list, poll status, và download không? Job ID có được trả về và dùng được cho các bước sau không? |
| C6 | **Gateway routing correctness** | Tất cả 6 scenarios | Header `X-Upstream-Service` có thay đổi đúng theo từng bước không? Có request nào rơi vào fallback `app` không? |

### 2.3 Auth -- tạo session dùng được cho các request sau

Auth tạo session dùng được cho các request sau. Trong `stateful_business_flow`, hàm `ensureStatefulSession()` gọi `POST /api/sim/auth/login` và xác nhận `success=true`. Session được duy trì trong cookie jar của VU (k6 tự động xử lý cookie). Tất cả request sau đó (me, cart, checkout, confirm, status) đều dùng session này mà không cần gửi lại token.

**Cách kiểm chứng**: Request 2 (`GET /api/sim/auth/me`) trả về thông tin user -- nếu session không được propagate, request này sẽ trả về lỗi authentication.

### 2.4 Cart -- state persist từ add đến update

Cart state persist từ add đến update. `POST /api/sim/cart/add` tạo cart item với `product_id` và `quantity`. `PATCH /api/sim/cart/items/{item_id}` cập nhật quantity của chính item đó. `item_id` được lưu trong `vuState.cartItemId` -- một biến JavaScript thuần túy trong VU context, chứng minh rằng cart service thực sự persist state giữa hai request.

**Cách kiểm chứng**: PATCH request dùng `item_id` từ response của POST request trước đó. Nếu cart service không persist state, PATCH sẽ trả về lỗi "item not found".

### 2.5 Order -- order_id dùng được cho confirm và status

Checkout tạo order_id dùng được cho confirm và status. `POST /api/sim/checkout` trả về `data.order_id`. `POST /api/sim/orders/{order_id}/confirm` dùng chính `order_id` đó. `GET /api/sim/orders/{order_id}` kiểm tra order state và xác nhận `order_id` khớp.

**Cách kiểm chứng**: Assert cuối cùng của flow: `stateful order status preserves order_id` -- so sánh `order_id` từ status response với `checkoutOrderId` đã lưu.

### 2.6 Header `X-Upstream-Service` -- routing proof

`X-Upstream-Service` header thay đổi đúng theo từng bước:

```text
auth-service -> auth-service -> cart-service -> cart-service -> order-service -> order-service -> order-service
   (login)       (me)         (cart add)    (cart update)   (checkout)     (confirm)      (status)
```

Mỗi response từ Nginx đều có header `X-Upstream-Service` cho biết service nào đã xử lý request. Đây là evidence chính cho routing correctness. Nếu bất kỳ response nào có `X-Upstream-Service: app` (fallback), routing đã sai.

### 2.7 6 scenarios -- tất cả pass

6 scenarios (stateful flow, AB control, AB variant, race hotkey, idempotency retry, batch jobs) tất cả pass. Mỗi scenario test một khía cạnh khác nhau của microservices layer. Pass một scenario không đảm bảo pass tất cả -- mỗi scenario có thresholds và counters riêng.

Đây là integration test của toàn bộ microservices layer.

---

## 3. Vì sao phải test stateful flow

### 3.1 Unit test từng service pass khong bằng flow pass

Đây là bài học quan trọng nhất của case này. Hãy xem xét một tình huống cụ thể:

```text
Unit test auth-service:   PASS (login trả token, me trả user)
Unit test cart-service:   PASS (add trả item, update trả success)
Unit test order-service:  PASS (checkout trả order_id, confirm trả success)

Nhưng flow thực tế:      FAIL
```

Làm sao có thể? Vì:

| Vấn đề | Unit test không phát hiện | Flow test phát hiện |
|---|---|---|
| Auth token không được propagate đúng | Mỗi service test với mock token | Request thứ 3 (cart add) dùng session từ request 1 -- nếu session không propagate, flow đứt |
| Cart state không share giữa các request | Cart service test với mock cart | PATCH dùng `item_id` từ POST response -- nếu state không persist, PATCH fail |
| Order ID mapping sai giữa checkout và confirm | Order service test với mock order_id | Status request dùng `order_id` từ checkout response -- nếu mapping sai, status trả sai order |
| Response contract thay đổi | Unit test parse response theo contract cũ | Flow test gọi nhiều service -- nếu một service thay đổi contract, parse ở bước sau fail |
| Session timeout giữa các bước | Mỗi unit test chạy trong < 1 giây | Flow test kéo dài hàng trăm ms đến vài giây -- session có thể timeout |

### 3.2 So sánh unit test, integration test, và stateful flow test

| Tiêu chí | Unit test | Integration test (từng service) | Stateful flow test (case này) |
|---|---|---|---|
| Phạm vi | 1 hàm / 1 class | 1 service + database mock | 5 services + Nginx + thật |
| Thời gian chạy | < 10ms | < 500ms | 5-10 giây |
| Phát hiện lỗi contract | Không | Có, trong phạm vi 1 service | Có, xuyên suốt 5 services |
| Phát hiện lỗi state propagation | Không | Không | **Có** |
| Phát hiện lỗi routing | Không | Không | **Có** |
| Phát hiện lỗi session | Không | Không (dùng mock) | **Có** (session thật) |
| Phát hiện lỗi AB test routing | Không | Không | **Có** |
| Phát hiện lỗi race condition | Không | Không | **Có** |
| Phát hiện lỗi idempotency | Không | Có (nếu test riêng) | **Có** |
| Độ tin cậy cho deploy decision | Thấp | Trung bình | **Cao nhất** |

### 3.3 Mô hình "contract cascade failure"

```text
┌─────────────────────────────────────────────────────────────────┐
│                   CONTRACT CASCADE FAILURE                        │
│                                                                  │
│  Service A thay đổi response contract                            │
│      │                                                           │
│      ▼                                                           │
│  Service A vẫn trả 200 OK + success=true                         │
│  (Health check A: PASS, Unit test A: PASS)                       │
│      │                                                           │
│      ▼                                                           │
│  Service B (consumer của A) parse response A                     │
│  Cấu trúc data thay đổi -> parse fail                            │
│  (Health check B: PASS, Unit test B: PASS với mock A)            │
│      │                                                           │
│      ▼                                                           │
│  Service C (consumer của B) không nhận được input từ B           │
│  (Health check C: PASS, Unit test C: PASS)                       │
│      │                                                           │
│      ▼                                                           │
│  TOÀN BỘ FLOW ĐỨT -- nhưng mọi health check đều 200 OK           │
│  CHỈ CÓ STATEFUL FLOW TEST PHÁT HIỆN                             │
└─────────────────────────────────────────────────────────────────┘
```

### 3.4 Case này là smoke test đầu tiên sau mỗi deploy

Trong thực tế, đây là smoke test đầu tiên sau mỗi deploy -- nếu nó fail, rollback ngay. Thứ tự chạy sau deploy:

```text
1. Health check từng service (ms-07)              -- 10 giây
2. Stateful flow test (ms-06 -- case này)          -- 30 giây
3. Per-service contract test (ms-02 đến ms-05)    -- 2 phút
4. Gateway routing test (ms-01)                   -- 30 giây
5. Redis shared state test (15-*.js)              -- 5 phút
6. Full load test                                 -- 15 phút

Nếu bước 2 fail: ROLLBACK NGAY, không cần chạy bước 3-6.
Nếu bước 2 pass: tiếp tục bước 3-6.
```

---

## 4. Topology và precondition

### 4.1 Topology

Tất cả microservices cases dùng `TargetLayer=full-no-cdn`:

```text
BASE_URL=http://localhost:80
```

Không dùng `full` (có CDN) vì Varnish cache có thể làm nhiễu response header và latency. Không dùng `lb-app` vì cần đủ 5 microservice upstream.

### 4.2 Sơ đồ topology chi tiết

```text
                          ┌─────────────────────────┐
                          │    k6 test script        │
                          │  (32-per-vu-business-    │
                          │   core.js)               │
                          └──────┬───────────────────┘
                                 │
                                 │  public path (tất cả request)
                                 │  http://localhost:80
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx API Gateway)                            │
│  ┌──────────────────────────────────────────────────────────┐│
│  │  URL routing rules:                                      ││
│  │  /api/sim/auth/*      -> auth-service:8081               ││
│  │  /api/sim/products*   -> products-service:8084           ││
│  │  /api/sim/cart/*      -> cart-service:8082               ││
│  │  /api/sim/checkout    -> order-service:8083              ││
│  │  /api/sim/orders/*    -> order-service:8083              ││
│  │  /api/sim/report*     -> report-service:8085             ││
│  │  /*                   -> app:8080 (fallback)             ││
│  └──────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│  │  auth    │ │ products │ │  cart    │ │  order   │ │  report  │
│  │  :8081   │ │  :8084   │ │  :8082   │ │  :8083   │ │  :8085   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
│       │            │            │            │            │
│       └────────────┴────────────┴────────────┴────────────┘
│                            │
│                            ▼
│              ┌─────────────────────────┐
│              │  Postgres + external     │
│              │  mock services           │
│              └─────────────────────────┘
└──────────────────────────────────────────────────────────────┘
```

### 4.3 Stack khởi động

```powershell
# Khởi động full-no-cdn stack (không có CDN/Varnish)
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
```

Đợi tất cả service healthy (khoảng 30-60 giây). Kiểm tra:

```powershell
# Xác nhận Nginx đang chạy
docker ps --filter "name=nginx"

# Xác nhận public path hoạt động
curl -sI http://localhost:80/api/sim/auth/login

# Xác nhận tất cả 5 service upstream hoạt động
curl -sI http://localhost:80/api/sim/products
curl -sI http://localhost:80/api/sim/cart
curl -sI http://localhost:80/api/sim/checkout
curl -sI http://localhost:80/api/sim/report
```

### 4.4 Script và executor

```text
Script: ../app/32-per-vu-business-core.js
Executor: per-vu-iterations (6 scenarios)
Scenarios:
  stateful_business_flow:  6 VUs × 4 iters
  ab_control:              8 VUs × 5 iters
  ab_variant_a:            8 VUs × 5 iters
  race_hotkey_consistency: 8 VUs × 2 iters
  idempotency_retry:       6 VUs × 3 iters
  predictable_batch_jobs:  4 VUs × 5 iters
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

### 4.5 Env knobs

```powershell
$env:BASE_URL = "http://localhost:80"
# Default config đủ -- tất cả PERVU_CORE_* có default hợp lý
# Optional override:
$env:PERVU_CORE_STATEFUL_VUS = "6"
$env:PERVU_CORE_STATEFUL_ITERS = "4"
```

### 4.6 Bảng đầy đủ biến môi trường

| Biến | Mặc định | Ý nghĩa | Ảnh hưởng đến scenario |
|---|---|---|---|
| `BASE_URL` | `http://localhost:80` | Public entry point qua Nginx gateway | Tất cả scenarios |
| `OPS_AUTH_TOKEN` | `""` | Token xác thực cho ops header (nếu cần) | Tất cả scenarios |
| `PERVU_CORE_STATEFUL_VUS` | `6` | Số VU cho stateful flow scenario | `stateful_business_flow` |
| `PERVU_CORE_STATEFUL_ITERS` | `4` | Số iteration mỗi VU cho stateful flow | `stateful_business_flow` |
| `PERVU_CORE_AB_VUS_PER_ARM` | `8` | Số VU mỗi arm (control + variant) cho AB test | `ab_control`, `ab_variant_a` |
| `PERVU_CORE_AB_ITERS` | `5` | Số iteration mỗi VU cho AB test | `ab_control`, `ab_variant_a` |
| `PERVU_CORE_RACE_VUS` | `8` | Số VU cho race condition test | `race_hotkey_consistency` |
| `PERVU_CORE_RACE_ITERS` | `2` | Số iteration mỗi VU cho race test | `race_hotkey_consistency` |
| `PERVU_CORE_IDEMP_VUS` | `6` | Số VU cho idempotency test | `idempotency_retry` |
| `PERVU_CORE_IDEMP_ITERS` | `3` | Số iteration mỗi VU cho idempotency test | `idempotency_retry` |
| `PERVU_CORE_BATCH_VUS` | `4` | Số VU cho batch job test | `predictable_batch_jobs` |
| `PERVU_CORE_BATCH_ITERS` | `5` | Số iteration mỗi VU cho batch job test | `predictable_batch_jobs` |
| `PERVU_CORE_IDEMP_DUP_RATIO_MAX` | `0.5` | Tỉ lệ tối đa giữa thời gian duplicate và first call | `idempotency_retry` |
| `PERVU_CORE_IDEMP_DUP_MAX_MS` | `110` | Thời gian tối đa (ms) cho duplicate call | `idempotency_retry` |
| `PERVU_CORE_INTER_STEP_SLEEP_SECONDS` | `0.03` | Thời gian nghỉ giữa các bước (giây) | Tất cả scenarios |

### 4.7 Precondition tự động

Script `setup()` tự động thực thi precondition:

```javascript
export function setup() {
  return {
    seed: `${Date.now()}`,
  };
}
```

Setup tạo `seed` từ timestamp. Seed này được dùng để tạo user context (`buildUserContext`) cho mỗi VU, đảm bảo mỗi VU có một user riêng biệt và mỗi lần chạy có dữ liệu khác nhau.

**Lưu ý quan trọng**: Không cần precondition thủ công. Script không yêu cầu bất kỳ trạng thái nào trước khi chạy -- tất cả state (auth session, cart item, order) được tạo ra trong quá trình chạy.

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\app\32-per-vu-business-core.js
```

### 5.2 Import và dependency

Script import từ hai nguồn chính:

**Từ k6 built-in:**
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
```

**Từ shared modules của dự án:**
```javascript
import { envFloat, envInt, envString } from '../shared/common.js';
import {
  buildUserContext,
  headerValue,
  perVuScenario,
  recordFailure,
  safeJson,
  withOpsHeaders,
} from '../core/per-vu-core.js';
```

| Import | Nguồn | Vai trò trong case này |
|---|---|---|
| `http` | k6 | Gửi HTTP request đến Nginx gateway |
| `check` | k6 | Assertion framework -- mỗi check fail được ghi nhận |
| `sleep` | k6 | Tạm dừng giữa các bước để mô phỏng user think time |
| `Counter` | k6/metrics | Custom metric dạng đếm (chỉ tăng) |
| `Trend` | k6/metrics | Custom metric dạng thống kê (min/max/avg/p) |
| `buildUserContext` | per-vu-core.js | Tạo user context từ seed -- mỗi VU có user riêng |
| `perVuScenario` | per-vu-core.js | Tạo scenario config chuẩn cho per-vu-iterations executor |
| `recordFailure` | per-vu-core.js | Ghi nhận failure + tăng counter -- KHÔNG throw |
| `safeJson` | per-vu-core.js | Parse JSON response an toàn, trả về `{}` nếu lỗi |
| `withOpsHeaders` | per-vu-core.js | Thêm ops auth headers nếu `OPS_AUTH_TOKEN` được set |

### 5.3 Custom metrics -- danh sách đầy đủ

Đây là case nhiều counters nhất trong toàn bộ microservices layer:

```javascript
const caseFailures = new Counter('per_vu_core_case_failures');
const statefulFlowDuration = new Trend('per_vu_core_stateful_flow_duration', true);
const abDuration = new Trend('per_vu_core_ab_duration', true);
const raceFreshCount = new Counter('per_vu_core_race_fresh_count');
const raceReuseCount = new Counter('per_vu_core_race_reuse_count');
const idemFreshCount = new Counter('per_vu_core_idem_fresh_count');
const idemDuplicateReuseCount = new Counter('per_vu_core_idem_duplicate_reuse_count');
const idemFirstDuration = new Trend('per_vu_core_idem_first_duration', true);
const idemDuplicateDuration = new Trend('per_vu_core_idem_duplicate_duration', true);
const batchJobsCreated = new Counter('per_vu_core_batch_jobs_created');
const batchJobStatusRead = new Counter('per_vu_core_batch_job_status_read');
```

| Metric | Loại | Scenario liên quan | Ý nghĩa |
|---|---|---|---|
| `per_vu_core_case_failures` | Counter | Tất cả | Tổng số lần check thất bại. **Phải = 0** |
| `per_vu_core_stateful_flow_duration` | Trend | `stateful_business_flow` | Thời gian toàn bộ flow (ms): login -> status |
| `per_vu_core_ab_duration` | Trend | `ab_control`, `ab_variant_a` | Thời gian mỗi AB request (ms) |
| `per_vu_core_race_fresh_count` | Counter | `race_hotkey_consistency` | Số lần confirm là "fresh" (chưa ai confirm trước) |
| `per_vu_core_race_reuse_count` | Counter | `race_hotkey_consistency` | Số lần confirm là "reuse" (đã có VU khác confirm trước) |
| `per_vu_core_idem_fresh_count` | Counter | `idempotency_retry` | Số lần first call là fresh |
| `per_vu_core_idem_duplicate_reuse_count` | Counter | `idempotency_retry` | Số lần duplicate call reuse cached result |
| `per_vu_core_idem_first_duration` | Trend | `idempotency_retry` | Thời gian first call (ms) |
| `per_vu_core_idem_duplicate_duration` | Trend | `idempotency_retry` | Thời gian duplicate call (ms) -- phải nhanh hơn first |
| `per_vu_core_batch_jobs_created` | Counter | `predictable_batch_jobs` | Số lượng job được tạo |
| `per_vu_core_batch_job_status_read` | Counter | `predictable_batch_jobs` | Số lần đọc status của job |

### 5.4 Expected values cho thresholds

```javascript
const RACE_EXPECTED_FRESH = RACE_ITERS;                          // = 2
const RACE_EXPECTED_REUSE = RACE_ITERS * Math.max(RACE_VUS - 1, 0); // = 2 * 7 = 14
const IDEMP_EXPECTED_DUPLICATE_REUSE = IDEMP_VUS * IDEMP_ITERS;  // = 6 * 3 = 18
const IDEMP_EXPECTED_FRESH = IDEMP_VUS * IDEMP_ITERS;            // = 6 * 3 = 18
const BATCH_EXPECTED_CREATED = BATCH_VUS * BATCH_ITERS;          // = 4 * 5 = 20
const BATCH_EXPECTED_STATUS_READ = BATCH_VUS * BATCH_ITERS;      // = 4 * 5 = 20
```

**Giải thích expected values:**

| Expected value | Công thức | Giá trị mặc định | Logic |
|---|---|---|---|
| `RACE_EXPECTED_FRESH` | `RACE_ITERS` | 2 | Trong mỗi iteration, chỉ có 1 VU (đầu tiên) thấy "fresh". Nhưng vì các VU gọi song song và có thể VU đầu tiên chưa hoàn thành, nên mỗi iteration có thể có nhiều hơn 1 fresh. Tuy nhiên, expected value được set = `RACE_ITERS` vì script giả định mỗi iteration có đúng 1 fresh (VU đầu tiên) |
| `RACE_EXPECTED_REUSE` | `RACE_ITERS * (RACE_VUS - 1)` | 14 | 7 VU còn lại trong mỗi iteration thấy "reuse" |
| `IDEMP_EXPECTED_FRESH` | `IDEMP_VUS * IDEMP_ITERS` | 18 | Mỗi VU, mỗi iteration gọi first call -> fresh |
| `IDEMP_EXPECTED_DUPLICATE_REUSE` | `IDEMP_VUS * IDEMP_ITERS` | 18 | Mỗi VU, mỗi iteration gọi duplicate call -> reuse |
| `BATCH_EXPECTED_CREATED` | `BATCH_VUS * BATCH_ITERS` | 20 | Mỗi VU, mỗi iteration tạo 1 job |
| `BATCH_EXPECTED_STATUS_READ` | `BATCH_VUS * BATCH_ITERS` | 20 | Mỗi VU, mỗi iteration đọc status 1 lần |

### 5.5 Options block -- phân tích chi tiết

```javascript
export const options = {
  noConnectionReuse: true,
  scenarios: {
    stateful_business_flow: perVuScenario(
      'statefulBusinessFlow',
      STATEFUL_VUS,
      STATEFUL_ITERS,
      '10m',
      '0s',
      {
        case: 'stateful_business_flow',
        executor_family: 'per_vu_iterations',
        target_layer: 'app',
      },
    ),
    ab_control: perVuScenario('abControlFlow', AB_VUS_PER_ARM, AB_ITERS, '8m', '0s', {
      case: 'ab_compare',
      variant: 'control',
      executor_family: 'per_vu_iterations',
      target_layer: 'app',
    }),
    ab_variant_a: perVuScenario('abVariantFlow', AB_VUS_PER_ARM, AB_ITERS, '8m', '0s', {
      case: 'ab_compare',
      variant: 'variant-a',
      executor_family: 'per_vu_iterations',
      target_layer: 'app',
    }),
    race_hotkey_consistency: perVuScenario(
      'raceHotkeyConsistencyFlow',
      RACE_VUS,
      RACE_ITERS,
      '5m',
      '2s',
      {
        case: 'race_hotkey_consistency',
        executor_family: 'per_vu_iterations',
        target_layer: 'app',
      },
    ),
    idempotency_retry: perVuScenario('idempotencyRetryFlow', IDEMP_VUS, IDEMP_ITERS, '8m', '2s', {
      case: 'idempotency_retry',
      executor_family: 'per_vu_iterations',
      target_layer: 'app',
    }),
    predictable_batch_jobs: perVuScenario('predictableBatchFlow', BATCH_VUS, BATCH_ITERS, '8m', '3s', {
      case: 'predictable_batch',
      executor_family: 'per_vu_iterations',
      target_layer: 'app',
    }),
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    per_vu_core_case_failures: ['count==0'],
    per_vu_core_race_fresh_count: [`count==${RACE_EXPECTED_FRESH}`],
    per_vu_core_race_reuse_count: [`count==${RACE_EXPECTED_REUSE}`],
    per_vu_core_idem_duplicate_reuse_count: [`count==${IDEMP_EXPECTED_DUPLICATE_REUSE}`],
    per_vu_core_idem_fresh_count: [`count==${IDEMP_EXPECTED_FRESH}`],
    per_vu_core_batch_jobs_created: [`count==${BATCH_EXPECTED_CREATED}`],
    per_vu_core_batch_job_status_read: [`count==${BATCH_EXPECTED_STATUS_READ}`],
  },
  tags: {
    scenario_suite: 'per_vu_business_core',
  },
};
```

**Phân tích từng trường:**

| Trường | Giá trị | Ý nghĩa |
|---|---|---|
| `noConnectionReuse` | `true` | Mỗi request dùng một connection mới -- quan trọng để test routing độc lập |
| `scenarios` | 6 scenarios | Mỗi scenario chạy song song với executor và VU riêng |
| `thresholds.checks` | `['rate==1']` | **100% checks phải pass** |
| `thresholds.http_req_failed` | `['rate==0']` | **0% HTTP errors** |
| `thresholds.per_vu_core_case_failures` | `['count==0']` | **Không một failure nào được phép** |
| `gracefulStop` | `0s` (stateful) | Stateful flow không cần graceful stop -- không có sleep dài |
| `gracefulStop` | `2s` (race, idempotency) | Race và idempotency test có sleep dài hơn, cần graceful stop |
| `gracefulStop` | `3s` (batch) | Batch job test cần thời gian chờ job hoàn thành |
| `tags.scenario_suite` | `'per_vu_business_core'` | Tag để nhóm trên k6 dashboard |

##### Phân tích executor: vì sao dùng `per-vu-iterations` cho case này?

Config dùng `perVuScenario()` -> `per-vu-iterations` executor.

**Yêu cầu của case:**

```text
1. Stateful flow: 7 bước tuần tự (login -> me -> cart add -> cart update ->
   checkout -> confirm -> status) -> cần TUẦN TỰ trong mỗi VU

2. Mỗi VU có state riêng (auth session, cart item ID, order ID)
   -> state nằm trong VU context -> mỗi VU PHẢI chạy tuần tự

3. Race condition test: 8 VU cùng confirm 1 order
   -> cần nhiều VU chạy SONG SONG -> per-vu-iterations cho phép

4. Idempotency test: mỗi VU gọi confirm 2 lần với cùng key
   -> cần tuần tự trong mỗi VU (first -> duplicate)

5. Batch job test: create -> list -> status -> download
   -> cần tuần tự trong mỗi VU
```

**So sánh executor:**

| Executor | Phù hợp? | Vì sao |
|---|---|---|
| **per-vu-iterations** (đang dùng) | ✅ **ĐÚNG** | VU state isolation + tuần tự trong VU + song song giữa các VU |
| shared-iterations | ❌ SAI | Iteration được share giữa các VU -- VU A có thể nhận iteration đang dở của VU B -> mất state |
| constant-vus | ❌ SAI | Cần `duration`. Không biết trước thời gian |
| constant-arrival-rate | ❌ SAI | Ép rate. Case này cần sequence + VU isolation |
| ramping-vus | ❌ SAI | Không cần ramp. Số VU cố định |

**Key insight**: `per-vu-iterations` là executor duy nhất cung cấp VU state isolation
(vuState được duy trì riêng cho mỗi VU) trong khi vẫn cho phép nhiều VU chạy song song.
Stateful flow test yêu cầu cả hai: tuần tự trong VU (để state không bị mất) và song song
giữa các VU (để test race condition).

### 5.6 VU state management

```javascript
const vuState = {
  initialized: false,
  cartItemId: '',
};
```

Đây là **VU-level state** -- mỗi VU có một bản sao riêng của object này. Khi VU chạy iteration đầu tiên, `initialized = false` -> gọi `ensureStatefulSession()` để login. Các iteration sau, `initialized = true` -> bỏ qua login, dùng lại session.

**Vòng đời của vuState:**

```text
Iteration 1: initialized=false -> login -> initialized=true, cartItemId="sku-0"
Iteration 2: initialized=true  -> skip login, dùng cartItemId="sku-0"
Iteration 3: initialized=true  -> skip login, dùng cartItemId="sku-0"
Iteration 4: initialized=true  -> skip login, dùng cartItemId="sku-0"
```

### 5.7 Helper functions

**`jsonHeaders(extraHeaders)`** và **`getHeaders(extraHeaders)`**:

```javascript
function jsonHeaders(extraHeaders = {}) {
  return withOpsHeaders(
    {
      'Content-Type': 'application/json',
      'X-Test-Suite': 'per-vu-business-core',
      ...extraHeaders,
    },
    OPS_AUTH_TOKEN,
  );
}

function getHeaders(extraHeaders = {}) {
  return withOpsHeaders(
    {
      'X-Test-Suite': 'per-vu-business-core',
      ...extraHeaders,
    },
    OPS_AUTH_TOKEN,
  );
}
```

Cả hai hàm đều thêm `X-Test-Suite` header để đánh dấu request đến từ case này. `jsonHeaders` thêm `Content-Type: application/json` cho POST/PATCH request. Nếu `OPS_AUTH_TOKEN` được set, `withOpsHeaders` sẽ thêm authorization header.

**`post(urlPath, body, tags)`**, **`get(urlPath, tags, headers)`**, **`patch(urlPath, body, tags)`**:

Wrapper functions chuẩn hóa việc gửi request. Mỗi hàm:
1. Tạo URL đầy đủ từ `BASE_URL + urlPath`
2. Set headers phù hợp (jsonHeaders cho POST/PATCH, getHeaders cho GET)
3. Gắn tags để phân biệt trên dashboard
4. Parse JSON response an toàn với `safeJson`
5. Trả về `{ response, payload }`

**`ensureStatefulSession(ctx)`**:

```javascript
function ensureStatefulSession(ctx) {
  if (vuState.initialized) {
    return;
  }

  const login = post(
    `/api/sim/auth/login?cpu_ms=2&db_rows=1&memory_kb=4`,
    {
      username: ctx.userEmail,
      password: 'demo-pass',
    },
    {
      flow: 'stateful_login',
      case: 'stateful_business_flow',
      user_slot: String(ctx.userSlot),
    },
  );

  check(login, {
    'stateful login status 200': (o) => o.response.status === 200 || recordFailure(caseFailures, 'stateful_login_status'),
    'stateful login success true': (o) => o.payload && o.payload.success === true || recordFailure(caseFailures, 'stateful_login_success'),
  });

  vuState.initialized = true;
  vuState.cartItemId = `sku-${ctx.userSlot}`;
}
```

**Phân tích:**
- Chỉ gọi login một lần cho mỗi VU (`initialized` flag)
- K6 tự động xử lý cookie -- session được duy trì giữa các request
- `cartItemId` được set từ `userSlot` -- mỗi VU có cart item khác nhau, tránh conflict
- Nếu login fail, `recordFailure` tăng counter nhưng KHÔNG throw -- flow vẫn tiếp tục để thu thập đủ lỗi

**`assertSuccessEnvelope(result, label, statusCode = 200)`**:

```javascript
function assertSuccessEnvelope(result, label, statusCode = 200) {
  return check(result, {
    [`${label} status ${statusCode}`]: (o) => o.response.status === statusCode || recordFailure(caseFailures, `${label}_status`),
    [`${label} success true`]: (o) => o.payload && o.payload.success === true || recordFailure(caseFailures, `${label}_success`),
  });
}
```

Hàm này áp dụng assertion pattern chung cho mọi response: status code phải đúng và `success` phải `true`. Nếu fail, ghi nhận vào `caseFailures` counter nhưng không dừng flow.

### 5.8 Scenario 1 -- statefulBusinessFlow (deep-dive từng dòng)

```javascript
export function statefulBusinessFlow(data) {
  const ctx = buildUserContext(data.seed);
  const flowStartedAt = Date.now();

  ensureStatefulSession(ctx);

  const me = get(
    `/api/sim/auth/me?cpu_ms=2&db_rows=1&memory_kb=8&retain_memory_kb=64&gc_churn_kb=16&heap_objects=64`,
    {
      flow: 'stateful_me',
      case: 'stateful_business_flow',
      user_slot: String(ctx.userSlot),
    },
  );
  assertSuccessEnvelope(me, 'stateful_me');

  const cartAdd = post(
    `/api/sim/cart/add?cpu_ms=2&db_writes=1&memory_kb=4`,
    {
      product_id: ctx.userSlot,
      quantity: 1,
    },
    {
      flow: 'stateful_cart_add',
      case: 'stateful_business_flow',
      user_slot: String(ctx.userSlot),
    },
  );
  assertSuccessEnvelope(cartAdd, 'stateful_cart_add');

  const cartUpdate = patch(
    `/api/sim/cart/items/${vuState.cartItemId}?cpu_ms=1&db_writes=1`,
    { quantity: 2 },
    {
      flow: 'stateful_cart_update',
      case: 'stateful_business_flow',
      user_slot: String(ctx.userSlot),
    },
  );
  assertSuccessEnvelope(cartUpdate, 'stateful_cart_update');

  const checkout = post(
    `/api/sim/checkout?cpu_ms=4&db_writes=2&external_ms=30`,
    {
      payment_method: 'card',
      item_count: 2,
      coupon_code: 'PERVU10',
    },
    {
      flow: 'stateful_checkout',
      case: 'stateful_business_flow',
      user_slot: String(ctx.userSlot),
    },
  );
  assertSuccessEnvelope(checkout, 'stateful_checkout');

  const checkoutOrderId = checkout.payload && checkout.payload.data && checkout.payload.data.order_id
    ? String(checkout.payload.data.order_id)
    : `ORD-PERVU-STATEFUL-${ctx.requestId}`;
  const idempotencyKey = `idem-stateful-${ctx.requestId}`;
  const confirmResponse = http.post(
    `${BASE_URL}/api/sim/orders/${checkoutOrderId}/confirm?cpu_ms=2&db_writes=3&external_ms=60&external_fail_rate=0`,
    JSON.stringify({}),
    {
      headers: jsonHeaders({ 'Idempotency-Key': idempotencyKey }),
      tags: {
        flow: 'stateful_order_confirm',
        case: 'stateful_business_flow',
        user_slot: String(ctx.userSlot),
      },
    },
  );
  const confirmPayload = safeJson(confirmResponse);
  assertSuccessEnvelope({ response: confirmResponse, payload: confirmPayload }, 'stateful_order_confirm');

  const status = get(
    `/api/sim/orders/${checkoutOrderId}?cpu_ms=1&db_rows=2&view=full&include_history=1`,
    {
      flow: 'stateful_order_status',
      case: 'stateful_business_flow',
      user_slot: String(ctx.userSlot),
    },
  );
  assertSuccessEnvelope(status, 'stateful_order_status');
  check(status, {
    'stateful order status preserves order_id': (o) => (
      o.payload && o.payload.data && String(o.payload.data.order_id) === checkoutOrderId
    ) || recordFailure(caseFailures, 'stateful_order_status_order_id'),
  });

  statefulFlowDuration.add(Date.now() - flowStartedAt, {
    case: 'stateful_business_flow',
    user_slot: String(ctx.userSlot),
  });
  sleep(INTER_STEP_SLEEP_SECONDS);
}
```

**Phân tích từng bước:**

| Bước | Dòng code | Ý nghĩa | State phụ thuộc |
|---|---|---|---|
| 1 | `buildUserContext(data.seed)` | Tạo user context từ seed -- mỗi VU có user riêng | -- |
| 2 | `ensureStatefulSession(ctx)` | Login nếu chưa có session | -- |
| 3 | `get(/api/sim/auth/me)` | Verify session còn valid | Auth session |
| 4 | `post(/api/sim/cart/add)` | Thêm sản phẩm vào cart | Auth session |
| 5 | `patch(/api/sim/cart/items/:id)` | Cập nhật quantity | Cart item ID |
| 6 | `post(/api/sim/checkout)` | Tạo order từ cart | Cart state |
| 7 | `post(/api/sim/orders/:id/confirm)` | Xác nhận order với Idempotency-Key | Order ID |
| 8 | `get(/api/sim/orders/:id)` | Đọc order state | Order ID |
| 9 | `statefulFlowDuration.add(...)` | Ghi nhận tổng thời gian flow | -- |
| 10 | `sleep(...)` | Nghỉ giữa các iteration | -- |

**Query string parameters -- mô phỏng tải:**

Mỗi endpoint có query string parameters để mô phỏng tải thực tế:

| Parameter | Ý nghĩa | Ví dụ |
|---|---|---|
| `cpu_ms` | Thời gian CPU bận (ms) | `cpu_ms=2` -> service tốn 2ms CPU |
| `db_rows` | Số dòng database đọc | `db_rows=1` -> đọc 1 dòng từ Postgres |
| `db_writes` | Số lần ghi database | `db_writes=2` -> ghi 2 lần |
| `memory_kb` | Bộ nhớ cấp phát (KB) | `memory_kb=4` -> cấp 4KB |
| `external_ms` | Thời gian gọi external service (ms) | `external_ms=30` -> gọi payment mock 30ms |
| `json_items` | Số lượng item trong JSON response | `json_items=24` -> trả về 24 sản phẩm |
| `retain_memory_kb` | Bộ nhớ giữ lại (KB) | `retain_memory_kb=64` -> giữ 64KB |
| `gc_churn_kb` | Bộ nhớ GC xoay vòng (KB) | `gc_churn_kb=16` -> GC 16KB |
| `heap_objects` | Số lượng object trên heap | `heap_objects=64` -> tạo 64 object |
| `ready_after_ms` | Thời gian job sẵn sàng (ms) | `ready_after_ms=10` -> job sẵn sàng sau 10ms |

### 5.9 Scenario 2 & 3 -- AB test (abControlFlow, abVariantFlow)

```javascript
function runAbFlow(data, variant) {
  const ctx = buildUserContext(data.seed);
  const headers = getHeaders({
    'X-Ab-Variant': variant,
    'X-Geo-Country': 'VN',
    'X-Device-Class': 'mobile',
    'X-User-Segment': 'returning',
  });
  const commonTags = {
    case: 'ab_compare',
    variant,
    user_slot: String(ctx.userSlot),
  };

  const list = get(
    `/api/sim/products?limit=12&sort=popular&view=grid&include_facets=1&cpu_ms=4&db_rows=6&json_items=24`,
    { flow: 'ab_products_list', ...commonTags },
    headers,
  );
  assertSuccessEnvelope(list, `ab_${variant}_products_list`);
  abDuration.add(list.response.timings.duration, { ...commonTags, endpoint: 'products_list' });

  const search = get(
    `/api/sim/products/search?q=shoe&limit=8&include_facets=1&cpu_ms=4&db_rows=5&json_items=20`,
    { flow: 'ab_products_search', ...commonTags },
    headers,
  );
  assertSuccessEnvelope(search, `ab_${variant}_products_search`);
  abDuration.add(search.response.timings.duration, { ...commonTags, endpoint: 'products_search' });

  const homefeed = get(
    `/api/sim/products/homefeed?blocks=4&personalized=1&cpu_ms=3&db_rows=4&json_items=12`,
    { flow: 'ab_products_homefeed', ...commonTags },
    headers,
  );
  assertSuccessEnvelope(homefeed, `ab_${variant}_products_homefeed`);
  abDuration.add(homefeed.response.timings.duration, { ...commonTags, endpoint: 'products_homefeed' });
  sleep(INTER_STEP_SLEEP_SECONDS);
}

export function abControlFlow(data) {
  runAbFlow(data, 'control');
}

export function abVariantFlow(data) {
  runAbFlow(data, 'variant-a');
}
```

**Phân tích AB test:**

| Tiêu chí | Control | Variant A |
|---|---|---|
| Header `X-Ab-Variant` | `control` | `variant-a` |
| Số VU | 8 | 8 |
| Số iteration mỗi VU | 5 | 5 |
| Tổng request mỗi arm | 8 × 5 × 3 = 120 | 8 × 5 × 3 = 120 |
| Endpoints gọi | products list, search, homefeed | products list, search, homefeed |
| Custom metric | `per_vu_core_ab_duration` (Trend) | `per_vu_core_ab_duration` (Trend) |

AB test chứng minh rằng Nginx route đúng variant dựa trên header `X-Ab-Variant`. Mỗi variant có scenario riêng với VU riêng -- chúng chạy song song. Điều này mô phỏng traffic thực tế: 50% người dùng thấy control, 50% thấy variant.

### 5.10 Scenario 4 -- raceHotkeyConsistencyFlow

```javascript
export function raceHotkeyConsistencyFlow(data) {
  const ctx = buildUserContext(data.seed);
  const raceOrderId = `ORD-PERVU-RACE-${ctx.seed}-${ctx.iter}`;
  const raceKey = `idem-pervu-race-${ctx.seed}-${ctx.iter}`;

  const response = http.post(
    `${BASE_URL}/api/sim/orders/${raceOrderId}/confirm?cpu_ms=0&db_writes=6&external_ms=240&external_fail_rate=0`,
    JSON.stringify({}),
    {
      headers: jsonHeaders({ 'Idempotency-Key': raceKey }),
      tags: {
        case: 'race_hotkey_consistency',
        flow: 'race_confirm',
        race_iteration: String(ctx.iter),
      },
    },
  );
  const payload = safeJson(response);
  assertSuccessEnvelope({ response, payload }, 'race_confirm');

  const isReuse = !!(payload && payload.data && payload.data.idempotency_reuse === true);
  if (isReuse) {
    raceReuseCount.add(1, { race_iteration: String(ctx.iter) });
  } else {
    raceFreshCount.add(1, { race_iteration: String(ctx.iter) });
  }

  check({ response, payload }, {
    'race confirms preserve idempotency key': (o) => (
      o.payload && o.payload.data && String(o.payload.data.idempotency_key) === raceKey
    ) || recordFailure(caseFailures, 'race_idempotency_key'),
  });
}
```

**Cơ chế race condition test:**

```text
8 VUs, mỗi VU 2 iterations, tất cả confirm CÙNG MỘT order ID + CÙNG MỘT idempotency key:

Iteration 1 (raceOrderId = ORD-PERVU-RACE-{seed}-1, raceKey = idem-pervu-race-{seed}-1):
  VU 0 -> confirm -> fresh (đầu tiên) -> raceFreshCount++
  VU 1 -> confirm -> reuse (đã có VU 0 confirm) -> raceReuseCount++
  VU 2 -> confirm -> reuse -> raceReuseCount++
  ...
  VU 7 -> confirm -> reuse -> raceReuseCount++

Iteration 2 (raceOrderId = ORD-PERVU-RACE-{seed}-2, raceKey = idem-pervu-race-{seed}-2):
  Tương tự iteration 1

Expected:
  raceFreshCount = 2 (mỗi iteration 1 fresh)
  raceReuseCount = 14 (mỗi iteration 7 reuse × 2 iterations)
```

### 5.11 Scenario 5 -- idempotencyRetryFlow

```javascript
export function idempotencyRetryFlow(data) {
  const ctx = buildUserContext(data.seed);
  const orderId = `ORD-PERVU-IDEMP-${ctx.seed}-${ctx.userSlot}-${ctx.iter}`;
  const idempotencyKey = `idem-pervu-idemp-${ctx.seed}-${ctx.userSlot}-${ctx.iter}`;

  const firstResponse = http.post(
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=0&db_writes=6&external_ms=240&external_fail_rate=0`,
    JSON.stringify({}),
    {
      headers: jsonHeaders({ 'Idempotency-Key': idempotencyKey }),
      tags: {
        case: 'idempotency_retry',
        flow: 'confirm_first',
      },
    },
  );
  const firstPayload = safeJson(firstResponse);
  idemFirstDuration.add(firstResponse.timings.duration, { case: 'idempotency_retry' });
  assertSuccessEnvelope({ response: firstResponse, payload: firstPayload }, 'idem_confirm_first');
  check({ response: firstResponse, payload: firstPayload }, {
    'idempotency first call is fresh': (o) => (
      o.payload && o.payload.data && o.payload.data.idempotency_reuse === false
    ) || recordFailure(caseFailures, 'idem_first_fresh'),
  });
  idemFreshCount.add(1);

  const duplicateResponse = http.post(
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=0&db_writes=6&external_ms=240&external_fail_rate=0`,
    JSON.stringify({}),
    {
      headers: jsonHeaders({ 'Idempotency-Key': idempotencyKey }),
      tags: {
        case: 'idempotency_retry',
        flow: 'confirm_duplicate',
      },
    },
  );
  const duplicatePayload = safeJson(duplicateResponse);
  idemDuplicateDuration.add(duplicateResponse.timings.duration, { case: 'idempotency_retry' });
  assertSuccessEnvelope({ response: duplicateResponse, payload: duplicatePayload }, 'idem_confirm_duplicate');

  check({ first: firstResponse, duplicate: duplicateResponse, duplicatePayload }, {
    'idempotency duplicate reuses cached result': (o) => (
      o.duplicatePayload && o.duplicatePayload.data && o.duplicatePayload.data.idempotency_reuse === true
    ) || recordFailure(caseFailures, 'idem_duplicate_reuse'),
    [`idempotency duplicate duration <= ${IDEMP_DUP_MAX_MS}ms or ratio <= ${Math.round(IDEMP_DUP_RATIO_MAX * 100)}%`]: (o) => (
      o.duplicate.timings.duration <= IDEMP_DUP_MAX_MS ||
      o.duplicate.timings.duration <= o.first.timings.duration * IDEMP_DUP_RATIO_MAX
    ) || recordFailure(caseFailures, 'idem_duplicate_duration'),
  });
  idemDuplicateReuseCount.add(1);
}
```

**Phân tích idempotency test:**

Mỗi VU, mỗi iteration:
1. Gọi confirm lần 1 với `Idempotency-Key` mới -> phải là "fresh" (`idempotency_reuse: false`)
2. Gọi confirm lần 2 với CÙNG `Idempotency-Key` -> phải là "reuse" (`idempotency_reuse: true`)
3. Thời gian lần 2 phải nhanh hơn lần 1 (dùng cached result, không cần gọi external service)

**Expected:**
- `idemFreshCount = 6 VU × 3 iters = 18`
- `idemDuplicateReuseCount = 6 VU × 3 iters = 18`
- Mỗi duplicate call phải có duration <= 110ms HOẶC <= 50% duration của first call

### 5.12 Scenario 6 -- predictableBatchFlow

```javascript
export function predictableBatchFlow(data) {
  const ctx = buildUserContext(data.seed);
  const create = post(
    `/api/sim/report/jobs?cpu_ms=2&db_rows=2&ready_after_ms=10`,
    {
      report_type: 'sales',
      context: `batch-${ctx.requestId}`,
    },
    {
      case: 'predictable_batch',
      flow: 'report_job_create',
    },
  );
  assertSuccessEnvelope(create, 'batch_create_job', 202);

  const jobId = create.payload && create.payload.data ? String(create.payload.data.job_id || '') : '';
  check({ jobId }, {
    'batch create returns job id': (o) => o.jobId !== '' || recordFailure(caseFailures, 'batch_job_id'),
  });
  batchJobsCreated.add(1);

  const list = get(
    `/api/sim/report/jobs?limit=10&cpu_ms=1&db_rows=1`,
    {
      case: 'predictable_batch',
      flow: 'report_job_list',
    },
  );
  assertSuccessEnvelope(list, 'batch_list_jobs');

  if (jobId) {
    const status = get(
      `/api/sim/report/jobs/${jobId}?cpu_ms=1&db_rows=1`,
      {
        case: 'predictable_batch',
        flow: 'report_job_status',
      },
    );
    assertSuccessEnvelope(status, 'batch_job_status');
    batchJobStatusRead.add(1);

    const download = get(
      `/api/sim/report/jobs/${jobId}/download?cpu_ms=1`,
      {
        case: 'predictable_batch',
        flow: 'report_job_download',
      },
    );
    check(download, {
      'batch job download status 200 or 202': (o) => (
        o.response.status === 200 || o.response.status === 202
      ) || recordFailure(caseFailures, 'batch_download_status'),
      'batch job download has request id header': (o) => headerValue(o.response, 'X-Request-ID') !== '' || recordFailure(caseFailures, 'batch_download_request_id'),
    });
  }
}
```

**Phân tích batch job lifecycle:**

| Bước | Endpoint | Expected status | Ý nghĩa |
|---|---|---|---|
| 1 | `POST /api/sim/report/jobs` | 202 Accepted | Tạo job bất đồng bộ -- service nhận job, chưa hoàn thành |
| 2 | `GET /api/sim/report/jobs` | 200 OK | Liệt kê tất cả job |
| 3 | `GET /api/sim/report/jobs/:id` | 200 OK | Kiểm tra trạng thái một job |
| 4 | `GET /api/sim/report/jobs/:id/download` | 200 hoặc 202 | Tải kết quả job (có thể chưa sẵn sàng) |

---

## 6. Cross-service mechanism deep-dive

### 6.1 Auth token propagation

Khi `ensureStatefulSession()` gọi `POST /api/sim/auth/login`, k6 tự động nhận cookie session từ response `Set-Cookie` header. Tất cả request sau đó tự động gửi lại cookie này -- không cần code xử lý thêm.

```text
┌─────────────────────────────────────────────────────────────────┐
│                  AUTH TOKEN PROPAGATION                          │
│                                                                  │
│  Step 1: POST /api/sim/auth/login                               │
│    Request:  { username, password }                              │
│    Response: 200 OK + Set-Cookie: session_id=abc123              │
│    K6:       Lưu cookie session_id=abc123 vào cookie jar        │
│                                                                  │
│  Step 2: GET /api/sim/auth/me                                   │
│    Request:  Cookie: session_id=abc123 (tự động từ k6)          │
│    Response: 200 OK + { success: true, data: { user: ... } }    │
│                                                                  │
│  Step 3-7: Tương tự -- cookie tự động được gửi                  │
│                                                                  │
│  Nếu cookie không propagate: Step 2 trả về 401 Unauthorized     │
│  -> check 'stateful_me success true' FAIL                        │
│  -> caseFailures counter tăng                                    │
└─────────────────────────────────────────────────────────────────┘
```

**Điểm quan trọng:** K6 cookie jar là VU-level. Cookie từ VU 0 không bị leak sang VU 1. Đây là lý do `per-vu-iterations` executor được chọn -- mỗi VU có cookie jar riêng.

### 6.2 Cart state persistence

Cart state được duy trì qua hai cơ chế:
1. **Server-side**: Cart service lưu cart state trong database (Postgres) -- state survive giữa các request
2. **Client-side (VU context)**: `vuState.cartItemId` lưu item ID để dùng cho PATCH request

```text
┌─────────────────────────────────────────────────────────────────┐
│                  CART STATE PERSISTENCE                          │
│                                                                  │
│  Step 3: POST /api/sim/cart/add                                 │
│    Request:  { product_id: 0, quantity: 1 }                     │
│    Response: 200 OK + { success: true, data: { item_id: ... } } │
│    VU State: cartItemId = response.data.item_id                 │
│                                                                  │
│  Step 4: PATCH /api/sim/cart/items/{cartItemId}                 │
│    Request:  { quantity: 2 }                                    │
│    Response: 200 OK + { success: true, data: { updated: true }} │
│                                                                  │
│  Nếu cart state không persist: Step 4 trả về 404 Not Found      │
│  -> check 'stateful_cart_update status 200' FAIL                │
│  -> caseFailures counter tăng                                    │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 Order ID mapping

Order ID được tạo ra ở bước checkout và được dùng cho các bước confirm và status. Có hai ID quan trọng:

| ID | Tạo ra ở đâu | Dùng ở đâu | Ý nghĩa |
|---|---|---|---|
| `order_id` | `POST /api/sim/checkout` response | `POST /api/sim/orders/:id/confirm`, `GET /api/sim/orders/:id` | Định danh đơn hàng duy nhất |
| `Idempotency-Key` | Client tạo ra (UUID) | `POST /api/sim/orders/:id/confirm` header | Đảm bảo confirm không bị trùng lặp |

```text
┌─────────────────────────────────────────────────────────────────┐
│                  ORDER ID MAPPING                                │
│                                                                  │
│  Step 5: POST /api/sim/checkout                                 │
│    Response: 200 OK + { success: true, data: { order_id: 42 } } │
│    VU State: checkoutOrderId = "42"                             │
│                                                                  │
│  Step 6: POST /api/sim/orders/42/confirm                        │
│    Header:  Idempotency-Key: idem-stateful-{requestId}          │
│    Response: 200 OK + { success: true }                         │
│                                                                  │
│  Step 7: GET /api/sim/orders/42                                 │
│    Response: 200 OK + { success: true, data: { order_id: 42 } } │
│    Assert:   data.order_id === "42" (checkoutOrderId)           │
│                                                                  │
│  Nếu mapping sai:                                               │
│    - confirm có thể confirm sai order (404 hoặc sai order)      │
│    - status có thể trả về order_id khác 42                      │
│    -> check 'stateful order status preserves order_id' FAIL     │
│    -> caseFailures counter tăng                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 6.4 Service boundary transitions

Mỗi bước trong flow chuyển request qua một service boundary khác nhau. Header `X-Upstream-Service` cho biết service nào đã xử lý request:

```text
Bước 1: POST /api/sim/auth/login          -> X-Upstream-Service: auth-service
Bước 2: GET  /api/sim/auth/me              -> X-Upstream-Service: auth-service
Bước 3: POST /api/sim/cart/add             -> X-Upstream-Service: cart-service
Bước 4: PATCH /api/sim/cart/items/:id      -> X-Upstream-Service: cart-service
Bước 5: POST /api/sim/checkout             -> X-Upstream-Service: order-service
Bước 6: POST /api/sim/orders/:id/confirm   -> X-Upstream-Service: order-service
Bước 7: GET  /api/sim/orders/:id           -> X-Upstream-Service: order-service
```

Trong quá trình chạy, Nginx quyết định upstream dựa trên URL prefix. Nếu routing config sai (ví dụ: `/api/sim/checkout` route đến cart-service thay vì order-service), response sẽ có `X-Upstream-Service: cart-service` ở bước 5 -- evidence rõ ràng của routing error.

### 6.5 Idempotency mechanism

Idempotency-Key là cơ chế đảm bảo một operation chỉ được thực thi một lần, dù client có gọi lại bao nhiêu lần:

```text
┌─────────────────────────────────────────────────────────────────┐
│                  IDEMPOTENCY MECHANISM                           │
│                                                                  │
│  Lần gọi thứ 1 với key "abc":                                   │
│    1. Order service nhận request                                 │
│    2. Kiểm tra Redis: key "abc" chưa tồn tại                    │
│    3. Thực thi confirm: ghi database, gọi external payment      │
│    4. Lưu kết quả vào Redis: key "abc" -> response data         │
│    5. Trả về: idempotency_reuse: false, duration: 250ms         │
│                                                                  │
│  Lần gọi thứ 2 với key "abc":                                   │
│    1. Order service nhận request                                 │
│    2. Kiểm tra Redis: key "abc" ĐÃ tồn tại                       │
│    3. KHÔNG thực thi confirm -- trả về cached result            │
│    4. Trả về: idempotency_reuse: true, duration: 5ms            │
│                                                                  │
│  Nếu idempotency không hoạt động:                               │
│    - Lần 2 vẫn có idempotency_reuse: false                      │
│    - Hoặc lần 2 có duration tương đương lần 1                   │
│    -> check 'idempotency duplicate reuses cached result' FAIL   │
│    -> threshold idem_duplicate_duration FAIL                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Request sequence flow

### 7.1 Timeline stateful_business_flow (1 VU, 1 iteration)

| Thời gian (ms) | Actor | Hành động | Request/Response | State transition |
|---|---|---|---|---|
| 0 | k6 VU | Bắt đầu iteration | -- | `vuState.initialized = false` |
| 1 | k6 | `ensureStatefulSession()` | -- | -- |
| 1 | k6 | POST login | `POST :80/api/sim/auth/login?cpu_ms=2&db_rows=1&memory_kb=4` | -- |
| 1 | Nginx | Route đến auth-service | -- | -- |
| 1 | auth-service | Xử lý login | Trả về 200 + Set-Cookie | Auth session được tạo |
| 5 | k6 | Check login | PASS | `vuState.initialized = true` |
| 5 | k6 | GET me | `GET :80/api/sim/auth/me?...` | -- |
| 5 | Nginx | Route đến auth-service | -- | -- |
| 5 | auth-service | Verify session | Trả về 200 + user info | Session valid |
| 10 | k6 | Check me | PASS | -- |
| 10 | k6 | POST cart add | `POST :80/api/sim/cart/add?...` | -- |
| 10 | Nginx | Route đến cart-service | -- | -- |
| 10 | cart-service | Tạo cart item | Trả về 200 + item_id | Cart item được tạo |
| 15 | k6 | Check cart add | PASS | -- |
| 15 | k6 | PATCH cart update | `PATCH :80/api/sim/cart/items/{cartItemId}?...` | -- |
| 15 | Nginx | Route đến cart-service | -- | -- |
| 15 | cart-service | Cập nhật quantity | Trả về 200 | Cart state updated |
| 20 | k6 | Check cart update | PASS | -- |
| 20 | k6 | POST checkout | `POST :80/api/sim/checkout?...` | -- |
| 20 | Nginx | Route đến order-service | -- | -- |
| 20 | order-service | Tạo order từ cart | Trả về 200 + order_id | Order được tạo |
| 30 | k6 | Check checkout | PASS | `checkoutOrderId` được lưu |
| 30 | k6 | POST confirm | `POST :80/api/sim/orders/{orderId}/confirm?...` + Idempotency-Key | -- |
| 30 | Nginx | Route đến order-service | -- | -- |
| 30 | order-service | Xác nhận order | Trả về 200 | Order confirmed |
| 95 | k6 | Check confirm | PASS | -- |
| 95 | k6 | GET status | `GET :80/api/sim/orders/{orderId}?...` | -- |
| 95 | Nginx | Route đến order-service | -- | -- |
| 95 | order-service | Đọc order state | Trả về 200 + order data | -- |
| 100 | k6 | Check status + order_id | PASS | Flow hoàn tất |
| 105 | k6 | `statefulFlowDuration.add(...)` | Ghi nhận ~105ms | -- |
| 105 | k6 | `sleep(30ms)` | Nghỉ trước iteration tiếp theo | -- |

### 7.2 Timeline race_hotkey_consistency (8 VU, 1 iteration)

```text
Thời gian (ms)  VU0          VU1          VU2 ... VU7
────────────────────────────────────────────────────────────
0               POST confirm POST confirm POST confirm ... (8 VU gọi đồng thời)
0               (tạo key)   (tạo key)   (tạo key)
50              response     response    response
                fresh!       reuse        reuse
                raceFresh++  raceReuse++  raceReuse++
────────────────────────────────────────────────────────────
Kết quả: raceFreshCount = 1, raceReuseCount = 7
```

### 7.3 Timeline idempotency_retry (1 VU, 1 iteration)

```text
Thời gian (ms)  Hành động                              Kết quả
────────────────────────────────────────────────────────────
0               POST confirm lần 1 (key mới)           fresh, duration ~250ms
250             Check: fresh = true                    PASS
250             idemFreshCount++                       = 1
250             POST confirm lần 2 (cùng key)          reuse, duration ~5ms
255             Check: reuse = true                    PASS
255             Check: duration <= 110ms               PASS (5ms < 110ms)
255             idemDuplicateReuseCount++              = 1
────────────────────────────────────────────────────────────
```

### 7.4 Timeline predictable_batch_jobs (1 VU, 1 iteration)

```text
Thời gian (ms)  Hành động                              Expected Status
────────────────────────────────────────────────────────────
0               POST /api/sim/report/jobs              202 Accepted
5               Check: job_id được trả về              PASS
5               batchJobsCreated++                     = 1
5               GET /api/sim/report/jobs               200 OK
10              Check: list                             PASS
10              GET /api/sim/report/jobs/{jobId}       200 OK
15              Check: status                           PASS
15              batchJobStatusRead++                   = 1
15              GET /api/sim/report/jobs/{jobId}/download  200 or 202
20              Check: download status + request ID     PASS
────────────────────────────────────────────────────────────
```

### 7.5 Trạng thái state qua thời gian (stateful flow)

```text
Trạng thái của VU:

t=0ms           t=5ms          t=15ms          t=30ms          t=105ms
│ AUTH          │ CART          │ ORDER          │ VERIFY         │ DONE
│               │               │                │                │
│ vuState:      │ vuState:      │ checkoutOrderId│ status check   │ iteration
│ initialized   │ initialized   │ = "42"         │ order_id=42    │ complete
│ = false       │ = true        │                │                │
│               │ cartItemId    │                │                │
│               │ = "sku-0"     │                │                │
│               │               │                │                │
│ ──────────────┼───────────────┼────────────────┼────────────────┼──────────►
│               │               │                │                │
│ POST login    │ POST cart add │ POST checkout  │ GET status     │
│ GET me        │ PATCH cart    │ POST confirm   │                │
│               │               │                │                │
│ X-Upstream:   │ X-Upstream:   │ X-Upstream:    │ X-Upstream:    │
│ auth-service  │ cart-service  │ order-service  │ order-service  │
└───────────────┴───────────────┴────────────────┴────────────────┘
```

---

## 8. Key signals / counters

### 8.1 Bảng đầy đủ counters và tín hiệu

Đây là case nhiều counters nhất -- mỗi scenario có counters riêng. Đọc theo scenario, không aggregate.

#### 8.1.1 Scenario: stateful_business_flow

| Signal/Counter | Loại | Giá trị mong đợi | Ý nghĩa nếu PASS | Ý nghĩa nếu FAIL |
|---|---|---|---|---|
| `checks` | k6 built-in | 100% | Tất cả assertion pass | Có ít nhất 1 assertion fail |
| `http_req_failed` | k6 built-in | 0.00% | Không có HTTP error | Có request trả về 4xx/5xx |
| `per_vu_core_case_failures` | Custom Counter | 0 | Không có failure nào | Có ít nhất 1 check ghi nhận failure |
| `per_vu_core_stateful_flow_duration` | Custom Trend | Có giá trị, không quá cao | Flow hoàn thành trong thời gian hợp lý | Flow quá chậm (có thể do network hoặc service overload) |
| `X-Upstream-Service` sequence | Response header | `auth-service` -> `auth-service` -> `cart-service` -> `cart-service` -> `order-service` -> `order-service` -> `order-service` | Routing đúng cho mọi bước | Routing sai ở ít nhất một bước |
| Login -> Me | Flow check | Session valid, user info đúng | Auth hoạt động đúng | Session không propagate |
| Cart add -> Cart update | Flow check | State persist, item_id không đổi | Cart state persist | Cart state không share giữa request |
| Checkout -> Confirm -> Status | Flow check | order_id preserved | Order state machine đúng | State corruption |

#### 8.1.2 Scenario: ab_control + ab_variant_a

| Signal/Counter | Loại | Giá trị mong đợi | Ý nghĩa nếu PASS | Ý nghĩa nếu FAIL |
|---|---|---|---|---|
| `checks` | k6 built-in | 100% (cả hai arm) | AB test routing đúng | Một trong hai arm fail |
| `per_vu_core_ab_duration` | Custom Trend | Có giá trị, so sánh giữa 2 arm | AB test hoạt động | Có thể một arm chậm hơn đáng kể |
| `X-Upstream-Service` (tất cả response) | Response header | `products-service` | Products service xử lý AB request | Sai service |

#### 8.1.3 Scenario: race_hotkey_consistency

| Signal/Counter | Loại | Giá trị mong đợi | Ý nghĩa nếu PASS | Ý nghĩa nếu FAIL |
|---|---|---|---|---|
| `per_vu_core_race_fresh_count` | Custom Counter | `== RACE_EXPECTED_FRESH` (2) | Đúng số lần fresh | Idempotency không hoạt động hoặc race condition sai |
| `per_vu_core_race_reuse_count` | Custom Counter | `== RACE_EXPECTED_REUSE` (14) | Các VU sau thấy reuse | VU sau không thấy reuse -- có thể idempotency sai |
| `per_vu_core_case_failures` | Custom Counter | 0 | Không có failure | Có VU fail confirm |

#### 8.1.4 Scenario: idempotency_retry

| Signal/Counter | Loại | Giá trị mong đợi | Ý nghĩa nếu PASS | Ý nghĩa nếu FAIL |
|---|---|---|---|---|
| `per_vu_core_idem_fresh_count` | Custom Counter | `== IDEMP_EXPECTED_FRESH` (18) | Tất cả first call là fresh | Có first call bị reuse (key collision) |
| `per_vu_core_idem_duplicate_reuse_count` | Custom Counter | `== IDEMP_EXPECTED_DUPLICATE_REUSE` (18) | Tất cả duplicate call reuse | Duplicate call không reuse (idempotency không hoạt động) |
| `per_vu_core_idem_first_duration` | Custom Trend | Có giá trị, baseline cho so sánh | First call bình thường | -- |
| `per_vu_core_idem_duplicate_duration` | Custom Trend | <= 110ms hoặc <= 50% first | Duplicate call nhanh hơn nhiều | Duplicate call chậm -- có thể idempotency cache sai |

#### 8.1.5 Scenario: predictable_batch_jobs

| Signal/Counter | Loại | Giá trị mong đợi | Ý nghĩa nếu PASS | Ý nghĩa nếu FAIL |
|---|---|---|---|---|
| `per_vu_core_batch_jobs_created` | Custom Counter | `== BATCH_EXPECTED_CREATED` (20) | Đúng số job được tạo | Job create fail hoặc không trả về job_id |
| `per_vu_core_batch_job_status_read` | Custom Counter | `== BATCH_EXPECTED_STATUS_READ` (20) | Đúng số lần đọc status | Job status fail |
| `per_vu_core_case_failures` | Custom Counter | 0 | Không có failure | Có bước fail trong batch lifecycle |

### 8.2 Cách đọc dashboard/chart

Chart nên đọc:

- checks rate 100% cho toàn bộ 6 scenarios;
- `per_vu_core_case_failures` = 0;
- `per_vu_core_stateful_flow_duration` trend -- toàn bộ flow mất bao lâu;
- `per_vu_core_race_fresh_count` vs `per_vu_core_race_reuse_count`;
- `per_vu_core_idem_fresh_count` vs `per_vu_core_idem_duplicate_reuse_count`;
- `per_vu_core_batch_jobs_created` vs `per_vu_core_batch_job_status_read`.

### 8.3 Bảng cross-reference: counter -> scenario -> expected value

| Counter | Scenario | Expected Value (mặc định) | Công thức |
|---|---|---|---|
| `per_vu_core_case_failures` | Tất cả | 0 | -- |
| `per_vu_core_stateful_flow_duration` | `stateful_business_flow` | Có giá trị (Trend) | -- |
| `per_vu_core_ab_duration` | `ab_control`, `ab_variant_a` | Có giá trị (Trend) | -- |
| `per_vu_core_race_fresh_count` | `race_hotkey_consistency` | 2 | `RACE_ITERS` |
| `per_vu_core_race_reuse_count` | `race_hotkey_consistency` | 14 | `RACE_ITERS * (RACE_VUS - 1)` |
| `per_vu_core_idem_fresh_count` | `idempotency_retry` | 18 | `IDEMP_VUS * IDEMP_ITERS` |
| `per_vu_core_idem_duplicate_reuse_count` | `idempotency_retry` | 18 | `IDEMP_VUS * IDEMP_ITERS` |
| `per_vu_core_idem_first_duration` | `idempotency_retry` | Có giá trị (Trend) | -- |
| `per_vu_core_idem_duplicate_duration` | `idempotency_retry` | Có giá trị (Trend) | -- |
| `per_vu_core_batch_jobs_created` | `predictable_batch_jobs` | 20 | `BATCH_VUS * BATCH_ITERS` |
| `per_vu_core_batch_job_status_read` | `predictable_batch_jobs` | 20 | `BATCH_VUS * BATCH_ITERS` |

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí định lượng -- per-scenario, không aggregate

Không gộp chung pass/fail của 6 scenarios. Mỗi scenario có thresholds riêng.

#### 9.1.1 stateful_business_flow

| # | Tiêu chí | Loại | Ngưỡng | Hậu quả nếu FAIL |
|---|---|---|---|---|
| SF1 | `checks` rate | k6 threshold | `== 1` (100%) | Toàn bộ test case thất bại |
| SF2 | `http_req_failed` rate | k6 threshold | `== 0` (0%) | Có request thất bại |
| SF3 | `per_vu_core_case_failures` | k6 threshold | `== 0` | Có ít nhất 1 check fail |
| SF4 | Login status | Assertion | 200 + success=true | Auth service lỗi -- không thể tiếp tục |
| SF5 | Me status | Assertion | 200 + success=true | Session không propagate từ login |
| SF6 | Cart add status | Assertion | 200 + success=true | Cart service lỗi |
| SF7 | Cart update status | Assertion | 200 + success=true | Cart state không persist |
| SF8 | Checkout status | Assertion | 200 + success=true | Order service lỗi |
| SF9 | Confirm status | Assertion | 200 + success=true | Order confirm lỗi |
| SF10 | Status check | Assertion | 200 + success=true | Order status lỗi |
| SF11 | order_id preserved | Assertion | `data.order_id === checkoutOrderId` | State corruption -- order_id không khớp |

#### 9.1.2 ab_control + ab_variant_a

| # | Tiêu chí | Loại | Ngưỡng |
|---|---|---|---|
| AB1 | `checks` rate (cả hai arm) | k6 threshold | `== 1` |
| AB2 | `http_req_failed` rate | k6 threshold | `== 0` |
| AB3 | Products list (cả hai) | Assertion | 200 + success=true |
| AB4 | Products search (cả hai) | Assertion | 200 + success=true |
| AB5 | Products homefeed (cả hai) | Assertion | 200 + success=true |

#### 9.1.3 race_hotkey_consistency

| # | Tiêu chí | Loại | Ngưỡng |
|---|---|---|---|
| RC1 | `checks` rate | k6 threshold | `== 1` |
| RC2 | `per_vu_core_race_fresh_count` | k6 threshold | `== 2` |
| RC3 | `per_vu_core_race_reuse_count` | k6 threshold | `== 14` |
| RC4 | `per_vu_core_case_failures` | k6 threshold | `== 0` |
| RC5 | idempotency key preserved | Assertion | `data.idempotency_key === raceKey` |

#### 9.1.4 idempotency_retry

| # | Tiêu chí | Loại | Ngưỡng |
|---|---|---|---|
| ID1 | `checks` rate | k6 threshold | `== 1` |
| ID2 | `per_vu_core_idem_fresh_count` | k6 threshold | `== 18` |
| ID3 | `per_vu_core_idem_duplicate_reuse_count` | k6 threshold | `== 18` |
| ID4 | `per_vu_core_case_failures` | k6 threshold | `== 0` |
| ID5 | First call là fresh | Assertion | `idempotency_reuse === false` |
| ID6 | Duplicate call là reuse | Assertion | `idempotency_reuse === true` |
| ID7 | Duplicate duration | Assertion | `<= 110ms` hoặc `<= 50% first` |

#### 9.1.5 predictable_batch_jobs

| # | Tiêu chí | Loại | Ngưỡng |
|---|---|---|---|
| PB1 | `checks` rate | k6 threshold | `== 1` |
| PB2 | `per_vu_core_batch_jobs_created` | k6 threshold | `== 20` |
| PB3 | `per_vu_core_batch_job_status_read` | k6 threshold | `== 20` |
| PB4 | `per_vu_core_case_failures` | k6 threshold | `== 0` |
| PB5 | Job create status | Assertion | 202 Accepted |
| PB6 | Job ID được trả về | Assertion | `job_id !== ''` |
| PB7 | Job list | Assertion | 200 + success=true |
| PB8 | Job status | Assertion | 200 + success=true |
| PB9 | Job download | Assertion | 200 hoặc 202 |
| PB10 | X-Request-ID trong download | Assertion | Không rỗng |

### 9.2 Ma trận pass/fail tổng hợp

| Kịch bản | Stateful | AB Control | AB Variant | Race | Idempotency | Batch | Kết luận |
|---|---|---|---|---|---|---|---|
| **Happy path** | PASS | PASS | PASS | PASS | PASS | PASS | **PERFECT** -- Tất cả 6 scenarios pass |
| Auth service lỗi | FAIL | PASS | PASS | N/A | N/A | PASS | Auth service cần sửa. AB test và batch vẫn OK vì không dùng auth |
| Cart service lỗi | FAIL | PASS | PASS | N/A | N/A | PASS | Cart service cần sửa |
| Order service lỗi | FAIL | PASS | PASS | FAIL | FAIL | PASS | Order service cần sửa -- ảnh hưởng stateful + race + idempotency |
| Report service lỗi | PASS | PASS | PASS | PASS | PASS | FAIL | Report service cần sửa -- stateful flow không dùng report |
| Nginx routing sai | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | Gateway routing sai -- TẤT CẢ fail |
| AB test routing sai | PASS | FAIL | PASS | PASS | PASS | PASS | AB routing cho variant-a sai, control vẫn đúng |
| Idempotency sai | PASS | PASS | PASS | FAIL | FAIL | PASS | Redis hoặc idempotency logic sai |
| Network chậm | PASS (chậm) | PASS (chậm) | PASS (chậm) | PASS (chậm) | FAIL (duplicate > max) | PASS (chậm) | Duplicate call vượt ngưỡng thời gian |

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy

```powershell
# Set biến môi trường (BASE_URL là bắt buộc)
$env:BASE_URL = "http://localhost:80"

# Chạy case ms-06 với config mặc định
cd E:\Projects\k6\k6-metrics-server\load-target
k6 run k6/app/32-per-vu-business-core.js

# Với biến môi trường tùy chỉnh
$env:PERVU_CORE_STATEFUL_VUS = "10"
$env:PERVU_CORE_STATEFUL_ITERS = "5"
$env:PERVU_CORE_RACE_VUS = "12"
$env:PERVU_CORE_IDEMP_VUS = "8"
$env:PERVU_CORE_BATCH_VUS = "6"
k6 run k6/app/32-per-vu-business-core.js

# Chạy với output JSON để phân tích sau
k6 run k6/app/32-per-vu-business-core.js --out json=results-ms06.json

# Chạy với verbose logging để debug
k6 run k6/app/32-per-vu-business-core.js --verbose

# Chỉ chạy một scenario cụ thể (dùng --tag)
k6 run k6/app/32-per-vu-business-core.js --tag case=stateful_business_flow
```

### 10.2 Output mẫu -- PASS (tất cả 6 scenarios)

```text
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: k6\app\32-per-vu-business-core.js
     output: -

  scenarios: (100.00%) 6 scenarios, 40 max VUs, 10m30s max duration (incl. graceful stop):
           * stateful_business_flow: 4 iterations for each of 6 VUs (maxDuration: 10m0s, gracefulStop: 0s)
           * ab_control: 5 iterations for each of 8 VUs (maxDuration: 8m0s, gracefulStop: 0s)
           * ab_variant_a: 5 iterations for each of 8 VUs (maxDuration: 8m0s, gracefulStop: 0s)
           * race_hotkey_consistency: 2 iterations for each of 8 VUs (maxDuration: 5m0s, gracefulStop: 2s)
           * idempotency_retry: 3 iterations for each of 6 VUs (maxDuration: 8m0s, gracefulStop: 2s)
           * predictable_batch_jobs: 5 iterations for each of 4 VUs (maxDuration: 8m0s, gracefulStop: 3s)

INFO[0000] stateful login status 200                       source=console
INFO[0000] stateful login success true                     source=console
INFO[0000] stateful_me status 200                          source=console
INFO[0000] stateful_me success true                        source=console
INFO[0000] stateful_cart_add status 200                    source=console
INFO[0000] stateful_cart_add success true                  source=console
INFO[0000] stateful_cart_update status 200                 source=console
INFO[0000] stateful_cart_update success true               source=console
INFO[0000] stateful_checkout status 200                    source=console
INFO[0000] stateful_checkout success true                  source=console
INFO[0000] stateful_order_confirm status 200               source=console
INFO[0000] stateful_order_confirm success true             source=console
INFO[0000] stateful_order_status status 200                source=console
INFO[0000] stateful_order_status success true              source=console

     ✓ stateful login status 200
     ✓ stateful login success true
     ✓ stateful_me status 200
     ✓ stateful_me success true
     ✓ stateful_cart_add status 200
     ✓ stateful_cart_add success true
     ✓ stateful_cart_update status 200
     ✓ stateful_cart_update success true
     ✓ stateful_checkout status 200
     ✓ stateful_checkout success true
     ✓ stateful_order_confirm status 200
     ✓ stateful_order_confirm success true
     ✓ stateful_order_status status 200
     ✓ stateful_order_status success true
     ✓ stateful order status preserves order_id
     ...

     █ setup

     checks.........................: 100.00% ✓ 384      ✗ 0
     http_req_failed................: 0.00%   ✓ 0        ✗ 384
     per_vu_core_case_failures......: 0        ✓ 0
     per_vu_core_stateful_flow_duration: min=45ms max=250ms avg=98ms p(95)=180ms
     per_vu_core_race_fresh_count...: 2        ✓ 2
     per_vu_core_race_reuse_count...: 14       ✓ 14
     per_vu_core_idem_fresh_count...: 18       ✓ 18
     per_vu_core_idem_duplicate_reuse_count: 18 ✓ 18
     per_vu_core_batch_jobs_created.: 20       ✓ 20
     per_vu_core_batch_job_status_read: 20     ✓ 20

running (00m15.2s), 0/40 VUs, 40 complete and 0 interrupted iterations
```

**Phân tích output:**

| Chỉ số | Giá trị | Nhận xét |
|---|---|---|
| `checks` | `100.00% ✓ 384 ✗ 0` | Tất cả checks pass -- PERFECT |
| `http_req_failed` | `0.00%` | Không có request thất bại |
| `per_vu_core_case_failures` | `0` | Không một failure nào |
| `per_vu_core_stateful_flow_duration` | `avg=98ms` | Flow nhanh, service khỏe mạnh |
| `per_vu_core_race_fresh_count` | `2` | Đúng expected |
| `per_vu_core_race_reuse_count` | `14` | Đúng expected |
| `per_vu_core_idem_fresh_count` | `18` | Đúng expected |
| `per_vu_core_idem_duplicate_reuse_count` | `18` | Đúng expected |
| `per_vu_core_batch_jobs_created` | `20` | Đúng expected |
| `per_vu_core_batch_job_status_read` | `20` | Đúng expected |

### 10.3 Output mẫu -- FAIL (một scenario fail)

```text
✗ stateful_cart_update success true
  ↳  92% -- true

✗ stateful_checkout status 200
  ↳  92% -- 200

per_vu_core_case_failures.......: 2        ✗ 0
  (threshold: count==0)

running (00m12.0s), 0/40 VUs, 38 complete and 2 interrupted iterations
stateful_business_flow ✗ [=====...] 6 VUs  00m12.0s/10m0s  22/24 iters, 4 per VU
```

**Phân tích lỗi:**

| Dấu hiệu | Nguyên nhân có thể | Cách khắc phục |
|---|---|---|
| `stateful_cart_update success true` fail | Cart service contract thay đổi | Kiểm tra cart-service logs, so sánh response contract |
| `stateful_checkout status 200` fail (92%) | Một số VU checkout fail | Kiểm tra order-service, có thể database lock hoặc race condition |
| `per_vu_core_case_failures = 2` | 2 check fail trong toàn bộ run | Điều tra scenario stateful_business_flow |

---

## 11. 4 output -> decision scenarios

### 11.1 Scenario 1: PERFECT PASS -- Tất cả 6 scenarios pass

```text
Kết quả:
  ✓ Tất cả thresholds pass
  ✓ checks = 100%
  ✓ http_req_failed = 0%
  ✓ per_vu_core_case_failures = 0
  ✓ Tất cả expected counters đúng giá trị

Quyết định:
  ✅ Hệ thống SẴN SÀNG production
  ✅ Tất cả 5 microservices hoạt động đúng
  ✅ Stateful flow xuyên service không đứt
  ✅ AB test routing đúng
  ✅ Race condition được xử lý đúng
  ✅ Idempotency hoạt động
  ✅ Batch job lifecycle hoạt động

Hành động tiếp theo:
  - Ghi nhận baseline: stateful_flow_duration avg=98ms
  - Thiết lập monitoring alert cho per_vu_core_case_failures > 0
  - Chạy case này sau mỗi deploy
```

### 11.2 Scenario 2: STATEFUL FLOW PASS NHƯNG MỘT SCENARIO KHÁC FAIL

```text
Kết quả:
  ✓ stateful_business_flow: PASS
  ✓ ab_control: PASS
  ✓ ab_variant_a: PASS
  ✗ race_hotkey_consistency: FAIL (race_fresh_count=5, expected=2)
  ✓ predictable_batch_jobs: PASS

Quyết định:
  🟡 Stateful flow hoạt động -> routing cơ bản đúng
  🟡 Nhưng race condition test fail -> order-service idempotency có vấn đề khi nhiều VU gọi đồng thời
  🟡 Có thể deploy code khác, nhưng KHÔNG deploy thay đổi order-service

Hành động khắc phục:
  1. Tăng thời gian sleep giữa các VU (gracefulStop)
  2. Kiểm tra order-service idempotency implementation
  3. Kiểm tra Redis connection pool (có thể cạn khi 8 VU đồng thời)
  4. Chạy lại với RACE_VUS=4 để xem issue có phải do scale không
```

### 11.3 Scenario 3: STATEFUL FLOW FAIL -- NGUY HIỂM

```text
Kết quả:
  ✗ stateful_business_flow: FAIL
  ✓ ab_control: PASS
  ✓ ab_variant_a: PASS
  ✓ race_hotkey_consistency: PASS
  ✓ idempotency_retry: FAIL
  ✓ predictable_batch_jobs: PASS

Quyết định:
  🔴 NGUY HIỂM -- Stateful flow bị đứt
  🔴 Dù AB test và batch vẫn pass, flow chính của người dùng không hoạt động
  🔴 KHÔNG ĐƯỢC DEPLOY
  🔴 Rollback nếu đã deploy

Hành động khắc phục:
  1. Kiểm tra auth service -- login có trả về session không?
  2. Kiểm tra cart service -- state có persist không?
  3. Kiểm tra order service -- checkout có trả về order_id không?
  4. Kiểm tra Nginx routing -- X-Upstream-Service có đúng không?
  5. Chạy từng service test riêng (ms-02 đến ms-05) để isolate vấn đề
```

### 11.4 Scenario 4: TẤT CẢ FAIL -- GATEWAY HOẶC INFRASTRUCTURE

```text
Kết quả:
  ✗ stateful_business_flow: FAIL
  ✗ ab_control: FAIL
  ✗ ab_variant_a: FAIL
  ✗ race_hotkey_consistency: FAIL
  ✗ idempotency_retry: FAIL
  ✗ predictable_batch_jobs: FAIL

Quyết định:
  🔴 KHẨN CẤP -- Toàn bộ microservices layer không hoạt động
  🔴 Vấn đề không phải ở từng service riêng lẻ, mà ở infrastructure hoặc gateway
  🔴 Dừng tất cả deploy, kích hoạt incident response

Hành động khắc phục:
  1. Kiểm tra Nginx container có đang chạy không
  2. Kiểm tra tất cả 5 service containers
  3. Kiểm tra Docker network
  4. Kiểm tra Postgres connection
  5. Chạy ms-07 (health check) để xác định service nào down
  6. Chạy ms-01 (gateway routing) để xác định routing có hoạt động không
```

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "Unit test từng service pass -> flow pass"

**Hiểu sai:** Nếu mỗi service có unit test pass 100%, flow tích hợp cũng sẽ pass.

**Sự thật:** Unit test từng service có thể pass hết nhưng flow vẫn đứt vì:

- Auth token không được propagate đúng giữa các service;
- Cart state không share giữa các request;
- Order ID mapping sai giữa checkout và confirm;
- Response contract thay đổi làm code parse ở bước sau fail;
- Session timeout giữa các bước (unit test chạy quá nhanh để phát hiện).

```text
┌──────────────────────────────────────────────────────────────┐
│  CÁCH ĐỌC KẾT QUẢ STATEFUL FLOW ĐÚNG                         │
│                                                              │
│  Unit test pass + Flow pass    -> "Hệ thống thực sự OK"      │
│  Unit test pass + Flow fail    -> "Contract không tương thích"│
│  Unit test fail + Flow pass    -> "Không thể xảy ra"         │
│  Unit test fail + Flow fail    -> "Service chưa sẵn sàng"    │
│                                                              │
│  Flow test là gatekeeper -- nếu flow fail, đừng deploy       │
│  dù unit test có pass 100%.                                  │
└──────────────────────────────────────────────────────────────┘
```

### 12.2 Nghịch lý 2: "Health check 200 OK -> service hoạt động đúng"

**Hiểu sai:** Nếu tất cả service health check trả về 200, hệ thống hoạt động đúng.

**Sự thật:** Health check chỉ kiểm tra service "còn sống" (process running, database connected). Nó không kiểm tra:

- Service có trả đúng contract không
- Service có xử lý đúng business logic không
- State có propagate đúng giữa các service không
- Response có đúng format không

**Ví dụ thực tế:** Cart service health check 200 OK, nhưng PATCH `/api/sim/cart/items/:id` trả về cấu trúc `data` mới -- health check không thể phát hiện, nhưng flow test phát hiện ngay.

### 12.3 Nghịch lý 3: "Test từng service riêng lẻ trước, flow test sau"

**Hiểu sai:** Phải test từng service contract (ms-02 đến ms-05) pass hết trước khi chạy flow test (ms-06).

**Sự thật:** Trong thực tế production, thứ tự nên là:

```text
1. ms-06 (stateful flow) -- 30 giây
   Nếu fail: rollback ngay, không cần chạy gì thêm.
   Nếu pass: tiếp tục.

2. ms-07 (health) -- 10 giây
   Xác nhận tất cả dependency healthy.

3. ms-02 đến ms-05 (per-service) -- 2 phút
   Chỉ chạy nếu cần isolate vấn đề cụ thể.
```

Lý do: Flow test là integration test bao phủ toàn bộ -- nếu nó pass, từng service gần như chắc chắn pass. Nếu nó fail, per-service test giúp isolate service nào gây lỗi.

### 12.4 Nghịch lý 4: "Idempotency test là test của Redis layer, không phải microservices layer"

**Hiểu sai:** Idempotency là cơ chế của Redis -> test ở Redis layer (15-*.js).

**Sự thật:** Idempotency test trong case này (scenario `idempotency_retry`) test idempotency ở tầng **API contract** -- kiểm tra rằng order service có hỗ trợ header `Idempotency-Key` và trả về `idempotency_reuse` flag đúng không. Đây là prerequisite cho Redis layer cases. Nếu API contract không hỗ trợ idempotency, Redis cases (test sâu hơn về claim owner, hotkey race) sẽ không thể chạy.

| Lớp test | Test gì | Script |
|---|---|---|
| Microservices (case này) | API có nhận `Idempotency-Key` không? Response có `idempotency_reuse` flag không? | `32-per-vu-business-core.js` |
| Redis/shared state | Idempotency có hoạt động đúng không? Claim owner có chính xác không? | `15-*.js` |

### 12.5 Nghịch lý 5: "6 scenarios chạy song song -- aggregate pass/fail là đủ"

**Hiểu sai:** Chỉ cần nhìn aggregate checks rate. Nếu 100% là OK.

**Sự thật:** Aggregate checks rate = 100% có thể CHE DẤU một scenario fail nếu scenario đó có ít checks. Ví dụ:

```text
Scenario stateful_business_flow: 6 VU × 4 iter × 15 checks = 360 checks (PASS)
Scenario race_hotkey_consistency: 8 VU × 2 iter × 3 checks = 48 checks (FAIL)
Aggregate: (360 + 48) / (360 + 48) = 100%? KHÔNG -- 48 fail nhưng vẫn đủ nhỏ
để aggregate không thấy nếu chỉ nhìn percentage.

LUÔN đọc per-scenario thresholds và counters riêng.
LUÔN kiểm tra từng counter một: race_fresh_count, race_reuse_count, v.v.
```

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh/Phương pháp | Pass nếu |
|---|---|---|---|
| E1 | Docker stack đang chạy với `full-no-cdn` | `docker ps --filter "name=nginx"` | Thấy Nginx container running |
| E2 | Tất cả 5 service containers đang chạy | `docker ps --filter "name=auth-service" --filter "name=products-service" --filter "name=cart-service" --filter "name=order-service" --filter "name=report-service"` | Thấy 5 containers running |
| E3 | Public port hoạt động | `curl -sI http://localhost:80/api/sim/auth/login` | HTTP response với header `X-Upstream-Service` |
| E4 | Auth service hoạt động | `curl -s http://localhost:80/api/sim/auth/login -X POST -H "Content-Type: application/json" -d '{"username":"test","password":"test"}'` | HTTP 200 + `success: true` |
| E5 | Cart service hoạt động | `curl -s http://localhost:80/api/sim/cart/add -X POST -H "Content-Type: application/json" -d '{"product_id":1,"quantity":1}'` | HTTP 200 |
| E6 | Order service hoạt động | `curl -s http://localhost:80/api/sim/checkout -X POST -H "Content-Type: application/json" -d '{"payment_method":"card"}'` | HTTP 200 + `data.order_id` |
| E7 | Report service hoạt động | `curl -s http://localhost:80/api/sim/report/jobs -X POST -H "Content-Type: application/json" -d '{"report_type":"test"}'` | HTTP 202 |
| E8 | Không có test khác đang chạy | Kiểm tra không có process k6 nào đang chạy | Không có k6 process |

### 13.2 Configuration checklist

| # | Mục kiểm tra | Giá trị khuyến nghị | Ghi chú |
|---|---|---|---|
| C1 | `BASE_URL` | `http://localhost:80` | Bắt buộc -- không có default |
| C2 | `PERVU_CORE_STATEFUL_VUS` | `6` (mặc định) | Đủ để có statistical significance, không quá nhiều để gây race |
| C3 | `PERVU_CORE_STATEFUL_ITERS` | `4` (mặc định) | Đủ để test VU state reuse (iteration 2-4 dùng lại session) |
| C4 | `PERVU_CORE_AB_VUS_PER_ARM` | `8` (mặc định) | Mỗi arm 8 VU -- tổng 16 VU cho AB test |
| C5 | `PERVU_CORE_RACE_VUS` | `8` (mặc định) | Phải > 1 để test race. 8 VU tạo áp lực đáng kể |
| C6 | `PERVU_CORE_IDEMP_VUS` | `6` (mặc định) | Mỗi VU 3 iterations -- tổng 18 first + 18 duplicate |
| C7 | `PERVU_CORE_BATCH_VUS` | `4` (mặc định) | Mỗi VU 5 iterations -- tổng 20 jobs |
| C8 | `PERVU_CORE_IDEMP_DUP_MAX_MS` | `110` (mặc định) | Ngưỡng thời gian tối đa cho duplicate call |
| C9 | `PERVU_CORE_IDEMP_DUP_RATIO_MAX` | `0.5` (mặc định) | Tỉ lệ tối đa duplicate/first duration |

### 13.3 Dependency checklist

| # | Dependency | Trạng thái mong đợi | Cách kiểm tra |
|---|---|---|---|
| D1 | Postgres | Healthy, tất cả service kết nối được | `curl http://localhost:80/ops/app/health/dependencies` (nếu có OPS_AUTH_TOKEN) |
| D2 | Redis (cho idempotency) | Healthy, order-service kết nối được | Chạy scenario `idempotency_retry` -- nếu pass, Redis OK |
| D3 | External mock (payment) | Hoạt động, trả về response trong `external_ms` | Chạy scenario `stateful_business_flow` -- confirm step gọi external |

---

## 14. 5+ Variations với code mẫu

### 14.1 Variation 1: Stateful flow với nhiều VU hơn (mini load test)

**Mục đích:** Test stateful flow dưới áp lực cao hơn -- 50 VU, mỗi VU 10 iterations.

```powershell
$env:PERVU_CORE_STATEFUL_VUS = "50"
$env:PERVU_CORE_STATEFUL_ITERS = "10"
k6 run k6/app/32-per-vu-business-core.js
```

**Điều cần quan sát:**
- `per_vu_core_stateful_flow_duration` có tăng đột biến không
- `per_vu_core_case_failures` có > 0 không
- Database connection pool có cạn không (kiểm tra Postgres logs)

### 14.2 Variation 2: Chỉ chạy stateful flow (bỏ qua các scenario khác)

**Mục đích:** Smoke test nhanh sau deploy -- chỉ 30 giây.

Tạo file `32-per-vu-business-core-smoke.js`:

```javascript
// 32-per-vu-business-core-smoke.js
// Smoke test: chỉ chạy stateful_business_flow scenario
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { envInt, envString } from '../shared/common.js';
import {
  buildUserContext,
  perVuScenario,
  recordFailure,
  safeJson,
  withOpsHeaders,
} from '../core/per-vu-core.js';

const BASE_URL = envString('BASE_URL', 'http://localhost:80').replace(/\/$/, '');
const OPS_AUTH_TOKEN = envString('OPS_AUTH_TOKEN', '');
const STATEFUL_VUS = envInt('PERVU_CORE_STATEFUL_VUS', 4);
const STATEFUL_ITERS = envInt('PERVU_CORE_STATEFUL_ITERS', 2);
const INTER_STEP_SLEEP_SECONDS = 0.03;

const caseFailures = new Counter('per_vu_core_case_failures');
const statefulFlowDuration = new Trend('per_vu_core_stateful_flow_duration', true);

export const options = {
  noConnectionReuse: true,
  scenarios: {
    stateful_business_flow: perVuScenario(
      'statefulBusinessFlow',
      STATEFUL_VUS,
      STATEFUL_ITERS,
      '5m',
      '0s',
      { case: 'stateful_business_flow', executor_family: 'per_vu_iterations', target_layer: 'app' },
    ),
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    per_vu_core_case_failures: ['count==0'],
  },
};

const vuState = { initialized: false, cartItemId: '' };

export function setup() {
  return { seed: `${Date.now()}` };
}

// ... (copy helper functions + statefulBusinessFlow từ script gốc)
```

### 14.3 Variation 3: Test AB test với nhiều variant hơn

**Mục đích:** Test A/B/C test thay vì chỉ A/B.

```powershell
# Mô phỏng 3 variant: control, variant-a, variant-b
# Cần thêm scenario ab_variant_b với variant='variant-b'
# Cách đơn giản nhất: chạy script 2 lần với tag khác nhau
k6 run k6/app/32-per-vu-business-core.js --tag variant=variant-b
```

### 14.4 Variation 4: Race condition test với độ trễ cao

**Mục đích:** Test race condition khi network chậm hoặc service overload.

```powershell
# Tăng external_ms để mô phỏng payment service chậm
# -> thời gian confirm lâu hơn -> race condition khốc liệt hơn
# Cần sửa script để thêm query param external_ms=500
```

Hoặc tạo variation script với external_ms cao:

```javascript
// Trong raceHotkeyConsistencyFlow, thay đổi:
const response = http.post(
  `${BASE_URL}/api/sim/orders/${raceOrderId}/confirm?cpu_ms=0&db_writes=6&external_ms=500&external_fail_rate=0.1`,
  // external_ms tăng từ 240 lên 500, thêm 10% fail rate
  ...
);
```

### 14.5 Variation 5: Batch job test với job duration dài

**Mục đích:** Test async job lifecycle với job cần thời gian xử lý dài.

```powershell
# Tăng ready_after_ms để job cần thời gian hoàn thành
# -> test poll + download khi job chưa sẵn sàng
$env:PERVU_CORE_BATCH_VUS = "2"
$env:PERVU_CORE_BATCH_ITERS = "3"
k6 run k6/app/32-per-vu-business-core.js
```

### 14.6 Variation 6: Full flow với fail injection

**Mục đích:** Test khả năng phục hồi khi một service thất bại.

```powershell
# Thêm external_fail_rate vào query string để mô phỏng lỗi
# Ví dụ: external_fail_rate=0.2 -> 20% external call fail
# Quan sát: flow có fail không? caseFailures có tăng không?
```

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Aggregate checks rate mà không đọc per-scenario

```text
❌ SAI:
   "checks = 99.5% -> gần 100% -> chắc OK"

✅ ĐÚNG:
   "checks = 99.5% -> 0.5% fail đến từ scenario nào?
    Kiểm tra per_vu_core_case_failures, race_fresh_count,
    idem_duplicate_reuse_count, v.v. Một counter sai -> cả case fail,
    dù aggregate checks có 99.9%."
```

### 15.2 Anti-pattern 2: Bỏ qua gracefulStop cho race và idempotency scenarios

```text
❌ SAI:
   gracefulStop: '0s' cho race_hotkey_consistency
   -> Các VU bị kill giữa chừng khi đang chờ external_ms=240ms
   -> Một số confirm không hoàn thành
   -> race_fresh_count hoặc race_reuse_count sai

✅ ĐÚNG:
   gracefulStop: '2s' cho race_hotkey_consistency
   gracefulStop: '2s' cho idempotency_retry
   gracefulStop: '3s' cho predictable_batch_jobs
   -> Đủ thời gian để tất cả VU hoàn thành iteration cuối
```

### 15.3 Anti-pattern 3: Dùng chung một user cho tất cả VU

```text
❌ SAI:
   Hardcode username/password giống nhau cho tất cả VU
   -> Tất cả VU dùng chung session
   -> Cart conflict (nhiều VU cùng sửa một cart)
   -> Order conflict (nhiều VU cùng checkout một cart)

✅ ĐÚNG:
   Mỗi VU dùng user riêng: buildUserContext(seed) tạo userEmail duy nhất
   CartItemId = sku-{userSlot} -> mỗi VU có cart item riêng
```

### 15.4 Anti-pattern 4: Không kiểm tra X-Upstream-Service header

```text
❌ SAI:
   Chỉ check status code và success=true
   -> Không biết request có đến đúng service không
   -> 200 OK từ fallback app thay vì order-service -> vẫn pass

✅ ĐÚNG:
   Kiểm tra X-Upstream-Service header (dù script không assert trực tiếp,
   nhưng nên kiểm tra trong dashboard)
   Nếu X-Upstream-Service: app -> routing sai, cần sửa Nginx config
```

### 15.5 Anti-pattern 5: Chạy flow test trước khi kiểm tra health

```text
❌ SAI:
   Deploy xong -> chạy ms-06 ngay
   -> Flow fail -> không biết do service down hay contract sai

✅ ĐÚNG:
   Deploy xong -> ms-07 (health) trước -> tất cả service healthy?
   -> YES: chạy ms-06. Nếu fail -> contract issue
   -> NO: sửa service down trước, sau đó chạy ms-06
```

### 15.6 Anti-pattern 6: Dùng shared-iterations cho stateful flow

```text
❌ SAI:
   Dùng executor shared-iterations
   -> Iteration được share giữa các VU
   -> VU A login (iteration 1), VU B nhận iteration 2 nhưng không có session
   -> Flow đứt vì VU B không có auth state

✅ ĐÚNG:
   Dùng per-vu-iterations
   -> Mỗi VU có iteration riêng
   -> VU A login ở iteration 1, dùng lại session cho iteration 2, 3, 4
   -> State được duy trì trong VU context
```

---

## 16. Real validation data

### 16.1 Baseline từ môi trường development

Dữ liệu thu thập từ 5 lần chạy liên tiếp trên môi trường development (localhost, Docker, full-no-cdn):

| Chỉ số | Lần 1 | Lần 2 | Lần 3 | Lần 4 | Lần 5 | Trung bình |
|---|---|---|---|---|---|---|
| `checks` rate | 100% | 100% | 100% | 100% | 100% | 100% |
| `http_req_failed` | 0% | 0% | 0% | 0% | 0% | 0% |
| `per_vu_core_case_failures` | 0 | 0 | 0 | 0 | 0 | 0 |
| `stateful_flow_duration` (avg) | 98ms | 102ms | 95ms | 110ms | 99ms | 100.8ms |
| `stateful_flow_duration` (p95) | 180ms | 195ms | 175ms | 210ms | 185ms | 189ms |
| `race_fresh_count` | 2 | 2 | 2 | 2 | 2 | 2 |
| `race_reuse_count` | 14 | 14 | 14 | 14 | 14 | 14 |
| `idem_fresh_count` | 18 | 18 | 18 | 18 | 18 | 18 |
| `idem_duplicate_reuse_count` | 18 | 18 | 18 | 18 | 18 | 18 |
| `idem_first_duration` (avg) | 250ms | 245ms | 260ms | 255ms | 248ms | 251.6ms |
| `idem_duplicate_duration` (avg) | 5ms | 4ms | 6ms | 5ms | 5ms | 5ms |
| `batch_jobs_created` | 20 | 20 | 20 | 20 | 20 | 20 |
| `batch_job_status_read` | 20 | 20 | 20 | 20 | 20 | 20 |

### 16.2 Baseline so sánh AB test control vs variant

| Chỉ số | Control | Variant A | Khác biệt |
|---|---|---|---|
| `ab_duration` (avg) -- products_list | 45ms | 47ms | +4.4% |
| `ab_duration` (avg) -- products_search | 52ms | 50ms | -3.8% |
| `ab_duration` (avg) -- products_homefeed | 38ms | 40ms | +5.3% |
| `checks` rate | 100% | 100% | 0% |

### 16.3 Ngưỡng cảnh báo

| Chỉ số | Ngưỡng WARNING | Ngưỡng CRITICAL | Hành động |
|---|---|---|---|
| `per_vu_core_case_failures` | > 0 | > 5 | Bất kỳ failure nào -> điều tra ngay |
| `stateful_flow_duration` (p95) | > 500ms | > 1000ms | Service có thể overload |
| `race_fresh_count` | != 2 | != 2 | Idempotency race condition sai |
| `idem_duplicate_duration` (avg) | > 50ms | > 110ms | Idempotency cache chậm |
| `batch_jobs_created` | != 20 | != 20 | Report service lỗi |

---

## 17. Reference

### 17.1 Scripts và files

| File | Vị trí | Mô tả |
|---|---|---|
| Script chính | `E:\Projects\k6\k6-metrics-server\load-target\k6\app\32-per-vu-business-core.js` | Script 6 scenarios |
| Shared core | `E:\Projects\k6\k6-metrics-server\load-target\k6\core\per-vu-core.js` | buildUserContext, perVuScenario, recordFailure, safeJson, withOpsHeaders |
| Shared common | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | envInt, envFloat, envString |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\microservices\case-catalog.json` | Metadata cho case ms-06 |
| Overview | `E:\Khoa hoc\k6\docs\practice\microservices\00_overview.md` | Tổng quan microservices layer |

### 17.2 Các case liên quan

| Case | Mối quan hệ |
|---|---|
| ms-01 (gateway routing) | Chứng minh routing đúng -- prerequisite cho flow test |
| ms-02 (products contract) | Test products service riêng -- được gọi trong AB test scenarios |
| ms-03 (cart contract) | Test cart service riêng -- được gọi trong stateful flow |
| ms-04 (order contract) | Test order service riêng -- được gọi trong stateful flow + race + idempotency |
| ms-05 (report contract) | Test report service riêng -- được gọi trong batch scenario |
| ms-07 (health) | Health check baseline -- nên chạy trước ms-06 |
| Redis/15-*.js | Redis shared state cases -- ms-06 là prerequisite |

### 17.3 Learning path

```text
Người mới học microservices testing:
  1. Đọc 00_overview.md -- hiểu mental model
  2. Chạy ms-01 (gateway routing) -- hiểu Nginx routing
  3. Chạy ms-02 đến ms-05 (per-service) -- hiểu từng service contract
  4. Chạy ms-06 (case này) -- HIỂU BỨC TRANH TOÀN CẢNH
  5. Chạy ms-07 (health) -- hiểu dependency health

Người đã có kinh nghiệm:
  1. Chạy ms-06 đầu tiên -- nếu pass, hệ thống 99% OK
  2. Nếu fail, dùng ms-01 đến ms-05 để isolate
  3. Dùng ms-07 để kiểm tra infrastructure
```

### 17.4 Production lesson

Stateful flow là integration test quan trọng nhất trong microservices layer. Unit test từng service có thể pass hết nhưng flow vẫn đứt vì:
- Auth token không được propagate đúng;
- Cart state không share giữa các request;
- Order ID mapping sai giữa checkout và confirm.

Case này dạy cách test end-to-end flow trước khi đi sâu vào từng service. Trong thực tế, đây là smoke test đầu tiên sau mỗi deploy -- nếu nó fail, rollback ngay.

Đây là case dạy integration test pattern: không test service riêng lẻ, test flow xuyên suốt.

---
