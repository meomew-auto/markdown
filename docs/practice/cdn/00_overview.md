# Series thực hành: CDN / Varnish layer

## Mục đích series

Series này mở đầu phần **layer-level practice** sau các executor packs. Executor suite trả lời “traffic shape là gì?”. CDN layer suite trả lời:

```text
Public edge cache có giữ đúng cache correctness, invalidation, stale, coalescing, và negative caching contract không?
```

Đây không phải throughput benchmark trước tiên. Phần lớn CDN cases là correctness/capability proof: phải nhìn header, cache state sequence, control-plane effect và origin counters.

## Mental model: public edge path + control path

Runtime đúng cho suite này là `TargetLayer=full`:

```text
k6/client -> http://localhost:80 -> Varnish CDN -> Nginx -> app/microservices
control/direct path -> http://localhost:8088
catalog-events mock -> http://localhost:9091
```

`localhost:80` phải đi qua Varnish. `localhost:8088` dùng cho ops/control hoặc debug direct path. `localhost:9091` là mock producer cho event-driven invalidation.

## Required topology and env

```text
requiredTargetLayer = full
BASE_URL = http://localhost:80
CONTROL_BASE_URL = http://localhost:8088
CATALOG_EVENTS_BASE_URL = http://localhost:9091
OPS_AUTH_TOKEN = <ops-token>
```

Không commit hoặc in real token trong docs/report. `OPS_TOKEN` chỉ là fallback compatibility trong shared helper; contract chính là `OPS_AUTH_TOKEN`.

## CDN concepts cần nắm

| Concept | Cách hiểu |
| --- | --- |
| Cache key | Cách CDN phân biệt object; gồm path/query normalized và variant headers. |
| HIT | CDN phục vụ từ cache. |
| MISS | CDN phải hỏi origin rồi có thể lưu object. |
| BYPASS / not HIT | Request không được cache vì auth/cookie/no-cache/write. |
| TTL / `s-maxage` | Thời gian object còn fresh ở shared cache. |
| Stale | Object hết fresh nhưng vẫn được serve khi origin lỗi theo policy. |
| Purge | Xóa exact object. |
| Ban URL / prefix | Xóa nhiều variant/object theo URL/prefix. |
| Ban tag | Xóa objects cùng `Surrogate-Key`. |
| Revalidation | Client dùng ETag/If-None-Match; expected 304. |
| Coalescing | Nhiều cold requests cùng key collapse thành ít origin hits. |
| Negative caching | Cache tạm response lỗi expected như 404. |

## Key headers/signals

```text
X-Cache
X-Upstream-Service
X-Cache-Key-Language
X-Cache-Key-Geo
X-Cache-Key-Device
X-Cache-Key-AB
X-Cache-Key-Segment
Cache-Control
CDN-Cache-Control
ETag
Last-Modified
Surrogate-Key
Vary
X-Cache-Stale
X-Cache-Backend-Healthy
X-Negative-Cache
```

Origin request-count control endpoint là evidence quan trọng cho stale/coalescing/negative caching:

```text
GET  /ops/app/cdn/origin/request-counts
POST /ops/app/cdn/origin/request-counts/reset
```

## Bảng tổng hợp 11 CDN cases

