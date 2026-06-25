# Observability / SLO Layer -- Run Guide

## Shared env

Tất cả các case trong layer này dùng chung các biến môi trường sau:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
```

## obs-01 -- Trace & request correlation

**Cần `OPS_AUTH_TOKEN`**. Token được source từ `docker exec`, không bao giờ in ra màn hình.

```powershell
# Source token từ container (KHÔNG in ra)
$env:OPS_AUTH_TOKEN = docker exec k6-metrics-server printenv OPS_AUTH_TOKEN 2>$null

# Xác nhận token đã được set (chỉ kiểm tra độ dài, không in nội dung)
if ($env:OPS_AUTH_TOKEN) { Write-Host "OPS_AUTH_TOKEN set (length: $($env:OPS_AUTH_TOKEN.Length))" } else { Write-Host "ERROR: OPS_AUTH_TOKEN not set" }

$env:ORDER_TRACE_CORRELATION_RUN_ID = "fe-obs-trace"
$env:ORDER_TRACE_CORRELATION_SCENARIO = "order_trace_correlation"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/24-order-service-trace-correlation.js
```

Expected: `order_trace_correlation_check_failures=0`, tất cả trace identifiers khớp giữa request header và response body.

## obs-02 -- Green-path SLO decision

Không cần `OPS_AUTH_TOKEN`.

```powershell
$env:PERVU_CORE_STATEFUL_VUS = "4"
$env:PERVU_CORE_STATEFUL_ITERS = "3"
$env:PERVU_CORE_AB_VUS_PER_ARM = "2"
$env:PERVU_CORE_AB_ITERS = "2"
$env:PERVU_CORE_RACE_VUS = "4"
$env:PERVU_CORE_RACE_ITERS = "1"
$env:PERVU_CORE_IDEMP_VUS = "4"
$env:PERVU_CORE_IDEMP_ITERS = "2"
$env:PERVU_CORE_BATCH_VUS = "2"
$env:PERVU_CORE_BATCH_ITERS = "2"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/32-per-vu-business-core.js
```

Expected: `per_vu_core_case_failures=0`, tất cả business flow pass, p95 latency trong SLO.

## obs-03 -- Pressure SLO exception

Không cần `OPS_AUTH_TOKEN`. Dùng `cpu_throttle` mode.

```powershell
$env:NONK8S_MODE = "cpu_throttle"
$env:NONK8S_RUN_ID = "fe-obs-pressure"
$env:NONK8S_VUS = "4"
$env:NONK8S_DURATION_SECONDS = "16"
$env:NONK8S_PRODUCTS_CPU_MS = "35"
$env:NONK8S_RETAIN_MEMORY_KB = "16384"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/29-nonk8s-prod-approx.js
```

Expected: 429 responses xuất hiện, `nonk8s_prod_approx_tolerated_errors > 0`, `nonk8s_prod_approx_success_200 > 0`.

## Dashboard

Sau khi chạy, mở `http://localhost:13001/` → chọn run:

### Tab Production (SLO view)
- **SLI Cards panel**: 4 cards hiển thị availability %, p95 latency, capacity protection status, resource headroom
- **Trace Correlation panel**: Request ID → Trace ID → Operation → Service → Resource evidence
- **Status Breakdown**: 200 vs 429 vs error counts, grouped by endpoint

### Tab Requests
- Bảng chi tiết từng request: status, duration, URL, tags
- Filter theo `target_service`, `flow`, `case` để isolate từng operation

### Tab Checks
- Pass/fail breakdown cho từng check group
- Dùng để xác nhận trace correlation checks (obs-01) và business flow checks (obs-02)

### Tab Capacity / Resources
- `GET /v1/tests/:id/resources` -- container CPU %, RAM MB, network I/O, disk I/O
- Dùng cho SLO-4 (Resource Headroom) evidence
- Trong obs-03 (cpu_throttle), CPU chart sẽ show saturation tương ứng với 429 spike

## Lưu ý quan trọng

1. **OPS_AUTH_TOKEN** cho obs-01 phải được source từ `docker exec`, không hardcode, không in ra log. Nếu không set, script vẫn chạy nhưng thiếu auth headers -- trace correlation có thể fail.
2. **obs-03 cpu_throttle** sinh ra 429 có chủ đích. Đây là behavior đúng, không phải bug. Script đã cấu hình `expectedStatuses: [200, 429]` và `nonk8s_prod_approx_tolerated_errors` counter.
3. **Script paths** trong guide này dùng absolute path `E:/Projects/k6/k6-metrics-server/...`. Điều chỉnh nếu repo được clone ở vị trí khác.

## Validation snapshot (2026-06-24)

| Case | Run | Checks | Highlight |
| --- | ---: | --- | --- |
| obs-01 Trace | #148 | TBD | TBD |
| obs-02 Green | #149 | TBD | TBD |
| obs-03 Pressure | #139 | 0 failures / 844 tolerated | 429 backpressure validated |
