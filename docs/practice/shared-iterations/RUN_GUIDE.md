# Run Guide — shared-iterations practice

> File này dùng chung cho 7 case `shared-iterations`. Mỗi case có thêm config/env vars riêng.

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

Nếu dùng wrapper có push final summary, ưu tiên wrapper để dashboard summary khớp CLI summary.
Dấu hiệu dashboard authoritative là summary lấy từ k6 final summary export thay vì chỉ HDR approximation.

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
| 06 | `SI_06_VUS` | `SI_06_JOBS` | `SI_06_READY_AFTER_MS` |
| 07 | `SI_07_VUS` | `SI_07_JOBS` | - |

Ví dụ chạy nhỏ để demo nhanh:

```powershell
$env:SI_06_JOBS = "10"
$env:SI_06_VUS = "2"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js
```

## Cách đọc kết quả chung

Với mọi case, đọc theo thứ tự:

```text
1. iterations == JOBS
2. shared_jobs_total == JOBS
3. shared_jobs_failed == 0
4. checks rate == 1
5. http_req_failed rate == 0
6. http_reqs/shared_api_calls_total == expected API formula
7. shared_job_duration_ms count == JOBS
```

## Debug khi fail

| Tín hiệu | Nghĩa thường gặp | Hành động |
| --- | --- | --- |
| `iterations < JOBS` | maxDuration/interruption, backlog chưa drain hết | tăng maxDuration, giảm workload, kiểm endpoint chậm |
| `shared_jobs_total < JOBS` | script/job không mark finish đủ | kiểm branch lỗi trong script hoặc exception |
| `shared_jobs_failed > 0` | job business fail | lọc dashboard theo `operation`, `job_id` |
| `http_req_failed > 0` | HTTP non-2xx/network fail | xem request breakdown/status code |
| `checks < 100%` | status/schema/contract fail | xem check nào fail, đối chiếu expectedStatus |

## Dashboard checklist

```text
[ ] Response time tách theo operation/service
[ ] Execution timeline cộng iterations ra JOBS
[ ] Execution timeline cộng http_reqs ra expected API calls
[ ] shared_jobs_total cộng ra JOBS
[ ] shared_jobs_failed cộng ra 0
[ ] VUs vs iter/s đúng worker-pool shape
```

## Reference

- Overview: `./00_overview.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
