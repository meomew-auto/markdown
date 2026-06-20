# Case 01: Daily traffic curve

## Tình huống thực tế

Traffic bình thường trong ngày không phẳng: sáng tăng dần, vào peak, giữ một lúc, rồi chiều giảm.

Team storefront muốn biết products/cart/order giữ latency và failure rate ra sao khi active users đi theo daily curve.

Case này trả lời: hệ thống có chịu được đường cong 2 -> 8 -> 24 -> 12 -> 2 VUs không, và service nào kéo latency khi vào peak?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 2 -> 8 -> 24 -> 12 -> 2
Scenario: daily_traffic_curve
Exec function: dailyTrafficCurve
Team/service focus: storefront/products/cart/order
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 2 -> 8 -> 24 -> 12 -> 2,
latency/failures/iter-s/RPS phản ứng như thế nào?
```

## Yêu cầu cứng của case này

- VU chart phải đi theo daily stage shape.
- Không dùng total iterations làm target; iterations/RPS là output.
- Operation mix browse/cart/checkout phải đọc bằng tags.
- Failures phải dưới thresholds của case.

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

## Vì sao "Daily traffic curve" nên dùng `ramping-vus`?

Daily traffic là active-user curve theo thời gian. `ramping-vus` đúng vì input nghiệp vụ là số active users ở từng phase, không phải fixed RPS hoặc fixed backlog.

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
RV_01_START_VUS = 2
RV_01_MORNING_VUS = 8
RV_01_PEAK_VUS = 24
RV_01_AFTERNOON_VUS = 12
RV_01_DURATION_SCALE = 0.25
RV_01_SLEEP_SECONDS = 0.4
gracefulRampDown = 15s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_01_START_VUS | 2 | stage/control knob |
| RV_01_MORNING_VUS | 8 | stage/control knob |
| RV_01_PEAK_VUS | 24 | stage/control knob |
| RV_01_AFTERNOON_VUS | 12 | stage/control knob |
| RV_01_DURATION_SCALE | 0.25 | stage/control knob |
| RV_01_SLEEP_SECONDS | 0.4 | stage/control knob |
| gracefulRampDown | 15s | stage/control knob |

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 60s | 15s | 8 | morning traffic starts rising |
| 2 | 120s | 30s | 24 | ramp into peak |
| 3 | 120s | 30s | 24 | hold peak |
| 4 | 90s | 23s | 12 | afternoon cool-down |
| 5 | 60s | 15s | 2 | return to low traffic |

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

### Nguyên nhân kỹ thuật 1: Product browse latency can flatten iter/s during peak

Peak VUs tăng nhưng nếu products-service chậm, mỗi VU loop lâu hơn và iter/s có thể không tăng tương ứng.

### Nguyên nhân kỹ thuật 2: Checkout branch nhỏ nhưng kéo tail latency

Checkout chỉ 8% mix nhưng có order/external dependency, có thể kéo p95/p99 aggregate.

### Nguyên nhân kỹ thuật 3: Mixed services hide branch bottlenecks

Aggregate p95 hoặc total RPS không chỉ ra service nào chậm; phải lọc `operation`/`service`.

### Nguyên nhân kỹ thuật 4: Cool-down và gracefulRampDown

Khi giảm từ 24 xuống 12 rồi 2 VUs, residual iterations có thể hoàn tất trong graceful ramp-down, không tự động là lỗi.

## Service/API flow

Flow pattern:

```text
Weighted branch selection: browse 70, cart 22, checkout 8.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| daily_curve_list | products-service | GET | /api/sim/products | 200 | Product list during daily curve. |
| daily_curve_detail | products-service | GET | /api/sim/products/:id | 200 | Product detail browse. |
| daily_curve_cart_add | cart-service | POST | /api/sim/cart/add | 200 | Cart branch. |
| daily_curve_checkout | order-service | POST | /api/sim/checkout | 200 | Checkout branch. |

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
case_id       = rv-01-daily-traffic-curve
business_case = daily_traffic_curve
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
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = daily_traffic_curve
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 2 -> 8 -> 24 -> 12 -> 2
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

- VUs/vus_max phải đối chiếu với peak 24 và stage shape.
- Branch mix 70/22/8 là expected ratio over enough loops, không phải exact per bucket.
- Nếu iter/s flatten ở peak, đọc `ramping_flow_duration_ms` và operation p95.

<!-- REAL_RUN_START -->
## Contract rerun 2026-06-20 — run #58

Run này ép đúng contract/tải đã ghi trong tài liệu, sau lần BE fix mới nhất.

