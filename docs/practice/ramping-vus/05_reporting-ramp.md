# Case 05: Reporting ramp

## Tình huống thực tế

Backoffice users vào đầu ngày và mở report dashboard. Một phần loops tạo report jobs và poll status.

Report workload thường low VU nhưng heavy: DB rows, gzip, async job readiness.

Case này trả lời: report service có chịu được staff ramp 1 -> 5 -> 14 -> 1 không?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 1 -> 5 -> 14 -> 1
Scenario: reporting_ramp
Exec function: reportingRamp
Team/service focus: report/backoffice
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 1 -> 5 -> 14 -> 1,
latency/failures/iter-s/RPS phản ứng như thế nào?
```

## Yêu cầu cứng của case này

- Dashboard runs every loop; create/status are conditional.
- READY_AFTER_MS intentionally extends flow duration.
- Missing job ID must count as failed iteration.
- Do not dismiss low VUs as irrelevant; report path can be heavy.

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

## Vì sao "Reporting ramp" nên dùng `ramping-vus`?

Reporting ramp mô phỏng con người vào backoffice theo giờ làm. `ramping-vus` đúng vì active staff users thay đổi theo time curve.

Mental model:

```text
Active VUs follow stage timeline.
Each active VU loops the business flow sequentially.
Backend latency changes completed loop rate.
```

## Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho staged active users? |
| --- | --- | --- |
| `ramping-vus` | Active users thay đổi theo thời gian | **Đúng**: input là timeline VU, output là latency/iter-s/RPS theo từng phase. |
| `constant-vus` | Cũng là closed model active users | Sai nếu traffic phải rise/peak/cooldown; `constant-vus` giữ VUs phẳng. |
| `shared-iterations` | Có nhiều VU cùng chạy | Sai nếu không có fixed backlog cần drain đủ. |
| `per-vu-iterations` | VU identity ổn định | Sai nếu không cần mỗi VU chạy đúng N vòng; stage duration mới là input chính. |
| `constant-arrival-rate` | Giữ rate ổn định | Sai nếu requirement là active users, không phải arrivals/s. |
| `ramping-arrival-rate` | Cũng có time-shaped load | Close cousin nhưng input là arrivals/s, không phải active VU pool. |

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
RV_05_START_VUS = 1
RV_05_MID_VUS = 5
RV_05_PEAK_VUS = 14
RV_05_DURATION_SCALE = 0.25
RV_05_SLEEP_SECONDS = 1
RV_05_READY_AFTER_MS = 50
gracefulRampDown = 20s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_05_START_VUS | 1 | stage/control knob |
| RV_05_MID_VUS | 5 | stage/control knob |
| RV_05_PEAK_VUS | 14 | stage/control knob |
| RV_05_DURATION_SCALE | 0.25 | stage/control knob |
| RV_05_SLEEP_SECONDS | 1 | stage/control knob |
| RV_05_READY_AFTER_MS | 50 | stage/control knob |
| gracefulRampDown | 20s | stage/control knob |

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 60s | 15s | 5 | staff arriving |
| 2 | 90s | 23s | 14 | backoffice peak |
| 3 | 120s | 30s | 14 | sustained report usage |
| 4 | 60s | 15s | 1 | drain |

Lưu ý:

```text
effective duration = scaleSeconds(raw_seconds, RV_NN_DURATION_SCALE)
scaleSeconds = max(1, round(raw_seconds * scale)) seconds
```

`stage.target` là absolute VU target ở cuối stage.

## Technical semantics: staged active pool, closed model, graceful ramp-down

Trong ramping-vus:

```text
startVUs = active users at scenario start
stages[].target = absolute active user target at stage end
stages[].duration = time to move from previous target to new target
gracefulRampDown = grace when VUs are stopped during ramp-down
```

Không có fixed target cho:

```text
iterations
http_reqs
RPS
iter/s
```

Nếu VUs tăng nhưng iter/s không tăng:

```text
ramping_flow_duration_ms có thể đã tăng
backend/service có thể đã saturated
```

Nếu VUs giảm nhưng iterations vẫn hoàn tất thêm:

```text
gracefulRampDown có thể đang cho in-flight loops finish
```

## Technical root causes this case catches

### Nguyên nhân kỹ thuật 1: Dashboard every loop

Dashboard read dominates count and user-perceived backoffice UX.

### Nguyên nhân kỹ thuật 2: Ready wait extends flow duration

`RV_05_READY_AFTER_MS` làm loop lâu hơn có chủ ý; khi tăng env này, iter/s giảm là expected.

### Nguyên nhân kỹ thuật 3: Missing job ID is business failure

HTTP 202 không đủ nếu create response không trả job id để status check.

### Nguyên nhân kỹ thuật 4: Low VU high cost

14 report users có thể đủ tạo DB/gzip/report pressure lớn.

## Service/API flow

Flow pattern:

```text
Dashboard every iteration; create job every third iteration; wait ready_after; status check if job created.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| reporting_ramp_dashboard | report-service | GET | /api/sim/report | 200 | Report dashboard. |
| reporting_ramp_create_job | report-service | POST | /api/sim/report/jobs | 202 | Create async report job. |
| reporting_ramp_job_status | report-service | GET | /api/sim/report/jobs/:id | 200 | Check report job status. |

