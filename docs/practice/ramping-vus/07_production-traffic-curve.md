# Case 07: Production traffic curve

## Tình huống thực tế

Sau khi hiểu từng service riêng, platform cần một mixed production-shaped curve để xem toàn hệ thống phản ứng theo traffic curve.

Flow trộn browse, cart, auth, checkout, report. Đây là capstone case cho staged concurrency.

Case này trả lời: mixed services có chịu được 2 -> 12 -> 30 -> 8 -> 2 VUs không, và service nào kéo baseline ở peak?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 2 -> 12 -> 30 -> 8 -> 2
Scenario: production_traffic_curve
Exec function: productionTrafficCurve
Team/service focus: platform/performance/mixed services
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 2 -> 12 -> 30 -> 8 -> 2,
latency/failures/iter-s/RPS phản ứng như thế nào?
```

## Yêu cầu cứng của case này

- Mixed branch ratio phải đọc bằng operation/service tags.
- Thresholds relaxed hơn vì production mix rộng hơn.
- Aggregate p95 phải được breakdown theo service.
- Case này tổng hợp các root causes từ cases 01-06.

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

## Vì sao "Production traffic curve" nên dùng `ramping-vus`?

Production traffic curve cần active user pool thay đổi theo timeline với nhiều service. `ramping-vus` đúng vì input là VU curve, còn service-specific RPS/latency là output.

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
RV_07_START_VUS = 2
RV_07_MID_VUS = 12
RV_07_PEAK_VUS = 30
RV_07_LATE_VUS = 8
RV_07_DURATION_SCALE = 0.25
RV_07_SLEEP_SECONDS = 0.5
gracefulRampDown = 20s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_07_START_VUS | 2 | stage/control knob |
| RV_07_MID_VUS | 12 | stage/control knob |
| RV_07_PEAK_VUS | 30 | stage/control knob |
| RV_07_LATE_VUS | 8 | stage/control knob |
| RV_07_DURATION_SCALE | 0.25 | stage/control knob |
| RV_07_SLEEP_SECONDS | 0.5 | stage/control knob |
| gracefulRampDown | 20s | stage/control knob |

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 60s | 15s | 12 | morning/mid traffic |
| 2 | 90s | 23s | 30 | ramp to peak |
| 3 | 150s | 38s | 30 | sustained peak |
| 4 | 90s | 23s | 8 | late traffic |
| 5 | 45s | 11s | 2 | cooldown |

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

### Nguyên nhân kỹ thuật 1: Mixed traffic hides service bottlenecks

Aggregate metrics không đủ; phải lọc service/operation.

### Nguyên nhân kỹ thuật 2: Browse dominates volume

Browse 50 weight thường chiếm count nhiều nhất, ảnh hưởng average/RPS.

### Nguyên nhân kỹ thuật 3: Checkout/report can dominate tail

Dù weight nhỏ, checkout/report có external/report cost nên kéo p95/p99.

### Nguyên nhân kỹ thuật 4: Relaxed thresholds reflect broader curve

98%/2% thresholds phù hợp mixed production curve hơn strict service isolated case.

### Nguyên nhân kỹ thuật 5: Synthesis after cases 01-06

Case này dùng để so kết quả tổng hợp sau khi đã hiểu từng service/ramp riêng.

## Service/API flow

Flow pattern:

```text
Weighted mixed production flow: browse 50, cart 20, auth 15, checkout 10, report 5.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| production_curve_browse | products-service | GET | /api/sim/products | 200 | Browse branch. |
| production_curve_cart_add | cart-service | POST | /api/sim/cart/add | 200 | Cart branch. |
| production_curve_auth_me | auth-service | GET | /api/sim/auth/me | 200 | Auth/session branch. |
| production_curve_checkout | order-service | POST | /api/sim/checkout | 200 | Checkout branch. |
| production_curve_report | report-service | GET | /api/sim/report | 200 | Report branch. |

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
case_id       = rv-07-production-traffic-curve
business_case = production_traffic_curve
workload      = staged_concurrency
```

## Pass criteria

Thresholds theo backend script:

```text
checks: rate>0.98
http_req_failed: rate<0.02
ramping_active_iterations_failed: count<50
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
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = production_traffic_curve
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 2 -> 12 -> 30 -> 8 -> 2
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

- Branch mix 50/20/15/10/5 là expected ratio over enough loops.
- Aggregate p95 xấu phải breakdown trước khi route issue.
- RPS thấp hơn baseline có thể do một service branch kéo flow duration.

<!-- REAL_RUN_START -->
## Contract rerun 2026-06-20 — run #57

Run này ép đúng contract/tải đã ghi trong tài liệu, kể cả khi backend script default hiện tại đã đổi nhẹ hơn.

