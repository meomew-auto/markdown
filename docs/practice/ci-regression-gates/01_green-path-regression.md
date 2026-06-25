# ci-01 -- Green-path API regression gate

> **Case ID:** `ci-01-green-path-regression`
> **Script:** `load-target/k6/app/32-per-vu-business-core.js`
> **Topology:** `full-no-cdn`, per-vu-iterations, NO token
> **Pattern:** Baseline vs Candidate -- CI chặn regression trong business-flow code

---

## 1. Tinh huong thuc te

Mot PR thay doi business logic -- vi du: toi uu hoa cart checkout flow, refactor auth middleware, hoac them cache layer cho products API. Team muon CI tu dong xac nhan rang **PR nay khong lam cham he thong hoac tang error rate**.

```text
PR: "Refactor cart calculation logic"
  |
  v
CI pipeline:
  1. Checkout main branch → chay baseline (RUN_ID = ci-01-baseline)
  2. Checkout PR branch → chay candidate (RUN_ID = ci-01-candidate)
  3. So sanh: candidate vs baseline
  4. Neu latency p95 tang > 20% + 25ms → FAIL, block merge
  5. Neu error rate tang > 0.5pp → FAIL, block merge
  6. Neu tat ca pass → MERGE allowed
```

Day la pattern CI gate dien hinh: **moi PR chay script giong het nhau, chi khac code**. Gate khong danh gia candidate mot minh (no co the van "xanh" neu latency 15ms < SLO 500ms) -- no so sanh voi baseline de phat hien regression nho nhung co y nghia.

## 2. Capability

Script `32-per-vu-business-core.js` test toan bo business flow cua he thong:

| Scenario | Endpoints | Purpose |
| --- | --- | --- |
| **Stateful flow** | `POST /api/sim/register` → `POST /api/sim/auth/login` → `GET /api/sim/products` → `POST /api/sim/cart/add` → `GET /api/sim/cart/summary` → `POST /api/sim/orders/checkout` → `GET /api/sim/orders/report` | Business flow day du: tu register den checkout |
| **A/B test** | `GET /api/sim/products?experiment=A` vs `GET /api/sim/products?experiment=B` | 2 variant duoc goi song song, so sanh latency |
| **Race condition** | 4 VUs dong thoi `POST /api/sim/cart/add` cung product | Phat hien race condition trong cart |
| **Idempotency** | 4 VUs goi `POST /api/sim/orders/checkout` nhieu lan | Xac nhan order khong bi duplicate |
| **Batch** | `POST /api/sim/orders/batch-report` | Batch operation voi nhieu order ID |

Gate focus vao green-path: tat ca request thanh cong (200), checks pass, latency thap.

## 3. Gate metrics applied to green-path

6 gate metrics ap dung cho business flow:

| Gate | Metric | Rule | Y nghia cho green-path |
| --- | --- | --- | --- |
| **availability** | `http_req_failed_rate` | `candidate <= max(0.01, baseline + 0.005)` | PR khong duoc gay loi moi |
| **latencyP95** | `http_req_duration_p95` | `candidate <= baseline * 1.20 + 25ms` | PR khong duoc lam p95 cham hon 20% |
| **latencyP99** | `http_req_duration_p99` | `candidate <= baseline * 1.30 + 50ms` | Tail latency khong duoc tro nen te hon |
| **throughput** | `iterations` | `candidate >= baseline * 0.90` | PR khong duoc giam throughput > 10% |
| **resourceCPU** | Container CPU p95 | `candidate <= baseline * 1.25 + 5pp` | PR khong gay CPU spike |
| **resourceMemory** | Container memory % max | `candidate <= baseline + 10pp` | PR khong gay memory leak |

### Tai sao latency gate co offset (+25ms, +50ms)

Voi baseline p95 = 9ms, chi ap dung multiplier (9 * 1.20 = 10.8ms) qua chat -- moi thay doi 2ms se fail. Offset +25ms tao ra "vung khong quan tam" cho nhieu duoi 25ms va chi bat dau quan tam khi latency tang ro ret.

```text
Baseline p95 = 9.2ms
  → Threshold = 9.2 * 1.20 + 25 = 36.04ms
  → Candidate p95 = 9.29ms → PASS (9.29 << 36.04)

Neu baseline p95 = 200ms (production)
  → Threshold = 200 * 1.20 + 25 = 265ms
  → Candidate p95 = 250ms → PASS (250 < 265)
  → Candidate p95 = 270ms → FAIL (270 > 265)
```

Offset +25ms dam bao gate khong gay nhieu cho small baselines nhung van nhay voi production-scale latencies.

## 4. Pass/fail per gate metric

