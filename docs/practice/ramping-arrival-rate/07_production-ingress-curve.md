# Case 07: Production Ingress Curve

## Tình huống thực tế

Một production baseline thật không chỉ có nhiều service — nó còn có **arrival rate thay đổi theo
daily traffic curve**. Trong thực tế, traffic không bao giờ phẳng: user truy cập ít vào 3h sáng,
tăng dần vào 8h sáng, đạt đỉnh vào 11h-14h, giảm dần về chiều, rồi tăng nhẹ vào tối.

Case này mô phỏng chính xác scenario đó: **6 service production mixed baseline** chạy trên
một arrival curve có hình dạng daily traffic điển hình — bắt đầu thấp, ramp lên đỉnh trưa,
rồi giảm dần về cuối ngày.

Câu hỏi business:

```text
Hệ thống TỔNG THỂ có chịu được arrival rate BIẾN THIÊN theo daily curve trong 55s không?
- Bắt đầu 4/s (sáng sớm)
- Ramp lên 14/s (giờ làm việc)
- Tiếp tục ramp lên 28/s (đỉnh trưa)
- Giảm về 18/s (chiều)
- Giảm tiếp về 6/s (tối)

Với 6 service cùng chạy: product_list, product_detail, cart_add, auth_me, report, checkout.
Checkout có external latency 30ms — liệu có thành "noisy neighbor" khi rate lên 28/s không?
Với drop budget = 5 slots, liệu VU pool 20→60 có đủ cho toàn bộ curve không?
```

Đây là **case TỔNG HỢP CUMULATIVE** — cầu nối từ toàn bộ series `constant-arrival-rate`
(case 01-07, rate cố định) sang `ramping-arrival-rate` (rate biến thiên). Nó tổng hợp
**tất cả bài học từ 6 case trước của chính series ramping-arrival-rate này** và làm
nền tảng cho việc hiểu arrival-rate pattern ở dạng phức tạp nhất: **mixed services +
variable rate**.

### Case này LÀ cầu nối — không phải "case 01-06 gộp lại"

Case 07 không chạy 6 scenario riêng rồi gộp kết quả. Nó là **1 scenario duy nhất**
với 6 branch trộn vào nhau theo weight distribution, arrival rate **thay đổi theo 4 stages**:

```text
startRate = 4, timeUnit = 1s
stages:
  Stage 1: duration=10s, target=14  →  rate ramp 4→14/s (sáng → giờ làm việc)
  Stage 2: duration=20s, target=28  →  rate ramp 14→28/s (giờ làm việc → đỉnh trưa)
  Stage 3: duration=15s, target=18  →  rate ramp 28→18/s (đỉnh trưa → chiều)
  Stage 4: duration=10s, target=6   →  rate ramp 18→6/s (chiều → tối)

Tổng duration = 10 + 20 + 15 + 10 = 55s
Tổng scheduled slots ≈ 10×(4+14)/2 + 20×(14+28)/2 + 15×(28+18)/2 + 10×(18+6)/2
                     = 90 + 420 + 345 + 120
                     = 975 arrivals
Peak rate: 28/s (cuối stage 2)
Average target rate: 975 / 55 ≈ 17.7/s
```

Branch mix theo weight distribution:

```text
product_list    (30%): browse nhanh, read-heavy, ~5ms
product_detail  (25%): detail nhanh, read-heavy, ~5ms
cart_add        (15%): write nhẹ, memory 4KB, ~10ms
auth_me         (10%): validation + memory, ~10ms
report          (10%): report có gzip 1KB, ~15-20ms
checkout        (10%): external call 30ms, ~35-50ms   ← bottleneck ẩn
```

### Vì sao case này là CUMULATIVE BRIDGE?

```text
Series constant-arrival-rate (case 01-07):
  rate CỐ ĐỊNH — "hệ thống chịu được X arrivals/s không đổi trong Y giây không?"

Series ramping-arrival-rate (case 01-07):
  rate THAY ĐỔI — "hệ thống chịu được arrival curve biến thiên trong Y giây không?"

Case 07 ramping-arrival-rate = đỉnh của cả 2 series:
  - Dùng CÙNG 6 mixed services như constant-arrival-rate case 07
  - Dùng CÙNG cơ chế VU pool, drop, arrival slot như mọi case ramping-arrival-rate
  - THÊM variable rate curve — thứ làm VU demand profile phức tạp hơn hẳn
  - Tổng hợp bài học từ case 01-06 của ramping-arrival-rate:
    Case 01: daily curve pattern → áp dụng curve shape
    Case 02: peak stage sizing → stage 2 target=28 là đỉnh, cần VU đủ
    Case 03: mixed auth operations → auth_me branch trong mix
    Case 04: low-rate-high-VU → checkout external latency vẫn là bottleneck dù rate thấp
    Case 05: dropped_iterations as primary signal → drop budget=5 cho 975 slots
    Case 06: Little's Law for fast operations → product_list 5ms cần ít VU

→ Học xong case này = hiểu TOÀN BỘ arrival-rate pattern
→ Có thể áp dụng cho BẤT KỲ arrival curve nào trong production
→ Là definitive reference cho ramping-arrival-rate
```

### So sánh nhanh với constant-arrival-rate case 07

| Khía cạnh | constant-arrival-rate case 07 | ramping-arrival-rate case 07 |
| --- | --- | --- |
| Rate | Cố định 18/s | Biến thiên 4→14→28→18→6 |
| Duration | 60s | 55s |
| Total slots | 1080 | 975 |
| Peak rate | 18/s (toàn thời gian) | 28/s (chỉ cuối stage 2) |
| VU demand | Ổn định, dễ dự đoán | Thay đổi theo curve, phức tạp |
| preAllocatedVUs | 25 | 20 |
| maxVUs | 80 | 60 |
| Drop budget | 5/1080 = 0.46% | 5/975 = 0.51% |
| Bài toán chính | Mixed services ở rate cố định | Mixed services ở rate biến thiên |
| Câu hỏi | "6 service chịu 18/s không?" | "6 service chịu curve 4→28→6 không?" |

## 2 yêu cầu cốt lõi

Case 07 có 2 yêu cầu cốt lõi, phản ánh thực tế production mixed baseline với traffic biến thiên:

### Yêu cầu (a): Sustain mixed curve — toàn bộ 975 slot được xử lý qua 4 stages

```text
startRate = 4, timeUnit = 1s
stages: 10s→14, 20s→28, 15s→18, 10s→6
→ tổng scheduled slots ≈ 975 arrivals
→ mỗi arrival rơi vào 1 trong 6 branch theo trọng số
→ branch mix phải phản ánh traffic production thật
→ VU pool (preAllocatedVUs=20, maxVUs=60) phải ĐỦ cho toàn bộ curve
→ Đặc biệt: stage 2 peak 28/s — VU demand CAO NHẤT tại đây
```

**Khác với constant-arrival-rate case 07**: Ở constant case, VU demand ổn định suốt 60s.
Bạn biết chính xác cần bao nhiêu VU cho 18/s. Ở đây, VU demand **thay đổi theo từng stage**:
stage 1 cần ít VU (rate 4-14/s), stage 2 cần nhiều VU (rate 14-28/s, peak 28/s),
stage 3-4 cần ít dần. Điều này tạo ra bài toán **spawn/drain timing**: k6 có kịp spawn
thêm VU khi rate tăng không? Có lãng phí VU idle khi rate giảm không?

**Ví dụ tương tác phức tạp ở stage 2 (peak 28/s)**:

```text
Giây thứ 29 (cuối stage 2, rate=28/s): 28 slot đến. Weight distribution cho ra:
  product_list  ×8-9  (nhanh, ~5ms)    → trả VU lại nhanh
  product_detail ×7-8 (nhanh, ~5ms)    → trả VU lại nhanh
  cart_add      ×4-5 (vừa, ~10ms)     → trả VU lại vừa
  auth_me       ×2-3 (vừa, ~10ms)     → trả VU lại vừa
  report        ×2-3 (chậm, ~20ms)    → giữ VU lâu hơn
  checkout      ×2-3 (rất chậm, ~50ms)→ GIỮ VU RẤT LÂU

→ 28 slot/giây, mỗi checkout ~50ms → 2.8 checkout/s × 50ms = 0.14 VU-s/s
→ Nhưng đây chỉ là average — thực tế checkout latency có thể spike lên 100ms+
→ Nếu checkout và report cùng rơi vào 1 giây, chúng "ngốn" nhiều VU
→ Các slot product_list/auth_me tiếp theo có thể THIẾU VU
→ Nếu maxVUs=60 không kịp spawn → DROP slot (dù product/auth vốn rất nhanh!)
```

Đây chính xác là "noisy neighbor problem" ở cấp độ **variable arrival rate**:
khi rate đạt đỉnh 28/s, tác động của service chậm bị KHUẾCH ĐẠI vì số lượng slot/giây
nhiều hơn, làm tăng xác suất checkout/report "ngốn" VU đúng lúc các slot nhanh cần worker.

### Yêu cầu (b): drops <= 5, events failed trong budget

```text
dropped_iterations <= 5      (drop budget ~0.51% của 975)
ramping_arrival_events_failed < 20  (~2.05% của 975)
checks > 0.98                (cho phép tối đa 2% check fail)
http_req_failed < 0.02       (cho phép tối đa 2% request fail)
```

**Điểm dạy quan trọng — drop budget interpretation**:

`maxDropped=5` là **lab budget**, không phải production SLO:

```text
1. Đọc drop count:  5 out of 975 = 0.51% — nghe nhỏ nhưng là 5 business event bị mất
2. Drill service:   5 drops đó đến từ service NÀO? Checkout (write, money) hay
                    product_list (read, cacheable)?
3. Stage context:   5 drops xảy ra ở STAGE NÀO? Stage 2 (peak 28/s) hay stage 4 (6/s)?
                    Drop ở peak stage = hệ thống không chịu nổi đỉnh traffic
                    Drop ở low stage = vấn đề khác (spawn chậm, VU drain sớm?)
4. Ra quyết định:  nếu 5 drops đều ở product_list giai đoạn peak → có thể accept
                    nếu 5 drops đều ở checkout → unacceptable dù <=5!
                    nếu drops rải rác qua nhiều stage → VU pool thiếu toàn diện
5. So với production SLO: nếu SLO thật yêu cầu 0 drop → phải resize VU pool hoặc
   tối ưu service chậm TRƯỚC KHI rate đạt đỉnh
```

Điều quan trọng: `0.51%` drop rate nghe có vẻ chấp nhận được, nhưng đây là **lab**
với traffic tổng 975 slot. Trong production với hàng triệu request/ngày, 0.51% =
hàng nghìn business event bị mất. **Production SLO thường yêu cầu 0% drop cho
service business-critical** (checkout, cart, auth).

## Vì sao chọn `ramping-arrival-rate`?

Đây là câu hỏi QUAN TRỌNG NHẤT của case: với mixed baseline 6 service và daily traffic
curve, vì sao `ramping-arrival-rate` là executor ĐÚNG — và vì sao KHÔNG executor nào khác?

### Bảng so sánh definitive: tất cả 6 executor

| Executor | Dùng được cho mixed variable-rate baseline? | Vì sao (không) |
| --- | --- | --- |
| **per-vu-iterations** | ❌ | Đếm iteration cố định per VU, không mô phỏng arrival rate biến thiên từ bên ngoài. Không có khái niệm "rate thay đổi 4→28→6/s". VU identity bound vào user → không phù hợp open model. Mỗi VU chạy N iteration — không có cách nào map sang "28 arrivals/s trong stage 2". |
| **shared-iterations** | ❌ | Phân phối iteration không đều giữa VU. VU nhanh "cướp" iteration của VU chậm → branch mix bị bias về service nhanh (product) thay vì giữ weight distribution. Không kiểm soát được TIMING của iteration → không có arrival curve. |
| **constant-vus** | ❌ | Backend chậm (checkout 50ms) làm iter_time tăng → throughput GIẢM. Không giữ được rate curve. Kiểm tra "hệ thống chịu curve 4→28→6/s không?" trở thành "hệ thống chạy được bao nhiêu với 20→60 VU?" — sai câu hỏi. Đây là CLOSED model. |
| **ramping-vus** | ⚠️ GẦN ĐÚNG nhưng sai câu hỏi | Dùng CÙNG stage shape (ramp VU thay vì ramp rate). Nhưng kiểm soát VU count, KHÔNG kiểm soát arrival rate. Bạn không biết "28/s có đạt được không" — bạn chỉ biết "có 60 VU đang chạy". Backend chậm → throughput giảm → rate thực tế thấp hơn target. Xem NL4 bên dưới. |
| **constant-arrival-rate** | ⚠️ ĐƠN GIẢN HƠN NHƯNG không đủ | Giữ rate CỐ ĐỊNH. Dùng được cho mixed services (như constant-arrival-rate case 07). Nhưng không mô phỏng được DAILY CURVE. Production thật có traffic biến thiên — test với rate cố định không trả lời được "đỉnh 28/s có chịu được không?" Nếu dùng constant-arrival-rate với rate=28/s trong 55s → 1540 slot, quá nhiều so với thực tế (975). |
| **ramping-arrival-rate** | ✅ | **ĐÚNG**: giữ arrival rate BIẾN THIÊN theo curve. Backend chậm → cần thêm VU chứ không giảm rate. Drop là tín hiệu "VU pool không đủ cho latency profile hiện tại ở stage này". Branch mix theo weight → phản ánh traffic production thật. Rate curve phản ánh daily traffic pattern. |

### Vì sao ramping-arrival-rate là executor ĐÚNG cho open-model mixed variable-rate baseline?

Phân tích sâu 5 lý do:

#### Lý do 1: Arrival rate từ bên ngoài THAY ĐỔI THEO THỜI GIAN — production thật là vậy

```text
Trong production:
  - 3h sáng:  ~100 users đang browse → ~4 requests/s
  - 8h sáng:  ~500 users bắt đầu làm việc → ~14 requests/s
  - 12h trưa: ~1200 users đang hoạt động → ~28 requests/s
  - 18h chiều: ~700 users → ~18 requests/s
  - 22h tối:  ~200 users → ~6 requests/s

  Backend chậm hay nhanh KHÔNG làm thay đổi số user đang click.
  User vẫn click theo nhịp của HỌ, không phải nhịp của backend.

ramping-arrival-rate mô phỏng đúng điều này:
  - k6 giữ nhịp slot theo curve bất kể backend latency
  - Stage 1: 4→14 slot/s, stage 2: 14→28 slot/s, stage 3: 28→18 slot/s, stage 4: 18→6 slot/s
  - Backend chậm → iteration lâu hơn → cần nhiều VU hơn để giữ curve
  - Thiếu VU ở stage nào → drop Ở STAGE ĐÓ (biết chính xác stage nào thiếu)

ramping-vus mô phỏng SAI:
  - Bạn set VU ramp: 10→30→60→40→15
  - Backend chậm ở stage 2 → iter_time tăng → throughput giảm
  - "User tự nhiên click chậm lại lúc 12h trưa" — vô lý trong production
  - Bạn KHÔNG biết 28/s có đạt được không
```

