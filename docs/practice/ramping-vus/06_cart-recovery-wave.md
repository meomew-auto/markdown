# Case 06: Cart recovery wave

## Tình huống thực tế

Abandoned-cart notification kéo shoppers quay lại trong một wave ngắn. Users mở summary, add item, và đôi khi update item.

Đây không phải steady baseline; đây là notification-driven wave rồi late-stage drain.

Case này trả lời: cart-service có chịu được recovery wave 1 -> 22 -> 8 -> 1 không?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 1 -> 22 -> 8 -> 1
Scenario: cart_recovery_wave
Exec function: cartRecoveryWave
Team/service focus: cart/marketing
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 1 -> 22 -> 8 -> 1,
latency/failures/iter-s/RPS phản ứng như thế nào?
```

## Yêu cầu cứng của case này

- Fast wave lên 22 VUs phải hiện rõ trong chart.
- Summary/add mỗi iteration, update roughly every second iteration.
- Late stage phải cho thấy service recover/drain.
- Header recovery campaign giúp phân biệt traffic này.

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

## Vì sao "Cart recovery wave" nên dùng `ramping-vus`?

Cart recovery là wave shape sau notification batch. `ramping-vus` đúng vì active users surge rồi giảm tự nhiên.

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
RV_06_START_VUS = 1
RV_06_PEAK_VUS = 22
RV_06_LATE_VUS = 8
RV_06_DURATION_SCALE = 0.25
RV_06_SLEEP_SECONDS = 0.6
gracefulRampDown = 15s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_06_START_VUS | 1 | stage/control knob |
| RV_06_PEAK_VUS | 22 | stage/control knob |
| RV_06_LATE_VUS | 8 | stage/control knob |
| RV_06_DURATION_SCALE | 0.25 | stage/control knob |
| RV_06_SLEEP_SECONDS | 0.6 | stage/control knob |
| gracefulRampDown | 15s | stage/control knob |

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 45s | 11s | 22 | notification wave |
| 2 | 120s | 30s | 22 | peak recovery |
| 3 | 90s | 23s | 8 | late recovery |
| 4 | 45s | 11s | 1 | drain |

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

### Nguyên nhân kỹ thuật 1: Notification batch creates a fast wave

Active users jump quickly after notification; constant-vus would miss transition behavior.

### Nguyên nhân kỹ thuật 2: Summary read combines with write pressure

Every loop reads summary and writes add; read/write contention can appear at peak.

### Nguyên nhân kỹ thuật 3: Update count roughly half iterations

Update is conditional every second iteration; do not expect exact every loop.

### Nguyên nhân kỹ thuật 4: Late stage distinguishes normal drain

If latency remains high after VUs fall to 8, suspect persistent degradation/locks.

## Service/API flow

Flow pattern:

```text
Cart summary every iteration; cart add every iteration; cart update every second iteration; header `X-Recovery-Campaign: abandoned-cart`.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| cart_recovery_summary | cart-service | GET | /api/sim/cart/summary | 200 | Read cart summary. |
| cart_recovery_add | cart-service | POST | /api/sim/cart/add | 200 | Add recovery item. |
| cart_recovery_update | cart-service | PATCH | /api/sim/cart/items/:item_id | 200 | Conditional update. |

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
case_id       = rv-06-cart-recovery-wave
business_case = cart_recovery_wave
workload      = staged_concurrency
```

## Pass criteria

Thresholds theo backend script:

```text
checks: rate>0.99
http_req_failed: rate<0.01
ramping_active_iterations_failed: count<25
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
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = cart_recovery_wave
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 1 -> 22 -> 8 -> 1
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

- Summary/add counts should be higher than update count.
- Late-stage latency recovery is as important as peak behavior.
- Failed loops at peak likely indicate cart write/read capacity issue.

<!-- REAL_RUN_START -->
## Real run 2026-06-20 — run #45

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
| Script | `rv-06-cart-recovery-wave.js` |
| Run ID | `45` |
| Exit code | `0` |
| Verdict | **PASS** — Đạt |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `1 -> 22 -> 8 -> 1` |
| Observed `vus` min/max | 2 / 22 |

