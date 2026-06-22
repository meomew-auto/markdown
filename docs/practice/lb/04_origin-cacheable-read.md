# Case 04: Origin cacheable read without CDN

> **Case ID:** `lb-04-origin-cacheable-read`  
> **Script:** `04-origin-cacheable-read.js`  
> **Profile:** `full-no-cdn`  
> **Proof:** cacheable product reads đi origin qua LB, không bị CDN cache che khuất

## 1. Tình huống thực tế

Sau CDN, một số traffic cacheable vẫn có thể đi xuống origin khi cache MISS/bypass/expired. LB phải route product reads tới `products-service` và giữ signal rõ ràng rằng request không đi qua CDN.

## 2. Capability được chứng minh

Case này dùng traffic pattern warmup/measurement cho product endpoints:

- product list;
- detail;
- categories;
- search;
- recommendations;
- homefeed.

Mỗi response phải có upstream `products-service` và không có `X-Cache`.

## 3. Topology và precondition

```powershell
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
```

Default load của case có thể chạm rate-limit ở `/api/sim/products` trong môi trường hiện tại. Nếu mục tiêu là correctness-only, dùng tuned env trong validation report.

## 4. Request sequence

1. warmup VUs chạy cacheable product traffic;
2. measurement VUs tiếp tục traffic;
3. mỗi request assert status expected, upstream, request id, no cache.

## 5. Pass/fail criteria

PASS khi tất cả product reads status expected và upstream `products-service`.

FAIL khi:

- có `X-Cache`;
- route không phải `products-service`;
- status `429` xuất hiện trong correctness mode vì case này chưa định nghĩa 429 là expected.

## 6. Cách chạy

Default:

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 04-origin-cacheable-read
```

Tuned correctness run đã pass:

```powershell
$env:LB_CACHEABLE_WARMUP_VUS = "1"
$env:LB_CACHEABLE_MEASUREMENT_VUS = "2"
$env:LB_CACHEABLE_WARMUP_DURATION = "5s"
$env:LB_CACHEABLE_MEASUREMENT_DURATION = "10s"
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 04-origin-cacheable-read
```

## 7. Chart reading

Default failure pattern:

- checks drop khỏi 100%;
- HTTP failed tăng;
- status chart có `429`;
- failures tập trung ở `products_list`.

Nếu đọc chart mà không nhìn endpoint/tag, dễ kết luận sai là toàn bộ products routing hỏng.

## 8. Real validation data

Default run:

```text
Exit: 99
Checks: 11396/11930
HTTP failed: 22.38%
Failure: products_list status check failed due 429
```

Tuned run:

```text
Exit: 0
Checks: 1160/1160
HTTP failed: 0.00% (0/232)
Result: PASS tuned correctness
```

Manual probe:

```text
120 concurrent /api/sim/products -> 100 x 200, 20 x 429
```

## 9. Reference

- Overview: `./00_overview.md`
- Validation: `./13_validation-and-chart-analysis.md`
- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/04-origin-cacheable-read.js`
