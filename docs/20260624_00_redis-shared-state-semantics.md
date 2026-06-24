# Redis/shared state layer: consistency trước capacity

## 1. Vì sao sau LB là Redis/shared state?

CDN trả lời request nào được edge cache/offload. LB/Gateway trả lời request nào được route tới đúng upstream. Khi request đã đến đúng app/order service, câu hỏi tiếp theo là shared state:

```text
Nhiều instance/service cùng đọc ghi Redis có giữ đúng idempotency, claim ownership, hot-key race, fairness, degrade và cache behavior không?
```

Nếu layer này sai, hệ thống có thể vẫn trả status 200 nhưng tạo duplicate side effect: order confirm chạy hai lần, webhook payment apply hai lần, lock bị kẹt, owner chết nhưng không ai takeover, hoặc cache hot/cold làm benchmark bị hiểu nhầm.

## 2. Mental model

Runtime đúng cho Redis practice hiện tại là `TargetLayer=full-no-cdn`:

```text
k6/client
  -> http://localhost:80
  -> Nginx LB/Gateway
  -> app/order-service instances
  -> Redis shared state
  -> Postgres / external simulation
```

Không dùng `TargetLayer=full` cho Redis proof vì Varnish/CDN phía trước có thể làm nhiễu request/latency/header. Redis cases kiểm origin-side state, không kiểm edge cache.

## 3. Redis không giống CDN cache

| Khía cạnh | CDN/Varnish | Redis/shared state |
| --- | --- | --- |
| Vị trí | Edge/public path trước Nginx | Origin-side sau app/order service |
| Câu hỏi | Response có được cache/bypass/invalidate đúng không? | State dùng chung có nhất quán/atomic/degrade đúng không? |
| Evidence | `X-Cache`, TTL, purge, origin counters | idempotency reuse, duplicate counters, claim takeover, hot-key fairness, Redis profile |
| Failure chính | stale/wrong cached response | duplicate side effect, stuck lock, race, unfairness, degraded dependency |

## 4. Các primitive cần hiểu

| Primitive | Ý nghĩa |
| --- | --- |
| Idempotency key | Key giúp retry cùng operation không tạo side effect mới. |
| Fresh execution | Request đầu thật sự thực hiện DB/write/external work. |
| Reuse / duplicate | Request sau dùng lại kết quả hoặc bị dedupe, không làm side effect lần nữa. |
| Claim owner | Worker/request giữ quyền xử lý một key trong một khoảng thời gian. |
| Claim TTL | Thời gian lock/claim hết hạn để tránh kẹt vĩnh viễn. |
| Abandon / takeover | Owner cũ bỏ dở; owner mới takeover sau TTL. |
| Hot key | Một key bị nhiều client tranh chấp đồng thời. |
| Fairness | Hot key không được làm normal keys bị starvation. |
| Redis degrade | Redis bị delay/fault; correctness vẫn phải giữ, latency được phép tăng. |
| Hot/cold cache | Hot key kỳ vọng HIT; cold unique keys kỳ vọng MISS. |

## 5. 6 capability proofs

| Case | Capability | Lesson |
| --- | --- | --- |
| 01 | Shared state distributed | Idempotency/webhook/status vẫn nhất quán khi request qua nhiều upstream instances. |
| 02 | Hot-key idempotency race | Nhiều request tranh cùng key phải collapse thành 1 fresh + N reuse/duplicate. |
| 03 | Claim owner abandon | Claim bị abandon phải takeover sau TTL, không stuck lock. |
| 04 | Redis delay degradation | Redis chậm làm latency tăng nhưng không tạo duplicate side effect. |
| 05 | Hot-key fairness | Hot key collapse đúng nhưng normal unique keys vẫn fresh, không bị starvation. |
| 06 | Cache hot/cold toggle | App cache tạo đúng HIT cho hot key và MISS cho cold keys. |

## 6. k6 quan sát được gì?

k6 quan sát được:

```text
status code
headers: X-Upstream-Service, X-Upstream-Addr, X-Test-Scenario
body flags: idempotency_reuse, webhook_duplicate, claim_abandoned
custom counters: fresh/reuse/duplicate/takeover/fairness/cache HIT-MISS
latency trends: Redis degrade, hotkey, normal key, hot/cold cache
control-plane response cho redis-04
```

Status code không đủ. Ví dụ:

```text
status 200 + duplicate fresh count > 1 = fail
status 503 trong abandon setup = expected nếu check claim_abandoned=true
http_req_failed 0% nhưng hot/cold cache sai = fail
latency tăng trong Redis degrade = expected, miễn correctness counters vẫn đúng
```

## 7. Failure modes thường gặp

```text
Per-instance memory thay vì Redis -> request đổi upstream làm idempotency mất hiệu lực.
Race không atomic -> nhiều fresh execution cho cùng idempotency key.
Webhook dedupe sai -> cùng event_id apply nhiều lần.
Claim TTL thiếu -> owner chết làm lock kẹt vĩnh viễn.
Takeover quá sớm -> duplicate active owner.
Redis degrade không reset -> case sau bị nhiễu latency/fault.
Hotkey chiếm worker -> normal keys chậm hoặc fail.
Cache toggle sai -> benchmark hot/cold không còn đáng tin.
```

## 8. Dashboard reading

Dashboard hữu ích nhất khi đọc theo phase/tag:

- checks rate: contract pass/fail chính;
- `http_req_failed`: chỉ đọc theo context, vì case 03 có intentional 503 setup;
- latency by phase: hotkey fresh vs reuse, Redis degrade, normal vs hot key;
- custom counters: nguồn bằng chứng chính cho race/fairness/cache;
- request timeline: hotkey burst và cold/hot phase split.

Không dùng aggregate p95 toàn suite để kết luận Redis layer. Một fresh path có external work 240ms và reuse path vài ms là expected; aggregate làm mất khác biệt.

## 9. Validation snapshot 2026-06-24

Sau BE fix idempotency replay breakdown và conditional distinct-upstream proof, Redis/shared-state practice xanh toàn bộ 6/6:

```text
redis-01 shared-state-distributed: PASS 525/525, distinct-upstream proof conditional (skip default, strict on demand).
redis-02 hot-key race: PASS 216/216.
redis-03 claim owner abandon: PASS.
redis-04 Redis degrade: PASS.
redis-05 hotkey fairness: PASS.
redis-06 cache hot/cold toggle: PASS.
```

redis-01 giờ có 2 chế độ:

- **Default learner/local**: distinct-upstream proof được skip/warn với metric `order_service_shared_state_distinct_upstream_skipped`. Case pass core shared-state semantics.
- **Strict CI**: set `ORDER_SHARED_STATE_REQUIRE_DISTINCT_UPSTREAM=true` hoặc `ORDER_SHARED_STATE_EXPECTED_INSTANCES>=2` để require proof qua nhiều order-service instances.

## 10. Roadmap tiếp theo

Sau Redis/shared state:

```text
Postgres/DB -> external dependency/payment -> resource/capacity
```

Redis layer là cầu nối giữa routing correctness và data persistence correctness: request đã route đúng rồi, nhưng state dùng chung có thật sự nhất quán trước khi ghi DB/external side effect hay không.