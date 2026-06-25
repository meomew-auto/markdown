# External Layer — Run Guide

## Prerequisites

```powershell
docker compose --profile full-no-cdn up -d
docker ps | grep -E "payment-mock|catalog-events"
```

ext-07 cần `full` topology (có Varnish CDN).

## OPS_AUTH_TOKEN

```powershell
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
```

## Shared env

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
```

## Case-by-case

### ext-01 — Payment checkout matrix

```powershell
$env:PAYMENT_CHECKOUT_CONTROL_BASE_URL = "http://localhost:80"
$env:PAYMENT_MATRIX_MODE = "healthy"  # hoặc: slow, down, circuit_breaker

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/02-payment-checkout-matrix.js
```

Expected: 502 intentional trong `down` và `circuit_breaker` mode — không judge fail.

### ext-02 — Dependency recovery matrix

```powershell
$env:DEPENDENCY_RECOVERY_CONTROL_BASE_URL = "http://localhost:80"
$env:APP_DEPS_RECOVERY_DEPENDENCY = "redis"  # hoặc: postgres
$env:APP_DEPS_RECOVERY_FAULT_MODE = "dns_fail"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/03-dependency-recovery-matrix.js
```

### ext-03 — Order confirm payment retry

```powershell
$env:ORDER_CONFIRM_RETRY_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_CONFIRM_RETRY_FAIL_FIRST_N = "1"
$env:ORDER_CONFIRM_RETRY_MIN_ATTEMPTS = "2"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/12-order-confirm-payment-retry.js
```

Expected: `payment_attempts >= 2` trong transient phase.

### ext-04 — Payment webhook idempotency

```powershell
$env:PAYMENT_WEBHOOK_EVENT_TYPE = "payment.captured"
# Không cần OPS_AUTH_TOKEN

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/13-payment-webhook-idempotency.js
```

Expected: `webhook_duplicate=true` trên lần 2, `db_write_ms` cleared.

### ext-05 — Payment webhook ordering

```powershell
$env:PAYMENT_WEBHOOK_ORDERING_CAPTURE_EVENT_TYPE = "payment.captured"
$env:PAYMENT_WEBHOOK_ORDERING_STALE_EVENT_TYPE = "payment.failed"
# Không cần OPS_AUTH_TOKEN

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/14-payment-webhook-ordering.js
```

Expected: `payment_regression_ignored=true` trên stale event.

### ext-06 — Mixed payment + DB recovery

```powershell
$env:PROD_MIX_PAYMENT_ORDER_DB_CONTROL_BASE_URL = "http://localhost:80"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/09-production-mix-payment-order-db-recovery.js
```

### ext-07 — Catalog event invalidation

```powershell
# Cần topology full (có Varnish CDN)!
docker compose --profile full up -d

$env:CDN_BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/06-invalidation-events.js
```

Expected: warmup HIT → event → MISS sequence.
