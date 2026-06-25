# External Dependency Layer — Overview

## 1. Vị trí trong lộ trình

```text
CDN → LB → Microservices → Redis → Postgres/DB → External → Resource
```

Sau khi đã xác nhận DB chịu được degradation (Postgres layer), câu hỏi tiếp theo là:

```text
Service phụ thuộc vào external systems (payment gateway, webhook provider, event source) —
có handle được slow, fail, retry, duplicate, out-of-order events không?
```

Trong production, bạn không sở hữu payment gateway. Bạn không control được webhook delivery order. Bạn không quản lý được catalog event source. Nhưng service của bạn **phải** handle tất cả những edge case này.

## 2. Mental model

```text
k6/client
  → http://localhost:80 (Nginx)
  → order-service / app
  → payment-mock (external payment gateway)
  → catalog-events-mock (external event source)
  → Varnish CDN (chỉ ext-07 — observable effect nằm ở cache)
```

### 2.1 payment-mock — mô phỏng payment gateway thật

```text
Checkout → gọi payment-mock (HTTP)
  - Healthy:   200 OK, payment_mode=http, payment_code=200
  - Slow:      200 OK, external_ms cao, bottleneck=external_ms
  - Down:      502, dependency down
  - Circuit:   Sau N lần fail → circuit OPEN → short-circuit (không gọi external)
               Sau timeout → HALF-OPEN → test request → CLOSED (gọi lại bình thường)
```

### 2.2 catalog-events-mock — mô phỏng event source thật

```text
Catalog update → POST event đến catalog-events-mock (port 9091)
  → App nhận event → invalidate CDN cache
  → Request tiếp theo → MISS (cache bị xóa)
```

## 3. External khác gì DB?

| Khía cạnh | Postgres/DB layer | External layer |
| --- | --- | --- |
| Dependency | Internal (bạn sở hữu) | External (bạn không sở hữu) |
| Control | Full — inject delay/pressure/fault | Giới hạn — mock behavior |
| Failure mode | 5xx do DB fault | 5xx do external timeout/refuse |
| Recovery | Reset profile → instant | Circuit breaker, retry, dedupe |
| Key pattern | Inject → Observe → Reset | Healthy → Degraded → Retry/Recover |

## 4. 7 capability proofs

| Case | Capability | Topology | Ops token? | Key pattern |
| --- | --- | --- | --- | --- |
| ext-01 | Payment gateway matrix | full-no-cdn | Có | healthy → slow → down → circuit open → half-open → closed |
| ext-02 | Dependency recovery matrix | full-no-cdn | Có | healthy → fault → degraded → reset → recovered |
| ext-03 | Order confirm retry | full-no-cdn | Có | baseline → transient fail → retry success (attempts ≥ 2) |
| ext-04 | Webhook idempotency | full-no-cdn | Không | first (fresh) → duplicate (reuse, no DB write) → new event |
| ext-05 | Webhook ordering | full-no-cdn | Không | captured → stale failed (ignored, regression protected) |
| ext-06 | Mixed payment+DB recovery | full-no-cdn | Có | payment + postgres cùng degraded → phân biệt được source |
| ext-07 | Catalog event invalidation | **full** | Có | warmup HIT → event → MISS, external source → CDN effect |

## 5. Evidence model

```json
{
  "data": {
    "payment_mode": "http",
    "payment_code": 200,
    "payment_attempts": 2,
    "webhook_duplicate": false,
    "payment_regression_ignored": true,
    "payment_state_source": "webhook"
  },
  "performance": {
    "bottleneck": "external_ms",
    "breakdown": { "external_ms": 180, "db_write_ms": 5 }
  }
}
```

Key signals:
- `payment_attempts` — retry proof
- `webhook_duplicate` — dedupe proof
- `payment_regression_ignored` — stale event protection
- `bottleneck=external_ms` — external là bottleneck
- `X-Cache: HIT → MISS` — catalog invalidation proof (ext-07)

## 6. Learning order

```text
ext-01 (payment matrix) → ext-03 (retry) → ext-04 (webhook idempotency) → ext-05 (ordering)
  → ext-02 (dependency recovery) → ext-06 (mixed) → ext-07 (catalog events)
```

- **ext-01 trước**: Hiểu payment gateway behavior spectrum
- **ext-03 → ext-04 → ext-05**: Payment flow: retry → dedupe → ordering
- **ext-02 → ext-06**: Dependency recovery → mixed incident
- **ext-07**: Cross-layer — external event source ảnh hưởng CDN

## 7. Circuit breaker pattern (ext-01)

```text
CLOSED → (fail N lần) → OPEN → (timeout) → HALF-OPEN → (success) → CLOSED
  ↓                      ↓                     ↓
  Gọi external           Short-circuit         Test request
  bình thường            (trả 502 ngay)        Nếu OK → CLOSED
                                               Nếu fail → OPEN
```

## 8. Production lesson

External dependencies là thứ bạn **không kiểm soát được**. Payment gateway có thể chậm, fail, gửi duplicate webhook, gửi event sai thứ tự. Service của bạn phải:
- **Retry** có bounded (không retry vô hạn)
- **Dedupe** webhook (idempotency)
- **Protect** state (stale failed không được hạ cấp paid)
- **Circuit break** khi external down (không gọi mãi)
- **Phân biệt** được source của degradation (payment vs DB)
