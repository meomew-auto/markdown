# CDN / Varnish validation and chart analysis

## Mục đích

File này lưu bằng chứng runtime sau khi chạy 11 CDN capability cases qua real full topology.

Không bịa số. Trước khi có run thật, chỉ ghi checklist và expected evidence. Sau khi chạy, cập nhật command, exit, checks, HTTP failed, primary observation và result.

## Validation environment

```text
Required topology: TargetLayer=full
Public URL: http://localhost:80
Control URL: http://localhost:8088
Catalog events URL: http://localhost:9091
OPS_AUTH_TOKEN: redacted
```

## Preflight checklist

| Check | Expected | Observed |
| --- | --- | --- |
| `GET /health` public `:80` | 200 through full stack | pending |
| `GET /health` control `:8088` | 200 direct/control | pending |
| `GET /health` events `:9091` | 200 mock alive | pending |
| target routing | `TargetLayer=full` | pending |
| control profile with token | 200 | pending |

## Static inspect

| Command | Expected | Observed |
| --- | --- | --- |
| `./scripts/run-cdn-capabilities.ps1 -InspectOnly -Scenarios all` | all 11 scripts inspect successfully | pending |

## Runtime summary

| Case | Script | Exit | Checks | HTTP failed | Primary observation | Result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 01 | `01-hit-smoke.js` | pending | pending | pending | `MISS -> HIT` | pending |
| 02 | `02-variant-keys.js` | pending | pending | pending | variant `MISS/HIT` isolation | pending |
| 03 | `03-bypass-rules.js` | pending | pending | pending | auth/cookie/no-cache/write not `HIT` | pending |
| 04 | `04-query-normalization.js` | pending | pending | pending | tracking `HIT`, business param `MISS/HIT` | pending |
| 05 | `05-invalidation-ops.js` | pending | pending | pending | purge/ban/tag -> `MISS` | pending |
| 06 | `06-invalidation-events.js` | pending | pending | pending | events -> `MISS` | pending |
| 07 | `07-cache-contract.js` | pending | pending | pending | headers + 304 | pending |
| 08 | `08-ttl-expiry.js` | pending | pending | pending | `HIT -> TTL -> MISS` | pending |
| 09 | `09-stale-while-error.js` | pending | pending | pending | stale `HIT` while origin unhealthy | pending |
| 10 | `10-request-coalescing.js` | pending | pending | pending | origin count `<= 2` | pending |
| 11 | `11-negative-caching.js` | pending | pending | pending | `404 MISS -> 404 HIT -> wait -> 404 MISS` | pending |

## Special proof table for cases 09-11

| Case | Header/counter proof | Expected | Observed | Result |
| --- | --- | --- | --- | --- |
| 09 | `X-Cache-Stale` | `true` | pending | pending |
| 09 | `X-Cache-Backend-Healthy` | `false` | pending | pending |
| 09 | origin request count during stale probe | `1` | pending | pending |
| 10 | follow-up cache state | `HIT` | pending | pending |
| 10 | origin request count | `<= 2` | pending | pending |
| 11 | first response | `404 MISS` | pending | pending |
| 11 | second response | `404 HIT` | pending | pending |
| 11 | after expiry | `404 MISS` | pending | pending |
| 11 | origin request counts | `1 then 2` | pending | pending |

## Dashboard note

Dashboard/cloud validation is optional for this layer. If runs are pushed later, add run IDs and summary-final status here. The core evidence remains headers/checks/origin counters from the real surface.

## Global pass/fail rule

Global PASS requires:

- k6 exits 0.
- checks threshold passes.
- required cache-state sequence is observed.
- required headers/counters match the case contract.
- control/event setup and teardown complete successfully.

Global FAIL if:

- k6 exits non-zero.
- a required check fails.
- expected cache sequence is wrong.
- control/event endpoint is unavailable or unauthorized.
- event invalidation does not invalidate.
