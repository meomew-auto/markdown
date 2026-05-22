# `ramping-arrival-rate` worked example

Mẫu này dùng một workload cực dễ đọc để nhìn rõ cách k6 xếp lịch start:

```text
1 iteration = 1 sleep(0.4)
```

## 1. Script

```js
import exec from "k6/execution";
import { sleep } from "k6";

export const options = {
  scenarios: {
    ramping_arrival_demo: {
      executor: "ramping-arrival-rate",
      startRate: 4,
      timeUnit: "1s",
      stages: [
        { duration: "2s", target: 8 },
        { duration: "2s", target: 2 },
        { duration: "2s", target: 6 },
      ],
      preAllocatedVUs: 4,
      maxVUs: 4,
      gracefulStop: "2s",
    },
  },
};

export default function () {
  sleep(0.4);
}
```

## 2. Đường nhịp

Core `cal()` hiểu stage theo đường tuyến tính giữa `startRate` và `stage.target`.
Nói dễ hiểu: trong mỗi stage, nhịp start không nhảy cục mà đổi đều từ đầu stage tới cuối stage.

Với config trên:

```text
0-2s: 4 -> 8 iterations/s
2-4s: 8 -> 2 iterations/s
4-6s: 2 -> 6 iterations/s
```

Số mốc start theo diện tích:

```text
stage 1 = 2s * (4 + 8)/2 = 12
stage 2 = 2s * (8 + 2)/2 = 10
stage 3 = 2s * (2 + 6)/2 = 8
theoretical scheduled start slots = 30
```

Đây là số mốc start lý thuyết theo diện tích dưới đường rate mà core `cal()` dùng để xếp lịch.
Nếu run sạch, `completed_iterations` có thể tiến gần 30. Nếu thiếu VU hoặc bị interrupt thì:

```text
theoretical_scheduled_start_slots
  ~= completed_iterations + interrupted_iterations + dropped_iterations

completed_iterations
  ~= theoretical_scheduled_start_slots - interrupted_iterations - dropped_iterations
```

Ngoài ra ở biên cuối gần `t=6s`, có thể lệch khoảng 1 mốc do timing đúng mép regular duration.

Peak rate:

```text
lambda_peak = 8 iterations/s
```

Đây là peak instant rate của timeline, không phải average rate của cả test.

## 3. Cần bao nhiêu VU

Vì workload chỉ `sleep(0.4)`:

```text
W_effective ~= 0.4s
```

`0.4s` lấy thẳng từ `sleep(0.4)` trong `default()`. Vì demo này gần như chỉ ngủ, nên
`iteration_duration.avg` cũng sẽ xấp xỉ 400ms và đó là cách summary xác nhận lại `W_effective`.

Peak VU cần gần đúng:

```text
required_vus_min_peak ~= ceil(8 * 0.4) = 4 VUs
```

Nên config `preAllocatedVUs: 4, maxVUs: 4` đủ cho peak này.

Nếu `W_effective` lớn hơn, cần tăng VU theo `ceil(lambda_peak * W_effective)`.

Nếu muốn an toàn hơn khi workload dao động:

```text
W_effective_p95 = p95 của effective busy time
safety_factor = hệ số an toàn, thường > 1

safe_vus ~= ceil(lambda_peak * W_effective_p95 * safety_factor)
```

## 4. Đọc output theo core

Nếu run sạch:

```text
iterations rate = completed_iterations / summary_runtime_base
```

Nhưng phải tách rõ với nhịp target của timeline:

```text
average_target_start_rate = theoretical_scheduled_start_slots / total_regular_duration
                          = 30 / 6s
                          = 5 starts/s
```

Trong khi summary `/s` là:

```text
completed_iterations / summary_runtime_base
```

Vì vậy không dùng riêng summary `/s` để kết luận arrival schedule có được giữ hay không.

Trong worked example này, vì test là 1 scenario đơn, `startTime=0`, và không có `setup()/teardown`,
`summary_runtime_base` thường rất gần với thời gian scenario thật sự chạy.

và:

```text
vus_max = initialized VUs sample
vus = active VUs sample
```

`vus` chỉ đếm VU đang chạy iteration; VU đã init xong nhưng đang rảnh chờ việc mới chưa được tính.

Nếu `iterations` không bằng 30:

```text
lệch nhiều thì thường có drop hoặc interrupt
lệch 1 slot ở biên cuối vẫn có thể chỉ là timing của slot cuối đúng mép regular duration
```

## 5. Điều cần nhớ

```text
peak rate quyết định VU sizing
không phải average rate của cả timeline
```

```text
slot hiện tại bị drop nếu không có VU rảnh
unplanned VU chỉ giúp các slot sau
```

## 6. Kết luận chốt: đọc số nào?

`ramping-arrival-rate` cũng là open model, nhưng nhịp start thay đổi theo stage.

Nên khi báo cáo 1 run:

- số chính: `lambda_start`, `lambda_peak`, và `iterations/s` thực tế của summary
- `dropped_iterations` để biết có bỏ mốc start nào không
- `http_reqs/s` nếu muốn nhìn theo request
- `iteration_duration avg/med/p95` để mô tả VU bị bận bao lâu

Khi sizing:

- lấy `lambda_peak` làm nhịp cần bảo vệ
- dùng `W_effective_p95` để tránh lạc quan
- công thức chốt là `safe_vus ~= ceil(lambda_peak * W_effective_p95 * safety_factor)`
- nhiều run cùng cấu hình thì lấy `median(iterations/s)` giữa các run làm số đại diện, run xấu nhất giữ để kiểm tra drop

Điểm mấu chốt:

```text
stage curve quyết định nhịp start
VU sizing quyết định có drop hay không
summary completed rate chỉ là kết quả cuối
```
