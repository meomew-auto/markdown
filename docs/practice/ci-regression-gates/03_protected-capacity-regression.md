# ci-03 -- Protected capacity regression gate

> **Case ID:** `ci-03-protected-capacity-regression`
> **Script:** `load-target/k6/app/29-nonk8s-prod-approx.js`
> **Topology:** `full-no-cdn`, constant-vus, NO token
> **Mode:** `cpu_throttle`
> **Pattern:** Baseline vs Candidate -- CI chan PR gay unexpected errors khi he thong chiu ap luc

---

## 1. Tinh huong thuc te

Mot PR thay doi error handling, circuit breaker, hoac retry logic trong service. Khi he thong dang chiu ap luc (CPU throttle, memory pressure), degradation phai **predictable** -- 429 la co chu dich, 5xx la khong chap nhan duoc.

```text
PR: "Refactor circuit breaker with exponential backoff"
  |
  v
CI pipeline:
  1. Chay baseline voi cpu_throttle mode (RUN_ID = ci-pressure-baseline)
  2. Apply PR, chay candidate voi cpu_throttle mode (RUN_ID = ci-pressure-candidate)
  3. So sanh degradation pattern:
     a. 429 van visible → degradation van xay ra (tot)
     b. 5xx van = 0 → PR khong gay crash moi
     c. success_200 khong collapse → service van phuc vu duoi ap luc
     d. Resource trend giai thich duoc backpressure
```

**Cau hoi cot loi:** He thong co "chet dung cach" khong? Khi qua tai, no tu bao ve (429) hay sup do (5xx, crash)? PR co lam thay doi cach he thong degradation khong?

## 2. Capability

Script `29-nonk8s-prod-approx.js` voi mode `cpu_throttle`:

- 4 VUs lien tuc trong 16 giay
- `cpu_ms=35`, `retain_memory_kb=16384` -- day CPU + memory len cao
- Service bi ap luc se tra 429 de tu bao ve
- Script checks: `nonk8s_prod_approx_tolerated_errors` -- chap nhan 429 nhu expected behavior
- **Quan trong:** Script KHONG co `expectedStatuses(429)` cho tat ca endpoint -- 429 duoc accept qua `tolerated_errors` counter, khong phai expected status

## 3. Gate: Khi degradation la "predictable"

### The 429 contract

Trong he thong nay, 429 la **backpressure co chu dich**, khong phai incident:

```text
Client → [CPU=35ms, memory=16MB] → Service
                                      |
                                      v
                            Service detect qua tai
                                      |
                                      v
                            Tra 429 + Retry-After header
                                      |
                                      v
                            Client nhan 429 → retry sau
```

So voi crash/5xx:
- **429**: Service van song, van co kha nang tra linh, chi la tu choi request de bao ve chinh no
- **5xx**: Service crash hoac internal error -- mat kha nang phuc vu
- **Crash/connection reset**: Service chet han -- khong con phuc vu

**Gate logic cho degradation:**
- `nonk8s_prod_approx_tolerated_errors > 0` → 429 duoc ghi nhan (tot -- degradation visible)
- `unexpected 5xx count = 0` → khong co crash moi (tot -- degradation predictable)
- `success_200 count > 0` va khong giam dot bien → service van phuc vu (tot -- khong sup do)

### Phan biet "regression" vs "capacity boundary"

| Signal | Regression (PR gay loi) | Capacity boundary (binh thuong) |
| --- | --- | --- |
| 429 rate | **Tang dot bien** so voi baseline | Tuong duong baseline |
| 5xx count | **> 0** (moi xuat hien) | 0 (nhu baseline) |
| success_200 | **Collapse** (giam > 50%) | Tuong duong baseline |
| Latency p95 | **Tang dot bien** (service vat lon) | On dinh (rate-limited pattern) |
| Resource trend | CPU/memory **spike bat thuong** | On dinh o muc cao |

**Cach doc bang:** Neu candidate co 429 rate tuong duong baseline, 5xx = 0, success_200 on dinh → day la capacity boundary binh thuong. Neu 5xx > 0 hoac success_200 collapse → PR da gay regression.

## 4. Gate metrics for protected capacity

6 gate metrics ap dung trong boi canh pressure:

