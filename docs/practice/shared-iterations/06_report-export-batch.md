# Case 06: Report export batch

## Tình huống thực tế

Team report/data cần verify một batch export jobs: tạo report, kiểm tra status, rồi download artifact. Đây là flow lifecycle, không phải một request đơn lẻ.

Nếu chỉ create job thành công nhưng status/download fail, user vẫn không lấy được report. Vì vậy job chỉ pass khi full lifecycle pass.

Case này trả lời: 6 workers có xử lý đủ 60 report lifecycle jobs không, và mỗi job có đủ create/status/download không?

Tóm tắt đời thường:

```text
Trigger: nightly report export, migration report service, storage pipeline change, hoặc regression cho report worker
Backlog: 60 report export lifecycle jobs
Risk nếu skip job: report accepted nhưng không generated/download được, hoặc artifact path bị lỗi
```

Case này **không** cố gắng trả lời "production traffic giống thật chưa?". Nó trả lời câu hỏi batch/ops cụ thể hơn:

```text
Có xử lý đủ fixed backlog không?
Mỗi job có đi đúng business flow không?
Có job nào fail không?
```

### Vì sao "report export lifecycle batch" buộc chọn shared-iterations?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của report export batch trước:

```text
Report export batch = "duyệt qua TỪNG report job trong danh sách cố định,
                       POST create -> nhận job_id,
                       GET status (poll đến khi ready),
                       GET download artifact,
                       xác nhận cả 3 đều pass"

Đời thường:
  Văn phòng có 60 báo cáo cần xuất (= 60 jobs)
  6 nhân viên (= 6 VU)
  Mỗi báo cáo cần: tạo yêu cầu (= create) + chờ in (= status poll) + lấy bản in (= download)
  Nhân viên nào xong báo cáo trước thì lấy báo cáo tiếp theo
  Kết thúc khi TẤT CẢ 60 báo cáo đã được xuất và lấy về
```

Để report export batch **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ shared-iterations mới thỏa mãn cả 2.

#### Yêu cầu (a): EXACT TOTAL COVERAGE (không thiếu job nào)

**Ý nghĩa**: Phải export ĐỦ 60 report jobs. Thiếu 1 job là coverage incomplete — job đó có thể bị fail âm thầm mà không ai biết.

**Ví dụ cụ thể**:

```text
Scenario: team deploy report-service mới, cần verify 60 report lifecycle jobs

Trường hợp A (coverage ĐỦ):
  Export 60 jobs, tất cả create + status + download pass
  → Kết luận: report pipeline OK, mọi job đều sinh artifact đầy đủ

Trường hợp B (coverage THIẾU - bug):
  Export 42 jobs (thiếu 18), 42 jobs đã export đều pass
  → Tưởng OK, nhưng 18 jobs chưa export có thể đang lỗi ở async pipeline
  → Production: user request report trong 18 jobs đó -> pending mãi không có artifact
  → KHÔNG kết luận được, test không có giá trị
```

**Vì sao total iterations phải chính xác 60?**

```text
Nếu total phụ thuộc duration:
  - duration cố định 30s
  - latency thấp  → export được 60 jobs (đủ)
  - latency cao   → export được 42 jobs (thiếu 18)
  - latency tăng do async pipeline chậm, không phải do ít job hơn
  → Mỗi lần test số job export được khác → không biết coverage có đủ không
```

**Phân tích sâu: vì sao 2 executor "duration-based" không đảm bảo count?**

`constant-vus` với `duration: "30s"`:

```text
Công thức count khi chạy:
  count_jobs = duration × throughput
             = 30s × (vus / iter_time)
             = 30s × (6 / iter_time)
             = 180 / iter_time

iter_time KHÔNG cố định, biến thiên do:
  - HTTP latency của từng API call (create, status, download)
  - Async readiness delay (READY_AFTER_MS mô phỏng thời gian generate)
  - Download artifact size (gzip_kb)
  - Network variability giữa các API calls

Ví dụ thực tế chạy 3 lần liên tiếp cùng config:
  Lần 1: server vừa restart, cache cold, READY_AFTER_MS hoạt động bình thường
    iter_time avg = 0.50s -> count = 180/0.50 = 360 jobs export
    (dư! export nhiều hơn 60, nhưng có thể export lặp job đầu, thiếu job cuối)
  Lần 2: async pipeline đặc biệt nhanh (cache warm)
    iter_time avg = 0.30s -> count = 180/0.30 = 600 jobs export
  Lần 3: async pipeline chậm (report worker backlog)
    iter_time avg = 0.90s -> count = 180/0.90 = 200 jobs export

  Vấn đề KHÔNG chỉ là count khác nhau.
  Vấn đề LỚN HƠN: không biết 60 jobs có được export ĐỦ không.
  360 jobs có thể = export lặp 30 jobs đầu × 12 lần, bỏ sót 30 jobs cuối.
```

**Điểm khác biệt với case 01 (catalog audit) — async làm duration-based còn tệ hơn**:

```text
Trong catalog audit (case 01), mỗi job là synchronous: 2 API calls, latency ổn định.
Trong report export (case 06), mỗi job là ASYNCHRONOUS: 3 API calls + wait time.

Async có thêm biến số:
  - READY_AFTER_MS: thời gian chờ report được generate (mô phỏng delay)
  - Status poll: có thể cần poll nhiều lần nếu report chưa ready
  - Download time: artifact size ảnh hưởng download duration

→ iter_time dao động MẠNH HƠN case 01
→ duration-based executor càng không可靠 cho async batch
→ count biến thiên còn lớn hơn nữa
```

`constant-arrival-rate` với `rate: 3/s, duration: "25s"`:

```text
Mục tiêu config: "3 job/s × 25s = 75 jobs TOTAL"
→ Dư so với 60 jobs cần export. Nhưng...

KHÔNG đảm bảo đạt 75 vì có thể DROP slot:
  - Khi rate target > năng lực VU pool
  - Khi async pipeline chậm bất thường (report worker quá tải)
  - Khi spawn VU không kịp lúc đầu
  - Khi status poll kéo dài (report chưa ready, VU bị kẹt)

Công thức thực tế:
  N_done = N_sched - N_drop - N_int
         = 75 - N_drop - N_int

Ví dụ thực tế:
  Lần 1: pool vừa khít, async pipeline nhanh
    N_drop = 0, N_done = 75 (dư 15 so với 60, export lặp)
  Lần 2: async pipeline có 10s chậm ở giữa (report worker stall)
    N_drop = 25, N_done = 50 (thiếu 10 jobs!)
  Lần 3: READY_AFTER_MS lớn hơn bình thường
    N_drop = 20, N_int = 5, N_done = 50 (thiếu 10 jobs)

  KHÔNG可靠: lần được lần không, không biết trước
```

**Trong khi đó với `shared-iterations`**:

```text
Config: vus=6, iterations=60
N_done = 60 (TUYỆT ĐỐI, nếu không bị maxDuration cắt)

Lần 1: async pipeline nhanh -> 60 jobs, T_run=18s, shared_job_duration_ms p95=0.8s
Lần 2: async pipeline chậm -> 60 jobs, T_run=35s, shared_job_duration_ms p95=2.1s
Lần 3: async pipeline bình thường -> 60 jobs, T_run=24s, shared_job_duration_ms p95=1.2s

Count CỐ ĐỊNH ở 60 mỗi lần.
Chỉ có T_run + latency thay đổi -> đó CHÍNH LÀ cái cần đo!

→ 60 jobs luôn được export đủ → coverage guarantee
→ Nếu latency tăng, T_run tăng → phát hiện được async pipeline regression
→ Nếu shared_job_duration_ms tăng → phát hiện được report worker chậm
```

**Tóm tắt 3 executor về count**:

| Executor | Count formula | Count cố định? | Job coverage guarantee? |
| --- | --- | --- | --- |
| **shared-iterations** | `iterations` | CÓ (tuyệt đối) | CÓ (nếu identity map đúng) |
| constant-vus (duration) | `duration × vus / iter_time` | KHÔNG (do iter_time) | KHÔNG (có thể export lặp hoặc thiếu) |
| constant-arrival-rate | `N_sched - N_drop - N_int` | KHÔNG (do drop/int) | KHÔNG (drop có thể bỏ sót job) |

→ COUNT phải CHÍNH XÁC, KHÔNG phụ thuộc latency
→ Chỉ executor đếm theo "iterations cố định" mới đạt
→ Nhưng count đủ chưa đủ — còn cần identity map ĐÚNG (yêu cầu b)

#### Yêu cầu (b): CORRECT IDENTITY MAPPING (mỗi job map đúng 1 report, job_id local)

**Ý nghĩa**: 60 iteration phải map sang 60 report jobs KHÁC NHAU. Mỗi job tạo ra `job_id` riêng từ API create, và `job_id` đó chỉ thuộc về iteration đó.

**Bug identity mapping là gì?**

```text
Trường hợp ĐÚNG — identity từ iterationInTest:
  iter #0  -> create report job #0, nhận job_id (vd: "job-abc-000")
            -> status check job-abc-000 -> download artifact
  iter #1  -> create report job #1, nhận job_id (vd: "job-abc-001")
            -> status check job-abc-001 -> download artifact
  iter #2  -> create report job #2, nhận job_id (vd: "job-abc-002")
  ...
  iter #59 -> create report job #59
  → 60 jobs unique được export ✓

Trường hợp SAI — identity từ __VU:
  VU=1: __VU=1 -> luôn tạo report cùng pattern (lặp lại 15 lần)
  VU=2: __VU=2 -> luôn tạo report cùng pattern (lặp lại 12 lần)
  ...
  VU=6: __VU=6 -> luôn tạo report cùng pattern (lặp lại 6 lần)
  → Chỉ 6 unique report types được export (lặp đi lặp lại)
  → 54 report types còn lại KHÔNG BAO GIỜ được export
  → Dù iterations = 60, coverage thật chỉ = 6/60 = 10%
```

**Bug job_id state leakage (đặc thù case async)**:

```text
Trường hợp SAI — lưu job_id vào worker-level state:
  export default function () {
    // SAI: lưu job_id vào biến ngoài function, shared giữa các iter của cùng VU
    if (!workerState.jobId) {
      workerState.jobId = createReport();  // chỉ create lần đầu
    }
    checkStatus(workerState.jobId);  // dùng lại job_id cũ
    downloadReport(workerState.jobId);
  }
  
  VU=1:
    iter #0: create job A, check A, download A ✓
    iter #1: KHÔNG create nữa, vẫn check A, download A (lặp!)
    iter #2: vẫn check A, download A (lặp!)
    → Chỉ 1 job được tạo, nhưng status/download lặp 10 lần trên cùng 1 job
    → http_reqs = 1×create + 10×status + 10×download = 21 (cho VU=1)
    → Tổng http_reqs vẫn có thể gần 180, nhưng chỉ 6 jobs thực sự được tạo!
```

