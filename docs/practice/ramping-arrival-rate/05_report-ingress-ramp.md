# Case 05: Report Ingress Ramp — Async Job Pattern với Ramping Arrival Rate

> **THE FAILING CASE của series ramping-arrival-rate.** Đây là case dạy học quan trọng nhất — nơi mà checks=100%, http_req_failed=0% nhưng test vẫn FAIL vì `dropped_iterations > 0`. Mọi thứ bạn biết về "pass" từ các case trước sẽ bị thách thức ở đây.

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [2 yêu cầu cốt lõi](#2-2-yêu-cầu-cốt-lõi)
3. [Vì sao chọn ramping-arrival-rate?](#3-vì-sao-chọn-ramping-arrival-rate)
4. [Phân tích nguyên nhân gốc kỹ thuật — 5 Root Causes](#4-phân-tích-nguyên-nhân-gốc-kỹ-thuật--5-root-causes)
5. [Identity model deep-dive — Job ID tracking](#5-identity-model-deep-dive--job-id-tracking)
6. [Phân tích open model với async ramp](#6-phân-tích-open-model-với-async-ramp)
7. [Bảng service/API flow](#7-bảng-serviceapi-flow)
8. [Metrics & tags deep-dive](#8-metrics--tags-deep-dive)
9. [Pass criteria](#9-pass-criteria)
10. [Cách chạy](#10-cách-chạy)
11. [Phân tích output 5 bước](#11-phân-tích-output-5-bước)
12. [Dashboard 3-chart deep analysis](#12-dashboard-3-chart-deep-analysis)
13. [4 output→decision scenarios](#13-4-outputdecision-scenarios)
14. ["Nghịch lý" — 4 Paradoxes](#14-nghịch-lý--4-paradoxes)
15. [Checklist — Async-specific checks](#15-checklist--async-specific-checks)
16. [4–5 Variations](#16-45-variations)
17. [Anti-patterns (mở rộng)](#17-anti-patterns-mở-rộng)
18. [Reference](#18-reference)

---

## 1. Tình huống thực tế

### 1.1 Business context: Report dashboard buổi sáng đầu giờ

Hãy hình dung một buổi sáng thứ Hai tại một công ty fintech. 8:00 AM, nhân viên bắt đầu vào làm. Việc đầu tiên họ làm: mở dashboard báo cáo để xem số liệu cuối tuần. Nhưng dashboard không chỉ hiển thị dữ liệu tĩnh — nó còn cho phép tạo các "report job" bất đồng bộ (async) để tổng hợp dữ liệu phức tạp.

Traffic pattern điển hình trong 35 giây đầu giờ:

```
Phase 1 (0s–10s): Nhân viên bắt đầu login, mở dashboard.
                   Traffic tăng từ 2 req/s lên 6 req/s.
                   Chủ yếu là GET dashboard reads.

Phase 2 (10s–25s): Cao điểm. Nhiều người đã vào, bắt đầu tạo report jobs.
                    Traffic tăng từ 6 req/s lên 14 req/s (peak).
                    Mix: ~70% dashboard reads + ~30% async job creates.

Phase 3 (25s–35s): Giờ họp hành, traffic giảm dần.
                    Traffic giảm từ 14 req/s xuống 4 req/s.
                    Còn lại chủ yếu là async job polling (GET status).
```

Tổng cộng: khoảng 280 request được schedule trong 35 giây, với peak rate 14 req/s.

### 1.2 Điểm đặc biệt: Async job pattern

Đây KHÔNG phải là traffic "thuần HTTP" mà bạn thấy trong case 01–04. 30% request là async job với flow:

```
Client (VU) → POST /api/sim/report/jobs     (tạo job, nhận 202 + job ID)
            → WAIT ~140ms                    (job đang được xử lý — VU BỊ GIỮ LẠI)
            → GET  /api/sim/report/jobs/:id  (poll status, nhận 200 + kết quả)
```

Điểm mấu chốt: **VU bị giữ lại trong suốt thời gian wait**, không chỉ trong thời gian HTTP request/response. Một VU đang wait 140ms là một VU không thể phục vụ iteration khác. Đây là bản chất của "open model bị bottleneck bởi VU pool" — chủ đề trung tâm của case này.

### 1.3 So sánh nhanh với các case khác trong series

| Case | Pattern | Peak rate | Async wait? | VU yêu cầu | Kết quả điển hình |
|------|---------|-----------|-------------|-----------|-------------------|
| 01 | Simple HTTP GET | 28/s | Không | ~1 | PASS (0 drops) |
| 02 | Mixed GET/POST | 24/s | Không | ~2 | PASS (0 drops) |
| 03 | Heavy payload | 20/s | Không | ~3 | PASS (0 drops) |
| 04 | Multi-step checkout | 16/s | Không | ~5 | PASS (0 drops) |
| **05** | **Async job** | **14/s** | **Có (~140ms)** | **Cần >> lý thuyết** | **FAIL (drops > 0)** |

Chú ý: case 05 có peak rate **thấp nhất** (14/s) nhưng lại là case **khó pass nhất**. Đây là nghịch lý đầu tiên bạn sẽ gặp.

---

## 2. 2 yêu cầu cốt lõi

### Yêu cầu 1: Sustain report ramp — Duy trì được traffic ramp với async pattern

Hệ thống phải xử lý được toàn bộ 280 iteration được schedule trong 35 giây, với pattern ramp-up → peak → ramp-down, trong đó 30% request là async job (có wait 140ms). Tất cả các iteration phải được thực thi — không iteration nào bị drop.

**Tại sao khó:** Async job giữ VU lâu hơn HTTP response time. Nếu HTTP response của POST là 5ms và GET status là 5ms, bạn có thể nghĩ mỗi async job chỉ tốn 10ms. Nhưng thực tế, VU bị giữ trong suốt 140ms wait giữa POST và GET. Điều này có nghĩa mỗi async job tiêu tốn VU-time gấp ~14 lần so với một dashboard read (10ms vs 140ms + 10ms = 150ms).

### Yêu cầu 2: Zero drops bất chấp async wait

`dropped_iterations` phải bằng 0. Đây là tiêu chí pass DUY NHẤT của open model. Checks có thể 100%, http_req_failed có thể 0% — nhưng nếu `dropped_iterations > 0`, test FAIL.

**Tại sao khó hơn nữa:** Với preAllocatedVUs=15 và maxVUs=45, bạn có thể nghĩ pool đủ lớn. Nhưng hãy tính toán:

- Tại peak 14/s: 30% × 14 = 4.2 async jobs/s
- Mỗi async job giữ VU ~150ms (10ms HTTP + 140ms wait)
- Dashboard reads: 70% × 14 = 9.8/s, mỗi cái ~5ms
- Weighted average event duration: 0.7 × 5ms + 0.3 × 150ms = 3.5ms + 45ms = 48.5ms
- VU cần theo lý thuyết: ceil(14 × 0.0485) = ceil(0.679) = 1 VU

**Nhưng thực tế:** Với arrival rate 14/s, một slot mới xuất hiện mỗi ~71ms. Một async job chiếm VU trong 150ms, tức là trong thời gian đó có ~2 slot khác đến. Nếu các slot đó đều là async job, bạn cần 3 VU concurrent để xử lý. Và đây mới chỉ là tính trung bình — thực tế, phân phối đến có thể clustered, và tail latency của async job có thể vượt xa 140ms.

**Kết luận sớm:** Lý thuyết Little's Law (L = λW) với W trung bình không áp dụng tốt khi W có bimodal distribution (5ms vs 150ms) và arrival là ngẫu nhiên. Bạn cần phân tích sâu hơn — và đó chính là nội dung của section 4.

---

## 3. Vì sao chọn ramping-arrival-rate?

### 3.1 So sánh các executor cho scenario này

| Executor | Phù hợp? | Lý do |
|----------|----------|-------|
| `constant-vus` | Không | Không mô hình được arrival rate độc lập. VUs cố định, arrival rate phụ thuộc vào event duration. Nếu async job chậm, arrival rate tự động giảm — không phản ánh thực tế user đến. |
| `ramping-vus` | Không | Vẫn là closed model. Số VU tăng nhưng arrival rate không được kiểm soát trực tiếp. Không test được việc hệ thống có đáp ứng kịp arrival rate target không. |
| `shared-iterations` | Không | Không có khái niệm arrival rate. Chia đều iteration cho VU, không có ramp pattern. |
| `per-vu-iterations` | Không | Mỗi VU chạy N iterations độc lập. Không có arrival rate control, không có ramp. |
| `constant-arrival-rate` | Một phần | Giữ arrival rate không đổi. Tốt cho steady-state test, nhưng không mô hình được ramp-up/ramp-down của traffic thực tế. |
| **`ramping-arrival-rate`** | **CÓ** | **Cho phép định nghĩa arrival rate theo thời gian (ramp). Mô phỏng chính xác traffic tăng dần → peak → giảm dần. Open model: iteration đến độc lập với VU đang bận.** |

### 3.2 Tại sao open model quan trọng cho case này?

Trong thực tế, user không "chờ" VU rảnh rồi mới gửi request. Họ đến theo lịch trình của riêng họ (giờ làm việc, thói quen). Nếu hệ thống chậm, user vẫn đến — và queue sẽ build up.

`ramping-arrival-rate` mô phỏng chính xác điều này:
- Mỗi giây, k6 schedule đúng N iteration mới (theo target rate của stage hiện tại)
- Nếu không có VU rảnh để nhận iteration, iteration đó bị DROP
- `dropped_iterations` là tín hiệu cho thấy hệ thống không theo kịp arrival rate

Đây chính là lý do case này fail: arrival rate tiếp tục được schedule theo kế hoạch, nhưng VU pool không đủ để xử lý vì async job giữ VU quá lâu.

### 3.3 Nếu dùng constant-arrival-rate thì sao?

Nếu bạn set constant-arrival-rate với rate=14/s và chạy trong 35s, bạn sẽ thấy pattern tương tự nhưng thiếu ramp context. Bạn sẽ không biết được liệu hệ thống có thể "bắt kịp" sau khi ramp up không, hay drops xảy ra ngay từ đầu. Ramp pattern cho phép bạn quan sát:

- Thời điểm drops bắt đầu xuất hiện (ở stage nào? rate bao nhiêu?)
- Drops có giảm khi ramp down không?
- VU pool có phục hồi được sau peak không?

Đây là những insight mà constant-arrival-rate không cung cấp.

---

## 4. Phân tích nguyên nhân gốc kỹ thuật — 5 Root Causes

### 4.1 RC1: Async wait giữ VU vượt ra ngoài HTTP response time

#### Cơ chế

Trong HTTP test thông thường, event_duration ≈ http_req_duration. VU bận trong khoảng thời gian request bay đi và response bay về. Khi response về, VU được giải phóng ngay lập tức.

Nhưng trong case này, async job flow có thêm bước **wait**:

```javascript
// Pseudocode của async branch
const createRes = http.post('/api/sim/report/jobs', payload);  // ~5ms
const jobId = createRes.json().id;
sleep(READY_AFTER_MS / 1000);                                   // ~140ms ← VU BỊ GIỮ Ở ĐÂY
const statusRes = http.get(`/api/sim/report/jobs/${jobId}`);    // ~5ms
```

`event_duration` cho async branch ≈ 5ms (POST) + 140ms (sleep) + 5ms (GET) = **150ms**.

Trong khi `http_req_duration` trung bình cho async branch ≈ (5ms + 5ms) / 2 = **5ms** (hai HTTP calls).

**Đây là mismatch quan trọng:** system metrics (http_req_duration) nói "mọi thứ nhanh", nhưng VU pool metrics nói "VU bận lâu". Bạn không thể dùng http_req_duration để estimate VU requirement cho async scenario.

#### Hệ quả với VU pool

Mỗi async job tiêu thụ VU-time gấp 30 lần so với http_req_duration gợi ý (150ms vs 5ms). Nếu bạn allocation VU dựa trên http_req_duration, bạn sẽ thiếu VU trầm trọng.

#### Công thức W_effective

```
W_effective = Σ (weight_i × event_duration_i)

Với case này:
W_effective = 0.7 × 5ms + 0.3 × 150ms = 3.5ms + 45ms = 48.5ms
```

So sánh: nếu chỉ nhìn http_req_duration, bạn sẽ tính W_effective ≈ 0.7×5ms + 0.3×5ms = 5ms — thấp hơn 10 lần.

#### Insight

**RC1 dạy bạn rằng:** Trong async scenario, YOU phải tự tính event_duration (bao gồm sleep/wait), không phải chỉ nhìn http_req_duration. K6 báo cáo http_req_duration cho HTTP calls, nhưng event_duration (bao gồm sleep) mới là thứ quyết định VU utilization.

---

### 4.2 RC2: Bimodal event duration — Dashboard nhanh, async_job chậm

#### Phân phối event duration

Case này có hai "chế độ" event duration rất khác nhau:

| Branch | Weight | HTTP calls | Sleep | Event duration | http_req_duration (per call) |
|--------|--------|-----------|-------|---------------|------------------------------|
| dashboard | 70% | 1 (GET) | 0ms | ~5ms | ~5ms |
| async_job | 30% | 2 (POST + GET) | ~140ms | ~150ms | ~5ms |

Đây là **bimodal distribution** rõ rệt: một mode ở ~5ms, một mode ở ~150ms. Tỷ lệ 70:30.

#### Tại sao bimodal gây vấn đề?

1. **Mean không đại diện:** Mean = 48.5ms, nhưng KHÔNG CÓ iteration nào thực sự kéo dài 48.5ms. Tất cả đều hoặc ~5ms hoặc ~150ms.

2. **Arrival randomness:** Tại peak 14/s, mỗi slot cách nhau ~71ms. Nếu 2 slot liên tiếp đều là async job (xác suất 0.3×0.3 = 9%), bạn cần 2 VU concurrent, mỗi VU bận 150ms. Nếu 3 slot liên tiếp đều async (xác suất 2.7%), bạn cần 3 VU.

3. **Queueing effect:** Khi một async job đang chạy (150ms), các dashboard event đến trong thời gian đó (~71ms/slot, ~2 slot) có thể được xử lý nhanh (5ms mỗi cái) bởi VU khác. Nhưng nếu không đủ VU, dashboard event cũng bị drop.

4. **Tail behavior:** Thời gian wait 140ms có thể có variance. Nếu đôi khi wait lâu hơn (ví dụ 200ms, 300ms), hiệu ứng còn tệ hơn.

#### Tính toán xác suất

Với arrival rate λ = 14/s, trong 150ms (thời gian một async job), có trung bình 14 × 0.15 = 2.1 slot đến. Phân phối số async jobs trong 2.1 slot:

```
P(0 async trong 2.1 slot) = (0.7)^2.1 ≈ 47%
P(1 async trong 2.1 slot) ≈ 40%
P(2 async trong 2.1 slot) ≈ 11%
P(≥3 async trong 2.1 slot) ≈ 2%
```

Trong trường hợp có 1 async job đang chạy và 2 slot mới đến, nếu cả 2 slot mới đều là async (xác suất ~9%), bạn cần 3 VU concurrent. Với preAllocatedVUs=15, điều này nghe có vẻ an toàn. Nhưng...

#### Vấn đề thực sự: Clustering ở scale

Với λ = 14/s trong 35s, có tổng cộng 280 iteration. Trong đó ~84 là async. Nếu async jobs cluster (đến gần nhau), một "đợt" 5-6 async job liên tiếp có thể xảy ra. Xác suất thấp nhưng với 84 async jobs, khả năng xảy ra ít nhất một cluster là đáng kể.

Khi cluster xảy ra: 6 async job concurrent × 150ms = cần 6 VU. Nếu lúc đó đã có vài VU đang bận với dashboard reads, VU pool có thể bị cạn kiệt → drops.

---

### 4.3 RC3: VU pool exhaustion tại peak → dropped_iterations bất chấp HTTP sạch

#### Cơ chế exhaustion

Đây là cơ chế trung tâm của case này:

```
1. Arrival rate scheduler: "Đã đến giờ schedule iteration mới. Còn slot không?"
   → Có slot (đang trong stage, còn iteration được phân bổ)
   → Schedule iteration mới

2. VU pool: "Có VU rảnh để nhận iteration này không?"
   → Nếu CÓ: VU nhận iteration, bắt đầu thực thi → OK
   → Nếu KHÔNG: iteration bị DROP → dropped_iterations++

3. HTTP layer vẫn báo cáo: checks=100%, http_req_failed=0%
   → Tại sao? Vì những iteration ĐÃ ĐƯỢC thực thi thì HTTP vẫn OK.
   → Nhưng những iteration BỊ DROP chưa từng gửi HTTP request nào.
   → HTTP metrics không biết về dropped iterations.
```

#### Timeline exhaustion điển hình

```
Time 12s: Stage 2 bắt đầu. Rate tăng từ 6 → 14/s.
Time 13s: Rate ~8/s. VU pool (15 preAllocated) vẫn OK.
Time 15s: Rate ~10/s. Một vài async job bắt đầu cluster.
           VU utilization bắt đầu tăng. Vẫn chưa drop.
Time 18s: Rate ~13/s (gần peak). Async jobs cluster.
          preAllocated VUs (15) đã dùng hết.
          k6 bắt đầu allocate thêm VU (từ pool lên đến maxVUs=45).
Time 20s: Rate = 14/s (peak). Dù đã allocate đến 20-25 VU,
          async jobs vẫn giữ VU quá lâu.
          Một iteration mới đến, không có VU rảnh → DROP.
Time 22s: Vẫn ở peak. Drops tiếp tục tích lũy.
          Có thể 30-35 VU đã được allocate, nhưng vẫn không đủ.
Time 25s: Stage 3 bắt đầu. Rate giảm từ 14 → 4/s.
          VU pool dần phục hồi. Drops giảm.
Time 30s: Rate ~6/s. VU pool đã ổn định trở lại.
          Không còn drops.
```

#### Tại sao maxVUs=45 vẫn không đủ?

Với W_effective = 48.5ms, lý thuyết nói cần ceil(14 × 0.0485) = 1 VU. Nhưng lý thuyết dùng mean, không tính đến bimodal distribution và arrival clustering.

Thực tế, với bimodal (5ms vs 150ms), số VU cần thiết để không drop PHỤ THUỘC VÀO THỨ TỰ ARRIVAL. Trong worst case (tất cả slot đều là async job), bạn cần:

```
VU_worst_case = arrival_rate × max_event_duration
              = 14/s × 0.150s
              = 2.1 VU
```

Nhưng đây mới là concurrent VU đang chạy. Để không bao giờ drop, bạn cần VU pool > concurrent VU peak, và concurrent VU peak có thể vượt mean đáng kể do clustering.

Với 45 VU max, bạn có margin lớn so với 2.1 VU mean. Nhưng nếu async wait thực tế dài hơn 140ms (ví dụ do server queue, hoặc variance), hoặc nếu arrival clustering tệ hơn dự kiến, 45 VU vẫn có thể không đủ.

**Đây chính là bài học:** Trong async scenario, VU requirement không được quyết định bởi mean, mà bởi tail behavior của cả arrival process và event duration.

---

### 4.4 RC4: Tăng VU pool giúp nhưng có thể không giải quyết triệt để (tail latency)

#### Hiệu ứng của việc tăng VU pool

Giả sử bạn tăng maxVUs từ 45 lên 100:

```
Trước (maxVUs=45):
- VU pool có thể đạt 45 concurrent
- Tại peak: nếu 45 VU đều bận → drop ngay
- Drops bắt đầu khi concurrent VU chạm 45

Sau (maxVUs=100):
- VU pool có thể đạt 100 concurrent
- Tại peak: cần >100 VU bận đồng thời mới drop
- Xác suất drops giảm đáng kể
```

**Nhưng:** Tăng maxVUs không giải quyết được gốc rễ vấn đề. Vấn đề gốc rễ là **event duration quá dài** (do async wait). Nếu bạn có thể giảm event duration, bạn sẽ cần ít VU hơn.

#### Tại sao vẫn có thể drop dù VU pool lớn?

1. **Tail latency của async wait:** READY_AFTER_MS=140ms là mean. Nếu có variance (một số job mất 500ms, 1000ms), những job "đuôi dài" này giữ VU rất lâu, làm tăng concurrent VU requirement.

2. **VU allocation overhead:** Khi k6 cần allocate VU mới (từ preAllocated lên max), có overhead. Nếu arrival rate tăng nhanh hơn tốc độ allocate VU, drops có thể xảy ra trong giai đoạn chuyển tiếp.

3. **Stage transition:** Khi chuyển từ stage 1 sang stage 2 (rate 6→14/s), VU pool cần scale up nhanh. Nếu không kịp, drops ở đầu stage 2.

4. **Không có giới hạn trên nào là an toàn tuyệt đối:** Về lý thuyết, nếu tất cả 280 iteration đến cùng lúc và đều là async job, bạn cần 280 VU. Điều này không thực tế, nhưng minh họa rằng không có maxVUs nào đảm bảo 0 drops cho mọi arrival pattern.

#### Insight

**RC4 dạy bạn rằng:** Tăng VU pool là giải pháp "chữa cháy", không phải giải pháp gốc rễ. Giải pháp gốc rễ là:
- Giảm async wait time (tối ưu job processing)
- Hoặc thay đổi architecture (ví dụ: tách request tạo job và poll status thành hai scenario riêng)
- Hoặc dùng `maxDuration` để cắt đuôi — nếu một iteration chạy quá lâu, force stop nó

---

### 4.5 RC5: dropped_iterations là THE primary failure signal — không phải checks hay http_req_failed

#### Tại sao checks và http_req_failed không đủ?

Trong closed model (constant-vus, ramping-vus):
- Nếu hệ thống chậm → VU bận lâu hơn → arrival rate tự động giảm
- Checks vẫn pass (request gửi đi nhận về OK)
- http_req_failed = 0% (không có request nào fail)
- **Kết luận sai:** "Hệ thống OK, chỉ hơi chậm"

Trong open model (ramping-arrival-rate):
- Nếu hệ thống chậm → VU bận lâu hơn → arrival rate KHÔNG đổi
- Iteration mới vẫn được schedule đúng lịch
- Nếu không có VU rảnh → DROP
- Checks vẫn pass trên những iteration được thực thi
- http_req_failed = 0% trên những request được gửi
- Nhưng dropped_iterations > 0
- **Kết luận đúng:** "Hệ thống không theo kịp arrival rate → test FAIL"

#### Bảng so sánh các failure signals

| Signal | Case 01–04 (HTTP) | Case 05 (Async) | Độ tin cậy |
|--------|-------------------|-----------------|-----------|
| `checks` | Hữu ích (nếu response sai) | Vẫn hữu ích | Trung bình — chỉ bắt được logic error, không bắt được capacity error |
| `http_req_failed` | Hữu ích (nếu server trả 5xx) | Vẫn hữu ích | Trung bình — chỉ bắt được HTTP-level error |
| `http_req_duration` | Hữu ích (nếu response chậm) | **Gây hiểu nhầm** — không phản ánh event duration | Thấp cho async |
| `dropped_iterations` | Có thể > 0 nếu thiếu VU | **THE signal** | **CAO NHẤT** cho open model |
| `iterations` completed vs total | Hữu ích | Hữu ích | Cao |
| `vus_max` reached? | Hữu ích | Hữu ích — cho biết pool có bị đẩy lên max không | Cao |

#### Cách đọc dropped_iterations đúng

```
dropped_iterations == 0  → PASS (hệ thống theo kịp arrival rate)
dropped_iterations > 0   → FAIL (hệ thống không theo kịp)
                            → Không quan trọng checks hay http_req_failed thế nào
                            → Cần investigation: tại sao VU pool không đủ?
```

#### Insight tổng kết

**RC5 là bài học quan trọng nhất của case 05 và toàn bộ series ramping-arrival-rate:** Trong open model, tiêu chí pass/fail KHÔNG nằm ở HTTP metrics. Nó nằm ở khả năng của VU pool đáp ứng được arrival rate schedule. `dropped_iterations` là tín hiệu trực tiếp nhất cho biết capacity mismatch. Checks=100% + http_req_failed=0% + dropped_iterations>0 = FAIL. Không có ngoại lệ.

---

### 4.6 RC6: `gracefulStop` và `maxDuration` tương tác với drops

#### Một lớp failure khác: iteration bị kill giữa chừng

Ngoài dropped_iterations (iteration không bao giờ bắt đầu), còn có một failure mode khác: iteration bắt đầu nhưng bị kill giữa chừng do timeout. Điều này xảy ra khi:

```
iteration_duration > maxDuration (nếu được set)
→ iteration bị force stop
→ iteration đó KHÔNG được tính là completed
→ iteration đó KHÔNG được tính là dropped (vì nó đã bắt đầu)
→ iteration đó... biến mất khỏi cả hai metrics
```

Đây là "lỗ hổng metrics" tiềm ẩn. Nếu bạn chỉ check `dropped_iterations` và `iterations.completed`, bạn có thể bỏ qua iteration bị kill giữa chừng.

#### Cách phát hiện

```
total_scheduled = area dưới đường cong rate
total_accounted = iterations.completed + dropped_iterations

Nếu total_accounted < total_scheduled:
→ Có iteration "mất tích" → có thể bị kill bởi maxDuration
→ Kiểm tra: có log "iteration interrupted" hoặc "graceful stop" không?
```

#### Tương tác với async case

Với case 05, nếu bạn set `maxDuration: '200ms'`:

```
- Dashboard iterations (5ms): luôn hoàn thành
- Async iterations (150ms): thường hoàn thành
- Nhưng async iterations có tail latency → một số > 200ms → BỊ KILL
- Kết quả: một số async job không hoàn thành, nhưng cũng không được tính là dropped
```

#### Khuyến nghị

- Nếu set `maxDuration`, phải set cao hơn p99 của iteration_duration một margin an toàn (ví dụ: p99=160ms → maxDuration=300ms)
- Luôn reconcile: `iterations.completed + dropped_iterations ≈ total_scheduled`
- Nếu có gap, investigate maxDuration kills
- Trong CI/CD, check cả `iterations.completed + dropped_iterations` chứ không chỉ `dropped_iterations`

#### Insight

**RC6 dạy bạn rằng:** dropped_iterations không phải là cách duy nhất để iteration thất bại. `maxDuration` và `gracefulStop` có thể kill iteration giữa chừng, và những iteration này không xuất hiện trong dropped_iterations. Luôn cross-check tổng số iteration.

---

## 5. Identity model deep-dive — Job ID tracking

### 5.1 Tại sao cần identity model?

Async job flow tạo ra một bài toán identity: làm sao biết GET status request nào tương ứng với POST create job nào? Nếu không track được identity, bạn không thể:
- Verify rằng GET trả về đúng job vừa tạo
- Đo lường end-to-end latency của async flow (từ POST đến khi job ready)
- Debug khi có failure: POST thành công nhưng GET thất bại — đó là vấn đề gì?

### 5.2 Cơ chế identity tracking

```javascript
// Pattern: extract identity từ response, dùng làm parameter cho request tiếp theo

// Step 1: Tạo job, extract job ID
const createRes = http.post('/api/sim/report/jobs', payload, {
  tags: { branch: 'async_job', step: 'create' }
});
const jobId = createRes.json().id;  // ← ĐÂY LÀ IDENTITY
console.log(`[VU ${__VU}] Created job ${jobId}`);

// Step 2: Wait cho job sẵn sàng
sleep(READY_AFTER_MS / 1000);

// Step 3: Poll status với job ID
const statusRes = http.get(`/api/sim/report/jobs/${jobId}`, {
  tags: { branch: 'async_job', step: 'status', job_id: jobId }
});
// Verify: statusRes.json().status === 'ready'
```

`jobId` là identity xâu chuỗi POST và GET. Nó được extract từ POST response và inject vào GET URL.

### 5.3 Impact của identity model lên metrics

Khi bạn tag request với `job_id`, bạn có thể:
- Group metrics theo `job_id` để trace end-to-end latency của từng job
- So sánh số lượng POST (tạo job) và GET (poll status) — chúng phải khớp
- Phát hiện "orphan GET" (GET cho job không tồn tại) hoặc "abandoned POST" (POST thành công nhưng không GET)

### 5.4 Identity model và weighted branches

Case này có weighted branching:

```javascript
// Pseudocode
const branch = Math.random() < 0.7 ? 'dashboard' : 'async_job';

if (branch === 'dashboard') {
  // 1 HTTP call, không có identity tracking
  http.get('/api/sim/report');
} else {
  // 2 HTTP calls, có identity tracking (job ID)
  const createRes = http.post('/api/sim/report/jobs', ...);
  const jobId = createRes.json().id;
  sleep(READY_AFTER_MS / 1000);
  http.get(`/api/sim/report/jobs/${jobId}`, ...);
}
```

Điều này có nghĩa:
- Dashboard branch: 1 HTTP call/iteration
- Async_job branch: 2 HTTP calls/iteration
- Tỷ lệ iteration: 70% dashboard, 30% async_job
- Tỷ lệ HTTP calls: 70/(70+60) ≈ 54% dashboard, 46% async_job

**Quan trọng:** Tỷ lệ HTTP calls KHÔNG giống tỷ lệ iterations. Đây là điểm dễ gây nhầm lẫn khi đọc metrics (sẽ phân tích sâu ở section 8).

### 5.5 Job lifecycle state machine

```
                    ┌─────────┐
                    │  IDLE   │
                    └────┬────┘
                         │ POST /api/sim/report/jobs
                         ▼
                    ┌─────────┐
                    │ PENDING │ (job được tạo, đang xử lý)
                    └────┬────┘
                         │ Wait READY_AFTER_MS
                         ▼
                    ┌─────────┐
                    │  READY  │ (GET /api/sim/report/jobs/:id → status: "ready")
                    └─────────┘
```

State machine này giúp bạn hiểu async flow không phải là một HTTP transaction đơn lẻ, mà là một chuỗi các bước với wait time ở giữa. Mỗi state transition là một cơ hội cho failure — và mỗi state giữ VU trong suốt thời gian tồn tại của nó.

---

## 6. Phân tích open model với async ramp

### 6.1 Step-by-step qua peak stage

Hãy walk through stage 2 (10s–25s, rate 6→14/s) một cách chi tiết:

```
Second 10: Rate = 6/s. Schedule 6 iterations.
           ~4 dashboard, ~2 async_job.
           Dashboard VU-time: 4 × 5ms = 20ms
           Async VU-time: 2 × 150ms = 300ms
           Total VU-time cần: 320ms → cần ~1 VU concurrent (nếu perfectly interleaved)
           VU pool (15 preAllocated): dư dả.

Second 12: Rate = ~8/s. Schedule 8 iterations.
           ~5-6 dashboard, ~2-3 async_job.
           Dashboard: 6 × 5ms = 30ms
           Async: 3 × 150ms = 450ms
           Total: 480ms → cần ~1 VU
           Vẫn OK.

Second 15: Rate = ~10/s. Schedule 10 iterations.
           ~7 dashboard, ~3 async_job.
           Dashboard: 7 × 5ms = 35ms
           Async: 3 × 150ms = 450ms
           Total: 485ms → cần ~1-2 VU nếu interleaved tốt
           VU pool: OK, nhưng bắt đầu thấy VU count tăng nhẹ.

Second 18: Rate = ~12/s. Schedule 12 iterations.
           ~8 dashboard, ~4 async_job.
           Dashboard: 8 × 5ms = 40ms
           Async: 4 × 150ms = 600ms
           Total: 640ms
           Nếu 4 async đến gần nhau: cần 4 VU concurrent cho async
           + 1-2 VU cho dashboard → 5-6 VU concurrent
           VU pool: vẫn trong preAllocated (15).

Second 20: Rate = 14/s (PEAK). Schedule 14 iterations.
           ~10 dashboard, ~4 async_job.
           Dashboard: 10 × 5ms = 50ms
           Async: 4 × 150ms = 600ms
           Total: 650ms
           Nếu 4 async cluster: cần 4 VU cho async
           Nhưng trong 150ms async chạy, có ~2 slot mới đến
           Nếu 2 slot mới cũng async → thêm 2 VU → 6 VU concurrent
           + dashboard events → 7-8 VU concurrent
           VU pool: 15 preAllocated. Dư dả về lý thuyết.

           *** VẬY TẠI SAO LẠI DROP? ***

           Lý do: không phải mọi thứ đều hoàn hảo như tính toán.
           - Arrival clustering: có thể 4 async job đến CÙNG LÚC
             (trong cùng 1 giây, scheduler có thể schedule chúng gần nhau)
           - Thời gian wait thực tế có thể > 140ms (server variance)
           - Khi 4 async chạy concurrent, mỗi cái gửi 2 HTTP requests
             → 8 concurrent HTTP requests → server queue → response chậm hơn
           - VU allocation overhead: thời gian để k6 spin up VU mới
```

### 6.2 Mô phỏng worst-case cluster

Giả sử tại second 20, scheduler schedule 14 iterations với pattern:

```
Slot  1: dashboard   (5ms)    → VU 1
Slot  2: async_job   (150ms)  → VU 2
Slot  3: dashboard   (5ms)    → VU 1 (reused)
Slot  4: async_job   (150ms)  → VU 3  ← VU 2 vẫn bận
Slot  5: async_job   (150ms)  → VU 4  ← VU 2,3 vẫn bận
Slot  6: dashboard   (5ms)    → VU 1 (reused)
Slot  7: async_job   (150ms)  → VU 5  ← VU 2,3,4 vẫn bận
Slot  8: dashboard   (5ms)    → VU 1 (reused)
Slot  9: dashboard   (5ms)    → VU 1 (reused)
Slot 10: async_job   (150ms)  → VU 6  ← VU 2,3,4,5 vẫn bận
Slot 11: dashboard   (5ms)    → VU 1 (reused)
Slot 12: async_job   (150ms)  → VU 7  ← VU 2,3,4,5,6 vẫn bận
Slot 13: dashboard   (5ms)    → VU 1 (reused)
Slot 14: async_job   (150ms)  → VU 8  ← VU 2,3,4,5,6,7 vẫn bận
```

Trong scenario này (7 async jobs trong 14 slots, hơi cao hơn expected 4.2), có thời điểm 7 VU concurrent đang chạy async jobs. Nếu mỗi VU cũng đang phục vụ dashboard (VU 1 tái sử dụng nhiều lần), tổng VU concurrent có thể là 8.

Với preAllocatedVUs=15, vẫn OK. Nhưng nếu pattern này lặp lại trong vài giây liên tiếp, và VU allocation không theo kịp, drops có thể xảy ra.

### 6.3 Tính toán VU requirement với công thức mở rộng

Công thức cơ bản: `VU_required = λ × W_effective`

Nhưng với bimodal distribution, cần tính thêm buffer cho clustering:

```
λ_async = λ × 0.3 = 14 × 0.3 = 4.2 async/s
λ_dashboard = λ × 0.7 = 14 × 0.7 = 9.8 dashboard/s

VU_async_mean = λ_async × W_async = 4.2 × 0.150 = 0.63 VU
VU_dashboard_mean = λ_dashboard × W_dashboard = 9.8 × 0.005 = 0.049 VU

VU_total_mean = 0.63 + 0.049 = 0.679 VU (≈1 VU)
```

Nhưng đây là mean. Trong thực tế, do arrival ngẫu nhiên, số async job concurrent tại một thời điểm có thể cao hơn mean. Dùng công thức queueing M/G/c hoặc ước lượng với buffer:

```
VU_async_peak ≈ λ_async × W_async + z × sqrt(λ_async × W_async)
              = 0.63 + 2 × sqrt(0.63)    (z=2 cho ~95th percentile)
              = 0.63 + 2 × 0.79
              = 0.63 + 1.58
              = 2.21 VU

VU_total_peak ≈ 2.21 + 0.05 = 2.26 VU
```

Với preAllocated=15, lý thuyết nói dư dả. Nhưng thực tế drops vẫn xảy ra → có yếu tố khác.

### 6.5 VU recovery dynamics — điều gì xảy ra SAU peak?

Một khía cạnh thường bị bỏ qua: VU pool phục hồi như thế nào sau khi peak qua đi. Trong case này, stage 3 giảm rate từ 14/s xuống 4/s. Về lý thuyết, VU requirement cũng phải giảm. Nhưng thực tế phức tạp hơn:

```
Second 25: Rate bắt đầu giảm từ 14/s.
           VU count vẫn ở ~40-45 (async jobs đang chạy vẫn giữ VU).

Second 27: Rate ~10/s. 
           Các async job khởi tạo trước đó (~second 23-25) vẫn đang chạy.
           Mỗi async job giữ VU 150ms → VU vẫn bận đến ~second 25.3.
           VU count vẫn cao: 30-35.

Second 30: Rate ~6/s.
           Hầu hết async job cũ đã hoàn thành.
           VU count giảm mạnh: 10-15.
           Drops đã dừng hẳn.

Second 35: Rate = 4/s (cuối stage 3).
           VU count ~5-8.
           Pool đã phục hồi hoàn toàn.
```

**Insight:** Có một "VU tail" — VU count vẫn cao một thời gian sau khi rate đã giảm. Điều này là do async jobs khởi tạo ở peak vẫn đang chạy. Thời gian tail ≈ max_iteration_duration (150ms). Trong thực tế, tail này có thể dài hơn vì k6 không ngay lập tức release VU sau khi iteration hoàn thành (có grace period).

**Hệ quả cho capacity planning:** Nếu peak kéo dài hơn (ví dụ 60s thay vì 15s), "VU tail" sẽ tích lũy và VU count có thể tiếp tục tăng ngay cả khi rate ổn định. Điều này giải thích tại sao steady-state async test có thể có VU count cao hơn nhiều so với dự đoán của Little's Law.

### 6.6 Ma trận rủi ro: khi nào drops xảy ra?

Tổng hợp tất cả các yếu tố đã phân tích, drops xảy ra khi một hoặc nhiều điều kiện sau đúng:

| Điều kiện | Cơ chế | Mức độ ảnh hưởng |
|-----------|--------|-------------------|
| Rate vượt threshold (~11/s với config mặc định) | VU allocation không theo kịp arrival | **CAO** |
| Async jobs cluster (≥4 async liên tiếp) | Concurrent VU spike vượt pool | **CAO** |
| Stage transition (rate thay đổi đột ngột) | Allocation delay trong giai đoạn chuyển tiếp | Trung bình |
| Tail latency của async job (wait > 140ms) | Iteration dài hơn dự kiến → giữ VU lâu hơn | Trung bình |
| preAllocatedVUs thấp hơn concurrent VU | Phải allocate VU từ cold state | **CAO** |
| maxVUs bị hit | Ceiling effect — không thể allocate thêm | **CAO** (khi kết hợp với các yếu tố trên) |
| Server overload (http_req_duration tăng) | Feedback loop: chậm hơn → giữ VU lâu hơn → cần nhiều VU hơn | Thấp (trong case này, server thường không overload) |

**Ma trận xác suất:**

```
Rate:          Thấp (<8/s)  Trung bình (8-12/s)  Cao (>12/s)
Async cluster: 
  Thấp (0-1)      PASS          PASS                PASS (hiếm)
  Trung bình (2-3) PASS          CÓ THỂ DROP         DROP
  Cao (≥4)         CÓ THỂ DROP   DROP                DROP NHIỀU
```

Với arrival ngẫu nhiên, xác suất cluster tăng theo rate → drops bắt đầu xuất hiện ở rate trung bình-cao và trở nên nghiêm trọng ở rate cao.

---

## 7. Bảng service/API flow

### 7.1 Tổng quan hai branches

```
Ramping Arrival Rate (Case 05)
│
├── Branch: dashboard (70%)
│   │
│   └── GET /api/sim/report
│       ├── Method: GET
│       ├── Headers: standard
│       ├── Body: none
│       ├── Expected: 200 OK
│       ├── Response time: ~5ms
│       ├── Event duration: ~5ms (1 HTTP call, no sleep)
│       └── Tags: { branch: "dashboard" }
│
└── Branch: async_job (30%)
    │
    ├── Step 1: POST /api/sim/report/jobs
    │   ├── Method: POST
    │   ├── Headers: Content-Type: application/json
    │   ├── Body: { type: "report", params: {...} }
    │   ├── Expected: 202 Accepted
    │   ├── Response body: { id: "job-xxx", status: "pending" }
    │   ├── Response time: ~5ms
    │   └── Tags: { branch: "async_job", step: "create" }
    │
    ├── Step 2: sleep(READY_AFTER_MS / 1000)
    │   ├── Duration: ~140ms (default)
    │   ├── VU state: BLOCKED (không làm gì, nhưng vẫn chiếm VU)
    │   └── Purpose: Mô phỏng thời gian job xử lý bất đồng bộ
    │
    └── Step 3: GET /api/sim/report/jobs/{id}
        ├── Method: GET
        ├── URL: /api/sim/report/jobs/{jobId từ step 1}
        ├── Expected: 200 OK
        ├── Response body: { id: "job-xxx", status: "ready", data: {...} }
        ├── Response time: ~5ms
        └── Tags: { branch: "async_job", step: "status", job_id: "job-xxx" }
```

### 7.2 HTTP call count reconciliation

| Branch | Weight | Iterations (trên 280 total) | HTTP calls/iter | Tổng HTTP calls | % HTTP calls |
|--------|--------|----------------------------|-----------------|-----------------|--------------|
| dashboard | 70% | ~196 | 1 | ~196 | ~53.8% |
| async_job | 30% | ~84 | 2 | ~168 | ~46.2% |
| **Total** | **100%** | **~280** | — | **~364** | **100%** |

**Lưu ý quan trọng:** 280 iterations tạo ra ~364 HTTP calls. Khi đọc `http_reqs` metric, bạn sẽ thấy số lượng > số iteration. Điều này là bình thường và không phải là dấu hiệu của vấn đề.

### 7.3 Event duration breakdown

| Branch | HTTP time | Sleep/Wait time | Total event duration | % of iteration |
|--------|-----------|----------------|---------------------|----------------|
| dashboard | 5ms | 0ms | 5ms | 100% HTTP |
| async_job | 10ms (5+5) | 140ms | 150ms | 6.7% HTTP, 93.3% wait |

**Insight:** 93.3% thời gian của async iteration là CHỜ (sleep), không phải xử lý HTTP. Đây là lý do VU pool bị lãng phí — VU "ngồi không" trong lúc chờ job hoàn thành.

### 7.4 So sánh với async pattern trong constant-arrival-rate (car-05)

Case này được thiết kế tương tự car-05 trong series constant-arrival-rate. Điểm khác biệt:
- car-05: constant rate, không có ramp → drops xảy ra liên tục nếu có
- rar-05: ramp pattern → drops chỉ xảy ra ở peak, cho thấy rõ rate threshold

Cả hai đều dạy cùng một bài học: async wait pattern + open model = VU pool bottleneck.

---

## 8. Metrics & tags deep-dive

### 8.1 Tag strategy

```javascript
// Dashboard branch
http.get('/api/sim/report', {
  tags: {
    branch: 'dashboard',
    scenario: 'report_ingress_ramp'
  }
});

// Async job branch
http.post('/api/sim/report/jobs', payload, {
  tags: {
    branch: 'async_job',
    step: 'create',
    scenario: 'report_ingress_ramp'
  }
});

http.get(`/api/sim/report/jobs/${jobId}`, {
  tags: {
    branch: 'async_job',
    step: 'status',
    job_id: jobId,
    scenario: 'report_ingress_ramp'
  }
});
```

### 8.2 Metrics cần theo dõi

#### Primary metrics (quyết định pass/fail)

| Metric | Ý nghĩa | Pass value | Weight trong decision |
|--------|---------|------------|----------------------|
| `dropped_iterations` | Số iteration bị drop do không có VU | 0 | **#1 PRIORITY** |
| `iterations.completed` | Số iteration hoàn thành | = total scheduled | **#2** |
| `vus_max` | Số VU tối đa được allocate | < maxVUs (có margin) | #3 |

#### Secondary metrics (giải thích tại sao)

| Metric | Ý nghĩa | Cách đọc |
|--------|---------|----------|
| `http_req_duration` (avg, p95, p99) | Thời gian HTTP response | So sánh dashboard vs async_job |
| `http_req_duration` theo tag `branch` | Response time từng branch | Dashboard ~5ms, async_job ~5ms (mỗi call) |
| `http_reqs` | Tổng số HTTP requests | Phải > iterations (vì async có 2 calls) |
| `vus` (theo thời gian) | Concurrent VU theo thời gian | Xem VU pool có chạm max không |
| `iteration_duration` (avg, p95) | Thời gian toàn bộ iteration | Dashboard ~5ms, async_job ~150ms |
| `checks` | Tỷ lệ check pass | 100% (nhưng không đủ để pass) |
| `http_req_failed` | Tỷ lệ request thất bại | 0% (nhưng không đủ để pass) |

### 8.3 Weighted call count reconciliation

Khi đọc `http_reqs` theo tag:

```
http_reqs{ branch="dashboard" }  ≈ 196
http_reqs{ branch="async_job" }  ≈ 168

Tổng http_reqs ≈ 364

Ratio async_job/dashboard ≈ 168/196 ≈ 0.86

Nhưng branch weight là 30/70 ≈ 0.43

Tại sao khác? Vì async_job có 2 HTTP calls/iteration,
dashboard chỉ có 1.

Chuẩn hóa về iterations:
dashboard_iterations = 196 / 1 = 196
async_job_iterations = 168 / 2 = 84
Ratio = 84/196 = 0.43 ≈ 30/70 ✓
```

**Quy tắc:** Khi reconcile metrics, luôn normalize HTTP call count về iteration count bằng cách chia cho số calls/iteration của từng branch.

### 8.4 Custom metrics cần consider

Ngoài built-in metrics, case này có thể hưởng lợi từ custom metrics:

```javascript
// Custom metric: thời gian end-to-end của async job
const asyncE2ETrend = new Trend('async_job_e2e_duration', true);

// Trong async branch:
const startTime = Date.now();
const createRes = http.post('/api/sim/report/jobs', payload);
const jobId = createRes.json().id;
sleep(READY_AFTER_MS / 1000);
const statusRes = http.get(`/api/sim/report/jobs/${jobId}`);
asyncE2ETrend.add(Date.now() - startTime);
```

Custom metric này cho phép bạn đo chính xác thời gian từ lúc tạo job đến lúc nhận kết quả, bao gồm cả wait time.

### 8.5 Tag cardinality warning

Tag `job_id` có cardinality cao (mỗi iteration một giá trị). Trong k6, tag cardinality cao có thể gây vấn đề với metrics storage (đặc biệt là cloud output). Cân nhắc:
- Chỉ dùng `job_id` tag khi thực sự cần debug
- Trong production test, bỏ `job_id` tag để giảm cardinality
- Dùng console log thay vì tag cho job-level tracing

---

## 9. Pass criteria

### 9.1 Primary criterion — dropped_iterations = 0

```
PASS: dropped_iterations == 0
FAIL: dropped_iterations > 0
```

Đây là tiêu chí DUY NHẤT. Không có ngoại lệ. Không có "pass với điều kiện". Nếu một iteration bị drop, test fail — bất kể checks, http_req_failed, hay bất kỳ metric nào khác nói gì.

### 9.2 Tại sao dropped_iterations lại cứng nhắc như vậy?

Trong open model, dropped_iterations có nghĩa:
- Hệ thống **không thể** xử lý được toàn bộ traffic được schedule
- Một số request của user **sẽ không bao giờ được phục vụ**
- Đây không phải là "chậm" — đây là **thất bại hoàn toàn** của những request đó
- Nếu đây là production, những user đó sẽ thấy timeout hoặc connection refused

So sánh: trong closed model, nếu VU bận, iteration tiếp theo chỉ đơn giản là đợi — user ảo "chờ" đến lượt. Trong thực tế, điều này tương đương với việc user phải đợi lâu hơn, nhưng cuối cùng họ vẫn được phục vụ. Trong open model, user thực không "chờ" — họ đến, và nếu không được phục vụ, họ bỏ đi (hoặc bị từ chối).

### 9.3 Secondary checks — informative only

Những metrics sau cung cấp context nhưng KHÔNG quyết định pass/fail:

| Check | Pass condition | Nếu fail? |
|-------|---------------|-----------|
| checks | 100% | Có bug trong response logic |
| http_req_failed | 0% | Có HTTP errors (5xx, connection refused, timeout) |
| http_req_duration p95 | < 200ms | Response chậm — có thể là dấu hiệu server overload |
| vus_max | < maxVUs | VU pool đã chạm trần — tăng maxVUs có thể giúp |
| iteration_duration p95 | < 500ms | Iteration quá dài — async wait hoặc server chậm |

### 9.4 Pass/fail decision matrix

| dropped_iterations | checks | http_req_failed | Decision | Action |
|-------------------|--------|-----------------|----------|--------|
| 0 | 100% | 0% | **PASS** | Không cần action |
| 0 | <100% | 0% | **PASS (với bug)** | Fix response validation, nhưng capacity OK |
| 0 | 100% | >0% | **PASS (với HTTP errors)** | Điều tra HTTP errors, nhưng capacity OK |
| >0 | 100% | 0% | **FAIL** | **ĐÂY LÀ CASE 05** — Capacity problem, tăng VU hoặc giảm event duration |
| >0 | <100% | 0% | **FAIL** | Cả capacity và logic đều có vấn đề |
| >0 | 100% | >0% | **FAIL** | Cả capacity và HTTP đều có vấn đề |

### 9.5 Expected result for case 05

Với config mặc định (preAllocatedVUs=15, maxVUs=45, READY_AFTER_MS=140):

```
EXPECTED: FAIL
dropped_iterations: > 0 (có thể 5-50, tùy thuộc vào arrival clustering)
checks: 100%
http_req_failed: 0%
http_req_duration avg: ~5ms (cả hai branches)
iteration_duration avg: ~48.5ms (weighted)
iteration_duration p95: ~150ms (async job)
vus_max: có thể chạm 45 (hit ceiling)
```

---

## 10. Cách chạy

### 10.1 Basic run

```bash
k6 run rar-05-report-ingress-ramp.js
```

Kết quả mong đợi: **FAIL** — `dropped_iterations > 0`, dù checks=100% và http_req_failed=0%.

### 10.2 Với cloud output

```bash
k6 run --out cloud rar-05-report-ingress-ramp.js
```

Kết quả hiển thị trên Grafana Cloud k6 dashboard, nơi bạn có thể thấy timeline của VU usage và dropped iterations.

### 10.3 Experiment với READY_AFTER_MS

Biến môi trường `READY_AFTER_MS` kiểm soát thời gian async job "xử lý" (sleep giữa POST và GET):

```bash
# Scenario A: Async job cực nhanh (5ms) — kỳ vọng PASS
READY_AFTER_MS=5 k6 run rar-05-report-ingress-ramp.js

# Scenario B: Default (140ms) — kỳ vọng FAIL
READY_AFTER_MS=140 k6 run rar-05-report-ingress-ramp.js

# Scenario C: Async job rất chậm (500ms) — kỳ vọng FAIL nặng
READY_AFTER_MS=500 k6 run rar-05-report-ingress-ramp.js

# Scenario D: Async job cực chậm (1000ms) — kỳ vọng FAIL thảm họa
READY_AFTER_MS=1000 k6 run rar-05-report-ingress-ramp.js
```

### 10.4 Experiment với VU pool size

```bash
# Default VU pool (preAllocated=15, max=45)
k6 run rar-05-report-ingress-ramp.js

# Tăng preAllocated
k6 run --env PRE_ALLOCATED_VUS=30 rar-05-report-ingress-ramp.js

# Tăng max
k6 run --env MAX_VUS=100 rar-05-report-ingress-ramp.js

# Cả hai
k6 run --env PRE_ALLOCATED_VUS=30 --env MAX_VUS=100 rar-05-report-ingress-ramp.js
```

### 10.5 Script structure (hypothetical)

File: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-ingress-ramp.js`

Cấu trúc giả định:

```javascript
import http from 'k6/http';
import { sleep } from 'k6';
import { check } from 'k6';

const READY_AFTER_MS = __ENV.READY_AFTER_MS || 140;
const PRE_ALLOCATED_VUS = __ENV.PRE_ALLOCATED_VUS || 15;
const MAX_VUS = __ENV.MAX_VUS || 45;

export const options = {
  scenarios: {
    report_ingress_ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 2,
      timeUnit: '1s',
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: [
        { duration: '10s', target: 6 },
        { duration: '15s', target: 14 },
        { duration: '10s', target: 4 },
      ],
    },
  },
};

export default function () {
  if (Math.random() < 0.7) {
    // Dashboard branch (70%)
    const res = http.get('/api/sim/report', {
      tags: { branch: 'dashboard' },
    });
    check(res, {
      'dashboard status 200': (r) => r.status === 200,
    });
  } else {
    // Async job branch (30%)
    const createRes = http.post('/api/sim/report/jobs', 
      JSON.stringify({ type: 'report', params: {} }),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { branch: 'async_job', step: 'create' },
      }
    );
    
    check(createRes, {
      'create job status 202': (r) => r.status === 202,
    });
    
    if (createRes.status === 202) {
      const jobId = createRes.json().id;
      
      // Wait for job to be ready — GIỮ VU
      sleep(READY_AFTER_MS / 1000);
      
      const statusRes = http.get(`/api/sim/report/jobs/${jobId}`, {
        tags: { branch: 'async_job', step: 'status' },
      });
      
      check(statusRes, {
        'status 200': (r) => r.status === 200,
        'job ready': (r) => r.json().status === 'ready',
      });
    }
  }
}
```

---

## 11. Phân tích output 5 bước

### Step 1: Đọc summary metrics

Chạy test xong, nhìn vào phần summary:

```
     ✓ dashboard status 200
     ✓ create job status 202
     ✓ status 200
     ✓ job ready

     █ Report Ingress Ramp

       ✗ dropped_iterations.........: 23   ← FAIL SIGNAL
       ✓ checks.....................: 100.00%
       ✓ http_req_failed............: 0.00%
         http_req_duration..........: avg=5.2ms  p(95)=8.1ms
         http_reqs..................: 342
         iteration_duration.........: avg=52.3ms p(95)=158.7ms
         iterations.................: 257 completed, 280 scheduled
         vus........................: 18 min=1  max=45
         vus_max....................: 45
```

**Phân tích:**
- `dropped_iterations = 23`: Test FAIL. 23 iterations không bao giờ được thực thi.
- `checks = 100%`: Tất cả request được gửi đều OK. Vấn đề không nằm ở logic.
- `http_req_failed = 0%`: Không có HTTP error. Server vẫn khỏe.
- `http_req_duration = 5.2ms avg`: Response nhanh. Server không overload.
- `iteration_duration = 52.3ms avg, 158.7ms p95`: P95 gần bằng async event duration — đúng như dự đoán.
- `vus_max = 45`: Đã chạm ceiling. Có thể cần thêm VU.
- `iterations = 257/280`: 257 hoàn thành + 23 drop = 280. Khớp.

### Step 2: Check dropped_iterations timeline (nếu có cloud output)

Trên Grafana Cloud, xem timeline của `dropped_iterations`:

```
Drops bắt đầu: ~ second 16-18 (khi rate đạt ~11-12/s)
Drops peak: ~ second 20-23 (khi rate = 14/s)
Drops kết thúc: ~ second 27-28 (khi rate giảm xuống ~6-7/s)
Tổng drops: 23
```

Pattern này cho thấy drops xảy ra khi rate > ~11/s. Đây là **rate threshold** của hệ thống với config hiện tại.

### Step 3: Analyze VU utilization theo thời gian

```
Second  0-10: VU = 1-3 (stage 1, rate 2-6/s, thấp)
Second 10-15: VU = 3-8 (stage 2 đầu, rate 6-10/s, tăng dần)
Second 15-20: VU = 8-25 (stage 2 giữa, rate 10-14/s, tăng nhanh)
Second 20-25: VU = 25-45 (PEAK, rate 14/s, VU tăng vọt)
Second 25-30: VU = 45-30 (stage 3 đầu, rate 14→7/s, VU giảm dần)
Second 30-35: VU = 30-10 (stage 3 cuối, rate 7→4/s, pool phục hồi)
```

**Insight:** VU count tăng phi tuyến. Từ second 15 đến 20, VU tăng từ 8 lên 25 (gấp 3) dù rate chỉ tăng từ 10 lên 14 (gấp 1.4). Điều này xác nhận hiệu ứng clustering: khi rate cao hơn, async jobs cluster nhiều hơn, đòi hỏi nhiều VU hơn tỷ lệ.

### Step 4: Compare http_req_duration vs iteration_duration

```
http_req_duration (dashboard): avg=5ms, p95=7ms
http_req_duration (async create): avg=5ms, p95=8ms
http_req_duration (async status): avg=5ms, p95=8ms

iteration_duration (dashboard): avg=5ms, p95=7ms
iteration_duration (async): avg=150ms, p95=160ms
```

**Insight:** HTTP response times đều nhanh (~5ms). Nhưng iteration duration của async là 150ms — gấp 30 lần http_req_duration. Khoảng cách này chính là sleep/wait time. Đây là lý do bạn không thể dùng http_req_duration để capacity planning cho async scenario.

### Step 5: Reconcile iteration counts

```
Total scheduled iterations = 280 (từ công thức diện tích)
Total completed iterations = 257
Dropped iterations = 23
Total = 257 + 23 = 280 ✓

Expected HTTP calls:
- Dashboard iterations: 257 × 0.7 ≈ 180 → 180 HTTP calls
- Async iterations: 257 × 0.3 ≈ 77 → 154 HTTP calls (2 mỗi iteration)
- Total expected: 180 + 154 = 334

Actual http_reqs: 342
Difference: 342 - 334 = 8 (có thể do một số async iteration chỉ hoàn thành 1/2 calls trước khi bị drop?)

Hoặc: nếu một async iteration bị drop sau khi đã POST nhưng trước khi GET:
- POST được gửi, nhưng iteration bị drop trước khi GET
- http_reqs tính POST, nhưng iteration không completed
- Điều này giải thích sự khác biệt nhỏ
```

---

## 12. Dashboard 3-chart deep analysis

### 12.1 Chart 1: Response Time — Dashboard vs Async (huge disparity)

**Mô tả chart:** Biểu đồ `http_req_duration` theo thời gian, grouped by `branch` tag.

**Kỳ vọng:**

```
ms
160 ┤                                          ╭─ async_job (p95)
140 ┤                                 ╭────────╯
120 ┤                                ╱
100 ┤                               ╱
 80 ┤                              ╱
 60 ┤                             ╱
 40 ┤                            ╱
 20 ┤                           ╱
  0 ┤──────────────────────────╱────────────────── dashboard (p95)
    └────────────────────────────────────────────────────────── time
    0s                    10s  15s   20s   25s         35s
```

**Nhưng chú ý:** Đây là `http_req_duration`, không phải `iteration_duration`. Cả hai branch đều có http_req_duration ~5ms. Biểu đồ http_req_duration sẽ cho thấy **cả hai branch đều nhanh như nhau**. Đây chính là **cạm bẫy**: nhìn chart này, bạn sẽ nghĩ "mọi thứ đều ổn".

Biểu đồ `iteration_duration` grouped by branch mới cho thấy sự thật:

```
ms
160 ┤                                          ╭─ async_job
140 ┤                                 ╭────────╯
120 ┤                                ╱
100 ┤                               ╱
 80 ┤                              ╱
 60 ┤                             ╱
 40 ┤                            ╱
 20 ┤                           ╱
  0 ┤──────────────────────────╱────────────────── dashboard
    └────────────────────────────────────────────────────────── time
```

**Insight:** Dashboard có iteration_duration ổn định ~5ms. Async_job có iteration_duration ~150ms (do sleep). Sự disparity này là gốc rễ của vấn đề VU pool. Nếu bạn chỉ nhìn http_req_duration, bạn sẽ bỏ lỡ hoàn toàn vấn đề này.

**Hành động sau khi xem chart:**
1. Xác nhận: async_job iteration_duration >> dashboard iteration_duration
2. Tính W_effective weighted để estimate VU requirement thực tế
3. Xem xét: có thể giảm async wait time không?
4. Nếu không: cần tăng preAllocatedVUs và maxVUs

### 12.2 Chart 2: Execution Timeline — iter/s falling below target at peak

**Mô tả chart:** Biểu đồ `iterations` (rate) theo thời gian, so sánh với target rate từ stages.

**Kỳ vọng:**

```
iter/s
14 ┤                     ╭──────────────╮ target
12 ┤                    ╱                ╲
10 ┤                   ╱                  ╲
 8 ┤                  ╱                    ╲
 6 ┤        ╭────────╱                      ╲────────╮
 4 ┤       ╱                                          ╲
 2 ┤──────╱                                              ╲──────
   └──────────────────────────────────────────────────────────── time
   0s        10s              20s              25s        35s

iter/s (actual — nếu có drops)
14 ┤                     ╭──────╮ target
12 ┤                    ╱        ╲
10 ┤                   ╱          ╲
 8 ┤                  ╱            ╲
 6 ┤        ╭────────╱              ╲────────╮
 4 ┤       ╱          ╲              ╲        ╲
 2 ┤──────╱            ╲______________╲________╲──────  ← actual
   └──────────────────────────────────────────────────────────── time
                      ^^^^^^^^^^^^^^
                      GAP = dropped iterations
```

**Phân tích gap:**
- GAP xuất hiện khi rate vượt ~11/s
- GAP lớn nhất tại peak (14/s)
- GAP biến mất khi rate giảm xuống dưới ~7/s
- Điều này cho thấy hệ thống có capacity threshold ở khoảng 11/s với config hiện tại

**Cách tính capacity threshold từ chart:**

```
Tại rate 11/s:
- async jobs: 11 × 0.3 = 3.3/s
- VU async cần: 3.3 × 0.150 = 0.5 VU (mean)
- Dashboard: 11 × 0.7 = 7.7/s → 0.04 VU
- Total VU mean: ~0.54

Nhưng thực tế bắt đầu drop ở 11/s với preAllocated=15?
→ Điều này cho thấy VU allocation không theo kịp, hoặc clustering tệ hơn dự kiến
→ HOẶC: server bắt đầu chậm ở rate này → event duration tăng → cần nhiều VU hơn
```

### 12.3 Chart 3: VUs vs iter/s — VUs climbing to max, still dropping

**Mô tả chart:** Dual-axis chart: `vus` (left axis) và `iterations` rate (right axis) theo thời gian.

**Kỳ vọng:**

```
VUs                                    iter/s
45 ┤                          ╭────── 14
40 ┤                         ╱
35 ┤                        ╱
30 ┤                       ╱
25 ┤                      ╱
20 ┤                     ╱
15 ┤                    ╱
10 ┤            ╭──────╱
 5 ┤          ╱
 0 ┤─────────╱────────────────────── 0
   └────────────────────────────────────── time
   0s    10s    15s    20s   25s    35s

VUs line (solid), iter/s line (dashed)
```

**Phân tích quan trọng:**

1. **VU count tăng nhanh hơn iter/s:**
   - Từ second 10 đến 20: iter/s tăng từ 6 lên 14 (×2.3), VU tăng từ 3 lên 45 (×15)
   - Điều này cho thấy mỗi iteration tiêu tốn nhiều VU-time hơn khi rate tăng
   - Nguyên nhân: async jobs cluster, event duration không đổi nhưng concurrency tăng

2. **VU chạm ceiling (45) trước khi iter/s đạt peak:**
   - VU đạt 45 có thể ở second 18-19, trong khi iter/s đạt 14 ở second 20
   - Trong khoảng 18-20s: VU đã max nhưng iter/s vẫn tăng → drops bắt đầu
   - **Đây là tín hiệu rõ nhất:** VU ceiling là bottleneck

3. **VU giảm chậm hơn iter/s:**
   - Sau second 25 (rate bắt đầu giảm), VU vẫn duy trì ở mức cao một lúc
   - Lý do: async jobs đang chạy vẫn giữ VU trong ~150ms sau khi rate giảm
   - "Tail" VU này là hậu quả của async pattern

4. **So sánh với case 01 (peak 28/s, chỉ cần ~1 VU):**
   - Case 01: iter/s = 28, VU = 1. Tỷ lệ VU/iter_s = 0.036
   - Case 05: iter/s = 14, VU = 45. Tỷ lệ VU/iter_s = 3.21
   - Case 05 cần VU/iter_s cao gấp ~90 lần case 01!
   - **Đây là bài học về async cost:** async pattern "đắt" hơn sync pattern rất nhiều về mặt VU

**Kết luận từ 3 charts:**
1. Response time chart: http_req_duration đẹp nhưng iteration_duration xấu → đừng chỉ nhìn HTTP metrics
2. Execution timeline: gap giữa target và actual iter/s → dropped_iterations là tín hiệu chính
3. VUs vs iter/s: VU requirement phi tuyến, tăng vọt ở rate cao → async pattern rất đắt về VU

---

## 13. 4 output→decision scenarios

### 13.1 Scenario A: Hypothetical PASS — Fast async (READY_AFTER_MS=5)

**Config:** READY_AFTER_MS=5 (async job "xử lý" trong 5ms)

**Kỳ vọng output:**

```
dropped_iterations.........: 0      ← PASS
checks.....................: 100.00%
http_req_failed............: 0.00%
http_req_duration..........: avg=5.1ms
iteration_duration.........: avg=5.2ms p(95)=7.5ms
vus........................: max=5
vus_max....................: 5
```

**Phân tích:**
- W_effective = 0.7×5ms + 0.3×(5ms_POST + 5ms_sleep + 5ms_GET) = 3.5ms + 4.5ms = 8ms
- VU cần: ceil(14 × 0.008) = 1 VU
- Với 15 preAllocated, dư dả rất nhiều → 0 drops
- Conclusion: **PASS**

**Decision:** Hệ thống pass. Không cần thay đổi gì. Async job đủ nhanh để không gây VU bottleneck.

**Bài học:** Nếu bạn có thể giảm async processing time từ 140ms xuống 5ms, VU requirement giảm từ ~45 xuống ~5. Đầu tư vào tối ưu async processing ROI cao hơn nhiều so với tăng VU pool.

---

### 13.2 Scenario B: Expected FAIL — Default config

**Config:** READY_AFTER_MS=140, preAllocatedVUs=15, maxVUs=45

**Kỳ vọng output:**

```
dropped_iterations.........: 23      ← FAIL
checks.....................: 100.00% ← VẪN 100%
http_req_failed............: 0.00%   ← VẪN 0%
http_req_duration..........: avg=5.2ms
iteration_duration.........: avg=52.3ms p(95)=158.7ms
vus........................: max=45
vus_max....................: 45       ← CHẠM CEILING
```

**Phân tích:**
- 23 iterations bị drop → test fail, bất chấp checks và http_req_failed đều sạch
- VU pool đã được đẩy lên tối đa 45 nhưng vẫn không đủ
- Đây là THE TEACHING CASE: cho thấy nghịch lý "checks pass nhưng test fail"

**Decision:** Test FAIL. Cần investigation và action.

**Path forward:**
1. Tăng maxVUs (thử 100, 200) → có thể giảm drops nhưng có thể không eliminate
2. Giảm async wait time (READY_AFTER_MS) → đây là giải pháp gốc rễ
3. Tách scenario: dashboard riêng, async job riêng với config khác nhau
4. Accept drops ở peak và set SLA: "chấp nhận <1% drops ở peak 14/s"

---

### 13.3 Scenario C: Larger pool still fails — maxVUs=100

**Config:** READY_AFTER_MS=140, preAllocatedVUs=30, maxVUs=100

**Kỳ vọng output:**

```
dropped_iterations.........: 5       ← GIẢM nhưng VẪN >0 → FAIL
checks.....................: 100.00%
http_req_failed............: 0.00%
http_req_duration..........: avg=5.3ms (hơi tăng do nhiều concurrent requests)
iteration_duration.........: avg=54.1ms p(95)=162.3ms (hơi tăng)
vus........................: max=78
vus_max....................: 100      ← KHÔNG CHẠM CEILING, nhưng vẫn drop
```

**Phân tích:**
- drops giảm từ 23 xuống 5 (cải thiện 78%) — tăng VU pool có tác dụng
- Nhưng vẫn > 0 → vẫn FAIL
- VU chưa chạm ceiling (78 < 100) mà đã drop → vấn đề không (chỉ) là ceiling
- http_req_duration hơi tăng (5.2→5.3ms) → nhiều concurrent requests hơn gây nhẹ server load
- iteration_duration hơi tăng (52.3→54.1ms) → đồng bộ với http_req_duration tăng

**Tại sao vẫn drop dù chưa chạm ceiling?**

1. **VU allocation rate limit:** k6 có thể có giới hạn về tốc độ allocate VU mới. Nếu arrival rate tăng nhanh hơn allocation rate, drops có thể xảy ra dù ceiling chưa đạt.

2. **VU spin-up overhead:** Mỗi VU mới cần thời gian để khởi tạo (load script, establish connections). Nếu nhiều VU được allocate cùng lúc, overhead này có thể gây delay.

3. **Stage transition spike:** Khi rate nhảy từ 6 lên 14/s, nhu cầu VU tăng đột ngột. Dù ceiling cao, allocation không kịp trong vài giây đầu của stage 2.

4. **Không có preAllocated đủ:** preAllocated=30 nhưng nhu cầu có thể vượt 30 trong spike.

**Decision:** Test vẫn FAIL. Tăng maxVUs không phải là silver bullet.

**Path forward:**
- Tăng preAllocatedVUs lên 50-60 để loại bỏ allocation delay
- HOẶC: giảm async wait time
- HOẶC: restructure test để giảm async weight

---

### 13.4 Scenario D: Reduce async weight — drops decrease

**Config:** READY_AFTER_MS=140, preAllocatedVUs=15, maxVUs=45, nhưng async weight = 10% (thay vì 30%)

**Kỳ vọng output:**

```
dropped_iterations.........: 2       ← GIẢM MẠNH
checks.....................: 100.00%
http_req_failed............: 0.00%
iteration_duration.........: avg=19.8ms p(95)=152.3ms
vus_max....................: 28       ← KHÔNG CHẠM CEILING
```

**Phân tích:**
- W_effective mới = 0.9×5ms + 0.1×150ms = 4.5ms + 15ms = 19.5ms
- VU cần (mean): ceil(14 × 0.0195) = 1 VU
- Nhưng peak concurrent async = 14×0.1×0.150 = 0.21 VU → ít clustering hơn nhiều
- drops giảm mạnh (23→2) vì async cluster probability giảm
- Nhưng vẫn có 2 drops → cho thấy ngay cả 10% async cũng có thể gây vấn đề ở peak

**Decision:** Vẫn FAIL (drops > 0), nhưng cải thiện đáng kể.

**Bài học:** Async weight là lever quan trọng. Giảm tỷ lệ async jobs (ví dụ: bằng cách cache dashboard data, pre-compute reports) có thể giảm đáng kể VU requirement.

---

## 14. "Nghịch lý" — 4 Paradoxes

### 14.1 NL1: "checks=100%, http_req_failed=0% nhưng test FAIL"

**Nghịch lý:** Mọi HTTP request đều thành công, mọi check đều pass, không có lỗi nào — nhưng test vẫn báo FAIL.

**Giải thích:**
- Checks và http_req_failed chỉ đo lường những gì ĐÃ ĐƯỢC thực thi
- Những iteration bị drop CHƯA TỪNG gửi HTTP request nào → không có cơ hội để fail check hay HTTP
- dropped_iterations là metric ở level CAO HƠN HTTP — nó đo lường capacity của chính test infrastructure (VU pool)
- Trong open model, capacity để thực thi iteration quan trọng không kém (thực ra là quan trọng hơn) chất lượng của từng request riêng lẻ

**Hệ quả thực tế:** Nếu đây là production, 23 requests của 23 users đã bị "bỏ rơi" — họ không nhận được phản hồi nào, không có error message, chỉ là... không có gì xảy ra. Đây là loại failure tệ nhất vì nó silent — không có alert nào từ HTTP monitoring.

**Cách tránh:** Luôn check `dropped_iterations` trong CI/CD pipeline. Set alert: `dropped_iterations > 0 → fail build`.

---

### 14.2 NL2: "Tăng VU pool mà vẫn drop"

**Nghịch lý:** Bạn đã tăng maxVUs từ 45 lên 100 (gấp 2.2 lần), VU thực tế chỉ dùng đến 78 (chưa chạm ceiling), nhưng vẫn có drops.

**Giải thích:**
- Drops không chỉ xảy ra khi VU pool chạm ceiling
- Drops cũng xảy ra khi VU allocation không theo kịp arrival rate spike
- Allocation VU là quá trình có độ trễ: k6 phải khởi tạo VU mới (load script, thiết lập connection, ...)
- Nếu arrival rate tăng nhanh hơn allocation rate, sẽ có "gap" tạm thời → drops

**Minh họa bằng numbers:**
```
Second 10.0: rate = 6/s, VU = 3
Second 10.5: rate = 7/s, cần VU = 4. k6 bắt đầu allocate VU #4
Second 11.0: rate = 8/s, VU #4 chưa sẵn sàng. Iteration đến → DROP!
Second 11.2: VU #4 sẵn sàng. Nhưng iteration đã bị drop mất rồi.
```

**Giải pháp:** Tăng `preAllocatedVUs`, không chỉ `maxVUs`. preAllocated giữ sẵn VU để hấp thụ spike mà không cần allocation.

---

### 14.3 NL3: "event_duration != http_req_duration — wait/sleep cũng giữ VU"

**Nghịch lý:** http_req_duration báo cáo ~5ms cho mọi request, nhưng iteration_duration báo cáo ~150ms cho async branch. VU bị "bận" trong 150ms dù HTTP chỉ mất 10ms.

**Giải thích:**
- K6 metrics chia làm hai level:
  - **HTTP-level metrics** (http_req_*): chỉ đo thời gian của HTTP request/response
  - **Iteration-level metrics** (iteration_duration): đo toàn bộ thời gian của một iteration, bao gồm cả sleep, script execution, và bất kỳ code nào giữa các HTTP calls

- `sleep()` trong k6 giữ VU. Trong thời gian sleep, VU không thể phục vụ iteration khác.
- Điều này đúng với mô hình thực tế: user thực cũng "bận" trong lúc chờ job hoàn thành — họ không gửi request khác trong lúc đó.

**Hệ quả cho capacity planning:**
- Dùng `http_req_duration` để estimate VU requirement → estimate sai (thiếu) cho async scenario
- Phải dùng `iteration_duration` (hoặc tính toán thủ công nếu có sleep)
- Công thức đúng: VU = arrival_rate × iteration_duration (không phải http_req_duration)

**Công thức tổng quát:**
```
iteration_duration = Σ(http_req_duration_i) + Σ(sleep_time_j) + Σ(script_execution_time_k)

VU_required = arrival_rate × avg_iteration_duration
```

---

### 14.4 NL4: "Peak 14/s thấp nhưng cần nhiều VU hơn case 01 (peak 28/s)"

**Nghịch lý:** Case 01 có peak rate 28/s, gấp đôi case 05, nhưng case 01 pass dễ dàng với 1 VU. Case 05 có peak rate 14/s nhưng fail với 45 VU.

**Giải thích bằng số:**

| | Case 01 | Case 05 |
|---|---------|---------|
| Peak rate | 28/s | 14/s |
| Event duration | ~2ms (sync HTTP) | ~48.5ms (weighted, bimodal) |
| W_effective | 2ms | 48.5ms |
| VU cần (Little's Law) | 28 × 0.002 = 0.056 ≈ 1 | 14 × 0.0485 = 0.679 ≈ 1 |
| VU thực tế cần | ~1 | ~45 (do clustering + allocation overhead) |
| VU/iter_s ratio | 0.036 | 3.21 |

Lý thuyết Little's Law nói cả hai chỉ cần 1 VU. Nhưng thực tế:
- Case 01: arrival đều, event duration ngắn và đồng nhất → Little's Law áp dụng tốt
- Case 05: arrival ngẫu nhiên, event duration bimodal (5ms vs 150ms) → Little's Law với mean không áp dụng; cần model phức tạp hơn (M/G/c queue với bimodal service time)

**Insight:** Arrival rate cao không nhất thiết đồng nghĩa với VU requirement cao. Event duration distribution và pattern quan trọng hơn raw rate. Một system với 1000 req/s, mỗi req 1ms → cần 1 VU. Một system với 10 req/s, mỗi req 1000ms → cần 10 VU.

---

### 14.5 NL5: "Tăng preAllocatedVUs quá cao thì test mất ý nghĩa"

**Nghịch lý:** Nếu bạn set preAllocatedVUs=500, maxVUs=1000, test sẽ pass với 0 drops. Nhưng... liệu kết quả đó có ý nghĩa không?

**Giải thích:**
- preAllocatedVUs quá cao nghĩa là bạn đang "giải quyết" vấn đề bằng cách throw resource vào
- Trong thực tế, load generator có giới hạn: một máy không thể chạy 1000 VU
- Nếu bạn cần 500 VU để xử lý 14 req/s, có điều gì đó rất sai trong thiết kế test hoặc hệ thống
- Test với VU pool khổng lồ không còn phản ánh capacity thực tế nữa

**Ví dụ cực đoan:**
```
preAllocatedVUs=10000, maxVUs=20000
→ Pass mọi test
→ Nhưng: load generator sẽ OOM trước khi đạt 10000 VU
→ Kết quả không có giá trị thực tế
```

**Nguyên tắc vàng:** VU pool nên được set ở mức **hợp lý** — phản ánh resource thực tế bạn sẵn sàng allocate. Nếu test pass với pool hợp lý, hệ thống thực sự OK. Nếu test fail, bạn có hai lựa chọn:
1. Tăng resource (tăng VU pool, tăng server capacity)
2. Tối ưu hệ thống (giảm event duration)

**Công thức tham khảo cho "hợp lý":**
```
preAllocatedVUs ≈ expected_concurrent_VU × 2
maxVUs ≈ expected_concurrent_VU × 3 đến 5

Với case 05:
expected_concurrent_VU (mean) = 14 × 0.0485 ≈ 1
preAllocatedVUs hợp lý: 2-5
maxVUs hợp lý: 10-20

→ Với config này, test SẼ fail → đó là tín hiệu ĐÚNG
→ Hệ thống cần optimization, không phải cần thêm VU
```

**NL5 dạy bạn rằng:** Đừng dùng VU pool khổng lồ để "mua" pass. Pass đạt được bằng cách đó không có giá trị. Mục tiêu của performance test không phải là pass, mà là hiểu được capacity và giới hạn thực sự của hệ thống.

---

## 15. Checklist — Async-specific checks

### 15.1 Pre-run checklist

Trước khi chạy test:

- [ ] **Xác nhận async flow đúng:** POST → wait → GET, với identity tracking (job ID)
- [ ] **Xác nhận weighted branching:** dashboard 70%, async_job 30% (hoặc tỷ lệ mong muốn)
- [ ] **Xác nhận READY_AFTER_MS:** giá trị phản ánh đúng async processing time thực tế
- [ ] **Xác nhận preAllocatedVUs:** đủ để cover expected concurrent VU ở rate thấp nhất
- [ ] **Xác nhận maxVUs:** đủ cao để không artificially limit test (nhưng không quá cao gây lãng phí resource)
- [ ] **Xác nhận stages:** tổng scheduled iterations khớp với tính toán diện tích
- [ ] **Tags được set đúng:** branch, step, job_id (nếu cần)
- [ ] **Custom metrics (nếu có):** async_e2e_duration trend được define và sử dụng
- [ ] **Backend server sẵn sàng:** POST /api/sim/report/jobs và GET /api/sim/report/jobs/:id hoạt động
- [ ] **Không có rate limiting trên server** có thể ảnh hưởng đến kết quả

### 15.2 During-run checks (nếu dùng cloud output hoặc dashboard real-time)

- [ ] **VU count đang tăng?** Nếu không, allocation có vấn đề
- [ ] **Dropped iterations > 0?** Nếu có, test sẽ fail — có thể dừng sớm để điều chỉnh
- [ ] **http_req_duration ổn định?** Nếu tăng đột biến, server có thể đang overload
- [ ] **Iteration duration của async có ổn định ~150ms không?** Nếu tăng, server chậm hoặc sleep không chính xác

### 15.3 Post-run checklist

#### Primary (quyết định pass/fail)

- [ ] **dropped_iterations == 0?** Nếu không → FAIL. Đây là check quan trọng nhất.
- [ ] **iterations completed ≈ total scheduled?** Nếu không → có drops. Xác nhận số khớp.

#### Secondary (diagnostics)

- [ ] **checks == 100%?** Nếu không → kiểm tra response validation logic
- [ ] **http_req_failed == 0%?** Nếu không → kiểm tra HTTP errors (5xx, timeout, connection)
- [ ] **http_req_duration p95 < threshold?** Nếu không → server có thể overload hoặc network issue
- [ ] **iteration_duration của async ≈ expected (READY_AFTER_MS + HTTP time)?** Nếu cao hơn → investigate
- [ ] **vus_max < maxVUs?** Nếu == maxVUs → pool đã chạm ceiling, consider tăng maxVUs
- [ ] **HTTP call count reconciliation:** async_job http_reqs ≈ 2 × async iterations
- [ ] **Branch ratio đúng?** async_job iterations / total iterations ≈ 30%

#### Advanced

- [ ] **VU spin-up time:** Thời gian từ lúc VU=1 đến lúc VU đạt steady state
- [ ] **Rate threshold:** Rate mà tại đó drops bắt đầu xuất hiện
- [ ] **Tail latency analysis:** P99, P99.9 của iteration_duration cho async branch
- [ ] **Correlation:** http_req_duration có tăng khi VU count tăng không? (dấu hiệu server overload)

### 15.4 CI/CD integration checklist

```yaml
# Ví dụ: GitHub Actions threshold check
- name: k6 test
  run: k6 run rar-05-report-ingress-ramp.js --summary-export=summary.json

- name: Verify pass criteria
  run: |
    DROPS=$(jq '.metrics.dropped_iterations.values.count' summary.json)
    if [ "$DROPS" -gt 0 ]; then
      echo "FAIL: dropped_iterations = $DROPS"
      exit 1
    fi
    echo "PASS: dropped_iterations = 0"
```

---

## 16. 4–5 Variations

### 16.1 Variation 1: All-fast (READY_AFTER_MS=0)

**Mô tả:** Async job xử lý instantaneous (0ms wait). Về cơ bản, async branch trở thành sync 2-step HTTP.

**Config:**
```
READY_AFTER_MS=0
```

**Dự đoán:**
- iteration_duration async: ~10ms (5ms POST + 5ms GET)
- W_effective = 0.7×5ms + 0.3×10ms = 6.5ms
- VU cần: ceil(14 × 0.0065) = 1 VU
- drops: 0 → PASS

**Bài học:** Khoảng cách giữa "async" và "sync" nằm ở wait time. Không có wait time, async flow không khác gì multi-step sync flow.

---

### 16.2 Variation 2: All-slow (READY_AFTER_MS=1000)

**Mô tả:** Async job rất chậm (1 giây wait). Mô phỏng heavy report generation.

**Config:**
```
READY_AFTER_MS=1000
```

**Dự đoán:**
- iteration_duration async: ~1010ms
- W_effective = 0.7×5ms + 0.3×1010ms = 3.5ms + 303ms = 306.5ms
- VU cần (mean): ceil(14 × 0.3065) = ceil(4.29) = 5 VU
- Nhưng với clustering: có thể cần 10-20 VU
- drops: có thể > 100 → FAIL nặng

**Bài học:** Wait time càng dài, VU requirement càng cao — và tăng phi tuyến do clustering.

---

### 16.3 Variation 3: High async weight (async=70%, dashboard=30%)

**Mô tả:** Đảo ngược tỷ lệ branch — phần lớn traffic là async job.

**Config:**
```
Branch weight: dashboard=30%, async_job=70%
```

**Dự đoán:**
- W_effective = 0.3×5ms + 0.7×150ms = 1.5ms + 105ms = 106.5ms
- VU cần (mean): ceil(14 × 0.1065) = ceil(1.49) = 2 VU (lý thuyết)
- Async jobs/s: 14 × 0.7 = 9.8/s
- Concurrent async (mean): 9.8 × 0.150 = 1.47 VU
- Nhưng với 9.8 async/s, clustering nghiêm trọng hơn → có thể cần 60-80 VU
- drops: dự đoán 50-100 → FAIL nặng hơn case gốc

**Bài học:** Async weight là multiplier cho VU requirement. Tăng async weight từ 30% lên 70% → drops tăng ~2-3x.

---

### 16.4 Variation 4: Steeper ramp (peak 28/s)

**Mô tả:** Gấp đôi peak rate. Traffic ramp nhanh hơn, peak cao hơn.

**Config:**
```
stages: [
  { duration: "10s", target: 12 },
  { duration: "15s", target: 28 },
  { duration: "10s", target: 8 },
]
```

**Dự đoán:**
- Async jobs/s ở peak: 28 × 0.3 = 8.4/s
- Concurrent async (mean): 8.4 × 0.150 = 1.26 VU
- Với clustering: có thể cần 100+ VU
- drops: dự đoán 100-200 → FAIL thảm họa

**Bài học:** Peak rate tăng gấp đôi → drops tăng hơn gấp đôi (có thể gấp 4-5 lần). Đây là hậu quả của bimodal distribution: khi rate tăng, xác suất async cluster tăng theo cấp số mũ.

---

### 16.5 Variation 5: Two-scenario split (dashboard + async riêng)

**Mô tả:** Tách dashboard và async job thành hai scenario riêng trong cùng một test. Dashboard dùng constant-arrival-rate, async job dùng ramping-arrival-rate với VU pool riêng.

**Config:**
```javascript
scenarios: {
  dashboard_reads: {
    executor: 'ramping-arrival-rate',
    startRate: 2, timeUnit: '1s',
    preAllocatedVUs: 5, maxVUs: 10,
    stages: [
      { duration: '10s', target: 4 },
      { duration: '15s', target: 10 },
      { duration: '10s', target: 3 },
    ],
    exec: 'dashboard',
  },
  async_jobs: {
    executor: 'ramping-arrival-rate',
    startRate: 1, timeUnit: '1s',
    preAllocatedVUs: 20, maxVUs: 80,  // Pool riêng cho async
    stages: [
      { duration: '10s', target: 2 },
      { duration: '15s', target: 4 },
      { duration: '10s', target: 1 },
    ],
    exec: 'asyncJob',
  },
}
```

**Dự đoán:**
- Dashboard scenario: pass dễ dàng (event duration 5ms, rate thấp)
- Async job scenario: vẫn có thể fail nhưng dễ diagnose hơn vì metrics tách biệt
- Tổng drops = drops của cả hai scenario

**Bài học:** Tách scenario cho phép fine-tune VU pool cho từng loại traffic. Dashboard không cần nhiều VU, async job cần nhiều. Allocation hiệu quả hơn.

---

## 17. Anti-patterns (mở rộng)

### 17.1 Anti-pattern 1: "Checks pass là test pass"

**Sai lầm:** Nhìn vào output thấy `checks: 100.00%`, kết luận test pass.

**Tại sao sai:** Trong open model, checks chỉ xác nhận logic của những iteration đã chạy. Những iteration bị drop không có cơ hội để check — và chúng là failure thực sự.

**Cách đúng:**
1. Check `dropped_iterations` TRƯỚC
2. Nếu `dropped_iterations > 0` → test FAIL (dừng ở đây)
3. Chỉ khi `dropped_iterations == 0` mới xét đến checks

**Code pattern đúng:**
```javascript
// Trong post-processing script
const drops = results.metrics.dropped_iterations.values.count;
if (drops > 0) {
  console.error(`FAIL: ${drops} iterations were dropped`);
  process.exit(1);
}
// Chỉ check tiếp nếu không có drops
if (results.metrics.checks.values.passes < results.metrics.checks.values.total) {
  console.error('FAIL: some checks did not pass');
  process.exit(1);
}
console.log('PASS');
```

---

### 17.2 Anti-pattern 2: "Tăng maxVUs đến khi hết drop"

**Sai lầm:** Thấy drops → tăng maxVUs. Vẫn drops → tăng tiếp. Lặp lại đến khi hết drops hoặc maxVUs = 1000.

**Tại sao sai:**
- Đây là "chữa triệu chứng", không phải "chữa bệnh"
- Không scale: mỗi lần tăng arrival rate hoặc async weight, lại phải tăng maxVUs
- VU không miễn phí: mỗi VU tiêu tốn memory và CPU trên load generator
- Có thể che giấu vấn đề thực sự (async processing quá chậm)

**Cách đúng:**
1. Xác định iteration_duration của async branch
2. Tính W_effective dựa trên weight
3. Estimate VU cần dùng queueing model (không chỉ Little's Law mean)
4. Set preAllocatedVUs và maxVUs dựa trên estimate + buffer hợp lý (20-30%)
5. Nếu vẫn drops: investigate TẠI SAO iteration_duration cao
6. Giải pháp gốc rễ: giảm iteration_duration (tối ưu async processing), không phải tăng VU

---

### 17.3 Anti-pattern 3: "Dùng http_req_duration để estimate VU"

**Sai lầm:** Lấy http_req_duration trung bình (~5ms) × arrival rate (14/s) = cần 0.07 VU → set preAllocatedVUs=5 cho "an toàn".

**Tại sao sai:** http_req_duration không bao gồm sleep/wait time. Trong async scenario, sleep chiếm phần lớn thời gian iteration (140/150 = 93%).

**Cách đúng:**
- Dùng `iteration_duration` metric (có sẵn trong k6 output)
- Hoặc tự tính: `http_req_duration_sum + sleep_time + script_overhead`
- Với case này: iteration_duration async = 150ms, không phải 5ms

---

### 17.4 Anti-pattern 4: "Refuse to accept that a test with zero HTTP errors can fail"

**Sai lầm:** Developer từ chối tin rằng test fail khi tất cả HTTP requests đều 200 OK. "Hệ thống vẫn hoạt động tốt, chỉ là k6 không đủ VU thôi."

**Tại sao sai:**
- "k6 không đủ VU" không phải là vấn đề của k6 — nó là tín hiệu cho thấy hệ thống không thể xử lý traffic với rate yêu cầu
- Trong production, "không đủ VU" tương đương với "không đủ server capacity"
- User không quan tâm lỗi là do "server chậm" hay "không đủ resource" — họ chỉ biết request của họ không được phục vụ
- Open model test chính xác là để phát hiện capacity gap này

**Cách đúng:**
- Accept rằng `dropped_iterations > 0` là failure thực sự
- Coi nó như capacity warning: "với traffic pattern này, hệ thống cần X VU; hiện tại chỉ có Y; thiếu Z"
- Dùng kết quả để capacity planning: hoặc tăng resource, hoặc tối ưu code, hoặc điều chỉnh SLA

---

### 17.5 Anti-pattern 5: "Bỏ qua dropped_iterations vì 'chỉ có vài iteration bị drop thôi'"

**Sai lầm:** drops=5 trên 280 iterations (1.8%) → "1.8% drop rate là chấp nhận được" → bỏ qua.

**Tại sao sai:**
- 1.8% drop rate hôm nay có thể là 5% ngày mai (khi traffic tăng)
- Drop rate thường tăng phi tuyến với arrival rate: 1.8% ở 14/s có thể thành 10% ở 16/s
- Mỗi iteration bị drop đại diện cho một user không được phục vụ
- Nếu 1.8% là chấp nhận được, phải ghi rõ trong SLA — không được âm thầm bỏ qua

**Cách đúng:**
- Set threshold rõ ràng: "dropped_iterations / total_iterations < 0.1%"
- Nếu drops > threshold: INVESTIGATE, không ignore
- Nếu drops < threshold: document rằng đây là rủi ro đã biết và được chấp nhận
- Theo dõi trend: drop rate có tăng theo thời gian không?

---

### 17.6 Anti-pattern 6: "So sánh http_req_duration của async và sync branch"

**Sai lầm:** "http_req_duration của async_job cũng ~5ms, giống dashboard → async không chậm hơn sync."

**Tại sao sai:** http_req_duration chỉ đo từng HTTP call riêng lẻ. Nó không đo:
- Thời gian giữa POST và GET (sleep/wait)
- Tổng thời gian user phải chờ để có kết quả cuối cùng
- Chi phí VU utilization

**Cách đúng:** So sánh `iteration_duration`, không phải `http_req_duration`. Hoặc dùng custom metric `async_e2e_duration` đo từ POST đến khi GET trả về kết quả.

---

### 17.7 Anti-pattern 7: "Dùng chung một VU pool lớn cho mọi scenario"

**Sai lầm:** Tất cả scenario dùng chung một VU pool (trong trường hợp test có nhiều scenario). "Pool càng lớn càng tốt."

**Tại sao sai:**
- Scenario nhanh (dashboard, 5ms) bị ảnh hưởng bởi scenario chậm (async, 150ms)
- Khi async jobs cluster, chúng chiếm hết VU → dashboard reads cũng bị drop (dù dashboard không cần nhiều VU)
- Khó diagnose: không biết drops đến từ scenario nào

**Cách đúng:**
- Mỗi scenario có VU pool riêng, được cấu hình dựa trên đặc thù của scenario đó
- Scenario dashboard: preAllocatedVUs thấp (5-10), maxVUs thấp (20)
- Scenario async: preAllocatedVUs cao (30-50), maxVUs cao (100+)
- Tổng VU = sum của từng pool — kiểm soát được

---

### 17.8 Anti-pattern 8: "Dùng sleep() để mô phỏng wait nhưng không tính đến variance"

**Sai lầm:** Dùng `sleep(140)` (hằng số) để mô phỏng async processing time. Không có variance.

**Tại sao sai:**
- Trong thực tế, async processing time có variance: đôi khi 50ms, đôi khi 500ms
- Sleep hằng số tạo ra event duration đồng nhất → dễ predict, dễ pass
- Test với sleep hằng số không phản ánh được tail latency thực tế
- Kết quả: test pass với sleep(140) nhưng production fail vì P99 thực tế là 500ms

**Cách đúng:**
```javascript
// Thay vì sleep hằng số:
sleep(140);

// Dùng sleep với variance:
const waitTime = Math.random() * 200 + 40;  // 40ms đến 240ms
sleep(waitTime);

// Hoặc dùng phân phối thực tế hơn:
// 80% jobs complete trong 100-150ms
// 15% jobs complete trong 150-300ms
// 5% jobs complete trong 300-1000ms
const rand = Math.random();
let waitTime;
if (rand < 0.80) waitTime = 100 + Math.random() * 50;
else if (rand < 0.95) waitTime = 150 + Math.random() * 150;
else waitTime = 300 + Math.random() * 700;
sleep(waitTime);
```

**Bài học:** Variance của async processing time quan trọng không kém mean. Một hệ thống với mean=140ms nhưng P99=1000ms sẽ cần nhiều VU hơn rất nhiều so với hệ thống với mean=140ms và P99=160ms.

---

### 17.9 Anti-pattern 9: "Không kiểm tra iteration_duration của async branch riêng"

**Sai lầm:** Chỉ nhìn vào iteration_duration tổng (avg=52.3ms), kết luận "iteration nhanh, không có vấn đề".

**Tại sao sai:**
- iteration_duration tổng là weighted average của cả hai branch
- avg=52.3ms che giấu sự thật rằng async branch mất 150ms
- 70% dashboard iterations (5ms) kéo mean xuống → tạo cảm giác an toàn giả
- Khi rate tăng, async branch mới là bottleneck — và mean tổng không cảnh báo được

**Cách đúng:** Luôn group iteration_duration theo branch tag:

```javascript
// Trong post-processing:
// iteration_duration{ branch="dashboard" } → avg=5ms, p95=7ms
// iteration_duration{ branch="async_job" }  → avg=150ms, p95=160ms
```

Hoặc dùng custom metric cho từng branch:
```javascript
const dashboardTrend = new Trend('dashboard_iteration_duration', true);
const asyncJobTrend = new Trend('async_job_iteration_duration', true);
```

**Bài học:** Trong multi-branch scenarios, không dùng mean tổng. Luôn drill down vào từng branch. Bimodal distribution nguy hiểm ở chỗ mean có thể nằm giữa hai modes và không đại diện cho bất kỳ mode nào.

---

## 18. Reference

### 18.1 Code references

| File | Mô tả |
|------|-------|
| `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-ingress-ramp.js` | Script chạy case 05 (hypothetical reference) |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-*.js` | Case tương đương trong constant-arrival-rate series |

### 18.2 K6 documentation references

| Document | Relevance |
|----------|-----------|
| k6 Ramping Arrival Rate executor docs | Reference cho cấu hình stages, preAllocatedVUs, maxVUs |
| k6 Open vs Closed Model | Giải thích sự khác biệt giữa arrival-rate (open) và VU-based (closed) executors |
| k6 Metrics: dropped_iterations | Định nghĩa và ý nghĩa của dropped_iterations metric |
| k6 Tags best practices | Hướng dẫn sử dụng tags, cardinality considerations |

### 18.3 Concepts referenced

| Concept | Áp dụng trong case này |
|---------|----------------------|
| **Little's Law (L = λW)** | Dùng để estimate VU requirement cơ bản: VU = arrival_rate × iteration_duration. Case này cho thấy giới hạn của Little's Law với bimodal distribution. |
| **Open Model / Closed Model** | Case này là open model (ramping-arrival-rate). Khác biệt cốt lõi: iteration đến theo schedule, không phụ thuộc VU availability. |
| **Bimodal Distribution** | Event duration có 2 modes: ~5ms (dashboard) và ~150ms (async). Mean không đại diện cho cả hai mode. |
| **Queueing Theory (M/G/c)** | Với bimodal service time, standard M/M/c không áp dụng. Cần M/G/c hoặc simulation để estimate chính xác VU requirement. |
| **VU Pool Exhaustion** | Khi tất cả VU đều bận và iteration mới đến → dropped_iterations. Đây là failure mode chính của case. |
| **Tail Latency** | P95, P99 của iteration_duration quan trọng hơn mean trong async scenario. Tail latency quyết định VU peak requirement. |
| **Arrival Clustering** | Iteration đến ngẫu nhiên, đôi khi nhiều async job đến liên tiếp → VU requirement spike. |
| **Identity Model** | Job ID dùng để xâu chuỗi POST và GET trong async flow. Cần thiết cho verification và tracing. |

### 18.4 Cross-series references

| Case | Series | Liên quan |
|------|--------|-----------|
| car-05 | constant-arrival-rate | Async job pattern giống hệt. car-05 giữ constant rate, case này dùng ramp. Cả hai đều dạy về VU pool exhaustion với async. |
| rar-01 đến rar-04 | ramping-arrival-rate | Các case sync HTTP. Dùng để contrast: sync không bị VU bottleneck ở rate tương đương. |
| rar-05 (case này) | ramping-arrival-rate | Case duy nhất trong series có async wait. THE failing case. |

### 18.5 Key takeaways

1. **dropped_iterations là THE pass/fail signal trong open model.** Không có ngoại lệ.
2. **event_duration bao gồm sleep/wait**, không chỉ http_req_duration. Dùng iteration_duration để capacity planning.
3. **Async pattern "đắt" hơn sync rất nhiều về VU.** Case 05 (14/s, async) cần nhiều VU hơn case 01 (28/s, sync).
4. **Bimodal event duration làm cho mean estimation không đáng tin cậy.** Cần xem xét tail behavior.
5. **Tăng VU pool giúp nhưng không phải silver bullet.** Giải pháp gốc rễ là giảm async wait time.
6. **Tách scenario (dashboard riêng, async riêng)** cho phép fine-tune VU allocation và dễ diagnose hơn.
7. **CI/CD phải check dropped_iterations.** Nếu không, open model test mất đi giá trị cốt lõi của nó.

---

> **Tổng kết:** Case 05 — Report Ingress Ramp là case dạy học trung tâm của series ramping-arrival-rate. Nó phơi bày giới hạn của open model khi gặp async pattern: arrival rate độc lập với VU availability, nhưng event duration (bao gồm wait) giữ VU lâu hơn HTTP response time. Kết quả: dropped_iterations > 0 dù checks=100% và http_req_failed=0%. Nếu bạn chỉ nhớ một điều từ case này, hãy nhớ: **dropped_iterations is the truth. Everything else is commentary.**

---

*Document generated for k6 ramping-arrival-rate practice series. Case 05 of 05+.*
