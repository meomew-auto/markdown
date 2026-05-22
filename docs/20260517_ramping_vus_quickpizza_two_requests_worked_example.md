# Ramping VUs QuickPizza `2 requests / iteration` worked example

File này phân tích một run cụ thể của:

```text
ramping-vus
```

Khác với `per-vu-iterations` và `shared-iterations`, ở đây:

```text
không có tổng iteration mục tiêu cố định
```

Khác với `constant-vus`, ở đây:

```text
số VU thay đổi theo thời gian
```

## 1. File test đang phân tích

Script:

```text
examples/ramping_vus_quickpizza_two_requests_demo.js
```

Command:

```powershell
rtk k6 run .\examples\ramping_vus_quickpizza_two_requests_demo.js
```

Code cốt lõi:

```js
import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";

export const options = {
  scenarios: {
    quickpizza_ramping_vus: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "2s", target: 4 },
        { duration: "2s", target: 4 },
        { duration: "2s", target: 0 },
      ],
      gracefulRampDown: "2s",
      gracefulStop: "2s",
    },
  },
};

export default function () {
  const home = http.get("https://quickpizza.grafana.com/");
  const quotes = http.get("https://quickpizza.grafana.com/api/quotes");

  check(home, {
    "home status is 200": (res) => res.status === 200,
  });
  check(quotes, {
    "quotes status is 200": (res) => res.status === 200,
  });

  sleep(1);
}
```

Trong 1 iteration có:

```text
2 HTTP requests
2 checks
1 sleep(1)
```

## 2. Header output cho biết gì?

Header:

```text
scenarios: (100.00%) 1 scenario, 4 max VUs, 8s max duration (incl. graceful stop):
         * quickpizza_ramping_vus: Up to 4 looping VUs for 6s over 3 stages (gracefulRampDown: 2s, gracefulStop: 2s)
```

Đọc ra:

```text
scenario_name = quickpizza_ramping_vus
executor = ramping-vus
startVUs = 1
target_max = 4
regular_duration = 6s
gracefulRampDown = 2s
gracefulStop = 2s
executor_wall_time_after_start_max = 8s
```

Điểm quan trọng:

```text
Up to 4 looping VUs for 6s over 3 stages
```

nghĩa là:

```text
VU thay đổi theo timeline
tối đa có thể cần 4 VU
timeline chính dài 6 giây
```

Không có nghĩa là:

```text
4 VUs chạy cố định suốt 6s
```

và cũng không có nghĩa là:

```text
có tổng iteration mục tiêu biết trước
```

## 3. Summary output đang phân tích

Lần chạy mẫu ngày 2026-05-17:

```text
checks_total.......: 24      3.543856/s
checks_succeeded...: 100.00% 24 out of 24
checks_failed......: 0.00%   0 out of 24

http_req_duration..............: avg=264.76ms min=245.36ms med=265.13ms max=304.27ms p(90)=276.55ms p(95)=278.82ms
  { expected_response:true }...: avg=264.76ms min=245.36ms med=265.13ms max=304.27ms p(90)=276.55ms p(95)=278.82ms
http_req_failed................: 0.00% 0 out of 24
http_reqs......................: 24    3.543856/s

iteration_duration.............: avg=1.71s min=1.51s med=1.54s max=2.17s p(90)=2.04s p(95)=2.1s
iterations.....................: 12    1.771928/s
vus............................: 2     min=2       max=4
vus_max........................: 4     min=4       max=4

running (6.8s), 0/4 VUs, 12 complete and 0 interrupted iterations
```

Đừng đọc nhầm:

```text
4 looping VUs trong header
  = trần planned VU của executor theo plan

running ... 0/4 VUs
  = snapshot cuối cùng khi progress in ra

iterations.........: 12    1.771928/s
  = tốc độ iteration trung bình của cả scenario
  = không phải 1 VU chạy 1.771928 iteration/s
```

Cách đọc riêng dòng này:

```text
iterations.....................: 12    1.771928/s
```

nghĩa là:

```text
toàn bộ run hoàn thành 12 iteration
và cột `/s` của Counter `iterations` đang cho biết trung bình khoảng 1.771928 iteration mỗi giây
trên `summary_runtime_base`
```

Không nên đọc nhầm thành:

```text
1 VU chạy 1.771928 iteration/s
```

vì đây là cột `/s` của Counter `iterations`, tức trung bình trên cả run, không phải rate của 1 VU.

## 4. Bóc ra các đại lượng chính

### 4.1. Đại lượng đọc trực tiếp

