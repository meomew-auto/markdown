# as-04 — Scale in with cooldown

> **Case ID:** `as-04-cooldown`
> **Script:** `../app/25-order-service-autoscale-controller.js`
> **Proof:** Tải giảm → KHÔNG scale down ngay. Cooldown buộc chờ stable low-load window rồi mới scale in.

---

## 1. Tình huống thực tế

"CPU về 0% sau 30s cao tải. Autoscaler đừng scale in ngay — có thể traffic sắp tăng lại. Nếu scale in vội → CPU lại spike → scale out → scale in → ... = **flapping**."

---

## 2. Flapping — vấn đề cooldown giải quyết

```text
KHÔNG có cooldown:                     CÓ cooldown (12s):
                                       
CPU ↑ → scale out (t=0)                CPU ↑ → scale out (t=0)
CPU ↓ → scale in  (t=2)  ← FLAP!       CPU ↓ → COOLDOWN (t=2-14)
CPU ↑ → scale out (t=4)  ← FLAP!           CPU vẫn thấp suốt 12s?
CPU ↓ → scale in  (t=6)  ← FLAP!               ↓ YES → scale in (t=14)
...                                     CPU ↑ trong cooldown?
                                            ↓ YES → HOLD (đúng, không flap)
```

---

## 3. Cooldown state machine

```text
                    ┌──────────────────────────┐
                    │      COOLDOWN             │
                    │  (12s sau mỗi lần scale)  │
                    │                          │
    scale_applied → │  Mọi decision = "cooldown"│
                    │  Dù CPU có vượt ngưỡng    │
                    │  cũng KHÔNG scale         │
                    └──────────────────────────┘
                              ↓ (hết 12s)
                    ┌──────────────────────────┐
                    │      DECISION             │
                    │  CPU >= 12% → cpu_high    │
                    │  CPU <= 4%  → cpu_low     │
                    │  else       → hold        │
                    └──────────────────────────┘
```

---

## 4. Timeline thực tế từ lab (Run #165)

```text
t=0s:   controller_started, scale_applied(initial, replicas=1)
t=2-4s: CPU spike 19.28% → COOLDOWN (chặn scale out vì mới scale initial)
t=6s:   CPU 0.7% → hold (trong ngưỡng)
t=8s+:  CPU 0-0.8% → hold (ổn định)
...
t=60s:  controller_stopped

→ Cooldown đã chặn scale-out sai khi CPU spike do stack restart
→ Sau cooldown, CPU ổn định → không scale không cần thiết
```

---

## 5. Pass/fail

```text
✅ Event log có decision với reason "cooldown"
✅ KHÔNG có scale_applied liên tiếp < 12s (chứng minh cooldown hoạt động)
✅ Sau cooldown, nếu CPU thấp stable → scale in (cpu_low)
✅ Sau cooldown, nếu CPU cao → scale out (cpu_high) ← không bị chặn oan
```

---

## 6. Cách chạy

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:K6_METRICS_TOKEN = "student-token-1234567890"
.\scripts\run-compose-autoscale-lab.ps1 `
  -BaseUrl http://localhost:18080 `
  -MetricsBaseUrl http://localhost:13001 `
  -ControllerDurationSeconds 90
```

Muốn thấy rõ scale-in: cần scale-out trước (as-02), rồi để low_load phase chạy đủ lâu (>12s + cooldown).

---

## 7. Bài học

- **Cooldown = chống flap**: K8s HPA có `--horizontal-pod-autoscaler-downscale-stabilization` (mặc định 5m). AWS ASG có `--cooldown`. Tất cả autoscaler đều cần cơ chế này.
- **Scale-in phải thận trọng hơn scale-out**: Scale out sai → tốn tài nguyên. Scale in sai → mất availability → user thấy lỗi.
- **CPU spike đầu tiên không tin cậy**: Restart, cold start, cache warmup đều tạo spike tạm thời.
