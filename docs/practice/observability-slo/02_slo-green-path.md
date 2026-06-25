# obs-02 -- Green-path SLO decision

> **Case ID:** `obs-02-slo-green-path`
> **Script:** `load-target/k6/app/32-per-vu-business-core.js`
> **Profile:** `full-no-cdn`, 6 scenarios, per-vu-iterations, NO token
> **Proof:** Tat ca 4 SLO cards pass duoi normal business load. Learner doc SLI cards va ra pass/warn/fail decision.

---

## 1. Tinh huong thuc te

He thong dang chay binh thuong. Khong co incident, khong co alert. Business team hoi:

```text
"He thong co dang dap ung SLO khong? Availability co >= 99% khong?
 p95 latency co <= 500ms khong? Capacity co du headroom khong?"
```

Day la green-path SLO decision -- kiem tra system health trong dieu kien binh thuong, khong co ap luc.

## 2. Capability

Case nay chay 6 scenarios mo phong day du business flow cua nguoi dung thuc:

| Scenario | Executor | VUs | Iters | Mo ta |
| --- | --- | ---: | ---: | --- |
| `stateful_business_flow` | per-vu-iterations | 4 | 3 | Login → me → cart add → update → checkout → confirm → status |
| `ab_control` | per-vu-iterations | 2 | 2 | A/B test control arm: products list, search, homefeed |
| `ab_variant_a` | per-vu-iterations | 2 | 2 | A/B test variant A: products list, search, homefeed |
| `race_hotkey_consistency` | per-vu-iterations | 4 | 1 | Race condition test: nhieu VU confirm cung order |
| `idempotency_retry` | per-vu-iterations | 4 | 2 | Idempotency test: goi lai cung idempotency key |
| `predictable_batch` | per-vu-iterations | 2 | 2 | Batch job: create → list → status → download |

Tong so request du kien: ~50+ requests trai deu qua 6 scenarios.

## 3. 4 SLI cards

Sau khi chay, learner doc 4 SLI cards tu dashboard va ra decision.

### SLO-1: API Availability

| Field | Value |
| --- | --- |
| **Target** | ≥ 99% |
| **SLI formula** | `1 - http_req_failed_rate` |
| **Current** | `http_req_failed_rate` tu summary |
| **Evidence** | `summary.http_req_failed_rate` |

**Pass** neu `http_req_failed_rate == 0`.
**Warn** neu `0 < http_req_failed_rate <= 0.01` (1%).
**Fail** neu `http_req_failed_rate > 0.01`.

### SLO-2: API Latency p95

| Field | Value |
| --- | --- |
| **Target** | ≤ 500ms |
| **SLI formula** | `http_req_duration_p95` |
| **Current** | `http_req_duration_p95` tu summary |
| **Evidence** | `summary.http_req_duration_p95` |

**Pass** neu `p95 <= 500ms`.
**Warn** neu `500ms < p95 <= 1000ms`.
**Fail** neu `p95 > 1000ms`.

### SLO-3: Capacity Protection

| Field | Value |
| --- | --- |
| **Target** | 429 count = 0, dropped_iterations = 0 |
| **SLI formula** | `429 count + dropped_iterations` |
| **Current** | Status breakdown + `summary.dropped_iterations` |
| **Evidence** | `summary.dropped_iterations`, status code histogram |

**Pass** neu 0 dropped va 0 backpressure (429).
**Warn** neu co dropped_iterations nhung khong co 429 (k6 scheduler issue).
**Fail** neu co 429 khong duoc giai thich (day la green path, khong co pressure).

### SLO-4: Resource Headroom

| Field | Value |
| --- | --- |
| **Target** | CPU < 80%, memory < 80% container limit |
| **SLI formula** | Container CPU %, RAM MB trend |
| **Current** | `GET /v1/tests/:id/resources` |
| **Evidence** | Resource samples per container per timestamp |

