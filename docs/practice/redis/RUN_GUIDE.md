# Run Guide — Redis / shared state layer practice

> File này dùng chung cho 6 Redis/shared-state capability cases. Đây là layer correctness suite, không phải benchmark throughput thuần.

## Important: real runs vs claims

Không bịa Redis/shared-state evidence:

```text
Không nói idempotency đúng nếu chưa đọc fresh/reuse counters.
Không nói webhook dedupe đúng nếu chưa đọc duplicate counter/body flag.
Không nói takeover pass nếu chưa thấy abandon -> TTL wait -> takeover -> duplicate reuse.
Không nói Redis degrade pass nếu setup/reset profile chưa OK.
Không nói cache hot/cold đúng nếu thiếu HIT/MISS signal.
```

## Required topology

Chạy từ backend repo:

```powershell
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
```

Topology cần đúng:

```text
http://localhost:80 -> Nginx LB/Gateway -> app/order-service -> Redis
```

Không dùng `TargetLayer=full` cho Redis practice vì `full` có Varnish/CDN phía trước.

## Env vars chung

```powershell
$env:BASE_URL = "http://localhost:80"
```

Riêng `redis-04-redis-degrade` cần control-plane env:

```powershell
$env:ORDER_SHARED_STATE_REDIS_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_SHARED_STATE_REDIS_CONTROL_MODE = "http"
$env:ORDER_SHARED_STATE_REDIS_DELAY_MS = "80"
$env:ORDER_SHARED_STATE_REDIS_HOTKEY_VUS = "6"
$env:OPS_AUTH_TOKEN = "<ops-token>"
```

Không in real token trong report. FE/platform nên inject `OPS_AUTH_TOKEN` cho learner thay vì yêu cầu learner tự nhập shared ops token.

## Preflight

```powershell
curl.exe -i http://localhost:80/health
.\scripts\check-target-routing.ps1 -BaseUrl "http://localhost:80" -TargetLayer full-no-cdn
```

Nếu preflight route check yêu cầu ops token trong local target, set token qua env hoặc truyền tham số tương ứng. Nếu chỉ chạy cases không dùng control-plane, runtime vẫn có thể chạy mà không cần ops token.

## Runner status

Hiện catalog Redis là metadata-only và **chưa có** runner riêng kiểu:

```text
scripts/run-redis-capabilities.ps1
```

Vì vậy chạy trực tiếp từng script từ `load-target`.

## Direct k6 pattern

```powershell
cd E:\Projects\k6\k6-metrics-server\load-target
$env:BASE_URL = "http://localhost:80"

k6 run .\k6\app\15-order-service-shared-state-distributed.js
k6 run .\k6\app\16-order-service-shared-state-hotkey-race.js
k6 run .\k6\app\17-order-service-claim-owner-abandon.js
k6 run .\k6\app\19-order-service-hotkey-fairness.js
k6 run .\k6\app\31-cache-hot-cold-toggle.js
```

Chạy case degrade có control-plane:

```powershell
cd E:\Projects\k6\k6-metrics-server\load-target
$env:BASE_URL = "http://localhost:80"
$env:ORDER_SHARED_STATE_REDIS_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_SHARED_STATE_REDIS_CONTROL_MODE = "http"
$env:ORDER_SHARED_STATE_REDIS_DELAY_MS = "80"
$env:ORDER_SHARED_STATE_REDIS_HOTKEY_VUS = "6"
$env:OPS_AUTH_TOKEN = "<ops-token>"

k6 run .\k6\app\18-order-service-shared-state-redis-degrade.js
```

## Commands từng case

| Case | Command |
| --- | --- |
| 01 Shared state distributed | `k6 run .\k6\app\15-order-service-shared-state-distributed.js` |
| 02 Hot-key race | `k6 run .\k6\app\16-order-service-shared-state-hotkey-race.js` |
| 03 Claim owner abandon | `k6 run .\k6\app\17-order-service-claim-owner-abandon.js` |
| 04 Redis degrade | `k6 run .\k6\app\18-order-service-shared-state-redis-degrade.js` |
| 05 Hot-key fairness | `k6 run .\k6\app\19-order-service-hotkey-fairness.js` |
| 06 Cache hot/cold toggle | `k6 run .\k6\app\31-cache-hot-cold-toggle.js` |

## Useful env knobs

```powershell
# redis-01
$env:ORDER_SHARED_STATE_DISTRIBUTED_MAX_UPSTREAM_ATTEMPTS = "10"
$env:ORDER_SHARED_STATE_DISTRIBUTED_RETRY_SLEEP_SECONDS = "0.1"

# redis-02
$env:ORDER_SHARED_STATE_HOTKEY_VUS = "8"
$env:ORDER_SHARED_STATE_HOTKEY_CONFIRM_EXTERNAL_MS = "240"

# redis-03
$env:ORDER_CLAIM_ABANDON_TTL_MS = "900"
$env:ORDER_CLAIM_ABANDON_AFTER_MS = "80"

# redis-04
$env:ORDER_SHARED_STATE_REDIS_DELAY_MS = "80"
$env:ORDER_SHARED_STATE_REDIS_HOTKEY_VUS = "6"

# redis-05
$env:ORDER_HOTKEY_FAIRNESS_HOTKEY_VUS = "8"
$env:ORDER_HOTKEY_FAIRNESS_NORMAL_VUS = "8"
$env:ORDER_HOTKEY_FAIRNESS_HOTKEY_MAX_FRESH = "2"
$env:ORDER_HOTKEY_FAIRNESS_NORMAL_MAX_MS = "1500"

# redis-06
$env:CACHE_TOGGLE_VUS = "4"
$env:CACHE_TOGGLE_HOT_DURATION_SECONDS = "12"
$env:CACHE_TOGGLE_COLD_DURATION_SECONDS = "12"
$env:CACHE_TOGGLE_TTL_SECONDS = "120"
$env:CACHE_TOGGLE_SLEEP_SECONDS = "0.05"
```

## What to collect

Per case:

```text
case id
script
command/env, token redacted
exit code
checks rate
http_req_failed rate and whether expected
custom counters: fresh/reuse/duplicate/takeover/fairness/cache
important body flags: idempotency_reuse, webhook_duplicate, claim_abandoned
important headers: X-Upstream-Service, X-Upstream-Addr, X-Test-Scenario
latency trends by phase
PASS/FAIL/notes
```

## Reading rules

```text
Fresh/reuse/duplicate counters > status code alone.
Initial 503 in redis-03 can be expected setup.
Redis degrade latency increase is expected if correctness counters remain exact.
Control-plane setup/reset must pass for redis-04.
Hot key must not starve normal unique keys in redis-05.
Hot/cold cache must prove HIT/MISS, not just 200.
Do not run Redis cases in parallel unless each case isolates state/profile.
```

## Reference

- Overview: `./00_overview.md`
- Validation report: `./07_validation-and-chart-analysis.md`
- Source catalog: `E:\Projects\k6\k6-metrics-server\load-target\k6\redis\case-catalog.json`
