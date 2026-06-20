# Case 02: Order reconciliation

## Tình huống thực tế

Team order/payment có một backlog order pending/failed cần reconcile sau sự cố payment, retry job, hoặc migration order state.

Mỗi order phải được confirm/re-confirm rồi verify trạng thái cuối. Nếu một order bị skip, finance/support có thể thấy order treo dù batch test báo xanh.

Case này trả lời: 8 worker có xử lý đủ 120 order jobs không, và confirm có được verify bằng status/history không?

Tóm tắt đời thường:

```text
Trigger: payment incident recovery, order migration, retry confirm batch, hoặc nightly reconciliation
Backlog: 120 pending/failed order reconciliation jobs
Risk nếu skip job: một order có thể vẫn pending/failed nhưng không ai biết batch bỏ sót
```

Case này **không** cố gắng trả lời "production traffic giống thật chưa?". Nó trả lời câu hỏi batch/ops cụ thể hơn:

```text
Có xử lý đủ fixed backlog không?
Mỗi job có đi đúng business flow không?
Có job nào fail không?
```

### Vì sao "order reconciliation fixed backlog" buộc chọn shared-iterations?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của order reconciliation trước:

```text
Order reconciliation = "duyệt qua TỪNG order trong danh sách cố định,
                        gọi POST confirm + GET verify status,
                        xác nhận order đã được reconcile thành công"

Đời thường:
  Kho tài chính có 120 hóa đơn (= 120 order) cần đối soát
  8 nhân viên kế toán (= 8 VU)
  Mỗi hóa đơn cần: gửi lệnh confirm (= POST) + kiểm sổ sách xem đã ghi nhận chưa (= GET verify)
  Nhân viên nào xong hóa đơn trước thì lấy hóa đơn tiếp theo
  Kết thúc khi TẤT CẢ 120 hóa đơn đã được đối soát
```

Để order reconciliation **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ shared-iterations mới thỏa mãn cả 2.

#### Yêu cầu (a): EXACT TOTAL COVERAGE (không thiếu order nào)

**Ý nghĩa**: Phải reconcile ĐỦ 120 order. Thiếu 1 order là coverage incomplete — order đó có thể vẫn treo pending/failed mà không ai biết.

**Ví dụ cụ thể**:

```text
Scenario: payment gateway bị sập 2 giờ, 120 order dính pending cần reconcile

Trường hợp A (coverage ĐỦ):
  Reconcile 120 order, tất cả confirm + verify pass
  → Kết luận: batch reconciliation OK, tất cả order đã về trạng thái đúng

Trường hợp B (coverage THIẾU - bug):
  Reconcile 85 order (thiếu 35), 85 order đã reconcile đều pass
  → Tưởng OK, nhưng 35 order chưa reconcile có thể đang treo pending
  → Finance: khách đã trả tiền nhưng order vẫn pending → mất tiền + mất khách
  → KHÔNG kết luận được, test không có giá trị
```

**Vì sao total iterations phải chính xác 120?**

```text
Nếu total phụ thuộc duration:
  - duration cố định 60s
  - latency thấp  → reconcile được 120 order (đủ)
  - latency cao   → reconcile được 85 order (thiếu 35)
  - latency tăng do payment gateway chậm, không phải do ít order hơn
  → Mỗi lần test số order reconcile được khác → không biết coverage có đủ không
```

**Phân tích sâu: vì sao 2 executor "duration-based" không đảm bảo count?**

`constant-vus` với `duration: "60s"`:

```text
Công thức count khi chạy:
  count_jobs = duration × throughput
             = 60s × (vus / iter_time)
             = 60s × (8 / iter_time)
             = 480 / iter_time

iter_time KHÔNG cố định, biến thiên do:
  - external_ms ở confirm path (payment gateway, tùy network)
  - db_writes ở confirm (có thể bị lock contention khi nhiều VU cùng confirm)
  - include_history ở status verify (JOIN với bảng lịch sử, có thể chậm nếu history lớn)
  - server load (nếu reconcile chạy giờ cao điểm, latency tăng)

Ví dụ thực tế chạy 3 lần liên tiếp cùng config:
  Lần 1: payment gateway phản hồi nhanh, cache warm
    iter_time avg = 0.70s -> count = 480/0.70 ≈ 685 jobs reconcile
    (dư rất nhiều! nhưng có thể reconcile lặp order đầu, thiếu order cuối)
  Lần 2: payment gateway bình thường, network ổn
    iter_time avg = 0.50s -> count = 480/0.50 = 960 jobs reconcile
  Lần 3: payment gateway chậm (retry, timeout), db_writes bị lock
    iter_time avg = 1.40s -> count = 480/1.40 ≈ 342 jobs reconcile

  Vấn đề KHÔNG chỉ là count khác nhau.
  Vấn đề LỚN HƠN: không biết 120 order có được reconcile ĐỦ không.
  685 jobs có thể = reconcile lặp 40 order đầu × ~17 lần, bỏ sót 80 order cuối.
```

`constant-arrival-rate` với `rate: 4/s, duration: "35s"`:

```text
Mục tiêu config: "4 job/s × 35s = 140 jobs TOTAL"
→ Dư so với 120 order cần reconcile. Nhưng...

KHÔNG đảm bảo đạt 140 vì có thể DROP slot:
  - Khi rate target > năng lực VU pool
  - Khi payment gateway chậm bất thường ở 1 đoạn (external_ms spike, network partition)
  - Khi spawn VU không kịp lúc đầu

Công thức thực tế:
  N_done = N_sched - N_drop - N_int
         = 140 - N_drop - N_int

Ví dụ thực tế:
  Lần 1: pool vừa khít, confirm nhanh, không drop
    N_drop = 0, N_done = 140 (dư 20 so với 120, reconcile lặp)
  Lần 2: payment gateway có 15s chậm ở giữa
    N_drop = 40, N_done = 100 (thiếu 20 order!)
  Lần 3: db_writes bị lock 10s ở đầu
    N_drop = 20, N_int = 8, N_done = 112 (thiếu 8 order)

  KHÔNG可靠: lần được lần không, không biết trước
```

**Trong khi đó với `shared-iterations`**:

```text
Config: vus=8, iterations=120
N_done = 120 (TUYỆT ĐỐI, nếu không bị maxDuration cắt)

Lần 1: payment gateway chậm  -> 120 jobs, T_run=95s, p95=2.1s
Lần 2: payment gateway nhanh -> 120 jobs, T_run=52s, p95=0.8s
Lần 3: payment gateway bình thường -> 120 jobs, T_run=68s, p95=1.2s

Count CỐ ĐỊNH ở 120 mỗi lần.
Chỉ có T_run + latency thay đổi -> đó CHÍNH LÀ cái cần đo!

→ 120 order luôn được reconcile đủ → coverage guarantee
→ Nếu latency tăng, T_run tăng → phát hiện được payment gateway regression
```

**Tóm tắt 3 executor về count**:

| Executor | Count formula | Count cố định? | Order coverage guarantee? |
| --- | --- | --- | --- |
| **shared-iterations** | `iterations` | CÓ (tuyệt đối) | CÓ (nếu identity map đúng) |
| constant-vus (duration) | `duration × vus / iter_time` | KHÔNG (do iter_time) | KHÔNG (có thể reconcile lặp hoặc thiếu) |
| constant-arrival-rate | `N_sched - N_drop - N_int` | KHÔNG (do drop/int) | KHÔNG (drop có thể bỏ sót order) |

→ COUNT phải CHÍNH XÁC, KHÔNG phụ thuộc latency
→ Chỉ executor đếm theo "iterations cố định" mới đạt
→ Nhưng count đủ chưa đủ — còn cần identity map ĐÚNG (yêu cầu b)

#### Yêu cầu (b): CORRECT IDENTITY MAPPING (mỗi job map đúng 1 order)

**Ý nghĩa**: 120 iteration phải map sang 120 order KHÁC NHAU. Nếu map sai, dù count = 120, coverage vẫn thiếu.

**Bug identity mapping là gì?**

```text
Trường hợp ĐÚNG — identity từ iterationInTest:
  iter #0   -> order #0   (reconcile confirm + verify)
  iter #1   -> order #1
  iter #2   -> order #2
  ...
  iter #119 -> order #119
  → 120 order unique được reconcile ✓

Trường hợp SAI — identity từ __VU:
  VU=1: __VU=1 -> order=1 (lặp lại ~18 lần)
  VU=2: __VU=2 -> order=2 (lặp lại ~16 lần)
  ...
  VU=8: __VU=8 -> order=8 (lặp lại ~12 lần)
  → Chỉ 8 order được reconcile (lặp đi lặp lại)
  → 112 order còn lại KHÔNG BAO GIỜ được reconcile
  → Dù iterations = 120, coverage thật chỉ = 8/120 ≈ 6.7%
```

Đặc biệt với order reconciliation, bug identity mapping còn gây ra **idempotency key collision**: nếu idempotency key derive từ `__VU`, 2 VU khác nhau có thể dùng cùng key cho 2 order khác nhau → payment gateway từ chối vì idempotency conflict, hoặc tệ hơn: confirm sai order.

### Vì sao per-vu-iterations thất bại cho order reconciliation

Ngoài 2 executor duration-based ở trên, cần giải thích vì sao `per-vu-iterations` cũng không phù hợp dù count cố định:

```text
per-vu-iterations: vus=8, iterations=15
→ mỗi VU chạy ĐÚNG 15 iter = 120 total
→ Count cố định, nghe có vẻ OK

Nhưng vấn đề: mỗi VU chạy 15 iter với CÙNG identity
→ VU=1 chạy 15 lần cho order #1
→ VU=2 chạy 15 lần cho order #2
→ ...
→ VU=8 chạy 15 lần cho order #8

→ Chỉ 8 order được reconcile, mỗi order bị confirm 15 lần!
→ 112 order còn lại không bao giờ được đụng tới

Trong order reconciliation:
  - Mỗi order CHỈ cần được reconcile MỘT LẦN
  - Confirm 15 lần cho cùng 1 order là VÔ NGHĨA và CÓ HẠI
    (có thể gây ra duplicate charge, idempotency conflict, hoặc state corruption)

→ per-vu-iterations phù hợp khi VU = business identity
  (vd: mỗi VU là 1 user, cần replay 15 action của user đó)
→ Nhưng KHÔNG phù hợp khi cần xử lý 120 order KHÁC NHAU
```

**Demo trace so sánh per-vu-iterations vs shared-iterations cho order reconciliation**:

```text
Scenario: 120 order (order #0 đến order #119), 8 VU

=== per-vu-iterations (vus=8, iterations=15) ===

VU=1: reconcile order #1 × 15 lần
  Iter 1: POST confirm order #1 → GET verify order #1
  Iter 2: POST confirm order #1 → GET verify order #1  ← LẶP!

VU=2: reconcile order #2 × 15 lần
  Iter 1: POST confirm order #2 → GET verify order #2
  Iter 2: POST confirm order #2 → GET verify order #2  ← LẶP!

...
VU=8: reconcile order #8 × 15 lần

Kết quả: 120 iter, nhưng chỉ 8 order unique được reconcile ❌
  order #9 → #119: CHƯA BAO GIỜ được reconcile!

=== shared-iterations (vus=8, iterations=120) ===

VU bất kỳ: lấy iter tiếp theo từ pool
  Iter #0  → reconcile order #0
  Iter #1  → reconcile order #1
  ...
  Iter #119 → reconcile order #119

Kết quả: 120 iter, 120 order unique được reconcile ✓
  Mỗi order đúng 1 lần, không thiếu, không thừa
```

### Tổng kết: chỉ shared-iterations thỏa mãn cả (a) và (b)

| Executor | (a) Exact total coverage | (b) Correct identity mapping | Verdict |
| --- | --- | --- | --- |
| **shared-iterations** | ✓ iterations cố định | ✓ nếu dùng iterationInTest | ✅ DÙNG |
| per-vu-iterations | ✓ count cố định | ✗ mỗi VU chỉ 1 identity, lặp lại | ❌ |
| constant-vus (duration) | ✗ count phụ thuộc latency | ✗ VU random pick, identity không ổn định | ❌ |
| constant-arrival-rate | ✗ có thể drop | ✗ rate-driven, không bound vào job index | ❌ |
| ramping-vus | ✗ count biến thiên theo time | ✗ VU spawn lệch theo timeline | ❌ |
| ramping-arrival-rate | ✗ count biến thiên + drop | ✗ rate-driven, không bound job | ❌ |

→ Chỉ **shared-iterations** thỏa mãn cả 2 yêu cầu, các executor khác đều fail ở ít nhất 1 trong 2.

### 3 thông số config ánh xạ từ yêu cầu nghiệp vụ

```text
1. FIXED BACKLOG SIZE (tổng số job cố định):
   - Payment team có danh sách 120 order cần reconcile
   - Không phải "reconcile trong 10 phút", mà là "reconcile ĐỦ 120 order"
   → iterations = 120 (tổng job toàn scenario)
   → KHÔNG dùng duration làm input chính

2. WORKER POOL SIZE (số worker cùng xử lý):
   - 8 worker cùng reconcile để xong nhanh hơn
   - Không quan trọng worker nào làm bao nhiêu, miễn tổng đủ
   → vus = 8 (số worker)
   → KHÔNG cần mỗi VU reconcile đúng 15 order

3. COVERAGE COMPLETENESS (mỗi job đi qua đủ flow):
   - Mỗi job: POST confirm + GET status verify = 2 API calls
   - 120 jobs × 2 API = 240 total API calls
   → http_reqs = 240 (deterministic, nếu không fail)
   → shared_api_calls_total = 240
```

## Yêu cầu cứng của case này

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Tổng completed iterations phải bằng `120` | Vì `120` là kích thước backlog, thiếu 1 job là coverage incomplete. |
| `shared_jobs_total == 120` | Iteration chạy xong chưa đủ; job phải được mark hoàn tất end-to-end. |
| `shared_jobs_failed == 0` | Có failed job nghĩa là business contract không đạt. |
| `http_reqs/shared_api_calls_total == 120 × 2 = 240` | Mỗi job phải gọi đúng số API trong flow. |
| Operation counts phải khớp expected breakdown | Tổng HTTP đúng nhưng thiếu một operation vẫn là coverage bug. |
| Job identity phải derive từ `exec.scenario.iterationInTest` | Worker identity `__VU` không đại diện cho business job. |
| Idempotency key phải derive từ order/job identity, KHÔNG từ `__VU` | Key trùng giữa các VU → idempotency conflict hoặc confirm sai order. |
| Uneven per-VU distribution is normal | Worker nhanh xử lý nhiều job hơn là đúng mô hình shared pool. |

Nếu một trong các invariant về count/job fail, kết quả nên coi là **invalid hoặc fail**, không phải "pass nhưng hơi thiếu".

## Vì sao "order reconciliation backlog" nên dùng `shared-iterations`?

Mental model đúng:

```text
120 jobs đang nằm trong một queue/backlog.
8 VUs là 8 workers.
Worker nào rảnh thì lấy job kế tiếp.
Batch kết thúc khi queue hết job.
```

Nếu worker A xử lý 22 job còn worker B xử lý 8 job, điều đó không làm test sai. Nó chỉ nói worker A nhận được nhiều job hơn vì vòng lặp của nó quay lại sớm hơn.

### Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho fixed backlog? |
| --- | --- | --- |
| `shared-iterations` | Có tổng `iterations` chung và nhiều VU cùng chạy | **Đúng**: mô hình đúng là N job trong backlog, M worker xử lý đến khi hết việc. |
| `per-vu-iterations` | Count cũng deterministic | Sai nếu VU không phải business identity. Nó ép mỗi VU làm quota bằng nhau, không giống worker queue. Với order reconciliation, confirm lặp 1 order 15 lần là vô nghĩa và có hại. |
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
| `SI_02_VUS` | 8 | Số worker cùng xử lý backlog |
| `SI_02_JOBS` | 120 | Tổng số job toàn scenario |
| `maxDuration` | 12m | Safety cap, không phải target duration |
| `executor` | `shared-iterations` | Fixed global backlog + worker pool |

Mapping quan trọng:

```text
business backlog size = 120 jobs
k6 iterations         = 120
worker pool size      = 8 VUs
expected API calls    = 120 × 2 = 240
```

`maxDuration` chỉ là safety cap. Nếu cap này cắt run làm `iterations < 120`, kết quả không valid vì backlog chưa drain hết.

Operation coverage expected:

```text
order_confirm_reconcile: 120
order_status_verify: 120
```

## Technical semantics: shared backlog, worker pool, job identity

Cách k6 vận hành nên được hiểu như sau:

```text
1. Scenario có một global quota: iterations = 120.
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

### Identity model chi tiết: `__VU` vs `__ITER` vs `iterationInTest` cho order reconciliation

Đây là điểm quan trọng nhất khi code shared-iterations script. Ba khái niệm khác nhau:

```text
__VU:
  - Worker ID, từ 1 đến vus
  - VU=1 có thể chạy iter #0, #5, #11, #18... (nhiều order khác nhau)
  - KHÔNG dùng làm order ID, idempotency key prefix

__ITER:
  - Local counter của từng VU, bắt đầu từ 0
  - VU=1: __ITER=0 → iter #0, __ITER=1 → iter #5, __ITER=2 → iter #11...
  - KHÔNG phải global job index
  - VU=1 __ITER=4 và VU=2 __ITER=4 là 2 order KHÁC NHAU

exec.scenario.iterationInTest:
  - Global job index, từ 0 đến iterations-1
  - DUY NHẤT cho mỗi iteration trong toàn scenario
  - Dùng làm business identity: order index, idempotency key derivation
```

**Demo trace identity model với 3 VU, 10 order**:

```text
Config: vus=3, iterations=10

t=0.0s   VU=1: __VU=1, __ITER=0, iterationInTest=0  -> reconcile order #0
         VU=2: __VU=2, __ITER=0, iterationInTest=1  -> reconcile order #1
         VU=3: __VU=3, __ITER=0, iterationInTest=2  -> reconcile order #2

t=0.4s   VU=1 xong (confirm nhanh), lấy tiếp:
         VU=1: __VU=1, __ITER=1, iterationInTest=3  -> reconcile order #3

t=0.7s   VU=2 xong, lấy tiếp:
         VU=2: __VU=2, __ITER=1, iterationInTest=4  -> reconcile order #4

t=0.8s   VU=1 xong, lấy tiếp:
         VU=1: __VU=1, __ITER=2, iterationInTest=5  -> reconcile order #5

