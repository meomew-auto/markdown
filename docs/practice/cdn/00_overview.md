# Series thực hành: CDN / Varnish layer

## Mục đích series

Series này mở đầu phần **layer-level practice** sau các executor packs.

```text
Executor suite trả lời: traffic shape là gì?
Layer suite trả lời: layer nào đang được validate, và behavior/correctness của layer đó đúng chưa?
```

Với CDN/Varnish, mục tiêu không phải throughput benchmark trước tiên. Mục tiêu là chứng minh public edge cache giữ đúng contract: HIT/MISS, key isolation, bypass, invalidation, TTL, stale serving, coalescing và negative caching.

Một case CDN pass khi cache-state sequence, headers, origin counters, control/event effects đúng với contract. Không đánh giá bằng status code đơn thuần.

## Mental model: public edge path + control path

Runtime đúng cho suite này là `TargetLayer=full`:

```text
client/k6 -> public URL :80 -> Varnish CDN -> Nginx -> app/microservices
control/direct path -> :8088
catalog event mock -> :9091
```

- `http://localhost:80` phải đi qua Varnish; đây là path dùng để chứng minh cache behavior.
- `http://localhost:8088` là control/direct path cho purge/ban/origin profile/counters.
- `http://localhost:9091` là catalog-events mock cho event-driven invalidation.

## Required topology and env

```text
TargetLayer = full
BASE_URL = http://localhost:80
CONTROL_BASE_URL = http://localhost:8088
CATALOG_EVENTS_BASE_URL = http://localhost:9091
OPS_AUTH_TOKEN = <ops-token>
```

Không commit hoặc in real token trong docs/report. `OPS_TOKEN` chỉ là fallback compatibility trong helper; contract chính của docs là `OPS_AUTH_TOKEN`.

## CDN concepts cần nắm

| Concept | Cách hiểu |
| --- | --- |
| Cache key | Object identity trong CDN; gồm path/query đã normalize và variant headers. |
| HIT | CDN phục vụ object từ cache. |
| MISS | CDN phải hỏi origin rồi có thể lưu object. |
| BYPASS / not HIT | Request không được cache vì auth/cookie/no-cache/write/private. |
| TTL / `s-maxage` | Freshness window tại shared cache. |
| Stale | Object hết fresh nhưng vẫn được serve khi origin unhealthy theo policy. |
| Purge | Xóa exact object. |
| Ban URL / prefix | Invalidate một URL hoặc nhóm URL/prefix. |
| Ban tag | Invalidate objects theo `Surrogate-Key`. |
| Revalidation | Client/CDN dùng `ETag` hoặc `Last-Modified`; expected 304 khi hợp lệ. |
| Request coalescing | Nhiều cold requests cùng key collapse thành ít origin hits. |
| Negative caching | Cache tạm expected errors như 404 để giảm origin pressure. |
| Origin request-count reconciliation | Dùng counter ở control path để chứng minh offload/coalescing/stale thật. |

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

Origin counter endpoints là evidence quan trọng cho cases 09/10/11:

```text
GET  /ops/app/cdn/origin/request-counts
POST /ops/app/cdn/origin/request-counts/reset
```

## Case inventory

| # | Script | Capability proof | Evidence cần đọc |
| --- | --- | --- | --- |
| 01 | `01-hit-smoke.js` | Product detail `MISS -> HIT`, sustained HIT | `X-Cache`, `X-Upstream-Service` |
| 02 | `02-variant-keys.js` | Language/geo/device/AB/segment không leak variant | `X-Cache-Key-*`, per-variant `MISS -> HIT` |
| 03 | `03-bypass-rules.js` | Auth/cookie/no-cache/write traffic bypass cache | not `HIT`, upstream service |
| 04 | `04-query-normalization.js` | Tracking params không fragment cache; business params tạo key riêng | canonical/tracking/business query sequence |
| 05 | `05-invalidation-ops.js` | Purge, ban-url, ban-tag invalidate đúng object | warm `HIT`, invalidate, next `MISS` |
| 06 | `06-invalidation-events.js` | Catalog events invalidate product/search/homefeed objects | event status + next public `MISS` |
| 07 | `07-cache-contract.js` | Cache contract headers and 304 revalidation | cache headers, `ETag`, `Vary`, `Surrogate-Key`, 304 |
| 08 | `08-ttl-expiry.js` | `MISS -> HIT -> wait TTL -> MISS` | `X-Cache` before/after wait |
| 09 | `09-stale-while-error.js` | Serve stale while origin unhealthy | `X-Cache-Stale=true`, backend unhealthy, origin count = 1 |
| 10 | `10-request-coalescing.js` | Cold burst coalesces origin forwarding | follow-up `HIT`, origin count `<= 2` |
| 11 | `11-negative-caching.js` | Expected 404 negative cache TTL works | `404 MISS -> 404 HIT -> wait -> 404 MISS`, count `1 then 2` |

## Common invalid-result patterns

| Pattern | Vì sao nguy hiểm | Cách đọc đúng |
| --- | --- | --- |
| Status 200 nhưng `X-Cache` sai | App trả OK nhưng CDN contract fail | Luôn kiểm HIT/MISS/BYPASS/stale sequence. |
| Hit ratio cao nhưng variant leakage | Cache nhanh nhưng serve sai audience | Kiểm `X-Cache-Key-*` và response variant. |
| Purge/ban trả 200 nhưng next request vẫn `HIT` | Control plane không invalidated object thật | Warm -> invalidate -> request lại phải `MISS`. |
| Expected 404 bị coi là fail | Negative caching dùng 404 làm expected business outcome | Case 11 pass bằng checks, headers, origin counts. |
| Stale case pass vì status 200 | 200 có thể là origin hoặc stale | Cần stale headers + origin count không tăng. |
| Coalescing all 200 nhưng origin count cao | User thấy OK nhưng origin bị stampede | Case 10 phải chứng minh origin count `<= 2`. |
| Chạy cases song song | Shared cache/control state làm nhiễu proof | Chạy tuần tự, reset theo case. |

## Suggested learning order

1. `cdn-01-hit-smoke`: hiểu cold `MISS -> HIT`.
2. `cdn-02-variant-keys`: tránh cache leakage.
3. `cdn-03-bypass-rules`: private/write traffic không cache.
4. `cdn-04-query-normalization`: tránh cache fragmentation.
5. `cdn-05-invalidation-ops`: purge/ban/tag.
6. `cdn-06-invalidation-events`: event -> internal app -> CDN invalidation.
7. `cdn-07-cache-contract`: headers + 304.
8. `cdn-08-ttl-expiry`: TTL transition.
9. `cdn-09-stale-while-error`: availability khi origin unhealthy.
10. `cdn-10-request-coalescing`: chống stampede.
11. `cdn-11-negative-caching`: expected 404 offload.

## Reference

- Run guide: `./RUN_GUIDE.md`
- Validation report: `./12_validation-and-chart-analysis.md`
- Source catalog: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/case-catalog.json`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
- Layer roadmap: `E:/Projects/k6/k6-metrics-server/load-target/k6/layer-roadmap.md`
