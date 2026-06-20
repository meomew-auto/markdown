# Case 04: Checkout trickle

## Tình huống thực tế

Team order/payment muốn mô phỏng một dòng checkout nhỏ nhưng liên tục, giống giờ bình thường chứ không phải campaign spike.

Mỗi active user tạo checkout, confirm order, rồi đọc status. Status read chứng minh final order state, không chỉ command 200.

Case này trả lời: với 8 checkout users trong 5 phút, order service và external payment path có ổn định không?

Tóm tắt đời thường:

```text
Executor model: fixed active user pool
VUs: 8
Duration: 5m
Think time: 1s
Team/service focus: order/payment
```

Case này không hỏi:

```text
Có xử lý đủ N job không?
Có đạt đúng X RPS không?
Mỗi user có chạy đúng N vòng không?
```

Nó hỏi:

```text
Nếu giữ 8 active users trong 5m,
latency/error/natural throughput của flow này ra sao?
```

### Vì sao "Checkout trickle" buộc chọn constant-vus?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của checkout trickle trước:

```text
Checkout trickle = "8 users đang checkout liên tục trong 5 phút,
                   mỗi user: tạo order → confirm (thanh toán) → đọc status,
                   quan sát: latency của từng bước, natural throughput,
                   và quan trọng nhất: khi external payment chậm,
                   throughput tự giảm — đó LÀ tín hiệu cần thấy"

Đời thường:
  Quầy thanh toán có 8 quầy (= 8 VU)
  Mỗi khách vào quầy: chọn đồ (= create), quẹt thẻ (= confirm), kiểm hóa đơn (= status)
  Khách nào xong thì quầy đó đón khách tiếp theo
  Quan sát trong 5 phút, không đếm xem phục vụ được bao nhiêu khách
```

Để checkout trickle **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ constant-vus mới thỏa mãn cả 2.

#### Yêu cầu (a): CLOSED MODEL FEEDBACK (backend chậm thì throughput giảm)

**Ý nghĩa**: Khi external payment chậm, throughput checkout PHẢI giảm. Nếu throughput vẫn giữ nguyên, test đang CHE vấn đề thay vì PHÁT HIỆN nó.

**Ví dụ cụ thể**:

```text
Scenario: external payment provider bị chậm (confirm tăng từ 100ms → 3000ms)

Trường hợp A (constant-vus — PHÁT HIỆN vấn đề):
  loop_duration tăng từ 1.5s → 4.0s
  iter/s giảm từ 5.3/s → 2.0/s
  → Dashboard: VUs flat=8, iter/s giảm rõ rệt
  → Kết luận: external payment đang kéo checkout xuống → BLOCK hoặc điều tra

Trường hợp B (constant-arrival-rate — CHE vấn đề):
  k6 cố bơm 5 checkout/s
  external chậm → queue đầy → drop request hoặc queue overflow
  → Dashboard: RPS vẫn ~5/s (do arrival-rate ép)
  → Tưởng checkout vẫn OK, nhưng thực tế queue đang vỡ
  → KHÔNG kết luận được, test đánh lừa
```

**Vì sao closed model feedback quan trọng với checkout?**

```text
Checkout KHÔNG phải là "càng nhiều càng tốt".
Checkout là "mỗi lần phải thành công".

Nếu external payment chậm:
  - User thật sẽ bị treo ở màn hình thanh toán
  - Họ không "bơm thêm checkout" — họ ĐANG ĐỢI
  - Throughput tự nhiên giảm — đó là thực tế

constant-vus mô phỏng ĐÚNG hành vi này:
  VU đợi confirm xong mới bắt đầu checkout mới
  → loop_duration tăng → iter/s giảm

constant-arrival-rate mô phỏng SAI:
  K6 bơm checkout mới bất kể external đang chậm
  → queue đầy → drop hoặc system overload
  → Không phản ánh user thật
```

**Phân tích sâu: vì sao 3 executor "rate/job-based" không đảm bảo closed model?**

`constant-arrival-rate` với `rate: 5/s, duration: "5m"`:

```text
Công thức: k6 schedule 5 iteration start mỗi giây, bất kể backend state

Khi external payment bình thường (confirm ~100ms):
  iter_time = 1.5s (create 200ms + confirm 100ms + status 200ms + sleep 1s)
  VU cần: rate × iter_time = 5 × 1.5 = 7.5 → cần 8 VU → vừa đủ
  → Mọi thứ OK, không drop

Khi external payment chậm (confirm ~3000ms):
  iter_time = 4.4s (create 200ms + confirm 3000ms + status 200ms + sleep 1s)
  VU cần: rate × iter_time = 5 × 4.4 = 22 VU → nhưng chỉ có 8 VU!
  → maxVu=8 < 22 → k6 KHÔNG thể schedule đủ 5/s
  → 3.2 iteration bị DROP mỗi giây
  → Dashboard: RPS cố giữ nhưng drop rate tăng
  → CHE vấn đề: tưởng hệ thống vẫn nhận 5 checkout/s
    nhưng thực tế 3.2 checkout/s bị drop

Công thức thực tế:
  N_done = N_sched - N_drop
         = 5/s × 300s - N_drop
         = 1500 - N_drop

  N_drop phụ thuộc vào iter_time và maxVu:
    N_drop ≈ max(0, rate - maxVu/iter_time) × duration
          ≈ max(0, 5 - 8/4.4) × 300
          ≈ max(0, 5 - 1.82) × 300
          ≈ 3.18 × 300 ≈ 954 drop!

  → 1500 scheduled, ~954 drop, chỉ ~546 done
  → Nhưng learner nhìn RPS target 5/s vẫn "đạt" (do metric đo scheduled, không đo done)
  → CỰC KỲ NGUY HIỂM: test trông có vẻ pass nhưng thực tế ~954 checkout bị drop
```

`shared-iterations` với `vus: 8, iterations: 500`:

```text
Vấn đề 1: fixed count nghĩa là gì với checkout trickle?
  iterations=500 → test dừng sau 500 checkout, không quan tâm 5 phút
  → Nếu external nhanh: 500 checkout trong 94s, dừng sớm
  → Nếu external chậm: 500 checkout trong 370s, vượt duration mong muốn
  → Không trả lời được "trong 5 phút, throughput ra sao?"

Vấn đề 2: identity model sai
  shared-iterations: VU là worker, không có identity ổn định
  → VU=1 có thể làm checkout cho user A, rồi user B, rồi user C...
  → Idempotency key dựa trên iterationInTest (global job index)
  → Nhưng checkout trickle cần key dựa trên user identity (__VU) + attempt (__ITER)

Vấn đề 3: Không phát hiện được closed-model slowdown
  external chậm → iter_time tăng → T_run dài hơn
  → Nhưng vẫn 500 checkout → nhìn giống hệt run external nhanh
  → Sự khác biệt duy nhất: T_run (94s vs 370s) và latency
  → Learner dễ bỏ qua vì "iterations vẫn = 500, http_reqs vẫn đúng"
```

`per-vu-iterations` với `vus: 8, iterations: 60`:

```text
Vấn đề 1: mỗi VU chạy đúng 60 checkout → quota, không phải observation window
  → External nhanh: 60 checkout × 8 VU = 480, xong trong ~90s
  → External chậm: 60 checkout × 8 VU = 480, xong trong ~264s
  → Luôn 480 checkout, không thấy được throughput tự nhiên trong 5 phút

Vấn đề 2: VU nhanh xong sớm → idle
  → VU có network tốt: 60 checkout × 1.5s = 90s → idle 210s còn lại
  → Lãng phí observation window
  → Không giống "8 users checkout liên tục trong 5 phút"
```

**Trong khi đó với `constant-vus`**:

```text
Config: vus=8, duration=5m
T_run = 300s (LUÔN LUÔN)

Lần 1: external nhanh (confirm ~100ms)
  iter_time ≈ 1.5s
  iterations ≈ 300 / 1.5 × 8 = 1600
  iter/s ≈ 5.3

Lần 2: external chậm (confirm ~3000ms)
  iter_time ≈ 4.4s
  iterations ≈ 300 / 4.4 × 8 ≈ 545
  iter/s ≈ 1.8

Lần 3: external bình thường (confirm ~500ms)
  iter_time ≈ 1.9s
  iterations ≈ 300 / 1.9 × 8 ≈ 1263
  iter/s ≈ 4.2

→ Duration CỐ ĐỊNH ở 300s mỗi lần
→ Iterations THAY ĐỔI theo external latency → đó CHÍNH LÀ tín hiệu!
→ Run 1: 1600 checkout → external khỏe
→ Run 2: 545 checkout → external có vấn đề → BLOCK
→ Run 3: 1263 checkout → baseline bình thường
```

