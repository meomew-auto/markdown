# Case 03: Login wave

## Tình huống thực tế

Đầu ngày làm việc, users vào hệ thống theo wave: bắt đầu ít, tăng nhanh, rồi settle xuống số sessions thấp hơn.

Auth service phải xử lý login, session validation, refresh theo active pool đang tăng.

Case này trả lời: auth có chịu được 1 -> 12 -> 28 -> 5 VUs và ổn định ở plateau không?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 1 -> 12 -> 28 -> 5
Scenario: login_wave
Exec function: loginWave
Team/service focus: auth/session
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 1 -> 12 -> 28 -> 5,
latency/failures/iter-s/RPS phản ứng như thế nào?
```

## Yêu cầu cứng của case này

- Auth stage shape phải rise/peak/cooldown.
- `auth/me` chạy mỗi loop; login/refresh là conditional.
- Không đọc login count bằng iterations count.
- Session failures phải thấp hơn cap.

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

## Vì sao "Login wave" nên dùng `ramping-vus`?

Login wave là active session pool thay đổi theo thời gian. `ramping-vus` đúng vì input là active sessions curve, không phải fixed login RPS hay fixed session backlog.

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
RV_03_START_VUS = 1
RV_03_MID_VUS = 12
RV_03_PEAK_VUS = 28
RV_03_COOLDOWN_VUS = 5
RV_03_DURATION_SCALE = 0.25
RV_03_SLEEP_SECONDS = 0.5
gracefulRampDown = 15s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_03_START_VUS | 1 | stage/control knob |
| RV_03_MID_VUS | 12 | stage/control knob |
| RV_03_PEAK_VUS | 28 | stage/control knob |
| RV_03_COOLDOWN_VUS | 5 | stage/control knob |
| RV_03_DURATION_SCALE | 0.25 | stage/control knob |
| RV_03_SLEEP_SECONDS | 0.5 | stage/control knob |
| gracefulRampDown | 15s | stage/control knob |

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 60s | 15s | 12 | workday arrivals |
| 2 | 60s | 15s | 28 | login peak |
| 3 | 90s | 23s | 28 | session plateau |
| 4 | 60s | 15s | 5 | cooldown |

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

### Nguyên nhân kỹ thuật 1: Session validation dominates

`auth/me` chạy mỗi loop, nên nó thường dominate count và latency.

### Nguyên nhân kỹ thuật 2: Login/refresh counts are conditional

Login mỗi 3rd và refresh mỗi 5th iteration; count thấp hơn iterations là expected.

### Nguyên nhân kỹ thuật 3: Auth state under rising sessions

Token/session/cache bugs thường lộ khi active sessions tăng nhanh.

### Nguyên nhân kỹ thuật 4: Peak plateau verifies stabilization

Giữ 28 VUs một đoạn để xem auth recover/stabilize hay tiếp tục degrade.

## Service/API flow

Flow pattern:

```text
Login every third iteration; auth/me every iteration; refresh every fifth iteration.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| login_wave_login | auth-service | POST | /api/sim/auth/login | 200 | Login branch. |
| login_wave_me | auth-service | GET | /api/sim/auth/me | 200 | Session validation every loop. |
| login_wave_refresh | auth-service | POST | /api/sim/auth/refresh | 200 | Refresh branch. |

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
case_id       = rv-03-login-wave
business_case = morning_login_wave
workload      = staged_concurrency
```

## Pass criteria

Thresholds theo backend script:

```text
checks: rate>0.99
http_req_failed: rate<0.01
ramping_active_iterations_failed: count<20
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
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-03-login-wave.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6
amping-vus\rv-03-login-wave.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6
amping-vus\rv-03-login-wave.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = login_wave
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 1 -> 12 -> 28 -> 5
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

- Login/refresh không phải count bằng iterations.
- `login_wave_me` latency tăng thường là session store/cache issue.
- Failures ở refresh có thể không hiện trong aggregate nếu count nhỏ; phải lọc operation.

<!-- REAL_RUN_START -->
## Real run 2026-06-20 — run #42

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
| Script | `rv-03-login-wave.js` |
| Run ID | `42` |
| Exit code | `0` |
| Verdict | **PASS** — Đạt |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `1 -> 12 -> 28 -> 5` |
| Observed `vus` min/max | 1 / 28 |

