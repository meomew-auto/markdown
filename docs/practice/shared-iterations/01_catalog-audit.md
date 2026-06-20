# Case 01: Catalog audit

## Tình huống thực tế

Team catalog/product vừa deploy logic catalog hoặc sync/import lại dữ liệu sản phẩm. Sau deploy, họ có một danh sách SKU/product cố định cần audit để chắc chắn list page và detail page vẫn trả đúng.

Nếu chỉ một SKU bị bỏ sót, learner vẫn có thể thấy test pass trong khi product detail của SKU đó bị lỗi ngoài production. Vì vậy mục tiêu chính là coverage đủ backlog, không phải mô phỏng user traffic.

Case này trả lời câu hỏi: với 8 worker, backend có audit đủ 80 product jobs không, và mỗi job có đi qua cả list + detail path không?

Tóm tắt đời thường:

```text
Trigger: deploy catalog, sync product index, import SKU mới, hoặc regression sau thay đổi products-service
Backlog: 80 product/SKU audit jobs
Risk nếu skip job: một SKU/detail path có thể lỗi nhưng không bị phát hiện
```

Case này **không** cố gắng trả lời "production traffic giống thật chưa?". Nó trả lời câu hỏi batch/ops cụ thể hơn:

```text
Có xử lý đủ fixed backlog không?
Mỗi job có đi đúng business flow không?
Có job nào fail không?
```

### Vì sao "catalog audit fixed SKU backlog" buộc chọn shared-iterations?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của catalog audit trước:

```text
Catalog audit = "duyệt qua TỪNG SKU trong danh sách cố định,
                gọi list page + detail page,
                xác nhận cả 2 đều trả về 200 và data hợp lệ"

Đời thường:
  Kho có 80 thùng hàng (= 80 SKU)
  8 công nhân (= 8 VU)
  Mỗi thùng cần: quét mã ngoài (= list) + mở ra kiểm bên trong (= detail)
  Công nhân nào xong thùng trước thì lấy thùng tiếp theo
  Kết thúc khi TẤT CẢ 80 thùng đã được kiểm
```

Để catalog audit **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ shared-iterations mới thỏa mãn cả 2.

#### Yêu cầu (a): EXACT TOTAL COVERAGE (không thiếu SKU nào)

**Ý nghĩa**: Phải audit ĐỦ 80 SKU. Thiếu 1 SKU là coverage incomplete — SKU đó có thể bị lỗi mà không ai biết.

**Ví dụ cụ thể**:

```text
Scenario: team deploy sync product index mới, cần verify 80 SKU

Trường hợp A (coverage ĐỦ):
  Audit 80 SKU, tất cả list + detail pass
  → Kết luận: catalog sync OK, không mất SKU nào

Trường hợp B (coverage THIẾU - bug):
  Audit 55 SKU (thiếu 25), 55 SKU đã audit đều pass
  → Tưởng OK, nhưng 25 SKU chưa audit có thể đang lỗi
  → Production: user mở 1 trong 25 SKU đó → lỗi → mất khách
  → KHÔNG kết luận được, test không có giá trị
```

**Vì sao total iterations phải chính xác 80?**

```text
Nếu total phụ thuộc duration:
  - duration cố định 30s
  - latency thấp  → audit được 80 SKU (đủ)
  - latency cao   → audit được 55 SKU (thiếu 25)
  - latency tăng do backend chậm, không phải do ít SKU hơn
  → Mỗi lần test số SKU audit được khác → không biết coverage có đủ không
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
  - DB query time (cache hit/miss, lock contention)
  - Detail endpoint có include_reviews (JOIN query, có thể chậm hơn list)
  - List endpoint có include_facets + json_items (aggregation nặng)

Ví dụ thực tế chạy 3 lần liên tiếp cùng config:
  Lần 1: server vừa restart, cache cold
    iter_time avg = 0.80s -> count = 240/0.80 = 300 jobs audit
    (dư! audit nhiều hơn 80, nhưng có thể audit lặp SKU đầu, thiếu SKU cuối)
  Lần 2: cache đã warm, network ổn
    iter_time avg = 0.50s -> count = 240/0.50 = 480 jobs audit
  Lần 3: DB backup chạy ngầm, detail endpoint chậm
    iter_time avg = 1.20s -> count = 240/1.20 = 200 jobs audit

  Vấn đề KHÔNG chỉ là count khác nhau.
  Vấn đề LỚN HƠN: không biết 80 SKU có được audit ĐỦ không.
  300 jobs có thể = audit lặp 30 SKU đầu × 10 lần, bỏ sót 50 SKU cuối.
```

`constant-arrival-rate` với `rate: 5/s, duration: "20s"`:

```text
Mục tiêu config: "5 job/s × 20s = 100 jobs TOTAL"
→ Dư so với 80 SKU cần audit. Nhưng...

KHÔNG đảm bảo đạt 100 vì có thể DROP slot:
  - Khi rate target > năng lực VU pool
  - Khi server chậm bất thường ở 1 đoạn (database lock, GC)
  - Khi spawn VU không kịp lúc đầu

Công thức thực tế:
  N_done = N_sched - N_drop - N_int
         = 100 - N_drop - N_int

Ví dụ thực tế:
  Lần 1: pool vừa khít, không drop
    N_drop = 0, N_done = 100 (dư 20 so với 80, audit lặp)
  Lần 2: server có 10s chậm ở giữa (database backup)
    N_drop = 30, N_done = 70 (thiếu 10 SKU!)
  Lần 3: cache cold ở 30s đầu
    N_drop = 15, N_int = 5, N_done = 80 (vừa đủ, may mắn)

  KHÔNG可靠: lần được lần không, không biết trước
```

**Trong khi đó với `shared-iterations`**:

```text
Config: vus=8, iterations=80
N_done = 80 (TUYỆT ĐỐI, nếu không bị maxDuration cắt)

Lần 1: server chậm  -> 80 jobs, T_run=22s, p95=1.8s
Lần 2: server nhanh -> 80 jobs, T_run=12s, p95=0.6s
Lần 3: server bình thường -> 80 jobs, T_run=16s, p95=1.0s

Count CỐ ĐỊNH ở 80 mỗi lần.
Chỉ có T_run + latency thay đổi -> đó CHÍNH LÀ cái cần đo!

→ 80 SKU luôn được audit đủ → coverage guarantee
→ Nếu latency tăng, T_run tăng → phát hiện được performance regression
```

**Tóm tắt 3 executor về count**:

| Executor | Count formula | Count cố định? | SKU coverage guarantee? |
| --- | --- | --- | --- |
| **shared-iterations** | `iterations` | CÓ (tuyệt đối) | CÓ (nếu identity map đúng) |
| constant-vus (duration) | `duration × vus / iter_time` | KHÔNG (do iter_time) | KHÔNG (có thể audit lặp hoặc thiếu) |
| constant-arrival-rate | `N_sched - N_drop - N_int` | KHÔNG (do drop/int) | KHÔNG (drop có thể bỏ sót SKU) |

→ COUNT phải CHÍNH XÁC, KHÔNG phụ thuộc latency
→ Chỉ executor đếm theo "iterations cố định" mới đạt
→ Nhưng count đủ chưa đủ — còn cần identity map ĐÚNG (yêu cầu b)

#### Yêu cầu (b): CORRECT IDENTITY MAPPING (mỗi job map đúng 1 SKU)

**Ý nghĩa**: 80 iteration phải map sang 80 SKU KHÁC NHAU. Nếu map sai, dù count = 80, coverage vẫn thiếu.

**Bug identity mapping là gì?**

```text
Trường hợp ĐÚNG — identity từ iterationInTest:
  iter #0  -> SKU #0  (audit list + detail)
  iter #1  -> SKU #1
  iter #2  -> SKU #2
  ...
  iter #79 -> SKU #79
  → 80 SKU unique được audit ✓

Trường hợp SAI — identity từ __VU:
  VU=1: __VU=1 -> SKU=1 (lặp lại 15 lần)
  VU=2: __VU=2 -> SKU=2 (lặp lại 12 lần)
  ...
  VU=8: __VU=8 -> SKU=8 (lặp lại 8 lần)
  → Chỉ 8 SKU được audit (lặp đi lặp lại)
  → 72 SKU còn lại KHÔNG BAO GIỜ được audit
  → Dù iterations = 80, coverage thật chỉ = 8/80 = 10%
```

**3 nguyên nhân kỹ thuật của bug identity mapping**:

### Nguyên nhân 1: CATALOG COVERAGE GAP (thiếu SKU do duration-based test)

**Vấn đề**: Duration-based test dừng sau một khoảng thời gian, không theo số SKU. Nếu latency tăng, số SKU audit được giảm.

```text
Tưởng tượng kho 80 thùng hàng:
  - 8 công nhân kiểm, mỗi thùng mất ~0.5s
  - Sếp đặt đồng hồ 30s -> hết 30s dừng, bất kể còn thùng chưa kiểm

  Ngày thường (server nhanh, 0.5s/thùng):
    8 công nhân × 30s / 0.5s = 480 thùng (dư, nhưng audit lặp thùng đầu)
    → Nếu map identity SAI, audit lặp 8 thùng đầu × 60 lần
    → 72 thùng cuối chưa từng được đụng tới

  Ngày chậm (server quá tải, 1.2s/thùng):
    8 công nhân × 30s / 1.2s = 200 thùng
    → Vẫn có thể audit lặp, bỏ sót thùng cuối
```

**Demo cụ thể: constant-vus duration=30s, vus=8**

Giả sử mỗi iter mất 0.6s, code dùng `__VU` làm identity (SAI):

```text
VU=1 (nhanh nhất, network tốt): iter_time=0.4s
  → 30s / 0.4s = 75 iter
  → Luôn audit SKU=1, lặp 75 lần

VU=8 (chậm nhất, network kém): iter_time=0.9s
  → 30s / 0.9s = 33 iter
  → Luôn audit SKU=8, lặp 33 lần

Tổng: 75+... +33 ≈ 400 iterations
Nhưng chỉ 8 SKU unique được audit
→ Coverage thật = 8/80 = 10%
→ 72 SKU bỏ sót, dù test "pass" với 400 iter
```

**Demo với code đúng (identity từ iterationInTest) nhưng vẫn duration-based**:

```text
Vấn đề khác: không biết khi nào đã audit đủ 80 SKU

constant-vus duration=30s:
  iter #0-#79: audit SKU #0-#79 (đủ 80)
  iter #80-#399: audit tiếp SKU #0-#79 (lặp lại, dư)
  → Lãng phí, nhưng ít nhất 80 SKU đã được audit

constant-vus duration=5s (quá ngắn):
  iter #0-#45: audit SKU #0-#45 (chỉ 46 SKU)
  → Thiếu 34 SKU, coverage không đủ
  → Nhưng test vẫn "pass" nếu chỉ nhìn http_req_failed=0

SO SÁNH VỚI shared-iterations:
  iterations=80
  iter #0-#79: audit SKU #0-#79 (đủ 80, DỪNG)
  → Không dư, không thiếu, coverage chính xác
```

**Cách phát hiện**: so sánh `iterations` count với expected `JOBS`. Nếu `iterations < JOBS` → coverage incomplete. Nếu `iterations > JOBS` và identity từ `__VU` → audit lặp.

### Nguyên nhân 2: WRONG IDENTITY MAPPING (dùng `__VU` thay vì `iterationInTest`)

Đây là lỗi phổ biến nhất khi chuyển từ per-vu-iterations sang shared-iterations.

**`__VU` là gì trong shared-iterations?** `__VU` là **worker ID** — định danh VU nào đang xử lý job hiện tại. Nó không phải business identity.

