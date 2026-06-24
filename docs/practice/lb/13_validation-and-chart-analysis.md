# LB / Gateway validation and chart analysis

> **File tổng hợp validation cho toàn bộ 12 LB capability cases**
> **Ngày tổng hợp**: 2026-06-23
> **Layer**: LB / Gateway -- Nginx
> **Profiles**: `lb-app`, `full-no-cdn`
> **Mục tiêu**: validate routing/failover/canary/pressure/timeout semantics, không qua CDN

---

## 1. Mục đích

File này tổng hợp runtime evidence cho 12 LB capability cases. Khác CDN, LB không chứng minh cache semantics; LB chứng minh:

```text
request vào origin path có được Nginx route đúng upstream, phân phối đúng pool,
failover đúng, shed load đúng, canary đúng, isolate slow lane đúng, và timeout
đúng policy không?
```

**Nguyên tắc đọc**:

- `status 200` không đủ; phải đọc `X-Upstream-Service`.
- `X-Cache` phải vắng mặt; nếu có là chạy nhầm qua CDN.
- `429` có thể expected ở pressure case 07, nhưng không expected ở case 04/05 (correctness).
- `504` expected ở timeout case 12.
- Chart chỉ là supporting evidence; proof chính là checks + headers + custom counters.
- `http_req_failed` rate cần đọc theo context từng case, không dùng aggregate toàn suite.
- Aggregate p95 toàn suite có thể gây hiểu nhầm; phải đọc theo endpoint/tag.

**Khác biệt cốt lõi với CDN validation**:

| Khía cạnh | CDN validation | LB validation |
| --- | --- | --- |
| Câu hỏi chính | Cache contract có đúng không? | Route/failover/policy có đúng không? |
| Evidence chính | `X-Cache`, cache headers, origin counters | `X-Upstream-Service`, `X-LB-*`, distribution/counters |
| Non-2xx expected | Case 11: 404 expected | Case 07: 429 expected; Case 12: 504 expected |
| Stateful | Nhiều (cache, origin profile, counter) | Vừa (outlier ejection, failover, pressure) |
| Chạy sai topology | Có (qua `full` layer) | Rất có (qua `full` layer: request đi CDN trước Nginx) |

---

## 2. Validation environment

### 2.1. Hai profile runtime

```text
Profile 1: lb-app
TargetLayer: lb-app
Purpose: public :80 -> Nginx -> app replicas
ScaleApp: 2
Cases: 01, 02

Profile 2: full-no-cdn
TargetLayer: full-no-cdn
Purpose: public :80 -> Nginx -> app/microservices/LB demo origins, no Varnish
ScaleApp: 2
Cases: 03-12
```

### 2.2. Topology cho từng profile

**Profile `lb-app` (case 01-02)**:

```text
client/k6 -> public URL :80 -> Nginx LB/Gateway -> app replicas (ScaleApp 2)
```

Không có microservices hay LB demo origins. Chỉ có app replicas phía sau Nginx.

**Profile `full-no-cdn` (case 03-12)**:

```text
client/k6 -> public URL :80 -> Nginx LB/Gateway -> app replicas
                                                  -> microservices (auth, cart, orders, products, report)
                                                  -> LB demo origins (failover, pressure, canary, ejection, isolation, timeout)
```

Không có Varnish/CDN trong path. `X-Cache` phải vắng mặt trong mọi response.

### 2.3. Biến môi trường

```powershell
$env:BASE_URL = "http://localhost:80"
```

Biến điều chỉnh cho từng case (có thể ghi đè qua env):

```powershell
# Case 01-02 (lb-app)
$env:LB_ENTRY_VUS = "4"
$env:LB_ENTRY_DURATION = "20s"
$env:LB_DISTRIBUTION_ITERATIONS = "60"
$env:MIN_LB_INSTANCES = "2"

# Case 04 (origin cacheable read)
$env:LB_CACHEABLE_WARMUP_VUS = "6"
$env:LB_CACHEABLE_MEASUREMENT_VUS = "16"
$env:LB_CACHEABLE_WARMUP_DURATION = "20s"
$env:LB_CACHEABLE_MEASUREMENT_DURATION = "30s"

# Case 05 (origin service mix)
$env:LB_MIX_VUS = "12"
$env:LB_MIX_DURATION = "45s"

# Case 07 (pressure)
$env:LB_PRESSURE_RATE = "30"

# Case 08/10 (canary)
$env:LB_CANARY_SAMPLE_SIZE = "120"
$env:LB_CANARY_FAIRNESS_RATE = "90"

# Case 11 (isolation)
$env:LB_ISOLATION_FAST_RATE = "35"
$env:LB_ISOLATION_SLOW_RATE = "8"

# Case 12 (timeout)
$env:LB_TIMEOUT_RATE = "8"
```

### 2.4. Stack commands

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

# Targeted diagnosis nếu cần chạy riêng case 04/05
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 04-origin-cacheable-read
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 05-origin-service-mix

# Recheck sau fix: default full-no-cdn, không dùng tuned env
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn
```

---

## 3. Preflight checklist

Trước khi chạy toàn bộ LB suite, các bước preflight sau phải được hoàn thành:

| # | Profile | Check | Command | Expected | Observed | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `lb-app` | public health `:80` | `curl http://localhost:80/health` | 200 | 200 | PASS |
| 2 | `lb-app` | route contract | `check-target-routing.ps1 -TargetLayer lb-app` | all pass | 9 pass, 0 fail | PASS |
| 3 | `lb-app` | inspect script syntax | `run-lb-capabilities.ps1 -Profile lb-app -InspectOnly` | exit 0 | exit 0 | PASS |
| 4 | `full-no-cdn` | public health `:80` | `curl http://localhost:80/health` | 200 | 200 | PASS |
| 5 | `full-no-cdn` | route contract | `check-target-routing.ps1 -TargetLayer full-no-cdn` | all pass | 37 pass, 0 fail | PASS |
| 6 | `full-no-cdn` | inspect script syntax | `run-lb-capabilities.ps1 -Profile full-no-cdn -InspectOnly` | exit 0 | exit 0 | PASS |
| 7 | `full-no-cdn` | `X-Cache` absent on all paths | `curl -sI http://localhost:80/api/sim/products` | no `X-Cache` in response | no `X-Cache` | PASS |
| 8 | `full-no-cdn` | Nginx `Server` header present | `curl -sI http://localhost:80/` | `Server: nginx` | `Server: nginx` | PASS |
| 9 | `full-no-cdn` | `X-Request-ID` present | `curl -sI http://localhost:80/api/sim/products` | `X-Request-ID` present | `X-Request-ID` present | PASS |
| 10 | `full-no-cdn` | Backend ejection healthy | `curl http://localhost:80/api/lb/ejection-demo -H "X-LB-Ejection-Bucket: a"` | 200, role=stable | 200, role=stable | PASS |

---

## 4. Runtime summary -- bảng tổng hợp 12 case

### 4.1. `lb-app` profile

| Case | Script | Exit | Checks | HTTP failed | Primary observation | Result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 01 | `01-entry-smoke.js` | 0 | 13764/13764 | 0.00% (0/2463) | public entrypoint qua Nginx tới app, có `X-Request-ID`, không `X-Cache`, upstream service đúng | **PASS** |
| 02 | `02-app-instance-distribution.js` | 0 | 361/361 | 0.00% (0/60) | quan sát được nhiều app `instance_id` với `ScaleApp 2`; Nginx phân phối traffic qua nhiều instance | **PASS** |

### 4.2. `full-no-cdn` profile -- default run sau fix case 04/05

Sau khi BE/test-harness sửa case 04/05, chạy lại default profile `full-no-cdn` **không dùng tuned env**. Kết quả: runner exit 0, đủ 10/10 cases của profile `full-no-cdn` pass.

