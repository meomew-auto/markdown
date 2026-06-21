# Series thực hành: 7 tình huống thực tế cho `ramping-arrival-rate`

## Mục đích series

Series này dạy **WHEN/WHY dùng `ramping-arrival-rate`** thay vì các executor khác,
qua 7 tình huống production nơi traffic đến hệ thống **thay đổi theo timeline**.

Câu hỏi đúng của executor này là:

```text
"Hệ thống có chịu được arrival rate biến thiên theo stages trong Y thời gian không?"
```

Không phải:

```text
"Có đúng N user đang online không?"                        -> constant-vus / ramping-vus
"Traffic giữ đúng X RPS cố định trong Y giây không?"       -> constant-arrival-rate
"Mỗi user chạy đúng M vòng không?"                         -> per-vu-iterations
"Có xử lý hết N job backlog không?"                        -> shared-iterations
"User tăng/giảm theo giờ không?"                           -> ramping-vus
```

`ramping-arrival-rate` trả lời câu hỏi về **arrival contract biến thiên**,
không phải về active user pool hay fixed ingress rate. Đây là executor duy nhất
kết hợp **open model** (arrival-rate driven) với **rate curve theo timeline**.

Mỗi case trong series dùng script ở pack FE/load-target:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-NN-*.js
```

Docs nằm ở:

```text
docs/practice/ramping-arrival-rate/NN_<topic>.md
```

## Mental model: arrival slot = contract, rate thay đổi theo stages, VU = anonymous worker

Hãy tưởng tượng một lịch hẹn **biến thiên** theo thời gian:

```text
startRate = 5
stages: 15s -> 15,  25s -> 28,  15s -> 8
timeUnit = 1s

=> 0-15s:  rate ramp tuyến tính từ 5/s lên 15/s
   15-40s: rate ramp tuyến tính từ 15/s lên 28/s
   40-55s: rate ramp tuyến tính từ 28/s xuống 8/s
```

Mỗi slot đến giờ sẽ hỏi:

```text
"Có worker/VU nào rảnh để chạy event này không?"
```

- Có VU rảnh -> iteration bắt đầu.
- Không có VU rảnh nhưng còn dưới `maxVUs` -> k6 spawn thêm VU (có spawn delay).
- Không spawn kịp hoặc đã chạm trần `maxVUs` -> slot bị bỏ, `dropped_iterations += 1`.

Rate không phẳng — nó ramp lên và xuống trong từng stage. K6 tính rate(t) theo công thức nội suy tuyến tính:

```text
rate(t) = rate_start_stage + (rate_end_stage - rate_start_stage) × (t - t_stage_start) / stage_duration
```

Ví dụ stage `duration: 15s, target: 28` bắt đầu từ rate=15/s:

```text
t=0s trong stage:  rate = 15/s
t=5s trong stage:  rate = 15 + (28-15)×5/15 = 15 + 4.33 = 19.33/s
t=10s trong stage: rate = 15 + (28-15)×10/15 = 15 + 8.67 = 23.67/s
t=15s trong stage: rate = 28/s (target cuối stage)
```

Điều này có nghĩa **khoảng cách giữa các slot arrival co giãn theo rate hiện tại**.
Khi rate thấp, slot thưa; khi rate cao, slot dày hơn.

Điểm mấu chốt:

```text
VU trong ramping-arrival-rate KHÔNG phải business user.
VU là năng lực scheduler để giữ arrival contract biến thiên.
__VU = anonymous worker. exec.scenario.iterationInTest = global arrival slot index.
User identity KHÔNG bound vào VU.
```

## Đặc trưng `ramping-arrival-rate`

```text
- OPEN MODEL: k6 cố START iteration theo nhịp rate(t) thay đổi theo stages.
- startRate = arrival rate lúc scenario bắt đầu (không phải lúc stage 1 bắt đầu — nó chính là rate_start của stage 1).
- stages[].target = rate đích ở CUỐI mỗi stage (tuyệt đối, không phải delta).
- stages[].duration = thời gian rate ramp từ target trước đến target mới, nội suy tuyến tính.
- VU chỉ là anonymous worker để nhận arrival slot đã đến giờ.
- preAllocatedVUs là số worker chuẩn bị sẵn ngay từ đầu.
- maxVUs là trần worker được phép mở thêm; spawn có delay nên không tức thời.
- Backend chậm KHÔNG tự làm giảm arrival rate — rate(t) vẫn chạy đúng lịch.
- Nếu đến giờ start mà không có VU rảnh -> dropped_iterations tăng.
- iterations/http_reqs là OUTPUT thực tế, có thể thấp hơn scheduled slots nếu bị drop.
```

Khác với `constant-arrival-rate`:

```text
constant-arrival-rate:
  rate CỐ ĐỊNH suốt duration
  -> phù hợp RPS contract phẳng

