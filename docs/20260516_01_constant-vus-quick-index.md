# `constant-vus` quick index

File chính:

```text
docs/20260516_02_constant-vus-tham-so-cong-thuc.md
```

Worked example QuickPizza:

```text
docs/20260516_03_constant-vus-quickpizza-two-requests-worked-example.md
```

## Link nhanh

- [Practice 7 case backend](./practice/constant-vus/00_overview.md)
- [Run guide practice](./practice/constant-vus/RUN_GUIDE.md)
- [Ý tưởng chính](./20260516_02_constant-vus-tham-so-cong-thuc.md#1-ý-tưởng-chính)
- [Khi nào dùng thực tế](./20260516_02_constant-vus-tham-so-cong-thuc.md#11-khi-nào-dùng-thực-tế)
- [Core chạy như nào](./20260516_02_constant-vus-tham-so-cong-thuc.md#12-core-chạy-như-nào)
- [Bảng tham số tiếng Việt](./20260516_02_constant-vus-tham-so-cong-thuc.md#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](./20260516_02_constant-vus-tham-so-cong-thuc.md#3-công-thức-nền)
- [Checklist core đã lọc](./20260516_02_constant-vus-tham-so-cong-thuc.md#39-checklist-core-đã-lọc-cho-constant-vus)
- [Thêm nhầm field của executor khác](./20260516_02_constant-vus-tham-so-cong-thuc.md#310-thêm-nhầm-field-của-executor-khác-có-lỗi-không)
- [Demo loop theo duration](./20260516_02_constant-vus-tham-so-cong-thuc.md#4-demo-loop-theo-duration)
- [Demo VU nhanh/chậm](./20260516_02_constant-vus-tham-so-cong-thuc.md#5-demo-vu-nhanhchậm)
- [Demo interrupt](./20260516_02_constant-vus-tham-so-cong-thuc.md#6-demo-interrupt)
- [Demo QuickPizza 2 requests / iteration](./20260516_02_constant-vus-tham-so-cong-thuc.md#7-demo-quickpizza-2-requests--iteration)
- [So sánh với per-vu và shared](./20260516_02_constant-vus-tham-so-cong-thuc.md#8-so-sánh-với-per-vu-và-shared)
- [Cheat sheet](./20260516_02_constant-vus-tham-so-cong-thuc.md#9-cheat-sheet)

## File demo

```text
examples/constant_vus_loop_demo.js
examples/constant_vus_vu_speed_count_demo.js
examples/constant_vus_interrupt_demo.js
examples/constant_vus_quickpizza_two_requests_demo.js
```

## Command chạy nhanh

```powershell
rtk k6 run .\examples\constant_vus_loop_demo.js
rtk k6 run .\examples\constant_vus_vu_speed_count_demo.js
rtk k6 run .\examples\constant_vus_interrupt_demo.js
rtk k6 run .\examples\constant_vus_quickpizza_two_requests_demo.js
```

## Nhớ nhanh

```text
constant-vus = fixed VUs over time
```

Đọc đời thường:

```text
giữ cố định một số VU trong một khoảng thời gian
```

Legend ngắn:

```text
t_i = thời gian VU i bị bận cho 1 iteration
counter_count = cột trái của Counter summary
counter_rate = cột phải `/s` của Counter summary
summary_runtime_base = counter_count / counter_rate
```

Công thức hay dùng:

```text
executor_wall_time_after_start = duration + gracefulStop

scenario_end_from_test_start = startTime + duration + gracefulStop

per_vu_rate_i = 1 / t_i

peak_iteration_rate_if_all_vus_active = sum(1 / t_i)

average_iteration_rate = completed_iterations / summary_runtime_base

summary_runtime_base = counter_count / counter_rate
```

Không có:

```text
total_iterations_target
iterations config
```

Vì vậy tổng iteration chỉ biết chắc sau khi chạy:

```text
completed_iterations = summary iterations count
```

Đọc từng biến:

| Biến / biểu thức | Nghĩa đời thường | Lấy ở đâu |
| --- | --- | --- |
| `duration` | khoảng thời gian regular mà executor còn được start iteration mới | config scenario |
| `gracefulStop` | thời gian chờ để iteration đang chạy xong nốt | config hoặc default `30s` từ base config |
| `t_i` | thời gian một iteration của VU i giữ VU bận | ước lượng từ `iteration_duration`, cộng caveat `minIterationDuration` |
| `per_vu_rate_i` | 1 VU đó trung bình chạy được bao nhiêu iteration/s | `1 / t_i` |
| `peak_iteration_rate_if_all_vus_active` | nếu mọi VU đều đang bận chạy thì cả nhóm đẩy được bao nhiêu iteration/s | cộng các `1 / t_i` |
| `average_iteration_rate` | tốc độ iteration trung bình nhìn từ Counter summary của run | summary `iterations...: count rate/s` hoặc `count / summary_runtime_base` |
| `summary_runtime_base` | thời gian mà Counter summary dùng làm mẫu số cho cột `/s` | `Counter count / Counter rate` |

Điểm dễ nhầm nhất:

```text
constant-vus không có target iteration count từ đầu
nó chỉ giữ số VU cố định trong một khoảng thời gian
```

Và thêm 1 caveat:

```text
core summary chia Counter rate theo test run duration của cả test
trong demo 1 scenario, startTime=0, không setup/teardown thì nó thường gần với runtime của scenario
```