**`exec.scenario.iterationInTest` là gì?** Là **global job index** — số thứ tự iteration trong toàn scenario, từ 0 đến iterations-1.

```text
So sánh 2 cách map identity:

Cách A — SAI: dùng __VU
  const skuId = skus[__VU - 1];  // VU=1 -> skus[0], VU=2 -> skus[1], ...
  
  VU=1: __VU=1 -> luôn audit skus[0] (lặp ~10 lần)
  VU=2: __VU=2 -> luôn audit skus[1] (lặp ~10 lần)
  ...
  VU=8: __VU=8 -> luôn audit skus[7] (lặp ~10 lần)
  → 8 SKU unique, 72 SKU bỏ sót

Cách B — ĐÚNG: dùng exec.scenario.iterationInTest
  const skuId = skus[exec.scenario.iterationInTest];  // iter #0 -> skus[0], ...
  
  iter #0  -> skus[0]  (do VU nào cũng được)
  iter #1  -> skus[1]
  iter #2  -> skus[2]
  ...
  iter #79 -> skus[79]
  → 80 SKU unique, coverage đủ
```

**Demo trace 8 VU × 80 iter với identity đúng**:

```text
t=0.0s   8 VU cùng start
         VU=1 lấy iterInTest=0  -> audit SKU #0
         VU=2 lấy iterInTest=1  -> audit SKU #1
         VU=3 lấy iterInTest=2  -> audit SKU #2
         ...
         VU=8 lấy iterInTest=7  -> audit SKU #7

t=0.5s   VU=1 xong iter #0, lấy iterInTest=8  -> audit SKU #8
         VU=3 xong iter #2, lấy iterInTest=9  -> audit SKU #9
         ...

t=6.0s   iterInTest=79 được lấy -> audit SKU #79 (SKU cuối!)
         80/80 jobs complete -> scenario dừng

Kết quả: 80 SKU unique được audit, mỗi SKU đúng 1 lần ✓
```

**Demo trace 8 VU × 80 iter với identity SAI (dùng __VU)**:

```text
t=0.0s   VU=1: __VU=1 -> SKU #1 (lần 1)
         VU=2: __VU=2 -> SKU #2 (lần 1)
         ...

t=0.5s   VU=1: __VU=1 -> SKU #1 (lần 2)  ← lặp!
         VU=3: __VU=3 -> SKU #3 (lần 1)
         ...

t=6.0s   80 iter hoàn thành
         SKU #1: audit 15 lần
         SKU #2: audit 12 lần
         SKU #3: audit 10 lần
         ...
         SKU #8: audit 8 lần
         SKU #9-#80: audit 0 lần ← 72 SKU bỏ sót!

Kết quả: 80 iter, nhưng coverage thật = 8/80 = 10% ❌
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
  const skuIndex = exec.scenario.iterationInTest;  // 0..79
  const sku = skus[skuIndex];
  // KHÔNG: const sku = skus[__VU - 1];
```

### Nguyên nhân 3: LIST/DETAIL ASYMMETRY (list pass nhưng detail fail)

**Vấn đề**: Một job catalog audit chỉ hoàn tất khi **cả** list endpoint và detail endpoint đều pass. Nếu chỉ check tổng HTTP requests, có thể bỏ sót trường hợp list pass hết nhưng detail fail.

```text
Flow mỗi job:
  1. GET /api/sim/products?...       (list endpoint)  → expect 200
  2. GET /api/sim/products/:id?...    (detail endpoint) → expect 200

Nếu detail endpoint có bug (vd JOIN thiếu index, query timeout):
  - List vẫn pass 80/80 (nhanh, có cache)
  - Detail fail 15/80 (chậm, thiếu index)

Nếu chỉ nhìn http_reqs = 160:
  → 80 list + 80 detail = 160 request đã gửi
  → nhưng 15 detail fail (status 500/timeout)
  → http_req_failed = 15/160 = 9.4%
  → Có vẻ "hơi fail", nhưng...

Nếu tách theo operation:
  catalog_list_audit:   80/80 pass (100%)
  catalog_detail_audit: 65/80 pass (81.25%), 15 fail
  → 15 SKU có list OK nhưng detail LỖI
  → Nguy hiểm: user thấy SKU trong list, click vào -> lỗi
```

**Demo trace list/detail asymmetry**:

```text
Backend state: detail endpoint của SKU #15, #27, #42, #58, #73 bị lỗi
(do data migration thiếu field, hoặc JOIN broken)

Run catalog audit 80 jobs:
  Job #0:  list=200 OK, detail=200 OK  ✓
  Job #1:  list=200 OK, detail=200 OK  ✓
  ...
  Job #15: list=200 OK, detail=500 ERR ← BUG, nhưng list vẫn OK
  ...
  Job #27: list=200 OK, detail=500 ERR ← BUG
  ...
  Job #79: list=200 OK, detail=200 OK  ✓

Tổng kết nếu CHỈ nhìn http_reqs:
  http_reqs = 160
  http_req_failed = 5/160 = 3.1%
  → Dễ bị bỏ qua nếu threshold http_req_failed < 5%

Tổng kết nếu tách operation:
  catalog_list_audit:  80 pass, 0 fail
  catalog_detail_audit: 75 pass, 5 fail
  → 5 SKU detail bị lỗi → CATALOG AUDIT FAIL
  → Phải route theo job_id để tìm chính xác SKU nào lỗi
```

**Cách phát hiện**: luôn tách metric theo tag `operation`. Không chỉ check `http_req_failed` tổng. Nếu `catalog_detail_audit` count < 80 → thiếu detail coverage. Nếu `catalog_detail_audit` có failed > 0 → điều tra SKU cụ thể.

### Nguyên nhân 4: WORKER SKEW IS EXPECTED (phân phối không đều là bình thường)