ramping-arrival-rate:
  rate BIẾN THIÊN theo stages
  -> phù hợp traffic curve, campaign spike, daily pattern
```

Khác với `ramping-vus` (đây là điểm dễ nhầm nhất):

```text
ramping-vus:
  CLOSED MODEL + active VU pool thay đổi theo stages
  input = timeline VU count
  output = iter/s, RPS, latency
  backend chậm -> mỗi VU loop chậm -> throughput tự giảm

ramping-arrival-rate:
  OPEN MODEL + arrival rate thay đổi theo stages
  input = timeline arrival rate
  output = latency, failed events, dropped_iterations
  backend chậm -> iteration lâu hơn -> cần nhiều VU hơn để giữ nhịp
  thiếu VU -> k6 drop arrival slot -> dropped_iterations tăng
```

## So sánh executor: chọn executor nào cho tình huống nào?

| Mục tiêu test | Executor đúng | Vì sao |
| --- | --- | --- |
| Arrival rate biến thiên theo timeline | **ramping-arrival-rate** | Open model + rate curve; traffic shape quyết định VU sizing |
| Cố định arrivals/s trong một khoảng thời gian | constant-arrival-rate | Rate phẳng, open model, phù hợp RPS contract cố định |
| Cố định concurrent active users | constant-vus | Closed model; VU loop liên tục; throughput là output |
| User tăng/giảm theo giờ (active user pool) | ramping-vus | Closed model; active VU count là input, không phải arrival rate |
| Mỗi user chạy đúng N vòng | per-vu-iterations | Identity bound vào VU; count deterministic |
| Xử lý hết backlog N jobs | shared-iterations | Một pool VU chia việc đến khi hết backlog |

Rule nhớ nhanh:

```text
Cần arrivals/s đổi theo timeline      -> ramping-arrival-rate
Cần arrivals/s phẳng                  -> constant-arrival-rate
Cần active VUs đổi theo timeline      -> ramping-vus
Cần active VUs phẳng                  -> constant-vus
Cần fixed global backlog              -> shared-iterations
Cần mỗi VU chạy đúng N vòng           -> per-vu-iterations
```

## Bảng tổng hợp 7 case

| # | Case | Business shape | Config mặc định | Peak rate | Điểm học chính |
| --- | --- | --- | --- | --- | --- |
| 01 | Daily ingress curve | Products browse/list traffic theo daily pattern: tăng sáng, giữ peak trưa, giảm chiều | `startRate=5`, stages: `15s→15`, `25s→28`, `15s→8` | 28/s | Read ingress curve; peak rate xác định VU sizing, không phải average rate |
| 02 | Campaign ingress spike | Campaign launch với traffic spike đột biến: prelaunch thấp, spike cao, recovery nhanh | `startRate=3`, stages: `5s→10`, `10s→40`, `10s→8`, `5s→3` | 40/s | Spike stage quyết định toàn bộ VU requirement; stage ngắn + rate cao = drop risk lớn nhất |
| 03 | Login wave ingress | Auth validation traffic theo wave đăng nhập: user vào buổi sáng, session settle | `startRate=2`, stages: `15s→15`, `20s→28`, `10s→5` | 28/s | Auth stream ramp; peak rate khớp giờ cao điểm; auth latency thường thấp -> ít VU hơn các case khác |
| 04 | Checkout surge ingress | Checkout/order intake tăng đột biến: low baseline, surge vừa phải | `startRate=1`, stages: `15s→5`, `15s→10`, `10s→2` | 10/s | Low peak rate nhưng external latency cao -> VU requirement cao hơn hẳn dự đoán naive từ peak rate |
| 05 | Report ingress ramp | Report API với async job traffic ramp: staff mở report đầu giờ | `startRate=2`, stages: `10s→6`, `15s→14`, `10s→4` | 14/s | Async job latency không được throttle arrival stream; `dropped_iterations` là tín hiệu duy nhất báo thiếu worker cho async path |
| 06 | Feed ingress ramp | Cacheable feed/recommendation high-rate ramp: read-heavy, response nhanh | `startRate=8`, stages: `10s→20`, `15s→35`, `10s→10` | 35/s | Highest peak rate; Little's Law: rate cao + event nhanh = ít VU; cache hit ratio ảnh hưởng trực tiếp đến W_effective |
| 07 | Production ingress curve | Mixed 6-service baseline theo traffic curve: browse/cart/auth/checkout/report/feed | `startRate=4`, stages: `10s→14`, `20s→28`, `15s→18`, `10s→6` | 28/s | Mixed open-model baseline; Noisy Neighbor xuất hiện khi một service chậm kéo VU pool, ảnh hưởng arrival của service khác |

### Stage math cho từng case

**Case 01 — Daily ingress curve:**

```text
startRate=5, timeUnit=1s
Stage 1: duration=15s, rate: 5 -> 15/s
  slots = 15 × (5+15)/2 = 15 × 10 = 150
