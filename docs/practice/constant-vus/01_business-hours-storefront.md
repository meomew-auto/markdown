# Case 01: Business-hours storefront

## Tình huống thực tế

Team storefront muốn biết hệ thống hoạt động ra sao khi có một nhóm shopper đang active trong giờ kinh doanh bình thường.

Người dùng không chỉ list product; họ browse detail, thêm cart, và một phần nhỏ checkout. Đây là steady user behavior, không phải batch jobs.

Case này trả lời: nếu giữ 20 active shoppers trong 5 phút, products/cart/order có giữ được latency và failure rate ổn định không?

Tóm tắt đời thường:

```text
Executor model: fixed active user pool
VUs: 20
Duration: 5m
Think time: 0.4s
Team/service focus: storefront/product/cart/order
```

Case này không hỏi:

```text
Có xử lý đủ N job không?
Có đạt đúng X RPS không?
Mỗi user có chạy đúng N vòng không?
```

Nó hỏi:

```text
Nếu giữ 20 active users trong 5m,
latency/error/natural throughput của flow này ra sao?
```

## Yêu cầu cứng của case này

- Giữ active concurrency gần 20 VUs trong regular phase.
- Chạy đủ observation window 5m, không dùng total iterations làm target.
- Weighted mix browse/cart/checkout phải được đọc bằng operation tags.
- Failed user loops phải thấp hơn `constant_active_iterations_failed count<20`.

Các invariant chung:

```text
vus + duration = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì RPS giảm
```

Do đó không được fail test chỉ vì `iterations` không bằng một số target tưởng tượng.

## Vì sao "Business-hours storefront" nên dùng `constant-vus`?

Business-hours storefront là bài toán concurrency steady: có một lượng shopper active, họ lặp lại hành vi tự nhiên. Ta muốn natural throughput và latency sinh ra từ 20 users, không muốn ép RPS hay drain backlog.

Mental model:

```text
20 active VUs start.
Each VU loops the user flow until 5m ends.
A loop finishes -> same VU starts the next loop.
Total completed loops depend on loop duration.
```

Nếu backend nhanh:

```text
loop_duration giảm -> mỗi VU chạy nhiều loops hơn -> iter/s/RPS tăng
```

Nếu backend chậm:

```text
loop_duration tăng -> mỗi VU chạy ít loops hơn -> iter/s/RPS giảm
```

Đây là lý do gọi là closed model.

## Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho case steady active users? |
| --- | --- | --- |
| `constant-vus` | Giữ N active users trong duration T | **Đúng**: input chính là concurrency + observation window; throughput là output tự nhiên. |
| `shared-iterations` | Cũng có nhiều VU cùng làm việc | Sai nếu không có backlog hữu hạn cần drain đủ; nó tối ưu fixed total jobs, không phải active users over time. |
| `per-vu-iterations` | VU có thể là user identity ổn định | Sai nếu không cần mỗi user chạy đúng N vòng; nó biến test thành quota replay, không phải steady active pool. |
| `constant-arrival-rate` | Có thể giữ RPS cố định | Sai nếu muốn quan sát closed-model backpressure; arrival-rate sẽ cố bơm traffic theo rate. |
| `ramping-vus` | Mô phỏng user tăng/giảm | Sai nếu requirement là active concurrency phẳng để lấy baseline. |
| `ramping-arrival-rate` | Mô phỏng campaign/surge | Sai cho steady baseline; nó thay đổi target arrivals theo thời gian. |

Kết luận cho case này:

```text
Need fixed active users over time -> constant-vus.
Need fixed total jobs -> shared-iterations, not this case.
Need fixed per-user quota -> per-vu-iterations, not this case.
Need fixed RPS -> constant-arrival-rate, not this case.
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
CV_01_VUS = 20
CV_01_DURATION = 5m
CV_01_SLEEP_SECONDS = 0.4

browse 70%
cart 25%
checkout 5%
```

| Config/env | Giá trị | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `CV_01_VUS` | 20 | Số active shoppers |
| `CV_01_DURATION` | 5m | Observation window |
| `CV_01_SLEEP_SECONDS` | 0.4 | Think time giữa các vòng |

Weighted mix expected:

| Branch | Weight |
| --- | --- |
| browse | 70% |
| cart | 25% |
| checkout | 5% |

Threshold cap riêng:

```text
constant_active_iterations_failed: count<20
```

## Technical semantics: active user pool, loop identity, closed model

Trong constant-vus:

```text
__VU / exec.vu.idInTest = active user identity tương đối ổn định
__ITER                  = loop counter của riêng VU đó
exec.scenario.iterationInTest = global loop counter, không phải backlog job id
```

Một VU có thể chạy nhiều loops trong duration. Nhưng không có quota kiểu:

```text
mỗi VU phải chạy đúng N loops
```

Nếu cần quota per user, dùng `per-vu-iterations`.

