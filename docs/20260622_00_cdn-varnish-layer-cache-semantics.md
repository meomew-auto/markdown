# CDN/Varnish layer: cache semantics trước capacity

## 1. Vì sao layer testing đến sau executor testing?

Executor practice packs trả lời k6 tạo traffic như thế nào: fixed users, fixed backlog, constant arrival, ramping arrival. Nhưng production không chỉ fail vì traffic shape. Nó còn fail vì từng layer xử lý request sai contract.

CDN/Varnish là layer đầu tiên sau client/k6. Nếu layer này sai, latency/RPS phía sau rất dễ bị hiểu nhầm:

```text
Executor question: traffic shape là gì?
Layer question: request đi qua layer này có đúng semantics không?
```

Vì vậy CDN layer testing đi sau executor testing: khi đã hiểu cách tạo traffic, ta dùng k6 để chứng minh behavior của một layer cụ thể.

## 2. CDN/Varnish mental model

```text
Client/k6
  -> public endpoint :80
  -> Varnish CDN
  -> Nginx / LB path
  -> app handlers / microservices
```

Public path `:80` là nơi đọc HIT/MISS/BYPASS/stale. Control/direct path `:8088` dùng cho purge/ban/origin profile/origin counters. Catalog event mock `:9091` dùng để mô phỏng event-driven invalidation.

## 3. Public path vs control path

| Path | Mục đích | Có chứng minh CDN HIT/MISS không? |
| --- | --- | --- |
| `http://localhost:80` | public user traffic qua Varnish | Có |
| `http://localhost:8088` | ops/control/direct app path | Không; chỉ setup/observe |
| `http://localhost:9091` | catalog event mock | Không; chỉ trigger event |

Sai lầm thường gặp là gọi direct/control path rồi kết luận cache behavior. Với CDN, behavior phải được chứng minh trên public path.

## 4. Cache key, TTL, stale, purge, ban, surrogate key

| Primitive | Ý nghĩa thực tế |
| --- | --- |
| Cache key | Object identity tại CDN; key sai gây leakage hoặc fragmentation. |
| `Vary` | Những request-header dimensions response có thể khác nhau theo. |
| Variant key headers | Signal debug như language/geo/device/AB/segment. |
| TTL / `s-maxage` | Freshness window ở shared cache. |
| Stale / grace | Cho phép serve object cũ khi origin unhealthy hoặc trong stale window. |
| Purge | Xóa exact object. |
| Ban URL / prefix | Invalidate một URL hoặc nhóm URL. |
| Surrogate-Key / ban-tag | Gắn tag cho nhiều objects liên quan để invalidation theo business entity. |
| ETag / Last-Modified | Revalidation contract, ví dụ 304 với `If-None-Match`. |

## 5. Hit ratio không đủ

Hit ratio cao có thể là dấu hiệu tốt, nhưng không đủ để kết luận CDN đúng.

```text
HIT cao + variant leakage = serve sai audience.
Purge endpoint 200 + next request still HIT = invalidation fail.
Status 200 + thiếu X-Cache-Stale = chưa chứng minh stale serving.
All batch responses 200 + origin count cao = hidden stampede.
```

Do đó CDN validation phải kết hợp correctness + origin offload:

- correctness: đúng response cho đúng variant và đúng cache policy;
- offload: origin counter giảm đúng ở stale/coalescing/negative-cache cases.

## 6. k6 quan sát được gì?

k6 có thể đọc:

```text
status code
response headers
named checks
response timing
control-plane response
origin request-count endpoint
```

k6 không tự biết “CDN đúng” nếu script không encode contract. Vì vậy các CDN scripts check `X-Cache`, `X-Cache-Key-*`, cache contract headers, stale headers, negative-cache headers và origin counters.

## 7. 11 capability proofs

| Case | Capability | Lesson |
| --- | --- | --- |
| 01 | HIT smoke | Object cacheable phải `MISS -> HIT`. |
| 02 | Variant keys | Không serve nhầm language/geo/device/AB/segment. |
| 03 | Bypass rules | Private/write/no-cache traffic không được `HIT`. |
| 04 | Query normalization | Tracking params không phá cache; business params có key riêng. |
| 05 | Manual invalidation | Ops purge/ban/tag phải tác động đúng object. |
| 06 | Event invalidation | Business event phải invalidate CDN qua internal path. |
| 07 | Cache contract | Origin phải emit headers đủ để CDN/client revalidate/invalidate. |
| 08 | TTL expiry | Fresh `HIT` phải quay lại `MISS` sau TTL. |
| 09 | Stale while error | CDN giữ availability khi origin unhealthy bằng stale object. |
| 10 | Request coalescing | Cold burst không stampede origin. |
| 11 | Negative caching | Expected 404 có thể cache ngắn để giảm origin pressure. |

## 8. Failure modes và diagnosis

| Symptom | Diagnosis hướng tới |
| --- | --- |
| Second request vẫn `MISS` | Object không cacheable, TTL/header sai, hoặc key bị thay đổi. |
| Variant request `HIT` ngay | Cache key thiếu dimension; có nguy cơ leakage. |
| Auth/cookie request `HIT` | Bypass rule sai; nguy cơ private data leak. |
| Tracking URL `MISS` | Query normalization chưa strip tracking params. |
| `sort=price` lại `HIT` canonical | Query normalization quá aggressive. |
| Invalidation endpoint 200 nhưng next request `HIT` | Control plane/VCL ban/purge không tác động object thật. |
| Stale returns 200 nhưng thiếu stale headers | Có thể origin vẫn healthy hoặc stale path chưa chạy. |
| Coalescing origin count cao | CDN không collapse forwarding; origin có stampede. |
| Negative cache second request `MISS` | 404 không được cached hoặc negative TTL/header sai. |

## 9. Dashboard/summary reading

Dashboard response-time chart hữu ích để xem edge/client latency và traffic timeline. Nhưng với CDN layer, dashboard không thay thế header/counter evidence.

Một report tốt luôn có:

```text
k6 exit/checks
X-Cache sequence
key/stale/negative headers
origin request counts
control/event effects
optional dashboard/cloud run IDs nếu có push
```

Nếu không push dashboard/cloud, ghi rõ “dashboard/cloud runs not performed”.

## 10. Layer này feed các layer sau như thế nào?

Sau CDN/Varnish, các layer tiếp theo có thể là:

```text
LB/Nginx -> app gateway -> microservices -> Redis/state -> Postgres/DB -> external dependency -> resource/capacity
```

CDN layer là nền vì nó quyết định request nào đi tiếp vào origin, request nào bị bypass, request nào được offload, và lúc origin lỗi user có còn được serve stale object không.

## Practice pack

- Overview: `docs/practice/cdn/00_overview.md`
- Run guide: `docs/practice/cdn/RUN_GUIDE.md`
- Validation: `docs/practice/cdn/12_validation-and-chart-analysis.md`
