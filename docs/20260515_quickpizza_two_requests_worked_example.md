# QuickPizza `2 requests / iteration` worked example

File này chỉ tập trung vào một ví dụ:

- executor: `per-vu-iterations`
- target: `https://quickpizza.grafana.com/`
- mỗi iteration gọi `2` HTTP requests

Mục tiêu:

```text
nhìn một output k6
=> suy ra được những đại lượng gì
=> công thức tính từng đại lượng là gì
=> cái gì đọc từ metric, cái gì phải đọc từ code/header
```

## 1. File test đang phân tích

Script:

```text
examples/per_vu_iterations_quickpizza_two_requests_demo.js
```

Command:

```bash
k6 run examples/per_vu_iterations_quickpizza_two_requests_demo.js
```

Code cốt lõi:

```js
const TARGET_URL = "https://quickpizza.grafana.com/";
const VUS = 4;
const ITERATIONS_PER_VU = 3;

export const options = {
    scenarios: {
        quickpizza_two_requests_per_vu: {
            executor: "per-vu-iterations",
            vus: VUS,
            iterations: ITERATIONS_PER_VU,
            maxDuration: "30s",
            gracefulStop: "5s",
        },
    },
};

export default function () {
    const res1 = http.get(TARGET_URL);
    const res2 = http.get(TARGET_URL);

    check(res1, { "request 1 status is 200": (r) => r.status === 200 });
    check(res2, { "request 2 status is 200": (r) => r.status === 200 });

    sleep(1);
}
```

## 2. Header output cho biết gì?

Header:

```text
scenarios: (100.00%) 1 scenario, 4 max VUs, 35s max duration (incl. graceful stop):
         * quickpizza_two_requests_per_vu: 3 iterations for each of 4 VUs (maxDuration: 30s, gracefulStop: 5s)
```

Từ đây đọc được:

```text
scenario_name = quickpizza_two_requests_per_vu
executor = per-vu-iterations
vus = 4
iterations_per_vu = 3
maxDuration = 30s
gracefulStop = 5s
scenario_max_end = 35s
```

## 3. Summary output đang phân tích

Lần chạy mẫu ngày 2026-05-15:

```text
checks_total.......: 24      4.510616/s
checks_succeeded...: 100.00% 24 out of 24
checks_failed......: 0.00%   0 out of 24

http_req_duration..: avg=260.76ms min=258.73ms med=260.77ms max=262.43ms
http_req_failed....: 0.00%   0 out of 24
http_reqs..........: 24      4.510616/s

iteration_duration.: avg=1.77s min=1.52s med=1.52s max=2.27s p(90)=2.27s p(95)=2.27s
iterations.........: 12      2.255308/s
vus................: 4       min=4       max=4
vus_max............: 4       min=4       max=4

running (05.3s), 0/4 VUs, 12 complete and 0 interrupted iterations
```

## 4. Bóc ra các đại lượng chính

### 4.1. Đại lượng đọc trực tiếp