**Tóm tắt 4 executor về checkout trickle**:

| Executor | Duration cố định? | Throughput tự nhiên? | Phát hiện external slowdown? | Identity model đúng? |
| --- | --- | --- | --- | --- |
| **constant-vus** | CÓ (duration) | CÓ (output) | CÓ (iter/s giảm) | CÓ (VU = user) |
| constant-arrival-rate | CÓ | KHÔNG (ép rate) | KHÔNG (drop thay vì giảm) | KHÔNG (rate-driven) |
| shared-iterations | KHÔNG (count-driven) | KHÔNG (đếm job) | MỘT PHẦN (chỉ T_run) | KHÔNG (VU = worker) |
| per-vu-iterations | KHÔNG (count-driven) | KHÔNG (đếm quota) | MỘT PHẦN (chỉ T_run) | CÓ (VU = user) |

→ Chỉ **constant-vus** thỏa mãn: duration cố định + throughput là output tự nhiên + phát hiện external slowdown qua iter/s + VU là user identity ổn định.

#### Yêu cầu (b): CORRECT IDEMPOTENCY KEY (mỗi lần confirm là duy nhất)

**Ý nghĩa**: Mỗi lần user nhấn "confirm order" phải có idempotency key KHÁC NHAU. Nếu 2 lần confirm dùng trùng key, payment provider có thể:
- Từ chối (coi là duplicate)
- Trả về kết quả cached của lần trước (sai order state)
- Trigger fraud detection (nghi ngờ replay attack)

**Bug idempotency key là gì?**

```text
Trường hợp ĐÚNG — key từ __VU + __ITER (constant-vus pattern):
  VU=1, __ITER=0 → idem-1-0 (checkout lần 1 của user 1)
  VU=1, __ITER=1 → idem-1-1 (checkout lần 2 của user 1)
  VU=2, __ITER=0 → idem-2-0 (checkout lần 1 của user 2)
  ...
  → Mỗi lần confirm là UNIQUE, không trùng

Trường hợp SAI — key từ iterationInTest (shared-iterations pattern):
  VU=1 lấy job #0 → idem-0
  VU=2 lấy job #1 → idem-1
  ...
  Nhưng: trong constant-vus, iterationInTest không phải job index cố định
  → Có thể VU=1 __ITER=5 và VU=2 __ITER=5 cùng map ID giống nhau
  → Hoặc: iterationInTest reused nếu dùng global counter sai cách
```

**Vì sao key pattern khác nhau giữa 2 executor?**

```text
Trong shared-iterations (catalog audit):
  Key = idem-${exec.scenario.iterationInTest}
  → Mỗi JOB là một checkout riêng biệt
  → 80 job = 80 key unique, mỗi key dùng 1 lần
  → iterationInTest là global job index, tăng từ 0→79

Trong constant-vus (checkout trickle):
  Key = idem-${__VU}-${__ITER}
  → Mỗi VU là một USER riêng biệt
  → User 1 checkout lần 1, lần 2, lần 3... → key tăng theo __ITER
  → __VU ổn định (user identity), __ITER tăng (attempt counter)
  → iterationInTest KHÔNG dùng được vì:
    - Nó là global loop counter, không gắn với user identity
    - User 1 loop #5 và user 2 loop #5 là 2 checkout KHÁC NHAU
    - Dùng iterationInTest: 2 user khác nhau có thể trùng key nếu __ITER bằng nhau
```

**Demo bug: dùng sai key pattern**

```text
Script SAI — dùng iterationInTest trong constant-vus:
  const idemKey = `idem-${exec.scenario.iterationInTest}`;

  VU=1, __ITER=5: iterationInTest có thể = 37 → key = idem-37
  VU=2, __ITER=5: iterationInTest có thể = 42 → key = idem-42
  → Lần này không trùng, nhưng...

  Vấn đề thực sự: iterationInTest trong constant-vus là GLOBAL LOOP COUNTER
  Nó không đảm bảo uniqueness theo user.
  Nếu VU=1 chạy nhanh, VU=8 chạy chậm:
    VU=1 confirm lần 10 → iterationInTest = 75
    VU=8 confirm lần 1  → iterationInTest = 76
  → Key không có ý nghĩa business (không biết là user nào, lần thứ mấy)

  Quan trọng hơn: nếu dùng iterationInTest, payment provider
  thấy key nhảy lung tung cho cùng một user → nghi ngờ fraud
```

---

## Yêu cầu cứng của case này

- Giữ 8 active checkout users trong 5m.
- Mỗi flow cần create/confirm/status.
- Không ép fixed checkout RPS; natural throughput là output.
- Failed loops phải dưới `constant_active_iterations_failed count<10`.

Các invariant chung:

```text
vus + duration = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì RPS giảm
```

Do đó không được fail test chỉ vì `iterations` không bằng một số target tưởng tượng.

### Yêu cầu cứng bổ sung cho checkout

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Mỗi checkout loop phải có create + confirm + status | Thiếu status read → không chứng minh được final order state |
| Idempotency key phải unique mỗi lần confirm | Trùng key → payment provider từ chối hoặc trả cached |
| Key derive từ `__VU` + `__ITER` | __VU là user identity ổn định, __ITER là attempt counter |
| KHÔNG derive key từ `iterationInTest` | iterationInTest là global loop counter, không phải per-user attempt |
| `constant_active_iterations_failed count<10` | Mỗi failed loop = một đơn hàng thất bại, business impact cao |
| Status GET phải pass check | Confirm 200 chưa đủ — cần verify order state qua status |

---

## Vì sao "Checkout trickle" nên dùng `constant-vus`?

Checkout trickle là low steady concurrency. `constant-vus` đúng vì ta muốn thấy closed-model behavior khi order/external latency thay đổi.

Mental model:

```text
8 active VUs start.
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

### Mental model mở rộng: VU là quầy thanh toán, không phải worker trong kho

```text
shared-iterations (catalog audit):
  VU = công nhân trong kho, ai nhanh thì bốc nhiều thùng
  Job identity = iterationInTest (global job index)
  Không có per-VU state

constant-vus (checkout trickle):
  VU = quầy thanh toán cố định, mỗi quầy phục vụ khách liên tục
  User identity = __VU (quầy số mấy)
  Attempt counter = __ITER (khách thứ mấy trong ngày ở quầy này)
  Có per-VU state: idempotency key tăng theo __ITER của chính VU đó
```

## Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho case steady active users? |
| --- | --- | --- |
| `constant-vus` | Giữ N active users trong duration T | **Đúng**: input chính là concurrency + observation window; throughput là output tự nhiên. |
| `shared-iterations` | Cũng có nhiều VU cùng làm việc | Sai nếu không có backlog hữu hạn cần drain đủ; nó tối ưu fixed total jobs, không phải active users over time. |
| `per-vu-iterations` | VU có thể là user identity ổn định | Sai nếu không cần mỗi user chạy đúng N vòng; nó biến test thành quota replay, không phải steady active pool. |
| `constant-arrival-rate` | Có thể giữ RPS cố định | Sai nếu muốn quan sát closed-model backpressure; arrival-rate sẽ cố bơm traffic theo rate. |
| `ramping-vus` | Mô phỏng user tăng/giảm | Sai nếu requirement là active concurrency phẳng để lấy baseline. |
| `ramping-arrival-rate` | Mô phỏng campaign/surge | Sai cho steady baseline; nó thay đổi target arrivals theo thời gian. |

Kết luận cho case này:

```text
Need fixed active users over time -> constant-vus.
Need fixed total jobs -> shared-iterations, not this case.
Need fixed per-user quota -> per-vu-iterations, not this case.
Need fixed RPS -> constant-arrival-rate, not this case.
```

---

## 4 nguyên nhân kỹ thuật case này phát hiện

### Nguyên nhân kỹ thuật 1: External latency reduces natural throughput

Checkout/confirm có external_ms. Khi external chậm, mỗi loop lâu hơn và checkout RPS giảm tự nhiên.

**Demo trace: external payment từ nhanh → chậm**

```text
Baseline — external payment bình thường (confirm ~100ms):
  VU=1: create(200ms) → confirm(100ms) → status(200ms) → sleep(1s)
  loop_duration = 1.5s
  VU=1 làm được: 300s / 1.5s = 200 loops
  8 VU: iter/s ≈ 8 / 1.5 ≈ 5.3/s
  Total iterations ≈ 1600

