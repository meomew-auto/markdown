# CI Regression Gates Layer -- Run Guide

## Shared env

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
```

Không case nào cần `OPS_AUTH_TOKEN`. Tất cả case đều dùng `full-no-cdn` topology.

## Critical pattern: Baseline + Candidate (2 runs)

**Mỗi case cần chạy 2 lần** với RUN_ID khác nhau:

```text
Lần 1 -- Baseline:
  RUN_ID = "ci-xx-baseline" (hoặc "ci-xx-baseline-v2" nếu chạy lại)
  → Code: main branch (trước PR)
  → Kết quả lưu vào dashboard làm baseline reference

Lần 2 -- Candidate:
  RUN_ID = "ci-xx-candidate"
  → Code: feature branch (sau PR)
  → Dashboard so sánh candidate vs baseline → pass/warn/fail
```

**Nguyên tắc quan trọng:** Tất cả env vars KHÁC (ngoài RUN_ID) phải GIỐNG HỆT nhau giữa baseline và candidate. Nếu thay đổi `db_rows`, `rate`, `VUs`... giữa 2 lần chạy, đó không còn là regression test.

## ci-01 -- Green-path API regression

### Baseline

```powershell
$env:BASE_URL = "http://localhost:80"
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

### Candidate

```powershell
# GIỐNG HỆT baseline, chỉ đổi RUN_ID
$env:BASE_URL = "http://localhost:80"
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

Expected: `per_vu_business_core_failures = 0`, checks = 100%, http_req_failed = 0%.

After both runs: Mở Dashboard Production tab → chọn baseline run + candidate run → xem gate results per metric.

## ci-02 -- DB read/write regression gate

### Baseline

```powershell
$env:BASE_URL = "http://localhost:80"
$env:CAPACITY_RUN_ID = "ci-db-baseline"
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "4"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_DB_ROWS = "80"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"
$env:CAPACITY_MAX_VUS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

### Candidate

```powershell
# GIỐNG HỆT baseline, chỉ đổi RUN_ID
$env:BASE_URL = "http://localhost:80"
$env:CAPACITY_RUN_ID = "ci-db-candidate"
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "4"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_DB_ROWS = "80"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"
$env:CAPACITY_MAX_VUS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

Expected: `capacity_sizing_failures = 0`, `capacity_breakdown_db_ms` ổn định, `dropped_iterations = 0`.

**Note:** Nếu candidate cố ý thay đổi `CAPACITY_DB_ROWS` hoặc `CAPACITY_RATE`, đây là capacity exploration, không phải regression gate. Gate chỉ có ý nghĩa khi env vars giữ nguyên.

## ci-03 -- Protected capacity regression gate

### Baseline

```powershell
$env:BASE_URL = "http://localhost:80"
$env:NONK8S_RUN_ID = "ci-pressure-baseline"
$env:NONK8S_MODE = "cpu_throttle"
$env:NONK8S_VUS = "4"
$env:NONK8S_DURATION_SECONDS = "16"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/29-nonk8s-prod-approx.js
```

### Candidate

```powershell
# GIỐNG HỆT baseline, chỉ đổi RUN_ID
$env:BASE_URL = "http://localhost:80"
$env:NONK8S_RUN_ID = "ci-pressure-candidate"
$env:NONK8S_MODE = "cpu_throttle"
$env:NONK8S_VUS = "4"
$env:NONK8S_DURATION_SECONDS = "16"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/29-nonk8s-prod-approx.js
```

Expected: `nonk8s_prod_approx_tolerated_errors > 0` (429 visible), unexpected 5xx = 0, success_200 không collapse.

## How to view gate results

Sau khi chạy baseline + candidate, mở `http://localhost:13001/`:

1. Vào **Production** tab (hoặc tab CI Regression Gate nếu có)
2. Chọn **baseline run** từ dropdown (vd: "ci-01-baseline")
3. Chọn **candidate run** từ dropdown (vd: "ci-01-candidate")
4. Dashboard hiển thị:
   - Bảng gate results: từng metric với pass/warn/fail + threshold
   - Summary diff: latency, error rate, throughput delta
   - Resource diff: CPU/memory comparison
   - Request breakdown diff: per-operation latency comparison
5. **overallStatus**: pass / warn / fail ở đầu trang

## Export compare artifact

Compare artifact có thể export dưới dạng JSON:

```json
{
  "schema": "k6-dashboard-ci-regression-gate/v1",
  "baselineRunId": "ci-01-baseline",
  "candidateRunId": "ci-01-candidate",
  "caseId": "ci-01-green-path-regression",
  "gateResults": { ... },
  "overallStatus": "pass"
}
```

Artifact này được CI agent đọc để quyết định block merge hay không.

## Validation snapshot (2026-06-26)

| Case | Baseline Run | Candidate Run | Gate Result |
| --- | ---: | ---: | --- |
| ci-01 Green path | #150 | #151 | pass |
| ci-02 DB path | (pending) | (pending) | (pending) |
| ci-03 Protected capacity | (pending) | (pending) | (pending) |
