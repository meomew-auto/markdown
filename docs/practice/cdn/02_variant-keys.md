# Case 02: Variant cache keys

> **Case ID:** `cdn-02-variant-keys`
> **Script:** `02-variant-keys.js`
> **Layer:** CDN / Varnish
> **Proof:** language/geo/device/AB/segment variant isolation

## 1. Business situation

Different shoppers can legitimately see different cached content: language, country, device class, AB test variant, and user segment can all change the response. CDN caching must not leak one audience's response to another.

## 2. CDN capability being proven

Proves the cache key includes the required variant dimensions while still allowing repeated requests for the same variant to hit cache.

```text
base variant:    MISS -> HIT
new variant:     MISS -> HIT
same new variant: HIT
```

The dangerous failure is not low hit ratio; it is a fast `HIT` for the wrong audience.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 for ban-url setup
Event path:   not used
```

Precondition: deterministic 1-VU sequence. Increase iterations only for extra samples; avoid concurrency because it can blur the expected `MISS -> HIT` order.

## 4. Script and env knobs

Source:

```text
E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/02-variant-keys.js
```

Env knobs:

- `VARIANT_KEYS_ITERATIONS`, default `24`

## 5. Request sequence

1. Clear target path through control `ban-url`.
2. Request base product variant -> `MISS`.
3. Request same base variant -> `HIT`.
4. Request variant with different language/geo/device/AB/segment -> `MISS`.
5. Request the same variant again -> `HIT`.
6. Repeat equivalent isolation proof for homefeed guest/returning segment variants.

## 6. Expected observations

| Signal | Expected |
| --- | --- |
| `X-Cache-Key-Language` | normalized language dimension |
| `X-Cache-Key-Geo` | normalized country/geo dimension |
| `X-Cache-Key-Device` | normalized device class |
| `X-Cache-Key-AB` | AB variant dimension |
| `X-Cache-Key-Segment` | segment dimension |
| cross-variant first request | `MISS`, not reused `HIT` |
| same-variant repeat | `HIT` |

## 7. Pass/fail criteria

PASS when:

- k6 exits 0.
- variant-specific checks pass.
- each new variant starts with `MISS` and then becomes `HIT`.
- cache-key debug headers match expected normalized dimensions.

FAIL when:

- a different variant returns `HIT` immediately;
- cache-key headers omit a required dimension;
- concurrent runs make the proof non-deterministic.

## 8. How to run

```powershell
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
./scripts/run-cdn-capabilities.ps1 -Scenarios 02-variant-keys
```

## 9. How to read output

Look for per-variant check names and `X-Cache-Key-*` assertions. A high hit ratio is invalid if the first request for a different variant is already a `HIT`.

## 10. Common failure interpretation

| Symptom | Likely area to inspect |
| --- | --- |
| variant first request `HIT` | VCL hash/key missing a variant header |
| same variant never `HIT` | response cacheability or key instability |
| key header mismatch | normalization logic in Varnish |

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
