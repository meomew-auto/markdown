# Case 01: Daily traffic curve

## Tình huống thực tế

Traffic bình thường trong ngày không phẳng: sáng tăng dần, vào peak, giữ một lúc, rồi chiều giảm.

Team storefront muốn biết products/cart/order giữ latency và failure rate ra sao khi active users đi theo daily curve.

Case này trả lời: hệ thống có chịu được đường cong 2 -> 8 -> 24 -> 12 -> 2 VUs không, và service nào kéo latency khi vào peak?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 2 -> 8 -> 24 -> 12 -> 2
Scenario: daily_traffic_curve
Exec function: dailyTrafficCurve
Team/service focus: storefront/products/cart/order
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 2 -> 8 -> 24 -> 12 -> 2,
latency/failures/iter-s/RPS phản ứng như thế nào?
```

### Bối cảnh thực tế đầy đủ hơn

```text
Trigger: team muốn biết storefront capacity theo daily traffic curve
         — sáng ít user, trưa peak, chiều giảm dần.
         Chạy trước khi quyết định scale hay trước campaign lớn.

Business reality:
  - Sáng sớm (6h-8h): ít shopper, ~2-8 người active cùng lúc
  - Giữa buổi sáng (8h-11h): traffic tăng dần, 8 -> 24 shoppers
  - Giờ cao điểm trưa (11h-13h): peak ~24 shoppers active
  - Đầu giờ chiều (13h-15h): traffic giảm dần, 24 -> 12 shoppers
  - Cuối chiều (15h-17h): thưa dần, 12 -> 2 shoppers
  
  Mỗi shopper browse/cart/checkout tự nhiên, không có quota.
  Họ không đến cùng lúc — họ "vào" dần trong morning ramp.
  Họ không rời cùng lúc — họ "ra" dần trong afternoon ramp.

Risk nếu hiểu sai model:
  - Dùng constant-vus: giữ 24 VU phẳng suốt → không thấy được behavior 
    khi traffic ĐANG TĂNG (ramp-up stress khác với steady state)
  - Dùng shared-iterations: ép drain N jobs → không observation
    window per stage, không thấy system reaction theo từng phase
  - Dùng constant-arrival-rate: giữ RPS target → che mất 
    closed-model backpressure khi backend saturated ở peak
  - Kỳ vọng fixed RPS: daily curve không phải arrival-rate target
```

### Vì sao "Daily traffic curve" buộc chọn ramping-vus?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của daily traffic curve trước:

```text
Daily traffic curve = "active users thay đổi theo timeline ngày,
                       quan sát hệ thống phản ứng ở TỪNG PHASE:
                       ramp-up, peak plateau, ramp-down"

Đời thường:
  Sáng sớm: vài khách đầu tiên vào siêu thị
  Giữa sáng: khách vào nhiều dần (ramp-up)
  Trưa: siêu thị đông nhất (peak plateau)
  Chiều: khách rời dần (ramp-down)
  Tối: còn vài khách cuối
  
  Không ai ép "phải có đúng 24 khách suốt 8 tiếng"
  Không ai ép "mỗi giờ phải có đúng 100 khách vào"
  → Traffic TỰ NHIÊN thay đổi theo thời gian
```

Để daily traffic curve **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ ramping-vus mới thỏa mãn cả 2.

#### Yêu cầu (a): STAGED CONCURRENCY OBSERVATION (quan sát từng phase concurrency khác nhau)

**Ý nghĩa**: Phải giữ đúng số active users ở từng stage theo timeline. Input là STAGE SHAPE — ta muốn biết "khi 8 users, hệ thống ra sao? Khi 24 users thì sao? Khi ramp-down về 12 thì có hồi phục không?"

**Ví dụ cụ thể**:

```text
Scenario: team muốn biết storefront capacity curve theo giờ trong ngày

Trường hợp A (staged concurrency ĐÚNG):
  Stage 1: 2 -> 8 VUs trong 15s (morning ramp)
  Stage 2: 8 -> 24 VUs trong 30s (ramp to peak)
  Stage 3: 24 VUs giữ trong 30s (peak plateau)
  Stage 4: 24 -> 12 VUs trong 23s (afternoon ramp-down)
  Stage 5: 12 -> 2 VUs trong 15s (low traffic)
  → Mỗi phase có observation window riêng
  → So sánh được latency ở 8 VU, 24 VU, 12 VU

Trường hợp B (concurrency SAI — dùng constant-vus):
  Giữ 24 VU phẳng suốt 113s
  → Chỉ thấy behavior ở 24 VU
  → Không biết: lúc ramp từ 8 lên 24, hệ thống có "sốc" không?
  → Không biết: lúc ramp-down, hệ thống có hồi phục nhanh không?
  → Kết luận thiếu: "24 VU ổn" nhưng không biết transition có vấn đề không
```

**Vì sao staged concurrency quan trọng hơn fixed VUs cho case này?**

```text
Trong thực tế, traffic không tự nhiên nhảy từ 2 lên 24 rồi ở đó.
Hệ thống trải qua CÁC GIAI ĐOẠN:
  - Ramp-up stress: vừa tăng load vừa phải phục vụ
  - Peak plateau: sustain max concurrency
  - Ramp-down recovery: giảm load, hệ thống có "thở" lại không

Nếu chỉ test 24 VU phẳng:
  → Bỏ qua ramp-up stress (transition có thể gây lỗi)
  → Bỏ qua recovery observation (sau peak, latency có về baseline không)
  → Kết luận không đầy đủ

ramping-vus capture được:
  "Latency lúc 8 VU là X, lúc ramp lên 24 tăng lên Y, 
   lúc ramp-down về 12 giảm còn Z"
  → Đây là staged observation QUAN TRỌNG

constant-vus KHÔNG capture được điều này:
  "Latency ở 24 VU là Y" — chỉ 1 data point
  → Thiếu context của các phase khác
```

#### Yêu cầu (b): CLOSED-MODEL PER STAGE (mỗi stage là closed-model observation riêng)

**Ý nghĩa**: Trong từng stage, VUs hoạt động theo closed model. Khi backend chậm ở stage peak, iter/s phải GIẢM — đó là tín hiệu. Nhưng điều quan trọng hơn: so sánh iter/s GIỮA CÁC STAGE để thấy capacity limit.

**Ví dụ cụ thể**:

```text
ramping-vus với shape 2 -> 8 -> 24 -> 12 -> 2, loop_duration ~0.4s:

Stage 1 (2->8 VUs):  VU avg ~5,   iter/s ~12.5
Stage 2 (8->24 VUs): VU avg ~16,  iter/s ~40
Stage 3 (24 VUs):    VU = 24,     iter/s ~60 (nếu backend còn capacity)
                                  iter/s ~35 (nếu backend saturated!)
Stage 4 (24->12 VUs): VU avg ~18, iter/s ~45 (hồi phục?)
Stage 5 (12->2 VUs):  VU avg ~7,  iter/s ~17.5

Nếu stage 3 iter/s chỉ ~35 thay vì ~60:
  → Backend saturated ở khoảng 24 VU
  → Đây là TÍN HIỆU: "peak capacity limit found"

Nếu dùng arrival-rate:
  Stage 3: giữ RPS target → k6 spawn thêm VU để bù
  → Không thấy được "24 VU thật tạo ra bao nhiêu iter/s"
  → Kết luận sai về capacity
```

### Phân tích sâu: vì sao 5 executor "không phải ramping-vus" không phù hợp?

`constant-vus` với `vus=24, duration=113s`:

```text
Vấn đề: concurrency phẳng, không có staged observation.

Nếu giữ 24 VU suốt 113s:
  → Chỉ thấy behavior ở 1 mức concurrency
  → Không thấy ramp-up stress: lúc VUs đang tăng, latency spike không?
  → Không thấy recovery: sau peak, latency về baseline nhanh không?
  → Không thấy transition: lúc chuyển stage, có lỗi không?

Daily traffic có ÍT NHẤT 3 phase cần quan sát riêng:
  - Ramp-up: hệ thống có "sốc" khi load tăng không?
  - Peak: sustain được max concurrency không?
  - Ramp-down: hồi phục nhanh không? Có residual effect không?

constant-vus chỉ trả lời được câu thứ 2.
→ Thiếu 2/3 bức tranh.

Ngoài ra: daily curve thật có lúc ít user (sáng sớm, tối).
Nếu chỉ test 24 VU, bỏ qua behavior ở low concurrency.
```

`shared-iterations` với `vus=24, iterations=???`:

```text
Vấn đề kép: (1) không observation window per stage, 
            (2) không biết đặt iterations bằng bao nhiêu.

Nếu iterations = 5000:
  - Backend nhanh: 24 VU, loop=0.4s → iter/s=60 → 83s xong
  - Backend chậm: 24 VU, loop=0.8s → iter/s=30 → 167s xong
  - Cả 2 đều không có stage shape gì cả
  - VUs phẳng, không ramp-up/down

Nếu cố gắng mô phỏng stage bằng cách chia iterations:
  - Stage 1: 200 iter với 2 VU → xong trong ~250s (với loop=0.5s, 2 VU → 4 iter/s)
  - Stage 2: 1000 iter với 8 VU...
  → Vẫn là drain-from-backlog, không phải time-based observation
  → Mỗi stage duration phụ thuộc backend latency → không so sánh được

Cốt lõi: shared-iterations trả lời "xử lý hết N job trong bao lâu?"
         ramping-vus trả lời "trong T giây ở stage S, N user tạo ra bao nhiêu job?"
         → 2 câu hỏi KHÁC NHAU
```

`per-vu-iterations` với `vus=24, iterations=50`:

```text
Vấn đề: ép mỗi user chạy đúng 50 vòng, không có stage timeline.

24 VU, mỗi VU 50 iterations:
  - VU nhanh: xong 50 vòng trong 20s, rồi IDLE
  - VU chậm: xong 50 vòng trong 40s
  - Không có ramp-up: tất cả 24 VU start cùng lúc
  - Không có ramp-down: VU xong rồi dừng, không giảm dần
  - Không observation window: duration do VU chậm nhất quyết định

Ngoài ra:
  - Shopper thật không có quota "phải browse đúng 50 vòng"
  - Họ vào dần, browse tự nhiên, rồi ra dần
  - per-vu-iterations ép quota + start đồng loạt = sai behavior model
```

`constant-arrival-rate` với `rate=40, duration="113s"`:

```text
Vấn đề: open model — che mất closed-model backpressure.

Demo trace so sánh:
  Tình huống: stage 3 (peak), products-service bị saturated

  ramping-vus:
    VUs: 24 (theo stage config)
    iter/s: 60 (đầu peak) → 35 (giữa peak) → GIẢM!
    → Phát hiện: "24 VU không tạo ra 60 iter/s nữa — backend saturated"

  constant-arrival-rate:
    Target: 40 iter/s (cố định)
    VUs: 20 (đầu) → 35 (khi backend chậm, k6 spawn thêm để giữ rate)
    iter/s: 40 → 40 (KHÔNG đổi, bị che)
    → Thấy: "VU tăng, latency tăng"
    → Nhưng không biết: "24 VU thật có tạo ra 60 iter/s không?"
    → Kết luận sai về capacity

  Vấn đề của arrival-rate: nó tạo ra concurrency CAO HƠN thực tế
  để giữ rate. Trong thực tế, 24 shoppers không tự nhiên thành 35.
  → Kết luận sai về capacity requirement
```

`ramping-arrival-rate` với ramp rate:

```text
Vấn đề: input là arrivals/s, không phải active VU pool.

Nếu config arrival rate ramp 10 -> 40 -> 10:
  → Input: "bao nhiêu request được sinh ra mỗi giây"
  → Output: VUs (k6 tự quyết định cần bao nhiêu VU để đạt rate)

Nhưng case này hỏi: "nếu có 24 shoppers active, hệ thống ra sao?"
  → Input phải là: "24 shoppers active"
  → Không phải: "40 requests/s được sinh ra"

Đây là khác biệt CỐT LÕI:
  - ramping-vus: input = active user count (business question)
  - ramping-arrival-rate: input = arrival rate (infrastructure question)