Stage 2: duration=25s, rate: 15 -> 28/s
  slots = 25 × (15+28)/2 = 25 × 21.5 = 537.5
Stage 3: duration=15s, rate: 28 -> 8/s
  slots = 15 × (28+8)/2 = 15 × 18 = 270
total_scheduled = 150 + 537.5 + 270 ≈ 957.5 slots
lambda_peak = 28/s
required_vus_min_peak ≈ ceil(28 × W_effective)
```

**Case 02 — Campaign ingress spike:**

```text
startRate=3, timeUnit=1s
Stage 1: duration=5s, rate: 3 -> 10/s
  slots = 5 × (3+10)/2 = 32.5
Stage 2: duration=10s, rate: 10 -> 40/s
  slots = 10 × (10+40)/2 = 250
Stage 3: duration=10s, rate: 40 -> 8/s
  slots = 10 × (40+8)/2 = 240
Stage 4: duration=5s, rate: 8 -> 3/s
  slots = 5 × (8+3)/2 = 27.5
total_scheduled ≈ 550 slots
lambda_peak = 40/s  <-- ĐÂY LÀ CON SỐ QUYẾT ĐỊNH VU SIZING
required_vus_min_peak ≈ ceil(40 × W_effective)
```

Stage 2 chỉ kéo dài 10s nhưng rate lên tới 40/s — đây là stage quyết định toàn bộ
`preAllocatedVUs` và `maxVUs`. Nếu chỉ nhìn average rate (550/30 ≈ 18.3/s) mà
set VU, bạn sẽ bị drop hàng loạt ở stage 2.

**Case 03 — Login wave ingress:**

```text
startRate=2, timeUnit=1s
Stage 1: duration=15s, rate: 2 -> 15/s  => slots = 15 × (2+15)/2 = 127.5
Stage 2: duration=20s, rate: 15 -> 28/s => slots = 20 × (15+28)/2 = 430
Stage 3: duration=10s, rate: 28 -> 5/s  => slots = 10 × (28+5)/2 = 165
total_scheduled ≈ 722.5 slots
lambda_peak = 28/s
```

Auth endpoint thường latency thấp (token validation đơn giản), nhưng stage 2 kéo dài
20s ở rate cao — cần đảm bảo VU pool ổn định suốt phase này.

**Case 04 — Checkout surge ingress:**

```text
startRate=1, timeUnit=1s
Stage 1: duration=15s, rate: 1 -> 5/s   => slots = 15 × (1+5)/2 = 45
Stage 2: duration=15s, rate: 5 -> 10/s  => slots = 15 × (5+10)/2 = 112.5
Stage 3: duration=10s, rate: 10 -> 2/s  => slots = 10 × (10+2)/2 = 60
total_scheduled ≈ 217.5 slots
lambda_peak = 10/s  <-- nhìn qua tưởng nhẹ
```

Nhưng checkout endpoint có external latency cao (payment gateway, inventory check,
order write) -> W_effective có thể 0.5-1.5s. Với W=0.8s:

```text
required_vus_min_peak ≈ ceil(10 × 0.8) = 8 VUs
```

8 VU cho rate 10/s — tỷ lệ VU/rate cao hơn hẳn case 06 (feed cache). Đây là bài học:
**peak rate thấp không có nghĩa là cần ít VU**.

**Case 05 — Report ingress ramp:**

```text
startRate=2, timeUnit=1s
Stage 1: duration=10s, rate: 2 -> 6/s   => slots = 10 × (2+6)/2 = 40
Stage 2: duration=15s, rate: 6 -> 14/s  => slots = 15 × (6+14)/2 = 150
Stage 3: duration=10s, rate: 14 -> 4/s  => slots = 10 × (14+4)/2 = 90
total_scheduled = 280 slots
lambda_peak = 14/s
```

Async job pattern: k6 gửi request, backend trả 202 Accepted, job chạy async.
Event duration = HTTP round-trip + poll/wait nếu script có polling.
`dropped_iterations` là tín hiệu duy nhất báo thiếu worker cho async path —
vì HTTP latency của 202 thường thấp, nhưng nếu script poll job status thì
W_effective tăng đáng kể.

**Case 06 — Feed ingress ramp:**

```text
startRate=8, timeUnit=1s
Stage 1: duration=10s, rate: 8 -> 20/s  => slots = 10 × (8+20)/2 = 140
Stage 2: duration=15s, rate: 20 -> 35/s => slots = 15 × (20+35)/2 = 412.5
Stage 3: duration=10s, rate: 35 -> 10/s => slots = 10 × (35+10)/2 = 225
total_scheduled ≈ 777.5 slots
lambda_peak = 35/s  <-- peak cao nhất trong 7 case
```

Nhưng feed endpoint cacheable, W_effective cỡ 0.05-0.1s. Với W=0.07s:

```text
required_vus_min_peak ≈ ceil(35 × 0.07) = 3 VUs
```

3 VU cho rate 35/s — tỷ lệ VU/rate cực thấp. Bài học: **rate cao không có nghĩa
là cần nhiều VU nếu event cực nhanh**. Little's Law quyết định tất cả.

**Case 07 — Production ingress curve:**

```text
startRate=4, timeUnit=1s
Stage 1: duration=10s, rate: 4 -> 14/s  => slots = 10 × (4+14)/2 = 90
Stage 2: duration=20s, rate: 14 -> 28/s => slots = 20 × (14+28)/2 = 420
Stage 3: duration=15s, rate: 28 -> 18/s => slots = 15 × (28+18)/2 = 345
Stage 4: duration=10s, rate: 18 -> 6/s  => slots = 10 × (18+6)/2 = 120
total_scheduled = 975 slots
lambda_peak = 28/s
```

6 service types trong cùng một scenario: browse, cart, auth, checkout, report, feed.
Mỗi service có W_effective khác nhau. VU pool dùng chung cho tất cả arrival slots.

Noisy Neighbor pattern:

```text
Nếu checkout (W cao) chiếm nhiều VU cùng lúc ở stage 2,
các arrival slot cho feed (W thấp) có thể bị drop dù feed endpoint vẫn nhanh.
```

Đây là lý do case 07 là bài tổng hợp — nó dạy rằng **VU pool là tài nguyên chung**,
và một service chậm có thể gây drop cho toàn bộ arrival stream.

## Công thức cần nhớ

### 1. Rate tại thời điểm t trong stage

```text
rate(t) = rate_start + (rate_end - rate_start) × (t - t_stage_start) / stage_duration
```

`rate_start` = rate lúc bắt đầu stage (target của stage trước, hoặc startRate cho stage 1).
`rate_end` = `stages[i].target` (rate đích ở cuối stage).

Ví dụ case 02 stage 2:

```text
rate_start = 10/s (target stage 1)
rate_end = 40/s (target stage 2)
stage_duration = 10s

