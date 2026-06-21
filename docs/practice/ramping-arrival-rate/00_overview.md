# Series thực hành: 7 tình huống thực tế cho `ramping-arrival-rate`

## Mục đích series

Series này dạy **WHEN/WHY dùng `ramping-arrival-rate`** qua 7 tình huống production nơi traffic đến hệ thống **thay đổi theo timeline**.

Câu hỏi đúng của executor này là:

```text
Hệ thống có chịu được arrival rate biến thiên theo stages trong một khoảng thời gian không?
```

Không đọc nó thành:

```text
Có đúng N user đang online không?        -> constant-vus / ramping-vus
Traffic giữ đúng X RPS phẳng không?     -> constant-arrival-rate
Mỗi user chạy đúng M vòng không?        -> per-vu-iterations
Có xử lý hết N job backlog không?       -> shared-iterations
```

`ramping-arrival-rate` là **open model**: k6 cố start iterations theo lịch arrival-rate đã cấu hình. Backend chậm không tự làm giảm target rate; thay vào đó VU demand tăng và nếu không đủ worker thì `dropped_iterations` tăng.

## Read this first

```text
00_overview.md = mental model, công thức, case inventory
RUN_GUIDE.md  = cách chạy, env, dashboard checklist, troubleshooting
01..07        = phân tích từng business case theo script thật
```

Source scripts nằm ở:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-NN-*.js
```

Catalog cho FE/learner:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\case-catalog.json
```

## Mental model: arrival slot = contract, VU = scheduler worker

Ví dụ config:

```js
export const options = {
  scenarios: {
    campaign: {
      executor: 'ramping-arrival-rate',
      startRate: 2,
      timeUnit: '1s',
      stages: [
        { target: 8, duration: '15s' },
        { target: 28, duration: '20s' },
        { target: 6, duration: '15s' },
        { target: 0, duration: '5s' },
      ],
      preAllocatedVUs: 18,
      maxVUs: 60,
    },
  },
};
```

Đọc đúng:

```text
startRate=2/s lúc scenario bắt đầu.
stages[].target là absolute target rate ở cuối mỗi stage.
Rate trong stage được nội suy tuyến tính từ rate trước đó đến target mới.
preAllocatedVUs/maxVUs là capacity để k6 giữ lịch arrival, không phải số business users.
```

Mỗi arrival slot đến giờ hỏi:

```text
Có VU rảnh không?
  Có              -> start iteration.
  Không, còn room -> spawn thêm VU nếu dưới maxVUs.
  Không kịp       -> dropped_iterations += 1.
```

## Technical semantics that matter

### 1. `startRate`, `stages`, `timeUnit` là input contract

```text
rate(t) = rate_start + (rate_end - rate_start) × elapsed_in_stage / stage_duration
```

`rate_start` là `startRate` cho stage đầu, sau đó là target của stage trước.

### 2. Scheduled slots là diện tích dưới đường rate

```text
scheduled_slots_stage = duration_seconds × (rate_start + rate_end) / 2
total_scheduled_slots = Σ scheduled_slots_stage
```

Nếu `dropped_iterations=0`, `iterations` và custom event counter nên gần tổng scheduled slots, có sai số nhỏ do timing/graceful stop.

### 3. VU sizing theo peak rate và event duration

```text
lambda_peak = max(startRate, stages[].target)
required_vus_min ≈ ceil(lambda_peak × W_effective_seconds)
```

`W_effective` là thời gian event giữ VU bận: HTTP latency, JS processing, external wait/polling, và any deliberate wait trong script.

### 4. Backend chậm không tự throttle traffic

Khác closed model:

```text
constant-vus/ramping-vus:
  backend chậm -> VU loop chậm -> throughput tự giảm.

ramping-arrival-rate:
  backend chậm -> event lâu hơn -> cần nhiều VUs hơn để giữ arrival slots.
  thiếu VU -> dropped_iterations tăng.
```

### 5. User identity không bind vào VU

Trong suite này `userContext()` tạo `rar-user-N` từ `exec.scenario.iterationInTest % USER_POOL`.

```text
VU = worker capacity
iterationInTest = arrival slot index
user_id = business identity được derive từ slot, không phải từ VU
```

