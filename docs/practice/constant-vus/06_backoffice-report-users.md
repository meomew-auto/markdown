# Case 06: Backoffice report users

## Tình huống thực tế

Backoffice thường ít user hơn storefront nhưng mỗi request có thể nặng: report dashboard, DB rows, gzip, async export job.

Team report muốn giữ 6 staff users active để quan sát UX report trong 5 phút.

Case này khác shared report export batch: không cần xử lý đủ 60 report jobs; cần xem active staff behavior ổn định không.

Tóm tắt đời thường:

```text
Executor model: fixed active user pool
VUs: 6
Duration: 5m
Think time: 2s
Team/service focus: report/backoffice
```

### Đời thường của backoffice report users

Tưởng tượng phòng backoffice của một hệ thống e-commerce:

```text
Phòng report có 6 nhân viên.
Mỗi người ngồi trước màn hình, mở report dashboard.
Họ đọc báo cáo (dashboard read) — vài giây suy nghĩ.
Thỉnh thoảng họ tạo một export job (report job create) khi cần gửi báo cáo cho sếp.
Sau khi tạo job, họ check status (report job status) cho đến khi job done.
Rồi họ quay lại dashboard, đọc tiếp, suy nghĩ tiếp.
```

Điểm khác biệt so với storefront:

```text
Storefront (case 01): user browse product, thêm cart, checkout — flow nhẹ, nhiều request nhỏ.
Backoffice (case 06): user đọc report dashboard, tạo export job — flow nặng, ít request nhưng mỗi request có thể kéo dài.
```

Case này không hỏi:

```text
Có xử lý đủ N job không?
Có đạt đúng X RPS không?
Mỗi user có chạy đúng N vòng không?
```

Nó hỏi:

```text
Nếu giữ 6 active users trong 5m,
latency/error/natural throughput của flow này ra sao?
Dashboard read có ảnh hưởng UX staff không?
Export job create/status có fail không?
```

### Vì sao "Backoffice report users" nên dùng `constant-vus`?

Backoffice report users là steady internal user workflow. `constant-vus` đúng vì có fixed staff concurrency, không phải report-job backlog.

Trước khi vào kỹ thuật, hiểu **mục tiêu** của backoffice report users trước:

```text
Backoffice report users = "6 nhân viên cùng online, mỗi người mở dashboard,
                           đọc report, thỉnh thoảng tạo export job,
                           check status, rồi quay lại dashboard"

Đời thường:
  Phòng report có 6 bàn (= 6 VU)
  Mỗi nhân viên ngồi một bàn, làm việc liên tục trong 5 phút
  Mỗi vòng: mở dashboard → đọc (2s) → thỉnh thoảng tạo export → check status
  Hết 5 phút, xem ai làm được bao nhiêu vòng, có ai bị lỗi không
```

Để backoffice report users test **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ constant-vus mới thỏa mãn cả 2.

#### Yêu cầu (a): STEADY ACTIVE CONCURRENCY (giữ đúng 6 staff cùng online)

**Ý nghĩa**: 6 staff phải cùng active trong suốt observation window. Không phải "tổng cộng có 6 user login trong ngày", mà là "tại cùng một thời điểm, luôn có 6 user đang làm việc".

**Ví dụ cụ thể**:

```text
Scenario: team report muốn biết UX của 6 staff khi cùng dùng hệ thống

Trường hợp A (concurrency đúng):
  6 VU active suốt 5 phút
  Mỗi VU loop liên tục: dashboard → sleep 2s → (optional create) → dashboard...
  → Kết luận: với 6 staff cùng online, latency/error ở mức X

Trường hợp B (concurrency sai — test không giữ được 6 VU):
  Đầu test: 6 VU active
  Giữa test: 1 VU bị stuck ở request dài → còn 5 VU active thật sự
  → Kết luận sai: tưởng 6 staff cùng online nhưng thực tế chỉ 5
  → KHÔNG kết luận được UX của 6 staff thật
```

**Phân tích sâu: vì sao 2 executor "count-based" không giữ được steady concurrency?**

`shared-iterations` với `iterations=60`:

```text
Tưởng tượng: sếp nói "hôm nay kiểm tra 60 report là được, không cần ngồi đủ 5 phút"

6 VU start, cùng xử lý 60 iterations.
Nhưng iterations cố định, không có duration observation window.
Nếu latency thấp: 60 iter xong trong 1 phút → VU idle hết.
  → Test dừng sau 1 phút, không quan sát được 5 phút steady state.
  → KHÔNG trả lời được: "sau 3 phút liên tục dùng, hệ thống có chậm đi không?"

Nếu latency cao: 60 iter mất 8 phút → bị maxDuration cắt.
  → KHÔNG trả lời được: "trong 5 phút bình thường, staff UX ra sao?"
```

`per-vu-iterations` với `iterations=10, vus=6`:

```text
Tưởng tượng: sếp nói "mỗi người làm đúng 10 report rồi nghỉ"

Mỗi VU chạy đúng 10 iter.
VU nhanh (dashboard nhẹ, network tốt): 10 iter xong trong 2 phút → idle.
VU chậm (dashboard nặng, network kém): 10 iter mất 7 phút → vẫn chạy.
→ Concurrency không ổn định: đầu test 6 VU, giữa test còn 3-4 VU.
→ KHÔNG trả lời được: "6 staff cùng online liên tục trong 5 phút thì sao?"
```

**Trong khi đó với `constant-vus`**:

```text
Config: vus=6, duration=5m

6 VU start.
Mỗi VU loop liên tục cho đến khi hết 5 phút.
VU nào xong loop sớm → start loop mới ngay.
VU nào loop chậm → vẫn đang chạy, không bị bỏ.
Suốt 5 phút: luôn có 6 VU active.

Lần 1: server nhanh → mỗi VU chạy được 100 loops → total 600 iter
Lần 2: server chậm → mỗi VU chạy được 40 loops → total 240 iter
Lần 3: server bình thường → mỗi VU chạy được 75 loops → total 450 iter

Số iter KHÁC NHAU — nhưng đó CHÍNH LÀ điều cần đo!
Nếu server chậm, iter giảm = tín hiệu closed-model backpressure.
Nếu server nhanh, iter tăng = hệ thống khỏe.

→ 6 staff luôn active trong 5 phút → concurrency guarantee
→ Số iter thay đổi theo backend → phát hiện được performance regression
```

**Tóm tắt 3 executor về steady concurrency**:

| Executor | Giữ 6 VU active suốt 5m? | Iterations cố định? | Steady concurrency guarantee? |
| --- | --- | --- | --- |
| **constant-vus** | CÓ (duration-based, VU loop liên tục) | KHÔNG (output) | CÓ |
| shared-iterations | KHÔNG (dừng khi hết iter, có thể sớm hơn 5m) | CÓ (input) | KHÔNG (VU idle sớm nếu latency thấp) |
| per-vu-iterations | KHÔNG (VU nhanh idle sớm) | CÓ (input) | KHÔNG (VU tụt dần) |

#### Yêu cầu (b): CLOSED-MODEL BACKPRESSURE SIGNAL (backend chậm phải thấy được qua throughput)

**Ý nghĩa**: Khi report dashboard query chậm (DB issue, gzip nặng), throughput phải tự giảm. Đây là tín hiệu quan trọng — không phải lỗi của test.

**Ví dụ cụ thể**:

```text
Ngày thường (DB index tốt, cache warm):
  Dashboard query: 0.3s
  Loop duration: 0.3s + 2s sleep = 2.3s
  iter/s: 6 / 2.3 ≈ 2.6 iter/s

Ngày DB có vấn đề (missing index, cache cold):
  Dashboard query: 3.0s
  Loop duration: 3.0s + 2s sleep = 5.0s
  iter/s: 6 / 5.0 ≈ 1.2 iter/s

iter/s giảm từ 2.6 → 1.2 = backend chậm → closed-model signal ĐÚNG.
```

Nếu dùng `constant-arrival-rate` với `rate=3/s`:

```text
Ngày DB chậm:
  k6 vẫn cố bơm 3 request/s
  Nếu VU pool không đủ (VU bị kẹt trong request dài):
    → DROP slot, interrupt iteration
    → http_req_failed tăng vì drop
    → KHÔNG phải backend fail, mà là test ép quá sức
  → KHÔNG phân biệt được "backend chậm" vs "test ép quá sức"
```

**Demo closed-model backpressure chi tiết**:

Giả sử một VU loop có 3 bước:

```text
Loop của 1 VU:
  1. GET /api/sim/report              (dashboard)     ~0.5s bình thường
  2. sleep(2)                                         ~2.0s (think time)
  3. Nếu có export (30% loop):
       POST /api/sim/report/jobs       (job create)    ~0.3s
       GET /api/sim/report/jobs/:id    (job status)    ~0.2s
     Nếu không (70% loop):
       không làm gì thêm

  Loop duration bình thường:
    = 0.5s + 2.0s + 0.3×0.5s
    = 2.5s + 0.15s
    = 2.65s

  iter/s bình thường: 6 / 2.65 ≈ 2.26 iter/s
```

Khi dashboard query chậm (DB issue):

```text
  1. GET /api/sim/report              (dashboard)     ~4.0s (CHẬM 8×)
  2. sleep(2)                                         ~2.0s
  3. Optional export: vẫn ~0.5s

  Loop duration khi chậm:
    = 4.0s + 2.0s + 0.3×0.5s
    = 6.0s + 0.15s
    = 6.15s

  iter/s khi chậm: 6 / 6.15 ≈ 0.98 iter/s
```

```text
So sánh:
  Bình thường: loop_duration=2.65s, iter/s=2.26
  DB chậm:     loop_duration=6.15s, iter/s=0.98

  iter/s giảm 57% ← ĐÂY LÀ TÍN HIỆU CẦN ĐỌC
  Không phải "test chạy ít quá" — mà là "backend chậm làm staff UX giảm"
```

Nếu dùng arrival-rate:

```text
Config: rate=2/s, duration=5m

Bình thường (loop 2.65s, cần ~5.3 VU):
  k6 schedule 2 iter/s, VU pool đủ → không drop
  iter/s = 2 (đúng rate)

DB chậm (loop 6.15s, cần ~12.3 VU):
  k6 schedule 2 iter/s nhưng chỉ có 6 VU
  6 VU / 6.15s = 0.98 iter/s capacity
  → k6 DROP 1.02 iter/s
  → http_req_failed tăng do drop

  Kết luận SAI: tưởng backend fail, nhưng thực ra test config sai.
  KHÔNG phân biệt được drop vs backend fail.
```

**Tóm tắt**:

| Executor | Backend chậm → throughput giảm tự nhiên? | Phân biệt được drop vs backend fail? |
| --- | --- | --- |
| **constant-vus** | CÓ (closed-model backpressure) | CÓ (không có drop, iter/s giảm = backend chậm) |
| constant-arrival-rate | KHÔNG (throughput cố gắng giữ rate) | KHÔNG (drop xen vào fail) |
| shared-iterations | KHÔNG áp dụng (throughput là function của count) | KHÔNG áp dụng (không quan sát steady state) |

---
### Tổng kết: chỉ constant-vus thỏa mãn cả (a) và (b)

| Executor | (a) Steady 6-VU concurrency | (b) Closed-model backpressure signal | Verdict |
| --- | --- | --- | --- |
| **constant-vus** | ✓ duration-based, VU loop liên tục | ✓ throughput tự giảm khi backend chậm | ✅ DÙNG |
| shared-iterations | ✗ dừng khi hết iter | ✗ throughput = count/duration, không tự điều chỉnh | ❌ |
| per-vu-iterations | ✗ VU nhanh idle sớm | ✗ VU tụt dần, không giữ steady concurrency | ❌ |
| constant-arrival-rate | ✗ rate-driven, không giữ VU count | ✗ drop slot xen vào, không phân biệt được | ❌ |
| ramping-vus | ✗ VU thay đổi theo time | △ có backpressure nhưng shape không phẳng | ❌ |
| ramping-arrival-rate | ✗ rate + VU đều thay đổi | ✗ quá nhiều biến, không isolate được | ❌ |

→ Chỉ **constant-vus** thỏa mãn cả 2 yêu cầu, các executor khác đều fail ở ít nhất 1 trong 2.

## Yêu cầu cứng của case này

- Giữ 6 active staff users trong 5m.
- Dashboard read và occasional report job create/status phải tách operation.
- Không đọc thấp VU count là test không quan trọng; report path có thể rất nặng.
- Failed loops phải dưới `constant_active_iterations_failed count<10`.

Các invariant chung:

```text
vus + duration = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì RPS giảm
```

Do đó không được fail test chỉ vì `iterations` không bằng một số target tưởng tượng.

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| VUs giữ gần 6 trong toàn regular phase | Vì 6 là số staff active cần quan sát; VU tụt = concurrency không đạt. |
| `constant_active_iterations_failed < 10` | Có failed loop nghĩa là staff flow bị đứt; dưới 10 là chấp nhận được trong 5m. |
| `checks rate > 0.99` | Business contract của API phải được tôn trọng. |
| `http_req_failed rate < 0.01` | HTTP failure phải thấp; nếu cao, không kết luận được UX. |
| Operation tags phải có đủ 3 operation | Dashboard, job_create, job_status phải tách được; aggregate che branch nhỏ. |
| Flow duration phải được đo bằng `constant_flow_duration_ms` | Đây là staff UX end-to-end, không chỉ từng request. |

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

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
CV_06_VUS = 6
CV_06_DURATION = 5m
CV_06_READY_AFTER_MS = 1
CV_06_SLEEP_SECONDS = 2
```

| Config/env | Giá trị | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `CV_06_VUS` | 6 | Số active backoffice users |
| `CV_06_DURATION` | 5m | Observation window |
| `CV_06_SLEEP_SECONDS` | 2 | Think time dài hơn vì staff đọc report |
| `CV_06_READY_AFTER_MS` | 1 | Async readiness simulation |

Extra env:

| Env | Default | Ý nghĩa |
| --- | --- | --- |
| `CV_06_READY_AFTER_MS` | 1 | Async report readiness simulation |

Mapping quan trọng:

```text
business staff count = 6
k6 vus              = 6
observation window  = 5m
think time           = 2s (staff reads report between actions)
async readiness      = 1ms (simulation knob for job readiness delay)
```

Threshold cap riêng:

```text
constant_active_iterations_failed: count<10
```

## Technical semantics: active user pool, loop identity, closed model

### Identity model: VU = staff user

Trong constant-vus, VU không phải generic worker bốc job từ backlog. Nó là **staff identity**:

```text
__VU / exec.vu.idInTest = active staff user identity tương đối ổn định
__ITER                  = loop counter của riêng VU đó
exec.scenario.iterationInTest = global loop counter, không phải backlog job id
```

Một VU có thể chạy nhiều loops trong duration. Nhưng không có quota kiểu:

```text
mỗi VU phải chạy đúng N loops
```

Nếu cần quota per user, dùng `per-vu-iterations`.

Nếu cần fixed global job list, dùng `shared-iterations`.

### VU identity vs iteration identity

Điểm quan trọng khi code constant-vus script cho backoffice:

```text
__VU:
  - Staff user ID, từ 1 đến 6
  - VU=1 = "staff-1", VU=2 = "staff-2", ...
  - Mỗi VU giữ identity ổn định suốt duration
  - Dùng __VU để tag user_id, mô phỏng session/user-specific behavior

__ITER:
  - Local counter của từng VU, bắt đầu từ 0
  - VU=1: __ITER=0 → loop đầu của staff-1
  - VU=1: __ITER=1 → loop thứ hai của staff-1
  - Dùng để biết staff này đã loop bao nhiêu lần

exec.scenario.iterationInTest:
  - Global loop index trong toàn scenario
  - Ít dùng trong constant-vus vì không có backlog cố định
  - Có thể dùng để trace thứ tự loop nếu cần debug
```

**Demo trace identity model với 3 VU, 10s duration**:

```text
Config: vus=3, duration=10s, sleep=2s

t=0.0s   3 VU start
         VU=1 (staff-1): __ITER=0, GET /report → sleep 2s
         VU=2 (staff-2): __ITER=0, GET /report → sleep 2s
         VU=3 (staff-3): __ITER=0, GET /report → sleep 2s

t=2.1s   VU=1 xong sleep, __ITER=1, GET /report → sleep 2s
         (staff-1 bắt đầu loop thứ 2)

t=2.2s   VU=2 xong sleep, __ITER=1, GET /report → sleep 2s
t=2.3s   VU=3 xong sleep, __ITER=1, GET /report → sleep 2s

t=4.1s   VU=1: __ITER=2, loop thứ 3
...

t=10.0s  Duration hết → tất cả VU dừng.

Tổng kết:
  VU=1 (staff-1): __ITER=0..4 (5 loops)
  VU=2 (staff-2): __ITER=0..4 (5 loops)
  VU=3 (staff-3): __ITER=0..4 (5 loops)
  Total iterations = 15

Code đúng:
  const userId = `staff-${__VU}`;  // staff identity ổn định
  // Mỗi loop dùng cùng userId để tag metric

Code sai (trong constant-vus):
  const skuIndex = exec.scenario.iterationInTest;
  // iterationInTest chỉ là loop index, không phải business identity
  // Không có fixed backlog để map
