# Case 06: Report export batch

## Tình huống thực tế

Team report/data cần verify một batch export jobs: tạo report, poll trạng thái cho tới khi report hoàn tất, rồi download artifact. Đây là **async lifecycle flow**, không phải một HTTP request đơn lẻ.

```text
Backlog cố định: 60 report export jobs
Worker pool: 6 VUs
Mỗi job: create -> poll status until completed -> download
Kết luận PASS chỉ khi đủ 60 job đều hoàn tất lifecycle
```

Trong thực tế, endpoint download có thể trả `202 processing` nếu report chưa sẵn sàng. Điều đó **không phải bug HTTP**. Client đúng phải poll status body `data.status` tới khi `completed`, rồi mới download và expect `200`.

## Yêu cầu cứng của case này

| Requirement | Vì sao quan trọng |
| --- | --- |
| `iterations == 60` | Đủ fixed backlog jobs, không bỏ sót report nào. |
| `shared_jobs_total == 60` | Mỗi business job được ghi nhận đúng một lần. |
| `shared_jobs_failed == 0` | Không job nào fail ở create/status/download lifecycle. |
| `checks rate == 1` | Tất cả HTTP/status/lifecycle checks đều pass. |
| `http_req_failed rate == 0` | Không có HTTP request bị k6 đánh dấu failed. |
| `report_job_create == 60` | Mỗi job phải tạo async report request. |
| `report_job_status >= 60` | Mỗi job phải poll status ít nhất một lần; có thể nhiều hơn nếu chưa ready. |
| `report_job_download == 60` | Mỗi job phải download artifact thành công sau khi completed. |

Công thức API sau khi dùng polling:

```text
http_reqs = create_count + status_poll_count + download_count
          = 60 + status_poll_count + 60
          = 120 + status_poll_count

Trong đó:
  status_poll_count >= 60
```

Vì vậy **không được hard-code `http_reqs = 180`** nữa. Nếu backend ready ngay ở lần poll đầu, tổng có thể là 180. Nếu cần poll thêm, tổng sẽ lớn hơn 180 và vẫn đúng.

## Vì sao case này nên dùng `shared-iterations`?

`shared-iterations` phù hợp khi có một backlog hữu hạn cần drain hết:

```text
60 report jobs là 60 đơn vị công việc cố định.
6 VUs là 6 workers lấy job từ backlog chung.
Worker nào xong trước lấy job tiếp theo.
Kết thúc khi đủ 60 iterations hoàn tất.
```

Điểm cần đo không phải “mỗi user làm bao nhiêu việc”, mà là:

```text
pool 6 workers có drain đủ 60 async report jobs không?
job lifecycle end-to-end nhanh/chậm thế nào?
status polling có tăng bất thường không?
download artifact có đủ 60/60 không?
```

## Vì sao không dùng executor khác?

| Executor | Vì sao không phù hợp bằng |
| --- | --- |
| `constant-vus` | Chạy theo duration, số job hoàn tất phụ thuộc latency/readiness delay; không guarantee đúng 60 report jobs. |
| `per-vu-iterations` | Phân quota cố định cho từng VU, trong khi batch thực tế là worker pool chung; VU nhanh/chậm nên tự chia việc không đều. |
| `constant-arrival-rate` | Điều khiển arrival rate, có thể drop slots nếu async lifecycle chậm; không đảm bảo backlog coverage. |
| `ramping-vus` | Dùng cho active users theo thời gian, không phải fixed report backlog. |
| `ramping-arrival-rate` | Dùng cho rate curve, không phải danh sách report jobs cần hoàn tất đủ. |

## Config mapping

Script backend:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js
```

Default config:

| Env | Default | Ý nghĩa |
| --- | ---: | --- |
| `SI_06_VUS` | `6` | Số workers xử lý backlog. |
| `SI_06_JOBS` | `60` | Tổng report lifecycle jobs cần xử lý. |
| `SI_06_READY_AFTER_MS` | `100` | Thời gian backend mô phỏng report generation trước khi completed. |
| `SI_06_STATUS_POLL_INTERVAL_MS` | `25` | Khoảng nghỉ giữa các lần status poll nếu còn `processing`. |
| `SI_06_STATUS_TIMEOUT_MS` | `5000` | Timeout tối đa cho một job chờ completed. |
| `SI_06_SLEEP_SECONDS` | `0` | Pause tùy chọn sau mỗi job. |

Lý do default `READY_AFTER_MS=100`: backend report-service clamp readiness tối thiểu 100ms. Đây là realistic hơn `1ms`, và tránh dạy learner rằng async report job có thể download deterministic sau 1ms.

## Backend async contract

Backend report-service có semantics thực tế:

```text
POST /api/sim/report/jobs
  -> HTTP 202
  -> body data.job_id
  -> body data.status = queued
  -> body data.poll_after_ms

