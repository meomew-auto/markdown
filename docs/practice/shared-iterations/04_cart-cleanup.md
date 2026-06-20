# Case 04: Cart cleanup

## Tình huống thực tế

Team cart/backend cần cleanup một danh sách stale cart items sau TTL job, data migration, hoặc bug làm cart line item bị lệch quantity. Mỗi stale item là một record trong backlog cần được PATCH (sửa/correct) rồi GET summary để verify final state đã đúng sau khi sửa.

Nếu bỏ sót record, user có thể thấy cart cũ với quantity sai, hoặc total checkout không khớp với từng line item — dẫn đến mất tiền hoặc mất lòng tin. Vì vậy mục tiêu chính là coverage đủ backlog, không phải mô phỏng user traffic.

Case này **không** test same-user race (cart của cùng một user bị nhiều request sửa đồng thời — đó là bài toán của per-vu-iterations case 04/06). Nó test batch cleanup: 8 workers có xử lý đủ 90 stale item jobs và verify summary sau mỗi lần update không?

Case này trả lời câu hỏi: với 8 worker, backend có cleanup đủ 90 stale item jobs không, và mỗi job có đi qua cả update (PATCH) + verify (GET summary) path không?

Tóm tắt đời thường:

```text
Trigger: TTL cleanup, cart migration, stale item repair, hoặc backend maintenance job
Backlog: 90 stale cart item cleanup jobs
Risk nếu skip job: một stale item còn sót lại, cart summary/user state có thể sai
```

Case này **không** cố gắng trả lời "production traffic giống thật chưa?". Nó trả lời câu hỏi batch/ops cụ thể hơn:

```text
Có xử lý đủ fixed backlog không?
Mỗi job có đi đúng business flow không? (update + verify)
Có job nào fail không?
Verify có khớp với kỳ vọng sau update không?
```

### Vì sao "stale cart cleanup fixed backlog" buộc chọn shared-iterations?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của cart cleanup trước:

```text
Cart cleanup = "duyệt qua TỪNG stale item trong danh sách cố định,
               gọi PATCH để sửa/correct item,
               gọi GET summary để verify trạng thái final cart,
               xác nhận cả 2 đều trả về 200 và data hợp lệ"

Đời thường:
  Kho có 90 món hàng hỏng (= 90 stale items)
  8 công nhân (= 8 VU)
  Mỗi món cần: sửa lại (= PATCH) + kiểm tra sổ sách sau sửa (= GET summary)
  Công nhân nào xong món trước thì lấy món tiếp theo
  Kết thúc khi TẤT CẢ 90 món đã được sửa và kiểm tra
```

Để cart cleanup **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ shared-iterations mới thỏa mãn cả 2.

#### Yêu cầu (a): EXACT TOTAL COVERAGE (không thiếu stale item nào)

**Ý nghĩa**: Phải cleanup ĐỦ 90 stale items. Thiếu 1 item là coverage incomplete — item đó có thể vẫn còn stale, user thấy cart sai.

**Ví dụ cụ thể**:

```text
Scenario: team chạy TTL cleanup job, cần verify 90 stale items đã được sửa

Trường hợp A (coverage ĐỦ):
  Cleanup 90 items, tất cả update + verify pass
  → Kết luận: cleanup job OK, không còn stale item nào

Trường hợp B (coverage THIẾU - bug):
  Cleanup 60 items (thiếu 30), 60 items đã cleanup đều pass
  → Tưởng OK, nhưng 30 items chưa cleanup vẫn stale
  → Production: user mở cart → thấy quantity sai, total lệch
  → KHÔNG kết luận được, test không có giá trị
```

**Vì sao total iterations phải chính xác 90?**

```text
Nếu total phụ thuộc duration:
  - duration cố định 30s
  - latency thấp  → cleanup được 90 items (đủ)
  - latency cao   → cleanup được 55 items (thiếu 35)
  - latency tăng do backend chậm, không phải do ít items hơn
  → Mỗi lần test số item cleanup được khác → không biết coverage có đủ không
```

**Phân tích sâu: vì sao 2 executor "duration-based" không đảm bảo count?**

`constant-vus` với `duration: "30s"`:

```text
Công thức count khi chạy:
  count_jobs = duration × throughput
             = 30s × (vus / iter_time)
             = 30s × (8 / iter_time)
             = 240 / iter_time

iter_time KHÔNG cố định, biến thiên do:
  - HTTP latency (mạng, server load, GC pause)
  - DB write time (PATCH có db_writes=1, có thể chậm hơn GET)
  - Write contention (nhiều job chạm cùng cart/partition)
  - Summary GET có db_rows=3 + json_items=8 (query nặng hơn update)

Ví dụ thực tế chạy 3 lần liên tiếp cùng config:
  Lần 1: server vừa restart, cache cold
    iter_time avg = 0.70s -> count = 240/0.70 ≈ 342 jobs cleanup
    (dư! cleanup nhiều hơn 90, nhưng có thể cleanup lặp item đầu, thiếu item cuối)
  Lần 2: cache đã warm, network ổn
    iter_time avg = 0.40s -> count = 240/0.40 = 600 jobs cleanup
  Lần 3: DB backup chạy ngầm, write contention cao
    iter_time avg = 1.50s -> count = 240/1.50 = 160 jobs cleanup

  Vấn đề KHÔNG chỉ là count khác nhau.
  Vấn đề LỚN HƠN: không biết 90 stale items có được cleanup ĐỦ không.
  342 jobs có thể = cleanup lặp 30 item đầu × 11 lần, bỏ sót 60 item cuối.
```

`constant-arrival-rate` với `rate: 5/s, duration: "20s"`:

```text
Mục tiêu config: "5 job/s × 20s = 100 jobs TOTAL"
→ Dư so với 90 items cần cleanup. Nhưng...

KHÔNG đảm bảo đạt 100 vì có thể DROP slot:
  - Khi rate target > năng lực VU pool
  - Khi server chậm bất thường ở 1 đoạn (database lock, write contention)
  - Khi spawn VU không kịp lúc đầu

Công thức thực tế:
  N_done = N_sched - N_drop - N_int
         = 100 - N_drop - N_int

Ví dụ thực tế:
  Lần 1: pool vừa khít, không drop
    N_drop = 0, N_done = 100 (dư 10 so với 90, cleanup lặp)
  Lần 2: server có 10s chậm ở giữa (database backup + write contention)
    N_drop = 35, N_done = 65 (thiếu 25 items!)
  Lần 3: cache cold ở 30s đầu
    N_drop = 20, N_int = 5, N_done = 75 (thiếu 15 items)

  KHÔNG可靠: lần được lần không, không biết trước
```

**Trong khi đó với `shared-iterations`**:

```text
Config: vus=8, iterations=90
N_done = 90 (TUYỆT ĐỐI, nếu không bị maxDuration cắt)

Lần 1: server chậm  -> 90 jobs, T_run=18s, p95=1.6s
Lần 2: server nhanh -> 90 jobs, T_run=10s, p95=0.5s
Lần 3: server bình thường -> 90 jobs, T_run=14s, p95=0.9s

Count CỐ ĐỊNH ở 90 mỗi lần.
Chỉ có T_run + latency thay đổi -> đó CHÍNH LÀ cái cần đo!

→ 90 stale items luôn được cleanup đủ → coverage guarantee
→ Nếu latency tăng, T_run tăng → phát hiện được performance regression
→ Nếu write contention tăng, shared_job_duration_ms tăng → phát hiện được partition hotspot
```

**Tóm tắt 3 executor về count**:

| Executor | Count formula | Count cố định? | Stale item coverage guarantee? |
| --- | --- | --- | --- |
| **shared-iterations** | `iterations` | CÓ (tuyệt đối) | CÓ (nếu identity map đúng) |
| constant-vus (duration) | `duration × vus / iter_time` | KHÔNG (do iter_time) | KHÔNG (có thể cleanup lặp hoặc thiếu) |
| constant-arrival-rate | `N_sched - N_drop - N_int` | KHÔNG (do drop/int) | KHÔNG (drop có thể bỏ sót item) |

→ COUNT phải CHÍNH XÁC, KHÔNG phụ thuộc latency
→ Chỉ executor đếm theo "iterations cố định" mới đạt
→ Nhưng count đủ chưa đủ — còn cần identity map ĐÚNG (yêu cầu b)

#### Yêu cầu (b): CORRECT IDENTITY MAPPING (mỗi job map đúng 1 stale item)

**Ý nghĩa**: 90 iteration phải map sang 90 stale items KHÁC NHAU. Nếu map sai, dù count = 90, coverage vẫn thiếu.

**Bug identity mapping là gì?**

```text
Trường hợp ĐÚNG — identity từ iterationInTest:
  iter #0  -> staleItems[0]  (PATCH + GET verify)
  iter #1  -> staleItems[1]
  iter #2  -> staleItems[2]
  ...
  iter #89 -> staleItems[89]
  → 90 items unique được cleanup ✓

Trường hợp SAI — identity từ __VU:
  VU=1: __VU=1 -> staleItems[0] (lặp lại ~15 lần)
  VU=2: __VU=2 -> staleItems[1] (lặp lại ~12 lần)
  ...
  VU=8: __VU=8 -> staleItems[7] (lặp lại ~10 lần)
  → Chỉ 8 items được cleanup (lặp đi lặp lại)
  → 82 items còn lại KHÔNG BAO GIỜ được cleanup
  → Dù iterations = 90, coverage thật chỉ = 8/90 ≈ 9%
```

**3 nguyên nhân kỹ thuật của bug identity mapping**:

### Nguyên nhân 1: CLEANUP COVERAGE GAP (thiếu item do duration-based test)

**Vấn đề**: Duration-based test dừng sau một khoảng thời gian, không theo số item. Nếu latency tăng, số item cleanup được giảm.

```text
Tưởng tượng kho 90 món hàng hỏng cần sửa:
  - 8 công nhân sửa, mỗi món mất ~0.5s (PATCH + GET verify)
  - Sếp đặt đồng hồ 30s -> hết 30s dừng, bất kể còn món chưa sửa

  Ngày thường (server nhanh, 0.5s/món):
    8 công nhân × 30s / 0.5s = 480 món (dư, nhưng cleanup lặp món đầu)
    → Nếu map identity SAI, cleanup lặp 8 món đầu × 60 lần
    → 82 món cuối chưa từng được đụng tới

  Ngày chậm (server quá tải, write contention, 1.2s/món):
    8 công nhân × 30s / 1.2s = 200 món
    → Vẫn có thể cleanup lặp, bỏ sót món cuối
```

