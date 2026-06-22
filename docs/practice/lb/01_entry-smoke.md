# Case 01: Entry smoke

> **Case ID:** `lb-01-entry-smoke`  
> **Script:** `01-entry-smoke.js`  
> **Profile:** `lb-app` / `TargetLayer=lb-app`  
> **Proof:** public entrypoint `:80` đi qua Nginx tới app, có request id, không có CDN cache

## 1. Tình huống thực tế

Đây là bài smoke test đầu tiên của LB layer. Trước khi nói tới canary, failover hay pressure, cần chứng minh public endpoint thật sự đi qua Gateway/Nginx và tới app origin.

Nếu test nhầm direct app hoặc nhầm CDN path, mọi kết luận LB phía sau đều không đáng tin.

## 2. LB capability được chứng minh

Case này chứng minh:

```text
client/k6 -> http://localhost:80 -> Nginx -> app
```

Response phải có:

- `X-Served-By=nginx` hoặc `Server: nginx/...`;
- `X-Upstream-Service=app`;
- `X-Request-ID`;
- không có `X-Cache`;
- home response có `instance_id`.

## 3. Topology và precondition

```powershell
cd E:/Projects/k6/k6-metrics-server
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer lb-app -ScaleApp 2
$env:BASE_URL = "http://localhost:80"
```

Không dùng `TargetLayer=full` vì full có CDN/Varnish phía trước.

## 4. Request sequence

1. setup probe vào home/app endpoint.
2. sustained traffic với 4 VUs mặc định trong khoảng 20s.
3. random traffic giữa `/`, `/api/users`, `/api/slow?cpu_ms=10`.
4. mỗi response assert LB headers và no cache.

## 5. Key signals

| Signal | Expected |
| --- | --- |
| status | 200 |
| `X-Served-By` / `Server` | nginx |
| `X-Upstream-Service` | app |
| `X-Request-ID` | present |
| `X-Cache` | absent |
| `instance_id` | present trên home/setup response |

## 6. Pass/fail criteria

PASS khi checks 100%, failed 0%, upstream đúng app và không có `X-Cache`.

FAIL khi:

- public path không qua Nginx;
- upstream không phải app;
- thiếu request id;
- xuất hiện `X-Cache`, nghĩa là chạy nhầm qua CDN.

## 7. Cách chạy

```powershell
cd E:/Projects/k6/k6-metrics-server
./scripts/run-lb-capabilities.ps1 -Profile lb-app -Scenarios 01-entry-smoke
```

## 8. Chart reading

Chart cần xem:

- checks rate phải 100%;
- HTTP failed 0%;
- latency thấp và ổn định;
- VUs bằng config `LB_ENTRY_VUS`.

Chart không chứng minh upstream đúng nếu không đọc checks/header.

## 9. Real validation data

Run `lb-app` profile:

```text
Exit: 0
Checks: 13764/13764
HTTP failed: 0.00% (0/2463)
Result: PASS
```

## 10. Reference

- Overview: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Validation: `./13_validation-and-chart-analysis.md`
- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/01-entry-smoke.js`
