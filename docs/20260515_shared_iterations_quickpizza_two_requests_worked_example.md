# Shared iterations QuickPizza `2 requests / iteration` worked example

File này phân tích một run cụ thể của:

```text
shared-iterations
```

Khác với `per-vu-iterations`, ở đây:

```text
iterations = tổng số iteration chung của scenario
```

không phải:

```text
iterations = số vòng mỗi VU
```

## 1. File test đang phân tích

Script:

```text
examples/shared_iterations_quickpizza_two_requests_demo.js
```

Command:

```bash
k6 run examples/shared_iterations_quickpizza_two_requests_demo.js
```

Code cốt lõi:

```js
const TARGET_URL = "https://quickpizza.grafana.com/";
const VUS = 4;
const TOTAL_ITERATIONS = 12;

export const options = {
  scenarios: {
    quickpizza_shared_two_requests: {
      executor: "shared-iterations",
      vus: VUS,
      iterations: TOTAL_ITERATIONS,
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
         * quickpizza_shared_two_requests: 12 iterations shared among 4 VUs (maxDuration: 30s, gracefulStop: 5s)
```

Đọc ra:

```text
scenario_name = quickpizza_shared_two_requests
executor = shared-iterations
vus = 4
total_iterations_target = 12
maxDuration = 30s
gracefulStop = 5s
scenario_max_end = 35s
```

Điểm quan trọng:

```text
12 iterations shared among 4 VUs
```

nghĩa là:

```text
tổng toàn scenario = 12 iterations
```

không phải:

```text
4 VUs * 12 iterations = 48
```

## 3. Summary output đang phân tích

Lần chạy mẫu ngày 2026-05-15:

```text
checks_total.......: 24      4.634551/s
checks_succeeded...: 100.00% 24 out of 24
checks_failed......: 0.00%   0 out of 24

http_req_duration..: avg=253.37ms min=251.26ms med=252.76ms max=258.88ms p(90)=255.7ms p(95)=255.98ms
http_req_failed....: 0.00%   0 out of 24
http_reqs..........: 24      4.634551/s

iteration_duration.: avg=1.72s min=1.5s med=1.5s max=2.15s p(90)=2.14s p(95)=2.15s
iterations.........: 12      2.317275/s
vus................: 4       min=4       max=4
vus_max............: 4       min=4       max=4

running (05.2s), 0/4 VUs, 12 complete and 0 interrupted iterations
```

Cách đọc riêng dòng này:

```text
iterations.........: 12      2.317275/s
```

nghĩa là:

```text
toàn bộ run đã hoàn thành 12 iteration
và cột `/s` của Counter đang cho biết trung bình khoảng 2.317275 iteration mỗi giây trên cả run
```

Tức là:

```text
trung bình mỗi giây, cả test xong khoảng 2.31 iteration
```

Không nên đọc nhầm thành:

```text
1 VU chạy 2.31 iteration/s
```

hay:

```text
giây nào cũng đúng 2.31 iteration
```

## 4. Bóc ra các đại lượng chính

### 4.1. Đại lượng đọc trực tiếp

| Đại lượng | Giá trị | Đọc từ đâu |
| --- | --- | --- |
| `completed_iterations` | `12` | `iterations.........: 12` |
| `iterations_rate` | `2.317275/s` | `iterations.........: ... 2.317275/s` |
| `total_http_requests` | `24` | `http_reqs..........: 24` |
| `http_reqs_rate` | `4.634551/s` | `http_reqs..........: ... 4.634551/s` |
| `total_checks` | `24` | `checks_total.......: 24` |
| `checks_total_rate` | `4.634551/s` | `checks_total.......: ... 4.634551/s` |
| `checks_succeeded_rate` | `100%` | `checks_succeeded...: 100.00%` |
| `checks_failed_rate` | `0%` | `checks_failed......: 0.00%` |
| `http_req_failed_rate` | `0%` | `http_req_failed....: 0.00%` |
| `http_req_duration_avg` | `253.37ms` | summary |
| `http_req_duration_min` | `251.26ms` | summary |
| `iteration_duration_avg` | `1.72s` | summary |
| `iteration_duration_min` | `1.5s` | summary |
| `iteration_duration_max` | `2.15s` | summary |
| `vus` | `4 min=4 max=4` | summary |
| `vus_max` | `4 min=4 max=4` | summary |

### 4.2. Đại lượng phải đọc từ code/header

| Đại lượng | Giá trị | Đọc từ đâu |
| --- | --- | --- |
| `TARGET_URL` | `https://quickpizza.grafana.com/` | code |
| `executor` | `shared-iterations` | code/header |
| `vus` config | `4` | code/header |
| `total_iterations_target` | `12` | code/header |
| `maxDuration` | `30s` | code/header |
| `gracefulStop` | `5s` | code/header |
| `http_requests_per_iteration` | `2` | code |
| `checks_per_iteration` | `2` | code |
| `sleep_per_iteration` | `1s` | code |

