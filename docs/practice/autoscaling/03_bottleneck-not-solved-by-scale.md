# as-03 — Bottleneck NOT solved by scale

> **Case ID:** `as-03-scale-does-not-fix-backend`
> **Script:** `../app/30-capacity-sizing-sweep.js` với DB-heavy profile
> **Mô phỏng:** DB/payment-mock quá tải → thêm app replica không tăng throughput. Scale app không cứu được backend bottleneck.

---

> ✅ **CASE ĐÃ FIXED (BE round 6, verify 2026-07-15 — xem `BE_ISSUES.md` #8).**
> BE thêm **DB bottleneck thật** bằng `pg_advisory_lock` server-side (shared qua mọi replica) qua env `PRODUCTS_DB_LOCK_HOLD_MS`, và profile `db-bottleneck-practice` nâng rate limit để 429 không chạm trước. Giờ scenario tái hiện ĐÚNG bài học.
> A/B sạch (rate 8, db_rows 120, lock_hold 60ms, 30s): scale 1→3 replica → throughput **−0.34%** (đứng yên), db_p95 **173→349ms** (tệ hơn 2× vì đua chung 1 lock), 0×429, 27/27 gates PASS.
> **Cách chạy đúng:** dùng harness `scripts/run-as03-db-bottleneck.ps1` (tự bật lock + recreate + A/B + gates), hoặc set thủ công `PRODUCTS_DB_LOCK_HOLD_MS=60` + `CAPACITY_LOAD_PROFILE=db-bottleneck-practice` trước khi chạy.

## 1. Tình huống thực tế

"Trang sản phẩm bị chậm. Team devops scale products-service từ 1 lên 3 replica. Nhưng throughput vẫn không tăng, thậm chí latency còn tệ hơn. Tại sao?"

→ Vì bottleneck KHÔNG nằm ở app. Nó nằm ở DB (Postgres) hoặc external dependency (payment-mock) — thứ mà mọi replica dùng CHUNG.

---

## 2. Mô phỏng

```text
Cấu hình:
  CAPACITY_PROFILE      = "products_db_read"
  CAPACITY_LOAD_PROFILE = "db-bottleneck-practice"  ← nới rate limit, 429 không chạm trước
  CAPACITY_RATE         = 8
  CAPACITY_DB_ROWS      = 120
  PRODUCTS_DB_LOCK_HOLD_MS = 60   ← BE giữ pg_advisory_lock 60ms mỗi lần chạm DB

                  ┌───────────────────────┐
                  │  Postgres             │  ← BOTTLENECK THẬT
                  │  1 pg_advisory_lock   │    (chỉ 1 holder tại 1 thời điểm)
                  └───────────────────────┘
                        ↑ đua chung 1 khóa
          ┌─────────────┼─────────────┐
          │             │             │
    ┌──────────┐  ┌──────────┐  ┌──────────┐
    │products-1│  │products-2│  │products-3│  ← scale app 1→3
    │          │  │          │  │          │     không giúp được!
    └──────────┘  └──────────┘  └──────────┘
          ↑             ↑             ↑
          └─────────────┼─────────────┘
                        │
                    k6 traffic (8 req/s)

Kết quả (verified 2026-07-15): dù 1 hay 3 replica, throughput đứng yên ~8 success/s
→ Lock nằm TRONG Postgres → mọi replica serialize trên cùng 1 khóa
→ Thêm replica chỉ làm nhiều request xếp hàng hơn: db_p95 173ms → 349ms (×2)
→ 429 = 0 (rate limit đã nới) → bottleneck lộ rõ là DB, không phải app
→ Scale app KHÔNG giải quyết được bottleneck DB
```

---

## 3. Thí nghiệm

> Bottleneck thật do BE bơm vào bằng `PRODUCTS_DB_LOCK_HOLD_MS` (giữ `pg_advisory_lock` server-side mỗi lần chạm DB). Vì lock nằm TRONG Postgres, mọi replica đua chung 1 key → chỉ 1 request qua tại một thời điểm, scale app không nâng được trần. Dùng profile `db-bottleneck-practice` để nới rate limit (100000/phút) cho 429 không chạm trước.

### Cách nhanh nhất: harness A/B của BE
```powershell
cd E:\Projects\k6\k6-metrics-server
.\scripts\run-as03-db-bottleneck.ps1 -Build
# Tự rebuild, bật lock, chạy phase A (1 replica) + phase B (3 replica), chấm gate, xuất report
# artifacts/audits/as03-db-bottleneck-<ts>/as03-db-bottleneck.md
```

### Hoặc chạy tay từng bước

Bước 1 — 1 replica, bật lock:
```powershell
$env:PRODUCTS_DB_LOCK_HOLD_MS = "60"
$env:PRODUCTS_LIST_RAMPING_PRACTICE_RATE_LIMIT_PER_MINUTE = "100000"
# recreate products-service để nhận env (dùng stack.ps1 hoặc compose up -d --force-recreate products-service)
$env:CAPACITY_PROFILE = "products_db_read"; $env:CAPACITY_LOAD_PROFILE = "db-bottleneck-practice"
$env:CAPACITY_RATE = "8"; $env:CAPACITY_DB_ROWS = "120"; $env:CAPACITY_DURATION_SECONDS = "30"
k6 run .../30-capacity-sizing-sweep.js
# Ghi db_p95, success, 429
```

Bước 2 — scale products-service lên 3:
```powershell
docker compose -p k6target -f infra/compose/compose.target.yml up -d --scale products-service=3
```

Bước 3 — chạy lại cùng workload, so sánh:
```powershell
k6 run .../30-capacity-sizing-sweep.js
# So sánh throughput A vs B: KHÔNG tăng; db_p95 B ≈ 2× A vì đua chung lock
```

---

## 4. Pass/fail (verified 2026-07-15, harness A/B — BE_ISSUES #8 FIXED)

```text
✅ Baseline 1 replica: 241 success, 0×429, db_p95 = 173ms (DB đã là bottleneck)
✅ Scale products-service lên 3 replica
✅ Throughput KHÔNG tăng: gain = −0.34% (241 → 240 success/30s) ← đúng bài học
✅ db_p95 TĂNG khi scale: 173ms → 349ms (×2.02) vì 3 replica đua chung 1 advisory-lock
✅ dropped_iterations = 0, 429 = 0 (rate limit nới lên 100000, không còn che bottleneck)
✅ postgres/products-service: 0 restart, 0 OOM, 0 churn
→ 27/27 gate PASS. Scale app KHÔNG cứu được DB bottleneck — thông điệp case đã đúng.
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
