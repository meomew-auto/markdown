# Case 06: Cache/Feed Wave

> **Script:** `rar-06-cache-feed-wave.js`  
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 36 arrivals/s  
> **Focus:** personalized homefeed + recommendations read-heavy wave.

## 1. Tình huống thực tế

Users mở app, homefeed/recommendations tăng mạnh theo engagement wave. Đây là read-heavy path, peak cao nhất suite nhưng event nhanh nên VU demand vẫn thấp nếu backend/cache ổn.

```text
startRate = 4/s
15s -> 12/s  normal feed traffic
20s -> 36/s  feed peak
15s -> 8/s   recovery
5s  -> 0/s   drain
```

Business question:

```text
Products/feed path có giữ được 36 arrivals/s ở peak mà không drop/fail không?
```

## 2. Vì sao dùng `ramping-arrival-rate`?

Feed traffic là external engagement stream; app opens và scrolls đến theo thời gian. Mục tiêu là giữ ingress curve, không phải giữ một số active VUs.

## 3. Config mapping

| Tham số | Default | Ý nghĩa |
| --- | ---: | --- |
| `RAR_06_START_RATE` | 4 | rate đầu run |
| `RAR_06_NORMAL_RATE` | 12 | normal traffic |
| `RAR_06_FEED_RATE` | 36 | feed peak |
| `RAR_06_RECOVERY_RATE` | 8 | recovery traffic |
| `RAR_06_DURATION_SCALE` | 1 | scale stage duration |
| `RAR_06_PREALLOCATED_VUS` | 18 | worker warm sẵn |
| `RAR_06_MAX_VUS` | 60 | worker ceiling |
| `RAR_06_MAX_DROPPED` | 5 | drop budget |
| `RAR_06_USER_POOL` | 1000 | user identity pool |

Scheduled slots mặc định:

```text
15×(4+12)/2  = 120
20×(12+36)/2 = 480
15×(36+8)/2  = 330
5×(8+0)/2    = 20
total         = 950 arrivals
```

## 4. Service/API flow

| Branch | Weight | Operation | Endpoint |
| --- | ---: | --- | --- |
| Homefeed | 70% | `feed_wave_homefeed` | `GET /api/sim/products/homefeed` |
| Recommendations | 30% | `feed_wave_recommendations` | `GET /api/sim/products/:id/recommendations` |

1 call/event, products-service only.

## 5. Metrics cần đọc

```text
ramping_arrival_events_total       ~= iterations
ramping_arrival_api_calls_total    ~= http_reqs ~= iterations
ramping_arrival_events_failed      = feed/recommendations failures
dropped_iterations                 = feed arrival slots lost
ramping_arrival_event_duration_ms  = read event duration
```

## 6. Pass criteria

```text
checks > 0.98
http_req_failed < 0.02
dropped_iterations <= RAR_06_MAX_DROPPED
ramping_arrival_events_failed < 20
```

Default local validation:

```text
iterations=949
http_reqs=949
checks=100%
http failed=0%
dropped_iterations=0
p95≈3.76ms
```

## 7. Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-06-cache-feed-wave.js"
```

## 8. Dashboard reading

**Response time.** Homefeed/recommendations p95 phải thấp. Nếu recommendations p99 dominates, personalization path cần điều tra.

**Execution timeline.** Iterations/http_reqs bucket theo 4 -> 12 -> 36 -> 8/s; `http_reqs == iterations`.

**VUs vs iter/s.** Đây là case dạy Little's Law: peak cao không nhất thiết cần nhiều VUs nếu W_effective rất thấp. VUs thấp + dropped=0 là healthy.

**Executor tab.** Check `case_id=rar-06-cache-feed-wave`, `business_case=personalized_feed_ramping_ingress`.

## 9. Output -> decision

| Output | Kết luận |
| --- | --- |
| dropped=0, p95 thấp | Feed wave pass, backend/cache ổn |
| recommendations latency dominates | Personalization/recommendations path cần xem |
| dropped ở peak với latency thấp | Có thể preAllocated/spawn issue |
| dropped + latency tăng | Backend/cache miss tạo VU pressure |

## 10. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-06-cache-feed-wave.js`