```

### Vì sao VU identity quan trọng cho backoffice?

```text
Trong shared-iterations: VU là worker, không có identity ổn định.
  → VU=1 chạy job #0 (SKU A), xong job #5 (SKU F)...
  → Identity thay đổi mỗi iteration.

Trong constant-vus (case này): VU là staff user.
  → VU=1 luôn là "staff-1", loop đi loop lại.
  → Có thể mô phỏng: staff-1 luôn tạo export, staff-2 không bao giờ tạo...
  → Có thể tag user_id để trace ai bị fail nhiều.
```

### Closed model: backend chậm thì RPS giảm

Trong constant-vus:

```text
__VU / exec.vu.idInTest = active user identity tương đối ổn định
__ITER                  = loop counter của riêng VU đó
exec.scenario.iterationInTest = global loop counter, không phải backlog job id
```

Mental model:

```text
6 active VUs start.
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

**Công thức closed-model cho case này**:

```text
loop_duration ~= dashboard_latency + sleep + branch_mix × (create_latency + status_latency)

Với case này:
  dashboard_latency bình thường ~0.5s
  sleep = 2.0s
  branch_mix = 30% loop có export
  create_latency ~0.3s, status_latency ~0.2s

  loop_duration_bình_thường = 0.5 + 2.0 + 0.3 × (0.3 + 0.2)
                             = 2.5 + 0.15
                             = 2.65s

  iter/s = vus / loop_duration = 6 / 2.65 ≈ 2.26 iter/s

Khi dashboard query chậm (DB issue, 3.5s thay vì 0.5s):
  loop_duration_chậm = 3.5 + 2.0 + 0.15 = 5.65s
  iter/s = 6 / 5.65 ≈ 1.06 iter/s

  → iter/s giảm 53% = tín hiệu closed-model rõ rệt
```

## Technical root causes this case catches

### Nguyên nhân kỹ thuật 1: Low VU count can still stress expensive paths

6 staff users có thể đủ tạo DB/gzip/report pressure nếu endpoint nặng.

**Vấn đề**: Nhiều người nghĩ "chỉ 6 VU thì không thể là performance test". Nhưng 6 VU với query nặng có thể tạo áp lực tương đương 600 VU với query nhẹ.

**Demo so sánh: 6 VU query nặng vs 100 VU query nhẹ**:

```text
Case A: 6 VU backoffice, mỗi dashboard query:
  - 50MB dữ liệu report
  - JOIN 5 bảng
  - GROUP BY + aggregation
  - gzip response
  → Mỗi query: 3-5s CPU + 2-4s I/O + 1s gzip
  → 6 query đồng thời: DB CPU 90-100%

Case B: 100 VU storefront, mỗi product list query:
  - 1KB dữ liệu
  - Index scan
  - Cache hit 95%
  → Mỗi query: 0.01-0.05s
  → 100 query đồng thời: DB CPU 20-30%

Kết luận: 6 VU case A nặng hơn 100 VU case B.
→ Đừng đánh giá test bằng VU count.
→ Đánh giá bằng workload per operation.
```

**Cách phát hiện**: So sánh `http_req_duration` của `backoffice_report_dashboard` với baseline storefront. Nếu dashboard p95 >> storefront p95, đó là tín hiệu đúng — report path đang nặng hơn.

**Demo trace: 6 VU dashboard query gây DB pressure**:

```text
Backend state: DB server 8 CPU cores, report query dùng 1.5 core/query

t=0.0s   6 VU cùng gọi GET /api/sim/report
         → 6 query × 1.5 core = 9 cores demand > 8 cores supply
         → DB queue bắt đầu hình thành

t=0.5s   Query đầu tiên xong (core 1-2)
t=1.0s   Query thứ hai xong (core 3-4)
t=1.5s   Query thứ ba xong (core 5-6)
t=2.0s   Query thứ tư xong (core 7-8)
t=3.0s   Query thứ năm xong (core 1-2, vừa free từ query 1)
t=4.0s   Query thứ sáu xong (core 3-4)

  → 6 query hoàn thành trong 0.5-4.0s (không đều)
  → p95 = 4.0s (bị queue delay)
  → Dù chỉ 6 VU, DB đã bão hòa

Nếu tăng lên 8 VU:
  → DB queue dài hơn → p95 còn cao hơn nữa
```

### Nguyên nhân kỹ thuật 2: Export creation is occasional

Nếu chỉ nhìn aggregate, report job create/status có thể bị dashboard read che. Cần operation tags.

**Vấn đề**: Dashboard read chiếm ~77% API calls (mỗi loop luôn có dashboard), trong khi job create + status chỉ chiếm ~23% (chỉ 30% loop có export). Nếu nhìn aggregate p95, latency của job create/status bị pha loãng bởi dashboard read.

**Demo trace: job create chậm nhưng aggregate p95 vẫn đẹp**:

```text
Giả sử trong 5m, 6 VU chạy được 680 iterations.
Mỗi iteration có:
  - dashboard read: 100% × 680 = 680 calls, avg=0.5s, p95=0.8s
  - job create:     30% × 680 = 204 calls, avg=4.0s, p95=8.0s (CHẬM!)
  - job status:     30% × 680 = 204 calls, avg=0.2s, p95=0.4s

Tổng API calls = 680 + 204 + 204 = 1088

Aggregate http_req_duration:
  avg = (680×0.5 + 204×4.0 + 204×0.2) / 1088
      = (340 + 816 + 40.8) / 1088
      = 1196.8 / 1088
      = 1.1s  ← trông vẫn ổn!

Nhưng nếu tách theo operation:
  backoffice_report_dashboard:    avg=0.5s, p95=0.8s  ✓ OK
  backoffice_report_job_create:   avg=4.0s, p95=8.0s  ← CHẬM!
  backoffice_report_job_status:   avg=0.2s, p95=0.4s  ✓ OK

→ Aggregate che mất job create chậm.
→ Nếu không tách operation, tưởng test OK nhưng staff UX khi tạo export job rất tệ.
```

**Cách phát hiện**: Luôn đọc metric theo tag `operation`. So sánh p95 của từng operation, không chỉ aggregate. Nếu `backoffice_report_job_create` p95 >> `backoffice_report_dashboard` p95, điều tra job create pipeline.

**Demo trace: aggregate che mất branch nhỏ nhưng chậm**:

```text
Dashboard chart nếu chỉ filter theo service=report-service:

  http_req_duration p95 = 0.9s  ← nhìn ổn
  http_req_duration avg = 0.6s  ← nhìn ổn

Dashboard chart nếu tách theo operation:

  backoffice_report_dashboard:    p95=0.8s, avg=0.5s  ✓
  backoffice_report_job_create:   p95=9.5s, avg=4.5s  ← SPIKE!
  backoffice_report_job_status:   p95=0.4s, avg=0.2s  ✓

→ p95 aggregate = 0.9s nhưng job_create p95 = 9.5s
→ Aggregate bị dashboard (nhiều call, nhẹ) kéo xuống
→ Job create (ít call, nặng) bị "pha loãng" trong aggregate
→ Đây là lý do operation tag là BẮT BUỘC cho case này
```

### Nguyên nhân kỹ thuật 3: Dashboard read latency affects staff UX

Ngay cả khi export job pass, report dashboard chậm vẫn là UX regression.

**Vấn đề**: Staff dành phần lớn thời gian ở dashboard (đọc report, suy nghĩ). Nếu dashboard load 3-5s thay vì 0.5s, UX bị ảnh hưởng dù export job vẫn pass.

**Demo: dashboard chậm nhưng export pass → test "pass" nhưng UX fail**:

```text
Scenario: DB thiếu index cho report dashboard query.

Run 5m, 6 VU:
  backoffice_report_dashboard:    680 calls, avg=4.2s, p95=7.0s  ← CHẬM
  backoffice_report_job_create:   204 calls, avg=0.4s, p95=0.7s  ✓ OK
  backoffice_report_job_status:   204 calls, avg=0.2s, p95=0.4s  ✓ OK

  checks rate: 100% (tất cả API đều 200/202)
  http_req_failed: 0%
  constant_active_iterations_failed: 0

  → Tất cả threshold PASS!
  → Nhưng dashboard avg=4.2s, p95=7.0s
  → Staff mở dashboard mất 4-7 giây → UX rất tệ
  → Test "pass" nhưng production staff sẽ phàn nàn
```

**Tác động thật đến staff**:

```text
Loop bình thường (dashboard 0.5s):
  dashboard 0.5s → đọc 2s → (optional export 0.5s) → dashboard 0.5s → ...
  Mỗi phút: ~23 vòng dashboard → staff xem được nhiều report

Loop dashboard chậm (dashboard 4.0s):
  dashboard 4.0s → đọc 2s → (optional export 0.5s) → dashboard 4.0s → ...
  Mỗi phút: ~9 vòng dashboard → staff xem được ít report hơn 60%

  → Dù không có lỗi, productivity giảm 60%.
  → Đây là lý do flow duration quan trọng, không chỉ error rate.
```

**Cách phát hiện**: Đặt threshold cho `http_req_duration{operation:backoffice_report_dashboard}`. Không chỉ check fail/success. Nếu muốn gate performance, thêm `p(95)<2000` cho dashboard read.

### Nguyên nhân kỹ thuật 4: READY_AFTER_MS changes async timing

Simulation knob này ảnh hưởng status/readiness; khi đổi env phải đọc lại flow duration.

**Vấn đề**: `CV_06_READY_AFTER_MS` mô phỏng delay giữa lúc job created (202 Accepted) và lúc job thật sự ready. Nếu set quá thấp (1ms), status trả về "done" ngay. Nếu set cao hơn (vd 500ms), status có thể cần polling loop.

**Demo: READY_AFTER_MS thay đổi flow duration**:

```text
READY_AFTER_MS = 1 (default):
  POST /report/jobs → 202 (job accepted)
  GET /report/jobs/:id → 200 {status: "done"} (gần như ngay lập tức)
  → Flow nhánh export: ~0.3s + ~0.2s = ~0.5s

READY_AFTER_MS = 500:
  POST /report/jobs → 202 (job accepted)
  GET /report/jobs/:id → 200 {status: "processing"} (chưa ready)
  → Cần poll lại: GET /report/jobs/:id → 200 {status: "done"} (sau 500ms)
  → Flow nhánh export: ~0.3s + 0.5s + ~0.2s = ~1.0s

READY_AFTER_MS = 2000:
  POST /report/jobs → 202
  GET /report/jobs/:id → {status: "processing"} (lần 1, t=0)
  GET /report/jobs/:id → {status: "processing"} (lần 2, t=0.5s)
  GET /report/jobs/:id → {status: "processing"} (lần 3, t=1.0s)
  GET /report/jobs/:id → {status: "processing"} (lần 4, t=1.5s)
  GET /report/jobs/:id → {status: "done"}     (lần 5, t=2.0s)
  → Flow nhánh export: ~0.3s + 2.0s + ~0.2s = ~2.5s
```

**Tác động đến flow duration**:

```text
READY_AFTER_MS = 1:
  loop_duration = 0.5 + 2.0 + 0.3×0.5 = 2.65s
  iter/s = 6 / 2.65 ≈ 2.26

READY_AFTER_MS = 2000 (với polling loop):
  loop_duration = 0.5 + 2.0 + 0.3×2.5 = 3.25s
  iter/s = 6 / 3.25 ≈ 1.85

  → iter/s giảm 18% chỉ vì async timing thay đổi
  → KHÔNG phải backend chậm hơn — là simulation parameter khác
  → Khi so sánh 2 run, phải check READY_AFTER_MS trước khi kết luận regression
```

**Cách phát hiện**: Luôn check env vars trước khi so sánh 2 run. Nếu READY_AFTER_MS khác, expected flow duration khác → không so sánh trực tiếp iter/s.

## LOW-VU HIGH-IMPACT: phân tích sâu

### Vì sao "chỉ 6 VU" vẫn là performance test?

Backoffice report query khác storefront product query ở nhiều mặt:

| Tiêu chí | Storefront product list | Backoffice report dashboard |
| --- | --- | --- |
| Data volume | 10-50 rows, 1-5KB | 1000-10000 rows, 100KB-50MB |
| Query complexity | Index scan, 1-2 tables | JOIN 3-7 tables, GROUP BY, aggregation |
| Response format | JSON nhỏ, không nén | JSON lớn, có gzip |
| Cache hit rate | 80-95% (products ít thay đổi) | 20-50% (report real-time, thay đổi liên tục) |
| DB CPU/query | 0.01-0.1 core | 1.0-2.0 cores |
| Memory/query | 1-5MB | 100-500MB |
| I/O/query | Vài KB | 10-50MB disk read |

**Công thức áp lực DB**:

```text
DB pressure = VU_count × resource_per_query

Storefront: 100 VU × 0.05 core  = 5 cores demand
Backoffice:   6 VU × 1.5 cores   = 9 cores demand

→ 6 backoffice VU nặng hơn 100 storefront VU!
```

### Demo: 6 VU bão hòa DB trong khi 100 VU storefront vẫn ổn

```text
Máy chủ DB: 8 CPU cores, 32GB RAM

Scenario A — 100 VU storefront (product list):
  Mỗi query: 0.05 core, 5MB RAM
  100 query đồng thời: 5 cores, 500MB RAM
  → DB CPU 62.5%, RAM 1.5% → còn dư nhiều
  → p95 = 0.08s (tốt)

Scenario B — 6 VU backoffice (report dashboard):
  Mỗi query: 1.5 cores, 200MB RAM
  6 query đồng thời: 9 cores, 1.2GB RAM
  → DB CPU 112.5% (oversubscribed!), RAM 3.75%
  → DB queue hình thành → một số query phải chờ
  → p95 = 4.0s (chậm vì CPU oversubscribed)

Kết luận: 6 VU backoffice = DB bão hòa.
         100 VU storefront = DB vẫn khỏe.
→ VU count không nói lên mức độ stress.
→ Phải hiểu workload per operation.
```

### Khi nào 6 VU backoffice gây vấn đề?

| Điều kiện | DB CPU | Dashboard p95 | Hành động |
| --- | --- | --- | --- |
| 6 VU, query nhẹ (cache hit, ít data) | 30-50% | <1s | Bình thường |
| 6 VU, query vừa (cache miss, data vừa) | 60-80% | 1-3s | Theo dõi |
| 6 VU, query nặng (cache miss, nhiều JOIN, nhiều data) | 90-100% | 3-8s | Cần tối ưu query hoặc scale DB |
| 6 VU, query nặng + export jobs | 95-100% | 5-15s | DB bão hòa, cần index/cache/scale |

### Khác với shared-iterations report export batch

Case này (constant-vus) khác shared-iterations report-export-batch:

| Tiêu chí | Case 06 (constant-vus) | Report export batch (shared-iterations) |
| --- | --- | --- |
| Mục tiêu | Quan sát steady UX của 6 staff | Drain đủ 60 report lifecycle jobs |
| Input | vus=6, duration=5m | iterations=60, vus=... |
| Output cần đo | Latency, error, flow duration | Total jobs done, failed jobs |
| Branch mix | 70% dashboard-only, 30% có export | Mỗi iteration luôn có export |
| Think time | 2s (staff đọc report) | Có thể không có hoặc ngắn |
| VU identity | Staff user ổn định | Worker bốc job từ pool |
| Async flow | Trong cùng 1 loop, tạo job → poll status ngay | Mỗi iteration là 1 async lifecycle hoàn chỉnh |

## ASYNC FLOW trong constant-vus: create → poll → verify

### Khác biệt với shared-iterations async pattern

Trong shared-iterations, mỗi iteration là một async lifecycle hoàn chỉnh:

```text
shared-iterations report export batch:
  Iteration #0:
    1. POST /report/jobs → 202 (tạo job)
    2. Poll GET /report/jobs/:id cho đến khi done
    3. Verify kết quả
  → Iteration #0 kết thúc = 1 job hoàn tất
  → Iteration #1 bắt đầu = job mới, identity mới
```

Trong constant-vus, async flow là một nhánh optional trong loop:

```text
constant-vus backoffice:
  VU=1 (staff-1) loop:
    1. GET /report (dashboard) → 200
    2. sleep(2s) ← staff đọc report
    3. Nếu staff quyết định tạo export (30%):
       a. POST /report/jobs → 202
       b. GET /report/jobs/:id → 200 (poll status)
       c. Nếu READY_AFTER_MS cao, poll lại
    4. Quay lại bước 1 (loop tiếp)
  → Export job là nhánh trong loop, không phải toàn bộ iteration
  → VU vẫn là staff-1, identity không đổi
```

### Pattern code cho async flow trong constant-vus

