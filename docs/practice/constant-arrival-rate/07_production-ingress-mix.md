# Case 07: Production ingress mix

## Tình huống thực tế

Một production baseline thật không chỉ có một endpoint hay một service. Khi hệ thống
vận hành thực tế, traffic đến từ **nhiều nguồn khác nhau** cùng lúc: người dùng browse
sản phẩm, xem chi tiết, thêm vào giỏ hàng, hệ thống xác thực token, checkout đơn hàng,
và dashboard report cùng chạy song song. Mỗi loại traffic có **latency profile khác nhau**,
service backend khác nhau, và mức độ quan trọng business khác nhau.

Câu hỏi business:

```text
Hệ thống TỔNG THỂ có chịu được 18 mixed arrivals/s trong 60s không?
Mỗi service riêng lẻ có bottleneck ẩn nào không?
Nếu có drop, service NÀO là nguyên nhân?
```

Đây là **case TỔNG HỢP** — nó gom tất cả bài học từ 6 case trước (case 01 storefront,
case 02 auth, case 03 cart, case 04 checkout, case 05 report, case 06 cacheable feed)
vào một baseline duy nhất. Sau case này, bước tiếp theo là `ramping-arrival-rate` —
nơi arrival rate không còn cố định mà **thay đổi theo thời gian** (campaign, flash sale,
surge traffic).

### Case này KHÔNG phải là "case 01 + 02 + ... gộp lại"

Case 07 không chạy 6 scenario riêng. Nó là **1 scenario duy nhất** với 6 branch
trộn vào nhau theo weight distribution:

```text
product_list    (30%): browse nhanh, read-heavy, ~5ms
product_detail  (25%): detail nhanh, read-heavy, ~5ms
cart_add        (15%): write nhẹ, memory 4KB, ~10ms
auth_me         (10%): validation + memory, ~10ms
report          (10%): report có gzip 1KB, ~15-20ms
checkout        (10%): external call 30ms, ~35-50ms   ← bottleneck ẩn
```

Điểm mấu chốt: **checkout và report chậm hơn nhiều so với product/auth**, nhưng
chúng dùng chung VU pool. Đây chính là bài toán "noisy neighbor" trong thực tế:
service chậm có thể **ngốn VU**, làm service nhanh bị thiếu worker.

### Vì sao case này là cầu nối sang ramping-arrival-rate?

```text
constant-arrival-rate:
  rate CỐ ĐỊNH 18/s × 60s = 1080 arrivals

ramping-arrival-rate:
  rate THAY ĐỔI theo thời gian: 5/s → 18/s → 30/s → 18/s → 5/s
  dùng SAME mixed services, SAME VU pool concept
  chỉ khác: arrival curve thay vì arrival constant

→ Học xong case 07 = hiểu open-model mixed baseline
→ Bước tiếp: thay constant rate bằng ramp stages
→ Toàn bộ kiến thức về noisy neighbor, drop budget, per-service drill
  ÁP DỤNG NGUYÊN cho ramping-arrival-rate
```

## 2 yêu cầu cốt lõi

Case 07 có 2 yêu cầu cốt lõi, khác với các case đơn service trước đó:

### Yêu cầu (a): 18 mixed arrivals/s bền vững trong 60s

```text
rate = 18, timeUnit = 1s
→ mỗi giây k6 cố START 18 iteration mới
→ tổng scheduled slots = 18 × 60 = 1080 arrivals
→ mỗi arrival rơi vào 1 trong 6 branch theo trọng số
→ branch mix phải phản ánh traffic production thật
```

**Khác với case đơn service**: case 01-06 mỗi case chỉ có 1 service/endpoint. Case 07
có **6 service khác nhau** với latency profile khác nhau, cùng chia sẻ 1 VU pool.
Điều này tạo ra tương tác phức tạp mà case đơn service không có.

**Ví dụ tương tác**:

```text
Giây thứ N: 18 slot đến. Weight distribution cho ra:
  product_list  ×5-6  (nhanh, ~5ms)    → trả VU lại nhanh
  product_detail ×4-5 (nhanh, ~5ms)    → trả VU lại nhanh
  cart_add      ×2-3 (vừa, ~10ms)     → trả VU lại vừa
  auth_me       ×1-2 (vừa, ~10ms)     → trả VU lại vừa
  report        ×1-2 (chậm, ~20ms)    → giữ VU lâu hơn
  checkout      ×1-2 (rất chậm, ~50ms)→ GIỮ VU RẤT LÂU

→ Nếu checkout và report cùng rơi vào 1 giây, chúng "ngốn" nhiều VU
→ Các slot product_list/auth_me tiếp theo có thể THIẾU VU
→ Nếu maxVUs không kịp spawn → DROP slot (dù product/auth vốn rất nhanh!)
```

Đây chính xác là "noisy neighbor problem" ở cấp độ arrival-rate.

### Yêu cầu (b): drops <= 5, events failed trong budget

```text
dropped_iterations <= 5      (drop budget ~0.46% của 1080)
constant_arrival_events_failed < 20  (~1.85% của 1080)
checks > 0.98                (cho phép tối đa 2% check fail)
http_req_failed < 0.02       (cho phép tối đa 2% request fail)
```

**Điểm dạy quan trọng**: `maxDropped=5` là **lab budget**, không phải production SLO.
Production thường yêu cầu `dropped_iterations=0` cho các service business-critical (checkout, cart).
Lab cho phép 5 drops để dạy cách:

```text
1. Đọc drop count: 5 out of 1080 = 0.46% — nghe nhỏ nhưng là 5 business event bị mất
2. Drill service: 5 drops đó đến từ service NÀO? Checkout hay product_list?
3. Ra quyết định: nếu 5 drops đều ở product_list (read, cacheable) → có thể accept
                   nếu 5 drops đều ở checkout (write, money) → unacceptable dù <=5!
4. So với production SLO: nếu SLO thật yêu cầu 0 drop → phải resize VU pool hoặc
   tối ưu service chậm
```

## Vì sao chọn `constant-arrival-rate`?

Đây là câu hỏi quan trọng: với mixed baseline 6 service, vì sao không dùng executor khác?

### Bảng so sánh definitive: tất cả 6 executor

| Executor | Dùng được cho mixed baseline? | Vì sao (không) |
| --- | --- | --- |
| **per-vu-iterations** | ❌ | Đếm iteration cố định per VU, không mô phỏng arrival rate từ bên ngoài. Không có khái niệm "18 arrivals/s". VU identity bound vào user → không phù hợp open model. |
| **shared-iterations** | ❌ | Phân phối iteration không đều giữa VU. VU nhanh "cướp" iteration của VU chậm → branch mix bị bias về service nhanh (product) thay vì giữ weight distribution. |
| **constant-vus** | ❌ | Backend chậm (checkout 50ms) làm iter_time tăng → throughput GIẢM. Không giữ được 18/s. Kiểm tra "hệ thống chịu 18/s không?" trở thành "hệ thống chạy được bao nhiêu với 30 VU?" — sai câu hỏi. |
| **ramping-vus** | ❌ | Giống constant-vus nhưng thay đổi VU theo thời gian. Không kiểm soát được arrival rate. Không biết 18/s có đạt không. |
| **ramping-arrival-rate** | ⚠️ quá mức | Dùng được nhưng quá phức tạp cho baseline cố định. Ramping-arrival-rate là bước SAU khi đã có baseline từ case này. Dùng nó cho baseline cố định = over-engineering. |
| **constant-arrival-rate** | ✅ | **ĐÚNG**: giữ arrival rate 18/s cố định. Backend chậm → cần thêm VU chứ không giảm rate. Drop là tín hiệu "VU pool không đủ cho mixed latency profile hiện tại". Branch mix theo weight → phản ánh traffic production thật. |

### Vì sao constant-arrival-rate là executor ĐÚNG cho open-model mixed baseline?

Phân tích sâu 5 lý do:

#### Lý do 1: Arrival rate từ bên ngoài là FIXED — backend chậm không được làm chậm ingress

```text
Trong production:
  - 1000 users đang browse app/web
  - Họ click, scroll, add to cart THEO NHỊP CỦA HỌ
  - Backend chậm không làm user "click chậm lại"
  - User vẫn click 18 lần/s, nhưng response chậm hơn → user frustrated

constant-arrival-rate mô phỏng đúng điều này:
  - k6 giữ nhịp 18 slot/s bất kể backend latency
  - Backend chậm → iteration lâu hơn → cần nhiều VU hơn
  - Thiếu VU → drop (user bị từ chối / timeout ở production)

constant-vus mô phỏng SAI:
  - Backend chậm → iter_time tăng → VU loop chậm → throughput giảm
  - "User tự nhiên click chậm lại" — vô lý trong production
```

#### Lý do 2: Branch mix phải ổn định — không bị bias bởi latency

```text
Trong production:
  - 30% traffic là browse (không thay đổi vì backend chậm)
  - 10% là checkout (vẫn 10% dù checkout service đang chậm)

per-vu-iterations / shared-iterations:
  - weightedPick() vẫn chạy đúng theo weight
  - NHƯNG: nếu checkout chậm, iteration checkout lâu hơn → checkout VU "bận" lâu hơn
  - Với shared-iterations: VU nhanh (product) lấy thêm iteration → mix bị lệch
  - Với per-vu-iterations: VU checkout chậm → tổng iteration của VU đó ít hơn (nếu
    maxDuration cắt) → mix cũng lệch

constant-arrival-rate:
  - Mỗi slot đến giờ → weightedPick() quyết định branch
  - Slot luôn được tạo ĐÚNG GIỜ, không phụ thuộc iteration trước xong chưa
  - Branch mix ổn định theo thời gian (chỉ lệch do randomness của weightedPick)
```

#### Lý do 3: Cần VU pool dùng chung cho 6 service — đúng mô hình production

```text
Trong production:
  - Kubernetes cluster có N pod xử lý TẤT CẢ request
  - Pod không "chuyên biệt" cho checkout hay product
  - Pod xử lý bất kỳ request nào đến

constant-arrival-rate:
  - VU pool (preAllocatedVUs=25, maxVUs=80) xử lý BẤT KỲ branch nào
  - Không có "VU chuyên checkout" hay "VU chuyên product"
  - VU = anonymous worker → đúng với pod model

per-vu-iterations:
  - VU identity = user identity → sai: pod không thuộc về user nào
```

#### Lý do 4: Drop là tín hiệu khan hiếm VU — cần để xác định bottleneck

```text
Nếu dùng constant-vus:
  - Rate giảm khi backend chậm → KHÔNG có drop
  - Không biết "ở 18/s có cần thêm VU không"
  - Không phát hiện được checkout đang ngốn VU

Nếu dùng constant-arrival-rate:
  - Rate GIỮ 18/s → nếu VU không đủ → drop xuất hiện
  - Drop là TÍN HIỆU: "VU pool hiện tại không đủ cho latency profile này"
  - Drill service/operation → tìm ra service nào kéo dài event duration nhất
  - → Quyết định: tăng maxVUs, hay tối ưu service chậm?
```

#### Lý do 5: Đây là baseline cho ramping-arrival-rate

```text
ramping-arrival-rate dùng CÙNG cơ chế:
  - VU pool dùng chung
  - Arrival rate thay đổi theo stages
  - Drop khi VU không đủ
  - Cần drill service/operation để hiểu bottleneck

→ Case 07 dạy tất cả những thứ này ở rate CỐ ĐỊNH (dễ hiểu hơn)
→ Sau đó áp dụng cho rate THAY ĐỔI (ramping-arrival-rate)
→ Không học case 07 → không hiểu ramping-arrival-rate
```

## Phân tích nguyên nhân gốc kỹ thuật (5 RC)

Mỗi RC đi kèm demo trace/code và cách phát hiện từ output.

### RC1: Mixed services tạo phân phối latency bimodal/multimodal

**Hiện tượng**: p95 tổng = 1617ms, nhưng từng service riêng lẻ có p95 rất khác nhau.

**Nguyên nhân**: 6 service có 6 W_effective (work per event) khác nhau:

```text
Công thức: W_effective = CPU + DB + external + memory

product_list:   W_eff ≈ 1ms (cpu) + 2 rows DB ≈ 3ms        → event ~5ms
product_detail: W_eff ≈ 1ms (cpu) + 1 row DB ≈ 2ms          → event ~5ms
cart_add:       W_eff ≈ 1ms (cpu) + 1 DB write + 4KB mem ≈ 8ms → event ~10ms
auth_me:        W_eff ≈ 1ms (cpu) + 1 row DB + 4KB mem ≈ 8ms  → event ~10ms
report:         W_eff ≈ 1ms (cpu) + 1 row DB + 1KB gzip ≈ 15ms → event ~20ms
checkout:       W_eff ≈ 2ms (cpu) + 1 DB write + 30ms ext ≈ 35ms → event ~50ms
```

