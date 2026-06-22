# Case 02: Variant cache keys

> **Case ID:** `cdn-02-variant-keys`
> **Script:** `02-variant-keys.js`
> **Layer:** CDN / Varnish
> **Proof:** cache key split theo language/geo/device/AB/segment

## 1. Business situation

Different language, geo, device, AB variant and user segment combinations must not share the wrong cached response.

## 2. CDN capability being proven

Proves cache key dimensions split variants correctly while repeated requests for the same variant hit cache.

This case proves: **cache key split theo language/geo/device/AB/segment**.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 when setup/invalidation/origin counters are needed
Event path:   http://localhost:9091 for catalog event invalidation cases
```

Precondition: Chạy 1 VU deterministic; tăng iterations nếu cần thêm sample, không tăng VUs.

## 4. Script and env knobs

Source:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\02-variant-keys.js
```

Env knobs:

- `VARIANT_KEYS_ITERATIONS` default `24`

## 5. Request sequence

1. clear path trước từng proof
2. base variant `MISS -> HIT`
3. variant khác `MISS -> HIT`, không reuse object base
4. homefeed guest/returning có segment key riêng

## 6. Catalog calls

| Phase | Method | Base URL | Path | Expected |
| --- | --- | --- | --- | --- |
|  | POST | controlBaseUrl | /ops/app/cdn/cache/ban-url |  |
|  | GET | publicBaseUrl | /api/sim/products/1 | expectedStatus=200; expectedSequence=base MISS -> base HIT -> variant MISS -> variant HIT |
|  | GET | publicBaseUrl | /api/sim/products/homefeed | expectedStatus=200; expectedSequence=guest MISS/HIT and returning MISS/HIT |

## 7. Pass/fail criteria

PASS when:

```text
k6 exits 0
checks pass
required X-Cache/header sequence matches the contract
setup/control/event calls complete when this case uses them
```

FAIL when:

- Variant khác trả HIT ngay -> cache key thiếu dimension
- Cache-key headers không khớp expected normalization
- Concurrency làm sequence MISS/HIT bị nhiễu

## 8. How to run

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scriptsun-cdn-capabilities.ps1 -Scenarios 02-variant-keys
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