| Case | Script | Exit | Checks | HTTP failed | Primary observation | Result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 03 | `03-domain-boundaries.js` | 0 | 31/31 | 0.00% (0/6) | app/auth/cart/order/products/report boundaries route đúng upstream service tương ứng | **PASS** |
| 04 | `04-origin-cacheable-read.js` | 0 | 6535/6535 | 0.00% (0/1307) | cacheable product reads đi origin qua LB, không CDN cache, không còn unexpected 429 | **PASS** |
| 05 | `05-origin-service-mix.js` | 0 | 4625/4625 | 0.00% (0/925) | production-like mix route đúng upstream service, không còn unexpected 429 trên `products_list` | **PASS** |
| 06 | `06-retry-failover.js` | 0 | 7/7 | 0.00% (0/1) | faulty origin được failover sang stable; `X-LB-Failover=faulty->stable` | **PASS** |
| 07 | `07-rate-limit-and-connection-pressure.js` | 0 | 602/602 | 65.11% (196/301) | expected pressure shedding: 200 + 429, unexpected = 0 | **PASS** |
| 08 | `08-weighted-routing-canary.js` | 0 | 253/253 | 0.00% (0/122) | forced stable/canary channels + weighted share within expected band | **PASS** |
| 09 | `09-passive-outlier-ejection.js` | 0 | 43/43 | 0.00% (0/6) | passive ejection/fallback behavior; `X-LB-Health-Mode=passive-ejection`; follow-up clean | **PASS** |
| 10 | `10-weighted-fairness-under-load.js` | 0 | 2160/2160 | 0.00% (0/720) | canary fairness under load inside expected band | **PASS** |
| 11 | `11-saturation-isolation.js` | 0 | 1872/1872 | 0.00% (0/312) | fast lane remains healthy while slow lane is intentionally slow | **PASS** |
| 12 | `12-slow-origin-timeouts.js` | 0 | 260/260 | 100.00% (65/65) | expected timeout 504; `X-LB-Timeout-Policy=read_timeout=150ms`; unexpected = 0 | **PASS** |

### 4.3. Targeted recheck 2026-06-24 -- case 04/05 sau BE fix

Sau thông báo BE đã fix case 04/05, chạy lại riêng hai scenario trên stack `full-no-cdn` vừa rebuild, không dùng tuned env:

```text
Command:
  ./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
  ./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 04-origin-cacheable-read,05-origin-service-mix

Result:
  runner exit 0
  case 04: checks 8180/8180, http_req_failed 0.00% (0/1636), p95=189.56ms
  case 05: checks 4580/4580, http_req_failed 0.00% (0/916), p95=154.57ms
```

Kết luận: targeted recheck xác nhận fix vẫn ổn ở default scenario; không còn unexpected `429` trên case 04/05.

### 4.4. Historical issue -- default case 04/05 trước fix

Trước fix, default profile dừng ở case 04/05 vì `/api/sim/products` trả unexpected `429` dưới traffic mặc định.

```text
Case 04 old default:
  Checks: 11396/11930
  http_req_failed: 22.38%
  products_list status failed due 429

Case 05 old default:
  Checks: 20946/21770
  http_req_failed: 18.92%
  products_list status failed due 429

Manual probe cũ:
  120 concurrent /api/sim/products -> 100 x 200, 20 x 429
```

Diễn giải cũ: đây là contract mismatch giữa correctness cases 04/05 và pressure/rate-limit behavior của products path, không phải route bug vì `X-Upstream-Service` vẫn là `products-service` và `X-Cache` vắng mặt.

Trạng thái hiện tại: **đã verify fixed** bằng default full-no-cdn run mới; case 04/05 không còn cần tuned env để pass.

---

## 5. Special proof tables

### 5.1. Rate/connection pressure -- case 07

Case 07 không pass bằng "tất cả 200". Nó pass vì Nginx shedding đúng contract và không có status ngoài 200/429.

| Signal | Expected | Observed (tuned run) | Result |
| --- | --- | --- | --- |
| `lb_pressure_200` | some accepted traffic | 105 trong run | PASS |
| `lb_pressure_429` | expected shedding under pressure | 196 trong run | PASS |
| `lb_pressure_unexpected` | 0 | 0 | PASS |
| `http_req_failed` | high due to expected 429 | ~65.11% | expected |
| Status codes observed | only 200 and 429 | 200 + 429, no other | PASS |
| `X-Upstream-Service` | `lb-pressure-backend` | verified via checks | PASS |
| `X-Cache` | absent | absent | PASS |

**Cách đọc đúng**: Một người mới nhìn vào bảng trên có thể kết luận "case 07 fail vì HTTP failed 65%". Đây là cách đọc sai. Case 07 pass vì:
- Checks rate = 100% (602/602): tất cả assertion về pressure signal đều đúng.
- `lb_pressure_unexpected = 0`: không có status lạ ngoài 200 và 429.
- Pressure shedding là behavior mong muốn -- Nginx từ chối request khi áp lực vượt ngưỡng, thay vì để tất cả request vào và làm sập upstream.

### 5.2. Canary fairness -- cases 08/10

Nginx config dùng `split_clients 15%`; local sample không cần đúng 15.00%, chỉ cần nằm trong band.

| Signal | Expected | Observed | Result |
| --- | --- | --- | --- |
| forced stable channel | `X-LB-Release-Channel=stable` | checks passed | PASS |
| forced canary channel | `X-LB-Release-Channel=canary` | checks passed | PASS |
| weighted sample | within min/max band | checks passed | PASS |
| `lb_canary_observed` (case 10) | trong expected band (vd: 10-20%) | 12.62% | PASS |
| `http_req_failed` | 0.00% (case 08: 0/122; case 10: 0/721) | 0.00% | PASS |

**Lưu ý**: Case 08 chứng minh routing đúng kênh (forced stable và forced canary). Case 10 chứng minh fairness định lượng dưới load. Cả hai case đều cần sample đủ lớn (`LB_CANARY_SAMPLE_SIZE`, `LB_CANARY_FAIRNESS_RATE`) để kết quả thống kê có ý nghĩa.

### 5.3. Saturation isolation -- case 11

Slow lane chậm có chủ đích, nhưng fast lane vẫn phải nhanh. Đọc aggregate p95 sẽ làm mất thông tin này.

| Endpoint | Expected | Observed p95 | HTTP failed | Result |
| --- | --- | ---: | ---: | --- |
| `lb_isolation_fast_demo` | fast lane stays fast | ~4.29ms | 0% (0 fast requests) | PASS |
| `lb_isolation_slow_demo` | slow lane intentionally slow | ~616.27ms | 0% (0 slow requests) | PASS |
| Failed rate by endpoint | 0% per endpoint | -- | 0% fast, 0% slow | PASS |
| `X-LB-Isolation-Class` | `fast` / `slow` per endpoint | checks passed | -- | PASS |

**Ý nghĩa**: Nếu ta chỉ nhìn aggregate p95 toàn case, giá trị sẽ bị slow lane kéo lên rất cao (hàng trăm ms), tạo cảm giác "toàn bộ hệ thống chậm". Nhưng fast lane vẫn hoạt động nhanh độc lập với slow lane. Đây là bằng chứng Nginx cô lập được slow origin -- slow lane không kéo sập fast lane.

### 5.4. Slow origin timeout -- case 12

Case 12 có `http_req_failed = 100%` -- tất cả request đều "fail" từ góc nhìn HTTP. Nhưng đây là expected: slow origin bị Nginx cắt bằng timeout có chủ đích.

| Signal | Expected | Observed | Result |
| --- | --- | --- | --- |
| HTTP status | 504 Gateway Timeout | all timeout requests returned 504 | PASS |
| `X-LB-Timeout-Policy` | `read_timeout=150ms` | checks passed | PASS |
| `lb_timeout_504` | equals request count | 65 | PASS |
| `lb_timeout_unexpected` | 0 | 0 | PASS |
| p95 duration | near 150ms policy | ~153ms | PASS |
| `http_req_failed` | 100% expected | 65/65 | expected |
| `X-Upstream-Service` | `lb-timeout-backend` | checks passed | PASS |

