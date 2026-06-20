# Case 02: Campaign launch spike

## Tình huống thực tế

Marketing launch gửi users vào campaign page trong thời gian ngắn. Traffic không tăng từ từ như ngày thường mà spike mạnh.

Người dùng luôn mở landing/list và product detail, rồi một phần add to cart.

Case này trả lời: products/cart có chịu được cú jump 1 -> 6 -> 36 VUs và có recover sau spike không?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 1 -> 6 -> 36 -> 8 -> 1
Scenario: campaign_launch_spike
Exec function: campaignLaunchSpike
Team/service focus: marketing/products/cart
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 1 -> 6 -> 36 -> 8 -> 1,
latency/failures/iter-s/RPS phản ứng như thế nào?
```

### Bối cảnh thực tế đầy đủ hơn

```text
Trigger: team marketing muốn chắc chắn hệ thống chịu được
         spike traffic khi campaign launch được công bố trên
         social media / push notification / email blast.

Business reality:
  - Prelaunch: chỉ có vài user vào xem trước landing page
  - Launch moment: link được publish, traffic nhảy vọt trong
    vài giây — user từ 6 lên 36 active gần như ngay lập tức
  - Spike plateau: traffic giữ ở peak trong khoảng thời gian
    ngắn, user đổ vào xem sản phẩm campaign và add to cart
  - Recovery: traffic giảm dần khi campaign buzz hạ nhiệt,
    user quay về mức bình thường
  - Không có "danh sách việc cần làm xong" (không backlog)
  - Không có "target RPS cần đạt" (không SLA arrival-rate)

Risk nếu hiểu sai model:
  - Dùng constant-vus flat 36: bỏ qua prelaunch/recovery
    → không test được transition shock và khả năng recover
  - Dùng constant-arrival-rate: ép RPS cố định
    → che mất behavior "user tăng đột ngột rồi giảm"
  - Dùng shared-iterations: ép drain hết N jobs
    → không observation window theo stage timeline
  - Kỳ vọng fixed RPS: campaign traffic thật không có
    RPS target cố định — nó là concurrency spike
```

### Nhân vật chính của case này: CÚ JUMP 6 -> 36

```text
Không giống daily traffic curve (tăng/giảm từ từ theo giờ),
campaign spike có một cú jump RẤT GẤP từ prelaunch lên peak.

Từ 6 VU lên 36 VU trong 8 giây (effective duration với scale 0.25):
  step_interval ≈ 8s / (36 - 6) = 8s / 30 ≈ 0.27s mỗi VU mới được activate

Mỗi 0.27 giây, hệ thống nhận thêm 1 active user mới.
Trong 8 giây, từ 6 user → 36 user: tăng GẤP 6 LẦN concurrency.

Đây là stress test THẬT cho:
  - Connection pool (mở 30 connections mới trong 8s)
  - Cache (cold cache cho user mới, các user cũ đã warm)
  - Database fanout (36 user cùng query products đồng loạt)
  - Service discovery / load balancer (phân phối 30 user mới)

Nếu hệ thống sống qua cú jump này, campaign launch được coi là an toàn.
```

## Vì sao "Campaign launch spike" có 2 yêu cầu cốt lõi — và chỉ `ramping-vus` thỏa mãn cả 2

Trước khi vào kỹ thuật, hiểu **mục tiêu** của campaign launch spike trước:

```text
Campaign launch spike = "active users tăng đột ngột từ prelaunch
                         lên spike, giữ peak, rồi recover về idle,
                         quan sát hệ thống phản ứng ra sao qua
                         TỪNG STAGE của timeline"

Đời thường:
  6 khách đang xem campaign landing trước giờ launch
  Link được publish → 30 khách nữa ập vào trong vài giây
  36 khách cùng browse campaign products, add to cart
  Sau 1-2 phút peak, buzz giảm → còn 8 khách, rồi 1 khách
  Không ai ép họ phải "mua đủ N món" hay "xem đúng M sản phẩm"
  Họ vào theo concurrency wave, rồi rời đi tự nhiên
```

Để campaign launch spike **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ ramping-vus mới thỏa mãn cả 2.

### Yêu cầu (a): STAGED SPIKE CONCURRENCY (active users đi theo stage timeline)

**Ý nghĩa**: Phải tạo được shape 1 -> 6 -> 36 -> 8 -> 1 với active users thay đổi THEO THỜI GIAN. Đây là input chính — ta muốn biết "nếu concurrency spike từ 6 lên 36 trong 8 giây, rồi giảm, hệ thống ra sao". Không phải "36 user tạo ra bao nhiêu RPS".

**Ví dụ cụ thể**:

```text
Scenario: team marketing muốn test campaign launch spike

Trường hợp A (staged concurrency ĐÚNG — ramping-vus):
  Stage 1: 1 -> 6 VUs trong 11s (prelaunch warm)
  Stage 2: 6 -> 36 VUs trong 8s (SHARP SPIKE)
  Stage 3: giữ 36 VUs trong 23s (spike plateau)
  Stage 4: 36 -> 8 VUs trong 15s (recovery)
  Stage 5: 8 -> 1 VUs trong 8s (back to idle)
  → Quan sát latency/failures/iter-s ở TỪNG STAGE
  → Thấy được: spike có làm hệ thống ngã không? recovery có xảy ra không?

Trường hợp B (concurrency SAI — dùng constant-vus 36):
  Giữ 36 VU phẳng trong toàn bộ duration
  → Không có prelaunch, không có recovery
  → Không biết: "cú jump từ 6 lên 36 có gây shock không?"
  → Không biết: "sau spike, hệ thống có recover không?"
  → Kết luận thiếu: "36 user steady thì ổn" nhưng "jump lên 36 thì sao?"

Trường hợp C (concurrency SAI — dùng arrival-rate):
  Target RPS thay đổi theo thời gian
  → K6 tự quyết định VUs để đạt RPS
  → Không kiểm soát được concurrency thật
  → Không biết: "36 user thật có làm hệ thống sập không?"
  → Vì arrival-rate có thể spawn 50 VU để giữ RPS nếu backend chậm
```

**Vì sao staged concurrency quan trọng hơn fixed RPS cho case này?**

```text
Trong thực tế, campaign launch KHÔNG có RPS target.
Marketing publish link → users tự vào → traffic spike.
Điều ta cần biết: "hệ thống có chịu được CÚ JUMP CONCURRENCY không?"

Nếu dùng arrival-rate:
  → Ta set RPS target, K6 spawn VU để đạt target
  → Backend chậm → K6 spawn thêm VU → concurrency tăng ngoài kiểm soát
  → Kết luận SAI: "hệ thống yếu" nhưng thực ra concurrency đã vượt xa 36

Nếu dùng ramping-vus:
  → Ta set đúng 36 VU max, K6 giữ concurrency theo stage
  → Backend chậm → iter/s giảm, VU vẫn đúng 36
  → Kết luận ĐÚNG: "với 36 concurrent users, latency là X, failures là Y"
```

### Yêu cầu (b): SPIKE PRESSURE VISIBILITY (thấy được áp lực spike qua throughput và latency)

**Ý nghĩa**: Khi VU jump từ 6 lên 36 trong thời gian ngắn, ta phải THẤY ĐƯỢC phản ứng của hệ thống: latency có tăng đột biến không? iter/s có theo kịp VU ramp không? Failures có cluster ở spike stage không? Nếu dùng executor che mất transition, ta không thấy được áp lực thật của spike.

**Ví dụ cụ thể**:

```text
ramping-vus với shape 1->6->36->8->1, loop_duration trung bình 0.3s:

  Prelaunch (6 VU):
    iter/s ≈ 6 / 0.3 = 20 iter/s
    RPS ≈ 20 × 2.5 = 50 req/s
    Latency p95: ổn định quanh 50ms

  Spike ramp (6->36 VU trong 8s):
    VU tăng: 6, 7, 8, ... 36
    iter/s TĂNG THEO: 20, 23, 27, ... 120 (nếu backend khỏe)
    HOẶC iter/s FLATTEN ở ~60 (nếu backend saturated)
    Latency p95: CÓ THỂ tăng đột biến
    → ĐÂY LÀ CỬA SỔ QUAN SÁT QUAN TRỌNG NHẤT

  Spike plateau (36 VU):
    iter/s ≈ 36 / 0.3 = 120 iter/s (nếu backend khỏe)
    RPS ≈ 120 × 2.5 = 300 req/s
    → Nếu iter/s < 120: backend đang saturated
    → Nếu latency p95 tăng ở plateau: không đủ capacity cho 36 concurrent

  Recovery (36->8->1):
    VU giảm, iter/s giảm theo
    Latency CÓ GIẢM LẠI KHÔNG?
    → Nếu latency vẫn cao sau khi VU giảm: hệ thống không recover
    → Có thể: resource leak, queue buildup, connection pool không release

constant-arrival-rate với target RPS:
  → RPS target cố định, VU thay đổi
  → Không thấy được "iter/s có theo kịp VU ramp không?"
  → Không thấy được "recovery có xảy ra không?"
  → CHE MẤT toàn bộ transition dynamics
```

### Phân tích sâu: vì sao 5 executor "không phải ramping-vus" không phù hợp?

`constant-vus` với `vus=36, duration=...`:

```text
Vấn đề: giữ concurrency phẳng, bỏ qua transition dynamics.

Nếu dùng constant-vus 36:
  - 36 VU active từ t=0 đến hết duration
  - Không có giai đoạn prelaunch (chỉ 1-6 VU)
  - Không có giai đoạn spike ramp (6->36 trong 8s)
  - Không có giai đoạn recovery (36->8->1)
  - Không có gracefulRampDown behavior

  → Mất toàn bộ thông tin về:
    - Cold start khi user mới vào
    - Connection pool ramp-up
    - Cache warm-up trong giai đoạn ramp
    - System recovery after peak

  constant-vus trả lời: "36 user steady thì sao?"
  ramping-vus trả lời: "jump từ 6 lên 36 user trong 8s thì sao?"
  → 2 câu hỏi KHÁC NHAU

Tuy nhiên, constant-vus 36 CÓ THỂ dùng làm BASELINE SO SÁNH:
  - Run constant-vus 36 trước: biết "steady 36 user" latency baseline
  - Run ramping-vus spike sau: so sánh latency spike stage vs baseline
  - Nếu spike latency >> baseline: transition shock là có thật
```

`shared-iterations` với `vus=36, iterations=???`:

```text
Vấn đề: không biết đặt iterations bằng bao nhiêu, và không có stage timeline.

Nếu iterations = 1000:
  - Backend nhanh (loop=0.3s): 1000 / (36/0.3) ≈ 8.3s là xong
  - Backend chậm (loop=0.6s): 1000 / (36/0.6) ≈ 16.7s là xong
  - Cả 2 đều xong trước khi kịp observation

Nếu iterations = 10000:
  - Backend nhanh: 10000 / 120 ≈ 83s
  - Backend chậm: 10000 / 60 ≈ 167s
  - Duration KHÔNG cố định → không so sánh được giữa các run

Cốt lõi:
  - shared-iterations trả lời: "xử lý hết N job trong bao lâu?"
  - ramping-vus trả lời: "trong timeline T, concurrency spike tạo ra behavior gì?"
  - shared-iterations không có stage timeline → không có prelaunch/spike/recovery
```

`per-vu-iterations` với `vus=36, iterations=30`:

```text
Vấn đề: ép mỗi VU chạy đúng 30 vòng, không có stage timeline.

36 VU, mỗi VU 30 iterations:
  - VU nhanh: xong 30 vòng trong 9s, rồi IDLE
  - VU chậm: xong 30 vòng trong 18s
  - Không có stage concept: tất cả VU start cùng lúc
  - Không có prelaunch, không có spike ramp, không có recovery

Ngoài ra:
  - Campaign user thật không có quota "phải xem đúng 30 sản phẩm"
  - Họ vào, browse, rồi rời đi tự nhiên theo thời gian
  - per-vu-iterations ép quota = làm sai behavior model
```

`constant-arrival-rate` với `rate=..., duration=...`:

```text
Vấn đề: input là arrival rate, không phải active concurrency.

