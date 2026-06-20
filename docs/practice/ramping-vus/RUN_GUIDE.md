# Run Guide — ramping-vus practice

> File này dùng chung cho 7 case `ramping-vus`. Mỗi case có thêm giải thích nghiệp vụ, stage timeline, output reading và dashboard checklist riêng.

## Important: real runs are optional

Docs trong series này hiện giải thích **semantics + backend contract**.

Backend scripts nằm ở:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\
```

Không tự thêm số thật nếu chưa chạy thật:

```text
Không bịa run #...
Không bịa p95/p99/max.
Không bịa observed RPS/iterations.
Không bịa chart bucket arrays.
Không nói runtime full đã pass nếu chưa chạy.
```

Khi chạy thật, ghi rõ command/env/run ID rồi mới update docs với số thật.

## Stack cần có

| Service | URL | Mục đích |
| --- | --- | --- |
| UI Dashboard | http://localhost:13001 | Xem run, summary, charts |
| Metrics API | http://localhost:18080 | k6 cloud endpoint (`-o cloud`) |
| Load-target | http://localhost:80 | Backend `/api/sim/*` cho learner chạy |

## Env vars chung

PowerShell:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
```

## Case catalog cho FE/learner

FE đọc contract ở:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\case-catalog.json
```

Field cần dùng:

| Field | Ý nghĩa |
| --- | --- |
| `id` | ID case, ví dụ `rv-01-daily-traffic-curve` |
| `script` | Script k6 tương ứng |
| `title` | Tên case hiển thị |
| `businessCase` | Tình huống nghiệp vụ |
| `whyRampingVus` | Lý do chọn executor này |
| `defaultConfig.startVUs` | Active VUs ở đầu scenario |
| `defaultConfig.peakVUs` | Peak VUs chính của case |
| `defaultConfig.durationScale` | Scale thời lượng stage để demo nhanh |
| `calls[]` | Service/API/method/path/status expected |

## Run pattern chung

Từ backend repo:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js
```

Private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js
```

## Commands từng case

| Case | Script | Command |
| --- | --- | --- |
| 01 Daily traffic curve | `rv-01-daily-traffic-curve.js` | `k6 run -o cloud .\\load-target\\k6\\ramping-vus\\rv-01-daily-traffic-curve.js` |
| 02 Campaign launch spike | `rv-02-campaign-launch-spike.js` | `k6 run -o cloud .\\load-target\\k6\\ramping-vus\\rv-02-campaign-launch-spike.js` |
| 03 Login wave | `rv-03-login-wave.js` | `k6 run -o cloud .\\load-target\\k6\\ramping-vus\\rv-03-login-wave.js` |
| 04 Checkout ramp | `rv-04-checkout-ramp.js` | `k6 run -o cloud .\\load-target\\k6\\ramping-vus\\rv-04-checkout-ramp.js` |
| 05 Reporting ramp | `rv-05-reporting-ramp.js` | `k6 run -o cloud .\\load-target\\k6\\ramping-vus\\rv-05-reporting-ramp.js` |
| 06 Cart recovery wave | `rv-06-cart-recovery-wave.js` | `k6 run -o cloud .\\load-target\\k6\\ramping-vus\\rv-06-cart-recovery-wave.js` |
| 07 Production traffic curve | `rv-07-production-traffic-curve.js` | `k6 run -o cloud .\\load-target\\k6\\ramping-vus\\rv-07-production-traffic-curve.js` |

## Env override nhanh

| Case | Start | Intermediate | Peak | Late/Cooldown | Scale | Sleep | Extra |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 01 | `RV_01_START_VUS=2` | `RV_01_MORNING_VUS=8` | `RV_01_PEAK_VUS=24` | `RV_01_AFTERNOON_VUS=12` | `RV_01_DURATION_SCALE=0.25` | `RV_01_SLEEP_SECONDS=0.4` | - |
| 02 | `RV_02_START_VUS=1` | `RV_02_PRELAUNCH_VUS=6` | `RV_02_SPIKE_VUS=36` | `RV_02_RECOVERY_VUS=8` | `RV_02_DURATION_SCALE=0.25` | `RV_02_SLEEP_SECONDS=0.2` | - |
| 03 | `RV_03_START_VUS=1` | `RV_03_MID_VUS=12` | `RV_03_PEAK_VUS=28` | `RV_03_COOLDOWN_VUS=5` | `RV_03_DURATION_SCALE=0.25` | `RV_03_SLEEP_SECONDS=0.5` | - |
| 04 | `RV_04_START_VUS=1` | `RV_04_MID_VUS=8` | `RV_04_PEAK_VUS=18` | n/a | `RV_04_DURATION_SCALE=0.25` | `RV_04_SLEEP_SECONDS=0.8` | - |
| 05 | `RV_05_START_VUS=1` | `RV_05_MID_VUS=5` | `RV_05_PEAK_VUS=14` | n/a | `RV_05_DURATION_SCALE=0.25` | `RV_05_SLEEP_SECONDS=1` | `RV_05_READY_AFTER_MS=50` |
| 06 | `RV_06_START_VUS=1` | n/a | `RV_06_PEAK_VUS=22` | `RV_06_LATE_VUS=8` | `RV_06_DURATION_SCALE=0.25` | `RV_06_SLEEP_SECONDS=0.6` | - |
| 07 | `RV_07_START_VUS=2` | `RV_07_MID_VUS=12` | `RV_07_PEAK_VUS=30` | `RV_07_LATE_VUS=8` | `RV_07_DURATION_SCALE=0.25` | `RV_07_SLEEP_SECONDS=0.5` | - |

Caveat:

```text
Đổi duration scale làm timeline ngắn/dài khác đi.
Đổi sleep làm iter/s/RPS thay đổi.
Đổi VU targets làm chart VUs vs iter/s đổi shape.
```

## What to collect when backend scripts are available

| Nhóm | Cần lấy |
| --- | --- |
| Run identity | run ID, command, env overrides, exit code |
| Scenario header | executor, startVUs, stages, gracefulRampDown |
| Thresholds | `checks`, `http_req_failed`, `ramping_active_iterations_failed` |
| Counters | `iterations`, `http_reqs`, `ramping_active_iterations`, `ramping_api_calls_total` |
| Trends | `ramping_flow_duration_ms`, `http_req_duration` by operation |
| Gauges | `vus`, `vus_max` |
| Dashboard | VU shape, iter/s shape, response time by operation, failure clusters |

<!-- LATEST_RERUN_START -->
## Latest rerun snapshot — 2026-06-20

Rerun command pattern used for all cases:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:K6_CLOUD_METRIC_PUSH_INTERVAL = "1s"
$env:K6_CLOUD_AGGREGATION_PERIOD = "1s"
$env:K6_CLOUD_AGGREGATION_WAIT_PERIOD = "2s"
k6 run -o cloud --summary-export <tmp.json> --summary-trend-stats "avg,min,med,max,p(90),p(95),p(99)" .\load-target\k6amping-vus\<script>.js
```

| Case | Run ID | Exit | Verdict | Key summary |
| --- | ---: | ---: | --- | --- |
| 01 Daily traffic curve | 40 | 99 | **FAIL** | checks 96.54%, http_failed 3.45%, failed_iters 254 |
| 02 Campaign launch spike | 41 | 99 | **FAIL** | checks 86.61%, http_failed 13.38%, failed_iters 2313 |
| 03 Login wave | 42 | 0 | **PASS** | checks 100.00%, http_failed 0.00%, failed_iters 0 |
| 04 Checkout ramp | 43 | 0 | **PASS** | checks 100.00%, http_failed 0.00%, failed_iters 0 |
| 05 Reporting ramp | 44 | 99 | **FAIL** | checks 75.00%, http_failed 0.00%, failed_iters 105 |
| 06 Cart recovery wave | 45 | 0 | **PASS** | checks 100.00%, http_failed 0.00%, failed_iters 0 |
| 07 Production traffic curve | 46 | 99 | **FAIL** | checks 98.41%, http_failed 1.58%, failed_iters 66 |

Backend/script issues found in this rerun:

| Area | Evidence | Suggested fix |
| --- | --- | --- |
| Products list rate-limit/capacity | Cases 01/02/07 have `GET /api/sim/products` 429 rows. | Decide contract: if default practice should pass, raise/tune product list limit/cache; if 429 is intentional, change expected status/threshold and docs. |
| Reporting job status contract | Case 05 `reporting_ramp_create_job` returns 202 but script checks 200. | Update `rv-05-reporting-ramp.js` to pass expected status 202 to `requestJson`, then parse `data.job_id` and execute status check. |

Use the per-case `Real run` section for detailed summary -> 3 chart analysis.
<!-- LATEST_RERUN_END -->

## Cách đọc kết quả chung

Đọc theo thứ tự:

```text
1. Header có đúng executor ramping-vus không?
2. startVUs/stages/gracefulRampDown có đúng config/env không?
3. VUs chart có đi theo stage shape không?
4. Thresholds checks/http_req_failed/ramping_active_iterations_failed có pass không?
5. iterations/RPS/http_reqs là bao nhiêu? Nhớ đây là output.
6. ramping_flow_duration_ms có tăng ở stage nào không?
7. Nếu VUs tăng mà iter/s flatten, operation nào kéo latency?
8. Ramp-down có interrupted/grace effect không?
```

Không đọc:

```text
iterations phải bằng target cố định
RPS phải bằng target cố định
stage target là số VUs cộng thêm
```

## Debug khi fail

| Tín hiệu | Nghĩa thường gặp | Hành động |
| --- | --- | --- |
| VUs không theo stage shape | config/env/dashboard ingestion issue | Kiểm `startVUs`, `stages`, duration scale |
| `ramping_active_iterations_failed` tăng | user-loop failure | Lọc theo `operation`, `user_id` |
| `http_req_failed` tăng | HTTP/API failures | Xem status code/service |
| VUs tăng nhưng iter/s không tăng | saturation/backpressure | So `ramping_flow_duration_ms`, operation latency |
| Failures chỉ ở peak | capacity limit ở high concurrency | Investigate service at peak VUs |
| Ramp-down interrupted | gracefulRampDown quá ngắn hoặc loop dài | Tăng grace hoặc tối ưu flow |
| Operation mix lệch | weightedPick/modulo/run quá ngắn | Validate tags và logic |

## Dashboard checklist

```text
[ ] VUs có follow expected stage shape không?
[ ] Peak VUs có đạt gần target không?
[ ] iter/s là output, không bị đọc nhầm thành target không?
[ ] Response time đã tách theo service/operation chưa?
[ ] Failures có cluster ở ramp-up/peak/ramp-down không?
[ ] VUs rising + iter/s flatten có được phân tích như backpressure không?
[ ] gracefulRampDown/tail behavior có bị đọc nhầm thành backend fail không?
```

## Reference

- Overview: `./00_overview.md`
- Ramping-vus quick index: `../../20260517_01_ramping-vus-quick-index.md`
- Tham số/công thức: `../../20260517_02_ramping-vus-tham-so-cong-thuc.md`
- Worked example: `../../20260517_03_ramping-vus-quickpizza-two-requests-worked-example.md`