Demo trace cho 6 event từ các branch khác nhau:

```text
Iter 1 (product_list):   start=0ms, GET /api/sim/products → 6ms, finish=6ms
Iter 2 (product_detail): start=0ms, GET /api/sim/products/17 → 4ms, finish=4ms
Iter 3 (cart_add):       start=1ms, POST /api/sim/cart/add → 11ms, finish=12ms
Iter 4 (auth_me):        start=1ms, GET /api/sim/auth/me → 9ms, finish=10ms
Iter 5 (report):         start=2ms, GET /api/sim/report → 18ms, finish=20ms
Iter 6 (checkout):       start=2ms, POST /api/sim/checkout → 48ms, finish=50ms

→ 6 event durations: [6, 4, 12, 10, 20, 50] ms
→ avg = 17ms, nhưng p95 ≈ 50ms (bị checkout kéo)
→ p95 tổng = 1617ms là do network + queueing trong test thật
  (event duration ≠ chỉ backend latency, còn có VU queue wait time)
```

**Phân phối latency thực tế từ Run 95**:

```text
Tổng 1081 event trải trên 6 service:

products-service (product_list + product_detail):
  ~55% của 1081 ≈ ~595 event
  p95 ~5-10ms (rất nhanh)

cart-service:
  ~15% ≈ ~162 event
  p95 ~15-25ms

auth-service:
  ~10% ≈ ~108 event
  p95 ~15-25ms

report-service:
  ~10% ≈ ~108 event
  p95 ~30-50ms

order-service (checkout):
  ~10% ≈ ~108 event
  p95 ~1600ms (có external_ms=30)

→ Đây là phân phối BIMODAL: 2 đỉnh
  - Đỉnh 1: ~5-25ms  (product, auth, cart) — 80% traffic
  - Đỉnh 2: ~50-1600ms (report, checkout)  — 20% traffic

→ p95 tổng 1617ms bị kéo bởi checkout
→ KHÔNG THỂ đọc p95 tổng mà kết luận "hệ thống chậm"
```

**Cách phát hiện**: So sánh `constant_arrival_event_duration_ms` theo tag `service`:

```text
Sai:
  "p95 tổng = 1617ms → hệ thống chậm"
Đúng:
  "p95 overall = 1617ms nhưng p95 products-service ~10ms,
   p95 order-service ~1600ms → checkout service là bottleneck"
```

### RC2: Noisy Neighbor — checkout/report ngốn VU pool, tiềm ẩn starve service nhanh

**Hiện tượng**: Dù product/auth rất nhanh, nhưng nếu checkout và report chiếm nhiều VU,
các slot product/auth có thể bị drop vì không còn VU rảnh.

**Nguyên nhân sâu**: Trong open model, VU pool là tài nguyên DÙNG CHUNG. Một service
chậm (checkout, W_eff cao) giữ VU lâu hơn → giảm số VU khả dụng cho service nhanh.

**Phân tích với Little's Law cho từng service**:

```text
Little's Law: L = λ × W

Với mỗi service trong mixed pool:
  L_service = λ_service × W_service

  product_list:   L = (18×0.30) × 0.005s = 5.4  × 0.005 = 0.027 VU → ~0 VU
  product_detail: L = (18×0.25) × 0.005s = 4.5  × 0.005 = 0.023 VU → ~0 VU
  cart_add:       L = (18×0.15) × 0.010s = 2.7  × 0.010 = 0.027 VU → ~0 VU
  auth_me:        L = (18×0.10) × 0.010s = 1.8  × 0.010 = 0.018 VU → ~0 VU
  report:         L = (18×0.10) × 0.020s = 1.8  × 0.020 = 0.036 VU → ~0 VU
  checkout:       L = (18×0.10) × 0.050s = 1.8  × 0.050 = 0.090 VU → ~0 VU

Tổng L = 0.027 + 0.023 + 0.027 + 0.018 + 0.036 + 0.090 ≈ 0.22 VU

→ Về lý thuyết, 18/s chỉ cần ~0.22 VU (!)
→ Nhưng thực tế Run 95 dùng active VU max = 11 VU (!)
→ Tại sao chênh lệch lớn như vậy?
```

**Khoảng cách lý thuyết ↔ thực tế**:

```text
Lý thuyết Little's Law tính W = backend latency THUẦN (5ms, 10ms, 50ms)
Nhưng thực tế còn có:
  1. k6 internal overhead (JS runtime, metric collection): +5-10ms
  2. Network RTT (k6 → server → k6): +5-20ms mỗi request
  3. VU scheduling jitter: VU không được giao slot ngay lập tức
  4. HTTP connection setup/teardown
  5. check() evaluation time

→ W_thực tế > W_backend_thuần rất nhiều
→ Với arrival rate 18/s, dù mỗi event "chỉ" 50-100ms thực tế:
  L = 18 × 0.080 ≈ 1.44 VU (đã lớn hơn nhiều)
→ Thêm checkout tail latency (p95=1617ms, không phải avg 50ms):
  tail VU demand có thể tăng đột biến trong bucket nhiều checkout
```

**Minh họa noisy neighbor bằng trace**:

```text
Timeline 1 giây với 18 slot:

t=0ms:   slot 1-6  đến → product_list (nhanh, ~10ms)    → trả VU lúc t=10ms
t=0ms:   slot 7-10 đến → product_detail (nhanh, ~10ms)   → trả VU lúc t=10ms
t=1ms:   slot 11-13 đến → cart_add (vừa, ~15ms)          → trả VU lúc t=16ms
t=1ms:   slot 14-15 đến → auth_me (vừa, ~15ms)           → trả VU lúc t=16ms
t=2ms:   slot 16-17 đến → report (chậm, ~30ms)           → trả VU lúc t=32ms
t=2ms:   slot 18 đến    → checkout (rất chậm, ~1600ms)   → GIỮ VU ĐẾN t=1602ms (!)

Đến t=1000ms (giây tiếp theo):
  - Các VU product/auth/cart đã trả về pool từ lâu
  - VU report có thể đã trả về (nếu là p50 ~20ms)
  - NHƯNG VU checkout VẪN ĐANG BẬN → giảm pool capacity
  - Nếu nhiều checkout cùng rơi vào các giây liên tiếp → VU pool cạn dần
  - Đến 1 lúc: slot mới đến, checkout cũ chưa xong → thiếu VU → DROP

→ Đây là "noisy neighbor": checkout (10% traffic) gây drop cho product_list (30% traffic)
→ Product_list vốn nhanh và vô tội, nhưng bị ảnh hưởng vì dùng chung VU pool
```

**Cách phát hiện noisy neighbor**:

```text
1. Xem constant_arrival_event_duration_ms breakdown theo service:
   - Nếu p95 checkout >> p95 product → checkout là neighbor ồn

2. Xem VU active theo thời gian (Execution timeline):
   - Nếu active VUs tăng khi checkout xuất hiện nhiều → xác nhận noisy neighbor

3. Xem dropped_iterations theo thời gian:
   - Drop có xuất hiện ở bucket có checkout không?
   - Nếu có → checkout đang starve service khác

4. Chạy variation: tăng checkout weight lên 30%:
   - Drop có tăng không?
   - Nếu có → checkout chính là noisy neighbor
```

### RC3: Drop budget = 5 không có nghĩa "5 drops luôn acceptable"

**Hiện tượng**: Học sinh đọc `maxDropped=5`, thấy test PASS → kết luận "5 drops OK".
Nhưng đây là **ngưỡng lab**, không phải production SLO.

**Phân tích drop budget**:

```text
Lab contract (case 07):
  maxDropped = 5
  5 / 1080 = 0.46% dropped rate
  → PASS nếu drops <= 5

Production SLO thường:
  checkout service:     0 drop  (mỗi drop = mất tiền)
  cart service:         0 drop  (mỗi drop = mất sale)
  product_list service: có thể chấp nhận 1-2 drops (read, cacheable)
  report service:       có thể chấp nhận vài drops (non-critical)

→ Cùng 5 drops, nhưng:
  - 5 drops ở checkout → unacceptable (mất 5 đơn hàng)
  - 5 drops ở product_list → có thể accept (user refresh là được)
  - 2 drops checkout + 3 product_list → vẫn unacceptable (checkout không được drop)

→ KHÔNG THỂ chỉ nhìn con số 5 mà kết luận
→ PHẢI drill service để biết DROP Ở ĐÂU
```

**Demo trace: 5 drops có ý nghĩa khác nhau**:

```text
Tình huống A: 5 drops, tất cả ở product_list
  - product_list weight 30%, expected ~324 events
  - 5/324 = 1.5% drop rate cho service này
  - Impact: 5 lần browse bị fail → user refresh → vẫn OK
  - Decision: CÓ THỂ accept nếu đây là lab test
  - Action: tăng nhẹ maxVUs nếu muốn zero drop

Tình huống B: 5 drops, tất cả ở checkout
  - checkout weight 10%, expected ~108 events
  - 5/108 = 4.6% drop rate cho service này
  - Impact: 5 đơn hàng bị mất → unacceptable trong mọi trường hợp
  - Decision: KHÔNG accept, phải fix
  - Action: tối ưu checkout service (giảm external_ms) HOẶC tăng maxVUs
            HOẶC tách checkout ra scenario riêng với VU pool riêng

Tình huống C: 5 drops, trải đều (1/checkout, 1/cart, 1/auth, 2/product)
  - Mỗi service mất <1% → nhìn tổng thì "nhẹ"
  - Nhưng vẫn có 1 checkout drop → 1 đơn hàng mất
  - Decision: phụ thuộc production SLO
  - Nếu SLO checkout = 0 drop → vẫn FAIL
```

**Bài học về drop budget**:

```text
1. Lab budget (5) ≠ production budget (thường 0 cho critical path)
2. Cùng con số drop, ý nghĩa KHÁC NHAU tùy service bị drop
3. Luôn drill service/operation khi có drop, KHÔNG chỉ nhìn tổng
4. Drop budget là công cụ DẠY HỌC: nó cho phép test "gần fail" để học cách
   đọc signal, thay vì test luôn zero-drop (không có gì để học)
```

### RC4: Aggregate p95 che giấu per-service reality

**Hiện tượng**: p95 tổng của `constant_arrival_event_duration_ms` = 1617ms.
Nhìn vào con số này, có vẻ "hệ thống chậm". Nhưng thực tế 80% traffic có p95 < 25ms.

**Công thức p95 tổng KHÔNG phải là trung bình các p95**:

```text
SAI:
  p95_tổng = avg(p95_product, p95_cart, p95_auth, p95_checkout, p95_report)
  → Đây là trung bình các p95, không có ý nghĩa thống kê

ĐÚNG:
  p95_tổng = percentile thứ 95 của TOÀN BỘ sample gộp lại
  → Nếu 90% sample nhanh (5-25ms) và 10% sample chậm (50-2000ms)
  → p95 sẽ nằm ở phần chậm nhất của nhóm nhanh + đầu nhóm chậm

Với 1081 sample:
  Sắp xếp tăng dần: [4, 5, 5, ..., 10, 10, ..., 25, ..., 50, ..., 1600, ...]
  Index p95 = 0.95 × 1081 ≈ 1027
  → Sample thứ 1027 nằm ở đâu?
  → ~973 sample đầu (< 90%) là product/auth/cart: 4-25ms
  → ~108 sample cuối (> 90%) là report/checkout: 30-2000ms
  → Sample thứ 1027 nằm trong nhóm checkout (~50-2000ms)
  → p95 ≈ 1617ms (bị checkout tail latency kéo)
```

**Drill per-service từ Run 95 (minh họa)**:

| Service | ~Events | p50 | p95 | p99 | Đánh giá |
| --- | ---: | ---: | ---: | ---: | --- |
| products-service | ~595 | ~5ms | ~10ms | ~20ms | Rất tốt |
| cart-service | ~162 | ~10ms | ~25ms | ~40ms | Tốt |
| auth-service | ~108 | ~10ms | ~25ms | ~40ms | Tốt |
| report-service | ~108 | ~20ms | ~50ms | ~80ms | Ổn |
| order-service (checkout) | ~108 | ~50ms | ~1600ms | ~2000ms | Bottleneck! |