**Demo cụ thể: constant-vus duration=30s, vus=8**

Giả sử mỗi iter mất 0.6s, code dùng `__VU` làm identity (SAI):

```text
VU=1 (nhanh nhất, network tốt): iter_time=0.4s
  → 30s / 0.4s = 75 iter
  → Luôn cleanup staleItems[0], lặp 75 lần

VU=8 (chậm nhất, network kém): iter_time=0.9s
  → 30s / 0.9s = 33 iter
  → Luôn cleanup staleItems[7], lặp 33 lần

Tổng: 75+... +33 ≈ 400 iterations
Nhưng chỉ 8 items unique được cleanup
→ Coverage thật = 8/90 ≈ 9%
→ 82 items bỏ sót, dù test "pass" với 400 iter
```

**Demo với code đúng (identity từ iterationInTest) nhưng vẫn duration-based**:

```text
Vấn đề khác: không biết khi nào đã cleanup đủ 90 items

constant-vus duration=30s:
  iter #0-#89: cleanup items #0-#89 (đủ 90)
  iter #90-#399: cleanup tiếp items #0-#89 (lặp lại, lãng phí)
  → Lãng phí, nhưng ít nhất 90 items đã được cleanup

constant-vus duration=3s (quá ngắn):
  iter #0-#22: cleanup items #0-#22 (chỉ 23 items)
  → Thiếu 67 items, coverage không đủ
  → Nhưng test vẫn "pass" nếu chỉ nhìn http_req_failed=0

SO SÁNH VỚI shared-iterations:
  iterations=90
  iter #0-#89: cleanup items #0-#89 (đủ 90, DỪNG)
  → Không dư, không thiếu, coverage chính xác
```

**Cách phát hiện**: so sánh `iterations` count với expected `JOBS`. Nếu `iterations < JOBS` → coverage incomplete. Nếu `iterations > JOBS` và identity từ `__VU` → cleanup lặp.

### Nguyên nhân 2: WRONG IDENTITY MAPPING (dùng `__VU` thay vì `iterationInTest`)

Đây là lỗi phổ biến nhất khi chuyển từ per-vu-iterations sang shared-iterations.

**`__VU` là gì trong shared-iterations?** `__VU` là **worker ID** — định danh VU nào đang xử lý job hiện tại. Nó không phải business identity.

**`exec.scenario.iterationInTest` là gì?** Là **global job index** — số thứ tự iteration trong toàn scenario, từ 0 đến iterations-1.

```text
So sánh 2 cách map identity:

Cách A — SAI: dùng __VU
  const itemId = staleItems[__VU - 1];  // VU=1 -> staleItems[0], VU=2 -> staleItems[1], ...

  VU=1: __VU=1 -> luôn cleanup staleItems[0] (lặp ~12 lần)
  VU=2: __VU=2 -> luôn cleanup staleItems[1] (lặp ~12 lần)
  ...
  VU=8: __VU=8 -> luôn cleanup staleItems[7] (lặp ~12 lần)
  → 8 items unique, 82 items bỏ sót

Cách B — ĐÚNG: dùng exec.scenario.iterationInTest
  const itemId = staleItems[exec.scenario.iterationInTest];  // iter #0 -> staleItems[0], ...

  iter #0  -> staleItems[0]  (do VU nào cũng được)
  iter #1  -> staleItems[1]
  iter #2  -> staleItems[2]
  ...
  iter #89 -> staleItems[89]
  → 90 items unique, coverage đủ
```

**Demo trace 8 VU × 90 iter với identity đúng**:

```text
t=0.0s   8 VU cùng start
         VU=1 lấy iterInTest=0  -> cleanup staleItems[0]
         VU=2 lấy iterInTest=1  -> cleanup staleItems[1]
         VU=3 lấy iterInTest=2  -> cleanup staleItems[2]
         ...
         VU=8 lấy iterInTest=7  -> cleanup staleItems[7]

t=0.5s   VU=1 xong iter #0 (PATCH + GET verify done), lấy iterInTest=8  -> cleanup staleItems[8]
         VU=3 xong iter #2, lấy iterInTest=9  -> cleanup staleItems[9]
         ...

t=7.0s   iterInTest=89 được lấy -> cleanup staleItems[89] (item cuối!)
         90/90 jobs complete -> scenario dừng

Kết quả: 90 stale items unique được cleanup, mỗi item đúng 1 lần ✓
```

**Demo trace 8 VU × 90 iter với identity SAI (dùng __VU)**:

```text
t=0.0s   VU=1: __VU=1 -> staleItems[0] (lần 1)
         VU=2: __VU=2 -> staleItems[1] (lần 1)
         ...

t=0.5s   VU=1: __VU=1 -> staleItems[0] (lần 2)  ← lặp!
         VU=3: __VU=3 -> staleItems[2] (lần 1)
         ...

t=7.0s   90 iter hoàn thành
         staleItems[0]: cleanup 15 lần
         staleItems[1]: cleanup 12 lần
         staleItems[2]: cleanup 11 lần
         ...
         staleItems[7]: cleanup 9 lần
         staleItems[8]-staleItems[89]: cleanup 0 lần ← 82 items bỏ sót!

Kết quả: 90 iter, nhưng coverage thật = 8/90 ≈ 9% ❌
```

**Vì sao lỗi này dễ mắc khi chuyển từ per-vu-iterations?**

```text
Trong per-vu-iterations:
  __VU = business identity (user, customer, cart session)
  Mỗi VU chạy đúng N iter cho cùng identity đó
  → Dùng __VU để map identity là ĐÚNG

Trong shared-iterations:
  __VU = worker identity (ai đang cầm job)
  Mỗi VU chạy số iter khác nhau, job identity thay đổi mỗi lần
  → Dùng __VU để map identity là SAI

Code đúng cho shared-iterations:
  const itemIndex = exec.scenario.iterationInTest;  // 0..89
  const item = staleItems[itemIndex];
  // KHÔNG: const item = staleItems[__VU - 1];
```

### Nguyên nhân 3: UPDATE / VERIFY ASYMMETRY (PATCH pass nhưng GET summary fail)

**Vấn đề**: Một job cart cleanup chỉ hoàn tất khi **cả** PATCH update và GET summary verify đều pass. Nếu chỉ check tổng HTTP requests, có thể bỏ sót trường hợp PATCH pass hết nhưng summary GET fail.

```text
Flow mỗi job:
  1. PATCH /api/sim/cart/items/:item_id?...  (update stale item)       → expect 200
  2. GET   /api/sim/cart/summary?...          (verify final cart state) → expect 200

Nếu summary GET endpoint có bug (vd: db_rows query sai, index missing, write chưa commit):
  - PATCH vẫn pass 90/90 (command accepted, write queued)
  - GET verify fail 18/90 (đọc lại state chưa nhất quán)

Nếu chỉ nhìn http_reqs = 180:
  → 90 PATCH + 90 GET = 180 request đã gửi
  → nhưng 18 GET fail (status 500/timeout)
  → http_req_failed = 18/180 = 10%
  → Có vẻ "hơi fail", nhưng...

Nếu tách theo operation:
  cart_item_cleanup_update:   90/90 pass (100%)
  cart_cleanup_summary_verify: 72/90 pass (80%), 18 fail
  → 18 items có PATCH OK nhưng verify FAIL
  → Nguy hiểm: item đã được sửa nhưng không thể xác nhận final state đúng
  → User có thể vẫn thấy state cũ hoặc inconsistent
```

**Demo trace update/verify asymmetry**:

```text
Backend state: summary GET của item #12, #34, #56, #78 bị lỗi
(do write chưa commit xong, hoặc DB read replica lag)

Run cart cleanup 90 jobs:
  Job #0:  PATCH=200 OK, GET=200 OK  ✓
  Job #1:  PATCH=200 OK, GET=200 OK  ✓
  ...
  Job #12: PATCH=200 OK, GET=500 ERR ← BUG: write accepted nhưng read không thấy
  ...
  Job #34: PATCH=200 OK, GET=500 ERR ← BUG
  ...
  Job #89: PATCH=200 OK, GET=200 OK  ✓

Tổng kết nếu CHỈ nhìn http_reqs:
  http_reqs = 180
  http_req_failed = 4/180 = 2.2%
  → Dễ bị bỏ qua nếu threshold http_req_failed < 5%

Tổng kết nếu tách operation:
  cart_item_cleanup_update:   90 pass, 0 fail
  cart_cleanup_summary_verify: 86 pass, 4 fail
  → 4 items verify bị lỗi → CART CLEANUP FAIL
  → Phải route theo job_id để tìm chính xác item nào verify fail
```

**Cách phát hiện**: luôn tách metric theo tag `operation`. Không chỉ check `http_req_failed` tổng. Nếu `cart_cleanup_summary_verify` count < 90 → thiếu verify coverage. Nếu `cart_cleanup_summary_verify` có failed > 0 → điều tra item cụ thể. Đây là lý do case này BẮT BUỘC có 2 operation — PATCH một mình không đủ chứng minh cleanup thành công.

### Nguyên nhân 4: WRITE CONTENTION (nhiều job chạm cùng cart/DB partition)

**Vấn đề**: Không giống catalog audit (chủ yếu là read), cart cleanup có write path. Nhiều stale items có thể thuộc cùng một cart_id hoặc cùng DB partition, gây lock contention khi nhiều worker cùng PATCH.

```text
Tưởng tượng 90 món hàng hỏng trong kho:
  - 30 món nằm trong cùng 1 kệ (= cùng cart_id hoặc DB partition)
  - 8 công nhân cùng vào 1 kệ để sửa → chen chúc, đợi nhau
  - Công nhân phải đợi người trước sửa xong mới tới lượt

Trong database:
  - Nhiều PATCH cùng cart_id → row-level lock trên cùng row
  - Hoặc PATCH khác cart_id nhưng cùng partition → page-level lock
  - Worker phải đợi lock release → shared_job_duration_ms tăng đột biến
```

