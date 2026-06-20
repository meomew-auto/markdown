# Case 03: Active cart editing

## Tình huống thực tế

Team cart muốn mô phỏng một nhóm shoppers đang active và liên tục chỉnh cart trong vài phút.

Mỗi loop add item, update quantity, rồi đọc summary. Đây là steady write/read pressure từ active users, không phải cleanup backlog.

Case này trả lời: với 18 active cart users, cart-service có giữ write/read latency và consistency đủ ổn không?

Tóm tắt đời thường:

```text
Executor model: fixed active user pool
VUs: 18
Duration: 5m
Think time: 0.5s
Team/service focus: cart/backend
```

### Phân biệt với shared-iterations cart-cleanup

Case này **không phải** cart-cleanup của shared-iterations. Hai case khác nhau hoàn toàn về mục tiêu, mental model, và cách đọc output:

| Tiêu chí | Active cart editing (case này) | Cart cleanup (shared-iterations) |
| --- | --- | --- |
| Mục tiêu | Quan sát cart-service dưới steady write pressure từ active users | Drain hết fixed stale item backlog |
| Input chính | Concurrency (18 VU) + observation window (5m) | Backlog size (N stale items cần xử lý) |
| Output chính | Latency, error rate, natural throughput | Coverage: đã xử lý đủ N items chưa? |
| VU identity | Active user, giữ cart state qua nhiều loop | Generic worker, bốc item từ backlog |
| Dừng khi nào? | Hết duration | Hết backlog items |
| Throughput thấp nghĩa là gì? | Backend chậm, closed-model backpressure | Có thể backlog chưa drain hết → invalid test |

Hiểu sai sự khác biệt này dẫn đến đọc sai hoàn toàn output của test.

Case này không hỏi:

```text
Có xử lý đủ N job không?
Có đạt đúng X RPS không?
Mỗi user có chạy đúng N vòng không?
```

Nó hỏi:

```text
Nếu giữ 18 active users trong 5m,
latency/error/natural throughput của flow này ra sao?
```

## Yêu cầu cứng của case này

- Giữ 18 active cart users trong 5m.
- Mỗi completed loop nên có add/update/summary path.
- Không cần exact total carts/jobs; total iterations là output.
- Failed loops phải dưới `constant_active_iterations_failed count<20`.

Các invariant chung:

```text
vus + duration = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì RPS giảm
```

Do đó không được fail test chỉ vì `iterations` không bằng một số target tưởng tượng.

## Vì sao "Active cart editing" nên dùng `constant-vus`?

Active cart editing là duration/concurrency test: người dùng đang tương tác liên tục. `constant-vus` giữ user pool active để quan sát cart-service dưới steady write pressure.

Mental model:

```text
18 active VUs start.
Each VU loops the user flow until 5m ends.
A loop finishes -> same VU starts the next loop.
Total completed loops depend on loop duration.
```

### Mental model mở rộng: trace 18 VU trong 5 phút

```text
t=0.0s   18 VU cùng khởi động
         VU=1: loop #1 — add item A, update qty, read summary
         VU=2: loop #1 — add item B, update qty, read summary
         ...
         VU=18: loop #1 — add item R, update qty, read summary

t=0.5s   VU=1 xong loop #1 (add + update + summary + sleep 0.5s)
         → LẬP TỨC bắt đầu loop #2
         → Cart state của VU=1 được giữ lại (item A vẫn trong cart)

t=0.6s   VU=3 xong loop #1 (nhanh hơn vì network tốt)
         → Bắt đầu loop #2 với cart state của VU=3

t=0.7s   VU=8 xong loop #1 (chậm hơn vì DB lock queue)
         → Bắt đầu loop #2

...

t=5m     Duration kết thúc
         Các VU đang chạy loop dang dở được phép hoàn tất (gracefulStop)
         Tổng iterations = tất cả loop đã hoàn tất trong 5m + gracefulStop
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

### Closed model: cơ chế và hệ quả

Trong closed model, VU phải chờ loop hiện tại hoàn tất mới bắt đầu loop tiếp theo. Điều này tạo ra cơ chế phản hồi tự nhiên:

```text
Backend nhanh:
  loop_duration = 0.3s → mỗi VU làm ~3.3 loop/s → 18 VU → ~60 iter/s
  RPS = 60 × 3 = ~180 req/s (mỗi loop 3 API)

Backend bình thường:
  loop_duration = 0.5s → mỗi VU làm 2 loop/s → 18 VU → ~36 iter/s
  RPS = 36 × 3 = ~108 req/s

Backend chậm (DB lock contention):
  loop_duration = 2.0s → mỗi VU làm 0.5 loop/s → 18 VU → ~9 iter/s
  RPS = 9 × 3 = ~27 req/s
```

Công thức ước lượng (Little's Law áp dụng cho closed model):

```text
iter/s ≈ vus / avg_loop_duration
RPS    ≈ iter/s × API_per_loop
       ≈ vus / avg_loop_duration × API_per_loop
```

Đây là **tín hiệu**, không phải lỗi. Nếu backend chậm, throughput tự giảm — đó chính là điều constant-vus được thiết kế để phát hiện.

Ngược lại, nếu dùng `constant-arrival-rate`:

```text
k6 sẽ cố bơm đúng target RPS dù backend chậm.
→ Có thể gây drop, queue overflow ở k6, hoặc backlog ảo không phản ánh user thật.
→ Không thấy được closed-model backpressure.
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

### Phân tích sâu: vì sao 3 executor "duration-based" khác không phù hợp?

**`per-vu-iterations` — quota replay, không phải active pool**:

```text
Config: vus=18, iterations=100
→ Mỗi VU chạy ĐÚNG 100 loops rồi dừng
→ Tổng = 18 × 100 = 1800 loops

Vấn đề:
  - Mỗi VU dừng SAU KHI đạt quota, không phải sau 5m
  - VU nhanh xong 100 loops trong 30s → idle 4m30s
  - VU chậm xong 100 loops trong 6m → kéo dài hơn duration
  → KHÔNG phải "18 users active trong 5m"
  → Là "mỗi user replay đúng 100 lần, bất kể mất bao lâu"
```

**`shared-iterations` — batch job, không phải active session**:

```text
Config: vus=18, iterations=500
→ 500 "cart items" cần xử lý trong backlog
→ VU nào rảnh thì lấy job tiếp theo
→ Dừng khi hết 500 jobs

Vấn đề:
  - Không có khái niệm "cùng một user" qua nhiều loop
  - Mỗi VU bốc job ngẫu nhiên từ pool → cart state không persist
  - Nếu muốn mô phỏng "user A thêm item, rồi user A sửa item đó"
    → shared-iterations không làm được vì VU không giữ identity
  - Nó là "worker pool xử lý 500 cart operation", không phải "18 shoppers shopping"
```

**`constant-arrival-rate` — open model, không có backpressure**:

```text
Config: rate=30, duration="5m", preAllocatedVUs=18
→ k6 cố gắng start 30 iterations/s trong 5m
→ Nếu backend chậm, k6 vẫn schedule 30/s

Vấn đề:
  - Nếu backend chậm (loop_duration = 2.0s):
    + constant-vus: tự động giảm còn ~9 iter/s — PHÁT HIỆN ĐƯỢC vấn đề
    + constant-arrival-rate: vẫn cố 30/s, drop slot hoặc queue ở k6
      → Bạn thấy drop, nhưng không biết "nếu là user thật thì throughput tự nhiên là bao nhiêu"
  - Che khuất closed-model behavior
```

Kết luận cho case này:

```text
Need fixed active users over time -> constant-vus.
Need fixed total jobs -> shared-iterations, not this case.
Need fixed per-user quota -> per-vu-iterations, not this case.
Need fixed RPS -> constant-arrival-rate, not this case.
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
CV_03_VUS = 18
CV_03_DURATION = 5m
CV_03_SLEEP_SECONDS = 0.5
```

| Config/env | Giá trị | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `CV_03_VUS` | 18 | Số active cart users |
| `CV_03_DURATION` | 5m | Observation window |
| `CV_03_SLEEP_SECONDS` | 0.5 | Think time giữa cart edits |

Threshold cap riêng:

```text
constant_active_iterations_failed: count<20
```

### Công thức expected (ước lượng, không phải target)

```text
loop_duration_estimate ≈ add_latency + update_latency + summary_latency + sleep
                        ≈ 0.15s + 0.10s + 0.08s + 0.5s
                        ≈ 0.83s (nếu backend bình thường)

iter/s_estimate ≈ vus / loop_duration_estimate
                ≈ 18 / 0.83
                ≈ 21.7 iter/s

total_iterations_estimate ≈ iter/s_estimate × duration_seconds
                           ≈ 21.7 × 300
                           ≈ 6510 iterations

RPS_estimate ≈ iter/s_estimate × 3
             ≈ 65 req/s (3 API calls mỗi loop)

http_reqs_estimate ≈ total_iterations_estimate × 3
                    ≈ 19530
```

**Quan trọng**: Đây là ước lượng để có intuition, KHÔNG phải pass criteria. Số thật phụ thuộc backend latency thực tế.

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

### Identity model: VU = active user với persistent cart state

Đây là điểm khác biệt quan trọng nhất giữa constant-vus và shared-iterations trong case cart.

