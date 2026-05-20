# `constant-arrival-rate` quick index

File chính:

```text
docs/20260517_constant-arrival-rate-tham-so-cong-thuc.md
```

Worked example QuickPizza:

```text
docs/20260517_constant_arrival_rate_quickpizza_two_requests_worked_example.md
```

## Link nhanh

- [Ý tưởng chính](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#1-ý-tưởng-chính)
- [Khi nào dùng thực tế](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#11-khi-nào-dùng-thực-tế)
- [Core chạy như nào](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#12-core-chạy-như-nào)
- [Bảng tham số tiếng Việt](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#3-công-thức-nền)
- [Checklist core đã lọc](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#39-checklist-core-đã-lọc-cho-constant-arrival-rate)
- [Đọc vus và vus_max theo core](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#391-đọc-vus-và-vus_max-theo-core)
- [Đọc iterations và iteration_duration theo core](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#392-đọc-iterations-và-iteration_duration-theo-core)
- [Execution segment và rate scaling](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#393-execution-segment-và-rate-scaling)
- [Bảng đối chiếu core truth](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#394-bảng-đối-chiếu-core-truth)
- [Source map core đã đối chiếu](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#395-source-map-core-đã-đối-chiếu)
- [Thêm nhầm field của executor khác](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#310-thêm-nhầm-field-của-executor-khác-có-lỗi-không)
- [Demo fixed start schedule](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#4-demo-fixed-start-schedule-đủ-vu)
- [Demo thiếu VU và dropped_iterations](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#5-demo-thiếu-vu-và-dropped_iterations)
- [Demo preAllocatedVUs vs maxVUs](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#6-demo-preallocatedvus-vs-maxvus)
- [Demo interrupt cuối scenario](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#7-demo-interrupt-cuối-scenario)
- [Demo QuickPizza 2 requests / iteration](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#8-demo-quickpizza-2-requests--iteration)
- [So sánh với closed-model executors](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#9-so-sánh-với-constant-vus-ramping-vus-per-vu-shared)
- [Cheat sheet](./20260517_constant-arrival-rate-tham-so-cong-thuc.md#10-cheat-sheet)

## File demo

```text
examples/constant_arrival_rate_schedule_demo.js
examples/constant_arrival_rate_not_enough_vus_demo.js
examples/constant_arrival_rate_unplanned_vus_demo.js
examples/constant_arrival_rate_interrupt_demo.js
examples/constant_arrival_rate_quickpizza_two_requests_demo.js
```

## Command chạy nhanh

```powershell
rtk k6 run .\examples\constant_arrival_rate_schedule_demo.js
rtk k6 run .\examples\constant_arrival_rate_not_enough_vus_demo.js
rtk k6 run .\examples\constant_arrival_rate_unplanned_vus_demo.js
rtk k6 run .\examples\constant_arrival_rate_interrupt_demo.js
rtk k6 run .\examples\constant_arrival_rate_quickpizza_two_requests_demo.js
```

## Nhớ nhanh

```text
constant-arrival-rate = fixed iteration start rate
```

Đọc tốc độ start ở:

```text
rate / timeUnit
```

Ví dụ:

```js
rate: 4,
timeUnit: "1s",
```

nghĩa là target start rate `4 iteration starts/s`. Khi chạy, header sẽ hiện dạng:

```text
4.00 iterations/s for ...
```

Đừng nhầm với summary `iterations...: N X/s`; đó là completed iteration rate trung bình.

`rate` không làm core tự tính đủ VU để đảm bảo chạy được target. Core lấy `preAllocatedVUs` làm số
VU chuẩn bị sẵn, lấy `maxVUs` làm trần; thiếu VU rảnh đúng mốc thì `dropped_iterations` tăng.

Công thức hay dùng:

```text
lambda = rate / timeUnit_seconds

ticker_period = 1 / lambda = timeUnit_seconds / rate

executor_wall_time_after_start_max = duration + gracefulStop

required_vus_min ~= ceil(lambda * W_effective)

capacity_with_M_vus ~= M / W_effective

drop_rate ~= max(0, lambda - capacity_with_M_vus)

observed_scheduled_slots ~= completed_iterations + interrupted_iterations + dropped_iterations

estimated_http_req_rate_if_no_drop ~= lambda * http_requests_per_iteration
```

Trong đó:

```text
W_effective = thời gian VU bị bận cho full default/exec function
không có minIterationDuration thì W_effective thường lấy từ iteration_duration
có minIterationDuration thì dùng max(iteration_duration, minIterationDuration)
M = số VU đang giả sử có để nhận việc trong công thức capacity
http_requests_per_iteration = số request mỗi iteration của đúng demo/script đang nói tới
completed_iterations = số iteration chạy xong thật trong summary
```

Không đọc nhầm:

```text
preAllocatedVUs không phải số user mục tiêu
maxVUs không phải target throughput
rate mới là tốc độ start iteration mục tiêu
```

Khác nhóm closed model:

```text
constant-vus/ramping-vus = VU loop xong rồi mới start iteration kế
constant-arrival-rate = đến mốc start theo lịch thì k6 cố start iteration mới
```

Trong bài này, `slot` hay `slot thời gian` nghĩa là một mốc start iteration theo lịch. Ví dụ
`rate: 4`, `timeUnit: "1s"` thì các mốc start cách nhau khoảng `0.25s`.

Nó không phải VU hay queue; chỉ là thời điểm scheduler muốn start một iteration.

Nếu không có VU rảnh đúng mốc:

```text
dropped_iterations tăng
mốc đó không được chờ bù
```

Đọc metrics theo core:

```text
iterations = full iterations đã kết thúc
iteration_duration = thời gian function chạy xong; nếu không có minIterationDuration thì xấp xỉ VU busy time
vus = active VUs tại thời điểm scheduler sample
vus_max = initialized VUs tại thời điểm scheduler sample, không phải configured maxVUs
vus/vus_max là sample mỗi giây, không phải high-watermark tuyệt đối từng millisecond
```

Đọc từng biến:

| Biến / biểu thức | Nghĩa đời thường | Lấy ở đâu |
| --- | --- | --- |
| `rate` | mỗi `timeUnit` muốn start bao nhiêu iteration | config scenario |
| `timeUnit_seconds` | `timeUnit` đổi ra giây | ví dụ `1s -> 1`, `1m -> 60` |
| `lambda` | target start rate theo giây | `rate / timeUnit_seconds` |
| `ticker_period` | khoảng cách giữa 2 mốc start liên tiếp | `1 / lambda` |
| `W_effective` | 1 iteration giữ 1 VU bận bao lâu | thường lấy từ `iteration_duration`, nhớ caveat `minIterationDuration` |
| `preAllocatedVUs` | VU chuẩn bị sẵn từ đầu | config scenario |
| `maxVUs` | trần tổng VU tối đa được phép dùng | config scenario |
| `completed_iterations` | số iteration chạy xong thật | summary `iterations` |
| `dropped_iterations` | số mốc start đến hạn nhưng không có VU rảnh | metric `dropped_iterations` |
| `interrupted_iterations` | iteration đã start nhưng bị cắt ở cuối scenario | progress cuối `interrupted iterations` |

Điểm dễ nhầm nhất:

```text
summary iterations/s là tốc độ completed iteration trung bình
không phải target start rate
```
