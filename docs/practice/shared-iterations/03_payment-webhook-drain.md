# Case 03: Payment webhook drain

## Tình huống thực tế

Payment gateway thường deliver webhook theo kiểu at-least-once: một event có thể gửi lại nhiều lần. Sau outage hoặc deploy, hệ thống có thể có backlog webhook cần drain.

Nếu một event bị skip, order/payment state có thể không cập nhật. Nếu duplicate không idempotent, order có thể bị process nhiều lần.

Case này trả lời: 10 worker có drain đủ 100 webhook jobs không, và duplicate event có được xử lý an toàn không?

Tóm tắt đời thường:

```text
Trigger: payment gateway retry, webhook queue backlog, deploy consumer mới, hoặc incident recovery
Backlog: 100 payment webhook event jobs, có duplicate theo `SI_03_DUPLICATE_EVERY=5`
Risk nếu skip job: payment event không được apply vào order state hoặc duplicate gây double-processing
```

Case này **không** cố gắng trả lời "production traffic giống thật chưa?". Nó trả lời câu hỏi batch/ops cụ thể hơn:

```text
Có xử lý đủ fixed backlog không?
Mỗi job có đi đúng business flow không?
Có job nào fail không?
Duplicate có gây double-processing hoặc business failure không?
```

### Vì sao "payment webhook backlog drain" buộc chọn shared-iterations?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của payment webhook drain trước:

```text
Payment webhook drain = "xử lý TỪNG webhook event trong queue backlog,
                         POST webhook tới order-service,
                         xác nhận server xử lý đúng (kể cả duplicate),
                         không có event nào bị bỏ sót,
                         duplicate không gây double-processing"

Đời thường:
  Payment gateway gửi 100 webhook events vào queue
  10 consumer worker (= 10 VU) cùng drain queue
  Mỗi job: POST webhook tới order-service, gửi kèm X-Webhook-Id
  Cứ mỗi 5 event, có 1 event bị gửi lại (at-least-once delivery)
  Worker nào xong job trước thì lấy event tiếp theo
  Kết thúc khi TẤT CẢ 100 webhook events đã được xử lý
```

Để payment webhook drain **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ shared-iterations mới thỏa mãn cả 2.

#### Yêu cầu (a): EXACT TOTAL COVERAGE (không bỏ sót webhook event nào)

**Ý nghĩa**: Phải xử lý ĐỦ 100 webhook events. Thiếu 1 event là coverage incomplete — order state có thể không được cập nhật.

**Ví dụ cụ thể**:

```text
Scenario: payment gateway retry sau outage, 100 webhook events trong queue

Trường hợp A (coverage ĐỦ):
  Drain 100 webhook events, tất cả POST pass (kể cả duplicate)
  → Kết luận: webhook backlog drain OK, toàn bộ order state đã cập nhật

Trường hợp B (coverage THIẾU - bug):
  Drain 72 webhook events (thiếu 28), 72 event đã drain đều pass
  → Tưởng OK, nhưng 28 event chưa drain có thể là payment quan trọng
  → Production: payment đã charge nhưng order state không cập nhật
  → KHÔNG kết luận được, test không có giá trị
```

**Vì sao total iterations phải chính xác 100?**

```text
Nếu total phụ thuộc duration:
  - duration cố định 60s
  - latency thấp  → drain được 100 events (đủ)
  - latency cao   → drain được 72 events (thiếu 28)
  - latency tăng do order-service chậm (claim TTL, DB write), không phải do ít event hơn
  → Mỗi lần test số event drain được khác → không biết coverage có đủ không
```

**Phân tích sâu: vì sao 3 executor "duration-based" không đảm bảo count?**

`constant-vus` với `duration: "60s"`:

```text
Công thức count khi chạy:
  count_jobs = duration × throughput
             = 60s × (vus / iter_time)
             = 60s × (10 / iter_time)
             = 600 / iter_time

iter_time KHÔNG cố định, biến thiên do:
  - HTTP latency (mạng, server load, claim TTL wait)
  - DB write time (order-state update, idempotency record insert)
  - Duplicate handling (409 response nhanh hơn 200 vì claim đã tồn tại)
  - Lock contention (nhiều worker cùng claim event → TTL wait)

Ví dụ thực tế chạy 3 lần liên tiếp cùng config:
  Lần 1: server vừa restart, cache cold, claim TTL chưa có
    iter_time avg = 0.50s -> count = 600/0.50 = 1200 jobs drain
    (dư! drain nhiều hơn 100, nhưng có thể drain lặp event đầu, thiếu event cuối)
  Lần 2: claim TTL đã ổn, latency thấp
    iter_time avg = 0.30s -> count = 600/0.30 = 2000 jobs drain
  Lần 3: DB backup chạy ngầm, order-service chậm
    iter_time avg = 0.90s -> count = 600/0.90 = 666 jobs drain

  Vấn đề KHÔNG chỉ là count khác nhau.
  Vấn đề LỚN HƠN: không biết 100 webhook events có được drain ĐỦ không.
  1200 jobs có thể = drain event đầu 12 lần, bỏ event cuối.
```

`constant-arrival-rate` với `rate: 5/s, duration: "25s"`:

```text
Mục tiêu config: "5 job/s × 25s = 125 jobs TOTAL"
→ Dư so với 100 events cần drain. Nhưng...

KHÔNG đảm bảo đạt 125 vì có thể DROP slot:
  - Khi rate target > năng lực VU pool
  - Khi server chậm bất thường ở 1 đoạn (claim TTL spike, database lock)
  - Khi spawn VU không kịp lúc đầu

Công thức thực tế:
  N_done = N_sched - N_drop - N_int
         = 125 - N_drop - N_int

Ví dụ thực tế:
  Lần 1: pool vừa khít, không drop
    N_drop = 0, N_done = 125 (dư 25 so với 100, drain lặp)
  Lần 2: server có 10s chậm ở giữa (database backup, claim TTL spike)
    N_drop = 30, N_done = 95 (thiếu 5 events!)
  Lần 3: cache cold ở 30s đầu
    N_drop = 15, N_int = 5, N_done = 105 (dư 5, may mắn)

  KHÔNG可靠: lần được lần không, không biết trước
```

**Trong khi đó với `shared-iterations`**:

```text
Config: vus=10, iterations=100
N_done = 100 (TUYỆT ĐỐI, nếu không bị maxDuration cắt)

Lần 1: server chậm  -> 100 jobs, T_run=18s, p95=1.2s
Lần 2: server nhanh -> 100 jobs, T_run=10s, p95=0.4s
Lần 3: server bình thường -> 100 jobs, T_run=14s, p95=0.7s

Count CỐ ĐỊNH ở 100 mỗi lần.
Chỉ có T_run + latency thay đổi -> đó CHÍNH LÀ cái cần đo!

→ 100 webhook events luôn được drain đủ → coverage guarantee
→ Nếu latency tăng, T_run tăng → phát hiện được performance regression
→ Nếu duplicate gây claim TTL spike, p95 tăng → phát hiện idempotency contention
```

**Tóm tắt 3 executor về count**:

| Executor | Count formula | Count cố định? | Webhook coverage guarantee? |
| --- | --- | --- | --- |
| **shared-iterations** | `iterations` | CÓ (tuyệt đối) | CÓ (nếu identity map đúng + duplicate schedule đúng) |
| constant-vus (duration) | `duration × vus / iter_time` | KHÔNG (do iter_time) | KHÔNG (có thể drain lặp hoặc thiếu) |
| constant-arrival-rate | `N_sched - N_drop - N_int` | KHÔNG (do drop/int) | KHÔNG (drop có thể bỏ sót event) |

→ COUNT phải CHÍNH XÁC, KHÔNG phụ thuộc latency
→ Chỉ executor đếm theo "iterations cố định" mới đạt
→ Nhưng count đủ chưa đủ — còn cần identity map ĐÚNG + duplicate schedule ĐÚNG (yêu cầu b)

#### Yêu cầu (b): CORRECT EVENT IDENTITY + DUPLICATE HANDLING

**Ý nghĩa**: 100 iteration phải map sang 100 webhook jobs với event ID chính xác, trong đó có các duplicate theo schedule `SI_03_DUPLICATE_EVERY`. Nếu map sai event ID hoặc duplicate schedule sai, dù count = 100, kết quả vẫn không có giá trị.

**Bug identity mapping là gì?**

```text
Trường hợp ĐÚNG — identity từ iterationInTest + duplicate schedule:
  iter #0  -> event "evt-000" (webhook gốc)
  iter #1  -> event "evt-001"
  iter #2  -> event "evt-002"
  iter #3  -> event "evt-003"
  iter #4  -> event "evt-004"
  iter #5  -> event "evt-004" (DUPLICATE! Cùng X-Webhook-Id với iter #4)
  iter #6  -> event "evt-005"
  iter #7  -> event "evt-006"
  iter #8  -> event "evt-007"
  iter #9  -> event "evt-008"
  iter #10 -> event "evt-009"
  iter #11 -> event "evt-009" (DUPLICATE! Cùng X-Webhook-Id với iter #10)
  ...
  → Vừa đủ unique events, vừa có duplicate theo schedule ✓

Trường hợp SAI — identity từ __VU:
  VU=1: __VU=1 -> luôn gửi event "evt-001" (lặp lại ~15 lần)
  VU=2: __VU=2 -> luôn gửi event "evt-002" (lặp lại ~12 lần)
  ...
  VU=10: __VU=10 -> luôn gửi event "evt-010" (lặp lại ~8 lần)
  → Chỉ 10 event được gửi (lặp đi lặp lại)
  → 90 event còn lại KHÔNG BAO GIỜ được drain
  → Dù iterations = 100, coverage thật chỉ = 10/100 = 10%
```

**Bug duplicate schedule là gì?**

```text
Trường hợp ĐÚNG — duplicate theo DUPLICATE_EVERY:
  iter #4 -> event "evt-004" (lần 1)
  iter #5 -> event "evt-004" (lần 2, duplicate)
  → Server thấy cùng X-Webhook-Id: "evt-004"
  → Lần 1: 200 OK (process), lần 2: 200/409 (idempotent reject) ✓

Trường hợp SAI — không có duplicate:
  iter #4 -> event "evt-004"
  iter #5 -> event "evt-005" (sai! lẽ ra phải là duplicate của evt-004)
  → Không test được idempotency path
  → Nếu production có duplicate thật, order-state có thể corrupt
  → Bug idempotency không bị phát hiện trong test
```

**3 nguyên nhân kỹ thuật của bug identity mapping trong webhook drain**:

### Nguyên nhân 1: QUEUE DRAIN SEMANTICS (webhook backlog là queue tự nhiên)