External payment chậm (confirm ~3000ms):
  VU=1: create(200ms) → confirm(3000ms) → status(200ms) → sleep(1s)
  loop_duration = 4.4s
  VU=1 làm được: 300s / 4.4s ≈ 68 loops
  8 VU: iter/s ≈ 8 / 4.4 ≈ 1.8/s
  Total iterations ≈ 545

→ iter/s giảm từ 5.3 → 1.8 (~66% drop)
→ ĐÂY LÀ TÍN HIỆU ĐÚNG: external payment đang kéo checkout xuống
→ Hành động: BLOCK, điều tra external payment provider

Nếu dùng constant-arrival-rate rate=5/s trong tình huống này:
  iter_time = 4.4s, cần 22 VU để giữ 5/s, chỉ có 8 VU
  → 3.2 iteration/s bị drop
  → Dashboard vẫn show arrival rate = 5/s
  → CHE vấn đề — không thấy external đang chậm!
```

**Công thức định lượng**:

```text
loop_duration = T_create + T_confirm + T_status + T_sleep + T_js

T_confirm = T_order_service + T_external_payment
          ≈ T_base + external_ms

Khi external_ms tăng:
  loop_duration tăng
  per_vu_loop_rate = 1 / loop_duration giảm
  iter/s = vus × per_vu_loop_rate giảm

Mối quan hệ:
  Δiter/s ≈ -vus × (Δexternal_ms) / (loop_duration²)
```

### Nguyên nhân kỹ thuật 2: Idempotency key uniqueness

Mỗi logical checkout/confirm attempt cần idempotency key riêng để tránh replay/collision.

**Demo trace: idempotency key collision**

```text
Scenario: external payment chậm, user nhấn "confirm" lại

Dùng key ĐÚNG — idem-${__VU}-${__ITER}:
  VU=3, __ITER=7: key = idem-3-7
    confirm gửi đi, external chậm (3s)
    VU=3 vẫn đợi, không gửi lại
    → 1 key, 1 attempt, không collision ✓

  VU=3, __ITER=8: key = idem-3-8
    checkout mới, key mới
    → Mỗi lần confirm là duy nhất ✓

Dùng key SAI — idem-${iterationInTest}:
  VU=3 đang chạy iterationInTest=42 → key = idem-42
  Nhưng VU=7 trước đó cũng đã dùng key = idem-42 khi chạy iterationInTest=42!
  → COLLISION: 2 user khác nhau dùng cùng key
  → Payment provider: "duplicate request" → từ chối hoặc trả kết quả cũ
  → Order của VU=3 có thể bị: từ chối sai, hoặc nhận state của order cũ
```

**Vì sao pattern constant-vus khác shared-iterations?**

```text
shared-iterations pattern:
  key = idem-${exec.scenario.iterationInTest}
  → 80 jobs = 80 keys, mỗi key dùng ĐÚNG 1 lần
  → iterationInTest tăng từ 0→79, không VU nào dùng lại key cũ
  → Phù hợp vì: mỗi job là một checkout ĐỘC LẬP

constant-vus pattern:
  key = idem-${__VU}-${__ITER}
  → 8 users, mỗi user checkout nhiều lần
  → User 1: idem-1-0, idem-1-1, idem-1-2...
  → User 2: idem-2-0, idem-2-1, idem-2-2...
  → KHÔNG dùng iterationInTest vì:
    - Nó là global loop counter, không gắn với user
    - iterationInTest=42 có thể là VU=3 lần 7 hoặc VU=7 lần 3
    - 2 user khác nhau không nên dùng chung key
```

### Nguyên nhân kỹ thuật 3: POST 200 is not enough

Create/confirm 200 chưa chứng minh final order state; status read là part of user-visible flow.

**Demo trace: confirm 200 nhưng status fail**

```text
Flow mỗi checkout loop:
  1. POST /api/sim/checkout         → expect 200 (order created)
  2. POST /api/sim/orders/:id/confirm → expect 200 (payment confirmed)
  3. GET  /api/sim/orders/:id        → expect 200 + status = "confirmed"

Nếu confirm trả 200 nhưng payment provider async fail sau đó:
  - Confirm response: HTTP 200, body: {"status": "processing"}
  - Payment provider xử lý async → FAIL (insufficient funds, timeout...)
  - Order state chuyển từ "processing" → "failed"
  - Status GET: HTTP 200, body: {"status": "failed"}

Nếu script CHỈ check HTTP status:
  create 200 ✓
  confirm 200 ✓
  status 200 ✓ (vì HTTP vẫn 200!)
  → Loop "pass", nhưng order thực tế FAILED

Nếu script check BOTH HTTP status AND body status:
  create 200 ✓
  confirm 200 ✓
  status 200 + body.status == "confirmed" → FAIL (body.status = "failed")
  → Loop FAIL → constant_active_iterations_failed tăng
  → Phát hiện được async inconsistency ✓
```

**Check pattern đúng cho status verification**:

```js
const statusRes = http.get(`${BASE_URL}/api/sim/orders/${orderId}`);
check(statusRes, {
  "status HTTP 200": (r) => r.status === 200,
  "order state confirmed": (r) => {
    const body = JSON.parse(r.body);
    return body.status === "confirmed" || body.status === "completed";
  },
});
```

### Nguyên nhân kỹ thuật 4: Avoid unrealistic forced checkout RPS

Arrival-rate có thể bơm thêm checkouts khi service chậm; constant-vus giữ model active users thực tế hơn.

**Demo trace: arrival-rate che giấu external slowdown**

```text
Tình huống: external payment provider chậm (confirm 100ms → 3000ms)

constant-vus (vus=8, duration=5m):
  Trước khi external chậm: iter/s ≈ 5.3
  Khi external chậm:       iter/s ≈ 1.8
  → Dashboard: VUs flat=8, iter/s giảm RÕ RỆT
  → Operator thấy ngay: "có vấn đề với checkout"
  → Hành động: điều tra external payment

constant-arrival-rate (rate=5, duration=5m, maxVu=8):
  Trước khi external chậm: iter/s ≈ 5.0 (đúng target)
  Khi external chậm:
    iter_time = 4.4s, cần 22 VU, chỉ có 8
    → 3.2 drop/s
    → Dashboard: RPS vẫn ~5/s (target), nhưng drop rate tăng
    → Operator thấy: "RPS ổn, chắc OK"
    → THỰC TẾ: ~65% checkout bị drop, external đang chậm
  → CHE VẤN ĐỀ, không phát hiện được

So sánh trực quan:
  constant-vus:           "8 quầy, khách tự đến, xem 5 phút được bao nhiêu"
  constant-arrival-rate:  "phải phục vụ đúng 5 khách/phút, nhồi thêm quầy nếu cần"
  → Nếu quầy chậm (external chậm), cách 1 cho thấy giảm, cách 2 che đi
```

---

## Identity model chi tiết: `__VU` vs `__ITER` vs `iterationInTest` trong constant-vus

Đây là điểm quan trọng nhất khi code constant-vus script cho checkout trickle. Ba khái niệm khác với shared-iterations:

```text
__VU:
  - User identity ổn định, từ 1 đến vus
  - VU=1 LUÔN là "user 1", VU=2 LUÔN là "user 2"
  - Dùng làm user_id trong tag, idempotency key prefix
  - Khác shared-iterations: ở đó __VU là worker, không phải user

__ITER:
  - Local loop counter của từng VU, bắt đầu từ 0
  - VU=1: __ITER=0 (checkout lần 1), __ITER=1 (checkout lần 2)...
  - Dùng làm attempt counter trong idempotency key
  - KHÔNG phải global counter — VU=1 __ITER=5 và VU=2 __ITER=5 là 2 checkout KHÁC NHAU