**Vấn đề**: Với shared-iterations, VU nhanh sẽ lấy nhiều job hơn VU chậm. Đây là **feature**, không phải bug. Nhưng nếu learner không hiểu, họ có thể fail test vì "phân phối không đều".

```text
Tưởng tượng 8 công nhân kiểm kho 80 thùng:
  - Công nhân A (nhanh, có kinh nghiệm): 0.3s/thùng -> làm được 22 thùng
  - Công nhân B (bình thường): 0.5s/thùng -> làm được 13 thùng
  - Công nhân H (mới, chậm): 0.9s/thùng -> làm được 5 thùng

  Tổng: 22+13+...+5 = 80 thùng ✓
  Phân phối: không đều, nhưng TẤT CẢ thùng đã được kiểm

  Người quản lý KHÔNG nói: "Công nhân H làm ít quá, test fail"
  Người quản lý NÓI: "80/80 thùng đã kiểm xong, test pass"
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

**Demo trace worker skew với 4 VU, 16 iter, tốc độ khác nhau**:

```text
Config: vus=4, iterations=16
  VU=1: delay=0.2s (nhanh)
  VU=2: delay=0.4s
  VU=3: delay=0.8s
  VU=4: delay=0.8s (chậm)

Timeline:
t=0.0s   4 VU start, cùng lấy iter đầu
         VU=1: iterInTest=0,  sleep(0.2)
         VU=2: iterInTest=1,  sleep(0.4)
         VU=3: iterInTest=2,  sleep(0.8)
         VU=4: iterInTest=3,  sleep(0.8)

t=0.2s   VU=1 xong, lấy iterInTest=4,  sleep(0.2)
t=0.4s   VU=1 xong, lấy iterInTest=5,  sleep(0.2)
         VU=2 xong, lấy iterInTest=6,  sleep(0.4)
t=0.6s   VU=1 xong, lấy iterInTest=7,  sleep(0.2)
t=0.8s   VU=1 xong, lấy iterInTest=8,  sleep(0.2)
         VU=2 xong, lấy iterInTest=9,  sleep(0.4)
         VU=3 xong, lấy iterInTest=10, sleep(0.8)
         VU=4 xong, lấy iterInTest=11, sleep(0.8)
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

**So sánh với per-vu-iterations (nơi phân phối đều là REQUIREMENT)**:

| Tiêu chí | shared-iterations | per-vu-iterations |
| --- | --- | --- |
| Phân phối job | Không đều (first-come-first-served) | Đều tuyệt đối (mỗi VU = N iter) |
| VU nhanh xong sớm | Lấy thêm job | IDLE (không cướp việc VU khác) |
| Pass criteria | Tổng job = config | Tổng job = config VÀ mỗi VU = N iter |
| Khi nào fail vì phân phối? | Không bao giờ | Nếu VU nào không đủ N iter |

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
   - Product team có danh sách 80 SKU cần audit
   - Không phải "audit trong 5 phút", mà là "audit ĐỦ 80 SKU"
   → iterations = 80 (tổng job toàn scenario)
   → KHÔNG dùng duration làm input chính

2. WORKER POOL SIZE (số worker cùng xử lý):
   - 8 worker cùng audit để xong nhanh hơn
   - Không quan trọng worker nào làm bao nhiêu, miễn tổng đủ
   → vus = 8 (số worker)
   → KHÔNG cần mỗi VU audit đúng 10 SKU

3. COVERAGE COMPLETENESS (mỗi job đi qua đủ flow):
   - Mỗi job: list endpoint + detail endpoint = 2 API calls
   - 80 jobs × 2 API = 160 total API calls
   → http_reqs = 160 (deterministic, nếu không fail)
   → shared_api_calls_total = 160
```

## Yêu cầu cứng của case này

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Tổng completed iterations phải bằng `80` | Vì `80` là kích thước backlog, thiếu 1 job là coverage incomplete. |
| `shared_jobs_total == 80` | Iteration chạy xong chưa đủ; job phải được mark hoàn tất end-to-end. |
| `shared_jobs_failed == 0` | Có failed job nghĩa là business contract không đạt. |
| `http_reqs/shared_api_calls_total == 80 × 2 = 160` | Mỗi job phải gọi đúng số API trong flow. |
| Operation counts phải khớp expected breakdown | Tổng HTTP đúng nhưng thiếu một operation vẫn là coverage bug. |
| Job identity phải derive từ `exec.scenario.iterationInTest` | Worker identity `__VU` không đại diện cho business job. |
| Uneven per-VU distribution is normal | Worker nhanh xử lý nhiều job hơn là đúng mô hình shared pool. |

Nếu một trong các invariant về count/job fail, kết quả nên coi là **invalid hoặc fail**, không phải "pass nhưng hơi thiếu".

## Vì sao "catalog audit fixed SKU backlog" nên dùng `shared-iterations`?

Mental model đúng:

```text
80 jobs đang nằm trong một queue/backlog.
8 VUs là 8 workers.
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
| `SI_01_VUS` | 8 | Số worker cùng xử lý backlog |
| `SI_01_JOBS` | 80 | Tổng số job toàn scenario |
| `maxDuration` | 8m | Safety cap, không phải target duration |
| `executor` | `shared-iterations` | Fixed global backlog + worker pool |

Mapping quan trọng:

```text
business backlog size = 80 jobs
k6 iterations         = 80
worker pool size      = 8 VUs
expected API calls    = 80 × 2 = 160
```

`maxDuration` chỉ là safety cap. Nếu cap này cắt run làm `iterations < 80`, kết quả không valid vì backlog chưa drain hết.

Operation coverage expected:

```text
catalog_list_audit: 80
catalog_detail_audit: 80
```

## Technical semantics: shared backlog, worker pool, job identity

Cách k6 vận hành nên được hiểu như sau:

```text
1. Scenario có một global quota: iterations = 80.
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
  - KHÔNG dùng làm product ID, order ID, SKU index

__ITER:
  - Local counter của từng VU, bắt đầu từ 0
  - VU=1: __ITER=0 → iter #0, __ITER=1 → iter #3, __ITER=2 → iter #7...
  - KHÔNG phải global job index
  - VU=1 __ITER=4 và VU=2 __ITER=4 là 2 job KHÁC NHAU

exec.scenario.iterationInTest:
  - Global job index, từ 0 đến iterations-1
  - DUY NHẤT cho mỗi iteration trong toàn scenario
  - Dùng làm business identity: SKU index, order index, report ID...
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
  const skuIndex = exec.scenario.iterationInTest;  // 0..9
  const sku = skus[skuIndex];
  // Mỗi job #0-#9 map sang SKU #0-#9, không trùng, không thiếu

Code sai:
  const sku = skus[__VU - 1];  // VU=1 -> skus[0], VU=2 -> skus[1], VU=3 -> skus[2]
  // Chỉ 3 SKU được audit, lặp đi lặp lại
  // 7 SKU còn lại không bao giờ được audit
```

### Code pattern đúng cho shared-iterations

```js
import exec from "k6/execution";
import { check } from "k6";
import http from "k6/http";

const SKUS = Array.from({ length: 80 }, (_, i) => `SKU-${String(i).padStart(4, "0")}`);

export default function () {
  // Lấy global job index — ĐÂY LÀ DÒNG QUAN TRỌNG NHẤT
  const jobIndex = exec.scenario.iterationInTest;  // 0..79
  const sku = SKUS[jobIndex];

  // List endpoint
  const listRes = http.get(`${BASE_URL}/api/sim/products?limit=10&sort=popular&...`);
  check(listRes, { "list status 200": (r) => r.status === 200 });

  // Detail endpoint cho SKU cụ thể từ job index
  const detailRes = http.get(`${BASE_URL}/api/sim/products/${sku}?view=full&...`);
  check(detailRes, { "detail status 200": (r) => r.status === 200 });
}
```

**KHÔNG viết thế này**:

```js
// SAI — dùng __VU làm identity
const sku = SKUS[__VU - 1];  // Chỉ audit 8 SKU, lặp đi lặp lại

// SAI — dùng __ITER làm identity
const sku = SKUS[__ITER];    // VU=1 __ITER=4 và VU=2 __ITER=4 trùng SKU
```

### Vì sao KHÔNG có per-VU state như per-vu-iterations?

Trong per-vu-iterations, mỗi VU có state riêng (session, token, cart) sống qua nhiều iteration vì cùng VU luôn chạy iter cho cùng identity.

Trong shared-iterations, **không có per-VU persistent state hữu ích** vì:

```text
VU=1 chạy job #0 (SKU #0), xong chạy job #3 (SKU #3), xong chạy job #7 (SKU #7)...
→ Mỗi job là một SKU khác nhau
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

## Service/API flow

| Operation | Method | Path | Service | Expected | Expected count | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| catalog_list_audit | `GET` | `/api/sim/products?limit=10&sort=popular&view=grid&include_facets=1&cpu_ms=2&db_rows=4&json_items=10` | products-service | `200` | 80 | Audit list/search surface. |
| catalog_detail_audit | `GET` | `/api/sim/products/:id?view=full&include_reviews=1&cpu_ms=2&db_rows=2` | products-service | `200` | 80 | Audit detail page của SKU/job. |

Một job chỉ được coi là hoàn tất khi các operation cần thiết của job đó đã pass theo contract.

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
| `case_id` | Case đang chạy, ví dụ `si-01-catalog-audit`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service đang được gọi. |
| `operation` | Bước nghiệp vụ/API cụ thể trong job. |
| `endpoint` | Nhóm endpoint/API family. |
| `job_id` | Business job trong backlog, derive từ global job index. |
| `executor_family` | `shared_iterations`. |
| `workload_shape` | `fixed_backlog`. |

Tags case này:

```text
case_id       = si-01-catalog-audit
business_case = product_catalog_audit
service       = products-service
```

## Pass criteria

Pass criteria tối thiểu:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 80
shared_jobs_failed count == 0
iterations count == 80
http_reqs count == 160
shared_api_calls_total count == 160
```

Operation breakdown phải khớp:

```text
catalog_list_audit: 80
catalog_detail_audit: 80
```

Đừng thêm pass condition kiểu:

```text
mỗi VU phải xử lý 80 / 8 = 10 jobs
```

Vì đó không phải invariant của `shared-iterations`.

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-01-catalog-audit.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js
```

Nếu backend script chưa có trong working tree, chỉ đọc phần expected formula trước; không tự điền run data.

## Đọc output summary

Áp 5 bước giống cách đọc các case per-vu, nhưng invariant đổi sang **total backlog**, không phải per-user quota.

### Bước 1 — Verify scenario/config

Header phải thể hiện:

```text
executor = shared-iterations
vus = 8 hoặc env override
total iterations/jobs = 80 hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ expected counts.

### Bước 2 — Compute expected total jobs

Default case này:

```text
JOBS = 80
API_PER_JOB = 2
expected iterations = 80
expected http_reqs = 80 × 2 = 160
```

### Bước 3 — Compare summary counters

Expected:

```text
iterations == 80
shared_jobs_total == 80
shared_jobs_failed == 0
```

Nếu `iterations < 80`:

```text
backlog chưa drain hết -> invalid result
→ maxDuration cắt? Tăng maxDuration.
→ iter_time quá dài? Giảm workload hoặc tăng vus.
```

Nếu `iterations == 80` nhưng `shared_jobs_total < 80`:

```text
iteration chạy xong nhưng job completion instrumentation/business branch bị thiếu
→ Kiểm script: có gọi jobDone() sau mỗi iteration không?
→ Có exception/early return nào bỏ qua job completion không?
```

### Bước 4 — Compare API and operation counts

Expected:

```text
http_reqs == 160
shared_api_calls_total == 160
catalog_list_audit: 80
catalog_detail_audit: 80
```

