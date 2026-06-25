# soak-03 -- Dependency recovery endurance

> **Case ID:** `soak-03-dependency-recovery-endurance`
> **Script:** `../app/03-dependency-recovery-matrix.js`
> **Profile:** `full-no-cdn`, 1 VU, 1 iteration, **CAN OPS_AUTH_TOKEN**
> **Proof:** He thong co the chiu dung repeated Redis/Postgres disruption ma khong bi permanent degradation. Moi lan fault -> recovery sach se, khong co accumulation.

---

## 1. Tinh huong thuc te

```text
3 gio sang. Monitoring alert:
  "Redis connection failed -- products-service returning 500"

Team DevOps fix Redis, service tu dong recover.
  -> 5 phut sau: Lai fail
  -> Fix lai, recover
  -> 15 phut sau: Lai fail
  -> Fix lai, recover

Cau hoi:
  - Sau 3 lan fail + recover, latency co ve baseline khong?
  - Sau 3 lan fail + recover, memory co cao hon ban dau khong?
  - Co connection pool bi ro ri khong?
  - Co background goroutine nao bi hung khong?

Neu mot lan fail + recover la OK, nhung 5 lan thi memory day hoac latency tang gap doi,
day la degradation accumulation -- chi soak test moi tim ra.
```

Redis fails repeatedly -- does the system recover cleanly every time? Day la cau hoi soak-03 tra loi.

## 2. Capability

- **Repeated fault -> recovery cycles**: Inject Redis failure (dns_fail hoac tcp_reset), doi service recover, kiem tra health, lap lai
- **Health check after each recovery**: Service co tro lai healthy khong? Latency co ve baseline khong?
- **No degradation accumulation**: Memory, CPU khong climb sau nhieu lan recovery
- **No 5xx outside fault windows**: Chi co errors trong thoi gian fault, khong co errors sau khi recover
- **Transition time measurement**: Do `app_deps_recovery_transition_ms` -- thoi gian service nhan ra dependency da fail
- **Restore time measurement**: Do `app_deps_recovery_restore_ms` -- thoi gian service recover sau khi dependency duoc restore

## 3. Soak-specific checks

```text
PASS:
  - Service returns to healthy status sau moi fault phase
  - Latency returns to baseline sau moi recovery
  - Service memory khong climb sau repeated recovery cycles
  - Service CPU khong climb sau repeated recovery cycles
  - Khong co unexpected 5xx ben ngoai fault windows
  - app_deps_recovery_check_failures = 0
  - checks rate = 100%

FAIL signals:
  - Latency khong ve baseline sau recovery -> PERMANENT DEGRADATION
  - Memory tang dan qua moi cycle -> MEMORY LEAK FROM RECOVERY
  - CPU tang dan qua moi cycle -> BACKGROUND GOROUTINE ACCUMULATION
  - 5xx ben ngoai fault window -> INCOMPLETE RECOVERY
  - Transition time tang dan qua moi cycle -> RECOVERY SLOWDOWN
```

## 4. Co che fault injection

Script `03-dependency-recovery-matrix.js` su dung OPS API de inject fault:

```text
1. GET /ops/app/deps/health?dependency=redis  -> kiem tra health ban dau
2. POST /ops/app/deps/fault?dependency=redis&mode=dns_fail&timeout=12s
   -> Inject fault: Redis DNS fail trong 12 giay
3. Poll GET /ops/app/deps/health?dependency=redis
   -> Do transition time (khi service nhan ra Redis da fail)
4. Doi fault timeout (12s) + settle time
5. GET /ops/app/deps/health?dependency=redis
   -> Confirm service da recover
6. Do restore time (thoi gian tu khi fault ket thuc den khi service healthy)
7. GET /api/sim/products?cpu_ms=2&db_rows=10 (normal traffic)
   -> Kiem tra latency da ve baseline chua
```

Tat ca deu can `OPS_AUTH_TOKEN`.

## 5. OPS_AUTH_TOKEN

> **CAN OPS_AUTH_TOKEN.** Token duoc source tu container runtime.
> **Khong bao gio in token ra log, console, hoac docs.**

### Cach lay token

```powershell
# Lay token tu container -- khong in ra man hinh
$env:OPS_AUTH_TOKEN = docker exec <app-container> printenv OPS_AUTH_TOKEN
```

Hoac:

```powershell
# Neu chay trong Docker Compose
$env:OPS_AUTH_TOKEN = docker compose exec app printenv OPS_AUTH_TOKEN
```

Token duoc su dung trong headers:
- `Authorization: Bearer <token>`
- `X-Ops-Token: <token>`

## 6. Cach chay

### Short profile

```powershell
$env:BASE_URL = "http://localhost:80"
$env:OPS_AUTH_TOKEN = "<token-tu-docker-exec>"
$env:APP_DEPS_RECOVERY_DEPENDENCY = "redis"
$env:APP_DEPS_RECOVERY_FAULT_MODE = "dns_fail"
$env:APP_DEPS_RECOVERY_TIMEOUT_SECONDS = "12"
$env:APP_DEPS_RECOVERY_INTERVAL_SECONDS = "0.5"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/03-dependency-recovery-matrix.js
```

Thoi gian chay: **~2 phut** (1 iteration, nhieu lan fault + recovery + health check).

Expected: Service recovers cleanly, latency returns to baseline, memory does not climb, 0 unexpected 5xx.

### Cac fault modes