**Demo trace write contention với 4 VU, 3 items chung cart**:

```text
Config: vus=4, iterations=90
staleItems[0], staleItems[5], staleItems[12] đều thuộc cart_id="CART-A"

t=0.0s   VU=1: iterInTest=0  -> PATCH cart_id=CART-A, item=staleItems[0]
         VU=2: iterInTest=1  -> PATCH cart_id=CART-B, item=staleItems[1]  (khác cart, OK)
         VU=3: iterInTest=2  -> PATCH cart_id=CART-C, item=staleItems[2]  (khác cart, OK)
         VU=4: iterInTest=3  -> PATCH cart_id=CART-D, item=staleItems[3]  (khác cart, OK)

t=0.3s   VU=2 xong, lấy iterInTest=4 -> PATCH cart_id=CART-E (OK)
         VU=4 xong, lấy iterInTest=5 -> PATCH cart_id=CART-A, item=staleItems[5]
         → VU=4 đụng cart_id=CART-A, đang bị VU=1 lock
         → VU=4 phải ĐỢI VU=1 xong mới được PATCH

t=0.6s   VU=1 xong PATCH CART-A, release lock
         VU=4 được unlock, PATCH CART-A

t=0.8s   VU=3 xong, lấy iterInTest=12 -> PATCH cart_id=CART-A, item=staleItems[12]
         → Lại đụng CART-A, phải đợi VU=4 xong

Kết quả job_duration:
  staleItems[0]  (CART-A, không đợi):    job_duration = 0.55s
  staleItems[1]  (CART-B, không đợi):    job_duration = 0.28s
  staleItems[5]  (CART-A, đợi VU=1):     job_duration = 0.75s  ← spike!
  staleItems[12] (CART-A, đợi VU=4):     job_duration = 0.82s  ← spike!
  staleItems[20] (CART-Z, không đợi):    job_duration = 0.30s

Tổng: vẫn đủ 90 jobs, nhưng shared_job_duration_ms có tail dài
p50 = 0.35s, p95 = 0.80s, p99 = 0.90s
→ p95 > 2× p50 → dấu hiệu write contention
```

**Cách phát hiện write contention**:

```text
1. So sánh shared_job_duration_ms p95 vs p50:
   - Nếu p95 > 2× p50 → có tail đáng kể (có thể do contention)
   - Không kết luận ngay, cần xác nhận nguyên nhân

2. So sánh http_req_duration của PATCH vs GET:
   - PATCH p95 >> GET p95 → write path là bottleneck
   - PATCH p95 ≈ GET p95 → server latency đều, không phải write-specific

3. So sánh shared_job_duration_ms với http_req_duration:
   - job_duration ≈ PATCH_time + GET_time → không có wait time
   - job_duration >> PATCH_time + GET_time → có wait time (contention, queueing)
   - Ví dụ: PATCH avg=0.15s, GET avg=0.10s, nhưng job_duration avg=0.55s
     → 0.30s "mất tích" → có thể là lock wait hoặc queueing trong DB

4. Nếu có tag cart_id trong metric:
   - Filter theo cart_id, so sánh job_duration giữa các cart
   - Cart nào có nhiều item → job_duration cao hơn
```

**Bảng tóm tắt 4 nguyên nhân kỹ thuật**:

| # | Nguyên nhân | Biểu hiện | Cách phát hiện |
| --- | --- | --- | --- |
| 1 | Cleanup coverage gap | iterations < 90 hoặc cleanup lặp | So sánh iterations với JOBS |
| 2 | Wrong identity mapping | Chỉ 8 items unique được cleanup | Đếm unique job_id, so với JOBS |
| 3 | Update/Verify asymmetry | PATCH pass nhưng GET fail | Tách operation, check verify count |
| 4 | Write contention | job_duration tail dài, p95 >> p50 | So sánh p95/p50, PATCH vs GET latency |

---

### Tổng kết: chỉ shared-iterations thỏa mãn cả (a) và (b)

| Executor | (a) Exact total coverage | (b) Correct identity mapping | Verdict |
| --- | --- | --- | --- |
| **shared-iterations** | ✓ iterations cố định | ✓ nếu dùng iterationInTest | ✅ DÙNG |
| per-vu-iterations | ✓ count cố định | ✗ ép quota bằng nhau, VU không phải worker | ❌ |
| constant-vus (duration) | ✗ count phụ thuộc latency | ✗ VU random pick, identity không ổn định | ❌ |
| constant-arrival-rate | ✗ có thể drop | ✗ rate-driven, không bound vào job index | ❌ |
| ramping-vus | ✗ count biến thiên theo time | ✗ VU spawn lệch theo timeline | ❌ |
| ramping-arrival-rate | ✗ count biến thiên + drop | ✗ rate-driven, không bound job | ❌ |

→ Chỉ **shared-iterations** thỏa mãn cả 2 yêu cầu, các executor khác đều fail ở ít nhất 1 trong 2.

### 3 thông số config ánh xạ từ yêu cầu nghiệp vụ

```text
1. FIXED BACKLOG SIZE (tổng số job cố định):
   - Team cart có danh sách 90 stale items cần cleanup
   - Không phải "cleanup trong 5 phút", mà là "cleanup ĐỦ 90 items"
   → iterations = 90 (tổng job toàn scenario)
   → KHÔNG dùng duration làm input chính

2. WORKER POOL SIZE (số worker cùng xử lý):
   - 8 worker cùng cleanup để xong nhanh hơn
   - Không quan trọng worker nào làm bao nhiêu, miễn tổng đủ
   → vus = 8 (số worker)
   → KHÔNG cần mỗi VU cleanup đúng 90/8 items

3. COVERAGE COMPLETENESS (mỗi job đi qua đủ flow):
   - Mỗi job: PATCH update + GET summary verify = 2 API calls
   - 90 jobs × 2 API = 180 total API calls
   → http_reqs = 180 (deterministic, nếu không fail)
   → shared_api_calls_total = 180
   → Đặc biệt: GET verify là BẮT BUỘC — PATCH một mình không đủ
```

## Yêu cầu cứng của case này

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Tổng completed iterations phải bằng `90` | Vì `90` là kích thước backlog, thiếu 1 job là coverage incomplete. |
| `shared_jobs_total == 90` | Iteration chạy xong chưa đủ; job phải được mark hoàn tất end-to-end. |
| `shared_jobs_failed == 0` | Có failed job nghĩa là business contract không đạt. |
| `http_reqs/shared_api_calls_total == 90 × 2 = 180` | Mỗi job phải gọi đúng số API trong flow (PATCH + GET verify). |
| Operation counts phải khớp expected breakdown | Tổng HTTP đúng nhưng thiếu verify operation vẫn là coverage bug. |
| `cart_cleanup_summary_verify` count == 90 | PATCH accepted chưa đủ; phải verify được final state. |
| Job identity phải derive từ `exec.scenario.iterationInTest` | Worker identity `__VU` không đại diện cho business job. |
| Uneven per-VU distribution is normal | Worker nhanh xử lý nhiều job hơn là đúng mô hình shared pool. |

Nếu một trong các invariant về count/job fail, kết quả nên coi là **invalid hoặc fail**, không phải "pass nhưng hơi thiếu".

## Vì sao "stale cart cleanup backlog" nên dùng `shared-iterations`?

Mental model đúng:

```text
90 jobs đang nằm trong một queue/backlog.
8 VUs là 8 workers.
Worker nào rảnh thì lấy job kế tiếp.
Batch kết thúc khi queue hết job.
```

Nếu worker A xử lý 22 job còn worker B xử lý 6 job, điều đó không làm test sai. Nó chỉ nói worker A nhận được nhiều job hơn vì vòng lặp của nó quay lại sớm hơn.

### Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho fixed backlog? |
| --- | --- | --- |
| `shared-iterations` | Có tổng `iterations` chung và nhiều VU cùng chạy | **Đúng**: mô hình đúng là N job trong backlog, M worker xử lý đến khi hết việc. |
| `per-vu-iterations` | Count cũng deterministic | Sai nếu VU không phải business identity. Nó ép mỗi VU làm quota bằng nhau, không giống worker queue. Hơn nữa, cart cleanup không phải same-user cart journey — mỗi item là một record riêng. |
| `constant-vus` | Nhìn giống worker pool | Sai khi cần exact count: tổng việc phụ thuộc duration và latency, không bảo đảm xử lý đúng N job. Đặc biệt với write path, latency biến thiên mạnh hơn. |
| `constant-arrival-rate` | Kiểm soát được tốc độ vào | Sai cho batch drain: nó schedule arrivals theo rate, có thể drop, không phải danh sách job cố định cần xử lý hết. |
| `ramping-vus` | Có thể tăng/giảm worker | Sai nếu mục tiêu là exact backlog completion; shape VU biến thiên làm khó so sánh coverage. |
| `ramping-arrival-rate` | Mô phỏng traffic thay đổi | Sai cho fixed-job coverage; phù hợp traffic surge hơn là batch/checklist. |

Kết luận:

```text
Cần exact total backlog coverage -> shared-iterations.
Không cần mỗi VU có quota riêng -> không dùng per-vu-iterations.
Không lấy duration/rate làm input chính -> không dùng constant-vus/arrival-rate.
Write path càng củng cố lý do: latency biến thiên mạnh, count phải cố định để không bị nhiễu.
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

| Config/env | Giá trị | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `SI_04_VUS` | 8 | Số worker cùng xử lý backlog |
| `SI_04_JOBS` | 90 | Tổng số job toàn scenario |
| `maxDuration` | 8m | Safety cap, không phải target duration |
| `executor` | `shared-iterations` | Fixed global backlog + worker pool |

Mapping quan trọng:

```text
business backlog size = 90 jobs
k6 iterations         = 90
worker pool size      = 8 VUs
expected API calls    = 90 × 2 = 180
```

`maxDuration` chỉ là safety cap. Nếu cap này cắt run làm `iterations < 90`, kết quả không valid vì backlog chưa drain hết.

Operation coverage expected:

```text
cart_item_cleanup_update: 90
cart_cleanup_summary_verify: 90
```

## Technical semantics: shared backlog, worker pool, job identity

Cách k6 vận hành nên được hiểu như sau:

```text
1. Scenario có một global quota: iterations = 90.
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

