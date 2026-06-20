# Run Guide — shared-iterations practice

> File này dùng chung cho 7 case `shared-iterations`. Mỗi case có thêm giải thích nghiệp vụ, formula, dashboard checklist trong doc riêng.

## Important: real runs are optional

Các docs trong series này hiện đang giải thích **semantics + expected formulas**. Chỉ bổ sung run ID, p95/p99/max, chart bucket thật khi đã chạy thật script.

Lý do: trong working tree hiện tại, folder BE được mô tả là:

```text
k6-metrics-server/load-target/k6/shared-iterations/
```

nhưng có thể chưa tồn tại ở repo đang mở. Vì vậy:

```text
Không bịa run #...
Không bịa p95/p99/max.
Không bịa bucket chart.
Không nói "đã chạy pass" nếu chưa chạy thật.
```

Khi BE folder có mặt, dùng guide này để chạy và thu số thật.

## Stack cần có

| Service | URL | Mục đích |
| --- | --- | --- |
| UI Dashboard | http://localhost:13001 | Xem run, summary, charts |
| Metrics API | http://localhost:18080 | k6 cloud endpoint (`-o cloud`) |
| Load-target | http://localhost:80 | Backend `/api/sim/*` cho learner chạy |

## Env vars chung

PowerShell:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
```

Bash:

```bash
export BASE_URL=http://localhost:80
export K6_CLOUD_HOST=http://localhost:18080
export K6_CLOUD_TOKEN=student-token-1234567890
```

## Case catalog cho FE/learner

FE đọc contract ở:

```text
k6-metrics-server/load-target/k6/shared-iterations/case-catalog.json
```

Field cần dùng:

| Field | Ý nghĩa |
| --- | --- |
| `id` | ID case, ví dụ `si-01-catalog-audit` |
| `script` | Script k6 tương ứng |
| `businessCase` | Tình huống nghiệp vụ |
| `whySharedIterations` | Lý do chọn executor này |
| `defaultConfig` | VUS/JOBS/maxDuration mặc định |
| `calls[]` | Service/API/method/path/body/status expected |

## Run pattern chung

Local summary:

```powershell
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js
```

Private dashboard:

```powershell
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js
```

Nếu có wrapper push final summary, ưu tiên wrapper để dashboard summary khớp CLI summary.
Dấu hiệu dashboard authoritative là summary lấy từ k6 final summary export thay vì chỉ từ HDR approximation.

## Commands từng case

| Case | Script | Command |
| --- | --- | --- |
| 01 Catalog audit | `si-01-catalog-audit.js` | `k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js` |
| 02 Order reconciliation | `si-02-order-reconciliation.js` | `k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-02-order-reconciliation.js` |
| 03 Payment webhook drain | `si-03-payment-webhook-drain.js` | `k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-03-payment-webhook-drain.js` |
| 04 Cart cleanup | `si-04-cart-cleanup.js` | `k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js` |
| 05 Cache warm | `si-05-cache-warm.js` | `k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-05-cache-warm.js` |
| 06 Report export batch | `si-06-report-export-batch.js` | `k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js` |
| 07 CI verification batch | `si-07-ci-verification-batch.js` | `k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-07-ci-verification-batch.js` |

## Env override nhanh

| Case | VUs | Jobs | Extra |
| --- | --- | --- | --- |
| 01 | `SI_01_VUS` | `SI_01_JOBS` | - |
| 02 | `SI_02_VUS` | `SI_02_JOBS` | - |
| 03 | `SI_03_VUS` | `SI_03_JOBS` | `SI_03_DUPLICATE_EVERY` |
| 04 | `SI_04_VUS` | `SI_04_JOBS` | - |
| 05 | `SI_05_VUS` | `SI_05_JOBS` | - |
| 06 | `SI_06_VUS` | `SI_06_JOBS` | `SI_06_READY_AFTER_MS`, `SI_06_STATUS_POLL_INTERVAL_MS`, `SI_06_STATUS_TIMEOUT_MS` |
| 07 | `SI_07_VUS` | `SI_07_JOBS` | - |

Caveat quan trọng khi override:

```text
Nếu đổi JOBS, phải recompute expected formulas.
```

Ví dụ:

- case 05 default `120 jobs` chia `60 homefeed / 60 detail`; nếu đổi thành `121 jobs`, split có thể không còn 60/60.
- case 07 default `100 jobs` chia `5 operation × 20`; nếu `JOBS % 5 != 0`, split không đều.
- case 06 async report export: `http_reqs = JOBS × 2 + status_poll_count`, trong đó `status_poll_count >= JOBS`; đổi `JOBS`, `READY_AFTER_MS`, hoặc poll interval thì recompute expected HTTP calls.

## What to collect when backend scripts are available

Khi chạy thật để update docs với số thật, collect tối thiểu:

| Nhóm | Cần lấy |
| --- | --- |
| Run identity | run ID, command, env overrides, exit code |
| Summary counters | `iterations`, `http_reqs`, `checks`, `http_req_failed` |
| Shared metrics | `shared_jobs_total`, `shared_jobs_failed`, `shared_api_calls_total`, `shared_job_duration_ms`, `shared_sleep_seconds` |
| Operation breakdown | count theo `operation`, `service`, status code |
| Response time | avg/p95/p99/max theo operation |
| Dashboard timeline | bucket sums của iterations/http_reqs/jobs/failures |
| VUs/iter/s | worker-pool shape, tail behavior |

Chỉ sau khi có số thật mới thêm vào docs:

```text
run #...
summary p95/p99/max
chart bucket arrays
percentile_source
final verdict PASS/FAIL
```

## Cách đọc kết quả chung

Với mọi case, đọc theo thứ tự:

```text
1. Header/config có đúng executor shared-iterations không?
2. iterations == JOBS không?
3. shared_jobs_total == JOBS không?
4. shared_jobs_failed == 0 không?
5. checks rate == 1 không?
6. http_req_failed rate == 0 không?
7. http_reqs/shared_api_calls_total == expected API formula không? Với case 06: create + status polls + download, không hard-code 3 calls/job.
8. operation breakdown có đúng coverage không?
9. shared_job_duration_ms cho thấy job lifecycle nhanh/chậm thế nào?
```

Không check:

```text
mỗi VU phải làm số job bằng nhau
```

Vì với shared pool:

```text
uneven per-VU distribution is normal
```

## Debug khi fail

| Tín hiệu | Nghĩa thường gặp | Hành động |
| --- | --- | --- |
| `iterations < JOBS` | maxDuration/interruption, backlog chưa drain hết | tăng maxDuration, giảm workload, kiểm endpoint chậm |
| `shared_jobs_total < JOBS` | script/job không mark finish đủ | kiểm branch lỗi trong script hoặc exception |
| `shared_jobs_failed > 0` | job business fail | lọc dashboard theo `operation`, `job_id` |
| `http_req_failed > 0` | HTTP non-2xx/network fail | xem request breakdown/status code |
| `checks < 100%` | status/schema/contract fail | xem check nào fail, đối chiếu expectedStatus |
| operation count mismatch | coverage lệch | kiểm job selector và branch logic |

## Dashboard checklist

```text
[ ] Response time đã tách theo operation/service chưa?
[ ] Execution timeline cộng iterations ra JOBS chưa?
[ ] Execution timeline cộng http_reqs ra expected API calls chưa?
[ ] shared_jobs_total cộng ra JOBS chưa?
[ ] shared_jobs_failed cộng ra 0 chưa?
[ ] VUs vs iter/s đúng worker-pool shape chưa?
[ ] Có ai đang đọc nhầm VU distribution là pass/fail không?
```

## Reference

- Overview: `./00_overview.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
