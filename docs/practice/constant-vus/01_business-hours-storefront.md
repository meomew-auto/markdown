# Case 01: Business-hours storefront

## Tình huống thực tế

Team storefront muốn biết hệ thống hoạt động ra sao khi có một nhóm shopper đang active trong giờ kinh doanh bình thường.

Người dùng không chỉ list product; họ browse detail, thêm cart, và một phần nhỏ checkout. Đây là steady user behavior, không phải batch jobs.

Case này trả lời: nếu giữ 20 active shoppers trong 5 phút, products/cart/order có giữ được latency và failure rate ổn định không?

Tóm tắt đời thường:

```text
Executor model: fixed active user pool
VUs: 20
Duration: 5m
Think time: 0.4s
Team/service focus: storefront/product/cart/order
```

Case này không hỏi:

```text
Có xử lý đủ N job không?
Có đạt đúng X RPS không?
Mỗi user có chạy đúng N vòng không?
```

Nó hỏi:

```text
Nếu giữ 20 active users trong 5m,
latency/error/natural throughput của flow này ra sao?
```

### Bối cảnh thực tế đầy đủ hơn

```text
Trigger: team muốn biết baseline storefront giờ bình thường
         trước khi chạy surge test hoặc trước khi deploy thay đổi.

Business reality:
  - 20 shoppers đang browse, add-to-cart, và thỉnh thoảng checkout
  - Họ không có deadline — họ cứ browse đến khi mệt thì thôi
  - Không có "danh sách việc cần làm xong" (không backlog)
  - Không có "target RPS cần đạt" (không SLA arrival-rate)

Risk nếu hiểu sai model:
  - Dùng shared-iterations: ép 20 users phải browse ĐỦ N vòng — vô nghĩa, shopper thật không có quota
  - Dùng constant-arrival-rate: ép 40 RPS — nếu backend chậm, k6 tạo thêm VU để giữ rate, làm quá tải hệ thống khác với thực tế
  - Kỳ vọng fixed RPS: shopper thật không tự nhiên "tăng tốc" khi backend chậm
```

### Vì sao "Business-hours storefront" buộc chọn constant-vus?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của business-hours storefront trước:

```text
Business-hours storefront = "giữ một nhóm shopper active ổn định,
                             cho họ browse/cart/checkout tự nhiên,
                             quan sát hệ thống phản ứng ra sao trong T phút"

Đời thường:
  20 khách đang trong siêu thị
  Họ đi dọc lối hàng (= browse list)
  Dừng lại xem sản phẩm (= browse detail)
  Bỏ vào giỏ (= cart add)
  Thỉnh thoảng ra quầy tính tiền (= checkout)
  Không ai ép họ phải "mua đủ 10 món" hay "xem đúng 100 sản phẩm"
  Họ cứ đi tự nhiên trong 5 phút, rồi quan sát xem quầy có nghẽn không
```

Để business-hours storefront **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ constant-vus mới thỏa mãn cả 2.

#### Yêu cầu (a): STEADY CONCURRENCY OBSERVATION (giữ đúng N active users)

**Ý nghĩa**: Phải giữ ĐÚNG 20 active users trong suốt 5 phút. Đây là input cố định — ta muốn biết "nếu có 20 người cùng lúc, hệ thống ra sao", không phải "20 người làm xong bao nhiêu việc".

**Ví dụ cụ thể**:

```text
Scenario: team muốn biết storefront baseline cho 20 concurrent shoppers

Trường hợp A (concurrency ĐÚNG):
  Giữ 20 VU active trong 5m
  Mỗi VU browse/cart/checkout tự nhiên
  Latency ổn định, RPS ~35-45
  → Kết luận: storefront ổn với 20 concurrent users

Trường hợp B (concurrency SAI — dùng arrival-rate):
  Target 40 RPS, để k6 tự quyết VUs
  Backend chậm 1 đoạn → k6 spawn thêm VU lên 35 để giữ 40 RPS
  → 35 VU thật ra là quá tải nhân tạo, không phải 20 users nữa
  → Kết luận sai: "hệ thống yếu, cần scale" — nhưng thực ra 20 users vẫn ổn
```

**Vì sao steady concurrency quan trọng hơn fixed RPS cho case này?**

```text
Trong thực tế, 20 shoppers không tự dưng "tăng tốc browse" chỉ vì server chậm.
Họ browse chậm hơn vì page load lâu hơn — đó là HÀNH VI THẬT.

Nếu requirement là "dù server chậm, vẫn phải phục vụ 40 RPS":
  → Đó là bài toán capacity planning, dùng arrival-rate
  → Nhưng case này là BASELINE BEHAVIOR, không phải capacity target

constant-vus capture được:
  "Server chậm → shopper browse chậm hơn → tổng RPS giảm"
  → Đây là closed-model signal QUAN TRỌNG

arrival-rate KHÔNG capture được điều này:
  "Server chậm → k6 spawn thêm VU → RPS vẫn 40"
  → Che mất vấn đề thật
```

#### Yêu cầu (b): CLOSED-MODEL BACKPRESSURE VISIBILITY (thấy được slowdown qua throughput)

**Ý nghĩa**: Khi backend chậm, RPS phải GIẢM. Đây là tín hiệu — không phải bug. Nếu RPS không giảm khi backend chậm, ta không biết có vấn đề.

**Ví dụ cụ thể**:

```text
constant-vus với 20 VU, loop_duration trung bình 0.5s:
  iter/s ≈ 20 / 0.5 = 40
  RPS   ≈ 40 × requests_per_loop

constant-vus với 20 VU, loop_duration tăng lên 1.0s (backend chậm):
  iter/s ≈ 20 / 1.0 = 20
  RPS   ≈ 20 × requests_per_loop
  → RPS GIẢM từ ~40 xuống ~20
  → Đây là TÍN HIỆU: "có gì đó chậm, cần điều tra"

constant-arrival-rate với target 40 RPS:
  Khi backend chậm, k6 spawn thêm VU để giữ 40 RPS
  → RPS vẫn 40, không thấy tín hiệu gì
  → Chỉ thấy VU tăng + latency tăng — khó phân biệt "backend chậm" vs "traffic tăng"
```

### Phân tích sâu: vì sao 4 executor "không phải constant-vus" không phù hợp?

`shared-iterations` với `vus=20, iterations=???`:

```text
Vấn đề: không biết đặt iterations bằng bao nhiêu.

Nếu iterations = 500:
  - Backend nhanh (loop=0.5s): 500 iter / (20/0.5) ≈ 12.5s là xong
  - Backend chậm (loop=1.0s): 500 iter / (20/1.0) ≈ 25s là xong
  - Cả 2 đều xong trước 5m — không observation window đủ dài

Nếu iterations = 12000 (để kéo dài 5m khi backend nhanh):
  - Backend nhanh: 12000 / 40 = 300s = 5m ✓
  - Backend chậm: 12000 / 20 = 600s = 10m → vượt duration mong muốn
  → Mỗi lần chạy duration khác nhau, không so sánh được

Cốt lõi: shared-iterations trả lời "xử lý hết N job trong bao lâu?"
         constant-vus trả lời "trong T phút, N user tạo ra bao nhiêu job?"
         → 2 câu hỏi KHÁC NHAU
```

`per-vu-iterations` với `vus=20, iterations=100`:

```text
Vấn đề: ép mỗi user chạy đúng 100 vòng — vô nghĩa với shopper thật.

20 shoppers, mỗi người browse ĐÚNG 100 vòng:
  - VU nhanh (network tốt): xong 100 vòng trong 50s, rồi IDLE 250s
  - VU chậm (network kém): 100 vòng trong 150s
  - Kết quả: VU IDLE lãng phí, không observation window thật

Ngoài ra:
  - Shopper thật không có quota "phải xem đúng 100 sản phẩm"
  - Họ browse tự nhiên, có thể xem 50 hoặc 150 sản phẩm tùy tốc độ
  - per-vu-iterations ép quota = làm sai behavior model
```

`constant-arrival-rate` với `rate=40, duration="5m"`:

```text
Vấn đề: che mất closed-model backpressure signal.

Demo trace so sánh:
  Tình huống: phút thứ 3, products-service bị chậm (loop_duration 0.5s → 1.0s)

  constant-vus:
    iter/s: 40 → 20 (GIẢM, tín hiệu rõ)
    VUs:   20 → 20 (không đổi)
    → Phát hiện: "có gì đó chậm ở phút thứ 3"

  constant-arrival-rate:
    iter/s: 40 → 40 (KHÔNG đổi, bị che)
    VUs:   20 → 35 (TĂNG để bù)
    → Thấy: "VU tăng, latency tăng"
    → Không biết: "20 user thật có bị ảnh hưởng không?"

  Vấn đề của arrival-rate: nó tạo ra concurrency CAO HƠN thực tế
  để giữ rate. Trong thực tế, 20 shoppers không tự nhiên thành 35.
  → Kết luận sai về capacity requirement
```

`ramping-vus` với ramp từ 1 lên 20:

```text
Vấn đề: concurrency thay đổi, không phải baseline phẳng.

Nếu muốn quan sát "từ lúc mở cửa đến lúc đông":
  → ramping-vus phù hợp

Nhưng case này muốn baseline GIỜ BÌNH THƯỜNG (steady):
  → Concurrency phải phẳng để làm baseline so sánh
  → Nếu ramp, không biết latency thay đổi do "thêm user" hay do "backend chậm"
```

### Tổng kết: chỉ constant-vus thỏa mãn cả (a) và (b)

| Executor | (a) Steady concurrency | (b) Closed-model backpressure | Verdict |
| --- | --- | --- | --- |
| **constant-vus** | ✓ vus cố định, duration cố định | ✓ RPS giảm khi backend chậm | ✅ DÙNG |
| shared-iterations | ✗ duration không cố định, phụ thuộc latency | ✗ không observation window | ❌ |
| per-vu-iterations | ✗ VU nhanh xong sớm → idle, concurrency giảm | ✗ VU idle → không backpressure signal | ❌ |
| constant-arrival-rate | ✗ VU thay đổi để giữ rate | ✗ RPS cố định → che backpressure | ❌ |
| ramping-vus | ✗ concurrency thay đổi theo time | △ thấy được nhưng lẫn với ramp effect | ❌ |
| ramping-arrival-rate | ✗ cả rate và VU đều thay đổi | ✗ rate target thay đổi → không baseline | ❌ |

→ Chỉ **constant-vus** thỏa mãn cả 2 yêu cầu, các executor khác đều fail ở ít nhất 1 trong 2.