```js
import { sleep, check } from "k6";
import http from "k6/http";

export default function () {
  const userId = `staff-${__VU}`;
  const tags = { user_id: userId };

  // Bước 1: Mở report dashboard (luôn có)
  const dashboardRes = http.get(`${__ENV.BASE_URL}/api/sim/report`, {
    tags: { ...tags, operation: "backoffice_report_dashboard" },
  });
  check(dashboardRes, { "dashboard status 200": (r) => r.status === 200 });

  // Bước 2: Staff đọc report, suy nghĩ
  sleep(parseFloat(__ENV.CV_06_SLEEP_SECONDS || "2"));

  // Bước 3: Thỉnh thoảng tạo export job (30% loop)
  if (Math.random() < 0.3) {
    const createRes = http.post(`${__ENV.BASE_URL}/api/sim/report/jobs`, null, {
      tags: { ...tags, operation: "backoffice_report_job_create" },
    });
    check(createRes, { "job create accepted 202": (r) => r.status === 202 });

    const jobId = createRes.json("id");

    // Bước 4: Poll status (có thể cần poll nhiều lần nếu READY_AFTER_MS cao)
    let jobDone = false;
    let polls = 0;
    const maxPolls = parseInt(__ENV.CV_06_MAX_POLLS || "10");
    const pollInterval = parseFloat(__ENV.CV_06_POLL_INTERVAL_MS || "500") / 1000;

    while (!jobDone && polls < maxPolls) {
      const statusRes = http.get(`${__ENV.BASE_URL}/api/sim/report/jobs/${jobId}`, {
        tags: { ...tags, operation: "backoffice_report_job_status" },
      });
      check(statusRes, { "job status 200": (r) => r.status === 200 });

      if (statusRes.json("status") === "done") {
        jobDone = true;
      } else {
        polls++;
        if (polls < maxPolls) {
          sleep(pollInterval);
        }
      }
    }

    if (!jobDone) {
      // Job không done trong maxPolls — đánh dấu loop failed
      console.warn(`staff-${__VU} job ${jobId} not done after ${maxPolls} polls`);
    }
  }

  // Loop tiếp: quay lại dashboard
}
```

### Polling strategy theo READY_AFTER_MS

| READY_AFTER_MS | Poll strategy | Số poll trung bình | Thời gian chờ tổng |
| --- | --- | --- | --- |
| 1ms | Gọi 1 lần, gần như done ngay | 1 | ~0.2s |
| 100ms | Gọi 1-2 lần | 1-2 | ~0.3-0.5s |
| 500ms | Gọi 2-3 lần (interval 0.5s) | 2-3 | ~1.0-1.5s |
| 2000ms | Gọi 5 lần (interval 0.5s) | 5 | ~2.5s |
| 5000ms | Gọi 10+ lần, có thể timeout | 10+ | ~5.0s+ |

## Service/API flow

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| backoffice_report_dashboard | report-service | GET | /api/sim/report | 200 | Open report dashboard. |
| backoffice_report_job_create | report-service | POST | /api/sim/report/jobs | 202 | Create report export job. |
| backoffice_report_job_status | report-service | GET | /api/sim/report/jobs/:id | 200 | Check report job status. |

Các operation này phải được đọc bằng tag `operation`, vì aggregate metrics có thể che branch nhỏ nhưng chậm.

### Phân bố operation trong flow

```text
Mỗi loop (iteration):
  backoffice_report_dashboard: 100% (1 call/loop)
  backoffice_report_job_create: ~30% (0.3 call/loop trung bình)
  backoffice_report_job_status: ~30% × số_poll_trung_bình

Với READY_AFTER_MS=1 (done ngay):
  API calls mỗi loop trung bình = 1 + 0.3×1 + 0.3×1 = 1.6 calls

Với READY_AFTER_MS=500 (cần 2 poll):
  API calls mỗi loop trung bình = 1 + 0.3×1 + 0.3×2 = 1.9 calls
```

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
case_id       = cv-06-backoffice-report-users
business_case = backoffice_report_users
workload      = steady_concurrency
```

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

### Pass criteria mở rộng (theo operation)

Nếu muốn biến case này thành performance gate (không chỉ functional pass):

```text
// Functional (bắt buộc)
checks rate > 0.99
http_req_failed rate < 0.01
constant_active_iterations_failed count < 10

// Performance (optional, tùy team)
http_req_duration{operation:backoffice_report_dashboard}: p(95) < 2000ms
http_req_duration{operation:backoffice_report_job_create}: p(95) < 5000ms
http_req_duration{operation:backoffice_report_job_status}: p(95) < 1000ms
constant_flow_duration_ms: p(95) < 8000ms
```

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-06-backoffice-report-users.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-06-backoffice-report-users.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-06-backoffice-report-users.js
```

### Override env vars để thử variation

```powershell
# Tăng READY_AFTER_MS để thấy async timing ảnh hưởng flow duration
$env:CV_06_READY_AFTER_MS = 2000
k6 run ...cv-06-backoffice-report-users.js

# Giảm sleep để thấy think time ảnh hưởng iter/s
$env:CV_06_SLEEP_SECONDS = 0.5
k6 run ...cv-06-backoffice-report-users.js

# Tăng VUs để stress test report service
$env:CV_06_VUS = 12
k6 run ...cv-06-backoffice-report-users.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = constant-vus
vus = 6 hoặc env override
duration = 5m hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ expected behavior.

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

**Cách sanity check counters cho case này**:

```text
Biết:
  duration = 5m = 300s
  sleep = 2s mỗi loop
  dashboard latency ~0.5s (nếu backend khỏe)

Loop duration tối thiểu (không export):
  = 0.5s (dashboard) + 2.0s (sleep) = 2.5s

Loop duration trung bình (có 30% export, READY_AFTER_MS=1):
  = 2.5s + 0.3 × 0.5s = 2.65s

Expected iterations (ước lượng):
  ~ 6 VU × 300s / 2.65s ≈ 679 iterations

Expected http_reqs (ước lượng):
  ~ 679 × 1.6 calls/loop ≈ 1086 calls

Nhưng đây CHỈ là ước lượng.
Nếu số thật thấp hơn nhiều → dashboard latency cao hơn dự kiến.
Nếu số thật cao hơn nhiều → dashboard latency thấp hơn dự kiến.
```

### Bước 5 — Interpret duration/throughput

Đọc:

```text
constant_flow_duration_ms
iteration_duration
http_req_duration by operation
```

Case-specific notes:

- `iterations` là số staff loops, không phải số report jobs cần hoàn tất.
- `constant_flow_duration_ms` quan trọng vì staff UX là full loop.
- `constant_api_calls_total` phụ thuộc branch occasional create/status.
- `constant_sleep_seconds` nên gần `iterations × 2s` (vì mỗi loop sleep 2s).

## Đọc dashboard real-time charts cho case 06

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
backoffice_report_dashboard: GET /api/sim/report
backoffice_report_job_create: POST /api/sim/report/jobs
backoffice_report_job_status: GET /api/sim/report/jobs/:id
```

Cách đọc:

```text
http_req_duration       = latency từng request
constant_flow_duration_ms = latency full user loop
iteration_duration      = duration vòng default(), thường bao gồm sleep
```

Đừng dùng aggregate p95 một mình trong mixed/multi-operation flow.

#### Cách phân tích sâu chart Response time

Khi nhìn chart này, đọc theo 4 câu hỏi:

```text
1. Operation nào có avg cao nhất?
2. Operation nào có p95 spike?
3. Operation nào có max outlier?
4. Dashboard read latency có ổn định suốt 5m không?
```

Với case 06, shape đẹp thường có:

```text
dashboard read: avg thấp nhất vì là GET nhẹ nhất trong 3 operation
                (nhưng đây là report query — có thể vẫn nặng!)
job create:     avg cao hơn dashboard (POST + async accept)
job status:     avg thấp nhất (GET nhẹ, thường có cache)

Nếu READY_AFTER_MS cao:
  job status có thể xuất hiện nhiều call hơn (do polling)
  → count của job_status > count của job_create
```

#### Phân tích operation-level latency

**backoffice_report_dashboard**:

```text
Đây là operation quan trọng nhất vì chiếm nhiều nhất (~63% calls).
Nếu dashboard p95 cao:
  - DB query chậm (thiếu index, nhiều JOIN)
  - gzip response lớn (CPU nén)
  - Network bandwidth không đủ (response 50MB)
→ Staff UX bị ảnh hưởng trực tiếp vì mỗi loop đều gọi dashboard.
```

**backoffice_report_job_create**:

```text
Đây là operation ít gọi nhất (~19% calls) nhưng có thể chậm nhất.
Nếu job_create p95 >> dashboard p95:
  - POST handler chậm (validation, DB insert)
  - Async worker queue đầy → 202 chậm accepted
  - DB write lock contention
→ Khi staff cần export, họ phải chờ lâu hơn bình thường.
```

**backoffice_report_job_status**:

