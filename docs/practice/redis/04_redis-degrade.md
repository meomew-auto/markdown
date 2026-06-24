# redis-04 — Redis delay degradation

## 1. Business scenario

Redis nằm trên critical path của order idempotency, webhook dedupe và claim ownership. Khi Redis chậm, latency tăng là expected, nhưng correctness không được hỏng: không duplicate confirm, không duplicate webhook, không để profile degrade ảnh hưởng case sau.

```text
setup Redis delay -> hotkey confirm race -> hotkey webhook race -> reset Redis profile
```

## 2. Capability được test

Case này chứng minh Redis degrade được kiểm soát:

- control-plane set Redis profile delay thành công;
- under Redis delay, hotkey race vẫn exact: 1 fresh + N-1 reuse/duplicate;
- latency trends phản ánh Redis delay;
- teardown reset Redis profile thành công.

## 3. Script và executor

```text
Script: ../app/18-order-service-shared-state-redis-degrade.js
Executor: per-vu-iterations
Scenarios:
  confirm_hotkey_redis_degrade: HOTKEY_VUS VUs, 1 iteration
  webhook_hotkey_redis_degrade: HOTKEY_VUS VUs, 1 iteration, startTime=4s
Default HOTKEY_VUS: 6
Topology: full-no-cdn
BASE_URL: http://localhost:80
Control base: http://localhost:80
```

## 4. Token/control-plane requirement

Case này cần ops token khi `ORDER_SHARED_STATE_REDIS_CONTROL_MODE=http` vì gọi:

```text
POST /ops/order/redis/reset
PUT  /ops/order/redis/profile
GET  /ops/order/redis/profile
POST /ops/order/redis/reset   # teardown
```

Env:

```powershell
$env:ORDER_SHARED_STATE_REDIS_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_SHARED_STATE_REDIS_CONTROL_MODE = "http"
$env:ORDER_SHARED_STATE_REDIS_DELAY_MS = "80"
$env:ORDER_SHARED_STATE_REDIS_HOTKEY_VUS = "6"
$env:OPS_AUTH_TOKEN = "<ops-token>"
```

Không in token thật trong docs/report.

## 5. Flow chính

```text
setup:
  POST /ops/order/redis/reset
  PUT /ops/order/redis/profile { redis_delay_ms: 80, redis_fault_mode: none }
  GET /ops/order/redis/profile -> verify delay 80

runtime:
  HOTKEY_VUS cùng confirm một Idempotency-Key
  HOTKEY_VUS cùng gửi một webhook event_id

teardown:
  POST /ops/order/redis/reset
```

## 6. Evidence phải đọc

| Evidence | Expected default |
| --- | ---: |
| setup reset status | 200 |
| setup delay status | 200 |
| profile `redis_delay_ms` | 80 |
| profile `redis_fault_mode` | empty/none |
| `checks` | 100% |
| `http_req_failed` | 0.00% |
| `order_shared_state_redis_degrade_check_failures` | 0 |
| `order_shared_state_redis_confirm_fresh_count` | 1 |
| `order_shared_state_redis_confirm_reuse_count` | 5 nếu HOTKEY_VUS=6 |
| `order_shared_state_redis_webhook_fresh_count` | 1 |
| `order_shared_state_redis_webhook_duplicate_count` | 5 nếu HOTKEY_VUS=6 |
| teardown reset status | 200 |

## 7. Latency đọc thế nào?

Redis delay làm `order_shared_state_redis_confirm_duration` và `order_shared_state_redis_webhook_duration` tăng là expected.

Cách đọc đúng:

```text
Latency tăng + counters exact = degrade behavior OK.
Latency thấp bất thường + profile delay không set được = test chưa thật sự degrade.
Counters sai dưới latency degrade = Redis/app correctness bug.
```

## 8. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| setup profile 401/403 | Thiếu/sai `OPS_AUTH_TOKEN`; setup blocker, chưa kết luận BE bug. |
| profile delay không đúng | Control-plane không áp dụng Redis degrade. |
| fresh count > 1 | Redis delay làm lock/idempotency race hỏng. |
| reuse/duplicate count thiếu | Dedupe không ổn định dưới degrade. |
| teardown reset fail | Rất nguy hiểm: case sau bị nhiễu Redis delay/fault. |
| Chỉ nhìn latency tăng và kết luận fail | Sai; latency tăng là mục tiêu inject degrade. |

## 9. Dashboard/chart reading

Chart nên đọc:

- custom counters fresh/reuse/duplicate;
- latency trend confirm/webhook dưới `target_dependency=redis`;
- setup/teardown control-plane status;
- request timeline hai burst confirm và webhook.

Không dùng aggregate p95 một mình. Degrade case cố tình làm p95 tăng.

## 10. Production lesson

Redis degrade không nhất thiết phải làm hệ thống fail cứng, nhưng nó phải visible trong latency và không được phá correctness. Điều nguy hiểm nhất là Redis chậm làm lock timeout/race tạo duplicate side effect, hoặc profile degrade không reset làm toàn bộ suite sau bị sai.