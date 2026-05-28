# `ramping-vus` quick index

File chính:

```text
docs/20260517_ramping-vus-tham-so-cong-thuc.md
```

Worked example QuickPizza:

```text
docs/20260517_ramping_vus_quickpizza_two_requests_worked_example.md
```

## Link nhanh

- [Ý tưởng chính](./20260517_ramping-vus-tham-so-cong-thuc.md#1-ý-tưởng-chính)
- [Khi nào dùng thực tế](./20260517_ramping-vus-tham-so-cong-thuc.md#11-khi-nào-dùng-thực-tế)
- [Core chạy như nào](./20260517_ramping-vus-tham-so-cong-thuc.md#12-core-chạy-như-nào)
- [Bảng tham số tiếng Việt](./20260517_ramping-vus-tham-so-cong-thuc.md#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](./20260517_ramping-vus-tham-so-cong-thuc.md#3-công-thức-nền)
- [Checklist core đã lọc](./20260517_ramping-vus-tham-so-cong-thuc.md#39-checklist-core-đã-lọc-cho-ramping-vus)
- [Thêm nhầm field của executor khác](./20260517_ramping-vus-tham-so-cong-thuc.md#310-thêm-nhầm-field-của-executor-khác-có-lỗi-không)
- [Demo stage timeline](./20260517_ramping-vus-tham-so-cong-thuc.md#4-demo-stage-timeline)
- [Demo VU nhanh/chậm](./20260517_ramping-vus-tham-so-cong-thuc.md#5-demo-vu-nhanhchậm)
- [Demo gracefulRampDown và interrupted](./20260517_ramping-vus-tham-so-cong-thuc.md#6-demo-gracefulrampdown-và-interrupted)
- [Demo QuickPizza 2 requests / iteration](./20260517_ramping-vus-tham-so-cong-thuc.md#7-demo-quickpizza-2-requests--iteration)
- [So sánh với constant-vus per-vu shared arrival-rate](./20260517_ramping-vus-tham-so-cong-thuc.md#8-so-sánh-với-constant-vus-per-vu-shared-arrival-rate)
- [Cheat sheet](./20260517_ramping-vus-tham-so-cong-thuc.md#9-cheat-sheet)

## File demo

```text
examples/ramping_vus_stage_timeline_demo.js
examples/ramping_vus_vu_speed_count_demo.js
examples/ramping_vus_graceful_rampdown_demo.js
examples/ramping_vus_interrupt_demo.js
examples/ramping_vus_quickpizza_two_requests_demo.js
```

## Command chạy nhanh

```powershell
rtk k6 run .\examples\ramping_vus_stage_timeline_demo.js
rtk k6 run .\examples\ramping_vus_vu_speed_count_demo.js
rtk k6 run .\examples\ramping_vus_graceful_rampdown_demo.js
rtk k6 run .\examples\ramping_vus_interrupt_demo.js
rtk k6 run .\examples\ramping_vus_quickpizza_two_requests_demo.js
```

## Nhớ nhanh

```text
ramping-vus = variable VUs over time
```

Công thức hay dùng:

```text
regular_duration = sum(stage.duration)

executor_wall_time_after_start_max = regular_duration + gracefulStop

per_vu_rate_i = 1 / t_i

effective_iteration_time ~= iteration_duration nếu không có minIterationDuration

effective_iteration_time ~= max(iteration_duration, minIterationDuration) nếu có minIterationDuration

peak_iteration_rate_if_all_active ~= active_vus / effective_iteration_time

average_iteration_rate = completed_iterations / summary_runtime_base

average_http_request_rate = total_http_requests / summary_runtime_base
```

Trong đó:

```text
t_i = thời gian một iteration của VU i giữ VU bận
per_vu_rate_i = 1 / t_i = riêng VU đó trung bình chạy được bao nhiêu iteration/s
active_vus = số VU đang bận ở thời điểm đang xét
summary_runtime_base = mẫu số mà Counter summary dùng cho cột `/s`
```

Không có:

```text
total_iterations_target
đường emit dropped_iterations bình thường
```

Vì vậy tổng iteration chỉ biết chắc sau khi chạy:

```text
completed_iterations = summary iterations count
```

Đọc từng biến:

| Biến / biểu thức | Nghĩa đời thường | Lấy ở đâu |
| --- | --- | --- |
| `stage.duration` | stage kéo dài bao lâu | config `stages[]` |
| `stage.target` | cuối stage muốn có bao nhiêu VU | config `stages[]` |
| `regular_duration` | tổng thời gian của các stage | cộng toàn bộ `stage.duration` |
| `t_i` / `effective_iteration_time` | một iteration giữ VU bận bao lâu | thường lấy từ `iteration_duration`, có caveat `minIterationDuration` |
| `active_vus` | số VU đang bận chạy tại thời điểm đó | progress `x/y VUs`, metric `vus` |
| `summary_runtime_base` | mẫu số mà Counter summary dùng cho cột `/s` | `count / rate` từ summary Counter |
| `average_iteration_rate` | completed iteration trung bình mỗi giây của cả run | summary `iterations...: count rate/s` |

Điểm dễ nhầm nhất:

```text
ramping-vus đổi số VU theo timeline
chứ không đặt lịch start iteration cố định như arrival-rate
```

Cảnh báo nhanh:

```text
gracefulStop có thể cắt ngắn gracefulRampDown ở cuối scenario
vus và vus_max là Gauge sample theo chu kỳ, không phải timeline chính xác từng khoảnh khắc
```
