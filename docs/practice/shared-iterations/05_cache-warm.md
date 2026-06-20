# Case 05: Cache warm

## Tình huống thực tế

Sau deploy hoặc catalog change, platform/product muốn warm trước một danh sách URL/cache keys để traffic thật không phải trả cold-start cost.

Danh sách warm là finite: homefeed keys và product detail keys. Nếu một key bị skip, user đầu tiên chạm key đó vẫn ăn cold latency.

Case này trả lời: 12 workers có gọi đủ 120 warm jobs không, và split homefeed/detail có đúng coverage không?

Tóm tắt đời thường:

```text
Trigger: deploy, catalog cache invalidation, CDN/backend cache reset, hoặc traffic ramp trước campaign
Backlog: 120 URL/cache-key warm jobs
Risk nếu skip job: một URL/cache key vẫn cold khi user thật truy cập
```

Case này **không** cố gắng trả lời "production traffic giống thật chưa?". Nó trả lời câu hỏi batch/ops cụ thể hơn:

```text
Có xử lý đủ fixed backlog không?
Mỗi job có đi đúng business flow không?
Có job nào fail không?
Split homefeed/detail có đúng tỉ lệ không?
```

### Vì sao "cache warm fixed URL backlog" buộc chọn shared-iterations?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của cache warm trước:

```text
Cache warm = "gửi request đến TỪNG URL/cache key trong danh sách cố định,
             để backend cache hoặc CDN cache chứa sẵn response,
             traffic thật sau đó được hit cache thay vì cold origin"

Đời thường:
  Kho có 120 thùng hàng (= 120 URL/cache keys cần warm)
  12 công nhân (= 12 VU)
  Mỗi thùng cần: gọi 1 request warm tới URL tương ứng
  Công nhân nào xong thùng trước thì lấy thùng tiếp theo
  Kết thúc khi TẤT CẢ 120 thùng đã được warm
```

Để cache warm **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ shared-iterations mới thỏa mãn cả 2.

#### Yêu cầu (a): EXACT TOTAL COVERAGE (không thiếu URL/cache key nào)

**Ý nghĩa**: Phải warm ĐỦ 120 URL. Thiếu 1 URL là coverage incomplete — URL đó vẫn cold, user đầu tiên truy cập sẽ gánh latency cold start.

**Ví dụ cụ thể**:

```text
Scenario: team deploy xong, invalidate toàn bộ cache catalog, cần warm 120 URL

Trường hợp A (coverage ĐỦ):
  Warm 120 URL, tất cả homefeed + detail đều 200
  → Kết luận: cache warm hoàn tất, sẵn sàng nhận traffic

Trường hợp B (coverage THIẾU - bug):
  Warm 90 URL (thiếu 30), 90 URL đã warm đều 200
  → Tưởng OK, nhưng 30 URL chưa warm vẫn cold
  → Production: user đầu tiên truy cập 1 trong 30 URL đó → latency spike
  → Cache warm KHÔNG hoàn thành, deploy có thể gây outage
```

**Vì sao total iterations phải chính xác 120?**

```text
Nếu total phụ thuộc duration:
  - duration cố định 30s
  - latency thấp  → warm được 120 URL (đủ)
  - latency cao   → warm được 70 URL (thiếu 50)
  - latency tăng do backend cold (chính là thứ đang cần warm!)
  → Mỗi lần test số URL warm được khác → không biết coverage có đủ không
```

**Phân tích sâu: vì sao 2 executor "duration-based" không đảm bảo count?**

`constant-vus` với `duration: "30s"`:

```text
Công thức count khi chạy:
  count_jobs = duration × throughput
             = 30s × (vus / iter_time)
             = 30s × (12 / iter_time)
             = 360 / iter_time

iter_time KHÔNG cố định, biến thiên do:
  - HTTP latency (mạng, server load, GC pause)
  - DB query time (cache hit/miss, lock contention)
  - Homefeed có personalized + json_items (nặng hơn detail)
  - Detail có include_reviews (JOIN query)

Ví dụ thực tế chạy 3 lần liên tiếp cùng config:
  Lần 1: server vừa restart, cache cold
    iter_time avg = 0.25s -> count = 360/0.25 = 1440 jobs warm
    (dư! warm nhiều hơn 120, nhưng có thể warm lặp URL đầu, thiếu URL cuối)
  Lần 2: cache bắt đầu ấm, network ổn
    iter_time avg = 0.15s -> count = 360/0.15 = 2400 jobs warm
  Lần 3: DB backup chạy ngầm, homefeed endpoint chậm
    iter_time avg = 0.45s -> count = 360/0.45 = 800 jobs warm

  Vấn đề KHÔNG chỉ là count khác nhau.
  Vấn đề LỚN HƠN: không biết 120 URL có được warm ĐỦ không.
  1440 jobs có thể = warm lặp 10 URL đầu × 144 lần, bỏ sót 110 URL cuối.
```

`constant-arrival-rate` với `rate: 5/s, duration: "30s"`:

```text
Mục tiêu config: "5 job/s × 30s = 150 jobs TOTAL"
→ Dư so với 120 URL cần warm. Nhưng...

KHÔNG đảm bảo đạt 150 vì có thể DROP slot:
  - Khi rate target > năng lực VU pool
  - Khi server chậm bất thường ở 1 đoạn (database lock, GC)
  - Khi spawn VU không kịp lúc đầu

Công thức thực tế:
  N_done = N_sched - N_drop - N_int
         = 150 - N_drop - N_int

Ví dụ thực tế:
  Lần 1: pool vừa khít, không drop
    N_drop = 0, N_done = 150 (dư 30 so với 120, warm lặp)
  Lần 2: server có 10s chậm ở giữa (database backup)
    N_drop = 40, N_done = 110 (thiếu 10 URL!)
  Lần 3: cache cold ở 30s đầu
    N_drop = 30, N_int = 5, N_done = 115 (thiếu 5)

  KHÔNG可靠: lần được lần không, không biết trước
```

**Trong khi đó với `shared-iterations`**:

```text
Config: vus=12, iterations=120
N_done = 120 (TUYỆT ĐỐI, nếu không bị maxDuration cắt)

Lần 1: server chậm  -> 120 jobs, T_run=8s,  p95=0.4s
Lần 2: server nhanh -> 120 jobs, T_run=4s,  p95=0.15s
Lần 3: server bình thường -> 120 jobs, T_run=6s,  p95=0.25s

Count CỐ ĐỊNH ở 120 mỗi lần.
Chỉ có T_run + latency thay đổi -> đó CHÍNH LÀ cái cần đo!

→ 120 URL luôn được warm đủ → coverage guarantee
→ Nếu latency tăng, T_run tăng → phát hiện được cache/origin regression
```

**Tóm tắt 3 executor về count**:

| Executor | Count formula | Count cố định? | URL coverage guarantee? |
| --- | --- | --- | --- |
| **shared-iterations** | `iterations` | CÓ (tuyệt đối) | CÓ (nếu identity map đúng) |
| constant-vus (duration) | `duration × vus / iter_time` | KHÔNG (do iter_time) | KHÔNG (có thể warm lặp hoặc thiếu) |
| constant-arrival-rate | `N_sched - N_drop - N_int` | KHÔNG (do drop/int) | KHÔNG (drop có thể bỏ sót URL) |

→ COUNT phải CHÍNH XÁC, KHÔNG phụ thuộc latency
→ Chỉ executor đếm theo "iterations cố định" mới đạt
→ Nhưng count đủ chưa đủ — còn cần identity map ĐÚNG (yêu cầu b)

#### Yêu cầu (b): CORRECT IDENTITY MAPPING (mỗi job map đúng 1 URL)

**Ý nghĩa**: 120 iteration phải map sang 120 URL KHÁC NHAU (60 homefeed + 60 detail). Nếu map sai, dù count = 120, coverage vẫn thiếu.

**Bug identity mapping là gì?**

```text
Trường hợp ĐÚNG — identity từ iterationInTest:
  iter #0   -> homefeed URL (cache key homefeed variant #0)
  iter #1   -> homefeed URL (cache key homefeed variant #1)
  ...
  iter #59  -> homefeed URL (cache key homefeed variant #59)
  iter #60  -> detail URL (product #0)
  iter #61  -> detail URL (product #1)
  ...
  iter #119 -> detail URL (product #59)
  → 120 URL unique được warm ✓

Trường hợp SAI — identity từ __VU:
  VU=1: __VU=1 -> URL=1 (lặp lại 15 lần)
  VU=2: __VU=2 -> URL=2 (lặp lại 12 lần)
  ...
  VU=12: __VU=12 -> URL=12 (lặp lại 8 lần)
  → Chỉ 12 URL được warm (lặp đi lặp lại)
  → 108 URL còn lại KHÔNG BAO GIỜ được warm
  → Dù iterations = 120, coverage thật chỉ = 12/120 = 10%
```

**3 nguyên nhân kỹ thuật của bug identity mapping**:

### Nguyên nhân 1: CACHE COVERAGE GAP (thiếu URL do duration-based test)

**Vấn đề**: Duration-based test dừng sau một khoảng thời gian, không theo số URL. Nếu latency tăng, số URL warm được giảm. Cache warm ĐẶC BIỆT dễ bị vì backend đang cold chính là nguyên nhân latency tăng.

