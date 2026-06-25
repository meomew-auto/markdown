# External Dependency Layer: bạn không sở hữu nó, nhưng phải handle nó

## 1. Vì sao sau DB là External?

```text
CDN → LB → Microservices → Redis → Postgres → External → Resource
```

Sau khi xác nhận internal state (Redis, Postgres) chịu được degradation, câu hỏi tiếp theo:

```text
External systems — thứ bạn KHÔNG sở hữu — có làm hệ thống sập không?
Payment gateway down → checkout có fail đúng cách không?
Webhook duplicate → có dedupe không?
Webhook out-of-order → có bảo vệ state không?
Catalog event → CDN cache có bị invalidate không?
```

## 2. Mental model

```text
k6 → Nginx → order-service → payment-mock (HTTP, port 8080 internal)
                            → catalog-events-mock (HTTP, port 9091)
                            → Varnish CDN (observable effect, ext-07)
```

### 2.1 Hai external mock

| Mock | Mô phỏng | Real-world equivalent |
| --- | --- | --- |
| `payment-mock` | Payment gateway (PSP) | Stripe, PayPal, Adyen |
| `catalog-events-mock` | Event source / message bus | Kafka, RabbitMQ, SNS |

### 2.2 Tại sao external khác biệt?

```text
Internal (Redis, Postgres):  Bạn sở hữu → control plane đầy đủ → inject/reset
External (payment, events):  Bạn KHÔNG sở hữu → mock behavior → handle gracefully
```

## 3. 7 capability proofs

| Case | Capability | 5xx intentional? |
| --- | --- | --- |
| ext-01 | Payment matrix: healthy→slow→down→circuit→recover | **Có** (down + circuit) |
| ext-02 | Dependency recovery: fault→degraded→recovered | Có |
| ext-03 | Payment retry: fail first → retry success (attempts≥2) | Không |
| ext-04 | Webhook idempotency: duplicate → dedupe (no DB write) | Không |
| ext-05 | Webhook ordering: stale failed → ignored (regression) | Không |
| ext-06 | Mixed payment+DB recovery: phân biệt source | Có |
| ext-07 | Catalog event invalidation: event → CDN HIT→MISS | Không |

## 4. Validation snapshot 2026-06-25

| Case | Run | Checks | http_fail | Notes |
| --- | ---: | ---: | ---: | --- |
| ext-04 | #122 | 27/27 (100%) | 0% | Webhook: first fresh, duplicate deduped, new event independent |
| ext-05 | #123 | 41/41 (100%) | 0% | Webhook: regression_ignored=true on stale failed |
| ext-01 | #125 | 9/9 (100%) | 0% | Payment matrix healthy mode pass |
| ext-06 | #126 | 263/263 (100%) | 0% | Mixed payment+DB: degraded observed, recovered 100% |
| ext-03 | #124 | 27/38 (71.1%) | 20% | **FAIL** — transient retry `payment_attempts` not meeting MIN_ATTEMPTS=2 |
| ext-02 | — | — | — | Chưa chạy |
| ext-07 | — | — | — | Cần topology `full` |

**5/7 cases verified. ext-03 cần BE fix — `payment_fail_first_n` mechanism không tạo đủ retry attempts.**

## 5. Production lesson

External dependencies là thứ bạn không kiểm soát được. Nhưng bạn **phải**:
- **Retry** có bounded (ext-03)
- **Dedupe** webhook (ext-04)
- **Protect** state monotonicity (ext-05)
- **Circuit break** khi external down (ext-01)
- **Phân biệt** source của degradation (ext-06)
- **Invalidate** cache khi external event đến (ext-07)

Không làm được những điều này → production incident không thể debug, không thể recover.
