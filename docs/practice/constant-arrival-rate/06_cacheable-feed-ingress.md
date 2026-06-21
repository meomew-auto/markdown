# Case 06: Cacheable feed ingress

## Tình huống thực tế

Homefeed/recommendation traffic thường là read-heavy và có thể cache tốt. Nhưng external
traffic vẫn đến theo nhịp cố định từ app/web.

Câu hỏi business:

```text
Products/feed service có giữ được 24 feed arrivals/s trong 45s không?
```

Đây là case có target rate cao nhất trong pack, dùng để đọc fixed read ingress và cache/headroom.

## Vì sao chọn `constant-arrival-rate`?

Read-heavy endpoint nhanh hơn checkout/report, nên VU requirement có thể thấp hơn dù rate cao hơn.
Nhưng nếu cache miss hoặc recommendation query chậm, k6 vẫn cố giữ arrival rate.

`constant-arrival-rate` làm rõ:

```text
cache hit tốt -> VUs thấp, iter/s đạt target
cache miss/tail latency -> VUs tăng
thiếu VU -> dropped_iterations
```

## Mapping business -> k6 config

Source script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-06-cacheable-feed-ingress.js
```

Default config:

| Field | Value | Ý nghĩa |
| --- | ---: | --- |
| `rate` | `24` | 24 feed arrivals mỗi giây |
| `timeUnit` | `1s` | target = 24 arrivals/s |
| `duration` | `45s` | giữ ingress trong 45 giây |
| `preAllocatedVUs` | `12` | worker chuẩn bị sẵn |
| `maxVUs` | `30` | trần worker được mở thêm |
| `maxDroppedIterations` | `0` | không chấp nhận drop |

Expected scheduled slots:

```text
scheduled_slots = 24 × 45 = 1080 arrivals
```

Env override:

```powershell
$env:CAR_06_RATE = "24"
$env:CAR_06_TIME_UNIT = "1s"
$env:CAR_06_DURATION = "45s"
$env:CAR_06_PREALLOCATED_VUS = "12"
$env:CAR_06_MAX_VUS = "30"
$env:CAR_06_MAX_DROPPED = "0"
```

## Endpoint flow

Weighted branches:

| Branch | Weight | Endpoint | Ý nghĩa |
| --- | ---: | --- | --- |
| `homefeed` | 65% | `GET /api/sim/products/homefeed` | feed chính, read-heavy |
| `recommendations` | 35% | `GET /api/sim/products/:id/recommendations` | recommendation detail |

Mỗi arrival event gọi đúng 1 API:

```text
iterations ≈ 1080
constant_arrival_events_total ≈ 1080
constant_arrival_api_calls_total ≈ 1080
http_reqs ≈ 1080
dropped_iterations = 0
```

## Code walkthrough

Scenario:

```js
cacheable_feed_ingress: buildArrivalScenario(
  'cacheableFeedIngress',
  RATE,
  TIME_UNIT,
  DURATION,
  PREALLOCATED_VUS,
  MAX_VUS,
  { case_id: CASE_ID, business_case: 'cacheable_feed_fixed_ingress' },
)
```

Endpoint query mô phỏng read/cache workload:

```text
homefeed: personalized=1, json_items=12, gzip_kb=1
recommendations: algorithm=collaborative, limit=6
```

Điểm học: high rate không tự động fail nếu event duration thấp; VU sizing theo
`lambda × event_duration`.

## Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-06-cacheable-feed-ingress.js"
```

## Pass criteria

| Check | Pass khi |
| --- | --- |
| `dropped_iterations` | `count <= 0` |
| `checks` | `rate > 0.99` |
| `http_req_failed` | `rate < 0.01` |
| `constant_arrival_events_failed` | `count < 10` |
| `iterations` | gần `1080` nếu không drop/interrupt |
| `constant_arrival_events_total` | gần `iterations` |
| `constant_arrival_api_calls_total` | gần `http_reqs`, expected khoảng `1080` |

## Phân tích output theo 5 bước

### Bước 1: Header/config

```text
executor = constant-arrival-rate
rate = 24
timeUnit = 1s
duration = 45s
preAllocatedVUs = 12
maxVUs = 30
```

### Bước 2: Expected slots

```text
24/s × 45s = 1080 slots
```

### Bước 3: Summary count

Healthy run:

```text
iterations ~= 1080
dropped_iterations = 0
http_reqs ~= 1080
```

### Bước 4: Feed operation breakdown

Drill by operation:

```text
feed_arrival_homefeed
feed_arrival_recommendations
```

Nếu p95 cao chỉ ở recommendations, cache/feed homepage có thể vẫn ổn.

### Bước 5: Business conclusion

| Output | Kết luận |
| --- | --- |
| 1080 iterations, 0 drop, failed 0 | Feed service giữ được 24 arrivals/s |
| VUs thấp, iter/s đạt | Cache/read path còn nhiều headroom |
| VUs tăng hoặc p95 tăng | Cache miss/recommendation latency đang ăn capacity |
| drop > 0 | High-rate read ingress không đạt; đọc VU pool và endpoint latency |

## Đọc dashboard real-time charts cho case 06

### Response time

Kỳ vọng p95 ổn định. Nếu có cold start ở đầu run rồi ổn định, có thể là cache warm.
Nếu p95 tăng dần, nghi resource pressure hoặc cache churn.

### Execution timeline

Kỳ vọng:

```text
iterations/bucket gần 24/s
http_reqs/bucket gần 24/s
dropped_iterations = 0
```

Do rate cao, chart này dễ thấy bucket nào hụt.

### VUs vs iter/s

Nếu service cache tốt, active VUs có thể thấp dù target 24/s. Đây là ví dụ tốt cho công thức:

```text
required_vus ≈ lambda × event_duration
```

Rate cao nhưng event nhanh -> cần ít worker.

### Executor tab

Checklist:

```text
executor = constant-arrival-rate
rate/timeUnit/duration = 24/1s/45s
preAllocatedVUs=12, maxVUs=30
dropped_iterations khớp summary
```

## Anti-patterns

```text
Sai: "Rate cao nhất nên chắc cần nhiều VU nhất."
Đúng: Cần VU theo rate × event duration; feed nhanh có thể cần ít VU hơn checkout.

Sai: "Cacheable endpoint không cần đọc dropped_iterations."
Đúng: Nếu cache miss làm VU pool cạn, drop vẫn là failure của ingress contract.

Sai: "1080 http_reqs nghĩa là 1080 user."
Đúng: Đó là 1080 arrivals/API calls; user pool có thể reuse identity.
```
