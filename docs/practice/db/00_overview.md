# Postgres / Database Layer — Overview

## 1. Vị trí trong lộ trình

```text
CDN → LB → Microservices → Redis → Postgres/DB → External → Resource
```

Sau khi đã xác nhận request đến đúng service (Microservices layer) và state dùng chung nhất quán (Redis layer), câu hỏi tiếp theo là:

```text
Database có chịu được delay, pressure, fault không?
Service có recover sau khi DB được reset không?
Pool contention có observable qua trace không?
db_rows/db_writes input có khớp với resource_model output không?
Hệ thống chịu được bao nhiêu DB read traffic trước khi drop iteration?
```

## 2. Mental model

```text
k6/client
  → http://localhost:80 (Nginx)
  → order-service / products-service / report-service
  → Postgres (shared persistent store)
  → Control plane: /ops/order/db/profile, /ops/order/db/reset
```

Khác với Redis (cache/state — mất được), Postgres là **persistent store** — mọi order, product, report đều được lưu vĩnh viễn. DB layer test tính **chịu đựng** (resilience) và **phục hồi** (recovery) của dependency này.

## 3. DB khác gì Redis?

| Khía cạnh | Redis layer | Postgres/DB layer |
| --- | --- | --- |
| Vai trò | Cache/state tạm (TTL) | Persistent store vĩnh viễn |
| Câu hỏi | Idempotency, claim, hotkey có đúng không? | Delay/pressure/fault có được handle và recover không? |
| Control plane | `/ops/order/redis/profile` | `/ops/order/db/profile`, `/ops/order/db/reset` |
| Evidence | fresh/reuse counters, claim takeover | `db_ms`, `db_write_ms`, pool stats, resource_model |
| Failure mode | Duplicate side effect | 5xx transient, pool exhaustion, slow queries |

## 4. 6 capability proofs

| Case | Capability | Control plane? | Câu hỏi |
| --- | --- | --- | --- |
| db-01 | DB delay recovery | Có | DB bị delay → latency tăng → reset → recover? |
| db-02 | DB pressure recovery | Có | Pool bị ép → service degraded → reset → recover? |
| db-03 | DB fault recovery | Có | DB fault mode → 5xx intentional → reset → 200 OK? |
| db-04 | Pool contention | Có | Contention → trace correlation → recovered success? |
| db-05 | Resource model correctness | Không | db_rows/db_writes input khớp với performance breakdown? |
| db-06 | Capacity sweep | Không | Bao nhiêu DB read traffic trước khi drop iteration? |

## 5. Evidence model

DB layer dựa vào **performance payload** trong mỗi response:

```json
{
  "success": true,
  "data": { ... },
  "performance": {
    "breakdown": {
      "cpu_ms": 2,
      "db_ms": 45,
      "db_write_ms": 12,
      "external_ms": 0
    },
    "resource_model": {
      "db_rows": 60,
      "db_writes": 6,
      "db_round_trips": 1
    }
  }
}
```

Khác với CDN (`X-Cache`), LB (upstream selection), Microservices (`X-Upstream-Service`), Redis (custom counters) — DB layer evidence nằm trong **response body**.

## 6. Control plane

4/6 cases yêu cầu `OPS_AUTH_TOKEN` để gọi control plane:

```text
PUT  /ops/order/db/profile  — inject delay, pressure, hoặc fault mode
POST /ops/order/db/reset    — reset về trạng thái bình thường
GET  /ops/order/db/profile  — đọc current DB profile
```

Case db-05 và db-06 không cần control plane — chúng verify DB behavior thông qua API call thông thường.

## 7. 5xx intentional — không phải fail

db-03 (fault recovery) và db-04 (pool contention) có **5xx intentional** trong fault/degraded window. Đây là expected behavior:

```text
db-03: Trong fault window, DB bị tcp_reset → 5xx là đúng → service phải recover sau reset
db-04: Trong degrade window, pool bị ép → 5xx transient được phép → recovered success sau recover
```

**Không dùng `http_req_failed` để kết luận fail** cho db-03 và db-04. Dùng custom counters: `faultCheckFailures`, `contentionRecoveredSuccess`, `degradedObserved`.

## 8. Learning order

```text
db-05 (resource model) → db-01 (delay) → db-02 (pressure) → db-03 (fault) → db-04 (contention) → db-06 (capacity sweep)
```

- **db-05 trước**: Hiểu `db_ms`/`db_write_ms`/`resource_model` trước khi test các case khác.
- **db-01 → db-02 → db-03**: Tăng dần độ nghiêm trọng: delay → pressure → fault.
- **db-04**: Contention test — cần hiểu pool behavior từ db-02.
- **db-06**: Sweep — tổng hợp tất cả knowledge để đọc capacity.

## 9. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| `db_ms` không thay đổi sau khi inject delay | Control plane không hoạt động hoặc DB không bị ảnh hưởng |
| Fault window không có 5xx | Fault mode không được áp dụng |
| Sau reset mà vẫn 5xx | Recovery fail — DB chưa được reset đúng |
| `resource_model.db_rows` không khớp query param | Contract violation — không thể tin tưởng DB metrics |
| `dropped_iterations = 0` dù rate cao | Hoặc hệ thống quá mạnh, hoặc VU pool quá lớn — cần sweep rộng hơn |
| `http_req_failed > 0` trong db-05 | Không expected — DB read/write contract phải luôn 200 |

## 10. Production lesson

Database là persistent store — nếu sai, data mất vĩnh viễn. Nhưng DB cũng là dependency có thể bị chậm, quá tải, hoặc lỗi. Layer này dạy:

- Cách **inject** DB degradation có kiểm soát (delay, pressure, fault)
- Cách **đọc** evidence từ performance payload (`db_ms`, `db_write_ms`, `resource_model`)
- Cách **phân biệt** giữa fail thật và 5xx expected trong fault window
- Cách **xác nhận recovery** sau khi reset DB profile
- Cách **sweep** để tìm capacity limit của DB read path