```text
Nếu READY_AFTER_MS thấp, count ~= job_create count.
Nếu READY_AFTER_MS cao, count > job_create count (polling nhiều lần).
→ Kiểm count ratio: nếu status_count / create_count > 3, polling quá nhiều.
```

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| dashboard p95 cao ngay từ đầu, ổn định | query luôn nặng, không phải cold start | tối ưu report query |
| dashboard p95 tăng dần theo thời gian | memory leak, DB connection pool cạn, cache eviction | kiểm resource theo thời gian |
| job_create max spike cao nhưng p95 thấp | vài outlier, không phải pattern | xem log, chưa fail |
| job_create p95 cao đều | POST path có vấn đề hệ thống | điều tra job create pipeline |
| job_status count >> job_create count | polling quá nhiều, READY_AFTER_MS cao | kiểm env, tối ưu poll interval |
| dashboard avg tăng đột ngột ở phút thứ 3 | sự kiện ngoại lai (backup, cron, deploy) | correlate với system events |

Case-specific hints:

- Response time: tách dashboard vs job create/status.
- Execution timeline: low VUs nhưng report endpoints có thể tạo high latency buckets.
- VUs vs iter/s: long sleep 2s làm iter/s thấp có chủ ý.

### Chart 2 — Execution timeline

Với constant-vus:

```text
VUs should be flat near 6 during regular phase.
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
  "tại mỗi giây, 6 staff đã hoàn thành bao nhiêu loops? bao nhiêu request?"
```

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs — 6 staff có đang active không?
2. HTTP reqs mỗi bucket — bao nhiêu request hoàn thành trong giây đó?
3. Iterations mỗi bucket — bao nhiêu loop hoàn thành trong giây đó?
```

Với constant-vus, shape "đẹp" thường là:

```text
đầu run:
  Live VUs = 6 (tất cả staff vào làm)
  iter/s và RPS ổn định ngay (không cold start nặng như arrival-rate)
  (nếu READY_AFTER_MS cao, có thể thấy job_status count tăng dần)

giữa run:
  Live VUs giữ gần 6
  iter/s dao động nhẹ theo branch mix (có loop có export, có loop không)
  RPS dao động tương ứng

cuối run:
  Live VUs vẫn gần 6 cho đến khi duration hết
  iter/s và RPS có thể giảm nhẹ (gracefulStop)
  Sau đó tất cả VU dừng cùng lúc
```

Điểm khác với shared-iterations:

```text
shared-iterations:
  VU tụt ở cuối vì backlog hết việc
  Shape: plateau → decline → zero

constant-vus:
  VU giữ flat suốt duration
  Shape: plateau → abrupt stop (khi duration hết)
  → KHÔNG có "đuôi dài" của VU cuối cùng
  → Tất cả VU dừng khi duration kết thúc
```

Invalid patterns:

| Pattern | Nghĩa |
| --- | --- |
| VUs không giữ được 6 trong regular phase | VU bị kẹt ở request dài, hoặc config/env sai |
| iter/s giảm dần dù VUs flat | closed-model backpressure (loop chậm dần) |
| RPS spike rồi giảm mạnh | có thể do branch mix thay đổi hoặc backend quá tải rồi hồi |
| iter/s gần 0 dù VUs=6 | tất cả VU đang bị kẹt trong request dài (dashboard query treo) |
| http_reqs không tương quan với iterations | branch mix thay đổi (loop có export khác loop không export) |

#### Vì sao iter/s case này thấp hơn các case constant-vus khác?

```text
Case 01 (storefront, 20 VU): sleep có thể 0.5s, loop nhẹ → iter/s cao hơn
Case 06 (backoffice, 6 VU):  sleep 2s, dashboard nặng → iter/s thấp hơn

So sánh:
  Case 01: loop_duration ~1.0s (0.5s API + 0.5s sleep), iter/s ~20/1.0 = 20
  Case 06: loop_duration ~2.65s (0.65s API + 2.0s sleep), iter/s ~6/2.65 = 2.26

→ iter/s case 06 thấp hơn KHÔNG phải bug.
→ Đó là do sleep dài hơn + API nặng hơn + ít VU hơn.
→ Đừng so sánh iter/s giữa 2 case khác business shape.
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
6 staff có giữ active suốt 5 phút không?
Throughput loop có ổn định không?
```

Với constant-vus, đường `Executor VUs` và `Actual iter/s` có quan hệ:

```text
peak_rate ≈ vus / loop_duration
         ≈ 6 / loop_duration

Nếu loop_duration avg = 2.65s:
  peak_rate ≈ 6 / 2.65 ≈ 2.26 iter/s

Nếu loop_duration avg = 6.0s (dashboard chậm):
  peak_rate ≈ 6 / 6.0 ≈ 1.0 iter/s
```

Shape mong đợi:

```text
- đầu run: iter/s có thể dao động (loop đầu đang hoàn thành)
- giữa run: iter/s ổn định ở mức ~2.2-2.3 iter/s (nếu backend bình thường)
- cuối run: iter/s giảm nhẹ (gracefulStop), rồi về 0
- đường VUs: flat ở 6 suốt regular phase
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| `Actual iter/s` đầu = 0, sau tăng | loop đầu chưa hoàn tất | bình thường |
| `Actual iter/s` dao động quanh 2.2-2.3 | branch mix thay đổi nhẹ (có loop export, có loop không) | bình thường |
| `Actual iter/s` = 0.5-1.0 dù VUs=6 | dashboard query rất chậm, loop duration dài | cần điều tra dashboard |
| `Actual iter/s` giảm dần từ 2.3 → 1.5 | backend đang chậm dần (leak, saturation) | cần điều tra backend resource |
| `Actual iter/s` tăng đột biến rồi giảm | branch mix thay đổi hoặc cache warm up | kiểm operation breakdown |
| VUs không lên tới 6 | config/env sai, VU init lỗi | kiểm header |
| VUs flat nhưng iter/s = 0 lâu | tất cả VU kẹt trong request | backend treo hoặc timeout |

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận failures/thresholds trước.
2. VUs vs iter/s xác nhận active-user pool có phẳng không.
3. Execution timeline cho thấy RPS/iter/s là output theo time.
4. Response time by operation tìm service/branch chậm.
5. Business decision dựa trên failures + latency + closed-model throughput change.
```

## Kết luận thực tế: output -> quyết định

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| dashboard/status clean | Backoffice steady use OK | Accept |
| dashboard slow | Report query/gzip/DB issue | Investigate report dashboard |
| create accepted but status issue | Async report worker issue | Inspect worker/status path |
| low VUs but high flow duration | Internal workflow bottleneck | Tune report pipeline |

### Kịch bản A — output sạch: BACKOFFICE PASS

```text
iterations................: 680
http_req_failed...........: 0.00%
checks....................: 100%
constant_active_iterations: 680
constant_active_iterations_failed: 0
http_reqs.................: 1090

backoffice_report_dashboard:  avg=0.5s, p95=0.8s, count=680
backoffice_report_job_create: avg=0.4s, p95=0.7s, count=205
backoffice_report_job_status: avg=0.2s, p95=0.4s, count=205

constant_flow_duration_ms: avg=2650, p95=3200
constant_sleep_seconds: 1360  (= 680 × 2s)
```

Kết luận thực tế:

```text
- 6 staff active suốt 5m, VUs flat
- 680 loops hoàn tất, 0 failed
- Dashboard read p95=0.8s → staff UX tốt
- Job create p95=0.7s → export nhanh
- Flow duration p95=3.2s → phù hợp với sleep 2s + API ~1.2s
- Sleep đúng 680×2=1360s → script chạy đúng
=> QUYẾT ĐỊNH: backoffice report system OK. Accept.
```

### Kịch bản B — dashboard chậm (DB/query issue): INVESTIGATE

```text
iterations................: 390  ← THẤP hơn kịch bản A (680)
http_req_failed...........: 0.00%
checks....................: 100%
constant_active_iterations_failed: 0

backoffice_report_dashboard:  avg=4.2s, p95=7.0s, count=390  ← CHẬM
backoffice_report_job_create: avg=0.5s, p95=0.8s, count=117
backoffice_report_job_status: avg=0.3s, p95=0.5s, count=117

constant_flow_duration_ms: avg=6250, p95=9200
constant_sleep_seconds: 780  (= 390 × 2s)
```

Kết luận thực tế:

```text
- VUs vẫn flat 6 → không phải lỗi test
- Nhưng iterations chỉ 390 (giảm 43% so với baseline 680)
- Dashboard avg=4.2s (chậm 8× so với baseline 0.5s)
- Flow duration tăng 2.4× → staff làm được ít việc hơn trong 5m
- Export job vẫn OK → vấn đề nằm ở dashboard read path
=> QUYẾT ĐỊNH: KHÔNG fail test vì iterations thấp.
   Đây là closed-model signal: dashboard query chậm.
   Điều tra: DB index? Query plan? Cache hit rate? gzip CPU?
