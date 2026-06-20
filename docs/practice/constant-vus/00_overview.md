# Series thực hành: 7 tình huống thực tế cho `constant-vus`

## Mục đích series

Series này dạy **WHEN/WHY dùng `constant-vus`** bằng 7 case backend thực tế.

Điểm quan trọng nhất:

```text
constant-vus = fixed active user pool over fixed duration
```

Nó không phải executor để chạy đủ một số job cố định, cũng không phải executor để ép hệ thống nhận đúng một target RPS.

Nó trả lời câu hỏi:

```text
Nếu có N active users cùng sử dụng hệ thống trong T phút,
hệ thống giữ latency/error/throughput như thế nào?
```

## Mental model: fixed active user pool + loop until duration ends

Ví dụ config:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "constant-vus",
      vus: 10,
      duration: "5m",
    },
  },
};
```

Đọc đúng:

```text
Có 10 VU active trong 5 phút.
Mỗi VU chạy default() xong thì lập tức chạy vòng tiếp theo.
Test dừng khi duration kết thúc.
Tổng iterations/RPS chỉ biết sau khi chạy.
```

Không đọc thành:

```text
10 VU phải chạy đúng N iterations
```

và cũng không đọc thành:

```text
k6 sẽ cố giữ đúng X requests/s
```

Với `constant-vus`, input là:

```text
vus + duration
```

Output là:

```text
iterations
http_reqs
RPS
iter/s
flow duration
```

## Vì sao `constant-vus` tồn tại?

Nhiều tình huống production được mô tả bằng concurrency ổn định, không phải bằng fixed backlog hay target RPS.

Ví dụ đời thực:

| Tình huống | Input muốn kiểm soát | Output muốn quan sát |
| --- | --- | --- |
| Storefront business hours | 20 active shoppers trong 5 phút | latency, error rate, natural RPS |
| Session keepalive | 15 logged-in sessions active | session health, refresh stability |
| Active cart editing | 18 shoppers liên tục sửa cart | write/read latency, failed loops |
| Checkout trickle | 8 users checkout steady | order/external latency |
| Personalized feed | 25 active readers | personalization latency by operation |
| Backoffice reports | 6 staff active | report UX and async job behavior |
| Mixed production baseline | 30 active mixed users | baseline before ramp/arrival-rate tests |

## Executor comparison: chọn executor nào?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho constant active users? |
| --- | --- | --- |
| `constant-vus` | Fixed active users + fixed observation window | **Đúng**: giữ concurrency phẳng, throughput là output tự nhiên. |
| `shared-iterations` | Worker pool xử lý việc | Sai nếu không có finite backlog cần drain đủ. |
| `per-vu-iterations` | VU identity ổn định | Sai nếu không cần mỗi user chạy đúng N vòng. |
| `constant-arrival-rate` | Fixed RPS | Sai nếu muốn quan sát backend slowdown làm RPS tự giảm. |
| `ramping-vus` | User pool thay đổi theo thời gian | Sai nếu cần steady baseline phẳng. |
| `ramping-arrival-rate` | Campaign/surge shape | Sai cho business-hours steady load. |

Rule nhớ nhanh:

```text
Cần active users phẳng trong T phút      -> constant-vus
Cần fixed backlog N jobs                 -> shared-iterations
Cần mỗi user chạy đúng N vòng            -> per-vu-iterations
Cần target RPS cố định                   -> constant-arrival-rate
Cần user/concurrency tăng giảm theo time -> ramping-vus
```

## Technical semantics that matter

### 1. `vus` là active concurrency

`vus: 20` nghĩa là giữ 20 VUs active trong regular phase.

Nó không có nghĩa:

```text
20 users tổng cộng trong cả ngày
```

mà là:

```text
ở cùng một thời điểm, cố giữ 20 virtual users đang loop
```

### 2. `duration` là observation window

`duration: "5m"` nghĩa là trong 5 phút regular phase, k6 cho VUs tiếp tục start iterations mới.

Nó không phải deadline để hoàn tất một backlog.

Nếu cần “xử lý đủ 1000 job”, dùng `shared-iterations`.

### 3. Total iterations là output

Trong `constant-vus`, không có field `iterations` trong config scenario.

Tổng iterations chỉ biết sau khi chạy:

```text
completed_iterations = summary iterations count
```

Nếu backend nhanh hơn, cùng 20 VUs trong 5 phút có thể hoàn tất nhiều loops hơn.
Nếu backend chậm hơn, hoàn tất ít loops hơn.

### 4. Closed model: backend chậm thì RPS giảm

`constant-vus` là closed model:

```text
VU phải chờ vòng hiện tại xong mới bắt đầu vòng tiếp theo.
```

Nếu backend chậm:

```text
loop_duration tăng
per_vu_loop_rate giảm
iter/s giảm
RPS giảm
```

Đây là tín hiệu quan trọng, không phải lỗi của k6.

Nếu requirement là “dù backend chậm vẫn start 100 iterations/s”, đó là bài arrival-rate, không phải constant-vus.

### 5. User identity có thể ổn định theo VU

Với constant-vus, `__VU` hoặc `exec.vu.idInTest` có thể dùng như active user identity:

```text
VU 1 = user steady-1
VU 2 = user steady-2
...
```

Khác với `shared-iterations`, ở đây VU không chỉ là generic worker bốc job từ backlog. Nó có thể đại diện cho một active user liên tục dùng app trong duration.

### 6. `exec.scenario.iterationInTest` là loop identity, không phải backlog identity

Trong constant-vus, global iteration index chỉ là số vòng đã chạy trong time window.

Không nên đọc nó thành:

```text
job #123 trong fixed backlog
```

vì constant-vus không có fixed backlog.

### 7. Think time làm giảm throughput có chủ ý

`sleep()` hoặc helper `think()` mô phỏng user ngừng đọc/suy nghĩ giữa các hành động.

Nó làm:

```text
loop_duration tăng
iter/s giảm
RPS giảm
```

Đó là expected nếu mục tiêu là mô phỏng active users thật hơn.

## Công thức cần nhớ

```text
loop_duration ~= API time + JS time + sleep/think time
per_vu_loop_rate ~= 1 / loop_duration
total_iter_rate ~= sum(per_vu_loop_rate_i)
if homogeneous: iter/s ~= vus / avg_loop_duration
http_reqs ~= iterations × requests_per_iteration_or_mix
```

Nhưng đây là ước lượng. Số thật phải đọc từ summary/dashboard sau run.

## Common metrics của bộ constant-vus cases

| Metric | Type | Cách đọc |
| --- | --- | --- |
| `constant_active_iterations` | Counter | Số user loops hoàn tất trong fixed-duration run. Đây là output, không phải target. |
| `constant_active_iterations_failed` | Counter | Số user loops có ít nhất một API required bị fail. |
| `constant_api_calls_total` | Counter | Tổng API calls do active users tạo ra. |
| `constant_flow_duration_ms` | Trend | End-to-end duration của một user loop. |
| `constant_sleep_seconds` | Counter | Tổng think time/sleep do script cố ý thêm. |
| `checks` | Rate | API/status/contract checks pass bao nhiêu %. |
| `http_req_failed` | Rate | HTTP/network/protocol failure rate theo k6. |
| `iterations` | Counter | Số vòng `default()` hoàn tất; observed output. |

Pass criteria chung của bộ BE:

```text
checks rate > 0.99
http_req_failed rate < 0.01
constant_active_iterations_failed < per-case cap
```

## Common invalid-result patterns

| Pattern | Meaning | Action |
| --- | --- | --- |
| VUs không flat trong regular phase | Scenario/config/dashboard issue hoặc VU không giữ được | Kiểm config, max VUs, dashboard ingestion |
| `http_req_failed` tăng | HTTP/API failures | Block/investigate status code |
| `constant_active_iterations_failed` tăng | User loop business failure | Lọc theo `operation`, `user_id` |
| iter/s/RPS giảm nhưng VUs flat | Closed-model slowdown/backpressure | Investigate latency/flow duration |
| Aggregate p95 đẹp nhưng một operation xấu | Bottleneck bị aggregate che | Lọc theo service/operation |
| Tổng iterations thấp hơn run trước | Có thể backend chậm hoặc sleep/config khác | So flow duration, sleep, env vars trước khi kết luận fail |
| Expect exact iteration count | Sai mental model | Dùng per-vu/shared nếu cần exact count |

## Dashboard semantics for constant-vus

### Chart 1 — Response time

Chart này trả lời:

```text
API operation nào chậm?
Service nào kéo tail latency?
Request-level p95/p99/max nằm ở đâu?
```

Đọc theo tags:

```text
service
operation
endpoint
user_id nếu cần debug session/user cụ thể
```

Đừng nhầm:

```text
http_req_duration không bao gồm sleep/think time.
```

Muốn đọc full loop latency, xem:

```text
constant_flow_duration_ms
iteration_duration
```

### Chart 2 — Execution timeline

Chart này trả lời:

```text
Trong từng bucket, active users tạo ra bao nhiêu iterations/http_reqs?
RPS/iter/s có ổn định không?
Có thời điểm nào failures tăng không?
```

Với constant-vus:

```text
iterations/http_reqs per bucket = output
```

không phải target đã config.

### Chart 3 — VUs vs iter/s

Đây là chart quan trọng nhất cho constant-vus.

Expected shape:

```text
VUs phẳng gần configured VUs trong regular phase.
iter/s dao động theo loop duration/backend latency/think time.
```

Nếu thấy:

```text
VUs flat + iter/s giảm
```

thì đó là closed-model signal: VUs vẫn active nhưng loop chậm hơn.

Nếu thấy:

```text
VUs không flat
```

thì kiểm scenario config/dashboard ingestion trước khi kết luận backend.

## Bảng tổng hợp 7 case

| # | Script | VUs | Duration | Business shape | Service focus |
| --- | --- | ---: | --- | --- | --- |
| 01 | `cv-01-business-hours-storefront.js` | 20 | 5m | business-hours storefront | products/cart/order |
| 02 | `cv-02-session-keepalive.js` | 15 | 5m | logged-in session keepalive | auth |
| 03 | `cv-03-active-cart-editing.js` | 18 | 5m | active cart editing | cart |
| 04 | `cv-04-checkout-trickle.js` | 8 | 5m | checkout trickle | order |
| 05 | `cv-05-personalized-homefeed.js` | 25 | 5m | personalized homefeed | products |
| 06 | `cv-06-backoffice-report-users.js` | 6 | 5m | backoffice report users | report |
| 07 | `cv-07-production-mixed-baseline.js` | 30 | 5m | production mixed baseline | mixed |

## Real run summary — default constant-vus suite

Bộ 7 case đã được chạy với default config, push final summary và verify qua dashboard/API `http://localhost:13001`.

