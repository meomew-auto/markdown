# Series thực hành: Redis / shared state layer

## Mục đích series

Sau CDN/Varnish và LB/Gateway, request đã đi đúng public path và đúng upstream service. Redis/shared state layer trả lời câu hỏi tiếp theo:

```text
Khi nhiều app/order-service instances cùng xử lý retry, webhook, claim, hot key và cache, shared state có giữ đúng consistency/atomicity/fairness/degrade contract không?
```

Đây là layer correctness suite. Không đọc Redis practice như throughput benchmark thuần. Một case pass khi custom counters và checks chứng minh không duplicate side effect, không stuck claim, không cache mode sai, và degrade behavior được reset sạch.

## Mental model

Runtime đúng theo catalog là `TargetLayer=full-no-cdn`:

```text
client/k6 -> http://localhost:80 -> Nginx LB/Gateway -> app/order-service -> Redis -> Postgres/external simulation
```

Không dùng `TargetLayer=full` vì CDN/Varnish phía trước có thể làm nhiễu signal Redis/origin-side state.

## Required topology and env

```text
requiredTargetLayer = full-no-cdn
BASE_URL = http://localhost:80
ORDER_SHARED_STATE_REDIS_CONTROL_BASE_URL = http://localhost:80   # redis-04
OPS_AUTH_TOKEN = <ops-token>                                      # chỉ redis-04 nếu control mode http
```

`OPS_AUTH_TOKEN` không được in/commit. FE/platform nên inject token cho control-plane case; learner không cần tự nhập shared ops token.

## Redis concepts cần nắm

| Concept | Cách hiểu |
| --- | --- |
| Shared state | State nằm ở Redis, không nằm riêng trong memory từng app instance. |
| Idempotency key | Retry cùng key phải trả lại kết quả cũ, không tạo side effect mới. |
| Webhook dedupe | Cùng `event_id` chỉ được apply một lần. |
| Fresh execution | Lần xử lý thật đầu tiên, có DB/write/external work. |
| Reuse / duplicate | Lần sau dùng lại kết quả/dedupe, không làm lại work. |
| Claim owner | Request/worker giữ quyền xử lý key. |
| Claim TTL | Claim tự hết hạn để owner chết không khóa vĩnh viễn. |
| Abandon/takeover | Owner bỏ dở; request sau takeover sau TTL. |
| Hot key | Nhiều VU tranh cùng một key. |
| Fairness | Hot key không làm normal keys bị starvation. |
| Redis degrade | Redis chậm/fault; correctness counters vẫn phải đúng. |
| Hot/cold cache | Hot repeated key kỳ vọng HIT, cold unique keys kỳ vọng MISS. |

## Key signals

```text
X-Upstream-Service
X-Upstream-Addr
idempotency_reuse
webhook_duplicate
claim_abandoned
payment_state_reused
payment_regression_ignored
order_service_shared_state_* counters
order_claim_abandon_* counters
order_shared_state_redis_* counters
order_hotkey_fairness_* counters
cache_hot_hits / cache_cold_misses
X-Cache-Status hoặc X-Cache trong app cache case
```

## Bảng tổng hợp 6 Redis cases

| # | Case | Script thật | Business case | Capability proof |
| --- | --- | --- | --- | --- |
| 01 | `redis-01-shared-state-distributed` | `../app/15-order-service-shared-state-distributed.js` | Confirm order, payment webhook và status read đi qua nhiều order-service instances. | Shared Redis state giữ idempotency replay, webhook dedupe và payment state nhất quán qua upstream khác nhau. |
| 02 | `redis-02-hotkey-race` | `../app/16-order-service-shared-state-hotkey-race.js` | Mobile/payment retry storm gửi cùng idempotency key/event id đồng thời. | Chính xác 1 fresh confirm/webhook, còn lại reuse/duplicate. |
| 03 | `redis-03-claim-owner-abandon` | `../app/17-order-service-claim-owner-abandon.js` | Worker claim key rồi chết/bỏ dở. | Initial 503 là setup; request sau takeover sau TTL; duplicate sau takeover reuse. |
| 04 | `redis-04-redis-degrade` | `../app/18-order-service-shared-state-redis-degrade.js` | Redis bị delay trong retry storm. | Correctness counters vẫn exact dù latency tăng; setup/reset Redis profile qua ops. |
| 05 | `redis-05-hotkey-fairness` | `../app/19-order-service-hotkey-fairness.js` | Một hot idempotency key cạnh tranh với nhiều normal keys. | Hot key bị collapse đúng, normal unique keys vẫn fresh và latency dưới ngưỡng. |
| 06 | `redis-06-cache-hot-cold-toggle` | `../app/31-cache-hot-cold-toggle.js` | App cache chạy hot repeated key rồi cold unique keys. | Hot phase có HIT, cold phase có MISS, toggle đúng mode. |