**Vấn đề**: Webhook system sinh ra backlog tự nhiên sau outage. Duration-based test không mô phỏng được "drain tới khi hết queue" — nó dừng sau thời gian cố định, không theo số event.

```text
Tưởng tượng payment gateway queue sau outage:
  - 100 payment webhook events đang chờ xử lý
  - 10 consumer worker cùng pull event từ queue
  - Worker nào rảnh thì lấy event tiếp theo
  - Mục tiêu: queue rỗng (0 event pending)

  Nếu dùng constant-vus duration=60s:
    - Hết 60s, test dừng bất kể queue còn event hay không
    - Queue có thể còn 28 events chưa drain
    → Không biết những event đó có lỗi không

  Nếu dùng shared-iterations iterations=100:
    - Test chỉ dừng khi 100 events đã được xử lý
    - Queue rỗng → drain hoàn tất
    → Mọi event đã được attempt
```

**Demo cụ thể: constant-vus duration=60s, vus=10**

Giả sử mỗi iter mất 0.5s, code dùng `__VU` làm identity (SAI):

```text
VU=1 (nhanh nhất, network tốt): iter_time=0.3s
  → 60s / 0.3s = 200 iter
  → Luôn gửi event "evt-001", lặp 200 lần

VU=10 (chậm nhất, network kém): iter_time=0.9s
  → 60s / 0.9s = 66 iter
  → Luôn gửi event "evt-010", lặp 66 lần

Tổng: 200+... +66 ≈ 1200 iterations
Nhưng chỉ 10 event unique được drain
→ Coverage thật = 10/100 = 10%
→ 90 event bỏ sót, dù test "pass" với 1200 iter
```

**Demo với code đúng (identity từ iterationInTest) nhưng vẫn duration-based**:

```text
Vấn đề khác: không biết khi nào đã drain đủ 100 events

constant-vus duration=60s:
  iter #0-#99: drain event #0-#99 (đủ 100)
  iter #100-#1199: drain tiếp event #0-#99 (lặp lại, dư)
  → Lãng phí, nhưng ít nhất 100 event đã được drain

constant-vus duration=15s (quá ngắn):
  iter #0-#72: drain event #0-#72 (chỉ 73 event)
  → Thiếu 27 event, coverage không đủ
  → Nhưng test vẫn "pass" nếu chỉ nhìn http_req_failed=0

SO SÁNH VỚI shared-iterations:
  iterations=100
  iter #0-#99: drain event #0-#99 (đủ 100, DỪNG)
  → Không dư, không thiếu, coverage chính xác
  → Điểm khác biệt lớn với case 01: thêm duplicate schedule
    → iter #5 drain event #4 lần 2 (duplicate)
    → iter #11 drain event #10 lần 2 (duplicate)
```

**Cách phát hiện**: so sánh `iterations` count với expected `JOBS`. Nếu `iterations < JOBS` → coverage incomplete. Nếu `iterations > JOBS` và identity từ `__VU` → drain lặp.

### Nguyên nhân 2: AT-LEAST-ONCE DELIVERY (duplicate là normal, test phải chứng minh an toàn)

**Vấn đề**: Trong payment systems, at-least-once delivery là đặc trưng, không phải bug. Mỗi webhook event có thể được gửi lại nhiều lần. Hệ thống PHẢI xử lý an toàn: duplicate event không được gây double-charge hay double-process.

```text
Tại sao payment gateway gửi duplicate?
  - Gateway gửi webhook, HTTP 200 OK, nhưng response bị mất trên đường về
  - Gateway không biết consumer đã nhận được chưa → retry
  - Consumer nhận 2 lần cùng một payment event
  - Nếu consumer không idempotent → order bị process 2 lần → double-charge

Đây là tình huống SẢN XUẤT THẬT:
  - Stripe docs: "Stripe may send the same event more than once"
  - PayPal docs: "notification messages may be delivered more than once"
  - Không test duplicate = không test được path production-critical
```

**Demo trace: at-least-once duplicate gây lỗi nếu không idempotent**

```text
Backend state: order-service KHÔNG có idempotency check

Job #4: POST /api/sim/orders/webhooks/payment
  X-Webhook-Id: "evt-004"
  Body: {order_id: "ORD-123", amount: 50000, status: "paid"}
  → Server: tìm order ORD-123, cập nhật status=paid, balance += 50000
  → Response: 200 OK

Job #5 (DUPLICATE): POST /api/sim/orders/webhooks/payment
  X-Webhook-Id: "evt-004" (CÙNG ID!)
  Body: {order_id: "ORD-123", amount: 50000, status: "paid"}
  → Server: tìm order ORD-123, cập nhật status=paid, balance += 50000 (LẦN 2!)
  → Response: 200 OK
  → Balance ORD-123: 100000 thay vì 50000 ← DOUBLE-CHARGE!

Bug này production-critical nhưng test thường bỏ qua vì:
  - Test functional chỉ gửi 1 event
  - Test load chỉ quan tâm throughput
  - Test end-to-end ít khi mô phỏng duplicate delivery
```

**Demo trace: at-least-once duplicate được xử lý an toàn (idempotent)**

```text
Backend state: order-service CÓ idempotency check

Job #4: POST /api/sim/orders/webhooks/payment
  X-Webhook-Id: "evt-004"
  Body: {order_id: "ORD-123", amount: 50000, status: "paid"}
  → Server: check idempotency table, "evt-004" chưa tồn tại
  → Process payment, lưu idempotency record "evt-004" → "processed"
  → Response: 200 OK

Job #5 (DUPLICATE): POST /api/sim/orders/webhooks/payment
  X-Webhook-Id: "evt-004" (CÙNG ID!)
  Body: {order_id: "ORD-123", amount: 50000, status: "paid"}
  → Server: check idempotency table, "evt-004" ĐÃ tồn tại → "processed"
  → KHÔNG process lại, trả về idempotent response
  → Response: 200 OK (hoặc 409 Conflict tùy implementation)
  → Balance ORD-123: 50000 (chỉ cập nhật 1 lần) ✓
```

**Cách phát hiện**: nếu `shared_jobs_failed > 0` ở các job duplicate → idempotency bug. Nếu operation count > JOBS (vd: 100 unique event nhưng 120 HTTP requests) → có retry/duplicate không được xử lý đúng. Nếu `http_req_failed` tăng ở bucket duplicate → 409/500 do claim lock sai.

### Nguyên nhân 3: IDEMPOTENCY / CLAIM LOCKING (race condition khi nhiều worker cùng claim)

**Vấn đề**: Khi nhiều worker cùng xử lý webhook events với cùng X-Webhook-Id (trường hợp duplicate hoặc retry), server phải dùng claim lock để đảm bảo chỉ 1 worker process. Nếu claim TTL quá ngắn hoặc lock implementation sai, có thể gây race condition.

```text
Cơ chế claim locking điển hình:

1. Worker A nhận webhook event "evt-004", gửi POST
2. Server nhận request:
   a. Kiểm tra idempotency table: "evt-004" đã claim chưa?
   b. Nếu chưa: INSERT claim record "evt-004" với TTL=claim_ttl_ms
   c. Nếu đã claim: return 409 Conflict / idempotent response
3. Worker process payment trong claim TTL window
4. Sau khi process xong: update claim record → "evt-004" = "processed"
5. Claim record hết hạn sau TTL → có thể bị xóa (tùy implementation)
```

**Race condition khi claim TTL không đủ hoặc implementation sai**:

```text
Timeline race condition với claim_ttl_ms=4000:

t=0.0s   Worker A POST event "evt-004" (lần 1)
         Server: claim "evt-004", TTL=4s, bắt đầu process

t=0.5s   Worker B POST event "evt-004" (duplicate, lần 2)
         Server: kiểm tra claim → "evt-004" đã tồn tại
         → Return 409 Conflict (idempotent reject) ✓

t=4.0s   Claim "evt-004" hết TTL → bị xóa khỏi claim table
         Nhưng Worker A VẪN ĐANG process! (chưa xong vì DB chậm)

t=4.1s   Worker C POST event "evt-004" (retry thứ 3)
         Server: kiểm tra claim → "evt-004" KHÔNG tồn tại (đã hết TTL)
         → INSERT claim mới, bắt đầu process ← RACE CONDITION!
         → Cả Worker A và Worker C cùng process "evt-004"

Kết quả: DOUBLE-PROCESS dù có idempotency system
Nguyên nhân: claim TTL (4s) < job duration thực tế (~5s)
```

**Demo trace claim TTL contention với 10 VU, DUPLICATE_EVERY=5**:

```text
Config: vus=10, iterations=100, DUPLICATE_EVERY=5, claim_ttl_ms=4000

Giả sử order-service latency ~300ms bình thường, nhưng có spike:

t=0.0s   10 VU start, lấy 10 iter đầu
t=0.3s   VU nhanh xong iter đầu, lấy tiếp
...
t=1.5s   iter #4 (evt-004, lần 1): POST, server claim "evt-004"
t=1.8s   iter #5 (evt-004, duplicate!): POST, server thấy claim → 409 ✓
         → 2 job liên tiếp cùng event, cách nhau 0.3s
         → Claim TTL = 4s >> 0.3s → claim vẫn còn → an toàn

t=6.0s   iter #28 hoặc iter nào đó trùng event do retry schedule:
         Nếu duplicate schedule tạo 2 job cách xa nhau > 4s:
         → Job 1 claim "evt-XXX", TTL=4s
         → 4s sau, job 2 (duplicate) POST "evt-XXX"
         → Claim đã hết hạn → có thể process lại → DOUBLE-PROCESS

Tình huống này xảy ra khi:
  - VU nhanh xử lý event gốc
  - VU chậm nhận duplicate của event đó muộn hơn 4s
  - Shared-iterations worker model làm việc này KHẢ DĨ
```

**Cách phát hiện**: so sánh `shared_job_duration_ms` p95 với `claim_ttl_ms`. Nếu p95 > claim_ttl_ms → nguy cơ claim hết hạn trước khi job xong. Theo dõi http_req_failed ở bucket duplicate — nếu 409 xuất hiện nhiều hơn expected → lock contention. Nếu có 500 ở bucket duplicate → claim implementation lỗi.

### Nguyên nhân 4: EVENT IDENTITY IS NOT WORKER IDENTITY

Đây là lỗi phổ biến nhất khi chuyển từ per-vu-iterations sang shared-iterations, và với webhook drain nó còn phức tạp hơn vì thêm duplicate schedule.

**`__VU` là gì trong shared-iterations?** `__VU` là **worker ID** — định danh VU nào đang xử lý job hiện tại. Nó không phải business identity.

