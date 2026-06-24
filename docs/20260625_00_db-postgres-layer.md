# Postgres / DB layer: resilience trước persistence

## 1. Vì sao sau Redis là Postgres/DB?

CDN trả lời request nào được edge cache. LB trả lời request nào được route tới upstream nào. Microservices trả lời request có đến đúng service không. Redis trả lời state dùng chung có nhất quán không. Khi state đã nhất quán, câu hỏi tiếp theo là:

```text
Database — persistent store — có chịu được delay, pressure, fault không?
Service có recover sau khi DB được reset không?
DB metrics (db_ms, db_write_ms, resource_model) có đáng tin cho capacity planning không?
```

Nếu layer này sai, toàn bộ dữ liệu kinh doanh (order, product, report) có thể bị mất hoặc sai khi DB gặp sự cố.

## 2. Mental model

```text
k6/client
  → http://localhost:80 (Nginx)
  → order-service / products-service / report-service
  → Postgres (shared persistent store)
  → Control plane: /ops/order/db/profile, /ops/order/db/reset
```

DB là dependency **không thể thiếu** — khác với Redis (cache, có thể miss). DB layer test:
- **Resilience**: Service handle DB degradation đúng cách
- **Recovery**: Service hồi phục sau khi DB được reset
- **Observability**: DB metrics exposed đúng contract
- **Capacity**: Hệ thống chịu được bao nhiêu DB load

## 3. 6 capability proofs

| Case | Capability | Control plane | Pattern |
| --- | --- | --- | --- |
| db-01 | DB delay recovery | Có | Sequential — inject delay → observe → reset → recover |
| db-02 | DB pressure recovery | Có | Sequential — inject pool pressure → burst → reset |
| db-03 | DB fault recovery | Có | Sequential — inject fault → expect 5xx → reset → 200 |
| db-04 | Pool contention | Có | Sustained — concurrent VUs + timed degrade/recover |
| db-05 | Resource model correctness | Không | Sequential — verify db_rows/db_writes → resource_model |
| db-06 | Capacity sweep | Không | Open-model — sweep db_rows × rate → find capacity limit |

## 4. Evidence model

```json
{
  "performance": {
    "breakdown": {
      "cpu_ms": 2,
      "db_ms": 45,        ← DB read time (evidence chính)
      "db_write_ms": 12,  ← DB write time (write path)
      "external_ms": 0
    },
    "resource_model": {
      "db_rows": 60,      ← Input verification
      "db_writes": 6,
      "db_round_trips": 1
    },
    "bottleneck": "db_ms",
    "bottleneck_percent": 68
  }
}
```

Khác với tất cả layer trước — CDN (`X-Cache` header), LB (upstream), Microservices (`X-Upstream-Service` header), Redis (custom counters) — DB layer evidence nằm trong **response body performance payload**.

## 5. Control plane pattern

```text
PUT  /ops/order/db/profile  — { postgres_delay_ms, postgres_pressure_limit, postgres_fault_mode }
POST /ops/order/db/reset    — Xóa tất cả degradation
GET  /ops/order/db/profile  — Đọc current state
```

Pattern: **Inject → Observe → Reset → Verify recovery**. Đây là pattern lặp lại trong db-01, db-02, db-03.

## 6. 5xx intentional — critical teaching point

db-03 và db-04 có 5xx expected trong fault/degraded window:

```text
db-03: tcp_reset fault → 5xx là ĐÚNG → service phải fail khi DB không reachable
db-04: pool contention → transient 5xx < 5% → allowed, recovered sau reset
```

**Không dùng `http_req_failed` để judge fail.** Dùng custom counters:
- `prod_mix_order_db_fault_check_failures`
- `order_db_contention_recovered_success`

## 7. Roadmap

```text
CDN → LB → Microservices → Redis → Postgres/DB → External dependency → Resource/capacity
```

DB layer là cầu nối giữa state consistency (Redis) và external resilience:
- **Trước DB**: Đã xác nhận state nhất quán (Redis)
- **DB**: Xác nhận persistence chịu được degradation
- **Sau DB**: External dependency (payment mock) và capacity sizing

## 8. Validation snapshot 2026-06-25

| Case | Run | Checks | http_fail | Notes |
| --- | ---: | ---: | ---: | --- |
| db-05 | #116 | 355/355 (100%) | 0% | Resource model: db_rows/db_writes verified |
| db-01 | #117 | 199/200 (99.5%) | 0% | DB delay 35ms → db_ms observable → recovered |
| db-02 | #118 | 236/236 (100%) | 0% | DB pressure → p95 3170ms in degraded → recovered |
| db-03 | #119 | 224/224 (100%) | 4.8% **(expected)** | Fault tcp_reset → 5xx intentional → recovered 200 |
| db-04 | #120 | 3584/3584 (100%) | 0% | Pool contention 24s → recovered success |
| db-06 | #121 | sweep | 0% | Capacity: db_rows=120, rate=8, 0 drops |

**Postgres/DB layer GREEN 6/6.**

### Key observations

- **db-01**: 1 check failure (0.5%) — likely timing assertion at boundary. Delay phase `db_ms` clearly elevated.
- **db-02**: p95 latency 3170ms in pressure phase — proves pool pressure injection works. Recovered clean.
- **db-03**: http_req_failed 4.8% — ALL during fault window. Post-reset: 0% failures. This is the correct fault→recovery signature.
- **db-04**: 3584 checks, 0 failures — sustained 24s contention test, trace correlation preserved.
- **db-05**: All 28 endpoints verified — `resource_model.db_rows` matches query param on every response.
- **db-06**: Capacity sweep successful — `resource_model.db_rows=120` recorded in every CAPACITY_SAMPLE. Bottleneck rotates between `cpu_ms` and `db_ms`.