## Yêu cầu cứng của case này

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Giữ active concurrency gần 20 VUs trong regular phase | Input chính của case là 20 concurrent shoppers. Nếu VU không flat, mô hình sai. |
| Chạy đủ observation window 5m, không dùng total iterations làm target | Duration là observation window. Dừng sớm hay muộn đều làm mất khả năng so sánh. |
| Weighted mix browse/cart/checkout phải được đọc bằng operation tags | Aggregate metrics che branch nhỏ. Phải tách operation. |
| Failed user loops phải thấp hơn `constant_active_iterations_failed count<20` | Shopper loop fail nghĩa là user không hoàn tất flow. |
| `http_req_failed` rate < 0.01 | HTTP failure phải gần 0. |
| `checks` rate > 0.99 | Status/contract checks phải pass. |

Các invariant chung:

```text
vus + duration = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì RPS giảm
```

Do đó không được fail test chỉ vì `iterations` không bằng một số target tưởng tượng.

## Vì sao "Business-hours storefront" nên dùng `constant-vus`?

Business-hours storefront là bài toán concurrency steady: có một lượng shopper active, họ lặp lại hành vi tự nhiên. Ta muốn natural throughput và latency sinh ra từ 20 users, không muốn ép RPS hay drain backlog.

Mental model:

```text
20 active VUs start.
Each VU loops the user flow until 5m ends.
A loop finishes -> same VU starts the next loop.
Total completed loops depend on loop duration.
```

Nếu backend nhanh:

```text
loop_duration giảm -> mỗi VU chạy nhiều loops hơn -> iter/s/RPS tăng
```

Nếu backend chậm:

```text
loop_duration tăng -> mỗi VU chạy ít loops hơn -> iter/s/RPS giảm
```

Đây là lý do gọi là closed model.

## CLOSED MODEL DEEP DIVE — Trái tim của constant-vus

Đây là phần quan trọng nhất để hiểu constant-vus. Nếu không nắm closed model, mọi phân tích RPS/latency đều có thể sai.

### Công thức closed model

```text
loop_duration = API_time + JS_time + sleep/think_time

Với 1 VU:
  per_vu_loop_rate = 1 / loop_duration
  (Nếu loop mất 0.5s, 1 VU chạy được 2 loops/s)

Với N VU (giả sử đồng nhất):
  total_iter_rate ≈ vus / avg_loop_duration
  iter/s ≈ 20 / loop_duration

  http_reqs_rate ≈ iter/s × avg_requests_per_loop
```

### Demo 1: Backend nhanh → throughput cao

```text
Config: vus=20, duration=5m, sleep=0.4s

Backend nhanh:
  storefront_browse_list:    avg=50ms
  storefront_browse_detail:  avg=30ms
  storefront_cart_add:       avg=40ms
  storefront_checkout:       avg=200ms (có external_ms)

  Weighted loop (70% browse, 25% cart, 5% checkout):
    browse loop:   50ms + 30ms + 400ms(sleep) = 480ms → 2.08 loops/s/VU
    cart loop:     50ms + 30ms + 40ms + 400ms = 520ms → 1.92 loops/s/VU
    checkout loop: 50ms + 30ms + 40ms + 200ms + 400ms = 720ms → 1.39 loops/s/VU

    Weighted avg loop: 0.7×480 + 0.25×520 + 0.05×720 = 336 + 130 + 36 = 502ms

  iter/s ≈ 20 / 0.502 ≈ 39.8 iter/s
  Total iterations trong 5m ≈ 39.8 × 300 = 11940 iterations

  Với browse loop có ~2.5 requests (list+detail, đôi khi thêm variation):
  RPS ≈ 39.8 × 2.5 ≈ 99.5 req/s
```

### Demo 2: Backend chậm → throughput thấp (CLOSED-MODEL SIGNAL)

```text
Cùng config, nhưng backend chậm hơn (database backup, cache miss):

  storefront_browse_list:    avg=120ms (tăng từ 50ms)
  storefront_browse_detail:  avg=90ms  (tăng từ 30ms)
  storefront_cart_add:       avg=80ms  (tăng từ 40ms)
  storefront_checkout:       avg=450ms (tăng từ 200ms)

  Weighted loop:
    browse loop:   120 + 90 + 400 = 610ms → 1.64 loops/s/VU
    cart loop:     120 + 90 + 80 + 400 = 690ms → 1.45 loops/s/VU
    checkout loop: 120 + 90 + 80 + 450 + 400 = 1140ms → 0.88 loops/s/VU

    Weighted avg: 0.7×610 + 0.25×690 + 0.05×1140 = 427 + 172.5 + 57 = 656.5ms

  iter/s ≈ 20 / 0.6565 ≈ 30.5 iter/s
  Total iterations ≈ 30.5 × 300 = 9150 iterations

  RPS ≈ 30.5 × 2.5 ≈ 76.3 req/s

SO SÁNH:
  Demo 1 (nhanh): iter/s≈39.8, RPS≈99.5
  Demo 2 (chậm): iter/s≈30.5, RPS≈76.3
  → RPS GIẢM 23% — ĐÂY LÀ TÍN HIỆU
  → VUs vẫn = 20 (phẳng) nhưng throughput giảm
  → Closed-model backpressure visible
```

### Demo 3: Một service chậm, các service khác bình thường

```text
Tình huống: phút thứ 3, order-service (checkout) bị chậm.
  Các service khác (products, cart) vẫn bình thường.

  browse loop:   50+30+400 = 480ms (không đổi)
  cart loop:     50+30+40+400 = 520ms (không đổi)
  checkout loop: 50+30+40+2000+400 = 2520ms (chậm vì order-service)

  Weighted avg: 0.7×480 + 0.25×520 + 0.05×2520 = 336 + 130 + 126 = 592ms

  iter/s ≈ 20 / 0.592 ≈ 33.8 iter/s

  Nhưng — đây là weighted average.
  Nếu chỉ nhìn aggregate: iter/s giảm từ 39.8 → 33.8 (giảm 15%)
  → Có vẻ "hơi chậm", không nghiêm trọng

  NHƯNG nếu tách theo operation:
  checkout p95: 200ms → 2000ms (TĂNG 10x!)
  → Checkout branch đang chết, nhìn aggregate không thấy

  Đây là lý do PHẢI tách operation trong constant-vus mixed flow.
```

### Tại sao closed-model backpressure là TÍN HIỆU, không phải bug?

```text
So sánh 2 cách nghĩ:

Cách nghĩ SAI (open-model mindset):
  "Tôi config 20 VU, tôi expect RPS ~100.
   RPS giảm còn 76 → k6 có bug, không bơm đủ traffic!"
  → Sai vì constant-vus không config RPS target.

Cách nghĩ ĐÚNG (closed-model mindset):
  "Tôi config 20 VU trong 5m. RPS là output tự nhiên.
   RPS giảm từ 100 → 76 → loop_duration tăng từ 0.5s → 0.66s
   → Backend đang chậm hơn. Cần điều tra latency by operation."
  → Đúng vì RPS giảm là tín hiệu closed-model.

Tương tự thực tế:
  20 khách trong siêu thị.
  Nếu quầy tính tiền chậm (thêm nhân viên nghỉ ốm):
    - Khách vẫn 20 người (VU flat)
    - Nhưng mỗi khách tốn nhiều thời gian hơn ở quầy
    - Tổng số khách ra khỏi siêu thị mỗi giờ GIẢM
    → Đây là điều BÌNH THƯỜNG, không phải "siêu thị có bug"
```

### Contrast closed model vs open model

```text
CLOSED MODEL (constant-vus):
  Input:  vus=20, duration=5m
  Output: iter/s, RPS, latency
  Khi backend chậm: RPS GIẢM, VUs FLAT
  Signal: "RPS giảm + VUs flat" = có vấn đề

OPEN MODEL (constant-arrival-rate):
  Input:  rate=40/s, duration=5m
  Output: VUs, latency, drops
  Khi backend chậm: VUs TĂNG (để giữ rate), drops có thể TĂNG
  Signal: "VUs tăng + latency tăng" = có vấn đề

Cả 2 đều phát hiện được vấn đề, nhưng:
  - Closed model: phát hiện qua THROUGHPUT GIẢM
  - Open model:  phát hiện qua CONCURRENCY TĂNG

  Case này là "20 shoppers trong siêu thị" → concurrency CỐ ĐỊNH
  → Chọn closed model (constant-vus) vì input thực tế là concurrency
```

## Identity model trong constant-vus: VU = stable user identity

Đây là điểm khác biệt quan trọng với shared-iterations.

### VU identity trong constant-vus

```text
Trong constant-vus:
  VU=1  LUÔN là user-1 trong suốt 5 phút
  VU=2  LUÔN là user-2 trong suốt 5 phút
  ...
  VU=20 LUÔN là user-20 trong suốt 5 phút

  → VU identity = STABLE USER IDENTITY
  → Có thể dùng __VU làm user_id, session token, cart state
  → Mỗi VU có state riêng sống qua NHIỀU loops
```

### So sánh với shared-iterations

```text
Trong shared-iterations:
  VU=1: worker-1, xử lý job #0 (SKU #0), rồi job #3 (SKU #3), rồi job #7...
  → VU identity = WORKER ID (không phải user)
  → KHÔNG dùng __VU làm business identity
  → KHÔNG có per-VU persistent state hữu ích

Trong constant-vus:
  VU=1: user-1, loop #0: browse→cart, loop #1: browse→browse, loop #2: browse→checkout...
  → VU identity = USER ID (người dùng thật)
  → CÓ THỂ dùng __VU làm user_id
  → CÓ per-VU persistent state: session, cart, token

Đây là khác biệt CỐT LÕI:
  shared-iterations: VU = anonymous worker
  constant-vus:      VU = named active user
```

### Demo trace identity model với 3 VU trong 10 giây

```text
Config: vus=3, duration=10s, sleep=0.5s

Timeline:
t=0.0s   VU=1 (user-1): loop #0, __ITER=0, browse_list + browse_detail
         VU=2 (user-2): loop #0, __ITER=0, browse_list + cart_add
         VU=3 (user-3): loop #0, __ITER=0, browse_list + browse_detail

t=0.5s   VU=1 xong loop #0, sleep(0.4), bắt đầu loop #1
         loop #1: browse_list + browse_detail + cart_add
         (VU=1 vẫn là user-1, __ITER=1)

t=0.6s   VU=2 xong loop #0, sleep(0.4), bắt đầu loop #1
         loop #1: browse_list + checkout (user-2 checkout!)
         (VU=2 vẫn là user-2, __ITER=1)

t=0.7s   VU=3 xong loop #0, sleep(0.4), bắt đầu loop #1
         (VU=3 vẫn là user-3, __ITER=1)

... tiếp tục trong 10s

Tổng kết:
  user-1 (VU=1): hoàn tất ~9 loops, mỗi loop là 1 trải nghiệm browse
  user-2 (VU=2): hoàn tất ~8 loops, có 1 lần checkout
  user-3 (VU=3): hoàn tất ~8 loops

  iterationInTest: global loop counter, từ 0 đến ~25
  __VU:            stable user identity, 1..3
  __ITER:          per-user loop counter, mỗi user 0..8/9

Khác với shared-iterations:
  - iterationInTest trong shared-iterations = global JOB index (backlog)
  - iterationInTest trong constant-vus = global LOOP counter (observation)
```

