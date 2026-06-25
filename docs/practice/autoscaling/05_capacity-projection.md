# as-05 — Replica recommendation from capacity sweep

> **Case ID:** `as-05-capacity-projection`
> **Script:** `../app/30-capacity-sizing-sweep.js`
> **Proof:** Tìm safe RPS/replica → tính recommended replicas cho target traffic. Autoscaling policy phải dựa trên capacity đo được, không phải guess.

---

## 1. Tình huống thực tế

"Trước khi set min/max replicas cho autoscaler, cần biết: 1 replica chịu được bao nhiêu req/s an toàn? Với target RPS dự kiến, cần ít nhất bao nhiêu replica?"

## 2. Capacity projection formula

```text
Bước 1: Chạy capacity sweep → tìm safe RPS/replica
  Rate=3, db_rows=80 → 100% success, 0 fail
  → Safe RPS/replica = 3

Bước 2: Tính utilization target
  Không chạy ở 100% capacity → để headroom 30%
  → Utilization target = 0.7

Bước 3: Tính recommended replicas
  target_rps = 15 (dự kiến)
  recommended = ceil(target_rps / safe_rps_per_replica / utilization)
             = ceil(15 / 3 / 0.7)
             = ceil(7.14)
             = 8 replicas
```

## 3. Sweep methodology

```text
Giữ nguyên profile (products_db_read), thay đổi RATE để tìm ceiling:

Rate=3  → 100% xanh, p95=7ms   ← safe
Rate=5  → 99% xanh, p95=9ms    ← gần ceiling  
Rate=6  → 83% xanh, 17% fail   ← vượt ceiling
Rate=8  → 76% xanh, 24% fail   ← đã vượt xa

→ Safe RPS/replica = 3-5 tùy mức độ an toàn mong muốn
→ Với DB rows=80, service bắt đầu bão hòa ở rate=5
```

## 4. Áp dụng vào autoscaler config

```text
Với safe RPS/replica = 3:
  ┌─────────────┬──────────┬──────────┐
  │ Target RPS  │ Min      │ Max      │
  ├─────────────┼──────────┼──────────┤
  │ 3 (low)     │ 1        │ 2        │
  │ 6 (medium)  │ 2        │ 4        │
  │ 12 (high)   │ 4        │ 6        │
  └─────────────┴──────────┴──────────┘

Min = ceil(target * 0.7 / safe_rps)
Max = Min * 2 (cho burst capacity)
```

## 5. Cách chạy

### Sweep tìm safe RPS
```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "3"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_PRE_ALLOCATED_VUS = "10"
$env:CAPACITY_MAX_VUS = "25"
$env:CAPACITY_DB_ROWS = "80"
$env:CAPACITY_RUN_ID = "as-capacity-sweep"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

Lặp lại với RATE=4, 5, 6 để vẽ đường cong capacity.

### Tính recommendation

```python
safe_rps_per_replica = 3  # từ sweep
utilization_target = 0.7  # 30% headroom
target_rps = 10

recommended = math.ceil(target_rps / safe_rps_per_replica / utilization_target)
print(f"Recommended replicas for {target_rps} RPS: {recommended}")
```

## 6. Pass/fail

```text
✅ Capacity sweep hoàn thành, tìm được safe RPS/replica
✅ Recommended replicas dựa trên số đo, không phải guess
✅ Autoscaler min/max được calibrate từ capacity test
✅ Nếu tăng db_rows (schema change) → chạy lại sweep, cập nhật recommendation
```

## 7. Bài học

- **Autoscaler config không phải số ma thuật**: Min/max replicas phải đến từ capacity test thật.
- **Safe RPS/replica thay đổi theo workload**: DB-heavy (db_rows=120) có safe RPS thấp hơn CPU-light.
- **Utilization target là trade-off**: 50% → an toàn nhưng tốn resource. 90% → tiết kiệm nhưng dễ vượt ceiling.
- **Sweep định kỳ**: Mỗi lần thay đổi schema, query, hoặc dependency, chạy lại capacity sweep để cập nhật autoscaler config.
