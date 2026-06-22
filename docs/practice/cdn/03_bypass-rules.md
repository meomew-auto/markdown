# Case 03: Bypass rules

> **Case ID:** `cdn-03-bypass-rules`
> **Script:** `03-bypass-rules.js`
> **Layer:** CDN / Varnish
> **Proof:** auth/cookie/no-cache/write requests must not become `HIT`

## 1. Business situation

Authenticated reads, cookie-bearing requests, explicit no-cache requests, and write operations can contain private or mutation-sensitive data. CDN must not store and replay them as shared cache objects.

## 2. CDN capability being proven

Proves Varnish bypasses shared cache for traffic that must reach origin:

- `Authorization` header;
- `Cookie` header;
- `Cache-Control: no-cache`;
- unsafe/write method such as cart add.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: not required for this case
Event path:   not used
```

Precondition: run through the public CDN URL. Do not use direct/control path for the bypass proof.

## 4. Script and env knobs

Source:

```text
E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/03-bypass-rules.js
```

Env knobs: no case-specific knobs; use common env from `RUN_GUIDE.md`.

## 5. Request sequence

1. `GET /api/sim/products/1` with `Authorization` -> not `HIT`.
2. `GET /api/sim/products/1` with `Cookie` -> not `HIT`.
3. `GET /api/sim/products/1` with `Cache-Control: no-cache` -> not `HIT`.
4. `POST /api/sim/cart/add` -> not `HIT`, upstream `cart-service`.

## 6. Expected observations

| Traffic type | Expected cache behavior |
| --- | --- |
| auth read | not `HIT` |
| cookie read | not `HIT` |
| no-cache read | not `HIT` |
| write/cart add | not `HIT`; upstream `cart-service` |

## 7. Pass/fail criteria

PASS when:

- k6 exits 0.
- all named bypass checks pass.
- none of the private/write requests returns a shared-cache `HIT`.

FAIL when:

- auth/cookie/no-cache/write traffic returns `HIT`;
- write response exposes cache-key/HIT behavior;
- upstream signal is missing for write traffic.

## 8. How to run

```powershell
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
./scripts/run-cdn-capabilities.ps1 -Scenarios 03-bypass-rules
```

## 9. How to read output

Do not look for a `MISS -> HIT` sequence here. Correct behavior is “not `HIT`” for every private/write path.

## 10. Common failure interpretation

| Symptom | Likely area to inspect |
| --- | --- |
| auth/cookie `HIT` | VCL `vcl_recv` bypass rules |
| no-cache `HIT` | request Cache-Control handling |
| POST cached | unsafe method handling and backend routing |

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
