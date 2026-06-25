# ext-02 — Dependency recovery matrix

> **Case ID:** `ext-02-dependency-recovery-matrix`
> **Script:** `../app/03-dependency-recovery-matrix.js`
> **Profile:** `full-no-cdn`, requires `OPS_AUTH_TOKEN`
> **Proof:** Inject dependency fault (Redis hoặc Postgres) → degraded observable → reset → recovered. System phân biệt được healthy, degraded, recovered states.

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

3:00 AM. Monitoring alert: "Redis connection failure — order-service health degraded". Team on-call check: Redis instance bị DNS failure (không resolve được hostname). Họ failover sang replica, DNS cache clear, service recover.

Câu hỏi: **Hệ thống có expose rõ ràng degraded state không?** Hay nó âm thầm fail? Khi dependency recover, service có tự động nhận ra không?

### 1.2 Recovery contract

```text
Healthy  → Fault injected  → Degraded observable  → Reset  → Recovered
(200 OK)   (dns_fail/tcp)    (errors/slowdown)       (clear)   (200 OK)
```

---

## 2. Key signals

| Phase | Signal |
| --- | --- |
| Healthy | Tất cả 200, dependency status = up |
| Degraded | Dependency fault active, errors observable |
| Recovered | Tất cả 200, dependency status = up |

Custom counters:
- `app_deps_recovery_degraded_observed` > 0
- `app_deps_recovery_recovered_observed` > 0
- `app_deps_recovery_check_failures = 0`

---

## 3. Cách chạy

```powershell
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
$env:DEPENDENCY_RECOVERY_CONTROL_BASE_URL = "http://localhost:80"
$env:APP_DEPS_RECOVERY_DEPENDENCY = "redis"
$env:APP_DEPS_RECOVERY_FAULT_MODE = "dns_fail"

k6 run -o cloud ...03-dependency-recovery-matrix.js
```

---

## 4. Variations

- `APP_DEPS_RECOVERY_DEPENDENCY=postgres` — test Postgres fault
- `APP_DEPS_RECOVERY_FAULT_MODE=tcp_reset` — different fault mode
