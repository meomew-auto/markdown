# Case 07: CI verification batch

## Tình huống thực tế

CI/platform cần một checklist API cố định sau deploy/migration. Mục tiêu không phải mô phỏng traffic production mà là deterministic contract coverage — mỗi lần CI chạy phải kiểm tra cùng một danh sách API, cùng một tỉ lệ operation, để kết quả pass/fail giữa các build có thể so sánh được với nhau.

Nếu tổng request đủ 100 nhưng chỉ chạy products/cart mà bỏ sót order/report, CI pass là giả — order service có thể bị regression mà không ai phát hiện cho đến khi production có người đặt hàng thất bại. Coverage theo operation quan trọng ngang total count.

Case này trả lời: 10 workers có chạy đủ 100 checklist jobs không, và 5 operation có split đúng 20/20/20/20/20 không?

Tóm tắt đời thường:

```text
Trigger: CI deploy gate, migration smoke test, contract verification sau release candidate
Backlog: 100 API checklist jobs across 5 operation types
Risk nếu skip job: một service/API regression lọt qua CI vì checklist coverage lệch
```

Case này **không** cố gắng trả lời "production traffic giống thật chưa?". Nó trả lời câu hỏi batch/ops cụ thể hơn:

```text
Có xử lý đủ fixed backlog không?
Mỗi job có đi đúng business flow không?
Có job nào fail không?
5 operation types có được phủ đều 20/20/20/20/20 không?
```

### Vì sao "CI fixed API checklist" buộc chọn shared-iterations?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của CI verification batch trước:

```text
CI verification batch = "gọi TỪNG API trong danh sách cố định,
                        xác nhận response 200 và contract hợp lệ,
                        đảm bảo 5 service đều được kiểm tra"

Đời thường:
  Checklist 100 mục kiểm tra sau deploy (= 100 jobs)
  10 kỹ sư QA (= 10 VU)
  Mỗi mục: gọi 1 API và verify response
  Kỹ sư nào xong mục trước thì lấy mục tiếp theo
  Kết thúc khi TẤT CẢ 100 mục đã được kiểm
  Quan trọng: 5 nhóm API (products, detail, cart, order, report) mỗi nhóm 20 mục
```

Để CI verification batch **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ shared-iterations mới thỏa mãn cả 2.

#### Yêu cầu (a): EXACT TOTAL COVERAGE (không thiếu job nào)

**Ý nghĩa**: Phải chạy ĐỦ 100 checklist jobs. Thiếu 1 job là coverage incomplete — service tương ứng có thể bị regression mà CI không bắt được.

**Ví dụ cụ thể**:

```text
Scenario: team vừa deploy release candidate, cần verify 100 API checklist

Trường hợp A (coverage ĐỦ):
  Chạy 100 jobs, tất cả 5 operation × 20 pass
  → Kết luận: CI checklist OK, cho phép promote lên production

Trường hợp B (coverage THIẾU - bug):
  Chạy 72 jobs (thiếu 28), 72 jobs đã chạy đều pass
  → Tưởng OK, nhưng 28 jobs chưa chạy có thể nằm ở order/confirm hoặc report
  → Production: user đặt hàng → order confirm lỗi → mất doanh thu
  → KHÔNG kết luận được, CI test không có giá trị
```

**Vì sao total iterations phải chính xác 100?**

```text
Nếu total phụ thuộc duration:
  - duration cố định 30s
  - latency thấp  → chạy được 100 jobs (đủ)
  - latency cao   → chạy được 72 jobs (thiếu 28)
  - latency tăng do backend chậm, không phải do ít API hơn
  → Mỗi lần CI số jobs chạy được khác → không biết coverage có đủ không
  → KHÔNG so sánh được giữa build #123 và build #124
```

**Phân tích sâu: vì sao 2 executor "duration-based" không đảm bảo count?**

`constant-vus` với `duration: "30s"`:

```text
Công thức count khi chạy:
  count_jobs = duration × throughput
             = 30s × (vus / iter_time)
             = 30s × (10 / iter_time)
             = 300 / iter_time

iter_time KHÔNG cố định, biến thiên do:
  - HTTP latency (mạng, server load, GC pause)
  - DB query time (cache hit/miss, lock contention)
  - Cart add endpoint có db_writes (chậm hơn product list đơn thuần)
  - Order confirm có external_ms (gọi external service, dễ chậm)
  - Report generate có gzip_kb (compress data, CPU-bound)

Ví dụ thực tế chạy 3 lần liên tiếp cùng config:
  Lần 1: server vừa restart, cache cold
    iter_time avg = 0.50s -> count = 300/0.50 = 600 jobs
    (dư! chạy nhiều hơn 100, nhưng có thể chạy lặp operation đầu, thiếu operation cuối)
  Lần 2: cache đã warm, network ổn
    iter_time avg = 0.30s -> count = 300/0.30 = 1000 jobs
  Lần 3: external service cho order confirm bị chậm
    iter_time avg = 0.80s -> count = 300/0.80 = 375 jobs

  Vấn đề KHÔNG chỉ là count khác nhau.
  Vấn đề LỚN HƠN: không biết 5 operation có được kiểm ĐỦ mỗi cái 20 lần không.
  600 jobs có thể = product_list 300 lần, order_confirm 50 lần → coverage lệch.
```

`constant-arrival-rate` với `rate: 5/s, duration: "30s"`:

```text
Mục tiêu config: "5 job/s × 30s = 150 jobs TOTAL"
→ Dư so với 100 jobs cần kiểm. Nhưng...

KHÔNG đảm bảo đạt 150 vì có thể DROP slot:
  - Khi rate target > năng lực VU pool
  - Khi server chậm bất thường ở 1 đoạn (database lock, GC)
  - Khi spawn VU không kịp lúc đầu

Công thức thực tế:
  N_done = N_sched - N_drop - N_int
         = 150 - N_drop - N_int

Ví dụ thực tế:
  Lần 1: pool vừa khít, không drop
    N_drop = 0, N_done = 150 (dư 50 so với 100, không biết operation split thế nào)
  Lần 2: server có 10s chậm ở giữa (database backup)
    N_drop = 40, N_done = 110 (vẫn có thể đủ 100, nhưng drop đã làm mất operation nào?)
  Lần 3: cache cold ở 30s đầu
    N_drop = 35, N_int = 10, N_done = 105

  KHÔNG reliable: lần được lần không, không biết trước
  Quan trọng hơn: KHÔNG biết operation nào bị drop
  → Nếu order_confirm bị drop nhiều hơn product_list, CI vẫn pass nhưng order service chưa được test đủ
```

**Trong khi đó với `shared-iterations`**:

```text
Config: vus=10, iterations=100
N_done = 100 (TUYỆT ĐỐI, nếu không bị maxDuration cắt)

Lần 1: server chậm  -> 100 jobs, T_run=12s, p95=1.8s
Lần 2: server nhanh -> 100 jobs, T_run=6s,  p95=0.4s
Lần 3: server bình thường -> 100 jobs, T_run=8s, p95=0.7s

Count CỐ ĐỊNH ở 100 mỗi lần.
Chỉ có T_run + latency thay đổi -> đó CHÍNH LÀ cái cần đo!

→ 100 jobs luôn được chạy đủ → coverage guarantee
→ Nếu latency tăng, T_run tăng → phát hiện được performance regression
→ Operation split luôn deterministic (nếu code đúng) → so sánh được giữa các build
```

**Tóm tắt 3 executor về count**:

| Executor | Count formula | Count cố định? | Operation coverage guarantee? |
| --- | --- | --- | --- |
| **shared-iterations** | `iterations` | CÓ (tuyệt đối) | CÓ (nếu routing từ iterationInTest) |
| constant-vus (duration) | `duration × vus / iter_time` | KHÔNG (do iter_time) | KHÔNG (có thể chạy lặp hoặc thiếu operation) |
| constant-arrival-rate | `N_sched - N_drop - N_int` | KHÔNG (do drop/int) | KHÔNG (drop có thể bỏ sót operation cụ thể) |

→ COUNT phải CHÍNH XÁC, KHÔNG phụ thuộc latency
→ Chỉ executor đếm theo "iterations cố định" mới đạt
→ Nhưng count đủ chưa đủ — còn cần operation routing ĐÚNG (yêu cầu b)

#### Yêu cầu (b): CORRECT OPERATION COVERAGE MAPPING (mỗi job map đúng 1 operation type)

**Ý nghĩa**: 100 iteration phải map sang 5 operation types, mỗi operation đúng 20 lần. Nếu map sai, dù count = 100, coverage từng service vẫn thiếu.

**Bug operation routing là gì?**

```text
Trường hợp ĐÚNG — operation từ iterationInTest:
  iter #0  -> ci_product_list      (job #0,  operation type 0)
  iter #1  -> ci_product_list      (job #1,  operation type 0)
  ...
  iter #19 -> ci_product_list      (job #19, operation type 0)
  iter #20 -> ci_product_detail    (job #20, operation type 1)
  ...
  iter #39 -> ci_product_detail    (job #39, operation type 1)
  iter #40 -> ci_cart_add          (job #40, operation type 2)
  ...
  iter #59 -> ci_cart_add          (job #59, operation type 2)
  iter #60 -> ci_order_confirm     (job #60, operation type 3)
  ...
  iter #79 -> ci_order_confirm     (job #79, operation type 3)
  iter #80 -> ci_report_generate   (job #80, operation type 4)
  ...
  iter #99 -> ci_report_generate   (job #99, operation type 4)
  → 5 operations × 20 = 100, coverage đúng ✓

Trường hợp SAI — operation từ __VU:
  VU=1:  __VU=1 -> luôn ci_product_list (lặp ~12 lần)
  VU=2:  __VU=2 -> luôn ci_product_detail (lặp ~11 lần)
  VU=3:  __VU=3 -> luôn ci_cart_add (lặp ~10 lần)
  VU=4:  __VU=4 -> luôn ci_order_confirm (lặp ~9 lần)
  VU=5:  __VU=5 -> luôn ci_report_generate (lặp ~9 lần)
  VU=6:  __VU=6 -> luôn ci_product_list (lặp ~10 lần)
  ...
  VU=10: __VU=10 -> luôn ci_cart_add (lặp ~8 lần)
  → 5 operation types được chạy, nhưng KHÔNG theo tỉ lệ 20/20/20/20/20
  → Tỉ lệ phụ thuộc VU speed → mỗi lần CI tỉ lệ khác nhau
  → KHÔNG so sánh được giữa build #123 và build #124
```

**4 nguyên nhân kỹ thuật của bug CI verification**:

### Nguyên nhân 1: CI COVERAGE GAP (thiếu operation do duration-based test)

**Vấn đề**: Duration-based test dừng sau một khoảng thời gian, không theo số operation cần test. Nếu latency tăng, số operation test được giảm — và operation nào bị thiếu là không biết trước.