## Metrics và tags cần đọc

| Metric | Type | Cách đọc |
| --- | --- | --- |
| `ramping_active_iterations` | Counter | Số user loops hoàn tất trong staged run. Đây là output, không phải target. |
| `ramping_active_iterations_failed` | Counter | Số loops có ít nhất một API required fail. Đây là business-flow failure counter. |
| `ramping_api_calls_total` | Counter | Tổng API calls do ramping user pool tạo ra. Dùng để sanity check operation mix. |
| `ramping_flow_duration_ms` | Trend | End-to-end duration của một user loop. Metric chính để giải thích iter/s flatten. |
| `ramping_sleep_seconds` | Counter | Think time/sleep do script cố ý thêm. |
| `checks` | Rate | API/status/contract checks pass bao nhiêu %. |
| `http_req_failed` | Rate | HTTP/network/protocol failure rate theo k6. |
| `iterations` | Counter | Số vòng `default()` hoàn tất; observed output. |
| `vus` | Gauge | Active VUs sampled over time; phải đi theo stage shape. |
| `vus_max` | Gauge | Max VUs observed/reserved, dùng để đối chiếu peak target. |

Tags chung:

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `rv-02-campaign-launch-spike`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service được gọi. |
| `operation` | Operation cụ thể trong user loop. |
| `endpoint` | Nhóm endpoint/API family. |
| `user_id` | Active user identity derive từ VU/user context. |
| `executor_family` | `ramping_vus`. |
| `workload_shape` | `staged_concurrency`. |

Tags case này:

```text
case_id       = rv-05-reporting-ramp
business_case = backoffice_reporting_ramp
workload      = staged_concurrency
```

## Pass criteria

Thresholds theo backend script:

```text
checks: rate>0.99
http_req_failed: rate<0.01
ramping_active_iterations_failed: count<15
```

Các counters/trends cần sanity check:

```text
ramping_active_iterations
ramping_active_iterations_failed
ramping_api_calls_total
ramping_flow_duration_ms
ramping_sleep_seconds
iterations
http_reqs
vus / vus_max
```

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-05-reporting-ramp.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6
amping-vus\rv-05-reporting-ramp.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6
amping-vus\rv-05-reporting-ramp.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = reporting_ramp
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 1 -> 5 -> 14 -> 1
```

`vus_max` nên gần peak target nếu run đủ dài và dashboard sample bắt được peak.

### Bước 3 — Check failures trước throughput

Đọc trước:

```text
checks
http_req_failed
ramping_active_iterations_failed
```

Nếu failures fail threshold, xử lý correctness/API failure trước khi bàn throughput.

### Bước 4 — Interpret counters as outputs

Đọc:

```text
iterations
http_reqs
ramping_active_iterations
ramping_api_calls_total
```

Nhớ:

```text
iterations/RPS là output, không có exact expected target.
```

### Bước 5 — Interpret duration/throughput

Đọc:

```text
ramping_flow_duration_ms
http_req_duration by operation
iteration_duration
```

Case-specific notes:

- Dashboard count sẽ cao hơn create/status vì jobs conditional.
- `ramping_flow_duration_ms` bao gồm ready wait khi job branch chạy.
- Nếu iter/s thấp nhưng checks pass, kiểm sleep/ready_after trước khi kết luận backend fail.

<!-- REAL_RUN_START -->
## Real run 2026-06-20 — run #44

Run này dùng default env của case:

```text
BASE_URL = http://localhost:80
K6_CLOUD_HOST = http://localhost:18080
K6_CLOUD_METRIC_PUSH_INTERVAL = 1s
K6_CLOUD_AGGREGATION_PERIOD = 1s
K6_CLOUD_AGGREGATION_WAIT_PERIOD = 2s
```

| Item | Value |
| --- | --- |
| Script | `rv-05-reporting-ramp.js` |
| Run ID | `44` |
| Exit code | `99` |
| Verdict | **FAIL** — Không đạt |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `1 -> 5 -> 14 -> 1` |
| Observed `vus` min/max | 1 / 14 |

### Summary thật của run

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 75.00% (315/420) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/420) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 105 | User-loop failures của case. |
| `iterations` | 315 (3.75/s) | Output, không phải target. |
| `http_reqs` | 420 (5.00/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 315 | Completed user loops. |
| `ramping_api_calls_total` | 420 | Custom API counter, phải khớp `http_reqs` trong case này. |
| `ramping_sleep_seconds` | 315.0s | Think time do script thêm. |
| `http_req_duration` | avg 1.15s, p95 2.61s, p99 2.90s, max 3.30s | Request-level latency. |
| `ramping_flow_duration_ms` | avg 1.53s, p95 2.80s, p99 3.18s, max 3.60s | Full user-loop latency. |
| `iteration_duration` | avg 2.53s, p95 3.80s, p99 4.18s, max 4.60s | Bao gồm flow + think/sleep. |

Threshold failures:

- checks 75.00% <= required 99%
- ramping_active_iterations_failed 105 >= limit 15

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `reporting_ramp_dashboard` | GET | 200 | 315 | 75.00% |
| `reporting_ramp_create_job` | POST | 202 | 105 | 25.00% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

HTTP p95 2.61s, p99 2.90s; flow p95 2.80s. Reporting là workload heavy nên latency cao, nhưng lỗi chính là status expectation mismatch chứ không phải HTTP transport failure (`http_req_failed=0`).

Chart aggregates của run:

| Aggregate | Value |
| --- | ---: |
| Response-time points | 420 |
| Avg của các window avg | 1.15s |
| Max window p95 | 3.30s |
| Max window p99 | 3.30s |
| Max request window | 3.30s |
| Windows p95 > 100ms | 382 |
| Windows p95 > 500ms | 239 |

#### 2. Execution timeline chart

Execution timeline có 105 failed iterations đúng bằng số `reporting_ramp_create_job` calls. Không có `reporting_ramp_job_status` trong request breakdown vì script chỉ parse job_id khi `create.ok` true; status 202 làm `create.ok=false`.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 315 |
| Sum `http_reqs` buckets | 420 |
| Peak iter/s bucket | 6 |
| Peak http_req/s bucket | 9 |
| Failed-iteration points | 105 |
| Sum failed iterations | 105 |
| Peak failed-iteration bucket | 3 |

#### 3. VUs vs iter/s chart

VU series đạt peak 14 VUs, peak iter/s bucket 6 và peak http_req/s bucket 9. Low VU nhưng flow heavy/ready wait làm iter/s thấp — expected với reporting.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 83 |
| VUs min/max series | 1 / 14 |
| Avg VUs series | 9.60 |
| Peak iter/s bucket | 6 |

### Kết luận riêng của run #44

Run fail vì contract script/backend không khớp ở create report job. Endpoint trả HTTP 202 nhưng helper đang check status 200, nên 105 create-job checks fail và không gọi status endpoint.

BE note:

> BE/script pack cần sửa `rv-05-reporting-ramp.js`: `requestJson(... reporting_ramp_create_job ...)` phải truyền expectedStatus `202` hoặc helper phải cho phép 202. Sau đó script mới parse `data.job_id` và gọi `reporting_ramp_job_status`. Nếu API contract thật là 200 thì backend phải đổi endpoint; nhưng docs/case flow hiện ghi expected 202.
<!-- REAL_RUN_END -->

## Đọc dashboard real-time charts cho case 05

> Phần này giữ cách đọc dashboard chung; số thật của run gần nhất nằm ở section `Real run` phía trên.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm theo phase? | Fixed iteration target |
| Execution timeline | VUs/failures/RPS thay đổi theo stage nào? | Target RPS, vì không có target RPS |
| VUs vs iter/s | VU shape có đúng không, iter/s có flatten không? | Business correctness nếu không đọc failures |

### Chart 1 — Response time

Đọc theo `operation`:

```text
reporting_ramp_dashboard: GET /api/sim/report
reporting_ramp_create_job: POST /api/sim/report/jobs
reporting_ramp_job_status: GET /api/sim/report/jobs/:id
```

Cách đọc:

```text
ramp-up phase: latency có tăng khi VUs tăng không?
peak/plateau: p95/p99 có ổn định không?
ramp-down/recovery: latency có giảm lại không?
```

Case-specific hints:

- Response time: dashboard vs create/status.
- Execution timeline: create/status spikes every third iteration pattern.
- VUs vs iter/s: low VU but heavy flow can still flatten iter/s at peak.

### Chart 2 — Execution timeline

Với ramping-vus:

```text
VUs should follow 1 -> 5 -> 14 -> 1.
iterations/http_reqs per bucket are outputs.
failures may cluster at ramp transitions or peak.
```

Không kỳ vọng exact per-bucket counts, đặc biệt với weighted/conditional flows.

### Chart 3 — VUs vs iter/s

Expected:

```text
VUs: ramp/plateau/ramp-down theo stages
iter/s: tăng theo VUs nếu backend còn capacity
iter/s: flatten/fall nếu flow duration tăng hoặc backend saturated
```

Bad/important shapes:

| Shape | Nghĩa |
| --- | --- |
| VUs follow stages, iter/s follows roughly | Healthy scaling shape |
| VUs rise, iter/s flat | Possible saturation/backpressure |
| VUs fall, iterations continue briefly | gracefulRampDown behavior |
| VUs not matching stages | Config/env/dashboard issue |

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận thresholds/failures.
2. VUs vs iter/s xác nhận stage shape và saturation signal.
3. Execution timeline xác nhận failures/throughput cluster ở phase nào.
4. Response time by operation tìm service/branch chậm.
5. Business decision dựa trên phase + operation + failure pattern.
```