| Mode | Mo ta | Khi nao dung |
| --- | --- | --- |
| `dns_fail` | DNS resolution fail -- service khong the resolve Redis hostname | Test service recovery khi DNS bi loi (network partition) |
| `tcp_reset` | TCP connection reset -- ket noi bi drop dot ngot | Test service recovery khi Redis bi crash/kill |

### Cac dependency targets

| Dependency | Test case |
| --- | --- |
| `redis` | Redis fail -> products service co cache fallback khong? Cart service co bi mat session khong? |
| `postgres` | Postgres fail -> service co circuit breaker khong? Co retry logic khong? |

## 7. Repeated recovery vs Single fault

> **Quan trong:** Day la **REPEATED RECOVERY** (nhieu lan fault -> recovery), khong phai single fault test.

```text
Single fault test (ext-02 trong external layer):
  - 1 lan Redis fail
  - Kiem tra: Service co detect duoc fail khong? Co degrade dung cach khong?
  -> Muc tieu: Xac nhan fault detection + graceful degradation

Repeated recovery test (soak-03 o day):
  - Nhieu lan Redis fail + recover (>=3 cycles)
  - Kiem tra: Sau moi lan recover, system co ve trang thai baseline khong?
  - Memory co climb khong? Latency co drift khong? Connection pool co bi ro ri khong?
  -> Muc tieu: Xac nhan KHONG co degradation accumulation
```

| Dac diem | Single fault (ext-02) | Repeated recovery (soak-03) |
| --- | --- | --- |
| So lan fault | 1 | >=3 |
| Muc tieu | Detection + degradation | No accumulation |
| Memory check | Khong can | **CAN** -- check slope |
| Latency check | Trong luc fault | Sau recovery -- compare voi baseline |
| Script | `02-dependency-fault-matrix.js` | `03-dependency-recovery-matrix.js` |

## 8. What to watch

### Sau moi recovery cycle

```text
Cycle 1: fault -> recover -> health OK, latency=12ms, memory=45MB
Cycle 2: fault -> recover -> health OK, latency=13ms, memory=46MB (+1MB)
Cycle 3: fault -> recover -> health OK, latency=12ms, memory=46MB (flat)
Cycle 4: fault -> recover -> health OK, latency=13ms, memory=47MB (+1MB)
Cycle 5: fault -> recover -> health OK, latency=19ms, memory=52MB (+5MB)

-> Cycle 5: LATENCY DRIFT + MEMORY JUMP -> degradation accumulation detected!
-> Can investigate: co phai connection pool bi ro ri sau nhieu lan recovery?
```

### Healthy pattern (PASS)

```text
Cycle 1: fault -> recover -> health OK, latency=12ms, memory=45MB
Cycle 2: fault -> recover -> health OK, latency=11ms, memory=46MB
Cycle 3: fault -> recover -> health OK, latency=12ms, memory=45MB
Cycle 4: fault -> recover -> health OK, latency=13ms, memory=46MB
Cycle 5: fault -> recover -> health OK, latency=12ms, memory=46MB

-> Latency on dinh trong 11-13ms, memory dao dong 45-46MB
-> KHONG CO ACCUMULATION -> PASS
```

### Transition time pattern

```text
Cycle 1: transition_ms = 500ms  (service nhan ra fail trong 0.5s)
Cycle 2: transition_ms = 480ms
Cycle 3: transition_ms = 510ms
Cycle 4: transition_ms = 490ms

-> STABLE: Transition time khong tang -> service detection logic hoat dong dung
```

## 9. Real validation

Chua co run validation cho soak-03. Can chay:

```powershell
$env:OPS_AUTH_TOKEN = "<token>"
$env:BASE_URL = "http://localhost:80"
$env:APP_DEPS_RECOVERY_DEPENDENCY = "redis"
$env:APP_DEPS_RECOVERY_FAULT_MODE = "dns_fail"
$env:APP_DEPS_RECOVERY_TIMEOUT_SECONDS = "12"
$env:APP_DEPS_RECOVERY_INTERVAL_SECONDS = "0.5"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/03-dependency-recovery-matrix.js
```

Expected: checks rate=100%, app_deps_recovery_check_failures=0, latency returns to baseline, memory flat, no 5xx outside fault windows.

## 10. Troubleshooting

| Hien tuong | Nguyen nhan co the | Cach kiem tra |
| --- | --- | --- |
| Transition time qua cao (>2s) | Service health check interval qua dai | Kiem tra health check config trong service |
| Latency khong ve baseline | Connection pool chua duoc reset | Kiem tra connection pool stats sau recovery |
| Memory tang qua moi cycle | Background goroutines khong duoc cleanup | Kiem tra goroutine count (`/debug/pprof/goroutine`) |
| 5xx ben ngoai fault window | Service khong nhan ra dependency da recover | Kiem tra circuit breaker state (co bi stuck open khong?) |
| `app_deps_recovery_check_failures > 0` | OPS API khong respond hoac token sai | Kiem tra OPS_AUTH_TOKEN, kiem tra OPS API endpoint |

## 11. Mo rong: Test voi Postgres

```powershell
$env:APP_DEPS_RECOVERY_DEPENDENCY = "postgres"
$env:APP_DEPS_RECOVERY_FAULT_MODE = "tcp_reset"
# Cac env khac giu nguyen

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/03-dependency-recovery-matrix.js
```

> **CANH BAO:** Postgres failure co the anh huong den nhieu service hon Redis.
> Chi test khi stack duoc lap rieng va san sang bi gian doan.