#### Lý do 2: Variable rate tạo VU demand profile PHỨC TẠP — cần test để thấy

```text
Với constant-arrival-rate 18/s:
  L = λ × W = 18 × 0.01125 = 0.2025 VU (lý thuyết, bỏ qua queueing)
  Thực tế cần ~25-30 VU vì arrival pattern không đều + checkout tail latency

Với ramping-arrival-rate curve 4→28→6/s:
  Stage 1 (avg rate 9/s):  L ≈ 9 × 0.01125 = 0.10 VU → ít
  Stage 2 (avg rate 21/s): L ≈ 21 × 0.01125 = 0.24 VU → trung bình
  Stage 2 PEAK (28/s):     L ≈ 28 × 0.01125 = 0.32 VU (lý thuyết)
                            Nhưng checkout tail latency ở peak 28/s:
                            checkout event có thể kéo dài 50-100ms
                            → W_eff tăng → cần NHIỀU VU HƠN Little's Law dự đoán

  VU demand không cố định — nó THEO CURVE:
    Stage 1: demand thấp, VU dư → VU idle
    Stage 2: demand CAO, VU thiếu → spawn thêm (có delay!)
    Stage 3: demand giảm dần → VU bắt đầu dư trở lại
    Stage 4: demand thấp → VU dư nhiều

→ Test với constant-arrival-rate: chỉ thấy VU demand ở 1 mức rate
→ Test với ramping-arrival-rate: thấy VU demand THEO TỪNG STAGE
→ Phát hiện: "preAllocatedVUs=20 đủ cho stage 1-3 nhưng stage 2 peak cần spawn thêm"
→ Phát hiện: "spawn delay ở đầu stage 2 có thể gây drop trước khi VU kịp online"
```

#### Lý do 3: Branch mix phải ổn định THEO TỪNG STAGE — weight distribution không đổi

```text
Trong production:
  - 30% traffic là browse — tỷ lệ này KHÔNG đổi dù là 4/s hay 28/s
  - 10% là checkout — vẫn 10% dù checkout service đang chậm
  - User behavior mix ổn định theo thời gian (cùng user base)

ramping-arrival-rate:
  - Mỗi slot đến giờ → weightedPick() quyết định branch
  - Slot luôn được tạo ĐÚNG GIỜ THEO CURVE, không phụ thuộc iteration trước
  - Branch mix ổn định theo thời gian ở MỌI STAGE
  - Ở stage 2 peak 28/s: 30% × 28 = 8.4 product_list/s, 10% × 28 = 2.8 checkout/s
  - Ở stage 4 low 6/s:  30% × 6 = 1.8 product_list/s,  10% × 6 = 0.6 checkout/s

shared-iterations:
  - VU nhanh (product) lấy thêm iteration → mix bị lệch về product
  - Ở rate cao, bias càng nặng vì VU nhanh càng có lợi thế
  - Checkout 10% → thực tế có thể chỉ còn 5% iteration checkout
```

#### Lý do 4: Cần VU pool dùng chung cho 6 service QUA 4 STAGES — spawn/drain động

```text
Trong production (Kubernetes):
  - HPA (Horizontal Pod Autoscaler) scale pod THEO traffic
  - Khi traffic tăng (stage 1→2): HPA spawn thêm pod (có delay ~30-60s)
  - Khi traffic giảm (stage 3→4): HPA drain pod dư
  - Pod xử lý BẤT KỲ request nào — không "pod chuyên checkout"

ramping-arrival-rate:
  - preAllocatedVUs=20: worker khởi tạo sẵn, sẵn sàng nhận slot từ stage 1
  - Khi rate tăng vượt khả năng 20 VU: k6 tự động spawn thêm VU (có spawn delay)
  - maxVUs=60: trần worker — tương tự maxReplicas của HPA
  - Khi rate giảm: VU dư sẽ idle (k6 không tự drain VU trong scenario)
  - VU = anonymous worker → đúng với pod model

ramping-vus:
  - Bạn PHẢI tự tính: "cần bao nhiêu VU cho mỗi stage?"
  - Không có cơ chế tự động spawn theo demand — bạn set schedule thủ công
  - Nếu tính sai → hoặc thiếu VU (drop), hoặc thừa VU (lãng phí resource)
  - Đây là CLOSED model logic áp dụng cho OPEN model problem
```

#### Lý do 5: Drop là tín hiệu khan hiếm VU THEO STAGE — cần để xác định bottleneck stage

```text
Nếu dùng ramping-vus:
  - Bạn set VU schedule: 20→40→60→40→20
  - Rate THỰC TẾ không biết — có thể là 15/s hoặc 25/s
  - KHÔNG có drop vì VU luôn chạy (chỉ chậm đi)
  - Không biết "ở stage 2, 60 VU có đạt 28/s không?"
  - Không phát hiện được checkout đang ngốn VU ở stage 2

Nếu dùng ramping-arrival-rate:
  - Rate GIỮ THEO CURVE → nếu VU không đủ ở stage NÀO → drop XUẤT HIỆN Ở STAGE ĐÓ
  - Drop là TÍN HIỆU THEO STAGE: "VU pool hiện tại không đủ cho stage 2 (peak 28/s)"
  - Drill service/operation trong stage bị drop → tìm ra service nào kéo dài event duration
  - → Quyết định: tăng maxVUs (tương tự tăng maxReplicas HPA), hay tối ưu service chậm?
  - → Quyết định: tăng preAllocatedVUs (tương tự tăng minReplicas HPA) để giảm spawn delay?
```

### Tóm tắt: câu hỏi ĐÚNG cho case này

```text
❌ "Có 60 VU đủ để chạy 6 service trong 55s không?"
   → Đây là câu hỏi của ramping-vus (closed model)

✅ "Hệ thống có giữ được arrival curve 4→28→6/s với 6 mixed service, VU pool 20→60 không?"
   → Đây là câu hỏi của ramping-arrival-rate (open model)

   Câu hỏi ĐÚNG vì:
   - Rate là INPUT (đến từ user behavior)
   - VU pool là RESOURCE (để giữ rate)
   - Drop là SIGNAL (VU pool thiếu ở stage nào)
   - Service mix là CONTEXT (weight distribution production thật)
```

## Phân tích nguyên nhân gốc kỹ thuật (5 RC)

Mỗi RC đi kèm demo trace/code và cách phát hiện từ output.

### RC1: Mixed services + variable rate → multimodal latency × variable load → complex VU demand

**Hiện tượng**: p95 tổng có thể dao động MẠNH giữa các stage — stage 2 (28/s) có p95 cao hơn
hẳn stage 4 (6/s) vì load cao làm tăng queueing delay.

**Nguyên nhân**: 6 service có 6 W_effective (work per event) khác nhau. Khi rate tăng, không chỉ
số lượng event tăng mà **tỷ lệ event "nặng" trên tổng cũng tăng hiệu ứng** vì checkout/report
chiếm nhiều VU hơn ở rate cao:

```text
Công thức: W_effective = CPU + DB + external + memory

product_list:   W_eff ≈ 1ms (cpu) + 2 rows DB ≈ 3ms           → event ~5ms
product_detail: W_eff ≈ 1ms (cpu) + 1 row DB ≈ 2ms            → event ~5ms
cart_add:       W_eff ≈ 1ms (cpu) + 1 DB write + 4KB mem ≈ 8ms → event ~10ms
auth_me:        W_eff ≈ 1ms (cpu) + 1 row DB + 4KB mem ≈ 8ms  → event ~10ms
report:         W_eff ≈ 1ms (cpu) + 1 row DB + 1KB gzip ≈ 15ms → event ~20ms
checkout:       W_eff ≈ 2ms (cpu) + 1 DB write + 30ms ext ≈ 35ms → event ~50ms

Weighted W_effective (theo branch weight):
  = 0.30×5ms + 0.25×5ms + 0.15×10ms + 0.10×10ms + 0.10×20ms + 0.10×50ms
  = 1.5 + 1.25 + 1.5 + 1.0 + 2.0 + 5.0
  = 12.25ms (average)
```

**Nhưng average NÀY CHE GIẤU SỰ THẬT**:

```text
Ở stage 1 (rate 4-14/s, avg 9/s):
  - 9 slot/s × 12.25ms = 0.11 VU-s/s → cần rất ít VU
  - Checkout: 0.9 checkout/s × 50ms = 0.045 VU-s → không đáng kể
  - Hầu như không có queueing → latency gần đúng W_eff

Ở stage 2 (rate 14-28/s, peak 28/s):
  - 28 slot/s × 12.25ms = 0.343 VU-s/s (lý thuyết)
  - Checkout: 2.8 checkout/s × 50ms = 0.14 VU-s — CHIẾM 40% VU-s dù chỉ 10% traffic!
  - Thêm queueing delay khi VU pool gần cạn → checkout latency có thể spike 100ms+
  - 2.8 checkout/s × 100ms = 0.28 VU-s → chiếm đến 60%+ VU capacity
  - Các service nhanh (product_list, auth) bị ảnh hưởng dù bản thân chúng nhanh

→ W_eff KHÔNG cố định — nó tăng theo rate vì queueing
→ Ở rate 4/s:  W_eff ≈ 12ms
→ Ở rate 14/s: W_eff ≈ 13ms
→ Ở rate 28/s: W_eff ≈ 16-18ms (queueing bắt đầu đáng kể)
```

Demo trace cho 6 event từ các branch khác nhau Ở STAGE 2 (rate cao):

```text
Iter 412 (product_list):   start=0ms, GET /api/sim/products → 6ms, finish=6ms
Iter 413 (product_detail): start=0ms, GET /api/sim/products/17 → 4ms, finish=4ms
Iter 414 (cart_add):       start=1ms, POST /api/sim/cart/add → 12ms, finish=13ms
Iter 415 (checkout):       start=1ms, POST /api/sim/checkout → 55ms, finish=56ms  ← GIỮ VU LÂU
Iter 416 (report):         start=2ms, GET /api/sim/report → 22ms, finish=24ms
Iter 417 (product_list):   start=2ms, GET /api/sim/products → 5ms, finish=7ms
```

Cùng branch mix, nhưng **checkout event kéo dài 55ms** (gấp ~10 lần product_list).
Khi 3 checkout event chạy concurrent trong 1 giây ở rate 28/s → chúng giữ 3 VU trong ~55ms
→ 3 VU không available cho 25 slot còn lại trong giây đó → 25 slot phải tìm VU khác.

**Cách phát hiện**: So sánh `iteration_duration` trend qua các stage — stage 2 sẽ thấy p95
cao hơn hẳn stage 1 và stage 4. Nếu checkout latency spike, p95 stage 2 có thể gấp 2-3x
so với stage 1.

### RC2: Noisy Neighbor — checkout/report chậm NGỐN VU pool, ảnh hưởng service nhanh ở peak stage

**Hiện tượng**: Drop xuất hiện ở stage 2 (peak 28/s) dù tổng VU (60) có vẻ "đủ" theo
tính toán lý thuyết.

**Nguyên nhân**: Đây là **Noisy Neighbor Problem** kinh điển trong distributed systems,
nhưng ở cấp độ arrival-rate scheduler:

```text
Noisy Neighbor = service chậm (checkout 50ms, report 20ms) dùng chung resource pool (VU)
với service nhanh (product_list 5ms, product_detail 5ms). Khi pool cạn, service chậm
"ngốn" worker → service nhanh không còn worker để chạy → drop.

Cơ chế chính xác:

1. Ở stage 2, rate=28/s, 28 slot đến mỗi giây
2. WeightedPick() → ~2.8 checkout, ~2.8 report, ~8.4 product_list, ...
3. Checkout bắt đầu → chiếm 1 VU trong ~50ms
4. Report bắt đầu → chiếm 1 VU trong ~20ms
5. Product_list bắt đầu → chiếm 1 VU trong ~5ms → TRẢ VU LẠI NHANH
6. ... 5ms sau, product_list VU trả lại → available cho slot mới
7. ... 50ms sau, checkout VU trả lại → available cho slot mới
8. Nếu trong 50ms đó có 2-3 checkout + 2-3 report CONCURRENT:
   → 5-6 VU bị chiếm trong 20-50ms
   → 22 slot còn lại phải cạnh tranh cho số VU còn lại
   → Nếu maxVUs chưa kịp spawn (spawn delay) → DROP

Tác động CỘNG HƯỞNG ở peak stage:
  - Stage 1 (rate 9/s avg): ít checkout concurrent → Noisy Neighbor ít tác động
  - Stage 2 (rate 28/s peak): NHIỀU checkout concurrent → Noisy Neighbor TỐI ĐA
  - Stage 4 (rate 6/s): ít checkout → Noisy Neighbor không đáng kể

→ Drop nếu có sẽ TẬP TRUNG Ở STAGE 2
→ Drop thường xảy ra với service NHANH (ironic: service nhanh bị hại bởi service chậm)
```

**Cách phát hiện**:

```text
1. Lọc dropped_iterations theo stage (dùng custom tag `stage` hoặc timestamp)
2. Xem iteration của service NÀO bị drop — thường là product_list/auth (service nhanh)
   chứ không phải checkout (vì checkout đã chiếm VU rồi)
3. So sánh % VU utilization ở stage 2 vs stage 1:
   - Stage 1: VU utilization ~30-40%
   - Stage 2: VU utilization ~85-95% (gần max)
4. Đo checkout iteration_duration p95 ở stage 2:
   - Nếu > 80ms → checkout đang bị queueing delay → Noisy Neighbor đang hoạt động
```

### RC3: Drop budget interpretation — 5/975 = 0.51%, nhưng production SLO thường yêu cầu 0

**Hiện tượng**: Test pass với 3-4 drops (trong budget 5), team nghĩ "OK để deploy".
Nhưng production SLO yêu cầu 0% drop cho transaction có tiền.

**Nguyên nhân**: `maxDropped=5` là **lab budget để dạy học**, không phải production approval:

```text
Trong lab:
  975 slot, 5 drops = 0.51% drop rate
  5 drops nghe ít → "chắc không sao"
  Nhưng 5 drops = 5 business event bị mất
  Nếu 1 trong 5 là checkout → 1 đơn hàng bị mất → revenue impact

Trong production (1 triệu request/ngày):
  0.51% × 1,000,000 = 5,100 request bị drop mỗi ngày
  Nếu 10% là checkout → 510 đơn hàng/ngày bị mất
  Với average order value $50 → $25,500/ngày revenue loss
  → HOÀN TOÀN KHÔNG CHẤP NHẬN ĐƯỢC

Tại sao lab cho phép 5 drops?
  1. Để BẠN THẤY drop xuất hiện (nếu set = 0, test fail ngay → không có cơ hội phân tích)
  2. Để dạy cách ĐỌC drop: service nào, stage nào, pattern gì
  3. Để dạy cách HÀNH ĐỘNG: tăng maxVUs, tăng preAllocatedVUs, tối ưu service chậm
  4. Để dạy SỰ KHÁC BIỆT giữa lab budget và production SLO
```

