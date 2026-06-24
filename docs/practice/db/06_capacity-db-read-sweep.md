# db-06 — DB read capacity sweep

> **Case ID:** `db-06-capacity-db-read-sweep`
> **Script:** `../app/30-capacity-sizing-sweep.js`
> **Profile:** `full-no-cdn`, `constant-arrival-rate`, NO token needed
> **Proof:** Sweep DB-heavy read workload từ nhẹ đến nặng → đọc `dropped_iterations`, `db_ms`, VU pool behavior để xác định capacity limit

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Team muốn biết: "Products service có thể chịu được bao nhiêu request/giây khi mỗi request query 120 rows từ DB?" Đây là câu hỏi **capacity planning** — không phải pass/fail.

Case này dùng **constant-arrival-rate** (open model) để sweep: giữ nguyên rate, thay đổi `db_rows` từ nhẹ (10) đến nặng (500), quan sát khi nào `dropped_iterations` bắt đầu xuất hiện.

### 1.2 Sweep pattern

```text
Light:   CAPACITY_RATE=5,  CAPACITY_DB_ROWS=10   → 0 drops, latency thấp
Medium:  CAPACITY_RATE=8,  CAPACITY_DB_ROWS=120  → 0 drops, latency tăng
Heavy:   CAPACITY_RATE=15, CAPACITY_DB_ROWS=500  → drops xuất hiện, DB saturated
```

---

## 2. Flow chính

```text
1. Tạo request với CAPACITY_DB_ROWS và CAPACITY_RATE
2. k6 gửi sustained arrival-rate suốt CAPACITY_DURATION_SECONDS
3. Quan sát:
   - iterations (có thể < rate nếu dropped)
   - dropped_iterations
   - vus (actual VUs used)
   - http_req_duration (DB latency)
   - capacity_breakdown_db_ms
   - capacity_bottleneck_samples
```

---

## 3. Key signals

| Signal | Ý nghĩa |
| --- | --- |
| `dropped_iterations` | = 0 → đủ capacity; > 0 → saturated |
| `capacity_breakdown_db_ms` | DB read time per request |
| `capacity_check_failures` | Must = 0 |
| `vus` / `vus_max` | Actual VU usage vs ceiling |
| `http_req_duration` p95 | DB latency under sustained load |

---

## 4. Pass/fail (khác với case khác)

```text
✅ capacity_check_failures = 0 (contract đúng)
✅ dropped_iterations được interpret với rate + VU pool
✅ db_ms và resource_model present trong mọi response
📊 Capacity limit là khi dropped_iterations > 0 hoặc p95 vượt ngưỡng
```

---

## 5. Cách chạy

```powershell
# Light sweep
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "5"; $env:CAPACITY_DB_ROWS = "10"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_PRE_ALLOCATED_VUS = "10"; $env:CAPACITY_MAX_VUS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js

# Heavy sweep
$env:CAPACITY_RATE = "15"; $env:CAPACITY_DB_ROWS = "500"
k6 run -o cloud ...
```

---

## 6. Variations

- **Products DB read**: `CAPACITY_PROFILE=products_db_read` (default)
- **Report gzip**: `CAPACITY_PROFILE=report_gzip` — test report service
- **Checkout mixed**: `CAPACITY_PROFILE=checkout_mixed` — test write path capacity
- **Memory-heavy**: `CAPACITY_PROFILE=memory_intensive` — test memory capacity

---

## 7. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Chỉ chạy 1 data point** | Không biết capacity curve — cần sweep |
| **Không record VU usage** | Không biết liệu maxVUs có đủ không |
| **Aggregate latency không filter theo db_rows** | Mất context DB load |
