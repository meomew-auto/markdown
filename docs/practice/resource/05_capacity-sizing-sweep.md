# res-05 — Capacity sizing sweep

> **Case ID:** `res-05-capacity-sizing-sweep`
> **Script:** `../app/30-capacity-sizing-sweep.js`
> **Profile:** `full-no-cdn`, constant-arrival-rate, NO token
> **Proof:** Sweep arrival rate với DB load cố định → tìm capacity ceiling. Phát hiện: đây là **rate-limited system**, không phải DB-saturated.

---

## 1. Tình huống thực tế

"Products service chịu được bao nhiêu req/s?" — Bạn tăng dần arrival rate, giữ nguyên DB load, và quan sát khi nào hệ thống bắt đầu từ chối request.

**Điều bất ngờ:** Latency không tăng khi gần ceiling. Server giữ p95 ổn định ~6-9ms ở mọi mức rate, rồi đột ngột trả 429 khi vượt quá ~5 success/s. Đây là **rate-limited pattern** — khác hẳn với resource-saturated pattern (latency tăng dần đến timeout) mà bạn thường thấy.

---

## 2. Sweep strategy — 3 mức dạy học

Cả 3 mức dùng chung `products_db_read` profile, cùng `db_rows=120` cho Medium và Heavy. **Chỉ thay đổi rate.**

| Mức | Rate | DB_ROWS | Duration | preAllocatedVUs | maxVUs | Kết quả thực tế |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| **Light** | 5 | 10 | 20s | 8 | 20 | 100% xanh, p95=9ms, 0 fail |
| **Medium** | 5 | 120 | 20s | 8 | 20 | ~99% xanh, p99=20ms, DB nặng 12x nhưng vẫn xanh |
| **Heavy** | 8 | 120 | 30s | 12 | 40 | ~76% success, ~24% 429 — tìm thấy ceiling |

### Tại sao cấu trúc này:

```
Light (rate=5, db_rows=10):
  "Hệ thống thoải mái" → baseline latency

Medium (rate=5, db_rows=120):
  "DB nặng gấp 12 lần nhưng latency không đổi"
  → Bài học: bottleneck KHÔNG phải DB!

Heavy (rate=8, db_rows=120):
  "Tăng rate → 429 xuất hiện, latency vẫn phẳng"
  → Bài học: ceiling là RATE LIMITER, không phải DB saturation
```

---

## 3. Rate-limited vs Resource-saturated — 2 pattern trái ngược

```
RATE-LIMITED (hệ thống này)            RESOURCE-SATURATED (điển hình)
─────────────────────────────          ──────────────────────────
Latency                                 Latency
  |                                     |
  |  ────────⏤⏤⏤⏤⏤⏤⏤                   |  ──────╱
  |                                     |       ╱
  |  200  200  200  429  429            |     ╱ timeout
  +──────────────────→ rate            +──────────────→ rate
  
  p95 phẳng, 429 đột ngột              p95 tăng dần, timeout từ từ
  Server từ chối, không chậm            Server chậm dần rồi chết
```

**Tại sao phân biệt này quan trọng:** Nếu bạn只看 latency chart, bạn sẽ nghĩ "hệ thống ổn, còn dư capacity" — trong khi thực ra nó đã ở sát ceiling và đang từ chối 24% request. **Phải đọc cả status code (200/429) và latency cùng lúc.**

---

## 4. Dữ liệu thực tế từ sweep

```
Rate=5, db_rows=10  → 100% xanh, p95=9.4ms,  p99=9.9ms   ← Light
Rate=5, db_rows=120 →  99% xanh, p95=7.6ms,  p99=20.4ms  ← Medium  
Rate=6, db_rows=120 →  83% xanh, 17% fail                 ← bắt đầu vượt
Rate=7, db_rows=120 →  71% xanh, 29% fail                 ← vượt rõ
Rate=8, db_rows=120 →  76% xanh, 24% fail, p95=9ms        ← Heavy
```

**Quan sát mấu chốt:**
- `dropped_iterations = 0` ở TẤT CẢ các mức — k6 scheduler không bao giờ là bottleneck
- `p95 latency` của request thành công LUÔN 6-9ms — không tăng
- `capacity_sizing_tolerated_statuses` bắt đầu > 0 từ rate=6 — server trả 429
- Ceiling nằm ở **~5 success/s** — đây là hard limit của rate limiter

**Kết luận:** Muốn tăng throughput, không optimize DB query (vì DB không phải bottleneck). Phải scale service instance hoặc tăng rate limit config.

---