**Cách phát hiện**:

```text
1. Không chỉ đếm drop count — DRILL SERVICE:
   - Có bao nhiêu drop là checkout? → Nếu > 0, UNACCEPTABLE cho production
   - Có bao nhiêu drop là product_list? → Có thể accept nếu product_list là cacheable read
   - Có bao nhiêu drop là cart_add? → Nguy hiểm — ảnh hưởng conversion funnel

2. Không chỉ đếm drop count — DRILL STAGE:
   - Stage 2 (peak): drop do thiếu VU ở peak → cần resize VU pool
   - Stage 1 (low): drop ở low rate → vấn đề spawn timing (lạ!)
   - Stage 4 (low): drop ở low rate → VU drain sớm?

3. So sánh drop count với production SLO:
   Lab:    5/975   = 0.51% → PASS (trong budget)
   Prod:   0/975   = 0%    → production requirement
   → Nếu production yêu cầu 0 drop → phải optimize đến khi 0 drop
   → KHÔNG ĐƯỢC lấy "lab pass" làm "production ready"
```

### RC4: Aggregate metrics CHE GIẤU per-service reality — phải drill by service và stage

**Hiện tượng**: `http_req_duration` p95 tổng = 45ms, nhìn có vẻ ổn. Nhưng `http_req_duration`
của checkout riêng p95 = 180ms, product_list riêng p95 = 8ms. Aggregate đánh lừa.

**Nguyên nhân**: k6 aggregate metrics mặc định gom TẤT CẢ request từ TẤT CẢ service vào 1 bucket:

```text
http_req_duration (aggregate, p95):
  = percentile của TẤT CẢ 975 request (từ 6 service)
  = bị kéo bởi service nhanh (70% traffic từ product_list + product_detail, ~5ms)
  → p95 tổng ~45ms (có vẻ ổn!)
  
  NHƯNG đây là SAI LẦM:
  - Checkout p95 = 180ms → user checkout chờ 180ms → unacceptable UX
  - Report p95 = 80ms → dashboard load chậm
  - Product_list p95 = 8ms → quá nhanh, kéo aggregate xuống

→ Aggregate metric là "con số dối trá" khi có mixed latency profile
→ PHẢI drill by service name HOẶC by URL/name tag
```

Thêm vào đó, với variable rate, aggregate metrics còn bị CHE GIẤU THEO STAGE:

```text
http_req_duration (aggregate, p95):
  Stage 1: ~30ms (rate thấp, ít queueing)
  Stage 2: ~65ms (rate cao, queueing đáng kể)
  Stage 4: ~25ms (rate thấp, ít queueing)
  → p95 tổng = 45ms — nằm giữa, không cho thấy stage 2 có vấn đề

Nếu chỉ nhìn aggregate:
  → "45ms, ổn" → bỏ qua việc stage 2 chậm hơn hẳn
  → Bỏ qua việc checkout đang bị ảnh hưởng nặng ở stage 2
```

**Cách phát hiện**:

```text
Drill 2 chiều: service × stage

1. Tag request với `service` name:
   http.get('/api/sim/products', { tags: { service: 'product_list' } })
   http.get('/api/sim/checkout',  { tags: { service: 'checkout' } })

2. Lọc http_req_duration theo tag service:
   - product_list: p95 target < 10ms
   - checkout:     p95 target < 100ms (nới rộng vì external 30ms)
   - report:       p95 target < 50ms

3. Lọc iteration_duration theo stage (dùng timestamp range):
   - Stage 2 (giây 10-30): checkout iteration p95 < 80ms
   - Stage 1 (giây 0-10):  checkout iteration p95 < 60ms (rate thấp hơn)

4. Nếu checkout p95 ở stage 2 > 100ms:
   → Checkout đang bị queueing delay do VU pool cạn ở peak
   → Cần thêm VU HOẶC tối ưu external call (cache, connection pool, timeout tuning)
```

### RC5: Stage transitions tạo VU demand shift — spawn/drain timing quan trọng

**Hiện tượng**: Drop xuất hiện ở ĐẦU stage 2 (khi rate bắt đầu ramp từ 14 lên 28/s), nhưng
hết drop ở CUỐI stage 2 (khi rate đã ổn định ở 28/s). Tại sao?

**Nguyên nhân**: Spawn delay + rate ramp tạo ra "window of vulnerability" ở mỗi stage transition:

```text
Stage transition: stage 1 (rate=14/s) → stage 2 (rate bắt đầu ramp lên 28/s)

Timeline chi tiết:
  t=9.0s:  rate ≈ 13/s, 20 VU đang xử lý, utilization ~60% → ỔN
  t=10.0s: stage 2 BẮT ĐẦU, rate = 14/s (bằng cuối stage 1)
  t=10.5s: rate ≈ 14.35/s, utilization bắt đầu tăng
  t=12.0s: rate ≈ 15.4/s, 20 VU gần full → k6 phát hiện cần thêm VU
  t=12.0s: k6 BẮT ĐẦU spawn VU mới (spawn process có delay!)
  t=12.5s: rate ≈ 15.75/s — VU MỚI CHƯA KỊP ONLINE → 20 VU không đủ → DROP!
  t=13.0s: VU mới #21 online → utilization giảm → hết drop
  t=14.0s: rate ≈ 16.8/s, thêm VU #22, #23 online
  ...
  t=20.0s: rate ≈ 21/s, ~35 VU online, utilization ổn

→ "Window of vulnerability" = từ lúc rate vượt capacity của VU hiện tại
  đến lúc VU mới kịp spawn và sẵn sàng nhận slot
→ Window này ở ĐẦU MỖI STAGE TĂNG RATE (stage 2)
→ Có thể giảm bằng cách: tăng preAllocatedVUs (spawn sẵn từ đầu)
  hoặc giảm spawn delay (không control được từ test script — là k6 internal)

Stage transition ngược: stage 2 (rate=28/s) → stage 3 (rate bắt đầu ramp xuống 18/s):
  t=30.0s: stage 3 bắt đầu, rate = 28/s (bằng cuối stage 2)
  t=30.0s: ~45 VU đang online → utilization giảm dần khi rate giảm
  t=35.0s: rate ≈ 23/s, VU bắt đầu idle
  t=45.0s: rate = 18/s, nhiều VU idle
  → KHÔNG có drop vì VU dư (không bị thiếu)
  → Nhưng VU idle = lãng phí resource (tương tự overallocation trong K8s)
```

**Cách phát hiện**:

```text
1. Vẽ timeline dropped_iterations (dùng custom metric hoặc log)
2. Nếu drops CLUSTER ở đầu stage 2 (giây 10-14):
   → Spawn delay issue → tăng preAllocatedVUs
3. Nếu drops RẢI RÁC suốt stage 2:
   → maxVUs không đủ → tăng maxVUs
4. Nếu drops ở stage 1 hoặc 4 (low rate):
   → Bất thường! Có thể là VU drain sớm hoặc bug trong script
5. So sánh VU count timeline với rate curve:
   - VU count nên "đi trước" rate 1-2 giây (nhờ preAllocatedVUs)
   - Nếu VU count "đi sau" rate → spawn delay đang là vấn đề
```

## Identity model deep-dive

Trong ramping-arrival-rate, **user identity trải dài qua 6 service** — không phải 1 user = 1
service. Đây là điểm KHÁC BIỆT với các case đơn service trước đó.

### User pool trong mixed baseline

```text
Trong production thật:
  - 1 người dùng browse sản phẩm (product_list)
  - Click vào 1 sản phẩm (product_detail)
  - Thêm vào giỏ hàng (cart_add)
  - Hệ thống xác thực token định kỳ (auth_me)
  - Admin dashboard load report (report)
  - User checkout đơn hàng (checkout)
  → 1 user có thể tạo ra NHIỀU LOẠI request KHÁC NHAU

Trong ramping-arrival-rate:
  - KHÔNG có user identity cố định gắn với VU
  - Mỗi arrival slot là 1 event độc lập
  - WeightedPick() chọn service cho event đó
  - Event KHÔNG nhớ "user nào đã làm gì trước đó" (stateless)
  - → Đúng với HTTP workload: mỗi request là độc lập

User pool ẩn (implied user pool):
  - 975 slot / 55s = trung bình 17.7 event/s
  - Nếu 1 user tạo trung bình 1 event mỗi 3 giây → ~53 concurrent users (think time 3s)
  - Nếu 1 user tạo trung bình 1 event mỗi 1.5 giây → ~27 concurrent users
  - Con số này KHÔNG quan trọng trong open model — quan trọng là arrival rate
```

### VU = anonymous worker, KHÔNG phải user

```text
ramping-arrival-rate:
  VU #1:  chạy product_list → xong → chạy checkout → xong → chạy auth_me → ...
  VU #2:  chạy report → xong → chạy product_detail → xong → chạy cart_add → ...
  ...
  VU #20: chạy product_list → xong → (idle, chờ slot mới)

→ VU không có identity
→ VU không thuộc về service nào
→ VU là POOL RESOURCE dùng chung
→ exec.scenario.iterationInTest = global arrival slot index (0..974)

So sánh với per-vu-iterations (có identity):
  VU #1 (user alice):   chạy 5 iteration, LUÔN là "alice"
  VU #2 (user bob):     chạy 5 iteration, LUÔN là "bob"
  → VU CÓ identity
  → Mỗi VU chạy TUẦN TỰ (iteration N+1 đợi iteration N xong)
  → exec.vu.iterationInInstance = local counter per VU

Sự khác biệt này là CỐT LÕI của open model vs closed model:
  - Open model: event đến theo thời gian (arrival rate), VU xử lý event nào cũng được
  - Closed model: VU có identity, VU tự tạo event tiếp theo sau khi xong event trước
```

### Tại sao anonymous worker QUAN TRỌNG với mixed baseline?

```text
Nếu VU có identity (per-vu-iterations):
  - VU alice chuyên checkout: alice chạy 5 checkout → alice LUÔN bận (checkout chậm)
  - VU bob chuyên product_list: bob chạy 5 product → bob LUÔN nhanh
  - alice không thể "giúp" bob vì identity khác nhau
  - Tận dụng VU pool KHÔNG hiệu quả

Nếu VU là anonymous worker (ramping-arrival-rate):
  - VU xử lý checkout (chậm) → xong → xử lý product_list (nhanh) → xong → xử lý auth_me
  - Mọi VU đều xử lý được mọi service
  - Tận dụng VU pool TỐI ĐA
  - Giống K8s pod: pod nào cũng xử lý được request nào

→ Anonymous worker = mô hình ĐÚNG cho mixed baseline
→ Identity-bound VU = mô hình SAI (hoặc ít nhất không tối ưu)
```

## Phân tích open model với mixed curve

Đây là phần deep-dive vào Noisy Neighbor ở chế độ **variable rate**, mở rộng từ constant case.

### Noisy Neighbor deep-dive với variable rate

```text
Định nghĩa Noisy Neighbor trong open model:
  Service A (chậm) và Service B (nhanh) dùng chung VU pool.
  Khi Service A chiếm VU → Service B thiếu VU → B bị drop,
  DÙ BẢN THÂN B RẤT NHANH.

Với CONSTANT rate (constant-arrival-rate case 07):
  Noisy Neighbor xảy ra ở MỌI THỜI ĐIỂM với cường độ NHƯ NHAU
  Vì rate cố định → số lượng checkout concurrent ổn định
  → Dễ dự đoán: "ở 18/s, checkout luôn chiếm ~X VU"

Với VARIABLE rate (ramping-arrival-rate case 07):
  Noisy Neighbor xảy ra với cường độ THAY ĐỔI THEO STAGE:
  
  Stage 1 (rate 4-14/s):
    - Checkout: 0.4-1.4 checkout/s → ít concurrent
    - Noisy Neighbor: YẾU, hầu như không đáng kể
    - VU pool 20 → dư dả
    
  Stage 2 (rate 14-28/s):
    - Checkout: 1.4-2.8 checkout/s → nhiều concurrent
    - Ở rate 28/s: 2.8 checkout/s, mỗi checkout ~50ms
    - Xác suất 3+ checkout concurrent trong 50ms window:
      P(3+ events trong 50ms với rate 2.8/s) = Poisson(λ=0.14, k>=3) ≈ 0.04%
      → Thấp, nhưng...
    - Khi VU pool gần cạn, checkout latency TĂNG do queueing:
      2.8 checkout/s × 80ms (có queueing) = 0.224 VU-s
    - Xác suất 3+ checkout concurrent trong 80ms:
      P(3+ events trong 80ms với rate 2.8/s) = Poisson(λ=0.224, k>=3) ≈ 0.15%
    - Vẫn thấp, nhưng CỘNG VỚI report (2.8 report/s, 20ms):
      P(5+ slow events concurrent) cao hơn đáng kể
    - Noisy Neighbor: MẠNH, có thể gây drop
    
  Stage 3 (rate 28-18/s):
    - Checkout giảm dần: 2.8 → 1.8 checkout/s
    - Noisy Neighbor: GIẢM DẦN
    - VU dư bắt đầu xuất hiện
    
  Stage 4 (rate 18-6/s):
    - Checkout: 1.8-0.6 checkout/s → ít concurrent
    - Noisy Neighbor: YẾU trở lại
    - VU pool dư → nhiều VU idle
```

### Tính toán VU demand theo từng stage