| # | Script | Title | Business case | Capability proof |
| --- | --- | --- | --- | --- |
| 01 | `01-hit-smoke.js` | Cache HIT smoke | A product detail page is requested repeatedly by anonymous shoppers after an initial cold cache fill. | MISS -> HIT cho product detail anonymous read |
| 02 | `02-variant-keys.js` | Variant cache keys | Different language, geo, device, AB variant and user segment combinations must not share the wrong cached response. | cache key split theo language/geo/device/AB/segment |
| 03 | `03-bypass-rules.js` | Bypass rules | Authenticated, cookie-bearing, no-cache and write requests must bypass CDN cache. | Authorization/Cookie/no-cache/write không được cache HIT |
| 04 | `04-query-normalization.js` | Query normalization | Marketing tracking parameters should not fragment cache, while business query parameters should create distinct objects. | tracking params không phá cache; business params tạo object riêng |
| 05 | `05-invalidation-ops.js` | Manual invalidation ops | Operators purge or ban cached objects after content or product updates. | purge exact URL, ban-url, ban-tag invalidates expected objects |
| 06 | `06-invalidation-events.js` | Event-driven invalidation | Catalog events invalidate product detail, recommendations, search and homefeed cache without manual operator action. | catalog-events-mock -> app internal invalidation -> CDN invalidation |
| 07 | `07-cache-contract.js` | Cache response contract | Cacheable APIs must return the headers CDN and clients need for revalidation, stale serving and tagging. | Cache-Control/CDN-Cache-Control/ETag/Last-Modified/Surrogate-Key/Vary và 304 revalidation |
| 08 | `08-ttl-expiry.js` | TTL expiry | A homefeed object should be served from cache until TTL expires, then refresh from origin. | object HIT trước TTL và MISS sau TTL expiry |
| 09 | `09-stale-while-error.js` | Stale while origin error | When origin becomes unhealthy after TTL, CDN should serve a stale object instead of failing the user request. | origin unhealthy nhưng CDN serve stale HIT đúng header/counter |
| 10 | `10-request-coalescing.js` | Request coalescing | A cold popular object receives a concurrency burst; CDN should collapse origin forwarding. | cold burst cùng key không stampede origin |
| 11 | `11-negative-caching.js` | Negative caching | Repeated requests for a missing object should not repeatedly hit origin within the negative TTL window. | 404 có thể cache ngắn hạn đúng TTL |

## Common invalid-result patterns

| Pattern | Vì sao nguy hiểm | Cách đọc đúng |
| --- | --- | --- |
| Status 200 nhưng `X-Cache` sai | App trả OK nhưng CDN contract fail | Luôn kiểm sequence HIT/MISS/BYPASS/stale. |
| Hit ratio cao nhưng variant leakage | Cache nhanh nhưng serve sai audience | Kiểm `X-Cache-Key-*` và response variant. |
| Purge/ban trả 200 nhưng next request vẫn HIT | Control plane không invalidated object thật | Warm -> invalidate -> request lại phải MISS. |
| Expected 404 bị coi là fail | Negative caching dùng 404 làm expected business outcome | Case 11 pass bằng checks/cache headers/origin count. |
| Stale case pass vì status 200 | 200 có thể là origin hoặc stale | Cần `X-Cache-Stale=true`, backend unhealthy false, origin count không tăng. |
| Coalescing all 200 nhưng origin count cao | User thấy OK nhưng origin bị stampede | Case 10 phải chứng minh origin count <= 2. |
| Chạy cases song song | Shared cache/control state làm nhiễu proof | Chạy tuần tự, reset state theo case. |

## Dashboard/summary semantics

Nếu chỉ chạy k6 local, evidence chính là checks/output. Nếu push dashboard/cloud, chart hữu ích nhất là request timeline + response time theo operation. Nhưng CDN correctness vẫn cần header/counter evidence; dashboard không thay thế `X-Cache` sequence.

## Thứ tự đề xuất học

```text
1. cdn-01 HIT smoke: hiểu MISS -> HIT.
2. cdn-02 variant keys: tránh cache leakage.
3. cdn-03 bypass rules: private/write traffic không cache.
4. cdn-04 query normalization: tránh cache fragmentation.
5. cdn-05 manual invalidation: purge/ban/tag.
6. cdn-06 event invalidation: event -> internal app -> CDN.
7. cdn-07 cache contract: headers + 304.
8. cdn-08 TTL expiry.
9. cdn-09 stale while origin error.
10. cdn-10 request coalescing.
11. cdn-11 negative caching.
```

## Reference

- Source catalog: `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json`
- Source README: `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md`
- Layer roadmap: `E:\Projects\k6\k6-metrics-server\load-target\k6\layer-roadmap.md`
- Run guide: `./RUN_GUIDE.md`
- Validation report: `./12_validation-and-chart-analysis.md`
