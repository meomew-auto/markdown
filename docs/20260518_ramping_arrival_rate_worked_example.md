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
total scheduled iterations = 30
```

Đây là số slot start theo lịch từ core `cal()`. Nếu run sạch, completed iterations có thể tiến gần
30; nếu thiếu VU hoặc bị interrupt thì summary `iterations` sẽ thấp hơn.

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
iterations rate = completed_iterations / actual_scenario_runtime
```

và:

```text
vus_max = initialized VUs sample
vus = active VUs sample
```

`vus` chỉ đếm VU đang chạy iteration; VU đã init xong nhưng đang rảnh chờ việc mới chưa được tính.

Nếu `iterations` không bằng 30:

```text
có drop hoặc interrupt
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
