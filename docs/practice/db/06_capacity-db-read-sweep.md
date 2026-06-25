# db-06 — DB read capacity sweep

> **Case ID:** `db-06-capacity-db-read-sweep`
> **Script:** `../app/30-capacity-sizing-sweep.js`
> **Profile:** `full-no-cdn`, `constant-arrival-rate`, **NO token needed**
> **Workload:** Open-model arrival-rate sweep
> **Proof:** Sweep DB-heavy read workload từ nhẹ đến nặng — đọc `dropped_iterations`, `db_ms`, VU pool behavior, `resource_model` để xác định capacity limit. Đây là **capacity planning case** — không phải pass/fail đơn thuần.

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Team muốn biết: "Products service có thể chịu được bao nhiêu request/giây khi mỗi request query 120 rows từ DB?" Đây là câu hỏi **capacity planning** — cần sweep để tìm limit, không phải test pass/fail.

### 1.2 Sweep pattern

```text
Light:   CAPACITY_RATE=5,  CAPACITY_DB_ROWS=10   → 0 drops, latency thấp
Medium:  CAPACITY_RATE=8,  CAPACITY_DB_ROWS=120  → 0 drops, latency medium
Heavy:   CAPACITY_RATE=15, CAPACITY_DB_ROWS=500  → drops xuất hiện, DB saturated
```

Mỗi data point là một lần chạy với rate và db_rows khác nhau. Vẽ curve: rate (x) vs p95 latency (y) — điểm uốn là capacity limit.

### 1.3 Constant-arrival-rate (open model)

```text
Khác với constant-vus (closed model):
  - Closed: VUs cố định, RPS phụ thuộc latency
  - Open: RATE cố định, VUs tăng để đạt rate

Open model phù hợp cho capacity testing vì:
  - Bạn muốn biết "ở rate X, hệ thống có theo kịp không?"
  - dropped_iterations cho biết hệ thống đã saturated
```

---

## 2. DB capability được chứng minh

1. **Rate sweep**: Gửi sustained arrival rate, quan sát system behavior.
2. **DB metrics under load**: `db_ms`, `resource_model.db_rows` trong từng CAPACITY_SAMPLE.
3. **Bottleneck detection**: `performance.bottleneck` rotates giữa `cpu_ms` và `db_ms`.
4. **Resource delta observation**: CPU, memory, heap objects delta per sample.

---

## 3. Flow chính

```text
1. k6 tạo constant-arrival-rate scenario với CAPACITY_RATE và CAPACITY_DB_ROWS
2. Mỗi iteration gọi GET /api/sim/products?db_rows={CAPACITY_DB_ROWS}&...
3. k6 log CAPACITY_SAMPLE JSON mỗi request (qua console)
4. Quan sát cuối run:
   - iterations (actual completed)
   - dropped_iterations (nếu > 0 → saturated)
   - vus / vus_max (actual VU usage)
   - http_req_duration p95
   - capacity_breakdown_db_ms
```

---

## 4. Key signals

| Signal | Ý nghĩa |
| --- | --- |
| `dropped_iterations` | = 0 → đủ capacity; > 0 → saturated |
| `capacity_breakdown_db_ms` | DB read time under sustained load |
| `capacity_check_failures` | Must = 0 |
| `vus` / `vus_max` | Actual vs ceiling VU usage |
| `http_req_duration` p95 | DB latency at this rate |
| `resource_model.db_rows` | Verified = CAPACITY_DB_ROWS |
| `performance.bottleneck` | `cpu_ms` hoặc `db_ms` — cái nào đang giới hạn? |

---

## 5. Pass/fail (khác với case khác)

```text
✅ capacity_check_failures = 0 (contract đúng ở mọi rate)
✅ resource_model.db_rows matches CAPACITY_DB_ROWS
📊 Capacity limit = rate mà tại đó dropped_iterations > 0
📊 DB saturation = rate mà tại đó bottleneck = "db_ms" > 50%
```

---

## 6. CAPACITY_SAMPLE format

Mỗi request log ra console:

```json
{
  "run_id": "capacity-sizing-...",
  "profile": "products_db_read",
  "target_rate": 8,
  "endpoint": "products_list",
  "status": 200,
  "duration_ms": 6.3,
  "success": true,
  "bottleneck": "db_ms",
  "bottleneck_percent": 40,
  "breakdown": { "cpu_ms": 2, "db_ms": 2, "json_ms": 1 },
  "resource_model": {
    "db_rows": 120,
    "db_round_trips": 2,
    "payload_bytes": 19072,
    ...
  },
  "observed_resource_delta": {
    "wall_ms": 4.5,
    "cpu_total_ms_delta": 0,
    "heap_alloc_mb_delta": 0.69,
    ...
  }
}
```

---

## 7. Cách chạy + sweep strategy

```powershell
# Light
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "5"; $env:CAPACITY_DB_ROWS = "10"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_PRE_ALLOCATED_VUS = "10"; $env:CAPACITY_MAX_VUS = "30"
k6 run -o cloud ...

# Medium
$env:CAPACITY_RATE = "8"; $env:CAPACITY_DB_ROWS = "120"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"; $env:CAPACITY_MAX_VUS = "40"
k6 run -o cloud ...

# Heavy
$env:CAPACITY_RATE = "15"; $env:CAPACITY_DB_ROWS = "500"
$env:CAPACITY_PRE_ALLOCATED_VUS = "20"; $env:CAPACITY_MAX_VUS = "60"
k6 run -o cloud ...
```

---

## 8. Variations

| Profile | Endpoint | DB Load |
| --- | --- | --- |
| `products_db_read` | GET /api/sim/products | db_rows, json_items |
| `report_gzip` | GET /api/sim/report | db_rows, gzip_kb |
| `checkout_mixed` | POST /api/sim/checkout | db_writes, external_ms |
| `memory_intensive` | Various | memory_kb, retain_memory_kb |

---

## 9. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Chỉ chạy 1 data point** | Không biết capacity curve |
| **Không record VU usage** | Không biết maxVUs có đủ không |
| **Aggregate latency không filter theo db_rows** | Mất context DB load |
| **Không log CAPACITY_SAMPLE** | Mất evidence per-request |

---

## 10. Real validation data

### Run #121 (2026-06-25) — Medium sweep

```text
Profile: products_db_read
Rate: 8 req/s, DB_ROWS: 120
Duration: 30s
PreAllocatedVUs: 12, MaxVUs: 40

CAPACITY_SAMPLE observations:
  - resource_model.db_rows: 120 ✓
  - breakdown.db_ms: 2ms
  - bottleneck: rotates cpu_ms/db_ms (40% each)
  - observed_resource_delta.heap_alloc_mb_delta: ~0.7MB per request
  - duration_ms: 5-7ms avg
  - dropped_iterations: 0 (system handles 8 rps easily)
```

---

## 11. Reference

- **Script**: `k6/app/30-capacity-sizing-sweep.js`
- **Catalog**: `k6/db/case-catalog.json`
- **Dashboard**: `http://localhost:13001/` → run #121
- **Profiles**: `products_db_read`, `report_gzip`, `checkout_mixed`, `memory_intensive`
