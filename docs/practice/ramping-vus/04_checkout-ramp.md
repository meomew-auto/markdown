# Case 04: Checkout ramp

## Tình huống thực tế

Promotion làm checkout users tăng dần vào peak rồi drain xuống sau cửa sổ khuyến mãi.

Mỗi loop thêm cart, tạo checkout, confirm order. Đây là flow có external/payment wait nên rất nhạy với concurrency.

Case này trả lời: order/cart có chịu được checkout concurrency 1 -> 8 -> 18 -> 1 không?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 1 -> 8 -> 18 -> 1
Scenario: checkout_ramp
Exec function: checkoutRamp
Team/service focus: checkout/order/payment
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 1 -> 8 -> 18 -> 1,
latency/failures/iter-s/RPS phản ứng như thế nào?
```

## Yêu cầu cứng của case này

- Stage shape phải ramp lên và giữ 18 checkout users.
- Full checkout loop phải đi cart add -> checkout -> confirm.
- Idempotency keys phải ổn dưới concurrency ramp.
- Failed loops phải thấp hơn cap.

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

## Vì sao "Checkout ramp" nên dùng `ramping-vus`?

Checkout ramp cần active users tăng theo promotion. `ramping-vus` đúng vì input là concurrent checkout users over time, không phải target checkout RPS.

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
RV_04_START_VUS = 1
RV_04_MID_VUS = 8
RV_04_PEAK_VUS = 18
RV_04_DURATION_SCALE = 0.25
RV_04_SLEEP_SECONDS = 0.8
gracefulRampDown = 20s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_04_START_VUS | 1 | stage/control knob |
| RV_04_MID_VUS | 8 | stage/control knob |
| RV_04_PEAK_VUS | 18 | stage/control knob |
| RV_04_DURATION_SCALE | 0.25 | stage/control knob |
| RV_04_SLEEP_SECONDS | 0.8 | stage/control knob |
| gracefulRampDown | 20s | stage/control knob |

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 60s | 15s | 8 | checkout ramp-up |
| 2 | 90s | 23s | 18 | promotion ramp |
| 3 | 120s | 30s | 18 | sustained peak |
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

### Nguyên nhân kỹ thuật 1: Payment/external wait increases loop duration

Checkout/confirm external wait làm `ramping_flow_duration_ms` tăng và iter/s giảm.

### Nguyên nhân kỹ thuật 2: Cart may pass while order fails

Cart add success không chứng minh checkout/order path pass.

### Nguyên nhân kỹ thuật 3: Idempotency under ramping concurrency

Concurrent checkout users cần unique idempotency keys để tránh replay/collision.

### Nguyên nhân kỹ thuật 4: Plateau verifies sustained checkout

Giữ 18 VUs kiểm sustained capacity, không chỉ short burst.

## Service/API flow

Flow pattern:

```text
Each loop: cart add -> checkout create -> order confirm; uses idempotency keys.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| checkout_ramp_cart_add | cart-service | POST | /api/sim/cart/add | 200 | Cart add before checkout. |
| checkout_ramp_create | order-service | POST | /api/sim/checkout | 200 | Create checkout/order. |
| checkout_ramp_confirm | order-service | POST | /api/sim/orders/:id/confirm | 200 | Confirm order. |

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
case_id       = rv-04-checkout-ramp
business_case = checkout_concurrency_ramp
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
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-04-checkout-ramp.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6\ramping-vus\rv-04-checkout-ramp.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6\ramping-vus\rv-04-checkout-ramp.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = checkout_ramp
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 1 -> 8 -> 18 -> 1
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

- Mỗi full loop thường có 3 API calls.
- Nếu confirm tail cao, flow duration sẽ tăng dù cart add nhanh.
- Peak plateau là nơi quan trọng nhất để đọc capacity.

<!-- REAL_RUN_START -->
## Real run 2026-06-20 — run #43

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
| Script | `rv-04-checkout-ramp.js` |
| Run ID | `43` |
| Exit code | `0` |
| Verdict | **PASS** — Đạt |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `1 -> 8 -> 18 -> 1` |
| Observed `vus` min/max | 1 / 18 |