### Summary thật của run

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 100.00% (3886/3886) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/3886) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 0 | User-loop failures của case. |
| `iterations` | 2534 (37.02/s) | Output, không phải target. |
| `http_reqs` | 3886 (56.77/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 2534 | Completed user loops. |
| `ramping_api_calls_total` | 3886 | Custom API counter, phải khớp `http_reqs` trong case này. |
| `ramping_sleep_seconds` | 1267.0s | Think time do script thêm. |
| `http_req_duration` | avg 5.17ms, p95 22.9ms, p99 23.5ms, max 33.9ms | Request-level latency. |
| `ramping_flow_duration_ms` | avg 8.05ms, p95 27.0ms, p99 29.0ms, max 48.0ms | Full user-loop latency. |
| `iteration_duration` | avg 508ms, p95 528ms, p99 530ms, max 549ms | Bao gồm flow + think/sleep. |

Threshold failures:

Không có threshold failure.

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `login_wave_me` | GET | 200 | 2534 | 65.21% |
| `login_wave_login` | POST | 200 | 845 | 21.74% |
| `login_wave_refresh` | POST | 200 | 507 | 13.05% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

HTTP p95 22.87ms, p99 23.47ms; flow p95 27ms. Không thấy tail latency bất thường.

Chart aggregates của run:

| Aggregate | Value |
| --- | ---: |
| Response-time points | 2537 |
| Avg của các window avg | 6.42ms |
| Max window p95 | 33.9ms |
| Max window p99 | 33.9ms |
| Max request window | 33.9ms |
| Windows p95 > 100ms | 0 |
| Windows p95 > 500ms | 0 |

#### 2. Execution timeline chart

Execution timeline không có failed-iteration points. Mix đúng: `auth/me` mỗi iteration, login khoảng mỗi 3 iteration, refresh khoảng mỗi 5 iteration.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 2534 |
| Sum `http_reqs` buckets | 3886 |
| Peak iter/s bucket | 56 |
| Peak http_req/s bucket | 86 |
| Failed-iteration points | 0 |
| Sum failed iterations | 0 |
| Peak failed-iteration bucket | 0 |

#### 3. VUs vs iter/s chart

VU series đạt peak 28 VUs, peak iter/s bucket 56 và peak http_req/s bucket 86. Shape login wave đúng và iter/s scale ổn.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 68 |
| VUs min/max series | 1 / 28 |
| Avg VUs series | 18.94 |
| Peak iter/s bucket | 56 |

### Kết luận riêng của run #42

Run pass sạch: checks 100%, HTTP failed 0%, failed iterations 0. Auth/session wave giữ được contract.

BE note:

> Không cần báo BE bug cho case 03 trong run này.
<!-- REAL_RUN_END -->

## Đọc dashboard real-time charts cho case 03

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
login_wave_login: POST /api/sim/auth/login
login_wave_me: GET /api/sim/auth/me
login_wave_refresh: POST /api/sim/auth/refresh
```

Cách đọc:

```text
ramp-up phase: latency có tăng khi VUs tăng không?
peak/plateau: p95/p99 có ổn định không?
ramp-down/recovery: latency có giảm lại không?
```

Case-specific hints:

- Response time: tách login/me/refresh.
- Execution timeline: login/refresh spikes theo modulo branch.
- VUs vs iter/s: auth latency tăng sẽ làm iter/s flatten ở peak.

### Chart 2 — Execution timeline

Với ramping-vus:

```text
VUs should follow 1 -> 12 -> 28 -> 5.
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
| Clean auth wave | Workday login/session pressure acceptable | Accept |
| auth/me latency rises | Session store/cache/db issue | Investigate read path |
| login/refresh failures | Token issuance/rotation issue | Block auth release |
| Call mix mismatch | Modulo/tag logic issue | Validate script |

## Nghịch lý và misconceptions của ramping-vus

Đừng coi total iterations là số logins. Login là conditional branch, không phải mỗi loop.

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
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-03-login-wave.js`