Nếu cần fixed global job list, dùng `shared-iterations`.

## Technical root causes this case catches

### Nguyên nhân kỹ thuật 1: Browse latency lowers natural RPS while VUs stay flat

Nếu products-service chậm, 20 VUs vẫn active nhưng mỗi loop lâu hơn, nên iter/s/RPS giảm. Đây là closed-model signal cần học.

### Nguyên nhân kỹ thuật 2: Checkout branch nhỏ nhưng có thể kéo mixed p95

Checkout chỉ khoảng 5% mix nhưng có external_ms/order dependency. Aggregate p95 có thể bị checkout kéo lên dù browse/cart ổn.

### Nguyên nhân kỹ thuật 3: Weighted operation mix hides branch bottlenecks

Tổng `http_reqs` không nói operation nào chiếm bao nhiêu. Phải lọc theo `operation` để thấy browse/cart/checkout đúng mix và bottleneck.

### Nguyên nhân kỹ thuật 4: No dropped arrivals expected

Khi backend chậm, constant-vus không bơm thêm arrivals để giữ RPS. Nó giảm throughput tự nhiên thay vì tạo arrival pressure.

## Service/API flow

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| storefront_browse_list | products-service | GET | /api/sim/products | 200 | Browse product list. |
| storefront_browse_detail | products-service | GET | /api/sim/products/:id | 200 | Open product detail. |
| storefront_cart_add | cart-service | POST | /api/sim/cart/add | 200 | Add item to cart. |
| storefront_checkout | order-service | POST | /api/sim/checkout | 200 | Occasional checkout branch. |

Các operation này phải được đọc bằng tag `operation`, vì aggregate metrics có thể che branch nhỏ nhưng chậm.

## Metrics và tags cần đọc

| Metric | Type | Đọc như thế nào |
| --- | --- | --- |
| `constant_active_iterations` | Counter | Số user loops hoàn tất trong fixed-duration run. Đây là output, không phải target. |
| `constant_active_iterations_failed` | Counter | Số user loops có ít nhất một API required bị fail. Đây là business-flow failure counter. |
| `constant_api_calls_total` | Counter | Tổng API calls do active users tạo ra. Dùng để đối chiếu calls/loop hoặc weighted mix. |
| `constant_flow_duration_ms` | Trend | End-to-end duration của một user loop, bao gồm nhiều API trong flow. |
| `constant_sleep_seconds` | Counter | Tổng think time/sleep do script cố ý thêm để mô phỏng user thật. |
| `checks` | Rate | API/status/contract checks pass bao nhiêu %. |
| `http_req_failed` | Rate | HTTP/network/protocol failure rate theo k6. |
| `iterations` | Counter | Số vòng `default()` hoàn tất. Với `constant-vus`, đây là observed output. |

Tags chung:

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `cv-03-active-cart-editing`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service được gọi. |
| `operation` | Operation cụ thể trong user loop. |
| `endpoint` | Nhóm endpoint/API family. |
| `user_id` | Active user identity derive từ VU/user context. |
| `executor_family` | `constant_vus`. |
| `workload_shape` | `steady_concurrency`. |

Tags case này:

```text
case_id       = cv-01-business-hours-storefront
business_case = business_hours_storefront
workload      = steady_concurrency
```

## Pass criteria

Pass criteria tối thiểu theo backend script:

```text
checks rate > 0.99
http_req_failed rate < 0.01
constant_active_iterations_failed count<20
```

Các counters cần sanity check:

```text
constant_active_iterations ~= iterations completed by user loops
constant_api_calls_total   ~= API calls generated by completed/attempted loops
constant_flow_duration_ms  = end-to-end loop duration
constant_sleep_seconds     = configured think time actually applied
```

Không có expected exact count cho:

```text
iterations
http_reqs
RPS
iter/s
```

