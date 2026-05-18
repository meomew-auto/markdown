# Constant arrival rate QuickPizza `2 requests / iteration` worked example

File này phân tích một run cụ thể của:

```text
constant-arrival-rate
```

Khác với `constant-vus` và `ramping-vus`, ở đây:

```text
số VU không phải mục tiêu chính
rate/timeUnit mới là mục tiêu chính
```

VU chỉ là worker để k6 giữ được lịch start iteration.

## 1. File test đang phân tích

Script:

```text
examples/constant_arrival_rate_quickpizza_two_requests_demo.js
```

Command:

```powershell
rtk k6 run .\examples\constant_arrival_rate_quickpizza_two_requests_demo.js
```

Code cốt lõi:

```js
import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";

export const options = {
  scenarios: {
    quickpizza_constant_arrival_rate: {
      executor: "constant-arrival-rate",
      rate: 2,
      timeUnit: "1s",
      duration: "6s",
      preAllocatedVUs: 6,
      maxVUs: 8,
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
scenarios: (100.00%) 1 scenario, 8 max VUs, 11s max duration (incl. graceful stop):
         * quickpizza_constant_arrival_rate: 2.00 iterations/s for 6s (maxVUs: 6-8, gracefulStop: 5s)
```

Đọc ra:

```text
scenario_name = quickpizza_constant_arrival_rate
executor = constant-arrival-rate
rate = 2
timeUnit = 1s
lambda = 2 iterations/s
duration = 6s
preAllocatedVUs = 6
maxVUs = 8
gracefulStop = 5s
executor_wall_time_after_start_max = 11s
```

Dòng:

```text
2.00 iterations/s for 6s
```

nghĩa là:

```text
k6 cố start 2 iteration mỗi giây trong regular duration 6 giây
```

Không có nghĩa là:

```text
summary completed iteration rate bắt buộc phải bằng 2.00/s
```

vì summary rate tính trên runtime thực tế của các completed iterations.

## 3. Summary output đang phân tích

Lần chạy mẫu ngày 2026-05-17:

```text
checks_total.......: 26      3.459233/s
checks_succeeded...: 100.00% 26 out of 26
checks_failed......: 0.00%   0 out of 26

✓ home status is 200
✓ quotes status is 200

http_req_duration..............: avg=260.53ms min=256.27ms med=258.23ms max=266.39ms p(90)=265.38ms p(95)=265.7ms
http_req_failed................: 0.00% 0 out of 26
http_reqs......................: 26    3.459233/s

iteration_duration.............: avg=1.76s    min=1.51s    med=1.52s    max=2.09s    p(90)=2.05s    p(95)=2.07s
iterations.....................: 13    1.729617/s
vus............................: 2     min=2       max=4
vus_max........................: 6     min=6       max=6

running (07.5s), 0/6 VUs, 13 complete and 0 interrupted iterations
```

Không có dòng:

```text
dropped_iterations
```

Nên trong run này xem như:

```text
dropped_iterations = 0
```

## 4. Bóc ra các đại lượng chính

### 4.1. Đại lượng đọc trực tiếp

| Đại lượng | Giá trị | Đọc từ đâu |
| --- | --- | --- |
| `completed_iterations` | `13` | `iterations.....................: 13` |
| `iterations_rate` | `1.729617/s` | `iterations.....................: ... 1.729617/s` |
| `total_http_requests` | `26` | `http_reqs......................: 26` |
| `http_reqs_rate` | `3.459233/s` | `http_reqs......................: ... 3.459233/s` |
| `total_checks` | `26` | `checks_total.......: 26` |
| `checks_total_rate` | `3.459233/s` | `checks_total.......: ... 3.459233/s` |
| `checks_succeeded_rate` | `100%` | `checks_succeeded...: 100.00%` |
| `checks_failed_rate` | `0%` | `checks_failed......: 0.00%` |
| `http_req_failed_rate` | `0%` | `http_req_failed................: 0.00%` |
| `http_req_duration_avg` | `260.53ms` | summary |
| `iteration_duration_avg` | `1.76s` | summary |
| `iteration_duration_min` | `1.51s` | summary |
| `iteration_duration_max` | `2.09s` | summary |
| `vus` | `2 min=2 max=4` | summary |
| `vus_max` | `6 min=6 max=6` | summary |
| `dropped_iterations` | `0` | không có dòng metric này |
| `interrupted_iterations` | `0` | progress cuối |

### 4.2. Đại lượng phải đọc từ code/header

