# Case 08: TTL expiry

> **Case ID:** `cdn-08-ttl-expiry`
> **Script:** `08-ttl-expiry.js`
> **Layer:** CDN / Varnish
> **Proof:** object HIT trước TTL và MISS sau TTL expiry

## 1. Business situation

A homefeed object should be served from cache until TTL expires, then refresh from origin.

## 2. CDN capability being proven

Proves cached object transitions HIT -> expired -> MISS after s-maxage.

This case proves: **object HIT trước TTL và MISS sau TTL expiry**.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 when setup/invalidation/origin counters are needed
Event path:   http://localhost:9091 for catalog event invalidation cases
```

Precondition: Clear homefeed, warm object, wait `TTL_WAIT_SECONDS` mặc định 21s.

## 4. Script and env knobs

Source:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\08-ttl-expiry.js
```

Env knobs:

- `TTL_WAIT_SECONDS` default `21`

## 5. Request sequence

1. first request MISS
2. second request HIT
3. sleep TTL wait
4. after expiry request MISS

## 6. Catalog calls

| Phase | Method | Base URL | Path | Expected |
| --- | --- | --- | --- | --- |
|  | POST | controlBaseUrl | /ops/app/cdn/cache/ban-url |  |
|  | GET | publicBaseUrl | /api/sim/products/homefeed | expectedSequence=MISS -> HIT -> wait TTL -> MISS |

## 7. Pass/fail criteria

PASS when:

```text
k6 exits 0
checks pass
required X-Cache/header sequence matches the contract
setup/control/event calls complete when this case uses them
```

FAIL when:

- After wait vẫn HIT -> TTL/s-maxage không áp dụng như expected
- Before wait không HIT -> object không cache
- TTL wait quá ngắn/dài do env override sai

## 8. How to run

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scriptsun-cdn-capabilities.ps1 -Scenarios 08-ttl-expiry
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
