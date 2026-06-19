# Case 05: Cache warm

## Tình huống thực tế

Warm một danh sách URL cố định sau deploy hoặc catalog change: homefeed và product detail.

Đây không phải bài mô phỏng user traffic mở theo thời gian. Đây là bài:

```text
fixed backlog + worker pool + drain until done
```

Nói đời thường:

```text
Có 120 job đang chờ.
Dùng 12 worker xử lý hết.
Ai xong trước thì lấy job tiếp theo.
Hoàn tất khi không còn job nào trong backlog.
```

## Vì sao case này hợp với `shared-iterations`?

Cache warm là finite URL backlog. Nhiều worker cùng gọi hết danh sách; không có khái niệm user identity cố định.

Đọc config:

```text
iterations = 120
```

nghĩa là:

```text
cả scenario có 120 job tổng cộng
```

không phải:

```text
mỗi VU chạy 120 job
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
| SI_05_VUS | 12 |
| SI_05_JOBS | 120 |
| maxDuration | 8m |
| executor | shared-iterations |
| script | `si-05-cache-warm.js` |

Công thức chính:

```text
JOBS = 120
configured VUs = 12
expected iterations = 120
expected http_reqs = shared_api_calls_total = 120 × 1 = 120
```

## Backlog/job model

- Mỗi job là một URL cần warm.
- Default alternating giữa `homefeed` và `detail`.
- Geo/device headers giúp mô phỏng cache key khác nhau.

Selector đúng cho business job là job index toàn scenario, ví dụ:

```js
exec.scenario.iterationInTest
```

Không dùng `__VU` làm identity chính cho backlog, vì `__VU` chỉ là worker đang cầm job hiện tại.

## Service/API flow

| Bước | Method | Path | Service | Operation | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| A | `GET` | `/api/sim/products/homefeed?personalized=1&cpu_ms=2&db_rows=5&json_items=16` | `products-service` | `cache_warm_homefeed` | `200` | Warm homefeed cache key. |
| B | `GET` | `/api/sim/products/:id?view=full&include_reviews=1&cpu_ms=2&db_rows=2` | `products-service` | `cache_warm_detail` | `200` | Warm product detail cache key. |

Expected operation breakdown:

| Operation | Expected count |
| --- | --- |
| `cache_warm_homefeed` | 60 |
| `cache_warm_detail` | 60 |

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
case_id       = si-05-cache-warm
business_case = cache_warm_after_deploy
service       = products-service
```

## Pass criteria

Pass khi cả 4 nhóm tín hiệu đều đúng:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 120
shared_jobs_failed count == 0
```

Và count theo công thức phải khớp:

```text
iterations = 120
http_reqs = shared_api_calls_total = 120 × 1 = 120
```

Nếu có tag breakdown theo `operation`, expected là:

```text
cache_warm_homefeed: 60
```

```text
cache_warm_detail: 60
```

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-05-cache-warm.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-05-cache-warm.js
```

Run lên private dashboard nếu dùng cloud output:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-05-cache-warm.js
```

Có thể override workload bằng env vars trong bảng config ở trên, ví dụ:

```powershell
$env:SI_05_JOBS = "20"
$env:SI_05_VUS = "4"
```

## Đọc output summary

Đọc summary theo checklist sau:

1. `iterations` có bằng `120` không?
2. `shared_jobs_total` có bằng `120` không?
3. `shared_jobs_failed` có bằng `0` không?
4. `checks` có pass 100% không?
5. `http_req_failed` có bằng 0 không?
6. `http_reqs` và `shared_api_calls_total` có bằng `120 × 1 = 120` không?
7. `shared_job_duration_ms` có count bằng `120` không?

Các điểm case-specific:

- `iterations = 120` nghĩa là warm đủ 120 URL jobs.
- `http_reqs = 120` vì mỗi job warm đúng một URL.
- Với default split chẵn, homefeed 60 và detail 60.

Đừng bịa thêm per-VU fairness từ summary. Với shared pool, summary không cần chứng minh mỗi VU xử lý cùng số job.

## Đọc dashboard real-time charts cho case 05

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
| `cache_warm_homefeed` | 60 |
| `cache_warm_detail` | 60 |

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

- Response time nên tách homefeed/detail; homefeed có json_items/db_rows nhiều hơn nên có thể nặng hơn.
- Execution timeline phải sum 120 iterations và 120 http_reqs.
- VUs vs iter/s cho biết 12 worker warm list nhanh hay bị bottleneck.

### Chart 2 — Execution timeline

Chart này dùng để kiểm backlog drain có đủ không.

Kiểm tổng:

```text
sum(iterations buckets) == 120
sum(http_reqs buckets) == 120 × 1 = 120
sum(shared_jobs_total buckets) == 120
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
- Khi còn backlog: VUs gần configured VUs (12)
- Khi backlog gần hết: VUs có thể tụt ở tail
- iter/s cao thấp tùy latency và số API/job
```

Điểm quan trọng:

```text
VUs ổn định không chứng minh chia đều job.
Tail VUs tụt không phải lỗi nếu iterations/shared_jobs_total vẫn đủ.
```

### Checklist đọc biểu đồ case 05

```text
[ ] Response time đã tách operation chưa?
[ ] Execution timeline cộng iterations ra 120 chưa?
[ ] Execution timeline cộng http_reqs ra 120 × 1 = 120 chưa?
[ ] shared_jobs_total == 120 chưa?
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

## Kết luận thực tế: team platform/product quyết định gì?

Team platform/product có thể mở traffic sau deploy khi fixed warm list đã drain đủ, không fail, và operation split đúng. Nếu warm thiếu URL, dashboard latency đẹp cũng không đủ vì cache coverage chưa hoàn tất.

## Mở rộng

- Thêm geo/device vào tag để xem cache key nào chậm.
- Tăng JOBS theo URL list production.
- Chạy vòng 2 để so cold-warm latency nếu BE/cache hỗ trợ.

## Anti-pattern

- Dùng aggregate p95 để kết luận mọi URL đã warm.
- Không tách homefeed/detail nên không biết nhóm nào chậm.
- Kỳ vọng mỗi VU warm đúng 10 URL; worker nhanh có thể làm nhiều hơn.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-05-cache-warm.js`
