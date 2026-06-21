# Case 04: Checkout Surge Ingress

## Tình huống thực tế

Checkout/order intake tăng đột biến khi promotion bắt đầu. Đây là tình huống production
kinh điển: team marketing mở campaign 12:00, hệ thống checkout bắt đầu nhận traffic tăng
dần từ 1 checkout/s lên 5 checkout/s trong 15 giây đầu, đạt peak 10 checkout/s trong 15
giây tiếp theo, rồi hạ nhiệt về 2 checkout/s sau 10 giây cuối. Tổng cộng 40 giây — nhưng
40 giây này quyết định doanh thu của cả campaign.

Dù rate thấp hơn browse (case 01 ramping-arrival-rate có thể lên 28/s), mỗi checkout
event có external latency cao (payment gateway simulation ~40ms, order confirm ~20ms)
và multi-step flow (create checkout → confirm order). Team cần biết order service có xử
lý được checkout surge không khi external dependency ngốn VU.

### Câu hỏi business

```text
Order service có xử lý được checkout surge với rate biến thiên 1→5→10→2 trong 40s không?
Mỗi checkout event có 2 API calls + external latency 40ms + 20ms.
Dù peak chỉ 10/s (thấp hơn case 01 peak 28/s), external latency khiến VU demand cao hơn.
Liệu preAllocatedVUs=12 có đủ giữ intake toàn bộ 3 stage?
```

Đây là case dạy bài học quan trọng nhất của toàn bộ pack ramping-arrival-rate:
**peak rate thấp không đồng nghĩa cần ít VU** nếu mỗi event giữ VU lâu vì external
latency. Đây là "nghịch lý low-rate-high-VU" — một hiện tượng mà team production
thường xuyên bỏ sót khi sizing.

### Vì sao case này quan trọng với production?

```text
Tình huống thường gặp ở production:
  - Team nhìn peak checkout = 10/s, nghĩ "thấp, pool 5 VU là dư"
  - Setup ramping-arrival-rate với preAllocatedVUs=5, maxVUs=15
  - Deploy lên production
  - External payment gateway bắt đầu chậm ở stage peak (p95 tăng từ 40ms lên 200ms)
  - W_effective tăng từ 65ms lên ~225ms
  - required_vus_min tăng từ 1 lên ceil(10 × 0.225) = 3
  - NHƯNG với tail latency ở p99 (500ms), vài event kéo dài nửa giây
  - VU pool 5 cạn nhanh ở stage peak → dropped_iterations xuất hiện
  - Khách hàng thấy "checkout failed" ngay lúc định mua → mất đơn

Bài học: peak rate thấp không cho phép bạn dùng pool nhỏ nếu mỗi event có external
latency. VU sizing tính theo lambda × W_effective, không phải lambda đơn thuần.
Và W_effective của checkout không phải ~5ms như browse — nó là ~65ms.
```

### So sánh nhanh với case 01 (ramping-arrival-rate high-rate browse)

| Thuộc tính | Case 01 (browse) | Case 04 (checkout surge) |
| --- | ---: | ---: |
| Peak rate | 28/s | 10/s |
| W_effective | ~5ms (1 GET) | ~65ms (2 POST + external) |
| required_vus_min (lt) | 1 | 1 |
| preAllocatedVUs | 15 | 12 |
| maxVUs | 40 | 35 |
| Tỉ lệ pre/peak_rate | 15/28 = 0.54 | 12/10 = 1.20 |
| Tỉ lệ capacity/peak_rate | ~107x | ~18x |
| Số step trong event | 1 | 2 |
| http_reqs/iterations | 1.0 | 2.0 |
| External dependency | Không | Có (payment gateway) |

→ Dù peak rate case 04 thấp hơn case 01 gần 3 lần, VU sizing lại aggressive hơn
(tỉ lệ pre/peak_rate gấp đôi). Đây là minh chứng cho "nghịch lý low-rate-high-VU".

## 2 yêu cầu cốt lõi

Case này có 2 yêu cầu cốt lõi, phải thỏa mãn đồng thời:

### Yêu cầu (a): SUSTAIN CHECKOUT SURGE SUỐT 3 STAGE (giữ intake biến thiên 1→5→10→2)

**Ý nghĩa**: Order service phải tiếp nhận checkout arrivals với rate biến thiên theo
3 stage — tăng dần, giữ peak, rồi giảm dần — không bị gián đoạn ở bất kỳ stage nào.
Đây là contract về **throughput đầu vào biến thiên theo thời gian**.

**Ví dụ cụ thể**:

```text
Scenario: Promotion checkout 12:00-12:00:40 (40 giây)

Stage 1 (ramp-up, 0-15s):    rate tăng từ 1/s → 5/s
  - Khách hàng bắt đầu nghe tin promotion, vào checkout dần
  - 15 giây đầu: ~45 arrivals (average rate ~3/s)

Stage 2 (peak, 15-30s):      rate tăng từ 5/s → 10/s
  - Đỉnh promotion, khách hàng ào vào checkout
  - 15 giây peak: ~112 arrivals (average rate ~7.5/s)

Stage 3 (ramp-down, 30-40s): rate giảm từ 10/s → 2/s
  - Hết promotion, checkout giảm dần
  - 10 giây cuối: ~60 arrivals (average rate ~6/s)

Tổng: ~218 arrivals trong 40s (average ~5.45/s)
Peak: 10/s ở cuối stage 2

Trường hợp A (giữ được intake):
  40s chạy: 218 arrivals scheduled, 218 iterations completed
  dropped_iterations = 0 ở mọi stage
  → Order service xử lý kịp mọi checkout arrival suốt surge
  → Không mất đơn hàng nào trong toàn bộ campaign

Trường hợp B (mất intake ở peak):
  40s chạy: 218 arrivals scheduled, 195 iterations completed
  dropped_iterations = 23 (tập trung ở stage 2 peak)
  → 23 checkout arrivals bị drop — tương đương 23 khách hàng thấy lỗi
  → Mất 23 × giá trị đơn hàng trung bình revenue, đúng lúc peak promotion
```

**Vì sao rate=10/s peak thấp nhưng vẫn khó giữ ở stage peak?**

```text
Peak rate = 10/s → mỗi 100ms có 1 arrival được scheduled

Nhưng mỗi arrival event cần:
  Step 1: POST checkout create (external_ms=40 → ~48ms tổng)
  Step 2: POST order confirm  (external_ms=20 → ~24ms tổng)
  → W_effective khoảng 65-75ms minimum happy path

Với W_effective = 70ms, 1 VU xử lý được 1/0.07 ≈ 14.3 events/s
→ Về lý thuyết, 1 VU dư sức cho 10/s peak (10/14.3 = 0.7 VU)

NHƯNG thực tế ở stage peak:
  - External latency không cố định — có tail (p95 có thể 120ms+)
  - Tại peak, external payment gateway bị áp lực → latency tăng
  - W_effective_p95 ≈ 145ms → required_vus ≈ ceil(10 × 0.145) = 2
  - Với W_effective_p99 ≈ 225ms → required_vus ≈ 3
  - Thêm CPU scheduling, network jitter, GC pause, VU spawn delay
  - preAllocatedVUs=12 là buffer an toàn cho stage peak
  - maxVUs=35 là headroom nếu external thực sự chậm
```

### Yêu cầu (b): ZERO DROPS DESPITE EXTERNAL LATENCY AT SURGE PEAK

**Ý nghĩa**: Dù external dependency (payment gateway simulation) có latency và dù
rate đang ở peak 10/s, không một checkout arrival nào được phép bị drop. Đây là
contract về **độ tin cậy tuyệt đối** cho checkout flow.

```text
Checkout là điểm quyết định mua hàng:
  - Browse bị drop → user refresh lại, ít thiệt hại
  - Search bị drop → user search lại
  - Checkout bị drop → user mất niềm tin, có thể bỏ đi hẳn
  - Mỗi drop ở stage peak = 1 khách hàng thấy lỗi ở bước cuối cùng,
    đúng lúc họ đã quyết định mua

→ maxDroppedIterations = 0 (contract cứng cho mọi stage)
```

**So sánh mức độ nghiêm trọng của drop giữa các case ramping-arrival-rate**:

| Case | Peak rate | Nghiệp vụ | maxDroppedIterations | Lý do |
| --- | ---: | --- | ---: | --- |
| case 01 (browse) | 28/s | Browse sản phẩm | 10 | browse có thể retry |
| case 02 (search) | 35/s | Search sản phẩm | 15 | search có thể retry |
| case 03 (cart write) | 15/s | Cart write intake | 5 | cart quan trọng hơn browse |
| **case 04 (checkout surge)** | **10/s** | **Checkout + order** | **0** | **checkout không được phép drop** |
| case 05 (report) | 8/s | Report API ingest | 0 | report data loss cũng zero-drop |

→ Checkout surge có peak rate thấp thứ hai trong series (chỉ trên report),
nhưng contract drop nghiêm ngặt nhất. Kết hợp với external latency cao, đây
là case "nguy hiểm thầm lặng" — nhìn rate thấp tưởng dễ, nhưng external
latency + zero-drop contract khiến nó là một trong những case khó pass nhất.

## Vì sao chọn `ramping-arrival-rate`?

### Bài toán: mô phỏng checkout surge thực tế với rate biến thiên

Checkout arrivals trong promotion có 3 đặc điểm mà chỉ ramping-arrival-rate mô phỏng đúng:

```text
1. ARRIVAL RATE BIẾN THIÊN THEO THỜI GIAN THỰC
   - Khách hàng không "chờ" server sẵn sàng mới checkout
   - Họ đến theo nhịp riêng (campaign, quảng cáo, organic)
   - Nhịp này TĂNG dần khi promo bắt đầu, ĐẠT PEAK, rồi GIẢM dần
   - Server phải THEO KỊP nhịp biến thiên đó
   - constant-arrival-rate chỉ giữ được rate phẳng, không ramp

2. MỖI ARRIVAL CÓ NHIỀU BƯỚC + EXTERNAL DEPENDENCY
   - Checkout create (gọi external payment gateway, ~40ms)
   - Order confirm (gọi external inventory service, ~20ms)
   - Mỗi bước có latency riêng, có thể fail độc lập
   - External latency có thể tăng ở stage peak do áp lực

3. VU POOL PHẢI ĐỦ GIỮ NHỊP Ở MỌI STAGE
   - Ở ramp-up: rate thấp, VU demand thấp → dư VU
   - Ở peak: rate cao + external có thể chậm → VU demand tăng
   - Ở ramp-down: rate giảm → VU demand giảm
   - Pool phải đủ cho stage khó nhất (peak)
```

### Bảng so sánh executor cho case checkout surge

| Executor | Giữ được rate biến thiên? | Phản ứng khi external chậm? | Verdict |
| --- | --- | --- | --- |
| **ramping-arrival-rate** | ✓ rate biến thiên theo stage, scheduler giữ nhịp từng giai đoạn | VU demand tăng, nếu pool đủ → không drop. Thấy được stage nào thiếu VU | ✅ DÙNG |
| constant-arrival-rate | ✗ rate cố định, không mô phỏng được surge shape | Không test được transition behavior giữa các stage | ❌ |
| ramping-vus | ✗ input là VU count, không phải arrival rate | Throughput tự động giảm khi external chậm, không phát hiện vấn đề | ❌ |
| constant-vus | ✗ VU phẳng, không có stage | Throughput tự giảm, không phát hiện vấn đề | ❌ |
| per-vu-iterations | ✗ không có khái niệm rate theo thời gian | Không mô phỏng được arrival pattern | ❌ |
| shared-iterations | ✗ count cố định, không có timeline | Không phân biệt được "đủ count" với "đủ rate theo stage" | ❌ |

### Vì sao KHÔNG dùng ramping-vus cho checkout surge?

Đây là điểm quan trọng nhất để phân biệt open model variable-rate và closed model
variable-concurrency:

```text
ramping-vus với startVUs=2, stages [{duration:"15s",target:8},{duration:"15s",target:18},{duration:"10s",target:2}]:
  Công thức throughput: rate = VUs / iter_time = 18 / 0.07 ≈ 257 iter/s ở peak
  → Rate này CAO HƠN RẤT NHIỀU so với 10/s target
  → Test sẽ "pass" dễ dàng, không phát hiện vấn đề gì

NHƯNG trong production thực tế:
  - External payment gateway không chạy 70ms mãi — có lúc 200ms, 500ms
  - Khi external chậm, iter_time tăng, throughput của ramping-vus GIẢM
  - Từ 18/0.07=257/s xuống 18/0.5=36/s → VẪN trên 10/s
  - Test ramping-vus không bao giờ thấy vấn đề!
  - Hơn nữa, ramping-vus đo "active users" không phải "arrivals/s"
  - Business hỏi: "Hệ thống chịu được 10 checkout/s không?"
  - Ramping-vus trả lời: "18 users checkout được X lần/s"
  - → Không trả lời đúng câu hỏi

Trong khi ramping-arrival-rate:
  - Rate intake LUÔN theo stage (scheduler ép)
  - Stage 1: 1→5/s, stage 2: 5→10/s, stage 3: 10→2/s
  - Khi external chậm, W_effective tăng → cần thêm VU
  - Nếu VU pool không đủ ở stage peak → dropped_iterations → TEST FAIL
  - → Test thật sự kiểm tra được năng lực của hệ thống ở từng stage
```

### Vì sao KHÔNG dùng constant-arrival-rate cho checkout surge?

```text
constant-arrival-rate với rate=10, duration=40s:
  - Rate 10/s phẳng suốt 40s → 400 arrivals
  - Không có ramp-up, không có ramp-down
  - Production reality: checkout bắt đầu từ 1/s, tăng dần lên 10/s
  - Nếu hệ thống fail ở ramp-up (không handle được transition 1→5/s)
    → constant-arrival-rate không phát hiện được vì nó bắt đầu ngay ở 10/s
  - Ngược lại, nếu hệ thống chỉ fail ở ramp-down (resource cleanup issue)
    → constant-arrival-rate cũng không thấy

ramping-arrival-rate:
  - Stage 1: 1→5/s — test ramp-up behavior
  - Stage 2: 5→10/s — test peak behavior
  - Stage 3: 10→2/s — test ramp-down behavior
  → Test được TOÀN BỘ surge lifecycle
```

