# soak-02 -- DB read endurance

> **Case ID:** `soak-02-db-read-endurance`
> **Script:** `../app/30-capacity-sizing-sweep.js`
> **Profile:** `full-no-cdn`, constant-arrival-rate, rate=3, db_rows=80
> **Proof:** DB read traffic duy tri ben vung -- Postgres va products-service khong bi memory drift, latency drift, hoac backpressure accumulation.

---

## 1. Tinh huong thuc te

```text
Mot tuan sau khi deploy, DBA bao dong:
  "Postgres memory da tang 200MB trong 1 tuan. Co ai query khong giai phong connection khong?"

Ban check 30s test:
  - DB queries: 100% success, avg 8ms
  -> "DB binh thuong ma?"

Nhung 30s test khong the thay:
  - Connection pool can kiet sau 1000 queries
  - Postgres memory tang 2MB/phut do query plan cache khong gioi han
  - products-service memory tang do khong giai phong result set
  - DB latency drift: 8ms (phut 1) -> 12ms (phut 3) -> 18ms (phut 5)

Soak-02 tra loi: Duoi tai DB read ben vung, tat ca signals co giu on dinh khong?
```

DB read traffic sustained -- Postgres hoac products-service memory co grow khong? Day la cau hoi soak-02 tra loi.

## 2. Capability

- Monitor **capacity_breakdown_db_ms** drift: DB query latency co tang dan khong?
- Monitor **products-service memory**: Co tang monotonically sau warmup khong?
- Monitor **Postgres container resources**: CPU, memory co xu huong tang khong?
- Monitor **backpressure**: 429 ratio = 0% o rate=3 (safe rate)?
- Phan biet **capacity ceiling** vs **soak failure**: Neu rate hoac db_rows duoc tang cao co tinh -> day la capacity exploration, khong phai soak

## 3. Tai sao chi DB read?

`products_db_read` profile goi mot endpoint duy nhat:

```text
GET /api/sim/products?cpu_ms=8&db_rows=80&json_items=100&limit=20&view=full
```

- Khong co DB write -> khong co table bloat, khong co WAL pressure
- Khong co external call -> khong co external drift noise
- Chi co DB read -> **moi latency drift la do DB hoac service**

Day la "pure signal" test: neu DB read latency drift, nguyen nhan chi co the la:
- Postgres query planner thay doi (bad plan cache)
- Connection pool can kiet
- Service memory growth (result set retention)
- OS page cache pressure

## 4. Soak-specific checks

```text
PASS:
  - capacity_breakdown_db_ms stable (khong tang > 2ms sau warmup)
  - products-service memory flat (slope < 0.5MB/min)
  - Postgres container memory flat
  - 429 ratio = 0% (rate=3 la safe rate)
  - dropped_iterations = 0
  - http_req_failed = 0

FAIL signals:
  - capacity_breakdown_db_ms tang dan -> DB QUERY DRIFT
  - products-service memory tang > 1MB/min -> SERVICE MEMORY LEAK
  - Postgres memory tang > 2MB/min -> POSTGRES MEMORY GROWTH
  - 429 xuat hien o rate=3 -> UNEXPECTED BACKPRESSURE (rate=3 rat thap, khong nen co 429)
  - dropped_iterations > 0 -> SCHEDULER ISSUE
```

## 5. Cach chay

### Short profile (5m -- an toan cho classroom)

```powershell
$env:BASE_URL = "http://localhost:80"
$env:CAPACITY_RUN_ID = "soak-db-short"
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "3"
$env:CAPACITY_DB_ROWS = "80"
$env:CAPACITY_DURATION_SECONDS = "300"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"
$env:CAPACITY_MAX_VUS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

Thoi gian chay: **5 phut**. So request du kien: 3 req/s * 300s = **~900 requests**.
Moi request query 80 rows tu Postgres -> tong cong ~72,000 rows duoc doc.

### Medium profile (15m -- dev verification)

```powershell
$env:CAPACITY_RUN_ID = "soak-db-medium"
$env:CAPACITY_DURATION_SECONDS = "900"
# Cac env khac giu nguyen nhu short profile

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

