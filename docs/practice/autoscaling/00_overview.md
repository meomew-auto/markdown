# Autoscaling Layer — Overview

> **Scale ngang (horizontal scaling):** Thêm/bớt replica container của cùng 1 service, LB phân phối traffic.
> **Docker approximation:** Không cần K8s. `docker compose --scale` + Nginx LB = mô phỏng thật cơ chế giống hệt K8s HPA.
> **Dashboard:** http://localhost:13001/ → tab Autoscale

---

## 1. Scale ngang là gì?

```
Scale dọc (vertical):                    Scale ngang (horizontal):
  ┌──────────┐                            ┌──────────┐  ┌──────────┐  ┌──────────┐
  │ order    │ BIGGER                     │ order-1  │  │ order-2  │  │ order-3  │
  │ 8 CPU    │                            │ 1 CPU     │  │ 1 CPU     │  │ 1 CPU     │
  │ 16GB RAM │                            │ 512MB RAM │  │ 512MB RAM │  │ 512MB RAM │
  └──────────┘                            └──────────┘  └──────────┘  └──────────┘
                                               ↑              ↑              ↑
                                               └──────────────┼──────────────┘
                                                              ↓
                                                        Nginx LB
                                                              ↓
                                                           k6 traffic
```

**Scale ngang = THÊM container, không phải container to hơn.**

Trong Docker lab này:
- `docker compose --scale order-service=3` → 3 container order-service (order-service-1, order-service-2, order-service-3)
- Nginx upstream tự động include tất cả container (via Docker DNS resolve)
- Traffic được phân phối round-robin qua các replica
- Autoscaler controller thực hiện đúng chu trình: **watch metric → decide → scale**

---

## 2. Khác biệt Docker vs K8s (và tại sao vẫn dạy được)

| Khía cạnh | K8s (production) | Docker Compose (lab này) | Có dạy được không? |
| --- | --- | --- | --- |
| **Cơ chế scale** | K8s tạo/destroy Pod | `docker compose --scale` tạo/destroy container | ✅ Cùng nguyên lý |
| **Service discovery** | K8s Service + Endpoint | Nginx `server` directive + Docker DNS | ✅ Cùng pattern |
| **Health check** | K8s readinessProbe | Docker HEALTHCHECK | ✅ Cùng khái niệm |
| **Metric source** | Prometheus/cAdvisor | Docker stats API | ✅ Cùng dạng metric |
| **Autoscaler loop** | K8s HPA controller | compose-autoscaler.ps1 | ✅ Cùng decision loop |
| **Cgroup/throttling** | Có CPU limit/throttle | Không (local Docker) | ⚠️ Khác — latency đo được không bị throttle |
| **Scheduler** | K8s scheduler chọn node | Docker daemon local | ⚠️ Khác — nhưng learner không cần biết |

**Kết luận:** Lab này mô phỏng ĐƯỢC logic autoscaling thực tế. Điểm khác biệt (cgroup, scheduler) là chi tiết hạ tầng — không ảnh hưởng đến bài học về **khi nào scale, scale bao nhiêu, state ra sao khi scale**.

---

## 3. Mental model

```text
k6 workload (CPU pressure)
        ↓
order-service replicas (1→N)
        ↓
Docker stats (CPU % per container)  ← metric source
        ↓
compose-autoscaler.ps1               ← controller (như K8s HPA)
  ├── Sample CPU mỗi 2s
  ├── CPU >= scale_out → docker compose --scale N+1
  ├── CPU <= scale_in  → docker compose --scale N-1
  └── Cooldown 12s ngăn flap
        ↓
Nginx upstream update (DNS resolve container mới)
        ↓
Dashboard tab Autoscale:
  GET /v1/autoscale/events?test_run_id=X
  artifacts/autoscale-events/autoscale-X.jsonl
```

---

## 4. 5 cases

| Case | Hỏi gì | Dạy gì | Script |
| --- | --- | --- | --- |
| **as-01** | Scale trong lúc traffic chạy → mất request không? | Redis state survive replica churn. Brief disruption tolerated. | 22-order-service-runtime-scale.js |
| **as-02** | CPU order-service quá tải → scale out? | CPU pressure trigger `scale_applied`. Replicas tăng 1→2/3. | 25-order-service-autoscale-controller.js |
| **as-03** | DB/payment quá tải → scale app cứu được không? | **KHÔNG.** App scale không fix được backend bottleneck. Phải scale DB/payment hoặc optimize query. | 30-capacity-sizing-sweep.js |
| **as-04** | Tải giảm → scale in ngay? | Cooldown ngăn scale-in vội vàng. Phải đợi stable low-load window. | 25-order-service-autoscale-controller.js |
| **as-05** | Nhiều replica → state có toàn vẹn không? | Idempotency/webhook/cart/order state vẫn đúng qua Redis/Postgres. Replica count không thay thế distributed state. | 25-order-service-autoscale-controller.js |

---

## 5. Autoscaler parameters

| Parameter | Default | Ý nghĩa |
| --- | ---: | --- |
| `ScaleOutCpuPercent` | 12 | Scale out khi tổng CPU >= ngưỡng này |
| `ScaleInCpuPercent` | 4 | Scale in khi tổng CPU <= ngưỡng này |
| `CooldownSeconds` | 12 | Chờ N giây giữa 2 lần scale |
| `SampleSeconds` | 2 | Check CPU mỗi N giây |
| `MinReplicas` | 1 | Không xuống dưới mức này |
| `MaxReplicas` | 3 | Không vượt quá mức này |

---

## 6. Production lesson

Autoscaling layer dạy learner 4 sự thật:

1. **Scale ngang không miễn phí**: Mỗi lần thêm replica có thể gây disruption (LB reload, connection reset). Production cần graceful drain.
2. **Scale không giải quyết mọi bottleneck**: Tăng app replica không fix được DB chậm hay external dependency quá tải (as-03).
3. **Cooldown = chống flap**: Không có cooldown, system scale up/down liên tục khi metric dao động quanh ngưỡng (as-04).
4. **State > Replica count**: Dù có 10 replica, vẫn cần Redis/Postgres để đảm bảo idempotency và consistency (as-05).
