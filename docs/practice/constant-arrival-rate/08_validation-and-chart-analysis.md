# Full validation + chart analysis — `constant-arrival-rate`

Ngày chạy: 2026-06-21

Mục tiêu file này: ghi lại kết quả chạy thật 7 case `car-01` → `car-07`, reconcile với
summary/dashboard, và chỉ ra các điểm cần đọc khi phân tích chart.

## Môi trường validate

Preflight đã pass:

| Check | Result |
| --- | --- |
| `k6 version` | `k6.exe v2.0.0` |
| Metrics API | `http://localhost:18080/v1/capabilities` HTTP 200 |
| Token | `GET /v1/me` với `student-token-1234567890` HTTP 200 |
| Load-target | `http://localhost:80/health` HTTP 200 |

Source pack:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate
```

## Static validation

`k6 inspect` pass cho toàn bộ 7 scripts:

| Case | Script | Inspect |
| --- | --- | --- |
| car-01 | `car-01-storefront-rps-contract.js` | OK |
| car-02 | `car-02-auth-token-validation-rps.js` | OK |
| car-03 | `car-03-cart-write-intake.js` | OK |
| car-04 | `car-04-checkout-order-intake.js` | OK |
| car-05 | `car-05-report-api-ingress.js` | OK |
| car-06 | `car-06-cacheable-feed-ingress.js` | OK |
| car-07 | `car-07-production-ingress-mix.js` | OK |

Tất cả inspect output đều thấy:

```text
executor = constant-arrival-rate
executor_family = constant_arrival_rate
workload_shape = fixed_ingress_rate
```

## Full-run summary

Chạy bằng `run-with-summary.ps1` equivalent flow:

```text
k6 run -o cloud --summary-export ... --summary-trend-stats avg,min,med,max,p(90),p(95),p(99) <script>
POST /v1/tests/:id/summary-final
POST /v1/tests/:id
```

| Case | Run id | Target slots | Iterations | Dropped | HTTP reqs | Checks | HTTP failed | Event failed | Event p95 | Active VU max | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| car-01 storefront | 89 | 900 | 900 | 0 | 900 | 100% | 0% | 0 | 4 ms | sampled 0 | PASS |
| car-02 auth | 90 | 675 | 676 | 0 | 676 | 100% | 0% | 0 | 23 ms | sampled 0 | PASS |
| car-03 cart | 91 | 540 | 541 | 0 | 541 | 100% | 0% | 0 | 6 ms | sampled 0 | PASS |
| car-04 checkout | 92 | 225 | 226 | 0 | 452 | 100% | 0% | 0 | 115 ms | sampled 0 | PASS |
| car-05 report | 93 | 270 | 249 | 22 | 309 | 100% | 0% | 0 | 7950.6 ms | 41 | FAIL: dropped threshold |
| car-06 feed | 94 | 1080 | 1081 | 0 | 1081 | 100% | 0% | 0 | 4 ms | sampled 0 | PASS |
| car-07 mixed | 95 | 1080 | 1081 | 0 | 1081 | 100% | 0% | 0 | 1617 ms | 11 | PASS |

Important observations:

```text
- 6/7 default full runs passed their thresholds.
- car-05 failed exactly for the reason this executor is meant to expose:
  dropped_iterations = 22 > maxDroppedIterations = 0.
- Several successful cases finished target_slots + 1 iteration. Treat scheduled slots as
  approximate at exact duration boundaries; validate with dropped/interrupted and thresholds,
  not with brittle exact equality.
```

## car-05 rerun with larger VU pool

To check whether the failure was only low `preAllocatedVUs/maxVUs`, reran car-05 with:

```powershell
$env:CAR_05_PREALLOCATED_VUS = "60"
$env:CAR_05_MAX_VUS = "100"
```

Result:

| Run id | Iterations | Dropped | HTTP reqs | Event p95 | Active VU max | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 96 | 265 | 6 | 325 | 12785 ms | 64 | FAIL: still dropped |

Interpretation:

```text
Increasing VU pool reduced drops from 22 -> 6, but did not reach zero.
Event duration also became very high (p95 ~12.8s), so this is not a simple "just add a few VUs"
case. The report/async flow or backend state needs investigation before claiming the full
6 arrivals/s contract is healthy.
```

For teaching, this is valuable: `checks=100%` and `http_req_failed=0%` are not enough.
The open-model contract still failed because k6 could not start all scheduled arrivals.

## Per-case interpretation

### car-01 — Storefront RPS contract

```text
Target: 20/s × 45s = 900 slots
Observed: 900 iterations, 900 HTTP requests, 0 dropped
```

Chart read:

```text
- Execution timeline iterations sum reconciled to 900.
- Response/event p95 was 4 ms: read path very fast.
- Active VU samples were 0 at 1s chart granularity because events finished between samples.
  This does not mean no VU executed; the progress output still shows the configured VU envelope.
