# Case 05: Origin service mix

> **Case ID:** `lb-05-origin-service-mix`  
> **Script:** `05-origin-service-mix.js`  
> **Profile:** `full-no-cdn`  
> **Proof:** production-like mix route đúng upstream services

## 1. Tình huống thực tế

Production traffic không chỉ gọi một endpoint. Nó trộn products, auth, cart, orders, report, payment webhook. Gateway phải route đúng service trong mix này.

## 2. Capability được chứng minh

Case này dùng weighted production mix và assert từng request:

- expected status;
- served by nginx;
- `X-Upstream-Service` đúng;
- `X-Request-ID` present;
- không có `X-Cache`.

## 3. Topology và precondition

```powershell
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
$env:BASE_URL = "http://localhost:80"
```

## 4. Request sequence

1. constant VUs chạy trong duration mặc định;
2. mỗi iteration pick API từ production mix;
3. assert route theo prefix/service mapping.

## 5. Pass/fail criteria

PASS khi tất cả endpoints trong mix route đúng và status expected.

FAIL khi:

- route nhầm upstream;
- một endpoint bị unexpected `429/5xx` trong correctness mode;
- `X-Cache` xuất hiện.

## 6. Cách chạy

Default:

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 05-origin-service-mix
```

Tuned correctness run:

```powershell
$env:LB_MIX_VUS = "2"
$env:LB_MIX_DURATION = "10s"
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 05-origin-service-mix
```

## 7. Chart reading

Chart hữu ích nhất là status code by endpoint. Default failure hiện tại tập trung ở `products_list`, không phải toàn bộ service mix.

## 8. Real validation data

Default batch run:

```text
Exit: 99
Checks: 20946/21770
HTTP failed: 18.92%
Failure: products_list origin mix status failed due 429
```

Tuned run:

```text
Exit: 0
Checks: 815/815
HTTP failed: 0.00% (0/163)
Result: PASS tuned correctness
```

## 9. Reference

- Overview: `./00_overview.md`
- Validation: `./13_validation-and-chart-analysis.md`
- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/05-origin-service-mix.js`
