# as-02 — CPU pressure scale out

> **Case ID:** `as-02-cpu-driven-scale-out`
> **Script:** `../app/cpu-pressure-workload.js` (CPU load) + `../app/25-order-service-autoscale-controller.js` (state check)
> **Runner:** `scripts/run-compose-autoscale-lab.ps1` hoặc manual `compose-autoscaler.ps1`
> **Mô phỏng:** CPU products-service vượt ngưỡng → autoscaler thêm replica. Đây là **scale ngang thật** — container mới được tạo, Nginx thêm upstream.

---

## 1. Scale ngang là gì?

```text
Trước scale:                      Sau scale (cpu_high):
  ┌──────────────┐                  ┌──────────────┐  ┌──────────────┐
  │ products-1   │                  │ products-1   │  │ products-2   │  ← container MỚI
  │ CPU: 17%     │                  │ CPU: 12%     │  │ CPU: 13%     │
  └──────────────┘                  └──────────────┘  └──────────────┘
        ↑                                  ↑                ↑
        └────────── Nginx ─────────────────└────────────────┘
                      ↑
                  k6 traffic (10 VUs, cpu_ms=30)

docker compose --scale products-service=2
  → Docker tạo container products-service-2
  → Nginx upstream tự động resolve DNS → thêm upstream mới
  → Traffic được chia đều round-robin
```

**Đây là scale ngang (horizontal):** thêm container cùng loại, LB chia tải. Không phải scale dọc (tăng CPU/RAM container hiện có).

---

## 2. Autoscaler decision loop

```text
Mỗi 2 giây:
  1. GET /v1/resources/live → tổng CPU % của tất cả products-service container
  2. Nếu CPU >= ScaleOutCpuPercent(10%) VÀ ngoài cooldown(12s) VÀ replicas < MaxReplicas(3):
       → scale_out: docker compose --scale products-service=N+1
       → ghi event: "reason": "cpu_high", "scale_applied"
  3. Nếu trong cooldown: "cooldown" (chặn scale)
  4. Nếu trong ngưỡng: "hold"
```

---

## 3. Timeline thực tế (Run #184 — 2026-06-30)

```text
t=0s:   controller_started (replicas=3 leftover từ run trước)
t=2s:   scale_applied(initial): 3→1 (cleanup về MinReplicas)
t=4s:   CPU 18.71% → COOLDOWN (còn 8s)    ← mới scale xong → chặn
t=8s:   CPU 17.98% → COOLDOWN (còn 3s)
t=12s:  CPU 17.25% → CPU_HIGH   ← SCALE OUT 1→2 🔥 (hết cooldown)
t=16s:  CPU 24.51% → COOLDOWN (còn 8s)
t=20s:  CPU 19.44% → COOLDOWN (còn 3s)
t=24s:  CPU 20.51% → CPU_HIGH   ← SCALE OUT 2→3 🔥
t=28s:  CPU 20.56% → COOLDOWN
t=32s:  CPU 23.38% → COOLDOWN
t=36s+: CPU 18-24% → hold       ← max=3, không scale thêm
...k6 workload ends (t=~50s)...
t=50s:  CPU 0.01% → CPU_LOW    ← SCALE IN 3→2 🔻 (workload hết, CPU về 0)
t=54s:  CPU 1.20% → COOLDOWN
t=58s:  CPU 0.00% → COOLDOWN
t=62s:  CPU 0.62% → CPU_LOW    ← SCALE IN 2→1 🔻
t=63s:  controller_stopped (replicas=1)
```

**Kết quả:**
- 35,134 requests (390 req/s)
- 5 lần scale thật: cleanup 3→1, scale_out 1→2 (CPU 17%), scale_out 2→3 (CPU 20%), scale_in 3→2 (CPU 0%), scale_in 2→1 (CPU 0.6%)
- 19 events, 8 cooldown blocks, mapping `test_run_id=184` sạch
- **Lần đầu tiên thấy scale-in**: CPU về 0% sau khi workload dừng → autoscaler thu gọn 3→2→1 đúng quy trình
- Nginx RestartCount=0 — scale hoàn toàn không đụng đến nginx

