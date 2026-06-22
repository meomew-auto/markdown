# Case 07: Cache response contract

> **Case ID:** `cdn-07-cache-contract`
> **Script:** `07-cache-contract.js`
> **Layer:** CDN / Varnish
> **Proof:** Cache-Control/CDN-Cache-Control/ETag/Last-Modified/Surrogate-Key/Vary và 304 revalidation

## 1. Business situation

Cacheable APIs must return the headers CDN and clients need for revalidation, stale serving and tagging.

## 2. CDN capability being proven

Validates Cache-Control, CDN-Cache-Control, ETag, Last-Modified, Surrogate-Key, Vary and 304 behavior.

This case proves: **Cache-Control/CDN-Cache-Control/ETag/Last-Modified/Surrogate-Key/Vary và 304 revalidation**.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 when setup/invalidation/origin counters are needed
Event path:   http://localhost:9091 for catalog event invalidation cases
```

Precondition: Public reads qua CDN; validate headers and conditional request.

## 4. Script and env knobs

Source:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\07-cache-contract.js
```

Env knobs:

- Không có env knob riêng; dùng env chung trong `RUN_GUIDE.md`.

## 5. Request sequence

1. detail response có cache contract headers
2. conditional `If-None-Match` returns 304
3. homefeed/categories expose expected vary/surrogate behavior

## 6. Catalog calls

| Phase | Method | Base URL | Path | Expected |
| --- | --- | --- | --- | --- |
|  | GET | publicBaseUrl | /api/sim/products/1 | expectedStatus=200 |
|  | GET | publicBaseUrl | /api/sim/products/1 | expectedStatus=304 |
|  | GET | publicBaseUrl | /api/sim/products/homefeed, /api/sim/products/categories | expectedStatus=200 |

## 7. Pass/fail criteria

PASS when:

```text
k6 exits 0
checks pass
required X-Cache/header sequence matches the contract
setup/control/event calls complete when this case uses them
```

FAIL when:

- Cacheable response thiếu Surrogate-Key/Vary -> invalidation/keying khó đúng
- ETag present nhưng 304 fail -> revalidation contract sai
- Header contract đúng nhưng X-Cache sequence sai -> VCL behavior cần kiểm

## 8. How to run

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scriptsun-cdn-capabilities.ps1 -Scenarios 07-cache-contract
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
