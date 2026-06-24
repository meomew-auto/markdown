# LB/Nginx layer: routing semantics trước capacity

## 1. Vì sao sau CDN là LB/Gateway?

CDN/Varnish quyết định request nào được cache/offload và request nào bypass xuống origin. Khi request đã đi vào origin path, layer tiếp theo là **LB/Gateway**, hiện thực bằng Nginx.

```text
CDN question: request có được cache/bypass đúng không?
LB question: request vào origin có được route/failover/limit/timeout đúng không?
```

Nếu LB sai, backend có thể vẫn trả 200 nhưng request đi nhầm service, canary sai tỷ lệ, failover không xảy ra, hoặc slow origin kéo sập fast lane.

## 2. Mental model

```text
client/k6 -> http://localhost:80 -> Nginx Gateway -> app replicas / microservices / LB demo origins
```

Có hai profile học:

| Profile | Dùng cho | Ý nghĩa |
| --- | --- | --- |
| `lb-app` | cases 01-02 | kiểm Nginx entrypoint và app replica distribution |
| `full-no-cdn` | cases 03-12 | kiểm full origin routing nhưng không qua CDN |

Không dùng `TargetLayer=full` cho LB proof vì `full` thêm Varnish phía trước.

## 3. LB correctness không chỉ là status 200

Các signal cần đọc:

```text
X-Served-By / Server
X-Upstream-Service
X-Request-ID
X-LB-Failover
X-LB-Release-Channel
X-LB-Health-Mode
X-LB-Upstream-Status
X-LB-Isolation-Class
X-LB-Timeout-Policy
absence of X-Cache
```

Ví dụ:

```text
status 200 + X-Upstream-Service sai = route fail
status 429 trong case 07 = expected pressure shedding
status 504 trong case 12 = expected timeout policy
status 200 without X-LB-Failover in case 06 = chưa chứng minh failover
```

## 4. 12 capability proofs

| Case | Capability | Lesson |
| --- | --- | --- |
| 01 | Entry smoke | Public `:80` thật sự đi qua Nginx và tới app. |
| 02 | App distribution | Nginx phân phối qua nhiều app replicas khi `ScaleApp=2`. |
| 03 | Domain boundaries | Service boundary routing đúng app/auth/cart/order/products/report. |
| 04 | Cacheable reads without CDN | Product reads đi origin qua LB, không còn CDN cache. |
| 05 | Origin service mix | Mix realistic routes tới đúng service. |
| 06 | Retry/failover | Faulty origin fallback sang stable. |
| 07 | Rate/connection pressure | Nginx shed load bằng 429 đúng contract. |
| 08 | Weighted canary | Stable/canary route theo force header và weight. |
| 09 | Passive outlier ejection | Flaky upstream bị loại/fallback đúng policy. |
| 10 | Weighted fairness under load | Canary share vẫn nằm trong band dưới load. |
| 11 | Saturation isolation | Slow lane không làm fast lane chậm. |
| 12 | Slow origin timeout | Nginx timeout slow origin theo policy 150ms. |

## 5. Kết quả validation hiện tại

- `lb-app`: pass 2/2.
- `full-no-cdn` health/routing/inspect: pass.
- `full-no-cdn` default runtime sau fix: pass 10/10 cho cases 03-12.
- Case 04/05 từng fail vì `/api/sim/products` trả unexpected 429 dưới traffic mặc định; đã recheck lại và verify fixed. Targeted recheck 2026-06-24 pass: case 04 `8180/8180`, case 05 `4580/4580`, HTTP failed đều `0.00%`.
- Cases 07/12 vẫn có non-2xx expected theo đúng semantics riêng: expected 429 ở case 07, expected 504 ở case 12.

Kết luận hiện tại: LB/Gateway layer đã xanh với default runner ở cả hai profile (`lb-app` và `full-no-cdn`).

## 6. Chart reading

Với LB, chart hữu ích để nhìn pattern nhưng không thay proof:

- checks rate: pass/fail tổng;
- status codes: phân biệt 200/429/504 expected;
- latency by endpoint: fast vs slow lane;
- custom counters: `lb_pressure_*`, `lb_canary_observed`, `lb_timeout_*`;
- request timeline: thấy pressure burst, canary load, timeout policy.

Không nên kết luận từ aggregate p95 hoặc aggregate failed rate vì case 07/12 cố ý tạo non-2xx.

## 7. Practice pack

- Overview: `docs/practice/lb/00_overview.md`
- Run guide: `docs/practice/lb/RUN_GUIDE.md`
- Validation/chart analysis: `docs/practice/lb/13_validation-and-chart-analysis.md`