```text
Tưởng tượng kho 120 thùng hàng:
  - 12 công nhân warm, mỗi thùng mất ~0.2s
  - Sếp đặt đồng hồ 5s -> hết 5s dừng, bất kể còn thùng chưa warm

  Ngày thường (server nhanh, 0.2s/thùng):
    12 công nhân × 5s / 0.2s = 300 thùng (dư, nhưng warm lặp thùng đầu)
    → Nếu map identity SAI, warm lặp 12 thùng đầu × 25 lần
    → 108 thùng cuối chưa từng được đụng tới

  Ngày chậm (server cold, 0.5s/thùng):
    12 công nhân × 5s / 0.5s = 120 thùng (vừa đúng! may mắn)
    → Nhưng không biết trước — latency biến thiên

  Ngày rất chậm (server overload, 1.0s/thùng):
    12 công nhân × 5s / 1.0s = 60 thùng
    → 60 thùng còn lại vẫn cold! Cache warm thất bại.
```

**Demo cụ thể: constant-vus duration=10s, vus=12**

Giả sử mỗi iter mất 0.3s, code dùng `__VU` làm identity (SAI):

```text
VU=1 (nhanh nhất, network tốt): iter_time=0.15s
  → 10s / 0.15s = 66 iter
  → Luôn warm URL=1, lặp 66 lần

VU=12 (chậm nhất, network kém): iter_time=0.5s
  → 10s / 0.5s = 20 iter
  → Luôn warm URL=12, lặp 20 lần

Tổng: 66+...+20 ≈ 400 iterations
Nhưng chỉ 12 URL unique được warm
→ Coverage thật = 12/120 = 10%
→ 108 URL bỏ sót, dù test "pass" với 400 iter
```

**Demo với code đúng (identity từ iterationInTest) nhưng vẫn duration-based**:

```text
Vấn đề khác: không biết khi nào đã warm đủ 120 URL

constant-vus duration=5s:
  iter #0-#119: warm URL #0-#119 (đủ 120)
  iter #120-#299: warm tiếp URL #0-#119 (lặp lại, dư)
  → Lãng phí, nhưng ít nhất 120 URL đã được warm

constant-vus duration=1s (quá ngắn):
  iter #0-#29: warm URL #0-#29 (chỉ 30 URL)
  → Thiếu 90 URL, coverage không đủ
  → Nhưng test vẫn "pass" nếu chỉ nhìn http_req_failed=0

SO SÁNH VỚI shared-iterations:
  iterations=120
  iter #0-#119: warm URL #0-#119 (đủ 120, DỪNG)
  → Không dư, không thiếu, coverage chính xác
```

**Cách phát hiện**: so sánh `iterations` count với expected `JOBS`. Nếu `iterations < JOBS` → coverage incomplete. Nếu `iterations > JOBS` và identity từ `__VU` → warm lặp.

### Nguyên nhân 2: WRONG IDENTITY MAPPING (dùng `__VU` thay vì `iterationInTest`)

Đây là lỗi phổ biến nhất khi chuyển từ per-vu-iterations sang shared-iterations.

**`__VU` là gì trong shared-iterations?** `__VU` là **worker ID** — định danh VU nào đang xử lý job hiện tại. Nó không phải business identity.

**`exec.scenario.iterationInTest` là gì?** Là **global job index** — số thứ tự iteration trong toàn scenario, từ 0 đến iterations-1.

```text
So sánh 2 cách map identity:

Cách A — SAI: dùng __VU
  const urlIndex = __VU - 1;  // VU=1 -> urls[0], VU=2 -> urls[1], ...
  
  VU=1: __VU=1 -> luôn warm urls[0] (lặp ~10 lần)
  VU=2: __VU=2 -> luôn warm urls[1] (lặp ~10 lần)
  ...
  VU=12: __VU=12 -> luôn warm urls[11] (lặp ~10 lần)
  → 12 URL unique, 108 URL bỏ sót

Cách B — ĐÚNG: dùng exec.scenario.iterationInTest
  const urlIndex = exec.scenario.iterationInTest;  // iter #0 -> urls[0], ...
  
  iter #0   -> urls[0]   (do VU nào cũng được)
  iter #1   -> urls[1]
  iter #2   -> urls[2]
  ...
  iter #119 -> urls[119]
  → 120 URL unique, coverage đủ
```

**Demo trace 12 VU × 120 iter với identity đúng**:

```text
t=0.0s   12 VU cùng start
         VU=1  lấy iterInTest=0   -> warm URL #0  (homefeed)
         VU=2  lấy iterInTest=1   -> warm URL #1  (homefeed)
         VU=3  lấy iterInTest=2   -> warm URL #2  (homefeed)
         ...
         VU=12 lấy iterInTest=11  -> warm URL #11 (homefeed)

t=0.2s   VU=1 xong iter #0, lấy iterInTest=12  -> warm URL #12 (homefeed)
         VU=3 xong iter #2, lấy iterInTest=13  -> warm URL #13 (homefeed)
         ...

t=1.5s   iterInTest=59 được lấy -> warm URL #59 (homefeed cuối)
         iterInTest=60 được lấy -> warm URL #60 (detail đầu)
         ...

t=3.0s   iterInTest=119 được lấy -> warm URL #119 (detail cuối!)
         120/120 jobs complete -> scenario dừng

Kết quả: 120 URL unique được warm, mỗi URL đúng 1 lần ✓
```

**Demo trace 12 VU × 120 iter với identity SAI (dùng __VU)**:

```text
t=0.0s   VU=1: __VU=1 -> URL #1 (lần 1)
         VU=2: __VU=2 -> URL #2 (lần 1)
         ...

t=0.2s   VU=1: __VU=1 -> URL #1 (lần 2)  ← lặp!
         VU=3: __VU=3 -> URL #3 (lần 1)
         ...

t=3.0s   120 iter hoàn thành
         URL #1: warm 15 lần
         URL #2: warm 12 lần
         URL #3: warm 11 lần
         ...
         URL #12: warm 8 lần
         URL #13-#120: warm 0 lần ← 108 URL bỏ sót!

Kết quả: 120 iter, nhưng coverage thật = 12/120 = 10% ❌
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
  const jobIndex = exec.scenario.iterationInTest;  // 0..119
  const isHomefeed = jobIndex < 60;
  if (isHomefeed) { /* warm homefeed */ }
  else { /* warm detail with product id = jobIndex - 60 */ }
  // KHÔNG: const isHomefeed = __VU <= 6;
```

### Nguyên nhân 3: OPERATION SPLIT SENSITIVITY (homefeed/detail split lệch)

**Vấn đề**: Cache warm chỉ hoàn tất khi **cả** homefeed keys và detail keys đều được warm đủ số lượng. Nếu split sai, một trong hai loại cache bị thiếu.

```text
Flow mỗi job:
  Job #0-#59:  GET /api/sim/products/homefeed?...     → expect 200 (homefeed warm)
  Job #60-#119: GET /api/sim/products/:id?...           → expect 200 (detail warm)

Nếu split logic sai:
  - Homefeed warm 80/60 (dư 20)
  - Detail warm 40/60 (thiếu 20!)
  → 20 product detail keys vẫn cold
  → User mở detail page của product đó → cold latency
```

#### OPERATION SPLIT LOGIC — ĐÂY LÀ PHẦN QUAN TRỌNG NHẤT CỦA CASE 05

Khác với case 01 catalog audit (mỗi job gọi cả list + detail), case 05 cache warm có **mỗi job chỉ gọi 1 API** — hoặc homefeed, hoặc detail. Job nào gọi API nào được quyết định bởi **job index** và **split point**.

**Cách split 60/60 hoạt động**:

```text
Config: vus=12, iterations=120

Split logic:
  jobIndex < 60  → cache_warm_homefeed (warm homefeed cache key)
  jobIndex >= 60 → cache_warm_detail   (warm product detail cache key)

Job index   Operation            URL
0           cache_warm_homefeed  /api/sim/products/homefeed?personalized=1&...
1           cache_warm_homefeed  /api/sim/products/homefeed?personalized=1&...
...         ...                  ...
59          cache_warm_homefeed  /api/sim/products/homefeed?personalized=1&...
60          cache_warm_detail    /api/sim/products/product-000?view=full&...
61          cache_warm_detail    /api/sim/products/product-001?view=full&...
...         ...                  ...
119         cache_warm_detail    /api/sim/products/product-059?view=full&...
```

**Demo trace split logic với 12 VU**:

```text
t=0.0s   12 VU start, lấy 12 iter đầu
         VU=1:  iterInTest=0  -> jobIndex=0  < 60  → homefeed warm
         VU=2:  iterInTest=1  -> jobIndex=1  < 60  → homefeed warm
         ...
         VU=12: iterInTest=11 -> jobIndex=11 < 60  → homefeed warm

t=0.2s   VU=1 xong, lấy iterInTest=12 -> jobIndex=12 < 60 → homefeed warm
         VU=3 xong, lấy iterInTest=13 -> jobIndex=13 < 60 → homefeed warm

...      60 iter homefeed hoàn thành ...

t=1.5s   VU=1 xong iter #?? -> lấy iterInTest=60 -> jobIndex=60 >= 60 → detail warm (product #0)
         VU=5 xong iter #?? -> lấy iterInTest=61 -> jobIndex=61 >= 60 → detail warm (product #1)

t=3.0s   iterInTest=119 -> jobIndex=119 >= 60 → detail warm (product #59)
         120/120 complete → dừng

Tổng kết:
  cache_warm_homefeed: 60 request (jobIndex 0..59)
  cache_warm_detail:   60 request (jobIndex 60..119)
  Split đúng 60/60 ✓
```