```text
BASE_URL=http://localhost:80
K6_CLOUD_HOST=http://localhost:18080
RV_01_START_VUS=2
RV_01_MORNING_VUS=8
RV_01_PEAK_VUS=24
RV_01_AFTERNOON_VUS=12
RV_01_DURATION_SCALE=0.25
RV_01_SLEEP_SECONDS=0.4
```

| Item | Value |
| --- | --- |
| Script | `rv-01-daily-traffic-curve.js` |
| Run ID | `58` |
| Exit code | `0` |
| Verdict | **PASS** — Đạt theo contract gốc |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `2 -> 8 -> 24 -> 12 -> 2` |
| Observed `vus` min/max | 2 / 24 |

### Summary thật của contract rerun

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 100.00% (7329/7329) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/7329) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 0 | User-loop failures của case. |
| `iterations` | 4380 (38.64/s) | Output, không phải target. |
| `http_reqs` | 7329 (64.66/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 4380 | Completed user loops. |
| `ramping_api_calls_total` | 7329 | Custom API counter. |
| `ramping_sleep_seconds` | 1752.0s | Think time do script thêm. |
| `http_req_duration` | avg 5.62ms, p95 5.82ms, p99 89.0ms, max 122ms | Request-level latency. |
| `ramping_flow_duration_ms` | avg 9.52ms, p95 78.0ms, p99 92.0ms, max 121ms | Full user-loop latency. |
| `iteration_duration` | avg 410ms, p95 478ms, p99 492ms, max 522ms | Bao gồm flow + think/sleep. |

Threshold failures:

Không có threshold failure.

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `daily_curve_list` | GET | 200 | 2949 | 40.24% |
| `daily_curve_detail` | GET | 200 | 2949 | 40.24% |
| `daily_curve_cart_add` | POST | 200 | 1117 | 15.24% |
| `daily_curve_checkout` | POST | 200 | 314 | 4.28% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

Latency request ổn và không còn 429. `daily_curve_list`, `daily_curve_detail`, `daily_curve_cart_add`, `daily_curve_checkout` đều status 200. Đây là dấu hiệu BE đã xử lý xong product-list throttling cho daily curve peak 24 VUs.

| Aggregate | Value |
| --- | ---: |
| Response-time points | 4284 |
| Avg của các window avg | 8.04ms |
| Max window p95 | 122ms |
| Max window p99 | 122ms |
| Max request window | 122ms |
| Windows p95 > 100ms | 9 |
| Windows p95 > 500ms | 0 |

#### 2. Execution timeline chart

Execution timeline không còn failed iterations. Tổng request breakdown chỉ có status 200, nên lỗi 29 failed loops ở run #51 đã hết.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 4380 |
| Sum `http_reqs` buckets | 7329 |
| Peak iter/s bucket | 64 |
| Peak http_req/s bucket | 113 |
| Failed-iteration points | 0 |
| Sum failed iterations | 0 |
| Peak failed-iteration bucket | 0 |

#### 3. VUs vs iter/s chart

VU shape đạt peak 24 đúng contract `2 -> 8 -> 24 -> 12 -> 2`. Peak/plateau chạy đúng active-user curve và thresholds đều pass.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 113 |
| VUs min/max series | 2 / 24 |
| Avg VUs series | 15.86 |
| Peak iter/s bucket | 64 |

### Kết luận contract rerun #58

OK theo contract gốc. Case 01 đã pass sau fix mới nhất.
<!-- REAL_RUN_END -->

## Đọc dashboard real-time charts cho case 01

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
daily_curve_list: GET /api/sim/products
daily_curve_detail: GET /api/sim/products/:id
daily_curve_cart_add: POST /api/sim/cart/add
daily_curve_checkout: POST /api/sim/checkout
```

Cách đọc:

```text
ramp-up phase: latency có tăng khi VUs tăng không?
peak/plateau: p95/p99 có ổn định không?
ramp-down/recovery: latency có giảm lại không?
```

Case-specific hints:

- Chart response time: tách list/detail/cart/checkout.
- Execution timeline: VUs và http_reqs phải rise/hold/cool theo daily shape.
- VUs vs iter/s: VUs tăng mà iter/s không tăng là signal saturation/backpressure.

### Chart 2 — Execution timeline

Với ramping-vus:

```text
VUs should follow 2 -> 8 -> 24 -> 12 -> 2.
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
| Clean thresholds + VU shape đúng | Daily curve baseline acceptable | Use as daily traffic baseline |
| Product latency rises at peak | Products-service capacity/cache/db pressure | Investigate products path |
| Checkout tail spikes | Order/external dependency bottleneck | Inspect checkout |
| Operation mix wrong | weightedPick/tagging issue | Validate script/tags before trusting run |

## Nghịch lý và misconceptions của ramping-vus

Đừng nói case này phải có exact iterations count. Nó kiểm active-user curve, không phải fixed total work.

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
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js`