... tiếp tục đến iterationInTest=9 (order #9)

Tổng kết:
  VU=1 (nhanh, confirm path latency thấp): __ITER=0..4 (5 jobs)
    reconcile order #0, #3, #5, #7, #9
  VU=2 (vừa):   __ITER=0..2 (3 jobs)
    reconcile order #1, #4, #8
  VU=3 (chậm, confirm path external_ms cao):  __ITER=0..1 (2 jobs)
    reconcile order #2, #6
  Total: 5+3+2 = 10 orders ✓

Code đúng:
  const orderIndex = exec.scenario.iterationInTest;  // 0..9
  const orderId = orders[orderIndex];
  const idempotencyKey = `reconcile-${orderId}-${exec.scenario.iterationInTest}`;
  // Mỗi order #0-#9 được reconcile đúng 1 lần, key unique cho mỗi job

Code sai:
  const orderId = orders[__VU - 1];  // VU=1 -> orders[0], VU=2 -> orders[1]
  // Chỉ 3 order được reconcile, lặp đi lặp lại
  // 7 order còn lại không bao giờ được reconcile
```

**Demo trace với idempotency key từ `__VU` (SAI)**:

```text
Tình huống: idempotency key = `reconcile-${orderId}-${__VU}`

VU=1 reconcile order #0:
  Key: reconcile-order-0-1

VU=1 reconcile order #3:
  Key: reconcile-order-3-1  ← OK, __VU giống nhưng orderId khác

VU=2 reconcile order #1:
  Key: reconcile-order-1-2

Vấn đề: nếu idempotency key CHỈ dựa trên __VU:
  Key = `reconcile-${__VU}`

  VU=1 reconcile order #0: Key = reconcile-1
  VU=1 reconcile order #3: Key = reconcile-1  ← COLLISION! Cùng key, order khác
  → Payment gateway thấy key đã dùng → từ chối order #3
  → Order #3 không được reconcile!
```

**Demo trace với idempotency key từ `iterationInTest` (ĐÚNG)**:

```text
idempotency key = `reconcile-${orderId}-${exec.scenario.iterationInTest}`

iter #0  (order #0):  Key = reconcile-order-0-0
iter #1  (order #1):  Key = reconcile-order-1-1
iter #2  (order #2):  Key = reconcile-order-2-2
...
iter #119 (order #119): Key = reconcile-order-119-119

→ 120 key unique, không collision nào
→ Dù VU nào chạy cũng không ảnh hưởng
```

### Vì sao KHÔNG có per-VU state như per-vu-iterations?

Trong per-vu-iterations, mỗi VU có state riêng (session, token, cart) sống qua nhiều iteration vì cùng VU luôn chạy iter cho cùng identity.

Trong shared-iterations, **không có per-VU persistent state hữu ích** vì:

```text
VU=1 chạy job #0 (order #0), xong chạy job #5 (order #5), xong chạy job #11 (order #11)...
→ Mỗi job là một order khác nhau
→ State của job #0 không dùng được cho job #5
→ Không cần giữ session/token/cart giữa các iter trong cùng VU
```

Nếu script cần auth token, dùng `setup()` hoặc tạo token mới mỗi iteration:

```js
export function setup() {
  return { token: login() };
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.token}` };
  // ...
}
```

### Code pattern đúng cho shared-iterations order reconciliation

```js
import exec from "k6/execution";
import { check } from "k6";
import http from "k6/http";

const ORDERS = Array.from({ length: 120 }, (_, i) => `ORD-${String(i + 1).padStart(6, "0")}`);

export default function () {
  // Lấy global job index — ĐÂY LÀ DÒNG QUAN TRỌNG NHẤT
  const jobIndex = exec.scenario.iterationInTest;  // 0..119
  const orderId = ORDERS[jobIndex];

  // Idempotency key DUY NHẤT cho mỗi job
  const idempotencyKey = `reconcile-${orderId}-batch-${jobIndex}`;

  // Bước 1: Confirm/re-confirm order
  const confirmRes = http.post(
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0`,
    null,
    {
      headers: {
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json",
      },
      tags: { operation: "order_confirm_reconcile", job_id: orderId },
    }
  );
  check(confirmRes, {
    "confirm status 200": (r) => r.status === 200,
  });

  // Bước 2: Verify final order state/history
  const statusRes = http.get(
    `${BASE_URL}/api/sim/orders/${orderId}?cpu_ms=1&db_rows=2&view=full&include_history=1`,
    {
      tags: { operation: "order_status_verify", job_id: orderId },
    }
  );
  check(statusRes, {
    "status verify 200": (r) => r.status === 200,
    "status is completed": (r) => {
      try {
        return r.json("status") === "completed";
      } catch (e) {
        return false;
      }
    },
  });
}
```

**KHÔNG viết thế này**:

```js
// SAI — dùng __VU làm identity
const orderId = ORDERS[__VU - 1];  // Chỉ reconcile 8 order, lặp đi lặp lại

// SAI — idempotency key từ __VU
const idempotencyKey = `reconcile-${__VU}`;  // Key collision giữa các iter của cùng VU

// SAI — dùng __ITER làm identity
const orderId = ORDERS[__ITER];  // VU=1 __ITER=4 và VU=2 __ITER=4 trùng order

// SAI — confirm 200 là đủ, không verify
// POST 200 chỉ chứng minh command accepted, không chứng minh final state đúng
```

## 4 Technical root causes this case catches — CHI TIẾT

Mỗi nguyên nhân dưới đây là một lớp bug mà order reconciliation phải bắt được. Case 02 được thiết kế để phát hiện tất cả 4 lớp này.

### Nguyên nhân 1: FINITE RECONCILIATION BACKLOG (duration-based tests miss orders)

**Real-world analogy**:

```text
Sau sự cố payment gateway, finance team có danh sách 120 order cần đối soát.
Giống như: kế toán trưởng đưa cho team 120 hóa đơn, nói "đối soát hết chỗ này".

Nếu sếp nói "làm trong 1 tiếng rồi nghỉ":
  - Hôm nay nhanh: xong 120 hóa đơn trong 45 phút → OK
  - Hôm nay chậm (hệ thống lag): mới làm 85 hóa đơn hết giờ → 35 hóa đơn chưa đụng tới!

Nếu sếp nói "đối soát ĐỦ 120 hóa đơn rồi hãy nghỉ":
  - Hôm nay nhanh: 45 phút xong → OK
  - Hôm nay chậm: 95 phút mới xong → vẫn OK, 120 hóa đơn đều được xử lý
```

**Vấn đề**: Duration-based test dừng sau một khoảng thời gian, không theo số order. Nếu latency tăng (payment gateway chậm, db lock), số order reconcile được giảm.

```text
Tưởng tượng team kế toán 8 người:
  - Mỗi hóa đơn cần ~0.6s để confirm + verify
  - Sếp đặt đồng hồ 60s -> hết 60s dừng, bất kể còn hóa đơn chưa đối soát

  Ngày thường (payment gateway nhanh, 0.6s/order):
    8 người × 60s / 0.6s = 800 hóa đơn (dư, nhưng có thể đối soát lặp)
    → Nếu map identity SAI, đối soát lặp 8 hóa đơn đầu × 100 lần
    → 112 hóa đơn cuối chưa từng được đụng tới

  Ngày chậm (payment gateway quá tải, 1.4s/order):
    8 người × 60s / 1.4s = 342 hóa đơn
    → Vẫn có thể đối soát lặp, bỏ sót hóa đơn cuối
```

**Demo cụ thể: constant-vus duration=60s, vus=8**

Giả sử mỗi iter mất 0.7s, code dùng `__VU` làm identity (SAI):

```text
VU=1 (nhanh nhất, confirm path latency thấp): iter_time=0.5s
  → 60s / 0.5s = 120 iter
  → Luôn reconcile order=1, lặp 120 lần

VU=8 (chậm nhất, confirm path external_ms cao): iter_time=1.1s
  → 60s / 1.1s = 54 iter
  → Luôn reconcile order=8, lặp 54 lần

Tổng: 120+...+54 ≈ 650 iterations
Nhưng chỉ 8 order unique được reconcile
→ Coverage thật = 8/120 ≈ 6.7%
→ 112 order bỏ sót, dù test "pass" với 650 iter
```

**Demo với code đúng (identity từ iterationInTest) nhưng vẫn duration-based**:

```text
Vấn đề khác: không biết khi nào đã reconcile đủ 120 order

constant-vus duration=60s:
  iter #0-#119: reconcile order #0-#119 (đủ 120)
  iter #120-#649: reconcile tiếp order #0-#119 (lặp lại, dư, CÓ HẠI)
  → Mỗi order bị confirm 5-6 lần!
  → Idempotency key có thể bị collision nếu không derive đúng từ iterationInTest
  → Payment gateway có thể từ chối hoặc ghi nhận duplicate

constant-vus duration=15s (quá ngắn):
  iter #0-#55: reconcile order #0-#55 (chỉ 56 order)
  → Thiếu 64 order, coverage không đủ
  → Nhưng test vẫn "pass" nếu chỉ nhìn http_req_failed=0

SO SÁNH VỚI shared-iterations:
  iterations=120
  iter #0-#119: reconcile order #0-#119 (đủ 120, DỪNG)
  → Không dư, không thiếu, coverage chính xác
  → Mỗi order reconcile đúng 1 lần
```

**Vì sao test khác không bắt được?**

```text
- Load test (constant-vus duration=5m): quan tâm throughput, không quan tâm
  từng order cụ thể có được reconcile không. Nếu 1000 iter pass,
  nhưng đó là 8 order lặp 125 lần mỗi cái → bug ẩn.

- Functional test (1 order): chỉ test 1 order đơn lẻ, không phát hiện
  vấn đề coverage khi có 120 order cần xử lý.

- Monitoring alert: chỉ báo latency/error rate, không báo "còn 35 order
  chưa được reconcile".
```

**Cách phát hiện**: so sánh `iterations` count với expected `JOBS`. Nếu `iterations < JOBS` → coverage incomplete. Nếu `iterations > JOBS` và identity từ `__VU` → reconcile lặp. Luôn kiểm `shared_jobs_total` khớp `JOBS`.

---

### Nguyên nhân 2: CONFIRM IS NOT ENOUGH (POST 200 doesn't prove final state)

**Real-world analogy**:

```text
Gửi lệnh chuyển tiền qua ngân hàng:
  - Bạn nhấn "Chuyển tiền" → màn hình báo "Đã tiếp nhận yêu cầu" (POST 200)
  - Nhưng 5 phút sau, tiền vẫn chưa đến tài khoản kia
  - Vì sao? Yêu cầu được accept, nhưng backend xử lý thất bại:
    + Số dư không đủ (kiểm tra sau)
    + Tài khoản đích bị khóa
    + Hệ thống trung gian timeout

