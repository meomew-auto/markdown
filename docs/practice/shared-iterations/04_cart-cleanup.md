# Case 04: Cart cleanup

## Tình huống thực tế

Team cart/backend cần cleanup một danh sách stale cart items sau TTL job, data migration, hoặc bug làm cart line item bị lệch quantity.

Mỗi stale item là một record cần xử lý. Nếu bỏ sót record, user có thể thấy cart cũ hoặc total sai.

Case này không test same-user race. Nó test batch cleanup: 8 workers có xử lý đủ 90 stale item jobs và verify summary sau update không?

Tóm tắt đời thường:

```text
Trigger: TTL cleanup, cart migration, stale item repair, hoặc backend maintenance job
Backlog: 90 stale cart item cleanup jobs
Risk nếu skip job: một stale item còn sót lại, cart summary/user state có thể sai
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
| Tổng completed iterations phải bằng `90` | Vì `90` là kích thước backlog, thiếu 1 job là coverage incomplete. |
| `shared_jobs_total == 90` | Iteration chạy xong chưa đủ; job phải được mark hoàn tất end-to-end. |
| `shared_jobs_failed == 0` | Có failed job nghĩa là business contract không đạt. |
| `http_reqs/shared_api_calls_total == 90 × 2 = 180` | Mỗi job phải gọi đúng số API trong flow. |
| Operation counts phải khớp expected breakdown | Tổng HTTP đúng nhưng thiếu một operation vẫn là coverage bug. |
| Job identity phải derive từ `exec.scenario.iterationInTest` | Worker identity `__VU` không đại diện cho business job. |
| Uneven per-VU distribution is normal | Worker nhanh xử lý nhiều job hơn là đúng mô hình shared pool. |

Nếu một trong các invariant về count/job fail, kết quả nên coi là **invalid hoặc fail**, không phải “pass nhưng hơi thiếu”.

## Vì sao "stale cart cleanup backlog" nên dùng `shared-iterations`?

Mental model đúng:

```text
90 jobs đang nằm trong một queue/backlog.
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
| `SI_04_VUS` | 8 | Số worker cùng xử lý backlog |
| `SI_04_JOBS` | 90 | Tổng số job toàn scenario |
| `maxDuration` | 8m | Safety cap, không phải target duration |
| `executor` | `shared-iterations` | Fixed global backlog + worker pool |

Mapping quan trọng:

```text
business backlog size = 90 jobs
k6 iterations         = 90
worker pool size      = 8 VUs
expected API calls    = 90 × 2 = 180
```

`maxDuration` chỉ là safety cap. Nếu cap này cắt run làm `iterations < 90`, kết quả không valid vì backlog chưa drain hết.

Operation coverage expected:

```text
cart_item_cleanup_update: 90
cart_cleanup_summary_verify: 90
```

## Technical semantics: shared backlog, worker pool, job identity

Cách k6 vận hành nên được hiểu như sau:

```text
1. Scenario có một global quota: iterations = 90.
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

### Nguyên nhân kỹ thuật 1: Batch cleanup, not same-user cart journey

Business target là 90 stale item records, không phải 8 users giữ cart session. VU chỉ là worker xử lý record.

### Nguyên nhân kỹ thuật 2: Wrong `__VU` mapping skips items

Nếu item id derive từ `__VU`, bạn chỉ cleanup vài worker identities lặp lại. Item identity phải derive từ global job index.

### Nguyên nhân kỹ thuật 3: Update must be verified

PATCH 200 chỉ chứng minh command được accept. Summary GET xác nhận final cart state sau cleanup.

### Nguyên nhân kỹ thuật 4: Write contention

Một số cleanup jobs có thể chạm cùng cart/DB partition. `shared_job_duration_ms` cao có thể chỉ ra lock/write contention.

## Service/API flow

| Operation | Method | Path | Service | Expected | Expected count | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| cart_item_cleanup_update | `PATCH` | `/api/sim/cart/items/:item_id?cpu_ms=1&db_writes=1` | cart-service | `200` | 90 | Update/cleanup stale line item. |
| cart_cleanup_summary_verify | `GET` | `/api/sim/cart/summary?cpu_ms=1&db_rows=3&json_items=8` | cart-service | `200` | 90 | Verify summary sau cleanup. |

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
case_id       = si-04-cart-cleanup
business_case = stale_cart_cleanup
service       = cart-service
```

## Pass criteria

Pass criteria tối thiểu:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 90
shared_jobs_failed count == 0
iterations count == 90
http_reqs count == 180
shared_api_calls_total count == 180
```

Operation breakdown phải khớp:

```text
cart_item_cleanup_update: 90
cart_cleanup_summary_verify: 90
```

Đừng thêm pass condition kiểu:

```text
mỗi VU phải xử lý 90 / 8 jobs
```

Vì đó không phải invariant của `shared-iterations`.

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

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js
```

Nếu backend script chưa có trong working tree, chỉ đọc phần expected formula trước; không tự điền run data.

## Đọc output summary

Áp 5 bước giống cách đọc các case per-vu, nhưng invariant đổi sang **total backlog**, không phải per-user quota.

### Bước 1 — Verify scenario/config

Header phải thể hiện:

```text
executor = shared-iterations
vus = 8 hoặc env override
total iterations/jobs = 90 hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ expected counts.

### Bước 2 — Compute expected total jobs

Default case này:

```text
JOBS = 90
API_PER_JOB = 2
expected iterations = 90
expected http_reqs = 90 × 2 = 180
```

### Bước 3 — Compare summary counters

Expected:

```text
iterations == 90
shared_jobs_total == 90
shared_jobs_failed == 0
```

Nếu `iterations < 90`:

```text
backlog chưa drain hết -> invalid result
```

Nếu `iterations == 90` nhưng `shared_jobs_total < 90`:

```text
iteration chạy xong nhưng job completion instrumentation/business branch bị thiếu
```

### Bước 4 — Compare API and operation counts

Expected:

```text
http_reqs == 180
shared_api_calls_total == 180
cart_item_cleanup_update: 90
cart_cleanup_summary_verify: 90
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

- `iterations = 90` chứng minh 90 stale item jobs chạy.
- `http_reqs = 180` chứng minh mỗi job có update + summary verify.
- Update pass nhưng summary fail nghĩa là final state không đáng tin.

Không check mỗi VU làm bằng nhau. Invariant là total completed work, không phải equal work per VU.

## Đọc dashboard real-time charts cho case 04

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
cart_item_cleanup_update: 90
cart_cleanup_summary_verify: 90
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

- `cart_item_cleanup_update` có db_writes nên thường là path cần soi latency.
- `cart_cleanup_summary_verify` giúp phát hiện read-after-write/state inconsistency.
- Case này không kết luận lost-update same-user; đó là mục tiêu của per-vu cart concurrency.

### Chart 2 — Execution timeline

Chart này chứng minh backlog drain đủ theo thời gian.

Kiểm tổng bucket:

```text
sum(iterations buckets) == 90
sum(http_reqs buckets) == 180
sum(shared_jobs_total buckets) == 90
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
mỗi VU phải xử lý 90 / 8 jobs
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
| update/summary mỗi loại 90, no failed jobs | Cleanup completed and verified | Cleanup batch passed |
| update pass nhưng summary fail | Final state inconsistent | Block and inspect cart state |
| operation counts mismatch | Coverage incomplete | Invalid result |
| `shared_jobs_failed > 0` | Stale item not safely cleaned | Investigate failed job |
| Counts pass but duration high | Write path risk | Tune/monitor DB writes |
| Uneven VU work | Normal worker-pool behavior | No action |

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
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-04-cart-cleanup.js`