```text
Tưởng tượng checklist 100 mục kiểm tra sau deploy:
  - 10 kỹ sư QA kiểm, mỗi mục mất ~0.3s
  - Manager đặt đồng hồ 20s -> hết 20s dừng, bất kể còn mục chưa kiểm

  Ngày thường (server nhanh, 0.3s/mục):
    10 kỹ sư × 20s / 0.3s = 666 mục (dư, nhưng kiểm lặp mục đầu)
    → Nếu routing SAI, kiểm lặp product_list 200 lần, bỏ sót report
    → report service có thể bị regression mà không phát hiện

  Ngày external service chậm (order_confirm: 0.8s, còn lại 0.3s):
    order_confirm: 10 kỹ sư × 20s / 0.8s = 250 mục order_confirm (nếu toàn bộ làm order)
    Nhưng thực tế hỗn hợp: avg iter_time = 0.4s
    10 kỹ sư × 20s / 0.4s = 500 mục
    → Vẫn dư, nhưng tỉ lệ lệch: order_confirm ít hơn vì chậm hơn
```

**Demo cụ thể: constant-vus duration=20s, vus=10**

Giả sử mỗi iter mất 0.3s, code dùng `__VU` làm operation routing (SAI):

```text
VU=1 (nhanh nhất, network tốt): iter_time=0.2s
  → 20s / 0.2s = 100 iter
  → Luôn chạy ci_product_list, lặp 100 lần

VU=5 (trung bình): iter_time=0.3s
  → 20s / 0.3s = 66 iter
  → Luôn chạy ci_report_generate, lặp 66 lần

VU=10 (chậm nhất, network kém): iter_time=0.5s
  → 20s / 0.5s = 40 iter
  → Luôn chạy ci_cart_add, lặp 40 lần

Tổng: khoảng 600 iterations
Nhưng operation split HOÀN TOÀN phụ thuộc VU speed
→ Build #123: VU=1 nhanh → product_list nhiều
→ Build #124: VU=5 nhanh → report_generate nhiều
→ KHÔNG so sánh được kết quả CI giữa 2 build
```

**Demo với code đúng (operation từ iterationInTest) nhưng vẫn duration-based**:

```text
Vấn đề khác: không biết khi nào đã test đủ 100 jobs

constant-vus duration=20s:
  iter #0-#99: test theo operation routing đúng (đủ 100)
  iter #100-#599: test tiếp, lặp lại operation đầu
  → Lãng phí, nhưng ít nhất 100 jobs đã được test đúng routing

constant-vus duration=3s (quá ngắn):
  iter #0-#45: test được 45 jobs
  → Thiếu 55 jobs, operation cuối (report_generate) có thể chưa được test
  → Nhưng test vẫn "pass" nếu chỉ nhìn http_req_failed=0

SO SÁNH VỚI shared-iterations:
  iterations=100
  iter #0-#99: test đủ 100 jobs theo routing đúng (DỪNG)
  → Không dư, không thiếu, coverage chính xác
  → Mỗi operation đúng 20 lần
```

**Cách phát hiện**: so sánh `iterations` count với expected `JOBS`. Nếu `iterations < JOBS` → coverage incomplete. Nếu `iterations > JOBS` và operation routing từ `__VU` → coverage lệch, không deterministic.

### Nguyên nhân 2: WRONG OPERATION ROUTING (dùng `__VU` thay vì `iterationInTest`)

Đây là lỗi phổ biến nhất khi chuyển từ per-vu-iterations sang shared-iterations cho CI checklist.

**`__VU` là gì trong shared-iterations?** `__VU` là **worker ID** — định danh VU nào đang xử lý job hiện tại. Nó không phải business identity, không nên dùng để chọn operation.

**`exec.scenario.iterationInTest` là gì?** Là **global job index** — số thứ tự iteration trong toàn scenario, từ 0 đến iterations-1. Đây là identity ổn định để chọn operation type.

```text
So sánh 2 cách chọn operation:

Cách A — SAI: dùng __VU
  const opIndex = __VU % 5;  // VU=1 -> op=1, VU=2 -> op=2, ...
  
  VU=1: __VU=1 -> op=1 (ci_product_list), lặp ~12 lần
  VU=2: __VU=2 -> op=2 (ci_product_detail), lặp ~11 lần
  VU=3: __VU=3 -> op=3 (ci_cart_add), lặp ~10 lần
  ...
  → 5 operation types được chạy, nhưng tỉ lệ phụ thuộc VU speed
  → KHÔNG deterministic → KHÔNG so sánh được giữa các build

Cách B — ĐÚNG: dùng exec.scenario.iterationInTest
  const opIndex = exec.scenario.iterationInTest % 5;
  hoặc:
  const opIndex = Math.floor(exec.scenario.iterationInTest / 20);
  
  iter #0  -> opIndex=0 -> ci_product_list     (do VU nào cũng được)
  iter #1  -> opIndex=1 -> ci_product_detail
  iter #2  -> opIndex=2 -> ci_cart_add
  iter #3  -> opIndex=3 -> ci_order_confirm
  iter #4  -> opIndex=4 -> ci_report_generate
  iter #5  -> opIndex=0 -> ci_product_list
  ...
  → Tỉ lệ TUYỆT ĐỐI 20/20/20/20/20, mọi lần chạy
  → Deterministic → so sánh được giữa các build
```

**Demo trace 10 VU × 100 iter với operation routing đúng**:

```text
t=0.0s   10 VU cùng start
         VU=1  lấy iterInTest=0  -> opIndex=0 -> ci_product_list
         VU=2  lấy iterInTest=1  -> opIndex=1 -> ci_product_detail
         VU=3  lấy iterInTest=2  -> opIndex=2 -> ci_cart_add
         VU=4  lấy iterInTest=3  -> opIndex=3 -> ci_order_confirm
         VU=5  lấy iterInTest=4  -> opIndex=4 -> ci_report_generate
         VU=6  lấy iterInTest=5  -> opIndex=0 -> ci_product_list
         VU=7  lấy iterInTest=6  -> opIndex=1 -> ci_product_detail
         VU=8  lấy iterInTest=7  -> opIndex=2 -> ci_cart_add
         VU=9  lấy iterInTest=8  -> opIndex=3 -> ci_order_confirm
         VU=10 lấy iterInTest=9  -> opIndex=4 -> ci_report_generate

t=0.3s   VU=1 xong iter #0, lấy iterInTest=10 -> opIndex=0 -> ci_product_list
         VU=3 xong iter #2, lấy iterInTest=11 -> opIndex=1 -> ci_product_detail
         ...

t=4.0s   iterInTest=99 được lấy -> opIndex=4 -> ci_report_generate (job cuối!)
         100/100 jobs complete -> scenario dừng

Kết quả: 5 operations × 20 = 100, deterministic ✓
```

**Demo trace 10 VU × 100 iter với operation routing SAI (dùng __VU)**:

```text
t=0.0s   VU=1:  __VU=1 -> op=1 -> ci_product_list (lần 1)
         VU=2:  __VU=2 -> op=2 -> ci_product_detail (lần 1)
         VU=3:  __VU=3 -> op=3 -> ci_cart_add (lần 1)
         VU=4:  __VU=4 -> op=4 -> ci_order_confirm (lần 1)
         VU=5:  __VU=5 -> op=0 -> ci_product_list (lần 1)
         ...

t=0.3s   VU=1:  __VU=1 -> op=1 -> ci_product_list (lần 2) ← lặp!
         VU=3:  __VU=3 -> op=3 -> ci_cart_add (lần 2)
         ...

t=4.0s   100 iter hoàn thành
         ci_product_list:     25 lần (VU=1,5 nhanh)
         ci_product_detail:   22 lần
         ci_cart_add:         20 lần
         ci_order_confirm:    18 lần (VU=4,9 chậm — external service)
         ci_report_generate:  15 lần (VU=5,10 chậm — CPU gzip)

Kết quả: 100 iter, nhưng operation split = 25/22/20/18/15 ❌
→ KHÔNG phải 20/20/20/20/20
→ Build sau có thể ra split khác → KHÔNG so sánh được
```

**Vì sao lỗi này dễ mắc khi chuyển từ per-vu-iterations?**

```text
Trong per-vu-iterations:
  __VU = business identity (user, customer, tenant)
  Mỗi VU chạy đúng N iter cho cùng identity đó
  → Dùng __VU để chọn operation là CÓ THỂ CHẤP NHẬN ĐƯỢC
    (mỗi VU là một "user" cố định, operation gắn với user đó)

Trong shared-iterations:
  __VU = worker identity (ai đang cầm job)
  Mỗi VU chạy số iter khác nhau, operation thay đổi mỗi lần
  → Dùng __VU để chọn operation là SAI
  → Operation phải derive từ iterationInTest để deterministic

Code đúng cho shared-iterations:
  const opIndex = exec.scenario.iterationInTest % 5;
  const operation = OPERATIONS[opIndex];
  // KHÔNG: const operation = OPERATIONS[__VU % 5];
```

### Nguyên nhân 3: SERVICE-SPECIFIC LATENCY ASYMMETRY (operation này pass nhưng operation kia fail)

**Vấn đề**: Một CI checklist job chỉ hoàn tất khi operation được gọi trả về 200 và pass checks. 5 operation gọi 5 service/endpoint khác nhau, mỗi cái có latency profile và failure mode riêng. Nếu chỉ check tổng HTTP requests, có thể bỏ sót trường hợp 4 operation pass hết nhưng 1 operation fail.

```text
Flow mỗi job:
  Gọi 1 API endpoint tương ứng với operation type
  → expect 200 và contract checks pass

5 operation types với risk profile khác nhau:
  ci_product_list:      GET  /products        → đọc DB, có cache → thường nhanh, ít fail
  ci_product_detail:    GET  /products/:id    → đọc DB, JOIN → trung bình
  ci_cart_add:          POST /cart/add        → ghi DB → có thể chậm nếu DB lock
  ci_order_confirm:     POST /orders/:id/confirm → ghi DB + external service → dễ fail nhất
  ci_report_generate:   GET  /report          → CPU gzip → có thể chậm, ít fail
```

**Demo trace service-specific failure**:

```text
Backend state: external service cho order_confirm bị timeout 30% request
(do external service quá tải sau deploy)

Run CI verification 100 jobs:
  Job #0:  ci_product_list     -> 200 OK ✓ (nhanh, 0.05s)
  Job #1:  ci_product_detail   -> 200 OK ✓ (0.08s)
  Job #2:  ci_cart_add         -> 200 OK ✓ (0.10s)
  Job #3:  ci_order_confirm    -> 504 TIMEOUT ✗ (external service chậm)
  Job #4:  ci_report_generate  -> 200 OK ✓ (0.15s)
  Job #5:  ci_product_list     -> 200 OK ✓
  ...
  Job #23: ci_order_confirm    -> 504 TIMEOUT ✗
  ...
  Job #43: ci_order_confirm    -> 504 TIMEOUT ✗
  ...
  Job #63: ci_order_confirm    -> 504 TIMEOUT ✗
  ...
  Job #83: ci_order_confirm    -> 504 TIMEOUT ✗
  ...
  Job #99: ci_report_generate  -> 200 OK ✓

Tổng kết nếu CHỈ nhìn http_reqs:
  http_reqs = 100
  http_req_failed = 6/100 = 6%
  → Dễ bị bỏ qua nếu threshold http_req_failed < 10%

Tổng kết nếu tách operation:
  ci_product_list:      20 pass, 0 fail (100%)
  ci_product_detail:    20 pass, 0 fail (100%)
  ci_cart_add:          20 pass, 0 fail (100%)
  ci_order_confirm:     14 pass, 6 fail (70%!) ← PROBLEM
  ci_report_generate:   20 pass, 0 fail (100%)
  → order_confirm bị fail 30% → CI NÊN FAIL
  → Route về order service owner để điều tra external service
```

**Cách phát hiện**: luôn tách metric theo tag `operation`. Không chỉ check `http_req_failed` tổng. Nếu `ci_order_confirm` count < 20 → thiếu coverage. Nếu `ci_order_confirm` có failed > 0 → điều tra external service. Nếu `ci_cart_add` p95 đột biến → điều tra DB write path.

### Nguyên nhân 4: WORKER SKEW IS EXPECTED (phân phối không đều là bình thường)

**Vấn đề**: Với shared-iterations, VU nhanh sẽ lấy nhiều job hơn VU chậm. Đây là **feature**, không phải bug. Nhưng nếu learner không hiểu, họ có thể fail CI test vì "phân phối không đều".

```text
Tưởng tượng 10 kỹ sư QA kiểm 100 mục checklist:
  - Kỹ sư A (nhanh, có kinh nghiệm): 0.15s/mục -> làm được 15 mục
  - Kỹ sư B (bình thường): 0.25s/mục -> làm được 12 mục
  - Kỹ sư J (mới, chậm): 0.60s/mục -> làm được 5 mục
  - Kỹ sư K (gặp mục order_confirm chậm): 0.80s/mục -> làm được 4 mục

  Tổng: 15+12+...+5+4 = 100 mục ✓
  Phân phối: không đều, nhưng TẤT CẢ 100 mục đã được kiểm
  5 operation types vẫn đúng 20/20/20/20/20 (vì routing từ iterationInTest)

  CI manager KHÔNG nói: "Kỹ sư K làm ít quá, CI fail"
  CI manager NÓI: "100/100 mục đã kiểm xong, operation split đúng, CI pass"
```

**Vì sao worker skew xảy ra?**

Cơ chế atomic counter trong k6:

```text
shared_iterations.go — handleVU():

  for {
      // Check hết maxDuration chưa
      if regDurationDone { return }
      
      // LẤY SỐ TIẾP THEO từ atomic counter CHUNG
      attemptedIterNumber := atomic.AddUint64(&attemptedIters, 1)
      
      // Nếu vượt quota -> dừng
      if attemptedIterNumber > totalIters { return }
      
      // Chạy iteration
      runIteration(maxDurationCtx, activeVU)
  }

Mỗi VU gọi atomic.AddUint64 ĐỘC LẬP.
VU nào gọi xong iteration trước -> gọi AddUint64 trước -> lấy job tiếp theo.
→ Không có cơ chế round-robin, không có fairness.
→ Đây là "first come first served" worker pool.
```

**Demo trace worker skew với 5 VU, 25 iter, tốc độ khác nhau**:

```text
Config: vus=5, iterations=25
  VU=1: delay=0.15s (nhanh)
  VU=2: delay=0.25s
  VU=3: delay=0.40s
  VU=4: delay=0.60s
  VU=5: delay=0.60s (chậm)

Timeline:
t=0.0s   5 VU start, cùng lấy iter đầu
         VU=1: iterInTest=0,  opIndex=0 (product_list),    sleep(0.15)
         VU=2: iterInTest=1,  opIndex=1 (product_detail),  sleep(0.25)
         VU=3: iterInTest=2,  opIndex=2 (cart_add),        sleep(0.40)
         VU=4: iterInTest=3,  opIndex=3 (order_confirm),   sleep(0.60)
         VU=5: iterInTest=4,  opIndex=4 (report_generate), sleep(0.60)

t=0.15s  VU=1 xong, lấy iterInTest=5,  opIndex=0, sleep(0.15)
t=0.25s  VU=2 xong, lấy iterInTest=6,  opIndex=1, sleep(0.25)
t=0.30s  VU=1 xong, lấy iterInTest=7,  opIndex=2, sleep(0.15)
t=0.40s  VU=3 xong, lấy iterInTest=8,  opIndex=3, sleep(0.40)
t=0.45s  VU=1 xong, lấy iterInTest=9,  opIndex=4, sleep(0.15)
t=0.50s  VU=2 xong, lấy iterInTest=10, opIndex=0, sleep(0.25)
t=0.60s  VU=1 xong, lấy iterInTest=11, opIndex=1, sleep(0.15)
         VU=4 xong, lấy iterInTest=12, opIndex=2, sleep(0.60)
         VU=5 xong, lấy iterInTest=13, opIndex=3, sleep(0.60)
...

Kết quả cuối:
  VU=1: 9 iter  (nhanh nhất -> nhiều nhất)
  VU=2: 6 iter
  VU=3: 4 iter
  VU=4: 3 iter
  VU=5: 3 iter  (chậm nhất -> ít nhất)
  Tổng: 25 iter ✓

Phân phối: 9-6-4-3-3 (lệch nặng)
Nhưng tổng = 25 = config → PASS ✓
Operation split vẫn 5/5/5/5/5 vì routing từ iterationInTest ✓
Không ai fail CI vì VU=5 chỉ làm 3 job.
```

**So sánh với per-vu-iterations (nơi phân phối đều là REQUIREMENT)**:

| Tiêu chí | shared-iterations | per-vu-iterations |
| --- | --- | --- |
| Phân phối job | Không đều (first-come-first-served) | Đều tuyệt đối (mỗi VU = N iter) |
| VU nhanh xong sớm | Lấy thêm job | IDLE (không cướp việc VU khác) |
| Pass criteria | Tổng job = config + operation split đúng | Tổng job = config VÀ mỗi VU = N iter |
| Khi nào fail vì phân phối? | Không bao giờ | Nếu VU nào không đủ N iter |
| Operation split | Từ iterationInTest, luôn đúng | Từ __VU, đều nhưng identity sai |

**Cách phát hiện**: nếu learner fail CI test vì "VU distribution không đều", giải thích lại mental model worker pool. Invariant là `sum(iterations_per_vu) == JOBS` và operation split đúng 20/20/20/20/20, không phải `iterations_per_vu == JOBS / vus`.

---

### Tổng kết: chỉ shared-iterations thỏa mãn cả (a) và (b)

| Executor | (a) Exact total coverage | (b) Correct operation mapping | Verdict |
| --- | --- | --- | --- |
| **shared-iterations** | ✓ iterations cố định | ✓ nếu dùng iterationInTest | ✅ DÙNG |
| per-vu-iterations | ✓ count cố định | ✗ ép quota bằng nhau, VU không phải operation | ❌ |
| constant-vus (duration) | ✗ count phụ thuộc latency | ✗ VU random pick, operation không deterministic | ❌ |
| constant-arrival-rate | ✗ có thể drop | ✗ rate-driven, không bound vào job index | ❌ |
| ramping-vus | ✗ count biến thiên theo time | ✗ VU spawn lệch theo timeline | ❌ |
| ramping-arrival-rate | ✗ count biến thiên + drop | ✗ rate-driven, không bound job | ❌ |

→ Chỉ **shared-iterations** thỏa mãn cả 2 yêu cầu, các executor khác đều fail ở ít nhất 1 trong 2.

### 3 thông số config ánh xạ từ yêu cầu nghiệp vụ

```text
1. FIXED BACKLOG SIZE (tổng số job cố định):
   - CI checklist có 100 mục kiểm tra
   - Không phải "test trong 5 phút", mà là "test ĐỦ 100 mục"
   → iterations = 100 (tổng job toàn scenario)
   → KHÔNG dùng duration làm input chính

2. WORKER POOL SIZE (số worker cùng xử lý):
   - 10 worker cùng kiểm để xong nhanh hơn
   - Không quan trọng worker nào làm bao nhiêu, miễn tổng đủ và operation split đúng
   → vus = 10 (số worker)
   → KHÔNG cần mỗi VU kiểm đúng 10 mục

3. OPERATION COVERAGE (mỗi operation type được test đúng 20 lần):
   - 5 operation types × 20 jobs = 100 total jobs
   - 100 jobs × 1 API = 100 total API calls
   → http_reqs = 100 (deterministic, nếu không fail)
   → shared_api_calls_total = 100
   → Deterministic operation split: mỗi operation type = JOBS / 5 = 20
```

## OPERATION SELECTION — Cách chọn operation từ iterationInTest

Đây là phần **quan trọng nhất** của case 07, khác biệt hoàn toàn với case 01 (chỉ có 2 operation). Với 5 operation types, routing phải đảm bảo deterministic split 20/20/20/20/20.

### Cách 1: Dùng modulo (round-robin operation)

```js
const OPERATIONS = [
  "ci_product_list",
  "ci_product_detail",
  "ci_cart_add",
  "ci_order_confirm",
  "ci_report_generate",
];

const opIndex = exec.scenario.iterationInTest % 5;
const operation = OPERATIONS[opIndex];
```

**Cách này cho ra split xen kẽ**:

```text
iter #0  -> opIndex=0 -> ci_product_list
iter #1  -> opIndex=1 -> ci_product_detail
iter #2  -> opIndex=2 -> ci_cart_add
iter #3  -> opIndex=3 -> ci_order_confirm
iter #4  -> opIndex=4 -> ci_report_generate
iter #5  -> opIndex=0 -> ci_product_list
iter #6  -> opIndex=1 -> ci_product_detail
...
iter #99 -> opIndex=4 -> ci_report_generate

Split: 20/20/20/20/20 ✓
```

**Ưu điểm**: code đơn giản, dễ hiểu. Mỗi operation xuất hiện đều đặn, không bị "dồn cục".

**Nhược điểm**: các operation xen kẽ, khó nhìn pattern trên dashboard nếu muốn quan sát từng operation riêng.

### Cách 2: Dùng block-based (first N = operation A, next N = operation B, ...)

```js
const OP_COUNT = 5;
const JOBS_PER_OP = 20; // JOBS / OP_COUNT

const opIndex = Math.floor(exec.scenario.iterationInTest / JOBS_PER_OP);
const operation = OPERATIONS[opIndex];
```

**Cách này cho ra split theo block**:

```text
iter #0  -> floor(0/20)=0  -> ci_product_list     (block 0: iter #0-#19)
iter #1  -> floor(1/20)=0  -> ci_product_list
...
iter #19 -> floor(19/20)=0 -> ci_product_list
iter #20 -> floor(20/20)=1 -> ci_product_detail   (block 1: iter #20-#39)
iter #21 -> floor(21/20)=1 -> ci_product_detail
...
iter #39 -> floor(39/20)=1 -> ci_product_detail
iter #40 -> floor(40/20)=2 -> ci_cart_add          (block 2: iter #40-#59)
...
iter #59 -> floor(59/20)=2 -> ci_cart_add
iter #60 -> floor(60/20)=3 -> ci_order_confirm     (block 3: iter #60-#79)
...
iter #79 -> floor(79/20)=3 -> ci_order_confirm
iter #80 -> floor(80/20)=4 -> ci_report_generate   (block 4: iter #80-#99)
...
iter #99 -> floor(99/20)=4 -> ci_report_generate

Split: 20/20/20/20/20 ✓
```

**Ưu điểm**: dễ quan sát pattern trên dashboard — product_list chạy xong hết 20 lần rồi mới đến product_detail. Nếu có operation fail, dễ thấy fail tập trung ở block nào. Phù hợp cho CI pipeline: muốn test product list TRƯỚC, nếu fail thì dừng sớm.

**Nhược điểm**: nếu maxDuration cắt ngang giữa chừng, operation cuối (report_generate) có thể bị thiếu toàn bộ.

### So sánh 2 cách routing

| Tiêu chí | Modulo (`% 5`) | Block-based (`/ 20`) |
| --- | --- | --- |
| Split pattern | Xen kẽ: A,B,C,D,E,A,B,... | Block: A×20, B×20, C×20,... |
| Dễ quan sát trên dashboard | Khó (xen kẽ) | Dễ (từng block rõ ràng) |
| Chịu maxDuration cắt | Đều (mỗi operation bị cắt đều) | Lệch (operation cuối bị thiếu toàn bộ) |
| Dễ debug operation fail | Khó (fail rải rác) | Dễ (fail tập trung block) |
| Phù hợp CI pipeline | OK | Tốt hơn (test tuần tự) |

**Khuyến nghị cho CI verification**: dùng block-based vì CI muốn biết operation nào fail để route về đúng owner, và muốn test tuần tự để fail fast.

### Trường hợp đặc biệt: JOBS không chia hết cho OP_COUNT

```text
Nếu JOBS = 101, OP_COUNT = 5:
  101 / 5 = 20 dư 1

Cách modulo:
  iter #0-#99:  mỗi operation 20 lần
  iter #100:    opIndex = 100 % 5 = 0 -> ci_product_list (thêm 1)
  Split: 21/20/20/20/20 (product_list dư 1)
  → Vẫn deterministic, nhưng lệch 1 job

Cách block-based với JOBS_PER_OP = Math.ceil(JOBS / OP_COUNT) = 21:
  iter #0-#20:   ci_product_list     (21 jobs)
  iter #21-#41:  ci_product_detail   (21 jobs)
  iter #42-#62:  ci_cart_add         (21 jobs)
  iter #63-#83:  ci_order_confirm    (21 jobs)
  iter #84-#100: ci_report_generate  (17 jobs, vì tổng = 101)
  Split: 21/21/21/21/17
  → Operation cuối bị thiếu!

Cách block-based với remainder xử lý riêng:
  JOBS_PER_OP = Math.floor(JOBS / OP_COUNT) = 20
  remainder = JOBS % OP_COUNT = 1
  
  Nếu iterInTest < OP_COUNT * JOBS_PER_OP:
    opIndex = Math.floor(iterInTest / JOBS_PER_OP)
  Ngược lại:
    opIndex = iterInTest - (OP_COUNT * JOBS_PER_OP) // mỗi operation thêm 1
  
  Split: 21/20/20/20/20 (remainder 1 phân cho operation đầu)
  → Vẫn deterministic
```

**Quy tắc**: CI verification script phải xử lý trường hợp JOBS % OP_COUNT != 0. Nếu không, split có thể không như expected và CI có thể pass/fall sai.

## Identity model chi tiết: `__VU` vs `__ITER` vs `iterationInTest`

Đây là điểm quan trọng nhất khi code shared-iterations script cho CI. Ba khái niệm khác nhau:

```text
__VU:
  - Worker ID, từ 1 đến vus
  - VU=1 có thể chạy iter #0, #3, #7, #12... (nhiều job khác nhau)
  - KHÔNG dùng để chọn operation type

__ITER:
  - Local counter của từng VU, bắt đầu từ 0
  - VU=1: __ITER=0 → iter #0, __ITER=1 → iter #3, __ITER=2 → iter #7...
  - KHÔNG phải global job index
  - VU=1 __ITER=4 và VU=2 __ITER=4 là 2 job KHÁC NHAU

exec.scenario.iterationInTest:
  - Global job index, từ 0 đến iterations-1
  - DUY NHẤT cho mỗi iteration trong toàn scenario
  - Dùng làm business identity: operation routing, checklist item index...
```

**Demo trace identity model với 5 VU, 10 iter**:

```text
Config: vus=5, iterations=10

t=0.0s   VU=1: __VU=1, __ITER=0, iterationInTest=0  -> opIndex=0 -> ci_product_list
         VU=2: __VU=2, __ITER=0, iterationInTest=1  -> opIndex=1 -> ci_product_detail
         VU=3: __VU=3, __ITER=0, iterationInTest=2  -> opIndex=2 -> ci_cart_add
         VU=4: __VU=4, __ITER=0, iterationInTest=3  -> opIndex=3 -> ci_order_confirm
         VU=5: __VU=5, __ITER=0, iterationInTest=4  -> opIndex=4 -> ci_report_generate

t=0.3s   VU=1 xong, lấy tiếp:
         VU=1: __VU=1, __ITER=1, iterationInTest=5  -> opIndex=0 -> ci_product_list

t=0.5s   VU=2 xong, lấy tiếp:
         VU=2: __VU=2, __ITER=1, iterationInTest=6  -> opIndex=1 -> ci_product_detail

t=0.6s   VU=1 xong, lấy tiếp:
         VU=1: __VU=1, __ITER=2, iterationInTest=7  -> opIndex=2 -> ci_cart_add

... tiếp tục đến iterationInTest=9 (job #9)

Tổng kết:
  VU=1 (nhanh): __ITER=0..3 (4 jobs), iterationInTest=0,5,7,9
  VU=2 (vừa):   __ITER=0..2 (3 jobs), iterationInTest=1,6,8
  VU=3 (chậm):  __ITER=0..1 (2 jobs), iterationInTest=2
  VU=4 (chậm):  __ITER=0..0 (1 job),  iterationInTest=3
  VU=5 (chậm):  __ITER=0..0 (1 job),  iterationInTest=4
  Total: 4+3+2+1+1 = 10 jobs ✓

Operation split (dùng modulo 5):
  iterationInTest=0 -> op=0 (product_list)
  iterationInTest=1 -> op=1 (product_detail)
  iterationInTest=2 -> op=2 (cart_add)
  iterationInTest=3 -> op=3 (order_confirm)
  iterationInTest=4 -> op=4 (report_generate)
  iterationInTest=5 -> op=0 (product_list)
  iterationInTest=6 -> op=1 (product_detail)
  iterationInTest=7 -> op=2 (cart_add)
  iterationInTest=8 -> op=3 (order_confirm)
  iterationInTest=9 -> op=4 (report_generate)
  → 2/2/2/2/2 = deterministic ✓

Code đúng:
  const opIndex = exec.scenario.iterationInTest % 5;
  const operation = OPERATIONS[opIndex];
  // Mỗi operation đúng 2 lần trong 10 iter

Code sai:
  const opIndex = __VU % 5;
  // VU=1 -> op=1, VU=2 -> op=2, ...
  // 5 operation types nhưng tỉ lệ phụ thuộc VU speed
  // KHÔNG deterministic
```

### Vì sao KHÔNG có per-VU state như per-vu-iterations?

Trong per-vu-iterations, mỗi VU có state riêng (session, token, cart) sống qua nhiều iteration vì cùng VU luôn chạy iter cho cùng identity.

Trong shared-iterations, **không có per-VU persistent state hữu ích** vì:

```text
VU=1 chạy job #0 (product_list), xong chạy job #7 (cart_add), xong chạy job #9 (report_generate)...
→ Mỗi job là một operation KHÁC NHAU
→ State của job #0 không dùng được cho job #7
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

## Code pattern đúng cho CI verification batch

```js
import exec from "k6/execution";
import { check } from "k6";
import http from "k6/http";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";

const OP_COUNT = 5;
const JOBS = 100;
const JOBS_PER_OP = JOBS / OP_COUNT; // 20

const OPERATIONS = [
  {
    name: "ci_product_list",
    method: "GET",
    path: "/api/sim/products?limit=10&cpu_ms=1&db_rows=2",
    service: "products",
  },
  {
    name: "ci_product_detail",
    method: "GET",
    path: "/api/sim/products/10?view=full&cpu_ms=1&db_rows=1",
    service: "products",
  },
  {
    name: "ci_cart_add",
    method: "POST",
    path: "/api/sim/cart/add?cpu_ms=1&db_writes=1",
    service: "cart",
  },
  {
    name: "ci_order_confirm",
    method: "POST",
    path: "/api/sim/orders/1/confirm?cpu_ms=1&db_writes=1&external_ms=1&external_fail_rate=0",
    service: "order",
  },
  {
    name: "ci_report_generate",
    method: "GET",
    path: "/api/sim/report?cpu_ms=1&db_rows=1&gzip_kb=1",
    service: "report",
  },
];

export default function () {
  // Lấy global job index — ĐÂY LÀ DÒNG QUAN TRỌNG NHẤT
  const jobIndex = exec.scenario.iterationInTest; // 0..99

  // Chọn operation — 2 cách:
  
  // Cách 1: block-based (khuyến nghị cho CI)
  const opIndex = Math.floor(jobIndex / JOBS_PER_OP);
  
  // Cách 2: round-robin modulo
  // const opIndex = jobIndex % OP_COUNT;

  const op = OPERATIONS[opIndex];

  // Gọi API và verify
  const res = http.request(op.method, `${BASE_URL}${op.path}`, null, {
    tags: {
      operation: op.name,
      service: op.service,
      case_id: "si-07-ci-verification-batch",
      business_case: "ci_api_contract_verification",
      job_id: `ci-job-${String(jobIndex).padStart(3, "0")}`,
    },
  });

  check(res, {
    [`${op.name} status 200`]: (r) => r.status === 200,
    [`${op.name} response time < 2s`]: (r) => r.timings.duration < 2000,
  });
}
```

**KHÔNG viết thế này**:

```js
// SAI — dùng __VU để chọn operation
const opIndex = __VU % 5;
// VU=1 -> luôn product_list, VU=2 -> luôn product_detail, ...
// Split phụ thuộc VU speed → không deterministic

