# Case 04: Checkout ramp

## Tình huống thực tế

Promotion làm checkout users tăng dần vào peak rồi drain xuống sau cửa sổ khuyến mãi.

Mỗi loop thêm cart, tạo checkout, confirm order. Đây là flow có external/payment wait nên rất nhạy với concurrency.

Case này trả lời: order/cart có chịu được checkout concurrency 1 -> 8 -> 18 -> 1 không?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 1 -> 8 -> 18 -> 1
Scenario: checkout_ramp
Exec function: checkoutRamp
Team/service focus: checkout/order/payment
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 1 -> 8 -> 18 -> 1,
latency/failures/iter-s/RPS phản ứng như thế nào?
```

### Vì sao "Checkout ramp" buộc chọn ramping-vus?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của checkout ramp trước:

```text
Checkout ramp = "số checkout users tăng dần khi promotion bắt đầu,
                 đạt peak 18 users trong cửa sổ khuyến mãi,
                 rồi giảm dần sau khi promotion kết thúc,
                 mỗi user: cart -> checkout -> confirm (thanh toán),
                 quan sát: latency của từng bước theo stage,
                 throughput có theo kịp concurrency không,
                 và quan trọng nhất: khi external payment chậm,
                 throughput tự giảm — đó LÀ tín hiệu cần thấy"

Đời thường:
  Promotion 12:00-12:30
  Trước 12:00: 1-2 người checkout (đang chờ sale)
  12:00-12:05: 8 người ào vào checkout
  12:05-12:25: 18 người checkout liên tục (peak khuyến mãi)
  12:25-12:30: giảm dần về 1 người (hết sale)
  Mỗi người: thêm giỏ -> tạo đơn -> thanh toán
```

Để checkout ramp **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ ramping-vus mới thỏa mãn cả 2.

#### Yêu cầu (a): STAGED CHECKOUT CONCURRENCY (users tăng/peak/giảm theo promotion timeline)

**Ý nghĩa**: Checkout users không phẳng trong suốt thời gian khuyến mãi. Họ tăng dần khi promo bắt đầu, đạt peak giữa promo, rồi giảm dần sau promo. Test phải phản ánh timeline này.

**Ví dụ cụ thể**:

```text
Scenario: promotion checkout từ 12:00 đến 12:30

Trường hợp A (ramping-vus — PHÁT HIỆN vấn đề theo từng phase):
  Stage 1 (pre-promo):   1 VU  — baseline latency trước promotion
  Stage 2 (ramp-up):     1→8 VU — checkout users bắt đầu vào
  Stage 3 (peak/plateau): 18 VU — sustained peak checkout
  Stage 4 (ramp-down):   18→1 VU — post-promo recovery
  → Dashboard: VUs theo shape, latency tăng ở peak, recovery ở ramp-down
  → Kết luận: thấy được capacity ở từng phase

Trường hợp B (constant-vus — THIẾU timeline):
  vus=18, duration=5m
  → 18 users checkout suốt 5 phút
  → Không thấy được: pre-promo có ổn không? ramp-up có shock không?
  → KHÔNG kết luận được về transition behavior

Trường hợp C (constant-arrival-rate — SAI input):
  rate tăng theo target RPS
  → Ép checkout rate, không phải active users
  → Khi external chậm: drop request, CHE vấn đề
  → KHÔNG phản ánh user thật (user không "bơm checkout theo rate")
```

**Vì sao staged concurrency quan trọng với checkout promotion?**

```text
Promotion checkout KHÔNG phải là "18 users checkout suốt 5 phút".
Promotion checkout là "users TĂNG DẦN, đạt PEAK, rồi GIẢM DẦN".

Nếu chỉ test 18 users phẳng:
  - Không thấy được ramp-up shock (users ào vào cùng lúc)
  - Không thấy được recovery behavior (sau peak, hệ thống có về bình thường không)
  - Không thấy được transition cost (VUs thay đổi có gây spike latency không)

ramping-vus mô phỏng ĐÚNG hành vi này:
  Stage 2 (ramp-up): VUs tăng từ 1→8, quan sát latency có spike không
  Stage 3 (plateau): giữ 18 VUs, quan sát sustained capacity
  Stage 4 (ramp-down): VUs giảm, quan sát recovery

constant-vus mô phỏng SAI:
  18 VUs phẳng từ đầu đến cuối
  → Không có ramp-up, không có recovery
  → Thiếu transition signal
```

**Phân tích sâu: vì sao 3 executor "rate/job/flat" không đảm bảo staged concurrency?**

`constant-vus` với `vus: 18, duration: "5m"`:

```text
Công thức: 18 VUs active suốt 5 phút, mỗi VU loop liên tục

Vấn đề 1: Không có ramp-up phase
  → 18 users checkout ngay từ giây đầu tiên
  → Production: users tăng dần, không phải 18 users cùng lúc
  → Ramp-up shock không được test

Vấn đề 2: Không có ramp-down phase
  → 18 users dừng đột ngột khi hết duration
  → Production: users giảm dần sau promotion
  → Recovery behavior không được test

Vấn đề 3: Không có pre-promo baseline
  → Production: trước promo có 1-2 users checkout
  → Cần baseline để so sánh với peak
  → constant-vus không có phase baseline thấp
```

`constant-arrival-rate` với `rate tăng dần`:

```text
Vấn đề 1: Input là arrivals/s, không phải active users
  → Promotion requirement: "18 users checkout cùng lúc"
  → Arrival-rate: "X checkouts được tạo mỗi giây"
  → KHÔNG cùng khái niệm — 18 concurrent users ≠ 18 checkouts/s

Vấn đề 2: Khi external chậm, arrival-rate CHE vấn đề
  → K6 cố bơm target rate, drop nếu không đủ VU
  → Dashboard: RPS vẫn đạt → tưởng OK
  → Thực tế: checkout bị drop, external đang chậm
  → CHE vấn đề thay vì PHÁT HIỆN

Vấn đề 3: Không thấy closed-model feedback
  → User thật: đợi confirm xong mới checkout tiếp
  → Arrival-rate: bơm checkout mới bất kể confirm chưa xong
  → Không phản ánh user behavior thật
```

`shared-iterations` với `vus: 18, iterations: 1000`:

```text
Vấn đề 1: fixed count nghĩa là gì với promotion checkout?
  iterations=1000 → test dừng sau 1000 checkout, không quan tâm timeline
  → Nếu external nhanh: 1000 checkout trong 100s, dừng sớm
  → Không test được sustained peak trong 5 phút

Vấn đề 2: identity model sai
  shared-iterations: VU là worker, không có identity ổn định
  → VU=1 có thể làm checkout cho user A, rồi user B, rồi user C...
  → Idempotency key dựa trên iterationInTest (global job index)
  → Nhưng checkout ramp cần key dựa trên user identity (__VU) + attempt (__ITER)

Vấn đề 3: Không có stage timeline
  → Tất cả VU start cùng lúc, cùng làm việc
  → Không có ramp-up, plateau, ramp-down
  → Không phản ánh promotion timeline
```

#### Yêu cầu (b): EXTERNAL DEPENDENCY VISIBILITY (thấy được external payment impact theo từng stage)

**Ý nghĩa**: Checkout có external payment dependency. Khi external chậm, latency và throughput thay đổi THEO TỪNG STAGE. Test phải cho thấy external impact khác nhau ở ramp-up, peak, và ramp-down.

**External dependency visibility qua các stage**:

```text
Stage 1 (pre-promo, 1 VU):
  - 1 user checkout, external payment load thấp
  - Confirm latency: baseline (~100ms)
  - Đây là reference point

Stage 2 (ramp-up, 1→8 VU):
  - 8 users bắt đầu checkout, external payment load tăng
  - Confirm latency: có thể tăng nhẹ (200-500ms)
  - Nếu confirm latency spike → external không handle được ramp-up
  - Đây là transition signal QUAN TRỌNG

Stage 3 (peak, 18 VU):
  - 18 users checkout liên tục, external payment load cao nhất
  - Confirm latency: cao nhất (~500-3000ms tùy external capacity)
  - Nếu iter/s flatten dù VUs tăng → external là bottleneck
  - Đây là sustained capacity signal

Stage 4 (ramp-down, 18→1 VU):
  - Users giảm dần, external payment load giảm
  - Confirm latency: có về baseline không?
  - Nếu latency vẫn cao dù VUs giảm → external chưa recover
  - Đây là recovery signal
```

**Vì sao chỉ ramping-vus cho thấy external impact theo stage?**

```text
ramping-vus:
  → Có 4 stage riêng biệt
  → Mỗi stage có VU count khác nhau
  → External load thay đổi theo VU count
  → Dashboard: latency theo stage, thấy được external degradation pattern
  → Kết luận: "external OK ở 8 VUs nhưng fail ở 18 VUs"

constant-vus:
  → Chỉ có 1 phase phẳng
  → External load không đổi
  → Chỉ thấy: "external OK ở 18 VUs" hoặc "external fail ở 18 VUs"
  → KHÔNG thấy được: "external OK ở 8 VUs, fail ở 18 VUs"
  → Thiếu ngưỡng chuyển tiếp

constant-arrival-rate:
  → Ép rate, CHE external slowdown
  → Drop request thay vì cho thấy latency tăng
  → KHÔNG thấy external impact