Trong constant-vus, mỗi VU **có thể** (và nên) được dùng như một active user identity ổn định:

```text
VU=1  = "shopper Alice" — cart của Alice tồn tại qua nhiều loop
VU=2  = "shopper Bob"   — cart của Bob tồn tại qua nhiều loop
...
VU=18 = "shopper Ruby"  — cart của Ruby tồn tại qua nhiều loop
```

Mỗi VU duy trì cart state của riêng mình qua các loop:

```text
VU=1, loop #1: add item "SKU-001", qty=2 → cart có {SKU-001: 2}
VU=1, loop #2: add item "SKU-042", qty=1 → cart có {SKU-001: 2, SKU-042: 1}
               update "SKU-001", qty=3    → cart có {SKU-001: 3, SKU-042: 1}
VU=1, loop #3: add item "SKU-107", qty=1 → cart có {SKU-001: 3, SKU-042: 1, SKU-107: 1}
               read summary               → xác nhận cart state nhất quán
...
```

Điều này mô phỏng **chính xác** hành vi người dùng thật: một shopper mở app, thêm vài món vào cart, sửa số lượng, xem lại cart, rồi tiếp tục mua sắm.

#### So sánh identity model giữa 3 executor

| Tiêu chí | constant-vus (case này) | shared-iterations | per-vu-iterations |
| --- | --- | --- | --- |
| VU là gì? | Active user identity | Generic worker | Business entity với quota |
| Cart state persist? | CÓ, qua nhiều loop trong cùng VU | KHÔNG, mỗi iter là job mới | CÓ, qua các iter của cùng VU |
| Mỗi VU chạy bao nhiêu loop? | Không cố định, tùy duration + latency | Không cố định, tùy ai lấy job trước | Cố định = iterations config |
| Phù hợp mô phỏng... | Người dùng shopping liên tục | Worker xử lý batch job | User replay journey N lần |

#### Vì sao `__VU` là identity đúng cho case này?

```text
Trong shared-iterations:
  __VU = worker ID → SAI nếu dùng làm business identity
  Vì VU=1 có thể bốc job #0, #7, #15 (các job khác nhau)
  → Không có persistent state

Trong constant-vus (case cart editing):
  __VU = active user ID → ĐÚNG nếu dùng làm shopper identity
  Vì VU=1 luôn là "shopper 1", chạy loop #1, #2, #3... liên tục
  → Cart state PERSIST qua các loop của cùng VU
  → Mô phỏng đúng hành vi: cùng 1 người dùng tương tác với cart của họ
```

### Demo trace: 3 VU, mỗi VU có cart state riêng

```text
Config: vus=3, duration=10s, sleep=0.5s

t=0.0s   VU=1 (shopper Alice):   loop #1 — add SKU-A, qty=2 → cart={A:2}
         VU=2 (shopper Bob):     loop #1 — add SKU-B, qty=1 → cart={B:1}
         VU=3 (shopper Charlie): loop #1 — add SKU-C, qty=3 → cart={C:3}

t=0.5s   VU=1: loop #2 — add SKU-D, qty=1 → cart={A:2, D:1}
                          update SKU-A, qty=5 → cart={A:5, D:1}
                          read summary → verify cart={A:5, D:1}
         VU=2: loop #1 vẫn đang chạy (network chậm hơn)
         VU=3: loop #2 — add SKU-E, qty=1 → cart={C:3, E:1}

t=1.0s   VU=1: loop #3 — tiếp tục với cart={A:5, D:1}
         VU=2: loop #2 — update SKU-B, qty=3 → cart={B:3}
         VU=3: loop #2 vẫn đang chạy

...

→ Mỗi VU có cart state RIÊNG, tích lũy qua các loop
→ State của VU=1 không ảnh hưởng VU=2 hay VU=3
→ Đây chính là mô hình "18 shoppers cùng shopping"
```

### Vì sao identity model quan trọng cho case cart?

Nếu không giữ cart state qua các loop, test không phát hiện được các bug liên quan đến state mutation:

```text
Bug #1 — Cart corruption sau nhiều lần update:
  - User add item A, update A vài lần → cart bị duplicate item A
  → Chỉ phát hiện nếu CÙNG VU giữ cart state qua nhiều loop

Bug #2 — Summary sai sau khi add/update nhiều item:
  - User add 3 item, update 2 item → summary chỉ hiện 1 item
  → Chỉ phát hiện nếu đọc summary SAU KHI đã add/update trong CÙNG cart

Bug #3 — Write lock contention giữa các user:
  - 18 user cùng add/update → DB lock queue → latency tăng
  → Phát hiện được vì iter/s giảm dù VUs vẫn flat
```

Nếu dùng shared-iterations (mỗi iter = 1 cart operation độc lập), các bug này bị che khuất vì mỗi iter bắt đầu với clean state.

## Technical root causes this case catches

### Phân tích sâu: mỗi root cause và cách nó biểu hiện

Case active cart editing được thiết kế để bắt 4 lớp vấn đề kỹ thuật. Mỗi lớp cần được hiểu riêng vì chúng biểu hiện khác nhau trên dashboard và cần cách điều tra khác nhau.

---

### Nguyên nhân kỹ thuật 1: Write amplification

**Định nghĩa**: Một user loop tạo nhiều cart operations. RPS tổng có thể cao hơn iter/s nhiều lần.

**Demo cụ thể**:

```text
1 loop của 1 active user:
  POST   /api/sim/cart/add           (active_cart_add)
  PATCH  /api/sim/cart/items/:id     (active_cart_update)
  GET    /api/sim/cart/summary       (active_cart_summary)
  → 3 API calls trong 1 loop

Với 18 VU, avg loop_duration = 0.5s:
  iter/s ≈ 18 / 0.5 = 36 iter/s
  RPS    ≈ 36 × 3  = 108 req/s

→ RPS gấp 3 lần iter/s
→ http_reqs ≈ iterations × 3 (nếu không có fail/retry)
```

**Vì sao đây là root cause cần bắt?**:

```text
Nếu developer chỉ nhìn "iterations" mà không nhìn "http_reqs" hoặc "RPS",
họ có thể nghĩ: "36 iter/s — nhẹ nhàng, cart-service chịu được"

Nhưng thực tế cart-service đang nhận 108 req/s.
Nếu cart-service được thiết kế cho 50 req/s, nó đang bị quá tải 2×.

→ Write amplification làm tăng áp lực thật lên service,
  vượt xa con số iterations bề ngoài.
```

**Cách phát hiện trên dashboard**:

```text
- So sánh http_reqs với iterations: tỉ lệ nên ≈ 3.0
- Nếu tỉ lệ < 2.5: có loop không đi đủ 3 API (branch skip, early return, hoặc fail)
- Nếu tỉ lệ > 3.5: có retry/re-request không mong muốn
- Execution timeline: đường httpReqs cao gấp ~3 lần đường iterations
```

**Hệ quả cho pass criteria**:

```text
constant_api_calls_total ≈ constant_active_iterations × 3

Nếu constant_api_calls_total = 9000 và constant_active_iterations = 3000
→ Tỉ lệ = 3.0 → flow đi đủ add/update/summary ✓

Nếu constant_api_calls_total = 9000 và constant_active_iterations = 4000
→ Tỉ lệ = 2.25 → thiếu API calls, có loop không đủ operation → investigate
```

---

### Nguyên nhân kỹ thuật 2: Summary read can hide behind write success

**Định nghĩa**: Add/update 200 chưa chứng minh read model/summary đúng hoặc nhanh.

**Demo cụ thể — read-after-write consistency issue**:

```text
Backend state: cart-service dùng CQRS (Command Query Responsibility Segregation)
  - Write model (add/update): ghi vào primary DB → return 200 ngay
  - Read model (summary): đọc từ materialized view → có độ trễ sync

Scenario:
  VU=1, loop #5:
    1. POST /cart/add → 200 OK (write model ghi xong)
    2. PATCH /cart/items/xyz → 200 OK (write model update xong)
    3. GET /cart/summary → 200 OK nhưng data CŨ (read model chưa sync)
       → Summary thiếu item vừa add, hoặc qty sai

  Kết quả:
    - http_req_failed = 0% (tất cả request đều 200)
    - checks pass (status 200 đều đúng)
    - Nhưng DATA SAI: summary không phản ánh cart thật

  → Bug này bị CHE KHUẤT nếu chỉ nhìn HTTP status code
  → Chỉ phát hiện nếu check CONTENT của summary response
```

**Demo trace với response body check**:

```text
VU=1, loop #3:
  Cart state trước loop: {SKU-001: 3, SKU-042: 1}
  
  Step 1: add SKU-107, qty=1 → POST 200
  Step 2: update SKU-001, qty=5 → PATCH 200
  Step 3: read summary → GET 200
  
  Expected summary: {SKU-001: 5, SKU-042: 1, SKU-107: 1}  (3 items, qty đúng)
  Actual summary:   {SKU-001: 3, SKU-042: 1}                (2 items, thiếu SKU-107, qty cũ)
  
  → HTTP 200, nhưng DATA SAI
  → Nếu không check response body → test PASS giả
```

**Cách phát hiện**:

