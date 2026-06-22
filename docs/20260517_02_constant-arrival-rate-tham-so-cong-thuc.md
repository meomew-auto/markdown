# `constant-arrival-rate`: tham số, ý nghĩa và công thức

File này là bài song song với:

```text
docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md
docs/20260515_02_shared-iterations-tham-so-cong-thuc.md
docs/20260516_02_constant-vus-tham-so-cong-thuc.md
docs/20260517_02_ramping-vus-tham-so-cong-thuc.md
```

nhưng dành cho executor:

```text
constant-arrival-rate
```

Nguồn docs Grafana:
<https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/>

Nếu chỉ muốn tra nhanh, mở:

```text
docs/20260517_01_constant-arrival-rate-quick-index.md
```

Worked example QuickPizza:

```text
docs/20260517_03_constant-arrival-rate-quickpizza-two-requests-worked-example.md
```

## Mục lục nhanh

- [Ý tưởng chính](#1-ý-tưởng-chính)
- [Khi nào dùng thực tế](#11-khi-nào-dùng-thực-tế)
- [Nếu muốn tìm ngưỡng quá tải thì tăng gì?](#111-nếu-muốn-tìm-ngưỡng-quá-tải-thì-tăng-gì)
- [Open model vs closed model: vì sao arrival-rate khác hẳn VU-based](#13-open-model-vs-closed-model-vì-sao-arrival-rate-khác-hẳn-vu-based)
- [Core chạy như nào](#12-core-chạy-như-nào)
- [Bảng tham số tiếng Việt](#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](#3-công-thức-nền)
- [Checklist core đã lọc](#39-checklist-core-đã-lọc-cho-constant-arrival-rate)
- [Đọc vus và vus_max theo core](#391-đọc-vus-và-vus_max-theo-core)
- [Đọc iterations và iteration_duration theo core](#392-đọc-iterations-và-iteration_duration-theo-core)
- [Execution segment và rate scaling](#393-execution-segment-và-rate-scaling)
- [Bảng đối chiếu core truth](#394-bảng-đối-chiếu-core-truth)
- [Source map core đã đối chiếu](#395-source-map-core-đã-đối-chiếu)
- [Thêm nhầm field của executor khác](#310-thêm-nhầm-field-của-executor-khác-có-lỗi-không)
- [Hai trục độc lập: arrival timeline vs VU iter timeline](#311-hai-trục-độc-lập-arrival-timeline-vs-vu-iter-timeline)
- [Spawn timing của unplanned VU theo core](#312-spawn-timing-của-unplanned-vu-theo-core)
- [Lifecycle của unplanned VU](#313-lifecycle-của-unplanned-vu)
- [Dropped iterations: công thức và khi nào emit](#314-dropped-iterations-công-thức-và-khi-nào-emit)
- [gracefulStop interaction với arrival timeline](#315-gracefulstop-interaction-với-arrival-timeline)
- [Demo fixed start schedule đủ VU](#4-demo-fixed-start-schedule-đủ-vu)
- [Demo thiếu VU và dropped_iterations](#5-demo-thiếu-vu-và-dropped_iterations)
- [Demo preAllocatedVUs vs maxVUs](#6-demo-preallocatedvus-vs-maxvus)
- [Demo interrupt cuối scenario](#7-demo-interrupt-cuối-scenario)
- [Demo QuickPizza 2 requests / iteration](#8-demo-quickpizza-2-requests--iteration)
- [So sánh với constant-vus ramping-vus per-vu shared](#9-so-sánh-với-constant-vus-ramping-vus-per-vu-shared)
- [Edge case và config không hợp lệ](#10-edge-case-và-config-không-hợp-lệ)
- [Cheat sheet — Công thức cần nhớ nhất](#11-cheat-sheet--công-thức-cần-nhớ-nhất)
- [Cheat sheet (tóm gọn)](#12-cheat-sheet-tóm-gọn)

## 1. Ý tưởng chính

`constant-arrival-rate` nghĩa là:

```text
k6 cố start iteration theo một tốc độ cố định
rate/timeUnit quyết định lịch start iteration
VU chỉ là worker để chạy các iteration đã được schedule
```

Ví dụ:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "constant-arrival-rate",
      rate: 4,
      timeUnit: "1s",
      duration: "10s",
      preAllocatedVUs: 8,
      maxVUs: 12,
    },
  },
};
```

Hiểu là:

```text
trong 10 giây, k6 cố start khoảng 4 iteration mỗi giây
mỗi mốc start theo lịch cần 1 VU rảnh để nhận việc
nếu không có VU rảnh, mốc đó bị drop
```

Trong bài này, `slot` hay `slot thời gian` nghĩa là:

```text
một mốc start iteration theo lịch của arrival-rate executor
```

Nó không phải là VU, không phải queue, cũng không phải một resource riêng. Nó chỉ là cách gọi ngắn
cho thời điểm mà executor `constant-arrival-rate` muốn bắt đầu một iteration mới.

Ví dụ dưới đây là case `constant-arrival-rate` local run đơn giản. Với `rate: 4`, `timeUnit: "1s"`
thì executor cố start ở các mốc gần như:

```text
t = 0.00s
t = 0.25s
t = 0.50s
t = 0.75s
t = 1.00s
```

Ở mỗi mốc này, k6 cần 1 VU rảnh. Nếu không có VU rảnh, mốc đó bị tính là
`dropped_iterations`; k6 không chờ VU rảnh rồi chạy bù lại mốc cũ.

Nói rất đời thường:

```text
slot không phải là "khoảng 1 giây"
slot cũng không phải "một ô chứa việc"
slot chỉ là "đến đúng giờ này thì k6 muốn bấm start thêm 1 iteration"
```

Với `rate: 4, timeUnit: "1s"` thì vì 1 giây được chia thành 4 mốc start, nên khoảng cách gần đúng
giữa các slot là `0.25s`.
Nhưng bản chất vẫn là:

```text
slot = mốc thời gian
không phải tài nguyên
không phải VU
```

Không hiểu là:

```text
chạy 4 VU
chạy đúng 4 request/s trong mọi trường hợp
mỗi VU chạy 4 iteration/s
preAllocatedVUs là số user mục tiêu
maxVUs là throughput mục tiêu
```

Điểm cốt lõi:

```text
constant-arrival-rate = fixed iteration start rate
```

Đây là nhóm:

```text
open model
```

vì tốc độ start iteration được điều khiển bởi lịch thời gian, không phải bởi việc VU chạy xong iteration trước rồi tự loop tiếp.

Tốc độ start iteration nằm ở đâu?

```js
rate: 4,
timeUnit: "1s",
```

Nghĩa là:

```text
target_start_rate = 4 iteration starts / 1s
                  = 4 iteration starts/s
```

Khi chạy, header k6 cũng hiện target này, ví dụ:

```text
* demo: 4.00 iterations/s for 10s
```

Đây là tốc độ **start iteration theo lịch**. Đừng nhầm với dòng summary cuối:

```text
iterations...........: N  X/s
```

Dòng summary `X/s` là tốc độ **completed iterations trung bình trên `summary_runtime_base`**.

`rate: 4` không có nghĩa là ở pha init core tự tính đủ tài nguyên để chắc chắn chạy được 4 iteration/s.
Nó chỉ là target để arrival-rate executor tạo lịch start:

```text
rate = 4, timeUnit = 1s
=> cứ khoảng 0.25s có 1 mốc start iteration
```

Core chỉ dùng `preAllocatedVUs` để chuẩn bị sẵn VU và dùng `maxVUs` làm trần tạo thêm VU. Nếu tới
mốc start mà không có VU rảnh, mốc đó vẫn bị drop.

### 1.1. Khi nào dùng thực tế?

`constant-arrival-rate` hợp khi câu hỏi là:

```text
hệ thống chịu được tốc độ start work cố định X iteration/s không?
```

Ví dụ thực tế:

```text
luôn có 100 giao dịch mới mỗi giây
luôn có 50 lượt checkout mới mỗi giây
luôn có 200 job API mới mỗi phút
```

Mapping sang k6:

```text
rate = số iteration muốn start theo mỗi timeUnit, không phải số VU được tự tính
timeUnit = đơn vị thời gian của rate
duration = giữ tốc độ đó trong bao lâu
preAllocatedVUs = số VU chuẩn bị sẵn từ đầu
maxVUs = trần VU tối đa nếu cần thêm worker
```

Một vài case hợp:

- cần cố định arrival rate
- cần mô phỏng traffic từ bên ngoài đổ vào đều đều
- cần tìm số VU tối thiểu để giữ một target rate
- cần quan sát `dropped_iterations` khi hệ thống hoặc VU pool không đủ capacity
- cần tách câu hỏi "start rate" khỏi câu hỏi "iteration chạy nhanh hay chậm"

Không hợp khi mục tiêu là:

```text
có đúng N user đang loop liên tục
mỗi user chạy đúng M vòng
chia đúng tổng iteration cho nhiều VU
tăng giảm số user theo timeline
```

Khi đó thường dùng:

```text
constant-vus
per-vu-iterations
shared-iterations
ramping-vus
```

### 1.1.1. Nếu muốn tìm ngưỡng quá tải thì tăng gì?

Trước hết phải chọn bạn muốn tìm ngưỡng theo kiểu nào:

```text
ngưỡng traffic vào hệ thống
hay
ngưỡng số user đồng thời
```

Nếu câu hỏi là:

```text
hệ thống chịu được bao nhiêu request/s, transaction/s, iteration/s trước khi latency tăng mạnh hoặc lỗi nhiều?
```

thì dùng nhóm arrival-rate:

```text
ramping-arrival-rate để tăng dần rate và tìm vùng bắt đầu quá tải
constant-arrival-rate để giữ một mức rate cố định và xác nhận lại ngưỡng đó
```

Khi đó thứ tăng chính là:

```text
rate
```

Ví dụ tư duy:

```text
stage 1: 50 iterations/s
stage 2: 100 iterations/s
stage 3: 150 iterations/s
stage 4: 200 iterations/s
```

Bạn quan sát:

```text
http_req_duration p95/p99 tăng mạnh
http_req_failed tăng
checks_failed tăng
server CPU/RAM/DB connection tăng bất thường
```

Mức ngay trước khi các dấu hiệu này vượt ngưỡng là capacity gần đúng của hệ thống.

Lưu ý quan trọng:

```text
preAllocatedVUs và maxVUs không phải là tải mục tiêu
```

Với arrival-rate, `preAllocatedVUs/maxVUs` chỉ là năng lực của máy bắn tải. Tăng chúng khi k6 thiếu
worker để giữ được `rate`. Nếu `dropped_iterations` tăng vì thiếu VU rảnh, đó có thể là máy bắn tải
thiếu worker, không chắc là hệ thống server đã quá tải.

Nếu câu hỏi là:

```text
hệ thống chịu được bao nhiêu user đồng thời đang thao tác?
```

thì dùng nhóm VU-based:

```text
ramping-vus để tăng dần số VU và tìm ngưỡng
constant-vus để giữ một mức VU cố định và xác nhận lại
```

Khi đó thứ tăng chính là:

```text
stages[].target trong ramping-vus
hoặc vus trong constant-vus
```

Tóm tắt chọn executor:

| Mục tiêu tìm ngưỡng | Tăng cái gì | Executor nên dùng |
| --- | --- | --- |
| Ngưỡng RPS/TPS/iteration rate | `rate` | `ramping-arrival-rate`, sau đó xác nhận bằng `constant-arrival-rate` |
| Ngưỡng user đồng thời | `vus` hoặc `stages[].target` | `ramping-vus`, sau đó xác nhận bằng `constant-vus` |
| Chạy đúng tổng số vòng | `iterations` | `shared-iterations` |
| Mỗi user chạy đúng N vòng | `vus` + `iterations` mỗi VU | `per-vu-iterations` |

### 1.2. Core chạy như nào?

Trong code executor:

```text
lib/executor/constant_arrival_rate.go
lib/executor/helpers.go
```

Config riêng của executor:

```go
type ConstantArrivalRateConfig struct {
    BaseConfig
    Rate     null.Int           `json:"rate"`
    TimeUnit types.NullDuration `json:"timeUnit"`
    Duration types.NullDuration `json:"duration"`

    PreAllocatedVUs null.Int `json:"preAllocatedVUs"`
    MaxVUs          null.Int `json:"maxVUs"`
}
```

Default đáng nhớ:

```text
timeUnit = 1s nếu không set
maxVUs = preAllocatedVUs nếu không set
gracefulStop = default từ BaseConfig
```

Validate chính:

```text
rate phải có và > 0
timeUnit phải > 0
duration phải có và >= minDuration
preAllocatedVUs phải có và không âm
maxVUs không được nhỏ hơn preAllocatedVUs
```

Execution requirements trong `ConstantArrivalRateConfig.GetExecutionRequirements()`:

```text
TimeOffset = 0 của executor, chưa cộng scenario startTime:
  PlannedVUs = preAllocatedVUs
  MaxUnplannedVUs = maxVUs - preAllocatedVUs

TimeOffset = duration + gracefulStop của executor:
  PlannedVUs = 0
  MaxUnplannedVUs = 0
```

Nghĩa là:

```text
preAllocatedVUs được scheduler chuẩn bị sẵn
phần maxVUs - preAllocatedVUs là số VU có thể tạo thêm trong lúc chạy
```

Trong full execution plan, `ScenarioConfigs.GetFullExecutionRequirements()` mới cộng thêm
`startTime` của scenario vào các offset này. Vì vậy `TimeOffset = 0` ở đây là mốc bắt đầu tương
đối của executor, không phải luôn luôn là giây 0 của cả test nếu scenario có `startTime`.

Flow chạy chính:

```text
1. scheduler dùng GetExecutionRequirements() để biết cần init trước bao nhiêu planned VUs
2. nếu có startTime, scheduler đợi tới startTime rồi mới gọi executor.Run()
3. trong Run(), executor activate toàn bộ preAllocatedVUs đã được scheduler chuẩn bị
4. tính arrivalRate từ rate/timeUnit và execution segment
5. tính tickerPeriod = 1 / arrivalRate
6. đến mỗi mốc start theo lịch, gọi vusPool.TryRunIteration()
7. nếu có VU rảnh: start iteration
8. nếu không có VU rảnh: emit dropped_iterations = 1
9. nếu còn room dưới maxVUs: cố tạo unplanned VU ở background
10. hết duration: ngừng schedule mốc start mới
11. gracefulStop cho iteration đã start có thời gian kết thúc
```

Tách rõ các lớp core:

| Lớp | Code | Làm gì |
| --- | --- | --- |
| Parse config | `RegisterExecutorConfigType()` + `StrictJSONUnmarshal()` | scenario explicit bị strict, field lạ sẽ lỗi |
| Validate | `Validate()` | kiểm tra `rate`, `timeUnit`, `duration`, `preAllocatedVUs`, `maxVUs` |
| Reserve VU | `GetExecutionRequirements()` | báo scheduler cần `preAllocatedVUs` planned VUs và room unplanned |
| Init executor | `Init()` | tạo execution tuple/segmented index, không tự tạo đủ VU theo `rate` |
| Wait start | `Scheduler.runExecutor()` | nếu có `startTime`, scheduler đợi trước khi gọi `Run()` |
| Run schedule | `Run()` | tính arrival rate, ticker period, activate planned VUs, schedule mốc start |
| Run iteration | `activeVUPool.TryRunIteration()` | non-blocking: có VU rảnh thì chạy, không có thì trả `false` ngay |
| Drop | `DroppedIterations` sample | mốc hiện tại bị drop, không retry/bù lại |
| Graceful stop | `getDurationContexts()` | `duration` dừng mốc start mới, `duration + gracefulStop` là trần cho iteration đang chạy |

`Init()` của executor này dễ bị hiểu nhầm. Nó không làm việc này:

```text
rate = 4 nên tự tính ra cần N VU rồi tự tạo N VU
```

Nó chỉ làm phần execution-segment/index:

```go
et, err := car.executionState.ExecutionTuple.GetNewExecutionTupleFromValue(car.config.MaxVUs.Int64)
car.et = et
car.iterSegIndex = lib.NewSegmentedIndex(et)
```

VU được chuẩn bị bởi scheduler theo `GetExecutionRequirements()`, còn số lượng là từ config
`preAllocatedVUs`, không phải từ công thức auto-sizing theo `rate`.

Mốc start được neo theo `startTime` bên trong `Run()`:

```go
startTime, maxDurationCtx, regDurationCtx, cancel := getDurationContexts(parentCtx, duration, gracefulStop)
...
t := notScaledTickerPeriod*time.Duration(gi) - time.Since(startTime)
timer.Reset(t)
```

Nghĩa là lịch start tính từ lúc executor thật sự bắt đầu chạy, sau khi scheduler đã đợi xong
`startTime` nếu có.

Điểm khác hẳn closed model:

```text
constant-vus/ramping-vus:
  VU chạy xong iteration rồi mới start iteration kế

constant-arrival-rate:
  đến mốc start theo lịch thì k6 cố start iteration mới
```

Nếu mốc start bị drop:

```text
k6 không chờ bù mốc đó
k6 không chạy muộn để đuổi target
dropped_iterations tăng
```

### 1.3. Open model vs closed model: vì sao arrival-rate khác hẳn VU-based

Đây là phần nhiều người dùng k6 đọc cảm tính dễ sai, nên cần tách thật rõ.

`constant-vus`, `ramping-vus`, `per-vu-iterations`, `shared-iterations` đều thuộc nhóm
**closed model**. Trong closed model:

```text
mỗi VU là một chiếc vòng lặp tự đóng
VU loop:
  1. start iteration
  2. chạy function default
  3. finish iteration
  4. quay lại bước 1 ngay (nếu chưa hết duration / chưa hết quota)
```

Tốc độ start iteration sinh ra một cách thụ động:

```text
start_rate_closed ~= active_vus / iteration_duration
```

Nghĩa là server trả lời chậm thì start_rate tự động giảm. Không có khái niệm "drop slot": nếu VU
chưa rảnh, đơn giản là chưa có iteration mới được start.

`constant-arrival-rate` và `ramping-arrival-rate` thuộc nhóm **open model**. Trong open model:

```text
arrival timeline là độc lập với VU
arrival timeline:
  cứ tickerPeriod giây thì có 1 mốc fire
  fire xảy ra dù VU có rảnh hay không
VU pool là một worker pool tách biệt:
  worker rảnh thì nhận mốc fire
  worker bận thì mốc fire bị drop
```

Tốc độ start iteration được driven chủ động bởi config `rate/timeUnit`:

```text
start_rate_open = rate / timeUnit_seconds (cố định)
```

Khác biệt then chốt:

| Câu hỏi | Closed model | Open model |
| --- | --- | --- |
| Ai control start rate? | iteration_duration của VU | config `rate/timeUnit` |
| Server chậm thì sao? | start_rate tự giảm theo | start_rate giữ nguyên, dồn áp lực |
| Có khái niệm drop iteration? | Không | Có (`dropped_iterations`) |
| Có khái niệm unplanned VU runtime? | Không | Có (preAllocated -> max) |
| Cần khai báo `vus` trực tiếp? | Có | Không, khai báo capacity bằng `preAllocatedVUs/maxVUs` |
| Field chính | `vus`, `iterations` | `rate`, `timeUnit`, `preAllocatedVUs`, `maxVUs` |
| Kết quả khi quá tải | latency tăng, throughput cap | dropped_iterations tăng |

Vì sao arrival-rate cần cả `preAllocatedVUs` lẫn `maxVUs`?

```text
preAllocatedVUs = chuẩn bị sẵn worker để giữ start rate ngay từ giây đầu
maxVUs = trần an toàn nếu pool không đủ và k6 phải tạo thêm worker giữa lúc đo
```

Với closed model thì chỉ cần một biến `vus`: số worker cũng là số iteration đồng thời, vì worker đã
quy định start rate. Với open model, số worker không quy định start rate. Số worker chỉ quyết định
năng lực hấp thụ start rate. Nên cần 2 biến: một biến cho worker đã sẵn (`preAllocatedVUs`), một
biến cho trần (`maxVUs`).

Hệ quả tư duy quan trọng:

```text
arrival-rate = "một sự kiện bên ngoài đang gọi vào hệ thống"
closed model = "một số người dùng cố định đang vận hành tại chỗ"
```

Real world map:

| Use case | Mô hình hợp | Lý do |
| --- | --- | --- |
| Mô phỏng traffic người dùng đổ vào hệ thống | open / arrival-rate | flow request đến từ Internet, không bị giới hạn bởi việc server đang chậm |
| Mô phỏng N nhân viên đang dùng nội bộ | closed / VU-based | nhân viên chậm thì hành vi tiếp theo cũng chậm, không "fire mốc mới" |
| Đo throughput max của API | open / arrival-rate | giữ start rate, đo xem server tự sập ở mức nào |
| Đo trải nghiệm khi 100 người ngồi cùng dùng app | closed / constant-vus | quan tâm tới latency của từng "người" |

Trong arrival-rate, một câu hay đọc nhầm là:

```text
preAllocatedVUs là số người dùng mục tiêu của bài test
```

Đây là sai. `preAllocatedVUs` không phải là payload, mà là vốn của máy bắn tải. Tăng nó không làm
load tăng. Chỉ tăng `rate` mới làm load tăng.

Sai đối xứng phía closed model:

```text
constant-vus với vus=100 nghĩa là tải target 100 RPS
```

Cũng sai. `vus=100` chỉ là 100 worker. RPS phụ thuộc vào `iteration_duration` của script. Nếu
function chạy 200ms thì đó là khoảng `100 * (1/0.2) = 500` iter/s (với 1 request/iter là 500 RPS).
Nếu function chậm còn 2s thì còn `50 RPS`. Closed model không cho phép pin throughput.

Một cách kiểm tra nhanh xem mình đang ở mô hình nào: tự hỏi

```text
nếu server phía sau bị chậm gấp 2 lần, thì k6 có giảm tốc độ start iteration không?
- Có   -> closed model (constant-vus, ramping-vus, per-vu-iterations, shared-iterations)
- Không -> open model (constant-arrival-rate, ramping-arrival-rate) -> sẽ thấy dropped_iterations
```

Bảng đối chiếu nhanh giữa hai họ:

| Tình huống | constant-vus (closed) | constant-arrival-rate (open) |
| --- | --- | --- |
| Server chậm gấp đôi | iteration_duration tăng, throughput giảm, không drop | start rate giữ nguyên, VU pool bão hòa, drop tăng |
| Server crash | request fail, VU vẫn loop, iteration vẫn đếm | request fail, VU vẫn nhận mốc fire mới |
| Cần cấp 1000 RPS đều | không đảm bảo | đảm bảo bằng rate=1000, timeUnit=1s |
| Cần test trải nghiệm 50 user | đặt vus=50, đảm bảo | không đảm bảo concurrency |

Vì hai trục đo khác nhau, output của hai họ executor cũng khác nhau:

```text
closed model:
  - vus, vus_max là core metric
  - dropped_iterations không có ý nghĩa trong closed model
  - throughput đọc từ iterations/s

open model:
  - rate là core metric (input)
  - dropped_iterations là core metric (output)
  - vus, vus_max chỉ là worker pool size (tham khảo capacity), không phải tải
```

Khi đọc tài liệu Grafana về `vus` và `vus_max`, hãy nhớ chúng là sample từ scheduler, không liên
quan tới `rate`. Trong open model, `vus_max` thấp hơn `maxVUs` của config khi run không cần
spawn unplanned, đó là điều bình thường, không phải bug.

Cuối cùng, một điểm dễ nhầm khi mix scenarios:

```text
options.scenarios = {
  peak: { executor: "constant-arrival-rate", rate: 100, ... preAllocatedVUs: 50, maxVUs: 100 },
  background: { executor: "constant-vus", vus: 10, duration: "5m" },
}
```

k6 chạy đồng thời được cả hai. Số VU tổng max của process là cộng:

```text
total_max_vus = 100 (peak.maxVUs) + 10 (background.vus) = 110
```

Mỗi scenario tự lấy phần VU từ pool chung của ExecutionState, không lẫn phạm vi với nhau. Nên đừng
nghĩ "constant-vus 10 đã đủ rồi, không cần preAllocatedVUs cho peak". Hai pool tách biệt, không
share worker.

## 2. Bảng tham số tiếng Việt

| Tham số | Ý nghĩa | Bắt buộc | Ví dụ | Ghi chú |
| --- | --- | --- | --- | --- |
| `executor` | loại executor | Có | `constant-arrival-rate` | Bắt buộc khi dùng explicit scenario. |
| `rate` | số iteration muốn start trong mỗi `timeUnit` | Có | `4` | Đây là target start rate, không phải số VU. |
| `timeUnit` | đơn vị thời gian của `rate` | Không | `1s`, `1m` | Default là `1s`. |
| `duration` | thời gian schedule mốc start mới | Có | `30s` | Sau thời gian này, không start mốc mới. |
| `preAllocatedVUs` | số VU chuẩn bị sẵn từ đầu | Có | `20` | Nên sizing đủ để không cần tạo VU lúc đang đo. |
| `maxVUs` | trần VU tối đa | Không | `40` | Nếu không set, bằng `preAllocatedVUs`. |
| `gracefulStop` | thời gian cho iteration đang chạy finish sau `duration` | Không | `5s` | Không tạo mốc start mới trong gracefulStop. |
| `startTime` | delay trước khi scenario bắt đầu | Không | `10s` | Scheduler đợi xong `startTime` rồi mới gọi `Run()`. |
| `exec` | function JS được gọi | Không | `checkout` | Default là `default`. |
| `tags`, `env` | tags/env riêng cho scenario | Không | `{ type: "api" }` | Đi từ BaseConfig. |

Các đại lượng hay dùng trong bài:

| Đại lượng | Ý nghĩa | Công thức / nguồn |
| --- | --- | --- |
| `lambda` | target iteration start rate theo giây | `rate / timeUnit_seconds` |
| `ticker_period` | khoảng cách giữa 2 mốc start theo lịch | `1 / lambda` |
| `regular_duration` | thời gian schedule mốc start mới | `duration` |
| `executor_wall_time_after_start_max` | trần thời gian executor | `duration + gracefulStop` |
| `planned_vus` | VU chuẩn bị sẵn | `preAllocatedVUs` |
| `max_unplanned_vus` | VU có thể tạo thêm | `maxVUs - preAllocatedVUs` |
| `completed_iterations` | iteration hoàn thành | metric `iterations` |
| `dropped_iterations` | mốc start không chạy được vì thiếu VU rảnh | metric `dropped_iterations` |
| `interrupted_iterations` | iteration đã start nhưng bị cancel | progress cuối |
| `http_requests_per_iteration` | số HTTP request trong 1 iteration nếu code path chạy đủ | đọc từ code |
| `checks_per_iteration` | số check trong 1 iteration | đọc từ code |

## 3. Công thức nền

### 3.1. Target start rate

Với:

```js
rate: 4,
timeUnit: "1s",
```

có:

```text
lambda = rate / timeUnit_seconds
       = 4 / 1
       = 4 iterations/s
```

Khoảng cách giữa 2 mốc start:

```text
ticker_period = 1 / lambda
              = 1 / 4
              = 0.25s
```

Với:

```js
rate: 120,
timeUnit: "1m",
```

có:

```text
lambda = 120 / 60
       = 2 iterations/s

ticker_period = 0.5s
```

### 3.2. Scheduled, completed, dropped, interrupted

Trong `constant-arrival-rate`, công thức quan trọng nhất không phải chỉ là đếm tổng iteration.
Phải tách 4 loại số liệu này trước:

```text
scheduled slot = một mốc start iteration theo lịch của k6
completed iteration = iteration đã chạy xong đầy đủ
dropped iteration = mốc start đến hạn nhưng không có VU rảnh để chạy
interrupted iteration = iteration đã start nhưng bị cancel trước khi finish
```

Giải thích từng tham số:

| Tên | Nghĩa | Đọc ở đâu |
| --- | --- | --- |
| `scheduled slot` | mốc mà k6 muốn start 1 iteration | suy từ `rate/timeUnit`, log `iterInScenario`, hoặc công thức quan sát |
| `completed_iterations` | số iteration đã chạy hết function `default`/`exec` | metric `iterations` |
| `dropped_iterations` | số mốc start bị bỏ vì thiếu VU rảnh | metric `dropped_iterations` |
| `interrupted_iterations` | số iteration đã start nhưng bị cancel | progress cuối: `X interrupted iterations` |

Công thức đọc output thực tế là:

```text
observed_scheduled_slots ~= completed_iterations + interrupted_iterations + dropped_iterations
```

Đây là con số bạn TỰ TÍNH, không có sẵn trong summary. Nó dùng để:

1. Biết tổng slot thực tế đã được schedule — thay vì dùng con số lý thuyết
   `rate × duration` (có thể lệch do mốc đầu thường gần t=0, mốc cuối phụ
   thuộc timing).

2. Kiểm tra "hạch toán": nếu N_done + N_drop + N_int khớp với N_sched lý
   thuyết → mọi slot đều có lời giải thích, không bị thất thoát.

3. Tìm nguyên nhân thiếu hụt: khi iterations thấp hơn dự kiến, nhìn vào
   N_drop (thiếu VU rảnh) và N_int (bị cắt lúc hết duration) để biết
   nguyên nhân chính.

Tóm lại: `observed_scheduled_slots` là công cụ GIẢI THÍCH, không phải metric.
Ba con số trong summary là N_done (iterations), N_drop (dropped_iterations),
N_int (footer "X interrupted"). Cộng chúng lại → biết có bao nhiêu slot đã
được schedule trong thực tế.

Đây là công thức đọc output để giải thích run, không phải invariant tuyệt đối của mọi edge case.

Tức là:

```text
tổng mốc đã xảy ra trong run
~= số mốc chạy xong
 + số mốc đã start nhưng bị interrupt
 + số mốc không start được vì thiếu VU
```

Không nên viết cứng công thức này như tuyệt đối cho mọi run ngắn:

```text
scheduled_slots = rate * duration_seconds / timeUnit_seconds
```

Lý do: mốc đầu thường start gần `t=0`, mốc sát boundary cuối phụ thuộc timing.

Ví dụ cụ thể — config `rate: 4, timeUnit: "1s", duration: "4s"`:

```text
Bước 1: Tính khoảng cách giữa các mốc
  gap = timeUnit / rate = 1s / 4 = 0.25s

Bước 2: Liệt kê các mốc từ t=0, mỗi lần +0.25s
  slot 1:  t = 0.00s
  slot 2:  t = 0.25s
  slot 3:  t = 0.50s
  slot 4:  t = 0.75s
  slot 5:  t = 1.00s
  ...
  slot 16: t = 3.75s   ← (16-1)×0.25 = 3.75 < 4.0 → được schedule
  slot 17: t = 4.00s   ← 4.00 = duration → ???

Bước 3: Mốc t=4.00s có được schedule không?

  Trong core k6 (`constant_arrival_rate.go:364`), executor có 2 tín hiệu
  cùng lúc tại t=4.00s:

    Tín hiệu A: "đến giờ bắn slot tiếp theo" (timer hết hạn)
    Tín hiệu B: "hết duration rồi, dừng lại"   (regDurationCtx hết hạn)

  Cả 2 cùng réo tại 4.00s. Executor chỉ nghe được 1 trong 2:

    - Nghe A trước → bắn nốt slot cuối → 17 slot
    - Nghe B trước → dừng luôn, không bắn nữa → 16 slot

  Không đoán trước được vì 2 tín hiệu đến cùng lúc, executor chọn
  ngẫu nhiên. Đây là race condition ở mức code, không phải lỗi —
  chỉ là không thể biết trước 16 hay 17.

  → Kết luận: `rate × duration = 16` là con số lý thuyết, thực tế
    có thể 16 hoặc 17. Muốn biết chính xác → đọc metric sau khi chạy.

Bước 4: Ảnh hưởng — sai số tuyệt đối luôn ≤ 1 slot (slot biên).
  Nhưng sai số TƯƠNG ĐỐI phụ thuộc độ dài run:

  Run 4s:   1 slot lệch / 16 slot  = 6.25% (lớn, không nên dùng công thức)
  Run 10s:  1 slot lệch / 40 slot  = 2.5%
  Run 60s:  1 slot lệch / 240 slot = 0.4%
  Run 300s: 1 slot lệch / 1200 slot = 0.08% (vô nghĩa)

  → Run càng dài, 1 slot biên càng "chìm" vào tổng số.
  → Với run ngắn: dùng observed_scheduled_slots từ metric, không dùng công thức.
```

Trường hợp rate không chia hết — `rate: 3/s, duration: "5s"`:

```text
  gap = 1/3 ≈ 0.333s

  Liệt kê:
  slot 1:  t=0.000
  slot 2:  t=0.333
  slot 3:  t=0.667
  slot 4:  t=1.000
  ...
  slot 15: t=4.667   ← 4.667 < 5.0 → OK
  slot 16: t=5.000   ← 5.000 = duration → ???
  slot 17: t=5.333   ← 5.333 > 5.0 → chắc chắn KHÔNG

  → Có thể 15 hoặc 16 slot, tùy cách check biên tại t=5.000.
  → Công thức lý thuyết: rate × duration = 3 × 5 = 15.
  → Nhưng nếu slot t=5.000 được schedule → thực tế là 16, lệch 1 slot.
```

Kết luận:
- `rate × duration` là ước lượng LÝ THUYẾT, không phải số đếm thực tế
- Muốn biết chính xác có bao nhiêu slot đã schedule → dùng `observed_scheduled_slots = N_done + N_drop + N_int` từ metric sau khi chạy
- Với run dài (vài phút), 1 slot lệch không đáng kể. Với run ngắn (vài giây), phải đọc từ metric.

**── `rate × duration` và họ hàng với executor khác ──**

`rate × duration` trong constant-arrival-rate là "tổng slot lý thuyết được
schedule". Cùng một khuôn với các executor khác — chỉ khác *rate* đến từ đâu:

| Executor | Tổng work lý thuyết | Rate đến từ đâu | Có trong summary? |
| --- | --- | --- | --- |
| **per-vu-iterations** | `vus × iterations` | Không cần rate, count tuyệt đối | Có: `iterations` |
| **constant-vus** | `vus × duration / iter_time` | `rate = vus / iter_time` (phụ thuộc latency) | Có: `iterations...: N X/s` |
| **constant-arrival-rate** | `rate × duration` | `rate` từ config (cố định theo lịch) | **Không** — summary `iterations` là N_done, không phải N_sched |

Trong constant-arrival-rate, `rate × duration` trả lời "bao nhiêu slot đã lên lịch",
**không** phải "bao nhiêu iter đã xong". Summary `iterations` = slot CHẠY XONG,
luôn ≤ `rate × duration` (vì có thể drop/interrupt).

`duration` ở đây là field config, bạn tự đặt:
```js
duration: "5m",  // ← 300s, thời gian k6 mở cửa schedule slot
```
Không phải thứ trong summary. Summary chỉ có `iteration_duration` (thời gian
1 iter) — đơn vị khác hẳn.

Little's Law nối 2 thế giới:

```text
constant-vus:            rate = vus / iter_time   (rate sinh ra từ VU)
constant-arrival-rate:   required_vus = rate × iter_time  (VU cần để giữ rate)
```

Cùng là `rate × iter_time` nhưng chiều ngược nhau:
- Với constant-vus: `rate × iter_time = vus` → biết VU → tính rate
- Với constant-arrival-rate: `rate × iter_time = vus cần` → biết rate → tính VU

Ví dụ 1, đủ VU:

```js
rate: 4,
timeUnit: "1s",
duration: "4s",
preAllocatedVUs: 4,
maxVUs: 4,
```

Effective busy time trong demo khoảng:

```text
W_effective ~= 0.4s
```

Số `0.4s` này đọc từ code demo:

```js
const ITERATION_SECONDS = 0.4;

export default function () {
  sleep(ITERATION_SECONDS);
}
```

Vì demo này gần như chỉ `sleep(0.4)`, nên `W_effective` xấp xỉ `0.4s`. Output cũng xác nhận:

```text
iteration_duration...: avg=400.53ms
```

Output mẫu:

```text
iterations...........: 16
running (4.2s), 0/4 VUs, 16 complete and 0 interrupted iterations
```

Không có dòng `dropped_iterations`, nên:

```text
completed_iterations = 16
interrupted_iterations = 0
dropped_iterations = 0

observed_scheduled_slots ~= 16 + 0 + 0
                         = 16
```

Nghĩa là các mốc start đều có VU rảnh để chạy.

Ví dụ 2, thiếu VU:

```js
rate: 10,
timeUnit: "1s",
duration: "3s",
preAllocatedVUs: 2,
maxVUs: 2,
```

Effective busy time khoảng:

```text
W_effective ~= 1s
```

Output mẫu:

```text
dropped_iterations...: 24
iterations...........: 6
running (3.3s), 0/2 VUs, 6 complete and 0 interrupted iterations
```

Đọc là:

```text
completed_iterations = 6
interrupted_iterations = 0
dropped_iterations = 24

observed_scheduled_slots ~= 6 + 0 + 24
                         = 30
```

Nghĩa là trong run có khoảng 30 mốc start. Chỉ 6 mốc có VU rảnh để chạy, 24 mốc bị drop.

Ví dụ 3, iteration bị interrupt:

```js
rate: 1,
timeUnit: "1s",
duration: "1s",
preAllocatedVUs: 1,
maxVUs: 1,
gracefulStop: "0s",
```

Function lại `sleep(5)`. Output mẫu:

```text
dropped_iterations...: 1
running (1.0s), 0/1 VUs, 0 complete and 1 interrupted iterations
```

Đọc là:

```text
completed_iterations = 0
interrupted_iterations = 1
dropped_iterations = 1

observed_scheduled_slots ~= 0 + 1 + 1
                         = 2
```

Mốc đầu start được nhưng bị interrupt vì hết thời gian. Mốc sau tới lúc VU vẫn bận nên bị drop.

### 3.3. Sizing VU pool

Phần này trả lời câu hỏi:

```text
muốn giữ được target rate thì cần chuẩn bị khoảng bao nhiêu VU?
```

**Quy trình sizing 3 bước:**

```text
Bước 1: Đo W_effective — thời gian 1 VU bận cho 1 iteration
        Chạy thử script, xem iteration_duration trong summary.
        Nếu có minIterationDuration: W = max(iteration_duration, minIterationDuration)

Bước 2: Xác định lambda — tốc độ start iteration target
        lambda = rate / timeUnit (vd: rate=30, timeUnit="1s" → lambda=30/s)

Bước 3: Tính preAllocatedVUs tối thiểu
        preAllocatedVUs >= ceil(lambda × W_effective)
```

Core k6 **không tự tính rồi tự set `preAllocatedVUs` cho bạn**. Bạn phải
sizing bằng số liệu của script. Nếu bạn set `preAllocatedVUs` quá thấp,
k6 sẽ cố spawn unplanned VU (đến `maxVUs`), nhưng vài slot đầu vẫn drop
vì spawn VU cần thời gian (~vài ms đến vài trăm ms).

**── Công thức ──**

Các biến:

```text
lambda = target iteration start rate theo giây
W_effective = thời gian một VU bị bận cho một iteration
M = số VU có thể dùng để chạy iteration
```

Giải thích từng biến:

| Biến | Nghĩa | Đơn vị | Đọc từ đâu |
| --- | --- | --- | --- |
| `lambda` | tốc độ k6 muốn start iteration | iterations/s | `rate / timeUnit_seconds` hoặc header `X iterations/s` |
| `W_effective` | thời gian 1 VU bị bận cho 1 iteration đầy đủ | seconds/iteration | thường lấy từ `iteration_duration` avg/p90/p95 nếu không có `minIterationDuration` |
| `M` | số VU đang có để nhận việc | VUs | `preAllocatedVUs`, hoặc tối đa `maxVUs` nếu cho tạo thêm |
| `required_vus_min` | số VU tối thiểu gần đúng để không drop | VUs | `ceil(lambda * W_effective)` |
| `capacity_with_M_vus` | capacity gần đúng của `M` VU | iterations/s | `M / W_effective` |

VU tối thiểu gần đúng:

```text
required_vus_min ~= ceil(lambda * W_effective)
```

Trong các demo của bài này không set `minIterationDuration`, nên có thể lấy gần đúng:

```text
W_effective ~= iteration_duration
```

Nếu global options có `minIterationDuration`, core emit `iteration_duration` trước phần sleep bù
`minIterationDuration`, nhưng VU vẫn bận cho tới khi sleep bù xong. Khi đó nên sizing bằng:

```text
W_effective ~= max(iteration_duration, minIterationDuration)
```

Vì sao nhân như vậy?

```text
lambda = mỗi giây cần start bao nhiêu iteration
W_effective = mỗi iteration giữ 1 VU bận bao lâu

lambda * W_effective = số iteration đang chạy đồng thời trung bình
                     = số VU tối thiểu cần có
```

Ví dụ:

```text
lambda = 4 iterations/s
W_effective = 0.6s

required_vus_min ~= ceil(4 * 0.6)
                 = ceil(2.4)
                 = 3 VUs
```

Nghĩa là nếu mỗi iteration giữ VU bận 0.6 giây, mà mỗi giây muốn start 4 iteration, thì trung bình cần khoảng 2.4 VU đang bận. Vì VU là số nguyên, làm tròn lên thành 3.

Capacity với `M` VU:

```text
capacity_with_M_vus ~= M / W_effective
```

Đây là công thức nghịch đảo của `required_vus_min`:
```text
required_vus_min = ceil(lambda × W)     → "muốn rate lambda thì cần ? VU"
capacity         = M / W                → "có M VU thì chịu được rate ?"
```

Hai công thức dùng chung 2 biến (`lambda`/`capacity` và `M`/`required_vus_min`),
chỉ khác chiều tính. Nếu `M < required_vus_min` thì `capacity < lambda`.

Nghĩa là nếu có `M` VU và mỗi VU bị chiếm `W_effective` giây để xong 1 iteration, thì cả pool làm được khoảng `M / W_effective` iteration mỗi giây.

Công thức này chính là Little's Law áp dụng cho VU pool:
```text
capacity = số VU / thời gian bận mỗi iter
         = M / W_effective
```
Giống hệt `peak_rate = vus / iter_time` bên constant-vus, chỉ khác là
ở đây `capacity` là GIỚI HẠN của pool — nếu lambda vượt quá capacity
thì slot thừa sẽ drop.

Nếu:

```text
lambda > capacity_with_M_vus
```

thì thường thấy:

```text
dropped_iterations tăng
warning: Insufficient VUs
```

Drop rate gần đúng:

```text
drop_rate ~= max(0, lambda - capacity_with_M_vus)
```

**── Ví dụ thiếu VU, phân tích từng bước ──**

```text
lambda        = 10 iterations/s   (mỗi giây muốn start 10 slot)
W_effective   = 1s                (1 iteration giữ VU bận 1 giây)
M             = 2 VUs             (chỉ có 2 VU để nhận việc)

Bước 1 — Tính capacity của pool:
  capacity = M / W_effective = 2 / 1 = 2 iterations/s

  Phân tích kỹ con số 2/s:
    W = 1s → 1 VU xong 1 iter mất 1s → tốc độ 1 VU = 1/1 = 1 iter/s
    Có 2 VU → 2 × 1 = 2 iter/s

    Viết gọn: capacity = M × (1/W) = 2 × (1/1) = 2 iter/s
                        ↑         ↑
                    số VU     tốc độ 1 VU (đảo từ thời gian)

  → 2 VU, mỗi VU xong 1 iter trong 1s → 1 giây làm được tối đa 2 iter

Bước 2 — So sánh lambda với capacity:
  lambda = 10/s, capacity = 2/s
  → Mỗi giây muốn start 10 slot nhưng chỉ xử lý được 2
  → 8 slot mỗi giây không có VU rảnh → DROP

Bước 3 — Tính drop rate:
  drop_rate = max(0, 10 - 2) = 8 drops/s

Bước 4 — Timeline 1 giây đầu tiên:
  t=0.00: slot 1 → VU 1 nhận, bận đến t=1.00
  t=0.10: slot 2 → VU 2 nhận, bận đến t=1.10
  t=0.20: slot 3 → KHÔNG CÓ VU RẢNH → DROP
  t=0.30: slot 4 → DROP
  ...
  t=0.90: slot 10 → DROP
  → 2 slot chạy, 8 slot drop trong giây đầu

  Sang giây thứ 2: VU 1 rảnh lúc t=1.00, VU 2 rảnh lúc t=1.10
  → Vẫn chỉ xử lý được ~2 slot/s, 8 slot/s drop đều đặn
```

Với `duration = 3s`:

```text
expected_dropped ~= drop_rate × duration
                 = 8 × 3
                 = 24 drops
```

Output demo đúng khoảng này:

```text
dropped_iterations...: 24
```

Ví dụ đủ VU:

```text
lambda = 4 iterations/s
W_effective = 0.4s
M = 4 VUs

required_vus_min ~= ceil(4 * 0.4)
                 = ceil(1.6)
                 = 2 VUs

capacity_with_4_vus ~= 4 / 0.4
                    = 10 iterations/s
```

Vì capacity 10/s lớn hơn target 4/s, demo không có `dropped_iterations`.

Ví dụ QuickPizza:

```text
rate = 2
timeUnit = 1s
lambda = 2 iterations/s

iteration_duration_avg ~= 1.76s
W_effective ~= 1.76s vì demo không có minIterationDuration

required_vus_min ~= ceil(2 * 1.76)
                 = ceil(3.52)
                 = 4 VUs
```

Config demo:

```js
preAllocatedVUs: 6,
maxVUs: 8,
```

Output cho thấy:

```text
vus............................: 2     min=2       max=4
vus_max........................: 6     min=6       max=6
```

Đọc là:

```text
run này thực tế cần tối đa khoảng 4 VU active
đã chuẩn bị sẵn 6 VU
không cần tạo unplanned VU
không có dropped_iterations
```

Khi sizing thật, nên dùng số cao hơn avg:

```text
safe_vus ~= ceil(lambda * W_effective_p95 * safety_factor)
```

Ví dụ:

```text
lambda = 2 iterations/s
W_effective_p95 = 2.08s
safety_factor = 1.2

safe_vus ~= ceil(2 * 2.08 * 1.2)
         = ceil(4.992)
         = 5 VUs
```

Nếu muốn tránh tạo VU lúc đang chạy test, đặt:

```text
preAllocatedVUs >= safe_vus
```

Khi sizing thật, không dùng đúng sát biên. Nên có margin vì latency mạng, JS logic, `sleep()`, và initialization của unplanned VU đều làm nhịp mốc start xấu hơn.

### 3.4. preAllocatedVUs vs maxVUs

Hai field này rất dễ đọc nhầm.

```text
preAllocatedVUs = số VU đã chuẩn bị sẵn trước khi scenario chạy
maxVUs = trần tối đa executor được phép dùng
```

Nếu:

```js
preAllocatedVUs: 1,
maxVUs: 4,
```

thì core hiểu là:

```text
planned VUs sẵn từ đầu = 1
room tạo unplanned VUs = 4 - 1 = 3
```

`unplanned VU` là VU được k6 tạo thêm trong lúc scenario đang chạy, khi arrival-rate cần thêm worker.
Nó không có sẵn từ đầu như `preAllocatedVUs`.

Theo core `constant_arrival_rate.go`, flow ở mỗi mốc start là:

```text
1. đến mốc start theo lịch
2. gọi vusPool.TryRunIteration()
3. nếu có VU rảnh: start iteration ngay
4. nếu không có VU rảnh: push metric dropped_iterations = 1
5. sau khi drop mốc hiện tại, nếu còn room dưới maxVUs thì thử tạo unplanned VU ở background
6. unplanned VU tạo xong chỉ giúp các mốc start sau, không cứu lại mốc vừa bị drop
```

Đoạn core tương ứng:

```go
if vusPool.TryRunIteration() {
    continue
}

// không có VU rảnh => mốc hiện tại bị drop
metrics.PushIfNotDone(... DroppedIterations ..., Value: 1)

if remainingUnplannedVUs == 0 {
    warning("Insufficient VUs...")
    continue
}

select {
case makeUnplannedVUCh <- struct{}{}:
    remainingUnplannedVUs--
default:
    // đang tạo unplanned VU rồi
}
```

Vì vậy câu:

```text
mốc hiện tại vẫn có thể bị drop
```

nghĩa là:

```text
drop xảy ra trước
tạo unplanned VU xảy ra sau
unplanned VU không chạy bù mốc đã drop
```

Các case có thể xảy ra:

| Case | Trạng thái tại mốc start | Core làm gì | Kết quả |
| --- | --- | --- | --- |
| 1 | Có VU rảnh | `TryRunIteration()` thành công | iteration start, không drop |
| 2 | Không có VU rảnh, còn room `maxVUs` | drop mốc hiện tại, gửi tín hiệu tạo unplanned VU | mốc hiện tại mất, VU mới có thể giúp mốc sau |
| 3 | Không có VU rảnh, đang tạo unplanned VU rồi | drop mốc hiện tại, không gửi thêm tín hiệu | chờ VU đang init xong, mốc hiện tại vẫn mất |
| 4 | Không có VU rảnh, đã đạt `maxVUs` | drop mốc hiện tại, warning `Insufficient VUs` | các mốc sau cũng dễ drop nếu VU vẫn bận |
| 5 | Unplanned VU tạo xong | activate VU và đưa vào pool nội bộ `activeVUPool` | VU mới nhận được mốc start tương lai |

Ví dụ timeline với `preAllocatedVUs: 1`, `maxVUs: 4`:

```text
t=0.00s  VU #1 rảnh      -> start iteration
t=0.25s  VU #1 vẫn bận   -> drop mốc này, k6 bắt đầu tạo VU #2 ở background
t=0.50s  VU #2 chưa xong -> drop tiếp, không chắc gửi thêm request tạo VU mới vì đang init
t=0.60s  VU #2 init xong -> vào pool
t=0.75s  có VU rảnh      -> mốc này mới có thể chạy
```

Điểm cần nhớ:

```text
maxVUs không phải là số VU có sẵn ngay từ đầu
maxVUs chỉ là trần cho phép tạo thêm
preAllocatedVUs mới là số VU sẵn trước khi đo
```

Vì vậy trong load test nghiêm túc:

```text
preAllocatedVUs nên được sizing đủ cao
maxVUs dùng làm trần an toàn
không dựa vào unplanned VUs để đạt target đều đẹp
```

### 3.5. Duration và gracefulStop

Với:

```js
duration: "6s",
gracefulStop: "5s",
```

hiểu là:

```text
0s -> 6s:
  k6 schedule mốc start mới theo rate/timeUnit

6s -> 11s:
  không schedule mốc start mới
  iteration đã start có thể finish trong gracefulStop

sau 11s:
  iteration còn chạy bị interrupt
```

Trần wall-clock của executor:

```text
executor_wall_time_after_start_max = duration + gracefulStop
```

### 3.6. HTTP requests, checks và iterations

Nếu code 1 iteration có:

```text
2 HTTP requests
2 checks
```

thì nếu mỗi completed iteration đi qua đủ code path đó:

```text
total_http_requests = completed_iterations * 2
total_checks = completed_iterations * 2
```

Ước lượng target request rate từ lịch iteration:

```text
target_http_req_rate_if_no_drop ~= lambda * http_requests_per_iteration
```

Cần nhớ:

```text
lambda điều khiển start iteration
không điều khiển trực tiếp từng HTTP request bên trong iteration
công thức trên chỉ đúng gần đúng nếu không drop/interrupt và mỗi iteration chạy đủ số request đó
```

### 3.7. iteration_duration và http_req_duration

Trước khi dùng công thức, phải tách rõ 3 đại lượng khác nhau:

| Đại lượng | Ví dụ | Đơn vị | Nghĩa |
| --- | --- | --- | --- |
| `target_start_rate` / `lambda` | `2 iterations/s` | iterations/s | k6 muốn start bao nhiêu iteration mỗi giây theo lịch |
| `iterations` rate trong summary | `13  1.729617/s` | completed iterations/s | trung bình mỗi giây có bao nhiêu iteration hoàn thành trên `summary_runtime_base` |
| `iteration_duration` | `avg=1.76s` | seconds/iteration | thời gian function chạy xong; thường là thời gian VU bận nếu không có `minIterationDuration` |

`iteration_duration avg=1.76s` **không phải** là `1.76 iterations/s`. Nó là:

```text
1 iteration mất trung bình 1.76 giây để chạy xong
```

Nếu muốn đổi riêng thời gian này thành năng suất của 1 VU, mới lấy nghịch đảo:

```text
per_vu_capacity ~= 1 / 1.76
                ~= 0.568 iteration/s cho 1 VU
```

Với khoảng 4 VU active:

```text
pool_capacity ~= 4 / 1.76
              ~= 2.27 iterations/s
```

Nên pool 4 VU đủ gần để giữ target `lambda = 2 iterations/s`.

Khi ước lượng số VU cần chuẩn bị cho `constant-arrival-rate`, hãy dùng thời gian của **cả
iteration**, tức thời gian VU bị bận. Trong các demo ở bài này, giá trị đó xấp xỉ:

```text
iteration_duration
```

Nếu có `minIterationDuration`, dùng `max(iteration_duration, minIterationDuration)` cho phần sizing,
vì VU vẫn chưa rảnh trong lúc k6 sleep bù min duration.

Không lấy riêng thời gian của từng HTTP request:

```text
http_req_duration
```

Lý do là VU chỉ rảnh để nhận mốc start tiếp theo sau khi toàn bộ function `default` hoặc `exec`
chạy xong. Một iteration có thể gồm:

```text
HTTP request 1
HTTP request 2
check()
custom JS logic
console.log()
sleep()
```

`http_req_duration` chỉ đo thời gian request HTTP. Nó không bao gồm toàn bộ phần còn lại của
iteration. Nếu dùng nó để tính VU, bạn sẽ thường tính thiếu.

Trong demo QuickPizza:

```text
http_req_duration avg ~= 260ms
iteration_duration avg ~= 1.76s
```

Nếu target là:

```text
lambda = 2 iterations/s
```

Tính sai bằng `http_req_duration`:

```text
required_vus_wrong ~= ceil(2 * 0.260)
                   = ceil(0.52)
                   = 1 VU
```

Tính đúng hơn bằng `iteration_duration`:

```text
required_vus_min ~= ceil(2 * 1.76)
                 = ceil(3.52)
                 = 4 VUs
```

Vì vậy câu gọn là:

```text
arrival-rate cần VU rảnh theo lịch start iteration,
nên phải sizing theo thời gian VU bị bận cho cả iteration.
```

### 3.8. Dropped vs interrupted

`dropped_iterations` nghĩa là:

```text
iteration chưa được start
mốc start bị bỏ vì không có VU rảnh
```

`interrupted iterations` nghĩa là:

```text
iteration đã được start
nhưng context bị cancel trước khi function chạy xong
```

Chúng không giống nhau. Một run có thể vừa có drop vừa có interrupt.

### 3.9. Checklist core đã lọc cho constant-arrival-rate

| Core detail | Ý nghĩa khi đọc output |
| --- | --- |
| `TimeUnit` default `1s` | Không set `timeUnit` thì `rate` là iterations/s. |
| `Validate()` yêu cầu `rate`, `duration`, `preAllocatedVUs` | Thiếu các field này sẽ lỗi config. |
| `maxVUs` default bằng `preAllocatedVUs` | Không set `maxVUs` thì không có room tạo thêm VU. |
| `GetExecutionRequirements()` khai báo `preAllocatedVUs` tại offset 0 của executor | Đây là planned VUs; full execution plan sẽ cộng thêm `startTime` nếu scenario có delay. |
| `MaxUnplannedVUs = maxVUs - preAllocatedVUs` | Đây là room tạo thêm VU lúc chạy. |
| `getTickerPeriod()` lấy nghịch đảo arrival rate | `rate/timeUnit` quyết định khoảng cách mốc start. |
| `vusPool.TryRunIteration()` quyết định có chạy được mốc start không | Non-blocking; không có VU rảnh thì trả `false` ngay. |
| `DroppedIterations` được push khi thiếu VU | Drop là mốc start không được chạy. |
| unplanned VU tạo ở background | Mốc hiện tại vẫn có thể drop trong lúc VU mới đang init. |
| `regDurationCtx.Done()` kết thúc schedule | Sau `duration`, không start mốc mới. |
| `maxDurationCtx` gồm `gracefulStop` | Iteration đang chạy có thêm thời gian để finish. |
| `startTime` không nằm trực tiếp trong `GetExecutionRequirements()` | `ScenarioConfigs.GetFullExecutionRequirements()` cộng `startTime` vào execution plan tổng. |
| `vus` metric | Scheduler emit mỗi giây từ currently active VUs. |
| `vus_max` metric | Scheduler emit mỗi giây từ initialized VUs, không nhất thiết bằng configured `maxVUs`. |
| `iterations` metric | JS runner emit khi full iteration kết thúc. |
| `iteration_duration` metric | JS runner emit thời gian từ start tới end của full iteration. |

### 3.9.1. Đọc `vus` và `vus_max` theo core

Trong summary, hai dòng này dễ đọc nhầm:

```text
vus............................: 2     min=2       max=4
vus_max........................: 6     min=6       max=6
```

Core scheduler emit 2 metric này mỗi giây:

```go
Value: float64(e.state.GetCurrentlyActiveVUsCount())
Value: float64(e.state.GetInitializedVUsCount())
```

Nên đọc là:

```text
vus = số VU đang active tại các thời điểm scheduler sample
vus_max = số VU đã được initialize tại các thời điểm scheduler sample
```

Vì đây là sample mỗi giây, `min/max` trong summary không phải high-watermark tuyệt đối theo từng
millisecond. Với run rất ngắn hoặc iteration overlap theo nhịp nhỏ hơn 1 giây, `vus max` có thể bỏ
lỡ một đỉnh active VU nằm giữa hai lần sample. Dùng nó để đọc xu hướng, không dùng một mình để chứng
minh peak concurrency chính xác tuyệt đối.

Không đọc là:

```text
vus = target users
vus_max là configured maxVUs
```

Trong QuickPizza demo:

```js
preAllocatedVUs: 6,
maxVUs: 8,
```

Header ghi:

```text
maxVUs: 6-8
```

nghĩa là:

```text
6 VU planned/preallocated
có thể tạo thêm tới trần 8 nếu thiếu worker
```

Nhưng summary có:

```text
vus_max min=6 max=6
```

nghĩa là run đó không cần tạo unplanned VU; số initialized VUs vẫn là 6.

`vus max=4` nghĩa là tại lúc scheduler sample, cao nhất có 4 VU đang active cùng lúc. Nó khớp với
ước lượng:

```text
required_vus_min ~= ceil(lambda * W_effective)
                 ~= ceil(2 * 1.76)
                 = 4
```

### 3.9.2. Đọc `iterations` và `iteration_duration` theo core

`iterations` và `iteration_duration` không phải do arrival-rate scheduler tự cộng khi tới mốc start.
Chúng được emit sau khi VU chạy xong full iteration trong JS runner:

```go
Metric: builtinMetrics.IterationDuration, Value: endTime.Sub(startTime)
Metric: builtinMetrics.Iterations, Value: 1
```

Nên:

```text
iterations = số full iterations đã kết thúc
iteration_duration = thời gian chạy của full iteration
```

Chi tiết core cần nhớ: nếu có `minIterationDuration`, `iterationSamples()` đã được emit trước khi
`RunOnce()` sleep bù min duration. Vì vậy `iteration_duration` đo thời gian function chạy xong, còn
VU chỉ thật sự rảnh sau phần sleep bù đó.

Nếu mốc start bị drop:

```text
không có VU chạy function
không có iteration_duration
không tăng iterations
chỉ tăng dropped_iterations
```

Nếu iteration đã start nhưng bị cancel do context hết hạn:

```text
AddInterruptedIterations tăng cho progress/UI
không tính là full iteration
```

`iterations` cũng không có nghĩa là nghiệp vụ pass. Nếu function chạy xong nhưng check fail hoặc HTTP
trả status xấu, iteration vẫn có thể được tính là full iteration; muốn đánh giá pass/fail nghiệp vụ
phải đọc `checks`, HTTP status, threshold hoặc custom metric riêng.

### 3.9.3. Execution segment và rate scaling

Trong local run bình thường, có thể đọc đơn giản:

```text
lambda = rate / timeUnit_seconds
```

Nhưng core có hỗ trợ execution segment cho distributed run:

```go
arrivalRate := getScaledArrivalRate(car.et.Segment, rate, timeUnit)
arrivalRatePerSec := getArrivalRatePerSec(arrivalRate)
```

Nghĩa là nếu test được chia thành execution segments, mỗi instance chỉ nhận phần rate của segment đó.
Trong bài này các demo đều là local single instance, nên cứ đọc theo công thức đơn giản.

Core vẫn dùng `GetStripedOffsets()` và `notScaledTickerPeriod` để chia các mốc start theo segment:

```go
start, offsets, _ := car.et.GetStripedOffsets()
t := notScaledTickerPeriod*time.Duration(gi) - time.Since(startTime)
```

Với người học bài này, chỉ cần nhớ:

```text
local run: rate/timeUnit là target start rate của cả process
distributed execution segment: rate bị chia theo segment
```

### 3.9.4. Bảng đối chiếu core truth

Bảng này là phần nên dùng khi review output hoặc khi giải thích cho học viên. Nó bám theo code core,
không bám theo cảm giác từ tên field.

| Thứ đang đọc | Core làm gì | Đọc đúng | Đọc sai cần tránh |
| --- | --- | --- | --- |
| `rate/timeUnit` | `Run()` tính arrival rate và ticker period | target start rate theo lịch | số VU hoặc số request chắc chắn hoàn thành mỗi giây |
| `preAllocatedVUs` | `GetExecutionRequirements()` khai báo `PlannedVUs` | worker đã chuẩn bị sẵn để nhận mốc start | user mục tiêu của bài test |
| `maxVUs` | `Run()` dùng làm trần `remainingUnplannedVUs` | giới hạn planned + unplanned VUs | số VU có sẵn ngay từ đầu |
| `TryRunIteration()` | gửi non-blocking vào pool VU rảnh | có VU rảnh thì start, không có thì fail ngay | chờ tới khi có VU rảnh rồi chạy bù |
| `dropped_iterations` | được push sau khi `TryRunIteration()` fail | mốc start chưa từng chạy function JS | iteration chạy lỗi HTTP |
| unplanned VU | xin thêm sau khi mốc hiện tại đã drop | chỉ có thể giúp các mốc sau | cứu lại mốc vừa bị drop |
| `iterations` | JS runner emit sau full iteration | số iteration function đã chạy tới cuối | số mốc scheduler đã tạo hoặc số business success |
| `iteration_duration` | JS runner emit `endTime - startTime` | thời gian function chạy xong; thường dùng làm `W_effective` khi không có `minIterationDuration` | iterations/s hoặc luôn bao gồm min duration |
| `minIterationDuration` | `RunOnce()` sleep bù sau khi emit `iteration_duration` | nếu set thì sizing bằng thời gian VU bị bận thực tế | nghĩ `iteration_duration` luôn đã bao gồm min duration |
| `vus` | scheduler sample `GetCurrentlyActiveVUsCount()` mỗi giây | số VU đang active tại thời điểm sample | target users |
| `vus_max` | scheduler sample `GetInitializedVUsCount()` mỗi giây | số VU đã initialize tại thời điểm sample | configured `maxVUs` |
| `startTime` | scheduler đợi trước khi gọi `Run()`; full plan cộng vào requirements | delay scenario trong toàn test | delay nằm trực tiếp trong `GetExecutionRequirements()` |
| `gracefulStop` | `getDurationContexts()` tạo `duration + gracefulStop` | cho iteration đã start có thời gian finish | thời gian tiếp tục start mốc mới |

### 3.9.5. Source map core đã đối chiếu

Các kết luận trong bài này bám vào các điểm core sau:

| File | Function/đoạn code | Ý nghĩa trong bài |
| --- | --- | --- |
| `lib/executor/constant_arrival_rate.go` | `ConstantArrivalRateConfig`, `NewConstantArrivalRateConfig()` | field riêng của executor, default `timeUnit = 1s` |
| `lib/executor/constant_arrival_rate.go` | `Validate()` | field bắt buộc, `maxVUs` default bằng `preAllocatedVUs` |
| `lib/executor/constant_arrival_rate.go` | `GetExecutionRequirements()` | planned/unplanned VUs theo offset của executor |
| `lib/executors.go` | `ScenarioConfigs.GetFullExecutionRequirements()` | cộng `startTime` vào execution plan tổng |
| `internal/execution/scheduler.go` | `runExecutor()` | scheduler đợi `startTime` trước khi gọi `Run()` |
| `lib/executor/constant_arrival_rate.go` | `Run()` | tính arrival rate, schedule mốc start, push `dropped_iterations`, xin unplanned VU |
| `lib/executor/ramping_arrival_rate.go` | `activeVUPool.TryRunIteration()` | non-blocking; thiếu VU rảnh thì fail ngay |
| `lib/executor/helpers.go` | `getDurationContexts()` | `duration` dừng mốc start mới, `duration + gracefulStop` là deadline cuối |
| `lib/executor/helpers.go` | `getIterationRunner()` | full vs interrupted iteration count |
| `internal/execution/scheduler.go` | `emitVUsAndVUsMax()` | `vus`/`vus_max` là sample mỗi giây từ active/initialized VUs |
| `internal/js/runner.go` | `RunOnce()` và `iterationSamples()` | emit `iterations`/`iteration_duration`, và caveat `minIterationDuration` |

### 3.10. Thêm nhầm field của executor khác có lỗi không?

Có. Với explicit scenario config, k6 parse strict JSON.

Ví dụ `constant-arrival-rate` không dùng:

```text
vus
iterations
maxDuration
stages
startVUs
gracefulRampDown
```

Nếu thêm nhầm thường gặp lỗi kiểu:

```text
json: unknown field "vus"
json: unknown field "iterations"
json: unknown field "stages"
```

Đừng trộn tư duy:

```text
constant-vus dùng vus + duration
per-vu-iterations dùng vus + iterations
shared-iterations dùng vus + iterations
ramping-vus dùng startVUs + stages
constant-arrival-rate dùng rate + timeUnit + duration + preAllocatedVUs/maxVUs
```

### 3.11. Hai trục độc lập: arrival timeline vs VU iter timeline

Phần này là phần quan trọng nhất khi giải thích arrival-rate. Người mới rất hay vẽ một timeline duy
nhất rồi gắn cả "mốc start theo lịch" và "VU đang chạy iteration" vào đó. Cách đó dẫn tới các bài
toán kiểu "VU số 1 chạy mốc 0.25s rồi 0.50s thì vô lý vì nó vẫn đang bận". Thực tế core có hai trục
hoạt động độc lập, và mọi câu chuyện drop / unplanned VU đều nằm ở chỗ hai trục này gặp nhau.

#### 3.11.1. Trục 1 — arrival timeline (chỉ phụ thuộc rate/timeUnit)

```text
arrival timeline tự nhịp theo notScaledTickerPeriod
nó không quan tâm VU rảnh hay không
mỗi nhịp = 1 mốc fire scheduled
```

Trong core (`lib/executor/constant_arrival_rate.go:316-330`):

```go
timer := time.NewTimer(time.Hour * 24)
notScaledTickerPeriod := getTickerPeriod(
    big.NewRat(
        car.config.Rate.Int64,
        int64(car.config.TimeUnit.TimeDuration()),
    )).TimeDuration()

for li, gi := 0, start; ; li, gi = li+1, gi+offsets[li%len(offsets)] {
    t := notScaledTickerPeriod*time.Duration(gi) - time.Since(startTime)
    timer.Reset(t)
    select {
    case <-timer.C:
        if vusPool.TryRunIteration() { continue }
        // ... drop logic
    case <-regDurationCtx.Done():
        return nil
    }
}
```

Đặc điểm trục arrival timeline:

```text
mốc 0: t = 0
mốc 1: t = 1 * tickerPeriod
mốc 2: t = 2 * tickerPeriod
...
mốc k: t = k * tickerPeriod
```

Đây là lịch tuyệt đối neo theo `startTime` của executor. Lịch không bị shift khi:

```text
VU pool kẹt
một mốc trước đó bị drop
unplanned VU đang được init ở background
```

Khi `regDurationCtx.Done()` đóng (tức `t >= duration`), trục arrival timeline kết thúc, không fire
thêm mốc mới.

#### 3.11.2. Trục 2 — VU iter timeline (mỗi VU một trục riêng)

Mỗi VU active có timeline iteration riêng:

```text
VU #1: idle -> [iter A: 0.4s] -> idle -> [iter B: 0.4s] -> ...
VU #2: idle -> [iter C: 0.4s] -> idle -> [iter D: 0.4s] -> ...
VU #N: ...
```

Một VU ở trạng thái `idle` thì sẵn sàng nhận tín hiệu từ `activeVUPool.iterations` channel
(`lib/executor/ramping_arrival_rate.go:545-561`):

```go
func (p *activeVUPool) AddVU(ctx context.Context, avu lib.ActiveVU,
    runfn func(context.Context, lib.ActiveVU) bool) {
    p.wg.Add(1)
    ch := make(chan struct{})
    go func() {
        defer p.wg.Done()
        close(ch)
        for range p.iterations {
            atomic.AddUint64(&p.running, uint64(1))
            p.execState.ModCurrentlyActiveVUsCount(+1)
            runfn(ctx, avu)
            p.execState.ModCurrentlyActiveVUsCount(-1)
            atomic.AddUint64(&p.running, ^uint64(0))
        }
    }()
    <-ch
}
```

Cơ chế nhận việc:

```text
worker goroutine của VU đang `range p.iterations`
=> nó block tại đó nếu chưa có việc
=> ngay khi có ai đó push struct{}{} vào channel, worker pick lên
=> chạy runfn (full iteration), trong suốt thời gian này worker không listen channel
=> chạy xong worker quay lại `range p.iterations` để chờ việc mới
```

Đặc điểm:

```text
khi VU đang chạy runfn, nó tuyệt đối không nhận thêm mốc fire
khi VU finish, nó vào idle ngay, không có concept "lập lịch sẵn"
nhiều VU cùng select trên cùng channel: ai rảnh trước thì nhận
```

#### 3.11.3. Hai trục gặp nhau: TryRunIteration

Khi arrival timeline fire một mốc, executor gọi
`vusPool.TryRunIteration()` (`lib/executor/ramping_arrival_rate.go:527-534`):

```go
func (p *activeVUPool) TryRunIteration() bool {
    select {
    case p.iterations <- struct{}{}:
        return true
    default:
        return false
    }
}
```

Đây là `select` non-blocking. Nó hoạt động chính xác như sau:

```text
Có VU idle  -> push struct{}{} vào channel thành công, return true
Mọi VU đều bận -> default branch chạy ngay, return false (không chờ)
```

Hệ quả: khi arrival fire, bài toán quy về

```text
có ít nhất 1 VU idle tại đúng thời điểm này không?
```

Nếu có: mốc được nhận. Nếu không: mốc bị drop.

#### 3.11.4. Sơ đồ minh họa

Ví dụ: `rate=4, timeUnit=1s, preAllocatedVUs=2, maxVUs=2`,
mỗi iteration mất `0.6s`.

Arrival timeline (trục 1):

```text
t = 0.00s   fire #0
t = 0.25s   fire #1
t = 0.50s   fire #2
t = 0.75s   fire #3
t = 1.00s   fire #4
t = 1.25s   fire #5
t = 1.50s   fire #6
t = 1.75s   fire #7
```

VU iter timeline (trục 2, hai VU độc lập):

```text
VU #1: [iter 0: 0.00 -> 0.60] [iter 2: 0.60 -> 1.20] [iter 4: 1.20 -> 1.80] [iter 6: 1.80 -> 2.40]
VU #2: [iter 1: 0.25 -> 0.85] [iter 3: 0.85 -> 1.45] [iter 5: 1.45 -> 2.05] [iter 7: 2.05 -> 2.65]
```

Hợp hai trục:

```text
fire #0 (t=0.00) -> VU#1 idle -> nhận, start iter 0
fire #1 (t=0.25) -> VU#1 bận, VU#2 idle -> VU#2 nhận, start iter 1
fire #2 (t=0.50) -> VU#1 bận, VU#2 bận -> DROP (không VU idle)
fire #3 (t=0.75) -> VU#1 bận tới 0.60, sau đó idle; nhưng tại đúng t=0.75 VU#1 bắt đầu iter mới
                    -> chính xác: tại 0.60 VU#1 idle, tại 0.75 lại fire -> chạy iter mới
                    -> tới t=0.75: VU#1 đã rảnh từ 0.60, vào nhận. VU#2 còn bận tới 0.85.
                    -> fire #3 được nhận bởi VU#1 (giả sử timing chuẩn)
```

Quan sát quan trọng:

```text
trục 1 không "biết" VU#2 đang bận
trục 1 fire đúng theo đồng hồ
TryRunIteration là điểm kiểm tra duy nhất
```

Nếu vẽ một timeline duy nhất, sẽ rất khó nhìn. Tách hai trục là cách dễ nhất để giải thích cho học
viên.

#### 3.11.5. Thuật ngữ tóm tắt

| Thuật ngữ | Trục nào | Sinh ra bởi |
| --- | --- | --- |
| `tickerPeriod` | trục 1 | `getTickerPeriod(arrivalRate)` trong `Run()` |
| `fire mốc start` | trục 1 | timer trigger trong vòng `for li, gi := ...` |
| `iteration_duration` | trục 2 | từng VU đo thời gian function chạy xong |
| `VU idle/busy` | trục 2 | trạng thái nội tại của worker goroutine |
| `TryRunIteration()` | giao điểm | điểm hai trục gặp nhau |
| `dropped_iterations` | giao điểm | mốc fire không kết nối được với VU idle |
| `unplanned VU spawn` | trục 2 | hệ quả khi giao điểm fail |

### 3.12. Spawn timing của unplanned VU theo core

Đây là phần đặc thù chỉ có ở open model. Closed model không bao giờ "tạo VU thêm trong runtime";
toàn bộ VU đều được scheduler init từ đầu. Open model thì có khái niệm `preAllocatedVUs` (init
trước) và `maxVUs - preAllocatedVUs` (room runtime). Phần này đọc trực tiếp từ
`lib/executor/constant_arrival_rate.go:288-313` và `lib/execution.go:500-520`.

#### 3.12.1. Hai pha của VU pool: init phase vs runtime phase

```text
init phase (trước khi executor.Run() được gọi):
  scheduler đọc GetExecutionRequirements()
  thấy PlannedVUs = preAllocatedVUs
  thấy MaxUnplannedVUs = maxVUs - preAllocatedVUs
  scheduler chuẩn bị preAllocatedVUs VU thật vào buffer chung
  cũng đặt counter es.uninitializedUnplannedVUs = MaxUnplannedVUs

runtime phase (trong executor.Run()):
  activate hết preAllocatedVUs (vào activeVUPool ngay)
  rồi vào loop fire mốc start
```

Đoạn code activate `preAllocatedVUs` (`constant_arrival_rate.go:307-313`):

```go
// Get the pre-allocated VUs in the local buffer
for range preAllocatedVUs {
    initVU, err := car.executionState.GetPlannedVU(car.logger, false)
    if err != nil {
        return err
    }
    activateVU(initVU)
}
```

Quan sát: tất cả `preAllocatedVUs` được activate **đồng loạt ngay đầu** `Run()`. Không có khái niệm
"ramp up" như `ramping-vus`. Ngay khi executor bắt đầu, có đủ `preAllocatedVUs` worker idle sẵn.

#### 3.12.2. Trigger spawn unplanned VU

`remainingUnplannedVUs` được khởi tạo (`constant_arrival_rate.go:288`):

```go
remainingUnplannedVUs := maxVUs - preAllocatedVUs
makeUnplannedVUCh := make(chan struct{})
defer close(makeUnplannedVUCh)
```

Trigger nằm trong nhánh fail của `TryRunIteration()`
(`constant_arrival_rate.go:332-362`):

```go
case <-timer.C:
    if vusPool.TryRunIteration() {
        continue
    }

    // Since there aren't any free VUs available, consider this iteration
    // dropped - we aren't going to try to recover it, but
    metrics.PushIfNotDone(parentCtx, out, metrics.Sample{
        TimeSeries: metrics.TimeSeries{
            Metric: droppedIterationMetric,
            Tags:   metricTags,
        },
        Time:  time.Now(),
        Value: 1,
    })

    // We'll try to start allocating another VU in the background,
    // non-blockingly, if we have remainingUnplannedVUs...
    if remainingUnplannedVUs == 0 {
        if !shownWarning {
            car.logger.Warningf("Insufficient VUs, reached %d active VUs and cannot initialize more", maxVUs)
            shownWarning = true
        }
        continue
    }

    select {
    case makeUnplannedVUCh <- struct{}{}: // great!
        remainingUnplannedVUs--
    default: // we're already allocating a new VU
    }
```

Đọc kỹ thứ tự:

```text
1. timer fire (mốc fire đến hạn)
2. gọi TryRunIteration()
   - nếu có VU idle: continue (không trigger spawn)
   - nếu không có VU idle: tiếp tục bước 3
3. push DroppedIterations = 1 (drop trước, vô điều kiện)
4. kiểm tra remainingUnplannedVUs:
   - nếu == 0: log warning (chỉ 1 lần) rồi continue
   - nếu > 0: tiếp tục bước 5
5. select non-blocking trên makeUnplannedVUCh:
   - nếu push được: remainingUnplannedVUs--
   - nếu default: đã có request spawn đang pending rồi, không gửi thêm
```

Hệ quả tinh tế ở bước 5: **chỉ 1 unplanned VU đang init tại một thời điểm**. Channel
`makeUnplannedVUCh` không có buffer, và goroutine consumer chỉ đọc từ channel khi nó vừa init xong
VU trước. Vì vậy nếu nhiều mốc liên tiếp đều fail và đều cố push request:

```text
mốc 1 fail -> push thành công -> remainingUnplannedVUs--, goroutine bắt đầu init VU
mốc 2 fail -> push fail (default) -> không decrement, không tạo thêm
mốc 3 fail -> push fail (default) -> ...
... cho tới khi VU init xong, goroutine quay lại đọc từ channel
mốc N fail -> push thành công lần nữa -> bắt đầu init VU thứ 2
```

Đây là cơ chế tự throttle: k6 không spawn ồ ạt N VU cùng lúc, mà spawn từ từ khi cần.

#### 3.12.3. Goroutine init unplanned VU

`constant_arrival_rate.go:289-304`:

```go
makeUnplannedVUCh := make(chan struct{})
defer close(makeUnplannedVUCh)
go func() {
    defer close(returnedVUs)
    for range makeUnplannedVUCh {
        car.logger.Debug("Starting initialization of an unplanned VU...")
        initVU, err := car.executionState.GetUnplannedVU(maxDurationCtx, car.logger)
        if err != nil {
            car.logger.WithError(err).Error("Error while allocating unplanned VU")
        } else {
            car.logger.Debug("The unplanned VU finished initializing successfully!")
            activateVU(initVU)
        }
    }
}()
```

Quy trình của goroutine này:

```text
ngồi range trên makeUnplannedVUCh
mỗi khi nhận được struct{}{}:
  1. gọi executionState.GetUnplannedVU()
     - nếu còn quota uninitializedUnplannedVUs: init VU thật (chạy code init.js)
     - nếu hết quota: lấy VU đã init từ buffer (rare path, debug log)
  2. activateVU(initVU):
     - Activate() VU vào maxDurationCtx
     - tăng atomic activeVUsCount
     - thêm vào vusPool qua AddVU()
   3. quay lại range để chờ request kế tiếp
```

`GetUnplannedVU` (`lib/execution.go:510-520`):

```go
func (es *ExecutionState) GetUnplannedVU(ctx context.Context, logger *logrus.Entry) (InitializedVU, error) {
    remVUs := atomic.AddInt64(es.uninitializedUnplannedVUs, -1)
    if remVUs < 0 {
        logger.Debug("Reusing a previously initialized unplanned VU")
        atomic.AddInt64(es.uninitializedUnplannedVUs, 1)
        return es.GetPlannedVU(logger, false)
    }

    logger.Debug("Initializing an unplanned VU, this may affect test results")
    return es.InitializeNewVU(ctx, logger)
}
```

Lưu ý dòng debug:

```text
"Initializing an unplanned VU, this may affect test results"
```

k6 chủ động cảnh báo: init VU runtime tốn thời gian (chạy lại init script), có thể ảnh hưởng kết
quả. Vì vậy best practice là sizing `preAllocatedVUs` đủ để tránh trigger spawn unplanned trong lúc
đo.

#### 3.12.4. Khoảng thời gian từ trigger tới sẵn sàng

Đây là phần không có công thức cứng, vì phụ thuộc:

```text
T_init = thời gian chạy phần init script (top-level JS, import, open() file, ...)
T_activate = thời gian activate VU vào pool (rất nhỏ, microseconds)
T_total ~= T_init + T_activate
```

Trong các test thực tế, `T_init` có thể từ vài chục `ms` (script trống) tới hàng giây (nếu init mở
file lớn, parse JSON, gọi shared object). Trong toàn bộ `T_total` này:

```text
arrival timeline vẫn fire đều
mọi mốc fire trong khoảng này vẫn drop nếu pool cũ vẫn bận
unplanned VU mới chưa join pool
```

Khi VU mới join pool, nó vào idle ngay và sẵn sàng nhận mốc fire kế tiếp. Không có concept "chạy bù
mốc đã drop".

Sơ đồ thời gian:

```text
t=0.00s   VU#1 idle, start iter A (kéo dài 0.6s)
t=0.25s   fire #1 -> VU#1 bận -> drop, request spawn VU#2 (giả định T_init=0.4s)
t=0.50s   fire #2 -> VU#1 vẫn bận, VU#2 đang init -> drop, push fail (default)
t=0.60s   VU#1 finish iter A -> idle
t=0.65s   VU#2 init xong -> activate, idle
t=0.75s   fire #3 -> VU#1 idle (hoặc VU#2 idle) -> nhận
t=1.00s   fire #4 -> ... pool có 2 VU sẵn sàng
```

Quan sát: drop tại 0.25, 0.50 không "tự được trả lại" sau khi VU#2 sẵn sàng. Mốc đã trôi qua.

#### 3.12.5. Đọc verify từ output

Trong `constant_arrival_rate_unplanned_vus_demo.js`, output điển hình:

```text
constant_arrival_unplanned_vus: 4.00 iterations/s for 4s (maxVUs: 1-4, gracefulStop: 2s)

dropped_iterations...: 2   0.434755/s
iteration_duration...: avg=600.32ms
iterations...........: 15  3.26066/s
vus..................: 3   min=2      max=3
vus_max..............: 3   min=2      max=3
```

Đọc theo trục:

```text
preAllocatedVUs = 1 -> trục 2 ban đầu chỉ có VU#1
maxVUs = 4 -> remainingUnplannedVUs = 3
trục 1 fire 4 mốc/giây * 4 giây = 16 mốc target

dropped_iterations=2 -> 2 mốc đầu (hoặc đầu/cuối) bị drop trong khi pool spawn
iterations=15 -> 15 mốc nhận được VU và chạy xong
vus_max=3 -> tổng init phase + 2 lần spawn unplanned đã xong (1 + 2 = 3)
```

vus_max max=3 nghĩa là k6 đã spawn 2 unplanned VU (lên tới 3 VU initialized), không hết hạn mức 4
vì pool đủ rồi. Nếu iteration nhanh và đều, k6 không cần thêm worker thứ 4.

#### 3.12.6. Tại sao không spawn ngay lúc bắt đầu test?

Câu hỏi tự nhiên: tại sao k6 không gọi `InitializeNewVU` cho cả `maxVUs` ngay từ init phase, để
tránh drop?

Lý do thiết kế:

```text
1. init phase chạy thật code init.js của user, tốn RAM/CPU
2. "max" là trần an toàn, không phải target
3. nhiều test set maxVUs >> preAllocatedVUs làm safety margin
4. nếu init hết max, lãng phí tài nguyên cho VU không bao giờ dùng
```

Vì vậy k6 chọn lazy init. Hệ quả: nếu set `preAllocatedVUs` quá thấp, k6 sẽ trigger spawn lúc đang
đo, ảnh hưởng kết quả.

### 3.13. Lifecycle của unplanned VU

Phần này trả lời chi tiết: một unplanned VU sống vòng đời như thế nào, từ lúc được trigger spawn cho
tới khi scenario kết thúc. Hiểu lifecycle giúp lý giải `vus`/`vus_max` ở cuối summary và giải thích
được vì sao có hành vi "VU vẫn còn idle khi gracefulStop".

#### 3.13.1. Năm pha của một unplanned VU

```text
[Pha 0] uninitialized:
  scheduler đặt counter es.uninitializedUnplannedVUs = MaxUnplannedVUs (= maxVUs - preAllocatedVUs)
  chưa có VU nào được tạo
  chỉ là quota numeric

[Pha 1] requested (chưa init):
  trong runtime, executor push request vào makeUnplannedVUCh
  goroutine consumer lấy quota: atomic decrement uninitializedUnplannedVUs
  bắt đầu chạy initVUFunc (init script)

[Pha 2] initialized (chưa active):
  initVUFunc xong, trả về InitializedVU
  được thêm vào es buffer
  ModInitializedVUsCount(+1) -> vus_max metric tăng

[Pha 3] active (idle hoặc busy):
  activateVU(initVU): gọi initVU.Activate()
  ModCurrentlyActiveVUsCount(+1) -> vus metric tăng (sample tiếp theo)
  thêm vào activeVUPool qua AddVU()
  worker goroutine bắt đầu range channel iterations
  trạng thái idle, sẵn sàng nhận mốc fire

[Pha 4] retired (cuối scenario):
  channel iterations đóng (vusPool.Close())
  worker goroutine thoát khỏi range loop
  returnVU được trigger qua deferred path
  ReturnVU(u, false) trả VU về buffer chung
  ModInitializedVUsCount(-1) ở scheduler khi cleanup
```

#### 3.13.2. Đối chiếu với code

Pha 1->2 ở `lib/execution.go:510-520`:

```go
func (es *ExecutionState) GetUnplannedVU(...) (InitializedVU, error) {
    remVUs := atomic.AddInt64(es.uninitializedUnplannedVUs, -1)
    if remVUs < 0 {
        atomic.AddInt64(es.uninitializedUnplannedVUs, 1)
        return es.GetPlannedVU(logger, false)
    }
    return es.InitializeNewVU(ctx, logger)
}

func (es *ExecutionState) InitializeNewVU(...) (InitializedVU, error) {
    newVU, err := es.initVUFunc(ctx, logger)
    if err != nil { return nil, err }
    es.ModInitializedVUsCount(+1)
    return newVU, err
}
```

Pha 2->3 ở `constant_arrival_rate.go:277-286`:

```go
activateVU := func(initVU lib.InitializedVU) lib.ActiveVU {
    activeVUsWg.Add(1)
    activeVU := initVU.Activate(getVUActivationParams(
        maxDurationCtx, car.config.BaseConfig, returnVU,
        car.nextIterationCounters,
    ))
    atomic.AddUint64(&activeVUsCount, 1)
    vusPool.AddVU(maxDurationCtx, activeVU, runIterationBasic)
    return activeVU
}
```

Pha 3->4 ở `constant_arrival_rate.go:267-274`:

```go
returnVU := func(u lib.InitializedVU) {
    car.executionState.ReturnVU(u, false)
    activeVUsWg.Done()
}
```

`returnVU` được gọi khi `initVU.Activate()`'s context bị cancel (trong defer cleanup của
maxDurationCtx). Tức là: khi `duration + gracefulStop` hết, `cancel()` được gọi, mọi VU đang active
nhận tín hiệu cancel, run xong (hoặc bị cancel iteration), rồi đóng goroutine và trả về.

#### 3.13.3. Khác biệt với planned VU

```text
planned VU:
  init ở init phase, trước khi executor.Run() được gọi
  scheduler đã đếm vào InitializedVUsCount từ trước
  Run() lấy từ buffer chung qua GetPlannedVU()
  activate đồng loạt ở đầu Run()

unplanned VU:
  init lazy, runtime, sau khi đã có drop xảy ra
  init xong mới đếm vào InitializedVUsCount
  được lấy qua GetUnplannedVU(), không qua GetPlannedVU()
  activate ngay sau khi init xong (1 VU/lần)
```

Một sự thật quan trọng: cả planned và unplanned VU đều dùng chung buffer cuối cùng. Khi scenario
xong, `ReturnVU()` đẩy VU về `es.vus` channel (buffer chung), không phân biệt nguồn gốc. Vì vậy nếu
có scenario kế tiếp (sequence) hoặc test có nhiều scenario, các VU này có thể được tái sử dụng.

#### 3.13.4. Idle vs busy trong activeVUPool

Worker goroutine của VU active rất đơn giản (`ramping_arrival_rate.go:545-561`):

```go
go func() {
    defer p.wg.Done()
    close(ch)
    for range p.iterations {
        atomic.AddUint64(&p.running, uint64(1))
        p.execState.ModCurrentlyActiveVUsCount(+1)
        runfn(ctx, avu)
        p.execState.ModCurrentlyActiveVUsCount(-1)
        atomic.AddUint64(&p.running, ^uint64(0))
    }
}()
```

Trạng thái VU:

```text
idle: đang ngồi block trong `range p.iterations`, chưa pick được job
busy: đã pick job, đang chạy runfn
```

Quan trọng: `ModCurrentlyActiveVUsCount(+1)` chỉ tăng khi VU **bắt đầu chạy** runfn. Nó **không**
tăng khi VU vào idle. Đó là lý do `vus` metric ở summary phản ánh số VU đang **busy**, không phải
số VU đã active. Số VU đã active (và idle) là `vus_max`.

Hệ quả khi đọc summary:

```text
vus min=2 max=4 nghĩa là:
  - tại sample khi ít nhất 2 VU đang busy
  - tại sample khi nhiều nhất 4 VU đang busy
  
vus_max min=6 max=6 nghĩa là:
  - đã init 6 VU, không spawn unplanned thêm
  - 6 VU này đang ở mix idle/busy tại các thời điểm sample
```

#### 3.13.5. Khi nào unplanned VU "biến mất"

Một câu hỏi nâng cao: unplanned VU có bị "destroy" giữa scenario không?

Trả lời: không. Một khi đã init, VU sống suốt scenario. Lý do:

```text
1. init script chỉ chạy 1 lần (top-level JS)
2. destroy/recreate VU rất tốn kém
3. closed/open model đều giữ VU sống tới khi maxDurationCtx kết thúc
```

Vì vậy `vus_max` là monotonic non-decreasing trong một scenario: chỉ tăng khi spawn unplanned, không
giảm. Cuối scenario nó về 0 do scheduler cleanup, không phải do mid-run shrink.

Trong `ramping-arrival-rate`, nhiều người tưởng "khi rate giảm, VU thừa sẽ bị release". Sai. Tương
tự `ramping-vus`, VU pool không tự co lại trong runtime. Chỉ khi scenario kết thúc thì cleanup mới
chạy.

#### 3.13.6. Bảng tóm tắt lifecycle

| Pha | Counter `Initialized` | Counter `Active` | Có thể nhận mốc fire? |
| --- | --- | --- | --- |
| 0 - uninitialized | chưa | chưa | không |
| 1 - requested | chưa | chưa | không (đang init) |
| 2 - initialized | +1 | chưa | không (chưa activate) |
| 3a - active idle | +1 | (sample khi busy thì +1, idle thì 0) | có |
| 3b - active busy | +1 | +1 | không (đang chạy iter) |
| 4 - retired | -1 (cleanup) | -1 (cleanup) | không |

### 3.14. Dropped iterations: công thức và khi nào emit

`dropped_iterations` là metric đặc thù của open model. Closed model không có metric này. Hiểu cơ
chế emit chính xác giúp đọc summary đúng và biết khi nào cần tăng `preAllocatedVUs`.

#### 3.14.1. Định nghĩa core

`dropped_iterations` được emit ở `lib/executor/constant_arrival_rate.go:339-346`:

```go
metrics.PushIfNotDone(parentCtx, out, metrics.Sample{
    TimeSeries: metrics.TimeSeries{
        Metric: droppedIterationMetric,
        Tags:   metricTags,
    },
    Time:  time.Now(),
    Value: 1,
})
```

Giá trị `1` mỗi lần emit. Tổng lại bằng số mốc fire bị bỏ. Time stamp là `time.Now()` tại thời điểm
drop, không phải thời điểm fire (chênh lệch nhỏ vì select case xảy ra ngay sau timer).

Điều kiện emit (`constant_arrival_rate.go:330-346`):

```text
1. timer.C fire (mốc fire đến hạn)
2. vusPool.TryRunIteration() trả về false
3. emit DroppedIterations = 1
```

Tức `dropped_iterations` chỉ emit khi:

```text
- arrival timeline đã fire một mốc cụ thể
- pool không có VU idle tại đúng thời điểm đó
- chưa qua regDurationCtx.Done() (sau duration thì không fire mốc mới)
```

#### 3.14.2. Khi nào KHÔNG emit dropped_iterations

Để tránh đọc nhầm, liệt kê các trường hợp **không** emit dropped_iterations dù trông như thiếu VU:

```text
1. iteration đã start nhưng bị cancel cuối scenario
   -> đó là interrupted_iterations, KHÔNG phải dropped
   -> hiển thị ở dòng "running ... X complete and Y interrupted iterations"

2. test bị Ctrl+C (parentCtx cancel)
   -> PushIfNotDone không push vì context đã done
   -> các mốc đáng ra fire mà bị skip do test stop -> không tính

3. mốc fire sau regDurationCtx.Done()
   -> select case `<-regDurationCtx.Done()` thắng
   -> Run() return luôn, không vào nhánh drop
   -> các mốc trong gracefulStop window không tồn tại

4. iteration chạy nhưng check fail / HTTP 500
   -> đó là check failure, không phải drop
   -> iteration vẫn được tính là complete iteration

5. preAllocatedVUs = maxVUs và tất cả VU bận
   -> emit dropped_iterations bình thường
   -> log warning "Insufficient VUs..." 1 lần duy nhất
```

#### 3.14.3. Công thức ước lượng dropped_iterations

Khi capacity của pool nhỏ hơn target rate:

```text
lambda = rate / timeUnit_seconds
W_effective = thời gian VU bận / iteration
M = số VU active tối đa = preAllocatedVUs (hoặc maxVUs nếu spawn được hết)

capacity = M / W_effective                  (iter/s)
drop_rate ~= max(0, lambda - capacity)      (drop/s)

expected_dropped ~= drop_rate * effective_window_seconds
                  ~= drop_rate * duration_seconds  (gần đúng nếu pool bão hòa toàn bộ duration)
```

Nếu pool bão hòa **không** suốt duration (ví dụ pool spawn unplanned dần):

```text
expected_dropped phụ thuộc cả timeline spawn
= sum over each interval (drop_rate_in_interval * interval_seconds)
```

Nên trong các test thực, công thức trên chỉ là cận trên. Cận dưới khi spawn xong nhanh là 0.

Ví dụ verify với demo `not_enough_vus`:

```text
rate=10, timeUnit=1s, duration=3s
preAllocatedVUs=2, maxVUs=2 (pool bão hòa, không spawn được unplanned)
W_effective ~= 1s

lambda = 10
capacity = 2 / 1 = 2
drop_rate = 10 - 2 = 8
expected_dropped = 8 * 3 = 24

actual: dropped_iterations = 24
```

Khớp. Lý do khớp đẹp: pool đầy ngay từ đầu (W_effective ~= 1s, fire mốc đầu xong là kẹt liên tục).

Ví dụ với spawn unplanned (demo `unplanned_vus`):

```text
rate=4, timeUnit=1s, duration=4s
preAllocatedVUs=1, maxVUs=4
W_effective ~= 0.6s

ban đầu pool chỉ có 1 VU:
  capacity = 1/0.6 ~= 1.67 iter/s
  drop_rate = 4 - 1.67 = 2.33 drop/s
  
sau khi spawn 1 unplanned (~T_init~= 0.4s):
  capacity = 2/0.6 ~= 3.33 iter/s
  drop_rate = 4 - 3.33 = 0.67 drop/s
  
sau khi spawn unplanned thứ 2:
  capacity = 3/0.6 = 5 iter/s
  drop_rate = 0
  
expected_dropped (rough): chỉ những mốc trong window spawn còn dở
~= 1-3 drops

actual: dropped_iterations = 2
```

Nằm trong dải hợp lý. Vì rate spawn phụ thuộc T_init và scheduling chính xác của Go runtime, không
có cách viết công thức chính xác cho case này; chỉ cần biết drop sẽ tập trung trong window spawn.

#### 3.14.4. Verify dropped_iterations từ summary

Cách đọc nhanh:

```text
nếu dropped_iterations = 0:
  pool đủ trong toàn bộ run, không cần action
  
nếu dropped_iterations > 0 nhưng nhỏ:
  có thể pool đã spawn unplanned, drop nằm ở window spawn
  cân nhắc tăng preAllocatedVUs để tránh trigger spawn

nếu dropped_iterations >> 0 và có warning "Insufficient VUs":
  pool đã đạt maxVUs vẫn không đủ
  bắt buộc phải tăng maxVUs (và preAllocatedVUs)
  hoặc giảm rate
```

Tỉ số drop/total cũng quan trọng:

```text
drop_ratio = dropped_iterations / (dropped_iterations + iterations + interrupted_iterations)
           = drop / total_scheduled

nếu drop_ratio > 0.1 (10%): nghi ngờ test không đáng tin
nếu drop_ratio > 0.5: bài test gần như không phản ánh đúng tải
```

Trong CI hoặc threshold setup, thường dùng:

```js
thresholds: {
  dropped_iterations: ["count<10"],         // tổng drop dưới 10
  // hoặc tỉ lệ:
  dropped_iterations: ["rate<0.01"],         // dùng kết hợp với metric counter rate
}
```

Lưu ý: `dropped_iterations` là Counter, threshold dùng `count`, `rate`. Không có `avg`/`p95` cho
metric Counter.

#### 3.14.5. Phân biệt với interrupted_iterations

Đây là điểm rất hay nhầm:

```text
dropped_iterations  = mốc fire không kết nối được với VU idle
                    = iteration CHƯA TỪNG start
                    = không có entry trong iteration_duration metric

interrupted_iterations = iteration đã start nhưng VU bị cancel context trước khi finish
                       = đã có entry runfn() được gọi nhưng abort
                       = không có entry trong iterations metric (vì runfn return false)
                       = chỉ hiện ở dòng "running (X), Y/Z VUs, A complete and B interrupted iterations"
```

Cùng một run có thể có cả hai:

```text
trong duration: pool kẹt -> dropped tăng
cuối duration -> sang gracefulStop: iteration đang chạy còn time
sau gracefulStop: iteration chưa xong bị cancel -> interrupted tăng
```

Demo `constant_arrival_rate_interrupt_demo.js` minh họa rõ tình huống này.

#### 3.14.6. Bảng cơ chế emit

| Trạng thái fire | Trạng thái pool | Action core | Metric/counter ảnh hưởng |
| --- | --- | --- | --- |
| Fire trong duration | Có VU idle | TryRunIteration thành công | iterations++ (sau khi finish) |
| Fire trong duration | Mọi VU bận, có quota unplanned | drop, push spawn request | dropped_iterations++, spawn lazy |
| Fire trong duration | Mọi VU bận, hết quota unplanned | drop, log warning lần 1 | dropped_iterations++, warning lần đầu |
| Fire trong duration | Mọi VU bận, đang chờ spawn | drop (default branch select) | dropped_iterations++, không trigger spawn thêm |
| Sau duration (gracefulStop) | bất kỳ | regDurationCtx done -> Run() return | không emit metric mới |
| Iteration đang chạy bị cancel | (cuối gracefulStop) | maxDurationCtx cancel | interrupted_iterations++ |

### 3.15. gracefulStop interaction với arrival timeline

`gracefulStop` ở open model có hành vi khác hẳn `gracefulStop` của closed model. Đây là phần dễ
nhầm khi user copy mental model từ `constant-vus`.

#### 3.15.1. Hai context khác nhau

`getDurationContexts()` (`lib/executor/helpers.go:141`) tạo hai context:

```text
regDurationCtx: hết hạn sau `duration`
maxDurationCtx: hết hạn sau `duration + gracefulStop`
```

Trong `Run()` của `constant-arrival-rate`:

```go
startTime, maxDurationCtx, regDurationCtx, cancel := getDurationContexts(parentCtx, duration, gracefulStop)
```

Hai context được dùng cho hai mục đích:

```text
regDurationCtx -> điều khiển arrival timeline (trục 1)
maxDurationCtx -> điều khiển VU iter timeline (trục 2)
```

Cụ thể trong loop chính:

```go
for li, gi := 0, start; ; li, gi = li+1, gi+offsets[li%len(offsets)] {
    t := notScaledTickerPeriod*time.Duration(gi) - time.Since(startTime)
    timer.Reset(t)
    select {
    case <-timer.C:
        // ... fire mốc, gọi TryRunIteration ...
    case <-regDurationCtx.Done():
        return nil           // <-- arrival timeline kết thúc
    }
}
```

Khi `regDurationCtx.Done()`:

```text
return nil ngay khỏi Run()
arrival timeline đóng
không fire mốc nào nữa
```

Nhưng iteration đang chạy thì sao? `runfn` của VU dùng `maxDurationCtx`, không phải
`regDurationCtx`. Vì vậy:

```text
sau khi Run() return:
  defer cancel() được gọi
  defer ở dòng 226-230:
    <-returnedVUs           # đợi goroutine spawn unplanned đóng
    vusPool.Close()         # đóng channel iterations
    cancel()                # cancel maxDurationCtx
    activeVUsWg.Wait()      # đợi VU return
```

Quan trọng: `vusPool.Close()` chỉ đóng channel `iterations`. Worker goroutine vẫn đang chạy `runfn`
sẽ chạy tiếp tới khi:

```text
- runfn finish bình thường (full iteration complete)
- HOẶC maxDurationCtx bị cancel (sau gracefulStop hết hạn)
```

#### 3.15.2. Sequence chi tiết tại boundary

Giả sử `duration=4s`, `gracefulStop=2s`, có 2 iteration đang chạy lúc t=4s:

```text
t=4.000s  regDurationCtx.Done() fire
          Run() return nil
          defer block bắt đầu chạy:
            <-returnedVUs    # spawn goroutine kết thúc
            vusPool.Close()  # close(iterations channel)
              -> worker đang range channel: thoát vòng lặp ngay sau khi runfn hiện tại xong
              -> worker đang chạy runfn: vẫn chạy tới khi runfn return hoặc ctx cancel
            cancel()         # cancel maxDurationCtx (sau khi <-waitOnProgressChannel xong)
              !! nhưng cancel() chỉ được gọi sau khi <-waitOnProgressChannel
              !! mà progress goroutine cũng đang dùng maxDurationCtx, sẽ thoát khi nó done
              !! thực chất maxDurationCtx tự done sau gracefulStop từ getDurationContexts

t=4.001s  worker VU#1 vẫn đang chạy iter A (giả sử bắt đầu t=3.5s, W=1s)
t=4.500s  iter A finish bình thường, VU#1 về range channel
          channel đã closed -> for range thoát -> goroutine của VU#1 return
t=4.500s  iter B (giả sử bắt đầu t=3.8s, W=1s) còn dở
t=4.800s  iter B finish bình thường (vẫn trong gracefulStop window)
t=6.000s  maxDurationCtx hết hạn (4s + 2s)
          nhưng tới đây mọi iter đã xong -> không có interrupt
```

Trường hợp iter còn dở quá gracefulStop:

```text
t=3.5s   iter C bắt đầu (W=3s, không nên xảy ra trong test bình thường)
t=4.0s   regDurationCtx done, Run() return
t=6.0s   maxDurationCtx hết hạn, cancel() được gọi
         iter C bị cancel context -> runfn return false
         -> count vào interrupted_iterations
t=6.0s   pool cleanup, scenario kết thúc
```

#### 3.15.3. gracefulStop = 0s

Nếu set `gracefulStop: "0s"`:

```text
maxDurationCtx hết hạn = duration + 0 = duration
regDurationCtx hết hạn = duration
=> hai context cùng done tại t=duration
```

Hệ quả:

```text
mọi iter đang chạy bị cancel ngay tại t=duration
mọi iter chưa kịp finish trở thành interrupted
```

Demo `constant_arrival_rate_interrupt_demo.js` minh họa case này: rate=1, duration=1s, function
sleep 5s, gracefulStop=0s. Iter đầu start tại t=0 và bị cancel tại t=1s.

#### 3.15.4. gracefulStop > duration (test setup không thường gặp)

Set `gracefulStop` rất lớn (ví dụ `gracefulStop: "10s"` cho `duration: "1s"`):

```text
arrival timeline đóng tại t=1s
mọi iter đã start được phép chạy tới t=11s
```

Với W_effective bình thường <1s, gracefulStop dư thừa không gây hại, chỉ làm runtime tổng dài hơn.
Nhưng nếu W_effective lớn (ví dụ test có HTTP timeout 30s), gracefulStop dài giúp các iter cuối kịp
finish, tránh interrupted.

Tradeoff:

```text
gracefulStop nhỏ:
  + run kết thúc nhanh
  - dễ có interrupted iter cuối

gracefulStop lớn:
  + iter cuối hoàn thành đầy đủ, summary chính xác hơn
  - run kéo dài
```

Best practice: `gracefulStop ~= 1.5 * iteration_duration_p95`. Đủ để 95% iter cuối kịp finish.

#### 3.15.5. So sánh với closed model gracefulStop

Bảng đối chiếu:

| Aspect | constant-vus (closed) | constant-arrival-rate (open) |
| --- | --- | --- |
| Trục bị cắt sau duration | VU loop next iter | arrival timeline fire |
| Iter đang chạy ở t=duration | finish trong gracefulStop hoặc bị interrupt | finish trong gracefulStop hoặc bị interrupt |
| Có iter mới start trong gracefulStop? | không (VU không loop nữa) | không (arrival timeline đã đóng) |
| Drop có xảy ra trong gracefulStop? | n/a (closed không có drop) | không, vì timeline đã đóng |

Điểm chung: cả hai model đều dừng "khởi động iter mới" tại t=duration, và đều cho gracefulStop để
iter đang chạy finish. Khác biệt chỉ ở "ai khởi động iter mới":

```text
closed: VU tự loop -> sau duration VU không loop nữa
open: arrival timeline -> sau duration timeline không fire nữa
```

#### 3.15.6. Đọc dòng "running" cuối summary

Dòng:

```text
running (4.2s), 0/4 VUs, 16 complete and 0 interrupted iterations
```

phản ánh trạng thái cuối:

```text
4.2s = wall clock thực tế (không nhất thiết = duration + gracefulStop)
0/4 VUs = 0 VU đang busy / 4 VU đã initialize
16 complete = 16 iter chạy xong full
0 interrupted = không iter nào bị cancel cuối scenario
```

Nếu `interrupted > 0`: gracefulStop không đủ. Tăng gracefulStop hoặc giảm độ phức tạp của iter.


## 4. Demo fixed start schedule đủ VU

File:

```text
examples/constant_arrival_rate_schedule_demo.js
```

Command:

```powershell
rtk k6 run .\examples\constant_arrival_rate_schedule_demo.js
```

Code chính:

```js
const RATE = 4;
const TIME_UNIT = "1s";
const DURATION = "4s";
const ITERATION_SECONDS = 0.4;

export const options = {
  scenarios: {
    constant_arrival_schedule: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: TIME_UNIT,
      duration: DURATION,
      preAllocatedVUs: 4,
      maxVUs: 4,
      gracefulStop: "2s",
    },
  },
};

export default function () {
  console.log(`[iter-start] t=${elapsedSeconds()}s __VU=${__VU}`);
  sleep(ITERATION_SECONDS);
  console.log(`[iter-end]   t=${elapsedSeconds()}s __VU=${__VU}`);
}
```

Tính trước:

```text
lambda = 4 / 1s = 4 iterations/s
ticker_period = 1 / 4 = 0.25s
W_effective ~= 0.4s
required_vus_min ~= ceil(4 * 0.4) = 2
preAllocatedVUs = 4 đủ rộng
```

Output mẫu:

```text
constant_arrival_schedule: 4.00 iterations/s for 4s (maxVUs: 4, gracefulStop: 2s)

iteration_duration...: avg=400.53ms min=400.15ms med=400.45ms max=402.02ms
iterations...........: 16  3.854836/s
vus..................: 1   min=1      max=1
vus_max..............: 4   min=4      max=4

running (4.2s), 0/4 VUs, 16 complete and 0 interrupted iterations
```

Log start có pattern:

```text
t=0.00s
t=0.25s
t=0.50s
t=0.75s
t=1.00s
```

Điểm cần nhớ:

```text
rate quyết định lịch start
iteration_duration quyết định cần bao nhiêu VU để không drop
```

## 5. Demo thiếu VU và dropped_iterations

File:

```text
examples/constant_arrival_rate_not_enough_vus_demo.js
```

Command:

```powershell
rtk k6 run .\examples\constant_arrival_rate_not_enough_vus_demo.js
```

Code chính:

```js
const RATE = 10;
const TIME_UNIT = "1s";
const DURATION = "3s";
const ITERATION_SECONDS = 1;

export const options = {
  scenarios: {
    constant_arrival_not_enough_vus: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: TIME_UNIT,
      duration: DURATION,
      preAllocatedVUs: 2,
      maxVUs: 2,
      gracefulStop: "2s",
    },
  },
};
```

Tính trước:

```text
lambda = 10 iterations/s
W_effective ~= 1s
capacity_with_2_vus ~= 2 / 1 = 2 iterations/s
drop_rate ~= 10 - 2 = 8 drops/s
```

Output mẫu:

```text
constant_arrival_not_enough_vus: 10.00 iterations/s for 3s (maxVUs: 2, gracefulStop: 2s)

dropped_iterations...: 24  7.270493/s
iteration_duration...: avg=1s min=1s med=1s max=1s
iterations...........: 6   1.817623/s
vus..................: 2   min=2      max=2
vus_max..............: 2   min=2      max=2

running (3.3s), 0/2 VUs, 6 complete and 0 interrupted iterations
```

Warning:

```text
Insufficient VUs, reached 2 active VUs and cannot initialize more
```

Đọc kết quả:

```text
completed_iterations = 6
dropped_iterations = 24
interrupted_iterations = 0

observed_scheduled_slots ~= 6 + 24 + 0 = 30
```

Demo này chứng minh:

```text
arrival-rate không tự chạy chậm lại để đợi VU
mốc nào thiếu VU thì drop mốc đó
```

## 6. Demo preAllocatedVUs vs maxVUs

File:

```text
examples/constant_arrival_rate_unplanned_vus_demo.js
```

Command:

```powershell
rtk k6 run .\examples\constant_arrival_rate_unplanned_vus_demo.js
```

Config chính:

```js
const RATE = 4;
const TIME_UNIT = "1s";
const DURATION = "4s";
const ITERATION_SECONDS = 0.6;

export const options = {
  scenarios: {
    constant_arrival_unplanned_vus: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: TIME_UNIT,
      duration: DURATION,
      preAllocatedVUs: 1,
      maxVUs: 4,
      gracefulStop: "2s",
    },
  },
};
```

Tính nhanh:

```text
lambda = 4 iterations/s
W_effective ~= 0.6s
required_vus_min ~= ceil(4 * 0.6) = 3
preAllocatedVUs = 1 thiếu
maxVUs = 4 cho phép tạo thêm
```

Output mẫu:

```text
constant_arrival_unplanned_vus: 4.00 iterations/s for 4s (maxVUs: 1-4, gracefulStop: 2s)

dropped_iterations...: 2   0.434755/s
iteration_duration...: avg=600.32ms min=600.07ms med=600.29ms max=600.83ms
iterations...........: 15  3.26066/s
vus..................: 3   min=2      max=3
vus_max..............: 3   min=2      max=3
```

Điểm quan trọng:

```text
maxVUs cho phép tăng trần
nhưng VU mới không xuất hiện miễn phí ở đúng mốc hiện tại
```

Trong run này vẫn có `dropped_iterations = 2` vì lúc cần VU, VU mới chưa kịp sẵn sàng.

Do đó cách sizing tốt hơn là:

```text
preAllocatedVUs >= ceil(lambda * W_effective * safety_factor)
```

không phải:

```text
preAllocatedVUs thấp, trông chờ maxVUs cứu
```

## 7. Demo interrupt cuối scenario

File:

```text
examples/constant_arrival_rate_interrupt_demo.js
```

Command:

```powershell
rtk k6 run .\examples\constant_arrival_rate_interrupt_demo.js
```

Config chính:

```js
export const options = {
  scenarios: {
    constant_arrival_interrupt: {
      executor: "constant-arrival-rate",
      rate: 1,
      timeUnit: "1s",
      duration: "1s",
      preAllocatedVUs: 1,
      maxVUs: 1,
      gracefulStop: "0s",
    },
  },
};

export default function () {
  sleep(5);
}
```

Output mẫu:

```text
constant_arrival_interrupt: 1.00 iterations/s for 1s (maxVUs: 1)

dropped_iterations...: 1   0.999049/s
vus..................: 1   min=1      max=1
vus_max..............: 1   min=1      max=1

running (1.0s), 0/1 VUs, 0 complete and 1 interrupted iterations
```

Cách đọc:

```text
iteration đầu đã start và đang sleep 5s
duration chỉ 1s
gracefulStop = 0s nên iteration đó bị interrupt
mốc start khác đến khi VU vẫn bận thì bị drop
```

Nên trong cùng một run có thể có cả:

```text
dropped_iterations
interrupted iterations
```

Chúng không giống nhau.

## 8. Demo QuickPizza `2 requests / iteration`

File:

```text
examples/constant_arrival_rate_quickpizza_two_requests_demo.js
```

Worked example chi tiết nằm ở:

```text
docs/20260517_03_constant-arrival-rate-quickpizza-two-requests-worked-example.md
```

Command:

```powershell
rtk k6 run .\examples\constant_arrival_rate_quickpizza_two_requests_demo.js
```

Code chính:

```js
export const options = {
  scenarios: {
    quickpizza_constant_arrival_rate: {
      executor: "constant-arrival-rate",
      rate: 2,
      timeUnit: "1s",
      duration: "6s",
      preAllocatedVUs: 6,
      maxVUs: 8,
      gracefulStop: "5s",
    },
  },
};

export default function () {
  const home = http.get("https://quickpizza.grafana.com/");
  const quotes = http.get("https://quickpizza.grafana.com/api/quotes");

  check(home, { "home status is 200": (res) => res.status === 200 });
  check(quotes, { "quotes status is 200": (res) => res.status === 200 });

  sleep(1);
}
```

Trong 1 iteration có:

```text
2 HTTP requests
2 checks
1 sleep(1)
```

Output mẫu:

```text
quickpizza_constant_arrival_rate: 2.00 iterations/s for 6s (maxVUs: 6-8, gracefulStop: 5s)

checks_total.......: 26      3.459233/s
checks_succeeded...: 100.00% 26 out of 26

http_req_duration..............: avg=260.53ms min=256.27ms med=258.23ms max=266.39ms
http_req_failed................: 0.00% 0 out of 26
http_reqs......................: 26    3.459233/s

iteration_duration.............: avg=1.76s min=1.51s med=1.52s max=2.09s
iterations.....................: 13    1.729617/s
vus............................: 2     min=2       max=4
vus_max........................: 6     min=6       max=6

running (07.5s), 0/6 VUs, 13 complete and 0 interrupted iterations
```

Từ output:

```text
completed_iterations = 13
total_http_requests = 26 = 13 * 2
total_checks = 26 = 13 * 2
dropped_iterations = 0 vì không có dòng dropped_iterations trong summary
interrupted_iterations = 0
```

Sizing VU:

```text
lambda = 2 iterations/s
W_effective ~= iteration_duration_avg ~= 1.76s vì demo không có minIterationDuration

required_vus_min ~= ceil(lambda * W_effective)
                 ~= ceil(2 * 1.76)
                 = ceil(3.52)
                 = 4 VUs
```

Summary cũng cho thấy:

```text
vus max=4
vus_max max=6
```

Nghĩa là run này thực tế cần khoảng 4 VU active để giữ lịch, và đã preallocate 6 VU nên không drop.

Có nên so sánh `iterations/s` trong summary là `1.729617/s` với target `2.00 iterations/s` không?

Không nên so sánh trực tiếp để kết luận đạt/không đạt target, vì đây là 2 loại rate khác nhau:

```text
target 2.00 iterations/s là start rate trong regular duration 6s
summary iterations/s là average completed iterations trên `summary_runtime_base`, tức kéo tới lúc
các iteration cuối finish
```

Muốn kiểm tra arrival-rate có giữ được lịch start không, ưu tiên nhìn:

```text
dropped_iterations
interrupted_iterations
log iterInScenario / số iteration đã start
VU pool có đủ không
```

Trong output mẫu này:

```text
completed_iterations = 13
dropped_iterations = 0
interrupted_iterations = 0
```

nên không kết luận “k6 hụt target start rate chỉ vì summary completed rate thấp hơn 2/s”. Đọc đúng hơn là:

```text
k6 start được các mốc theo lịch, không drop
summary completed rate thấp hơn vì `summary_runtime_base` kéo dài tới lúc iteration cuối finish
```

Runtime suy ra từ summary:

```text
summary_runtime_base ~= completed_iterations / iterations_rate
                      ~= 13 / 1.729617
                      ~= 7.52s
```

Run kéo dài hơn 6s vì các iteration đã start gần cuối vẫn cần chạy nốt trong `gracefulStop`.

## 9. So sánh với constant-vus ramping-vus per-vu shared

| Điểm so sánh | `constant-arrival-rate` | `constant-vus` | `ramping-vus` | `per-vu-iterations` | `shared-iterations` |
| --- | --- | --- | --- | --- | --- |
| Nhóm mô hình | Open model | Closed model | Closed model | Closed model | Closed model |
| Điều khiển chính | start rate | số VU cố định | số VU theo stages | số vòng mỗi VU | tổng vòng cả scenario |
| Có target iteration count không? | Không cứng, chỉ có lịch start | Không | Không | Có | Có |
| Có target start rate không? | Có | Không | Không | Không | Không |
| VU rảnh mới chạy tiếp? | Mốc start cần VU rảnh đúng lúc | Có | Có | Có | Có |
| Thiếu VU thì sao? | `dropped_iterations` | throughput giảm | throughput giảm | chậm hoặc timeout | chậm hoặc timeout |
| Field chính | `rate`, `timeUnit`, `duration`, `preAllocatedVUs` | `vus`, `duration` | `startVUs`, `stages` | `vus`, `iterations` | `vus`, `iterations` |

Nhớ nhanh:

```text
constant-arrival-rate = ép lịch start iteration
constant-vus = giữ số VU loop ổn định
ramping-vus = thay đổi số VU theo timeline
per-vu-iterations = mỗi VU chạy đúng N vòng
shared-iterations = cả scenario chạy tổng N vòng
```

## 10. Edge case và config không hợp lệ

Phần này tổng hợp các edge case và cách core xử lý từng tình huống. Mỗi case đều bám theo
`Validate()` hoặc `Run()` thật trong `lib/executor/constant_arrival_rate.go`.

### 10.1. timeUnit khác giây

`timeUnit` mặc định `1s` nhưng cho phép bất kỳ duration `> 0`:

```js
rate: 120,
timeUnit: "1m",     // 120 iter/phút = 2 iter/s
```

```js
rate: 100,
timeUnit: "500ms",  // 100 iter / 500ms = 200 iter/s
```

```js
rate: 1,
timeUnit: "10s",    // 1 iter/10s = 0.1 iter/s
```

Cách core đọc:

```go
timeUnit := carc.TimeUnit.TimeDuration()  // mặc định time.Second
arrivalRate := getScaledArrivalRate(et.Segment, rate, timeUnit)
tickerPeriod := getTickerPeriod(arrivalRate).TimeDuration()
```

`getScaledArrivalRate` (`lib/executor/helpers.go:196`) trả về `*big.Rat` với numerator = rate (đã
scale theo segment), denominator = timeUnit nanoseconds. `getTickerPeriod` lấy nghịch đảo, ra
duration giữa hai mốc fire.

Ví dụ tính toán:

| rate | timeUnit | lambda (iter/s) | tickerPeriod |
| --- | --- | --- | --- |
| 4 | 1s | 4 | 250ms |
| 60 | 1s | 60 | 16.67ms |
| 120 | 1m | 2 | 500ms |
| 1 | 10s | 0.1 | 10s |
| 600 | 1m | 10 | 100ms |
| 1 | 1h | 1/3600 | 1h |

Tại sao có `timeUnit`? Để diễn đạt rate tự nhiên cho từng use case:

```text
"5 đơn hàng/phút" -> rate=5, timeUnit="1m"
"1000 RPS" -> rate=1000, timeUnit="1s"
"1 health check / 30s" -> rate=1, timeUnit="30s"
```

Ba cách viết cho cùng một rate `2 iter/s`:

```js
{ rate: 2, timeUnit: "1s" }        // tự nhiên
{ rate: 120, timeUnit: "1m" }      // nếu phù hợp ngữ nghĩa "2/s = 120/m"
{ rate: 1, timeUnit: "500ms" }     // ngắn nhất
```

Validate:

```go
if carc.TimeUnit.TimeDuration() <= 0 {
    errors = append(errors, fmt.Errorf("the timeUnit must be more than 0"))
}
```

`timeUnit = 0` hoặc âm là lỗi config:

```text
GoError: the timeUnit must be more than 0
```

### 10.2. rate = 0 hoặc duration rất ngắn

#### 10.2.1. rate = 0

```js
rate: 0,
timeUnit: "1s",
```

`Validate()` chặn ngay (`constant_arrival_rate.go:95-96`):

```go
} else if carc.Rate.Int64 <= 0 {
    errors = append(errors, fmt.Errorf("the iteration rate must be more than 0"))
}
```

Lỗi:

```text
GoError: the iteration rate must be more than 0
```

Lý do thiết kế: `rate=0` nghĩa là không bao giờ fire, executor không có việc làm. Thay vì tạo
executor "no-op", k6 yêu cầu tác giả test xóa scenario hoặc dùng cách khác.

Nếu muốn scenario "tạm tắt" trong CI: dùng `executor: null` không được, nhưng có thể bỏ scenario
khỏi `options.scenarios` map, hoặc dùng env flag để skip:

```js
export const options = {
  scenarios: __ENV.SKIP_PEAK ? {} : {
    peak: { executor: "constant-arrival-rate", rate: 100, ... }
  }
};
```

#### 10.2.2. rate âm

```js
rate: -1,
```

Cùng error path: `must be more than 0`.

#### 10.2.3. duration rất ngắn

```js
rate: 100,
timeUnit: "1s",
duration: "100ms",
```

`Validate()` (`constant_arrival_rate.go:104-108`):

```go
} else if carc.Duration.TimeDuration() < minDuration {
    errors = append(errors, fmt.Errorf(
        "the duration must be at least %s, but is %s", minDuration, carc.Duration,
    ))
}
```

`minDuration` được định nghĩa trong `lib/executor/base_config.go` là `1s`. Vì vậy:

```text
duration < 1s -> lỗi "the duration must be at least 1s, but is 100ms"
```

Test với `duration < 1s` không hợp lý vì:

```text
- arrival timeline cần thời gian fire ổn định
- summary tính rate từ runtime, < 1s là noise
- gracefulStop cleanup tốn thời gian
```

#### 10.2.4. duration = 0

```js
duration: "0s",
```

Cùng path `< minDuration` -> lỗi.

#### 10.2.5. duration = 1s (cận biên)

```js
rate: 4,
timeUnit: "1s",
duration: "1s",
```

Hợp lệ. Trong window 1s này có khoảng 4 mốc fire:

```text
t=0.00s mốc #0
t=0.25s mốc #1
t=0.50s mốc #2
t=0.75s mốc #3
t=1.00s -> regDurationCtx done, không fire mốc #4
```

Số mốc fire thực tế phụ thuộc timing chính xác. Có thể có 4 hoặc 5 mốc tùy chính xác của timer.

#### 10.2.6. duration rất dài

```js
duration: "24h",
```

Hợp lệ. Test soak chạy 24 tiếng. Lưu ý:

```text
- gracefulStop nên đủ lớn để cleanup
- preAllocatedVUs sizing ổn định, không spawn unplanned giữa chừng
- monitor RAM/CPU dài hạn
```

### 10.3. preAllocatedVUs = 0

```js
preAllocatedVUs: 0,
maxVUs: 5,
```

Validate:

```go
if !carc.PreAllocatedVUs.Valid {
    errors = append(errors, fmt.Errorf("the number of preAllocatedVUs isn't specified"))
} else if carc.PreAllocatedVUs.Int64 < 0 {
    errors = append(errors, fmt.Errorf("the number of preAllocatedVUs can't be negative"))
}
```

Code chỉ chặn `< 0`, không chặn `= 0`. Vì vậy `preAllocatedVUs: 0` về mặt syntax là hợp lệ.

Tuy nhiên hành vi runtime:

```text
- vòng for activate trống (`for range preAllocatedVUs` với 0 -> no-op)
- pool ban đầu trống
- mốc fire đầu tiên DROP ngay vì pool trống
- request spawn unplanned VU (nếu maxVUs > 0)
- VU đầu tiên init xong mới có ai nhận
```

Sơ đồ minh họa với `preAllocatedVUs=0, maxVUs=2, rate=4, T_init=0.4s`:

```text
t=0.000s  fire #0 -> pool trống -> DROP, request spawn VU#1
t=0.250s  fire #1 -> pool trống, đang chờ VU#1 -> DROP (default branch)
t=0.400s  VU#1 init xong, vào pool idle
t=0.500s  fire #2 -> VU#1 idle -> nhận, start iter A
t=0.750s  fire #3 -> VU#1 bận -> DROP, request spawn VU#2
t=1.000s  fire #4 -> ...
```

Vì vậy: dù hợp syntax, `preAllocatedVUs: 0` là **anti-pattern**. Nên đặt ít nhất bằng
`ceil(lambda * W_effective)` để tránh drop ngay từ đầu.

Nếu config:

```js
preAllocatedVUs: 0,
maxVUs: 0,    // explicit
```

thì `HasWork()` trả về false:

```go
func (carc ConstantArrivalRateConfig) HasWork(et *lib.ExecutionTuple) bool {
    return carc.GetMaxVUs(et) > 0
}
```

Scheduler skip executor này ngay. Không có lỗi nhưng cũng không có gì chạy. Trong
`Validate()` không có check trực tiếp ngăn case này, nên dễ bị silent skip - cẩn thận khi review
config.

### 10.4. maxVUs < preAllocatedVUs

```js
preAllocatedVUs: 10,
maxVUs: 5,
```

Validate (`constant_arrival_rate.go:120-122`):

```go
if !carc.MaxVUs.Valid {
    carc.MaxVUs.Int64 = carc.PreAllocatedVUs.Int64
} else if carc.MaxVUs.Int64 < carc.PreAllocatedVUs.Int64 {
    errors = append(errors, fmt.Errorf("maxVUs can't be less than preAllocatedVUs"))
}
```

Lỗi:

```text
GoError: maxVUs can't be less than preAllocatedVUs
```

Logic check là đúng theo định nghĩa: `maxVUs` là trần, `preAllocatedVUs` là sàn. Sàn không thể cao
hơn trần.

Edge case: `maxVUs = preAllocatedVUs`. Hợp lệ, có nghĩa là không cho phép spawn unplanned. Pool
fixed bằng đúng `preAllocatedVUs`. Đây là setup an toàn cho test reproducibility.

### 10.5. maxVUs không khai báo

```js
preAllocatedVUs: 10,
// không có maxVUs
```

Validate (`constant_arrival_rate.go:117-119`):

```go
if !carc.MaxVUs.Valid {
    // TODO: don't change the config while validating
    carc.MaxVUs.Int64 = carc.PreAllocatedVUs.Int64
}
```

Mặc định `maxVUs = preAllocatedVUs`. Tức:

```text
remainingUnplannedVUs = 0
không spawn unplanned
pool fixed
```

Lưu ý comment `TODO: don't change the config while validating` - đây là technical debt nhỏ trong
core, nhưng hành vi user-facing là rõ ràng.

### 10.6. preAllocatedVUs rất lớn

```js
preAllocatedVUs: 10000,
maxVUs: 10000,
duration: "10s",
rate: 1,
```

Hợp lệ về syntax. Tuy nhiên:

```text
- init phase tạo 10000 VU thật -> tốn RAM (~MB/VU phụ thuộc init script)
- chỉ rate=1 nghĩa là 1 iter/s, dùng 10 iter/10s
- 9990 VU không bao giờ chạy iter
```

Setup này không lỗi nhưng lãng phí. k6 không tự cảnh báo khi pool size >> capacity cần.

Trong CI/CD, nên có guard:

```js
const safe_vus = Math.ceil(rate * iter_duration_p95 * 1.5);
if (safe_vus > preAllocatedVUs) {
    throw new Error(`preAllocatedVUs ${preAllocatedVUs} too small, need ${safe_vus}`);
}
```

(setup-time check, không phải runtime check trong k6).

### 10.7. rate rất lớn

```js
rate: 100000,
timeUnit: "1s",
duration: "10s",
```

Hợp lệ. Tickerperiod = 10us. Lưu ý:

```text
- timer.Reset cứ 10us -> Go runtime overhead lên đáng kể
- syscall vào kernel cho timer cũng tốn
- iter_duration thấp nhất cũng có overhead per-iter ~1ms
- thực tế rate > 10000 thường giới hạn bởi máy bắn tải
```

Cảnh báo riêng: `int64` overflow không xảy ra với rate hợp lý, nhưng nếu config kiểu:

```js
rate: 999999999999,
```

`getScaledArrivalRate` dùng `*big.Rat`, không overflow numeric, nhưng tickerPeriod sẽ là
nanoseconds rất nhỏ -> timer bị clamp tới minimum của Go (~1us). Lúc đó actual fire rate sẽ thấp
hơn target.

### 10.8. gracefulStop âm

```js
gracefulStop: "-1s",
```

`BaseConfig.Validate()` (gọi từ `Validate()` của arrival-rate qua `errors := carc.BaseConfig.Validate()`)
chặn:

```text
GoError: scenario gracefulStop must be > 0
```

(check thực tế nằm trong `lib/executor/base_config.go`).

### 10.9. exec function không tồn tại

```js
scenarios: {
  demo: {
    executor: "constant-arrival-rate",
    rate: 1,
    timeUnit: "1s",
    duration: "5s",
    preAllocatedVUs: 1,
    exec: "doesNotExist",   // function này không export
  }
}
```

Lỗi runtime:

```text
GoError: function 'doesNotExist' not found in exports
```

(check trong JS runner khi VU init).

### 10.10. Hai scenario khác `startTime` khác nhau dùng chung `__VU`

```js
scenarios: {
  early: { executor: "constant-arrival-rate", rate: 2, ... preAllocatedVUs: 5 },
  late:  { executor: "constant-arrival-rate", rate: 2, ..., startTime: "10s", preAllocatedVUs: 5 },
}
```

`__VU` numbering là global theo execution state. VU pool được share giữa scenarios qua
`es.vus` channel:

```text
__VU 1..5 được dùng cho early
sau khi early kết thúc, các VU này về buffer
late dùng lại từ buffer (có thể là VU 1, 2, ..., 5 hoặc 6..10)
```

Vì vậy không nên dùng `__VU` để identify "user X" giữa các scenario. Trong arrival-rate, một mốc
fire có thể được bất kỳ VU idle nào nhận, nên `__VU` cũng không identify "user thật" trong nội bộ
scenario - chỉ là index của worker.

### 10.11. Bảng tóm tắt edge case

| Case | Validate | Runtime | Khuyến nghị |
| --- | --- | --- | --- |
| `rate <= 0` | reject | n/a | luôn dùng rate >= 1 |
| `timeUnit <= 0` | reject | n/a | mặc định 1s là tốt |
| `duration < 1s` | reject | n/a | dùng duration >= 1s |
| `duration` rất dài | pass | OK | check soak setup |
| `preAllocatedVUs < 0` | reject | n/a | dùng số dương |
| `preAllocatedVUs = 0` | pass | drop ngay đầu | luôn pre-size đủ |
| `preAllocatedVUs = 0, maxVUs = 0` | pass | scenario skip (HasWork=false) | đừng làm |
| `maxVUs` không set | default = preAllocatedVUs | không spawn unplanned | OK nếu pre-size đủ |
| `maxVUs < preAllocatedVUs` | reject | n/a | thiết kế logic đúng |
| `maxVUs = preAllocatedVUs` | pass | pool fixed | OK cho test reproducibility |
| `gracefulStop < 0` | reject (BaseConfig) | n/a | dùng số dương hoặc 0 |
| `gracefulStop = 0` | pass | iter cuối có thể bị interrupt | dùng nếu chấp nhận interrupt |
| `exec` không tồn tại | pass parse | runtime error trong VU init | check function name khi viết test |

## 11. Cheat sheet — Công thức cần nhớ nhất

> Phần này dành cho người mới. Mỗi công thức có **tên tiếng Việt**, ví dụ
> đời thường, và "khi nào dùng". Đọc xong section này là dùng được ngay
> mà không cần đọc Section 3 chi tiết.

### 11.0. Config chung của `constant-arrival-rate`

Đây là **bộ config đầy đủ** cho executor `constant-arrival-rate`. Đọc bảng
này trước khi viết test, biết tham số nào BẮT BUỘC, tham số nào có default.

#### Template config đầy đủ

```js
export const options = {
  scenarios: {
    my_scenario: {
      // === BẮT BUỘC ===
      executor: "constant-arrival-rate",  // tên executor
      rate: 10,                           // số iter/timeUnit (cố định)
      duration: "30s",                    // thời gian schedule mốc start
      preAllocatedVUs: 5,                 // số VU sẵn từ đầu

      // === TUỲ CHỌN (có default) ===
      timeUnit: "1s",                     // default = "1s"
      maxVUs: 10,                         // default = preAllocatedVUs
      gracefulStop: "30s",                // default = "30s" (BaseConfig)
      startTime: "0s",                    // default = "0s"
      exec: "default",                    // default = "default" function
      tags: { test: "demo" },             // default = {}
      env: { DEBUG: "1" },                // default = {}
    },
  },
};

export default function () {
  // code chạy mỗi iter
}
```

#### Bảng tham số chi tiết

| Tham số | Required? | Default | Đơn vị | Ý nghĩa |
| --- | --- | --- | --- | --- |
| `executor` | **BẮT BUỘC** | — | string | Phải đặt là `"constant-arrival-rate"` |
| `rate` | **BẮT BUỘC** | — | int (>0) | Số iter mỗi `timeUnit` (cố định, không ramp) |
| `duration` | **BẮT BUỘC** | — | duration | Thời gian schedule mốc start (vd `"30s"`) |
| `preAllocatedVUs` | **BẮT BUỘC** | — | int (>=0) | Số VU sẵn sàng từ đầu test |
| `timeUnit` | tuỳ chọn | `"1s"` | duration | Đơn vị của `rate` (vd `"1s"`, `"1m"`) |
| `maxVUs` | tuỳ chọn | `= preAllocatedVUs` | int | Trần VU tối đa (cho phép spawn unplanned) |
| `gracefulStop` | tuỳ chọn | `"30s"` | duration | Grace cuối scenario cho iter đang chạy |
| `startTime` | tuỳ chọn | `"0s"` | duration | Trễ trước khi scenario bắt đầu |
| `exec` | tuỳ chọn | `"default"` | string | Tên function JS chạy mỗi iter |
| `tags` | tuỳ chọn | `{}` | object | Tag attach vào metric của scenario |
| `env` | tuỳ chọn | `{}` | object | Biến môi trường riêng cho scenario |

#### 5 quy tắc validate (đọc từ core)

```text
1. rate phải có và > 0
   (thiếu: lỗi "the iteration rate isn't specified")
   (<= 0: lỗi "the iteration rate must be more than 0")

2. timeUnit > 0
   (nếu <= 0: lỗi "the timeUnit must be more than 0")

3. duration phải có và >= minDuration
   (thiếu: lỗi "the duration is unspecified")
   (quá ngắn: lỗi "the duration must be at least <minDuration>")

4. preAllocatedVUs phải có và >= 0
   (thiếu: lỗi "the number of preAllocatedVUs isn't specified")
   (âm: lỗi "the number of preAllocatedVUs can't be negative")

5. maxVUs >= preAllocatedVUs
   (nhỏ hơn: lỗi "maxVUs can't be less than preAllocatedVUs")
   (không khai báo: tự động bằng preAllocatedVUs)
```

Code ref: `lib/executor/constant_arrival_rate.go:91-125` (function `Validate()`).

#### Config tối thiểu (chạy được)

Nếu chỉ muốn config gọn nhất:

```js
export const options = {
  scenarios: {
    minimal: {
      executor: "constant-arrival-rate",
      rate: 10,
      duration: "10s",
      preAllocatedVUs: 5,
    },
  },
};
```

5 dòng đủ chạy. `timeUnit` lấy default `"1s"`, `maxVUs` lấy default
`= preAllocatedVUs = 5`, `gracefulStop` lấy default `"30s"`.

**Khác với `ramping-arrival-rate`**: không có `stages`, không có `startRate`.
Rate ở đây CỐ ĐỊNH suốt `duration`, không thay đổi theo thời gian.

### 11.1. 5 công thức TOP cần thuộc lòng

#### Công thức 1: "Slot interval" (Khoảng cách 2 mốc start)

```text
slot_interval = timeUnit / rate
```

**Tiếng Việt**: "Cứ bao nhiêu giây thì k6 lại start 1 iter mới?"

**Vì sao quan trọng**: với `constant-arrival-rate`, rate **CỐ ĐỊNH**, nên
khoảng cách giữa 2 mốc start cũng cố định. Khác với ramping (slot_interval
biến đổi theo thời gian).

**Ví dụ đời thường**:

```text
Quán phở phục vụ đều: 12 khách/phút
=> cứ 5 giây gọi 1 khách vào (60s / 12 = 5s)
   Khoảng cách CỐ ĐỊNH suốt giờ mở cửa.
```

**Áp vào k6**:

```text
config: rate=4, timeUnit="1s"
=> slot_interval = 1s / 4 = 0.25s
=> mốc start: t=0, 0.25, 0.5, 0.75, 1.0, ... (cứ 0.25s 1 mốc)

config: rate=120, timeUnit="1m"
=> slot_interval = 60s / 120 = 0.5s
=> mốc start: t=0, 0.5, 1.0, 1.5, ... (cứ 0.5s 1 mốc)
```

**Khi nào dùng**: muốn biết tại 1 thời điểm cụ thể, k6 đang start mốc nào,
hoặc check xem 2 mốc cách nhau bao xa.

Code ref: `constant_arrival_rate.go:202` — `tickerPeriod = getTickerPeriod(arrivalRate)`.

#### Công thức 2: "Số slot dự kiến" (Đếm tổng mốc start)

```text
N_sched = rate × duration / timeUnit_in_seconds
```

**Tiếng Việt**: "Tổng mốc start dự kiến = rate × thời gian chạy
(quy về cùng đơn vị)"

**Ví dụ đời thường**:

```text
Quán phở: 12 khách/phút, mở 5 phút
=> tổng khách dự kiến = 12 × 5 = 60 lượt
   (KHÔNG cần nhân chia phức tạp vì rate cố định)
```

**Áp vào k6**:

```text
config: rate=4, timeUnit="1s", duration="10s"
=> N_sched = 4 × 10 / 1 = 40 mốc start

config: rate=120, timeUnit="1m", duration="2m"
=> N_sched = 120 × 2 = 240 mốc start

config: rate=10, timeUnit="1s", duration="30s"
=> N_sched = 10 × 30 = 300 mốc start
```

**Khi nào dùng**: ước lượng số iter scenario sẽ có, đối chiếu với metric
`iterations` + `dropped_iterations` sau test.

**Lưu ý**: với `constant-arrival-rate`, công thức này ĐƠN GIẢN hơn ramping
(không cần tính trung bình rate đầu/cuối stage).

#### Công thức 3: "Cần bao nhiêu nhân viên?" (Sizing VU bằng Little's Law)

```text
required_vus = ceil(rate × iter_time / timeUnit_in_seconds) × 1.2
```

**Tiếng Việt**: "Số VU cần = (rate quy về iter/giây) × (thời gian 1 iter)
× 1.2 (dự phòng 20%)"

**Ví dụ đời thường**:

```text
Ngân hàng: 12 khách vào/phút (đều), mỗi giao dịch mất 30 giây
=> trung bình lúc nào cũng có 12 × 30/60 = 6 khách đang giao dịch
=> cần ÍT NHẤT 6 quầy + dự phòng = 7-8 quầy
```

**Áp vào k6**:

```text
config: rate=10, timeUnit="1s"
code:   sleep(0.5) -> iter_time ≈ 0.5s

required_vus = ceil(10 × 0.5 / 1) × 1.2
             = ceil(5) × 1.2
             = 5 × 1.2
             = 6 VU

=> preAllocatedVUs = 6
```

**Một ví dụ khác** (rate đơn vị phút):

```text
config: rate=120, timeUnit="1m"
code:   iter_time ≈ 1s (1 HTTP request)

lambda = 120/60 = 2 iter/s
required_vus = ceil(2 × 1) × 1.2 = 3 VU
```

**Khi nào dùng**: trước khi chạy test, để biết đặt `preAllocatedVUs`
bao nhiêu cho đủ. Nếu thiếu, sẽ có `dropped_iterations` lúc rate đỉnh.

#### Công thức 4: "Pool M VU chịu rate cao nhất bao nhiêu?" (Capacity)

```text
capacity = M / iter_time
```

**Tiếng Việt**: "Năng lực pool M VU = số VU / thời gian 1 iter (đơn vị
iter/giây)"

**Ví dụ đời thường**:

```text
Quán có 5 nhân viên, mỗi đơn phục vụ 30 giây
=> mỗi giây xử lý được 5 / 30 = 0.167 đơn/giây
=> hay 10 đơn/phút
```

**Áp vào k6**:

```text
M = 6 VU, code sleep(0.5) -> iter_time = 0.5s
=> capacity = 6 / 0.5 = 12 iter/s
=> chịu được scenario có rate ≤ 12 iter/s

M = 4 VU, code sleep(1) -> iter_time = 1s
=> capacity = 4 / 1 = 4 iter/s
=> nếu config rate = 5/s -> sẽ DROP 1 iter/s (vượt capacity)
```

**Khi nào dùng**: đã có pool VU sẵn (vd test infrastructure cố định),
muốn biết có nên đẩy rate cao hơn không, hoặc rate cao bao nhiêu thì
bắt đầu drop.

**Liên hệ Công thức 3**: capacity là **chiều ngược lại** của Công thức 3.
Công thức 3 cho rate, suy ra VU. Công thức 4 cho VU, suy ra rate max.

#### Công thức 5: "Drop bao nhiêu nếu thiếu VU?" (Verify drop)

```text
drop_rate = max(0, rate − capacity)
         = max(0, rate − M / iter_time)
```

**Tiếng Việt**: "Số iter bị drop mỗi giây = rate config − năng lực pool
(nếu vượt; ngược lại = 0)"

**Ví dụ**:

```text
config: rate=15/s
pool:   M=6 VU, iter_time=0.5s -> capacity = 12/s

drop_rate = max(0, 15 − 12) = 3 iter/s

=> chạy 10s, dự kiến drop 3 × 10 = 30 iter
=> summary sẽ thấy dropped_iterations ≈ 30
```

**Verify ngược từ output**:

```text
N_done + N_drop + N_int ≈ N_sched (đẳng thức gần đúng)

vd: rate=10, duration=5s -> N_sched = 50
    summary: iterations=42, dropped_iterations=8, interrupted=0
    => 42 + 8 + 0 = 50 ✓ (khớp)
```

**Khi nào dùng**: sau test, để verify hệ thống có chịu được rate config
hay không. Drop > 5% N_sched là dấu hiệu sizing thiếu.

### 11.2. Bảng tra nhanh: gặp tình huống nào, dùng công thức nào

#### Tình huống 1: "Sắp viết config, không biết đặt số bao nhiêu"

Đây là tình huống đầu tiên ai cũng gặp: đã có script, muốn test chạy ở tốc
độ target, nhưng chưa biết đặt `preAllocatedVUs` bao nhiêu.

Demo dùng để phân tích: `examples/constant_arrival_rate_sizing_demo.js`

```js
import exec from "k6/execution";
import { sleep } from "k6";

const TARGET_RATE = __ENV.TARGET_RATE ? Number(__ENV.TARGET_RATE) : 10;
const ITER_TIME_SEC = 0.5;  // sleep cố định giả lập request HTTP

const W = ITER_TIME_SEC;
const R = TARGET_RATE;
const timeUnitSec = 1;  // timeUnit = "1s"
const requiredVUs = Math.ceil(R * W / timeUnitSec) * 1.2;
const preAllocatedVUs = Math.ceil(requiredVUs);

export const options = {
  scenarios: {
    sizing_demo: {
      executor: "constant-arrival-rate",
      rate: R,
      timeUnit: "1s",
      duration: "10s",
      preAllocatedVUs: preAllocatedVUs,
      maxVUs: preAllocatedVUs,
      gracefulStop: "5s",
    },
  },
};

export default function () {
  sleep(ITER_TIME_SEC); // giả lập request HTTP
}
```

Chạy:

```bash
k6 run examples/constant_arrival_rate_sizing_demo.js              # R = 10
k6 run -e TARGET_RATE=5  examples/constant_arrival_rate_sizing_demo.js
k6 run -e TARGET_RATE=20 examples/constant_arrival_rate_sizing_demo.js
```

Giờ phân tích output theo đúng 4 bước, lấy lần chạy TARGET_RATE=10 làm mẫu.

**── Bước 1: Chọn rate target (R) ──**

Lý thuyết: R là con số bạn TỰ CHỌN dựa trên mục tiêu test. Với
`constant-arrival-rate`, rate CỐ ĐỊNH suốt duration — không ramp, không thay
đổi. Đây chính là tốc độ k6 SCHEDULE mốc start, không phụ thuộc VU.

Ví dụ chọn R:
  "Production chạy 50 req/s" → R = 50, timeUnit = "1s"
  "Muốn 120 request mỗi phút" → R = 120, timeUnit = "1m"
  "CI smoke test cần 5 iter/s" → R = 5

Trong demo: `const TARGET_RATE = 10` → R = 10 iter/s.

```text
sizing_demo: 10.00 iterations/s for 10s
             ↑
         rate config = 10 iter/s, hiện ngay ở header scenario
```

**── Bước 2: Đo iter_time (W) ──**

Lý thuyết: chạy thử 1 VU, xem `iteration_duration avg` trong summary,
lấy đó làm W.

Trong demo: `const ITER_TIME_SEC = 0.5` → W = 0.5s. Đây là giả lập —
sleep(0.5) mô phỏng 1 request HTTP mất 0.5s. Ngoài đời thì bạn chạy
thử script với 1 VU rồi đọc số từ summary.

```text
iteration_duration...: avg=500.28ms     ← W thực tế ~0.5s, khớp code
```

**── Bước 3: Tính preAllocatedVUs (Công thức 3 — Little's Law) ──**

Lý thuyết: `required_vus = ceil(rate × iter_time / timeUnit_s) × 1.2`.
Nhân 1.2 là buffer 20% dự phòng. Làm tròn LÊN vì VU là số nguyên.
Thiếu VU → dropped_iterations > 0.

Trong demo:
  `requiredVUs = Math.ceil(R * W / timeUnitSec) * 1.2`
  = ceil(10 × 0.5 / 1) × 1.2 = ceil(5.0) × 1.2 = 5 × 1.2 = 6.0
  → `preAllocatedVUs = Math.ceil(6.0) = 6 VU`

```text
vus_max..............: 6   min=6      max=6
```
  vus_max = 6 → pool VU đúng Bước 3.

**── Bước 4: Đặt config hoàn chỉnh, chạy, đọc summary kiểm tra ──**

Lý thuyết: sau khi có preAllocatedVUs từ Bước 3, điền nốt duration,
gracefulStop. Rồi chạy và kiểm tra chéo bằng các công thức.

Trong demo:
  rate: R                  ← từ Bước 1
  timeUnit: "1s"           ← mặc định
  preAllocatedVUs: 6       ← từ Bước 3
  maxVUs: 6                ← = preAllocatedVUs (pool cố định)
  duration: "10s"          ← thời gian schedule mốc start
  gracefulStop: "5s"       ← để iter cuối không bị cắt

Tổng slot dự kiến (Công thức 2):
  N_sched ≈ rate × duration / timeUnit_s = 10 × 10 / 1 = 100 slot
  Summary: iterations = 101 → xấp xỉ 100 ✓

Capacity dự kiến (Công thức 4):
  capacity = preAllocatedVUs / W = 6 / 0.5 = 12 iter/s
  R(10) ≤ capacity(12) → không drop

Kiểm tra drop:
  dropped_iterations = 0 (không xuất hiện trong summary → = 0)
  → pool đủ VU, không slot nào bị drop ✓

Kiểm tra ngược (đảo Công thức 3):
  preAllocatedVUs ≈ ceil(rate × iteration_duration.avg) × 1.2
  = ceil(9.618 × 0.50028) × 1.2 ≈ ceil(4.81) × 1.2 = 5 × 1.2 = 6 ✓

Footer:
```text
running (10.5s), 0/6 VUs, 101 complete and 0 interrupted iterations
                          ↑               ↑
                    N_done = 101    N_int = 0 → sạch
```

  interrupted = 0 → gracefulStop đủ rộng, không iter nào bị cắt giữa chừng.

**So sánh với constant-vus:**
```text
Với constant-vus (Tình huống 1 bên kia):
  vus = ceil(R × W) = ceil(10 × 0.5) = 5 VU (không buffer)
  Cùng R=10, W=0.5s → cần 5 VU (constant-vus) vs 6 VU (constant-arrival-rate)

Với constant-arrival-rate:
  preAllocatedVUs = ceil(ceil(R × W) × 1.2) = 6 VU (có buffer 20%)
  Buffer 20% dự phòng cho iter_time dao động thực tế.
```

**── Thử target khác để thấy quy luật ──**

```bash
k6 run -e TARGET_RATE=20 examples/constant_arrival_rate_sizing_demo.js
```

Bước 1: R = 20.
Bước 3: preAllocatedVUs = ceil(ceil(20 × 0.5) × 1.2) = ceil(10 × 1.2) = 12 VU.

```text
  iterations...........: 201 19.14/s   ← gần 20 ✓
  vus_max..............: 12  min=12 max=12
```

→ Muốn rate gấp đôi → VU gấp đôi. Đúng lý thuyết: rate ∝ VU.

```bash
k6 run -e TARGET_RATE=5 examples/constant_arrival_rate_sizing_demo.js
```

Bước 3: preAllocatedVUs = ceil(ceil(5 × 0.5) × 1.2) = ceil(3 × 1.2) = 4 VU.

```text
  iterations...........: 51  4.86/s    ← gần 5 ✓
  vus_max..............: 4   min=4 max=4
```

Bảng tổng kết:

| R (target) | W | required_vus (trước ceil) | preAllocatedVUs | capacity | N_sched | N_done | rate thực | drop | Đạt? |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 5 | 0.5s | ceil(2.5)×1.2 = 3.6 | 4 | 8/s | 50 | 51 | ~4.86/s | 0 | ✓ |
| 10 | 0.5s | ceil(5.0)×1.2 = 6.0 | 6 | 12/s | 100 | 101 | ~9.62/s | 0 | ✓ |
| 20 | 0.5s | ceil(10.0)×1.2 = 12.0 | 12 | 24/s | 200 | 201 | ~19.14/s | 0 | ✓ |

Tất cả khớp vì demo dùng sleep cố định. Với HTTP thật, iter_time dao
động → rate thực tế lệch vài % → buffer 20% giúp an toàn.

#### Tình huống 2: "Đã có sẵn N VU, hỏi chịu được rate cao nhất là bao nhiêu?"

Ngược với Tình huống 1: đã biết số VU (vd do giới hạn tài khoản test,
server giới hạn connection, hoặc policy "chỉ được dùng 4 VU"), muốn ước
lượng rate tối đa pool này chịu được trước khi chạy.

Demo: `examples/constant_arrival_rate_reverse_sizing_demo.js`

```js
import exec from "k6/execution";
import { sleep } from "k6";

const AVAILABLE_VUS = __ENV.VUS ? Number(__ENV.VUS) : 6;   // N: số VU có sẵn
const ITER_TIME_SEC = 0.5;  // W: đo được từ chạy thử 1 VU
const TEST_RATE = __ENV.TEST_RATE ? Number(__ENV.TEST_RATE) : 8;  // R: rate muốn test

const N = AVAILABLE_VUS;
const W = ITER_TIME_SEC;
const R = TEST_RATE;
const capacity = N / W;           // CT4: năng lực pool
const dropRate = Math.max(0, R - capacity);  // CT5: drop dự kiến mỗi giây

export const options = {
  scenarios: {
    reverse_sizing: {
      executor: "constant-arrival-rate",
      rate: R,
      timeUnit: "1s",
      duration: "10s",
      preAllocatedVUs: N,
      maxVUs: N,
      gracefulStop: "5s",
    },
  },
};

export default function () {
  sleep(ITER_TIME_SEC); // giả lập request HTTP
}
```

Chạy với mặc định N=6 VU, R=8, W=0.5s:

```bash
k6 run examples/constant_arrival_rate_reverse_sizing_demo.js
```

**── Bước 1: Đo iter_time (W) ──**

```text
iteration_duration...: avg=500.28ms     ← W thực tế ~0.5s, khớp code
```

**── Bước 2: Tính capacity (Công thức 4) ──**

  capacity = N / W = 6 / 0.5 = 12 iter/s

```text
  N=6 VU, mỗi VU làm được 1/0.5 = 2 iter/s
  → pool 6 VU làm được 6 × 2 = 12 iter/s
```

**── Bước 3: So với rate config ──**

  R = 8, capacity = 12 → R ≤ capacity → không drop.

Kiểm tra trong summary:

```text
  iterations...........: 81  7.713371/s
  vus..................: 4   min=4      max=4
  vus_max..............: 6   min=6      max=6
```

  dropped_iterations: không xuất hiện (= 0) → không drop ✓

Verify Công thức 2:
  N_sched = R × duration = 8 × 10 = 80 slot
  N_done = 81 → xấp xỉ 80 ✓

Lưu ý: vus active trung bình = 4 (không phải 6). Điều này bình thường —
6 VU là pool max, nhưng với R=8 và W=0.5, chỉ cần ~4 VU busy đồng thời
để đạt rate 8/s. Pool 6 VU là dư cho trường hợp này.

**── Ví dụ B: N=4 VU, R=10 (biên, có drop) ──**

```bash
k6 run -e VUS=4 -e TEST_RATE=10 examples/constant_arrival_rate_reverse_sizing_demo.js
```

Bước 2: capacity = 4 / 0.5 = 8 iter/s
Bước 3: R(10) > capacity(8) → drop!

  drop_rate (CT5) = max(0, 10 − 8) = 2 iter/s
  → Drop dự kiến 10s: 2 × 10 = 20 iter

```text
  dropped_iterations...: 32  3.076392/s
  iterations...........: 68  6.537333/s
  vus..................: 4   min=3      max=4
```

Phân tích:
  N_done (68) + N_drop (32) = 100 → khớp N_sched = 10 × 10 = 100 ✓
  Drop thực tế (32) > dự kiến (20)

→ CT5 cho estimate THẤP HƠN thực tế trong trường hợp này. Lý do: với
constant-arrival-rate, slot được schedule cố định mỗi 0.1s. Khi VU vừa
xong 1 iter, có thể phải chờ slot tiếp theo (cách 0.1s), gây lãng phí
VU. CT5 là lower bound lý tưởng (giả định VU luôn có slot ngay khi rảnh),
thực tế luôn drop nhiều hơn.

Bài học: luôn dùng buffer ≥ 20% khi sizing. Với R=10, W=0.5:
  preAllocatedVUs nên ≥ ceil(10 × 0.5 × 1.2) = 6 VU
  Chỉ dùng 4 VU → drop 32% số slot.

**── Ví dụ C: N=3 VU, R=12 (drop nặng) ──**

```bash
k6 run -e VUS=3 -e TEST_RATE=12 examples/constant_arrival_rate_reverse_sizing_demo.js
```

Bước 2: capacity = 3 / 0.5 = 6 iter/s
Bước 3: R(12) >> capacity(6) → drop nặng

  drop_rate (CT5) = max(0, 12 − 6) = 6 iter/s
  → Drop dự kiến 10s: 6 × 10 = 60 iter

```text
  dropped_iterations...: 68  6.474671/s
  iterations...........: 53  5.046435/s
  vus..................: 2   min=2      max=3
```

  N_done (53) + N_drop (68) = 121 ≈ N_sched = 120 ✓

  Drop 68/120 = 57% slot bị drop — pool thiếu VU trầm trọng.

**── Điểm mấu chốt ──**

```text
Với constant-arrival-rate, N VU CỐ ĐỊNH xác định capacity TỐI ĐA.
Rate config vượt capacity → dropped_iterations (slot không có VU).

So sánh cùng 4 VU, W = 0.5s:
  capacity = 4 / 0.5 = 8 iter/s
  R = 8/s  → không drop
  R = 10/s → drop ~3/s (CT5: 2/s, thực tế cao hơn)
  R = 15/s → drop ~7/s (CT5: 7/s)

→ Đây là khác biệt CHÍNH với constant-vus:
  - constant-vus: rate = vus / iter_time (phụ thuộc latency)
  - constant-arrival-rate: rate CỐ ĐỊNH, VU không đủ → drop

→ constant-arrival-rate phù hợp cho test cần rate chính xác,
  nhưng đòi hỏi sizing VU đúng + buffer dự phòng.
```

Bảng tổng kết:

| N (VU) | R (target) | W | capacity (CT4) | drop_rate (CT5) | N_sched | N_done | N_drop | N_done+N_drop | Nhận xét |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 6 | 8 | 0.5s | 12/s | 0 | 80 | 81 | 0 | 81 | R ≤ capacity, sạch ✓ |
| 4 | 10 | 0.5s | 8/s | 2/s | 100 | 68 | 32 | 100 | Drop 32%, thiếu VU ✗ |
| 3 | 12 | 0.5s | 6/s | 6/s | 120 | 53 | 68 | 121 | Drop 57%, thiếu nặng ✗ |

#### Tình huống 3: "Đã chạy xong, đọc summary"

Sau khi run xong, summary là nơi duy nhất cần đọc để kết luận test
có chạy đúng kế hoạch không.

Dùng output từ demo `constant_arrival_rate_sizing_demo.js` (TARGET_RATE=10) làm mẫu:

```text
  █ TOTAL RESULTS

    EXECUTION
    iteration_duration...: avg=500.28ms min=500.01ms med=500.26ms max=500.77ms
                           p(90)=500.48ms p(95)=500.51ms
    iterations...........: 101 9.618334/s
    vus..................: 5   min=5      max=5
    vus_max..............: 6   min=6      max=6

    NETWORK
    data_received........: 0 B 0 B/s
    data_sent............: 0 B 0 B/s

  running (10.5s), 0/6 VUs, 101 complete and 0 interrupted iterations
```

**── 5 con số trong EXECUTION ──**

| Dòng summary | Ký hiệu | Nghĩa | Giá trị mẫu | Đọc thế nào |
|---|---|---|---|---|
| `iteration_duration avg` | W | Thời gian 1 iter trung bình | 500.28ms | So với W dự kiến (0.5s) → khớp |
| `iterations` | N_done | Số iter hoàn thành | 101 | So với CT2: 10×10=100 ✓ |
| `iterations X/s` | rate thực | Tốc độ trung bình toàn test | 9.62/s | So với R config (10/s): hơi thấp |
| `vus min / max` | VU active | Số VU đang bận | 5 / 5 | 5 VU bận cùng lúc |
| `vus_max min / max` | pool size | Tổng VU trong pool | 6 / 6 | khớp preAllocatedVUs=6 |

**So với constant-vus**:
```text
Với constant-arrival-rate, vus_max ≥ vus. vus_max = pool, vus = đang bận.
Ở trên: vus_max=6 (pool 6 VU), vus=5 (5 VU đang chạy iter).

Với constant-vus: vus_max = vus (bằng nhau), vì mỗi VU chạy iter liên tục
không nghỉ.
```

**── 3 câu hỏi kiểm tra (theo thứ tự) ──**

```text
1. Có drop không? — dropped_iterations = ?
   Nếu không thấy dòng dropped_iterations → = 0, pool đủ VU ✓
   Nếu có → N_drop / N_sched > 5% → đáng lo, cần tăng VU

2. Có interrupt cuối không? — đọc footer progress
   "0 interrupted iterations" → không iter nào bị cắt ✓
   N_int > 0 → gracefulStop chưa đủ, cần tăng

3. Rate thực có gần target không?
   actual_rate = N_done / T_run
   101 / 10.5 = 9.62/s, target 10/s → hụt 4%
   Hụt nhẹ là bình thường vì T_run > duration (có grace)
```

**── Footer progress ──**

```text
running (10.5s), 0/6 VUs, 101 complete and 0 interrupted iterations
           ↑       ↑        ↑              ↑
      T_run    VU active  N_done         N_int
```

  T_run = 10.5s → duration(10s) + grace(0.5s), iter cuối xong trong grace
  VU active cuối = 0 → tất cả VU đã xong
  N_done = 101 → khớp dự đoán
  N_int = 0 → không iter nào bị cắt giữa chừng

**── Ví dụ có drop: đọc summary từ TH2-B (N=4, R=10) ──**

```text
  █ TOTAL RESULTS

    EXECUTION
    dropped_iterations...: 32  3.076392/s       ← N_drop > 0!
    iteration_duration...: avg=500.27ms ...
    iterations...........: 68  6.537333/s       ← N_done = 68
    vus..................: 4   min=3      max=4
    vus_max..............: 4   min=4      max=4

  running (10.4s), 0/4 VUs, 68 complete and 0 interrupted iterations
```

```text
Câu hỏi kiểm tra:
  1) Có drop không? CÓ — dropped_iterations = 32
     N_drop / N_sched = 32/100 = 32% → RẤT ĐÁNG LO
     → preAllocatedVUs không đủ, cần tăng từ 4 lên 6

  2) Có interrupt không? N_int = 0 ✓

  3) Rate thực? 68/10.4 = 6.54/s, target 10/s → hụt 35%
     Nguyên nhân chính: drop 32 slot — không phải do code chậm

  4) Verify tổng: N_done + N_drop = 68 + 32 = 100 = N_sched ✓
```

**── 4 câu hỏi kiểm tra cho constant-arrival-rate ──**

```text
1. N_done + N_drop có gần N_sched không?
   N_sched = rate × duration / timeUnit_s
   → Nếu lệch > 5%: kiểm tra lại công thức

2. N_drop / N_sched > 5%?
   → preAllocatedVUs thiếu. Tăng theo CT3: ceil(R × W) × 1.2

3. N_int > 0?
   → Tăng gracefulStop hoặc giảm duration

4. actual_rate có gần rate config không?
   actual = N_done / T_run
   → Nếu drop = 0, int = 0 mà vẫn thấp → iter_time thực tế > W
```

### 11.3. Hành động khi gặp vấn đề

#### "Drop nhiều quá!"

Nguyên nhân: rate vượt năng lực pool VU. Cách xử lý theo độ ưu tiên:

```text
1. (DỄ NHẤT) Tăng preAllocatedVUs
   -> Pool có sẵn nhiều VU rảnh, không cần spawn
   -> Tốt nhất cho test ổn định

2. Tăng maxVUs (cho phép spawn unplanned)
   -> Cho k6 spawn thêm VU khi cần
   -> Có window vài chục ms ban đầu vẫn drop trong lúc spawn
   -> Xem Section 3.12-3.13 chi tiết

3. Giảm rate (đơn giản nhất nếu rate cao là không cần)
   -> Rate thấp hơn -> ít VU cần hơn

4. Tối ưu code (giảm iter_time)
   -> Bỏ sleep dư, tối ưu logic, gộp request
   -> iter_time nhỏ hơn -> mỗi VU làm được nhiều iter/s hơn
```

**Công thức quyết định**:

```text
Rate config = R
Capacity hiện tại = M / iter_time

Cần tăng VU lên:
  M_mới = ceil(R × iter_time × 1.2)

Hoặc giảm rate xuống:
  R_mới = M × 0.8 / iter_time  (chừa 20% buffer)
```

#### "Có interrupted iterations cuối test!"

Nguyên nhân: iter chưa kịp xong khi `gracefulStop` hết. Cách xử lý:

```text
1. Tăng gracefulStop
   -> Cho iter cuối thêm thời gian
   -> Vd: gracefulStop: "60s" thay vì default "30s"

2. Giảm rate
   -> Mốc start cuối ít hơn -> ít iter dở dang lúc duration hết

3. Tối ưu code (giảm iter_time)
   -> Iter ngắn hơn -> ít có khả năng vắt qua mốc cuối duration
```

**Đặc thù `constant-arrival-rate`**: vì rate cố định đến tận cuối duration,
slot start ngay sát `duration` rất dễ bị interrupt nếu code chậm. Khác với
`ramping-arrival-rate` có thể ramp về 0 ở stage cuối để giảm risk.

#### "Rate thực thấp hơn target nhiều!"

```text
1. Check N_drop trước
   -> N_drop / N_sched > 5% -> fix theo "Drop nhiều"

2. Check N_int sau
   -> N_int > 0 -> tăng gracefulStop

3. Check T_run vs duration
   -> T_run > duration (dùng grace) -> divisor lớn hơn
   -> rate thực tự nhiên thấp hơn rate config
   -> đây là chuyện bình thường, không phải bug

4. Check iter_time avg
   -> nếu iter_time cao bất thường -> code chậm, làm spawn không kịp
   -> tối ưu code hoặc giảm rate

Nếu drop=0, int=0, T_run≈duration mà rate vẫn thấp:
   -> có thể là caveat slot đầu lệch t=0 (không có iter ở t=0)
   -> hoặc precision của ticker (Section 3.1)
```

### 11.4. Bảng từ vựng: ký hiệu nào nghĩa là gì?

> Section 3 và section 11 dùng nhiều ký hiệu rút gọn cho gọn. Đây là bảng
> tra để bạn không phải lật lại đầu Section 3 mỗi lần.

| Ký hiệu | Đọc là | Nghĩa | Đơn vị |
| --- | --- | --- | --- |
| `lambda` (λ) | "lam-da" | Rate, nhịp start (ở `constant-arrival-rate` là CỐ ĐỊNH) | iter/giây |
| `rate` | "rết" | Số iter mỗi `timeUnit` config | iter/timeUnit |
| `timeUnit` | "tham đơn vị" | Đơn vị thời gian của rate | giây hoặc phút |
| `iter_time` (W) | "đắp-bờ-liu" | Thời gian 1 iter chiếm 1 VU | giây/iter |
| `slot_interval` | "slót in-tờ" | Khoảng cách 2 mốc start | giây |
| `T` | "ti" | Tổng `duration` config | giây |
| `T_run` | "ti rần" | Thời gian thực tế chạy (có thể > T do grace) | giây |
| `M` | "em" | Số VU thực tế trong pool (preAllocated) | VU |
| `M_max` | "em mác" | Trần VU (`maxVUs`) | VU |
| `C` | "xi" | Capacity (năng lực pool M VU) = M/W | iter/giây |
| `N_sched` | "ren skét" | Tổng slot dự kiến = rate × T / timeUnit_s | slot |
| `N_done` | "ren đần" | Tổng iter HOÀN THÀNH (metric `iterations`) | iter |
| `N_drop` | "ren đờ-rốp" | Slot bị drop (`dropped_iterations`) | slot |
| `N_int` | "ren in-tờ" | Iter bị interrupt (đọc footer progress) | iter |

**So với `ramping-arrival-rate`**: KHÔNG có `λ_peak` riêng (vì rate cố
định = peak), KHÔNG có `λ_avg` (vì avg = rate luôn). Chỉ cần nhớ 1 `rate`.

### 11.5. 3 công thức "1 dòng" để giải mọi case (nhớ vĩnh viễn)

```text
Cần BAO NHIÊU VU?         VU = ceil(rate × iter_time)
Slot mỗi BAO LÂU?         slot_interval = timeUnit / rate
Pool CHỊU rate cao bao nhiêu? rate_max = số_VU / iter_time
```

**Ví dụ áp dụng**:

```text
Case 1: muốn rate=20/s, iter_time=0.4s
   -> VU = ceil(20 × 0.4) = 8 (+ 20% buffer = 10)

Case 2: rate=10, timeUnit=1s
   -> slot_interval = 1 / 10 = 0.1s (cứ 100ms 1 mốc)

Case 3: có 12 VU, iter_time=0.6s
   -> rate_max = 12 / 0.6 = 20 iter/s
   -> nếu test cần > 20/s thì phải tăng VU
```

Học thuộc 3 dòng này là dùng được 80% nhu cầu thực tế.

### 11.6. Đọc output sau test: tìm số ở đâu?

Sau khi `k6 run` xong, bạn sẽ thấy 3 nhóm số liệu. Phải biết tìm từng
con số ở đâu để **áp vào đúng công thức** đã học ở 11.1.

**Bảng mapping nhanh: số ở đâu → dùng cho công thức nào**:

```text
| Số liệu                  | Đọc ở đâu                   | Dùng cho công thức |
| ------------------------ | --------------------------- | ------------------ |
| rate (config)            | Header "X.XX iterations/s"  | CT 2 (verify)      |
| duration                 | Header "for Xs"             | CT 3 (verify)      |
| preAllocatedVUs, maxVUs  | Header "maxVUs: A-B"        | CT 1 (verify)      |
| W (iter_time)            | Summary iteration_duration  | CT 1, 2 (sizing)   |
| N_done                   | Summary iterations count    | CT 5 (verify)      |
| N_drop                   | Summary dropped_iterations  | CT 5               |
| actual_rate              | Summary iterations rate     | CT 5 (so target)   |
| M_peak (vus max)         | Summary vus max             | CT 1 đảo (suy ngược)|
| T_run                    | Footer "running (X.Xs)"     | CT 5 (mẫu số)      |
| N_int                    | Footer "X interrupted"      | CT 5               |
```

#### Nhóm 1: Header (in ra ngay đầu test)

```text
scenarios: (100.00%) 1 scenario, 5 max VUs, 35s max duration (incl. graceful stop):
         * my_scenario: 10.00 iterations/s for 5s (maxVUs: 5)
```

Đọc các con số:

```text
"5 max VUs"                      <- vus_max init (preAllocatedVUs hoặc maxVUs)
"35s max duration"               <- duration + gracefulStop (5 + 30)
"10.00 iterations/s"             <- rate / timeUnit_s (CỐ ĐỊNH)
"for 5s"                         <- duration
"maxVUs: 5"                      <- preAllocatedVUs (=maxVUs trong case này)
```

Code ref: `constant_arrival_rate.go:70-88` (function `GetDescription()`).

**Khi nào đọc**: ngay đầu để verify config đã parse đúng. Đặc biệt check
con số `iterations/s` có khớp `rate / timeUnit_s` không.

#### Nhóm 2: Summary cuối test (block "TOTAL RESULTS")

```text
EXECUTION
iteration_duration...: avg=505ms min=500ms max=520ms p(95)=515ms
iterations...........: 42    8.4/s
dropped_iterations...: 8     1.6/s
vus..................: 5     min=5  max=5
vus_max..............: 5     min=5  max=5

NETWORK
http_req_duration....: avg=200ms ...
http_reqs............: 84    16.8/s
```

Đọc các con số:

```text
iteration_duration avg     <- iter_time hiệu dụng (W)
iterations (count)         <- N_done (iter hoàn thành)
iterations (rate)          <- actual_rate
dropped_iterations (count) <- N_drop (slot bị drop)
dropped_iterations (rate)  <- drop_rate (so với target)
vus (max)                  <- M_busy_peak (VU bận cao nhất)
vus_max                    <- preAllocated (instance đã init)
http_reqs (count)          <- nếu code có HTTP, ÷ N_done = req per iter
```

**Khi nào đọc**: sau khi test xong, để đánh giá kết quả.

#### Nhóm 3: Progress/footer (ngay trước summary)

```text
running (05.5s), 0/5 VUs, 42 complete and 0 interrupted iterations
```

Đọc các con số:

```text
"05.5s"                          <- T_run (thời gian thực tế chạy)
"0/5 VUs"                        <- VU đang bận / tổng VU init
"42 complete"                    <- N_done (khớp với summary)
"0 interrupted iterations"       <- N_int (KHÔNG có metric Counter riêng)
```

**Lưu ý**: `N_int` chỉ xuất hiện ở dòng progress cuối, KHÔNG có trong
block "TOTAL RESULTS" summary. Phải đọc dòng này riêng.

### 11.7. Quy trình 5 bước phân tích output

Sau khi có đủ số liệu từ 11.6, làm 5 bước theo thứ tự. Mỗi bước **dùng
đúng 1 công thức từ 11.1**.

**Bảng mapping nhanh: Bước → Công thức → Số liệu cần**:

```text
| Bước | Công thức dùng       | Input cần              | Output                |
|------|----------------------|------------------------|-----------------------|
| 1    | CT 2 (verify rate)   | Header + config        | Verify config OK      |
| 2    | CT 3 (N_sched)       | rate, duration         | N_sched dự kiến       |
| 3    | CT 5 (so N_done)     | N_done từ summary      | Tỷ lệ N_done/N_sched  |
| 4    | CT 5 (drop/int)      | N_drop, N_int          | Diagnose drop/int     |
| 5    | CT 1 đảo (suy ngược) | M_peak + W từ summary  | Capacity thực tế      |
```

#### Output mẫu để phân tích (dùng xuyên suốt 5 bước)

**Config đã chạy**:

```js
export const options = {
  scenarios: {
    demo_analyze: {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: "5s",
      preAllocatedVUs: 5,
      maxVUs: 5,
      gracefulStop: "30s",
    },
  },
};

import { sleep } from "k6";
export default function () { sleep(0.5); }
```

**Output đầy đủ k6 in ra**:

```text
scenarios: (100.00%) 1 scenario, 5 max VUs, 35s max duration (incl. graceful stop):
         * demo_analyze: 10.00 iterations/s for 5s (maxVUs: 5)

running (05.0s), 0/5 VUs, 42 complete and 0 interrupted iterations

  █ TOTAL RESULTS

    EXECUTION
    iteration_duration...: avg=505ms min=500ms max=520ms p(95)=515ms
    iterations...........: 42    8.4/s
    dropped_iterations...: 8     1.6/s
    vus..................: 5     min=5  max=5
    vus_max..............: 5     min=5  max=5

  EXECUTION
  scenarios: 1 scenarios completed
```

Áp 5 bước dưới đây vào đúng output này.

#### Bước 1: Verify config có chạy đúng không

```text
Câu hỏi: con số rate header có khớp với config?

Header in:    "10.00 iterations/s"
Config có:    rate=10, timeUnit=1s
              -> rate/timeUnit_s = 10 / 1 = 10 iter/s ✓

Header in:    "for 5s"
Config có:    duration = "5s" ✓

Header in:    "maxVUs: 5"
Config có:    preAllocatedVUs=5, maxVUs=5 ✓

Header in:    "5 max VUs"
              -> instance VU init (= maxVUs = 5) ✓

KẾT LUẬN: config parse đúng -> sang Bước 2
```

#### Bước 2: Tính N_sched (số slot dự kiến)

Áp Công thức 2:

```text
N_sched = rate × duration / timeUnit_s
        = 10 × 5 / 1
        = 50 slot

(với constant-arrival-rate, công thức RẤT đơn giản, không cần
 tính trung bình ramp như ở ramping-arrival-rate)
```

#### Bước 3: So với N_done (đã hoàn thành)

```text
Summary cho:  iterations = 42
Tính từ Bước 2: N_sched = 50

So sánh:
  N_done / N_sched = 42 / 50 = 84%
  -> hệ thống chỉ chịu được 84% rate target

Phân loại:
  >= 99%     : test "hoàn hảo"
  95-99%     : nhỏ giọt drop ở biên slot, OK
  80-95%     : có vấn đề, kiểm tra Bước 4   <- DEMO RƠI VÀO ĐÂY
  < 80%      : sizing sai nghiêm trọng
```

#### Bước 4: Tách rõ drop vs interrupt

```text
Summary cho:  dropped_iterations = 8
Footer cho:   "0 interrupted iterations" -> N_int = 0

Verify cộng số:
  N_done + N_drop + N_int = 42 + 8 + 0 = 50 = N_sched ✓
  (khớp tuyệt đối, không lệch)

Diagnose:
  N_drop = 8 (> 0)  -> sizing VU thiếu, không kịp xử rate=10
                       -> Bước 5 sẽ tính cụ thể thiếu bao nhiêu

  N_int = 0          -> code đủ kịp grace, không có vấn đề ở grace
```

#### Bước 5: Tính capacity thực tế từ output (suy ngược)

Đây là bước **suy ngược** từ output để biết hệ thống thật sự chịu
được rate cao nhất bao nhiêu, từ đó quyết định sizing đúng.

```text
Đo W từ summary:
  iteration_duration avg = 505ms = 0.505s
  (lớn hơn sleep(0.5) một chút vì overhead k6)

Đo M từ summary:
  vus max = 5    (số VU bận cao nhất trong test)

Tính capacity thực tế (Công thức 4):
  C_thực = M / W = 5 / 0.505 ≈ 9.9 iter/s

So với rate config:
  rate config = 10 iter/s
  capacity   ≈ 9.9 iter/s
  -> rate VƯỢT capacity 0.1 iter/s
  -> drop ~0.1 × 5s = 0.5 iter/giây CỘNG VỚI overhead spawn ban đầu
  -> tổng drop quan sát = 8 (lớn hơn lý thuyết do
     ticker drift, slot cuối kẹt grace, etc.)

Sizing ĐÚNG cho lần test sau:
  required_vus = ceil(rate × iter_time) × 1.2
              = ceil(10 × 0.505) × 1.2
              = ceil(5.05) × 1.2
              = 6 × 1.2
              ≈ 7 VU

Kết luận:
  - 5 VU không đủ cho rate=10 với iter_time=0.505s
  - Nên đặt preAllocatedVUs = 7 (theo công thức)
  - Hoặc giảm rate xuống 8/s (5 VU đủ cho rate ≤ 9.9/s)
  - Hoặc tối ưu code: bỏ sleep còn 0.4s
    -> capacity = 5/0.4 = 12.5 iter/s -> đủ chịu rate=10
```

**Mẹo**: bước 5 quan trọng nhất, vì nó trả lời câu hỏi "lần sau test
nên đặt số bao nhiêu". Đừng chỉ tăng `preAllocatedVUs` đại — luôn dùng
công thức `ceil(rate × iter_time) × 1.2` để có số chuẩn.

## 12. Cheat sheet (tóm gọn)

```text
lambda = rate / timeUnit_seconds
```

```text
ticker_period = 1 / lambda
```

```text
executor_wall_time_after_start_max = duration + gracefulStop
```

```text
required_vus_min ~= ceil(lambda * W_effective)
```

```text
capacity_with_M_vus ~= M / W_effective
```

```text
drop_rate ~= max(0, lambda - capacity_with_M_vus)
```

```text
observed_scheduled_slots ~= completed_iterations + interrupted_iterations + dropped_iterations
```

```text
target_http_req_rate_if_no_drop ~= lambda * http_requests_per_iteration
```

Trong đó:

```text
W_effective = thời gian VU bị bận cho full iteration; nếu không có minIterationDuration thì thường lấy từ iteration_duration
```

Không đọc nhầm:

```text
rate là tốc độ start iteration
preAllocatedVUs là worker chuẩn bị sẵn
maxVUs là trần worker tối đa
dropped_iterations là mốc start không được chạy
interrupted iterations là work đã start nhưng bị cancel
```