**`exec.scenario.iterationInTest` là gì?** Là **global job index** — số thứ tự iteration trong toàn scenario, từ 0 đến iterations-1.

**Event ID trong webhook drain không đơn giản là `iterationInTest`** — vì duplicate schedule làm cho nhiều iteration map vào cùng một event. Cần derive event ID từ iterationInTest và DUPLICATE_EVERY.

```text
So sánh 2 cách map identity:

Cách A — SAI: dùng __VU
  const eventId = `evt-${String(__VU).padStart(3, "0")}`;
  
  VU=1: __VU=1 -> luôn gửi "evt-001" (lặp ~15 lần)
  VU=2: __VU=2 -> luôn gửi "evt-002" (lặp ~12 lần)
  ...
  VU=10: __VU=10 -> luôn gửi "evt-010" (lặp ~8 lần)
  → 10 unique event, 90 event bỏ sót
  → Chưa kể: duplicate schedule bị phá vỡ hoàn toàn

Cách B — ĐÚNG: dùng exec.scenario.iterationInTest + duplicate schedule
  const baseId = computeBaseId(exec.scenario.iterationInTest);
  const eventId = `evt-${String(baseId).padStart(3, "0")}`;
  
  Với DUPLICATE_EVERY=5:
    iter #0  -> baseId=0  -> "evt-000"
    iter #1  -> baseId=1  -> "evt-001"
    iter #2  -> baseId=2  -> "evt-002"
    iter #3  -> baseId=3  -> "evt-003"
    iter #4  -> baseId=4  -> "evt-004"
    iter #5  -> baseId=4  -> "evt-004" (DUPLICATE!)
    iter #6  -> baseId=5  -> "evt-005"
    iter #7  -> baseId=6  -> "evt-006"
    iter #8  -> baseId=7  -> "evt-007"
    iter #9  -> baseId=8  -> "evt-008"
    iter #10 -> baseId=9  -> "evt-009"
    iter #11 -> baseId=9  -> "evt-009" (DUPLICATE!)
    ...
  → Đủ unique events, duplicate đúng schedule ✓
```

**Demo trace 10 VU × 100 iter với identity đúng + duplicate schedule**:

```text
t=0.0s   10 VU cùng start
         VU=1 lấy iterInTest=0  -> event "evt-000" (gốc)
         VU=2 lấy iterInTest=1  -> event "evt-001" (gốc)
         VU=3 lấy iterInTest=2  -> event "evt-002" (gốc)
         ...
         VU=10 lấy iterInTest=9 -> event "evt-008" (gốc)

t=0.4s   VU=1 xong iter #0, lấy iterInTest=10 -> event "evt-009" (gốc)
         VU=4 xong iter #3, lấy iterInTest=11 -> event "evt-009" (DUPLICATE!)
         → Lưu ý: iter #10 và #11 CÙNG event "evt-009"
         → iter #11 là duplicate của iter #10

t=0.8s   VU=2 xong iter #1, lấy iterInTest=12 -> event "evt-010" (gốc)

...

t=8.0s   iterInTest=99 được lấy (event cuối)
         100/100 jobs complete -> scenario dừng

Kết quả: ~84 unique events, ~16 duplicates, tổng 100 jobs ✓
Duplicate schedule được giữ nguyên vẹn dù VU nào cũng có thể nhận duplicate
```

**Demo trace 10 VU × 100 iter với identity SAI (dùng __VU)**:

```text
t=0.0s   VU=1: __VU=1 -> "evt-001" (lần 1)
         VU=2: __VU=2 -> "evt-002" (lần 1)
         ...

t=0.4s   VU=1: __VU=1 -> "evt-001" (lần 2)  ← lặp!
         VU=6: __VU=6 -> "evt-006" (lần 1)
         ...

t=8.0s   100 iter hoàn thành
         event "evt-001": gửi 20 lần
         event "evt-002": gửi 15 lần
         ...
         event "evt-010": gửi 8 lần
         event "evt-011" đến "evt-099": 0 lần ← 90 event bỏ sót!
         → Duplicate schedule: không tồn tại (vì chỉ có 10 event được gửi)

Kết quả: 100 iter, nhưng coverage thật = 10/100 = 10% ❌
         Idempotency path không được test đúng
```

**Vì sao lỗi này dễ mắc khi chuyển từ per-vu-iterations?**

```text
Trong per-vu-iterations:
  __VU = business identity (user, customer, tenant)
  Mỗi VU chạy đúng N iter cho cùng identity đó
  → Dùng __VU để map identity là ĐÚNG

Trong shared-iterations:
  __VU = worker identity (ai đang cầm job)
  Mỗi VU chạy số iter khác nhau, job identity thay đổi mỗi lần
  → Dùng __VU để map identity là SAI

Code đúng cho shared-iterations với duplicate schedule:
  const jobIndex = exec.scenario.iterationInTest;  // 0..99
  const baseId = Math.floor(jobIndex / (DUPLICATE_EVERY + 1)) * DUPLICATE_EVERY
                 + (jobIndex % (DUPLICATE_EVERY + 1));
  // HOẶC dùng hàm tính baseId từ jobIndex và DUPLICATE_EVERY
  const eventId = `evt-${String(baseId).padStart(3, "0")}`;
  // KHÔNG: const eventId = `evt-${String(__VU).padStart(3, "0")}`;
```

### Tổng kết: chỉ shared-iterations thỏa mãn cả (a) và (b)

| Executor | (a) Exact total coverage | (b) Correct identity + duplicate schedule | Verdict |
| --- | --- | --- | --- |
| **shared-iterations** | ✓ iterations cố định | ✓ nếu dùng iterationInTest + duplicate logic | ✅ DÙNG |
| per-vu-iterations | ✓ count cố định | ✗ ép quota bằng nhau, VU không phải worker, duplicate schedule bị phá | ❌ |
| constant-vus (duration) | ✗ count phụ thuộc latency | ✗ VU random pick, identity không ổn định | ❌ |
| constant-arrival-rate | ✗ có thể drop | ✗ rate-driven, không bound vào job index | ❌ |
| ramping-vus | ✗ count biến thiên theo time | ✗ VU spawn lệch theo timeline | ❌ |
| ramping-arrival-rate | ✗ count biến thiên + drop | ✗ rate-driven, không bound job | ❌ |

→ Chỉ **shared-iterations** thỏa mãn cả 2 yêu cầu, các executor khác đều fail ở ít nhất 1 trong 2.

### 3 thông số config ánh xạ từ yêu cầu nghiệp vụ

```text
1. FIXED BACKLOG SIZE (tổng số webhook job cố định):
   - Payment gateway có 100 webhook events trong queue
   - Không phải "drain trong 10 phút", mà là "drain ĐỦ 100 events"
   → iterations = 100 (tổng job toàn scenario)
   → KHÔNG dùng duration làm input chính

2. WORKER POOL SIZE (số consumer worker cùng drain):
   - 10 worker cùng drain queue để xong nhanh hơn
   - Không quan trọng worker nào làm bao nhiêu, miễn tổng đủ
   → vus = 10 (số worker)
   → KHÔNG cần mỗi VU drain đúng 10 webhook

3. AT-LEAST-ONCE / DUPLICATE COVERAGE (đảm bảo idempotency):
   - DUPLICATE_EVERY=5: sau mỗi 5 unique event, thêm 1 duplicate
   - Mỗi duplicate phải có cùng X-Webhook-Id với event gốc
   - Server phải xử lý an toàn: không double-process, không fail
   → Đây là yêu cầu đặc thù của webhook drain mà case khác không có
```

## DUPLICATE HANDLING — CƠ CHẾ ĐẶC THÙ CỦA CASE 03

Đây là phần quan trọng nhất của case này, vì nó phân biệt case 03 với tất cả case shared-iterations khác. Mọi case shared-iterations đều drain fixed backlog, nhưng chỉ case 03 mới có duplicate delivery.

### Cách SI_03_DUPLICATE_EVERY hoạt động

`SI_03_DUPLICATE_EVERY=5` quy định: trong chuỗi 100 webhook jobs, sau mỗi 5 unique event sẽ có 1 job duplicate với X-Webhook-Id trùng với event ngay trước đó.

```text
Công thức derive event ID từ job index và DUPLICATE_EVERY:

  groupSize = DUPLICATE_EVERY + 1    // = 6 (5 unique + 1 duplicate)
  groupIndex = floor(jobIndex / groupSize)
  offsetInGroup = jobIndex % groupSize

  if offsetInGroup == DUPLICATE_EVERY:    // vị trí cuối trong group (thứ 6)
    // Đây là job duplicate → dùng lại event ID của job trước đó
    // offsetInGroup - 1 = DUPLICATE_EVERY - 1 = vị trí unique cuối
    uniqueIndex = groupIndex * DUPLICATE_EVERY + (DUPLICATE_EVERY - 1)
    baseId = uniqueIndex
  else:
    // Job unique bình thường
    baseId = groupIndex * DUPLICATE_EVERY + offsetInGroup

  webhookId = "evt-" + padStart(baseId, 3)

Bảng kết quả job index 0-20:

  job #0:  group=0, offset=0, baseId=0  → "evt-000" (unique)
  job #1:  group=0, offset=1, baseId=1  → "evt-001" (unique)
  job #2:  group=0, offset=2, baseId=2  → "evt-002" (unique)
  job #3:  group=0, offset=3, baseId=3  → "evt-003" (unique)
  job #4:  group=0, offset=4, baseId=4  → "evt-004" (unique)
  job #5:  group=0, offset=5, DUPLICATE → "evt-004" (trùng job #4!)
  job #6:  group=1, offset=0, baseId=5  → "evt-005" (unique)
  job #7:  group=1, offset=1, baseId=6  → "evt-006" (unique)
  job #8:  group=1, offset=2, baseId=7  → "evt-007" (unique)
  job #9:  group=1, offset=3, baseId=8  → "evt-008" (unique)
  job #10: group=1, offset=4, baseId=9  → "evt-009" (unique)
  job #11: group=1, offset=5, DUPLICATE → "evt-009" (trùng job #10!)
  job #12: group=2, offset=0, baseId=10 → "evt-010" (unique)
  ...
  job #99: job cuối cùng trong 100-job sequence
```

### Demo trace: job #4 và job #5 — duplicate đầu tiên