// SAI — dùng __ITER để chọn operation
const opIndex = __ITER % 5;
// VU=1 __ITER=4 và VU=2 __ITER=4 trùng operation
// Không kiểm soát được split toàn cục

// SAI — không handle JOBS % OP_COUNT != 0
const opIndex = Math.floor(exec.scenario.iterationInTest / 20);
// Nếu JOBS=101, operation cuối (report_generate) chỉ có 17 thay vì 20
```

## Yêu cầu cứng của case này

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Tổng completed iterations phải bằng `100` | Vì `100` là kích thước backlog, thiếu 1 job là coverage incomplete. |
| `shared_jobs_total == 100` | Iteration chạy xong chưa đủ; job phải được mark hoàn tất end-to-end. |
| `shared_jobs_failed == 0` | Có failed job nghĩa là business contract không đạt. |
| `http_reqs/shared_api_calls_total == 100 × 1 = 100` | Mỗi job phải gọi đúng số API trong flow. |
| Operation counts phải khớp expected breakdown | Tổng HTTP đúng nhưng thiếu một operation vẫn là coverage bug. CI không thể pass nếu order_confirm thiếu. |
| Job identity phải derive từ `exec.scenario.iterationInTest` | Worker identity `__VU` không đại diện cho business job. |
| Uneven per-VU distribution is normal | Worker nhanh xử lý nhiều job hơn là đúng mô hình shared pool. |
| Operation routing phải handle JOBS % OP_COUNT != 0 | Nếu JOBS không chia hết cho 5, split phải được xử lý tường minh. |

Nếu một trong các invariant về count/job fail, kết quả nên coi là **invalid hoặc fail**, không phải "pass nhưng hơi thiếu".

## Vì sao "CI fixed API checklist" nên dùng `shared-iterations`?

Mental model đúng:

```text
100 jobs đang nằm trong một queue/backlog.
10 VUs là 10 workers.
Worker nào rảnh thì lấy job kế tiếp.
Batch kết thúc khi queue hết job.
```

CI checklist là **ultimate shared-iterations use case** vì:

1. **Deterministic count** — CI phải so sánh được kết quả giữa build #123 và build #124. Nếu count thay đổi mỗi lần chạy, không biết sự khác biệt đến từ code change hay từ test chạy ít/nhiều hơn.

2. **Deterministic coverage** — CI phải biết chính xác operation nào đã được test. Không thể có chuyện "build #123 test được order_confirm 20 lần, build #124 chỉ test được 12 lần".

3. **Service-level gating** — Mỗi operation thuộc về một service owner khác nhau. Nếu ci_order_confirm fail, route về order team. Nếu ci_cart_add fail, route về cart team. Split phải deterministic để biết chính xác mỗi service được test bao nhiêu lần.

4. **Fail-fast CI pipeline** — CI muốn dừng sớm nếu operation đầu fail. Block-based routing cho phép test product_list trước, nếu fail thì không cần chạy các operation sau.

Nếu worker A xử lý 20 job còn worker B xử lý 8 job, điều đó không làm test sai. Nó chỉ nói worker A nhận được nhiều job hơn vì vòng lặp của nó quay lại sớm hơn.

### Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho fixed CI checklist? |
| --- | --- | --- |
| `shared-iterations` | Có tổng `iterations` chung và nhiều VU cùng chạy | **Đúng**: mô hình đúng là N job trong backlog, M worker xử lý đến khi hết việc. |
| `per-vu-iterations` | Count cũng deterministic | Sai nếu VU không phải business identity. Nó ép mỗi VU làm quota bằng nhau, không giống worker queue. Nếu dùng __VU làm operation routing, split không deterministic. |
| `constant-vus` | Nhìn giống worker pool | Sai khi cần exact count: tổng việc phụ thuộc duration và latency, không bảo đảm xử lý đúng N job. Không so sánh được giữa các CI build. |
| `constant-arrival-rate` | Kiểm soát được tốc độ vào | Sai cho batch drain: nó schedule arrivals theo rate, có thể drop, không phải danh sách job cố định cần xử lý hết. Drop có thể làm mất operation cụ thể. |
| `ramping-vus` | Có thể tăng/giảm worker | Sai nếu mục tiêu là exact backlog completion; shape VU biến thiên làm khó so sánh coverage giữa các build. |
| `ramping-arrival-rate` | Mô phỏng traffic thay đổi | Sai cho fixed-job coverage; phù hợp traffic surge hơn là batch/checklist. |

Kết luận:

```text
Cần exact total backlog coverage -> shared-iterations.
Cần deterministic operation split -> shared-iterations với iterationInTest routing.
Không cần mỗi VU có quota riêng -> không dùng per-vu-iterations.
Không lấy duration/rate làm input chính -> không dùng constant-vus/arrival-rate.
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

| Config/env | Giá trị | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `SI_07_VUS` | 10 | Số worker cùng xử lý backlog |
| `SI_07_JOBS` | 100 | Tổng số job toàn scenario |
| `maxDuration` | 10m | Safety cap, không phải target duration |
| `executor` | `shared-iterations` | Fixed global backlog + worker pool |

Mapping quan trọng:

```text
business backlog size = 100 jobs
k6 iterations         = 100
worker pool size      = 10 VUs
operation type count  = 5
jobs per operation    = 20
expected API calls    = 100 × 1 = 100
```

`maxDuration` chỉ là safety cap. Nếu cap này cắt run làm `iterations < 100`, kết quả không valid vì backlog chưa drain hết.

Operation coverage expected:

```text
ci_product_list: 20
ci_product_detail: 20
ci_cart_add: 20
ci_order_confirm: 20
ci_report_generate: 20
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
operation routing must be deterministic from iterationInTest
```

Nếu script cần chọn business object như operation type, checklist item, service endpoint, derive từ:

```js
exec.scenario.iterationInTest
```

Không derive từ:

```js
__VU
```

vì `__VU` chỉ nói worker nào đang cầm job hiện tại.

## Service/API flow

| Operation | Method | Path | Service | Expected | Expected count | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| ci_product_list | `GET` | `/api/sim/products?limit=10&cpu_ms=1&db_rows=2` | products | `200` | 20 | Verify products list endpoint. |
| ci_product_detail | `GET` | `/api/sim/products/:id?view=full&cpu_ms=1&db_rows=1` | products | `200` | 20 | Verify product detail endpoint. |
| ci_cart_add | `POST` | `/api/sim/cart/add?cpu_ms=1&db_writes=1` | cart | `200` | 20 | Verify cart add endpoint. |
| ci_order_confirm | `POST` | `/api/sim/orders/:id/confirm?cpu_ms=1&db_writes=1&external_ms=1&external_fail_rate=0` | order | `200` | 20 | Verify order confirm endpoint. |
| ci_report_generate | `GET` | `/api/sim/report?cpu_ms=1&db_rows=1&gzip_kb=1` | report | `200` | 20 | Verify report endpoint. |

Một job chỉ được coi là hoàn tất khi operation được gọi trả về 200 và pass checks.

### Latency profile khác nhau giữa các operation

Đây là điểm quan trọng khi đọc dashboard cho case 07:

```text
ci_product_list:
  - GET, chỉ đọc DB (db_rows=2), có cache → latency thấp nhất (~5-20ms)
  - Risk: cache miss, index scan lớn

ci_product_detail:
  - GET, đọc DB (db_rows=1), có JOIN → latency thấp-trung bình (~10-30ms)
  - Risk: JOIN query chậm, missing index

ci_cart_add:
  - POST, ghi DB (db_writes=1) → latency trung bình-cao (~20-80ms)
  - Risk: DB lock contention, write amplification

ci_order_confirm:
  - POST, ghi DB (db_writes=1) + external service (external_ms=1) → latency cao nhất (~50-200ms)
  - Risk: external service timeout, network latency, retry storm

ci_report_generate:
  - GET, đọc DB (db_rows=1) + CPU gzip (gzip_kb=1) → latency trung bình (~30-100ms)
  - Risk: CPU bound, memory pressure khi compression
```

Trên dashboard, 5 operation sẽ có 5 đường latency khác nhau. Đây là expected behavior, không phải bug. Điều cần quan tâm là:
- Mỗi operation có đủ 20 count không
- Operation nào có p95 đột biến so với baseline
- order_confirm có spike bất thường không (liên quan external service)

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
| `case_id` | Case đang chạy, ví dụ `si-07-ci-verification-batch`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service đang được gọi (products/cart/order/report). |
| `operation` | Bước nghiệp vụ/API cụ thể trong job. |
| `endpoint` | Nhóm endpoint/API family. |
| `job_id` | Business job trong backlog, derive từ global job index. |
| `executor_family` | `shared_iterations`. |
| `workload_shape` | `fixed_backlog`. |

Tags case này:

```text
case_id       = si-07-ci-verification-batch
business_case = ci_api_contract_verification
service       = mixed (products/cart/order/report)
operation     = ci_product_list | ci_product_detail | ci_cart_add | ci_order_confirm | ci_report_generate
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
ci_product_list: 20
ci_product_detail: 20
ci_cart_add: 20
ci_order_confirm: 20
ci_report_generate: 20
```

Đừng thêm pass condition kiểu:

```text
mỗi VU phải xử lý 100 / 10 = 10 jobs
```

Vì đó không phải invariant của `shared-iterations`.

### CI-specific pass criteria

Ngoài các criteria trên, CI verification batch còn cần:

```text
1. Operation split đúng 20/20/20/20/20 — nếu lệch, CI fail
2. Không operation nào có count = 0 — nếu có, service đó chưa được test
3. p95 từng operation không vượt CI latency gate (nếu có)
4. http_req_failed theo từng operation = 0 — tổng = 0 chưa đủ
```

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-07-ci-verification-batch.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-07-ci-verification-batch.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-07-ci-verification-batch.js
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
OP_COUNT = 5
JOBS_PER_OP = 20
expected iterations = 100
expected http_reqs = 100 × 1 = 100
expected per operation = 20
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
→ Một operation cụ thể quá chậm (vd: order_confirm external timeout)?
  → Route về service owner, không phải tăng vus.
```

Nếu `iterations == 100` nhưng `shared_jobs_total < 100`:

```text
iteration chạy xong nhưng job completion instrumentation/business branch bị thiếu
→ Kiểm script: có gọi jobDone() sau mỗi iteration không?
→ Có exception/early return nào bỏ qua job completion không?
```

### Bước 4 — Compare API and operation counts

Expected:

```text
http_reqs == 100
shared_api_calls_total == 100
ci_product_list: 20
ci_product_detail: 20
ci_cart_add: 20
ci_order_confirm: 20
ci_report_generate: 20
```

Tổng HTTP đúng nhưng operation split sai vẫn là coverage bug:

```text
VD: http_reqs = 100, nhưng:
  ci_product_list: 25       ← DƯ 5
  ci_product_detail: 22     ← DƯ 2
  ci_cart_add: 20           ← đúng
  ci_order_confirm: 18      ← THIẾU 2
  ci_report_generate: 15    ← THIẾU 5
