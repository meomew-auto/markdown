# res-02 — Resource trend monotonicity

> **Case ID:** `res-02-resource-trend`
> **Script:** `../app/27-resource-trend-benchmark.js`
> **Profile:** `full-no-cdn`, 1 VU, NO token
> **Proof:** Tăng resource knobs (off→medium→high) → metrics tăng monotonic. 8 families: cpu, db_read, db_write, payload, memory, disk, gzip, external.

---

## 1. Tình huống thực tế

Bạn muốn biết: "Nếu tăng `cpu_ms` từ 0 lên 24, `observed_resource_delta.cpu_total_ms_delta` có tăng không?" Nếu không tăng, bottleneck analysis sẽ sai — bạn nghĩ CPU đang rảnh nhưng thực ra service đang bị throttle.

## 2. 8 trend families

| Family | Off | Medium | High | Primary metric |
| --- | --- | --- | --- | --- |
| cpu | 0ms | 8ms | 24ms | `breakdown.cpu_ms` |
| db_read | 0 rows | 40 rows | 120 rows | `breakdown.db_ms` |
| db_write | 0 writes | 4 writes | 12 writes | `breakdown.db_write_ms` |
| payload | 0 items | 20 items | 100 items | `resource_model.json_target_items` |
| memory | 0 KB | 512 KB | 2048 KB | `resource_model.memory_kb` |
| disk | 0 KB | 32 KB | 128 KB | `resource_model.disk_kb` |
| gzip | 0 KB | 32 KB | 256 KB | `resource_model.gzip_kb` |
| external | 0ms | 40ms | 120ms | `breakdown.external_ms` |

## 3. Pass/fail

```text
✅ resource_trend_failures = 0
✅ Mỗi family: off < medium < high (monotonic)
✅ Trend ratio high/medium > 1.5x
```

## 4. Real validation

**Run #130** (2026-06-25): 490/490 checks (100%), 0 failures, 120 reqs, avg=11.21ms, p95=61.31ms, p99=137.73ms.

All 8 families monotonic:
- cpu: off(2ms) → medium(4ms) → high(13ms) ✅
- db_read: off(2ms) → medium(7ms) → high(45ms) ✅
- db_write: off(2ms) → medium(5ms) → high(18ms) ✅
- payload: off(2ms) → medium(4ms) → high(12ms) ✅
- external: off(2ms) → medium(6ms) → high(35ms) ✅
- memory: off(2ms) → medium(3ms) → high(8ms) ✅
- disk: off(3ms) → medium(5ms) → high(10ms) ✅
- gzip: off(3ms) → medium(5ms) → high(10ms) ✅

High db_read level dominates tail latency (p95=61ms, p99=138ms) — expected with 120 rows.

## 5. Cách chạy

```powershell
$env:RESOURCE_TREND_RUN_ID = "res-02-test"
$env:RESOURCE_TREND_REPEATS = "4"
k6 run -o cloud ...27-resource-trend-benchmark.js
```
