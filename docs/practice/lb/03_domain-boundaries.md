# Case 03: Domain boundary routing

> **Case ID:** `lb-03-domain-boundaries`  
> **Script:** `03-domain-boundaries.js`  
> **Profile:** `full-no-cdn` / `TargetLayer=full-no-cdn`  
> **Proof:** Nginx route đúng boundary app/auth/cart/order/products/report

## 1. Tình huống thực tế

Gateway phải route theo domain boundary. Một request auth không được đi sang cart, product list không được đi sang app monolith, report jobs không được đi sang order service.

## 2. LB capability được chứng minh

Case này probe representative endpoint của từng service và assert `X-Upstream-Service`.

| Endpoint family | Expected upstream |
| --- | --- |
| `/` | app |
| `/api/sim/auth/*` | auth-service |
| `/api/sim/cart*` | cart-service |
| `/api/sim/checkout`, `/api/sim/orders/*` | order-service |
| `/api/sim/products*` | products-service |
| `/api/sim/report*` | report-service |

## 3. Topology và precondition

```powershell
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
$env:BASE_URL = "http://localhost:80"
```

`full-no-cdn` quan trọng vì cần full services nhưng không có CDN.

## 4. Request sequence

Script chạy 1 iteration, lần lượt gọi 6 representative routes và check:

- status expected;
- served by nginx;
- upstream matches;
- request id present;
- no cache header.

## 5. Pass/fail criteria

PASS khi tất cả boundary checks pass.

FAIL khi:

- `X-Upstream-Service` sai;
- một route trả 404/5xx ngoài expected;
- có `X-Cache`, chứng tỏ chạy nhầm topology.

## 6. Cách chạy

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 03-domain-boundaries
```

## 7. Chart reading

Không cần chart sâu. Đây là correctness probe ngắn; chart chỉ xác nhận không có HTTP failed và checks 100%.

## 8. Real validation data

```text
Exit: 0
Checks: 31/31
HTTP failed: 0.00% (0/6)
Result: PASS
```

## 9. Reference

- Overview: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Validation: `./13_validation-and-chart-analysis.md`
- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/03-domain-boundaries.js`
