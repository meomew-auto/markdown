# Run Guide — constant-vus practice

> File này dùng chung cho 7 case `constant-vus`. Mỗi case có thêm giải thích nghiệp vụ, formula, output reading và dashboard checklist riêng.

## Important: real runs are optional

Docs trong series này hiện giải thích **semantics + backend contract**.

Backend scripts được user tạo ở repo nested:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\
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

Bash:

```bash
export BASE_URL=http://localhost:80
export K6_CLOUD_HOST=http://localhost:18080
export K6_CLOUD_TOKEN=student-token-1234567890
```

## Case catalog cho FE/learner

FE đọc contract ở:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\case-catalog.json
```

Field cần dùng:

| Field | Ý nghĩa |
| --- | --- |
| `id` | ID case, ví dụ `cv-01-business-hours-storefront` |
| `script` | Script k6 tương ứng |
| `title` | Tên case hiển thị |
| `businessCase` | Tình huống nghiệp vụ |
| `whyConstantVus` | Lý do chọn executor này |
| `defaultConfig.vus` | Active VUs mặc định |
| `defaultConfig.duration` | Observation window mặc định |
| `calls[]` | Service/API/method/path/query/body/header/status expected |

## Run pattern chung

Local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js
```

Private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js
```

Nếu dùng wrapper push final summary, ưu tiên wrapper để dashboard summary khớp CLI summary.

## Commands từng case

| Case | Script | Command |
| --- | --- | --- |
| 01 Business-hours storefront | `cv-01-business-hours-storefront.js` | `k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js` |
| 02 Session keepalive | `cv-02-session-keepalive.js` | `k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-02-session-keepalive.js` |
| 03 Active cart editing | `cv-03-active-cart-editing.js` | `k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-03-active-cart-editing.js` |
| 04 Checkout trickle | `cv-04-checkout-trickle.js` | `k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-04-checkout-trickle.js` |
| 05 Personalized homefeed | `cv-05-personalized-homefeed.js` | `k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-05-personalized-homefeed.js` |
| 06 Backoffice report users | `cv-06-backoffice-report-users.js` | `k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-06-backoffice-report-users.js` |
| 07 Production mixed baseline | `cv-07-production-mixed-baseline.js` | `k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-07-production-mixed-baseline.js` |

## Env override nhanh

| Case | VUs | Duration | Extra |
| --- | --- | --- | --- |
| 01 | `CV_01_VUS` | `CV_01_DURATION` | `CV_01_SLEEP_SECONDS` |
| 02 | `CV_02_VUS` | `CV_02_DURATION` | `CV_02_SLEEP_SECONDS` |
| 03 | `CV_03_VUS` | `CV_03_DURATION` | `CV_03_SLEEP_SECONDS` |
| 04 | `CV_04_VUS` | `CV_04_DURATION` | `CV_04_SLEEP_SECONDS` |
| 05 | `CV_05_VUS` | `CV_05_DURATION` | `CV_05_SLEEP_SECONDS` |
| 06 | `CV_06_VUS` | `CV_06_DURATION` | `CV_06_READY_AFTER_MS`, `CV_06_SLEEP_SECONDS` |
| 07 | `CV_07_VUS` | `CV_07_DURATION` | `CV_07_SLEEP_SECONDS` |

Ví dụ chạy ngắn để demo:

```powershell
$env:CV_01_VUS = "5"
$env:CV_01_DURATION = "30s"
$env:CV_01_SLEEP_SECONDS = "0.2"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js
```

Caveat:

```text
Đổi sleep/duration/VUs sẽ làm iterations/RPS/http_reqs đổi.
Đừng so total iteration count giữa 2 run nếu config/think time khác nhau.
```

## Real run collection workflow used

Default full suite runtime:

```text
7 cases × 5m ≈ 35 minutes, plus summary-final push/API collection.
```

For the latest default run, collection used:

```text
K6_CLOUD_HOST=http://localhost:18080
Dashboard/API validation=http://localhost:13001/v1/tests/<run_id>/...
summary-final POST=/v1/tests/<run_id>/summary-final
finish POST=/v1/tests/<run_id> {"status":"finished"}
```

Collected files for audit/debug:

```text
E:\Khoa hoc\k6\.claude-constant-vus-run-results.json
E:\Khoa hoc\k6\.claude-constant-vus-analysis.json
E:\Khoa hoc\k6\.claude-constant-vus-chart-summary.json
```

When updating docs, only copy numbers from real run records. Do not assume `iterations` or RPS targets for `constant-vus`; they are observed outputs.

## Real run collection workflow used

Default full suite runtime:

```text
7 cases × 5m ≈ 35 minutes, plus summary-final push/API collection.
```

For the latest default run, collection used:

```text
K6_CLOUD_HOST=http://localhost:18080
Dashboard/API validation=http://localhost:13001/v1/tests/<run_id>/...
summary-final POST=/v1/tests/<run_id>/summary-final
finish POST=/v1/tests/<run_id> {"status":"finished"}
```

Important contract update for the latest run:

```text
constant-vus common request helper now sends X-User-ID: ctx.userId when userId is present.
This maps simulated users to products-service rate-limit identity instead of falling back to ClientIP.
```

Collected files for audit/debug:

```text
E:\Khoa hoc\k6\.claude-constant-vus-fixed-run-results.json
E:\Khoa hoc\k6\.claude-constant-vus-fixed-analysis.json
E:\Khoa hoc\k6\.claude-constant-vus-fixed-chart-summary.json
```

When updating docs, only copy numbers from real run records. Do not assume `iterations` or RPS targets for `constant-vus`; they are observed outputs.

## What to collect when backend scripts are available

| Nhóm | Cần lấy |
| --- | --- |
| Run identity | run ID, command, env overrides, exit code |
| Scenario header | executor, VUs, duration, gracefulStop nếu có |
| Summary counters | `iterations`, `http_reqs`, `checks`, `http_req_failed` |
| Constant metrics | `constant_active_iterations`, `constant_active_iterations_failed`, `constant_api_calls_total`, `constant_flow_duration_ms`, `constant_sleep_seconds` |
| Operation breakdown | count/latency theo `service`, `operation`, status code |
| Dashboard Response time | avg/p95/p99/max theo operation |
| Dashboard Execution timeline | VUs, iter/s, RPS, failures over time |
| Dashboard VUs vs iter/s | flat VU shape, iter/s drop/spike, tail behavior |

## Cách đọc kết quả chung

Đọc theo thứ tự:

```text
1. Header có đúng executor constant-vus không?
2. VUs/duration có đúng config/env không?
3. VUs có flat trong dashboard regular phase không?
4. thresholds checks/http_req_failed/constant_active_iterations_failed có pass không?
5. iterations/RPS/http_reqs là bao nhiêu? Nhớ đây là output.
6. constant_flow_duration_ms tăng/giảm như thế nào?
7. operation nào kéo latency hoặc failed loops?
8. Nếu RPS giảm, có phải do flow duration/backend latency tăng không?
```

Không đọc:

```text
iterations phải bằng một target cố định
RPS phải bằng một target cố định
mỗi VU phải chạy đúng N vòng
```

## Debug khi fail

| Tín hiệu | Nghĩa thường gặp | Hành động |
| --- | --- | --- |
| `http_req_failed` tăng | HTTP non-2xx/network issue | Xem status code và operation |
| `constant_active_iterations_failed` tăng | User loop fail ở business/API required step | Lọc theo `operation`, `user_id` |
| VUs không flat | Config/dashboard/VU scheduling issue | Kiểm scenario, max VUs, ingestion |
| VUs flat nhưng iter/s giảm | Closed-model slowdown | So `constant_flow_duration_ms`, `http_req_duration` |
| Aggregate p95 cao | Có thể do một branch nhỏ rất chậm | Breakdown theo service/operation |
| Total iterations thấp hơn run cũ | Có thể latency/sleep tăng | So config + flow duration trước khi kết luận fail |

## Dashboard checklist

```text
[ ] VUs có phẳng gần configured VUs không?
[ ] iter/s/RPS là output, không bị đọc nhầm thành target không?
[ ] Response time đã tách theo service/operation chưa?
[ ] constant_flow_duration_ms có tăng bất thường không?
[ ] constant_active_iterations_failed có gần 0 / dưới threshold không?
[ ] Operation mix có đúng kỳ vọng với case mixed không?
[ ] Nếu RPS giảm, đã kiểm latency/think time chưa?
```

## Reference

- Overview: `./00_overview.md`
- Constant-vus quick index: `../../20260516_01_constant-vus-quick-index.md`
- Tham số/công thức: `../../20260516_02_constant-vus-tham-so-cong-thuc.md`
- Worked example: `../../20260516_03_constant-vus-quickpizza-two-requests-worked-example.md`
