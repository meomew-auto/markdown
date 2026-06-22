# Case 01: Cache HIT smoke

> **Case ID:** `cdn-01-hit-smoke`
> **Script:** `01-hit-smoke.js`
> **Layer:** CDN / Varnish
> **Proof:** MISS -> HIT cho product detail anonymous read

## 1. Business situation

A product detail page is requested repeatedly by anonymous shoppers after an initial cold cache fill.

## 2. CDN capability being proven

Proves the basic MISS -> HIT path and stable HIT behavior for cacheable reads.

This case proves: **MISS -> HIT cho product detail anonymous read**.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 when setup/invalidation/origin counters are needed
Event path:   http://localhost:9091 for catalog event invalidation cases
```

Precondition: Clear product detail object bằng control `ban-url`, sau đó warm qua public CDN path.

## 4. Script and env knobs

Source:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\01-hit-smoke.js
```

Env knobs:

- `HIT_SMOKE_VUS` default `4`
- `HIT_SMOKE_DURATION` default `18s`
- `HIT_SMOKE_SLEEP_SECONDS` default `0.025`

## 5. Request sequence

1. control ban-url `/api/sim/products/1`
2. GET product detail lần 1 qua `:80` -> `MISS`
3. GET cùng variant lần 2 -> `HIT`
4. sustained traffic giữ `HIT` ổn định

## 6. Catalog calls

| Phase | Method | Base URL | Path | Expected |
| --- | --- | --- | --- | --- |
| setup | POST | controlBaseUrl | /ops/app/cdn/cache/ban-url |  |
| setup | GET | publicBaseUrl | /api/sim/products/1 | expectedStatus=200; expectedCache=MISS; expectedUpstream=products-service |
| setup/default | GET | publicBaseUrl | /api/sim/products/1 | expectedStatus=200; expectedCache=HIT; expectedUpstream=products-service |

## 7. Pass/fail criteria

PASS when:

```text
k6 exits 0
checks pass
required X-Cache/header sequence matches the contract
setup/control/event calls complete when this case uses them
```

FAIL when:

- Lần 2 vẫn MISS -> object không cache hoặc key bị thay đổi
- HIT nhưng upstream/header sai -> cần kiểm VCL/header propagation
- Control ban fail -> token/topology/control path sai

## 8. How to run

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scriptsun-cdn-capabilities.ps1 -Scenarios 01-hit-smoke
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
