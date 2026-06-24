# ms-07 — Service health and real dependency status

## 1. Business scenario

Trước khi chạy bất kỳ test nào, cần xác nhận tất cả services và dependencies đều healthy. Mỗi microservice có `/health` endpoint báo cáo trạng thái của chính nó và các dependency (Postgres, Redis, payment URL). App-level dependency endpoint aggregate tất cả.

```text
Health check: app → từng service → từng dependency
```

Đây là case đầu tiên nên chạy trong mọi incident — nếu dependency down, service degraded dù business endpoint vẫn trả 200.

## 2. Capability được test

Case này chứng minh:

- App dependency endpoint trả về trạng thái từng dependency;
- Redis status = "up";
- Postgres status = "up";
- Không có dependency nào degraded;
- Service-level `/health` endpoints đều trả về 200;
- Health check phản ánh đúng thực tế (không phải static "ok").

## 3. Script và executor

```text
Script: ../app/01-dependency-smoke.js
Executor: constant-vus
Default VUs: 2
Default duration: 24s
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

Case này dùng constant-vus với low VUs để sustained health probe — không cần nhiều traffic, chỉ cần đủ để xác nhận health ổn định theo thời gian.

## 4. Env knobs

```powershell
$env:BASE_URL = "http://localhost:80"
$env:APP_DEPS_EXPECTATION = "healthy"
$env:APP_DEPS_VUS = "2"
$env:APP_DEPS_DURATION = "24s"
$env:APP_DEPS_SLEEP_SECONDS = "0.2"
```

`APP_DEPS_EXPECTATION` có các mode khác:

```text
healthy            — tất cả dependencies up
redis_down         — Redis down, Postgres up
postgres_down      — Postgres down, Redis up
redis_slow         — Redis chậm nhưng up
postgres_slow      — Postgres chậm nhưng up
redis_timeout      — Redis timeout
postgres_timeout   — Postgres timeout
redis_exhausted    — Redis hết connection
postgres_exhausted — Postgres hết connection
redis_network_fault — Redis network fault
postgres_network_fault — Postgres network fault
```

## 5. Flow chính

```text
Runtime loop (2 VUs, 24s, sleep 0.2s giữa các iteration):

Mỗi iteration:
  1. GET /ops/app/health/dependencies
     → Expect: 200, JSON với trạng thái từng dependency

  2. Verify:
     - Redis status = "up"
     - Postgres status = "up"
     - Tất cả dependencies expected healthy
```

Health check probe không gọi business endpoint — nó gọi thẳng health endpoint để tránh side effect.

## 6. Evidence phải đọc

| Evidence | Expected |
| --- | --- |
| `checks` | 100% |
| `app_deps_check_failures` | 0 |
| `app_deps_degraded_observed` | 0 |
| Redis status | `up` |
| Postgres status | `up` |
| Từng service `/health` | 200 OK |

## 7. Từng service health endpoint

Mỗi service có `/health` endpoint riêng. Khác biệt giữa các service:

| Service | Health dependencies |
| --- | --- |
| auth-service | Chỉ Postgres |
| products-service | Chỉ Postgres |
| cart-service | Chỉ Postgres |
| order-service | Postgres + payment-mock (HTTP) |
| report-service | Chỉ Postgres |

Order service là service duy nhất có external HTTP dependency (payment-mock). Nếu payment-mock down, order-service health báo degraded, nhưng các service khác vẫn healthy.

## 8. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| `app_deps_degraded_observed > 0` | Có dependency không healthy |
| Redis/PG status = "down" trong healthy mode | Infrastructure problem |
| Health check pass nhưng business endpoint fail | Health check không phản ánh đúng thực tế |
| Checks < 100% | Một số probe fail |
| Health báo "up" nhưng latency rất cao | Dependency degraded nhưng chưa down |

## 9. Dashboard/chart reading

Chart nên đọc:

- checks rate 100% suốt 24s;
- `app_deps_check_failures` = 0;
- `app_deps_degraded_observed` = 0%;
- `app_deps_cache_duration` và `app_deps_db_duration` trends — baseline latency.

Đây là case nhẹ nhất (2 VUs, sleep 0.2s) — không có áp lực. Nếu health check đã fail ở mức này, đừng chạy bất kỳ case nào khác.

## 10. Production lesson

Health check là thứ đầu tiên orchestrator (K8s, Docker Compose, load balancer) dùng để quyết định service có ready không. Một health check sai (báo "up" khi dependency down) sẽ dẫn đến traffic bị route đến service không hoạt động được. Case này dạy:

- Cách đọc health check có dependency awareness;
- Cách phân biệt "process alive" vs "service healthy";
- Cách dùng health check làm baseline trước khi test bất kỳ case nào khác.

Trong incident, đây luôn là case đầu tiên: xác nhận dependency state trước khi debug business logic.
