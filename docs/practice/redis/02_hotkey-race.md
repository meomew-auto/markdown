# redis-02 — Hot-key idempotency race

## 1. Business scenario

Một payment/order retry storm xảy ra: nhiều client gửi cùng order confirm key hoặc cùng webhook event id gần như đồng thời. Đây là tình huống hay gặp khi mobile app retry, payment provider retry, hoặc network timeout làm client không biết request trước đã thành công chưa.

```text
8 VUs cùng POST một Idempotency-Key
8 VUs cùng POST một webhook event_id
```

Nếu Redis lock/idempotency không atomic, nhiều request có thể cùng fresh execution và tạo duplicate side effect.

## 2. Capability được test

Case này chứng minh hot-key race được collapse đúng:

```text
confirm: exactly 1 fresh + HOTKEY_VUS-1 reuse
webhook: exactly 1 fresh + HOTKEY_VUS-1 duplicate
```

Không cần tất cả request nhanh; cần tất cả request đúng side-effect semantics.

## 3. Script và executor

```text
Script: ../app/16-order-service-shared-state-hotkey-race.js
Executor: per-vu-iterations
Scenarios:
  confirm_hotkey: HOTKEY_VUS VUs, 1 iteration
  webhook_hotkey: HOTKEY_VUS VUs, 1 iteration, startTime=4s
Default HOTKEY_VUS: 8
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

Executor dùng nhiều VU để tạo race thật trên cùng key.

## 4. Flow chính

```text
confirm_hotkey:
  POST /api/sim/orders/{orderId}/confirm
  Header: Idempotency-Key = same key for all VUs

webhook_hotkey:
  POST /api/sim/orders/webhooks/payment
  Body/header: same event_id for all VUs
```

Sau webhook, script còn đọc status để xác nhận payment state là `paid` và source là `webhook`.

## 5. Evidence phải đọc

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

## 6. Fresh vs reuse khác nhau thế nào?

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

## 7. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| `confirm_fresh_count > 1` | Race bug: nhiều request cùng thực hiện side effect confirm. |
| `confirm_reuse_count < HOTKEY_VUS-1` | Dedupe/replay thiếu request. |
| `webhook_fresh_count > 1` | Payment webhook có thể apply nhiều lần. |
| `webhook_duplicate_count < HOTKEY_VUS-1` | Webhook dedupe không ổn định. |
| Status 200 toàn bộ nhưng counter sai | Đây vẫn là fail; status không chứng minh side effect. |
| `http_req_failed > 0` | Không expected ở case này; cần debug app/Redis/LB. |

## 8. Dashboard/chart reading

Chart nên đọc:

- request burst ở hai phase `confirm_hotkey` và `webhook_hotkey`;
- fresh duration cao hơn reuse/duplicate duration;
- checks rate 100%;
- custom counters fresh/reuse/duplicate.

Không dùng RPS cao/thấp để pass/fail. Mục tiêu là exact count.

## 9. Production lesson

Hot-key race là bài test quan trọng nhất cho Redis/shared state. Hệ thống đúng không phải vì trả 200 cho mọi retry, mà vì chỉ tạo side effect một lần. Đây là khác biệt giữa API availability và business correctness.