| Đại lượng | Giá trị | Đọc từ đâu |
| --- | --- | --- |
| `executor` | `constant-arrival-rate` | code/header |
| `rate` | `2` | code/header |
| `timeUnit` | `1s` | code/header |
| `lambda` | `2 iterations/s` | `rate / timeUnit` |
| `ticker_period` | `0.5s` | `1 / lambda` |
| `regular_duration` | `6s` | code/header |
| `preAllocatedVUs` | `6` | code/header |
| `maxVUs` | `8` | code/header |
| `gracefulStop` | `5s` | code/header |
| `executor_wall_time_after_start_max` | `11s` | `duration + gracefulStop` |
| `http_requests_per_iteration` | `2` | code |
| `checks_per_iteration` | `2` | code |
| `sleep_per_iteration` | `1s` | code |

## 5. Từ output suy ra gì?

### 5.1. Tổng số iterations

Metric:

```text
iterations.....................: 13    1.729617/s
```

Cho biết:

```text
completed_iterations = 13
```

Đây là số iteration đã chạy xong đầy đủ. Nó không bao gồm iteration bị interrupted.

### 5.2. Tổng số HTTP requests

Code có 2 HTTP request mỗi iteration:

```js
const home = http.get("https://quickpizza.grafana.com/");
const quotes = http.get("https://quickpizza.grafana.com/api/quotes");
```

Nên:

```text
expected_http_requests = completed_iterations * http_requests_per_iteration
                       = 13 * 2
                       = 26
```

Output:

```text
http_reqs......................: 26    3.459233/s
```

Khớp.

### 5.3. Tổng số checks

Code có 2 check mỗi iteration:

```js
check(home, { "home status is 200": ... });
check(quotes, { "quotes status is 200": ... });
```

Nên:

```text
expected_checks = completed_iterations * checks_per_iteration
                = 13 * 2
                = 26
```

Output:

```text
checks_total.......: 26      3.459233/s
```

Khớp.

### 5.4. Runtime thật của scenario

Từ summary:

```text
iterations = 13
iterations_rate = 1.729617/s
```

Suy ra runtime mà k6 dùng để tính rate:

```text
actual_runtime ~= completed_iterations / iterations_rate
               ~= 13 / 1.729617
               ~= 7.52s
```

Progress cuối cũng ghi:

```text
running (07.5s), 0/6 VUs, 13 complete and 0 interrupted iterations
```

Khớp.

Tại sao runtime thật lớn hơn `duration = 6s`?

```text
duration chỉ là thời gian schedule mốc start mới
iteration đã start gần cuối vẫn được finish trong gracefulStop
```

### 5.5. Có nên so sánh target 2.00/s với summary 1.729617/s không?

Header:

```text
2.00 iterations/s for 6s
```

là target start rate trong 6 giây regular duration.

Summary:

```text
iterations.....................: 13    1.729617/s
```

là completed iteration rate trên runtime thực tế khoảng 7.52 giây.

Hai con số này không cùng loại metric:

```text
target_start_rate = 2.00/s trong schedule window
observed_completed_rate = 13 / 7.52s = 1.729617/s
```

Vì vậy không dùng `1.729617/s < 2.00/s` để kết luận k6 không đạt target start rate. Muốn kiểm tra
arrival-rate có giữ được lịch start không, nhìn các dấu hiệu này:

```text
dropped_iterations có tăng không?
interrupted_iterations có tăng không?
log iterInScenario có cho thấy các iteration được start theo mốc không?
preAllocatedVUs/maxVUs có đủ worker không?
```

Trong run này:

```text
completed_iterations = 13
dropped_iterations = 0
interrupted_iterations = 0
iterInScenario = 0..12
```

nên cách đọc đúng là: schedule start chạy ổn, còn `1.729617/s` chỉ thấp hơn vì rate summary chia
theo runtime thực tế kéo dài tới lúc iteration cuối finish.

### 5.6. Mốc start scheduled trong run này

Trong bài này, `slot` nghĩa là:

```text
một mốc start iteration theo lịch của arrival-rate executor
```

Nó không phải VU hay queue; chỉ là thời điểm scheduler muốn start một iteration mới.

Quan sát từ log console có `iterInScenario` từ `0` đến `12`:

```text
iterInScenario=0
iterInScenario=1
...
iterInScenario=12
```

Tức là có 13 iteration đã được start.

Vì:

```text
completed_iterations = 13
interrupted_iterations = 0
dropped_iterations = 0
```

nên:

```text
observed_scheduled_slots ~= 13 + 0 + 0 = 13
```

Không cần ép về đúng `2 * 6 = 12` trong run ngắn này. Khi phân tích output thật, ưu tiên số metric và log thực tế.

## 6. Sizing VU cho bài này

Target:

```text
lambda = 2 iterations/s
```

Effective busy time trung bình của 1 VU:

```text
W_effective ~= iteration_duration_avg
            ~= 1.76s
```

Demo này không set `minIterationDuration`, nên `W_effective` gần bằng `iteration_duration_avg`.
Nếu có `minIterationDuration`, core emit `iteration_duration` trước phần sleep bù, nhưng VU vẫn bị
giữ tới hết phần bù đó. Khi sizing phải dùng:

```text
W_effective ~= max(iteration_duration_avg, minIterationDuration)
```

