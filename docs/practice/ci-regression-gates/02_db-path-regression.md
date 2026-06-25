# ci-02 -- DB read/write regression gate

> **Case ID:** `ci-02-db-path-regression`
> **Script:** `load-target/k6/app/30-capacity-sizing-sweep.js`
> **Topology:** `full-no-cdn`, constant-arrival-rate, NO token
> **Profile:** `products_db_read`, `rate=4`, `db_rows=80`
> **Pattern:** Baseline vs Candidate -- CI chan DB query/index change gay regression

---

## 1. Tinh huong thuc te

Mot PR thay doi DB query (them index, thay doi JOIN strategy, refactor schema) hoac thay doi cache layer cho products service. Team muon CI xac nhan rang **DB-path latency khong tang, 429 rate khong nhay vot, va resource consumption khong dot bien**.

```text
PR: "Add composite index on products (category, price)"
  |
  v
CI pipeline:
  1. Chay baseline voi DB query cu (RUN_ID = ci-db-baseline)
  2. Apply PR, chay candidate voi DB query moi (RUN_ID = ci-db-candidate)
  3. So sanh DB-path metrics: db_ms p95, 429 count, resource
  4. Neu db_ms tang > 20% + 25ms → WARN (DB path cham hon)
  5. Neu 429 rate tang dot bien → FAIL (system self-protection tang)
  6. Neu resource CPU/memory tang bat thuong → WARN
```

Khac voi ci-01 (green-path, latency thap), ci-02 tap trung vao **DB-path specific metrics**: `capacity_breakdown_db_ms`, 429 status count, va `dropped_iterations`. Resource CPU/memory cung duoc gate vi DB change co the shift resource profile (vd: index moi ton CPU de maintain, hoac cache layer dung nhieu memory).

## 2. Capability

Script `30-capacity-sizing-sweep.js` voi profile `products_db_read`:

- `GET /api/sim/products?cpu_ms=8&db_rows=80` → DB doc 80 rows, CPU process 8ms
- Arrival rate co dinh = 4 req/s -- khong phai sweep (sweep la capacity exploration, khong phai regression gate)
- `capacity_breakdown`: phan tich cpu_ms, db_ms, external_ms, memory_kb, disk_kb
- `capacity_bottleneck_samples`: classifier phat hien bottleneck (cpu/db/external/memory/disk)

**Tai sao rate=4:** Du thap de he thong xanh hoan toan (0% 429), du cao de DB path co du samples. Voi rate cao hon, 429 tu rate limiter se lam nhiou DB metric.

**Tai sao db_rows=80:** DB load vua phai -- khong qua nhe (10 rows = khong y nghia), khong qua nang (120 rows gan capacity ceiling). 80 rows cho DB-path latency co y nghia de so sanh.

## 3. Gate metrics focused on DB path

6 gate metrics ap dung cho DB-path scenario:

| Gate | Metric | Rule | Y nghia cho DB path |
| --- | --- | --- | --- |
| **availability** | `http_req_failed_rate` | `candidate <= max(0.01, baseline + 0.005)` | DB change khong duoc tang 429/error rate |
| **latencyP95** | `http_req_duration_p95` | `candidate <= baseline * 1.20 + 25ms` | Tong latency (bao gom db_ms) khong duoc tang |
| **latencyP99** | `http_req_duration_p99` | `candidate <= baseline * 1.30 + 50ms` | Tail latency quan trong voi DB query (index scan vs seq scan) |
| **throughput** | `iterations` | `candidate >= baseline * 0.90` | DB change khong duoc giam throughput |
| **resourceCPU** | Container CPU p95 | `candidate <= baseline * 1.25 + 5pp` | Index moi co the tang CPU write overhead |
| **resourceMemory** | Container memory % max | `candidate <= baseline + 10pp` | Cache layer thay doi co the tang memory |

### DB-specific evidence: breakdown

Ngoai 6 gate metrics, DB-path regression gate con doc them **breakdown data** de xac nhan:

```text
capacity_breakdown_db_ms p95/p99:
  Baseline: db_ms p95 = 3.2ms, p99 = 5.1ms
  Candidate: db_ms p95 = 3.5ms, p99 = 5.3ms
  → DB path khong regression (delta < 10%)

429/error count from request breakdown:
  Baseline: 429 count = 0, error rate = 0%
  Candidate: 429 count = 0, error rate = 0%
  → Khong co 429 moi

dropped_iterations:
  Baseline: 0, Candidate: 0
  → k6 scheduler khong drop request
```

### Tai sao resource CPU/memory quan trong cho DB gate

DB index change co the shift resource profile:
- **Index moi** → INSERT/UPDATE cham hon (write overhead) → CPU co the tang
- **Cache layer them vao** → memory tang, nhung latency giam -- day la trade-off co chu dich, khong phai regression
- **Connection pool thay doi** → memory tang nhe, khong anh huong latency