→ POST 200 = "Tôi đã nhận lệnh của anh/chị"
→ KHÔNG = "Giao dịch đã hoàn tất"
```

**Áp vào order reconciliation**:

```text
POST /api/sim/orders/:id/confirm 200:
  → Command đã được accept bởi order-service
  → Chưa chắc final state đã là "completed"
  → Cần GET status để xác nhận

Các tình huống confirm 200 nhưng state không đúng:
  1. Payment gateway xác nhận chậm: confirm gửi đi, payment gateway nhận
     nhưng chưa callback về → order vẫn pending
  2. DB write bị rollback: confirm ghi DB, nhưng transaction bị rollback
     sau đó (deadlock, constraint violation)
  3. Async processing fail: confirm trigger async job (gửi email, update
     inventory) → async job fail → order rollback về pending
  4. State machine conflict: order đang ở state không cho phép confirm
     → confirm trả 200 nhưng state không đổi
```

**Demo trace confirm 200 nhưng state fail**:

```text
Backend state: order #27, #53, #88, #104 có vấn đề state machine
(do migration order state không nhất quán, hoặc payment gateway chưa callback)

Run order reconciliation 120 jobs:
  Job #0:  confirm=200 OK, status=completed OK  ✓
  Job #1:  confirm=200 OK, status=completed OK  ✓
  ...
  Job #27: confirm=200 OK, status=pending ERR  ← confirm accept nhưng state chưa đổi
  ...
  Job #53: confirm=200 OK, status=failed ERR   ← confirm accept nhưng state fail
  ...
  Job #88: confirm=200 OK, status=pending ERR  ← payment gateway chưa callback
  ...
  Job #104: confirm=200 OK, status=pending ERR ← async processing chưa xong
  ...
  Job #119: confirm=200 OK, status=completed OK ✓

Tổng kết nếu CHỈ nhìn confirm:
  order_confirm_reconcile: 120 pass, 0 fail
  → Tưởng tất cả order OK!

Tổng kết nếu nhìn cả status verify:
  order_confirm_reconcile: 120 pass
  order_status_verify: 116 pass, 4 fail
  → 4 order confirm OK nhưng final state KHÔNG đúng
  → ORDER RECONCILIATION FAIL — 4 order cần điều tra thêm
```

**Vì sao test khác không bắt được?**

```text
- API smoke test: chỉ check POST confirm 200 → pass, không phát hiện state sai
- Load test: chỉ quan tâm latency/throughput, không check business state
- Unit test: test riêng confirm logic, không test integration state machine
- E2E test UI: có thể phát hiện nếu check UI order detail, nhưng không
  chạy đủ 120 order như batch test này
```

**Cách phát hiện**: luôn pair confirm với status verify. Tách metric theo tag `operation`. Nếu `order_status_verify` count < 120 → thiếu verify coverage. Nếu `order_status_verify` có check fail (status không "completed") → điều tra order cụ thể.

**Code minh họa check status sau confirm**:

```js
// ĐÚNG: confirm rồi verify state
const confirmRes = http.post(`${BASE_URL}/api/sim/orders/${orderId}/confirm?...`);
check(confirmRes, { "confirm accepted": (r) => r.status === 200 });

const statusRes = http.get(`${BASE_URL}/api/sim/orders/${orderId}?...`);
check(statusRes, {
  "status is completed": (r) => {
    try { return r.json("status") === "completed"; } catch (e) { return false; }
  },
});

// SAI: chỉ confirm, không verify
const confirmRes = http.post(`${BASE_URL}/api/sim/orders/${orderId}/confirm?...`);
// Xong! Không check gì thêm → bug ẩn
```

---

### Nguyên nhân 3: IDEMPOTENCY KEY SEMANTICS (must derive from job identity, not __VU)

**Real-world analogy**:

```text
Idempotency key giống như "số biên nhận" khi gửi chuyển phát nhanh:
  - Mỗi bưu kiện có 1 mã vận đơn DUY NHẤT
  - Nếu bạn gửi 2 bưu kiện khác nhau mà dùng cùng 1 mã vận đơn:
    + Bưu điện từ chối bưu kiện thứ 2 (trùng mã)
    + Hoặc tệ hơn: gán nhầm thông tin bưu kiện 2 vào bưu kiện 1

Trong order reconciliation:
  - Idempotency key = mã định danh DUY NHẤT cho mỗi lần confirm
  - Nếu 2 job confirm khác nhau dùng cùng key → conflict
  - Payment gateway dùng key để dedup: "key này đã xử lý rồi, không làm lại"
```

**Vấn đề cụ thể với shared-iterations**:

```text
Trong per-vu-iterations:
  Mỗi VU chạy N iter cho CÙNG identity
  → Idempotency key có thể derive từ __VU + __ITER
  → VU=1, ITER=0: key = "reconcile-1-0"
  → VU=1, ITER=1: key = "reconcile-1-1"
  → Key unique vì mỗi VU có dải __ITER riêng

Trong shared-iterations:
  Mỗi VU chạy các iter cho NHIỀU identity KHÁC NHAU
  → Nếu idempotency key từ __VU + __ITER:
    VU=1, __ITER=0: reconcile order #0  → key = "reconcile-1-0"
    VU=1, __ITER=1: reconcile order #5  → key = "reconcile-1-1"
    VU=2, __ITER=0: reconcile order #1  → key = "reconcile-2-0"
    VU=2, __ITER=1: reconcile order #6  → key = "reconcile-2-1"
    → Key vẫn unique nếu dùng __VU + __ITER (mỗi VU __ITER tăng riêng)

  NHƯNG vấn đề THẬT SỰ:
    Nếu idempotency key CHỈ từ __VU (không dùng __ITER):
      VU=1: TẤT CẢ iter có key = "reconcile-1"
      → Iter #0 (order #0): key = "reconcile-1"
      → Iter #1 (order #5): key = "reconcile-1"  ← COLLISION!
      → Payment gateway: "key reconcile-1 đã xử lý" → TỪ CHỐI order #5!
      → Order #5 không được reconcile!
```

**Demo trace: 3 VU, 9 order, idempotency key từ __VU (SAI)**:

```text
Config: vus=3, iterations=9
Idempotency key: `reconcile-${__VU}`

t=0.0s  VU=1: reconcile order #0,  key=reconcile-1  → payment gateway xử lý ✓
        VU=2: reconcile order #1,  key=reconcile-2  → payment gateway xử lý ✓
        VU=3: reconcile order #2,  key=reconcile-3  → payment gateway xử lý ✓

t=0.5s  VU=1 xong, lấy order #3: key=reconcile-1  ← ĐÃ DÙNG!
        → Payment gateway: "key reconcile-1 already processed" → 409 Conflict
        → Order #3 KHÔNG được reconcile!

t=0.7s  VU=2 xong, lấy order #4: key=reconcile-2  ← ĐÃ DÙNG!
        → 409 Conflict → Order #4 không được reconcile!

... tương tự, TẤT CẢ order sau order đầu tiên của mỗi VU đều bị từ chối