## Bảng tổng hợp 7 case

| # | Script | Business shape | Config mặc định | Peak rate | Service focus | Điểm học chính |
| --- | --- | --- | --- | ---: | --- | --- |
| 01 | `rar-01-campaign-warmup-surge.js` | Campaign warmup -> surge -> recovery | `2/s -> 8/s -> 28/s -> 6/s -> 0/s`, pre/max `18/60` | 28/s | products + cart | Campaign spike là ingress contract; branch mix vẫn phải giữ zero drops |
| 02 | `rar-02-login-burst-recovery.js` | Login burst recovery | `1/s -> 6/s -> 24/s -> 5/s -> 0/s`, pre/max `16/50` | 24/s | auth | Auth burst có mixed login/me/refresh; status checks theo operation |
| 03 | `rar-03-payment-webhook-wave.js` | Payment webhook wave | `2/s -> 8/s -> 20/s -> 4/s -> 0/s`, pre/max `16/50` | 20/s | order webhook | Webhook provider là open-model producer; idempotency key quan trọng |
| 04 | `rar-04-checkout-flash-sale-wave.js` | Checkout flash-sale wave | `1/s -> 4/s -> 12/s -> 3/s -> 0/s`, pre/max `25/80` | 12/s | cart + order | Peak thấp nhưng event multi-step + external wait làm VU demand cao |
| 05 | `rar-05-report-job-ingress-ramp.js` | Report job ingress ramp | `1/s -> 3/s -> 8/s -> 2/s -> 0/s`, pre/max `25/80`, base `localhost:8088` | 8/s | report | Async create/status giữ VU trong wait; default drop budget bằng 0 |
| 06 | `rar-06-cache-feed-wave.js` | Cache/feed wave | `4/s -> 12/s -> 36/s -> 8/s -> 0/s`, pre/max `18/60` | 36/s | products feed | Peak cao nhất nhưng read path nhanh; Little's Law giải thích VU thấp |
| 07 | `rar-07-production-spike-mix.js` | Production spike mix | `3/s -> 12/s -> 32/s -> 10/s -> 0/s`, pre/max `30/90` | 32/s | mixed | Mixed services dùng chung VU pool; slow branch có thể tạo noisy-neighbor pressure |

## Common metrics của pack

| Metric | Type | Cách đọc |
| --- | --- | --- |
| `ramping_arrival_events_total` | Counter | Event đã start và hoàn thành; thường 1 event = 1 k6 iteration hoàn tất. |
| `ramping_arrival_events_failed` | Counter | Event có ít nhất một required API call fail. |
| `ramping_arrival_api_calls_total` | Counter | Tổng API calls do arrival events tạo ra; có thể > iterations nếu event multi-step. |
| `ramping_arrival_event_duration_ms` | Trend | End-to-end duration của một arrival event, bao gồm multi-step/wait nếu script có. |
| `dropped_iterations` | k6 Counter | Arrival slots không start được đúng lịch vì thiếu VU rảnh; primary pass/fail signal cho open model. |
| `vus` | k6 Gauge | Active VUs observed để giữ ingress curve; không phải số business users. |
| `vus_max` | k6 Gauge | VU ceiling/initialized max theo config/summary. |
| `iterations` | k6 Counter | Started+completed arrival events; output thực tế. |
| `http_reqs` | k6 Counter | Built-in request count; reconcile với `ramping_arrival_api_calls_total`. |
| `checks` | Rate | Contract/status checks pass bao nhiêu %. |
| `http_req_failed` | Rate | HTTP/network/protocol failure rate. |

Pass criteria chung cho default local validation:

```text
checks rate đạt threshold
http_req_failed dưới threshold
ramping_arrival_events_failed dưới case cap
dropped_iterations <= RAR_NN_MAX_DROPPED
```

Với run mặc định người dùng đã validate local against Docker target: cả 7 case đều `checks=100%`, `http failed=0%`, `dropped=0`.

## Tags và dashboard contract

Scenario tags:

```text
executor = ramping-arrival-rate
executor_family = ramping_arrival_rate
workload_shape = ramping_ingress_rate
case_id = rar-NN-...
business_case = ...
```

Request/API-call metrics từ `requestJson()` có:

```text
case_id, service, operation, endpoint, user_id, name
```

Event metrics từ `finishEvent()` có:

```text
case_id, service, operation, user_id
```

Lưu ý: `endpoint` nằm trên request/API-call metrics, không nằm trên event metrics. Đừng filter `ramping_arrival_event_duration_ms` theo `endpoint` rồi tưởng dashboard mất data.

## Cách phân tích output theo 5 bước

1. **Xác nhận executor/config** — đúng `ramping-arrival-rate`, đúng `startRate`, `stages`, `preAllocatedVUs`, `maxVUs`, `case_id`.
2. **Tính scheduled slots** — dùng diện tích hình thang từng stage để biết expected arrivals.
3. **So với summary** — `iterations + dropped_iterations` nên gần scheduled slots; `http_reqs` khớp call pattern.
4. **Đọc drop/failure cùng VU pressure** — nếu dropped > 0, xem `vus`, `vus_max`, event duration, operation p95/p99.
5. **Kết luận theo arrival contract** — pass nghĩa là giữ được curve với error/drop trong ngưỡng, không chỉ latency đẹp.

## Dashboard semantics

### Chart 1 — Response time

Trả lời:

```text
Operation/service nào chậm?
Latency có tăng ở peak stage không?
Tail latency có làm event duration/VU demand tăng không?
```

Dùng `service`, `operation`, `endpoint` trên request metrics để tìm bottleneck. Với multi-step cases, xem thêm event duration vì `http_req_duration` chỉ đo từng request, không đo cả flow.

### Chart 2 — Execution timeline

Trả lời:

```text
iterations/http_reqs per bucket có theo stage curve không?
dropped_iterations xuất hiện ở stage nào?
failures có cluster ở peak/recovery không?
```

Với `ramping-arrival-rate`, `iterations/s` là completed/start-success rate theo bucket; so với target stage theo thời điểm, không so summary average với peak target.

### Chart 3 — VUs vs iter/s

Trả lời:

```text
k6 phải dùng bao nhiêu VUs để giữ arrival curve?
VUs có sát maxVUs không?
iter/s có tụt khi VUs chạm trần không?
```

VUs tăng không phải tự nó là lỗi; đó là scheduler capacity demand. Lỗi là `VUs sát max + dropped_iterations tăng` hoặc `iter/s hụt target stage`.

### Executor tab

Xác nhận executor family, workload shape, case ID, business case, stage curve, `preAllocatedVUs`, `maxVUs`, và dropped count.

## Common invalid-result patterns

| Pattern | Meaning | Action |
| --- | --- | --- |
| `dropped_iterations > 0` ở peak nhưng vẫn kết luận pass vì latency đẹp | Không đạt arrival contract ở peak | Tăng preAllocated/max VUs hoặc giảm target; đọc event duration để biết vì sao |
| Sizing theo average rate | Average che stage peak | Luôn sizing theo `lambda_peak × W_effective` |
| Gọi `preAllocatedVUs` là business users | Sai mental model | Ghi rõ VU là worker; user identity từ slot/user pool |
| So summary `iterations_rate` với peak stage | Summary rate là average toàn run | So theo bucket/stage timeline |
| `dropped>0` nhưng VUs chưa chạm max | Spawn delay hoặc preAllocated thấp | Tăng preAllocatedVUs, kiểm stage ramp quá dốc |
| `http_reqs` không bằng `iterations` | Có multi-step event | Reconcile với case call pattern và `ramping_arrival_api_calls_total` |
| Filter event metric theo `endpoint` không ra data | Event metrics không có endpoint tag | Filter event metric theo `operation`; dùng request metrics cho endpoint |

## Real run summary — default ramping-arrival-rate suite

Bộ 7 case đã chạy qua local cloud/dashboard:

```text
K6_CLOUD_HOST=http://localhost:18080
Dashboard/read API=http://localhost:13001
BASE_URL=http://localhost:80
RAR_05_BASE_URL=http://localhost:8088
summary_pushed=true cho cả 7 run
finish_status=200 cho cả 7 run
```