> **CANH BAO MEDIUM:** 15 phut chay lien tuc query DB. Dam bao stack duoc lap rieng.
> Neu dang chay tren shared Postgres instance, medium profile co the anh huong
> den nguoi khac.

---

## 6. Phan biet: Capacity ceiling vs Soak failure

Day la diem quan trong nhat cua soak-02:

```text
SOAK TEST (dung nghia):
  rate=3, db_rows=80 -> sustained capacity cua he thong
  Neu 429 xuat hien o rate=3 -> THAT SU LA VAN DE
  -> BAO DONG: He thong khong chiu duoc safe rate

CAPACITY EXPLORATION (khong phai soak):
  rate=8, db_rows=120 -> vuot sustained capacity
  Neu 429 xuat hien o rate=8 -> DAY LA BINH THUONG
  -> GHI NHAN: Capacity ceiling o ~5 success/s
```

| Tham so | Soak (dung nghia) | Capacity exploration |
| --- | --- | --- |
| `CAPACITY_RATE` | 3 (safe) | 8+ (stress) |
| `CAPACITY_DB_ROWS` | 80 (normal) | 120+ (heavy) |
| Muc tieu | Tim drift/leak | Tim ceiling |
| 429 expected? | **KHONG** | Co |
| Ket qua neu 429 | **FAIL** -- system yeu | **INFO** -- ceiling found |

> **Luu y quan trong:** Neu ban co tinh tang rate hoac db_rows de test capacity ceiling,
> hay phan loai ket qua la "capacity ceiling", **khong phai "soak failure"**.
> Dashboard nen hien thi ro rang: "Capacity ceiling reached at rate=X" vs "Soak drift detected".

## 7. What to watch

### DB query latency drift

```text
capacity_breakdown_db_ms trend:
  Minute 1:  avg=5ms, p95=8ms
  Minute 2:  avg=5ms, p95=9ms
  Minute 3:  avg=6ms, p95=9ms
  Minute 4:  avg=5ms, p95=8ms
  Minute 5:  avg=5ms, p95=8ms
  -> STABLE: Khong co drift
```

Neu `capacity_breakdown_db_ms` tang dan:
1. Check Postgres CPU/ memory co bi pressure khong
2. Check Postgres `pg_stat_statements` xem query plan co thay doi khong
3. Check connection pool size (co can kiet khong?)

### Service memory

```text
products-service memory trend:
  Minute 1:  48MB (warmup)
  Minute 2:  49MB (+1MB -- cache fill, OK)
  Minute 3:  49MB (flat -- OK)
  Minute 4:  50MB (+1MB -- borderline)
  Minute 5:  50MB (flat -- OK)
  -> ACCEPTABLE: Tang 1-2MB sau warmup la binh thuong (cache fill)
  -> WARNING: Neu tiep tuc tang o phut 6-10 -> leak
```

### Postgres container memory

```text
Postgres memory trend:
  Minute 1:  120MB
  Minute 2:  125MB (+5MB -- shared buffers warmup, OK)
  Minute 3:  126MB (+1MB -- OK)
  Minute 4:  126MB (flat -- OK)
  Minute 5:  126MB (flat -- OK)
  -> KHOE: Postgres memory on dinh sau khi shared buffers duoc fill
```

## 8. Real validation

Chua co run validation cho soak-02. Can chay:

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

Expected: ~900 requests, capacity_breakdown_db_ms stable, products-service memory flat, Postgres memory flat, 0% 429, 0 dropped_iterations.

## 9. Troubleshooting

| Hien tuong | Nguyen nhan co the | Cach kiem tra |
| --- | --- | --- |
| db_ms tang dan | Postgres query planner thay doi | `EXPLAIN ANALYZE` query, check `pg_stat_statements` |
| products-service memory tang | Result set khong duoc giai phong | Check `observed_resource_delta.heap_alloc_mb_delta` |
| Postgres memory tang | Shared buffers hoac work_mem pressure | Check Postgres config, giam `db_rows` de test |
| 429 o rate=3 | Service khong chiu duoc safe rate | Kiem tra service CPU, co the bi throttle |
| Connection pool errors | Pool size qua nho | Kiem tra service config connection pool max |
