# Case 06: Report export batch

## Tình huống thực tế

Team report/data cần verify một batch export jobs: tạo report, kiểm tra status, rồi download artifact. Đây là flow lifecycle, không phải một request đơn lẻ.

Nếu chỉ create job thành công nhưng status/download fail, user vẫn không lấy được report. Vì vậy job chỉ pass khi full lifecycle pass.

Case này trả lời: 6 workers có xử lý đủ 60 report lifecycle jobs không, và mỗi job có đủ create/status/download không?

Tóm tắt đời thường:

```text
Trigger: nightly report export, migration report service, storage pipeline change, hoặc regression cho report worker
Backlog: 60 report export lifecycle jobs
Risk nếu skip job: report accepted nhưng không generated/download được, hoặc artifact path bị lỗi
```

Case này **không** cố gắng trả lời “production traffic giống thật chưa?”. Nó trả lời câu hỏi batch/ops cụ thể hơn:

```text
Có xử lý đủ fixed backlog không?
Mỗi job có đi đúng business flow không?
Có job nào fail không?
```

## Yêu cầu cứng của case này

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Tổng completed iterations phải bằng `60` | Vì `60` là kích thước backlog, thiếu 1 job là coverage incomplete. |
| `shared_jobs_total == 60` | Iteration chạy xong chưa đủ; job phải được mark hoàn tất end-to-end. |
| `shared_jobs_failed == 0` | Có failed job nghĩa là business contract không đạt. |
| `http_reqs/shared_api_calls_total == 60 × 3 = 180` | Mỗi job phải gọi đúng số API trong flow. |
| Operation counts phải khớp expected breakdown | Tổng HTTP đúng nhưng thiếu một operation vẫn là coverage bug. |
| Job identity phải derive từ `exec.scenario.iterationInTest` | Worker identity `__VU` không đại diện cho business job. |
| Uneven per-VU distribution is normal | Worker nhanh xử lý nhiều job hơn là đúng mô hình shared pool. |

Nếu một trong các invariant về count/job fail, kết quả nên coi là **invalid hoặc fail**, không phải “pass nhưng hơi thiếu”.

## Vì sao "report export lifecycle batch" nên dùng `shared-iterations`?

Mental model đúng:

```text
60 jobs đang nằm trong một queue/backlog.
6 VUs là 6 workers.
Worker nào rảnh thì lấy job kế tiếp.
Batch kết thúc khi queue hết job.
```

Nếu worker A xử lý 20 job còn worker B xử lý 8 job, điều đó không làm test sai. Nó chỉ nói worker A nhận được nhiều job hơn vì vòng lặp của nó quay lại sớm hơn.

### Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho fixed backlog? |
| --- | --- | --- |
| `shared-iterations` | Có tổng `iterations` chung và nhiều VU cùng chạy | **Đúng**: mô hình đúng là N job trong backlog, M worker xử lý đến khi hết việc. |
| `per-vu-iterations` | Count cũng deterministic | Sai nếu VU không phải business identity. Nó ép mỗi VU làm quota bằng nhau, không giống worker queue. |
| `constant-vus` | Nhìn giống worker pool | Sai khi cần exact count: tổng việc phụ thuộc duration và latency, không bảo đảm xử lý đúng N job. |
| `constant-arrival-rate` | Kiểm soát được tốc độ vào | Sai cho batch drain: nó schedule arrivals theo rate, có thể drop, không phải danh sách job cố định cần xử lý hết. |
| `ramping-vus` | Có thể tăng/giảm worker | Sai nếu mục tiêu là exact backlog completion; shape VU biến thiên làm khó so sánh coverage. |
| `ramping-arrival-rate` | Mô phỏng traffic thay đổi | Sai cho fixed-job coverage; phù hợp traffic surge hơn là batch/checklist. |

Kết luận:

```text
Cần exact total backlog coverage -> shared-iterations.
Không cần mỗi VU có quota riêng -> không dùng per-vu-iterations.
Không lấy duration/rate làm input chính -> không dùng constant-vus/arrival-rate.
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

| Config/env | Giá trị | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `SI_06_VUS` | 6 | Số worker cùng xử lý backlog |
| `SI_06_JOBS` | 60 | Tổng số job toàn scenario |
| `SI_06_READY_AFTER_MS` | 1 | Case-specific behavior |
| `maxDuration` | 12m | Safety cap, không phải target duration |
| `executor` | `shared-iterations` | Fixed global backlog + worker pool |

Mapping quan trọng:

```text
business backlog size = 60 jobs
k6 iterations         = 60
worker pool size      = 6 VUs
expected API calls    = 60 × 3 = 180
```

`maxDuration` chỉ là safety cap. Nếu cap này cắt run làm `iterations < 60`, kết quả không valid vì backlog chưa drain hết.

Operation coverage expected:

```text
report_job_create: 60
report_job_status: 60
report_job_download: 60
```

## Technical semantics: shared backlog, worker pool, job identity

Cách k6 vận hành nên được hiểu như sau:

```text
1. Scenario có một global quota: iterations = 60.
2. Mỗi VU là worker, không phải user/business entity.
3. VU lấy global iteration/job kế tiếp từ pool chung.
4. VU nhanh có thể lấy thêm nhiều job.
5. Scenario kết thúc khi global quota hết hoặc bị maxDuration/interruption cắt.
```

Do đó:

```text
__VU is worker, not business identity
__ITER is per-worker local counter, not global job id
exec.scenario.iterationInTest is the stable global job index
iterations is total jobs
uneven per-VU distribution is normal
```

Nếu script cần chọn business object như product/order/event/item/report/checklist, derive từ:

```js
exec.scenario.iterationInTest
```

Không derive từ:

```js
__VU
```

vì `__VU` chỉ nói worker nào đang cầm job hiện tại.

## Technical root causes this case catches

### Nguyên nhân kỹ thuật 1: Lifecycle job semantics

Report export không hoàn tất ở create. Job chỉ complete khi create, status, và download đều pass.

### Nguyên nhân kỹ thuật 2: Async readiness

HTTP 202 từ create nghĩa là accepted, không phải generated. Status/download mới chứng minh async pipeline đã hoàn thành.

### Nguyên nhân kỹ thuật 3: Per-job state must stay local

Returned `job_id` thuộc về một job iteration. Không lưu như worker-level state hay derive từ `__VU`.

### Nguyên nhân kỹ thuật 4: End-to-end duration matters

`shared_job_duration_ms` quan trọng hơn single request duration vì user quan tâm full export lifecycle.

## Service/API flow

| Operation | Method | Path | Service | Expected | Expected count | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| report_job_create | `POST` | `/api/sim/report/jobs?report_type=...&cpu_ms=2&db_rows=2&gzip_kb=4&ready_after_ms=...` | report-service | `202` | 60 | Create async report job. |
| report_job_status | `GET` | `/api/sim/report/jobs/:id?cpu_ms=1&db_rows=1` | report-service | `200` | 60 | Check generated job status. |
| report_job_download | `GET` | `/api/sim/report/jobs/:id/download?cpu_ms=1&gzip_kb=4` | report-service | `200` | 60 | Download report artifact. |

Một job chỉ được coi là hoàn tất khi các operation cần thiết của job đó đã pass theo contract.

## Metrics và tags cần đọc

| Metric | Type | Expected | Nó chứng minh gì? |
| --- | --- | --- | --- |
| `shared_jobs_total` | Counter | `count == JOBS` | Bao nhiêu business job đã hoàn tất end-to-end. |
| `shared_jobs_failed` | Counter | `count == 0` | Có job nào fail ở tầng business không. |
| `shared_api_calls_total` | Counter | khớp công thức API/job | Helper đã gửi đúng số API calls theo flow chưa. |
| `shared_job_duration_ms` | Trend | `count == JOBS` | Thời gian end-to-end của từng job, không chỉ từng request. |
| `shared_sleep_seconds` | Counter | tùy case | Tổng sleep/think/wait time nếu script mô phỏng delay. |

Tags chung:

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `si-02-order-reconciliation`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service đang được gọi. |
| `operation` | Bước nghiệp vụ/API cụ thể trong job. |
| `endpoint` | Nhóm endpoint/API family. |
| `job_id` | Business job trong backlog, derive từ global job index. |
| `executor_family` | `shared_iterations`. |
| `workload_shape` | `fixed_backlog`. |

Tags case này:

```text
case_id       = si-06-report-export-batch
business_case = report_export_batch
service       = report-service
```

## Pass criteria

Pass criteria tối thiểu:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 60
shared_jobs_failed count == 0
iterations count == 60
http_reqs count == 180
shared_api_calls_total count == 180
```

