# Case 10: Weighted fairness under load

> **Case ID:** `lb-10-weighted-fairness-under-load`  
> **Script:** `10-weighted-fairness-under-load.js`  
> **Profile:** `full-no-cdn`  
> **Proof:** canary share vẫn nằm trong band khi có sustained load

## 1. Tình huống thực tế

Canary routing không chỉ đúng trong sample nhỏ. Khi có sustained load, tỷ lệ stable/canary vẫn phải nằm trong dải kỳ vọng, nếu không rollout có thể quá nhanh hoặc quá chậm.

## 2. Capability được chứng minh

Case này tạo request rate đều và đo observed canary share bằng custom metric `lb_canary_observed`.

Nginx config hiện dùng `split_clients` 15%, nhưng validation dùng min/max band thay vì đòi đúng tuyệt đối.

## 3. Key signals

| Signal | Expected |
| --- | --- |
| `lb_canary_observed` | nằm trong expected band |
| `X-LB-Release-Channel` | stable/canary |
| status | 200 |
| HTTP failed | 0% |
| checks | 100% |

## 4. Pass/fail criteria

PASS khi canary observed share nằm trong min/max và không có unexpected failures.

FAIL khi:

- all traffic stable hoặc all canary;
- canary share ngoài band;
- status failed không expected;
- sample quá nhỏ nhưng vẫn kết luận distribution.

## 5. Cách chạy

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 10-weighted-fairness-under-load
```

Env knobs:

```powershell
$env:LB_CANARY_FAIRNESS_RATE = "90"
$env:LB_CANARY_FAIRNESS_DURATION_SECONDS = "12"
$env:LB_CANARY_FAIRNESS_MIN_SHARE = "0.05"
$env:LB_CANARY_FAIRNESS_MAX_SHARE = "0.30"
```

## 6. Chart reading

Dashboard nên chart `lb_canary_observed` hoặc count theo `X-LB-Release-Channel`. Aggregate latency/RPS không chứng minh canary fairness.

## 7. Real validation data

```text
Exit: 0
Checks: 2163/2163
HTTP failed: 0.00% (0/721)
lb_canary_observed: 12.62% (91/721)
Result: PASS
```

## 8. Reference

- Overview: `./00_overview.md`
- Validation: `./13_validation-and-chart-analysis.md`
- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/10-weighted-fairness-under-load.js`