```

**So sánh trực quan 4 executor cho checkout promotion**:

| Executor | Staged concurrency? | Thấy external impact theo stage? | Phát hiện ramp-up shock? | Identity model đúng? |
| --- | --- | --- | --- | --- |
| **ramping-vus** | CÓ (stages) | CÓ (theo VU count) | CÓ (transition) | CÓ (VU = user) |
| constant-vus | KHÔNG (phẳng) | MỘT PHẦN (1 phase) | KHÔNG | CÓ (VU = user) |
| constant-arrival-rate | MỘT PHẦN (rate thay đổi) | KHÔNG (drop thay vì giảm) | KHÔNG (ép rate) | KHÔNG (rate-driven) |
| shared-iterations | KHÔNG (count-driven) | MỘT PHẦN (chỉ T_run) | KHÔNG (cùng start) | KHÔNG (VU = worker) |

→ Chỉ **ramping-vus** thỏa mãn: staged concurrency + external dependency visibility theo từng phase + phát hiện ramp-up shock + VU là user identity ổn định.

---

## Yêu cầu cứng của case này

- Stage shape phải ramp lên và giữ 18 checkout users.
- Full checkout loop phải đi cart add -> checkout -> confirm.
- Idempotency keys phải ổn dưới concurrency ramp.
- Failed loops phải thấp hơn cap.

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

### Yêu cầu cứng bổ sung cho checkout promotion

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Stage shape phải cover pre-promo + ramp-up + peak + ramp-down | Thiếu pre-promo baseline → không có reference point; thiếu ramp-down → không thấy recovery |
| Mỗi checkout loop phải có cart_add + create + confirm | Thiếu cart_add → không test được cart service dưới concurrency; thiếu confirm → không test được payment path |
| Idempotency key phải unique mỗi lần confirm dưới ramping concurrency | VUs tăng/giảm theo stage, key collision khi VU mới start có thể trùng key với VU cũ |
| Key derive từ `__VU` + `__ITER` | __VU là user identity ổn định, __ITER là attempt counter; phù hợp với per-VU identity của ramping-vus |
| KHÔNG derive key từ `iterationInTest` | iterationInTest là global loop counter, có thể bị reuse khi VUs thay đổi theo stage |
| `ramping_active_iterations_failed count<20` | Mỗi failed loop = một đơn hàng thất bại, business impact cao trong promotion |
| Plateau phải đủ dài để verify sustained checkout | Peak ngắn → chỉ test được burst, không test được sustained capacity |

---

## Vì sao "Checkout ramp" nên dùng `ramping-vus`?

Checkout ramp cần active users tăng theo promotion. `ramping-vus` đúng vì input là concurrent checkout users over time, không phải target checkout RPS.

Mental model:

```text
Active VUs follow stage timeline.
Each active VU loops the business flow sequentially.
Backend latency changes completed loop rate.
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

### Mental model mở rộng: VU là khách checkout, stage là timeline promotion

```text
shared-iterations (catalog audit):
  VU = công nhân trong kho, ai nhanh thì bốc nhiều thùng
  Job identity = iterationInTest (global job index)
  Không có per-VU state
  Không có timeline

constant-vus (checkout trickle):
  VU = quầy thanh toán cố định, mỗi quầy phục vụ khách liên tục
  User identity = __VU (quầy số mấy)
  Có per-VU state: idempotency key tăng theo __ITER
  Nhưng VU count PHẲNG — không có ramp-up/ramp-down

ramping-vus (checkout ramp):
  VU = khách checkout, số lượng khách thay đổi theo promotion timeline
  Stage = phase của promotion (pre-promo, ramp-up, peak, ramp-down)
  User identity = __VU (khách số mấy)
  Có per-VU state: idempotency key tăng theo __ITER
  CÓ timeline: VU count thay đổi theo stage
```

---

## Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho staged active users? |
| --- | --- | --- |
| `ramping-vus` | Active users thay đổi theo thời gian | **Đúng**: input là timeline VU, output là latency/iter-s/RPS theo từng phase. |
| `constant-vus` | Cũng là closed model active users | Sai nếu traffic phải rise/peak/cooldown; `constant-vus` giữ VUs phẳng. |
| `shared-iterations` | Có nhiều VU cùng chạy | Sai nếu không có fixed backlog cần drain đủ. |
| `per-vu-iterations` | VU identity ổn định | Sai nếu không cần mỗi VU chạy đúng N vòng; stage duration mới là input chính. |
| `constant-arrival-rate` | Giữ rate ổn định | Sai nếu requirement là active users, không phải arrivals/s. |
| `ramping-arrival-rate` | Cũng có time-shaped load | Close cousin nhưng input là arrivals/s, không phải active VU pool. |

Kết luận cho case này:

```text
Need active VUs changing over time -> ramping-vus.
Need fixed active users -> constant-vus, not this case.
Need fixed total jobs -> shared-iterations, not this case.
Need fixed per-user quota -> per-vu-iterations, not this case.
Need fixed arrivals/s -> constant-arrival-rate, not this case.
Need arrivals/s changing over time -> ramping-arrival-rate, close but wrong input.
```

---

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 60s | 15s | 8 | checkout ramp-up |
| 2 | 90s | 23s | 18 | promotion ramp |
| 3 | 120s | 30s | 18 | sustained peak |
| 4 | 60s | 15s | 1 | drain |

Lưu ý:

```text
effective duration = scaleSeconds(raw_seconds, RV_NN_DURATION_SCALE)
scaleSeconds = max(1, round(raw_seconds * scale)) seconds
```

`stage.target` là absolute VU target ở cuối stage.

### Diễn giải stage timeline cho promotion checkout

```text
Stage 1 (ramp-up, 1→8 VU, 15s):
  Pre-promo: 1 user đang checkout
  Promotion bắt đầu: users tăng từ 1 lên 8
  → Test ramp-up behavior: latency có spike khi users tăng không?

Stage 2 (promotion ramp, 8→18 VU, 23s):
  Promotion đang hot: users tăng từ 8 lên 18
  → Test scalability: hệ thống có handle được 8→18 không?

Stage 3 (sustained peak, 18 VU, 30s):
  Peak promotion: 18 users checkout liên tục
  → Test sustained capacity: 18 users checkout trong 30s
  → Đây là phase QUAN TRỌNG NHẤT

Stage 4 (ramp-down, 18→1 VU, 15s):
  Post-promo: users giảm về 1
  → Test recovery: latency có về baseline không?
```

---

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
RV_04_START_VUS = 1
RV_04_MID_VUS = 8
RV_04_PEAK_VUS = 18
RV_04_DURATION_SCALE = 0.25
RV_04_SLEEP_SECONDS = 0.8
gracefulRampDown = 20s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_04_START_VUS | 1 | stage/control knob |
| RV_04_MID_VUS | 8 | stage/control knob |
| RV_04_PEAK_VUS | 18 | stage/control knob |
| RV_04_DURATION_SCALE | 0.25 | stage/control knob |
| RV_04_SLEEP_SECONDS | 0.8 | stage/control knob |
| gracefulRampDown | 20s | stage/control knob |

Mapping quan trọng cho checkout ramp:

```text
pre-promo users           = 1 VU (startVUs)
ramp-up target            = 8 VU (MID_VUS)
peak users                = 18 VU (PEAK_VUS)
post-promo target         = 1 VU (final stage)
observation duration      = sum of all stage durations
think time                = 0.8s
expected API per loop     = 3 (cart_add + create + confirm)
natural throughput        = OUTPUT (không config)
idempotency key pattern   = idem-${__VU}-${__ITER}
```

---

## Technical semantics: staged active pool, closed model, graceful ramp-down

Trong ramping-vus:

```text
startVUs = active users at scenario start
stages[].target = absolute active user target at stage end
stages[].duration = time to move from previous target to new target
gracefulRampDown = grace when VUs are stopped during ramp-down
```

Không có fixed target cho:

```text
iterations
http_reqs
RPS
iter/s
```

Nếu VUs tăng nhưng iter/s không tăng:

```text
ramping_flow_duration_ms có thể đã tăng
backend/service có thể đã saturated
```

Nếu VUs giảm nhưng iterations vẫn hoàn tất thêm:

```text
gracefulRampDown có thể đang cho in-flight loops finish
```

### So sánh identity model: ramping-vus vs constant-vus vs shared-iterations

| Tiêu chí | ramping-vus (checkout ramp) | constant-vus (checkout trickle) | shared-iterations (catalog audit) |
| --- | --- | --- | --- |
| VU là gì? | User identity ổn định, nhưng VU count thay đổi theo stage | User identity ổn định, VU count phẳng | Worker generic (công nhân kho) |
| `__VU` dùng làm gì? | User ID, key prefix | User ID, key prefix | KHÔNG dùng (chỉ là worker ID) |
| `__ITER` dùng làm gì? | Attempt counter của user đó | Attempt counter của user đó | KHÔNG dùng (local counter vô nghĩa) |
| `iterationInTest` dùng làm gì? | Global stat (không dùng làm identity) | Global stat (không dùng làm identity) | Business identity CHÍNH (SKU index) |
| Per-VU state? | CÓ (idempotency prefix, session) | CÓ (idempotency prefix, session) | KHÔNG (mỗi job khác nhau) |
| VU count thay đổi? | CÓ (theo stage) | KHÔNG (phẳng) | KHÔNG (cố định) |
| Key pattern | `idem-${__VU}-${__ITER}` | `idem-${__VU}-${__ITER}` | `idem-${iterationInTest}` |

### Lưu ý đặc biệt cho identity trong ramping-vus