Operation breakdown phải khớp:

```text
report_job_create: 60
report_job_status: 60
report_job_download: 60
```

Đừng thêm pass condition kiểu:

```text
mỗi VU phải xử lý 60 / 6 jobs
```

Vì đó không phải invariant của `shared-iterations`.

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

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js
```

Nếu backend script chưa có trong working tree, chỉ đọc phần expected formula trước; không tự điền run data.

## Đọc output summary

Áp 5 bước giống cách đọc các case per-vu, nhưng invariant đổi sang **total backlog**, không phải per-user quota.

### Bước 1 — Verify scenario/config

Header phải thể hiện:

```text
executor = shared-iterations
vus = 6 hoặc env override
total iterations/jobs = 60 hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ expected counts.

### Bước 2 — Compute expected total jobs

Default case này:

```text
JOBS = 60
API_PER_JOB = 3
expected iterations = 60
expected http_reqs = 60 × 3 = 180
```

### Bước 3 — Compare summary counters

Expected:

```text
iterations == 60
shared_jobs_total == 60
shared_jobs_failed == 0
```

Nếu `iterations < 60`:

```text
backlog chưa drain hết -> invalid result
```

Nếu `iterations == 60` nhưng `shared_jobs_total < 60`:

```text
iteration chạy xong nhưng job completion instrumentation/business branch bị thiếu
```

### Bước 4 — Compare API and operation counts

Expected:

```text
http_reqs == 180
shared_api_calls_total == 180
report_job_create: 60
report_job_status: 60
report_job_download: 60
```

Tổng HTTP đúng nhưng operation split sai vẫn là coverage bug.

### Bước 5 — Interpret duration/throughput

`shared_job_duration_ms` trả lời:

```text
một business job end-to-end mất bao lâu
```

`http_req_duration` trả lời:

```text
mỗi request/API call mất bao lâu
```

Hai metric này khác nhau. Job nhiều API có thể có từng request nhanh nhưng full lifecycle vẫn chậm.

Case-specific summary notes:

- `iterations = 60` chứng minh 60 report lifecycle jobs chạy.
- `http_reqs = 180` vì mỗi job có create + status + download.
- `shared_job_duration_ms` là metric chính để đọc full lifecycle latency.

Không check mỗi VU làm bằng nhau. Invariant là total completed work, không phải equal work per VU.

## Đọc dashboard real-time charts cho case 06

> Phần này mô tả expected reading. Chỉ bổ sung run ID, p95/p99/max, bucket arrays sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? bucket nào có tail latency? | Backlog đã xử lý đủ chưa |
| Execution timeline | Theo thời gian đã hoàn tất bao nhiêu iterations/http_reqs/jobs? | Mỗi VU có làm bằng nhau không |
| VUs vs iter/s | Worker pool drain backlog nhanh/chậm ra sao? | Business correctness của từng job |

### Chart 1 — Response time

Đây là request-level latency. Với case này, đọc theo `operation`:

```text
report_job_create: 60
report_job_status: 60
report_job_download: 60
```

Cách đọc:

```text
avg  -> request thường nhanh/chậm thế nào
p95  -> phần lớn request có tail tới đâu
p99  -> tail hiếm hơn
max  -> spike lớn nhất trong bucket/run
```

Nhưng đừng kết luận pass/fail chỉ từ latency. Response time chỉ giúp tìm bottleneck.

Case-specific bottleneck hints:

- `report_job_create` kiểm accepted path, expected 202.
- `report_job_status` expose readiness/worker latency.
- `report_job_download` expose artifact/storage/gzip path; download spike khác create spike.

### Chart 2 — Execution timeline

Chart này chứng minh backlog drain đủ theo thời gian.

Kiểm tổng bucket:

```text
sum(iterations buckets) == 60
sum(http_reqs buckets) == 180
sum(shared_jobs_total buckets) == 60
sum(shared_jobs_failed buckets) == 0
```

Invalid patterns:

| Pattern | Nghĩa |
| --- | --- |
| `iterations` đủ nhưng `shared_jobs_total` thiếu | iteration complete nhưng business job chưa mark done |
| `http_reqs` đủ nhưng operation split sai | tổng request đủ nhưng coverage lệch |
| `shared_jobs_failed > 0` | business failure dù HTTP có thể vẫn 200 |
| buckets không cộng ra summary | đọc nhầm point/bucket hoặc data chưa final |

Đừng nhầm:

```text
Mỗi point = 1 time bucket / metrics frame.
Không phải 1 request.
Không phải 1 job.
```

### Chart 3 — VUs vs iter/s

Chart này giải thích worker-pool shape:

```text
- VUs gần 6 khi backlog còn nhiều việc
- iter/s tăng/giảm theo latency và số API/job
- VUs có thể tụt ở tail khi backlog gần hết
- fast VUs có thể xử lý nhiều job hơn slow VUs
```

Đừng đọc chart này thành:

```text
mỗi VU phải xử lý 60 / 6 jobs
```

Với `shared-iterations`, đó là yêu cầu sai.

### Cách chốt từ summary -> 3 chart

```text
1. Summary quyết định pass/fail bằng counters/thresholds.
2. Execution timeline xác nhận backlog drain đủ theo thời gian.
3. Response time tìm operation/service chậm.
4. VUs vs iter/s giải thích worker pool hoạt động ra sao.
5. Business decision dựa trên total coverage + failed jobs + operation breakdown.
```

## Kết luận thực tế: output -> quyết định

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| create/status/download mỗi loại 60, no failed jobs | All report lifecycle jobs completed | Report batch passed |
| create 60, status < 60 | Accepted jobs not fully verified | Block |
| create/status 60, download < 60 | Artifacts not fully retrievable | Block |
| status timeout/not ready | Async worker/SLA issue | Investigate report worker |
| download failures | Artifact generation/storage path broken | Block |
| Counts pass but `shared_job_duration_ms` high | Functional pass, SLA risk | Investigate report pipeline |

## Mở rộng

- Thêm tag domain-specific để lọc theo nhóm job quan trọng.
- Tăng `JOBS` để mô phỏng backlog production lớn hơn.
- Thêm threshold latency theo `operation` nếu muốn chuyển từ functional batch sang performance gate.
- Khi có real run, bổ sung run ID, summary thật, operation breakdown thật, và bucket sums thật.

## Anti-pattern

- Dùng `__VU` làm business identity chính cho backlog.
- Fail test chỉ vì VU distribution không đều.
- Dùng `constant-vus` rồi suy ra exact job count từ duration.
- Dùng arrival-rate executor cho bài toán drain fixed queue.
- Chỉ nhìn response time đẹp mà không kiểm `shared_jobs_total` và operation counts.
- Giữ expected formulas cũ sau khi override `JOBS`.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-06-report-export-batch.js`