```text
Đây là duplicate đầu tiên trong test, đánh dấu lần đầu tiên X-Webhook-Id bị trùng:

Job #4:
  iterationInTest = 4
  webhook_id = "evt-004"
  X-Webhook-Id header = "evt-004"
  Body = {webhook_id: "evt-004", order_id: "ORD-004", ...}
  → POST lần đầu cho event này
  → Server claim "evt-004", process payment, return 200 OK
  → job_duration ≈ 0.35s

Job #5 (DUPLICATE):
  iterationInTest = 5
  webhook_id = "evt-004"  ← CÙNG ID với job #4!
  X-Webhook-Id header = "evt-004"
  Body = {webhook_id: "evt-004", order_id: "ORD-004", ...}
  → POST lần 2 cho CÙNG event
  → Server check claim "evt-004" → đã tồn tại
  → Return 200/409 (idempotent response)
  → job_duration ≈ 0.05s (nhanh hơn vì không cần process)

Thời gian giữa 2 job: phụ thuộc worker pool
  - Nếu cùng 1 VU nhanh: cách nhau ~0.35s (job #4 vừa xong, lấy tiếp job #5)
  - Nếu VU khác nhau: có thể gần như đồng thời (~0.01s)
  - Cả 2 trường hợp: claim TTL=4s >> gap → claim vẫn còn → an toàn
```

### Server behavior đúng cho duplicate

```text
Khi server nhận webhook với X-Webhook-Id đã tồn tại, có 2 cách xử lý đúng:

Cách 1 — Idempotent 200 OK:
  Server: "Tôi đã thấy event này rồi, đã process rồi, OK"
  → HTTP 200, body có thể chứa kết quả từ lần process trước
  → Consumer thấy 200 → job success
  → Ưu điểm: client không cần phân biệt first vs duplicate

Cách 2 — Conflict 409:
  Server: "Event này tôi đã process rồi, conflict"
  → HTTP 409 Conflict
  → Consumer thấy 409 → vẫn coi là OK (event đã được xử lý)
  → Ưu điểm: rõ ràng về mặt semantics

Cả 2 cách đều ĐÚNG, miễn là:
  1. KHÔNG process lại payment (không double-charge)
  2. KHÔNG update order state lần 2
  3. Response không gây crash ở consumer
```

### Server behavior SAI cho duplicate

```text
Các bug thường gặp khi xử lý duplicate webhook:

Bug 1 — KHÔNG check idempotency:
  Server: không có idempotency table, process mọi request như mới
  → Mỗi duplicate → process lại payment → double-charge
  → Output: shared_jobs_total = 100, http_reqs = 100
  → Nhưng order balance bị sai! KHÔNG phát hiện qua HTTP metrics

Bug 2 — Idempotency check sai key:
  Server: check idempotency bằng order_id thay vì webhook_id
  → event #4 và event #5 có cùng webhook_id "evt-004" nhưng khác order_id
  → Nếu order_id cũng trùng → vẫn process 2 lần cho cùng order
  → Nếu order_id khác → không phát hiện duplicate

Bug 3 — Claim TTL quá ngắn:
  Server: claim "evt-004", TTL=100ms
  → Job #4 process mất 350ms
  → Claim hết hạn ở 100ms, job vẫn đang chạy
  → Job #5 duplicate đến ở 360ms → claim không tồn tại → process lại
  → Double-process!

Bug 4 — Server crash/500 khi duplicate:
  Server: gặp duplicate → throw exception → HTTP 500
  → Consumer thấy 500 → retry → càng nhiều duplicate → cascade failure
  → Output: http_req_failed tăng, shared_jobs_failed tăng

Bug 5 — Duplicate schedule bị bỏ qua hoàn toàn:
  Script: không implement DUPLICATE_EVERY
  → 100 unique events, 0 duplicate
  → Test "pass" sạch đẹp
  → Nhưng idempotency path KHÔNG ĐƯỢC TEST
  → Production có duplicate thật → bug không bị phát hiện
```

### Code pattern cho duplicate schedule

```js
// Cách derive webhook event ID từ iterationInTest và DUPLICATE_EVERY

const DUPLICATE_EVERY = parseInt(__ENV.SI_03_DUPLICATE_EVERY) || 5;

function deriveWebhookId(jobIndex) {
  const groupSize = DUPLICATE_EVERY + 1;  // 6 jobs per group
  const groupIndex = Math.floor(jobIndex / groupSize);
  const offsetInGroup = jobIndex % groupSize;

  let uniqueEventIndex;
  if (offsetInGroup === DUPLICATE_EVERY) {
    // Vị trí cuối trong group → duplicate của unique cuối
    uniqueEventIndex = groupIndex * DUPLICATE_EVERY + (DUPLICATE_EVERY - 1);
  } else {
    // Unique event bình thường
    uniqueEventIndex = groupIndex * DUPLICATE_EVERY + offsetInGroup;
  }

  return `evt-${String(uniqueEventIndex).padStart(3, "0")}`;
}
```

Bảng ánh xạ đầy đủ cho 100 jobs:

```text
Với DUPLICATE_EVERY=5, groupSize=6:
  Số group đầy đủ: floor(100/6) = 16 group (96 jobs)
  Số job dư: 100 - 96 = 4 jobs
  Số duplicate: 16 (từ 16 group đầy đủ)
  Số unique event: 84

Kiểm tra: 84 unique + 16 duplicate = 100 jobs ✓
```

Pattern check duplicate trong script:

```js
function isDuplicateJob(jobIndex) {
  const groupSize = DUPLICATE_EVERY + 1;
  return (jobIndex % groupSize) === DUPLICATE_EVERY;
}
```

---

## Yêu cầu cứng của case này

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Tổng completed iterations phải bằng `100` | Vì `100` là kích thước backlog, thiếu 1 job là coverage incomplete. |
| `shared_jobs_total == 100` | Iteration chạy xong chưa đủ; job phải được mark hoàn tất end-to-end. |
| `shared_jobs_failed == 0` | Có failed job nghĩa là business contract không đạt. |
| `http_reqs/shared_api_calls_total == 100 × 1 = 100` | Mỗi job phải gọi đúng số API trong flow. |
| Operation counts phải khớp expected breakdown | Tổng HTTP đúng nhưng thiếu một operation vẫn là coverage bug. |
| Job identity phải derive từ `exec.scenario.iterationInTest` | Worker identity `__VU` không đại diện cho business job. |
| Uneven per-VU distribution is normal | Worker nhanh xử lý nhiều job hơn là đúng mô hình shared pool. |
| Duplicate jobs phải có `X-Webhook-Id` trùng với event gốc theo schedule | Nếu duplicate sai schedule, idempotency path không được test đúng. |
| Duplicate KHÔNG được gây `shared_jobs_failed > 0` | Duplicate là normal, server phải xử lý an toàn. |

Nếu một trong các invariant về count/job fail, kết quả nên coi là **invalid hoặc fail**, không phải "pass nhưng hơi thiếu".

## Vì sao "payment webhook backlog drain" nên dùng `shared-iterations`?

Mental model đúng:

```text
100 jobs đang nằm trong một queue/backlog.
10 VUs là 10 workers.
Worker nào rảnh thì lấy job kế tiếp.
Batch kết thúc khi queue hết job.
```

Nếu worker A xử lý 20 job còn worker B xử lý 8 job, điều đó không làm test sai. Nó chỉ nói worker A nhận được nhiều job hơn vì vòng lặp của nó quay lại sớm hơn.

### Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho fixed backlog? |
| --- | --- | --- |
| `shared-iterations` | Có tổng `iterations` chung và nhiều VU cùng chạy | **Đúng**: mô hình đúng là N job trong backlog, M worker xử lý đến khi hết việc. |
| `per-vu-iterations` | Count cũng deterministic | Sai nếu VU không phải business identity. Nó ép mỗi VU làm quota bằng nhau, không giống worker queue. |
| `constant-vus` | Nhìn giống worker pool | Sai khi cần exact count: tổng việc phụ thuộc duration và latency, không bảo đảm xử lý đúng N job. |
| `constant-arrival-rate` | Kiểm soát được tốc độ vào | Sai cho batch drain: nó schedule arrivals theo rate, có thể drop, không phải danh sách job cố định cần xử lý hết. |
| `ramping-vus` | Có thể tăng/giảm worker | Sai nếu mục tiêu là exact backlog completion; shape VU biến thiên làm khó so sánh coverage. |
| `ramping-arrival-rate` | Mô phỏng traffic thay đổi | Sai cho fixed-job coverage; phù hợp traffic surge hơn là batch/checklist. |

Kết luận:

```text
Cần exact total backlog coverage -> shared-iterations.
Không cần mỗi VU có quota riêng -> không dùng per-vu-iterations.
Không lấy duration/rate làm input chính -> không dùng constant-vus/arrival-rate.
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

| Config/env | Giá trị | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `SI_03_VUS` | 10 | Số worker cùng xử lý backlog |
| `SI_03_JOBS` | 100 | Tổng số job toàn scenario |
| `SI_03_DUPLICATE_EVERY` | 5 | Cứ 5 unique event có 1 duplicate (at-least-once simulation) |
| `maxDuration` | 10m | Safety cap, không phải target duration |
| `executor` | `shared-iterations` | Fixed global backlog + worker pool |

Mapping quan trọng:

```text
business backlog size = 100 jobs
k6 iterations         = 100
worker pool size      = 10 VUs
duplicate schedule    = mỗi 5 unique event → 1 duplicate
expected unique events ≈ 84 (với DUPLICATE_EVERY=5, 100 jobs)
expected API calls    = 100 × 1 = 100
```

`maxDuration` chỉ là safety cap. Nếu cap này cắt run làm `iterations < 100`, kết quả không valid vì backlog chưa drain hết.

Operation coverage expected:

```text
payment_webhook_process: 100
```

## Technical semantics: shared backlog, worker pool, job identity

Cách k6 vận hành nên được hiểu như sau:

```text
1. Scenario có một global quota: iterations = 100.
2. Mỗi VU là worker, không phải user/business entity.
3. VU lấy global iteration/job kế tiếp từ pool chung.
4. VU nhanh có thể lấy thêm nhiều job.
5. Scenario kết thúc khi global quota hết hoặc bị maxDuration/interruption cắt.
```

Do đó:

```text
__VU is worker, not business identity
__ITER is per-worker local counter, not global job id
exec.scenario.iterationInTest is the stable global job index
iterations is total jobs
uneven per-VU distribution is normal
```

### Identity model chi tiết: `__VU` vs `__ITER` vs `iterationInTest` — và thêm `webhook_id`

Đây là điểm quan trọng nhất khi code shared-iterations script, đặc biệt với case có duplicate schedule. Bốn khái niệm khác nhau:

```text
__VU:
  - Worker ID, từ 1 đến vus
  - VU=1 có thể chạy iter #0, #3, #7, #12... (nhiều job khác nhau)
  - KHÔNG dùng làm webhook event ID, order ID

