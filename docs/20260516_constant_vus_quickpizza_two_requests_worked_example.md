# Constant VUs QuickPizza `2 requests / iteration` worked example

File này phân tích một run cụ thể của:

```text
constant-vus
```

Khác với `per-vu-iterations` và `shared-iterations`, ở đây:

```text
không có tổng iteration mục tiêu
```

Scenario chạy theo:

```text
vus + duration
```

## 1. File test đang phân tích

Script:

```text
examples/constant_vus_quickpizza_two_requests_demo.js
```

Command:

```powershell
rtk k6 run .\examples\constant_vus_quickpizza_two_requests_demo.js
```

Code cốt lõi:

```js
import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";

export const options = {
  scenarios: {
    quickpizza_constant_vus: {
      executor: "constant-vus",
      vus: 4,
      duration: "5s",
      gracefulStop: "5s",
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
scenarios: (100.00%) 1 scenario, 4 max VUs, 10s max duration (incl. graceful stop):
         * quickpizza_constant_vus: 4 looping VUs for 5s (gracefulStop: 5s)
```

Đọc ra:

```text
scenario_name = quickpizza_constant_vus
executor = constant-vus
vus = 4
duration = 5s
gracefulStop = 5s
executor_wall_time_after_start = 10s
```

Điểm quan trọng:

```text
4 looping VUs for 5s
```

nghĩa là:

```text
4 VU chạy loop trong 5s
```

Không có nghĩa là:

```text
4 VU * 5 iterations
```

`10s max duration (incl. graceful stop)` là:

```text
duration + gracefulStop = 5s + 5s = 10s
```

Đây là trần wall-clock tối đa của scenario, không phải field `maxDuration` trong config.

## 3. Summary output đang phân tích

Lần chạy mẫu ngày 2026-05-16:

```text
checks_total.......: 24      4.667445/s
checks_succeeded...: 100.00% 24 out of 24
checks_failed......: 0.00%   0 out of 24

http_req_duration..............: avg=261.43ms min=259.74ms med=260.93ms max=264.65ms p(90)=263.46ms p(95)=263.84ms
  { expected_response:true }...: avg=261.43ms min=259.74ms med=260.93ms max=264.65ms p(90)=263.46ms p(95)=263.84ms
http_req_failed................: 0.00% 0 out of 24
http_reqs......................: 24    4.667445/s

iteration_duration.............: avg=1.7s min=1.52s med=1.52s max=2.07s p(90)=2.06s p(95)=2.06s
iterations.....................: 12    2.333723/s
vus............................: 4     min=4       max=4
vus_max........................: 4     min=4       max=4

running (05.1s), 0/4 VUs, 12 complete and 0 interrupted iterations
```

Cách đọc riêng dòng này:

```text
iterations.....................: 12    2.333723/s
```

nghĩa là:

```text
toàn bộ run hoàn thành 12 iteration
và cột `/s` của Counter đang cho biết trung bình khoảng 2.333723 iteration mỗi giây trên cả run
```

Không nên đọc nhầm thành:

```text
1 VU chạy 2.333723 iteration/s
```

vì đây là rate toàn scenario.

## 4. Bóc ra các đại lượng chính

### 4.1. Đại lượng đọc trực tiếp

| Đại lượng | Giá trị | Đọc từ đâu |
| --- | --- | --- |
| `completed_iterations` | `12` | `iterations.....................: 12` |
| `iterations_rate` | `2.333723/s` | `iterations.....................: ... 2.333723/s` |
| `total_http_requests` | `24` | `http_reqs......................: 24` |
| `http_reqs_rate` | `4.667445/s` | `http_reqs......................: ... 4.667445/s` |
| `total_checks` | `24` | `checks_total.......: 24` |
| `checks_total_rate` | `4.667445/s` | `checks_total.......: ... 4.667445/s` |
| `checks_succeeded_rate` | `100%` | `checks_succeeded...: 100.00%` |
| `checks_failed_rate` | `0%` | `checks_failed......: 0.00%` |
| `http_req_failed_rate` | `0%` | `http_req_failed................: 0.00%` |
| `http_req_duration_avg` | `261.43ms` | summary |
| `http_req_duration_min` | `259.74ms` | summary |
| `http_req_duration_max` | `264.65ms` | summary |
| `iteration_duration_avg` | `1.7s` | summary |
| `iteration_duration_min` | `1.52s` | summary |
| `iteration_duration_max` | `2.07s` | summary |
| `vus` | `4 min=4 max=4` | summary |
| `vus_max` | `4 min=4 max=4` | summary |
| `interrupted_iterations` | `0` | progress cuối |

