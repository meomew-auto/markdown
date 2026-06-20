# Case 02: Order reconciliation

## Tình huống thực tế

Team order/payment có một backlog order pending/failed cần reconcile sau sự cố payment, retry job, hoặc migration order state.

Mỗi order phải được confirm/re-confirm rồi verify trạng thái cuối. Nếu một order bị skip, finance/support có thể thấy order treo dù batch test báo xanh.

Case này trả lời: 8 worker có xử lý đủ 120 order jobs không, và confirm có được verify bằng status/history không?

Tóm tắt đời thường:

```text
Trigger: payment incident recovery, order migration, retry confirm batch, hoặc nightly reconciliation
Backlog: 120 pending/failed order reconciliation jobs
Risk nếu skip job: một order có thể vẫn pending/failed nhưng không ai biết batch bỏ sót
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
| Tổng completed iterations phải bằng `120` | Vì `120` là kích thước backlog, thiếu 1 job là coverage incomplete. |
| `shared_jobs_total == 120` | Iteration chạy xong chưa đủ; job phải được mark hoàn tất end-to-end. |
| `shared_jobs_failed == 0` | Có failed job nghĩa là business contract không đạt. |
| `http_reqs/shared_api_calls_total == 120 × 2 = 240` | Mỗi job phải gọi đúng số API trong flow. |
| Operation counts phải khớp expected breakdown | Tổng HTTP đúng nhưng thiếu một operation vẫn là coverage bug. |
| Job identity phải derive từ `exec.scenario.iterationInTest` | Worker identity `__VU` không đại diện cho business job. |
| Uneven per-VU distribution is normal | Worker nhanh xử lý nhiều job hơn là đúng mô hình shared pool. |

Nếu một trong các invariant về count/job fail, kết quả nên coi là **invalid hoặc fail**, không phải “pass nhưng hơi thiếu”.

## Vì sao "order reconciliation backlog" nên dùng `shared-iterations`?

Mental model đúng:

```text
120 jobs đang nằm trong một queue/backlog.
8 VUs là 8 workers.
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
| `SI_02_VUS` | 8 | Số worker cùng xử lý backlog |
| `SI_02_JOBS` | 120 | Tổng số job toàn scenario |
| `maxDuration` | 12m | Safety cap, không phải target duration |
| `executor` | `shared-iterations` | Fixed global backlog + worker pool |

Mapping quan trọng:

```text
business backlog size = 120 jobs
k6 iterations         = 120
worker pool size      = 8 VUs
expected API calls    = 120 × 2 = 240
```

`maxDuration` chỉ là safety cap. Nếu cap này cắt run làm `iterations < 120`, kết quả không valid vì backlog chưa drain hết.

Operation coverage expected:

```text
order_confirm_reconcile: 120
order_status_verify: 120
```

## Technical semantics: shared backlog, worker pool, job identity

Cách k6 vận hành nên được hiểu như sau:

```text
1. Scenario có một global quota: iterations = 120.
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

### Nguyên nhân kỹ thuật 1: Finite reconciliation backlog

Business object là order, không phải VU. Có đúng 120 order jobs cần reconcile; worker nào xử lý order nào không quan trọng bằng việc tất cả order đều được xử lý.

### Nguyên nhân kỹ thuật 2: Confirm is not enough

`POST confirm` 200 chỉ chứng minh command được accept. Nó không chứng minh final order state/history đúng. Vì vậy mỗi job cần thêm `order_status_verify`.

### Nguyên nhân kỹ thuật 3: Idempotency key semantics

Idempotency key phải derive từ order/job identity. Nếu derive từ `__VU`, worker reuse có thể gây key collision hoặc replay sai order.

### Nguyên nhân kỹ thuật 4: External latency and worker skew

Confirm path có external_ms/db_writes nên latency biến thiên. VU gặp confirm nhanh sẽ xử lý nhiều order hơn; đó là expected.

## Service/API flow

| Operation | Method | Path | Service | Expected | Expected count | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| order_confirm_reconcile | `POST` | `/api/sim/orders/:id/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0` | order-service | `200` | 120 | Confirm/re-confirm order với `Idempotency-Key`. |
| order_status_verify | `GET` | `/api/sim/orders/:id?cpu_ms=1&db_rows=2&view=full&include_history=1` | order-service | `200` | 120 | Verify final order state/history. |

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
case_id       = si-02-order-reconciliation
business_case = order_reconciliation
service       = order-service
```