Kết quả:
  Chỉ 3 order được reconcile (order #0, #1, #2)
  6 order bị từ chối vì idempotency key collision
  http_req_failed có thể vẫn = 0 nếu 409 được coi là "acceptable"
  → Test PASS nhưng 6 order chưa được reconcile!
```

**Demo trace: 3 VU, 9 order, idempotency key từ iterationInTest (ĐÚNG)**:

```text
Config: vus=3, iterations=9
Idempotency key: `reconcile-${orderId}-iter-${exec.scenario.iterationInTest}`

t=0.0s  VU=1: reconcile order #0,  key=reconcile-ORD-000001-iter-0  ✓
        VU=2: reconcile order #1,  key=reconcile-ORD-000002-iter-1  ✓
        VU=3: reconcile order #2,  key=reconcile-ORD-000003-iter-2  ✓

t=0.5s  VU=1 xong, lấy order #3:
        key=reconcile-ORD-000004-iter-3  ← MỚI, chưa từng dùng ✓

t=0.7s  VU=2 xong, lấy order #4:
        key=reconcile-ORD-000005-iter-4  ← MỚI, chưa từng dùng ✓

... 120 key unique, không collision

Kết quả: 9 order được reconcile, mỗi order đúng 1 lần ✓
```

**Vì sao test khác không bắt được?**

```text
- Unit test idempotency: thường test "gọi 2 lần cùng key → lần 2 được dedup"
  → Test này pass, nhưng không test scenario "120 key khác nhau từ 120 order"

- Integration test 1 order: chỉ có 1 key, không có collision để phát hiện

- Load test per-vu-iterations: mỗi VU có dải key riêng, không collision
  → Khi chuyển sang shared-iterations, key strategy cũ bị vỡ

- Manual test: không thể test 120 order bằng tay
```

**Cách phát hiện**: 
1. Kiểm tra script: idempotency key derive từ đâu?
2. Nếu từ `__VU` hoặc `__ITER` một mình → SAI
3. Nếu từ `exec.scenario.iterationInTest` hoặc `orderId + iterationInTest` → ĐÚNG
4. Sau khi chạy, kiểm `order_confirm_reconcile` count: nếu count < 120 và có nhiều HTTP 409 → nghi ngờ key collision

---

### Nguyên nhân 4: EXTERNAL LATENCY AND WORKER SKEW (confirm has external_ms, causes uneven distribution)

**Real-world analogy**:

```text
8 nhân viên kế toán cùng đối soát 120 hóa đơn.
Mỗi hóa đơn cần 2 bước:
  1. Gọi điện cho ngân hàng xác nhận (external call, ~80ms)
  2. Kiểm tra sổ sách nội bộ (internal, ~10ms)

Nhân viên A: gọi ngân hàng, họ pick up ngay → 50ms → xong nhanh
Nhân viên B: gọi ngân hàng, họ bắt máy chậm → 120ms → xong chậm hơn
Nhân viên C: gọi ngân hàng, đường dây bận → 200ms → xong chậm nhất

→ A xong sớm → lấy thêm hóa đơn → làm được nhiều hơn
→ C xong muộn → ít cơ hội lấy thêm → làm được ít hơn
→ Phân phối không đều: A làm 25 hóa đơn, C chỉ làm 8 hóa đơn

Nhưng TẤT CẢ 120 hóa đơn vẫn được xử lý → batch OK
```

**Vấn đề**: Với shared-iterations, VU nhanh sẽ lấy nhiều job hơn VU chậm. Đây là **feature**, không phải bug. Nhưng nếu learner không hiểu, họ có thể fail test vì "phân phối không đều".

```text
Trong order reconciliation:
  - Confirm path có external_ms=80ms (mô phỏng gọi payment gateway)
  - Network latency tới payment gateway biến thiên giữa các VU
  - VU gần gateway (latency thấp) → confirm nhanh → lấy nhiều order
  - VU xa gateway (latency cao) → confirm chậm → lấy ít order
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

**Demo trace worker skew với 4 VU, 16 order, confirm latency khác nhau**:

```text
Config: vus=4, iterations=16
  VU=1: confirm external_ms=30ms  (gateway rất nhanh) → iter_time=0.15s
  VU=2: confirm external_ms=60ms  (gateway bình thường) → iter_time=0.25s
  VU=3: confirm external_ms=100ms (gateway chậm) → iter_time=0.40s
  VU=4: confirm external_ms=150ms (gateway rất chậm) → iter_time=0.55s

Timeline:
t=0.00s  4 VU start, cùng lấy iter đầu
         VU=1: iterationInTest=0  (order #0),  iter_time=0.15s
         VU=2: iterationInTest=1  (order #1),  iter_time=0.25s
         VU=3: iterationInTest=2  (order #2),  iter_time=0.40s
         VU=4: iterationInTest=3  (order #3),  iter_time=0.55s

t=0.15s  VU=1 xong, lấy iterationInTest=4  (order #4),  iter_time=0.15s
t=0.25s  VU=2 xong, lấy iterationInTest=5  (order #5),  iter_time=0.25s
t=0.30s  VU=1 xong, lấy iterationInTest=6  (order #6),  iter_time=0.15s
t=0.40s  VU=3 xong, lấy iterationInTest=7  (order #7),  iter_time=0.40s
t=0.45s  VU=1 xong, lấy iterationInTest=8  (order #8),  iter_time=0.15s
t=0.50s  VU=2 xong, lấy iterationInTest=9  (order #9),  iter_time=0.25s
t=0.55s  VU=4 xong, lấy iterationInTest=10 (order #10), iter_time=0.55s
t=0.60s  VU=1 xong, lấy iterationInTest=11 (order #11), iter_time=0.15s
...

Kết quả cuối:
  VU=1: 7 iter  (nhanh nhất → nhiều nhất)
  VU=2: 4 iter
  VU=3: 3 iter
  VU=4: 2 iter  (chậm nhất → ít nhất)
  Tổng: 16 iter ✓

Phân phối: 7-4-3-2 (lệch nặng)
Nhưng tổng = 16 = config → PASS ✓
Không ai fail test vì VU=4 chỉ làm 2 order.
```

**Demo worker skew với case 02: 8 VU, 120 order**:

```text
Expected (nếu learner quen per-vu-iterations):
  Mỗi VU reconcile 120/8 = 15 order → hình ảnh "đẹp, đều"

Thực tế (shared-iterations với confirm external_ms biến thiên):
  VU=1 (confirm nhanh, gateway gần):     ~22 order
  VU=2 (confirm nhanh):                  ~18 order
  VU=3 (confirm vừa):                    ~16 order
  VU=4 (confirm vừa):                    ~15 order
  VU=5 (confirm vừa):                    ~14 order
  VU=6 (confirm chậm, gateway xa):       ~13 order
  VU=7 (confirm chậm):                   ~12 order
  VU=8 (confirm rất chậm, network kém):  ~10 order
  Tổng: 22+18+16+15+14+13+12+10 = 120 ✓

Phân phối LỆCH nhưng TỔNG ĐÚNG → PASS
```

**So sánh với per-vu-iterations (nơi phân phối đều là REQUIREMENT)**:

| Tiêu chí | shared-iterations | per-vu-iterations |
| --- | --- | --- |
| Phân phối job | Không đều (first-come-first-served) | Đều tuyệt đối (mỗi VU = N iter) |
| VU nhanh xong sớm | Lấy thêm job | IDLE (không cướp việc VU khác) |
| Pass criteria | Tổng job = config | Tổng job = config VÀ mỗi VU = N iter |
| Khi nào fail vì phân phối? | Không bao giờ | Nếu VU nào không đủ N iter |
| Phù hợp cho order reconciliation? | CÓ — mỗi order cần xử lý 1 lần, ai làm cũng được | KHÔNG — mỗi VU confirm cùng 1 order 15 lần |

**Vì sao test khác không bắt được?**

```text
- per-vu-iterations test: phân phối ĐỀU, không có skew → learner không
  biết skew là normal trong shared-iterations → fail test oan

- Monitoring: không quan tâm VU nào làm bao nhiêu, chỉ quan tâm
  latency/error rate tổng

- Code review: reviewer quen per-vu-iterations có thể comment
  "sao VU phân phối không đều" → yêu cầu sai
```

**Cách phát hiện**: nếu learner fail test vì "VU distribution không đều", giải thích lại mental model worker pool. Invariant là `sum(iterations_per_vu) == JOBS`, không phải `iterations_per_vu == JOBS / vus`.

---

### Tổng kết 4 nguyên nhân

| # | Nguyên nhân | Class of bug | Shared-iterations bắt được? |
| --- | --- | --- | --- |
| 1 | Finite backlog (duration-based miss) | Coverage gap | CÓ — iterations cố định, count guarantee |
| 2 | Confirm is not enough | Business logic gap | CÓ — job flow gồm confirm + verify |
| 3 | Idempotency key semantics | Identity/key collision | CÓ — key derive từ iterationInTest |
| 4 | Worker skew | Mental model error | CÓ — giải thích được, không fail oan |

## Service/API flow

| Operation | Method | Path | Service | Expected | Expected count | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| order_confirm_reconcile | `POST` | `/api/sim/orders/:id/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0` | order-service | `200` | 120 | Confirm/re-confirm order với `Idempotency-Key`. |
| order_status_verify | `GET` | `/api/sim/orders/:id?cpu_ms=1&db_rows=2&view=full&include_history=1` | order-service | `200` | 120 | Verify final order state/history. |

Một job chỉ được coi là hoàn tất khi các operation cần thiết của job đó đã pass theo contract.

Điểm khác biệt quan trọng với case 01 (catalog audit):

```text
Case 01 — catalog audit:
  Cả list và detail đều là GET (idempotent, read-only)
  Không có side effect, không cần idempotency key
  Thứ tự: list trước hay detail trước không quan trọng

Case 02 — order reconciliation:
  Confirm là POST (có side effect — thay đổi order state)
  Cần idempotency key để dedup an toàn
  Thứ tự: confirm PHẢI chạy trước verify (không thể verify state chưa được confirm)
  external_ms ở confirm path tạo ra latency biến thiên lớn hơn
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
| `case_id` | Case đang chạy, ví dụ `si-02-order-reconciliation`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service đang được gọi. |
| `operation` | Bước nghiệp vụ/API cụ thể trong job. |
| `endpoint` | Nhóm endpoint/API family. |
| `job_id` | Business job trong backlog, derive từ global job index. |
| `executor_family` | `shared_iterations`. |
| `workload_shape` | `fixed_backlog`. |

Tags case này:

```text
case_id       = si-02-order-reconciliation
business_case = order_reconciliation
service       = order-service
```

## Pass criteria

Pass criteria tối thiểu:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 120
shared_jobs_failed count == 0
iterations count == 120
http_reqs count == 240
shared_api_calls_total count == 240
```

Operation breakdown phải khớp:

```text
order_confirm_reconcile: 120
order_status_verify: 120
```

Đừng thêm pass condition kiểu:

```text
mỗi VU phải xử lý 120 / 8 = 15 jobs
```

Vì đó không phải invariant của `shared-iterations`.

Pass criteria bổ sung cho case này (do có side effect):

```text
Tất cả order_confirm_reconcile phải trả về HTTP 200
  (không 409 Idempotency Conflict — dấu hiệu key collision)

Tất cả order_status_verify phải trả về HTTP 200
  VÀ response body "status" phải là "completed"
  (không "pending", không "failed")

shared_job_duration_ms p95 không vượt threshold SLA
  (nếu SLA yêu cầu reconcile trong X giây)
```

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-02-order-reconciliation.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-02-order-reconciliation.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-02-order-reconciliation.js
```

Nếu backend script chưa có trong working tree, chỉ đọc phần expected formula trước; không tự điền run data.

## Đọc output summary

Áp 5 bước giống cách đọc các case per-vu, nhưng invariant đổi sang **total backlog**, không phải per-user quota.

### Bước 1 — Verify scenario/config

Header phải thể hiện:

```text
executor = shared-iterations
vus = 8 hoặc env override
total iterations/jobs = 120 hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ expected counts.

### Bước 2 — Compute expected total jobs

Default case này:

```text
JOBS = 120
API_PER_JOB = 2
expected iterations = 120
expected http_reqs = 120 × 2 = 240
```

### Bước 3 — Compare summary counters

Expected:

```text
iterations == 120
shared_jobs_total == 120
shared_jobs_failed == 0
```

Nếu `iterations < 120`:

```text
backlog chưa drain hết -> invalid result
→ maxDuration cắt? Tăng maxDuration.
→ iter_time quá dài? Giảm workload hoặc tăng vus.
→ Payment gateway quá chậm? Kiểm tra external_ms, network.
```

Nếu `iterations == 120` nhưng `shared_jobs_total < 120`:

```text
iteration chạy xong nhưng job completion instrumentation/business branch bị thiếu
→ Kiểm script: có gọi jobDone() sau mỗi iteration không?
→ Có exception/early return nào bỏ qua job completion không?
→ Đặc biệt với case này: confirm 200 nhưng status check fail có bị skip jobDone()?
```

### Bước 4 — Compare API and operation counts

Expected:

```text
http_reqs == 240
shared_api_calls_total == 240
order_confirm_reconcile: 120
order_status_verify: 120
```

Tổng HTTP đúng nhưng operation split sai vẫn là coverage bug:

```text
VD: http_reqs = 240, nhưng:
  order_confirm_reconcile: 135
  order_status_verify: 105
→ 15 order chỉ có confirm, thiếu verify
→ Status coverage = 105/120 = 87.5% -> FAIL
→ 15 order confirm OK nhưng không ai biết final state có đúng không
```

Case-specific operation check:

```text
Nếu order_confirm_reconcile > 120:
  → Có confirm lặp (retry, duplicate)
  → Kiểm tra idempotency key có unique không

Nếu order_confirm_reconcile < 120:
  → Thiếu confirm coverage
  → Có order nào bị skip confirm?

Nếu order_status_verify < order_confirm_reconcile:
  → Script có branch bỏ qua verify không?
  → Verify bị fail/timeout và không retry?
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

Với case này, đặc biệt chú ý:

```text
http_req_duration{operation:order_confirm_reconcile}:
  → Confirm latency, bao gồm external_ms (payment gateway)
  → Đây thường là bottleneck chính

http_req_duration{operation:order_status_verify}:
  → Verify latency, chủ yếu internal (DB read)
  → Nếu verify chậm hơn confirm → DB query có vấn đề (include_history JOIN)

shared_job_duration_ms:
  = confirm_latency + verify_latency + check_overhead
  → Nếu cao hơn nhiều so với tổng 2 request → nghi ngờ script có sleep/think time
```

Case-specific summary notes:

- `iterations = 120` chứng minh 120 order jobs được lấy khỏi backlog.
- `http_reqs = 240` chứng minh mỗi order có confirm + status verify.
- Confirm 120 nhưng status thiếu nghĩa là final state chưa được chứng minh.
- `order_confirm_reconcile` count = 120 và tất cả 200 → không có idempotency collision.
- `shared_job_duration_ms` cao bất thường → kiểm `order_confirm_reconcile` p95 (external_ms).

Không check mỗi VU làm bằng nhau. Invariant là total completed work, không phải equal work per VU.

## Đọc dashboard real-time charts cho case 02

> Phần này mô tả expected reading pattern. Chỉ bổ sung run ID, p95/p99/max, bucket arrays sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? bucket nào có tail latency? | Backlog đã xử lý đủ chưa |
| Execution timeline | Theo thời gian đã hoàn tất bao nhiêu iterations/http_reqs/jobs? | Mỗi VU có làm bằng nhau không |
| VUs vs iter/s | Worker pool drain backlog nhanh/chậm ra sao? | Business correctness của từng job |

Một cách đọc nhanh:

```text
Response time      -> chất lượng request, phát hiện bottleneck (đặc biệt confirm external_ms)
Execution timeline -> backlog drain progress, phát hiện thiếu coverage
VUs vs iter/s      -> worker pool shape, phát hiện bất thường throughput
```

### Chart 1 — Response time

Đây là request-level latency. Với case này, đọc theo `operation`:

```text
order_confirm_reconcile: 120
order_status_verify: 120
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
2. Batch p95 có spike ở đoạn nào?
3. Batch max có outlier lớn không?
4. Spike xảy ra ở operation nào (confirm hay verify)?
```

Với case 02, shape đẹp thường có:

```text
đầu run:  confirm p95/max có thể cao hơn (cold start, connection pool tới payment gateway init)
          verify p95 ổn định hơn (internal, ít cold start)
giữa run: confirm p95 ổn định, dao động quanh external_ms
          verify p95 ổn định thấp
cuối run: không spike bất thường
```

Vì sao confirm thường chậm hơn và biến thiên nhiều hơn verify?

```text
- Confirm có external_ms=80ms → gọi ra payment gateway bên ngoài
  → Network latency biến thiên, không kiểm soát được hoàn toàn
  → Có db_writes=3 → write lock, có thể bị contention khi nhiều VU cùng confirm

- Verify chỉ có cpu_ms=1 + db_rows=2 → internal, latency ổn định hơn
  → include_history=1 thêm JOIN nhưng vẫn nhanh hơn external call
```

Case-specific bottleneck hints:

- `order_confirm_reconcile` thường là bottleneck vì có `db_writes` và `external_ms`.
- `order_status_verify` giúp phát hiện state/history fail sau confirm.
- Nếu confirm p95 >> verify p95: payment gateway/external path là bottleneck.
- Nếu verify p95 >> confirm p95: DB JOIN (include_history) hoặc query path có vấn đề.
- Nếu `shared_job_duration_ms` cao nhưng request status nhanh: nghi ngờ script có sleep/think time hoặc check logic phức tạp.

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| confirm p95 cao ngay từ đầu rồi ổn định | cold start payment gateway connection | kiểm payment gateway health |
| confirm p95 tăng dần càng về cuối | payment gateway quá tải, queue dài | điều tra gateway capacity |
| verify p95 tăng đột biến ở giữa/cuối | DB lock contention, history table lớn | kiểm DB query plan, index |
| max spike lẻ tẻ nhưng p95 ổn | vài outlier đơn lẻ (network blip) | xem log nhưng chưa vội fail |
| p95 và max cùng spike nhiều bucket | vấn đề hệ thống thật | chặn / điều tra backend |
| confirm p95 >> verify p95 | external_ms/payment gateway chậm | route về payment gateway team |
| verify p95 >> confirm p95 | DB query chậm (include_history JOIN) | kiểm DB index, query plan |

### Chart 2 — Execution timeline

Chart này chứng minh backlog drain đủ theo thời gian.

Kiểm tổng bucket:

```text
sum(iterations buckets) == 120
sum(http_reqs buckets) == 240
sum(shared_jobs_total buckets) == 120
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

Điểm khác với case 01 (catalog audit):

```text
Case 01 — catalog audit:
  iter_time ổn định hơn (cả list và detail đều là GET, read-only)
  → RPS ổn định suốt run, shape đẹp

Case 02 — order reconciliation:
  confirm có external_ms biến thiên → iter_time dao động nhiều hơn
  → RPS có thể dao động theo từng bucket
  → Một số bucket có thể có iteration = 0 (confirm đang chờ payment gateway)
  → Shape có thể "răng cưa" hơn — đây là normal cho case này
```

Invalid patterns:

| Pattern | Nghĩa |
| --- | --- |
| `iterations` đủ nhưng `shared_jobs_total` thiếu | iteration complete nhưng business job chưa mark done |
| `http_reqs` đủ nhưng operation split sai | tổng request đủ nhưng coverage lệch |
| `shared_jobs_failed > 0` | business failure dù HTTP có thể vẫn 200 |
| buckets không cộng ra summary | đọc nhầm point/bucket hoặc data chưa final |
| Live VUs không lên đủ 8 từ đầu | VU init có vấn đề, config/env sai |
| Live VUs giữ cao nhưng iterations không tăng | VU bị kẹt trong confirm (payment gateway chậm) |
| `order_confirm_reconcile` < `order_status_verify` | bất thường: confirm PHẢI chạy trước verify |

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
- 8 VU cùng chạy (mỗi VU đang ở 1 order khác nhau)
- Nhiều HTTP request hoàn thành (cả confirm POST + verify GET)
- Một số iteration/job hoàn thành
- Nhiều check pass/fail
```

Điều kiện để một event rơi vào bucket nào:

```text
event timestamp thuộc giây nào -> rơi vào bucket giây đó
```

#### Vì sao bucket đầu có thể có httpReqs > 0 nhưng iterations = 0?

```text
Bucket đầu: VU vừa start, confirm request đầu đã xong
nhưng full job (confirm + verify + check) chưa hoàn tất

→ httpReqs > 0 (request-level metric đến sớm)
→ iterations = 0 (job-level metric đến muộn hơn, cần full flow xong)
```

Đặc biệt với case này, gap có thể lớn hơn case 01 vì:

```text
- Confirm có external_ms=80ms → request đầu mất ~80ms+
- Verify request sau confirm → thêm ~10ms+
- Check logic (parse JSON, so sánh status) → thêm vài ms
→ Full job có thể mất ~100ms+ từ lúc bắt đầu confirm đến lúc kết thúc verify
→ Bucket đầu có thể có confirm request xong nhưng iteration chưa kết thúc
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
```

Với `shared-iterations`, đường `Executor VUs` và `Actual iter/s` có quan hệ:

```text
peak_rate ≈ vus / iter_time
         ≈ 8 / iter_time

Nếu iter_time avg = 0.7s (confirm ~80ms + verify ~10ms + overhead):
  peak_rate ≈ 8 / 0.7 ≈ 11.4 iter/s

Nếu iter_time avg = 1.2s (payment gateway chậm, confirm ~200ms):
  peak_rate ≈ 8 / 1.2 ≈ 6.7 iter/s
```

Đừng đọc chart này thành:

```text
mỗi VU phải xử lý 120 / 8 = 15 jobs
```

Với `shared-iterations`, đó là yêu cầu sai.

Shape mong đợi:

```text
- đầu run: iter/s có thể 0 (chưa job nào xong)
- giữa run: iter/s dao động theo batch hoàn thành
  → Với case này, dao động có thể rõ hơn case 01 vì confirm external_ms biến thiên
- cuối run: iter/s tụt khi backlog gần hết, rồi về 0
- đường VUs: gần 8 ở đầu/giữa, tụt ở cuối
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| `Actual iter/s` đầu = 0, sau đó tăng | job đầu chưa hoàn tất | bình thường |
| `Actual iter/s` dao động theo bucket | confirm external_ms biến thiên, nhiều job finish không cùng thời điểm | bình thường |
| `Actual iter/s` = 0 lâu trong khi VUs cao | VU bị kẹt trong confirm (payment gateway chậm/không phản hồi) | cần điều tra |
| `Actual iter/s` tụt về 0 và VUs cũng về 0 | test xong quota | bình thường |
| sum `Actual iter/s` < expected total | thiếu iteration / drop / interrupt | test invalid |
| VUs không lên tới 8 | config/env sai, VU init lỗi | kiểm header |
| `Actual iter/s` có pattern "lên-xuống" đều đặn | confirm batch hoàn thành theo nhóm (external_ms đồng bộ) | quan sát, không fail |

### Cách chốt từ summary -> 3 chart

```text
1. Summary quyết định pass/fail bằng counters/thresholds.
2. Execution timeline xác nhận backlog drain đủ theo thời gian.
3. Response time tìm operation/service chậm.
   → Với case 02: confirm p95 là tín hiệu payment gateway health.
4. VUs vs iter/s giải thích worker pool hoạt động ra sao.
5. Business decision dựa trên total coverage + failed jobs + operation breakdown.
```

## Kết luận thực tế: output -> quyết định

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **reconciliation gate**: output ra số như vậy thì team quyết định gì với batch reconciliation?

### Kịch bản A — output sạch: RECONCILIATION PASS

```text
iterations.........: 120         (đủ backlog)
http_req_failed....: 0.00%
shared_jobs_total..: 120
shared_jobs_failed.: 0
order_confirm_reconcile: 120     (tất cả confirm 200)
order_status_verify.....: 120    (tất cả status completed)
iteration_duration.: p(95)=0.9s
```

Kết luận thực tế:

```text
- Count đủ 120 -> toàn bộ order đã được reconcile (yêu cầu a)
- 0 fail, 0 job failed -> không order nào lỗi
- Operation breakdown đúng 120/120 -> cả confirm và verify đều đủ coverage
- Không có HTTP 409 -> không có idempotency key collision
- p95 0.9s -> latency OK (confirm + verify trong ngưỡng)
=> QUYẾT ĐỊNH: batch reconciliation OK. Close batch, báo cáo finance.
   Tất cả 120 order đã được confirm và verify trạng thái completed.
```

### Kịch bản B — confirm pass nhưng status fail: BLOCK

```text
iterations.........: 120         (vẫn đủ!)
shared_jobs_total..: 120
shared_jobs_failed.: 8           ← CÓ 8 JOB FAIL
order_confirm_reconcile: 120     ← confirm vẫn đủ 120
order_status_verify.....: 112    ← THIẾU 8 VERIFY
```

Kết luận thực tế:

```text
- Count vẫn 120 -> KHÔNG phải lỗi test, coverage attempt đủ
- Confirm 120 pass -> tất cả order đã được gửi lệnh confirm
- Nhưng 8 job failed -> 8 order confirm OK nhưng final state KHÔNG "completed"
- Status verify chỉ có 112/120 -> 8 order có vấn đề state machine
=> QUYẾT ĐỊNH: BLOCK batch closure.
   Route theo job_id để tìm 8 order bị fail.
   Kiểm tra: payment gateway callback? async processing? state machine conflict?
   Đây CHÍNH LÀ giá trị của verify sau confirm:
   nếu chỉ check confirm, 8 order này đã bị bỏ sót.
```

### Kịch bản C — thiếu iteration: TEST INVALID

```text
iterations.........: 85          (THIẾU 35!)
http_req_failed....: 0.8%
interrupted........: 35
```

Kết luận thực tế:

```text
- 85 < 120 -> backlog chưa drain hết -> KHÔNG kết luận được reconciliation có OK không
- Trước khi nói gì về order, phải sửa cho test chạy đủ 120 đã:
    interrupted=35 -> maxDuration quá ngắn? Tăng maxDuration (đang 12m).
    Hoặc iter_time quá dài? Payment gateway quá chậm?
    → Kiểm tra confirm p95: nếu > 3s, payment gateway có vấn đề.
    → Hoặc tăng vus (lên 12-16) để bù latency.
=> QUYẾT ĐỊNH: CHƯA kết luận reconciliation pass/fail.
   Test invalid, chạy lại sau khi sửa nguyên nhân thiếu count.
```

### Kịch bản D — idempotency key collision: INVESTIGATE

```text
iterations.........: 120         (count đủ!)
http_req_failed....: 5.8%        ← CÓ FAIL
order_confirm_reconcile: 120
  Trong đó: HTTP 200: 106, HTTP 409: 14  ← 14 CONFLICT
order_status_verify.....: 106    ← THIẾU 14
```

Kết luận thực tế:

```text
- Count 120 nhưng 14 confirm trả về 409 Conflict
- 14 order không được reconcile vì idempotency key collision
- Đây là dấu hiệu idempotency key derive từ __VU hoặc fixed string
=> QUYẾT ĐỊNH: BLOCK. Sửa script: idempotency key phải derive từ
   iterationInTest hoặc orderId + iterationInTest.
   Chạy lại sau khi sửa.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| confirm/status mỗi loại 120, no failed jobs | Tất cả orders reconciled và verified | Close reconciliation batch |
| confirm 120 nhưng status < 120 | Final state không được verify đủ | Block batch closure, điều tra order theo job_id |
| `shared_jobs_failed > 0` | Order/payment state issue | Investigate affected `job_id`/order |
| `http_req_failed > 0` | Backend/API failure during reconciliation | Block and inspect status codes |
| HTTP 409 Conflict ở confirm | Idempotency key collision | Sửa script: key từ iterationInTest |
| Counts complete nhưng job duration high | Functional pass, SLA/external latency risk | Investigate payment gateway latency |
| < 120 iter (drop/interrupt) | Test chưa hợp lệ, backlog chưa drain hết | Tăng maxDuration hoặc vus, chạy lại |
| http_reqs = 240 nhưng operation split sai | Coverage gap ẩn | Sửa script, kiểm branch logic |
| Per-VU uneven | Normal worker-pool behavior | No action |
| confirm p95 cao bất thường | Payment gateway/external chậm | Route về payment gateway team |

Điểm cốt lõi của case này: **vì count luôn cố định 120, mọi thiếu hụt ở operation breakdown hoặc failed jobs đều là tín hiệu THẬT về order state, không bị nhiễu bởi "lần này test chạy nhiều/ít hơn lần trước"**. Và **confirm 200 là chưa đủ — phải verify final state** mới kết luận được reconciliation thành công. Đó là lý do reconciliation gate dùng shared-iterations và flow confirm+verify.

## "Nghịch lý" và misconceptions của shared-iterations cho order reconciliation

### Nghịch lý 1: iteration_duration = 0.7s nhưng iter/s = 11.4?

```text
iteration_duration: avg=0.7s     <- 1 job mất 0.7 giây
iterations:         11.4/s       <- nhưng 1 giây ra 11.4 job

Sao 1 job mất 0.7s mà mỗi giây lại ra được 11.4 job?
"Lẽ ra 0.7s mới ra 1 job chứ?"
```

**Trả lời: vì 8 VU chạy SONG SONG, không phải 1 VU.**

```text
iteration_duration = thời gian 1 VU làm xong 1 job = 0.7s
iterations rate    = tổng job hoàn thành / tổng thời gian (cả pool) = 11.4/s

Công thức nối 2 con số (Little's Law):
  rate = vus / iter_time
  11.4 ≈ 8 / 0.7 ✓

Ví dụ trực quan cho order reconciliation:
  8 kế toán viên, mỗi người đối soát 1 hóa đơn mất 0.7 phút:
    - 1 hóa đơn VẪN mất 0.7 phút (không nhanh hơn)
    - nhưng 8 người đối soát song song -> mỗi phút ra ~11.4 hóa đơn
```

### Nghịch lý 2: VU=8, jobs=120, sao có VU reconcile 22 order, VU khác chỉ 10?

```text
Đây là câu hỏi phổ biến nhất từ learner chuyển từ per-vu-iterations sang.

Trong per-vu-iterations:
  iterations=15, vus=8 -> mỗi VU chạy ĐÚNG 15 iter = 120 total
  → Phân phối ĐỀU (mỗi VU 15)

Trong shared-iterations:
  iterations=120, vus=8 -> tổng 120 iter, CHIA KHÔNG ĐỀU
  → VU nhanh: 22 iter, VU chậm: 10 iter
  → Tổng = 120, nhưng phân phối LỆCH
```

Vì sao? Vì cơ chế atomic counter "first come first served":

```text
VU nào xong job -> gọi atomic.AddUint64 -> lấy job tiếp theo
VU nhanh (confirm external_ms thấp) -> xong sớm -> gọi sớm -> lấy nhiều
VU chậm (confirm external_ms cao) -> xong muộn -> gọi muộn -> lấy ít

Trong order reconciliation:
  VU gần payment gateway (network latency thấp) -> confirm nhanh -> nhiều order
  VU xa payment gateway (network latency cao) -> confirm chậm -> ít order

Đây là ĐẶC TRƯNG của worker pool, không phải bug.
Giống như: kế toán viên gọi ngân hàng nhanh (đường dây tốt)
  sẽ đối soát được nhiều hóa đơn hơn kế toán viên gọi ngân hàng chậm.
```

### Nghịch lý 3: Tổng http_reqs = 240 nhưng shared_jobs_total chỉ = 116?

```text
http_reqs = 240 -> 240 HTTP requests đã hoàn thành
shared_jobs_total = 116 -> nhưng chỉ 116 job được mark complete

4 job (8 HTTP requests) đã chạy xong HTTP, nhưng job không được mark done.
→ Có thể do: confirm 200 nhưng status check fail (status != "completed")
  → script throw exception trước khi gọi jobDone()?
  → Hoặc check "status is completed" fail và script return sớm?
  → Hoặc code branch bỏ qua job completion instrumentation.

Cách debug:
  - Kiểm shared_jobs_failed: 4 job đó có bị mark failed không?
  - Nếu không failed cũng không total -> instrumentation gap
  - Kiểm script: có try/catch bỏ qua jobDone() không?
  - Đặc biệt: check "status is completed" fail có throw không?
```

### Nghịch lý 4: Confirm POST 200 nhưng order vẫn pending?

```text
Đây là misconception phổ biến: "POST trả 200 là thành công".

Thực tế với order reconciliation:
  POST /confirm 200 = "command accepted" (đã nhận lệnh)
  ≠ "order state = completed" (đã xử lý xong)

Ví dụ: gửi lệnh chuyển tiền
  - Ngân hàng nhận lệnh → HTTP 200 (đã tiếp nhận)
  - Nhưng 5 phút sau tiền mới đến (hoặc không đến nếu số dư không đủ)
  - POST 200 không đảm bảo kết quả cuối cùng

Trong case này:
  - external_ms=80ms mô phỏng thời gian chờ payment gateway
  - db_writes=3 mô phỏng transaction có thể rollback
  → Luôn cần GET verify để xác nhận final state
```

### Nghịch lý 5: idempotency key từ __VU không collision trong per-vu-iterations nhưng collision trong shared-iterations?

```text
Câu hỏi: "Script cũ dùng idempotency key từ __VU, test per-vu-iterations
  vẫn pass. Sao chuyển sang shared-iterations lại collision?"

Trả lời:
  per-vu-iterations:
    Mỗi VU có iterations RIÊNG (__ITER tăng từ 0 đến N-1)
    → Key = f(__VU, __ITER) → mỗi VU có N key khác nhau
    → Tổng: vus × N key unique, không collision

  shared-iterations:
    Mỗi VU lấy iteration từ POOL CHUNG
    → __VU không thay đổi, __ITER tăng nhưng iterationInTest tăng toàn cục
    → Nếu key = f(__VU) (chỉ dùng __VU): chỉ có vus key khác nhau
    → VU=1 dùng key "reconcile-1" cho order #0, rồi DÙNG LẠI key "reconcile-1" cho order #5
    → COLLISION!

  → Khi chuyển executor, phải chuyển cả cách derive identity/key.
  → Dùng iterationInTest — nó là DUY NHẤT toàn scenario.
```

## Checklist đọc biểu đồ case 02

Khi học sinh nhìn dashboard case 02, đọc theo thứ tự này:

```text
1. Overview KPI
   - iterations = 120?
   - http_req_failed = 0%?
   - checks = 100%?

2. Response time chart
   - Tách theo operation (confirm vs verify) chưa?
   - confirm p95 có cao hơn verify không? (thường confirm cao hơn vì external_ms)
   - confirm p95 cuối run có spike không?
   - verify p95 có bất thường không? (nếu verify > confirm → DB issue)
   - Có bucket nào confirm max spike đột biến không?

3. Execution timeline
   - Live VUs đầu có = 8 không?
   - cuối run VUs có tụt dần về 0 không?
   - sum iterations theo bucket có = 120 không?
   - sum http_reqs theo bucket có = 240 không?
   - sum shared_jobs_total theo bucket có = 120 không?
   - shared_jobs_failed có = 0 ở mọi bucket không?
   - order_confirm_reconcile count theo bucket có = order_status_verify count không?
     (nếu confirm > verify: có order confirm OK nhưng chưa verify)

4. VUs vs iter/s
   - Actual iter/s theo bucket dao động thế nào?
   - Có pattern "răng cưa" không? (normal cho case này vì external_ms biến thiên)
   - sum actual iter/s có = 120 không?
   - VUs có giữ gần 8 ở đầu/giữa run không?
   - Cuối run VUs có tụt về 0 không?

5. Business decision
   - Tất cả counters pass?
   - Operation breakdown đúng 120/120?
   - shared_jobs_failed = 0?
   - Có HTTP 409 Conflict không? (dấu hiệu idempotency collision)
   - order_status_verify check "status is completed" pass hết?
   - Nếu tất cả pass -> reconciliation batch PASS
```

Kết luận của run case 02 đang đúng nếu thấy:

```text
iterations = 120
http_req_failed = 0%
checks = 100%
shared_jobs_total = 120
shared_jobs_failed = 0
order_confirm_reconcile = 120 (tất cả HTTP 200)
order_status_verify = 120 (tất cả status "completed")
Live VUs: đầu = 8, cuối giảm về 0
sum chart iterations = summary iterations
sum chart httpReqs = summary http_reqs
executor = shared-iterations
confirm p95 > verify p95 (normal, do external_ms)
```

## Mở rộng / variation

### Variation A: Thêm tag domain-specific để lọc nhóm order quan trọng

```js
const HIGH_VALUE_ORDERS = new Set([0, 5, 12, 30, 55, 72, 100, 115]);

export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  const orderId = ORDERS[jobIndex];
  const isHighValue = HIGH_VALUE_ORDERS.has(jobIndex);

  // Tag riêng cho order giá trị cao
  const confirmRes = http.post(
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?...`,
    null,
    {
      headers: { "Idempotency-Key": `reconcile-${orderId}-${jobIndex}` },
      tags: {
        operation: "order_confirm_reconcile",
        job_id: orderId,
        priority: isHighValue ? "high_value" : "normal",
      },
    }
  );

  const statusRes = http.get(
    `${BASE_URL}/api/sim/orders/${orderId}?...`,
    {
      tags: {
        operation: "order_status_verify",
        job_id: orderId,
        priority: isHighValue ? "high_value" : "normal",
      },
    }
  );
}
```

### Variation B: Tăng JOBS để mô phỏng backlog production lớn hơn

```powershell
$env:SI_02_JOBS = 500
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-02-order-reconciliation.js
```

Nhớ recompute expected: `http_reqs = 500 × 2 = 1000`.

Đồng thời cân nhắc tăng `maxDuration` nếu 12 phút không đủ cho 500 order:

```powershell
$env:SI_02_JOBS = 500
$env:SI_02_MAX_DURATION = "30m"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-02-order-reconciliation.js
```

### Variation C: Thêm threshold latency theo operation

```js
export const options = {
  thresholds: {
    "http_req_duration{operation:order_confirm_reconcile}": ["p(95)<500"],
    "http_req_duration{operation:order_status_verify}": ["p(95)<300"],
  },
};
```

Chuyển từ functional batch sang performance gate: ngoài việc tất cả order được reconcile, còn yêu cầu confirm không quá 500ms p95.

### Variation D: Mô phỏng external_fail_rate để test retry/resilience

```js
// Khi muốn test khả năng retry của hệ thống
const confirmRes = http.post(
  `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=1&db_writes=3&external_ms=80&external_fail_rate=0.05`,
  null,
  {
    headers: { "Idempotency-Key": `reconcile-${orderId}-${jobIndex}` },
    tags: { operation: "order_confirm_reconcile", job_id: orderId },
  }
);

// Nếu external fail (5%), thử retry sau 1s
if (confirmRes.status !== 200) {
  sleep(1);
  const retryRes = http.post(
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?...`,
    null,
    {
      headers: { "Idempotency-Key": `reconcile-${orderId}-${jobIndex}-retry1` },
      tags: { operation: "order_confirm_reconcile", job_id: orderId },
    }
  );
  check(retryRes, { "confirm retry 200": (r) => r.status === 200 });
}
```

### Variation E: Multi-scenario — reconcile + audit order history đồng thời

```js
scenarios: {
  order_reconciliation: {
    executor: "shared-iterations",
    vus: 8,
    iterations: 120,
    maxDuration: "12m",
    tags: { case_id: "si-02-order-reconciliation" },
  },
  order_history_audit: {
    executor: "shared-iterations",
    vus: 4,
    iterations: 80,
    startTime: "10s",
    maxDuration: "10m",
    tags: { case_id: "si-03-order-history-audit" },
  },
},
```

## Anti-pattern

- Dùng `__VU` làm business identity chính cho backlog.
- Dùng `__VU` hoặc fixed string làm idempotency key → key collision.
- Fail test chỉ vì VU distribution không đều.
- Dùng `constant-vus` rồi suy ra exact job count từ duration.
- Dùng arrival-rate executor cho bài toán drain fixed queue.
- Chỉ nhìn response time đẹp mà không kiểm `shared_jobs_total` và operation counts.
- Chỉ check confirm 200, không verify final state → bỏ sót order pending/failed.
- Giữ expected formulas cũ sau khi override `JOBS`.
- Dùng per-VU state (session, token) kỳ vọng sống qua nhiều iter — mỗi iter là 1 order khác nhau.
- Kiểm tra `iterations_per_vu == JOBS / vus` như một pass criteria.
- Cho rằng confirm 200 = order đã được reconcile hoàn tất.
- Dùng lại script per-vu-iterations không đổi idempotency key strategy khi chuyển sang shared-iterations.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-02-order-reconciliation.js`
- Catalog audit case (reference pattern): `./01_catalog-audit.md`
