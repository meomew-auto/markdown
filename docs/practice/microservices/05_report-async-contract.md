# ms-05 — Report service: async job API contract

## 1. Business scenario

Một batch export report: tạo job → poll status → download khi ready. Report service mô hình hóa async job pattern — không giống các service khác (sync request-response), nó dùng 202 Accepted + polling.

```text
Report export: create job → list jobs → poll status → download
```

## 2. Capability được test

Case này chứng minh:

- `GET /api/sim/report` trả về dashboard data (sync read);
- `POST /api/sim/report/jobs` tạo async job, trả về 202 Accepted + `job_id`;
- `GET /api/sim/report/jobs` liệt kê jobs;
- `GET /api/sim/report/jobs/:id` poll status;
- `GET /api/sim/report/jobs/:id/download` tải kết quả khi ready;
- `X-Upstream-Service: report-service` trên mọi response.

## 3. Script và executor

```text
Script: ../shared-iterations/si-06-report-export-batch.js
Executor: shared-iterations
Default VUs: 8
Default jobs: 80
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

## 4. Env knobs

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_06_VUS = "8"
$env:SI_06_JOBS = "80"
$env:SI_06_SLEEP_SECONDS = "0"
```

## 5. Flow chính

```text
Setup tạo 80 jobs

Mỗi job:
  1. GET /api/sim/report?cpu_ms=2&db_rows=4
     → Expect: 200, success=true, data (dashboard)

  2. POST /api/sim/report/jobs?cpu_ms=2&db_rows=2&ready_after_ms=10
     → Body: { report_type, context }
     → Expect: 202 Accepted, success=true, data.job_id

  3. GET /api/sim/report/jobs?limit=10&cpu_ms=1&db_rows=1
     → Expect: 200, success=true, data.jobs array

  4. GET /api/sim/report/jobs/{job_id}?cpu_ms=1&db_rows=1
     → Expect: 200, success=true, data.status

  5. GET /api/sim/report/jobs/{job_id}/download?cpu_ms=1
     → Expect: 200 hoặc 202 (nếu job chưa ready)
```

## 6. Evidence phải đọc

| Evidence | Expected |
| --- | --- |
| `checks` | 100% |
| `http_req_failed` | 0.00% |
| `shared_jobs_total` | 80 |
| `shared_jobs_failed` | 0 |
| `X-Upstream-Service` | `report-service` trên mọi response |
| Sync report GET | 200, `success: true` |
| Job create POST | **202 Accepted** (không phải 200) |
| Job status GET | 200, `data.status` cho biết trạng thái job |
| Job download GET | 200 hoặc 202 |

## 7. Report service — async pattern

Report service là service duy nhất dùng **202 Accepted** pattern:

```text
Sync endpoints (trả về ngay):
  GET /api/sim/report              — dashboard data

Async endpoints (job-based):
  POST /api/sim/report/jobs        — tạo job → 202 + job_id
  GET  /api/sim/report/jobs        — list jobs
  GET  /api/sim/report/jobs/:id    — poll status
  GET  /api/sim/report/jobs/:id/download — tải kết quả
```

Khác biệt chính:
- POST job trả về 202 (không phải 200) — người học dễ bị nhầm;
- Client phải poll hoặc chờ `ready_after_ms` rồi mới download;
- Job có lifecycle: `pending → processing → completed/failed`.

## 8. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| Job create trả về 200 thay vì 202 | Service không hiểu async pattern |
| Job ID rỗng | Không thể poll/download |
| Download luôn trả về 202 (không bao giờ ready) | Job không complete — `ready_after_ms` quá dài hoặc bug |
| Sync report trả về 202 | Sai contract — sync read phải là 200 |
| `X-Upstream-Service` không phải `report-service` | Routing sai |

## 9. Dashboard/chart reading

Chart nên đọc:

- `shared_jobs_total` = 80, `shared_jobs_failed` = 0;
- checks rate 100%;
- Status code distribution: ~20% 202 (job create), ~80% 200 (còn lại);
- `X-Upstream-Service` = `report-service` 100%;
- Latency: job create có `ready_after_ms=10` nên có thể chậm hơn sync read.

## 10. Production lesson

Async job pattern là microservices pattern quan trọng: không phải operation nào cũng nên là sync. Report export, data import, batch processing — tất cả nên dùng 202 + polling thay vì giữ connection mở. Case này dạy cách verify contract cho async pattern: status code đúng (202 không phải 200), job ID usable, và job thật sự complete sau thời gian expected.