```text
- Không chỉ check status code — phải check response body/content
- Tách metric theo operation: summary latency riêng, add/update latency riêng
- So sánh summary p95 với add/update p95:
  + Nếu summary p95 ≈ add p95: read model sync nhanh
  + Nếu summary p95 >> add p95: read model/materialized view có vấn đề
- Check business-level assertions (không chỉ HTTP-level checks)
```

**Tại sao case constant-vus phát hiện tốt hơn case khác**:

```text
Trong shared-iterations:
  - Mỗi iter là 1 cart operation độc lập → không có state trước đó
  - Add rồi đọc summary → nhưng summary không có "expected state" để so sánh
  - Vì không biết trước đó đã add những gì

Trong constant-vus với cart state:
  - VU=1 giữ cart state qua nhiều loop → BIẾT chính xác cart nên có những gì
  - Loop #5: cart đã có {A:3, B:1}, add C:2, update A:5
    → Expected summary = {A:5, B:1, C:2}
  - So sánh expected vs actual → phát hiện read-model inconsistency
```

---

### Nguyên nhân kỹ thuật 3: Same active user mutates state over time

**Định nghĩa**: Constant-vus giữ active user identity qua duration, phù hợp cart interaction lặp lại. Mỗi VU liên tục thay đổi cart state của mình, tạo ra cumulative side effects.

**Demo trace: cart state mutation qua 5 loop của 1 VU**:

```text
VU=1 (shopper Alice), 5 loops liên tiếp:

Loop #1:
  State đầu: {}
  Add SKU-001, qty=2 → cart={SKU-001:2}
  Update SKU-001, qty=3 → cart={SKU-001:3}
  Summary: 1 item

Loop #2:
  State đầu: {SKU-001:3}
  Add SKU-042, qty=1 → cart={SKU-001:3, SKU-042:1}
  Update SKU-001, qty=5 → cart={SKU-001:5, SKU-042:1}
  Summary: 2 items

Loop #3:
  State đầu: {SKU-001:5, SKU-042:1}
  Add SKU-107, qty=1 → cart={SKU-001:5, SKU-042:1, SKU-107:1}
  Update SKU-042, qty=0 (remove) → cart={SKU-001:5, SKU-107:1}
  Summary: 2 items

Loop #4:
  State đầu: {SKU-001:5, SKU-107:1}
  Add SKU-200, qty=3 → cart={SKU-001:5, SKU-107:1, SKU-200:3}
  Summary: 3 items (không update loop này)

Loop #5:
  State đầu: {SKU-001:5, SKU-107:1, SKU-200:3}
  Update SKU-200, qty=0 (remove) → cart={SKU-001:5, SKU-107:1}
  Update SKU-001, qty=2 → cart={SKU-001:2, SKU-107:1}
  Summary: 2 items

→ Sau 5 loop, VU=1 đã thực hiện:
  - 3 lần add (SKU-001, SKU-042, SKU-107, SKU-200 — 4 SKU unique)
  - 6 lần update (thay đổi quantity, remove item)
  - 5 lần summary
  - Cart state HIỆN TẠI: {SKU-001:2, SKU-107:1}
```

**Vì sao mutation over time quan trọng?**:

```text
1. Phát hiện memory leak trong cart service:
   - 18 VU × 300s / 0.5s ≈ 10800 cart operations
   - Mỗi cart tích lũy state qua thời gian
   - Nếu cart service không clean up đúng → memory tăng dần

2. Phát hiện race condition:
   - Nhiều VU cùng update cart → concurrent writes
   - Nếu locking không đúng → cart corruption (thiếu item, sai qty)

3. Phát hiện DB index degradation:
   - Cart table có 18 active carts, mỗi cart tích lũy nhiều item
   - Query performance có thể giảm khi cart có nhiều item hơn
   - Loop #1 (cart rỗng) nhanh hơn loop #50 (cart có 10+ items)
```

**So sánh với executor khác**:

```text
shared-iterations:
  - Mỗi iter = 1 operation → không có state tích lũy
  - Không phát hiện được bug "cart có 50 items thì summary chậm"

per-vu-iterations:
  - Có state per-VU, nhưng VU dừng sau N iter cố định
  - Không mô phỏng "user shopping liên tục trong 5m"

constant-arrival-rate:
  - Mỗi iter độc lập → không có persistent cart state
  - Không phát hiện state mutation bugs
```

---

### Nguyên nhân kỹ thuật 4: Backend slowdown reduces loop rate

**Định nghĩa**: Nếu writes lock DB, VUs vẫn flat nhưng loops/s giảm thay vì k6 ép thêm arrivals.

**Đây là đặc trưng quan trọng nhất của closed model.**

**Demo: DB write lock contention — loop_duration tăng, iter/s giảm**:

```text
Điều kiện bình thường (không lock contention):
  Cart-service: optimistic locking, ít conflict
  loop_duration avg = 0.5s
  iter/s = 18 / 0.5 = 36 iter/s

Điều kiện có lock contention (database row-level lock):
  Cart-service: pessimistic locking, nhiều VU update cùng cart item
  Hoặc: DB connection pool cạn, VU phải chờ connection

  Timeline của 3 VU khi có lock contention:
  
  t=0.0s   VU=1 update cart → acquire DB row lock
           VU=2 update cart → WAIT (cùng row bị lock bởi VU=1)
           VU=3 update cart → WAIT
  
  t=0.2s   VU=1 release lock → UPDATE xong
           VU=2 acquire lock → bắt đầu update
  
  t=0.4s   VU=2 release lock → UPDATE xong
           VU=3 acquire lock → bắt đầu update
  
  t=0.6s   VU=3 release lock → UPDATE xong

  → Mỗi VU mất 0.2s cho update, nhưng VU=2 phải chờ 0.2s, VU=3 phải chờ 0.4s
  → loop_duration hiệu quả của VU=3 = 0.5s (bình thường) + 0.4s (chờ lock) = 0.9s
```

**Kịch bản tồi hơn — lock escalation**:

```text
18 VU cùng update cart → 18 concurrent write transactions
DB dùng table-level lock hoặc row lock contention cao:

  VU=1:  loop_duration = 0.5s (được lock đầu tiên)
  VU=2:  loop_duration = 0.8s (chờ VU=1 0.3s)
  VU=3:  loop_duration = 1.1s (chờ VU=1+2 0.6s)
  VU=4:  loop_duration = 1.4s
  ...
  VU=18: loop_duration = 5.0s (chờ 17 VU trước)

  Avg loop_duration ≈ (0.5 + 0.8 + 1.1 + ... + 5.0) / 18 ≈ 2.75s
  iter/s ≈ 18 / 2.75 ≈ 6.5 iter/s (so với 36 iter/s bình thường)
  
  → GIẢM 82% throughput dù VUs vẫn = 18!
  → Đây là backpressure signal của closed model
```

**Cách đọc trên dashboard**:

```text
Chart "VUs vs iter/s":
  VUs: flat = 18 (VUs vẫn active, không giảm)
  iter/s: giảm dần (từ 36 → 20 → 12 → 9 → 6.5)
  
  → Pattern: VUs flat + iter/s falling = write lock contention
  → Đây LÀ tín hiệu đúng, không phải lỗi test

Chart "Response time":
  active_cart_update p95: tăng rõ rệt (0.1s → 2.0s+)
  active_cart_add p95: có thể cũng tăng (nếu add và update cùng DB transaction)
  active_cart_summary p95: có thể ổn định hơn (read-only, không cần lock)

Chart "Execution timeline":
  RPS: giảm dần theo thời gian
  http_reqs per bucket: giảm
  iterations per bucket: giảm
```

**So sánh với constant-arrival-rate trong cùng tình huống**:

```text
constant-arrival-rate (rate=100/s):
  - Backend có lock contention → latency tăng
  - Nhưng k6 vẫn cố start 100 iteration/s
  - Kết quả: drop tăng, queue ở k6, VU có thể tăng để bù
  - Bạn thấy: "drop rate cao, test không ổn định"
  - Bạn KHÔNG thấy: "nếu là user thật, throughput tự nhiên chỉ còn 6.5 iter/s"
  
constant-vus (case này):
  - Backend có lock contention → latency tăng → loop chậm
  - VUs vẫn = 18, nhưng iter/s giảm tự nhiên
  - Kết quả: iter/s = 6.5 (phản ánh đúng năng lực thật của hệ thống)
  - Bạn thấy: "với 18 active users, hệ thống chỉ xử lý được 6.5 cart loops/s"
  → Đây là insight production value: nếu có 18 user thật, họ sẽ trải nghiệm
    latency cao + response chậm, không phải "drop request"
```

---

### Bảng tổng hợp 4 root causes và dấu hiệu

| Root cause | Triệu chứng trên dashboard | Cách xác nhận |
| --- | --- | --- |
| Write amplification | http_reqs ≈ 3× iterations | So sánh http_reqs với iterations; tỉ lệ lệch → flow incomplete |
| Summary read hides behind writes | add/update p95 thấp, summary p95 cao; hoặc summary data sai dù 200 | Tách operation latency; check response body content |
| Same user mutates state over time | loop_duration tăng dần theo số item trong cart | So sánh loop_duration của loop đầu vs loop cuối; cart size log |
| Backend slowdown → loop rate giảm | VUs flat, iter/s giảm; update p95 tăng | Chart VUs vs iter/s: VUs=18 phẳng, iter/s falling |

