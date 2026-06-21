# Run Guide — `constant-arrival-rate` practice pack

> File này dùng chung cho 7 case trong series. Mỗi case doc giải thích thêm business context,
> expected output, pass criteria và cách đọc chart riêng.

## 3 stack cần start

| Service | URL | Mục đích |
| --- | --- | --- |
| UI Dashboard | http://localhost:13001 | Xem run catalog, Overview charts, Executor tab |
| Metrics API | http://localhost:18080 | k6 cloud endpoint (`-o cloud`) |
| Load-target | http://localhost:80 | Endpoints `/api/sim/*` cho scripts `car-*` |
| Grafana (optional) | http://localhost:13002 | Ingest/storage health |

## Start stack

```powershell
# 1. Metrics + UI
cd e:\Projects\k6\k6-metrics-server\deploy\private-metrics
docker compose --env-file .env `
  -f compose.private-metrics.yml `
  -f compose.tier1-small.yml `
  up -d

# 2. Load-target
cd e:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up
```

## Env vars cho mọi run

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
```

Linux/Bash tương đương:

```bash
export BASE_URL=http://localhost:80
export K6_CLOUD_HOST=http://localhost:18080
export K6_CLOUD_TOKEN=student-token-1234567890
```

## Sanity check connectivity

```bash
# Metrics API capabilities
curl http://localhost:18080/v1/capabilities

# Auth token hợp lệ
curl -H "Authorization: Bearer student-token-1234567890" \
  http://localhost:18080/v1/me

# Load-target health
curl http://localhost:80/health
```

Expected:

```text
/v1/capabilities -> auth_required=true, production_mode=true
/v1/me           -> class_id/student_id hợp lệ
/health          -> status ok của load-target
```

Nếu 1 trong 3 check fail, chưa chạy k6. Fix stack trước.

## Source scripts

Pack source-of-truth đang nằm ở metrics/load-target repo:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate
```

Files chính:

```text
case-catalog.json
README.md
common.js
car-01-storefront-rps-contract.js
car-02-auth-token-validation-rps.js
car-03-cart-write-intake.js
car-04-checkout-order-intake.js
car-05-report-api-ingress.js
car-06-cacheable-feed-ingress.js
car-07-production-ingress-mix.js
```

Sau khi chạy full validation, đọc thêm:

```text
docs/practice/constant-arrival-rate/08_validation-and-chart-analysis.md
```

Docs trong repo này chỉ giải thích cách học/chạy/phân tích; không duplicate source scripts.

## Run pattern chung

Từ repo docs/k6 hiện tại:

```powershell
cd "E:\Khoa hoc\k6"

# Run local: chỉ xem CLI summary
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js"

# Run dashboard/cloud: có run id, Overview charts, Executor tab, summary-final
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js"
```

Nên dùng `run-with-summary.ps1` cho bài học có chart vì wrapper này:

```text
1. chạy k6 với -o cloud
2. export summary JSON từ k6 CLI
3. POST summary-final lên Metrics API
4. finish run để giải phóng active-run quota
```

Vì vậy dashboard `/summary` sẽ khớp CLI summary 1:1 cho final percentiles.

## Run đủ 7 case

```powershell
cd "E:\Khoa hoc\k6"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-02-auth-token-validation-rps.js"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-04-checkout-order-intake.js"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-06-cacheable-feed-ingress.js"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-07-production-ingress-mix.js"
```

## Short smoke settings

Khi chỉ muốn kiểm tra script/stack nhanh, override duration/rate:

```powershell
$env:CAR_01_RATE = "5"
$env:CAR_01_DURATION = "5s"
$env:CAR_01_PREALLOCATED_VUS = "4"
$env:CAR_01_MAX_VUS = "8"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js"

# Xóa env override sau smoke để tránh ảnh hưởng full run
Remove-Item Env:CAR_01_RATE, Env:CAR_01_DURATION, Env:CAR_01_PREALLOCATED_VUS, Env:CAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

Nguyên tắc smoke:

```text
- duration ngắn để tiết kiệm thời gian
- rate thấp để tránh drop do stack chưa warm
- vẫn giữ executor constant-arrival-rate để validate shape
```

## Env override theo case

Pattern chung:

```text
CAR_NN_RATE
CAR_NN_TIME_UNIT
CAR_NN_DURATION
CAR_NN_PREALLOCATED_VUS
CAR_NN_MAX_VUS
CAR_NN_USER_POOL
CAR_NN_MAX_DROPPED
```

Riêng case 05 có thêm:

```text
CAR_05_READY_AFTER_MS
```

Ví dụ cố tình tạo áp lực VU pool cho case 04:

```powershell
$env:CAR_04_RATE = "8"
$env:CAR_04_DURATION = "30s"
$env:CAR_04_PREALLOCATED_VUS = "2"
$env:CAR_04_MAX_VUS = "4"
$env:CAR_04_MAX_DROPPED = "999"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-04-checkout-order-intake.js"
```

Mục đích của override này là dạy `dropped_iterations`, không phải target production.

## Cách đọc output chung

### 1. Đọc config/header

Xác nhận:

```text
executor = constant-arrival-rate
rate/timeUnit/duration đúng case
preAllocatedVUs/maxVUs đúng env/default
```

### 2. Tính target slots

```text
scheduled_slots = rate × duration_seconds / timeUnit_seconds
```

Ví dụ:

```text
car-01 = 20/s × 45s = 900 slots
car-07 = 18/s × 60s = 1080 slots
```

### 3. Đọc built-in metrics

Bắt buộc đọc:

```text
iterations
dropped_iterations
http_reqs
http_req_failed
checks
vus
vus_max
```

### 4. Đọc custom metrics

Bắt buộc đọc:

```text
constant_arrival_events_total
constant_arrival_events_failed
constant_arrival_api_calls_total
constant_arrival_event_duration_ms
```

Healthy run thường có:

```text
dropped_iterations = 0
constant_arrival_events_failed = 0
constant_arrival_events_total ≈ iterations
constant_arrival_api_calls_total ≈ http_reqs
```

Một số case có weighted branch hoặc multi-call event nên `http_reqs` không phải lúc nào bằng `iterations`.
Luôn đọc case doc để biết expected call pattern.

## Dashboard checklist

Sau khi run bằng `run-with-summary.ps1`:

```text
1. Mở http://localhost:13001
2. Paste token student-token-1234567890
3. Chọn run mới nhất hoặc run id in trên CLI
4. Mở Overview tab
5. Mở Executor tab
6. So summary-final với chart/series
```

### Overview: Response time

Đọc:

```text
- avg/med/p95/p99 có spike không?
- spike ở đầu run hay cuối run?
- p95 tăng dần theo thời gian không?
- endpoint/tag nào gây tail latency?
```

### Overview: Execution timeline

Đọc:

```text
- iterations per bucket có gần target rate không?
- http_reqs per bucket có đúng call pattern không?
- có bucket nào hụt mạnh không?
- dropped_iterations có xuất hiện không?
```

### Overview: VUs vs iter/s

Đọc:

```text
- actual iter/s có giữ gần target không?
- active VUs có tăng khi latency tăng không?
- active VUs có sát maxVUs không?
```

### Executor tab

Đọc:

```text
- executor detected đúng constant-arrival-rate
- configured rate/timeUnit/duration đúng
- preAllocatedVUs/maxVUs đúng
- observed active VUs hợp lý
- dropped_iterations khớp summary
```

## Chart caveats

```text
summary-final là nguồn truth cuối cùng cho final summary.
pointCount là số bucket chart, không phải số request/event.
metrics_push_count là số payload backend nhận, không phải business count.
Bucket chart có thể aggregate/downsample; muốn verify count phải sum đúng series value.
```

## Troubleshooting

### `dropped_iterations > 0`

Đọc theo thứ tự:

```text
1. Rate/duration có đúng không?
2. Event duration có tăng không?
3. Active VUs có sát maxVUs không?
4. preAllocatedVUs có quá thấp khiến spawn không kịp không?
5. Load-target có cold start/DB lock/CPU pressure không?
```

Cách thử lại:

```text
- tăng preAllocatedVUs nếu drop ở đầu run
- tăng maxVUs nếu VUs chạm trần
- giảm rate nếu mục tiêu test là tìm capacity hiện tại
- giữ rate và fix backend nếu mục tiêu là đạt ingress contract
```

### `constant_arrival_events_failed > 0`

Đọc tag `operation`/`endpoint` để biết branch nào fail.
Không chỉ nhìn `http_req_failed` tổng vì một event có thể gọi nhiều endpoint.

### k6 cloud upload fail

```text
Check K6_CLOUD_HOST đúng: http://localhost:18080
Check K6_CLOUD_TOKEN còn valid: curl /v1/me
Check metrics stack đang chạy
Check active-run quota; wrapper finish run nhưng run cũ có thể còn stale vài phút
```

### Target down

```text
curl http://localhost:80/health
cd e:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up
```

## Stop stack

```powershell
# Metrics + UI
cd e:\Projects\k6\k6-metrics-server\deploy\private-metrics
docker compose --env-file .env `
  -f compose.private-metrics.yml `
  -f compose.tier1-small.yml `
  down

# Load-target
cd e:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action down
```
