# Case 04: Checkout order intake

## Tình huống thực tế

Checkout/order traffic thường có rate thấp hơn browse/feed, nhưng mỗi arrival event quan trọng hơn:
liên quan thanh toán, tạo order, confirm order và external dependency. Một checkout
thất bại không chỉ mất revenue — nó còn mất niềm tin khách hàng ngay tại điểm quyết
định mua hàng.

### Câu hỏi business

```text
Order service có xử lý ổn 5 checkout arrivals/s trong 45s không?
Dù rate thấp, mỗi arrival có 2 API calls + external latency 40ms + 20ms.
Liệu VU pool 15 pre-allocated có đủ giữ intake khi external dependency chậm?
```

Đây là case dạy rằng **rate thấp không đồng nghĩa cần ít VU** nếu mỗi event
giữ VU lâu vì external latency. Đây là bài học quan trọng nhất của cả pack
constant-arrival-rate: **VU sizing = lambda x W_effective, không phải lambda đơn thuần**.

### Vì sao case này quan trọng với production?

```text
Tình huống thường gặp ở production:
  - Team nhìn rate checkout = 5/s, nghĩ "thấp, pool 5 VU là đủ"
  - Setup constant-arrival-rate với preAllocatedVUs=5, maxVUs=10
  - Deploy lên production
  - External payment gateway bắt đầu chậm (p95 tăng từ 40ms lên 120ms)
  - W_effective tăng từ 65ms lên ~145ms
  - required_vus_min tăng từ ~1 lên ~1 (vẫn tưởng an toàn)
  - NHƯNG với tail latency, vài event kéo dài 200-300ms
  - VU pool 5 không đủ giữ → dropped_iterations xuất hiện
  - Khách hàng thấy "checkout failed" → mất đơn

Bài học: rate thấp không cho phép bạn dùng pool nhỏ nếu mỗi event có external latency.
```

## 2 yêu cầu cốt lõi

Case này có 2 yêu cầu cốt lõi, phải thỏa mãn đồng thời:

### Yêu cầu (a): SUSTAINED INTAKE RATE (giữ đúng 5 checkout/s)

**Ý nghĩa**: Order service phải tiếp nhận checkout arrivals với rate 5/s liên tục
trong 45 giây, không bị gián đoạn. Đây là contract về **throughput đầu vào**.

**Ví dụ cụ thể**:

```text
Scenario: Black Friday campaign funnel đổ 5 checkout/s vào order service

Trường hợp A (giữ được intake):
  45s chạy: 225 arrivals scheduled, 225 iterations completed
  dropped_iterations = 0
  → Order service xử lý kịp mọi checkout arrival
  → Không mất đơn hàng nào

Trường hợp B (mất intake):
  45s chạy: 225 arrivals scheduled, 198 iterations completed
  dropped_iterations = 27
  → 27 checkout arrivals bị drop — tương đương 27 khách hàng thấy lỗi
  → Mất 27 × giá trị đơn hàng trung bình revenue
```

**Vì sao rate=5/s thấp nhưng vẫn khó giữ?**

```text
rate = 5/s → mỗi 200ms có 1 arrival được scheduled

Nhưng mỗi arrival event cần:
  Step 1: POST checkout create (external_ms=40 → ~43ms tổng)
  Step 2: POST order confirm  (external_ms=20 → ~23ms tổng)
  → W_effective khoảng 65-70ms minimum

Với W_effective = 70ms, 1 VU xử lý được 1/0.07 ≈ 14.3 events/s
→ Về lý thuyết chỉ cần ceil(5 / 14.3) = 1 VU

NHƯNG thực tế:
  - External latency không cố định — có tail (p95 cao hơn avg nhiều)
  - CPU scheduling, network jitter, GC pause
  - K6 scheduler không perfect — cần buffer VU
  - preAllocatedVUs=15 là buffer cho tail latency
```

### Yêu cầu (b): ZERO DROPS DESPITE EXTERNAL LATENCY

**Ý nghĩa**: Dù external dependency (payment gateway simulation) có latency,
không một checkout arrival nào được phép bị drop. Đây là contract về **độ tin cậy**.

```text
Checkout là điểm quyết định mua hàng:
  - Browse bị drop → user refresh lại, ít thiệt hại
  - Checkout bị drop → user mất niềm tin, có thể bỏ đi hẳn
  - Mỗi drop = 1 khách hàng thấy lỗi ở bước cuối cùng

→ maxDroppedIterations = 0 (contract cứng)
```

**So sánh mức độ nghiêm trọng của drop giữa các case**:

| Case | Rate | Nghiệp vụ | maxDroppedIterations | Lý do |
| --- | ---: | --- | ---: | --- |
| case 01 (storefront) | 20/s | Browse sản phẩm | 10 | browse có thể retry |
| case 02 (search) | 30/s | Search sản phẩm | 15 | search có thể retry |
| case 03 (cart) | 10/s | Cart operations | 5 | cart quan trọng hơn |
| **case 04 (checkout)** | **5/s** | **Checkout + order** | **0** | **checkout không được phép drop** |
| case 05 (payment) | 3/s | Payment processing | 0 | payment cũng zero-drop |

→ Checkout có rate thấp nhất nhưng contract drop nghiêm ngặt nhất (cùng với payment).

## Vì sao chọn `constant-arrival-rate`?

### Bài toán: mô phỏng checkout arrivals thực tế

Checkout arrivals đến từ người dùng thật hoặc campaign funnel. Khác với browse
(có thể refresh), checkout arrivals có 3 đặc điểm:

```text
1. ARRIVAL RATE CỐ ĐỊNH THEO THỜI GIAN THỰC
   - Khách hàng không "chờ" server sẵn sàng mới checkout
   - Họ đến theo nhịp riêng (campaign, quảng cáo, organic)
   - Server phải THEO KỊP nhịp đó, không phải ngược lại

2. MỖI ARRIVAL CÓ NHIỀU BƯỚC + EXTERNAL DEPENDENCY
   - Checkout create (gọi external payment gateway)
   - Order confirm (gọi external inventory service)
   - Mỗi bước có latency riêng, có thể fail độc lập

3. VU POOL PHẢI ĐỦ GIỮ NHỊP DÙ EXTERNAL CHẬM
   - Nếu payment gateway chậm, VU bị giữ lâu hơn
   - Cần thêm VU để bù — đây là bài toán sizing
   - Thiếu pool → dropped_iterations
```

### Bảng so sánh executor cho case checkout

| Executor | Giữ được rate intake? | Phản ứng khi external chậm? | Verdict |
| --- | --- | --- | --- |
| **constant-arrival-rate** | ✓ rate=5/s cố định, scheduler giữ nhịp | VU demand tăng, nếu pool đủ → không drop | ✅ DÙNG |
| constant-vus (duration) | ✗ throughput = VUs / iter_time, giảm khi external chậm | Throughput tự động giảm, không phát hiện được vấn đề | ❌ |
| per-vu-iterations | ✗ không có khái niệm rate theo thời gian | Không mô phỏng được arrival pattern | ❌ |
| shared-iterations | ✗ count cố định nhưng không có timeline | Không phân biệt được "đủ count" với "đủ rate" | ❌ |
| ramping-vus | ✗ rate biến thiên theo ramp | Không giữ được rate intake cố định | ❌ |
| ramping-arrival-rate | ✓ giữ được rate (với ramp) | Phức tạp hơn cần thiết cho rate cố định | ⚠️ overkill |

### Vì sao KHÔNG dùng constant-vus cho checkout intake test?

Đây là điểm quan trọng nhất để phân biệt open model và closed model:

```text
constant-vus với vus=15, duration=45s:
  Công thức throughput: rate = VUs / iter_time = 15 / 0.07 ≈ 214 iter/s
  → Về lý thuyết, 15 VU với iter_time=70ms cho throughput ~214/s
  → Rate này CAO HƠN RẤT NHIỀU so với 5/s target
  → Test sẽ "pass" dễ dàng, không phát hiện vấn đề gì

NHƯNG trong production thực tế:
  - External payment gateway không chạy 70ms mãi — có lúc 200ms, 500ms
  - Khi external chậm, iter_time tăng, throughput của constant-vus GIẢM
  - Từ 15/0.07=214/s xuống 15/0.5=30/s → VẪN trên 5/s
  - Test constant-vus không bao giờ thấy vấn đề!

Trong khi constant-arrival-rate:
  - Rate intake LUÔN là 5/s (scheduler ép)
  - Khi external chậm, W_effective tăng → cần thêm VU
  - Nếu VU pool không đủ → dropped_iterations → TEST FAIL
  - → Test thật sự kiểm tra được năng lực của hệ thống
```

**Kết luận**: Chỉ constant-arrival-rate mới mô phỏng đúng bản chất của checkout
intake: arrivals đến theo nhịp thời gian thực, server phải theo kịp, và external
latency là biến số ảnh hưởng đến VU demand.

## Mapping business -> k6 config

### Source script

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-04-checkout-order-intake.js
```

### Default config và ý nghĩa từng tham số

| Field | Value | Ý nghĩa | Vì sao giá trị này? |
| --- | ---: | --- | --- |
| `executor` | `constant-arrival-rate` | Open model, scheduler-driven | Bắt buộc để giữ rate intake cố định |
| `rate` | `5` | 5 checkout arrivals mỗi timeUnit | Business requirement: 5 checkout/s |
| `timeUnit` | `1s` | Target = 5 arrivals/s | Time unit chuẩn cho rate |
| `duration` | `45s` | Giữ intake trong 45 giây | Đủ dài để quan sát external latency pattern |
| `preAllocatedVUs` | `15` | Worker khởi tạo sẵn | Buffer cho external latency (40ms+20ms) |
| `maxVUs` | `40` | Trần worker được mở thêm | Headroom nếu external latency spike |
| `maxDroppedIterations` | `0` | Không chấp nhận drop | Checkout là business-critical |

### Expected scheduled slots

```text
lambda = rate / timeUnit_seconds = 5 / 1 = 5 arrivals/s
scheduled_slots = lambda × duration_seconds = 5 × 45 = 225 arrivals
```

### Env override

```powershell
$env:CAR_04_RATE = "5"
$env:CAR_04_TIME_UNIT = "1s"
$env:CAR_04_DURATION = "45s"
$env:CAR_04_PREALLOCATED_VUS = "15"
$env:CAR_04_MAX_VUS = "40"
$env:CAR_04_USER_POOL = "500"
$env:CAR_04_MAX_DROPPED = "0"
```

### Vì sao preAllocatedVUs=15 dù rate chỉ 5/s?

Đây là câu hỏi trung tâm của case này. Phân tích sâu:

```text
Bước 1: Tính W_effective (thời gian 1 event giữ VU)
  Checkout create: cpu_ms=3 + db_writes=2 + external_ms=40 ≈ 45ms
  Order confirm:   cpu_ms=1 + db_writes=1 + external_ms=20 ≈ 22ms
  Overhead (HTTP, JSON parse, k6 internal): ~3-5ms
  → W_effective ≈ 70ms (happy path)

