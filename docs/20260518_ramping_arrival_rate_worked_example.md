# `ramping-arrival-rate` worked example

Mẫu này dùng một workload cực dễ đọc để bóc đúng core flow:

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

## 2. Rate curve

Core `cal()` hiểu stage theo đường tuyến tính giữa `startRate` và `stage.target`.

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

Peak rate:

```text
lambda_peak = 8 iterations/s
```

## 3. Sizing VU

Vì workload chỉ `sleep(0.4)`:

```text
W_effective ~= 0.4s
```

Peak VU cần gần đúng:

```text
required_vus_min_peak ~= ceil(8 * 0.4) = 4 VUs
```

Nên config `preAllocatedVUs: 4, maxVUs: 4` đủ cho peak này.

Nếu muốn an toàn hơn khi workload dao động:

```text
safe_vus ~= ceil(lambda_peak * W_effective_p95 * safety_factor)
```

## 4. Đọc summary theo core

Nếu run sạch:

```text
iterations rate = completed_iterations / actual_scenario_runtime
```

và:

```text
vus_max = initialized VUs sample
vus = active VUs sample
```

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
