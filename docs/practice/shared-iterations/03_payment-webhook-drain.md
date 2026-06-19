# Case 03: Payment webhook drain

## Tình huống thực tế

Drain một backlog payment webhook cố định, có cả event duplicate để verify xử lý idempotent.

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

Webhook queue là fixed backlog. Nhiều worker cùng consume message; worker nhanh consume thêm message là đúng mô hình queue drain.

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
| SI_03_VUS | 10 |
| SI_03_JOBS | 100 |
| SI_03_DUPLICATE_EVERY | 5 |
| maxDuration | 10m |
| executor | shared-iterations |
| script | `si-03-payment-webhook-drain.js` |

Công thức chính:

```text
JOBS = 100
configured VUs = 10
expected iterations = 100
expected http_reqs = shared_api_calls_total = 100 × 1 = 100
```

## Backlog/job model

- Mỗi job là một webhook event cần process.
- Một số job dùng lại `event_id` theo `SI_03_DUPLICATE_EVERY=5` để mô phỏng duplicate.
- Business correctness nằm ở xử lý duplicate an toàn, không phải chia đều event cho VU.

Selector đúng cho business job là job index toàn scenario, ví dụ:

```js
exec.scenario.iterationInTest
```

Không dùng `__VU` làm identity chính cho backlog, vì `__VU` chỉ là worker đang cầm job hiện tại.

## Service/API flow

| Bước | Method | Path | Service | Operation | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `POST` | `/api/sim/orders/webhooks/payment?cpu_ms=1&db_writes=2&claim_ttl_ms=4000` | `order-service` | `payment_webhook_process` | `200` | Process payment event, header `X-Webhook-Id`. |

Expected operation breakdown:

| Operation | Expected count |
| --- | --- |
| `payment_webhook_process` | 100 |

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
case_id       = si-03-payment-webhook-drain
business_case = payment_webhook_backlog_drain
service       = order-service
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
payment_webhook_process: 100
```

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

Run lên private dashboard nếu dùng cloud output:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-03-payment-webhook-drain.js
```

Có thể override workload bằng env vars trong bảng config ở trên, ví dụ:

```powershell
$env:SI_03_JOBS = "20"
$env:SI_03_VUS = "4"
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

- `iterations = 100` nghĩa là 100 webhook jobs được attempt/complete.
- `http_reqs = 100` vì mỗi job có một webhook POST.
- Duplicate expected vẫn nên trả 200 nếu contract BE là idempotent accept/ignore.

Đừng bịa thêm per-VU fairness từ summary. Với shared pool, summary không cần chứng minh mỗi VU xử lý cùng số job.

## Đọc dashboard real-time charts cho case 03

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
| `payment_webhook_process` | 100 |

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

- Response time cho biết webhook processing/claim lock có bucket nào chậm.
- Execution timeline phải sum 100 iterations và 100 webhook calls.
- Nếu có spike latency, kiểm duplicate/claim_ttl path vì duplicate handling có thể lock/serialize.

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

### Checklist đọc biểu đồ case 03

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

## Kết luận thực tế: team payment/order quyết định gì?

Team payment/order có thể xem drain pass khi 100 webhook jobs đều complete, không job failed, và duplicate không tạo HTTP/check fail. Nếu `shared_jobs_total` thiếu, queue chưa drain hết; nếu `shared_jobs_failed > 0`, phải xem duplicate/idempotency handling.

## Mở rộng

- Tăng duplicate density bằng `SI_03_DUPLICATE_EVERY` nhỏ hơn.
- Thêm tag `duplicate=true/false` nếu muốn so latency duplicate vs fresh.
- Thêm check trạng thái order sau webhook nếu cần end-to-end stronger.

## Anti-pattern

- Coi duplicate webhook là lỗi chỉ vì event_id lặp lại.
- Chỉ nhìn http_req_failed=0 mà không đọc `shared_jobs_failed`.
- Đòi mỗi VU xử lý đúng 10 webhook; queue drain không có yêu cầu đó.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-03-payment-webhook-drain.js`