Bước 2: Tính required_vus_min theo Little's Law
  required_vus_min = ceil(lambda × W_effective)
                   = ceil(5 × 0.070)
                   = ceil(0.35)
                   = 1 VU

Bước 3: Vậy sao cần 15 VU?
  1 VU chỉ đủ trong điều kiện LÝ TƯỞNG:
    - External latency cố định ở đúng 40ms và 20ms
    - Không có tail latency
    - Không có network jitter
    - k6 scheduler hoàn hảo, không delay

  Thực tế:
    - External latency có p95 cao hơn avg (vd avg=40ms, p95=120ms)
    - Khi event gặp tail, nó giữ VU lâu hơn → cần VU khác bù
    - preAllocatedVUs=15 là buffer cho tail latency
    - Với 15 VU: capacity = 15 / 0.070 ≈ 214 events/s → dư nhiều
    - Nhưng dư này là CỐ Ý — để hấp thụ external latency spikes

Bước 4: maxVUs=40 cho extreme cases
  Nếu external dependency có đợt chậm (p95=300ms):
    W_effective trung bình ≈ 150ms
    required_vus_min ≈ ceil(5 × 0.150) = 1 (vẫn 1!)
    NHƯNG với tail 300ms, vài event cần 300ms để xong
    → Cần nhiều VU hơn để không drop slot trong lúc chờ
    → maxVUs=40 cho headroom
```

**Công thức tổng quát**:

```text
required_vus_min = ceil(lambda × W_effective_p95)

Với checkout case:
  lambda = 5
  W_effective_p95 ≈ 120ms (ước tính từ external_ms=40 + overhead)
  required_vus_min ≈ ceil(5 × 0.120) = 1

→ Chỉ cần 1 VU về mặt lý thuyết
→ NHƯNG preAllocatedVUs=15 để:
    1. Có sẵn worker, không cần spawn khi test bắt đầu
    2. Hấp thụ tail latency mà không drop
    3. Cho phép external latency tăng gấp đôi vẫn an toàn
```

**Bài học**: VU sizing cho open model không dựa trên rate đơn thuần. Nó dựa trên
`lambda × W_effective`. Khi W_effective nhỏ, cần ít VU. Nhưng phải dùng
preAllocatedVUs đủ lớn để hấp thụ tail latency.

## Phân tích nguyên nhân gốc kỹ thuật (5 RC)

### RC1: Low rate không đồng nghĩa low VU demand — external latency dominates sizing

**Phát biểu**: `rate=5/s` thấp nhất trong pack constant-arrival-rate, nhưng
`preAllocatedVUs=15` lại **cao hơn** case 01 (rate=20/s, preAllocatedVUs=12).
Nghịch lý này đến từ đâu?

**So sánh trực tiếp**:

| Case | Rate | preAllocatedVUs | W_effective | required_vus_min (lt) | Tỉ lệ pre/rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| case 01 (storefront) | 20/s | 12 | ~4ms | 1 | 0.6 |
| case 02 (search) | 30/s | 18 | ~5ms | 1 | 0.6 |
| **case 04 (checkout)** | **5/s** | **15** | **~70ms** | **1** | **3.0** |

→ Tỉ lệ `preAllocatedVUs / rate` của case 04 là 3.0, gấp 5 lần case 01 (0.6).
Nguyên nhân: **W_effective của checkout gấp ~17 lần storefront**.

**Trace minh họa**:

```text
Case 01 (storefront, 1 GET request, ~4ms):
  t=0ms:    arrival slot #0 → VU #1 nhận, gửi GET /api/sim/products
  t=4ms:    response 200, VU #1 freed
  t=50ms:   arrival slot #1 → VU #1 (đã freed) nhận tiếp
  → 1 VU xử lý được 1/0.004 = 250 events/s

Case 04 (checkout, 2 POST requests, ~70ms tổng):
  t=0ms:    arrival slot #0 → VU #1 nhận, gửi POST checkout (external_ms=40)
  t=45ms:   checkout response 200, gửi POST confirm (external_ms=20)
  t=70ms:   confirm response 200, VU #1 freed
  t=200ms:  arrival slot #1 → VU #1 (vừa freed) nhận tiếp
  → 1 VU xử lý được 1/0.070 ≈ 14.3 events/s

Với 15 VU:
  Case 01: 15 × 250 = 3750 events/s capacity (rate=20/s → dư 187x)
  Case 04: 15 × 14.3 = 214 events/s capacity (rate=5/s → dư 42x)

→ Case 04 dư ít hơn rất nhiều về mặt tỉ lệ
→ Với external latency spike, buffer này dễ bị ăn mòn
```

**Công thức tổng quát cho sizing**:

```text
capacity = preAllocatedVUs / W_effective
headroom = capacity / lambda - 1

Case 04: headroom = (15 / 0.070) / 5 - 1 = 42.9 - 1 = 41.9x
  → Khi external latency tăng gấp 10 (W_effective=700ms):
    capacity = 15 / 0.700 = 21.4 events/s
    headroom = 21.4 / 5 - 1 = 3.3x → vẫn đủ

  Khi external latency tăng gấp 40 (W_effective=2800ms):
    capacity = 15 / 2.800 = 5.36 events/s
    headroom = 5.36 / 5 - 1 = 0.07x → gần chạm trần, có thể drop
