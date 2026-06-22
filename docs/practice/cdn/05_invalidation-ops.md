# Case 05: Manual invalidation ops

> **Case ID:** `cdn-05-invalidation-ops`
> **Script:** `05-invalidation-ops.js`
> **Layer:** CDN / Varnish
> **Proof:** purge exact URL, ban-url, ban-tag invalidates expected objects

## 1. Business situation

Operators purge or ban cached objects after content or product updates.

## 2. CDN capability being proven

Proves purge by URL, ban by URL and ban by surrogate tag remove the correct cached objects.

This case proves: **purge exact URL, ban-url, ban-tag invalidates expected objects**.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 when setup/invalidation/origin counters are needed
Event path:   http://localhost:9091 for catalog event invalidation cases
```

Precondition: Warm objects trước, gọi control plane qua `:8088` với ops token.

## 4. Script and env knobs

Source:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\05-invalidation-ops.js
```

Env knobs:

- Không có env knob riêng; dùng env chung trong `RUN_GUIDE.md`.

## 5. Request sequence

1. warm `/api/cached` then purge exact -> next MISS
2. warm product detail then ban-url -> next MISS
3. warm recommendations by surrogate tag then ban-tag -> next MISS

## 6. Catalog calls

| Phase | Method | Base URL | Path | Expected |
| --- | --- | --- | --- | --- |
|  | POST | controlBaseUrl | /ops/app/cdn/cache/purge | expectedStatus=200 |
|  | POST | controlBaseUrl | /ops/app/cdn/cache/ban-url | expectedStatus=200 |
|  | POST | controlBaseUrl | /ops/app/cdn/cache/ban-tag | expectedStatus=200 |
|  | GET | publicBaseUrl | /api/cached, /api/sim/products/1, /api/sim/products/1/recommendations | expectedSequence=warm MISS/HIT -> invalidate -> MISS |

## 7. Pass/fail criteria

PASS when:

```text
k6 exits 0
checks pass
required X-Cache/header sequence matches the contract
setup/control/event calls complete when this case uses them
```

FAIL when:

- Control 200 nhưng next request HIT -> invalidation không tác động đúng object
- Purge exact làm mất quá rộng -> collateral invalidation
- ban-tag không cover related object -> surrogate tags sai

## 8. How to run

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scriptsun-cdn-capabilities.ps1 -Scenarios 05-invalidation-ops
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