## 5. Từ output suy ra gì?

### 5.1. Tổng số iterations

Với `shared-iterations`:

```text
total_iterations_target = iterations
```

Ở demo:

```text
total_iterations_target = 12
```

Khớp:

```text
iterations.........: 12
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
http_reqs..........: 24
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

Nó là summary helper dựng từ metric `checks` kiểu `Rate`, nhưng rate của dòng
`checks_total` vẫn dùng:

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
  = 12 / 2.317275
  ≈ 5.1785s
```

Từ `http_reqs`:

```text
summary_runtime_base
  = 24 / 4.634551
  ≈ 5.1785s
```

Khớp với:

```text
running (05.2s)
```

Trong demo sạch này, số đó cũng gần với thời gian run bạn nhìn thấy.
Nhưng khi cắt nghĩa công thức thì nên gọi đúng là `summary_runtime_base`.

## 6. Từ `summary_runtime_base` suy ra rate

Lấy:

```text
summary_runtime_base ≈ 5.1785s
```

thì:

```text
iterations_rate
  = 12 / 5.1785
  ≈ 2.317275 iter/s

average_total_rate
  = completed_iterations / summary_runtime_base
  = 2.317275 iter/s
  = cột `/s` của Counter `iterations` trong summary
  = trung bình trên cả run theo `count / summary_runtime_base`

per_vu_rate
  ≈ 1 / effective_iteration_time

peak_total_rate
  ≈ active_vus * per_vu_rate

Không lấy:

iterations_rate * vus

vì iterations_rate đã là tốc độ trung bình của toàn scenario.

http_reqs_rate
  = 24 / 5.1785
  ≈ 4.634551 req/s

checks_total_rate
  = total_checks / summary_runtime_base
  = 24 / 5.1785
  ≈ 4.634551 /s
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

Công thức này đúng cho run sạch này vì mỗi completed iteration đều chạy đủ 2 HTTP requests và 2
checks. Nếu code có nhánh điều kiện, request fail trước khi gọi request thứ hai, hoặc iteration bị
interrupt, phải đọc `http_reqs`/`checks` thực tế từ summary hoặc custom metric, không chỉ nhân máy
móc.

Kiểm tra:

```text
2 * 2.317275
= 4.63455
```

## 7. 1 VU trong 1 giây chạy được bao nhiêu iteration?

Với `shared-iterations`, vẫn tính được tốc độ ước lượng của 1 VU:

```text
effective_iteration_time ~= iteration_duration nếu không có minIterationDuration
effective_iteration_time ~= max(iteration_duration, minIterationDuration) nếu có minIterationDuration

per_vu_rate ≈ 1 / effective_iteration_time
```

Nhưng phải hiểu đúng:

```text
per_vu_rate
  = tốc độ ước lượng của 1 VU

per_vu_iteration_count
  = số iteration một VU thực tế đã chạy
```

Hai cái này khác nhau.

Muốn thấy rõ mỗi VU thực tế chạy bao nhiêu iteration, xem demo chuyên để đếm:

```text
examples/shared_iterations_vu_speed_count_demo.js
```

### Tính `per_vu_rate`

Output:

```text
iteration_duration avg = 1.72s
iteration_duration min = 1.5s
```

Suy ra:

```text
per_vu_rate_avg
  ≈ 1 / 1.72
  ≈ 0.58 iter/s

per_vu_rate_fast
  ≈ 1 / 1.5
  ≈ 0.67 iter/s
```

Nếu 4 VU đều active và nhịp khá giống nhau:

```text
estimated_total_rate_from_avg
  ≈ active_vus * per_vu_rate_avg
  ≈ 4 * 0.58
  ≈ 2.32 iter/s
```

Khớp với summary:

```text
iterations.........: 12      2.317275/s
```

### Nhưng không được suy ra "mỗi VU chạy đúng 3 iteration"

Vì đây là `shared-iterations`, nên:

```text
iterations = 12
vus = 4
```

không có nghĩa chắc chắn:

```text
mỗi VU chạy 12 / 4 = 3 iterations
```

Điều đó chỉ đúng nếu các VU chạy đều nhau hoặc run tình cờ phân phối đều.

Với shared:

```text
sum(iterations_per_vu_i) = 12
```

nhưng từng VU chạy bao nhiêu iteration thì:

- không cố định từ config
- phụ thuộc VU nào xong trước
- muốn biết chính xác phải xem log `__VU`, `__ITER`, `iterInScenario`

Tóm lại:

```text
per_vu_rate
  tính được từ iteration_duration

per_vu_iteration_count
  phải đo/log, không suy chắc từ iterations / vus