```text
Trong ramping-vus, VU count thay đổi theo stage.
VU mới được tạo khi ramp-up, VU cũ bị dừng khi ramp-down.

Điều này có nghĩa:
  - __VU có thể không tồn tại suốt toàn bộ run
  - VU=15 có thể chỉ active trong stage 3 (peak)
  - Khi VU bị dừng ở ramp-down, in-flight iteration được bảo vệ bởi gracefulRampDown

Idempotency key: idem-${__VU}-${__ITER}
  - VU=5, __ITER=0: key = idem-5-0 (checkout lần 1 của user 5)
  - VU=5, __ITER=1: key = idem-5-1 (checkout lần 2 của user 5)
  - Dù VU=5 chỉ active trong stage 2-3, key vẫn unique
  - KHÔNG bị collision với VU khác hoặc stage khác
```

---

## Technical root causes this case catches

### Nguyên nhân kỹ thuật 1: Payment/external wait increases loop duration

Checkout/confirm external wait làm `ramping_flow_duration_ms` tăng và iter/s giảm.

**Demo trace: external payment từ nhanh → chậm trong promotion peak**

```text
Baseline — external payment bình thường (confirm ~100ms):
  VU=1: cart_add(50ms) → create(200ms) → confirm(100ms) → sleep(0.8s)
  loop_duration = 1.15s
  iter/s (1 VU) ≈ 1 / 1.15 ≈ 0.87/s

  Tại peak 18 VU (nếu external vẫn nhanh):
  iter/s ≈ 18 / 1.15 ≈ 15.7/s

External payment chậm (confirm ~3000ms) — promotion peak:
  VU=1: cart_add(50ms) → create(200ms) → confirm(3000ms) → sleep(0.8s)
  loop_duration = 4.05s
  iter/s (18 VU) ≈ 18 / 4.05 ≈ 4.4/s

→ iter/s giảm từ 15.7 → 4.4 (~72% drop)
→ ĐÂY LÀ TÍN HIỆU ĐÚNG: external payment đang kéo checkout xuống
→ Đặc biệt quan trọng ở STAGE 3 (peak): 18 VUs nhưng iter/s thấp
→ Hành động: BLOCK, điều tra external payment provider

So sánh với constant-arrival-rate trong tình huống này:
  Nếu cố đặt target checkout rate = 15/s:
  iter_time = 4.05s, cần 15 × 4.05 = 60.75 VU
  Nhưng maxVUs chỉ có 18 → drop ~42 checkout/s
  Dashboard: arrival rate vẫn "đạt" ~15/s (scheduled)
  CHE VẤN ĐỀ — không thấy external đang chậm!
```

**Công thức định lượng**:

```text
loop_duration = T_cart_add + T_create + T_confirm + T_sleep + T_js

T_confirm = T_order_service + T_external_payment
          ≈ T_base + external_ms

Khi external_ms tăng:
  loop_duration tăng
  per_vu_loop_rate = 1 / loop_duration giảm
  iter/s = active_vus × per_vu_loop_rate giảm

Mối quan hệ:
  Δiter/s ≈ -active_vus × (Δexternal_ms) / (loop_duration²)

Tại peak 18 VUs, external_ms từ 100ms → 3000ms:
  loop_duration: 1.15s → 4.05s
  iter/s: 15.7/s → 4.4/s
  → Mất ~11.3 checkout/s do external payment chậm
```

**Vì sao case này phát hiện rõ hơn constant-vus?**

```text
constant-vus (8 VUs phẳng):
  external chậm: iter/s 5.3 → 1.8 (giảm 3.5/s)
  → Thấy được slowdown, nhưng chỉ ở 1 mức VU

ramping-vus (1→8→18→1):
  external chậm:
    Stage 1 (1 VU):  iter/s 0.87 → 0.25 (giảm 0.62/s)
    Stage 2 (8 VU):  iter/s 6.96 → 1.98 (giảm 4.98/s)
    Stage 3 (18 VU): iter/s 15.7 → 4.4  (giảm 11.3/s)
    Stage 4 (1 VU):  iter/s 0.87 → 0.25 (giảm 0.62/s)
  → Thấy được external impact THEO TỪNG MỨC CONCURRENCY
  → Biết chính xác: "external OK ở 1 VU, chậm ở 8 VU, rất chậm ở 18 VU"
  → Đây là thông tin mà constant-vus KHÔNG thể cung cấp
```

### Nguyên nhân kỹ thuật 2: Cart may pass while order fails

Cart add success không chứng minh checkout/order path pass.

**Demo trace: cart pass nhưng order fail trong promotion peak**

```text
Flow mỗi checkout loop:
  1. POST /api/sim/cart/add          → expect 200 (cart created)
  2. POST /api/sim/checkout           → expect 200 (order created)
  3. POST /api/sim/orders/:id/confirm → expect 200 (payment confirmed)

Scenario: order service quá tải ở peak 18 VUs:
  Bước 1: cart_add → 200 OK (cart service vẫn khỏe)
  Bước 2: create → 500 Internal Server Error (order service quá tải)
  → Loop fail ở bước create
  → Nhưng cart_add vẫn pass!

Nếu script CHỈ check cart_add:
  cart_add 200 ✓
  → Loop "pass", nhưng order không được tạo
  → CHE vấn đề: tưởng checkout OK, thực tế order service đang fail

Nếu script check TẤT CẢ các bước:
  cart_add 200 ✓
  create 500 ✗ → return sớm, loop fail
  → ramping_active_iterations_failed tăng
  → Phát hiện được order service failure ✓

Tag quan trọng: operation-level tagging
  - cart_add: tag operation=checkout_ramp_cart_add
  - create:   tag operation=checkout_ramp_create
  - confirm:  tag operation=checkout_ramp_confirm
  → Dashboard lọc theo operation để thấy bước nào fail
  → Nếu không tag operation: aggregate metric che mất branch fail
```

**Vì sao cart pass nhưng order fail nguy hiểm trong promotion?**

```text
Trong promotion:
  - Cart service: thường là read/write đơn giản, ít external dependency
  - Order service: có external payment, DB transaction, inventory check
  → Order service dễ fail hơn cart service khi concurrency cao

Nếu chỉ nhìn aggregate:
  checks rate = 67% (2/3 pass: cart_add OK, create FAIL, confirm skip)
  → Thấy "có vấn đề" nhưng không biết bước nào

Nếu tách theo operation:
  checkout_ramp_cart_add: 100% pass
  checkout_ramp_create: 0% pass ← ĐÂY LÀ VẤN ĐỀ
  checkout_ramp_confirm: N/A (không chạy tới)
  → Biết chính xác: order service fail, không phải cart hay payment

→ Tag operation là BẮT BUỘC cho multi-step flow như checkout
```

**Check pattern đúng: mỗi bước có tag operation riêng**

```js
// Bước 1: cart add — tag riêng
const cartRes = http.post(`${BASE_URL}/api/sim/cart/add`, payload, {
  tags: { operation: "checkout_ramp_cart_add" },
});

// Bước 2: checkout create — tag riêng
const createRes = http.post(`${BASE_URL}/api/sim/checkout`, payload, {
  tags: { operation: "checkout_ramp_create" },
});

// Bước 3: confirm — tag riêng
const confirmRes = http.post(`${BASE_URL}/api/sim/orders/${orderId}/confirm`, payload, {
  tags: { operation: "checkout_ramp_confirm" },
});
```

### Nguyên nhân kỹ thuật 3: Idempotency under ramping concurrency

Concurrent checkout users cần unique idempotency keys để tránh replay/collision.

**Demo trace: idempotency key trong ramping concurrency**

```text
Scenario: 18 VUs checkout cùng lúc trong stage 3 (peak)

Dùng key ĐÚNG — idem-${__VU}-${__ITER}:
  VU=1, __ITER=0: key = idem-1-0
  VU=2, __ITER=0: key = idem-2-0
  VU=3, __ITER=0: key = idem-3-0
  ...
  VU=18, __ITER=0: key = idem-18-0
  → 18 keys UNIQUE, mỗi VU một key riêng
  → Không collision ✓

  VU=1, __ITER=1: key = idem-1-1 (checkout lần 2 của user 1)
  VU=1, __ITER=2: key = idem-1-2 (checkout lần 3 của user 1)
  → Key tăng theo __ITER, không trùng với VU khác ✓

Dùng key SAI — idem-${iterationInTest}:
  iterationInTest là global loop counter
  VU=1, loop 1 → iterationInTest=0 → key=idem-0
  VU=2, loop 1 → iterationInTest=1 → key=idem-1
  ...
  → Có vẻ OK, nhưng...

  Vấn đề thực sự: iterationInTest không gắn với user identity
  Nếu VU=1 chạy nhanh, VU=18 chạy chậm:
    VU=1 loop 10 → iterationInTest=150
    VU=18 loop 1 → iterationInTest=151
  → Key không có ý nghĩa business (không biết là user nào, lần thứ mấy)
  → Payment provider thấy key nhảy lung tung → nghi ngờ fraud
```

**Vì sao idempotency trong ramping-vus khó hơn constant-vus?**

```text
constant-vus:
  - VU count cố định (8 VUs)
  - Mỗi VU active từ đầu đến cuối
  - __VU ổn định suốt run
  - Key pattern: idem-${__VU}-${__ITER} — đơn giản, không có edge case

ramping-vus:
  - VU count thay đổi theo stage (1→8→18→1)
  - VU mới được tạo ở ramp-up, VU cũ bị dừng ở ramp-down
  - __VU có thể không tồn tại suốt toàn bộ run
  - VU=15 chỉ active trong stage 3 (peak)
  - Key pattern: idem-${__VU}-${__ITER} — vẫn đúng, nhưng cần hiểu:
    + VU=15, __ITER=0 là key ĐẦU TIÊN của VU này
    + Không trùng với VU=1, __ITER=0 vì __VU khác nhau
    + Khi VU=15 bị dừng ở ramp-down, key của nó không bị reuse

  Edge case: VU bị dừng rồi tạo lại?
    - Trong ramping-vus, VU bị dừng ở ramp-down thường không được tạo lại
    - grace kỳ: VU mới có __VU khác (k6 không reuse __VU trong cùng scenario)
    - → idem-${__VU}-${__ITER} vẫn an toàn
```