**Cách đọc đúng**: Checks rate = 100% (260/260), tất cả assertion về timeout signal đều đúng. `http_req_failed = 100%` ở đây không phải bug -- nó là bằng chứng Nginx timeout policy đang hoạt động chính xác.

---

## 6. Cross-case pattern analysis

### 6.1. Pattern recurrence: những pattern nào lặp lại?

**Pattern 1 -- Upstream routing verification (xuất hiện trong tất cả 12 case)**

Mọi LB case đều cần xác minh request được route đúng upstream. Evidence chính là `X-Upstream-Service` header:

| Case | Expected upstream | Cách verify |
| --- | --- | --- |
| 01 | `app` | `assertLBResponse` check upstream matches |
| 02 | `app` | `assertLBResponse` + instance_id diversity |
| 03 | `app`, `auth-service`, `cart-service`, `orders-service`, `products-service`, `reporting-service` | mỗi endpoint check upstream tương ứng |
| 04 | `products-service` | `assertLBResponse` |
| 05 | varies by endpoint (6 services) | check từng endpoint |
| 06 | `lb-stable-origin` (sau failover) | `X-LB-Failover=faulty->stable` |
| 07 | `lb-pressure-backend` | check trong pressure case |
| 08 | `lb-canary-backend` | `X-LB-Release-Channel=stable/canary` |
| 09 | `lb-ejection-backend` | `X-LB-Health-Mode=passive-ejection` |
| 10 | `lb-canary-backend` | canary share counter |
| 11 | `lb-isolation-backend` | `X-LB-Isolation-Class=fast/slow` |
| 12 | `lb-timeout-backend` | `X-LB-Timeout-Policy` |

**Pattern 2 -- `X-Cache` absence check (tất cả 10 case `full-no-cdn`)**

Tất cả case trong profile `full-no-cdn` đều phải verify `X-Cache` vắng mặt. Đây là bằng chứng request không đi qua Varnish/CDN -- đúng topology LB-only.

**Pattern 3 -- `X-Request-ID` presence (tất cả 12 case)**

Mọi case đều kiểm tra `X-Request-ID` có mặt trong response, chứng minh Nginx Gateway gắn trace ID cho mỗi request.

**Pattern 4 -- Custom metrics cho expected non-200 (case 07, 12)**

Case 07 và 12 đều có `http_req_failed` cao, nhưng đều pass nhờ custom counters phân loại expected vs unexpected status:

- Case 07: `lb_pressure_200`, `lb_pressure_429`, `lb_pressure_unexpected`
- Case 12: `lb_timeout_504`, `lb_timeout_unexpected`

**Pattern 5 -- Endpoint-tagged thresholds (case 07, 10, 11, 12)**

Các case phức tạp dùng tagging theo endpoint để tách biệt metric cho từng loại traffic:

- Case 07: tag phân biệt pressure probe
- Case 10: tag phân biệt canary vs stable request
- Case 11: tag `lb_isolation_fast_demo` vs `lb_isolation_slow_demo`
- Case 12: tag timeout probe

Nếu không có tagging, aggregate metric sẽ bị trộn lẫn và không thể kết luận đúng.

### 6.2. Case difficulty ranking (1 = dễ nhất, 12 = khó nhất)

| Rank | Case | Độ khó | Lý do |
| --- | --- | --- | --- |
| 1 | 01 Entry smoke | Thấp | Chỉ cần request qua Nginx, check upstream + request ID + no cache. Sustained traffic nhưng đơn giản. |
| 2 | 02 App distribution | Thấp | Cần thấy nhiều `instance_id`. Chỉ cần `ScaleApp 2` và sample đủ. |
| 3 | 03 Domain boundaries | Trung bình thấp | 6 service boundaries, nhưng mỗi cái chỉ cần đúng upstream. |
| 4 | 06 Retry/failover | Trung bình thấp | Chỉ 1 request, nhưng cần header failover. |
| 5 | 04 Origin cacheable read | Trung bình | Cần sustained traffic; trước đây từng đụng rate limit nhưng default run sau fix đã pass. |
| 6 | 05 Origin service mix | Trung bình | Production-like mix, nhiều endpoint; default run sau fix đã pass 0% HTTP failed. |
| 7 | 08 Weighted canary | Trung bình | Forced channels + weighted sample; cần hiểu dải thống kê. |
| 8 | 12 Slow origin timeout | Trung bình cao | `http_req_failed=100%` dễ gây hiểu nhầm; cần đọc custom counter. |
| 9 | 07 Rate/pressure | Cao | `http_req_failed=65%` dễ gây hiểu nhầm; cần phân loại expected 429. |
| 10 | 10 Canary fairness | Cao | Cần sample lớn, thống kê ổn định dưới load; canary share phải trong band. |
| 11 | 09 Passive ejection | Cao | Timing-critical: `sleep(RESET_WAIT_SECONDS)`; cần hiểu fail_timeout; stateful. |
| 12 | 11 Saturation isolation | Rất cao | Hai lane chạy đồng thời; fast lane p95 phải thấp dù slow lane cao; aggregate p95 gây hiểu nhầm nặng. |

### 6.3. Dependency graph

```text
Case 01 (Entry smoke) -- foundation: public Nginx entrypoint
  └── Case 02 (App distribution) -- mở rộng: app instance phân phối

Case 03 (Domain boundaries) -- foundation: 6 service boundaries
  ├── Case 04 (Cacheable read) -- mở rộng: sustained origin traffic
  ├── Case 05 (Service mix) -- mở rộng: realistic production mix
  ├── Case 06 (Retry/failover) -- mở rộng: failover mechanism
  ├── Case 07 (Pressure) -- mở rộng: rate/connection shedding
  ├── Case 08 (Canary) -- mở rộng: weighted routing
  │     └── Case 10 (Canary fairness) -- mở rộng: fairness under load
  ├── Case 09 (Passive ejection) -- mở rộng: outlier detection + stateful behavior
  ├── Case 11 (Saturation isolation) -- mở rộng: lane isolation
  └── Case 12 (Slow timeout) -- mở rộng: timeout policy
```

**Dependency giữa các profile**:

- Case 01-02 (`lb-app`): độc lập với case 03-12 (`full-no-cdn`). Có thể chạy profile nào trước cũng được.
- Case 03-12 (`full-no-cdn`): chạy tuần tự trong cùng một profile vì shared state của Nginx (ejection state, upstream health).
- Case 09: để lại ejection state trong Nginx. Nếu không có `RESET_WAIT_SECONDS`, case 09 có thể ảnh hưởng các case sau (dù các case sau dùng upstream khác, nhưng Nginx worker behavior có thể bị ảnh hưởng).
- Case 07 (pressure) và case 04/05 (correctness): dùng chung `/api/sim/products` path nên rate limit state có thể ảnh hưởng chéo.

### 6.4. Case nào dễ false positive / false negative nhất?

**Dễ false positive nhất: Case 06 (Retry/failover)**

```text
Tại sao:
  - Chỉ 1 request, 7 checks, tất cả đều pass dễ dàng.
  - Nhưng nếu failover config không tồn tại, request vẫn có thể 200 (backend chính healthy).
  - False positive: tất cả checks pass nhưng failover chưa từng xảy ra.

Cách tránh:
  - Luôn kiểm tra X-LB-Failover header (không chỉ status 200).
  - Verify body role = "stable" (không phải "faulty").
```

**Historical false negative: Case 04/05 trước fix**

```text
Trước fix:
  - Default load gây 429 trên products_list.
  - http_req_failed cao -> nhìn như route bug.
  - Nhưng routing vẫn đúng: X-Upstream-Service=products-service.
  - False negative: kết luận "LB route sai" trong khi thực tế là contract mismatch.

Sau fix:
  - Default full-no-cdn pass case 04/05 với http_req_failed 0%.
  - Pattern này được giữ lại như bài học debug: nếu gặp lại 429, kiểm tra upstream header trước khi kết luận route bug.
```

**Dễ false negative thứ hai: Case 12 (Slow origin timeout)**

