# Series thực hành: 7 tình huống thực tế cho `constant-arrival-rate`

## Mục đích series

Series này dạy **WHEN/WHY dùng `constant-arrival-rate`** thay vì các executor khác,
qua 7 tình huống production nơi traffic đến hệ thống theo **nhịp cố định từ bên ngoài**.

Câu hỏi đúng của executor này là:

```text
"Hệ thống có chịu được X arrivals/second trong Y thời gian không?"
```

Không phải:

```text
"Có đúng N user đang online không?"        -> constant-vus / ramping-vus
"Mỗi user chạy đúng M vòng không?"         -> per-vu-iterations
"Có xử lý hết N job backlog không?"        -> shared-iterations
"Traffic tăng/giảm theo campaign không?"  -> ramping-arrival-rate
```

Mỗi case trong series dùng script ở pack FE/load-target:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-NN-*.js
```

Docs nằm ở:

```text
docs/practice/constant-arrival-rate/NN_<topic>.md
```

## Đặc trưng `constant-arrival-rate`

```text
- k6 cố START iteration theo nhịp rate/timeUnit cố định.
- duration quyết định giữ nhịp đó trong bao lâu.
- VU chỉ là worker để nhận arrival slot đã đến giờ.
- preAllocatedVUs là số worker chuẩn bị sẵn.
- maxVUs là trần worker được phép mở thêm.
- Backend chậm KHÔNG tự làm giảm ingress.
- Nếu đến giờ start mà không có VU rảnh -> dropped_iterations tăng.
- iterations/http_reqs là OUTPUT thực tế, có thể thấp hơn target nếu bị drop.
```

Đây là điểm khác biệt lớn nhất so với closed-model executors như `constant-vus`:

```text
constant-vus:
  backend chậm -> mỗi VU loop chậm hơn -> throughput tự giảm

constant-arrival-rate:
  backend chậm -> iteration lâu hơn -> cần nhiều VU hơn để giữ nhịp
  thiếu VU -> k6 drop arrival slot -> dropped_iterations tăng