| Gate | Metric | Rule | Y nghia cho protected capacity |
| --- | --- | --- | --- |
| **availability** | `http_req_failed_rate` | `candidate <= max(0.01, baseline + 0.005)` | **Modified:** 429 duoc loai tru khoi failure rate. Gate chi phat hien 5xx moi. |
| **latencyP95** | `http_req_duration_p95` | `candidate <= baseline * 1.20 + 25ms` | Duoi pressure, latency cua request thanh cong van phai on dinh |
| **latencyP99** | `http_req_duration_p99` | `candidate <= baseline * 1.30 + 50ms` | Tail latency khong duoc tro nen te hon duoi pressure |
| **throughput** | `iterations` | `candidate >= baseline * 0.90` | Success throughput khong duoc collapse |
| **resourceCPU** | Container CPU p95 | `candidate <= baseline * 1.25 + 5pp` | PR khong lam CPU cao hon baseline pressure |
| **resourceMemory** | Container memory % max | `candidate <= baseline + 10pp` | PR khong lam memory cao hon baseline pressure |

### Capacity-specific signals (khong phai gate, nhung phai check)

```text
✅ nonk8s_prod_approx_tolerated_errors: candidate ≈ baseline (429 pattern on dinh)
✅ unexpected 5xx count: 0 (candidate) = 0 (baseline)
✅ success_200 count: khong giam > 50% so voi baseline
✅ Resource trend: CPU/memory trend consistent voi baseline
```

## 5. Pass/fail per gate metric

```text
✅ availability:     http_req_failed_rate (excl 429) = 0% (candidate) = 0% (baseline)
                    → PASS, khong co 5xx moi
⚠️ latencyP95:      15.2ms (candidate) <= 12.8 * 1.20 + 25 = 40.36ms
                    → PASS (nhung dang xem xet -- degrade nhe)
✅ latencyP99:       35.1ms (candidate) <= 28.3 * 1.30 + 50 = 86.79ms → PASS
⚠️ throughput:       180 iters (candidate) >= 195 * 0.90 = 175.5 → PASS (borderline)
✅ resourceCPU:      62.1% (candidate) <= 58.5 * 1.25 + 5 = 78.13% → PASS
✅ resourceMemory:   45.2% (candidate) <= 42.8 + 10 = 52.8% → PASS

Capacity-specific:
✅ tolerated_errors: 423 (candidate) ≈ 418 (baseline) -- 429 pattern on dinh
✅ unexpected 5xx:   0 (candidate) = 0 (baseline)
✅ success_200:      196 (candidate) ≈ 201 (baseline) -- khong collapse

→ overallStatus: pass
```

**Cac buoc kiem tra:**
- [ ] `nonk8s_prod_approx_tolerated_errors > 0` (429 duoc ghi nhan)
- [ ] Unexpected 5xx = 0 (khong co crash moi)
- [ ] `success_200 > 0` va on dinh (service van phuc vu)
- [ ] 429 rate tuong duong baseline (pattern degradation on dinh)
- [ ] Resource trend consistent (CPU/memory cao nhung on dinh)

## 6. Cach chay