```

### Tổng kết: chỉ ramping-vus thỏa mãn cả (a) và (b)

| Executor | (a) Staged concurrency | (b) Closed-model per stage | Verdict |
| --- | --- | --- | --- |
| **ramping-vus** | ✓ VUs theo stage timeline | ✓ iter/s giảm khi backend chậm ở từng stage | ✅ DÙNG |
| constant-vus | ✗ VUs phẳng, không stage | △ thấy backpressure nhưng chỉ 1 mức | ❌ |
| shared-iterations | ✗ duration phụ thuộc latency | ✗ không observation window | ❌ |
| per-vu-iterations | ✗ VU start đồng loạt, không timeline | ✗ VU idle sau khi hết quota | ❌ |
| constant-arrival-rate | ✗ VU thay đổi để giữ rate | ✗ RPS cố định → che backpressure | ❌ |
| ramping-arrival-rate | ✗ input là rate, không phải users | ✗ rate target thay đổi → không baseline user | ❌ |

→ Chỉ **ramping-vus** thỏa mãn cả 2 yêu cầu, các executor khác đều fail ở ít nhất 1 trong 2.

## Yêu cầu cứng của case này

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| VU chart phải đi theo daily stage shape 2->8->24->12->2 | Input chính là staged active user curve. Nếu VU không theo shape, mô hình sai. |
| Chạy đủ observation window cho TỪNG stage, không dùng total iterations làm target | Duration mỗi stage là observation window. Dừng sớm/muộn làm mất khả năng so sánh per-stage. |
| Weighted mix browse/cart/checkout phải được đọc bằng operation tags | Aggregate metrics che branch bottlenecks. Phải tách operation. |
| Failed user loops phải thấp hơn `ramping_active_iterations_failed count<25` | Shopper loop fail nghĩa là user không hoàn tất flow. |
| `http_req_failed` rate < 0.01 | HTTP failure phải gần 0. |
| `checks` rate > 0.99 | Status/contract checks phải pass. |

Các invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

Do đó không được fail test chỉ vì `iterations` không bằng một số target tưởng tượng. Và đặc biệt: không được fail test vì iter/s ở stage 1 (2 VU) thấp hơn stage 3 (24 VU) — đó là expected.

## Stage timeline deep dive: từng giây một

Đây là phần quan trọng nhất để hiểu ramping-vus. Mỗi stage là một giai đoạn với VU count thay đổi (hoặc giữ nguyên), và hệ thống phản ứng khác nhau ở từng stage.

### Công thức step_interval

```text
fromVUs = startVUs hoặc previous stage target
toVUs = current stage target
step_interval ~= stage.duration / abs(toVUs - fromVUs)

step_interval là khoảng thời gian giữa 2 lần thêm/bớt 1 VU
```

### Stage-by-stage timeline

Raw/effective stages:

| Stage | Raw duration | Effective default | From VUs | To VUs | Delta | step_interval | Business meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 60s | 15s | 2 | 8 | +6 | ~2.5s/VU | Sáng sớm: traffic bắt đầu tăng, từ 2 lên 8 shoppers |
| 2 | 120s | 30s | 8 | 24 | +16 | ~1.88s/VU | Giữa sáng: ramp mạnh vào giờ cao điểm |
| 3 | 120s | 30s | 24 | 24 | 0 | N/A (plateau) | Trưa: giữ peak, quan sát sustain |
| 4 | 90s | 23s | 24 | 12 | -12 | ~1.92s/VU | Đầu chiều: traffic giảm dần |
| 5 | 60s | 15s | 12 | 2 | -10 | ~1.5s/VU | Cuối chiều: về low traffic |

Lưu ý:

```text
effective duration = scaleSeconds(raw_seconds, RV_NN_DURATION_SCALE)
scaleSeconds = max(1, round(seconds * scale)) seconds
```

`stage.target` là **absolute VU target ở cuối stage**, không phải delta.

### Timeline từng giây — Stage 1 (morning ramp: 2 -> 8)

```text
Duration: 15s, delta: +6 VU, step_interval: ~2.5s

t=0s:   2 VU active (startVUs)
t=2.5s:  3 VU active (thêm 1 VU)
t=5s:   4 VU active
t=7.5s:  5 VU active
t=10s:  6 VU active
t=12.5s: 7 VU active
t=15s:  8 VU active (kết thúc stage 1)

Observation: trong 15s, VUs tăng từ 2 lên 8.
- Mỗi VU mới bắt đầu loop riêng
- iter/s tăng dần khi có thêm VU hoàn tất loop đầu tiên
- Latency ở giai đoạn này thường thấp (ít concurrent requests)
- Nếu latency ĐÃ cao ở 2-8 VU → vấn đề không phải do load, mà do baseline performance kém
```

### Timeline từng giây — Stage 2 (ramp to peak: 8 -> 24)

```text
Duration: 30s, delta: +16 VU, step_interval: ~1.88s

t=15s:   8 VU (bắt đầu stage 2)
t=16.9s:  9 VU
t=18.8s: 10 VU
...
t=30s:  16 VU (giữa stage 2)
...
t=41.3s: 23 VU
t=43.1s: 24 VU
t=45s:  24 VU (kết thúc stage 2)

Observation: đây là phase QUAN TRỌNG NHẤT để phát hiện ramp-up stress.
- VUs tăng nhanh (+16 trong 30s, ~0.53 VU/s)
- Mỗi VU mới tạo thêm concurrent requests
- Backend có thể bắt đầu saturated ở đâu đó giữa 8-24 VU
- Nếu iter/s tăng không tuyến tính với VUs → tìm knee point
- Nếu latency bắt đầu tăng ở 1 mức VU cụ thể → đó là capacity signal
```

### Timeline từng giây — Stage 3 (peak plateau: 24)

```text
Duration: 30s, delta: 0

t=45s:  24 VU
t=75s:  24 VU (kết thúc stage 3)

Observation: đây là phase SUSTAIN — kiểm tra hệ thống có giữ được peak không.
- 24 VU chạy liên tục trong 30s
- iter/s nên ổn định nếu backend khỏe
- Nếu iter/s GIẢM trong 30s plateau → backend đang degrade dưới sustained load
- Nếu latency TĂNG dần trong plateau → memory leak, connection pool cạn, GC pressure
- So sánh latency đầu plateau vs cuối plateau
```

### Timeline từng giây — Stage 4 (afternoon ramp-down: 24 -> 12)

```text
Duration: 23s, delta: -12 VU, step_interval: ~1.92s

t=75s:  24 VU (bắt đầu stage 4)
t=76.9s: 23 VU (bớt 1 VU)
...
t=87s:  18 VU
...
t=96.1s: 13 VU
t=98s:  12 VU (kết thúc stage 4)

Observation: đây là phase RECOVERY.
- VUs giảm dần, nhưng gracefulRampDown cho VU thời gian finish loop
- Có thể thấy residual iterations sau khi VU đã giảm (gracefulRampDown behavior)
- Latency nên GIẢM khi VUs giảm
- Nếu latency KHÔNG giảm → backend chưa hồi phục (có thể còn backlog ở queue, DB, connection pool)
- Nếu thấy interrupted iterations → gracefulRampDown quá ngắn hoặc loop quá dài
```

### Timeline từng giây — Stage 5 (evening low: 12 -> 2)

```text
Duration: 15s, delta: -10 VU, step_interval: ~1.5s

t=98s:  12 VU (bắt đầu stage 5)
t=99.5s: 11 VU
...
t=105.5s: 7 VU
...
t=111.5s: 3 VU
t=113s:  2 VU (kết thúc stage 5)

Observation: đây là phase COOL-DOWN cuối.
- VUs về gần baseline (2 VU)
- Latency nên về gần baseline của stage 1
- Đây là final sanity check: sau cả daily curve, hệ thống có về trạng thái ban đầu không?
- Nếu latency vẫn cao hơn baseline dù VUs đã thấp → residual issue
```

### Tổng timeline

```text
t=0s     ─── Stage 1 start: 2 VU
t=15s    ─── Stage 2 start: 8 VU (ramp to peak begins)
t=45s    ─── Stage 3 start: 24 VU (peak plateau begins)
t=75s    ─── Stage 4 start: 24 VU (ramp-down begins)
t=98s    ─── Stage 5 start: 12 VU (cool-down begins)
t=113s   ─── Scenario end: 2 VU

Tổng duration: 113s
Peak VUs: 24 (stage 3)
Min VUs: 2 (start và end)
VU shape: 2 → 8 → 24 → 12 → 2
```

## Vì sao "Daily traffic curve" nên dùng `ramping-vus`?

Daily traffic là active-user curve theo thời gian. `ramping-vus` đúng vì input nghiệp vụ là số active users ở từng phase, không phải fixed RPS hoặc fixed backlog.

Mental model:

```text
Active VUs follow stage timeline.
Each active VU loops the business flow sequentially.
Backend latency changes completed loop rate.
```

Mỗi stage là một observation window riêng với mức concurrency khác nhau. Đây là khác biệt cốt lõi với constant-vus (chỉ 1 mức) và arrival-rate (che backpressure).

## Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho staged active users? |
| --- | --- | --- |
| `ramping-vus` | Active users thay đổi theo thời gian | **Đúng**: input là timeline VU, output là latency/iter-s/RPS theo từng phase. |
| `constant-vus` | Cũng là closed model active users | Sai nếu traffic phải rise/peak/cooldown; `constant-vus` giữ VUs phẳng. |
| `shared-iterations` | Có nhiều VU cùng chạy | Sai nếu không có fixed backlog cần drain đủ. |
| `per-vu-iterations` | VU identity ổn định | Sai nếu không cần mỗi VU chạy đúng N vòng; stage duration mới là input chính. |
| `constant-arrival-rate` | Giữ rate ổn định | Sai nếu requirement là active users, không phải arrivals/s. |
| `ramping-arrival-rate` | Cũng có time-shaped load | Close cousin nhưng input là arrivals/s, không phải active VU pool. |

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
RV_01_START_VUS = 2
RV_01_MORNING_VUS = 8
RV_01_PEAK_VUS = 24
RV_01_AFTERNOON_VUS = 12
RV_01_DURATION_SCALE = 0.25
RV_01_SLEEP_SECONDS = 0.4
gracefulRampDown = 15s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_01_START_VUS | 2 | Số shopper active lúc bắt đầu (sáng sớm). |
| RV_01_MORNING_VUS | 8 | Target VU cuối morning ramp (stage 1). |
| RV_01_PEAK_VUS | 24 | Target VU cuối ramp-to-peak (stage 2) và giữ ở plateau (stage 3). |
| RV_01_AFTERNOON_VUS | 12 | Target VU cuối afternoon ramp-down (stage 4). |
| RV_01_DURATION_SCALE | 0.25 | Scale factor cho raw duration → effective. 0.25 nghĩa là 60s raw → 15s effective. |
| RV_01_SLEEP_SECONDS | 0.4 | Think time giữa các API call trong loop. |
| gracefulRampDown | 15s | Thời gian cho VU finish loop hiện tại khi bị ramp-down chọn để dừng. |

### Stage config mapping chi tiết

```text
Stage 1: { duration: scaleSeconds(60, RV_01_DURATION_SCALE), target: RV_01_MORNING_VUS }
         → default: { duration: "15s", target: 8 }

Stage 2: { duration: scaleSeconds(120, RV_01_DURATION_SCALE), target: RV_01_PEAK_VUS }
         → default: { duration: "30s", target: 24 }

Stage 3: { duration: scaleSeconds(120, RV_01_DURATION_SCALE), target: RV_01_PEAK_VUS }
         → default: { duration: "30s", target: 24 }

Stage 4: { duration: scaleSeconds(90, RV_01_DURATION_SCALE), target: RV_01_AFTERNOON_VUS }
         → default: { duration: "23s", target: 12 }

Stage 5: { duration: scaleSeconds(60, RV_01_DURATION_SCALE), target: RV_01_START_VUS }
         → default: { duration: "15s", target: 2 }
```

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 60s | 15s | 8 | morning traffic starts rising |
| 2 | 120s | 30s | 24 | ramp into peak |
| 3 | 120s | 30s | 24 | hold peak |
| 4 | 90s | 23s | 12 | afternoon cool-down |
| 5 | 60s | 15s | 2 | return to low traffic |

Lưu ý:

```text
effective duration = scaleSeconds(raw_seconds, RV_NN_DURATION_SCALE)
scaleSeconds = max(1, round(seconds * scale)) seconds
```

`stage.target` là absolute VU target ở cuối stage.

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

### Closed model trong từng stage

```text
Trong mỗi stage (kể cả ramp-up và ramp-down):
  - Mỗi active VU loop default() theo closed model
  - Loop xong → VU bắt đầu loop mới (nếu chưa hết stage)
  - KHÔNG có queue, KHÔNG có drop, KHÔNG có target iteration

