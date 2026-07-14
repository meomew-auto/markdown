# as-04 — Cooldown (scale in)

> **Case ID:** `as-04-cooldown`
> **Script:** `../app/cpu-pressure-workload.js` + `scripts/compose-autoscaler.ps1`
> **Proof:** Cooldown 12s chặn mọi decision trong 12s sau mỗi lần scale. Dù CPU vượt ngưỡng, autoscaler vẫn đợi hết cooldown mới scale tiếp.

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
                    │  CPU >= 10% → cpu_high    │
                    │  CPU <= 3%  → cpu_low     │
                    │  else       → hold        │
                    └──────────────────────────┘
```

---

## 4. Timeline thực tế (Run #184 — CPU pressure, scale-out + scale-in)

```text
t=0s:   controller_started (replicas=3 leftover)
t=2s:   scale_applied(initial, 3→1)            ← bắt đầu 12s cooldown

t=6s:   CPU 18.71% → COOLDOWN (còn 8s)          ← CPU vượt ngưỡng nhưng BỊ CHẶN
t=10s:  CPU 17.98% → COOLDOWN (còn 3s)          ← vẫn bị chặn

t=14s:  CPU 17.25% → cpu_high → SCALE 1→2 🔥    ← hết cooldown, quyết định scale

t=18s:  CPU 24.51% → COOLDOWN (còn 8s)          ← CPU 24% nhưng mới scale → CHẶN
t=22s:  CPU 19.44% → COOLDOWN (còn 3s)

t=26s:  CPU 20.51% → cpu_high → SCALE 2→3 🔥    ← hết cooldown, scale tiếp

t=30s:  CPU 20.56% → COOLDOWN (còn 8s)          ← max=3, không scale thêm
t=34s:  CPU 23.38% → COOLDOWN (còn 3s)
t=38s+: CPU 18-24% → hold                       ← max reached, giữ nguyên

...k6 workload ends, CPU drops to ~0%...

t=50s:  CPU 0.01% → cpu_low → SCALE 3→2 🔻     ← hết cooldown, scale in
t=54s:  CPU 1.20% → COOLDOWN (còn 8s)
t=58s:  CPU 0.00% → COOLDOWN (còn 3s)
t=62s:  CPU 0.62% → cpu_low → SCALE 2→1 🔻     ← hết cooldown, scale in tiếp
t=63s:  controller_stopped
```

**8 lần cooldown block** — trải đều cả phase scale-out (6 blocks sau 2 lần scale_out) và scale-in (2 blocks sau scale_in đầu tiên). Mỗi lần CPU vượt ngưỡng nhưng autoscaler từ chối scale vì đang trong cooldown window.

**Điểm mới so với Run #170:** Run #184 show cả scale-in flow với cooldown — chứng minh cơ chế hoạt động đối xứng cho cả 2 chiều scale.

---

## 5. Pass/fail

```text
✅ Event log có decision với reason "cooldown" (ít nhất 2 lần)
✅ KHÔNG có scale_applied liên tiếp < 12s (chứng minh cooldown hoạt động)
✅ CPU vượt ngưỡng trong cooldown → "cooldown" (không scale)
✅ Hết cooldown, CPU vẫn vượt ngưỡng → "cpu_high" + scale (không bị chặn oan)
✅ Sau khi đạt max_replicas, CPU vẫn cao → "hold" (đúng, không scale thêm)
```

---

## 6. Cách chạy

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:K6_METRICS_TOKEN = "student-token-1234567890"

# Chạy CPU pressure workload + autoscaler
# Terminal 1: k6 workload (90s, cpu_ms=30, 10 VUs)
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:CPU_PRESSURE_CPU_MS = "30"
$env:CPU_PRESSURE_VUS = "10"
$env:CPU_PRESSURE_DURATION_SECONDS = "90"
k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/cpu-pressure-workload.js

# Terminal 2: Autoscaler (sau khi k6 đã register)
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

Muốn thấy rõ scale-in: cần scale-out trước (as-02), rồi để workload dừng → CPU về 0% > 12s + ngoài cooldown → scale in (cpu_low).

---

## 7. Bài học

- **Cooldown = chống flap**: K8s HPA có `--horizontal-pod-autoscaler-downscale-stabilization` (mặc định 5m). AWS ASG có `--cooldown`. Tất cả autoscaler đều cần cơ chế này.
- **Scale-in phải thận trọng hơn scale-out**: Scale out sai → tốn tài nguyên. Scale in sai → mất availability → user thấy lỗi.
- **CPU spike đầu tiên không tin cậy**: Restart, cold start, cache warmup đều tạo spike tạm thời → cooldown bảo vệ khỏi scale oan.
- **Run #184 chứng minh**: 8 cooldown blocks trải đều scale-out (6) + scale-in (2). CPU 17-24% trong cooldown → bị chặn. Hết cooldown, CPU vẫn vượt ngưỡng → scale thật. CPU về 0% → scale-in với cooldown bảo vệ. Cơ chế hoạt động chính xác cả 2 chiều.