**Điều gì xảy ra nếu JOBS không chia hết cho 2?**

```text
Trường hợp JOBS = 121 (lẻ):

Cần quyết định split:
  Cách A: floor/ceil
    homefeed = floor(121 / 2) = 60
    detail   = ceil(121 / 2)  = 61
    → split = 60/61

  Cách B: ceil/floor
    homefeed = ceil(121 / 2)  = 61
    detail   = floor(121 / 2) = 60
    → split = 61/60

  Cách C: tỉ lệ (vd 55/45)
    homefeed = floor(121 × 0.55) = 66
    detail   = 121 - 66 = 55
    → split = 66/55

QUAN TRỌNG: Split phải được ĐỊNH NGHĨA TRƯỚC và DOCUMENT trong expected counts.
Không được "để code tự quyết định" rồi sau đó so sánh với expected cũ.
```

**Code pattern cho split**:

Cách 1 — Split cứng bằng hằng số:

```js
const SPLIT_POINT = 60;  // jobIndex < 60 = homefeed, >= 60 = detail
const jobIndex = exec.scenario.iterationInTest;

if (jobIndex < SPLIT_POINT) {
  // Warm homefeed
  const res = http.get(`${BASE_URL}/api/sim/products/homefeed?personalized=1&...`, {
    tags: { operation: "cache_warm_homefeed" },
  });
  check(res, { "homefeed warm 200": (r) => r.status === 200 });
} else {
  // Warm detail
  const productIndex = jobIndex - SPLIT_POINT;
  const productId = `product-${String(productIndex).padStart(3, "0")}`;
  const res = http.get(`${BASE_URL}/api/sim/products/${productId}?view=full&...`, {
    tags: { operation: "cache_warm_detail" },
  });
  check(res, { "detail warm 200": (r) => r.status === 200 });
}
```

Cách 2 — Split động từ JOBS env:

```js
const JOBS = parseInt(__ENV.SI_05_JOBS) || 120;
const SPLIT_POINT = Math.floor(JOBS / 2);  // homefeed = floor(JOBS/2), detail = JOBS - floor(JOBS/2)
// Với JOBS=120: SPLIT_POINT=60, homefeed=60, detail=60
// Với JOBS=121: SPLIT_POINT=60, homefeed=60, detail=61

const expectedHomefeed = SPLIT_POINT;
const expectedDetail = JOBS - SPLIT_POINT;
```

Cách 3 — Interleave (xen kẽ):

```js
const jobIndex = exec.scenario.iterationInTest;

if (jobIndex % 2 === 0) {
  // Even jobs = homefeed
  const res = http.get(`${BASE_URL}/api/sim/products/homefeed?...`, {
    tags: { operation: "cache_warm_homefeed" },
  });
} else {
  // Odd jobs = detail
  const productIndex = Math.floor(jobIndex / 2);
  const res = http.get(`${BASE_URL}/api/sim/products/${productId}?...`, {
    tags: { operation: "cache_warm_detail" },
  });
}
```

**Vì sao interleave pattern có thể tốt hơn cho cache warm?**

```text
Split cứng 60/60:
  - 60 homefeed request liên tiếp trước, sau đó 60 detail
  - Homefeed endpoint nhận burst 60 request từ 12 VU
  - Detail endpoint bắt đầu sau khi homefeed xong
  → Cache warm theo đợt, có thể gây spike tập trung

Interleave (even=homefeed, odd=detail):
  - Homefeed và detail xen kẽ
  - 2 endpoint cùng được warm song song
  - Burst trải đều hơn trên 2 endpoint
  → Cache warm phân tán, ít spike hơn

Chọn pattern nào tùy vào cache architecture:
  - Nếu homefeed và detail cache độc lập: interleave tốt hơn
  - Nếu detail cache phụ thuộc homefeed (vd: homefeed cache chứa list product ID): split cứng để homefeed warm trước
```

### Nguyên nhân 4: COVERAGE VERSUS CACHE-HIT PROOF (200 không chứng minh cache hit)

**Vấn đề**: Request trả về 200 chỉ chứng minh warm call **đã được gửi và nhận response thành công**. Nó **không** chứng minh rằng:

```text
- Cache đã thực sự lưu response (cache write có thể fail âm thầm)
- Response được lưu có đúng key không (cache key mismatch)
- TTL có đủ dài để phục vụ traffic thật không (hết hạn ngay sau warm)
- CDN edge có nhận được cache từ origin không (CDN propagation delay)
- Cache có bị evict ngay sau warm không (memory pressure)
```

**Đời thường**: Gửi thư báo đảm bảo (request 200 = thư đã gửi), nhưng không biết người nhận có đọc không (cache hit = người nhận đã đọc).

**Demo trace: warm call pass nhưng cache vẫn cold**:

```text
Scenario: warm homefeed URL, response 200, nhưng cache không lưu

t=0.0s   VU=1 gửi GET /api/sim/products/homefeed?personalized=1
t=0.2s   Server xử lý: query DB, build response, TRẢ VỀ 200
         NHƯNG: cache write fail (Redis connection timeout, memcached full)
         → Response 200 OK, nhưng cache KHÔNG có key này
t=0.3s   VU=1 check pass: "homefeed warm 200" ✓
         → Job hoàn thành, tưởng cache đã warm

t=10s    User thật truy cập homefeed
         → Cache MISS (vì cache write đã fail ở trên)
         → Server phải query DB lại → cold latency
         → User thấy chậm, dù warm test "pass"
```

**Cách phát hiện (nếu BE expose cache hit metric)**:

```text
Nếu products-service trả về response header:
  X-Cache: HIT / MISS
  X-Cache-Key: /api/sim/products/homefeed?personalized=1

Thì script có thể check:
  check(res, {
    "homefeed warm 200": (r) => r.status === 200,
    "cache populated": (r) => r.headers["X-Cache"] === "MISS",  // Lần đầu gọi phải MISS (chưa có cache)
  });

Và verify round 2 (gọi lại để kiểm cache HIT):
  const res2 = http.get(`${BASE_URL}/api/sim/products/homefeed?...`);
  check(res2, {
    "cache hit after warm": (r) => r.headers["X-Cache"] === "HIT",
  });
```

**Không có cache hit metric thì sao?**

```text
Nếu BE không expose cache hit/miss:
  → Chỉ kết luận được: "120 warm calls đã được gửi, tất cả 200"
  → KHÔNG kết luận được: "cache đã sẵn sàng cho traffic thật"
  → Phải bổ sung caveat: "warm execution proven, cache hit rate unverified"

Đây là giới hạn của case 05 — nó đo execution, không đo cache effect.
Muốn đo cache effect, cần BE expose hit/miss metric hoặc chạy verify pass riêng sau warm.
```

### Nguyên nhân 5: WORKER SKEW IS EXPECTED (phân phối không đều là bình thường)

**Vấn đề**: Với shared-iterations, VU nhanh sẽ lấy nhiều job hơn VU chậm. Đây là **feature**, không phải bug. Nhưng nếu learner không hiểu, họ có thể fail test vì "phân phối không đều".

```text
Tưởng tượng 12 công nhân warm 120 thùng:
  - Công nhân A (nhanh, có kinh nghiệm): 0.1s/thùng -> làm được 22 thùng
  - Công nhân B (bình thường): 0.2s/thùng -> làm được 13 thùng
  - Công nhân L (mới, chậm): 0.4s/thùng -> làm được 5 thùng

  Tổng: 22+13+...+5 = 120 thùng ✓
  Phân phối: không đều, nhưng TẤT CẢ thùng đã được warm

  Người quản lý KHÔNG nói: "Công nhân L làm ít quá, test fail"
  Người quản lý NÓI: "120/120 thùng đã warm xong, test pass"
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
  VU=1: delay=0.1s (nhanh)
  VU=2: delay=0.2s
  VU=3: delay=0.3s
  VU=4: delay=0.4s (chậm)

Timeline:
t=0.0s   4 VU start, cùng lấy iter đầu
         VU=1: iterInTest=0,  sleep(0.1)
         VU=2: iterInTest=1,  sleep(0.2)
         VU=3: iterInTest=2,  sleep(0.3)
         VU=4: iterInTest=3,  sleep(0.4)

t=0.1s   VU=1 xong, lấy iterInTest=4,  sleep(0.1)
t=0.2s   VU=1 xong, lấy iterInTest=5,  sleep(0.1)
         VU=2 xong, lấy iterInTest=6,  sleep(0.2)
t=0.3s   VU=1 xong, lấy iterInTest=7,  sleep(0.1)
         VU=3 xong, lấy iterInTest=8,  sleep(0.3)
t=0.4s   VU=1 xong, lấy iterInTest=9,  sleep(0.1)
         VU=2 xong, lấy iterInTest=10, sleep(0.2)
         VU=4 xong, lấy iterInTest=11, sleep(0.4)
...

Kết quả cuối:
  VU=1: 7 iter  (nhanh nhất -> nhiều nhất)
  VU=2: 4 iter
  VU=3: 3 iter
  VU=4: 2 iter  (chậm nhất -> ít nhất)
  Tổng: 16 iter ✓

Phân phối: 7-4-3-2 (lệch nặng)
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
   - Platform team có danh sách 120 URL/cache keys cần warm
   - Không phải "warm trong 5 phút", mà là "warm ĐỦ 120 URL"
   → iterations = 120 (tổng job toàn scenario)
   → KHÔNG dùng duration làm input chính

2. WORKER POOL SIZE (số worker cùng xử lý):
   - 12 worker cùng warm để xong nhanh hơn
   - Không quan trọng worker nào làm bao nhiêu, miễn tổng đủ
   → vus = 12 (số worker)
   → KHÔNG cần mỗi VU warm đúng 10 URL

3. COVERAGE COMPLETENESS (mỗi job đi qua đúng operation):
   - Mỗi job: HOẶC homefeed HOẶC detail = 1 API call
   - 120 jobs × 1 API = 120 total API calls
   - Trong đó: 60 homefeed + 60 detail
   → http_reqs = 120 (deterministic, nếu không fail)
   → shared_api_calls_total = 120
```