### Code pattern: dùng __VU làm user identity

```js
import exec from "k6/execution";

export default function () {
  // Trong constant-vus, __VU là stable user identity
  const userId = exec.vu.idInTest;  // 1..20, ổn định suốt 5m
  // hoặc: const userId = __VU;

  // Có thể dùng userId cho:
  // - Session token riêng cho mỗi user
  // - Cart state sống qua nhiều loops
  // - User-specific headers/cookies

  const params = {
    tags: {
      user_id: `user-${userId}`,    // stable user identity
      vu: userId,                    // để filter theo VU nếu cần
    },
  };

  // Browse flow với user identity ổn định
  const listRes = http.get(`${BASE_URL}/api/sim/products?...`, params);
  // ...
}
```

**Khác với shared-iterations — nơi identity đến từ iterationInTest**:

```js
// shared-iterations: identity từ iterationInTest (global job index)
const skuIndex = exec.scenario.iterationInTest;  // 0..79, mỗi iter KHÁC nhau
const sku = SKUS[skuIndex];

// constant-vus: identity từ __VU (stable user)
const userId = exec.vu.idInTest;  // 1..20, LUÔN là user đó
```

### Mối quan hệ giữa các identity trong constant-vus

```text
Ba khái niệm KHÁC NHAU trong constant-vus:

1. __VU / exec.vu.idInTest:
   - Stable user identity, 1 đến vus
   - VU=1 là user-1 trong SUỐT duration
   - Dùng làm: user_id, session, cart owner

2. __ITER:
   - Per-VU loop counter, bắt đầu từ 0
   - VU=1: __ITER=0 (loop đầu), __ITER=1 (loop hai), ...
   - Cho biết: user này đã browse bao nhiêu vòng

3. exec.scenario.iterationInTest:
   - Global loop counter, từ 0 đến tổng số loops
   - DUY NHẤT cho mỗi loop trong toàn scenario
   - Cho biết: đây là loop thứ mấy của toàn bộ test
   - KHÔNG phải backlog job id (vì không có backlog)
```

## Technical root causes this case catches

Mỗi nguyên nhân dưới đây là một pattern lỗi thực tế mà constant-vus phát hiện được, nhưng các executor khác có thể bỏ sót.

### Nguyên nhân kỹ thuật 1: Browse latency lowers natural RPS while VUs stay flat

**Vấn đề**: Khi products-service hoặc cart-service chậm, loop_duration của shopper tăng lên. Với closed model, VUs vẫn active nhưng mỗi VU hoàn tất ít loops hơn → iter/s và RPS giảm.

**Real-world analogy**:

```text
Tưởng tượng siêu thị có 20 khách.
Bình thường: mỗi khách browse 1 vòng (đi 1 dãy hàng) mất 30 giây.
→ Mỗi phút có ~40 khách hoàn tất 1 vòng browse.

Bỗng nhiên: nhân viên sắp xếp lại hàng, lối đi bị chặn 1 phần.
Mỗi khách vẫn browse, nhưng đi chậm hơn → 1 vòng mất 45 giây.
→ Mỗi phút chỉ còn ~27 khách hoàn tất 1 vòng.

SIÊU THỊ VẪN CÓ 20 KHÁCH (VUs flat).
Nhưng throughput (khách hoàn tất vòng/phút) GIẢM.
→ Đây là closed-model: concurrency không đổi, throughput giảm.
```

**Demo trace: 3 scenarios of latency change**

```text
Scenario A — NORMAL (baseline):
  vus=20, loop_duration avg=0.55s
  iter/s = 20 / 0.55 = 36.4 iter/s
  Mỗi loop: 2.5 requests trung bình
  RPS = 36.4 × 2.5 = 91 req/s
  VUs chart: flat at 20
  iter/s chart: dao động quanh 36

Scenario B — BROWSE SLOW (products-service degraded):
  vus=20, loop_duration avg=0.75s (tăng 36%)
  iter/s = 20 / 0.75 = 26.7 iter/s (giảm 27%)
  RPS = 26.7 × 2.5 = 66.8 req/s (giảm 27%)
  VUs chart: flat at 20 ← VẪN FLAT!
  iter/s chart: dao động quanh 27 ← GIẢM RÕ

  → Signal: VUs flat + iter/s giảm = BROWSE ĐANG CHẬM
  → Phải tách operation để xem operation nào chậm

Scenario C — INTERMITTENT SLOW (spike latency mỗi 60s):
  vus=20, loop_duration: 0.55s (thường) → 1.2s (spike) → 0.55s
  iter/s: 36 → 16.7 → 36 (dao động theo chu kỳ)
  VUs chart: flat at 20 (vẫn flat qua spike)
  RPS: 91 → 42 → 91

  → Signal: iter/s có pattern dao động chu kỳ
  → Có thể do: GC pause, cron job, cache refresh định kỳ
  → Arrival-rate sẽ CHE pattern này vì nó tăng VU để giữ RPS
```

**Cách phát hiện trên dashboard**:

```text
VUs vs iter/s chart:
  - VUs: đường phẳng ở 20
  - iter/s: đường đi xuống (trend giảm) hoặc dao động chu kỳ
  → Đây LÀ closed-model signal

Execution timeline:
  - RPS/iter/s per bucket: thấy trend giảm theo thời gian
  - Nếu giảm đột ngột ở 1 bucket: có event (deploy, backup, GC)

Response time by operation:
  - Lọc theo operation để tìm operation nào kéo loop_duration
  - Nếu tất cả operation cùng chậm: vấn đề hạ tầng chung
  - Nếu chỉ 1 operation chậm: vấn đề service cụ thể
```

**Đừng nhầm**: iter/s giảm không phải là "k6 chạy ít đi". Đó là "cùng 20 users, nhưng mỗi user browse chậm hơn vì backend chậm". Đây là tín hiệu CẦN điều tra, không phải bug của test.

### Nguyên nhân kỹ thuật 2: Checkout branch nhỏ nhưng có thể kéo mixed p95

**Vấn đề**: Checkout chỉ chiếm 5% weighted mix, nhưng có external dependency (payment, order-service) nên latency có thể cao gấp 5-10 lần browse. Khi nhìn aggregate p95, checkout kéo p95 lên dù 95% request còn lại vẫn nhanh.

**Real-world analogy**:

```text
Siêu thị có 20 khách. 19 người chỉ browse, 1 người ra quầy tính tiền.

Bình thường:
  - Browse: 30 giây/khách
  - Checkout: 2 phút (quầy tính tiền)

Nếu nhìn "thời gian trung bình 1 khách trong siêu thị":
  avg = (19×30 + 1×120) / 20 = 34.5 giây → có vẻ ổn

Nhưng nếu nhìn riêng khách checkout: 120 giây → ĐANG CÓ VẤN ĐỀ!
Và nếu quầy tính tiền hỏng: checkout thành 10 phút → 1 khách bị kẹt.

Nếu chỉ nhìn aggregate: avg = (19×30 + 1×600) / 20 = 58.5 giây
→ "Hơi chậm" — nhưng thực ra checkout đang CHẾT.
```

**Demo trace: checkout kéo aggregate p95**

```text
Config: vus=20, duration=5m
Weighted mix: browse 70%, cart 25%, checkout 5%

Sau 5m, giả sử có 10000 iterations:
  browse iterations:   ~7000
  cart iterations:     ~2500
  checkout iterations: ~500

Response time từng operation (p95):
  storefront_browse_list:   45ms
  storefront_browse_detail: 35ms
  storefront_cart_add:      55ms
  storefront_checkout:      850ms  ← CAO GẤP 15-20 LẦN!

Aggregate http_req_duration p95 (tất cả operation gộp lại):
  Tổng requests: 7000×2.5 + 2500×3 + 500×4 ≈ 17500+7500+2000 ≈ 27000
  Trong đó checkout requests: 500×4 = 2000 requests (~7.4%)
  Nhưng checkout p95=850ms, cao hơn hẳn các request khác

  Aggregate p95: có thể bị checkout kéo lên ~200-300ms
  → Nhìn aggregate: "p95 ~250ms, cũng tạm"
  → Nhìn riêng checkout: "p95 = 850ms — ĐANG CÓ VẤN ĐỀ!"

Nếu checkout degraded (external service chậm):
  storefront_checkout p95: 850ms → 3500ms
  Aggregate p95: 250ms → 450ms (tăng, nhưng không quá alarming)
  → Dễ bỏ sót nếu chỉ nhìn aggregate!
```

**Cách phát hiện**:

```text
Trên Response time chart:
  - LUÔN LUÔN group/filter theo tag operation
  - So sánh p95 của checkout vs browse vs cart
  - Nếu checkout p95 >> browse p95: checkout dependency có vấn đề

Trên dashboard:
  - KHÔNG chỉ nhìn aggregate http_req_duration
  - Phải drill down: operation=storefront_checkout
  - So sánh count checkout vs expected (5% của total iter):
    Nếu checkout count << 5%: có thể checkout bị fail/timeout nhiều
    Nếu checkout count ~5% nhưng p95 cao: checkout chậm nhưng vẫn chạy
```

**Checkout p95 decomposition**:

```text
storefront_checkout = POST /api/sim/checkout
  Thường bao gồm:
    - Validate cart items (internal, nhanh)
    - Tính tổng tiền (internal, nhanh)
    - Gọi external payment (external_ms, có thể CHẬM)
    - Tạo order record (internal, nhanh)

  → external_ms là bottleneck chính của checkout
  → Nếu checkout p95 cao, nghi ngờ external dependency đầu tiên

So sánh với cart_add (không có external dependency):
  storefront_cart_add: POST /api/sim/cart/add
    - Validate product (internal)
    - Update cart state (internal)
    → Thường nhanh hơn checkout nhiều
```

### Nguyên nhân kỹ thuật 3: Weighted operation mix hides branch bottlenecks