**3 nguyên nhân kỹ thuật của bug identity mapping**:

### Nguyên nhân 1: REPORT COVERAGE GAP (thiếu job do duration-based test)

**Vấn đề**: Duration-based test dừng sau một khoảng thời gian, không theo số job. Với async pipeline, latency biến thiên mạnh, số job export được càng không ổn định.

```text
Tưởng tượng văn phòng 60 báo cáo cần xuất:
  - 6 nhân viên xuất báo cáo, mỗi báo cáo mất ~0.5s để tạo + chờ in + lấy
  - Sếp đặt đồng hồ 30s -> hết 30s dừng, bất kể còn báo cáo chưa xuất

  Ngày thường (async pipeline nhanh, READY_AFTER_MS=1ms):
    6 nhân viên × 30s / 0.5s = 360 báo cáo (dư, nhưng export lặp báo cáo đầu)
    → Nếu map identity SAI, export lặp 6 báo cáo đầu × 60 lần
    → 54 báo cáo cuối chưa từng được đụng tới

  Ngày chậm (report worker quá tải, READY_AFTER_MS=500ms):
    6 nhân viên × 30s / 1.5s = 120 báo cáo
    → Vẫn có thể export lặp, bỏ sót báo cáo cuối
```

**Demo cụ thể: constant-vus duration=30s, vus=6**

Giả sử mỗi iter mất 0.6s, code dùng `__VU` làm identity (SAI):

```text
VU=1 (nhanh nhất, network tốt): iter_time=0.3s
  → 30s / 0.3s = 100 iter
  → Luôn export report type #1, lặp 100 lần

VU=6 (chậm nhất, async pipeline chậm): iter_time=1.2s
  → 30s / 1.2s = 25 iter
  → Luôn export report type #6, lặp 25 lần

Tổng: 100+...+25 ≈ 350 iterations
Nhưng chỉ 6 report types unique được export
→ Coverage thật = 6/60 = 10%
→ 54 report types bỏ sót, dù test "pass" với 350 iter
```

**Demo với code đúng (identity từ iterationInTest) nhưng vẫn duration-based**:

```text
Vấn đề khác: không biết khi nào đã export đủ 60 jobs

constant-vus duration=30s:
  iter #0-#59: export report #0-#59 (đủ 60)
  iter #60-#349: export tiếp report #0-#59 (lặp lại, dư)
  → Lãng phí, nhưng ít nhất 60 jobs đã được export

constant-vus duration=5s (quá ngắn):
  iter #0-#24: export report #0-#24 (chỉ 25 jobs)
  → Thiếu 35 jobs, coverage không đủ
  → Nhưng test vẫn "pass" nếu chỉ nhìn http_req_failed=0

SO SÁNH VỚI shared-iterations:
  iterations=60
  iter #0-#59: export report #0-#59 (đủ 60, DỪNG)
  → Không dư, không thiếu, coverage chính xác
```

**Cách phát hiện**: so sánh `iterations` count với expected `JOBS`. Nếu `iterations < JOBS` → coverage incomplete. Nếu `iterations > JOBS` và identity từ `__VU` → export lặp.

### Nguyên nhân 2: WRONG IDENTITY MAPPING (dùng `__VU` thay vì `iterationInTest`)

Đây là lỗi phổ biến nhất khi chuyển từ per-vu-iterations sang shared-iterations.

**`__VU` là gì trong shared-iterations?** `__VU` là **worker ID** — định danh VU nào đang xử lý job hiện tại. Nó không phải business identity.

**`exec.scenario.iterationInTest` là gì?** Là **global job index** — số thứ tự iteration trong toàn scenario, từ 0 đến iterations-1.

```text
So sánh 2 cách map identity:

Cách A — SAI: dùng __VU
  const reportType = reportTypes[__VU - 1];  // VU=1 -> reportTypes[0], VU=2 -> reportTypes[1], ...
  
  VU=1: __VU=1 -> luôn export reportTypes[0] (lặp ~15 lần)
  VU=2: __VU=2 -> luôn export reportTypes[1] (lặp ~12 lần)
  ...
  VU=6: __VU=6 -> luôn export reportTypes[5] (lặp ~6 lần)
  → 6 report types unique, 54 report types bỏ sót

Cách B — ĐÚNG: dùng exec.scenario.iterationInTest
  const reportType = reportTypes[exec.scenario.iterationInTest];  // iter #0 -> reportTypes[0], ...
  
  iter #0  -> reportTypes[0]  (do VU nào cũng được)
  iter #1  -> reportTypes[1]
  iter #2  -> reportTypes[2]
  ...
  iter #59 -> reportTypes[59]
  → 60 report types unique, coverage đủ
```

**Demo trace 6 VU × 60 iter với identity đúng**:

```text
t=0.0s   6 VU cùng start
         VU=1 lấy iterInTest=0  -> export report #0 (create -> status -> download)
         VU=2 lấy iterInTest=1  -> export report #1
         VU=3 lấy iterInTest=2  -> export report #2
         ...
         VU=6 lấy iterInTest=5  -> export report #5

t=0.6s   VU=1 xong iter #0 (cả create+status+download), lấy iterInTest=6  -> export report #6
         VU=3 xong iter #2, lấy iterInTest=7  -> export report #7
         ...

t=7.0s   iterInTest=59 được lấy -> export report #59 (report cuối!)
         60/60 jobs complete -> scenario dừng

Kết quả: 60 unique report jobs được export, mỗi job đúng 1 lần ✓
```

**Demo trace 6 VU × 60 iter với identity SAI (dùng __VU)**:

```text
t=0.0s   VU=1: __VU=1 -> report #1 (lần 1)
         VU=2: __VU=2 -> report #2 (lần 1)
         ...

t=0.6s   VU=1: __VU=1 -> report #1 (lần 2)  ← lặp!
         VU=3: __VU=3 -> report #3 (lần 1)
         ...

t=7.0s   60 iter hoàn thành
         report #1: export 15 lần
         report #2: export 12 lần
         report #3: export 10 lần
         ...
         report #6: export 6 lần
         report #7-#60: export 0 lần ← 54 reports bỏ sót!

Kết quả: 60 iter, nhưng coverage thật = 6/60 = 10% ❌
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

Code đúng cho shared-iterations:
  const reportIndex = exec.scenario.iterationInTest;  // 0..59
  const reportType = reportTypes[reportIndex];
  // KHÔNG: const reportType = reportTypes[__VU - 1];
```

### Nguyên nhân 3: ASYNC LIFECYCLE INCOMPLETENESS (create pass nhưng status/download fail)

**Vấn đề**: Một report export job chỉ hoàn tất khi **cả** create, status, và download đều pass. Create trả về 202 (accepted) nhưng chưa chứng minh report đã được generate và artifact có thể download. Đây là khác biệt cốt lõi với case 01-05 (sync flow).

```text
Flow mỗi job:
  1. POST /api/sim/report/jobs?...        (create)   → expect 202
  2. GET  /api/sim/report/jobs/:id?...     (status)   → expect 200
  3. GET  /api/sim/report/jobs/:id/download?... (download) → expect 200

KHÁC BIỆT VỚI CASE 01:
  Case 01 (catalog audit): list endpoint + detail endpoint, cả 2 đều độc lập
  Case 06 (report export): các operation CÓ THỨ TỰ và PHỤ THUỘC
    - Không thể status nếu chưa create (cần job_id)
    - Không thể download nếu status chưa ready
    - Status có thể cần poll nhiều lần nếu report chưa generated

Nếu report worker bị lỗi (crash, queue full, storage unavailable):
  - Create vẫn pass 60/60 (202 accepted, job vào queue)
  - Status fail 15/60 (report không được generate, worker không chạy)
  - Download fail 15/60 (không có artifact để download)

Nếu chỉ nhìn http_reqs = 180:
  → 60 create + 60 status + 60 download = 180 request đã gửi
  → nhưng 15 status fail (timeout/500) và 15 download fail (404/500)
  → http_req_failed = 30/180 = 16.7%
  → Có vẻ "hơi fail", nhưng...

Nếu tách theo operation:
  report_job_create:   60/60 pass (100%)
  report_job_status:   45/60 pass (75%), 15 fail
  report_job_download: 45/60 pass (75%), 15 fail
  → 15 jobs: create OK nhưng async pipeline LỖI
  → Nguy hiểm: user thấy report "đang xử lý" nhưng không bao giờ có artifact
```

**Demo trace async lifecycle incompleteness**:

```text
Backend state: report worker bị crash sau khi xử lý 45 jobs
(hoặc storage service unavailable cho 15 jobs cuối)

Run report export 60 jobs:
  Job #0:  create=202, status=200, download=200  ✓
  Job #1:  create=202, status=200, download=200  ✓
  ...
  Job #44: create=202, status=200, download=200  ✓ (job cuối cùng OK)
  Job #45: create=202, status=PENDING (timeout)  ← WORKER CRASH, report không generate
  ...
  Job #59: create=202, status=PENDING (timeout)  ← 15 jobs bị kẹt

Tổng kết nếu CHỈ nhìn http_reqs:
  http_reqs = 180 (60+60+60)
  http_req_failed = 15/180 = 8.3% (chỉ 15 status fail)
  → Dễ bị bỏ qua nếu threshold http_req_failed < 10%

Tổng kết nếu tách operation:
  report_job_create:   60 pass, 0 fail
  report_job_status:   45 pass, 15 fail/timeout
  report_job_download: 45 pass, 15 fail/404
  → 15 jobs async pipeline broken → REPORT EXPORT FAIL
  → Phải route theo job_id để tìm chính xác job nào lỗi
```

**Cách phát hiện**: luôn tách metric theo tag `operation`. Không chỉ check `http_req_failed` tổng. Nếu `report_job_status` count < 60 → async pipeline chưa verify hết. Nếu `report_job_download` count < 60 → artifact coverage incomplete. Sự chênh lệch giữa create count và status/download count là tín hiệu async pipeline broken.

### Nguyên nhân 4: WORKER SKEW IS EXPECTED AND AMPLIFIED BY ASYNC (phân phối không đều, async làm lệch thêm)

**Vấn đề**: Với shared-iterations, VU nhanh sẽ lấy nhiều job hơn VU chậm. Đây là **feature**, không phải bug. Nhưng với async pipeline, skew còn mạnh hơn vì thời gian hoàn thành mỗi job dao động lớn hơn sync flow.