t=0s trong stage:  rate = 10 + (40-10)×0/10 = 10/s
t=5s trong stage:  rate = 10 + 30×5/10 = 25/s
t=10s trong stage: rate = 10 + 30×10/10 = 40/s
```

### 2. Scheduled slots trong một stage

```text
scheduled_slots_stage_i = stage_duration_i × (rate_start_i + rate_end_i) / 2
```

Đây là diện tích hình thang dưới đường rate(t). Vì rate thay đổi tuyến tính,
số slot scheduled trong stage = duration × rate trung bình của stage.

Ví dụ case 01 stage 2:

```text
scheduled_slots = 25s × (15 + 28) / 2 = 25 × 21.5 = 537.5 slots
```

Tổng toàn scenario:

```text
total_scheduled_slots = Σ stage_duration_i × (rate_start_i + rate_end_i) / 2
```

### 3. Peak rate cho VU sizing (Little's Law)

```text
lambda_peak = max(startRate, max(stages[].target)) / timeUnit_seconds
```

Đây là công thức quan trọng nhất. VU sizing phải dựa trên **peak rate**, không phải average rate:

```text
average_target_rate = total_scheduled_slots / total_regular_duration
```

Ví dụ case 02:

```text
lambda_peak = 40/s
average_target_rate = 550/30 ≈ 18.3/s
```

Nếu set VU theo average 18.3/s, bạn sẽ drop ở stage 2 (40/s). Luôn dùng lambda_peak.

### 4. Required VUs (Little's Law áp dụng cho peak)

```text
required_vus_min_peak ≈ ceil(lambda_peak × W_effective)
```

Trong đó `W_effective` là thời gian một event giữ VU bận:

```text
W_effective ≈ max(iteration_duration, minIterationDuration)
```

Bao gồm: HTTP latency, JS xử lý, external latency giả lập, polling, sleep nếu có.

Ví dụ case 02 với W_effective = 0.3s:

```text
required_vus_min_peak ≈ ceil(40 × 0.3) = 12 VUs
```

Production nên có buffer 1.5x-2x vì latency tail, cold start, GC, network spike và spawn delay.

### 5. Capacity với M VUs (đảo của Little's Law)

```text
capacity_with_M_vus ≈ M / W_effective_seconds
```

Nếu capacity thấp hơn peak rate:

```text
capacity < lambda_peak
-> observed completed rate giảm ở vùng peak
-> dropped_iterations tăng
-> vus chạm hoặc gần chạm maxVUs
```

Ví dụ: nếu set maxVUs=8 nhưng W_effective=0.3s và lambda_peak=40/s:

```text
capacity = 8/0.3 ≈ 26.7/s < 40/s
-> sẽ drop ở stage 2
```

## Metrics bắt buộc trong pack này

| Metric | Type | Ý nghĩa |
| --- | --- | --- |
| `ramping_arrival_events_total` | Counter | Event đã start và chạy xong; thường 1 event = 1 iteration hoàn thành |
| `ramping_arrival_events_failed` | Counter | Event có ít nhất một required API call fail |
| `ramping_arrival_api_calls_total` | Counter | Số HTTP API calls do arrival events tạo ra |
| `ramping_arrival_event_duration_ms` | Trend | End-to-end duration của một arrival event |
| `dropped_iterations` | k6 Counter | Slot k6 không start được đúng lịch vì thiếu VU rảnh |
| `vus` | k6 Gauge | Active VUs observed để giữ rate curve |
| `vus_max` | k6 Gauge | VU ceiling/initialized VUs theo k6 summary; cần phân biệt với active VUs chart |
| `iterations` | k6 Counter | Số vòng `default()` hoàn tất; observed output |
| `http_reqs` | k6 Counter | Tổng HTTP requests; cần reconcile với `ramping_arrival_api_calls_total` |
| `checks` | Rate | API/status/contract checks pass bao nhiêu % |
| `http_req_failed` | Rate | HTTP/network/protocol failure rate theo k6 |

`dropped_iterations` không phải metric phụ. Với ramping-arrival-rate, nó là **input bắt buộc**
để kết luận pass/fail. Một run có `dropped_iterations > 0` ở vùng peak là KHÔNG pass,
bất kể latency có đẹp thế nào.

Phân biệt trong output:

```text
iterations                         = số arrival events đã start và hoàn thành
ramping_arrival_events_total       = event-level counter của pack
ramping_arrival_api_calls_total    = tổng API calls; có thể > iterations nếu một event gọi nhiều endpoint
http_reqs                          = k6 built-in HTTP requests; nên reconcile với API calls
dropped_iterations                 = slot không start được; iterations + dropped ≈ scheduled slots (nếu không interrupt)
```

## Pattern chung trong code

Tất cả case dùng helper chung:

```js
buildRampingArrivalScenario(execName, startRate, timeUnit, stages, preAllocatedVUs, maxVUs, extraTags)
requestJson(method, url, body, tags, expectedStatus)
finishEvent(startedAt, ok, tags)
```

Các tag chung:

```text
executor_family = ramping_arrival_rate
workload_shape  = variable_ingress_rate
case_id         = rar-NN-...
service         = products-service/auth-service/cart-service/...
operation       = browse_products/validate_token/write_cart/...
endpoint        = METHOD /api/sim/...
```

Custom counters được emit theo event/API call. Khi đọc output cần phân biệt:

```text
ramping_arrival_events_total       = đếm theo event (1 event = 1 iteration)
ramping_arrival_api_calls_total    = đếm theo API call (có thể nhiều call/event)
ramping_arrival_event_duration_ms  = trend của event duration
```

## Cách phân tích output theo 5 bước

### Bước 1: Xác nhận executor/config

Output phải thể hiện scenario dùng:

```text
executor: ramping-arrival-rate
startRate: <case startRate>
timeUnit: <case timeUnit>
stages: [
  { duration: "...", target: ... },
  ...
]
preAllocatedVUs: <case preAllocatedVUs>
maxVUs: <case maxVUs>
```

Nếu config sai, mọi kết luận phía sau vô nghĩa. Đặc biệt kiểm tra:
- `startRate` có đúng không (dễ nhầm với `rate` của constant-arrival-rate).
- `stages[].target` có phải là absolute rate target không (dễ nhầm thành delta).

### Bước 2: Tính expected scheduled slots toàn scenario

```text
Với mỗi stage i:
  rate_start_i = (i==0 ? startRate : stages[i-1].target)
  rate_end_i = stages[i].target
  slots_i = stages[i].duration_seconds × (rate_start_i + rate_end_i) / 2