## Yêu cầu cứng của case này

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Tổng completed iterations phải bằng `120` | Vì `120` là kích thước backlog, thiếu 1 job là coverage incomplete. |
| `shared_jobs_total == 120` | Iteration chạy xong chưa đủ; job phải được mark hoàn tất end-to-end. |
| `shared_jobs_failed == 0` | Có failed job nghĩa là business contract không đạt. |
| `http_reqs/shared_api_calls_total == 120 × 1 = 120` | Mỗi job phải gọi đúng số API trong flow. |
| Operation counts phải khớp expected breakdown | Tổng HTTP đúng nhưng thiếu một operation vẫn là coverage bug. |
| Job identity phải derive từ `exec.scenario.iterationInTest` | Worker identity `__VU` không đại diện cho business job. |
| Uneven per-VU distribution is normal | Worker nhanh xử lý nhiều job hơn là đúng mô hình shared pool. |
| Split logic phải được định nghĩa trước | Nếu JOBS đổi, split phải recompute — không dùng expected cũ. |

Nếu một trong các invariant về count/job fail, kết quả nên coi là **invalid hoặc fail**, không phải "pass nhưng hơi thiếu".

## Vì sao "cache warm fixed URL backlog" nên dùng `shared-iterations`?

Mental model đúng:

```text
120 jobs đang nằm trong một queue/backlog.
12 VUs là 12 workers.
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
| `SI_05_VUS` | 12 | Số worker cùng xử lý backlog |
| `SI_05_JOBS` | 120 | Tổng số job toàn scenario |
| `maxDuration` | 8m | Safety cap, không phải target duration |
| `executor` | `shared-iterations` | Fixed global backlog + worker pool |

Mapping quan trọng:

```text
business backlog size = 120 jobs
k6 iterations         = 120
worker pool size      = 12 VUs
expected API calls    = 120 × 1 = 120
```

`maxDuration` chỉ là safety cap. Nếu cap này cắt run làm `iterations < 120`, kết quả không valid vì backlog chưa drain hết.

Operation coverage expected:

```text
cache_warm_homefeed: 60
cache_warm_detail: 60
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

Nếu script cần chọn business object như product/order/event/item/report/checklist, derive từ:

```js
exec.scenario.iterationInTest
```

Không derive từ:

```js
__VU
```

vì `__VU` chỉ nói worker nào đang cầm job hiện tại.

### Identity model chi tiết: `__VU` vs `__ITER` vs `iterationInTest`

Đây là điểm quan trọng nhất khi code shared-iterations script. Ba khái niệm khác nhau:

```text
__VU:
  - Worker ID, từ 1 đến vus
  - VU=1 có thể chạy iter #0, #3, #7, #12... (nhiều job khác nhau)
  - KHÔNG dùng làm URL index, product ID, cache key selector

__ITER:
  - Local counter của từng VU, bắt đầu từ 0
  - VU=1: __ITER=0 → iter #0, __ITER=1 → iter #3, __ITER=2 → iter #7...
  - KHÔNG phải global job index
  - VU=1 __ITER=4 và VU=2 __ITER=4 là 2 job KHÁC NHAU

exec.scenario.iterationInTest:
  - Global job index, từ 0 đến iterations-1
  - DUY NHẤT cho mỗi iteration trong toàn scenario
  - Dùng làm business identity: quyết định warm homefeed hay detail, chọn product ID...
```

**Demo trace identity model với 3 VU, 12 iter (cache warm)**:

```text
Config: vus=3, iterations=12, split point = 6

t=0.0s   VU=1: __VU=1, __ITER=0, iterationInTest=0  -> job #0  (homefeed)
         VU=2: __VU=2, __ITER=0, iterationInTest=1  -> job #1  (homefeed)
         VU=3: __VU=3, __ITER=0, iterationInTest=2  -> job #2  (homefeed)

t=0.2s   VU=1 xong, lấy tiếp:
         VU=1: __VU=1, __ITER=1, iterationInTest=3  -> job #3  (homefeed)

t=0.3s   VU=2 xong, lấy tiếp:
         VU=2: __VU=2, __ITER=1, iterationInTest=4  -> job #4  (homefeed)

t=0.4s   VU=1 xong, lấy tiếp:
         VU=1: __VU=1, __ITER=2, iterationInTest=5  -> job #5  (homefeed)

t=0.5s   VU=3 xong, lấy tiếp:
         VU=3: __VU=3, __ITER=1, iterationInTest=6  -> job #6  (detail! product #0)

... tiếp tục đến iterationInTest=11 (job #11, detail product #5)

Tổng kết:
  VU=1 (nhanh): __ITER=0..5 (6 jobs), iterationInTest=0,3,5,7,9,11
  VU=2 (vừa):   __ITER=0..3 (4 jobs), iterationInTest=1,4,8,10
  VU=3 (chậm):  __ITER=0..1 (2 jobs), iterationInTest=2,6
  Total: 6+4+2 = 12 jobs ✓
  Homefeed: iterationInTest 0..5 = 6 jobs ✓
  Detail:   iterationInTest 6..11 = 6 jobs ✓

Code đúng:
  const jobIndex = exec.scenario.iterationInTest;  // 0..11
  if (jobIndex < 6) {
    // homefeed warm
  } else {
    const productId = `product-${String(jobIndex - 6).padStart(3, "0")}`;
    // detail warm
  }

Code sai:
  const isHomefeed = __VU <= 2;  // VU=1,2 -> homefeed, VU=3 -> detail
  // Homefeed: VU=1,2 (9 jobs lặp), Detail: VU=3 (2 jobs lặp)
  // Split 9/2 thay vì 6/6 → coverage lệch hoàn toàn
```

### Vì sao KHÔNG có per-VU state như per-vu-iterations?

Trong per-vu-iterations, mỗi VU có state riêng (session, token, cart) sống qua nhiều iteration vì cùng VU luôn chạy iter cho cùng identity.

Trong shared-iterations, **không có per-VU persistent state hữu ích** vì:

```text
VU=1 chạy job #0 (homefeed), xong chạy job #3 (homefeed), xong chạy job #7 (detail product #1)...
→ Mỗi job là một URL/cache key khác nhau
→ State của job #0 không dùng được cho job #7
→ Không cần giữ session/token/state giữa các iter trong cùng VU
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

### Nguyên nhân kỹ thuật 1: Finite URL/cache-key backlog

Cache warm là danh sách keys cần touch một lần. `shared-iterations` map trực tiếp: mỗi global job là một URL/cache key.

**Real-world analogy**: Giống như warm-up 120 máy trong nhà máy trước khi sản xuất. Mỗi máy cần được bật và chạy thử 1 lần. Không máy nào được bỏ sót — nếu bỏ sót, khi dây chuyền chạy thật, máy đó khởi động chậm làm tắc cả line.

**Demo trace với JOBS=120, vus=12**:

```text
Backlog: [URL#0, URL#1, URL#2, ..., URL#119]
12 workers cùng lấy từ đầu queue.
Queue empty khi 120/120 đã được lấy → dừng.

Không worker nào biết "còn bao nhiêu URL trong queue".
Không worker nào bị assign cố định "làm URL #X đến #Y".
Atomic counter đảm bảo mỗi URL được lấy ĐÚNG 1 LẦN.
```

**Cách phát hiện**: `iterations < 120` → coverage incomplete. Kiểm tra `interrupted` count, `maxDuration` setting, và `iter_time` để tìm nguyên nhân.

### Nguyên nhân kỹ thuật 2: Cache key composition

URL, product id, geo/device headers, và query params đều có thể tạo cache key khác nhau. Job index phải drive đúng key coverage.

**Real-world analogy**: Mỗi ổ khóa (cache key) cần đúng chìa (request). Nếu bạn có 120 ổ khóa nhưng chỉ có 60 chìa, 60 ổ còn lại không mở được.

**Các thành phần tạo cache key trong case này**:

```text
Homefeed cache key = f(endpoint, personalized flag, geo header?, device type?)
  /api/sim/products/homefeed?personalized=1  → có thể là 1 key
  /api/sim/products/homefeed?personalized=0  → key khác
  Thêm geo header → key khác nữa
  Thêm device type → key khác nữa

Detail cache key = f(endpoint, product_id, view mode, include_reviews)
  /api/sim/products/product-000?view=full&include_reviews=1  → 1 key
  /api/sim/products/product-001?view=full&include_reviews=1  → key khác
  Cùng product-000 nhưng view=summary → key khác nữa
```

**Demo: cache key coverage với job index**:

```text
Job index drive các yếu tố tạo cache key:

jobIndex < 60 (homefeed):
  - endpoint: /api/sim/products/homefeed
  - personalized: 1 (cố định)
  - cache key: homefeed_personalized_{variant}
  - 60 jobs = 60 lần warm cùng endpoint, nhưng personalized query có thể
    tạo các cache key variant khác nhau (vd: backend personalization theo user segment)

jobIndex >= 60 (detail):
  - endpoint: /api/sim/products/{productId}
  - productId: derive từ jobIndex - 60
  - cache key: detail_{productId}_{viewMode}
  - 60 jobs = 60 product detail keys khác nhau
```

**Cách phát hiện**: Nếu operation count đúng nhưng cache vẫn miss → cache key composition không khớp expected. Kiểm tra xem query params, headers có được set đúng để tạo cache key mong muốn không.

### Nguyên nhân kỹ thuật 3: Coverage versus cache-hit proof

Request 200 chứng minh warm call đã được gửi. Nó chưa chứng minh future cache hit rate nếu BE không expose hit/miss metric.

**Real-world analogy**: Bạn bật lò nướng, đèn báo sáng (200 OK), nhưng không có nhiệt kế để biết lò đã đủ nóng chưa. Khi bỏ bánh vào, bánh có thể vẫn sống vì lò chưa đạt nhiệt độ.

**Các cấp độ chứng minh của cache warm**:

```text
Cấp 1 — Execution proof (case này đạt được):
  "120 warm calls đã được gửi, tất cả response 200"
  → Chứng minh: request đã đến server, server xử lý OK
  → KHÔNG chứng minh: cache đã lưu response

Cấp 2 — Cache write proof (cần BE expose header):
  "120 warm calls, response header X-Cache-Status=stored"
  → Chứng minh: cache layer đã ghi nhận response
  → KHÔNG chứng minh: cache sẽ hit khi user gọi (TTL, eviction)

Cấp 3 — Cache hit proof (cần verify pass):
  "120 warm calls, sau đó 120 verify calls, 100% cache HIT"
  → Chứng minh: cache đã sẵn sàng, user sẽ hit
  → Đây là gold standard, cần 2 pass (warm + verify)
```

**Cách phát hiện**:

```text
Nếu có cache hit header:
  - Thêm check X-Cache header trong warm script
  - Hoặc chạy scenario verify riêng sau warm

Nếu không có cache hit header:
  - Chỉ kết luận "warm execution complete"
  - Thêm caveat vào report: "cache hit rate not verified"
  - Không claim "cache đã sẵn sàng" nếu không có proof
```

### Nguyên nhân kỹ thuật 4: Operation split sensitivity

Default 120 jobs split 60 homefeed + 60 detail. Nếu đổi JOBS, expected split phải recompute.

**Real-world analogy**: Chia 120 quả cam cho 2 giỏ (homefeed, detail). Nếu tự nhiên có 121 quả, phải quyết định giỏ nào nhận thêm 1 quả. Không thể tiếp tục dùng công thức "mỗi giỏ 60 quả".

**Demo: split thay đổi khi JOBS thay đổi**:

```text
JOBS = 120: homefeed=60, detail=60 (split point = 60)
JOBS = 121: homefeed=60, detail=61 (split point = 60, floor)
            HOẶC homefeed=61, detail=60 (split point = 61, ceil)
JOBS = 100: homefeed=50, detail=50 (split point = 50)
JOBS = 150: homefeed=75, detail=75 (split point = 75)
JOBS = 80:  homefeed=40, detail=40 (split point = 40)

Với mỗi JOBS mới, phải recompute:
  - Split point
  - Expected homefeed count
  - Expected detail count
  - K6 config iterations
  - Expected http_reqs
```

**Cách phát hiện**: So sánh operation count thực tế với expected count đã recompute. Nếu `cache_warm_homefeed + cache_warm_detail != http_reqs` → split logic bug. Nếu `cache_warm_homefeed != expected_homefeed` → split point sai.

## Service/API flow

| Operation | Method | Path | Service | Expected | Expected count | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| cache_warm_homefeed | `GET` | `/api/sim/products/homefeed?personalized=1&cpu_ms=2&db_rows=5&json_items=16` | products-service | `200` | 60 | Warm homefeed cache key. |
| cache_warm_detail | `GET` | `/api/sim/products/:id?view=full&include_reviews=1&cpu_ms=2&db_rows=2` | products-service | `200` | 60 | Warm product detail cache key. |

Một job chỉ được coi là hoàn tất khi các operation cần thiết của job đó đã pass theo contract.

### Khác biệt chính với case 01 catalog audit

| Tiêu chí | Case 01 (catalog audit) | Case 05 (cache warm) |
| --- | --- | --- |
| API per job | 2 (list + detail) | 1 (homefeed HOẶC detail) |
| Job flow | Mỗi job gọi CẢ list và detail | Mỗi job gọi CHỈ MỘT operation |
| Total API calls | 80 × 2 = 160 | 120 × 1 = 120 |
| Split logic | Không cần — mỗi job tự gọi đủ 2 API | CẦN — job index quyết định operation |
| Mục tiêu | Verify correctness của endpoint | Warm cache cho traffic sắp tới |
| Pass criteria | List VÀ detail đều pass | Từng operation pass, tổng coverage đủ |

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
| `case_id` | Case đang chạy, ví dụ `si-05-cache-warm`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service đang được gọi. |
| `operation` | Bước nghiệp vụ/API cụ thể trong job. |
| `endpoint` | Nhóm endpoint/API family. |
| `job_id` | Business job trong backlog, derive từ global job index. |
| `executor_family` | `shared_iterations`. |
| `workload_shape` | `fixed_backlog`. |

Tags case này:

```text
case_id       = si-05-cache-warm
business_case = cache_warm_after_deploy
service       = products-service
```

## Pass criteria

Pass criteria tối thiểu:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == 120
shared_jobs_failed count == 0
iterations count == 120
http_reqs count == 120
shared_api_calls_total count == 120
```

Operation breakdown phải khớp:

```text
cache_warm_homefeed: 60
cache_warm_detail: 60
```

Đừng thêm pass condition kiểu:

```text
mỗi VU phải xử lý 120 / 12 = 10 jobs
```

Vì đó không phải invariant của `shared-iterations`.

## Cách chạy

> Đường dẫn BE do bộ target cung cấp:

```text
k6-metrics-server/load-target/k6/shared-iterations/si-05-cache-warm.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run .\k6-metrics-server\load-target\k6\shared-iterations\si-05-cache-warm.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-05-cache-warm.js
```

Nếu backend script chưa có trong working tree, chỉ đọc phần expected formula trước; không tự điền run data.

## Đọc output summary

Áp 5 bước giống cách đọc các case per-vu, nhưng invariant đổi sang **total backlog**, không phải per-user quota.

### Bước 1 — Verify scenario/config

Header phải thể hiện:

```text
executor = shared-iterations
vus = 12 hoặc env override
total iterations/jobs = 120 hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ expected counts.

### Bước 2 — Compute expected total jobs

Default case này:

```text
JOBS = 120
API_PER_JOB = 1
expected iterations = 120
expected http_reqs = 120 × 1 = 120
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
→ Đặc biệt với cache warm: backend đang cold chính là nguyên nhân iter_time cao.
  Nếu backend quá cold, tăng maxDuration hoặc chấp nhận warm chậm hơn.
```

Nếu `iterations == 120` nhưng `shared_jobs_total < 120`:

```text
iteration chạy xong nhưng job completion instrumentation/business branch bị thiếu
→ Kiểm script: có gọi jobDone() sau mỗi iteration không?
→ Có exception/early return nào bỏ qua job completion không?
→ Split logic có nhánh nào không gọi jobDone() không?
```

### Bước 4 — Compare API and operation counts

Expected:

```text
http_reqs == 120
shared_api_calls_total == 120
cache_warm_homefeed: 60
cache_warm_detail: 60
```

Tổng HTTP đúng nhưng operation split sai vẫn là coverage bug:

```text
VD: http_reqs = 120, nhưng:
  cache_warm_homefeed: 80
  cache_warm_detail: 40
→ 20 detail URL chưa được warm (bị skip)
→ 20 homefeed warm dư (lãng phí)
→ Detail coverage = 40/60 = 67% -> FAIL

Hoặc:
  cache_warm_homefeed: 70
  cache_warm_detail: 50
→ 10 homefeed URL thiếu, 10 detail URL thiếu
→ Cả 2 operation đều incomplete
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

Hai metric này khác nhau. Trong case 05, mỗi job chỉ có 1 API nên `shared_job_duration_ms ≈ http_req_duration` (cộng thêm overhead script). Nhưng nếu script có thêm check, logging, hoặc processing, gap có thể lớn hơn.

Case-specific summary notes:

- `iterations = 120` chứng minh 120 warm jobs chạy.
- `http_reqs = 120` vì mỗi job warm đúng một URL.
- Default split cần là homefeed 60 và detail 60.
- Nếu JOBS thay đổi (qua env `SI_05_JOBS`), split phải được recompute.
- Warm execution proven, cache hit rate unverified (trừ khi BE expose cache header).

Không check mỗi VU làm bằng nhau. Invariant là total completed work, không phải equal work per VU.

## Đọc dashboard real-time charts cho case 05

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
cache_warm_homefeed: 60
cache_warm_detail: 60
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
4. Spike xảy ra ở operation nào (homefeed hay detail)?
```

Với case 05, shape đẹp thường có:

```text
đầu run:  p95/max CÓ THỂ CAO HƠN HẲN (cold start — đây là ĐẶC TRƯNG của cache warm!)
giữa run: p95 giảm dần và ổn định thấp hơn (cache bắt đầu ấm)
cuối run: p95 thấp nhất (cache đã warm hoàn toàn)
```

**Vì sao đầu run của cache warm CAO HẲN so với case khác?**

```text
Đây là bản chất của cache warm — KHÔNG phải bug:

- Request đầu tiên tới server: cache MISS → query DB → build response → write cache
  → Latency = DB query time + response build + cache write
  → Đây là COLD LATENCY, chính là thứ cache warm muốn loại bỏ

- Request thứ 2+ tới cùng URL: cache HIT → trả response từ cache
  → Latency = cache read time (rất thấp)
  → Đây là WARM LATENCY, traffic thật sẽ thấy

→ Shape latency "cao đầu, thấp dần" là CHUẨN cho cache warm
→ Nếu latency ĐỀU từ đầu đến cuối → cache có thể không hoạt động
→ Nếu latency CAO ở cuối → có vấn đề khác (leak, resource exhaustion)
```

Case-specific bottleneck hints:

- Homefeed có `personalized`, `db_rows`, `json_items`; có thể nặng hơn detail.
- Detail có product id/reviews; nếu spike chỉ ở detail, investigate detail cache/origin.
- Response 200 không tự chứng minh hit rate; cần cache hit/miss metric nếu muốn kết luận đó.
- Nếu latency đầu run và cuối run giống hệt nhau → cache layer có thể không hoạt động (mọi request đều cold).

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 cao ngay từ đầu rồi ổn định thấp | cold start bình thường, cache warm hiệu quả | OK, đây là expected pattern |
| p95 cao từ đầu đến cuối, không giảm | cache không hoạt động, mọi request đều cold | kiểm cache layer (Redis, CDN, in-memory) |
| p95 tăng dần càng về cuối | leak, state phình trong backend | soi job_duration theo job_id |
| max spike lẻ tẻ nhưng p95 ổn | vài outlier đơn lẻ | xem log nhưng chưa vội fail |
| p95 và max cùng spike nhiều bucket | vấn đề hệ thống thật | chặn / điều tra backend |
| homefeed p95 >> detail p95 | homefeed query nặng hơn (personalized, json_items) | bình thường, nhưng nếu quá cao thì kiểm homefeed pipeline |
| detail p95 >> homefeed p95 | detail query chậm (JOIN reviews, thiếu index) | route về detail pipeline |
| p95 đầu run = p95 cuối run | cache không hoạt động | kiểm cache hit ratio, cache config |

### Chart 2 — Execution timeline

Chart này chứng minh backlog drain đủ theo thời gian.

Kiểm tổng bucket:

```text
sum(iterations buckets) == 120
sum(http_reqs buckets) == 120
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
  Live VUs = config VUs (12)
  RPS cao vì tất cả VU cùng hoạt động
  Nhưng iteration có thể = 0 trong bucket đầu (job chưa kịp complete)

giữa run:
  Live VUs vẫn gần 12 nếu backlog còn nhiều
  iterations tăng đều theo bucket
  RPS ổn định

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
| `http_reqs` đủ nhưng operation split sai | tổng request đủ nhưng coverage lệch (homefeed/detail) |
| `shared_jobs_failed > 0` | business failure dù HTTP có thể vẫn 200 |
| buckets không cộng ra summary | đọc nhầm point/bucket hoặc data chưa final |
| Live VUs không lên đủ 12 từ đầu | VU init có vấn đề, config/env sai |
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
- 12 VU cùng chạy (mỗi VU đang ở 1 job khác nhau)
- Nhiều HTTP request hoàn thành (cả homefeed + detail)
- Một số iteration/job hoàn thành
- Nhiều check pass/fail
```

Điều kiện để một event rơi vào bucket nào:

```text
event timestamp thuộc giây nào -> rơi vào bucket giây đó
```

#### Vì sao bucket đầu có thể có httpReqs > 0 nhưng iterations = 0?

```text
Bucket đầu: VU vừa start, request đầu đã xong (1 API call)
nhưng full job (request + check + instrumentation) chưa hoàn tất

→ httpReqs > 0 (request-level metric đến sớm)
→ iterations = 0 (job-level metric đến muộn hơn, cần full flow xong)
```

### Chart 3 — VUs vs iter/s

Chart này giải thích worker-pool shape:

```text
- VUs gần 12 khi backlog còn nhiều việc
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
         ≈ 12 / iter_time

Nếu iter_time avg = 0.2s:
  peak_rate ≈ 12 / 0.2 ≈ 60 iter/s

Nếu iter_time avg = 0.5s:
  peak_rate ≈ 12 / 0.5 ≈ 24 iter/s
```

Đừng đọc chart này thành:

```text
mỗi VU phải xử lý 120 / 12 = 10 jobs
```

Với `shared-iterations`, đó là yêu cầu sai.

Shape mong đợi:

```text
- đầu run: iter/s có thể 0 (chưa job nào xong)
- giữa run: iter/s dao động theo batch hoàn thành
- cuối run: iter/s tụt khi backlog gần hết, rồi về 0
- đường VUs: gần 12 ở đầu/giữa, tụt ở cuối
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| `Actual iter/s` đầu = 0, sau đó tăng | job đầu chưa hoàn tất | bình thường |
| `Actual iter/s` dao động theo bucket | nhiều job finish không cùng thời điểm | bình thường |
| `Actual iter/s` = 0 lâu trong khi VUs cao | VU bị kẹt trong request, backend chậm | cần điều tra |
| `Actual iter/s` tụt về 0 và VUs cũng về 0 | test xong quota | bình thường |
| sum `Actual iter/s` < expected total | thiếu iteration / drop / interrupt | test invalid |
| VUs không lên tới 12 | config/env sai, VU init lỗi | kiểm header |
| `Actual iter/s` cao bất thường ở đầu | cold start — request nhanh hơn vì server chưa tải | bình thường với cache warm |

### Cách chốt từ summary -> 3 chart

```text
1. Summary quyết định pass/fail bằng counters/thresholds.
2. Execution timeline xác nhận backlog drain đủ theo thời gian.
3. Response time tìm operation/service chậm.
4. VUs vs iter/s giải thích worker pool hoạt động ra sao.
5. Business decision dựa trên total coverage + failed jobs + operation breakdown.
```

## Kết luận thực tế: output -> quyết định

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **cache warm gate**: output ra số như vậy thì team quyết định gì với việc ramp traffic?

### Kịch bản A — output sạch: CACHE WARM PASS

```text
iterations.........: 120         (đủ backlog)
http_req_failed....: 0.00%
shared_jobs_total..: 120
shared_jobs_failed.: 0
cache_warm_homefeed: 60
cache_warm_detail..: 60
iteration_duration.: p(95)=0.35s
```

Kết luận thực tế:

```text
- Count đủ 120 -> toàn bộ URL đã được warm (yêu cầu a)
- 0 fail, 0 job failed -> không URL nào lỗi
- Operation breakdown đúng 60/60 -> cả homefeed và detail đều đủ coverage
- p95 0.35s -> latency OK
=> QUYẾT ĐỊNH: cache warm OK. Cho phép ramp traffic.
   (Kèm caveat: nếu BE không expose cache hit metric, chỉ chứng minh execution,
    không chứng minh cache hit rate)
```

### Kịch bản B — count đủ nhưng homefeed fail, detail pass: BLOCK

```text
iterations.........: 120         (vẫn đủ!)
shared_jobs_total..: 120
shared_jobs_failed.: 15          ← CÓ 15 JOB FAIL
cache_warm_homefeed: 45          ← THIẾU 15 HOMEFEED
cache_warm_detail..: 60          ← detail vẫn đủ
```

Kết luận thực tế:

```text
- Count vẫn 120 -> KHÔNG phải lỗi test, coverage attempt đủ
- Nhưng 15 job failed -> 15 homefeed URL không warm được
- Homefeed chỉ có 45/60 -> thiếu 15 homefeed cache keys
- Detail vẫn 60/60 -> detail path OK
=> QUYẾT ĐỊNH: BLOCK ramp traffic. Homefeed bị lỗi, user vào trang chủ
   sẽ gặp cold latency. Điều tra homefeed pipeline (personalized query, DB).
   Detail OK, có thể ramp riêng detail traffic nếu cần.
```

### Kịch bản C — count đủ nhưng detail fail, homefeed pass: BLOCK

```text
iterations.........: 120
shared_jobs_total..: 120
shared_jobs_failed.: 10
cache_warm_homefeed: 60          ← homefeed đủ
cache_warm_detail..: 50          ← THIẾU 10 DETAIL
```

Kết luận thực tế:

```text
- Homefeed 60/60 -> homefeed cache OK
- Detail 50/60 -> thiếu 10 product detail cache keys
- 10 product detail page sẽ cold khi user đầu tiên click vào
=> QUYẾT ĐỊNH: BLOCK. Điều tra detail path (product query, reviews JOIN).
   Homefeed OK nên trang chủ an toàn, nhưng detail page thì không.
```

### Kịch bản D — thiếu iteration: TEST INVALID

```text
iterations.........: 85          (THIẾU 35!)
http_req_failed....: 0.5%
interrupted........: 35
```

Kết luận thực tế:

```text
- 85 < 120 -> backlog chưa drain hết -> KHÔNG kết luận được cache warm có OK không
- Trước khi nói gì về cache, phải sửa cho test chạy đủ 120 đã:
    interrupted=35 -> maxDuration quá ngắn? Tăng maxDuration.
    Hoặc iter_time quá dài? Backend đang quá cold -> chấp nhận warm chậm hơn,
    tăng maxDuration hoặc giảm vus để giảm áp lực.
=> QUYẾT ĐỊNH: CHƯA kết luận cache warm pass/fail. Test invalid, chạy lại
   sau khi sửa nguyên nhân thiếu count.
```

### Kịch bản E — count đủ, operation split sai: COVERAGE BUG

```text
iterations.........: 120
http_reqs..........: 120         (tổng đúng!)
cache_warm_homefeed: 70          ← DƯ 10
cache_warm_detail..: 50          ← THIẾU 10
```

Kết luận thực tế:

```text
- Tổng http_reqs = 120 -> nhìn qua tưởng đúng
- Nhưng homefeed=70, detail=50 -> 10 detail URL bị skip
- Có thể do split point bị hardcode sai (dùng 70 thay vì 60)
- Hoặc split logic dùng ceil thay vì floor khi JOBS lẻ
=> QUYẾT ĐỊNH: BLOCK. Sửa script split logic.
   Đây là lỗi coverage ẩn — tổng HTTP đúng không có nghĩa coverage đúng.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 120 iter, homefeed=60, detail=60, 0 fail | cache warm hoàn tất, mọi URL OK | cho phép ramp traffic (với cache-metric caveat) |
| 120 iter, shared_jobs_failed > 0 | có URL/business job lỗi | block, route theo job_id |
| 120 iter, homefeed < 60 | homefeed cache coverage incomplete | block, kiểm homefeed pipeline |
| 120 iter, detail < 60 | detail cache coverage incomplete | block, kiểm detail pipeline |
| < 120 iter (drop/interrupt) | test chưa hợp lệ, backlog chưa drain hết | sửa config, chạy lại |
| http_reqs = 120 nhưng operation split sai | coverage gap ẩn | sửa script split logic, kiểm branch |
| Counts pass nhưng p95 cao | functional pass, latency risk | investigate products-service |
| VU distribution uneven | normal worker-pool behavior | do not fail |
| Counts pass, latency đầu cao cuối thấp | cold start pattern bình thường | OK, cache warm đang hoạt động |
| Counts pass, latency đều từ đầu đến cuối | cache có thể không hoạt động | kiểm cache layer |
| Counts pass, không có cache hit metric | warm execution proven, hit rate unverified | thêm caveat, không claim cache sẵn sàng |

Điểm cốt lõi của case này: **vì count luôn cố định 120, mọi thiếu hụt ở operation breakdown hoặc failed jobs đều là tín hiệu THẬT về cache warm, không bị nhiễu bởi "lần này test chạy nhiều/ít hơn lần trước"**. Đó là lý do cache warm gate dùng shared-iterations.

## "Nghịch lý" và misconceptions của cache warm với shared-iterations

### Nghịch lý 1: 120 jobs nhưng chỉ 60 URL unique?

```text
120 jobs = 120 warm calls
Nhưng operation breakdown: 60 homefeed + 60 detail
→ Homefeed: 60 calls cùng 1 endpoint! Vậy chỉ warm 1 URL?

Trả lời: KHÔNG. 60 homefeed calls CÓ THỂ warm 60 cache keys KHÁC NHAU.

Cơ chế:
  /api/sim/products/homefeed?personalized=1
  → Backend personalization có thể tạo response khác nhau cho mỗi request
    dù cùng URL (dựa trên user segment, geo, device...)
  → CDN/backend cache có thể cache theo VARY header
  → Mỗi variant personalization = 1 cache key riêng

  Và QUAN TRỌNG HƠN: 60 calls là 60 LẦN TOUCH cache.
  Mỗi lần touch giúp cache "ấm" hơn (cache warming cần nhiều hit để
  cache policy quyết định giữ lại, TTL được refresh...)

Tóm lại:
  - Detail: 60 URL unique thật sự (60 product ID khác nhau)
  - Homefeed: 60 lần warm khác nhau (có thể cùng endpoint nhưng khác variant,
    hoặc đơn giản là cache cần nhiều hit để thực sự ấm)
```

### Nghịch lý 2: Warm call pass (200 OK) nhưng cache vẫn cold?

```text
"Test pass hết, 120/120 request 200. Vậy cache chắc chắn đã warm?
 → Không. 200 OK chứng minh request thành công, không chứng minh cache đã lưu."

Tình huống cache write fail âm thầm:
  1. Request đến server
  2. Server query DB, build response (200 OK)
  3. Server TRẢ VỀ response cho client -> client thấy 200 ✓
  4. Server GHI VÀO CACHE -> cache write fail (timeout, full, config sai)
  5. Client không hề biết bước 4 fail -> test PASS
  6. User thật gọi -> cache MISS -> cold latency

Tình huống cache TTL quá ngắn:
  1. Warm 120 URL, tất cả cache write OK
  2. Nhưng TTL = 10s (quá ngắn cho warm window)
  3. 15 giây sau warm xong, cache hết hạn
  4. Traffic thật vào -> cache MISS

Tình huống CDN propagation delay:
  1. Warm origin cache (backend Redis/memcached) -> OK
  2. Nhưng CDN edge cache chưa nhận được từ origin
  3. User gọi qua CDN -> CDN MISS -> CDN gọi origin (có thể vẫn OK nếu origin đã warm)

Giải pháp:
  - Add cache hit verification step (gọi lại sau warm để check X-Cache: HIT)
  - Dùng cache header nếu BE có expose
  - Không claim "cache sẵn sàng" nếu chỉ có execution proof
```

### Nghịch lý 3: iteration_duration = 0.2s nhưng iter/s = 60?

```text
iteration_duration: avg=0.2s     <- 1 job mất 0.2 giây
iterations:         60/s         <- nhưng 1 giây ra 60 job

Sao 1 job mất 0.2s mà mỗi giây lại ra được 60 job?
"Lẽ ra 0.2s mới ra 1 job -> 1s ra 5 job chứ?"
```

**Trả lời: vì 12 VU chạy SONG SONG, không phải 1 VU.**

```text
iteration_duration = thời gian 1 VU làm xong 1 job = 0.2s
iterations rate    = tổng job hoàn thành / tổng thời gian (cả pool) = 60/s

Công thức nối 2 con số (Little's Law):
  rate = vus / iter_time
  60 ≈ 12 / 0.2 ✓

Ví dụ trực quan:
  12 công nhân, mỗi người warm 1 thùng mất 0.2 phút:
    - 1 thùng VẪN mất 0.2 phút (không nhanh hơn)
    - nhưng 12 người warm song song -> mỗi phút ra ~60 thùng
```

### Nghịch lý 4: VU=12, jobs=120, sao có VU làm 20 job, VU khác chỉ 5?

```text
Đây là câu hỏi phổ biến nhất từ learner chuyển từ per-vu-iterations sang.

Trong per-vu-iterations:
  iterations=10, vus=12 -> mỗi VU chạy ĐÚNG 10 iter = 120 total
  → Phân phối ĐỀU (mỗi VU 10)

Trong shared-iterations:
  iterations=120, vus=12 -> tổng 120 iter, CHIA KHÔNG ĐỀU
  → VU nhanh: 20 iter, VU chậm: 5 iter
  → Tổng = 120, nhưng phân phối LỆCH
```

Vì sao? Vì cơ chế atomic counter "first come first served":

```text
VU nào xong job -> gọi atomic.AddUint64 -> lấy job tiếp theo
VU nhanh (network tốt, latency thấp) -> xong sớm -> gọi sớm -> lấy nhiều
VU chậm (network kém, latency cao) -> xong muộn -> gọi muộn -> lấy ít

Đây là ĐẶC TRƯNG của worker pool, không phải bug.
Giống như: công nhân nhanh làm nhiều thùng hơn công nhân chậm.
```

### Nghịch lý 5: Tổng http_reqs = 120 nhưng shared_jobs_total chỉ = 115?

```text
http_reqs = 120 -> 120 HTTP requests đã hoàn thành
shared_jobs_total = 115 -> nhưng chỉ 115 job được mark complete

5 job (5 HTTP requests) đã chạy xong HTTP, nhưng job không được mark done.
→ Có thể do: exception sau HTTP request, check fail, hoặc code branch
   bỏ qua job completion instrumentation.

Cách debug:
  - Kiểm script: có try/catch bỏ qua jobDone() không?
  - Kiểm shared_jobs_failed: 5 job đó có bị mark failed không?
  - Nếu không failed cũng không total -> instrumentation gap
```

## Checklist đọc biểu đồ case 05

Khi học sinh nhìn dashboard case 05, đọc theo thứ tự này:

```text
1. Overview KPI
   - iterations = 120?
   - http_req_failed = 0%?
   - checks = 100%?

2. Response time chart
   - Tách theo operation (homefeed vs detail) chưa?
   - Operation nào chậm hơn?
   - batch p95 đầu có spike không? (cold start pattern — BÌNH THƯỜNG)
   - cuối test còn spike không? (nếu còn -> vấn đề)
   - p95 giảm dần theo thời gian không? (cache warming pattern)
   - Nếu p95 đều từ đầu đến cuối -> cache có hoạt động không?

3. Execution timeline
   - Live VUs đầu có = 12 không?
   - cuối run VUs có tụt dần về 0 không?
   - sum iterations theo bucket có = 120 không?
   - sum http_reqs theo bucket có = 120 không?
   - sum shared_jobs_total theo bucket có = 120 không?
   - shared_jobs_failed có = 0 ở mọi bucket không?

4. VUs vs iter/s
   - Actual iter/s theo bucket dao động thế nào?
   - sum actual iter/s có = 120 không?
   - VUs có giữ gần 12 ở đầu/giữa run không?
   - Cuối run VUs có tụt về 0 không?

5. Business decision
   - Tất cả counters pass?
   - Operation breakdown đúng 60/60?
   - shared_jobs_failed = 0?
   - Nếu tất cả pass -> cache warm PASS
   - Nhớ caveat: warm execution proven, cache hit rate unverified
```

Kết luận của run case 05 đang đúng nếu thấy:

```text
iterations = 120
http_req_failed = 0%
checks = 100%
shared_jobs_total = 120
shared_jobs_failed = 0
cache_warm_homefeed = 60
cache_warm_detail = 60
Live VUs: đầu = 12, cuối giảm về 0
sum chart iterations = summary iterations
sum chart httpReqs = summary http_reqs
executor = shared-iterations
```

## Code pattern đúng cho cache warm với operation split

### Pattern chính: split cứng với hằng số

```js
import exec from "k6/execution";
import { check, sleep } from "k6";
import http from "k6/http";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";
const JOBS = parseInt(__ENV.SI_05_JOBS) || 120;
const SPLIT_POINT = 60;  // jobIndex < 60 = homefeed, >= 60 = detail

export default function () {
  // Lấy global job index — ĐÂY LÀ DÒNG QUAN TRỌNG NHẤT
  const jobIndex = exec.scenario.iterationInTest;  // 0..119
  
  if (jobIndex < SPLIT_POINT) {
    // === HOME FEED WARM ===
    const res = http.get(
      `${BASE_URL}/api/sim/products/homefeed?personalized=1&cpu_ms=2&db_rows=5&json_items=16`,
      {
        tags: {
          operation: "cache_warm_homefeed",
          case_id: "si-05-cache-warm",
          business_case: "cache_warm_after_deploy",
          service: "products-service",
          endpoint: "homefeed",
          job_id: `job-${String(jobIndex).padStart(4, "0")}`,
          executor_family: "shared_iterations",
          workload_shape: "fixed_backlog",
        },
      }
    );
    check(res, {
      "homefeed warm 200": (r) => r.status === 200,
    });
  } else {
    // === PRODUCT DETAIL WARM ===
    const productIndex = jobIndex - SPLIT_POINT;  // 0..59
    const productId = `product-${String(productIndex).padStart(3, "0")}`;
    const res = http.get(
      `${BASE_URL}/api/sim/products/${productId}?view=full&include_reviews=1&cpu_ms=2&db_rows=2`,
      {
        tags: {
          operation: "cache_warm_detail",
          case_id: "si-05-cache-warm",
          business_case: "cache_warm_after_deploy",
          service: "products-service",
          endpoint: "detail",
          job_id: `job-${String(jobIndex).padStart(4, "0")}`,
          executor_family: "shared_iterations",
          workload_shape: "fixed_backlog",
        },
      }
    );
    check(res, {
      "detail warm 200": (r) => r.status === 200,
    });
  }
}
```

**KHÔNG viết thế này**:

```js
// SAI — dùng __VU làm identity
const isHomefeed = __VU <= 6;  // Chỉ warm theo VU ID, không theo job index

// SAI — dùng __ITER làm identity
const isHomefeed = __ITER < 5;  // __ITER reset mỗi VU, không global

// SAI — không tag operation
http.get(url);  // Không có operation tag -> không phân biệt được homefeed vs detail
```

### Pattern nâng cao: split động từ JOBS

```js
const JOBS = parseInt(__ENV.SI_05_JOBS) || 120;
const SPLIT_POINT = Math.floor(JOBS / 2);

export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  
  if (jobIndex < SPLIT_POINT) {
    // homefeed warm
    // ...
  } else {
    const productIndex = jobIndex - SPLIT_POINT;
    // detail warm
    // ...
  }
}

// Khai báo expected counts để verify trong dashboard:
// expected_homefeed = SPLIT_POINT
// expected_detail = JOBS - SPLIT_POINT
// Với JOBS=120: homefeed=60, detail=60
// Với JOBS=121: homefeed=60, detail=61
```

### Pattern nâng cao: interleave (xen kẽ)

```js
export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  
  if (jobIndex % 2 === 0) {
    // Even jobs = homefeed warm
    const res = http.get(`${BASE_URL}/api/sim/products/homefeed?...`, {
      tags: { operation: "cache_warm_homefeed" },
    });
    check(res, { "homefeed warm 200": (r) => r.status === 200 });
  } else {
    // Odd jobs = detail warm
    const productIndex = Math.floor(jobIndex / 2);
    const productId = `product-${String(productIndex).padStart(3, "0")}`;
    const res = http.get(`${BASE_URL}/api/sim/products/${productId}?...`, {
      tags: { operation: "cache_warm_detail" },
    });
    check(res, { "detail warm 200": (r) => r.status === 200 });
  }
}