| Case | Run | Verdict | iterations | http_reqs | dropped | event p95 | HTTP p95 | BE note |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 01 | #100 | PASS | 705 | 705 | 0 | 5 ms | 4.19 ms | không thấy BE issue từ run này |
| 02 | #101 | PASS | 507 | 507 | 0 | 23 ms | 23.10 ms | không thấy BE issue từ run này |
| 03 | #102 | PASS | 545 | 545 | 0 | 6 ms | 5.73 ms | không thấy BE issue từ run này |
| 04 | #103 | PASS | 317 | 951 | 0 | 108 ms | 54.92 ms | không thấy BE issue từ run này |
| 05 | #104 | PASS | 219 | 299 | 0 | 166.10 ms | 23.20 ms | không thấy BE issue từ run này |
| 06 | #105 | PASS | 949 | 949 | 0 | 5 ms | 4.35 ms | không thấy BE issue từ run này |
| 07 | #106 | PASS | 1,034 | 1,034 | 0 | 80.60 ms | 80.34 ms | không thấy BE issue từ run này |

Kết luận cross-case:

```text
PASS: cả 7 case ramping-arrival-rate default.
checks_rate=1, http_req_failed_rate=0, dropped_iterations=0 cho từng case.
Không thấy BE issue bắt buộc phải báo từ các run #100-#106.
```

Diễn giải quan trọng:

```text
- Với open model, VUs tăng/giảm là scheduler capacity demand, không phải số user.
- Tín hiệu pass/fail chính là dropped_iterations + checks/status + operation latency.
- Multi-step cases có http_reqs > iterations là expected: case 04 = 3 calls/event, case 05 mix 1/2 calls/event.
```

## Thứ tự đề xuất học

```text
1. Đọc 00_overview.md để hiểu open model + stage curve.
2. Đọc RUN_GUIDE.md để chạy và collect số.
3. Case 01 campaign warmup/surge: hiểu branch mix + surge curve.
4. Case 02 login burst: auth mixed operations.
5. Case 03 webhook wave: external producer + idempotency.
6. Case 04 checkout wave: multi-step event duration.
7. Case 05 report job ingress: async wait + zero-drop budget.
8. Case 06 cache/feed wave: peak cao nhưng fast read path.
9. Case 07 production mix: noisy-neighbor trong shared VU pool.
```

## Reference

- Run guide: `./RUN_GUIDE.md`
- **Validation + chart analysis với real run data:** `./08_validation-and-chart-analysis.md` ⭐
- Quick index: `../../20260518_01_ramping-arrival-rate-quick-index.md`
- Tham số/công thức: `../../20260518_02_ramping-arrival-rate-tham-so-cong-thuc.md`
- Worked example: `../../20260518_03_ramping-arrival-rate-worked-example.md`
- Constant-arrival-rate overview: `../constant-arrival-rate/00_overview.md`
- Ramping-vus overview: `../ramping-vus/00_overview.md`
- Constant-vus overview: `../constant-vus/00_overview.md`
- Source pack: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\README.md`

## Real validation run summary (2026-06-21)

Chạy local với `BASE_URL=http://localhost:80`:

| # | Case | Iter | Drop | HTTP Reqs | Event p95 | Active VU max | Result |
|---|------|-----:|-----:|----------:|----------:|--------------:|--------|
| 01 | Campaign warmup surge | 705 | 0 | 705 | 5ms | 1 | ✅ PASS |
| 02 | Login burst recovery | 507 | 0 | 507 | 23ms | 1 | ✅ PASS |
| 03 | Payment webhook wave | 545 | 0 | 545 | 6ms | 0 | ✅ PASS |
| 04 | Checkout flash-sale wave | 317 | 0 | 951 | 112ms | 1 | ✅ PASS |
| 05 | Report job ingress ramp | 199 | **20** | 278 | 9.01s | 45 | ❌ FAIL (rerun pre=60/max=120: 216 iter, 3 drops, STILL FAIL) |
| 06 | Cache feed wave | 949 | 0 | 949 | 4ms | 1 | ✅ PASS |
| 07 | Production spike mix | 1035 | 0 | 1035 | 86ms | 6 | ✅ PASS |

**6/7 pass.** rar-05 fail vì `dropped_iterations=20 > maxDropped=0` — đúng như thiết kế dạy open-model.

Chi tiết: `08_validation-and-chart-analysis.md`.
