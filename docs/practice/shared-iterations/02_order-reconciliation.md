# Case 02: Order reconciliation

## Tình huống thực tế

Reconcile một backlog order pending/failed cố định: confirm lại order rồi đọc status/history để verify trạng thái cuối.

Đây không phải bài mô phỏng user traffic mở theo thời gian. Đây là bài:

```text
fixed backlog + worker pool + drain until done
```

Nói đời thường:

```text
Có 120 job đang chờ.
Dùng 8 worker xử lý hết.
Ai xong trước thì lấy job tiếp theo.
Hoàn tất khi không còn job nào trong backlog.
```

## Vì sao case này hợp với `shared-iterations`?

Danh sách order cần reconcile là finite backlog. Worker nào rảnh thì lấy order tiếp theo; không cần bound order vào VU cố định.

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
| SI_02_VUS | 8 |
| SI_02_JOBS | 120 |
| maxDuration | 12m |
| executor | shared-iterations |
| script | `si-02-order-reconciliation.js` |

Công thức chính:

```text
JOBS = 120
configured VUs = 8
expected iterations = 120
expected http_reqs = shared_api_calls_total = 120 × 2 = 240
```

## Backlog/job model

- Mỗi job là một order trong backlog reconciliation.
- Order ID và idempotency key được seed theo job index.
- `Idempotency-Key` bảo vệ retry/replay ở cấp business, nhưng VU identity không quan trọng.

Selector đúng cho business job là job index toàn scenario, ví dụ:

```js
exec.scenario.iterationInTest
```

Không dùng `__VU` làm identity chính cho backlog, vì `__VU` chỉ là worker đang cầm job hiện tại.

## Service/API flow

| Bước | Method | Path | Service | Operation | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `POST` | `/api/sim/orders/:id/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0` | `order-service` | `order_confirm_reconcile` | `200` | Confirm/re-confirm order bằng idempotency key. |
| 2 | `GET` | `/api/sim/orders/:id?cpu_ms=1&db_rows=2&view=full&include_history=1` | `order-service` | `order_status_verify` | `200` | Verify trạng thái/history sau confirm. |

Expected operation breakdown:

| Operation | Expected count |
| --- | --- |
| `order_confirm_reconcile` | 120 |
| `order_status_verify` | 120 |

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
case_id       = si-02-order-reconciliation
business_case = order_reconciliation
service       = order-service
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
http_reqs = shared_api_calls_total = 120 × 2 = 240
```

Nếu có tag breakdown theo `operation`, expected là:

```text
order_confirm_reconcile: 120
```

```text
order_status_verify: 120
```

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

Run lên private dashboard nếu dùng cloud output:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-02-order-reconciliation.js
```

Có thể override workload bằng env vars trong bảng config ở trên, ví dụ:

```powershell
$env:SI_02_JOBS = "20"
$env:SI_02_VUS = "4"
```

## Đọc output summary

Đọc summary theo checklist sau:

1. `iterations` có bằng `120` không?
2. `shared_jobs_total` có bằng `120` không?
3. `shared_jobs_failed` có bằng `0` không?
4. `checks` có pass 100% không?
5. `http_req_failed` có bằng 0 không?
6. `http_reqs` và `shared_api_calls_total` có bằng `120 × 2 = 240` không?
7. `shared_job_duration_ms` có count bằng `120` không?

Các điểm case-specific:

- `iterations = 120` nghĩa là 120 order jobs đã được lấy khỏi backlog.
- `http_reqs = 240` vì mỗi order confirm xong phải status verify.
- `shared_jobs_failed = 0` mới chứng minh không order nào reconcile fail ở cấp job.

Đừng bịa thêm per-VU fairness từ summary. Với shared pool, summary không cần chứng minh mỗi VU xử lý cùng số job.

## Đọc dashboard real-time charts cho case 02

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
| `order_confirm_reconcile` | 120 |
| `order_status_verify` | 120 |

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

- Response time thường thấy `order_confirm_reconcile` chậm hơn vì có external_ms/db_writes.
- Execution timeline phải có 120 iterations, 240 http_reqs, confirm/status mỗi loại 120.
- Nếu tail chậm, kiểm bucket max của confirm trước; status chỉ là verify path.

### Chart 2 — Execution timeline

Chart này dùng để kiểm backlog drain có đủ không.

Kiểm tổng:

```text
sum(iterations buckets) == 120
sum(http_reqs buckets) == 120 × 2 = 240
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
- Khi còn backlog: VUs gần configured VUs (8)
- Khi backlog gần hết: VUs có thể tụt ở tail
- iter/s cao thấp tùy latency và số API/job
```

Điểm quan trọng:

```text
VUs ổn định không chứng minh chia đều job.
Tail VUs tụt không phải lỗi nếu iterations/shared_jobs_total vẫn đủ.
```

### Checklist đọc biểu đồ case 02

```text
[ ] Response time đã tách operation chưa?
[ ] Execution timeline cộng iterations ra 120 chưa?
[ ] Execution timeline cộng http_reqs ra 120 × 2 = 240 chưa?
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

## Kết luận thực tế: team order/payment quyết định gì?

Team order/payment chỉ nên đóng batch khi 120 jobs đều pass, không có 5xx/check fail, và confirm/status đều đủ 120 call. Nếu confirm đủ nhưng status thiếu, reconciliation chưa có bằng chứng trạng thái cuối.

## Mở rộng

- Thêm nhóm order theo age/status để lọc dashboard.
- Thêm case external_fail_rate > 0 để học retry policy.
- Thêm custom counter cho confirmed/replayed nếu BE trả trạng thái idempotency.

## Anti-pattern

- Dùng per-vu vì tưởng mỗi VU là một order owner.
- Chỉ đếm confirm 200 mà không verify status sau confirm.
- Coi VU nào xử lý ít order là lỗi; trong shared-iterations điều đó bình thường.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-02-order-reconciliation.js`