### Nguyên nhân kỹ thuật 4: Plateau verifies sustained checkout

Giữ 18 VUs kiểm sustained capacity, không chỉ short burst.

**Demo trace: burst vs sustained checkout capacity**

```text
Scenario A — Burst test (shared-iterations, 18 VUs, 100 iterations):
  18 VUs cùng start, chạy 100 checkout
  Nếu external nhanh: 100 checkout trong ~6.4s
  → Thấy: "18 VUs checkout 100 lần OK"
  → Nhưng: chỉ test trong 6.4s — quá ngắn!
  → Không phát hiện được: memory leak, connection pool cạn, DB slow sau 30s

Scenario B — Sustained test (ramping-vus, stage 3 plateau 30s):
  18 VUs checkout liên tục trong 30s
  Nếu external nhanh: ~470 checkout trong 30s
  → Thấy: latency ổn định suốt 30s? Hay tăng dần?
  → Phát hiện được: degradation theo thời gian

Ví dụ: connection pool cạn sau 15s với 18 concurrent checkouts:
  Burst test (6.4s): không thấy vấn đề → FALSE PASS
  Sustained test (30s):
    0-15s: latency ổn, iter/s ổn
    15-30s: latency tăng, iter/s giảm → PHÁT HIỆN VẤN ĐỀ
  → Plateau duration đủ dài là CRITICAL
```

**Vì sao plateau quan trọng cho promotion checkout?**

```text
Promotion thực tế:
  - Không phải "18 users checkout 100 lần rồi nghỉ"
  - Mà là "18 users checkout LIÊN TỤC trong 30 phút khuyến mãi"

Nếu plateau quá ngắn:
  - Chỉ test được burst capacity
  - Không thấy được: resource leak, slow degradation, GC pause tích lũy

Plateau đủ dài (≥30s effective):
  - Test được sustained capacity
  - Thấy được: latency trend (tăng dần?), iter/s trend (giảm dần?)
  - Phát hiện được: "OK trong 10s đầu, fail sau 20s"

Công thức rough:
  plateau_iterations ≈ plateau_duration × vus / loop_duration
  
  Với plateau 30s, 18 VUs, loop 1.15s:
  plateau_iterations ≈ 30 × 18 / 1.15 ≈ 470 iterations
  → Đủ lớn để thấy pattern, không chỉ là may rủi
```

---

## Service/API flow

Flow pattern:

```text
Each loop: cart add -> checkout create -> order confirm; uses idempotency keys.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| checkout_ramp_cart_add | cart-service | POST | /api/sim/cart/add | 200 | Cart add before checkout. |
| checkout_ramp_create | order-service | POST | /api/sim/checkout | 200 | Create checkout/order. |
| checkout_ramp_confirm | order-service | POST | /api/sim/orders/:id/confirm | 200 | Confirm order. |

### Flow logic từng loop

```text
1. cart add:
   POST /api/sim/cart/add
   Body: { user_id, items: [...] }
   Response: { cart_id, status: "created" }
   → Chuẩn bị giỏ hàng trước khi checkout

2. create checkout:
   POST /api/sim/checkout
   Body: { user_id, cart_id, ... }
   Response: { order_id, status: "created" }
   → Tạo order từ cart
   → Lưu order_id cho bước sau

3. confirm order:
   POST /api/sim/orders/${order_id}/confirm
   Header: Idempotency-Key: idem-${__VU}-${__ITER}
   Body: { payment_method, ... }
   Response: { status: "processing" hoặc "confirmed" }
   → External payment được gọi trong bước này
   → Đây là bước CHẬM NHẤT (external dependency)
```

---

## Metrics và tags cần đọc

| Metric | Type | Cách đọc |
| --- | --- | --- |
| `ramping_active_iterations` | Counter | Số user loops hoàn tất trong staged run. Đây là output, không phải target. |
| `ramping_active_iterations_failed` | Counter | Số loops có ít nhất một API required fail. Đây là business-flow failure counter. |
| `ramping_api_calls_total` | Counter | Tổng API calls do ramping user pool tạo ra. Dùng để sanity check operation mix. |
| `ramping_flow_duration_ms` | Trend | End-to-end duration của một user loop. Metric chính để giải thích iter/s flatten. |
| `ramping_sleep_seconds` | Counter | Think time/sleep do script cố ý thêm. |
| `checks` | Rate | API/status/contract checks pass bao nhiêu %. |
| `http_req_failed` | Rate | HTTP/network/protocol failure rate theo k6. |
| `iterations` | Counter | Số vòng `default()` hoàn tất; observed output. |
| `vus` | Gauge | Active VUs sampled over time; phải đi theo stage shape. |
| `vus_max` | Gauge | Max VUs observed/reserved, dùng để đối chiếu peak target. |

Tags chung:

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `rv-02-campaign-launch-spike`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service được gọi. |
| `operation` | Operation cụ thể trong user loop. |
| `endpoint` | Nhóm endpoint/API family. |
| `user_id` | Active user identity derive từ VU/user context. |
| `executor_family` | `ramping_vus`. |
| `workload_shape` | `staged_concurrency`. |

Tags case này:

```text
case_id       = rv-04-checkout-ramp
business_case = checkout_concurrency_ramp
workload      = staged_concurrency
```

### Cách đọc metric theo operation cho case này

```text
Tách theo operation để phát hiện bottleneck ẩn:

checkout_ramp_cart_add:
  - Count: số lần thêm cart
  - http_req_duration: latency của cart service
  - http_req_failed: cart service có fail không?
  - Thường là operation NHANH NHẤT (không có external dependency)

checkout_ramp_create:
  - Count: số lần tạo checkout (có thể ít hơn cart_add nếu cart fail)
  - http_req_duration: latency của order creation
  - http_req_failed: order service fail?
  - Có thể tăng ở peak do order service load

checkout_ramp_confirm:
  - Count: số lần confirm (có thể ít hơn create nếu create fail)
  - http_req_duration: latency của confirm (BAO GỒM external payment)
  - http_req_failed: external payment fail?
  - Đây thường là operation CHẬM NHẤT (external dependency)
  - Đặc biệt quan trọng ở stage 3 (peak 18 VUs)
```

---

## Pass criteria

Thresholds theo backend script:

```text
checks: rate>0.99
http_req_failed: rate<0.01
ramping_active_iterations_failed: count<20
```

Các counters/trends cần sanity check:

```text
ramping_active_iterations
ramping_active_iterations_failed
ramping_api_calls_total
ramping_flow_duration_ms
ramping_sleep_seconds
iterations
http_reqs
vus / vus_max
```

Không có expected exact count cho:

```text
iterations
http_reqs
RPS
iter/s
```

Chúng là observed outputs.

### Pass criteria bổ sung cho checkout promotion

```text
Operation counts sanity:
  checkout_ramp_cart_add count ≈ checkout_ramp_create count
  (Mỗi cart add nên có một create; chênh lệch nhỏ có thể do loop đang chạy dở)

  checkout_ramp_create count ≈ checkout_ramp_confirm count
  (Mỗi create nên có một confirm)

Stage shape verification:
  vus_min ≈ 1 (pre-promo và post-promo)
  vus_max ≈ 18 (peak)
  vus chart phải theo shape 1→8→18→1

Per-stage latency sanity:
  Stage 1 (1 VU):  latency thấp nhất (baseline)
  Stage 2 (8 VU):  latency có thể tăng nhẹ
  Stage 3 (18 VU): latency cao nhất (peak load)
  Stage 4 (1 VU):  latency về gần baseline (recovery)

Idempotency:
  Không có HTTP 409 Conflict từ confirm (trùng key)
  Nếu có 409 → key pattern sai
```

---

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-04-checkout-ramp.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6\ramping-vus\rv-04-checkout-ramp.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6\ramping-vus\rv-04-checkout-ramp.js
```

---

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = checkout_ramp
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 1 -> 8 -> 18 -> 1
```

`vus_max` nên gần peak target nếu run đủ dài và dashboard sample bắt được peak.

### Bước 3 — Check failures trước throughput

Đọc trước:

```text
checks
http_req_failed
ramping_active_iterations_failed
```

Nếu failures fail threshold, xử lý correctness/API failure trước khi bàn throughput.

**Case-specific: thứ tự ưu tiên khi có failure**

```text
1. ramping_active_iterations_failed > 0:
   → Có loop checkout thất bại → business impact CAO trong promotion
   → Lọc theo operation để tìm bước nào fail:
     - cart_add fail → cart service down?
     - create fail → order service down?
     - confirm fail → external payment down?
   → Mỗi failed loop = một đơn hàng mất → ưu tiên cao nhất

2. http_req_failed > 0:
   → Có HTTP failure → network/protocol issue
   → Lọc theo operation + status code
   → Đặc biệt chú ý confirm fail (external payment)

3. checks rate < 1:
   → API/status check fail
   → Lọc theo operation để tìm bước nào fail check
