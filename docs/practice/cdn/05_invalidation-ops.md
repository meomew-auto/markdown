# Case 05: Manual invalidation ops

> **Case ID:** `cdn-05-invalidation-ops`
> **Script:** `05-invalidation-ops.js`
> **Layer:** CDN / Varnish
> **Proof:** purge, ban-url, and ban-tag invalidate expected objects

## 1. Business situation

Operators need a safe way to remove stale content after product/content updates. Exact purge, URL ban, and tag ban each cover a different operational need.

## 2. CDN capability being proven

Proves manual invalidation affects the real cached object, not just the control endpoint:

```text
warm object -> HIT
call purge/ban/ban-tag -> 200
next public request -> MISS
```

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 for purge/ban/ban-tag
Event path:   not used
```

Precondition: warm each object before invalidation and use `OPS_AUTH_TOKEN` for control calls.

## 4. Script and env knobs

Source:

```text
E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/05-invalidation-ops.js
```

Env knobs: no case-specific knobs; use common env from `RUN_GUIDE.md`.

## 5. Request sequence

1. Warm `/api/cached/...` to `MISS -> HIT`, then purge exact URL -> next request `MISS`.
2. Warm `/api/sim/products/1` to `MISS -> HIT`, then ban URL -> next request `MISS`.
3. Warm `/api/sim/products/1/recommendations`, then ban surrogate tag -> next request `MISS`.

## 6. Expected observations

| Invalidation type | Control endpoint | Public proof |
| --- | --- | --- |
| exact purge | `/ops/app/cdn/cache/purge` | next same URL `MISS` |
| ban URL | `/ops/app/cdn/cache/ban-url` | next same URL `MISS` |
| ban tag | `/ops/app/cdn/cache/ban-tag` | tagged object next request `MISS` |

## 7. Pass/fail criteria

PASS when:

- k6 exits 0.
- warm objects reach `HIT` before invalidation.
- control calls return success.
- next public request is `MISS` for the expected object(s).

FAIL when:

- control returns 200 but public request remains `HIT`;
- invalidation is too broad and breaks unrelated objects;
- tag invalidation does not cover related objects.

## 8. How to run

```powershell
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
./scripts/run-cdn-capabilities.ps1 -Scenarios 05-invalidation-ops
```

## 9. How to read output

A successful control response is setup evidence only. The final proof is the next public request showing `MISS` after the object had previously been `HIT`.

## 10. Common failure interpretation

| Symptom | Likely area to inspect |
| --- | --- |
| control unauthorized | `OPS_AUTH_TOKEN`, Nginx/control routing |
| next request still `HIT` | Varnish purge/ban implementation or URL normalization mismatch |
| tag miss | `Surrogate-Key` generation and ban-tag mapping |

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
