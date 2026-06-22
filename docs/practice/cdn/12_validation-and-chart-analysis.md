# CDN / Varnish validation and chart analysis

## Mục đích

File này lưu bằng chứng runtime sau khi chạy CDN capability cases qua real full topology.

Không bịa số. Nếu một case chưa chạy vì thiếu token/topology, ghi rõ là **not run** hoặc **blocked**, không chuyển expected behavior thành observed behavior.

## Validation environment

```text
Required topology: TargetLayer=full
Public URL: http://localhost:80
Control URL: http://localhost:8088
Catalog events URL: http://localhost:9091
OPS_AUTH_TOKEN: not set in this Claude session
OPS_TOKEN: not set in this Claude session
OPS_AUTH_TOKEN_FILE: not set in this Claude session
```

## Commands attempted

```powershell
# health preflight
GET http://localhost:80/health
GET http://localhost:8088/health
GET http://localhost:9091/health

# routing check
./scripts/check-target-routing.ps1 -TargetLayer full -BaseUrl "http://localhost:80"

# full inspect attempt
./scripts/run-cdn-capabilities.ps1 -InspectOnly -Scenarios all

# token-free inspect/runtime subset
./scripts/run-cdn-capabilities.ps1 -InspectOnly -Scenarios 03-bypass-rules,07-cache-contract
./scripts/run-cdn-capabilities.ps1 -Scenarios 03-bypass-rules,07-cache-contract
```

No real token was printed or committed.

## Preflight checklist

| Check | Expected | Observed |
| --- | --- | --- |
| `GET /health` public `:80` | 200 through full stack | 200 |
| `GET /health` control `:8088` | 200 direct/control | 200 |
| `GET /health` events `:9091` | 200 mock alive | 200 |
| target routing script | `TargetLayer=full` | blocked: exit 3, ops token required |
| control profile with token | 200 | not run: no ops token in session |

## Static inspect

| Command | Expected | Observed |
| --- | --- | --- |
| `./scripts/run-cdn-capabilities.ps1 -InspectOnly -Scenarios all` | all 11 scripts inspect successfully | blocked before inspect: `OPS_AUTH_TOKEN` required for cases 01, 02, 04, 05, 06, 08, 09, 10, 11 |
| `./scripts/run-cdn-capabilities.ps1 -InspectOnly -Scenarios 03-bypass-rules,07-cache-contract` | token-free scripts inspect successfully | exit 0, both inspect passed |

## Runtime summary

| Case | Script | Exit | Checks | HTTP failed | Primary observation | Result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 01 | `01-hit-smoke.js` | not run | not run | not run | requires control ban-url token for clean `MISS -> HIT` proof | blocked: missing ops token |
| 02 | `02-variant-keys.js` | not run | not run | not run | requires control ban-url token for deterministic variant isolation proof | blocked: missing ops token |
| 03 | `03-bypass-rules.js` | 0 | 54/54 | 0.00% | auth/cookie/no-cache/write requests completed with all bypass checks passing | PASS |
| 04 | `04-query-normalization.js` | not run | not run | not run | requires control ban-prefix token for clean query-normalization proof | blocked: missing ops token |
| 05 | `05-invalidation-ops.js` | not run | not run | not run | requires purge/ban/ban-tag control calls | blocked: missing ops token |
| 06 | `06-invalidation-events.js` | not run | not run | not run | requires event/control invalidation flow with tokenized internals | blocked: missing ops token |
| 07 | `07-cache-contract.js` | 0 | 22/22 | 0.00% | cache contract headers present and detail revalidation returned 304 | PASS |
| 08 | `08-ttl-expiry.js` | not run | not run | not run | requires control ban-url token before TTL proof | blocked: missing ops token |
| 09 | `09-stale-while-error.js` | not run | not run | not run | requires origin profile/counter control endpoints | blocked: missing ops token |
| 10 | `10-request-coalescing.js` | not run | not run | not run | requires origin delay/counter control endpoints | blocked: missing ops token |
| 11 | `11-negative-caching.js` | not run | not run | not run | requires origin counter reset/read control endpoints | blocked: missing ops token |

## Token-free runtime details

### Case 03 — bypass rules

Observed from runner summary:

```text
Scenario: 03-bypass-rules
Exit: 0
checks_total: 54
checks_succeeded: 54/54 = 100.00%
checks_failed: 0/54 = 0.00%
http_req_failed: 0.00% = 0/8
```

Named status checks covered authorization-header, cookie-header, `Cache-Control: no-cache`, and write-method POST requests. The case passed according to the script checks.

### Case 07 — cache contract

Observed from runner summary:

```text
Scenario: 07-cache-contract
Exit: 0
checks_total: 22
checks_succeeded: 22/22 = 100.00%
checks_failed: 0/22 = 0.00%
http_req_failed: 0.00% = 0/4
```

Named checks included:

- detail status 200;
- `Cache-Control` present with `public`, `s-maxage=`, `stale-while-revalidate=`, `stale-if-error=`;
- `CDN-Cache-Control` present with `max-age=`, `stale-while-revalidate=`, `stale-if-error=`;
- `ETag`, `Last-Modified`, `Surrogate-Key`, `Vary` present;
- `Surrogate-Key` includes `product-1`;
- detail revalidation status 304;
- homefeed/category contract checks passed.

## Special proof table for cases 09-11

| Case | Header/counter proof | Expected | Observed | Result |
| --- | --- | --- | --- | --- |
| 09 | `X-Cache-Stale` | `true` | not run | blocked: missing ops token |
| 09 | `X-Cache-Backend-Healthy` | `false` | not run | blocked: missing ops token |
| 09 | origin request count during stale probe | `1` | not run | blocked: missing ops token |
| 10 | follow-up cache state | `HIT` | not run | blocked: missing ops token |
| 10 | origin request count | `<= 2` | not run | blocked: missing ops token |
| 11 | first response | `404 MISS` | not run | blocked: missing ops token |
| 11 | second response | `404 HIT` | not run | blocked: missing ops token |
| 11 | after expiry | `404 MISS` | not run | blocked: missing ops token |
| 11 | origin request counts | `1 then 2` | not run | blocked: missing ops token |

## Dashboard note

Dashboard/cloud runs were not performed in this pass. If runs are pushed later, add run IDs and summary-final status here. The core evidence remains headers/checks/origin counters from the real surface.

## Current validation conclusion

Partial validation only:

- Full topology health endpoints are reachable on public, control, and event ports.
- Token-free cases `cdn-03-bypass-rules` and `cdn-07-cache-contract` passed locally.
- Full 11-case CDN validation is blocked until `OPS_AUTH_TOKEN` or `OPS_AUTH_TOKEN_FILE` is available in the session.

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
