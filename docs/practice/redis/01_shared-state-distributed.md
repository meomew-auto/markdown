# redis-01 — Shared state across order-service instances

## 1. Business scenario

Một user confirm order, payment provider gửi webhook, rồi UI/API đọc lại order status. Trong production, các request này có thể đi qua nhiều `order-service` instances khác nhau vì LB phân phối upstream.

```text
confirm order -> duplicate confirm retry -> payment webhook -> duplicate webhook -> stale webhook -> status read
```

Nếu state chỉ nằm trong memory từng instance, request đổi upstream sẽ làm idempotency replay hoặc webhook dedupe bị sai.

## 2. Capability được test

Case này chứng minh Redis/shared state là centralized:

- cùng `Idempotency-Key` replay kết quả confirm đầu tiên;
- cùng webhook `event_id` chỉ apply một lần;
- stale payment event không ghi đè trạng thái mới hơn;
- status read thấy payment state do webhook ghi;
- retry qua upstream khác vẫn giữ state đúng.

## 3. Script và executor

```text
Script: ../app/15-order-service-shared-state-distributed.js
Executor: per-vu-iterations implicit via options vus=1, iterations=1
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

Đây là deterministic sequence, không phải load test. Một VU đủ vì case cần kiểm chuỗi phụ thuộc state.

## 4. Flow chính

```text
1. POST /api/sim/orders/{orderId}/confirm với Idempotency-Key mới
   -> expected fresh execution

2. POST lại cùng orderId + Idempotency-Key
   -> expected idempotency_reuse=true, không external/db work lại

3. POST /api/sim/orders/webhooks/payment với event_id mới
   -> expected payment_status=paid, webhook_duplicate=false

4. POST lại cùng event_id
   -> expected webhook_duplicate=true, không db write lại

5. POST stale payment.failed event
   -> expected payment_status vẫn paid, regression ignored

6. GET /api/sim/orders/{orderId}
   -> expected status thấy payment state từ webhook
```

## 5. Evidence phải đọc

| Evidence | Expected |
| --- | --- |
| `checks` | `rate==1` |
| `order_service_shared_state_distributed_check_failures` | `count==0` |
| `X-Upstream-Service` | `order-service` |
| `X-Upstream-Addr` | present; duplicate/status attempts cố gắng thấy upstream khác |
| `idempotency_reuse` | first false, duplicate true |
| `webhook_duplicate` | first false, duplicate true |
| `payment_regression_ignored` | true cho stale event |
| `payment_state_reused` | true cho stale event |
| `payment_state_source` | `webhook` |

## 6. Custom metrics quan trọng

```text
order_service_shared_state_confirm_first_duration
order_service_shared_state_confirm_duplicate_duration
order_service_shared_state_webhook_applied_duration
order_service_shared_state_webhook_duplicate_duration
order_service_shared_state_webhook_stale_duration
order_service_shared_state_status_duration
order_service_shared_state_distinct_upstream_attempts
order_service_shared_state_distributed_check_failures
```

Duration fresh thường cao hơn duplicate/reuse vì fresh path có DB/external work. Đây là expected.

## 7. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| Duplicate confirm không `idempotency_reuse=true` | Idempotency state không shared hoặc không atomic. |
| Duplicate webhook không `webhook_duplicate=true` | Webhook dedupe sai, có thể apply payment nhiều lần. |
| Stale failed event đổi `payment_status` từ paid sang failed | Payment state regression bug nghiêm trọng. |
| Status read không thấy webhook state | Shared state/status read không nhất quán. |
| Không thấy upstream khác sau nhiều attempts | Có thể LB chưa phân phối hoặc sample nhỏ; không tự kết luận Redis sai, nhưng evidence distributed yếu. |

## 8. Dashboard/chart reading

Chart hữu ích:

- latency theo stage: fresh confirm/webhook cao hơn duplicate/stale/status;
- checks rate 100%;
- timeline sequence theo `target_flow`;
- distinct upstream attempts để biết retry có đi qua nhiều instance hay không.

Không đọc aggregate p95 để kết luận. Fresh path có external delay nên p95 cao là bình thường.

## 9. Production lesson

Shared state distributed là nền của order/payment correctness. Nếu idempotency và webhook dedupe không sống ở Redis/shared store, LB distribution sẽ biến retry bình thường thành duplicate side effect.