### Identity model chi tiết: `__VU` vs `__ITER` vs `iterationInTest`

Đây là điểm quan trọng nhất khi code shared-iterations script. Ba khái niệm khác nhau:

```text
__VU:
  - Worker ID, từ 1 đến vus
  - VU=1 có thể chạy iter #0, #3, #7, #12... (nhiều job khác nhau)
  - KHÔNG dùng làm item ID, cart ID, stale item index

__ITER:
  - Local counter của từng VU, bắt đầu từ 0
  - VU=1: __ITER=0 → iter #0, __ITER=1 → iter #3, __ITER=2 → iter #7...
  - KHÔNG phải global job index
  - VU=1 __ITER=4 và VU=2 __ITER=4 là 2 job KHÁC NHAU

exec.scenario.iterationInTest:
  - Global job index, từ 0 đến iterations-1
  - DUY NHẤT cho mỗi iteration trong toàn scenario
  - Dùng làm business identity: stale item index, cleanup job ID...
```

**Demo trace identity model với 3 VU, 10 iter**:

```text
Config: vus=3, iterations=10

t=0.0s   VU=1: __VU=1, __ITER=0, iterationInTest=0  -> job #0
         VU=2: __VU=2, __ITER=0, iterationInTest=1  -> job #1
         VU=3: __VU=3, __ITER=0, iterationInTest=2  -> job #2

t=0.3s   VU=1 xong, lấy tiếp:
         VU=1: __VU=1, __ITER=1, iterationInTest=3  -> job #3

t=0.5s   VU=2 xong, lấy tiếp:
         VU=2: __VU=2, __ITER=1, iterationInTest=4  -> job #4

t=0.6s   VU=1 xong, lấy tiếp:
         VU=1: __VU=1, __ITER=2, iterationInTest=5  -> job #5

... tiếp tục đến iterationInTest=9 (job #9)

Tổng kết:
  VU=1 (nhanh): __ITER=0..4 (5 jobs), các iterationInTest=0,3,5,7,9
  VU=2 (vừa):   __ITER=0..2 (3 jobs), các iterationInTest=1,4,8
  VU=3 (chậm):  __ITER=0..1 (2 jobs), các iterationInTest=2,6
  Total: 5+3+2 = 10 jobs ✓

Code đúng:
  const itemIndex = exec.scenario.iterationInTest;  // 0..9
  const item = staleItems[itemIndex];
  // Mỗi job #0-#9 map sang staleItems[0]-staleItems[9], không trùng, không thiếu

Code sai:
  const item = staleItems[__VU - 1];  // VU=1 -> staleItems[0], VU=2 -> staleItems[1], VU=3 -> staleItems[2]
  // Chỉ 3 items được cleanup, lặp đi lặp lại
  // 7 items còn lại không bao giờ được cleanup
```

### Code pattern đúng cho shared-iterations cart cleanup

```js
import exec from "k6/execution";
import { check } from "k6";
import http from "k6/http";

const STALE_ITEMS = Array.from({ length: 90 }, (_, i) => ({
  item_id: `item-${String(i).padStart(4, "0")}`,
  cart_id: `cart-${String(Math.floor(i / 5)).padStart(3, "0")}`, // ~5 items per cart
}));

export default function () {
  // Lấy global job index — ĐÂY LÀ DÒNG QUAN TRỌNG NHẤT
  const jobIndex = exec.scenario.iterationInTest;  // 0..89
  const item = STALE_ITEMS[jobIndex];

  // Bước 1: PATCH update stale item
  const updateRes = http.patch(
    `${BASE_URL}/api/sim/cart/items/${item.item_id}?cpu_ms=1&db_writes=1`,
    JSON.stringify({ quantity: 0, status: "cleaned" }),
    { headers: { "Content-Type": "application/json" } }
  );
  check(updateRes, {
    "update status 200": (r) => r.status === 200,
  });

  // Bước 2: GET summary verify — BẮT BUỘC, không thể bỏ qua
  const verifyRes = http.get(
    `${BASE_URL}/api/sim/cart/summary?cpu_ms=1&db_rows=3&json_items=8`
  );
  check(verifyRes, {
    "verify status 200": (r) => r.status === 200,
  });
}
```

**KHÔNG viết thế này**:

```js
// SAI — dùng __VU làm identity
const item = STALE_ITEMS[__VU - 1];  // Chỉ cleanup 8 items, lặp đi lặp lại

// SAI — dùng __ITER làm identity
const item = STALE_ITEMS[__ITER];    // VU=1 __ITER=4 và VU=2 __ITER=4 trùng item

// SAI — chỉ PATCH, không GET verify
// Chỉ gọi PATCH xong check 200 rồi kết thúc job
// → Không biết final state có đúng không
// → Read-after-write consistency không được verify
```

### Vì sao KHÔNG có per-VU state như per-vu-iterations?

Trong per-vu-iterations, mỗi VU có state riêng (session, token, cart) sống qua nhiều iteration vì cùng VU luôn chạy iter cho cùng identity.

Trong shared-iterations, **không có per-VU persistent state hữu ích** vì:

```text
VU=1 chạy job #0 (staleItems[0]), xong chạy job #3 (staleItems[3]), xong chạy job #7 (staleItems[7])...
→ Mỗi job là một stale item khác nhau, có thể thuộc cart khác nhau
→ State của job #0 không dùng được cho job #3
→ Không cần giữ session/token/cart giữa các iter trong cùng VU
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

## Technical root causes this case catches

Phần trên đã phân tích 3 nguyên nhân trong ngữ cảnh identity mapping. Phần này mở rộng từng nguyên nhân với real-world analogy, demo trace chi tiết, code example, và detection method.

### Nguyên nhân kỹ thuật 1: Batch cleanup, not same-user cart journey

**Vấn đề**: Business target là 90 stale item records, không phải 8 users giữ cart session. VU chỉ là worker xử lý record. Đây là khác biệt CƠ BẢN với per-vu-iterations cart case.

**Real-world analogy**:

```text
Kho hàng có 90 món bị lỗi cần sửa (stale items).
8 công nhân được gọi vào sửa.
Mỗi công nhân không "sở hữu" món nào — họ chỉ là người sửa.
Công nhân nhanh sửa nhiều món, công nhân chậm sửa ít món.
Không ai nói "công nhân số 3 chịu trách nhiệm sửa mọi món trong kệ số 3".

SO SÁNH VỚI per-vu-iterations (same-user cart):
  8 khách hàng, mỗi người có 1 giỏ hàng riêng.
  Mỗi khách thêm/sửa/xóa item trong giỏ CỦA MÌNH.
  Khách A không đụng vào giỏ của khách B.
  → 8 VU = 8 users = 8 cart sessions (ĐÓ LÀ per-vu-iterations)
```

**Demo trace: shared-iterations cart cleanup vs per-vu-iterations cart session**:

```text
SHARED-ITERATIONS (cart cleanup — case này):
  VU=1 xử lý:
    job #0  -> PATCH staleItems[0]  (cart-A)
    job #8  -> PATCH staleItems[8]  (cart-B)
    job #15 -> PATCH staleItems[15] (cart-C)
    → Mỗi job là 1 item khác nhau, cart khác nhau
    → VU=1 là WORKER, không phải "chủ cart-A"

PER-VU-ITERATIONS (cart session — case KHÁC):
  VU=1 (user "alice") xử lý:
    iter #1 -> POST cart (tạo cart mới)
    iter #2 -> POST add item 1
    iter #3 -> POST add item 2
    iter #4 -> PATCH update quantity
    iter #5 -> GET cart summary
    → Tất cả iter cho CÙNG 1 cart của alice
    → VU=1 là USER "alice", không phải worker
```

**Cách phát hiện nhầm lẫn**:

```text
Dấu hiệu bạn đang nhầm shared-iterations với per-vu-iterations:
  1. Bạn nghĩ "mỗi VU nên xử lý 90/8 ≈ 11 items"
     → SAI. shared-iterations không đảm bảo phân phối đều.
  2. Bạn lưu cart_id trong VU state và dùng lại qua nhiều iter
     → SAI. Mỗi iter là 1 item/cart khác nhau trong shared-iterations.
  3. Bạn dùng __VU để chọn cart
     → SAI. __VU là worker, không phải cart.

Công thức kiểm tra nhanh:
  Nếu business entity (item, cart) THAY ĐỔI qua mỗi iteration
  → shared-iterations
  Nếu business entity (user, cart) CỐ ĐỊNH cho mỗi VU
  → per-vu-iterations
```

### Nguyên nhân kỹ thuật 2: Wrong `__VU` mapping skips items

**Vấn đề**: Nếu item id derive từ `__VU`, bạn chỉ cleanup vài worker identities lặp lại. Item identity phải derive từ global job index.

**Real-world analogy**:

```text
Danh sách 90 món cần sửa được đánh số #0 đến #89.
Có 8 công nhân, đeo thẻ số 1 đến 8.

Cách SAI: "Công nhân số 1 chỉ sửa món số 1, công nhân số 2 chỉ sửa món số 2..."
  → Công nhân 1 sửa món #1 tới 15 lần (vô ích)
  → Công nhân 8 sửa món #8 tới 10 lần (vô ích)
  → 82 món còn lại KHÔNG AI SỬA

Cách ĐÚNG: "Ai rảnh thì lấy món tiếp theo trong danh sách"
  → Công nhân 1: sửa món #0, #3, #7, #12, #18...
  → Công nhân 2: sửa món #1, #5, #10, #16...
  → Mỗi món được sửa ĐÚNG 1 LẦN
  → Tất cả 90 món đều được sửa
```

**Demo chi tiết với số**:

```text
Config: vus=8, iterations=90
staleItems = [item-0000, item-0001, ..., item-0089]