__ITER:
  - Local counter của từng VU, bắt đầu từ 0
  - VU=1: __ITER=0 → iter #0, __ITER=1 → iter #3, __ITER=2 → iter #7...
  - KHÔNG phải global job index
  - VU=1 __ITER=4 và VU=2 __ITER=4 là 2 job KHÁC NHAU

exec.scenario.iterationInTest:
  - Global job index, từ 0 đến iterations-1
  - DUY NHẤT cho mỗi iteration trong toàn scenario
  - Dùng làm INPUT để derive webhook event ID
  - NHƯNG: không phải cứ iterationInTest=i thì event ID = i
    Vì duplicate schedule làm nhiều iteration map vào cùng event

webhook_id (derived):
  - Business event identity, derive từ iterationInTest + DUPLICATE_EVERY
  - Gửi trong header X-Webhook-Id
  - Server dùng để idempotency check
  - Có thể trùng giữa các iteration (khi duplicate schedule yêu cầu)
```

**Demo trace identity model với 4 VU, 18 iter, DUPLICATE_EVERY=5**:

```text
Config: vus=4, iterations=18, DUPLICATE_EVERY=5

t=0.0s   VU=1: __VU=1, __ITER=0, iterationInTest=0  -> webhook_id="evt-000"
         VU=2: __VU=2, __ITER=0, iterationInTest=1  -> webhook_id="evt-001"
         VU=3: __VU=3, __ITER=0, iterationInTest=2  -> webhook_id="evt-002"
         VU=4: __VU=4, __ITER=0, iterationInTest=3  -> webhook_id="evt-003"

t=0.3s   VU=1 xong, lấy tiếp:
         VU=1: __VU=1, __ITER=1, iterationInTest=4  -> webhook_id="evt-004"

t=0.5s   VU=2 xong, lấy tiếp:
         VU=2: __VU=2, __ITER=1, iterationInTest=5  -> webhook_id="evt-004" (DUPLICATE!)

t=0.6s   VU=1 xong, lấy tiếp:
         VU=1: __VU=1, __ITER=2, iterationInTest=6  -> webhook_id="evt-005"

... tiếp tục đến iterationInTest=17

Tổng kết:
  VU=1 (nhanh): __ITER=0..6 (7 jobs)
  VU=2 (vừa):   __ITER=0..3 (4 jobs)
  VU=3 (vừa):   __ITER=0..3 (4 jobs)
  VU=4 (chậm):  __ITER=0..2 (3 jobs)
  Total: 7+4+4+3 = 18 jobs ✓
  Unique webhook events: ~15 (với 3 duplicate ở iter 5, 11, 17)

Code đúng:
  const jobIndex = exec.scenario.iterationInTest;  // 0..17
  const webhookId = deriveWebhookId(jobIndex);     // "evt-000".."evt-014"
  // Gửi POST với X-Webhook-Id: webhookId
  // iter #5 có webhookId = "evt-004" (trùng với iter #4) ✓

Code sai:
  const webhookId = `evt-${String(__VU).padStart(3, "0")}`;
  // VU=1 -> "evt-001", VU=2 -> "evt-002", ...
  // Chỉ 4 event được gửi, không có duplicate, 14 event bỏ sót ❌
```

### Code pattern đúng cho shared-iterations với duplicate schedule

```js
import exec from "k6/execution";
import { check } from "k6";
import http from "k6/http";

const DUPLICATE_EVERY = parseInt(__ENV.SI_03_DUPLICATE_EVERY) || 5;

function deriveWebhookId(jobIndex) {
  const groupSize = DUPLICATE_EVERY + 1;
  const groupIndex = Math.floor(jobIndex / groupSize);
  const offsetInGroup = jobIndex % groupSize;

  let uniqueEventIndex;
  if (offsetInGroup === DUPLICATE_EVERY) {
    // Duplicate job — reuse previous unique event's ID
    uniqueEventIndex = groupIndex * DUPLICATE_EVERY + (DUPLICATE_EVERY - 1);
  } else {
    uniqueEventIndex = groupIndex * DUPLICATE_EVERY + offsetInGroup;
  }

  return `evt-${String(uniqueEventIndex).padStart(3, "0")}`;
}

function isDuplicateJob(jobIndex) {
  return (jobIndex % (DUPLICATE_EVERY + 1)) === DUPLICATE_EVERY;
}

export default function () {
  // Lấy global job index — ĐÂY LÀ DÒNG QUAN TRỌNG NHẤT
  const jobIndex = exec.scenario.iterationInTest;  // 0..99

  // Derive webhook event ID từ job index + duplicate schedule
  const webhookId = deriveWebhookId(jobIndex);
  const isDuplicate = isDuplicateJob(jobIndex);

  // POST webhook với X-Webhook-Id
  const res = http.post(
    `${BASE_URL}/api/sim/orders/webhooks/payment?cpu_ms=1&db_writes=2&claim_ttl_ms=4000`,
    JSON.stringify({
      webhook_id: webhookId,
      order_id: `ORD-${webhookId.split("-")[1]}`,
      amount: 50000,
      status: "paid",
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Id": webhookId,  // ← KEY: idempotency key
      },
      tags: {
        operation: "payment_webhook_process",
        is_duplicate: isDuplicate ? "yes" : "no",
        job_id: String(jobIndex),
      },
    }
  );

  // Check: với duplicate, 200 hoặc 409 đều OK
  check(res, {
    "webhook accepted (200 or 409)": (r) =>
      r.status === 200 || r.status === 409,
  });
}
```

**KHÔNG viết thế này**:

```js
// SAI — dùng __VU làm event identity
const webhookId = `evt-${String(__VU).padStart(3, "0")}`;
// Chỉ 10 event được gửi, lặp đi lặp lại, không có duplicate schedule

// SAI — dùng __ITER làm event identity
const webhookId = `evt-${String(__ITER).padStart(3, "0")}`;
// VU=1 __ITER=4 và VU=2 __ITER=4 trùng webhook_id

// SAI — không có duplicate schedule
const webhookId = `evt-${String(exec.scenario.iterationInTest).padStart(3, "0")}`;
// 100 unique events, 0 duplicate → idempotency path không được test
```

### Vì sao KHÔNG có per-VU state như per-vu-iterations?

Trong per-vu-iterations, mỗi VU có state riêng (session, token, cart) sống qua nhiều iteration vì cùng VU luôn chạy iter cho cùng identity.

Trong shared-iterations, **không có per-VU persistent state hữu ích** vì:

```text
VU=1 chạy job #0 (event "evt-000"), xong chạy job #4 (event "evt-004"), xong chạy job #6 (event "evt-005")...
→ Mỗi job là một webhook event khác nhau
→ State của job #0 không dùng được cho job #4
→ Không cần giữ session/token/claim giữa các iter trong cùng VU
```

Nếu script cần state (vd: auth token), dùng `setup()` hoặc tạo token mới mỗi iteration:

```js
export function setup() {
  // Token dùng chung cho toàn test
  return { token: login() };
}

export default function (data) {
  // Dùng token từ setup, KHÔNG lưu per-VU state
  const headers = { Authorization: `Bearer ${data.token}` };
  // ...
}
```

## Service/API flow

| Operation | Method | Path | Service | Expected | Expected count | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| payment_webhook_process | `POST` | `/api/sim/orders/webhooks/payment?cpu_ms=1&db_writes=2&claim_ttl_ms=4000` | order-service | `200` | 100 | Process payment event với `X-Webhook-Id`. |

Một job chỉ được coi là hoàn tất khi các operation cần thiết của job đó đã pass theo contract.

Giải thích query params của endpoint:

```text
cpu_ms=1:         mỗi request tiêu tốn ~1ms CPU (nhẹ)
db_writes=2:      mỗi request ghi 2 DB rows (idempotency record + order update)
claim_ttl_ms=4000: claim lock tồn tại 4 giây, sau đó hết hạn
                   → duplicate trong 4s: claim vẫn còn → 409 idempotent reject
                   → duplicate sau 4s: claim đã hết hạn → có thể process lại (race risk)
```

## Metrics và tags cần đọc

| Metric | Type | Expected | Nó chứng minh gì? |
| --- | --- | --- | --- |
| `shared_jobs_total` | Counter | `count == JOBS` | Bao nhiêu business job đã hoàn tất end-to-end. |
| `shared_jobs_failed` | Counter | `count == 0` | Có job nào fail ở tầng business không. |
| `shared_api_calls_total` | Counter | khớp công thức API/job | Helper đã gửi đúng số API calls theo flow chưa. |
| `shared_job_duration_ms` | Trend | `count == JOBS` | Thời gian end-to-end của từng job, không chỉ từng request. |
| `shared_sleep_seconds` | Counter | tùy case | Tổng sleep/think/wait time nếu script mô phỏng delay. |

Tags chung:

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `si-03-payment-webhook-drain`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service đang được gọi. |
| `operation` | Bước nghiệp vụ/API cụ thể trong job. |
| `endpoint` | Nhóm endpoint/API family. |
| `job_id` | Business job trong backlog, derive từ global job index. |
| `executor_family` | `shared_iterations`. |
| `workload_shape` | `fixed_backlog`. |

Tags case này:

```text
case_id        = si-03-payment-webhook-drain
business_case  = payment_webhook_backlog_drain
service        = order-service
is_duplicate   = yes/no (tag thêm cho case 03 để lọc duplicate path)
```

## Pass criteria

Pass criteria tối thiểu:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 100
shared_jobs_failed count == 0
iterations count == 100
http_reqs count == 100
shared_api_calls_total count == 100
```

Operation breakdown phải khớp:

```text
payment_webhook_process: 100
```

Duplicate-specific pass criteria:

```text
Số duplicate job = floor(100 / (DUPLICATE_EVERY + 1)) = floor(100/6) = 16
→ 16 job có is_duplicate=yes
→ Tất cả 16 duplicate job phải có status 200 hoặc 409 (idempotent accept)
→ shared_jobs_failed KHÔNG được tăng vì duplicate
→ http_req_failed KHÔNG được tăng ở bucket duplicate
```

Claim TTL safety check:

```text
shared_job_duration_ms p95 < claim_ttl_ms
→ Nếu p95 > 4000ms: nguy cơ claim hết hạn trước khi job xong
→ Cần tăng claim_ttl_ms hoặc tối ưu job duration
```

Đừng thêm pass condition kiểu:

```text
mỗi VU phải xử lý 100 / 10 jobs
```