Resource gate bao ve nhung thay doi "vo hinh" ma latency gate khong bat duoc.

## 4. Pass/fail per gate metric

```text
✅ availability:     http_req_failed_rate = 0% (candidate) <= max(0.01, 0 + 0.005) = 0.01 → PASS
✅ latencyP95:       8.5ms (candidate) <= 7.8 * 1.20 + 25 = 34.36ms → PASS
✅ latencyP99:       18.2ms (candidate) <= 16.5 * 1.30 + 50 = 71.45ms → PASS
✅ throughput:       120 iters (candidate) >= 118 * 0.90 = 106.2 → PASS
✅ resourceCPU:      18.5% (candidate) <= 15.2 * 1.25 + 5 = 24.0% → PASS
✅ resourceMemory:   22.1% (candidate) <= 20.5 + 10 = 30.5% → PASS

DB breakdown:
✅ capacity_breakdown_db_ms p95: 3.5ms (candidate) ≈ 3.2ms (baseline)
✅ 429 count: 0 (candidate) = 0 (baseline)
✅ dropped_iterations: 0 (candidate) = 0 (baseline)

→ overallStatus: pass
```

**Cac buoc kiem tra:**
- [ ] `capacity_sizing_failures = 0`
- [ ] `capacity_breakdown_db_ms` p95/p99 on dinh
- [ ] `dropped_iterations = 0`
- [ ] 429 count = 0 (day la green-path rate, khong nen co 429)
- [ ] Resource CPU/memory khong dot bien

## 5. Cach chay

### Baseline (truoc DB change)

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:CAPACITY_RUN_ID = "ci-db-baseline"
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "4"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_DB_ROWS = "80"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"
$env:CAPACITY_MAX_VUS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

### Candidate (sau DB change)

```powershell
# Chi khac RUN_ID so voi baseline
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:CAPACITY_RUN_ID = "ci-db-candidate"
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "4"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_DB_ROWS = "80"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"
$env:CAPACITY_MAX_VUS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

### Sau khi chay

Mo Dashboard → Production tab → chon baseline "ci-db-baseline" + candidate "ci-db-candidate" → xem gate results.

Kiem tra them trong Dashboard:
- **Capacity tab:** `capacity_breakdown` chart -- so sanh db_ms p95 giua 2 run
- **Request breakdown:** status code distribution -- xac nhan 0% 429
- **Resource tab:** CPU/memory trend -- xac nhan khong dot bien

## 6. Note: Regression gate vs Capacity exploration

**Regression gate (ci-02):** Env vars GIONG HET. Chi khac code. Muc tieu: phat hien regression.

```text
Baseline: rate=4, db_rows=80 → latency p95 = 7.8ms
Candidate: rate=4, db_rows=80 → latency p95 = 8.5ms → PASS (delta 9%)
```

**Capacity exploration (KHONG PHAI regression gate):** Thay doi `db_rows` hoac `rate`. Muc tieu: tim capacity boundary.

```text
Baseline: rate=4, db_rows=80 → latency p95 = 7.8ms
Candidate: rate=8, db_rows=120 → latency p95 = 9.0ms, 24% 429
→ Day la capacity exploration, khong phai regression gate
→ Gate khong co y nghia o day vi env vars khac nhau
```

**Quan trong:** Neu candidate co y thay doi `db_rows` hoac `rate`, phai ghi ro rang -- day la capacity exploration, khong phai regression test. Gate chi co y nghia khi so sanh hai run voi cung tham so.

## 7. Real validation

| Metric | Baseline | Candidate | Threshold | Verdict |
| --- | ---: | ---: | ---: | --- |
| http_req_failed_rate | 0.0% | 0.0% | <= 1.0% | pass |
| p95 latency | (pending) | (pending) | (formula) | (pending) |
| p99 latency | (pending) | (pending) | (formula) | (pending) |
| capacity_breakdown_db_ms p95 | (pending) | (pending) | -- | (pending) |
| 429 count | (pending) | (pending) | -- | (pending) |
| dropped_iterations | (pending) | (pending) | = 0 | (pending) |

## 8. Checklist nguoi hoc

- [ ] Hieu DB path specific metrics: `capacity_breakdown_db_ms`, 429 count, `dropped_iterations`
- [ ] Chay baseline voi rate=4, db_rows=80 → luu DB-path latency reference
- [ ] Chay candidate voi cung tham so → so sanh
- [ ] Doc duoc breakdown data de xac nhan DB path khong regression
- [ ] Hieu su khac biet giua "DB change gay regression" va "DB change shift resource profile co chu dich"
- [ ] Biet cach doc resource CPU/memory de phat hien "vo hinh" side effects
- [ ] Phan biet regression gate (env vars giong het) vs capacity exploration (env vars thay doi)
- [ ] Biet cach xem Capacity tab trong Dashboard de so sanh breakdown giua 2 run
