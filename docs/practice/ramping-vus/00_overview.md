# Series thực hành: 7 tình huống thực tế cho `ramping-vus`

## Mục đích series

Series này dạy **WHEN/WHY dùng `ramping-vus`** bằng 7 case backend thực tế.

Điểm quan trọng nhất:

```text
ramping-vus = closed model + active user pool thay đổi theo stages
```

Nó trả lời câu hỏi:

```text
Nếu số active users tăng/giữ peak/giảm theo một timeline,
hệ thống phản ứng thế nào về latency, failures, iter/s và RPS?
```

Nó không phải executor để ép hệ thống nhận đúng một target RPS, cũng không phải executor để xử lý đủ một backlog hữu hạn.

## Mental model: staged active user pool + closed-model loop

Ví dụ config:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "ramping-vus",
      startVUs: 2,
      stages: [
        { duration: "1m", target: 10 },
        { duration: "3m", target: 10 },
        { duration: "1m", target: 2 },
      ],
      gracefulRampDown: "30s",
    },
  },
};
```

Đọc đúng:

```text
Bắt đầu với 2 active VUs.
Trong 1 phút ramp lên 10 VUs.
Giữ 10 VUs trong 3 phút.
Trong 1 phút ramp xuống 2 VUs.
Mỗi active VU loop default() theo closed model.
```

Không đọc thành:

```text
stage target = add thêm từng đó VUs
```

`stage.target` là **absolute VU count ở cuối stage**, không phải số VU tăng thêm.

Cũng không đọc thành:

```text
ramping-vus sẽ tạo đúng X RPS
```

RPS/iter-s là output từ VU shape + loop duration + think time + backend latency.

## Vì sao `ramping-vus` tồn tại?

Rất nhiều traffic production không phẳng. Active users tăng/giảm theo thời gian:

| Tình huống | Shape đời thực | Vì sao cần ramping-vus |
| --- | --- | --- |
| Daily traffic curve | sáng tăng, peak giữ, chiều giảm | Cần active user curve theo ngày |
| Campaign launch | prelaunch thấp, spike cao, recovery | Cần mô phỏng jump concurrency |
| Login wave | user vào đầu ngày, session settle | Cần auth pressure tăng theo wave |
| Checkout promotion | checkout users tăng vào promo | Cần order/payment concurrency ramp |
| Reporting ramp | staff mở report đầu giờ | Cần low-VU nhưng heavy endpoints ramp |
| Cart recovery wave | notification kéo users quay lại | Cần short wave rồi drain |
| Production curve | mixed services theo traffic shape | Cần tổng hợp capacity theo staged concurrency |

## Executor comparison: chọn executor nào?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho staged active users? |
| --- | --- | --- |
| `ramping-vus` | Active users thay đổi theo thời gian | **Đúng**: input là timeline VU, output là latency/iter-s/RPS theo từng phase. |
| `constant-vus` | Cũng là closed model active users | Sai nếu traffic phải rise/peak/cooldown; `constant-vus` giữ VUs phẳng. |
| `shared-iterations` | Có nhiều VU cùng chạy | Sai nếu không có fixed backlog cần drain đủ. |
| `per-vu-iterations` | VU identity ổn định | Sai nếu không cần mỗi VU chạy đúng N vòng; stage duration mới là input chính. |
| `constant-arrival-rate` | Giữ rate ổn định | Sai nếu requirement là active users, không phải arrivals/s. |
| `ramping-arrival-rate` | Cũng có time-shaped load | Close cousin nhưng input là arrivals/s, không phải active VU pool. |

Rule nhớ nhanh:

```text
Cần active VUs đổi theo timeline       -> ramping-vus
Cần active VUs phẳng                   -> constant-vus
Cần fixed global backlog               -> shared-iterations
Cần mỗi VU chạy đúng N vòng            -> per-vu-iterations
Cần target arrivals/RPS đổi theo time  -> ramping-arrival-rate
```

## Technical semantics that matter

### 1. `startVUs` là active VUs ở đầu scenario

`startVUs: 2` nghĩa là scenario bắt đầu với 2 VUs active.

Nó không phải max VUs, không phải total users, không phải target cuối.

### 2. `stages[].target` là absolute target VUs

Nếu stage 1 target 8, stage 2 target 24:

```text
stage 1: đi từ startVUs -> 8
stage 2: đi từ 8 -> 24
```

Không phải:

```text
stage 2 add thêm 24 VUs
```

### 3. `stages[].duration` là thời gian chuyển từ target trước sang target mới

Một stage `{ duration: "30s", target: 24 }` nghĩa là trong 30s, k6 chuyển active VUs từ giá trị trước đó đến 24.

Rough mental formula:

```text
step_interval ~= stage.duration / abs(toVUs - fromVUs)
```

### 4. Total iterations là output

Không có fixed total iteration target.

```text
completed_iterations = observed output after run
```

Nếu backend nhanh hơn, cùng stage shape có thể hoàn tất nhiều loops hơn.
Nếu backend chậm hơn, hoàn tất ít loops hơn.

### 5. Closed model: backend chậm thì iter/s có thể flatten

Mỗi active VU phải hoàn tất loop hiện tại trước khi bắt đầu loop mới.

Nếu backend chậm:

```text
ramping_flow_duration_ms tăng
per-VU loop rate giảm
iter/s hoặc RPS có thể flatten dù VUs đang ramp up
```

Đó là tín hiệu saturation/backpressure, không tự động là k6 bug.

### 6. `gracefulRampDown` bảo vệ in-flight iterations

Khi stage ramp-down chọn VU để dừng, `gracefulRampDown` cho VU thời gian hoàn tất iteration đang chạy.

Nếu quá ngắn hoặc `0s`, bạn có thể thấy interrupted iterations.

Nếu VUs đang giảm mà iterations vẫn tiếp tục hoàn tất thêm một chút, đó có thể là graceful ramp-down behavior bình thường.

### 7. User identity có thể ổn định theo VU khi active

Trong các scripts, `user_id` thường derive từ VU/user context.

Khi VU active, nó đại diện cho active user loop qua nhiều iterations. Nhưng VUs có thể được activate/deactivate theo stage.

### 8. Think time làm giảm throughput có chủ ý

`think()`/`sleep()` mô phỏng user đọc, suy nghĩ, nhập liệu.

Nó làm:

```text
flow duration tăng
iter/s giảm
RPS giảm
```

Đây là expected nếu muốn user behavior thật hơn.

## Công thức cần nhớ

```text
fromVUs = startVUs hoặc previous stage target
toVUs = current stage target
step_interval ~= stage.duration / abs(toVUs - fromVUs)

