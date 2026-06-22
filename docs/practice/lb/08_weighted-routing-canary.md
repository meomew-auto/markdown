# Case 08: Weighted routing canary

> **Case ID:** `lb-08-weighted-routing-canary`  
> **Script:** `08-weighted-routing-canary.js`  
> **Profile:** `full-no-cdn`  
> **Proof:** Nginx route stable/canary bằng force header và weighted split

## 1. Tình huống thực tế

Canary release cần đưa một phần nhỏ traffic sang bản mới. Gateway phải hỗ trợ cả forced routing để debug và weighted routing để rollout dần.

## 2. Capability được chứng minh

Case này kiểm:

1. `X-Canary: never` -> stable.
2. `X-Canary: always` -> canary.
3. weighted route theo `split_clients` nằm trong dải min/max.

## 3. Key signals

| Signal | Expected |
| --- | --- |
| `X-LB-Release-Channel` | `stable` hoặc `canary` |
| `X-Upstream-Service` stable | `lb-stable-origin` |
| `X-Upstream-Service` canary | `lb-canary-origin` |
| weighted sample | canary percent nằm trong configured band |
| `X-Cache` | absent |

## 4. Pass/fail criteria

PASS khi forced stable/canary đúng và weighted sample trong band.

FAIL khi:

- force header bị bỏ qua;
- canary share nằm ngoài min/max;
- upstream service không khớp channel;
- sample quá nhỏ gây kết luận nhiễu.

## 5. Cách chạy

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 08-weighted-routing-canary
```

Env knobs:

```powershell
$env:LB_CANARY_SAMPLE_SIZE = "120"
$env:LB_CANARY_MIN_PERCENT = "5"
$env:LB_CANARY_MAX_PERCENT = "30"
```

## 6. Chart reading

Chart status/latency không đủ. Cần đọc channel/upstream distribution. Với Nginx `split_clients` 15%, sample local không cần đúng 15.00%, chỉ cần nằm trong band.

## 7. Real validation data

```text
Exit: 0
Checks: 253/253
HTTP failed: 0.00% (0/122)
Result: PASS
```

## 8. Reference

- Overview: `./00_overview.md`
- Validation: `./13_validation-and-chart-analysis.md`
- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/08-weighted-routing-canary.js`