GET /api/sim/report/jobs/:id
  -> HTTP 200 nếu job tồn tại
  -> body data.status = processing hoặc completed
  -> body data.eta_ms

GET /api/sim/report/jobs/:id/download
  -> HTTP 202 nếu report còn processing
  -> HTTP 200 nếu report completed
```

Vì vậy, status endpoint HTTP `200` **chưa đủ** để kết luận report ready. Phải đọc body:

```text
HTTP 200 + data.status="processing"  -> poll tiếp
HTTP 200 + data.status="completed"   -> được download
```

## Service/API flow

Mỗi business job chạy theo flow:

```text
1. POST /api/sim/report/jobs?report_type=<sales|inventory>&ready_after_ms=100
   expected HTTP 202
   extract data.job_id

2. Poll GET /api/sim/report/jobs/:id
   expected HTTP 200
   repeat while data.status == "processing"
   success only when data.status == "completed"

3. GET /api/sim/report/jobs/:id/download
   expected HTTP 200
```

Operation tags:

| Operation | Service | Expected count |
| --- | --- | ---: |
| `report_job_create` | `report-service` | `60` |
| `report_job_status` | `report-service` | `>= 60` |
| `report_job_download` | `report-service` | `60` |
| `report_export_job` | `report-service` | `60` business jobs |

## Technical root causes case này bắt được

### 1. Async readiness race

Bug thường gặp:

```text
create 202 -> sleep cố định quá ngắn -> download ngay -> nhận 202 processing
```

Case đúng phải poll status body. Nếu script thấy download `202` trong successful run, nghĩa là script download quá sớm hoặc status completed check không đúng.

### 2. Status HTTP 200 bị hiểu nhầm là ready

Status endpoint trả HTTP `200` cho cả `processing` và `completed`. Nếu chỉ check HTTP code, test có thể false positive.

Đúng:

```text
status.ok && response.json('data.status') == 'completed'
```

### 3. Hidden lifecycle failure

Nếu chỉ nhìn create `202`, report có thể vẫn fail ở status/download. Business job chỉ pass khi đủ lifecycle.

### 4. Poll storm / worker backlog

Nếu `report_job_status` count tăng quá cao so với jobs, có thể:

```text
READY_AFTER_MS quá lớn
report worker/storage chậm
poll interval quá ngắn
client poll quá dày gây thêm load
```

### 5. Incorrect identity mapping

Mỗi iteration phải có job identity riêng dựa trên `exec.scenario.iterationInTest`, không dựa vào `__VU`. Nếu lưu `job_id` ở worker-level state và reuse, có thể download lặp cùng artifact, bỏ sót nhiều jobs.

## Metrics và tags cần đọc

| Metric | Cách đọc trong case này |
| --- | --- |
| `iterations` | Số report jobs hoàn tất iteration; phải bằng `JOBS`. |
| `http_reqs` | Tổng HTTP calls; bằng `120 + status_poll_count`, không cố định 180. |
| `checks` | HTTP checks + final lifecycle completed check. |
| `http_req_failed` | Transport/status failure theo k6; download `202` có thể không là transport fail nếu expected khác, nhưng script success không được có download `202`. |
| `shared_jobs_total` | Business jobs đã ghi nhận; phải bằng `JOBS`. |
| `shared_jobs_failed` | Business jobs fail lifecycle; phải bằng 0. |
| `shared_api_calls_total` | Nên bằng `http_reqs`. |
| `shared_job_duration_ms` | End-to-end duration của một report lifecycle, gồm create + poll wait + download. |
| `shared_sleep_seconds` | Think/pause nếu config `SI_06_SLEEP_SECONDS > 0`. |

Tags quan trọng:

```text
case_id=si-06-report-export-batch
business_case=report_export_batch
executor_family=shared_iterations
workload_shape=fixed_backlog
service=report-service
operation=report_job_create|report_job_status|report_job_download|report_export_job
job_id=report-export-N
```

## Pass criteria

CLI/summary phải có:

```text
checks.........................: 100%
http_req_failed................: 0.00%
iterations.....................: 60
shared_jobs_total..............: 60
shared_jobs_failed.............: 0
```

Request breakdown phải có:

```text
report_job_create   POST 202  count=60
report_job_status   GET  200  count>=60
report_job_download GET  200  count=60
```

Không được có trong final successful run:

```text
report_job_download GET 202 count>0
shared_jobs_failed > 0
checks_failed > 0
iterations < 60
```

## Cách chạy

PowerShell:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:K6_CLOUD_METRIC_PUSH_INTERVAL = "1s"
$env:K6_CLOUD_AGGREGATION_PERIOD = "1s"
$env:K6_CLOUD_AGGREGATION_WAIT_PERIOD = "2s"
k6 run -o cloud --summary-trend-stats "avg,min,med,max,p(90),p(95),p(99)" .\load-target\k6\shared-iterations\si-06-report-export-batch.js
```

