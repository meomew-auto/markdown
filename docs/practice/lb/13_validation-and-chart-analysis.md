# LB / Gateway validation and chart analysis

> **Layer:** LB / Gateway — Nginx  
> **Profiles:** `lb-app`, `full-no-cdn`  
> **Mục tiêu:** validate routing/failover/canary/pressure/timeout semantics, không qua CDN

## 1. Mục đích

File này tổng hợp runtime evidence cho 12 LB capability cases. Khác CDN, LB không chứng minh cache semantics; LB chứng minh:

```text
request vào origin path có được Nginx route đúng upstream, phân phối đúng pool, failover đúng, shed load đúng, canary đúng, isolate slow lane đúng, và timeout đúng policy không?
```

Nguyên tắc đọc:

- `status 200` không đủ; phải đọc `X-Upstream-Service`.
- `X-Cache` phải vắng mặt; nếu có là chạy nhầm qua CDN.
- `429` có thể expected ở pressure case 07, nhưng không expected ở case 04/05.
- `504` expected ở timeout case 12.
- Chart chỉ là supporting evidence; proof chính là checks + headers + custom counters.

## 2. Validation environment

```text
Profile 1: lb-app
TargetLayer: lb-app
Purpose: public :80 -> Nginx -> app replicas
ScaleApp: 2

Profile 2: full-no-cdn
TargetLayer: full-no-cdn
Purpose: public :80 -> Nginx -> app/microservices/LB demo origins, no Varnish
ScaleApp: 2

BASE_URL: http://localhost:80
OPS token: only used for routing preflight when required; redacted
```

## 3. Commands run

```powershell
# lb-app profile
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer lb-app -ScaleApp 2
./scripts/check-target-routing.ps1 -BaseUrl "http://localhost:80" -TargetLayer lb-app
./scripts/run-lb-capabilities.ps1 -Profile lb-app -InspectOnly
./scripts/run-lb-capabilities.ps1 -Profile lb-app

# full-no-cdn profile
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
./scripts/check-target-routing.ps1 -BaseUrl "http://localhost:80" -TargetLayer full-no-cdn
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -InspectOnly
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn

# targeted diagnosis / tuned run for 04-05
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 04-origin-cacheable-read
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 05-origin-service-mix

$env:LB_CACHEABLE_WARMUP_VUS = "1"
$env:LB_CACHEABLE_MEASUREMENT_VUS = "2"
$env:LB_CACHEABLE_WARMUP_DURATION = "5s"
$env:LB_CACHEABLE_MEASUREMENT_DURATION = "10s"
$env:LB_MIX_VUS = "2"
$env:LB_MIX_DURATION = "10s"
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn
```

## 4. Preflight checklist

| Profile | Check | Expected | Observed | Result |
| --- | --- | --- | --- | --- |
| `lb-app` | public health `:80` | 200 | 200 | PASS |
| `lb-app` | route contract | pass | 9 pass, 0 fail | PASS |
| `lb-app` | inspect | exit 0 | exit 0 | PASS |
| `full-no-cdn` | public health `:80` | 200 | 200 | PASS |
| `full-no-cdn` | route contract | pass | 37 pass, 0 fail | PASS |
| `full-no-cdn` | inspect | exit 0 | exit 0 | PASS |

## 5. Runtime summary

### 5.1. `lb-app` profile

| Case | Script | Exit | Checks | HTTP failed | Primary observation | Result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 01 | `01-entry-smoke.js` | 0 | 13764/13764 | 0.00% (0/2463) | public entrypoint through Nginx, upstream app, request ID, no `X-Cache` | PASS |
| 02 | `02-app-instance-distribution.js` | 0 | 361/361 | 0.00% (0/60) | observed multiple app `instance_id` values with `ScaleApp 2` | PASS |

### 5.2. `full-no-cdn` profile — default run

Default profile started with case 03 pass, then stopped at case 04 because products list hit rate limiting/pressure.

| Case | Script | Exit | Checks | HTTP failed | Primary observation | Result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 03 | `03-domain-boundaries.js` | 0 | 31/31 | 0.00% (0/6) | app/auth/cart/order/products/report boundaries route đúng upstream | PASS |
| 04 | `04-origin-cacheable-read.js` | 99 | 11396/11930 | 22.38% | `products_list` status check failed; under concurrent cacheable traffic endpoint returned `429` | FAIL under default load |
| 05 | `05-origin-service-mix.js` | 99 when run in 05-12 batch | 20946/21770 | 18.92% | `products_list` status check failed; product list rate limited inside service mix | FAIL under default load |

Diagnosis probe for `/api/sim/products` under concurrency:

```text
120 concurrent probes -> 100 x 200, 20 x 429
non-200 responses still had X-Upstream-Service=products-service
```

Interpretation:

- Routing vẫn đúng: `X-Upstream-Service=products-service`.
- `X-Cache` vắng mặt: đúng LB-only path.
- Failure là mismatch giữa traffic shape mặc định của case 04/05 và rate/pressure behavior của products path.
- `429` không được case 04/05 khai báo là expected, nên threshold fail là đúng.