```text
Tưởng tượng 6 nhân viên xuất 60 báo cáo:
  - Nhân viên A (nhanh, report đơn giản, async pipeline nhanh): 0.4s/job -> làm được 22 jobs
  - Nhân viên B (bình thường): 0.6s/job -> làm được 13 jobs
  - Nhân viên F (chậm, report phức tạp, async pipeline chậm): 1.5s/job -> làm được 3 jobs

  Tổng: 22+13+...+3 = 60 jobs ✓
  Phân phối: không đều, nhưng TẤT CẢ báo cáo đã được xuất

  Người quản lý KHÔNG nói: "Nhân viên F làm ít quá, test fail"
  Người quản lý NÓI: "60/60 báo cáo đã xuất xong, test pass"
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

**Demo trace worker skew với 4 VU, 16 iter, tốc độ khác nhau (có async delay)**:

```text
Config: vus=4, iterations=16
  VU=1: iter_time=0.3s (nhanh — async pipeline nhanh, READY_AFTER_MS nhỏ)
  VU=2: iter_time=0.5s
  VU=3: iter_time=0.9s (chậm — async pipeline chậm, status poll nhiều lần)
  VU=4: iter_time=0.9s (chậm)

Timeline:
t=0.0s   4 VU start, cùng lấy iter đầu
         VU=1: iterInTest=0,  create+status+download (0.3s)
         VU=2: iterInTest=1,  create+status+download (0.5s)
         VU=3: iterInTest=2,  create+status+download (0.9s)
         VU=4: iterInTest=3,  create+status+download (0.9s)

t=0.3s   VU=1 xong, lấy iterInTest=4,  create+status+download (0.3s)
t=0.5s   VU=2 xong, lấy iterInTest=5,  create+status+download (0.5s)
t=0.6s   VU=1 xong, lấy iterInTest=6,  create+status+download (0.3s)
t=0.9s   VU=1 xong, lấy iterInTest=7,  create+status+download (0.3s)
         VU=3 xong, lấy iterInTest=8,  create+status+download (0.9s)
         VU=4 xong, lấy iterInTest=9,  create+status+download (0.9s)
t=1.0s   VU=2 xong, lấy iterInTest=10, create+status+download (0.5s)
...

Kết quả cuối:
  VU=1: 8 iter  (nhanh nhất -> nhiều nhất)
  VU=2: 4 iter
  VU=3: 2 iter
  VU=4: 2 iter  (chậm nhất -> ít nhất)
  Tổng: 16 iter ✓

Phân phối: 8-4-2-2 (lệch nặng)
Nhưng tổng = 16 = config → PASS ✓
Không ai fail test vì VU=4 chỉ làm 2 job.
```

**Vì sao async làm skew mạnh hơn sync?**

```text
Trong sync flow (case 01 catalog audit):
  iter_time chủ yếu do HTTP latency của 2 API calls
  → latency biến thiên ít, skew vừa phải

Trong async flow (case 06 report export):
  iter_time = create_latency + status_latency + download_latency + async_wait
  → async_wait (READY_AFTER_MS) có thể dao động mạnh giữa các job
  → Nếu READY_AFTER_MS biến thiên (vd: 1ms-500ms), skew còn lớn hơn
  → Một VU có thể bị kẹt chờ report generate trong khi VU khác đã xong 3 jobs

Hệ quả thực tế:
  Case 01: VU nhanh nhất / VU chậm nhất ≈ 2-3x
  Case 06: VU nhanh nhất / VU chậm nhất ≈ 5-8x (async amplification)
```

**So sánh với per-vu-iterations (nơi phân phối đều là REQUIREMENT)**:

| Tiêu chí | shared-iterations | per-vu-iterations |
| --- | --- | --- |
| Phân phối job | Không đều (first-come-first-served) | Đều tuyệt đối (mỗi VU = N iter) |
| VU nhanh xong sớm | Lấy thêm job | IDLE (không cướp việc VU khác) |
| Pass criteria | Tổng job = config | Tổng job = config VÀ mỗi VU = N iter |
| Khi nào fail vì phân phối? | Không bao giờ | Nếu VU nào không đủ N iter |
| Async amplification | Skew mạnh hơn, nhưng vẫn đúng | VU chậm kẹt cả pool (idle resource) |

**Cách phát hiện**: nếu learner fail test vì "VU distribution không đều", giải thích lại mental model worker pool. Invariant là `sum(iterations_per_vu) == JOBS`, không phải `iterations_per_vu == JOBS / vus`.

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
   - Report team có danh sách 60 report jobs cần export
   - Không phải "export trong 5 phút", mà là "export ĐỦ 60 jobs"
   → iterations = 60 (tổng job toàn scenario)
   → KHÔNG dùng duration làm input chính

2. WORKER POOL SIZE (số worker cùng xử lý):
   - 6 worker cùng export để xong nhanh hơn
   - Không quan trọng worker nào làm bao nhiêu, miễn tổng đủ
   → vus = 6 (số worker)
   → KHÔNG cần mỗi VU export đúng 10 jobs

3. ASYNC LIFECYCLE COMPLETENESS (mỗi job đi qua đủ flow):
   - Mỗi job: create + status + download = 3 API calls
   - 60 jobs × 3 API = 180 total API calls
   → http_reqs = 180 (deterministic, nếu không fail)
   → shared_api_calls_total = 180
   - QUAN TRỌNG: 3 operation PHẢI có thứ tự, không thể skip bước nào
```

## Yêu cầu cứng của case này

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Tổng completed iterations phải bằng `60` | Vì `60` là kích thước backlog, thiếu 1 job là coverage incomplete. |
| `shared_jobs_total == 60` | Iteration chạy xong chưa đủ; job phải được mark hoàn tất end-to-end. |
| `shared_jobs_failed == 0` | Có failed job nghĩa là business contract không đạt. |
| `http_reqs/shared_api_calls_total == 60 × 3 = 180` | Mỗi job phải gọi đúng số API trong flow. |
| Operation counts phải khớp expected breakdown | Tổng HTTP đúng nhưng thiếu một operation vẫn là coverage bug. |
| Job identity phải derive từ `exec.scenario.iterationInTest` | Worker identity `__VU` không đại diện cho business job. |
| `job_id` từ API create phải local cho iteration đó | Không lưu vào worker-level state, không reuse giữa các iter. |
| Uneven per-VU distribution is normal | Worker nhanh xử lý nhiều job hơn là đúng mô hình shared pool. |
| `shared_job_duration_ms` là metric chính, không phải `http_req_duration` | User quan tâm full lifecycle, không phải từng API call. |

Nếu một trong các invariant về count/job fail, kết quả nên coi là **invalid hoặc fail**, không phải "pass nhưng hơi thiếu".

## Vì sao "report export lifecycle batch" nên dùng `shared-iterations`?

Mental model đúng:

```text
60 jobs đang nằm trong một queue/backlog.
6 VUs là 6 workers.
Worker nào rảnh thì lấy job kế tiếp.
Mỗi job: create report -> poll status -> download artifact.
Batch kết thúc khi queue hết job.
```

Nếu worker A xử lý 20 job còn worker B xử lý 8 job, điều đó không làm test sai. Nó chỉ nói worker A nhận được nhiều job hơn vì vòng lặp của nó quay lại sớm hơn.

### Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho fixed backlog? |
| --- | --- | --- |
| `shared-iterations` | Có tổng `iterations` chung và nhiều VU cùng chạy | **Đúng**: mô hình đúng là N job trong backlog, M worker xử lý đến khi hết việc. |
| `per-vu-iterations` | Count cũng deterministic | Sai nếu VU không phải business identity. Nó ép mỗi VU làm quota bằng nhau, không giống worker queue. |
| `constant-vus` | Nhìn giống worker pool | Sai khi cần exact count: tổng việc phụ thuộc duration và latency, không bảo đảm xử lý đúng N job. Đặc biệt tệ với async pipeline vì iter_time dao động mạnh. |
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
| `SI_06_VUS` | 6 | Số worker cùng xử lý backlog |
| `SI_06_JOBS` | 60 | Tổng số job toàn scenario |
| `SI_06_READY_AFTER_MS` | 1 | Case-specific: async readiness delay (mô phỏng thời gian report generate) |
| `maxDuration` | 12m | Safety cap, không phải target duration |
| `executor` | `shared-iterations` | Fixed global backlog + worker pool |

Mapping quan trọng:

```text
business backlog size = 60 jobs
k6 iterations         = 60
worker pool size      = 6 VUs
expected API calls    = 60 × 3 = 180
async readiness delay = SI_06_READY_AFTER_MS (mô phỏng report generation time)
```

`maxDuration` chỉ là safety cap. Nếu cap này cắt run làm `iterations < 60`, kết quả không valid vì backlog chưa drain hết.

`SI_06_READY_AFTER_MS` là tham số đặc thù của case async này. Nó mô phỏng độ trễ giữa lúc job được accepted (create 202) và lúc report thực sự được generate (status ready). Giá trị mặc định 1ms để test nhanh, nhưng có thể tăng lên để mô phỏng async pipeline thực tế.

Operation coverage expected:

```text
report_job_create: 60
report_job_status: 60
report_job_download: 60
```

## Technical semantics: shared backlog, worker pool, job identity

Cách k6 vận hành nên được hiểu như sau:

```text
1. Scenario có một global quota: iterations = 60.
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
  - KHÔNG dùng làm report ID, report type index, hay job_id

__ITER:
  - Local counter của từng VU, bắt đầu từ 0
  - VU=1: __ITER=0 → iter #0, __ITER=1 → iter #3, __ITER=2 → iter #7...
  - KHÔNG phải global job index
  - VU=1 __ITER=4 và VU=2 __ITER=4 là 2 job KHÁC NHAU

exec.scenario.iterationInTest:
  - Global job index, từ 0 đến iterations-1
  - DUY NHẤT cho mỗi iteration trong toàn scenario
  - Dùng làm business identity: report type index, report job index...
  
ĐẶC THÙ CASE 06 — job_id từ API create:
  - job_id được trả về từ POST create
  - job_id là server-generated, KHÔNG derive từ iterationInTest
  - Nhưng iterationInTest quyết định report_type nào được request
  - job_id phải được lưu CỤC BỘ trong iteration (biến local)
  - KHÔNG lưu job_id vào biến global/worker-level
```

**Demo trace identity model với 3 VU, 10 iter (có job_id cục bộ)**:

```text
Config: vus=3, iterations=10

t=0.0s   VU=1: __VU=1, __ITER=0, iterationInTest=0  -> job #0
           create report type #0 -> nhận job_id="rpt-000"
           status check "rpt-000" -> download "rpt-000"
         VU=2: __VU=2, __ITER=0, iterationInTest=1  -> job #1
           create report type #1 -> nhận job_id="rpt-001"
           status check "rpt-001" -> download "rpt-001"
         VU=3: __VU=3, __ITER=0, iterationInTest=2  -> job #2
           create report type #2 -> nhận job_id="rpt-002"

t=0.4s   VU=1 xong, lấy tiếp:
         VU=1: __VU=1, __ITER=1, iterationInTest=3  -> job #3
           create report type #3 -> nhận job_id="rpt-003"
           (KHÔNG dùng lại "rpt-000"!)

t=0.6s   VU=2 xong, lấy tiếp:
         VU=2: __VU=2, __ITER=1, iterationInTest=4  -> job #4
           create report type #4 -> nhận job_id="rpt-004"

... tiếp tục đến iterationInTest=9 (job #9)

Tổng kết:
  VU=1 (nhanh): __ITER=0..4 (5 jobs), các iterationInTest=0,3,5,7,9
  VU=2 (vừa):   __ITER=0..2 (3 jobs), các iterationInTest=1,4,8
  VU=3 (chậm):  __ITER=0..1 (2 jobs), các iterationInTest=2,6
  Total: 5+3+2 = 10 jobs ✓

Mỗi job có job_id RIÊNG, không trùng, không reuse ✓
```

### Code pattern đúng cho shared-iterations với async lifecycle

```js
import exec from "k6/execution";
import { check } from "k6";
import http from "k6/http";

const REPORT_TYPES = [
  "inventory_summary", "sales_daily", "user_activity",
  "revenue_monthly", "product_performance", "customer_retention",
  // ... đủ 60 report types
];

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";
const READY_AFTER_MS = __ENV.SI_06_READY_AFTER_MS || 1;

export default function () {
  // Lấy global job index — ĐÂY LÀ DÒNG QUAN TRỌNG NHẤT
  const jobIndex = exec.scenario.iterationInTest;  // 0..59
  const reportType = REPORT_TYPES[jobIndex];

  // ===== BƯỚC 1: CREATE REPORT JOB =====
  const createUrl = `${BASE_URL}/api/sim/report/jobs?report_type=${reportType}&cpu_ms=2&db_rows=2&gzip_kb=4&ready_after_ms=${READY_AFTER_MS}`;
  const createRes = http.post(createUrl);
  
  check(createRes, {
    "create accepted 202": (r) => r.status === 202,
  });

  // Lấy job_id từ response — LOCAL cho iteration này
  const jobId = createRes.json().job_id;

  // ===== BƯỚC 2: CHECK JOB STATUS =====
  const statusUrl = `${BASE_URL}/api/sim/report/jobs/${jobId}?cpu_ms=1&db_rows=1`;
  const statusRes = http.get(statusUrl, {
    tags: { operation: "report_job_status" },
  });
  
  check(statusRes, {
    "status 200": (r) => r.status === 200,
  });

  // ===== BƯỚC 3: DOWNLOAD ARTIFACT =====
  const downloadUrl = `${BASE_URL}/api/sim/report/jobs/${jobId}/download?cpu_ms=1&gzip_kb=4`;
  const downloadRes = http.get(downloadUrl, {
    tags: { operation: "report_job_download" },
  });
  
  check(downloadRes, {
    "download 200": (r) => r.status === 200,
  });
}
```

**KHÔNG viết thế này**:

```js
// SAI — dùng __VU làm identity
const reportType = REPORT_TYPES[__VU - 1];  // Chỉ export 6 report types, lặp đi lặp lại

// SAI — dùng __ITER làm identity
const reportType = REPORT_TYPES[__ITER];    // VU=1 __ITER=4 và VU=2 __ITER=4 trùng report type

// SAI — lưu job_id vào worker-level state (biến ngoài export default)
let workerJobId = null;
export default function () {
  if (!workerJobId) {
    workerJobId = http.post(createUrl).json().job_id;  // Chỉ create 1 lần/VU
  }
  // Dùng lại workerJobId cho mọi iter -> status/download lặp trên cùng 1 job
}

// SAI — dùng biến global shared giữa tất cả VU
let globalJobId = null;
export default function () {
  globalJobId = http.post(createUrl).json().job_id;
  // VU này ghi đè job_id của VU khác -> race condition!
}
```

### Vì sao KHÔNG có per-VU state như per-vu-iterations?

Trong per-vu-iterations, mỗi VU có state riêng (session, token, cart) sống qua nhiều iteration vì cùng VU luôn chạy iter cho cùng identity.

Trong shared-iterations, **không có per-VU persistent state hữu ích** vì:

```text
VU=1 chạy job #0 (report type #0, job_id="rpt-000"), xong chạy job #3 (report type #3, job_id="rpt-003"), xong chạy job #7 (report type #7, job_id="rpt-007")...
→ Mỗi job là một report type KHÁC NHAU với job_id KHÁC NHAU
→ State của job #0 không dùng được cho job #3
→ job_id của iter trước là rác với iter sau
→ Không cần giữ session/token/job_id giữa các iter trong cùng VU
```

Nếu script cần auth token, dùng `setup()` hoặc tạo token mới mỗi iteration:

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

## ASYNC LIFECYCLE — ĐẶC THÙ CỦA CASE NÀY

Đây là section quan trọng nhất của case 06, phân biệt nó với tất cả case 01-05 (sync flow).

### Flow async đầy đủ

```text
┌─────────────────────────────────────────────────────────────┐
│                 REPORT EXPORT LIFECYCLE                      │
│                                                              │
│  POST /report/jobs          GET /report/jobs/:id    GET .../download │
│  ┌──────────────┐          ┌──────────────┐       ┌──────────────┐   │
│  │   CREATE     │──202──▶  │   STATUS     │──200─▶│  DOWNLOAD    │   │
│  │   accepted   │   │      │   ready      │   │   │  artifact    │   │
│  └──────────────┘   │      └──────────────┘   │   └──────────────┘   │
│                      │                         │                      │
│               job_id │                  ┌──────┘                      │
│               (local)│                  │                              │
│                      │        ┌─────────┴──────────┐                 │
│                      └───────▶│ REPORT WORKER       │                 │
│                               │ (generate artifact) │                 │
│                               │ READY_AFTER_MS ms   │                 │
│                               └────────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

### Từng bước chi tiết

**Bước 1 — CREATE (POST)**:

```text
Client gửi: POST /api/sim/report/jobs?report_type=sales_daily&...
Server trả về: 202 Accepted + { job_id: "rpt-abc-123", status: "pending" }

202 Accepted = job đã vào hàng đợi, CHƯA generated
job_id là server-generated, unique
Client PHẢI lưu job_id để dùng cho bước 2 và 3
```

**Bước 2 — STATUS CHECK (GET)**:

```text
Client gửi: GET /api/sim/report/jobs/rpt-abc-123?...
Server trả về: 200 OK + { job_id: "rpt-abc-123", status: "ready" }

status có thể là:
  - "pending": report đang được generate, chưa sẵn sàng
  - "ready": report đã generate xong, có thể download
  - "failed": report generate thất bại

READY_AFTER_MS mô phỏng thời gian generate:
  - 1ms: gần như instant (test nhanh)
  - 100ms: mô phỏng delay nhẹ
  - 500ms: mô phỏng report nặng (nhiều data, query phức tạp)
```

**Bước 3 — DOWNLOAD (GET)**:

```text
Client gửi: GET /api/sim/report/jobs/rpt-abc-123/download?...
Server trả về: 200 OK + artifact data (gzip)

Chỉ download được khi status = "ready"
Nếu status = "pending" hoặc "failed" -> 404 hoặc 409
gzip_kb mô phỏng kích thước artifact
```

### Demo trace async lifecycle — job thành công

```text
Job #0: report_type="inventory_summary", READY_AFTER_MS=1ms

t=0.000s  VU=1 bắt đầu iter #0
t=0.002s  POST create -> server accept, trả về job_id="rpt-000", status 202
          (job_id="rpt-000" lưu vào biến local của iter này)
t=0.004s  GET status "rpt-000" -> server trả về status="ready" (sau READY_AFTER_MS=1ms)
t=0.006s  GET download "rpt-000" -> server trả về artifact (gzip 4KB)
t=0.008s  Job #0 hoàn tất ✓
          shared_job_duration_ms ≈ 8ms
          (tổng 3 API calls: create 2ms + status 2ms + download 2ms = 6ms,
           + overhead ~2ms)
```

### Demo trace async lifecycle — status chưa ready (cần poll)

```text
Job #15: report_type="revenue_monthly", READY_AFTER_MS=500ms
(Trong thực tế, nếu script có retry loop cho status)

t=0.000s  VU=3 bắt đầu iter #15
t=0.003s  POST create -> job_id="rpt-015", 202
t=0.005s  GET status "rpt-015" -> status="pending" (chưa ready!)
t=0.100s  GET status "rpt-015" lần 2 -> status="pending" (vẫn chưa)
t=0.300s  GET status "rpt-015" lần 3 -> status="pending"
t=0.505s  GET status "rpt-015" lần 4 -> status="ready" ✓
t=0.507s  GET download "rpt-015" -> artifact ✓
t=0.510s  Job #15 hoàn tất
          shared_job_duration_ms ≈ 510ms
          (async wait = 500ms dominates toàn bộ job time)
```

### Điều gì xảy ra nếu status KHÔNG BAO GIỜ ready?

```text
Job #45: report worker crash, report không được generate

t=0.000s  VU=5 bắt đầu iter #45
t=0.003s  POST create -> job_id="rpt-045", 202 ✓
t=0.005s  GET status "rpt-045" -> status="pending"
t=0.100s  GET status "rpt-045" -> status="pending"
t=0.300s  GET status "rpt-045" -> status="pending"
...
t=10.00s  GET status "rpt-045" -> status="pending" (vẫn pending sau 10s!)
          → Nếu script có timeout: throw error, job failed
          → Nếu script không có timeout: VU bị kẹt vô hạn, maxDuration cắt scenario
          → shared_job_duration_ms cho job này = 10s+ (SLA breach)
          → shared_jobs_failed tăng lên 1