**Vấn đề**: Với weighted mix browse=70%, cart=25%, checkout=5%, nếu chỉ nhìn aggregate metrics (tổng http_reqs, avg latency), branch checkout (5%) bị "pha loãng" trong aggregate. Checkout có thể đang fail hoặc cực chậm mà aggregate vẫn đẹp.

**Real-world analogy**:

```text
Bệnh viện có 100 bệnh nhân/giờ:
  95 người: khám thông thường (5 phút/người)
  5 người: cấp cứu (60 phút/người)

Nếu nhìn "thời gian trung bình":
  avg = (95×5 + 5×60) / 100 = 7.75 phút → "Ổn, dưới 10 phút"

Nhưng 5 người cấp cứu đợi 60 phút — CÓ THỂ CHẾT!
Aggregate che mất vấn đề nghiêm trọng.

Tương tự: checkout 5% nhưng nếu checkout fail, 5% khách hàng
không mua được hàng → mất doanh thu từ 5% khách.
```

**Demo trace: aggregate OK nhưng checkout branch chết**

```text
Run 5m, 20 VU, ~10000 iterations:

Aggregate metrics:
  http_reqs:            ~27000
  http_req_failed:      0.5%     ← Có vẻ ổn
  http_req_duration avg: 85ms    ← Có vẻ nhanh
  http_req_duration p95: 250ms   ← Có vẻ chấp nhận được

Tách theo operation:
  storefront_browse_list:   7000 req, p95=45ms,  0 fail
  storefront_browse_detail: 7000 req, p95=35ms,  0 fail
  storefront_cart_add:      2500 req, p95=55ms,  0 fail
  storefront_checkout:      500 req,  p95=3500ms, 35 fail (7%!)

  → Checkout: p95=3500ms, 7% fail rate → ĐANG CÓ VẤN ĐỀ NGHIÊM TRỌNG
  → Nhưng aggregate: p95=250ms, 0.5% fail → CHE MẤT HOÀN TOÀN

Nếu không tách operation:
  → Tưởng hệ thống ổn
  → Thực ra 5% khách checkout đang bị fail/timeout
  → Mất doanh thu từ những khách này
```

**Cách phát hiện**:

```text
Trên dashboard, LUÔN tách metric theo operation tag:

Response time chart:
  - Group by: operation
  - Xem riêng từng đường: browse_list, browse_detail, cart_add, checkout
  - Nếu 1 đường cao vọt lên so với các đường khác → bottleneck branch

Execution timeline:
  - Lọc theo operation: checkout requests per bucket
  - Nếu checkout count thấp hơn expected (5% của total): có thể đang fail
  - Nếu checkout count = 0 trong vài bucket: checkout branch bị block

Checks:
  - Lọc checks fail theo operation tag
  - "checkout status 200" fail nhiều hơn "browse status 200"?
```

**Công thức kiểm tra mix có đúng không**:

```text
Expected operation distribution với weighted mix:

  total_iterations = N (từ summary)

  expected_browse_iterations  ≈ N × 0.70
  expected_cart_iterations    ≈ N × 0.25
  expected_checkout_iterations ≈ N × 0.05

  Nếu checkout_iterations << N × 0.05:
    → Checkout branch bị fail/timeout → iteration không hoàn tất
    → Mất coverage checkout

  Nếu cart_iterations << N × 0.25:
    → Cart branch có vấn đề

  Lưu ý: đây là EXPECTED gần đúng (weighted random), không phải exact.
  Với N=10000, expected checkout=500; thực tế 450-550 là bình thường.
  Nếu thực tế checkout=150 → bất thường.
```

### Nguyên nhân kỹ thuật 4: No dropped arrivals expected (closed model không drop)

**Vấn đề**: Trong constant-vus, không có khái niệm "dropped iterations" hay "dropped arrivals". Mỗi VU luôn chạy loop tiếp theo khi loop hiện tại xong. Nếu backend quá chậm, VU vẫn đợi — không drop. Điều này KHÁC với arrival-rate executor, nơi iteration có thể bị drop nếu không đủ VU.

**Real-world analogy**:

```text
Hàng đợi tính tiền siêu thị (closed model):
  - 20 khách trong siêu thị
  - Mỗi khách tự quyết định khi nào ra quầy tính tiền
  - Nếu quầy chậm: khách đợi lâu hơn, nhưng KHÔNG AI BỊ ĐUỔI RA NGOÀI
  - Không có "drop" — tất cả khách đều được phục vụ (dù chậm)

Hàng đợi có rate limit (open model):
  - Cho phép tối đa 40 khách/giờ vào siêu thị
  - Nếu siêu thị đông, khách mới bị chặn ở cửa (DROP)
  - Một số khách không được vào
```

**Demo trace: so sánh drop giữa 2 executor**

```text
Tình huống: phút thứ 3-4, backend đột ngột chậm (loop_duration 0.5s → 2.0s)

constant-vus (vus=20):
  t=0-180s:  loop=0.5s, iter/s=40,  VU=20
  t=180-240s: loop=2.0s, iter/s=10, VU=20 (GIẢM throughput, VU PHẲNG)
  t=240-300s: loop=0.5s, iter/s=40, VU=20 (hồi phục)
  → Không drop iteration nào. Tất cả VU đều đợi.
  → Tổng iterations: 40×180 + 10×60 + 40×60 = 7200+600+2400 = 10200

constant-arrival-rate (rate=40, maxVUs=30):
  t=0-180s:  rate=40, VU~20 (bình thường)
  t=180-240s: rate=40, VU cần = 40×2.0 = 80 VU để giữ rate
              Nhưng maxVUs=30 → cần 80, chỉ có 30
              → k6 vẫn schedule 40/s nhưng chỉ 30/2.0=15/s thực hiện được
              → 40-15=25 arrivals bị DROP mỗi giây!
              → 25×60 = 1500 iterations bị drop trong 60s
  t=240-300s: hồi phục
  → Có drop iterations. Một số job không được xử lý.
  → Tổng completed: 40×180 + 15×60 + 40×60 = 7200+900+2400 = 10500
  → Tổng dropped: 1500 iterations

SO SÁNH:
  constant-vus:         10200 completed, 0 dropped → tất cả user được phục vụ
  constant-arrival-rate: 10500 completed, 1500 dropped → 12.5% job bị drop

  Ý nghĩa:
    - constant-vus: "backend chậm, user phải đợi lâu hơn" → trải nghiệm kém nhưng không mất user
    - constant-arrival-rate: "backend chậm, một số user bị từ chối" → mất user

  Với business-hours storefront, ta muốn biết "user có đợi lâu không?"
  chứ không muốn biết "bao nhiêu user bị từ chối?" (vì giờ bình thường không có surge).
```

**Cách phát hiện**: trong constant-vus, iterations luôn = số loops hoàn tất. Không có drop, không có interrupt (trừ khi bị maxDuration cắt). Nếu thấy `interrupted` > 0, kiểm tra maxDuration.

## Service/API flow

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| storefront_browse_list | products-service | GET | /api/sim/products | 200 | Browse product list. |
| storefront_browse_detail | products-service | GET | /api/sim/products/:id | 200 | Open product detail. |
| storefront_cart_add | cart-service | POST | /api/sim/cart/add | 200 | Add item to cart. |
| storefront_checkout | order-service | POST | /api/sim/checkout | 200 | Occasional checkout branch. |

Các operation này phải được đọc bằng tag `operation`, vì aggregate metrics có thể che branch nhỏ nhưng chậm.

### Flow của từng branch

```text
BRANCH: browse (70%)
  1. GET /api/sim/products              → storefront_browse_list
  2. sleep(think_time)                  → user đọc list
  3. GET /api/sim/products/:id          → storefront_browse_detail
  4. sleep(think_time)                  → user đọc detail
  → Loop hoàn tất, VU bắt đầu loop mới

BRANCH: cart (25%)
  1. GET /api/sim/products              → storefront_browse_list
  2. sleep(think_time)
  3. GET /api/sim/products/:id          → storefront_browse_detail
  4. sleep(think_time)
  5. POST /api/sim/cart/add             → storefront_cart_add
  6. sleep(think_time)
  → Loop hoàn tất

BRANCH: checkout (5%)
  1. GET /api/sim/products              → storefront_browse_list
  2. sleep(think_time)
  3. GET /api/sim/products/:id          → storefront_browse_detail
  4. sleep(think_time)
  5. POST /api/sim/cart/add             → storefront_cart_add
  6. sleep(think_time)
  7. POST /api/sim/checkout             → storefront_checkout
  8. sleep(think_time)
  → Loop hoàn tất
```

## Metrics và tags cần đọc

| Metric | Type | Đọc như thế nào |
| --- | --- | --- |
| `constant_active_iterations` | Counter | Số user loops hoàn tất trong fixed-duration run. Đây là output, không phải target. |
| `constant_active_iterations_failed` | Counter | Số user loops có ít nhất một API required bị fail. Đây là business-flow failure counter. |
| `constant_api_calls_total` | Counter | Tổng API calls do active users tạo ra. Dùng để đối chiếu calls/loop hoặc weighted mix. |
| `constant_flow_duration_ms` | Trend | End-to-end duration của một user loop, bao gồm nhiều API trong flow. |
| `constant_sleep_seconds` | Counter | Tổng think time/sleep do script cố ý thêm để mô phỏng user thật. |
| `checks` | Rate | API/status/contract checks pass bao nhiêu %. |
| `http_req_failed` | Rate | HTTP/network/protocol failure rate theo k6. |
| `iterations` | Counter | Số vòng `default()` hoàn tất. Với `constant-vus`, đây là observed output. |

### Tags chung

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `cv-01-business-hours-storefront`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service được gọi. |
| `operation` | Operation cụ thể trong user loop. |
| `endpoint` | Nhóm endpoint/API family. |
| `user_id` | Active user identity derive từ VU/user context. |
| `executor_family` | `constant_vus`. |
| `workload_shape` | `steady_concurrency`. |

Tags case này:

```text
case_id       = cv-01-business-hours-storefront
business_case = business_hours_storefront
workload      = steady_concurrency
```

### Cách đọc metric với weighted mix

```text
Để kiểm tra weighted mix có đúng không:

  total_iterations = N (từ summary iterations)

  expected_browse_iterations  ≈ N × 0.70
  expected_cart_iterations    ≈ N × 0.25
  expected_checkout_iterations ≈ N × 0.05

  (Đây là expected gần đúng — weighted random không ra exact)

Để kiểm tra API calls:

  constant_api_calls_total ≈
    browse_iterations  × requests_per_browse_loop +
    cart_iterations    × requests_per_cart_loop +
    checkout_iterations × requests_per_checkout_loop

  Với requests_per_loop:
    browse:   2 (list + detail)
    cart:     3 (list + detail + cart_add)
    checkout: 4 (list + detail + cart_add + checkout)
```

