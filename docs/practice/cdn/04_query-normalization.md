# Case 04: Query normalization

> **Case ID:** `cdn-04-query-normalization`
> **Script:** `04-query-normalization.js`
> **Layer:** CDN / Varnish
> **Proof:** tracking params do not fragment cache; business params do create distinct objects

## 1. Business situation

Search pages often receive marketing parameters such as `utm_*`, `fbclid`, and `gclid`. Those should not create separate cache objects. Business parameters such as `sort=price` can change the response and must remain part of the cache key.

## 2. CDN capability being proven

Proves query normalization is neither too weak nor too aggressive:

```text
/search?q=shoe                         -> MISS -> HIT
/search?q=shoe&utm_source=...&fbclid=  -> HIT, same object
/search?q=shoe&sort=price              -> MISS -> HIT, separate object
```

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 for ban-prefix setup
Event path:   not used
```

Precondition: clear the search prefix by control `ban`, then run public CDN requests.

## 4. Script and env knobs

Source:

```text
E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/04-query-normalization.js
```

Env knobs: no case-specific knobs; use common env from `RUN_GUIDE.md`.

## 5. Request sequence

1. Clear `/api/sim/products/search` cache objects.
2. Canonical query `/api/sim/products/search?q=shoe` -> `MISS`.
3. Same canonical query again -> `HIT`.
4. Add tracking params (`utm_*`, `fbclid`, `gclid`) -> expected `HIT` from same normalized object.
5. Add business param `sort=price` -> expected new object `MISS -> HIT`.

## 6. Expected observations

| Request | Expected |
| --- | --- |
| canonical first read | `MISS` |
| canonical repeat | `HIT` |
| tracking-param URL | `HIT` |
| semantic `sort=price` first read | `MISS` |
| semantic `sort=price` repeat | `HIT` |

## 7. Pass/fail criteria

PASS when:

- k6 exits 0.
- tracking params reuse the canonical cached object.
- semantic params create a separate cache object.
- setup ban completes successfully.

FAIL when:

- tracking-param URL returns `MISS`, causing cache fragmentation;
- `sort=price` reuses canonical `HIT`, meaning normalization is too aggressive;
- ban setup fails and stale previous cache state pollutes the proof.

## 8. How to run

```powershell
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
./scripts/run-cdn-capabilities.ps1 -Scenarios 04-query-normalization
```

## 9. How to read output

This case has two opposite checks: tracking params should be cache-neutral, while business params should be cache-significant. Passing only one side is not enough.

## 10. Common failure interpretation

| Symptom | Likely area to inspect |
| --- | --- |
| tracking URL `MISS` | VCL query-param strip list |
| `sort=price` `HIT` canonical | VCL strips too many query params |
| inconsistent order | query-string normalization/canonicalization |

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