```text
BASE_URL=http://localhost:80
K6_CLOUD_HOST=http://localhost:18080
RV_07_START_VUS=2
RV_07_MID_VUS=12
RV_07_PEAK_VUS=30
RV_07_LATE_VUS=8
RV_07_DURATION_SCALE=0.25
RV_07_SLEEP_SECONDS=0.5
```

| Item | Value |
| --- | --- |
| Script | `rv-07-production-traffic-curve.js` |
| Run ID | `57` |
| Exit code | `0` |
| Verdict | **PASS** — Đạt theo contract gốc |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `2 -> 12 -> 30 -> 8 -> 2` |
| Observed `vus` min/max | 2 / 30 |

### Summary thật của contract rerun

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 100.00% (4171/4171) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/4171) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 0 | User-loop failures của case. |
| `iterations` | 4171 (37.75/s) | Output, không phải target. |
| `http_reqs` | 4171 (37.75/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 4171 | Completed user loops. |
| `ramping_api_calls_total` | 4171 | Custom API counter. |
| `ramping_sleep_seconds` | 2085.5s | Think time do script thêm. |
| `http_req_duration` | avg 33.3ms, p95 153ms, p99 683ms, max 1.41s | Request-level latency. |
| `ramping_flow_duration_ms` | avg 33.4ms, p95 154ms, p99 683ms, max 1.41s | Full user-loop latency. |
| `iteration_duration` | avg 534ms, p95 653ms, p99 1.18s, max 1.91s | Bao gồm flow + think/sleep. |

Threshold failures:

Không có threshold failure.

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `production_curve_browse` | GET | 200 | 2068 | 49.58% |
| `production_curve_cart_add` | POST | 200 | 814 | 19.52% |
| `production_curve_auth_me` | GET | 200 | 649 | 15.56% |
| `production_curve_checkout` | POST | 200 | 410 | 9.83% |
| `production_curve_report` | GET | 200 | 230 | 5.51% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

Mixed production curve có p95 cao hơn case đơn giản do checkout/report/product mix, nhưng không còn 429/failed request.

| Aggregate | Value |
| --- | ---: |
| Response-time points | 3587 |
| Avg của các window avg | 37.7ms |
| Max window p95 | 1.40s |
| Max window p99 | 1.40s |
| Max request window | 1.41s |
| Windows p95 > 100ms | 234 |
| Windows p95 > 500ms | 63 |

#### 2. Execution timeline chart

Không có failed iterations. Tất cả operation trong mix đều status 200.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 4171 |
| Sum `http_reqs` buckets | 4171 |
| Peak iter/s bucket | 60 |
| Peak http_req/s bucket | 60 |
| Failed-iteration points | 0 |
| Sum failed iterations | 0 |
| Peak failed-iteration bucket | 0 |

#### 3. VUs vs iter/s chart

VU shape đạt peak 30 đúng contract gốc, không phải bản giảm tải 24 VUs. Đây là tín hiệu tốt: production curve đã pass theo đúng tài liệu đề ra.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 110 |
| VUs min/max series | 2 / 30 |
| Avg VUs series | 20.20 |
| Peak iter/s bucket | 60 |

### Kết luận contract rerun #57

OK theo contract gốc.
<!-- REAL_RUN_END -->

## Đọc dashboard real-time charts cho case 07

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
production_curve_browse: GET /api/sim/products
production_curve_cart_add: POST /api/sim/cart/add
production_curve_auth_me: GET /api/sim/auth/me
production_curve_checkout: POST /api/sim/checkout
production_curve_report: GET /api/sim/report
```

Cách đọc:

```text
ramp-up phase: latency có tăng khi VUs tăng không?
peak/plateau: p95/p99 có ổn định không?
ramp-down/recovery: latency có giảm lại không?
```

Case-specific hints:

- Response time: products/cart/auth/order/report breakdown bắt buộc.
- Execution timeline: failures ở peak có thể chỉ một service gây ra.
- VUs vs iter/s: 30 VUs peak mà iter/s flatten là mixed-system saturation signal.

### Chart 2 — Execution timeline

Với ramping-vus:

```text
VUs should follow 2 -> 12 -> 30 -> 8 -> 2.
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
| Clean mixed curve | Production-shaped baseline acceptable | Use as broad baseline |
| Overall p95 bad but one service dominates | Service-specific bottleneck | Route to service owner |
| Failures in low-volume branch | Small branch business-critical issue | Do not ignore |
| Weighted mix wrong | Test invalid until distribution understood | Validate script/tags |

## Nghịch lý và misconceptions của ramping-vus

Đừng dùng case này để claim max RPS. Nó là active-user production curve, không phải arrival-rate capacity test.

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
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js`