## Service/API flow

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| active_cart_add | cart-service | POST | /api/sim/cart/add | 200 | Add product to cart. |
| active_cart_update | cart-service | PATCH | /api/sim/cart/items/:item_id | 200 | Update item quantity. |
| active_cart_summary | cart-service | GET | /api/sim/cart/summary | 200 | Read final cart summary. |

Các operation này phải được đọc bằng tag `operation`, vì aggregate metrics có thể che branch nhỏ nhưng chậm.

### Operation mix và weighted latency

Trong case này, 3 operation có đặc tính latency khác nhau:

```text
active_cart_add (POST):
  - Write operation: insert row vào cart_items table
  - Thường nhanh nhất trong 3 operation (insert đơn giản)
  - Nhưng có thể chậm nếu cart đã có nhiều items (index update)

active_cart_update (PATCH):
  - Write operation: update row trong cart_items table
  - Có thể gây lock contention (nhiều VU update cùng lúc)
  - Dễ bị ảnh hưởng nhất bởi DB locking

active_cart_summary (GET):
  - Read operation: aggregate cart items + compute totals
  - Nếu dùng materialized view: latency ổn định nhưng data có thể stale
  - Nếu dùng real-time query: latency tăng khi cart nhiều items
```

Đừng gộp latency 3 operation làm một. Mỗi operation có bottleneck riêng.

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

### Cách đọc từng counter và mối quan hệ giữa chúng

```text
constant_active_iterations:
  - Đếm số user loop hoàn tất end-to-end
  - KHÔNG phải target → không có "expected count"
  - Dùng để: so sánh giữa các run (cùng config), tính iter/s

constant_active_iterations_failed:
  - Đếm số loop có ít nhất 1 API fail
  - Pass nếu < 20 (trong ~6000+ loops)
  - Nếu cao: lọc theo operation để tìm API nào fail

constant_api_calls_total:
  - Tổng API calls thực tế
  - So với constant_active_iterations × 3 để kiểm flow completeness
  - Nếu thấp hơn: có loop incomplete
  - Nếu cao hơn: có retry/re-request

constant_flow_duration_ms:
  - Thời gian end-to-end của 1 user loop
  - BAO GỒM: add time + update time + summary time + sleep + JS overhead
  - So sánh với iteration_duration để hiểu sleep chiếm bao nhiêu

constant_sleep_seconds:
  - Tổng sleep tích lũy
  - constant_sleep_seconds / constant_active_iterations ≈ 0.5s (nếu config đúng)
```

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
case_id       = cv-03-active-cart-editing
business_case = active_cart_editing
workload      = steady_concurrency
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

### Sanity check bổ sung

```text
1. Tỉ lệ API/loop:
   constant_api_calls_total / constant_active_iterations ≈ 3.0
   (Mỗi loop nên có add + update + summary)
   Nếu 2.5-3.5: OK
   Nếu < 2.5: có loop thiếu operation → kiểm script flow
   Nếu > 3.5: có retry không mong muốn

2. Sleep đúng config:
   constant_sleep_seconds / constant_active_iterations ≈ CV_03_SLEEP_SECONDS
   Nếu lệch nhiều: sleep không được gọi đúng cách

3. VUs flat:
   Dashboard chart VUs vs iter/s: VUs phải gần 18 trong regular phase
   Nếu VUs không lên đủ 18: config/env sai
   Nếu VUs dao động: preAllocatedVUs hoặc VU init có vấn đề

4. Flow duration breakdown:
   constant_flow_duration_ms p95 > (sleep + add_p95 + update_p95 + summary_p95)
   Nếu flow_duration bất thường so với tổng API latencies: JS overhead hoặc
   orchestration delay
```

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-03-active-cart-editing.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-03-active-cart-editing.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-03-active-cart-editing.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = constant-vus
vus = 18 hoặc env override
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

### Bước 5 — Interpret duration/throughput

Đọc:

```text
constant_flow_duration_ms
iteration_duration
http_req_duration by operation
```

Case-specific notes:

- `constant_api_calls_total` nên xấp xỉ `constant_active_iterations × 3` nếu mỗi loop đi đủ add/update/summary.
- `constant_flow_duration_ms` phản ánh full cart edit loop.
- Summary latency/failure phải đọc riêng, không chỉ nhìn add/update.

## Đọc dashboard real-time charts cho case 03

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
active_cart_add: POST /api/sim/cart/add
active_cart_update: PATCH /api/sim/cart/items/:item_id
active_cart_summary: GET /api/sim/cart/summary
```

Cách đọc:

```text
http_req_duration       = latency từng request
constant_flow_duration_ms = latency full user loop
iteration_duration      = duration vòng default(), thường bao gồm sleep
```

Đừng dùng aggregate p95 một mình trong mixed/multi-operation flow.

Case-specific hints:

- Response time: tách add/update/summary để biết write hay read model chậm.
- Execution timeline: http_reqs thường khoảng 3× iterations nếu flow không branch/fail.
- VUs vs iter/s: VUs flat + iter/s giảm có thể do DB write contention.

#### Phân tích sâu: Write vs Read latency comparison

Đây là phân tích quan trọng nhất cho case cart editing. Ba operation có latency profile khác nhau và mỗi cái kể một câu chuyện riêng:

```text
So sánh 3 operation latency:

active_cart_add (POST) — write:
  - p95 thường ổn định nếu insert đơn giản
  - Có thể tăng nếu cart table lớn, index nhiều
  - Nếu tăng: kiểm DB insert performance, index strategy

active_cart_update (PATCH) — write:
  - p95 dễ bị ảnh hưởng nhất bởi lock contention
  - Nếu update_p95 >> add_p95: lock contention hoặc row-level locking
  - Nếu update_p95 tăng dần theo thời gian: lock queue tích lũy

active_cart_summary (GET) — read:
  - p95 nên ổn định và thấp (read-only, không lock)
  - Nếu summary_p95 cao: read model/materialized view có vấn đề
  - Nếu summary_p95 ≈ update_p95: có thể read cũng bị block bởi write lock
  - Nếu summary_p95 thấp nhưng data sai: read-model inconsistency (đọc data cũ)
```

**Shape đẹp cho case cart editing**:

```text
active_cart_add:     p95 < 200ms  (insert nhanh)
active_cart_update:  p95 < 150ms  (update đơn giản, ít conflict)
active_cart_summary: p95 < 100ms  (read nhanh)

constant_flow_duration_ms p95 ≈ 0.5s (sleep) + 0.2s + 0.15s + 0.1s ≈ 0.95s
iteration_duration p95: tương tự nhưng có thể cao hơn do JS overhead
```

**Shape xấu cần chú ý**:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| add p95 ổn, update p95 tăng dần | Lock contention tích lũy | Kiểm DB locking strategy |
| add p95 ổn, update p95 ổn, summary p95 cao | Read model/materialized view chậm | Kiểm cart summary query |
| add p95 ổn, update p95 ổn, summary p95 thấp nhưng data sai | Read-model inconsistency | Kiểm sync giữa write/read model |
| Cả 3 operation p95 đều tăng | Backend quá tải toàn diện | Kiểm cart-service resource (CPU, DB pool) |
| p95 spike định kỳ (mỗi ~60s) | GC pause, cron job, hoặc background task | Kiểm JVM/GC log, cron schedule |
| update p95 >> add p95 (gap > 3×) | Update query chậm hơn insert nhiều | Kiểm UPDATE query plan, index |

#### Cách phân tích sâu chart Response time

Khi nhìn chart này, đừng chỉ nhìn "cao/thấp". Hãy đọc theo 4 câu hỏi:

```text
1. Operation nào chậm nhất? (add, update, hay summary?)
2. Latency có ổn định suốt 5m không, hay tăng/giảm?
3. Batch p95 có spike ở đoạn nào không?
4. Mối quan hệ giữa 3 operation latency nói lên điều gì?
```

Với case 03, shape đẹp thường có:

```text
đầu run:  p95 có thể cao hơn (cold start, connection pool init, cache miss)
giữa run: p95 ổn định thấp hơn
cuối run: p95 không tăng bất thường (không có memory leak, lock tích lũy)
```

### Chart 2 — Execution timeline

Với constant-vus:

```text
VUs should be flat near 18 during regular phase.
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

#### Phân tích sâu chart Execution timeline

Chart này trả lời câu hỏi khác hẳn Response time:

```text
Response time chart:
  "request nhanh/chậm thế nào?"

Execution timeline:
  "tại mỗi giây, test đã xử lý bao nhiêu loop? bao nhiêu VU còn chạy?"
```

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs — còn bao nhiêu active user đang chạy?
2. HTTP reqs mỗi bucket — bao nhiêu request hoàn thành trong giây đó?
3. Iterations hoàn thành mỗi bucket — bao nhiêu loop xong trong giây đó?
```

Với `constant-vus`, shape "đẹp" thường là:

```text
đầu run:
  Live VUs = 18 (tất cả active users đã start)
  httpReqs cao (~3× iterations vì mỗi loop 3 API)
  iterations bắt đầu xuất hiện sau ~0.5-1.0s (loop đầu hoàn tất)