```

### Code pattern async với retry/polling loop

Với case đơn giản (READY_AFTER_MS=1ms), không cần retry vì report gần như instant. Nhưng với async pipeline thực tế, cần polling:

```js
export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  const reportType = REPORT_TYPES[jobIndex];

  // Bước 1: Create
  const createRes = http.post(`${BASE_URL}/api/sim/report/jobs?...`);
  check(createRes, { "create accepted": (r) => r.status === 202 });
  const jobId = createRes.json().job_id;

  // Bước 2: Poll status với retry
  const maxRetries = 30;
  const retryDelayMs = 200;
  let statusReady = false;
  
  for (let i = 0; i < maxRetries; i++) {
    const statusRes = http.get(`${BASE_URL}/api/sim/report/jobs/${jobId}?...`, {
      tags: { operation: "report_job_status" },
    });
    
    if (statusRes.status === 200) {
      const body = statusRes.json();
      if (body.status === "ready") {
        statusReady = true;
        break;
      }
    }
    
    // Chưa ready, đợi rồi thử lại
    if (i < maxRetries - 1) {
      // sleep(retryDelayMs / 1000); // nếu dùng k6 sleep
    }
  }
  
  check(null, { "status ready before timeout": () => statusReady });

  // Bước 3: Download (chỉ khi status ready)
  if (statusReady) {
    const downloadRes = http.get(
      `${BASE_URL}/api/sim/report/jobs/${jobId}/download?...`,
      { tags: { operation: "report_job_download" } }
    );
    check(downloadRes, { "download 200": (r) => r.status === 200 });
  }
}
```

### Vì sao worker skew còn mạnh hơn với async?

```text
Trong sync flow (case 01-05):
  Tất cả VU có iter_time gần giống nhau vì latency mỗi API call ổn định
  → Skew vừa phải (VU nhanh ~2-3x VU chậm)

Trong async flow (case 06):
  - READY_AFTER_MS có thể khác nhau giữa các job
  - Một VU có thể gặp job có READY_AFTER_MS=500ms (chậm)
    trong khi VU khác gặp job READY_AFTER_MS=1ms (nhanh)
  - VU bị kẹt với job chậm sẽ mất cơ hội lấy job khác
  - Kết quả: skew có thể lên tới 5-10x

Ví dụ cụ thể:
  VU=1 gặp các job READY_AFTER_MS=1ms: iter_time=0.01s -> 30 jobs
  VU=6 gặp các job READY_AFTER_MS=500ms: iter_time=0.51s -> 2 jobs
  → Skew: 30-2, nhưng tổng vẫn = 60 ✓
```

## Service/API flow

| Operation | Method | Path | Service | Expected | Expected count | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| report_job_create | `POST` | `/api/sim/report/jobs?report_type=...&cpu_ms=2&db_rows=2&gzip_kb=4&ready_after_ms=...` | report-service | `202` | 60 | Create async report job, accepted vào queue. |
| report_job_status | `GET` | `/api/sim/report/jobs/:id?cpu_ms=1&db_rows=1` | report-service | `200` | 60 | Check job status, verify async pipeline đã generate xong. |
| report_job_download | `GET` | `/api/sim/report/jobs/:id/download?cpu_ms=1&gzip_kb=4` | report-service | `200` | 60 | Download report artifact, verify storage/download path. |

Một job chỉ được coi là hoàn tất khi các operation cần thiết của job đó đã pass theo contract — và **đúng thứ tự** create → status → download.

### Khác biệt operation semantics với case 01 (catalog audit)

| Tiêu chí | Case 01 (catalog audit) | Case 06 (report export) |
| --- | --- | --- |
| Số operation/job | 2 (list + detail) | 3 (create + status + download) |
| Quan hệ giữa operations | Độc lập (có thể gọi song song) | Phụ thuộc tuần tự (cần job_id từ create) |
| Response code chính | 200 cho cả 2 | 202 (create), 200 (status/download) |
| Có async delay? | Không | Có (READY_AFTER_MS) |
| Operation nào chứng minh pipeline? | Detail chứng minh product detail page | Status + download chứng minh async pipeline |
| Metric chính | http_req_duration (từng request) | shared_job_duration_ms (full lifecycle) |

## Metrics và tags cần đọc

| Metric | Type | Expected | Nó chứng minh gì? |
| --- | --- | --- | --- |
| `shared_jobs_total` | Counter | `count == JOBS` | Bao nhiêu business job đã hoàn tất end-to-end. |
| `shared_jobs_failed` | Counter | `count == 0` | Có job nào fail ở tầng business không. |
| `shared_api_calls_total` | Counter | khớp công thức API/job | Helper đã gửi đúng số API calls theo flow chưa. |
| `shared_job_duration_ms` | Trend | `count == JOBS` | Thời gian end-to-end của từng job, không chỉ từng request. ĐÂY LÀ METRIC CHÍNH. |
| `shared_sleep_seconds` | Counter | tùy case | Tổng sleep/think/wait time nếu script mô phỏng delay. |

Tags chung:

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `si-06-report-export-batch`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service đang được gọi. |
| `operation` | Bước nghiệp vụ/API cụ thể trong job. |
| `endpoint` | Nhóm endpoint/API family. |
| `job_id` | Business job trong backlog, derive từ global job index. |
| `executor_family` | `shared_iterations`. |
| `workload_shape` | `fixed_backlog`. |

Tags case này:

```text
case_id       = si-06-report-export-batch
business_case = report_export_batch
service       = report-service
```

## Pass criteria

Pass criteria tối thiểu:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 60
shared_jobs_failed count == 0
iterations count == 60
http_reqs count == 180
shared_api_calls_total count == 180
```

Operation breakdown phải khớp:

```text
report_job_create: 60
report_job_status: 60
report_job_download: 60
```

Đừng thêm pass condition kiểu:

```text
mỗi VU phải xử lý 60 / 6 = 10 jobs
```

Vì đó không phải invariant của `shared-iterations`.

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-06-report-export-batch.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js
```

Nếu backend script chưa có trong working tree, chỉ đọc phần expected formula trước; không tự điền run data.

## Đọc output summary

Áp 5 bước giống cách đọc các case per-vu, nhưng invariant đổi sang **total backlog**, không phải per-user quota.

### Bước 1 — Verify scenario/config

Header phải thể hiện:

```text
executor = shared-iterations
vus = 6 hoặc env override
total iterations/jobs = 60 hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ expected counts.

### Bước 2 — Compute expected total jobs

Default case này:

```text
JOBS = 60
API_PER_JOB = 3
expected iterations = 60
expected http_reqs = 60 × 3 = 180
```

### Bước 3 — Compare summary counters

Expected:

```text
iterations == 60
shared_jobs_total == 60
shared_jobs_failed == 0
```

Nếu `iterations < 60`:

```text
backlog chưa drain hết -> invalid result
→ maxDuration cắt? Tăng maxDuration.
→ iter_time quá dài? Giảm workload hoặc tăng vus.
→ Async pipeline quá chậm? Kiểm tra READY_AFTER_MS hoặc report worker.
```

Nếu `iterations == 60` nhưng `shared_jobs_total < 60`:

```text
iteration chạy xong nhưng job completion instrumentation/business branch bị thiếu
→ Kiểm script: có gọi jobDone() sau mỗi iteration không?
→ Có exception/early return nào bỏ qua job completion không?
→ Có job nào bị kẹt ở async wait và không mark done?
```

### Bước 4 — Compare API and operation counts

Expected:

```text
http_reqs == 180
shared_api_calls_total == 180
report_job_create: 60
report_job_status: 60
report_job_download: 60
```

Tổng HTTP đúng nhưng operation split sai vẫn là coverage bug:

```text
VD: http_reqs = 180, nhưng:
  report_job_create: 60
  report_job_status: 80  ← DƯ 20 (poll nhiều lần)
  report_job_download: 40  ← THIẾU 20
→ 20 jobs: create + status OK nhưng download fail
→ Artifact coverage = 40/60 = 67% -> FAIL
→ Có thể storage/download path bị lỗi cho 20 jobs
```

### Bước 5 — Interpret duration/throughput

`shared_job_duration_ms` trả lời:

```text
một business job end-to-end mất bao lâu
= create_time + async_wait + status_time + download_time
```

`http_req_duration` trả lời:

```text
mỗi request/API call mất bao lâu
= riêng create HOẶC status HOẶC download
```

Hai metric này khác nhau. Job nhiều API + async wait có thể có từng request nhanh nhưng full lifecycle vẫn chậm.

**Đặc thù case 06: shared_job_duration_ms >> http_req_duration**

```text
Nếu READY_AFTER_MS = 500ms:
  http_req_duration avg = 5ms (từng API call rất nhanh)
  shared_job_duration_ms avg = 510ms (full lifecycle, async wait dominates)

→ Không thể dùng http_req_duration để đánh giá user experience
→ User chờ 510ms cho report, không phải 5ms
→ shared_job_duration_ms là metric CHÍNH cho SLA
```

Case-specific summary notes:

- `iterations = 60` chứng minh 60 report lifecycle jobs chạy.
- `http_reqs = 180` vì mỗi job có create + status + download.
- `shared_job_duration_ms` là metric chính để đọc full lifecycle latency — create nhanh nhưng async wait có thể chiếm phần lớn thời gian.
- `shared_job_duration_ms` count phải = 60 (mỗi job có 1 duration sample).
- Operation breakdown phải là create 60, status 60, download 60; thiếu operation nào nghĩa là pipeline không hoàn chỉnh.

Không check mỗi VU làm bằng nhau. Invariant là total completed work, không phải equal work per VU.

## Đọc dashboard real-time charts cho case 06

> Phần này mô tả expected reading pattern. Chỉ bổ sung run ID, p95/p99/max, bucket arrays sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? bucket nào có tail latency? Create nhanh nhưng status/download chậm? | Backlog đã xử lý đủ chưa |
| Execution timeline | Theo thời gian đã hoàn tất bao nhiêu iterations/http_reqs/jobs? | Mỗi VU có làm bằng nhau không |
| VUs vs iter/s | Worker pool drain backlog nhanh/chậm ra sao? Async có làm giảm throughput không? | Business correctness của từng job |

Một cách đọc nhanh:

```text
Response time      -> chất lượng request, phát hiện bottleneck (đặc biệt: async pipeline delay)
Execution timeline -> backlog drain progress, phát hiện thiếu coverage
VUs vs iter/s      -> worker pool shape, phát hiện bất thường throughput do async wait
```

### Chart 1 — Response time

Đây là request-level latency. Với case này, đọc theo `operation`:

```text
report_job_create: 60
report_job_status: 60
report_job_download: 60
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
4. Spike xảy ra ở operation nào (create, status, hay download)?
```

Với case 06, shape đẹp thường có:

```text
đầu run:  p95/max có thể cao hơn (cold start, request đầu)
giữa run: p95 ổn định thấp hơn
cuối run: p95 không tăng bất thường

ĐẶC THÙ CASE 06:
  report_job_create: thường nhanh nhất (chỉ accept, không generate)
  report_job_status: có thể chậm hơn create (cần check db state)
  report_job_download: có thể chậm nhất (gzip, data transfer)
```

#### Shape analysis cho 3 operation — đọc tuần tự pipeline

```text
SO SÁNH 3 ĐƯỜNG OPERATION TRÊN CÙNG CHART:

Shape A — Pipeline khỏe mạnh:
  create p95:  ~5ms   (nhanh, ổn định)
  status p95:  ~8ms   (nhanh, gần create)
  download p95: ~10ms  (chậm hơn chút do data transfer)
  → Cả 3 operation gần nhau, không có bottleneck rõ rệt
  → Async pipeline OK, không có delay bất thường

Shape B — Async bottleneck (status chậm hơn hẳn):
  create p95:  ~5ms   (vẫn nhanh)
  status p95:  ~50ms  (chậm hơn create 10x!)
  download p95: ~12ms (bình thường)
  → Status check chậm -> report worker chậm hoặc DB query status chậm
  → Điều tra: READY_AFTER_MS lớn? report worker overload?
  → KHÔNG kết luận toàn pipeline chậm — create và download vẫn OK

Shape C — Download bottleneck:
  create p95:  ~5ms   (nhanh)
  status p95:  ~8ms   (nhanh)
  download p95: ~100ms (chậm hơn hẳn!)
  → Download path có vấn đề: storage service chậm, gzip compression nặng
  → Hoặc artifact kích thước lớn hơn bình thường
  → Điều tra storage/download pipeline riêng

Shape D — Create cũng chậm:
  create p95:  ~50ms  (chậm từ đầu)
  status p95:  ~55ms
  download p95: ~60ms
  → Không phải async pipeline — toàn bộ report-service chậm
  → Điều tra report-service deployment, resource, hoặc upstream
```

Case-specific bottleneck hints:

- `report_job_create` kiểm accepted path, expected 202. Nếu create chậm → report-service endpoint hoặc DB insert chậm.
- `report_job_status` expose readiness/worker latency. Nếu status chậm hơn create đáng kể → async pipeline delay (READY_AFTER_MS hoặc worker queue).
- `report_job_download` expose artifact/storage/gzip path. Download spike khác create spike → storage service riêng có vấn đề.
- Khoảng cách giữa create p95 và status p95 là "async readiness gap" — gap càng lớn, async pipeline càng có vấn đề.

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 cao ngay từ đầu rồi ổn định | cold start, cache miss đầu | kiểm report-service cache |
| p95 tăng dần càng về cuối | leak, state phình trong backend | soi job_duration theo job_id |
| max spike lẻ tẻ nhưng p95 ổn | vài outlier đơn lẻ | xem log nhưng chưa vội fail |
| p95 và max cùng spike nhiều bucket | vấn đề hệ thống thật | chặn / điều tra backend |
| create nhanh, status chậm rõ rệt | async pipeline bottleneck | kiểm report worker, READY_AFTER_MS |
| create + status nhanh, download chậm | storage/artifact path bottleneck | kiểm storage service, gzip config |
| cả 3 operation cùng chậm | report-service tổng thể có vấn đề | kiểm deployment, resource, DB |

### Chart 2 — Execution timeline

Chart này chứng minh backlog drain đủ theo thời gian.

Kiểm tổng bucket:

```text
sum(iterations buckets) == 60
sum(http_reqs buckets) == 180
sum(shared_jobs_total buckets) == 60
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
  Live VUs = config VUs (6)
  RPS cao vì tất cả VU cùng hoạt động
  httpReqs có thể xuất hiện sớm hơn iterations (request-level metrics đến trước)

giữa run:
  Live VUs vẫn gần 6 nếu backlog còn nhiều
  iterations tăng đều theo bucket
  Với case 06: httpReqs nên gấp ~3x iterations (3 API/job)

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

#### Đặc thù case 06 — httpReqs pattern 3:1

```text
Với case 01 (catalog audit): httpReqs ≈ 2 × iterations (2 API/job)
Với case 06 (report export): httpReqs ≈ 3 × iterations (3 API/job)

Trên execution timeline:
  Đường httpReqs nên CAO GẤP 3 đường iterations
  Nếu httpReqs chỉ gấp 2 iterations -> thiếu 1 operation (có thể download bị skip)
  Nếu httpReqs gấp 4+ iterations -> có retry/polling extra status calls
```

Invalid patterns:

| Pattern | Nghĩa |
| --- | --- |
| `iterations` đủ nhưng `shared_jobs_total` thiếu | iteration complete nhưng business job chưa mark done |
| `http_reqs` đủ nhưng operation split sai | tổng request đủ nhưng coverage lệch (vd: create 60, status 80, download 40) |
| `shared_jobs_failed > 0` | business failure dù HTTP có thể vẫn 200 |
| buckets không cộng ra summary | đọc nhầm point/bucket hoặc data chưa final |
| Live VUs không lên đủ 6 từ đầu | VU init có vấn đề, config/env sai |
| Live VUs giữ cao nhưng iterations không tăng | VU bị kẹt trong request, backend chậm hoặc async wait kéo dài |
| httpReqs / iterations ratio < 3 | thiếu operation trong flow |
| httpReqs / iterations ratio > 3 | có extra status poll hoặc duplicate calls |

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
- 6 VU cùng chạy (mỗi VU đang ở 1 job khác nhau)
- Nhiều HTTP request hoàn thành (create + status + download)
- Một số iteration/job hoàn thành
- Nhiều check pass/fail
```

Điều kiện để một event rơi vào bucket nào:

```text
event timestamp thuộc giây nào -> rơi vào bucket giây đó
```

#### Vì sao bucket đầu có thể có httpReqs > 0 nhưng iterations = 0?

```text
Bucket đầu: VU vừa start, request đầu đã xong (create endpoint)
nhưng full job (create + status + download + checks) chưa hoàn tất

→ httpReqs > 0 (request-level metric đến sớm)
→ iterations = 0 (job-level metric đến muộn hơn, cần full flow xong)

Với case 06, hiệu ứng này còn rõ hơn:
  - Create request xong rất nhanh (202)
  - Nhưng status + download + async wait mất thêm thời gian
  → httpReqs xuất hiện sớm, iterations xuất hiện muộn hơn nhiều
```

### Chart 3 — VUs vs iter/s

Chart này giải thích worker-pool shape:

```text
- VUs gần 6 khi backlog còn nhiều việc
- iter/s tăng/giảm theo latency và số API/job
- VUs có thể tụt ở tail khi backlog gần hết
- fast VUs có thể xử lý nhiều job hơn slow VUs
```

#### Cách phân tích sâu chart VUs vs iter/s

Chart này trả lời câu hỏi:

```text
Worker pool drain backlog nhanh/chậm ra sao?
Throughput iteration có bám theo shape VU không?
Async wait có làm giảm throughput không?
```

Với `shared-iterations`, đường `Executor VUs` và `Actual iter/s` có quan hệ:

```text
peak_rate ≈ vus / iter_time
         ≈ 6 / iter_time

Nếu iter_time avg = 0.5s:
  peak_rate ≈ 6 / 0.5 ≈ 12 iter/s

Nếu iter_time avg = 1.5s (async pipeline chậm):
  peak_rate ≈ 6 / 1.5 ≈ 4 iter/s

SO SÁNH VỚI CASE 01:
  Case 01: iter_time ≈ 0.3-0.6s (sync, 2 API)
  Case 06: iter_time ≈ 0.4-1.5s (async, 3 API + wait)
  → Case 06 throughput thấp hơn case 01 với cùng số VU
  → KHÔNG phải do case 06 "chậm hơn", mà do workload khác (3 API + async wait)
```

Đừng đọc chart này thành:

```text
mỗi VU phải xử lý 60 / 6 = 10 jobs
```

Với `shared-iterations`, đó là yêu cầu sai.

Shape mong đợi:

```text
- đầu run: iter/s có thể 0 (chưa job nào xong — async wait ban đầu)
- giữa run: iter/s dao động theo batch hoàn thành
- cuối run: iter/s tụt khi backlog gần hết, rồi về 0
- đường VUs: gần 6 ở đầu/giữa, tụt ở cuối
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| `Actual iter/s` đầu = 0, sau đó tăng | job đầu chưa hoàn tất (async wait) | bình thường |
| `Actual iter/s` dao động theo bucket | nhiều job finish không cùng thời điểm | bình thường |
| `Actual iter/s` = 0 lâu trong khi VUs cao | VU bị kẹt trong async wait, backend chậm | cần điều tra |
| `Actual iter/s` thấp hơn expected (dựa trên iter_time) | async delay kéo dài hơn dự kiến | kiểm READY_AFTER_MS, report worker |
| `Actual iter/s` tụt về 0 và VUs cũng về 0 | test xong quota | bình thường |
| sum `Actual iter/s` < expected total | thiếu iteration / drop / interrupt | test invalid |
| VUs không lên tới 6 | config/env sai, VU init lỗi | kiểm header |

### Cách chốt từ summary -> 3 chart

```text
1. Summary quyết định pass/fail bằng counters/thresholds.
2. Execution timeline xác nhận backlog drain đủ theo thời gian.
3. Response time tìm operation/service chậm — đặc biệt async readiness gap.
4. VUs vs iter/s giải thích worker pool hoạt động ra sao — async wait impact lên throughput.
5. Business decision dựa trên total coverage + failed jobs + operation breakdown.
```

## Kết luận thực tế: output -> quyết định

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **report export batch gate**: output ra số như vậy thì team quyết định gì với việc deploy report-service hoặc storage pipeline?

### Kịch bản A — output sạch: REPORT EXPORT PASS

```text
iterations.........: 60         (đủ backlog)
http_req_failed....: 0.00%
shared_jobs_total..: 60
shared_jobs_failed.: 0
report_job_create..: 60
report_job_status..: 60
report_job_download: 60
shared_job_duration_ms: p(95)=0.65s
```

Kết luận thực tế:

```text
- Count đủ 60 -> toàn bộ report jobs đã được export (yêu cầu a)
- 0 fail, 0 job failed -> không job nào lỗi
- Operation breakdown đúng 60/60/60 -> cả create, status, download đều đủ coverage
- shared_job_duration_ms p95=0.65s -> full lifecycle latency OK
- http_reqs = 180 = 60×3 -> đúng số API calls
=> QUYẾT ĐỊNH: report pipeline OK. Cho phép deploy report-service/storage.
```

### Kịch bản B — create đủ nhưng status thiếu: ASYNC PIPELINE BROKEN

```text
iterations.........: 60         (vẫn đủ!)
shared_jobs_total..: 60
shared_jobs_failed.: 15         ← CÓ 15 JOB FAIL
report_job_create..: 60         ← create OK hết
report_job_status..: 45         ← THIẾU 15 STATUS
report_job_download: 45         ← THIẾU 15 DOWNLOAD
```

Kết luận thực tế:

```text
- Count vẫn 60 -> KHÔNG phải lỗi test, coverage attempt đủ
- Nhưng 15 job failed -> 15 jobs async pipeline broken
- Create 60/60 -> accept pipeline OK
- Status chỉ 45/60 -> 15 jobs không được generate (report worker lỗi?)
- Download chỉ 45/60 -> artifact không tồn tại cho 15 jobs
=> QUYẾT ĐỊNH: BLOCK deploy. Route theo job_id để tìm 15 jobs lỗi.
   Điều tra report worker: có bị crash? queue full? timeout?
   Đây CHÍNH LÀ giá trị của shared-iterations: count cố định nên
   failed jobs là tín hiệu thật, không phải do test thiếu coverage.
   ĐIỂM KHÁC BIỆT: create pass hết nhưng status fail ->
   vấn đề nằm ở async pipeline (worker), không phải API accept.
