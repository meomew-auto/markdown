# Case 10: Request coalescing

> **Case ID:** `cdn-10-request-coalescing`
> **Script:** `10-request-coalescing.js`
> **Layer:** CDN / Varnish
> **Proof:** cold burst cùng key không stampede origin

## 1. Business situation

A cold popular object receives a concurrency burst; CDN should collapse origin forwarding.

## 2. CDN capability being proven

Proves multiple concurrent cache misses do not create an origin stampede.

This case proves: **cold burst cùng key không stampede origin**.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 when setup/invalidation/origin counters are needed
Event path:   http://localhost:9091 for catalog event invalidation cases
```

Precondition: Dynamic cold key có origin delay; run batch concurrency mặc định 12.

## 4. Script and env knobs

Source:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\10-request-coalescing.js
```

Env knobs:

- `COALESCE_CONCURRENCY` default `12`
- `COALESCE_ORIGIN_DELAY_MS` default `800`
- `COALESCE_TTL_SECONDS` default `30`

## 5. Request sequence

1. ban cold key and reset counts
2. send concurrent batch to same URL
3. all responses 200
4. follow-up HIT
5. origin request count <= 2

## 6. Catalog calls

| Phase | Method | Base URL | Path | Expected |
| --- | --- | --- | --- | --- |
|  | GET | publicBaseUrl | /api/cached/<dynamic> | expectedStatus=200 |
|  | GET | controlBaseUrl | /ops/app/cdn/origin/request-counts |  |

## 7. Pass/fail criteria

PASS when:

```text
k6 exits 0
checks pass
required X-Cache/header sequence matches the contract
setup/control/event calls complete when this case uses them
```

FAIL when:

- All 200 nhưng origin count cao -> hidden stampede
- follow-up MISS -> object không cached after batch
- count endpoint mismatch -> control/origin counter issue

## 8. How to run

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scriptsun-cdn-capabilities.ps1 -Scenarios 10-request-coalescing
```

## 9. How to read output

- Check k6 threshold summary first.
- Then read the named checks for cache-state/header expectations.
- For control/event cases, a setup endpoint returning 200 is not enough; the following public request must show the expected cache effect.
- For expected 404/negative-cache behavior, judge by checks and headers, not by status-only intuition.

## 10. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md`