```

### Bước 4 — Interpret counters as outputs

Đọc:

```text
iterations
http_reqs
ramping_active_iterations
ramping_api_calls_total
```

Nhớ:

```text
iterations/RPS là output, không có exact expected target.
```

**Case-specific: phân tích iterations không theo kỳ vọng**

```text
Nếu iterations thấp hơn dự kiến:
  1. Check ramping_flow_duration_ms — có tăng không?
     → Nếu tăng: backend/external chậm → closed-model feedback (TỐT)
     → Nếu không tăng: sleep/config thay đổi?

  2. Check http_req_duration theo operation:
     → checkout_ramp_confirm tăng? → external payment chậm
     → checkout_ramp_create tăng? → order service chậm
     → checkout_ramp_cart_add tăng? → cart service chậm

  3. Check ramping_sleep_seconds:
     → Có khớp configured sleep không?

  4. Check iterations theo stage:
     → Stage 3 (peak 18 VUs) có iterations cao nhất không?
     → Nếu stage 2 (8 VUs) iterations > stage 3 → vấn đề ở peak
     → Nếu stage 4 (1 VU) iterations bất thường → recovery issue
```

### Bước 5 — Interpret duration/throughput

Đọc:

```text
ramping_flow_duration_ms
http_req_duration by operation
iteration_duration
```

Case-specific notes:

- Mỗi full loop thường có 3 API calls.
- Nếu confirm tail cao, flow duration sẽ tăng dù cart add nhanh.
- Peak plateau là nơi quan trọng nhất để đọc capacity.

**Case-specific: tương quan giữa các operation theo stage**

```text
Expected relationship:
  http_req_duration confirm > http_req_duration create > http_req_duration cart_add
  (Vì confirm có external payment, chậm nhất; cart_add đơn giản nhất)

Nếu cart_add > create:
  → Cart service chậm bất thường
  → Có thể do DB write lock, validation chậm

Nếu create > confirm:
  → Order service tạo order chậm hơn external payment (bất thường)
  → Có thể external payment không thực sự được gọi, hoặc quá nhanh

Per-stage analysis:
  Stage 1 (1 VU):  tất cả latency thấp → baseline
  Stage 2 (8 VU):  confirm có thể tăng nhẹ → ramp-up signal
  Stage 3 (18 VU): confirm cao nhất → peak load signal
  Stage 4 (1 VU):  confirm về baseline? → recovery signal

ramping_flow_duration_ms ≈ sum(http_req_duration) + sleep + JS overhead
  → Dùng để validate script không bị bottleneck ở JS
```

---

<!-- REAL_RUN_START -->
## Contract rerun 2026-06-20 — run #54

Run này ép đúng contract/tải đã ghi trong tài liệu, kể cả khi backend script default hiện tại đã đổi nhẹ hơn.

```text
BASE_URL=http://localhost:80
K6_CLOUD_HOST=http://localhost:18080
RV_04_START_VUS=1
RV_04_MID_VUS=8
RV_04_PEAK_VUS=18
RV_04_DURATION_SCALE=0.25
RV_04_SLEEP_SECONDS=0.8
```

| Item | Value |
| --- | --- |
| Script | `rv-04-checkout-ramp.js` |
| Run ID | `54` |
| Exit code | `0` |
| Verdict | **PASS** — Đạt theo contract gốc |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `1 -> 8 -> 18 -> 1` |
| Observed `vus` min/max | 1 / 18 |

### Summary thật của contract rerun

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 100.00% (3129/3129) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/3129) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 0 | User-loop failures của case. |
| `iterations` | 1043 (12.46/s) | Output, không phải target. |
| `http_reqs` | 3129 (37.39/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 1043 | Completed user loops. |
| `ramping_api_calls_total` | 3129 | Custom API counter. |
| `ramping_sleep_seconds` | 834.4s | Think time do script thêm. |
| `http_req_duration` | avg 68.2ms, p95 112ms, p99 116ms, max 173ms | Request-level latency. |
| `ramping_flow_duration_ms` | avg 205ms, p95 225ms, p99 251ms, max 285ms | Full user-loop latency. |
| `iteration_duration` | avg 1.01s, p95 1.03s, p99 1.05s, max 1.09s | Bao gồm flow + think/sleep. |

Threshold failures:

Không có threshold failure.

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `checkout_ramp_confirm` | POST | 200 | 1043 | 33.33% |
| `checkout_ramp_create` | POST | 200 | 1043 | 33.33% |
| `checkout_ramp_cart_add` | POST | 200 | 1043 | 33.33% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

Checkout p95 cao hơn các case nhẹ vì create/confirm có external/order cost, nhưng toàn bộ checks pass và HTTP failed 0%.

| Aggregate | Value |
| --- | ---: |
| Response-time points | 3125 |
| Avg của các window avg | 68.2ms |
| Max window p95 | 174ms |
| Max window p99 | 174ms |
| Max request window | 173ms |
| Windows p95 > 100ms | 1084 |
| Windows p95 > 500ms | 0 |

#### 2. Execution timeline chart

Không có failed iterations. Mỗi iteration chạy đủ 3 API calls: cart_add, create, confirm.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 1043 |
| Sum `http_reqs` buckets | 3129 |
| Peak iter/s bucket | 18 |
| Peak http_req/s bucket | 55 |
| Failed-iteration points | 0 |
| Sum failed iterations | 0 |
| Peak failed-iteration bucket | 0 |

#### 3. VUs vs iter/s chart

VU shape đạt peak 18 đúng contract. iter/s thấp hơn do checkout flow dài hơn, đây là closed-model behavior bình thường.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 83 |
| VUs min/max series | 1 / 18 |
| Avg VUs series | 12.59 |
| Peak iter/s bucket | 18 |

### Kết luận contract rerun #54

OK theo contract gốc.
<!-- REAL_RUN_END -->

---

## Đọc dashboard real-time charts cho case 04

> Phần này giữ cách đọc dashboard chung; số thật của run gần nhất nằm ở section `Real run` phía trên.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm theo phase? | Fixed iteration target |
| Execution timeline | VUs/failures/RPS thay đổi theo stage nào? | Target RPS, vì không có target RPS |
| VUs vs iter/s | VU shape có đúng không, iter/s có flatten không? | Business correctness nếu không đọc failures |

### Chart 1 — Response time

Đọc theo `operation`:

```text
checkout_ramp_cart_add: POST /api/sim/cart/add
checkout_ramp_create: POST /api/sim/checkout
checkout_ramp_confirm: POST /api/sim/orders/:id/confirm
```

Cách đọc:

```text
ramp-up phase: latency có tăng khi VUs tăng không?
peak/plateau: p95/p99 có ổn định không?
ramp-down/recovery: latency có giảm lại không?
```

Case-specific hints:

- Response time: cart_add vs checkout_create vs confirm.
- Execution timeline: failures ở peak stage là payment/order capacity signal.
- VUs vs iter/s: plateau 18 VUs nhưng iter/s giảm nghĩa là checkout flow chậm hơn.

#### Cách phân tích sâu chart Response time cho checkout ramp

Khi nhìn chart này, đừng chỉ nhìn "cao/thấp". Hãy đọc theo 4 câu hỏi:

```text
1. Operation nào chậm nhất? (thường là confirm — external payment)
2. Confirm latency có tăng theo stage không? (ramp-up → peak)
3. Cart_add vs create vs confirm gap có thay đổi theo stage không?
4. Recovery: latency có về baseline ở stage 4 không?
```

Với case 04, shape đẹp thường có:

```text
stage 1 (1 VU):   tất cả latency thấp, confirm > cart_add nhẹ
stage 2 (8 VU):   confirm tăng nhẹ, cart_add và create vẫn thấp
stage 3 (18 VU):  confirm cao nhất, nhưng ổn định (không tăng dần)
stage 4 (1 VU):   tất cả latency về gần baseline

Expected latency ranking:
  p95(confirm) > p95(create) > p95(cart_add)

Lý do:
  - confirm: external payment call (~100-500ms extra)
  - create: order creation + DB write
  - cart_add: simple cart insert
```

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 confirm tăng dần trong stage 3 | External payment degradation theo thời gian | Điều tra external provider |
| p95 confirm spike ở stage 2 (ramp-up) | External không handle được ramp-up | Điều tra ramp-up behavior |
| p95 create và confirm cùng tăng ở peak | Order service chậm (không phải external) | Điều tra order-service |
| p95 cart_add tăng ở peak | Cart service cũng bị ảnh hưởng | Điều tra cart-service |
| Stage 4 latency không về baseline | Hệ thống không recover sau peak | Điều tra recovery/cleanup |
| p95 confirm = p95 create (gần bằng) | External payment không được gọi? | Kiểm script/config |
| Aggregate p95 đẹp nhưng một operation xấu | Bottleneck bị aggregate che | Luôn tách theo operation |

### Chart 2 — Execution timeline

Với ramping-vus:

```text
VUs should follow 1 -> 8 -> 18 -> 1.
iterations/http_reqs per bucket are outputs.
failures may cluster at ramp transitions or peak.
```

Không kỳ vọng exact per-bucket counts, đặc biệt với weighted/conditional flows.

Nếu thấy:

```text
VUs tăng nhưng RPS/iter/s không tăng
```

thì đọc là:

```text
closed-model slowdown/backpressure
```

không đọc là:

```text
k6 không bơm đủ target RPS
```

vì không có target RPS trong ramping-vus.

#### Cách phân tích sâu chart Execution timeline

Chart này trả lời câu hỏi khác hẳn Response time:

```text
Response time chart:
  "request nhanh/chậm thế nào?"

