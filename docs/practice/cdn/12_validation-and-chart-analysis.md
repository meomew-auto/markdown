# CDN / Varnish validation and chart analysis

## Mục đích

File này lưu bằng chứng runtime sau khi chạy CDN capability cases qua real full topology.

Không bịa số. Nếu một case pass isolated nhưng fail trong full sequential run, ghi rõ cả hai vì đó là tín hiệu khác với CDN steady-state behavior.

## Latest recheck after BE fix

Recheck sau khi BE/test-harness sửa recovery giữa stale case và coalescing case:

```text
Full runtime command: ./scripts/run-cdn-capabilities.ps1 -Scenarios all
Result: exit 0
Scenarios started: 11/11
Scenarios passed: 11/11
OPS_AUTH_TOKEN: sourced from running container env, redacted in docs/output
```

Previous issue `cdn-10-request-coalescing` failing immediately after `cdn-09-stale-while-error` is now **verified fixed** in the full sequential suite.

## Validation environment

```text
Required topology: TargetLayer=full
Public URL: http://localhost:80
Control URL: http://localhost:8088
Catalog events URL: http://localhost:9091
OPS_AUTH_TOKEN: sourced from running container env, redacted in docs/output
```

## Commands run

```powershell
# health preflight
GET http://localhost:80/health
GET http://localhost:8088/health
GET http://localhost:9091/health

# routing check, token redacted
./scripts/check-target-routing.ps1 -TargetLayer full -BaseUrl "http://localhost:80"

# full static inspect, token redacted
./scripts/run-cdn-capabilities.ps1 -InspectOnly -Scenarios all

# full runtime, token redacted
./scripts/run-cdn-capabilities.ps1 -Scenarios all
```

No real token was printed or committed.

## Preflight checklist

| Check | Expected | Observed |
| --- | --- | --- |
| `GET /health` public `:80` | 200 through full stack | 200 |
| `GET /health` control `:8088` | 200 direct/control | 200 |
| `GET /health` events `:9091` | 200 mock alive | 200 |
| target routing | `TargetLayer=full` route contract pass | exit 0, 37 pass, 0 fail |
| control profile with token | 200 | covered by routing and scenario control checks |

## Static inspect

| Command | Expected | Observed |
| --- | --- | --- |
| `./scripts/run-cdn-capabilities.ps1 -InspectOnly -Scenarios all` | all 11 scripts inspect successfully | exit 0 |

## Runtime summary

| Case | Script | Exit | Checks | HTTP failed | Primary observation | Result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 01 | `01-hit-smoke.js` | 0 | 21617/21617 | 0.00% | `MISS -> HIT`, sustained HIT | PASS |
| 02 | `02-variant-keys.js` | 0 | 3720/3720 | 0.00% | per-variant `MISS -> HIT` isolation | PASS |
| 03 | `03-bypass-rules.js` | 0 | 54/54 | 0.00% | auth/cookie/no-cache/write requests not `HIT` | PASS |
| 04 | `04-query-normalization.js` | 0 | 36/36 | 0.00% | canonical `MISS -> HIT`, tracking `HIT`, business param `MISS -> HIT` | PASS |
| 05 | `05-invalidation-ops.js` | 0 | 42/42 | 0.00% | purge/ban-url/ban-tag cause next public `MISS` | PASS |
| 06 | `06-invalidation-events.js` | 0 | 46/46 | 0.00% | product/homefeed events cause affected objects to `MISS` | PASS |
| 07 | `07-cache-contract.js` | 0 | 22/22 | 0.00% | cache contract headers present and detail revalidation returned 304 | PASS |
| 08 | `08-ttl-expiry.js` | 0 | 9/9 | 0.00% | homefeed `MISS -> HIT -> wait TTL -> MISS` | PASS |
| 09 | `09-stale-while-error.js` | 0 | 22/22 | 0.00% | stale `HIT` while origin unhealthy with required headers and recovery checks | PASS |
| 10 | `10-request-coalescing.js` | 0 | 24/24 | 0.00% | cold burst succeeded, follow-up `HIT`, origin count proof passed | PASS |
| 11 | `11-negative-caching.js` | 0 | 15/15 | 30.00% expected 404s | `404 MISS -> 404 HIT -> wait -> 404 MISS`, origin counts validated by script | PASS |

## Case 10 sequence issue status

Historical issue before BE fix:

| Run shape | Old result |
| --- | --- |
| Full `all` run, cases 01-09 then immediate case 10 | `cdn-10` failed with batch status failures |
| Single `10-request-coalescing` rerun | passed |
| `09-stale-while-error`, wait 10s, then `10-request-coalescing` | passed |

Latest recheck:

| Run shape | New result |
| --- | --- |
| Full `all` run, cases 01-09 then immediate case 10 | PASS |
| `cdn-10-request-coalescing` in full suite | checks 24/24, `http_req_failed=0.00%` |

Conclusion: the suite sequencing/recovery race between stale serving and request coalescing is verified fixed.

## Special proof table for cases 09-11

| Case | Header/counter proof | Expected | Observed | Result |
| --- | --- | --- | --- | --- |
| 09 | `X-Cache-Stale` | `true` | check passed | PASS |
| 09 | `X-Cache-Backend-Healthy` | `false` | check passed | PASS |
| 09 | origin request count during stale probe | `1` | script counter assertion passed | PASS |
| 09 | recovery/setup checks | healthy enough for next case | full suite proceeded to case 10 successfully | PASS |
| 10 | batch responses | all 200 | checks passed | PASS |
| 10 | follow-up cache state | `HIT` | check passed | PASS |
| 10 | origin request count | `<= 2` | script counter assertion passed | PASS |
| 11 | first response | `404 MISS` | check passed | PASS |
| 11 | second response | `404 HIT` | check passed | PASS |
| 11 | after expiry | `404 MISS` | check passed | PASS |
| 11 | origin request counts | `1 then 2` | script counter assertions passed | PASS |

## Dashboard note

Dashboard/cloud runs were not performed in this pass. If runs are pushed later, add run IDs and summary-final status here. The core evidence remains headers/checks/origin counters from the real surface.

## Current validation conclusion

- Topology health endpoints are reachable.
- Route contract checks pass: 37 pass, 0 fail.
- Full static inspect exits 0.
- Full CDN runtime suite exits 0.
- All 11 CDN capability cases pass in one sequential run.
- Previous `cdn-09` -> `cdn-10` recovery race is verified fixed.

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