---

## 4. Pass/fail

```text
✅ Autoscaler event log CÓ ít nhất 1 "scale_applied" với reason "cpu_high"
✅ Replicas tăng từ 1 → 2 → 3
✅ container được tạo thật: products-service-2, products-service-3
✅ Cooldown chặn scale liên tiếp (8 lần "cooldown" decision)
✅ http_reqs > 0 trên tất cả replica (traffic được chia đều)
✅ Scale-in hoạt động khi workload dừng: CPU về 0% → scale 3→2→1
⚠️ http_req_failed cao (98%) — expected với CPU pressure workload, service trả 429 khi quá tải
```

---

## 5. Cách chạy

### Cách 1: Lab script (đơn giản)

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:K6_METRICS_TOKEN = "student-token-1234567890"
.\scripts\run-compose-autoscale-lab.ps1 `
  -BaseUrl http://localhost:18080 `
  -MetricsBaseUrl http://localhost:13001 `
  -ControllerDurationSeconds 90
```

### Cách 2: Manual CPU pressure (scale thật)

```powershell
# Terminal 1: CPU pressure workload (90s)
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:CPU_PRESSURE_CPU_MS = "30"
$env:CPU_PRESSURE_VUS = "10"
$env:CPU_PRESSURE_DURATION_SECONDS = "90"
k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/cpu-pressure-workload.js

# Terminal 2: Autoscaler (chạy sau khi k6 đã register)
.\scripts\compose-autoscaler.ps1 `
  -MetricsBaseUrl http://localhost:13001 `
  -AuthToken "student-token-1234567890" `
  -TestRunId "<run_id>" `
  -ProjectName k6target `
  -Service products-service `
  -MinReplicas 1 -MaxReplicas 3 `
  -ScaleOutCpuPercent 10 -ScaleInCpuPercent 3 `
  -DurationSeconds 70
```

**Muốn scale-out thật sự (CPU đủ cao để vượt ngưỡng):**
- Dùng `cpu-pressure-workload.js` với `CPU_PRESSURE_CPU_MS=30` (không phải order-service script IO-bound)
- Target `products-service` (có cpu_ms handler) thay vì `order-service` (chỉ có external_ms)
- Xem as-03 để hiểu tại sao external_ms không tạo CPU load

---

## 6. Đọc Autoscale tab

```text
Dashboard → tab Autoscale → chọn Run #177:
  Current desired replicas: 3
  Scale applied: 2 lần (cpu_high×2)
  Latest reason: hold (max=3, không scale thêm)
  Chart replicas: blue bar 1→2→3
  Chart CPU: amber bar 20-28% xuyên suốt
  Event log:
    controller_started → scale_observed(initial_already_satisfied)
    → decision(cpu_high) → scale_applied(cpu_high, 1→2)
    → decision(cooldown)×2 → decision(cpu_high) → scale_applied(cpu_high, 2→3)
    → decision(cooldown)×2 → decision(hold)×9 → controller_stopped
```

---

## 7. Bài học

- **Scale ngang = thêm container, LB chia tải**: Không phải magic. Docker tạo container thật (`products-service-2`, `products-service-3`), Nginx route thật.
- **CPU là late signal**: CPU spike sau khi traffic đã tăng. Production kết hợp predictive + reactive scaling.
- **Cooldown là cần thiết**: 6 lần cooldown block trong Run #170 — nếu không có, system sẽ scale 1→2→3 trong <10s gây flapping.
- **IO-bound service cần metric khác**: Nếu service chỉ chờ external/DB (như order confirm với external_ms=35), CPU luôn thấp → cần latency-based hoặc queue-depth scaling.
- **Scale không giảm CPU về 0**: Dù 3 replica, CPU vẫn 18-28% vì workload quá nặng (cpu_ms=30 × 10 VUs). Đây là tín hiệu cần scale DB hoặc optimize code — không phải thêm app replica (xem as-03).
