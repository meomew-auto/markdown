# Autoscaling Layer — Overview

> **Vị trí:** Sau Resource/Capacity, song song với Observability/SLO
> **Topology:** k6 → Nginx LB → order-service replicas → Redis/Postgres/payment-mock; autoscaler đọc Docker stats → scale
> **Dashboard:** http://localhost:13001/ → tab Autoscale

---

## 1. Vị trí trong lộ trình

```text
CDN → LB → Microservices → Redis → Postgres/DB → External → Resource/Capacity
                                                            ↓
                                    ┌───────────────────────┴──────────────────┐
                                    ↓                                           ↓
                              Autoscaling                               Observability/SLO
```

Layer này trả lời câu hỏi: **"Làm sao để service tự động tăng/giảm replica khi traffic thay đổi, không cần Kubernetes?"**

---

## 2. Mental model

```text
k6 workload (CPU load)
        ↓
order-service (1→N replicas)
        ↓
Docker stats (CPU % per container)
        ↓
compose-autoscaler.ps1 (controller loop)
  ├── Sample CPU mỗi 2s
  ├── CPU >= scale_out → scale up (+1 replica, max 3)
  ├── CPU <= scale_in  → scale down (-1 replica, min 1)
  └── Cooldown 12s ngăn flap
        ↓
docker compose --scale order-service=N
        ↓
Dashboard tab Autoscale:
  GET /v1/autoscale/events?test_run_id=X
  artifacts/autoscale-events/autoscale-X.jsonl
```

---

## 3. 5 capability proofs

| Case | Script | Dạy gì |
| --- | --- | --- |
| **as-01** | 22-order-service-runtime-scale.js | Scale thủ công — request in-flight có bị mất không? |
| **as-02** | 25-order-service-autoscale-controller.js | CPU-driven scale out — controller tự động thêm replica |
| **as-03** | 25-order-service-autoscale-controller.js | Scale in + cooldown — không flap khi CPU vừa giảm |
| **as-04** | 25-order-service-autoscale-controller.js | Hotkey + idempotency — state shared qua Redis không bị duplicate |
| **as-05** | 30-capacity-sizing-sweep.js | Tính capacity → đề xuất min/max replicas |

---

## 4. Autoscaler parameters

| Parameter | Default | Ý nghĩa |
| --- | ---: | --- |
| `ScaleOutCpuPercent` | 12 | Scale out khi CPU >= ngưỡng này |
| `ScaleInCpuPercent` | 4 | Scale in khi CPU <= ngưỡng này |
| `CooldownSeconds` | 12 | Thời gian chờ giữa 2 lần scale |
| `SampleSeconds` | 2 | Sample CPU mỗi N giây |
| `MinReplicas` | 1 | Số replica tối thiểu |
| `MaxReplicas` | 3 | Số replica tối đa |

---

## 5. Autoscale event model

```json
{
  "event": "decision",
  "timestamp": "2026-06-25T22:37:46Z",
  "test_run_id": "165",
  "service": "order-service",
  "current_replicas": 1,
  "desired_replicas": 1,
  "cpu_percent": 0.7,
  "reason": "hold",
  "cooldown_remaining_seconds": 0
}
```

4 event types: `controller_started` → `scale_applied` (initial) → `decision` (repeating) → `controller_stopped`

4 decision reasons: `cpu_high` (scale out), `cpu_low` (scale in), `cooldown` (đang chờ), `hold` (trong ngưỡng)

---

## 6. Bài học thực tế từ lab (Run #164, #165)

### Phát hiện 1: CPU-based autoscaling không hiệu quả với IO-bound service
```
order-service confirm gọi external_ms=35ms + db_writes=1
→ CPU 0-2% dù 1894 requests trong 30s
→ Autoscaler giữ nguyên 1 replica (reason: "hold")
→ CPU-based chỉ hoạt động với CPU-bound workload
```

### Phát hiện 2: Cooldown ngăn flap khi stack restart
```
Lúc stack up: CPU spike 19.28%
→ Cooldown 12s → reason: "cooldown" (chặn scale đúng)
→ Sau cooldown: CPU về 0% → không scale không cần thiết
```

### Phát hiện 3: Stack restart gây disruption
```
docker compose --scale restart nginx → 3-5s downtime
→ 760/1894 requests (40%) bị unexpected status
→ Cần graceful switch hoặc health check drain trước khi restart
```

---

## 7. Production lesson

Autoscaling layer dạy learner 3 điều:

1. **Autoscaling là policy, không phải magic**: CPU threshold, cooldown, min/max replicas phải được calibrate từ capacity test thật (as-05).
2. **IO-bound service cần metric khác**: CPU-based không đủ — cần request queue depth, latency-based, hoặc custom metric.
3. **Scale không miễn phí**: Mỗi lần scale có thể gây disruption. Graceful drain + health check là bắt buộc trong production.
