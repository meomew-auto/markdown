# Case 03: Bypass rules

> **Case ID:** `cdn-03-bypass-rules`
> **Script:** `03-bypass-rules.js`
> **Layer:** CDN / Varnish
> **Proof:** Authorization/Cookie/no-cache/write không được cache HIT

## 1. Business situation

Authenticated, cookie-bearing, no-cache and write requests must bypass CDN cache.

## 2. CDN capability being proven

Prevents private or mutation traffic from being cached and served to the wrong caller.

This case proves: **Authorization/Cookie/no-cache/write không được cache HIT**.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 when setup/invalidation/origin counters are needed
Event path:   http://localhost:9091 for catalog event invalidation cases
```

Precondition: Public path qua CDN; không cần control token cho riêng case này.

## 4. Script and env knobs

Source:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\03-bypass-rules.js
```

Env knobs:

- Không có env knob riêng; dùng env chung trong `RUN_GUIDE.md`.

## 5. Request sequence

1. GET với Authorization -> not HIT
2. GET với Cookie -> not HIT
3. GET với Cache-Control:no-cache -> not HIT
4. POST cart add -> not HIT, upstream cart-service

## 6. Catalog calls

| Phase | Method | Base URL | Path | Expected |
| --- | --- | --- | --- | --- |
|  | GET | publicBaseUrl | /api/sim/products/1 | expectedStatus=200; expectedCache=not HIT |
|  | GET | publicBaseUrl | /api/sim/products/1 | expectedStatus=200; expectedCache=not HIT |
|  | GET | publicBaseUrl | /api/sim/products/1 | expectedStatus=200; expectedCache=not HIT |
|  | POST | publicBaseUrl | /api/sim/cart/add | expectedStatus=200; expectedCache=not HIT; expectedUpstream=cart-service |

## 7. Pass/fail criteria

PASS when:

```text
k6 exits 0
checks pass
required X-Cache/header sequence matches the contract
setup/control/event calls complete when this case uses them
```

FAIL when:

- Private request HIT -> nguy cơ leak cache
- POST có cache key/header HIT -> write path bị cache sai
- Bypass response thiếu upstream/service signal

## 8. How to run

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scriptsun-cdn-capabilities.ps1 -Scenarios 03-bypass-rules
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
