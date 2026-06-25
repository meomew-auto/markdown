# ext-06 — Payment plus order DB mixed recovery

> **Case ID:** `ext-06-payment-order-db-mixed-recovery`
> **Script:** `../app/09-production-mix-payment-order-db-recovery.js`
> **Profile:** `full-no-cdn`, requires `OPS_AUTH_TOKEN`
> **Proof:** Payment + Postgres cùng degraded → system phân biệt được source của degradation → `target_dependency=payment_plus_postgres`, `degradation_mode=mixed` → recovered.

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Black Friday 23:50. Cả payment gateway VÀ Postgres đều có vấn đề:
- Payment gateway: latency spike 3s
- Postgres: connection pool exhausted

Team on-call cần biết: **request nào fail vì payment? Request nào fail vì DB?** Nếu không phân biệt được, họ sẽ debug sai hướng.

### 1.2 Mixed degradation

```text
Checkout bị ảnh hưởng bởi CẢ HAI:
  external_ms → payment-mock latency
  db_write_ms → Postgres write time

Dashboard phải tách được 2 source này.
```

---

## 2. Key signals

| Signal | Source |
| --- | --- |
| `external_ms` | Payment gateway |
| `db_ms` / `db_write_ms` | Postgres |
| `bottleneck` | `external_ms` hoặc `db_ms` — cái nào lớn hơn? |
| `target_dependency` | `payment_plus_postgres` |
| `degradation_mode` | `mixed` |

---

## 3. Cách chạy

```powershell
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
$env:PROD_MIX_PAYMENT_ORDER_DB_CONTROL_BASE_URL = "http://localhost:80"

k6 run -o cloud ...09-production-mix-payment-order-db-recovery.js
```
