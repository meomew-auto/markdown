# Case 05: Report API ingress

## Tình huống thực tế

Backoffice/reporting APIs thường có 2 loại traffic:

```text
1. dashboard read: user mở report/dashboard
2. async job: user tạo job export/report rồi poll trạng thái
```

Traffic này đến theo ingress rate từ UI hoặc scheduler. Nếu report job chậm, arrival stream
không nên âm thầm giảm trong test.

Câu hỏi business:

```text
Report service có chịu được 6 report arrivals/s trong 45s không?
```

## Vì sao chọn `constant-arrival-rate`?

Report job có thể giữ VU lâu hơn vì external/job wait. Nếu dùng closed model, throughput
sẽ tự giảm khi job chậm. Với open model:

```text
- k6 vẫn cố start 6 arrivals/s
- event lâu hơn -> active VUs tăng
- thiếu VU -> dropped_iterations tăng
```

Đây là case tốt để dạy “async latency không phải cơ chế throttle hợp lệ”.

## Mapping business -> k6 config

Source script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js
```

Default config:

| Field | Value | Ý nghĩa |
| --- | ---: | --- |
| `rate` | `6` | 6 report arrivals mỗi giây |
| `timeUnit` | `1s` | target = 6 arrivals/s |
| `duration` | `45s` | giữ ingress trong 45 giây |
| `preAllocatedVUs` | `20` | nhiều worker vì có async/poll wait |
| `maxVUs` | `50` | trần worker được mở thêm |
| `readyAfterMs` | `20` | wait trước khi poll job status |
| `maxDroppedIterations` | `0` | không chấp nhận drop |

Expected scheduled slots:

```text
scheduled_slots = 6 × 45 = 270 arrivals
```

Env override:

```powershell
$env:CAR_05_RATE = "6"
$env:CAR_05_TIME_UNIT = "1s"
$env:CAR_05_DURATION = "45s"
$env:CAR_05_PREALLOCATED_VUS = "20"
$env:CAR_05_MAX_VUS = "50"
$env:CAR_05_READY_AFTER_MS = "20"
$env:CAR_05_MAX_DROPPED = "0"
```

## Endpoint flow

Weighted branches:

| Branch | Weight | Flow | Expected |
| --- | ---: | --- | --- |
| `dashboard` | 70% | `GET /api/sim/report` | `200` |
| `async_job` | 30% | `POST /api/sim/report/jobs` -> wait -> `GET /api/sim/report/jobs/:id` | `202`, `200` |

Expected API calls là weighted:

```text
70% events × 1 call + 30% events × 2 calls
≈ 1.3 calls/event
```

Với 270 scheduled slots, happy path rough expectation:

```text
iterations ≈ 270
constant_arrival_events_total ≈ 270
constant_arrival_api_calls_total ≈ 351
http_reqs ≈ 351
dropped_iterations = 0
```

Do branch chọn theo modulo weight, số thực tế thường rất gần tỷ lệ trên.

## Code walkthrough

Scenario:

```js
report_api_ingress: buildArrivalScenario(
  'reportApiIngress',
  RATE,
  TIME_UNIT,
  DURATION,
  PREALLOCATED_VUS,
  MAX_VUS,
  { case_id: CASE_ID, business_case: 'report_api_fixed_ingress_rate' },
)
```

Điểm đặc biệt:

```js
wait(READY_AFTER_MS / 1000)
```

Wait này giữ VU bận trong async-job branch. Vì vậy VU sizing phải tính cả event duration,
không chỉ HTTP request duration đơn lẻ.

## Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js"
```

Tăng async wait để thấy VU pressure:

```powershell
$env:CAR_05_READY_AFTER_MS = "200"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js"
Remove-Item Env:CAR_05_READY_AFTER_MS -ErrorAction SilentlyContinue
```

## Pass criteria

