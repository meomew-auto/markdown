# Case 04: Checkout order intake

## Tình huống thực tế

Checkout/order traffic thường có rate thấp hơn browse/feed, nhưng mỗi event quan trọng hơn:
liên quan thanh toán, tạo order, confirm order và external dependency.

Câu hỏi business:

```text
Order service có xử lý ổn 5 checkout arrivals/s trong 45s không?
```

Đây là case dạy rằng **rate thấp không đồng nghĩa cần ít VU** nếu mỗi event giữ VU lâu
vì external latency.

## Vì sao chọn `constant-arrival-rate`?

Checkout arrivals đến từ người dùng thật hoặc campaign funnel. Khi payment/external dependency
chậm, production vẫn có thể tiếp tục nhận checkout attempts trong một khoảng thời gian.

`constant-arrival-rate` giúp mô phỏng:

```text
- external arrival rate cố định
- mỗi event có nhiều bước
- VU pool phải đủ giữ nhịp
- thiếu pool -> dropped_iterations
```

## Mapping business -> k6 config

Source script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-04-checkout-order-intake.js
```

Default config:

| Field | Value | Ý nghĩa |
| --- | ---: | --- |
| `rate` | `5` | 5 checkout arrivals mỗi giây |
| `timeUnit` | `1s` | target = 5 arrivals/s |
| `duration` | `45s` | giữ intake trong 45 giây |
| `preAllocatedVUs` | `15` | nhiều worker hơn vì event có external latency |
| `maxVUs` | `40` | trần worker được mở thêm |
| `maxDroppedIterations` | `0` | checkout contract không chấp nhận drop |

Expected scheduled slots:

```text
scheduled_slots = 5 × 45 = 225 arrivals
```

Env override:

```powershell
$env:CAR_04_RATE = "5"
$env:CAR_04_TIME_UNIT = "1s"
$env:CAR_04_DURATION = "45s"
$env:CAR_04_PREALLOCATED_VUS = "15"
$env:CAR_04_MAX_VUS = "40"
$env:CAR_04_MAX_DROPPED = "0"
```

## Endpoint flow

Mỗi arrival event chạy 2 bước bắt buộc:

| Step | Endpoint | Expected |
| --- | --- | --- |
| 1 | `POST /api/sim/checkout?cpu_ms=3&db_writes=2&external_ms=40` | `200` |
| 2 | `POST /api/sim/orders/:id/confirm?cpu_ms=1&db_writes=1&external_ms=20` | `200` |

Vì mỗi event gọi 2 API calls, happy path default:

```text
iterations ≈ 225
constant_arrival_events_total ≈ 225
constant_arrival_api_calls_total ≈ 450
http_reqs ≈ 450
dropped_iterations = 0
```

Nếu step 1 fail và không có order id, step 2 có thể không chạy; khi đó API calls thấp hơn
`iterations × 2` và `constant_arrival_events_failed` tăng.

## Code walkthrough

Scenario:

```js
checkout_order_intake: buildArrivalScenario(
  'checkoutOrderIntake',
  RATE,
  TIME_UNIT,
  DURATION,
  PREALLOCATED_VUS,
  MAX_VUS,
  { case_id: CASE_ID, business_case: 'checkout_order_fixed_intake' },
)
```

Script cố tình dùng external latency giả lập:

```text
checkout create: external_ms=40
order confirm:  external_ms=20
```

Đây là lý do `preAllocatedVUs=15` dù rate chỉ `5/s`.

## Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-04-checkout-order-intake.js"
```

## Pass criteria

| Check | Pass khi |
| --- | --- |
| `dropped_iterations` | `count <= 0` |
| `checks` | `rate > 0.99` |
| `http_req_failed` | `rate < 0.01` |
| `constant_arrival_events_failed` | `count < 5` |
| `iterations` | gần `225` nếu không drop/interrupt |
| `constant_arrival_events_total` | gần `iterations` |
| `constant_arrival_api_calls_total` | expected khoảng `450` nếu cả 2 bước đều chạy |

## Phân tích output theo 5 bước

### Bước 1: Header/config

```text
executor = constant-arrival-rate
rate = 5
timeUnit = 1s
duration = 45s
preAllocatedVUs = 15
maxVUs = 40
```

### Bước 2: Expected slots

```text
5/s × 45s = 225 slots
```

### Bước 3: Summary count

Healthy run:

```text
iterations ~= 225
dropped_iterations = 0
http_reqs ~= 450
```

### Bước 4: Multi-step reconciliation

```text
constant_arrival_events_total ~= iterations
constant_arrival_api_calls_total ~= http_reqs
http_reqs ~= iterations × 2
```

Nếu `http_reqs` thấp hơn nhiều so với `iterations × 2`, kiểm tra checkout create fail hoặc
logic không lấy được order id.

### Bước 5: Business conclusion

| Output | Kết luận |
| --- | --- |
| 225 iterations, 450 requests, 0 drop | Order service giữ được 5 checkout/s |
| 0 drop nhưng event duration cao | Contract đạt, nhưng checkout latency ảnh hưởng UX |
| VUs tăng mạnh nhưng không drop | External latency đang ăn headroom |
| drop > 0 | Low-rate contract vẫn hụt vì mỗi event giữ VU quá lâu hoặc sizing thiếu |

## Đọc dashboard real-time charts cho case 04

### Response time

Expect checkout/confirm latency cao hơn simple read. Đọc p95/p99 cùng `operation`:

```text
checkout_arrival_create  -> tạo checkout/order
checkout_arrival_confirm -> confirm order
```

Nếu p95 cao nhưng `dropped_iterations=0`, backend chậm nhưng k6 vẫn giữ intake.
Nếu p95 cao và drop tăng, contract đã bị hụt.

### Execution timeline

Kỳ vọng:

```text
iterations/bucket gần 5/s
http_reqs/bucket gần 10/s vì mỗi event 2 requests
dropped_iterations = 0
```

Đây là case tốt để dạy rằng `http_reqs/s` có thể khác `iterations/s`.

### VUs vs iter/s

Rate chỉ 5/s nhưng active VUs có thể cao hơn case đọc đơn giản vì mỗi event có external wait.
Đọc VUs như **capacity consumed by latency**, không phải user count.

### Executor tab

Checklist:

```text
executor = constant-arrival-rate
rate/timeUnit/duration = 5/1s/45s
preAllocatedVUs=15, maxVUs=40
dropped_iterations khớp summary
```

## Kết quả validation 2026-06-21

Full run với default config:

```text
Run id: 92
Target slots: 225
Iterations: 226
HTTP requests: 452
Dropped iterations: 0
Checks: 100%
HTTP failed: 0%
constant_arrival_events_failed: 0
constant_arrival_event_duration_ms p95: 115 ms
Result: PASS
```

`http_reqs = iterations × 2`, đúng flow checkout create + confirm. Chart analysis chi tiết nằm ở `08_validation-and-chart-analysis.md`.

## Anti-patterns

```text
Sai: "5/s thấp nên preAllocatedVUs=15 là quá nhiều."
Đúng: VU cần theo lambda × event duration, không chỉ theo rate.

Sai: "http_reqs phải bằng iterations."
Đúng: case này 1 iteration = 2 HTTP requests nếu cả flow chạy đủ.

Sai: "Không drop nên checkout ổn hoàn toàn."
Đúng: Không drop chỉ nói ingress đạt; vẫn phải đọc event duration/p95 để đánh giá UX.
```
