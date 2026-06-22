# Case 01: Cache HIT smoke

> **Case ID:** `cdn-01-hit-smoke`
> **Script:** `01-hit-smoke.js`
> **Layer:** CDN / Varnish
> **Proof:** product detail `MISS -> HIT`, sustained HIT

## 1. Business situation

A product detail page is requested repeatedly by anonymous shoppers after an initial cold cache fill. This is the most basic CDN promise: anonymous read traffic should be served from edge after the first origin fill.

## 2. CDN capability being proven

Proves the basic cacheable read path:

```text
cold product detail request -> MISS -> origin products-service
same object/variant again -> HIT -> CDN serves cached object
sustained anonymous reads -> HIT remains stable
```

This case is not proving executor behavior. It proves Varnish can store and replay a cacheable product-detail response without changing the key unexpectedly.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 for ban-url setup
Event path:   not used
```

Precondition: clear `/api/sim/products/1` through control `ban-url`, then warm through the public CDN path.

## 4. Script and env knobs

Source:

```text
E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/01-hit-smoke.js
```

Env knobs:

- `HIT_SMOKE_VUS`, default `4`
- `HIT_SMOKE_DURATION`, default `18s`
- `HIT_SMOKE_SLEEP_SECONDS`, default `0.025`

## 5. Request sequence

1. `POST /ops/app/cdn/cache/ban-url` for `/api/sim/products/1`.
2. First public `GET /api/sim/products/1` -> expected `200 MISS`.
3. Second public `GET /api/sim/products/1` -> expected `200 HIT`.
4. Sustained reads keep returning `HIT` with `X-Upstream-Service=products-service`.

## 6. Expected observations

| Signal | Expected |
| --- | --- |
| status | `200` |
| `X-Cache` first read | `MISS` |
| `X-Cache` second/repeated reads | `HIT` |
| `X-Upstream-Service` | `products-service` |
| cache-key headers | normalized/default variant values |

## 7. Pass/fail criteria

PASS when:

- k6 exits 0.
- required checks pass.
- the observed cache sequence is `MISS -> HIT`.
- setup ban completes successfully.

FAIL when:

- the second request stays `MISS`;
- a `HIT` is returned with wrong upstream/service headers;
- control ban fails, making the cold-cache proof unreliable.

## 8. How to run

```powershell
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
./scripts/run-cdn-capabilities.ps1 -Scenarios 01-hit-smoke
```

## 9. How to read output

Read the named checks for first-read `MISS` and repeated `HIT`. A status-only 200 is not enough; this case exists to prove the CDN changed state from cold to warm.

## 10. Common failure interpretation

| Symptom | Likely area to inspect |
| --- | --- |
| always `MISS` | response cache headers, VCL cacheability, query/key normalization |
| wrong upstream | routing/header propagation through Varnish/Nginx |
| setup unauthorized | `OPS_AUTH_TOKEN` or control path config |

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
