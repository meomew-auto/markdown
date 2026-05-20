# `shared-iterations` quick index

File này là bản điều hướng nhanh cho bộ bài `shared-iterations`.

## Đọc theo nhu cầu

| Tôi muốn xem | Link |
| --- | --- |
| Ý tưởng chính | [Ý tưởng chính](./20260515_shared-iterations-tham-so-cong-thuc.md#1-ý-tưởng-chính) |
| Khi nào dùng thực tế | [Khi nào dùng thực tế](./20260515_shared-iterations-tham-so-cong-thuc.md#11-khi-nào-dùng-thực-tế) |
| Core chạy như nào | [Core chạy như nào](./20260515_shared-iterations-tham-so-cong-thuc.md#12-core-chạy-như-nào) |
| Bảng tham số | [Bảng tham số](./20260515_shared-iterations-tham-so-cong-thuc.md#2-bảng-tham-số-tiếng-việt) |
| Công thức nền | [Công thức nền](./20260515_shared-iterations-tham-so-cong-thuc.md#3-công-thức-nền) |
| Khác gì với `per-vu-iterations` | [So sánh per-vu](./20260515_shared-iterations-tham-so-cong-thuc.md#4-khác-gì-với-per-vu-iterations) |
| Demo `dropped_iterations` do `maxDuration` | [Dropped iterations](./20260515_shared-iterations-tham-so-cong-thuc.md#demo-dropped-iterations-do-maxduration) |
| Demo VU nhanh lấy thêm việc | [Demo phân phối](./20260515_shared-iterations-tham-so-cong-thuc.md#5-demo-phân-phối-iteration) |
| Đếm mỗi VU chạy bao nhiêu vòng | [Demo đếm từng VU](./20260515_shared-iterations-tham-so-cong-thuc.md#51-demo-đếm-từng-vu-nhanhchậm) |
| QuickPizza 2 requests / iteration | [Demo QuickPizza](./20260515_shared-iterations-tham-so-cong-thuc.md#6-demo-quickpizza-2-requests--iteration) |
| Worked example QuickPizza | [Worked example](./20260515_shared_iterations_quickpizza_two_requests_worked_example.md) |
| Các loại metric và công thức | [Metric types and formulas](./20260515_k6_metric_types_and_formulas.md) |
| TPS, RPS, peak vs average throughput | [TPS / Throughput](./20260515_tps-throughput-jmeter-vs-k6.md) |

## File demo để chạy

| Mục đích | File | Command |
| --- | --- | --- |
| Thấy VU nhanh lấy thêm iteration | [`examples/shared_iterations_distribution_demo.js`](../examples/shared_iterations_distribution_demo.js) | `k6 run examples/shared_iterations_distribution_demo.js` |
| Dropped iterations do `maxDuration` | [`examples/shared_iterations_dropped_demo.js`](../examples/shared_iterations_dropped_demo.js) | `k6 run examples/shared_iterations_dropped_demo.js` |
| Đếm từng VU chạy bao nhiêu iteration | [`examples/shared_iterations_vu_speed_count_demo.js`](../examples/shared_iterations_vu_speed_count_demo.js) | `k6 run examples/shared_iterations_vu_speed_count_demo.js` |
| QuickPizza, 2 requests / iteration | [`examples/shared_iterations_quickpizza_two_requests_demo.js`](../examples/shared_iterations_quickpizza_two_requests_demo.js) | `k6 run examples/shared_iterations_quickpizza_two_requests_demo.js` |

## Công thức hay dùng

```text
shared-iterations:
  total_iterations_target = iterations

sum(iterations_per_vu_i) = completed_iterations

Nếu không drop/interrupt:
  completed_iterations = iterations

Nếu có drop/interrupt:
  completed_iterations có thể nhỏ hơn iterations

Counter:
  rate = count / summary_runtime_base
  summary_runtime_base = count / rate

http_reqs_count = completed_iterations * http_requests_per_iteration
http_reqs_rate = http_reqs_count / summary_runtime_base

checks_total_rate = total_checks / summary_runtime_base

Nếu 1 completed iteration luôn chạy đủ N HTTP requests:
  estimated_http_reqs_rate ≈ N * iterations/s
  chỉ đúng khi mỗi completed iteration chạy đủ N requests trên cùng code path
  nếu có branch/error/interrupt làm thiếu request thì đọc http_reqs thực tế

Per VU speed:
  effective_iteration_time ~= iteration_duration nếu không có minIterationDuration
  effective_iteration_time ~= max(iteration_duration, minIterationDuration) nếu có minIterationDuration
  per_vu_rate_i ≈ 1 / effective_iteration_time

Peak vs average:
  peak_total_rate ≈ active_vus * per_vu_rate
  average_total_rate = completed_iterations / summary_runtime_base
  summary iterations/s = average_total_rate, không nhân thêm vus

Shared distribution:
  iterations_per_vu_i phải đo bằng log __VU và __ITER
  không suy chắc từ iterations / vus
```

Đọc từng biến:

| Biến / biểu thức | Nghĩa đời thường | Lấy ở đâu |
| --- | --- | --- |
| `iterations` | tổng số iteration của cả scenario | config `iterations` |
| `iterations_per_vu_i` | VU số i thực tế chạy bao nhiêu vòng | phải log `__VU`, `__ITER` hoặc `exec.vu.*` |
| `completed_iterations` | số iteration hoàn tất thật | summary `iterations` |
| `summary_runtime_base` | thời gian mà Counter summary dùng làm mẫu số cho cột `/s` | `count / rate` từ Counter summary |
| `http_requests_per_iteration` | mỗi iteration thường gọi mấy request | đọc trong code script |
| `effective_iteration_time` | thời gian một VU bị bận cho một vòng | thường lấy từ `iteration_duration`, nhớ caveat `minIterationDuration` |

Điểm dễ nhầm nhất:

```text
shared-iterations không chia đều iteration theo VU
VU nhanh có thể lấy thêm việc
```

Và thêm 1 caveat:

```text
Counter summary dùng test run duration của cả test làm mẫu số
trong demo 1 scenario, startTime=0, không setup/teardown thì nó mới gần với runtime của scenario
```

## Nhớ khác biệt với `per-vu-iterations`

```text
shared-iterations:
  iterations = tổng toàn scenario
  VU nhanh có thể chạy nhiều iteration hơn

per-vu-iterations:
  iterations = số vòng mỗi VU
  mỗi VU chạy đúng số vòng như nhau
```