Vì đó không phải invariant của `shared-iterations`.

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-03-payment-webhook-drain.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-03-payment-webhook-drain.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-03-payment-webhook-drain.js
```

Override duplicate schedule:

```powershell
$env:SI_03_DUPLICATE_EVERY = 3
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-03-payment-webhook-drain.js
```

Nếu backend script chưa có trong working tree, chỉ đọc phần expected formula trước; không tự điền run data.

## Đọc output summary

Áp 5 bước giống cách đọc các case per-vu, nhưng invariant đổi sang **total backlog**, không phải per-user quota.

### Bước 1 — Verify scenario/config

Header phải thể hiện:

```text
executor = shared-iterations
vus = 10 hoặc env override
total iterations/jobs = 100 hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ expected counts.

### Bước 2 — Compute expected total jobs

Default case này:

```text
JOBS = 100
API_PER_JOB = 1
DUPLICATE_EVERY = 5
expected iterations = 100
expected http_reqs = 100 × 1 = 100
expected duplicate jobs = floor(100 / (DUPLICATE_EVERY + 1)) = floor(100/6) = 16
expected unique events ≈ 84
```

### Bước 3 — Compare summary counters

Expected:

```text
iterations == 100
shared_jobs_total == 100
shared_jobs_failed == 0
```

Nếu `iterations < 100`:

```text
backlog chưa drain hết -> invalid result
→ maxDuration cắt? Tăng maxDuration.
→ iter_time quá dài? Giảm workload hoặc tăng vus.
→ Claim TTL contention làm chậm? Tăng claim_ttl_ms hoặc giảm DUPLICATE_EVERY.
```

Nếu `iterations == 100` nhưng `shared_jobs_total < 100`:

```text
iteration chạy xong nhưng job completion instrumentation/business branch bị thiếu
→ Kiểm script: có gọi jobDone() sau mỗi iteration không?
→ Có exception/early return nào bỏ qua job completion không?
→ Đặc biệt: duplicate job có bị bỏ qua jobDone() vì 409 response không?
```

### Bước 4 — Compare API and operation counts

Expected:

```text
http_reqs == 100
shared_api_calls_total == 100
payment_webhook_process: 100
```

Tổng HTTP đúng nhưng operation split sai vẫn là coverage bug:

```text
VD: http_reqs = 100, nhưng:
  payment_webhook_process: 90
  (thêm operation khác không mong đợi): 10
→ Script có thể gọi thêm API không nằm trong flow
→ Hoặc tag operation bị sai ở một số request
```

### Bước 5 — Interpret duration/throughput

`shared_job_duration_ms` trả lời:

```text
một business job end-to-end mất bao lâu
```

`http_req_duration` trả lời:

```text
mỗi request/API call mất bao lâu
```

Hai metric này khác nhau. Job nhiều API có thể có từng request nhanh nhưng full lifecycle vẫn chậm.

Case-specific summary notes:

- `iterations = 100` chứng minh 100 webhook jobs được attempt/complete.
- `http_reqs = 100` vì mỗi webhook job có một POST.
- Duplicate expected vẫn nên pass nếu BE contract là accept/ignore idempotent.
- So sánh `shared_job_duration_ms` giữa `is_duplicate=yes` và `is_duplicate=no`:
  - Nếu duplicate nhanh hơn nhiều (claim đã tồn tại → reject nhanh): bình thường
  - Nếu duplicate chậm hơn (claim contention): cần điều tra
- So sánh `shared_job_duration_ms p95` với `claim_ttl_ms=4000`: nếu p95 > 4000, nguy cơ claim hết hạn.

Không check mỗi VU làm bằng nhau. Invariant là total completed work, không phải equal work per VU.

## Đọc dashboard real-time charts cho case 03

> Phần này mô tả expected reading pattern. Chỉ bổ sung run ID, p95/p99/max, bucket arrays sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? bucket nào có tail latency? duplicate bucket có spike không? | Backlog đã xử lý đủ chưa |
| Execution timeline | Theo thời gian đã hoàn tất bao nhiêu iterations/http_reqs/jobs? | Mỗi VU có làm bằng nhau không |
| VUs vs iter/s | Worker pool drain backlog nhanh/chậm ra sao? | Business correctness của từng job (nhất là duplicate) |

Một cách đọc nhanh:

```text
Response time      -> chất lượng request, phát hiện bottleneck (đặc biệt claim TTL contention)
Execution timeline -> backlog drain progress, phát hiện thiếu coverage
VUs vs iter/s      -> worker pool shape, phát hiện bất thường throughput
```

### Chart 1 — Response time

Đây là request-level latency. Với case này, chỉ có 1 operation:

```text
payment_webhook_process: 100
```

Nhưng nên tách thêm theo tag `is_duplicate` để so sánh:

```text
payment_webhook_process (is_duplicate=no):  ~84 requests
payment_webhook_process (is_duplicate=yes): ~16 requests
```

Cách đọc:

```text
avg  -> request thường nhanh/chậm thế nào
p95  -> phần lớn request có tail tới đâu
p99  -> tail hiếm hơn
max  -> spike lớn nhất trong bucket/run
```

Nhưng đừng kết luận pass/fail chỉ từ latency. Response time chỉ giúp tìm bottleneck.

#### Cách phân tích sâu chart Response time cho case 03

Khi nhìn chart này, đừng chỉ nhìn "cao/thấp". Hãy đọc theo 5 câu hỏi:

```text
1. Avg response có ổn định không?
2. Batch p95 có spike ở đoạn nào?
3. Batch max có outlier lớn không?
4. Latency spike có trùng với bucket có nhiều duplicate không?
5. p95 có vượt claim_ttl_ms (4000ms) không?
```

Với case 03, shape đẹp thường có:

```text
đầu run:  p95/max có thể cao hơn (cold start, request đầu, claim table empty)
giữa run: p95 ổn định thấp hơn
cuối run: p95 không tăng bất thường
duplicate buckets: p95 THẤP HƠN unique buckets (vì chỉ cần check claim, không process)
```

Vì sao duplicate thường nhanh hơn?

```text
- Unique request: server phải INSERT claim record + process payment (DB writes=2)
- Duplicate request: server chỉ check claim → đã tồn tại → reject ngay
  → latency thấp hơn vì bỏ qua bước process payment
  → Đây là TÍN HIỆU TỐT: idempotency hoạt động đúng
```

Case-specific bottleneck hints:

- Latency spike ở unique buckets: order-service process payment chậm (DB write, validation).
- Latency spike ở duplicate buckets: claim lookup chậm (DB index thiếu, claim table lớn).
- Nếu duplicate p95 = unique p95: server vẫn process payment dù có claim → idempotency bug!
- Nếu `http_req_failed` tăng ở duplicate buckets: server trả 500 khi gặp duplicate → bug.
- Nếu p95 > 4000ms (claim_ttl_ms): nguy cơ claim hết hạn → race condition → double-process.

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 cao ngay từ đầu rồi ổn định | cold start, claim table empty | kiểm order-service warm-up |
| p95 tăng dần càng về cuối | claim table phình, lock contention tăng | soi job_duration theo job_id |
| max spike lẻ tẻ nhưng p95 ổn | vài outlier đơn lẻ (DB backup, GC) | xem log nhưng chưa vội fail |
| p95 và max cùng spike nhiều bucket | vấn đề hệ thống thật | chặn / điều tra backend |
| duplicate p95 >> unique p95 | claim lookup chậm hơn process | kiểm idempotency table index |
| duplicate p95 ≈ unique p95 | duplicate vẫn bị process (không idempotent) | BLOCK — idempotency bug |
| p95 > 4000ms ở bất kỳ bucket nào | nguy cơ claim hết hạn | tăng claim_ttl_ms hoặc điều tra |

### Chart 2 — Execution timeline

Chart này chứng minh backlog drain đủ theo thời gian.

Kiểm tổng bucket:

```text
sum(iterations buckets) == 100
sum(http_reqs buckets) == 100
sum(shared_jobs_total buckets) == 100
sum(shared_jobs_failed buckets) == 0
```

#### Cách phân tích sâu chart Execution timeline

Chart này trả lời câu hỏi khác hẳn Response time:

```text
Response time chart:
  "request nhanh/chậm thế nào?"

Execution timeline:
  "tại mỗi giây, test đã xử lý bao nhiêu job? bao nhiêu VU còn chạy?"
```

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs — còn bao nhiêu worker đang active?
2. HTTP reqs mỗi bucket — bao nhiêu request hoàn thành trong giây đó?
3. Iterations hoàn thành mỗi bucket — bao nhiêu job xong trong giây đó?
```

Với `shared-iterations`, shape "đẹp" thường là:

```text
đầu run:
  Live VUs = config VUs (10)
  RPS cao vì tất cả VU cùng hoạt động

giữa run:
  Live VUs vẫn gần 10 nếu backlog còn nhiều
  iterations tăng đều theo bucket

cuối run:
  Live VUs tụt xuống vì backlog gần hết
  iteration cũng tụt theo
  sau đó VUs = 0 khi toàn bộ quota xong
```

Điểm khác với per-vu-iterations:

```text
per-vu-iterations:
  VU tụt ở cuối vì VU nhanh xong quota RIÊNG -> idle
  VU chậm vẫn chạy -> "đuôi dài" của VU chậm nhất

shared-iterations:
  VU tụt ở cuối vì backlog CHUNG gần hết
  VU nhanh cũng không còn job để lấy -> idle
  Không có "đuôi dài" của 1 VU — khi hết job, tất cả dừng
```

Invalid patterns:

| Pattern | Nghĩa |
| --- | --- |
| `iterations` đủ nhưng `shared_jobs_total` thiếu | iteration complete nhưng business job chưa mark done |
| `http_reqs` đủ nhưng operation split sai | tổng request đủ nhưng coverage lệch |
| `shared_jobs_failed > 0` | business failure dù HTTP có thể vẫn 200 |
| buckets không cộng ra summary | đọc nhầm point/bucket hoặc data chưa final |
| Live VUs không lên đủ 10 từ đầu | VU init có vấn đề, config/env sai |
| Live VUs giữ cao nhưng iterations không tăng | VU bị kẹt trong request, backend chậm |
| `shared_jobs_failed` tăng ở bucket giữa/cuối | có thể do duplicate gây 500 ở claim path |

Đừng nhầm:

```text
Mỗi point = 1 time bucket / metrics frame.
Không phải 1 request.
Không phải 1 job.
```

#### Batch 1 giây / time bucket

Giống như case per-vu-iterations, mỗi point trên chart là 1 time bucket gom tất cả metric samples trong cùng 1 giây:

```text
01:09:19
→ mọi sample có timestamp trong khoảng 01:09:19.000 -> 01:09:19.999
→ được gom vào chung 1 point trên chart
```

Trong 1 bucket đó có thể có:

```text
- 10 VU cùng chạy (mỗi VU đang ở 1 job khác nhau)
- Nhiều HTTP request hoàn thành (cả unique và duplicate)
- Một số iteration/job hoàn thành
- Nhiều check pass/fail
```

Điều kiện để một event rơi vào bucket nào:

```text
event timestamp thuộc giây nào -> rơi vào bucket giây đó
```

#### Vì sao bucket đầu có thể có httpReqs > 0 nhưng iterations = 0?

```text
Bucket đầu: VU vừa start, request đầu đã xong
nhưng full job (HTTP + check + instrumentation) chưa hoàn tất