```

### Kịch bản C — create accepted nhưng status issue (async worker): INSPECT WORKER

```text
iterations................: 640
http_req_failed...........: 0.00%
checks....................: 98.5%  ← THẤP
constant_active_iterations_failed: 18

backoffice_report_dashboard:  avg=0.6s, p95=1.0s, count=640  ✓ OK
backoffice_report_job_create: avg=0.4s, p95=0.7s, count=192  ✓ OK
backoffice_report_job_status: avg=4.5s, p95=10.0s, count=385  ← CHẬM + NHIỀU

  status_count / create_count = 385/192 = 2.0
  → Trung bình 2 lần poll mới done (thay vì 1)
  → READY_AFTER_MS có thể cao, hoặc worker xử lý chậm
```

Kết luận thực tế:

```text
- Dashboard vẫn OK → không phải DB/query issue
- Job create vẫn accepted 202 → API gateway OK
- Nhưng job status chậm và cần poll nhiều lần
- 18 loops failed → có thể do job không bao giờ "done" (timeout poll)
=> QUYẾT ĐỊNH: Điều tra async report worker.
   Worker có bị queue đầy không? Có bị crash/restart không?
   READY_AFTER_MS có bị set cao không?
   Poll interval có phù hợp không?
```

### Kịch bản D — high flow duration: TUNE PIPELINE

```text
iterations................: 350
http_req_failed...........: 0.50%
checks....................: 99.2%
constant_active_iterations_failed: 6

backoffice_report_dashboard:  avg=1.8s, p95=3.5s, count=350
backoffice_report_job_create: avg=2.5s, p95=6.0s, count=105
backoffice_report_job_status: avg=1.2s, p95=3.0s, count=210

constant_flow_duration_ms: avg=7800, p95=12000
  ← Flow duration p95 = 12s, quá cao cho 1 loop
```

Kết luận thực tế:

```text
- Tất cả operation đều chậm hơn baseline, không chỉ 1 operation
- Flow duration p95=12s: staff mất 12s cho 1 vòng (dashboard + đọc + optional export)
  → So với baseline 3.2s: chậm 3.75×
- Cả dashboard, create, status đều chậm → không phải 1 bottleneck
- Có thể: DB chung bị quá tải, network latency cao, hoặc resource contention
=> QUYẾT ĐỊNH: Điều tra toàn bộ report pipeline.
   Kiểm tra resource usage (CPU, memory, I/O) của report-service và DB.
   Có thể cần scale hoặc tune nhiều tầng.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| Tất cả operation p95 thấp, 0 fail | Backoffice steady use OK | Accept |
| Dashboard p95 cao, còn lại OK | Report query/gzip/DB issue | Investigate report dashboard query |
| Create accepted nhưng status chậm/poll nhiều | Async worker issue | Inspect worker/status path |
| Tất cả operation cùng chậm | Toàn bộ pipeline bottleneck | Tune report pipeline tổng thể |
| Iterations thấp hơn baseline nhưng VUs flat | Closed-model backpressure (backend chậm) | Điều tra latency, không fail test |
| http_req_failed > 0, checks < 100% | Có request fail thật sự | Block, điều tra error |
| constant_active_iterations_failed > 10 | Nhiều loop có business failure | Lọc theo user_id, operation |
| Sleep count không khớp iterations × 2s | Script không chạy đúng sleep | Kiểm script logic, branch |

## Real run — default constant-vus baseline after X-User-ID header

Run verify qua local cloud/dashboard sau khi k6 helper gửi `X-User-ID: ctx.userId`:

```text
Run ID: #86
Script: cv-06-backoffice-report-users.js
Exit code: 0
summary_pushed: true
finish_status: 200
Config: 6 VUs, duration 5m, default sleep/env
```

### Summary chính

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes/checks_fails` | `1,358 / 0` |
| `http_req_failed_rate` | `0` |
| `iterations` | `814` |
| `iterations_rate` | `2.69/s` |
| `http_reqs` | `1,358` |
| `http_reqs_rate` | `4.49/s` |
| `vus_min/vus_max` | `1 / 6` |
| `constant_flow_duration_ms avg/med/p95/p99/max` | `220.27 / 200 / 222.05 / 997.74 / 1,293 ms` |
| `http_req_duration avg/med/p95/p99/max` | `131.60 / 188.80 / 205.02 / 643.65 / 1,282.59 ms` |

Request breakdown:

```text
backoffice_report_dashboard GET 200 count=814
backoffice_report_job_create POST 202 count=272
backoffice_report_job_status GET 200 count=272
```

### Đọc 3 chart dashboard cho run #86

**Chart 1 — Response time.** `http_req_duration` p95 ~205.02ms; `constant_flow_duration_ms` p95 ~222.05ms. Dashboard/create/status đều 200/202 đúng contract.

**Chart 2 — Execution timeline.** `iterations` sum 814, `http_reqs` sum 1,358. Breakdown đúng script hiện tại: dashboard 814, create 272, status 272.

Dashboard/API bucket summary:

```text
iterations buckets: count=298, sum=814, min=1.00, max=6.00
http_reqs buckets:  count=298, sum=1358, min=1.00, max=10.00
không có failed iteration buckets
```

**Chart 3 — VUs vs iter/s.** Regular phase gần 6 VUs; min 1 là end-tail bucket. Không có failed iterations.

```text
vus buckets: count=302, min=1.00, max=6.00, avg=5.98
```

### Backend verdict

```text
PASS functional — report backoffice sạch trong run này.
```

Không báo functional bug. Lưu ý case hiện tại chỉ validate dashboard + create + status HTTP 200; chưa validate body `data.status == completed` và chưa download artifact.

## Nghịch lý và misconceptions của constant-vus

### Nghịch lý 1: "Chỉ 6 VU mà là performance test?"

```text
Nhiều người nghĩ: "Performance test phải 100-1000 VU. 6 VU thì test được gì?"

Sai. Performance test không đo bằng VU count — đo bằng RESOURCE PRESSURE.

6 VU với:
  - Dashboard query: 50MB data, JOIN 5 bảng, GROUP BY, gzip
  - Mỗi query: 1.5 CPU cores, 200MB RAM
  - 6 query đồng thời: 9 cores demand, 1.2GB RAM
  → DB CPU 100%, disk I/O saturated

100 VU với:
  - Product list query: 1KB data, index scan, cache hit
  - Mỗi query: 0.05 CPU cores, 5MB RAM
  - 100 query đồng thời: 5 cores demand, 500MB RAM
  → DB CPU 60%, còn dư

→ 6 VU backoffice STRESS hơn 100 VU storefront.
→ "Performance test" là test resource saturation, không phải test VU count.
```

### Nghịch lý 2: "iter/s rất thấp là bug?"

```text
Case 01 (storefront, 20 VU): iter/s ~20
Case 06 (backoffice, 6 VU):  iter/s ~2.3

"Case 06 iter/s thấp quá, có bug gì không?"

Không. iter/s thấp là do:
  1. sleep 2s (case 01 thường sleep 0.5s) → loop dài hơn 4×
  2. Dashboard query nặng hơn product list → API time dài hơn
  3. Chỉ 6 VU (case 01 có 20 VU) → ít VU hơn 3.3×

Công thức:
  iter/s = vus / loop_duration

  Case 01: 20 / 1.0s = 20 iter/s  (loop_duration 1.0s)
  Case 06:  6 / 2.65s = 2.26 iter/s (loop_duration 2.65s)

→ iter/s khác nhau vì BUSINESS SHAPE khác nhau.
→ Không so sánh iter/s giữa 2 case khác business.
→ iter/s chỉ có ý nghĩa khi so sánh CÙNG case, CÙNG config, KHÁC thời điểm.
```

### Nghịch lý 3: "Dashboard OK mà export fail?"

```text
"Checks pass, http_req_failed=0, dashboard p95=0.8s.
 Nhưng 18 loops failed (constant_active_iterations_failed=18).
 Sao dashboard OK mà loop fail?"

Vì loop fail không phải do HTTP request fail.
Mỗi loop gồm nhiều bước:
  1. Dashboard read (có thể pass)
  2. Export job create (có thể pass)
  3. Export job status poll (CÓ THỂ FAIL nếu job không bao giờ "done")

Loop fail khi:
  - Job được tạo (202) nhưng status không bao giờ về "done"
  - Poll loop hết maxPolls mà vẫn "processing"
  - Check "job done" fail

Trong khi http_req_failed=0 vì:
  - Tất cả HTTP request đều trả về 200/202
  - Không có connection error, timeout DNS
  - Nhưng business contract (job done) không đạt

