# Case 04: Query normalization

> **Case ID:** `cdn-04-query-normalization`
> **Script:** `04-query-normalization.js`
> **Layer:** CDN / Varnish
> **Proof:** tracking params không phá cache; business params tạo object riêng

## 1. Business situation

Marketing tracking parameters should not fragment cache, while business query parameters should create distinct objects.

## 2. CDN capability being proven

Proves CDN ignores tracking params such as utm/fbclid/gclid but keeps semantic params such as sort.

This case proves: **tracking params không phá cache; business params tạo object riêng**.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 when setup/invalidation/origin counters are needed
Event path:   http://localhost:9091 for catalog event invalidation cases
```

Precondition: Clear search prefix bằng control `ban`; chạy qua public CDN.

## 4. Script and env knobs

Source:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\04-query-normalization.js
```

Env knobs:

- Không có env knob riêng; dùng env chung trong `RUN_GUIDE.md`.

## 5. Request sequence

1. canonical search `MISS -> HIT`
2. same business query + utm/fbclid/gclid -> `HIT`
3. semantic param `sort=price` -> object riêng `MISS -> HIT`

## 6. Catalog calls

| Phase | Method | Base URL | Path | Expected |
| --- | --- | --- | --- | --- |
|  | POST | controlBaseUrl | /ops/app/cdn/cache/ban |  |
|  | GET | publicBaseUrl | /api/sim/products/search?q=shoe | expectedSequence=MISS -> HIT |
|  | GET | publicBaseUrl | /api/sim/products/search?q=shoe&utm_source=lesson&fbclid=abc123&gclid=paid123 | expectedCache=HIT |
|  | GET | publicBaseUrl | /api/sim/products/search?q=shoe&sort=price | expectedSequence=MISS -> HIT |

## 7. Pass/fail criteria

PASS when:

```text
k6 exits 0
checks pass
required X-Cache/header sequence matches the contract
setup/control/event calls complete when this case uses them
```

FAIL when:

- Tracking param MISS -> cache fragmentation
- Business param HIT cùng canonical -> key normalization quá aggressive
- ban prefix không làm sạch objects trước proof

## 8. How to run

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scriptsun-cdn-capabilities.ps1 -Scenarios 04-query-normalization
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