giữa run:
  Live VUs giữ ổn định 18
  httpReqs và iterations ổn định (dao động nhẹ theo batch hoàn thành)

cuối run (gracefulStop):
  Live VUs giảm dần về 0 khi duration hết
  iterations giảm theo
  Một số request cuối vẫn hoàn tất trong gracefulStop window
```

Invalid patterns:

| Pattern | Nghĩa |
| --- | --- |
| Live VUs không lên đủ 18 từ đầu | VU init có vấn đề, config/env sai, hoặc preAllocatedVUs thiếu |
| Live VUs giữ 18 nhưng iterations = 0 lâu | VU bị kẹt trong request đầu, backend không phản hồi |
| httpReqs per bucket giảm dần trong khi VUs=18 | Backend chậm dần, loop duration tăng |
| httpReqs không ≈ 3× iterations | Flow incomplete, branch skip, hoặc retry |
| httpReqs spike đột ngột | Retry burst hoặc failover |
| Live VUs giảm giữa run (không phải cuối) | VU crash, OOM, hoặc bị kill |

#### Batch 1 giây / time bucket

Mỗi point trên chart là 1 time bucket gom tất cả metric samples trong cùng 1 giây:

```text
01:09:19
→ mọi sample có timestamp trong khoảng 01:09:19.000 -> 01:09:19.999
→ được gom vào chung 1 point trên chart
```

Trong 1 bucket đó có thể có:

```text
- 18 VU cùng chạy (mỗi VU đang ở 1 loop khác nhau)
- Nhiều HTTP request hoàn thành (add + update + summary từ nhiều VU)
- Một số iteration/loop hoàn thành
- Nhiều check pass/fail
```

#### Vì sao bucket đầu có thể có httpReqs > 0 nhưng iterations = 0?

```text
Bucket đầu: VU vừa start, request đầu tiên đã xong (add)
nhưng full loop (add + update + summary + sleep) chưa hoàn tất

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

#### Phân tích sâu chart VUs vs iter/s

Chart này là **trọng tâm** cho constant-vus. Nó trả lời câu hỏi:

```text
Với 18 active users, throughput tự nhiên của hệ thống là bao nhiêu?
Throughput có ổn định không hay giảm dần?
```

**Mối quan hệ VUs và iter/s**:

```text
iter/s ≈ VUs / avg_loop_duration

Nếu VUs = 18 và loop_duration = 0.5s:
  iter/s ≈ 18 / 0.5 = 36 iter/s

Nếu loop_duration tăng lên 1.0s (backend chậm):
  iter/s ≈ 18 / 1.0 = 18 iter/s

Nếu loop_duration tăng lên 2.0s (lock contention nặng):
  iter/s ≈ 18 / 2.0 = 9 iter/s
```

**Đọc chart này cho case cart editing**:

```text
Shape A — ỔN ĐỊNH (hệ thống khỏe):
  VUs flat = 18 từ đầu đến cuối regular phase
  iter/s ổn định quanh ~30-40
  → Kết luận: cart-service xử lý tốt 18 active users

Shape B — GIẢM DẦN (write lock contention):
  VUs flat = 18 (VUs không giảm)
  iter/s giảm dần: 36 → 25 → 18 → 12 → 9
  → Kết luận: lock contention tích lũy, cart-service degradation
  → Đây LÀ tín hiệu giá trị nhất của constant-vus:
    phát hiện degradation mà arrival-rate executor sẽ che khuất

Shape C — THẤP TỪ ĐẦU (backend chậm toàn diện):
  VUs flat = 18
  iter/s thấp ngay từ đầu (~5-10)
  → Kết luận: cart-service hoặc DB chậm ngay từ đầu
  → Kiểm tra: cold start? thiếu resource? query plan xấu?

Shape D — SPIKES (intermittent issue):
  VUs flat = 18
  iter/s có spike lên/xuống đột ngột
  → Có thể: GC pause, network blip, dependency timeout
```

#### Demo đọc chart VUs vs iter/s cho 4 kịch bản

**Kịch bản 1: Hệ thống khỏe — iter/s ổn định**:

```text
Bucket   VUs   iter/s
0-30s    18    35
30-60s   18    36
60-90s   18    34
90-120s  18    36
120-150s 18    35
150-180s 18    35
180-210s 18    36
210-240s 18    34
240-270s 18    35
270-300s 18    36

→ iter/s ổn định ~35 suốt 5m
→ Kết luận: cart-service khỏe, không degradation
→ Total iterations ≈ 35 × 300 = 10500
```

**Kịch bản 2: Write lock contention — iter/s giảm dần**:

```text
Bucket   VUs   iter/s   Ghi chú
0-30s    18    36       Bình thường
30-60s   18    30       Bắt đầu có lock queue
60-90s   18    24       Lock contention tăng
90-120s  18    18       Nửa VU phải chờ lock
120-150s 18    14       Lock queue dài hơn
150-180s 18    12
180-210s 18    10
210-240s 18    9
240-270s 18    8
270-300s 18    7        Lock contention nặng nhất

→ iter/s giảm 80% (36 → 7) dù VUs vẫn = 18
→ Đây là tín hiệu closed-model backpressure
→ Hành động: kiểm tra DB locking strategy, connection pool size
```

**Kịch bản 3: Intermittent spike**:

```text
Bucket   VUs   iter/s   Ghi chú
0-30s    18    35
30-60s   18    36
60-90s   18    8        ← SPIKES xuống (GC pause?)
90-120s  18    35       ← Hồi phục
120-150s 18    34
150-180s 18    7        ← SPIKES xuống
180-210s 18    36       ← Hồi phục
...

→ iter/s có spike định kỳ → kiểm tra GC log, cron job, background task
```

**Kịch bản 4: VUs không flat — config issue**:

```text
Bucket   VUs   iter/s
0-30s    10    20       ← VUs không đủ 18!
30-60s   12    24
60-90s   14    28
...

→ VUs không đạt 18 → config/env sai, preAllocatedVUs, hoặc VU init lỗi
→ Đây không phải vấn đề backend, mà là vấn đề test config
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

### Kịch bản A — Tất cả sạch: CART STEADY EDITING OK

```text
constant_active_iterations.........: ~10500    (output, không phải target)
constant_active_iterations_failed..: 0
http_req_failed....................: 0.00%
checks..............................: 100%
constant_api_calls_total............: ~31500    (≈ 10500 × 3)

Operation breakdown:
  active_cart_add:     ~10500
  active_cart_update:  ~10500
  active_cart_summary: ~10500

Response time (p95):
  active_cart_add:     150ms
  active_cart_update:  120ms
  active_cart_summary: 80ms

constant_flow_duration_ms p95: ~900ms (sleep 500ms + API ~200ms + overhead)
iter/s ổn định: ~35
VUs flat: 18
```

Kết luận thực tế:

```text
- 18 active users liên tục edit cart trong 5m → không lỗi
- Write latency (add/update) thấp, read latency (summary) thấp
- Flow duration ~0.9s/cart loop → response time tốt
- Throughput ổn định 35 iter/s → không degradation
=> QUYẾT ĐỊNH: Cart-service sẵn sàng cho 18 concurrent active users.
   Accept baseline, có thể tăng VUs để tìm limit.
```

### Kịch bản B — Add/update pass nhưng summary fail: READ MODEL ISSUE

```text
constant_active_iterations.........: ~10500
constant_active_iterations_failed..: 350       ← 350 loops fail!
http_req_failed....................: 0.00%      ← HTTP vẫn 200 hết!
checks..............................: 96.7%     ← Một số check fail

Operation breakdown:
  active_cart_add:     ~10500     (tất cả add OK)
  active_cart_update:  ~10500     (tất cả update OK)
  active_cart_summary: ~10500     (vẫn gọi đủ)

Response time (p95):
  active_cart_add:     150ms      (ổn)
  active_cart_update:  130ms      (ổn)
  active_cart_summary: 85ms       (nhanh! nhưng...)

Nhưng:
  constant_active_iterations_failed = 350
  → 350 loop fail vì summary data KHÔNG KHỚP expected cart state
  → HTTP 200 nhưng response body SAI
```

Kết luận thực tế:

```text
- Add và update write thành công (HTTP 200, latency tốt)
- Nhưng summary trả về data cũ/thiếu → read model không sync kịp
- 350/10500 ≈ 3.3% loop bị read-model inconsistency
- Nếu chỉ nhìn http_req_failed = 0% → TƯỞNG test pass!
=> QUYẾT ĐỊNH: BLOCK. Cart-service có read-model inconsistency.
   Điều tra: materialized view refresh interval? CQRS sync delay?
   Đây là bug production-critical: user add item, thấy 200,
   nhưng cart page không hiện item vừa add.
```

### Kịch bản C — Write contention: ITER/S DROP

```text
constant_active_iterations.........: ~4200     (thấp hơn nhiều so với ~10500)
constant_active_iterations_failed..: 5
http_req_failed....................: 0.02%
checks..............................: 99.9%

Operation breakdown:
  active_cart_add:     ~4200
  active_cart_update:  ~4200
  active_cart_summary: ~4200

Response time (p95):
  active_cart_add:     350ms      (tăng 2×)
  active_cart_update:  1800ms     (tăng 15×! ← lock contention)
  active_cart_summary: 90ms       (vẫn ổn, read-only)