**Kết luận**: Chỉ ramping-arrival-rate mới mô phỏng đúng bản chất của checkout
surge: arrivals đến theo nhịp biến thiên theo thời gian thực, server phải theo kịp
ở mọi stage, và external latency là biến số ảnh hưởng đến VU demand — đặc biệt
nguy hiểm ở stage peak.

## Mapping business -> k6 config

### Source script (hypothetical reference)

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-04-checkout-surge-ingress.js
```

Script dùng helper `buildRampingArrivalScenario('checkoutSurgeIngress', ...)`.

### Default config và ý nghĩa từng tham số

| Field | Value | Ý nghĩa | Vì sao giá trị này? |
| --- | ---: | --- | --- |
| `executor` | `ramping-arrival-rate` | Open model, variable rate theo stage | Bắt buộc để giữ rate biến thiên |
| `startRate` | `1` | Bắt đầu với 1 arrival mỗi timeUnit | Baseline thấp trước khi surge |
| `timeUnit` | `1s` | Target = arrivals/s | Time unit chuẩn cho rate |
| `stages[0]` | `{duration:"15s", target:5}` | Ramp-up: 1→5/s trong 15s | Khách bắt đầu vào checkout |
| `stages[1]` | `{duration:"15s", target:10}` | Peak: 5→10/s trong 15s | Đỉnh promotion |
| `stages[2]` | `{duration:"10s", target:2}` | Ramp-down: 10→2/s trong 10s | Hạ nhiệt sau promotion |
| `preAllocatedVUs` | `12` | Worker khởi tạo sẵn | Buffer cho external latency (peak 10/s × 65ms) |
| `maxVUs` | `35` | Trần worker được mở thêm | Headroom nếu external latency spike ở peak |
| `maxDroppedIterations` | `0` | Không chấp nhận drop | Checkout là business-critical |

### Stage math chi tiết

```text
Stage 1 (ramp-up): duration=15s, rate 1→5/s
  Average rate = (1 + 5) / 2 = 3/s
  Scheduled slots = 15 × 3 = 45 arrivals

Stage 2 (peak): duration=15s, rate 5→10/s
  Average rate = (5 + 10) / 2 = 7.5/s
  Scheduled slots = 15 × 7.5 = 112.5 ≈ 113 arrivals

Stage 3 (ramp-down): duration=10s, rate 10→2/s
  Average rate = (10 + 2) / 2 = 6/s
  Scheduled slots = 10 × 6 = 60 arrivals

Tổng scheduled slots = 45 + 112.5 + 60 = 217.5 ≈ 218 arrivals
Tổng duration = 15 + 15 + 10 = 40s
Average target rate = 218 / 40 = 5.45/s
Peak rate = 10/s (cuối stage 2)
```

### Timeline minh họa từng stage

```text
t=0s:     stage 1 bắt đầu, rate=1/s  — 1 arrival mỗi giây
t=5s:     rate ≈ 2.3/s                — đang ramp-up
t=10s:    rate ≈ 3.7/s                — đang ramp-up
t=14.9s:  rate ≈ 5/s                  — cuối stage 1
t=15s:    stage 2 bắt đầu, rate=5/s   — bắt đầu peak
t=22.5s:  rate ≈ 7.5/s                — giữa peak
t=29.9s:  rate ≈ 10/s                 — đỉnh peak
t=30s:    stage 3 bắt đầu, rate=10/s  — bắt đầu ramp-down
t=35s:    rate ≈ 6/s                  — đang ramp-down
t=39.9s:  rate ≈ 2/s                  — cuối stage 3
t=40s:    test kết thúc
```

### Vì sao preAllocatedVUs=12 dù peak rate chỉ 10/s?

Đây là câu hỏi trung tâm của case này. Phân tích sâu:

```text
Bước 1: Tính W_effective (thời gian 1 event giữ VU)
  Checkout create: cpu_ms=3 + db_writes=2 + external_ms=40 ≈ 48ms
  Order confirm:   cpu_ms=1 + db_writes=1 + external_ms=20 ≈ 24ms
  Overhead (HTTP, JSON parse, k6 internal): ~3-5ms
  → W_effective ≈ 70ms (happy path)

  Nhưng với tail latency ở stage peak (external chịu áp lực):
  W_effective_p95 ≈ 145ms (external_ms=120 thay vì 40)
  W_effective_p99 ≈ 225ms (external_ms=200 thay vì 40)

Bước 2: Tính required_vus_min theo Little's Law
  Ở happy path (W_effective=70ms):
    required_vus_min = ceil(peak_rate × W_effective)
                     = ceil(10 × 0.070)
                     = ceil(0.7)
                     = 1 VU

  Ở p95 tail (W_effective=145ms):
    required_vus_min = ceil(10 × 0.145) = ceil(1.45) = 2 VU

  Ở p99 tail (W_effective=225ms):
    required_vus_min = ceil(10 × 0.225) = ceil(2.25) = 3 VU

Bước 3: Vậy sao cần 12 VU?
  3 VU chỉ đủ trong điều kiện:
    - External latency phân phối đúng như mô hình
    - Không có network jitter
    - k6 scheduler hoàn hảo, không delay
    - Không có cold start, GC pause

  Thực tế ở stage peak:
    - External latency có thể SPIKE TOÀN BỘ (không chỉ tail)
    - Khi payment gateway chậm, TẤT CẢ request đều chậm
    - Nếu external_ms tăng lên 200ms toàn bộ: W_effective ≈ 230ms
      → required_vus = ceil(10 × 0.230) = 3 VU → vẫn ổn
    - Nhưng nếu external_ms = 500ms: W_effective ≈ 530ms
      → required_vus = ceil(10 × 0.530) = 6 VU
    - Nếu external_ms = 1000ms (extreme): W_effective ≈ 1030ms
      → required_vus = ceil(10 × 1.030) = 11 VU → gần chạm preAllocatedVUs=12

Bước 4: So sánh với case 01 (browse, peak 28/s)
  Case 01: W_effective ≈ 5ms, required_vus_min = ceil(28 × 0.005) = 1
           preAllocatedVUs=15 → capacity dư 15/0.005 = 3000 events/s
           Dư 3000/28 = 107x → cực kỳ an toàn

  Case 04: W_effective ≈ 70ms, required_vus_min = ceil(10 × 0.070) = 1
           preAllocatedVUs=12 → capacity dư 12/0.070 = 171 events/s
           Dư 171/10 = 17x → an toàn nhưng ít hơn case 01 nhiều

  → Dù case 04 peak rate thấp hơn case 01, headroom capacity thấp hơn 6.3 lần
    (107x vs 17x). Đây là lý do case 04 cần được thiết kế VU pool cẩn thận hơn.

Bước 5: maxVUs=35 cho extreme cases
  Nếu external dependency có đợt chậm cực đoan (p99=800ms):
    W_effective ≈ 830ms
    required_vus = ceil(10 × 0.830) = 9 VU → vẫn trong preAllocatedVUs

  Nếu TẤT CẢ request đều 800ms (không chỉ tail):
    required_vus = 9 VU → preAllocatedVUs=12 vẫn đủ

  Nhưng nếu external_ms = 3000ms (mất kết nối, timeout):
    required_vus = ceil(10 × 3.030) = 31 VU
    → Vượt preAllocatedVUs=12
    → k6 spawn thêm VU lên đến maxVUs=35
    → maxVUs=35 đủ cho kịch bản extreme này
```

**Công thức tổng quát cho VU sizing với surge**:

```text
required_vus_stage(s) = ceil(average_rate_s × W_effective_p95)

Stage 1: average_rate = 3/s,  W_effective_p95 ≈ 145ms
  → required_vus = ceil(3 × 0.145) = 1

Stage 2: average_rate = 7.5/s, W_effective_p95 ≈ 145ms
  → required_vus = ceil(7.5 × 0.145) = 2

Stage 3: average_rate = 6/s,  W_effective_p95 ≈ 145ms
  → required_vus = ceil(6 × 0.145) = 1

→ Về lý thuyết, 2 VU là đủ
→ NHƯNG preAllocatedVUs=12 để:
    1. Có sẵn worker, không cần spawn khi test bắt đầu
    2. Hấp thụ tail latency ở stage peak mà không drop
    3. Cho phép external latency tăng gấp 5-7 lần vẫn an toàn
    4. Headroom cho stage transition (VU allocation during rate change)
```

**Bài học**: VU sizing cho ramping-arrival-rate không dựa trên peak rate đơn
thuần. Nó dựa trên `max_stage(average_rate × W_effective_p95)`. Khi W_effective
lớn (external latency), dù rate thấp vẫn cần VU pool đáng kể. Và quan trọng
nhất: pool phải được tính cho stage khó nhất (thường là stage peak).

## Phân tích nguyên nhân gốc kỹ thuật (5 RC)

### RC1: Low peak rate không đồng nghĩa low VU demand — external latency dominates sizing

**Phát biểu**: `peak rate=10/s` thấp hơn case 01 (28/s), nhưng `preAllocatedVUs=12`
gần bằng case 01 (preAllocatedVUs=15). Nghịch lý này đến từ W_effective của
checkout gấp ~14 lần browse, khiến VU demand ở stage peak cao hơn tưởng tượng.

**So sánh trực tiếp giữa các case ramping-arrival-rate**:

| Case | Peak rate | preAllocatedVUs | W_effective | required_vus_min (lt) | Tỉ lệ pre/peak_rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| case 01 (browse) | 28/s | 15 | ~5ms | 1 | 0.54 |
| case 02 (search) | 35/s | 18 | ~5ms | 1 | 0.51 |
| case 03 (cart) | 15/s | 13 | ~8ms | 1 | 0.87 |
| **case 04 (checkout)** | **10/s** | **12** | **~70ms** | **1** | **1.20** |
| case 05 (report) | 8/s | 20 | ~150ms | 2 | 2.50 |

→ Tỉ lệ `preAllocatedVUs / peak_rate` của case 04 là 1.20, gấp 2.2 lần case 01
(0.54). Nguyên nhân: **W_effective của checkout gấp ~14 lần browse**.

**Trace minh họa**:

```text
Case 01 (browse, 1 GET request, ~5ms):
  t=0ms:    arrival slot #0 → VU #1 nhận, gửi GET /api/sim/products
  t=5ms:    response 200, VU #1 freed
  t=35ms:   arrival slot #1 → VU #1 (đã freed) nhận tiếp
  → 1 VU xử lý được 1/0.005 = 200 events/s
  → Với peak 28/s: cần 28/200 = 0.14 VU → 1 VU dư 14x

Case 04 (checkout, 2 POST requests, ~70ms tổng):
  t=0ms:    arrival slot #0 → VU #1 nhận, gửi POST checkout (external_ms=40)
  t=48ms:   checkout response 200, gửi POST confirm (external_ms=20)
  t=72ms:   confirm response 200, VU #1 freed
  t=100ms:  arrival slot #1 → VU #1 (vừa freed) nhận tiếp
  → 1 VU xử lý được 1/0.072 ≈ 13.9 events/s
  → Với peak 10/s: cần 10/13.9 = 0.72 VU → 1 VU dư 1.4x

Với 12 VU:
  Case 01: 12 × 200 = 2400 events/s capacity (peak 28/s → dư 85x)
  Case 04: 12 × 13.9 = 167 events/s capacity (peak 10/s → dư 16.7x)

→ Case 04 dư ít hơn 5 lần về mặt tỉ lệ
→ Với external latency spike ở stage peak, buffer này dễ bị ăn mòn
```

**Công thức tổng quát cho VU sizing**:

```text
capacity = preAllocatedVUs / W_effective
headroom_ratio = capacity / peak_rate

Case 01: capacity = 15/0.005 = 3000/s, headroom = 3000/28 = 107x
Case 04: capacity = 12/0.070 = 171/s, headroom = 171/10 = 17x

→ Case 04 headroom thấp hơn 6.3 lần

Khi external latency tăng gấp 5 (W_effective=350ms) ở stage peak:
  Case 04 capacity = 12/0.350 = 34.3/s
  headroom = 34.3/10 = 3.4x → vẫn đủ nhưng mỏng hơn nhiều

Khi external latency tăng gấp 15 (W_effective=1050ms):
  Case 04 capacity = 12/1.050 = 11.4/s
  headroom = 11.4/10 = 1.14x → nguy hiểm, cận kề drop
  → Lúc này maxVUs=35 mới phát huy tác dụng