```text
✅ availability:     http_req_failed_rate = 0 (candidate) <= max(0.01, 0 + 0.005) = 0.01 → PASS
✅ latencyP95:       9.29ms (candidate) <= 9.20 * 1.20 + 25 = 36.04ms → PASS
✅ latencyP99:       12.3ms (candidate) <= 12.1 * 1.30 + 50 = 65.73ms → PASS
✅ throughput:       48 iters (candidate) >= 48 * 0.90 = 43.2 → PASS
✅ resourceCPU:      8.5% (candidate) <= 8.2 * 1.25 + 5 = 15.25% → PASS
✅ resourceMemory:   12.3% (candidate) <= 12.1 + 10 = 22.1% → PASS

→ overallStatus: pass
```

**Cac buoc kiem tra:**
- [ ] `per_vu_business_core_failures = 0`
- [ ] `checks rate = 100%`
- [ ] `http_req_failed = 0%`
- [ ] Latency p95 on dinh ~9-10ms
- [ ] Khong co unexpected status code (5xx, connection reset)
- [ ] Tat ca 6 gate metrics pass

## 5. Cach chay

### Baseline (main branch)

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:PERVU_CORE_RUN_ID = "ci-01-baseline"
$env:PERVU_CORE_STATEFUL_VUS = "4"
$env:PERVU_CORE_STATEFUL_ITERS = "4"
$env:PERVU_CORE_AB_VUS_PER_ARM = "2"
$env:PERVU_CORE_AB_ITERS = "2"
$env:PERVU_CORE_RACE_VUS = "4"
$env:PERVU_CORE_RACE_ITERS = "1"
$env:PERVU_CORE_IDEMP_VUS = "4"
$env:PERVU_CORE_IDEMP_ITERS = "2"
$env:PERVU_CORE_BATCH_VUS = "2"
$env:PERVU_CORE_BATCH_ITERS = "2"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/32-per-vu-business-core.js
```

### Candidate (feature branch)

```powershell
# Chi khac RUN_ID so voi baseline
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:PERVU_CORE_RUN_ID = "ci-01-candidate"
$env:PERVU_CORE_STATEFUL_VUS = "4"
$env:PERVU_CORE_STATEFUL_ITERS = "4"
$env:PERVU_CORE_AB_VUS_PER_ARM = "2"
$env:PERVU_CORE_AB_ITERS = "2"
$env:PERVU_CORE_RACE_VUS = "4"
$env:PERVU_CORE_RACE_ITERS = "1"
$env:PERVU_CORE_IDEMP_VUS = "4"
$env:PERVU_CORE_IDEMP_ITERS = "2"
$env:PERVU_CORE_BATCH_VUS = "2"
$env:PERVU_CORE_BATCH_ITERS = "2"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/32-per-vu-business-core.js
```

## 6. Real validation

**Runs #150 (baseline) va #151 (candidate)** -- 2026-06-26:

| Metric | Baseline (#150) | Candidate (#151) | Threshold | Verdict |
| --- | ---: | ---: | ---: | --- |
| http_req_failed_rate | 0.0% | 0.0% | <= 1.0% | pass |
| p95 latency | 9.20ms | 9.29ms | <= 36.04ms | pass |
| p99 latency | 12.10ms | 12.30ms | <= 65.73ms | pass |
| iterations | 48 | 48 | >= 43 | pass |
| checks rate | 100% | 100% | -- | -- |
| per_vu_business_core_failures | 0 | 0 | -- | -- |

Ca 2 run deu xanh, tat ca gate pass. Delta latency chi 0.09ms (0.98%) -- nhieu trang thiet bi do. Day la baseline reference cho cac PR sau.

### Dashboard Production tab

Sau khi chay ca 2 run, mo Dashboard → Production tab:
- Chon baseline: run #150
- Chon candidate: run #151
- Gate results hien thi: 6/6 pass, overallStatus = pass
- Summary diff: latency delta < 1%, throughput identical, error rate 0
- Resource diff: CPU/memory near-identical

## 7. Checklist nguoi hoc

- [ ] Hieu pattern baseline vs candidate: 2 run, chi khac RUN_ID, tat ca env vars khac giong het
- [ ] Chay baseline → luu ket qua
- [ ] Chay candidate → mo Dashboard so sanh
- [ ] Doc duoc gate results: pass/warn/fail per metric
- [ ] Hieu tai sao latency gate co offset +25ms (bao ve small baselines)
- [ ] Hieu su khac biet giua "candidate xanh mot minh" va "candidate khong regression so voi baseline"
- [ ] Biet cach export compare artifact JSON cho CI agent

## 8. Anti-patterns

- **Chi nhin candidate mot minh:** "p95 = 9.29ms, con thap" -- sai, neu baseline p95 = 5ms thi day la regression 86%
- **Thay doi env vars giua baseline va candidate:** Khong con la regression test, dang lam capacity exploration
- **Block merge khi chi co warn:** warn = can review, khong block. Chi fail moi block
- **Quen kiem tra resource:** Code thay doi co the lam CPU tang nhung latency van thap (vd them logging) -- resourceCPU gate se bat duoc
- **Dung SLO threshold thay vi gate threshold:** SLO p95 = 500ms khong phai la gate. Gate la 20% deviation tu baseline, ngay ca khi baseline = 9ms
