# Case 02: Campaign launch spike

## Tình huống thực tế

Marketing launch gửi users vào campaign page trong thời gian ngắn. Traffic không tăng từ từ như ngày thường mà spike mạnh.

Người dùng luôn mở landing/list và product detail, rồi một phần add to cart.

Case này trả lời: products/cart có chịu được cú jump 1 -> 6 -> 36 VUs và có recover sau spike không?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 1 -> 6 -> 36 -> 8 -> 1
Scenario: campaign_launch_spike
Exec function: campaignLaunchSpike
Team/service focus: marketing/products/cart
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 1 -> 6 -> 36 -> 8 -> 1,
latency/failures/iter-s/RPS phản ứng như thế nào?
```

## Yêu cầu cứng của case này

- Stage shape phải thể hiện prelaunch -> spike -> recovery.
- Thresholds hơi relaxed hơn baseline vì spike cố ý volatile.
- Cart add là conditional, không được expect mỗi iteration đều add cart.
- Latency phải đọc riêng landing/detail/cart.

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

## Vì sao "Campaign launch spike" nên dùng `ramping-vus`?

Campaign launch là staged concurrency spike. `ramping-vus` đúng vì active users tăng rất nhanh rồi recover; constant-vus không diễn tả được spike, arrival-rate lại ép arrivals thay vì active users.

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
RV_02_START_VUS = 1
RV_02_PRELAUNCH_VUS = 6
RV_02_SPIKE_VUS = 36
RV_02_RECOVERY_VUS = 8
RV_02_DURATION_SCALE = 0.25
RV_02_SLEEP_SECONDS = 0.2
gracefulRampDown = 20s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_02_START_VUS | 1 | stage/control knob |
| RV_02_PRELAUNCH_VUS | 6 | stage/control knob |
| RV_02_SPIKE_VUS | 36 | stage/control knob |
| RV_02_RECOVERY_VUS | 8 | stage/control knob |
| RV_02_DURATION_SCALE | 0.25 | stage/control knob |
| RV_02_SLEEP_SECONDS | 0.2 | stage/control knob |
| gracefulRampDown | 20s | stage/control knob |

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 45s | 11s | 6 | prelaunch warm traffic |
| 2 | 30s | 8s | 36 | sharp spike |
| 3 | 90s | 23s | 36 | hold launch spike |
| 4 | 60s | 15s | 8 | recovery |
| 5 | 30s | 8s | 1 | back to idle |

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

### Nguyên nhân kỹ thuật 1: Sharp ramp exposes cold cache/fanout

Spike từ 6 lên 36 VUs trong thời gian ngắn có thể làm lộ cache miss, DB fanout, product detail bottleneck.

### Nguyên nhân kỹ thuật 2: Conditional cart add

Cart add chỉ mỗi second iteration; count khoảng một nửa iterations over enough loops, không phải exact every loop.

### Nguyên nhân kỹ thuật 3: Recovery stage matters

Sau spike, latency/failures phải recover khi VUs giảm về 8 rồi 1.

### Nguyên nhân kỹ thuật 4: Relaxed thresholds are intentional

Campaign spike có thể tolerates volatility hơn steady baseline, nhưng không được để business failures vượt cap.

## Service/API flow

Flow pattern:

```text
Always campaign landing/list + product detail; cart add every second iteration.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| campaign_landing | products-service | GET | /api/sim/products | 200 | Campaign landing/list. |
| campaign_product_detail | products-service | GET | /api/sim/products/:id | 200 | Campaign product detail. |
| campaign_cart_add | cart-service | POST | /api/sim/cart/add | 200 | Conditional add to cart. |

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
case_id       = rv-02-campaign-launch-spike
business_case = campaign_launch_spike
workload      = staged_concurrency
```

## Pass criteria

Thresholds theo backend script:

```text
checks: rate>0.98
http_req_failed: rate<0.02
ramping_active_iterations_failed: count<40
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
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-02-campaign-launch-spike.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6amping-vus\rv-02-campaign-launch-spike.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6amping-vus\rv-02-campaign-launch-spike.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = campaign_launch_spike
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 1 -> 6 -> 36 -> 8 -> 1
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

- Checks/http failures thresholds là 98%/2%, khác baseline 99%/1%.
- Cart add count thấp hơn landing/detail là expected.
- Nếu p95 không recover ở recovery stage, nghi queue/resource saturation.

## Đọc dashboard real-time charts cho case 02

> Phần này mô tả cách đọc expected dashboard. Chỉ thêm run ID/số p95/bucket thật sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm theo phase? | Fixed iteration target |
| Execution timeline | VUs/failures/RPS thay đổi theo stage nào? | Target RPS, vì không có target RPS |
| VUs vs iter/s | VU shape có đúng không, iter/s có flatten không? | Business correctness nếu không đọc failures |

### Chart 1 — Response time

Đọc theo `operation`:

```text
campaign_landing: GET /api/sim/products
campaign_product_detail: GET /api/sim/products/:id
campaign_cart_add: POST /api/sim/cart/add
```

Cách đọc:

```text
ramp-up phase: latency có tăng khi VUs tăng không?
peak/plateau: p95/p99 có ổn định không?
ramp-down/recovery: latency có giảm lại không?
```

Case-specific hints:

- Response time: landing/detail/cart tách riêng; spike thường làm product/detail p95 tăng.
- Execution timeline: failures clustering ở spike stage là capacity signal.
- VUs vs iter/s: ramp rất nhanh; iter/s flatten trong spike là saturation indicator.

### Chart 2 — Execution timeline

Với ramping-vus:

```text
VUs should follow 1 -> 6 -> 36 -> 8 -> 1.
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
| Clean spike and recovery | Campaign capacity acceptable | Approve launch shape |
| Failure only at spike | Peak capacity insufficient | Add cache/protection or reduce campaign ramp |
| Latency does not recover | Resource saturation/leak/queue | Investigate before launch |
| Cart count every iteration or never | Conditional branch/tag issue | Validate script |

## Nghịch lý và misconceptions của ramping-vus

Đừng dùng constant-vus flat 36 VUs để thay case này; spike transition và recovery là phần chính cần test.

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
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-02-campaign-launch-spike.js`
