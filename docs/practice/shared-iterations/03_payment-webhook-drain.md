# Case 03: Payment webhook drain

## Tình huống thực tế

Payment gateway thường deliver webhook theo kiểu at-least-once: một event có thể gửi lại nhiều lần. Sau outage hoặc deploy, hệ thống có thể có backlog webhook cần drain.

Nếu một event bị skip, order/payment state có thể không cập nhật. Nếu duplicate không idempotent, order có thể bị process nhiều lần.

Case này trả lời: 10 worker có drain đủ 100 webhook jobs không, và duplicate event có được xử lý an toàn không?

Tóm tắt đời thường:

```text
Trigger: payment gateway retry, webhook queue backlog, deploy consumer mới, hoặc incident recovery
Backlog: 100 payment webhook event jobs, có duplicate theo `SI_03_DUPLICATE_EVERY=5`
Risk nếu skip job: payment event không được apply vào order state hoặc duplicate gây double-processing
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
| Tổng completed iterations phải bằng `100` | Vì `100` là kích thước backlog, thiếu 1 job là coverage incomplete. |
| `shared_jobs_total == 100` | Iteration chạy xong chưa đủ; job phải được mark hoàn tất end-to-end. |
| `shared_jobs_failed == 0` | Có failed job nghĩa là business contract không đạt. |
| `http_reqs/shared_api_calls_total == 100 × 1 = 100` | Mỗi job phải gọi đúng số API trong flow. |
| Operation counts phải khớp expected breakdown | Tổng HTTP đúng nhưng thiếu một operation vẫn là coverage bug. |
| Job identity phải derive từ `exec.scenario.iterationInTest` | Worker identity `__VU` không đại diện cho business job. |
| Uneven per-VU distribution is normal | Worker nhanh xử lý nhiều job hơn là đúng mô hình shared pool. |

Nếu một trong các invariant về count/job fail, kết quả nên coi là **invalid hoặc fail**, không phải “pass nhưng hơi thiếu”.

## Vì sao "payment webhook backlog drain" nên dùng `shared-iterations`?

Mental model đúng:

```text
100 jobs đang nằm trong một queue/backlog.
10 VUs là 10 workers.
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
| `SI_03_VUS` | 10 | Số worker cùng xử lý backlog |
| `SI_03_JOBS` | 100 | Tổng số job toàn scenario |
| `SI_03_DUPLICATE_EVERY` | 5 | Case-specific behavior |
| `maxDuration` | 10m | Safety cap, không phải target duration |
| `executor` | `shared-iterations` | Fixed global backlog + worker pool |

Mapping quan trọng:

```text
business backlog size = 100 jobs
k6 iterations         = 100
worker pool size      = 10 VUs
expected API calls    = 100 × 1 = 100
```

`maxDuration` chỉ là safety cap. Nếu cap này cắt run làm `iterations < 100`, kết quả không valid vì backlog chưa drain hết.

Operation coverage expected:

```text
payment_webhook_process: 100
```

## Technical semantics: shared backlog, worker pool, job identity

Cách k6 vận hành nên được hiểu như sau:

```text
1. Scenario có một global quota: iterations = 100.
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

### Nguyên nhân kỹ thuật 1: Queue drain semantics

Payment webhooks là queue/backlog tự nhiên. `shared-iterations` mô phỏng nhiều consumers cùng drain queue tới khi hết 100 events.

### Nguyên nhân kỹ thuật 2: At-least-once delivery

Duplicate delivery là normal trong payment/webhook systems. Test phải chứng minh duplicate không tạo business failure.

### Nguyên nhân kỹ thuật 3: Idempotency/claim locking

Event ID, claim TTL, hoặc idempotency record có thể gây lock contention, 409/500, hoặc double-process nếu implement sai.

### Nguyên nhân kỹ thuật 4: Event identity is not worker identity

Event ID phải derive từ job index/duplicate schedule. Nếu derive từ `__VU`, 10 workers có thể lặp vài event và bỏ sót event khác.

## Service/API flow

| Operation | Method | Path | Service | Expected | Expected count | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| payment_webhook_process | `POST` | `/api/sim/orders/webhooks/payment?cpu_ms=1&db_writes=2&claim_ttl_ms=4000` | order-service | `200` | 100 | Process payment event với `X-Webhook-Id`. |

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
case_id       = si-03-payment-webhook-drain
business_case = payment_webhook_backlog_drain
service       = order-service
```