Chúng là observed outputs.

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = constant-vus
vus = 20 hoặc env override
duration = 5m hoặc env override
```

### Bước 2 — Verify active-user model

Summary/dashboard nên thể hiện VUs giữ gần configured VUs trong regular phase.

Nếu VUs không flat, kiểm config/ingestion trước khi kết luận backend.

### Bước 3 — Check failures trước throughput

Đọc trước:

```text
checks
http_req_failed
constant_active_iterations_failed
```

Nếu các metric này fail, xử lý correctness/failure trước khi bàn RPS.

### Bước 4 — Interpret counters as outputs

Đọc:

```text
iterations
http_reqs
constant_active_iterations
constant_api_calls_total
```

Nhớ:

```text
iterations thấp hơn run khác không tự động fail.
Có thể do backend latency tăng hoặc sleep/config khác.
```

### Bước 5 — Interpret duration/throughput

Đọc:

```text
constant_flow_duration_ms
iteration_duration
http_req_duration by operation
```

Case-specific notes:

- `iterations` là số shopper loops hoàn tất trong 5m, không có expected exact count.
- `constant_api_calls_total` phải đọc cùng weighted mix; browse path có thể tạo nhiều products calls hơn checkout.
- `constant_flow_duration_ms` cho biết full shopper loop bị chậm bởi branch nào.

## Đọc dashboard real-time charts cho case 01

> Phần này mô tả cách đọc expected dashboard. Chỉ thêm run ID/số p95/bucket thật sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? | Total iterations target, vì không có target đó |
| Execution timeline | VUs/RPS/iter/s thay đổi theo time thế nào? | Business branch nào chậm nếu không lọc operation |
| VUs vs iter/s | VUs có flat không, iter/s có giảm không? | Fixed RPS target, vì constant-vus không config RPS |

### Chart 1 — Response time

Đọc theo `operation`:

```text
storefront_browse_list: GET /api/sim/products
storefront_browse_detail: GET /api/sim/products/:id
storefront_cart_add: POST /api/sim/cart/add
storefront_checkout: POST /api/sim/checkout
```

Cách đọc:

```text
http_req_duration       = latency từng request
constant_flow_duration_ms = latency full user loop
iteration_duration      = duration vòng default(), thường bao gồm sleep
```

Đừng dùng aggregate p95 một mình trong mixed/multi-operation flow.

Case-specific hints:

- Response time: tách `storefront_browse_list`, `storefront_browse_detail`, `storefront_cart_add`, `storefront_checkout`.
- Execution timeline: nếu VUs flat nhưng RPS giảm, nghi backend/branch latency tăng.
- VUs vs iter/s: checkout external latency có thể tạo dips nhỏ trong iter/s nếu nhiều VUs rơi vào branch checkout cùng lúc.

### Chart 2 — Execution timeline

Với constant-vus:

```text
VUs should be flat near 20 during regular phase.
iterations/http_reqs per bucket are observed outputs.
RPS depends on loop duration + API mix + sleep.
```

Nếu thấy:

```text
VUs flat nhưng RPS/iter/s giảm
```

thì đọc là:

```text
closed-model slowdown/backpressure
```

không đọc là:

```text
k6 không bơm đủ target RPS
```

vì không có target RPS trong constant-vus.

### Chart 3 — VUs vs iter/s

Chart này là trọng tâm của executor này.

Expected:

```text
VUs: flat near configured value
iter/s: dao động theo backend latency + think time + branch mix
```

Bad shapes:

| Shape | Nghĩa |
| --- | --- |
| VUs flat, iter/s slowly falling | Backend/flow duration tăng, closed-model backpressure |
| VUs not flat | Scenario/config/dashboard issue cần kiểm trước |
| iter/s spike/drop theo branch | Weighted branch hoặc dependency latency thay đổi |
| end-tail odd shape | duration/gracefulStop/end bucket effect |

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận failures/thresholds trước.
2. VUs vs iter/s xác nhận active-user pool có phẳng không.
3. Execution timeline cho thấy RPS/iter/s là output theo time.
4. Response time by operation tìm service/branch chậm.
5. Business decision dựa trên failures + latency + closed-model throughput change.
```

## Kết luận thực tế: output -> quyết định

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| Failures near zero, VUs flat, latency stable | Storefront steady-state acceptable | Use as baseline / continue |
| Checkout slower than browse/cart | Order/payment dependency bottleneck | Inspect checkout branch |
| VUs flat but iter/s drops | Closed-model backpressure visible | Investigate latency by operation |
| Operation mix far from expected over long run | weightedPick/tagging issue | Validate script and catalog mapping |

## Nghịch lý và misconceptions của constant-vus

Đừng nói case này xử lý đủ N shoppers. Nó giữ 20 shoppers active trong 5m; số loop họ hoàn tất là output.

Nhớ 3 câu:

```text
vus + duration = input
iterations/RPS = output
backend chậm -> RPS giảm là tín hiệu đúng của closed model
```

## Mở rộng

- Tăng `VUS` để xem service chịu active concurrency cao hơn ra sao.
- Tăng `DURATION` để biến case thành stability/soak ngắn.
- Tăng/giảm sleep để thấy think time tác động đến RPS.
- Thêm threshold theo `constant_flow_duration_ms` hoặc operation p95 nếu muốn biến baseline thành performance gate.

## Anti-pattern

- Dùng total `iterations` như pass/fail target cứng.
- Kỳ vọng fixed RPS từ `constant-vus`.
- So sánh 2 run có sleep/duration/VUs khác nhau rồi kết luận backend regress.
- Chỉ nhìn aggregate p95 trong flow nhiều operation.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với per-user quota của `per-vu-iterations`.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Constant-vus quick index: `../../20260516_01_constant-vus-quick-index.md`
- Tham số/công thức: `../../20260516_02_constant-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js`