Sử dụng __VU (SAI):
  VU=1: 15 iter, luôn cleanup item-0000 → 15 lần
  VU=2: 12 iter, luôn cleanup item-0001 → 12 lần
  VU=3: 12 iter, luôn cleanup item-0002 → 12 lần
  VU=4: 11 iter, luôn cleanup item-0003 → 11 lần
  VU=5: 10 iter, luôn cleanup item-0004 → 10 lần
  VU=6: 10 iter, luôn cleanup item-0005 → 10 lần
  VU=7: 10 iter, luôn cleanup item-0006 → 10 lần
  VU=8: 10 iter, luôn cleanup item-0007 → 10 lần

  Tổng: 90 iter
  Unique items cleaned: 8
  Missed items: 82 (item-0008 đến item-0089)
  Coverage: 8/90 ≈ 9%

Sử dụng iterationInTest (ĐÚNG):
  iter #0:  item-0000 (do VU=1)
  iter #1:  item-0001 (do VU=2)
  ...
  iter #89: item-0089 (do VU=5)

  Tổng: 90 iter
  Unique items cleaned: 90
  Missed items: 0
  Coverage: 90/90 = 100%
```

**Detection**: đếm số unique `job_id` (derive từ `iterationInTest`). Nếu < JOBS → identity mapping sai.

### Nguyên nhân kỹ thuật 3: Update must be verified (read-after-write)

**Vấn đề**: PATCH 200 chỉ chứng minh command được accept. Summary GET xác nhận final cart state sau cleanup. Đây là bài toán "read-after-write consistency" — viết xong phải đọc lại để chắc chắn.

**Real-world analogy**:

```text
Bạn gửi thư yêu cầu sửa sổ sách kế toán (PATCH).
Bưu điện báo "đã nhận thư" (HTTP 200).
Nhưng bạn KHÔNG BIẾT:
  - Thư có được chuyển đến kế toán không?
  - Kế toán đã sửa sổ chưa?
  - Sửa có đúng không?

→ Bạn phải gọi điện cho kế toán để kiểm tra sổ (GET summary verify).
→ Nếu kế toán nói "sổ đã đúng", bạn mới biết cleanup thành công.
→ Nếu kế toán không nghe máy / sổ vẫn sai, cleanup chưa hoàn tất.
```

**Demo trace: 3 trường hợp PATCH 200 nhưng kết quả khác nhau**:

```text
Trường hợp 1 — PATCH 200 + GET 200 = CLEANUP THÀNH CÔNG:
  Job #5: PATCH /cart/items/item-0005 → 200 OK (write accepted)
          GET  /cart/summary          → 200 OK (verify: quantity=0, status=cleaned)
  → Cleanup item-0005 hoàn tất ✓

Trường hợp 2 — PATCH 200 + GET 500 = CLEANUP KHÔNG XÁC ĐỊNH:
  Job #12: PATCH /cart/items/item-0012 → 200 OK (write accepted)
           GET  /cart/summary           → 500 ERR (DB read replica lag, chưa thấy update)
  → Không biết item-0012 đã được cleanup chưa
  → KHÔNG THỂ kết luận cleanup pass ❌

Trường hợp 3 — PATCH 200 + GET 200 nhưng data sai = CLEANUP SAI:
  Job #34: PATCH /cart/items/item-0034 → 200 OK (write accepted)
           GET  /cart/summary           → 200 OK (verify pass HTTP)
           Nhưng check body: quantity vẫn = 5 (chưa được set về 0!)
  → PATCH và GET đều 200, nhưng data KHÔNG đúng
  → Cần check body, không chỉ check status ❌
```

**Cách phát hiện**:

```text
1. Đếm cart_cleanup_summary_verify count:
   - Nếu < 90 → có job bỏ qua verify (code bug hoặc early return)
   - Nếu = 90 nhưng có failed > 0 → verify fail

2. Kiểm tra check không chỉ status code:
   check(verifyRes, {
     "verify status 200": (r) => r.status === 200,
     "verify quantity zero": (r) => r.json("quantity") === 0,  // ← QUAN TRỌNG
   });

3. So sánh latency PATCH vs GET:
   - Nếu GET chậm hơn PATCH đáng kể → có thể read replica lag
   - Nếu GET có p99 spike → một số verify request đụng cold cache hoặc lock
```

### Nguyên nhân kỹ thuật 4: Write contention (cùng cart/DB partition)

**Vấn đề**: Một số cleanup jobs có thể chạm cùng cart/DB partition. `shared_job_duration_ms` cao có thể chỉ ra lock/write contention.

**Real-world analogy**:

```text
90 món hàng hỏng nằm rải rác trong 18 kệ (mỗi kệ ~5 món).
8 công nhân cùng vào kho sửa.

Nếu 8 công nhân vào 8 kệ KHÁC NHAU:
  → Mỗi người 1 kệ, không ai đợi ai
  → Tốc độ nhanh nhất có thể

Nếu 3 công nhân cùng vào 1 kệ (vì kệ đó có nhiều món hỏng):
  → 1 người sửa, 2 người đợi bên ngoài
  → Tổng thời gian tăng vì wait time
  → Kệ đó trở thành "hotspot"
```

**Demo trace write contention chi tiết**:

```text
Giả sử staleItems phân bố: mỗi cart_id có 5 items (90/5 = 18 carts)
Cart "cart-000" có items: item-0000, item-0001, item-0002, item-0003, item-0004

8 VU start:
t=0.0s   VU=1: iterInTest=0  -> PATCH item-0000 (cart-000)
         VU=2: iterInTest=1  -> PATCH item-0001 (cart-000) ← ĐỤNG cart-000, đợi lock
         VU=3: iterInTest=2  -> PATCH item-0002 (cart-000) ← ĐỤNG cart-000, đợi lock
         VU=4: iterInTest=3  -> PATCH item-0003 (cart-000) ← ĐỤNG cart-000, đợi lock
         VU=5: iterInTest=4  -> PATCH item-0004 (cart-000) ← ĐỤNG cart-000, đợi lock
         VU=6: iterInTest=5  -> PATCH item-0005 (cart-001) ← OK, cart khác
         VU=7: iterInTest=6  -> PATCH item-0006 (cart-001) ← ĐỤNG cart-001, đợi VU=6
         VU=8: iterInTest=7  -> PATCH item-0007 (cart-001) ← ĐỤNG cart-001, đợi

  → 5 VU cùng đợi lock trên cart-000
  → 2 VU đợi lock trên cart-001
  → Chỉ VU=1 và VU=6 thực sự làm việc
  → 6 VU còn lại IDLE vì lock contention!

t=0.3s   VU=1 xong item-0000, release lock cart-000
         VU=2 được lock, PATCH item-0001
         VU=3,4,5 vẫn đợi...

t=0.6s   VU=2 xong item-0001, release lock cart-000
         VU=3 được lock, PATCH item-0002
         ...

Kết quả job_duration cho cart-000 items:
  item-0000 (lấy lock ngay):     job_duration = 0.30s
  item-0001 (đợi 0.30s):         job_duration = 0.60s
  item-0002 (đợi 0.60s):         job_duration = 0.90s
  item-0003 (đợi 0.90s):         job_duration = 1.20s
  item-0004 (đợi 1.20s):         job_duration = 1.50s

→ Cùng 1 business operation, nhưng job_duration tăng dần theo vị trí queue
→ p50 = 0.35s, p95 = 1.50s  (p95 > 4× p50!)
→ Dấu hiệu RÕ RÀNG của write contention trên hot partition
```

**Cách phát hiện write contention**:

```text
1. shared_job_duration_ms distribution:
   - p95 > 2× p50 → có tail
   - p99 >> p95 → extreme outliers
   - max >> p99 → vài job bị kẹt rất lâu

2. Tách http_req_duration theo method:
   - PATCH p95 >> GET p95 → write path là bottleneck
   - Cả PATCH và GET đều cao → server-wide issue, không phải write-specific

3. Tính "wait time" = job_duration - (PATCH_time + GET_time):
   - Nếu wait time > 20% job_duration → có contention hoặc queueing
   - Ví dụ: job_duration=0.80s, PATCH=0.15s, GET=0.10s
     → wait time = 0.80 - 0.25 = 0.55s (69% là wait time!)

4. Nếu có tag cart_id:
   - Group by cart_id, so sánh avg job_duration
   - Cart có nhiều items → job_duration cao hơn (do contention)
```

**Bảng shape analysis cho write contention**:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| PATCH p95 > 2× GET p95 | Write path bottleneck, có thể lock contention | Điều tra DB write path, index, lock strategy |
| job_duration p95 > 2× (PATCH avg + GET avg) | Wait time lớn, worker phải đợi lock | Kiểm tra partition key, xem xét phân tán cart |
| job_duration tăng dần theo thời gian run | Contention tích lũy, queue build-up | Giảm vus hoặc tăng phân mảnh |
| p95 ổn nhưng max spike lẻ tẻ | Vài outlier do GC pause hoặc network blip | Xem log, chưa vội fail |
| Cả PATCH và GET cùng tăng | Server-wide degradation | Điều tra infra, không phải code bug |

## Service/API flow

| Operation | Method | Path | Service | Expected | Expected count | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| cart_item_cleanup_update | `PATCH` | `/api/sim/cart/items/:item_id?cpu_ms=1&db_writes=1` | cart-service | `200` | 90 | Update/cleanup stale line item. |
| cart_cleanup_summary_verify | `GET` | `/api/sim/cart/summary?cpu_ms=1&db_rows=3&json_items=8` | cart-service | `200` | 90 | Verify summary sau cleanup. |

Một job chỉ được coi là hoàn tất khi các operation cần thiết của job đó đã pass theo contract. PATCH 200 một mình KHÔNG ĐỦ — phải có GET verify 200 + check body data.

## Metrics và tags cần đọc

| Metric | Type | Expected | Nó chứng minh gì? |
| --- | --- | --- | --- |
| `shared_jobs_total` | Counter | `count == JOBS` | Bao nhiêu business job đã hoàn tất end-to-end. |
| `shared_jobs_failed` | Counter | `count == 0` | Có job nào fail ở tầng business không. |
| `shared_api_calls_total` | Counter | khớp công thức API/job | Helper đã gửi đúng số API calls theo flow chưa. |
| `shared_job_duration_ms` | Trend | `count == JOBS` | Thời gian end-to-end của từng job, không chỉ từng request. Đặc biệt quan trọng để phát hiện write contention. |
| `shared_sleep_seconds` | Counter | tùy case | Tổng sleep/think/wait time nếu script mô phỏng delay. |

Tags chung:

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `si-04-cart-cleanup`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service đang được gọi. |
| `operation` | Bước nghiệp vụ/API cụ thể trong job. |
| `endpoint` | Nhóm endpoint/API family. |
| `job_id` | Business job trong backlog, derive từ global job index. |
| `executor_family` | `shared_iterations`. |
| `workload_shape` | `fixed_backlog`. |

Tags case này:

```text
case_id       = si-04-cart-cleanup
business_case = stale_cart_cleanup
service       = cart-service
```

## Pass criteria

Pass criteria tối thiểu:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 90
shared_jobs_failed count == 0
iterations count == 90
http_reqs count == 180
shared_api_calls_total count == 180
```

