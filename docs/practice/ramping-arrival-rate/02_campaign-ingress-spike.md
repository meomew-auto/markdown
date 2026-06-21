# Case 02: Login Burst Recovery

> **Script:** `rar-02-login-burst-recovery.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 24 arrivals/s
> **Focus:** auth login/me/refresh wave sau notification hoặc app-open burst.

## 1. Tình huống thực tế

Một notification hoặc app-open wave làm nhiều user đồng loạt chạm auth service: login, đọc `/me`, refresh token. Traffic tăng theo burst rồi recovery, không phải fixed user pool.

```text
startRate = 1/s
15s -> 6/s   pre-burst
15s -> 24/s  burst peak
15s -> 5/s   recovery
5s  -> 0/s   drain
```

Business question:

```text
Auth service có hấp thụ login burst 1 -> 6 -> 24 -> 5/s mà không fail/drop không?
```

## 2. Vì sao dùng `ramping-arrival-rate`?

Auth ingress bị producer bên ngoài quyết định: mobile app, notification, gateway retry. Backend chậm không được làm “giảm số người đang cố login”; nếu thiếu capacity, `dropped_iterations` mới là tín hiệu mất arrival slot.

## 3. Config mapping

| Tham số | Default | Ý nghĩa |
| --- | ---: | --- |
| `RAR_02_START_RATE` | 1 | rate đầu run |
| `RAR_02_PRE_RATE` | 6 | pre-burst traffic |
| `RAR_02_BURST_RATE` | 24 | burst peak |
| `RAR_02_RECOVERY_RATE` | 5 | recovery traffic |
| `RAR_02_DURATION_SCALE` | 1 | scale stage duration |
| `RAR_02_PREALLOCATED_VUS` | 16 | worker warm sẵn |
| `RAR_02_MAX_VUS` | 50 | worker ceiling |
| `RAR_02_MAX_DROPPED` | 3 | drop budget |
| `RAR_02_USER_POOL` | 600 | business identities |

Scheduled slots mặc định:

```text
15×(1+6)/2  = 52.5
15×(6+24)/2 = 225
15×(24+5)/2 = 217.5
5×(5+0)/2   = 12.5
total        ≈ 507.5 arrivals
```

## 4. Service/API flow

| Branch | Weight | Operation | Endpoint |
| --- | ---: | --- | --- |
| Login | 60% | `login_burst_login` | `POST /api/sim/auth/login` |
| Me | 25% | `login_burst_me` | `GET /api/sim/auth/me` |
| Refresh | 15% | `login_burst_refresh` | `POST /api/sim/auth/refresh` |

`GET /me` dùng `Authorization: Bearer <userId>`; mọi request gửi `X-User-ID` từ helper.

## 5. Metrics cần đọc

```text
ramping_arrival_events_total       ~= iterations
ramping_arrival_api_calls_total    ~= http_reqs ~= iterations
ramping_arrival_events_failed      = auth flow failures
dropped_iterations                 = auth arrival slot lost
ramping_arrival_event_duration_ms  = full auth event duration
```

## 6. Pass criteria

```text
checks > 0.99
http_req_failed < 0.01
dropped_iterations <= RAR_02_MAX_DROPPED
ramping_arrival_events_failed < 10
```

Default local validation:

```text
iterations=507
http_reqs=507
checks=100%
http failed=0%
dropped_iterations=0
p95≈23.23ms
```

## 7. Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-login-burst-recovery.js"
```

## 8. Dashboard reading

**Response time.** So `login_burst_login`, `login_burst_me`, `login_burst_refresh`; login/refresh là write-ish path nên cần nhìn p95/p99 riêng.

**Execution timeline.** Iter/s phải tăng mạnh ở burst stage và recover về 5/s; dropped phải bằng 0 ở default.

**VUs vs iter/s.** VUs tăng ở burst là bình thường. Nếu `dropped_iterations` xuất hiện ngay đầu burst trong khi maxVUs còn dư, tăng `RAR_02_PREALLOCATED_VUS` để tránh spawn delay.

**Executor tab.** Check `case_id=rar-02-login-burst-recovery` và `business_case=login_burst_after_notification`.

## 9. Output -> decision

| Output | Kết luận |
| --- | --- |
| dropped=0, checks 100% | Auth burst contract pass |
| login fail/status mismatch | Báo auth login endpoint |
| refresh p95/p99 dominate | Điều tra session/refresh write path |
| dropped ở burst only | Burst capacity/preAllocated cần tăng |

## 10. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-login-burst-recovery.js`