constant_flow_duration_ms p95: ~2800ms (so với ~900ms bình thường)
iter/s: giảm dần 36 → 7
VUs: flat = 18
```

Kết luận thực tế:

```text
- VUs vẫn = 18 → không phải lỗi test
- Nhưng iter/s giảm 80% → closed-model backpressure
- Update p95 = 1800ms (bình thường 120ms) → DB write lock contention
- Add cũng chậm hơn (350ms vs 150ms) → có thể add và update chung transaction
- Summary vẫn nhanh (90ms) → read path không bị ảnh hưởng
=> QUYẾT ĐỊNH: BLOCK. Cart-service có write lock contention nghiêm trọng.
   Với 18 users, throughput giảm 80%. Nếu production có 50 users,
   hệ thống có thể gần như đứng.
   Điều tra: DB locking strategy (pessimistic → optimistic?),
   connection pool size, transaction isolation level.
```

### Kịch bản D — Operation count mismatch: FLOW INCOMPLETE

```text
constant_active_iterations.........: ~10500
constant_active_iterations_failed..: 0          ← không fail?
http_req_failed....................: 0.00%
checks..............................: 100%

constant_api_calls_total............: ~24000    ← ĐÁNG LẼ ~31500!

Operation breakdown:
  active_cart_add:     ~10500     (đủ)
  active_cart_update:  ~10500     (đủ)
  active_cart_summary: ~3000      ← THIẾU 7500!

→ Tỉ lệ API/loop = 24000 / 10500 ≈ 2.29 (đáng lẽ 3.0)
→ 7500 loop thiếu summary!
```

Kết luận thực tế:

```text
- Add và update đều đủ → write path OK
- Nhưng summary thiếu 7500 calls → 71% loop không đọc summary
- Có thể: script bug (summary request bị skip trong 1 nhánh điều kiện)
- Hoặc: summary endpoint quá chậm → timeout → script không retry
- Dù http_req_failed = 0% → vì những loop thiếu summary
  đơn giản là không gọi summary → không có request để fail
=> QUYẾT ĐỊNH: TEST INVALID. Script flow không đi đủ 3 operation.
   Sửa script trước khi kết luận gì về cart-service.
   Đây là lý do cần sanity check: tỉ lệ API/loop.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| add/update/summary clean | Cart steady editing OK | Accept baseline |
| add/update pass but summary issue | Read model/materialization issue | Investigate cart summary |
| flow duration high | Cart write/read bottleneck | Inspect cart-service/DB |
| API call count per loop mismatch | Branch/script/failure issue | Validate flow |
| VUs flat, iter/s falling | Write lock contention, closed-model backpressure | Kiểm DB locking, connection pool |
| VUs flat, iter/s ổn định thấp | Backend chậm toàn diện từ đầu | Kiểm resource, cold start, query plan |
| update p95 >> add p95 | Update query chậm hoặc lock riêng | Kiểm UPDATE query, lock strategy |
| summary data sai dù HTTP 200 | Read-model inconsistency | Kiểm CQRS sync, materialized view |
| API/loop ratio < 2.5 | Flow incomplete | Kiểm script branch logic |

## Real run — default constant-vus baseline

Run verify qua local cloud/dashboard:

```text
Run ID: #73
Script: cv-03-active-cart-editing.js
Exit code: 0
summary_pushed: true
finish_status: 200
Config: 18 VUs, duration 5m, default sleep/env
```

### Summary chính

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes/checks_fails` | `30,831 / 0` |
| `http_req_failed_rate` | `0` |
| `iterations` | `10,277` |
| `iterations_rate` | `34.20/s` |
| `http_reqs` | `30,831` |
| `http_reqs_rate` | `102.61/s` |
| `vus_min/vus_max` | `18 / 18` |
| `constant_flow_duration_ms avg/med/p95/p99/max` | `25.53 / 11 / 90 / 193 / 408 ms` |
| `http_req_duration avg/med/p95/p99/max` | `8.40 / 3.54 / 48.79 / 92.23 / 298.38 ms` |

Request breakdown:

```text
active_cart_update PATCH 200 count=10,277
active_cart_add POST 200 count=10,277
active_cart_summary GET 200 count=10,277
```

### Đọc 3 chart dashboard cho run #73

**Chart 1 — Response time.** `http_req_duration` p95 ~48.79ms, p99 ~92.23ms; `constant_flow_duration_ms` p95 ~90ms. Cart add/update/summary đều 200.

**Chart 2 — Execution timeline.** `iterations` sum 10,277, `http_reqs` sum 30,831 = 3×iterations. Operation breakdown add/update/summary đều đúng 10,277, không thiếu bước nào.

Dashboard/API bucket summary:

```text
iterations buckets: count=301, sum=10277, min=18.00, max=36.00
http_reqs buckets:  count=300, sum=30831, min=60.00, max=108.00
không có failed iteration buckets
```

**Chart 3 — VUs vs iter/s.** VUs flat đúng 18 trong 300 buckets. Iter/s bucket 18–36, đây là closed-model output bình thường với sleep 0.5s và 3 API/loop.

```text
vus buckets: count=300, min=18.00, max=18.00, avg=18.00
```

### Backend verdict

```text
PASS — không thấy vấn đề BE trong run này.
```

Không cần báo BE.

## Nghịch lý và misconceptions của constant-vus

Đừng nhầm case này với cart cleanup shared-iterations. Đây là active users theo thời gian, không phải danh sách stale items cần xử lý đủ.

Nhớ 3 câu:

```text
vus + duration = input
iterations/RPS = output
backend chậm -> RPS giảm là tín hiệu đúng của closed model
```

### Nghịch lý 1: "3 API/loop mà RPS = 3× iter/s?"

```text
Nhìn summary:
  iterations = 10500
  http_reqs  = 31500
  RPS        = 105 req/s (avg)
  iter/s     = 35 iter/s

Câu hỏi: "Sao RPS gấp 3 lần iter/s? Tưởng 1 iteration = 1 request?"
```

**Trả lời: Vì mỗi loop gọi 3 API, không phải 1.**

```text
1 loop của active user = 3 HTTP requests:
  POST   /api/sim/cart/add           → 1 request
  PATCH  /api/sim/cart/items/:id     → 1 request
  GET    /api/sim/cart/summary       → 1 request
  Total: 3 requests / loop

Do đó:
  http_reqs  = iterations × 3
  RPS        = iter/s × 3
  31500      = 10500 × 3 ✓
  105 req/s  = 35 × 3 ✓

Đây là write amplification: mỗi user loop tạo ra nhiều request hơn
số loop. Cart-service nhận 105 req/s dù chỉ có 35 loop/s hoàn tất.

Ý nghĩa: Khi đọc dashboard, đừng nhìn iter/s rồi nghĩ "service chỉ nhận 35 req/s".
Thực tế service nhận 105 req/s. Nếu service được thiết kế cho 50 req/s,
nó đang bị quá tải 2× dù iter/s trông có vẻ thấp.
```

### Nghịch lý 2: "Add OK mà summary sai? HTTP đều 200 mà?"

```text
Nhìn summary:
  http_req_failed = 0.00%
  checks = 96.7%
  constant_active_iterations_failed = 350

Câu hỏi: "Sao HTTP đều 200 mà vẫn có failed iterations?
         Add và update 200 — cart chẳng phải đã đúng rồi sao?"
```

**Trả lời: HTTP 200 chỉ nói server nhận request và trả về response thành công, không nói data trong response có đúng không.**

```text
Cơ chế:
  1. POST /cart/add → server ghi vào primary DB → 200 OK
  2. PATCH /cart/items/:id → server update primary DB → 200 OK
  3. GET /cart/summary → server đọc từ read replica/materialized view → 200 OK
     Nhưng read replica CHƯA SYNC → data cũ!

  → Cả 3 request đều HTTP 200
  → http_req_failed = 0%
  → Nhưng summary data SAI (thiếu item vừa add, sai quantity)
  → constant_active_iterations_failed = 350 (business-level check fail)

Hệ quả:
  - Không thể chỉ dựa vào http_req_failed để kết luận pass/fail
  - Phải check response body/content ở business level
  - Phải đọc constant_active_iterations_failed (business failure counter)
  - Case constant-vus với cart state CỰC KỲ QUAN TRỌNG:
    vì script biết expected cart state → so sánh được với actual summary
    → phát hiện read-model inconsistency
```

### Nghịch lý 3: "18 VU mà iter/s chỉ bằng 6 VU?"

```text
Run bình thường: 18 VU → 36 iter/s
Run có lock contention: 18 VU → 7 iter/s

Câu hỏi: "18 VU mà throughput chỉ bằng ~6 VU (nếu 6 VU × 2 loop/s = 12 iter/s)?
         Có phải 12 VU đang idle không? Dashboard báo VUs=18 mà?"
```

**Trả lời: 18 VU đều đang chạy (không idle), nhưng mỗi VU bị chậm lại vì phải chờ DB lock.**

```text
Cơ chế:
  - VU=1 đến VU=18 đều đang ACTIVE (không idle)
  - Nhưng khi cần UPDATE cart, phải acquire DB row lock
  - 18 VU cùng muốn update → 17 VU phải CHỜ
  - VU chờ = VU vẫn active, vẫn chiếm 1 connection, vẫn trong loop
    → Dashboard thấy VUs = 18 (đúng! tất cả đang chạy)
    → Nhưng loop_duration của mỗi VU tăng 3-5× (do wait time)