```text
Kết luận:
  - 4/5 service nhanh (p95 <= 50ms) → hệ thống KHÔNG chậm
  - 1/5 service chậm (p95 = 1600ms) → checkout là bottleneck
  - p95 tổng 1617ms phản ánh checkout, không phải toàn hệ thống
  - Nếu chỉ nhìn p95 tổng → kết luận sai "hệ thống chậm"
  - Nếu drill service → kết luận đúng "checkout cần tối ưu"
```

**Cách đọc aggregate metric đúng**:

```text
Bước 1: Nhìn p95 tổng → biết CÓ vấn đề không
Bước 2: Drill theo service → biết vấn đề Ở ĐÂU
Bước 3: Drill theo operation → biết vấn đề CỤ THỂ operation nào
Bước 4: So sánh p95 từng service với SLO riêng của service đó
Bước 5: Kết luận THEO SERVICE, không kết luận toàn hệ thống
```

### RC5: Đây là open-model baseline mà ramping-arrival-rate kế thừa

**Hiện tượng**: Case 07 là case cuối cùng dùng constant-arrival-rate. Sau đó
là ramping-arrival-rate. Vì sao cần case này trước?

**Nguyên nhân**: Ramping-arrival-rate = constant-arrival-rate + arrival curve thay đổi.

```text
constant-arrival-rate:
  config:  rate=18, timeUnit=1s, duration=60s
  behavior: giữ 18/s trong 60s
  học được: VU pool sizing, drop signal, noisy neighbor, per-service drill

ramping-arrival-rate:
  config:  stages=[{duration:'2m', target:18}, {duration:'3m', target:30}, ...]
  behavior: thay đổi rate theo stages
  học được: TẤT CẢ những thứ trên + cách hệ thống phản ứng khi arrival rate THAY ĐỔI

→ Case 07 dạy phần "nền": mọi thứ về mixed open-model baseline
→ Ramping-arrival-rate dạy phần "động": thêm chiều thời gian thay đổi
→ Nếu chưa hiểu case 07 → không hiểu tại sao ramping-arrival-rate drop ở stage 30/s
→ Vì nguyên nhân drop vẫn là: noisy neighbor + VU pool không đủ
  Chỉ khác: rate cao hơn → áp lực VU pool lớn hơn → drop dễ xảy ra hơn
```

**Cầu nối cụ thể từ case 07 sang ramping-arrival-rate**:

| Kiến thức từ case 07 | Áp dụng cho ramping-arrival-rate |
| --- | --- |
| Mixed branch weights | Giữ nguyên weights khi ramp |
| VU pool sizing (preAllocated, maxVUs) | Cần tính lại cho rate cao nhất |
| Drop budget interpretation | Drop budget theo từng stage |
| Noisy neighbor identification | Noisy neighbor rõ hơn ở rate cao |
| Per-service drill | Drill service THEO TỪNG STAGE |
| Aggregate p95 che giấu per-service reality | Càng quan trọng khi rate thay đổi |
| VU active max < preAllocatedVUs | Có thể thấy VU spike ở stage cao |

## Identity model deep-dive

Trong constant-arrival-rate, VU và user là 2 khái niệm HOÀN TOÀN TÁCH BIỆT.
Đây là điểm quan trọng nhất để hiểu open model.

### VU = anonymous worker, KHÔNG phải business user

```text
Trong constant-vus / per-vu-iterations:
  VU ≈ business user (có session, cart, identity xuyên suốt)
  __VU dùng để map sang user ID

Trong constant-arrival-rate:
  VU = worker vô danh trong pool
  VU nhận slot từ scheduler → chạy iteration → trả VU về pool
  __VU KHÔNG map sang user ID cố định
  User ID đến từ userContext(seed, USER_POOL) → độc lập với VU
```

### Bảng identity model cho case 07

| Khía cạnh | Giá trị / cơ chế | Ý nghĩa |
| --- | --- | --- |
| VU identity | `__VU` = 1..maxVUs, VU tái sử dụng | Worker vô danh, không gắn với user |
| User identity | `arrival-user-${n}`, n = (iter % 1000) + 1 | 1000 user luân phiên qua iteration |
| User pool size | 1000 | Đủ lớn để mô phỏng production, tránh cache hit bias |
| User → VU mapping | KHÔNG CỐ ĐỊNH | Iter 1 của user-5 có thể do VU=3 chạy, iter 2 do VU=7 |
| Service identity | 6 service: products, cart, auth, order, report | Mỗi arrival được tag service/operation để drill |
| Request key | `car-prod-${seed}-${iter}-${vuId}` | Unique per arrival, dùng cho idempotency |
| AB variant | `iter % 2` → 'a' hoặc 'b' | Phân nửa traffic variant, dùng cho test A/B |

### User pool 1000 trải trên 6 service

```text
User pool = 1000 user ảo, phân bổ đều qua iteration:

Iter 1:    user = arrival-user-1   → branch = weightedPick(iter=1)
Iter 2:    user = arrival-user-2   → branch = weightedPick(iter=2)
...
Iter 1000: user = arrival-user-1000 → branch = weightedPick(iter=1000)
Iter 1001: user = arrival-user-1   → branch = weightedPick(iter=1001)
                                     (quay vòng)

→ Mỗi user xuất hiện ~1 lần trong 1080 iteration (1080/1000 ≈ 1.08)
→ User không có session xuyên suốt (không phải per-VU state)
→ Mỗi arrival là 1 event độc lập: 1 API call, 1 user, 1 service
→ Không có chuyện "user-5 login rồi browse rồi checkout"
  (đó là pattern của per-vu-iterations, không phải case này)
```

### Vì sao user pool 1000?

```text
1. Tránh cache hit bias:
   - Nếu chỉ có 10 user → product_list lặp lại cùng user → cache hit 100%
   - 1000 user → phân tán traffic → cache hit pattern giống production hơn

2. Đại diện production scale:
   - Production có hàng nghìn user concurrent
   - 1000 là con số đủ lớn để mô phỏng mà không quá nặng

3. User ID dùng cho distributed tracing:
   - Mỗi request có header X-User-ID: arrival-user-${n}
   - Backend log/dashboard có thể group theo user để trace
   - Nhưng user identity KHÔNG dùng để giữ state (vì là open model)

4. AB variant:
   - iter chẵn → variant 'a', iter lẻ → variant 'b'
   - 50/50 split, dùng để test A/B testing infrastructure
```

## Phân tích open model — "noisy neighbor" deep-dive

### Open model là gì và vì sao nó quan trọng ở case 07?

```text
Closed model (constant-vus, per-vu-iterations):
  - Số user/VU cố định
  - User xong việc → user "nghĩ" (think time) → user làm việc tiếp
  - Backend chậm → user "nghĩ" lâu hơn → throughput tự giảm
  - Không có khái niệm "drop" vì không có arrival schedule

Open model (constant-arrival-rate, ramping-arrival-rate):
  - Arrival rate từ bên ngoài cố định
  - Backend chậm → VU bận lâu hơn → cần thêm VU để giữ nhịp
  - Thiếu VU → drop (mất business event)
  - Hệ thống có thể "quá tải" mà không tự điều chỉnh
```

### Noisy neighbor trong open model: cơ chế đầy đủ

Noisy neighbor xảy ra khi một service (checkout) dùng VU lâu hơn các service khác,
làm giảm VU pool khả dụng. Trong open model, điều này nguy hiểm hơn closed model
vì **arrival rate không giảm** — k6 vẫn cố schedule 18 slot/s.

```text
Phân tích từng bước:

Bước 1: VU pool ban đầu
  preAllocatedVUs = 25 VU sẵn sàng
  maxVUs = 80 (trần cứng)

Bước 2: Giây 1 - 18 slot đến
  Branch mix: ~5 product_list, ~5 product_detail, ~3 cart_add, ~2 auth_me,
              ~2 report, ~1 checkout
  VU usage: 18 VU được giao 18 slot
  product/auth VU xong trong ~10ms → trả về pool
  checkout VU (1 cái) xong trong ~50ms (avg) → trả về pool sau

Bước 3: Giây 2 - thêm 18 slot đến
  18 VU mới được giao (từ pool ~25 VU)
  Nếu checkout giây trước chưa xong (tail latency) → VU đó vẫn bận
  → Pool còn 24 VU → vẫn OK, không drop

Bước 4: Giây N - "sóng" checkout trùng nhau
  Do randomness của weight, có thể có giây có 3-4 checkout
  3 checkout × ~50ms = 3 VU bị giữ lâu
  + các report cũng chậm (~20ms)
  + tổng VU bận > preAllocatedVUs (25)
  → k6 phải spawn thêm VU (lên đến maxVUs=80)
  → Nếu spawn không kịp → drop

Bước 5: Tích lũy checkout tail latency
  p95 checkout = 1617ms (không phải 50ms!)
  → 5% checkout event GIỮ VU hơn 1.6 GIÂY
  → Trong 1.6 giây đó, 1 VU bị "kẹt" với checkout
  → 1.6s × 18 slot/s = ~29 slot trôi qua trong lúc VU này bận
  → Nếu có 2-3 checkout tail latency cùng lúc → 2-3 VU bị kẹt dài
  → Số VU còn lại cho 29 slot kia giảm → áp lực spawn VU mới
```

### Mô phỏng noisy neighbor qua công thức

```text
Gọi:
  N_checkout = số checkout event đang chạy đồng thời
  W_checkout = thời gian mỗi checkout (avg ~50ms, p95 ~1600ms)
  N_other = số event khác đang chạy
  W_other = thời gian mỗi event khác (~10ms)
  V_total = tổng VU đang bận

V_total = N_checkout + N_other (mỗi event dùng 1 VU)

Với avg latency (trường hợp bình thường):
  V_total ≈ 18 × 0.030 ≈ 0.54 VU → rất thấp, không vấn đề

Với p95 latency (trường hợp xấu):
  Giả sử checkout p95 = 1600ms
  Nếu có 1 checkout tail → V_checkout = 1 VU bận trong 1.6s
  Trong 1.6s → 1.6 × 18 ≈ 29 slot mới đến
  Các slot này cần VU, nhưng 1 VU đã bị checkout giữ
  → Cần 29 VU khác + 1 VU checkout = 30 VU đồng thời
  → preAllocatedVUs=25 không đủ
  → Phải spawn thêm 5 VU (lên 30)
  → Vẫn dưới maxVUs=80 → spawn được → không drop

  Nhưng nếu có 2 checkout tail + 1 report tail:
  → 2 × 1.6s + 1 × 0.05s ≈ 3.25 VU bị giữ dài
  → Trong 1.6s → 29 slot → cần 29 + 3 = 32 VU
  → Spawn từ 25 lên 32 → OK (dưới 80)

  Nếu có 4 checkout tail:
  → 4 × 1.6s = 6.4 VU bị giữ dài
  → Trong 1.6s → 29 slot → cần 29 + 4 = 33 VU
  → Vẫn OK

  Vậy vì sao Run 95 có max active VU = 11?
  → Vì checkout tail (p95=1617ms) hiếm (chỉ 5% của 10% = 0.5% event)
  → Trong 1080 event, ~5 event có checkout > 1600ms
  → Không đủ nhiều để gây áp lực VU lớn
  → 11 VU là đủ cho toàn bộ 60s
```

### Khi nào noisy neighbor thực sự gây drop?

```text
Điều kiện để noisy neighbor gây drop:
  1. Tỷ lệ service chậm (checkout) CAO trong bucket
  2. Service chậm có tail latency DÀI
  3. preAllocatedVUs THẤP hơn peak demand
  4. maxVUs không kịp spawn (spawn rate limit của k6)

→ Với Run 95: 0 drop, vì preAllocatedVUs=25 >> peak demand=11
→ Nhưng nếu checkout weight tăng lên 30% (thay vì 10%):
  - Số checkout event tăng gấp 3
  - Xác suất checkout tail latency đồng thời tăng
  - VU demand tăng → có thể chạm maxVUs → drop
→ Xem Variation 2 bên dưới để kiểm chứng
```

## Bảng service/API flow

Case 07 gồm 6 branch, mỗi branch = 1 arrival event = 1 API call.
Đây là điểm khác với case 04 checkout-order-intake (multi-step) hay case 05 (async).

### Master flow table