```

### Kịch bản C — create + status đủ nhưng download thiếu: STORAGE BROKEN

```text
iterations.........: 60
shared_jobs_total..: 60
shared_jobs_failed.: 10
report_job_create..: 60         ← OK
report_job_status..: 60         ← OK (report đã được generate)
report_job_download: 50         ← THIẾU 10 DOWNLOAD
```

Kết luận thực tế:

```text
- Create 60/60 -> accept OK
- Status 60/60 -> report generate OK (async pipeline hoạt động)
- Download 50/60 -> 10 artifacts không download được
- Có thể: storage path sai, artifact bị xóa premature, permission issue
- Hoặc: download endpoint có bug, gzip processing lỗi
=> QUYẾT ĐỊNH: BLOCK deploy storage service.
   Khác với kịch bản B: ở đây async pipeline (create+status) OK,
   vấn đề nằm RIÊNG ở download/storage path.
   Đây là giá trị của operation breakdown: phân biệt được
   lỗi pipeline (status fail) vs lỗi storage (download fail).
```

### Kịch bản D — thiếu iteration: TEST INVALID

```text
iterations.........: 38         (THIẾU 22!)
http_req_failed....: 2.3%
interrupted........: 22
```

Kết luận thực tế:

```text
- 38 < 60 -> backlog chưa drain hết -> KHÔNG kết luận được report pipeline có OK không
- Trước khi nói gì về report, phải sửa cho test chạy đủ 60 đã:
    interrupted=22 -> maxDuration quá ngắn? Tăng maxDuration.
    Hoặc iter_time quá dài? Async pipeline quá chậm? Giảm READY_AFTER_MS hoặc tăng vus.
=> QUYẾT ĐỊNH: CHƯA kết luận report pass/fail. Test invalid, chạy lại
   sau khi sửa nguyên nhân thiếu count.
```

### Kịch bản E — counts pass nhưng shared_job_duration_ms cao: SLA RISK

```text
iterations.........: 60
report_job_create..: 60 (p95=5ms)    ← create nhanh
report_job_status..: 60 (p95=8ms)    ← status nhanh
report_job_download: 60 (p95=10ms)   ← download nhanh
shared_job_duration_ms: p(95)=2.1s   ← full lifecycle CHẬM!
```

Kết luận thực tế:

```text
- Tất cả operation counts pass, http_req_duration đều thấp
- NHƯNG shared_job_duration_ms p95 = 2.1s — rất cao so với individual request
- 2.1s - (5+8+10)ms ≈ 2.077s async wait time
- Có thể READY_AFTER_MS được set quá cao, hoặc có delay ẩn giữa các bước
- Hoặc script có sleep/poll không tối ưu
=> QUYẾT ĐỊNH: Functional pass nhưng SLA risk.
   Nếu SLA yêu cầu p95 < 1s -> FAIL.
   Điều tra async wait time: READY_AFTER_MS config, report worker performance.
   Đây là lý do shared_job_duration_ms là metric CHÍNH, không phải http_req_duration.
```

### Kịch bản F — operation split sai, tổng HTTP vẫn 180: COVERAGE BUG ẨN

```text
iterations.........: 60
http_reqs..........: 180        (tổng đúng!)
report_job_create..: 60         ← đúng
report_job_status..: 75         ← DƯ 15 (poll extra?)
report_job_download: 45         ← THIẾU 15
```

Kết luận thực tế:

```text
- Tổng http_reqs = 180 = 60×3 -> nhìn qua tưởng đúng
- Nhưng create=60, status=75, download=45 -> 15 jobs thiếu download
- Status dư 15 -> có thể script poll status extra cho 15 jobs (retry loop)
- Download thiếu 15 -> artifact path lỗi hoặc download bị skip
=> QUYẾT ĐỊNH: BLOCK. Sửa script hoặc điều tra vì sao download thiếu.
   Đây là lỗi coverage ẩn — tổng HTTP đúng không có nghĩa coverage đúng.
   Đặc biệt với async flow: status poll extra làm tổng HTTP vẫn khớp,
   che giấu việc download bị thiếu.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| create/status/download mỗi loại 60, no failed jobs | All report lifecycle jobs completed | Report batch passed, cho phép deploy |
| create 60, status < 60 | Accepted jobs not fully verified, async pipeline broken | Block, điều tra report worker |
| create/status 60, download < 60 | Artifacts not fully retrievable, storage path broken | Block, điều tra storage/download service |
| create 60, status/download < 60 (cùng số) | Report worker crash hoặc không generate | Block, restart report worker, điều tra queue |
| status timeout/not ready | Async worker/SLA issue, report không generate kịp | Điều tra report worker performance |
| download failures | Artifact generation/storage path broken | Block, kiểm tra storage service, artifact path |
| Counts pass but `shared_job_duration_ms` high | Functional pass, SLA risk (end-to-end quá chậm) | Điều tra async wait time, READY_AFTER_MS |
| Counts pass, http_reqs=180, operation split sai | Coverage gap ẩn dưới tổng HTTP đúng | Block, sửa script branch logic |
| < 60 iter (drop/interrupt) | Test chưa hợp lệ, backlog chưa drain hết | Sửa config, chạy lại |
| http_req_duration thấp nhưng shared_job_duration_ms cao | Từng API nhanh nhưng async wait dominates | SLA decision dựa trên shared_job_duration_ms |
| VU distribution uneven | Normal worker-pool behavior | Do not fail |

Điểm cốt lõi của case này: **vì count luôn cố định 60, mọi thiếu hụt ở operation breakdown hoặc failed jobs đều là tín hiệu THẬT về report pipeline, không bị nhiễu bởi "lần này test chạy nhiều/ít hơn lần trước"**. Đặc biệt, với async flow, `shared_job_duration_ms` là metric CHÍNH vì nó capture full lifecycle (create + async wait + status + download), trong khi `http_req_duration` chỉ capture từng API call riêng lẻ. Một pipeline có thể có từng request nhanh nhưng end-to-end vẫn chậm do async wait — đó là lý do không thể dùng http_req_duration để đánh giá SLA.

## "Nghịch lý" và misconceptions của shared-iterations (case 06)

### Nghịch lý 1: iteration_duration = 0.6s nhưng iter/s = 10?

```text
iteration_duration: avg=0.6s     <- 1 job mất 0.6 giây
iterations:         10/s         <- nhưng 1 giây ra 10 job

Sao 1 job mất 0.6s mà mỗi giây lại ra được 10 job?
"Lẽ ra 0.6s mới ra 1 job chứ?"
```

**Trả lời: vì 6 VU chạy SONG SONG, không phải 1 VU.**

```text
iteration_duration = thời gian 1 VU làm xong 1 job = 0.6s
iterations rate    = tổng job hoàn thành / tổng thời gian (cả pool) = 10/s

Công thức nối 2 con số (Little's Law):
  rate = vus / iter_time
  10 ≈ 6 / 0.6 ✓

Ví dụ trực quan:
  6 nhân viên, mỗi người xuất 1 báo cáo mất 0.6 phút:
    - 1 báo cáo VẪN mất 0.6 phút (không nhanh hơn)
    - nhưng 6 người làm song song -> mỗi phút ra ~10 báo cáo
```

### Nghịch lý 2: 3 API calls per job nhưng http_reqs = 180?

```text
60 jobs, mỗi job 3 API calls (create + status + download)
60 × 3 = 180

Nhưng nếu có retry loop cho status:
  - Một số job cần poll status 2-3 lần
  - http_reqs có thể > 180

Câu hỏi: "Vậy expected http_reqs có phải lúc nào cũng 180 không?"

Trả lời: Với READY_AFTER_MS=1ms (default), report gần như instant,
status luôn ready ở lần gọi đầu -> http_reqs = 180.

Nếu READY_AFTER_MS lớn hơn và script có retry:
  - http_reqs sẽ > 180 (có extra status poll)
  - Nhưng operation breakdown mong đợi: create=60, download=60
  - Status có thể > 60 do retry, nhưng create và download PHẢI = 60
```

### Nghịch lý 3: Create nhanh (p95=5ms) nhưng shared_job_duration_ms chậm (p95=510ms)?

```text
http_req_duration{operation:report_job_create}: p95=5ms   <- create rất nhanh
http_req_duration{operation:report_job_status}: p95=8ms   <- status cũng nhanh
http_req_duration{operation:report_job_download}: p95=10ms <- download nhanh
shared_job_duration_ms: p95=510ms                          <- FULL LIFECYCLE CHẬM!

Tổng 3 request: 5+8+10 = 23ms
Nhưng full lifecycle: 510ms

510ms - 23ms = 487ms "biến mất" đi đâu?
```

**Trả lời: 487ms là async wait time (READY_AFTER_MS + overhead).**

```text
shared_job_duration_ms đo từ lúc bắt đầu create đến lúc kết thúc download.
Bao gồm:
  - create request time: 5ms
  - async wait (READY_AFTER_MS): 500ms ← ĐÂY LÀ PHẦN "BIẾN MẤT"
  - status request time: 8ms
  - download request time: 10ms
  - overhead: ~10ms (serialization, network round-trip)
  = Tổng: ~533ms (gần với 510ms)

http_req_duration CHỈ đo thời gian 1 HTTP request.
Nó KHÔNG đo thời gian chờ giữa các request.

→ Đây là lý do shared_job_duration_ms là metric CHÍNH cho async flow.
→ http_req_duration không thể dùng để đo SLA của async pipeline.
```

