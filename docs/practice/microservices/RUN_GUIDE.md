# Microservices Layer — Run Guide

## Prerequisites

Stack phải chạy với topology `full-no-cdn`:

```powershell
docker compose --profile full-no-cdn up -d
docker ps --format "table {{.Names}}\t{{.Status}}" | grep k6target
```

Phải thấy đủ 5 service: `auth-service`, `products-service`, `cart-service`, `order-service`, `report-service`.

## Shared env

Tất cả cases dùng chung:

```powershell
$env:BASE_URL = "http://localhost:80"
```

## Case-by-case

### ms-01 — Gateway routing smoke

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_07_VUS = "10"
$env:SI_07_JOBS = "100"
$env:SI_07_SLEEP_SECONDS = "0"

k6 run E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-07-ci-verification-batch.js
```

Expected: 100/100 jobs, 0 failures. X-Upstream-Service header cycles through all 5 services.

### ms-02 — Products read contract

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_01_VUS = "8"
$env:SI_01_JOBS = "80"
$env:SI_01_SLEEP_SECONDS = "0"

k6 run E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-01-catalog-audit.js
```

Expected: 80/80 jobs, 0 failures. products-service contract pass.

### ms-03 — Cart write contract

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_04_VUS = "8"
$env:SI_04_JOBS = "90"
$env:SI_04_SLEEP_SECONDS = "0"

k6 run E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-04-cart-cleanup.js
```

Expected: 90/90 jobs, 0 failures. cart-service contract pass.

### ms-04 — Order transaction contract

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_02_VUS = "8"
$env:SI_02_JOBS = "120"
$env:SI_02_SLEEP_SECONDS = "0"

k6 run E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-02-order-reconciliation.js
```

Expected: 120/120 jobs, 0 failures. order-service contract pass.

### ms-05 — Report async contract

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_06_VUS = "8"
$env:SI_06_JOBS = "80"
$env:SI_06_SLEEP_SECONDS = "0"

k6 run E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-06-report-export-batch.js
```

Expected: 80/80 jobs, 0 failures. report-service contract pass.

### ms-06 — Stateful business flow

```powershell
$env:BASE_URL = "http://localhost:80"
# Default config là đủ — không cần env override
k6 run E:/Projects/k6/k6-metrics-server/load-target/k6/app/32-per-vu-business-core.js
```

Expected: checks 100%, `per_vu_core_case_failures = 0`, tất cả 6 scenarios pass.

### ms-07 — Service health

```powershell
$env:BASE_URL = "http://localhost:80"
$env:APP_DEPS_EXPECTATION = "healthy"
$env:APP_DEPS_VUS = "2"
$env:APP_DEPS_DURATION = "24s"
$env:APP_DEPS_SLEEP_SECONDS = "0.2"

k6 run E:/Projects/k6/k6-metrics-server/load-target/k6/app/01-dependency-smoke.js
```

Expected: checks 100%, `app_deps_check_failures = 0`, tất cả dependencies "up".

## Ops token

Hầu hết microservices cases không cần `OPS_AUTH_TOKEN`. Chỉ cần cho các case có gọi `/ops/*` control plane (không nằm trong 7 case trên). Nếu cần, source từ container:

```powershell
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
```

## Run all

```powershell
$env:BASE_URL = "http://localhost:80"

$cases = @(
  @{Id="ms-01"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-07-ci-verification-batch.js"; Env=@{SI_07_VUS="10";SI_07_JOBS="100";SI_07_SLEEP_SECONDS="0"}},
  @{Id="ms-02"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-01-catalog-audit.js"; Env=@{SI_01_VUS="8";SI_01_JOBS="80";SI_01_SLEEP_SECONDS="0"}},
  @{Id="ms-03"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-04-cart-cleanup.js"; Env=@{SI_04_VUS="8";SI_04_JOBS="90";SI_04_SLEEP_SECONDS="0"}},
  @{Id="ms-04"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-02-order-reconciliation.js"; Env=@{SI_02_VUS="8";SI_02_JOBS="120";SI_02_SLEEP_SECONDS="0"}},
  @{Id="ms-05"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/shared-iterations/si-06-report-export-batch.js"; Env=@{SI_06_VUS="8";SI_06_JOBS="80";SI_06_SLEEP_SECONDS="0"}},
  @{Id="ms-06"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/app/32-per-vu-business-core.js"; Env=@{}},
  @{Id="ms-07"; Script="E:/Projects/k6/k6-metrics-server/load-target/k6/app/01-dependency-smoke.js"; Env=@{APP_DEPS_EXPECTATION="healthy";APP_DEPS_VUS="2";APP_DEPS_DURATION="24s";APP_DEPS_SLEEP_SECONDS="0.2"}}
)

$results = @()
foreach ($c in $cases) {
  Write-Host "=== $($c.Id) ===" -ForegroundColor Cyan
  foreach ($k in $c.Env.Keys) { Set-Item "env:$k" $c.Env[$k] }
  k6 run $c.Script 2>&1 | Out-File -FilePath ".claude-$($c.Id)-output.txt"
  $exit = $LASTEXITCODE
  $results += [PSCustomObject]@{ Id=$c.Id; Exit=$exit }
  Write-Host "$($c.Id) EXIT=$exit"
}

Write-Host "`n=== SUMMARY ===" -ForegroundColor Cyan
$results | Format-Table -AutoSize
```
