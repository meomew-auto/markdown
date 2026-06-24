# App Gateway & Microservices: routing + contract trước consistency

## 1. Vì sao sau LB là App Gateway & Microservices?

CDN trả lời request nào được edge cache. LB trả lời request nào được route tới upstream nào. Khi request đã đến đúng upstream, câu hỏi tiếp theo là:

```text
Nginx có route request đến đúng microservice không?
Mỗi microservice có trả đúng API contract không?
Stateful flow có hoạt động xuyên suốt các service không?
```

Nếu layer này sai, Redis/shared state bên trong order-service là vô nghĩa — vì request có thể đã đến sai service hoặc contract sai khiến idempotency key bị drop.

## 2. Mental model

Runtime đúng cho Microservices practice là `TargetLayer=full-no-cdn`:

```text
k6/client
  → http://localhost:80
  → Nginx API Gateway
  → /api/sim/auth/*      → auth-service:8081      (X-Upstream-Service: auth-service)
  → /api/sim/products     → products-service:8084   (X-Upstream-Service: products-service)
  → /api/sim/cart         → cart-service:8082       (X-Upstream-Service: cart-service)
  → /api/sim/checkout     → order-service:8083      (X-Upstream-Service: order-service)
  → /api/sim/orders/*     → order-service:8083      (X-Upstream-Service: order-service)
  → /api/sim/report*      → report-service:8085     (X-Upstream-Service: report-service)
  → /*                    → app:8080 (fallback)     (X-Upstream-Service: app)
```

Không dùng `TargetLayer=full` vì Varnish/CDN phía trước có thể cache response làm nhiễu routing proof. Microservices cases kiểm origin-side routing và contract, không kiểm edge cache.

## 3. Microservices khác gì CDN và LB?

| Khía cạnh | CDN/Varnish | LB/Nginx | App Gateway & Microservices |
| --- | --- | --- | --- |
| Vị trí | Edge/public path | Entry routing | Origin-side service routing |
| Câu hỏi | Response có được cache/bypass/invalidate đúng không? | Request được route tới upstream nào? | Request được route tới đúng service không? Contract có đúng không? |
| Evidence | `X-Cache`, TTL, purge, origin counters | Upstream selection, distribution, failover | `X-Upstream-Service` header, response envelope, cross-service flow |
| Failure chính | Stale/wrong cached response | Wrong upstream, uneven distribution | Wrong service routed, contract violation, broken flow |

## 4. 5 microservices

| Service | Port | Loại | Dependencies |
| --- | --- | --- | --- |
| auth-service | 8081 | Auth/Session | Postgres |
| products-service | 8084 | Read-heavy catalog | Postgres |
| cart-service | 8082 | Write-heavy state | Postgres |
| order-service | 8083 | Transaction core | Postgres, Redis, payment-mock |
| report-service | 8085 | Sync read + async jobs | Postgres |

## 5. 7 capability proofs

| Case | Capability | Script | Lesson |
| --- | --- | --- | --- |
| ms-01 | Gateway routing smoke | si-07-ci-verification-batch.js | Nginx route đúng URL prefix → service; `X-Upstream-Service` là proof chính |
| ms-02 | Products read contract | si-01-catalog-audit.js | List + detail trả đúng envelope; products là CDN cache origin |
| ms-03 | Cart write contract | si-04-cart-cleanup.js | Add/view/update/remove đúng contract; cart state persist |
| ms-04 | Order transaction contract | si-02-order-reconciliation.js | Checkout/confirm/status đúng contract; idempotency key hoạt động |
| ms-05 | Report async contract | si-06-report-export-batch.js | Sync read + async job (202 Accepted); job lifecycle hoàn chỉnh |
| ms-06 | Stateful business flow | 32-per-vu-business-core.js | Login→browse→cart→checkout→confirm→status xuyên 5 service |
| ms-07 | Service health | 01-dependency-smoke.js | Tất cả dependencies "up"; health check phản ánh thực tế |

## 6. k6 quan sát được gì?

```text
status code (200 cho sync, 202 cho async job create)
headers: X-Upstream-Service, X-Upstream-Addr, X-Request-ID
body envelope: { success: bool, data: ... }
cross-service state: order_id preserved, session valid, cart persist
custom counters: shared_jobs_total/failed, per_vu_core_case_failures
service health: dependency status per service
```

Status code không đủ:

```text
status 200 + X-Upstream-Service: app (fallback) = fail
status 200 + success: false = fail
status 200 nhưng order_id khác giữa checkout và status = fail
status 200 cho job create thay vì 202 = fail
```

## 7. Failure modes thường gặp

```text
Nginx location block sai → request rơi vào fallback app thay vì microservice.
Service contract sai → thiếu field, sai envelope, sai status code.
Auth session không propagate → stateful flow đứt ở bước đầu.
Cart state không persist → thêm item nhưng view không thấy.
Order ID mapping sai → checkout trả ID này, status đọc ID khác.
Health check tĩnh → báo "up" nhưng dependency thật sự down.
202 vs 200 nhầm lẫn → async job trả 200 thay vì 202.
```

## 8. Tại sao phải trước Redis?

```text
CDN → LB → [App Gateway & Microservices] → Redis → Postgres → External → Resource
                   ↑
              PHẢI CÓ LAYER NÀY
```

Redis cases (15-*.js đến 19-*.js, 31-*.js) test idempotency, claim owner, hotkey race, fairness, degrade, cache toggle — tất cả đều nằm trong order-service và app cache. Nếu:

- Gateway route `/api/sim/orders/*` đến sai service → Redis cases test sai thứ;
- Order service không parse `Idempotency-Key` header → idempotency test fail vì contract, không phải vì Redis;
- Auth service không hoạt động → stateful flow không thể login để lấy token cho cart/order operations.

**Phải chứng minh routing + contract đúng trước khi test consistency.**

## 9. Validation snapshot 2026-06-24

```text
ms-01 gateway-routing-smoke:     PASS 100/100    (100%)    0.00% http_req_failed
ms-02 products-read-contract:    PASS 160/160    (100%)    0.00% http_req_failed
ms-03 cart-write-contract:       PASS 180/180    (100%)    0.00% http_req_failed
ms-04 order-transaction-contract:PASS 240/240    (100%)    0.00% http_req_failed
ms-05 report-async-contract:     PASS 240/240    (100%)    0.00% http_req_failed
ms-06 stateful-business-flow:    PASS 915/918    (99.67%) 0.00% http_req_failed (3 idempotency timing)
ms-07 service-health:            PASS 2320/2320  (100%)    0.00% http_req_failed
```

App Gateway & Microservices layer **GREEN 7/7** trong default practice mode.

ms-07 cần `APP_DEPS_ORIGIN_BASE_URL=""` vì `full-no-cdn` không expose port 8088.

ms-06 có 3 idempotency timing failures là expected race behavior ở layer này — Redis layer (redis-02) cung cấp exact atomic proof sau.

## 10. Roadmap

```text
CDN → LB → App Gateway & Microservices → Redis/shared state → Postgres/DB → External dependency → Resource/capacity
```

App Gateway & Microservices là nền tảng: nó chứng minh request đến đúng service với đúng contract. Mọi layer sau (Redis, Postgres, External) đều giả định layer này đúng. Nếu bỏ qua layer này, bạn đang test consistency trên một nền tảng chưa được xác nhận.