Execution timeline:
  "tại mỗi giây, có bao nhiêu VUs active?
   Bao nhiêu checkout loop hoàn tất?
   Failures cluster ở stage nào?"
```

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs — có theo đúng stage shape 1→8→18→1 không?
2. HTTP reqs mỗi bucket — bao nhiêu request hoàn thành trong giây đó?
3. Iterations hoàn thành mỗi bucket — bao nhiêu checkout loop xong trong giây đó?
```

Với `ramping-vus`, shape "đẹp" thường là:

```text
stage 1 (ramp-up, 1→8 VU):
  Live VUs tăng từ 1 lên 8
  iter/s tăng dần theo VUs
  http_reqs tăng dần

stage 2 (promotion ramp, 8→18 VU):
  Live VUs tăng từ 8 lên 18
  iter/s tiếp tục tăng
  http_reqs tăng theo

stage 3 (peak, 18 VU):
  Live VUs = 18, phẳng
  iter/s ổn định (nếu backend khỏe) hoặc giảm dần (nếu external chậm)
  http_reqs ≈ iter/s × 3 (3 API/loop)

stage 4 (ramp-down, 18→1 VU):
  Live VUs giảm từ 18 về 1
  iter/s giảm theo VUs
  http_reqs giảm theo
  Có thể có tail iterations do gracefulRampDown
```

Điểm khác với constant-vus:

```text
constant-vus:
  VUs PHẲNG suốt duration
  Chỉ có 1 phase

ramping-vus:
  VUs THAY ĐỔI theo stage
  Có 4 phase riêng biệt
  → Mỗi phase có expected VU count và iter/s khác nhau
  → Phải verify VU shape trước khi đọc iter/s
```

Invalid patterns:

| Pattern | Nghĩa |
| --- | --- |
| VUs không theo stage shape | Config sai hoặc dashboard issue |
| VUs tăng nhưng iter/s = 0 kéo dài | Tất cả VU bị kẹt trong request → backend treo |
| VUs flat ở peak nhưng iter/s giảm dần | Closed-model slowdown (external chậm dần) |
| Failures cluster ở stage transition | Ramp-up/ramp-down shock |
| Failures chỉ ở stage 3 (peak) | Capacity limit — chỉ fail khi đủ load |
| http_reqs << iter/s × 3 | Có operation bị skip hoặc fail |
| Stage 4 có iterations dù VUs=1 | gracefulRampDown cho in-flight loops |

#### Batch 1 giây / time bucket

Mỗi point trên chart là 1 time bucket gom tất cả metric samples trong cùng 1 giây:

```text
01:09:19
→ mọi sample có timestamp trong khoảng 01:09:19.000 -> 01:09:19.999
→ được gom vào chung 1 point trên chart
```

Trong 1 bucket ở stage 3 (peak) có thể có:

```text
- 18 VU cùng chạy (mỗi VU đang ở 1 bước khác nhau trong checkout flow)
- Nhiều HTTP request hoàn thành (cả cart_add + create + confirm)
- Một số iteration/loop hoàn thành
- Nhiều check pass/fail
```

#### Vì sao bucket đầu có thể có httpReqs > 0 nhưng iterations = 0?

```text
Bucket đầu: VU vừa start, request cart_add đầu tiên đã xong
nhưng full loop (cart_add + create + confirm + check) chưa hoàn tất

→ httpReqs > 0 (request-level metric đến sớm)
→ iterations = 0 (loop-level metric đến muộn hơn, cần full flow xong)
```

### Chart 3 — VUs vs iter/s

Expected:

```text
VUs: ramp/plateau/ramp-down theo stages
iter/s: tăng theo VUs nếu backend còn capacity
iter/s: flatten/fall nếu flow duration tăng hoặc backend saturated
```

Bad/important shapes:

| Shape | Nghĩa |
| --- | --- |
| VUs follow stages, iter/s follows roughly | Healthy scaling shape |
| VUs rise, iter/s flat | Possible saturation/backpressure |
| VUs fall, iterations continue briefly | gracefulRampDown behavior |
| VUs not matching stages | Config/env/dashboard issue |

#### Cách phân tích sâu chart VUs vs iter/s

Chart này trả lời câu hỏi:

```text
Khi số checkout users tăng theo promotion timeline,
số checkout hoàn tất mỗi giây có tăng theo không?
Hay iter/s bị flatten/fall dù VUs vẫn tăng?
```

Với `ramping-vus`, đường `Executor VUs` và `Actual iter/s` có quan hệ:

```text
peak_rate_at_stage ≈ active_vus_at_stage / loop_duration

Stage 1 (avg ~4.5 VUs):  iter/s ≈ 4.5 / 1.15 ≈ 3.9/s
Stage 2 (avg ~13 VUs):   iter/s ≈ 13 / 1.15 ≈ 11.3/s
Stage 3 (18 VUs):        iter/s ≈ 18 / 1.15 ≈ 15.7/s
Stage 4 (avg ~9.5 VUs):  iter/s ≈ 9.5 / 1.15 ≈ 8.3/s

Nếu loop_duration = 4.05s (external chậm):
Stage 3 (18 VUs):        iter/s ≈ 18 / 4.05 ≈ 4.4/s
→ iter/s giảm 72% dù VUs vẫn 18!
```

Shape mong đợi:

```text
- stage 1: iter/s tăng dần theo VUs (ramp-up)
- stage 2: iter/s tiếp tục tăng (promotion ramp)
- stage 3: iter/s đạt đỉnh và ổn định (peak plateau)
- stage 4: iter/s giảm dần theo VUs (ramp-down)
- đường VUs: theo đúng shape 1→8→18→1
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| `Actual iter/s` tăng theo VUs trong stage 1-2 | Backend handle được ramp-up | Tốt |
| `Actual iter/s` ổn định trong stage 3 (peak) | Sustained capacity OK | Tốt |
| `Actual iter/s` giảm dần trong stage 3 dù VUs=18 | Closed-model degradation | Tín hiệu đúng — điều tra |
| `Actual iter/s` = 0 trong stage 3 dù VUs=18 | Tất cả VU bị kẹt | Khẩn cấp — backend treo |
| `Actual iter/s` không tăng khi VUs tăng (stage 2) | Backend không scale được | Điều tra bottleneck |
| VUs không theo shape 1→8→18→1 | Config/dashboard issue | Kiểm header/config |
| Stage 4 có iter/s > 0 dù VUs thấp | gracefulRampDown tail | Bình thường |

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận thresholds/failures.
2. VUs vs iter/s xác nhận stage shape và saturation signal.
3. Execution timeline xác nhận failures/throughput cluster ở phase nào.
4. Response time by operation tìm service/branch chậm.
5. Business decision dựa trên phase + operation + failure pattern.
```

---

## Kết luận thực tế: output -> quyết định

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| Clean checkout ramp | Promotion checkout capacity acceptable | Accept |
| Checkout create slow | Order/payment dependency bottleneck | Investigate create path |
| Confirm slow/failing | Payment finalization issue | Block checkout release |
| Iter/s flatten low failures | Backpressure/capacity signal | Investigate SLA before scaling |

### Kịch bản A — output sạch: PROMOTION CHECKOUT HEALTHY

```text
ramping_active_iterations.........: ~1043
ramping_active_iterations_failed..: 0
http_req_failed....................: 0.00%
checks..............................: 100%
checkout_ramp_cart_add count........: ≈ iterations
checkout_ramp_create count..........: ≈ iterations
checkout_ramp_confirm count.........: ≈ iterations
ramping_flow_duration_ms............: p(95)≈225ms

VUs chart: theo shape 1→8→18→1
iter/s chart: tăng theo VUs, ổn định ở peak
Response time: confirm > create > cart_add (expected ranking)
Stage 4 recovery: latency về baseline
```

Kết luận thực tế:

```text
- 0 failed loops → không đơn hàng nào thất bại
- Operation counts khớp → flow đầy đủ cart_add/create/confirm
- VUs theo đúng stage shape → timeline đúng
- iter/s tăng theo VUs → không có bottleneck
- Latency ranking đúng → confirm chậm nhất (external), cart_add nhanh nhất
- Stage 4 recovery tốt → hệ thống về bình thường sau peak
=> QUYẾT ĐỊNH: Promotion checkout capacity acceptable. Cho phép release.
```

### Kịch bản B — confirm fails ở peak (external payment down): BLOCK

```text
ramping_active_iterations.........: ~1043 (VUs vẫn loop)
ramping_active_iterations_failed..: ~350 (fail ở stage 3 peak)
http_req_failed....................: 11% (confirm requests fail ở peak)
checks..............................: 89%

checkout_ramp_cart_add count........: ~1043
checkout_ramp_create count..........: ~1043
checkout_ramp_confirm count.........: ~700 (350 fail, 350 pass)

http_req_duration confirm (stage 3)..: p(95)=30s (timeout)

VUs chart: theo shape 1→8→18→1
iter/s chart: giảm mạnh ở stage 3
Failures cluster: CHỈ ở stage 3 (peak 18 VUs)
```

Kết luận thực tế:

```text
- Cart_add OK, Create OK → cart service và order creation ổn
- Confirm fail ở stage 3 → external payment không handle được 18 concurrent
- Failures CHỈ ở peak → external capacity limit ở 18 VUs
- Stage 1-2 (1-8 VUs): confirm pass → external OK ở low concurrency
=> QUYẾT ĐỊNH: BLOCK release nếu promotion đạt 18 concurrent users.
   External payment cần scale hoặc cần circuit breaker.
   Đây là value của ramping-vus: biết chính xác external fail ở mức VU nào.
```

