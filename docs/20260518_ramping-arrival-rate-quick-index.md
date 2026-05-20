# `ramping-arrival-rate` quick index

File chính:

```text
docs/20260518_ramping-arrival-rate-tham-so-cong-thuc.md
```

Worked example:

```text
docs/20260518_ramping_arrival_rate_worked_example.md
```

## Link nhanh

- [Ý tưởng chính](./20260518_ramping-arrival-rate-tham-so-cong-thuc.md#1-ý-tưởng-chính)
- [Khi nào dùng thực tế](./20260518_ramping-arrival-rate-tham-so-cong-thuc.md#11-khi-nào-dùng-thực-tế)
- [Core chạy như nào](./20260518_ramping-arrival-rate-tham-so-cong-thuc.md#12-core-chạy-như-nào)
- [Bảng tham số tiếng Việt](./20260518_ramping-arrival-rate-tham-so-cong-thuc.md#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](./20260518_ramping-arrival-rate-tham-so-cong-thuc.md#3-công-thức-nền)
- [Checklist core đã lọc](./20260518_ramping-arrival-rate-tham-so-cong-thuc.md#39-checklist-core-đã-lọc-cho-ramping-arrival-rate)
- [Demo stage curve đủ VU](./20260518_ramping-arrival-rate-tham-so-cong-thuc.md#310-demo-stage-curve-đủ-vu)
- [Demo thiếu VU và dropped_iterations](./20260518_ramping-arrival-rate-tham-so-cong-thuc.md#311-demo-thiếu-vu-và-dropped_iterations)
- [Demo preAllocatedVUs vs maxVUs](./20260518_ramping-arrival-rate-tham-so-cong-thuc.md#312-demo-preallocatedvus-vs-maxvus)
- [Demo QuickPizza 2 requests / iteration](./20260518_ramping-arrival-rate-tham-so-cong-thuc.md#313-demo-quickpizza-2-requests--iteration)
- [So sánh với constant-arrival-rate](./20260518_ramping-arrival-rate-tham-so-cong-thuc.md#4-so-sánh-với-constant-arrival-rate)
- [Cheat sheet](./20260518_ramping-arrival-rate-tham-so-cong-thuc.md#5-cheat-sheet)

## Nhớ nhanh

```text
ramping-arrival-rate = đường stage đổi nhịp start iteration theo timeline
startRate = nhịp lúc bắt đầu stage 1
stage.target = nhịp đích ở cuối stage
stage.duration = thời lượng mỗi stage
total_regular_duration = tổng thời lượng các stage
lambda_peak = nhịp cao nhất trong cả timeline (đã đổi về /s)
```

```text
required_vus_min_peak ~= ceil(lambda_peak * W_effective)
```

```text
W_effective ~= iteration_duration nếu không có minIterationDuration
W_effective ~= max(iteration_duration, minIterationDuration) nếu có minIterationDuration
```

```text
observed_http_reqs_rate ~= N_req * actual_summary_iterations_rate
target_http_reqs_rate_if_no_drop ~= N_req * average_target_rate
```

Trong đó:

```text
N_req = số HTTP request trong mỗi iteration của đúng demo/script đang nói tới
actual_summary_iterations_rate = iterations/s ở summary
average_target_rate = nhịp target trung bình của cả timeline
```

`observed_http_reqs_rate` là cách đọc từ output thật.
`target_http_reqs_rate_if_no_drop` là cách ước lượng theo lịch target nếu không rơi slot và mỗi
iteration luôn đi cùng một code path.

Đọc từng biến:

| Biến / biểu thức | Nghĩa đời thường | Lấy ở đâu |
| --- | --- | --- |
| `startRate` | nhịp start lúc vừa bắt đầu scenario | config scenario |
| `stage.target` | nhịp start ở cuối stage | config `stages[]` |
| `stage.duration` | stage kéo dài bao lâu | config `stages[]` |
| `lambda_peak` | nhịp start cao nhất trong cả timeline | lấy max của `startRate` và mọi `stage.target`, rồi đổi về `/s` |
| `average_target_rate` | nhịp target trung bình của cả timeline | `scheduled_iterations_total / total_regular_duration` |
| `W_effective` | một iteration giữ VU bận bao lâu | thường lấy từ `iteration_duration`, nhớ caveat `minIterationDuration` |
| `required_vus_min_peak` | số VU tối thiểu gần đúng để chịu được đoạn peak | `ceil(lambda_peak * W_effective)` |
| `actual_summary_iterations_rate` | completed iteration rate trung bình của summary | dòng `iterations...: count rate/s` |
| `N_req` | số request trong mỗi iteration của đúng demo/script | đọc trong code |

Điểm dễ nhầm nhất:

```text
ramping-arrival-rate sizing theo đoạn peak
không theo rate trung bình của cả timeline
```

Và thêm 2 note ngắn:

```text
ramping-arrival-rate không có ticker_period cố định cho toàn run
slot đầu cũng không mặc định ở t=0; nó xuất hiện khi tích lũy đủ event đầu tiên
```
