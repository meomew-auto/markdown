# Run Guide — CDN / Varnish layer practice

> File này dùng chung cho 11 CDN capability cases. Đây là layer correctness suite, không phải executor benchmark.

## Important: real runs vs claims

Không bịa cache evidence:

```text
Không nói MISS -> HIT nếu chưa capture được X-Cache.
Không nói purge/ban pass nếu next request chưa MISS.
Không nói stale pass nếu thiếu X-Cache-Stale/backend-healthy/origin-count evidence.
Không nói coalescing pass nếu chưa đọc origin request count.
Không fail negative caching chỉ vì status 404.
```

## Required topology

Chạy từ backend repo:

```powershell
cd E:/Projects/k6/k6-metrics-server
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full -ScaleApp 2
```

Topology cần đúng:

```text
http://localhost:80   -> Varnish CDN public path
http://localhost:8088 -> Nginx/control/direct path
http://localhost:9091 -> catalog-events mock
```

## Env vars

```powershell
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
```

`OPS_AUTH_TOKEN` required cho control-plane cases. Không in real token trong report. `OPS_TOKEN` được `shared.js` accept như fallback, nhưng docs nên dùng `OPS_AUTH_TOKEN`.

## Preflight

```powershell
curl.exe -i http://localhost:80/health
curl.exe -i http://localhost:8088/health
curl.exe -i http://localhost:9091/health

./scripts/check-target-routing.ps1 -TargetLayer full -BaseUrl "http://localhost:80"
```

Control profile probe, token redacted:

```powershell
curl.exe -i http://localhost:8088/ops/app/cdn/origin/profile `
  -H "X-Ops-Token: <ops-token>"
```

## Preferred runner

Inspect all scripts:

```powershell
./scripts/run-cdn-capabilities.ps1 -InspectOnly -Scenarios all
```

Run all cases sequentially:

```powershell
./scripts/run-cdn-capabilities.ps1 -Scenarios all
```

Run one case:

```powershell
./scripts/run-cdn-capabilities.ps1 -Scenarios 01-hit-smoke
./scripts/run-cdn-capabilities.ps1 -Scenarios 09-stale-while-error
./scripts/run-cdn-capabilities.ps1 -Scenarios 10-request-coalescing
./scripts/run-cdn-capabilities.ps1 -Scenarios 11-negative-caching
```

Không chạy các case song song vì cache/control state dùng chung.

## Direct k6 pattern

```powershell
cd E:/Projects/k6/k6-metrics-server/load-target
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

k6 run ./k6/cdn/01-hit-smoke.js
```

## Commands từng case

| Case | Command |
| --- | --- |
| 01 HIT smoke | `./scripts/run-cdn-capabilities.ps1 -Scenarios 01-hit-smoke` |
| 02 Variant keys | `./scripts/run-cdn-capabilities.ps1 -Scenarios 02-variant-keys` |
| 03 Bypass rules | `./scripts/run-cdn-capabilities.ps1 -Scenarios 03-bypass-rules` |
| 04 Query normalization | `./scripts/run-cdn-capabilities.ps1 -Scenarios 04-query-normalization` |
| 05 Invalidation ops | `./scripts/run-cdn-capabilities.ps1 -Scenarios 05-invalidation-ops` |
| 06 Invalidation events | `./scripts/run-cdn-capabilities.ps1 -Scenarios 06-invalidation-events` |
| 07 Cache contract | `./scripts/run-cdn-capabilities.ps1 -Scenarios 07-cache-contract` |
| 08 TTL expiry | `./scripts/run-cdn-capabilities.ps1 -Scenarios 08-ttl-expiry` |
| 09 Stale while error | `./scripts/run-cdn-capabilities.ps1 -Scenarios 09-stale-while-error` |
| 10 Request coalescing | `./scripts/run-cdn-capabilities.ps1 -Scenarios 10-request-coalescing` |
| 11 Negative caching | `./scripts/run-cdn-capabilities.ps1 -Scenarios 11-negative-caching` |

## Useful env knobs

```powershell
$env:HIT_SMOKE_VUS = "4"
$env:HIT_SMOKE_DURATION = "18s"
$env:HIT_SMOKE_SLEEP_SECONDS = "0.025"
$env:VARIANT_KEYS_ITERATIONS = "24"
$env:TTL_WAIT_SECONDS = "21"
$env:STALE_TTL_SECONDS = "2"
$env:STALE_IF_ERROR_SECONDS = "120"
$env:STALE_POST_TTL_WAIT_SECONDS = "3"
$env:STALE_PROBE_WAIT_SECONDS = "4"
$env:STALE_PROBE_RECOVERY_WAIT_SECONDS = "3"
$env:COALESCE_CONCURRENCY = "12"
$env:COALESCE_ORIGIN_DELAY_MS = "800"
$env:COALESCE_TTL_SECONDS = "30"
$env:NEGATIVE_TTL_SECONDS = "5"
$env:NEGATIVE_WAIT_SECONDS = "7"
```

## What to collect

Per case:

```text
case id
script
command/env, token redacted
exit code
checks rate
http_req_failed rate when meaningful
X-Cache sequence
required headers
control/event endpoint status
origin request count where used
PASS/FAIL/notes
```

## Reading rules

```text
HIT/MISS/BYPASS sequence > status code alone.
Control endpoint 200 is setup evidence, not final proof.
For invalidation, next public request must MISS.
For stale, require stale headers and origin count.
For coalescing, require origin count <= 2.
For negative caching, 404 is expected; checks decide pass/fail.
```

## Reference

- Overview: `./00_overview.md`
- Validation report: `./12_validation-and-chart-analysis.md`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
