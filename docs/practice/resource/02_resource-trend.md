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

## 4. Cách chạy

```powershell
$env:RESOURCE_TREND_RUN_ID = "res-02-test"
$env:RESOURCE_TREND_REPEATS = "4"
k6 run -o cloud ...27-resource-trend-benchmark.js
```