## Pass criteria

Pass criteria tối thiểu theo backend script:

```text
checks rate > 0.99
http_req_failed rate < 0.01
constant_active_iterations_failed count<20
```

Các counters cần sanity check:

```text
constant_active_iterations ~= iterations completed by user loops
constant_api_calls_total   ~= API calls generated by completed/attempted loops
constant_flow_duration_ms  = end-to-end loop duration
constant_sleep_seconds     = configured think time actually applied
```

Không có expected exact count cho:

```text
iterations
http_reqs
RPS
iter/s
```

Chúng là observed outputs.

### Tại sao không có pass criteria cho iterations count?

```text
Nếu đặt: "iterations phải > 10000 mới pass"

Vấn đề:
  - Backend nhanh: iter/s=40, 5m → 12000 iterations → PASS
  - Backend chậm: iter/s=30, 5m → 9000 iterations → FAIL

  Nhưng "backend chậm" mới là điều ta muốn PHÁT HIỆN!
  Nếu fail test vì iterations thấp, ta đã phát hiện vấn đề.
  Nhưng nếu đặt threshold quá cao, test luôn fail dù backend bình thường.

Thay vào đó, dùng latency thresholds nếu muốn performance gate:
  "http_req_duration{operation:storefront_browse_list}": ["p(95)<200"],
  "http_req_duration{operation:storefront_checkout}": ["p(95)<1000"],

Hoặc dùng trend metric:
  "constant_flow_duration_ms": ["p(95)<1500"],
```

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js
```

Override env vars:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:CV_01_VUS = 30
$env:CV_01_DURATION = "10m"
$env:CV_01_SLEEP_SECONDS = 0.2
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
CV_01_VUS = 20
CV_01_DURATION = 5m
CV_01_SLEEP_SECONDS = 0.4

browse 70%
cart 25%
checkout 5%
```

| Config/env | Giá trị | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `CV_01_VUS` | 20 | Số active shoppers |
| `CV_01_DURATION` | 5m | Observation window |
| `CV_01_SLEEP_SECONDS` | 0.4 | Think time giữa các vòng |

Weighted mix expected:

| Branch | Weight |
| --- | --- |
| browse | 70% |
| cart | 25% |
| checkout | 5% |

Threshold cap riêng:

```text
constant_active_iterations_failed: count<20
```

## Technical semantics: active user pool, loop identity, closed model

Trong constant-vus:

```text
__VU / exec.vu.idInTest = active user identity tương đối ổn định
__ITER                  = loop counter của riêng VU đó
exec.scenario.iterationInTest = global loop counter, không phải backlog job id
```

Một VU có thể chạy nhiều loops trong duration. Nhưng không có quota kiểu:

```text
mỗi VU phải chạy đúng N loops
```

Nếu cần quota per user, dùng `per-vu-iterations`.

Nếu cần fixed global job list, dùng `shared-iterations`.

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = constant-vus
vus = 20 hoặc env override
duration = 5m hoặc env override
```

Nếu learner override env vars (CV_01_VUS, CV_01_DURATION), phải recompute toàn bộ expected relationships (nhưng không recompute expected exact counts — vì counts là output).

### Bước 2 — Verify active-user model

Summary/dashboard nên thể hiện VUs giữ gần configured VUs trong regular phase.

```text
Trên VUs vs iter/s chart:
  - Đường VUs phải PHẲNG gần 20 trong regular phase
  - Nếu VUs không phẳng: kiểm config (maxVUs đủ không?), 
    dashboard ingestion, hoặc VU init/teardown issue
  - Nếu VUs < 20 từ đầu: env override hoặc config sai
```

Nếu VUs không flat, kiểm config/ingestion trước khi kết luận backend.

### Bước 3 — Check failures trước throughput

Đọc trước:

```text
checks
http_req_failed
constant_active_iterations_failed
```

Nếu các metric này fail, xử lý correctness/failure trước khi bàn RPS.

```text
Thứ tự ưu tiên:
  1. checks rate < 0.99 → có request sai status/contract → BLOCK
  2. http_req_failed > 0.01 → có HTTP failure → BLOCK
  3. constant_active_iterations_failed >= 20 → user loop fail nhiều → BLOCK

  Chỉ khi 3 metric trên pass → mới phân tích latency/throughput
```

### Bước 4 — Interpret counters as outputs

Đọc:

```text
iterations
http_reqs
constant_active_iterations
constant_api_calls_total
```

Nhớ:

```text
iterations thấp hơn run khác không tự động fail.
Có thể do backend latency tăng hoặc sleep/config khác.

Cách so sánh 2 run cùng config:
  1. Check failures trước (phải pass cả 2)
  2. So sánh iterations: run nào ít hơn → loop_duration dài hơn
  3. Check constant_flow_duration_ms: run nào p95 cao hơn → backend chậm hơn
  4. Check http_req_duration by operation: operation nào tăng?
  5. Kết luận: "run B chậm hơn run A vì checkout p95 tăng từ 850ms → 1200ms"
```

### Bước 5 — Interpret duration/throughput

Đọc:

```text
constant_flow_duration_ms
iteration_duration
http_req_duration by operation
```

Case-specific notes:

- `iterations` là số shopper loops hoàn tất trong 5m, không có expected exact count.
- `constant_api_calls_total` phải đọc cùng weighted mix; browse path có thể tạo nhiều products calls hơn checkout.
- `constant_flow_duration_ms` cho biết full shopper loop bị chậm bởi branch nào.
- So sánh `iteration_duration` với `constant_flow_duration_ms`: iteration_duration bao gồm sleep, flow_duration thường không.

### Bước 6 — Verify weighted mix distribution

```text
Từ summary, estimate operation distribution:

  total_iterations = N (từ summary)
  
  Browse iterations  ≈ N × 0.70 (khoảng)
  Cart iterations    ≈ N × 0.25 (khoảng)
  Checkout iterations ≈ N × 0.05 (khoảng)

  Nếu checkout count << N × 0.05: checkout branch đang fail
  Nếu cart count << N × 0.25: cart branch có vấn đề

  Lưu ý: weighted random có độ lệch tự nhiên ±10-20%
  Với N=10000, checkout expected=500, actual 400-600 là bình thường
  Nếu actual=100 → bất thường
```

## Đọc dashboard real-time charts cho case 01

> Phần này mô tả cách đọc expected dashboard. Chỉ thêm run ID/số p95/bucket thật sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? | Total iterations target, vì không có target đó |
| Execution timeline | VUs/RPS/iter/s thay đổi theo time thế nào? | Business branch nào chậm nếu không lọc operation |
| VUs vs iter/s | VUs có flat không, iter/s có giảm không? | Fixed RPS target, vì constant-vus không config RPS |

Một cách đọc nhanh:

```text
Response time      -> chất lượng request, phát hiện bottleneck operation
Execution timeline -> throughput pattern, phát hiện closed-model slowdown
VUs vs iter/s      -> worker pool shape, phát hiện VU instability hoặc backpressure
```

### Chart 1 — Response time

Đây là chart request-level latency. Với case này, PHẢI đọc theo `operation`, không đọc aggregate.

#### Các operation cần tách

```text
storefront_browse_list:   GET /api/sim/products
storefront_browse_detail: GET /api/sim/products/:id
storefront_cart_add:      POST /api/sim/cart/add
storefront_checkout:      POST /api/sim/checkout
```

#### Cách đọc

```text
http_req_duration       = latency từng request (KHÔNG bao gồm sleep)
constant_flow_duration_ms = latency full user loop (có thể không bao gồm sleep)
iteration_duration      = duration vòng default(), thường bao gồm sleep
```

Đừng dùng aggregate p95 một mình trong mixed/multi-operation flow.

#### Phân tích sâu chart Response time

Khi nhìn chart này, đọc theo 5 câu hỏi:

```text
1. Operation nào có p95 cao nhất?
2. p95 của checkout có >> p95 của browse không?
3. Có operation nào có trend tăng dần theo thời gian không?
4. Có operation nào có spike đột ngột ở bucket cụ thể không?
5. Max của operation nào đang kéo aggregate lên?
```

Shape mong đợi với case 01:

```text
đầu run (0-30s):
  - p95/max có thể cao hơn (cold start, connection pool init)
  - 20 VU cùng start → burst request ban đầu

giữa run (30s-270s):
  - p95 ổn định cho browse_list, browse_detail, cart_add
  - checkout p95 cao hơn hẳn (có external_ms)
  - Đây là NORMAL — checkout luôn chậm hơn browse

cuối run (270s-300s):
  - p95 không tăng bất thường
  - Nếu tăng: có thể backend mệt sau 5m (memory leak, connection pool cạn)
```

#### Decomposition p95 cho weighted mix

```text
Đây là kỹ thuật quan trọng: tách aggregate p95 để tìm operation nào kéo tail.

Giả sử aggregate http_req_duration p95 = 280ms.

Tách theo operation:
  storefront_browse_list:   p95=55ms   ← rất nhanh
  storefront_browse_detail: p95=45ms   ← rất nhanh
  storefront_cart_add:      p95=70ms   ← nhanh
  storefront_checkout:      p95=950ms  ← CHẬM, kéo aggregate

  → Kết luận: aggregate p95=280ms bị checkout kéo lên
  → Nếu chỉ nhìn aggregate: "280ms, cũng được"
  → Nhìn riêng checkout: "950ms — cần điều tra order-service"

Công thức ước lượng:
  Nếu checkout chiếm ~7% requests và p95=950ms,
  aggregate p95 sẽ bị kéo lên đáng kể dù 93% requests còn lại nhanh.
```

#### Shape xấu cần chú ý

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| Checkout p95 >> browse p95 (gấp 10x+) | External payment/order dependency chậm | Inspect order-service, external_ms |
| Browse p95 tăng dần theo thời gian | products-service memory leak, cache degradation | So sánh p95 đầu run vs cuối run |
| Cart p95 spike đột ngột | cart-service có vấn đề (DB lock, connection pool) | Xem bucket time, correlate với deploy/backup |
| Tất cả operation p95 cùng tăng | Vấn đề hạ tầng chung (network, load balancer) | Kiểm infrastructure metrics |
| Checkout max >> checkout p95 (max=15000, p95=950) | Vài checkout request bị timeout/extreme latency | Điều tra external service timeout |
| Browse p95 tăng nhưng cart/checkout không | products-service riêng bị ảnh hưởng | Route về products-service team |
| p95 ổn nhưng max có spike lẻ tẻ | Vài outlier đơn lẻ (GC pause, network blip) | Ghi nhận nhưng chưa vội fail |

### Chart 2 — Execution timeline

Chart này trả lời câu hỏi KHÁC với Response time:

```text
Response time chart:
  "request nhanh/chậm thế nào?"

