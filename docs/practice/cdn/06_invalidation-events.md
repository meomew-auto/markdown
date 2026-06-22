# Case 06: Event-driven invalidation

> **Case ID:** `cdn-06-invalidation-events`
> **Script:** `06-invalidation-events.js`
> **Layer:** CDN / Varnish
> **Proof:** catalog events invalidate product/search/homefeed cache objects

## 1. Business situation

In production, not every invalidation is manual. Product/catalog changes should emit events that invalidate affected product detail, recommendation, search, and homefeed cache objects.

## 2. CDN capability being proven

Proves the event path works end-to-end:

```text
catalog-events mock -> internal app event handler -> CDN invalidation -> next public request MISS
```

An event endpoint returning 200 is not enough. The affected public objects must stop being `HIT` after the event.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 for app/internal invalidation path
Event path:   http://localhost:9091 for catalog-events mock
```

Precondition: warm product detail, recommendations, search, and homefeed objects before emitting events.

## 4. Script and env knobs

Source:

```text
E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/06-invalidation-events.js
```

Env knobs: no case-specific knobs; use common env from `RUN_GUIDE.md`.

## 5. Request sequence

1. Warm product detail, recommendations, search, and homefeed objects to `MISS -> HIT`.
2. Emit `POST /events/product-updated` through catalog-events mock.
3. Verify affected product/search/recommendations public requests become `MISS`.
4. Emit `POST /events/homefeed-updated`.
5. Verify homefeed variants become `MISS`.

## 6. Expected observations

| Event | Affected objects | Expected proof |
| --- | --- | --- |
| `product-updated` | product detail, recommendations, search | warmed `HIT` -> event -> next `MISS` |
| `homefeed-updated` | homefeed variants | warmed `HIT` -> event -> next `MISS` |

## 7. Pass/fail criteria

PASS when:

- k6 exits 0.
- event endpoints return success.
- every expected affected object becomes `MISS` after the event.
- unaffected setup/teardown does not poison later cases.

FAIL when:

- event returns 200 but object remains `HIT`;
- only some related objects invalidate, indicating tag/entity mapping is incomplete;
- event mock or internal token/config is unavailable.

## 8. How to run

```powershell
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
./scripts/run-cdn-capabilities.ps1 -Scenarios 06-invalidation-events
```

## 9. How to read output

Pair each event status with the following public request. If the event succeeds but the public object stays `HIT`, the layer contract failed.

## 10. Common failure interpretation

| Symptom | Likely area to inspect |
| --- | --- |
| event mock unavailable | `catalog-events-mock.py` service/topology |
| event 200, cache still `HIT` | app internal event handler or CDN invalidation call |
| partial invalidation | surrogate-key/entity mapping |

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