```

## Mental model: arrival slot = contract, VU = worker

Hãy tưởng tượng có một lịch hẹn cố định:

```text
rate = 20, timeUnit = 1s
=> mỗi giây có 20 slot công việc cần bắt đầu
```

Mỗi slot đến giờ sẽ hỏi:

```text
"Có worker/VU nào rảnh để chạy event này không?"
```

- Có VU rảnh -> iteration bắt đầu.
- Không có VU rảnh nhưng còn dưới `maxVUs` -> k6 có thể mở thêm VU.
- Không mở kịp hoặc đã chạm trần -> slot bị bỏ, `dropped_iterations += 1`.

Vì vậy:

```text
VU trong constant-arrival-rate KHÔNG phải business user.
VU là năng lực scheduler để giữ arrival contract.
```

## Bảng tổng hợp 7 case

| # | Case | Business shape | Config mặc định | Điểm học chính |
| --- | --- | --- | --- | --- |
| 01 | Storefront RPS contract | Browse/list traffic có RPS contract cố định | `20/s × 45s`, pre `12`, max `30` | Read ingress cố định; backend chậm không được tự giảm traffic |
| 02 | Auth token validation RPS | Gateway/frontend gửi token validation đều đặn | `15/s × 45s`, pre `8`, max `24` | Auth stream là ingress contract, không phải số VU/user |
| 03 | Cart write intake | Client gửi cart write events theo nhịp cố định | `12/s × 45s`, pre `10`, max `30` | Write-intake cần đọc drop + failed events cùng nhau |
| 04 | Checkout order intake | Checkout/order đến chậm hơn nhưng business-critical | `5/s × 45s`, pre `15`, max `40` | Low rate vẫn cần nhiều VU nếu external latency cao |
| 05 | Report API ingress | Dashboard report + async job ingress | `6/s × 45s`, pre `20`, max `50` | Async/job latency không được âm thầm throttle arrival stream |
| 06 | Cacheable feed ingress | Feed/recommendation read-heavy traffic | `24/s × 45s`, pre `12`, max `30` | Cacheable reads vẫn phải đạt fixed ingress |
| 07 | Production ingress mix | Mixed browse/cart/auth/checkout/report stream | `18/s × 60s`, pre `25`, max `80` | Open-model baseline trước khi học ramping-arrival-rate |

## Bảng so sánh: dùng executor nào cho tình huống nào?

| Mục tiêu test | Executor đúng | Vì sao |
| --- | --- | --- |
| Cố định arrivals/s trong một khoảng thời gian | **constant-arrival-rate** | Traffic đến từ bên ngoài theo start schedule cố định |
| Cố định concurrent active users | constant-vus | VU loop liên tục; throughput là output |
| Mỗi user chạy đúng N vòng | per-vu-iterations | Identity bound vào VU; count deterministic |
| Xử lý hết backlog N jobs | shared-iterations | Một pool VU chia việc đến khi hết backlog |
| Traffic tăng/giảm theo campaign | ramping-arrival-rate | Arrival rate biến thiên theo time |
| User tăng/giảm theo giờ | ramping-vus | Concurrency biến thiên theo stage |

## Công thức cần nhớ

### 1. Target arrival rate

```text
lambda = rate / timeUnit_seconds
```

Ví dụ:

```text
rate = 20
timeUnit = 1s
lambda = 20 arrivals/s
```

### 2. Scheduled slots

```text
scheduled_slots ≈ lambda × duration_seconds
```

Ví dụ case 01:

```text
20 arrivals/s × 45s = 900 scheduled arrival slots
```

Đây là số slot k6 **muốn** start, không phải số iteration chắc chắn hoàn thành.

### 3. Completed iterations

```text
completed_iterations ≈ scheduled_slots - dropped_iterations - interrupted_iterations
```

Nếu `dropped_iterations = 0` và không bị interrupt, `iterations` thường khớp scheduled slots.
Nếu có drop, `iterations` thấp hơn target là đúng dấu hiệu cần điều tra.

### 4. VU sizing gần đúng

```text
required_vus_min ≈ ceil(lambda × W_effective_seconds)
```

Trong đó `W_effective` là thời gian một event giữ VU bận: HTTP latency, JS xử lý,
external latency giả lập, polling, sleep nếu có.

Ví dụ:

```text
lambda = 20/s
W_effective = 0.15s
required_vus_min ≈ ceil(20 × 0.15) = 3 VUs
```

Nhưng production nên có buffer vì latency tail, cold start, GC, network spike và spawn delay.

### 5. Capacity với M VUs

```text
capacity_with_M_vus ≈ M / W_effective_seconds
```

Nếu capacity thấp hơn target arrival rate:

```text
observed completed rate giảm
dropped_iterations tăng
vus có thể chạm hoặc gần chạm maxVUs
```

## Metrics bắt buộc trong pack này

| Metric | Type | Ý nghĩa |
| --- | --- | --- |
| `constant_arrival_events_total` | Counter | Event đã start và chạy xong; thường 1 event = 1 iteration hoàn thành |
| `constant_arrival_events_failed` | Counter | Event có ít nhất một required API call fail |
| `constant_arrival_api_calls_total` | Counter | Số HTTP API calls do arrival events tạo ra |
| `constant_arrival_event_duration_ms` | Trend | End-to-end duration của một arrival event |
| `dropped_iterations` | k6 Counter | Slot k6 không start được đúng lịch vì thiếu VU rảnh |
| `vus` | k6 Gauge | Active VUs observed để giữ rate |
| `vus_max` | k6 Gauge | VU ceiling/initialized VUs theo k6 summary; cần phân biệt với active VUs chart |

`dropped_iterations` không phải metric phụ. Với open-model executor, nó là input bắt buộc để kết luận pass/fail.

## Pattern chung trong code

Tất cả case dùng helper chung:

```js
buildArrivalScenario(execName, rate, timeUnit, duration, preAllocatedVUs, maxVUs, extraTags)
requestJson(method, url, body, tags, expectedStatus)
finishEvent(startedAt, ok, tags)
```

Các tag chung:

```text
executor_family = constant_arrival_rate
workload_shape  = fixed_ingress_rate
case_id         = car-NN-...
service         = products-service/auth-service/...
operation       = ...
endpoint        = METHOD /api/sim/...
```

Custom counters được emit theo event/API call, nên khi đọc output cần phân biệt:

```text
iterations                         = số arrival events đã start và hoàn thành
constant_arrival_events_total      = event-level counter của pack
constant_arrival_api_calls_total   = tổng API calls; có thể > iterations nếu một event gọi nhiều endpoint
http_reqs                          = k6 built-in HTTP requests; nên reconcile với API calls
```

## Cách phân tích output theo 5 bước

### Bước 1: Xác nhận executor/config

Output phải thể hiện scenario dùng:

```text
executor: constant-arrival-rate
rate: <case rate>
timeUnit: <case timeUnit>
duration: <case duration>
preAllocatedVUs: <case preAllocatedVUs>
maxVUs: <case maxVUs>
```

Nếu config sai, mọi kết luận phía sau vô nghĩa.

### Bước 2: Tính expected scheduled slots

```text
scheduled_slots = rate × duration_seconds / timeUnit_seconds
```

Ví dụ:

```text
car-06: 24/s × 45s = 1080 scheduled slots
```

### Bước 3: So sánh với summary

Đọc:

```text
iterations
dropped_iterations
interrupted iterations
http_reqs
constant_arrival_events_total
constant_arrival_api_calls_total
```

Healthy happy path thường là:

```text
dropped_iterations = 0
iterations ≈ scheduled_slots
constant_arrival_events_total ≈ iterations
```

### Bước 4: Đọc failure/drop cùng VU pressure

Nếu `dropped_iterations > 0`, không kết luận ngay "backend hỏng".
Phải đọc cùng:

```text
vus / active VUs chart
vus_max / maxVUs envelope
constant_arrival_event_duration_ms
http_req_duration
```

Diễn giải:

| Dấu hiệu | Cách hiểu |
| --- | --- |
| Latency tăng, dropped = 0 | Backend chậm hơn nhưng VU pool vẫn đủ giữ ingress |
| Latency tăng, VUs tăng, dropped = 0 | Pool đang hấp thụ slow-down, cần theo dõi headroom |
| VUs sát max, dropped > 0 | Không còn worker rảnh đúng slot; target arrival không đạt |
| dropped > 0 nhưng latency thấp | Có thể preAllocated/maxVUs quá thấp hoặc spawn không kịp |

### Bước 5: Kết luận theo business contract

Một run pass khi:

```text
- target arrival contract đạt hoặc drop trong ngưỡng cho phép
- failed events trong ngưỡng
- checks/http_req_failed đạt threshold
- VU pressure còn headroom hoặc được giải thích rõ
```

Không pass chỉ vì `http_req_duration` đẹp nếu `dropped_iterations` đã tăng.

## Đọc dashboard real-time charts

### Overview chart 1: Response time

Dùng để xem latency theo bucket thời gian:

```text
- cold start spike?
- p95/p99 tăng dần?
- max spike đơn lẻ hay tail latency rộng?
- endpoint nào/tag nào tạo spike?
```

Nhưng response-time chart không thay thế summary-final. Final percentile nên lấy từ k6 summary hoặc summary-final do `run-with-summary.ps1` push.

### Overview chart 2: Execution timeline

Dùng để xem theo thời gian:

```text
- http_reqs per bucket
- iterations per bucket
- dropped_iterations nếu dashboard expose
- active VUs
```

Với `constant-arrival-rate`, timeline đẹp là:

```text
iterations/bucket gần target rate
dropped_iterations = 0 hoặc trong ngưỡng
http_reqs/bucket theo đúng call pattern
```

### Overview chart 3: VUs vs iter/s

Chart này trả lời:

```text
"k6 phải dùng bao nhiêu VU để giữ nhịp arrival?"
```

Không đọc chart này như số user production.

```text
VUs tăng = event giữ worker lâu hơn
VUs sát max + iter/s tụt = nguy cơ thiếu capacity
VUs thấp + iter/s đạt target = pool dư headroom
```

### Executor tab

Executor tab nên xác nhận:

```text
executor = constant-arrival-rate
rate/timeUnit/duration đúng case
preAllocatedVUs/maxVUs đúng config
observed active VUs hợp lý
dropped_iterations khớp summary
actual iter/s gần target nếu không drop
```

## Chart caveats dễ hiểu nhầm

```text
summary-final là nguồn truth cuối cùng.
pointCount là số điểm chart/bucket, không phải số request/event.
metrics_push_count là số lần backend nhận payload metrics, không phải business count.
Dashboard bucket có thể downsample/aggregate; phải reconcile bằng sum đúng series.
```

## Common invalid-result patterns

| Pattern | Vì sao nguy hiểm | Cách xử lý |
| --- | --- | --- |
| `dropped_iterations > 0` nhưng vẫn kết luận pass vì latency đẹp | Test không đạt target ingress; latency chỉ đo phần đã chạy | Đọc VU pressure, tăng sizing hoặc giảm target rồi rerun |
| Gọi `preAllocatedVUs` là số user | Sai mental model; VU là worker capacity | Ghi rõ business users đến từ arrival events/user pool |
| So `iterations/s` summary trực tiếp với target start rate | Summary rate là completed iterations trên runtime thực tế | So theo bucket + dropped + duration |
| Sum `pointCount` thay vì metric value | pointCount chỉ là số bucket | Sum `value/count` đúng metric |
| Copy config constant-vus sang CAR | Closed model vs open model khác nhau | Tính lại `lambda × W` và drop budget |

## Reference docs

- Quick index: `docs/20260517_01_constant-arrival-rate-quick-index.md`
- Tham số/công thức: `docs/20260517_02_constant-arrival-rate-tham-so-cong-thuc.md`
- Worked example QuickPizza: `docs/20260517_03_constant-arrival-rate-quickpizza-two-requests-worked-example.md`
- Practice run guide: `docs/practice/constant-arrival-rate/RUN_GUIDE.md`
- Source pack: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\README.md`

## Thứ tự đề xuất đọc/làm

```text
1. Đọc 00_overview.md (file này)
2. Đọc RUN_GUIDE.md để start stack + hiểu wrapper summary-final
3. Làm 01_storefront-rps-contract (case dễ nhất, read ingress)
4. Làm 04_checkout-order-intake (low rate nhưng external latency cao)
5. Làm 05_report-api-ingress (async/job latency)
6. Làm 07_production-ingress-mix (mixed baseline)
7. Tự chỉnh RATE / PREALLOCATED_VUS / MAX_VUS để quan sát dropped_iterations
```