```text
Tại sao:
  - http_req_failed = 100% -> mọi framework CI/CD sẽ đỏ.
  - Người đọc output thấy 100% failed -> kết luận "timeout policy hỏng".

Cách tránh:
  - Đọc lb_timeout_504 và lb_timeout_unexpected.
  - Không set http_req_failed threshold cho case 12.
  - Hiểu rằng 504 là expected outcome của case này.
```

### 6.5. Interaction matrix

| Case | Cần upstream đặc biệt? | Cần state setup? | Để lại state? | Bị ảnh hưởng bởi case trước? | `http_req_failed` expected? |
| --- | --- | --- | --- | --- | --- |
| 01 | Không (app) | Không | Không | Không | 0.00% |
| 02 | Không (app) | Cần `ScaleApp 2` | Không | Không | 0.00% |
| 03 | Có (6 services) | Không | Không | Không | 0.00% |
| 04 | Có (products) | Sustained products traffic | Không | Có thể bị ảnh hưởng nếu rate-limit window bẩn | 0.00% expected; default run sau fix đạt 0.00% |
| 05 | Có (6 services) | Production-like service mix | Không | Có thể bị ảnh hưởng nếu rate-limit window bẩn | 0.00% expected; default run sau fix đạt 0.00% |
| 06 | Có (lb-stable-origin) | Faulty origin available | Không | Không | 0.00% |
| 07 | Có (lb-pressure-backend) | Pressure config | Có (rate limit window) | Không đáng kể | ~65% (expected) |
| 08 | Có (lb-canary-backend) | Canary split config | Không | Không | 0.00% |
| 09 | Có (lb-ejection-backend) | `RESET_WAIT_SECONDS` | Có (ejection state) | Có (cần reset) | 0.00% |
| 10 | Có (lb-canary-backend) | Canary fairness config | Không | Không | 0.00% |
| 11 | Có (lb-isolation-backend) | Isolation config | Không | Không | 0.00% |
| 12 | Có (lb-timeout-backend) | Timeout config | Không | Không | 100% (expected) |

---

## 7. Diễn giải quan trọng về pass/fail

### 7.1. `429` không phải bug (case 07)

```text
Nguyên tắc: Case 07 là pressure shedding test. 429 là expected signal.

Sai:    "HTTP failed 65% -> case 07 fail"
Đúng:   "Checks 100% + lb_pressure_unexpected = 0 -> pressure shedding đúng contract"

Đọc:    Không dùng http_req_failed làm pass/fail cho case 07.
        Dùng checks + custom counters (lb_pressure_200, lb_pressure_429, lb_pressure_unexpected).
```

### 7.2. `504` không phải bug (case 12)

```text
Nguyên tắc: Case 12 là timeout policy test. 504 là expected signal.

Sai:    "HTTP failed 100% -> case 12 fail"
Đúng:   "Checks 100% + lb_timeout_unexpected = 0 -> timeout policy đúng"

Đọc:    X-LB-Timeout-Policy=read_timeout=150ms cho biết policy.
        lb_timeout_504 = số request = 65.
        p95 duration ~153ms, gần 150ms policy.
```

### 7.3. `X-Cache` absent là mandatory

```text
Nguyên tắc: Tất cả case trong full-no-cdn phải không có X-Cache.

Nếu response có X-Cache:
  -> Đang chạy qua Varnish/CDN, không phải LB-only path.
  -> Toàn bộ LB proof (routing, failover, canary, pressure, timeout) bị nhiễu.
  -> Phải kiểm tra TargetLayer: dùng full-no-cdn hoặc lb-app, không dùng full.

Cách kiểm tra nhanh:
  curl -sI http://localhost:80/api/sim/products | grep -i x-cache
  # Expected: không có output
```

### 7.4. Upstream signal là primary proof (không phải status 200)

```text
Nguyên tắc: X-Upstream-Service mới là bằng chứng route đúng, không phải status 200.

Ví dụ thực tế từ case 04/05 default run fail:
  - Status trả 429 (rate limited)
  - Nhưng X-Upstream-Service vẫn là products-service
  -> Route đúng, nhưng rate limit cắt.
  -> Đây không phải route bug.

Tổng quát:
  - Status 200 + upstream sai = route sai (LB fail)
  - Status 429 + upstream đúng = route đúng + pressure (LB pass nếu case cho phép)
  - Status 504 + upstream đúng = route đúng + timeout (LB pass nếu case cho phép)
```

### 7.5. `http_req_failed` rate cần đọc theo context

| Case | `http_req_failed` | Có phải fail? | Cách đọc đúng |
| --- | ---: | --- | --- |
| 01-06, 08-10 | 0.00% | Không | Đúng như expected |
| 07 | ~65% | **Không** | Expected: 429 pressure shedding |
| 11 | 0.00% | Không | Cả fast lane và slow lane đều trả 200 |
| 12 | 100% | **Không** | Expected: 504 timeout policy |

### 7.6. Aggregate p95 gây hiểu nhầm

```text
Nguyên tắc: Không đọc aggregate p95 toàn suite cho LB validation.

Ví dụ thực tế:
  Case 11: fast lane p95 ~4ms, slow lane p95 ~616ms
  Aggregate p95 toàn case: ~600ms
  -> Kết luận sai: "hệ thống chậm"
  -> Kết luận đúng: "fast lane vẫn nhanh, slow lane bị cô lập tốt"

Cách đọc đúng: filter p95 theo tag endpoint.
  - http_req_duration{endpoint:lb_isolation_fast_demo} -> p95 ~4ms
  - http_req_duration{endpoint:lb_isolation_slow_demo} -> p95 ~616ms
```

### 7.7. Case 04/05: historical default failure đã được fix

```text
Trước fix:
  Default VU/duration của case 04/05 làm products_list trả 429.
  429 response vẫn có X-Upstream-Service=products-service -> route đúng.
  Kết luận cũ: contract mismatch giữa correctness case và pressure/rate-limit behavior.

Sau fix:
  Chạy lại default full-no-cdn, không dùng tuned env.
  Case 04: checks 6535/6535, http_req_failed 0.00%.
  Case 05: checks 4625/4625, http_req_failed 0.00%.
  Full profile 03-12: exit 0, pass 10/10.

Kết luận hiện tại:
  Issue 04/05 đã verify fixed.
  Targeted recheck 2026-06-24 cũng pass:
    case 04: 8180/8180, http_req_failed 0.00% (0/1636)
    case 05: 4580/4580, http_req_failed 0.00% (0/916)
  Không còn cần tuned env để pass correctness suite mặc định.
```

---

## 8. So sánh LB validation với CDN validation và executor validation

### 8.1. Bảng so sánh 3-way

| Khía cạnh | Executor validation | CDN validation | LB / Gateway validation |
| --- | --- | --- | --- |
| **Câu hỏi chính** | "Traffic shape có đúng không?" | "Cache contract có đúng không?" | "Route/failover/policy có đúng không?" |
| **Evidence chính** | RPS, VUs, latency (p95/p99), iterations | `X-Cache`, cache headers, origin counters | `X-Upstream-Service`, `X-LB-*`, distribution/counters |
| **Số liệu quan trọng** | `http_reqs`, `http_req_duration`, `iterations` | `checks`, `X-Cache` sequence, origin request counts | `checks`, upstream headers, custom counters |
| **Pass/fail criteria** | Thresholds (`rate>0.95`, `p(95)<200ms`) | Check 100% + header sequence + origin count | Check 100% + upstream signal + custom counters |
| **Non-2xx expected?** | Thường không | Case 11: 404 expected | Case 07: 429 expected; Case 12: 504 expected |
| **`http_req_failed` threshold** | Luôn set (`rate<0.01` hoặc `rate==0`) | Có case không set (case 11) | Có case không set (case 07, 12) |
| **Duration** | 10s-30m (load test) | 0.8ms-31s (correctness proof) | 1s-45s (correctness + moderate load) |
| **VUs** | 10-1000 (tạo tải) | 1 (tuần tự, trừ case 01) | 1-16 (tạo tải vừa phải, trừ case 01 sustained) |
| **Iterations** | Hàng nghìn đến hàng triệu | 1 (single-run proof) | 1 (single-run proof, trừ sustained case 01) |
| **Concurrent?** | Luôn có | Chỉ case 10 (coalescing) | Có (pressure case 07, fairness case 10, isolation case 11) |
| **Cần control plane?** | Không | Có (5/11 case) | Có (inspect + health check) |
| **Stateful?** | Ít | Nhiều (cache, origin profile, counter) | Vừa (ejection state, rate limit window, upstream health) |
| **Chạy song song?** | Có thể (nếu isolate) | Không (shared cache/control state) | Không (shared Nginx state) |
| **Chạy sai topology dễ nhầm?** | Ít | Có (qua `full` layer) | Rất có: `full` layer cho request đi CDN trước Nginx |
| **Chart quan trọng?** | Rất quan trọng | Phụ trợ | Phụ trợ nhưng hữu ích cho distribution/pressure |
| **Output chính** | Dashboard chart, summary statistics | Check list, header table, origin count | Check list, upstream signal table, custom counters |