Override để mô phỏng report worker chậm hơn:

```powershell
$env:SI_06_READY_AFTER_MS = "500"
$env:SI_06_STATUS_POLL_INTERVAL_MS = "50"
$env:SI_06_STATUS_TIMEOUT_MS = "10000"
```

Expected khi readiness chậm hơn:

```text
shared_job_duration_ms tăng
report_job_status count tăng
http_reqs tăng
iterations vẫn phải bằng 60
shared_jobs_failed vẫn phải bằng 0 nếu timeout đủ lớn
```

## Đọc output summary

Đọc theo thứ tự:

1. **Scenario header**: phải là `shared-iterations`, `60 iterations shared among 6 VUs`.
2. **Thresholds**:
   - `checks rate==1` pass.
   - `http_req_failed rate==0` pass.
   - `shared_jobs_total count==60` pass.
   - `shared_jobs_failed count==0` pass.
3. **Business counters**:
   - `shared_jobs_total=60`.
   - `shared_jobs_failed=0`.
4. **Operation breakdown**:
   - create/download count exactly 60.
   - status count at least 60.
5. **Latency**:
   - `http_req_duration` = latency của từng HTTP call.
   - `shared_job_duration_ms` = end-to-end job lifecycle, mới là số business quan trọng nhất.

Ví dụ công thức kiểm operation split:

```text
create_count = 60
download_count = 60
status_count >= 60
http_reqs = create_count + status_count + download_count
shared_api_calls_total = http_reqs
```

## Đọc dashboard real-time charts cho case 06

Dashboard: `http://localhost:13001`

### Chart 1 — Response time

Chart response time thường đọc từ request-level metric như `http_req_duration`. Với case này phải filter theo `operation`:

| Operation | Cách đọc |
| --- | --- |
| `report_job_create` | Tạo job async; expected HTTP `202`; latency gồm CPU/DB/gzip mô phỏng create. |
| `report_job_status` | Có thể nhiều samples hơn jobs vì polling; latency từng request thấp không có nghĩa job lifecycle nhanh. |
| `report_job_download` | Phải có đúng 60 samples HTTP `200`; nếu có HTTP `202` nghĩa là download quá sớm. |

Điểm quan trọng:

```text
http_req_duration đo từng HTTP call.
shared_job_duration_ms đo cả lifecycle create + wait/poll + download.
```

Nếu `http_req_duration` thấp nhưng `shared_job_duration_ms` cao, đó không mâu thuẫn. Nó nghĩa là HTTP calls nhanh, nhưng report cần thời gian để generate trước khi completed.

### Chart 2 — Execution timeline

Timeline phải chứng minh fixed backlog đã drain đủ:

```text
sum(iterations buckets) == 60
sum(shared_jobs_total buckets) == 60
sum(shared_jobs_failed buckets) == 0
sum(report_job_create) == 60
sum(report_job_download) == 60
sum(report_job_status) >= 60
```

Sau polling, ratio đúng là:

```text
http_reqs / iterations = 2 + status_poll_count / iterations
```

Với 60 jobs:

```text
minimum ratio = 3.0   nếu mỗi job chỉ poll status một lần
ratio > 3.0           bình thường nếu có job cần poll thêm
```

Vì vậy:

| Pattern | Kết luận |
| --- | --- |
| `http_reqs = 180`, status=60 | Mỗi job completed ở lần status poll đầu. |
| `http_reqs > 180`, status>60, download=60, failed=0 | Bình thường với async polling. |
| `http_reqs > 180`, status rất cao, failed>0 | Có timeout/report worker chậm/poll interval quá dày. |
| download<60 | Lifecycle coverage fail. |
| download `202` xuất hiện | Script download trước khi completed hoặc backend contract lệch. |

### Chart 3 — VUs vs iter/s

Case này là worker-pool backlog, không phải active-user traffic:

```text
VUs = số workers đang xử lý backlog
iter/s = tốc độ hoàn tất report jobs
```

Expected shape:

1. Khi backlog còn nhiều, VUs gần configured `6`.
2. Iter/s có thể thấp ở đầu vì mỗi job phải chờ report completed trước khi iteration kết thúc.
3. Khi backlog gần hết, VUs tụt dần vì không còn job để lấy.
4. Tail ngắn là bình thường; tail dài với VUs cao và iter/s thấp là dấu hiệu async pipeline chậm.

Không được kết luận sai:

```text
VU làm ít job hơn != lỗi.
shared-iterations chia việc theo worker nào rảnh trước.
```

## Output -> quyết định

| Output | Quyết định |
| --- | --- |
| 60 iterations, 60 downloads, 0 failed jobs | PASS: report export lifecycle ổn. |
| create=60 nhưng download<60 | FAIL: async lifecycle incomplete, không release. |
| download có `202` trong successful path | FAIL script/contract: download trước completed. |
| status polls tăng mạnh nhưng vẫn pass | Functional pass nhưng performance risk; kiểm report worker/readiness delay/poll interval. |
| `shared_job_duration_ms` p95/p99 tăng | SLA risk cho user chờ report. |
| `http_req_failed > 0` | HTTP/API failure cần điều tra status code/endpoint. |

## Nghịch lý và misconceptions

### “Status HTTP 200 nghĩa là report ready?”

Sai. Status endpoint HTTP `200` chỉ nghĩa là request status thành công. Readiness nằm trong body:

```text
data.status = processing | completed
```

### “Download 202 là backend bug?”

Không nhất thiết. Với async export, download `202` khi report còn processing là hợp lý. Bug chỉ xảy ra nếu client đã thấy status `completed` nhưng download vẫn `202`, hoặc contract quy định ready rồi mà vẫn processing.

### “Case 06 phải luôn có 180 HTTP requests?”

Sai sau khi dùng polling. Đúng là:

```text
http_reqs = 120 + status_poll_count
status_poll_count >= 60
```

### “Case pass mà `http_reqs > 180` thì có duplicate bug?”

Không tự động. Có thể chỉ là extra status polls. Cần xem operation breakdown:

```text
create phải = 60
download phải = 60
status có thể > 60
```

## Mở rộng

### Variation A — tăng report generation delay

```powershell
$env:SI_06_READY_AFTER_MS = "500"
$env:SI_06_STATUS_POLL_INTERVAL_MS = "50"
```

Kỳ vọng:

```text
shared_job_duration_ms tăng
status poll count tăng
http_reqs tăng
job coverage vẫn đủ 60 nếu timeout đủ
```

### Variation B — timeout quá ngắn

```powershell
$env:SI_06_READY_AFTER_MS = "1000"
$env:SI_06_STATUS_TIMEOUT_MS = "200"
```

Kỳ vọng:

```text
report_job_status completed before timeout check fail
shared_jobs_failed > 0
không đủ download 60
```

Đây là cách test timeout handling của client.

### Variation C — poll interval quá ngắn

```powershell
$env:SI_06_STATUS_POLL_INTERVAL_MS = "5"
```

Kỳ vọng:

```text
status poll count tăng mạnh
http_reqs tăng
có thể gây thêm load không cần thiết
```

## Anti-pattern

Không viết flow kiểu này:

```js
create job
sleep(1ms)
GET status // chỉ check HTTP 200
GET download // expect 200 ngay
```

Vì backend async thực tế có thể chưa completed. Pattern đúng:

```js
create job
while status.data.status == 'processing':
  sleep(poll_interval)
  poll again
if completed:
  download expect 200
else:
  fail job
```

## Reference

- Overview: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js`
- Backend catalog: `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\case-catalog.json`
- Report-service handler: `E:\Projects\k6\k6-metrics-server\load-target\services\report-service\internal\handler\http.go`
- Report-service usecase: `E:\Projects\k6\k6-metrics-server\load-target\services\report-service\internal\usecase\report.go`
