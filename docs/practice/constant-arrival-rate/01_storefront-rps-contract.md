# Case 01: Storefront RPS contract

## Tình huống thực tế

Storefront có traffic browse/list đến từ CDN, mobile app hoặc web client theo một **RPS contract** cố định.
Team không hỏi “có bao nhiêu user đang online?”, mà hỏi:

```text
Products service có chịu được 20 arrivals/s trong 45s không?
```

Nếu backend chậm, traffic bên ngoài vẫn đến. Vì vậy test phải giữ ingress rate, không để
throughput tự giảm theo latency.

## Vì sao chọn `constant-arrival-rate`?

`constant-vus` không phù hợp vì:

```text
backend chậm -> mỗi VU loop chậm hơn -> RPS tự giảm
```

Trong case này, RPS là input business contract:

```text
20 arrivals/s phải được start đều trong 45s
```

`constant-arrival-rate` phù hợp vì:

```text
- k6 schedule arrival slots theo rate/timeUnit
- VU chỉ là worker giữ nhịp
- nếu worker không đủ -> dropped_iterations chỉ ra contract bị hụt
```

## Mapping business -> k6 config

Source script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js
```

Default config:

| Field | Value | Ý nghĩa |
| --- | ---: | --- |
| `rate` | `20` | 20 arrival events mỗi `timeUnit` |
| `timeUnit` | `1s` | target = 20 arrivals/s |
| `duration` | `45s` | giữ contract trong 45 giây |
| `preAllocatedVUs` | `12` | worker chuẩn bị sẵn |
| `maxVUs` | `30` | trần worker được mở thêm |
| `maxDroppedIterations` | `0` | case contract: không chấp nhận drop |

Expected scheduled slots:

```text
scheduled_slots = 20 × 45 = 900 arrivals
```

Env override:

```powershell
$env:CAR_01_RATE = "20"
$env:CAR_01_TIME_UNIT = "1s"
$env:CAR_01_DURATION = "45s"
$env:CAR_01_PREALLOCATED_VUS = "12"
$env:CAR_01_MAX_VUS = "30"
$env:CAR_01_MAX_DROPPED = "0"
```

## Endpoint flow

Case 01 chọn deterministic weighted branch theo iteration number:

| Branch | Weight | Endpoint | Ý nghĩa |
| --- | ---: | --- | --- |
| `list` | 70% | `GET /api/sim/products?limit=10&sort=popular&view=grid` | browse/list phổ biến |
| `detail` | 30% | `GET /api/sim/products/:id?view=full` | mở product detail |

Mỗi arrival event gọi đúng 1 API call, nên happy path default là:

```text
iterations ≈ 900
constant_arrival_events_total ≈ 900
constant_arrival_api_calls_total ≈ 900
http_reqs ≈ 900
dropped_iterations = 0
```

## Code walkthrough

Scenario được khai báo qua helper chung:

```js
storefront_rps_contract: buildArrivalScenario(
  'storefrontRpsContract',
  RATE,
  TIME_UNIT,
  DURATION,
  PREALLOCATED_VUS,
  MAX_VUS,
  { case_id: CASE_ID, business_case: 'storefront_fixed_rps_contract' },
)
```

Điểm quan trọng:

```text
rate/timeUnit/duration = ingress input
preAllocatedVUs/maxVUs = scheduler capacity
```

Mỗi HTTP call đi qua `requestJson(...)`, helper này:

```text
- gắn tag case_id/service/operation/endpoint/user_id
- tăng constant_arrival_api_calls_total
- chạy check status code
```

Cuối event gọi `finishEvent(...)`, helper này:

```text
- tăng constant_arrival_events_total
- ghi constant_arrival_event_duration_ms
- nếu event fail -> tăng constant_arrival_events_failed
```

## Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js"
```

Smoke nhanh:

```powershell
$env:CAR_01_RATE = "5"
$env:CAR_01_DURATION = "5s"
$env:CAR_01_PREALLOCATED_VUS = "4"
$env:CAR_01_MAX_VUS = "8"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js"
Remove-Item Env:CAR_01_RATE, Env:CAR_01_DURATION, Env:CAR_01_PREALLOCATED_VUS, Env:CAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

## Pass criteria

| Check | Pass khi |
| --- | --- |
| `dropped_iterations` | `count <= 0` |
| `checks` | `rate > 0.99` |
| `http_req_failed` | `rate < 0.01` |
| `constant_arrival_events_failed` | `count < 10` |
| `iterations` | gần `900` nếu không drop/interrupt |
| `constant_arrival_events_total` | gần `iterations` |
| `constant_arrival_api_calls_total` | gần `http_reqs`, expected khoảng `900` |

Nếu `dropped_iterations > 0`, run không đạt RPS contract dù latency có thể vẫn đẹp.

## Phân tích output theo 5 bước

### Bước 1: Header/config

Xác nhận output đang chạy:

```text
executor = constant-arrival-rate
rate = 20
timeUnit = 1s
duration = 45s
preAllocatedVUs = 12
maxVUs = 30
```

### Bước 2: Expected slots

```text
20/s × 45s = 900 slots
```

### Bước 3: Summary count

Healthy run:

```text
iterations ~= 900
dropped_iterations = 0
http_reqs ~= 900
```

Nếu `iterations` thấp hơn 900, đọc ngay `dropped_iterations` và `interrupted iterations`.

### Bước 4: Custom metrics

```text
constant_arrival_events_total ~= iterations
constant_arrival_events_failed = 0 hoặc < 10 theo threshold
constant_arrival_api_calls_total ~= http_reqs
```

Vì mỗi event chỉ gọi 1 endpoint, case này là case dễ nhất để reconcile counters.

### Bước 5: Business conclusion

| Output | Kết luận |
| --- | --- |
| 900 iterations, 0 drop, fail 0 | Products service giữ được 20 arrivals/s cho browse traffic |
| 900 iterations, 0 drop, latency p95 cao | Contract đạt nhưng backend cần tối ưu latency |
| <900 iterations, drop > 0 | Contract không đạt; đọc VU pressure trước khi kết luận backend |
| events_failed > 0 | Endpoint/status logic fail; đọc tag `operation` để biết list hay detail |

## Đọc dashboard real-time charts cho case 01

### Overview — Response time

Kỳ vọng:

```text
- p95 ổn định sau cold start
- detail có thể chậm hơn list nhưng không kéo p95 tăng dần
- max spike đơn lẻ không tự động làm fail nếu p95/threshold ổn và drop = 0
```

Nếu p95 tăng dần theo thời gian, nghi ngờ products service có cache miss, DB rows tăng,
hoặc resource pressure.

### Overview — Execution timeline

Kỳ vọng:

```text
iterations/bucket gần 20/s
http_reqs/bucket gần 20/s
dropped_iterations = 0
```

Vì mỗi event gọi 1 request, `iterations` và `http_reqs` nên có shape gần nhau.

### Overview — VUs vs iter/s

Đọc như capacity chart:

```text
actual iter/s gần 20
active VUs tăng/giảm theo latency
active VUs không phải số user thật
```

Nếu actual iter/s tụt trong khi VUs sát `maxVUs`, pool không đủ để giữ ingress.

### Executor tab

Checklist:

```text
executor detected = constant-arrival-rate
rate/timeUnit/duration đúng 20/1s/45s
preAllocatedVUs=12, maxVUs=30
dropped_iterations khớp summary
```

## Kết quả validation 2026-06-21

Full run với default config:

```text
Run id: 89
Target slots: 900
Iterations: 900
HTTP requests: 900
Dropped iterations: 0
Checks: 100%
HTTP failed: 0%
constant_arrival_events_failed: 0
constant_arrival_event_duration_ms p95: 4 ms
Result: PASS
```

Chart analysis chi tiết nằm ở `08_validation-and-chart-analysis.md`.

## Anti-patterns

```text
Sai: "12 preAllocatedVUs nghĩa là chỉ test 12 user."
Đúng: 12 là worker chuẩn bị sẵn; arrival events có userContext riêng.

Sai: "Latency thấp nên pass."
Đúng: phải pass cả dropped_iterations=0 và failed events/checks.

Sai: "http_reqs/s thấp hơn 20 một chút nên chắc backend fail."
Đúng: đọc bucket duration, dropped_iterations, summary runtime và chart aggregation trước.
```
