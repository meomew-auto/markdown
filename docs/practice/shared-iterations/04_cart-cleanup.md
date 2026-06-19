# Case 04: Cart cleanup

## Tình huống thực tế

Cleanup/update một backlog stale cart line-items cố định, rồi đọc summary để verify sau update.

Đây không phải bài mô phỏng user traffic mở theo thời gian. Đây là bài:

```text
fixed backlog + worker pool + drain until done
```

Nói đời thường:

```text
Có 90 job đang chờ.
Dùng 8 worker xử lý hết.
Ai xong trước thì lấy job tiếp theo.
Hoàn tất khi không còn job nào trong backlog.
```

## Vì sao case này hợp với `shared-iterations`?

Stale cart cleanup là batch data task: có N item cần xử lý hết. VU chỉ là worker, không phải user giữ cart state.

Đọc config:

```text
iterations = 90
```

nghĩa là:

```text
cả scenario có 90 job tổng cộng
```

không phải:

```text
mỗi VU chạy 90 job
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
| SI_04_VUS | 8 |
| SI_04_JOBS | 90 |
| maxDuration | 8m |
| executor | shared-iterations |
| script | `si-04-cart-cleanup.js` |

Công thức chính:

```text
JOBS = 90
configured VUs = 8
expected iterations = 90
expected http_reqs = shared_api_calls_total = 90 × 2 = 180
```

## Backlog/job model

- Mỗi job là một stale cart item/SKU cần update hoặc clear.
- Quantity được derive theo job index.
- Case này khác cart concurrency per-vu: không test same-user race, mà test fixed cleanup backlog.

Selector đúng cho business job là job index toàn scenario, ví dụ:

```js
exec.scenario.iterationInTest
```

Không dùng `__VU` làm identity chính cho backlog, vì `__VU` chỉ là worker đang cầm job hiện tại.

## Service/API flow

| Bước | Method | Path | Service | Operation | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `PATCH` | `/api/sim/cart/items/:item_id?cpu_ms=1&db_writes=1` | `cart-service` | `cart_item_cleanup_update` | `200` | Update/cleanup stale line item. |
| 2 | `GET` | `/api/sim/cart/summary?cpu_ms=1&db_rows=3&json_items=8` | `cart-service` | `cart_cleanup_summary_verify` | `200` | Verify cart summary sau cleanup. |

Expected operation breakdown:

| Operation | Expected count |
| --- | --- |
| `cart_item_cleanup_update` | 90 |
| `cart_cleanup_summary_verify` | 90 |

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
case_id       = si-04-cart-cleanup
business_case = stale_cart_cleanup
service       = cart-service
```

## Pass criteria

Pass khi cả 4 nhóm tín hiệu đều đúng:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 90
shared_jobs_failed count == 0
```

Và count theo công thức phải khớp:

```text
iterations = 90
http_reqs = shared_api_calls_total = 90 × 2 = 180
```

Nếu có tag breakdown theo `operation`, expected là:

```text
cart_item_cleanup_update: 90
```

```text
cart_cleanup_summary_verify: 90
```

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-04-cart-cleanup.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js
```

Run lên private dashboard nếu dùng cloud output:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js
```

Có thể override workload bằng env vars trong bảng config ở trên, ví dụ:

```powershell
$env:SI_04_JOBS = "20"
$env:SI_04_VUS = "4"
```

## Đọc output summary

Đọc summary theo checklist sau:

1. `iterations` có bằng `90` không?
2. `shared_jobs_total` có bằng `90` không?
3. `shared_jobs_failed` có bằng `0` không?
4. `checks` có pass 100% không?
5. `http_req_failed` có bằng 0 không?
6. `http_reqs` và `shared_api_calls_total` có bằng `90 × 2 = 180` không?
7. `shared_job_duration_ms` có count bằng `90` không?

Các điểm case-specific:

- `iterations = 90` nghĩa là 90 stale item jobs đã xử lý.
- `http_reqs = 180` vì mỗi job update rồi summary verify.
- `shared_jobs_failed = 0` mới chứng minh không item nào cleanup fail.

Đừng bịa thêm per-VU fairness từ summary. Với shared pool, summary không cần chứng minh mỗi VU xử lý cùng số job.

## Đọc dashboard real-time charts cho case 04

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
| `cart_item_cleanup_update` | 90 |
| `cart_cleanup_summary_verify` | 90 |

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

- Response time nên so update vs summary; update có db_writes nên có thể chậm hơn.
- Execution timeline phải sum 90 iterations, 180 http_reqs.
- VUs vs iter/s cho biết 8 worker xử lý backlog đều đặn không, không chứng minh race condition.

### Chart 2 — Execution timeline

Chart này dùng để kiểm backlog drain có đủ không.

Kiểm tổng:

```text
sum(iterations buckets) == 90
sum(http_reqs buckets) == 90 × 2 = 180
sum(shared_jobs_total buckets) == 90
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
- Khi còn backlog: VUs gần configured VUs (8)
- Khi backlog gần hết: VUs có thể tụt ở tail
- iter/s cao thấp tùy latency và số API/job
```

Điểm quan trọng:

```text
VUs ổn định không chứng minh chia đều job.
Tail VUs tụt không phải lỗi nếu iterations/shared_jobs_total vẫn đủ.
```

### Checklist đọc biểu đồ case 04

```text
[ ] Response time đã tách operation chưa?
[ ] Execution timeline cộng iterations ra 90 chưa?
[ ] Execution timeline cộng http_reqs ra 90 × 2 = 180 chưa?
[ ] shared_jobs_total == 90 chưa?
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

## Kết luận thực tế: team cart/backend quyết định gì?

Team cart/backend có thể coi cleanup pass khi đủ 90 jobs, update và summary đều đủ 90 call, không job failed. Nếu chỉ update pass nhưng summary fail/thiếu, chưa có bằng chứng dữ liệu sau cleanup đúng.

## Mở rộng

- Thêm job type delete/update/expire để phân tích theo operation.
- Tăng db_rows/json_items để mô phỏng cart lớn.
- Thêm custom counter cho item_deleted/item_updated nếu BE trả action.

## Anti-pattern

- Dùng case này để kết luận không có lost-update same-user; đó là mục tiêu của per-vu cart concurrency.
- Bỏ summary verify để giảm request rồi vẫn nói cleanup đúng.
- Map stale item theo `__VU` làm mất coverage backlog.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-04-cart-cleanup.js`