| Đại lượng                | Giá trị         | Đọc từ đâu                            |
| ------------------------ | --------------- | ------------------------------------- |
| `completed_iterations`   | `12`            | `iterations.........: 12`             |
| `iterations_rate`        | `2.255308/s`    | `iterations.........: ... 2.255308/s` |
| `total_http_requests`    | `24`            | `http_reqs..........: 24`             |
| `http_reqs_rate`         | `4.510616/s`    | `http_reqs..........: ... 4.510616/s` |
| `total_checks`           | `24`            | `checks_total.......: 24`             |
| `checks_total_rate`      | `4.510616/s`    | `checks_total.......: ... 4.510616/s` |
| `successful_checks`      | `24`            | `checks_succeeded...: 24 out of 24`   |
| `failed_checks`          | `0`             | `checks_failed......: 0 out of 24`    |
| `checks_succeeded_rate`  | `100%`          | `checks_succeeded...: 100.00%`        |
| `checks_failed_rate`     | `0%`            | `checks_failed......: 0.00%`          |
| `http_req_duration_avg`  | `260.76ms`      | summary                               |
| `http_req_duration_min`  | `258.73ms`      | summary                               |
| `http_req_duration_med`  | `260.77ms`      | summary                               |
| `http_req_duration_max`  | `262.43ms`      | summary                               |
| `iteration_duration_avg` | `1.77s`         | summary                               |
| `iteration_duration_min` | `1.52s`         | summary                               |
| `iteration_duration_med` | `1.52s`         | summary                               |
| `iteration_duration_max` | `2.27s`         | summary                               |
| `iteration_duration_p90` | `2.27s`         | summary                               |
| `iteration_duration_p95` | `2.27s`         | summary                               |
| `failed_http_requests`   | `0`             | `http_req_failed....: 0 out of 24`    |
| `http_req_failed_rate`   | `0%`            | `http_req_failed....: 0.00%`          |
| `vus`                    | `4 min=4 max=4` | summary                               |
| `vus_max`                | `4 min=4 max=4` | summary                               |

### 4.2. Đại lượng phải đọc từ code/header

| Đại lượng                     | Giá trị                           | Đọc từ đâu  |
| ----------------------------- | --------------------------------- | ----------- |
| `TARGET_URL`                  | `https://quickpizza.grafana.com/` | code        |
| `executor`                    | `per-vu-iterations`               | code/header |
| `vus` config                  | `4`                               | code/header |
| `iterations_per_vu`           | `3`                               | code/header |
| `maxDuration`                 | `30s`                             | code/header |
| `gracefulStop`                | `5s`                              | code/header |
| `http_requests_per_iteration` | `2`                               | code        |
| `checks_per_iteration`        | `2`                               | code        |
| `sleep_per_iteration`         | `1s`                              | code        |

## 5. Từ output suy ra gì?

### 5.1. Tổng số iterations

```text
total_iterations = vus * iterations_per_vu
                 = 4 * 3
                 = 12
```

Khớp với:

```text
iterations.........: 12
```

### 5.2. Tổng số HTTP requests

Vì code cố định:

```text
1 iteration = 2 HTTP requests
```

nên:

```text
total_http_requests
  = total_iterations * http_requests_per_iteration
  = 12 * 2
  = 24
```

Khớp với:

```text
http_reqs..........: 24
```

### 5.3. Tổng số checks

Vì code cố định:

```text
1 iteration = 2 checks
```

nên:

```text
total_checks
  = total_iterations * checks_per_iteration
  = 12 * 2
  = 24
```

Khớp với:

```text
checks_total.......: 24
```

Ghi chú rất quan trọng:

```text
checks_total không phải Counter builtin giống http_reqs hay iterations.
```

Trong core:

- metric `checks` là loại `Rate`
- summary tự dựng thêm `checks_total` để dễ đọc
- `checks_total` lấy từ số `Total` bên trong `checks`
- rồi tính `checks_total_rate = total_checks / runtime`

Vì vậy:

```text
checks_total_rate có công thức giống Counter-rate
nhưng nguồn gốc metric gốc là Rate, không phải Counter builtin
```

### 5.4. Runtime thật của scenario

Với các metric `Counter`:

```text
rate = count / actual_scenario_runtime
=> actual_scenario_runtime = count / rate
```

Ghi chú nguồn gốc từ core:

```text
Đây không phải công thức mình tự bịa.
```

Trong core k6:

- `iterations` và `http_reqs` đều là metric kiểu `Counter`
- summary của `Counter` tính `rate = count / duration`

Tên `actual_scenario_runtime` trong file này là cách mình gọi lại chính cái `duration` đó cho dễ học.
Trong code summary, nó được truyền như `testRunDuration`.

Từ `iterations`:

```text
actual_scenario_runtime
  = 12 / 2.255308
  ≈ 5.3208s
```

Từ `http_reqs`:

```text
actual_scenario_runtime
  = 24 / 4.510616
  ≈ 5.3208s
```

Từ `checks_total` cũng ra cùng runtime:

```text
actual_scenario_runtime
  = 24 / 4.510616
  ≈ 5.3208s
```

Nhưng nhớ là đây là:

```text
summary helper rate của checks_total
```

chứ không phải `checks_total` là Counter builtin.

Khớp với progress line bị làm tròn:

```text
running (05.3s)
```

## 6. Từ runtime suy ra rate như thế nào?

Lấy:

```text
actual_scenario_runtime ≈ 5.3208s
```

thì:

```text
iterations_rate
  = completed_iterations / runtime
  = 12 / 5.3208
  ≈ 2.255308 iter/s

http_reqs_rate
  = total_http_requests / runtime
  = 24 / 5.3208
  ≈ 4.510616 req/s

checks_total_rate
  = total_checks / runtime
  = 24 / 5.3208
  ≈ 4.510616 /s
```

### Kết luận quan trọng

Trong run này:

```text
estimated_http_reqs_rate = 2 * iterations/s
estimated_checks_total_rate = 2 * iterations/s
```

Công thức này đúng cho run sạch này vì mỗi completed iteration đều chạy đủ 2 HTTP requests và 2
checks. Nếu code có nhánh điều kiện, request fail trước khi gọi request thứ hai, hoặc iteration bị
interrupt, phải đọc `http_reqs`/`checks` thực tế từ summary hoặc custom metric, không chỉ nhân máy
móc.

vì:

```text
1 iteration = 2 HTTP requests + 2 checks
```

Kiểm tra:

```text
2 * 2.255308
= 4.510616
```

## 6.1. Công thức pass/fail của `http_req_failed` và `checks`

### `http_req_failed`

`http_req_failed` là metric kiểu `Rate`.

Công thức:

```text
http_req_failed_rate
  = failed_http_requests / total_http_requests
```

Với run này:

```text
failed_http_requests = 0
total_http_requests = 24

http_req_failed_rate
  = 0 / 24
  = 0%
```

Khớp:

```text
http_req_failed....: 0.00%   0 out of 24
```

### `checks_succeeded` và `checks_failed`

Summary text tách `checks` thành:

- `checks_total`
- `checks_succeeded`
- `checks_failed`

Ta có:

```text
successful_checks = 24
failed_checks = 0
total_checks = 24
```

Công thức:

```text
checks_succeeded_rate
  = successful_checks / total_checks
  = 24 / 24
  = 100%

checks_failed_rate
  = failed_checks / total_checks
  = 0 / 24
  = 0%
```

Khớp:

```text
checks_succeeded...: 100.00% 24 out of 24
checks_failed......: 0.00%   0 out of 24
```

## 7. 1 VU trong 1 giây chạy được bao nhiêu iteration?

Lấy `iteration_duration`:

```text
iteration_duration avg = 1.77s
iteration_duration min = 1.52s
```

Trong demo này không set `minIterationDuration`, nên có thể lấy gần đúng:

```text
effective_iteration_time ~= iteration_duration
```

Nếu có `minIterationDuration`, phải dùng:

```text
effective_iteration_time ~= max(iteration_duration, minIterationDuration)
```

Suy ra tốc độ của 1 VU:

```text
per_vu_rate_avg
  ≈ 1 / 1.77
  ≈ 0.565 iter/s

per_vu_rate_fast
  ≈ 1 / 1.52
  ≈ 0.658 iter/s
```

Nếu nhân với `4 VU`:

```text
estimated_total_rate_from_avg
  ≈ 4 * 0.565
  ≈ 2.26 iter/s
```

Khá sát với:

```text
iterations/s = 2.255308/s
```

## 8. `Trend`: `http_req_duration` và `iteration_duration` đọc theo công thức nào?

Hai metric này là metric kiểu `Trend`.

Summary `Trend` thường in:

```text
avg
min
med
max
p(90)
p(95)
```

Phải nhớ:

```text
sample ở đây không phải "mỗi 1 giây lấy 1 mẫu"
```

Mà là:

```text
http_req_duration:
  mỗi HTTP request hoàn thành -> 1 sample duration

iteration_duration:
  mỗi iteration hoàn thành -> 1 sample duration
```

Cách đọc rõ hơn:

```text
avg
  = average / trung bình cộng
  = tổng duration của các sample / số sample

min
  = minimum / nhỏ nhất
  = sample nhanh nhất

med
  = median / p(50)
  = khoảng 50% sample nhanh hơn hoặc bằng số này

max
  = maximum / lớn nhất
  = sample chậm nhất

p(90)
  = percentile 90
  = khoảng 90% sample nhanh hơn hoặc bằng số này
  = khoảng 10% sample còn lại chậm hơn số này

p(95)
  = percentile 95
  = khoảng 95% sample nhanh hơn hoặc bằng số này
  = khoảng 5% sample còn lại chậm hơn số này
```

Áp vào output:

```text
http_req_duration
  avg = 260.76ms
  min = 258.73ms
  med = 260.77ms
  max = 262.43ms

iteration_duration
  avg = 1.77s
  min = 1.52s
  med = 1.52s
  max = 2.27s
  p(90) = 2.27s
  p(95) = 2.27s
```

Đọc thành câu:

```text
http_req_duration avg=260.76ms
  trung bình một HTTP request mất 260.76ms

http_req_duration p(95)=262.07ms
  khoảng 95% HTTP request mất <= 262.07ms

iteration_duration avg=1.77s
  trung bình một iteration mất 1.77s

iteration_duration min=1.52s
  iteration nhanh nhất mất 1.52s

iteration_duration med=1.52s
  khoảng một nửa số iteration mất <= 1.52s

iteration_duration max=2.27s
  iteration chậm nhất mất 2.27s

iteration_duration p(90)=2.27s
  khoảng 90% iteration mất <= 2.27s

iteration_duration p(95)=2.27s
  khoảng 95% iteration mất <= 2.27s
```

Vậy `iteration_duration avg=1.77s` phải hiểu là:

```text
trung bình một iteration hoàn thành mất 1.77 giây
```

không phải:

```text
trung bình mỗi 1 giây đo ra 1.77 giây
```

`p(90)` / `p(95)` là percentile trên **các sample duration**, không phải 90% VU và cũng không phải `rate/s`.

Ý nghĩa:

```text
http_req_duration
  = request mất bao lâu

iteration_duration
  = cả iteration mất bao lâu
```

### Quan trọng

`Trend` không có công thức kiểu:

```text
rate = count / runtime
```

Nó không đo "bao nhiêu event mỗi giây". Nó đo "mỗi event mất bao lâu".

## 8.1. `http_req_duration` và `iteration_duration` liên hệ thế nào?

Mỗi iteration ở đây là:

```text
request 1 + request 2 + sleep(1) + check + overhead
```

### Nhìn ở trạng thái nhanh nhất

```text
http_req_duration min = 258.73ms ≈ 0.25873s
```

Nếu lấy 2 request:

```text
2 * 0.25873
= 0.51746s
```

Cộng `sleep(1)`:

```text
0.51746 + 1
= 1.51746s
```

Rất khớp với:

```text
iteration_duration min ≈ 1.52s
```

Nghĩa là:

```text
iteration nhanh nhất
≈ 2 request nhanh nhất + sleep(1)
```

### Nhìn ở trung bình

```text
http_req_duration avg = 0.26076s
2 * 0.26076 = 0.52152s
0.52152 + 1 = 1.52152s
```

Nhưng:

```text
iteration_duration avg = 1.77s
```

Chênh lệch:

```text
1.77 - 1.52152
≈ 0.24848s
```

Phần chênh này đến từ:

- request đầu tiên của mỗi VU chậm hơn
- `check()`
- JS overhead
- runtime/scheduling overhead

## 9. `Gauge`: `vus` và `vus_max` đọc theo công thức nào?

Hai metric này là metric kiểu `Gauge`.

Output:

```text
vus................: 4       min=4       max=4
vus_max............: 4       min=4       max=4
```

Cách đọc:

```text
value = sample cuối cùng
min = sample nhỏ nhất
max = sample lớn nhất
```

Áp vào run này:

```text
vus
  value = 4
  min = 4
  max = 4

vus_max
  value = 4
  min = 4
  max = 4
```

Nghĩa là:

```text
mọi sample đều thấy 4 VU active
mọi sample đều thấy 4 VU initialized
```

`Gauge` không có công thức:

```text
rate = count / runtime
```

Nó là metric theo sample thời điểm, không phải metric đếm.

## 10. Vì sao `24 requests + 24 checks` không thành `48 iterations`?

Vì đây là ba metric khác nhau:

```text
iterations    = số vòng default function hoàn thành
http_reqs     = số HTTP requests đã gửi
checks_total  = số check đã chạy
```

Trong run này:

```text
iterations = 12
http_reqs = 24
checks_total = 24
```

Không đọc là:

```text
24 + 24 = 48 iterations
```

Mà phải đọc là:

```text
12 iteration events
24 request events
24 check events
```

## 11. Tóm tắt công thức của ví dụ này

```text
vus = 4
iterations_per_vu = 3
total_iterations = 4 * 3 = 12

http_requests_per_iteration = 2
checks_per_iteration = 2

total_http_requests = 12 * 2 = 24
total_checks = 12 * 2 = 24

actual_scenario_runtime
  = 12 / 2.255308
  ≈ 5.3208s

iterations_rate
  = 12 / 5.3208
  ≈ 2.255308 iter/s

average_total_rate
  = completed_iterations / actual_runtime
  = 2.255308 iter/s
  = summary iterations/s của toàn scenario

per_vu_rate
  ≈ 1 / effective_iteration_time

peak_total_rate
  ≈ active_vus * per_vu_rate

Không lấy:

iterations_rate * vus

vì iterations_rate đã là tốc độ trung bình của toàn scenario.

http_reqs_rate
  = 24 / 5.3208
  ≈ 4.510616 req/s

checks_total_rate
  = 24 / 5.3208
  ≈ 4.510616 /s

per_vu_rate_avg
  ≈ 1 / 1.77
  ≈ 0.565 iter/s

estimated_total_rate_from_avg
  ≈ 4 * 0.565
  ≈ 2.26 iter/s
```

Ví dụ kiểu Grafana docs để tính peak:

```text
1 iteration ≈ 515ms = 0.515s

per_vu_rate
  ≈ 1 / 0.515
  ≈ 1.94 iter/s
  ≈ 2 iter/s

10 VUs active

peak_total_rate
  ≈ 10 * 1.94
  ≈ 19.4 iter/s
  ≈ 20 iter/s
```

## 12. Nên nhớ gì sau ví dụ này?

```text
1. runtime là mẫu số chung của các Counter
2. checks_total không phải Counter builtin, nó là summary helper từ metric checks kiểu Rate
3. iterations/s đo tốc độ hoàn thành iteration
4. http_reqs/s đo tốc độ gửi request
5. checks_total/s đo tốc độ chạy check
6. nếu 1 completed iteration luôn chạy đủ N requests thì có thể ước lượng http_reqs/s từ N * iterations/s
7. http_req_duration là latency của request, không phải runtime của scenario
8. nếu không có minIterationDuration, effective_iteration_time gần bằng iteration_duration
9. vus/vus_max là Gauge nên đọc bằng value/min/max, không chia theo runtime
10. failed/succeeded là tỉ lệ pass/fail, không phải count/s
11. summary iterations/s là average_total_rate của toàn scenario, không nhân thêm vus
```