```text
Công thức Little's Law: L = λ × W

Nhưng với mixed services + variable rate, cần tính RIÊNG cho từng stage
và RIÊNG cho từng service, rồi CỘNG LẠI:

Stage 1 (avg rate = (4+14)/2 = 9/s, duration 10s):
  product_list:   0.30 × 9 × 5ms  = 0.0135 VU
  product_detail: 0.25 × 9 × 5ms  = 0.0113 VU
  cart_add:       0.15 × 9 × 10ms = 0.0135 VU
  auth_me:        0.10 × 9 × 10ms = 0.0090 VU
  report:         0.10 × 9 × 20ms = 0.0180 VU
  checkout:       0.10 × 9 × 50ms = 0.0450 VU
  ─────────────────────────────────────────
  Total L (lý thuyết):            0.1103 VU
  Thực tế (có queueing, +50% buffer): ~0.17 VU → 20 VU quá dư

Stage 2 (avg rate = (14+28)/2 = 21/s, PEAK rate = 28/s, duration 20s):
  Ở avg rate 21/s:
    product_list:   0.30 × 21 × 5ms  = 0.0315 VU
    product_detail: 0.25 × 21 × 5ms  = 0.0263 VU
    cart_add:       0.15 × 21 × 10ms = 0.0315 VU
    auth_me:        0.10 × 21 × 10ms = 0.0210 VU
    report:         0.10 × 21 × 20ms = 0.0420 VU
    checkout:       0.10 × 21 × 50ms = 0.1050 VU
    ─────────────────────────────────────────
    Total L (lý thuyết):             0.2573 VU
    Thực tế (có queueing, +80% buffer): ~0.46 VU

  Ở PEAK rate 28/s (cuối stage 2):
    product_list:   0.30 × 28 × 5ms  = 0.0420 VU
    product_detail: 0.25 × 28 × 5ms  = 0.0350 VU
    cart_add:       0.15 × 28 × 10ms = 0.0420 VU
    auth_me:        0.10 × 28 × 10ms = 0.0280 VU
    report:         0.10 × 28 × 20ms = 0.0560 VU
    checkout:       0.10 × 28 × 50ms = 0.1400 VU
    ─────────────────────────────────────────
    Total L (lý thuyết):             0.3430 VU
    Thực tế (có queueing, +100% buffer): ~0.7 VU

  NHƯNG — checkout latency KHÔNG cố định 50ms ở peak:
    Khi VU pool cạn, checkout bị queueing delay → latency tăng lên 80-100ms
    Nếu checkout = 80ms: 0.10 × 28 × 80ms = 0.224 VU → TĂNG 60%
    Nếu checkout = 100ms: 0.10 × 28 × 100ms = 0.280 VU → TĂNG 100%
    
    → Đây là VÒNG LẶP CHẾT:
      Checkout chậm → chiếm VU → VU cạn → queueing → checkout CÀNG CHẬM

  → 60 VU (maxVUs) vẫn ĐỦ cho peak lý thuyết (0.343 VU)
  → Nhưng nếu checkout spike lên 100ms + queueing: có thể cần đến 1-2 VU
  → 60 VU vẫn dư rất nhiều (vì preAllocatedVUs=20 đã dư cho stage 1)

Stage 3 (avg rate = (28+18)/2 = 23/s, duration 15s):
  Tương tự stage 2 nhưng giảm dần
  Total L (lý thuyết ở rate 23/s): ~0.28 VU
  Thực tế: ~0.5 VU → 60 VU dư

Stage 4 (avg rate = (18+6)/2 = 12/s, duration 10s):
  Total L (lý thuyết): ~0.15 VU
  Thực tế: ~0.25 VU → 20 VU dư

KẾT LUẬN: Với mixed services và variable rate 4→28→6/s:
  - VU demand lý thuyết rất thấp (~0.1-0.34 VU)
  - Ngay cả với buffer 2-3x → cần < 1 VU
  - preAllocatedVUs=20, maxVUs=60 là CỰC KỲ DƯ DẢ
  - NHƯNG: checkout tail latency + spawn delay + arrival burst
    có thể tạo ra drop CỤC BỘ ở stage 2
  
  → Bài toán KHÔNG phải là "có đủ VU không"
  → Bài toán là: "checkout tail latency + Noisy Neighbor + spawn timing
     có gây drop ở stage 2 không?"
  → Và: "nếu có drop, service NÀO bị drop?"
```

### Vòng lặp chết (death spiral) của Noisy Neighbor ở variable rate

```text
Cơ chế death spiral ở stage 2 (peak 28/s):

1. Rate bắt đầu tăng từ 14/s → VU utilization tăng
2. Một vài checkout event bắt đầu (chiếm VU trong 50-80ms)
3. VU pool bắt đầu cạn → slot mới phải queue
4. Queueing làm TẤT CẢ event chậm đi (không chỉ checkout)
5. Event chậm → giữ VU lâu hơn → VU pool CÀNG cạn
6. VU pool cạn → k6 spawn thêm VU (có delay)
7. Trong lúc chờ spawn → checkout event mới vẫn đến (2.8/s)
8. Checkout mới cũng phải queue → checkout latency TĂNG
9. Checkout latency tăng → checkout giữ VU lâu hơn → VU pool càng cạn
10. Lặp lại cho đến khi:
    a. VU mới spawn kịp → phá vỡ vòng lặp
    b. Rate giảm (stage 3) → giảm áp lực
    c. Drop xảy ra (slot bị bỏ) → giảm áp lực (nhưng mất business event)

Khác với constant rate: ở constant rate, death spiral nếu có sẽ KÉO DÀI SUỐT TEST
(vì rate không đổi). Ở variable rate, death spiral TỰ HẾT khi rate giảm (stage 3).
Điều này có nghĩa:
  - Drop có thể chỉ xảy ra trong 5-10 giây ở stage 2
  - Sau đó test "tự phục hồi" khi rate giảm
  - → Cần drill THEO STAGE để thấy, không nhìn aggregate
```

## Bảng service/API flow

6 branch với 6 service backend, chi tiết về weight, latency profile, và tác động VU.

### Tổng quan 6 service

| # | Service | Weight | Endpoint | W_eff | Event duration (p50) | Event duration (p95) | VU impact (per event) | Risk level |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | product_list | 30% | GET /api/sim/products | ~3ms | ~5ms | ~10ms | Rất thấp (0.005 VU-s) | LOW |
| 2 | product_detail | 25% | GET /api/sim/products/:id | ~2ms | ~5ms | ~10ms | Rất thấp (0.005 VU-s) | LOW |
| 3 | cart_add | 15% | POST /api/sim/cart/add | ~8ms | ~10ms | ~20ms | Thấp (0.010 VU-s) | LOW-MED |
| 4 | auth_me | 10% | GET /api/sim/auth/me | ~8ms | ~10ms | ~20ms | Thấp (0.010 VU-s) | LOW-MED |
| 5 | report | 10% | GET /api/sim/report | ~15ms | ~20ms | ~40ms | Trung bình (0.020 VU-s) | MED |
| 6 | checkout | 10% | POST /api/sim/checkout | ~35ms | ~50ms | ~100ms+ | CAO (0.050-0.100 VU-s) | HIGH |

### Phân tích từng service

#### Service 1: product_list (30%, GET /api/sim/products)

```text
Weight:      30% — traffic lớn nhất
W_eff:       ~3ms (1ms CPU + 2 rows DB select)
Event dur:   p50=5ms, p95=10ms
VU impact:   0.005 VU-s per event (rất nhẹ)
Stage 2 peak: 0.30 × 28 = 8.4 req/s → 8.4 × 5ms = 0.042 VU-s → cần < 1 VU

Đặc điểm:
  - Read-only, có thể cache được (giống constant-arrival-rate case 06)
  - Event nhanh nhất trong 6 service
  - Trả VU lại cực nhanh → VU quay vòng cao
  - Ít khả năng gây drop — nhưng DỄ BỊ DROP do Noisy Neighbor
  - Nếu bị drop: không mất tiền (read), nhưng mất UX
  - Ở stage 2 peak: 8.4 req/s, đây là service có slot NHIỀU NHẤT
    → nếu thiếu VU, product_list bị drop nhiều nhất (vì có nhiều slot nhất)
```

#### Service 2: product_detail (25%, GET /api/sim/products/:id)

```text
Weight:      25% — traffic lớn thứ hai
W_eff:       ~2ms (1ms CPU + 1 row DB select by id)
Event dur:   p50=5ms, p95=10ms
VU impact:   0.005 VU-s per event (rất nhẹ)
Stage 2 peak: 0.25 × 28 = 7.0 req/s → 7.0 × 5ms = 0.035 VU-s → cần < 1 VU

Đặc điểm:
  - Read-only, nhanh tương đương product_list
  - Database lookup by primary key → index hit, rất nhanh
  - Tương tự product_list: dễ bị drop do Noisy Neighbor
  - Kết hợp product_list + product_detail = 55% traffic → 15.4 req/s ở peak
  - Nếu 2 service này bị drop → ảnh hưởng browse experience
```

#### Service 3: cart_add (15%, POST /api/sim/cart/add)

```text
Weight:      15% — traffic vừa
W_eff:       ~8ms (1ms CPU + 1 DB write + 4KB memory alloc)
Event dur:   p50=10ms, p95=20ms
VU impact:   0.010 VU-s per event (thấp)
Stage 2 peak: 0.15 × 28 = 4.2 req/s → 4.2 × 10ms = 0.042 VU-s → cần < 1 VU

Đặc điểm:
  - Write nhẹ (cart data 4KB)
  - Nhanh hơn checkout (không có external call)
  - Dù là write nhưng latency thấp → ít ảnh hưởng VU pool
  - QUAN TRỌNG: drop cart_add = drop conversion funnel → ảnh hưởng revenue
  - Dù 4.2 req/s không nhiều, nhưng MỖI drop cart_add đều đau
```

#### Service 4: auth_me (10%, GET /api/sim/auth/me)

```text
Weight:      10% — traffic vừa
W_eff:       ~8ms (1ms CPU + 1 row DB + 4KB memory + token validation)
Event dur:   p50=10ms, p95=20ms
VU impact:   0.010 VU-s per event (thấp)
Stage 2 peak: 0.10 × 28 = 2.8 req/s → 2.8 × 10ms = 0.028 VU-s → cần < 1 VU

Đặc điểm:
  - Auth validation — critical path cho mọi request khác
  - Token validation có thể cache → giảm latency
  - 2.8 req/s không nhiều, nhưng nếu auth fail → ảnh hưởng toàn bộ session
  - Drop auth_me = user bị logout giữa chừng → UX rất tệ
```

#### Service 5: report (10%, GET /api/sim/report)

```text
Weight:      10% — traffic vừa
W_eff:       ~15ms (1ms CPU + 1 row DB + 1KB gzip compression)
Event dur:   p50=20ms, p95=40ms
VU impact:   0.020 VU-s per event (trung bình)
Stage 2 peak: 0.10 × 28 = 2.8 req/s → 2.8 × 20ms = 0.056 VU-s → cần < 1 VU

Đặc điểm:
  - Chậm hơn auth/cart/product vì có gzip compression
  - 2.8 req/s ở peak — không nhiều nhưng mỗi event giữ VU 20ms
  - Là một phần của "Noisy Neighbor" cùng với checkout
  - Report thường là dashboard admin → không ảnh hưởng end-user
  - Drop report = dashboard load fail → ảnh hưởng internal ops
```

#### Service 6: checkout (10%, POST /api/sim/checkout) ← BOTTLENECK CHÍNH

```text
Weight:      10% — traffic ít nhất (cùng với auth, report)
W_eff:       ~35ms (2ms CPU + 1 DB write + 30ms external call)
Event dur:   p50=50ms, p95=100ms+ (có thể spike cao hơn khi VU pool cạn)
VU impact:   0.050-0.100 VU-s per event (CAO NHẤT)
Stage 2 peak: 0.10 × 28 = 2.8 req/s → 2.8 × 50ms = 0.140 VU-s (lý thuyết)
              Nếu spike 100ms: 2.8 × 100ms = 0.280 VU-s (x2!)

Đặc điểm:
  - SERVICE CHẬM NHẤT — external call 30ms là nguyên nhân chính
  - External latency KHÔNG KIỂM SOÁT ĐƯỢC (phụ thuộc bên thứ 3)
  - Khi VU pool cạn → checkout latency TĂNG (queueing) → càng ngốn VU
  - Là "kẻ ồn ào" (Noisy Neighbor) chính:
    + Chỉ 10% traffic nhưng chiếm đến 40%+ VU-s ở peak
    + Làm service nhanh bị drop
  - CRITICAL: drop checkout = MẤT TIỀN — đây là transaction có revenue
  - Mỗi drop checkout là 1 đơn hàng không được xử lý
  
  Chiến lược:
    - Tăng maxVUs: giảm áp lực VU pool → checkout đỡ bị queueing
    - Tăng preAllocatedVUs: VU sẵn sàng ngay từ stage 1 → không cần spawn
    - Circuit breaker: nếu external call timeout → fail fast thay vì treo VU
    - Timeout tuning: giảm external timeout từ 30s xuống 5s → VU không bị treo lâu
```

### Tổng VU-s breakdown ở peak stage 2 (rate=28/s)

```text
┌─────────────────┬──────────┬──────────┬─────────────┬──────────┐
│ Service         │ Weight   │ Req/s    │ Event dur   │ VU-s/s   │
├─────────────────┼──────────┼──────────┼─────────────┼──────────┤
│ product_list    │ 30%      │ 8.4      │ 5ms         │ 0.042    │
│ product_detail  │ 25%      │ 7.0      │ 5ms         │ 0.035    │
│ cart_add        │ 15%      │ 4.2      │ 10ms        │ 0.042    │
│ auth_me         │ 10%      │ 2.8      │ 10ms        │ 0.028    │
│ report          │ 10%      │ 2.8      │ 20ms        │ 0.056    │
│ checkout        │ 10%      │ 2.8      │ 50-100ms    │ 0.140-0.280│
├─────────────────┼──────────┼──────────┼─────────────┼──────────┤
│ TOTAL           │ 100%     │ 28.0     │             │ 0.343-0.483│
└─────────────────┴──────────┴──────────┴─────────────┴──────────┘

Checkout chiếm: 0.140 / 0.343 = 40.8% VU-s (với checkout=50ms)
Checkout chiếm: 0.280 / 0.483 = 58.0% VU-s (với checkout=100ms)

→ Dù chỉ 10% traffic, checkout chiếm 40-60% VU capacity ở peak!
→ Đây là định nghĩa của Noisy Neighbor
```

## Metrics & tags deep-dive

### Per-service drill strategy

Để phát hiện Noisy Neighbor và drop pattern, bạn PHẢI drill metrics theo service.
k6 aggregate mặc định CHE GIẤU tất cả những gì quan trọng.

```text
STRATEGY 3 LỚP:

Lớp 1 — Aggregate (nhìn tổng quan):
  http_req_duration (p95)           → "45ms, ổn" ← SAI, bị service nhanh kéo xuống
  http_req_failed                   → "1.2%, pass" ← cần drill service nào fail
  dropped_iterations                → "3 drops, pass" ← cần drill service nào bị drop
  ramping_arrival_events_failed     → "5 fails, pass"
  checks                            → "99.1%, pass"

Lớp 2 — By service (drill từng service):
  http_req_duration{service:product_list} (p95)    → "8ms"
  http_req_duration{service:product_detail} (p95)  → "7ms"
  http_req_duration{service:cart_add} (p95)        → "18ms"
  http_req_duration{service:auth_me} (p95)         → "17ms"
  http_req_duration{service:report} (p95)          → "35ms"
  http_req_duration{service:checkout} (p95)        → "180ms" ← ĐỎ!

Lớp 3 — By service × stage (drill sâu hơn):
  http_req_duration{service:checkout, stage:2} (p95) → "250ms" ← ĐỎ ĐẬM!
  http_req_duration{service:checkout, stage:1} (p95) → "65ms"  ← vàng
  http_req_duration{service:checkout, stage:4} (p95) → "55ms"  ← xanh

→ Kết luận: checkout bị ảnh hưởng NẶNG ở stage 2 (peak)
→ Nhưng aggregate p95=45ms không cho thấy điều này!
```

### Custom tags cần thiết

