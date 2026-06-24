# DB Layer — Run Guide

## Prerequisites

Stack `full-no-cdn`:

```powershell
docker compose --profile full-no-cdn up -d
docker ps --format "table {{.Names}}\t{{.Status}}" | grep k6target
```

Phải có: `postgres`, `order-service`, `products-service`, `report-service`.

## OPS_AUTH_TOKEN (db-01 → db-04)

```powershell
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
```

db-05 và db-06 không cần token.

## Shared env

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
```

## Case-by-case

### db-01 — Order DB delay recovery

```powershell
$env:BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_CONTROL_BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_DELAY_MS = "35"
$env:PROD_MIX_ORDER_DB_DELAY_DELTA_MS = "160"
$env:PROD_MIX_ORDER_DB_RECOVERY_DELTA_MS = "120"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/07-production-mix-order-db-recovery.js
```

Expected: checks 100%, `db_ms` increases during delay phase, recovers after reset.

### db-02 — Order DB pressure recovery

```powershell
$env:BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_PRESSURE_CONTROL_BASE_URL = "http://localhost:80"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/08-production-mix-order-db-pressure-recovery.js
```

Expected: checks 100%, pool pressure visible in latency, recovered after reset.

### db-03 — Order DB fault recovery

```powershell
$env:BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_FAULT_CONTROL_BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_FAULT_MODE = "tcp_reset"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/10-production-mix-order-db-fault-recovery.js
```

Expected: checks 100%, 5xx intentional during fault window, recovered 200 after reset.
**Không judge fail vì `http_req_failed` > 0 — đó là expected!**

### db-04 — Order DB pool contention

```powershell
$env:BASE_URL = "http://localhost:80"
$env:ORDER_DB_POOL_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_DB_CONTENTION_VUS = "8"
$env:ORDER_DB_CONTENTION_DURATION_SECONDS = "24"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/23-order-service-db-pool-contention.js
```

Expected: checks 100%, trace correlation preserved, recovered success after degrade window.

### db-05 — Resource model correctness

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RESOURCE_CORRECTNESS_RUN_ID = "db-05-test"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/26-resource-correctness-benchmark.js
```

Expected: checks 100%, `resource_model.db_rows` matches query param, `breakdown.db_ms` present.

### db-06 — Capacity sweep

```powershell
$env:BASE_URL = "http://localhost:80"
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "8"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"
$env:CAPACITY_MAX_VUS = "40"
$env:CAPACITY_DB_ROWS = "120"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

Expected: checks 100%, `dropped_iterations` interpreted with rate + VU pool, `db_ms` recorded.

### Variations cho db-06 (sweep)

```powershell
# Light: db_rows=10, rate=5
$env:CAPACITY_DB_ROWS = "10"; $env:CAPACITY_RATE = "5"

# Medium: db_rows=120, rate=8
$env:CAPACITY_DB_ROWS = "120"; $env:CAPACITY_RATE = "8"

# Heavy: db_rows=500, rate=15
$env:CAPACITY_DB_ROWS = "500"; $env:CAPACITY_RATE = "15"
```

## Run all

```powershell
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN

$cases = @(
  @{Id="db-05"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/app/26-resource-correctness-benchmark.js"; Env=@{RESOURCE_CORRECTNESS_RUN_ID="db-05-test"}},
  @{Id="db-01"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/app/07-production-mix-order-db-recovery.js"; Env=@{PROD_MIX_ORDER_DB_CONTROL_BASE_URL="http://localhost:80";PROD_MIX_ORDER_DB_DELAY_MS="35";PROD_MIX_ORDER_DB_DELAY_DELTA_MS="160";PROD_MIX_ORDER_DB_RECOVERY_DELTA_MS="120"}},
  @{Id="db-02"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/app/08-production-mix-order-db-pressure-recovery.js"; Env=@{PROD_MIX_ORDER_DB_PRESSURE_CONTROL_BASE_URL="http://localhost:80"}},
  @{Id="db-03"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/app/10-production-mix-order-db-fault-recovery.js"; Env=@{PROD_MIX_ORDER_DB_FAULT_CONTROL_BASE_URL="http://localhost:80";PROD_MIX_ORDER_DB_FAULT_MODE="tcp_reset"}},
  @{Id="db-04"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/app/23-order-service-db-pool-contention.js"; Env=@{ORDER_DB_POOL_CONTROL_BASE_URL="http://localhost:80";ORDER_DB_CONTENTION_VUS="8";ORDER_DB_CONTENTION_DURATION_SECONDS="24"}},
  @{Id="db-06"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js"; Env=@{CAPACITY_PROFILE="products_db_read";CAPACITY_RATE="8";CAPACITY_DURATION_SECONDS="30";CAPACITY_PRE_ALLOCATED_VUS="12";CAPACITY_MAX_VUS="40";CAPACITY_DB_ROWS="120"}}
)

$results = @()
foreach ($c in $cases) {
  Write-Host "=== $($c.Id) ===" -ForegroundColor Cyan
  foreach ($k in $c.Env.Keys) { Set-Item "env:$k" $c.Env[$k] }
  k6 run -o cloud $c.Script 2>&1 | Out-File -FilePath ".claude-$($c.Id)-output.txt"
  $results += [PSCustomObject]@{ Id=$c.Id; Exit=$LASTEXITCODE }
  Write-Host "$($c.Id) EXIT=$LASTEXITCODE"
}

Write-Host "`n=== SUMMARY ===" -ForegroundColor Cyan
$results | Format-Table -AutoSize
```
