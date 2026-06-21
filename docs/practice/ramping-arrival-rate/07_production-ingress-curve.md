# Case 07: Production Spike Mix

> **Script:** `rar-07-production-spike-mix.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 32 arrivals/s
> **Focus:** mixed production API spike across products/cart/auth/order/report.

## 1. Tình huống thực tế

Production spike hiếm khi chỉ đánh một endpoint. Một campaign/app event tạo mixed API ingress: browse, detail, cart, auth, checkout, report. Tất cả branch dùng chung VU pool của scenario; slow branch có thể giữ worker lâu và tạo pressure cho branch khác.

```text
startRate = 3/s
20s -> 12/s  baseline ramp
20s -> 32/s  spike peak
20s -> 10/s  recovery
5s  -> 0/s   drain
```

Business question:

```text
Toàn hệ thống có giữ được mixed production spike 3 -> 12 -> 32 -> 10/s mà không drop/fail không?
```

## 2. Vì sao dùng `ramping-arrival-rate`?

Đây là broad open-model baseline: arrival mix đến từ production traffic, không phải từ một fixed active user pool. Backend chậm ở một branch không làm ingress tự giảm; nó làm VU demand tăng và có thể gây dropped slots.

## 3. Config mapping

| Tham số | Default | Ý nghĩa |
| --- | ---: | --- |
| `RAR_07_START_RATE` | 3 | rate đầu run |
| `RAR_07_BASELINE_RATE` | 12 | baseline ramp |
| `RAR_07_SPIKE_RATE` | 32 | production spike peak |
| `RAR_07_RECOVERY_RATE` | 10 | recovery traffic |
| `RAR_07_DURATION_SCALE` | 1 | scale stage duration |
| `RAR_07_PREALLOCATED_VUS` | 30 | worker warm sẵn |
| `RAR_07_MAX_VUS` | 90 | worker ceiling |
| `RAR_07_MAX_DROPPED` | 8 | drop budget |
| `RAR_07_USER_POOL` | 1200 | business identity pool |

Scheduled slots mặc định:

```text
20×(3+12)/2  = 150
20×(12+32)/2 = 440
20×(32+10)/2 = 420
5×(10+0)/2   = 25
total         = 1,035 arrivals
```

## 4. Service/API flow

| Branch | Weight | Service | Operation | Endpoint |
| --- | ---: | --- | --- | --- |
| Browse | 35% | products-service | `production_spike_browse` | `GET /api/sim/products` |
| Detail | 20% | products-service | `production_spike_detail` | `GET /api/sim/products/:id` |
| Cart | 18% | cart-service | `production_spike_cart_add` | `POST /api/sim/cart/add` |
| Auth | 12% | auth-service | `production_spike_auth_me` | `GET /api/sim/auth/me` |
| Checkout | 10% | order-service | `production_spike_checkout` | `POST /api/sim/checkout` |
| Report | 5% | report-service | `production_spike_report` | `GET /api/sim/report` |

1 call/event. Event-level `finishEvent()` service tag is `mixed`; use request breakdown to identify branch/service bottlenecks.

## 5. Metrics cần đọc

```text
ramping_arrival_events_total       ~= iterations
ramping_arrival_api_calls_total    ~= http_reqs ~= iterations
ramping_arrival_events_failed      = mixed branch failures
dropped_iterations                 = production arrivals lost
ramping_arrival_event_duration_ms  = branch duration across mixed operations
```

## 6. Pass criteria

```text
checks > 0.98
http_req_failed < 0.02
dropped_iterations <= RAR_07_MAX_DROPPED
ramping_arrival_events_failed < 25
```

Default local validation:

```text
iterations=1,035
http_reqs=1,035
checks=100%
http failed=0%
dropped_iterations=0
p95≈70.04ms
```

## 7. Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-07-production-spike-mix.js"
```

## 8. Dashboard reading

**Response time.** Group by `service`/`operation`. Event-level trend shows mixed operation duration, but request breakdown tells which service branch dominates p95/p99.

**Execution timeline.** Iterations/http_reqs bucket should follow 3 -> 12 -> 32 -> 10/s. `http_reqs == iterations` because each branch has one API call.

**VUs vs iter/s.** Mixed branches share VU pool. Checkout/report tail can increase VU pressure for all branches — a noisy-neighbor effect inside one open-model scenario.

**Executor tab.** Check `case_id=rar-07-production-spike-mix`, `business_case=production_spike_mixed_api_ingress`, pre/max VUs `30/90`.

## 9. Output -> decision

| Output | Kết luận |
| --- | --- |
| dropped=0, checks 100%, no dominant tail | Production spike baseline pass |
| one operation p95/p99 dominates | Route investigation to that service, not whole backend |
| dropped at peak with checkout/report slow | Slow branch is consuming shared worker capacity |
| auth/order failures | Report exact operation/status counts |

## 10. Real run — dashboard verification

Run verify qua local cloud/dashboard với default env:

```text
Run ID: #106
Script: rar-07-production-spike-mix.js
Exit code: 0
summary_pushed: true
finish_status: 200
Target base: http://localhost:80
```

### Summary chính

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes/checks_fails` | `1,034 / 0` |
| `http_req_failed_rate` | `0` |
| `dropped_iterations` | `0` |
| `ramping_arrival_events_failed_rate` | `0` |
| `iterations` | `1,034` |
| `iterations_rate` | `15.91/s` |
| `http_reqs` | `1,034` |
| `http_reqs_rate` | `15.91/s` |
| `vus_max` | `5` |
| `ramping_arrival_event_duration_ms avg/med/p95/p99/max` | `45.17 / 3 / 80.60 / 943.05 / 1,005 ms` |
| `http_req_duration avg/med/p95/p99/max` | `45.07 / 3.10 / 80.34 / 943.18 / 1,005.32 ms` |

Request breakdown:

```text
production_spike_browse GET 200 count=384
production_spike_detail GET 200 count=200
production_spike_cart_add POST 200 count=180
production_spike_auth_me GET 200 count=120
production_spike_checkout POST 200 count=100
production_spike_report GET 200 count=50
```

### Dashboard series check

```text
iterations: points=65, sum=1,034, min=1, max=35, truncated=false
http_reqs: points=1034, sum=1,034, min=1, max=1, truncated=false
dropped_iterations: points=0, truncated=false
vus: points=65, min=0, max=5, truncated=false
```

### Verdict

```text
PASS — default ramping-arrival-rate case giữ được arrival curve: checks sạch, HTTP failed 0%, dropped_iterations=0.
```

## 11. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-07-production-spike-mix.js`
