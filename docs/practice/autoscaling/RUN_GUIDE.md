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

## as-02 — CPU pressure scale out

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:K6_METRICS_TOKEN = "student-token-1234567890"

# Chạy lab đầy đủ (90s controller + CPU pressure workload)
.\scripts\run-compose-autoscale-lab.ps1 `
  -BaseUrl http://localhost:18080 `
  -MetricsBaseUrl http://localhost:13001 `
  -ControllerDurationSeconds 90
```

**Muốn scale-out thật (CPU đủ cao để vượt ngưỡng):**
```powershell
# Dùng CPU pressure workload thay vì order-service script mặc định
# Script: load-target/k6/app/cpu-pressure-workload.js
# Tự động gọi products-service với cpu_ms=25, 8 VUs → tạo CPU load thật
```

**Chạy riêng autoscaler với custom threshold:**
```powershell
# Terminal 1: CPU pressure workload
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:CPU_PRESSURE_CPU_MS = "30"
$env:CPU_PRESSURE_VUS = "8"
$env:CPU_PRESSURE_DURATION_SECONDS = "90"
k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/cpu-pressure-workload.js

# Terminal 2: Autoscaler controller
.\scripts\compose-autoscaler.ps1 `
  -MetricsBaseUrl http://localhost:13001 `
  -AuthToken "student-token-1234567890" `
  -TestRunId "<run_id>" `
  -ProjectName k6target `
  -Service products-service `
  -MinReplicas 1 `
  -MaxReplicas 3 `
  -ScaleOutCpuPercent 10 `
  -ScaleInCpuPercent 3 `
  -DurationSeconds 60 `
  -EventPath artifacts/autoscale-events/autoscale-<run_id>.jsonl
```

## as-03 — Bottleneck NOT solved by scale

```powershell
# Bước 1: Baseline với 1 replica
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "8"; $env:CAPACITY_DB_ROWS = "120"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"; $env:CAPACITY_MAX_VUS = "40"
k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
# Ghi nhận: success rate, 429 rate, capacity_breakdown_db_ms

# Bước 2: Scale order-service lên 3 replica
docker compose -p k6target up -d --scale order-service=3

# Bước 3: Chạy lại cùng workload
k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
# So sánh: success rate có tăng không? → nếu KHÔNG → bottleneck ở DB, không phải app
```

## as-04 — Cooldown (scale in)

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:K6_METRICS_TOKEN = "student-token-1234567890"

# Chạy lab 90s — workload đủ dài để thấy full chu trình:
# scale out (cpu_high) → cooldown blocks → workload dừng → cpu_low → scale in
.\scripts\run-compose-autoscale-lab.ps1 `
  -BaseUrl http://localhost:18080 `
  -MetricsBaseUrl http://localhost:13001 `
  -ControllerDurationSeconds 90
```

**Đọc kết quả:** Đếm số `decision` với `reason: "cooldown"` trong event log. Mỗi cooldown = 1 lần autoscaler định scale nhưng bị chặn vì chưa hết 12s.

## as-05 — Shared state during scale

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:K6_METRICS_TOKEN = "student-token-1234567890"

# Chạy lab — autoscale controller script tự động test hotkey idempotency
.\scripts\run-compose-autoscale-lab.ps1 `
  -BaseUrl http://localhost:18080 `
  -MetricsBaseUrl http://localhost:13001 `
  -ControllerDurationSeconds 90
```

**Đọc kết quả:**
- `order_autoscale_hotkey_fresh_count` = 1 (chỉ 1 replica claim được)
- `order_autoscale_hotkey_reuse_count` > 0 (các replica khác thấy duplicate)
- `order_autoscale_trace_failures` = 0 (trace preserved qua các replica)

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
- Resource samples persist qua `GET /v1/tests/:id/resources`
- `resource_sample_count` có trong test list item (BE fixed 2026-06-26)

## Validation snapshot (2026-06-30 — all 7 BE issues resolved)

| Run | Case | Events | Scale events | Kết quả |
| ---: | --- | ---: | --- | --- |
| #165 | as-05 shared state | 17 | 1 (initial) | hotkey_fresh=1, reuse=55, trace=0 ✅ |
| #170 | as-02/04 CPU pressure (cũ) | 22 | 3 (initial + cpu_high×2) | Scale 1→2→3, CPU 17-28%, 6 cooldown blocks ✅ |
| #177 | as-02 CPU pressure | 22 | 3 (initial_already_satisfied + cpu_high×2) | Scale 1→2→3, mapping sạch, no temp-fix ✅ |
| **#184** | **as-02/04 full cycle** | **19** | **5 (initial 3→1 + cpu_high×2 + cpu_low×2)** | **Scale 3→1→2→3→2→1, 8 cooldown blocks, scale-in hoạt động** ✅ |

**Run #184 timeline (canonical — show cả scale-out lẫn scale-in):**
```
t=0s:   controller_started (replicas=3 leftover)
t=2s:   scale_applied(initial, 3→1)          ← cleanup leftover replicas
t=6s:   CPU 18.71% → COOLDOWN (còn 8s)
t=10s:  CPU 17.98% → COOLDOWN (còn 3s)
t=14s:  CPU 17.25% → cpu_high → SCALE 1→2 🔥
t=18s:  CPU 24.51% → COOLDOWN (còn 8s)
t=22s:  CPU 19.44% → COOLDOWN (còn 3s)
t=26s:  CPU 20.51% → cpu_high → SCALE 2→3 🔥
t=30s+: CPU 18-24% → hold (max=3)
...k6 workload ends (~t=50s), CPU drops to 0%...
t=50s:  CPU 0.01% → cpu_low → SCALE 3→2 🔻
t=54s:  CPU 1.20% → COOLDOWN (còn 8s)
t=58s:  CPU 0.00% → COOLDOWN (còn 3s)
t=62s:  CPU 0.62% → cpu_low → SCALE 2→1 🔻
t=63s:  controller_stopped (replicas=1)
```

**Kết quả Run #184:**
- 35,134 requests (390 req/s), 10 VUs, cpu_ms=30
- 5 scale_applied thật, 8 cooldown blocks
- Nginx RestartCount=0 — `docker compose --scale` không restart nginx
- List `summary_metrics` đầy đủ (http_reqs, fail_rate, checks_rate) — issue #5 fixed
- Resource samples=55, persisted=true qua BE deploy

**Lưu ý:**
- `order-service` với `external_ms=35` là **IO-bound** → CPU luôn thấp → không trigger scale. Dùng `cpu-pressure-workload.js` (gọi products-service với cpu_ms=30) để tạo CPU load thật.
- `products-service` được scale (không phải order-service) vì CPU pressure workload gọi products endpoint.
- `compose-autoscaler.ps1` đã fix: dùng `docker compose --scale` trực tiếp thay vì gọi `stack.ps1` (tránh restart nginx mỗi lần scale).
- Autoscaler mặc định scale `order-service`. Đổi service bằng `-Service products-service`.
- **Scale-in hoạt động**: Khi workload dừng, CPU về <3% sau cooldown → autoscaler tự động scale xuống MinReplicas.