### Kịch bản C — external chậm ở peak → iter/s giảm: INVESTIGATE

```text
ramping_active_iterations.........: ~700 (thấp hơn baseline 1043)
ramping_active_iterations_failed..: 0 (tất cả loop thành công, nhưng ít hơn)
http_req_failed....................: 0.00%
checks..............................: 100%

ramping_flow_duration_ms (stage 3)..: p(95)=4.2s (tăng từ 0.23s)
http_req_duration confirm (stage 3)..: p(95)=3200ms (tăng từ 150ms)

VUs chart: theo shape 1→8→18→1
iter/s chart: tăng đến stage 2, nhưng FLAT ở stage 3 dù VUs=18
  → Stage 2 (8 VU): iter/s ≈ 6.5/s
  → Stage 3 (18 VU): iter/s ≈ 4.3/s (KHÔNG tăng dù VUs tăng 2.25x!)
```

Kết luận thực tế:

```text
- 0 failed loops → checkout vẫn hoạt động, chỉ chậm hơn
- Loop duration tăng ~18x ở peak → external payment là bottleneck
- iter/s KHÔNG tăng khi VUs tăng từ 8→18 → ĐÂY LÀ TÍN HIỆU ĐÚNG
- VUs tăng 2.25x nhưng iter/s giảm → external bão hòa ở khoảng 8 VUs
- Stage 4: iter/s và latency về bình thường → external recover
=> QUYẾT ĐỊNH: INVESTIGATE external payment provider.
   External bão hòa ở ~8 concurrent users.
   Tăng VUs không tăng throughput → không có lợi.
   Cần optimize external payment hoặc add circuit breaker.
   Đây là value CỐT LÕI của ramping-vus: tìm được saturation point.
```

### Kịch bản D — ramp-up shock (fail ở stage transition): INVESTIGATE

```text
ramping_active_iterations.........: ~1000
ramping_active_iterations_failed..: ~50 (chủ yếu ở stage 2 transition)
http_req_failed....................: 1.5%
checks..............................: 98.5%

checkout_ramp_create count..........: ~1000
checkout_ramp_confirm count.........: ~950 (50 fail ở ramp-up)

VUs chart: theo shape 1→8→18→1
iter/s chart: dips ở transition điểm (stage 1→2, stage 2→3)
Failures cluster: ĐẦU stage 2 và ĐẦU stage 3
```

Kết luận thực tế:

```text
- Failures tập trung ở transition → ramp-up shock
- Khi VUs tăng đột ngột, một số request fail
- Stage 3 plateau: ổn định sau transition → sustained capacity OK
- Vấn đề là KHỞI ĐỘNG concurrency, không phải DUY TRÌ
=> QUYẾT ĐỊNH: INVESTIGATE ramp-up behavior.
   Có thể cần: warm-up phase, connection pool pre-allocation,
   hoặc tăng ramp-up duration để transition mượt hơn.
   Đây là value của ramping-vus: phát hiện transition issue
   mà constant-vus không bao giờ thấy.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 0 fail, VUs theo shape, iter/s tăng theo VUs | Promotion checkout capacity khỏe | Accept |
| Confirm fail ở peak stage | External payment limit ở high concurrency | Block nếu peak đạt target |
| iter/s flat ở peak dù VUs tăng | External bão hòa, closed-model feedback | Investigate saturation point |
| Failures cluster ở stage transition | Ramp-up shock | Investigate warm-up/ramp duration |
| Stage 4 latency không về baseline | Hệ thống không recover sau peak | Investigate cleanup/resource leak |
| VUs không theo stage shape | Scenario/config issue | Kiểm config trước |
| Cart pass nhưng create fail | Order service issue (không phải cart) | Kiểm order service |
| Cart + create pass nhưng confirm fail | External payment issue | Kiểm external provider |

---

## "Nghịch lý" và misconceptions của ramping-vus

Đừng dùng arrival-rate để ép checkout RPS nếu câu hỏi là concurrent checkout users tăng theo promotion.

Nhớ 3 câu:

```text
stage target = absolute VU target, không phải delta
iterations/RPS = output, không phải input
VUs tăng mà iter/s flatten = tín hiệu backpressure đáng đọc
```

### Nghịch lý 1: "VUs tăng 2.25x (8→18) nhưng iter/s không tăng — đó là TỐT?"

```text
"Ủa, thêm VUs mà throughput không tăng là xấu mà?
 Sao lại nói là tín hiệu đúng?"

Trả lời: Có 2 lý do iter/s không tăng khi VUs tăng:

Lý do 1 — VU chết/config sai (XẤU):
  VUs không đạt target, VU crash → iter/s không tăng
  → Test không valid, không kết luận được gì

Lý do 2 — Closed-model saturation (TỐT — đúng mục đích):
  VUs đạt target (18), nhưng external payment chậm
  → loop_duration tăng → iter/s không tăng
  → Test valid, PHÁT HIỆN ĐÚNG vấn đề
  → Đây CHÍNH LÀ điều ramping-vus được thiết kế để làm:
    tìm ra saturation point — external bão hòa ở đâu

Giá trị thực tế:
  - Biết được: "external handle được ~8 concurrent, ở 18 thì bão hòa"
  - Không cần test 50, 100 VUs — đã biết saturation point
  - Nếu dùng arrival-rate: CHE vấn đề, không thấy saturation
```

### Nghịch lý 2: "Confirm 200 nhưng order vẫn có thể fail?"

```text
"Confirm trả 200 OK rồi, sao order có thể fail?
 Có phải bug của order service không?"

Trả lời: Đây là async inconsistency — không phải bug, là behavior thực tế.

Flow thực tế:
  1. Client gửi confirm → order service nhận, trả 200 "processing"
  2. Order service gửi request sang payment provider (ASYNC)
  3. Payment provider xử lý (có thể mất vài giây)
  4. Payment provider trả kết quả → order service update order state

Nếu bước 3-4 fail (insufficient funds, timeout...):
  - Bước 1: confirm HTTP 200 (vì order service nhận request OK)
  - Nhưng order state cuối cùng: "failed"

Trong case này, script check:
  - confirm HTTP 200 → pass
  - Nhưng không có status read (khác constant-vus checkout trickle)

Với checkout ramp:
  - Focus là capacity under ramping concurrency
  - Confirm 200 được coi là pass (không đọc status sau confirm)
  - KHÁC với checkout trickle (constant-vus): có status read

Nếu muốn thêm status verification:
  - Thêm GET /api/sim/orders/:id sau confirm
  - Check body.status == "confirmed"
  - Giống flow trong constant-vus checkout trickle
```

### Nghịch lý 3: "Stage target = 8 có nghĩa là thêm 8 VUs?"

```text
"Stage 1 target=8 nghĩa là thêm 8 VUs nữa hả?"

Trả lời: KHÔNG. Stage target là ABSOLUTE VU count ở cuối stage.

Đúng:
  startVUs=1, stage 1 target=8 → đi từ 1 đến 8 (tăng 7 VUs)
  stage 2 target=18 → đi từ 8 đến 18 (tăng 10 VUs)
  stage 4 target=1 → đi từ 18 đến 1 (giảm 17 VUs)

Sai:
  stage 1 target=8 → thêm 8 VUs (từ 1 lên 9)
  stage 2 target=18 → thêm 18 VUs (từ 9 lên 27)

Nếu đọc sai:
  - Stage 1: expect 1+8=9 VUs, thực tế 8 VUs → tưởng thiếu
  - Stage 3: expect 9+18=27 VUs, thực tế 18 VUs → tưởng thiếu
  - Kết luận sai: "k6 không đạt target VUs"
  - Thực tế: k6 đạt đúng target, mình đọc sai config

→ Đây là nguyên nhân #1 của invalid bug report cho ramping-vus.
```

---

## Checklist đọc biểu đồ case 04

Khi học sinh nhìn dashboard case 04, đọc theo thứ tự này:

```text
1. Overview KPI
   - ramping_active_iterations_failed < 20?
   - http_req_failed < 1%?
   - checks > 99%?
   - vus_max ≈ 18?

2. VUs vs iter/s chart (QUAN TRỌNG NHẤT)
   - VUs theo đúng shape 1→8→18→1?
   - iter/s tăng theo VUs trong stage 1-2?
   - iter/s ổn định trong stage 3 (peak)?
   - Nếu iter/s flat ở stage 3 → closed-model saturation signal
   - Stage 4: iter/s giảm theo VUs?
   - Có tail iterations ở stage 4? (gracefulRampDown)

3. Response time chart
   - Tách theo operation (cart_add vs create vs confirm) chưa?
   - Confirm có phải operation chậm nhất không?
   - Confirm latency có tăng theo stage không?
   - Stage 3 (peak): latency có ổn định hay tăng dần?
   - Stage 4 (recovery): latency có về baseline không?

4. Execution timeline
   - Live VUs theo đúng stage shape?
   - RPS/iter/s thay đổi theo stage?
   - Failures cluster ở stage nào? (transition hay peak?)
   - http_reqs ≈ iter/s × 3? (3 API/loop)
   - Có bucket nào bất thường không?

5. Business decision
   - Tất cả thresholds pass?
   - ramping_active_iterations_failed = 0 (hoặc < 20)?
   - Operation breakdown hợp lý (cart_add ≈ create ≈ confirm)?
   - Nếu iter/s flat ở peak: do external chậm (TỐT — phát hiện) hay do config sai?
   - Recovery OK? (stage 4 latency về baseline)
