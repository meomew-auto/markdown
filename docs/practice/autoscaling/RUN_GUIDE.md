# Autoscaling Layer — Run Guide

## Shared env

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:K6_METRICS_TOKEN = "student-token-1234567890"
$env:K6_METRICS_SERVER_URL = "http://localhost:13001"
```

## as-01 — Scheduled replica change (manual)

```powershell
# Terminal 1: Chạy k6 workload
$env:ORDER_RUNTIME_SCALE_SCENARIO = "runtime_scale_flow"
$env:ORDER_RUNTIME_SCALE_VUS = "4"
$env:ORDER_RUNTIME_SCALE_DURATION_SECONDS = "30"
$env:OPS_AUTH_TOKEN = "<from docker exec>"
k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/22-order-service-runtime-scale.js

# Terminal 2 (sau 5s): Scale thủ công
docker compose -p k6target --env-file .../infra/env/.env.target -f .../infra/compose/compose.target.yml up -d --scale order-service=2 nginx
```

## as-02/03/04 — Autoscale lab (CPU-driven)

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:K6_METRICS_TOKEN = "student-token-1234567890"

# Chạy lab đầy đủ (90s controller + k6 workload)
.\scripts\run-compose-autoscale-lab.ps1 `
  -BaseUrl http://localhost:18080 `
  -MetricsBaseUrl http://localhost:13001 `
  -ControllerDurationSeconds 90
```

**Hoặc chạy riêng autoscaler với custom threshold:**
```powershell
# Terminal 1: k6 workload
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$token = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN 2>&1 | Select-Object -Last 1
$env:OPS_AUTH_TOKEN = $token
k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/25-order-service-autoscale-controller.js

# Terminal 2: Autoscaler controller
.\scripts\compose-autoscaler.ps1 `
  -MetricsBaseUrl http://localhost:13001 `
  -AuthToken "student-token-1234567890" `
  -TestRunId "<run_id>" `
  -ProjectName k6target `
  -Service order-service `
  -MinReplicas 1 `
  -MaxReplicas 3 `
  -ScaleOutCpuPercent 12 `
  -ScaleInCpuPercent 4 `
  -DurationSeconds 60 `
  -EventPath artifacts/autoscale-events/autoscale-<run_id>.jsonl
```

## as-05 — Capacity projection for autoscale

```powershell
# Sweep tìm safe RPS/replica
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "3"; $env:CAPACITY_DB_ROWS = "80"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_PRE_ALLOCATED_VUS = "10"; $env:CAPACITY_MAX_VUS = "25"
$env:CAPACITY_RUN_ID = "as-capacity-baseline"
k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

## Dashboard Autoscale tab

Sau khi chạy lab, mở `http://localhost:13001/` → tab **Autoscale**:
- Current desired replicas
- Số lần `scale_applied`
- Latest reason: `cpu_high`, `cpu_low`, `cooldown`, `hold`
- Chart replica timeline (blue bar)
- Chart CPU pressure (amber bar)
- Event log (từ JSONL artifact)
- Debug JSON để copy

Nếu selected run không có autoscale event, UI fallback sang latest event và hiện note.

## Resource & event persistence

- Autoscale events lưu ở `artifacts/autoscale-events/autoscale-<runId>.jsonl`
- Mỗi event là 1 dòng JSON (JSONL format)
- Dashboard đọc qua `GET /v1/autoscale/events?test_run_id=<id>`
- Resource samples vẫn persist qua `GET /v1/tests/:id/resources`

## Validation snapshot (2026-06-26)

| Run | Case | Events | Scale events | Kết quả |
| ---: | --- | ---: | --- | --- |
| #164 | as-02/03/04 lab | 24 | 1 (initial) | Autoscaler chạy đúng, CPU thấp → hold |
| #165 | as-02/03/04 lab | 17 | 1 (initial) | Cooldown chặn scale đúng (CPU spike 19%) |

**Lưu ý:** order-service với `cpu_ms=0, external_ms=35` là IO-bound → CPU thấp. Để thấy scale thật, dùng workload có `cpu_ms` cao hoặc giảm `ScaleOutCpuPercent`.