| Branch | Weight | Service | Operation tag | Endpoint | Method | Work profile | Expected ~count (1080 total) |
| --- | ---: | --- | --- | --- | --- | --- | ---: |
| product_list | 30% | products-service | production_arrival_product_list | GET /api/sim/products | GET | cpu=1ms, db=2rows | ~324 |
| product_detail | 25% | products-service | production_arrival_product_detail | GET /api/sim/products/:id | GET | cpu=1ms, db=1row | ~270 |
| cart_add | 15% | cart-service | production_arrival_cart_add | POST /api/sim/cart/add | POST | cpu=1ms, db_write=1, mem=4KB | ~162 |
| auth_me | 10% | auth-service | production_arrival_auth_me | GET /api/sim/auth/me | GET | cpu=1ms, db=1row, mem=4KB | ~108 |
| report | 10% | report-service | production_arrival_report | GET /api/sim/report | GET | cpu=1ms, db=1row, gzip=1KB | ~108 |
| checkout | 10% | order-service | production_arrival_checkout | POST /api/sim/checkout | POST | cpu=2ms, db_write=1, ext=30ms | ~108 |

### Products-service (55% combined: product_list + product_detail)

```text
products-service chịu 55% total traffic (~595/1080 event).
Đây là service đọc (read-heavy), latency thấp.

product_list (30%, ~324 event):
  GET /api/sim/products?limit=8&sort=popular&view=grid&cpu_ms=1&db_rows=2
  → Trả về danh sách 8 sản phẩm phổ biến
  → Work: 1ms CPU + 2 rows DB query → W_eff ~3ms
  → Baseline latency: ~5ms
  → Cacheable: có (query params cố định → CDN/Redis cache hit cao)

product_detail (25%, ~270 event):
  GET /api/sim/products/${productId}?view=full&cpu_ms=1&db_rows=1
  → productId = ((iter * 17) % 50) + 1  (50 sản phẩm, phân bổ pseudo-random)
  → Work: 1ms CPU + 1 row DB query → W_eff ~2ms
  → Baseline latency: ~5ms
  → Cacheable: một phần (50 product, cache hit ~80-90%)
```

### Cart-service (15%, ~162 event)

```text
cart_add (15%, ~162 event):
  POST /api/sim/cart/add?cpu_ms=1&db_writes=1&memory_kb=4
  Body: {product_id: number, quantity: 1}
  → Thêm 1 sản phẩm vào giỏ hàng
  → Work: 1ms CPU + 1 DB write + 4KB memory → W_eff ~8ms
  → Baseline latency: ~10ms
  → NOT cacheable (write operation)
  → product_id = ((iter * 17) % 50) + 1 (cùng formula với detail)
```

### Auth-service (10%, ~108 event)

```text
auth_me (10%, ~108 event):
  GET /api/sim/auth/me?cpu_ms=1&db_rows=1&memory_kb=4
  Header: Authorization: Bearer car-prod-${userId}
  → Validate token, trả về user info
  → Work: 1ms CPU + 1 row DB + 4KB memory → W_eff ~8ms
  → Baseline latency: ~10ms
  → Token unique per user (userId thay đổi theo iter)
```

### Report-service (10%, ~108 event)

```text
report (10%, ~108 event):
  GET /api/sim/report?cpu_ms=1&db_rows=1&gzip_kb=1
  → Lấy report data (dashboard/metrics summary)
  → Work: 1ms CPU + 1 row DB + 1KB gzip compression → W_eff ~15ms
  → Baseline latency: ~20ms
  → Có gzip overhead → chậm hơn product/auth
```

### Order-service (10%, ~108 event)

```text
checkout (10%, ~108 event):
  POST /api/sim/checkout?cpu_ms=2&db_writes=1&external_ms=30&external_fail_rate=0
  Body: {payment_method: 'card', items: [{id: productId, qty: 1}]}
  Header: Idempotency-Key: car07-checkout-${requestKey}
  → Thanh toán đơn hàng
  → Work: 2ms CPU + 1 DB write + 30ms external call → W_eff ~35ms
  → Baseline latency: ~50ms (có external call 30ms)
  → External call = mô phỏng payment gateway
  → Đây là service CHẬM NHẤT, là bottleneck chính
```

### Mỗi event = đúng 1 API call

```text
Điểm khác biệt với các case multi-step:

Case 04 (checkout-order-intake): mỗi arrival = 2-3 bước (create order,
  verify, confirm) → multi-step flow
Case 05 (report-api-ingress): có async job → event duration > single API call
Case 07: mỗi arrival = 1 API call duy nhất

→ constant_arrival_api_calls_total ≈ iterations ≈ http_reqs
→ Mỗi iteration = 1 lần gọi requestJson() + finishEvent()
→ Đơn giản hơn case 04/05, NHƯNG phức tạp ở chỗ mixed services
```

## Metrics & tags deep-dive

### Tất cả custom metrics trong case 07

| Metric | Type | Tags | Ý nghĩa |
| --- | --- | --- | --- |
| `constant_arrival_events_total` | Counter | case_id, service, operation, user_id | Tổng số arrival event đã hoàn thành |
| `constant_arrival_events_failed` | Counter | case_id, service, operation, user_id | Số arrival event thất bại (check fail) |
| `constant_arrival_api_calls_total` | Counter | case_id, service, operation, endpoint, user_id | Tổng số API call đã thực hiện |
| `constant_arrival_event_duration_ms` | Trend | case_id, service, operation, user_id | Thời gian hoàn thành mỗi arrival event (ms) |

### Tags chi tiết cho case 07

```text
case_id:    "car-07-production-ingress-mix"
service:    "products-service" | "cart-service" | "auth-service" |
            "order-service" | "report-service" | "mixed-services"
operation:  "production_arrival_product_list" | "production_arrival_product_detail" |
            "production_arrival_cart_add" | "production_arrival_auth_me" |
            "production_arrival_report" | "production_arrival_checkout" |
            "production_product_list_arrival" | ... (finishEvent tag)
endpoint:   "GET /api/sim/products" | "GET /api/sim/products/:id" |
            "POST /api/sim/cart/add" | "GET /api/sim/auth/me" |
            "GET /api/sim/report" | "POST /api/sim/checkout"
user_id:    "arrival-user-1" ... "arrival-user-1000"
```

### Vì sao service/operation tags là CRITICAL?

```text
KHÔNG có service/operation tags:
  - Chỉ thấy p95 tổng = 1617ms
  - Không biết service nào chậm
  - Không biết drop đến từ đâu
  - Kết luận mù mờ: "hệ thống chậm, cần thêm resource"
  - Action sai: scale up toàn bộ cluster (tốn tiền, không giải quyết gốc)

CÓ service/operation tags:
  - Drill p95 theo service: products ~10ms, checkout ~1600ms
  - Biết checkout là bottleneck
  - Drill dropped theo service: biết drop đến từ checkout hay product
  - Kết luận chính xác: "checkout service cần tối ưu external call"
  - Action đúng: optimize checkout service HOẶC tăng VU pool
```

### Cách drill per-service từ aggregate metrics

Trên dashboard (cloud output hoặc local summary), dùng filter:

```text
Filter: service=order-service
  → constant_arrival_events_total: ~108
  → constant_arrival_event_duration_ms p95: ~1600ms
  → constant_arrival_events_failed: 0

Filter: service=products-service
  → constant_arrival_events_total: ~595
  → constant_arrival_event_duration_ms p95: ~10ms
  → constant_arrival_events_failed: 0

Filter: service=cart-service
  → constant_arrival_events_total: ~162
  → constant_arrival_event_duration_ms p95: ~25ms
  → constant_arrival_events_failed: 0

Filter: service=auth-service
  → constant_arrival_events_total: ~108
  → constant_arrival_event_duration_ms p95: ~25ms
  → constant_arrival_events_failed: 0

Filter: service=report-service
  → constant_arrival_events_total: ~108
  → constant_arrival_event_duration_ms p95: ~50ms
  → constant_arrival_events_failed: 0
```

### Tạo per-service sub-analysis từ aggregate metrics (thủ công)

Nếu dashboard không hỗ trợ filter theo tag, có thể dùng `jq` hoặc script để phân tích:

```powershell
# Lấy summary JSON từ cloud output
$summary = Get-Content .\summary.json | ConvertFrom-Json

# Lọc metrics theo service
$summary.metrics | Where-Object { $_.tags.service -eq "order-service" }
```

Hoặc dùng `k6 run --summary-export=summary.json` rồi phân tích offline.

### Mối quan hệ giữa các metrics

```text
constant_arrival_events_total ≈ iterations ≈ http_reqs ≈ constant_arrival_api_calls_total

Với case 07 (mỗi event = 1 API call):
  iterations:              1081  (1080 scheduled - 0 dropped + có thể lệch ±1)
  http_reqs:               1081  (mỗi iteration = 1 HTTP request)
  constant_arrival_events_total:  1081
  constant_arrival_api_calls_total: 1081
  dropped_iterations:      0

Nếu có case multi-step (như case 04):
  http_reqs > iterations  (mỗi iteration có nhiều request)

Với case 07 đơn giản:
  http_reqs = iterations  (1 iteration = 1 request)
```

## Pass criteria — mở rộng

### Ngưỡng chính

| Check | Ngưỡng | Vì sao ngưỡng này? |
| --- | --- | --- |
| `dropped_iterations` | `count <= 5` | Lab budget cho phép tối đa 5 drops (~0.46%). Dạy cách đọc drop budget nhỏ. |
| `checks` | `rate > 0.98` | Cho phép tối đa 2% check fail. Rộng hơn case đơn service (0.99) vì mixed 6 service có nhiều variance. |
| `http_req_failed` | `rate < 0.02` | HTTP fail < 2%. Rộng hơn case đơn service (0.01) cùng lý do. |
| `constant_arrival_events_failed` | `count < 20` | Tối đa 20 event fail (~1.85%). Cho phép một lượng nhỏ fail để dạy drill-down. |
| `iterations` | gần `1080 - dropped` | Số iteration hoàn thành phải gần scheduled slots trừ drops. |
| `constant_arrival_events_total` | gần `iterations` | Mỗi iteration = 1 event (case đơn giản, 1 event = 1 API call). |
| `constant_arrival_api_calls_total` | gần `http_reqs` | Mỗi event = 1 API call. |

### Vì sao thresholds "rộng" hơn các case đơn service?

```text
Case 01 (storefront):     checks>0.99, http_req_failed<0.01, events_failed<10
Case 02 (auth):           checks>0.99, http_req_failed<0.01, events_failed<10
Case 03 (cart):           checks>0.99, http_req_failed<0.01, events_failed<10
...
Case 07 (production mix): checks>0.98, http_req_failed<0.02, events_failed<20, drops<=5

Lý do:
1. Mixed 6 service → tổng variance cao hơn 1 service
2. Checkout có external call (external_ms=30) → có thể có network jitter
3. Report có gzip → compression time khác nhau theo data size
4. 1080 event (nhiều hơn case đơn 900 event) → xác suất gặp outlier cao hơn
5. Đây là LAB threshold để dạy drill-down. Production phải chặt hơn.
```

### Per-service sub-thresholds (không có trong script, nhưng nên tự đặt)

```text
Khi áp vào production, team NÊN đặt sub-thresholds cho từng service:

products-service:
  p95 < 20ms, fail rate < 0.5%

cart-service:
  p95 < 50ms, fail rate < 0.1%, 0 drop (critical write path)

auth-service:
  p95 < 30ms, fail rate < 0.5%

order-service (checkout):
  p95 < 2000ms, fail rate < 0.1%, 0 drop (CRITICAL: liên quan đến tiền)

report-service:
  p95 < 100ms, fail rate < 1% (non-critical, có thể retry)

→ Script hiện tại không có sub-thresholds (chỉ dùng 1 threshold tổng)
→ Nhưng KHI ĐỌC output, phải tự áp dụng sub-thresholds để đánh giá
→ Đây là điểm trưởng thành: từ "test pass/fail" → "đánh giá chất lượng per service"
```

### Pass/fail decision tree cho case 07

