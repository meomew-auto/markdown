# res-05 — Capacity sizing sweep

> **Case ID:** `res-05-capacity-sizing-sweep`
> **Script:** `../app/30-capacity-sizing-sweep.js`
> **Profile:** `full-no-cdn`, constant-arrival-rate, NO token
> **Proof:** Sweep DB-heavy workload → find capacity limit qua `dropped_iterations`, `db_ms`, VU pool behavior.

---

## 1. Tình huống thực tế

"Products service chịu được bao nhiêu req/s với db_rows=120?" — Sweep để tìm limit.

## 2. Sweep strategy

| Level | Rate | DB_ROWS | Expected |
| --- | ---: | ---: | --- |
| Light | 5 | 10 | 0 drops, latency thấp |
| Medium | 8 | 120 | 0 drops, latency medium |
| Heavy | 15 | 500 | drops > 0, DB saturated |

## 3. Key signals

- `dropped_iterations = 0` → đủ capacity
- `dropped_iterations > 0` → saturated — đây là capacity limit
- `capacity_breakdown_db_ms` — DB time per request
- `vus / vus_max` — VU pool usage

## 4. CAPACITY_SAMPLE format

Mỗi request log ra console JSON với `resource_model`, `breakdown`, `observed_resource_delta`.

## 5. Capacity curve

```text
Rate=5  → p95=6ms   (thoải mái)
Rate=8  → p95=8ms   (bắt đầu căng)
Rate=10 → p95=15ms  (gần limit)
Rate=12 → p95=45ms  (vượt limit, drops > 0)
```

## 6. Cách chạy

```powershell
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "8"; $env:CAPACITY_DB_ROWS = "120"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"; $env:CAPACITY_MAX_VUS = "40"
k6 run -o cloud ...30-capacity-sizing-sweep.js
```
