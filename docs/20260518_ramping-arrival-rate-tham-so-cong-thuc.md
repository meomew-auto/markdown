# `ramping-arrival-rate`: tham số, ý nghĩa và công thức

File này là bản chi tiết cho executor:

```text
ramping-arrival-rate
```

Nếu chỉ muốn tra nhanh, mở:

```text
docs/20260518_ramping-arrival-rate-quick-index.md
```

Worked example:

```text
docs/20260518_ramping_arrival_rate_worked_example.md
```

## Mục lục nhanh

- [Ý tưởng chính](#1-ý-tưởng-chính)
- [Khi nào dùng thực tế](#11-khi-nào-dùng-thực-tế)
- [Nếu muốn tìm ngưỡng quá tải thì tăng gì?](#111-nếu-muốn-tìm-ngưỡng-quá-tải-thì-tăng-gì)
- [Core chạy như nào](#12-core-chạy-như-nào)
- [Bảng tham số tiếng Việt](#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](#3-công-thức-nền)
- [Checklist core đã lọc](#39-checklist-core-đã-lọc-cho-ramping-arrival-rate)
- [Demo stage curve đủ VU](#310-demo-stage-curve-đủ-vu)
- [Demo thiếu VU và dropped_iterations](#311-demo-thiếu-vu-và-dropped_iterations)
- [Demo preAllocatedVUs vs maxVUs](#312-demo-preallocatedvus-vs-maxvus)
- [Demo QuickPizza 2 requests / iteration](#313-demo-quickpizza-2-requests--iteration)
- [So sánh với constant-arrival-rate](#4-so-sánh-với-constant-arrival-rate)
- [Cheat sheet](#5-cheat-sheet)

## 1. Ý tưởng chính

`ramping-arrival-rate` nghĩa là:

```text
k6 cố start iteration theo một rate thay đổi theo timeline
startRate = rate lúc bắt đầu
stages[].target = rate đích ở cuối mỗi stage
```

Ví dụ:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "ramping-arrival-rate",
      startRate: 2,
      timeUnit: "1s",
      stages: [
        { duration: "2s", target: 4 },
        { duration: "2s", target: 1 },
        { duration: "2s", target: 3 },
      ],
      preAllocatedVUs: 4,
      maxVUs: 6,
    },
  },
};
```

Hiểu là:

```text
0-2s: rate ramp từ 2/s lên 4/s
2-4s: rate ramp từ 4/s xuống 1/s
4-6s: rate ramp từ 1/s lên 3/s
```

Điểm cốt lõi:

```text
ramping-arrival-rate = open model
rate là target start iteration theo lịch
VU chỉ là worker để giữ lịch đó
```

`open model` nghĩa là k6 bám theo lịch start, không đợi iteration trước chạy xong rồi mới tự lặp tiếp.

Nếu mới đọc, nhớ 5 câu này trước:

```text
slot = 1 lần k6 muốn start đúng giờ
rate = nhịp start trong 1 giây
peak = chỗ nhịp cao nhất
VU = worker giữ iteration chạy
drop = đến giờ mà không có worker rảnh
```

Đọc bài theo thứ tự này sẽ dễ hơn:

```text
1. Ý tưởng chính
2. 5 câu nhớ nhanh
3. Ví dụ worked example
4. 3.2 và 3.3
5. 3.9 chỉ khi muốn đối chiếu code
```

`slot` ở đây là mốc start iteration theo lịch của scheduler. Mỗi slot cần 1 VU rảnh.
Không có VU rảnh đúng mốc thì slot đó bị drop. k6 không chờ slot cũ rồi chạy bù.

### 1.1. Khi nào dùng thực tế?

Hợp khi muốn:

```text
giữ traffic vào hệ thống tăng/giảm theo timeline
đo vùng bắt đầu quá tải
kiểm tra hệ thống khi traffic có ramp-up/ramp-down
```

Không hợp khi muốn:

```text
N user đồng thời cố định
mỗi user chạy đúng M vòng
tổng work chia đều cho VU
```

### 1.1.1. Nếu muốn tìm ngưỡng quá tải thì tăng gì?

Tăng:

```text
stage target rate
```

Hoặc tăng `startRate` + target các stage sau để đẩy peak cao hơn.

Khi đó cần nhìn:

```text
lambda_peak
W_effective
dropped_iterations
latency/error
```

### 1.2. Core chạy như nào?

Phần này là để đối chiếu code thật. Nếu mới học, chỉ cần nhớ 4 ý:

```text
scheduler chuẩn bị trước VU
cal() sinh lịch start
đến giờ thì TryRunIteration()
thiếu VU => slot đó mất
```

Tên hàm trong ngoặc chỉ để tra code, không cần nhớ thuộc lòng.

Core file:

```text
lib/executor/ramping_arrival_rate.go
```

`GetDescription()` của core mô tả theo:

```text
Up to X iterations/s for total_stage_duration over N stages (maxVUs: planned-max, gracefulStop: ...)
```

`GetExecutionRequirements()`:

```text
TimeOffset 0:
  PlannedVUs = preAllocatedVUs
  MaxUnplannedVUs = maxVUs - preAllocatedVUs

TimeOffset total_stage_duration + gracefulStop:
  PlannedVUs = 0
  MaxUnplannedVUs = 0
```

Luồng runtime:

```text
cal() sinh các mốc start theo diện tích dưới đường rate
đến mỗi mốc, Run() gọi TryRunIteration()
```

Nếu `TryRunIteration()` fail:

```text
dropped_iterations += 1
nếu còn quota unplanned -> tạo VU mới ở background
```

Điểm quan trọng:

```text
unplanned VU chỉ giúp các mốc sau
mốc hiện tại vẫn có thể đã bị drop
```

Scheduler metrics:

```text
vus = active VUs tại thời điểm sample
vus_max = initialized VUs tại thời điểm sample
```

`iterations` và `iteration_duration` vẫn được emit bởi JS runner sau full iteration.
Nếu có `minIterationDuration`, phần sleep bù không nằm trong `iteration_duration`
nhưng vẫn giữ VU bận.

## 2. Bảng tham số tiếng Việt

| Ký hiệu | Nghĩa | Đơn vị | Đọc từ đâu | Ghi chú |
| --- | --- | --- | --- | --- |
| `startRate` | rate lúc bắt đầu scenario | iterations/timeUnit | code/header | Nếu không set thì core dùng 0. |
| `timeUnit` | đơn vị của rate | duration | code/header | Default `1s`. Ví dụ `rate: 4, timeUnit: 1s` = 4 lần start mỗi giây. |
| `stages` | các stage đổi rate | list stage | code/header | Bắt buộc, mỗi stage có `duration` + `target`. |
| `stage.duration` | thời lượng stage | duration | code/header | Ví dụ `2s` nghĩa là stage đó kéo dài 2 giây. Tổng các stage = `total_regular_duration`. |
| `stage.target` | nhịp đích ở cuối stage | iterations/timeUnit | code/header | Đây là nhịp start, không phải VU. |
| `preAllocatedVUs` | VU chuẩn bị sẵn | VUs | code/header | Số worker có sẵn từ đầu để đỡ phải tạo gấp. |
| `maxVUs` | trần VU tối đa | VUs | code/header | Giới hạn cao nhất của worker; nếu bỏ qua thì bằng `preAllocatedVUs`. |
| `total_regular_duration` | tổng thời gian của các stage | duration | tự tính | `sum(stage.duration)`, chưa tính `gracefulStop`. |
| `lambda_start` | nhịp start lúc mở màn | iterations/s | tự tính | `startRate / timeUnit`. |
| `lambda_peak` | nhịp cao nhất trong cả timeline | iterations/s | tự tính | max của `startRate` và mọi `stage.target`. |
| `W_effective` | thời gian 1 VU bị bận cho 1 iteration | seconds/iteration | summary + core caveat | Dùng để ước lượng số VU cần. |

### 2.1. Biến phụ trong công thức

| Biến / biểu thức | Nghĩa | Ghi chú |
| --- | --- | --- |
| `lambda_prev` | rate ở đầu stage đang xét | Stage 1 thì = `lambda_start`; các stage sau thì = rate đích stage trước. |
| `lambda_next` | rate ở cuối stage đang xét | Bằng `stage.target / timeUnit_seconds`. |
| `lambda_current` | rate đang xét tại một thời điểm cụ thể | Dùng trong `drop_rate ~= max(0, lambda_current - capacity_with_M_vus)`. |
| `d_i` | duration của stage thứ i | Đơn vị seconds. |
| `scheduled_iterations_i` | số mốc start được schedule trong stage i | Với ramp tuyến tính: `d_i * (lambda_prev + lambda_next) / 2`. |
| `scheduled_iterations_total` | tổng số mốc start theo lịch cho toàn timeline | `sum(scheduled_iterations_i)`. |
| `average_target_rate` | nhịp start trung bình của cả timeline | `scheduled_iterations_total / total_regular_duration`. |
| `actual_summary_iterations_rate` | tốc độ completed iteration thật sự của summary | `completed_iterations / actual_scenario_runtime`. |
| `drop_rate` | số slot bị drop ước lượng theo giây | Chỉ là ước lượng, không phải metric core. |
| `W_effective_p95` | p95 của effective busy time | dùng khi sizing theo tail. |
| `safety_factor` | hệ số an toàn | margin > 1 để bù jitter/dao động. |

## 3. Công thức nền

### 3.1. Rate theo stage

```text
lambda_start = startRate / timeUnit_seconds
lambda_i_end = stage.target / timeUnit_seconds
```

`cal()` của core tạo mốc start bằng cách tích lũy diện tích dưới đường rate.
Với stage ramp tuyến tính từ `lambda_prev` sang `lambda_next` trong `d_i`:

```text
scheduled_iterations_i = d_i * (lambda_prev + lambda_next) / 2
```

Đọc chậm từng biến:

- `lambda_start`: nhịp start lúc scenario vừa mở màn.
- `lambda_i_end`: nhịp start ở cuối stage i.
- `d_i`: stage đó kéo dài bao lâu.
- `lambda_prev`: nhịp ở đầu stage đang xét.
- `lambda_next`: nhịp ở cuối stage đang xét.
- `scheduled_iterations_i`: tổng số lần k6 phải bắt đầu trong stage đó.

Trong mấy công thức dưới, cứ đọc `lambda` là "nhịp start".
Nó chỉ là cách viết gọn của tốc độ k6 phải bấm start trong 1 giây.

Tưởng tượng k6 như người bấm nút start theo lịch:

```text
stage dài 2 giây
đầu stage bấm ít
cuối stage bấm nhiều
vì nhịp thay đổi đều nên cả stage tính bằng nhịp trung bình
```

Nói bằng tiếng thường:

```text
stage ramp tuyến tính = 1 đoạn thời gian mà nhịp start tăng hoặc giảm đều
số slot của stage = nhịp trung bình trong stage * thời gian của stage
```

Ví dụ dễ nhất:

```text
2 -> 4 iterations/s trong 2s
0s: 2/s
1s: 3/s
2s: 4/s
trung bình = 3/s
2s * 3/s = 6 iterations
```

Ramp xuống cũng giống vậy:

```text
4 -> 1 iterations/s trong 2s
0s: 4/s
1s: 2.5/s
2s: 1/s
trung bình = 2.5/s
2s * 2.5/s = 5 iterations
```

Nếu muốn nhìn bằng hình:

```text
Ramp lên 2 -> 4 trong 2s

rate
4 |           /|
3 |          / |
2 |_________/  |
0 +------0s----2s

0s=2/s, 1s=3/s, 2s=4/s
=> tổng 6 slot

Ramp xuống 4 -> 1 trong 2s

rate
4 |--------\   |
3 |         \  |
2 |          \ |
1 |           \|
0 +------0s----2s

0s=4/s, 1s=2.5/s, 2s=1/s
=> tổng 5 slot
```

Trong core, `cal()` chỉ làm việc này:

```text
đi qua từng stage
tính tổng slot của stage đó
cộng phần slot còn dư sang stage sau
```

`scheduled_iterations_i` có thể ra số lẻ. Core không làm tròn ngay; phần lẻ được mang sang stage
sau qua `doneSoFar`.

Nếu stage không ramp, tức là giữ nguyên một nhịp:

```text
scheduled_iterations_i = d_i * lambda
```

Tổng số lần k6 dự tính bấm start cho cả bài:

```text
scheduled_iterations_total = sum(scheduled_iterations_i)
```

Đây là số lần k6 định bấm start, chưa tính chuyện bị rớt hay bị dừng sớm.
Nếu có drop/interrupt, summary completed rate sẽ thấp hơn con số này.

Trong `cal()`:

- `doneSoFar` = số slot đã tích lũy trước stage hiện tại
- `endCount` = số slot tích lũy tới cuối stage hiện tại
- `i` = slot nguyên kế tiếp cần được gán thời điểm start

Ví dụ stage trước kết thúc ở `9.8` events thì `0.8` không mất đi. Core giữ phần đó trong
`doneSoFar`, rồi stage sau chỉ cần cộng tiếp phần còn lại để tìm khi nào slot kế tiếp xảy ra.

### 3.2. Nhịp cao nhất và nhịp bình quân

```text
lambda_peak = max(lambda_start, mọi lambda_i_end)
average_target_rate = scheduled_iterations_total / total_regular_duration
```

`lambda_peak` là nhịp cao nhất mà timeline đòi k6 phải start ở bất kỳ đoạn nào.
Vì stage ramp đi đều từ đầu sang cuối, chỗ cao nhất của stage chỉ nằm ở 2 đầu stage.

`average_target_rate` là nhịp bình quân của cả bài test nếu lấy tổng slot chia cho tổng thời gian.
Nó không phải summary completed rate.

Nói dễ hiểu:

```text
lambda_peak = nhịp cao nhất cần chịu
average_target_rate = nhịp trung bình của cả timeline
```

Ví dụ: cả bài có lúc lên 8/s rồi xuống 2/s thì sizing phải nhìn 8/s, vì chính đoạn 8/s mới là
đoạn dễ thiếu VU nhất.

`drop_rate` là phần slot bị rớt khi nhịp hiện tại vượt quá khả năng của VU:

```text
drop_rate ~= max(0, lambda_current - capacity_with_M_vus)
```

`lambda_current` là nhịp đang xảy ra ngay lúc đó. Đầu stage có thể thấp, giữa stage có thể cao hơn.
Khi chuẩn bị VU, đừng nhìn `average_target_rate` một mình, vì nhịp giữa stage mới là chỗ dễ thiếu VU.

### 3.3. Ước lượng VU

```text
required_vus_min_peak ~= ceil(lambda_peak * W_effective)
capacity_with_M_vus ~= M / W_effective
drop_rate ~= max(0, lambda_current - capacity_with_M_vus)
```

Đọc kiểu thực tế:

- `lambda_peak * W_effective`: một iteration giữ VU bao lâu, nhân với nhịp cao nhất.
- `ceil(...)`: làm tròn lên vì không thể có nửa VU.
- `capacity_with_M_vus`: với `M` VU thì cả pool chạy được khoảng bao nhiêu iteration/s.
- `drop_rate`: nhịp hiện tại lớn hơn sức chứa thì phần dư sẽ bị drop.

Kiểm tra đơn vị:

```text
lambda_peak [iterations/s] * W_effective [s/iteration] = số VU cần đồng thời
M [VU] / W_effective [s/iteration] = capacity [iterations/s]
```

Ví dụ nhanh:

```text
lambda_peak = 8 iterations/s
W_effective = 0.4s
ceil(8 * 0.4) = ceil(3.2) = 4 VUs
```

Với `W_effective`:

```text
W_effective ~= iteration_duration nếu không có minIterationDuration
W_effective ~= max(iteration_duration, minIterationDuration) nếu có minIterationDuration
```

### 3.4. Rate của summary

```text
actual_summary_iterations_rate = completed_iterations / actual_scenario_runtime
http_reqs_rate = total_http_requests / actual_scenario_runtime
checks_total_rate = total_checks / actual_scenario_runtime
```

Đây là rate của metric summary thật, đọc từ `count / runtime` của Counter.
`actual_scenario_runtime` là thời gian thực tế từ lúc scenario bắt đầu tới lúc nó thật sự dừng,
thường có thể dài hơn `total_regular_duration` nếu còn `gracefulStop`.
Nó khác `average_target_rate` ở trên:

```text
average_target_rate = rate lịch start trung bình
actual_summary_iterations_rate = rate completed iteration thực tế
```

Nếu 1 completed iteration chạy đủ N request:

```text
estimated_http_reqs_rate_if_no_branch = N * actual_summary_iterations_rate
```

Chỉ dùng khi code path sạch và không có interrupt/branch làm thiếu request.

## 3.9. Checklist core đã lọc cho `ramping-arrival-rate`

Phần này là phụ lục đối chiếu code thật. Nếu mới học, đọc cột `Hành vi thật` trước; cột `Core`
chỉ để biết chỗ đó nằm ở file nào.

| Core | Hành vi thật | Ý nghĩa khi đọc bài |
| --- | --- | --- |
| `ramping_arrival_rate.go:Validate()` | kiểm tra `startRate`, `timeUnit`, `stages`, `preAllocatedVUs`, `maxVUs` | `stages` bắt buộc; `maxVUs` nếu bỏ qua thì core dùng bằng `preAllocatedVUs`. |
| `ramping_arrival_rate.go:GetDescription()` | mô tả theo max stage rate và tổng stage duration | `Up to X iterations/s for Y over N stages ...` là peak stage rate, không phải rate cố định. |
| `ramping_arrival_rate.go:GetExecutionRequirements()` | reserve `preAllocatedVUs` và `maxVUs - preAllocatedVUs`; end offset = `sumStagesDuration + gracefulStop` | Planned VUs có sẵn từ đầu; unplanned quota chỉ là phần thêm. |
| `ramping_arrival_rate.go:cal()` | sinh mốc start theo diện tích dưới đường rate | Ramping stage không có `ticker_period` cố định toàn run; slot cách nhau thay đổi theo rate. |
| `ramping_arrival_rate.go:Run()` | tới mốc thì `TryRunIteration()`; fail thì drop; còn quota thì start unplanned VU ở background | Drop là theo slot hiện tại, không retry slot cũ. |
| `activeVUPool.TryRunIteration()` | non-blocking | Không có VU rảnh là false ngay. |
| `activeVUPool.AddVU()` | 1 VU có thể xử lý nhiều iteration nối tiếp khi pool nhận request mới | VU chỉ là worker, không phải quota. |
| `internal/execution/scheduler.go:emitVUsAndVUsMax()` | `vus`/`vus_max` sample mỗi giây | `vus_max` là initialized VUs tại thời điểm sample, không phải configured `maxVUs`. |
| `internal/js/runner.go:RunOnce()` + `iterationSamples()` | `iterations` và `iteration_duration` emit sau full iteration | `iteration_duration` không bao gồm sleep bù `minIterationDuration`. |
| `helpers.go:getDurationContexts()` | `regDurationCtx` chặn start mới; `maxDurationCtx` là regular + gracefulStop | Hết stage timeline thì không start mốc mới nữa; chỉ chờ finish trong grace. |

## 3.10. Demo stage curve đủ VU

Ví dụ schedule:

```js
startRate: 2,
timeUnit: "1s",
stages: [
  { duration: "2s", target: 4 },
  { duration: "2s", target: 1 },
  { duration: "2s", target: 3 },
]
```

Rate theo stage:

```text
0-2s: 2 -> 4 iterations/s
2-4s: 4 -> 1 iterations/s
4-6s: 1 -> 3 iterations/s
```

Số scheduled starts theo diện tích:

```text
stage 1: 2s * (2 + 4)/2 = 6
stage 2: 2s * (4 + 1)/2 = 5
stage 3: 2s * (1 + 3)/2 = 4
total = 15 scheduled iterations
```

Peak rate:

```text
lambda_peak = 4 iterations/s
```

S sizing:

```text
required_vus_min_peak ~= ceil(4 * W_effective)
```

Nếu `W_effective = 0.4s` (ví dụ workload kiểu `sleep(0.4)`):

```text
required_vus_min_peak ~= 2 VUs
```

Nếu `W_effective = 1.76s`:

```text
required_vus_min_peak ~= 8 VUs
```

### 3.11. Demo thiếu VU và dropped_iterations

Ví dụ peak lên cao hơn capacity:

```js
startRate: 4,
timeUnit: "1s",
stages: [
  { duration: "3s", target: 10 },
]
```

Nếu workload có:

```text
W_effective = 0.6s
```

thì peak cần:

```text
required_vus_min_peak ~= ceil(10 * 0.6) = 6 VUs
```

Nếu chỉ có:

```text
preAllocatedVUs: 2,
maxVUs: 4,
```

thì peak stage có thể rơi vào `dropped_iterations`. Core sẽ:

```text
push dropped_iterations
và nếu còn quota unplanned thì bắt đầu tạo VU mới ở background
```

Mốc hiện tại vẫn có thể đã drop xong trước khi VU mới sẵn sàng.

### 3.12. Demo preAllocatedVUs vs maxVUs

```text
preAllocatedVUs = VU chuẩn bị sẵn từ đầu
maxVUs = trần tổng VU, bao gồm unplanned quota
```

Nếu:

```text
maxVUs = preAllocatedVUs
```

thì không còn đường tạo thêm VU runtime.

Nếu:

```text
maxVUs > preAllocatedVUs
```

thì còn `maxVUs - preAllocatedVUs` VU có thể sinh thêm khi thiếu worker.

Kết luận:

```text
preAllocatedVUs là sizing để giảm drop
maxVUs là ceiling để tránh vượt trần
```

### 3.13. Demo QuickPizza `2 requests / iteration`

Nếu iteration là QuickPizza kiểu:

```text
2 HTTP requests
2 checks
sleep(1)
```

thì:

```text
W_effective thường lấy gần đúng từ iteration_duration.avg của một run sạch
```

Sau đó:

```text
estimated_http_reqs_rate_if_no_branch = 2 * actual_summary_iterations_rate
estimated_checks_total_rate_if_no_branch = 2 * actual_summary_iterations_rate
```

Nếu peak rate cao hơn `ceil(lambda_peak * W_effective)`, test sẽ cần nhiều VU hơn.
Nếu preAllocatedVUs thấp hơn peak demand, có thể xuất hiện unplanned VU hoặc drop.

## 4. So sánh với constant-arrival-rate

```text
constant-arrival-rate = 1 rate cố định
ramping-arrival-rate = rate đổi theo stage curve
```

Giống nhau:

```text
open model
preAllocatedVUs/maxVUs
TryRunIteration() non-blocking
dropped_iterations khi không có VU rảnh
vus/vus_max là scheduler samples
```

Khác nhau:

```text
constant-arrival-rate có 1 lambda
ramping-arrival-rate có lambda(t) theo stage
```

Nên với ramping-arrival-rate, sizing nên nhìn:

```text
lambda_peak
W_effective
```

không chỉ nhìn rate trung bình của cả timeline.

## 5. Cheat sheet

```text
startRate = rate lúc bắt đầu
stage.target = rate đích ở cuối stage
stage.duration = thời lượng stage
total_regular_duration = sum(stage.duration)
lambda_peak = max(startRate, mọi stage.target) / timeUnit
```

```text
scheduled_iterations_stage = d * (lambda_prev + lambda_next) / 2
scheduled_iterations_total = sum(scheduled_iterations_stage)
```

```text
required_vus_min_peak ~= ceil(lambda_peak * W_effective)
capacity_with_M_vus ~= M / W_effective
```

```text
W_effective ~= iteration_duration nếu không có minIterationDuration
W_effective ~= max(iteration_duration, minIterationDuration) nếu có minIterationDuration
```

```text
actual_summary_iterations_rate = completed_iterations / actual_scenario_runtime
```