```text
Trong script, tag mỗi request với:

1. `service` tag — để drill by service:
   http.get('/api/sim/products', { tags: { service: 'product_list' } })
   http.get('/api/sim/checkout',  { tags: { service: 'checkout' } })

2. `stage` tag (tính từ timestamp) — để drill by stage:
   Dùng __ENV.SCENARIO_START_TIMESTAMP hoặc Date.now() để tính stage hiện tại
   Hoặc dùng custom metric counter để gán stage tag

3. `operation` tag — để phân biệt operation type:
   http.get(..., { tags: { operation: 'browse' } })
   http.post(..., { tags: { operation: 'write' } })
   http.post(..., { tags: { operation: 'checkout' } })

4. Custom metric `iteration_stage` — để đếm iteration per stage:
   const stageMetric = new Counter('iteration_stage');
   // Tăng counter với tag stage='1', stage='2', etc.
```

### Custom metrics quan trọng

```text
1. dropped_iterations_by_service (Counter):
   - Tag: service (product_list, checkout, ...)
   - Đếm số drop cho TỪNG service
   - Cách làm: khi phát hiện iteration bị drop (dùng try/catch hoặc check
     exec.scenario.iterationInTest), tăng counter với tag service tương ứng

2. iteration_duration_by_service (Trend):
   - Tag: service
   - Đo iteration duration cho TỪNG service riêng
   - So sánh p95 giữa các service → tìm Noisy Neighbor

3. vu_count_over_time (Gauge):
   - Ghi nhận số VU đang active tại mỗi thời điểm
   - So sánh với rate curve → thấy spawn delay

4. stage_active (Gauge):
   - Ghi nhận stage hiện tại (1, 2, 3, 4)
   - Dùng để correlation với các metric khác
```

## Pass criteria

Case 07 có thresholds **nới lỏng hơn** so với các case đơn service trước đó.
Lý do: mixed baseline với 6 service có nhiều biến số hơn — độ nhiễu cao hơn,
external dependency (checkout), và variable rate làm tăng độ phức tạp.

### Bảng pass criteria

| Metric | Threshold | Vì sao mức này | Production SLO tương ứng |
| --- | --- | --- | --- |
| `dropped_iterations` | <= 5 | Lab budget cho phép 0.51% drop. Đủ để thấy pattern mà không mask vấn đề. | 0 (cho service có tiền) |
| `ramping_arrival_events_failed` | < 20 | ~2.05% failure rate cho phép. Mixed services + external call dễ fail hơn. | < 0.1% |
| `checks` | > 0.98 | Cho phép tối đa 2% check fail. 6 service × nhiều check = dễ fail hơn. | > 0.999 |
| `http_req_failed` | < 0.02 | Cho phép tối đa 2% request fail. External call checkout dễ fail. | < 0.001 |
| `http_req_duration` (checkout, p95) | < 200ms | Nới rộng cho checkout vì external 30ms + queueing ở peak. | < 100ms |
| `http_req_duration` (product_list, p95) | < 20ms | Service nhanh, kỳ vọng thấp. | < 10ms |
| `http_req_duration` (aggregate, p95) | < 100ms | Nới rộng vì mixed latency. | < 50ms |

### Vì sao thresholds được nới lỏng?

```text
1. Mixed services → multimodal latency → aggregate p95 bị kéo bởi service chậm
   → không thể đặt p95 aggregate < 50ms như case đơn service
   → phải drill by service để đánh giá riêng

2. Checkout external latency 30ms → baseline đã 50ms, không thể < 20ms
   → chấp nhận p95 checkout < 200ms (cho lab)
   → production target: < 100ms (cần tối ưu external call hoặc cache)

3. 6 service = nhiều code path = nhiều cơ hội fail
   → checks > 0.98 (thay vì > 0.99 như case đơn service)
   → http_req_failed < 0.02 (thay vì < 0.01)

4. Variable rate → stage 2 peak có thể gây spike latency
   → p95 aggregate < 100ms (thay vì < 50ms)
   → Nhưng p95 product_list VẪN phải < 20ms (service nhanh không có lý do chậm)

5. Drop budget = 5 (0.51%) → lab chấp nhận, nhưng phải phân tích
   → Nếu drop ở checkout: UNACCEPTABLE dù trong budget
   → Nếu drop ở product_list + stage 2: chấp nhận được cho lab
```

### Pass criteria KHÔNG có nghĩa là "production ready"

```text
LAB PASS:
  dropped_iterations = 3 <= 5          ✓
  checks = 0.985 > 0.98                ✓
  http_req_failed = 0.015 < 0.02       ✓
  http_req_duration p95 = 85ms < 100ms ✓
  → PASS!

PRODUCTION READY?:
  dropped_iterations = 3:
    - Trong đó 2 là checkout → KHÔNG chấp nhận được
    - 3/975 = 0.31% → với 1M req/ngày = 3100 drop → unacceptable
  http_req_duration p95 = 85ms:
    - Nhưng checkout p95 = 180ms → unacceptable UX cho checkout
  → NOT PRODUCTION READY!

→ Pass criteria trong lab là CỔNG ĐẦU TIÊN
→ Production readiness cần drill SÂU HƠN: by service, by stage, by business impact
```

## Cách chạy

### Local run

```bash
# Basic run
k6 run rar-07-production-ingress-curve.js

# Với output vào file JSON (để phân tích sau)
k6 run rar-07-production-ingress-curve.js \
  --out json=rar-07-results.json \
  --summary-export=rar-07-summary.json

# Với env override (thay đổi maxVUs, preAllocatedVUs, stages)
k6 run rar-07-production-ingress-curve.js \
  -e MAX_VUS=80 \
  -e PRE_ALLOCATED_VUS=30 \
  -e MAX_DROPPED=0 \
  --out json=rar-07-override-results.json
```

### Env override variables

```text
Các biến môi trường có thể override:

MAX_VUS=60               # Trần VU (default: 60)
PRE_ALLOCATED_VUS=20     # VU khởi tạo sẵn (default: 20)
MAX_DROPPED=5            # Drop budget (default: 5)
STAGE_1_DURATION=10      # Stage 1 duration (default: 10s)
STAGE_1_TARGET=14        # Stage 1 target rate (default: 14)
STAGE_2_DURATION=20      # Stage 2 duration (default: 20s)
STAGE_2_TARGET=28        # Stage 2 target rate (default: 28)
STAGE_3_DURATION=15      # Stage 3 duration (default: 15s)
STAGE_3_TARGET=18        # Stage 3 target rate (default: 18)
STAGE_4_DURATION=10      # Stage 4 duration (default: 10s)
STAGE_4_TARGET=6         # Stage 4 target rate (default: 6)
START_RATE=4             # Start rate (default: 4)
CHECKOUT_EXTERNAL_MS=30  # External latency cho checkout (default: 30ms)
```

### Dashboard view

```bash
# Chạy với K6_WEB_DASHBOARD
k6 run rar-07-production-ingress-curve.js --out web-dashboard

# Hoặc export ra CSV/JSON rồi visualize riêng
k6 run rar-07-production-ingress-curve.js \
  --out csv=rar-07-metrics.csv
```

Dashboard sẽ hiển thị:
- **Response Time**: drill by `service` tag — quan trọng nhất
- **Execution Timeline**: ramping shape với rate curve qua 4 stages
- **VUs vs iter/s**: VU demand theo rate curve, thấy spawn/drain pattern
- **Checks & Failures**: by service
- **Dropped Iterations**: timeline (nếu có)

### Expected run duration

```text
Total scenario duration: 55s (4 stages)
 + gracefulStop: 30s (default)
 + setup/teardown: ~5s
─────────────────────────────────
Total expected: ~90s
```

## Phân tích output 5 bước

### Bước 1: Kiểm tra aggregate metrics

```text
Nhìn vào summary cuối test:

data_received / data_sent      → traffic pattern
http_req_duration (avg, p95)   → "45ms / 85ms" ← ổn aggregate
http_req_failed                → "1.2%" ← pass (<2%)
checks                         → "99.1%" ← pass (>98%)
dropped_iterations             → "3" ← pass (<=5)
ramping_arrival_events_failed  → "5" ← pass (<20)
iterations                     → "972" ← tổng completed (975 scheduled - 3 dropped)

Đánh giá aggregate: PASS — nhưng ĐỪNG DỪNG Ở ĐÂY!
Aggregate PASS không có nghĩa là production ready.
```

### Bước 2: Drill dropped_iterations — service nào, stage nào?

```text
Nếu có drops (dù <=5), phân tích:

1. Lấy danh sách dropped iterations (từ log hoặc custom metric)
2. Xác định service của TỪNG drop:
   - Drop #1: checkout    ← ĐỎ: mất tiền
   - Drop #2: product_list ← vàng: mất UX, nhưng cacheable
   - Drop #3: product_list ← vàng
   → Kết luận: 1/3 drop là checkout → đau, dù <=5

3. Xác định stage của TỪNG drop (dùng timestamp):
   - Drop #1: t=12.3s (stage 2, rate ~16/s) ← spawn delay window
   - Drop #2: t=24.1s (stage 2, rate ~26/s) ← gần peak
   - Drop #3: t=25.8s (stage 2, rate ~27/s) ← gần peak
   → TẤT CẢ drop đều ở stage 2!
   → Stage 1, 3, 4: 0 drop → VU pool đủ cho low/medium rate
   → Stage 2: 3 drops → VU pool thiếu ở peak

4. Phân tích checkout drop:
   - Drop #1 là checkout ở t=12.3s → rate mới 16/s, chưa peak
   - Tại sao checkout bị drop khi rate còn thấp?
   - → Có thể checkout event trước đó đang giữ VU (50ms+)
   - → Slot checkout mới đến, không có VU rảnh → drop
   - → Spawn delay: VU mới chưa kịp online
```

### Bước 3: Drill http_req_duration by service — tìm Noisy Neighbor

```text
So sánh p95 của từng service:

Service           p50     p95     Đánh giá
product_list      5ms     8ms     ✓ Nhanh, ổn
product_detail    4ms     7ms     ✓ Nhanh, ổn
cart_add          10ms    18ms    ✓ Ổn
auth_me           9ms     17ms    ✓ Ổn
report            20ms    35ms    ✓ Ổn (chấp nhận được)
checkout          50ms    180ms   ⚠️ CAO! (external + queueing)

Phân tích checkout:
  - p50=50ms: đúng với baseline (35ms W_eff + overhead)
  - p95=180ms: gấp 3.6x p50 → queueing delay đáng kể
  - So với production target (p95 < 100ms): FAIL
  - Nguyên nhân: VU pool cạn ở stage 2 → checkout phải queue

Phân tích product_list:
  - p50=5ms, p95=8ms: rất nhanh, không bị ảnh hưởng
  - Dù Noisy Neighbor tồn tại, product_list VẪN nhanh
  - → Product_list bị DROP (mất slot) chứ không bị CHẬM
  - → Irony: service nhanh bị drop, service chậm bị chậm thêm
```

### Bước 4: Per-service breakdown — iteration count và failure

```text
Phân tích iteration count theo service:

Service           Expected     Actual      % of total  Delta
                  iterations   iterations
product_list      292          289         29.7%       -3 (có thể bị drop)
product_detail    244          243         25.0%       -1
cart_add          146          146         15.0%        0
auth_me            98           98         10.1%        0
report             98           97         10.0%       -1
checkout           98           96          9.9%       -2 ← MẤT CHECKOUT!
─────────────────────────────────────────────────────────────────
TOTAL             975          969         99.4%       -6 (? 
                                                       nhưng drop=3?
                                                       → 3 event đang
                                                       chạy khi test kết thúc)

CHÚ Ý: checkout actual = 96 thay vì 98 expected → 2 checkout bị mất
       (có thể 1 drop + 1 đang chạy khi test end)
       → Dù tổng drop=3 <=5 PASS, nhưng 2/3 là checkout → BUSINESS FAIL

Phân tích failure theo service:
  http_req_failed{service:product_list} = 0      ✓
  http_req_failed{service:product_detail} = 0    ✓
  http_req_failed{service:cart_add} = 0          ✓
  http_req_failed{service:auth_me} = 0           ✓
  http_req_failed{service:report} = 1            ~ (chấp nhận)
  http_req_failed{service:checkout} = 4          ⚠️ External call fail
  ─────────────────────────────────────────────────────
  TOTAL                                  = 5      <20 PASS

→ Checkout có 4 fails — external call không ổn định
→ Cần investigation: timeout? network? bên thứ 3?
```

### Bước 5: Correlation — rate curve × VU count × drop timeline

```text
Vẽ 3 đường trên cùng timeline (55s):

1. Rate curve (target):     4/s → 14/s → 28/s → 18/s → 6/s
2. VU count (actual):       20 → 20 → 35 → 45 → 45 → 45 → ...
3. Drop events (nếu có):    đánh dấu X tại thời điểm drop

Phân tích correlation:

t=0-10s (stage 1):
  Rate: 4→14/s, VU: 20 (không đổi), Drops: 0
  → 20 VU đủ cho stage 1

t=10-13s (đầu stage 2):
  Rate: 14→16/s, VU: 20→25 (bắt đầu spawn), Drops: 1-2
  → SPAN DELAY WINDOW: rate tăng nhanh hơn VU spawn
  → Nếu có drop, thường ở ĐÂY

t=13-30s (giữa-cuối stage 2):
  Rate: 16→28/s, VU: 25→45 (spawn tiếp), Drops: 0-1
  → VU đã "bắt kịp" rate
  → Nếu còn drop: maxVUs chưa đủ (cần >60?)

t=30-45s (stage 3):
  Rate: 28→18/s, VU: 45 (không đổi, idle tăng), Drops: 0
  → VU bắt đầu dư, idle VU xuất hiện

t=45-55s (stage 4):
  Rate: 18→6/s, VU: 45→45 (không giảm, k6 không tự drain), Drops: 0
  → Nhiều VU idle — lãng phí tài nguyên

PATTERN LÝ TƯỞNG (nếu pass hoàn hảo):
  VU count "đi trước" rate 1-2 giây (nhờ preAllocatedVUs)
  Không có drop ở bất kỳ stage nào
  VU count tăng theo rate curve (giống HPA trong K8s)

PATTERN CÓ VẤN ĐỀ (cần investigation):
  VU count "đi sau" rate → spawn delay đáng kể
  Drop cluster ở đầu stage 2 → cần tăng preAllocatedVUs
  Drop rải rác suốt stage 2 → cần tăng maxVUs
  VU count phẳng ở stage 3-4 → lãng phí (bình thường với ramping-arrival-rate)
```

## Dashboard 3-chart deep analysis

### Chart 1: Response Time — DRILL BY SERVICE (quan trọng nhất)