→ httpReqs > 0 (request-level metric đến sớm)
→ iterations = 0 (job-level metric đến muộn hơn, cần full flow xong)
```

### Chart 3 — VUs vs iter/s

Chart này giải thích worker-pool shape:

```text
- VUs gần 10 khi backlog còn nhiều việc
- iter/s tăng/giảm theo latency và số API/job
- VUs có thể tụt ở tail khi backlog gần hết
- fast VUs có thể xử lý nhiều job hơn slow VUs
```

#### Cách phân tích sâu chart VUs vs iter/s

Chart này trả lời câu hỏi:

```text
Worker pool drain backlog nhanh/chậm ra sao?
Throughput iteration có bám theo shape VU không?
```

Với `shared-iterations`, đường `Executor VUs` và `Actual iter/s` có quan hệ:

```text
peak_rate ≈ vus / iter_time
         ≈ 10 / iter_time

Nếu iter_time avg = 0.35s:
  peak_rate ≈ 10 / 0.35 ≈ 28.6 iter/s

Nếu iter_time avg = 0.70s (claim TTL contention):
  peak_rate ≈ 10 / 0.70 ≈ 14.3 iter/s
```

Đừng đọc chart này thành:

```text
mỗi VU phải xử lý 100 / 10 jobs
```

Với `shared-iterations`, đó là yêu cầu sai.

Shape mong đợi:

```text
- đầu run: iter/s có thể 0 (chưa job nào xong)
- giữa run: iter/s dao động theo batch hoàn thành
- cuối run: iter/s tụt khi backlog gần hết, rồi về 0
- đường VUs: gần 10 ở đầu/giữa, tụt ở cuối
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| `Actual iter/s` đầu = 0, sau đó tăng | job đầu chưa hoàn tất | bình thường |
| `Actual iter/s` dao động theo bucket | nhiều job finish không cùng thời điểm | bình thường |
| `Actual iter/s` = 0 lâu trong khi VUs cao | VU bị kẹt trong request, backend chậm | cần điều tra |
| `Actual iter/s` tụt về 0 và VUs cũng về 0 | test xong quota | bình thường |
| sum `Actual iter/s` < expected total | thiếu iteration / drop / interrupt | test invalid |
| VUs không lên tới 10 | config/env sai, VU init lỗi | kiểm header |
| `Actual iter/s` spike rồi tụt đột ngột | claim TTL contention làm nghẽn worker | điều tra idempotency path |
| `Actual iter/s` thấp hơn dự kiến nhiều | mỗi request chậm hơn expected (claim TTL wait, DB lock) | kiểm order-service performance |

### Cách chốt từ summary -> 3 chart

```text
1. Summary quyết định pass/fail bằng counters/thresholds.
2. Execution timeline xác nhận backlog drain đủ theo thời gian.
3. Response time tìm operation/service chậm + claim TTL contention.
4. VUs vs iter/s giải thích worker pool hoạt động ra sao.
5. Business decision dựa trên total coverage + failed jobs + duplicate safety.
```

## Kết luận thực tế: output -> quyết định

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **webhook drain safety gate**: output ra số như vậy thì team quyết định gì với webhook handling?

### Kịch bản A — output sạch: WEBHOOK DRAIN PASS

```text
iterations.........: 100           (đủ backlog)
http_req_failed....: 0.00%
shared_jobs_total..: 100
shared_jobs_failed.: 0
payment_webhook_process: 100
iteration_duration.: p(95)=0.45s
duplicate p95......: 0.05s          (nhanh hơn unique, đúng!)
```

Kết luận thực tế:

```text
- Count đủ 100 -> toàn bộ webhook events đã được drain (yêu cầu a)
- 0 fail, 0 job failed -> không event nào lỗi, kể cả duplicate
- Operation breakdown đúng 100/100 -> coverage đủ
- p95 0.45s < claim_ttl_ms 4s -> claim TTL an toàn
- duplicate p95 << unique p95 -> idempotency hoạt động đúng
=> QUYẾT ĐỊNH: webhook handler OK. Cho phép deploy/release.
   Idempotency path đã được verify an toàn.
```

### Kịch bản B — duplicate gây failed job: BLOCK

```text
iterations.........: 100           (vẫn đủ!)
shared_jobs_total..: 100
shared_jobs_failed.: 16            ← CÓ 16 JOB FAIL!
payment_webhook_process: 100
http_req_failed....: 16/100 = 16%
is_duplicate=yes failed: 16/16     ← TẤT CẢ duplicate fail!
```

Kết luận thực tế:

```text
- Count vẫn 100 -> KHÔNG phải lỗi test, coverage attempt đủ
- Nhưng 16 job failed -> TẤT CẢ là duplicate
- Server không xử lý được duplicate event
- Có thể: server trả 500 khi gặp X-Webhook-Id đã tồn tại
- Hoặc: claim lock implementation lỗi → crash
=> QUYẾT ĐỊNH: BLOCK deploy. Idempotency path bị lỗi.
   Production sẽ fail khi payment gateway retry webhook.
   Đây CHÍNH LÀ giá trị của case 03: duplicate schedule phát hiện
   bug idempotency mà test không có duplicate sẽ bỏ qua.
```

### Kịch bản C — thiếu iteration: TEST INVALID

```text
iterations.........: 72            (THIẾU 28!)
http_req_failed....: 2.1%
interrupted........: 28
```

Kết luận thực tế:

```text
- 72 < 100 -> backlog chưa drain hết -> KHÔNG kết luận được webhook handling có OK không
- Trước khi nói gì về webhook, phải sửa cho test chạy đủ 100 đã:
    interrupted=28 -> maxDuration quá ngắn? Tăng maxDuration.
    Hoặc iter_time quá dài? Giảm workload hoặc tăng vus.
    Hoặc claim TTL contention làm chậm toàn bộ pipeline?
=> QUYẾT ĐỊNH: CHƯA kết luận webhook handler pass/fail. Test invalid, chạy lại
   sau khi sửa nguyên nhân thiếu count.
```

### Kịch bản D — claim TTL contention spike: INVESTIGATE

```text
iterations.........: 100
shared_jobs_total..: 100
shared_jobs_failed.: 0             ← không fail, nhưng...
iteration_duration.: p(95)=5.2s    ← CAO! vượt claim_ttl_ms=4s
duplicate p95......: 4.8s           ← duplicate cũng chậm bất thường
http_req_duration..: p(95)=5.0s
```

Kết luận thực tế:

```text
- Count đủ, không fail -> functional PASS
- NHƯNG: p95 = 5.2s > claim_ttl_ms = 4s
- Có nghĩa: 5% job mất > 5s, trong khi claim hết hạn sau 4s
- Nguy cơ: claim hết hạn trước khi job xong → double-process
- duplicate p95 cao bất thường → claim lookup cũng chậm
=> QUYẾT ĐỊNH: Functional pass nhưng KHÔNG AN TOÀN.
   Tăng claim_ttl_ms lên ít nhất 10s HOẶC tối ưu order-service latency.
   Đây là tình huống nguy hiểm: test "pass" nhưng production
   vẫn có thể double-process khi claim hết hạn.
```

### Bảng ánh xạ nhanh output -> hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 100 iter, 100 webhook calls, 0 fail, duplicate OK | webhook drain hoàn tất, idempotency an toàn | cho phép deploy |
| 100 iter, shared_jobs_failed > 0 ở duplicate | idempotency bug ở duplicate path | block, sửa idempotency implementation |
| 100 iter, http_req_failed tăng ở bucket duplicate | server lỗi khi gặp duplicate | block, kiểm claim lock path |
| < 100 iter (drop/interrupt) | test chưa hợp lệ, backlog chưa drain hết | sửa config, chạy lại |
| Counts pass nhưng p95 > claim_ttl_ms | functional pass, claim TTL risk | tăng claim_ttl_ms hoặc tối ưu latency |
| duplicate p95 ≈ unique p95 | idempotency không hoạt động (vẫn process lại) | block — double-process risk |
| duplicate p95 >> unique p95 | claim lookup chậm hơn process | kiểm idempotency table index |
| 100 iter nhưng 0 duplicate (is_duplicate=no hết) | script không implement duplicate schedule | sửa script, chạy lại |
| VU distribution uneven | normal worker-pool behavior | do not fail |

Điểm cốt lõi của case này: **vì count luôn cố định 100, duplicate schedule luôn cố định, mọi failed job ở duplicate path đều là tín hiệu THẬT về idempotency bug. Test không có duplicate sẽ bỏ qua hoàn toàn bug này, và production sẽ gặp double-processing khi payment gateway retry.**

## "Nghịch lý" và misconceptions của webhook drain với shared-iterations

### Nghịch lý 1: 100 jobs nhưng chỉ ~84 unique events?

```text
Config: iterations=100, DUPLICATE_EVERY=5
→ 100 jobs được chạy
→ Nhưng chỉ ~84 unique X-Webhook-Id được gửi
→ ~16 jobs là duplicate, dùng lại webhook_id của job trước đó

Sao 100 jobs mà không phải 100 unique events?
  Vì DUPLICATE_EVERY=5 mô phỏng at-least-once delivery:
    - Payment gateway thực tế có thể gửi lại event
    - Mỗi group 6 jobs: 5 unique + 1 duplicate
    - 100 / 6 = 16 group dư 4 → 16 duplicate

Đây KHÔNG phải bug. Đây là FEATURE của test:
  - Mô phỏng đúng behavior của payment gateway
  - Test idempotency path mà test thường bỏ qua
  - Nếu không có duplicate, test không có giá trị cho webhook drain

Check: 84 unique + 16 duplicate = 100 jobs ✓
Check: server xử lý đúng 84 unique events (không double-process) ✓
Check: server idempotent reject 16 duplicate events ✓
```

### Nghịch lý 2: single operation nhưng job_duration không đều?

