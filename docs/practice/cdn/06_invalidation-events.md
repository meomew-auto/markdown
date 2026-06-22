# Case 06: Event-driven invalidation

> **Case ID:** `cdn-06-invalidation-events`
> **Script:** `06-invalidation-events.js`
> **Layer:** CDN / Varnish
> **Proof:** catalog-events-mock -> app internal invalidation -> CDN invalidation

## 1. Business situation

Catalog events invalidate product detail, recommendations, search and homefeed cache without manual operator action.

## 2. CDN capability being proven

Proves event bus -> app internal invalidation -> CDN invalidation flow.

This case proves: **catalog-events-mock -> app internal invalidation -> CDN invalidation**.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 when setup/invalidation/origin counters are needed
Event path:   http://localhost:9091 for catalog event invalidation cases
```

Precondition: Warm product detail/recommendations/search/homefeed, rồi gửi event qua `:9091`.

## 4. Script and env knobs

Source:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\06-invalidation-events.js
```

Env knobs:

- Không có env knob riêng; dùng env chung trong `RUN_GUIDE.md`.

## 5. Request sequence

1. product-updated event -> detail/recommendations/search next MISS
2. homefeed-updated event -> homefeed variants next MISS
3. control/event setup không đi qua CDN public cache

## 6. Catalog calls

| Phase | Method | Base URL | Path | Expected |
| --- | --- | --- | --- | --- |
|  | POST | catalogEventsBaseUrl | /events/product-updated | expectedStatus=200 |
|  | POST | catalogEventsBaseUrl | /events/homefeed-updated | expectedStatus=200 |
|  | GET | publicBaseUrl | /api/sim/products/1, /api/sim/products/1/recommendations, /api/sim/products/search, /api/sim/products/homefeed | expectedSequence=warm MISS/HIT -> event -> MISS |

## 7. Pass/fail criteria

PASS when:

```text
k6 exits 0
checks pass
required X-Cache/header sequence matches the contract
setup/control/event calls complete when this case uses them
```

FAIL when:

- Event endpoint 200 nhưng object vẫn HIT -> event bridge hoặc internal token/config sai
- Một related object không invalidated -> tag mapping thiếu
- Event mock 503 -> APP_INTERNAL_TOKEN/stack issue

## 8. How to run

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scriptsun-cdn-capabilities.ps1 -Scenarios 06-invalidation-events
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