```

### RC2: Multi-step event — checkout create → order confirm sequential, amplification factor = 2

**Phát biểu**: Mỗi arrival event không phải 1 API call mà là 2 API calls tuần tự
(checkout create + order confirm). Điều này tạo ra **amplification factor = 2**
cho http_reqs, và **sequential dependency** — nếu step 1 fail, step 2 có thể
không chạy hoặc chạy với dữ liệu không hợp lệ.

**Flow tuần tự trong code (hypothetical)**:

```js
export function checkoutSurgeIngress(data) {
  const started = Date.now();
  const ctx = userContext(data.seed, USER_POOL);
  const productId = ((ctx.iter * 11) % 50) + 1;
  const orderId = `RAR-ORDER-${ctx.requestKey}`;
  let ok = true;

  // ───── Step 1: Checkout Create ─────
  const checkout = requestJson('POST',
    `${BASE_URL}/api/sim/checkout?cpu_ms=3&db_writes=2&external_ms=40&external_fail_rate=0`,
    { payment_method: 'card', items: [{ id: productId, qty: 1 }] },
    { caseId: CASE_ID, service: 'order-service', operation: 'checkout_surge_create',
      endpoint: 'POST /api/sim/checkout', userId: ctx.userId,
      headers: { 'Idempotency-Key': `rar04-checkout-${ctx.requestKey}` } }
  );
  ok = ok && checkout.ok;

  // ───── Step 2: Order Confirm ─────
  const confirm = requestJson('POST',
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=1&db_writes=1&external_ms=20&external_fail_rate=0`,
    {},
    { caseId: CASE_ID, service: 'order-service', operation: 'checkout_surge_confirm',
      endpoint: 'POST /api/sim/orders/:id/confirm', userId: ctx.userId,
      headers: { 'Idempotency-Key': `rar04-confirm-${ctx.requestKey}` } }
  );
  ok = ok && confirm.ok;

  finishEvent(started, ok, { caseId: CASE_ID, service: 'order-service',
    operation: 'checkout_surge_event', userId: ctx.userId });
}
```

**Trace execution cho 1 arrival event ở stage peak**:

```text
[Event #142, VU #7]
  t=25200ms: scheduler gán slot #142 → VU #7 bắt đầu checkoutSurgeIngress()
  t=25201ms: userContext() → userId=arrival-user-343, requestKey=seed-142-7
  t=25202ms: Step 1: POST /api/sim/checkout (external_ms=40)
             → body: {payment_method:'card', items:[{id:12,qty:1}]}
             → header: Idempotency-Key=rar04-checkout-seed-142-7
  t=25250ms: Step 1 response: 200 OK (~48ms)
             → ok = true
  t=25251ms: Step 2: POST /api/sim/orders/RAR-ORDER-seed-142-7/confirm (external_ms=20)
             → header: Idempotency-Key=rar04-confirm-seed-142-7
  t=25275ms: Step 2 response: 200 OK (~24ms)
             → ok = true
  t=25276ms: finishEvent() → ramping_arrival_events_total += 1
             ramping_arrival_event_duration_ms = 76ms
  t=25277ms: VU #7 freed, sẵn sàng nhận slot mới
```

**Amplification factor qua từng stage**:

```text
1 iteration = 1 arrival event = 1 lần chạy checkoutSurgeIngress()
1 iteration → 2 API calls (nếu cả 2 step đều chạy)
→ http_reqs = iterations × 2 (happy path)
→ ramping_arrival_api_calls_total = iterations × 2 (happy path)

Với ~218 slots:
  Stage 1 (45 slots):  expected http_reqs = 45 × 2 = 90
  Stage 2 (113 slots): expected http_reqs = 113 × 2 = 226
  Stage 3 (60 slots):  expected http_reqs = 60 × 2 = 120
  Tổng expected http_reqs = 218 × 2 = 436
```

**Khi step 1 fail ở stage peak**:

```text
Nếu checkout create fail (status != 200):
  ok = false sau step 1
  Step 2 vẫn chạy (không có early return trong code pattern trên)
  → http_reqs vẫn = iterations × 2
  → Nhưng ramping_arrival_events_failed tăng

Nếu code có early return sau step 1 fail:
  Step 2 không chạy
  → http_reqs < iterations × 2
  → Đây là dấu hiệu cascade failure ở stage peak
  → Đặc biệt nguy hiểm nếu chỉ xảy ra ở stage peak (external quá tải)
```

**Stage-specific amplification risk**:

```text
Stage 1 (ramp-up, rate thấp):
  - External latency bình thường, ít fail
  - http_reqs ≈ iterations × 2
  - Amplification ổn định

Stage 2 (peak, rate cao nhất):
  - External chịu áp lực cao nhất
  - Checkout create có thể fail nhiều hơn
  - Nếu có early return → http_reqs/iterations < 2.0
  - Nếu không có early return → http_reqs/iterations = 2.0 nhưng events_failed > 0

Stage 3 (ramp-down, rate giảm):
  - External hồi phục
  - http_reqs trở về ≈ iterations × 2
  - Nhưng events_failed có thể vẫn cao nếu system chưa recover
```

### RC3: Idempotency key pattern at surge peak — safe retry without duplicate orders

**Phát biểu**: Mỗi API call trong checkout flow đều gửi kèm header `Idempotency-Key`.
Pattern này đảm bảo nếu cùng request được gửi lại (do network retry, load balancer
retry, hoặc k6 internal retry), server không tạo duplicate order. Tại surge peak,
khi network có thể unstable, idempotency key là lớp bảo vệ data integrity.

**Vì sao cần idempotency key trong checkout surge?**

```text
Checkout là operation CÓ HIỆU ỨNG (tạo order, trừ tiền).
Nếu không có idempotency key trong lúc surge:

  Client gửi POST /api/sim/checkout → server nhận, xử lý, tạo order #789
  Response 200 bị mất trên đường về (network congestion ở peak)
  Client retry POST /api/sim/checkout → server tạo order #790 (DUPLICATE!)
  → Khách hàng bị trừ tiền 2 lần, có 2 order giống nhau
  → Ở stage peak (10 checkout/s), rủi ro này nhân lên 10 lần mỗi giây

Với idempotency key:

  Client gửi POST /api/sim/checkout
    Header: Idempotency-Key: rar04-checkout-seed-142-7
  Server nhận, tạo order, lưu key: rar04-checkout-seed-142-7 → order #789

  Response 200 bị mất → client retry với CÙNG key
  Server thấy key đã tồn tại → trả về kết quả của order #789
  → Không tạo duplicate
```

**Cấu trúc key trong case này**:

```text
Checkout create: Idempotency-Key: rar04-checkout-{requestKey}
                 = rar04-checkout-seed-142-7

Order confirm:   Idempotency-Key: rar04-confirm-{requestKey}
                 = rar04-confirm-seed-142-7

requestKey = {seed}-{iter}-{vuId}
           = seed-142-7
```

**Tại sao dùng 2 key khác nhau cho 2 step?**

```text
Nếu dùng chung 1 key cho cả checkout create và confirm:
  - Server thấy cùng key ở step 2 → tưởng là retry của step 1
  - Có thể từ chối confirm vì "đã xử lý" (idempotency reply)
  - Hoặc tệ hơn: ghi đè trạng thái order

Nên mỗi operation có prefix riêng:
  rar04-checkout-{requestKey}  → cho checkout create
  rar04-confirm-{requestKey}   → cho order confirm

Điều này cho phép:
  - Retry checkout create độc lập với confirm
  - Retry confirm độc lập với checkout create
  - Mỗi operation có idempotency scope riêng
```

**Idempotency key KHÔNG làm giảm latency — và đây là điểm quan trọng ở surge**:

```text
Idempotency key chỉ bảo vệ data integrity, không cải thiện performance.
Server vẫn phải check key (DB lookup hoặc cache lookup) → có thể thêm 1-2ms.

Ở stage peak (10/s):
  - 10 checkouts/s × 2 API calls × 1-2ms key lookup = 20-40ms/s overhead
  - Không đáng kể so với external latency (40ms + 20ms = 60ms)
  - Nhưng đáng giá vì bảo vệ khỏi duplicate order

Trade-off:
  Cost: thêm 1-2ms mỗi API call
  Benefit: zero duplicate order, an toàn retry
  → Luôn luôn xứng đáng cho checkout flow
```

**Idempotency key behavior qua các stage**:

```text
Stage 1 (ramp-up, rate thấp): 
  - Ít request, ít rủi ro network issue
  - Idempotency key vẫn hoạt động nhưng ít được "dùng đến"

Stage 2 (peak, rate cao):
  - Nhiều request, network có thể congested
  - Khả năng retry cao hơn → idempotency key phát huy tác dụng
  - Nếu không có key: duplicate order risk cao nhất ở stage này

Stage 3 (ramp-down, rate giảm):
  - Network ổn định trở lại
  - Nhưng các retry từ stage 2 có thể vẫn đang "trôi"
  - Idempotency key tiếp tục bảo vệ
```

### RC4: External latency tail at peak → VU demand spikes

**Phát biểu**: Khi external latency tăng (spike), mỗi event giữ VU lâu hơn.
Tại stage peak, rate đang cao nhất (10/s), nếu external latency đồng thời
spike, VU demand tăng đột biến. Nếu VU pool không đủ để bù, các slot mới
đến sẽ không có VU free → dropped_iterations.

**Cơ chế drop trong ramping-arrival-rate với surge**:

```text
Scheduler hoạt động theo timeline với rate biến thiên:

Stage 1 (ramp-up, 0-15s):
  t=0ms:    rate=1/s, slot #0 scheduled → tìm VU free → VU #1 → OK
  t=1000ms: rate≈1.13/s, slot #1 scheduled → VU #2 → OK
  ...
  → Rate thấp, VU pool dư nhiều, không drop

Stage 2 (peak, 15-30s):
  t=15000ms: rate=5/s, slot #45 scheduled → tìm VU free → OK
  t=15200ms: rate≈5.1/s, slot #46 scheduled → OK
  ...
  t=29000ms: rate≈10/s, slot #N scheduled → tìm VU free
             → Nếu external đang spike, 12 VU đều busy
             → KHÔNG CÓ VU FREE → dropped_iterations += 1
  → Rate cao + external chậm = VU demand spike

Stage 3 (ramp-down, 30-40s):
  t=30000ms: rate=10/s, slot #M scheduled → VU demand vẫn cao
  t=35000ms: rate≈6/s, slot #P scheduled → VU demand giảm dần
  ...
  → Rate giảm, VU demand giảm, hồi phục
```

**Mô phỏng external latency spike ở stage peak**:

```text
Bình thường (external_ms=40, W_effective≈72ms) ở stage peak (rate=10/s):
  Mỗi VU xử lý 1 event trong ~72ms
  Với 10 slots/s, cần 10 × 0.072 = 0.72 VU → 1 VU đủ
  Nhưng 12 VU pre-allocated → 11 VU idle

Khi spike nhẹ (external_ms=120, W_effective≈152ms) ở stage peak:
  Mỗi VU xử lý 1 event trong ~152ms
  Với 10 slots/s, cần 10 × 0.152 = 1.52 → 2 VU
  → Vẫn an toàn với 12 VU

Khi spike vừa (external_ms=300, W_effective≈332ms) ở stage peak:
  Cần 10 × 0.332 = 3.32 → 4 VU
  → Vẫn an toàn

Khi spike nặng (external_ms=800, W_effective≈832ms) ở stage peak:
  Cần 10 × 0.832 = 8.32 → 9 VU
  → Vẫn trong preAllocatedVUs=12
  → Nhưng headroom còn 3 VU — mỏng

Khi spike cực đoan (external_ms=2000, W_effective≈2032ms) ở stage peak:
  Cần 10 × 2.032 = 20.32 → 21 VU
  → Vượt preAllocatedVUs=12
  → k6 spawn thêm VU, lên đến maxVUs=35
  → Nếu spawn kịp → không drop
  → Nếu spawn không kịp → drop
```

**Bài toán sizing với tail latency ở stage peak**:

```text
Giả sử external_ms phân phối: avg=40ms, p95=120ms, p99=300ms

W_effective tương ứng ở stage peak:
  avg: 72ms   → capacity 12 VU = 12/0.072 = 167/s → headroom 16.7x
  p95: 152ms  → capacity 12 VU = 12/0.152 = 79/s  → headroom 7.9x
  p99: 332ms  → capacity 12 VU = 12/0.332 = 36/s  → headroom 3.6x

Với 5% request ở p95 (152ms) và 1% ở p99 (332ms) tại peak 10/s:
  Trung bình mỗi giây: 10 × 0.05 = 0.5 events ở p95, 10 × 0.01 = 0.1 events ở p99
  → 12 VU vẫn dư sức

Nhưng nếu external dependency có đợt "chậm toàn bộ" ở stage peak:
  100% request ở mức 300ms
  capacity = 12/0.332 = 36/s → headroom 3.6x → OK

  Nếu kéo dài 800ms toàn bộ:
  capacity = 12/0.832 = 14.4/s → headroom 1.44x → risky

  Nếu kéo dài 1500ms toàn bộ:
  capacity = 12/1.532 = 7.8/s → headroom 0.78x → DROP!
  → Lúc này maxVUs=35 mới phát huy tác dụng:
    capacity = 35/1.532 = 22.8/s → headroom 2.28x → an toàn
```

**Điểm khác biệt với case 01 (browse)**:

```text
Case 01 (browse, W_effective=5ms):
  - VU freed cực nhanh (5ms)
  - 15 VU → 3000 events/s capacity
  - External latency không tồn tại (không có external dependency)
  - → Gần như không bao giờ drop vì thiếu VU

Case 04 (checkout, W_effective=72ms):
  - VU freed chậm hơn 14 lần (72ms vs 5ms)
  - 12 VU → 167 events/s capacity
  - External latency là biến số quan trọng
  - → Có thể drop nếu external spike ở stage peak
```

### RC5: Event failure cascading tại stage peak — nếu create fails, confirm có thể bị skip

**Phát biểu**: Khi step 1 (checkout create) fail, step 2 (order confirm) có thể
không chạy, dẫn đến `http_reqs < iterations × 2`. Tại stage peak, nơi rate cao
nhất và external chịu áp lực lớn nhất, checkout create dễ fail nhất. Nếu cascade
xảy ra, http_reqs/iterations sẽ tụt xuống dưới 2.0 — đây là tín hiệu quan trọng
để phát hiện vấn đề ở tầng checkout create trong lúc surge.

**Cơ chế cascade trong code**:

```js
let ok = true;

const checkout = requestJson('POST', '.../checkout?...', ...);
ok = ok && checkout.ok;  // ok = false nếu checkout fail

const confirm = requestJson('POST', '.../confirm?...', ...);
// Code này KHÔNG check ok trước khi gọi confirm
// → confirm vẫn chạy dù checkout fail
ok = ok && confirm.ok;
```

**Phân tích 3 trường hợp qua các stage**:

```text
Trường hợp A: Checkout OK, Confirm OK (happy path, cả 3 stage)
  iterations = 218
  http_reqs = 436
  ramping_arrival_api_calls_total = 436
  ramping_arrival_events_failed = 0
  → Tỉ lệ http_reqs/iterations = 2.0
  → Healthy ở mọi stage

Trường hợp B: Checkout fail 10% ở stage peak, Confirm vẫn chạy
  iterations = 218
  http_reqs = 436 (vẫn 436 vì confirm vẫn chạy)
  ramping_arrival_api_calls_total = 436
  ramping_arrival_events_failed = 11 (10% của 113 slots ở stage peak)
  → Tỉ lệ http_reqs/iterations = 2.0 nhưng events_failed > 0
  → Dấu hiệu: checkout create đang fail nhưng không cascade

Trường hợp C: Checkout fail 10% ở stage peak, có early return (code sửa)
  iterations = 218
  Stage 1 (45 slots): 45 checkout + 45 confirm = 90
  Stage 2 (113 slots): 113 checkout + 102 confirm (11 skip) = 215
  Stage 3 (60 slots): 60 checkout + 60 confirm = 120
  http_reqs = 90 + 215 + 120 = 425
  → Tỉ lệ http_reqs/iterations = 425/218 = 1.95
  → DẤU HIỆU cascade: tỉ lệ < 2.0, tập trung ở stage peak
```

**Cách phát hiện cascade failure từ metrics theo stage**:

```text
Phân tích tổng thể:
  Nếu http_reqs < iterations × 1.8:
    → Ít nhất 20% event bị skip step 2
    → Check ramping_arrival_events_failed để xác nhận
    → Điều tra checkout create failures

Phân tích theo stage (nếu có timestamp hoặc tag stage):
  Stage 1: http_reqs ≈ iterations × 2 → OK
  Stage 2: http_reqs < iterations × 2 → cascade xảy ra ở peak
  Stage 3: http_reqs ≈ iterations × 2 → hồi phục
  → Kết luận: external không chịu được áp lực ở stage peak
  → Hành động: tăng external capacity hoặc giảm peak rate

Phân tích từ counter metrics:
  Nếu ramping_arrival_api_calls_total{operation="checkout_surge_create"} 
     > ramping_arrival_api_calls_total{operation="checkout_surge_confirm"}
  → Có event không chạy confirm
  → Chênh lệch = số event bị skip step 2
```

**Stage-specific cascade risk**:

```text
Stage 1 (ramp-up): 
  - Rate thấp (1→5/s), external load nhẹ
  - Checkout create ít fail → cascade risk thấp

Stage 2 (peak):
  - Rate cao (5→10/s), external load nặng nhất
  - Checkout create dễ fail nhất → cascade risk CAO NHẤT
  - Nếu cascade xảy ra, nó tập trung ở stage này

Stage 3 (ramp-down):
  - Rate giảm (10→2/s), external load giảm
  - Checkout create ít fail hơn → cascade risk giảm
  - Nhưng nếu system chưa recover từ stage 2, cascade có thể kéo dài
```

## Identity model deep-dive

### Bảng identity model

| Thuộc tính | Cách sinh | Gắn với gì? | Ý nghĩa |
| --- | --- | --- | --- |
| `__VU` | k6 tự động | VU instance | Worker ID, 1..N |
| `exec.vu.idInTest` | k6 tự động | VU instance | ID duy nhất của VU trong test |
| `exec.scenario.iterationInTest` | k6 tự động | Toàn test | Global arrival slot index (0, 1, 2, ...) |
| `exec.scenario.iterationInInstance` | k6 tự động | Scenario instance | Slot index trong scenario này |
| `userId` | `arrival-user-{N}` | Slot (không phải VU) | Identity của người dùng trong event này |
| `requestKey` | `{seed}-{iter}-{vuId}` | Slot + VU | Key duy nhất cho idempotency |

### Vì sao userId là "arrival-user-N" thay vì "vu-user-N"?

```text
Trong open model, KHÔNG CÓ quan hệ cố định giữa user và VU:
  - VU là anonymous worker, chỉ nhận slot từ scheduler
  - Slot #142 có thể được xử lý bởi VU #7 hoặc VU #12
  - User identity gắn với ARRIVAL SLOT, không gắn với VU

→ userId = `arrival-user-{slot_index}` 
  với slot_index = (iterationInTest % USER_POOL) + 1

So sánh với closed model (ramping-vus case 04):
  userId = `qa-user-{vuId}`
  → User identity gắn cố định với VU

Đây là khác biệt cơ bản giữa open model và closed model về identity.
Trong ramping-arrival-rate, "user" không phải là VU — user là arrival event.
```

### requestKey và tính duy nhất

```text
requestKey = `${seed}-${exec.scenario.iterationInTest}-${exec.vu.idInTest}`
           = "1718901234-142-7"

Tính duy nhất được đảm bảo bởi:
  - seed: unique per test run (Date.now())
  - iterationInTest: global counter, không lặp trong 1 run
  - vuIdInTest: unique per VU

→ requestKey là unique trong toàn bộ test run
→ Dùng làm cơ sở cho Idempotency-Key
```

### Idempotency key derivation

```text
rar04-checkout-{requestKey}  → Idempotency-Key cho checkout create
rar04-confirm-{requestKey}   → Idempotency-Key cho order confirm

Tại sao không dùng chung 1 key?
  - Mỗi operation cần idempotency độc lập
  - Nếu checkout create thành công, confirm thất bại → retry confirm với key riêng
  - Server phân biệt được "retry của checkout" vs "lần đầu của confirm"
  - Đặc biệt quan trọng ở stage peak: 2 operations có thể fail độc lập
```

### userPool mechanism

```text
USER_POOL = 500 (số lượng user identity trong pool)
userId = `arrival-user-${(iterationInTest % USER_POOL) + 1}`

Tại sao 500?
  - 218 slots trong 40s → cần tối đa 218 unique user
  - 500 > 218 → mỗi slot có user riêng, không reuse trong 1 run
  - Giả lập traffic từ 218-500 khách hàng khác nhau trong surge

Nếu USER_POOL < 218:
  - Một số user sẽ xuất hiện nhiều lần trong surge
  - Có thể gây race condition trên cùng user (cart, order)
  - → Không đúng với mô hình "mỗi checkout là khách hàng mới trong surge"
```

## Phân tích open model với surge — external latency impact ở từng stage

### So sánh ramping-vus vs ramping-arrival-rate khi external latency thay đổi

Đây là phần quan trọng nhất để hiểu vì sao open model variable-rate là công cụ
đúng cho checkout surge test.

**Scenario**: External payment gateway có latency tăng dần từ 40ms lên 400ms
ở stage peak.

**Bảng so sánh**:

| External latency | W_effective | ramping-vus (vus=18 at peak) throughput | ramping-arrival-rate (peak=10/s) behavior |
| ---: | ---: | --- | --- |
| 40ms (normal) | 72ms | 18/0.072 = 250/s | 10/s intake, VU usage ≈ 1, 11 idle |
| 100ms | 132ms | 18/0.132 = 136/s | 10/s intake, VU usage ≈ 2, 10 idle |
| 200ms | 232ms | 18/0.232 = 78/s | 10/s intake, VU usage ≈ 3, 9 idle |
| 400ms | 432ms | 18/0.432 = 42/s | 10/s intake, VU usage ≈ 5, 7 idle |
| 1000ms | 1032ms | 18/1.032 = 17.4/s | 10/s intake, VU usage ≈ 11, 1 idle |
| 2000ms | 2032ms | 18/2.032 = 8.9/s | 10/s intake, VU usage ≈ 21, spawn thêm 9 |
| 3000ms | 3032ms | 18/3.032 = 5.9/s | 10/s intake, VU usage ≈ 31, spawn thêm 19 |

**Phân tích**:

```text
ramping-vus (closed model):
  Khi external chậm, throughput GIẢM:
    250/s → 136/s → 78/s → 42/s → 17.4/s → 8.9/s → 5.9/s
  Test luôn "pass" vì không có khái niệm drop
  KHÔNG PHÁT HIỆN ĐƯỢC vấn đề: throughput 5.9/s vẫn trên target ảo
  → KHÔNG trả lời được câu hỏi "order service có xử lý ổn checkout surge không?"

ramping-arrival-rate (open model):
  Khi external chậm, VU demand TĂNG:
    1 VU → 2 VU → 3 VU → 5 VU → 11 VU → 21 VU → 31 VU
  Rate intake vẫn theo stage (scheduler ép)
  Nếu VU pool không đủ → dropped_iterations → TEST FAIL
  → PHÁT HIỆN ĐƯỢC vấn đề khi VU pool cạn
  → Trả lời được câu hỏi business
```

**Minh họa bằng số ở stage peak**:

```text
Tình huống: external_ms tăng lên 2000ms, W_effective ≈ 2032ms ở stage peak

ramping-vus với vus=18 ở peak:
  throughput = 18 / 2.032 = 8.9/s
  → Vẫn gần 10/s → "không có vấn đề"
  → Nhưng p95 event duration = 2032ms → người dùng chờ 2 giây!
  → Test ramping-vus KHÔNG CẢNH BÁO gì về UX

ramping-arrival-rate với peak=10/s, preAllocatedVUs=12:
  required_vus = ceil(10 × 2.032) = 21 VU (vượt 12)
  → k6 spawn thêm VU lên maxVUs=35
  → 10/s intake vẫn được giữ (nếu spawn kịp)
  → Nhưng p95 event duration = 2032ms → thấy được trên dashboard
  → Nếu threshold p95 = 500ms → TEST FAIL vì p95
  → Phát hiện được vấn đề UX dù intake vẫn đạt
```

### External latency impact theo từng stage

```text
Stage 1 (ramp-up, rate 1→5/s):
  - Rate thấp → ít áp lực lên external
  - External latency thường ổn định (avg=40ms, p95=120ms)
  - VU demand: 1-2 VU → dư nhiều
  - Risk: thấp

Stage 2 (peak, rate 5→10/s):
  - Rate tăng → external chịu áp lực tăng
  - External latency có thể tăng (avg=40→100ms, p95=120→300ms)
  - VU demand: 2-11 VU → bắt đầu dùng đến preAllocatedVUs
  - Risk: CAO NHẤT — đây là stage quyết định pass/fail

Stage 3 (ramp-down, rate 10→2/s):
  - Rate giảm → external áp lực giảm
  - External latency thường hồi phục
  - VU demand: giảm từ 11 về 1
  - Risk: thấp, nhưng cần quan sát recovery behavior
```

### Tại sao open model variable-rate PHẢI có VU pool dư?

```text
Trong closed model, VU pool size = concurrency target.
Trong open model, VU pool size = capacity để hấp thụ latency.

Với variable-rate (ramping-arrival-rate):
  - VU demand thay đổi theo stage
  - Stage peak cần nhiều VU nhất
  - preAllocatedVUs phải đủ cho stage peak
  - maxVUs là headroom cho stage peak + external spike đồng thời

Nếu VU pool vừa khít (preAllocatedVUs = required_vus_min):
  - Stage 1: OK (dư VU)
  - Stage 2: bắt đầu drop nếu external hơi chậm
  - Stage 3: OK trở lại
  - → Drop chỉ xảy ra ở stage peak → khó debug

→ preAllocatedVUs phải > required_vus_min của stage khó nhất
→ Tỉ lệ an toàn thường là 3-10x tùy criticality
→ Checkout surge case: 12 / 2 = 6x → an toàn vừa phải
→ Nếu external latency tăng mạnh, maxVUs=35 là cứu cánh
```

## Bảng service/API flow

### 2-step flow với request/response expectations

| Step | Method | Endpoint | Query Params | Request Body | Expected Status | Tags (operation) | Idempotency-Key |
| --- | --- | --- | --- | --- | ---: | --- | --- |
| 1 | POST | `/api/sim/checkout` | `cpu_ms=3&db_writes=2&external_ms=40&external_fail_rate=0` | `{payment_method, items: [{id, qty}]}` | 200 | `checkout_surge_create` | `rar04-checkout-{requestKey}` |
| 2 | POST | `/api/sim/orders/:id/confirm` | `cpu_ms=1&db_writes=1&external_ms=20&external_fail_rate=0` | `{}` | 200 | `checkout_surge_confirm` | `rar04-confirm-{requestKey}` |

### Chi tiết từng step

**Step 1 — Checkout Create**:

```text
Request:
  POST /api/sim/checkout?cpu_ms=3&db_writes=2&external_ms=40&external_fail_rate=0
  Headers:
    Content-Type: application/json
    X-Test-Suite: ramping-arrival-rate
    X-User-ID: arrival-user-343
    Idempotency-Key: rar04-checkout-seed-142-7
  Body: {
    "payment_method": "card",
    "items": [{"id": 12, "qty": 1}]
  }

Response (expected):
  HTTP 200 OK
  Body: { "order_id": "RAR-ORDER-seed-142-7", "status": "created", ... }

Latency breakdown:
  cpu_ms=3:       3ms (CPU xử lý business logic)
  db_writes=2:    2ms (INSERT order vào database)
  external_ms=40: 40ms (gọi external payment gateway)
  overhead:       ~3ms (HTTP, JSON parse)
  → Tổng ≈ 48ms
```

**Step 2 — Order Confirm**:

```text
Request:
  POST /api/sim/orders/RAR-ORDER-seed-142-7/confirm?cpu_ms=1&db_writes=1&external_ms=20&external_fail_rate=0
  Headers:
    Content-Type: application/json
    X-Test-Suite: ramping-arrival-rate
    X-User-ID: arrival-user-343
    Idempotency-Key: rar04-confirm-seed-142-7
  Body: {}

Response (expected):
  HTTP 200 OK
  Body: { "order_id": "RAR-ORDER-seed-142-7", "status": "confirmed", ... }

Latency breakdown:
  cpu_ms=1:       1ms
  db_writes=1:    1ms
  external_ms=20: 20ms (gọi external inventory service)
  overhead:       ~2ms
  → Tổng ≈ 24ms
```

### Event duration calculation

```text
event_duration = checkout_latency + confirm_latency + internal_overhead
               ≈ 48ms + 24ms + 5ms
               ≈ 77ms (happy path)

Với tail ở stage peak (p95 external_ms cao hơn):
  checkout_latency_p95 ≈ 3 + 2 + 120 = 125ms
  confirm_latency_p95  ≈ 1 + 1 + 60  = 62ms
  event_duration_p95   ≈ 125 + 62 + 5 = 192ms

Với extreme tail (p99, external_ms spike):
  checkout_latency_p99 ≈ 3 + 2 + 300 = 305ms
  confirm_latency_p99  ≈ 1 + 1 + 150 = 152ms
  event_duration_p99   ≈ 305 + 152 + 5 = 462ms
```

### Headers đầy đủ

| Header | Step 1 | Step 2 | Ý nghĩa |
| --- | ---: | ---: | --- |
| `Content-Type` | `application/json` | `application/json` | Body format |
| `X-Test-Suite` | `ramping-arrival-rate` | `ramping-arrival-rate` | Đánh dấu test suite |
| `X-User-ID` | `arrival-user-343` | `arrival-user-343` | User identity cho tracing |
| `Idempotency-Key` | `rar04-checkout-seed-142-7` | `rar04-confirm-seed-142-7` | Chống duplicate |

### Tags trên mỗi request

| Tag | Step 1 value | Step 2 value | Dùng cho metric nào? |
| --- | --- | --- | --- |
| `case_id` | `rar-04-checkout-surge-ingress` | `rar-04-checkout-surge-ingress` | Lọc theo case |
| `service` | `order-service` | `order-service` | Nhóm theo service |
| `operation` | `checkout_surge_create` | `checkout_surge_confirm` | Phân biệt operation |
| `endpoint` | `POST /api/sim/checkout` | `POST /api/sim/orders/:id/confirm` | Phân biệt endpoint |
| `user_id` | `arrival-user-343` | `arrival-user-343` | Trace user |
| `name` | `checkout_surge_create` | `checkout_surge_confirm` | Tên trên dashboard |

## Metrics & tags deep-dive

### Tất cả metrics trong case này

| Metric | Type | Tags | Ý nghĩa | Expected value |
| --- | --- | --- | --- | ---: |
| `ramping_arrival_events_total` | Counter | case_id, service, operation, user_id | Số event hoàn thành | 218 |
| `ramping_arrival_events_failed` | Counter | case_id, service, operation, user_id | Số event failed | 0 |
| `ramping_arrival_api_calls_total` | Counter | case_id, service, operation, endpoint, user_id | Số API calls đã gửi | 436 |
| `ramping_arrival_event_duration_ms` | Trend | case_id, service, operation, user_id | Thời gian hoàn thành event (ms) | p95 ~192ms |
| `dropped_iterations` | Counter | (k6 built-in) | Số slot bị drop | 0 |
| `iterations` | Counter | (k6 built-in) | Số iteration hoàn thành | 218 |
| `http_reqs` | Counter | (k6 built-in) | Số HTTP requests | 436 |
| `http_req_duration` | Trend | (k6 built-in) | HTTP request duration | p95 ~120ms |
| `http_req_failed` | Rate | (k6 built-in) | Tỉ lệ request fail | 0% |
| `checks` | Rate | (k6 built-in) | Tỉ lệ check pass | >99% |
| `vus` | Gauge | (k6 built-in) | Số VU active | 1-12 (có thể lên 35) |
| `vus_max` | Gauge | (k6 built-in) | Số VU max đã dùng | ≤35 |

### http_reqs = 2 x iterations là healthy signal

```text
Đây là case ĐẶC BIỆT: http_reqs gấp đôi iterations.

Người mới dễ nhầm:
  "http_reqs phải bằng iterations — mỗi iteration là 1 HTTP request"
  → SAI với case này

Đúng:
  "1 iteration = 1 checkoutSurgeIngress() = 2 API calls"
  → http_reqs = iterations × 2 là DẤU HIỆU KHỎE MẠNH
  → Nếu http_reqs < iterations × 2 → có step bị skip hoặc fail
```

**Bảng chẩn đoán từ tỉ lệ http_reqs/iterations**:

| Tỉ lệ | Ý nghĩa | Hành động |
| ---: | --- | --- |
| = 2.0 | Cả 2 step đều chạy ở mọi stage | Healthy |
| 1.9 - 2.0 | Một số event skip step 2 (chủ yếu ở stage peak) | Kiểm tra checkout create fail rate ở peak |
| 1.5 - 1.9 | Nhiều event skip step 2 | Điều tra nghiêm trọng, focus vào stage peak |
| 1.0 - 1.5 | Đa số event skip step 2 | External dependency crisis ở peak |
| < 1.0 | Thậm chí step 1 cũng skip | Lỗi code hoặc early return logic |
| > 2.0 | Có redirect hoặc extra requests | Kiểm tra code flow |

### http_reqs/iterations theo stage (phân tích nâng cao)

```text
Nếu metrics có tag stage hoặc timestamp đủ chi tiết:

Stage 1 (ramp-up):    http_reqs/iterations ≈ 2.0
Stage 2 (peak):       http_reqs/iterations có thể < 2.0 (nếu cascade)
Stage 3 (ramp-down):  http_reqs/iterations ≈ 2.0 (hồi phục)

Nếu chỉ stage 2 bị < 2.0:
  → External không chịu được áp lực peak
  → Cần tăng external capacity hoặc giảm peak rate

Nếu cả 3 stage đều < 2.0:
  → Vấn đề không liên quan đến surge
  → Có thể là code bug hoặc config sai
```

### ramping_arrival_events_failed < 5 (stricter threshold)

```text
Tại sao threshold là 5 chứ không phải 0?

Với 218 events:
  - 5 failures / 218 = 2.3% fail rate
  - Đây là threshold "cảnh báo sớm" — nếu 5 events fail, bắt đầu điều tra
  - Không đợi đến 10% mới alert

Trong production, threshold này có thể là:
  - 0 cho payment (tuyệt đối không fail)
  - < 5 cho checkout (cho phép vài event fail do network transient)
  - < 10 cho browse (có thể retry)

→ Case này dùng 5 vì checkout quan trọng nhưng không critical như payment
  (payment là case 05 với threshold = 0)
```

### Counter metric aggregation

```text
ramping_arrival_events_total:
  - Tăng 1 mỗi lần finishEvent() được gọi
  - Tagged với operation: 'checkout_surge_event'
  → Lọc được: events_total{operation="checkout_surge_event"}

ramping_arrival_api_calls_total:
  - Tăng 1 mỗi lần requestJson() được gọi (2 lần/event)
  - Tagged với operation: 'checkout_surge_create' và 'checkout_surge_confirm'
  → Lọc được: api_calls_total{operation="checkout_surge_create"} ≈ 218
              api_calls_total{operation="checkout_surge_confirm"} ≈ 218

ramping_arrival_event_duration_ms:
  - Ghi nhận thời gian từ start đến finishEvent()
  - Phân phối theo operation: 'checkout_surge_event'
  → p95, p99 cho toàn bộ event
```

## Pass criteria

### Bảng pass criteria mở rộng

| Check | Pass khi | Rationale | Mức độ |
| --- | --- | --- | --- |
| `dropped_iterations` | `count <= 0` | Checkout không được drop ở bất kỳ stage nào | CRITICAL |
| `ramping_arrival_events_failed` | `count < 5` | < 2.3% events fail | HIGH |
| `checks` | `rate > 0.99` | > 99% checks pass | HIGH |
| `http_req_failed` | `rate < 0.01` | < 1% HTTP errors | HIGH |
| `iterations` | gần 218 (±3) | Scheduled slots đều được thực hiện | MEDIUM |
| `http_reqs` | gần 436 (±6) | Cả 2 step đều chạy (~2× iterations) | MEDIUM |
| `http_reqs/iterations` | trong [1.95, 2.05] | Amplification factor ổn định | MEDIUM |
| `ramping_arrival_events_total` | = iterations | Mỗi iteration emit 1 event | MEDIUM |
| `ramping_arrival_api_calls_total` | ≈ http_reqs | Mỗi API call được đếm | MEDIUM |
| `vus_max` | ≤ 35 | Không vượt trần VU | LOW |
| `event_duration p95` | < 500ms | UX acceptable ở checkout | LOW |

### Vì sao p95 event duration không có trong pass criteria CRITICAL?

```text
Case này tập trung vào INTAKE CAPACITY (có drop không ở mọi stage),
không phải latency SLA.

Lý do:
  - Contract: "xử lý checkout surge 1→5→10→2/s, không drop" → focus vào throughput
  - External latency (40ms, 20ms) là simulated — không phải latency thật
  - p95 thực tế phụ thuộc vào external_ms config, không phải performance thật

Tuy nhiên, trong output→decision:
  - p95 vẫn được đọc để đánh giá UX
  - Nếu p95 > 500ms dù 0 drop → vấn đề UX (xem scenario D)
  - p95 được theo dõi riêng cho từng operation (checkout_create vs confirm)
```

### Pass criteria so sánh với case 01 (ramping-arrival-rate browse)

| Tiêu chí | Case 01 (browse) | Case 04 (checkout surge) | Lý do khác biệt |
| --- | ---: | ---: | --- |
| dropped_iterations | ≤ 10 | = 0 | Checkout critical hơn browse |
| events_failed | không có metric này | < 5 | Case 04 có business event tracking |
| iterations expected | 940 | ~218 | Case 01 peak 28/s, case 04 peak 10/s |
| http_reqs expected | ~940 (1× iterations) | ~436 (2× iterations) | Case 04 có amplification factor = 2 |
| http_reqs/iterations | 1.0 | 2.0 | Case 04 multi-step |
| p95 threshold | < 2000ms | không có (focus intake) | Case 01 latency test, case 04 capacity test |
| VU demand driver | rate | rate + external latency | Case 04 có external dependency |

## Cách chạy

### Local run với cloud output

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-04-checkout-surge-ingress.js"
```

### Env override cho các tham số

```powershell
# Override stage config (smoke test ngắn hơn)
$env:RAR_04_START_RATE = "1"
$env:RAR_04_TIME_UNIT = "1s"
$env:RAR_04_STAGE_1_DURATION = "10s"
$env:RAR_04_STAGE_1_TARGET = "3"
$env:RAR_04_STAGE_2_DURATION = "10s"
$env:RAR_04_STAGE_2_TARGET = "5"
$env:RAR_04_STAGE_3_DURATION = "5s"
$env:RAR_04_STAGE_3_TARGET = "1"

# Override VU pool (test áp lực VU)
$env:RAR_04_PREALLOCATED_VUS = "5"
$env:RAR_04_MAX_VUS = "15"

# Override external latency (mô phỏng external chậm)
# (phải sửa script để thêm env var cho external_ms)
$env:RAR_04_EXTERNAL_MS = "200"

# Override user pool
$env:RAR_04_USER_POOL = "300"
```

### Verify trên UI

```text
1. Mở http://localhost:13001
2. Paste student-token-1234567890
3. Click vào run mới nhất
4. Tile "iterations" hiển thị ~218 ✓
5. Tile "http_reqs" hiển thị ~436 ✓
6. Tile "dropped_iterations" hiển thị 0 ✓
7. Tile "checks" hiển thị 100% ✓
8. Tab Executor: xác nhận arrival rate shape theo 3 stage
```

### Cách đọc output khi mới chạy

```text
running (XX.Xs), 00/12 VUs, 218 complete and 0 interrupted iterations

  █ TOTAL RESULTS

    EXECUTION
    iterations.........: 218
    iteration_duration.: avg=77ms p(95)=192ms
    http_reqs..........: 436
    http_req_duration..: avg=35ms p(95)=120ms
    http_req_failed....: 0.00%
    checks_total.......: ~872 (2 checks/request × 436 requests)
    vus................: 1..12
    vus_max............: 12
    dropped_iterations.: 0

    CUSTOM METRICS
    ramping_arrival_events_total.......: 218
    ramping_arrival_events_failed......: 0
    ramping_arrival_api_calls_total....: 436
    ramping_arrival_event_duration_ms..: avg=77ms p(95)=192ms
```

## Phân tích output 5 bước

### Bước 1: Verify config [Header]

```text
Header in:    executor=ramping-arrival-rate, startRate=1, timeUnit=1s
Config có:    START_RATE=1, TIME_UNIT='1s' ✓

Header in:    stages=[{duration:"15s",target:5},{duration:"15s",target:10},{duration:"10s",target:2}]
Config có:    STAGE_1='15s,5', STAGE_2='15s,10', STAGE_3='10s,2' ✓

Header in:    preAllocatedVUs=12, maxVUs=35
Config có:    PREALLOCATED_VUS=12, MAX_VUS=35 ✓

Header in:    scenario name: checkoutSurgeIngress
Config có:    exec: 'checkoutSurgeIngress' ✓
```

### Bước 2: Tính expected slots cho từng stage [CT 1]

```text
Stage 1 (ramp-up, 0-15s):   rate 1→5/s
  avg_rate = (1 + 5) / 2 = 3/s
  slots = 15 × 3 = 45

Stage 2 (peak, 15-30s):     rate 5→10/s
  avg_rate = (5 + 10) / 2 = 7.5/s
  slots = 15 × 7.5 = 112.5 ≈ 113

Stage 3 (ramp-down, 30-40s): rate 10→2/s
  avg_rate = (10 + 2) / 2 = 6/s
  slots = 10 × 6 = 60

Tổng scheduled slots = 45 + 112.5 + 60 = 217.5 ≈ 218 arrivals
→ Expected iterations = 218 (nếu 0 drop, 0 interrupt)
```

### Bước 3: So sánh với N_done [CT 5]

```text
Summary cho:  iterations = 219
Dự kiến:      218
Tỷ lệ:        219 / 218 = 100.5% → hoàn hảo

Lệch +1 là bình thường:
  - k6 scheduler có thể schedule thêm 1 slot ở cuối nếu timing trùng
  - Hoặc timeUnit boundary tính khác một chút
  - Hoặc stage transition có rounding
  - ±1-2 slots so với expected là chấp nhận được
```

### Bước 4: Multi-step reconciliation (bước quan trọng nhất)

Đây là bước quan trọng nhất của case này — verify rằng cả 2 step đều chạy
và amplification factor = 2.0 được duy trì suốt 3 stage.

```text
Step 4a: Verify http_reqs = iterations × 2
  http_reqs = 438
  iterations × 2 = 219 × 2 = 438
  → 438 = 438 ✓
  → Tỉ lệ http_reqs/iterations = 438/219 = 2.0
  → Cả 2 step đều chạy cho mọi iteration ở mọi stage

Step 4b: Verify ramping_arrival_events_total = iterations
  ramping_arrival_events_total = 219
  iterations = 219
  → 219 = 219 ✓
  → Mỗi iteration emit đúng 1 event

Step 4c: Verify ramping_arrival_api_calls_total = http_reqs
  ramping_arrival_api_calls_total = 438
  http_reqs = 438
  → 438 = 438 ✓
  → Mỗi API call được đếm đúng

Step 4d: Verify dropped_iterations = 0
  dropped_iterations = 0 ✓
  → Không slot nào bị drop ở bất kỳ stage nào

Step 4e: Verify ramping_arrival_events_failed < 5
  ramping_arrival_events_failed = 0
  → 0 < 5 ✓
  → Không event nào fail

Step 4f: Verify VU usage pattern theo stage (nếu có stage metrics)
  Stage 1: VU usage thấp (1-2 VU) — rate thấp
  Stage 2: VU usage tăng (2-5 VU) — rate cao + external latency
  Stage 3: VU usage giảm (5→1 VU) — rate giảm
  → Pattern hợp lý: VU usage tỉ lệ với rate × latency
```

**Bảng reconciliation**:

| Metric | Expected | Actual | Match? |
| --- | ---: | ---: | --- |
| iterations | 218 | 219 | ✓ (±1) |
| http_reqs | 436 | 438 | ✓ (= 2×219) |
| ramping_arrival_events_total | 218 | 219 | ✓ (= iterations) |
| ramping_arrival_api_calls_total | 436 | 438 | ✓ (= http_reqs) |
| dropped_iterations | 0 | 0 | ✓ |
| ramping_arrival_events_failed | < 5 | 0 | ✓ |
| http_reqs / iterations | 2.0 | 2.0 | ✓ |

**Nếu không khớp — chẩn đoán**:

| Dấu hiệu | Nguyên nhân có thể | Hành động |
| --- | --- | --- |
| http_reqs < iterations × 2 | Step 2 bị skip (cascade) | Kiểm tra checkout create fail rate, đặc biệt ở stage peak |
| ramping_arrival_events_total < iterations | finishEvent không được gọi | Kiểm tra code path |
| ramping_arrival_api_calls_total < http_reqs | requestJson không emit metric | Kiểm tra common.js |
| dropped_iterations > 0 | VU pool không đủ ở stage peak | Tăng preAllocatedVUs hoặc maxVUs |
| ramping_arrival_events_failed >= 5 | Có event fail | Điều tra operation có fail, focus vào stage peak |
| http_reqs/iterations giảm ở stage peak | Cascade failure chỉ ở peak | External không chịu được áp lực peak |
| VU usage không giảm ở stage 3 | System không recover | Memory leak hoặc connection pool không release |

### Bước 5: Business conclusion

Từ kết quả run mẫu:

```text
iterations = 219 (expected 218) ✓
http_reqs = 438 (= 2 × 219) ✓
dropped_iterations = 0 ✓
ramping_arrival_events_failed = 0 ✓
ramping_arrival_event_duration_ms p95 = 192ms
http_reqs/iterations = 2.0 (ổn định suốt 3 stage)

KẾT LUẬN:
  - Order service giữ được checkout surge 1→5→10→2/s trong 40s
  - Không drop ở bất kỳ stage nào
  - Không event fail
  - p95 event duration = 192ms → acceptable UX cho checkout
  - Amplification factor = 2.0 ổn định → cả 2 step đều chạy
  - VU usage theo đúng pattern: tăng ở peak, giảm ở ramp-down
  - Hệ thống đạt contract checkout surge intake
  → PASS
```

## Dashboard 3-chart deep analysis

### Tổng quan dashboard cho case 04

Dashboard case 04 có 3 chart cần đọc trong tab Overview, cộng với tab Executor:

```text
1. Response time        — latency của từng operation (checkout_create vs confirm)
                          và sự thay đổi latency qua 3 stage
2. Execution timeline   — http_reqs/bucket và iterations/bucket qua surge
3. VUs vs iter/s        — VU usage và iteration throughput theo stage
4. Executor tab         — arrival rate shape biến thiên qua 3 stage
```

### Chart 1 — Response time (phân biệt checkout_create vs confirm, theo stage)

Chart này cho case 04 có ĐẶC ĐIỂM RIÊNG: cần đọc theo operation VÀ theo thời gian
để thấy latency thay đổi thế nào qua 3 stage.

**Các series cần đọc**:

```text
Theo operation:
  checkout_surge_create  — POST /api/sim/checkout (external_ms=40)
  checkout_surge_confirm — POST /api/sim/orders/:id/confirm (external_ms=20)
```

**Kỳ vọng**:

```text
checkout_surge_create:
  - avg: ~40-50ms (cpu_ms=3 + db_writes=2 + external_ms=40 ≈ 45ms)
  - p95: ~100-120ms (external_ms tail)
  - Stage 1: ổn định
  - Stage 2: có thể tăng nhẹ (external chịu áp lực)
  - Stage 3: trở về bình thường

checkout_surge_confirm:
  - avg: ~20-25ms (cpu_ms=1 + db_writes=1 + external_ms=20 ≈ 22ms)
  - p95: ~50-70ms
  - Thấp hơn checkout create vì external_ms nhỏ hơn (20ms vs 40ms)
  - Pattern theo stage tương tự checkout_create
```

**Đọc shape**:

```text
Shape đẹp:
  checkout_create p95 ~120ms, confirm p95 ~60ms
  Cả 2 ổn định suốt 40s, có thể tăng nhẹ ở stage peak
  Không có spike đột biến
  Khoảng cách giữa create và confirm ổn định (~60ms)

Shape xấu:
  checkout_create p95 tăng đột biến ở stage peak → external không chịu được áp lực
  confirm p95 tăng theo checkout_create → cascade latency
  Cả 2 cùng spike → vấn đề hệ thống (không chỉ external)
  Khoảng cách create-confirm giãn ra → external hoặc network bất thường
```

**Vì sao phải tách theo operation VÀ đọc theo thời gian?**

```text
Nếu không tách theo operation:
  - p95 aggregate = trộn checkout_create (~45ms) và confirm (~22ms)
  - Không thấy được sự khác biệt giữa 2 step
  - Không biết step nào là bottleneck

Nếu không đọc theo thời gian (stage):
  - Không thấy được latency tăng ở stage peak
  - Bỏ lỡ tín hiệu "external đang quá tải ở peak"
  - Không phân biệt được "latency bình thường" với "latency do surge"

Khi tách cả 2 chiều:
  - checkout_create luôn chậm hơn confirm → đúng (external_ms=40 > 20)
  - Nếu confirm chậm hơn checkout_create → BẤT THƯỜNG → điều tra
  - Nếu latency tăng rõ rệt ở stage 2 (peak) → external bottleneck
  - Nếu latency vẫn cao ở stage 3 → system chưa recover
```

### Chart 2 — Execution timeline (http_reqs/bucket = 2× iterations/bucket, thay đổi theo stage)

Đây là chart QUAN TRỌNG NHẤT để hiểu amplification factor và surge pattern.

**Kỳ vọng**:

```text
iterations/bucket: theo rate stage (tăng dần, peak, giảm dần)
http_reqs/bucket:  = 2 × iterations/bucket (amplification factor)
dropped_iterations = 0 (xuyên suốt)
```

**Bảng point mẫu (từ run mẫu)**:

| Time bucket | Stage | Live VUs | HTTP reqs | Iterations | Dropped | http_reqs/iter |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| bucket 1 (0-5s) | ramp-up | 12 | 12 | 6 | 0 | 2.0 |
| bucket 2 (5-10s) | ramp-up | 12 | 20 | 10 | 0 | 2.0 |
| bucket 3 (10-15s) | ramp-up | 12 | 30 | 15 | 0 | 2.0 |
| bucket 4 (15-20s) | peak | 12 | 40 | 20 | 0 | 2.0 |
| bucket 5 (20-25s) | peak | 12 | 52 | 26 | 0 | 2.0 |
| bucket 6 (25-30s) | peak | 12 | 60 | 30 | 0 | 2.0 |
| bucket 7 (30-35s) | ramp-down | 12 | 48 | 24 | 0 | 2.0 |
| bucket 8 (35-40s) | ramp-down | 12 | 24 | 12 | 0 | 2.0 |

**Verify**:

```text
1. iterations/bucket tăng dần trong stage 1:
     bucket 1: 6 → bucket 2: 10 → bucket 3: 15
     → Phản ánh rate 1→5/s ✓

2. iterations/bucket đạt max trong stage 2:
     bucket 6: 30 iterations/5s = 6/s average
     → Phản ánh rate 5→10/s (average 7.5/s cho toàn stage,
        nhưng trong bucket có thể thấy rate tăng dần) ✓

3. iterations/bucket giảm dần trong stage 3:
     bucket 7: 24 → bucket 8: 12
     → Phản ánh rate 10→2/s ✓

4. http_reqs/bucket luôn = 2 × iterations/bucket:
     → Amplification factor ổn định suốt 3 stage ✓

5. dropped_iterations = 0 ở mọi bucket:
     → Không drop ở bất kỳ stage nào ✓
```

**Pattern cần cảnh báo**:

| Pattern | Ý nghĩa | Hành động |
| --- | --- | --- |
| http_reqs/iter < 2.0 ở stage peak | Cascade failure ở peak | Điều tra checkout create fail rate |
| iterations/bucket phẳng ở stage 2 | Rate không tăng như config | Kiểm tra VU pool có đủ không |
| dropped_iterations > 0 ở stage 2 | VU pool cạn ở peak | Tăng preAllocatedVUs hoặc maxVUs |
| Live VUs tăng đột biến ở stage 2 | k6 spawn thêm VU | Bình thường nếu trong maxVUs, bất thường nếu vượt |

### Chart 3 — VUs vs iter/s (VU demand cao dù rate thấp)

Đây là chart thể hiện rõ nhất "nghịch lý low-rate-high-VU".

**Kỳ vọng**:

```text
VUs:
  - Stage 1: 1-3 VUs active (rate thấp)
  - Stage 2: 3-8 VUs active (rate cao + external latency)
  - Stage 3: giảm dần về 1-2 VUs
  - preAllocatedVUs=12 luôn có sẵn, nhưng không dùng hết
  - maxVUs=35 không cần chạm tới trong điều kiện bình thường

iter/s:
  - Stage 1: 1→5/s (theo ramp-up)
  - Stage 2: 5→10/s (theo peak)
  - Stage 3: 10→2/s (theo ramp-down)
```

**Đọc shape**:

```text
Shape đẹp:
  - iter/s theo đúng shape 3 stage (tăng → peak → giảm)
  - VUs tăng theo iter/s nhưng tỉ lệ VUs/iter_s thấp
    (vài VUs cũng handle được rate nhờ W_effective nhỏ)
  - Khoảng cách VUs vs iter/s ổn định

Shape đáng lo:
  - VUs tăng mạnh hơn iter/s (tỉ lệ VUs/iter_s tăng)
    → W_effective tăng (external chậm)
  - VUs chạm preAllocatedVUs=12 ở stage peak
    → Bắt đầu risky, sắp hết buffer
  - VUs vượt preAllocatedVUs → k6 đang spawn thêm
    → External đang rất chậm, cần điều tra
```

**So sánh VU pattern với case 01**:

```text
Case 01 (browse, peak 28/s, W_effective=5ms):
  - 1-2 VUs handle toàn bộ 28/s peak
  - 15 VUs pre-allocated → gần như toàn bộ idle
  - VUs/iter_s ≈ 2/28 = 0.07

Case 04 (checkout, peak 10/s, W_effective=72ms):
  - 3-5 VUs để handle 10/s peak (gấp 2-3 lần case 01 dù rate thấp hơn)
  - 12 VUs pre-allocated → dùng ~25-40%
  - VUs/iter_s ≈ 5/10 = 0.5 (gấp 7 lần case 01!)

→ Mặc dù case 04 rate thấp hơn ~3 lần,
  VU usage cao hơn 2-3 lần vì W_effective lớn hơn 14 lần
```

## 4 output -> decision scenarios

### Scenario A: Perfect pass — surge handled, 0 drops, http_reqs=2×iter

**Kết quả**:

```text
iterations = 218 (đúng scheduled slots)
http_reqs = 436 (= 2 × 218)
dropped_iterations = 0
ramping_arrival_events_failed = 0
http_req_failed = 0.00%
ramping_arrival_event_duration_ms p95 = 192ms
vus_max = 12 (không spawn thêm)
http_reqs/iterations = 2.0 (ổn định suốt 3 stage)
```

**Phân tích**:

```text
Đây là kết quả LÝ TƯỞNG:
  - Order service xử lý checkout surge hoàn hảo
  - Không drop ở bất kỳ stage nào
  - Không event fail
  - Amplification factor ổn định = 2.0
  - 12 preAllocatedVUs đủ dùng, không cần spawn thêm
  - External latency trong ngưỡng bình thường
  - p95 = 192ms → UX acceptable
```

**Hành động**:

```text
1. Ghi nhận capacity: hệ thống handle được checkout surge 1→5→10→2/s
2. Document preAllocatedVUs=12 là đủ cho external latency hiện tại
3. Thiết lập alert: nếu VUs vượt 12 → external đang chậm bất thường
4. Lên kế hoạch test định kỳ: chạy case này trước mỗi campaign lớn
5. Optional: test với external latency cao hơn để biết headroom thực sự
```

### Scenario B: Drops at peak — external latency consumes VU pool

**Kết quả**:

```text
iterations = 195 (thiếu 23 so với scheduled 218)
http_reqs = 390 (vẫn = 2 × iterations vì không có early return)
dropped_iterations = 23 (tập trung ở stage 2 peak)
ramping_arrival_events_failed = 0 (event nào chạy thì pass)
http_req_failed = 0.00%
ramping_arrival_event_duration_ms p95 = 850ms (external chậm)
vus_max = 35 (chạm maxVUs!)
http_reqs/iterations = 2.0
```

**Phân tích**:

```text
Đây là kết quả ĐÁNG BÁO ĐỘNG:
  - 23 drops ở stage peak (~10.5% của scheduled slots)
  - Tương đương 23 khách hàng thấy lỗi khi đang checkout
  - vus_max = 35: k6 đã spawn đến maxVUs mà vẫn không đủ
  - p95 = 850ms: external cực kỳ chậm ở stage peak
  - http_reqs/iterations vẫn = 2.0 → không có cascade
    (event nào được nhận thì chạy đủ 2 step)
```

**Nguyên nhân gốc**:

```text
External payment gateway bị quá tải ở stage peak:
  - Rate 10/s + external_ms tăng lên 800ms+
  - W_effective ≈ 832ms
  - required_vus = ceil(10 × 0.832) = 9 VU
  - NHƯNG tail latency có thể khiến required_vus lên 20-30 VU
  - maxVUs=35 đã dùng hết → không còn headroom
  - Drops xảy ra khi k6 không spawn kịp hoặc đã chạm trần
```

**Hành động**:

```text
1. Điều tra external payment gateway performance ở load 10/s:
   - Tại sao external_ms tăng lên 800ms?
   - Có phải external có rate limit?
   - Có phải connection pool cạn?

2. Cân nhắc các giải pháp:
   - Tăng maxVUs lên 50-80 (giải pháp tạm thời)
   - Thêm circuit breaker: nếu external quá chậm, fail fast thay vì treo VU
   - Async checkout: accept order, xử lý payment async
   - Queue checkout request thay vì xử lý đồng bộ

3. Setup alert: nếu p95 event duration > 500ms → cảnh báo sớm
4. Test lại sau khi fix external bottleneck
```

### Scenario C: Step-1 failures — http_reqs < 2×iter, checkout create failing

**Kết quả**:

```text
iterations = 218 (đủ scheduled slots)
http_reqs = 395 (thiếu 41 so với expected 436)
dropped_iterations = 0 (không drop slot)
ramping_arrival_events_failed = 41
http_req_failed = 9.4% (41/436)
ramping_arrival_event_duration_ms p95 = 120ms (vẫn nhanh)
vus_max = 12
http_reqs/iterations = 1.81 (< 2.0!)
```

**Phân tích**:

```text
Đây là kết quả CASCADE FAILURE:
  - 41 events failed (18.8% của 218)
  - http_reqs/iterations = 1.81 → step 2 bị skip ở 41 events
  - Tỉ lệ: 218 iterations, nếu 41 fail → 177 success
    → http_reqs expected nếu có early return: 
      218 (checkout) + 177 (confirm) = 395 ✓ khớp với actual
  - Không drop → VU pool đủ
  - p95 = 120ms → external latency bình thường
  - Vấn đề KHÔNG phải ở external latency mà ở checkout create logic
```

**Nguyên nhân gốc**:

```text
Checkout create đang fail không liên quan đến latency:
  - Có thể external_fail_rate > 0 (config sai)
  - Có thể validation error (body sai format)
  - Có thể race condition (trùng idempotency key)
  - Có thể database lock (db_writes conflict)
```

**Hành động**:

```text
1. Check external_fail_rate trong config — phải là 0
2. Check response body của failed checkout create requests
3. Filter metrics theo operation="checkout_surge_create" để xem pattern fail
4. Nếu fail tập trung ở stage peak: có thể race condition do rate cao
5. Nếu fail rải rác: có thể intermittent bug
6. Sửa code: nếu checkout create fail, nên có early return để không gọi confirm
   với orderId không hợp lệ
```

### Scenario D: p95 spike at peak — external dependency slow at surge

**Kết quả**:

```text
iterations = 218 (đủ scheduled slots)
http_reqs = 436 (= 2 × 218)
dropped_iterations = 0 (không drop)
ramping_arrival_events_failed = 0 (không fail)
http_req_failed = 0.00%
ramping_arrival_event_duration_ms p95 = 1200ms (CAO!)
ramping_arrival_event_duration_ms avg = 180ms
vus_max = 28 (spawn thêm 16 VUs)
http_reqs/iterations = 2.0
```

**Phân tích**:

```text
Đây là kết quả "PASS VỀ MẶT KỸ THUẬT nhưng FAIL VỀ MẶT UX":
  - Không drop, không fail → contract intake đạt
  - http_reqs/iterations = 2.0 → flow bình thường
  - NHƯNG p95 = 1200ms → 5% khách hàng chờ > 1 giây để checkout
  - avg = 180ms → đa số nhanh, nhưng tail rất dài
  - vus_max = 28 → k6 spawn thêm 16 VUs để hấp thụ tail
  - External latency có vấn đề ở tail (p95 external_ms có thể ~1000ms)
```

**Nguyên nhân gốc**:

```text
External payment gateway có tail latency dài:
  - 95% request nhanh (avg=180ms → W_effective ~180ms → external_ms ~140ms)
  - 5% request rất chậm (p95=1200ms → external_ms ~1160ms)
  - Nguyên nhân: GC pause, connection pool exhaustion, DB slow query
  - k6 spawn thêm VU đến 28 để bù → giữ được intake
  - Nhưng UX vẫn tệ cho 5% khách hàng
```

**Hành động**:

```text
1. Điều tra tail latency của external:
   - Log external_ms distribution
   - Check GC pattern của external service
   - Check connection pool config

2. Cân nhắc giải pháp:
   - Timeout cho external call (vd 500ms) → fail fast thay vì chờ 1200ms
   - Retry với exponential backoff
   - Fallback: nếu external quá chậm, queue order để xử lý sau

3. Setup SLO:
   - p95 < 500ms cho checkout event
   - p99 < 1000ms
   - Alert nếu vi phạm

4. Đây là case "false positive" — test pass intake nhưng UX fail
   → Cần thêm p95 threshold vào pass criteria cho production
```

## "Nghịch lý" (4)

### NL1: "Peak 10/s thấp nhất series nhưng preAllocatedVUs=12 cao hơn case 01 (peak 28/s, pre=15)"

```text
Thoạt nhìn: case 04 peak 10/s, preAllocatedVUs=12.
            case 01 peak 28/s, preAllocatedVUs=15.
            → Case 04 rate thấp hơn 2.8 lần nhưng VU chỉ ít hơn 20%.
            → Nghịch lý: rate thấp hơn mà VU pool gần bằng.

Giải thích:
  Tỉ lệ preAllocatedVUs / peak_rate:
    Case 01: 15/28 = 0.54 VUs cho mỗi arrival/s
    Case 04: 12/10 = 1.20 VUs cho mỗi arrival/s
    → Case 04 cần gấp 2.2 lần VU cho mỗi arrival/s

  Nguyên nhân: W_effective
    Case 01: 1 GET request, ~5ms → 1 VU xử lý 200 events/s
    Case 04: 2 POST requests + external, ~72ms → 1 VU xử lý 14 events/s
    → Case 04 mỗi VU xử lý ít hơn 14 lần events

  Kết luận: VU sizing = f(rate, W_effect), không phải f(rate) đơn thuần.
  Khi W_effect lớn, cần nhiều VU hơn cho cùng rate.
```

### NL2: "http_reqs gấp đôi iterations — không phải bug, là amplification factor"

```text
Thoạt nhìn: http_reqs = 436, iterations = 218.
            → http_reqs gấp đôi iterations.
            → Tưởng có bug (mỗi iteration gửi 2 request thay vì 1).

Giải thích:
  Đây không phải bug. Đây là amplification factor = 2.
  Mỗi arrival event có 2 step tuần tự:
    Step 1: POST checkout create
    Step 2: POST order confirm
  → 1 iteration = 2 HTTP requests (trong happy path)

  Đây là ĐẶC TRƯNG của multi-step business flow,
  không phải vấn đề của k6 hay test script.

  Khi http_reqs/iterations < 2.0 → MỚI LÀ VẤN ĐỀ
  → Có step bị skip, cần điều tra.
```

### NL3: "Rate=10/s nhưng capacity cần tính theo event duration, không phải request duration"

```text
Thoạt nhìn: Checkout create ~48ms, Order confirm ~24ms.
            → Mỗi request khá nhanh, tưởng không cần nhiều VU.

Giải thích:
  k6 scheduler quan tâm đến EVENT duration, không phải single request duration.
  Event duration = checkout_create + confirm + overhead ≈ 77ms.

  Trong 77ms đó, VU bị giữ — không thể nhận slot mới.
  → Capacity của 1 VU = 1 / event_duration = 1/0.077 ≈ 13 events/s.
  → Với peak 10/s, cần 10/13 ≈ 0.77 VU lý thuyết.

  Nhưng đây là minimum. Với tail latency:
  Event duration p95 ≈ 192ms
  → Capacity 1 VU = 1/0.192 ≈ 5.2 events/s
  → Với peak 10/s, cần 10/5.2 ≈ 2 VU ở p95.

  Và với external spike toàn bộ:
  Event duration ≈ 332ms
  → Capacity 1 VU = 1/0.332 ≈ 3 events/s
  → Với peak 10/s, cần 10/3 ≈ 4 VU.

  → preAllocatedVUs=12 không phải "dư thừa" mà là buffer cho event duration
    thay đổi theo external latency.
```

### NL4: "Idempotency key bảo vệ data nhưng không giảm latency — thậm chí còn thêm latency"

```text
Thoạt nhìn: Idempotency key là pattern bảo vệ data integrity.
            → Tưởng nó cũng giúp cải thiện performance (vd cache hit).

Giải thích:
  Idempotency key CHỈ bảo vệ data integrity:
    - Server phải LOOKUP key (DB hoặc cache) → thêm 1-2ms mỗi request
    - Nếu key đã tồn tại → trả về kết quả cũ (nhanh hơn, nhưng đây là retry case)
    - Nếu key mới → xử lý bình thường + lưu key (chậm hơn 1-2ms)

  → Idempotency key KHÔNG cải thiện latency cho happy path.
  → Nó thậm chí THÊM latency (1-2ms cho DB lookup).
  → Nhưng cost này nhỏ so với rủi ro duplicate order.

  Ở stage peak, khi retry có thể xảy ra:
    - Nếu không có idempotency key: retry → duplicate order → data corruption
    - Nếu có idempotency key: retry → cache hit → trả về kết quả cũ (nhanh hơn)
    → Trong trường hợp retry, idempotency key GIÚP giảm latency.

  Trade-off:
    Cost: +1-2ms mỗi request (happy path)
    Benefit: zero duplicate order + faster retry
    → Luôn xứng đáng cho checkout/payment flow.
```

## Checklist

### Pre-run checklist

- [ ] Script `rar-04-checkout-surge-ingress.js` tồn tại và dùng `buildRampingArrivalScenario`
- [ ] BASE_URL trỏ đến server đang chạy
- [ ] K6_CLOUD_HOST và K6_CLOUD_TOKEN được set
- [ ] Server `/api/sim/checkout` và `/api/sim/orders/:id/confirm` endpoints hoạt động
- [ ] External simulation params (cpu_ms, db_writes, external_ms, external_fail_rate) được config đúng
- [ ] preAllocatedVUs=12 và maxVUs=35 phù hợp với môi trường test
- [ ] Stage durations tổng = 40s (không quá ngắn để thấy pattern, không quá dài để lãng phí)

### Run-time checklist

- [ ] k6 start thành công, không có error lúc init
- [ ] Dashboard hiển thị run đang chạy
- [ ] Executor tab hiển thị "ramping-arrival-rate"
- [ ] Arrival rate chart hiển thị shape 3 stage (tăng → peak → giảm)
- [ ] VUs không vượt maxVUs=35

### Post-run checklist

- [ ] iterations ≈ 218 (±3)
- [ ] http_reqs ≈ 436 (±6)
- [ ] dropped_iterations = 0
- [ ] ramping_arrival_events_failed < 5
- [ ] http_req_failed < 1%
- [ ] checks > 99%
- [ ] http_reqs / iterations trong [1.95, 2.05]
- [ ] ramping_arrival_events_total = iterations
- [ ] ramping_arrival_api_calls_total = http_reqs
- [ ] vus_max ≤ 35
- [ ] Response time chart: checkout_create > confirm (bình thường)
- [ ] Execution timeline: shape 3 stage rõ ràng trên iterations/bucket
- [ ] VUs chart: tăng ở stage peak, giảm ở ramp-down

### Pass/fail decision checklist

- [ ] CRITICAL: dropped_iterations == 0 → nếu không, FAIL
- [ ] HIGH: ramping_arrival_events_failed < 5 → nếu không, điều tra
- [ ] HIGH: http_req_failed < 1% → nếu không, FAIL
- [ ] MEDIUM: http_reqs/iterations ≈ 2.0 → nếu < 1.9, điều tra cascade
- [ ] MEDIUM: iterations gần expected → nếu lệch > 10, điều tra
- [ ] LOW: vus_max ≤ 35 → nếu vượt, FAIL (vượt trần config)
- [ ] OPTIONAL: p95 event duration < 500ms → nếu vượt, xem scenario D

## Variations (5)

### Variation 1: External latency spike — test VU headroom

```text
Mục đích: Test xem preAllocatedVUs=12 và maxVUs=35 có đủ khi external chậm không.

Thay đổi:
  - Tăng external_ms từ 40ms lên 200ms (checkout create)
  - Tăng external_ms từ 20ms lên 100ms (order confirm)
  - Giữ nguyên rate shape 1→5→10→2

Dự kiến:
  - W_effective tăng từ ~72ms lên ~332ms
  - VU demand ở stage peak: ceil(10 × 0.332) = 4 VU → vẫn trong 12
  - p95 event duration tăng lên ~350ms
  - VU usage tăng nhưng không drop
  - Nếu external_ms=200 làm external quá tải → có thể thấy drop

Bài học:
  - preAllocatedVUs=12 cho headroom ~3x với external_ms=200 ở peak
  - Nếu vẫn drop → external có vấn đề không tuyến tính với latency config
```

### Variation 2: Higher peak rate — test rate headroom

```text
Mục đích: Test order service có chịu được peak cao hơn không.

Thay đổi:
  - Stage 2 target: 10 → 20/s
  - Stage 3 target: 2 → 5/s
  - Giữ nguyên external_ms (40ms, 20ms)

Config mới:
  - stages: [{duration:"15s",target:5},{duration:"15s",target:20},{duration:"10s",target:5}]
  - Scheduled slots: 45 + 187.5 + 125 = 357.5 ≈ 358
  - Peak rate: 20/s (gấp đôi)

Dự kiến:
  - W_effective ≈ 72ms
  - required_vus ở peak 20/s: ceil(20 × 0.072) = 2 VU
  - → Vẫn dễ dàng với preAllocatedVUs=12
  - Nhưng nếu external latency tăng theo rate → có thể thấy drop
  - Test này đánh giá external scalability (external có tuyến tính không)

Bài học:
  - Nếu pass: external xử lý tuyến tính, có thể tăng peak rate
  - Nếu fail: external có bottleneck, cần điều tra rate limit
```

### Variation 3: Longer surge duration — test sustained peak

```text
Mục đích: Test xem system có duy trì được peak lâu hơn không (memory leak, connection leak).

Thay đổi:
  - Stage 2 duration: 15s → 60s
  - Tổng duration: 40s → 85s
  - Stage 1 target: 5 (giữ nguyên)
  - Stage 2 target: 10 (giữ nguyên, nhưng giữ lâu hơn)
  - Stage 3 target: 2 (giữ nguyên)

Config mới:
  - stages: [{duration:"15s",target:5},{duration:"60s",target:10},{duration:"10s",target:2}]
  - Scheduled slots: 45 + 450 + 60 = 555

Dự kiến:
  - 60s peak liên tục → cơ hội phát hiện memory leak
  - VUs ổn định trong suốt stage 2 → không tăng dần
  - p95 latency ổn định → không degradation
  - Nếu VUs tăng dần hoặc p95 tăng dần → resource leak

Bài học:
  - Duration dài phát hiện vấn đề mà test ngắn bỏ lỡ
  - Memory leak, connection pool cạn, GC pressure → cần sustained test
```

### Variation 4: External fail injection — test resilience

```text
Mục đích: Test system behavior khi external payment gateway có lỗi.

Thay đổi:
  - external_fail_rate: 0 → 0.05 (5% fail)
  - Giữ nguyên rate shape và external_ms

Dự kiến:
  - 5% của 218 = ~11 checkout create requests fail
  - Nếu code có early return → http_reqs < 436, khoảng 425
  - events_failed ≈ 11
  - dropped_iterations vẫn = 0 (fail không gây drop)
  - Tỉ lệ http_reqs/iterations giảm nhẹ (~1.95)

Bài học:
  - Phân biệt "fail do external" với "fail do thiếu VU"
  - External fail → events_failed tăng nhưng dropped_iterations = 0
  - Thiếu VU → dropped_iterations tăng, events_failed có thể vẫn = 0
  - Đọc cả 2 metrics cùng lúc để chẩn đoán đúng
```

### Variation 5: Steeper ramp — test shock absorption

```text
Mục đích: Test system behavior khi checkout surge đột ngột (flash sale).

Thay đổi:
  - Stage 1 duration: 15s → 5s (ramp nhanh hơn)
  - Stage 1 target: 5 → 10 (jump thẳng lên peak)
  - Stage 2 duration: 15s → 20s (giữ peak lâu hơn)
  - Stage 3: giữ nguyên

Config mới:
  - stages: [{duration:"5s",target:10},{duration:"20s",target:10},{duration:"10s",target:2}]
  - Scheduled slots: 5×(1+10)/2 + 20×10 + 10×(10+2)/2 = 27.5 + 200 + 60 = 287.5 ≈ 288
  - Peak rate: 10/s (đạt nhanh hơn)

Dự kiến:
  - Ramp quá nhanh (1→10/s trong 5s) → shock ở đầu stage 2
  - VU demand tăng đột ngột → có thể thấy latency spike
  - Nếu preAllocatedVUs=12 đủ → hấp thụ shock
  - Nếu không đủ → thấy drop ở đầu stage 2

Bài học:
  - Flash sale scenario: checkout users ào vào ngay lập tức
  - Ramp nhanh test khả năng "shock absorption" của hệ thống
  - So sánh với ramp chậm (15s) để thấy khác biệt
```

## Anti-patterns (mở rộng)

### AP1: "Peak rate 10/s thì pool 5 VU là đủ" — bỏ qua W_effective

```text
SAI:    peak = 10/s, 5 VUs → mỗi VU cần xử lý 2 events/s → tưởng dễ.
ĐÚNG:   Mỗi event cần ~72ms → 1 VU xử lý được ~14 events/s.
        5 VUs → capacity = 70 events/s → về lý thuyết đủ.
        NHƯNG với external tail latency (p95=192ms):
        5 VUs → capacity = 5/0.192 = 26 events/s → vẫn đủ cho 10/s.
        NHƯNG với external spike (W_effective=500ms):
        5 VUs → capacity = 5/0.5 = 10 events/s → VỪA KHÍT, dễ drop.

Hậu quả: Khi external chậm một chút, drop xuất hiện ngay vì không có buffer.
Bài học: Tính VU pool với W_effective_p95 (hoặc p99), không phải avg.
         Luôn có buffer 3-10x cho external latency biến động.
```

### AP2: "Dùng ramping-vus cho checkout surge vì nó cũng có stages"

```text
SAI:    ramping-vus có stages → tưởng mô phỏng được surge.
ĐÚNG:   ramping-vus stages thay đổi ACTIVE USERS (VU count), không phải arrival rate.
        Checkout surge yêu cầu: "10 checkout/s ở peak".
        ramping-vus trả lời: "18 users checkout được X lần/s".
        Khi external chậm: throughput tự giảm, KHÔNG PHÁT HIỆN ĐƯỢC vấn đề.

Hậu quả: Test pass nhưng production fail vì external bottleneck không được phát hiện.
Bài học: Dùng ramping-arrival-rate khi input là arrival rate biến thiên.
         Dùng ramping-vus khi input là active user count biến thiên.
```

### AP3: "http_reqs > iterations là bất thường" — không hiểu amplification

```text
SAI:    http_reqs = 436, iterations = 218 → "tỉ lệ 2:1 là sai, phải 1:1".
ĐÚNG:   Mỗi iteration có 2 API calls (checkout create + confirm).
        http_reqs = iterations × 2 là DẤU HIỆU KHỎE MẠNH.
        Nếu http_reqs = iterations → CHỈ có 1 step chạy → BUG.

Hậu quả: Tìm cách "sửa" tỉ lệ về 1:1 → phá vỡ multi-step flow.
Bài học: Hiểu business flow trước khi đọc metrics.
         Amplification factor là đặc trưng của multi-step event, không phải bug.
```

### AP4: "maxVUs để cao cho chắc, không cần preAllocatedVUs lớn"

```text
SAI:    "Cứ để maxVUs=100, k6 sẽ tự spawn khi cần, không cần preAllocatedVUs=12."
ĐÚNG:   Spawn VU mới có latency (cold start, memory allocation).
        Ở stage peak với rate 10/s, mỗi 100ms có 1 slot mới.
        Nếu VU không có sẵn, k6 phải spawn → có thể không kịp → drop.
        preAllocatedVUs đảm bảo có sẵn worker pool từ đầu.

Hậu quả: Drop xảy ra trong lúc k6 đang spawn VU, đặc biệt ở đầu stage peak.
Bài học: preAllocatedVUs = buffer tức thời. maxVUs = headroom dài hạn.
         Cả 2 đều cần, không thể thay thế cho nhau.
```

### AP5: "Checkout create fail → vẫn gọi confirm" — thiếu circuit breaker

```text
SAI:    Code không check ok trước khi gọi step 2.
        → Confirm được gọi với orderId từ checkout fail (có thể không hợp lệ).
ĐÚNG:   Nên có early return hoặc circuit breaker:
        if (!checkout.ok) { finishEvent(started, false, ...); return; }
        → Không gọi confirm nếu checkout thất bại.

Hậu quả: 
  - Lãng phí request confirm với orderId không tồn tại
  - Gây nhiễu metrics (confirm fail không phải do confirm mà do checkout)
  - Khó debug: không biết fail từ step nào
Bài học: Multi-step flow nên có circuit breaker giữa các step.
         Fail ở step N → không chạy step N+1.
         Giúp metrics rõ ràng và tránh cascading noise.
```

### AP6: "Chỉ cần đọc dropped_iterations, không cần đọc http_reqs/iterations"

```text
SAI:    "dropped_iterations = 0 là pass, không cần check gì khác."
ĐÚNG:   dropped_iterations = 0 chỉ nói rằng KHÔNG THIẾU VU.
        Không nói gì về business flow correctness.
        http_reqs/iterations < 2.0 có thể xảy ra dù dropped_iterations = 0
        (step 1 fail, step 2 skip → không drop nhưng event fail).

Hậu quả: Bỏ lỡ cascade failure. Tưởng test pass nhưng thực tế event đang fail.
Bài học: Luôn check cả dropped_iterations VÀ http_reqs/iterations.
         Hai metrics này bổ trợ cho nhau:
         - dropped_iterations → VU capacity
         - http_reqs/iterations → business flow health
```

### AP7: "External latency simulated thì không cần test tail"

```text
SAI:    "external_ms=40 là fixed, tail không tồn tại trong simulation."
ĐÚNG:   Dù external_ms fixed, tail latency vẫn có thể xuất hiện từ:
         - Network jitter thực tế (không phải simulated)
         - k6 internal scheduling delay
         - CPU contention khi nhiều VUs chạy
         - GC pause của k6 process
         - Server-side variability (DB lock, cache miss)

Hậu quả: Bỏ qua tail latency → underestimation VU demand.
Bài học: Luôn đọc p95/p99 dù external_ms fixed.
         Tail tồn tại từ infrastructure, không chỉ từ simulation.
```

## Reference

### Source files

| File | Mục đích |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-04-checkout-surge-ingress.js` | Backend script (hypothetical) |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\common.js` | Helper: `buildRampingArrivalScenario`, `finishEvent`, `requestJson`, `userContext` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\config.js` | Default config values |

### Related docs

| Doc | Liên quan |
| --- | --- |
| `docs/practice/ramping-arrival-rate/00_overview.md` | Tổng quan series ramping-arrival-rate |
| `docs/practice/ramping-arrival-rate/01_browse-surge-ingress.md` | Case 01: browse surge (contrast: high rate, low W) |
| `docs/practice/ramping-arrival-rate/02_search-surge-ingress.md` | Case 02: search surge |
| `docs/practice/ramping-arrival-rate/03_cart-surge-ingress.md` | Case 03: cart write surge |
| `docs/practice/ramping-arrival-rate/05_report-surge-ingress.md` | Case 05: report surge |
| `docs/practice/constant-arrival-rate/04_checkout-order-intake.md` | Constant-arrival-rate version (rate phẳng) |
| `docs/practice/ramping-vus/04_checkout-ramp.md` | Ramping-vus version (closed model) |

### Key formulas

| Công thức | Ý nghĩa |
| --- | --- |
| `slots_stage = duration × (rate_start + rate_end) / 2` | Scheduled slots cho 1 stage (trapezoid area) |
| `total_slots = sum(slots_stage)` | Tổng scheduled slots |
| `required_vus = ceil(max_rate × W_effective_p95)` | VU tối thiểu cho stage peak |
| `capacity = preAllocatedVUs / W_effective` | Capacity với pool hiện tại |
| `headroom = capacity / peak_rate` | Tỉ lệ an toàn |
| `http_reqs = iterations × 2` | Amplification factor (happy path) |
| `events_failed = iterations - (http_reqs / 2)` | Nếu có early return sau step 1 fail |

### Terminology

| Thuật ngữ | Định nghĩa |
| --- | --- |
| **Arrival slot** | Một cơ hội bắt đầu iteration tại một thời điểm xác định bởi scheduler |
| **Surge** | Traffic biến thiên theo thời gian: tăng dần (ramp-up), đạt đỉnh (peak), giảm dần (ramp-down) |
| **W_effective** | Thời gian một event giữ VU bận, bao gồm HTTP latency + JS processing + external dependency latency |
| **Amplification factor** | Tỉ lệ http_reqs / iterations; với multi-step flow, factor > 1 |
| **External latency** | Thời gian chờ external dependency (payment gateway, inventory service) — được simulate qua param `external_ms` |
| **Cascade failure** | Step 1 fail dẫn đến step 2 bị skip hoặc fail theo, làm giảm amplification factor |
| **Tail latency** | p95, p99 của latency distribution; quyết định VU demand thực tế |
| **VU pool buffer** | preAllocatedVUs - required_vus_min; hấp thụ latency spike |
| **Headroom** | maxVUs - preAllocatedVUs; khả năng mở rộng khi cần |
