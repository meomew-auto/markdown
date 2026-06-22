# Case 10: Request coalescing

> **Case ID:** `cdn-10-request-coalescing`
> **Script:** `10-request-coalescing.js`
> **Layer:** CDN / Varnish
> **Proof:** cold burst coalesces origin forwarding

## 1. Business situation

A popular object can go cold after deploy, purge, or TTL expiry. If many users request it at once, CDN should collapse the burst so origin receives only a small number of requests.

## 2. CDN capability being proven

Proves request coalescing / collapsed forwarding:

```text
cold key + concurrent batch -> all users get 200
follow-up request -> HIT
origin request count <= 2
```

All batch responses being 200 is insufficient. Without the origin counter proof, the origin may still have been stampeded.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 for origin delay and counters
Event path:   not used
```

Precondition: dynamic cold key, origin delay enabled, origin request counters reset.

## 4. Script and env knobs

Source:

```text
E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/10-request-coalescing.js
```

Env knobs:

- `COALESCE_CONCURRENCY`, default `12`
- `COALESCE_ORIGIN_DELAY_MS`, default `800`
- `COALESCE_TTL_SECONDS`, default `30`

## 5. Request sequence

1. Configure origin delay and TTL for a dynamic cached object.
2. Ban the cold key and reset origin counters.
3. Send concurrent requests to the same public URL.
4. Verify all responses are 200.
5. Send follow-up request and expect `HIT`.
6. Read origin request count and require `<= 2`.

## 6. Expected observations

| Signal | Expected |
| --- | --- |
| batch responses | all `200` |
| follow-up `X-Cache` | `HIT` |
| origin request count | `<= 2` |
| teardown | origin delay/profile restored |

## 7. Pass/fail criteria

PASS when:

- k6 exits 0.
- concurrent batch succeeds.
- follow-up request is `HIT`.
- origin request count is `<= 2`.

FAIL when:

- all responses are 200 but origin count is high;
- follow-up remains `MISS`;
- control counter endpoint is unavailable or inconsistent.

## 8. How to run

```powershell
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
./scripts/run-cdn-capabilities.ps1 -Scenarios 10-request-coalescing
```

Optional stress knobs:

```powershell
$env:COALESCE_CONCURRENCY = "12"
$env:COALESCE_ORIGIN_DELAY_MS = "800"
$env:COALESCE_TTL_SECONDS = "30"
```

## 9. How to read output

Read the follow-up cache state and origin count together. A user-visible success does not prove origin protection.

## 10. Common failure interpretation

| Symptom | Likely area to inspect |
| --- | --- |
| origin count > 2 | Varnish coalescing/collapsed forwarding behavior |
| follow-up `MISS` | object not stored after the batch |
| timeout under batch | origin delay/concurrency too aggressive for local environment |

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
