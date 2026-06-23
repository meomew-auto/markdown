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

## ⭐ 2 bài tiêu biểu nhất để dạy LB layer

Trong 12 case, đây là 2 bài **thực tế hay gặp nhất** và **bao quát toàn bộ tinh thần LB layer**:

### Bài 1: Case 03 — Domain boundary routing (`03_domain-boundaries.md`)

**Vì sao chọn làm bài nền tảng:**

```text
Routing là CHỨC NĂNG SỐ 1 của LB/Gateway.
Nếu route sai service, mọi thứ khác (retry, canary, timeout) đều vô nghĩa.
```

| Tiêu chí | Giá trị dạy |
| --- | --- |
| **Business scenario** | Hệ thống microservices: auth, cart, orders, products, report — mỗi service có path riêng. Request đến `/auth/*` phải đi auth service, `/cart/*` phải đi cart service. Route nhầm → user thấy sai data hoặc 404. |
| **LB capability** | Nginx route request đến đúng upstream service dựa trên URL path. `X-Upstream-Service` header xác nhận service đích. Mỗi path → đúng service → đúng response format. |
| **Signal quan trọng** | `X-Upstream-Service` là evidence chính: `X-Upstream-Service: auth-service`, `X-Upstream-Service: cart-service`, etc. Không có `X-Cache` (vì profile `full-no-cdn` bypass CDN). |
| **Executor** | `per-vu-iterations`, vus=1, iterations=1 — sequential deterministic proof. Gọi từng service một, verify response đúng format của service đó. |
| **Bài học cốt lõi** | **"Status 200 không có nghĩa route đúng."** App có thể trả 200 nhưng sai service → sai data. Phải verify `X-Upstream-Service` + response body structure. |
| **Độ khó** | ⭐⭐ — 5 service boundaries, cần biết response format từng service. |

**Dạy trong bao lâu:** 35-45 phút — routing concept, service boundaries, `X-Upstream-Service` header.

### Bài 2: Case 06 — Retry and failover (`06_retry-failover.md`)

**Vì sao chọn làm bài nâng cao:**

```text
Retry/failover là LÝ DO TỒN TẠI của LB trong production.
Không có failover, LB chỉ là reverse proxy đơn giản.
Case này dạy "user thấy 200 dù backend đang lỗi 503".
```

| Tiêu chí | Giá trị dạy |
| --- | --- |
| **Business scenario** | Một upstream origin bắt đầu trả 503 (lỗi, bảo trì, quá tải). Nginx phát hiện lỗi → retry sang upstream KHÁC → user vẫn nhận 200. User KHÔNG BAO GIỜ thấy lỗi nếu còn ít nhất 1 origin khỏe mạnh. |
| **LB capability** | Nginx retry mechanism: khi upstream A trả 503 → Nginx tự động thử upstream B → nếu B OK → trả 200 cho client. Header `X-LB-Failover=faulty->stable` là evidence của failover. |
| **Signal quan trọng** | `X-LB-Failover` header chứng minh failover đã xảy ra. `X-Upstream-Status: 503, 200` cho thấy attempt 1 (503) và attempt 2 (200). Client chỉ thấy status 200 cuối cùng. |
| **Executor** | `per-vu-iterations`, vus=1, iterations=1 — sequential proof. Sequence: setup faulty origin → gửi request → verify client nhận 200 + failover header. |
| **Bài học cốt lõi** | **"Client 200 có thể che giấu backend 503."** Đây là bài học vận hành quan trọng: đừng chỉ nhìn client-side status — phải đọc `X-Upstream-Status` và `X-LB-Failover` để biết chuyện gì đã xảy ra phía sau. |
| **Độ khó** | ⭐⭐ — Retry concept, failover evidence, phân biệt client view vs upstream view. |

**Dạy trong bao lâu:** 40-50 phút — retry concept, failover mechanism, client vs upstream perspective.

### Lộ trình dạy 2 bài

```text
Buổi 1 (nền tảng): Case 03 Domain boundary routing
  1. LB mental model: client → Nginx → upstream services
  2. Service boundaries: path → upstream mapping
  3. Evidence: X-Upstream-Service, response body structure
  4. Profile: full-no-cdn (không CDN để thấy signal LB thuần)
  5. Demo: chạy sequential, verify từng service route đúng

Buổi 2 (nâng cao): Case 06 Retry and failover
  1. Vì sao cần retry: upstream failure không nên đến user
  2. Failover mechanism: Nginx thử upstream khác
  3. Evidence: X-LB-Failover, X-Upstream-Status
  4. Client vs upstream view: 200 bên ngoài, 503 bên trong
  5. Demo: setup faulty origin, xem failover hoạt động
```

### Vì sao không chọn các case khác?

| Case | Vì sao không chọn làm bài chính? |
| --- | --- |
| 01 Entry smoke | Cơ bản (entrypoint, request ID, không CDN), nhưng chỉ là connectivity check. Case 03 dạy routing — giá trị hơn. |
| 02 App instance distribution | Tốt (scale app, nhiều instance_id), nhưng là extension của Case 01. Case 03 + 06 phủ rộng hơn. |
| 04 Origin cacheable read | Gần với CDN case 01 (cacheable read path). Học viên đã học CDN sẽ thấy trùng lặp. |
| 05 Origin service mix | Hay (mixed traffic như production), nhưng là "tổng hợp" của Case 03 + 04. Nên để học viên tự làm. |
| 07 Rate limit / connection pressure | Rất hay (load shedding, 429 expected), nhưng là advanced topic. Nên dạy làm case thứ 3 — sau khi đã hiểu routing + failover. |
| 08 Weighted canary routing | Tốt (canary release), nhưng đặc thù (deploy pattern). Case 06 (failover) phổ biến hơn — mọi hệ thống đều cần. |
| 09 Passive outlier ejection | Hay (auto-detect flaky backend), nhưng là automation của Case 06. Case 06 dạy concept gốc trước. |
| 10 Weighted fairness under load | Extension của Case 08 (canary weight) dưới load. Đặc thù. |
| 11 Saturation isolation | Cực hay (slow lane không kéo fast lane), nhưng là advanced topic. Cần hiểu open model (constant-arrival-rate) trước. |
| 12 Slow origin timeout policy | Rất hay (504 = policy, không phải bug), nhưng Case 06 (failover) là pattern phổ biến hơn trong vận hành hàng ngày. Case 12 nên dạy làm case thứ 3. |

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