Demo trace so sánh:
  Tình huống: giữa spike plateau, products-service bị chậm
              (loop_duration 0.3s → 0.6s)

  ramping-vus (36 VU):
    iter/s: 120 → 60 (GIẢM, tín hiệu rõ)
    VUs: 36 → 36 (không đổi)
    → Phát hiện: "36 user đang bị chậm ở spike plateau"

  constant-arrival-rate (target RPS cố định):
    RPS: không đổi (được giữ bởi K6)
    VUs: 36 → 72 (TĂNG để bù)
    → Thấy: "VU tăng, latency tăng"
    → Không biết: "36 user thật có bị ảnh hưởng không?"
    → Kết luận sai về capacity (72 VU là giả tạo)

  Cốt lõi:
    - Campaign launch là BÀI TOÁN CONCURRENCY, không phải arrival-rate
    - Marketing không nói: "tôi muốn 300 RPS"
    - Marketing nói: "tôi sẽ publish link, user sẽ ập vào"
    - Số user ập vào là input → ramping-vus đúng
```

`ramping-arrival-rate` với ramp rate:

```text
Vấn đề: input là arrival rate thay đổi, không phải concurrency.

ramping-arrival-rate:
  - Input: RPS target tăng/giảm theo stage
  - Output: VU (bao nhiêu VU cần để đạt RPS đó)

ramping-vus:
  - Input: VU target tăng/giảm theo stage
  - Output: RPS (RPS sinh ra từ VU pool đó)

→ Cả 2 đều có "ramping" và "stage" nhưng INPUT KHÁC NHAU

Với campaign launch:
  - Ta biết: "sẽ có 36 user active ở peak"
  - Ta KHÔNG biết: "36 user sẽ tạo ra bao nhiêu RPS" (vì RPS phụ thuộc backend)
  - → Input là VU → ramping-vus đúng

  Nếu requirement là: "hệ thống phải chịu được 300 RPS ở peak"
  - → Đó là capacity planning, input là RPS → ramping-arrival-rate
  - Nhưng campaign launch không có RPS target cứng
```

### Tổng kết: chỉ ramping-vus thỏa mãn cả (a) và (b)

| Executor | (a) Staged spike concurrency | (b) Spike pressure visibility | Verdict |
| --- | --- | --- | --- |
| **ramping-vus** | ✓ VU đi theo stage timeline 1->6->36->8->1 | ✓ iter/s/latency/failures tracked per stage | ✅ DÙNG |
| constant-vus | ✗ concurrency phẳng, không có stage | △ thấy được steady behavior, không thấy transition | ❌ |
| shared-iterations | ✗ không có stage timeline | ✗ duration không cố định, không observation window | ❌ |
| per-vu-iterations | ✗ không có stage, VU chạy quota rồi idle | ✗ không có timeline-based observation | ❌ |
| constant-arrival-rate | ✗ VU thay đổi để giữ rate, không kiểm soát concurrency | ✗ RPS cố định → che transition dynamics | ❌ |
| ramping-arrival-rate | ✗ input là RPS, không phải concurrency | △ thấy được latency nhưng VU là output | ❌ |

→ Chỉ **ramping-vus** thỏa mãn cả 2 yêu cầu, các executor khác đều fail ở ít nhất 1 trong 2.

## Yêu cầu cứng của case này

- Stage shape phải thể hiện prelaunch -> spike -> recovery.
- Thresholds hơi relaxed hơn baseline vì spike cố ý volatile.
- Cart add là conditional, không được expect mỗi iteration đều add cart.
- Latency phải đọc riêng landing/detail/cart.

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| VU shape phải theo 1->6->36->8->1 | Input chính của case là staged concurrency spike. Nếu VU không theo shape, mô hình sai. |
| Spike ramp 6->36 phải đủ gấp (step_interval nhỏ) | Cú jump gấp mới tạo được transition shock cần test. Nếu ramp quá chậm, không khác gì daily curve. |
| Chạy đủ 5 stage, không dùng total iterations làm target | Duration là observation window. Mỗi stage có ý nghĩa riêng: prelaunch, spike, plateau, recovery, idle. |
| Cart add là conditional (mỗi second iteration) | Không phải iteration nào cũng add cart. Count cart ~50% iterations. |
| Failed user loops phải thấp hơn `ramping_active_iterations_failed count<40` | User loop fail nghĩa là user không hoàn tất flow trong campaign. |
| `http_req_failed` rate < 0.02 | Spike có thể gây transient failure; threshold relaxed hơn baseline 0.01. |
| `checks` rate > 0.98 | Status/contract checks phải pass; threshold relaxed hơn baseline 0.99 vì spike volatile. |
| Latency phải đọc riêng landing/detail/cart | Aggregate che mất operation nào chậm trong spike. |
| Recovery stage phải được đọc riêng | Sau spike, latency/failures phải giảm. Nếu không, hệ thống không recover. |

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

## Vì sao "Campaign launch spike" nên dùng `ramping-vus`?

Campaign launch là staged concurrency spike. `ramping-vus` đúng vì active users tăng rất nhanh rồi recover; constant-vus không diễn tả được spike, arrival-rate lại ép arrivals thay vì active users.

Mental model:

```text
Active VUs follow stage timeline.
Each active VU loops the business flow sequentially.
Backend latency changes completed loop rate.
```

Nếu backend nhanh:

```text
loop_duration nhỏ → mỗi VU hoàn tất nhiều loops hơn → iter/s và RPS cao
Spike ramp: iter/s tăng gần như tuyến tính với VUs
```

Nếu backend chậm:

```text
loop_duration tăng → mỗi VU hoàn tất ít loops hơn → iter/s flatten
Spike ramp: VUs tăng nhưng iter/s không theo kịp
→ Đây là TÍN HIỆU: backend đang saturated ở spike
```

Nếu backend chậm nhưng chỉ ở 1 operation (ví dụ product detail):

```text
Loop duration tăng vì product detail chậm
→ iter/s giảm
→ Tách operation mới thấy: landing vẫn nhanh, detail đang chậm
→ Vấn đề nằm ở products-service, không phải toàn hệ thống
```

## STAGE TIMELINE DEEP DIVE — Trái tim của ramping-vus spike case

Đây là phần quan trọng nhất để hiểu campaign launch spike. Mỗi stage có một ý nghĩa business và kỹ thuật riêng.

### Công thức stage timeline

```text
fromVUs = startVUs hoặc previous stage target
toVUs = current stage target
step_interval ≈ stage.duration / abs(toVUs - fromVUs)

Tại mỗi step_interval, 1 VU được activate (ramp-up) hoặc deactivate (ramp-down).

Với helper scaleSeconds(seconds, scale):
  effective_duration = max(1, round(seconds * scale)) seconds
```

### Stage 1: Prelaunch warm (1 -> 6 VUs, raw 45s, effective 11s)

```text
Business: Trước giờ launch, một vài user vào xem campaign landing.
          Đây là "quiet before the storm."

Technical:
  fromVUs=1, toVUs=6, duration=11s
  step_interval ≈ 11s / (6-1) = 11s / 5 ≈ 2.2s mỗi VU
  → Ramp rất nhẹ, mỗi 2.2s thêm 1 user

Mục đích:
  - Warm up connection pool (từ 1 lên 6 connections)
  - Fill cache cho campaign products (user đầu tiên miss cache,
    các user sau hit cache)
  - Thiết lập baseline latency ở low concurrency

Điều cần quan sát:
  - Cold start latency ở VU đầu tiên có cao không?
  - Cache có warm up đủ nhanh không?
  - 6 VU có gây ra vấn đề gì không? (thường là không, nhưng
    cần baseline để so sánh với spike)
```

### Stage 2: SHARP SPIKE RAMP (6 -> 36 VUs, raw 30s, effective 8s) — STAGE QUAN TRỌNG NHẤT

```text
Business: Link campaign được publish! User ập vào.
          Đây là KHOẢNH KHẮC QUAN TRỌNG NHẤT cần test.

Technical:
  fromVUs=6, toVUs=36, duration=8s
  step_interval ≈ 8s / (36-6) = 8s / 30 ≈ 0.27s mỗi VU
  → Mỗi 0.27 giây, 1 VU mới được activate
  → Trong 8 giây, hệ thống nhận thêm 30 active users
  → Tăng GẤP 6 LẦN concurrency (6x)

Tại sao step_interval=0.27s là CRITICAL:
  - Mỗi 0.27s: 1 VU mới bắt đầu loop đầu tiên
  - Loop đầu tiên của mỗi VU mới: 2-3 HTTP requests
  - Trong 1 giây: ~3.7 VU mới, mỗi VU tạo 2-3 requests
    → ~9-11 requests mới mỗi giây từ VU MỚI
  - Cộng với requests từ 6 VU cũ đang loop
    → Tổng request rate tăng nhanh trong 8s

Điều cần quan sát (QUAN TRỌNG NHẤT):
  1. Latency có spike đột biến trong 8s này không?
     - p95 product detail: có tăng vọt từ 50ms → 300ms không?
     - p95 landing: có bị ảnh hưởng bởi cache miss không?
  
  2. iter/s có tăng theo kịp VU ramp không?
     - Nếu iter/s tăng gần tuyến tính: backend khỏe
     - Nếu iter/s flatten dù VU đang tăng: backend saturated
     - Đây là TÍN HIỆU QUAN TRỌNG NHẤT
  
  3. Failures có xuất hiện trong 8s này không?
     - http_req_failed có > 0 không?
     - Có request nào bị timeout/refused không?
     - Nếu có: connection pool không kịp mở rộng
  
  4. Cold cache impact trên VU mới:
     - VU đầu tiên trong 30 VU mới: cache miss
     - DB query cho campaign products → latency cao hơn
     - Các VU sau: cache hit → latency thấp hơn
     - Pattern: p95 cao ở đầu stage 2, giảm dần khi cache fill

So sánh với daily traffic curve (case 01):
  - Daily curve: ramp từ 2->24 trong 1 phút → step_interval lớn
  - Campaign spike: ramp từ 6->36 trong 8s → step_interval CỰC NHỎ
  - Campaign spike KHÓC LIỆT HƠN NHIỀU vì step_interval nhỏ hơn ~20 lần
```

### Stage 3: Spike plateau (giữ 36 VUs, raw 90s, effective 23s)

```text
Business: Campaign đang ở đỉnh buzz. 36 users cùng active,
          browse sản phẩm, add to cart.

Technical:
  fromVUs=36, toVUs=36, duration=23s
  step_interval = không có (giữ nguyên 36)
  → 36 VU active, mỗi VU loop liên tục

Mục đích:
  - Quan sát steady-state behavior ở peak concurrency
  - So sánh latency plateau vs latency ở stage 1 (prelaunch)
  - Xem hệ thống có ổn định ở 36 concurrent không?
  - Nếu có vấn đề (memory leak, connection pool cạn),
    nó sẽ lộ ra trong plateau

Điều cần quan sát:
  - Latency có ổn định trong suốt 23s không?
  - Hay latency tăng dần (dấu hiệu degradation)?
  - iter/s có ổn định không?
  - Cart add count có đúng tỷ lệ ~50% iterations không?
```

### Stage 4: Recovery (36 -> 8 VUs, raw 60s, effective 15s)

```text
Business: Campaign buzz bắt đầu hạ nhiệt. Users rời đi dần.
          Hệ thống bắt đầu "thở" trở lại.

Technical:
  fromVUs=36, toVUs=8, duration=15s
  step_interval ≈ 15s / (36-8) = 15s / 28 ≈ 0.54s mỗi VU
  → Mỗi 0.54s, 1 VU được deactivate
  → gracefulRampDown cho phép VU hoàn tất iteration đang chạy

Mục đích:
  - ĐÂY LÀ STAGE QUAN TRỌNG THỨ HAI (sau stage 2)
  - Kiểm tra: hệ thống có RECOVER sau spike không?
  - Nhiều hệ thống pass spike nhưng FAIL recovery

Điều cần quan sát:
  1. Latency có GIẢM khi VU giảm không?
     - Nếu latency vẫn cao: resource không release
     - Có thể: connection pool không thu hồi, memory không GC
  
  2. Failures có tiếp tục sau spike không?
     - Nếu failures vẫn xuất hiện ở stage 4: hệ thống bị
       "tổn thương" từ spike, chưa hồi phục
  
  3. iter/s có giảm tương ứng với VU không?
     - iter/s nên giảm khi VU giảm
     - Nếu iter/s giảm NHANH HƠN VU: có thể VU đang bị kẹt

  4. gracefulRampDown behavior:
     - VU được deactivate nhưng iteration đang chạy được finish
     - Có thể thấy iterations tiếp tục hoàn tất sau khi VU đã giảm
     - Đây là NORMAL — gracefulRampDown bảo vệ in-flight iterations
