# Case 07: CI verification batch

## Tình huống thực tế

Verify một checklist API cố định sau deploy/migration: products, cart, order, report.

Đây không phải bài mô phỏng user traffic mở theo thời gian. Đây là bài:

```text
fixed backlog + worker pool + drain until done
```

Nói đời thường:

```text
Có 100 job đang chờ.
Dùng 10 worker xử lý hết.
Ai xong trước thì lấy job tiếp theo.
Hoàn tất khi không còn job nào trong backlog.
```

## Vì sao case này hợp với `shared-iterations`?

CI cần coverage cố định, lặp lại được giữa các run. Shared-iterations đảm bảo tổng checklist jobs là input chính.

Đọc config:

```text
iterations = 100
```

nghĩa là:

```text
cả scenario có 100 job tổng cộng
```

không phải:

```text
mỗi VU chạy 100 job
```

Với `shared-iterations`, phân phối thực tế có thể lệch:

```text
VU nhanh  -> xử lý nhiều job hơn
VU chậm   -> xử lý ít job hơn
```

Điều đó **không phải lỗi**. Pass/fail nằm ở tổng backlog có drain đủ và job có fail không.

## Default config

| Tham số | Giá trị mặc định |
| --- | --- |
| SI_07_VUS | 10 |
| SI_07_JOBS | 100 |
| maxDuration | 10m |
| executor | shared-iterations |
| script | `si-07-ci-verification-batch.js` |

Công thức chính:

```text
JOBS = 100
configured VUs = 10
expected iterations = 100
expected http_reqs = shared_api_calls_total = 100 × 1 = 100
```

## Backlog/job model

- Mỗi job là một checklist item.
- Default cycle 5 operation types, 100 jobs nên mỗi type 20 lần.
- CI pass/fail dựa vào exact coverage và checks, không dựa vào traffic realism.

Selector đúng cho business job là job index toàn scenario, ví dụ:

```js
exec.scenario.iterationInTest
```

Không dùng `__VU` làm identity chính cho backlog, vì `__VU` chỉ là worker đang cầm job hiện tại.

## Service/API flow

| Bước | Method | Path | Service | Operation | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| A | `GET` | `/api/sim/products?limit=10&cpu_ms=1&db_rows=2` | `products-service` | `ci_product_list` | `200` | Verify products list. |
| B | `GET` | `/api/sim/products/:id?view=full&cpu_ms=1&db_rows=1` | `products-service` | `ci_product_detail` | `200` | Verify product detail. |
| C | `POST` | `/api/sim/cart/add?cpu_ms=1&db_writes=1` | `cart-service` | `ci_cart_add` | `200` | Verify cart add. |
| D | `POST` | `/api/sim/orders/:id/confirm?cpu_ms=1&db_writes=1&external_ms=1&external_fail_rate=0` | `order-service` | `ci_order_confirm` | `200` | Verify order confirm with idempotency key. |
| E | `GET` | `/api/sim/report?cpu_ms=1&db_rows=1&gzip_kb=1` | `report-service` | `ci_report_generate` | `200` | Verify report endpoint. |

Expected operation breakdown:

| Operation | Expected count |
| --- | --- |
| `ci_product_list` | 20 |
| `ci_product_detail` | 20 |
| `ci_cart_add` | 20 |
| `ci_order_confirm` | 20 |
| `ci_report_generate` | 20 |

## Metrics và tags cần đọc

| Metric | Expected | Ý nghĩa |
| --- | --- | --- |
| `shared_jobs_total` | `count == JOBS` | Đã hoàn tất đủ số job trong backlog. |
| `shared_jobs_failed` | `count == 0` | Không job nào fail ở cấp business. |
| `shared_api_calls_total` | khớp công thức API/job | Tổng request đi qua helper chung. |
| `shared_job_duration_ms` | `count == JOBS` | End-to-end duration của job. |
| `shared_sleep_seconds` | tùy case | Sleep/think time nếu script dùng. |

Tags quan trọng:

```text
case_id, business_case, service, operation, endpoint, job_id,
executor_family=shared_iterations, workload_shape=fixed_backlog
```

Riêng case này cần nhớ:

```text
case_id       = si-07-ci-verification-batch
business_case = ci_api_contract_verification
service       = mixed products/cart/order/report
```

## Pass criteria

Pass khi cả 4 nhóm tín hiệu đều đúng:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 100
shared_jobs_failed count == 0
```

Và count theo công thức phải khớp:

```text
iterations = 100
http_reqs = shared_api_calls_total = 100 × 1 = 100
```

Nếu có tag breakdown theo `operation`, expected là:

```text
ci_product_list: 20
```

```text
ci_product_detail: 20
```

```text
ci_cart_add: 20
```

```text
ci_order_confirm: 20
```

```text
ci_report_generate: 20
```

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-07-ci-verification-batch.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-07-ci-verification-batch.js
```