### 4.2. Đại lượng phải đọc từ code/header

| Đại lượng | Giá trị | Đọc từ đâu |
| --- | --- | --- |
| `executor` | `constant-vus` | code/header |
| `vus_config` | `4` | code/header |
| `effective_vus` | `4` | local run, không execution segment |
| `startTime` | `0s` | không khai báo nên default |
| `duration` | `5s` | code/header |
| `gracefulStop` | `5s` | code/header |
| `executor_wall_time_after_start` | `10s` | `duration + gracefulStop` / header |
| `scenario_end_from_test_start` | `10s` | `startTime + duration + gracefulStop` |
| `http_requests_per_iteration` | `2` | code |
| `checks_per_iteration` | `2` | code |
| `sleep_per_iteration` | `1s` | code |
| `total_iterations_target` | không có | đặc điểm của `constant-vus` |

## 5. Từ output suy ra gì?

### 5.1. Tổng số iterations

Với `constant-vus`, trước khi chạy không có:

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

Ghi chú:

```text
checks_total không phải Counter builtin.
```

Nó là dòng summary helper dựng từ metric `checks` kiểu `Rate`, nhưng rate của dòng
`checks_total` vẫn đọc được theo:

```text
checks_total_rate = total_checks / summary_runtime_base
```

### 5.4. Mẫu số thời gian mà Counter summary đang dùng

Với Counter:

```text
rate = count / summary_runtime_base
summary_runtime_base = count / rate
```

Từ `iterations`:

```text
summary_runtime_base
  = 12 / 2.333723
  = 5.142s
```

Từ `http_reqs`:

```text
summary_runtime_base
  = 24 / 4.667445
  = 5.142s
```

Từ `checks_total`:

```text
summary_runtime_base
  = 24 / 4.667445
  = 5.142s
```

Khớp với:

```text
running (05.1s)
```

Trong demo sạch này, `summary_runtime_base` lớn hơn `duration=5s` một chút vì còn overhead và
iteration cuối hoàn tất sát sau regular duration. Nói đời thường thì nó cũng gần runtime thật mà
ta đang nhìn thấy, nhưng khi giải thích công thức vẫn nên giữ tên đúng là `summary_runtime_base`.

## 6. Từ `summary_runtime_base` suy ra rate

Lấy:

```text
summary_runtime_base ~= 5.142s
```

thì:

```text
iterations_rate
  = completed_iterations / summary_runtime_base
  = 12 / 5.142
  = 2.333723 iter/s
```

Đây là:

```text
average_iteration_rate của toàn scenario
```

Không lấy:

```text
iterations_rate * vus
```

vì `iterations_rate` đã là rate toàn scenario, không phải rate của 1 VU.

Với HTTP:

```text
http_reqs_rate
  = total_http_requests / summary_runtime_base
  = 24 / 5.142
  = 4.667445 req/s
```

Với checks:

```text
checks_total_rate
  = total_checks / summary_runtime_base
  = 24 / 5.142
  = 4.667445 checks/s
```

Vì:

```text
1 iteration = 2 HTTP requests + 2 checks
```

nên:

```text
estimated_http_reqs_rate = 2 * iterations/s
estimated_checks_total_rate = 2 * iterations/s
```

Công thức này đúng trong run sạch này vì mọi completed iteration đều chạy đủ 2 requests và 2
checks. Nếu code có branch/error/interrupt làm thiếu request hoặc thiếu check, phải đọc số
`http_reqs`/`checks` thực tế từ summary hoặc custom metric.

Kiểm tra:

```text
2 * 2.333723
= 4.667446
```

Khớp:

```text
http_reqs..........: 4.667445/s
checks_total.......: 4.667445/s
```

## 7. Một VU trong 1 giây chạy được bao nhiêu iteration?

Với `constant-vus`, có thể ước lượng bằng:

```text
per_vu_rate ~= 1 / W
```

Trong đó:

```text
W_effective = effective_iteration_time_avg
            = thời gian trung bình 1 iteration chiếm 1 VU
```

Nếu không có `minIterationDuration`, thường dùng gần đúng:

```text
W_effective ~= iteration_duration.avg
```

Nếu có `minIterationDuration`, core emit `iteration_duration` trước phần sleep bù, nhưng VU vẫn bị
giữ tới hết phần bù. Khi đó dùng:

```text
W_effective ~= max(iteration_duration.avg, minIterationDuration)
```

Từ output:

```text
iteration_duration.avg = 1.7s
```

Suy ra:

```text
per_vu_rate_avg
  ~= 1 / W_effective
  ~= 1 / 1.7
  ~= 0.588 iter/s/VU
```

Với 4 VUs:

```text
estimated_total_rate_from_avg
  ~= vus * per_vu_rate_avg
  ~= 4 * 0.588
  ~= 2.35 iter/s
```

So với summary:

```text
iterations.....................: 12    2.333723/s
```

Gần khớp.

## 8. Tại sao không dùng `http_req_duration` để tính iterations/s?

Output:

```text
http_req_duration.avg = 261.43ms
iteration_duration.avg = 1.7s
```

`http_req_duration.avg` là:

```text
thời gian trung bình của 1 HTTP request
```

Nhưng 1 iteration trong file này gồm:

```text
GET /
GET /api/quotes
check home
check quotes
sleep(1)
JS overhead
```

Nên thời gian VU bị bận cho cả iteration mới là đại lượng gần đúng để tính tốc độ loop của VU.
Trong demo này không có `minIterationDuration`, nên thời gian VU bị bận gần bằng
`iteration_duration.avg`.

Không lấy:

```text
1 / http_req_duration.avg
```

để suy ra `iterations/s`.

Muốn ước lượng capacity của 1 VU, dùng:

```text
1 / effective_iteration_time_avg
```

Trong demo này:

```text
effective_iteration_time_avg ~= iteration_duration.avg
```

Còn `iterations/s` trung bình của toàn scenario thì đọc trực tiếp từ Counter:

```text
iterations.....................: 12    2.333723/s
```

## 9. Ước lượng số iteration trước khi chạy

Với `constant-vus`, trước khi chạy chỉ ước lượng được nếu biết gần đúng `W`.

Ở file này:

```text
W_effective = effective_iteration_time_avg
            = thời gian trung bình 1 iteration chiếm 1 VU
```

Với QuickPizza demo này, mình lấy gần đúng:

```text
W_effective ~= iteration_duration.avg
            ~= 1.7s
```

Từ output đã chạy:

```text
W_effective ~= 1.7s
vus = 4
duration = 5s
gracefulStop = 5s
```

Mỗi VU có thể start khoảng:

```text
ceil(duration / W_effective)
  = ceil(5 / 1.7)
  = ceil(2.94)
  = 3 iterations
```

Tổng:

```text
completed_iterations_approx
  ~= vus * ceil(duration / W_effective)
  ~= 4 * 3
  = 12
```

Khớp:

```text
iterations.....................: 12
```

Vì `gracefulStop=5s` đủ dài, các iteration cuối start trước khi hết `duration` vẫn finish được.

Nếu `gracefulStop` quá ngắn, một số iteration cuối có thể bị interrupted, khi đó completed thấp hơn ước lượng.

## 10. TPS, throughput, RPS trong ví dụ này

Trong k6:

```text
iterations/s
  = iteration throughput

http_reqs/s
  = HTTP request throughput / RPS
```

Trong ví dụ này:

```text
iterations/s = 2.333723 iter/s
http_reqs/s = 4.667445 req/s
```

Nếu định nghĩa:

```text
1 iteration = 1 business transaction
```

thì:

```text
TPS ~= iterations/s = 2.333723 TPS
```

Nhưng nếu định nghĩa transaction là:

```text
1 HTTP request = 1 transaction
```

thì:

```text
TPS ~= http_reqs/s = 4.667445 TPS
```

Vì vậy khi nói TPS phải nói rõ:

```text
transaction là cả flow iteration
hay từng HTTP request
```

## 11. Tổng kết số liệu

Từ output có thể suy ra:

```text
executor = constant-vus
vus = 4
duration = 5s
gracefulStop = 5s
executor_wall_time_after_start = 10s

completed_iterations = 12
interrupted_iterations = 0

http_requests_per_iteration = 2
checks_per_iteration = 2

total_http_requests = 12 * 2 = 24
total_checks = 12 * 2 = 24

actual_scenario_runtime
  = 12 / 2.333723
  = 5.142s

average_iteration_rate
  = 12 / 5.142
  = 2.333723 iter/s

average_http_request_rate
  = 24 / 5.142
  = 4.667445 req/s

per_vu_rate_avg
  ~= 1 / W_effective
  ~= 1 / 1.7
  ~= 0.588 iter/s/VU

estimated_total_iteration_rate
  ~= 4 * 0.588
  ~= 2.35 iter/s
```

Điểm cần nhớ:

```text
constant-vus không biết trước tổng iteration.
Tổng iteration là kết quả của: vus, duration, iteration_duration, gracefulStop.
```