exec.scenario.iterationInTest:
  - Global loop counter toàn scenario
  - KHÔNG dùng làm business identity trong constant-vus
  - Nó chỉ có ý nghĩa thống kê (đếm tổng số vòng đã chạy)
  - Khác shared-iterations: ở đó nó LÀ business identity chính
```

**Demo trace identity model với 3 VU trong constant-vus**:

```text
Config: vus=3, duration=30s (để dễ trace)

t=0.0s   3 VU cùng start
         VU=1: __VU=1, __ITER=0, iterationInTest=0
               → User 1, checkout lần 1
               → idempotency key = idem-1-0
         VU=2: __VU=2, __ITER=0, iterationInTest=1
               → User 2, checkout lần 1
               → idempotency key = idem-2-0
         VU=3: __VU=3, __ITER=0, iterationInTest=2
               → User 3, checkout lần 1
               → idempotency key = idem-3-0

t=1.5s   VU=1 xong loop 1, bắt đầu loop 2:
         VU=1: __VU=1, __ITER=1, iterationInTest=3
               → User 1, checkout lần 2
               → idempotency key = idem-1-1

t=1.8s   VU=2 xong loop 1, bắt đầu loop 2:
         VU=2: __VU=2, __ITER=1, iterationInTest=4
               → User 2, checkout lần 2
               → idempotency key = idem-2-1

... tiếp tục đến t=30s

Tổng kết (giả sử iter_time đều = 1.5s):
  VU=1: __ITER=0..19 (20 checkouts), idem-1-0 đến idem-1-19
  VU=2: __ITER=0..19 (20 checkouts), idem-2-0 đến idem-2-19
  VU=3: __ITER=0..19 (20 checkouts), idem-3-0 đến idem-3-19
  Total iterations = 60
  iterationInTest: 0..59 (global loop counter)

Code đúng:
  const idemKey = `idem-${__VU}-${__ITER}`;
  // User 1: idem-1-0, idem-1-1, idem-1-2...
  // Mỗi lần checkout là unique, gắn với user + attempt

Code sai:
  const idemKey = `idem-${exec.scenario.iterationInTest}`;
  // idem-0, idem-1, idem-2...
  // Không biết là user nào, lần thứ mấy
  // iterationInTest=3: có thể là User 1 lần 2 hoặc User 2 lần 1
```

### Vì sao constant-vus CÓ per-VU state hữu ích?

Trong shared-iterations, per-VU state không hữu ích vì mỗi VU xử lý nhiều job khác nhau.

Trong constant-vus, per-VU state CÓ Ý NGHĨA:

```text
VU=1 LUÔN là user 1:
  - Idempotency key prefix: idem-1-*
  - __ITER tăng dần → key tăng dần
  - Có thể giữ session token riêng (nếu cần)
  - Có thể giữ user profile/preferences riêng

VU=2 LUÔN là user 2:
  - Idempotency key prefix: idem-2-*
  - Mỗi loop là một checkout MỚI của CÙNG user này
  - Không liên quan gì đến checkout của user 1
```

---

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
CV_04_VUS = 8
CV_04_DURATION = 5m
CV_04_SLEEP_SECONDS = 1
```

| Config/env | Giá trị | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `CV_04_VUS` | 8 | Số checkout users active |
| `CV_04_DURATION` | 5m | Observation window |
| `CV_04_SLEEP_SECONDS` | 1 | Think time giữa checkout attempts |

Threshold cap riêng:

```text
constant_active_iterations_failed: count<10
```

Mapping quan trọng cho checkout trickle:

```text
active users             = 8 VUs
observation window       = 5m (300s)
think time               = 1s
expected API per loop    = 3 (create + confirm + status)
natural throughput       = OUTPUT (không config)
idempotency key pattern  = idem-${__VU}-${__ITER}
```

---

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

### So sánh identity model: constant-vus vs shared-iterations

| Tiêu chí | constant-vus (checkout trickle) | shared-iterations (catalog audit) |
| --- | --- | --- |
| VU là gì? | User identity ổn định (quầy thanh toán) | Worker generic (công nhân kho) |
| `__VU` dùng làm gì? | User ID, key prefix | KHÔNG dùng (chỉ là worker ID) |
| `__ITER` dùng làm gì? | Attempt counter của user đó | KHÔNG dùng (local counter vô nghĩa) |
| `iterationInTest` dùng làm gì? | Global stat (không dùng làm identity) | Business identity CHÍNH (SKU index) |
| Per-VU state? | CÓ (idempotency prefix, session) | KHÔNG (mỗi job khác nhau) |
| Key pattern | `idem-${__VU}-${__ITER}` | `idem-${iterationInTest}` |

---

## Service/API flow

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| checkout_trickle_create | order-service | POST | /api/sim/checkout | 200 | Create checkout/order. |
| checkout_trickle_confirm | order-service | POST | /api/sim/orders/:id/confirm | 200 | Confirm order with idempotency key. |
| checkout_trickle_status | order-service | GET | /api/sim/orders/:id | 200 | Read final order status. |

Các operation này phải được đọc bằng tag `operation`, vì aggregate metrics có thể che branch nhỏ nhưng chậm.

### Flow logic từng loop

```text
1. create checkout:
   POST /api/sim/checkout
   Body: { user_id, cart_id, ... }
   Response: { order_id, status: "created" }
   → Lưu order_id cho bước sau

2. confirm order:
   POST /api/sim/orders/${order_id}/confirm
   Header: Idempotency-Key: idem-${__VU}-${__ITER}
   Body: { payment_method, ... }
   Response: { status: "processing" hoặc "confirmed" }
   → External payment được gọi trong bước này

3. read status:
   GET /api/sim/orders/${order_id}
   Response: { status: "confirmed" | "failed" | "processing" }
   → Check: HTTP 200 VÀ body.status == "confirmed"
   → Đây là bước QUAN TRỌNG NHẤT để xác nhận order thực sự thành công
```

---

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

Tags chung:

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `cv-03-active-cart-editing`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service được gọi. |
| `operation` | Operation cụ thể trong user loop. |
| `endpoint` | Nhóm endpoint/API family. |
| `user_id` | Active user identity derive từ VU/user context. |
| `executor_family` | `constant_vus`. |
| `workload_shape` | `steady_concurrency`. |

Tags case này:

```text
case_id       = cv-04-checkout-trickle
business_case = checkout_trickle
workload      = steady_concurrency
```

### Cách đọc metric theo operation cho case này

```text
Tách theo operation để phát hiện bottleneck ẩn:

checkout_trickle_create:
  - Count: số lần tạo checkout
  - http_req_duration: latency của order creation
  - http_req_failed: có fail ở bước tạo order không?

checkout_trickle_confirm:
  - Count: số lần confirm (có thể ít hơn create nếu create fail)
  - http_req_duration: latency của confirm (BAO GỒM external payment)
  - http_req_failed: external payment fail?
  - Đây thường là operation CHẬM NHẤT (external dependency)

checkout_trickle_status:
  - Count: số lần đọc status (có thể ít hơn confirm nếu confirm fail)
  - http_req_duration: latency của status read
  - checks passed: body.status có phải "confirmed" không?
```

---

## Pass criteria

Pass criteria tối thiểu theo backend script:

```text
checks rate > 0.99
http_req_failed rate < 0.01
constant_active_iterations_failed count<10
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

### Pass criteria bổ sung cho checkout

```text
Operation counts sanity:
  checkout_trickle_create count ≈ checkout_trickle_confirm count
  (Mỗi create nên có một confirm; chênh lệch nhỏ có thể do loop đang chạy dở)

  checkout_trickle_confirm count ≈ checkout_trickle_status count
  (Mỗi confirm nên có một status read)

Status verification:
  checks{"check":"order state confirmed"} rate > 0.99
  (Xác nhận order thực sự confirmed, không chỉ HTTP 200)

Idempotency:
  Không có HTTP 409 Conflict từ confirm (trùng key)
  Nếu có 409 → key pattern sai
```

---

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-04-checkout-trickle.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-04-checkout-trickle.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-04-checkout-trickle.js
```