### Baseline (truoc PR, cpu_throttle mode)

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:NONK8S_RUN_ID = "ci-pressure-baseline"
$env:NONK8S_MODE = "cpu_throttle"
$env:NONK8S_VUS = "4"
$env:NONK8S_DURATION_SECONDS = "16"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/29-nonk8s-prod-approx.js
```

Expected: `nonk8s_prod_approx_tolerated_errors > 0` (429 xuat hien), `nonk8s_prod_approx_failures = 0` (khong co 5xx bat ngo).

### Candidate (sau PR, cpu_throttle mode)

```powershell
# Chi khac RUN_ID so voi baseline
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:NONK8S_RUN_ID = "ci-pressure-candidate"
$env:NONK8S_MODE = "cpu_throttle"
$env:NONK8S_VUS = "4"
$env:NONK8S_DURATION_SECONDS = "16"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/29-nonk8s-prod-approx.js
```

Expected: `nonk8s_prod_approx_tolerated_errors ≈ baseline`, unexpected 5xx = 0, success_200 on dinh.

### Sau khi chay

Mo Dashboard → Production tab → chon baseline "ci-pressure-baseline" + candidate "ci-pressure-candidate" → xem gate results.

Kiem tra them trong Dashboard:
- **Status code distribution chart:** stacked bar 200 (xanh) + 429 (cam) + 5xx (do) -- 5xx bar phai = 0
- **Latency chart:** latency cua request thanh cong (200) phai on dinh ~12-15ms
- **Resource tab:** CPU/memory cao nhung on dinh, khong spike

## 7. Note: Expected 429 vs Unexpected errors

### Expected 429 (tot)

```text
✅ nonk8s_prod_approx_tolerated_errors > 0
✅ 429 chi xuat hien o endpoint CPU-intensive (/api/sim/products)
✅ Latency cua request 200 van thap (service rate-limits, khong slow down)
✅ Resource trend on dinh o muc cao
```

### Unexpected errors (regression)

```text
❌ 5xx xuat hien (502, 503, 504) -- service crash hoac timeout
❌ Connection reset -- service chet han
❌ success_200 = 0 -- service khong con phuc vu
❌ 429 tang dot bien 2x-3x so voi baseline -- PR da lam service nhan vua qua tai
❌ Resource spike bat thuong (CPU 100%, memory leo thang)
```

**Nguyen tac:** Neu candidate co 429 nhieu hon baseline DANG KE (khong phai nhieu do nhieu), co the PR da lam service nhan vua qua tai som hon. Day la regression. Nhung neu 429 ~ baseline, day la capacity boundary binh thuong.

## 8. Real validation

**Run #132** (cpu_throttle mode, truoc day) -- lam baseline reference:

| Metric | Value | Y nghia |
| --- | ---: | --- |
| Total requests | 923 | |
| Success (200) | ~100 | ~11% success rate -- service van phuc vu |
| Tolerated (429) | ~823 | ~89% 429 -- service tu bao ve |
| 5xx errors | 0 | Khong crash |
| p95 latency (200) | ~12ms | Latency cua request thanh cong thap |
| nonk8s_prod_approx_failures | 0 | Script accept 429 nhu expected |

Day la baseline degradation pattern: **89% 429, 11% 200, 0% 5xx, latency thap**. Bat ky PR nao lam thay doi pattern nay (5xx > 0, success collapse, latency spike) la regression.

### Candidate comparison

| Signal | Baseline (#132) | Candidate | Expected |
| --- | ---: | ---: | --- |
| 429 count | ~823 | ≈ baseline | Stable degradation |
| 5xx count | 0 | 0 | No crash regression |
| success_200 | ~100 | ≈ baseline | Service still serves |
| p95 (200 only) | ~12ms | ≈ baseline | Latency stable |
| tolerated_errors | > 0 | > 0 | Degradation visible |

## 9. Checklist nguoi hoc

- [ ] Hieu su khac biet giua 429 (backpressure co chu dich) va 5xx (crash khong mong muon)
- [ ] Chay baseline cpu_throttle → hieu degradation pattern: 429 cao, 5xx = 0, latency thap
- [ ] Chay candidate cpu_throttle → so sanh degradation pattern
- [ ] Biet cach doc status code distribution de phat hien 5xx moi
- [ ] Biet cach doc resource trend de phat hien spike bat thuong
- [ ] Phan biet "regression" (pattern thay doi) vs "capacity boundary" (pattern giong baseline)
- [ ] Hieu tai sao 429 duoc accept trong capacity gate nhung van la "user-facing degradation"
- [ ] Biet cach doc `nonk8s_prod_approx_tolerated_errors` counter
- [ ] Hieu: PR khong duoc lam he thong "chet khac di" -- degradation phai predictable

## 10. Anti-patterns

- **Treat 429 as failure in capacity gate:** 429 la expected, script da accept qua `tolerated_errors`. Gate focus vao 5xx moi
- **Expect 0% error rate under pressure:** cpu_throttle mode duoc thiet ke de tao 429. 0% error = test khong tao du ap luc
- **Block merge khi 429 ~ baseline:** 429 pattern giong baseline = capacity boundary binh thuong, khong phai regression
- **Quen check success_200:** PR co the khong gay 5xx nhung lam success_200 collapse → service khong con phuc vu → regression
- **So sanh latency cua 429 response:** 429 tra ve nhanh vi service khong process. Chi so sanh latency cua 200 response
- **Dung capacity gate cho green-path PR:** ci-03 chi ap dung cho PR thay doi error handling/circuit breaker/retry logic. Green-path PR nen dung ci-01