Execution timeline:
  "tại mỗi giây, 20 users tạo ra bao nhiêu iterations? bao nhiêu HTTP requests?
   Có pattern bất thường không?"
```

Với constant-vus:

```text
VUs should be flat near 20 during regular phase.
iterations/http_reqs per bucket are observed outputs.
RPS depends on loop duration + API mix + sleep.
```

#### Cách đọc Execution timeline

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs — có giữ 20 trong suốt 5m không?
2. HTTP reqs per bucket — RPS có ổn định không?
3. Iterations per bucket — iter/s có pattern gì không?
```

Shape mong đợi:

```text
đầu run (0-10s):
  - Live VUs tăng từ 0 → 20 (VU init phase)
  - HTTP reqs và iterations: có thể 0 hoặc thấp (chưa loop nào xong)

giữa run (10s-290s):
  - Live VUs = 20 (phẳng)
  - HTTP reqs: dao động quanh ~80-100 req/s (tùy backend latency)
  - Iterations: dao động quanh ~30-40 iter/s

cuối run (290s-300s):
  - Live VUs giảm dần về 0 (gracefulStop)
  - HTTP reqs và iterations giảm về 0
```

#### Pattern cần đọc

Nếu thấy:

```text
VUs flat nhưng RPS/iter/s giảm
```

thì đọc là:

```text
closed-model slowdown/backpressure
→ Loop duration tăng → throughput giảm
→ CẦN ĐIỀU TRA latency by operation
```

không đọc là:

```text
k6 không bơm đủ target RPS
```

vì không có target RPS trong constant-vus.

#### Invalid patterns

| Pattern | Nghĩa |
| --- | --- |
| VUs không lên đủ 20 từ đầu | Config/env sai, VU init lỗi, maxVUs không đủ |
| VUs dao động (không flat) | Scenario config issue, gracefulRampDown quá sớm |
| VUs flat nhưng HTTP reqs = 0 trong nhiều bucket | VU bị kẹt trong sleep hoặc request treo |
| RPS tăng dần dù VUs flat | Backend đang warm up (cache fill, connection pool) |
| RPS giảm đột ngột ở 1 bucket | Có event: deploy, backup, network blip |
| Iterations = 0 trong bucket đầu | Bình thường — loop đầu chưa kịp xong |
| Iterations << HTTP reqs | Mỗi loop có nhiều requests — bình thường |
| Live VUs giảm về 0 trước duration | maxDuration quá ngắn hoặc gracefulStop cắt |

### Chart 3 — VUs vs iter/s

Chart này là **trọng tâm của constant-vus** — nó trả lời câu hỏi quan trọng nhất:

```text
Active user pool có giữ được concurrency không?
Throughput (iter/s) có phản ánh đúng closed-model behavior không?
```

#### Cách đọc sâu chart VUs vs iter/s

```text
3 thứ cần nhìn cùng lúc:

1. Executor VUs (đường VUs):
   - Có flat ở configured value trong regular phase không?
   - Có tăng/giảm bất thường không?
   - Có về 0 ở cuối duration không?

2. Actual iter/s (đường iterations per second):
   - Dao động trong khoảng nào?
   - Có trend tăng/giảm không?
   - Có spike/drop đột ngột không?

3. Mối quan hệ giữa 2 đường:
   - VUs flat + iter/s giảm = CLOSED-MODEL SIGNAL
   - VUs không flat = CONFIG ISSUE
   - VUs flat + iter/s ổn định = STEADY STATE
```

#### Expected shape

```text
đầu run (0-10s):
  - VUs: tăng 0 → 20
  - iter/s: 0 hoặc thấp (loop đầu chưa xong)

regular phase (10s-290s):
  - VUs: PHẲNG ở 20 — ĐÂY LÀ INVARIANT QUAN TRỌNG NHẤT
  - iter/s: dao động quanh giá trị ổn định
    iter/s ≈ vus / avg_loop_duration ≈ 20 / 0.5-0.7 ≈ 28-40 iter/s

cuối run (290s-300s):
  - VUs: giảm 20 → 0 (gracefulStop)
  - iter/s: giảm về 0
```

#### THE MOST IMPORTANT SIGNAL: VUs flat + iter/s falling

```text
Đây là pattern QUAN TRỌNG NHẤT của constant-vus:

  VUs: ========================================= (phẳng ở 20)
  iter/s: \ \ \ \ \ \ \ \ \ \ \ \ \ \ \ \ \ \ \ (giảm dần)

  Nghĩa là:
    - 20 users vẫn active (không ai rời đi)
    - Nhưng mỗi user browse chậm dần (loop duration tăng)
    → BACKEND ĐANG CHẬM DẦN
    → Có thể: memory leak, connection pool cạn, cache degradation

  Hành động:
    1. Vào Response time chart, tách theo operation
    2. Tìm operation nào có p95 tăng dần theo thời gian
    3. Route vấn đề về team service tương ứng

  ĐÂY CHÍNH LÀ GIÁ TRỊ CỦA CONSTANT-VUS:
    Phát hiện degradation qua THROUGHPUT GIẢM
    trong khi VUs vẫn phẳng — không cần nhìn latency trước.
```

#### Bad shapes

| Shape | Nghĩa |
| --- | --- |
| VUs flat, iter/s slowly falling | Backend/flow duration tăng, closed-model backpressure |
| VUs not flat | Scenario/config/dashboard issue cần kiểm trước |
| iter/s spike/drop theo branch | Weighted branch hoặc dependency latency thay đổi |
| end-tail odd shape | duration/gracefulStop/end bucket effect |
| VUs flat, iter/s flat but near 0 | VU bị kẹt — có thể request treo, timeout dài |
| VUs < configured từ đầu | Config/env sai, hoặc maxVUs thấp hơn configured VUs |
| iter/s tăng dần | Backend đang warm up (cache fill) — bình thường nếu nhẹ |

#### Quan hệ giữa chart 2 và chart 3

```text
Chart 2 (Execution timeline):
  - Cho biết RPS/iter/s THEO THỜI GIAN (per bucket)
  - Dùng để xem pattern: có bucket nào RPS drop đột ngột không?

Chart 3 (VUs vs iter/s):
  - Cho biết MỐI QUAN HỆ giữa VUs và iter/s
  - Dùng để xem: VUs có flat không? iter/s có theo kịp VUs không?

Cả 2 chart cùng trả lời: "hệ thống có đang ở steady state không?"
Nhưng chart 3 là quan trọng nhất vì nó cho thấy CLOSED-MODEL SIGNAL.
```

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận failures/thresholds trước.
2. VUs vs iter/s xác nhận active-user pool có phẳng không.
3. Execution timeline cho thấy RPS/iter/s là output theo time.
4. Response time by operation tìm service/branch chậm.
5. Business decision dựa trên failures + latency + closed-model throughput change.
```

## Kết luận thực tế: output -> quyết định

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **storefront baseline gate**: output ra số như vậy thì team quyết định gì?

### Kịch bản A — output sạch: STOREFRONT STEADY

```text
checks................: 100.00%
http_req_failed.......: 0.00%
constant_active_iterations_failed: 0
iterations............: 11200      (output, không target)
http_reqs.............: 28500      (output, không target)

http_req_duration by operation (p95):
  storefront_browse_list:   48ms
  storefront_browse_detail: 35ms
  storefront_cart_add:      62ms
  storefront_checkout:      820ms

VUs: flat at 20
iter/s: ổn định quanh 37
```

Kết luận thực tế:

```text
- Failures = 0: không có vấn đề functional
- VUs flat 20: concurrency giữ đúng input
- Browse/Cart p95 < 100ms: nhanh, ổn
- Checkout p95 = 820ms: cao hơn nhưng trong ngưỡng chấp nhận
- iter/s ổn định 37: không có degradation trong 5m

=> QUYẾT ĐỊNH: Storefront ổn định với 20 concurrent shoppers.
   Đây là baseline để so sánh với các run sau.
   Lưu lại latency numbers làm reference.
```

### Kịch bản B — Checkout chậm nhưng Browse/Cart OK: INVESTIGATE ORDER-SERVICE

```text
checks................: 99.8%
http_req_failed.......: 0.3%
constant_active_iterations_failed: 8
iterations............: 10800

http_req_duration by operation (p95):
  storefront_browse_list:   52ms   ← OK
  storefront_browse_detail: 38ms   ← OK
  storefront_cart_add:      65ms   ← OK
  storefront_checkout:      4200ms ← RẤT CHẬM!

VUs: flat at 20
iter/s: ổn định quanh 36 (hơi thấp hơn baseline)
```

Kết luận thực tế:

```text
- Browse/Cart: ổn, p95 < 100ms
- Checkout: p95=4200ms — CÓ VẤN ĐỀ NGHIÊM TRỌNG
- 8 user loops failed (constant_active_iterations_failed=8)
  → Có thể 8 checkout bị timeout

- Đây là case ĐIỂN HÌNH của "small branch, big impact"
- Aggregate p95 có thể ~300ms (vẫn "đẹp" vì checkout chỉ 5%)
- Nhưng tách operation mới thấy checkout đang chết

=> QUYẾT ĐỊNH: BLOCK nếu checkout là critical path.
   Route vấn đề về order-service team.
   Kiểm tra external dependency (payment) của checkout.
   KHÔNG kết luận "storefront ổn" chỉ vì browse/cart nhanh.
```

### Kịch bản C — iter/s dropping (closed-model backpressure): INVESTIGATE DEGRADATION

```text
checks................: 99.9%
http_req_failed.......: 0.1%
constant_active_iterations_failed: 2
iterations............: 8500       ← THẤP HƠN baseline (11200)

VUs vs iter/s chart:
  VUs: phẳng ở 20 (KHÔNG ĐỔI)
  iter/s: 45 (đầu) → 38 (giữa) → 28 (cuối) ← GIẢM DẦN

http_req_duration by operation (p95):
  storefront_browse_list:   55ms (đầu) → 120ms (cuối) ← TĂNG
  storefront_browse_detail: 35ms (đầu) → 95ms (cuối)  ← TĂNG
  storefront_cart_add:      60ms (đầu) → 110ms (cuối) ← TĂNG
  storefront_checkout:      850ms (đầu) → 1500ms (cuối) ← TĂNG
```

Kết luận thực tế:

```text
- VUs flat: input đúng, không phải config issue
- iter/s GIẢM DẦN: closed-model backpressure signal
  → Loop duration tăng từ ~0.44s → ~0.71s