### Nghịch lý 4: 6 VUs nhưng có job mất 10x thời gian job khác?

```text
shared_job_duration_ms:
  min=8ms, p50=15ms, p95=510ms, max=520ms

Sao có job nhanh 8ms mà có job chậm 520ms (gấp 65 lần)?
Cùng 6 VU, cùng script, cùng backend?
```

**Trả lời: async variability giữa các job.**

```text
Với READY_AFTER_MS cố định 1ms:
  - Tất cả job có async wait ~1ms -> latency đồng đều
  - p95 gần với avg

Nhưng nếu READY_AFTER_MS dao động (mô phỏng thực tế):
  - Job A: READY_AFTER_MS=1ms -> iter_time=8ms (nhanh)
  - Job B: READY_AFTER_MS=100ms -> iter_time=110ms
  - Job C: READY_AFTER_MS=500ms -> iter_time=510ms (chậm)

→ Đây là ĐẶC TRƯNG của async pipeline thực tế
→ Report đơn giản generate nhanh, report phức tạp generate chậm
→ shared_job_duration_ms distribution cho thấy async variability
→ Nếu p95 >> p50: có subset report types generate chậm -> cần tối ưu
```

### Nghịch lý 5: Tổng http_reqs = 180 nhưng shared_jobs_total chỉ = 55?

```text
http_reqs = 180 -> 180 HTTP requests đã hoàn thành
shared_jobs_total = 55 -> nhưng chỉ 55 job được mark complete

5 jobs (15 HTTP requests) đã chạy xong HTTP, nhưng job không được mark done.
→ Có thể do: exception sau HTTP request, check fail, hoặc code branch
   bỏ qua job completion instrumentation.

Đặc thù case 06:
  - Download fail (404, 500) nhưng HTTP request vẫn được count
  - Status trả về "failed" (200 OK về HTTP, nhưng business status=failed)
  - Job bị mark failed thay vì done
  → shared_jobs_failed = 5, shared_jobs_total = 55
  → Tổng = 55 + 5 = 60 = iterations ✓

Cách debug:
  - Kiểm script: job failed có được instrumentation đúng không?
  - Kiểm shared_jobs_failed: có = 5 không?
  - Nếu shared_jobs_failed = 0 và shared_jobs_total = 55 -> instrumentation gap
```

## Checklist đọc biểu đồ case 06

Khi học sinh nhìn dashboard case 06, đọc theo thứ tự này:

```text
1. Overview KPI
   - iterations = 60?
   - http_req_failed = 0%?
   - checks = 100%?

2. Response time chart
   - Tách theo operation (create vs status vs download) chưa?
   - Operation nào chậm hơn?
   - Khoảng cách create p95 và status p95 có lớn không? (async readiness gap)
   - Download p95 có spike so với create/status không? (storage bottleneck)
   - batch p95 đầu có spike không?
   - cuối test còn spike không?

3. Execution timeline
   - Live VUs đầu có = 6 không?
   - cuối run VUs có tụt dần về 0 không?
   - sum iterations theo bucket có = 60 không?
   - sum http_reqs theo bucket có = 180 không?
   - sum shared_jobs_total theo bucket có = 60 không?
   - shared_jobs_failed có = 0 ở mọi bucket không?
   - httpReqs / iterations ratio có ≈ 3 không? (nếu < 3 -> thiếu operation)

4. VUs vs iter/s
   - Actual iter/s theo bucket dao động thế nào?
   - sum actual iter/s có = 60 không?
   - VUs có giữ gần 6 ở đầu/giữa run không?
   - Cuối run VUs có tụt về 0 không?
   - Throughput có bị giảm do async wait không?

5. Business decision
   - Tất cả counters pass?
   - Operation breakdown đúng 60/60/60?
   - shared_jobs_failed = 0?
   - shared_job_duration_ms p95 có trong SLA không? ← ĐẶC THÙ CASE 06
   - Nếu tất cả pass -> report export batch PASS
```

Kết luận của run case 06 đang đúng nếu thấy:

```text
iterations = 60
http_req_failed = 0%
checks = 100%
shared_jobs_total = 60
shared_jobs_failed = 0
report_job_create = 60
report_job_status = 60
report_job_download = 60
shared_job_duration_ms count = 60
Live VUs: đầu = 6, cuối giảm về 0
sum chart iterations = summary iterations
sum chart httpReqs = summary http_reqs
httpReqs / iterations ratio ≈ 3
executor = shared-iterations
```

## Mở rộng / variation

### Variation A: Thêm retry loop cho status polling

Khi READY_AFTER_MS lớn (>100ms), report không instant ready, cần poll:

```js
export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  const reportType = REPORT_TYPES[jobIndex];

  // Create
  const createRes = http.post(`${BASE_URL}/api/sim/report/jobs?report_type=${reportType}&ready_after_ms=${READY_AFTER_MS}&...`);
  check(createRes, { "create accepted": (r) => r.status === 202 });
  const jobId = createRes.json().job_id;

  // Poll status với timeout 10s
  const maxAttempts = 50;
  const pollIntervalMs = 200;
  let statusReady = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const statusRes = http.get(`${BASE_URL}/api/sim/report/jobs/${jobId}?...`, {
      tags: { operation: "report_job_status", poll_attempt: String(attempt) },
    });

    if (statusRes.status === 200) {
      const body = statusRes.json();
      if (body.status === "ready") {
        statusReady = true;
        break;
      }
      if (body.status === "failed") {
        break; // Không retry nếu job failed
      }
    }
    // Sleep giữa các lần poll
    sleep(pollIntervalMs / 1000);
  }

  check(null, { "status became ready": () => statusReady });

  // Download chỉ khi ready
  if (statusReady) {
    const downloadRes = http.get(
      `${BASE_URL}/api/sim/report/jobs/${jobId}/download?...`,
      { tags: { operation: "report_job_download" } }
    );
    check(downloadRes, { "download 200": (r) => r.status === 200 });
  }
}
```

**Expected thay đổi**: http_reqs sẽ > 180 (do extra status poll). Nhưng create và download vẫn phải = 60.

### Variation B: Thay đổi READY_AFTER_MS để mô phỏng async pipeline khác nhau

```powershell
# Mô phỏng async pipeline nhanh (gần như sync)
$env:SI_06_READY_AFTER_MS = 1
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js

# Mô phỏng async pipeline trung bình
$env:SI_06_READY_AFTER_MS = 200
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js

# Mô phỏng async pipeline chậm (report nặng)
$env:SI_06_READY_AFTER_MS = 500
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js
```

So sánh shared_job_duration_ms giữa 3 lần chạy để thấy async wait impact.

### Variation C: Thêm report type variation để test nhiều loại report

```js
const REPORT_TYPES = [
  // Nhóm 1: Report nhẹ (nhanh)
  ...Array(20).fill("inventory_summary"),
  // Nhóm 2: Report trung bình
  ...Array(20).fill("sales_daily"),
  // Nhóm 3: Report nặng (nhiều data, query phức tạp)
  ...Array(20).fill("revenue_monthly_full"),
];

// Khi chạy, tag thêm report_type_category để so sánh latency theo nhóm
export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  const reportType = REPORT_TYPES[jobIndex];
  const category = jobIndex < 20 ? "light" : jobIndex < 40 ? "medium" : "heavy";

  const createRes = http.post(`${BASE_URL}/api/sim/report/jobs?report_type=${reportType}&...`, {
    tags: { report_category: category },
  });
  // ...
}
```

Sau đó filter dashboard theo `report_category` để so sánh latency giữa light/medium/heavy reports.

### Variation D: Thêm threshold latency cho shared_job_duration_ms

```js
export const options = {
  thresholds: {
    // Threshold cho từng operation
    "http_req_duration{operation:report_job_create}": ["p(95)<50"],
    "http_req_duration{operation:report_job_status}": ["p(95)<100"],
    "http_req_duration{operation:report_job_download}": ["p(95)<100"],
    // Threshold cho FULL LIFECYCLE — quan trọng nhất
    "shared_job_duration_ms": ["p(95)<1000"],  // SLA: p95 < 1s
  },
};
```

Chuyển từ functional batch sang SLA gate. `shared_job_duration_ms` threshold là SLA thật cho user experience.

### Variation E: Tăng JOBS để mô phỏng backlog production lớn hơn

```powershell
$env:SI_06_JOBS = 500
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-06-report-export-batch.js
```

Nhớ recompute expected: `http_reqs = 500 × 3 = 1500`.

### Variation F: Multi-scenario — report export + cache warm đồng thời

```js
scenarios: {
  report_export: {
    executor: "shared-iterations",
    vus: 6,
    iterations: 60,
    tags: { case_id: "si-06-report-export-batch" },
  },
  cache_warm: {
    executor: "shared-iterations",
    vus: 2,
    iterations: 30,
    startTime: "3s",
    tags: { case_id: "si-05-cache-warm" },
  },
},
```

## Anti-pattern

- Dùng `__VU` làm business identity chính cho backlog.
- Lưu `job_id` từ create vào worker-level state — mỗi iteration phải có job_id riêng.
- Fail test chỉ vì VU distribution không đều.
- Dùng `constant-vus` rồi suy ra exact job count từ duration — đặc biệt tệ với async pipeline.
- Dùng arrival-rate executor cho bài toán drain fixed queue.
- Chỉ nhìn response time đẹp mà không kiểm `shared_jobs_total` và operation counts.
- Dùng `http_req_duration` thay vì `shared_job_duration_ms` để đánh giá SLA — async wait không được capture trong http_req_duration.
- Giữ expected formulas cũ sau khi override `JOBS`.
- Coi create 202 là "job done" — 202 chỉ là accepted, chưa phải completed.
- Không tách operation breakdown — tưởng 180 request OK nhưng download có thể thiếu.
- Dùng per-VU state (job_id, session) kỳ vọng sống qua nhiều iter — mỗi iter là 1 job khác nhau.
- Kiểm tra `iterations_per_vu == JOBS / vus` như một pass criteria.
- Quên kiểm tra `shared_job_duration_ms` count = JOBS — mỗi job phải có 1 duration sample.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- Worked example QuickPizza: `../../20260515_03_shared-iterations-quickpizza-two-requests-worked-example.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-06-report-export-batch.js`
- Per-vu comparison (case 01): `../per-vu-iterations/01_user-journey-replay.md`
- Case 01 catalog audit (reference pattern): `./01_catalog-audit.md`