→ 100 total, nhưng phân phối lệch
→ order_confirm và report_generate chưa được test đủ
→ CI KHÔNG THỂ PASS — routing bug hoặc operation bị skip
```

**Đặc biệt với case 07**: phải kiểm tra TỪNG operation count, không chỉ tổng. CI pass total 100 nhưng order_confirm = 0 vẫn là CI FAIL.

### Bước 5 — Interpret duration/throughput

`shared_job_duration_ms` trả lời:

```text
một business job end-to-end mất bao lâu
```

`http_req_duration` trả lời:

```text
mỗi request/API call mất bao lâu
```

Hai metric này khác nhau. Với case 07, API_PER_JOB = 1 nên 2 metric gần bằng nhau (chỉ khác phần check/processing overhead). Nhưng vẫn nên tách riêng để quen với pattern.

Case-specific summary notes:

- `iterations = 100` chứng minh 100 checklist jobs chạy.
- `http_reqs = 100` vì mỗi job gọi một API.
- Default split cần là 5 operations × 20 = 100.
- Phải kiểm tra COUNTS TỪNG OPERATION, không chỉ tổng HTTP.
- Nếu một operation có count = 0 → CI routing bug nghiêm trọng.
- Nếu một operation có count > 20 → operation khác bị thiếu.

Không check mỗi VU làm bằng nhau. Invariant là total completed work + deterministic operation split, không phải equal work per VU.

## Đọc dashboard real-time charts cho case 07

> Phần này mô tả expected reading pattern. Chỉ bổ sung run ID, p95/p99/max, bucket arrays sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? bucket nào có tail latency? | Backlog đã xử lý đủ chưa |
| Execution timeline | Theo thời gian đã hoàn tất bao nhiêu iterations/http_reqs/jobs? | Mỗi VU có làm bằng nhau không |
| VUs vs iter/s | Worker pool drain backlog nhanh/chậm ra sao? | Business correctness của từng job |

Một cách đọc nhanh:

```text
Response time      -> chất lượng request, phát hiện bottleneck theo service
Execution timeline -> backlog drain progress, phát hiện thiếu coverage
VUs vs iter/s      -> worker pool shape, phát hiện bất thường throughput
```

### Chart 1 — Response time

Đây là request-level latency. Với case này, đọc theo `operation`:

```text
ci_product_list: 20
ci_product_detail: 20
ci_cart_add: 20
ci_order_confirm: 20
ci_report_generate: 20
```

Cách đọc:

```text
avg  -> request thường nhanh/chậm thế nào
p95  -> phần lớn request có tail tới đâu
p99  -> tail hiếm hơn
max  -> spike lớn nhất trong bucket/run
```

Nhưng đừng kết luận pass/fail chỉ từ latency. Response time chỉ giúp tìm bottleneck.

#### Cách phân tích sâu chart Response time cho case 07

Khi nhìn chart này với 5 operation, đừng chỉ nhìn "cao/thấp". Hãy đọc theo 5 câu hỏi:

```text
1. 5 operation có latency profile khác nhau không? (expected: CÓ)
2. Operation nào chậm nhất? (expected: order_confirm, vì external service)
3. Operation nào nhanh nhất? (expected: product_list, vì cache)
4. Có operation nào p95 đột biến so với baseline không?
5. Có operation nào có count = 0 (không xuất hiện trên chart) không?
```

Với case 07, shape đẹp thường có:

```text
5 đường latency phân biệt rõ:
  product_list:      thấp nhất  (5-20ms,  cache + read-only)
  product_detail:    thấp-thứ-2 (10-30ms, read + JOIN)
  cart_add:          trung bình  (20-80ms, write DB)
  report_generate:   trung bình  (30-100ms, CPU gzip)
  order_confirm:     cao nhất   (50-200ms, write DB + external call)

Đầu run: p95/max có thể cao hơn (cold start)
Giữa run: p95 ổn định, 5 đường phân biệt rõ
Cuối run: p95 không tăng bất thường
```

Vì sao đầu run dễ cao hơn?

```text
- Request đầu tiên tới server có thể cold (cache miss, connection pool init)
- 10 VU cùng start -> request burst đầu lớn (10 concurrent requests)
- Nếu có auth/token, request đầu có thể chậm hơn
- order_confirm request đầu tiên cần khởi tạo external service connection
```

Case-specific bottleneck hints:

- `product_list` p95 cao bất thường → cache miss hoặc index scan lớn, route về products team.
- `cart_add` p95 cao → DB write contention hoặc lock, route về cart/DB team.
- `order_confirm` p95 cao → external service chậm hoặc timeout, route về order/infra team.
- `report_generate` p95 cao → CPU pressure hoặc memory khi gzip, route về report/infra team.
- Nếu TẤT CẢ operation cùng spike → vấn đề hạ tầng chung (network, load balancer, DB).
- Nếu CHỈ MỘT operation spike → vấn đề riêng của service đó.

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 cao ngay từ đầu rồi ổn định | cold start, cache miss đầu | kiểm cache warming |
| p95 tăng dần càng về cuối | leak, state phình trong backend | soi job_duration theo job_id |
| max spike lẻ tẻ nhưng p95 ổn | vài outlier đơn lẻ | xem log nhưng chưa vội fail CI |
| p95 và max cùng spike nhiều bucket | vấn đề hệ thống thật | chặn deploy / điều tra backend |
| order_confirm p95 >> các operation khác | external service chậm (có thể bình thường) | kiểm external service SLA |
| cart_add p95 >> product_list p95 | DB write path chậm hơn read path (có thể bình thường) | kiểm DB write performance |
| Một operation không xuất hiện trên chart | operation bị skip hoặc routing bug | kiểm script routing logic |
| 5 đường gộp làm 1 (không phân biệt được) | tất cả operation cùng latency → bất thường | kiểm xem có đang gọi nhầm endpoint không |

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
  "request nhanh/chậm thế nào? operation nào chậm?"

Execution timeline:
  "tại mỗi giây, test đã xử lý bao nhiêu job? còn bao nhiêu VU active?"
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
  iterations bắt đầu tăng sau bucket đầu (job cần thời gian hoàn tất)

giữa run:
  Live VUs vẫn gần 10 nếu backlog còn nhiều
  iterations tăng đều theo bucket
  Nếu dùng block-based routing, có thể thấy pattern:
    đầu: nhiều product_list hoàn thành
    giữa: cart_add và order_confirm
    cuối: report_generate

cuối run:
  Live VUs tụt xuống vì backlog gần hết
  iterations cũng tụt theo
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
| Một operation không có iteration hoàn thành | routing bug hoặc operation bị skip hoàn toàn |

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
- Nhiều HTTP request hoàn thành (có thể từ nhiều operation khác nhau)
- Một số iteration/job hoàn thành
- Nhiều check pass/fail
```

Điều kiện để một event rơi vào bucket nào:

```text
event timestamp thuộc giây nào -> rơi vào bucket giây đó
```

#### Vì sao bucket đầu có thể có httpReqs > 0 nhưng iterations = 0?

```text
Bucket đầu: VU vừa start, request đầu đã xong (API call)
nhưng full job (API call + check) chưa hoàn tất

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

Nếu iter_time avg = 0.3s:
  peak_rate ≈ 10 / 0.3 ≈ 33.3 iter/s

Nếu iter_time avg = 0.6s (có order_confirm chậm):
  peak_rate ≈ 10 / 0.6 ≈ 16.7 iter/s
```

**Điểm đặc biệt của case 07**: iter_time KHÔNG đồng đều giữa các operation. Khi block order_confirm đang chạy, iter_time trung bình cao hơn → iter/s thấp hơn. Đây là expected behavior, thể hiện rõ trên chart nếu dùng block-based routing:

```text
Nếu dùng block-based routing (mỗi operation 20 jobs liên tiếp):
  Block product_list (20 jobs):      iter/s cao (~30/s, latency thấp)
  Block product_detail (20 jobs):    iter/s cao (~25/s)
  Block cart_add (20 jobs):          iter/s trung bình (~15/s)
  Block order_confirm (20 jobs):     iter/s thấp (~10/s, external service)
  Block report_generate (20 jobs):   iter/s trung bình-thấp (~12/s)

  → Chart sẽ thấy iter/s GIẢM DẦN qua các block
  → Đây là expected, không phải performance regression
```

Đừng đọc chart này thành:

```text
mỗi VU phải xử lý 100 / 10 = 10 jobs
```

Với `shared-iterations`, đó là yêu cầu sai.

Shape mong đợi:

```text
- đầu run: iter/s có thể 0 (chưa job nào xong)
- giữa run: iter/s dao động theo batch hoàn thành
  + Nếu block-based: iter/s giảm dần khi đến operation chậm
  + Nếu modulo: iter/s tương đối đều (xen kẽ nhanh/chậm)
- cuối run: iter/s tụt khi backlog gần hết, rồi về 0
- đường VUs: gần 10 ở đầu/giữa, tụt ở cuối
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| `Actual iter/s` đầu = 0, sau đó tăng | job đầu chưa hoàn tất | bình thường |
| `Actual iter/s` dao động theo bucket | nhiều job finish không cùng thời điểm | bình thường |
| `Actual iter/s` giảm dần theo thời gian (block-based) | operation sau chậm hơn operation trước | expected với block routing |
| `Actual iter/s` = 0 lâu trong khi VUs cao | VU bị kẹt trong request, backend chậm | cần điều tra |
| `Actual iter/s` tụt về 0 và VUs cũng về 0 | test xong quota | bình thường |
| sum `Actual iter/s` < expected total | thiếu iteration / drop / interrupt | test invalid |
| VUs không lên tới 10 | config/env sai, VU init lỗi | kiểm header |
| `Actual iter/s` đột ngột giảm mạnh giữa run | một operation bị timeout hàng loạt | kiểm operation đang chạy ở thời điểm đó |

### Cách chốt từ summary -> 3 chart

```text
1. Summary quyết định pass/fail bằng counters/thresholds.
2. Execution timeline xác nhận backlog drain đủ theo thời gian.
3. Response time tìm operation/service chậm — quan trọng vì 5 service khác nhau.
4. VUs vs iter/s giải thích worker pool hoạt động ra sao.
5. Business decision dựa trên total coverage + failed jobs + operation breakdown + per-service latency.
```

## Kết luận thực tế: output -> quyết định

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **CI deploy gate**: output ra số như vậy thì team quyết định gì với việc deploy/promote lên production?

### Kịch bản A — output sạch: CI PASS (all green)

```text
iterations.........: 100           (đủ backlog)
http_req_failed....: 0.00%
shared_jobs_total..: 100
shared_jobs_failed.: 0
checks.............: 100.00%
ci_product_list....: 20            ✓
ci_product_detail..: 20            ✓
ci_cart_add........: 20            ✓
ci_order_confirm...: 20            ✓
ci_report_generate.: 20            ✓
iteration_duration.: p(95)=0.45s
```

Kết luận thực tế:

```text
- Count đủ 100 -> toàn bộ checklist đã chạy
- 0 fail, 0 job failed -> không API nào lỗi
- Operation breakdown đúng 20/20/20/20/20 -> tất cả 5 service được test đủ
- p95 0.45s -> latency OK
=> QUYẾT ĐỊNH: CI PASS. Cho phép deploy/promote lên production.
   Tất cả 5 service (products, cart, order, report) đều verified.