Operation breakdown phải khớp:

```text
cart_item_cleanup_update: 90
cart_cleanup_summary_verify: 90
```

Đừng thêm pass condition kiểu:

```text
mỗi VU phải xử lý 90 / 8 ≈ 11 jobs
```

Vì đó không phải invariant của `shared-iterations`.

Đặc biệt với case này: **cart_cleanup_summary_verify count PHẢI = 90**. Nếu verify < 90, dù PATCH đủ 90, test vẫn FAIL vì không chứng minh được final state đúng.

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-04-cart-cleanup.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js
```

Nếu backend script chưa có trong working tree, chỉ đọc phần expected formula trước; không tự điền run data.

## Đọc output summary

Áp 5 bước giống cách đọc các case per-vu, nhưng invariant đổi sang **total backlog**, không phải per-user quota.

### Bước 1 — Verify scenario/config

Header phải thể hiện:

```text
executor = shared-iterations
vus = 8 hoặc env override
total iterations/jobs = 90 hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ expected counts.

### Bước 2 — Compute expected total jobs

Default case này:

```text
JOBS = 90
API_PER_JOB = 2
expected iterations = 90
expected http_reqs = 90 × 2 = 180
```

### Bước 3 — Compare summary counters

Expected:

```text
iterations == 90
shared_jobs_total == 90
shared_jobs_failed == 0
```

Nếu `iterations < 90`:

```text
backlog chưa drain hết -> invalid result
→ maxDuration cắt? Tăng maxDuration.
→ iter_time quá dài? Giảm workload hoặc tăng vus.
→ Write contention quá nặng? Kiểm tra DB partition strategy.
```

Nếu `iterations == 90` nhưng `shared_jobs_total < 90`:

```text
iteration chạy xong nhưng job completion instrumentation/business branch bị thiếu
→ Kiểm script: có gọi jobDone() sau mỗi iteration không?
→ Có exception/early return nào bỏ qua job completion không?
→ Đặc biệt: verify GET fail có làm script return sớm trước jobDone() không?
```

### Bước 4 — Compare API and operation counts

Expected:

```text
http_reqs == 180
shared_api_calls_total == 180
cart_item_cleanup_update: 90
cart_cleanup_summary_verify: 90
```

Tổng HTTP đúng nhưng operation split sai vẫn là coverage bug:

```text
VD: http_reqs = 180, nhưng:
  cart_item_cleanup_update: 100
  cart_cleanup_summary_verify: 80
→ 10 items chỉ có PATCH, thiếu verify
→ Verify coverage = 80/90 = 89% -> FAIL
→ Có thể do verify GET fail/timeout nhưng script không retry
→ Hoặc code bug: verify nằm trong if block không được execute
```

Đặc biệt nguy hiểm với case này:

```text
VD: http_reqs = 180, nhưng:
  cart_item_cleanup_update: 90
  cart_cleanup_summary_verify: 90
  Nhưng cart_cleanup_summary_verify có 5 failed (status != 200)

→ Tổng HTTP request vẫn 180, operation count vẫn 90/90
→ Nhưng 5 verify FAILED → 5 items không xác nhận được final state
→ http_req_failed = 5/180 = 2.8%
→ Có thể bị bỏ qua nếu threshold http_req_failed < 5%
→ Phải check BOTH operation count AND operation failed count
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

Hai metric này khác nhau. Job nhiều API có thể có từng request nhanh nhưng full lifecycle vẫn chậm. Đặc biệt với case này, `shared_job_duration_ms` CÓ THỂ chứa wait time do write contention.

```text
Nếu shared_job_duration_ms >> (PATCH http_req_duration + GET http_req_duration):
  → Có wait time giữa 2 request
  → Có thể do write contention, lock wait, hoặc DB queueing
  → Đây là tín hiệu QUAN TRỌNG không thấy được nếu chỉ nhìn http_req_duration

Công thức ước lượng wait time:
  wait_time ≈ job_duration - (PATCH_duration + GET_duration)

  Ví dụ: job_duration avg = 0.55s
         PATCH_duration avg = 0.12s
         GET_duration avg = 0.08s
         wait_time ≈ 0.55 - 0.20 = 0.35s (64% của job_duration!)
         → Có vấn đề về contention hoặc queueing
```

Case-specific summary notes:

- `iterations = 90` chứng minh đủ số stale item jobs đã chạy.
- `http_reqs = shared_api_calls_total = 180` chứng minh mỗi job đi qua 2 API calls.
- Operation breakdown phải là PATCH 90 và GET verify 90; thiếu verify nghĩa là final state không được xác nhận.
- Update pass nhưng summary fail nghĩa là final state không đáng tin — PATCH accepted nhưng read-after-write không nhất quán.
- `shared_job_duration_ms` p95 >> p50 là dấu hiệu write contention, cần điều tra DB partition.

Không check mỗi VU làm bằng nhau. Invariant là total completed work, không phải equal work per VU.

## Đọc dashboard real-time charts cho case 04

> Phần này mô tả expected reading pattern. Chỉ bổ sung run ID, p95/p99/max, bucket arrays sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? bucket nào có tail latency? Write path có bottleneck không? | Backlog đã xử lý đủ chưa |
| Execution timeline | Theo thời gian đã hoàn tất bao nhiêu iterations/http_reqs/jobs? | Mỗi VU có làm bằng nhau không |
| VUs vs iter/s | Worker pool drain backlog nhanh/chậm ra sao? | Business correctness của từng job |

Một cách đọc nhanh:

```text
Response time      -> chất lượng request, phát hiện bottleneck (đặc biệt write path)
Execution timeline -> backlog drain progress, phát hiện thiếu coverage
VUs vs iter/s      -> worker pool shape, phát hiện bất thường throughput
```

### Chart 1 — Response time

Đây là request-level latency. Với case này, đọc theo `operation`:

```text
cart_item_cleanup_update: 90
cart_cleanup_summary_verify: 90
```

Cách đọc:

```text
avg  -> request thường nhanh/chậm thế nào
p95  -> phần lớn request có tail tới đâu
p99  -> tail hiếm hơn
max  -> spike lớn nhất trong bucket/run
```

Nhưng đừng kết luận pass/fail chỉ từ latency. Response time chỉ giúp tìm bottleneck.

#### Cách phân tích sâu chart Response time

Khi nhìn chart này, đừng chỉ nhìn "cao/thấp". Hãy đọc theo 4 câu hỏi:

```text
1. Avg response có ổn định không?
2. PATCH p95 có cao hơn GET p95 không? (write path bottleneck?)
3. Batch p95 có spike ở đoạn nào?
4. Batch max có outlier lớn không?
```

Với case 04, shape đẹp thường có:

```text
đầu run:  p95/max có thể cao hơn (cold start, connection pool init)
giữa run: p95 ổn định thấp hơn
cuối run: p95 không tăng bất thường
PATCH p95 ≈ GET p95 (không có write-specific bottleneck)
```

Vì sao đầu run dễ cao hơn?

```text
- Request đầu tiên tới server có thể cold (cache miss, connection pool init)
- 8 VU cùng start -> request burst đầu lớn
- DB write path có thể cần warmup (buffer pool, index load)
```

Case-specific bottleneck hints:

- `cart_item_cleanup_update` có `db_writes=1` nên thường là path cần soi latency đầu tiên. Nếu PATCH p95 >> GET p95, write path đang là bottleneck.
- `cart_cleanup_summary_verify` có `db_rows=3&json_items=8`, query có thể nặng hơn nếu thiếu index. Giúp phát hiện read-after-write/state inconsistency qua latency pattern.
- Case này không kết luận lost-update same-user; đó là mục tiêu của per-vu cart concurrency case.
- Nếu GET p95 TĂNG DẦN theo thời gian run → có thể DB read replica đang lag sau nhiều PATCH.

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 cao ngay từ đầu rồi ổn định | cold start, cache miss đầu | kiểm cart-service cache + DB pool |
| PATCH p95 > 2× GET p95 | write path bottleneck, lock contention | soi DB write path, index, lock strategy |
| GET p95 > 2× PATCH p95 | read query nặng (db_rows=3, json_items=8) | kiểm GET query plan, index |
| p95 tăng dần càng về cuối | contention tích lũy, queue build-up | giảm vus hoặc tăng partition |
| max spike lẻ tẻ nhưng p95 ổn | vài outlier đơn lẻ (GC, network) | xem log nhưng chưa vội fail |
| p95 và max cùng spike nhiều bucket | vấn đề hệ thống thật | chặn / điều tra backend |
| Cả PATCH và GET cùng cao | server-wide degradation | điều tra infra |

### Chart 2 — Execution timeline

Chart này chứng minh backlog drain đủ theo thời gian.

Kiểm tổng bucket:

```text
sum(iterations buckets) == 90
sum(http_reqs buckets) == 180
sum(shared_jobs_total buckets) == 90
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
  Live VUs = config VUs (8)
  RPS cao vì tất cả VU cùng hoạt động

