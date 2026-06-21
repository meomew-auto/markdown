# Case 07: Production ingress mix

## Tình huống thực tế

Production không chỉ có một endpoint. Một baseline thực tế thường gồm browse, product detail,
cart write, auth validation, checkout và report traffic trộn với nhau.

Câu hỏi business:

```text
Hệ thống tổng thể có chịu được 18 mixed arrivals/s trong 60s không?
```

Đây là case tổng hợp trước khi chuyển sang `ramping-arrival-rate` để mô phỏng campaign/surge.

## Vì sao chọn `constant-arrival-rate`?

Production ingress mix là open-model baseline:

```text
- arrival rate từ bên ngoài cố định trong window test
- branch mix đại diện traffic thật
- backend chậm không được làm arrival stream tự giảm
- VU pool phải đủ hấp thụ tail latency của nhiều service
```

Case này cho phép `maxDroppedIterations = 5` để dạy cách đọc drop budget nhỏ trong mixed baseline.
Không có nghĩa là drop luôn acceptable trong production; đó là ngưỡng lab/contract của case.

## Mapping business -> k6 config

Source script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-07-production-ingress-mix.js
```

Default config:

| Field | Value | Ý nghĩa |
| --- | ---: | --- |
| `rate` | `18` | 18 mixed arrivals mỗi giây |
| `timeUnit` | `1s` | target = 18 arrivals/s |
| `duration` | `60s` | baseline dài hơn các case khác |
| `preAllocatedVUs` | `25` | worker chuẩn bị sẵn cho mixed latency |
| `maxVUs` | `80` | trần worker rộng hơn |
| `maxDroppedIterations` | `5` | drop budget nhỏ cho mixed baseline |

Expected scheduled slots:

```text
scheduled_slots = 18 × 60 = 1080 arrivals
```

Env override:

```powershell
$env:CAR_07_RATE = "18"
$env:CAR_07_TIME_UNIT = "1s"
$env:CAR_07_DURATION = "60s"
$env:CAR_07_PREALLOCATED_VUS = "25"
$env:CAR_07_MAX_VUS = "80"
$env:CAR_07_MAX_DROPPED = "5"
```

## Endpoint flow

Weighted branches:

| Branch | Weight | Endpoint | Service |
| --- | ---: | --- | --- |
| `product_list` | 30% | `GET /api/sim/products` | products-service |
| `product_detail` | 25% | `GET /api/sim/products/:id` | products-service |
| `cart_add` | 15% | `POST /api/sim/cart/add` | cart-service |
| `auth_me` | 10% | `GET /api/sim/auth/me` | auth-service |
| `report` | 10% | `GET /api/sim/report` | report-service |
| `checkout` | 10% | `POST /api/sim/checkout` | order-service |

Mỗi arrival event gọi đúng 1 API call trong mixed branch:

```text
iterations ≈ 1080 - dropped_iterations
constant_arrival_events_total ≈ iterations
constant_arrival_api_calls_total ≈ http_reqs ≈ iterations
dropped_iterations <= 5
```

## Code walkthrough

Scenario:

```js
production_ingress_mix: buildArrivalScenario(
  'productionIngressMix',
  RATE,
  TIME_UNIT,
  DURATION,
  PREALLOCATED_VUS,
  MAX_VUS,
  { case_id: CASE_ID, business_case: 'production_fixed_ingress_mix' },
)
```

Thresholds rộng hơn case đơn service:

```text
checks > 0.98
http_req_failed < 0.02
dropped_iterations <= 5
constant_arrival_events_failed < 20
```

Lý do: mixed baseline dùng nhiều service, nên ngưỡng lab cho phép một lượng nhỏ signal để dạy
cách drilldown theo tag. Khi áp vào production thật, team có thể đặt ngưỡng chặt hơn.

## Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-07-production-ingress-mix.js"
```

## Pass criteria