| Đại lượng | Giá trị | Đọc từ đâu |
| --- | --- | --- |
| `completed_iterations` | `12` | `iterations.....................: 12` |
| `iterations_rate` | `1.771928/s` | `iterations.....................: ... 1.771928/s` |
| `total_http_requests` | `24` | `http_reqs......................: 24` |
| `http_reqs_rate` | `3.543856/s` | `http_reqs......................: ... 3.543856/s` |
| `total_checks` | `24` | `checks_total.......: 24` |
| `checks_total_rate` | `3.543856/s` | `checks_total.......: ... 3.543856/s` |
| `checks_succeeded_rate` | `100%` | `checks_succeeded...: 100.00%` |
| `checks_failed_rate` | `0%` | `checks_failed......: 0.00%` |
| `http_req_failed_rate` | `0%` | `http_req_failed................: 0.00%` |
| `http_req_duration_avg` | `264.76ms` | summary |
| `http_req_duration_min` | `245.36ms` | summary |
| `http_req_duration_max` | `304.27ms` | summary |
| `iteration_duration_avg` | `1.71s` | summary |
| `iteration_duration_min` | `1.51s` | summary |
| `iteration_duration_max` | `2.17s` | summary |
| `vus` | `2 min=2 max=4` | summary |
| `vus_max` | `4 min=4 max=4` | summary |
| `interrupted_iterations` | `0` | progress cuối |

### 4.2. Đại lượng phải đọc từ code/header

| Đại lượng | Giá trị | Đọc từ đâu |
| --- | --- | --- |
| `executor` | `ramping-vus` | code/header |
| `startVUs` | `1` | code/header |
| `stage_1` | `2s -> 4` | code/header |
| `stage_2` | `2s -> 4` | code/header |
| `stage_3` | `2s -> 0` | code/header |
| `regular_duration` | `6s` | header / tổng stage duration |
| `gracefulRampDown` | `2s` | code/header |
| `gracefulStop` | `2s` | code/header |
| `executor_wall_time_after_start_max` | `8s` | `6s + 2s` / header |
| `http_requests_per_iteration` | `2` | code |
| `checks_per_iteration` | `2` | code |
| `sleep_per_iteration` | `1s` | code |

## 5. Từ output suy ra gì?

### 5.1. Tổng số iterations

Với `ramping-vus`, trước khi chạy không có:

```text
total_iterations_target
```

Sau khi chạy mới biết:

```text
completed_iterations = 12
```

Đọc từ:

```text
iterations.....................: 12
```

### 5.2. Tổng số HTTP requests

Vì code có:

```text
1 iteration = 2 HTTP requests
```

nên:

```text
total_http_requests
  = completed_iterations * http_requests_per_iteration
  = 12 * 2
  = 24
```

Khớp:

```text
http_reqs......................: 24
```

### 5.3. Tổng số checks

Vì code có:

```text
1 iteration = 2 checks
```

nên:

```text
total_checks
  = completed_iterations * checks_per_iteration
  = 12 * 2
  = 24
```

Khớp:

```text
checks_total.......: 24
```

### 5.4. Mẫu số `summary_runtime_base` của Counter summary

Với các metric Counter:

```text
rate = count / summary_runtime_base
=> summary_runtime_base = count / rate
```

Trong demo 1 scenario sạch này, `summary_runtime_base` khá gần thời gian scenario bạn đang nhìn
thấy. Nhưng phần công thức nên gọi đúng tên như vậy, không nên gọi chung là "runtime thật của
scenario".

Từ `iterations`:

```text
summary_runtime_base
  = 12 / 1.771928
  ≈ 6.7722s
```

Từ `http_reqs`:

```text
summary_runtime_base
  = 24 / 3.543856
  ≈ 6.7722s
```

Khớp progress cuối:

```text
running (6.8s)
```

Trong worked example này:

```text
summary_runtime_base gần với runtime thật của scenario
vì test chỉ có 1 scenario, startTime=0, và không có setup/teardown
```

### 5.5. Average iteration rate

```text
average_iteration_rate
  = completed_iterations / summary_runtime_base
  = 12 / 6.7722
  ≈ 1.771928 iter/s
```

Khớp:

```text
iterations.....................: 12    1.771928/s
```

### 5.6. Average HTTP request rate

```text
average_http_request_rate
  = total_http_requests / summary_runtime_base
  = 24 / 6.7722
  ≈ 3.543856 req/s
```

Khớp:

```text
http_reqs......................: 24    3.543856/s
```

### 5.7. Vì sao `1 / http_req_duration_avg` không ra `http_reqs/s`?