### Summary thật của run

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 100.00% (4910/4910) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/4910) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 0 | User-loop failures của case. |
| `iterations` | 1964 (26.00/s) | Output, không phải target. |
| `http_reqs` | 4910 (65.01/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 1964 | Completed user loops. |
| `ramping_api_calls_total` | 4910 | Custom API counter, phải khớp `http_reqs` trong case này. |
| `ramping_sleep_seconds` | 1178.4s | Think time do script thêm. |
| `http_req_duration` | avg 3.82ms, p95 5.62ms, p99 9.76ms, max 93.8ms | Request-level latency. |
| `ramping_flow_duration_ms` | avg 9.76ms, p95 13.0ms, p99 29.0ms, max 117ms | Full user-loop latency. |
| `iteration_duration` | avg 610ms, p95 613ms, p99 629ms, max 718ms | Bao gồm flow + think/sleep. |

Threshold failures:

Không có threshold failure.

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `cart_recovery_summary` | GET | 200 | 1964 | 40.00% |
| `cart_recovery_add` | POST | 200 | 1964 | 40.00% |
| `cart_recovery_update` | PATCH | 200 | 982 | 20.00% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

HTTP p95 5.62ms, p99 9.76ms; flow p95 13ms. Cart read/write latency thấp và ổn định.

Chart aggregates của run:

| Aggregate | Value |
| --- | ---: |
| Response-time points | 3228 |
| Avg của các window avg | 3.74ms |
| Max window p95 | 94.0ms |
| Max window p99 | 94.0ms |
| Max request window | 93.8ms |
| Windows p95 > 100ms | 0 |
| Windows p95 > 500ms | 0 |

#### 2. Execution timeline chart

Execution timeline không có failed iterations. Mix đúng: summary/add mỗi iteration, update đúng khoảng một nửa iterations.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 1964 |
| Sum `http_reqs` buckets | 4910 |
| Peak iter/s bucket | 38 |
| Peak http_req/s bucket | 95 |
| Failed-iteration points | 0 |
| Sum failed iterations | 0 |
| Peak failed-iteration bucket | 0 |

#### 3. VUs vs iter/s chart

VU series đạt peak 22 VUs, peak iter/s bucket 38 và peak http_req/s bucket 95. Shape notification wave đúng.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 75 |
| VUs min/max series | 2 / 22 |
| Avg VUs series | 15.96 |
| Peak iter/s bucket | 38 |

### Kết luận riêng của run #45

Run pass sạch: checks 100%, HTTP failed 0%, failed iterations 0. Cart recovery wave ổn.

BE note:

> Không cần báo BE bug cho case 06 trong run này.
<!-- REAL_RUN_END -->

## Đọc dashboard real-time charts cho case 06

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
cart_recovery_summary: GET /api/sim/cart/summary
cart_recovery_add: POST /api/sim/cart/add
cart_recovery_update: PATCH /api/sim/cart/items/:item_id
```

Cách đọc:

```text
ramp-up phase: latency có tăng khi VUs tăng không?
peak/plateau: p95/p99 có ổn định không?
ramp-down/recovery: latency có giảm lại không?
```

Case-specific hints:

- Response time: summary vs add vs update.
- Execution timeline: fast jump to 22 then late fall to 8.
- VUs vs iter/s: if iter/s stays low at late 8 VUs, investigate persistent cart degradation.

### Chart 2 — Execution timeline

Với ramping-vus:

```text
VUs should follow 1 -> 22 -> 8 -> 1.
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
| Clean wave | Recovery campaign safe | Accept |
| Summary slow | Cart read/materialized summary issue | Investigate summary |
| Add/update failures | Cart write path/concurrency issue | Block campaign |
| Recovery stage stays slow | Saturation/lock contention persists | Investigate before next batch |

## Nghịch lý và misconceptions của ramping-vus

Đừng dùng shared-iterations cart cleanup mental model. Đây là wave of active users, không phải fixed list of stale items.

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
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js`
