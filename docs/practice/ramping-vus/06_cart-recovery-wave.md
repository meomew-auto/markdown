# Case 06: Cart recovery wave

## Tình huống thực tế

Team marketing vừa gửi push notification "Bạn còn đồ trong giỏ — quay lại nhé!" đến người dùng đã abandon cart. Ngay sau khi notification được gửi, một wave shoppers quay lại app: mở cart summary, add thêm item, và thỉnh thoảng update quantity.

Đây không phải steady baseline như constant-vus cart editing. Đây là notification-driven wave rồi late-stage drain — traffic có hình dạng surge rồi tắt dần.

Case này trả lời: với recovery wave `1 -> 22 -> 8 -> 1`, cart-service có chịu được write/read pressure ở đỉnh wave và recover về trạng thái bình thường không?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 1 -> 22 -> 8 -> 1
Scenario: cart_recovery_wave
Exec function: cartRecoveryWave
Team/service focus: cart/marketing
```

### Phân biệt với constant-vus active cart editing

Case này **không phải** active cart editing của constant-vus. Hai case đều gọi cart-service nhưng khác nhau hoàn toàn về mục tiêu, shape, và cách đọc output:

| Tiêu chí | Cart recovery wave (case này) | Active cart editing (constant-vus) |
| --- | --- | --- |
| Mục tiêu | Quan sát cart-service dưới wave surge từ notification push rồi drain | Quan sát cart-service dưới steady write pressure từ active users |
| Input chính | Timeline VU (1->22->8->1) qua 4 stage | Concurrency (18 VU) + observation window (5m) |
| Output chính | Latency/failure/RPS ở từng phase (ramp-up, peak, ramp-down, drain) | Latency, error rate, natural throughput |
| VU identity | User quay lại sau notification, cart có thể còn item cũ | Active user shopping liên tục, cart state tích lũy |
| Shape | Wave: tăng nhanh, giữ peak, giảm, drain | Phẳng: 18 VU suốt 5m |
| Dừng khi nào? | Hết 4 stage | Hết duration |
| Key insight | Hệ thống có recover sau wave không? | Hệ thống có degradation dài hạn không? |

Hiểu sai sự khác biệt này dẫn đến đọc sai hoàn toàn output của test.

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 1 -> 22 -> 8 -> 1,
latency/failures/iter-s/RPS phản ứng như thế nào?
Hệ thống có recover về bình thường sau khi wave qua không?
```

## Yêu cầu cứng của case này

- Fast wave lên 22 VUs phải hiện rõ trong chart.
- Summary/add mỗi iteration, update roughly every second iteration.
- Late stage phải cho thấy service recover/drain.
- Header recovery campaign giúp phân biệt traffic này.

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

Do đó không được fail test chỉ vì `iterations` không bằng một số target tưởng tượng. Không được kỳ vọng RPS cố định từ `ramping-vus`.

## Vì sao "Cart recovery wave" nên dùng `ramping-vus`?

Cart recovery là wave shape sau notification batch. `ramping-vus` đúng vì active users surge rồi giảm tự nhiên theo thời gian — đúng bản chất của notification push: batch gửi đồng loạt, user mở app dần, rồi rời đi.

Mental model:

```text
Active VUs follow stage timeline.
Each active VU loops the business flow sequentially.
Backend latency changes completed loop rate.
```

### Mental model mở rộng: trace wave 1 -> 22 -> 8 -> 1

```text
t=0s     Stage 1 bắt đầu: 1 VU active
         VU=1: loop #1 — đọc summary cart cũ, add recovery item, update qty nếu cần

t=0-11s  Stage 1: ramp từ 1 lên 22 VUs (notification wave)
         VU=2 joins: loop #1 — user vừa nhận notification, mở app
         VU=3 joins: loop #1 — ...
         ...
         VU=22 joins: loop #1
         → 22 users cùng đọc summary + add item trong ~11s
         → Đây là peak write/read pressure: 22 concurrent cart operations

t=11s    Stage 2 bắt đầu: 22 VUs active, peak recovery phase
         VU=1: loop #3 — cart đã có 2-3 items, tiếp tục add/update
         VU=5: loop #2 — cart đang được build dần
         VU=22: loop #2 — ...
         → 22 active users shopping liên tục trong 30s
         → Cart service chịu sustained write/read pressure

t=41s    Stage 3 bắt đầu: ramp từ 22 xuống 8 VUs (late recovery)
         VU=10 kết thúc loop hiện tại, được ramp-down
         VU=15 kết thúc loop hiện tại, được ramp-down
         ...
         Còn 8 VUs active — đây là "user còn sót lại" sau wave
         → Hệ thống nên bắt đầu recover

t=64s    Stage 4 bắt đầu: ramp từ 8 xuống 1 VU (drain)
         Gần như toàn bộ user đã rời đi
         1 VU cuối cùng đại diện cho user còn mở app
         → Hệ thống nên hoàn toàn recover

t=75s    Kết thúc: tất cả VUs đã dừng
```

Nếu backend nhanh:

```text
loop_duration giảm -> mỗi VU chạy nhiều loops hơn -> iter/s cao ở peak
```

Nếu backend chậm (write contention ở peak):

```text
loop_duration tăng -> mỗi VU chạy ít loops hơn -> iter/s có thể flatten dù VUs = 22
```

Nếu backend recover tốt:

```text
Ở stage 3 (8 VUs), latency giảm về gần baseline 1 VU
→ Chứng tỏ degradation chỉ xảy ra ở peak, không phải persistent
```

### Closed model và wave shape: cơ chế và hệ quả

Trong ramping-vus closed model, khi VUs tăng nhanh (1->22 trong 11s), backend phải chịu concurrency pressure tăng đột ngột:

```text
Backend khỏe:
  stage 1 (1->22 VUs): loop_duration ~0.5s, iter/s tăng dần 2 -> 44
  stage 2 (22 VUs):    iter/s ổn định ~44
  stage 3 (22->8 VUs): iter/s giảm dần 44 -> 16
  stage 4 (8->1 VU):   iter/s giảm dần 16 -> 2

Backend có write contention:
  stage 1 (1->22 VUs): loop_duration tăng 0.5s -> 1.5s, iter/s chỉ đạt ~15 thay vì 44
  stage 2 (22 VUs):    iter/s tiếp tục giảm nếu lock contention tích lũy
  stage 3 (22->8 VUs): iter/s giảm nhưng có thể vẫn thấp hơn expected
  stage 4 (8->1 VU):   iter/s recover nếu contention giảm theo VUs
```

