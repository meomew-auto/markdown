# Case 09: Stale while origin error

> **Case ID:** `cdn-09-stale-while-error`
> **Script:** `09-stale-while-error.js`
> **Layer:** CDN / Varnish
> **Proof:** stale object served while origin unhealthy, with headers and origin-count proof

## 1. Business situation

When origin becomes unhealthy after an object has been cached, CDN should keep users served from a stale object instead of turning every request into an origin error.

## 2. CDN capability being proven

Proves stale-if-error behavior and origin protection:

```text
warm dynamic object -> MISS -> HIT
force origin unhealthy
wait beyond fresh TTL
probe public URL -> 200 HIT with stale headers
origin request count remains 1
```

Status `200` alone is insufficient. The response must prove it is stale and that origin was not repeatedly called.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 for origin profile and counters
Event path:   not used
```

Precondition: dynamic cached object is warm; origin profile can be changed and restored through control endpoints.

## 4. Script and env knobs

Source:

```text
E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/09-stale-while-error.js
```

Env knobs:

- `STALE_TTL_SECONDS`, default `2`
- `STALE_IF_ERROR_SECONDS`, default `120`
- `STALE_POST_TTL_WAIT_SECONDS`, default `3`
- `STALE_PROBE_WAIT_SECONDS`, default `4`
- `STALE_PROBE_RECOVERY_WAIT_SECONDS`, default `3`

## 5. Request sequence

1. Reset origin counters and configure short TTL/stale policy.
2. Warm dynamic cached URL -> `MISS -> HIT`.
3. Set origin unhealthy/503 via control profile.
4. Wait beyond fresh TTL.
5. Probe public URL -> expected `200 HIT` served stale.
6. Verify `X-Cache-Stale: true`, `X-Cache-Backend-Healthy: false`, origin count = `1`.
7. Restore origin profile during teardown.

## 6. Expected observations

| Signal | Expected |
| --- | --- |
| warm sequence | `MISS -> HIT` |
| stale probe status | `200` |
| stale probe `X-Cache` | `HIT` |
| `X-Cache-Stale` | `true` |
| `X-Cache-Backend-Healthy` | `false` |
| origin request count during stale probe | `1` |

## 7. Pass/fail criteria

PASS when:

- k6 exits 0.
- stale probe returns expected headers.
- origin request count does not increase beyond the initial fill.
- teardown restores origin profile successfully.

FAIL when:

- response is 200 but lacks stale headers;
- origin count is greater than 1 during stale probes;
- origin profile teardown fails and leaves later cases polluted.

## 8. How to run

```powershell
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
./scripts/run-cdn-capabilities.ps1 -Scenarios 09-stale-while-error
```

Optional timing overrides:

```powershell
$env:STALE_TTL_SECONDS = "2"
$env:STALE_POST_TTL_WAIT_SECONDS = "3"
$env:STALE_PROBE_WAIT_SECONDS = "4"
```

## 9. How to read output

Treat this as a header/counter proof. Do not mark PASS from status 200. The decisive evidence is `X-Cache-Stale`, backend health header, and origin count.

## 10. Common failure interpretation

| Symptom | Likely area to inspect |
| --- | --- |
| 503 instead of stale 200 | grace/stale-if-error policy or backend health handling |
| 200 without stale headers | response may be origin, not stale |
| origin count increases | stale serving not protecting origin |
| later cases fail unexpectedly | teardown did not restore origin profile |

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