| Check | Pass khi |
| --- | --- |
| `dropped_iterations` | `count <= 5` |
| `checks` | `rate > 0.98` |
| `http_req_failed` | `rate < 0.02` |
| `constant_arrival_events_failed` | `count < 20` |
| `iterations` | gần `1080 - dropped_iterations` |
| `constant_arrival_events_total` | gần `iterations` |
| `constant_arrival_api_calls_total` | gần `http_reqs`, expected gần `iterations` |

## Phân tích output theo 5 bước

### Bước 1: Header/config

```text
executor = constant-arrival-rate
rate = 18
timeUnit = 1s
duration = 60s
preAllocatedVUs = 25
maxVUs = 80
```

### Bước 2: Expected slots

```text
18/s × 60s = 1080 slots
```

### Bước 3: Summary count

Healthy/budgeted run:

```text
iterations ~= 1080 - dropped_iterations
dropped_iterations <= 5
http_reqs ~= iterations
```

### Bước 4: Service breakdown

Nếu fail/drop/latency xuất hiện, drill theo:

```text
products-service
cart-service
auth-service
order-service
report-service
```

và `operation`:

```text
production_arrival_product_list
production_arrival_product_detail
production_arrival_cart_add
production_arrival_auth_me
production_arrival_checkout
production_arrival_report
```

### Bước 5: Business conclusion

| Output | Kết luận |
| --- | --- |
| 0-5 drops, checks/http fail trong ngưỡng | Mixed ingress baseline đạt contract lab |
| Drops tăng nhưng dưới 5 | Đạt threshold nhưng cần đọc VU/latency để quyết định risk |
| Drops > 5 | Contract hụt; đọc service/operation nào kéo event duration lên |
| Fail tập trung một service | Service đó là bottleneck/bug, không kết luận toàn hệ thống đồng đều |

## Đọc dashboard real-time charts cho case 07

### Response time

Không đọc p95 tổng một mình. Mixed traffic có nhiều service khác nhau nên cần drill theo tag:

```text
service
operation
endpoint
```

Checkout/report có thể kéo p95 tổng cao dù products/auth vẫn ổn.

### Execution timeline

Kỳ vọng:

```text
iterations/bucket gần 18/s
http_reqs/bucket gần 18/s
dropped_iterations <= budget
```

Nếu có bucket hụt, xem cùng VUs và operation latency trong bucket đó.

### VUs vs iter/s

Mixed baseline có VU pressure biến thiên theo branch mix từng bucket. Nếu bucket nào nhiều
checkout/report hơn, active VUs có thể tăng. Đây là behavior hợp lý nếu iter/s vẫn giữ target
và drop trong budget.

### Executor tab

Checklist:

```text
executor = constant-arrival-rate
rate/timeUnit/duration = 18/1s/60s
preAllocatedVUs=25, maxVUs=80
dropped_iterations <= 5 và khớp summary
```

## Kết quả validation 2026-06-21

Full run với default config:

```text
Run id: 95
Target slots: 1080
Iterations: 1081
HTTP requests: 1081
Dropped iterations: 0
Checks: 100%
HTTP failed: 0%
constant_arrival_events_failed: 0
constant_arrival_event_duration_ms p95: 1617 ms
Active VU max observed: 11
Result: PASS
```

Mixed baseline đạt ingress contract với zero drops. p95 tổng cao hơn read-only cases vì checkout/report branches chậm hơn; cần drill theo `service`/`operation` nếu tối ưu. Chart analysis chi tiết nằm ở `08_validation-and-chart-analysis.md`.

## Anti-patterns

```text
Sai: "Case 07 pass nên mọi service đều pass."
Đúng: Mixed tổng pass nhưng vẫn phải drill service/operation để tìm bottleneck ẩn.

Sai: "5 drops luôn chấp nhận được trong production."
Đúng: 5 là budget của lab case; production SLO có thể yêu cầu 0.

Sai: "p95 tổng cao nghĩa là toàn hệ thống chậm."
Đúng: p95 tổng có thể bị checkout/report kéo lên; đọc theo tag.
```
