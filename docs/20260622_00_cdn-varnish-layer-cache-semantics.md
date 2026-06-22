# CDN/Varnish layer: cache semantics trước capacity

## 1. Vì sao sau executor lại học layer?

Executor practice packs trả lời traffic được schedule như thế nào: fixed users, fixed backlog, constant/ramping arrivals. Nhưng production không chỉ fail vì traffic shape. Nó còn fail vì từng layer xử lý request sai contract.

CDN/Varnish layer là layer đầu tiên sau client/k6. Nếu layer này sai, mọi số latency/RPS phía sau đều dễ bị hiểu nhầm.

```text
Executor question: k6 tạo traffic theo shape nào?
Layer question: request đi qua layer này có đúng semantics không?
```

## 2. Mental model CDN/Varnish

```text
Client/k6
  -> public endpoint :80
  -> Varnish CDN
  -> Nginx / LB path
  -> app handlers / microservices
```

Control/direct path dùng `:8088`, không dùng để chứng minh public cache HIT/MISS. Event-driven invalidation đi qua catalog-events mock `:9091`.

## 3. Cache correctness quan trọng hơn hit ratio

Hit ratio cao không đủ nếu cache key sai hoặc invalidation sai.

Ví dụ:

```text
HIT cao + variant leakage = nguy hiểm hơn MISS nhiều.
Purge endpoint 200 + object vẫn HIT = invalidation contract fail.
Status 200 + missing X-Cache-Stale = chưa chứng minh stale serving.
```

## 4. Những primitive cần hiểu

| Primitive | Ý nghĩa |
| --- | --- |
| Cache key | Object identity tại CDN. |
| Vary | Header dimension mà response có thể vary theo. |
| Surrogate-Key | Tag cho invalidation theo nhóm objects. |
| TTL / s-maxage | Freshness window tại shared cache. |
| ETag / Last-Modified | Revalidation contract. |
| Stale | Serve cached object khi origin lỗi hoặc trong stale window. |
| Coalescing | Collapse nhiều cold requests cùng key thành ít origin hits. |
| Negative caching | Cache response lỗi expected như 404 trong TTL ngắn. |

## 5. k6 quan sát được gì?

k6 quan sát được:

```text
status code
headers
checks
response timing
control-plane response
origin request-count endpoint
```

k6 không tự biết “CDN đúng” nếu script không check headers/counters. Vì vậy CDN scripts phải encode contract bằng checks: `X-Cache`, `X-Cache-Key-*`, stale headers, origin counts.

## 6. 11 capability proofs

| Case | Capability | Lesson |
| --- | --- | --- |
| 01 | HIT smoke | Object cacheable phải `MISS -> HIT`. |
| 02 | Variant keys | Không được serve nhầm language/geo/device/AB/segment. |
| 03 | Bypass rules | Private/write/no-cache traffic không được HIT. |
| 04 | Query normalization | Tracking params không phá cache; business params có key riêng. |
| 05 | Manual invalidation | Ops purge/ban/tag phải tác động đúng object. |
| 06 | Event invalidation | Business event phải invalidate CDN qua internal path. |
| 07 | Cache contract | Origin phải emit headers đủ để CDN/client revalidate/invalidate. |
| 08 | TTL expiry | Fresh HIT phải quay lại MISS sau TTL. |
| 09 | Stale while error | CDN giữ availability khi origin unhealthy bằng stale object. |
| 10 | Request coalescing | Cold burst không stampede origin. |
| 11 | Negative caching | 404 expected có thể cache ngắn để giảm origin pressure. |

## 7. Failure modes thường gặp

```text
Wrong cache key -> data leakage hoặc cache fragmentation.
Wrong bypass -> private data cached hoặc write response cached.
Wrong invalidation -> stale product/feed after update.
No stale support -> origin error lan thẳng ra client.
No coalescing -> cold object burst đập origin.
No negative cache -> bot/user retry 404 làm origin nóng.
```

## 8. Dashboard reading

Dashboard response-time chart hữu ích để xem edge/client latency, nhưng CDN correctness phải dựa vào headers/counters. Với layer này, report tốt luôn có cả:

```text
k6 checks
X-Cache sequence
key/stale/negative headers
origin request counts
control/event effects
```

## 9. Roadmap tiếp theo

Sau CDN/Varnish layer, học tiếp:

```text
LB/Nginx -> app gateway -> microservices -> Redis/state -> Postgres/DB -> external dependency -> resource/capacity
```

CDN layer là nền vì nó quyết định request nào đi tiếp vào origin và request nào được offload ngay tại edge.