- TẤT CẢ operation p95 đều tăng → không phải 1 service
  → Có thể: infrastructure issue, memory leak, connection pool cạn

- ĐÂY CHÍNH LÀ GIÁ TRỊ CỦA CLOSED MODEL:
  Nếu dùng arrival-rate, k6 sẽ spawn thêm VU để giữ RPS
  → Che mất degradation này

=> QUYẾT ĐỊNH: BLOCK. Điều tra infrastructure.
   So sánh latency đầu run vs cuối run để đo mức degradation.
   Kiểm tra memory/CPU/connection pool của các service.
   Đây là tín hiệu CẢNH BÁO SỚM — nếu chạy lâu hơn (30m), 
   degradation có thể nghiêm trọng hơn.
```

### Kịch bản D — Operation mix sai lệch: VALIDATE SCRIPT

```text
iterations............: 10500

Phân tích operation distribution:
  storefront_browse_list:   10500 requests  ← mỗi loop có list
  storefront_browse_detail: 10500 requests  ← mỗi loop có detail
  storefront_cart_add:      800 requests    ← ĐÁNG LẼ ~2625 (25%)
  storefront_checkout:      50 requests     ← ĐÁNG LẼ ~525 (5%)

  → Cart chỉ có 800/10500 = 7.6% (expected 25%)
  → Checkout chỉ có 50/10500 = 0.5% (expected 5%)
```

Kết luận thực tế:

```text
- Cart và Checkout count QUÁ THẤP so với expected mix
- Có thể:
  1. Script weighted pick bị sai (sai hàm random, sai threshold)
  2. Cart/Checkout request bị fail → iteration không hoàn tất
  3. Checkout branch bị skip do điều kiện sai

- Nếu cart_add và checkout có fail:
  → http_req_failed sẽ > 0
  → constant_active_iterations_failed sẽ > 0

- Nếu không có fail nhưng count vẫn thấp:
  → Lỗi script — weightedPick hoặc random function

=> QUYẾT ĐỊNH: BLOCK. Sửa script.
   Kiểm tra logic weighted pick.
   Đảm bảo random function phân phối đúng 70/25/5.
   Chạy lại sau khi fix.
```

### Bảng ánh xạ nhanh output -> hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| Failures near zero, VUs flat, latency stable | Storefront steady-state acceptable | Use as baseline / continue |
| Checkout slower than browse/cart | Order/payment dependency bottleneck | Inspect checkout branch, order-service |
| VUs flat but iter/s drops | Closed-model backpressure visible | Investigate latency by operation |
| Tất cả operation p95 cùng tăng dần | Infrastructure degradation (memory, pool) | Check service metrics, consider longer soak |
| Operation mix far from expected over long run | weightedPick/tagging issue | Validate script and catalog mapping |
| Checkout count gần 0 | Checkout branch bị block hoàn toàn | Kiểm tra order-service health |
| VUs không flat | Config/env issue | Kiểm config, maxVUs, dashboard |
| iter/s tăng dần đầu run | Backend warm up (cache fill) | Bình thường, ghi nhận |
| iter/s = 0 trong nhiều bucket | VU bị kẹt | Kiểm tra request timeout, sleep logic |

## Real run — default constant-vus baseline after X-User-ID header

Run verify qua local cloud/dashboard sau khi k6 helper gửi `X-User-ID: ctx.userId`:

```text
Run ID: #81
Script: cv-01-business-hours-storefront.js
Exit code: 99
summary_pushed: true
finish_status: 200
Config: 20 VUs, duration 5m, default sleep/env
```

### Summary chính

| Metric | Value |
| --- | ---: |
| `checks_rate` | `0.98` |
| `checks_passes/checks_fails` | `24,564 / 391` |
| `http_req_failed_rate` | `0.02` |
| `iterations` | `14,686` |
| `iterations_rate` | `48.89/s` |
| `http_reqs` | `24,955` |
| `http_reqs_rate` | `83.07/s` |
| `vus_min/vus_max` | `20 / 20` |
| `constant_flow_duration_ms avg/med/p95/p99/max` | `8.48 / 5 / 8 / 109 / 182 ms` |
| `http_req_duration avg/med/p95/p99/max` | `4.89 / 2.75 / 4.20 / 103.69 / 182.38 ms` |

Request breakdown:

```text
storefront_browse_detail GET 200 count=10,269
storefront_browse_list GET 200 count=9,878
storefront_cart_add POST 200 count=3,923
storefront_checkout POST 200 count=494
storefront_browse_list GET 429 count=391
```

### Đọc 3 chart dashboard cho run #81

**Chart 1 — Response time.** Aggregate latency vẫn rất thấp (`http_req_duration` p95 ~4.20ms), nên nếu chỉ nhìn response-time chart sẽ bỏ lỡ vấn đề. Request breakdown mới là bằng chứng chính: `storefront_browse_list` còn 391 responses `429`.

**Chart 2 — Execution timeline.** Execution timeline sum `iterations=14,686`, `http_reqs=24,955`; failed-iteration buckets còn 44 buckets với tổng 391 failures. So với run trước khi gửi `X-User-ID` (3,869 failures), lỗi giảm nhiều nhưng vẫn lặp lại trong run.

Dashboard/API bucket summary:

```text
iterations buckets: count=301, sum=14686, min=12.00, max=55.00
http_reqs buckets:  count=301, sum=24955, min=37.00, max=94.00
failed iteration buckets: 44 buckets, sum=391
```

**Chart 3 — VUs vs iter/s.** VUs flat tuyệt đối ở 20 trong 300 buckets, nên test valid. Vì VUs không tụt, phần 429 còn lại là contract/rate-limit threshold giữa CV-01 và products-service.

```text
vus buckets: count=300, min=20.00, max=20.00, avg=20.00
```

### Backend verdict

```text
FAIL — X-User-ID header giảm mạnh 429 nhưng chưa hết; default CV-01 vẫn vượt products-list per-user rate limit.
```

Option A đã được áp dụng ở k6 helper (`X-User-ID=ctx.userId`). Kết quả chứng minh BE đã phân bucket theo user tốt hơn, nhưng CV-01 vẫn vượt default per-user limit 100/min vì mỗi VU browse list quá nhanh/gần ngưỡng. Cần chốt tiếp: tăng `PRODUCTS_LIST_RATE_LIMIT_PER_MINUTE` hoặc thêm `constant-vus-practice` profile/limit cao hơn, hoặc đổi CV-01 script/threshold để chấp nhận 429 nếu đây là bài học rate-limit.

## "Nghịch lý" và misconceptions của constant-vus

### Nghịch lý 1: "20 VU trong 5m chạy được bao nhiêu loops?" — KHÔNG BIẾT TRƯỚC!

```text
Đây là câu hỏi phổ biến nhất từ learner mới làm quen constant-vus.

Trong shared-iterations: "80 jobs, 8 VU" → biết TRƯỚC là 80 iterations.
Trong per-vu-iterations: "10 iter/VU, 8 VU" → biết TRƯỚC là 80 iterations.
Trong constant-vus: "20 VU, 5m" → KHÔNG BIẾT TRƯỚC bao nhiêu iterations!

Tại sao?
  iterations = vus × duration / loop_duration
  loop_duration = API_time + JS_time + sleep

  API_time KHÔNG cố định → phụ thuộc backend latency
  → iterations KHÔNG cố định

  Backend nhanh: loop=0.5s → 20 × 300 / 0.5 = 12000 iterations
  Backend chậm: loop=0.7s → 20 × 300 / 0.7 = 8571 iterations

  Cả 2 đều ĐÚNG — iterations là OUTPUT, không phải target.

Đừng hỏi: "20 VU trong 5m PHẢI chạy được bao nhiêu loops?"
Hãy hỏi: "Với 20 VU trong 5m, backend latency tạo ra throughput bao nhiêu?"
```

### Nghịch lý 2: "RPS giảm là bug hay feature?" — FEATURE! Đó là closed-model signal.

```text
Learner thường hoang mang khi thấy RPS giảm dù VUs vẫn flat:

  "Tôi config 20 VU, sao RPS không ổn định?"
  "Có phải k6 bị lỗi, không bơm đủ request?"

Trả lời: Đây là FEATURE của closed model, không phải bug.

  constant-vus = fixed active users
  Nếu backend chậm → user browse chậm hơn → RPS giảm
  → Đây là TÍN HIỆU QUAN TRỌNG: "backend đang có vấn đề"

  Nếu RPS không giảm khi backend chậm (như arrival-rate):
  → Bạn sẽ KHÔNG BIẾT có vấn đề (cho đến khi latency alert reo)

So sánh:
  - Đồng hồ tốc độ xe: kim giảm khi xe chậm → TÍN HIỆU ĐÚNG
  - constant-vus RPS: giảm khi backend chậm → TÍN HIỆU ĐÚNG
  - arrival-rate RPS: không đổi khi backend chậm → CHE TÍN HIỆU
```

### Nghịch lý 3: "Checkout 5% mà kéo p95 của cả test?" — Small branch, big impact.

```text
"Checkout chỉ 5% thôi mà! Sao aggregate p95 lại bị ảnh hưởng?"

Trả lời: Vì p95 là percentile, không phải average.

Tưởng tượng 100 requests:
  95 requests: latency ~50ms (browse + cart)
  5 requests:  latency ~2000ms (checkout)

  Sắp xếp latency từ thấp đến cao:
    1-95:  ~50ms
    96:    2000ms ← ĐÂY LÀ p96!
    97-100: 2000ms

  → p95 = 50ms (vẫn trong nhóm nhanh)
  → Nhưng p96 = 2000ms (đã bị checkout kéo)

  Nếu checkout chiếm 7% thay vì 5%:
    1-93:  ~50ms
    94-100: 2000ms
    → p95 = 2000ms! (bị checkout kéo)

  Checkout chỉ cần vượt qua ngưỡng (100 - checkout_percent)%
  là đã kéo p95.

  Với checkout=5%: p95 vẫn OK, nhưng p96-p100 bị kéo
  Với checkout=7%: p95 đã bị kéo
  Với checkout=10%: p90 đã bị kéo

  → Kết luận: LUÔN tách operation. Đừng nhìn aggregate p95 một mình.
```

## Checklist đọc biểu đồ case 01

Khi học sinh nhìn dashboard case 01, đọc theo thứ tự này:

```text
1. Overview KPI
   - checks = 100%?
   - http_req_failed = 0%?
   - constant_active_iterations_failed < 20?
   - iterations > 0? (sanity: có chạy không)

