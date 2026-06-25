# as-02 — CPU pressure scale out

> **Case ID:** `as-02-cpu-driven-scale-out`
> **Script:** `../app/25-order-service-autoscale-controller.js`
> **Runner:** `scripts/run-compose-autoscale-lab.ps1`
> **Mô phỏng:** CPU order-service vượt ngưỡng → autoscaler thêm replica. Đây là **scale ngang thật** — container mới được tạo, Nginx thêm upstream.

---

## 1. Scale ngang là gì?

```text
Trước scale:                      Sau scale (cpu_high):
  ┌──────────────┐                  ┌──────────────┐  ┌──────────────┐
  │ order-svc-1  │                  │ order-svc-1  │  │ order-svc-2  │  ← container MỚI
  │ CPU: 25%     │                  │ CPU: 12%     │  │ CPU: 13%     │
  └──────────────┘                  └──────────────┘  └──────────────┘
        ↑                                  ↑                ↑
        └────────── Nginx ─────────────────└────────────────┘
                      ↑
                  k6 traffic (8 VUs, cpu_ms cao)

docker compose --scale order-service=2
  → Docker tạo container order-service-2
  → Nginx reload → resolve DNS → thêm upstream order-service-2:8083
  → Traffic được chia đều round-robin
```

**Đây là scale ngang (horizontal):** thêm container cùng loại, LB chia tải. Không phải scale dọc (tăng CPU/RAM container hiện có).

---

## 2. Autoscaler decision loop

```text
Mỗi 2 giây:
  1. GET /v1/resources/live → tổng CPU % của tất cả order-service container
  2. Nếu CPU >= ScaleOutCpuPercent(12%) VÀ ngoài cooldown VÀ replicas < MaxReplicas(3):
       → scale_out: docker compose --scale order-service=N+1
       → ghi event: "reason": "cpu_high", "scale_applied"
  3. Nếu trong ngưỡng: "hold"
```

---

## 3. Pass/fail

```text
✅ Autoscaler event log CÓ ít nhất 1 "scale_applied" với reason "cpu_high"
✅ Replicas tăng từ 1 → 2 hoặc 3
✅ order_autoscale_check_failures = 0 (state không bị corrupt)
✅ order_autoscale_hotkey_reuse_count > 0 (idempotency vẫn hoạt động qua các replica)
⚠️ order_autoscale_churn_status_count: expected brief 502/503 trong lúc nginx reload
```

---

## 4. Cách chạy

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:K6_METRICS_TOKEN = "student-token-1234567890"

# Chạy lab đầy đủ
.\scripts\run-compose-autoscale-lab.ps1 `
  -BaseUrl http://localhost:18080 `
  -MetricsBaseUrl http://localhost:13001 `
  -ControllerDurationSeconds 90
```

**Muốn scale-out thật sự (CPU đủ cao để vượt ngưỡng):**
- Dùng workload có `cpu_ms` thật (không chỉ `external_ms`)
- Hoặc giảm `ScaleOutCpuPercent` cho phù hợp với local Docker
- Xem as-03 để hiểu tại sao external_ms không tạo CPU load

---

## 5. Đọc Autoscale tab

```text
Dashboard → tab Autoscale → chọn run:
  Current desired replicas: 2
  Scale applied: 2 lần (initial 1 + cpu_high 2)
  Latest reason: cpu_high
  Chart replicas: blue bar 1→2
  Chart CPU: amber bar cao trước khi scale, giảm sau khi scale
  Event log: ... → decision(cpu_high) → scale_applied(cpu_high, 1→2) → decision(hold)
```

---

## 6. Bài học

- **Scale ngang = thêm container, LB chia tải**: Không phải magic. Docker tạo container thật, Nginx route thật.
- **CPU là late signal**: CPU spike sau khi traffic đã tăng. Production kết hợp predictive + reactive scaling.
- **Sau scale, CPU giảm**: Chứng tỏ scale có hiệu quả — tải được chia đều.
- **IO-bound service cần metric khác**: Nếu service chỉ chờ external/DB (như order confirm với external_ms=35), CPU luôn thấp → cần latency-based hoặc queue-depth scaling.
