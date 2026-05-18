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
ramping-arrival-rate = fixed stage curve of iteration start rate
startRate = rate trước stage 1
stage.target = rate đích ở cuối stage
stage.duration = thời lượng stage
total_regular_duration = sum(stage.duration)
lambda_peak = max(startRate, mọi stage.target) / timeUnit
```

```text
required_vus_min_peak ~= ceil(lambda_peak * W_effective)
```

```text
W_effective ~= iteration_duration nếu không có minIterationDuration
W_effective ~= max(iteration_duration, minIterationDuration) nếu có minIterationDuration
```

```text
estimated_http_reqs_rate_if_no_drop ~= requests_per_iteration * iterations/s
```

Chỉ đúng khi mỗi completed iteration chạy đủ request trên cùng code path.
