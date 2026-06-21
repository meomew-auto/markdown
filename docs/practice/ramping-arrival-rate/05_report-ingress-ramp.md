# Case 05: Report Job Ingress Ramp

> **Script:** `rar-05-report-job-ingress-ramp.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 8 arrivals/s
> **Focus:** report dashboard reads + async job create/status, default target `http://localhost:8088`.

## 1. Tình huống thực tế

Backoffice users mở dashboard báo cáo và tạo report jobs theo ramp đầu giờ. Một phần traffic là async job: create job, wait readiness, poll status. Trong open model, thời gian wait vẫn giữ VU bận và làm tăng VU demand.

```text
startRate = 1/s
15s -> 3/s  normal dashboard/report traffic
20s -> 8/s  job ingress peak
15s -> 2/s  cooldown
5s  -> 0/s  drain
```

Business question:

```text
Report service có giữ được report ingress ramp 1 -> 3 -> 8 -> 2/s với drop budget bằng 0 không?
```

## 2. Vì sao dùng `ramping-arrival-rate`?

Report job submissions là ingress stream. Nếu async path chậm, k6 cần nhiều VUs hơn để giữ schedule; nếu không đủ, `dropped_iterations` tăng. Đó chính là tín hiệu cần đo.

## 3. Config mapping

| Tham số | Default | Ý nghĩa |
| --- | ---: | --- |
| `RAR_05_BASE_URL` | `http://localhost:8088` | report API target riêng |
| `RAR_05_START_RATE` | 1 | rate đầu run |
| `RAR_05_NORMAL_RATE` | 3 | dashboard normal traffic |
| `RAR_05_JOB_RATE` | 8 | job ingress peak |
| `RAR_05_COOLDOWN_RATE` | 2 | cooldown traffic |
| `RAR_05_DURATION_SCALE` | 1 | scale stage duration |
| `RAR_05_PREALLOCATED_VUS` | 25 | worker warm sẵn |
| `RAR_05_MAX_VUS` | 80 | worker ceiling |
| `RAR_05_READY_AFTER_MS` | 120 | wait trước status poll |
| `RAR_05_MAX_DROPPED` | 0 | zero-drop budget |
| `RAR_05_USER_POOL` | 300 | user identity pool |

Scheduled slots mặc định:

```text
15×(1+3)/2 = 30
20×(3+8)/2 = 110
15×(8+2)/2 = 75
5×(2+0)/2  = 5
total       = 220 arrivals
```

## 4. Service/API flow

Weighted mix:

| Branch | Weight | Calls | Expected |
| --- | ---: | --- | --- |
| Dashboard | 60% | `GET /api/sim/report` | 200 |
| Async job | 40% | `POST /api/sim/report/jobs` then wait then `GET /api/sim/report/jobs/:id` | 202 then 200 |

Expected `http_reqs` không bằng `iterations`: dashboard branch có 1 call, async branch có 2 calls.

## 5. Metrics cần đọc

```text
ramping_arrival_events_total       ~= iterations
ramping_arrival_api_calls_total    ~= http_reqs, expected > iterations
ramping_arrival_events_failed      = dashboard/create/status failure
dropped_iterations                 = zero-budget signal
ramping_arrival_event_duration_ms  = includes wait((READY_AFTER_MS+20)/1000)
```

## 6. Pass criteria

```text
checks > 0.99
http_req_failed < 0.01
dropped_iterations <= 0
ramping_arrival_events_failed < 5
```

Default local validation:

```text
iterations=219
http_reqs=299
checks=100%
http failed=0%
dropped_iterations=0
p95≈22.98ms
```

## 7. Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:RAR_05_BASE_URL = "http://localhost:8088"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-job-ingress-ramp.js"
```

Nếu muốn ép chạy qua load target chung:

```powershell
$env:RAR_05_BASE_URL = "http://localhost:80"
```

Nhưng default của case này là report target `8088`.

## 8. Dashboard reading

**Response time.** Tách `report_job_ramp_dashboard`, `report_job_ramp_create`, `report_job_ramp_status`. Event trend mới phản ánh full async flow vì có wait giữa create và status.

**Execution timeline.** `http_reqs` lớn hơn `iterations`; đối chiếu mix dashboard/async. Với `MAX_DROPPED=0`, chỉ cần 1 drop là không đạt default contract.

**VUs vs iter/s.** Async wait giữ VU bận; VUs có thể cao hơn trực giác dù peak chỉ 8/s.

**Executor tab.** Check `case_id=rar-05-report-job-ingress-ramp`, `business_case=report_job_ingress_ramp`, base URL/env đã đúng.

## 9. Output -> decision

| Output | Kết luận |
| --- | --- |
| dropped=0, checks 100% | Report ingress ramp pass |
| dropped>0 | Không đạt zero-drop contract; xem event duration và VU pressure |
| create 202 fail | Report job create contract issue |
| status 200 fail | Report job status path issue |
| connection refused | Sai target/stack cho `RAR_05_BASE_URL` |

## 10. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-job-ingress-ramp.js`