---

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = constant-vus
vus = 8 hoặc env override
duration = 5m hoặc env override
```

### Bước 2 — Verify active-user model

Summary/dashboard nên thể hiện VUs giữ gần configured VUs trong regular phase.

Nếu VUs không flat, kiểm config/ingestion trước khi kết luận backend.

### Bước 3 — Check failures trước throughput

Đọc trước:

```text
checks
http_req_failed
constant_active_iterations_failed
```

Nếu các metric này fail, xử lý correctness/failure trước khi bàn RPS.

**Case-specific: thứ tự ưu tiên khi có failure**

```text
1. constant_active_iterations_failed > 0:
   → Có loop checkout thất bại → business impact CAO
   → Lọc theo operation để tìm bước nào fail:
     - create fail → order service down?
     - confirm fail → external payment down?
     - status fail → order state inconsistency?
   → Mỗi failed loop = một đơn hàng mất → ưu tiên cao nhất

2. http_req_failed > 0:
   → Có HTTP failure → network/protocol issue
   → Lọc theo operation + status code

3. checks rate < 1:
   → Status verification fail → confirm 200 nhưng order state không confirmed
   → Đây là async inconsistency → RẤT NGUY HIỂM
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
```

**Case-specific: phân tích iterations thấp**

```text
Nếu iterations thấp hơn baseline:
  1. Check constant_flow_duration_ms — có tăng không?
     → Nếu tăng: backend/external chậm → closed-model feedback (TỐT)
     → Nếu không tăng: sleep/config thay đổi?

  2. Check http_req_duration theo operation:
     → checkout_trickle_confirm tăng? → external payment chậm
     → checkout_trickle_create tăng? → order service chậm
     → checkout_trickle_status tăng? → read path chậm

  3. Check constant_sleep_seconds:
     → Có khớp configured sleep không?
     → Nếu cao hơn: script có thêm delay không mong muốn?

  4. So sánh iterations giữa các VU:
     → Trong constant-vus, VU nào cũng loop liên tục
     → Nếu một VU có iterations thấp hơn hẳn: VU đó bị kẹt?
     → Khác shared-iterations: ở đó VU nhanh làm nhiều hơn là bình thường
```

### Bước 5 — Interpret duration/throughput

Đọc:

```text
constant_flow_duration_ms
iteration_duration
http_req_duration by operation
```

Case-specific notes:

- `http_reqs` nên đọc tương quan với 3 operations/flow.
- `constant_flow_duration_ms` tăng thường do create/confirm external latency.
- Failed loops ở checkout thường nghiêm trọng hơn browse fail vì ảnh hưởng order/payment.

**Case-specific: tương quan giữa các operation**

```text
Expected relationship:
  http_req_duration confirm > http_req_duration create
  http_req_duration confirm > http_req_duration status
  (Vì confirm có external payment, chậm nhất)

Nếu create > confirm:
  → Order service tạo order chậm bất thường
  → Có thể do DB write lock, validation chậm

Nếu status > confirm:
  → Read path chậm hơn write path (bất thường)
  → Có thể do thiếu index, query chậm

constant_flow_duration_ms ≈ sum(http_req_duration) + sleep + JS overhead
  → Dùng để validate script không bị bottleneck ở JS
```

---

## Đọc dashboard real-time charts cho case 04

> Phần này mô tả cách đọc expected dashboard. Chỉ thêm run ID/số p95/bucket thật sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? | Total iterations target, vì không có target đó |
| Execution timeline | VUs/RPS/iter/s thay đổi theo time thế nào? | Business branch nào chậm nếu không lọc operation |
| VUs vs iter/s | VUs có flat không, iter/s có giảm không? | Fixed RPS target, vì constant-vus không config RPS |

### Chart 1 — Response time

Đọc theo `operation`:

```text
checkout_trickle_create: POST /api/sim/checkout
checkout_trickle_confirm: POST /api/sim/orders/:id/confirm
checkout_trickle_status: GET /api/sim/orders/:id
```

Cách đọc:

```text
http_req_duration       = latency từng request
constant_flow_duration_ms = latency full user loop
iteration_duration      = duration vòng default(), thường bao gồm sleep
```

Đừng dùng aggregate p95 một mình trong mixed/multi-operation flow.

Case-specific hints:

- Response time: create vs confirm vs status phải tách.
- Execution timeline: flat VUs + lower iter/s = checkout/order slowdown.
- VUs vs iter/s: dips có thể tương ứng external dependency latency.

#### Cách phân tích sâu chart Response time cho checkout trickle

Khi nhìn chart này, đừng chỉ nhìn "cao/thấp". Hãy đọc theo 4 câu hỏi:

```text
1. Operation nào chậm nhất? (thường là confirm — external payment)
2. Confirm latency có tăng theo thời gian không? (external degradation)
3. Create vs confirm gap có ổn định không? (nếu gap tăng → external chậm dần)
4. Status latency có bất thường không? (read-after-write consistency)
```

Với case 04, shape đẹp thường có:

```text
đầu run:  p95 confirm có thể cao hơn create/status (external call)
giữa run: p95 ổn định, confirm > create > status (expected ranking)
cuối run: p95 không tăng bất thường (không degradation)
```

Expected latency ranking:

```text
p95(confirm) > p95(create) > p95(status)

Lý do:
  - confirm: external payment call (~100-500ms extra)
  - create: order creation + DB write
  - status: simple read query

Nếu ranking bị đảo:
  - create > confirm → order service có vấn đề
  - status > create → read path bất thường (thiếu index?)
```

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 confirm tăng dần theo thời gian | External payment degradation | Điều tra external provider |
| p95 confirm spike đột ngột | External payment timeout/retry | Kiểm external health |
| p95 create và confirm cùng tăng | Order service chậm (không phải external) | Điều tra order-service |
| p95 status tăng nhưng create/confirm ổn | Read path vấn đề (index, cache) | Điều tra read query |
| p95 confirm = p95 create (gần bằng) | External payment không được gọi? | Kiểm script/config |
| Aggregate p95 đẹp nhưng một operation xấu | Bottleneck bị aggregate che | Luôn tách theo operation |

### Chart 2 — Execution timeline

Với constant-vus:

```text
VUs should be flat near 8 during regular phase.
iterations/http_reqs per bucket are observed outputs.
RPS depends on loop duration + API mix + sleep.
```

Nếu thấy:

```text
VUs flat nhưng RPS/iter/s giảm
```

thì đọc là:

```text
closed-model slowdown/backpressure
```

không đọc là:

```text
k6 không bơm đủ target RPS
```

vì không có target RPS trong constant-vus.

#### Cách phân tích sâu chart Execution timeline

Chart này trả lời câu hỏi khác hẳn Response time:

```text
Response time chart:
  "request nhanh/chậm thế nào?"

Execution timeline:
  "tại mỗi giây, 8 users đã checkout được bao nhiêu lần?
   Có giây nào RPS tụt bất thường không?"
```

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs — 8 users có luôn active không?
2. HTTP reqs mỗi bucket — bao nhiêu request hoàn thành trong giây đó?
3. Iterations hoàn thành mỗi bucket — bao nhiêu checkout loop xong trong giây đó?
```

Với `constant-vus`, shape "đẹp" thường là:

```text
đầu run:
  Live VUs = 8 (setup/init xong)
  RPS thấp trong 1-2 bucket đầu (loop đầu chưa xong)
  Sau đó RPS ổn định

giữa run:
  Live VUs = 8, phẳng
  RPS/iter/s dao động nhẹ theo loop completion timing
  http_reqs mỗi bucket ≈ iter/s × 3 (3 API/loop)

cuối run:
  Live VUs = 8 (vẫn active đến khi duration hết)
  RPS có thể dao động do gracefulStop
  Sau duration: VUs → 0
```

Điểm khác với shared-iterations:

```text
shared-iterations:
  VUs tụt ở cuối vì backlog hết → VU idle
  Test dừng khi iterations đạt quota

constant-vus:
  VUs GIỮ NGUYÊN 8 suốt duration
  Test dừng khi duration hết (KHÔNG quan tâm iterations)
  → Shape VUs: phẳng từ đầu đến cuối
  → Nếu VUs tụt trước khi hết duration → VẤN ĐỀ
```

Invalid patterns:

| Pattern | Nghĩa |
| --- | --- |
| VUs không flat (tụt giữa chừng) | VU bị kẹt hoặc crash, config sai |
| VUs flat nhưng iter/s = 0 kéo dài | Tất cả VU bị kẹt trong request → backend treo |
| VUs flat, iter/s giảm dần | Closed-model slowdown (external chậm dần) |
| http_reqs mỗi bucket << iter/s × 3 | Có operation bị skip hoặc fail trước khi hoàn tất |
| RPS spike rồi tụt về 0 | Burst rồi tất cả VU cùng đợi (sleep đồng bộ) |

#### Batch 1 giây / time bucket

Mỗi point trên chart là 1 time bucket gom tất cả metric samples trong cùng 1 giây:

```text
01:09:19
→ mọi sample có timestamp trong khoảng 01:09:19.000 -> 01:09:19.999
→ được gom vào chung 1 point trên chart
```

Trong 1 bucket đó có thể có:

```text
- 8 VU cùng chạy (mỗi VU đang ở 1 bước khác nhau trong checkout flow)
- Nhiều HTTP request hoàn thành (cả create + confirm + status)
- Một số iteration/loop hoàn thành
- Nhiều check pass/fail
```

#### Vì sao bucket đầu có thể có httpReqs > 0 nhưng iterations = 0?

```text
Bucket đầu: VU vừa start, request create đầu tiên đã xong
nhưng full loop (create + confirm + status + check) chưa hoàn tất

→ httpReqs > 0 (request-level metric đến sớm)
→ iterations = 0 (loop-level metric đến muộn hơn, cần full flow xong)
```

### Chart 3 — VUs vs iter/s

Chart này là trọng tâm của executor này.

Expected:

```text
VUs: flat near configured value
iter/s: dao động theo backend latency + think time + branch mix
```

Bad shapes:

| Shape | Nghĩa |
| --- | --- |
| VUs flat, iter/s slowly falling | Backend/flow duration tăng, closed-model backpressure |
| VUs not flat | Scenario/config/dashboard issue cần kiểm trước |
| iter/s spike/drop theo branch | Weighted branch hoặc dependency latency thay đổi |
| end-tail odd shape | duration/gracefulStop/end bucket effect |

#### Cách phân tích sâu chart VUs vs iter/s

Chart này trả lời câu hỏi:

```text
8 active users checkout được bao nhiêu lần mỗi giây?
Khi external chậm, iter/s có giảm không? (closed-model feedback)
```

Với `constant-vus`, đường `Executor VUs` và `Actual iter/s` có quan hệ:

```text
peak_rate ≈ vus / loop_duration
         ≈ 8 / loop_duration

Nếu loop_duration avg = 1.5s:
  peak_rate ≈ 8 / 1.5 ≈ 5.3 iter/s

Nếu loop_duration avg = 4.0s (external chậm):
  peak_rate ≈ 8 / 4.0 ≈ 2.0 iter/s
```

Shape mong đợi:

```text
- đầu run: iter/s có thể 0 trong 1-2 bucket (chưa loop nào xong)
- giữa run: iter/s dao động ổn định quanh 8/loop_duration
- cuối run: iter/s vẫn ổn định (VUs vẫn active đến hết duration)
- đường VUs: phẳng = 8 suốt duration
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| `Actual iter/s` đầu = 0, sau đó tăng | Loop đầu chưa hoàn tất | Bình thường |
| `Actual iter/s` dao động nhẹ theo bucket | Loop finish không đồng bộ | Bình thường |
| `Actual iter/s` giảm dần, VUs vẫn flat | Closed-model slowdown | Tín hiệu đúng — điều tra |
| `Actual iter/s` = 0 lâu trong khi VUs=8 | Tất cả VU bị kẹt trong request | Khẩn cấp — backend treo |
| `Actual iter/s` tăng đột biến | Nhiều loop cùng finish | Bình thường (batch effect) |
| VUs không flat (tụt) | VU crash hoặc config sai | Kiểm header/config |

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận failures/thresholds trước.
2. VUs vs iter/s xác nhận active-user pool có phẳng không.
3. Execution timeline cho thấy RPS/iter/s là output theo time.
4. Response time by operation tìm service/branch chậm.
5. Business decision dựa trên failures + latency + closed-model throughput change.
```

---

## Kết luận thực tế: output -> quyết định

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| create/confirm/status pass | Checkout trickle baseline acceptable | Accept |
| create pass but confirm fails | Order finalization issue | Block checkout release |
| status inconsistent | Read-after-write/order state issue | Inspect order state model |
| flow duration grows and iter/s drops | External/order latency | Investigate dependency |

### Kịch bản A — output sạch: CHECKOUT HEALTHY

```text
constant_active_iterations.........: ~1600 (ước lượng, tùy latency)
constant_active_iterations_failed..: 0
http_req_failed....................: 0.00%
checks..............................: 100%
checkout_trickle_create count.......: ≈ iterations
checkout_trickle_confirm count......: ≈ iterations
checkout_trickle_status count.......: ≈ iterations
constant_flow_duration_ms...........: p(95)≈1.8s

VUs chart: flat = 8 suốt 5m
iter/s chart: dao động ổn ~5.3/s
Response time: confirm > create > status (expected ranking)
```

Kết luận thực tế:

```text
- 0 failed loops → không đơn hàng nào thất bại
- Operation counts khớp → flow đầy đủ create/confirm/status
- VUs flat, iter/s ổn định → không có degradation
- Confirm latency trong ngưỡng → external payment ổn
=> QUYẾT ĐỊNH: Checkout baseline acceptable. Cho phép release.
```

### Kịch bản B — confirm fails (external down): BLOCK

```text
constant_active_iterations.........: ~1600 (VUs vẫn loop)
constant_active_iterations_failed..: ~1600 (TẤT CẢ loop fail!)
http_req_failed....................: 33% (confirm requests fail)
checks..............................: 67% (create pass, confirm fail)

checkout_trickle_create count.......: ~1600
checkout_trickle_confirm count......: ~1600 (vẫn gửi, nhưng fail)
checkout_trickle_status count.......: ~0 (không tới được bước status)

http_req_duration confirm...........: p(95)=30s (timeout)
```

Kết luận thực tế:

```text
- Create vẫn pass → order service OK
- Confirm fail toàn bộ → external payment DOWN
- Status không chạy → không có order nào confirmed
- 100% loop fail → checkout hoàn toàn không hoạt động
=> QUYẾT ĐỊNH: BLOCK release. External payment provider cần fix.
   KHÔNG thể release checkout khi external payment down.
```

### Kịch bản C — external slows → iter/s drops: INVESTIGATE

```text
constant_active_iterations.........: ~545 (thấp hơn baseline 1600)
constant_active_iterations_failed..: 0 (tất cả loop thành công, nhưng ít hơn)
http_req_failed....................: 0.00%
checks..............................: 100%

constant_flow_duration_ms...........: p(95)=4.5s (tăng từ 1.8s)
http_req_duration confirm...........: p(95)=3200ms (tăng từ 150ms)

VUs chart: flat = 8 (VUs vẫn active)
iter/s chart: giảm từ ~5.3 → ~1.8
```

Kết luận thực tế:

```text
- 0 failed loops → checkout vẫn hoạt động, chỉ chậm hơn
- Loop duration tăng 2.5x → external payment chậm
- iter/s giảm ~66% → ĐÂY LÀ TÍN HIỆU ĐÚNG của closed model
- Tất cả checkout thành công, nhưng throughput giảm
=> QUYẾT ĐỊNH: INVESTIGATE external payment provider.
   KHÔNG block nếu latency trong SLA.
   Nhưng nếu external tiếp tục chậm → user experience kém.
   Đây là giá trị của constant-vus: phát hiện sớm degradation
   mà arrival-rate executor có thể bỏ qua.
```

### Kịch bản D — status inconsistent (confirm 200 nhưng order failed): BLOCK

```text
constant_active_iterations.........: ~1600
constant_active_iterations_failed..: ~50 (3% loop fail)
http_req_failed....................: 0.00% (TẤT CẢ HTTP 200!)
checks..............................: 97%
  - "create HTTP 200": 100%
  - "confirm HTTP 200": 100%
  - "status HTTP 200": 100%
  - "order state confirmed": 97% ← CHỖ NÀY FAIL

checkout_trickle_create count.......: ~1600
checkout_trickle_confirm count......: ~1600
checkout_trickle_status count.......: ~1600
```