```text
Dashboard mặc định của k6 hiển thị http_req_duration AGGREGATE.
Với case 07 mixed services, ĐÂY LÀ CẠM BẪY.

Aggregate view:
  ┌────────────────────────────────────────────┐
  │ http_req_duration (all requests)            │
  │ avg: 42ms  p95: 85ms  p99: 150ms          │
  │ ▁▂▃▄▅▆▇█▇▆▅▄▃▂▁ (khá ổn)                  │
  └────────────────────────────────────────────┘
  → Nhìn ổn! Nhưng...

Drill by service (filter theo tag `service`):
  ┌────────────────────────────────────────────┐
  │ product_list:    avg 5ms   p95 8ms   ▁▂▁  │ ← quá nhanh
  │ product_detail:  avg 4ms   p95 7ms   ▁▂▁  │ ← quá nhanh
  │ cart_add:        avg 10ms  p95 18ms  ▂▃▂  │ ← ổn
  │ auth_me:         avg 9ms   p95 17ms  ▂▃▂  │ ← ổn
  │ report:          avg 20ms  p95 35ms  ▃▅▃  │ ← ổn
  │ checkout:        avg 55ms  p95 180ms ▅█▇  │ ← ĐỎ! Noisy Neighbor
  └────────────────────────────────────────────┘

→ Chỉ cần drill là thấy checkout p95=180ms
→ Nếu không drill, aggregate 85ms CHE GIẤU hoàn toàn

Phân tích checkout latency histogram:
  - 50% request: 40-60ms (baseline OK)
  - 90% request: 50-120ms (có queueing)
  - 95% request: 80-180ms (queueing nặng)
  - 99% request: 150-300ms (spike do thiếu VU trầm trọng)
  
  → Checkout latency có đuôi dài (long tail)
  → Đuôi này đến từ stage 2 (peak), khi VU pool cạn
  → Xác nhận bằng cách filter checkout requests ở stage 2 riêng

PHẢI LÀM: filter dashboard theo `service` tag HOẶC dùng Grafana dashboard
custom với panel riêng cho từng service.
```

### Chart 2: Execution Timeline — ramping shape với 6 services

```text
Execution timeline cho thấy iteration bắt đầu/kết thúc theo thời gian.

Kỳ vọng với ramping-arrival-rate (open model):
  - Iteration bắt đầu THEO RATE CURVE (dày hơn ở stage 2, thưa hơn ở stage 1, 4)
  - Không có "VU loop" như closed model (vì VU là anonymous)
  - Mỗi iteration là 1 event độc lập

Timeline pattern:
  t=0-10s (stage 1, rate 4→14):
    iteration ░░░░▒▒▒▒▓▓▓▓ (thưa → dày dần)
    
  t=10-30s (stage 2, rate 14→28):
    iteration ▓▓▓▓▓▓▓▓████ (dày → rất dày, PEAK)
    
  t=30-45s (stage 3, rate 28→18):
    iteration ████▓▓▓▓▓▓▓▓ (rất dày → dày)
    
  t=45-55s (stage 4, rate 18→6):
    iteration ▓▓▓▓▒▒▒▒░░░░ (dày → thưa)

Nếu có drop: thấy "lỗ hổng" trong timeline — iteration lẽ ra phải bắt đầu
nhưng không có. Lỗ hổng thường ở stage 2 (nơi density cao nhất).

So sánh với ramping-vus case 07 (closed model):
  - ramping-vus: iteration density phụ thuộc vào VU count VÀ iter_time
  - ramping-arrival-rate: iteration density CHỈ phụ thuộc vào rate curve
  - → Với ramping-arrival-rate, iteration density LUÔN theo rate curve
  - → Với ramping-vus, iteration density có thể thấp hơn rate curve nếu backend chậm
```

### Chart 3: VUs vs iter/s — VU demand theo rate curve

```text
Chart này cho thấy MỐI QUAN HỆ giữa VU count và iteration rate.

Kỳ vọng:
  - iter/s BÁM SÁT rate curve (vì rate là input)
  - VU count TĂNG khi rate tăng (spawn VU mới)
  - VU count KHÔNG GIẢM khi rate giảm (k6 không tự drain)
  - iter/s và VU count có tương quan dương

Biểu đồ lý tưởng:
  ┌──────────────────────────────────────────────┐
  │ iter/s (đường xanh)                          │
  │ ▁▂▃▄▅▆▇███▇▆▅▄▃▂▁ (theo curve)             │
  │                                              │
  │ VUs (đường cam)                              │
  │ ▁▁▁▂▃▅▆▇███████▇▇▇▇▇ (tăng rồi phẳng)      │
  │                                              │
  │ Drops (chấm đỏ)                              │
  │ ·· ·  · ·   (rải rác ở stage 2)              │
  └──────────────────────────────────────────────┘

Phân tích:
  - iter/s theo curve: ✓ hệ thống giữ được arrival rate
  - VU count tăng từ 20 → ~45: k6 spawn thêm ~25 VU ở stage 2
  - VU count phẳng sau stage 2: VU dư không được drain
  - Drops xuất hiện khi VU count chưa kịp tăng (đầu stage 2)

So sánh iter/s với target rate:
  Nếu iter/s LUÔN = target rate → 0 drop (VU pool luôn đủ)
  Nếu iter/s < target rate ở stage 2 → drop xảy ra
  Nếu iter/s > target rate → impossible (k6 không schedule quá rate)

So sánh với ramping-vus case 07:
  - ramping-vus: iter/s biến động theo iter_time, không control được
  - ramping-arrival-rate: iter/s = rate curve (miễn là VU đủ)
  - → Đây là ƯU ĐIỂM của open model: throughput là INPUT, không phải OUTPUT
```

## 4 output -> decision scenarios

### Scenario A: Perfect pass — 975 iterations, 0 drops, all services healthy

```text
KẾT QUẢ:
  iterations: 975 (100%)
  dropped_iterations: 0
  ramping_arrival_events_failed: 0
  checks: 1.0 (100%)
  http_req_failed: 0
  http_req_duration p95: 55ms (aggregate)
  checkout p95: 65ms
  product_list p95: 7ms

ĐÁNH GIÁ: PRODUCTION READY (với confidence cao)

Ý NGHĨA:
  - VU pool (20→60) HOÀN TOÀN ĐỦ cho curve 4→28→6/s
  - Checkout external latency không gây Noisy Neighbor ở peak 28/s
  - Spawn timing đủ nhanh để bắt kịp rate ramp
  - Tất cả service đều khỏe mạnh

HÀNH ĐỘNG:
  1. Ghi nhận baseline: preAllocatedVUs=20, maxVUs=60 là cấu hình TỐI ƯU
  2. Có thể thử GIẢM preAllocatedVUs xuống 15 xem còn pass không → tối ưu resource
  3. Có thể thử GIẢM maxVUs xuống 40 → tìm điểm gãy
  4. Tự tin deploy lên production (với cùng config VU pool)
  5. Set alert: nếu checkout p95 > 100ms → investigate

SO SÁNH VỚI CONSTANT-ARRIVAL-RATE CASE 07:
  - Constant case pass = "18/s cố định OK"
  - Ramping case pass = "4→28→6/s curve OK"
  - → Có confidence cho TOÀN BỘ daily traffic pattern
  - → Không chỉ 1 mức rate, mà MỌI mức rate trong ngày đều OK
```

### Scenario B: Drops within budget (<=5) — acceptable per lab, investigate service

```text
KẾT QUẢ:
  iterations: 972
  dropped_iterations: 3
  ramping_arrival_events_failed: 5
  checks: 0.987
  http_req_failed: 0.012
  http_req_duration p95: 78ms (aggregate)
  checkout p95: 150ms

ĐÁNH GIÁ: LAB PASS — nhưng CẦN INVESTIGATION trước production

PHÂN TÍCH DROPS:
  Drop #1: checkout, t=12.1s (stage 2, rate ~15/s)
  Drop #2: product_list, t=24.5s (stage 2, rate ~26/s)
  Drop #3: product_list, t=26.2s (stage 2, rate ~27/s)

  → 1/3 drop là checkout → business impact
  → Tất cả ở stage 2 → VU pool thiếu ở peak
  → Drop #1 xảy ra SỚM (rate mới 15/s) → spawn delay đáng kể

NGUYÊN NHÂN GỐC:
  - Spawn delay: VU mới chưa kịp online khi rate bắt đầu ramp
  - Checkout tail latency: p95=150ms → checkout ngốn VU lâu
  - preAllocatedVUs=20 không đủ buffer cho spawn delay window

HÀNH ĐỘNG:
  1. Tăng preAllocatedVUs: 20 → 25 (giảm spawn delay window)
     HOẶC
  2. Tăng maxVUs: 60 → 70 (thêm VU buffer)
     HOẶC
  3. Tối ưu checkout external call: circuit breaker, timeout tuning
  4. Sau khi áp dụng, re-run test → target 0 drops
  5. Nếu vẫn còn drop sau khi tăng VU → vấn đề không phải VU pool size
     → Checkout code path có vấn đề (memory leak, connection pool cạn...)

PRODUCTION READY?: CHƯA — còn checkout drop
  → 1 checkout drop trong 55s lab = unacceptable
  → Trong production 24h: ~1570 checkout drop/ngày (nếu pattern lặp lại)
```

### Scenario C: Drops > 5 — contract breach

```text
KẾT QUẢ:
  iterations: 963
  dropped_iterations: 12  ← VƯỢT NGƯỠNG!
  ramping_arrival_events_failed: 18
  checks: 0.972  ← DƯỚI NGƯỠNG (>0.98)
  http_req_failed: 0.025  ← VƯỢT NGƯỠNG (<0.02)
  http_req_duration p95: 250ms
  checkout p95: 450ms ← RẤT CAO

ĐÁNH GIÁ: FAIL — contract breach

PHÂN TÍCH:
  12 drops > 5 → VU pool KHÔNG ĐỦ
  checkout p95=450ms → checkout đang bị ảnh hưởng NẶNG
  checks=0.972 → có check fail (có thể timeout)
  http_req_failed=0.025 → 2.5% request fail

DROPS BREAKDOWN (giả định):
  6 drops ở product_list
  3 drops ở checkout
  2 drops ở product_detail
  1 drop ở cart_add
  → 3 checkout drops → CRITICAL

NGUYÊN NHÂN GỐC:
  - maxVUs=60 không đủ cho peak 28/s với mixed latency profile hiện tại
  - Checkout external latency đang spike (450ms p95 thay vì 50ms)
  - Có thể external service đang degraded → checkout chậm → VU pool cạn → death spiral
  - Có thể network issue giữa k6 và backend

HÀNH ĐỘNG:
  1. Tăng maxVUs: 60 → 100 (thử aggressive increase)
  2. Tăng preAllocatedVUs: 20 → 40 (giảm spawn pressure)
  3. Investigate checkout p95=450ms:
     - External service có bị quá tải không?
     - Network latency giữa k6 và external service?
     - Connection pool có bị cạn không?
  4. Thêm circuit breaker cho checkout: nếu external timeout > 200ms → fail fast
  5. Xem xét tách checkout ra executor riêng (constant-arrival-rate riêng cho checkout)
  6. Re-run test sau mỗi thay đổi để xác định yếu tố nào giúp

PRODUCTION READY?: TUYỆT ĐỐI KHÔNG
  → 12 drops, 3 checkout drops → mất revenue
  → checkout p95=450ms → user experience unacceptable
  → Cần investigation SÂU trước khi nghĩ đến deploy
```

### Scenario D: Concentrated failures in one service

```text
KẾT QUẢ:
  iterations: 974
  dropped_iterations: 1
  ramping_arrival_events_failed: 15
  checks: 0.985
  http_req_failed: 0.018 (1.8%)
  http_req_duration p95: 65ms (aggregate)
  checkout p95: 85ms

Nhưng khi drill by service:
  http_req_failed{service:checkout} = 14  ← 14/15 fails là checkout!
  http_req_failed{service:report} = 1
  Các service khác: 0 fail

ĐÁNH GIÁ: AGGREGATE PASS — nhưng CHECKOUT CÓ VẤN ĐỀ

PHÂN TÍCH:
  - 14/15 fails tập trung ở checkout → service-specific issue
  - Không phải VU pool issue (chỉ 1 drop)
  - Không phải Noisy Neighbor (các service khác khỏe)
  - → External service (checkout) đang có vấn đề RIÊNG
  - Có thể: external API rate limiting, authentication failure,
    network timeout, data validation error

HÀNH ĐỘNG:
  1. Investigate checkout external call:
     - Log response status code: 500? 503? 429?
     - Log response body: error message là gì?
     - Timing: fails xảy ra ở stage nào? (có thể external bị quá tải ở peak)
  2. Thêm retry logic cho checkout (nếu external error là transient)
  3. Thêm circuit breaker: nếu fail rate > 10% → stop sending checkout
  4. Tách checkout metric riêng để alert:
     - Alert khi http_req_failed{service:checkout} > 0.01
  5. Nếu external service không fix được:
     - Graceful degradation: checkout fail → lưu order vào queue, xử lý sau
     - Hoặc: giảm weight checkout trong test (tạm thời)

PRODUCTION READY?: KHÔNG cho checkout path
  → 14% checkout fail rate (14/98 checkout iterations)
  → Mất ~14 đơn hàng trong 55s
  → Cần fix external dependency trước khi deploy

BÀI HỌC: Aggregate metrics CHE GIẤU service-specific failure.
  - http_req_failed = 0.018 (1.8%) → aggregate PASS
  - Nhưng checkout fail rate = 14/98 = 14.3% → CRITICAL
  → LUÔN drill by service, đặc biệt với mixed baseline
```

## "Nghịch lý" (4)

### NL1: "p95 tổng cao nhưng test pass — vì contract đo bằng drops, không phải latency"

```text
Tình huống:
  http_req_duration p95 = 85ms (cao hơn mong đợi)
  Nhưng dropped_iterations = 2 (pass)
  → Test PASS

Nghịch lý: Làm sao test pass khi p95 cao?

Giải thích:
  ramping-arrival-rate đo CONTRACT bằng drops, không phải latency.
  Contract là: "giữ được arrival rate curve không?"
  
  - Nếu VU đủ để nhận MỌI slot → 0 drop → CONTRACT FULFILLED
  - Dù iteration có chậm (p95 cao) → VU vẫn nhận slot → không drop
  - Chỉ khi VU KHÔNG ĐỦ → slot bị bỏ → drop → CONTRACT BREACHED

  p95 cao là tín hiệu về CHẤT LƯỢNG DỊCH VỤ (latency), không phải về
  KHẢ NĂNG XỬ LÝ (throughput).

  Trong production:
  - Drop = user bị từ chối (mất hoàn toàn)
  - p95 cao = user phải chờ lâu (trải nghiệm kém, nhưng vẫn được phục vụ)
  - Cả 2 đều xấu, nhưng drop TỆ HƠN

Hành động:
  - Pass test = throughput OK → hệ thống XỬ LÝ ĐƯỢC toàn bộ traffic
  - Nhưng p95 cao = latency problem → cần optimize service chậm
  - KHÔNG ĐƯỢC coi "test pass" = "production ready" nếu p95 cao
  - Cần separate target cho latency (từng service) NGOÀI drop target
```

### NL2: "6 services, 975 slots, 0 drops — nhưng checkout vẫn là bottleneck ẩn"

