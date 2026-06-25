# Resource Layer — Run Guide

## Shared env

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
```

Không case nào cần `OPS_AUTH_TOKEN`.

## res-01 — Resource model correctness

```powershell
$env:RESOURCE_CORRECTNESS_RUN_ID = "res-01-test"
$env:RESOURCE_CORRECTNESS_SCENARIO = "resource_correctness"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/26-resource-correctness-benchmark.js
```

Expected: `resource_correctness_failures=0`, mọi `resource_model` field khớp query param.

## res-02 — Resource trend

```powershell
$env:RESOURCE_TREND_RUN_ID = "res-02-test"
$env:RESOURCE_TREND_REPEATS = "4"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/27-resource-trend-benchmark.js
```

Expected: `resource_trend_failures=0`, tất cả families có trend monotonic.

## res-03 — Container audit

```powershell
$env:RESOURCE_CONTAINER_RUN_ID = "res-03-test"
$env:RESOURCE_CONTAINER_REPEATS = "6"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/28-resource-container-audit.js
```

Expected: `resource_container_audit_failures=0`, container-level CPU/RAM/network/disk reported.

## res-04 — Non-K8s prod approx

```powershell
$env:NONK8S_MODE = "cpu_throttle"   # hoặc: memory_pressure, disk_pressure, oom_threshold
$env:NONK8S_VUS = "4"
$env:NONK8S_DURATION_SECONDS = "16"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/29-nonk8s-prod-approx.js
```

## res-05 — Capacity sweep

```powershell
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "8"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"
$env:CAPACITY_MAX_VUS = "40"
$env:CAPACITY_DB_ROWS = "120"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

## Dashboard Capacity tab

Sau khi chạy, mở `http://localhost:13001/` → chọn run → tab **Capacity**:
- `GET /v1/tests/:id/resources` — persisted resource history
- `GET /v1/resources/live?test_run_id=:id` — realtime container snapshot
- Hiển thị: CPU %, RAM MB, network I/O, disk I/O per container
