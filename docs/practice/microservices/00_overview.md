# App Gateway & Microservices — Overview

## 1. Vị trí trong lộ trình

```text
CDN → LB/Gateway → App Gateway & Microservices → Redis/shared state → Postgres/DB → External → Resource
```

CDN trả lời câu hỏi "response có được edge cache không". LB trả lời "request được route tới upstream nào". App Gateway & Microservices trả lời câu hỏi tiếp theo:

```text
Khi request đã đến đúng upstream, nó có được route đến đúng microservice không?
Và mỗi microservice có trả đúng API contract không?
```

Nếu layer này sai, Redis idempotency và claim ownership bên trong order-service là vô nghĩa — vì request có thể đã đến sai service ngay từ đầu.

## 2. Mental model

```text
k6/client
  → http://localhost:80
  → Nginx (API Gateway)
  → /api/sim/auth/*      → auth-service:8081
  → /api/sim/products     → products-service:8084
  → /api/sim/cart         → cart-service:8082
  → /api/sim/checkout     → order-service:8083
  → /api/sim/orders/*     → order-service:8083
  → /api/sim/report*      → report-service:8085
  → /*                    → app:8080 (fallback)
```

Nginx là API gateway. Mỗi response đều có header `X-Upstream-Service` cho biết service nào đã xử lý. Đây là evidence chính cho routing correctness.

## 3. 5 microservices

| Service | Port | Trách nhiệm | Endpoints chính |
| --- | --- | --- | --- |
| auth-service | 8081 | Login, token, session | POST login, GET me, POST refresh |
| products-service | 8084 | Catalog reads | GET list, detail, search, categories, homefeed, recommendations |
| cart-service | 8082 | Cart state | POST add, GET view/summary, PATCH update, DELETE remove |
| order-service | 8083 | Transaction core | POST checkout, GET status, POST confirm, POST webhooks/payment |
| report-service | 8085 | Dashboard + async jobs | GET report, POST/GET jobs, GET download |

Mỗi service có `/health` endpoint riêng, báo cáo trạng thái của chính nó và các dependency (Postgres, Redis, payment URL).

## 4. 7 capability proofs

| Case | Capability | Câu hỏi |
| --- | --- | --- |
| ms-01 | Gateway routing smoke | Nginx có route đúng URL prefix → service không? |
| ms-02 | Products read contract | Products service có trả đúng list + detail contract không? |
| ms-03 | Cart write contract | Cart service có trả đúng add/view/update/remove contract không? |
| ms-04 | Order transaction contract | Order service có trả đúng checkout/confirm/status contract không? |
| ms-05 | Report async contract | Report service có trả đúng sync read + async job contract không? |
| ms-06 | Stateful business flow | Flow login→browse→cart→checkout→confirm→status có hoạt động xuyên suốt 5 service không? |
| ms-07 | Service health | Tất cả service có báo cáo dependency healthy không? |

## 5. Evidence model

Khác với CDN (dựa vào `X-Cache` header) và LB (dựa vào upstream selection), microservices layer dựa vào:

```text
X-Upstream-Service header: chứng minh routing đúng
Response envelope { success, data }: chứng minh contract đúng
Cross-service flow: chứng minh state xuyên service đúng
Service /health: chứng minh dependency đúng
```

Status code 200 là điều kiện cần, không đủ. Một response 200 từ sai service (vd: app fallback thay vì order-service) là fail.

## 6. Tại sao phải trước Redis?

```text
Redis cases (15-*.js) test idempotency, claim owner, hotkey race
— tất cả đều nằm trong order-service.

Nếu gateway route sai (request đến app fallback thay vì order-service),
hoặc order-service contract sai (thiếu Idempotency-Key header),
thì Redis cases không thể pass vì lý do ngoài Redis.
```

Thứ tự đúng: **route đúng service → contract đúng → state nhất quán**.

## 7. Topology

Tất cả microservices cases dùng `TargetLayer=full-no-cdn`:

```text
BASE_URL=http://localhost:80
```

Không dùng `full` (có CDN) vì Varnish cache có thể làm nhiễu response header và latency. Không dùng `lb-app` vì cần đủ 5 microservice upstream.

## 8. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| X-Upstream-Service = "app" thay vì service name | Nginx route sai, request rơi vào fallback |
| Response success=false | Service contract violation |
| Thiếu X-Upstream-Service header | Không thể chứng minh routing |
| Stateful flow đứt ở bước N | Service N contract sai hoặc state không propagate |
| /health báo dependency "down" | Infrastructure problem, không phải code |
| Status 200 nhưng sai service | Fail — status không đủ để chứng minh routing |

## 9. Learning order

```text
ms-01 (gateway routing) → ms-02→05 (per-service contracts, thứ tự tùy ý)
  → ms-06 (cross-service flow) → ms-07 (health)
```

ms-01 phải làm đầu tiên vì nó chứng minh routing đúng. ms-02 đến ms-05 có thể làm theo thứ tự tùy ý. ms-06 là integration test — chỉ làm sau khi từng service đã pass. ms-07 là health baseline.

## 10. Production lesson

Microservices không tự động đúng chỉ vì mỗi service chạy được. Cần chứng minh:
- Gateway route đúng URL → service
- Mỗi service trả đúng contract (status, body shape, headers)
- State flow xuyên service không đứt
- Health check phản ánh đúng dependency status

Đây là nền tảng trước khi nói về consistency (Redis), durability (Postgres), resilience (external), và capacity (resource).
