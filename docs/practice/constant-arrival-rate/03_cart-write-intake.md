# Case 03: Cart write intake

## Tình huống thực tế

Cart service nhận các write events từ client: add item, update quantity, đọc summary sau khi thay đổi.
Ở production, các event này đến theo nhịp từ web/mobile clients; backend chậm không làm
clients tự biến mất ngay.

Câu hỏi business:

```text
Cart service có hấp thụ được 12 cart-write arrivals/s trong 45s không?
```

## Vì sao chọn `constant-arrival-rate`?

Cart write intake là bài toán **arrival stream**, không phải bài toán “N user active”.
Nếu dùng `constant-vus`, khi DB write chậm, vòng lặp VU chậm lại và write intake tự giảm,
làm che mất overload.

`constant-arrival-rate` giữ nhịp:

```text
12 arrival slots mỗi giây
```

Nếu cart service chậm khiến event giữ VU lâu hơn, active VUs tăng. Nếu pool không đủ,
`dropped_iterations` cho biết hệ thống không còn giữ được intake contract.

## Mapping business -> k6 config

Source script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js
```

Default config:

| Field | Value | Ý nghĩa |
| --- | ---: | --- |
| `rate` | `12` | 12 cart arrivals mỗi giây |
| `timeUnit` | `1s` | target = 12 arrivals/s |
| `duration` | `45s` | giữ intake trong 45 giây |
| `preAllocatedVUs` | `10` | worker chuẩn bị sẵn |
| `maxVUs` | `30` | trần worker được mở thêm |
| `maxDroppedIterations` | `0` | không chấp nhận drop trong contract case |

Expected scheduled slots:

```text
scheduled_slots = 12 × 45 = 540 arrivals
```

Env override:

```powershell
$env:CAR_03_RATE = "12"
$env:CAR_03_TIME_UNIT = "1s"
$env:CAR_03_DURATION = "45s"
$env:CAR_03_PREALLOCATED_VUS = "10"
$env:CAR_03_MAX_VUS = "30"
$env:CAR_03_MAX_DROPPED = "0"
```

## Endpoint flow

Weighted branches:

| Branch | Weight | Endpoint | Ý nghĩa |
| --- | ---: | --- | --- |
| `add` | 55% | `POST /api/sim/cart/add` | write chính |
| `update` | 30% | `PATCH /api/sim/cart/items/:item_id` | thay đổi quantity |
| `summary` | 15% | `GET /api/sim/cart/summary` | đọc summary sau write |

Mỗi arrival event gọi đúng 1 API call:

```text
iterations ≈ 540
constant_arrival_events_total ≈ 540
constant_arrival_api_calls_total ≈ 540
http_reqs ≈ 540
dropped_iterations = 0
```

## Code walkthrough

Scenario:

```js
cart_write_intake: buildArrivalScenario(
  'cartWriteIntake',
  RATE,
  TIME_UNIT,
  DURATION,
  PREALLOCATED_VUS,
  MAX_VUS,
  { case_id: CASE_ID, business_case: 'cart_write_fixed_intake' },
)
```

Các call gắn tag:

```text
service = cart-service
operation = cart_arrival_add | cart_arrival_update | cart_arrival_summary
endpoint = POST/PATCH/GET /api/sim/cart/...
```

Điểm dạy chính: write events thường giữ backend resources lâu hơn read-only browse.
Vì vậy phải đọc cả `constant_arrival_event_duration_ms`, VU pressure và `dropped_iterations`.

## Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js"
```

## Pass criteria

| Check | Pass khi |
| --- | --- |
| `dropped_iterations` | `count <= 0` |
| `checks` | `rate > 0.99` |
| `http_req_failed` | `rate < 0.01` |
| `constant_arrival_events_failed` | `count < 10` |
| `iterations` | gần `540` nếu không drop/interrupt |
| `constant_arrival_events_total` | gần `iterations` |
| `constant_arrival_api_calls_total` | gần `http_reqs`, expected khoảng `540` |

## Phân tích output theo 5 bước

### Bước 1: Header/config

```text
executor = constant-arrival-rate
rate = 12
timeUnit = 1s
duration = 45s
preAllocatedVUs = 10
maxVUs = 30
```

### Bước 2: Expected slots

```text
12/s × 45s = 540 slots
```

### Bước 3: Summary count

Healthy run:

```text
iterations ~= 540
dropped_iterations = 0
http_reqs ~= 540
```

### Bước 4: Write failure breakdown

Đọc tags:

```text
cart_arrival_add      -> add-item write path
cart_arrival_update   -> update quantity path
cart_arrival_summary  -> read summary path
```

Nếu fail tập trung ở `add`/`update`, đây là write-path issue. Nếu chỉ `summary` chậm,
read-after-write/reporting path có vấn đề riêng.

### Bước 5: Business conclusion

| Output | Kết luận |
| --- | --- |
| 540 iterations, 0 drop, failed 0 | Cart service hấp thụ được 12 arrivals/s |
| 0 drop nhưng VUs tăng nhiều | Write path chậm hơn, còn headroom nhưng cần theo dõi |
| drop > 0 | Intake contract hụt; đọc VU pool và DB/write latency |
| failed events > 0 | Cart endpoint bug hoặc status mismatch; drill theo operation |

## Đọc dashboard real-time charts cho case 03

### Response time

Write endpoints có thể tạo p95 cao hơn read-only. Đọc theo `operation` để phân biệt:

```text
cart_arrival_add/update chậm -> DB write pressure
cart_arrival_summary chậm -> read aggregation/cache issue
```

### Execution timeline

Kỳ vọng:

```text
iterations/bucket gần 12/s
http_reqs/bucket gần 12/s
dropped_iterations = 0
```

Nếu thấy bucket hụt nhưng summary không có drop, kiểm tra bucket aggregation/downsample trước.

### VUs vs iter/s

Cart write latency tăng sẽ làm active VUs tăng. Đây không phải tăng user thật; đó là
k6 cần nhiều worker hơn để giữ cùng 12 arrivals/s.

### Executor tab

Checklist:

```text
executor = constant-arrival-rate
rate/timeUnit/duration = 12/1s/45s
preAllocatedVUs=10, maxVUs=30
dropped_iterations khớp summary
```

## Kết quả validation 2026-06-21

Full run với default config:

```text
Run id: 91
Target slots: 540
Iterations: 541
HTTP requests: 541
Dropped iterations: 0
Checks: 100%
HTTP failed: 0%
constant_arrival_events_failed: 0
constant_arrival_event_duration_ms p95: 6 ms
Result: PASS
```

`iterations` cao hơn target slots 1 đơn vị do boundary scheduling; không có drop/interrupt nên contract vẫn pass. Chart analysis chi tiết nằm ở `08_validation-and-chart-analysis.md`.

## Anti-patterns

```text
Sai: "Cart write chậm nên RPS giảm là bình thường."
Đúng: với open model, RPS target vẫn phải giữ; nếu không giữ được thì dropped_iterations tăng.

Sai: "http_reqs = 540 nên mọi cart operation đều chạy 540 lần."
Đúng: 540 là tổng; branch add/update/summary chia theo weight.

Sai: "VUs tăng nghĩa là nhiều user hơn."
Đúng: VUs tăng nghĩa là event giữ worker lâu hơn hoặc pool cần thêm capacity.
```