### 8.2. Khi nào dùng từng loại validation?

```text
Executor validation:
  - Khi cần biết: "Hệ thống chịu được bao nhiêu RPS?"
  - Khi cần biết: "P95 latency ở 1000 VUs là bao nhiêu?"
  - Khi cần chứng minh: "Có thể scale lên N concurrent users"
  - Dùng: constant-vus, ramping-vus, shared-iterations

CDN validation:
  - Khi cần biết: "Cache có hoạt động đúng không?"
  - Khi cần biết: "Purge có invalidate object không?"
  - Khi cần biết: "Origin có bị gọi quá nhiều không?"
  - Dùng: single-VU, 1 iteration, control endpoints

LB / Gateway validation:
  - Khi cần biết: "Nginx route đúng upstream không?"
  - Khi cần biết: "Failover có hoạt động khi backend lỗi không?"
  - Khi cần biết: "Canary weight có ổn định dưới load không?"
  - Khi cần biết: "Timeout policy có cắt đúng ngưỡng không?"
  - Dùng: single-VU correctness + moderate VU cho pressure/isolation/fairness
```

### 8.3. Tại sao không thể dùng executor benchmark thay thế LB test?

1. **Executor benchmark không thấy `X-Upstream-Service`**: Benchmark chỉ quan tâm latency và throughput. Nó không kiểm tra request có được route đúng upstream hay không. Một request 200 có latency thấp vẫn có thể đến sai backend.

2. **Executor benchmark không phân biệt failover**: Benchmark thấy latency thấp và kết luận "tốt", nhưng không biết request đã qua failover từ faulty sang stable hay chưa.

3. **Executor benchmark không đọc được custom LB headers**: `X-LB-Failover`, `X-LB-Health-Mode`, `X-LB-Release-Channel`, `X-LB-Isolation-Class`, `X-LB-Timeout-Policy` -- tất cả đều vô hình với benchmark throughput.

4. **Executor benchmark không phân biệt expected non-200**: Với benchmark, 429 và 504 là failure cần tránh. Với LB test, 429 (case 07) và 504 (case 12) là expected outcomes cần verified.

5. **Executor benchmark không test được canary fairness định lượng**: Benchmark có thể thấy latency phân phối, nhưng không biết bao nhiêu % request đi canary. LB test dùng custom counter `lb_canary_observed` để đo chính xác.

---

## 9. Dashboard guide cho LB cases

### 9.1. Chart nào quan trọng cho từng case?

| Chart | Case liên quan | Cách đọc |
| --- | --- | --- |
| Checks rate over time | Tất cả | Phải 100% trừ khi đang diagnose failure; sau fix 04/05 default cũng phải giữ 100%. |
| HTTP failed rate | 04, 05, 07, 12 | 04/05 expected 0%; 07 expected cao do 429; 12 expected 100% do 504. |
| HTTP status codes | 07, 12 | 07 phải chỉ 200/429; 12 phải 504; status khác là bug. |
| HTTP duration by endpoint | 11, 12 | Fast lane p95 thấp, slow lane p95 cao; timeout p95 gần 150ms. |
| Request timeline | 04, 05, 07, 10, 11, 12 | Thấy sustained traffic, rate pressure, canary fairness, isolation lanes. |
| Custom metrics | 07, 10, 12 | `lb_pressure_*`, `lb_canary_observed`, `lb_timeout_*` là chart tốt hơn aggregate RPS. |
| VUs / iterations | 04, 05, 07 | So sánh default vs tuned VU count; kiểm tra load level. |

### 9.2. Chart không đủ để pass/fail

| Chart | Vì sao không đủ |
| --- | --- |
| Aggregate p95 toàn profile | Bị slow lane (case 11) và timeout (case 12) làm méo. |
| Aggregate `http_req_failed` | Case 07/12 expected failed cao; aggregate toàn suite dễ gây false alarm. |
| RPS tổng | Không chứng minh route đúng upstream. |
| 200 rate | Không chứng minh upstream đúng (có thể 200 từ sai backend). |
| Canary chart với sample nhỏ | Cần dải min/max, không đòi đúng 15.00%. |
| Hit ratio | Không liên quan đến LB validation (không có cache layer). |

### 9.3. Cách đọc chart của issue cũ 04/05 và trạng thái sau fix

Pattern cũ khi case 04/05 fail do rate-limit:

```text
checks rate drop khỏi 100%
http_req_failed spike (22% case 04, 19% case 05)
status chart xuất hiện 429 (không có trong expected)
fail chỉ tập trung ở endpoint products_list
các endpoint khác vẫn 200
X-Upstream-Service của request failed vẫn là products-service
```

Kết luận cũ đúng: không phải gateway route sai; đó là contract mismatch giữa correctness case và pressure policy.

Pattern sau fix trong default run:

```text
full default run:
  case 04 checks = 6535/6535, http_req_failed = 0.00%
  case 05 checks = 4625/4625, http_req_failed = 0.00%
targeted recheck 2026-06-24:
  case 04 checks = 8180/8180, http_req_failed = 0.00%
  case 05 checks = 4580/4580, http_req_failed = 0.00%
status chart chỉ có expected success cho 04/05
không còn 429 unexpected trên products_list
```

Kết luận hiện tại: fix đã được verify bằng default full-no-cdn suite, không cần tuned env để pass 04/05.

### 9.4. Cách export evidence

```powershell
# Export JSON summary cho từng case
k6 run .\load-target\k6\lb\07-rate-limit-and-connection-pressure.js `
  --summary-export lb-07-summary.json

# Export chi tiết từng event/check
k6 run .\load-target\k6\lb\07-rate-limit-and-connection-pressure.js `
  --out json=lb-07-results.json

# Lưu console output
k6 run .\load-target\k6\lb\07-rate-limit-and-connection-pressure.js 2>&1 |
  Tee-Object lb-07-console.txt

# Export toàn bộ profile qua runner (đã có sẵn output capture)
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn
```

---

## 10. Common invalid-result patterns

### 10.1. Bảng tổng hợp invalid-result patterns

