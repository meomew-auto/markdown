# BE Issues — Autoscaling Layer Validation

> Cập nhật lần cuối: 2026-06-30 (sau BE deploy round 5, validate Run #184)

## Trạng thái tổng quan

| # | Mức | Issue | Trạng thái |
| --- | --- | --- | --- |
| 1 | CRITICAL | autoscaler gọi stack.ps1 → restart nginx | ✅ FIXED (BE chuyển sang docker compose --scale) |
| 2 | HIGH | list không trả test_run_id | ✅ FIXED (BE thêm alias) |
| 3 | HIGH | data historical mất sau deploy | ✅ FIXED (Run #176-#184 đều intact sau deploy round 5) |
| 4 | MEDIUM | reuse test_run_id đã finished | ✅ FIXED (k6 run -o cloud tạo run mới) |
| 5 | LOW | list trả metrics=null | ✅ FIXED (list giờ include summary_metrics đầy đủ) |
| 6 | LOW | scale_applied(initial) ghi 1→1 | ✅ FIXED (đổi sang scale_observed/initial_already_satisfied) |
| 7 | CRITICAL | run-id resolution gom CẢ list reference_id | ✅ FIXED (Get-RunReferenceId reject mảng count≠1) |
| 8 | HIGH | as-03 scenario KHÔNG tái hiện được bài học: scale app 1→3 → success 41.7%→100% (NGƯỢC bài học) | ✅ FIXED (BE thêm pg_advisory_lock bottleneck + profile db-bottleneck-practice; verify 2026-07-15) |

**8/8 issues đã FIXED. Issue #8 (scenario design) verify lại 2026-07-15 (round 6): scale 1→3 → throughput −0.34%, db_p95 173→349ms, 0×429, 27/27 gates PASS — chi tiết cuối file.**

---

## Verify round 5 — Run #184 (2026-06-30)

### Timeline
```
t=0s:   controller_started (replicas=3 leftover từ run trước)
t=2s:   scale_applied(initial): 3→1 (cleanup về MinReplicas)
t=4s:   decision(cooldown, CPU 18.71%, cooldown_remaining=8s)
t=8s:   decision(cooldown, CPU 17.98%, cooldown_remaining=3s)
t=12s:  decision(cpu_high, CPU 17.25%) → SCALE 1→2 🔥
t=22s:  decision(cooldown, CPU 24.51%)
t=26s:  decision(cooldown, CPU 19.44%)
t=30s:  decision(cpu_high, CPU 20.51%) → SCALE 2→3 🔥
t=42s:  decision(cooldown, CPU 20.56%)
t=46s:  decision(cooldown, CPU 23.38%)
t=50s:  decision(cpu_low, CPU 0.01%) → SCALE 3→2 🔻 (k6 ended)
t=52s:  decision(cooldown, CPU 1.20%)
t=56s:  decision(cooldown, CPU 0.00%)
t=60s:  decision(cpu_low, CPU 0.62%) → SCALE 2→1 🔻
t=63s:  controller_stopped (replicas=1)
```

### Kết quả
- 35,134 requests (390 req/s)
- 5 scale_applied: initial 3→1, cpu_high 1→2, cpu_high 2→3, cpu_low 3→2, cpu_low 2→1
- 19 events total, 8 cooldown blocks
- Nginx RestartCount=0 (không restart, vẫn up từ 17:36)
- Resource samples=55, persisted=true
- List summary_metrics: http_reqs=35134, http_req_failed_rate=0.983 ✅
- Dashboard mapping: found=True, test_run_id=184 clean

### Điểm mới
- **Scale-in hoạt động**: CPU về 0% sau khi k6 workload kết thúc → autoscaler scale 3→2→1. Trước đây chưa từng thấy scale-in vì chỉ test scale-out.
- **Initial cleanup**: Autoscaler phát hiện 3 replicas leftover từ run trước → scale về 1 đúng cách (reason="initial")
- **Tất cả 7 issues đã FIXED**: Không còn issue nào open.

---

## Đã FIXED (giữ lại để tham chiếu)

### 1. [CRITICAL] ✅ autoscaler gọi stack.ps1 → restart nginx
BE đã chuyển `Invoke-ComposeScale` sang `docker compose --scale` trực tiếp. Verify: Run #174, #177, #182, #184 — nginx RestartCount=0.

### 2. [HIGH] ✅ list không trả test_run_id
BE thêm alias `test_run_id = reference_id` trong `/v1/tests`. Verify: `trid=184` xuất hiện trong list.

### 3. [HIGH] ✅ data historical mất sau deploy
Sau deploy round 5, runs #176-#184 vẫn intact với đầy đủ resource samples và summary metrics.

### 4. [MEDIUM] ✅ reuse test_run_id đã finished
Lab script giờ dùng `k6 run -o cloud` → mỗi run tạo reference_id mới, không ghi đè run cũ.

### 5. [LOW] ✅ list trả metrics=null
**Đã fix (verify round 5):** `/v1/tests?limit=N` giờ include `summary_metrics` với `iterations`, `http_reqs`, `checks_rate`, `http_req_failed_rate`. Run #184 xác nhận.

### 6. [LOW] ✅ scale_applied(initial) ghi 1→1
BE đổi sang event `scale_observed` với reason `initial_already_satisfied` khi replicas hiện tại đã đủ. Không còn confused 1→1.

### 7. [CRITICAL] ✅ run-id resolution gom CẢ list reference_id
BE thêm `Get-RunReferenceId` — reject mảng có `count ≠ 1` và chỉ nhận reference_id numeric (`^\d+$`). Verify: Run #184 map sạch.

---

## Issue mới (2026-07-15) — chạy as-03 với data thật

### 8. [HIGH] ⚠️ as-03 scenario tái hiện NGƯỢC bài học nó muốn dạy

**Bài học mong muốn (theo `03_bottleneck-not-solved-by-scale.md`):** scale app 1→3 KHÔNG tăng throughput vì bottleneck nằm ở DB/backend, không phải app.

**Thực tế đo được (A/B sạch, cùng workload `CAPACITY_RATE=8`, `CAPACITY_DB_ROWS=120`, 30s, 240 iterations):**

| Replicas | success | 429 | db_ms |
| --- | --- | --- | --- |
| 1 | 100/240 = **41.7%** | 140 | ~2ms |
| 3 | 240/240 = **100%** | 0 | ~2ms |

→ Scale app 1→3 khiến success **41.7% → 100%** — tức là scale app CỨU được, **ngược hoàn toàn** thông điệp của case.

**Nguyên nhân gốc (đọc code, không đoán):**
- Cái duy nhất bị chạm là **rate limiter per-replica in-memory** trong products-service (`internal/handler/http.go`: `userRateLimiter` = `sync.Mutex` + `map[string]rateLimitWindow`, state nằm TRONG mỗi process, KHÔNG share giữa các replica).
- Default `PRODUCTS_LIST_RATE_LIMIT_PER_MINUTE = 100`, window = 1 phút.
- Script `30-capacity-sizing-sweep.js` gửi `Authorization: Bearer ${RUN_ID}` trên MỌI request → toàn bộ VU gộp về **1 identity bucket duy nhất** (`default:${RUN_ID}`).
- Vì limiter per-replica → ceiling thực = **100/min × số replica**. Scale 1→3 nâng ceiling 100→300/min. DB không bao giờ nghẽn (db_ms giữ ~2ms), nên bottleneck DB mà case muốn dạy **không bao giờ xảy ra**.

**Tại sao đây là issue chứ không phải bài học:** case tên là "bottleneck NOT solved by scale" nhưng data chứng minh scale GIẢI QUYẾT được (vì bottleneck thật là app-level rate limiter, mà limiter lại scale tuyến tính theo replica). Học viên chạy đúng theo doc sẽ thấy kết quả mâu thuẫn với kết luận.

**Ngoài ra — lỗi doc (đã sửa trong RUN_GUIDE.md + 03_*.md):** cả `RUN_GUIDE.md` (bước 2) và `03_bottleneck-not-solved-by-scale.md` scale `order-service`, nhưng profile `products_db_read` route tới **products-service** (`30-capacity-sizing-sweep.js:217`). Scale sai tier → dù muốn demo "scale không giúp" thì cũng đang scale nhầm service.

**Đề xuất fix cho BE (chọn 1):**
1. **Ép DB thật sự thành bottleneck:** tăng `CAPACITY_DB_ROWS` rất cao + nới rate limit (`PRODUCTS_LIST_RATE_LIMIT_PER_MINUTE` lớn) để 429 không phải là cái chạm trước, và giới hạn `MaxConns` (hiện `db/postgres.go:258` = 10) là trần thật. Khi đó scale app 1→3 sẽ KHÔNG tăng throughput vì nghẽn ở pool DB dùng chung.
2. **Đổi identity mỗi VU:** cho script gửi `X-User-Token` khác nhau theo VU → limiter không còn gộp 1 bucket; nhưng vẫn phải xử lý chuyện limiter per-replica nếu muốn dạy "shared bottleneck".
3. **Nếu muốn giữ rate limiter làm bottleneck:** phải chuyển limiter sang **shared store (Redis)** để 3 replica dùng CHUNG 1 counter → lúc đó scale app mới thực sự KHÔNG nâng ceiling, đúng bài học.

Lựa chọn (1) sát ý đồ "DB là bottleneck thật" nhất.

---

### ✅ Verify round 6 — Run harness `run-as03-db-bottleneck.ps1` (2026-07-15)

**BE đã fix theo hướng #1 (biến thể tốt hơn):** thay vì dựa vào `MaxConns=10`, BE thêm **synthetic `pg_advisory_lock` server-side** (`db/postgres.go`: `acquireArtificialLock` gọi ở 4 callsite trên đường DB, khóa cùng 1 key qua env `PRODUCTS_DB_LOCK_HOLD_MS`). Lock nằm TRONG Postgres → mọi connection từ MỌI replica đua chung 1 khóa, chỉ 1 holder tại một thời điểm → trần throughput toàn cục, scale replica không nâng được. Kèm profile `db-bottleneck-practice` nâng rate limit lên 100000/min để 429 không còn là cái chạm trước (che mất bài học DB).

**Kết quả A/B (harness tự chạy + tự gate, `PRODUCTS_DB_LOCK_HOLD_MS=60`, rate 8, db_rows 120, 30s, profile `db-bottleneck-practice`):**

| | Phase A (1 replica) | Phase B (3 replica) |
| --- | --- | --- |
| success | 241/241 (100%) | 240/240 (100%) |
| 429 | 0 | 0 |
| dropped | 0 | 0 |
| **db_p95** | **173ms** | **349ms** |
| throughput gain B/A | — | **−0.34%** (đứng yên) |
| db_p95 ratio B/A | — | 201.7% (latency TỆ HƠN 2×) |

→ Scale app 1→3 KHÔNG tăng throughput (−0.34%), thậm chí latency tệ hơn 2× vì 3 replica đua trên cùng 1 advisory-lock. **Đúng bài học "scale app không cứu backend bottleneck".**

**27/27 gates PASS, `passed=True`.** Không OOM, không restart, không container churn. Cleanup trả stack về sạch (lock=0, replicas=1). Issue #8 **CLOSED**.

**Lưu ý cho học viên:** case này chỉ tái hiện đúng khi chạy qua harness `run-as03-db-bottleneck.ps1` (nó bật `PRODUCTS_DB_LOCK_HOLD_MS` + profile `db-bottleneck-practice`). Chạy `30-capacity-sizing-sweep.js` tay với default (lock=0, profile mặc định) sẽ KHÔNG có bottleneck DB — chỉ đụng rate limiter như cũ.
