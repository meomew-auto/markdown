# Case 04: Checkout Flash-Sale Wave

> **Script:** `rar-04-checkout-flash-sale-wave.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 12 arrivals/s
> **Focus:** cart add -> checkout -> confirm multi-step flow trong flash sale.

## 1. Tình huống thực tế

Flash sale làm checkout intake tăng theo wave. Peak rate không cao bằng browse/feed, nhưng mỗi event giữ VU lâu hơn vì có nhiều POST và external latency giả lập.

```text
startRate = 1/s
15s -> 4/s   browse/intent stage
20s -> 12/s  checkout peak
15s -> 3/s   recovery
5s  -> 0/s   drain
```

Business question:

```text
Order/cart path có xử lý được checkout wave 1 -> 4 -> 12 -> 3/s mà không drop/fail không?
```

## 2. Vì sao dùng `ramping-arrival-rate`?

Đây là order intake contract: tại peak, hệ thống phải nhận checkout arrivals đúng nhịp. Closed-model executors sẽ tự giảm throughput khi checkout chậm, làm mất tín hiệu “không giữ được arrival contract”.

## 3. Config mapping

| Tham số | Default | Ý nghĩa |
| --- | ---: | --- |
| `RAR_04_START_RATE` | 1 | rate đầu run |
| `RAR_04_BROWSE_RATE` | 4 | pre-checkout ramp |
| `RAR_04_CHECKOUT_RATE` | 12 | checkout peak |
| `RAR_04_RECOVERY_RATE` | 3 | recovery traffic |
| `RAR_04_DURATION_SCALE` | 1 | scale stage duration |
| `RAR_04_PREALLOCATED_VUS` | 25 | worker warm sẵn |
| `RAR_04_MAX_VUS` | 80 | worker ceiling |
| `RAR_04_MAX_DROPPED` | 3 | drop budget |
| `RAR_04_USER_POOL` | 500 | user identity pool |

Scheduled slots mặc định:

```text
15×(1+4)/2  = 37.5
20×(4+12)/2 = 160
15×(12+3)/2 = 112.5
5×(3+0)/2   = 7.5
total        ≈ 317.5 arrivals
```

## 4. Service/API flow

Mỗi event gồm 3 API calls:

| Step | Service | Operation | Endpoint | Expected |
| --- | --- | --- | --- | ---: |
| 1 | cart-service | `checkout_wave_cart_add` | `POST /api/sim/cart/add` | 200 |
| 2 | order-service | `checkout_wave_create` | `POST /api/sim/checkout` | 200 |
| 3 | order-service | `checkout_wave_confirm` | `POST /api/sim/orders/:id/confirm` | 200 |

Vì 3 calls/event, expected `http_reqs ≈ 3 × iterations` nếu không drop/interrupt.

## 5. Metrics cần đọc

```text
ramping_arrival_events_total       ~= iterations
ramping_arrival_api_calls_total    ~= http_reqs ~= 3×iterations
ramping_arrival_events_failed      = any step failed
ramping_arrival_event_duration_ms  = full cart+checkout+confirm duration
dropped_iterations                 = checkout arrival slots lost
```

## 6. Pass criteria

```text
checks > 0.99
http_req_failed < 0.01
dropped_iterations <= RAR_04_MAX_DROPPED
ramping_arrival_events_failed < 8
```

Default local validation:

```text
iterations=317
http_reqs=951
checks=100%
http failed=0%
dropped_iterations=0
p95≈54.64ms
```

## 7. Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-04-checkout-flash-sale-wave.js"
```

## 8. Dashboard reading

**Response time.** Đọc từng operation: cart add, checkout create, confirm. Nếu checkout/confirm p95 cao nhưng dropped=0, backend vẫn giữ được intake nhưng order-service tail cần theo dõi.

**Execution timeline.** `http_reqs` bucket phải khoảng 3× iterations bucket. `dropped_iterations=0` là điều kiện quan trọng hơn p95 đẹp.

**VUs vs iter/s.** Checkout event giữ VU lâu hơn feed/browse; VUs có thể cao dù peak chỉ 12/s. Đây là Little's Law: `VU ≈ lambda × W`.

**Executor tab.** Check `case_id=rar-04-checkout-flash-sale-wave`, pre/max VUs `25/80`, business case `checkout_wave_during_flash_sale`.

## 9. Output -> decision

| Output | Kết luận |
| --- | --- |
| dropped=0, checks 100%, http_reqs=3×iterations | Checkout wave pass |
| checkout_create/confirm slow | Order/payment/external path dominates |
| dropped ở peak | Multi-step duration vượt VU capacity |
| cart add fail | Cart write path issue, không blame order chung |

## 10. Real run — dashboard verification

Run verify qua local cloud/dashboard với default env:

```text
Run ID: #103
Script: rar-04-checkout-flash-sale-wave.js
Exit code: 0
summary_pushed: true
finish_status: 200
Target base: http://localhost:80
```

### Summary chính

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes/checks_fails` | `951 / 0` |
| `http_req_failed_rate` | `0` |
| `dropped_iterations` | `0` |
| `ramping_arrival_events_failed_rate` | `0` |
| `iterations` | `317` |
| `iterations_rate` | `5.89/s` |
| `http_reqs` | `951` |
| `http_reqs_rate` | `17.67/s` |
| `vus_max` | `1` |
| `ramping_arrival_event_duration_ms avg/med/p95/p99/max` | `87.71 / 87 / 108 / 117.84 / 127 ms` |
| `http_req_duration avg/med/p95/p99/max` | `29.02 / 34.14 / 54.92 / 57.81 / 85.13 ms` |

Request breakdown:

```text
checkout_wave_cart_add POST 200 count=317
checkout_wave_create POST 200 count=317
checkout_wave_confirm POST 200 count=317
```

### Dashboard series check

```text
iterations: points=54, sum=317, min=1, max=12, truncated=false
http_reqs: points=951, sum=951, min=1, max=1, truncated=false
dropped_iterations: points=0, truncated=false
vus: points=53, min=0, max=1, truncated=false
```

### Verdict

```text
PASS — default ramping-arrival-rate case giữ được arrival curve: checks sạch, HTTP failed 0%, dropped_iterations=0.
```

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-04-checkout-flash-sale-wave.js`