```text
Tình huống:
  dropped_iterations = 0 (hoàn hảo!)
  Tất cả 975 slot được xử lý
  → Test PASS tuyệt đối

Nhưng khi drill:
  checkout p95 = 180ms
  checkout p99 = 350ms
  → Checkout vẫn là bottleneck!

Nghịch lý: Làm sao 0 drop mà checkout vẫn là bottleneck?

Giải thích:
  - 0 drop = VU pool ĐỦ LỚN để hấp thụ checkout tail latency
  - preAllocatedVUs=20, maxVUs=60 → dư VU cho peak
  - Checkout chậm → chiếm VU lâu → nhưng VU pool đủ lớn
    → VU khác xử lý slot còn lại → không drop
  - Checkout vẫn CHẬM, nhưng không gây THIẾU VU

  Bottleneck ẩn = checkout vẫn chậm (180ms), nhưng không gây drop
  vì VU pool có buffer đủ lớn. Trong production:
  - Nếu traffic tăng thêm 20% → checkout p95 có thể tăng lên 250ms
  - Nếu external service chậm thêm 50ms → checkout p95 có thể tăng lên 300ms
  - Lúc đó VU pool có thể không còn đủ → DROP XUẤT HIỆN

Hành động:
  - KHÔNG ĐƯỢC dừng ở "0 drop = perfect"
  - Checkout p95=180ms vẫn là VẤN ĐỀ cần giải quyết
  - Coi checkout p95 là "canary trong mỏ than":
    nếu nó tăng → sắp có drop
  - Set alert: checkout p95 > 150ms → warning, > 250ms → critical
  - Đây là bottleneck ẩn: chưa gây drop, nhưng LÀ NGUY CƠ TIỀM ẨN
```

### NL3: "drop budget=5 nghe ít nhưng là 0.51% — SLO production thường yêu cầu 0"

```text
Tình huống:
  Lab: maxDropped=5 → "5 drops, budget OK, pass"
  Dev: "0.51%, nhỏ mà, chắc production cũng OK"

Nghịch lý: 0.51% nghe rất nhỏ, nhưng trong production là con số KHỦNG KHIẾP.

Giải thích:
  Toán học đơn giản:
    0.51% × 1,000,000 requests/ngày = 5,100 requests bị drop/ngày
    0.51% × 10,000,000 requests/ngày = 51,000 requests bị drop/ngày

  Với checkout (10% traffic, mỗi checkout = $50 average):
    5,100 × 10% × $50 = $25,500/ngày revenue loss
    → $9.3M/năm revenue loss!

  SLO production thực tế:
    - Google SRE: error budget thường 0.1% hoặc thấp hơn
    - Amazon: "every 100ms of latency costs 1% in sales" → 0% drop target
    - Payment processor (Stripe, Adyen): 0.001% failure rate target
    - Netflix: "0% drop, degrade gracefully instead"

  Tại sao lab dùng 0.51%?
    - Để SINH VIÊN THẤY drop (nếu set 0%, test fail ngay → không học được gì)
    - Để dạy cách ĐỌC và PHÂN TÍCH drop
    - Để dạy sự KHÁC BIỆT giữa lab và production
    - KHÔNG PHẢI là "0.51% là chấp nhận được"

Hành động:
  1. Trong lab: pass với <=5 drops → HIỂU drop pattern
  2. Trước production: RE-RUN với maxDropped=0
  3. Nếu fail với maxDropped=0 → tối ưu đến khi pass
  4. KHÔNG BAO GIỜ lấy lab pass criteria làm production SLO

  Production target thực tế cho case 07:
    dropped_iterations = 0
    checkout p95 < 100ms
    http_req_failed < 0.001
    → Đây mới là production SLO
    → Lab pass với 5 drops chỉ là BƯỚC ĐẦU
```

### NL4: "cùng stage shape với ramping-vus case 07 nhưng input khác (rate vs VU)"

```text
Tình huống:
  ramping-arrival-rate case 07:
    stages: [{target: 14}, {target: 28}, {target: 18}, {target: 6}]
    → target LÀ ARRIVAL RATE

  ramping-vus case 07 (giả định, nếu dùng cùng stage shape):
    stages: [{target: 14}, {target: 28}, {target: 18}, {target: 6}]
    → target LÀ VU COUNT

  Cùng con số: 14, 28, 18, 6
  Nhưng Ý NGHĨA HOÀN TOÀN KHÁC!

Nghịch lý: Cùng stage shape, khác input → khác output hoàn toàn.

Giải thích:
  ramping-arrival-rate: stages[].target = ARRIVAL RATE (requests/s)
    Stage 1: ramp rate từ 4→14/s → VU tự động spawn nếu cần
    Stage 2: ramp rate từ 14→28/s → VU tự động spawn nếu cần
    → Rate là INPUT, VU là OUTPUT (tự động)

  ramping-vus: stages[].target = VU COUNT (số VU)
    Stage 1: ramp VU từ 4→14 → rate thực tế = VU / iter_time
    Stage 2: ramp VU từ 14→28 → rate thực tế = VU / iter_time
    → VU là INPUT, Rate là OUTPUT (không kiểm soát)

  So sánh ở stage 2 peak:
    ramping-arrival-rate: rate = 28/s GUARANTEED (nếu VU đủ)
    ramping-vus: VU = 28, rate thực tế = 28 / iter_time
      - Nếu iter_time = 50ms (checkout): rate ≈ 28/0.05 = 560/s (!)
      - Nhưng ở mixed baseline, iter_time trung bình ~12ms:
        rate ≈ 28/0.012 = 2333/s (vô lý, bị giới hạn bởi backend capacity)
      - Thực tế: rate ≈ 28 × (1000/12) × (1/28) ... phức tạp
      - Nếu backend chậm → iter_time tăng → rate GIẢM
      - Bạn không bao giờ biết chính xác rate là bao nhiêu

Hành động:
  - KHÔNG BAO GIỜ dùng ramping-vus để test arrival rate contract
  - KHÔNG BAO GIỜ map "28 VU" = "28 requests/s" — đây là HIỂU SAI NGUY HIỂM
  - Nếu cần test arrival rate → dùng ramping-arrival-rate (open model)
  - Nếu cần test concurrent users → dùng ramping-vus (closed model)
  - ĐỪNG NHẦM LẪN giữa 2 executor chỉ vì "cùng stage shape"

  Case này dùng ramping-arrival-rate VÌ:
    - Câu hỏi là "chịu được arrival curve 4→28→6/s không?"
    - KHÔNG phải "chịu được 4→28→18→6 VU không?"
    - Đây là 2 câu hỏi HOÀN TOÀN KHÁC NHAU
```

## Checklist

Trước khi chạy case 07:

- [ ] Đọc hiểu config: startRate=4, stages với 4 targets, preAllocatedVUs=20, maxVUs=60
- [ ] Xác nhận backend script: `rar-07-production-ingress-curve.js` hoạt động
- [ ] Kiểm tra 6 endpoint đều reachable (product_list, product_detail, cart_add, auth_me, report, checkout)
- [ ] Xác nhận checkout external latency (external_ms=30) — có thể override bằng env
- [ ] Setup custom tags: `service` cho mỗi request
- [ ] Setup custom metrics (nếu cần): `dropped_iterations_by_service`, `iteration_duration_by_service`
- [ ] Chuẩn bị câu hỏi: "service nào là bottleneck?", "stage nào có drop?"
- [ ] Tính toán expected slots: 975
- [ ] Tính toán expected iterations per service (dựa trên weight):
  - product_list: ~292, product_detail: ~244, cart_add: ~146
  - auth_me: ~98, report: ~98, checkout: ~98
- [ ] Set expectation: aggregate metrics SẼ CHE GIẤU per-service reality
- [ ] Set expectation: stage 2 (peak 28/s) là nơi dễ có vấn đề nhất

Trong khi chạy:

- [ ] Theo dõi dashboard real-time: iter/s có theo curve không?
- [ ] Theo dõi VU count: có tăng kịp khi rate ramp lên không?
- [ ] Theo dõi drop: xuất hiện ở giây thứ mấy?
- [ ] Ghi chú stage hiện tại → correlation với metrics

Sau khi chạy — PHẢI LÀM:

- [ ] **Bước 1**: Kiểm tra aggregate metrics (pass/fail tổng thể)
- [ ] **Bước 2**: Drill dropped_iterations — service nào, stage nào?
- [ ] **Bước 3**: Drill http_req_duration BY SERVICE — tìm Noisy Neighbor
- [ ] **Bước 4**: Per-service breakdown — iteration count và failure
- [ ] **Bước 5**: Correlation — rate curve × VU count × drop timeline
- [ ] So sánh checkout p95 giữa các stage (stage 2 vs stage 1 vs stage 4)
- [ ] So sánh product_list p95 giữa các stage (có bị ảnh hưởng bởi Noisy Neighbor?)
- [ ] Đếm số checkout drop (nếu có) → business impact assessment
- [ ] So sánh actual iterations per service với expected → độ lệch weight distribution
- [ ] Kết luận: production ready hay cần investigation?

Checklist per-service drill (cho TỪNG service):

- [ ] **product_list**: p95 < 20ms? Iteration count ~292? Drops?
- [ ] **product_detail**: p95 < 20ms? Iteration count ~244? Drops?
- [ ] **cart_add**: p95 < 30ms? Iteration count ~146? Drops? (critical: write)
- [ ] **auth_me**: p95 < 30ms? Iteration count ~98? Fails?
- [ ] **report**: p95 < 50ms? Iteration count ~98? Fails?
- [ ] **checkout**: p95 < 200ms? Iteration count ~98? Drops? Fails? (CRITICAL)
- [ ] **checkout stage 2**: p95 < 250ms? (nới rộng cho peak)

## 4-5 variations

### Variation 1: Aggressive peak — flash sale simulation

```text
Thay đổi: stage 2 target từ 28 → 50, duration từ 20s → 10s

Mục đích: mô phỏng flash sale — traffic tăng ĐỘT BIẾN trong thời gian ngắn

Config:
  startRate: 4
  stages: [
    { duration: "10s", target: 14 },
    { duration: "10s", target: 50 },   ← aggressive peak
    { duration: "15s", target: 18 },
    { duration: "10s", target: 6 }
  ]

  Tổng slots ≈ 10×(4+14)/2 + 10×(14+50)/2 + 15×(50+18)/2 + 10×(18+6)/2
             = 90 + 320 + 510 + 120 = 1040
  Peak rate: 50/s (gấp ~1.8x case gốc)

  VU demand ở peak 50/s:
    checkout: 5.0 checkout/s × 50ms = 0.25 VU-s (lý thuyết)
    → Với checkout spike 100ms: 5.0 × 100ms = 0.50 VU-s
    → maxVUs=60 vẫn đủ, nhưng spawn timing CRITICAL

  Kỳ vọng: drops tăng (có thể >10) nếu không tăng preAllocatedVUs
  Bài học: flash sale cần preAllocatedVUs CAO (VU "nóng" sẵn sàng)
```

### Variation 2: Extended peak — sustained high traffic

```text
Thay đổi: stage 2 duration từ 20s → 60s, giữ target=28

Mục đích: mô phỏng peak kéo dài (giờ cao điểm 2-3 tiếng trong production)

Config:
  startRate: 4
  stages: [
    { duration: "10s", target: 14 },
    { duration: "60s", target: 28 },   ← extended peak
    { duration: "15s", target: 18 },
    { duration: "10s", target: 6 }
  ]

  Tổng slots ≈ 90 + 60×(14+28)/2 + 345 + 120 = 90 + 1260 + 345 + 120 = 1815
  Peak kéo dài 60s → VU pool phải CHỊU ĐỰNG peak trong thời gian dài

  Kỳ vọng:
    - Nếu có Noisy Neighbor, tác động KÉO DÀI → nhiều drop hơn
    - Nếu checkout external service có rate limit → có thể bị throttle
    - VU utilization duy trì cao trong 60s → nếu có memory leak → lộ rõ

  Bài học: peak kéo dài khác peak ngắn — không chỉ "chịu đỉnh" mà "chịu đỉnh LIÊN TỤC"
```

### Variation 3: Steeper curve — morning rush hour

```text
Thay đổi: stage 1 duration từ 10s → 5s, stage 2 duration từ 20s → 15s

Mục đích: mô phỏng traffic tăng NHANH (morning rush hour — user đổ vào cùng lúc)

Config:
  startRate: 4
  stages: [
    { duration: "5s", target: 14 },    ← ramp nhanh hơn
    { duration: "15s", target: 28 },
    { duration: "15s", target: 18 },
    { duration: "10s", target: 6 }
  ]

  Stage 1 ramp rate: (14-4)/5s = 2/s² (gấp đôi case gốc 1/s²)
  → Rate tăng NHANH HƠN → VU demand tăng nhanh hơn
  → Spawn delay càng NGUY HIỂM (VU không kịp online)

  Kỳ vọng: drops ở stage 1-2 transition TĂNG
  Bài học: rate ramp speed quan trọng không kém peak height
```

### Variation 4: Không có checkout external latency

```text
Thay đổi: external_ms=0 (checkout không có external call)

Mục đích: xác định checkout external latency CÓ PHẢI là root cause không

Config:
  Giữ nguyên config gốc, nhưng set CHECKOUT_EXTERNAL_MS=0

  Kỳ vọng:
    - Checkout event duration giảm từ 50ms → ~15-20ms
    - VU-s từ checkout giảm 60-70%
    - Noisy Neighbor GIẢM ĐÁNG KỂ
    - Drops giảm hoặc biến mất
    - Checkout p95 giảm từ 180ms → ~30-40ms

  Bài học: external dependency là ROOT CAUSE của Noisy Neighbor
  → Tối ưu external call (cache, connection pool, timeout) = giải quyết gốc
```

### Variation 5: Production SLO — maxDropped=0

```text
Thay đổi: maxDropped=0 (production SLO)

Mục đích: test với production requirement thực tế

Config:
  Giữ nguyên config gốc, nhưng set MAX_DROPPED=0

  Kỳ vọng:
    - Nếu case gốc pass với 0-2 drops → variation này có thể pass
    - Nếu case gốc pass với 3-5 drops → variation này SẼ FAIL
    - → Cần optimize: tăng preAllocatedVUs, tăng maxVUs, hoặc tối ưu checkout

  Sau khi tối ưu:
    preAllocatedVUs=30, maxVUs=80, MAX_DROPPED=0
    → Re-run → target 0 drops
    → Nếu pass → PRODUCTION READY (về mặt drop contract)

  Bài học: lab pass ≠ production pass
  → Luôn re-run với production SLO trước khi deploy
```

## Anti-patterns (mở rộng)

### Anti-pattern 1: Nhìn aggregate p95 rồi kết luận "hệ thống ổn"