total_scheduled_slots = Σ slots_i
```

Ví dụ case 01:

```text
stage 1: 15 × (5+15)/2 = 150
stage 2: 25 × (15+28)/2 = 537.5
stage 3: 15 × (28+8)/2 = 270
total ≈ 957.5
```

### Bước 3: So sánh với summary

Đọc:

```text
iterations
dropped_iterations
interrupted iterations
http_reqs
ramping_arrival_events_total
ramping_arrival_api_calls_total
```

Healthy happy path thường là:

```text
dropped_iterations = 0
iterations ≈ total_scheduled_slots
ramping_arrival_events_total ≈ iterations
```

Nếu `iterations` thấp hơn `total_scheduled_slots` nhưng `dropped_iterations = 0`,
có thể do gracefulStop ngắt scenario khi còn slot chưa start. Đọc thêm `interrupted iterations`.

### Bước 4: Đọc failure/drop cùng VU pressure

Nếu `dropped_iterations > 0`, không kết luận ngay "backend hỏng".
Phải đọc cùng:

```text
vus / active VUs chart (theo thời gian)
vus_max / maxVUs envelope
ramping_arrival_event_duration_ms (p95, p99, max)
http_req_duration (p95, p99 theo service/operation)
```

Diễn giải:

| Dấu hiệu | Cách hiểu |
| --- | --- |
| Latency tăng, VUs tăng, dropped = 0 | Pool đang hấp thụ slow-down, còn headroom |
| VUs sát maxVUs, dropped > 0 (chỉ ở vùng peak) | Peak rate vượt capacity; tăng maxVUs hoặc giảm target stage |
| VUs sát maxVUs, dropped > 0 (toàn bộ timeline) | preAllocatedVUs/maxVUs thấp toàn cục; W_effective cao hơn dự đoán |
| dropped > 0 nhưng VUs chưa chạm maxVUs | Spawn delay: rate tăng quá nhanh, k6 không spawn kịp VU; tăng preAllocatedVUs |
| Latency thấp, VUs thấp, dropped > 0 | Có thể preAllocatedVUs thấp + spawn không kịp ở stage đầu |

### Bước 5: Kết luận theo arrival contract

Một run pass khi:

```text
- dropped_iterations = 0 (HOẶC trong ngưỡng cho phép có giải thích rõ)
- ramping_arrival_events_failed trong ngưỡng
- checks/http_req_failed đạt threshold
- VU pressure còn headroom ở vùng peak
- iter/s theo bucket khớp rate(t) target ở từng stage
```

Không pass chỉ vì `http_req_duration` đẹp nếu `dropped_iterations` đã tăng ở vùng peak.

## Đọc dashboard real-time charts

### Overview chart 1: Response time

Dùng để xem latency theo bucket thời gian:

```text
- cold start spike ở stage 1?
- p95/p99 tăng dần khi rate ramp lên?
- max spike đơn lẻ hay tail latency rộng?
- endpoint nào/tag nào tạo spike?
- latency có tăng đột biến ở transition giữa các stage không?
```

Nhưng response-time chart không thay thế summary-final. Final percentile nên lấy từ
k6 summary hoặc summary-final do `run-with-summary.ps1` push.

### Overview chart 2: Execution timeline

Dùng để xem theo thời gian:

```text
- http_reqs per bucket — có theo đúng rate(t) curve không?
- iterations per bucket — có khớp scheduled slots từng stage không?
- dropped_iterations — xuất hiện ở stage nào? Có cluster ở peak không?
- active VUs — có tăng theo nhu cầu arrival rate không?
- ramping_arrival_events_failed — có cluster ở stage cụ thể không?
```

Với `ramping-arrival-rate`, timeline đẹp là:

```text
iterations/bucket đi theo đường rate(t) — tăng dần stage 1, giữ/tiếp tục tăng stage 2, giảm dần stage cuối
dropped_iterations = 0 hoặc chỉ xuất hiện thoáng qua ở transition
http_reqs/bucket theo đúng call pattern của từng operation
```

### Overview chart 3: VUs vs iter/s

Chart này trả lời:

```text
"k6 phải dùng bao nhiêu VU để giữ arrival rate curve?"
```

Không đọc chart này như số user production.

```text
VUs tăng = event giữ worker lâu hơn (có thể do rate tăng hoặc latency tăng)
VUs sát maxVUs + iter/s tụt so với rate(t) target = nguy cơ thiếu capacity
VUs thấp + iter/s đạt rate(t) target = pool dư headroom
VUs không tăng dù rate tăng = event cực nhanh, W_effective rất thấp
```

### Executor tab

Executor tab nên xác nhận:

```text
executor = ramping-arrival-rate
startRate/timeUnit đúng case
stages (duration + target) đúng config
preAllocatedVUs/maxVUs đúng config
observed active VUs hợp lý với rate curve
dropped_iterations khớp summary
actual iter/s theo bucket gần rate(t) target nếu không drop
```

## Chart caveats dễ hiểu nhầm

```text
summary-final là nguồn truth cuối cùng.
pointCount là số điểm chart/bucket, không phải số request/event.
metrics_push_count là số lần backend nhận payload metrics, không phải business count.
Dashboard bucket có thể downsample/aggregate; phải reconcile bằng sum đúng series.
iterations/s trên summary là COMPLETED rate, không phải target start rate.
  -> Với ramping-arrival-rate, rate target thay đổi theo stage, nên summary rate
     là average completed rate toàn run, không thể so trực tiếp với bất kỳ stage target nào.