Trong ramp-up:
  - VU mới được thêm vào → bắt đầu loop mới
  - VU cũ vẫn đang chạy loop hiện tại
  - Tổng iter/s = sum(1/loop_duration_i) cho tất cả active VU

Trong plateau:
  - VUs = constant → giống constant-vus trong stage này
  - iter/s nên ổn định nếu backend không degrade

Trong ramp-down:
  - VU bị chọn để dừng → gracefulRampDown cho finish loop hiện tại
  - VU finish loop → dừng, không start loop mới
  - VU chưa bị chọn → vẫn loop bình thường
```

### gracefulRampDown behavior

```text
gracefulRampDown = 15s nghĩa là:
  - Khi ramp-down chọn 1 VU để dừng, VU đó có 15s để finish iteration hiện tại
  - Nếu loop hiện tại finish trong < 15s: VU dừng ngay sau khi loop xong
  - Nếu loop hiện tại > 15s: VU bị interrupted sau 15s
  - interrupted iterations hiển thị trong summary

Với daily curve case này:
  - loop_duration ~0.4-0.5s (với sleep 0.4s)
  - 15s grace >> 0.5s loop → gần như không có interrupted
  - Nhưng nếu backend cực chậm (loop=20s) → sẽ có interrupted

Nếu VUs giảm nhưng iterations vẫn hoàn tất thêm:
  gracefulRampDown có thể đang cho in-flight loops finish.
```

### Per-stage throughput expectation

```text
Stage 1 (2->8 VU):
  VU avg ~5, loop ~0.5s → iter/s ~10
  Đây là LOW throughput — bình thường

Stage 2 (8->24 VU):
  VU avg ~16, loop ~0.5s → iter/s ~32
  Throughput TĂNG theo VU — expected

Stage 3 (24 VU plateau):
  VU = 24, loop ~0.5s → iter/s ~48
  Nếu iter/s << 48: BACKEND SATURATED
  Nếu iter/s ~48: backend khỏe

Stage 4 (24->12 VU):
  VU avg ~18, loop ~0.5s → iter/s ~36
  Throughput GIẢM theo VU — expected

Stage 5 (12->2 VU):
  VU avg ~7, loop ~0.5s → iter/s ~14
  Throughput thấp — expected
```

Nếu VUs tăng nhưng iter/s không tăng:

```text
ramping_flow_duration_ms có thể đã tăng
backend/service có thể đã saturated
```

Đây là closed-model backpressure signal trong ramp-up context.

Nếu VUs giảm nhưng iterations vẫn hoàn tất thêm:

```text
gracefulRampDown có thể đang cho in-flight loops finish
```

### So sánh closed model ramp-up vs open model ramp-up

```text
CLOSED MODEL RAMP-UP (ramping-vus):
  Input:  VUs tăng từ 2 → 8 → 24
  Output: iter/s, RPS (tăng nếu backend còn capacity, flatten nếu saturated)
  Signal: "VUs tăng + iter/s flatten" = capacity limit found
  
  Giống thực tế: thêm khách vào siêu thị, mỗi khách tự browse
  → Nếu siêu thị đông quá, mỗi khách browse chậm hơn
  → Tổng khách ra khỏi siêu thị mỗi phút không tăng thêm

OPEN MODEL RAMP-UP (ramping-arrival-rate):
  Input:  rate tăng từ 10 → 40 → 60 iter/s
  Output: VUs (k6 tự quyết định cần bao nhiêu VU)
  Signal: "rate tăng + VUs tăng + latency tăng" = capacity limit
  
  Giống: ép một lượng khách mới vào siêu thị mỗi phút
  → K6 tự động thêm nhân viên (VU) để xử lý
  → Không giống thực tế: khách không tự nhiên "sinh ra" để giữ rate
```

## Technical root causes this case catches

Mỗi nguyên nhân dưới đây là một pattern lỗi thực tế mà ramping-vus phát hiện được, đặc biệt trong bối cảnh staged concurrency — nơi vấn đề có thể chỉ xuất hiện ở 1 stage cụ thể.

### Nguyên nhân kỹ thuật 1: Product browse latency can flatten iter/s during peak

**Vấn đề**: Khi VUs ramp từ 2 lên 24 (stage 1 và 2), iter/s đáng lẽ tăng tuyến tính. Nhưng nếu products-service bắt đầu chậm ở một mức VU nhất định, loop_duration tăng và iter/s flatten — dù VUs vẫn đang tăng. Đây là closed-model backpressure signal ĐẶC TRƯNG của ramping-vus.

**Real-world analogy**:

```text
Siêu thị buổi sáng:
  8h: 2 khách, mỗi khách browse 1 vòng mất 30 giây
  9h: 8 khách, mỗi khách vẫn browse 30 giây/vòng (chưa đông)
  10h: 16 khách, lối đi bắt đầu chật → browse 40 giây/vòng
  11h: 24 khách, lối đi rất chật → browse 60 giây/vòng
  
  Tổng số vòng browse hoàn tất mỗi phút:
    8h (2 khách): 2 × 2 = 4 vòng/phút
    9h (8 khách): 8 × 2 = 16 vòng/phút
    10h (16 khách): 16 × 1.5 = 24 vòng/phút (đáng lẽ 32!)
    11h (24 khách): 24 × 1.0 = 24 vòng/phút (FLAT so với 10h!)
  
  → Dù số khách tăng từ 16 lên 24, throughput không tăng
  → Đây là CAPACITY LIMIT của siêu thị
```

**Demo trace: 3 scenarios of latency at different VU levels**

```text
Scenario A — HEALTHY SCALING (backend đủ capacity):
  Stage 1 (2->8 VU):  loop ~0.45s, iter/s tăng 4.4 → 17.8
  Stage 2 (8->24 VU): loop ~0.45s, iter/s tăng 17.8 → 53.3
  Stage 3 (24 VU):    loop ~0.45s, iter/s ~53.3 (ỔN ĐỊNH)
  Stage 4 (24->12 VU): loop ~0.45s, iter/s giảm 53.3 → 26.7
  Stage 5 (12->2 VU):  loop ~0.45s, iter/s giảm 26.7 → 4.4

  → iter/s TĂNG TUYẾN TÍNH theo VUs
  → Backend khỏe, chưa tới capacity limit

Scenario B — PEAK SATURATION (backend saturated ở ~18 VU):
  Stage 1 (2->8 VU):  loop ~0.45s, iter/s tăng 4.4 → 17.8  ✓
  Stage 2 (8->24 VU): loop bắt đầu tăng ở VU ~15
                      VU=15: loop=0.50s
                      VU=20: loop=0.70s
                      VU=24: loop=1.20s
                      iter/s ở cuối stage 2: 24/1.20 = 20 (FLAT!)
  Stage 3 (24 VU):    loop ~1.20s, iter/s ~20 (KHÔNG tăng thêm)
  Stage 4 (24->12 VU): loop giảm dần về 0.50s, iter/s 20 → 24
                      (iter/s thực ra TĂNG khi VU giảm! — recovery signal)
  Stage 5 (12->2 VU):  loop ~0.45s, iter/s giảm 26.7 → 4.4 (bình thường)

  → iter/s FLAT ở stage 2-3 dù VUs tăng
  → CAPACITY LIMIT ở khoảng 15-18 VU
  → ĐÂY LÀ TÍN HIỆU QUAN TRỌNG

Scenario C — INTERMITTENT DEGRADATION (chậm theo chu kỳ ở peak):
  Stage 1-2: bình thường
  Stage 3 (24 VU plateau):
    t=45-55s: loop=0.45s, iter/s=53 ✓
    t=55-65s: loop=1.50s, iter/s=16 ← SPIKE LATENCY
    t=65-75s: loop=0.45s, iter/s=53 ✓ (hồi phục)
  
  → Pattern dao động chu kỳ trong plateau
  → Có thể: GC pause, cron job, cache refresh mỗi 10s
  → Ramping-vus capture được vì plateau đủ dài (30s)
```

**Cách phát hiện trên dashboard**:

```text
VUs vs iter/s chart:
  - Stage 1-2: VUs tăng, iter/s tăng → bình thường
  - Stage 2-3: VUs tiếp tục tăng nhưng iter/s FLAT → CAPACITY LIMIT
  - Stage 4: VUs giảm, iter/s KHÔNG giảm (thậm chí tăng) → recovery
  → Đây là pattern "capacity knee" của ramping-vus

Execution timeline:
  - RPS/iter/s per bucket: thấy iter/s không tăng ở các bucket cuối stage 2
  - Nếu plateau có pattern dao động: thấy chu kỳ

Response time by operation:
  - Lọc theo operation trong stage 2-3
  - Tìm operation nào có p95 tăng khi VU > 15
  - Nếu chỉ browse tăng: products-service bottleneck
  - Nếu tất cả tăng: infrastructure bottleneck
```

**Đừng nhầm**: iter/s flatten khi VUs tăng không phải "k6 không bơm đủ VU". Đó là "backend không handle được thêm VU" — closed-model capacity signal.

### Nguyên nhân kỹ thuật 2: Checkout branch nhỏ nhưng kéo tail latency

**Vấn đề**: Checkout chỉ 8% weighted mix nhưng có order/external dependency, có thể kéo p95/p99 aggregate, đặc biệt ở stage peak khi nhiều VU cùng checkout.

**Real-world analogy**:

```text
Siêu thị có 24 khách. 22 người browse, 2 người ra quầy tính tiền.

Bình thường:
  - Browse: 30 giây/khách
  - Checkout: 2 phút (quầy tính tiền)

Nếu 2 quầy tính tiền, 2 khách checkout:
  → Mỗi khách 2 phút → OK

Nhưng nếu 1 quầy hỏng, còn 1 quầy:
  → 2 khách checkout, 1 quầy → mỗi khách 4 phút
  → Checkout latency TĂNG GẤP ĐÔI

Và nếu 4 khách checkout (giờ cao điểm, nhiều người mua):
  → 1 quầy, 4 khách → mỗi khách 8 phút
  → Checkout p95 bị kéo lên nghiêm trọng
```

**Demo trace: checkout kéo aggregate p95 trong mixed flow**

```text
Run với 24 VU peak, mixed flow 70/22/8:

Trong stage 3 (peak plateau, 30s):
  iterations ≈ 30s × (24/0.5) ≈ 1440 iterations
  checkout iterations ≈ 1440 × 0.08 ≈ 115 iterations
  
  Response time từng operation (p95):
    daily_curve_list:     45ms
    daily_curve_detail:   35ms
    daily_curve_cart_add: 55ms
    daily_curve_checkout: 850ms  ← CAO GẤP 15-20 LẦN!

  Aggregate http_req_duration p95:
    Tổng requests ~ 1440 × ~1.7 avg requests/loop ≈ 2450 requests
    Trong đó checkout: 115 × 1 = 115 requests (~4.7%)
    Nhưng checkout p95=850ms
    
    → Aggregate p95 có thể bị kéo lên ~150-200ms
    → Nhìn aggregate: "p95 ~180ms, ổn"
    → Nhìn riêng checkout: "p95=850ms — CẦN ĐIỀU TRA!"

Nếu checkout degraded ở peak (order-service quá tải vì 24 VU):
  daily_curve_checkout p95: 850ms → 3500ms
  Aggregate p95: 180ms → 380ms
  → Dễ bỏ sót nếu chỉ nhìn aggregate!
```

**Cách phát hiện**:

```text
Trên Response time chart:
  - LUÔN group/filter theo tag operation
  - So sánh p95 của checkout vs browse vs cart
  - Đặc biệt: so sánh checkout p95 Ở TỪNG STAGE
    Stage 1 (2-8 VU):  checkout p95 thường thấp
    Stage 3 (24 VU):   checkout p95 có thể tăng đột biến
    → Nếu checkout p95 tăng phi tuyến theo VU → order-service bottleneck

Trên dashboard:
  - KHÔNG chỉ nhìn aggregate http_req_duration
  - Phải drill down: operation=daily_curve_checkout
  - So sánh checkout count vs expected (8% của total iter):
    Nếu checkout count << 8%: checkout bị fail/timeout nhiều
    Nếu checkout count ~8% nhưng p95 cao: checkout chậm nhưng vẫn chạy
