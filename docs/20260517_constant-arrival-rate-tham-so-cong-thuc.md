# `constant-arrival-rate`: tham số, ý nghĩa và công thức

File này là bài song song với:

```text
docs/20260514_per-vu-iterations-tham-so-cong-thuc.md
docs/20260515_shared-iterations-tham-so-cong-thuc.md
docs/20260516_constant-vus-tham-so-cong-thuc.md
docs/20260517_ramping-vus-tham-so-cong-thuc.md
```

nhưng dành cho executor:

```text
constant-arrival-rate
```

Nguồn docs Grafana:
<https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/>

Nếu chỉ muốn tra nhanh, mở:

```text
docs/20260517_constant-arrival-rate-quick-index.md
```

Worked example QuickPizza:

```text
docs/20260517_constant_arrival_rate_quickpizza_two_requests_worked_example.md
```

## Mục lục nhanh

- [Ý tưởng chính](#1-ý-tưởng-chính)
- [Khi nào dùng thực tế](#11-khi-nào-dùng-thực-tế)
- [Nếu muốn tìm ngưỡng quá tải thì tăng gì?](#111-nếu-muốn-tìm-ngưỡng-quá-tải-thì-tăng-gì)
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
- [Demo fixed start schedule đủ VU](#4-demo-fixed-start-schedule-đủ-vu)
- [Demo thiếu VU và dropped_iterations](#5-demo-thiếu-vu-và-dropped_iterations)
- [Demo preAllocatedVUs vs maxVUs](#6-demo-preallocatedvus-vs-maxvus)
- [Demo interrupt cuối scenario](#7-demo-interrupt-cuối-scenario)
- [Demo QuickPizza 2 requests / iteration](#8-demo-quickpizza-2-requests--iteration)
- [So sánh với constant-vus ramping-vus per-vu shared](#9-so-sánh-với-constant-vus-ramping-vus-per-vu-shared)
- [Cheat sheet](#10-cheat-sheet)

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
cho thời điểm mà scheduler muốn bắt đầu một iteration mới.

Ví dụ `rate: 4`, `timeUnit: "1s"` thì k6 cố start ở các mốc gần như:

```text
t = 0.00s
t = 0.25s
t = 0.50s
t = 0.75s
t = 1.00s
```

Ở mỗi mốc này, k6 cần 1 VU rảnh. Nếu không có VU rảnh, mốc đó bị tính là `dropped_iterations`; k6 không chờ VU rảnh rồi chạy bù lại mốc cũ.

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

Dòng summary `X/s` là tốc độ **completed iterations trung bình trên runtime thực tế**.

`rate: 4` không có nghĩa là ở pha init core tự tính đủ tài nguyên để chắc chắn chạy được 4 iteration/s.
Nó chỉ là target để scheduler tạo lịch start:

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

Đây là công thức đọc output để giải thích run, không phải invariant tuyệt đối của mọi edge case. Nếu
test bị cancel đúng ở boundary, hoặc có `minIterationDuration` làm VU sleep bù sau khi
`iteration_duration` đã được emit, metric summary và progress counter có thể lệch nhau ở vài mốc
cuối. Với các demo trong bài này, không set `minIterationDuration`, nên công thức đủ tốt để cắt
nghĩa output.

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

Lý do: mốc đầu thường start gần `t=0`, mốc sát boundary cuối phụ thuộc timing, và summary rate tính trên runtime thực tế. Khi phân tích output, ưu tiên đọc từ metric.

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

Core k6 **không tự tính rồi tự set `preAllocatedVUs` cho bạn**. Bạn phải sizing bằng số liệu của script.

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

Nghĩa là nếu có `M` VU và mỗi VU bị chiếm `W_effective` giây để xong 1 iteration, thì cả pool làm được khoảng `M / W_effective` iteration mỗi giây.

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

Ví dụ thiếu VU:

```text
lambda = 10 iterations/s
W_effective = 1s
M = 2 VUs

capacity_with_2_vus ~= 2 / 1
                    = 2 iterations/s

drop_rate ~= max(0, 10 - 2)
          = 8 drops/s
```

Với `duration = 3s`:

```text
expected_dropped ~= drop_rate * duration
                 ~= 8 * 3
                 ~= 24 drops
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
| 5 | Unplanned VU tạo xong | activate VU và đưa vào pool | VU mới nhận được mốc start tương lai |

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

Ước lượng request rate từ lịch iteration:

```text
estimated_http_req_rate_if_no_drop ~= lambda * http_requests_per_iteration
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
| `iterations` rate trong summary | `13  1.729617/s` | completed iterations/s | trung bình mỗi giây có bao nhiêu iteration hoàn thành trên runtime thực tế |
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
docs/20260517_constant_arrival_rate_quickpizza_two_requests_worked_example.md
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
summary iterations/s là average completed iterations trên runtime thực tế tới lúc các iteration cuối finish
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
summary completed rate thấp hơn vì runtime thực tế kéo dài tới lúc iteration cuối finish
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

## 10. Cheat sheet

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
estimated_http_req_rate_if_no_drop ~= lambda * http_requests_per_iteration
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