giữa run:
  Live VUs vẫn gần 8 nếu backlog còn nhiều
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
| `http_reqs` đủ nhưng operation split sai | tổng request đủ nhưng coverage lệch (thiếu verify) |
| `shared_jobs_failed > 0` | business failure dù HTTP có thể vẫn 200 |
| buckets không cộng ra summary | đọc nhầm point/bucket hoặc data chưa final |
| Live VUs không lên đủ 8 từ đầu | VU init có vấn đề, config/env sai |
| Live VUs giữ cao nhưng iterations không tăng | VU bị kẹt trong request (write contention nặng), backend chậm |
| http_reqs tăng đều nhưng iterations tăng chậm | job cần 2 API, request xong trước khi job complete |

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
- 8 VU cùng chạy (mỗi VU đang ở 1 job khác nhau)
- Nhiều HTTP request hoàn thành (cả PATCH + GET verify)
- Một số iteration/job hoàn thành
- Nhiều check pass/fail
```

Điều kiện để một event rơi vào bucket nào:

```text
event timestamp thuộc giây nào -> rơi vào bucket giây đó
```

#### Vì sao bucket đầu có thể có httpReqs > 0 nhưng iterations = 0?

```text
Bucket đầu: VU vừa start, request đầu đã xong (PATCH endpoint)
nhưng full job (PATCH + GET verify + check) chưa hoàn tất

→ httpReqs > 0 (request-level metric đến sớm)
→ iterations = 0 (job-level metric đến muộn hơn, cần full flow xong)
```

### Chart 3 — VUs vs iter/s

Chart này giải thích worker-pool shape:

```text
- VUs gần 8 khi backlog còn nhiều việc
- iter/s tăng/giảm theo latency và số API/job
- VUs có thể tụt ở tail khi backlog gần hết
- fast VUs có thể xử lý nhiều job hơn slow VUs
```

#### Cách phân tích sâu chart VUs vs iter/s

Chart này trả lời câu hỏi:

```text
Worker pool drain backlog nhanh/chậm ra sao?
Throughput iteration có bám theo shape VU không?
Có dấu hiệu write contention làm giảm throughput không?
```

Với `shared-iterations`, đường `Executor VUs` và `Actual iter/s` có quan hệ:

```text
peak_rate ≈ vus / iter_time
         ≈ 8 / iter_time

Nếu iter_time avg = 0.5s:
  peak_rate ≈ 8 / 0.5 ≈ 16 iter/s

Nếu iter_time avg = 1.2s (write contention):
  peak_rate ≈ 8 / 1.2 ≈ 6.7 iter/s
```

Đừng đọc chart này thành:

```text
mỗi VU phải xử lý 90 / 8 ≈ 11 jobs
```

Với `shared-iterations`, đó là yêu cầu sai.

Shape mong đợi:

```text
- đầu run: iter/s có thể 0 (chưa job nào xong)
- giữa run: iter/s dao động theo batch hoàn thành
- cuối run: iter/s tụt khi backlog gần hết, rồi về 0
- đường VUs: gần 8 ở đầu/giữa, tụt ở cuối
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| `Actual iter/s` đầu = 0, sau đó tăng | job đầu chưa hoàn tất | bình thường |
| `Actual iter/s` dao động theo bucket | nhiều job finish không cùng thời điểm | bình thường |
| `Actual iter/s` = 0 lâu trong khi VUs cao | VU bị kẹt trong request, backend chậm hoặc write contention | cần điều tra |
| `Actual iter/s` thấp hơn expected dù VUs đủ | iter_time dài (có thể do write contention) | so sánh PATCH vs GET latency |
| `Actual iter/s` tụt về 0 và VUs cũng về 0 | test xong quota | bình thường |
| sum `Actual iter/s` < expected total | thiếu iteration / drop / interrupt | test invalid |
| VUs không lên tới 8 | config/env sai, VU init lỗi | kiểm header |

### Cách chốt từ summary -> 3 chart

```text
1. Summary quyết định pass/fail bằng counters/thresholds.
2. Execution timeline xác nhận backlog drain đủ theo thời gian.
3. Response time tìm operation/service chậm — đặc biệt so sánh PATCH vs GET.
4. VUs vs iter/s giải thích worker pool hoạt động ra sao.
5. Business decision dựa trên total coverage + failed jobs + operation breakdown + verify completion.
```

## Kết luận thực tế: output -> quyết định

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **cart cleanup gate**: output ra số như vậy thì team quyết định gì với việc cleanup/migration?

### Kịch bản A — output sạch: CART CLEANUP PASS

```text
iterations.........: 90         (đủ backlog)
http_req_failed....: 0.00%
shared_jobs_total..: 90
shared_jobs_failed.: 0
cart_item_cleanup_update: 90
cart_cleanup_summary_verify: 90
shared_job_duration_ms: p(95)=0.65s
```

Kết luận thực tế:

```text
- Count đủ 90 -> toàn bộ stale items đã được cleanup (yêu cầu a)
- 0 fail, 0 job failed -> không item nào lỗi
- Operation breakdown đúng 90/90 -> cả PATCH và verify đều đủ coverage
- Verify đủ 90 -> read-after-write consistency được xác nhận
- p95 0.65s -> latency OK, không có write contention đáng kể
=> QUYẾT ĐỊNH: cart cleanup OK. Cho phép TTL job / migration hoàn tất.
```

### Kịch bản B — update pass nhưng summary verify fail: BLOCK

```text
iterations.........: 90         (vẫn đủ!)
shared_jobs_total..: 90
cart_item_cleanup_update: 90   (PATCH đủ)
cart_cleanup_summary_verify: 78 (THIẾU 12 VERIFY)
shared_jobs_failed.: 8
http_req_failed....: 4.4%      (8/180)
```

Kết luận thực tế:

```text
- Count vẫn 90 -> KHÔNG phải lỗi test, coverage attempt đủ
- PATCH đủ 90 -> tất cả update command đã được gửi và accepted
- Nhưng verify chỉ 78/90 -> 12 items không xác nhận được final state
- 8 job failed -> 8 items có vấn đề
- Có thể do: DB read replica lag, write chưa commit khi GET verify
- Hoặc: verify endpoint có bug, timeout, hoặc trả về data không khớp
=> QUYẾT ĐỊNH: BLOCK. Route theo job_id để tìm 12 items verify fail.
   Đây CHÍNH LÀ giá trị của verify step: PATCH accepted không có nghĩa
   cleanup thành công. Phải verify được final state mới pass.
   Nếu không có GET verify, test đã pass (vì PATCH đủ 90, 0 fail).
```

### Kịch bản C — thiếu iteration: TEST INVALID

```text
iterations.........: 58         (THIẾU 32!)
http_req_failed....: 1.7%
interrupted........: 32
shared_job_duration_ms: p(95)=2.50s  (rất cao!)
```

Kết luận thực tế:

```text
- 58 < 90 -> backlog chưa drain hết -> KHÔNG kết luận được cleanup có OK không
- shared_job_duration_ms p95 = 2.50s -> job chạy rất chậm
  → Có thể do write contention nặng, hoặc server quá tải
- Trước khi nói gì về cleanup, phải sửa cho test chạy đủ 90 đã:
    interrupted=32 -> maxDuration quá ngắn cho workload hiện tại?
    Tăng maxDuration.
    Hoặc iter_time quá dài? Giảm workload (bớt db_writes) hoặc tăng vus.
    Nếu write contention là nguyên nhân -> điều tra DB partition strategy.
=> QUYẾT ĐỊNH: CHƯA kết luận cleanup pass/fail. Test invalid, chạy lại
   sau khi sửa nguyên nhân thiếu count.
```

### Kịch bản D — count đủ nhưng write contention spikes: CAUTION

```text
iterations.........: 90         (đủ!)
shared_jobs_total..: 90
shared_jobs_failed.: 0
cart_item_cleanup_update: 90
cart_cleanup_summary_verify: 90
http_req_failed....: 0.00%

shared_job_duration_ms: avg=0.55s, p(50)=0.35s, p(95)=1.50s, p(99)=2.10s
```

Kết luận thực tế:

```text
- Tất cả counters pass: 90 jobs, 0 fail, operation breakdown đúng
- Functional: PASS — cleanup đã hoàn tất cho tất cả 90 items
- NHƯNG: p95 = 1.50s >> p50 = 0.35s (gấp > 4 lần!)
- Và p99 = 2.10s >> p95 = 1.50s
→ Dấu hiệu RÕ RÀNG của write contention
→ Một số job bị kẹt rất lâu trong khi đa số job nhanh

=> QUYẾT ĐỊNH: Functional PASS, nhưng CAUTION về performance.
   - Ghi nhận write contention risk ở production scale lớn hơn
   - Điều tra DB partition strategy: có quá nhiều item chung cart không?
   - Nếu cleanup chạy định kỳ với backlog lớn hơn (vd 9000 items),
     write contention có thể làm job timeout hoặc backlog không drain kịp
   - Cân nhắc: tăng partition, dùng batch update, hoặc giảm concurrent workers
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 90 iter, update=90, verify=90, 0 fail | cleanup hoàn tất, mọi item OK | cho phép TTL job / migration |
| update=90, verify < 90, shared_jobs_failed > 0 | PATCH accepted nhưng verify fail | block, route theo job_id điều tra |
| update=90, verify=90 nhưng verify có failed | verify gọi được nhưng response lỗi | block, kiểm verify endpoint |
| < 90 iter (drop/interrupt) | test chưa hợp lệ, backlog chưa drain hết | sửa config, chạy lại |
| http_reqs = 180 nhưng operation split sai | coverage gap ẩn (thiếu verify) | sửa script, kiểm branch logic |
| Counts pass nhưng shared_job_duration_ms p95 >> p50 | write contention | caution, điều tra DB partition |
| Counts pass nhưng PATCH p95 >> GET p95 | write path bottleneck | tune DB writes, lock strategy |
| VU distribution uneven | normal worker-pool behavior | do not fail |

Điểm cốt lõi của case này: **vì count luôn cố định 90, mọi thiếu hụt ở verify step hoặc failed jobs đều là tín hiệu THẬT về cleanup, không bị nhiễu bởi "lần này test chạy nhiều/ít hơn lần trước"**. Và **verify step là BẮT BUỘC** — PATCH 200 không đủ để kết luận cleanup thành công.

## "Nghịch lý" và misconceptions của shared-iterations

### Nghịch lý 1: 90 items nhưng 180 HTTP calls? Tại sao gấp đôi?

```text
Đây là câu hỏi phổ biến: "Có 90 items cần cleanup, sao lại cần tới 180 HTTP requests?"

Trả lời: Vì mỗi item cần 2 operations:
  1. PATCH — thực hiện cleanup (sửa/correct item)
  2. GET verify — xác nhận final state sau cleanup

