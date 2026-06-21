# Run Guide — `ramping-arrival-rate` practice pack

> File này dùng chung cho 7 case trong series. Mỗi case doc giải thích business context, stage curve, expected output, pass criteria và dashboard reading riêng.

## Important: real runs vs local validation

Không tự thêm số dashboard thật nếu chưa chạy thật:

```text
Không bịa run #...
Không bịa p95/p99/max.
Không bịa chart bucket arrays.
Không nói dashboard full đã pass nếu chưa push/verify qua dashboard.
```

Hiện suite đã có **local validation default** against Docker target, không push dashboard: cả 7 case `checks=100%`, `http failed=0%`, `dropped_iterations=0`. Khi cần chart/run ID, chạy lại bằng cloud output + summary-final wrapper.

## Stack cần có

| Service | URL | Mục đích |
| --- | --- | --- |
| UI Dashboard | http://localhost:13001 | Xem run, summary, charts, Executor tab |
| Metrics API | http://localhost:18080 | k6 cloud endpoint (`-o cloud`) và summary-final |
| Load-target | http://localhost:80 | `/api/sim/*` cho đa số cases |
| Report target | http://localhost:8088 | Default riêng của `rar-05` qua `RAR_05_BASE_URL` |

## Source scripts và catalog

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate
```

Files chính:

```text
README.md
case-catalog.json
common.js
rar-01-campaign-warmup-surge.js
rar-02-login-burst-recovery.js
rar-03-payment-webhook-wave.js
rar-04-checkout-flash-sale-wave.js
rar-05-report-job-ingress-ramp.js
rar-06-cache-feed-wave.js
rar-07-production-spike-mix.js
```

Catalog `case-catalog.json` là inventory cho learner/FE: case ID, script, default config, calls, expected status, metrics.

## Env vars chung

PowerShell:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
```

Bash:

```bash
export BASE_URL=http://localhost:80
export K6_CLOUD_HOST=http://localhost:18080
export K6_CLOUD_TOKEN=student-token-1234567890
```

Case 05 đặc biệt:

```powershell
$env:RAR_05_BASE_URL = "http://localhost:8088"
```

Nếu không set, script vẫn default về `http://localhost:8088`.

## Sanity check connectivity

```bash
curl http://localhost:18080/v1/capabilities
curl -H "Authorization: Bearer student-token-1234567890" http://localhost:18080/v1/me
curl http://localhost:80/health
curl http://localhost:8088/health
```

Nếu một check fail, fix stack trước khi kết luận script/backend fail.

## Run pattern chung

Từ docs repo hiện tại:

```powershell
cd "E:\Khoa hoc\k6"

# Local CLI summary only
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js"

# Dashboard/cloud run: có run id, charts, summary-final nếu wrapper hoạt động
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js"
```

Nên dùng wrapper cho bài học có chart vì wrapper pattern thường làm:

```text
1. chạy k6 với -o cloud
2. export summary JSON từ k6 CLI
3. POST summary-final lên Metrics API
4. finish run để giải phóng active-run quota
```

## Commands từng case

```powershell
cd "E:\Khoa hoc\k6"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-login-burst-recovery.js"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-03-payment-webhook-wave.js"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-04-checkout-flash-sale-wave.js"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-job-ingress-ramp.js"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-06-cache-feed-wave.js"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-07-production-spike-mix.js"
```

Chạy sequential, không parallel, để mỗi dashboard run map sạch với đúng workload.

## Env override theo case

| Case | Start | Mid/normal | Peak | Recovery | Pre/max VUs | Drop budget | User pool | Extra |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| 01 | `RAR_01_START_RATE=2` | `RAR_01_WARM_RATE=8` | `RAR_01_PEAK_RATE=28` | `RAR_01_RECOVERY_RATE=6` | `18/60` | 5 | 800 | `RAR_01_DURATION_SCALE=1` |
| 02 | `RAR_02_START_RATE=1` | `RAR_02_PRE_RATE=6` | `RAR_02_BURST_RATE=24` | `RAR_02_RECOVERY_RATE=5` | `16/50` | 3 | 600 | `RAR_02_DURATION_SCALE=1` |
| 03 | `RAR_03_START_RATE=2` | `RAR_03_NORMAL_RATE=8` | `RAR_03_WAVE_RATE=20` | `RAR_03_DRAIN_RATE=4` | `16/50` | 3 | 500 | `RAR_03_DURATION_SCALE=1` |
| 04 | `RAR_04_START_RATE=1` | `RAR_04_BROWSE_RATE=4` | `RAR_04_CHECKOUT_RATE=12` | `RAR_04_RECOVERY_RATE=3` | `25/80` | 3 | 500 | `RAR_04_DURATION_SCALE=1` |
| 05 | `RAR_05_START_RATE=1` | `RAR_05_NORMAL_RATE=3` | `RAR_05_JOB_RATE=8` | `RAR_05_COOLDOWN_RATE=2` | `25/80` | 0 | 300 | `RAR_05_READY_AFTER_MS=120`, `RAR_05_BASE_URL=http://localhost:8088` |
| 06 | `RAR_06_START_RATE=4` | `RAR_06_NORMAL_RATE=12` | `RAR_06_FEED_RATE=36` | `RAR_06_RECOVERY_RATE=8` | `18/60` | 5 | 1000 | `RAR_06_DURATION_SCALE=1` |
| 07 | `RAR_07_START_RATE=3` | `RAR_07_BASELINE_RATE=12` | `RAR_07_SPIKE_RATE=32` | `RAR_07_RECOVERY_RATE=10` | `30/90` | 8 | 1200 | `RAR_07_DURATION_SCALE=1` |