```text
1. drops <= 5?
   ├─ NO  → FAIL (contract breach). Drill service để tìm nguyên nhân.
   └─ YES → tiếp tục

2. drops > 0?
   ├─ YES → kiểm tra service nào bị drop
   │        ├─ checkout/cart/auth → unacceptable dù <=5 → INVESTIGATE
   │        └─ product_list/report → có thể accept nếu là lab → PASS with warning
   └─ NO  → tiếp tục

3. checks > 0.98?
   ├─ NO  → FAIL. Drill service/operation để tìm check nào fail.
   └─ YES → tiếp tục

4. constant_arrival_events_failed < 20?
   ├─ NO  → FAIL. Drill service để tìm service nào có event fail.
   └─ YES → tiếp tục

5. http_req_failed < 0.02?
   ├─ NO  → FAIL. HTTP errors, kiểm tra backend.
   └─ YES → tiếp tục

6. Per-service p95 trong ngưỡng?
   ├─ NO  → PASS with warning. Note service nào chậm.
   └─ YES → PASS hoàn toàn.

→ Run 95: drops=0, checks=100%, failed=0, http_failed=0%
→ Tất cả bước 1-5 PASS
→ Bước 6: checkout p95=1617ms (hơi cao nhưng trong ngưỡng sub-threshold 2000ms)
→ Kết luận: PASS. Checkout cần monitoring thêm.
```

## Cách chạy

### Local với cloud output

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-07-production-ingress-mix.js"
```

### Env override để tùy chỉnh

```powershell
# Thay đổi rate
$env:CAR_07_RATE = "18"
# Thay đổi time unit
$env:CAR_07_TIME_UNIT = "1s"
# Thay đổi duration
$env:CAR_07_DURATION = "60s"
# Thay đổi preAllocatedVUs
$env:CAR_07_PREALLOCATED_VUS = "25"
# Thay đổi maxVUs
$env:CAR_07_MAX_VUS = "80"
# Thay đổi max dropped
$env:CAR_07_MAX_DROPPED = "5"
# Thay đổi user pool
$env:CAR_07_USER_POOL = "1000"
```

### Smoke test (giảm duration về 10s)

```powershell
$env:CAR_07_DURATION = "10s"
$env:CAR_07_MAX_DROPPED = "1"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-07-production-ingress-mix.js"
```

### Verify dashboard

```text
1. Mở http://localhost:13001
2. Paste student-token-1234567890
3. Click vào run mới nhất
4. Overview KPI:
   - iterations ≈ 1080 (±5)
   - http_reqs ≈ iterations
   - dropped_iterations <= 5
   - checks > 98%
5. Response time chart:
   - Drill theo service tag để thấy sự khác biệt products vs checkout
6. Execution timeline:
   - iter/s gần 18/s trong suốt 60s
   - Live VUs dao động, max ~11
7. VUs vs iter/s:
   - Executor VUs = maxVUs (80)
   - Observed VUs thấp hơn nhiều (chỉ ~11)
8. Executor tab:
   - executor = constant-arrival-rate
   - rate/timeUnit/duration = 18/1s/60s
```

## Phân tích output 5 bước

Áp dụng quy trình 5 bước phân tích output cho case 07.

### Bước 1: Header/config verification

```text
Read header:
  executor = constant-arrival-rate
  rate = 18
  timeUnit = 1s
  duration = 60s
  preAllocatedVUs = 25
  maxVUs = 80

Verify:
  rate × (duration / timeUnit) = 18 × 60 = 1080 expected slots ✓
  preAllocatedVUs = 25 ✓
  maxVUs = 80 ✓
```

### Bước 2: Expected slots calculation

```text
Công thức:
  scheduled_slots = rate × duration / timeUnit
                  = 18 × 60 / 1
                  = 1080 arrivals

Mỗi arrival = 1 iteration được schedule.
Branch mix được quyết định bởi weightedPick() khi iteration bắt đầu.
```

### Bước 3: Summary count verification

```text
Từ Run 95:
  iterations................: 1081
  http_reqs..................: 1081
  dropped_iterations.........: 0
  checks.....................: 100% (1081/1081)
  http_req_failed............: 0.00%
  constant_arrival_events_total: 1081
  constant_arrival_events_failed: 0
  constant_arrival_api_calls_total: 1081

Verify:
  iterations ≈ scheduled_slots - dropped = 1080 - 0 = 1080 ✓ (lệch 1, OK)
  http_reqs = iterations = 1081 ✓ (mỗi event = 1 API call)
  dropped_iterations = 0 <= 5 ✓
  checks rate = 100% > 98% ✓
  http_req_failed = 0% < 2% ✓
  events_failed = 0 < 20 ✓

Kết luận bước 3: Tất cả count OK. Không có dấu hiệu bất thường.
```

### Bước 4: Per-service breakdown (BƯỚC QUAN TRỌNG NHẤT)

Đây là bước phân biệt case 07 với các case đơn service. KHÔNG dừng ở aggregate.

```text
4a. Phân bổ event theo service (dự kiến từ weight):

  products-service:  ~595 event (30% + 25%)
    product_list:    ~324 event
    product_detail:  ~270 event

  cart-service:      ~162 event (15%)
    cart_add:        ~162 event

  auth-service:      ~108 event (10%)
    auth_me:         ~108 event

  report-service:    ~108 event (10%)
    report:          ~108 event

  order-service:     ~108 event (10%)
    checkout:        ~108 event

4b. Event duration theo service (từ Run 95, minh họa):

  products-service:
    p50 ~5ms, p95 ~10ms, p99 ~20ms
    → Rất nhanh, well within any SLO

  cart-service:
    p50 ~10ms, p95 ~25ms, p99 ~40ms
    → Tốt

  auth-service:
    p50 ~10ms, p95 ~25ms, p99 ~40ms
    → Tốt

  report-service:
    p50 ~20ms, p95 ~50ms, p99 ~80ms
    → Ổn, hơi cao hơn do gzip compression

  order-service (checkout):
    p50 ~50ms, p95 ~1600ms, p99 ~2000ms
    → CHẬM, external call 30ms gây tail latency lớn

4c. Failed events theo service:
  Tất cả service: 0 failed
  → Không có service nào bị lỗi

4d. Dropped iterations theo service (nếu có):
  Run 95: 0 dropped → không cần drill
  Nếu có drop: KIỂM TRA service nào có drop
  → Nếu checkout bị drop → CRITICAL
  → Nếu product_list bị drop → warning, có thể accept

4e. Kết luận per-service:
  - 4/5 service nhanh và ổn định
  - 1/5 service (checkout) có tail latency cao
  - Không có drop, không có fail
  - Hệ thống tổng thể khỏe mạnh
  - Checkout là điểm cần monitoring thêm
```

### Bước 5: Business conclusion

```text
Từ Run 95:
  - 1081 arrivals hoàn thành, 0 drops
  - 100% checks pass, 0% HTTP fail
  - Mixed baseline đạt contract lab
  - p95 tổng = 1617ms (cao, nhưng không vi phạm threshold vì threshold đo
    bằng drops/fails, không phải latency)
  - Per-service drill: checkout là bottleneck (external 30ms)
  - VU active max = 11, thấp hơn preAllocatedVUs=25 → dư headroom
  - Hệ thống có thể chịu được rate cao hơn hoặc checkout weight cao hơn

Decision:
  ✓ PASS – mixed ingress baseline đạt yêu cầu
  ⚠ Warning – checkout p95 cao, cần monitoring khi rate tăng
  → Sẵn sàng chuyển sang ramping-arrival-rate
```

### Bảng ánh xạ output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 1081 iter, 0 drop, checks 100% | Baseline đạt contract | Sẵn sàng cho ramping-arrival-rate |
| 0-5 drops, đều ở product_list | Read path hơi yếu | Accept (lab), tăng VU nếu muốn 0 drop |
| 0-5 drops, có checkout drop | CRITICAL: mất đơn hàng | KHÔNG accept. Tối ưu checkout hoặc tăng VU pool. |
| Drops > 5 | Contract breach | Xác định service gây drop, fix hoặc resize VU pool |
| checkout p95 > 2000ms | Checkout quá chậm | Tối ưu external call, xem xét async pattern |
| events_failed > 0, tập trung 1 service | Service đó có bug | Điều tra service cụ thể, không kết luận toàn hệ thống |
| active VU max gần maxVUs | VU pool gần cạn | Tăng maxVUs hoặc giảm event duration |

## Dashboard 3-chart deep analysis

Sau khi chạy với cloud output, mở dashboard để đọc 3 chart + Executor tab.
Phần này dùng dữ liệu minh họa từ Run 95 và các run tương tự.

### Chart 1 — Response time (CRITICAL: drill by service)

Chart này có JSON debug dạng:

```text
Debug JSON: response-time
```

**Điểm đặc biệt của case 07**: KHÔNG đọc chart này ở aggregate level. Phải drill
theo tag `service` hoặc `operation`.

```text
Nếu chỉ nhìn response time aggregate:
  - avg ~50ms (trung bình của tất cả service)
  - p95 ~1600ms (bị checkout kéo)
  - max ~3000ms (checkout tail)
  → Hình ảnh méo mó: "hệ thống có request rất chậm"

Nếu drill theo service:
  - products-service: avg ~5ms, p95 ~10ms → RẤT NHANH
  - cart-service:     avg ~10ms, p95 ~25ms → NHANH
  - auth-service:     avg ~10ms, p95 ~25ms → NHANH
  - report-service:   avg ~20ms, p95 ~50ms → ỔN
  - order-service:    avg ~50ms, p95 ~1600ms → CHẬM (checkout)

→ Kết luận ĐÚNG: "4/5 service nhanh, checkout chậm"
```

**Các series chính trong chart**:

```text
Avg response
Batch p95
Batch max
```

**Cách đọc chart với drill-down**:

```text
1. Nhìn aggregate trước: có spike không? p95 cao bất thường không?
2. Drill theo service: service nào kéo p95 lên?
3. Drill theo operation: operation nào trong service đó chậm?
4. So sánh p95 per-service với SLO riêng
5. Kết luận per-service, không kết luận aggregate
```

**Shape mong đợi cho case 07**:

```text
Đầu run (0-5s):
  - Response time có thể cao hơn (cold start, VU init)
  - Tất cả service đều có thể bị ảnh hưởng

Giữa run (5-55s):
  - products/auth/cart: p95 ổn định thấp (5-25ms)
  - report: p95 ổn định vừa (30-50ms)
  - checkout: p95 dao động, có thể có spike (50-2000ms)
  - Shape tổng: p95 aggregate dao động theo bucket checkout

Cuối run (55-60s):
  - Các service nhanh vẫn ổn định
  - Checkout vẫn có tail latency
  - Không có dấu hiệu degradation theo thời gian
```

**Các shape bất thường**:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 tất cả service cùng tăng | Vấn đề hệ thống (network, DB, K8s) | Điều tra infrastructure |
| Chỉ checkout p95 tăng | External call chậm (payment gateway) | Kiểm tra external dependency |
| p95 tăng dần theo thời gian | Memory leak, DB connection leak | Soi stateful bug, GC pattern |
| p95 products/auth đột ngột tăng | Noisy neighbor: checkout chiếm hết resource | Kiểm tra correlation với checkout volume |
| avg thấp nhưng p95 cao ở 1 service | Tail latency của service đó | Tối ưu service đó, không scale toàn bộ |

**Ghi nhớ quan trọng**:

```text
- Batch p95 ở từng bucket != summary p95 cuối test
- Summary p95 tính trên toàn bộ sample, Batch p95 tính trên bucket 1 giây
- Khi drill service, nhớ rằng mỗi bucket có ít sample cho service lẻ
  (vd: bucket 1 giây chỉ có ~2 checkout event → p95 của 2 sample không có
  ý nghĩa thống kê)
- Drill service nên nhìn TREND theo thời gian, không nhìn single bucket
```

### Chart 2 — Execution timeline (18/s sustained for 60s)

Chart này có JSON debug dạng:

```text
Debug JSON: execution-timeline
```

**Ý nghĩa đặc biệt cho case 07**:

```text
Đây là chart kiểm tra "có giữ được 18/s trong suốt 60s không?"

Các series:
  Live VUs: số VU đang active trong bucket
  RPS / httpReqs: số HTTP request hoàn thành trong bucket
  iterations: số iteration hoàn thành trong bucket
```

**Kỳ vọng cho case 07**:

```text
iterations/bucket ≈ 18 (target rate)
http_reqs/bucket ≈ 18 (mỗi iteration = 1 request)
Live VUs dao động 5-15 (tùy bucket có nhiều checkout không)
dropped_iterations = 0 (hoặc <= 5 nếu có)

Nếu có bucket iterations < 18:
  → Có drop trong bucket đó
  → Xem Live VUs bucket đó có chạm maxVUs không?
  → Xem response time bucket đó có spike không?
  → Xem bucket đó có nhiều checkout/report không?