```

Kết luận của run case 04 đang đúng nếu thấy:

```text
ramping_active_iterations_failed < 20
http_req_failed < 1%
checks > 99%
VUs theo shape 1→8→18→1
iter/s tăng theo VUs, ổn định ở peak
confirm p95 > create p95 > cart_add p95 (expected ranking)
checkout_ramp_cart_add count ≈ checkout_ramp_create count ≈ checkout_ramp_confirm count
Stage 4 latency về baseline (recovery)
executor = ramping-vus
scenario = checkout_ramp
```

---

## Mở rộng

- Tăng duration scale để chạy gần business timeline hơn.
- Tăng peak VUs để tìm capacity knee.
- Tăng/giảm sleep để xem think time ảnh hưởng iter/s.
- Thêm threshold theo operation p95 nếu muốn biến case thành gate.
- Sau khi chạy thật, thêm real-run section riêng có command/env/run ID/số summary.

### Variation 1: Tăng peak VUs để tìm saturation point

```powershell
$env:RV_04_PEAK_VUS = 36
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-04-checkout-ramp.js
```

Từ 18 → 36 VUs ở peak. Quan sát:
- iter/s có tăng gấp đôi không? (36/18 = 2x expected)
- Nếu iter/s không tăng: đã tìm thấy saturation point
- Confirm latency ở 36 VUs so với 18 VUs?

```text
Nếu iter/s(36) ≈ iter/s(18) → saturation ở ~18 VUs
Nếu iter/s(36) ≈ 2 × iter/s(18) → còn room để scale
Nếu iter/s(36) < iter/s(18) → degradation (quá tải)
```

### Variation 2: Tăng duration scale để chạy gần business timeline hơn

```powershell
$env:RV_04_DURATION_SCALE = 1.0
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-04-checkout-ramp.js
```

Scale từ 0.25 → 1.0. Stage durations:
- Stage 1: 15s → 60s
- Stage 2: 23s → 90s
- Stage 3: 30s → 120s (2 phút peak!)
- Stage 4: 15s → 60s

→ Test sustained checkout capacity trong thời gian dài hơn
→ Phát hiện được slow degradation (memory leak, connection pool cạn)

### Variation 3: Giảm sleep để thấy upper bound throughput

```powershell
$env:RV_04_SLEEP_SECONDS = 0.1
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-04-checkout-ramp.js
```

Sleep từ 0.8s → 0.1s. Loop duration giảm, iter/s tăng.
Dùng để estimate max checkout throughput tại mỗi stage.

```text
loop_duration ≈ API_time + 0.1s
Stage 3 iter/s ≈ 18 / (API_time + 0.1s)
→ Đây là upper bound throughput cho 18 concurrent users "không nghỉ"
```

### Variation 4: Thêm latency threshold thành performance gate

```js
export const options = {
  thresholds: {
    "http_req_duration{operation:checkout_ramp_confirm}": ["p(95)<2000"],
    "http_req_duration{operation:checkout_ramp_create}": ["p(95)<500"],
    "ramping_flow_duration_ms": ["p(95)<3000"],
  },
};
```

Chuyển từ functional baseline sang performance gate. Nếu confirm p95 > 2s, test tự fail — không cần operator đọc dashboard.

### Variation 5: Ramp-up nhanh hơn — test shock resistance

```powershell
# Custom stage config: ramp-up nhanh trong 5s thay vì 15s
# Cần script hỗ trợ custom stages hoặc env override
```

Mô phỏng promotion flash sale: users ào vào rất nhanh.
Quan sát:
- Ramp-up shock có gây spike latency không?
- Có checkout bị fail ở transition không?
- Hệ thống có cần warm-up không?

---

## Code pattern đúng cho checkout ramp với ramping-vus

```js
import { check } from "k6";
import http from "k6/http";
import { sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";
const SLEEP_SECONDS = parseFloat(__ENV.RV_04_SLEEP_SECONDS || "0.8");

export const options = {
  scenarios: {
    checkout_ramp: {
      executor: "ramping-vus",
      startVUs: parseInt(__ENV.RV_04_START_VUS || "1"),
      stages: [
        { duration: "15s", target: parseInt(__ENV.RV_04_MID_VUS || "8") },
        { duration: "23s", target: parseInt(__ENV.RV_04_PEAK_VUS || "18") },
        { duration: "30s", target: parseInt(__ENV.RV_04_PEAK_VUS || "18") },
        { duration: "15s", target: parseInt(__ENV.RV_04_START_VUS || "1") },
      ],
      gracefulRampDown: "20s",
      tags: {
        case_id: "rv-04-checkout-ramp",
        business_case: "checkout_concurrency_ramp",
        executor_family: "ramping_vus",
        workload_shape: "staged_concurrency",
      },
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    ramping_active_iterations_failed: ["count<20"],
  },
};

export default function () {
  // === IDENTITY: VU = user, __ITER = attempt counter ===
  const userId = __VU;
  const attemptNum = __ITER;

  // Idempotency key: unique per user + attempt
  // __VU ổn định dù VU count thay đổi theo stage
  // __ITER tăng dần cho mỗi checkout của cùng user
  const idemKey = `idem-${userId}-${attemptNum}`;

  // === BƯỚC 1: Cart add ===
  const cartRes = http.post(`${BASE_URL}/api/sim/cart/add`, JSON.stringify({
    user_id: `user-${userId}`,
    items: [{ sku: `SKU-${(userId * 7 + attemptNum) % 100}`, qty: 1 }],
  }), {
    headers: { "Content-Type": "application/json" },
    tags: { operation: "checkout_ramp_cart_add", user_id: `user-${userId}` },
  });

  const cartOk = check(cartRes, {
    "cart_add HTTP 200": (r) => r.status === 200,
  });

  if (!cartOk) {
    // Cart add fail → loop fail, không tiếp tục
    return;
  }

  // === BƯỚC 2: Create checkout ===
  const createRes = http.post(`${BASE_URL}/api/sim/checkout`, JSON.stringify({
    user_id: `user-${userId}`,
    cart_id: cartRes.json("cart_id"),
  }), {
    headers: { "Content-Type": "application/json" },
    tags: { operation: "checkout_ramp_create", user_id: `user-${userId}` },
  });

  const createOk = check(createRes, {
    "checkout_create HTTP 200": (r) => r.status === 200,
  });

  if (!createOk) {
    // Create fail → loop fail, không confirm
    return;
  }

  const orderId = createRes.json("order_id");

  // === BƯỚC 3: Confirm order với idempotency key ===
  const confirmRes = http.post(`${BASE_URL}/api/sim/orders/${orderId}/confirm`,
    JSON.stringify({ payment_method: "card" }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idemKey,
      },
      tags: { operation: "checkout_ramp_confirm", user_id: `user-${userId}` },
    },
  );

  check(confirmRes, {
    "confirm HTTP 200": (r) => r.status === 200,
  });

  // Think time: mô phỏng user xem kết quả trước khi checkout tiếp
  sleep(SLEEP_SECONDS);
}
```

**KHÔNG viết thế này**:

```js
// SAI — dùng iterationInTest làm idempotency key
const idemKey = `idem-${exec.scenario.iterationInTest}`;
// iterationInTest là global loop counter, không gắn với user identity
// Trong ramping-vus, VU count thay đổi theo stage,
// iterationInTest càng không có ý nghĩa business

// SAI — không tag operation cho từng bước
http.post(`${BASE_URL}/api/sim/cart/add`, payload);
http.post(`${BASE_URL}/api/sim/checkout`, payload);
http.post(`${BASE_URL}/api/sim/orders/${orderId}/confirm`, payload);
// → Không phân biệt được bước nào fail
// → Aggregate che mất: "cart pass nhưng create fail"

// SAI — không có idempotency key
http.post(`${BASE_URL}/api/sim/orders/${orderId}/confirm`, payload);
// Thiếu Idempotency-Key header → payment provider có thể từ chối

// SAI — đọc stage.target như delta
// Stage 1 target=8: KHÔNG phải thêm 8 VUs
// Stage 1 target=8: LÀ absolute target, đi từ startVUs(1) đến 8

// SAI — kỳ vọng iter/s tăng tuyến tính với VUs
// Nếu external chậm, iter/s có thể flatten
// Đó là closed-model behavior, không phải bug
```

---

## Anti-pattern

- Đọc `stage.target` như số VUs cộng thêm.
- Kỳ vọng fixed RPS từ `ramping-vus`.
- Dùng total `iterations` làm pass/fail target.
- Bỏ qua `gracefulRampDown` khi thấy tail iterations.
- Chỉ nhìn aggregate p95 trong mixed/conditional flow.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với flat active users của `constant-vus`.
- Dùng `iterationInTest` làm idempotency key trong ramping-vus.
- Không tag `operation` cho từng bước trong multi-step flow.
- Kỳ vọng iter/s tăng tuyến tính với VUs mà không check external latency.
- Bỏ qua stage 4 recovery signal — chỉ đọc peak.
- Không so sánh latency giữa các stage (baseline vs peak vs recovery).
- Dùng `constant-arrival-rate` để "giữ checkout RPS ổn định" — nó CHE vấn đề external slowdown.
- Cho rằng "VUs tăng mà iter/s không tăng = bug" — đó là closed-model saturation signal.
- Không verify VU shape trước khi đọc các metric khác.

---

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Ramping-vus quick index: `../../20260517_01_ramping-vus-quick-index.md`
- Tham số/công thức: `../../20260517_02_ramping-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-04-checkout-ramp.js`
- Constant-vus contrast (checkout trickle): `../constant-vus/04_checkout-trickle.md`
- Shared-iterations contrast: `../shared-iterations/`
