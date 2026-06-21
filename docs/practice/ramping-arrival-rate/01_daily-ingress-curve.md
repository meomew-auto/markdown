# Case 01: Campaign Warmup Surge

> **Script:** `rar-01-campaign-warmup-surge.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 28 arrivals/s
> **Focus:** products browse/detail + cart add trong campaign warmup -> surge -> recovery.

## 1. Tình huống thực tế

Marketing mở campaign. Traffic không phẳng: ban đầu warmup, sau đó surge ở launch window, rồi recovery. Đây là ingress contract từ bên ngoài hệ thống; backend không được tự giảm nhịp chỉ vì response chậm.

```text
startRate = 2/s
15s -> 8/s   warmup
20s -> 28/s  launch surge / peak
15s -> 6/s   recovery
5s  -> 0/s   drain
```

Business question:

```text
Products/cart có giữ được campaign curve 2 -> 8 -> 28 -> 6/s mà không drop slot không?
```

## 2. Vì sao dùng `ramping-arrival-rate`?

Case này cần kiểm soát **arrival rate thay đổi theo thời gian**, không phải số user online. Nếu dùng `ramping-vus`, throughput sẽ là output của VU loop duration; nếu backend chậm, RPS tự tụt và che mất câu hỏi “28 arrivals/s có chịu được không?”.

## 3. Config mapping

| Tham số | Default | Ý nghĩa |
| --- | ---: | --- |
| `RAR_01_START_RATE` | 2 | rate lúc scenario bắt đầu |
| `RAR_01_WARM_RATE` | 8 | cuối warmup stage |
| `RAR_01_PEAK_RATE` | 28 | peak campaign surge |
| `RAR_01_RECOVERY_RATE` | 6 | recovery traffic |
| `RAR_01_DURATION_SCALE` | 1 | scale stage duration |
| `RAR_01_PREALLOCATED_VUS` | 18 | worker warm sẵn |
| `RAR_01_MAX_VUS` | 60 | trần worker |
| `RAR_01_MAX_DROPPED` | 5 | drop budget |
| `RAR_01_USER_POOL` | 800 | pool business user id |

Scheduled slots mặc định:

```text
15×(2+8)/2  = 75
20×(8+28)/2 = 360
15×(28+6)/2 = 255
5×(6+0)/2   = 15
total        = 705 arrivals
```

## 4. Service/API flow

Mỗi arrival event chạy 1 branch theo deterministic weighted mix:

| Branch | Weight | Service | Operation | Endpoint |
| --- | ---: | --- | --- | --- |
| Landing/list | 55% | products-service | `campaign_surge_landing` | `GET /api/sim/products` |
| Detail | 30% | products-service | `campaign_surge_detail` | `GET /api/sim/products/:id` |
| Cart add | 15% | cart-service | `campaign_surge_cart_add` | `POST /api/sim/cart/add` |

`finishEvent()` ghi event-level operation `campaign_surge_<branch>`; request metrics có `endpoint`, event metrics không có `endpoint`.

## 5. Metrics cần đọc

```text
ramping_arrival_events_total       ~= iterations
ramping_arrival_api_calls_total    ~= http_reqs ~= iterations
ramping_arrival_events_failed      = event business failures
dropped_iterations                 = slot không start được đúng lịch
ramping_arrival_event_duration_ms  = full branch duration
```

## 6. Pass criteria

```text
checks > 0.98
http_req_failed < 0.02
dropped_iterations <= RAR_01_MAX_DROPPED
ramping_arrival_events_failed < 20
```

Default local validation đã thấy:

```text
iterations=705
http_reqs=705
checks=100%
http failed=0%
dropped_iterations=0
p95≈4.25ms
```

## 7. Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js"
```

Smoke nhanh:

```powershell
$env:RAR_01_DURATION_SCALE = "0"  # envInt + scaleSeconds() clamps stages to 1s each
$env:RAR_01_PEAK_RATE = "8"
$env:RAR_01_PREALLOCATED_VUS = "4"
$env:RAR_01_MAX_VUS = "12"
```

Xóa override sau smoke trước khi chạy default.

## 8. Dashboard reading

**Response time.** Filter theo `operation`: landing/detail/cart_add. Nếu cart add p95/p99 kéo dài ở peak, đó là dấu hiệu cart-service write path bị campaign pressure.

**Execution timeline.** Iterations/http_reqs bucket phải theo curve 2 -> 8 -> 28 -> 6/s. `dropped_iterations=0` nghĩa là k6 start đủ campaign slots.

**VUs vs iter/s.** VUs có thể tăng ở stage peak; đó là scheduler demand bình thường. Fail khi VUs sát max và dropped tăng.

**Executor tab.** Xác nhận `executor_family=ramping_arrival_rate`, `workload_shape=ramping_ingress_rate`, `case_id=rar-01-campaign-warmup-surge`.

## 9. Output -> decision

| Output | Kết luận |
| --- | --- |
| dropped=0, checks 100%, VUs còn headroom | Campaign curve pass |
| dropped tăng ở stage 2 | Peak 28/s vượt capacity hoặc preAllocated thấp |
| cart_add p95/p99 cao nhưng dropped=0 | Backend còn giữ được ingress, nhưng cart latency cần theo dõi |
| checks fail theo products/cart | Báo đúng service/operation, không kết luận chung chung |

## 10. Real run — dashboard verification

Run verify qua local cloud/dashboard với default env:

```text
Run ID: #100
Script: rar-01-campaign-warmup-surge.js
Exit code: 0
summary_pushed: true
finish_status: 200
Target base: http://localhost:80
```

### Summary chính

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes/checks_fails` | `705 / 0` |
| `http_req_failed_rate` | `0` |
| `dropped_iterations` | `0` |
| `ramping_arrival_events_failed_rate` | `0` |
| `iterations` | `705` |
| `iterations_rate` | `12.82/s` |
| `http_reqs` | `705` |
| `http_reqs_rate` | `12.82/s` |
| `vus_max` | `1` |
| `ramping_arrival_event_duration_ms avg/med/p95/p99/max` | `3.64 / 3 / 5 / 6 / 18 ms` |
| `http_req_duration avg/med/p95/p99/max` | `3.49 / 3.32 / 4.19 / 5.32 / 18.34 ms` |

Request breakdown:

```text
campaign_surge_landing GET 200 count=390
campaign_surge_detail GET 200 count=210
campaign_surge_cart_add POST 200 count=105
```

### Dashboard series check

```text
iterations: points=55, sum=705, min=1, max=27, truncated=false
http_reqs: points=705, sum=705, min=1, max=1, truncated=false
dropped_iterations: points=0, truncated=false
vus: points=55, min=0, max=1, truncated=false
```

### Verdict

```text
PASS — default ramping-arrival-rate case giữ được arrival curve: checks sạch, HTTP failed 0%, dropped_iterations=0.
```

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js`