```

### Kịch bản B — một operation fail: ROUTE TO SERVICE OWNER

```text
iterations.........: 100           (vẫn đủ!)
shared_jobs_total..: 100
shared_jobs_failed.: 6            ← CÓ 6 JOB FAIL
checks.............: 94.00%
ci_product_list....: 20 (pass)
ci_product_detail..: 20 (pass)
ci_cart_add........: 20 (pass)
ci_order_confirm...: 14 (pass), 6 (fail)  ← ORDER SERVICE PROBLEM
ci_report_generate.: 20 (pass)
```

Kết luận thực tế:

```text
- Count vẫn 100 -> KHÔNG phải lỗi test, coverage attempt đủ
- Nhưng 6 job failed, TẤT CẢ đều ở ci_order_confirm
- 4 operation khác đều pass 100%
- order_confirm fail 6/20 = 30%
=> QUYẾT ĐỊNH: CI FAIL. BLOCK deploy.
   Route về ORDER TEAM: kiểm tra external service cho order confirm.
   Có thể external service bị quá tải, timeout, hoặc contract thay đổi.
   Products, cart, report teams: OK, không bị block.
   
   Đây CHÍNH LÀ giá trị của shared-iterations + deterministic operation split:
   biết chính xác service nào fail, route đúng owner, không block team không liên quan.
```

### Kịch bản C — thiếu iteration: TEST INVALID (không kết luận được)

```text
iterations.........: 72            (THIẾU 28!)
http_req_failed....: 2.1%
interrupted........: 28
ci_product_list....: 20
ci_product_detail..: 20
ci_cart_add........: 17            ← THIẾU 3
ci_order_confirm...: 12            ← THIẾU 8
ci_report_generate.: 3             ← THIẾU 17! GẦN NHƯ CHƯA TEST
```

Kết luận thực tế:

```text
- 72 < 100 -> backlog chưa drain hết -> KHÔNG kết luận được CI pass hay fail
- report_generate mới test được 3/20 -> report service gần như chưa được verify
- order_confirm mới test 12/20 -> không đủ để kết luận
- Trước khi nói gì về service, phải sửa cho test chạy đủ 100 đã:
    interrupted=28 -> maxDuration quá ngắn? Tăng maxDuration.
    Hoặc iter_time quá dài? order_confirm có external service timeout?
    Hoặc VU không đủ? Tăng vus.
=> QUYẾT ĐỊNH: CHƯA kết luận CI pass/fail. Test invalid, chạy lại
   sau khi sửa nguyên nhân thiếu count.
```

### Kịch bản D — count đủ, operation split sai: COVERAGE BUG (CI phải fail)

```text
iterations.........: 100
http_reqs..........: 100           (tổng đúng!)
checks.............: 100.00%       (tất cả pass!)
ci_product_list....: 35            ← DƯ 15
ci_product_detail..: 28            ← DƯ 8
ci_cart_add........: 20            ← đúng
ci_order_confirm...: 12            ← THIẾU 8
ci_report_generate.: 5             ← THIẾU 15! CHỈ TEST 25%
```

Kết luận thực tế:

```text
- Tổng http_reqs = 100, checks = 100% -> nhìn qua tưởng CI PASS
- NHƯNG: operation split = 35/28/20/12/5 thay vì 20/20/20/20/20
- order_confirm chỉ được test 12 lần (thiếu 8)
- report_generate chỉ được test 5 lần (thiếu 15 — coverage 25%)
- Có thể do bug trong script: operation routing dùng __VU thay vì iterationInTest
- Hoặc code branch skip operation cuối
=> QUYẾT ĐỊNH: CI FAIL. BLOCK deploy.
   Sửa script routing để operation split deterministic.
   Đây là lỗi COVERAGE ẨN — tổng HTTP đúng + checks pass 
   không có nghĩa coverage từng service đúng.
   Nếu CI pass với split này, report service có thể regression mà không bị phát hiện.
```

### Kịch bản E — count đủ, split đúng, nhưng latency vượt gate: PERFORMANCE REGRESSION

```text
iterations.........: 100
operation split....: 20/20/20/20/20  ✓
http_req_failed....: 0.00%           ✓
ci_order_confirm p95: 850ms          ← VƯỢT CI GATE (threshold: 500ms)
ci_cart_add p95.....: 45ms           ← OK
```

Kết luận thực tế:

```text
- Functional: pass (tất cả operation đủ count, không fail)
- Performance: FAIL (order_confirm p95 vượt gate)
=> QUYẾT ĐỊNH: Tùy CI policy.
   Strict mode: BLOCK deploy (performance regression không được phép).
   Warn mode:   Cảnh báo, route về order team điều tra external service.
   Permissive:  Cho pass nếu chỉ cần functional verification.
```

### Bảng ánh xạ nhanh output -> hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 100 jobs, split 20/20/20/20/20, 0 fail | CI checklist hoàn tất, 5 service OK | CI PASS, cho phép deploy |
| 100 jobs, shared_jobs_failed > 0, chỉ 1 operation fail | service cụ thể có vấn đề | CI FAIL, route về service owner |
| 100 jobs, split đúng, order_confirm p95 vượt gate | performance regression ở order service | BLOCK hoặc WARN tùy policy |
| 100 jobs, split sai (lệch 20/20/20/20/20) | coverage bug — operation routing sai | CI FAIL, sửa script routing |
| < 100 iter (drop/interrupt) | test chưa hợp lệ, backlog chưa drain hết | sửa config, chạy lại |
| http_reqs = 100 nhưng một operation count = 0 | operation bị skip hoàn toàn | CI FAIL, kiểm script logic |
| Counts pass nhưng p95 tất cả operation cao | infrastructure-level regression | investigate hạ tầng chung |
| VU distribution uneven | normal worker-pool behavior | do not fail |

Điểm cốt lõi của case này: **vì count luôn cố định 100 và operation routing deterministic, mọi thiếu hụt ở operation breakdown hoặc failed jobs đều là tín hiệu THẬT về service, không bị nhiễu bởi "lần này test chạy nhiều/ít hơn lần trước"**. Đó là lý do CI deploy gate dùng shared-iterations.

## "Nghịch lý" và misconceptions của shared-iterations trong CI context

### Nghịch lý 1: 100 jobs nhưng checks có thể > 100?

```text
iterations: 100
http_reqs:  100
checks:     200+ ?

"Sao 100 jobs mà checks > 100? Mỗi job chỉ có 1 API call mà?"
```

**Trả lời: mỗi job có thể có nhiều check.**

```text
1 job = 1 API call = có thể N checks:
  - check status 200
  - check response time < 2s
  - check response body có field bắt buộc
  - check content-type
  - check schema validation
  - ...

VD: mỗi job 3 checks × 100 jobs = 300 checks

→ Tổng checks > 100 là BÌNH THƯỜNG, không phải bug.
→ checks rate = checks_pass / checks_total, tỉ lệ pass mới quan trọng.
```

### Nghịch lý 2: Tất cả HTTP pass nhưng CI nên fail?

```text
http_req_failed: 0.00%     ← tất cả HTTP 200
checks: 100.00%            ← tất cả checks pass
operation split: 35/28/20/12/5 ← SAI!

"Tất cả request đều 200, tất cả checks pass, sao CI vẫn fail?"
```

**Trả lời: vì COVERAGE SAI. Pass 100 request không có nghĩa test đúng 100 mục cần test.**

```text
CI checklist yêu cầu:
  - Test 20 lần product_list   → đã test 35 (dư, lãng phí)
  - Test 20 lần order_confirm  → mới test 12 (thiếu 8)
  - Test 20 lần report_generate → mới test 5 (thiếu 15)

→ Dù 100 request đều pass, order và report service chưa được test đủ.
→ Nếu report service bị regression, CI vẫn pass (vì 5 request pass).
→ Nhưng production: user thứ 6 gọi report → lỗi.

Kết luận: CI phải fail vì coverage incomplete.
Tương tự: kiểm tra 100 câu hỏi, nhưng chỉ kiểm đi kiểm lại 3 câu đầu.
Dù 3 câu đó đúng hết, 97 câu còn lại vẫn chưa được kiểm.
```

### Nghịch lý 3: 10 VUs nhưng chỉ 5 operation types?

```text
vus = 10
operation types = 5

"Sao 10 workers mà chỉ có 5 loại operation? Worker nào làm operation nào?"
```

**Trả lời: worker != operation. Mỗi worker có thể làm BẤT KỲ operation nào.**

```text
Worker pool: 10 workers, cùng làm 5 loại operation.
Operation type được chọn từ iterationInTest, KHÔNG từ __VU.