Tổng HTTP đúng nhưng operation split sai vẫn là coverage bug:

```text
VD: http_reqs = 160, nhưng:
  catalog_list_audit: 100
  catalog_detail_audit: 60
→ 20 SKU chỉ có list, thiếu detail
→ Detail coverage = 60/80 = 75% -> FAIL
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

- `iterations = 80` chứng minh đủ số product audit jobs đã chạy.
- `http_reqs = shared_api_calls_total = 160` chứng minh mỗi job đi qua 2 API calls.
- Operation breakdown phải là list 80 và detail 80; thiếu detail nghĩa là coverage detail chưa đủ.

Không check mỗi VU làm bằng nhau. Invariant là total completed work, không phải equal work per VU.

## Đọc dashboard real-time charts cho case 01

> Phần này mô tả expected reading pattern. Chỉ bổ sung run ID, p95/p99/max, bucket arrays sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? bucket nào có tail latency? | Backlog đã xử lý đủ chưa |
| Execution timeline | Theo thời gian đã hoàn tất bao nhiêu iterations/http_reqs/jobs? | Mỗi VU có làm bằng nhau không |
| VUs vs iter/s | Worker pool drain backlog nhanh/chậm ra sao? | Business correctness của từng job |

Một cách đọc nhanh:

```text
Response time      -> chất lượng request, phát hiện bottleneck
Execution timeline -> backlog drain progress, phát hiện thiếu coverage
VUs vs iter/s      -> worker pool shape, phát hiện bất thường throughput
```

### Chart 1 — Response time

Đây là request-level latency. Với case này, đọc theo `operation`:

```text
catalog_list_audit: 80
catalog_detail_audit: 80
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
4. Spike xảy ra ở operation nào (list hay detail)?
```

Với case 01, shape đẹp thường có:

```text
đầu run:  p95/max có thể cao hơn (cold start, request đầu)
giữa run: p95 ổn định thấp hơn
cuối run: p95 không tăng bất thường
```

Vì sao đầu run dễ cao hơn?

```text
- Request đầu tiên tới server có thể cold (cache miss, connection pool init)
- 8 VU cùng start -> request burst đầu lớn
- Nếu có auth/token, request đầu có thể chậm hơn
```

Case-specific bottleneck hints:

- List endpoint có `include_facets` và `json_items`, có thể nặng hơn detail trong một số backend.
- Detail endpoint có `include_reviews`, dễ lộ lỗi join/cache riêng của detail path.
- Nếu latency spike chỉ ở detail, không kết luận toàn catalog chậm; route về detail pipeline trước.

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 cao ngay từ đầu rồi ổn định | cold start, cache miss đầu | kiểm products-service cache |
| p95 tăng dần càng về cuối | leak, state phình trong backend | soi job_duration theo job_id |
| max spike lẻ tẻ nhưng p95 ổn | vài outlier đơn lẻ | xem log nhưng chưa vội fail |
| p95 và max cùng spike nhiều bucket | vấn đề hệ thống thật | chặn / điều tra backend |
| detail p95 >> list p95 | detail query chậm (JOIN, thiếu index) | route về detail pipeline |
| list p95 >> detail p95 | list aggregation nặng (facets, json_items) | kiểm list query |

### Chart 2 — Execution timeline

Chart này chứng minh backlog drain đủ theo thời gian.

Kiểm tổng bucket:

```text
sum(iterations buckets) == 80
sum(http_reqs buckets) == 160
sum(shared_jobs_total buckets) == 80
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
| `http_reqs` đủ nhưng operation split sai | tổng request đủ nhưng coverage lệch |
| `shared_jobs_failed > 0` | business failure dù HTTP có thể vẫn 200 |
| buckets không cộng ra summary | đọc nhầm point/bucket hoặc data chưa final |
| Live VUs không lên đủ 8 từ đầu | VU init có vấn đề, config/env sai |
| Live VUs giữ cao nhưng iterations không tăng | VU bị kẹt trong request, backend chậm |

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
- Nhiều HTTP request hoàn thành (cả list + detail)
- Một số iteration/job hoàn thành
- Nhiều check pass/fail
```

Điều kiện để một event rơi vào bucket nào:

```text
event timestamp thuộc giây nào -> rơi vào bucket giây đó
```

#### Vì sao bucket đầu có thể có httpReqs > 0 nhưng iterations = 0?

```text
Bucket đầu: VU vừa start, request đầu đã xong (list endpoint)
nhưng full job (list + detail + check) chưa hoàn tất

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
```

Với `shared-iterations`, đường `Executor VUs` và `Actual iter/s` có quan hệ:

```text
peak_rate ≈ vus / iter_time
         ≈ 8 / iter_time

Nếu iter_time avg = 0.6s:
  peak_rate ≈ 8 / 0.6 ≈ 13.3 iter/s

Nếu iter_time avg = 1.2s:
  peak_rate ≈ 8 / 1.2 ≈ 6.7 iter/s
```

Đừng đọc chart này thành:

```text
mỗi VU phải xử lý 80 / 8 = 10 jobs
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
| `Actual iter/s` = 0 lâu trong khi VUs cao | VU bị kẹt trong request, backend chậm | cần điều tra |
| `Actual iter/s` tụt về 0 và VUs cũng về 0 | test xong quota | bình thường |
| sum `Actual iter/s` < expected total | thiếu iteration / drop / interrupt | test invalid |
| VUs không lên tới 8 | config/env sai, VU init lỗi | kiểm header |

### Cách chốt từ summary -> 3 chart

```text
1. Summary quyết định pass/fail bằng counters/thresholds.
2. Execution timeline xác nhận backlog drain đủ theo thời gian.
3. Response time tìm operation/service chậm.
4. VUs vs iter/s giải thích worker pool hoạt động ra sao.
5. Business decision dựa trên total coverage + failed jobs + operation breakdown.
```