Summary có:

```text
http_req_duration avg = 264.76ms
```

Nếu lấy:

```text
1 / 0.26476
≈ 3.78
```

thì vẫn không bằng:

```text
http_reqs/s = 3.543856
```

Lý do:

```text
http_req_duration chỉ là thời gian của 1 request
```

Trong khi:

```text
1 iteration còn có request thứ 2
check()
sleep(1)
chờ theo closed model
số VU active còn thay đổi theo ramp timeline
```

Nên `http_reqs/s` của toàn scenario phải đọc bằng:

```text
total_http_requests / summary_runtime_base
```

không suy ra trực tiếp từ `1 / http_req_duration_avg`.

Trong run này `http_reqs = iterations * 2` vì mỗi completed iteration đều chạy đủ 2 requests. Nếu
code có nhánh điều kiện, request fail trước khi gọi request thứ hai, hoặc iteration bị interrupt,
phải đọc `http_reqs` thực tế từ summary/custom metric thay vì chỉ nhân máy móc.

### 5.8. Vì sao `iteration_duration_avg` lớn hơn nhiều `http_req_duration_avg`?

Vì:

```text
iteration_duration
  = request 1
  + request 2
  + check logic
  + sleep(1)
  + chi phí JS nhỏ khác
```

Trong run này:

```text
http_req_duration avg ≈ 0.265s
2 requests ≈ 0.53s
sleep(1) = 1.00s
```

Tổng rất gần:

```text
0.53s + 1.00s = 1.53s
```

và summary cho:

```text
iteration_duration avg = 1.71s
```

phần chênh thêm đến từ:

```text
biến thiên request
check logic
scheduling/timing overhead
```

### 5.9. `vus` và `vus_max` đọc thế nào?

Summary:

```text
vus............................: 2     min=2       max=4
vus_max........................: 4     min=4       max=4
```

Đọc là:

```text
vus:
  sample cuối còn giữ là 2
  sample nhỏ nhất đã thấy là 2
  sample lớn nhất đã thấy là 4

vus_max:
  summary sample thấy đã initialized 4 VU
  trong run local này số đó trùng với max planned VUs trong header
```

Với `ramping-vus`, `vus` rất hay lên xuống.

Nó không nên bị hiểu cứng là:

```text
luôn có 2 VU suốt bài test
```

hay:

```text
scenario kết thúc mà còn đúng 2 VU active
```

## 6. Rút gọn công thức cho bài này

```text
regular_duration = 2s + 2s + 2s = 6s

executor_wall_time_after_start_max = 6s + 2s = 8s

completed_iterations = 12

http_requests_per_iteration = 2
checks_per_iteration = 2

total_http_requests = 12 * 2 = 24
total_checks = 12 * 2 = 24

summary_runtime_base = 12 / 1.771928 ≈ 6.7722s

average_iteration_rate = 12 / 6.7722 ≈ 1.771928 iter/s

average_http_request_rate = 24 / 6.7722 ≈ 3.543856 req/s

effective_iteration_time ~= iteration_duration vì demo này không set minIterationDuration
```

## 7. Điều nên nhớ sau bài này

```text
ramping-vus không cho bạn biết tổng iteration trước khi chạy
```

```text
iterations/s và http_reqs/s trong summary là average của toàn scenario
```

```text
vì số VU thay đổi theo thời gian
peak ở từng đoạn có thể khác average của cả bài test
```

```text
muốn tính request tổng ở demo này:
http_reqs = iterations * 2
vì mỗi completed iteration chạy đủ 2 HTTP requests
```

## 8. Kết luận chốt: đọc số nào?

`ramping-vus` là closed model nhưng số VU thay đổi theo timeline.

Nên khi báo cáo 1 run:

- số chính: `iterations/s` và `http_reqs/s` của toàn scenario
- `iteration_duration avg` để nói 1 iteration thường mất bao lâu
- `med` để nói nhịp điển hình
- `p90/p95` để nhìn phần chậm, nhất là khi ramp down hoặc cuối scenario

Khi sizing:

- đừng lấy summary `iterations/s` làm peak của từng stage
- peak từng đoạn phải nhìn theo timeline / số VU active trong đoạn đó
- `iteration_duration p95` giúp bảo thủ hơn nếu run dao động

Nếu nhiều run cùng cấu hình:

- lấy `median(iterations/s)` giữa các run làm số đại diện
- run đẹp nhất chỉ nên ghi là best observed
- run xấu nhất giữ lại để xem grace/ramp-down có tạo interrupted iterations không