Run lên private dashboard nếu dùng cloud output:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-07-ci-verification-batch.js
```

Có thể override workload bằng env vars trong bảng config ở trên, ví dụ:

```powershell
$env:SI_07_JOBS = "20"
$env:SI_07_VUS = "4"
```

## Đọc output summary

Đọc summary theo checklist sau:

1. `iterations` có bằng `100` không?
2. `shared_jobs_total` có bằng `100` không?
3. `shared_jobs_failed` có bằng `0` không?
4. `checks` có pass 100% không?
5. `http_req_failed` có bằng 0 không?
6. `http_reqs` và `shared_api_calls_total` có bằng `100 × 1 = 100` không?
7. `shared_job_duration_ms` có count bằng `100` không?

Các điểm case-specific:

- `iterations = 100` nghĩa là 100 checklist jobs đã chạy.
- `http_reqs = 100` vì mỗi checklist job gọi một API.
- Default split 5 operation × 20 lần chứng minh coverage đều.

Đừng bịa thêm per-VU fairness từ summary. Với shared pool, summary không cần chứng minh mỗi VU xử lý cùng số job.

## Đọc dashboard real-time charts cho case 07

> Vì chưa có real run trong working tree hiện tại, phần này mô tả cách đọc expected dashboard. Khi đã chạy thật, bổ sung run ID, summary p95/p99/max và bucket sums giống series per-vu.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Request/operation nào chậm? bucket nào có tail latency? | Backlog đã xử lý đủ chưa |
| Execution timeline | Theo thời gian đã hoàn tất bao nhiêu job/request? | Mỗi VU có chia đều job không |
| VUs vs iter/s | Worker pool drain backlog nhanh/chậm ra sao? | Business correctness của từng job |

### Chart 1 — Response time

Chart này nên đọc theo `operation` tag.

Với case này, operation cần tách là:

| Operation | Expected count |
| --- | --- |
| `ci_product_list` | 20 |
| `ci_product_detail` | 20 |
| `ci_cart_add` | 20 |
| `ci_order_confirm` | 20 |
| `ci_report_generate` | 20 |

Cách đọc:

```text
- avg: request thường nhanh/chậm thế nào
- p95/p99: tail latency của phần lớn request
- max: bucket nào có spike lớn nhất
```

Nhưng kết luận đúng phải là:

```text
Response time giúp tìm bottleneck.
Pass/fail vẫn nằm ở checks + shared_jobs_total + shared_jobs_failed.
```

Case-specific notes:

- Response time nên đọc theo service/operation để biết service nào kéo chậm CI.
- Execution timeline phải sum 100 iterations và 100 http_reqs.
- VUs vs iter/s cho biết CI batch hoàn thành nhanh/chậm; pass vẫn do thresholds/checks quyết định.

### Chart 2 — Execution timeline

Chart này dùng để kiểm backlog drain có đủ không.

Kiểm tổng:

```text
sum(iterations buckets) == 100
sum(http_reqs buckets) == 100 × 1 = 100
sum(shared_jobs_total buckets) == 100
sum(shared_jobs_failed buckets) == 0
```

Nếu `iterations` đủ nhưng `shared_jobs_total` thiếu, nghĩa là script có iteration hoàn tất nhưng job không được mark done đúng cách.
Nếu `shared_jobs_total` đủ nhưng `shared_jobs_failed > 0`, nghĩa là backlog đã chạy hết nhưng có job business fail.

Đừng nhầm:

```text
Mỗi point = một time bucket / metrics frame.
Không phải một request.
Không phải một job.
```

### Chart 3 — VUs vs iter/s

Expected shape:

```text
- Khi còn backlog: VUs gần configured VUs (10)
- Khi backlog gần hết: VUs có thể tụt ở tail
- iter/s cao thấp tùy latency và số API/job
```

Điểm quan trọng:

```text
VUs ổn định không chứng minh chia đều job.
Tail VUs tụt không phải lỗi nếu iterations/shared_jobs_total vẫn đủ.
```

### Checklist đọc biểu đồ case 07

```text
[ ] Response time đã tách operation chưa?
[ ] Execution timeline cộng iterations ra 100 chưa?
[ ] Execution timeline cộng http_reqs ra 100 × 1 = 100 chưa?
[ ] shared_jobs_total == 100 chưa?
[ ] shared_jobs_failed == 0 chưa?
[ ] VUs shape có hợp worker pool không?
```

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận pass/fail bằng counters/thresholds.
2. Execution timeline xác nhận backlog drain đủ theo thời gian.
3. Response time xác định operation nào chậm.
4. VUs vs iter/s giải thích worker pool hoạt động thế nào.
5. Kết luận nghiệp vụ: batch có xử lý đủ và sạch không.
```

## Kết luận thực tế: team CI/platform quyết định gì?

Team CI/platform pass deploy khi exact checklist coverage đủ 100 jobs, mỗi operation đủ 20, không fail. Nếu thiếu một operation count, không nên pass dù tổng HTTP 100 vì coverage bị lệch.

## Mở rộng

- Thêm threshold p95 cho operation critical.
- Tăng checklist JOBS theo confidence level.
- Tách token/role nếu CI cần verify permission matrix.

## Anti-pattern

- Dùng constant-vus 1 phút cho CI checklist rồi count thay đổi mỗi run.
- Chỉ nhìn tổng checks pass mà không kiểm operation coverage.
- Đọc dashboard như load test traffic realism; đây là deterministic verification batch.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-07-ci-verification-batch.js`