```

### Stage 5: Back to idle (8 -> 1 VUs, raw 30s, effective 8s)

```text
Business: Campaign kết thúc. Chỉ còn 1 user lẻ tẻ.
          Hệ thống trở về trạng thái idle.

Technical:
  fromVUs=8, toVUs=1, duration=8s
  step_interval ≈ 8s / (8-1) = 8s / 7 ≈ 1.14s mỗi VU

Mục đích:
  - Xác nhận hệ thống trở về trạng thái bình thường
  - Latency phải về gần baseline prelaunch
  - Không còn failures
  - Tất cả connections được release
```

### Tổng kết timeline: vì sao stage 2 và stage 4 là quan trọng nhất

```text
Stage 2 (spike ramp):  TRẢ LỜI "hệ thống có chịu được cú jump không?"
Stage 4 (recovery):    TRẢ LỜI "hệ thống có hồi phục sau spike không?"

Hai câu hỏi này KHÔNG THỂ trả lời bằng constant-vus hay arrival-rate.
Chỉ ramping-vus với stage timeline mới cho phép quan sát transition.

Pattern nguy hiểm:
  - Stage 2 pass (spike OK)
  - Stage 3 OK (plateau steady)
  - Stage 4 FAIL (recovery fail: latency vẫn cao, failures còn tiếp diễn)
  → Hệ thống bị "tổn thương" từ spike, không tự hồi phục
  → Đây là bug NGHIÊM TRỌNG mà constant-vus không phát hiện được
```

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

### Closed model trong ramping-vus

```text
ramping-vus là closed model, giống constant-vus.
Khác biệt: pool size THAY ĐỔI theo stage timeline.

Công thức closed model với pool size thay đổi:

  Tại thời điểm t, có V(t) active VUs:
    loop_duration_i(t) = API_time_i(t) + JS_time + sleep
    per_vu_rate_i(t) = 1 / loop_duration_i(t)
    iter/s(t) ≈ sum(per_vu_rate_i(t)) for i in active VUs at t
    RPS(t) ≈ iter/s(t) × avg_requests_per_loop

  Khi V(t) tăng (ramp-up):
    iter/s(t) TĂNG nếu backend còn capacity
    iter/s(t) FLAT nếu backend saturated
  
  Khi V(t) giảm (ramp-down):
    iter/s(t) GIẢM
    Nhưng có thể thấy tail iterations do gracefulRampDown
```

### Điểm khác biệt giữa closed model trong constant-vus và ramping-vus

```text
constant-vus:
  V(t) = constant
  iter/s thay đổi CHỈ do loop_duration thay đổi
  → Dễ phát hiện degradation: iter/s giảm = backend chậm

ramping-vus:
  V(t) = thay đổi theo stage
  iter/s thay đổi do CẢ V(t) VÀ loop_duration
  → Khó hơn: phải phân biệt "iter/s tăng do VU tăng" vs
    "iter/s lẽ ra phải tăng nhiều hơn nhưng bị kìm do backend chậm"

Cách phân biệt:
  - So sánh iter/s thực tế với iter/s lý thuyết
  - iter/s lý thuyết = VUs / loop_duration_baseline
  - Nếu iter/s thực tế << iter/s lý thuyết: backend saturated
  - Dùng stage 1 (prelaunch) làm baseline loop_duration
```

## Identity model trong ramping-vus: VU = active user với identity theo thời gian

Đây là điểm khác biệt quan trọng với constant-vus.

### VU identity trong ramping-vus

```text
Trong ramping-vus:
  - VU=1 được activate ở stage 1, SỐNG qua tất cả 5 stage
    (trừ khi bị deactivate ở ramp-down)
  - VU=7 đến VU=36 được activate TRONG stage 2 (spike ramp)
  - VU=9 đến VU=36 bị deactivate TRONG stage 4 (recovery)
  
  → VU identity = TEMPORAL ACTIVE USER
  → Một VU có identity ổn định KHI ĐANG ACTIVE
  → Nhưng VU có thể được activate/deactivate theo stage
  → Số VU active thay đổi theo thời gian

KHÁC với constant-vus:
  - constant-vus: VU=1 LUÔN active từ t=0 đến hết duration
  - ramping-vus: VU=1 active từ t=0, VU=36 chỉ active từ giữa stage 2
```

### Demo trace identity model với shape 1 -> 6 -> 36 -> 8 -> 1

```text
Config: startVUs=1, stages=[{11s,6},{8s,36},{23s,36},{15s,8},{8s,1}]

Timeline identity:

t=0.0s     Stage 1 bắt đầu: VU=1 (user-1) active, bắt đầu loop
t=2.2s     VU=2 (user-2) được activate
t=4.4s     VU=3 (user-3) được activate
t=6.6s     VU=4 (user-4) được activate
t=8.8s     VU=5 (user-5) được activate
t=11.0s    VU=6 (user-6) được activate → Stage 1 kết thúc (6 VU)

--- Stage 2: SHARP SPIKE ---
t=11.27s   VU=7 (user-7) activate
t=11.54s   VU=8 (user-8) activate
t=11.81s   VU=9 (user-9) activate
...
t=19.0s    VU=36 (user-36) activate → Stage 2 kết thúc (36 VU)

--- Stage 3: PLATEAU ---
t=19.0s đến t=42.0s: 36 VU active, mỗi VU loop liên tục
  VU=1 (user-1): đã chạy được ~40 loops (từ t=0)
  VU=36 (user-36): mới chạy được ~77 loops (từ t=19)
  → Các VU có số loops KHÁC NHAU vì thời gian active khác nhau

--- Stage 4: RECOVERY ---
t=42.0s    Bắt đầu ramp-down, VU=36 bị deactivate đầu tiên
t=42.54s   VU=35 deactivate
...
t=57.0s    Chỉ còn VU=1 đến VU=8 active → Stage 4 kết thúc

--- Stage 5: BACK TO IDLE ---
t=57.0s đến t=65.0s: ramp-down từ 8 → 1 VU
t=65.0s    Chỉ còn VU=1 active → Stage 5 kết thúc

Tổng kết:
  - VU=1 (user-1): active SUỐT 65s, hoàn tất nhiều loops nhất
  - VU=36 (user-36): active ~23s (từ giữa stage 2 đến đầu stage 4)
  - Mỗi VU có __VU ổn định trong thời gian active
  - iterationInTest là global loop counter cho toàn scenario
```

### Code pattern: dùng __VU làm user identity trong ramping-vus

```js
import exec from "k6/execution";

export default function () {
  // Trong ramping-vus, __VU là user identity khi VU đang active
  const userId = exec.vu.idInTest;  // 1..36, ổn định khi active

  // Có thể dùng userId cho:
  // - Campaign session riêng cho mỗi user
  // - User-specific headers/cookies
  // - Tracking user behavior qua nhiều loops

  const params = {
    tags: {
      user_id: `user-${userId}`,    // stable khi VU active
      vu: userId,
      case_id: "rv-02-campaign-launch-spike",
    },
  };

  // Campaign flow với user identity
  const landingRes = http.get(`${BASE_URL}/api/sim/products?...`, {
    ...params,
    tags: { ...params.tags, operation: "campaign_landing" },
  });
  // ...
}
```

```text
LƯU Ý: Trong ramping-vus, __VU không đảm bảo user identity XUYÊN SUỐT
toàn bộ duration như constant-vus. VU có thể được activate/deactivate.

Nhưng KHI ĐANG ACTIVE, __VU là stable — dùng được làm user_id.
```

## Technical root causes this case catches

Mỗi nguyên nhân dưới đây là một pattern lỗi thực tế mà ramping-vus spike case phát hiện được, nhưng các executor khác có thể bỏ sót.

### Nguyên nhân kỹ thuật 1: Sharp ramp exposes cold cache / fanout bottleneck

**Vấn đề**: Khi 30 VU mới được activate trong 8 giây (stage 2), mỗi VU mới bắt đầu loop đầu tiên với cold cache. Products-service có thể bị quá tải vì vừa phải serve request từ VU cũ (đã warm cache), vừa phải query DB cho VU mới (cold cache miss). Điều này tạo ra fanout bottleneck: 30 users cùng query products trong 8 giây, DB phải xử lý 30 lần query giống hệt nhau (cùng campaign products) thay vì 1 lần rồi cache.

**Real-world analogy**:

```text
Tưởng tượng một cửa hàng vừa mở cửa campaign:
  - 6 khách đã ở trong cửa hàng từ trước (prelaunch)
  - Cửa mở to → 30 khách ập vào cùng lúc
  - 30 khách mới cùng hỏi: "Sản phẩm campaign ở đâu?"
  - Nhân viên phải trả lời 30 lần cùng một câu hỏi
    (thay vì có bảng chỉ dẫn = cache)

  Nếu nhân viên (DB) không chịu nổi:
    - Khách hỏi lâu mới được trả lời (latency tăng)
    - Một số khách bỏ đi (timeout/failure)
    - Nhân viên quá tải, không phục vụ được ai (DB saturation)
```

**Demo trace: cold cache impact trong 8s spike ramp**

```text
Config: startVUs=1, stages=[{11s,6},{8s,36},...]
Giả sử loop_duration baseline (warm cache) = 0.3s

Stage 2, 8 giây spike ramp:

t=11.0s: 6 VU active, cache warm cho campaign products
  iter/s ≈ 6 / 0.3 = 20 iter/s
  latency p95: ~50ms (warm)

t=11.3s: VU=7 active, loop đầu tiên — COLD CACHE
  GET /api/sim/products → cache miss → DB query
  latency p95: ~120ms (lần đầu, cold)

t=11.6s: VU=8 active, loop đầu tiên
  GET /api/sim/products → cache HIT (VU=7 đã warm cache)
  latency p95: ~50ms

t=11.9s: VU=9 active, loop đầu tiên
  GET /api/sim/products/:id → random product → cache miss
  latency p95: ~100ms (product detail cold)

...

t=15.0s: 20 VU active, cache đang được fill dần
  Một số VU mới vẫn cold, một số VU cũ đã warm
  latency p95: dao động 50-150ms (mixed cold/warm)

t=19.0s: 36 VU active, cache đã warm cho hầu hết sản phẩm
  latency p95: ổn định ~50ms
  → Nhưng 8 giây ramp vừa qua có thể có latency spike

Nếu DB yếu:
t=13.0s: 10 VU active, 4 VU mới cùng query DB
  → DB bắt đầu bão hòa
  latency p95: 200ms (tăng)
t=16.0s: 25 VU active, DB đã saturated
  latency p95: 500ms (tăng mạnh)
  http_req_failed: bắt đầu > 0 (timeout)
t=19.0s: 36 VU, DB quá tải
  latency p95: > 1000ms
  Failures cluster ở stage 2
```

**Cách phát hiện trên dashboard**:

```text
Response time chart (theo operation):
  - Lọc operation=campaign_landing
  - Xem p95 trong stage 2 (11s-19s): có spike cao không?
  - Nếu p95 stage 2 >> p95 stage 1: cold cache impact
  - Nếu p95 stage 2 >> p95 stage 3: ramp shock, không phải capacity vấn đề
  - Nếu p95 vẫn cao ở stage 3: capacity vấn đề thật

Execution timeline:
  - Failures cluster ở stage 2: ramp shock
  - Failures cluster ở stage 2 VÀ stage 3: capacity không đủ

VUs vs iter/s:
  - Stage 2: iter/s lẽ ra tăng 6x (6->36 VU)
  - Nếu iter/s chỉ tăng 3x: backend saturated, loop_duration tăng
```

**Đừng nhầm**: cold cache latency spike ở stage 2 là EXPECTED ở lần chạy đầu tiên. Nếu chạy lại lần 2, cache đã warm → latency stage 2 thấp hơn. Đây là lý do nên chạy ít nhất 2 lần: lần 1 cold, lần 2 warm — so sánh để biết cold cache penalty.

### Nguyên nhân kỹ thuật 2: Conditional cart add — count không được expect mỗi iteration

**Vấn đề**: Cart add chỉ xảy ra mỗi second iteration (`iterationInTest % 2 === 0`). Đây là conditional branch — không phải weighted random như constant-vus. Nếu không hiểu điều này, có thể kết luận sai "cart service bị fail" khi thấy count cart thấp hơn landing/detail.

**Real-world analogy**:

```text
Trong campaign launch:
  - 100% user xem landing page (= campaign_landing)
  - 100% user xem product detail (= campaign_product_detail)
  - 50% user add to cart (= campaign_cart_add, mỗi second iteration)

  Đây là PATTERN CỐ Ý:
    Iteration lẻ: user chỉ browse (landing + detail)
    Iteration chẵn: user browse rồi add cart (landing + detail + cart_add)

  Không phải "50% user bỏ qua cart vì lỗi" — mà là "script cố ý
  chỉ add cart mỗi 2 iterations."