```

## 8. Pass/fail rate

### `http_req_failed`

```text
http_req_failed_rate
  = failed_http_requests / total_http_requests
  = 0 / 24
  = 0%
```

### `checks_succeeded` / `checks_failed`

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

## 9. Trend: duration metrics

`http_req_duration` và `iteration_duration` là `Trend`.

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

Đọc rõ hơn:

```text
avg
  = average / trung bình cộng
  = tổng duration của các sample / số sample

min
  = minimum / nhỏ nhất
  = sample nhanh nhất

med
  = median / p50
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

Output:

```text
http_req_duration avg=253.37ms min=251.26ms med=252.76ms max=258.88ms
iteration_duration avg=1.72s min=1.5s med=1.5s max=2.15s
```

Đọc thành câu:

```text
http_req_duration avg=253.37ms
  trung bình một HTTP request mất 253.37ms

http_req_duration max=258.88ms
  request chậm nhất mất 258.88ms

iteration_duration avg=1.72s
  trung bình một iteration mất 1.72s

iteration_duration min=1.5s
  iteration nhanh nhất mất 1.5s

iteration_duration med=1.5s
  khoảng một nửa số iteration mất <= 1.5s

iteration_duration max=2.15s
  iteration chậm nhất mất 2.15s
```

Các số này là thống kê trên **sample duration**:

```text
http_req_duration
  sample = một HTTP request hoàn thành

iteration_duration
  sample = một iteration hoàn thành
```

Vậy `iteration_duration avg=1.72s` phải hiểu là:

```text
trung bình một iteration hoàn thành mất 1.72 giây
```

không phải:

```text
trung bình mỗi 1 giây đo ra 1.72 giây
```

Không đọc chúng là `req/s` hay `iter/s`; muốn xem tốc độ thì nhìn `http_reqs` hoặc `iterations`.

Liên hệ với code:

```text
1 iteration = request 1 + request 2 + checks + sleep(1) + overhead
```

Kiểm tra bằng min:

```text
2 * http_req_duration_min + sleep
  = 2 * 0.25126 + 1
  = 1.50252s
```

Khớp:

```text
iteration_duration min = 1.5s
```

## 10. Gauge: `vus` và `vus_max`

Output:

```text
vus................: 4       min=4       max=4
vus_max............: 4       min=4       max=4
```

Đọc:

```text
value = sample cuối
min = sample nhỏ nhất
max = sample lớn nhất
```

Ở run này:

```text
mọi sample đều thấy 4 VU active
mọi sample đều thấy 4 VU initialized
```

## 11. Shared khác per-vu ở ngay output này như nào?

Header của shared:

```text
12 iterations shared among 4 VUs
```

Nếu cùng config `vus=4`, `iterations=12` mà dùng `per-vu-iterations` thì ý nghĩa sẽ là:

```text
12 iterations for each of 4 VUs
=> total_iterations = 4 * 12 = 48
```

Nhưng với shared:

```text
total_iterations = 12
```

## 12. Tóm tắt công thức của ví dụ này

```text
executor = shared-iterations
vus = 4
iterations = 12

total_iterations_target = iterations = 12
completed_iterations = 12

http_requests_per_iteration = 2
checks_per_iteration = 2

total_http_requests = 12 * 2 = 24
total_checks = 12 * 2 = 24

runtime
  = 12 / 2.317275
  ≈ 5.1785s

iterations_rate
  = 12 / 5.1785
  ≈ 2.317275 iter/s

http_reqs_rate
  = 24 / 5.1785
  ≈ 4.634551 req/s

checks_total_rate
  = 24 / 5.1785
  ≈ 4.634551 /s

per_vu_rate_avg
  ≈ 1 / effective_iteration_time_avg
  ≈ 1 / 1.72
  ≈ 0.58 iter/s

estimated_total_rate_from_avg
  ≈ 4 * 0.58
  ≈ 2.32 iter/s
```

Ví dụ kiểu Grafana docs để tính peak trong một case giả định khác, không có `sleep(1)` như demo
QuickPizza này:

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

## 13. Nên nhớ gì sau ví dụ này?

```text
1. shared-iterations lấy iterations làm tổng chung
2. VU cùng lấy việc từ kho iteration chung của scenario
3. VU nhanh có thể chạy nhiều iteration hơn VU chậm
4. http_reqs/s phụ thuộc số request trong mỗi iteration
5. checks_total là summary helper, không phải Counter builtin
6. duration metrics là Trend, đọc bằng avg/min/med/max/p...
7. vus/vus_max là Gauge, đọc bằng value/min/max
8. per_vu_rate nên tính từ effective_iteration_time; trong demo không có minIterationDuration nên gần bằng iteration_duration
9. summary `iterations/s` là cột `/s` của Counter `iterations`, trung bình trên cả run; không nhân thêm `vus`
```
