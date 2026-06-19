# Series thực hành: 7 tình huống thực tế cho `shared-iterations`

## Mục đích series

Series này dạy **WHEN/WHY dùng `shared-iterations`** qua 7 case backend thực tế:

```text
Có một backlog/job list cố định.
Nhiều VU hoạt động như worker pool.
Worker nào xong job trước thì lấy job tiếp theo.
Test kết thúc khi toàn bộ backlog đã được xử lý.
```

Điểm khác quan trọng nhất so với `per-vu-iterations`:

```text
shared-iterations:
  iterations = tổng số job của cả scenario
  vus        = số worker cùng xử lý backlog

per-vu-iterations:
  iterations = số vòng MỖI VU phải chạy
  vus        = số identity cố định
```

Vì vậy, với `shared-iterations`, đừng đọc `iterations: 100` thành “mỗi VU chạy 100 vòng”. Đọc đúng là:

```text
cả scenario có tổng cộng 100 job cần hoàn tất
```

## Đặc trưng `shared-iterations`

```text
- Fixed backlog: tổng job biết trước
- Worker pool: nhiều VU cùng bốc job từ pool chung
- VU nhanh có thể xử lý nhiều job hơn VU chậm
- Không đảm bảo chia đều job cho từng VU
- Total work = iterations (DETERMINISTIC nếu không bị interrupt/drop)
- Kết quả đúng/sai nằm ở: hoàn tất đủ backlog, không job failed
```

## Vì sao không dùng `__VU` làm business identity?

Trong `shared-iterations`, `__VU` chỉ là worker đang xử lý job hiện tại.

Ví dụ:

```text
vus = 3
iterations = 9
```

Kết quả có thể là:

```text
VU 1 xử lý 5 job
VU 2 xử lý 3 job
VU 3 xử lý 1 job
```

Đó là bình thường. Vì vậy nếu mỗi job cần identity ổn định, hãy derive identity từ **job index** thay vì `__VU`.

Trong bộ BE này, contract dùng pattern:

```js
exec.scenario.iterationInTest
```

để chọn job ổn định trong backlog. Ý nghĩa:

```text
iterationInTest = số thứ tự job trong toàn scenario
```

Không phụ thuộc worker/VU nào đang chạy job đó.

## Khi nào nên dùng `shared-iterations`?

Dùng khi câu hỏi nghiệp vụ là:

```text
Có N việc cố định, M worker xử lý hết được không?
```

Các ví dụ thực tế:

| Tình huống | Vì sao hợp `shared-iterations` |
| --- | --- |
| Audit fixed SKU/product backlog | Có danh sách SKU cần audit, xử lý đủ là xong |
| Reconcile order backlog | Có danh sách order pending/failed cần xác minh |
| Drain webhook/queue backlog | Có N message/event cần consume hết |
| Cleanup stale cart items | Có danh sách record cũ cần cleanup |
| Warm cache sau deploy | Có fixed URL list cần gọi trước |
| Export report batch | Có N report job cần tạo/tải xuống |
| CI API checklist | Có checklist API cố định cần verify sau deploy |

## Khi nào KHÔNG nên dùng?

Không nên dùng nếu mục tiêu là:

| Mục tiêu | Executor hợp hơn | Lý do |
| --- | --- | --- |
| Mỗi user/account chạy đúng N vòng | `per-vu-iterations` | Identity phải bound vào VU |
| Test traffic kéo dài 5 phút | `constant-vus` | Duration là input chính |
| Test 100 RPS ổn định | `constant-arrival-rate` | Rate là input chính |
| Campaign surge tăng/giảm theo thời gian | `ramping-arrival-rate` | Arrival rate biến thiên |
| User concurrency tăng dần | `ramping-vus` | VU count biến thiên |

## Bảng tổng hợp 7 case

| # | Case | Business case | Service/API chính | Expected work |
| --- | --- | --- | --- | --- |
| 01 | Catalog audit | Audit fixed product backlog | `products-service`: list + detail | `80 jobs × 2 calls = 160 http_reqs` |
| 02 | Order reconciliation | Reconcile pending/failed orders | `order-service`: confirm + status | `120 jobs × 2 calls = 240 http_reqs` |
| 03 | Payment webhook drain | Drain webhook backlog có duplicate | `order-service`: payment webhook | `100 jobs × 1 call = 100 http_reqs` |
| 04 | Cart cleanup | Cleanup stale cart items | `cart-service`: update + summary | `90 jobs × 2 calls = 180 http_reqs` |
| 05 | Cache warm | Warm fixed URL backlog | `products-service`: homefeed/detail | `120 jobs × 1 call = 120 http_reqs` |
| 06 | Report export batch | Create/status/download reports | `report-service`: report jobs | `60 jobs × 3 calls = 180 http_reqs` |
| 07 | CI verification batch | Verify fixed API checklist | mixed products/cart/order/report | `100 jobs × 1 call = 100 http_reqs` |