```

**Checkout p95 decomposition**:

```text
daily_curve_checkout = POST /api/sim/checkout
  Thường bao gồm:
    - Validate cart items (internal, nhanh)
    - Tính tổng tiền (internal, nhanh)
    - Gọi external payment (external_ms, có thể CHẬM)
    - Tạo order record (internal, nhanh)

  → external_ms là bottleneck chính của checkout
  → Nếu checkout p95 cao, nghi ngờ external dependency đầu tiên
  → Kiểm tra: checkout p95 có tăng theo VU count không?
    (Nếu có: order-service không scale được)
```

### Nguyên nhân kỹ thuật 3: Mixed services hide branch bottlenecks

**Vấn đề**: Với weighted mix products 70%, cart 22%, checkout 8%, nếu chỉ nhìn aggregate metrics, branch checkout (8%) bị "pha loãng". Checkout có thể đang fail hoặc cực chậm mà aggregate vẫn đẹp.

**Real-world analogy**:

```text
Bệnh viện có 100 bệnh nhân/giờ:
  92 người: khám thông thường (5 phút/người)
  8 người: cấp cứu (60 phút/người)

Nếu nhìn "thời gian trung bình":
  avg = (92×5 + 8×60) / 100 = 9.4 phút → "Ổn, dưới 10 phút"

Nhưng 8 người cấp cứu đợi 60 phút — CÓ THỂ CHẾT!
Aggregate che mất vấn đề nghiêm trọng.

Tương tự: checkout 8% nhưng nếu checkout fail, 8% khách hàng
không mua được hàng → mất doanh thu từ 8% khách.
```

**Demo trace: aggregate OK nhưng checkout branch chết ở peak**

```text
Run daily curve, stage 3 (peak 24 VU):

Aggregate metrics:
  http_reqs:            ~4500
  http_req_failed:      0.5%     ← Có vẻ ổn
  http_req_duration avg: 85ms    ← Có vẻ nhanh
  http_req_duration p95: 250ms   ← Có vẻ chấp nhận được

Tách theo operation:
  daily_curve_list:     1800 req, p95=45ms,  0 fail
  daily_curve_detail:   1800 req, p95=35ms,  0 fail
  daily_curve_cart_add: 700 req,  p95=55ms,  0 fail
  daily_curve_checkout: 200 req,  p95=3500ms, 15 fail (7.5%!)

  → Checkout: p95=3500ms, 7.5% fail rate → ĐANG CÓ VẤN ĐỀ NGHIÊM TRỌNG
  → Nhưng aggregate: p95=250ms, 0.5% fail → CHE MẤT HOÀN TOÀN

Nếu không tách operation:
  → Tưởng hệ thống ổn
  → Thực ra 8% khách checkout đang bị fail/timeout
  → Mất doanh thu từ những khách này
```

**Cách phát hiện**:

```text
Trên dashboard, LUÔN tách metric theo operation tag:

Response time chart:
  - Group by: operation
  - Xem riêng từng đường: list, detail, cart_add, checkout
  - Nếu 1 đường cao vọt lên ở stage 2-3 → bottleneck branch
  - Đặc biệt: so sánh cùng 1 operation GIỮA CÁC STAGE
    checkout p95 stage 1 (2-8 VU) vs stage 3 (24 VU)

Execution timeline:
  - Lọc theo operation: checkout requests per bucket
  - Checkout count ở stage 3 có ~8% của total iter không?
  - Nếu checkout count = 0 trong vài bucket ở peak: checkout bị block

Checks:
  - Lọc checks fail theo operation tag
  - "checkout status 200" fail nhiều hơn "list status 200"?
```

**Công thức kiểm tra mix có đúng không, PER STAGE**:

```text
Expected operation distribution với weighted mix 70/22/8:

  total_iterations_stage_N = iterations hoàn tất trong stage N

  expected_browse_iterations  ≈ total × 0.70
  expected_cart_iterations    ≈ total × 0.22
  expected_checkout_iterations ≈ total × 0.08

  Nếu checkout_iterations_stage_3 << total × 0.08:
    → Checkout branch bị fail/timeout ở peak
    → Mất coverage checkout ở high concurrency

  Nếu cart_iterations << expected:
    → Cart branch có vấn đề

  Lưu ý: đây là EXPECTED gần đúng (weighted random), không phải exact.
  Với 1440 iter ở stage 3, expected checkout=115; thực tế 90-140 là bình thường.
  Nếu thực tế checkout=15 → bất thường.
```

### Nguyên nhân kỹ thuật 4: Cool-down và gracefulRampDown

**Vấn đề**: Khi ramp-down từ 24 xuống 12 rồi 2 VUs (stage 4 và 5), residual iterations có thể hoàn tất trong graceful ramp-down. Nếu loop dài hơn grace, iterations bị interrupted. Và nếu backend chưa kịp hồi phục sau peak, latency có thể vẫn cao dù VUs đã giảm.

**Real-world analogy**:

```text
Siêu thị lúc 14h (bắt đầu vắng):
  - 24 khách lúc 13h, bắt đầu rời dần
  - Nhưng khách đang đứng ở quầy tính tiền (in-flight)
    không bị "đuổi ra" ngay — họ tính tiền xong mới ra
  - Đó là gracefulRampDown

Nếu quầy tính tiền quá chậm (1 khách mất 20 phút):
  - Khách bị "kẹt" ở quầy dù siêu thị đã vắng
  - Trong k6: iteration bị interrupted nếu > gracefulRampDown

Và nếu siêu thị bừa bộn sau giờ cao điểm:
  - Dù chỉ còn 2 khách, họ vẫn browse chậm hơn bình thường
  - Vì nhân viên đang dọn dẹp, lối đi còn bừa bộn
  - Trong k6: latency vẫn cao dù VUs đã thấp → residual effect
```

**Demo trace: gracefulRampDown behavior**

```text
Config: gracefulRampDown = 15s

Scenario A — NORMAL (loop ngắn << grace):
  Stage 4 (24->12 VU): VU bị chọn để dừng, loop ~0.5s
    → VU finish loop trong 0.5s << 15s → dừng sạch
    → Không có interrupted iterations

Scenario B — SLOW BACKEND (loop dài > grace):
  Stage 4 (24->12 VU): backend đang chậm, loop ~20s
    → VU bị chọn để dừng, đang giữa loop 20s
    → Sau 15s grace: iteration bị INTERRUPTED
    → Summary hiển thị "iterations_interrupted: X"
    → Đây là SIGNAL: "loop quá dài so với grace, cần tối ưu"

Scenario C — RESIDUAL LATENCY (backend chưa hồi phục):
  Stage 5 (12->2 VU): VUs thấp nhưng latency vẫn cao hơn stage 1
    Stage 1 (2-8 VU):  browse p95 = 45ms
    Stage 5 (12->2 VU): browse p95 = 120ms (CAO HƠN!)
    → Backend chưa hồi phục sau peak
    → Có thể: connection pool chưa release, cache bị evict, DB còn backlog
    → Đây là residual effect — quan sát được nhờ staged model
```

**Cách phát hiện**:

```text
Trên summary:
  - iterations_interrupted > 0 → loop dài hơn gracefulRampDown
  - So sánh loop_duration p95 với gracefulRampDown

Trên Execution timeline:
  - Stage 4-5: iterations vẫn xuất hiện dù VUs đã giảm
    → gracefulRampDown behavior (bình thường nếu ít)

Trên Response time chart:
  - So sánh latency stage 1 (trước peak) vs stage 5 (sau peak)
  - Nếu stage 5 latency >> stage 1: residual effect
  - Cần điều tra: backend có "dọn dẹp" sau peak không?

Trên VUs vs iter/s chart:
  - Stage 4: VUs giảm, iter/s giảm → bình thường
  - Stage 4: VUs giảm, iter/s KHÔNG giảm (thậm chí tăng) → recovery
    (backend đang "thở" lại, mỗi VU loop nhanh hơn)
```

## Identity model trong ramping-vus: VU = shopper được activate/deactivate theo stage

Đây là điểm khác biệt quan trọng với constant-vus (VU stable suốt duration) và shared-iterations (VU = anonymous worker).

### VU identity trong ramping-vus

```text
Trong ramping-vus:
  - VU được ACTIVATE khi stage ramp-up thêm VU mới
  - VU được DEACTIVATE khi stage ramp-down bớt VU
  - KHI ACTIVE: VU có identity ổn định (giống constant-vus)
  - Nhưng VU có thể bị dừng giữa chừng khi ramp-down

  Stage 1: 2 VU active → user-1, user-2
  Stage 2 (ramp-up): thêm VU → user-3, user-4, ..., user-24
  Stage 3 (plateau): 24 VU stable → tất cả user-1..24 active
  Stage 4 (ramp-down): bớt VU → user-24 dừng, user-23 dừng, ...
  Stage 5: còn 2 VU → user-1, user-2 (có thể là VU gốc hoặc VU khác)

Lưu ý: k6 không đảm bảo VU nào bị dừng trước khi ramp-down.
  → Không nên dựa vào "user-1 luôn sống từ đầu đến cuối"
  → Nhưng KHI ACTIVE, identity ổn định
```

### So sánh identity model giữa các executor

```text
constant-vus:
  VU=1 LUÔN là user-1 trong suốt 5 phút
  → Stable identity, không ai bị dừng giữa chừng

ramping-vus:
  VU=1 là user-1 KHI ACTIVE, nhưng có thể bị dừng ở ramp-down
  → Stable while active, có activation/deactivation cycle

shared-iterations:
  VU=1 là worker-1, xử lý job #0, rồi job #5, rồi job #12
  → Anonymous worker, không có user identity
```

### Code pattern: dùng __VU làm shopper identity

```js
import exec from "k6/execution";

export default function () {
  // Trong ramping-vus, __VU là shopper identity khi active
  const userId = exec.vu.idInTest;  // 1..24, ổn định khi VU active

  const params = {
    tags: {
      user_id: `shopper-${userId}`,   // shopper identity
      vu: userId,                      // để filter theo VU nếu cần
      case_id: "rv-01-daily-traffic-curve",
      business_case: "daily_traffic_curve",
    },
  };

  // Flow với shopper identity
  const listRes = http.get(`${BASE_URL}/api/sim/products?...`, params);
  // ...
}
```

**Khác với shared-iterations — nơi identity đến từ iterationInTest**:

```js
// shared-iterations: identity từ iterationInTest (global job index)
const skuIndex = exec.scenario.iterationInTest;  // 0..79

// ramping-vus: identity từ __VU (shopper, active trong stage)
const userId = exec.vu.idInTest;  // 1..24, ổn định khi active
```

### Mối quan hệ giữa các identity trong ramping-vus

```text
Ba khái niệm KHÁC NHAU trong ramping-vus:

1. __VU / exec.vu.idInTest:
   - Shopper identity khi VU active, 1 đến max VU (24)
   - Có thể bị deactivate ở ramp-down
   - Dùng làm: user_id, session (khi active)

2. __ITER:
   - Per-VU loop counter, bắt đầu từ 0 khi VU được activate
   - VU mới ở stage 2: __ITER bắt đầu từ 0
   - Cho biết: shopper này đã browse bao nhiêu vòng

3. exec.scenario.iterationInTest:
   - Global loop counter, từ 0 đến tổng số loops
   - DUY NHẤT cho mỗi loop trong toàn scenario
   - KHÔNG phải backlog job id (vì không có backlog)
```

## Service/API flow

Flow pattern:

```text
Weighted branch selection: browse 70, cart 22, checkout 8.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| daily_curve_list | products-service | GET | /api/sim/products | 200 | Product list during daily curve. |
| daily_curve_detail | products-service | GET | /api/sim/products/:id | 200 | Product detail browse. |
| daily_curve_cart_add | cart-service | POST | /api/sim/cart/add | 200 | Cart branch. |
| daily_curve_checkout | order-service | POST | /api/sim/checkout | 200 | Checkout branch. |

### Flow của từng branch