```

**Minh họa execution timeline cho 10 bucket đầu**:

| Time bucket | Live VUs | iter/s | httpReqs | Ghi chú |
| --- | ---: | ---: | ---: | --- |
| 00:00 | 5 | 0 | 0 | Đang ramp-up |
| 00:01 | 8 | 18 | 18 | Đạt target |
| 00:02 | 10 | 18 | 18 | Đạt target |
| 00:03 | 9 | 17 | 17 | Hơi hụt (có checkout?) |
| 00:04 | 11 | 18 | 18 | Đạt target |
| 00:05 | 8 | 18 | 18 | Đạt target |
| 00:06 | 10 | 18 | 18 | Đạt target |
| 00:07 | 11 | 18 | 18 | Nhiều VU hơn (checkout tail?) |
| 00:08 | 9 | 18 | 18 | Đạt target |
| 00:09 | 8 | 18 | 18 | Đạt target |

```text
Nhận xét:
  - iter/s ổn định ở 18 (lệch ±1 là bình thường)
  - Live VUs dao động 8-11 → VU demand thay đổi theo branch mix
  - Bucket 00:03: iter/s=17 → có thể 1 checkout tail kéo dài từ bucket trước
  - Bucket 00:07: VUs=11 cao hơn → có thể vài checkout/report đồng thời
  - Nhìn chung: 18/s được duy trì ổn định trong 60s
```

**Cách phân tích sâu**:

```text
1. Kiểm tra Live VUs:
   - Có bucket nào Live VUs = maxVUs (80) không?
     → Nếu có: VU pool cạn, nguy cơ drop cao
   - Live VUs có tăng dần theo thời gian không?
     → Nếu có: VU leak hoặc event duration tăng dần

2. Kiểm tra iter/s:
   - Có bucket nào iter/s thấp hơn 18 đáng kể không?
     → Nếu có: drop hoặc event quá dài
   - Tổng iter/s các bucket có ≈ 1080 không?

3. Kiểm tra correlation với Response time:
   - Bucket có VUs cao → response time có cao không?
     → Nếu có: checkout/report đang gây áp lực
   - Bucket có VUs thấp → response time có thấp không?
     → Nếu có: bucket đó ít checkout → "may mắn"

4. Kiểm tra dropped_iterations:
   - Drop xuất hiện ở bucket nào?
   - Bucket đó có gì đặc biệt? (nhiều checkout? VUs cao?)
```

**Shape đúng cho constant-arrival-rate mixed**:

```text
- Live VUs: dao động quanh 8-15, không chạm maxVUs
- iter/s: ổn định 17-19/s, không tụt kéo dài
- httpReqs: ≈ iter/s (mỗi event = 1 call)
- Không có drop (hoặc rất ít, <=5)

Đây là shape của "open model hoạt động đúng":
  - VU pool đủ lớn cho latency profile hiện tại
  - Arrival rate được duy trì ổn định
  - Không có service nào gây drop
```

### Chart 3 — VUs vs iter/s (VU demand varies by bucket)

Chart này có JSON debug dạng:

```text
Debug JSON: vus-vs-iterations
```

**Series chính**:

```text
Executor VUs: đường envelope của executor (maxVUs=80)
Observed VUs: VU thực tế quan sát được (dao động 5-15)
Actual iter/s: iteration hoàn thành trong mỗi bucket (~18/s)
```

**Điểm đặc biệt của case 07 trên chart này**:

```text
Executor VUs = 80 (maxVUs) → đường envelope cao
Observed VUs = 5-15 → THẤP HƠN NHIỀU so với envelope

→ Khoảng cách lớn giữa Executor VUs và Observed VUs là BÌNH THƯỜNG
→ Nó cho thấy VU pool có nhiều HEADROOM
→ Hệ thống có thể chịu được rate cao hơn hoặc checkout weight cao hơn

Nếu Observed VUs tiến gần 80:
  → VU pool gần cạn → nguy cơ drop
  → Cần tăng maxVUs hoặc giảm event duration
```

**Phân tích VU demand theo bucket**:

```text
Bucket có Observed VUs thấp (5-8):
  → Branch mix trong bucket đó thiên về product/auth (nhanh)
  → Event duration ngắn → VU trả về pool nhanh → ít VU đồng thời

Bucket có Observed VUs cao (10-15):
  → Branch mix trong bucket đó có nhiều checkout/report (chậm)
  → Event duration dài → VU bận lâu → nhiều VU đồng thời

→ Sự dao động của Observed VUs PHẢN ÁNH branch mix theo bucket
→ Đây là behavior BÌNH THƯỜNG cho mixed baseline
→ KHÔNG phải là dấu hiệu bất ổn
```

**Cách đọc Actual iter/s**:

```text
Actual iter/s dao động 16-20/s
Tổng Actual iter/s toàn chart ≈ 1080 (hoặc 1081)

→ iter/s ổn định quanh 18/s → arrival rate được duy trì
→ Dao động ±2 là do randomness của weightedPick và event duration
→ KHÔNG kỳ vọng iter/s = chính xác 18 mỗi bucket
```

### Executor tab

Chuyển sang tab:

```text
Executor
```

Dashboard detect đúng:

```text
EXECUTOR = constant-arrival-rate
```

**Kiểm tra các thông số**:

```text
rate = 18
timeUnit = 1s
duration = 60s
preAllocatedVUs = 25
maxVUs = 80
maxDroppedIterations = 5
```

**Chart Executor behavior**:

```text
Series:
  Fixed VUs: envelope = maxVUs (80)
  Observed VUs: VU thực tế theo bucket (5-15)
  Actual iter/s: iteration rate theo bucket (~18/s)
  Peak if all active: throughput tối đa nếu tất cả VU cùng chạy
```

**Cách đọc cho case 07**:

```text
1. Fixed VUs = 80:
   → Đây là TRẦN, không phải target
   → Hệ thống được phép dùng đến 80 VU nếu cần
   → Run 95 chỉ dùng 11 → còn rất nhiều headroom

2. Observed VUs = 5-15:
   → Số VU thực tế cần để giữ 18/s
   → Thấp hơn preAllocatedVUs=25 → 25 VU pre-allocated là dư
   → Có thể giảm preAllocatedVUs nếu muốn tiết kiệm resource

3. Actual iter/s ≈ 18/s:
   → Đạt target rate
   → Ổn định trong suốt 60s

4. Peak if all active:
   → Nếu cả 80 VU cùng chạy → throughput lý thuyết rất cao
   → Nhưng mixed latency profile không cho phép (checkout chậm)
   → Khoảng cách Actual vs Peak là BÌNH THƯỜNG
```

**Checklist Executor tab cho case 07**:

```text
[ ] executor = constant-arrival-rate
[ ] rate = 18, timeUnit = 1s, duration = 60s
[ ] preAllocatedVUs = 25, maxVUs = 80
[ ] dropped_iterations <= 5, khớp summary
[ ] Fixed VUs = 80 (maxVUs envelope)
[ ] Observed VUs < Fixed VUs (bình thường, có headroom)
[ ] Actual iter/s ≈ 18/s, ổn định
[ ] Không có dấu hiệu VU leak (Observed VUs tăng dần không giảm)
```

## 4 output → decision scenarios

### Scenario A: Perfect pass (Run 95)

```text
Output:
  iterations...............: 1081
  dropped_iterations.......: 0
  checks...................: 100%
  http_req_failed..........: 0%
  constant_arrival_events_failed: 0
  constant_arrival_event_duration_ms p95: 1617ms
  Active VU max............: 11

Business interpretation:
  - 1081/1080 arrivals hoàn thành → 100% contract fulfillment
  - 0 drops → VU pool đủ cho latency profile hiện tại
  - 100% checks → không có business logic error
  - 0% HTTP fail → backend ổn định
  - p95=1617ms → cao nhưng do checkout, không phải vấn đề hệ thống
  - Active VU max=11 < preAllocatedVUs=25 → dư headroom

Decision:
  ✓ PASS – Baseline khỏe mạnh
  → Sẵn sàng cho ramping-arrival-rate
  → Monitor checkout p95 khi rate tăng

Action:
  - Drill per-service để xác nhận checkout là bottleneck duy nhất
  - Ghi nhận baseline: 18/s, 0 drops, VU max=11
  - Dùng baseline này để compare khi chạy ramping-arrival-rate
```

### Scenario B: Pass with drops <= 5 (within budget)

```text
Output:
  iterations...............: 1077
  dropped_iterations.......: 3
  checks...................: 99.5%
  http_req_failed..........: 0.2%
  constant_arrival_events_failed: 2
  constant_arrival_event_duration_ms p95: 2100ms

Business interpretation:
  - 3 drops / 1080 = 0.28% → trong budget 5
  - Nhưng KHÔNG dừng ở "PASS"
  - Cần drill: 3 drops đến từ service nào?

  Case B1: 3 drops đều ở product_list
    → Read path hơi yếu, nhưng user refresh là được
    → Có thể accept (lab)

  Case B2: 2 drops checkout + 1 drop product_list
    → 2 đơn hàng bị mất → CRITICAL
    → KHÔNG accept dù tổng drops <= 5
    → Phải điều tra checkout

  Case B3: 3 drops rải rác (1 checkout, 1 cart, 1 auth)
    → Mỗi service mất 1 event → vẫn unacceptable cho checkout/cart
    → Điều tra nguyên nhân

Decision:
  - Nếu drops ở service non-critical → PASS with warning
  - Nếu drops ở checkout/cart → INVESTIGATE (không release)
  - Luôn drill service, không chỉ nhìn tổng drops

Action:
  - Xác định service bị drop
  - Kiểm tra VU active max có gần maxVUs không?
  - Nếu checkout bị drop → tối ưu external call
  - Nếu product_list bị drop → tăng nhẹ maxVUs
```

### Scenario C: Drops > 5 (contract breach)

```text
Output:
  iterations...............: 1068
  dropped_iterations.......: 12
  checks...................: 97%
  http_req_failed..........: 1.5%
  constant_arrival_events_failed: 15
  constant_arrival_event_duration_ms p95: 3500ms
  Active VU max............: 78

Business interpretation:
  - 12 drops > 5 → contract breach
  - VU max = 78, gần maxVUs (80) → VU pool CẠN
  - p95 = 3500ms → event duration rất cao
  - Có thể checkout đang bị chậm nghiêm trọng

Phân tích:
  1. Drill service: service nào có p95 cao nhất? Checkout?
  2. Kiểm tra VU timeline: VUs tăng đến 78 ở đoạn nào?
  3. Correlation: bucket VUs=78 có nhiều checkout không?
  4. Nếu checkout weight vẫn 10% mà VUs=78 → external call có vấn đề
     (external_fail_rate? network delay?)
  5. Nếu tất cả service cùng chậm → vấn đề infrastructure

Decision:
  ✗ FAIL – contract breach
  → KHÔNG chuyển sang ramping-arrival-rate
  → Fix root cause trước

Action:
  - Nếu checkout là bottleneck → tối ưu external call, hoặc tăng maxVUs
  - Nếu tất cả service chậm → kiểm tra infrastructure
  - Nếu VU pool cạn → tính lại preAllocatedVUs và maxVUs
  - Chạy lại sau khi fix
```

### Scenario D: Failed events concentrated in one service

```text
Output:
  iterations...............: 1079
  dropped_iterations.......: 0
  checks...................: 99%
  http_req_failed..........: 0.5%
  constant_arrival_events_failed: 8
  Active VU max............: 12

Business interpretation:
  - 0 drops → arrival rate OK
  - Nhưng 8 events failed → service nào?
  - Drill service: tất cả 8 fail ở report-service
  - Các service khác: 0 fail

Phân tích:
  - Report-service có bug riêng (gzip fail? DB query fail?)
  - Không phải vấn đề toàn hệ thống
  - Không cần scale up toàn bộ cluster
  - Chỉ cần fix report-service

Decision:
  ⚠ PASS with exception
  → 4/5 service OK, 1 service có bug
  → Fix report-service, không cần thay đổi config

Action:
  - Điều tra report-service: log, error rate, DB connection
  - Không thay đổi VU pool (vì không phải vấn đề capacity)
  - Chạy lại sau khi fix report-service
```

## "Nghịch lý" (4)

### Nghịch lý 1: "p95=1617ms mà vẫn PASS — vì contract đo bằng dropped_iterations, không phải latency"

```text
Người mới nhìn vào:
  "p95 = 1617ms, cao quá! Sao vẫn PASS?"
  "Lẽ ra phải FAIL chứ?"