VUs chart có độ trễ so với rate(t) curve: spawn VU cần thời gian.
  -> VU peak xuất hiện sau rate peak vài giây là bình thường.
Stage transition có thể có artifact ngắn: k6 điều chỉnh rate, VU pool điều chỉnh.
  -> Không kết luận fail chỉ vì 1-2 bucket transition có drop nhẹ.
```

## Common invalid-result patterns

| Pattern | Vì sao nguy hiểm | Cách xử lý |
| --- | --- | --- |
| `dropped_iterations > 0` ở peak nhưng vẫn kết luận pass vì latency đẹp | Test không đạt target arrival ở peak; latency chỉ đo phần đã chạy | Đọc VU pressure ở stage peak, tăng maxVUs hoặc giảm target stage peak rồi rerun |
| Set VU theo average rate thay vì peak rate | Average che khuất stage peak; drop xảy ra ở stage rate cao nhất | Luôn tính `lambda_peak = max(startRate, max(target))`; VU sizing theo peak |
| Tưởng `ramping-arrival-rate` là `ramping-vus` với đơn vị khác | Khác model: open (arrival-rate) vs closed (active VU); backend chậm phản ứng khác hẳn | Xác nhận executor family trước khi đọc số; open model -> drop là primary signal |
| Copy config `preAllocatedVUs`/`maxVUs` từ constant-arrival-rate sang | Rate curve có peak cao hơn rate phẳng; VU requirement tính theo peak, không phải average | Tính lại `lambda_peak × W_effective` cho curve mới |
| So `iterations/s` summary trực tiếp với từng stage target | Summary rate = completed iterations / total duration; nó là average của cả curve | So theo bucket: đọc iterations/bucket ở từng stage, so với rate(t) target stage đó |
| Gọi `preAllocatedVUs` là số user | Sai mental model; VU là worker capacity, user là arrival slot | Ghi rõ: arrival slots = business events, VU = worker thực thi |
| Bỏ qua spawn delay khi rate ramp quá nhanh | Stage ngắn + rate target cao -> k6 không spawn kịp VU -> drop dù maxVUs đủ | Tăng preAllocatedVUs sát peak requirement; stage ramp đầu tiên không nên quá dốc |
| Không phân biệt `dropped_iterations` với `interrupted iterations` | Drop = chưa start; Interrupted = đã start nhưng không finish (thường do gracefulStop) | Đọc cả hai; drop mới là tín hiệu thiếu capacity; interrupted thường là graceful shutdown bình thường |
| Sum `pointCount` thay vì metric value | pointCount chỉ là số bucket | Sum `value/count` đúng metric |

## Thứ tự đề xuất học

```text
1. Đọc 00_overview.md (file này) để hiểu open model + variable rate curve
2. Đọc RUN_GUIDE.md để biết cách chạy và collect số
3. Làm case 01 (daily ingress curve) — case nền, hiểu rate ramp tuyến tính + peak sizing
4. Làm case 06 (feed ingress ramp) — peak rate cao nhất nhưng VU thấp nhất; hiểu Little's Law
5. Làm case 04 (checkout surge) — peak rate thấp nhưng VU cao; hiểu W_effective quyết định
6. Làm case 02 (campaign spike) — spike stage quyết định toàn bộ; hiểu drop risk ở stage ngắn + rate cao
7. Làm case 03 (login wave) — auth stream ramp; hiểu rate curve khớp business pattern
8. Làm case 05 (report ingress) — async job; hiểu drop là tín hiệu duy nhất cho async path
9. Làm case 07 (production ingress curve) — mixed services; hiểu Noisy Neighbor + VU pool chung
10. Tự chỉnh STAGES / PREALLOCATED_VUS / MAX_VUS để quan sát dropped_iterations ở peak
```

Lưu ý: Nếu bạn chưa từng làm việc với open-model executor, nên đọc qua
`constant-arrival-rate/00_overview.md` trước để nắm mental model "arrival slot = contract,
VU = worker". `ramping-arrival-rate` là phiên bản mở rộng của `constant-arrival-rate`
với rate curve thay vì rate phẳng — nên hiểu nền tảng open model trước khi thêm biến rate.

## Reference

- Quick index: `../../20260518_01_ramping-arrival-rate-quick-index.md`
- Tham số/công thức: `../../20260518_02_ramping-arrival-rate-tham-so-cong-thuc.md`
- Worked example (QuickPizza): `../../20260518_03_ramping-arrival-rate-worked-example.md`
- Practice run guide: `./RUN_GUIDE.md`
- Constant-arrival-rate overview (open model nền): `../constant-arrival-rate/00_overview.md`
- Ramping-vus overview (closed model biến thiên): `../ramping-vus/00_overview.md`
- Constant-vus overview (closed model phẳng): `../constant-vus/00_overview.md`
- Shared-iterations overview: `../shared-iterations/00_overview.md`
- Per-vu-iterations overview: `../per-vu-iterations/00_overview.md`
- Source pack: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\README.md`
