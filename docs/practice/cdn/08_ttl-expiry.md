# Case 08: TTL expiry

> **Case ID:** `cdn-08-ttl-expiry`
> **Script:** `08-ttl-expiry.js`
> **Layer:** CDN / Varnish
> **Proof:** `MISS -> HIT -> wait TTL -> MISS`

## 1. Business situation

A homefeed object should be served from cache while it is fresh, then refreshed from origin after its shared-cache TTL expires.

## 2. CDN capability being proven

Proves freshness transitions over time:

```text
cold object -> MISS
fresh repeat -> HIT
wait past TTL -> MISS/refill
```

This is different from manual invalidation. Nothing triggers a purge; time alone should move the object from fresh to expired.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 for ban-url setup
Event path:   not used
```

Precondition: clear homefeed cache object, warm it, then wait `TTL_WAIT_SECONDS` before the after-expiry request.

## 4. Script and env knobs

Source:

```text
E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/08-ttl-expiry.js
```

Env knobs:

- `TTL_WAIT_SECONDS`, default `21`

## 5. Request sequence

1. Clear homefeed object through control `ban-url`.
2. First public `GET /api/sim/products/homefeed` -> `MISS`.
3. Second public request -> `HIT`.
4. Sleep until TTL is expected to expire.
5. Public request after wait -> `MISS`.

## 6. Expected observations

| Step | Expected |
| --- | --- |
| first read | `200 MISS` |
| second read | `200 HIT` |
| after TTL wait | `200 MISS` |

## 7. Pass/fail criteria

PASS when:

- k6 exits 0.
- the sequence is `MISS -> HIT -> wait -> MISS`.
- the wait duration is long enough for the configured TTL.

FAIL when:

- before-wait request does not become `HIT`;
- after-wait request remains `HIT` when TTL should have expired;
- an env override makes the wait shorter than the object TTL.

## 8. How to run

```powershell
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
./scripts/run-cdn-capabilities.ps1 -Scenarios 08-ttl-expiry
```

Optional timing override:

```powershell
$env:TTL_WAIT_SECONDS = "21"
```

## 9. How to read output

This case is timing-sensitive. If it fails, record the actual `TTL_WAIT_SECONDS` used before changing values, then rerun only this case once.

## 10. Common failure interpretation

| Symptom | Likely area to inspect |
| --- | --- |
| never `HIT` | response cacheability or key instability |
| still `HIT` after wait | TTL/s-maxage policy or wait too short |
| intermittent | stale/grace behavior or shared state from parallel runs |

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
