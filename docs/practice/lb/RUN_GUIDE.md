# Run Guide — LB / Gateway layer practice

> File này dùng chung cho 12 LB capability cases. Đây là gateway correctness suite, không phải executor benchmark thuần.

## Important: real runs vs claims

```text
Không nói route đúng nếu chưa đọc X-Upstream-Service.
Không nói LB-only nếu response còn X-Cache.
Không nói distribution đúng nếu chỉ thấy 1 instance_id.
Không fail case 07 chỉ vì có 429 — 429 là expected pressure signal.
Không fail case 12 chỉ vì có 504 — 504 là expected timeout policy.
Không dùng TargetLayer=full cho LB proof vì full có CDN đứng trước.
```

## Required topology

### Profile 1 — `lb-app` cho case 01-02

```powershell
cd E:/Projects/k6/k6-metrics-server
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer lb-app -ScaleApp 2
./scripts/check-target-routing.ps1 -BaseUrl "http://localhost:80" -TargetLayer lb-app
./scripts/run-lb-capabilities.ps1 -Profile lb-app
```

### Profile 2 — `full-no-cdn` cho case 03-12

```powershell
cd E:/Projects/k6/k6-metrics-server
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
./scripts/check-target-routing.ps1 -BaseUrl "http://localhost:80" -TargetLayer full-no-cdn
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn
```

`check-target-routing.ps1` có thể cần ops token tùy stack/session. Nếu cần, lấy token từ secure env và không ghi vào docs/output.

## Env vars

```powershell
$env:BASE_URL = "http://localhost:80"
```

Useful knobs:

```powershell
$env:LB_ENTRY_VUS = "4"
$env:LB_ENTRY_DURATION = "20s"
$env:LB_DISTRIBUTION_ITERATIONS = "60"
$env:MIN_LB_INSTANCES = "2"

$env:LB_CACHEABLE_WARMUP_VUS = "6"
$env:LB_CACHEABLE_MEASUREMENT_VUS = "16"
$env:LB_MIX_VUS = "12"
$env:LB_MIX_DURATION = "45s"

$env:LB_PRESSURE_RATE = "30"
$env:LB_CANARY_SAMPLE_SIZE = "120"
$env:LB_CANARY_FAIRNESS_RATE = "90"
$env:LB_ISOLATION_FAST_RATE = "35"
$env:LB_ISOLATION_SLOW_RATE = "8"
$env:LB_TIMEOUT_RATE = "8"
```

## Preferred runner

Inspect only:

```powershell
./scripts/run-lb-capabilities.ps1 -Profile lb-app -InspectOnly
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -InspectOnly
```

Run profile:

```powershell
./scripts/run-lb-capabilities.ps1 -Profile lb-app
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn
```

Run one case:

```powershell
./scripts/run-lb-capabilities.ps1 -Profile lb-app -Scenarios 01-entry-smoke
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 06-retry-failover
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 12-slow-origin-timeouts
```

## Commands từng case

| Case | Profile | Command |
| --- | --- | --- |
| 01 Entry smoke | `lb-app` | `./scripts/run-lb-capabilities.ps1 -Profile lb-app -Scenarios 01-entry-smoke` |
| 02 App distribution | `lb-app` | `./scripts/run-lb-capabilities.ps1 -Profile lb-app -Scenarios 02-app-instance-distribution` |
| 03 Domain boundaries | `full-no-cdn` | `./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 03-domain-boundaries` |
| 04 Origin cacheable read | `full-no-cdn` | `./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 04-origin-cacheable-read` |
| 05 Origin service mix | `full-no-cdn` | `./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 05-origin-service-mix` |
| 06 Retry/failover | `full-no-cdn` | `./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 06-retry-failover` |
| 07 Pressure | `full-no-cdn` | `./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 07-rate-limit-and-connection-pressure` |
| 08 Canary | `full-no-cdn` | `./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 08-weighted-routing-canary` |
| 09 Outlier ejection | `full-no-cdn` | `./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 09-passive-outlier-ejection` |
| 10 Canary fairness | `full-no-cdn` | `./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 10-weighted-fairness-under-load` |
| 11 Saturation isolation | `full-no-cdn` | `./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 11-saturation-isolation` |
| 12 Slow timeout | `full-no-cdn` | `./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 12-slow-origin-timeouts` |

## What to collect

```text
profile / TargetLayer
command and env knobs
exit code
checks succeeded/failed
http_req_failed, with expected exceptions for 07 and 12
X-Served-By or Server
X-Upstream-Service
X-Request-ID
absence of X-Cache
special X-LB-* headers
custom counters: lb_pressure_*, lb_canary_observed, lb_timeout_*
latency by endpoint for isolation/timeout cases
PASS/FAIL/notes
```

## Reading rules

```text
LB correctness > status 200 alone.
X-Upstream-Service is the primary route proof.
No X-Cache means LB-only path is clean.
429 is expected only in pressure case 07 unless the case says otherwise.
504 is expected only in timeout case 12 unless the case says otherwise.
Aggregate p95 can mislead; read by scenario/endpoint.
```

## Reference

- Overview: `./00_overview.md`
- Validation report: `./13_validation-and-chart-analysis.md`
- Source LB scripts: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/*.js`
