# Case 11: Negative caching

> **Case ID:** `cdn-11-negative-caching`
> **Script:** `11-negative-caching.js`
> **Layer:** CDN / Varnish
> **Proof:** 404 có thể cache ngắn hạn đúng TTL

## 1. Business situation

Repeated requests for a missing object should not repeatedly hit origin within the negative TTL window.

## 2. CDN capability being proven

Proves 404 responses are cached briefly and expire correctly.

This case proves: **404 có thể cache ngắn hạn đúng TTL**.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 when setup/invalidation/origin counters are needed
Event path:   http://localhost:9091 for catalog event invalidation cases
```

Precondition: Dynamic missing path; 404 là expected, không đọc là test fail.

## 4. Script and env knobs

Source:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\11-negative-caching.js
```

Env knobs:

- `NEGATIVE_TTL_SECONDS` default `5`
- `NEGATIVE_WAIT_SECONDS` default `7`

## 5. Request sequence

1. first 404 MISS + `X-Negative-Cache:true`
2. second 404 HIT + negative header
3. origin count before expiry = 1
4. wait negative TTL
5. after expiry 404 MISS and origin count = 2

## 6. Catalog calls

| Phase | Method | Base URL | Path | Expected |
| --- | --- | --- | --- | --- |
|  | GET | publicBaseUrl | /api/cached/missing/<dynamic> | expectedSequence=404 MISS -> 404 HIT -> wait TTL -> 404 MISS |
|  | GET | controlBaseUrl | /ops/app/cdn/origin/request-counts |  |

## 7. Pass/fail criteria

PASS when:

```text
k6 exits 0
checks pass
required X-Cache/header sequence matches the contract
setup/control/event calls complete when this case uses them
```

FAIL when:

- 404 bị coi là failure theo status-only mindset
- Second request MISS -> negative object không cache
- After expiry still HIT -> negative TTL không hết hạn

## 8. How to run

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scriptsun-cdn-capabilities.ps1 -Scenarios 11-negative-caching
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