```text
BRANCH: browse (70%)
  1. GET /api/sim/products              → daily_curve_list
  2. sleep(think_time)                  → user đọc list
  3. GET /api/sim/products/:id          → daily_curve_detail
  4. sleep(think_time)                  → user đọc detail
  → Loop hoàn tất, VU bắt đầu loop mới

BRANCH: cart (22%)
  1. GET /api/sim/products              → daily_curve_list
  2. sleep(think_time)
  3. GET /api/sim/products/:id          → daily_curve_detail
  4. sleep(think_time)
  5. POST /api/sim/cart/add             → daily_curve_cart_add
  6. sleep(think_time)
  → Loop hoàn tất

BRANCH: checkout (8%)
  1. GET /api/sim/products              → daily_curve_list
  2. sleep(think_time)
  3. GET /api/sim/products/:id          → daily_curve_detail
  4. sleep(think_time)
  5. POST /api/sim/cart/add             → daily_curve_cart_add
  6. sleep(think_time)
  7. POST /api/sim/checkout             → daily_curve_checkout
  8. sleep(think_time)
  → Loop hoàn tất
```

### Tại sao checkout 8% (không phải 5%)?

```text
Trong daily traffic curve, checkout mix cao hơn business-hours storefront (8% vs 5%)
vì giờ cao điểm trưa, nhiều shopper mua hàng hơn.

Nếu muốn test checkout bottleneck rõ hơn:
  → Tăng checkout weight lên 15-20%
  → Xem variation ở phần Mở rộng
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
case_id       = rv-01-daily-traffic-curve
business_case = daily_traffic_curve
workload      = staged_concurrency
```

### Cách đọc metric với weighted mix và stage context

```text
Để kiểm tra weighted mix có đúng không:

  total_iterations = N (từ summary iterations)

  expected_browse_iterations  ≈ N × 0.70
  expected_cart_iterations    ≈ N × 0.22
  expected_checkout_iterations ≈ N × 0.08

  (Đây là expected gần đúng — weighted random không ra exact)

Để kiểm tra API calls per stage (nếu dashboard hỗ trợ filter by stage/time):

  ramping_api_calls_total ≈
    browse_iterations  × 2 +
    cart_iterations     × 3 +
    checkout_iterations × 4
```

## Pass criteria

Thresholds theo backend script:

```text
checks: rate>0.99
http_req_failed: rate<0.01
ramping_active_iterations_failed: count<25
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

Chúng là observed outputs. Đặc biệt: iter/s stage 1 (2 VU) sẽ thấp hơn stage 3 (24 VU) — đó là expected.

### Tại sao không có pass criteria cho iterations count?

```text
Nếu đặt: "iterations phải > 5000 mới pass"

Vấn đề:
  - Backend nhanh: iter/s=60 ở peak, tổng ~4380 iterations → PASS
  - Backend chậm: iter/s=30 ở peak, tổng ~2500 iterations → FAIL

  Nhưng "backend chậm ở peak" mới là điều ta muốn PHÁT HIỆN!
  Nếu fail test vì iterations thấp, ta đã phát hiện vấn đề.
  Nhưng nếu đặt threshold quá cao, test luôn fail dù backend bình thường.

Thay vào đó, dùng latency thresholds nếu muốn performance gate:
  "http_req_duration{operation:daily_curve_list}": ["p(95)<200"],
  "http_req_duration{operation:daily_curve_checkout}": ["p(95)<1500"],

Hoặc dùng trend metric:
  "ramping_flow_duration_ms": ["p(95)<1000"],
```

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js
```

Override env vars:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RV_01_PEAK_VUS = 48
$env:RV_01_DURATION_SCALE = 0.5
$env:RV_01_SLEEP_SECONDS = 0.2
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = daily_traffic_curve
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 2 -> 8 -> 24 -> 12 -> 2
```

`vus_max` nên gần peak target nếu run đủ dài và dashboard sample bắt được peak.

```text
Trên VUs vs iter/s chart:
  - Stage 1: VUs tăng 2 → 8
  - Stage 2: VUs tăng 8 → 24
  - Stage 3: VUs phẳng ở 24
  - Stage 4: VUs giảm 24 → 12
  - Stage 5: VUs giảm 12 → 2
  
  Nếu VUs không theo shape: kiểm config, scale factor, dashboard ingestion
  Nếu VUs < target: maxVUs không đủ hoặc env override
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
  1. checks rate < 0.99 → có request sai status/contract → BLOCK
  2. http_req_failed > 0.01 → có HTTP failure → BLOCK
  3. ramping_active_iterations_failed >= 25 → user loop fail nhiều → BLOCK

  Chỉ khi 3 metric trên pass → mới phân tích latency/throughput per stage
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

Đặc biệt với ramping-vus: so sánh iterations GIỮA CÁC STAGE nếu dashboard hỗ trợ.

```text
Cách so sánh 2 run cùng config:
  1. Check failures trước (phải pass cả 2)
  2. So sánh iterations: run nào ít hơn → loop_duration dài hơn
  3. Check ramping_flow_duration_ms: run nào p95 cao hơn → backend chậm hơn
  4. So sánh per-stage nếu có thể:
     - Stage 3 (peak) iterations của run A vs run B
     - Nếu run B stage 3 iter thấp hơn nhiều → peak saturation
  5. Kết luận: "run B bị saturated ở peak 24 VU, flow_duration tăng X%"
```

### Bước 5 — Interpret duration/throughput

Đọc:

```text
ramping_flow_duration_ms
http_req_duration by operation
iteration_duration
```

Case-specific notes:

- VUs/vus_max phải đối chiếu với peak 24 và stage shape.
- Branch mix 70/22/8 là expected ratio over enough loops, không phải exact per bucket.
- Nếu iter/s flatten ở peak, đọc `ramping_flow_duration_ms` và operation p95.
- So sánh latency stage 1 vs stage 3 vs stage 5: có tăng/giảm theo VU không?
- Nếu stage 5 latency > stage 1 latency: residual effect sau peak.

### Bước 6 — Verify weighted mix distribution per stage

```text
Từ summary, estimate operation distribution:

  total_iterations = N (từ summary)
  
  Browse iterations  ≈ N × 0.70 (khoảng)
  Cart iterations    ≈ N × 0.22 (khoảng)
  Checkout iterations ≈ N × 0.08 (khoảng)

  Nếu checkout count << N × 0.08: checkout branch đang fail
  Nếu cart count << N × 0.22: cart branch có vấn đề

  Lưu ý: weighted random có độ lệch tự nhiên ±10-20%
  Với N=4380, checkout expected=350, actual 280-420 là bình thường
  Nếu actual=50 → bất thường
```

<!-- REAL_RUN_START -->
## Contract rerun 2026-06-20 — run #58

Run này ép đúng contract/tải đã ghi trong tài liệu, sau lần BE fix mới nhất.

```text
BASE_URL=http://localhost:80
K6_CLOUD_HOST=http://localhost:18080
RV_01_START_VUS=2
RV_01_MORNING_VUS=8
RV_01_PEAK_VUS=24
RV_01_AFTERNOON_VUS=12
RV_01_DURATION_SCALE=0.25
RV_01_SLEEP_SECONDS=0.4
```

| Item | Value |
| --- | --- |
| Script | `rv-01-daily-traffic-curve.js` |
| Run ID | `58` |
| Exit code | `0` |
| Verdict | **PASS** — Đạt theo contract gốc |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `2 -> 8 -> 24 -> 12 -> 2` |
| Observed `vus` min/max | 2 / 24 |