per_vu_rate_i ~= 1 / flow_time_i
active_pool_rate_at_t ~= sum(1 / flow_time_i) for active VUs at t

iterations/RPS/http_reqs = observed outputs
```

For helper `scaleSeconds(seconds, scale)` in backend scripts:

```text
effective_duration = max(1, round(seconds * RV_NN_DURATION_SCALE)) seconds
```

## Common metrics của bộ ramping-vus cases

| Metric | Type | Cách đọc |
| --- | --- | --- |
| `ramping_active_iterations` | Counter | Số user loops hoàn tất trong staged run. Đây là output, không phải target. |
| `ramping_active_iterations_failed` | Counter | Số loops có ít nhất một API required fail. |
| `ramping_api_calls_total` | Counter | Tổng API calls do ramping user pool tạo ra. |
| `ramping_flow_duration_ms` | Trend | End-to-end duration của một user loop. |
| `ramping_sleep_seconds` | Counter | Think time/sleep do script cố ý thêm. |
| `checks` | Rate | API/status/contract checks pass bao nhiêu %. |
| `http_req_failed` | Rate | HTTP/network/protocol failure rate theo k6. |
| `iterations` | Counter | Số vòng `default()` hoàn tất; observed output. |
| `vus` | Gauge | Active VUs sampled over time; phải đi theo stage shape. |
| `vus_max` | Gauge | Max VUs observed/reserved, dùng để đối chiếu peak target. |

## Common tags của bộ ramping-vus cases

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `rv-02-campaign-launch-spike`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service được gọi. |
| `operation` | Operation cụ thể trong user loop. |
| `endpoint` | Nhóm endpoint/API family. |
| `user_id` | Active user identity derive từ VU/user context. |
| `executor_family` | `ramping_vus`. |
| `workload_shape` | `staged_concurrency`. |

## Common invalid-result patterns

| Pattern | Meaning | Action |
| --- | --- | --- |
| VU chart không theo stage shape | Config/dashboard/ingestion issue | Kiểm startVUs/stages/scale/dashboard data |
| `ramping_active_iterations_failed` tăng | Business flow failures | Lọc theo `operation`, `user_id` |
| `http_req_failed` tăng | HTTP/API failures | Kiểm status code/service |
| VUs tăng nhưng iter/s flatten | Closed-model backpressure/saturation | So `ramping_flow_duration_ms` và operation latency |
| Operation mix sai xa kỳ vọng | Branch/tag/script issue hoặc run quá ngắn | Kiểm weightedPick/modulo logic |
| Ramp-down có interrupted iterations | gracefulRampDown/gracefulStop quá ngắn hoặc loop quá dài | Tăng grace hoặc tối ưu loop |
| Expect exact total iterations | Sai mental model | Dùng shared/per-vu nếu cần exact count |

## Dashboard semantics for ramping-vus

### Chart 1 — Response time

Chart này trả lời:

```text
Operation/service nào chậm ở ramp-up, peak, cooldown?
p95/p99 có chỉ tăng ở high-VU phase không?
Branch nhỏ nào đang kéo tail latency?
```

Đọc theo:

```text
case_id
service
operation
```

### Chart 2 — Execution timeline

Chart này trả lời:

```text
VUs có đi đúng stage shape không?
iterations/http_reqs/failures thay đổi theo phase nào?
Failures có cluster ở transition hoặc peak không?
```

Với ramping-vus:

```text
iterations/http_reqs per bucket = output
```

không phải configured target.

### Chart 3 — VUs vs iter/s

Đây là chart quan trọng nhất cho executor này.

Expected shape:

```text
VUs: ramp-up / plateau / ramp-down
iter/s: tăng/giảm theo VUs nhưng có thể flatten nếu backend chậm
```

Nếu thấy:

```text
VUs rising + iter/s flat
```

đọc là:

```text
possible saturation/backpressure
```

không đọc là:

```text
k6 không bơm đủ target RPS
```

vì ramping-vus không có target RPS.

## Bảng tổng hợp 7 case

| # | Script | Default stage shape | Business shape | Service focus |
| --- | --- | --- | --- | --- |
| 01 | `rv-01-daily-traffic-curve.js` | `2 -> 8 -> 24 -> 12 -> 2` | daily traffic curve | products/cart/order |
| 02 | `rv-02-campaign-launch-spike.js` | `1 -> 6 -> 36 -> 8 -> 1` | campaign spike | products/cart |
| 03 | `rv-03-login-wave.js` | `1 -> 12 -> 28 -> 5` | login/session wave | auth |
| 04 | `rv-04-checkout-ramp.js` | `1 -> 8 -> 18 -> 1` | checkout ramp | cart/order |
| 05 | `rv-05-reporting-ramp.js` | `1 -> 5 -> 14 -> 1` | reporting ramp | report |
| 06 | `rv-06-cart-recovery-wave.js` | `1 -> 22 -> 8 -> 1` | cart recovery wave | cart |
| 07 | `rv-07-production-traffic-curve.js` | `2 -> 12 -> 30 -> 8 -> 2` | production traffic curve | mixed |

<!-- REAL_RUN_SUMMARY_START -->
## Kết quả rerun 2026-06-20

Rerun toàn bộ 7 case bằng private dashboard (`-o cloud`) với default env của từng script.

| Case | Run | Exit | Verdict | Lỗi chính / ghi chú BE |
| --- | ---: | ---: | --- | --- |
| 01 Daily traffic curve | #40 | 99 | **FAIL** | Product browse/list trả 429 vượt ngưỡng của case. |
| 02 Campaign launch spike | #41 | 99 | **FAIL** | Product browse/list trả 429 vượt ngưỡng của case. |
| 03 Login wave | #42 | 0 | **PASS** | Pass sạch, chưa cần báo BE bug. |
| 04 Checkout ramp | #43 | 0 | **PASS** | Pass sạch, chưa cần báo BE bug. |
| 05 Reporting ramp | #44 | 99 | **FAIL** | Script/API contract mismatch: report job trả 202 nhưng script check 200. |
| 06 Cart recovery wave | #45 | 0 | **PASS** | Pass sạch, chưa cần báo BE bug. |
| 07 Production traffic curve | #46 | 99 | **FAIL** | Product browse/list trả 429 vượt ngưỡng của case. |

Đọc kết quả:

```text
PASS = thresholds sạch, exit code 0, summary-final pushed thành công.
FAIL = k6 exit code 99 do threshold crossed; vẫn có summary thật để phân tích.
```

Các vấn đề còn cần báo BE/script owner:

1. **Products list/browse bị 429** trong case 01, 02, 07:
   - Case 01 `daily_curve_list`: 254 request 429.
   - Case 02 `campaign_landing`: 2313 request 429.
   - Case 07 `production_curve_browse`: 66 request 429, làm failed iterations vượt cap.
2. **Reporting create job contract mismatch** trong case 05:
   - Endpoint `POST /api/sim/report/jobs` trả 202.
   - Script đang check default 200 nên 105 checks fail và không chạy status check.

Các case pass sạch trong rerun này: **03 login wave**, **04 checkout ramp**, **06 cart recovery wave**.
<!-- REAL_RUN_SUMMARY_END -->

## Thứ tự đề xuất học

```text
1. Đọc 00_overview.md để hiểu staged concurrency + closed model.
2. Đọc RUN_GUIDE.md để biết cách chạy và collect số.
3. Làm case 01 để hiểu daily curve cơ bản.
4. Làm case 02 để hiểu spike/recovery.
5. Làm case 03/04 để hiểu auth/checkout under ramp.
6. Làm case 05/06 để hiểu reporting/cart waves.
7. Làm case 07 để tổng hợp production curve mixed services.
```

## Reference

- Run guide: `./RUN_GUIDE.md`
- Ramping-vus quick index: `../../20260517_01_ramping-vus-quick-index.md`
- Tham số/công thức: `../../20260517_02_ramping-vus-tham-so-cong-thuc.md`
- Worked example: `../../20260517_03_ramping-vus-quickpizza-two-requests-worked-example.md`
- Constant-vus contrast: `../constant-vus/00_overview.md`
- Shared-iterations contrast: `../shared-iterations/00_overview.md`
- Per-vu contrast: `../per-vu-iterations/00_overview.md`