90 items × 2 operations = 180 HTTP requests

Tưởng tượng:
  Bạn có 90 hóa đơn cần sửa.
  Mỗi hóa đơn bạn phải:
    1. Gạch số cũ, viết số mới (PATCH)
    2. Đọc lại toàn bộ hóa đơn để chắc chắn đã đúng (GET verify)
  → 90 hóa đơn × 2 thao tác = 180 thao tác

Nếu CHỈ làm PATCH (90 requests):
  - Bạn KHÔNG BIẾT hóa đơn đã đúng chưa
  - Có thể bạn gạch sai, viết sai, hoặc sổ chưa cập nhật
  - Test vẫn "pass" với 90 requests, 0 fail
  - Nhưng cleanup thực tế có thể SAI

→ 180 requests KHÔNG phải "lãng phí".
→ Đó là design CỐ Ý: update + verify = read-after-write consistency.
```

### Nghịch lý 2: Cùng cart_id xuất hiện trong nhiều job — sao không isolate?

```text
"Mỗi item có cart_id. Nhiều item có thể chung cart_id.
 Vậy khi 2 worker cùng cleanup 2 items của cùng 1 cart,
 có bị conflict không? Có nên isolate không?"

Trả lời: CÓ thể conflict — đó CHÍNH LÀ write contention (nguyên nhân 4).
Nhưng đây là tính chất CỐ HỮU của dữ liệu thực tế, không phải bug test.

Trong thực tế:
  - Một cart có thể có nhiều line items
  - TTL job hoặc migration có thể tạo ra nhiều stale items trong cùng cart
  - Backend PHẢI xử lý được concurrent updates trên cùng cart

Nếu bạn "isolate" bằng cách đảm bảo mỗi worker chỉ xử lý items từ 1 cart:
  - Bạn đang né vấn đề, không test được write contention thực tế
  - Production sẽ có nhiều request concurrent trên cùng cart
  - Test của bạn không phản ánh thực tế

Thay vào đó:
  - Để test tự nhiên, cho phép write contention xảy ra
  - Dùng shared_job_duration_ms để ĐO contention
  - Nếu contention quá nặng (p95 >> p50), đó là tín hiệu để tune backend
  - KHÔNG sửa test để né contention — đó là che dấu vấn đề

→ Write contention là FEATURE của test này, không phải bug.
→ Nó giúp phát hiện vấn đề partition/lock strategy TRƯỚC khi lên production.
```

### Nghịch lý 3: iteration_duration = 0.5s nhưng iter/s = 16?

```text
iteration_duration: avg=0.5s     <- 1 job mất 0.5 giây
iterations:         16/s         <- nhưng 1 giây ra 16 job

Sao 1 job mất 0.5s mà mỗi giây lại ra được 16 job?
"Lẽ ra 0.5s mới ra 1 job chứ?"
```

**Trả lời: vì 8 VU chạy SONG SONG, không phải 1 VU.**

```text
iteration_duration = thời gian 1 VU làm xong 1 job = 0.5s
iterations rate    = tổng job hoàn thành / tổng thời gian (cả pool) = 16/s

Công thức nối 2 con số (Little's Law):
  rate = vus / iter_time
  16 ≈ 8 / 0.5 ✓

Ví dụ trực quan:
  8 công nhân, mỗi người sửa 1 món mất 0.5 phút:
    - 1 món VẪN mất 0.5 phút (không nhanh hơn)
    - nhưng 8 người sửa song song -> mỗi phút ra ~16 món
```

## Checklist đọc biểu đồ case 04

Khi học sinh nhìn dashboard case 04, đọc theo thứ tự này:

```text
1. Overview KPI
   - iterations = 90?
   - http_req_failed = 0%?
   - checks = 100%?

2. Response time chart
   - Tách theo operation (PATCH vs GET verify) chưa?
   - Operation nào chậm hơn?
   - PATCH p95 có >> GET p95 không? (write contention dấu hiệu)
   - batch p95 đầu có spike không?
   - cuối test còn spike không?
   - GET p95 có tăng dần theo thời gian không? (read replica lag)

3. Execution timeline
   - Live VUs đầu có = 8 không?
   - cuối run VUs có tụt dần về 0 không?
   - sum iterations theo bucket có = 90 không?
   - sum http_reqs theo bucket có = 180 không?
   - sum shared_jobs_total theo bucket có = 90 không?
   - shared_jobs_failed có = 0 ở mọi bucket không?

4. VUs vs iter/s
   - Actual iter/s theo bucket dao động thế nào?
   - sum actual iter/s có = 90 không?
   - VUs có giữ gần 8 ở đầu/giữa run không?
   - Cuối run VUs có tụt về 0 không?
   - iter/s có thấp bất thường dù VUs đủ không? (write contention)

5. Write contention check (đặc thù case 04)
   - shared_job_duration_ms p95 / p50 > 2 không?
   - PATCH http_req_duration p95 / GET http_req_duration p95 > 2 không?
   - job_duration avg >> (PATCH avg + GET avg) không?

6. Business decision
   - Tất cả counters pass?
   - Operation breakdown đúng 90/90?
   - cart_cleanup_summary_verify = 90 và 0 failed?
   - shared_jobs_failed = 0?
   - Nếu tất cả pass -> cart cleanup PASS
   - Nếu verify < 90 hoặc có failed -> BLOCK
```

Kết luận của run case 04 đang đúng nếu thấy:

```text
iterations = 90
http_req_failed = 0%
checks = 100%
shared_jobs_total = 90
shared_jobs_failed = 0
cart_item_cleanup_update = 90
cart_cleanup_summary_verify = 90
Live VUs: đầu = 8, cuối giảm về 0
sum chart iterations = summary iterations
sum chart httpReqs = summary http_reqs
executor = shared-iterations
```

## Mở rộng / variation

### Variation A: Thêm tag cart_id để phân tích write contention theo partition

```js
const STALE_ITEMS = Array.from({ length: 90 }, (_, i) => ({
  item_id: `item-${String(i).padStart(4, "0")}`,
  cart_id: `cart-${String(Math.floor(i / 5)).padStart(3, "0")}`,
}));

export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  const item = STALE_ITEMS[jobIndex];

  // Tag cart_id để filter contention theo cart trên dashboard
  const cartTag = { cart_id: item.cart_id };

  const updateRes = http.patch(
    `${BASE_URL}/api/sim/cart/items/${item.item_id}?cpu_ms=1&db_writes=1`,
    JSON.stringify({ quantity: 0, status: "cleaned" }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { ...cartTag, operation: "cart_item_cleanup_update" },
    }
  );

  const verifyRes = http.get(
    `${BASE_URL}/api/sim/cart/summary?cpu_ms=1&db_rows=3&json_items=8`,
    { tags: { ...cartTag, operation: "cart_cleanup_summary_verify" } }
  );
}
```

### Variation B: Tăng JOBS để mô phỏng backlog production lớn hơn

```powershell
$env:SI_04_JOBS = 500
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-04-cart-cleanup.js
```

Nhớ recompute expected: `http_reqs = 500 × 2 = 1000`.

Với JOBS lớn, write contention có thể lộ rõ hơn vì nhiều item chung cart được xử lý concurrent.

### Variation C: Thêm threshold latency theo operation

```js
export const options = {
  thresholds: {
    "http_req_duration{operation:cart_item_cleanup_update}": ["p(95)<400"],
    "http_req_duration{operation:cart_cleanup_summary_verify}": ["p(95)<300"],
    "shared_job_duration_ms": ["p(95)<1000"],
  },
};
```

Chuyển từ functional batch sang performance gate. `shared_job_duration_ms` threshold giúp bắt write contention sớm.

### Variation D: Thêm check body data cho verify step

```js
const verifyRes = http.get(
  `${BASE_URL}/api/sim/cart/summary?cpu_ms=1&db_rows=3&json_items=8`
);

check(verifyRes, {
  "verify status 200": (r) => r.status === 200,
  "verify quantity zero": (r) => {
    const body = r.json();
    // Kiểm tra item đã cleanup có quantity = 0
    const cleanedItem = body.items.find(i => i.id === item.item_id);
    return cleanedItem === undefined || cleanedItem.quantity === 0;
  },
});
```

Nâng cao: không chỉ check HTTP status, còn check business data correctness.

### Variation E: Multi-scenario — cleanup cart + audit product đồng thời

```js
scenarios: {
  cart_cleanup: {
    executor: "shared-iterations",
    vus: 8,
    iterations: 90,
    tags: { case_id: "si-04-cart-cleanup" },
  },
  product_audit: {
    executor: "shared-iterations",
    vus: 4,
    iterations: 80,
    startTime: "3s",
    tags: { case_id: "si-01-catalog-audit" },
  },
},
```

Test cách hệ thống chịu tải khi có cả write workload (cart cleanup) và read workload (product audit) cùng lúc. Write contention có thể nặng hơn khi DB phải phục vụ cả read query.

## Anti-pattern

- Dùng `__VU` làm business identity chính cho backlog.
- Fail test chỉ vì VU distribution không đều.
- Dùng `constant-vus` rồi suy ra exact job count từ duration.
- Dùng arrival-rate executor cho bài toán drain fixed queue.
- Chỉ nhìn response time đẹp mà không kiểm `shared_jobs_total` và operation counts.
- Chỉ check PATCH pass mà không verify summary GET — PATCH 200 không đủ kết luận cleanup thành công.
- Giữ expected formulas cũ sau khi override `JOBS`.
- Dùng per-VU state (session, cart_id) kỳ vọng sống qua nhiều iter — mỗi iter là 1 item khác nhau.
- Kiểm tra `iterations_per_vu == JOBS / vus` như một pass criteria.
- Isolation cart_id để né write contention — contention là tín hiệu thật cần đo, không phải bug cần che.
- Bỏ qua `shared_job_duration_ms` — metric này chứa wait time mà http_req_duration không thấy được.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- Worked example QuickPizza: `../../20260515_03_shared-iterations-quickpizza-two-requests-worked-example.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-04-cart-cleanup.js`
- Per-vu comparison (case 01): `../per-vu-iterations/01_user-journey-replay.md`
- Catalog audit case (shared-iterations): `./01_catalog-audit.md`