Giải thích:
  Threshold trong script:
    dropped_iterations: count <= 5
    checks: rate > 0.98
    http_req_failed: rate < 0.02
    constant_arrival_events_failed: count < 20

  → KHÔNG có threshold nào đo latency!
  → Contract của constant-arrival-rate là "có drop không", không phải "nhanh không"
  → p95 cao là TÍN HIỆU, không phải FAIL

  Đây là sự khác biệt cốt lõi giữa:
    - constant-arrival-rate: đo "có kịp schedule không" (capacity)
    - per-vu-iterations: đo "latency có regression không" (performance)

  Case 07 PASS vì:
    - 0 drops → capacity đủ
    - p95 cao → checkout chậm, nhưng không gây drop
    - Nếu muốn cải thiện p95 → tối ưu checkout, không phải do test fail

Bài học:
  - Đọc threshold trước khi đọc p95
  - Hiểu executor đang đo CÁI GÌ
  - constant-arrival-rate đo CAPACITY (có đủ VU không?)
  - per-vu-iterations đo PERFORMANCE (có nhanh không?)
```

### Nghịch lý 2: "6 services, 1081 iterations, 0 drops — nhưng checkout vẫn có thể là bottleneck ẩn"

```text
Người mới nhìn vào:
  "0 drops → hệ thống hoàn hảo, không có vấn đề gì!"
  "Checkout p95=1617ms cũng OK vì test PASS mà?"

Giải thích:
  0 drops KHÔNG có nghĩa là không có bottleneck.
  0 drops chỉ có nghĩa là VU pool ĐỦ LỚN cho latency profile hiện tại.

  Với preAllocatedVUs=25, maxVUs=80, và active VU max=11:
    → VU pool DƯ RẤT NHIỀU
    → Checkout có thể chậm gấp 10 lần hiện tại vẫn không drop
    → Bottleneck bị "CHE" bởi VU pool lớn

  Nếu giảm maxVUs xuống 15:
    → Checkout tail latency có thể gây drop
    → Bottleneck LỘ RA

  Nếu tăng checkout weight lên 30%:
    → Nhiều checkout event hơn → VU demand tăng
    → Có thể chạm maxVUs → drop xuất hiện
    → Bottleneck LỘ RA

Bài học:
  - 0 drops + VU dư nhiều = bottleneck có thể bị CHE
  - Để tìm bottleneck thật → stress test: giảm VU pool hoặc tăng rate
  - KHÔNG kết luận "không có vấn đề" chỉ vì 0 drops
```

### Nghịch lý 3: "drop budget=5 nghe có vẻ ít nhưng là 0.46% — SLO production thường yêu cầu 0"

```text
Người mới nhìn vào:
  "5 drops / 1080 = 0.46% → tỷ lệ nhỏ, chắc OK trong production luôn?"

Giải thích:
  0.46% nghe nhỏ, nhưng production scale khác:
    - 1080 event / 60s → 18/s
    - Production: 1000 event/s
    - 0.46% của 1000/s = 4.6 drops MỖI GIÂY
    - 4.6 × 3600 = 16,560 drops MỖI GIỜ
    - Nếu là checkout: 16,560 ĐƠN HÀNG BỊ MẤT mỗi giờ

  Ngoài ra:
    - Drop budget trong lab là để DẠY HỌC
    - Production SLO thường KHÔNG có drop budget cho critical path
    - 99.9% SLO (three nines) = 0.1% error budget
    - 0.46% > 0.1% → vượt SLO three nines
    - 99.99% SLO (four nines) = 0.01% → còn xa hơn

Bài học:
  - Drop budget trong lab ≠ drop budget trong production
  - Tỷ lệ nhỏ ở lab scale → số tuyệt đối LỚN ở production scale
  - Luôn đặt SLO theo business impact, không theo "con số đẹp"
  - Checkout: SLO phải là 0 drops (mỗi drop = mất tiền)
  - Product list: có thể chấp nhận 0.1% drops
```

### Nghịch lý 4: "active VU max=11 nhưng preAllocatedVUs=25 — headroom dư nhiều, nhưng nếu checkout tăng weight thì sao?"

```text
Người mới nhìn vào:
  "11/25 VU dùng → lãng phí 14 VU! Giảm preAllocatedVUs xuống 12 cho tiết kiệm!"

Giải thích:
  Headroom 25-11=14 VU là BUFFER, không phải lãng phí.

  Với checkout weight=10% và preAllocatedVUs=25:
    - Active VU max = 11
    - Headroom = 14 VU (127% buffer)

  Nếu checkout weight TĂNG LÊN 30% (variation 2):
    - Số checkout event tăng gấp 3
    - Checkout tail latency → nhiều VU bị giữ lâu hơn
    - VU demand tăng → active VU max có thể lên 20-25
    - Headroom 25-20=5 VU → vẫn OK nhưng mỏng hơn

  Nếu checkout weight tăng lên 50%:
    - VU demand có thể vượt 25 → phải spawn thêm VU
    - Nếu spawn không kịp → drop

  Nếu giảm preAllocatedVUs xuống 12:
    - Bình thường: 11/12 VU dùng → vẫn OK
    - Checkout weight tăng 30%: VU demand 20 → VƯỢT 12
    - Phải spawn 8 VU mới → có thể không kịp → DROP
    - Headroom ban đầu bị mất → mất khả năng chống chịu

Bài học:
  - Headroom không phải lãng phí — nó là BUFFER cho variance
  - preAllocatedVUs phải đủ cho PEAK demand, không phải AVERAGE demand
  - Variance đến từ: branch mix randomness + checkout tail latency
  - Bài toán sizing: preAllocatedVUs >= E[VU_demand] + 2×σ(VU_demand)
  - Luôn test với worst-case branch mix trước khi giảm VU pool
```

## Checklist

### Pre-run checklist

```text
[ ] Script path đúng: car-07-production-ingress-mix.js
[ ] BACKEND_URL trỏ đến server đang chạy
[ ] Server có đủ 6 service endpoints (products, cart, auth, order, report)
[ ] Env vars set đúng (hoặc dùng default)
[ ] K6_CLOUD_HOST và K6_CLOUD_TOKEN set (nếu muốn xem dashboard)
[ ] Không có process khác chiếm port 80/18080
```

### Post-run aggregate checklist

```text
[ ] iterations ≈ 1080 (±5)
[ ] dropped_iterations <= 5
[ ] checks rate > 98%
[ ] http_req_failed rate < 2%
[ ] constant_arrival_events_failed < 20
[ ] constant_arrival_events_total ≈ iterations
[ ] constant_arrival_api_calls_total ≈ http_reqs ≈ iterations
[ ] Active VU max < maxVUs (còn headroom)
```

### Post-run per-service drill checklist

```text
[ ] products-service:
    [ ] event count ≈ 595 (±30)
    [ ] p95 < 20ms
    [ ] failed events = 0

[ ] cart-service:
    [ ] event count ≈ 162 (±15)
    [ ] p95 < 50ms
    [ ] failed events = 0

[ ] auth-service:
    [ ] event count ≈ 108 (±15)
    [ ] p95 < 30ms
    [ ] failed events = 0

[ ] report-service:
    [ ] event count ≈ 108 (±15)
    [ ] p95 < 100ms
    [ ] failed events = 0

[ ] order-service (checkout):
    [ ] event count ≈ 108 (±15)
    [ ] p95 < 2000ms (chấp nhận cao hơn do external call)
    [ ] failed events = 0
    [ ] KHÔNG CÓ DROP (nếu có → CRITICAL)
```

### Dashboard checklist

```text
[ ] Response time:
    [ ] Drill theo service, không đọc aggregate
    [ ] Product/auth p95 thấp và ổn định
    [ ] Checkout p95 cao nhưng không tăng dần
    [ ] Không có spike bất thường ở cuối run

[ ] Execution timeline:
    [ ] iter/s ≈ 18/s ổn định
    [ ] Live VUs dao động 5-15
    [ ] Live VUs không chạm maxVUs
    [ ] Tổng iterations ≈ 1080

[ ] VUs vs iter/s:
    [ ] Observed VUs thấp hơn Executor VUs nhiều (headroom)
    [ ] Actual iter/s ≈ 18/s
    [ ] Executor VUs = maxVUs (80)

[ ] Executor tab:
    [ ] executor = constant-arrival-rate
    [ ] rate/timeUnit/duration đúng config
    [ ] preAllocatedVUs/maxVUs đúng config
    [ ] dropped_iterations khớp summary
```

### Decision checklist

```text
[ ] Nếu drops > 0 → drill service nào bị drop?
[ ] Nếu drops ở checkout/cart → UNACCEPTABLE dù <= 5
[ ] Nếu drops ở product_list → warning, có thể accept (lab)
[ ] Nếu checkout p95 > 2000ms → cần tối ưu external call
[ ] Nếu active VU max gần maxVUs → tăng maxVUs hoặc giảm event duration
[ ] Nếu tất cả OK → sẵn sàng cho ramping-arrival-rate
```

## 5 variations với code

Mỗi variation thay đổi 1 yếu tố để quan sát tác động lên hệ thống.

### Variation 1: Lower rate smoke test

```powershell
# Mục đích: smoke test nhanh trước khi chạy full 60s
# Giảm rate và duration để verify setup đúng

$env:CAR_07_RATE = "10"
$env:CAR_07_DURATION = "15s"
$env:CAR_07_MAX_DROPPED = "0"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-07-production-ingress-mix.js"
```

Kỳ vọng:

```text
- 10/s × 15s = 150 slots
- iterations ≈ 150
- 0 drops (rate thấp, dễ đạt)
- p95 thấp hơn (ít áp lực VU pool)
- Active VU max thấp (~5-8)
```

### Variation 2: Change branch weights — tăng checkout, giảm product_list

```powershell
# Mục đích: quan sát noisy neighbor khi checkout weight tăng
# Code: sửa trực tiếp weight trong script hoặc dùng env var nếu có

# Trong car-07-production-ingress-mix.js, thay đổi weightedPick:
# Từ:
#   product_list: 30, product_detail: 25, cart_add: 15,
#   auth_me: 10, report: 10, checkout: 10
# Thành:
#   product_list: 15, product_detail: 15, cart_add: 15,
#   auth_me: 10, report: 15, checkout: 30

$env:CAR_07_RATE = "18"
$env:CAR_07_DURATION = "60s"
$env:CAR_07_MAX_DROPPED = "10"  # tăng budget vì checkout nặng hơn

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-07-production-ingress-mix.js"
```

Kỳ vọng:

```text
- Checkout event tăng từ ~108 lên ~324 (gấp 3)
- Product event giảm từ ~595 xuống ~324
- Active VU max TĂNG (vì checkout giữ VU lâu hơn)
- Có thể xuất hiện drops (nếu VU pool không đủ)
- p95 tổng TĂNG (nhiều checkout hơn → nhiều tail latency hơn)
- Response time chart: checkout series dày hơn, product series mỏng hơn

Bài học:
  - Branch mix ảnh hưởng TRỰC TIẾP đến VU demand
  - Tăng checkout weight → tăng VU demand → tăng rủi ro drop
  - Đây là lý do cần test với PRODUCTION MIX, không phải uniform mix
```

### Variation 3: Shrink VU pool — quan sát service nào drop trước

```powershell
# Mục đích: tìm service yếu nhất khi VU pool bị giới hạn
# Giảm preAllocatedVUs và maxVUs

$env:CAR_07_PREALLOCATED_VUS = "5"
$env:CAR_07_MAX_VUS = "10"
$env:CAR_07_MAX_DROPPED = "20"  # tăng budget để thấy pattern

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-07-production-ingress-mix.js"
```

Kỳ vọng:

```text
- VU pool nhỏ (5-10) → không đủ cho 18/s mixed
- Drop xuất hiện
- Checkout event bị drop NHIỀU NHẤT (vì giữ VU lâu nhất → VU không kịp
  giải phóng cho slot mới)
- Product_list cũng bị drop (dù nhanh, nhưng thiếu VU do checkout chiếm)
- Đây là noisy neighbor ở mức độ NẶNG

Drill theo service để xác nhận:
  - Checkout: drop rate cao nhất
  - Product_list: drop rate thấp hơn (vì nhanh hơn, nhưng vẫn bị ảnh hưởng)

Bài học:
  - Service chậm (checkout) là "kẻ chiếm dụng VU" → drop service khác
  - Khi VU pool thiếu, service nhanh cũng bị drop (vô tội nhưng lãnh đủ)
  - → Phải tăng VU pool HOẶC cô lập service chậm sang scenario riêng
