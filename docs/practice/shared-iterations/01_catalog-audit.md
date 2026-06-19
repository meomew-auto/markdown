# Case 01: Catalog audit

## Tình huống thực tế

Audit một backlog SKU/product cố định sau deploy, sau sync catalog, hoặc sau khi import dữ liệu sản phẩm.

Đây không phải bài mô phỏng user traffic mở theo thời gian. Đây là bài:

```text
fixed backlog + worker pool + drain until done
```

Nói đời thường:

```text
Có 80 job đang chờ.
Dùng 8 worker xử lý hết.
Ai xong trước thì lấy job tiếp theo.
Hoàn tất khi không còn job nào trong backlog.
```

## Vì sao case này hợp với `shared-iterations`?

Backlog SKU đã biết trước. Mục tiêu không phải mô phỏng 8 user, mà là dùng 8 worker cùng audit đủ 80 product jobs càng nhanh càng tốt.

Đọc config:

```text
iterations = 80
```

nghĩa là:

```text
cả scenario có 80 job tổng cộng
```

không phải:

```text
mỗi VU chạy 80 job
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
| SI_01_VUS | 8 |
| SI_01_JOBS | 80 |
| maxDuration | 8m |
| executor | shared-iterations |
| script | `si-01-catalog-audit.js` |

Công thức chính:

```text
JOBS = 80
configured VUs = 8
expected iterations = 80
expected http_reqs = shared_api_calls_total = 80 × 2 = 160
```

## Backlog/job model

- Mỗi job tương ứng một product/SKU cần audit.
- Job ID dạng `catalog-audit-N`.
- Product ID được derive từ số thứ tự job trong backlog, không derive từ `__VU`.

Selector đúng cho business job là job index toàn scenario, ví dụ:

```js
exec.scenario.iterationInTest
```

Không dùng `__VU` làm identity chính cho backlog, vì `__VU` chỉ là worker đang cầm job hiện tại.

## Service/API flow

| Bước | Method | Path | Service | Operation | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `GET` | `/api/sim/products?limit=10&sort=popular&view=grid&include_facets=1&cpu_ms=2&db_rows=4&json_items=10` | `products-service` | `catalog_list_audit` | `200` | Audit list/search surface. |
| 2 | `GET` | `/api/sim/products/:id?view=full&include_reviews=1&cpu_ms=2&db_rows=2` | `products-service` | `catalog_detail_audit` | `200` | Audit detail page của SKU/job đó. |

Expected operation breakdown:

| Operation | Expected count |
| --- | --- |
| `catalog_list_audit` | 80 |
| `catalog_detail_audit` | 80 |

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
case_id       = si-01-catalog-audit
business_case = product_catalog_audit
service       = products-service
```

## Pass criteria

Pass khi cả 4 nhóm tín hiệu đều đúng:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 80
shared_jobs_failed count == 0
```

Và count theo công thức phải khớp:

```text
iterations = 80
http_reqs = shared_api_calls_total = 80 × 2 = 160
```

Nếu có tag breakdown theo `operation`, expected là:

```text
catalog_list_audit: 80
```

```text
catalog_detail_audit: 80
```

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-01-catalog-audit.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js
```

Run lên private dashboard nếu dùng cloud output:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js
```

Có thể override workload bằng env vars trong bảng config ở trên, ví dụ:

```powershell
$env:SI_01_JOBS = "20"
$env:SI_01_VUS = "4"
```

## Đọc output summary

Đọc summary theo checklist sau:

1. `iterations` có bằng `80` không?
2. `shared_jobs_total` có bằng `80` không?
3. `shared_jobs_failed` có bằng `0` không?
4. `checks` có pass 100% không?
5. `http_req_failed` có bằng 0 không?
6. `http_reqs` và `shared_api_calls_total` có bằng `80 × 2 = 160` không?
7. `shared_job_duration_ms` có count bằng `80` không?

Các điểm case-specific:

- `iterations = 80` nghĩa là audit đủ 80 job, không phải `8 × 80`.
- `http_reqs = 160` vì mỗi job gọi list và detail.
- Nếu list pass nhưng detail fail thì vẫn là job fail vì audit chưa đủ contract.

Đừng bịa thêm per-VU fairness từ summary. Với shared pool, summary không cần chứng minh mỗi VU xử lý cùng số job.

## Đọc dashboard real-time charts cho case 01

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
| `catalog_list_audit` | 80 |
| `catalog_detail_audit` | 80 |

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

- Response time nên tách `catalog_list_audit` và `catalog_detail_audit`; list có thể nặng hơn vì include facets/json_items.
- Execution timeline phải cộng được 80 iterations và 160 http_reqs.
- VUs vs iter/s cho biết 8 worker drain backlog nhanh hay chậm, không nói mỗi worker audit đúng 10 SKU.

### Chart 2 — Execution timeline

Chart này dùng để kiểm backlog drain có đủ không.

Kiểm tổng:

```text
sum(iterations buckets) == 80
sum(http_reqs buckets) == 80 × 2 = 160
sum(shared_jobs_total buckets) == 80
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

### Checklist đọc biểu đồ case 01

```text
[ ] Response time đã tách operation chưa?
[ ] Execution timeline cộng iterations ra 80 chưa?
[ ] Execution timeline cộng http_reqs ra 80 × 2 = 160 chưa?
[ ] shared_jobs_total == 80 chưa?
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

## Kết luận thực tế: team catalog/product quyết định gì?

Nếu 80 jobs pass và 160 API calls đều 200, team catalog có thể tin rằng backlog audit sau deploy đã chạy đủ. Nếu chỉ thiếu vài detail call, không nên coi deploy pass vì có SKU chưa được kiểm.

## Mở rộng

- Tăng `SI_01_JOBS` theo số SKU thật.
- Thêm tag category/brand để dashboard tìm nhóm sản phẩm chậm.
- Thêm check schema/detail fields nếu muốn audit data quality.

## Anti-pattern

- Dùng `__VU` làm product ID rồi nghĩ đã audit đủ SKU.
- Chỉ nhìn p95 thấp mà bỏ qua `shared_jobs_total < 80`.
- Đọc `iterations: 80` thành mỗi VU audit 80 products.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-01-catalog-audit.js`