VU=1 có thể làm: product_list (iter #0), cart_add (iter #7), report (iter #9)...
VU=2 có thể làm: product_detail (iter #1), order_confirm (iter #6)...
...

→ Mỗi VU là generalist, làm được mọi operation.
→ 5 operation types là business classification, không liên quan số worker.
→ Có thể tăng VU lên 20, operation types vẫn là 5.
→ Có thể giảm VU xuống 3, operation types vẫn là 5.
```

### Nghịch lý 4: iteration_duration = 0.3s nhưng iter/s = 33.3?

```text
iteration_duration: avg=0.3s     <- 1 job mất 0.3 giây
iterations:         33.3/s       <- nhưng 1 giây ra 33.3 job

Sao 1 job mất 0.3s mà mỗi giây lại ra được 33.3 job?
"Lẽ ra 0.3s mới ra 1 job chứ?"
```

**Trả lời: vì 10 VU chạy SONG SONG, không phải 1 VU.**

```text
iteration_duration = thời gian 1 VU làm xong 1 job = 0.3s
iterations rate    = tổng job hoàn thành / tổng thời gian (cả pool) = 33.3/s

Công thức nối 2 con số (Little's Law):
  rate = vus / iter_time
  33.3 ≈ 10 / 0.3 ✓

Ví dụ trực quan:
  10 kỹ sư QA, mỗi người kiểm 1 mục mất 0.3 phút:
    - 1 mục VẪN mất 0.3 phút (không nhanh hơn)
    - nhưng 10 người kiểm song song -> mỗi phút ra ~33.3 mục
```

### Nghịch lý 5: VU=10, jobs=100, sao có VU làm 15 job, VU khác chỉ 4?

```text
Đây là câu hỏi phổ biến nhất từ learner chuyển từ per-vu-iterations sang.

Trong per-vu-iterations:
  iterations=10, vus=10 -> mỗi VU chạy ĐÚNG 10 iter = 100 total
  → Phân phối ĐỀU (mỗi VU 10)

Trong shared-iterations:
  iterations=100, vus=10 -> tổng 100 iter, CHIA KHÔNG ĐỀU
  → VU nhanh: 15 iter, VU chậm: 4 iter
  → Tổng = 100, nhưng phân phối LỆCH
```

Vì sao? Vì cơ chế atomic counter "first come first served":

```text
VU nào xong job -> gọi atomic.AddUint64 -> lấy job tiếp theo
VU nhanh (network tốt, latency thấp) -> xong sớm -> gọi sớm -> lấy nhiều
VU chậm (network kém, gặp order_confirm external service) -> xong muộn -> lấy ít

Đây là ĐẶC TRƯNG của worker pool, không phải bug.
Giống như: kỹ sư QA nhanh kiểm nhiều mục hơn kỹ sư QA chậm.
Và operation split VẪN đúng 20/20/20/20/20 vì routing từ iterationInTest.
```

## Checklist đọc biểu đồ case 07

Khi học sinh nhìn dashboard case 07, đọc theo thứ tự này:

```text
1. Overview KPI
   - iterations = 100?
   - http_req_failed = 0%?
   - checks = 100%?
   - shared_jobs_total = 100?
   - shared_jobs_failed = 0?

2. Operation breakdown (QUAN TRỌNG NHẤT — filter theo tag operation)
   - ci_product_list = 20?
   - ci_product_detail = 20?
   - ci_cart_add = 20?
   - ci_order_confirm = 20?
   - ci_report_generate = 20?
   - Có operation nào = 0 không? (nếu có -> routing bug)
   - Có operation nào > 20 không? (nếu có -> operation khác thiếu)

3. Response time chart
   - Tách theo operation (5 operation) chưa?
   - 5 đường latency có phân biệt được không?
   - Operation nào chậm nhất? (expected: order_confirm)
   - Operation nào nhanh nhất? (expected: product_list)
   - Có operation nào p95 đột biến không?
   - order_confirm có spike không? (liên quan external service)

4. Execution timeline
   - Live VUs đầu có = 10 không?
   - Cuối run VUs có tụt dần về 0 không?
   - sum iterations theo bucket có = 100 không?
   - sum http_reqs theo bucket có = 100 không?
   - sum shared_jobs_total theo bucket có = 100 không?
   - shared_jobs_failed có = 0 ở mọi bucket không?
   - Nếu dùng block-based: thấy pattern iter/s giảm dần không?

5. VUs vs iter/s
   - Actual iter/s theo bucket dao động thế nào?
   - sum actual iter/s có = 100 không?
   - VUs có giữ gần 10 ở đầu/giữa run không?
   - Cuối run VUs có tụt về 0 không?
   - Nếu block-based: iter/s có giảm khi đến operation chậm không?

6. Business decision
   - Tất cả counters pass?
   - Operation breakdown đúng 20/20/20/20/20?
   - shared_jobs_failed = 0?
   - Từng operation http_req_failed = 0?
   - Nếu tất cả pass -> CI PASS, cho phép deploy
   - Nếu 1 operation fail -> route về service owner
   - Nếu split sai -> CI FAIL, sửa script routing
```

Kết luận của run case 07 đang đúng nếu thấy:

```text
iterations = 100
http_req_failed = 0%
checks = 100%
shared_jobs_total = 100
shared_jobs_failed = 0
ci_product_list = 20
ci_product_detail = 20
ci_cart_add = 20
ci_order_confirm = 20
ci_report_generate = 20
Live VUs: đầu = 10, cuối giảm về 0
sum chart iterations = summary iterations
sum chart httpReqs = summary http_reqs
executor = shared-iterations
5 đường latency phân biệt trên response time chart
```

## Mở rộng / variation

### Variation A: Thêm auth validation vào mỗi operation

Một số CI checklist yêu cầu test cả auth layer:

```js
const OPERATIONS_WITH_AUTH = [
  {
    name: "ci_product_list",
    method: "GET",
    path: "/api/sim/products?limit=10&cpu_ms=1&db_rows=2",
    service: "products",
    requireAuth: false,  // public endpoint
  },
  {
    name: "ci_cart_add",
    method: "POST",
    path: "/api/sim/cart/add?cpu_ms=1&db_writes=1",
    service: "cart",
    requireAuth: true,   // cần auth token
  },
  // ...
];

export default function (data) {
  const jobIndex = exec.scenario.iterationInTest;
  const opIndex = Math.floor(jobIndex / JOBS_PER_OP);
  const op = OPERATIONS_WITH_AUTH[opIndex];

  const headers = {};
  if (op.requireAuth) {
    headers["Authorization"] = `Bearer ${data.token}`;
  }

  const res = http.request(op.method, `${BASE_URL}${op.path}`, null, {
    headers,
    tags: {
      operation: op.name,
      service: op.service,
      require_auth: op.requireAuth ? "yes" : "no",
    },
  });

  check(res, {
    [`${op.name} status 200`]: (r) => r.status === 200,
  });
}
```

### Variation B: Thay đổi tỉ lệ operation split (weighted CI checklist)

Không phải CI checklist nào cũng cần tỉ lệ đều. Một số operation quan trọng hơn, cần test nhiều hơn:

```js
// Weighted operation split: product_list quan trọng nhất, test 40 lần
const OP_WEIGHTS = [40, 15, 15, 15, 15]; // tổng = 100
const OP_NAMES = [
  "ci_product_list",
  "ci_product_detail",
  "ci_cart_add",
  "ci_order_confirm",
  "ci_report_generate",
];

function getOperationByWeight(jobIndex) {
  let cumulative = 0;
  for (let i = 0; i < OP_WEIGHTS.length; i++) {
    cumulative += OP_WEIGHTS[i];
    if (jobIndex < cumulative) {
      return i;
    }
  }
  return OP_WEIGHTS.length - 1; // fallback
}

export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  const opIndex = getOperationByWeight(jobIndex);
  const op = OPERATIONS[opIndex];
  // ...
}

// Split: product_list=40, product_detail=15, cart_add=15, order_confirm=15, report=15
```

**Dùng khi**: product list là critical path, cần verify kỹ hơn các service khác. Vẫn deterministic — mỗi lần CI chạy đều ra split 40/15/15/15/15.

### Variation C: Multi-scenario CI — contract test + performance test

```js
export const options = {
  scenarios: {
    // Functional contract verification (case này)
    ci_contract: {
      executor: "shared-iterations",
      vus: 10,
      iterations: 100,
      tags: { case_id: "si-07-ci-verification-batch", test_type: "contract" },
    },
    // Performance smoke test (chạy đồng thời)
    ci_perf_smoke: {
      executor: "constant-vus",
      vus: 5,
      duration: "30s",
      startTime: "2s",  // delay nhẹ để không overlap burst đầu
      tags: { case_id: "si-07-ci-perf-smoke", test_type: "performance" },
    },
  },
};
```

**Dùng khi**: CI pipeline cần cả functional verification (deterministic checklist) và performance smoke test (constant load). Hai scenario chạy song song, tag khác nhau để lọc riêng trên dashboard.

### Variation D: CI pipeline với fail-fast (dừng sớm nếu operation đầu fail)

```js
// Block-based routing + manual abort nếu operation đầu fail
const FAIL_FAST = true;
let failFastTriggered = false;

export default function () {
  if (FAIL_FAST && failFastTriggered) {
    return; // skip, nhưng iteration vẫn tính vào count
  }

  const jobIndex = exec.scenario.iterationInTest;
  const opIndex = Math.floor(jobIndex / JOBS_PER_OP);
  const op = OPERATIONS[opIndex];

  const res = http.request(op.method, `${BASE_URL}${op.path}`, null, {
    tags: { operation: op.name, service: op.service },
  });

  const passed = check(res, {
    [`${op.name} status 200`]: (r) => r.status === 200,
  });

  if (!passed && opIndex === 0) {
    // Operation đầu tiên (product_list) fail -> dừng CI sớm
    failFastTriggered = true;
    console.error(`FAIL-FAST: ${op.name} failed at job #${jobIndex}, aborting CI`);
  }
}
```

**Dùng khi**: CI muốn dừng sớm nếu operation đầu fail, tiết kiệm thời gian CI pipeline. Product list là operation nền tảng — nếu nó fail, các operation khác gần như chắc chắn cũng fail.

### Variation E: Thêm threshold latency theo từng operation

```js
export const options = {
  thresholds: {
    // Mỗi operation có latency gate riêng
    "http_req_duration{operation:ci_product_list}":      ["p(95)<200"],
    "http_req_duration{operation:ci_product_detail}":    ["p(95)<300"],
    "http_req_duration{operation:ci_cart_add}":          ["p(95)<500"],
    "http_req_duration{operation:ci_order_confirm}":     ["p(95)<800"],  // external service, cho phép chậm hơn
    "http_req_duration{operation:ci_report_generate}":   ["p(95)<600"],
    
    // Global checks
    "checks": ["rate==1"],
    "http_req_failed": ["rate==0"],
  },
};
```

**Dùng khi**: CI cần vừa functional verification vừa performance gate. Mỗi service có SLA khác nhau — product_list phải nhanh hơn order_confirm. Threshold tag theo operation cho phép granular control.

## Anti-pattern

- Dùng `__VU` làm business identity chính cho operation routing.
- Fail test chỉ vì VU distribution không đều.
- Dùng `constant-vus` rồi suy ra exact job count từ duration.
- Dùng arrival-rate executor cho bài toán drain fixed checklist.
- Chỉ nhìn response time đẹp mà không kiểm `shared_jobs_total` và operation counts.
- Chỉ kiểm tổng HTTP = 100 mà không kiểm operation breakdown 20/20/20/20/20.
- Giữ expected formulas cũ sau khi override `JOBS`.
- Dùng per-VU state (session, token) kỳ vọng sống qua nhiều iter — mỗi iter là 1 operation khác nhau.
- Kiểm tra `iterations_per_vu == JOBS / vus` như một pass criteria.
- Không handle trường hợp JOBS % OP_COUNT != 0 trong script routing.
- CI pass khi operation split sai (35/28/20/12/5) nhưng tổng HTTP = 100.
- Route cả team khi chỉ 1 service fail — phải route chính xác service owner dựa trên operation tag.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-07-ci-verification-batch.js`
- Case 01 catalog audit (reference pattern): `./01_catalog-audit.md`
