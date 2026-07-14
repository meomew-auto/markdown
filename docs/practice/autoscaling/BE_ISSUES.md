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

**Tất cả 7/7 issues đã FIXED.** 🎉

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
