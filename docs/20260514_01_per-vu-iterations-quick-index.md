# `per-vu-iterations` quick index

File này là bản điều hướng nhanh cho doc dài:

```text
docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md
```

## Đọc theo nhu cầu

| Tôi muốn xem | Link |
| --- | --- |
| Ý tưởng chính của `per-vu-iterations` | [Ý tưởng chính](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#1-ý-tưởng-chính) |
| Bài dạy học ngắn: khai báo và nhiều scenario | [Khai báo nhiều scenario](./20260521_00_per-vu-iterations-khai-bao-nhieu-scenario.md) |
| Khi nào dùng `per-vu-iterations` ngoài thực tế | [Khi nào dùng thực tế](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#11-khi-nào-dùng-thực-tế) |
| Core chạy như nào | [Core chạy như nào](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#12-core-chạy-như-nào) |
| Tên tham số tiếng Việt | [Bảng tham số](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#2-bảng-tham-số-tiếng-việt) |
| Công thức nền | [Công thức nền](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#3-công-thức-nền) |
| `iteration_duration` gồm gì | [`js_iteration_time_i`](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#4-js_iteration_time_i-gồm-những-gì) |
| Vì sao docs nói peak đạt được nhưng không giữ được | [Reached but not maintained](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#vì-sao-docs-nói-maximum-throughput-is-reached-but-not-maintained) |
| Demo mô phỏng VU nhanh/chậm | [Demo của ta](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#6-demo-của-ta) |
| Demo `dropped_iterations` do `maxDuration` | [Dropped iterations](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#demo-dropped-iterations-do-maxduration) |
| Cách đọc output k6 | [Chạy trực tiếp](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#7-chạy-trực-tiếp-thì-tìm-tham-số-ở-đâu) |
| QuickPizza 1 request / iteration | [Demo QuickPizza](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#77-demo-chạy-thật-với-quickpizza) |
| Bảng map output QuickPizza về công thức | [Map ngược output](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#772-map-ngược-từ-output-về-các-giá-trị-ở-đầu-file) |
| Công thức `http_reqs: count rate/s` | [`http_reqs` formula](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#d1-công-thức-riêng-cho-http_reqs-12--2780988s) |
| Dùng `summary runtime base` để suy ra các rate/count | [`summary_runtime_base` làm gốc](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#d2-nếu-lấy-summary_runtime_base-làm-gốc-thì-suy-ra-gì) |
| Công thức `1 VU chạy bao nhiêu iteration/s` | [`per_vu_rate`](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#e2-nếu-đã-biết-iteration_duration-thì-1-vu-1-giây-chạy-được-bao-nhiêu-iteration) |
| Các loại metric và công thức tổng quát | [k6 metrics căn bản](./20260520_00_k6-metrics-types-builtins-core-guide.md) |
| TPS, RPS, peak vs average throughput | [TPS / Throughput](./20260515_06_tps-throughput-jmeter-vs-k6.md) |
| QuickPizza 2 requests / iteration | [2 HTTP requests demo](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#773-demo-quickpizza-với-1-iteration--2-http-requests) |
| Worked example riêng cho QuickPizza 2 requests | [QuickPizza 2 requests worked example](./20260515_05_quickpizza-two-requests-worked-example.md) |
| So sánh 1 request vs 2 requests | [So sánh](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#774-khác-gì-so-với-case-1-iteration--1-http-request) |
| `sample`, `Gauge`, `vus`, `vus_max` | [`vus` và `vus_max`](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#78-sample-gauge-vus-vus_max-là-gì) |
| Cheat sheet cuối file | [Cheat sheet](./20260514_02_per-vu-iterations-tham-so-cong-thuc.md#8-cheat-sheet-ngắn) |

## File demo để chạy

| Mục đích | File | Command |
| --- | --- | --- |
| VU nhanh/chậm không gọi mạng | [`examples/per_vu_iterations_throughput_demo.js`](../examples/per_vu_iterations_throughput_demo.js) | `k6 run examples/per_vu_iterations_throughput_demo.js` |
| Dropped iterations do `maxDuration` | [`examples/per_vu_iterations_dropped_demo.js`](../examples/per_vu_iterations_dropped_demo.js) | `k6 run examples/per_vu_iterations_dropped_demo.js` |
| QuickPizza, 1 request / iteration | [`examples/per_vu_iterations_quickpizza_demo.js`](../examples/per_vu_iterations_quickpizza_demo.js) | `k6 run examples/per_vu_iterations_quickpizza_demo.js` |
| QuickPizza, 2 requests / iteration | [`examples/per_vu_iterations_quickpizza_two_requests_demo.js`](../examples/per_vu_iterations_quickpizza_two_requests_demo.js) | `k6 run examples/per_vu_iterations_quickpizza_two_requests_demo.js` |

## Công thức hay dùng

```text
iterations_per_vu = iterations

total_iterations = vus * iterations_per_vu

planned_total_iterations = vus * iterations_per_vu

completed_iterations = planned_total_iterations - dropped_iterations - interrupted_iterations

effective_iteration_time ~= iteration_duration nếu không có minIterationDuration
effective_iteration_time ~= max(iteration_duration, minIterationDuration) nếu có minIterationDuration

per_vu_rate ≈ 1 / effective_iteration_time

peak_total_rate ≈ active_vus * per_vu_rate

average_iteration_rate = completed_iterations / summary_runtime_base

summary iterations/s = average_iteration_rate, không nhân thêm vus

estimated_http_reqs_count_if_fixed_path = completed_iterations * http_requests_per_iteration

estimated_http_reqs_rate_if_fixed_path = estimated_http_reqs_count_if_fixed_path / summary_runtime_base

estimated_checks_total_if_fixed_path = completed_iterations * checks_per_iteration

estimated_checks_total_rate_if_fixed_path = estimated_checks_total_if_fixed_path / summary_runtime_base

Với Counter:
  summary_runtime_base = count / rate

Nếu 1 completed iteration luôn chạy đủ N HTTP requests:
  estimated_http_reqs_rate ≈ N * iterations/s
  chỉ đúng khi mỗi completed iteration chạy đủ N requests trên cùng code path
  nếu có branch/error/interrupt làm thiếu request thì đọc http_reqs thực tế
```

Legend ngắn:

```text
t_i = thời gian VU i bị bận cho 1 iteration
count = cột trái của Counter summary
rate = cột phải `/s` của Counter summary
N = số request/check trong mỗi iteration của đúng demo/script
```

Đọc từng biến:

| Biến / biểu thức | Nghĩa đời thường | Lấy ở đâu |
| --- | --- | --- |
| `vus` | số VU được executor lấy ra chạy | config scenario |
| `iterations_per_vu` | mỗi VU phải chạy bao nhiêu vòng | chính là config `iterations` của `per-vu-iterations` |
| `planned_total_iterations` | tổng số vòng dự kiến nếu không bị dừng sớm | `vus * iterations_per_vu` |
| `completed_iterations` | số iteration đã chạy xong thật | dòng summary `iterations` hoặc progress `complete` |
| `dropped_iterations` | iteration chưa kịp start vì hết `maxDuration` | metric `dropped_iterations`, thường chỉ có khi chạm `maxDuration` |
| `interrupted_iterations` | iteration đã start nhưng bị cắt giữa chừng | progress cuối `interrupted iterations` |
| `summary_runtime_base` | thời gian mà summary Counter dùng làm mẫu số cho cột `/s` | lấy từ `Counter count / Counter rate` |
| `http_requests_per_iteration` | mỗi iteration gọi bao nhiêu HTTP request | đọc trong code demo/script |
| `checks_per_iteration` | mỗi iteration chạy bao nhiêu check | đọc trong code demo/script |
| `iterations/s` | completed iteration trung bình mỗi giây | dòng summary `iterations...: count rate/s` |

Điểm dễ nhầm nhất:

```text
summary iterations/s đã là tốc độ trung bình toàn scenario
không nhân thêm với vus nữa
```

Và thêm 1 caveat quan trọng:

```text
core summary chia Counter rate theo test run duration của cả test
trong các demo 1 scenario, startTime=0, không setup/teardown thì nó thường gần bằng runtime của scenario
```