// Expected counts với JOBS=120:
// homefeed = 60 (even jobs: 0,2,4,...,118)
// detail = 60 (odd jobs: 1,3,5,...,119)
```

## Mở rộng / variation

### Variation A: Thêm cache hit verification header

Nếu BE có expose `X-Cache` header, thêm check để verify cache đã thực sự warm:

```js
export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  
  if (jobIndex < 60) {
    // Lần 1: warm (phải MISS vì chưa có cache)
    const res1 = http.get(`${BASE_URL}/api/sim/products/homefeed?...`, {
      tags: { operation: "cache_warm_homefeed" },
    });
    check(res1, {
      "homefeed warm 200": (r) => r.status === 200,
      "homefeed first call MISS": (r) => r.headers["X-Cache"] === "MISS",
    });
    
    // Lần 2: verify (phải HIT vì đã warm)
    const res2 = http.get(`${BASE_URL}/api/sim/products/homefeed?...`, {
      tags: { operation: "cache_verify_homefeed" },
    });
    check(res2, {
      "homefeed verify 200": (r) => r.status === 200,
      "homefeed cache HIT after warm": (r) => r.headers["X-Cache"] === "HIT",
    });
  } else {
    // Detail warm + verify tương tự
    // ...
  }
}
```

### Variation B: Thêm geo-header để warm cache key theo region

Cache key có thể thay đổi theo region header. Thêm variation để warm multi-region:

```js
const REGIONS = ["us-east", "eu-west", "ap-southeast"];