Kết luận thực tế:

```text
- HTTP đều 200 → nhìn qua tưởng mọi thứ OK
- Nhưng checks "order state confirmed" = 97% → 50 order không thực sự confirmed
- Confirm 200 nhưng payment provider async fail
- Status GET: HTTP 200 nhưng body.status = "failed"
=> QUYẾT ĐỊNH: BLOCK. Đây là async inconsistency — confirm trả 200
   nhưng order cuối cùng failed. Điều tra payment provider async flow.
   Nếu không có status check, test đã PASS (vì HTTP đều 200).
   Status verification đã CỨU bug này.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 0 fail, VUs flat, iter/s ổn định | Checkout baseline khỏe | Accept |
| Confirm fail (http_req_failed > 0) | External payment down | Block checkout release |
| iter/s giảm, VUs vẫn flat | External chậm, closed-model feedback | Investigate dependency |
| Status inconsistent (checks fail) | Async inconsistency | Inspect order state model |
| iter/s và http_reqs cùng giảm | Backend/external degradation | Điều tra theo operation |
| VUs không flat | Scenario/config issue | Kiểm config trước |
| Loop count thấp hơn baseline | Có thể OK nếu external chậm | So sánh flow_duration |

---

## Real run — default constant-vus baseline

Run verify qua local cloud/dashboard:

```text
Run ID: #75
Script: cv-04-checkout-trickle.js
Exit code: 0
summary_pushed: true
finish_status: 200
Config: 8 VUs, duration 5m, default sleep/env
```

### Summary chính

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes/checks_fails` | `6,168 / 0` |
| `http_req_failed_rate` | `0` |
| `iterations` | `2,056` |
| `iterations_rate` | `6.84/s` |
| `http_reqs` | `6,168` |
| `http_reqs_rate` | `20.51/s` |
| `vus_min/vus_max` | `8 / 8` |
| `constant_flow_duration_ms avg/med/p95/p99/max` | `168.93 / 166 / 200 / 248 / 433 ms` |
| `http_req_duration avg/med/p95/p99/max` | `56.17 / 68.97 / 89.76 / 108.64 / 237.50 ms` |

Request breakdown:

```text
checkout_trickle_confirm POST 200 count=2,056
checkout_trickle_create POST 200 count=2,056
checkout_trickle_status GET 200 count=2,056
```

### Đọc 3 chart dashboard cho run #75

**Chart 1 — Response time.** Checkout flow sạch: `http_req_duration` p95 ~89.76ms, p99 ~108.64ms; `constant_flow_duration_ms` p95 ~200ms. Create/confirm/status đều 200.

**Chart 2 — Execution timeline.** `iterations` sum 2,056, `http_reqs` sum 6,168 = 3×iterations. Operation counts create/confirm/status đều 2,056.

Dashboard/API bucket summary:

```text
iterations buckets: count=301, sum=2056, min=1.00, max=8.00
http_reqs buckets:  count=301, sum=6168, min=2.00, max=24.00
không có failed iteration buckets
```

**Chart 3 — VUs vs iter/s.** VUs flat đúng 8 trong 300 buckets. Iter/s bucket 1–8; các bucket thấp ở đầu/cuối là effect của loop completion và end-tail, không phải VU drop.

```text
vus buckets: count=300, min=8.00, max=8.00, avg=8.00
```

### Backend verdict

```text
PASS — không thấy vấn đề BE trong run này.
```

Không cần báo BE.

## "Nghịch lý" và misconceptions của constant-vus

Đừng dùng case này để claim max checkout RPS. Nó là steady low concurrency baseline.

Nhớ 3 câu:

```text
vus + duration = input
iterations/RPS = output
backend chậm -> RPS giảm là tín hiệu đúng của closed model
```

### Nghịch lý 1: "8 VUs nhỏ mà quan trọng?"

```text
"Chỉ có 8 users thôi mà? Sao không test 100 users cho hoành tráng?"

Trả lời: 8 VUs = 8 quầy thanh toán. Mỗi loop = một đơn hàng THẬT.
Nếu 1 loop fail = 1 đơn hàng mất = mất tiền THẬT.

So sánh:
  - Browse catalog: 1000 requests fail → user refresh lại → ít impact
  - Checkout fail: 1 request fail → mất 1 đơn hàng → impact CAO

→ "Nhỏ" về concurrency nhưng "LỚN" về business impact.
→ Mỗi failed loop trong checkout đáng quan tâm hơn 100 failed browse requests.

Hơn nữa: 8 users liên tục checkout trong 5 phút → ~1600 đơn hàng (nếu external nhanh)
→ Đủ lớn để phát hiện pattern failure, không cần 100 users.
```

### Nghịch lý 2: "External chậm → RPS giảm là TỐT?"

```text
"Ủa, RPS giảm là xấu mà? Sao lại nói là tín hiệu đúng?"

Trả lời: Có 2 cách RPS giảm:

Cách 1 — RPS giảm do VU chết/config sai (XẤU):
  VUs không flat, VU crash → RPS giảm
  → Test không valid, không kết luận được gì về backend

Cách 2 — RPS giảm do closed-model feedback (TỐT — đúng mục đích):
  VUs vẫn flat = 8, nhưng external chậm → loop lâu hơn → iter/s giảm
  → Test valid, phát hiện ĐÚNG vấn đề
  → Đây CHÍNH LÀ điều constant-vus được thiết kế để làm:
    backend chậm → throughput tự giảm → operator thấy vấn đề

Nếu dùng arrival-rate và thấy RPS không giảm khi external chậm:
  → ĐÓ MỚI LÀ XẤU: test đang CHE vấn đề
  → K6 đang drop request hoặc queue overflow
  → Operator tưởng mọi thứ OK vì "RPS vẫn đạt target"
```

### Nghịch lý 3: "Confirm 200 mà status fail?"

```text
"Confirm trả 200 OK rồi, sao status lại báo failed?
 Có phải bug của order service không?"

Trả lời: Đây là async inconsistency — không phải bug, là behavior thực tế.

Flow thực tế:
  1. Client gửi confirm → order service nhận, trả 200 "processing"
  2. Order service gửi request sang payment provider (ASYNC)
  3. Payment provider xử lý (có thể mất vài giây)
  4. Payment provider trả kết quả → order service update order state
  5. Client gọi status GET → đọc order state hiện tại

Nếu bước 3-4 fail (insufficient funds, timeout...):
  - Bước 1: confirm HTTP 200 (vì order service nhận request OK)
  - Bước 5: status HTTP 200 (vì GET thành công)
  - Nhưng body.status = "failed"
  → HTTP đều 200, nhưng order THỰC SỰ failed

Đây là lý do status verification QUAN TRỌNG:
  - Không chỉ check HTTP status (200)
  - Phải check body.status == "confirmed"
  - Nếu không có check này → test PASS trong khi order fail
```

---

## Checklist đọc biểu đồ case 04

Khi học sinh nhìn dashboard case 04, đọc theo thứ tự này:

```text
1. Overview KPI
   - constant_active_iterations_failed < 10?
   - http_req_failed < 1%?
   - checks > 99%?
   - "order state confirmed" check pass?

2. VUs vs iter/s chart (QUAN TRỌNG NHẤT)
   - VUs flat = 8 suốt 5m?
   - iter/s ổn định hay giảm dần?
   - Nếu iter/s giảm + VUs flat → closed-model signal
   - Nếu VUs không flat → config issue

3. Response time chart
   - Tách theo operation (create vs confirm vs status) chưa?
   - Confirm có phải operation chậm nhất không?
   - Confirm latency có tăng theo thời gian không?
   - Create/status latency có bất thường không?

4. Execution timeline
   - Live VUs = 8 suốt duration?
   - RPS/iter/s có ổn định không?
   - Có bucket nào RPS tụt đột ngột không?
   - http_reqs ≈ iter/s × 3? (3 API/loop)

5. Business decision
   - Tất cả thresholds pass?
   - constant_active_iterations_failed = 0 (hoặc < 10)?
   - Operation breakdown hợp lý (create ≈ confirm ≈ status)?
   - Status verification pass?
   - Nếu iter/s giảm: do external chậm (TỐT — phát hiện) hay do config sai?
```