| Pattern | Vì sao nguy hiểm | Cách đọc đúng | Case liên quan |
| --- | --- | --- | --- |
| Status 200 nhưng upstream sai | Gateway route nhầm service nhưng app vẫn trả OK | Kiểm `X-Upstream-Service` header | Tất cả, đặc biệt 03, 05 |
| Có `X-Cache` trong LB test | Đang chạy qua CDN/Varnish, không còn là LB-only proof | Dùng `TargetLayer=lb-app` hoặc `full-no-cdn` | Tất cả `full-no-cdn` case |
| Distribution chỉ thấy 1 instance | Scale app chưa đủ hoặc keepalive/session làm lệch sample | Case 02 cần `ScaleApp 2` và sample đủ | 02 |
| `429` bị coi là bug ở case 07 | Case pressure cố ý test shedding | Đọc `lb_pressure_200`, `lb_pressure_429`, `lb_pressure_unexpected` | 07 |
| `504` bị coi là bug ở case 12 | Timeout policy cố ý cắt slow origin | Đọc `X-LB-Timeout-Policy` và `lb_timeout_504` | 12 |
| All 200 nhưng failover không có header | Không chứng minh retry/failover thật | Cần `X-LB-Failover=faulty->stable` | 06 |
| Latency cao bị coi là LB fail | Slow lane/timeout case cố ý tạo latency | Đọc theo endpoint/tag, không đọc aggregate p95 | 11, 12 |
| `http_req_failed` threshold cứng | Case 07/12 có HTTP fail expected | Không set threshold cho case 07, 12 | 07, 12 |
| Chạy sai profile | `full` layer có CDN, làm nhiễu signal LB | Luôn dùng `lb-app` hoặc `full-no-cdn` cho LB proof | Tất cả |
| Không đọc custom counter | Chỉ nhìn aggregate HTTP metric -> kết luận sai | Luôn đọc `lb_pressure_*`, `lb_canary_observed`, `lb_timeout_*` | 07, 10, 12 |
| Không đợi reset giữa các case | Ejection state cũ ảnh hưởng case sau | Case 09 cần `RESET_WAIT_SECONDS` | 09 |
| Aggregate p95 toàn suite | Bị slow lane/timeout làm méo | Filter p95 theo `endpoint` tag | 11, 12 |

### 10.2. Phân tích chi tiết 3 pattern nguy hiểm nhất

**Pattern A -- Status 200 nhưng upstream sai (tất cả case, đặc biệt 03, 05)**

```text
Nguy hiểm: Tất cả request trả 200, chart xanh, dashboard đẹp.
           Nhưng X-Upstream-Service không khớp expected upstream.
           Request /auth đang bị route đến app thay vì auth-service.
           Người dùng vẫn thấy 200, nhưng authentication bị bypass.

Phát hiện: Chỉ có thể phát hiện qua X-Upstream-Service check.
           Dashboard và HTTP metrics không bao giờ phát hiện được.

Phòng tránh: Luôn assert upstream service trong mọi LB case.
             assertLBResponse() trong shared.js đã làm việc này.
             Không bao giờ bỏ qua upstream check.
```

**Pattern B -- `X-Cache` present trong LB test (tất cả case `full-no-cdn`)**

```text
Nguy hiểm: Mọi request đi qua Varnish/CDN trước Nginx.
           Toàn bộ header signal của LB bị Varnish che khuất.
           Kết quả pass/fail không còn ý nghĩa cho LB layer.

Phát hiện: X-Cache header xuất hiện trong response.
           X-Cache có thể là HIT, MISS, BYPASS, stale...

Phòng tránh:
  - Luôn dùng TargetLayer=lb-app hoặc full-no-cdn, không bao giờ full.
  - Preflight check: curl -sI http://localhost:80/ | grep -i x-cache
  - assertLBResponse() đã check "no cache header".
```

**Pattern C -- `http_req_failed` cao bị coi là bug (case 07, 12)**

```text
Nguy hiểm: CI/CD pipeline tự động fail vì http_req_failed vượt threshold.
           Team bị block deploy vì "test fail".
           Nhưng thực tế case 07 và 12 pass -- expected non-200 đã được verify.

Phát hiện: checks rate = 100% nhưng http_req_failed cao.
           Custom counters (lb_pressure_unexpected, lb_timeout_unexpected) = 0.

Phòng tránh:
  - Không set http_req_failed threshold cho case 07 và 12.
  - CI/CD pipeline cần phân biệt expected vs unexpected HTTP failures.
  - Đọc checks và custom counters, không đọc aggregate HTTP failed rate.
```

### 10.3. Debug process flowchart

```text
Case fail?
  ├── Checks < 100%?
  │     ├── Setup checks fail? -> Preflight issue (stack, routing, health)
  │     ├── Status code checks fail?
  │     │     ├── 429 trên products_list (case 04/05)? -> Contract mismatch; dùng tuned env
  │     │     ├── 429 trên case 07? -> Xem lb_pressure_unexpected; có thể pass
  │     │     └── Status khác? -> App/Nginx issue
  │     ├── Upstream checks fail? -> Route config sai trong Nginx
  │     ├── Header checks fail?
  │     │     ├── X-Cache present? -> Sai TargetLayer (đang qua CDN)
  │     │     ├── X-LB-Failover missing? -> Failover config thiếu
  │     │     ├── X-LB-Health-Mode missing? -> Passive health check không được cấu hình
  │     │     └── X-LB-Timeout-Policy missing? -> Timeout config thiếu
  │     └── Custom counter checks fail? -> Nginx behavior không đúng contract
  │
  └── Throw Error (không phải check fail)?
        ├── "got 0" -> Request không đến được upstream
        ├── "connection refused" -> Upstream backend không chạy
        └── "timeout" -> Upstream backend treo hoặc Nginx config sai
```

### 10.4. Error frequency by type

Dựa trên kinh nghiệm chạy thực tế:

| Loại lỗi | Case thường gặp | Tần suất | Mức độ nghiêm trọng |
| --- | --- | --- | --- |
| Historical contract mismatch (rate limit) | 04, 05 trước fix | Đã fix | Giữ làm bài học debug; default run hiện đã pass |
| Sai TargetLayer (X-Cache present) | Tất cả `full-no-cdn` | Trung bình (first run) | Cao -- toàn bộ proof bị vô hiệu |
| Route config sai | 03, 05 | Thấp | Cao -- request đến sai service |
| Stack chưa sẵn sàng | Tất cả | Trung bình (first run) | Thấp -- đợi stack healthy là xong |
| `http_req_failed` threshold sai | 07, 12 | Cao (nếu copy config) | Thấp -- bỏ threshold là xong |
| Ejection state cũ chưa reset | 09 | Cao (nếu chạy thủ công) | Trung bình -- tăng RESET_WAIT_SECONDS |
| Custom counter không hoạt động | 07, 10, 12 | Thấp | Cao -- không verify được special proof |

---

## 11. Historical case 04/05 contract mismatch analysis

### 11.1. Vấn đề cũ và trạng thái hiện tại

Trước fix, default case 04 (`04-origin-cacheable-read.js`) và case 05 (`05-origin-service-mix.js`) không pass trong profile `full-no-cdn` với cấu hình mặc định. Sau fix, chạy lại default profile `full-no-cdn` đã pass 10/10; case 04/05 hiện xanh.

**Evidence từ default run**:

```text
Case 04 default:
  Exit: 99
  Checks: 11396/11930 (95.52%)
  http_req_failed: 22.38%
  products_list status: 99 pass / 534 fail

Case 05 default:
  Exit: 99
  Checks: 20946/21770 (96.22%)
  http_req_failed: 18.92%
  products_list status: 77 pass / 824 fail
```

**Manual probe**:

```text
120 concurrent requests to /api/sim/products
Results: 100 x 200, 20 x 429
429 responses still had:
  X-Upstream-Service: products-service
  X-Request-ID: <uuid>
  X-Cache: absent
```

### 11.2. Phân tích

Đây không phải route bug vì:

1. **Failed response vẫn route đúng upstream**: `X-Upstream-Service=products-service` trên cả response 200 và 429.
2. **Nginx/Gateway signal vẫn có**: `X-Request-ID` có mặt, `X-Cache` vắng mặt.
3. **Tuned run pass khi giảm tải**: giảm VUs xuống 1-2, giảm duration xuống 5-10s -> case 04/05 pass hoàn toàn.
4. **Pressure/timeout cases (07, 12) đã có semantics riêng cho expected 429/504**: case 04/05 không khai báo 429 là expected.

### 11.3. Root cause

**Contract mismatch** giữa:

| Thành phần | Contract hiện tại | Thực tế runtime |
| --- | --- | --- |
| Case 04/05 assertion | Tất cả request phải 200 (correctness contract) | `/api/sim/products` có rate limit, trả 429 khi vượt ngưỡng |
| Default env VUs | 6-16 VUs (case 04), 12 VUs (case 05) | Rate limit bắt đầu từ ~120 concurrent |
| Default duration | 20-45s | Đủ dài để trigger rate limit window |

### 11.4. Kết luận sau fix

Fix đã được verify bằng default run và targeted recheck, không cần tuned env:

```text
full-no-cdn default runtime: exit 0
case 04: checks 6535/6535, http_req_failed 0.00% (0/1307)
case 05: checks 4625/4625, http_req_failed 0.00% (0/925)

targeted recheck 2026-06-24: runner exit 0
case 04: checks 8180/8180, http_req_failed 0.00% (0/1636), p95=189.56ms
case 05: checks 4580/4580, http_req_failed 0.00% (0/916), p95=154.57ms
```

Khuyến nghị còn lại chỉ là vận hành tài liệu/debug:

- Giữ historical analysis này để nếu 04/05 tái xuất hiện 429, team biết kiểm tra `X-Upstream-Service` trước khi kết luận route bug.
- Không cần tuned env cho CI correctness gate nữa.
- Nếu sau này muốn test pressure trên `/api/sim/products`, nên tạo case pressure riêng thay vì làm 04/05 fail.

---

## 12. Maturity model

### 12.1. Các cấp độ

**Cấp độ 1 -- Smoke only (case 01, 02)**:

```text
Biết: Nginx public entrypoint hoạt động; traffic được phân phối qua nhiều app instance.
Chưa biết: Service boundary routing, failover, canary, pressure, timeout.
Rủi ro: Request có thể route sai service; backend lỗi không được failover.
```

**Cấp độ 2 -- Core routing (case 01-05)**:

```text
Biết: Entrypoint + distribution + 6 service boundaries + sustained origin traffic.
Chưa biết: Failover, pressure shedding, canary, ejection, isolation, timeout.
Rủi ro: Backend lỗi -> user thấy lỗi; backend chậm -> kéo sập cả hệ thống.
```

**Cấp độ 3 -- Advanced policies (case 01-10)**:

```text
Biết: Thêm failover, pressure shedding, canary routing, passive ejection, canary fairness.
Chưa biết: Saturation isolation, timeout policy.
Rủi ro: Slow origin kéo sập fast origin; slow request treo connection vô hạn.
```

**Cấp độ 4 -- Full contract (tất cả 12 case)**:

```text
Biết: Toàn bộ LB/Gateway contract: routing, distribution, failover, pressure, canary,
      ejection, fairness, isolation, timeout.
Rủi ro: Minimal -- mọi edge case đã được test.
Đây là trạng thái mong muốn trước khi deploy production.
```

### 12.2. Lộ trình áp dụng cho team mới

```text
Tuần 1: Chạy case 01-03 (Entry smoke, App distribution, Domain boundaries)
        -> Nắm cơ bản về Nginx routing và upstream verification.

Tuần 2: Chạy case 04-06 (Cacheable read, Service mix, Retry/failover)
        -> Hiểu sustained traffic, multi-service routing, failover mechanism.

Tuần 3: Chạy case 07-10 (Pressure, Canary, Ejection, Fairness)
        -> Hiểu advanced policies: shedding, weighted routing, health check,
           fairness under load.

Tuần 4: Chạy case 11-12 (Isolation, Timeout)
        -> Hiểu edge cases: lane isolation, timeout policy.
        -> Tích hợp vào CI/CD: chạy tự động mỗi khi deploy Nginx config mới.
```

### 12.3. Tự đánh giá hiện tại

| Scope | Maturity level | Trạng thái |
| --- | --- | --- |
| `lb-app` profile (case 01-02) | Level 1 | PASS -- smoke + distribution verified |
| `full-no-cdn` route/inspect | Level 2 | PASS -- 37/37 routes verified |
| `full-no-cdn` default runtime (case 03-12) | Level 4 | PASS -- full contract verified after 04/05 fix |
| Historical 04/05 issue | Level 2-3 lesson | FIXED -- default run no longer needs tuned env |
| CI/CD integration | Chưa triển khai | Pending |

---

## 13. Bài học từ thực tế chạy

### 13.1. Tầm quan trọng của runner script

Runner script `run-lb-capabilities.ps1` không chỉ là convenience -- nó đảm bảo:

- Chạy tuần tự các case theo thứ tự đúng.
- Set env vars phù hợp cho từng profile.
- Chạy inspect trước để validate script syntax.
- Capture output cho audit trail.

Chạy thủ công từng case bằng `k6 run` dễ dẫn đến:
- Quên set env vars -> case fail không rõ nguyên nhân.
- Chạy sai TargetLayer -> X-Cache xuất hiện, toàn bộ proof vô hiệu.
- Không chạy inspect trước -> script syntax error bị bỏ qua.

### 13.2. Tại sao thứ tự case quan trọng

```text
Thứ tự chạy trong runner script: 01 -> 02 -> 03 -> ... -> 12

Case 09 (Passive ejection):
  - Có RESET_WAIT_SECONDS để đợi ejection state cũ hết hạn.
  - Nếu case 09 được chạy ngay sau một case khác cũng dùng cùng upstream,
    ejection state từ lần chạy trước có thể còn hiệu lực.
  - Runner script đảm bảo sleep đủ trước case 09.

Case 04/05 và case 07:
  - Dùng chung /api/sim/products path.
  - Case 07 tạo áp lực cao -> rate limit window có thể còn hiệu lực.
  - Nếu case 04/05 chạy ngay sau case 07 -> khả năng fail cao hơn.
  - Runner script chạy case 04/05 trước case 07.

Case 09-12:
  - Mỗi case dùng upstream riêng (ejection, canary, isolation, timeout).
  - Ít ảnh hưởng chéo hơn.
  - Nhưng vẫn cần đảm bảo Nginx health ổn định giữa các case.
```

### 13.3. First-run failure patterns

Các pattern fail phổ biến trong lần chạy đầu tiên:

1. **Stack chưa sẵn sàng**: Docker containers chưa fully initialized. Backend services chưa listen. Nginx chưa load config mới.
   - **Fix**: Đợi 30-60 giây sau `stack.ps1 up`, chạy preflight checklist.

2. **Sai TargetLayer**: Dùng `TargetLayer=full` thay vì `full-no-cdn` -> X-Cache xuất hiện.
   - **Fix**: Kiểm tra `X-Cache` absent trong preflight. Dùng đúng `TargetLayer`.

3. **Historical 04/05 rate-limit issue**: Trước fix, default env làm products path trả 429.
   - **Trạng thái hiện tại**: Đã fix; default full-no-cdn pass. Nếu tái xuất hiện, kiểm `X-Upstream-Service` và status distribution.

4. **Ejection state cũ chưa reset (case 09)**:
   - **Fix**: Tăng `LB_EJECTION_RESET_WAIT_SECONDS` nếu fail_timeout > 5s.

### 13.4. Historical tuned vs default comparison

| Khía cạnh | Trước fix: default run | Trước fix: tuned run | Sau fix: default run |
| --- | --- | --- | --- |
| Mục đích | Phát hiện contract mismatch | Verify correctness thuần túy | CI/CD correctness gate chính |
| Case 04/05 VUs | 6-16 (case 04), 12 (case 05) | 1-2 | default values |
| Case 04/05 duration | 20-45s | 5-10s | default values |
| Kết quả case 04/05 | FAIL do 429 | PASS | PASS |
| Giá trị | Bài học debug về rate-limit | Chứng minh route đúng | Chứng minh fix đã ổn định |
| Nên dùng khi nào? | Chỉ để đọc historical issue | Không cần cho gate chính | Dùng mặc định |

Kết luận hiện tại: không cần chạy tuned env để pass nữa. Giữ bảng này như audit trail để hiểu vì sao từng có failure và cách phân biệt route bug với pressure/rate-limit behavior.