`1.76s` ở đây là:

```text
seconds/iteration
```

không phải:

```text
iterations/s
```

Tức là 1 VU chạy xong 1 iteration trung bình mất 1.76 giây. Nếu muốn đổi sang năng suất của
1 VU:

```text
per_vu_capacity ~= 1 / 1.76
                ~= 0.568 iteration/s cho 1 VU
```

Nên nếu có 4 VU active:

```text
pool_capacity ~= 4 / 1.76
              ~= 2.27 iterations/s
```

Con số này mới đem so với target `lambda = 2 iterations/s`.

VU cần gần đúng:

```text
required_vus_min ~= ceil(lambda * W_effective)
                 = ceil(2 * 1.76)
                 = ceil(3.52)
                 = 4 VUs
```

Summary:

```text
vus............................: 2     min=2       max=4
vus_max........................: 6     min=6       max=6
```

Đọc là:

```text
run này có lúc cần tới 4 active VUs
k6 đã preallocate 6 VUs
không cần tạo unplanned VU
không có dropped_iterations
```

Nếu chỉ set:

```js
preAllocatedVUs: 2,
maxVUs: 2,
```

thì capacity gần đúng:

```text
capacity_with_2_vus ~= 2 / 1.76
                    ~= 1.14 iterations/s
```

nhỏ hơn target `2 iterations/s`, rất dễ có `dropped_iterations`.

## 7. HTTP request rate trong bài này

Vì 1 iteration có 2 HTTP requests:

```text
estimated_http_req_rate_if_no_drop ~= lambda * http_requests_per_iteration
                                   ~= 2 * 2
                                   ~= 4 HTTP requests/s trong regular duration
```

Đây là ước lượng từ lịch start iteration, không phải một scheduler riêng cho từng HTTP request. Nó
giả định không có drop/interrupt và iteration nào cũng chạy đủ 2 request.

Output:

```text
http_reqs......................: 26    3.459233/s
```

Rate này thấp hơn 4/s vì cũng được tính trên runtime thực tế khoảng 7.52s:

```text
26 / 7.52s ~= 3.46/s
```

Điểm cần nhớ:

```text
constant-arrival-rate điều khiển start iteration
không trực tiếp điều khiển từng request bên trong iteration
```

## 8. Vì sao không dùng `http_req_duration` để ước lượng VU?

Nếu lấy riêng:

```text
http_req_duration_avg = 260.53ms
```

rồi tính:

```text
ceil(2 * 0.26053) = 1 VU
```

thì sai thực tế.

Lý do là 1 iteration gồm:

```text
HTTP request home
HTTP request quotes
2 checks
console log
sleep(1)
```

Metric đúng hơn để ước lượng worker là:

```text
W_effective ~= iteration_duration_avg = 1.76s trong demo không có minIterationDuration
```

Vì VU chỉ rảnh nhận mốc start mới sau khi toàn bộ function `default` chạy xong.

Nói cách khác:

```text
arrival-rate cần VU rảnh theo mốc start iteration
VU chỉ rảnh sau cả iteration, không phải sau từng HTTP request
```

## 9. Rút gọn công thức cho bài này

```text
lambda = rate / timeUnit_seconds
       = 2 / 1
       = 2 iterations/s
```

```text
ticker_period = 1 / lambda
              = 1 / 2
              = 0.5s
```

```text
executor_wall_time_after_start_max = duration + gracefulStop
                                   = 6s + 5s
                                   = 11s
```

```text
required_vus_min ~= ceil(lambda * W_effective)
                 ~= ceil(2 * 1.76)
                 = 4 VUs
```

```text
total_http_requests = completed_iterations * 2
                    = 13 * 2
                    = 26
```

```text
total_checks = completed_iterations * 2
             = 13 * 2
             = 26
```

```text
actual_runtime ~= completed_iterations / iterations_rate
               ~= 13 / 1.729617
               ~= 7.52s
```

## 10. Điều nên nhớ sau bài này

- `rate/timeUnit` là target start iteration, không phải số VU.
- `preAllocatedVUs` là số worker chuẩn bị sẵn, không phải số user mục tiêu.
- Ước lượng VU dùng thời gian VU bị bận cho cả iteration, không dùng riêng `http_req_duration`.
- Nếu không có `minIterationDuration`, thời gian VU bị bận gần bằng `iteration_duration`; nếu có thì dùng `max(iteration_duration, minIterationDuration)`.
- `dropped_iterations` là mốc start chưa được chạy vì thiếu VU rảnh.
- `interrupted iterations` là iteration đã start nhưng bị cancel.
- Không so sánh trực tiếp summary completed rate với target start rate để kết luận đạt/không đạt lịch start.
- Summary completed rate có thể thấp hơn target start rate vì summary tính trên runtime thực tế, bao gồm thời gian iteration cuối finish trong `gracefulStop`.
