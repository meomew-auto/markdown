# db-05 — DB resource model correctness

> **Case ID:** `db-05-resource-db-correctness`
> **Script:** `../app/26-resource-correctness-benchmark.js`
> **Profile:** `full-no-cdn`, **NO `OPS_AUTH_TOKEN` needed**
> **Workload:** 1 VU, 1 iteration (sequential)
> **Proof:** `db_rows`/`db_writes` input qua query params khớp với `performance.resource_model` và `performance.breakdown` trong response body. Đây là **sanity check cho toàn bộ DB metrics pipeline** — phải làm đầu tiên trước mọi DB case khác.

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [DB capability được chứng minh](#2-db-capability-được-chứng-minh)
3. [Vì sao phải test ở DB layer](#3-vì-sao-phải-test-ở-db-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Service mechanism deep-dive: resource_model contract](#6-service-mechanism-deep-dive-resource_model-contract)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals](#8-key-signals)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output → decision scenarios](#11-4-output--decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist](#13-checklist)
14. [4-5 Variations](#14-4-5-variations)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Trước khi dùng DB metrics cho capacity planning, cần xác nhận một điều cơ bản: **khi API được gọi với `?db_rows=60`, response có thực sự report `resource_model.db_rows=60` không?**

Nếu contract này sai:
- Mọi phân tích capacity sau đó đều dựa trên dữ liệu không đáng tin
- Bạn có thể nghĩ DB đang query 60 rows nhưng thực ra là 6
- `db_ms` có thể bị sai lệch
- Bottleneck detection (`bottleneck: "db_ms"`) có thể sai

### 1.2 Đây là prerequisite

```text
db-05 (case này) → db-01 → db-02 → db-03 → db-04 → db-06
```

Nếu `db_ms` không xuất hiện trong response, tất cả case khác không thể verify được DB behavior.

### 1.3 Performance payload contract

Mỗi API response trong hệ thống này có `performance` object:

```json
{
  "success": true,
  "data": { ... },
  "performance": {
    "breakdown": {
      "cpu_ms": 2,       // CPU processing time
      "db_ms": 5,        // DB read time
      "db_write_ms": 12, // DB write time (chỉ write endpoints)
      "json_ms": 1       // JSON serialization time
    },
    "resource_model": {
      "db_rows": 60,     // Số rows query param yêu cầu
      "db_writes": 6,    // Số writes query param yêu cầu
      "db_round_trips": 2
    },
    "bottleneck": "db_ms",
    "bottleneck_percent": 55
  }
}
```

---

## 2. DB capability được chứng minh

### 2.1 Phát biểu capability

> **Mọi API response đều chứa `performance.resource_model` và `performance.breakdown`. `resource_model.db_rows` khớp chính xác với query param `?db_rows=N`. `resource_model.db_writes` khớp với `?db_writes=N`. `breakdown.db_ms` và `breakdown.db_write_ms` present trên các endpoint tương ứng.**

### 2.2 Verified endpoints

| Endpoint | Type | Expected in response |
| --- | --- | --- |
| `GET /api/sim/products?db_rows=60` | Read | `resource_model.db_rows=60`, `breakdown.db_ms` |
| `GET /api/sim/products/:id?db_rows=30` | Read | `resource_model.db_rows=30`, `breakdown.db_ms` |
| `GET /api/sim/products/search?db_rows=40` | Read | `resource_model.db_rows=40`, `breakdown.db_ms` |
| `POST /api/sim/checkout?db_writes=6` | Write | `resource_model.db_writes=6`, `breakdown.db_write_ms` |
| `POST /api/sim/orders/:id/confirm?db_writes=3` | Write | `resource_model.db_writes=3`, `breakdown.db_write_ms` |
| `GET /api/sim/report?db_rows=20` | Read | `resource_model.db_rows=20`, `breakdown.db_ms` |
| ... (tổng ~28 endpoints) | | |

---

## 3. Vì sao phải test ở DB layer

### 3.1 Không layer nào khác verify được resource_model

- **CDN**: Cache response — có thể cache response cũ với `resource_model` sai
- **LB**: Không parse response body
- **Microservices**: Verify API contract (`success`, `data`) nhưng không verify `performance` payload
- **Redis**: Không liên quan đến DB metrics

### 3.2 Đây là trust foundation

Nếu `resource_model` sai, mọi DB test case sau đó (db-01 → db-06) đều đọc sai metrics. Case này establish **trust** vào DB metrics pipeline.

---

## 4. Topology

```text
Script: ../app/26-resource-correctness-benchmark.js
Executor: 1 VU, 1 iteration (sequential)
Topology: full-no-cdn
BASE_URL: http://localhost:80 (default)
NO OPS_AUTH_TOKEN needed
```

---

## 5. Script deep-dive

```javascript
// Gọi nhiều endpoints với db_rows/db_writes khác nhau
// Mỗi response được parse và verify:

function verifyPerformance(payload, expected) {
  const p = payload.performance;
  const rm = p.resource_model;
  const bd = p.breakdown;

  // Verify resource_model
  if (expected.db_rows && rm.db_rows !== expected.db_rows) fail('db_rows mismatch');
  if (expected.db_writes && rm.db_writes !== expected.db_writes) fail('db_writes mismatch');

  // Verify breakdown
  if (rm.db_rows > 0 && typeof bd.db_ms !== 'number') fail('db_ms missing');
  if (rm.db_writes > 0 && typeof bd.db_write_ms !== 'number') fail('db_write_ms missing');

  // Verify bottleneck
  if (!p.bottleneck) fail('bottleneck missing');
}
```

---

## 6. Mechanism deep-dive

### 6.1 Query param → resource_model mapping

```text
Client request:
  GET /api/sim/products?db_rows=120&cpu_ms=8&json_items=100

Server xử lý:
  1. Parse query params: db_rows=120, cpu_ms=8, json_items=100
  2. Thực thi DB query với 120 rows
  3. Build response:
     - data.products (120 items)
     - performance.resource_model.db_rows = 120
     - performance.resource_model.cpu_target_ms = 8
     - performance.resource_model.json_target_items = 100
     - performance.breakdown.db_ms = <actual DB time>
     - performance.breakdown.cpu_ms = <actual CPU time>

Contract:
  resource_model.db_rows PHẢI = query param db_rows
  (không phải số rows thực tế trả về — mà là số rows được yêu cầu)
```

### 6.2 Tại sao resource_model quan trọng cho capacity planning?

```text
Khi sweep capacity (db-06):
  - db_rows=10  → db_ms ≈ 2ms  → RPS cao
  - db_rows=120 → db_ms ≈ 5ms  → RPS trung bình
  - db_rows=500 → db_ms ≈ 20ms → RPS thấp, có thể drop iteration

Nếu resource_model sai, bạn không thể map db_rows → db_ms → capacity limit.
```

---

## 7. Request sequence flow

```text
1.  GET /api/sim/products?db_rows=60&cpu_ms=8&json_items=100
    → verify resource_model.db_rows=60, breakdown.db_ms present
2.  GET /api/sim/products/:id?db_rows=30
    → verify resource_model.db_rows=30
3.  GET /api/sim/products/search?db_rows=40
    → verify resource_model.db_rows=40
4.  POST /api/sim/checkout?db_writes=6&cpu_ms=4
    → verify resource_model.db_writes=6, breakdown.db_write_ms present
5.  POST /api/sim/orders/:id/confirm?db_writes=3
    → verify resource_model.db_writes=3
6.  GET /api/sim/report?db_rows=20
    → verify resource_model.db_rows=20
... (tổng ~28 endpoints, kết hợp read/write/mixed)
```

---

## 8. Key signals

| Signal | Expected |
| --- | --- |
| `checks` | 100% |
| `resource_correctness_failures` | 0 |
| `http_req_failed` | 0% (không có fault) |
| `resource_model.db_rows` | Khớp query param `?db_rows=N` |
| `resource_model.db_writes` | Khớp query param `?db_writes=N` |
| `breakdown.db_ms` | Present khi `db_rows > 0` |
| `breakdown.db_write_ms` | Present khi `db_writes > 0` |
| `performance.bottleneck` | Present (string) |

---

## 9. Pass/fail

```text
✅ resource_correctness_failures = 0
✅ checks rate = 100%
✅ http_req_failed = 0%
✅ Mọi response có db_rows → breakdown.db_ms present
✅ Mọi response có db_writes → breakdown.db_write_ms present
✅ resource_model khớp query params trên mọi endpoint
```

---

## 10. Cách chạy + output

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RESOURCE_CORRECTNESS_RUN_ID = "db-05-test"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/26-resource-correctness-benchmark.js
```

### Output mẫu (Run #116)

```text
checks_total.......: 355
checks_succeeded...: 100% 355 out of 355
resource_correctness_failures: 0
http_req_failed....: 0% 0 out of 28
http_req_duration..: avg=5.6ms med=2.7ms p95=20.5ms
```

---

## 11. 4 output → decision scenarios

### Scenario A: Tất cả pass

```text
→ DB metrics pipeline đáng tin. Tiếp tục db-01.
```

### Scenario B: `resource_model.db_rows` sai

```text
→ Contract violation — service không report đúng input.
→ Không thể tin tưởng DB metrics cho capacity planning.
→ Cần fix BE trước khi tiếp tục.
```

### Scenario C: `breakdown.db_ms` missing

```text
→ Read path không expose DB time.
→ db-01, db-02, db-06 không thể verify được.
→ BE cần thêm db_ms vào performance payload.
```

### Scenario D: `breakdown.db_write_ms` missing

```text
→ Write path không expose DB write time.
→ db-01 (checkout trong delay phase) không verify được write impact.
```

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "resource_model.db_rows = số rows thực tế"

```text
SAI. resource_model.db_rows = số rows ĐƯỢC YÊU CẦU (query param).
Nếu query param db_rows=60 nhưng DB chỉ có 30 rows,
resource_model.db_rows vẫn = 60.
```

### Nghịch lý 2: "Case này quá đơn giản — bỏ qua được"

```text
SAI. Đây là sanity check quan trọng nhất.
Nếu bỏ qua, mọi DB metric trong case sau có thể là rác.
```

---

## 13. Checklist

- [ ] Stack `full-no-cdn` đang chạy
- [ ] Không cần OPS_AUTH_TOKEN
- [ ] `resource_correctness_failures = 0`
- [ ] Tất cả endpoints verified
- [ ] `db_ms` present trên read endpoints
- [ ] `db_write_ms` present trên write endpoints

---

## 14. Variations

- **Chỉ test read path**: Sửa script để skip write endpoints
- **Tăng db_rows cực đoan**: `?db_rows=1000` — verify response vẫn đúng
- **So sánh pre-post deploy**: Chạy trước và sau deploy để detect regression

---

## 15. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Bỏ qua case này** | Không biết DB metrics có đáng tin không |
| **Không check `db_write_ms`** | Bỏ sót write path contract |
| **Chạy với CDN** | CDN cache response → `db_ms` bị cache từ request trước |

---

## 16. Real validation data

### Run #116 (2026-06-25)

```json
{
  "run_id": "116",
  "checks_passes": 355, "checks_fails": 0, "checks_rate": 1.0,
  "http_req_failed_rate": 0, "http_reqs": 28, "iterations": 1,
  "http_req_duration_avg": 5.6, "http_req_duration_med": 2.7,
  "http_req_duration_p95": 20.5
}
```

---

## 17. Reference

- **Script**: `k6/app/26-resource-correctness-benchmark.js`
- **Catalog**: `k6/db/case-catalog.json`
- **Dashboard**: `http://localhost:13001/` → run #116
- **Next case**: db-01 (DB delay recovery)
