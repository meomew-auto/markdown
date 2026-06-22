# Case 09: Passive outlier ejection

> **Case ID:** `lb-09-passive-outlier-ejection`  
> **Script:** `09-passive-outlier-ejection.js`  
> **Profile:** `full-no-cdn`  
> **Proof:** Nginx tránh/fallback khỏi flaky origin sau failure signal

## 1. Tình huống thực tế

Một backend trong upstream pool có thể flaky: lúc trả 503, lúc trả 200. Passive outlier ejection giúp Gateway ngừng chọn backend lỗi trong một khoảng `fail_timeout`.

## 2. Capability được chứng minh

Case này chứng minh Nginx passive health behavior:

```text
first request có thể thấy upstream status 503,200
follow-up request đi stable/fallback và trả 200
header X-LB-Health-Mode = passive-ejection
```

## 3. Key signals

| Signal | Expected |
| --- | --- |
| status | 200 cuối cùng |
| `X-LB-Health-Mode` | `passive-ejection` |
| `X-LB-Upstream-Status` | thể hiện upstream attempt/fallback |
| `X-Upstream-Service` | `lb-ejection-backend` |
| checks | 100% |

## 4. Pass/fail criteria

PASS khi Gateway không để flaky origin làm user-facing request fail và header health-mode đúng.

FAIL khi:

- user nhận 503;
- không có header passive-ejection;
- follow-up không recover/fallback;
- ejection state làm case sau bị ảnh hưởng.

## 5. Cách chạy

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 09-passive-outlier-ejection
```

## 6. Chart reading

Request count ít nên chart không quan trọng. Nếu có dashboard, xem status code và request timeline: user-facing status phải 200, không kéo dài failure.

## 7. Real validation data

```text
Exit: 0
Checks: 43/43
HTTP failed: 0.00% (0/6)
Result: PASS
```

## 8. Reference

- Overview: `./00_overview.md`
- Validation: `./13_validation-and-chart-analysis.md`
- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/09-passive-outlier-ejection.js`