→ Phải phân biệt "HTTP success" và "business success".
→ constant_active_iterations_failed đo business success, không phải HTTP success.
```

### Nghịch lý 4: "Tăng VUs lên 12 nhưng iter/s không tăng gấp đôi?"

```text
"VUs=6 → iter/s=2.3. VUs=12 → iter/s=3.8 (không phải 4.6).
 Sao không tăng gấp đôi?"

Vì throughput không tăng tuyến tính khi backend bị bão hòa:

  VUs=6:  6 / 2.65s = 2.26 iter/s, DB CPU ~90%
  VUs=12: Nếu dashboard query vẫn 0.5s → 12/2.65 = 4.53 iter/s
          NHƯNG: 12 query đồng thời, mỗi query 1.5 cores
          → 18 cores demand > 8 cores supply
          → Queue hình thành, dashboard latency tăng lên 3.0s
          → loop_duration = 3.0 + 2.0 + 0.15 = 5.15s
          → iter/s = 12 / 5.15 = 2.33 iter/s ← GẦN NHƯ KHÔNG TĂNG!

  → Thêm VU chỉ làm queue dài hơn, không tăng throughput.
  → Đây là dấu hiệu backend đã bão hòa.
  → Cần scale backend, không phải tăng VU.
```

## Checklist đọc biểu đồ case 06

Khi học sinh nhìn dashboard case 06, đọc theo thứ tự này:

```text
1. Overview KPI
   - constant_active_iterations_failed < 10?
   - http_req_failed < 1%?
   - checks > 99%?

2. Response time chart
   - Tách theo operation (dashboard, job_create, job_status) chưa?
   - Dashboard p95 có < 2s không?
   - Job create có chậm hơn dashboard không?
   - Job status count có >> job create count không (polling nhiều)?
   - Có operation nào p95 tăng dần theo thời gian không?

3. Execution timeline
   - Live VUs có = 6 suốt regular phase không?
   - iter/s có ổn định không (dao động nhẹ là bình thường)?
   - RPS có tương quan với iter/s không?
   - Cuối run VUs có dừng đột ngột (hết duration) không?

4. VUs vs iter/s
   - VUs có flat ở 6 không?
   - iter/s dao động quanh giá trị expected (~2.3 nếu backend khỏe)?
   - iter/s có giảm dần không (closed-model backpressure)?
   - sum iterations chart có ≈ summary iterations không?

5. Business decision
   - constant_active_iterations_failed = 0 hoặc rất thấp?
   - Dashboard latency chấp nhận được?
   - Export job create/status OK?
   - Flow duration phù hợp với sleep + API time?
```

Kết luận của run case 06 đang đúng nếu thấy:

```text
http_req_failed = 0% hoặc rất thấp
checks > 99%
constant_active_iterations_failed < 10
VUs flat = 6 suốt 5m
Dashboard p95 < 2s (tùy SLA team)
Job create p95 < 5s (tùy SLA team)
Flow duration p95 < 8s
Sleep seconds ≈ iterations × 2s
executor = constant-vus
```

## Mở rộng / variation

### Variation A: Thay đổi READY_AFTER_MS để quan sát async timing

```powershell
# Async job ready gần như ngay (default)
$env:CV_06_READY_AFTER_MS = 1
k6 run ...cv-06-backoffice-report-users.js
# Expected: status poll 1 lần, job done ngay

# Async job ready sau 500ms
$env:CV_06_READY_AFTER_MS = 500
k6 run ...cv-06-backoffice-report-users.js
# Expected: status poll 2-3 lần, flow duration tăng ~0.5s

# Async job ready sau 5s (stress test polling)
$env:CV_06_READY_AFTER_MS = 5000
k6 run ...cv-06-backoffice-report-users.js
# Expected: status poll 10+ lần, flow duration tăng ~5s
# Có thể thấy constant_active_iterations_failed tăng nếu maxPolls không đủ
```

Điều cần quan sát:

```text
- job_status count / job_create count ratio thay đổi theo READY_AFTER_MS
- Flow duration tăng tỉ lệ với READY_AFTER_MS
- iter/s giảm khi READY_AFTER_MS tăng
- Nếu READY_AFTER_MS quá cao + maxPolls thấp → failed loops
```

### Variation B: Thêm polling loop configurable

```js
// Thêm env vars để điều khiển polling behavior
const READY_AFTER_MS = parseInt(__ENV.CV_06_READY_AFTER_MS || "1");
const POLL_INTERVAL_MS = parseInt(__ENV.CV_06_POLL_INTERVAL_MS || "500");
const MAX_POLLS = parseInt(__ENV.CV_06_MAX_POLLS || "10");

// Trong export branch:
let polls = 0;
let jobDone = false;

while (!jobDone && polls < MAX_POLLS) {
  const statusRes = http.get(`${__ENV.BASE_URL}/api/sim/report/jobs/${jobId}`, {
    tags: { operation: "backoffice_report_job_status" },
  });

  if (statusRes.json("status") === "done") {
    jobDone = true;
    check(statusRes, { "job completed": (r) => r.status === 200 });
  } else {
    polls++;
    if (polls < MAX_POLLS) {
      sleep(POLL_INTERVAL_MS / 1000);
    }
  }
}

if (!jobDone) {
  // Job không done trong MAX_POLLS lần poll
  // → Đánh dấu loop failed
  console.warn(`Job ${jobId} not done after ${MAX_POLLS} polls`);
}
```

### Variation C: Tăng VUs để stress test report service

```powershell
# Baseline: 6 staff
$env:CV_06_VUS = 6
k6 run ...cv-06-backoffice-report-users.js

# Moderate load: 12 staff
$env:CV_06_VUS = 12
k6 run ...cv-06-backoffice-report-users.js

# High load: 20 staff
$env:CV_06_VUS = 20
k6 run ...cv-06-backoffice-report-users.js

# Stress: 30 staff
$env:CV_06_VUS = 30
k6 run ...cv-06-backoffice-report-users.js
```

Điều cần quan sát khi tăng VUs:

```text
- iter/s có tăng tuyến tính không? Nếu không → backend bão hòa
- Dashboard p95 có tăng không? Nếu có → DB queue
- constant_active_iterations_failed có tăng không? Nếu có → quá sức
- VUs có còn flat không? Nếu không → VU bị kẹt
```

### Variation D: Thêm threshold latency theo operation

```js
export const options = {
  thresholds: {
    // Functional (bắt buộc)
    "checks": ["rate>0.99"],
    "http_req_failed": ["rate<0.01"],
    "constant_active_iterations_failed": ["count<10"],

    // Performance (tùy team)
    "http_req_duration{operation:backoffice_report_dashboard}": ["p(95)<2000"],
    "http_req_duration{operation:backoffice_report_job_create}": ["p(95)<5000"],
    "http_req_duration{operation:backoffice_report_job_status}": ["p(95)<1000"],
    "constant_flow_duration_ms": ["p(95)<8000"],
  },
};
```

Chuyển từ functional test sang performance gate.

### Variation E: Tăng duration thành stability/soak test ngắn

```powershell
# Baseline: 5m observation
$env:CV_06_DURATION = "5m"
k6 run ...cv-06-backoffice-report-users.js

# Stability: 15m observation
$env:CV_06_DURATION = "15m"
k6 run ...cv-06-backoffice-report-users.js

# Soak test ngắn: 30m
$env:CV_06_DURATION = "30m"
k6 run ...cv-06-backoffice-report-users.js
```

Điều cần quan sát khi tăng duration:

```text
- Dashboard p95 có tăng dần theo thời gian không? (memory leak, connection pool cạn)
- iter/s có ổn định suốt 15-30m không? (degradation)
- constant_active_iterations_failed có tăng ở phút thứ 10+ không?
- DB CPU/memory có trend tăng không?
```

## Anti-pattern

- Dùng total `iterations` như pass/fail target cứng.
- Kỳ vọng fixed RPS từ `constant-vus`.
- So sánh 2 run có sleep/duration/VUs khác nhau rồi kết luận backend regress.
- Chỉ nhìn aggregate p95 trong flow nhiều operation.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với per-user quota của `per-vu-iterations`.
- Nghĩ "chỉ 6 VU nên không phải performance test".
- Dùng `constant-arrival-rate` rồi thắc mắc tại sao drop/interrupt không phân biệt được với backend fail.
- So sánh iter/s của case 06 với case 01 (khác business shape).
- Không tách operation tag — để aggregate che mất job create/status latency.
- Không check READY_AFTER_MS khi so sánh flow duration giữa 2 run.
- Polling vô hạn không có maxPolls → loop treo nếu worker không bao giờ done.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Constant-vus quick index: `../../20260516_01_constant-vus-quick-index.md`
- Tham số/công thức: `../../20260516_02_constant-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-06-backoffice-report-users.js`