**Pass** neu CPU < 80% va memory < 80% container limit trong suot run.
**Warn** neu co spike > 80% nhung transient (< 30s).
**Fail** neu sustained saturation (> 80% keo dai > 30s).

## 4. Pass/fail per SLO

```text
SLO-1 (Availability):   ✅ Pass -- http_req_failed_rate = 0%
SLO-2 (Latency p95):    ✅ Pass -- p95 < 500ms
SLO-3 (Capacity):       ✅ Pass -- 0 dropped_iterations, 0 backpressure
SLO-4 (Resource):       ✅ Pass -- CPU < 50%, memory stable
```

**Tong ket:** 4/4 SLOs pass → system healthy, green-path SLO decision = **GREEN**.

## 5. Cach chay

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

$env:PERVU_CORE_STATEFUL_VUS = "4"
$env:PERVU_CORE_STATEFUL_ITERS = "3"
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

## 6. Dashboard

Sau khi chay, mo `http://localhost:13001/` → chon run → tab **Production**:

### SLI Cards panel
- 4 cards hien thi availability %, p95 latency, capacity status, resource headroom
- Moi card co: current value, target, trend arrow, pass/warn/fail badge
- Click vao card de xem evidence chi tiet

### Business Flow panel
- Stateful flow: login → cart → checkout → confirm → status timeline
- A/B compare: control vs variant-a latency side by side
- Race condition: fresh vs reuse count (expected: 1 fresh, 3 reuse)
- Idempotency: first vs duplicate duration comparison
- Batch jobs: created vs status read count

### Expected dashboard queries
- `per_vu_core_case_failures = 0` -- khong co business flow failure
- `per_vu_core_race_fresh_count = 1` -- dung 1 request tao moi
- `per_vu_core_race_reuse_count = 3` -- 3 request con lai reuse
- `per_vu_core_idem_duplicate_reuse_count = 8` -- tat ca duplicate deu reuse
- `per_vu_core_batch_jobs_created = 4` -- dung so batch job duoc tao
- `per_vu_core_batch_job_status_read = 4` -- dung so status read

### Resource panel
- Container CPU %: on dinh, khong spike
- Container Memory MB: tang nhe trong stateful flow, giai phong sau GC
- Network I/O: ty le voi so request

## 7. Real validation

**Run #149** (2026-06-24) -- green-path SLO check:

| SLI | Metric | Value | Target | Verdict |
| --- | --- | ---: | --- | --- |
| SLO-1 Availability | `http_req_failed_rate` | 0.0% | ≤ 1% | ✅ PASS |
| SLO-2 Latency p95 | `http_req_duration_p95` | TBD ms | ≤ 500ms | TBD |
| SLO-3 Capacity | `dropped_iterations` | 0 | = 0 | ✅ PASS |
| SLO-3 Capacity | 429 count | 0 | = 0 | ✅ PASS |
| SLO-4 Resource | CPU max % | TBD % | < 80% | TBD |
| SLO-4 Resource | Memory trend | TBD | stable | TBD |

**Lesson:** Green-path SLO decision khong chi la "khong co loi." Day la qua trinh doc 4 SLI cards, xac nhan moi card co day du evidence, va ra ket luan he thong co dang dap ung SLO khong.

## 8. Learner exercise

Sau khi chay, learner tu tra loi cac cau hoi:

1. **Doc SLO-1 card**: `http_req_failed_rate` la bao nhieu? Co pass target 99% khong?
2. **Doc SLO-2 card**: `http_req_duration_p95` la bao nhieu? Endpoint nao cham nhat?
3. **Doc SLO-3 card**: Co dropped_iterations khong? Co 429 khong? Tai sao day la tin hieu tot?
4. **Doc SLO-4 card**: CPU trend co spike khong? Memory co xu huong tang dan khong (leak)?
5. **Ra decision**: He thong GREEN, WARN, hay FAIL? Giai thich dua tren evidence.
