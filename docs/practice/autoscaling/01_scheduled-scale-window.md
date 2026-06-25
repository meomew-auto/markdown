# as-01 — Scheduled replica change window

> **Case ID:** `as-01-scheduled-scale-window`
> **Script:** `../app/22-order-service-runtime-scale.js`
> **Proof:** Scale thủ công order-service 1→2 giữa lúc traffic đang chạy → Redis state + idempotency survive replica churn.

---

## 1. Tình huống thực tế

Bạn cần scale order-service từ 1 lên 2 replica trong lúc traffic đang chạy. Request in-flight có bị mất không? Idempotency key trong Redis có hoạt động xuyên suốt các replica không? Brief 502/503 có acceptable không?

## 2. Cách thức

```text
Terminal 1: k6 workload (4 VUs, 30s)
  ├── Gửi order confirm liên tục
  └── Ghi idempotency key vào Redis (shared state)

Terminal 2 (sau 5s): docker compose --scale order-service=2
  ├── Docker tạo container order-service-2 mới
  ├── Nginx reload config → thêm upstream mới
  └── Brief disruption (có thể có 502/503 trong 1-3s)
```

## 3. Pass/fail

```text
✅ order_runtime_scale_failures = 0
✅ idempotency: duplicate confirm requests KHÔNG bị xử lý 2 lần
✅ Redis state survive qua scale event
⚠️ Tolerated: brief 502/503 trong churn window (< 5% total requests)
```

## 4. Cách chạy

```powershell
$token = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN 2>&1 | Select-Object -Last 1
$env:OPS_AUTH_TOKEN = $token
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:ORDER_RUNTIME_SCALE_SCENARIO = "runtime_scale_flow"
$env:ORDER_RUNTIME_SCALE_VUS = "4"
$env:ORDER_RUNTIME_SCALE_DURATION_SECONDS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/22-order-service-runtime-scale.js
```

Sau 5s, ở terminal khác:
```powershell
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -TargetLayer full-no-cdn -ScaleApp 2 -ScaleOrderService 2
```

## 5. Điều tra sau scale

1. Dashboard → tab Overview: http_req_failed rate — có spike ở giây scale không?
2. Dashboard → tab Resources: order-service CPU/RAM trước và sau scale
3. K6 console log: `ORDER_RUNTIME_SCALE_FAIL` — có bị mất idempotency không?
4. Redis: `GET idempotency:<key>` — key có bị duplicate giữa 2 replica không?

## 6. Bài học

- **Scale không miễn phí**: Có disruption. Production cần graceful drain + health check.
- **Shared state (Redis) là safeguard**: Idempotency key tồn tại xuyên suốt replica churn.
- **Brief churn được tolerate**: Nếu contract cho phép <5% error trong scale window, đây không phải incident.
