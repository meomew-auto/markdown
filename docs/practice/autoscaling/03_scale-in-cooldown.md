# as-03 — Scale in with cooldown

> **Case ID:** `as-03-scale-in-cooldown`
> **Script:** `../app/25-order-service-autoscale-controller.js`
> **Proof:** Scale-in phải chờ stable low-load window. Cooldown ngăn replica flapping.

---

## 1. Tình huống thực tế

"Traffic giảm, CPU về 0%. Controller đừng scale in ngay lập tức — phải đợi xem low load có stable không. Nếu không, replica sẽ flap: scale in → CPU spike → scale out → lặp lại."

## 2. Cooldown mechanism

```text
Sau mỗi lần scale (in hoặc out):
  ├── last_scale_at = now
  └── 12 giây tiếp theo: mọi decision = "cooldown"

Trong cooldown:
  CPU dù có vượt ngưỡng → vẫn HOLD
  CPU dù có thấp hơn ngưỡng → vẫn HOLD
  
→ Ngăn scale ngay sau khi vừa scale
→ Để hệ thống ổn định trước khi quyết định tiếp
```

## 3. Timeline thực tế (Run #165)

```text
t=0s:   controller_started, scale_applied(initial, replicas=1)
t=2s:   CPU=19.28% → LẼ RA scale out, nhưng cooldown 8s → "cooldown" ✅
t=4s:   CPU=0.18%  → cooldown 4s → "cooldown"
t=6s:   CPU=0.7%   → cooldown hết, CPU trong ngưỡng → "hold"
t=8s+:  CPU=0-0.8% → "hold"
```

**Bài học từ timeline:** CPU spike 19.28% lúc stack restart bị cooldown chặn đúng. Nếu không có cooldown, autoscaler đã scale out vì spike này, rồi scale in ngay sau đó khi CPU về 0% → **flap**.

## 4. K6 workload design

```text
high_load (8 VUs, 0-12s):  ← CPU spike (nhưng order-service IO-bound → CPU vẫn thấp)
low_load  (1 VU, 16-30s):  ← CPU low, stable
hotkey    (2 VUs, 0-30s):  ← load đều suốt

→ Nếu high_load tạo đủ CPU → scale out ở t=12-14s
→ Đến low_load phase → CPU thấp, stable → scale in ở t=28-30s (sau cooldown)
→ Tổng: thấy được cả scale out VÀ scale in trong 1 lab
```

## 5. Pass/fail

```text
✅ order_autoscale_unexpected_status = 0 (ngoài churn window)
✅ Cooldown event có trong event log
✅ Không có scale_applied liên tiếp trong < 12s (chứng minh cooldown hoạt động)
✅ Scale-in KHÔNG xảy ra khi CPU vừa giảm dưới 1s
```

## 6. Cách chạy

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:K6_METRICS_TOKEN = "student-token-1234567890"
.\scripts\run-compose-autoscale-lab.ps1 `
  -BaseUrl http://localhost:18080 `
  -MetricsBaseUrl http://localhost:13001 `
  -ControllerDurationSeconds 90
```

## 7. Bài học

- **Cooldown = chống flap**: Không scale liên tục. Production autoscaler (K8s HPA, AWS ASG) đều có cooldown/stabilization window.
- **Scale-in phải thận trọng hơn scale-out**: Scale out sai → tốn tài nguyên. Scale in sai → mất availability.
- **CPU spike đầu tiên không tin cậy**: Stack restart, cold start, cache warmup đều gây spike tạm thời. Cooldown filter được những spike này.