### Summary thật của run

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 100.00% (3126/3126) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/3126) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 0 | User-loop failures của case. |
| `iterations` | 1042 (12.48/s) | Output, không phải target. |
| `http_reqs` | 3126 (37.44/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 1042 | Completed user loops. |
| `ramping_api_calls_total` | 3126 | Custom API counter, phải khớp `http_reqs` trong case này. |
| `ramping_sleep_seconds` | 833.6s | Think time do script thêm. |
| `http_req_duration` | avg 67.7ms, p95 111ms, p99 114ms, max 159ms | Request-level latency. |
| `ramping_flow_duration_ms` | avg 204ms, p95 221ms, p99 228ms, max 287ms | Full user-loop latency. |
| `iteration_duration` | avg 1.00s, p95 1.02s, p99 1.02s, max 1.08s | Bao gồm flow + think/sleep. |

Threshold failures:

Không có threshold failure.

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `checkout_ramp_confirm` | POST | 200 | 1042 | 33.33% |
| `checkout_ramp_create` | POST | 200 | 1042 | 33.33% |
| `checkout_ramp_cart_add` | POST | 200 | 1042 | 33.33% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

HTTP p95 110.99ms do checkout/confirm có external/order cost; flow p95 221ms. Đây là latency cao hơn các case nhẹ nhưng vẫn sạch lỗi.

Chart aggregates của run:

| Aggregate | Value |
| --- | ---: |
| Response-time points | 3122 |
| Avg của các window avg | 67.7ms |
| Max window p95 | 159ms |
| Max window p99 | 159ms |
| Max request window | 159ms |
| Windows p95 > 100ms | 1039 |
| Windows p95 > 500ms | 0 |

#### 2. Execution timeline chart

Execution timeline không có failed iterations. Mỗi iteration tạo đúng 3 API calls: cart_add, create, confirm đều 1042.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 1042 |
| Sum `http_reqs` buckets | 3126 |
| Peak iter/s bucket | 18 |
| Peak http_req/s bucket | 55 |
| Failed-iteration points | 0 |
| Sum failed iterations | 0 |
| Peak failed-iteration bucket | 0 |

#### 3. VUs vs iter/s chart

VU series đạt peak 18 VUs, peak iter/s bucket 18 và peak http_req/s bucket 55. Closed model thể hiện rõ: flow checkout ~1s/iteration nên iter/s thấp hơn case browse/cart.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 83 |
| VUs min/max series | 1 / 18 |
| Avg VUs series | 12.60 |
| Peak iter/s bucket | 18 |

### Kết luận riêng của run #43

Run pass sạch: checks 100%, HTTP failed 0%, failed iterations 0. Checkout flow 3 bước chạy đủ.

BE note:

> Không cần báo BE bug cho case 04 trong run này; chỉ theo dõi checkout p95 nếu muốn đặt SLA chặt hơn.
<!-- REAL_RUN_END -->

## Đọc dashboard real-time charts cho case 04

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
checkout_ramp_cart_add: POST /api/sim/cart/add
checkout_ramp_create: POST /api/sim/checkout
checkout_ramp_confirm: POST /api/sim/orders/:id/confirm
```

Cách đọc:

```text
ramp-up phase: latency có tăng khi VUs tăng không?
peak/plateau: p95/p99 có ổn định không?
ramp-down/recovery: latency có giảm lại không?
```

Case-specific hints:

- Response time: cart_add vs checkout_create vs confirm.
- Execution timeline: failures ở peak stage là payment/order capacity signal.
- VUs vs iter/s: plateau 18 VUs nhưng iter/s giảm nghĩa là checkout flow chậm hơn.

### Chart 2 — Execution timeline

Với ramping-vus:

```text
VUs should follow 1 -> 8 -> 18 -> 1.
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
| Clean checkout ramp | Promotion checkout capacity acceptable | Accept |
| Checkout create slow | Order/payment dependency bottleneck | Investigate create path |
| Confirm slow/failing | Payment finalization issue | Block checkout release |
| Iter/s flatten low failures | Backpressure/capacity signal | Investigate SLA before scaling |

## Nghịch lý và misconceptions của ramping-vus

Đừng dùng arrival-rate để ép checkout RPS nếu câu hỏi là concurrent checkout users tăng theo promotion.

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
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-04-checkout-ramp.js`
