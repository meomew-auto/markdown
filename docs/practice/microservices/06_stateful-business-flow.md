# ms-06 — Cross-service stateful business flow

## 1. Business scenario

Một user journey hoàn chỉnh: login → check session → browse products → add to cart → update cart → checkout → confirm order → check order status. Mỗi bước phụ thuộc vào state từ bước trước. Flow này span qua tất cả 5 microservices.

```text
auth-service → cart-service → products-service → order-service → order-service → order-service
   (login)       (cart add)     (browse)         (checkout)     (confirm)      (status)
```

Nếu bất kỳ service nào sai contract, toàn bộ flow đứt.

## 2. Capability được test

Case này chứng minh:

- Auth tạo session dùng được cho các request sau;
- Cart state persist từ add đến update;
- Checkout tạo order_id dùng được cho confirm và status;
- Order status preserve order_id suốt flow;
- `X-Upstream-Service` header thay đổi đúng theo từng bước;
- 6 scenarios (stateful flow, AB control, AB variant, race hotkey, idempotency retry, batch jobs) tất cả pass.

Đây là integration test của toàn bộ microservices layer.

## 3. Script và executor

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

## 4. Env knobs

```powershell
$env:BASE_URL = "http://localhost:80"
# Default config đủ — tất cả PERVU_CORE_* có default hợp lý
# Optional override:
$env:PERVU_CORE_STATEFUL_VUS = "6"
$env:PERVU_CORE_STATEFUL_ITERS = "4"
```

## 5. Flow chính (stateful scenario)

```text
Mỗi VU, mỗi iteration:

1. POST /api/sim/auth/login
   → login với username/password
   → Expect: 200, success=true
   → State: session được thiết lập

2. GET /api/sim/auth/me
   → verify session còn valid
   → Expect: 200, success=true

3. POST /api/sim/cart/add
   → thêm sản phẩm vào cart
   → Expect: 200, success=true

4. PATCH /api/sim/cart/items/{item_id}
   → cập nhật quantity
   → Expect: 200, success=true

5. POST /api/sim/checkout
   → tạo order từ cart
   → Expect: 200, success=true, data.order_id

6. POST /api/sim/orders/{order_id}/confirm
   → Header: Idempotency-Key
   → Expect: 200, success=true

7. GET /api/sim/orders/{order_id}
   → đọc order state
   → Expect: 200, data.order_id khớp checkout
```

## 6. Evidence phải đọc

| Evidence | Expected |
| --- | --- |
| `checks` | 100% |
| `http_req_failed` | 0.00% |
| `per_vu_core_case_failures` | 0 |
| `X-Upstream-Service` sequence | auth-service → auth-service → cart-service → cart-service → order-service → order-service → order-service |
| Login → Me | Session valid, user info đúng |
| Cart add → Cart update | State persist, item_id不变的 |
| Checkout → Confirm → Status | order_id preserved |
| All 6 scenarios | checks 100% |

## 7. 6 scenarios trong script

Script này không chỉ có 1 scenario — nó có 6, mỗi cái test một khía cạnh:

| Scenario | Dịch vụ | Mục đích |
| --- | --- | --- |
| `stateful_business_flow` | auth + cart + order | Flow chính xuyên service |
| `ab_control` | products | AB test control arm: list + search + homefeed |
| `ab_variant_a` | products | AB test variant arm với header khác |
| `race_hotkey_consistency` | order | Nhiều VU confirm cùng order — test race |
| `idempotency_retry` | order | Confirm 2 lần với cùng key — test idempotency |
| `predictable_batch_jobs` | report | Create → list → status → download |

## 8. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| Login success nhưng me fail | Session không propagate |
| Cart add success nhưng update fail | State không persist |
| Checkout success nhưng confirm fail | Order state machine sai |
| `order_id` khác nhau giữa checkout và status | State corruption |
| `X-Upstream-Service` sai ở một bước | Route sai — request đến wrong service |
| Một scenario pass nhưng scenario khác fail | Vấn đề không phải toàn bộ layer, mà là scenario-specific |

## 9. Dashboard/chart reading

Chart nên đọc:

- checks rate 100% cho toàn bộ 6 scenarios;
- `per_vu_core_case_failures` = 0;
- `per_vu_core_stateful_flow_duration` trend — toàn bộ flow mất bao lâu;
- `per_vu_core_race_fresh_count` vs `per_vu_core_race_reuse_count`;
- `per_vu_core_idem_fresh_count` vs `per_vu_core_idem_duplicate_reuse_count`;
- `per_vu_core_batch_jobs_created` vs `per_vu_core_batch_job_status_read`.

Đây là case nhiều counters nhất — mỗi scenario có counters riêng. Đọc theo scenario, không aggregate.

## 10. Production lesson

Stateful flow là integration test quan trọng nhất trong microservices layer. Unit test từng service có thể pass hết nhưng flow vẫn đứt vì:
- Auth token không được propagate đúng;
- Cart state không share giữa các request;
- Order ID mapping sai giữa checkout và confirm.

Case này dạy cách test end-to-end flow trước khi đi sâu vào từng service. Trong thực tế, đây là smoke test đầu tiên sau mỗi deploy — nếu nó fail, rollback ngay.
