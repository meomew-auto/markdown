# as-02 — CPU-driven scale out

> **Case ID:** `as-02-cpu-driven-scale-out`
> **Script:** `../app/25-order-service-autoscale-controller.js`
> **Runner:** `scripts/run-compose-autoscale-lab.ps1`
> **Proof:** Autoscaler controller đọc Docker CPU % → scale out khi vượt ngưỡng.

---

## 1. Tình huống thực tế

"Order service đang 1 replica, traffic tăng đột biến → CPU lên cao. Controller phải tự động thêm replica thứ 2 mà không cần người can thiệp."

## 2. Autoscaler decision loop

```text
Mỗi 2 giây:
  1. GET /v1/resources/live → lấy CPU % của order-service container
  2. Nếu CPU >= 12% VÀ outside cooldown VÀ replicas < 3:
       → scale_out: docker compose --scale order-service=N+1
       → ghi event: "reason": "cpu_high"
  3. Nếu CPU trong ngưỡng (4% < CPU < 12%):
       → hold: giữ nguyên
       → ghi event: "reason": "hold"
```

## 3. K6 workload (3 scenarios)

| Scenario | VUs | Duration | Mục đích |
| --- | ---: | ---: | --- |
| `high_load` | 8 | 0-12s | Tạo CPU spike → trigger scale out |
| `hotkey_guard` | 2 | 0-30s | Check idempotency giữa các replica |
| `low_load` | 1 | 16-30s | Để CPU giảm → trigger scale in |

## 4. Pass/fail

```text
✅ order_autoscale_check_failures = 0
✅ order_autoscale_high_success > 0 (có request thành công)
✅ order_autoscale_low_success > 0
✅ order_autoscale_trace_failures = 0
✅ Autoscaler event log có scale_applied event
⚠️ order_autoscale_churn_status_count: brief disruption trong scale window
```

## 5. Cách chạy

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:K6_METRICS_TOKEN = "student-token-1234567890"
.\scripts\run-compose-autoscale-lab.ps1 `
  -BaseUrl http://localhost:18080 `
  -MetricsBaseUrl http://localhost:13001
```

## 6. Đọc Autoscale tab

```text
Dashboard → tab Autoscale:
  Desired replicas: 2 (đã scale)
  Scale applied: 2 lần (initial + cpu_high)
  Latest reason: cpu_high
  Chart: blue bar (replicas) tăng từ 1→2, amber bar (CPU) spike trước đó
  Event log: controller_started → scale_applied(initial) → decision(hold)×N → decision(cpu_high) → scale_applied(cpu_high)
```

## 7. Bài học

- **CPU là late signal**: CPU spike xảy ra SAU KHI traffic đã tăng. Production nên kết hợp predictive scaling.
- **IO-bound service cần metric khác**: Nếu service chủ yếu chờ external call, CPU luôn thấp → cần queue-depth hoặc latency-based scaling.
- **Cooldown quan trọng**: Không có cooldown → flap liên tục khi CPU dao động quanh ngưỡng.