2. VUs vs iter/s chart (QUAN TRỌNG NHẤT)
   - VUs có flat ở 20 trong regular phase không?
   - iter/s có ổn định không?
   - Có pattern VUs flat + iter/s falling không? (closed-model signal)
   - Cuối run VUs có về 0 không?

3. Execution timeline
   - Live VUs có = 20 trong regular phase?
   - RPS/iter/s per bucket có ổn định không?
   - Có bucket nào RPS drop đột ngột không?
   - Có bucket nào failures tăng không?

4. Response time chart — LUÔN TÁCH THEO OPERATION
   - storefront_browse_list p95?
   - storefront_browse_detail p95?
   - storefront_cart_add p95?
   - storefront_checkout p95?
   - Checkout p95 có >> browse p95 không?
   - Có operation nào p95 tăng dần theo thời gian không?
   - Aggregate p95 có bị checkout kéo không?

5. Weighted mix verification
   - Operation counts có gần đúng 70/25/5 không?
   - Checkout count có quá thấp không?
   - Nếu checkout count << 5%: có fail không?

6. Business decision
   - Failures pass? → tiếp tục
   - VUs flat? → input đúng
   - Latency ổn định? → dùng làm baseline / điều tra operation chậm
   - iter/s ổn định? → không có degradation
   - Tất cả pass → Storefront baseline OK
```

Kết luận của run case 01 đang đúng nếu thấy:

```text
checks gần 100%
http_req_failed gần 0%
constant_active_iterations_failed < 20
VUs: flat ở 20 trong regular phase
iter/s: ổn định, không có trend giảm mạnh
checkout p95 > browse p95 (bình thường)
checkout count ~5% của iterations (xấp xỉ)
executor = constant-vus
```

## Mở rộng / variation

### Variation A: Thay đổi weighted mix để mô phỏng traffic pattern khác

```js
// Mix gốc: browse 70%, cart 25%, checkout 5%

// Variation A1: Tăng checkout (sale event, nhiều người mua)
// browse 50%, cart 30%, checkout 20%
const roll = Math.random();
if (roll < 0.50) {
  // browse flow
} else if (roll < 0.80) {
  // cart flow
} else {
  // checkout flow — nhiều hơn, dễ thấy bottleneck
}

// Variation A2: Chỉ browse (user research, xem catalog)
// browse 100% — bỏ cart và checkout
// Dùng để isolate products-service performance
```

### Variation B: Thêm latency threshold cho từng operation

```js
export const options = {
  thresholds: {
    // Browse phải nhanh
    "http_req_duration{operation:storefront_browse_list}":   ["p(95)<200"],
    "http_req_duration{operation:storefront_browse_detail}": ["p(95)<150"],

    // Cart chấp nhận chậm hơn một chút
    "http_req_duration{operation:storefront_cart_add}":      ["p(95)<300"],

    // Checkout có external dependency nên threshold cao hơn
    "http_req_duration{operation:storefront_checkout}":      ["p(95)<1500"],

    // Flow duration toàn loop
    "constant_flow_duration_ms": ["p(95)<2000"],
  },
};
```

Chuyển từ baseline observation sang performance gate.

### Variation C: Tăng duration để làm mini-soak test

```powershell
# Từ 5m baseline → 30m soak test
$env:CV_01_DURATION = "30m"
$env:CV_01_VUS = 20
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js
```

```text
Mục đích: phát hiện degradation dài hạn (memory leak, connection pool cạn)
          mà 5m không đủ thấy.

Cách đọc:
  - So sánh p95 đầu run (0-5m) vs cuối run (25-30m)
  - Nếu p95 cuối run >> p95 đầu run: có degradation
  - iter/s trend: giảm dần theo 30m → closed-model backpressure kéo dài
```

### Variation D: Tăng VUs để test capacity

```powershell
# Từ 20 shoppers → 50 shoppers
$env:CV_01_VUS = 50
$env:CV_01_DURATION = "5m"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js
```

```text
Mục đích: "50 concurrent shoppers thì hệ thống còn ổn không?"

Cách đọc:
  - VUs có flat ở 50 không? (nếu không → hệ thống không giữ được 50)
  - iter/s có tăng tuyến tính không? (50/20 = 2.5x expected)
  - Latency có tăng phi tuyến không? (50 users → latency tăng 5x thay vì 2.5x)
  - Nếu latency tăng phi tuyến: hệ thống đang bão hòa ở đâu đó giữa 20-50
```

### Variation E: Multi-scenario — storefront baseline + background task

```js
export const options = {
  scenarios: {
    // Storefront shoppers (constant active users)
    storefront: {
      executor: "constant-vus",
      vus: 20,
      duration: "5m",
      exec: "storefrontFlow",
      tags: { case_id: "cv-01-business-hours-storefront" },
    },
    // Background: cache warm hoặc report generation
    background_cache: {
      executor: "shared-iterations",
      vus: 2,
      iterations: 500,
      startTime: "30s",
      exec: "cacheWarmFlow",
      tags: { case_id: "bg-cache-warm" },
    },
  },
};

export function storefrontFlow() {
  // Flow browse/cart/checkout như bình thường
}

export function cacheWarmFlow() {
  // Gọi API warm cache
}
```

```text
Mục đích: xem storefront có bị ảnh hưởng bởi background task không.

Cách đọc:
  - So sánh latency storefront trước và sau khi background task start
  - Nếu latency tăng khi background chạy: resource contention
```

## Code pattern: weighted pick cho operation mix

### Pattern 1: Dùng Math.random() (đơn giản nhất)

```js
export default function () {
  const userId = __VU;  // stable user identity
  const params = {
    tags: {
      user_id: `user-${userId}`,
      case_id: "cv-01-business-hours-storefront",
    },
  };

  const roll = Math.random();

  if (roll < 0.70) {
    // 70%: browse flow
    browseFlow(params);
  } else if (roll < 0.95) {
    // 25%: cart flow
    cartFlow(params);
  } else {
    // 5%: checkout flow
    checkoutFlow(params);
  }
}

function browseFlow(params) {
  const listRes = http.get(`${BASE_URL}/api/sim/products?limit=10&sort=popular`, {
    ...params,
    tags: { ...params.tags, operation: "storefront_browse_list" },
  });
  check(listRes, { "browse list 200": (r) => r.status === 200 });

  sleep(0.2);

  const detailRes = http.get(`${BASE_URL}/api/sim/products/${randomProductId()}`, {
    ...params,
    tags: { ...params.tags, operation: "storefront_browse_detail" },
  });
  check(detailRes, { "browse detail 200": (r) => r.status === 200 });

  sleep(0.2);
}

function cartFlow(params) {
  browseFlow(params);  // reuse browse, rồi thêm cart

  const cartRes = http.post(`${BASE_URL}/api/sim/cart/add`, JSON.stringify({
    product_id: randomProductId(),
    quantity: 1,
  }), {
    ...params,
    tags: { ...params.tags, operation: "storefront_cart_add" },
  });
  check(cartRes, { "cart add 200": (r) => r.status === 200 });

  sleep(0.2);
}

function checkoutFlow(params) {
  cartFlow(params);  // reuse cart, rồi thêm checkout

  const checkoutRes = http.post(`${BASE_URL}/api/sim/checkout`, JSON.stringify({
    payment_method: "card",
  }), {
    ...params,
    tags: { ...params.tags, operation: "storefront_checkout" },
  });
  check(checkoutRes, { "checkout 200": (r) => r.status === 200 });

  sleep(0.2);
}
```

### Pattern 2: Dùng iterationInTest cho weighted round-robin (deterministic repeatable)

```js
export default function () {
  const iterationIndex = exec.scenario.iterationInTest;
  const bucket = iterationIndex % 100;  // 0..99, lặp mỗi 100 iter

  if (bucket < 70) {
    browseFlow(params);       // 70%
  } else if (bucket < 95) {
    cartFlow(params);         // 25%
  } else {
    checkoutFlow(params);     // 5%
  }
}
```

```text
Ưu điểm:
  - Deterministic: mỗi lần chạy, iteration #0 luôn là browse, #70 luôn là cart, #95 luôn là checkout
  - Dễ reproduce: cùng seed → cùng sequence
  - Dễ verify: biết chính xác iteration nào là branch nào

Nhược điểm:
  - Không random — có thể không giống traffic thật (nơi checkout xảy ra ngẫu nhiên)
  - Nếu checkout bị fail, các iteration #95-#99 luôn fail → pattern dễ đoán
```

### Pattern 3: Dùng seeded random (repeatable nhưng vẫn random)

```js
// Dùng seed để random reproducible
function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

export default function () {
  const vuId = exec.vu.idInTest;
  const iterIdx = exec.vu.iterationInInstance;  // __ITER
  const rand = seededRandom(vuId * 10000 + iterIdx);

  const roll = rand();
  if (roll < 0.70) {
    browseFlow(params);
  } else if (roll < 0.95) {
    cartFlow(params);
  } else {
    checkoutFlow(params);
  }
}
```

```text
Ưu điểm:
  - Random nhưng reproducible (cùng seed → cùng sequence)
  - Mỗi VU có sequence riêng
  - Phân phối gần đúng 70/25/5

Nhược điểm:
  - Phức tạp hơn Math.random()
  - Cần verify phân phối thực tế sau run
```

## Anti-pattern

- Dùng total `iterations` như pass/fail target cứng.
- Kỳ vọng fixed RPS từ `constant-vus`.
- So sánh 2 run có sleep/duration/VUs khác nhau rồi kết luận backend regress.
- Chỉ nhìn aggregate p95 trong flow nhiều operation.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với per-user quota của `per-vu-iterations`.
- Nhầm RPS giảm là bug thay vì closed-model signal.
- Không tách operation tag khi đọc Response time chart.
- Dùng `exec.scenario.iterationInTest` làm business identity (trong constant-vus, đó chỉ là loop counter).
- Giữ per-VU state kỳ vọng nó là business state xuyên suốt — VU là user identity ổn định, nhưng mỗi loop là 1 hành động độc lập, không nên tích lũy state sai.
- Kỳ vọng weighted mix ra exact count — weighted random luôn có độ lệch.
- Dùng `__VU` làm product/SKU ID — trong constant-vus, __VU là user, không phải product.
- Fail test vì "checkout p95 cao hơn browse" — checkout luôn chậm hơn vì có external dependency.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Constant-vus quick index: `../../20260516_01_constant-vus-quick-index.md`
- Tham số/công thức: `../../20260516_02_constant-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-01-business-hours-storefront.js`
- Shared-iterations contrast: `../shared-iterations/01_catalog-audit.md`
- Per-vu contrast: `../per-vu-iterations/00_overview.md`