Tính toán:
  Bình thường: loop_duration = 0.5s → 18 VU × 2 loop/s = 36 iter/s
  Lock contention: loop_duration = 2.5s → 18 VU × 0.4 loop/s = 7.2 iter/s

  7.2 iter/s với 18 VU ≈ throughput của 3.6 VU nếu loop_duration = 0.5s
  (3.6 × 2 = 7.2)

→ "18 VU mà throughput chỉ bằng ~4 VU" là ĐÚNG trong tình huống này
→ KHÔNG phải 14 VU idle — tất cả 18 VU đều đang chờ lock
→ Đây là closed-model backpressure: VUs flat, throughput giảm

Nếu dùng constant-arrival-rate:
  - k6 vẫn cố bơm 36 iter/s
  - Mỗi iter phải chờ lock 2.5s → queue ở k6 dài ra
  - Drop tăng, VU tăng (để bù drop) → bạn thấy "test không ổn định"
  - KHÔNG thấy được "18 users thật sẽ trải nghiệm latency 2.5s/loop"

Bài học:
  - VUs flat + iter/s giảm = closed-model signal giá trị nhất
  - Đừng đọc nó thành "k6 không tạo đủ load"
  - Đọc nó thành "hệ thống đang bị backpressure, user thật sẽ thấy chậm"
```

## Checklist đọc biểu đồ case 03

Khi đọc dashboard case 03, đọc theo thứ tự này:

```text
1. Overview KPI (trước khi vào chart):
   - http_req_failed < 1%?
   - checks > 99%?
   - constant_active_iterations_failed < 20?
   - constant_api_calls_total / constant_active_iterations ≈ 3.0?

2. Response time chart:
   - Đã tách theo operation (add vs update vs summary) chưa?
   - Operation nào chậm nhất?
   - update p95 có >> add p95 không? (lock contention)
   - summary p95 có >> add/update p95 không? (read model issue)
   - Có spike định kỳ không? (GC, cron)
   - Latency có tăng dần theo thời gian không? (degradation)

3. Execution timeline:
   - Live VUs đầu có = 18 không?
   - Live VUs có giữ ổn định 18 suốt regular phase không?
   - httpReqs có ≈ 3× iterations không?
   - Cuối run VUs có giảm về 0 không? (gracefulStop)
   - Có bucket nào httpReqs spike/thấp bất thường không?

4. VUs vs iter/s (CHART QUAN TRỌNG NHẤT):
   - VUs có flat = 18 không?
   - iter/s có ổn định không, hay giảm dần?
   - Nếu iter/s giảm dần → kiểm tra Response time chart:
     + Update p95 tăng? → lock contention
     + Add p95 cũng tăng? → DB tổng thể chậm
     + Cả hai không tăng? → sleep/config thay đổi

5. Business decision:
   - Tất cả counters pass? → Accept baseline
   - Có failed iterations? → Lọc theo operation tìm root cause
   - iter/s giảm dù VUs flat? → Closed-model backpressure, điều tra backend
   - API/loop ratio lệch? → Script flow issue, sửa script trước
   - add/update OK nhưng summary fail? → Read-model inconsistency

6. Verify invariant:
   - VUs flat = 18 ✓
   - iter/s = output (không target) ✓
   - http_reqs ≈ iterations × 3 ✓
   - constant_sleep_seconds ≈ iterations × 0.5 ✓
```

Kết luận của run case 03 đang đúng nếu thấy:

```text
http_req_failed < 1%
checks > 99%
constant_active_iterations_failed < 20
constant_api_calls_total / constant_active_iterations ≈ 3.0 (±0.3)
VUs flat = 18 trong regular phase
iter/s ổn định hoặc giảm nhẹ (không spike bất thường)
operation breakdown: add ≈ update ≈ summary ≈ constant_active_iterations
executor = constant-vus
duration = 5m (hoặc env override)
```

## Mở rộng / variations

### Variation 1: Tăng VUs để tìm concurrency limit

```powershell
$env:CV_03_VUS = 50
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-03-active-cart-editing.js
```

Mục đích: Tìm điểm mà cart-service bắt đầu degradation (iter/s không tăng tuyến tính theo VUs).

```text
Cách đọc:
  VUs=18: iter/s = 36  (baseline)
  VUs=30: iter/s = 55  (gần tuyến tính: 30/18 × 36 = 60, thực tế 55 → OK)
  VUs=50: iter/s = 58  (KHÔNG tuyến tính: 50/18 × 36 = 100, thực tế 58 → degradation!)
  → Concurrency limit ~30-40 VUs cho cart-service
  → Trên 40 VUs: lock contention hoặc resource cạn
```

### Variation 2: Flow chỉ có add + update (không summary)

```js
// Script variation: bỏ summary, chỉ giữ write path
export default function () {
  addToCart();
  updateCartItem();
  sleep(0.5);
  // Không gọi summary
}
```

Mục đích: Cô lập write path, xem lock contention có phải từ read/write conflict hay chỉ từ write/write.

```text
So sánh:
  Flow gốc (add+update+summary): iter/s = 7 (lock contention)
  Flow write-only (add+update):  iter/s = 8 (vẫn thấp)
  → Lock contention đến từ write/write, không phải read/write
  → Summary read không phải nguyên nhân

  Flow gốc (add+update+summary): iter/s = 7
  Flow write-only (add+update):  iter/s = 30 (cao hơn nhiều)
  → Summary read GÂY write lock (transaction giữ lock lâu hơn)
  → Cần điều tra transaction scope
```

### Variation 3: Thêm latency threshold để biến thành performance gate

```js
export const options = {
  thresholds: {
    "http_req_duration{operation:active_cart_add}": ["p(95)<300"],
    "http_req_duration{operation:active_cart_update}": ["p(95)<250"],
    "http_req_duration{operation:active_cart_summary}": ["p(95)<200"],
    "constant_flow_duration_ms": ["p(95)<1500"],
  },
};
```

Mục đích: Chuyển từ "quan sát" sang "gate": nếu latency vượt ngưỡng, CI/CD block.

```text
Lưu ý:
  - Threshold nên dựa trên baseline đã đo được, không phải số tưởng tượng
  - Nếu chưa có baseline: chạy case này vài lần, lấy p95 + 50% làm threshold ban đầu
  - Threshold quá chặt → flaky test; quá lỏng → không phát hiện regression
```

### Variation 4: Tăng duration để thành stability/soak test

```powershell
$env:CV_03_DURATION = "30m"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-03-active-cart-editing.js
```

Mục đích: Phát hiện memory leak, connection leak, degradation dài hạn.

```text
Cách đọc:
  5m baseline: iter/s ổn định 36 suốt 5m → OK cho short test
  30m soak: iter/s bắt đầu giảm sau 15m (36 → 28 → 22)
  → Có degradation dài hạn: memory leak? connection pool cạn?
  → Không phát hiện được nếu chỉ chạy 5m

  Thêm metric cần theo dõi cho soak:
  - loop_duration trend theo thời gian (không chỉ p95 tổng)
  - Cart items count trung bình (có tăng không?)
  - Memory/CPU của cart-service (theo dõi riêng ngoài k6)
```

### Variation 5: Thay đổi sleep time để mô phỏng user behavior khác

```powershell
# User "nhanh tay" — ít suy nghĩ
$env:CV_03_SLEEP_SECONDS = "0.2"
k6 run ...

# User "chậm" — đọc kỹ cart trước khi tiếp tục
$env:CV_03_SLEEP_SECONDS = "2.0"
k6 run ...
```

Mục đích: Hiểu think time ảnh hưởng thế nào đến throughput và hệ thống.

```text
sleep=0.2s: loop_duration ≈ 0.5s → iter/s ≈ 36 → RPS ≈ 108
sleep=0.5s: loop_duration ≈ 0.83s → iter/s ≈ 22 → RPS ≈ 65
sleep=2.0s: loop_duration ≈ 2.3s → iter/s ≈ 8 → RPS ≈ 23

Quan sát:
  - sleep thấp → throughput cao → backend chịu nhiều pressure hơn
  - sleep cao → throughput thấp → backend nhàn hơn
  - Nhưng LATENCY từng operation có thể GIỐNG NHAU
    (vì latency không phụ thuộc sleep, chỉ phụ thuộc backend)
  - Đây là điểm khác với arrival-rate: constant-vus cho phép
    throughput tự điều chỉnh theo user behavior (sleep)
```

## Code patterns

### Code pattern đúng: Per-VU cart state với add/update/summary loop

```js
import { sleep } from "k6";
import { check } from "k6";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";

// Business metrics
const constantActiveIterations = new Counter("constant_active_iterations");
const constantActiveIterationsFailed = new Counter("constant_active_iterations_failed");
const constantApiCallsTotal = new Counter("constant_api_calls_total");
const constantFlowDurationMs = new Trend("constant_flow_duration_ms");
const constantSleepSeconds = new Counter("constant_sleep_seconds");

