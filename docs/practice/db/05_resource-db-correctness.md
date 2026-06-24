# db-05 — DB resource model correctness

> **Case ID:** `db-05-resource-db-correctness`
> **Script:** `../app/26-resource-correctness-benchmark.js`
> **Profile:** `full-no-cdn`, NO `OPS_AUTH_TOKEN` needed
> **Proof:** `db_rows`/`db_writes` input qua query params khớp với `resource_model` và `breakdown` trong performance payload

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Trước khi dùng DB metrics cho capacity planning, cần xác nhận một điều cơ bản: **khi API được gọi với `?db_rows=60`, response có thực sự report `resource_model.db_rows=60` không?** Nếu contract này sai, mọi phân tích capacity sau đó đều dựa trên dữ liệu không đáng tin.

Case này là **sanity check** cho toàn bộ DB metrics pipeline.

### 1.2 Tại sao phải làm case này đầu tiên?

```text
db-05 (case này) → db-01 → db-02 → db-03 → db-04 → db-06
```

Nếu `db_ms` không xuất hiện trong response, tất cả case khác không thể verify được DB behavior. Đây là **prerequisite** cho toàn bộ DB layer.

---

## 2. DB capability được chứng minh

1. **Read path**: `GET /api/sim/products?db_rows=60` → `resource_model.db_rows = 60`, `breakdown.db_ms` present.
2. **Write path**: `POST /api/sim/checkout?db_writes=6` → `resource_model.db_writes = 6`, `breakdown.db_write_ms` present.
3. **Multiple endpoints**: Products (read), checkout (write), report, order status, cart — tất cả verified.
4. **Bottleneck detection**: `performance.bottleneck` và `bottleneck_percent` present.

---

## 3. Flow chính

```text
Script gọi nhiều endpoints với db_rows/db_writes khác nhau:

  1. GET /api/sim/products?db_rows=60 → check resource_model.db_rows
  2. GET /api/sim/products/:id?db_rows=30 → check
  3. GET /api/sim/products/search?db_rows=40 → check
  4. POST /api/sim/checkout?db_writes=6 → check resource_model.db_writes
  5. POST /api/sim/orders/:id/confirm?db_writes=3 → check
  6. GET /api/sim/report?db_rows=20 → check
  7. GET /api/sim/orders/:id?db_rows=25 → check
  ... (tổng cộng nhiều endpoints)

Mỗi response được check:
  - performance.resource_model.db_rows matches query param
  - performance.breakdown.db_ms present
  - performance.breakdown.db_write_ms present (cho write endpoints)
```

---

## 4. Key signals

| Signal | Source | Expected |
| --- | --- | --- |
| `resource_correctness_failures` | Counter | 0 |
| `performance.resource_model.db_rows` | Response body | Khớp query param |
| `performance.resource_model.db_writes` | Response body | Khớp query param |
| `performance.breakdown.db_ms` | Response body | Present, > 0 cho read endpoints |
| `performance.breakdown.db_write_ms` | Response body | Present, > 0 cho write endpoints |
| `performance.bottleneck` | Response body | Present |

---

## 5. Pass/fail criteria

```text
✅ resource_correctness_failures = 0
✅ checks rate = 100%
✅ http_req_failed = 0% (đây là case không có fault)
✅ db_rows check matches requested value
✅ db_writes check matches requested value
✅ db_ms và db_write_ms present trong mọi response
```

---

## 6. Cách chạy

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RESOURCE_CORRECTNESS_RUN_ID = "db-05-test"

k6 run E:/Projects/k6/k6-metrics-server/load-target/k6/app/26-resource-correctness-benchmark.js
```

---

## 7. Variations

- **Tăng db_rows cực đoan**: `?db_rows=500` — verify response vẫn chứa đúng resource_model
- **Thay đổi endpoint focus**: Chỉ test read path hoặc chỉ test write path
- **So sánh pre-post deploy**: Chạy trước và sau deploy để detect regression

---

## 8. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Bỏ qua case này, nhảy thẳng db-01** | Không biết DB metrics có đáng tin không |
| **Không check `db_write_ms`** | Bỏ sót write path contract |
| **Chạy với CDN** | CDN cache response → `db_ms` có thể bị cache từ request trước |