---

## 14. Current validation conclusion

### 14.1. Summary table

| Scope | Profile | Cases | Result | Ghi chú |
| --- | --- | --- | --- | --- |
| Entrypoint + Distribution | `lb-app` | 01, 02 | **PASS 2/2** | Nginx public entrypoint hoạt động; multi-instance distribution verified |
| Route/Inspect | `full-no-cdn` | preflight | **PASS** | 37/37 routes pass; inspect exit 0 |
| Domain boundaries | `full-no-cdn` | 03 | **PASS** | 6 service boundaries verified |
| Cacheable read (default after fix) | `full-no-cdn` | 04 | **PASS** | 6535/6535, HTTP failed 0.00%; historical 429 issue fixed |
| Service mix (default after fix) | `full-no-cdn` | 05 | **PASS** | 4625/4625, HTTP failed 0.00%; historical 429 issue fixed |
| Retry/Failover | `full-no-cdn` | 06 | **PASS** | `X-LB-Failover=faulty->stable` verified |
| Pressure shedding | `full-no-cdn` | 07 | **PASS** | 200 + expected 429; unexpected = 0 |
| Weighted canary | `full-no-cdn` | 08 | **PASS** | Forced channels + weighted band verified |
| Passive ejection | `full-no-cdn` | 09 | **PASS** | `X-LB-Health-Mode=passive-ejection` verified |
| Canary fairness | `full-no-cdn` | 10 | **PASS** | Canary share 12.62% in expected band |
| Saturation isolation | `full-no-cdn` | 11 | **PASS** | Fast lane p95 ~4ms despite slow lane ~616ms |
| Slow timeout | `full-no-cdn` | 12 | **PASS** | 504 timeout; `X-LB-Timeout-Policy=read_timeout=150ms` |
| **Tổng kết `full-no-cdn` default sau fix** | `full-no-cdn` | 03-12 | **PASS 10/10** | Full contract verified with default runner |
| **Tổng kết toàn bộ suite default sau fix** | both | 01-12 | **PASS 12/12** | Tất cả LB capability cases pass |

### 14.2. Actionable issues

| # | Issue | Ưu tiên | Hành động |
| --- | --- | --- | --- |
| 1 | Historical case 04/05 unexpected 429 | Done | Verified fixed: default full-no-cdn now passes case 04/05 with 0.00% HTTP failed |
| 2 | Chưa có CI/CD integration | Thấp | Tích hợp `run-lb-capabilities.ps1` vào pipeline; chạy sau mỗi lần deploy Nginx config |
| 3 | Chưa có dashboard export cho audit | Thấp | Thêm `--out json` và `--summary-export` cho từng case; lưu output artifacts |

---

## 15. Reference

### 15.1. Source files

| File | Đường dẫn | Mô tả |
| --- | --- | --- |
| Overview | `./00_overview.md` | Tổng quan series LB và mental model |
| Run guide | `./RUN_GUIDE.md` | Hướng dẫn chạy tất cả LB case |
| Case 01-12 docs | `./01_entry-smoke.md` đến `./12_slow-origin-timeouts.md` | Tài liệu chi tiết từng case |
| Source scripts | `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/*.js` | k6 test scripts cho từng LB case |
| Shared helper | `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/shared.js` | Hàm `requestLB`, `assertLBResponse`, `responseHeader`, `lbCapabilityApis` |
| Common helpers | `E:/Projects/k6/k6-metrics-server/load-target/k6/shared/common.js` | Hàm `envInt`, `envFloat`, `envString` |
| Case catalog | `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/case-catalog.json` | Structured metadata cho tất cả LB cases |
| Nginx config | `E:/Projects/k6/k6-metrics-server/load-target/nginx/nginx.conf` | Cấu hình Nginx upstream, routing, health check, timeout |
| Runner script | `E:/Projects/k6/k6-metrics-server/scripts/run-lb-capabilities.ps1` | PowerShell runner cho toàn bộ LB suite |
| Routing check script | `E:/Projects/k6/k6-metrics-server/scripts/check-target-routing.ps1` | Preflight route contract verification |
| Stack script | `E:/Projects/k6/k6-metrics-server/scripts/stack.ps1` | Docker stack management |

### 15.2. Key headers reference

| Header | Xuất hiện ở case | Ý nghĩa |
| --- | --- | --- |
| `X-Served-By` | Tất cả | Xác nhận request qua Nginx |
| `Server` | Tất cả | `nginx/...` -- chứng minh LB layer |
| `X-Upstream-Service` | Tất cả | Upstream backend thật mà Nginx route đến -- evidence quan trọng nhất |
| `X-Request-ID` | Tất cả | Gateway trace ID |
| `X-Cache` | **Phải vắng mặt** | Nếu có -> đang qua CDN, sai topology |
| `X-LB-Failover` | 06 | `faulty->stable` -- bằng chứng failover |
| `X-LB-RateLimit` | 07 | Rate limit signal |
| `X-LB-Release-Channel` | 08, 10 | `stable` hoặc `canary` |
| `X-LB-Health-Mode` | 09 | `passive-ejection` -- bằng chứng ejection |
| `X-LB-Upstream-Status` | 09 | `503, 200` hoặc `200` -- lịch sử retry |
| `X-LB-Isolation-Class` | 11 | `fast` hoặc `slow` |
| `X-LB-Timeout-Policy` | 12 | `read_timeout=150ms` -- timeout config |

### 15.3. Key custom counters reference

| Counter | Case | Ý nghĩa |
| --- | --- | --- |
| `lb_pressure_200` | 07 | Số request accepted dưới pressure |
| `lb_pressure_429` | 07 | Số request bị shed (expected) |
| `lb_pressure_unexpected` | 07 | Số request có status không phải 200/429 (phải = 0) |
| `lb_canary_observed` | 10 | Phần trăm request đi canary channel |
| `lb_timeout_504` | 12 | Số request timeout đúng policy |
| `lb_timeout_unexpected` | 12 | Số request có status không phải 504 (phải = 0) |

### 15.4. External references

| Tài liệu | Mô tả |
| --- | --- |
| Nginx Upstream Module | https://nginx.org/en/docs/http/ngx_http_upstream_module.html -- `max_fails`, `fail_timeout`, `proxy_next_upstream` |
| Nginx Split Clients | https://nginx.org/en/docs/http/ngx_http_split_clients_module.html -- Canary weighted routing |
| Nginx Passive Health Check | https://docs.nginx.com/nginx/admin-guide/load-balancer/http-health-check/ |
| k6 docs: Checks | https://k6.io/docs/using-k6/checks/ |
| k6 docs: Thresholds | https://k6.io/docs/using-k6/thresholds/ |
| k6 docs: Tags | https://k6.io/docs/using-k6/tags-and-groups/ |
| k6 docs: Custom metrics | https://k6.io/docs/using-k6/metrics/#custom-metrics |

---

> **Tổng kết**: LB / Gateway validation khác biệt cơ bản với cả executor validation và CDN validation. Trong khi executor hỏi "hệ thống nhanh không?" và CDN hỏi "cache có đúng không?", LB validation hỏi "Nginx route, failover, canary, pressure, và timeout có đúng contract không?". Ba câu hỏi bổ trợ nhau và đều cần thiết trước khi deploy lên production. 12 LB cases trong series này bao phủ toàn bộ Gateway contract: từ public entrypoint cơ bản, app instance distribution, service boundary routing, sustained origin traffic, retry/failover, rate/connection pressure, weighted canary routing, passive outlier ejection, canary fairness under load, saturation isolation, đến slow origin timeout policy. Mỗi case là một mảnh ghép của bức tranh "public Gateway correctness". Evidence chính không phải là status 200 -- mà là upstream signal, custom counters, và header proof. Historical issue 04/05 unexpected 429 đã được verify fixed bằng default full-no-cdn run mới. Case 07 và 12 có `http_req_failed` cao nhưng pass vì expected non-2xx đã được phân loại chính xác qua custom counters.
