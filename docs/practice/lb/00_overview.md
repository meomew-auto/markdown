# Series thực hành: LB / Gateway layer

## Mục đích series

Sau CDN/Varnish, layer kế tiếp là **LB / Gateway**, hiện thực bằng Nginx. Nếu CDN trả lời câu hỏi “request nào được cache/offload?”, thì LB trả lời:

```text
Request đã đi vào origin path thì Nginx route, balance, retry, failover, canary, rate-limit và timeout có đúng contract không?
```

Đây vẫn là layer correctness suite, không phải capacity benchmark thuần. Một case LB pass khi route đúng upstream, header signal đúng, distribution/failover/limit/timeout đúng contract, và không có `X-Cache` vì profile này cố ý bypass CDN.

## Mental model

```text
client/k6 -> public URL :80 -> Nginx LB/Gateway -> app replicas / microservices / LB demo origins
```

Hai profile runtime:

| Profile | TargetLayer | Mục đích |
| --- | --- | --- |
| `lb-app` | `lb-app` | Nginx trước app replicas; chứng minh entrypoint và phân phối app instance. |
| `full-no-cdn` | `full-no-cdn` | Nginx trước full origin services nhưng không qua Varnish; chứng minh service boundary, failover, canary, pressure, timeout. |

Không dùng `TargetLayer=full` cho LB capability proof vì `full` có CDN/Varnish đứng trước, làm nhiễu signal LB.

## Required env

```powershell
$env:BASE_URL = "http://localhost:80"
```

Runner chính:

```powershell
./scripts/run-lb-capabilities.ps1 -Profile lb-app
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn
```

## Key LB concepts

| Concept | Cách hiểu |
| --- | --- |
| Public entrypoint | Cổng `:80` đi qua Nginx, không gọi direct app. |
| Upstream service | Backend thật mà Nginx route tới, đọc qua `X-Upstream-Service`. |
| Request ID | `X-Request-ID` chứng minh Gateway gắn trace ID cho mỗi request. |
| No CDN cache | LB profile phải không có `X-Cache`; nếu có là chạy sai topology. |
| App instance distribution | Với `ScaleApp 2`, traffic phải thấy nhiều `instance_id`. |
| Service boundary routing | `/auth`, `/cart`, `/orders`, `/products`, `/report` phải đi đúng service. |
| Retry/failover | Faulty origin được fallback sang stable origin đúng contract. |
| Rate/connection pressure | Một phần `429` có thể là expected nếu case đang test shedding. |
| Weighted canary | Stable/canary share phải nằm trong dải cho phép. |
| Passive outlier ejection | Backend lỗi bị tránh sau failure signal. |
| Saturation isolation | Slow lane không kéo sập fast lane. |
| Timeout policy | Slow origin bị cắt bằng timeout có chủ đích; `504` có thể expected. |

## Key headers/signals

```text
X-Served-By
Server
X-Upstream-Service
X-Request-ID
X-Upstream-Status
X-Upstream-Addr
X-LB-Failover
X-LB-RateLimit
X-LB-Release-Channel
X-LB-Health-Mode
X-LB-Upstream-Status
X-LB-Isolation-Class
X-LB-Timeout-Policy
```

Signal ngược lại cũng quan trọng:

```text
X-Cache phải vắng mặt trong LB profiles.
```

## Case inventory

| # | Case | Script | Profile | Capability proof |
| --- | --- | --- | --- | --- |
| 01 | Entry smoke | `01-entry-smoke.js` | `lb-app` | Public entrypoint qua Nginx tới app, có request id, không có CDN cache. |
| 02 | App instance distribution | `02-app-instance-distribution.js` | `lb-app` | Scale app 2 và Nginx thấy nhiều `instance_id`. |
| 03 | Domain boundaries | `03-domain-boundaries.js` | `full-no-cdn` | Route đúng app/auth/cart/order/products/report service. |
| 04 | Origin cacheable read | `04-origin-cacheable-read.js` | `full-no-cdn` | Cacheable product reads đi thẳng origin qua LB, không CDN. |
| 05 | Origin service mix | `05-origin-service-mix.js` | `full-no-cdn` | Production-like mix đi đúng upstream service. |
| 06 | Retry/failover | `06-retry-failover.js` | `full-no-cdn` | Faulty origin failover sang stable origin. |
| 07 | Rate limit/connection pressure | `07-rate-limit-and-connection-pressure.js` | `full-no-cdn` | `200` và expected `429` được phân loại đúng, unexpected = 0. |
| 08 | Weighted routing canary | `08-weighted-routing-canary.js` | `full-no-cdn` | Forced stable/canary và weighted canary nằm trong dải. |
| 09 | Passive outlier ejection | `09-passive-outlier-ejection.js` | `full-no-cdn` | Flaky origin bị ejection/fallback đúng behavior. |
| 10 | Weighted fairness under load | `10-weighted-fairness-under-load.js` | `full-no-cdn` | Canary share ổn định dưới load. |
| 11 | Saturation isolation | `11-saturation-isolation.js` | `full-no-cdn` | Fast lane p95 thấp dù slow lane chậm có chủ đích. |
| 12 | Slow origin timeout policy | `12-slow-origin-timeouts.js` | `full-no-cdn` | Slow origin bị timeout `504` đúng policy, unexpected = 0. |

## Common invalid-result patterns

| Pattern | Vì sao nguy hiểm | Cách đọc đúng |
| --- | --- | --- |
| Status 200 nhưng upstream sai | Gateway route nhầm service nhưng app vẫn trả OK | Kiểm `X-Upstream-Service`. |
| Có `X-Cache` trong LB test | Đang chạy qua CDN/Varnish, không còn là LB-only proof | Dùng `TargetLayer=lb-app` hoặc `full-no-cdn`. |
| Distribution chỉ thấy 1 instance | Scale app chưa đủ hoặc keepalive/session làm lệch sample | Case 02 cần `ScaleApp 2` và sample đủ. |
| `429` bị coi là bug ở case 07 | Case pressure cố ý test shedding | Đọc `lb_pressure_200`, `lb_pressure_429`, `lb_pressure_unexpected`. |
| `504` bị coi là bug ở case 12 | Timeout policy cố ý cắt slow origin | Đọc `X-LB-Timeout-Policy` và `lb_timeout_504`. |
| All 200 nhưng failover không có header | Không chứng minh retry/failover thật | Cần `X-LB-Failover=faulty->stable`. |
| Latency cao bị coi là LB fail | Slow lane/timeout case cố ý tạo latency | Đọc theo endpoint/tag, không đọc aggregate p95 toàn suite. |

## Suggested learning order

1. `lb-01`, `lb-02`: hiểu public Nginx entrypoint và app replica distribution.
2. `lb-03`: route boundary giữa app và microservices.
3. `lb-04`, `lb-05`: realistic origin traffic không qua CDN.
4. `lb-06`: retry/failover.
5. `lb-07`: pressure và expected shedding.
6. `lb-08`, `lb-10`: canary weight.
7. `lb-09`: passive outlier ejection.
8. `lb-11`: saturation isolation.
9. `lb-12`: timeout policy.

## Reference

- Run guide: `./RUN_GUIDE.md`
- Validation report: `./13_validation-and-chart-analysis.md`
- Source catalog: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/case-catalog.json`
- Runner: `E:/Projects/k6/k6-metrics-server/scripts/run-lb-capabilities.ps1`
- Nginx config: `E:/Projects/k6/k6-metrics-server/load-target/nginx/nginx.conf`