| Case | Run | Verdict | VUs | iterations | http_reqs | flow p95 | BE/contract note |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| 01 | #68 | FAIL | 20 | 14,772 | 25,058 | 6 ms | threshold_failure; failed_business_iterations; 429 responses on product list: 3869 |
| 02 | #71 | PASS | 15 | 4,470 | 5,379 | 26 ms | không thấy BE issue từ run này |
| 03 | #73 | PASS | 18 | 10,277 | 30,831 | 90 ms | không thấy BE issue từ run này |
| 04 | #75 | PASS | 8 | 2,056 | 6,168 | 200 ms | không thấy BE issue từ run này |
| 05 | #77 | PASS | 25 | 8,267 | 16,534 | 1,198 ms | không thấy BE issue từ run này |
| 06 | #79 | PASS | 6 | 426 | 710 | 6,307 ms | không thấy BE issue từ run này |
| 07 | #80 | FAIL | 30 | 11,861 | 11,861 | 2,495 ms | threshold_failure; failed_business_iterations; 429 responses on product list: 1912 |

Kết luận cross-case:

```text
PASS: case 02, 03, 04, 05, 06.
FAIL: case 01 và 07 do products list trả 429 dưới constant VUs.
```

Root cause đáng báo BE/contract cho 2 case fail:

```text
products-service List rate limiter đang bucket theo identity/header/IP.
constant-vus scripts mô phỏng nhiều users bằng k6 tag user_id, nhưng tag không phải HTTP header.
Vì request list không gửi X-User-ID/X-User-Token, nhiều simulated users bị gom vào cùng bucket và nhận 429.
```

Cách chốt contract đề xuất:

```text
1. Script practice gửi X-User-ID: ctx.userId cho products list; hoặc
2. Backend có load profile/limit riêng cho constant-vus practice; hoặc
3. Catalog/docs ghi rõ products list endpoint intentionally rate-limited và test phải expect 429.
```

Hiện script threshold expect gần như toàn 200, nên run #68 và #80 là FAIL hợp lệ.

## Thứ tự đề xuất học

```text
1. Đọc 00_overview.md để hiểu closed model.
2. Đọc RUN_GUIDE.md để biết cách chạy và collect số.
3. Làm case 01 storefront để hiểu steady shoppers.
4. Làm case 02 session để hiểu active logged-in users.
5. Làm case 03/04 để hiểu write-heavy cart/checkout.
6. Làm case 05/06 để hiểu personalized/report workloads.
7. Làm case 07 để lập mixed production baseline.
```

## Reference

- Run guide: `./RUN_GUIDE.md`
- Constant-vus quick index: `../../20260516_01_constant-vus-quick-index.md`
- Tham số/công thức: `../../20260516_02_constant-vus-tham-so-cong-thuc.md`
- Worked example: `../../20260516_03_constant-vus-quickpizza-two-requests-worked-example.md`
- Executor note: `../../20260115_00_constant-vus-executor.md`
- Shared-iterations contrast: `../shared-iterations/00_overview.md`
- Per-vu contrast: `../per-vu-iterations/00_overview.md`
