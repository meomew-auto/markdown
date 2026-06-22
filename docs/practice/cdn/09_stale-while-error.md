# Case 09: Stale while origin error

> **Case ID:** `cdn-09-stale-while-error`
> **Script:** `09-stale-while-error.js`
> **Layer:** CDN / Varnish
> **Proof:** origin unhealthy nhưng CDN serve stale HIT đúng header/counter

## 1. Business situation

When origin becomes unhealthy after TTL, CDN should serve a stale object instead of failing the user request.

## 2. CDN capability being proven

Proves stale-if-error behavior and verifies origin is not repeatedly hammered during outage.

This case proves: **origin unhealthy nhưng CDN serve stale HIT đúng header/counter**.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 when setup/invalidation/origin counters are needed
Event path:   http://localhost:9091 for catalog event invalidation cases
```

Precondition: Warm dynamic cached object, wait past TTL, force origin profile unhealthy.

## 4. Script and env knobs

Source:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\09-stale-while-error.js
```

Env knobs:

- `STALE_TTL_SECONDS` default `2`
- `STALE_IF_ERROR_SECONDS` default `120`
- `STALE_POST_TTL_WAIT_SECONDS` default `3`
- `STALE_PROBE_WAIT_SECONDS` default `4`
- `STALE_PROBE_RECOVERY_WAIT_SECONDS` default `3`

## 5. Request sequence

1. warm `MISS -> HIT`
2. set origin unhealthy 503
3. after TTL request returns 200 + `X-Cache:HIT`
4. requires `X-Cache-Stale:true`, `X-Cache-Backend-Healthy:false`, origin count = 1

## 6. Catalog calls

| Phase | Method | Base URL | Path | Expected |
| --- | --- | --- | --- | --- |
|  | PATCH | controlBaseUrl | /ops/app/cdn/origin/profile |  |
|  | GET | publicBaseUrl | /api/cached/<dynamic> | expectedStatus=200; expectedCache=HIT |
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

- 200 without stale headers -> không chứng minh được stale serving
- origin count >1 -> CDN vẫn gọi origin thay vì serve stale
- teardown không reset origin profile -> ảnh hưởng case sau

## 8. How to run

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scripts\run-cdn-capabilities.ps1 -Scenarios 09-stale-while-error
```

## 9. How to read output

- Check k6 threshold summary first.
- Then read the named checks for cache-state/header.
- For control/event cases, a setup endpoint returning 200 is not enough; the following public request must show the expected cache effect.
- For expected 404/negative-cache behavior, judge by checks and headers, not by status-only intuition.

## 10. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md`
