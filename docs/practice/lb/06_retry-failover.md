# Case 06: Retry and failover

> **Case ID:** `lb-06-retry-failover`  
> **Script:** `06-retry-failover.js`  
> **Profile:** `full-no-cdn`  
> **Proof:** faulty origin được failover sang stable origin

## 1. Tình huống thực tế

Khi một upstream lỗi, Gateway không nên trả lỗi ngay nếu có stable fallback. Case này chứng minh route failover được cấu hình và signal rõ ràng.

## 2. Capability được chứng minh

Expected flow:

```text
request /api/lb/failover-demo
-> primary faulty origin lỗi
-> Nginx intercept/failover
-> stable origin trả 200
```

Signal quan trọng: `X-LB-Failover=faulty->stable`.

## 3. Key signals

| Signal | Expected |
| --- | --- |
| status | 200 |
| `X-Upstream-Service` | `lb-stable-origin` |
| `X-LB-Failover` | `faulty->stable` |
| body role | stable |
| `X-Cache` | absent |

## 4. Cách chạy

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 06-retry-failover
```

## 5. Chart reading

Một request duy nhất, chart ít giá trị. Proof chính là header failover và body stable.

## 6. Real validation data

```text
Exit: 0
Checks: 7/7
HTTP failed: 0.00% (0/1)
Result: PASS
```

## 7. Reference

- Overview: `./00_overview.md`
- Validation: `./13_validation-and-chart-analysis.md`
- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/06-retry-failover.js`