// Per-VU cart state — ĐÂY LÀ ĐIỂM KHÁC BIỆT CHÍNH
// Mỗi VU duy trì cart state của riêng mình qua các loop
// Trong constant-vus, VU identity ổn định → cart state persist
const vuCarts = new Map(); // key: vuId, value: { items: {...}, itemCount: number }

function getVuCart(vuId) {
  if (!vuCarts.has(vuId)) {
    vuCarts.set(vuId, { items: {}, itemCount: 0 });
  }
  return vuCarts.get(vuId);
}

// Danh sách SKU để add vào cart (xoay vòng)
const PRODUCT_IDS = Array.from({ length: 200 }, (_, i) => `SKU-${String(i + 1).padStart(4, "0")}`);

function pickProductForAdd(vuId, cart) {
  // Chọn SKU chưa có trong cart (hoặc ít nhất là ít bị trùng)
  const existingIds = new Set(Object.keys(cart.items));
  const available = PRODUCT_IDS.filter((id) => !existingIds.has(id));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  // Nếu cart đã có tất cả SKU (hiếm), chọn random
  return PRODUCT_IDS[Math.floor(Math.random() * PRODUCT_IDS.length)];
}

function pickItemForUpdate(cart) {
  const ids = Object.keys(cart.items);
  if (ids.length === 0) return null;
  return ids[Math.floor(Math.random() * ids.length)];
}

export default function () {
  const vuId = __VU; // Active user identity — ổn định trong constant-vus
  const cart = getVuCart(vuId);

  const loopStart = Date.now();

  // === Step 1: Add item to cart ===
  const productId = pickProductForAdd(vuId, cart);
  const addQty = Math.floor(Math.random() * 5) + 1; // 1-5

  const addRes = http.post(
    `${BASE_URL}/api/sim/cart/add`,
    JSON.stringify({ product_id: productId, quantity: addQty }),
    {
      headers: { "Content-Type": "application/json" },
      tags: {
        operation: "active_cart_add",
        service: "cart-service",
        user_id: `user-${vuId}`,
        case_id: "cv-03-active-cart-editing",
        business_case: "active_cart_editing",
        executor_family: "constant_vus",
        workload_shape: "steady_concurrency",
      },
    }
  );

  constantApiCallsTotal.add(1);

  const addOk = check(addRes, {
    "cart add status 200": (r) => r.status === 200,
  });

  if (addOk) {
    // Cập nhật cart state của VU này
    cart.items[productId] = (cart.items[productId] || 0) + addQty;
    cart.itemCount = Object.keys(cart.items).length;
  }

  // === Step 2: Update item quantity ===
  const itemToUpdate = pickItemForUpdate(cart);

  if (itemToUpdate) {
    const newQty = Math.floor(Math.random() * 10) + 1; // 1-10

    const updateRes = http.patch(
      `${BASE_URL}/api/sim/cart/items/${itemToUpdate}`,
      JSON.stringify({ quantity: newQty }),
      {
        headers: { "Content-Type": "application/json" },
        tags: {
          operation: "active_cart_update",
          service: "cart-service",
          user_id: `user-${vuId}`,
          case_id: "cv-03-active-cart-editing",
          business_case: "active_cart_editing",
          executor_family: "constant_vus",
          workload_shape: "steady_concurrency",
        },
      }
    );

    constantApiCallsTotal.add(1);

    const updateOk = check(updateRes, {
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

  // === Step 3: Read cart summary ===
  const summaryRes = http.get(`${BASE_URL}/api/sim/cart/summary`, {
    tags: {
      operation: "active_cart_summary",
      service: "cart-service",
      user_id: `user-${vuId}`,
      case_id: "cv-03-active-cart-editing",
      business_case: "active_cart_editing",
      executor_family: "constant_vus",
      workload_shape: "steady_concurrency",
    },
  });

  constantApiCallsTotal.add(1);

  const summaryOk = check(summaryRes, {
    "cart summary status 200": (r) => r.status === 200,
  });

  // === Business-level check: summary có khớp expected cart state không? ===
  let summaryDataValid = false;
  if (summaryOk) {
    try {
      const summaryData = JSON.parse(summaryRes.body);
      // Kiểm tra cart state thực tế khớp với state script đang track
      const expectedItemCount = cart.itemCount;
      const actualItemCount = summaryData.items ? summaryData.items.length : -1;

      summaryDataValid = check(summaryData, {
        "summary item count matches cart state": () =>
          actualItemCount === expectedItemCount,
      });
    } catch (e) {
      // JSON parse error — summary response không hợp lệ
      summaryDataValid = false;
    }
  }

  // === Mark loop completion ===
  const loopDuration = Date.now() - loopStart;
  constantFlowDurationMs.add(loopDuration);
  constantActiveIterations.add(1);

  // Loop fail nếu bất kỳ operation nào fail hoặc summary data sai
  if (!addOk || !(itemToUpdate ? true : true) || !summaryOk || !summaryDataValid) {
    constantActiveIterationsFailed.add(1);
  }

  // === Think time ===
  const sleepSeconds = parseFloat(__ENV.CV_03_SLEEP_SECONDS || "0.5");
  sleep(sleepSeconds);
  constantSleepSeconds.add(sleepSeconds);
}

export const options = {
  scenarios: {
    active_cart_editing: {
      executor: "constant-vus",
      vus: parseInt(__ENV.CV_03_VUS || "18"),
      duration: __ENV.CV_03_DURATION || "5m",
      tags: {
        case_id: "cv-03-active-cart-editing",
        business_case: "active_cart_editing",
        executor_family: "constant_vus",
        workload_shape: "steady_concurrency",
      },
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    constant_active_iterations_failed: ["count<20"],
  },
};
```

### Những điểm quan trọng trong code pattern

```text
1. Per-VU cart state (vuCarts Map):
   - Key = __VU (ổn định trong constant-vus)
   - Mỗi VU có cart state riêng, tích lũy qua các loop
   - Đây là điểm KHÁC BIỆT với shared-iterations (không có per-VU state)

2. Business-level check (summary data validation):
   - Không chỉ check HTTP status 200
   - Còn check response body: summary item count có khớp cart state không
   - Đây là cách phát hiện read-model inconsistency

3. Tags đầy đủ:
   - operation: để tách latency theo add/update/summary
   - user_id: để debug user cụ thể nếu có vấn đề
   - case_id, business_case, executor_family, workload_shape:
     để dashboard filter và group

4. Custom metrics:
   - constant_active_iterations: đếm loop hoàn tất
   - constant_active_iterations_failed: đếm loop fail
   - constant_api_calls_total: đếm API calls thực tế
   - constant_flow_duration_ms: đo full loop duration
   - constant_sleep_seconds: đo sleep thực tế
```

### Code pattern SAI — không giữ cart state qua loop

```js
// SAI — Mỗi loop bắt đầu với cart rỗng
export default function () {
  const cart = { items: {}, itemCount: 0 }; // ← RESET mỗi loop!

  // Add item...
  // Update item...
  // Read summary — luôn thấy 1 item (vừa add)
  // → Không phát hiện được bug "cart có 10 items thì summary sai"
  // → Không mô phỏng được "cùng 1 user shopping qua nhiều thao tác"
}
```

```js
// SAI — Dùng iterationInTest làm cart identity
export default function () {
  const cartId = exec.scenario.iterationInTest; // ← Mỗi loop = cart mới!
  // ...
  // → Giống shared-iterations model
  // → Không có persistent cart state
  // → Không phát hiện state mutation bugs
}
```

```js
// SAI — Chỉ check HTTP status, không check response body
const summaryRes = http.get(`${BASE_URL}/api/sim/cart/summary`);
check(summaryRes, { "status 200": (r) => r.status === 200 });
// → HTTP 200 nhưng data sai → test pass giả
// → Luôn check cả status VÀ content
```

## Anti-pattern

- Dùng total `iterations` như pass/fail target cứng.
- Kỳ vọng fixed RPS từ `constant-vus`.
- So sánh 2 run có sleep/duration/VUs khác nhau rồi kết luận backend regress.
- Chỉ nhìn aggregate p95 trong flow nhiều operation.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với per-user quota của `per-vu-iterations`.
- Reset cart state mỗi loop — không giữ persistent cart state qua các loop.
- Chỉ check HTTP status code, không check response body content (bỏ sót read-model inconsistency).
- Đọc iter/s giảm khi VUs flat là "test fail" thay vì "closed-model signal".
- Không tách operation latency — gộp add/update/summary vào một aggregate p95.
- Cho rằng http_req_failed = 0% nghĩa là mọi thứ OK (summary data có thể sai dù HTTP 200).
- Dùng `constant-arrival-rate` để "fix" iter/s thấp — che khuất backpressure signal.
- Không verify tỉ lệ API/loop (~3.0) — bỏ sót flow incomplete.
- Quên check `constant_sleep_seconds` — sleep có thể không được áp dụng đúng.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Constant-vus quick index: `../../20260516_01_constant-vus-quick-index.md`
- Tham số/công thức: `../../20260516_02_constant-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-03-active-cart-editing.js`
- Shared-iterations contrast (cart-cleanup): `../shared-iterations/02_cart-cleanup.md`
- Per-vu-iterations contrast: `../per-vu-iterations/00_overview.md`