## Contract chung FE/learner cần đọc

BE cung cấp catalog:

```text
k6-metrics-server/load-target/k6/shared-iterations/case-catalog.json
```

FE nên đọc các field chính:

| Field | Ý nghĩa |
| --- | --- |
| `id` | ID case, ví dụ `si-01-catalog-audit` |
| `script` | File k6 script learner sẽ chạy |
| `businessCase` | Tình huống nghiệp vụ |
| `whySharedIterations` | Vì sao executor này đúng |
| `defaultConfig` | VUS/JOBS/maxDuration mặc định |
| `calls[]` | Service/API/method/path/body/status expected |

## Metrics chung của bộ case

| Metric | Type | Đọc như thế nào |
| --- | --- | --- |
| `shared_jobs_total` | Counter | Tổng số job đã hoàn tất. Expected `count == JOBS`. |
| `shared_jobs_failed` | Counter | Số job business fail. Expected `count == 0`. |
| `shared_api_calls_total` | Counter | Tổng request gửi qua helper chung. Nên khớp công thức API/job. |
| `shared_job_duration_ms` | Trend | End-to-end duration của một job. Count nên bằng `JOBS`. |
| `shared_sleep_seconds` | Counter | Tổng sleep/think time nếu case có mô phỏng delay. |

Pass criteria chung:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == JOBS
shared_jobs_failed count == 0
```

## Tags chung để lọc dashboard

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case nào đang chạy, ví dụ `si-04-cart-cleanup` |
| `business_case` | Nhóm nghiệp vụ |
| `service` | Backend service được gọi |
| `operation` | Operation cụ thể trong flow |
| `endpoint` | Endpoint/API family |
| `job_id` | Business job trong backlog |
| `executor_family` | `shared_iterations` |
| `workload_shape` | `fixed_backlog` |

## Cách đọc summary theo công thức

Luôn đọc theo thứ tự:

```text
1. iterations có bằng JOBS không?
2. shared_jobs_total có bằng JOBS không?
3. shared_jobs_failed có bằng 0 không?
4. checks có pass 100% không?
5. http_req_failed có bằng 0 không?
6. http_reqs/shared_api_calls_total có khớp công thức API/job không?
7. shared_job_duration_ms cho biết job end-to-end nhanh/chậm thế nào?
```

Ví dụ case 06:

```text
JOBS = 60
mỗi job = create + status + download = 3 API calls

Expected:
  iterations = 60
  shared_jobs_total = 60
  shared_jobs_failed = 0
  http_reqs = shared_api_calls_total = 60 × 3 = 180
```

## Cách đọc dashboard 3 chart

### Chart 1 — Response time

Chart này trả lời:

```text
API nào chậm theo thời gian?
Bucket nào có p95/max cao?
Operation nào là bottleneck?
```

Với shared-iterations, nên lọc theo `operation` vì một job có thể gọi nhiều API.

Đừng nhầm:

```text
Response time chart chỉ nói từng request chậm/nhanh.
Nó không tự chứng minh backlog đã xử lý đủ.
```

Muốn biết job end-to-end, đọc thêm `shared_job_duration_ms`.

### Chart 2 — Execution timeline

Chart này trả lời:

```text
Backlog được drain theo nhịp nào?
Mỗi time bucket hoàn tất bao nhiêu iterations/http_reqs/jobs?
Có bucket nào bị fail không?
```

Kiểm tổng:

```text
sum(iterations buckets) == JOBS
sum(http_reqs buckets) == expected API calls
sum(shared_jobs_total buckets) == JOBS
sum(shared_jobs_failed buckets) == 0
```

### Chart 3 — VUs vs iter/s

Chart này trả lời:

```text
Worker pool có được dùng đúng không?
VUs có duy trì gần configured vus khi còn backlog không?
iter/s drain backlog nhanh hay chậm?
```

Đừng nhầm:

```text
VU count ổn định không có nghĩa mỗi VU làm số job bằng nhau.
Tail VU drop là bình thường khi backlog gần hết.
```

## Thứ tự đề xuất học

```text
1. Đọc 00_overview.md (file này)
2. Đọc RUN_GUIDE.md để biết stack/env/run pattern
3. Làm case 01 catalog audit để hiểu fixed backlog đơn giản
4. Làm case 02/03 để hiểu idempotency/retry/drain
5. Làm case 04/05 để hiểu cleanup/cache warm
6. Làm case 06 để hiểu job lifecycle nhiều API
7. Làm case 07 để hiểu CI fixed checklist
```

## Reference

- Quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số và công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- Worked example: `../../20260515_03_shared-iterations-quickpizza-two-requests-worked-example.md`
- Practice per-vu để so sánh: `../per-vu-iterations/00_overview.md`