## Pass criteria

Pass criteria tối thiểu:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 120
shared_jobs_failed count == 0
iterations count == 120
http_reqs count == 240
shared_api_calls_total count == 240
```

Operation breakdown phải khớp:

```text
order_confirm_reconcile: 120
order_status_verify: 120
```

Đừng thêm pass condition kiểu:

```text
mỗi VU phải xử lý 120 / 8 jobs
```

Vì đó không phải invariant của `shared-iterations`.

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-02-order-reconciliation.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-02-order-reconciliation.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-02-order-reconciliation.js
```

Nếu backend script chưa có trong working tree, chỉ đọc phần expected formula trước; không tự điền run data.

## Đọc output summary

Áp 5 bước giống cách đọc các case per-vu, nhưng invariant đổi sang **total backlog**, không phải per-user quota.

### Bước 1 — Verify scenario/config

Header phải thể hiện:

```text
executor = shared-iterations
vus = 8 hoặc env override
total iterations/jobs = 120 hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ expected counts.

### Bước 2 — Compute expected total jobs

Default case này:

```text
JOBS = 120
API_PER_JOB = 2
expected iterations = 120
expected http_reqs = 120 × 2 = 240
```

### Bước 3 — Compare summary counters

Expected:

```text
iterations == 120
shared_jobs_total == 120
shared_jobs_failed == 0
```

Nếu `iterations < 120`:

```text
backlog chưa drain hết -> invalid result
```

Nếu `iterations == 120` nhưng `shared_jobs_total < 120`:

```text
iteration chạy xong nhưng job completion instrumentation/business branch bị thiếu
```

### Bước 4 — Compare API and operation counts

Expected:

```text
http_reqs == 240
shared_api_calls_total == 240
order_confirm_reconcile: 120
order_status_verify: 120
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

- `iterations = 120` chứng minh 120 order jobs được lấy khỏi backlog.
- `http_reqs = 240` chứng minh mỗi order có confirm + status verify.
- Confirm 120 nhưng status thiếu nghĩa là final state chưa được chứng minh.

Không check mỗi VU làm bằng nhau. Invariant là total completed work, không phải equal work per VU.

## Đọc dashboard real-time charts cho case 02

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
order_confirm_reconcile: 120
order_status_verify: 120
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

- `order_confirm_reconcile` thường là bottleneck vì có db_writes/external_ms.
- `order_status_verify` giúp phát hiện state/history fail sau confirm.
- Nếu `shared_job_duration_ms` cao nhưng request status nhanh, nghi confirm/external path.

### Chart 2 — Execution timeline

Chart này chứng minh backlog drain đủ theo thời gian.

Kiểm tổng bucket:

```text
sum(iterations buckets) == 120
sum(http_reqs buckets) == 240
sum(shared_jobs_total buckets) == 120
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
- VUs gần 8 khi backlog còn nhiều việc
- iter/s tăng/giảm theo latency và số API/job
- VUs có thể tụt ở tail khi backlog gần hết
- fast VUs có thể xử lý nhiều job hơn slow VUs
```

Đừng đọc chart này thành:

```text
mỗi VU phải xử lý 120 / 8 jobs
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
| confirm/status mỗi loại 120, no failed jobs | Tất cả orders reconciled và verified | Close reconciliation batch |
| confirm 120 nhưng status < 120 | Final state không được verify đủ | Block batch closure |
| `shared_jobs_failed > 0` | Order/payment state issue | Investigate affected `job_id`/order |
| `http_req_failed > 0` | Backend/API failure during reconciliation | Block and inspect status codes |
| Counts complete nhưng job duration high | Functional pass, SLA/external latency risk | Investigate payment/order latency |
| Per-VU uneven | Normal worker-pool behavior | No action |

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
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-02-order-reconciliation.js`