## 5. Key signals cần đọc cùng lúc

| Signal | Rate=5 (green) | Rate=8 (ceiling) | Ý nghĩa |
| --- | ---: | ---: | --- |
| `http_req_failed` | 0% | ~24% | Server từ chối = 429 |
| `http_req_duration p95` | 9ms | 9ms | **Không đổi** → rate-limited |
| `dropped_iterations` | 0 | 0 | Scheduler không drop |
| `capacity_sizing_successes` | 100 | 184/241 | ~5-6 success/s ổn định |
| `capacity_bottleneck_samples` | — | 241 | Bottleneck classifier có evidence |

**Nguyên tắc:** Không bao giờ đọc 1 metric đơn lẻ. "p95 thấp" không có nghĩa là "hệ thống khỏe" nếu 24% request đang bị từ chối.

---

## 6. Cách chạy

### Light (baseline xanh)
```powershell
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "5"; $env:CAPACITY_DB_ROWS = "10"
$env:CAPACITY_DURATION_SECONDS = "20"
$env:CAPACITY_PRE_ALLOCATED_VUS = "8"; $env:CAPACITY_MAX_VUS = "20"
k6 run -o cloud ...30-capacity-sizing-sweep.js
```

### Medium (DB nặng, vẫn xanh)
```powershell
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "5"; $env:CAPACITY_DB_ROWS = "120"
$env:CAPACITY_DURATION_SECONDS = "20"
$env:CAPACITY_PRE_ALLOCATED_VUS = "8"; $env:CAPACITY_MAX_VUS = "20"
k6 run -o cloud ...30-capacity-sizing-sweep.js
```

### Heavy (tìm ceiling)
```powershell
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "8"; $env:CAPACITY_DB_ROWS = "120"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"; $env:CAPACITY_MAX_VUS = "40"
k6 run -o cloud ...30-capacity-sizing-sweep.js
```

---

## 7. Real validation (2026-06-25)

Sweep đã chạy qua 5 mức rate (5/6/7/8) với db_rows=120:

| Run | Rate | DB | Success | Fail% | p95 | Kết luận |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| #136 | 5 | 10 | 100% | 0% | 9ms | Light — baseline xanh |
| #N/A | 5 | 120 | 99% | 1% | 7.6ms | Medium — DB nặng vẫn xanh |
| #N/A | 6 | 120 | 83% | 17% | 6.8ms | Bắt đầu vượt ceiling |
| #N/A | 7 | 120 | 71% | 29% | 7.0ms | Vượt rõ |
| #140 | 8 | 120 | 76% | 24% | 9.0ms | Heavy — ceiling confirmed |

**Pattern nhất quán:** Latency phẳng ~6-9ms ở mọi mức. 429 xuất hiện từ rate=6. Server products có hard rate limit ở ~5 success/s.

**Dashboard chart expectation:**
- Chart latency: đường thẳng ngang ~6-9ms
- Chart status: stacked bar 200 (xanh) + 429 (cam) — tỉ lệ 429 tăng theo rate
- Tab Capacity: resource data cho thấy CPU/RAM không spike → không phải resource saturation

---

## 8. Checklist người học

- [ ] Chạy Light → xác nhận 100% xanh, latency baseline
- [ ] Chạy Medium → DB nặng 12x nhưng latency không đổi → **DB không phải bottleneck**
- [ ] Chạy Heavy → 429 xuất hiện, latency vẫn phẳng → **Rate-limited ceiling**
- [ ] So sánh chart Light vs Heavy: latency giống nhau, status khác nhau
- [ ] Phân biệt được rate-limited (429 đột ngột, latency phẳng) vs resource-saturated (latency tăng dần)
- [ ] Đọc được `dropped_iterations=0` → scheduler không phải vấn đề
- [ ] Đọc được `capacity_sizing_tolerated_statuses` → đếm 429
- [ ] Hiểu: muốn tăng throughput → scale service, không optimize DB

---

## 9. Anti-patterns

- **Chỉ nhìn latency chart:** "p95=9ms → hệ thống còn khỏe" — sai, 24% request đang bị từ chối
- **Tăng VUs để fix 429:** 429 là server từ chối, không phải thiếu VUs. Tăng maxVUs không giúp được gì
- **Kết luận "DB là bottleneck" khi thấy db_rows cao:** DB nặng hơn nhưng latency không đổi → bottleneck nằm ở rate limiter, không phải DB
- **So sánh latency giữa các mức rate để tìm "điểm gãy":** Latency không đổi → không có điểm gãy trên latency chart. Điểm gãy nằm ở status code chart
