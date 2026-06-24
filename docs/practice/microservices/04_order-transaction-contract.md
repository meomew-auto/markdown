# ms-04 — Order service: transaction API contract

## 1. Business scenario

Daily reconciliation: replay tất cả order trong ngày — checkout, confirm với idempotency key, và payment webhook. Order service là transactional core của toàn bộ stack — nó owns the money path.

```text
Reconciliation job: checkout → confirm (có Idempotency-Key) → read status
```

## 2. Capability được test

Case này chứng minh:

- `POST /api/sim/checkout` tạo order và trả về `order_id`;
- `POST /api/sim/orders/:id/confirm` với `Idempotency-Key` header xác nhận order;
- `GET /api/sim/orders/:id` trả về order state đầy đủ;
- `X-Upstream-Service: order-service` và `X-Upstream-Addr` hiện diện;
- Idempotency replay trả về cùng kết quả.

Đây là prerequisite cho Redis shared-state cases (15-*.js). Nếu contract này sai, Redis cases không thể pass.

## 3. Script và executor

```text
Script: ../shared-iterations/si-02-order-reconciliation.js
Executor: shared-iterations
Default VUs: 8
Default jobs: 120
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

## 4. Env knobs

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_02_VUS = "8"
$env:SI_02_JOBS = "120"
$env:SI_02_SLEEP_SECONDS = "0"
```

## 5. Flow chính

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

## 6. Evidence phải đọc

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

## 7. Order service — full API surface

```text
POST /api/sim/checkout                  — tạo order từ cart
GET  /api/sim/orders/:id                — đọc order state
POST /api/sim/orders/:id/confirm        — xác nhận order (idempotent)
POST /api/sim/orders/webhooks/payment   — payment webhook (idempotent)
```

Order service khác biệt so với các service khác:

- **Có idempotency**: confirm và webhook payment dùng `Idempotency-Key` / `event_id` để chống duplicate;
- **Có external dependency**: gọi payment-mock cho checkout và confirm;
- **Có Redis shared state**: idempotency state, claim owner, hot-key protection;
- **Có X-Upstream-Addr header**: để biết instance nào xử lý request (quan trọng cho distributed state proof).

## 8. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| Checkout không trả `order_id` | Contract violation — không thể continue flow |
| Confirm không nhận `Idempotency-Key` | Header bị drop hoặc service không parse |
| Status trả về sai `order_id` | State corruption |
| `X-Upstream-Service` không phải `order-service` | Routing sai |
| `external_ms > 0` nhưng response vẫn 200 | Expected — external call thành công |
| Thiếu `X-Upstream-Addr` | Nginx config thiếu `add_header X-Upstream-Addr` |

## 9. Dashboard/chart reading

Chart nên đọc:

- `shared_jobs_total` = 120, `shared_jobs_failed` = 0;
- checks rate 100%;
- `X-Upstream-Service` = `order-service` 100%;
- Latency: checkout có external_ms=30 nên chậm hơn confirm và status;
- `X-Upstream-Addr` values — cho biết có bao nhiêu order-service instance đang chạy.

## 10. Production lesson

Order service là nơi mọi thứ trở nên nghiêm túc. Không như products (read, cacheable) hay cart (temporary state), order service xử lý tiền — mọi duplicate hay sai state đều có hậu quả tài chính. Contract test ở layer này là minimum bar: nếu checkout/confirm/status không đúng contract, đừng deploy. Redis cases (layer tiếp theo) sẽ test các edge case của idempotency và race condition mà contract test này không cover được.