## Common invalid-result patterns

| Pattern | Vì sao nguy hiểm | Cách đọc đúng |
| --- | --- | --- |
| Status 200 nhưng fresh count > 1 | Duplicate side effect có thể xảy ra dù client thấy OK | Đọc counters fresh/reuse/duplicate, không chỉ status. |
| Initial 503 ở case 03 bị coi là fail | 503 là setup intentional abandon claim | Pass/fail bằng `claim_abandoned=true` và takeover counters. |
| Latency degrade bị coi là Redis fail | redis-04 cố tình inject delay | Correctness counters phải exact, latency tăng là expected. |
| Hot key pass nhưng normal keys chậm/fail | Hotkey làm starvation | Đọc normal fresh count và normal duration threshold. |
| Hot/cold đều 200 | Không chứng minh cache mode | Đọc `X-Cache-Status`/`X-Cache` và `cache_hot_hits`, `cache_cold_misses`. |
| Chạy cases song song | Redis state/control profile dùng chung | Chạy tuần tự, reset state/profiles nếu case yêu cầu. |
| Quên reset Redis profile sau degrade | Case sau bị nhiễu delay/fault | redis-04 teardown phải reset 200. |

## Dashboard/summary semantics

Chart chỉ là supporting evidence. Redis correctness nằm ở checks + custom counters + body flags. Chart hữu ích nhất khi filter theo `scenario`, `phase`, `target_flow`, `target_service`, `target_dependency`.

## ⭐ 2 bài tiêu biểu nhất để dạy Redis/shared state

### Bài 1: Case 02 — Hot-key idempotency race

Đây là bài nền tảng cho race/atomicity:

```text
Nhiều request cùng lúc tranh một idempotency key. Hệ thống đúng khi chỉ có 1 request fresh và tất cả request còn lại reuse/duplicate.
```

| Tiêu chí | Giá trị dạy |
| --- | --- |
| Business scenario | Payment/mobile retry storm gửi cùng confirm key hoặc webhook event id nhiều lần. |
| Redis capability | Lock/idempotency record phải atomic. |
| Signal quan trọng | `confirm_fresh_count == 1`, `confirm_reuse_count == VUS-1`, `webhook_fresh_count == 1`, `webhook_duplicate_count == VUS-1`. |
| Executor | `per-vu-iterations`, nhiều VU, 1 iteration để tạo race cùng lúc. |
| Bài học cốt lõi | Status 200 không đủ; phải chứng minh side effect chỉ xảy ra một lần. |
| Độ khó | ⭐⭐ — concurrency vừa phải, counters rõ. |

### Bài 2: Case 03 — Claim owner abandon and TTL takeover

Đây là bài vận hành quan trọng nhất:

```text
Owner claim rồi chết là lỗi production phổ biến. Redis lock phải có TTL để request sau takeover an toàn.
```

| Tiêu chí | Giá trị dạy |
| --- | --- |
| Business scenario | Worker đang xử lý checkout/payment thì crash hoặc timeout. |
| Redis capability | Claim owner + TTL + takeover. |
| Signal quan trọng | initial `503` intentional, `claim_abandoned=true`, takeover fresh count > 0, duplicate reuse count > 0. |
| Executor | `per-vu-iterations`, 1 VU, sequential proof vì từng bước phụ thuộc nhau. |
| Bài học cốt lõi | 503 không luôn là bug; trong setup abandon nó là evidence tạo state để kiểm takeover. |
| Độ khó | ⭐⭐⭐ — dễ đọc sai nếu chỉ nhìn HTTP failed. |

## Suggested learning order

```text
1. redis-01 shared-state-distributed: hiểu state dùng chung qua nhiều upstream.
2. redis-02 hotkey-race: atomic idempotency dưới concurrency.
3. redis-03 claim-owner-abandon: TTL takeover và stuck-lock prevention.
4. redis-05 hotkey-fairness: hot key không starve normal keys.
5. redis-04 redis-degrade: control-plane degrade/reset và latency/correctness split.
6. redis-06 cache-hot-cold-toggle: app cache mode và benchmark validity.
```

## Reference

- Source catalog: `E:/Projects/k6/k6-metrics-server/load-target/k6/redis/case-catalog.json`
- Source scripts: `E:/Projects/k6/k6-metrics-server/load-target/k6/app/15-*.js` đến `19-*.js`, `31-cache-hot-cold-toggle.js`
- Layer roadmap: `E:/Projects/k6/k6-metrics-server/load-target/k6/layer-roadmap.md`
- Run guide: `./RUN_GUIDE.md`
- Validation report: `./07_validation-and-chart-analysis.md`