## Kết luận thực tế: output -> quyết định

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **catalog audit gate**: output ra số như vậy thì team quyết định gì với việc deploy/sync catalog?

### Kịch bản A — output sạch: CATALOG PASS

```text
iterations.........: 80         (đủ backlog)
http_req_failed....: 0.00%
shared_jobs_total..: 80
shared_jobs_failed.: 0
catalog_list_audit.: 80
catalog_detail_audit: 80
iteration_duration.: p(95)=0.85s
```

Kết luận thực tế:

```text
- Count đủ 80 -> toàn bộ SKU đã được audit (yêu cầu a)
- 0 fail, 0 job failed -> không SKU nào lỗi
- Operation breakdown đúng 80/80 -> cả list và detail đều đủ coverage
- p95 0.85s -> latency OK
=> QUYẾT ĐỊNH: catalog sync OK. Cho phép deploy/import.
```

### Kịch bản B — count đủ nhưng có failed job: BLOCK

```text
iterations.........: 80         (vẫn đủ!)
shared_jobs_total..: 80
shared_jobs_failed.: 5          ← CÓ 5 JOB FAIL
catalog_list_audit.: 80
catalog_detail_audit: 75        ← THIẾU 5 DETAIL
```

Kết luận thực tế:

```text
- Count vẫn 80 -> KHÔNG phải lỗi test, coverage attempt đủ
- Nhưng 5 job failed -> 5 SKU có vấn đề
- Detail chỉ có 75/80 -> 5 SKU detail bị lỗi
=> QUYẾT ĐỊNH: BLOCK deploy. Route theo job_id để tìm 5 SKU lỗi.
   Đây CHÍNH LÀ giá trị của shared-iterations: count cố định nên
   failed jobs là tín hiệu thật, không phải do test thiếu coverage.
```

### Kịch bản C — thiếu iteration: TEST INVALID

```text
iterations.........: 62         (THIẾU 18!)
http_req_failed....: 1.2%
interrupted........: 18
```

Kết luận thực tế:

```text
- 62 < 80 -> backlog chưa drain hết -> KHÔNG kết luận được catalog có OK không
- Trước khi nói gì về catalog, phải sửa cho test chạy đủ 80 đã:
    interrupted=18 -> maxDuration quá ngắn? Tăng maxDuration.
    Hoặc iter_time quá dài? Giảm workload hoặc tăng vus.
=> QUYẾT ĐỊNH: CHƯA kết luận catalog pass/fail. Test invalid, chạy lại
   sau khi sửa nguyên nhân thiếu count.
```

### Kịch bản D — count đủ, operation split sai: COVERAGE BUG

```text
iterations.........: 80
http_reqs..........: 160        (tổng đúng!)
catalog_list_audit.: 90         ← DƯ 10
catalog_detail_audit: 70        ← THIẾU 10
```

Kết luận thực tế:

```text
- Tổng http_reqs = 160 = 80×2 -> nhìn qua tưởng đúng
- Nhưng list=90, detail=70 -> 10 SKU chỉ có list, thiếu detail
- Có thể do bug trong script: detail request bị skip ở 1 nhánh điều kiện
- Hoặc detail endpoint fail/timeout nhưng script không retry
=> QUYẾT ĐỊNH: BLOCK. Sửa script hoặc điều tra vì sao detail thiếu.
   Đây là lỗi coverage ẩn — tổng HTTP đúng không có nghĩa coverage đúng.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 80 iter, list=80, detail=80, 0 fail | catalog audit hoàn tất, mọi SKU OK | cho phép deploy |
| 80 iter, shared_jobs_failed > 0 | có SKU lỗi business contract | block, route theo job_id |
| 80 iter, detail < 80 | detail coverage incomplete | block, kiểm detail pipeline |
| 80 iter, list < 80 | list coverage incomplete | block, kiểm list/search pipeline |
| < 80 iter (drop/interrupt) | test chưa hợp lệ, backlog chưa drain hết | sửa config, chạy lại |
| http_reqs = 160 nhưng operation split sai | coverage gap ẩn | sửa script, kiểm branch logic |
| Counts pass nhưng p95 cao | functional pass, latency risk | investigate products-service |
| VU distribution uneven | normal worker-pool behavior | do not fail |

Điểm cốt lõi của case này: **vì count luôn cố định 80, mọi thiếu hụt ở operation breakdown hoặc failed jobs đều là tín hiệu THẬT về catalog, không bị nhiễu bởi "lần này test chạy nhiều/ít hơn lần trước"**. Đó là lý do catalog audit gate dùng shared-iterations.

## "Nghịch lý" và misconceptions của shared-iterations

### Nghịch lý 1: iteration_duration = 0.6s nhưng iter/s = 13.3?

```text
iteration_duration: avg=0.6s     <- 1 job mất 0.6 giây
iterations:         13.3/s       <- nhưng 1 giây ra 13.3 job

Sao 1 job mất 0.6s mà mỗi giây lại ra được 13.3 job?
"Lẽ ra 0.6s mới ra 1 job chứ?"
```

**Trả lời: vì 8 VU chạy SONG SONG, không phải 1 VU.**

```text
iteration_duration = thời gian 1 VU làm xong 1 job = 0.6s
iterations rate    = tổng job hoàn thành / tổng thời gian (cả pool) = 13.3/s

