# Case 02: Auth token validation RPS

## Tình huống thực tế

Gateway, BFF hoặc frontend shell thường gọi auth service đều đặn để validate token,
refresh session hoặc kiểm tra `/me`. Traffic này không phụ thuộc trực tiếp vào số VU
mà k6 đang dùng; nó là **ingress stream** từ clients/proxies.

Câu hỏi business:

```text
Auth service có chịu được 15 auth-validation arrivals/s trong 45s không?
```

## Vì sao chọn `constant-arrival-rate`?

Nếu dùng `constant-vus`, auth throughput sẽ giảm khi auth service chậm:

```text
login/refresh/me chậm -> VU bị giữ lâu hơn -> vòng lặp ít hơn -> RPS tự hạ
```

Nhưng production gateway không tự giảm token-validation traffic chỉ vì auth đang chậm.
`constant-arrival-rate` giữ nhịp start cố định và bắt buộc ta đọc `dropped_iterations`
để biết có hụt contract không.

## Mapping business -> k6 config

Source script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-02-auth-token-validation-rps.js
```

Default config:

| Field | Value | Ý nghĩa |
| --- | ---: | --- |
| `rate` | `15` | 15 auth arrivals mỗi `timeUnit` |
| `timeUnit` | `1s` | target = 15 arrivals/s |
| `duration` | `45s` | giữ stream trong 45 giây |
| `preAllocatedVUs` | `8` | worker chuẩn bị sẵn |
| `maxVUs` | `24` | trần worker được mở thêm |
| `maxDroppedIterations` | `0` | auth contract không chấp nhận drop |

Expected scheduled slots:

```text
scheduled_slots = 15 × 45 = 675 arrivals
```

Env override:

```powershell
$env:CAR_02_RATE = "15"
$env:CAR_02_TIME_UNIT = "1s"
$env:CAR_02_DURATION = "45s"
$env:CAR_02_PREALLOCATED_VUS = "8"
$env:CAR_02_MAX_VUS = "24"
$env:CAR_02_MAX_DROPPED = "0"
```

## Endpoint flow

Script chọn branch bằng `weightedPick(...)`:

| Branch | Weight | Endpoint | Ý nghĩa |
| --- | ---: | --- | --- |
| `me` | 75% | `GET /api/sim/auth/me` | token validation/read session phổ biến |
| `login` | 15% | `POST /api/sim/auth/login` | login burst nhỏ trong stream |
| `refresh` | 10% | `POST /api/sim/auth/refresh` | refresh token |

Mỗi arrival event gọi đúng 1 API call, nên happy path:

```text
iterations ≈ 675
constant_arrival_events_total ≈ 675
constant_arrival_api_calls_total ≈ 675
http_reqs ≈ 675
dropped_iterations = 0
```

Weighted branch count không cần khớp tuyệt đối từng % ở run ngắn, nhưng tổng event/request
phải reconcile.

## Code walkthrough

Scenario dùng:

```js
auth_token_validation_rps: buildArrivalScenario(
  'authTokenValidationRps',
  RATE,
  TIME_UNIT,
  DURATION,
  PREALLOCATED_VUS,
  MAX_VUS,
  { case_id: CASE_ID, business_case: 'auth_fixed_validation_rps' },
)
```

`userContext(...)` tạo `arrival-user-N` từ iteration number. Đây là test data/user pool,
không phải VU identity cố định như `per-vu-iterations`.

Mỗi call gắn tag:

```text
service = auth-service
operation = auth_arrival_me | auth_arrival_login | auth_arrival_refresh
endpoint = GET/POST /api/sim/auth/...
```

## Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-02-auth-token-validation-rps.js"
```

## Pass criteria

| Check | Pass khi |
| --- | --- |
| `dropped_iterations` | `count <= 0` |
| `checks` | `rate > 0.99` |
| `http_req_failed` | `rate < 0.01` |
| `constant_arrival_events_failed` | `count < 10` |
| `iterations` | gần `675` nếu không drop/interrupt |
| `constant_arrival_events_total` | gần `iterations` |
| `constant_arrival_api_calls_total` | gần `http_reqs`, expected khoảng `675` |

## Phân tích output theo 5 bước

### Bước 1: Header/config

```text
executor = constant-arrival-rate
rate = 15
timeUnit = 1s
duration = 45s
preAllocatedVUs = 8
maxVUs = 24
```

### Bước 2: Expected slots

```text
15/s × 45s = 675 slots
```

### Bước 3: Summary count

Healthy run:

```text
iterations ~= 675
dropped_iterations = 0
http_reqs ~= 675
```

### Bước 4: Auth failure breakdown

Nếu `constant_arrival_events_failed > 0`, đọc tag `operation`:

```text
auth_arrival_me       -> token validation/read session fail
auth_arrival_login    -> login path fail
auth_arrival_refresh  -> refresh path fail
```

### Bước 5: Business conclusion

| Output | Kết luận |
| --- | --- |
| 675 iterations, 0 drop, failed 0 | Auth service giữ được 15 arrivals/s |
| 0 drop nhưng p95 login/refresh cao | Ingress đạt, nhưng endpoint write/refresh cần tối ưu |
| drop > 0, VUs sát max | Auth latency giữ VU quá lâu hoặc VU sizing thiếu |
| failed events tập trung ở refresh | Refresh path có bug/latency riêng, không kết luận toàn auth service |

## Đọc dashboard real-time charts cho case 02

### Response time

Auth `/me` thường nhanh hơn login/refresh. Nếu chart chỉ có p95 tổng, cần drill theo tag
`operation` để tránh login tail che mất `/me` hoặc ngược lại.

### Execution timeline

Kỳ vọng:

```text
iterations/bucket gần 15/s
http_reqs/bucket gần 15/s
dropped_iterations = 0
```

Vì mỗi event chỉ gọi 1 API, timeline rất dễ đối chiếu với summary.

### VUs vs iter/s

Nếu actual iter/s giữ gần 15 nhưng VUs tăng, auth service đang chậm hơn nhưng chưa hụt contract.
Nếu VUs tăng sát `maxVUs=24` và iter/s hụt, đọc `dropped_iterations` ngay.

### Executor tab

Checklist:

```text
executor = constant-arrival-rate
rate/timeUnit/duration = 15/1s/45s
preAllocatedVUs=8, maxVUs=24
dropped_iterations khớp summary
```

## Anti-patterns

```text
Sai: "8 preAllocatedVUs nghĩa là 8 auth users."
Đúng: 8 là worker chuẩn bị sẵn; user id đến từ userContext/user pool.

Sai: "Có 675 http_reqs nên chắc 675 users."
Đúng: 675 là arrival events/API calls trong stream, user pool có thể reuse identity.

Sai: "Auth p95 thấp nên pass."
Đúng: pass cần cả 0 dropped_iterations và failed events trong ngưỡng.
```
