# Case 06: Report export batch

## Tình huống thực tế

Batch create report jobs, poll/status check, rồi download report cho một danh sách export cố định.

Đây không phải bài mô phỏng user traffic mở theo thời gian. Đây là bài:

```text
fixed backlog + worker pool + drain until done
```

Nói đời thường:

```text
Có 60 job đang chờ.
Dùng 6 worker xử lý hết.
Ai xong trước thì lấy job tiếp theo.
Hoàn tất khi không còn job nào trong backlog.
```

## Vì sao case này hợp với `shared-iterations`?

Report export là lifecycle job rõ ràng: create → status → download. Có N report cần hoàn tất, worker pool xử lý hết backlog.

Đọc config:

```text
iterations = 60
```

nghĩa là:

```text
cả scenario có 60 job tổng cộng
```

không phải:

```text
mỗi VU chạy 60 job
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
| SI_06_VUS | 6 |
| SI_06_JOBS | 60 |
| SI_06_READY_AFTER_MS | 1 |
| maxDuration | 12m |
| executor | shared-iterations |
| script | `si-06-report-export-batch.js` |

Công thức chính:

```text
JOBS = 60
configured VUs = 6
expected iterations = 60
expected http_reqs = shared_api_calls_total = 60 × 3 = 180
```

## Backlog/job model

- Mỗi job là một report export request.
- Report type alternating `sales` và `inventory`.
- Job chỉ pass nếu create thành công và lấy được `job_id` để status/download.

Selector đúng cho business job là job index toàn scenario, ví dụ:

```js
exec.scenario.iterationInTest
```

Không dùng `__VU` làm identity chính cho backlog, vì `__VU` chỉ là worker đang cầm job hiện tại.

## Service/API flow

| Bước | Method | Path | Service | Operation | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `POST` | `/api/sim/report/jobs?report_type=...&cpu_ms=2&db_rows=2&gzip_kb=4&ready_after_ms=...` | `report-service` | `report_job_create` | `202` | Create async report job. |
| 2 | `GET` | `/api/sim/report/jobs/:id?cpu_ms=1&db_rows=1` | `report-service` | `report_job_status` | `200` | Check job status. |
| 3 | `GET` | `/api/sim/report/jobs/:id/download?cpu_ms=1&gzip_kb=4` | `report-service` | `report_job_download` | `200` | Download generated report. |

Expected operation breakdown:

| Operation | Expected count |
| --- | --- |
| `report_job_create` | 60 |
| `report_job_status` | 60 |
| `report_job_download` | 60 |

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
case_id       = si-06-report-export-batch
business_case = report_export_batch
service       = report-service
```

## Pass criteria

Pass khi cả 4 nhóm tín hiệu đều đúng:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 60
shared_jobs_failed count == 0
```

Và count theo công thức phải khớp:

```text
iterations = 60
http_reqs = shared_api_calls_total = 60 × 3 = 180
```

Nếu có tag breakdown theo `operation`, expected là:

```text
report_job_create: 60
```

```text
report_job_status: 60
```

```text
report_job_download: 60
```

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-06-report-export-batch.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js
```

Run lên private dashboard nếu dùng cloud output:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js
```

Có thể override workload bằng env vars trong bảng config ở trên, ví dụ:

```powershell
$env:SI_06_JOBS = "20"
$env:SI_06_VUS = "4"
```

## Đọc output summary

Đọc summary theo checklist sau:

1. `iterations` có bằng `60` không?
2. `shared_jobs_total` có bằng `60` không?
3. `shared_jobs_failed` có bằng `0` không?
4. `checks` có pass 100% không?
5. `http_req_failed` có bằng 0 không?
6. `http_reqs` và `shared_api_calls_total` có bằng `60 × 3 = 180` không?
7. `shared_job_duration_ms` có count bằng `60` không?

Các điểm case-specific:

- `iterations = 60` nghĩa là 60 report lifecycle jobs hoàn tất.
- `http_reqs = 180` vì mỗi job có create/status/download.
- `shared_job_duration_ms` quan trọng hơn từng request riêng lẻ vì user quan tâm full lifecycle.

Đừng bịa thêm per-VU fairness từ summary. Với shared pool, summary không cần chứng minh mỗi VU xử lý cùng số job.

## Đọc dashboard real-time charts cho case 06

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
| `report_job_create` | 60 |
| `report_job_status` | 60 |
| `report_job_download` | 60 |

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

- Response time nên tách create/status/download; download có gzip_kb nên có thể có tail latency riêng.
- Execution timeline phải sum 60 iterations và 180 http_reqs.
- Nên đọc thêm `shared_job_duration_ms` để biết report lifecycle end-to-end.

### Chart 2 — Execution timeline

Chart này dùng để kiểm backlog drain có đủ không.

Kiểm tổng:

```text
sum(iterations buckets) == 60
sum(http_reqs buckets) == 60 × 3 = 180
sum(shared_jobs_total buckets) == 60
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
- Khi còn backlog: VUs gần configured VUs (6)
- Khi backlog gần hết: VUs có thể tụt ở tail
- iter/s cao thấp tùy latency và số API/job
```

Điểm quan trọng:

```text
VUs ổn định không chứng minh chia đều job.
Tail VUs tụt không phải lỗi nếu iterations/shared_jobs_total vẫn đủ.
```

### Checklist đọc biểu đồ case 06

```text
[ ] Response time đã tách operation chưa?
[ ] Execution timeline cộng iterations ra 60 chưa?
[ ] Execution timeline cộng http_reqs ra 60 × 3 = 180 chưa?
[ ] shared_jobs_total == 60 chưa?
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

## Kết luận thực tế: team report/data quyết định gì?

Team report/data pass batch khi 60 report jobs đều create được, status được, download được, và `shared_jobs_failed=0`. Nếu create 202 đủ nhưng download thiếu, batch chưa đạt vì artifact cuối chưa được lấy.

## Mở rộng

- Tăng `SI_06_READY_AFTER_MS` để mô phỏng report lâu hơn.
- Tách sales/inventory tag để so lifecycle latency.
- Thêm nhiều lần status poll nếu BE async thật.

## Anti-pattern

- Chỉ nhìn create 202 rồi kết luận report export OK.
- Dùng response time của status để đại diện cả job lifecycle.
- Bỏ qua `shared_job_duration_ms` khi phân tích batch report.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-06-report-export-batch.js`
