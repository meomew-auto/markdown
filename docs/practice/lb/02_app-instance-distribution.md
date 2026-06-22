# Case 02: App instance distribution

> **Case ID:** `lb-02-app-instance-distribution`  
> **Script:** `02-app-instance-distribution.js`  
> **Profile:** `lb-app` / `TargetLayer=lb-app`  
> **Proof:** Nginx phân phối request qua nhiều app replicas

## 1. Tình huống thực tế

Khi app scale ngang, LB không được dồn toàn bộ traffic vào một replica nếu các replica đều healthy. Case này chứng minh Nginx thật sự nhìn thấy nhiều app instances phía sau.

## 2. LB capability được chứng minh

Case này gửi nhiều request tới app home endpoint và đọc `instance_id` trong body. Với `ScaleApp 2`, tập `instance_id` observed phải có ít nhất `MIN_LB_INSTANCES` giá trị.

## 3. Topology và precondition

```powershell
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer lb-app -ScaleApp 2
$env:MIN_LB_INSTANCES = "2"
$env:LB_DISTRIBUTION_ITERATIONS = "60"
```

Script dùng `Connection: close` để giảm ảnh hưởng keepalive khi đo distribution.

## 4. Request sequence

1. chạy 60 iterations mặc định;
2. mỗi iteration gọi public `:80`;
3. assert status/upstream/no-cache/request-id;
4. collect `instance_id`;
5. cuối run assert observed instances >= minimum.

## 5. Key signals

| Signal | Expected |
| --- | --- |
| status | 200 |
| upstream | app |
| `instance_id` | nhiều giá trị |
| `X-Cache` | absent |
| checks | 100% |

## 6. Pass/fail criteria

PASS khi thấy nhiều app instances trong sample.

FAIL khi:

- chỉ thấy 1 instance dù `ScaleApp=2`;
- thiếu `instance_id`;
- route không qua Nginx/app;
- sample quá nhỏ gây false negative.

## 7. Cách chạy

```powershell
cd E:/Projects/k6/k6-metrics-server
./scripts/run-lb-capabilities.ps1 -Profile lb-app -Scenarios 02-app-instance-distribution
```

## 8. Chart reading

Chart RPS/latency không chứng minh distribution. Evidence chính là distinct `instance_id`. Dashboard chỉ giúp thấy request sample chạy đủ iterations.

## 9. Real validation data

```text
Exit: 0
Checks: 361/361
HTTP failed: 0.00% (0/60)
Primary observation: observed multiple app instance_id values
Result: PASS
```

## 10. Reference

- Overview: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Validation: `./13_validation-and-chart-analysis.md`
- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/02-app-instance-distribution.js`
