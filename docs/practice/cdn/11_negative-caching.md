# Case 11: Negative caching

> **Case ID:** `cdn-11-negative-caching`
> **Script:** `11-negative-caching.js`
> **Layer:** CDN / Varnish
> **Proof:** expected 404 is cached briefly and expires correctly

## 1. Business situation

Repeated requests for a missing object should not repeatedly hit origin inside a short negative-cache window. This matters for deleted products, bot traffic, broken links, and repeated client retries.

## 2. CDN capability being proven

Proves expected 404 negative caching:

```text
first missing object request -> 404 MISS
second request before TTL -> 404 HIT
wait past negative TTL
third request -> 404 MISS
origin counts -> 1 then 2
```

A 404 is the expected business outcome here. The case passes or fails by checks, headers, cache sequence, and origin counters.

## 3. Runtime path and precondition

```text
Public path:  http://localhost:80 -> Varnish -> Nginx -> app
Control path: http://localhost:8088 for origin counters
Event path:   not used
```

Precondition: use a dynamic missing path so previous runs do not pollute the proof.

## 4. Script and env knobs

Source:

```text
E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/11-negative-caching.js
```

Env knobs:

- `NEGATIVE_TTL_SECONDS`, default `5`
- `NEGATIVE_WAIT_SECONDS`, default `7`

## 5. Request sequence

1. Reset origin counters for the dynamic missing path.
2. First public request -> expected `404 MISS` with `X-Negative-Cache: true`.
3. Second public request before TTL -> expected `404 HIT` with `X-Negative-Cache: true`.
4. Confirm origin count before expiry = `1`.
5. Wait beyond negative TTL.
6. Third public request -> expected `404 MISS`.
7. Confirm origin count after expiry = `2`.

## 6. Expected observations

| Step | Expected |
| --- | --- |
| first response | `404 MISS` |
| second response | `404 HIT` |
| negative header | `X-Negative-Cache: true` |
| count before expiry | `1` |
| after wait | `404 MISS` |
| count after expiry | `2` |

## 7. Pass/fail criteria

PASS when:

- k6 exits 0 even though expected responses are 404.
- the sequence is `404 MISS -> 404 HIT -> wait -> 404 MISS`.
- `X-Negative-Cache` is present as expected.
- origin count is `1 then 2`.

FAIL when:

- 404 is treated as failure purely because of status code;
- second request is `MISS`, meaning negative object is not cached;
- after-expiry request remains `HIT`, meaning negative TTL did not expire;
- origin count does not match the sequence.

## 8. How to run

```powershell
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
./scripts/run-cdn-capabilities.ps1 -Scenarios 11-negative-caching
```

Optional timing overrides:

```powershell
$env:NEGATIVE_TTL_SECONDS = "5"
$env:NEGATIVE_WAIT_SECONDS = "7"
```

## 9. How to read output

This case intentionally uses 404. Judge by named checks, `X-Negative-Cache`, cache sequence, and origin counters, not by status-only intuition.

## 10. Common failure interpretation

| Symptom | Likely area to inspect |
| --- | --- |
| second response `MISS` | negative-cache TTL/header/VCL behavior |
| no `X-Negative-Cache` | origin/VCL negative-cache tagging |
| after-expiry `HIT` | TTL too long or wait too short |
| origin count too high | negative cache not offloading origin |

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