Công thức nối 2 con số (Little's Law):
  rate = vus / iter_time
  13.3 ≈ 8 / 0.6 ✓

Ví dụ trực quan:
  8 công nhân, mỗi người kiểm 1 thùng mất 0.6 phút:
    - 1 thùng VẪN mất 0.6 phút (không nhanh hơn)
    - nhưng 8 người kiểm song song -> mỗi phút ra ~13.3 thùng
```

### Nghịch lý 2: VU=8, jobs=80, sao có VU làm 20 job, VU khác chỉ 5?

```text
Đây là câu hỏi phổ biến nhất từ learner chuyển từ per-vu-iterations sang.

Trong per-vu-iterations:
  iterations=10, vus=8 -> mỗi VU chạy ĐÚNG 10 iter = 80 total
  → Phân phối ĐỀU (mỗi VU 10)

Trong shared-iterations:
  iterations=80, vus=8 -> tổng 80 iter, CHIA KHÔNG ĐỀU
  → VU nhanh: 20 iter, VU chậm: 5 iter
  → Tổng = 80, nhưng phân phối LỆCH
```

Vì sao? Vì cơ chế atomic counter "first come first served":

```text
VU nào xong job -> gọi atomic.AddUint64 -> lấy job tiếp theo
VU nhanh (network tốt, latency thấp) -> xong sớm -> gọi sớm -> lấy nhiều
VU chậm (network kém, latency cao) -> xong muộn -> gọi muộn -> lấy ít

Đây là ĐẶC TRƯNG của worker pool, không phải bug.
Giống như: công nhân nhanh làm nhiều thùng hơn công nhân chậm.
```

### Nghịch lý 3: Tổng http_reqs = 160 nhưng shared_jobs_total chỉ = 78?

```text
http_reqs = 160 -> 160 HTTP requests đã hoàn thành
shared_jobs_total = 78 -> nhưng chỉ 78 job được mark complete

2 job (4 HTTP requests) đã chạy xong HTTP, nhưng job không được mark done.
→ Có thể do: exception sau HTTP request, check fail, hoặc code branch
   bỏ qua job completion instrumentation.

Cách debug:
  - Kiểm script: có try/catch bỏ qua jobDone() không?
  - Kiểm shared_jobs_failed: 2 job đó có bị mark failed không?
  - Nếu không failed cũng không total -> instrumentation gap
```

## Checklist đọc biểu đồ case 01

Khi học sinh nhìn dashboard case 01, đọc theo thứ tự này:

```text
1. Overview KPI
   - iterations = 80?
   - http_req_failed = 0%?
   - checks = 100%?

2. Response time chart
   - Tách theo operation (list vs detail) chưa?
   - Operation nào chậm hơn?
   - batch p95 đầu có spike không?
   - cuối test còn spike không?

3. Execution timeline
   - Live VUs đầu có = 8 không?
   - cuối run VUs có tụt dần về 0 không?
   - sum iterations theo bucket có = 80 không?
   - sum http_reqs theo bucket có = 160 không?
   - sum shared_jobs_total theo bucket có = 80 không?
   - shared_jobs_failed có = 0 ở mọi bucket không?

4. VUs vs iter/s
   - Actual iter/s theo bucket dao động thế nào?
   - sum actual iter/s có = 80 không?
   - VUs có giữ gần 8 ở đầu/giữa run không?
   - Cuối run VUs có tụt về 0 không?

5. Business decision
   - Tất cả counters pass?
   - Operation breakdown đúng 80/80?
   - shared_jobs_failed = 0?
   - Nếu tất cả pass -> catalog audit PASS
```

Kết luận của run case 01 đang đúng nếu thấy:

```text
iterations = 80
http_req_failed = 0%
checks = 100%
shared_jobs_total = 80
shared_jobs_failed = 0
catalog_list_audit = 80
catalog_detail_audit = 80
Live VUs: đầu = 8, cuối giảm về 0
sum chart iterations = summary iterations
sum chart httpReqs = summary http_reqs
executor = shared-iterations
```

## Mở rộng / variation

### Variation A: Thêm tag domain-specific để lọc nhóm SKU quan trọng

```js
const PRIORITY_SKUS = new Set([0, 5, 12, 30, 55, 72]); // SKU quan trọng

export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  const sku = SKUS[jobIndex];
  const isPriority = PRIORITY_SKUS.has(jobIndex);

  // Tag riêng cho SKU quan trọng
  const res1 = http.get(`${BASE_URL}/api/sim/products?...`, {
    tags: { priority: isPriority ? "high" : "normal" },
  });
}
```

### Variation B: Tăng JOBS để mô phỏng backlog production lớn hơn

```powershell
$env:SI_01_JOBS = 500
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js
```

Nhớ recompute expected: `http_reqs = 500 × 2 = 1000`.

### Variation C: Thêm threshold latency theo operation

```js
export const options = {
  thresholds: {
    "http_req_duration{operation:catalog_list_audit}": ["p(95)<500"],
    "http_req_duration{operation:catalog_detail_audit}": ["p(95)<800"],
  },
};
```

Chuyển từ functional batch sang performance gate.

### Variation D: Multi-scenario — audit catalog + warm cache đồng thời

```js
scenarios: {
  catalog_audit: {
    executor: "shared-iterations",
    vus: 8,
    iterations: 80,
    tags: { case_id: "si-01-catalog-audit" },
  },
  cache_warm: {
    executor: "shared-iterations",
    vus: 4,
    iterations: 120,
    startTime: "5s",
    tags: { case_id: "si-05-cache-warm" },
  },
},
```

## Anti-pattern

- Dùng `__VU` làm business identity chính cho backlog.
- Fail test chỉ vì VU distribution không đều.
- Dùng `constant-vus` rồi suy ra exact job count từ duration.
- Dùng arrival-rate executor cho bài toán drain fixed queue.
- Chỉ nhìn response time đẹp mà không kiểm `shared_jobs_total` và operation counts.
- Giữ expected formulas cũ sau khi override `JOBS`.
- Dùng per-VU state (session, token) kỳ vọng sống qua nhiều iter — mỗi iter là 1 job khác nhau.
- Kiểm tra `iterations_per_vu == JOBS / vus` như một pass criteria.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- Worked example QuickPizza: `../../20260515_03_shared-iterations-quickpizza-two-requests-worked-example.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-01-catalog-audit.js`
- Per-vu comparison (case 01): `../per-vu-iterations/01_user-journey-replay.md`