## Pass criteria

Pass criteria tối thiểu:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 100
shared_jobs_failed count == 0
iterations count == 100
http_reqs count == 100
shared_api_calls_total count == 100
```

Operation breakdown phải khớp:

```text
payment_webhook_process: 100
```

Đừng thêm pass condition kiểu:

```text
mỗi VU phải xử lý 100 / 10 jobs
```

Vì đó không phải invariant của `shared-iterations`.

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-03-payment-webhook-drain.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-03-payment-webhook-drain.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-03-payment-webhook-drain.js
```

Nếu backend script chưa có trong working tree, chỉ đọc phần expected formula trước; không tự điền run data.

## Đọc output summary

Áp 5 bước giống cách đọc các case per-vu, nhưng invariant đổi sang **total backlog**, không phải per-user quota.

### Bước 1 — Verify scenario/config

Header phải thể hiện:

```text
executor = shared-iterations
vus = 10 hoặc env override
total iterations/jobs = 100 hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ expected counts.

### Bước 2 — Compute expected total jobs

Default case này:

```text
JOBS = 100
API_PER_JOB = 1
expected iterations = 100
expected http_reqs = 100 × 1 = 100
```

### Bước 3 — Compare summary counters

Expected:

```text
iterations == 100
shared_jobs_total == 100
shared_jobs_failed == 0
```

Nếu `iterations < 100`:

```text
backlog chưa drain hết -> invalid result
```

Nếu `iterations == 100` nhưng `shared_jobs_total < 100`:

```text
iteration chạy xong nhưng job completion instrumentation/business branch bị thiếu
```

### Bước 4 — Compare API and operation counts

Expected:

```text
http_reqs == 100
shared_api_calls_total == 100
payment_webhook_process: 100
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

- `iterations = 100` chứng minh 100 webhook jobs được attempt/complete.
- `http_reqs = 100` vì mỗi webhook job có một POST.
- Duplicate expected vẫn nên pass nếu BE contract là accept/ignore idempotent.

Không check mỗi VU làm bằng nhau. Invariant là total completed work, không phải equal work per VU.

## Đọc dashboard real-time charts cho case 03

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
payment_webhook_process: 100
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

- Một operation duy nhất nên response chart tập trung vào webhook process latency.
- Latency spike ở duplicate buckets có thể chỉ ra lock contention hoặc claim TTL wait.
- Nếu `http_req_failed` tăng, xem status 409/500 và duplicate/idempotency path.

### Chart 2 — Execution timeline

Chart này chứng minh backlog drain đủ theo thời gian.

Kiểm tổng bucket:

```text
sum(iterations buckets) == 100
sum(http_reqs buckets) == 100
sum(shared_jobs_total buckets) == 100
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
- VUs gần 10 khi backlog còn nhiều việc
- iter/s tăng/giảm theo latency và số API/job
- VUs có thể tụt ở tail khi backlog gần hết
- fast VUs có thể xử lý nhiều job hơn slow VUs
```

Đừng đọc chart này thành:

```text
mỗi VU phải xử lý 100 / 10 jobs
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
| 100 webhook calls, no failed jobs | Queue drain passed | Accept webhook handling |
| `shared_jobs_total < 100` | Queue/backlog not fully drained | Invalid/incomplete result |
| Duplicate-related checks fail | Idempotency bug | Block release |
| HTTP 409/500 or failed jobs | Webhook processing unsafe | Inspect claim/idempotency path |
| Counts pass but duplicate latency spikes | Possible lock contention | Investigate performance separately |
| operation count != 100 | Instrumentation/retry mismatch | Investigate before accepting |

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
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-03-payment-webhook-drain.js`