```

Conclusion: storefront read ingress met the 20/s contract.

### car-02 — Auth token validation RPS

```text
Target: 15/s × 45s = 675 slots
Observed: 676 iterations, 676 HTTP requests, 0 dropped
```

Chart read:

```text
- Execution timeline reconciled to 676 completed iterations.
- Event p95 was 23 ms, higher than car-01 but still small.
- No drop, no failed events.
```

Conclusion: auth validation stream met the 15/s contract in this run.

### car-03 — Cart write intake

```text
Target: 12/s × 45s = 540 slots
Observed: 541 iterations, 541 HTTP requests, 0 dropped
```

Chart read:

```text
- Execution timeline reconciled to 541 iterations.
- Event p95 was 6 ms, max 162 ms: one outlier but no broad tail.
- Because each event has one API call, `http_reqs` and `iterations` should move together.
```

Conclusion: cart write intake met the 12/s contract.

### car-04 — Checkout order intake

```text
Target: 5/s × 45s = 225 slots
Observed: 226 iterations, 452 HTTP requests, 0 dropped
```

Chart read:

```text
- `http_reqs = iterations × 2`, matching checkout create + confirm.
- Event p95 was 115 ms, much higher than simple read cases because external latency is simulated.
- No drop: latency consumed more time but VU pool had enough headroom.
```

Conclusion: checkout/order intake met the 5/s contract; UX latency still needs separate SLO review.

### car-05 — Report API ingress

```text
Target: 6/s × 45s = 270 slots
Observed: 249 iterations, 22 dropped, 309 HTTP requests
Threshold: dropped_iterations <= 0
```

Chart read:

```text
- Execution timeline reconciled to 249 completed iterations.
- dropped_iterations series summed to 22.
- Active VUs rose to 41 and configured/initialized VU series reached 42.
- Event p95 was ~7.95s; event duration held workers long enough to miss arrivals.
```

Conclusion: full default car-05 did **not** meet the 6/s ingress contract in this environment.
Do not mark the report API contract healthy just because checks and HTTP failure rate were clean.

### car-06 — Cacheable feed ingress

```text
Target: 24/s × 45s = 1080 slots
Observed: 1081 iterations, 1081 HTTP requests, 0 dropped
```

Chart read:

```text
- High arrival rate but very short event p95 (4 ms).
- This demonstrates Little's-Law sizing: high rate can still need few active workers if event duration is tiny.
- No drop and no failed events.
```

Conclusion: feed/recommendation read ingress met the 24/s contract.

### car-07 — Production ingress mix

```text
Target: 18/s × 60s = 1080 slots
Observed: 1081 iterations, 1081 HTTP requests, 0 dropped
Allowed drop budget: <= 5
```

Chart read:

```text
- Mixed run passed with zero drops.
- Active VU max reached 11; configured/preallocated VU series showed 25.
- Event p95 was 1617 ms because some branches (checkout/report) are much slower than simple reads.
```

Conclusion: mixed production ingress met the 18/s baseline in this run, but p95 should be drilled down
by `service`/`operation` before deciding which service owns the tail.

## Dashboard UI check tại `http://localhost:13001`

Sau khi user nhắc kiểm tra trực tiếp trên UI, đã mở dashboard bằng Chrome headless và capture
Overview + Executor tab cho các run CAR:

```text
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-01-storefront-run89-overview.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-01-storefront-run89-executor.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-02-auth-run90-overview.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-02-auth-run90-executor.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-03-cart-run91-overview.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-03-cart-run91-executor.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-04-checkout-run92-overview.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-04-checkout-run92-executor.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-05-report-fail-run93-overview.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-05-report-fail-run93-executor.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-06-feed-run94-overview.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-06-feed-run94-executor.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-07-mix-run95-overview.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-07-mix-run95-executor.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-05-report-capacity-rerun-run96-overview.png
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\car-05-report-capacity-rerun-run96-executor.png
```

Capture report:

```text
E:\Khoa hoc\k6\.claude-car-dashboard-screenshots\dashboard-capture-report.json
```

### Overview tab

Overview tab render đủ các khu vực cần phân tích giống các executor pack trước:

```text
- KPI tiles: Requests, Failures, Observed RPS, Avg response
- Active VUs / HTTP failed rate
- Execution summary block
- Requests & sleep aggregate debug
- Response time chart
- Execution timeline chart
- VUs vs iter/s chart
- Run catalog
```

Các số hiển thị trên UI khớp với summary-final cho các KPI chính:

| Run | UI Requests | UI Observed RPS | UI Avg response / p95 | Nhận xét |
| --- | ---: | ---: | --- | --- |
| 89 car-01 | 900 | 19.999/s | avg 2.99 ms, p95 3.8 ms | storefront pass, chart đủ |
| 90 car-02 | 676 | 15.021/s | avg 4.57 ms, p95 22.82 ms | auth pass, chart đủ |
| 91 car-03 | 541 | 12.021/s | avg 4.21 ms, p95 5.55 ms | cart pass, chart đủ |
| 92 car-04 | 452 reqs | 10.022 req/s | avg 49.32 ms, p95 71.24 ms | đúng vì 1 iteration = 2 reqs |
| 93 car-05 | 309 reqs | 6.324 req/s | avg 3.1 s, p95 7.83 s | fail do drop; chart thể hiện latency/VU pressure |
| 94 car-06 | 1081 | 24.020/s | avg 3.16 ms, p95 4.15 ms | feed pass, chart đủ |
| 95 car-07 | 1081 | 17.956/s | avg 148.25 ms, p95 1.61 s | mixed pass, tail do branch chậm |
| 96 car-05 rerun | 325 reqs | 6.102 req/s | avg 6.12 s, p95 12.65 s | tăng VU vẫn còn drop |

### Executor tab issue found

Có một vấn đề UI/FE rõ ràng: Executor tab auto-detect sai với các CAR run **không có drop**.

Observed trên capture:

| Run | Expected | UI Executor tab observed |
| --- | --- | --- |
| 89/90/91/92/94/95 | `constant-arrival-rate`, open-model | `per-vu-iterations`, `closed-model`, source `fallback` |
| 93/96 | `constant-arrival-rate`, open-model | family `open-model` vì summary có `dropped_iterations > 0`, nhưng Executor label vẫn fallback `per-vu-iterations` |

Nguyên nhân khả dĩ từ FE logic:

```text
- inferExecutorFromName() chưa nhận diện file prefix car-01/car-02/... là constant-arrival-rate.
- detectFamilyFromSummary() chỉ auto-open khi dropped_iterations > 0 hoặc metric open-model riêng có value > 0.
- Với happy-path CAR drop = 0, summary không đủ signal để UI tự chuyển sang open-model.
```

Impact:

```text
- Overview charts vẫn phân tích được và KPI summary đúng.
- Executor tab/lens có thể dạy sai mental model cho các CAR run pass vì hiển thị closed-model.
```

Fix nên làm ở FE/dashboard, không phải BE core:

```text
1. Nhận diện tên script `car-` hoặc `constant-arrival-rate` pack path là `constant-arrival-rate`.
2. Hoặc backend lưu executor metadata khi ingest k6 scenario options để FE không phải đoán theo filename.
3. detectFamilyFromSummary nên coi presence của `dropped_iterations` metric / constant_arrival_* metrics là open-model signal,
   không chỉ khi dropped_iterations > 0.
```

## Chart reconciliation notes

### What reconciled cleanly

For all runs, `iterations` chart series reconciled to summary `iterations`:

| Case | Summary iterations | Chart `iterations` sum |
| --- | ---: | ---: |
| car-01 | 900 | 900 |
| car-02 | 676 | 676 |
| car-03 | 541 | 541 |
| car-04 | 226 | 226 |
| car-05 | 249 | 249 |
| car-06 | 1081 | 1081 |
| car-07 | 1081 | 1081 |

For car-05, `dropped_iterations` chart series also reconciled:

```text
summary dropped_iterations = 22
chart dropped_iterations sum = 22
```

### Counter-series caveat

The raw `series?metric=http_reqs` endpoint returned all points for lower-count runs but showed
only 500 points for high-count runs such as car-01/car-06/car-07. Therefore:

```text
Use summary-final as the authoritative total for high-cardinality counters.
Do not treat returned point count as total request count.
Do not sum pointCount.
```

This is the same lesson as the earlier executor packs:

```text
pointCount != business count
metrics_push_count != business count
summary-final = final truth
```

## `vus` / `vus_max` interpretation

The dashboard/server summary exposes several VU-looking numbers. Read them carefully:

```text
active VUs chart = VUs sampled at bucket time
vus_max summary fields = k6/server VU envelope samples, often close to preAllocated/initialized VUs
scenario config maxVUs = script config upper bound
```

Examples from this validation:

| Case | Config pre/max | Active VU max observed | `vus_max_max` in summary | Meaning |
| --- | ---: | ---: | ---: | --- |
| car-01 | 12 / 30 | sampled 0 | 12 | events too short; active sample missed busy VUs |
| car-05 | 20 / 50 | 41 | 42 | k6 expanded VU pool under report latency |
| car-07 | 25 / 80 | 11 | 25 | mixed run used headroom but did not need maxVUs |

Do not write “`vus_max` equals configured `maxVUs`” unless the specific UI field says that.
For teaching, always pair the number with its source: scenario config, active VU chart, or summary field.

## Final validation conclusion

```text
- Static inspect: 7/7 OK.
- Full default run: 6/7 pass, 1/7 fail.
- The failing case is car-05 because dropped_iterations exceeded its threshold.
- Chart/summary analysis confirms this is an open-model capacity/latency signal, not an HTTP status failure.
```

Actionable follow-up for car-05:

```text
1. Keep the doc as a teaching example of dropped_iterations under async/report latency, OR
2. Tune the pack defaults (lower rate, shorter ready/job latency, larger VU envelope), then rerun until full default passes, OR
3. Investigate report backend/job behavior because event p95 reached multi-second values.
```