```text
SAI:
  http_req_duration p95 = 65ms → "Hệ thống response nhanh, ổn!"

ĐÚNG:
  Drill by service:
    product_list p95 = 7ms   ← nhanh
    checkout p95 = 250ms     ← chậm!
  → Kết luận: checkout có vấn đề, cần investigation

Hậu quả:
  - Deploy với checkout p95=250ms → user checkout phải chờ 250ms
  - Ở production load cao hơn → checkout p95 có thể lên 500ms+
  - User abandon cart → mất revenue
  - "Nhưng aggregate p95=65ms mà!" ← SAI LẦM CHẾT NGƯỜI

Cách tránh:
  - LUÔN drill by service khi có mixed baseline
  - Set alert PER SERVICE, không phải aggregate
  - Dashboard phải có panel riêng cho TỪNG service
```

### Anti-pattern 2: Coi "drop <=5" là production approval

```text
SAI:
  dropped_iterations = 3 <= 5 → "PASS! Deploy thôi!"

ĐÚNG:
  dropped_iterations = 3:
    - 2 là checkout → 2 đơn hàng bị mất
    - Production SLO: 0 drop cho checkout
  → KHÔNG PASS cho production

Hậu quả:
  - Deploy → 0.3% order bị drop
  - 1000 orders/ngày → 3 orders bị mất/ngày → ~90 orders/tháng
  - Customer complaint → investigation → "à, lab pass mà?"
  - Mất uy tín với business team

Cách tránh:
  - Phân tích TỪNG drop: service gì, stage nào, business impact
  - Set production SLO RIÊNG cho service critical (checkout, cart: 0 drop)
  - Service non-critical (product_list: có thể chấp nhận 0.01% drop)
  - Lab pass là ĐIỀU KIỆN CẦN, không phải ĐIỀU KIỆN ĐỦ
```

### Anti-pattern 3: Không tag service → không drill được

```text
SAI:
  http.get('/api/sim/products')
  http.get('/api/sim/checkout')
  → Tất cả request vào chung 1 bucket `http_req_duration`
  → Không thể tách ra per-service

ĐÚNG:
  http.get('/api/sim/products', { tags: { service: 'product_list' } })
  http.get('/api/sim/checkout',  { tags: { service: 'checkout' } })
  → Có thể filter `http_req_duration{service:checkout}`

Hậu quả:
  - Không biết service nào chậm
  - Không biết service nào fail
  - Không biết service nào bị drop
  - Mù thông tin → không thể debug

Cách tránh:
  - TAG MỌI REQUEST với `service` tag
  - Tag thêm `operation` (read/write/external) nếu cần
  - Tag thêm `stage` nếu có thể tính từ timestamp
  - Dùng custom metric nếu tag không đủ
```

### Anti-pattern 4: Không so sánh per-stage metrics

```text
SAI:
  checkout p95 = 120ms → "Cao, cần fix"

ĐÚNG:
  checkout p95 stage 1 = 65ms   ← OK
  checkout p95 stage 2 = 250ms  ← ĐỎ!
  checkout p95 stage 3 = 100ms  ← vàng
  checkout p95 stage 4 = 60ms   ← OK
  → Vấn đề CHỈ ở stage 2 (peak)
  → Không cần fix checkout code — cần fix VU pool size ở peak

Hậu quả:
  - "Fix checkout performance" → optimize code không cần thiết
  - Code đã OK ở stage 1, 3, 4 — vấn đề là RESOURCE (VU) ở stage 2
  - Lãng phí thời gian optimize sai chỗ

Cách tránh:
  - LUÔN so sánh metrics GIỮA CÁC STAGE
  - Nếu metric xấu CHỈ ở stage peak → resource issue (thêm VU)
  - Nếu metric xấu ở MỌI stage → code issue (optimize service)
  - Dùng stage tag hoặc timestamp range để filter
```

### Anti-pattern 5: Dùng ramping-vus thay vì ramping-arrival-rate cho arrival rate test

```text
SAI:
  "Tôi cần test hệ thống chịu được 28 request/s. Tôi sẽ dùng ramping-vus
   với 28 VU vì 1 VU = 1 user, 1 user gửi 1 request/s."

ĐÚNG:
  "Tôi cần test hệ thống chịu được 28 request/s. Tôi sẽ dùng
   ramping-arrival-rate với rate=28."

Hậu quả của SAI:
  - 1 VU không = 1 request/s. VU chạy LIÊN TỤC.
    Nếu iter_time = 12ms → 1 VU tạo ra 1000/12 ≈ 83 request/s!
    → 28 VU tạo ra 28×83 ≈ 2324 request/s (không phải 28/s)
  - Hoặc nếu checkout chậm: iter_time = 200ms → 1 VU tạo ra 5 request/s
    → 28 VU tạo ra 140 request/s (vẫn không phải 28/s)
  - Rate thực tế PHỤ THUỘC vào iter_time, không kiểm soát được
  - Không biết "28/s có đạt được không"
  - TEST SAI CÂU HỎI

Cách tránh:
  - Hỏi: "tôi cần control INPUT là gì?"
  - Nếu INPUT = arrival rate → ramping-arrival-rate (open model)
  - Nếu INPUT = concurrent users → ramping-vus (closed model)
  - KHÔNG map 1 VU = 1 request/s — đây là HIỂU SAI CƠ BẢN
```

### Anti-pattern 6: Bỏ qua checkout external latency khi thiết kế test

```text
SAI:
  "Checkout weight 10%, không đáng kể. Tập trung vào product_list (30%)."

ĐÚNG:
  Checkout weight 10% nhưng VU-s chiếm 40-60% ở peak
  → Checkout là BOTTLENECK CHÍNH dù traffic ít
  → Phải tập trung phân tích checkout TRƯỚC

Hậu quả:
  - Tối ưu product_list (5ms → 3ms): tiết kiệm 0.017 VU-s ở peak
  - Bỏ qua checkout (50ms → 30ms): tiết kiệm 0.056 VU-s ở peak
  - → Tối ưu sai chỗ, ROI thấp hơn 3x

Cách tránh:
  - Tính VU-s impact = weight × rate × event_duration
  - So sánh VU-s giữa các service ở PEAK RATE
  - Ưu tiên optimize service có VU-s impact CAO NHẤT
  - Không nhìn weight một mình — weight không phản ánh resource consumption
```

### Anti-pattern 7: Không tính toán expected slots → không biết test có chạy đúng không

```text
SAI:
  Chạy test xong, thấy iterations=972 → "Chắc OK"

ĐÚNG:
  Expected slots = 975 (đã tính trước)
  Actual iterations = 972
  → Thiếu 3 → 3 drops (đúng với dropped_iterations=3)
  → Hoặc 3 iteration đang chạy khi test kết thúc

Hậu quả:
  - Không biết test có chạy đúng config không
  - Nếu expected=975 mà actual=500 → config sai, script lỗi — nhưng không biết
  - Nếu expected=975 mà actual=1200 → rate tính sai — không phát hiện

Cách tránh:
  - LUÔN tính expected slots TRƯỚC khi chạy:
    expected = SUM over stages: duration × (rate_start + rate_end) / 2
  - So sánh actual iterations với expected
  - Nếu chênh > 2% → investigation (config sai? script lỗi? rate tính sai?)
  - Đây là sanity check CƠ BẢN NHẤT
```

## Reference

### Bridge đến tất cả executor series

Case 07 ramping-arrival-rate là **CUMULATIVE BRIDGE** — nó kết nối tất cả series
với nhau:

```text
Series constant-arrival-rate (7 cases):
  Dạy: open model với rate CỐ ĐỊNH
  Bridge: case 07 constant-arrival-rate → mixed baseline ở rate cố định
  → Học constant case 07 trước khi học ramping case 07

Series ramping-arrival-rate (7 cases):
  Case 01: daily curve pattern cơ bản
  Case 02: peak stage sizing
  Case 03: mixed auth operations
  Case 04: low-rate-high-VU (checkout)
  Case 05: dropped_iterations as primary signal
  Case 06: Little's Law for fast operations
  Case 07: PRODUCTION INGRESS CURVE (case này) — TỔNG HỢP TẤT CẢ
  → Case 07 là ĐỈNH của series ramping-arrival-rate

Series ramping-vus (7 cases):
  Case 07 ramping-vus: CÙNG stage shape (14, 28, 18, 6)
  nhưng KHÁC input: VU count thay vì arrival rate
  → So sánh 2 case 07 để hiểu SÂU SẮC open model vs closed model
  → Xem NL4

Series per-vu-iterations:
  Dạy: VU identity, iteration counters, user-centric model
  → Contrast: ramping-arrival-rate KHÔNG có user identity
  → VU = anonymous worker vs VU = named user

Series shared-iterations:
  Dạy: batch processing, work distribution giữa các VU
  → Contrast: ramping-arrival-rate phân phối THEO THỜI GIAN (arrival rate)
    thay vì THEO VU (VU nhanh cướp iteration của VU chậm)
```

### So sánh trực tiếp: ramping-arrival-rate case 07 vs ramping-vus case 07

| Khía cạnh | ramping-arrival-rate case 07 | ramping-vus case 07 |
| --- | --- | --- |
| **Model** | Open model | Closed model |
| **Input** | Arrival rate curve (4→14→28→18→6) | VU count curve (20→40→60→40→20) |
| **Output** | VU count (tự động spawn) | Arrival rate (không kiểm soát) |
| **Contract** | "Giữ được rate curve không?" | "Có đủ VU cho curve không?" |
| **Drop signal** | Có (dropped_iterations) | Không có (VU luôn chạy) |
| **Noisy Neighbor** | Dễ phát hiện (drop ở service nhanh) | Khó phát hiện (rate giảm đều) |
| **Spawn logic** | Tự động theo demand | Manual schedule |
| **Drain logic** | Không tự drain | Manual schedule (giảm VU) |
| **Dùng khi** | Biết traffic pattern (requests/s) | Biết user pattern (concurrent users) |
| **Business question** | "Hệ thống chịu được X req/s?" | "Hệ thống chịu được Y users?" |

### Công thức quan trọng

```text
1. Expected slots:
   slots = Σ (duration_stage × (rate_start + rate_end) / 2)
   = 10×(4+14)/2 + 20×(14+28)/2 + 15×(28+18)/2 + 10×(18+6)/2
   = 90 + 420 + 345 + 120 = 975

2. Little's Law (lý thuyết):
   L = λ × W
   Ở peak 28/s: L = 28 × 0.01225 = 0.343 VU

3. VU-s per service (ở rate λ):
   VU-s_service = weight_service × λ × W_eff_service
   Checkout ở peak: 0.10 × 28 × 0.050 = 0.140 VU-s

4. Weighted average W_eff:
   W̄ = Σ (weight_i × W_eff_i)
   = 0.30×5 + 0.25×5 + 0.15×10 + 0.10×10 + 0.10×20 + 0.10×50
   = 12.25ms

5. Drop rate:
   drop_rate = dropped_iterations / expected_slots
   5/975 = 0.0051 = 0.51%

6. Noisy Neighbor impact:
   VU-s_ratio = VU_s_slow_services / VU_s_total
   Ở peak: 0.196 / 0.343 = 57% (nếu checkout=100ms, report=20ms)

7. Spawn delay window:
   window = thời gian từ lúc rate vượt capacity đến lúc VU mới online
   Có thể giảm bằng cách tăng preAllocatedVUs
```

### Script reference

```text
Script: E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-07-production-ingress-curve.js

Cấu trúc script (hypothetical):
  - 6 branch với weight distribution
  - Mỗi branch gọi 1 endpoint khác nhau
  - Checkout branch có external latency (external_ms=30)
  - Custom tags: service, operation
  - Custom metrics: dropped_iterations_by_service, iteration_duration_by_service
  - Graceful degradation: nếu external call fail → fallback response
```

### Đường dẫn docs liên quan

```text
Series constant-arrival-rate:
  docs/practice/constant-arrival-rate/00_overview.md
  docs/practice/constant-arrival-rate/07_production-ingress-mix.md  ← case gốc

Series ramping-arrival-rate:
  docs/practice/ramping-arrival-rate/00_overview.md
  docs/practice/ramping-arrival-rate/01_daily-curve-pattern.md      (case 01)
  docs/practice/ramping-arrival-rate/02_peak-stage-sizing.md        (case 02)
  docs/practice/ramping-arrival-rate/03_mixed-auth-operations.md    (case 03)
  docs/practice/ramping-arrival-rate/04_low-rate-high-vu.md         (case 04)
  docs/practice/ramping-arrival-rate/05_dropped-iterations-signal.md (case 05)
  docs/practice/ramping-arrival-rate/06_littles-law-fast-ops.md     (case 06)
  docs/practice/ramping-arrival-rate/07_production-ingress-curve.md (case này)

Series ramping-vus (để so sánh):
  docs/practice/ramping-vus/07_production-ingress-curve.md

Lý thuyết nền:
  docs/20260114_00_vu-lifecycle-and-iteration-counters.md
  docs/20260115_00_constant-vus-executor.md
  docs/20260513_00_executor-from-simplest.md
```

### Tổng kết: Vì sao case này là CUMULATIVE BRIDGE

```text
Case 07 ramping-arrival-rate tổng hợp TẤT CẢ:

Từ case 01 (daily curve):     curve shape — rate không phẳng, thay đổi theo thời gian
Từ case 02 (peak stage):      stage 2 target=28 là đỉnh — cần VU đủ ở peak
Từ case 03 (mixed auth):      nhiều operation type trong cùng 1 scenario
Từ case 04 (low-rate-high-VU): checkout external latency — VU demand không tỷ lệ với rate
Từ case 05 (drops signal):    dropped_iterations là primary signal — phải drill
Từ case 06 (Little's Law):    tính VU demand theo lý thuyết — so với thực tế

Từ constant-arrival-rate case 07:
  - Mixed services: 6 service, 6 latency profile
  - Weight distribution: phản ánh production traffic mix
  - Noisy Neighbor: service chậm ngốn VU, service nhanh bị drop
  - Drop budget interpretation: lab vs production
  - Per-service drill: aggregate metrics CHE GIẤU sự thật

THÊM VÀO (chỉ có ở ramping-arrival-rate):
  - Variable rate curve: rate thay đổi theo 4 stages
  - VU demand profile: thay đổi theo curve (không cố định)
  - Spawn/drain timing: VU phải spawn kịp khi rate tăng
  - Stage transition vulnerability: "window of vulnerability" ở đầu mỗi stage tăng
  - Death spiral tự hết: khi rate giảm (stage 3), áp lực giảm → spiral tự dừng

→ Học xong case này = HIỂU TOÀN BỘ ARRIVAL-RATE PATTERN
→ Có thể áp dụng cho BẤT KỲ daily traffic curve nào trong production
→ Là definitive reference cho ramping-arrival-rate
→ Là cầu nối hoàn chỉnh từ constant-arrival-rate (rate cố định)
   sang ramping-arrival-rate (rate biến thiên)
```

---

*Case 07 — Production Ingress Curve. The cumulative bridge. Tổng hợp tất cả bài học
từ 6 case trước + constant-arrival-rate case 07. Mixed services + variable rate =
definitive ramping-arrival-rate reference. Học xong case này, bạn hiểu arrival-rate
pattern ở dạng phức tạp nhất và sẵn sàng cho production.*
