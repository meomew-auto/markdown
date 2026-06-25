# as-03 — Bottleneck NOT solved by scale

> **Case ID:** `as-03-scale-does-not-fix-backend`
> **Script:** `../app/30-capacity-sizing-sweep.js` với DB-heavy profile
> **Mô phỏng:** DB/payment-mock quá tải → thêm app replica không tăng throughput. Scale app không cứu được backend bottleneck.

---

## 1. Tình huống thực tế

"Order confirm bị chậm. Team devops scale order-service từ 1 lên 3 replica. Nhưng throughput vẫn không tăng. Tại sao?"

→ Vì bottleneck KHÔNG nằm ở app. Nó nằm ở DB (Postgres) hoặc external dependency (payment-mock).

---

## 2. Mô phỏng

```text
Cấu hình:
  CAPACITY_PROFILE = "products_db_read"
  CAPACITY_RATE = 8          ← vượt ceiling
  CAPACITY_DB_ROWS = 120     ← DB nặng

                  ┌──────────────┐
                  │  Postgres    │  ← BOTTLENECK THẬT
                  │  db_rows=120 │
                  └──────────────┘
                        ↑
          ┌─────────────┼─────────────┐
          │             │             │
    ┌──────────┐  ┌──────────┐  ┌──────────┐
    │ order-1  │  │ order-2  │  │ order-3  │  ← scale app 1→3
    │          │  │          │  │          │     không giúp được!
    └──────────┘  └──────────┘  └──────────┘
          ↑             ↑             ↑
          └─────────────┼─────────────┘
                        │
                    k6 traffic (8 req/s)

Kết quả: dù 1 hay 3 replica, throughput vẫn ~5 success/s
→ 429 vẫn xuất hiện (DB không theo kịp)
→ Scale app KHÔNG giải quyết được bottleneck DB
```

---

## 3. Thí nghiệm

### Bước 1: 1 replica — đo baseline
```powershell
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "8"; $env:CAPACITY_DB_ROWS = "120"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"; $env:CAPACITY_MAX_VUS = "40"
k6 run -o cloud .../30-capacity-sizing-sweep.js
# Kết quả: ~76% success, ~24% 429
```

### Bước 2: Scale app lên 3 replica
```powershell
# Scale order-service lên 3
docker compose -p k6target ... up -d --scale order-service=3
```

### Bước 3: Chạy lại cùng workload
```powershell
# Cùng CAPACITY_RATE=8, CAPACITY_DB_ROWS=120
k6 run -o cloud .../30-capacity-sizing-sweep.js
# Kết quả: VẪN ~76% success, ~24% 429  ← KHÔNG cải thiện!
```

---

## 4. Pass/fail

```text
✅ Chạy baseline với 1 replica → ghi nhận success rate
✅ Scale app lên 3 replica
✅ Chạy lại → success rate KHÔNG tăng đáng kể (< 5% cải thiện)
✅ capacity_breakdown_db_ms vẫn cao → chứng minh bottleneck ở DB
✅ dropped_iterations vẫn = 0 → app không phải bottleneck
⚠️ Nếu success rate TĂNG → bottleneck nằm ở app, không phải DB. Cũng là bài học!
```

---

## 5. Cách phân biệt bottleneck

| Dấu hiệu | Bottleneck ở App | Bottleneck ở DB |
| --- | --- | --- |
| Scale app → throughput tăng | ✅ Có | ❌ Không |
| `capacity_breakdown_db_ms` | Thấp, ổn định | Cao, chiếm >50% thời gian |
| `http_req_duration` | Giảm khi thêm replica | Không đổi |
| 429 rate | Giảm khi thêm replica | Không đổi |
| DB container CPU | Thấp | **Cao, bão hòa** |

---

## 6. Bài học

- **Scale app không fix được backend bottleneck**: Thêm app replica chỉ giải quyết được app-level bottleneck (CPU, connection pool). DB, external API, message queue — cần giải pháp riêng.
- **Phải tìm bottleneck thật trước khi scale**: Đo breakdown (db_ms, external_ms, cpu_ms) trước khi quyết định scale cái gì.
- **Scale DB cũng là scale ngang**: Read replica, connection pooler, cache layer — đều là scale ngang nhưng ở tầng khác.
