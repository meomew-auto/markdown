# Case 07: Cache response contract

> **Case ID:** `cdn-07-cache-contract`
> **Script:** `07-cache-contract.js`
> **Layer:** CDN / Varnish
> **Proof:** cache contract headers and 304 revalidation

## 1. Business situation

Cacheable APIs need a clear response contract so CDN and clients know how to store, revalidate, vary, and invalidate objects. Without this contract, a response can look correct while being impossible to cache safely.

## 2. CDN capability being proven

Validates the headers that make CDN behavior predictable:

- `Cache-Control` and `CDN-Cache-Control` for freshness and shared-cache policy;
- `ETag` and `Last-Modified` for revalidation;
- `Surrogate-Key` for grouped invalidation;
- `Vary` and cache-key debug headers for variant safety;
- conditional request behavior with expected `304`.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: optional for setup, not the proof surface
Event path:   not used
```

Precondition: public reads must go through CDN. Conditional revalidation should be sent through the same public surface.

## 4. Script and env knobs

Source:

```text
E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/07-cache-contract.js
```

Env knobs: no case-specific knobs; use common env from `RUN_GUIDE.md`.

## 5. Request sequence

1. `GET /api/sim/products/1` and validate cache contract headers.
2. Re-request with conditional `If-None-Match` / no-cache revalidation and expect `304`.
3. Validate homefeed/categories responses expose expected cache and vary/tag behavior.

## 6. Expected observations

| Signal | Expected |
| --- | --- |
| `Cache-Control` | present and cacheable as contract requires |
| `CDN-Cache-Control` | present for shared cache semantics |
| `ETag` | present and usable for conditional request |
| `Last-Modified` | present where contract expects it |
| `Surrogate-Key` | present for invalidation grouping |
| `Vary` | contains required variant dimensions |
| conditional request | `304` when validator matches |

## 7. Pass/fail criteria

PASS when:

- k6 exits 0.
- required headers are present and valid.
- conditional revalidation returns expected `304`.
- cache-state checks still match the public CDN behavior.

FAIL when:

- cacheable responses lack `Surrogate-Key`, `Vary`, or freshness headers;
- `ETag` is present but `304` revalidation fails;
- headers look correct but public cache behavior contradicts the contract.

## 8. How to run

```powershell
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
./scripts/run-cdn-capabilities.ps1 -Scenarios 07-cache-contract
```

## 9. How to read output

Do not stop at “status 200”. This case is about response metadata and conditional semantics. The `304` revalidation check is a first-class pass/fail signal.

## 10. Common failure interpretation

| Symptom | Likely area to inspect |
| --- | --- |
| missing `Surrogate-Key` | origin handler cache-contract generation |
| missing/wrong `Vary` | variant key contract or Varnish header propagation |
| 304 fails | ETag/Last-Modified conditional handling |

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