```

### RC2: Multi-step event — checkout → confirm sequential, amplification factor

**Phát biểu**: Mỗi arrival event không phải 1 API call mà là 2 API calls tuần tự
(checkout create + order confirm). Điều này tạo ra **amplification factor = 2**
cho http_reqs, và **sequential dependency** — nếu step 1 fail, step 2 không chạy.

**Flow tuần tự trong code**:

```js
export function checkoutOrderIntake(data) {
  const started = Date.now();
  const ctx = userContext(data.seed, USER_POOL);
  const productId = ((ctx.iter * 11) % 50) + 1;
  const orderId = `CAR-ORDER-${ctx.requestKey}`;
  let ok = true;

  // ───── Step 1: Checkout Create ─────
  const checkout = requestJson('POST',
    `${BASE_URL}/api/sim/checkout?cpu_ms=3&db_writes=2&external_ms=40&external_fail_rate=0`,
    { payment_method: 'card', items: [{ id: productId, qty: 1 }] },
    { caseId: CASE_ID, service: 'order-service', operation: 'checkout_arrival_create',
      endpoint: 'POST /api/sim/checkout', userId: ctx.userId,
      headers: { 'Idempotency-Key': `car04-checkout-${ctx.requestKey}` } }
  );
  ok = ok && checkout.ok;

  // ───── Step 2: Order Confirm ─────
  const confirm = requestJson('POST',
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=1&db_writes=1&external_ms=20&external_fail_rate=0`,
    {},
    { caseId: CASE_ID, service: 'order-service', operation: 'checkout_arrival_confirm',
      endpoint: 'POST /api/sim/orders/:id/confirm', userId: ctx.userId,
      headers: { 'Idempotency-Key': `car04-confirm-${ctx.requestKey}` } }
  );
  ok = ok && confirm.ok;

  finishEvent(started, ok, { caseId: CASE_ID, service: 'order-service',
    operation: 'checkout_order_arrival', userId: ctx.userId });
}
```

**Trace execution cho 1 arrival event**:

```text
[Event #42, VU #7]
  t=8400ms:  scheduler gán slot #42 → VU #7 bắt đầu checkoutOrderIntake()
  t=8401ms:  userContext() → userId=arrival-user-243, requestKey=seed-42-7
  t=8402ms:  Step 1: POST /api/sim/checkout (external_ms=40)
             → body: {payment_method:'card', items:[{id:12,qty:1}]}
             → header: Idempotency-Key=car04-checkout-seed-42-7
  t=8447ms:  Step 1 response: 200 OK (~45ms)
             → ok = true
  t=8448ms:  Step 2: POST /api/sim/orders/CAR-ORDER-seed-42-7/confirm (external_ms=20)
             → header: Idempotency-Key=car04-confirm-seed-42-7
  t=8471ms:  Step 2 response: 200 OK (~23ms)
             → ok = true
  t=8472ms:  finishEvent() → constant_arrival_events_total += 1
             constant_arrival_event_duration_ms = 72ms
  t=8473ms:  VU #7 freed, sẵn sàng nhận slot mới
```

**Amplification factor**:

```text
1 iteration = 1 arrival event = 1 lần chạy checkoutOrderIntake()
1 iteration → 2 API calls (nếu cả 2 step đều chạy)
→ http_reqs = iterations × 2 (happy path)
→ constant_arrival_api_calls_total = iterations × 2 (happy path)

Với 225 slots:
  Expected http_reqs = 225 × 2 = 450
  Expected constant_arrival_api_calls_total = 450
```

**Khi step 1 fail**:

```text
Nếu checkout create fail (status != 200):
  ok = false sau step 1
  Step 2 vẫn chạy trong code này (vì không có early return) — nhưng orderId có
  thể không hợp lệ
  → http_reqs vẫn = iterations × 2
  → Nhưng constant_arrival_events_failed tăng

Nếu code có early return sau step 1 fail:
  Step 2 không chạy
  → http_reqs < iterations × 2
  → Đây là dấu hiệu cascade failure
```

### RC3: Idempotency key pattern — safe retry without duplicate orders

**Phát biểu**: Mỗi API call trong checkout flow đều gửi kèm header `Idempotency-Key`.
Pattern này đảm bảo nếu cùng request được gửi lại (do network retry, load balancer
retry), server không tạo duplicate order.

**Vì sao cần idempotency key trong checkout?**

```text
Checkout là operation CÓ HIỆU ỨNG (tạo order, trừ tiền).
Nếu không có idempotency key:

  Client gửi POST /api/sim/checkout → server nhận, xử lý, tạo order #123
  Response 200 bị mất trên đường về (network drop)
  Client retry POST /api/sim/checkout → server tạo order #124 (DUPLICATE!)
  → Khách hàng bị trừ tiền 2 lần, có 2 order giống nhau

Với idempotency key:

  Client gửi POST /api/sim/checkout
    Header: Idempotency-Key: car04-checkout-seed-42-7
  Server nhận, tạo order, lưu key: car04-checkout-seed-42-7 → order #123

  Response 200 bị mất → client retry với CÙNG key
  Server thấy key đã tồn tại → trả về kết quả của order #123
  → Không tạo duplicate
```

**Cấu trúc key trong case này**:

```text
Checkout create: Idempotency-Key: car04-checkout-{requestKey}
                 = car04-checkout-seed-42-7

Order confirm:   Idempotency-Key: car04-confirm-{requestKey}
                 = car04-confirm-seed-42-7

requestKey = {seed}-{iter}-{vuId}
           = seed-42-7
```

**Tại sao dùng 2 key khác nhau cho 2 step?**

```text
Nếu dùng chung 1 key cho cả checkout create và confirm:
  - Server thấy cùng key ở step 2 → tưởng là retry của step 1
  - Có thể từ chối confirm vì "đã xử lý"

Nên mỗi operation có prefix riêng:
  car04-checkout-{requestKey}  → cho checkout create
  car04-confirm-{requestKey}   → cho order confirm
```

**Idempotency key KHÔNG làm giảm latency**:

```text
Idempotency key chỉ bảo vệ data integrity, không cải thiện performance.
Server vẫn phải check key (DB lookup hoặc cache lookup) → có thể thêm 1-2ms.

Nhưng cost này nhỏ so với rủi ro duplicate order.
→ Đây là trade-off bắt buộc trong hệ thống thanh toán.
```

### RC4: dropped_iterations khi external latency spike tiêu thụ VU pool

**Phát biểu**: Khi external latency tăng (spike), mỗi event giữ VU lâu hơn.
Nếu VU pool không đủ để bù, các slot mới đến sẽ không có VU free → dropped_iterations.

**Cơ chế drop trong constant-arrival-rate**:

```text
Scheduler hoạt động theo timeline:
  t=0ms:    slot #0 scheduled → tìm VU free → VU #1 → OK
  t=200ms:  slot #1 scheduled → tìm VU free → VU #2 → OK
  t=400ms:  slot #2 scheduled → tìm VU free → VU #3 → OK
  ...
  t=Xms:    slot #N scheduled → tìm VU free → KHÔNG CÓ VU FREE
            → dropped_iterations += 1

Điều kiện drop: tất cả VU trong pool đều đang busy
```

**Mô phỏng external latency spike**:

```text
Bình thường (external_ms=40, W_effective≈70ms):
  VU #1 nhận slot #0 lúc t=0ms → xong lúc t=70ms
  VU #2 nhận slot #1 lúc t=200ms → xong lúc t=270ms
  VU #3 nhận slot #2 lúc t=400ms → xong lúc t=470ms
  ... 15 VU đủ xoay vòng cho 5 slots/s

Khi spike (external_ms=200, W_effective≈230ms):
  VU #1 nhận slot #0 lúc t=0ms → xong lúc t=230ms
  VU #2 nhận slot #1 lúc t=200ms → xong lúc t=430ms
  ...
  Tại t=3000ms: nhiều VU bị kẹt với external_ms=200
  → Tại t=3200ms: slot mới scheduled, tất cả 15 VU đều busy
  → Nếu maxVUs đã đạt trần → dropped_iterations += 1

Khi spike (external_ms=200, W_effective≈230ms) với maxVUs=40:
  k6 tự động spawn thêm VU (lên đến 40)
  → Tại t=3200ms: 15 preAllocated đều busy, nhưng k6 spawn VU #16
  → Không drop
```

**Bài toán sizing với tail latency**:

```text
Giả sử external_ms phân phối: avg=40ms, p95=120ms, p99=200ms

W_effective tương ứng:
  avg: 70ms   → capacity = 15/0.070 = 214/s → dư 42x
  p95: 150ms  → capacity = 15/0.150 = 100/s → dư 20x
  p99: 230ms  → capacity = 15/0.230 = 65/s  → dư 13x

Với 5% request ở p95 (150ms) và 1% ở p99 (230ms):
  Trung bình mỗi giây: 5 × 0.05 = 0.25 events ở p95, 5 × 0.01 = 0.05 events ở p99
  → 15 VU vẫn dư sức

Nhưng nếu external dependency có đợt "chậm toàn bộ" (vd maintenance):
  100% request ở mức 200ms
  capacity = 15/0.230 = 65/s → dư 13x → vẫn đủ

  Nếu kéo dài 500ms:
  capacity = 15/0.530 = 28/s → dư 5.6x → bắt đầu risky

  Nếu kéo dài 1000ms:
  capacity = 15/1.030 = 14.6/s → dư 2.9x → bắt đầu thấy drop nếu spike lâu
  → Lúc này maxVUs=40 mới phát huy tác dụng
```

### RC5: Event failure cascading — nếu create fails, confirm có thể bị skip

**Phát biểu**: Khi step 1 (checkout create) fail, step 2 (order confirm) có thể
không chạy, dẫn đến `http_reqs < iterations × 2`. Đây là tín hiệu quan trọng
để phát hiện vấn đề ở tầng checkout create.

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

**Phân tích 2 trường hợp**:

```text
Trường hợp A: Checkout OK, Confirm OK (happy path)
  iterations = 225
  http_reqs = 450
  constant_arrival_api_calls_total = 450
  constant_arrival_events_failed = 0
  → Tỉ lệ http_reqs/iterations = 2.0

Trường hợp B: Checkout fail 10%, Confirm vẫn chạy
  iterations = 225
  http_reqs = 450 (vẫn 450 vì confirm vẫn chạy)
  constant_arrival_api_calls_total = 450
  constant_arrival_events_failed = 22 (10% của 225)
  → Tỉ lệ http_reqs/iterations = 2.0 nhưng events_failed > 0

Trường hợp C: Checkout fail 10%, có early return (code sửa)
  iterations = 225
  http_reqs = 225 + 202 = 427 (202 confirm từ 90% success)
  constant_arrival_api_calls_total = 427
  → Tỉ lệ http_reqs/iterations = 1.9 → DẤU HIỆU cascade
```

**Cách phát hiện cascade failure từ metrics**:

```text
Nếu http_reqs < iterations × 1.8:
  → Ít nhất 20% event bị skip step 2
  → Check constant_arrival_events_failed để xác nhận
  → Điều tra checkout create failures

Nếu http_reqs ≈ iterations × 2 nhưng constant_arrival_events_failed > 0:
  → Code không có early return, confirm vẫn chạy dù checkout fail
  → Event được đánh dấu failed nhưng API calls vẫn đủ
  → Cần phân biệt: event failed ≠ API call failed
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
  - Slot #42 có thể được xử lý bởi VU #7 hoặc VU #12
  - User identity gắn với ARRIVAL SLOT, không gắn với VU

→ userId = `arrival-user-{slot_index}` 
  với slot_index = (iterationInTest % USER_POOL) + 1

So sánh với closed model (case 01 per-vu-iterations):
  userId = `qa-user-{vuId}`
  → User identity gắn cố định với VU

Đây là khác biệt cơ bản giữa open model và closed model về identity.
```

### requestKey và tính duy nhất

```text
requestKey = `${seed}-${exec.scenario.iterationInTest}-${exec.vu.idInTest}`
           = "1718901234-42-7"

Tính duy nhất được đảm bảo bởi:
  - seed: unique per test run (Date.now())
  - iterationInTest: global counter, không lặp trong 1 run
  - vuIdInTest: unique per VU

→ requestKey là unique trong toàn bộ test run
→ Dùng làm cơ sở cho Idempotency-Key
```

### Idempotency key derivation

```text
car04-checkout-{requestKey}  → Idempotency-Key cho checkout create
car04-confirm-{requestKey}   → Idempotency-Key cho order confirm

Tại sao không dùng chung 1 key?
  - Mỗi operation cần idempotency độc lập
  - Nếu checkout create thành công, confirm thất bại → retry confirm với key riêng
  - Server phân biệt được "retry của checkout" vs "lần đầu của confirm"
```

### userPool mechanism

```text
USER_POOL = 500 (số lượng user identity trong pool)
userId = `arrival-user-${(iterationInTest % USER_POOL) + 1}`

Tại sao 500?
  - 225 slots trong 45s → cần tối đa 225 unique user
  - 500 > 225 → mỗi slot có user riêng, không reuse trong 1 run
  - Giả lập traffic từ 225-500 khách hàng khác nhau

Nếu USER_POOL < 225:
  - Một số user sẽ xuất hiện nhiều lần
  - Có thể gây race condition trên cùng user (cart, order)
  - → Không đúng với mô hình "mỗi checkout là khách hàng mới"
```

## Phân tích open model — external latency impact comparison

### So sánh constant-vus vs constant-arrival-rate khi external latency thay đổi

Đây là phần quan trọng nhất để hiểu vì sao open model là công cụ đúng cho
checkout intake test.

**Scenario**: External payment gateway có latency tăng dần từ 40ms lên 400ms.

**Bảng so sánh**:

| External latency | W_effective | constant-vus (vus=15) throughput | constant-arrival-rate (rate=5) behavior |
| ---: | ---: | ---: | --- |
| 40ms (normal) | 70ms | 15/0.07 = 214/s | 5/s intake, VU usage ≈ 1, 14 idle |
| 100ms | 130ms | 15/0.13 = 115/s | 5/s intake, VU usage ≈ 1, 14 idle |
| 200ms | 230ms | 15/0.23 = 65/s | 5/s intake, VU usage ≈ 2, 13 idle |
| 400ms | 430ms | 15/0.43 = 35/s | 5/s intake, VU usage ≈ 3, 12 idle |
| 1000ms | 1030ms | 15/1.03 = 14.6/s | 5/s intake, VU usage ≈ 6, 9 idle |
| 3000ms | 3030ms | 15/3.03 = 5.0/s | 5/s intake, VU usage ≈ 16, spawn thêm |

**Phân tích**:

```text
constant-vus (closed model):
  Khi external chậm, throughput GIẢM:
    214/s → 115/s → 65/s → 35/s → 14.6/s → 5.0/s
  Test luôn "pass" vì không có khái niệm drop
  KHÔNG PHÁT HIỆN ĐƯỢC vấn đề: throughput 5/s vẫn OK dù latency 3000ms
  → KHÔNG trả lời được câu hỏi "order service có xử lý ổn 5/s không?"

constant-arrival-rate (open model):
  Khi external chậm, VU demand TĂNG:
    1 VU → 2 VU → 3 VU → 6 VU → 16 VU
  Rate intake vẫn giữ 5/s (scheduler ép)
  Nếu VU pool không đủ → dropped_iterations → TEST FAIL
  → PHÁT HIỆN ĐƯỢC vấn đề khi VU pool cạn
  → Trả lời được câu hỏi business
```

**Minh họa bằng số**:

```text
Tình huống: external_ms tăng lên 2000ms, W_effective ≈ 2030ms

constant-vus với vus=15:
  throughput = 15 / 2.030 = 7.4/s
  → Vẫn > 5/s → "không có vấn đề"
  → Nhưng p95 event duration = 2030ms → người dùng chờ 2 giây!
  → Test constant-vus KHÔNG CẢNH BÁO gì về UX

constant-arrival-rate với rate=5, preAllocatedVUs=15:
  required_vus = ceil(5 × 2.030) = 11 VU (vẫn trong 15)
  → 5/s intake vẫn được giữ
  → Nhưng p95 event duration = 2030ms → thấy được trên dashboard
  → Nếu threshold p95 = 500ms → TEST FAIL vì p95
  → Phát hiện được vấn đề UX dù intake vẫn đạt
```

### Tại sao open model PHẢI có VU pool dư?

```text
Trong closed model, VU pool size = concurrency target.
Trong open model, VU pool size = capacity để hấp thụ latency.

Nếu VU pool vừa khít (preAllocatedVUs = required_vus_min):
  - Khi latency bình thường: OK
  - Khi latency tăng 10%: bắt đầu drop
  - Không có buffer cho biến động

→ preAllocatedVUs phải > required_vus_min
→ Tỉ lệ an toàn thường là 3-10x tùy criticality
→ Checkout case: 15 / 1 = 15x → an toàn cao
```

## Bảng service/API flow

### 2-step flow với request/response expectations

| Step | Method | Endpoint | Query Params | Request Body | Expected Status | Tags (operation) | Idempotency-Key |
| --- | --- | --- | --- | --- | ---: | --- | --- |
| 1 | POST | `/api/sim/checkout` | `cpu_ms=3&db_writes=2&external_ms=40&external_fail_rate=0` | `{payment_method, items: [{id, qty}]}` | 200 | `checkout_arrival_create` | `car04-checkout-{requestKey}` |
| 2 | POST | `/api/sim/orders/:id/confirm` | `cpu_ms=1&db_writes=1&external_ms=20&external_fail_rate=0` | `{}` | 200 | `checkout_arrival_confirm` | `car04-confirm-{requestKey}` |

### Chi tiết từng step

**Step 1 — Checkout Create**:

```text
Request:
  POST /api/sim/checkout?cpu_ms=3&db_writes=2&external_ms=40&external_fail_rate=0
  Headers:
    Content-Type: application/json
    X-Test-Suite: constant-arrival-rate
    X-User-ID: arrival-user-243
    Idempotency-Key: car04-checkout-seed-42-7
  Body: {
    "payment_method": "card",
    "items": [{"id": 12, "qty": 1}]
  }

Response (expected):
  HTTP 200 OK
  Body: { "order_id": "CAR-ORDER-seed-42-7", "status": "created", ... }

Latency breakdown:
  cpu_ms=3:      3ms (CPU xử lý business logic)
  db_writes=2:   2ms (INSERT order vào database)
  external_ms=40: 40ms (gọi external payment gateway)
  overhead:      ~3ms (HTTP, JSON parse)
  → Tổng ≈ 48ms
```

**Step 2 — Order Confirm**:

```text
Request:
  POST /api/sim/orders/CAR-ORDER-seed-42-7/confirm?cpu_ms=1&db_writes=1&external_ms=20&external_fail_rate=0
  Headers:
    Content-Type: application/json
    X-Test-Suite: constant-arrival-rate
    X-User-ID: arrival-user-243
    Idempotency-Key: car04-confirm-seed-42-7
  Body: {}

Response (expected):
  HTTP 200 OK
  Body: { "order_id": "CAR-ORDER-seed-42-7", "status": "confirmed", ... }

Latency breakdown:
  cpu_ms=1:      1ms
  db_writes=1:   1ms
  external_ms=20: 20ms (gọi external inventory service)
  overhead:      ~2ms
  → Tổng ≈ 24ms
```

### Event duration calculation

```text
event_duration = checkout_latency + confirm_latency + internal_overhead
               ≈ 48ms + 24ms + 5ms
               ≈ 77ms (happy path)

Với tail (p95 external_ms cao hơn):
  checkout_latency_p95 ≈ 3 + 2 + 120 = 125ms
  confirm_latency_p95  ≈ 1 + 1 + 60  = 62ms
  event_duration_p95   ≈ 125 + 62 + 5 = 192ms
```

### Headers đầy đủ

| Header | Step 1 | Step 2 | Ý nghĩa |
| --- | ---: | ---: | --- |
| `Content-Type` | `application/json` | `application/json` | Body format |
| `X-Test-Suite` | `constant-arrival-rate` | `constant-arrival-rate` | Đánh dấu test suite |
| `X-User-ID` | `arrival-user-243` | `arrival-user-243` | User identity cho tracing |
| `Idempotency-Key` | `car04-checkout-seed-42-7` | `car04-confirm-seed-42-7` | Chống duplicate |

### Tags trên mỗi request

| Tag | Step 1 value | Step 2 value | Dùng cho metric nào? |
| --- | --- | --- | --- |
| `case_id` | `car-04-checkout-order-intake` | `car-04-checkout-order-intake` | Lọc theo case |
| `service` | `order-service` | `order-service` | Nhóm theo service |
| `operation` | `checkout_arrival_create` | `checkout_arrival_confirm` | Phân biệt operation |
| `endpoint` | `POST /api/sim/checkout` | `POST /api/sim/orders/:id/confirm` | Phân biệt endpoint |
| `user_id` | `arrival-user-243` | `arrival-user-243` | Trace user |
| `name` | `checkout_arrival_create` | `checkout_arrival_confirm` | Tên trên dashboard |

## Metrics & tags deep-dive

### Tất cả metrics trong case này

| Metric | Type | Tags | Ý nghĩa | Expected value |
| --- | --- | --- | --- | ---: |
| `constant_arrival_events_total` | Counter | case_id, service, operation, user_id | Số event hoàn thành | 225 |
| `constant_arrival_events_failed` | Counter | case_id, service, operation, user_id | Số event failed | 0 |
| `constant_arrival_api_calls_total` | Counter | case_id, service, operation, endpoint, user_id | Số API calls đã gửi | 450 |
| `constant_arrival_event_duration_ms` | Trend | case_id, service, operation, user_id | Thời gian hoàn thành event (ms) | p95 ~115ms |
| `dropped_iterations` | Counter | (k6 built-in) | Số slot bị drop | 0 |
| `iterations` | Counter | (k6 built-in) | Số iteration hoàn thành | 225 |
| `http_reqs` | Counter | (k6 built-in) | Số HTTP requests | 450 |
| `http_req_duration` | Trend | (k6 built-in) | HTTP request duration | p95 ~100ms |
| `http_req_failed` | Rate | (k6 built-in) | Tỉ lệ request fail | 0% |
| `checks` | Rate | (k6 built-in) | Tỉ lệ check pass | >99% |
| `vus` | Gauge | (k6 built-in) | Số VU active | 1-15 |
| `vus_max` | Gauge | (k6 built-in) | Số VU max đã dùng | ≤40 |

### http_reqs = 2 x iterations là healthy signal

```text
Đây là case ĐẶC BIỆT: http_reqs gấp đôi iterations.

Người mới dễ nhầm:
  "http_reqs phải bằng iterations — mỗi iteration là 1 HTTP request"
  → SAI với case này

Đúng:
  "1 iteration = 1 checkoutOrderIntake() = 2 API calls"
  → http_reqs = iterations × 2 là DẤU HIỆU KHỎE MẠNH
  → Nếu http_reqs < iterations × 2 → có step bị skip hoặc fail
```

**Bảng chẩn đoán từ tỉ lệ http_reqs/iterations**:

| Tỉ lệ | Ý nghĩa | Hành động |
| ---: | --- | --- |
| = 2.0 | Cả 2 step đều chạy | Healthy |
| 1.8 - 2.0 | Một số event skip step 2 | Kiểm tra checkout create fail rate |
| 1.0 - 1.8 | Nhiều event skip step 2 | Điều tra nghiêm trọng |
| < 1.0 | Thậm chí step 1 cũng skip | Lỗi code hoặc early return logic |
| > 2.0 | Có redirect hoặc extra requests | Kiểm tra code flow |

### constant_arrival_events_failed < 5 (stricter threshold)

```text
Tại sao threshold là 5 chứ không phải 0?

Với 225 events:
  - 5 failures / 225 = 2.2% fail rate
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
constant_arrival_events_total:
  - Tăng 1 mỗi lần finishEvent() được gọi
  - Tagged với operation: 'checkout_order_arrival'
  → Lọc được: events_total{operation="checkout_order_arrival"}

constant_arrival_api_calls_total:
  - Tăng 1 mỗi lần requestJson() được gọi (2 lần/event)
  - Tagged với operation: 'checkout_arrival_create' và 'checkout_arrival_confirm'
  → Lọc được: api_calls_total{operation="checkout_arrival_create"} ≈ 225
              api_calls_total{operation="checkout_arrival_confirm"} ≈ 225

constant_arrival_event_duration_ms:
  - Ghi nhận thời gian từ start đến finishEvent()
  - Phân phối theo operation: 'checkout_order_arrival'
  → p95, p99 cho toàn bộ event
```

## Pass criteria

### Bảng pass criteria mở rộng

| Check | Pass khi | Rationale | Mức độ |
| --- | --- | --- | --- |
| `dropped_iterations` | `count <= 0` | Checkout không được drop | CRITICAL |
| `constant_arrival_events_failed` | `count < 5` | < 2.2% events fail | HIGH |
| `checks` | `rate > 0.99` | > 99% checks pass | HIGH |
| `http_req_failed` | `rate < 0.01` | < 1% HTTP errors | HIGH |
| `iterations` | gần 225 (±2) | Scheduled slots đều được thực hiện | MEDIUM |
| `http_reqs` | gần 450 (±4) | Cả 2 step đều chạy (~2× iterations) | MEDIUM |
| `constant_arrival_events_total` | = iterations | Mỗi iteration emit 1 event | MEDIUM |
| `constant_arrival_api_calls_total` | ≈ http_reqs | Mỗi API call được đếm | MEDIUM |
| `vus_max` | ≤ 40 | Không vượt trần VU | LOW |

### Vì sao p95 không có trong pass criteria chính?

```text
Case này tập trung vào INTAKE CAPACITY (có drop không), không phải latency SLA.
p95 event duration được theo dõi nhưng không phải pass/fail chính.

Lý do:
  - Contract: "xử lý 5 checkout/s, không drop" → focus vào throughput
  - External latency (40ms, 20ms) là simulated — không phải latency thật
  - p95 thực tế phụ thuộc vào external_ms config, không phải performance thật

Tuy nhiên, trong output→decision:
  - p95 vẫn được đọc để đánh giá UX
  - Nếu p95 > 500ms dù 0 drop → vấn đề UX (xem scenario B)
```

### Pass criteria so sánh với case 01

| Tiêu chí | Case 01 (storefront) | Case 04 (checkout) | Lý do khác biệt |
| --- | ---: | ---: | --- |
| dropped_iterations | ≤ 10 | = 0 | Checkout critical hơn browse |
| events_failed | không có metric này | < 5 | Case 04 có business event tracking |
| iterations expected | 150 fixed | ~225 | Case 01 dùng per-vu-iterations (fixed count), case 04 dùng constant-arrival-rate (rate-driven) |
| http_reqs expected | variable | ~450 (2× iterations) | Case 04 có amplification factor = 2 |
| p95 threshold | < 2000ms | không có (focus intake) | Case 01 là latency test, case 04 là capacity test |

## Cách chạy

### Local run với cloud output

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-04-checkout-order-intake.js"
```

### Env override cho các tham số

```powershell
# Override rate (smoke test với rate thấp hơn)
$env:CAR_04_RATE = "2"
$env:CAR_04_DURATION = "20s"

# Override VU pool (test áp lực VU)
$env:CAR_04_PREALLOCATED_VUS = "5"
$env:CAR_04_MAX_VUS = "10"

# Override external latency (mô phỏng external chậm)
# (phải sửa script để thêm env var cho external_ms)
```

### Verify trên UI

```text
1. Mở http://localhost:13001
2. Paste student-token-1234567890
3. Click vào run mới nhất
4. Tile "iterations" hiển thị ~225 ✓
5. Tile "http_reqs" hiển thị ~450 ✓
6. Tile "dropped_iterations" hiển thị 0 ✓
7. Tile "checks" hiển thị 100% ✓
```

### Cách đọc output khi mới chạy

```text
running (XX.Xs), 00/15 VUs, 225 complete and 0 interrupted iterations

  █ TOTAL RESULTS

    EXECUTION
    iterations.........: 225
    iteration_duration.: avg=75ms p(95)=115ms
    http_reqs..........: 450
    http_req_duration..: avg=35ms p(95)=100ms
    http_req_failed....: 0.00%
    checks_total.......: ~900 (2 checks/request × 450 requests)
    vus................: 1..15
    vus_max............: 15
    dropped_iterations.: 0

    CUSTOM METRICS
    constant_arrival_events_total.......: 225
    constant_arrival_events_failed......: 0
    constant_arrival_api_calls_total....: 450
    constant_arrival_event_duration_ms..: avg=75ms p(95)=115ms
```

## Phân tích output theo 5 bước

### Bước 1: Verify config [Header]

```text
Header in:    executor=constant-arrival-rate, rate=5, timeUnit=1s, duration=45s
Config có:    RATE=5, TIME_UNIT='1s', DURATION='45s' ✓

Header in:    preAllocatedVUs=15, maxVUs=40
Config có:    PREALLOCATED_VUS=15, MAX_VUS=40 ✓

Header in:    scenario name: checkout_order_intake
Config có:    exec: 'checkoutOrderIntake' ✓
```

### Bước 2: Tính expected slots [CT 1]

```text
lambda = rate / timeUnit_seconds = 5 / 1 = 5 arrivals/s
scheduled_slots = lambda × duration_seconds = 5 × 45 = 225 arrivals

→ Expected iterations = 225 (nếu 0 drop, 0 interrupt)
```

### Bước 3: So sánh với N_done [CT 5]

```text
Summary cho:  iterations = 226
Dự kiến:      225
Tỷ lệ:        226 / 225 = 100.4% → hoàn hảo

Lệch +1 là bình thường:
  - k6 scheduler có thể schedule thêm 1 slot ở cuối nếu timing trùng
  - Hoặc timeUnit boundary tính khác một chút
  - ±1-2 slots so với expected là chấp nhận được
```

### Bước 4: Multi-step reconciliation

Đây là bước quan trọng nhất của case này — verify rằng cả 2 step đều chạy.

```text
Step 4a: Verify http_reqs = iterations × 2
  http_reqs = 452
  iterations × 2 = 226 × 2 = 452
  → 452 = 452 ✓
  → Tỉ lệ http_reqs/iterations = 452/226 = 2.0
  → Cả 2 step đều chạy cho mọi iteration

Step 4b: Verify constant_arrival_events_total = iterations
  constant_arrival_events_total = 226
  iterations = 226
  → 226 = 226 ✓
  → Mỗi iteration emit đúng 1 event

Step 4c: Verify constant_arrival_api_calls_total = http_reqs
  constant_arrival_api_calls_total = 452
  http_reqs = 452
  → 452 = 452 ✓
  → Mỗi API call được đếm đúng

Step 4d: Verify dropped_iterations = 0
  dropped_iterations = 0 ✓
  → Không slot nào bị drop

Step 4e: Verify constant_arrival_events_failed < 5
  constant_arrival_events_failed = 0
  → 0 < 5 ✓
  → Không event nào fail
```

**Bảng reconciliation**:

| Metric | Expected | Actual | Match? |
| --- | ---: | ---: | --- |
| iterations | 225 | 226 | ✓ (±1) |
| http_reqs | 450 | 452 | ✓ (= 2×226) |
| constant_arrival_events_total | 225 | 226 | ✓ (= iterations) |
| constant_arrival_api_calls_total | 450 | 452 | ✓ (= http_reqs) |
| dropped_iterations | 0 | 0 | ✓ |
| constant_arrival_events_failed | < 5 | 0 | ✓ |

**Nếu không khớp — chẩn đoán**:

| Dấu hiệu | Nguyên nhân có thể | Hành động |
| --- | --- | --- |
| http_reqs < iterations × 2 | Step 2 bị skip | Kiểm tra checkout create fail rate |
| constant_arrival_events_total < iterations | finishEvent không được gọi | Kiểm tra code path |
| constant_arrival_api_calls_total < http_reqs | requestJson không emit metric | Kiểm tra common.js |
| dropped_iterations > 0 | VU pool không đủ | Tăng preAllocatedVUs hoặc maxVUs |
| constant_arrival_events_failed >= 5 | Có event fail | Điều tra operation có fail |

### Bước 5: Business conclusion

Từ kết quả Run 92:

```text
iterations = 226 (expected 225) ✓
http_reqs = 452 (= 2 × 226) ✓
dropped_iterations = 0 ✓
constant_arrival_events_failed = 0 ✓
constant_arrival_event_duration_ms p95 = 115ms

KẾT LUẬN:
  - Order service giữ được 5 checkout arrivals/s trong 45s
  - Không drop, không event fail
  - p95 event duration = 115ms → acceptable UX
  - Hệ thống đạt contract checkout intake
  → PASS
```

## Dashboard 3-chart deep analysis

### Tổng quan dashboard cho case 04

Dashboard case 04 có 3 chart cần đọc trong tab Overview, cộng với tab Executor:

```text
1. Response time        — latency của từng operation (checkout_create vs confirm)
2. Execution timeline   — http_reqs/bucket và iterations/bucket
3. VUs vs iter/s        — VU usage và iteration throughput
4. Executor tab         — model open model với arrival rate
```

### Chart 1 — Response time (phân biệt checkout_create vs confirm)

Chart này cho case 04 có ĐẶC ĐIỂM RIÊNG: cần đọc theo operation, không phải
aggregate toàn bộ.

**Các series cần đọc**:

```text
Theo operation:
  checkout_arrival_create  — POST /api/sim/checkout (external_ms=40)
  checkout_arrival_confirm — POST /api/sim/orders/:id/confirm (external_ms=20)
```

**Kỳ vọng**:

```text
checkout_arrival_create:
  - avg: ~40-50ms (cpu_ms=3 + db_writes=2 + external_ms=40 ≈ 45ms)
  - p95: ~100-120ms (external_ms tail)
  - Ổn định suốt test (không spike)

checkout_arrival_confirm:
  - avg: ~20-25ms (cpu_ms=1 + db_writes=1 + external_ms=20 ≈ 22ms)
  - p95: ~50-70ms
  - Thấp hơn checkout create vì external_ms nhỏ hơn (20ms vs 40ms)
```

**Đọc shape**:

```text
Shape đẹp:
  checkout_create p95 ~120ms cao hơn confirm p95 ~60ms
  Cả 2 ổn định suốt 45s
  Không có spike đột biến

Shape xấu:
  checkout_create p95 tăng dần theo thời gian → external dependency chậm dần
  confirm p95 tăng theo checkout_create → cascade latency
  Cả 2 cùng spike → vấn đề hệ thống (không chỉ external)
```

**Vì sao phải tách theo operation?**

```text
Nếu không tách:
  - p95 aggregate = trộn checkout_create (~45ms) và confirm (~22ms)
  - Không thấy được sự khác biệt giữa 2 step
  - Không biết step nào là bottleneck

Khi tách:
  - checkout_create luôn chậm hơn confirm → đúng (external_ms=40 > 20)
  - Nếu confirm chậm hơn checkout_create → BẤT THƯỜNG → điều tra
```

### Chart 2 — Execution timeline (http_reqs/bucket ≈ 10/s = 2× iterations/bucket ≈ 5/s)

Đây là chart QUAN TRỌNG NHẤT để hiểu amplification factor.

**Kỳ vọng**:

```text
iterations/bucket ≈ 5/s (rate intake)
http_reqs/bucket ≈ 10/s (vì mỗi iteration = 2 HTTP requests)
dropped_iterations = 0
```

**Bảng point mẫu (từ run thật)**:

| Time bucket | Live VUs | HTTP reqs | Iterations | Dropped |
| --- | ---: | ---: | ---: | ---: |
| bucket 1 | 15 | 10 | 5 | 0 |
| bucket 2 | 15 | 12 | 6 | 0 |
| bucket 3 | 15 | 10 | 5 | 0 |
| bucket 4 | 15 | 8 | 4 | 0 |
| bucket 5 | 15 | 12 | 6 | 0 |
| ... | ... | ... | ... | ... |
| bucket 9 (cuối) | 15 | 10 | 5 | 0 |

**Verify**:

```text
sum(httpReqs) ≈ 452 → khớp summary http_reqs ✓
sum(iterations) ≈ 226 → khớp summary iterations ✓
httpReqs/bucket ≈ 2 × iterations/bucket → amplification factor = 2 ✓
dropped_iterations = 0 ở mọi bucket ✓
```

**Bài học từ chart này**:

```text
Đây là case tốt để dạy rằng:
  http_reqs/s có thể KHÁC iterations/s
  http_reqs/s = iterations/s × (số API calls per iteration)

Người mới nhìn chart:
  "Sao http_reqs cao gấp đôi iterations?"
  → Trả lời: vì mỗi checkout arrival cần 2 API calls

Trong production:
  - Nếu thấy http_reqs/s = iterations/s → có thể 1 step bị skip
  - Nếu thấy http_reqs/s > 2× iterations/s → có redirect hoặc extra requests
```

### Chart 3 — VUs vs iter/s (low rate but VUs can be high)

**Kỳ vọng**:

```text
Executor VUs: 15 (preAllocatedVUs)
Actual iter/s: dao động quanh 5/s
Peak iter/s: nếu tất cả 15 VU cùng active → ~15/0.07 ≈ 214/s (nhưng không đạt vì rate chỉ 5/s)

Điểm đặc biệt:
  - Rate chỉ 5/s nhưng Executor VUs = 15
  - 15 VU KHÔNG phải vì cần xử lý nhiều — mà là BUFFER cho external latency
  - Actual iter/s thấp hơn capacity rất nhiều (5/s vs 214/s capacity)
  → VU idle rất nhiều — đây là "lãng phí có chủ đích"
```

**Đọc shape VU**:

```text
Với constant-arrival-rate, Observed VUs là số VU đang bận (đang xử lý event).
Với rate=5/s và W_effective≈70ms:
  - Tại mỗi thời điểm, trung bình có 5 × 0.07 = 0.35 VU đang bận
  - → Observed VUs thường ≈ 1-3 (không phải 15)
  - 15 VU là pre-allocated (sẵn sàng), không phải lúc nào cũng active

Nếu Observed VUs gần 15:
  - External latency đang cao → nhiều VU bị giữ
  - Có thể sắp chạm trần → cần tăng maxVUs
```

**So sánh VUs vs iter/s với case 01**:

| | Case 01 (per-vu-iterations) | Case 04 (constant-arrival-rate) |
| --- | --- | --- |
| Fixed VUs | 8 (config) | 15 (preAllocatedVUs) |
| Observed VUs shape | Giảm dần về cuối (VU xong quota) | Ổn định thấp, có thể tăng nếu external chậm |
| Actual iter/s | Biến thiên, tổng = 40 | Ổn định ~5/s, tổng = 226 |
| Peak iter/s | 8 / iter_time ≈ 4.18/s | 15 / iter_time ≈ 214/s (capacity, không phải target) |
| Target rate | Không có (count-driven) | 5/s (rate-driven) |

### Executor tab

**Tab Executor cho case 04**:

```text
EXECUTOR = constant-arrival-rate
```

**Các series**:

```text
Fixed VUs:        15 (preAllocatedVUs)
Observed VUs:     thường 1-3, có thể lên 15 nếu external chậm
Actual iter/s:    ~5/s ổn định
Target rate:      5/s (đường rate target)
Dropped:          0
```

**Đọc executor tab cho open model**:

```text
Điểm khác biệt với closed model:
  - Không có "VU nhanh xong quota" → VU không có quota
  - Observed VUs = số VU đang bận xử lý event
  - Target rate là đường ngang ở 5/s
  - Actual iter/s bám sát target rate

Nếu Observed VUs tăng nhưng Actual iter/s vẫn 5/s:
  → External latency đang tăng → VU bị giữ lâu hơn
  → Nhưng scheduler vẫn giữ được rate
  → Đây là dấu hiệu hệ thống đang dùng thêm VU để bù latency

Nếu Observed VUs chạm maxVUs và Actual iter/s < 5/s:
  → VU pool cạn → bắt đầu drop slot
  → Cần tăng maxVUs hoặc giảm external latency
```

## 4 output->decision scenarios

### Scenario A: Perfect pass (Run 92)

```text
iterations................................: 226
http_reqs.................................: 452
dropped_iterations........................: 0
constant_arrival_events_failed............: 0
constant_arrival_event_duration_ms p95....: 115ms
checks....................................: 100%
http_req_failed...........................: 0%
```

**Phân tích**:

```text
- 226 iterations ≈ 225 expected → đủ slots
- 452 http_reqs = 2 × 226 → cả 2 step đều chạy
- 0 dropped → VU pool đủ
- 0 events_failed → không event nào fail
- p95 = 115ms → acceptable UX cho checkout

KẾT LUẬN: Order service xử lý ổn 5 checkout/s, không drop, không fail.
          Hệ thống sẵn sàng cho production với config này.
```

**Quyết định**: ✅ PASS — triển khai production.

### Scenario B: Pass nhưng p95 high (external dependency slow, UX concern)

```text
iterations................................: 226
http_reqs.................................: 452
dropped_iterations........................: 0
constant_arrival_events_failed............: 0
constant_arrival_event_duration_ms p95....: 450ms  ← CAO!
checks....................................: 100%
http_req_failed...........................: 0%
```

**Phân tích**:

```text
- Intake vẫn đạt: 0 drop, đủ slots
- API calls vẫn đủ: 452 = 2 × 226
- NHƯNG p95 event duration = 450ms → checkout mất gần nửa giây

Nguyên nhân có thể:
  - External payment gateway đang chậm (p95 cao)
  - DB query chậm do lock contention
  - Network latency giữa service và external dependency

Business impact:
  - User thấy "đang xử lý checkout..." lâu → UX kém
  - Có thể user bỏ đi trước khi xong → mất sale
  - Dù không drop, trải nghiệm vẫn tệ

KẾT LUẬN: Contract intake ĐẠT (0 drop), nhưng UX KHÔNG ĐẠT (p95 cao).
```

**Quyết định**: ⚠️ CONDITIONAL PASS — điều tra external dependency latency
trước khi release. Nếu p95 > 500ms, coi như FAIL.

### Scenario C: Contract breach (dropped > 0 despite low rate 5/s)

```text
iterations................................: 198  ← THIẾU 27!
http_reqs.................................: 396
dropped_iterations........................: 27   ← BREACH!
constant_arrival_events_failed............: 0
constant_arrival_event_duration_ms p95....: 350ms
checks....................................: 99%
http_req_failed...........................: 0.5%
```

**Phân tích**:

```text
- 27 dropped_iterations → 27 checkout arrivals bị mất
- Drop rate = 27/225 = 12% → không thể chấp nhận
- p95 event duration = 350ms → external latency cao
- VU pool không đủ để hấp thụ latency này

Nguyên nhân gốc:
  - W_effective cao (350ms p95) → cần nhiều VU hơn để giữ rate
  - preAllocatedVUs=15 không đủ cho mức latency này
  - maxVUs=40 có thể đã bị chạm → cần tăng thêm

Công thức kiểm chứng:
  required_vus ≈ ceil(lambda × W_effective_p95)
              ≈ ceil(5 × 0.350)
              ≈ ceil(1.75)
              ≈ 2 VU (lý thuyết)

  NHƯNG với p95=350ms, phân phối latency có tail dài hơn:
  - 5% events mất 350ms+
  - Một số events mất 500ms+
  - Với 15 VU, capacity = 15/0.350 = 42.8/s → vẫn dư
  - Vậy sao drop? → Có thể external latency cao HƠN p95 nhiều
    (p99 = 800ms chẳng hạn)

KẾT LUẬN: CONTRACT BREACH. VU pool không đủ cho external latency thực tế.
```

**Quyết định**: ❌ FAIL — tăng maxVUs (vd 80-100), hoặc điều tra vì sao
external latency cao bất thường. Chạy lại test.

### Scenario D: Step-1 failures (http_reqs < iterations × 2, checkout create failing)

```text
iterations................................: 226
http_reqs.................................: 340  ← THẤP! (lẽ ra 452)
dropped_iterations........................: 0
constant_arrival_events_failed............: 45   ← CAO!
constant_arrival_event_duration_ms p95....: 80ms
checks....................................: 90%
http_req_failed...........................: 10%
```

**Phân tích**:

```text
- http_reqs = 340, iterations = 226
- Tỉ lệ http_reqs/iterations = 340/226 = 1.50
- → Chỉ khoảng 50% events có cả 2 step chạy
- constant_arrival_events_failed = 45 → 45/226 = 20% events fail
- http_req_failed = 10% → nhiều request fail

Chẩn đoán:
  - Checkout create đang fail với tỉ lệ cao
  - Khi checkout create fail, confirm có thể bị skip (nếu code có early return)
  - Hoặc confirm cũng fail theo

Nguyên nhân có thể:
  - external_fail_rate được set > 0 (trong test config)
  - Backend checkout service thật sự lỗi
  - Payment method không hợp lệ
  - Idempotency key conflict

KẾT LUẬN: Intake đạt (0 drop) nhưng business logic fail.
          Checkout create đang có vấn đề.
```

**Quyết định**: ❌ FAIL — điều tra checkout create failures. Xem log, trace
events_failed, check external_fail_rate config.

### Bảng tổng kết 4 scenarios

| Scenario | Drop | Events Failed | http_reqs/iter | p95 | Kết luận | Hành động |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| A: Perfect | 0 | 0 | 2.0 | 115ms | PASS | Release production |
| B: High p95 | 0 | 0 | 2.0 | 450ms | CONDITIONAL | Điều tra external latency |
| C: Contract breach | 27 | 0 | 2.0 | 350ms | FAIL | Tăng VU pool, điều tra latency |
| D: Step-1 failures | 0 | 45 | 1.5 | 80ms | FAIL | Fix checkout create logic |

## "Nghịch lý" của case 04

### Nghịch lý 1: "rate=5/s thấp nhất pack nhưng preAllocatedVUs=15 cao hơn cả case 01 (rate=20/s, pre=12)"

```text
Trực giác sai:
  "Rate càng cao → cần càng nhiều VU"
  → Nếu rate=5/s cần 15 VU, thì rate=20/s phải cần 60 VU?
  → Nhưng case 01 (rate=20/s) chỉ cần 12 VU!

Sự thật:
  VU sizing = lambda × W_effective, không phải lambda đơn thuần.

  Case 01: lambda=20, W_effective=4ms → required_vus_min = ceil(20 × 0.004) = 1
           preAllocatedVUs=12 (12x buffer)
  Case 04: lambda=5,  W_effective=70ms → required_vus_min = ceil(5 × 0.070) = 1
           preAllocatedVUs=15 (15x buffer)

  Cả 2 đều cần 1 VU về lý thuyết.
  Nhưng buffer case 04 cần lớn hơn vì:
    - External latency có variance cao hơn (40ms mà p95 có thể 120ms)
    - W_effective lớn hơn → mỗi VU bị giữ lâu hơn → cần buffer lớn hơn
    - Checkout là business-critical → buffer phải an toàn hơn

  preAllocatedVUs cao không vì rate cao, mà vì W_effective lớn + variance cao.
```

**Bảng so sánh buffer ratio**:

| Case | Rate | W_effective | required_vus_min | preAllocatedVUs | Buffer ratio (pre/required) | pre/rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| case 01 | 20/s | 4ms | 1 | 12 | 12x | 0.6 |
| case 02 | 30/s | 5ms | 1 | 18 | 18x | 0.6 |
| case 03 | 10/s | 8ms | 1 | 10 | 10x | 1.0 |
| **case 04** | **5/s** | **70ms** | **1** | **15** | **15x** | **3.0** |
| case 05 | 3/s | 100ms | 1 | 12 | 12x | 4.0 |

→ `pre/rate` tăng dần theo W_effective. Đây là insight quan trọng: **khi W_effective
tăng, cần nhiều VU hơn TRÊN MỖI ĐƠN VỊ RATE**.

### Nghịch lý 2: "http_reqs gấp đôi iterations — đây không phải bug"

```text
Trực giác sai:
  "Mỗi iteration là 1 HTTP request"
  → iterations = 226, http_reqs phải = 226
  → Nhưng http_reqs = 452 → "có bug, gửi request 2 lần!"

Sự thật:
  Trong case này, 1 iteration = 1 checkoutOrderIntake() = 2 API calls.
  http_reqs = 452 = 226 × 2 → đúng flow.

  Đây không phải bug, mà là amplification factor.
  Mỗi arrival event cần 2 API calls để hoàn thành:
    - Tạo checkout (POST /api/sim/checkout)
    - Confirm order (POST /api/sim/orders/:id/confirm)

  Nếu http_reqs = iterations → đó mới là BUG (1 step bị skip).
```

**Bảng "dịch" http_reqs sang business**:

| http_reqs / iterations | Business meaning |
| ---: | --- |
| = 1.0 | Chỉ 1 step chạy (có thể checkout create hoặc confirm đơn độc) — BUG |
| = 2.0 | Cả 2 step đều chạy — HEALTHY |
| 1.0 < x < 2.0 | Một số event skip step 2 — cascade failure |
| > 2.0 | Có redirect hoặc extra requests — cần điều tra |

### Nghịch lý 3: "p95=115ms vẫn pass dù cao hơn storefront 4ms — vì contract khác nhau"

```text
Trực giác sai:
  "p95 càng thấp càng tốt"
  → Case 01 p95=4ms, case 04 p95=115ms
  → Case 04 "chậm hơn 28 lần" → "không pass"

Sự thật:
  Contract của mỗi case khác nhau:
    - Case 01 (storefront browse): đọc sản phẩm, p95 < 2000ms là OK
    - Case 04 (checkout intake): throughput test, focus vào 0 drop
      p95 không phải pass/fail chính

  115ms cho checkout là HOÀN TOÀN CHẤP NHẬN ĐƯỢC:
    - User thấy "đang xử lý..." trong < 0.2s → UX tốt
    - External payment gateway thường mất 100-500ms trong thực tế
    - 115ms là simulated (external_ms=40+20=60ms + overhead)

  So sánh p95 phải cùng ngữ cảnh:
    - Browse: p95 < 100ms (user expect nhanh)
    - Search: p95 < 200ms
    - Checkout: p95 < 500ms (user sẵn sàng chờ hơn vì là bước quan trọng)
    - Payment: p95 < 1000ms (external bank processing)
```

### Nghịch lý 4: "Idempotency key không làm giảm latency nhưng bảo vệ data integrity"

```text
Trực giác sai:
  "Thêm header Idempotency-Key sẽ làm request nhanh hơn"
  → Hoặc: "Idempotency-Key là để cache response"

Sự thật:
  Idempotency key KHÔNG cải thiện latency. Nó thậm chí làm chậm hơn 1-2ms
  (server phải check key trong DB/cache).

  Mục đích thật sự:
    - KHÔNG phải performance optimization
    - LÀ data integrity guarantee
    - Đảm bảo 1 request chỉ được xử lý 1 lần, dù gửi lại nhiều lần
    - Bảo vệ khỏi duplicate order, double charge

  Trade-off:
    Cost: +1-2ms latency, +storage cho key lookup
    Benefit: tránh duplicate order → bảo vệ revenue + niềm tin khách hàng
    → Trade-off RẤT ĐÁNG trong hệ thống thanh toán

  Trong case này, idempotency key là pattern ĐÚNG cho checkout flow.
  Không dùng nó để tăng performance — dùng để đảm bảo correctness.
```

## Checklist

### Pre-run checklist

```text
[ ] Stack đã start (k6-metrics-server + services)
[ ] BASE_URL trỏ đúng (http://localhost:80)
[ ] K6_CLOUD_HOST = http://localhost:18080
[ ] K6_CLOUD_TOKEN = student-token-1234567890
[ ] Script path đúng: car-04-checkout-order-intake.js
[ ] Env vars đã set (hoặc dùng default)
[ ] Không có process k6 cũ đang chạy
```

### Run-time checklist (dashboard real-time)

```text
[ ] Tab Overview: iterations đang tăng đều ~5/s
[ ] Tab Overview: http_reqs đang tăng đều ~10/s (= 2× iter/s)
[ ] Tab Overview: dropped_iterations = 0 suốt test
[ ] Response time chart: checkout_create p95 > confirm p95 (đúng)
[ ] Response time chart: không spike bất thường
[ ] Execution timeline: VUs ổn định, không chạm maxVUs
[ ] VUs vs iter/s: Actual iter/s ≈ 5/s ổn định
```

### Post-run checklist

```text
[ ] iterations ≈ 225 (±2)
[ ] http_reqs = iterations × 2 (452 với 226 iter)
[ ] dropped_iterations = 0
[ ] constant_arrival_events_failed < 5
[ ] constant_arrival_events_total = iterations
[ ] constant_arrival_api_calls_total = http_reqs
[ ] checks rate > 99%
[ ] http_req_failed rate < 1%
[ ] vus_max ≤ 40
[ ] Dashboard Executor tab: executor = constant-arrival-rate
[ ] Dashboard Executor tab: rate target = 5/s
```

### Troubleshooting checklist

| Triệu chứng | Check gì? | Hành động |
| --- | --- | --- |
| iterations < 225 | dropped_iterations > 0? | Tăng maxVUs hoặc preAllocatedVUs |
| iterations < 225, drop=0 | Test bị ngắt sớm? | Kiểm tra duration, gracefulStop |
| http_reqs < iterations × 2 | Checkout create fail? | Xem constant_arrival_events_failed |
| http_reqs > iterations × 2 | Có redirect? | Kiểm tra response status 3xx |
| p95 > 500ms | External latency cao? | Kiểm tra external_ms env, backend health |
| vus_max = maxVUs | VU pool cạn? | Tăng maxVUs |
| checks rate < 99% | Check nào fail? | Xem log check cụ thể |

## 5 variations với code PowerShell

### V1: Lower rate smoke test

```powershell
# Smoke test: rate=2/s trong 10s → 20 slots expected
$env:CAR_04_RATE = "2"
$env:CAR_04_DURATION = "10s"
$env:CAR_04_PREALLOCATED_VUS = "5"
$env:CAR_04_MAX_VUS = "10"
$env:CAR_04_MAX_DROPPED = "0"

k6 run -o cloud "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-04-checkout-order-intake.js"

# Expected: 20 iter, 40 http_reqs, 0 drop
# Dùng để verify nhanh script chạy đúng trước khi test đầy đủ
```

### V2: Shrink VU pool — quan sát massive drops (dạy sizing)

```powershell
# Giảm VU pool xuống cực thấp → bắt buộc drop
$env:CAR_04_RATE = "5"
$env:CAR_04_DURATION = "45s"
$env:CAR_04_PREALLOCATED_VUS = "2"   # ← CHỈ 2 VU!
$env:CAR_04_MAX_VUS = "4"            # ← max 4 VU
$env:CAR_04_MAX_DROPPED = "100"      # ← tăng threshold để thấy drop

k6 run -o cloud "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-04-checkout-order-intake.js"

# Expected: iterations < 225, dropped_iterations > 0
# Bài học: VU pool quá nhỏ → không giữ được rate intake
# Tính toán: với W_effective≈70ms, 2 VU → capacity = 2/0.07 = 28.5/s
# → vẫn > 5/s → SAO LẠI DROP?
# → Vì external latency có tail, 1 event có thể mất 150ms
# → 2 VU không đủ absorb tail → drop xảy ra
```

**Phân tích kết quả V2**:

```text
Với preAllocatedVUs=2, maxVUs=4:
  - Nếu external_ms luôn = 40ms: capacity = 4/0.07 = 57/s → đủ
  - Nhưng external_ms có variance:
    + 5% events: external_ms = 120ms → W_effective ≈ 150ms
    + 1% events: external_ms = 200ms → W_effective ≈ 230ms
  - Khi 1 event mất 230ms, nó giữ 1 VU trong 230ms
  - Với 4 VU, trong 230ms có 230/200 = 1.15 slots scheduled
  - Nếu 2 event cùng rơi vào tail → 2 VU bị giữ
  - Slot thứ 3 đến → chỉ còn 2 VU free → OK
  - Nhưng nếu 3 event cùng tail → 3 VU bị giữ
  - Slot thứ 4 đến → chỉ còn 1 VU free, nhưng event mới cũng có thể tail
  - → Tại một thời điểm xấu: tất cả 4 VU đều busy → DROP

→ Bài học: VU pool phải đủ lớn để absorb TAIL LATENCY, không chỉ average.
```

### V3: Increase external latency (mô phỏng external dependency chậm)

```powershell
# Phải sửa script để thêm env var cho external_ms
# Hoặc dùng script đã hỗ trợ override:
# (giả sử script có env: CAR_04_EXTERNAL_MS_CHECKOUT, CAR_04_EXTERNAL_MS_CONFIRM)

# Tăng external_ms lên 200ms cho checkout, 100ms cho confirm
$env:CAR_04_RATE = "5"
$env:CAR_04_DURATION = "45s"
$env:CAR_04_PREALLOCATED_VUS = "15"
$env:CAR_04_MAX_VUS = "40"

# Nếu script không hỗ trợ override external_ms, sửa trực tiếp:
# Trong URL: external_ms=200 (thay vì 40), external_ms=100 (thay vì 20)

k6 run -o cloud "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-04-checkout-order-intake.js"

# Expected: vẫn 0 drop (15 VU đủ cho external_ms=200)
# p95 event duration ≈ 350ms (200+100+overhead)
# Bài học: preAllocatedVUs=15 đủ lớn để absorb external latency tăng 5x
```

**Tính toán cho V3**:

```text
external_ms_checkout = 200, external_ms_confirm = 100
W_effective ≈ 200+3+2 + 100+1+1 + 5 = 312ms
capacity = 15 / 0.312 = 48/s → dư 9.6x so với rate=5/s
→ Vẫn an toàn

Nếu external_ms_checkout = 1000, external_ms_confirm = 500:
W_effective ≈ 1512ms
capacity = 15 / 1.512 = 9.9/s → dư 2x
→ Vẫn an toàn nhưng headroom thấp

Nếu external_ms_checkout = 3000, external_ms_confirm = 1500:
W_effective ≈ 4512ms
capacity = 15 / 4.512 = 3.3/s → THẤP HƠN rate=5/s!
→ Bắt buộc drop nếu không tăng VU
→ Lúc này maxVUs=40 mới phát huy: 40 / 4.512 = 8.9/s → đủ
```

### V4: Introduce external_fail_rate (event failure cascading)

```powershell
# Phải sửa script: đổi external_fail_rate từ 0 thành 0.1 (10% fail)
# Trong URL: external_fail_rate=0.1

$env:CAR_04_RATE = "5"
$env:CAR_04_DURATION = "45s"
$env:CAR_04_PREALLOCATED_VUS = "15"
$env:CAR_04_MAX_VUS = "40"
# Tăng threshold events_failed vì ta EXPECT fail
$env:CAR_04_EVENTS_FAILED_MAX = "50"

k6 run -o cloud "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-04-checkout-order-intake.js"

# Expected: iterations ≈ 225, http_reqs < 450 (vài confirm bị skip)
# constant_arrival_events_failed ≈ 22 (10% của 225)
# Bài học: external_fail_rate tạo cascade — checkout create fail → confirm skip
```

**Phân tích V4**:

```text
Với external_fail_rate=0.1 (10%):
  - ~22-23 checkout create sẽ fail (HTTP 500)
  - Nếu code có early return: confirm không chạy → http_reqs < 450
  - Nếu code không có early return: confirm vẫn chạy → http_reqs ≈ 450
    nhưng constant_arrival_events_failed ≈ 22

  Trong code hiện tại:
    ok = ok && checkout.ok;  // ok = false nếu checkout fail
    // confirm VẪN chạy (không có early return)
    const confirm = requestJson(...);
    ok = ok && confirm.ok;

  → http_reqs vẫn = 450 (confirm vẫn chạy)
  → Nhưng 22 events bị đánh dấu failed
  → Đây là pattern "fail-open": vẫn thử confirm dù checkout fail
  → Trong production, có thể đổi thành "fail-close": return sớm nếu checkout fail
```

### V5: Extend duration (kiểm tra ổn định dài hạn)

```powershell
# Kéo dài test lên 5 phút → 5 × 300 = 1500 slots
$env:CAR_04_RATE = "5"
$env:CAR_04_DURATION = "300s"     # ← 5 phút
$env:CAR_04_PREALLOCATED_VUS = "15"
$env:CAR_04_MAX_VUS = "40"
$env:CAR_04_MAX_DROPPED = "0"

k6 run -o cloud "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-04-checkout-order-intake.js"

# Expected: iterations ≈ 1500, http_reqs ≈ 3000, 0 drop
# Bài học: test dài hơn → phát hiện vấn đề tích lũy (memory leak, DB slow overtime)
```

## Anti-patterns (mở rộng)

### Anti-pattern 1: "5/s thấp nên preAllocatedVUs=15 là quá nhiều"

```text
SAI: "Rate 5/s thấp nhất pack, sao cần tới 15 VU? Lãng phí tài nguyên."

ĐÚNG: VU sizing = lambda × W_effective, không phải lambda đơn thuần.
      W_effective của checkout (70ms) gấp ~17 lần storefront browse (4ms).
      Dù rate thấp hơn, mỗi event giữ VU lâu hơn → cần buffer VU lớn hơn.

      preAllocatedVUs=15 không phải "dùng hết 15 VU một lúc".
      Đây là POOL SẴN SÀNG — thực tế chỉ 1-3 VU active cùng lúc.
      12-14 VU còn lại là buffer cho tail latency.

Hậu quả nếu giảm preAllocatedVUs:
  - preAllocatedVUs=5: capacity = 5/0.07 = 71/s → vẫn dư (14x)
    Nhưng khi external latency spike (p95=300ms):
    capacity = 5/0.33 = 15/s → dư 3x → bắt đầu risky
    Khi p99=800ms: capacity = 5/0.83 = 6/s → sát target
    → Chỉ cần vài event tail là DROP

Bài học: Buffer VU giống như insurance — bạn không dùng hết hàng ngày,
       nhưng khi cần thì phải có. Checkout là business-critical → buffer lớn.
```

### Anti-pattern 2: "http_reqs phải bằng iterations"

```text
SAI: "http_reqs = 452, iterations = 226 → lệch gấp đôi → có bug!"

ĐÚNG: Case này 1 iteration = 2 API calls (checkout create + confirm).
      http_reqs = iterations × 2 là HEALTHY SIGNAL.
      Nếu http_reqs = iterations → đó mới là bug (1 step bị skip).

Cách phân biệt:
  - Đọc code: đếm số lần http.post/http.get trong default function
  - Case 04: 2 lần POST → amplification factor = 2
  - Kiểm tra constant_arrival_api_calls_total để verify

Hậu quả nếu "sửa" để http_reqs = iterations:
  - Gộp 2 API calls thành 1 → mất khả năng test riêng từng step
  - Không phát hiện được step nào fail
  - Mất idempotency key riêng cho từng operation
```

### Anti-pattern 3: "Không drop nên checkout ổn hoàn toàn"

```text
SAI: "dropped_iterations=0 → checkout OK → release ngay."

ĐÚNG: Không drop chỉ nói INTAKE đạt. Vẫn phải đọc:
      1. p95 event duration — checkout có nhanh không?
      2. constant_arrival_events_failed — có event nào fail không?
      3. http_reqs/iterations ratio — cả 2 step có chạy không?
      4. checks rate — tất cả assertions có pass không?

Ví dụ:
  dropped=0, events_failed=45 (20%), p95=450ms
  → Intake đạt nhưng 20% checkout fail + chậm → KHÔNG ổn

  dropped=0, events_failed=0, p95=115ms, checks=100%
  → Thật sự ổn

Bài học: dropped_iterations là necessary nhưng không sufficient.
       Phải đọc đủ các metrics khác mới kết luận được.
```

### Anti-pattern 4: "External latency trong test giống production nên kết quả chính xác"

```text
SAI: "external_ms=40 và 20 là đúng production → test này phản ánh đúng performance."

ĐÚNG: external_ms là SIMULATED — nó không phải latency thật của payment gateway.
      Trong production:
        - Payment gateway latency có phân phối phức tạp (không fixed 40ms)
        - Có timeout, retry, circuit breaker
        - Có network hop thật (không phải simulated)

      Test này kiểm tra KHẢ NĂNG CHỊU ĐỰNG external latency của hệ thống,
      không phải benchmark external dependency.

      Để test chính xác hơn:
        - Dùng external_ms distribution thay vì fixed
        - Thêm external_fail_rate để test resilience
        - Test với external_ms cao hơn production (stress test)

Bài học: Simulation là approximation. Dùng test để hiểu behavior pattern,
       không dùng để dự đoán chính xác production latency.
```

### Anti-pattern 5: "Case này chỉ cần constant-vus vì rate thấp"

```text
SAI: "Rate=5/s thấp, constant-vus với 15 VU cho throughput >200/s → quá đủ.
      Không cần constant-arrival-rate phức tạp."

ĐÚNG: constant-vus KHÔNG kiểm tra được câu hỏi business.
      Câu hỏi: "Order service có xử lý ổn 5 checkout/s không?"
      constant-vus không có khái niệm "rate intake" — nó chỉ chạy VU loop.
      Nếu external latency tăng, constant-vus giảm throughput → vô tình "pass".
      constant-arrival-rate giữ rate 5/s → nếu không đủ VU → DROP → fail đúng.

So sánh:
  constant-vus (vus=15):
    - Không định nghĩa rate target
    - Throughput = f(iter_time) — biến thiên
    - Không có dropped_iterations
    - Không trả lời được "có giữ được 5/s không?"

  constant-arrival-rate (rate=5):
    - Rate target cố định = 5/s
    - Scheduler giữ rate, VU pool là capacity
    - Có dropped_iterations khi thiếu VU
    - Trả lời chính xác "có giữ được 5/s không?"

Bài học: Chọn executor phải khớp với CÂU HỎI BUSINESS, không phải chọn
       executor "đơn giản nhất mà vẫn pass".
```

## Kết quả validation 2026-06-21

Full run với default config (Run 92):

```text
Run id: 92
Target slots: 225
Iterations: 226
HTTP requests: 452
Dropped iterations: 0
Checks: 100%
HTTP failed: 0%
constant_arrival_events_total: 226
constant_arrival_events_failed: 0
constant_arrival_api_calls_total: 452
constant_arrival_event_duration_ms p95: 115 ms
vus_max: 15
Result: PASS

Phân tích:
  - iterations = 226 ≈ 225 expected ✓
  - http_reqs = 452 = 2 × 226 ✓ (amplification factor = 2)
  - dropped_iterations = 0 ✓ (contract intake đạt)
  - events_failed = 0 ✓ (không event nào fail)
  - p95 = 115ms (acceptable UX cho checkout)
  - vus_max = 15 (không cần spawn thêm, preAllocatedVUs đủ)
```

## Reference

- Doc tham số: `docs/20260513_00_executor-from-simplest.md`
- Doc constant-arrival-rate: `docs/20260515_01_shared-iterations-quick-index.md`
- Case 01 (storefront): `docs/practice/constant-arrival-rate/01_storefront-browse.md`
- Case 05 (payment): `docs/practice/constant-arrival-rate/05_payment-processing.md`
- Source script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-04-checkout-order-intake.js`
- Common helpers: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\common.js`
- Run guide: `docs/practice/RUN_GUIDE.md`
- Dashboard analysis guide: xem case 01, section "Đọc dashboard real-time charts"