Công thức ước lượng (Little's Law closed model với VUs thay đổi):

```text
iter/s_at_stage ≈ active_VUs_at_stage / avg_loop_duration_at_stage
RPS_at_stage    ≈ iter/s_at_stage × API_per_loop
                ≈ active_VUs_at_stage / avg_loop_duration_at_stage × API_per_loop
```

Đây là **tín hiệu**, không phải lỗi. Nếu backend chậm ở peak VUs, iter/s không tăng tuyến tính — đó chính là điều ramping-vus được thiết kế để phát hiện.

Ngược lại, nếu dùng `ramping-arrival-rate`:

```text
k6 sẽ cố bơm đúng target arrivals/s tăng dần dù backend chậm.
→ Có thể gây drop, queue overflow ở k6, hoặc backlog ảo không phản ánh user thật.
→ Không thấy được closed-model backpressure.
→ Không thấy được "22 users thật sẽ trải nghiệm latency bao nhiêu ở peak".
```

## Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho staged active users? |
| --- | --- | --- |
| `ramping-vus` | Active users thay đổi theo thời gian | **Đúng**: input là timeline VU, output là latency/iter-s/RPS theo từng phase. |
| `constant-vus` | Cũng là closed model active users | Sai nếu traffic phải rise/peak/cooldown; `constant-vus` giữ VUs phẳng. |
| `shared-iterations` | Có nhiều VU cùng chạy | Sai nếu không có fixed backlog cần drain đủ. |
| `per-vu-iterations` | VU identity ổn định | Sai nếu không cần mỗi VU chạy đúng N vòng; stage duration mới là input chính. |
| `constant-arrival-rate` | Giữ rate ổn định | Sai nếu requirement là active users, không phải arrivals/s. |
| `ramping-arrival-rate` | Cũng có time-shaped load | Close cousin nhưng input là arrivals/s, không phải active VU pool. |

### Phân tích sâu: vì sao 3 executor "gần giống" không phù hợp?

**`constant-vus` — phẳng, không có wave**:

```text
Config: vus=22, duration=75s
→ 22 VU active suốt 75s
→ Không có ramp-up, không có drain

Vấn đề:
  - Notification wave không phải "22 users shopping suốt 75s"
  - Mà là "từ 1 user, burst lên 22, rồi giảm về 1"
  - constant-vus không mô phỏng được transition behavior:
    + Làm sao biết backend phản ứng khi VUs tăng đột ngột 1->22?
    + Làm sao biết backend có recover khi VUs giảm 22->8?
  - constant-vus = baseline phẳng, không phải wave test
```

**`shared-iterations` — batch job, không phải user wave**:

```text
Config: vus=22, iterations=500
→ 500 "cart operations" cần xử lý
→ VU nào rảnh thì lấy job tiếp theo
→ Dừng khi hết 500 jobs

Vấn đề:
  - Không có khái niệm "cùng một user" qua nhiều loop
  - Mỗi VU bốc job ngẫu nhiên từ pool → cart state không persist
  - Không có timeline shape: làm sao biết system phản ứng ở peak vs drain?
  - Notification wave là TEMPORAL pattern (theo thời gian),
    không phải BATCH pattern (theo số lượng job)
```

**`ramping-arrival-rate` — open model, không có backpressure**:

```text
Config: stages=[{target:22,duration:"11s"},{target:22,duration:"30s"},...]
→ k6 cố gắng start iterations theo target arrivals/s
→ Nếu backend chậm, k6 vẫn schedule theo rate

Vấn đề:
  - Nếu backend chậm ở peak (loop_duration = 2.0s):
    + ramping-vus: tự động giảm iter/s — PHÁT HIỆN ĐƯỢC vấn đề
    + ramping-arrival-rate: vẫn cố bơm arrivals, queue ở k6
      → Bạn thấy drop, nhưng không biết "nếu là user thật thì throughput bao nhiêu"
  - Che khuất closed-model behavior
  - Che khuất recovery signal: nếu backend recover, arrival-rate vẫn bơm đều
    → Không thấy được "khi wave qua, latency có về bình thường không"
```

Kết luận cho case này:

```text
Need time-shaped active users -> ramping-vus.
Need flat active users -> constant-vus, not this case.
Need fixed total jobs -> shared-iterations, not this case.
Need fixed per-user quota -> per-vu-iterations, not this case.
Need target arrivals/s over time -> ramping-arrival-rate, not this case.
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
RV_06_START_VUS = 1
RV_06_PEAK_VUS = 22
RV_06_LATE_VUS = 8
RV_06_DURATION_SCALE = 0.25
RV_06_SLEEP_SECONDS = 0.6
gracefulRampDown = 15s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_06_START_VUS | 1 | Số user trước khi notification được gửi (quiet baseline) |
| RV_06_PEAK_VUS | 22 | Số user đồng thời ở đỉnh wave (notification burst) |
| RV_06_LATE_VUS | 8 | Số user còn lại sau khi wave qua (late recovery) |
| RV_06_DURATION_SCALE | 0.25 | Hệ số scale stage duration (0.25 = nhanh gấp 4 lần timeline thật) |
| RV_06_SLEEP_SECONDS | 0.6 | Think time user đọc cart, chọn item |
| gracefulRampDown | 15s | Thời gian chờ in-flight loops hoàn tất khi ramp-down |

### Công thức expected (ước lượng, không phải target)

```text
API_per_loop ≈ 2.5 (summary + add + update mỗi loop thứ hai)
             = 1 (summary) + 1 (add) + 0.5 (update ~50% loops)

loop_duration_estimate ≈ summary_latency + add_latency + (0.5 × update_latency) + sleep
                        ≈ 0.01s + 0.01s + (0.5 × 0.01s) + 0.6s
                        ≈ 0.625s (nếu backend nhanh)

Peak iter/s_estimate ≈ peak_VUs / loop_duration_estimate
                     ≈ 22 / 0.625
                     ≈ 35.2 iter/s

Peak RPS_estimate ≈ peak_iter/s × API_per_loop
                  ≈ 35.2 × 2.5
                  ≈ 88 req/s

Late iter/s_estimate ≈ 8 / 0.625 ≈ 12.8 iter/s
Late RPS_estimate    ≈ 12.8 × 2.5 ≈ 32 req/s
```

**Quan trọng**: Đây là ước lượng để có intuition, KHÔNG phải pass criteria. Số thật phụ thuộc backend latency thực tế ở từng stage.

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 45s | 11s | 22 | notification wave — user nhận push, mở app đồng loạt |
| 2 | 120s | 30s | 22 | peak recovery — user đang xem cart, add item, update |
| 3 | 90s | 23s | 8 | late recovery — hầu hết user đã rời, còn ít người |
| 4 | 45s | 11s | 1 | drain — user cuối cùng, hệ thống về trạng thái nghỉ |

Lưu ý:

```text
effective duration = scaleSeconds(raw_seconds, RV_NN_DURATION_SCALE)
scaleSeconds = max(1, round(raw_seconds * scale)) seconds
```

`stage.target` là absolute VU target ở cuối stage.

### Đặc điểm quan trọng của stage shape này

```text
Stage 1 (1->22, 11s): RAMP RẤT NHANH
  - Tốc độ ramp: (22-1)/11 ≈ 1.9 VUs/s
  - Mỗi ~0.5s có thêm 1 VU mới
  - Mô phỏng notification batch gửi đồng loạt, user mở app gần như cùng lúc
  - Đây là stress test cho cart-service cold start + sudden concurrency

Stage 2 (22, 30s): PEAK SUSTAINED
  - 22 active users shopping liên tục trong 30s
  - Viết + đọc cart liên tục → áp lực write/read bền vững
  - Nếu có lock contention, đây là lúc nó thể hiện rõ nhất

Stage 3 (22->8, 23s): RAMP-DOWN CHẬM
  - Tốc độ ramp-down: (22-8)/23 ≈ 0.6 VUs/s
  - Chậm hơn ramp-up → cho phép quan sát recovery dần
  - Nếu latency giảm nhanh khi VUs giảm → contention thực sự đến từ concurrency

Stage 4 (8->1, 11s): DRAIN
  - Về gần idle state
  - Nếu latency vẫn cao dù chỉ còn 1 VU → persistent degradation
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

### Identity model: VU = user returning to cart sau notification

Đây là điểm khác biệt quan trọng giữa ramping-vus wave case này và shared-iterations.

Trong ramping-vus cart recovery, mỗi VU **có thể** (và nên) được dùng như một user identity quay lại cart sau khi nhận notification:

```text
VU=1  = "shopper nhận notification lúc 09:00:00" — mở app, xem cart cũ
VU=2  = "shopper nhận notification lúc 09:00:00" — mở app, xem cart cũ
...
VU=22 = "shopper nhận notification lúc 09:00:00" — mở app, xem cart cũ
```

Mỗi VU khi được activate sẽ bắt đầu với cart state có thể có item cũ (abandoned cart), rồi add item mới, update item cũ:

```text
VU=5 (vừa được activate ở stage 1):
  loop #1: đọc cart summary → cart có {SKU-010: 1, SKU-055: 2} (item cũ từ lần trước)
           add SKU-120, qty=1 → cart có {SKU-010: 1, SKU-055: 2, SKU-120: 1}
           update SKU-010, qty=3 → cart có {SKU-010: 3, SKU-055: 2, SKU-120: 1}
  
  loop #2: đọc cart summary → verify cart state
           add SKU-033, qty=2 → cart có thêm item mới
           (không update loop này — update ~50% loops)

  loop #3: tiếp tục shopping...
```

Khác với constant-vus cart editing:

```text
constant-vus: VU=5 active SUỐT 5m, cart tích lũy rất nhiều items
ramping-vus wave: VU=5 active trong ~75s, cart tích lũy ít items hơn
  → Wave ngắn hơn, cart state ít phức tạp hơn
  → Nhưng CONCURRENCY thay đổi theo thời gian — đó là điểm cần test
```

### Vì sao identity model quan trọng cho case recovery wave?

Nếu không giữ cart state qua các loop, test không phát hiện được các bug liên quan đến recovery context:

```text
Bug #1 — Cart merge issue:
  - User có cart cũ {SKU-010: 1} từ trước khi abandon
  - Sau notification, user add thêm SKU-120
  - Backend phải merge cart cũ + item mới đúng
  → Chỉ phát hiện nếu VU bắt đầu với cart state có sẵn

Bug #2 — Wave peak write contention:
  - 22 users cùng add/update cart → DB lock queue
  - Latency tăng ở peak, nhưng phải GIẢM khi VUs giảm
  → Nếu latency không giảm ở stage 3/4 → persistent issue, không phải wave issue

Bug #3 — Read-model stale after recovery:
  - Ở peak, summary có thể trả về data cũ do read-model chưa sync
  - Khi wave qua (stage 3/4), read-model phải sync kịp
  → Nếu vẫn stale ở late stage → read-model sync bị broken, không phải do load
```

### So sánh identity model giữa 3 case cart

| Tiêu chí | Cart recovery wave (case này) | Active cart editing (constant-vus) | Cart cleanup (shared-iterations) |
| --- | --- | --- | --- |
| VU là gì? | User quay lại sau notification | Active user shopping liên tục | Generic worker |
| Cart state persist? | CÓ, qua loop của cùng VU | CÓ, qua nhiều loop tích lũy | KHÔNG |
| Cart state ban đầu? | Có thể có item cũ (abandoned cart) | Rỗng, build từ từ | Rỗng mỗi job |
| Thời gian active của VU? | ~75s (theo stage) | 5m (theo duration) | Đến khi hết backlog |
| Concurrency thay đổi? | CÓ (1->22->8->1) | KHÔNG (phẳng 18) | KHÔNG (phẳng max VUs) |
| Phù hợp mô phỏng... | Notification push campaign | User shopping dài hạn | Worker xử lý batch |

## Technical root causes this case catches

### Phân tích sâu: mỗi root cause và cách nó biểu hiện

Case cart recovery wave được thiết kế để bắt 4 lớp vấn đề kỹ thuật. Mỗi lớp cần được hiểu riêng vì chúng biểu hiện khác nhau trên dashboard và cần cách điều tra khác nhau.

---

### Nguyên nhân kỹ thuật 1: Notification batch creates a fast wave

**Định nghĩa**: Active users jump nhanh từ 1 lên 22 trong thời gian ngắn, mô phỏng push notification được gửi đồng loạt đến hàng ngàn users. Backend phải chịu cold start + sudden concurrency spike cùng lúc.

**Demo cụ thể**:

```text
Stage 1: ramp 1 -> 22 VUs trong 11s

Timeline chi tiết:
t=0.0s   VU=1: loop #1 bắt đầu (user duy nhất, backend nhàn)
t=0.5s   VU=2 joins: loop #1 bắt đầu
t=1.0s   VU=3 joins: loop #1 bắt đầu
t=1.5s   VU=4 joins: loop #1 bắt đầu
...
t=5.5s   VU=12 joins: loop #1 bắt đầu
         → 12 users đang concurrent, backend bắt đầu cảm nhận pressure
t=11.0s  VU=22 joins: loop #1 bắt đầu
         → 22 users concurrent — peak concurrency đạt được trong 11s!

So sánh với constant-vus:
  constant-vus: 22 VUs start CÙNG LÚC ở t=0 — không có giai đoạn "tăng dần"
  ramping-vus wave: VUs tăng DẦN trong 11s — backend thấy pressure tăng dần
  → Nếu backend fail ở VU=15 (không lên nổi 22), constant-vus không phát hiện được
    vì constant-vus start thẳng 22, có thể VU init chậm che khuất issue
  → Ngược lại, ramping-vus cho thấy CHÍNH XÁC VU thứ mấy bắt đầu gây issue
```

**Vì sao đây là root cause cần bắt?**:

```text
Nếu developer chỉ test với constant-vus (22 VU phẳng),
họ có thể nghĩ: "22 VU OK, cart-service chịu được 22 concurrent users"

Nhưng thực tế notification wave:
  - 22 users ĐỘT NGỘT xuất hiện trong 11s (không phải từ từ)
  - Backend chưa kịp warm up (connection pool, cache, DB query plan)
  - Cold start + sudden concurrency = double stress
  - Connection pool có thể cạn vì 22 connections mở gần như đồng thời

→ Fast ramp phát hiện issue mà slow ramp hoặc flat VUs bỏ sót.
```

**Cách phát hiện trên dashboard**:

```text
- Chart VUs vs iter/s: VUs tăng nhanh trong stage 1, iter/s có theo kịp không?
- Nếu iter/s tăng chậm hơn VUs → loop_duration đang tăng → backend đang struggle
- Chart Response time: latency ở stage 1 có cao hơn stage 2 không?
  + Nếu latency stage 1 > stage 2: cold start issue (cache miss, connection init)
  + Nếu latency stage 1 < stage 2: cold start OK, issue là sustained load
- Chart Execution timeline: có failed iterations cluster ở stage 1 không?
  + Nếu có: backend không chịu được sudden concurrency spike
```

**Hệ quả cho pass criteria**:

```text
Không có threshold cứng cho "iter/s phải tuyến tính với VUs".
Nhưng nếu iter/s ở stage 2 (22 VUs) không cao hơn đáng kể so với stage 4 (1 VU),
→ backend đang bị saturation nặng.
```

---

### Nguyên nhân kỹ thuật 2: Summary read combines with write pressure

**Định nghĩa**: Mỗi loop đọc summary (read) và write add (write). Ở peak wave, 22 users cùng đọc + ghi cart → read/write contention có thể xuất hiện. Read path có thể bị ảnh hưởng bởi write path.

**Demo cụ thể — read/write contention ở peak**:

```text
Backend state: cart-service dùng chung DB cho read và write
  22 VUs đang active ở stage 2:
    - ~22 POST /cart/add mỗi giây (write)
    - ~22 GET /cart/summary mỗi giây (read)
    - ~11 PATCH /cart/items/:id mỗi giây (write, ~50% loops)

Tổng: ~55 req/s vào cart-service, trong đó ~33 write + ~22 read

Nếu DB dùng row-level locking:
  - Write (add/update) acquire exclusive lock trên cart row
  - Read (summary) cần shared lock để đọc consistent data
  - 22 concurrent writes → lock queue dài → read cũng phải chờ

Nếu DB dùng MVCC (PostgreSQL):
  - Write tạo row mới, read đọc snapshot cũ
  - Read ít bị block hơn, nhưng data có thể STALE
  - Summary có thể trả về data trước khi add/update gần nhất được commit
```

**Demo trace — read-model stale trong wave**:

```text
VU=5, stage 2, loop #3:
  Cart state trước loop: {SKU-010: 3, SKU-055: 2, SKU-120: 1}
  
  Step 1: đọc summary → GET 200 → {SKU-010: 3, SKU-055: 2, SKU-120: 1} ✓
  
  Step 2: add SKU-033, qty=2 → POST 200 (write model ghi xong)
  
  Step 3: update SKU-010, qty=5 → PATCH 200 (write model update xong)
  
  (Loop này có update vì là loop lẻ)

VU=5, stage 2, loop #4:
  Cart state trước loop: {SKU-010: 5, SKU-055: 2, SKU-120: 1, SKU-033: 2}
  
  Step 1: đọc summary → GET 200 → {SKU-010: 3, SKU-055: 2, SKU-120: 1}
           ← THIẾU SKU-033! SKU-010 qty cũ (3 thay vì 5)!
  
  → HTTP 200, nhưng data STALE
  → Read-model chưa sync kịp sau write ở loop #3
  → Ở peak wave với 22 concurrent users, read-model sync delay có thể tăng
```

**Cách phát hiện trên dashboard**:

```text
- Tách latency theo operation: summary latency vs add latency vs update latency
- Ở stage 2 (peak): 
  + Nếu summary p95 ≈ add p95: read không bị block bởi write
  + Nếu summary p95 >> add p95: read đang bị block/chậm hơn write
  + Nếu summary p95 thấp nhưng data sai: read-model inconsistency
- Ở stage 3/4 (recovery): summary data phải sync kịp
  + Nếu vẫn stale ở late stage → read-model sync bị broken, không chỉ do load
```

**So sánh với constant-vus**:

```text
constant-vus (18 VU phẳng):
  - Read/write contention ở mức ổn định suốt 5m
  - Nếu read-model stale, nó stale ĐỀU → dễ bị coi là "bình thường"
  
ramping-vus wave:
  - Read/write contention THAY ĐỔI theo stage
  - Có thể thấy read-model sync kịp ở stage 1 (1 VU)
    nhưng không kịp ở stage 2 (22 VUs)
    rồi lại kịp ở stage 4 (1 VU)
  → Đây là insight: read-model sync delay phụ thuộc vào concurrency level
```

---

### Nguyên nhân kỹ thuật 3: Update count roughly half iterations

**Định nghĩa**: Update chỉ xảy ra ~50% loops (mỗi loop thứ hai). Đây không phải bug — đây là thiết kế mô phỏng user behavior thật: không phải loop nào user cũng update item, có loop chỉ add rồi đọc summary.

**Demo cụ thể — weighted branch trong loop**:

```text
Loop của 1 VU:
  Luôn luôn: đọc summary + add item = 2 API calls
  Có điều kiện: update item (50% loops) = +1 API call

Expected ratio:
  summary : add : update = 1 : 1 : 0.5
  → Với N loops: summary = N, add = N, update ≈ N/2

Với run hoàn tất 1958 iterations:
  summary: 1958
  add:     1958
  update:  ~979 (= 1958/2)
  
  Tổng API calls: 1958 + 1958 + 979 = 4895
  API per loop: 4895 / 1958 = 2.5
```

**Vì sao đây là root cause cần bắt?**:

```text
1. Không kỳ vọng update = add:
   Nếu developer thấy "update count thấp hơn add count" và nghĩ là bug,
   họ sẽ debug sai hướng. Đây là EXPECTED behavior.

2. Tỉ lệ update/add phản ánh user behavior:
   - Update ~50%: user thỉnh thoảng sửa quantity
   - Update 100%: user luôn sửa sau khi add — không thực tế
   - Update 0%: user chỉ add, không sửa — cũng không thực tế

3. Update có latency profile khác add:
   - Add = INSERT (thường nhanh)
   - Update = SELECT + UPDATE (có thể chậm hơn, dễ lock contention)
   - Nếu không tách add và update latency, update chậm có thể bị
     "pha loãng" bởi add nhanh trong aggregate p95

4. Tỉ lệ API/loop = 2.5 (không phải 3.0 như constant-vus cart editing):
   - Case này: summary(1) + add(1) + update(0.5) = 2.5
   - Case constant-vus: add(1) + update(1) + summary(1) = 3.0
   → Sanity check ratio phải là 2.5, không phải 3.0!
```

**Cách phát hiện trên dashboard**:

```text
- So sánh http_reqs với iterations: tỉ lệ nên ≈ 2.5
- Nếu tỉ lệ < 2.0: có loop không đi đủ flow (thiếu add hoặc summary)
- Nếu tỉ lệ > 3.0: có retry/re-request không mong muốn
- Request breakdown: update count nên ≈ iterations / 2
- Nếu update count << iterations/2: branch logic sai
- Nếu update count ≈ iterations: branch luôn chạy update → script bug
```

---

### Nguyên nhân kỹ thuật 4: Late stage distinguishes normal drain vs persistent degradation

**Định nghĩa**: Sau khi wave qua, VUs giảm từ 22 xuống 8 rồi 1. Nếu latency vẫn cao ở late stage dù VUs đã giảm, đó là persistent degradation — không phải do wave pressure.

**Đây là đặc trưng quan trọng nhất của case wave — phân biệt transient vs persistent issue.**

**Demo: 2 kịch bản late stage**

Kịch bản A — Recovery tốt (transient issue):

```text
Stage 2 (22 VUs, peak):
  summary p95: 15ms  (cao hơn bình thường do read/write contention)
  add p95:     18ms  (cao hơn bình thường)
  update p95:  45ms  (lock contention ở peak)
  iter/s:      ~25   (thấp hơn expected 35)

Stage 3 (ramp 22->8 VUs):
  summary p95: 8ms   (giảm dần về baseline)
  add p95:     8ms   (giảm dần)
  update p95:  15ms  (giảm rõ rệt, lock contention giảm)
  iter/s:      ~18   (giảm theo VUs)

Stage 4 (ramp 8->1 VU, drain):
  summary p95: 3ms   (về baseline)
  add p95:     3ms   (về baseline)
  update p95:  5ms   (về baseline)
  iter/s:      ~2    (1 VU)

→ Kết luận: Contention CHỈ xảy ra ở peak wave.
  Hệ thống recover tốt khi load giảm.
  → Đây là transient issue — OK cho notification campaign
    miễn là peak latency vẫn trong ngưỡng chấp nhận được.
```

Kịch bản B — Persistent degradation (có vấn đề):

```text
Stage 2 (22 VUs, peak):
  summary p95: 25ms
  add p95:     30ms
  update p95:  120ms  (lock contention nặng)
  iter/s:      ~10   (rất thấp)

Stage 3 (ramp 22->8 VUs):
  summary p95: 20ms   (GIẢM RẤT ÍT! vẫn cao)
  add p95:     25ms   (GIẢM RẤT ÍT!)
  update p95:  100ms  (GIẢM RẤT ÍT! lock vẫn contention?)
  iter/s:      ~8    (chỉ giảm nhẹ dù VUs giảm 3x)

Stage 4 (ramp 8->1 VU):
  summary p95: 18ms   (VẪN CAO dù chỉ 1 VU!)
  add p95:     20ms   (VẪN CAO!)
  update p95:  80ms   (VẪN CAO! 1 VU mà 80ms update?)
  iter/s:      ~1    (1 VU)

→ Kết luận: KHÔNG recover!
  Dù VUs giảm về 1, latency vẫn cao gần như lúc peak.
  → Persistent degradation: có thể DB lock không release,
    connection pool cạn không hồi, hoặc cart data bị corrupted.
  → Đây là bug CRITICAL: wave qua rồi mà hệ thống không về bình thường.
```

**Cách phát hiện trên dashboard**:

```text
- So sánh latency ở stage 2 (peak) vs stage 4 (drain):
  + Nếu latency_stage4 ≈ latency_stage1 (baseline): recovery tốt ✓
  + Nếu latency_stage4 >> latency_stage1: persistent degradation ✗
  
- Chart Response time: nhìn latency trend qua 4 stage
  + Shape đẹp: latency tăng ở stage 1-2, giảm ở stage 3-4
  + Shape xấu: latency tăng rồi GIỮ NGUYÊN (không giảm)

- Chart VUs vs iter/s:
  + iter/s giảm theo VUs ở stage 3-4 là BÌNH THƯỜNG
  + Nhưng nếu iter/s giảm MẠNH HƠN tỉ lệ VUs → loop_duration tăng
    (Ví dụ: VUs giảm 3x nhưng iter/s giảm 10x → loop chậm hơn hẳn)
```

**So sánh với constant-vus**:

```text
constant-vus:
  - VUs phẳng → không có "late stage" để so sánh
  - Không phân biệt được transient vs persistent
  → Đây là lý do ramping-vus wave QUAN TRỌNG cho notification test:
    nó cho phép quan sát RECOVERY.
```

---

### Bảng tổng hợp 4 root causes và dấu hiệu

| Root cause | Triệu chứng trên dashboard | Cách xác nhận |
| --- | --- | --- |
| Fast wave exposes write contention | Stage 1: VUs tăng nhanh, iter/s không theo kịp; latency spike ở cold start | So sánh iter/s slope với VU slope ở stage 1 |
| Summary read behind writes | Stage 2: summary latency cao hoặc data sai dù HTTP 200 | Tách operation latency; check response body content |
| Update count ratio matters | update count ≈ iterations/2; API/loop ≈ 2.5 | So sánh operation breakdown count; verify ratio |
| Late stage recovery verification | Stage 3/4: latency có giảm về baseline không? | So sánh latency stage 4 vs stage 1; nếu không giảm → persistent |

## Service/API flow

Flow pattern:

```text
Cart summary every iteration; cart add every iteration; cart update every second iteration; header `X-Recovery-Campaign: abandoned-cart`.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| cart_recovery_summary | cart-service | GET | /api/sim/cart/summary | 200 | Read cart summary — user xem giỏ trước khi thêm. |
| cart_recovery_add | cart-service | POST | /api/sim/cart/add | 200 | Add recovery item — user thêm món được gợi ý. |
| cart_recovery_update | cart-service | PATCH | /api/sim/cart/items/:item_id | 200 | Conditional update — user sửa quantity, ~50% loops. |

### Operation mix và weighted latency

Trong case này, 3 operation có đặc tính latency khác nhau:

```text
cart_recovery_summary (GET):
  - Read operation: aggregate cart items + compute totals
  - Được gọi ĐẦU TIÊN mỗi loop — user mở app, xem cart
  - Nếu dùng materialized view: latency ổn định nhưng data có thể stale
  - Đây là operation dễ bị read-model inconsistency nhất trong wave

cart_recovery_add (POST):
  - Write operation: insert row vào cart_items table
  - Được gọi MỖI loop — user luôn add ít nhất 1 item
  - Thường nhanh (insert đơn giản) nhưng có thể chậm nếu cart đã nhiều items
  - Ở peak wave (22 VUs), 22 inserts/s → index update pressure

cart_recovery_update (PATCH):
  - Write operation: update row trong cart_items table
  - Được gọi ~50% loops
  - Dễ bị ảnh hưởng nhất bởi DB locking (update cần lock row)
  - Ở peak wave, dù chỉ ~11 updates/s nhưng vẫn có thể gây lock contention
```

Đừng gộp latency 3 operation làm một. Mỗi operation có bottleneck riêng. Đặc biệt, update có thể chậm hơn add nhiều lần ở peak wave.

### Header campaign để phân biệt traffic

```text
X-Recovery-Campaign: abandoned-cart
```

Header này cho phép:
- Backend phân biệt traffic notification recovery với traffic shopping thông thường
- Dashboard filter theo campaign type
- Nếu cần test A/B campaign (các loại notification khác nhau), chỉ cần đổi header

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

### Cách đọc từng counter và mối quan hệ giữa chúng

```text
ramping_active_iterations:
  - Đếm số user loop hoàn tất end-to-end
  - KHÔNG phải target → không có "expected count"
  - Dùng để: tính iter/s ở từng stage, so sánh giữa các run

ramping_active_iterations_failed:
  - Đếm số loop có ít nhất 1 API fail
  - Pass nếu < 25
  - Nếu cao: lọc theo operation để tìm API nào fail
  - Ở wave, failures có thể cluster ở stage 1-2 (peak)

ramping_api_calls_total:
  - Tổng API calls thực tế
  - So với ramping_active_iterations × 2.5 để kiểm flow completeness
  - Nếu thấp hơn 2.3: có loop incomplete (thiếu add hoặc summary)
  - Nếu cao hơn 2.7: có retry/re-request

ramping_flow_duration_ms:
  - Thời gian end-to-end của 1 user loop
  - BAO GỒM: summary time + add time + (có thể) update time + sleep + JS overhead
  - So sánh với iteration_duration để hiểu sleep chiếm bao nhiêu
  - Ở từng stage: flow_duration nên phản ánh concurrency level

ramping_sleep_seconds:
  - Tổng sleep tích lũy
  - ramping_sleep_seconds / ramping_active_iterations ≈ 0.6s (RV_06_SLEEP_SECONDS)
```

Tags chung:

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `rv-06-cart-recovery-wave`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service được gọi. |
| `operation` | Operation cụ thể trong user loop. |
| `endpoint` | Nhóm endpoint/API family. |
| `user_id` | Active user identity derive từ VU/user context. |
| `executor_family` | `ramping_vus`. |
| `workload_shape` | `staged_concurrency`. |

Tags case này:

```text
case_id       = rv-06-cart-recovery-wave
business_case = cart_recovery_wave
workload      = staged_concurrency
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

Chúng là observed outputs.

### Sanity check bổ sung

```text
1. Tỉ lệ API/loop:
   ramping_api_calls_total / ramping_active_iterations ≈ 2.5
   (Mỗi loop: summary + add + update*0.5)
   Nếu 2.3-2.7: OK
   Nếu < 2.3: có loop thiếu operation → kiểm script flow
   Nếu > 2.7: có retry không mong muốn

2. Sleep đúng config:
   ramping_sleep_seconds / ramping_active_iterations ≈ RV_06_SLEEP_SECONDS
   Nếu lệch nhiều: sleep không được gọi đúng cách

3. VU stage shape:
   Dashboard chart VUs vs iter/s: VUs phải đi theo 1 -> 22 -> 8 -> 1
   vus_max nên gần 22 (peak target)
   Nếu VUs không theo shape: config/env/dashboard issue

4. Operation mix:
   cart_recovery_summary count ≈ cart_recovery_add count ≈ ramping_active_iterations
   cart_recovery_update count ≈ ramping_active_iterations / 2
   Nếu lệch: branch/tag/script issue

5. Recovery signal:
   Ở stage 3-4, ramping_flow_duration_ms p95 có giảm so với stage 2 không?
   Nếu không giảm: persistent degradation → investigate

6. Flow duration breakdown:
   ramping_flow_duration_ms p95 > (sleep + summary_p95 + add_p95 + 0.5*update_p95)
   Nếu flow_duration bất thường so với tổng API latencies: JS overhead hoặc
   orchestration delay
```

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js
```

### Override config để tùy chỉnh wave

```powershell
# Wave nhanh hơn (duration scale nhỏ hơn)
$env:RV_06_DURATION_SCALE = "0.1"

# Peak cao hơn
$env:RV_06_PEAK_VUS = "40"

# Think time ngắn hơn (user nhanh tay)
$env:RV_06_SLEEP_SECONDS = "0.3"

# Chạy với config tùy chỉnh
k6 run -o cloud .\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = cart_recovery_wave
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 1 -> 22 -> 8 -> 1
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

### Bước 5 — Interpret duration/throughput

Đọc:

```text
ramping_flow_duration_ms
http_req_duration by operation
iteration_duration
```

Case-specific notes:

- Summary/add counts should be higher than update count.
- Late-stage latency recovery is as important as peak behavior.
- Failed loops at peak likely indicate cart write/read capacity issue.
- Tỉ lệ API/loop nên ≈ 2.5 (không phải 3.0 như constant-vus cart editing).
- `ramping_sleep_seconds / ramping_active_iterations ≈ 0.6`.

<!-- REAL_RUN_START -->
## Contract rerun 2026-06-20 — run #56

Run này ép đúng contract/tải đã ghi trong tài liệu, kể cả khi backend script default hiện tại đã đổi nhẹ hơn.

```text
BASE_URL=http://localhost:80
K6_CLOUD_HOST=http://localhost:18080
RV_06_START_VUS=1
RV_06_PEAK_VUS=22
RV_06_LATE_VUS=8
RV_06_DURATION_SCALE=0.25
RV_06_SLEEP_SECONDS=0.6
```

| Item | Value |
| --- | --- |
| Script | `rv-06-cart-recovery-wave.js` |
| Run ID | `56` |
| Exit code | `0` |
| Verdict | **PASS** — Đạt theo contract gốc |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `1 -> 22 -> 8 -> 1` |
| Observed `vus` min/max | 2 / 22 |

### Summary thật của contract rerun

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 100.00% (4895/4895) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/4895) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 0 | User-loop failures của case. |
| `iterations` | 1958 (26.04/s) | Output, không phải target. |
| `http_reqs` | 4895 (65.09/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 1958 | Completed user loops. |
| `ramping_api_calls_total` | 4895 | Custom API counter. |
| `ramping_sleep_seconds` | 1174.8s | Think time do script thêm. |
| `http_req_duration` | avg 4.78ms, p95 5.78ms, p99 59.5ms, max 178ms | Request-level latency. |
| `ramping_flow_duration_ms` | avg 12.2ms, p95 17.1ms, p99 98.0ms, max 278ms | Full user-loop latency. |
| `iteration_duration` | avg 613ms, p95 618ms, p99 699ms, max 878ms | Bao gồm flow + think/sleep. |

Threshold failures:

Không có threshold failure.

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `cart_recovery_summary` | GET | 200 | 1958 | 40.00% |
| `cart_recovery_add` | POST | 200 | 1958 | 40.00% |
| `cart_recovery_update` | PATCH | 200 | 979 | 20.00% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

Cart latency thấp, không có failed request.

| Aggregate | Value |
| --- | ---: |
| Response-time points | 3234 |
| Avg của các window avg | 4.76ms |
| Max window p95 | 178ms |
| Max window p99 | 178ms |
| Max request window | 178ms |
| Windows p95 > 100ms | 1 |
| Windows p95 > 500ms | 0 |

#### 2. Execution timeline chart

Không có failed iterations. Summary/add mỗi loop, update khoảng một nửa loops đúng thiết kế.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 1958 |
| Sum `http_reqs` buckets | 4895 |
| Peak iter/s bucket | 41 |
| Peak http_req/s bucket | 95 |
| Failed-iteration points | 0 |
| Sum failed iterations | 0 |
| Peak failed-iteration bucket | 0 |

#### 3. VUs vs iter/s chart

VU shape đạt peak 22 đúng contract. Recovery wave ổn.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 75 |
| VUs min/max series | 2 / 22 |
| Avg VUs series | 16.00 |
| Peak iter/s bucket | 41 |

### Phân tích sâu contract rerun #56

Từ số liệu run #56, ta có thể rút ra các insight sau:

```text
1. API/loop ratio:
   4895 / 1958 = 2.500... ≈ 2.5 ✓
   → Flow đi đúng: summary + add + update*0.5
   → Không thiếu operation, không có retry thừa

2. Operation mix:
   summary: 1958 (40%) ✓
   add:     1958 (40%) ✓
   update:  979  (20%) ✓
   → 1958 / 2 = 979 → update đúng ~50% loops ✓

3. Sleep consistency:
   1174.8s / 1958 = 0.600s ≈ RV_06_SLEEP_SECONDS (0.6s) ✓
   → Sleep được áp dụng đúng mỗi loop

4. Flow duration vs iteration duration:
   flow_duration avg 12.2ms (thuần API)
   iteration_duration avg 613ms (API + sleep + overhead)
   → 613 - 12.2 - 600 = ~0.8ms JS overhead → rất nhẹ ✓

5. Latency profile:
   p95 = 5.78ms → cart-service rất nhanh ở 22 VUs
   → Không có dấu hiệu write contention ở peak
   → Hệ thống khỏe, wave không gây issue

6. VU shape:
   min 2, max 22 → đạt peak target
   avg 16.00 → phản ánh shape 1->22->8->1 (trung bình weighted)
```

### Kết luận contract rerun #56

OK theo contract gốc. Cart-service xử lý tốt recovery wave 1->22->8->1 với backend local. Không có failure, latency thấp, operation mix đúng thiết kế.
<!-- REAL_RUN_END -->

## Đọc dashboard real-time charts cho case 06

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
cart_recovery_summary: GET /api/sim/cart/summary
cart_recovery_add: POST /api/sim/cart/add
cart_recovery_update: PATCH /api/sim/cart/items/:item_id
```

Cách đọc:

```text
ramp-up phase: latency có tăng khi VUs tăng không?
peak/plateau: p95/p99 có ổn định không?
ramp-down/recovery: latency có giảm lại không?
```

Case-specific hints:

- Response time: summary vs add vs update.
- Execution timeline: fast jump to 22 then late fall to 8.
- VUs vs iter/s: if iter/s stays low at late 8 VUs, investigate persistent cart degradation.

#### Phân tích sâu: Write vs Read latency trong wave

Đây là phân tích quan trọng nhất cho case recovery wave. Ba operation có latency profile khác nhau và mỗi cái kể một câu chuyện riêng trong từng stage:

```text
So sánh 3 operation latency theo stage:

cart_recovery_summary (GET) — read:
  - Stage 1 (1->22): latency có thể tăng dần khi thêm VU đọc concurrent
  - Stage 2 (22): latency ổn định nếu read path khỏe
  - Stage 3-4 (22->1): latency phải GIẢM về baseline
  - Nếu vẫn cao ở stage 4: read-model broken, không phải load issue

cart_recovery_add (POST) — write:
  - Stage 1: latency tăng dần theo VUs
  - Stage 2: latency ổn định nếu insert path khỏe
  - Nếu add_p95 tăng dần trong stage 2: DB insert degradation (index, table size)

cart_recovery_update (PATCH) — write:
  - Dễ bị ảnh hưởng nhất bởi lock contention
  - Stage 2: nếu update_p95 >> add_p95 → lock contention
  - Stage 3-4: nếu update_p95 không giảm → persistent lock issue
```

**Shape đẹp cho case recovery wave**:

```text
cart_recovery_summary: p95 < 10ms  (read nhanh)
cart_recovery_add:     p95 < 10ms  (insert nhanh)
cart_recovery_update:  p95 < 15ms  (update nhanh, ít conflict)

ramping_flow_duration_ms p95 ≈ 0.6s (sleep) + 0.01s + 0.01s + 0.005s ≈ 0.625s
iteration_duration p95: tương tự flow + sleep

Ở stage 3-4: latency GIẢM về gần stage 1 baseline → recovery tốt
```

**Shape xấu cần chú ý trong wave**:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| add p95 ổn, update p95 tăng vọt ở stage 2 | Lock contention ở peak wave | Kiểm DB locking strategy |
| summary p95 cao ở stage 2, giảm ở stage 3 | Read bị block bởi write ở peak | Kiểm transaction isolation level |
| summary p95 thấp nhưng data sai ở stage 2 | Read-model stale do write pressure | Kiểm read-model sync delay |
| Cả 3 operation p95 đều tăng ở stage 1 | Cold start + sudden concurrency | Kiểm connection pool warm-up |
| Stage 3-4 latency không giảm | Persistent degradation | BLOCK — điều tra lock/connection leak |
| update p95 spike định kỳ ở stage 2 | Lock escalation hoặc deadlock retry | Kiểm DB deadlock log |

#### Cách phân tích sâu chart Response time cho wave

Khi nhìn chart này, đừng chỉ nhìn "cao/thấp". Hãy đọc theo 5 câu hỏi:

```text
1. Operation nào chậm nhất ở peak wave (stage 2)?
2. Latency có tăng đột ngột ở stage 1 (ramp-up) không?
3. Latency có GIẢM khi VUs giảm ở stage 3-4 không?
4. Update latency có >> add latency ở peak không?
5. Summary data có đúng không (cần check response body, không chỉ HTTP status)?
```

Với case 06, shape đẹp thường có:

```text
stage 1: latency tăng dần từ baseline (1 VU) lên peak (22 VUs)
stage 2: latency ổn định ở mức peak, không tăng thêm
stage 3: latency giảm dần theo VUs
stage 4: latency về baseline (gần bằng stage 1 lúc đầu)
```

### Chart 2 — Execution timeline

Với ramping-vus:

```text
VUs should follow 1 -> 22 -> 8 -> 1.
iterations/http_reqs per bucket are outputs.
failures may cluster at ramp transitions or peak.
```

Không kỳ vọng exact per-bucket counts, đặc biệt với weighted/conditional flows.

#### Phân tích sâu chart Execution timeline cho wave

Chart này trả lời câu hỏi khác hẳn Response time:

```text
Response time chart:
  "request nhanh/chậm thế nào ở từng phase?"

Execution timeline:
  "tại mỗi giây, test đã xử lý bao nhiêu loop? bao nhiêu VU còn chạy?
   shape có khớp 1->22->8->1 không?"
```

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs — có đi theo shape 1->22->8->1 không?
2. HTTP reqs mỗi bucket — có tăng/giảm theo VUs không?
3. Iterations hoàn thành mỗi bucket — có theo kịp VU shape không?
```

Với `ramping-vus` recovery wave, shape "đẹp" thường là:

```text
stage 1 (1->22):
  Live VUs tăng từ 1 lên 22
  httpReqs tăng theo (từ ~2/s lên ~55/s)
  iterations bắt đầu thấp, tăng dần

stage 2 (22):
  Live VUs giữ ổn định 22
  httpReqs ổn định ~55/s (22 × 2.5)
  iterations ổn định

stage 3 (22->8):
  Live VUs giảm từ 22 xuống 8
  httpReqs giảm theo
  iterations giảm theo

stage 4 (8->1):
  Live VUs giảm về 1
  httpReqs thấp (~2.5/s)
  iterations thấp
```

Invalid patterns cho wave:

| Pattern | Nghĩa |
| --- | --- |
| Live VUs không đạt 22 ở stage 2 | Config/env sai, hoặc VU init chậm |
| Live VUs đạt 22 nhưng iterations = 0 lâu | VU bị kẹt trong request đầu, backend không phản hồi |
| httpReqs không ≈ 2.5× iterations | Flow incomplete hoặc branch sai |
| Failures cluster ở stage 1-2 | Backend không chịu được sudden concurrency |
| Failures xuất hiện ở stage 3-4 | Vấn đề khi ramp-down (gracefulRampDown issue?) |
| Live VUs không giảm về 1 ở cuối | gracefulRampDown quá dài hoặc VU bị treo |

#### Đọc shape qua 4 stage

```text
Stage 1 (ramp-up): VUs và httpReqs tăng NHANH
  → Nếu httpReqs tăng chậm hơn VUs → loop_duration tăng → backend struggle

Stage 2 (peak): VUs và httpReqs ổn định
  → Nếu httpReqs giảm dần dù VUs = 22 → degradation tích lũy

Stage 3 (ramp-down): VUs và httpReqs giảm
  → Nếu httpReqs giảm nhanh hơn VUs → loop_duration tăng → backend vẫn struggle

Stage 4 (drain): VUs về 1, httpReqs thấp
  → Nếu vẫn còn httpReqs cao → gracefulRampDown cho in-flight loops chạy
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

#### Phân tích sâu chart VUs vs iter/s cho wave

Chart này là **trọng tâm** cho ramping-vus. Nó trả lời câu hỏi:

```text
Với wave shape 1->22->8->1, throughput tự nhiên của hệ thống ở mỗi stage là bao nhiêu?
Throughput có tăng/giảm theo VUs không?
Hệ thống có recover ở late stage không?
```

**Mối quan hệ VUs và iter/s trong wave**:

```text
iter/s ≈ active_VUs / avg_loop_duration

Stage 1 (1->22 VUs): iter/s nên tăng từ ~2 lên ~35-44
Stage 2 (22 VUs):    iter/s nên ổn định ~35-44
Stage 3 (22->8 VUs): iter/s nên giảm từ ~35-44 xuống ~13-16
Stage 4 (8->1 VU):   iter/s nên giảm về ~2

Nếu iter/s không theo kịp VU shape → loop_duration đang thay đổi
```

**Đọc chart này cho case recovery wave**:

```text
Shape A — HEALTHY WAVE (hệ thống khỏe):
  Stage 1: VUs 1->22, iter/s 2->40 (tăng tuyến tính)
  Stage 2: VUs = 22, iter/s ổn định ~40
  Stage 3: VUs 22->8, iter/s 40->15 (giảm tuyến tính)
  Stage 4: VUs 8->1, iter/s 15->2 (giảm tuyến tính)
  → Kết luận: cart-service scale tốt theo concurrency, recover sạch

Shape B — SATURATION AT PEAK:
  Stage 1: VUs 1->22, iter/s 2->20 (chỉ tăng được một nửa!)
  Stage 2: VUs = 22, iter/s ổn định ~20 (thấp hơn expected 40)
  Stage 3: VUs 22->8, iter/s 20->14 (giảm ít — vì đã bão hòa từ trước)
  Stage 4: VUs 8->1, iter/s 14->2
  → Kết luận: cart-service bão hòa ở ~20 iter/s
    Thêm VUs không tăng throughput → closed-model backpressure

Shape C — PERSISTENT DEGRADATION:
  Stage 1: VUs 1->22, iter/s 2->30 (tăng tốt)
  Stage 2: VUs = 22, iter/s 30->15 (GIẢM dù VUs không đổi! lock contention tích lũy)
  Stage 3: VUs 22->8, iter/s 15->5 (giảm mạnh hơn tỉ lệ VUs)
  Stage 4: VUs 8->1, iter/s 5->1 (vẫn thấp)
  → Kết luận: degradation TÍCH LŨY theo thời gian
    Lock contention hoặc resource leak — không recover khi VUs giảm

Shape D — COLD START SPIKE:
  Stage 1: VUs 1->22, iter/s rất thấp lúc đầu (cold start)
           iter/s tăng vọt sau vài giây (cache warm, connection pool full)
  Stage 2-4: bình thường
  → Kết luận: cold start issue — lần đầu khởi tạo chậm
    Cần warm-up trước khi nhận traffic thật
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

### Kịch bản A — Clean wave: CART RECOVERY CAMPAIGN SAFE

```text
ramping_active_iterations.........: ~1958
ramping_active_iterations_failed..: 0
http_req_failed....................: 0.00%
checks..............................: 100%
ramping_api_calls_total............: ~4895 (≈ 1958 × 2.5)

Operation breakdown:
  cart_recovery_summary: ~1958  (40%)
  cart_recovery_add:     ~1958  (40%)
  cart_recovery_update:  ~979   (20%)

Response time (p95):
  cart_recovery_summary: 6ms
  cart_recovery_add:     6ms
  cart_recovery_update:  8ms

ramping_flow_duration_ms p95: ~18ms (API ~12ms + overhead)
iteration_duration p95: ~618ms (flow + sleep 600ms)
VU shape: 1 -> 22 -> 8 -> 1 ✓
Peak iter/s: ~41
```

Kết luận thực tế:

```text
- Wave 1->22->8->1 chạy sạch, không lỗi
- Write latency (add/update) thấp, read latency (summary) thấp
- Operation mix đúng 2:2:1 (summary:add:update)
- Hệ thống recover tốt ở late stage
=> QUYẾT ĐỊNH: Cart recovery campaign an toàn để triển khai.
   Accept baseline, có thể tăng peak VUs để tìm capacity limit.
```

### Kịch bản B — Write contention at peak: WAVE SPIKE ISSUE

```text
ramping_active_iterations.........: ~1200  (thấp hơn expected)
ramping_active_iterations_failed..: 45     (có failure!)
http_req_failed....................: 0.50%
checks..............................: 99.1%

Response time (p95) theo stage:
  Stage 1 (1->22): add 8ms, update 12ms — OK
  Stage 2 (22):    add 35ms, update 180ms — UPDATE CHẬM 15×!
  Stage 3 (22->8): add 20ms, update 60ms — đang giảm nhưng vẫn cao
  Stage 4 (8->1):  add 7ms, update 15ms — về gần baseline

VU shape: 1 -> 22 -> 8 -> 1 ✓
Peak iter/s: ~18 (so với expected ~35-40)
```

Kết luận thực tế:

```text
- Ở peak wave (22 VUs), update latency tăng 15× (12ms -> 180ms)
- Đây là write lock contention: 22 users cùng update cart
- iter/s chỉ đạt ~18 thay vì ~35 → throughput giảm 50%
- Stage 3-4 recover → issue là transient, chỉ ở peak
=> QUYẾT ĐỊNH: CAUTION. Cart-service có write contention ở 22 concurrent users.
   Nếu campaign gửi đến >22 users đồng thời, latency sẽ degrade.
   Cân nhắc: giảm batch size, thêm DB connection pool, hoặc
   chuyển sang optimistic locking.
```

### Kịch bản C — Stale reads during wave: READ-MODEL INCONSISTENCY

```text
ramping_active_iterations.........: ~1958
ramping_active_iterations_failed..: 120    ← 120 loops fail!
http_req_failed....................: 0.00%  ← HTTP vẫn 200 hết!
checks..............................: 97.6%

Operation breakdown:
  cart_recovery_summary: ~1958  (vẫn gọi đủ)
  cart_recovery_add:     ~1958  (vẫn gọi đủ)
  cart_recovery_update:  ~979   (vẫn gọi đủ)

Response time (p95):
  cart_recovery_summary: 5ms    (NHANH! nhưng...)
  cart_recovery_add:     6ms    (ổn)
  cart_recovery_update:  8ms    (ổn)

Nhưng:
  ramping_active_iterations_failed = 120
  → 120 loop fail vì summary data KHÔNG KHỚP expected cart state
  → HTTP 200 nhưng response body SAI
  → Read-model stale trong wave peak
```

Kết luận thực tế:

```text
- Add và update write thành công (HTTP 200, latency tốt)
- Nhưng summary trả về data cũ/thiếu → read model không sync kịp
- 120/1958 ≈ 6.1% loop bị read-model inconsistency
- Đặc biệt tệ ở stage 2 (peak wave) — khi write pressure cao nhất
- Nếu chỉ nhìn http_req_failed = 0% → TƯỞNG test pass!
=> QUYẾT ĐỊNH: BLOCK. Cart-service có read-model inconsistency.
   User add item, thấy 200, nhưng cart page không hiện item vừa add.
   Điều tra: materialized view refresh interval? CQRS sync delay?
   Đây là bug production-critical cho notification campaign.
```

### Kịch bản D — Recovery incomplete: PERSISTENT DEGRADATION

```text
ramping_active_iterations.........: ~950   (rất thấp)
ramping_active_iterations_failed..: 80
http_req_failed....................: 1.2%
checks..............................: 98.3%

Response time (p95) theo stage:
  Stage 1 (1->22): add 10ms, update 18ms — tăng dần
  Stage 2 (22):    add 45ms, update 250ms — RẤT CHẬM
  Stage 3 (22->8): add 40ms, update 220ms — GIẢM RẤT ÍT!
  Stage 4 (8->1):  add 38ms, update 200ms — VẪN CAO dù 1 VU!

VU shape: 1 -> 22 -> 8 -> 1 ✓
Peak iter/s: ~10
Late iter/s: ~2 (1 VU mà chỉ 2 iter/s → loop_duration 500ms!)
```

Kết luận thực tế:

```text
- Stage 4 chỉ còn 1 VU nhưng latency vẫn cao gần như stage 2 peak!
- Hệ thống KHÔNG recover sau wave
- Có thể: DB lock không release, connection pool cạn,
  cart data corrupted, hoặc resource leak
=> QUYẾT ĐỊNH: BLOCK CRITICAL. Đây là persistent degradation.
   Sau wave, hệ thống không về trạng thái bình thường.
   Nếu triển khai campaign thật, sau wave đầu tiên,
   TẤT CẢ user tiếp theo (kể cả 1 user) sẽ thấy latency cao.
   Điều tra: lock release, connection leak, transaction timeout.
```

### Bảng ánh xạ nhanh output -> hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| Clean wave | Recovery campaign safe | Accept |
| Summary slow | Cart read/materialized summary issue | Investigate summary |
| Add/update failures | Cart write path/concurrency issue | Block campaign |
| Recovery stage stays slow | Saturation/lock contention persists | Investigate before next batch |
| Write contention at peak only | Transient issue ở high concurrency | Cân nhắc giảm batch size hoặc tối ưu DB |
| Stale reads during wave | Read-model sync delay | Kiểm materialized view refresh |
| Persistent degradation | Resource leak hoặc lock không release | CRITICAL — điều tra ngay |
| iter/s không tăng theo VUs ở stage 1 | Closed-model backpressure từ đầu | Kiểm cold start, connection pool |
| API/loop ratio < 2.3 | Flow incomplete | Kiểm script branch logic |

## Nghịch lý và misconceptions của ramping-vus recovery wave

Đừng dùng shared-iterations cart cleanup mental model. Đây là wave of active users, không phải fixed list of stale items.

Nhớ 3 câu:

```text
stage target = absolute VU target, không phải delta
iterations/RPS = output, không phải input
VUs tăng mà iter/s flatten = tín hiệu backpressure đáng đọc
```

### Nghịch lý 1: "Wave ngắn (75s) mà quan trọng?"

```text
Nhìn config:
  Total effective duration ≈ 75s
  Peak VUs = 22
  
Câu hỏi: "Test chỉ 75 giây, 22 users — nhẹ nhàng, có gì đáng lo?
         Production có hàng ngàn users, 22 users thì test được gì?"
```

**Trả lời: Wave ngắn + ramp nhanh = stress test cho transition behavior, không phải throughput test.**

```text
Cơ chế:
  - 75s không phải để test throughput — mà để test TRANSITION
  - Ramp 1->22 trong 11s = mỗi 0.5s thêm 1 user mới
  - 22 users ĐỘT NGỘT xuất hiện → backend phải:
    + Mở 22 connections gần như đồng thời
    + Xử lý 22 cart reads + writes concurrent
    + Giữ consistency khi 22 users cùng mutate cart
  - Đây là STRESS TEST cho cold start + sudden concurrency

So sánh:
  constant-vus 22 VU trong 5m:
    - 22 users từ từ, ổn định suốt 5m
    - Backend có thời gian warm up, cache fill, connection pool ổn định
    - Không test được "điều gì xảy ra khi 22 users ập đến cùng lúc?"
  
  ramping-vus wave 1->22 trong 11s:
    - 22 users xuất hiện ĐỘT NGỘT
    - Backend CHƯA kịp warm up đã bị 22 concurrent requests
    - Test được transition behavior: cold start + sudden spike

Ý nghĩa:
  - Nếu notification push gửi đến 100,000 users
  - Không phải 100,000 users mở app CÙNG MỘT LÚC
  - Nhưng trong vài giây đầu, CONCURRENCY tăng rất nhanh
  - 22 VUs trong 11s mô phỏng ĐÚNG pattern này ở scale nhỏ
  - Tăng peak VUs + duration scale để mô phỏng scale lớn hơn
```

### Nghịch lý 2: "Writes pass (200 OK) nhưng reads stale?"

```text
Nhìn summary:
  http_req_failed = 0.00%
  checks = 97.6%
  ramping_active_iterations_failed = 120

Câu hỏi: "Sao writes (add/update) đều 200 mà reads (summary) vẫn sai?
         Nếu write đã OK, cart phải đúng chứ?"
```

**Trả lời: Write 200 chỉ nói write model nhận và xác nhận write. Read model có thể chưa sync kịp.**

```text
Cơ chế:
  1. POST /cart/add → write model ghi vào primary DB → 200 OK
  2. PATCH /cart/items/:id → write model update primary DB → 200 OK
  3. GET /cart/summary → read model đọc từ materialized view/replica → 200 OK
     Nhưng materialized view CHƯA SYNC → data cũ!

  → Cả 3 request đều HTTP 200
  → http_req_failed = 0%
  → Nhưng summary data SAI (thiếu item vừa add, sai quantity)
  → ramping_active_iterations_failed = 120 (business-level check fail)

Đặc biệt trong wave:
  - Ở stage 2 (22 VUs peak), write pressure CAO
  - Materialized view refresh có thể bị delay do resource contention
  - 22 users cùng write → read model sync queue dài hơn
  - Kết quả: read-model stale NHIỀU HƠN ở peak wave

Hệ quả:
  - Không thể chỉ dựa vào http_req_failed để kết luận pass/fail
  - Phải check response body/content ở business level
  - Phải đọc ramping_active_iterations_failed (business failure counter)
  - Trong wave, stale reads có thể TẬP TRUNG ở stage 2 (peak)
    → Đây là insight: read-model issue phụ thuộc vào concurrency level
```

### Nghịch lý 3: "Late stage latency thấp nhưng iter/s vẫn thấp?"

```text
Run có persistent degradation:
  Stage 4 (1 VU): latency vẫn cao (add 38ms, update 200ms)
  iter/s = 2 (1 VU, loop_duration = 0.5s → lẽ ra 2 iter/s là bình thường!)

Câu hỏi: "1 VU, iter/s = 2, đó chẳng phải là bình thường sao?
         Loop mất 0.5s (sleep 0.6s? Không — sleep đã được trừ)."
```

**Trả lời: iter/s = 2 với 1 VU là BÌNH THƯỜNG nếu loop_duration = 0.5s. Nhưng nếu latency CAO (add 38ms, update 200ms) mà iter/s vẫn = 2, thì sleep đang CHE KHUẤT issue.**

```text
Phân tích:
  Bình thường (1 VU):
    loop_duration = 0.6s (sleep) + 0.005s (summary) + 0.005s (add) + 0.0025s (update*0.5)
                  ≈ 0.6125s
    iter/s ≈ 1 / 0.6125 ≈ 1.6 iter/s

  Persistent degradation (1 VU):
    loop_duration = 0.6s (sleep) + 0.038s (summary) + 0.045s (add) + 0.100s (update*0.5)
                  ≈ 0.783s
    iter/s ≈ 1 / 0.783 ≈ 1.3 iter/s

  → iter/s giảm từ 1.6 xuống 1.3 (chỉ ~19%)
  → Nhưng LATENCY tăng 7-40×!
  → Sleep 0.6s đã CHE KHUẤT latency increase:
    latency tăng 250ms nhưng loop chỉ chậm thêm 170ms (vì update chỉ 50% loops)

Bài học:
  - Đừng chỉ nhìn iter/s để đánh giá recovery
  - Phải nhìn LATENCY của từng operation
  - Sleep dài làm giảm sensitivity của iter/s với latency change
  - Đây là lý do cần tách operation latency, không chỉ nhìn flow duration
  - Muốn thấy latency impact rõ hơn: giảm sleep (RV_06_SLEEP_SECONDS=0.1)
```

## Checklist đọc biểu đồ case 06

Khi đọc dashboard case 06, đọc theo thứ tự này:

```text
1. Overview KPI (trước khi vào chart):
   - http_req_failed < 1%?
   - checks > 99%?
   - ramping_active_iterations_failed < 25?
   - ramping_api_calls_total / ramping_active_iterations ≈ 2.5?

2. VUs vs iter/s (CHART QUAN TRỌNG NHẤT):
   - VU shape có đúng 1 -> 22 -> 8 -> 1 không?
   - iter/s có tăng/giảm theo VU shape không?
   - Ở stage 2: iter/s có ổn định không (không giảm dần)?
   - Ở stage 3-4: iter/s có giảm tương ứng với VUs không?
   - Nếu iter/s không theo VU shape → kiểm tra Response time chart

3. Response time chart:
   - Đã tách theo operation (summary vs add vs update) chưa?
   - Ở stage 1: latency có tăng đột ngột không? (cold start)
   - Ở stage 2: update p95 có >> add p95 không? (lock contention)
   - Ở stage 3-4: latency có GIẢM về baseline không? (recovery)
   - Có spike định kỳ không? (GC, cron)

4. Execution timeline:
   - Live VUs có theo 1->22->8->1 không?
   - httpReqs có ≈ 2.5× iterations không?
   - Failures có cluster ở stage 1-2 không?
   - Cuối run VUs có về 1 không? (drain hoàn tất)

5. Business decision:
   - Tất cả thresholds pass? + operation mix đúng?
     → Accept: campaign an toàn
   - Có failed iterations ở stage 2? 
     → Lọc theo operation tìm root cause
   - iter/s không theo kịp VU shape?
     → Closed-model backpressure, điều tra backend
   - Stage 3-4 latency không giảm?
     → Persistent degradation, BLOCK
   - Summary data sai dù HTTP 200?
     → Read-model inconsistency, BLOCK

6. Verify invariant:
   - stage.target = absolute (không phải delta) ✓
   - iterations/RPS = output (không có target) ✓
   - http_reqs ≈ iterations × 2.5 ✓
   - ramping_sleep_seconds ≈ iterations × 0.6 ✓
   - VU shape = 1 -> 22 -> 8 -> 1 ✓
   - Late stage recovery visible ✓
```

Kết luận của run case 06 đang đúng nếu thấy:

```text
http_req_failed < 1%
checks > 99%
ramping_active_iterations_failed < 25
ramping_api_calls_total / ramping_active_iterations ≈ 2.5 (±0.2)
VU shape = 1 -> 22 -> 8 -> 1
vus_max gần 22
Stage 3-4 latency giảm rõ rệt so với stage 2
Operation breakdown: summary ≈ add ≈ 2× update
executor = ramping-vus
scenario = cart_recovery_wave
```

## Mở rộng / variations

### Variation 1: Tăng peak VUs để tìm capacity limit của wave

```powershell
$env:RV_06_PEAK_VUS = "50"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js
```

Mục đích: Tìm điểm mà cart-service không còn scale được trong wave — iter/s không tăng dù VUs tăng.

```text
Cách đọc:
  Peak VUs=22: peak iter/s = 41 (baseline)
  Peak VUs=35: peak iter/s = 55 (gần tuyến tính: 35/22 × 41 = 65, thực tế 55 → hơi giảm)
  Peak VUs=50: peak iter/s = 58 (KHÔNG tuyến tính: 50/22 × 41 = 93, thực tế 58 → saturation!)
  → Capacity limit ~35-40 VUs cho cart-service trong wave
  → Trên 40 VUs: lock contention hoặc resource cạn ở peak

  Ngoài ra, quan sát recovery:
  Peak VUs=50: stage 3-4 có recover không?
  Nếu sau peak 50 VUs, stage 4 (1 VU) latency vẫn cao → persistent degradation
```

### Variation 2: Thay đổi wave steepness (độ dốc của ramp)

```powershell
# Wave chậm hơn — user mở app từ từ (giống email campaign hơn là push)
$env:RV_06_DURATION_SCALE = "1.0"
# Stage 1: 45s thay vì 11s
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js

# Wave cực nhanh — push notification real-time, user mở app gần như tức thì
$env:RV_06_DURATION_SCALE = "0.1"
# Stage 1: 5s thay vì 11s
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js
```

Mục đích: Hiểu ảnh hưởng của ramp speed đến backend behavior.

```text
So sánh:
  scale=1.0 (chậm, 45s ramp):
    - Backend có thời gian warm up, connection pool mở từ từ
    - Cold start issue ít nghiêm trọng hơn
    - Phù hợp email campaign (user mở app rải rác)

  scale=0.25 (mặc định, 11s ramp):
    - Backend thấy concurrency tăng nhanh
    - Cold start + sudden spike
    - Phù hợp push notification (user mở app trong vài giây)

  scale=0.1 (rất nhanh, 5s ramp):
    - Backend bị 22 connections đổ vào gần như đồng thời
    - Stress test cho connection pool init
    - Phù hợp flash sale hoặc event real-time

Kỳ vọng:
  scale càng nhỏ → ramp càng nhanh → stage 1 latency càng cao (cold start)
  Nhưng stage 2 latency nên GIỐNG NHAU (cùng 22 VUs, khác cách đạt đến)
  → Nếu stage 2 latency khác → cold start ảnh hưởng đến sustained performance
```

### Variation 3: Thay đổi tỉ lệ update (user behavior)

```js
// Script variation: update mọi loop (user luôn sửa quantity)
// Thay đổi điều kiện update từ "mỗi loop thứ hai" thành "mọi loop"
export default function () {
  // ...
  // Thay vì: if (__ITER % 2 === 0) { updateCart(); }
  // Thành:   updateCart(); // luôn update
  // ...
}
```

Mục đích: Cô lập ảnh hưởng của update operation đến write contention.

```text
So sánh:
  Flow gốc (update ~50%): API/loop = 2.5, update count = iterations/2
  Flow update 100%:       API/loop = 3.0, update count = iterations

  Nếu với update 100%:
    - iter/s giảm mạnh hơn ở peak → update là bottleneck chính
    - update p95 tăng cao hơn → lock contention từ update
    → Xác nhận: update operation là root cause của write contention

  Nếu với update 100%:
    - iter/s và latency gần như không đổi → update không phải bottleneck
    → Bottleneck có thể là add operation hoặc summary read
```

### Variation 4: Thêm latency threshold để biến thành performance gate

```js
export const options = {
  thresholds: {
    "http_req_duration{operation:cart_recovery_summary}": ["p(95)<20"],
    "http_req_duration{operation:cart_recovery_add}": ["p(95)<30"],
    "http_req_duration{operation:cart_recovery_update}": ["p(95)<50"],
    "ramping_flow_duration_ms": ["p(95)<1000"],
    // Đặc biệt: threshold cho recovery — stage cuối phải nhanh
    // (cần custom metric hoặc check trong script)
  },
};
```

Mục đích: Chuyển từ "quan sát" sang "gate": nếu latency vượt ngưỡng ở bất kỳ phase nào, CI/CD block.

```text
Lưu ý:
  - Threshold nên dựa trên baseline đã đo được, không phải số tưởng tượng
  - Nếu chưa có baseline: chạy case này vài lần, lấy p95 + 50% làm threshold ban đầu
  - Threshold quá chặt → flaky test; quá lỏng → không phát hiện regression
  - Với wave case, cân nhắc threshold RIÊNG cho từng operation
    (update dễ bị lock contention hơn add)
```

### Variation 5: Tăng notification batch size (giữ ramp speed, tăng peak)

```powershell
# Mô phỏng notification gửi đến nhiều users hơn
$env:RV_06_PEAK_VUS = "40"
$env:RV_06_LATE_VUS = "15"  # Giữ tỉ lệ late/peak ≈ 0.36 như gốc (8/22)
$env:RV_06_DURATION_SCALE = "0.25"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js
```

Mục đích: Mô phỏng campaign lớn hơn — nhiều users nhận notification hơn.

```text
Cách đọc:
  Peak VUs=22: OK, pass
  Peak VUs=30: OK, pass
  Peak VUs=40: bắt đầu thấy issue (update p95 tăng, iter/s không scale)
  Peak VUs=60: fail (failures, latency quá cao)

  → Xác định được "batch size an toàn" cho notification campaign
  → Nếu production có 50,000 users subscribe push:
    + Với scale hiện tại, peak VUs nên ≤ 40
    + Nếu muốn gửi đến 100,000 users → cần tối ưu backend trước
```

## Code patterns

### Code pattern đúng: Per-VU cart state với add/update/summary flow có weighted branch

```js
import { sleep } from "k6";
import { check } from "k6";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";

// Business metrics
const rampingActiveIterations = new Counter("ramping_active_iterations");
const rampingActiveIterationsFailed = new Counter("ramping_active_iterations_failed");
const rampingApiCallsTotal = new Counter("ramping_api_calls_total");
const rampingFlowDurationMs = new Trend("ramping_flow_duration_ms");
const rampingSleepSeconds = new Counter("ramping_sleep_seconds");

// Per-VU cart state — MỖI VU LÀ MỘT USER QUAY LẠI CART
// VU identity ổn định trong ramping-vus (khi VU active)
// Cart state persist qua các loop của cùng VU
const vuCarts = new Map(); // key: vuId, value: { items: {...}, itemCount: number }

function getVuCart(vuId) {
  if (!vuCarts.has(vuId)) {
    // Cart mới có thể có sẵn item cũ (abandoned cart)
    vuCarts.set(vuId, { items: {}, itemCount: 0 });
  }
  return vuCarts.get(vuId);
}

// Danh sách SKU để add vào cart
const PRODUCT_IDS = Array.from(
  { length: 200 },
  (_, i) => `SKU-${String(i + 1).padStart(4, "0")}`
);

function pickProductForAdd(vuId, cart) {
  const existingIds = new Set(Object.keys(cart.items));
  const available = PRODUCT_IDS.filter((id) => !existingIds.has(id));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  return PRODUCT_IDS[Math.floor(Math.random() * PRODUCT_IDS.length)];
}

function pickItemForUpdate(cart) {
  const ids = Object.keys(cart.items);
  if (ids.length === 0) return null;
  return ids[Math.floor(Math.random() * ids.length)];
}

export default function () {
  const vuId = __VU; // User identity — ổn định khi VU active
  const cart = getVuCart(vuId);

  const loopStart = Date.now();

  // === Step 1: Read cart summary (LUÔN LUÔN) ===
  const summaryRes = http.get(`${BASE_URL}/api/sim/cart/summary`, {
    headers: {
      "X-Recovery-Campaign": "abandoned-cart",
    },
    tags: {
      operation: "cart_recovery_summary",
      service: "cart-service",
      user_id: `user-${vuId}`,
      case_id: "rv-06-cart-recovery-wave",
      business_case: "cart_recovery_wave",
      endpoint: "cart_summary",
      executor_family: "ramping_vus",
      workload_shape: "staged_concurrency",
    },
  });

  rampingApiCallsTotal.add(1);

  const summaryOk = check(summaryRes, {
    "cart summary status 200": (r) => r.status === 200,
  });

  // === Step 2: Add recovery item (LUÔN LUÔN) ===
  const productId = pickProductForAdd(vuId, cart);
  const addQty = Math.floor(Math.random() * 5) + 1; // 1-5

  const addRes = http.post(
    `${BASE_URL}/api/sim/cart/add`,
    JSON.stringify({ product_id: productId, quantity: addQty }),
    {
      headers: {
        "Content-Type": "application/json",
        "X-Recovery-Campaign": "abandoned-cart",
      },
      tags: {
        operation: "cart_recovery_add",
        service: "cart-service",
        user_id: `user-${vuId}`,
        case_id: "rv-06-cart-recovery-wave",
        business_case: "cart_recovery_wave",
        endpoint: "cart_add",
        executor_family: "ramping_vus",
        workload_shape: "staged_concurrency",
      },
    }
  );

  rampingApiCallsTotal.add(1);

  const addOk = check(addRes, {
    "cart add status 200": (r) => r.status === 200,
  });

  if (addOk) {
    cart.items[productId] = (cart.items[productId] || 0) + addQty;
    cart.itemCount = Object.keys(cart.items).length;
  }

  // === Step 3: Update item (CÓ ĐIỀU KIỆN — ~50% loops) ===
  let updateOk = true; // Default true nếu không chạy update
  const shouldUpdate = __ITER % 2 === 0; // Mỗi loop thứ hai

  if (shouldUpdate) {
    const itemToUpdate = pickItemForUpdate(cart);

    if (itemToUpdate) {
      const newQty = Math.floor(Math.random() * 10) + 1; // 1-10

      const updateRes = http.patch(
        `${BASE_URL}/api/sim/cart/items/${itemToUpdate}`,
        JSON.stringify({ quantity: newQty }),
        {
          headers: {
            "Content-Type": "application/json",
            "X-Recovery-Campaign": "abandoned-cart",
          },
          tags: {
            operation: "cart_recovery_update",
            service: "cart-service",
            user_id: `user-${vuId}`,
            case_id: "rv-06-cart-recovery-wave",
            business_case: "cart_recovery_wave",
            endpoint: "cart_update",
            executor_family: "ramping_vus",
            workload_shape: "staged_concurrency",
          },
        }
      );

      rampingApiCallsTotal.add(1);

      updateOk = check(updateRes, {
        "cart update status 200": (r) => r.status === 200,
      });

      if (updateOk) {
        if (newQty === 0) {
          delete cart.items[itemToUpdate];
        } else {
          cart.items[itemToUpdate] = newQty;
        }
        cart.itemCount = Object.keys(cart.items).length;
      }
    }
  }

  // === Mark loop completion ===
  const loopDuration = Date.now() - loopStart;
  rampingFlowDurationMs.add(loopDuration);
  rampingActiveIterations.add(1);

  // Loop fail nếu bất kỳ required operation nào fail
  const loopFailed = !summaryOk || !addOk || (shouldUpdate && !updateOk);
  if (loopFailed) {
    rampingActiveIterationsFailed.add(1);
  }

  // === Think time ===
  const sleepSeconds = parseFloat(__ENV.RV_06_SLEEP_SECONDS || "0.6");
  sleep(sleepSeconds);
  rampingSleepSeconds.add(sleepSeconds);
}

export const options = {
  scenarios: {
    cart_recovery_wave: {
      executor: "ramping-vus",
      startVUs: parseInt(__ENV.RV_06_START_VUS || "1"),
      stages: [
        {
          duration: `${Math.max(1, Math.round(45 * (parseFloat(__ENV.RV_06_DURATION_SCALE) || 0.25)))}s`,
          target: parseInt(__ENV.RV_06_PEAK_VUS || "22"),
        },
        {
          duration: `${Math.max(1, Math.round(120 * (parseFloat(__ENV.RV_06_DURATION_SCALE) || 0.25)))}s`,
          target: parseInt(__ENV.RV_06_PEAK_VUS || "22"),
        },
        {
          duration: `${Math.max(1, Math.round(90 * (parseFloat(__ENV.RV_06_DURATION_SCALE) || 0.25)))}s`,
          target: parseInt(__ENV.RV_06_LATE_VUS || "8"),
        },
        {
          duration: `${Math.max(1, Math.round(45 * (parseFloat(__ENV.RV_06_DURATION_SCALE) || 0.25)))}s`,
          target: parseInt(__ENV.RV_06_START_VUS || "1"),
        },
      ],
      gracefulRampDown: "15s",
      tags: {
        case_id: "rv-06-cart-recovery-wave",
        business_case: "cart_recovery_wave",
        executor_family: "ramping_vus",
        workload_shape: "staged_concurrency",
      },
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    ramping_active_iterations_failed: ["count<25"],
  },
};
```

### Những điểm quan trọng trong code pattern

```text
1. Per-VU cart state (vuCarts Map):
   - Key = __VU (ổn định khi VU active trong ramping-vus)
   - Mỗi VU có cart state riêng, tích lũy qua các loop
   - Khi VU bị ramp-down, cart state của VU đó không dùng nữa
   - Đây là điểm KHÁC BIỆT với shared-iterations (không có per-VU state)

2. Weighted branch cho update:
   - shouldUpdate = __ITER % 2 === 0 → update mỗi loop thứ hai
   - Mô phỏng user behavior: không phải loop nào cũng sửa quantity
   - Kết quả: update count ≈ iterations / 2
   - API/loop ≈ 2.5 (không phải 3.0)

3. Summary ĐẦU TIÊN mỗi loop:
   - User mở app, xem cart TRƯỚC KHI thêm item
   - Đây là flow thực tế: nhận notification → mở app → xem cart → add item
   - Khác với constant-vus cart editing (add trước, summary sau)

4. Header campaign:
   - X-Recovery-Campaign: abandoned-cart
   - Phân biệt traffic notification recovery với traffic thông thường
   - Cho phép backend/dashboard filter theo campaign type

5. Tags đầy đủ:
   - operation: để tách latency theo summary/add/update
   - user_id: để debug user cụ thể nếu có vấn đề
   - endpoint: để nhóm API family
   - case_id, business_case, executor_family, workload_shape:
     để dashboard filter và group

6. Custom metrics:
   - ramping_active_iterations: đếm loop hoàn tất
   - ramping_active_iterations_failed: đếm loop fail
   - ramping_api_calls_total: đếm API calls thực tế
   - ramping_flow_duration_ms: đo full loop duration
   - ramping_sleep_seconds: đo sleep thực tế

7. Stage config dùng env override:
   - Tất cả stage duration, target VUs đều có thể override qua env
   - Cho phép điều chỉnh wave shape không cần sửa script
   - Duration scale áp dụng uniform cho tất cả stages
```

### Code pattern SAI — Không giữ cart state qua loop

```js
// SAI — Mỗi loop bắt đầu với cart rỗng
export default function () {
  const cart = { items: {}, itemCount: 0 }; // ← RESET mỗi loop!

  // Đọc summary → luôn thấy cart rỗng (hoặc data ngẫu nhiên)
  // Add item → cart chỉ có 1 item
  // Update item → không có item để update (cart vừa bị reset)
  // → Không mô phỏng được "user quay lại cart cũ"
  // → Không phát hiện được bug cart merge
}
```

```js
// SAI — Không có weighted branch cho update
export default function () {
  // ...
  // Luôn gọi update mỗi loop
  updateCartItem(); // ← SAI: update mọi loop
  // ...
  // → Update count = iterations (đáng lẽ = iterations/2)
  // → API/loop = 3.0 (đáng lẽ 2.5)
  // → Sanity check ratio sẽ sai
  // → Over-test write path, không phản ánh user behavior thật
}
```

```js
// SAI — Dùng exec.scenario.iterationInTest làm identity
export default function () {
  const cartId = exec.scenario.iterationInTest; // ← Mỗi loop = identity mới!
  // ...
  // → Giống shared-iterations model
  // → Không có persistent cart state
  // → Không phát hiện state mutation bugs
}
```

```js
// SAI — Add trước, summary sau (sai flow user)
export default function () {
  // Add item trước
  addToCart();
  // Rồi mới đọc summary
  readSummary();
  // → User thật: mở app → XEM CART → thêm item
  // → Không phải: mở app → THÊM ITEM → xem cart
  // → Flow sai → không phát hiện được read-model issue
  //   (vì summary đọc SAU KHI add, read model có thời gian sync)
}
```

## Anti-pattern

- Đọc `stage.target` như số VUs cộng thêm (không phải — là absolute target).
- Kỳ vọng fixed RPS từ `ramping-vus`.
- Dùng total `iterations` làm pass/fail target.
- Bỏ qua `gracefulRampDown` khi thấy tail iterations.
- Chỉ nhìn aggregate p95 trong mixed/conditional flow.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với flat active users của `constant-vus`.
- Nhầm recovery wave với steady cart editing — khác hoàn toàn về shape và mục tiêu.
- Không tách operation latency — gộp summary/add/update vào một aggregate p95.
- Cho rằng http_req_failed = 0% nghĩa là mọi thứ OK (summary data có thể sai dù HTTP 200).
- Không verify tỉ lệ API/loop (~2.5) — bỏ sót flow incomplete.
- Quên check late-stage recovery — chỉ nhìn peak behavior.
- Dùng `constant-vus` để test wave shape — không thấy được transition behavior.
- Reset cart state mỗi loop — không giữ persistent cart state qua các loop của cùng VU.
- Không gắn header campaign — không phân biệt được traffic notification recovery.
- Bỏ qua cold start signal ở stage 1 — chỉ nhìn sustained performance ở stage 2.
- Cho rằng "wave ngắn thì không quan trọng" — wave ngắn + ramp nhanh = stress test transition.
- So sánh trực tiếp iter/s của case này với constant-vus cart editing — khác shape, khác sleep, khác API/loop ratio.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Ramping-vus quick index: `../../20260517_01_ramping-vus-quick-index.md`
- Tham số/công thức: `../../20260517_02_ramping-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-06-cart-recovery-wave.js`
- Constant-vus contrast (active cart editing): `../constant-vus/03_active-cart-editing.md`
- Shared-iterations contrast (cart cleanup): `../shared-iterations/02_cart-cleanup.md`
- Worked example: `../../20260517_03_ramping-vus-quickpizza-two-requests-worked-example.md`