export default function () {
  const jobIndex = exec.scenario.iterationInTest;
  const region = REGIONS[jobIndex % REGIONS.length];
  
  const params = {
    headers: {
      "X-Geo-Region": region,
    },
    tags: {
      operation: jobIndex < 60 ? "cache_warm_homefeed" : "cache_warm_detail",
      region: region,
    },
  };
  
  // ... gọi API với params
}

// Với JOBS=120, 3 regions:
// Mỗi region được warm: 120/3 = 40 jobs
// Mỗi region homefeed: 20 jobs
// Mỗi region detail: 20 jobs
```

### Variation C: Tăng JOBS để mô phỏng backlog production lớn hơn

```powershell
$env:SI_05_JOBS = 500
k6 run -o cloud .\k6-metrics-server\load-target\k6\shared-iterations\si-05-cache-warm.js
```

Nhớ recompute expected:
- `http_reqs = 500`
- `split_point = 250` (nếu dùng floor)
- `cache_warm_homefeed = 250`
- `cache_warm_detail = 250`

### Variation D: Thêm threshold latency theo operation

```js
export const options = {
  thresholds: {
    "http_req_duration{operation:cache_warm_homefeed}": ["p(95)<400"],
    "http_req_duration{operation:cache_warm_detail}": ["p(95)<300"],
  },
};
```

Chuyển từ functional batch sang performance gate. Lưu ý: với cache warm, p95 đầu run sẽ cao hơn (cold start) — nếu threshold quá chặt, test có thể fail oan. Cân nhắc dùng `p(95)<...` với giá trị đủ rộng, hoặc chỉ check p95 của nửa sau run.

### Variation E: Multi-scenario — cache warm + catalog audit đồng thời

```js
export const options = {
  scenarios: {
    cache_warm: {
      executor: "shared-iterations",
      vus: 12,
      iterations: 120,
      tags: { case_id: "si-05-cache-warm" },
    },
    catalog_audit: {
      executor: "shared-iterations",
      vus: 8,
      iterations: 80,
      startTime: "10s",  // Bắt đầu sau warm 10s để cache đã ấm một phần
      tags: { case_id: "si-01-catalog-audit" },
    },
  },
};
```

### Variation F: Warm theo tỉ lệ khác (không phải 50/50)

```js
// Ví dụ: 70% homefeed, 30% detail (homefeed quan trọng hơn)
const JOBS = 120;
const HOMEFEED_RATIO = 0.7;
const SPLIT_POINT = Math.floor(JOBS * HOMEFEED_RATIO);  // = 84

// Expected: homefeed=84, detail=36
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
- Claim "cache đã sẵn sàng" khi chỉ có execution proof (200 OK) mà không có cache hit metric.
- Bỏ qua cold start pattern ở đầu run — latency cao ở đầu là bình thường với cache warm.
- Không recompute split khi JOBS thay đổi — dùng expected 60/60 cho JOBS=121 là sai.
- Không tag `operation` — không phân biệt được homefeed fail hay detail fail.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- Worked example QuickPizza: `../../20260515_03_shared-iterations-quickpizza-two-requests-worked-example.md`
- BE script: `k6-metrics-server/load-target/k6/shared-iterations/si-05-cache-warm.js`
- Case 01 reference: `./01_catalog-audit.md`
