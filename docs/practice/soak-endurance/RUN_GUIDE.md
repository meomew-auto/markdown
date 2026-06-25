# Soak Layer -- Run Guide

## Shared env

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
```

Chi soak-03 can `OPS_AUTH_TOKEN`.

---

## DURATION WARNING -- DOC KY TRUOC KHI CHAY

| Profile | Duration | An toan? | Ghi chu |
| --- | --- | --- | --- |
| **local-short** | 5m (300s) | An toan | Dung cho classroom, FE validation, hoc tap |
| **local-medium** | 15m-30m (900s+) | Can isolated stack | Dung cho dev verification truoc commit |
| **nightly** | 1h+ | **CHI TREN CI** | Khong bao gio chay tren may ca nhan dung chung stack |

> **CANH BAO NIGHTLY:** Nightly profile tao tai nguyen lien tuc trong >1 gio.
> Chi su dung khi target stack duoc lap rieng va co the reset sau khi chay.
> Chay nightly tren may ca nhan co the lam day disk, tran bo nho,
> hoac anh huong den cac service khac cung stack.

---

## soak-01 -- Green business flow endurance

### Short profile (5m -- classroom safe)

```powershell
$env:CAPACITY_RUN_ID = "soak-green-short"
$env:CAPACITY_PROFILE = "realistic_mix"
$env:CAPACITY_RATE = "3"
$env:CAPACITY_DURATION_SECONDS = "300"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"
$env:CAPACITY_MAX_VUS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

Expected: ~900 requests, 100% success, memory flat after warmup, p95 stable, 0 dropped_iterations.

### Medium profile (15m -- dev verification)

```powershell
$env:CAPACITY_RUN_ID = "soak-green-medium"
$env:CAPACITY_PROFILE = "realistic_mix"
$env:CAPACITY_RATE = "3"
$env:CAPACITY_DURATION_SECONDS = "900"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"
$env:CAPACITY_MAX_VUS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

> **CANH BAO:** Medium profile chay 15 phut. Dam bao stack duoc lap rieng,
> khong co ai khac dang test tren cung stack.

---

## soak-02 -- DB read endurance

### Short profile (5m -- classroom safe)

```powershell
$env:CAPACITY_RUN_ID = "soak-db-short"
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "3"
$env:CAPACITY_DB_ROWS = "80"
$env:CAPACITY_DURATION_SECONDS = "300"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"
$env:CAPACITY_MAX_VUS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

Expected: DB read traffic sustained, capacity_breakdown_db_ms stable, 429 ratio ~0.

### Medium profile (15m -- dev verification)

```powershell
$env:CAPACITY_RUN_ID = "soak-db-medium"
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "3"
$env:CAPACITY_DB_ROWS = "80"
$env:CAPACITY_DURATION_SECONDS = "900"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"
$env:CAPACITY_MAX_VUS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

> **Luu y:** Neu rate hoac db_rows duoc tang len cao co tinh (de test capacity ceiling),
> day la capacity exploration, khong phai soak. Phan loai ket qua la "capacity ceiling",
> khong phai "soak failure".

---

## soak-03 -- Dependency recovery endurance

> **CAN OPS_AUTH_TOKEN.** Token duoc source tu `docker exec` vao container.
> **Khong bao gio in token ra log, console, hoac docs.**

### Cach lay OPS_AUTH_TOKEN

```powershell
# Lay token tu container (khong in ra man hinh)
$env:OPS_AUTH_TOKEN = docker exec <app-container> printenv OPS_AUTH_TOKEN
```

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

Expected: Service recovers cleanly after each fault, latency returns to baseline, memory does not climb, no 5xx outside fault windows.

> **Luu y:** Day la **repeated recovery** (nhieu lan fault -> recovery).
> Single fault test nam o external layer (ext-02), khong phai o day.

---

## Dashboard: Production tab -> Soak readiness

Sau khi chay, mo `http://localhost:13001/` -> chon run -> tab **Production** -> soak readiness:

- **Resource sample count**: So luong resource samples thu thap duoc trong suot run.
  Voi ~2s cadence, 5m run = ~150 samples, 15m run = ~450 samples.
- **Memory slope**: Xu huong memory cua tung service theo thoi gian.
  Flat = khoe. Rising = can dieu tra.
- **CPU trend**: CPU % cua tung container. On dinh sau warmup = khoe.
- **p95/p99 trend**: Latency percentiles over time. Flat = khoe. Rising = drift.
- **Status breakdown**: 2xx/4xx/5xx distribution. 429 ratio tang dan = backpressure.
- **dropped_iterations**: Phai luon = 0. Neu > 0: VU pool khong du.

### Resource sample cadence

Dashboard lay resource samples tu `/v1/tests/:id/resources` voi cadence ~2 giay:

```text
5m run  = 300s / 2s = ~150 samples
15m run = 900s / 2s = ~450 samples
1h run  = 3600s / 2s = ~1800 samples
```

So luong samples cang nhieu, memory slope estimate cang chinh xac.

---

## Validation snapshot (2026-06-26)

| Case | Run | Checks | Signals | Result |
| --- | ---: | --- | --- | --- |
| soak-01 Green flow | #152 | 121/121 (100%) | flat memory, p95 stable, 0 drops | PASS |
| soak-02 DB read | pending | -- | -- | -- |
| soak-03 Dep recovery | pending | -- | -- | -- |

**Note:** soak-02 va soak-03 can duoc chay lai de dien day validation snapshot.