## Kết luận thực tế: output -> quyết định

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| Clean reporting ramp | Backoffice start acceptable | Accept |
| Dashboard slow only | Report read/query/cache issue | Investigate dashboard |
| Job create/status failures | Async report pipeline issue | Block report release |
| Low iter/s clean checks | Heavy flow or ready wait | Interpret with READY_AFTER_MS |

## Nghịch lý và misconceptions của ramping-vus

Đừng coi report ramp là shared report export backlog. Đây là active staff users over time.

Nhớ 3 câu:

```text
stage target = absolute VU target, không phải delta
iterations/RPS = output, không phải input
VUs tăng mà iter/s flatten = tín hiệu backpressure đáng đọc
```

## Mở rộng

- Tăng duration scale để chạy gần business timeline hơn.
- Tăng peak VUs để tìm capacity knee.
- Tăng/giảm sleep để xem think time ảnh hưởng iter/s.
- Thêm threshold theo operation p95 nếu muốn biến case thành gate.
- Sau khi chạy thật, thêm real-run section riêng có command/env/run ID/số summary.

## Anti-pattern

- Đọc `stage.target` như số VUs cộng thêm.
- Kỳ vọng fixed RPS từ `ramping-vus`.
- Dùng total `iterations` làm pass/fail target.
- Bỏ qua `gracefulRampDown` khi thấy tail iterations.
- Chỉ nhìn aggregate p95 trong mixed/conditional flow.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với flat active users của `constant-vus`.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Ramping-vus quick index: `../../20260517_01_ramping-vus-quick-index.md`
- Tham số/công thức: `../../20260517_02_ramping-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-05-reporting-ramp.js`