### Summary thật của contract rerun

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 100.00% (7329/7329) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/7329) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 0 | User-loop failures của case. |
| `iterations` | 4380 (38.64/s) | Output, không phải target. |
| `http_reqs` | 7329 (64.66/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 4380 | Completed user loops. |
| `ramping_api_calls_total` | 7329 | Custom API counter. |
| `ramping_sleep_seconds` | 1752.0s | Think time do script thêm. |
| `http_req_duration` | avg 5.62ms, p95 5.82ms, p99 89.0ms, max 122ms | Request-level latency. |
| `ramping_flow_duration_ms` | avg 9.52ms, p95 78.0ms, p99 92.0ms, max 121ms | Full user-loop latency. |
| `iteration_duration` | avg 410ms, p95 478ms, p99 492ms, max 522ms | Bao gồm flow + think/sleep. |

Threshold failures:

Không có threshold failure.

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `daily_curve_list` | GET | 200 | 2949 | 40.24% |
| `daily_curve_detail` | GET | 200 | 2949 | 40.24% |
| `daily_curve_cart_add` | POST | 200 | 1117 | 15.24% |
| `daily_curve_checkout` | POST | 200 | 314 | 4.28% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

Latency request ổn và không còn 429. `daily_curve_list`, `daily_curve_detail`, `daily_curve_cart_add`, `daily_curve_checkout` đều status 200. Đây là dấu hiệu BE đã xử lý xong product-list throttling cho daily curve peak 24 VUs.

| Aggregate | Value |
| --- | ---: |
| Response-time points | 4284 |
| Avg của các window avg | 8.04ms |
| Max window p95 | 122ms |
| Max window p99 | 122ms |
| Max request window | 122ms |
| Windows p95 > 100ms | 9 |
| Windows p95 > 500ms | 0 |

#### 2. Execution timeline chart

Execution timeline không còn failed iterations. Tổng request breakdown chỉ có status 200, nên lỗi 29 failed loops ở run #51 đã hết.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 4380 |
| Sum `http_reqs` buckets | 7329 |
| Peak iter/s bucket | 64 |
| Peak http_req/s bucket | 113 |
| Failed-iteration points | 0 |
| Sum failed iterations | 0 |
| Peak failed-iteration bucket | 0 |

#### 3. VUs vs iter/s chart

VU shape đạt peak 24 đúng contract `2 -> 8 -> 24 -> 12 -> 2`. Peak/plateau chạy đúng active-user curve và thresholds đều pass.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 113 |
| VUs min/max series | 2 / 24 |
| Avg VUs series | 15.86 |
| Peak iter/s bucket | 64 |

### Kết luận contract rerun #58

OK theo contract gốc. Case 01 đã pass sau fix mới nhất.
<!-- REAL_RUN_END -->

## Đọc dashboard real-time charts cho case 01

> Phần này giữ cách đọc dashboard chung; số thật của run gần nhất nằm ở section `Contract rerun` phía trên.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm theo phase? | Fixed iteration target |
| Execution timeline | VUs/failures/RPS thay đổi theo stage nào? | Target RPS, vì không có target RPS |
| VUs vs iter/s | VU shape có đúng không, iter/s có flatten không? | Business correctness nếu không đọc failures |

Một cách đọc nhanh:

```text
Response time      -> chất lượng request per stage, phát hiện bottleneck operation
Execution timeline -> throughput pattern per stage, phát hiện stage transition issues
VUs vs iter/s      -> VU shape validation, phát hiện capacity knee và backpressure
```

### Chart 1 — Response time

Đây là chart request-level latency. Với case này, PHẢI đọc theo `operation`, không đọc aggregate. Và quan trọng: PHẢI đọc THEO STAGE.

#### Các operation cần tách

```text
daily_curve_list:      GET /api/sim/products
daily_curve_detail:    GET /api/sim/products/:id
daily_curve_cart_add:  POST /api/sim/cart/add
daily_curve_checkout:  POST /api/sim/checkout
```

#### Cách đọc

```text
http_req_duration        = latency từng request (KHÔNG bao gồm sleep)
ramping_flow_duration_ms = latency full user loop (có thể không bao gồm sleep)
iteration_duration       = duration vòng default(), thường bao gồm sleep
```

Đừng dùng aggregate p95 một mình trong mixed/multi-operation flow.

#### Phân tích sâu chart Response time — THEO TỪNG STAGE

Khi nhìn chart này, đọc theo 5 câu hỏi:

```text
1. Operation nào có p95 cao nhất?
2. p95 của checkout có >> p95 của browse không?
3. Có operation nào có p95 tăng khi stage chuyển từ 1→2→3 không?
4. Có operation nào có p95 giảm khi stage chuyển từ 3→4→5 không?
5. Stage 5 latency có về bằng stage 1 latency không? (residual check)
```

Shape mong đợi với case 01 — STAGE BY STAGE:

```text
Stage 1 (2->8 VU, morning ramp):
  - Tất cả operation p95 thấp (ít concurrent requests)
  - checkout p95 có thể cao hơn browse (bình thường, có external_ms)
  - Đây là BASELINE latency

Stage 2 (8->24 VU, ramp to peak):
  - p95 CÓ THỂ tăng dần khi VU tăng
  - Nếu p95 tăng phi tuyến (VU x2 nhưng p95 x4): bottleneck signal
  - Quan sát: ở VU nào p95 bắt đầu tăng mạnh? → capacity knee

Stage 3 (24 VU, peak plateau):
  - p95 nên ỔN ĐỊNH nếu backend sustain được
  - Nếu p95 TĂNG DẦN trong 30s plateau: degradation under sustained load
  - So sánh p95 đầu plateau vs cuối plateau
  - Checkout p95 thường cao nhất (external dependency)

Stage 4 (24->12 VU, afternoon ramp-down):
  - p95 nên GIẢM khi VU giảm
  - Nếu p95 KHÔNG giảm: backend chưa hồi phục
  - Có thể thấy recovery pattern: p95 giảm nhanh lúc đầu, chậm dần

Stage 5 (12->2 VU, evening low):
  - p95 nên về gần stage 1 baseline
  - Nếu stage 5 p95 >> stage 1 p95: RESIDUAL EFFECT
  - Cần điều tra: backend có "dọn dẹp" sau peak không?
```

#### Decomposition p95 theo stage

```text
Đây là kỹ thuật quan trọng: tách aggregate p95 THEO STAGE để tìm stage nào có vấn đề.

Giả sử aggregate http_req_duration p95 toàn run = 120ms.

Tách theo stage:
  Stage 1 (2-8 VU):   aggregate p95 = 50ms   (thấp)
  Stage 2 (8-24 VU):  aggregate p95 = 95ms   (tăng dần)
  Stage 3 (24 VU):    aggregate p95 = 180ms  (cao nhất)
  Stage 4 (24-12 VU): aggregate p95 = 130ms  (giảm)
  Stage 5 (12-2 VU):  aggregate p95 = 70ms   (về thấp)

  → Pattern bình thường: p95 tăng theo VU, giảm theo VU
  → Stage 5 p95 (70ms) > Stage 1 p95 (50ms): residual nhẹ, chấp nhận được

Tách sâu hơn trong stage 3:
  daily_curve_list:      p95=65ms   (nhanh)
  daily_curve_detail:    p95=55ms   (nhanh)
  daily_curve_cart_add:  p95=80ms   (nhanh)
  daily_curve_checkout:  p95=950ms  (CHẬM, kéo aggregate stage 3)

  → Checkout là bottleneck ở peak
  → Cần điều tra order-service ở 24 VU
```

#### Shape xấu cần chú ý — THEO STAGE

| Shape thấy trên chart | Stage | Có thể nghĩa là gì | Hành động |
| --- | --- | --- | --- |
| Browse p95 tăng mạnh ở stage 2-3 | 2, 3 | products-service saturated ở peak | Tăng capacity products-service |
| Checkout p95 >> browse p95 (gấp 15x+) | 3 | External payment/order bottleneck ở peak | Inspect order-service |
| Tất cả p95 cùng tăng ở stage 3 | 3 | Infrastructure bottleneck ở 24 VU | Kiểm CPU/mem/pool |
| p95 dao động chu kỳ trong stage 3 | 3 | GC pause, cron job, cache refresh | Correlate với system metrics |
| Stage 5 p95 >> stage 1 p95 | 5 | Residual effect sau peak | Điều tra cleanup/recovery |
| Stage 4 p95 không giảm dù VU giảm | 4 | Backend chưa hồi phụ, queue còn backlog | Kiểm tra queue depth |
| Checkout p95 spike đột ngột ở stage 2 | 2 | Order-service không handle được ramp | Thêm grace period cho order-service |
| Cart p95 tăng ở stage 2-3 | 2, 3 | cart-service bottleneck | Điều tra cart-service |

### Chart 2 — Execution timeline

Chart này trả lời câu hỏi KHÁC với Response time:

```text
Response time chart:
  "request nhanh/chậm thế nào ở từng stage?"

Execution timeline:
  "tại mỗi bucket, VUs đang ở stage nào? 
   Có bao nhiêu iterations/http_reqs? 
   Có failure cluster ở stage transition không?"
```

Với ramping-vus:

```text
VUs should follow 2 -> 8 -> 24 -> 12 -> 2.
iterations/http_reqs per bucket are outputs.
failures may cluster at ramp transitions or peak.
```

#### Cách đọc Execution timeline — THEO STAGE

Khi đọc chart này, nhìn 4 thứ cùng lúc:

```text
1. Live VUs — có đi theo stage shape không?
2. HTTP reqs per bucket — RPS thay đổi theo stage thế nào?
3. Iterations per bucket — iter/s pattern per stage?
4. Failures per bucket — có cluster ở transition không?
```

Shape mong đợi — STAGE BY STAGE:

```text
Stage 1 (0-15s, 2->8 VU):
  - Live VUs tăng 2 → 8 (bậc thang mỗi ~2.5s)
  - HTTP reqs và iterations: tăng dần từ thấp
  - Failures: 0 (low load)

Stage 2 (15-45s, 8->24 VU):
  - Live VUs tăng 8 → 24 (bậc thang mỗi ~1.88s)
  - HTTP reqs: tăng mạnh, có thể đạt peak ở cuối stage
  - Iterations: tăng theo VU
  - Failures: nếu có, thường xuất hiện ở cuối stage 2 (khi backend bắt đầu saturated)

Stage 3 (45-75s, 24 VU plateau):
  - Live VUs = 24 (PHẲNG)
  - HTTP reqs: CAO và ỔN ĐỊNH (nếu backend khỏe)
  - HTTP reqs: CAO nhưng GIẢM DẦN (nếu backend degrade)
  - Iterations: tương tự pattern
  - Failures: nếu backend saturated, có thể tăng dần

Stage 4 (75-98s, 24->12 VU):
  - Live VUs giảm 24 → 12 (bậc thang mỗi ~1.92s)
  - HTTP reqs: giảm dần theo VU
  - Có thể thấy residual iterations (gracefulRampDown)
  - Failures: nếu có, nên giảm dần

Stage 5 (98-113s, 12->2 VU):
  - Live VUs giảm 12 → 2
  - HTTP reqs: thấp dần
  - Failures: về 0
```

Không kỳ vọng exact per-bucket counts, đặc biệt với weighted/conditional flows.

#### Pattern cần đọc

| Pattern | Stage | Nghĩa |
| --- | --- | --- |
| VUs không theo stage shape | All | Config/env sai, scale factor issue |
| HTTP reqs không tăng khi VU tăng | 1, 2 | VU chưa kịp start loop, hoặc request treo |
| HTTP reqs FLAT dù VU tăng | 2 | Backend saturated — capacity limit |
| HTTP reqs GIẢM dù VU phẳng | 3 | Backend degrade dưới sustained load |
| Failures cluster ở transition | 1→2, 2→3 | Ramp-up stress — thêm VU gây lỗi |
| Failures cluster ở peak | 3 | Peak không sustain được |
| Residual iterations sau khi VU giảm | 4, 5 | gracefulRampDown behavior (bình thường nếu ít) |
| Iterations = 0 trong bucket đầu | 1 | Bình thường — loop đầu chưa kịp xong |
| VUs giảm về 0 trước stage 5 | 4, 5 | maxDuration cắt hoặc gracefulStop quá sớm |

### Chart 3 — VUs vs iter/s

Đây là chart **quan trọng nhất cho ramping-vus** — nó trả lời câu hỏi cốt lõi:

```text
VU shape có đúng stage timeline không?
iter/s có tăng tuyến tính theo VU không?
Nếu không: capacity knee ở đâu?
```

#### Cách đọc sâu chart VUs vs iter/s — THEO STAGE

```text
4 thứ cần nhìn cùng lúc:

1. Executor VUs (đường VUs):
   - Có theo stage shape 2->8->24->12->2 không?
   - Stage 1 ramp: tăng bậc thang 2→8?
   - Stage 3 plateau: phẳng ở 24?
   - Stage 4-5 ramp-down: giảm bậc thang?

2. Actual iter/s (đường iterations per second):
   - Stage 1: tăng từ ~4 lên ~18?
   - Stage 2: tăng từ ~18 lên ~48-60?
   - Stage 3: ổn định ở ~48-60? hay flatten?
   - Stage 4: giảm từ ~48 về ~24?
   - Stage 5: giảm về ~4?

3. Mối quan hệ VU vs iter/s:
   - VU tăng + iter/s tăng tuyến tính = HEALTHY SCALING
   - VU tăng + iter/s FLAT = CAPACITY KNEE (closed-model backpressure)
   - VU giảm + iter/s KHÔNG giảm (thậm chí tăng) = RECOVERY

4. Transition points:
   - Stage 1→2: iter/s có jump không? (VU nhảy 8→9, step_interval thay đổi)
   - Stage 2→3: iter/s có tiếp tục tăng không? hay đã flatten từ cuối stage 2?
   - Stage 3→4: iter/s có giảm ngay không?
```

#### Expected shape

```text
Stage 1 (0-15s):
  - VUs: tăng 2 → 8 (bậc thang)
  - iter/s: tăng dần, thấp (2-8 VU, ít throughput)

Stage 2 (15-45s):
  - VUs: tăng 8 → 24 (bậc thang nhanh hơn)
  - iter/s: TĂNG MẠNH theo VU
  - Nếu iter/s TĂNG TUYẾN TÍNH: backend còn capacity
  - Nếu iter/s bắt đầu FLAT ở cuối stage: capacity knee found

Stage 3 (45-75s):
  - VUs: PHẲNG ở 24
  - iter/s: ỔN ĐỊNH (nếu backend khỏe)
  - iter/s: GIẢM DẦN (nếu backend degrade under sustained load)
  - ĐÂY LÀ STAGE QUAN TRỌNG NHẤT

Stage 4 (75-98s):
  - VUs: giảm 24 → 12
  - iter/s: GIẢM theo VU (bình thường)
  - iter/s: KHÔNG GIẢM, thậm chí TĂNG → RECOVERY (backend "thở" lại)

Stage 5 (98-113s):
  - VUs: giảm 12 → 2
  - iter/s: giảm về thấp
  - Về gần mức stage 1
```

#### THE MOST IMPORTANT SIGNALS

```text
SIGNAL 1 — VUs rising + iter/s FLAT (capacity knee):
  Stage 2, VUs 8→24 nhưng iter/s dừng ở ~35:
  
  VUs:   / / / / / / / / / / / / / (tiếp tục tăng đến 24)
  iter/s: / / / / - - - - - - - - (flat ở ~35 từ VU=16)
  
  Nghĩa là:
    - Backend saturated ở khoảng 16 VU
    - Thêm VU không tạo thêm throughput
    - Mỗi VU loop chậm hơn để bù
    → CAPACITY LIMIT = 16 VU, ~35 iter/s

SIGNAL 2 — VUs plateau + iter/s FALLING (degradation):
  Stage 3, VUs=24 phẳng nhưng iter/s giảm dần:
  
  VUs:   ========================== (phẳng ở 24)
  iter/s: \ \ \ \ \ \ \ \ \ \ \ \ \ (giảm dần)
  
  Nghĩa là:
    - Backend đang degrade dưới sustained load
    - Có thể: memory leak, connection pool cạn, GC pressure
    → SUSTAIN PROBLEM ở 24 VU

SIGNAL 3 — VUs falling + iter/s RISING (recovery):
  Stage 4, VUs 24→12 nhưng iter/s tăng:
  
  VUs:   \ \ \ \ \ \ \ \ \ \ \ \ \ (giảm)
  iter/s: / / / / - - - - - - - - (tăng rồi ổn định)
  
  Nghĩa là:
    - Backend đang "thở" lại sau peak
    - Mỗi VU loop nhanh hơn vì bớt contention
    → RECOVERY — backend chưa bị hỏng vĩnh viễn
```

#### Bad/important shapes

| Shape | Nghĩa |
| --- | --- |
| VUs follow stages, iter/s follows roughly | Healthy scaling shape |
| VUs rise, iter/s flat | Possible saturation/backpressure — capacity knee |
| VUs plateau, iter/s slowly falling | Degradation under sustained load |
| VUs fall, iterations continue briefly | gracefulRampDown behavior |
| VUs fall, iter/s rises | Recovery — backend "thở" lại |
| VUs not matching stages | Config/env/dashboard issue |
| iter/s = 0 trong nhiều bucket | VU bị kẹt — request treo hoặc sleep quá dài |
| iter/s spike/drop theo chu kỳ | Branch hoặc dependency latency thay đổi |

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận thresholds/failures.
2. VUs vs iter/s xác nhận stage shape và saturation signal.
3. Execution timeline xác nhận failures/throughput cluster ở phase nào.
4. Response time by operation tìm service/branch chậm — THEO TỪNG STAGE.
5. Business decision dựa trên phase + operation + failure pattern.
```

## Kết luận thực tế: output -> quyết định

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **daily traffic curve capacity gate**: output ra số như vậy thì team quyết định gì?

### Kịch bản A — output sạch: DAILY CURVE HEALTHY

```text
checks................: 100.00%
http_req_failed.......: 0.00%
ramping_active_iterations_failed: 0
iterations............: 4380       (output, không target)
http_reqs.............: 7329       (output, không target)

VU shape: 2 -> 8 -> 24 -> 12 -> 2 (đúng contract)

http_req_duration by operation (p95):
  daily_curve_list:     48ms
  daily_curve_detail:   35ms
  daily_curve_cart_add: 58ms
  daily_curve_checkout: 820ms

Stage-by-stage iter/s:
  Stage 1 (2-8 VU):   ~10 iter/s
  Stage 2 (8-24 VU):  ~35 iter/s (tăng theo VU)
  Stage 3 (24 VU):    ~50 iter/s (ổn định)
  Stage 4 (24-12 VU): ~35 iter/s (giảm theo VU)
  Stage 5 (12-2 VU):  ~10 iter/s

Stage 5 latency ≈ Stage 1 latency (không residual)
```

Kết luận thực tế:

```text
- Failures = 0: không có vấn đề functional
- VU shape đúng: input valid
- iter/s tăng/giảm theo VU: không có saturation
- Latency ổn định qua tất cả stage: backend khỏe ở mọi mức concurrency
- Stage 5 latency = Stage 1 latency: không residual effect
- Checkout p95 = 820ms: cao hơn nhưng trong ngưỡng chấp nhận

=> QUYẾT ĐỊNH: Daily traffic curve 2->8->24->12->2 PASS.
   Storefront chịu được daily curve với peak 24 VUs.
   Đây là baseline. Lưu latency numbers per stage làm reference.
```

### Kịch bản B — Peak saturation: VUs=24 nhưng iter/s flat (CAPACITY KNEE)

```text
checks................: 99.8%
http_req_failed.......: 0.2%
ramping_active_iterations_failed: 3
iterations............: 2800       ← THẤP HƠN baseline (4380)

VU shape: 2 -> 8 -> 24 -> 12 -> 2 (đúng contract)

Stage-by-stage iter/s:
  Stage 1 (2-8 VU):   ~10 iter/s  ✓
  Stage 2 (8-24 VU):  ~35 iter/s (đầu) → ~20 iter/s (cuối) ← FLAT!
  Stage 3 (24 VU):    ~20 iter/s  ← KHÔNG tăng thêm
  Stage 4 (24-12 VU): ~20 iter/s (đầu) → ~25 iter/s (cuối) ← RECOVERY!
  Stage 5 (12-2 VU):  ~15 iter/s

http_req_duration by operation (p95) — STAGE 3:
  daily_curve_list:     180ms  ← TĂNG từ 48ms (stage 1)
  daily_curve_detail:   150ms  ← TĂNG từ 35ms
  daily_curve_cart_add: 220ms  ← TĂNG từ 58ms
  daily_curve_checkout: 2500ms ← TĂNG từ 820ms
```

Kết luận thực tế:

```text
- VU shape đúng: input valid
- iter/s FLAT ở stage 2-3: CAPACITY LIMIT found
  → Backend saturated ở khoảng 15-18 VU, ~35 iter/s
  → Thêm VU không tăng throughput
- Stage 4 iter/s TĂNG khi VU giảm: RECOVERY — backend "thở" lại
  → Mỗi VU loop nhanh hơn khi bớt contention
- Tất cả operation p95 tăng ở peak → không phải 1 service
  → Infrastructure bottleneck (không phải code bug)

=> QUYẾT ĐỊNH: CAPACITY KREE ở 15-18 VU, ~35 iter/s.
   Nếu business cần chịu >18 concurrent shoppers:
   → Cần scale infrastructure (thêm instance, tăng pool size)
   Nếu business chỉ cần <=15 concurrent shoppers:
   → OK với capacity hiện tại
   Đây là tín hiệu ĐÁNG GIÁ NHẤT của ramping-vus.
```

### Kịch bản C — Ramp-down bị interrupted iterations

```text
iterations_interrupted: 12   ← CÓ INTERRUPTED!

VU shape: 2 -> 8 -> 24 -> 12 -> 2

http_req_duration p95 (toàn run): 8500ms  ← RẤT CAO
ramping_flow_duration_ms p95: 9000ms     ← Loop rất dài

gracefulRampDown: 15s
```

Kết luận thực tế:

```text
- iterations_interrupted = 12: có 12 iterations bị cắt giữa chừng
- Nguyên nhân: loop_duration p95 (9s) < gracefulRampDown (15s)?
  → Thực ra loop có thể lên đến 20s ở p99
  → p99 > 15s → một số iteration bị interrupted

- HOẶC: backend quá chậm ở stage 4-5
  → Loop kéo dài > 15s → grace không đủ

=> QUYẾT ĐỊNH: 
   Nếu loop thường < 15s nhưng interrupted > 0:
   → Tăng gracefulRampDown lên 30s
   Nếu loop > 15s (backend quá chậm):
   → Điều tra backend latency TRƯỚC
   → Không tăng grace để "che" vấn đề
   → interrupted iterations LÀ TÍN HIỆU backend chậm
```

### Kịch bản D — Mixed bottleneck: checkout chết ở peak, browse vẫn OK

```text
checks................: 99.5%
http_req_failed.......: 0.8%
ramping_active_iterations_failed: 12
iterations............: 3800

Stage 3 (peak):
  daily_curve_list:     p95=50ms,   0 fail  ← OK
  daily_curve_detail:   p95=40ms,   0 fail  ← OK
  daily_curve_cart_add: p95=65ms,   2 fail  ← OK
  daily_curve_checkout: p95=5000ms, 10 fail ← CHẾT!

  Checkout count stage 3: ~20 iterations (expected ~110)
  → Checkout branch gần như không hoạt động ở peak
```

Kết luận thực tế:

```text
- Browse/Cart: ổn ở mọi stage, kể cả peak 24 VU
- Checkout: CHẾT ở peak — p95=5000ms, fail rate cao
- Checkout count << expected (20 vs 110) → checkout bị block
- Đây là case ĐIỂN HÌNH của "mixed services hide branch bottleneck"
- Aggregate p95 vẫn "đẹp" vì checkout chỉ 8%

=> QUYẾT ĐỊNH: BLOCK. Route về order-service team.
   Browse/Cart OK → products-service và cart-service ổn.
   Checkout fail ở peak → order-service không scale được đến 24 VU.
   KHÔNG kết luận "storefront ổn" chỉ vì browse/cart nhanh.
```

### Bảng ánh xạ nhanh output -> hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| Clean thresholds + VU shape đúng | Daily curve baseline acceptable | Use as daily traffic baseline |
| Product latency rises at peak | Products-service capacity/cache/db pressure | Investigate products path |
| Checkout tail spikes | Order/external dependency bottleneck | Inspect checkout |
| Operation mix wrong | weightedPick/tagging issue | Validate script/tags before trusting run |
| VU shape đúng, iter/s flat ở stage 2-3 | Capacity knee found | Xác định capacity limit, quyết định scale |
| iter/s tăng khi VU giảm (stage 4) | Recovery — backend "thở" lại | Tín hiệu tốt, bottleneck là concurrency-dependent |
| Stage 5 latency >> stage 1 latency | Residual effect sau peak | Điều tra cleanup/recovery sau peak |
| Interrupted iterations > 0 | Loop > gracefulRampDown | Tăng grace hoặc tối ưu loop |
| Failures cluster ở stage transition | Ramp-up stress | Thêm grace period, kiểm tra warm-up |

## Nghịch lý và misconceptions của ramping-vus

### Nghịch lý 1: "VUs tăng nhưng iter/s không tăng?" — ĐÓ LÀ CAPACITY KNEE!

```text
Đây là câu hỏi phổ biến nhất từ learner mới dùng ramping-vus.

"Tôi config stage 2 ramp từ 8 lên 24 VU, sao iter/s không tăng theo?"

Trả lời: Vì backend đã SATURATED. Đây là TÍN HIỆU, không phải bug.

Công thức:
  iter/s = active_VUs / avg_loop_duration

Nếu backend khỏe:
  VU 8 → 24: loop_duration không đổi (0.5s)
  iter/s: 16 → 48 (TĂNG TUYẾN TÍNH)

Nếu backend saturated ở ~16 VU:
  VU 8 → 16: loop_duration = 0.5s, iter/s = 16 → 32 (TĂNG)
  VU 16 → 24: loop_duration TĂNG (0.5s → 0.75s → 1.0s)
              iter/s = 16/0.75 = 21, 24/1.0 = 24 (FLAT!)
  
  → Thêm VU nhưng mỗi VU loop chậm hơn
  → Tổng iter/s không tăng
  → ĐÂY LÀ CAPACITY LIMIT

Đừng hỏi: "Sao iter/s không tăng khi VU tăng?"
Hãy hỏi: "Ở mức VU nào iter/s bắt đầu flatten? → Capacity knee ở đó."
```

### Nghịch lý 2: "iter/s thấp hơn constant-vus?" — ĐÚNG, VÌ SHAPE KHÁC NHAU!

```text
"Tôi chạy constant-vus 24 VU được 60 iter/s.
 Sao ramping-vus cũng 24 VU ở peak mà chỉ được 48 iter/s?"

Trả lời: Vì 2 executor có SHAPE KHÁC NHAU.

constant-vus 24 VU, 113s:
  - 24 VU từ GIÂY ĐẦU TIÊN
  - Tất cả 24 VU loop liên tục 113s
  - Tổng iterations ≈ 24 × 113 / 0.5 = 5424

ramping-vus 2->8->24->12->2, 113s:
  - Stage 1 (15s): avg ~5 VU → ít iterations
  - Stage 2 (30s): avg ~16 VU → ít hơn 24
  - Stage 3 (30s): 24 VU → bằng constant-vus
  - Stage 4 (23s): avg ~18 VU → ít hơn 24
  - Stage 5 (15s): avg ~7 VU → ít iterations
  - Tổng iterations ≈ 4380 (ÍT HƠN constant-vus)

→ Đây là EXPECTED, không phải bug.
→ ramping-vus có nhiều stage VU thấp → tổng iterations thấp hơn
→ Nhưng ramping-vus cho biết capacity curve, không chỉ 1 điểm

So sánh CÔNG BẰNG: chỉ so sánh stage 3 (24 VU plateau) của ramping-vus 
với constant-vus 24 VU. Không so sánh tổng iterations toàn run.
```

### Nghịch lý 3: "Ramp-down có interrupted iterations là bug?" — CÓ THỂ LÀ TÍN HIỆU!

```text
"Tôi thấy iterations_interrupted = 5. Có phải k6 bị lỗi?"

Trả lời: KHÔNG. Đó là gracefulRampDown behavior — và có thể là TÍN HIỆU.

Nếu loop_duration << gracefulRampDown (0.5s << 15s):
  - iterations_interrupted NÊN = 0
  - Nếu > 0: có thể có loop đặc biệt dài (checkout timeout?)
  - → Điều tra operation nào kéo loop dài

Nếu loop_duration ~= gracefulRampDown (10s ~= 15s):
  - Một số iteration CÓ THỂ bị interrupted (p99 > grace)
  - → Đây là EXPECTED behavior
  - → Cân nhắc tăng grace hoặc tối ưu loop

Nếu loop_duration >> gracefulRampDown (30s >> 15s):
  - Nhiều iteration SẼ bị interrupted
  - → Đây là TÍN HIỆU: backend quá chậm
  - → KHÔNG tăng grace để "che" — điều tra backend trước

Quy tắc: 
  iterations_interrupted > 0 + loop_duration p95 < grace → BẤT THƯỜNG
  iterations_interrupted > 0 + loop_duration p95 > grace → BÌNH THƯỜNG
  iterations_interrupted lớn + loop_duration p99 >> grace → BACKEND CHẬM
```

### Bonus misconception: "Stage target là số VU cộng thêm"

```text
Đây là lỗi phổ biến khi đọc config ramping-vus.

SAI:
  Stage 1: target=8  → thêm 8 VU, tổng 2+8=10 VU
  Stage 2: target=24 → thêm 24 VU, tổng 10+24=34 VU

ĐÚNG:
  Stage 1: target=8  → đi TỪ 2 ĐẾN 8 VU
  Stage 2: target=24 → đi TỪ 8 ĐẾN 24 VU
  Stage 3: target=24 → giữ 24 VU (target = previous target)
  Stage 4: target=12 → đi TỪ 24 ĐẾN 12 VU
  Stage 5: target=2  → đi TỪ 12 ĐẾN 2 VU

stage.target là ABSOLUTE VU count ở cuối stage.
```

Đừng nói case này phải có exact iterations count. Nó kiểm active-user curve, không phải fixed total work.

Nhớ 3 câu:

```text
stage target = absolute VU target, không phải delta
iterations/RPS = output, không phải input
VUs tăng mà iter/s flatten = tín hiệu backpressure đáng đọc
```

## Checklist đọc biểu đồ case 01

Khi học sinh nhìn dashboard case 01, đọc theo thứ tự này:

```text
1. Overview KPI
   - checks = 100%?
   - http_req_failed = 0%?
   - ramping_active_iterations_failed < 25?
   - iterations > 0? (sanity: có chạy không)

2. VUs vs iter/s chart (QUAN TRỌNG NHẤT)
   - VUs có theo stage shape 2->8->24->12->2 không?
   - Stage 1 ramp: VU tăng 2→8?
   - Stage 2 ramp: VU tăng 8→24?
   - Stage 3 plateau: VU phẳng ở 24?
   - Stage 4 ramp-down: VU giảm 24→12?
   - Stage 5 ramp-down: VU giảm 12→2?
   - iter/s có tăng tuyến tính theo VU không?
   - Có pattern VU tăng + iter/s flat không? (capacity knee)
   - Có pattern VU phẳng + iter/s falling không? (degradation)
   - Có pattern VU giảm + iter/s tăng không? (recovery)

3. Execution timeline
   - Live VUs có theo stage shape không?
   - HTTP reqs per bucket: tăng/giảm theo stage?
   - Failures có cluster ở stage transition không?
   - Có residual iterations ở stage 4-5 không?

4. Response time chart — LUÔN TÁCH THEO OPERATION + STAGE
   - Stage 1 baseline latency?
   - Stage 2: latency có tăng theo VU không?
   - Stage 3 peak: latency có ổn định không?
   - Stage 4: latency có giảm khi VU giảm không?
   - Stage 5: latency có về bằng stage 1 không? (residual check)
   - Checkout p95 có >> browse p95 không?
   - Operation nào p95 tăng phi tuyến ở stage 2-3?

5. Weighted mix verification
   - Operation counts có gần đúng 70/22/8 không?
   - Checkout count có quá thấp ở stage 3 không?
   - Nếu checkout count << 8%: có fail không?

6. gracefulRampDown check
   - iterations_interrupted > 0?
   - Nếu có: loop_duration p95 có > gracefulRampDown không?
   - Nếu loop_duration p95 < grace mà vẫn interrupted: bất thường

7. Business decision
   - Failures pass? → tiếp tục
   - VU shape đúng? → input valid
   - iter/s tăng/giảm theo VU? → healthy scaling
   - iter/s flat ở peak? → capacity knee, cần quyết định scale
   - Stage 5 latency = Stage 1? → không residual
   - Tất cả pass → Daily traffic curve baseline OK
```

Kết luận của run case 01 đang đúng nếu thấy:

```text
checks gần 100%
http_req_failed gần 0%
ramping_active_iterations_failed < 25
VUs: theo stage shape 2 -> 8 -> 24 -> 12 -> 2
Stage 3: VU phẳng ở 24
iter/s: tăng theo VU ở stage 1-2, ổn định ở stage 3, giảm ở stage 4-5
checkout p95 > browse p95 (bình thường)
checkout count ~8% của iterations (xấp xỉ)
Stage 5 latency ≈ Stage 1 latency
executor = ramping-vus
scenario = daily_traffic_curve
```

## Mở rộng

### Variation A: Tăng peak VUs để tìm capacity knee

```powershell
# Từ peak 24 → 48 VUs
$env:RV_01_PEAK_VUS = 48
$env:RV_01_DURATION_SCALE = 0.25
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js
```

```text
Mục đích: "Peak 48 shoppers thì hệ thống còn ổn không?"

Cách đọc:
  - VU shape có đạt 48 không?
  - iter/s có tiếp tục tăng tuyến tính đến 48 không?
  - Nếu iter/s flat ở ~35 (dù VU 24 hay 48) → capacity knee ở 35 iter/s
  - Latency ở 48 VU có tăng phi tuyến không?
  - So sánh latency stage 3 (24 VU) vs stage 3 (48 VU)
```

### Variation B: Tăng duration scale để chạy gần business timeline hơn

```powershell
# Từ scale 0.25 → 1.0 (full duration)
$env:RV_01_DURATION_SCALE = 1.0
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js
```

```text
Mục đích: "Nếu chạy full duration (60s+120s+120s+90s+60s = 450s),
          hệ thống có degrade không?"

Cách đọc:
  - Stage 3 plateau 120s (thay vì 30s): đủ dài để thấy degradation
  - So sánh latency đầu plateau vs cuối plateau
  - iter/s có giảm dần trong 120s plateau không?
  - Nếu có: sustained load problem
```

### Variation C: Thay đổi weighted mix để mô phỏng traffic pattern khác

```js
// Mix gốc: browse 70%, cart 22%, checkout 8%

// Variation C1: Tăng checkout (sale event, nhiều người mua)
// browse 50%, cart 30%, checkout 20%
const roll = Math.random();
if (roll < 0.50) {
  // browse flow
} else if (roll < 0.80) {
  // cart flow
} else {
  // checkout flow — nhiều hơn, dễ thấy bottleneck
}

// Variation C2: Chỉ browse (user research, xem catalog)
// browse 100% — bỏ cart và checkout
// Dùng để isolate products-service performance trong daily curve
```

### Variation D: Thêm latency threshold cho từng operation

```js
export const options = {
  thresholds: {
    // Browse phải nhanh
    "http_req_duration{operation:daily_curve_list}":   ["p(95)<200"],
    "http_req_duration{operation:daily_curve_detail}": ["p(95)<150"],

    // Cart chấp nhận chậm hơn một chút
    "http_req_duration{operation:daily_curve_cart_add}": ["p(95)<300"],

    // Checkout có external dependency nên threshold cao hơn
    "http_req_duration{operation:daily_curve_checkout}": ["p(95)<1500"],

    // Flow duration toàn loop
    "ramping_flow_duration_ms": ["p(95)<1000"],
  },
};
```

```text
Chuyển từ baseline observation sang performance gate.
```

### Variation E: So sánh 2 run — trước và sau khi scale

```powershell
# Run A: baseline (trước khi scale)
$env:RV_01_PEAK_VUS = 24
k6 run -o cloud ...rv-01-daily-traffic-curve.js
# Lưu kết quả run A

# Run B: sau khi scale (thêm instance, tăng pool)
$env:RV_01_PEAK_VUS = 24
k6 run -o cloud ...rv-01-daily-traffic-curve.js
# So sánh với run A
```

```text
Mục đích: verify việc scale có cải thiện không.

So sánh:
  - Run A vs Run B: cùng config, sau khi scale
  - Stage 3 iter/s: B có cao hơn A không?
  - Stage 2-3 latency: B có thấp hơn A không?
  - Capacity knee có dịch sang phải không? (từ 16 VU → 24 VU?)
```

## Code pattern: weighted branch mix + stage-aware metrics

### Pattern 1: Dùng Math.random() (đơn giản nhất)

```js
import http from "k6/http";
import { sleep, check } from "k6";
import exec from "k6/execution";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";

export default function () {
  const userId = exec.vu.idInTest;  // shopper identity khi active
  const params = {
    tags: {
      user_id: `shopper-${userId}`,
      case_id: "rv-01-daily-traffic-curve",
      business_case: "daily_traffic_curve",
      executor_family: "ramping_vus",
      workload_shape: "staged_concurrency",
    },
  };

  const roll = Math.random();

  if (roll < 0.70) {
    // 70%: browse flow
    browseFlow(params);
  } else if (roll < 0.92) {
    // 22%: cart flow
    cartFlow(params);
  } else {
    // 8%: checkout flow
    checkoutFlow(params);
  }
}

function browseFlow(params) {
  const listRes = http.get(`${BASE_URL}/api/sim/products?limit=10&sort=popular`, {
    ...params,
    tags: { ...params.tags, operation: "daily_curve_list", service: "products-service" },
  });
  check(listRes, { "list 200": (r) => r.status === 200 });

  sleep(0.2);

  const detailRes = http.get(`${BASE_URL}/api/sim/products/${randomProductId()}`, {
    ...params,
    tags: { ...params.tags, operation: "daily_curve_detail", service: "products-service" },
  });
  check(detailRes, { "detail 200": (r) => r.status === 200 });

  sleep(0.2);
}

function cartFlow(params) {
  browseFlow(params);  // reuse browse, rồi thêm cart

  const cartRes = http.post(`${BASE_URL}/api/sim/cart/add`, JSON.stringify({
    product_id: randomProductId(),
    quantity: 1,
  }), {
    ...params,
    tags: { ...params.tags, operation: "daily_curve_cart_add", service: "cart-service" },
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
    tags: { ...params.tags, operation: "daily_curve_checkout", service: "order-service" },
  });
  check(checkoutRes, { "checkout 200": (r) => r.status === 200 });

  sleep(0.2);
}

function randomProductId() {
  return Math.floor(Math.random() * 100) + 1;
}
```

### Pattern 2: Dùng iterationInTest cho weighted round-robin (deterministic)

```js
export default function () {
  const iterationIndex = exec.scenario.iterationInTest;
  const bucket = iterationIndex % 100;  // 0..99, lặp mỗi 100 iter

  if (bucket < 70) {
    browseFlow(params);       // 70%
  } else if (bucket < 92) {
    cartFlow(params);         // 22%
  } else {
    checkoutFlow(params);     // 8%
  }
}
```

```text
Ưu điểm:
  - Deterministic: iteration #0 luôn là browse, #70 luôn là cart, #92 luôn là checkout
  - Dễ reproduce: cùng seed → cùng sequence
  - Dễ verify per stage: biết chính xác iteration nào là branch nào

Nhược điểm:
  - Không random — có thể không giống traffic thật
  - Nếu checkout bị fail, iteration #92-#99 luôn fail → pattern dễ đoán
```

### Pattern 3: Dùng seeded random (repeatable nhưng vẫn random)

```js
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
  } else if (roll < 0.92) {
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
  - Phân phối gần đúng 70/22/8

Nhược điểm:
  - Phức tạp hơn Math.random()
  - Cần verify phân phối thực tế sau run
```

## Anti-pattern

- Đọc `stage.target` như số VUs cộng thêm (phải đọc là absolute target).
- Kỳ vọng fixed RPS từ `ramping-vus`.
- Dùng total `iterations` làm pass/fail target.
- Bỏ qua `gracefulRampDown` khi thấy tail iterations.
- Chỉ nhìn aggregate p95 trong mixed/conditional flow.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với flat active users của `constant-vus`.
- Nhầm iter/s flatten khi VU tăng là "k6 bug" — đó là capacity signal.
- So sánh tổng iterations của ramping-vus với constant-vus (shape khác nhau).
- Không tách operation khi đọc Response time chart.
- Không so sánh latency giữa các stage (bỏ qua staged observation).
- Bỏ qua stage 5 vs stage 1 latency comparison (bỏ qua residual check).
- Tăng gracefulRampDown để "che" interrupted iterations thay vì điều tra backend.
- Dùng `exec.scenario.iterationInTest` làm user identity (trong ramping-vus, đó chỉ là loop counter).
- Kỳ vọng iter/s stage 1 (2 VU) bằng stage 3 (24 VU).
- Fail test vì "checkout p95 cao hơn browse" — checkout luôn chậm hơn vì có external dependency.
- Không kiểm tra VU shape trước khi phân tích latency (input sai → kết luận sai).

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Ramping-vus quick index: `../../20260517_01_ramping-vus-quick-index.md`
- Tham số/công thức: `../../20260517_02_ramping-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-01-daily-traffic-curve.js`
- Constant-vus contrast: `../constant-vus/00_overview.md`
- Shared-iterations contrast: `../shared-iterations/00_overview.md`
