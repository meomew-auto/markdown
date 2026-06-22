# CDN / Varnish validation and chart analysis

## Mục đích

File này lưu bằng chứng runtime sau khi chạy CDN capability cases qua real full topology.

Không bịa số. Nếu một case pass isolated nhưng fail trong full sequential run, ghi rõ cả hai vì đó là tín hiệu khác với CDN steady-state behavior.

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

# full runtime attempt, token redacted
./scripts/run-cdn-capabilities.ps1 -Scenarios all

# targeted reruns, token redacted
./scripts/run-cdn-capabilities.ps1 -Scenarios 10-request-coalescing
./scripts/run-cdn-capabilities.ps1 -Scenarios 11-negative-caching

# sequence diagnosis, token redacted
./scripts/run-cdn-capabilities.ps1 -Scenarios 09-stale-while-error,10-request-coalescing
./scripts/run-cdn-capabilities.ps1 -Scenarios 09-stale-while-error
Start-Sleep -Seconds 10
./scripts/run-cdn-capabilities.ps1 -Scenarios 10-request-coalescing
```

No real token was printed or committed.

## Preflight checklist

| Check | Expected | Observed |
| --- | --- | --- |
| `GET /health` public `:80` | 200 through full stack | 200 |
| `GET /health` control `:8088` | 200 direct/control | 200 |
| `GET /health` events `:9091` | 200 mock alive | 200 |
| target routing | `TargetLayer=full` route contract pass | exit 0, all route contract checks passed |
| control profile with token | 200 | covered by routing and scenario control checks |

## Static inspect

| Command | Expected | Observed |
| --- | --- | --- |
| `./scripts/run-cdn-capabilities.ps1 -InspectOnly -Scenarios all` | all 11 scripts inspect successfully | exit 0 |

## Runtime summary

| Case | Script | Exit | Checks | HTTP failed | Primary observation | Result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 01 | `01-hit-smoke.js` | 0 | 21569/21569 | 0.00% | `MISS -> HIT`, sustained HIT | PASS |
| 02 | `02-variant-keys.js` | 0 | 3720/3720 | 0.00% | per-variant `MISS -> HIT` isolation | PASS |
| 03 | `03-bypass-rules.js` | 0 | 54/54 | 0.00% | auth/cookie/no-cache/write requests not `HIT` | PASS |
| 04 | `04-query-normalization.js` | 0 | 36/36 | 0.00% | canonical `MISS -> HIT`, tracking `HIT`, business param `MISS -> HIT` | PASS |
| 05 | `05-invalidation-ops.js` | 0 | 42/42 | 0.00% | purge/ban-url/ban-tag cause next public `MISS` | PASS |
| 06 | `06-invalidation-events.js` | 0 | 46/46 | 0.00% | product/homefeed events cause affected objects to `MISS` | PASS |
| 07 | `07-cache-contract.js` | 0 | 22/22 | 0.00% | cache contract headers present and detail revalidation returned 304 | PASS |
| 08 | `08-ttl-expiry.js` | 0 | 9/9 | 0.00% | homefeed `MISS -> HIT -> wait TTL -> MISS` | PASS |
| 09 | `09-stale-while-error.js` | 0 | 15/15 | 0.00% | stale `HIT` while origin unhealthy with required headers | PASS |
| 10 | `10-request-coalescing.js` | 99 in immediate full run; 0 isolated | 7/20 immediate; 20/20 isolated | 68.42% immediate; 0.00% isolated | immediate after case 09 batch statuses failed; isolated rerun passed with follow-up `HIT` | SEQUENCE ISSUE |
| 11 | `11-negative-caching.js` | 0 | 15/15 | 30.00% expected 404s | `404 MISS -> 404 HIT -> wait -> 404 MISS`, origin counts validated by script | PASS |

## Case 10 sequence issue evidence

`cdn-10-request-coalescing` is not a confirmed steady-state CDN coalescing failure because the same case passes when run alone. It is a full-suite sequencing/recovery issue after `cdn-09-stale-while-error`.

| Run shape | Result | Evidence |
| --- | --- | --- |
| Full `all` run, cases 01-09 then immediate case 10 | FAIL at case 10 | `checks_succeeded=7/20`, `checks_failed=13/20`, `http_req_failed=68.42%`; all 12 batch status-200 checks failed; follow-up cache state `HIT`; origin count endpoint 200 |
| Immediate `09-stale-while-error,10-request-coalescing` sequence | FAIL at case 10 | same failure pattern: `checks_succeeded=7/20`, `http_req_failed=68.42%` |
| Single `10-request-coalescing` rerun | PASS | `checks_succeeded=20/20`, `http_req_failed=0.00%`, batch statuses 200, follow-up `HIT`, origin counts endpoint 200 |
| `09-stale-while-error`, wait 10s, then `10-request-coalescing` | PASS | case 09 `15/15`; case 10 `20/20`, `http_req_failed=0.00%` |

Interpretation:

- Case 09 intentionally marks origin unhealthy and validates stale serving.
- Case 09 teardown resets the origin profile, but the next case can start before Varnish/backend health has recovered from the stale test.
- Case 10 setup also resets origin profile and counters, but immediately launches the cold coalescing batch.
- Adding a 10s gap between case 09 and case 10 makes case 10 pass, so this looks like a recovery/health-probe race between cases, not a persistent coalescing defect.

Suggested backend/test-harness fix:

- After `resetOriginProfile()` in `cdn/09-stale-while-error.js` teardown, wait until origin/CDN backend health is observed healthy before returning; or
- make the origin reset control endpoint synchronous for CDN health recovery; or
- add an explicit health wait in `cdn/10-request-coalescing.js` setup before the batch; or
- make `run-cdn-capabilities.ps1` support a small inter-scenario recovery delay for stateful CDN cases.

## Special proof table for cases 09-11

| Case | Header/counter proof | Expected | Observed | Result |
| --- | --- | --- | --- | --- |
| 09 | `X-Cache-Stale` | `true` | check passed | PASS |
| 09 | `X-Cache-Backend-Healthy` | `false` | check passed | PASS |
| 09 | origin request count during stale probe | `1` | script counter assertion passed | PASS |
| 10 | follow-up cache state | `HIT` | check passed both in failed sequence and isolated rerun | PASS for this signal |
| 10 | origin request count | `<= 2` | isolated script assertion passed; immediate sequence did not reach a clean status-200 batch | PASS isolated; sequence issue |
| 11 | first response | `404 MISS` | check passed | PASS |
| 11 | second response | `404 HIT` | check passed | PASS |
| 11 | after expiry | `404 MISS` | check passed | PASS |
| 11 | origin request counts | `1 then 2` | script counter assertions passed | PASS |

## Dashboard note

Dashboard/cloud runs were not performed in this pass. If runs are pushed later, add run IDs and summary-final status here. The core evidence remains headers/checks/origin counters from the real surface.

## Current validation conclusion

- Topology and routing are healthy.
- Full static inspect succeeds.
- CDN capability cases 01-09 pass in the full run before the runner stops at case 10.
- Case 11 passes when run separately.
- Case 10 passes when run separately, and also passes after a 10s recovery gap following case 09.
- The only actionable issue is a **stateful suite sequencing/recovery race between case 09 and case 10**.

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