### 5.3. `full-no-cdn` profile — tuned correctness run

Khi giảm tải cho case 04/05 để không đụng rate limit, full profile 03-12 pass.

Env tuned:

```powershell
$env:LB_CACHEABLE_WARMUP_VUS = "1"
$env:LB_CACHEABLE_MEASUREMENT_VUS = "2"
$env:LB_CACHEABLE_WARMUP_DURATION = "5s"
$env:LB_CACHEABLE_MEASUREMENT_DURATION = "10s"
$env:LB_MIX_VUS = "2"
$env:LB_MIX_DURATION = "10s"
```

| Case | Script | Checks | HTTP failed | Primary observation | Result |
| --- | --- | ---: | ---: | --- | --- |
| 03 | `03-domain-boundaries.js` | 31/31 | 0.00% (0/6) | service boundaries route đúng | PASS |
| 04 | `04-origin-cacheable-read.js` | 1160/1160 | 0.00% (0/232) | cacheable product reads đi origin qua LB, no CDN cache | PASS tuned |
| 05 | `05-origin-service-mix.js` | 815/815 | 0.00% (0/163) | production-like mix route đúng upstream | PASS tuned |
| 06 | `06-retry-failover.js` | 7/7 | 0.00% (0/1) | failover faulty -> stable | PASS |
| 07 | `07-rate-limit-and-connection-pressure.js` | 602/602 | 65.11% (196/301) | expected pressure shedding: 200 + 429, unexpected = 0 | PASS |
| 08 | `08-weighted-routing-canary.js` | 253/253 | 0.00% (0/122) | forced stable/canary + weighted share within range | PASS |
| 09 | `09-passive-outlier-ejection.js` | 43/43 | 0.00% (0/6) | passive ejection/fallback behavior correct | PASS |
| 10 | `10-weighted-fairness-under-load.js` | 2163/2163 | 0.00% (0/721) | observed canary share 12.62% inside expected band | PASS |
| 11 | `11-saturation-isolation.js` | 1866/1866 | 0.00% (0/311) | fast lane p95 low while slow lane intentionally high | PASS |
| 12 | `12-slow-origin-timeouts.js` | 260/260 | 100.00% (65/65) | expected timeout 504; unexpected = 0 | PASS |

## 6. Special proof tables

### 6.1. Rate/connection pressure — case 07

| Signal | Expected | Observed | Result |
| --- | --- | --- | --- |
| `lb_pressure_200` | some accepted traffic | 105-106 range in runs | PASS |
| `lb_pressure_429` | expected shedding under pressure | 195-196 range in runs | PASS |
| `lb_pressure_unexpected` | 0 | 0 | PASS |
| `http_req_failed` | high due expected 429 | ~65% | expected |

Case 07 không pass bằng “tất cả 200”. Nó pass vì Nginx shedding đúng contract và không có status ngoài 200/429.

### 6.2. Canary fairness — cases 08/10

| Signal | Expected | Observed | Result |
| --- | --- | --- | --- |
| forced stable | stable channel | checks passed | PASS |
| forced canary | canary channel | checks passed | PASS |
| weighted sample | within min/max band | checks passed | PASS |
| `lb_canary_observed` | expected band | 12.62% in load run | PASS |

Nginx config dùng `split_clients` 15%; local sample không cần đúng 15.00%, chỉ cần nằm trong band.

### 6.3. Saturation isolation — case 11

| Endpoint | Expected | Observed p95 | Result |
| --- | --- | ---: | --- |
| `lb_isolation_fast_demo` | fast lane stays fast | ~4.29ms individual run | PASS |
| `lb_isolation_slow_demo` | slow lane intentionally slow | ~616.27ms individual run | PASS |
| failed rate by endpoint | 0% | 0% fast, 0% slow | PASS |

Ý nghĩa: slow origin không kéo sập fast origin; đọc aggregate p95 sẽ làm mất thông tin này.

### 6.4. Slow origin timeout — case 12

| Signal | Expected | Observed | Result |
| --- | --- | --- | --- |
| status | 504 timeout | all timeout requests counted as 504 | PASS |
| `X-LB-Timeout-Policy` | `read_timeout=150ms` | checks passed | PASS |
| `lb_timeout_504` | equals request count | 65 | PASS |
| `lb_timeout_unexpected` | 0 | 0 | PASS |
| p95 duration | near 150ms policy | ~153ms | PASS |
| `http_req_failed` | 100% expected | 65/65 | expected |

## 7. Đánh giá vấn đề cần BE/test-harness xem

### 7.1. Issue confirmed ở default case 04/05

Default case 04 và 05 không pass trong `full-no-cdn` vì `products_list` trả `429` dưới traffic mặc định.

Evidence:

```text
case 04 default:
checks_succeeded = 11396/11930
http_req_failed = 22.38%
products_list status: 99 pass / 534 fail

case 05 default:
checks_succeeded = 20946/21770
http_req_failed = 18.92%
products_list status: 77 pass / 824 fail

manual probe:
120 concurrent /api/sim/products -> 100 x 200, 20 x 429
```

### 7.2. Diễn giải

Đây không giống route bug vì:

- failed response vẫn route tới `products-service`;
- Nginx/Gateway signal vẫn có upstream service;
- tuned run pass khi giảm tải;
- pressure/timeout cases 07/12 đã có semantics riêng cho expected `429/504`.

Vấn đề nằm ở **contract mismatch**:

- Nếu case 04/05 là correctness-only, default VU/duration đang quá cao so với rate/pressure policy của products path. Nên giảm default env hoặc tách “capacity/pressure” khỏi correctness cases.
- Nếu `429` trên `/api/sim/products` là behavior mong muốn ở profile này, case 04/05 cần encode expected `429` như case 07, nhưng khi đó tên/semantics “cacheable read without CDN” và “service mix” phải nói rõ có pressure shedding.

Khuyến nghị cho BE/test-harness:

1. Giảm default `LB_CACHEABLE_*` và `LB_MIX_*` để case 04/05 chứng minh routing correctness ổn định.
2. Hoặc nâng/disable rate limit cho `/api/sim/products` trong `full-no-cdn` correctness profile.
3. Hoặc split thành hai mode: correctness mode không pressure, pressure mode riêng giống case 07.

## 8. So sánh LB validation với CDN/executor

| Khía cạnh | Executor | CDN | LB/Gateway |
| --- | --- | --- | --- |
| Câu hỏi chính | traffic shape đúng chưa? | cache contract đúng chưa? | route/failover/policy đúng chưa? |
| Evidence chính | RPS, VUs, latency, iterations | `X-Cache`, cache headers, origin counters | `X-Upstream-Service`, `X-LB-*`, distribution/counters |
| Non-2xx expected? | thường không | case 11: 404 expected | case 07: 429 expected; case 12: 504 expected |
| Chart quan trọng | rất quan trọng | phụ trợ | phụ trợ nhưng hữu ích cho distribution/pressure |
| Stateful? | ít | nhiều | vừa; outlier/failover/pressure có state |
| Chạy sai topology dễ nhầm? | ít | có | rất có: `full` sẽ đi qua CDN, sai LB proof |

## 9. Phân tích dashboard/chart cho LB cases

### 9.1. Chart nào quan trọng?

| Chart | Case | Cách đọc |
| --- | --- | --- |
| Checks rate over time | tất cả | phải 100% trừ khi đang diagnose failure; drop ở 04/05 default cho thấy contract mismatch. |
| HTTP failed rate | 04/05/07/12 | 04/05 expected 0; 07 expected cao do 429; 12 expected 100% do 504. |
| HTTP status codes | 07/12 | 07 phải chỉ 200/429; 12 phải 504; status khác là bug. |
| HTTP duration by endpoint | 11/12 | fast lane p95 thấp, slow lane p95 cao; timeout p95 gần 150ms. |
| Request timeline | 04/05/07/10/11/12 | thấy sustained traffic, rate pressure, canary fairness, isolation lanes. |
| Custom metrics | 07/10/12 | `lb_pressure_*`, `lb_canary_observed`, `lb_timeout_*` là chart tốt hơn aggregate RPS. |

### 9.2. Chart không đủ để pass/fail

- Aggregate p95 toàn profile: bị slow lane/timeout làm méo.
- Aggregate `http_req_failed`: case 07/12 expected failed cao.
- RPS tổng: không chứng minh route đúng.
- 200 rate: không chứng minh upstream đúng.
- Canary chart với sample nhỏ: cần dải min/max, không đòi đúng 15.00%.

### 9.3. Cách đọc failure default 04/05 trên chart

Pattern expected khi case 04/05 fail do rate-limit:

```text
checks rate drop khỏi 100%
http_req_failed spike
status chart xuất hiện 429
fail chỉ tập trung ở endpoint products_list
X-Upstream-Service vẫn là products-service
```

Kết luận đúng: không phải gateway route sai, mà traffic correctness case đang đụng pressure policy.

## 10. Current validation conclusion

| Scope | Conclusion |
| --- | --- |
| `lb-app` profile | PASS 2/2 |
| `full-no-cdn` route/inspect | PASS |
| `full-no-cdn` default runtime | FAIL at 04/05 due unexpected 429 on products_list |
| `full-no-cdn` tuned correctness runtime | PASS 03-12 |
| LB special policies 06-12 | PASS when isolated/tuned profile runs |
| Actionable issue | Adjust case 04/05 default load or products rate-limit contract |

## 11. Reference

- Overview: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Source scripts: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/*.js`
- Shared helper: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/shared.js`
- Nginx config: `E:/Projects/k6/k6-metrics-server/load-target/nginx/nginx.conf`
- Runner: `E:/Projects/k6/k6-metrics-server/scripts/run-lb-capabilities.ps1`