```

### Variation 4: Add external latency to all services — system-wide slowdown

```powershell
# Mục đích: mô phỏng external dependency chậm toàn hệ thống
# Sửa backend thêm external_ms cho tất cả endpoint
# Hoặc thêm network delay ở mức infrastructure (tc qdisc)

# Trong script, tất cả endpoint đều có ?cpu_ms=...&db_rows=...
# Nếu backend hỗ trợ thêm external_ms cho mọi endpoint:
#   /api/sim/products?external_ms=15
#   /api/sim/auth/me?external_ms=15
#   ...

$env:CAR_07_RATE = "18"
$env:CAR_07_DURATION = "60s"
$env:CAR_07_MAX_VUS = "120"  # tăng maxVUs vì tất cả đều chậm hơn
$env:CAR_07_MAX_DROPPED = "10"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-07-production-ingress-mix.js"
```

Kỳ vọng:

```text
- Tất cả service chậm hơn (products không còn 5ms nữa)
- VU demand tổng tăng ĐỀU (không chỉ checkout)
- Active VU max tăng đáng kể
- Có thể chạm maxVUs nếu external_ms đủ lớn
- Drop xuất hiện (nếu VU pool không đủ)
- p95 tất cả service đều tăng → phân phối latency bị shift phải

Bài học:
  - System-wide slowdown KHÁC với single-service bottleneck
  - Khi tất cả cùng chậm → cần scale up toàn bộ (không chỉ fix 1 service)
  - Phân biệt: checkout chậm (noisy neighbor) vs tất cả cùng chậm (infrastructure)
```

### Variation 5: Extend to 120s — longer baseline, observe steady-state

```powershell
# Mục đích: xác nhận baseline ổn định trong thời gian dài hơn
# Gấp đôi duration, giữ nguyên rate

$env:CAR_07_DURATION = "120s"
$env:CAR_07_MAX_DROPPED = "10"  # gấp đôi duration → gấp đôi budget (tuyến tính)

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-07-production-ingress-mix.js"
```

Kỳ vọng:

```text
- 18/s × 120s = 2160 slots
- iterations ≈ 2160 (±5)
- VU active max tương tự (11-15) → không tăng theo thời gian
- p95 ổn định, không degrade theo thời gian
- Không có dấu hiệu memory leak hoặc resource exhaustion

Nếu thấy:
  - Active VU max TĂNG DẦN theo thời gian → leak (VU không được giải phóng)
  - p95 TĂNG DẦN → resource exhaustion (DB pool cạn, cache đầy)
  - Drop xuất hiện ở cuối run → hệ thống degrade theo thời gian

Bài học:
  - Baseline dài hơn → phát hiện degradation pattern
  - 60s đủ để verify arrival rate, nhưng 120s+ để verify steady-state
  - Production test thường chạy 5-15 phút để bắt leak/degradation
```

## Anti-patterns (mở rộng)

### Anti-pattern 1: "Case 07 pass nên mọi service đều pass"

```text
SAI:
  "Test PASS → tất cả 6 service đều ổn → release được"

ĐÚNG:
  "Test PASS ở aggregate level. Nhưng per-service:
   - Checkout p95 = 1617ms → CAO, cần monitoring
   - Product/Auth p95 < 25ms → ổn
   - Kết luận: PASS với warning cho checkout
   - KHÔNG kết luận 'mọi service đều pass'"

Ví dụ production:
  - 4/5 service p95 < 50ms → user thấy nhanh
  - 1/5 service (checkout) p95 = 2-3s → user THAN PHIỀN
  - Dù system-level metrics "PASS" → user experience KHÔNG pass
  - → Luôn drill per-service trước khi kết luận
```

### Anti-pattern 2: "5 drops luôn chấp nhận được trong production"

```text
SAI:
  "Lab cho maxDropped=5, test PASS với 3 drops → production cũng OK với 3 drops"

ĐÚNG:
  "Lab budget 5 drops là để HỌC CÁCH ĐỌC drop signal.
   Production SLO:
   - Checkout: 0 drops (mất tiền)
   - Cart: 0 drops (mất sale)
   - Product list: có thể 0.01% drops (non-critical)
   - Report: có thể 0.1% drops (non-critical)

   → KHÔNG áp dụng lab budget vào production
   → Production SLO do BUSINESS quyết định, không phải lab script"

Công thức SLO:
  error_budget = (1 - SLO%) × total_requests
  Với SLO 99.99%: error_budget = 0.01% × 1080 ≈ 0.1 drops → 0 drops
  Với SLO 99.9%:  error_budget = 0.1% × 1080 ≈ 1 drop
  → Lab budget 5 drops tương đương SLO ~99.5% (quá thấp cho production)
```

### Anti-pattern 3: "p95 tổng cao nghĩa là toàn hệ thống chậm"

```text
SAI:
  "p95 = 1617ms → hệ thống chậm → cần scale up toàn bộ cluster"

ĐÚNG:
  "p95 tổng = 1617ms là do checkout (10% traffic) có external call 30ms.
   Products-service (55% traffic) có p95 ~10ms → RẤT NHANH.

   Hành động SAI: scale up toàn bộ cluster (tốn tiền, không giải quyết gốc)
   Hành động ĐÚNG: tối ưu checkout external call, hoặc thêm cache layer
                   cho checkout nếu có thể

   Luôn drill service trước khi scale infrastructure"

Cách kiểm:
  1. Drill p95 theo service
  2. Nếu 1 service chậm → fix service đó
  3. Nếu TẤT CẢ service chậm → scale infrastructure
  4. KHÔNG skip bước 1-2 nhảy thẳng đến 3
```

### Anti-pattern 4: "active VU max thấp → có thể giảm maxVUs"

```text
SAI:
  "Run 95 dùng max 11 VU → maxVUs=80 là quá cao → giảm xuống 15"

ĐÚNG:
  "11 VU là MAX QUAN SÁT ĐƯỢC trong điều kiện HIỆN TẠI.
   Nhưng:
   - Branch mix có thể thay đổi (checkout spike)
   - External call có thể chậm hơn (payment gateway quá tải)
   - Rate có thể tăng (campaign, flash sale)
   - Duration dài hơn có thể tích lũy checkout tail

   → maxVUs là TRẦN AN TOÀN, không phải target
   → Giảm maxVUs chỉ sau khi đã test WORST-CASE scenario
   → Test với checkout weight=50%, external_ms=100ms trước khi quyết định"

Công thức an toàn:
  maxVUs >= peak_demand × safety_factor
  safety_factor = 2-3x cho production (để chống spike)
  Run 95: peak_demand = 11 → maxVUs nên >= 22-33
  → maxVUs=80 là an toàn (có thể giảm nhưng không xuống 15)
```

### Anti-pattern 5: "0 drops = không cần quan tâm đến latency"

```text
SAI:
  "Run 95: 0 drops → tất cả OK → không cần xem p95"

ĐÚNG:
  "0 drops = CAPACITY đủ. Nhưng p95 = 1617ms = USER EXPERIENCE kém cho checkout.
   User không quan tâm 'có drop không'.
   User quan tâm 'trang thanh toán load bao lâu'.

   → 0 drops + p95 cao = user không bị từ chối, nhưng PHẢI CHỜ LÂU
   → Cả 2 metrics đều quan trọng: drops (availability) + latency (performance)
   → KHÔNG bỏ qua latency chỉ vì không có drop"

Trong production:
  - Drop = user thấy "lỗi" / "không thể xử lý" → mất user
  - Latency cao = user thấy "chậm" → frustrated, có thể rời đi
  - Cả 2 đều quan trọng → cần monitor cả 2
```

### Anti-pattern 6: "Không cần drill service vì đã có aggregate threshold"

```text
SAI:
  "Threshold checks>0.98, drops<=5 → PASS → xong, không cần làm gì thêm"

ĐÚNG:
  "Aggregate threshold là ĐIỀU KIỆN CẦN (pass/fail).
   Drill service là ĐIỀU KIỆN ĐỦ (hiểu system health).

   Nếu chỉ dừng ở aggregate:
   - Không biết service nào là bottleneck
   - Không biết drop đến từ đâu
   - Không có baseline để compare khi rate thay đổi
   - Không có insight để báo cho team service owner

   → Luôn drill service, ngay cả khi aggregate PASS"
```

### Anti-pattern 7: "Case 07 giống hệt case 01-06 cộng lại"

```text
SAI:
  "Case 07 = case 01 + case 02 + case 03 + case 04 + case 05 + case 06"

ĐÚNG:
  "Case 07 là 1 scenario DUY NHẤT với 6 branch TRỘN VÀO NHAU.
   KHÔNG phải 6 scenario riêng biệt.

   Điểm khác:
   - Case 01-06: mỗi case chạy 1 service, 1 VU pool riêng
   - Case 07: 6 service dùng CHUNG 1 VU pool → tương tác noisy neighbor

   Nếu chạy 6 scenario riêng (như case 01-06):
   - Mỗi scenario có VU pool riêng → không có noisy neighbor
   - Không phát hiện được checkout làm chậm product
   - Không phản ánh production thật (nơi tất cả service dùng chung cluster)

   → Case 07 là BÀI TOÁN MỚI, không phải tổng của 6 case cũ"
```

## Reference

### Các case trong series constant-arrival-rate

- **Case 01 (storefront)**: Read ingress cố định; backend chậm không được tự giảm traffic. Xem `01_storefront-rps-contract.md`
- **Case 02 (auth)**: Auth stream là ingress contract, không phải số VU/user. Xem `02_auth-token-validation-rps.md`
- **Case 03 (cart)**: Write-intake cần đọc drop + failed events cùng nhau. Xem `03_cart-write-intake.md`
- **Case 04 (checkout)**: Low rate vẫn cần nhiều VU nếu external latency cao. Xem `04_checkout-order-intake.md`
- **Case 05 (report)**: Async/job latency không được âm thầm throttle arrival stream. Xem `05_report-api-ingress.md`
- **Case 06 (cacheable feed)**: Cacheable reads vẫn phải đạt fixed ingress. Xem `06_cacheable-feed-ingress.md`
- **Case 07 (production mix)**: File này. Open-model baseline trước khi học ramping-arrival-rate.

### Series overview

- **Overview**: `00_overview.md` — bảng tổng hợp 7 case, bảng so sánh executor
- **Run guide**: `RUN_GUIDE.md` — stack setup chung cho toàn bộ series
- **Validation**: `08_validation-and-chart-analysis.md` — chart analysis chi tiết từ run thật

### Các case liên quan trong series per-vu-iterations

- **Case 01 (per-vu-iterations)**: `../per-vu-iterations/01_user-journey-replay.md` — đối chiếu closed model vs open model
- **Case 06 (cart concurrency)**: `../per-vu-iterations/06_cart-concurrency.md` — race condition checkout

### Cầu nối sang ramping-arrival-rate

```text
Sau khi hoàn thành case 07:
  → Đã hiểu: open model, VU pool, noisy neighbor, drop budget, per-service drill
  → Bước tiếp: ramping-arrival-rate
  → Áp dụng TOÀN BỘ kiến thức case 07, thêm 1 chiều: arrival rate THAY ĐỔI

Các câu hỏi ramping-arrival-rate sẽ trả lời:
  - Khi rate tăng từ 18 → 30/s, VU demand tăng bao nhiêu?
  - Checkout có gây drop khi rate = 30/s không?
  - Service nào "gãy" trước khi rate tăng?
  - Cần bao nhiêu maxVUs cho peak rate?

→ Tất cả những câu hỏi này CHỈ trả lời được nếu đã hiểu baseline case 07
```

### Doc tham số và công thức

- **constant-arrival-rate tham số**: `docs/20260515_03_shared-iterations-quickpizza-two-requests-worked-example.md` (cross-reference executor)
- **Section 8.7**: quy trình 5 bước phân tích output
- **Little's Law**: `L = λ × W` — nền tảng cho VU demand estimation

---

**Case 07 — Production ingress mix** là case tổng hợp quan trọng nhất trong series
constant-arrival-rate. Nó dạy cách đọc mixed baseline với noisy neighbor, drop budget,
và per-service drill — tất cả những kỹ năng cần thiết trước khi bước vào
ramping-arrival-rate.

**Run 95 validation (2026-06-21)**: 1081 iterations, 0 drops, p95=1617ms,
active VU max=11, **PASS**. Baseline sẵn sàng cho bước tiếp theo.