User pool env vars:

```text
RAR_01_USER_POOL=800
RAR_02_USER_POOL=600
RAR_03_USER_POOL=500
RAR_04_USER_POOL=500
RAR_05_USER_POOL=300
RAR_06_USER_POOL=1000
RAR_07_USER_POOL=1200
```

Sau khi smoke với env override, xóa env để tránh ảnh hưởng full run:

```powershell
Remove-Item Env:RAR_01_START_RATE, Env:RAR_01_DURATION_SCALE, Env:RAR_01_PREALLOCATED_VUS, Env:RAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

## Smoke settings

Khi chỉ kiểm tra stack nhanh, giảm duration scale và peak rate:

```powershell
$env:RAR_01_DURATION_SCALE = "0.25"
$env:RAR_01_PEAK_RATE = "8"
$env:RAR_01_PREALLOCATED_VUS = "4"
$env:RAR_01_MAX_VUS = "12"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js"
```

Nguyên tắc smoke:

```text
Giữ executor ramping-arrival-rate.
Giữ stage shape nhưng scale duration/rate xuống.
Không dùng số smoke để kết luận production capacity.
```

## What to collect

Per run:

- script name, command/env, exit code, run ID nếu có.
- `checks` pass/fail.
- `http_req_failed` rate.
- `dropped_iterations` count.
- `iterations`, `http_reqs`.
- `vus`, `vus_max`.
- `ramping_arrival_events_total`.
- `ramping_arrival_events_failed`.
- `ramping_arrival_api_calls_total`.
- `ramping_arrival_event_duration_ms` avg/med/p95/p99/max.
- request breakdown by `operation`, `endpoint`, `status`.
- dashboard series: response time, execution timeline, VUs, dropped iterations.

## How to read output

Healthy default run:

```text
checks=100%
http_req_failed=0%
dropped_iterations=0
ramping_arrival_events_failed=0
iterations roughly follow scheduled slots
http_reqs matches per-case call pattern
```

Open-model signals:

```text
VUs rise when rate or event duration rises.
VUs rising alone is normal.
VUs near max + dropped_iterations > 0 means capacity shortage.
Dropped slots are not retried later; they are lost arrival events.
```

## Dashboard checklist

### Response time

- Which `service`/`operation` dominates p95/p99?
- Does latency grow in peak stage?
- For multi-step cases, compare `http_req_duration` with `ramping_arrival_event_duration_ms`.

### Execution timeline

- Do `iterations`/`http_reqs` buckets follow the stage curve?
- Are `dropped_iterations` zero, or do they cluster at peak/transition?
- Do failures cluster by operation/status?

### VUs vs iter/s

- Did VUs rise as rate increased?
- Did VUs stay below `maxVUs` with headroom?
- If iter/s misses target, is it because of drops or because of chart aggregation?

### Executor tab

Confirm:

```text
executor = ramping-arrival-rate
executor_family = ramping_arrival_rate
workload_shape = ramping_ingress_rate
case_id = rar-NN-...
business_case = ...
preAllocatedVUs/maxVUs/stages match script/env
```

## Local validation snapshot

Default validation reported for this suite, local k6 against Docker target, no dashboard push:

| Case | Iterations | HTTP reqs | Checks | HTTP failed | Dropped | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| rar-01 | 705 | 705 | 100% | 0% | 0 | 4.25 |
| rar-02 | 507 | 507 | 100% | 0% | 0 | 23.23 |
| rar-03 | 545 | 545 | 100% | 0% | 0 | 6.94 |
| rar-04 | 317 | 951 | 100% | 0% | 0 | 54.64 |
| rar-05 | 219 | 299 | 100% | 0% | 0 | 22.98 |
| rar-06 | 949 | 949 | 100% | 0% | 0 | 3.76 |
| rar-07 | 1,035 | 1,035 | 100% | 0% | 0 | 70.04 |

Dùng snapshot này để biết default scripts sạch. Khi cần chart evidence, rerun với dashboard/cloud mode.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `dropped_iterations > 0` ở peak | Thiếu VU capacity hoặc event duration tăng | Tăng `PREALLOCATED_VUS`/`MAX_VUS`, đọc event duration và operation p95 |
| `dropped>0` nhưng VUs chưa sát max | Spawn delay / preAllocated quá thấp | Tăng `PREALLOCATED_VUS`, giảm độ dốc stage hoặc warm target |
| checks fail nhưng `http_req_failed=0` | Status/contract mismatch | Xem operation/status breakdown |
| `rar-05` connection refused | Sai report target | Set `RAR_05_BASE_URL=http://localhost:8088` hoặc start report target |
| `http_reqs != iterations` | Multi-step event | Case 04/05 có nhiều calls/event; reconcile với call pattern |
| Dashboard thiếu endpoint khi xem event trend | Event metric không có endpoint tag | Filter event trend theo operation; dùng request metrics cho endpoint |

## Reference

- Overview: `./00_overview.md`
- Source README: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\README.md`
- Catalog: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\case-catalog.json`
- Constant-arrival-rate guide: `../constant-arrival-rate/RUN_GUIDE.md`
- Ramping-vus contrast: `../ramping-vus/00_overview.md`