Kết luận của run case 04 đang đúng nếu thấy:

```text
constant_active_iterations_failed < 10
http_req_failed < 1%
checks > 99%
VUs flat = 8 suốt 5m
iter/s ổn định (hoặc giảm có lý do — external chậm)
confirm p95 > create p95 > status p95 (expected ranking)
checkout_trickle_create count ≈ checkout_trickle_confirm count ≈ checkout_trickle_status count
executor = constant-vus
```

---

## Mở rộng

- Tăng `VUS` để xem service chịu active concurrency cao hơn ra sao.
- Tăng `DURATION` để biến case thành stability/soak ngắn.
- Tăng/giảm sleep để thấy think time tác động đến RPS.
- Thêm threshold theo `constant_flow_duration_ms` hoặc operation p95 nếu muốn biến baseline thành performance gate.

### Variation 1: Mô phỏng external payment fail rate

```powershell
$env:CV_04_EXTERNAL_FAIL_RATE = 0.05
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-04-checkout-trickle.js
```

Mô phỏng 5% external payment fail — quan sát xem confirm fail có propagate đúng không, status có nhất quán không.

Expected:
```text
constant_active_iterations_failed tăng (một số loop có confirm fail)
http_req_failed tăng (confirm requests fail)
checkout_trickle_status count < checkout_trickle_create count
→ Loop bị cắt ở bước confirm, không tới được status
```

### Variation 2: Tăng VUs để test higher concurrency

```powershell
$env:CV_04_VUS = 20
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-04-checkout-trickle.js
```

Từ 8 → 20 active checkout users. Quan sát:
- order service có scale không?
- external payment có bị rate limit không?
- iter/s có tăng tuyến tính không? (20/8 = 2.5x expected)

### Variation 3: Giảm sleep để thấy upper bound throughput

```powershell
$env:CV_04_SLEEP_SECONDS = 0.1
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-04-checkout-trickle.js
```

Sleep từ 1s → 0.1s. Loop duration giảm, iter/s tăng.
Dùng để estimate max checkout throughput với 8 users "không nghỉ".

```text
loop_duration ≈ API_time + 0.1s
iter/s ≈ 8 / loop_duration
→ Đây là upper bound throughput cho 8 concurrent users
```

### Variation 4: Thêm latency threshold thành performance gate

```js
export const options = {
  thresholds: {
    "http_req_duration{operation:checkout_trickle_confirm}": ["p(95)<2000"],
    "http_req_duration{operation:checkout_trickle_create}": ["p(95)<500"],
    "constant_flow_duration_ms": ["p(95)<3000"],
  },
};
```

Chuyển từ functional baseline sang performance gate. Nếu confirm p95 > 2s, test tự fail — không cần operator đọc dashboard.

### Variation 5: Multi-scenario — checkout trickle + storefront browse đồng thời

```js
scenarios: {
  checkout_trickle: {
    executor: "constant-vus",
    vus: 8,
    duration: "5m",
    exec: "checkoutFlow",
    tags: { case_id: "cv-04-checkout-trickle" },
  },
  storefront_browse: {
    executor: "constant-vus",
    vus: 20,
    duration: "5m",
    exec: "browseFlow",
    startTime: "10s",
    tags: { case_id: "cv-01-business-hours-storefront" },
  },
},
```

Mô phỏng production thực tế hơn: vừa có user browse, vừa có user checkout.
Quan sát tương tác giữa 2 workload trên cùng order service.

---

## Code pattern đúng cho checkout trickle với constant-vus

```js
import { check } from "k6";
import http from "k6/http";
import { sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";
const SLEEP_SECONDS = parseFloat(__ENV.CV_04_SLEEP_SECONDS || "1");

export const options = {
  scenarios: {
    checkout_trickle: {
      executor: "constant-vus",
      vus: parseInt(__ENV.CV_04_VUS || "8"),
      duration: __ENV.CV_04_DURATION || "5m",
      tags: {
        case_id: "cv-04-checkout-trickle",
        business_case: "checkout_trickle",
        executor_family: "constant_vus",
        workload_shape: "steady_concurrency",
      },
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    constant_active_iterations_failed: ["count<10"],
  },
};

export default function () {
  // === IDENTITY: VU = user, __ITER = attempt counter ===
  const userId = __VU;
  const attemptNum = __ITER;

  // Idempotency key: unique per user + attempt
  // KHÔNG dùng iterationInTest — nó là global loop counter, không gắn với user
  const idemKey = `idem-${userId}-${attemptNum}`;

  // === BƯỚC 1: Create checkout ===
  const createRes = http.post(`${BASE_URL}/api/sim/checkout`, JSON.stringify({
    user_id: `user-${userId}`,
    items: [{ sku: `SKU-${(userId * 7 + attemptNum) % 100}`, qty: 1 }],
  }), {
    headers: { "Content-Type": "application/json" },
    tags: { operation: "checkout_trickle_create", user_id: `user-${userId}` },
  });

  const createOk = check(createRes, {
    "create HTTP 200": (r) => r.status === 200,
  });

  if (!createOk) {
    // Create fail → loop fail, không tiếp tục confirm/status
    return;
  }

  const orderId = createRes.json("order_id");

  // === BƯỚC 2: Confirm order với idempotency key ===
  const confirmRes = http.post(`${BASE_URL}/api/sim/orders/${orderId}/confirm`,
    JSON.stringify({ payment_method: "card" }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idemKey,
      },
      tags: { operation: "checkout_trickle_confirm", user_id: `user-${userId}` },
    },
  );

  const confirmOk = check(confirmRes, {
    "confirm HTTP 200": (r) => r.status === 200,
  });

  if (!confirmOk) {
    // Confirm fail → loop fail, không đọc status
    return;
  }

  // === BƯỚC 3: Read status — VERIFY final order state ===
  const statusRes = http.get(`${BASE_URL}/api/sim/orders/${orderId}`, {
    tags: { operation: "checkout_trickle_status", user_id: `user-${userId}` },
  });

  check(statusRes, {
    "status HTTP 200": (r) => r.status === 200,
    // QUAN TRỌNG: không chỉ check HTTP 200, phải check body status
    "order state confirmed": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.status === "confirmed" || body.status === "completed";
      } catch (e) {
        return false;
      }
    },
  });

  // Think time: mô phỏng user đọc kết quả trước khi checkout tiếp
  sleep(SLEEP_SECONDS);
}
```

**KHÔNG viết thế này**:

```js
// SAI — dùng iterationInTest làm idempotency key
const idemKey = `idem-${exec.scenario.iterationInTest}`;
// iterationInTest là global loop counter, không gắn với user identity

// SAI — chỉ check HTTP status, không check body
check(statusRes, { "status 200": (r) => r.status === 200 });
// Thiếu check body.status → bỏ sót async inconsistency

// SAI — không có idempotency key
http.post(`${BASE_URL}/api/sim/orders/${orderId}/confirm`, payload);
// Thiếu Idempotency-Key header → payment provider có thể từ chối
```

---

## Anti-pattern

- Dùng total `iterations` như pass/fail target cứng.
- Kỳ vọng fixed RPS từ `constant-vus`.
- So sánh 2 run có sleep/duration/VUs khác nhau rồi kết luận backend regress.
- Chỉ nhìn aggregate p95 trong flow nhiều operation.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với per-user quota của `per-vu-iterations`.
- Dùng `iterationInTest` làm idempotency key trong constant-vus.
- Chỉ check HTTP status của confirm, không verify order state qua status GET.
- Dùng `constant-arrival-rate` để "giữ checkout RPS ổn định" — nó CHE vấn đề external slowdown.
- Cho rằng "iter/s thấp hơn lần trước = regress" mà không check flow_duration và external latency.
- Bỏ qua status verification vì "confirm đã 200 rồi".
- Dùng shared-iterations identity model (iterationInTest) cho constant-vus.

---

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Constant-vus quick index: `../../20260516_01_constant-vus-quick-index.md`
- Tham số/công thức: `../../20260516_02_constant-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-04-checkout-trickle.js`
- Shared-iterations contrast (catalog audit): `../shared-iterations/01_catalog-audit.md`
- VU lifecycle & iteration counters: `../../20260114_00_vu-lifecycle-and-iteration-counters.md`