| Check | Pass khi |
| --- | --- |
| `dropped_iterations` | `count <= 0` |
| `checks` | `rate > 0.99` |
| `http_req_failed` | `rate < 0.01` |
| `constant_arrival_events_failed` | `count < 5` |
| `iterations` | gần `270` nếu không drop/interrupt |
| `constant_arrival_events_total` | gần `iterations` |
| `constant_arrival_api_calls_total` | expected khoảng `351` với default branch mix |

## Phân tích output theo 5 bước

### Bước 1: Header/config

```text
executor = constant-arrival-rate
rate = 6
timeUnit = 1s
duration = 45s
preAllocatedVUs = 20
maxVUs = 50
```

### Bước 2: Expected slots

```text
6/s × 45s = 270 slots
```

### Bước 3: Summary count

Healthy run:

```text
iterations ~= 270
dropped_iterations = 0
http_reqs ~= 351
```

### Bước 4: Branch reconciliation

```text
dashboard events -> 1 request
action_job events -> 2 requests if job id exists
```

Nếu `http_reqs` thấp hơn expected, kiểm tra job create status và `job_id`. Nếu event failed
tăng, drill tag `report_arrival_create_job` hoặc `report_arrival_job_status`.

### Bước 5: Business conclusion

| Output | Kết luận |
| --- | --- |
| 270 iterations, ~351 requests, 0 drop | Report service giữ được 6 arrivals/s |
| 0 drop nhưng VUs tăng | Async wait/job latency ăn headroom nhưng contract vẫn đạt |
| drop > 0 | Report job latency hoặc sizing làm hụt fixed ingress |
| job-status fail | Async workflow hỏng, không chỉ dashboard read hỏng |

## Đọc dashboard real-time charts cho case 05

### Response time

Nên drill theo operation:

```text
report_arrival_dashboard
report_arrival_create_job
report_arrival_job_status
```

Event duration có thể cao hơn từng HTTP duration vì async branch có wait giữa create và status.

### Execution timeline

Kỳ vọng:

```text
iterations/bucket gần 6/s
http_reqs/bucket khoảng 7.8/s trung bình vì 1.3 calls/event
dropped_iterations = 0
```

Nếu chart request rate dao động, kiểm tra tỷ lệ async branch theo bucket trước khi kết luận issue.

### VUs vs iter/s

Đây là chart quan trọng nhất cho case 05. Khi `READY_AFTER_MS` tăng, active VUs nên tăng
ngay cả khi target iter/s vẫn giữ 6/s.

### Executor tab

Checklist:

```text
executor = constant-arrival-rate
rate/timeUnit/duration = 6/1s/45s
preAllocatedVUs=20, maxVUs=50
dropped_iterations khớp summary
```

## Kết quả validation 2026-06-21

Full run với default config:

```text
Run id: 93
Target slots: 270
Iterations: 249
HTTP requests: 309
Dropped iterations: 22
Checks: 100%
HTTP failed: 0%
constant_arrival_events_failed: 0
constant_arrival_event_duration_ms p95: 7950.6 ms
Active VU max observed: 41
Result: FAIL — dropped_iterations vượt threshold 0
```

Rerun tăng VU pool (`CAR_05_PREALLOCATED_VUS=60`, `CAR_05_MAX_VUS=100`) vẫn còn drop:

```text
Run id: 96
Iterations: 265
Dropped iterations: 6
constant_arrival_event_duration_ms p95: 12785 ms
Result: FAIL — giảm drop nhưng chưa đạt contract
```

Đây là case dạy rất rõ: `checks=100%` và `http_req_failed=0%` không đủ để pass open-model contract. Chart analysis chi tiết nằm ở `08_validation-and-chart-analysis.md`.

## Anti-patterns

```text
Sai: "Async job chậm thì arrival rate giảm là bình thường."
Đúng: Trong open model, arrival vẫn phải start đúng nhịp; chậm làm tăng VU usage/drop.

Sai: "http_reqs phải bằng iterations."
Đúng: async_job branch có 2 requests, dashboard branch có 1 request.

Sai: "http_req_duration đủ để sizing VU."
Đúng: phải dùng event duration vì wait/poll cũng giữ VU.
```