```

**Demo trace: operation distribution với conditional cart add**

```text
Run với 36 VU, tổng 4662 iterations (từ contract rerun #59):

Expected:
  campaign_landing:          4662 requests (100% iterations)
  campaign_product_detail:   4662 requests (100% iterations)
  campaign_cart_add:         2331 requests (50% iterations)
  → Tỷ lệ: 40% / 40% / 20% của tổng HTTP requests

Thực tế (từ run #59):
  campaign_product_detail:   4662 (40.00%)
  campaign_landing:          4662 (40.00%)
  campaign_cart_add:         2331 (20.00%)
  → Khớp chính xác!

Nếu cart_add << 50% iterations:
  - Cart branch bị fail → iteration không hoàn tất
  - Hoặc script conditional sai
  - KHÔNG phải "user không thích add cart"

Nếu cart_add > 50% iterations:
  - Script bug: conditional branch sai (luôn add cart)
  - Hoặc weighted random thay vì modulo
```

**Cách phát hiện**:

```text
Từ summary:
  - Đếm số request theo operation
  - cart_add count / iterations ≈ 0.50 (±5%)
  - Nếu << 0.50: cart branch fail hoặc script issue
  - Nếu >> 0.50: script issue (conditional sai)
  - Nếu = 0: cart branch bị skip hoàn toàn

So sánh với constant-vus case:
  - constant-vus dùng weighted random (70/25/5) → phân phối gần đúng
  - ramping-vus case 02 dùng MODULO (mỗi 2nd iteration) → phân phối CHÍNH XÁC
  - → Dễ verify hơn constant-vus!
```

### Nguyên nhân kỹ thuật 3: Recovery stage matters — không chỉ pass spike là đủ

**Vấn đề**: Nhiều hệ thống PASS spike (stage 2-3) nhưng FAIL recovery (stage 4-5). Sau spike, latency không giảm, failures vẫn tiếp tục, iter/s không về baseline. Đây là dấu hiệu của resource leak, connection pool không release, hoặc queue buildup.

**Real-world analogy**:

```text
Tưởng tượng cửa hàng sau campaign:
  - 36 khách ập vào lúc cao điểm
  - Nhân viên phục vụ xong (pass spike)
  - Khách dần rời đi, chỉ còn 8 khách
  - NHƯNG: nhân viên vẫn mệt, quầy vẫn lộn xộn,
    hệ thống POS vẫn chậm vì chưa kịp "nghỉ"
  - 8 khách còn lại vẫn bị phục vụ chậm dù cửa hàng vắng

  → Đây là RECOVERY FAILURE:
    Hệ thống bị "tổn thương" từ spike và không tự hồi phục.
```

**Demo trace: spike pass nhưng recovery fail**

```text
Run A — HEALTHY (cả spike và recovery đều OK):

  Stage 1 (prelaunch, 6 VU):
    latency p95 landing: 50ms
    latency p95 detail: 45ms
    failures: 0

  Stage 2-3 (spike, 36 VU):
    latency p95 landing: 120ms (tăng, chấp nhận được)
    latency p95 detail: 150ms (tăng, chấp nhận được)
    failures: 0-2 (transient, OK)

  Stage 4 (recovery, 8 VU):
    latency p95 landing: 55ms (GIẢM VỀ GẦN BASELINE)
    latency p95 detail: 50ms (GIẢM VỀ GẦN BASELINE)
    failures: 0

  → Kết luận: Healthy spike and recovery. Hệ thống ổn.

Run B — SPIKE PASS, RECOVERY FAIL:

  Stage 1 (prelaunch, 6 VU):
    latency p95 landing: 50ms
    latency p95 detail: 45ms
    failures: 0

  Stage 2-3 (spike, 36 VU):
    latency p95 landing: 200ms (tăng, vẫn pass threshold)
    latency p95 detail: 300ms (tăng, vẫn pass threshold)
    failures: 5 (dưới ngưỡng 40, PASS)

  Stage 4 (recovery, 8 VU):
    latency p95 landing: 180ms (KHÔNG GIẢM! Vẫn gần spike level)
    latency p95 detail: 250ms (KHÔNG GIẢM!)
    failures: 3 (VẪN CÒN failures dù VU đã giảm)

  → Kết luận: SPIKE GÂY TỔN THƯƠNG. Hệ thống không recover.
  → Nguyên nhân có thể:
    - Connection pool cạn, không release connection sau spike
    - Memory leak từ spike, GC chưa kịp dọn
    - Queue buildup từ spike vẫn đang được xử lý
    - DB lock chưa release từ transaction spike

  → ĐÂY LÀ BUG NGHIÊM TRỌNG mà constant-vus KHÔNG phát hiện được
    (vì constant-vus không có recovery stage)
```

**Cách phát hiện trên dashboard**:

```text
Response time chart:
  - So sánh p95 stage 1 (prelaunch) vs stage 4 (recovery)
  - Nếu p95 stage 4 >> p95 stage 1: recovery fail
  - So sánh p95 stage 4 vs stage 2-3 (spike)
  - Nếu p95 stage 4 ≈ p95 stage 2-3: hệ thống "kẹt" ở trạng thái xấu

Execution timeline:
  - Failures ở stage 4-5: recovery fail
  - Nếu failures tăng TRỞ LẠI ở stage 4: hệ thống không ổn định

VUs vs iter/s:
  - Stage 4: VU giảm 36->8, iter/s phải giảm theo
  - Nhưng iter/s giảm NHANH HƠN VU: loop_duration vẫn cao
  - → Backend vẫn đang "mệt" dù load đã giảm
```

### Nguyên nhân kỹ thuật 4: Relaxed thresholds are intentional — campaign spike có tolerance khác baseline

**Vấn đề**: Campaign spike là tình huống volatile có chủ ý. Không thể áp dụng threshold khắt khe như steady baseline. Thresholds relaxed (checks 98% thay vì 99%, http_req_failed 2% thay vì 1%) là ĐÚNG cho case này — nhưng learner thường không hiểu vì sao và áp dụng sai threshold.

**Real-world analogy**:

```text
So sánh 2 tình huống:

1. Siêu thị giờ bình thường (constant-vus baseline):
   - 20 khách, mọi thứ ổn định
   - Kỳ vọng: 99% khách hài lòng, <1% phàn nàn
   - Nếu 2% khách phàn nàn → CÓ VẤN ĐỀ

2. Siêu thị ngày Black Friday (campaign spike):
   - 36 khách ập vào cùng lúc
   - Kỳ vọng: 98% khách hài lòng, <2% phàn nàn
   - Nếu 2% khách phàn nàn → CHẤP NHẬN ĐƯỢC
     (vì đây là spike, không phải ngày thường)

Tương tự:
  - Baseline storefront: checks 99%, http_req_failed 1%
  - Campaign launch spike: checks 98%, http_req_failed 2%
  - Đây là SỰ KHÁC BIỆT CÓ CHỦ Ý, không phải "lỏng lẻo"
```

**Demo trace: vì sao không dùng threshold baseline cho spike**

```text
Run campaign spike với threshold baseline (99%/1%):

  checks: 98.5% → FAIL (dưới 99%)
  http_req_failed: 1.5% → FAIL (trên 1%)

  → Test FAIL. Nhưng spike 36 VU với 1.5% failure → có thật sự là fail?
  → Trong thực tế, campaign launch với 36 concurrent users,
    1.5% failure (~70 requests fail trên 4662) là CHẤP NHẬN ĐƯỢC
  → Nếu fail test vì threshold quá khắt khe:
    - Team sẽ giảm campaign scale (chỉ cho 20 users)
    - Nhưng thực ra 36 users vẫn ổn
    - → Quyết định SAI do threshold SAI

Run campaign spike với threshold relaxed (98%/2%):

  checks: 98.5% → PASS
  http_req_failed: 1.5% → PASS

  → Test PASS. Đúng với kỳ vọng thực tế.
  → Team tự tin launch campaign với 36 concurrent users.
```

**Khi nào relaxed threshold thành vấn đề**:

```text
Relaxed threshold CÓ GIỚI HẠN:
  - checks < 98%: vẫn FAIL — quá nhiều request sai
  - http_req_failed > 2%: vẫn FAIL — quá nhiều failure
  - ramping_active_iterations_failed >= 40: vẫn FAIL — quá nhiều user loop fail

Relaxed threshold KHÔNG có nghĩa là "bỏ qua mọi lỗi":
  - Vẫn phải check failures cluster ở stage nào
  - Vẫn phải check operation nào gây failure
  - Vẫn phải check failure có pattern không (transient vs systematic)

Nếu failures cluster ở stage 2 (spike ramp) với count < 40:
  → Transient spike failure, chấp nhận được

Nếu failures cluster ở stage 4 (recovery) với count > 10:
  → Recovery failure, CẦN ĐIỀU TRA dù dưới threshold 40
  → Vì recovery stage lẽ ra phải sạch
```

## Service/API flow

Flow pattern:

```text
Always campaign landing/list + product detail; cart add every second iteration.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| campaign_landing | products-service | GET | /api/sim/products | 200 | Campaign landing/list. |
| campaign_product_detail | products-service | GET | /api/sim/products/:id | 200 | Campaign product detail. |
| campaign_cart_add | cart-service | POST | /api/sim/cart/add | 200 | Conditional add to cart. |

### Flow của từng iteration

```text
ITERATION LẺ (iterationInTest % 2 !== 0) — BROWSE ONLY:
  1. GET /api/sim/products              → campaign_landing
  2. sleep(think_time)                  → user đọc landing
  3. GET /api/sim/products/:id          → campaign_product_detail
  4. sleep(think_time)                  → user đọc detail
  → Loop hoàn tất, VU bắt đầu loop mới

ITERATION CHẴN (iterationInTest % 2 === 0) — BROWSE + CART:
  1. GET /api/sim/products              → campaign_landing
  2. sleep(think_time)
  3. GET /api/sim/products/:id          → campaign_product_detail
  4. sleep(think_time)
  5. POST /api/sim/cart/add             → campaign_cart_add
  6. sleep(think_time)
  → Loop hoàn tất

→ Mỗi iteration có 2 requests (lẻ) hoặc 3 requests (chẵn)
→ Trung bình: 2.5 requests / iteration
→ Cart add count = iterations / 2 (exact, vì dùng modulo)
```

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
case_id       = rv-02-campaign-launch-spike
business_case = campaign_launch_spike
workload      = staged_concurrency
```

### Cách đọc metric với conditional cart add

```text
Để kiểm tra conditional cart add có đúng không:

  total_iterations = N (từ summary iterations)

  expected_landing_requests = N        (mỗi iteration có landing)
  expected_detail_requests  = N        (mỗi iteration có detail)
  expected_cart_requests    = N / 2    (mỗi second iteration có cart)

  Tổng HTTP requests expected = N + N + N/2 = 2.5 × N

  Với N = 4662:
    expected_landing = 4662
    expected_detail  = 4662
    expected_cart    = 2331
    expected_total   = 11655

  → Đây là EXACT expectation (vì dùng modulo, không phải random)
  → Nếu sai lệch > 1%: có vấn đề (script bug hoặc cart fail)
```

## Pass criteria

Thresholds theo backend script:

```text
checks: rate>0.98
http_req_failed: rate<0.02
ramping_active_iterations_failed: count<40
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

### Tại sao threshold relaxed hơn baseline?

```text
So sánh threshold giữa các case:

  constant-vus baseline (cv-01):
    checks > 0.99
    http_req_failed < 0.01
    constant_active_iterations_failed < 20

  ramping-vus spike (rv-02):
    checks > 0.98
    http_req_failed < 0.02
    ramping_active_iterations_failed < 40

  → Spike case relaxed vì:
    1. Spike ramp 6->36 trong 8s tạo ra transient pressure
    2. Cold cache trong ramp có thể gây transient failure
    3. Campaign launch thực tế chấp nhận rủi ro cao hơn ngày thường
    4. Failures dưới 40 trên tổng ~4662 iterations = < 0.86% failure rate
       → Vẫn chấp nhận được cho campaign
```

### Tại sao không có pass criteria cho iterations count?

```text
Tương tự constant-vus: iterations là OUTPUT, không phải target.

Nếu đặt: "iterations phải > 5000 mới pass":
  - Backend nhanh: 5000 iterations → PASS
  - Backend chậm: 4000 iterations → FAIL
  - Nhưng "backend chậm" mới là điều ta muốn PHÁT HIỆN!

Thay vào đó:
  - Dùng latency thresholds nếu muốn performance gate
  - Dùng failure thresholds cho correctness
  - Dùng VU shape verification cho config correctness
```

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-02-campaign-launch-spike.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6\ramping-vus\rv-02-campaign-launch-spike.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6\ramping-vus\rv-02-campaign-launch-spike.js
```

Override env vars để test kịch bản khác:

```powershell
# Tăng peak VUs để tìm capacity knee
$env:RV_02_SPIKE_VUS = 50
$env:RV_02_SLEEP_SECONDS = 0.1
k6 run -o cloud .\load-target\k6\ramping-vus\rv-02-campaign-launch-spike.js

# Tăng duration scale để chạy gần business timeline hơn
$env:RV_02_DURATION_SCALE = 1.0
k6 run -o cloud .\load-target\k6\ramping-vus\rv-02-campaign-launch-spike.js
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
RV_02_START_VUS = 1
RV_02_PRELAUNCH_VUS = 6
RV_02_SPIKE_VUS = 36
RV_02_RECOVERY_VUS = 8
RV_02_DURATION_SCALE = 0.25
RV_02_SLEEP_SECONDS = 0.2
gracefulRampDown = 20s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_02_START_VUS | 1 | Số active user khi bắt đầu scenario |
| RV_02_PRELAUNCH_VUS | 6 | Số user ở cuối stage prelaunch |
| RV_02_SPIKE_VUS | 36 | Số user ở peak spike |
| RV_02_RECOVERY_VUS | 8 | Số user sau khi recover |
| RV_02_DURATION_SCALE | 0.25 | Scale factor cho duration (0.25 = 1/4 thời gian thật) |
| RV_02_SLEEP_SECONDS | 0.2 | Think time giữa các thao tác |
| gracefulRampDown | 20s | Thời gian grace cho VU hoàn tất iteration khi bị dừng |

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 45s | 11s | 6 | prelaunch warm traffic |
| 2 | 30s | 8s | 36 | sharp spike |
| 3 | 90s | 23s | 36 | hold launch spike |
| 4 | 60s | 15s | 8 | recovery |
| 5 | 30s | 8s | 1 | back to idle |

Lưu ý:

```text
effective duration = scaleSeconds(raw_seconds, RV_NN_DURATION_SCALE)
scaleSeconds = max(1, round(raw_seconds * scale)) seconds
```

`stage.target` là absolute VU target ở cuối stage.

### Tính toán step_interval cho từng stage

```text
Stage 1: 1->6,  11s → step ≈ 11/5  = 2.20s  (nhẹ nhàng)
Stage 2: 6->36,  8s → step ≈ 8/30  = 0.27s  (CỰC GẤP!)
Stage 3: 36->36, 23s → giữ nguyên           (plateau)
Stage 4: 36->8,  15s → step ≈ 15/28 = 0.54s  (giảm từ từ)
Stage 5: 8->1,    8s → step ≈ 8/7   = 1.14s  (giảm chậm)

Stage 2 step_interval = 0.27s:
  → NHỎ NHẤT trong tất cả các stage
  → Nhanh gấp ~8 lần stage 1
  → Đây là lý do case này test SPIKE, không phải ramp từ từ
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = campaign_launch_spike
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 1 -> 6 -> 36 -> 8 -> 1
```

`vus_max` nên gần peak target nếu run đủ dài và dashboard sample bắt được peak.

Nếu VU shape không khớp:

```text
- VU max < 36: kiểm startVUs, stage targets, scale, maxVUs
- VU không về 1 ở cuối: gracefulRampDown quá dài hoặc stage 5 chưa kết thúc
- VU shape không mượt (bậc thang thô): dashboard sampling interval quá thưa
```

### Bước 3 — Check failures trước throughput

Đọc trước:

```text
checks
http_req_failed
ramping_active_iterations_failed
```

Nếu failures fail threshold, xử lý correctness/API failure trước khi bàn throughput.

```text
Thứ tự ưu tiên:
  1. checks rate < 0.98 → có request sai status/contract → BLOCK
  2. http_req_failed > 0.02 → có HTTP failure → BLOCK
  3. ramping_active_iterations_failed >= 40 → user loop fail nhiều → BLOCK

  Chỉ khi 3 metric trên pass → mới phân tích latency/throughput
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

Với conditional cart add, verify operation distribution:

```text
cart_add_count ≈ iterations / 2
landing_count = iterations
detail_count = iterations

Nếu cart_add << iterations/2: cart branch fail hoặc script issue
Nếu cart_add > iterations/2: script bug
```

### Bước 5 — Interpret duration/throughput

Đọc:

```text
ramping_flow_duration_ms
http_req_duration by operation
iteration_duration
```

Case-specific notes:

- Checks/http failures thresholds là 98%/2%, khác baseline 99%/1%.
- Cart add count thấp hơn landing/detail là expected (đúng 50%).
- Nếu p95 không recover ở recovery stage, nghi queue/resource saturation.
- So sánh p95 stage 1 (prelaunch) vs stage 4 (recovery): nếu không giảm, recovery fail.

### Bước 6 — Verify stage transition behavior

```text
Từ dashboard VUs vs iter/s chart:
  - Stage 2: iter/s có tăng theo VU ramp không?
    Nếu không → backend saturated
  - Stage 4: iter/s có giảm theo VU ramp-down không?
    Nếu giảm nhanh hơn VU → loop_duration vẫn cao
  - Stage 3: iter/s có ổn định không?
    Nếu dao động mạnh → backend không ổn định ở 36 concurrent

Từ dashboard Response time chart:
  - Stage 2: latency có spike không?
  - Stage 4: latency có giảm về gần stage 1 không?
  - Stage 3: latency có ổn định không?
```

<!-- REAL_RUN_START -->
## Contract rerun 2026-06-20 — run #59

Run này ép đúng contract/tải đã ghi trong tài liệu, sau lần BE fix mới nhất.

```text
BASE_URL=http://localhost:80
K6_CLOUD_HOST=http://localhost:18080
RV_02_START_VUS=1
RV_02_PRELAUNCH_VUS=6
RV_02_SPIKE_VUS=36
RV_02_RECOVERY_VUS=8
RV_02_DURATION_SCALE=0.25
RV_02_SLEEP_SECONDS=0.2
```

| Item | Value |
| --- | --- |
| Script | `rv-02-campaign-launch-spike.js` |
| Run ID | `59` |
| Exit code | `0` |
| Verdict | **PASS** — Đạt theo contract gốc |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `1 -> 6 -> 36 -> 8 -> 1` |
| Observed `vus` min/max | 1 / 36 |

### Summary thật của contract rerun

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 100.00% (11655/11655) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/11655) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 0 | User-loop failures của case. |
| `iterations` | 4662 (71.52/s) | Output, không phải target. |
| `http_reqs` | 11655 (178.81/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 4662 | Completed user loops. |
| `ramping_api_calls_total` | 11655 | Custom API counter. |
| `ramping_sleep_seconds` | 932.4s | Think time do script thêm. |
| `http_req_duration` | avg 40.4ms, p95 197ms, p99 294ms, max 399ms | Request-level latency. |
| `ramping_flow_duration_ms` | avg 101ms, p95 205ms, p99 301ms, max 407ms | Full user-loop latency. |
| `iteration_duration` | avg 302ms, p95 405ms, p99 501ms, max 608ms | Bao gồm flow + think/sleep. |

Threshold failures:

Không có threshold failure.

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `campaign_product_detail` | GET | 200 | 4662 | 40.00% |
| `campaign_landing` | GET | 200 | 4662 | 40.00% |
| `campaign_cart_add` | POST | 200 | 2331 | 20.00% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

Không còn `campaign_landing` 429 ở contract gốc 36 VUs + sleep 0.2s. HTTP p95 khoảng 197ms và p99 khoảng 294ms, cao hơn case nhẹ nhưng vẫn sạch lỗi.

| Aggregate | Value |
| --- | ---: |
| Response-time points | 4121 |
| Avg của các window avg | 41.5ms |
| Max window p95 | 398ms |
| Max window p99 | 398ms |
| Max request window | 399ms |
| Windows p95 > 100ms | 996 |
| Windows p95 > 500ms | 0 |

#### 2. Execution timeline chart

Execution timeline không còn failed iterations. Request breakdown chỉ có 3 operation status 200: landing, product detail, cart add.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 4662 |
| Sum `http_reqs` buckets | 11655 |
| Peak iter/s bucket | 121 |
| Peak http_req/s bucket | 294 |
| Failed-iteration points | 0 |
| Sum failed iterations | 0 |
| Peak failed-iteration bucket | 0 |

#### 3. VUs vs iter/s chart

VU shape đạt peak 36 đúng contract `1 -> 6 -> 36 -> 8 -> 1`. Đây là lần rerun chứng minh campaign spike gốc đã chịu được tải 36 VUs.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 65 |
| VUs min/max series | 1 / 36 |
| Avg VUs series | 21.58 |
| Peak iter/s bucket | 121 |

### Kết luận contract rerun #59

OK theo contract gốc. Case 02 đã pass ở đúng `RV_02_SPIKE_VUS=36` và `RV_02_SLEEP_SECONDS=0.2`.
<!-- REAL_RUN_END -->

## Đọc dashboard real-time charts cho case 02

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
campaign_landing: GET /api/sim/products
campaign_product_detail: GET /api/sim/products/:id
campaign_cart_add: POST /api/sim/cart/add
```

Cách đọc:

```text
ramp-up phase: latency có tăng khi VUs tăng không?
peak/plateau: p95/p99 có ổn định không?
ramp-down/recovery: latency có giảm lại không?
```

Case-specific hints:

- Response time: landing/detail/cart tách riêng; spike thường làm product/detail p95 tăng.
- Execution timeline: failures clustering ở spike stage là capacity signal.
- VUs vs iter/s: ramp rất nhanh; iter/s flatten trong spike là saturation indicator.

#### Phân tích sâu chart Response time

Khi nhìn chart này, đọc theo 5 câu hỏi:

```text
1. Operation nào có p95 cao nhất trong spike stage?
2. p95 stage 2 (ramp) có cao đột biến so với stage 1 (prelaunch) không?
3. p95 stage 4 (recovery) có về gần p95 stage 1 (prelaunch) không?
4. Có operation nào p95 tăng dần trong stage 3 (plateau) không?
5. Max của operation nào đang kéo aggregate lên?
```

Shape mong đợi với case 02:

```text
stage 1 — prelaunch (0-11s):
  - p95 thấp và ổn định cho tất cả operation
  - landing: ~30-50ms
  - detail: ~30-50ms
  - cart_add: ~40-70ms
  - Đây là baseline để so sánh

stage 2 — spike ramp (11-19s):
  - p95 CÓ THỂ tăng đột biến (cold cache, connection ramp)
  - landing: có thể tăng lên 100-200ms
  - detail: có thể tăng lên 100-200ms
  - cart_add: có thể tăng lên 150-300ms
  - Đây là EXPECTED nếu nhẹ — spike ramp tạo áp lực
  - Nếu p95 > 500ms: CẢNH BÁO — ramp quá gấp cho backend

stage 3 — spike plateau (19-42s):
  - p95 nên ổn định (cache đã warm)
  - landing: ~40-80ms (cao hơn stage 1, chấp nhận được)
  - detail: ~40-80ms
  - cart_add: ~60-120ms
  - Nếu p95 tăng dần trong plateau: degradation (memory leak, pool cạn)

stage 4 — recovery (42-57s):
  - p95 PHẢI GIẢM về gần stage 1
  - landing: ~30-60ms
  - detail: ~30-60ms
  - cart_add: ~50-80ms
  - Nếu p95 vẫn cao ~ stage 3: RECOVERY FAIL → INVESTIGATE

stage 5 — idle (57-65s):
  - p95 về gần baseline stage 1
  - Nếu không: hệ thống chưa hồi phục hoàn toàn
```

#### Decomposition p95 theo stage

```text
Đây là kỹ thuật quan trọng: tách p95 theo stage để tìm transition issue.

Giả sử run campaign spike, aggregate http_req_duration p95 = 200ms.

Tách theo operation và stage:
  campaign_landing:
    stage 1: p95=45ms
    stage 2: p95=180ms ← SPIKE! (ramp shock)
    stage 3: p95=80ms  ← giảm (cache warm)
    stage 4: p95=50ms  ← về baseline
    stage 5: p95=45ms  ← OK

  campaign_product_detail:
    stage 1: p95=40ms
    stage 2: p95=250ms ← SPIKE MẠNH! (cold detail cache)
    stage 3: p95=90ms  ← giảm
    stage 4: p95=55ms  ← về baseline
    stage 5: p95=40ms  ← OK

→ Kết luận: Stage 2 có ramp shock (cold cache), nhưng
  hệ thống recover tốt ở stage 4-5. Overall PASS.

Nếu pattern khác:
  campaign_landing:
    stage 1: p95=45ms
    stage 4: p95=180ms ← KHÔNG GIẢM! Recovery fail.
  
  → Hệ thống bị tổn thương từ spike, không tự hồi phục.
```

#### Shape xấu cần chú ý

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 stage 2 >> stage 1 (gấp 5x+) | Ramp shock quá mạnh, cold cache penalty lớn | Tăng duration stage 2 (ramp chậm hơn) hoặc warm cache trước |
| p95 stage 4 không giảm về stage 1 | Recovery fail, resource leak | Investigate connection pool, memory, GC |
| p95 tăng dần trong stage 3 | Degradation ở plateau, memory leak | So sánh p95 đầu/cuối stage 3 |
| p95 tất cả operation cùng tăng ở stage 2 | Infrastructure bottleneck chung | Kiểm network, load balancer, DB |
| p95 chỉ 1 operation tăng ở stage 2 | Service-specific bottleneck | Route về team service đó |
| p95 stage 1 đã cao | Prelaunch có vấn đề, baseline sai | Investigate trước khi chạy spike |
| Max >> p95 ở stage 2 (max=2000, p95=200) | Vài request timeout trong ramp | Điều tra external dependency timeout |
| Cart p95 >> Landing p95 (gấp 3x+) | Cart service hoặc DB write chậm | Investigate cart-service, DB write path |

### Chart 2 — Execution timeline

Với ramping-vus:

```text
VUs should follow 1 -> 6 -> 36 -> 8 -> 1.
iterations/http_reqs per bucket are outputs.
failures may cluster at ramp transitions or peak.
```

Không kỳ vọng exact per-bucket counts, đặc biệt với weighted/conditional flows.

#### Cách đọc Execution timeline

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs — có đi đúng stage shape 1->6->36->8->1 không?
2. HTTP reqs per bucket — có tăng theo VU không? có giảm theo VU không?
3. Iterations per bucket — có theo kịp VU ramp không?
```

Shape mong đợi:

```text
stage 1 (0-11s):
  - Live VUs tăng 1 → 6
  - HTTP reqs: tăng dần, còn thấp
  - Iterations: tăng dần

stage 2 (11-19s):
  - Live VUs tăng NHANH 6 → 36
  - HTTP reqs: TĂNG NHANH theo VU
  - Iterations: TĂNG NHANH theo VU (nếu backend khỏe)
  → Đây là phase quan trọng nhất để quan sát

stage 3 (19-42s):
  - Live VUs = 36 (phẳng)
  - HTTP reqs: ổn định ở mức cao nhất
  - Iterations: ổn định ở mức cao nhất

stage 4 (42-57s):
  - Live VUs giảm 36 → 8
  - HTTP reqs: GIẢM theo VU
  - Iterations: GIẢM theo VU
  - Có thể thấy tail do gracefulRampDown

stage 5 (57-65s):
  - Live VUs giảm 8 → 1
  - HTTP reqs và iterations: giảm về gần 0
```

#### Pattern cần đọc

```text
Nếu thấy VUs ramp-up nhưng HTTP reqs/iterations không ramp theo:
  → Backend saturated trong ramp
  → Loop duration tăng → throughput không theo kịp VU

Nếu thấy failures cluster ở stage 2:
  → Ramp shock: quá nhiều VU mới cùng lúc
  → Connection pool, cold cache, DB fanout

Nếu thấy failures cluster ở stage 4:
  → Recovery issue: hệ thống không release resource
  → Hoặc: gracefulRampDown cắt iteration đang chạy

Nếu thấy VU ramp-down nhưng iterations vẫn tiếp tục:
  → gracefulRampDown cho phép in-flight iterations finish
  → BÌNH THƯỜNG nếu nhẹ
```

#### Invalid patterns

| Pattern | Nghĩa |
| --- | --- |
| VUs không lên đủ 36 | Config/env sai, maxVUs không đủ |
| VUs không theo stage shape | Config stage target/duration sai |
| VUs lên 36 nhưng HTTP reqs không tăng theo | Backend saturated, loop_duration tăng |
| Failures cluster ở stage 2 | Ramp shock, cold cache, connection pool |
| Failures cluster ở stage 4 | Recovery fail, resource leak |
| HTTP reqs tăng nhưng iterations không tăng | Loop có nhiều requests hơn? Hoặc iteration fail |
| VU ramp-down nhưng HTTP reqs vẫn cao | gracefulRampDown tail — bình thường nếu nhẹ |
| Iterations = 0 trong stage 1 | Loop đầu chưa kịp xong — bình thường |

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

#### Cách đọc sâu chart VUs vs iter/s

```text
3 thứ cần nhìn cùng lúc:

1. Executor VUs (đường VUs):
   - Có theo đúng shape 1->6->36->8->1 không?
   - Stage 2 ramp có đủ gấp không? (step_interval nhỏ)
   - Stage 4 ramp-down có mượt không?

2. Actual iter/s (đường iterations per second):
   - Stage 2: có tăng theo VU không?
   - Stage 3: có ổn định ở mức cao nhất không?
   - Stage 4: có giảm theo VU không?

3. Mối quan hệ giữa 2 đường:
   - Stage 2: iter/s slope vs VU slope
     → iter/s slope ≈ VU slope: backend khỏe
     → iter/s slope << VU slope: backend saturated
   - Stage 4: iter/s có về baseline không?
     → iter/s về gần stage 1 level: recovery OK
     → iter/s vẫn cao hơn stage 1: còn tail hoặc chưa recover
```

#### THE MOST IMPORTANT SIGNAL: VUs ramp-up + iter/s flatten

```text
Đây là pattern QUAN TRỌNG NHẤT của ramping-vus spike case:

  Stage 2 (11-19s):
    VUs:   / / / / / / / / (tăng 6→36, slope dốc)
    iter/s: _ _ _ _ _ _ _ (FLAT, không tăng theo VU)

  Nghĩa là:
    - 30 VU mới được activate trong 8s
    - Nhưng throughput không tăng
    - → Backend ĐÃ SATURATED từ trước khi đạt 36 VU
    - → Loop duration tăng mạnh, bù trừ cho VU tăng

  Hành động:
    1. Vào Response time chart, tách theo operation
    2. Tìm operation nào có p95 tăng đột biến ở stage 2
    3. Xác định saturation point: VU ở mức nào thì iter/s bắt đầu flatten?
    4. Đó là capacity knee — số VU tối đa hệ thống chịu được

  ĐÂY CHÍNH LÀ GIÁ TRỊ CỦA RAMPPING-VUS:
    Tìm capacity knee qua VU ramp mà không cần chạy nhiều lần
    với các mức VU khác nhau.
```

#### Expected shape cho case 02

```text
stage 1 (0-11s):
  - VUs: tăng 1 → 6 (nhẹ)
  - iter/s: tăng từ ~3 → ~20 (tỷ lệ ~3.3 iter/s mỗi VU)

stage 2 (11-19s):
  - VUs: tăng NHANH 6 → 36
  - iter/s: tăng từ ~20 → ~120 (nếu backend khỏe)
  - iter/s: tăng từ ~20 → ~60 (nếu backend saturated)
  → Đây là CỬA SỔ QUAN SÁT CRITICAL

stage 3 (19-42s):
  - VUs: phẳng ở 36
  - iter/s: ổn định ở ~120 (nếu khỏe) hoặc ~60 (nếu saturated)

stage 4 (42-57s):
  - VUs: giảm 36 → 8
  - iter/s: giảm theo, về ~25-30

stage 5 (57-65s):
  - VUs: giảm 8 → 1
  - iter/s: giảm về ~3-5
```

#### Quan hệ giữa chart 2 và chart 3

```text
Chart 2 (Execution timeline):
  - Cho biết RPS/iter/s THEO THỜI GIAN (per bucket)
  - Dùng để xem pattern: có bucket nào RPS drop đột ngột không?
  - Dùng để xem failures cluster ở stage nào?

Chart 3 (VUs vs iter/s):
  - Cho biết MỐI QUAN HỆ giữa VUs và iter/s
  - Dùng để xem: iter/s có theo kịp VU ramp không?
  - Dùng để tìm capacity knee

Cả 2 chart cùng trả lời: "hệ thống có chịu được spike không?"
Nhưng chart 3 là quan trọng nhất vì nó cho thấy SATURATION SIGNAL.
```

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận thresholds/failures.
2. VUs vs iter/s xác nhận stage shape và saturation signal.
3. Execution timeline xác nhận failures/throughput cluster ở phase nào.
4. Response time by operation tìm service/branch chậm.
5. Business decision dựa trên phase + operation + failure pattern.
```

## Kết luận thực tế: output -> quyết định

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **campaign launch gate**: output ra số như vậy thì team quyết định gì?

### Kịch bản A — output sạch: SPIKE OK, RECOVERY OK

```text
checks................: 100.00%
http_req_failed.......: 0.00%
ramping_active_iterations_failed: 0
iterations............: 4662      (output, không target)
http_reqs.............: 11655     (output, không target)

http_req_duration by operation (p95):
  campaign_landing:           stage2=80ms, stage3=55ms, stage4=45ms
  campaign_product_detail:    stage2=100ms, stage3=60ms, stage4=45ms
  campaign_cart_add:          stage2=150ms, stage3=80ms, stage4=55ms

VU shape: 1 -> 6 -> 36 -> 8 -> 1 đúng contract
iter/s: theo kịp VU ramp, đạt peak ~120 iter/s
Stage 4 recovery: latency về gần stage 1 baseline
```

Kết luận thực tế:

```text
- Failures = 0: không có vấn đề functional
- VU shape đúng: config và execution đúng
- Stage 2 latency tăng nhẹ (cold cache) nhưng recover tốt
- Stage 4 latency về baseline: recovery hoạt động
- iter/s theo kịp VU ramp: backend đủ capacity cho 36 concurrent

=> QUYẾT ĐỊNH: Campaign launch an toàn với 36 concurrent users.
   Có thể tự tin publish campaign.
   Lưu latency numbers làm reference cho campaign sau.
```

### Kịch bản B — Spike gây saturation: iter/s flatten ở stage 2

```text
checks................: 99.2%
http_req_failed.......: 1.5%
ramping_active_iterations_failed: 12
iterations............: 3200       ← THẤP

VUs vs iter/s chart:
  Stage 2: VUs tăng 6->36, iter/s FLAT ở ~50 (không tăng theo)
  Stage 3: iter/s vẫn ~50 dù 36 VU

http_req_duration by operation (p95):
  campaign_landing:           stage2=350ms ← CAO
  campaign_product_detail:    stage2=400ms ← CAO
  campaign_cart_add:          stage2=600ms ← RẤT CAO

Stage 4 recovery: latency giảm về ~100ms (vẫn > baseline 50ms)
```

Kết luận thực tế:

```text
- iter/s flatten ở stage 2: backend SATURATED
- 36 VU là QUÁ NHIỀU cho hệ thống hiện tại
- Capacity knee có thể ở khoảng 15-20 VU (nơi iter/s bắt đầu flatten)

- Latency tăng mạnh ở tất cả operation → không phải 1 service
  → Infrastructure bottleneck: DB, connection pool, hoặc CPU

=> QUYẾT ĐỊNH: BLOCK campaign launch ở 36 concurrent.
   Tìm capacity knee: chạy lại với RV_02_SPIKE_VUS=12, 18, 24, 30.
   Xác định max VU an toàn trước khi saturation.
   Cân nhắc: thêm cache, tăng connection pool, scale service.
```

### Kịch bản C — Spike pass nhưng recovery fail: RESOURCE LEAK

```text
checks................: 99.5%
http_req_failed.......: 0.8%
ramping_active_iterations_failed: 5
iterations............: 4200

VUs vs iter/s chart:
  Stage 2-3: VU 36, iter/s 100 (OK, theo kịp)
  Stage 4: VU giảm 36->8, iter/s giảm 100->50
           NHƯNG: 8 VU lẽ ra iter/s ~25, thực tế 50
           → iter/s vẫn CAO so với VU (loop_duration ngắn?)
  HOẶC: Stage 4: VU giảm, iter/s giảm MẠNH HƠN VU
           → loop_duration TĂNG dù VU giảm

http_req_duration by operation (p95):
  campaign_landing:
    stage 1: 45ms
    stage 2-3: 120ms (spike, chấp nhận được)
    stage 4: 110ms ← KHÔNG GIẢM! Vẫn gần spike level
    stage 5: 95ms  ← VẪN CAO

  campaign_cart_add:
    stage 1: 60ms
    stage 4: 180ms ← VẪN CAO dù chỉ 8 VU
```

Kết luận thực tế:

```text
- Spike pass (threshold OK, failures thấp)
- NHƯNG: latency không recover sau spike
  → Hệ thống bị "tổn thương" từ spike
  → Có thể: connection pool không release, memory leak,
    DB transaction lock chưa release, queue buildup

- Đây là BUG NGHIÊM TRỌNG:
  Nếu chỉ test steady-state (constant-vus), sẽ không phát hiện.
  Vì constant-vus không có "sau spike".

=> QUYẾT ĐỊNH: BLOCK. Investigate recovery mechanism.
   Kiểm tra:
   - Connection pool: có release connection sau spike không?
   - Memory: có GC sau spike không?
   - DB: có long-running transaction từ spike không?
   - Queue: có message backlog từ spike không?

   Đây là vấn đề CRITICAL — nếu production spike xảy ra,
   hệ thống sẽ "mệt" trong nhiều phút sau spike, ảnh hưởng
   đến tất cả user (kể cả user không trong campaign).
```

### Kịch bản D — Cold cache spike: stage 2 latency cao nhưng recover tốt

```text
checks................: 99.8%
http_req_failed.......: 0.5%
ramping_active_iterations_failed: 3
iterations............: 4400

http_req_duration by operation (p95):
  campaign_product_detail:
    stage 1: 40ms
    stage 2: 350ms ← SPIKE CAO! (cold cache)
    stage 3: 65ms  ← GIẢM MẠNH (cache warm)
    stage 4: 45ms  ← về baseline
    stage 5: 40ms  ← OK

  campaign_landing:
    stage 1: 35ms
    stage 2: 200ms ← SPIKE (cold cache)
    stage 3: 55ms  ← GIẢM (cache warm)
    stage 4: 40ms  ← OK
```

Kết luận thực tế:

```text
- Stage 2 latency spike là COLD CACHE — không phải capacity vấn đề
- Bằng chứng: stage 3 latency GIẢM MẠNH khi cache warm
- Nếu là capacity vấn đề: latency sẽ CAO ở cả stage 2 và stage 3

- Failures thấp, không có iteration fail
- Recovery OK

=> QUYẾT ĐỊNH: PASS với ghi chú.
   Cold cache penalty ở stage 2 là ~300ms.
   Cân nhắc warm cache trước campaign launch (pre-warm).
   Nếu không pre-warm được, chấp nhận latency spike 8s đầu.
   Ghi nhận: chạy lại lần 2 sẽ không có cold cache spike.
```

### Bảng ánh xạ nhanh output -> hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| Clean spike and recovery | Campaign capacity acceptable | Approve launch shape |
| Failure only at spike | Peak capacity insufficient | Add cache/protection or reduce campaign ramp |
| Latency does not recover | Resource saturation/leak/queue | Investigate before launch |
| Cart count every iteration or never | Conditional branch/tag issue | Validate script |
| iter/s flatten ở stage 2 | Backend saturated, tìm capacity knee | Giảm RV_02_SPIKE_VUS hoặc scale backend |
| p95 stage 2 cao nhưng stage 3 thấp | Cold cache penalty, không phải capacity | Pre-warm cache hoặc chấp nhận |
| p95 stage 4 > p95 stage 1 | Recovery fail, resource leak | Investigate connection pool, memory, GC |
| VU shape không khớp contract | Config/env/scale issue | Kiểm startVUs, stages, scale, maxVUs |
| Cart count << iterations/2 | Cart branch fail hoặc script bug | Kiểm conditional logic, cart service |
| Stage 3 latency tăng dần | Degradation trong plateau | So sánh p95 đầu/cuối stage 3 |
| All thresholds pass, latency sạch | Campaign launch gate open | Tự tin launch, lưu baseline |

## Nghịch lý và misconceptions của ramping-vus

### Nghịch lý 1: "Sharp ramp (stage 2) gây ra latency spike — nhưng đó có thể là cold cache, không phải capacity vấn đề"

```text
Đây là nghịch lý phổ biến khi đọc campaign spike case.

Stage 2 (6->36 VU trong 8s):
  - Latency tăng từ 50ms → 300ms
  - Nhìn qua: "Hệ thống không chịu nổi 36 VU!"
  - Nhưng stage 3 (vẫn 36 VU): latency về 60ms

  → Nếu là capacity vấn đề: latency sẽ CAO ở CẢ stage 2 và 3
  → Nếu latency chỉ cao ở stage 2 rồi giảm: COLD CACHE

Nguyên nhân:
  - 30 VU mới được activate, mỗi VU loop đầu tiên miss cache
  - Cache được fill dần trong 8s ramp
  - Đến stage 3, cache đã warm → latency giảm

Cách phân biệt cold cache vs capacity:
  - Cold cache: p95 stage 2 >> p95 stage 3
  - Capacity:   p95 stage 2 ≈ p95 stage 3 (cả 2 đều cao)
  - Cold cache + capacity: p95 stage 2 >> p95 stage 3 nhưng
    p95 stage 3 vẫn >> p95 stage 1

Giải pháp:
  - Pre-warm cache trước khi chạy spike test
  - Hoặc chạy 2 lần: lần 1 cold (đo cold cache penalty),
    lần 2 warm (đo pure capacity)
```

### Nghịch lý 2: "Spike pass nhưng recovery fail — test PASS threshold nhưng BUSINESS FAIL"

```text
Đây là nghịch lý NGUY HIỂM NHẤT của campaign spike case.

Run campaign spike:
  checks: 99.0% (> 98% → PASS)
  http_req_failed: 1.2% (< 2% → PASS)
  ramping_active_iterations_failed: 15 (< 40 → PASS)
  → Tất cả threshold PASS

Nhưng:
  Stage 4 latency: 180ms (stage 1 baseline: 50ms)
  → Hệ thống KHÔNG recover sau spike!
  → Dù test PASS, hệ thống có vấn đề NGHIÊM TRỌNG

Tại sao threshold không bắt được?
  - Threshold checks/failures đo CORRECTNESS (request có sai không?)
  - Không đo RECOVERY (latency có về baseline không?)
  - Recovery là PATTERN BEHAVIOR, không phải point-in-time metric

Giải pháp:
  - KHÔNG chỉ nhìn pass/fail threshold
  - PHẢI đọc latency theo stage (đặc biệt stage 4 vs stage 1)
  - Thêm latency threshold nếu muốn gate:
    "http_req_duration{operation:campaign_landing}": ["p(95)<150"],
  - Nhưng threshold cũng không capture được TREND
  - → Phải đọc dashboard, không chỉ đọc summary

Kết luận:
  "Test PASS" != "Hệ thống ổn"
  Với ramping-vus spike case, PHẢI đọc dashboard để xác nhận recovery.
```

### Nghịch lý 3: "6->36 VU trong 8s là ramp 'ngắn' — nhưng đó là lý do case này tồn tại"

```text
Learner thường hỏi: "Sao stage 2 chỉ có 8s? Sao không ramp chậm hơn?"

Trả lời: Vì ĐÓ LÀ CAMPAIGN LAUNCH THẬT.

Campaign launch thực tế:
  - Marketing publish link lên social media
  - User click vào trong vài giây
  - Traffic JUMP, không RAMP

Nếu ramp chậm (30s, 60s):
  - Đó là daily traffic curve (case 01), không phải campaign spike
  - Mất đi giá trị của case: test SHARP SPIKE

8s ramp (với scale 0.25) đại diện cho:
  - User ập vào trong ~30 giây (với scale 1.0)
  - Đủ gấp để test cold cache, connection pool ramp-up
  - Đủ gấp để test DB fanout

Nếu muốn test RAMP FROM FROM:
  → Dùng case 01 (daily traffic curve) với ramp 2->24 trong 1 phút

Nếu muốn test SPIKE:
  → Dùng case 02 (campaign spike) với ramp 6->36 trong 8s
  → Step_interval = 0.27s là CÓ CHỦ Ý

Đừng nhầm: "ramping-vus" không có nghĩa là "lúc nào cũng ramp từ từ".
Ramp có thể cực gấp — đó là giá trị của executor này.
```

Nhớ 3 câu:

```text
stage target = absolute VU target, không phải delta
iterations/RPS = output, không phải input
VUs tăng mà iter/s flatten = tín hiệu backpressure đáng đọc
```

## Checklist đọc biểu đồ case 02

Khi học sinh nhìn dashboard case 02, đọc theo thứ tự này:

```text
1. Overview KPI
   - checks >= 98%?
   - http_req_failed < 2%?
   - ramping_active_iterations_failed < 40?
   - iterations > 0? (sanity: có chạy không)

2. VUs vs iter/s chart (QUAN TRỌNG NHẤT)
   - VUs có theo shape 1->6->36->8->1 không?
   - Stage 2: VU ramp có đủ gấp không? (step_interval nhỏ)
   - Stage 2: iter/s có tăng theo VU không?
     → Nếu iter/s flatten: saturation signal → INVESTIGATE
   - Stage 4: iter/s có giảm theo VU không?
   - Stage 4: iter/s có về gần stage 1 level không?
     → Nếu không: recovery fail
   - Cuối run: VU về 1, iter/s về gần 0?

3. Execution timeline
   - Live VUs có theo stage shape không?
   - HTTP reqs per bucket có tăng/giảm theo stage không?
   - Iterations per bucket có theo kịp VU không?
   - Failures cluster ở stage nào?
     → Stage 2: ramp shock
     → Stage 4: recovery fail
     → Stage 3: capacity không đủ ở plateau

4. Response time chart — LUÔN TÁCH THEO OPERATION
   - campaign_landing p95 theo stage?
   - campaign_product_detail p95 theo stage?
   - campaign_cart_add p95 theo stage?
   - Stage 2 p95 vs Stage 1 p95: ramp shock?
   - Stage 4 p95 vs Stage 1 p95: recovery OK?
   - Stage 3 p95 trend: ổn định hay tăng dần?
   - Operation nào có p95 cao nhất trong spike?

5. Operation distribution verification
   - landing count = iterations?
   - detail count = iterations?
   - cart count = iterations / 2?
   - Nếu cart << iterations/2: cart branch fail
   - Nếu cart >> iterations/2: script bug

6. Stage transition analysis
   - Stage 1->2: latency jump? cold cache?
   - Stage 2->3: latency giảm? cache warm?
   - Stage 3->4: latency giảm về baseline? recovery?
   - Stage 4->5: latency ổn định? fully recovered?

7. Business decision
   - Tất cả threshold pass? → tiếp tục
   - VU shape đúng? → input đúng
   - iter/s theo kịp VU ramp? → backend đủ capacity
   - Recovery OK (stage 4 latency ≈ stage 1)? → không resource leak
   - Nếu tất cả OK → Campaign launch gate PASS
   - Nếu iter/s flatten → tìm capacity knee
   - Nếu recovery fail → investigate resource leak
```

Kết luận của run case 02 đang đúng nếu thấy:

```text
checks >= 98%
http_req_failed < 2%
ramping_active_iterations_failed < 40
VUs: theo shape 1 -> 6 -> 36 -> 8 -> 1
iter/s: tăng theo VU ở stage 2, ổn định ở stage 3, giảm ở stage 4-5
Stage 4 latency ≈ Stage 1 latency (recovery OK)
cart count = iterations / 2 (exact)
executor = ramping-vus
```

## Mở rộng / variation

### Variation A: Tăng peak VUs để tìm capacity knee

```powershell
# Từ 36 VU → 50, 72, 100 để tìm điểm saturation
$env:RV_02_SPIKE_VUS = 50
$env:RV_02_SLEEP_SECONDS = 0.1
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-02-campaign-launch-spike.js
```

```text
Mục đích: "Bao nhiêu concurrent users thì hệ thống bắt đầu saturated?"

Cách đọc:
  - Chạy với SPIKE_VUS = 12, 18, 24, 30, 36, 50, 72, 100
  - Mỗi run, xem iter/s ở stage 3 (plateau)
  - Plot: SPIKE_VUS (x) vs iter/s (y)
  - Điểm mà iter/s bắt đầu flatten = CAPACITY KNEE
  - Trước knee: iter/s tăng tuyến tính với VU
  - Sau knee: iter/s tăng chậm hoặc không tăng

  Ví dụ:
    12 VU → 40 iter/s  (3.33 iter/s/VU)
    24 VU → 80 iter/s  (3.33 iter/s/VU) ← tuyến tính
    36 VU → 100 iter/s (2.78 iter/s/VU) ← bắt đầu giảm
    50 VU → 110 iter/s (2.20 iter/s/VU) ← RÕ RÀNG saturated
    → Capacity knee ở khoảng 30-36 VU
```

### Variation B: Tăng duration scale để chạy gần business timeline hơn

```powershell
# Từ scale 0.25 → 1.0 (thời gian thật)
$env:RV_02_DURATION_SCALE = 1.0
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-02-campaign-launch-spike.js
```

```text
Mục đích: Chạy với timeline gần thực tế hơn.

Với scale=1.0:
  Stage 1: 45s (prelaunch)
  Stage 2: 30s (spike ramp, step_interval = 1s)
  Stage 3: 90s (plateau)
  Stage 4: 60s (recovery)
  Stage 5: 30s (idle)
  Total: 255s (~4.25 phút)

Cách đọc:
  - So sánh latency pattern giữa scale=0.25 và scale=1.0
  - Scale lớn hơn → ramp chậm hơn → ít cold cache shock hơn
  - Nhưng plateau dài hơn → dễ phát hiện degradation hơn
  - Nếu degradation xuất hiện ở scale=1.0 (plateau 90s)
    nhưng không xuất hiện ở scale=0.25 (plateau 23s)
    → Có memory leak hoặc connection pool cạn theo thời gian
```

### Variation C: Thay đổi sleep để xem think time ảnh hưởng iter/s

```powershell
# Tăng sleep → user "suy nghĩ" lâu hơn → iter/s thấp hơn
$env:RV_02_SLEEP_SECONDS = 0.5
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-02-campaign-launch-spike.js

# Giảm sleep → user "nhanh tay" hơn → iter/s cao hơn, áp lực lớn hơn
$env:RV_02_SLEEP_SECONDS = 0.05
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-02-campaign-launch-spike.js
```

```text
Mục đích: Xem think time ảnh hưởng thế nào đến throughput và saturation.

Công thức:
  iter/s ≈ VUs / (API_time + sleep)

  Với sleep=0.2s:
    Nếu API_time=0.1s → loop=0.3s → 36/0.3 = 120 iter/s (lý thuyết)
  
  Với sleep=0.5s:
    Nếu API_time=0.1s → loop=0.6s → 36/0.6 = 60 iter/s (lý thuyết)
    → Throughput giảm 50% chỉ vì sleep tăng

  Với sleep=0.05s:
    Nếu API_time=0.1s → loop=0.15s → 36/0.15 = 240 iter/s (lý thuyết)
    → Throughput tăng 2x, áp lực lên backend tăng 2x
    → Có thể gây saturation dù sleep=0.2s vẫn OK

Cách đọc:
  - So sánh iter/s thực tế với các mức sleep khác nhau
  - Nếu sleep=0.05s gây saturation nhưng sleep=0.2s không:
    → Backend gần capacity knee ở sleep=0.2s
  - Dùng sleep để điều chỉnh "user behavior": user nhanh hay chậm
```

### Variation D: Thêm latency threshold cho từng operation để biến case thành gate

```js
export const options = {
  thresholds: {
    // Landing phải nhanh ngay cả trong spike
    "http_req_duration{operation:campaign_landing}": ["p(95)<300"],

    // Product detail chấp nhận chậm hơn trong spike (cold cache)
    "http_req_duration{operation:campaign_product_detail}": ["p(95)<400"],

    // Cart add có thể chậm nhất (DB write)
    "http_req_duration{operation:campaign_cart_add}": ["p(95)<500"],

    // Flow duration toàn loop trong spike
    "ramping_flow_duration_ms": ["p(95)<600"],

    // Vẫn giữ threshold gốc
    "checks": ["rate>0.98"],
    "http_req_failed": ["rate<0.02"],
    "ramping_active_iterations_failed": ["count<40"],
  },
};
```

```text
Mục đích: Từ "observation" → "performance gate".

Với threshold này:
  - Không chỉ check correctness (checks, failures)
  - Mà còn check LATENCY TRONG SPIKE
  - Nếu campaign_landing p95 > 300ms → FAIL
  - → Campaign không được launch nếu landing quá chậm

Lưu ý khi đặt threshold:
  - Phải dựa trên baseline thực tế (từ run sạch)
  - Không đặt quá thấp (sẽ luôn fail vì spike)
  - Không đặt quá cao (vô nghĩa)
  - Nên chạy vài lần để có reference trước khi đặt threshold
```

### Variation E: Pre-warm cache trước spike test

```powershell
# Chạy 2 lần: lần 1 warm cache, lần 2 spike test thật
# Hoặc dùng multi-scenario: background warm-up + spike

# Script multi-scenario:
```

```js
export const options = {
  scenarios: {
    // Warm-up: chạy trước để fill cache
    cache_warm: {
      executor: "shared-iterations",
      vus: 2,
      iterations: 50,
      exec: "warmCache",
      startTime: "0s",
      gracefulStop: "5s",
      tags: { case_id: "rv-02-cache-warm" },
    },
    // Spike test chính (start sau warm-up)
    campaign_spike: {
      executor: "ramping-vus",
      startVUs: __ENV.RV_02_START_VUS || 1,
      stages: [
        { duration: `${scaleSeconds(45)}s`, target: __ENV.RV_02_PRELAUNCH_VUS || 6 },
        { duration: `${scaleSeconds(30)}s`, target: __ENV.RV_02_SPIKE_VUS || 36 },
        { duration: `${scaleSeconds(90)}s`, target: __ENV.RV_02_SPIKE_VUS || 36 },
        { duration: `${scaleSeconds(60)}s`, target: __ENV.RV_02_RECOVERY_VUS || 8 },
        { duration: `${scaleSeconds(30)}s`, target: 1 },
      ],
      exec: "campaignLaunchSpike",
      startTime: "15s",  // Start sau warm-up
      gracefulRampDown: "20s",
      tags: { case_id: "rv-02-campaign-launch-spike" },
    },
  },
};

export function warmCache() {
  // Gọi campaign products API để fill cache
  http.get(`${BASE_URL}/api/sim/products?category=campaign`);
  http.get(`${BASE_URL}/api/sim/products/${randomProductId()}`);
}

export function campaignLaunchSpike() {
  // Flow campaign như bình thường
  // ...
}
```

```text
Mục đích: Loại bỏ cold cache noise khỏi spike test.

Với pre-warm:
  - Cache đã được fill trước khi spike bắt đầu
  - Stage 2 latency sẽ không bị cold cache ảnh hưởng
  - → Đo được PURE CAPACITY, không lẫn cold cache penalty

So sánh 2 run:
  - Run không warm: thấy cold cache penalty ở stage 2
  - Run có warm: không thấy cold cache penalty
  - → Difference = cold cache impact
  - → Dùng để quyết định: có cần pre-warm cache production không?
```

## Code pattern: conditional cart add và modulo identity

### Pattern 1: Dùng iterationInTest để quyết định cart add (deterministic)

```js
import exec from "k6/execution";

export default function () {
  const userId = exec.vu.idInTest;  // __VU, stable khi active
  const iterationIndex = exec.scenario.iterationInTest;

  const params = {
    tags: {
      user_id: `user-${userId}`,
      case_id: "rv-02-campaign-launch-spike",
      business_case: "campaign_launch_spike",
      workload: "staged_concurrency",
      executor_family: "ramping_vus",
    },
  };

  // Always: landing + product detail
  const landingRes = http.get(`${BASE_URL}/api/sim/products?limit=10&category=campaign`, {
    ...params,
    tags: { ...params.tags, service: "products-service", operation: "campaign_landing", endpoint: "products_list" },
  });
  check(landingRes, { "campaign landing 200": (r) => r.status === 200 });

  sleep(sleepSeconds);

  const detailRes = http.get(`${BASE_URL}/api/sim/products/${randomProductId()}`, {
    ...params,
    tags: { ...params.tags, service: "products-service", operation: "campaign_product_detail", endpoint: "product_detail" },
  });
  check(detailRes, { "campaign detail 200": (r) => r.status === 200 });

  sleep(sleepSeconds);

  // Conditional: cart add every SECOND iteration
  if (iterationIndex % 2 === 0) {
    const cartRes = http.post(`${BASE_URL}/api/sim/cart/add`, JSON.stringify({
      product_id: randomProductId(),
      quantity: 1,
    }), {
      headers: { "Content-Type": "application/json" },
      ...params,
      tags: { ...params.tags, service: "cart-service", operation: "campaign_cart_add", endpoint: "cart_add" },
    });
    check(cartRes, { "campaign cart add 200": (r) => r.status === 200 });

    sleep(sleepSeconds);
  }

  // Track custom metrics
  ramping_active_iterations.add(1, { case_id: "rv-02-campaign-launch-spike" });
}
```

### Pattern 2: Dùng __VU % 2 để quyết định cart add (per-VU behavior)

```js
export default function () {
  const userId = exec.vu.idInTest;

  // Mỗi VU có behavior riêng: VU chẵn luôn add cart, VU lẻ không
  const shouldAddCart = (userId % 2 === 0);

  // ... landing + detail như trên ...

  if (shouldAddCart) {
    // Cart add
  }

  // Với pattern này:
  // - VU=2,4,6,...,36 luôn add cart → ~50% iterations có cart
  // - VU=1,3,5,...,35 không add cart → ~50% iterations không có cart
  // - KHÔNG deterministic theo iteration → khó verify exact count
  // - Nhưng behavior per-VU ổn định → dễ track user behavior
}
```

```text
So sánh 2 pattern:

Pattern 1 (iterationInTest % 2):
  - Ưu: EXACT 50% cart add, dễ verify
  - Ưu: Deterministic, reproducible
  - Nhược: Mỗi VU có cả iteration có cart và không cart
  
Pattern 2 (__VU % 2):
  - Ưu: Per-VU behavior ổn định (user hoặc luôn add cart hoặc không)
  - Ưu: Mô phỏng user behavior thật hơn (có user hay add cart, có user không)
  - Nhược: Cart count có thể lệch 50% nếu VU được activate/deactivate không đều

Case 02 dùng Pattern 1 (iterationInTest % 2).
```

## Anti-pattern

- Đọc `stage.target` như số VUs cộng thêm.
- Kỳ vọng fixed RPS từ `ramping-vus`.
- Dùng total `iterations` làm pass/fail target.
- Bỏ qua `gracefulRampDown` khi thấy tail iterations.
- Chỉ nhìn aggregate p95 trong mixed/conditional flow.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với flat active users của `constant-vus`.
- Chỉ nhìn pass/fail threshold, không đọc dashboard recovery pattern.
- Kỳ vọng cart count = iterations (quên rằng cart là conditional).
- Nhầm cold cache latency spike ở stage 2 với capacity vấn đề.
- Dùng constant-vus 36 để thay thế — mất prelaunch/recovery dynamics.
- Kỳ vọng iter/s tăng tuyến tính vô hạn khi VU tăng.
- Không so sánh stage 4 latency với stage 1 latency.
- Đọc `step_interval` nhỏ là "config sai" — đó là CÓ CHỦ Ý để test spike.
- Bỏ qua VU identity model — VU có thể được activate/deactivate theo stage.
- Cho rằng "spike pass = hệ thống ổn" — phải check recovery nữa.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Ramping-vus quick index: `../../20260517_01_ramping-vus-quick-index.md`
- Tham số/công thức: `../../20260517_02_ramping-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-02-campaign-launch-spike.js`