```text
Case này chỉ có 1 operation (payment_webhook_process)
→ Tưởng rằng job_duration sẽ rất đều (mỗi job giống hệt nhau)
→ Nhưng thực tế job_duration BIẾN THIÊN vì:

1. Unique vs duplicate path:
   - Unique job: server INSERT claim + process payment (chậm hơn)
   - Duplicate job: server chỉ check claim → reject (nhanh hơn)
   → Cùng 1 operation nhưng duration khác nhau rõ rệt
   → duplicate thường nhanh hơn 5-10 lần

2. Claim TTL contention:
   - Khi nhiều worker cùng claim (duplicate đến gần nhau)
   - Claim table có lock contention → latency spike
   - job_duration có thể tăng ở bucket có nhiều duplicate

3. DB write variation:
   - db_writes=2 nhưng thời gian write phụ thuộc DB state
   - Idempotency record insert có thể chậm nếu bảng lớn
   - Order update có thể chậm nếu có lock row

→ Đừng kỳ vọng job_duration đều.
→ Sự KHÔNG ĐỀU của job_duration mới là tín hiệu:
  - duplicate nhanh hơn → idempotency OK
  - duplicate chậm bất thường → claim contention
  - p95 > claim_ttl_ms → nguy hiểm
```

### Nghịch lý 3: Tổng http_reqs = 100 nhưng shared_jobs_total chỉ = 98?

```text
http_reqs = 100 -> 100 HTTP requests đã hoàn thành
shared_jobs_total = 98 -> nhưng chỉ 98 job được mark complete

2 job (2 HTTP requests) đã chạy xong HTTP, nhưng job không được mark done.
→ Có thể do: exception sau HTTP request, check fail, hoặc code branch
   bỏ qua job completion instrumentation.
→ Đặc biệt với duplicate: nếu check chỉ cho phép status 200,
   nhưng server trả 409 cho duplicate → check fail → job không done

Cách debug:
  - Kiểm script: check có chấp nhận 409 cho duplicate không?
  - Kiểm shared_jobs_failed: 2 job đó có bị mark failed không?
  - Nếu duplicate job bị check fail vì status 409 → sửa check
    thành (r) => r.status === 200 || r.status === 409
```

### Nghịch lý 4: VU=10, jobs=100, sao duplicate schedule vẫn giữ được thứ tự?

```text
Với shared-iterations, không có guarantee về thứ tự job:
  - Job #4 và job #5 có thể được 2 VU khác nhau xử lý
  - Hoặc cùng 1 VU xử lý
  - Thứ tự thời gian không được đảm bảo

NHƯNG: điều này KHÔNG ảnh hưởng tới duplicate test vì:
  - Mỗi job gửi X-Webhook-Id ĐỘC LẬP
  - Server idempotency check dựa trên X-Webhook-Id, không phải thứ tự
  - Dù job #5 đến trước job #4: server vẫn process #5 (chưa có claim)
    rồi reject #4 (đã có claim) → vẫn OK
  - Dù cả 2 đến cùng lúc: claim lock đảm bảo chỉ 1 worker process

→ Thứ tự job KHÔNG quan trọng với idempotency.
→ Điều quan trọng là X-Webhook-Id TRÙNG theo schedule.
→ Shared-iterations worker pool không phá vỡ idempotency test.
```

## Checklist đọc biểu đồ case 03

Khi học sinh nhìn dashboard case 03, đọc theo thứ tự này:

```text
1. Overview KPI
   - iterations = 100?
   - http_req_failed = 0%?
   - checks = 100%?
   - shared_jobs_failed = 0?

2. Response time chart
   - Tách theo is_duplicate (yes/no) chưa?
   - duplicate p95 có thấp hơn unique p95 không?
   - batch p95 đầu có spike không?
   - cuối test còn spike không?
   - p95 có vượt claim_ttl_ms (4000ms) không?

3. Execution timeline
   - Live VUs đầu có = 10 không?
   - cuối run VUs có tụt dần về 0 không?
   - sum iterations theo bucket có = 100 không?
   - sum http_reqs theo bucket có = 100 không?
   - sum shared_jobs_total theo bucket có = 100 không?
   - shared_jobs_failed có = 0 ở mọi bucket không?

4. VUs vs iter/s
   - Actual iter/s theo bucket dao động thế nào?
   - sum actual iter/s có = 100 không?
   - VUs có giữ gần 10 ở đầu/giữa run không?
   - Cuối run VUs có tụt về 0 không?

5. Duplicate-specific checks
   - Số job is_duplicate=yes có = 16 không?
   - Tất cả duplicate job có pass check không?
   - duplicate latency có pattern bình thường không (thấp hơn unique)?
   - Có bucket nào duplicate latency spike bất thường không?

6. Business decision
   - Tất cả counters pass?
   - Operation breakdown đúng 100?
   - shared_jobs_failed = 0?
   - Duplicate idempotency path OK?
   - p95 < claim_ttl_ms?
   - Nếu tất cả pass -> webhook drain PASS
```

Kết luận của run case 03 đang đúng nếu thấy:

```text
iterations = 100
http_req_failed = 0%
checks = 100%
shared_jobs_total = 100
shared_jobs_failed = 0
payment_webhook_process = 100
is_duplicate=yes ≈ 16 (với DUPLICATE_EVERY=5)
duplicate p95 << unique p95 (idempotency hoạt động)
p95 < 4000ms (claim TTL an toàn)
Live VUs: đầu = 10, cuối giảm về 0
sum chart iterations = summary iterations
sum chart httpReqs = summary http_reqs
executor = shared-iterations
```

## Mở rộng / variation

### Variation A: Đổi DUPLICATE_EVERY để test tần suất duplicate khác nhau

```powershell
# Mô phỏng payment gateway aggressive retry (nhiều duplicate hơn)
$env:SI_03_DUPLICATE_EVERY = 2
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-03-payment-webhook-drain.js

# Expected: groupSize=3, jobs=100 → 33 duplicate, 67 unique
# Server phải chịu được nhiều duplicate hơn

# Hoặc ít duplicate hơn (production-like)
$env:SI_03_DUPLICATE_EVERY = 10
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-03-payment-webhook-drain.js

# Expected: groupSize=11, jobs=100 → 9 duplicate, 91 unique
```

### Variation B: Thêm retry logic cho 409 response

```js
export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  const webhookId = deriveWebhookId(jobIndex);

  const res = http.post(`${BASE_URL}/api/sim/orders/webhooks/payment?...`, 
    JSON.stringify({ webhook_id: webhookId, ... }),
    { headers: { "X-Webhook-Id": webhookId } }
  );

  // Nếu 409 và là duplicate → retry với backoff
  if (res.status === 409 && isDuplicateJob(jobIndex)) {
    sleep(0.1);
    const retryRes = http.post(`${BASE_URL}/api/sim/orders/webhooks/payment?...`,
      JSON.stringify({ webhook_id: webhookId, ... }),
      { headers: { "X-Webhook-Id": webhookId } }
    );
    check(retryRes, { "retry accepted": (r) => r.status === 200 || r.status === 409 });
  }
}
```

### Variation C: Thêm sleep giữa duplicate và unique để test claim TTL boundary

```js
export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  const webhookId = deriveWebhookId(jobIndex);
  const isDuplicate = isDuplicateJob(jobIndex);

  // Nếu là duplicate, thêm delay để mô phỏng gateway retry delay
  if (isDuplicate) {
    sleep(2.0);  // Gateway retry sau 2 giây
  }

  const res = http.post(`${BASE_URL}/api/sim/orders/webhooks/payment?...`,
    JSON.stringify({ webhook_id: webhookId, ... }),
    { headers: { "X-Webhook-Id": webhookId } }
  );

  check(res, {
    "webhook accepted": (r) => r.status === 200 || r.status === 409,
  });
}
```

Với sleep 2s, duplicate đến sau unique 2s. Claim TTL=4s > 2s → claim vẫn còn → an toàn. Nhưng nếu claim_ttl_ms=1s và sleep=2s → claim hết hạn → nguy cơ double-process.

### Variation D: Multi-scenario — drain webhook + reconcile order state

```js
scenarios: {
  webhook_drain: {
    executor: "shared-iterations",
    vus: 10,
    iterations: 100,
    tags: { case_id: "si-03-payment-webhook-drain" },
  },
  order_reconcile: {
    executor: "shared-iterations",
    vus: 5,
    iterations: 50,
    startTime: "5s",
    tags: { case_id: "si-02-order-reconciliation" },
  },
},
```

### Variation E: Thêm threshold latency theo operation và duplicate tag

```js
export const options = {
  thresholds: {
    "http_req_duration{operation:payment_webhook_process}": ["p(95)<500"],
    "http_req_duration{is_duplicate:yes}": ["p(95)<200"],
    "http_req_duration{is_duplicate:no}": ["p(95)<800"],
    // Đảm bảo job duration không vượt claim TTL
    "shared_job_duration_ms": ["p(95)<3500"],
  },
};
```

Chuyển từ functional batch sang performance gate có claim TTL safety.

### Variation F: Tăng JOBS để mô phỏng backlog production lớn hơn

```powershell
$env:SI_03_JOBS = 500
$env:SI_03_DUPLICATE_EVERY = 5
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-03-payment-webhook-drain.js
```

Nhớ recompute expected: `http_reqs = 500`, `duplicate jobs = floor(500/6) = 83`.

## Anti-pattern

- Dùng `__VU` làm business identity chính cho backlog.
- Fail test chỉ vì VU distribution không đều.
- Dùng `constant-vus` rồi suy ra exact job count từ duration.
- Dùng arrival-rate executor cho bài toán drain fixed queue.
- Chỉ nhìn response time đẹp mà không kiểm `shared_jobs_total` và operation counts.
- Giữ expected formulas cũ sau khi override `JOBS`.
- Dùng per-VU state (session, token) kỳ vọng sống qua nhiều iter — mỗi iter là 1 job khác nhau.
- Kiểm tra `iterations_per_vu == JOBS / vus` như một pass criteria.
- KHÔNG implement duplicate schedule → test không cover idempotency path.
- Check chỉ chấp nhận status 200 → duplicate bị fail khi server trả 409.
- Bỏ qua claim TTL safety: p95 > claim_ttl_ms vẫn cho pass.
- Dùng `iterationInTest` trực tiếp làm webhook ID (không qua duplicate schedule) → 100 unique, 0 duplicate.
- Không tag `is_duplicate` → không phân biệt được unique vs duplicate path trên dashboard.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- Worked example QuickPizza: `../../20260515_03_shared-iterations-quickpizza-two-requests-worked-example.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-03-payment-webhook-drain.js`
- Catalog audit case (case 01): `./01_catalog-audit.md`
- Order reconciliation case (case 02): `./02_order-reconciliation.md`
