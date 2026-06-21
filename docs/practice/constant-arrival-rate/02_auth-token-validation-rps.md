# Case 02: Auth token validation RPS

## Tình huống thực tế

Trong kiến trúc microservices, hầu như mọi request từ frontend, mobile app, BFF
(Backend For Frontend) hay API Gateway đều phải đi qua một bước: **validate token**.
Auth service nhận một dòng request liên tục từ các service khác — không phải từ
user trực tiếp, mà từ **các proxy/gateway nội bộ** gửi đến.

### Bối cảnh nghiệp vụ

```text
Một hệ thống e-commerce điển hình có kiến trúc:

  Mobile App ─┐
  Web App   ──┤
  Partner API ─┤
              ▼
         API Gateway ──────────────────────────► Auth Service
              │                                   (validate JWT,
              │                                    refresh token,
              │                                    check /me)
              ▼
         Backend Services (cart, order, product, ...)

Mỗi request từ Gateway đến backend service đều cần:
  1. Gateway gửi JWT token → Auth service validate
  2. Auth service trả về user context (userId, roles, permissions)
  3. Gateway forward request + user context → backend service

Nếu auth service CHẬM hoặc FAIL:
  → Gateway không forward được request
  → TOÀN BỘ hệ thống ngừng hoạt động dù cart/order/product vẫn khỏe
  → Auth service là SINGLE POINT OF FAILURE ở tầng xác thực
```

### Traffic pattern của auth service

Khác với traffic từ end-user (browse, add-to-cart, checkout), auth traffic có
đặc điểm riêng:

```text
1. STEADY STREAM — không burst mạnh như flash sale
   Gateway/proxy gửi validate token ĐỀU ĐẶN, không phụ thuộc user action

2. READ-HEAVY — 75% là validate token (GET /me), chỉ 15% login, 10% refresh
   Auth service đọc nhiều hơn ghi rất nhiều

3. LATENCY-SENSITIVE — mỗi ms auth chậm là mỗi ms mọi request khác chậm theo
   Auth nằm trên critical path của TOÀN BỘ request

4. INGRESS-DRIVEN — traffic do producer (gateway) quyết định, không do consumer (VU)
   Gateway gửi bao nhiêu request/s là do gateway config, không phải do auth service
   "rảnh hay bận"
```

Câu hỏi business cốt lõi:

```text
Auth service có chịu được 15 auth-validation arrivals/s trong 45s không?
Và quan trọng hơn: nếu auth service chậm đi, hệ thống có DROP request không?
```

### Vì sao đây là bài toán "contract" chứ không phải "throughput"?

```text
Thông thường với constant-vus:
  "Test xem hệ thống chịu được bao nhiêu request/s?"
  → Throughput là OUTPUT của test (hệ thống nhanh → throughput cao, chậm → thấp)

Với constant-arrival-rate:
  "Hệ thống PHẢI chịu được 15 request/s. Nếu không → breach contract."
  → Rate là INPUT của test, dropped_iterations là tín hiệu breach
```

Đời thường:

```text
Nhà máy đóng gói:
  - constant-vus: "Có 8 công nhân, xem 1 giờ đóng được bao nhiêu hộp?"
  - constant-arrival-rate: "Băng chuyền chạy 15 hộp/phút. Công nhân PHẢI
    đóng kịp 15 hộp/phút. Hộp nào không kịp → rơi xuống sàn (dropped)."
```

Auth service giống băng chuyền: Gateway gửi 15 request/s, auth PHẢI xử lý kịp.
Không có chuyện "auth chậm thì gateway gửi ít đi".

## 2 yêu cầu cốt lõi

### Yêu cầu (a): FUNCTIONAL — Auth service xử lý đúng mọi request đến

**Ý nghĩa**: Mọi token validation, login, refresh request gửi đến auth service
phải được xử lý và trả về kết quả đúng. Không request nào bị bỏ lỡ (dropped).

**Ví dụ cụ thể**:

```text
Scenario: Gateway gửi 15 request/s đến auth service trong 45 giây

Trường hợp A (auth service khỏe, latency thấp):
  15 request/s × 45s = 675 request đến
  Auth xử lý hết 675 request, 0 dropped
  → Contract pass. Auth service đáp ứng được lưu lượng yêu cầu.

Trường hợp B (auth service chậm, latency cao):
  15 request/s × 45s = 675 request đến
  Auth chỉ xử lý được 600 request, 75 dropped
  → Contract BREACH. 75 request không được validate.
  → Gateway không forward được 75 request từ user thật.
  → User thấy lỗi 502/504 dù backend cart/order vẫn khỏe.
```

**Vì sao dropped_iterations là tín hiệu breach contract?**

```text
Trong production:
  - Gateway/proxy KHÔNG tự giảm rate gửi request đến auth service
  - Nếu auth chậm, request xếp hàng (queue) → queue đầy → request bị REJECT
  - User cuối cùng thấy LỖI dù auth service vẫn "sống" (không crash)

Trong k6 constant-arrival-rate:
  - k6 scheduler tạo arrival slot đúng rate=15/s
  - Nếu không có VU rảnh → slot bị DROP → dropped_iterations++
  - dropped_iterations > 0 = mô phỏng chính xác cảnh "request bị reject"
```

### Yêu cầu (b): NON-FUNCTIONAL/SLO — Auth latency không vượt ngưỡng

**Ý nghĩa**: Không chỉ xử lý đủ request, auth service còn phải xử lý NHANH.
Vì auth nằm trên critical path, mỗi ms latency của auth là latency cộng dồn
cho toàn bộ request pipeline.

**Ví dụ cụ thể**:

```text
Pipeline end-to-end không có auth:
  Client → Gateway → Backend → DB → Response
  Latency: 50ms

Pipeline end-to-end có auth:
  Client → Gateway → Auth (validate token) → Backend → DB → Response
  Latency: 50ms + auth_latency

Nếu auth p95 = 100ms:
  → Pipeline p95 = 50 + 100 = 150ms (chậm gấp 3)

Nếu auth p95 = 5ms:
  → Pipeline p95 = 50 + 5 = 55ms (chỉ chậm thêm 10%)
```

**Auth SLO điển hình**:

```text
p95 < 50ms  cho validate token (GET /me)     — chiếm 75% traffic
p95 < 100ms cho login (POST /login)           — chiếm 15% traffic
p95 < 80ms  cho refresh token (POST /refresh) — chiếm 10% traffic

Tổng hợp weighted p95:
  = 0.75 × 50 + 0.15 × 100 + 0.10 × 80
  = 37.5 + 15 + 8 = 60.5ms
```

**Vì sao không dùng chung một ngưỡng cho tất cả endpoint?**

```text
GET /me (validate token):
  - Read-only, thường hit cache (Redis/memcached)
  - Kỳ vọng < 5-10ms trong production
  - Nếu > 50ms → cache miss hàng loạt hoặc DB query chậm

POST /login:
  - Write operation, phải verify password hash (bcrypt/scrypt)
  - Kỳ vọng < 50-100ms (hash verification tốn CPU)
  - Nếu > 200ms → auth DB quá tải hoặc hash cost quá cao

POST /refresh:
  - Write operation, rotate token, invalidate old token
  - Kỳ vọng < 30-80ms
  - Nếu > 150ms → token store (Redis/DB) có vấn đề
```

## Vì sao chọn constant-arrival-rate?

### Bảng so sánh executor cho auth validation

| Executor | Giữ được rate cố định? | Phát hiện được drop? | Auth latency tăng → throughput? | Verdict |
| --- | --- | --- | --- | --- |
| **constant-arrival-rate** | ✓ rate là INPUT cố định | ✓ dropped_iterations | Throughput GIỮ (drop tăng) | ✅ DÙNG |
| constant-vus (duration) | ✗ throughput = OUTPUT | ✗ không có drop metric | Throughput GIẢM | ❌ |
| per-vu-iterations | ✗ count cố định, không có rate | ✗ không đo được | N/A (không có rate) | ❌ |
| shared-iterations | ✗ count cố định, không có rate | ✗ không đo được | N/A | ❌ |
| ramping-vus | ✗ VU thay đổi → rate thay đổi | ✗ không có drop | Throughput biến thiên | ❌ |
| ramping-arrival-rate | ✓ rate biến thiên theo stage | ✓ dropped_iterations | Throughput giữ theo stage | ⚠️ được, nhưng quá phức tạp cho test đơn giản |

### Phân tích sâu: vì sao constant-vus KHÔNG phù hợp?

`constant-vus` với `vus=8, duration="45s"`:

```text
Công thức throughput khi chạy:
  throughput = vus / iter_time
             = 8 / iter_time

iter_time KHÔNG cố định, biến thiên do:
  - Auth service latency (cache hit/miss, DB query time)
  - CPU load của auth service (hash verification, JWT signing)
  - Network jitter giữa k6 và auth service
  - GC pause trên auth service (nếu dùng Java/Go)

Ví dụ thực tế chạy 3 lần liên tiếp cùng config:

  Lần 1: auth service cache warm, latency thấp
    iter_time avg = 20ms → throughput = 8 / 0.020 = 400 req/s
    Test kết luận: "Auth chịu được 400 req/s" ← SAI, vì rate target là 15/s

  Lần 2: auth service cache cold, latency cao hơn
    iter_time avg = 50ms → throughput = 8 / 0.050 = 160 req/s
    Test kết luận: "Auth chịu được 160 req/s" ← VẪN SAI, vì không biết
    ở 15/s có drop không

  Lần 3: auth service có GC pause 200ms
    iter_time avg = 80ms → throughput = 8 / 0.080 = 100 req/s
    Test kết luận: "Auth chịu được 100 req/s"

  Cả 3 lần đều KHÔNG trả lời được câu hỏi:
    "Ở đúng 15 req/s, auth có drop request không?"
```

**Vấn đề cốt lõi**: `constant-vus` đo throughput hệ thống CÓ THỂ đạt được ở
concurrency hiện tại. Nó KHÔNG đo được hệ thống có đáp ứng được MỘT MỨC RATE
CỤ THỂ hay không. Muốn biết auth có chịu được 15/s không, phải DÙNG executor
có rate là INPUT — tức `constant-arrival-rate`.

### Phân tích sâu: vì sao per-vu-iterations KHÔNG phù hợp?

`per-vu-iterations` với `vus=30, iterations=5`:

```text
Công thức count:
  total = vus × iterations = 30 × 5 = 150

Vấn đề 1: KHÔNG có khái niệm "rate"
  - 150 iteration là count cố định, không có rate/s
  - Không biết auth có chịu được 15/s trong 45s không
  - 150 iter có thể chạy xong trong 1s (nếu latency 6ms) hoặc 150s (nếu chậm)

Vấn đề 2: Identity bound vào VU
  - Mỗi VU = 1 user với state riêng
  - Auth service KHÔNG có khái niệm "VU = user"
  - Auth nhận request từ gateway, không biết và không cần biết VU nào gửi

Vấn đề 3: Không có dropped_iterations
  - per-vu-iterations không có cơ chế drop slot
  - Chỉ drop khi maxDuration tới → không mô phỏng được contract breach
```

### Tóm tắt: chỉ constant-arrival-rate thỏa mãn

```text
Yêu cầu (a) - Functional:
  "Auth PHẢI xử lý đủ 15 request/s, không drop"
  → Cần executor có rate là INPUT
  → Cần metric dropped_iterations để biết có breach không
  → Chỉ constant-arrival-rate (và ramping-arrival-rate) có cả 2

Yêu cầu (b) - Non-functional/SLO:
  "Auth latency không vượt ngưỡng"
  → Cần executor có thể test ở rate cố định để so sánh latency giữa các lần
  → Nếu rate thay đổi, latency thay đổi theo → không so sánh được
  → constant-arrival-rate giữ rate cố định → latency thay đổi là tín hiệu thật
```

## Phân tích nguyên nhân gốc kỹ thuật

### Root cause 1: Arrival schedule là FIXED TIMELINE — không phụ thuộc backend

Đây là khác biệt CỐT LÕI giữa constant-arrival-rate và mọi executor khác.

```text
Trong constant-arrival-rate, k6 scheduler KHÔNG hỏi:
  "Backend còn rảnh không? Có VU nào rảnh không?"
  
Nó chỉ làm một việc:
  "Đến giờ X → tạo 1 arrival slot → cần 1 VU để chạy slot này"
  
Nếu có VU rảnh → slot được chạy → iteration bắt đầu
Nếu KHÔNG có VU rảnh → slot bị DROP → dropped_iterations++
```

**Timeline cụ thể cho case 02**:

```text
rate=15/s, duration=45s

Timeline arrival slot (45 giây đầu):
  t=0.000s: slot #0   được schedule
  t=0.067s: slot #1   được schedule  (1/15 ≈ 0.067s giữa các slot)
  t=0.133s: slot #2   được schedule
  t=0.200s: slot #3   được schedule
  ...
  t=0.933s: slot #14  được schedule
  t=1.000s: slot #15  được schedule
  ...
  t=44.933s: slot #674 được schedule
  t=45.000s: hết duration, không schedule thêm

Tổng: 675 slot được schedule trong 45 giây
     = 15 slot/giây × 45 giây
```

**Trace demo — điều gì xảy ra với từng slot**:

```text
Giả sử auth service đang khỏe, p95=23ms, W_effective ≈ 0.023s:

  t=0.000s: slot #0  → VU #1 nhận, bắt đầu GET /me
  t=0.023s: slot #0  → VU #1 xong, trả về pool (total time = 23ms)
  t=0.067s: slot #1  → VU #1 (vừa rảnh) nhận, bắt đầu POST /login
  t=0.090s: slot #1  → VU #1 xong (total time = 23ms)
  t=0.133s: slot #2  → VU #1 nhận tiếp...
  ...

  Với p95=23ms, 1 VU xử lý ~43 slot/giây (1000ms / 23ms ≈ 43.5)
  Nhưng rate chỉ là 15 slot/giây
  → 1 VU thừa sức xử lý toàn bộ 15 slot/giây
  → 8 preAllocatedVUs là quá dư
  → 0 dropped_iterations (không bao giờ thiếu VU)

Giả sử auth service CHẬM đi (p95=200ms, W_effective ≈ 0.200s):

  t=0.000s: slot #0  → VU #1 nhận, bắt đầu
  t=0.067s: slot #1  → VU #2 nhận (VU #1 còn bận)
  t=0.133s: slot #2  → VU #3 nhận (VU #1, #2 còn bận)
  t=0.200s: slot #0  → VU #1 xong (total = 200ms), VU #3 vẫn bận
  t=0.200s: slot #3  → VU #1 nhận slot mới
  t=0.267s: slot #1  → VU #2 xong (total = 200ms)
  t=0.267s: slot #4  → VU #2 nhận slot mới
  ...

  Với p95=200ms, 1 VU xử lý ~5 slot/giây (1000ms / 200ms = 5)
  Cần 15 slot/giây → cần ít nhất 15/5 = 3 VU chạy song song
  → Nhưng do scheduler phân phối đều, cần thêm VU dự phòng
  → preAllocatedVUs=8 vẫn đủ
  → maxVUs=24 là trần an toàn
```

**Công thức VU demand**:

```text
VU cần thiết ≈ ceil(lambda × W_effective)

Trong đó:
  lambda = rate / timeUnit_seconds = 15 / 1 = 15 arrivals/s
  W_effective = thời gian trung bình 1 VU xử lý 1 arrival

Ví dụ với p95=23ms (W_effective ≈ 0.023s):
  VU cần ≈ ceil(15 × 0.023) = ceil(0.345) = 1 VU
  → 1 VU là đủ, 8 preAllocatedVUs là quá dư

Ví dụ với p95=200ms (W_effective ≈ 0.200s):
  VU cần ≈ ceil(15 × 0.200) = ceil(3.0) = 3 VU
  → Cần 3 VU chạy song song, 8 preAllocatedVUs vẫn đủ

Ví dụ với p95=2000ms (W_effective ≈ 2.0s) — auth service rất chậm:
  VU cần ≈ ceil(15 × 2.0) = ceil(30) = 30 VU
  → Nhưng maxVUs=24 → THIẾU VU!
  → 30 - 24 = 6 slot/giây bị drop (vượt trần maxVUs)
  → Trong 45s: ~270 slot bị dropped_iterations
```

**Kết luận**: Arrival schedule là FIXED. Backend chậm hay nhanh, slot vẫn được
tạo đúng 15 slot/giây. Điều duy nhất thay đổi là: có đủ VU để consume hết slot
không. Đây chính là mô hình INGRESS-DRIVEN.

### Root cause 2: Backend auth chậm → VU demand TĂNG (không giống constant-vus)

Đây là hệ quả trực tiếp từ Root cause 1.

```text
constant-vus (closed model):
  Backend chậm → iter_time tăng → throughput = vus / iter_time GIẢM
  → Hệ thống "tự điều tiết": chậm thì làm ít đi
  → Giống như: "8 công nhân, mỗi người làm 1 việc rồi làm tiếp.
     Nếu việc khó hơn → làm lâu hơn → 1 giờ làm được ít việc hơn."
  → KHÔNG có dropped_iterations

constant-arrival-rate (open model):
  Backend chậm → iter_time tăng → VU bị giữ lâu hơn → cần NHIỀU VU HƠN
  → Nếu không đủ VU → dropped_iterations tăng
  → Giống như: "Băng chuyền chạy 15 hộp/phút. Nếu mỗi hộp khó đóng hơn
     → cần thêm công nhân. Nếu không thêm được → hộp rơi."
  → dropped_iterations LÀ tín hiệu
```

**Demo so sánh side-by-side với cùng auth latency tăng**:

```text
Scenario: Auth service bị chậm đột ngột (DB có lock 500ms)
  iter_time tăng từ 23ms → 500ms

┌─────────────────────────────────────────────────────────────────┐
│ CONSTANT-VUS (vus=8, duration=45s)                              │
│                                                                 │
│ Trước khi chậm:                                                 │
│   throughput = 8 / 0.023 ≈ 348 req/s                            │
│                                                                 │
│ Khi auth chậm (iter_time=500ms):                                │
│   throughput = 8 / 0.500 = 16 req/s                             │
│                                                                 │
│ → Throughput GIẢM từ 348 → 16 req/s (giảm 95%)                  │
│ → Nhưng KHÔNG có dropped_iterations                             │
│ → Kết luận SAI: "Auth vẫn ổn, 0 drop"                           │
│ → Thực tế: Auth chỉ xử lý được 16/s thay vì 15/s target         │
│   NHƯNG nếu target là 100/s thì đã breach từ lâu                 │
│   constant-vus KHÔNG cho biết điều này                           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ CONSTANT-ARRIVAL-RATE (rate=15/s, preAllocatedVUs=8, maxVUs=24) │
│                                                                 │
│ Trước khi chậm:                                                 │
│   iter_time=23ms → VU cần = ceil(15 × 0.023) = 1 VU             │
│   → 0 dropped                                                   │
│                                                                 │
│ Khi auth chậm (iter_time=500ms):                                │
│   VU cần = ceil(15 × 0.500) = ceil(7.5) = 8 VU                 │
│   → Cần 8 VU chạy song song                                     │
│   → preAllocatedVUs=8 vừa đủ                                    │
│   → 0 dropped (nhưng VU usage sát trần)                         │
│                                                                 │
│ Nếu auth chậm hơn (iter_time=2000ms):                           │
│   VU cần = ceil(15 × 2.0) = 30 VU                               │
│   → maxVUs=24 → THIẾU 6 VU                                      │
│   → dropped_iterations ≈ 6/giây × 45s = 270 dropped             │
│   → CONTRACT BREACH rõ ràng                                     │
└─────────────────────────────────────────────────────────────────┘
```

**Kết luận**: `constant-arrival-rate` cho bạn biết CHÍNH XÁC khi nào hệ thống
không đáp ứng được rate target. `constant-vus` chỉ cho biết throughput giảm —
không phân biệt được "vẫn đủ target" và "đã breach".

### Root cause 3: dropped_iterations là CONTRACT BREACH SIGNAL duy nhất

Trong constant-arrival-rate, `dropped_iterations` không phải là "metric phụ".
Nó là **tín hiệu breach contract CHÍNH**.

```text
Tại sao dropped_iterations quan trọng hơn mọi metric khác?

Vì:
  - http_req_failed có thể = 0% (mọi request thành công)
  - checks có thể = 100% (mọi check pass)
  - p95 latency có thể < 10ms (rất nhanh)

  NHƯNG nếu dropped_iterations = 50:
    → Có 50 request LẼ RA phải được xử lý nhưng đã bị BỎ QUA
    → 50 user không được validate token
    → 50 request từ gateway bị reject
    → Contract BREACH dù mọi metric khác "đẹp"
```

**Cơ chế drop trong k6**:

```text
1. k6 scheduler tạo arrival slot tại thời điểm t
2. k6 tìm VU rảnh từ pool:
   a. Nếu có VU rảnh trong preAllocatedVUs → giao slot cho VU đó
   b. Nếu không có VU rảnh nhưng current VUs < maxVUs → spawn VU mới
   c. Nếu không có VU rảnh VÀ current VUs == maxVUs → DROP SLOT
3. dropped_iterations++

Lưu ý quan trọng:
  - Spawn VU mới tốn thời gian (init script, import module, allocate memory)
  - Nếu slot đến trong lúc VU đang spawn → vẫn bị drop (VU chưa sẵn sàng)
  - → preAllocatedVUs giúp giảm drop ở đầu test (VU đã sẵn sàng)
```

**Demo trace khi drop xảy ra**:

```text
Config: rate=100/s, preAllocatedVUs=2, maxVUs=5, auth p95=200ms

VU cần = ceil(100 × 0.200) = ceil(20) = 20 VU
Nhưng maxVUs=5 → thiếu 15 VU

Timeline:
  t=0.000s: slot #0   → VU #1 nhận
  t=0.010s: slot #1   → VU #2 nhận
  t=0.020s: slot #2   → spawn VU #3 (đang init...)
  t=0.030s: slot #3   → spawn VU #4 (đang init...)
  t=0.040s: slot #4   → spawn VU #5 (đang init...)
  t=0.050s: slot #5   → maxVUs=5, VU #3 chưa sẵn sàng → DROP!
  t=0.060s: slot #6   → DROP!
  t=0.070s: slot #7   → DROP!
  ...
  t=0.200s: slot #0   → VU #1 xong, nhận slot #20
  t=0.200s: slot #20  → VU #1 nhận (vừa rảnh)

  Trong 200ms đầu: 20 slot được schedule, chỉ 5 VU được spawn
  → ~15 slot bị drop trong 200ms đầu tiên
  → Sau đó 5 VU chạy song song: capacity = 5/0.200 = 25 slot/s
  → Nhưng rate=100/s → vẫn thiếu 75 slot/s → drop liên tục
```

**Kết luận**: `dropped_iterations` là metric số 1 để quyết định PASS/FAIL.
Mọi metric khác là phụ trợ. Nếu dropped_iterations > 0 → contract breach →
FAIL, bất kể latency hay error rate thế nào.

### Root cause 4: preAllocatedVUs là WORKER POOL, không phải auth user count

Đây là hiểu nhầm phổ biến nhất với constant-arrival-rate.

```text
SAI:    "preAllocatedVUs=8 nghĩa là test với 8 auth users"
ĐÚNG:   "preAllocatedVUs=8 nghĩa là chuẩn bị sẵn 8 worker (VU)
         để nhận arrival slot. Auth user đến từ userContext/userPool."

SAI:    "Tăng preAllocatedVUs = tăng số user test"
ĐÚNG:   "Tăng preAllocatedVUs = tăng số worker sẵn sàng nhận slot.
         Số user test do userPool quyết định."

SAI:    "maxVUs=24 nghĩa là tối đa 24 users đồng thời"
ĐÚNG:   "maxVUs=24 nghĩa là tối đa 24 VU (worker) được spawn.
         Số user đồng thời thực tế ≤ 24 (mỗi VU xử lý 1 user tại 1 thời điểm),
         nhưng tổng user unique có thể lên đến userPool=500."
```

**Phân biệt rạch ròi**:

```text
preAllocatedVUs (8):
  - Là worker threads/V8 isolates được khởi tạo sẵn trước khi test chạy
  - Mục đích: giảm độ trễ khi slot đến (không phải spawn VU mới)
  - KHÔNG liên quan đến số lượng user nghiệp vụ
  - 8 VU có thể xử lý hàng nghìn user khác nhau (mỗi slot gán user mới)

userPool (500):
  - Là số lượng user identity có sẵn trong pool test data
  - userContext.userId = `arrival-user-${(iter % userPool) + 1}`
  - 500 user khác nhau, lặp lại sau mỗi 500 iteration
  - Đây mới là "số user nghiệp vụ" được test

maxVUs (24):
  - Là trần worker được spawn thêm khi 8 preAllocatedVUs không đủ
  - Tăng maxVUs = tăng khả năng chịu đựng khi auth chậm
  - Nhưng không nên tăng vô tội vạ: VU tốn RAM/CPU, ảnh hưởng load generator
```

**Công thức năng lực VU pool**:

```text
capacity_with_preAllocatedVUs = preAllocatedVUs / W_effective
                               = 8 / 0.023
                               ≈ 347 arrivals/s

capacity_with_maxVUs = maxVUs / W_effective
                     = 24 / 0.023
                     ≈ 1043 arrivals/s

Với rate=15/s:
  - preAllocatedVUs=8 dư capacity gấp 347/15 ≈ 23 lần
  - maxVUs=24 dư capacity gấp 1043/15 ≈ 69 lần
  → Auth service cực kỳ an toàn với config này
```

### Root cause 5: Auth event branches có LATENCY PROFILE KHÁC NHAU

Không phải mọi auth request đều giống nhau. 3 branch có độ phức tạp và latency
khác biệt rõ rệt.

```text
Branch 1: GET /me (75% traffic) — VALIDATE TOKEN
  - Đọc session từ cache (Redis/memcached)
  - Hoặc decode JWT (không cần DB)
  - CPU: rất nhẹ (decode base64 + verify signature)
  - DB: không (hoặc 1 query nếu cache miss)
  - Expected latency: 1-5ms (cache hit), 10-30ms (cache miss + DB)
  - Memory: thấp (chỉ đọc session object vài KB)
  - Query params: cpu_ms=1, db_rows=1, memory_kb=4

Branch 2: POST /login (15% traffic) — LOGIN
  - Verify password hash (bcrypt/scrypt/argon2)
  - CPU: NẶNG (hash verification là CPU-bound)
  - DB: 1-2 queries (lookup user, update last_login)
  - Expected latency: 20-100ms (tùy hash cost)
  - Query params: cpu_ms=2, db_rows=1

Branch 3: POST /refresh (10% traffic) — REFRESH TOKEN
  - Rotate token (invalidate old, issue new)
  - CPU: trung bình (sign JWT mới)
  - DB: 1-2 writes (invalidate old token, store new)
  - Expected latency: 10-50ms
  - Query params: cpu_ms=1, db_writes=1
```

**Ảnh hưởng của weighted branches đến VU demand**:

```text
Weighted average latency:
  W_avg = 0.75 × W_me + 0.15 × W_login + 0.10 × W_refresh

Ví dụ với Run 90:
  W_me ≈ 15ms, W_login ≈ 35ms, W_refresh ≈ 25ms
  W_avg = 0.75 × 15 + 0.15 × 35 + 0.10 × 25
        = 11.25 + 5.25 + 2.5
        = 19ms

VU cần = ceil(15 × 0.019) = ceil(0.285) = 1 VU

Nhưng nếu login branch latency tăng đột biến:
  W_me ≈ 15ms, W_login ≈ 500ms, W_refresh ≈ 25ms
  W_avg = 0.75 × 15 + 0.15 × 500 + 0.10 × 25
        = 11.25 + 75 + 2.5
        = 88.75ms

VU cần = ceil(15 × 0.08875) = ceil(1.33) = 2 VU

→ VU demand tăng gấp đôi chỉ vì login branch chậm (dù login chỉ 15% traffic)
→ Đây là lý do phải drill-down theo operation, không nhìn p95 tổng
```

**Demo trace: login branch gây drop dù me và refresh OK**:

```text
Scenario: login hash verification bị chậm (hash cost config sai)
  → W_login = 2000ms, W_me = 15ms, W_refresh = 25ms
  → W_avg = 0.75×15 + 0.15×2000 + 0.10×25 = 11.25 + 300 + 2.5 = 313.75ms
  → VU cần = ceil(15 × 0.31375) = ceil(4.71) = 5 VU
  → Vẫn trong preAllocatedVUs=8 → 0 drop ở mức tổng

Nhưng phân tích theo branch:
  - 15% × 15/s = 2.25 login requests/s
  - Mỗi login request giữ VU trong 2000ms
  - → Cần ceil(2.25 × 2.0) = 5 VU CHỈ để xử lý login
  - Còn 3 VU cho me + refresh → capacity = 3/0.017 ≈ 176 req/s → đủ

  → Tổng không drop, nhưng login p95 = 2000ms là KHÔNG CHẤP NHẬN ĐƯỢC
  → Phải drill-down theo tag operation để phát hiện
```

## Identity model deep-dive

### Bảng identity semantics khác nhau giữa các executor

Trong constant-arrival-rate, identity model KHÁC HOÀN TOÀN so với per-vu-iterations.

| Khái niệm | per-vu-iterations | constant-arrival-rate (case này) |
| --- | --- | --- |
| `__VU` | Identity của user (VU=1 → qa-user-1) | Worker vô danh (chỉ là "công nhân") |
| `__ITER` | Số lần user này đã chạy (0, 1, 2, ...) | Số lần VU này đã chạy (vô nghĩa về mặt user) |
| `exec.scenario.iterationInTest` | Không quan trọng (dùng __VU + __ITER) | **Global arrival slot index** (0, 1, 2, ...) |
| Identity source | `__VU` → map sang user cố định | `iterationInTest % userPool` → user luân phiên |
| State (session, cart) | GIỮ qua iter (cùng VU isolate) | KHÔNG giữ (mỗi event độc lập) |
| User reuse | Mỗi VU LUÔN là 1 user | User lặp sau mỗi userPool iteration |

### Trace identity trong case 02

```js
// Từ common.js - userContext()
export function userContext(seed = 'arrival', userPool = 500) {
  const it = exec.scenario.iterationInTest;  // ← global arrival slot index
  const p = Math.max(1, userPool);
  const un = (it % p) + 1;                   // ← user luân phiên 1..500
  return {
    seed,
    vuId: exec.vu.idInTest,                  // ← VU worker ID (1..maxVUs)
    iter: it,                                 // ← global slot index
    scenarioIter: exec.scenario.iterationInInstance,
    userId: `arrival-user-${un}`,            // ← identity từ slot index
    requestKey: `${seed}-${it}-${exec.vu.idInTest}`,
    abVariant: it % 2 === 0 ? 'b' : 'a'
  };
}
```

**Demo trace identity qua 10 slot đầu**:

```text
Slot #0:  VU #1 nhận, iterationInTest=0  → userId=arrival-user-1  (0 % 500 + 1)
Slot #1:  VU #1 nhận, iterationInTest=1  → userId=arrival-user-2  (1 % 500 + 1)
Slot #2:  VU #2 nhận, iterationInTest=2  → userId=arrival-user-3  (2 % 500 + 1)
Slot #3:  VU #1 nhận, iterationInTest=3  → userId=arrival-user-4  (3 % 500 + 1)
Slot #4:  VU #3 nhận, iterationInTest=4  → userId=arrival-user-5  (4 % 500 + 1)
...
Slot #499: VU #k nhận, iterationInTest=499 → userId=arrival-user-500
Slot #500: VU #m nhận, iterationInTest=500 → userId=arrival-user-1  (lặp!)
```

**Điểm quan trọng**:

```text
1. VU #1 có thể xử lý user-1, user-2, user-4, user-7, ...
   → VU KHÔNG bound với user identity
   → Đây là OPEN MODEL: worker vô danh xử lý request đến

2. User identity lặp lại sau mỗi 500 slot
   → user-1 xuất hiện ở slot #0, #500, #1000, ...
   → Với 675 slot, user-1 xuất hiện 2 lần (slot #0 và #500)
   → Điều này OK vì auth event là stateless (không cần session)

3. requestKey = `${seed}-${it}-${vuId}` là unique per event
   → seed = timestamp từ setup()
   → it = global slot index
   → vuId = VU xử lý slot đó
   → Dùng để trace log nếu cần debug
```

### Vì sao identity model này PHÙ HỢP với auth service?

```text
Auth service trong thực tế:
  - Nhận request từ gateway/proxy
  - Gateway gửi request với JWT token của user thật
  - Auth service không biết và không cần biết "ai gửi request này"
  - Auth service chỉ cần: validate token → trả về user context

k6 constant-arrival-rate mô phỏng chính xác điều này:
  - VU = gateway worker (không phải user)
  - userContext.userId = identity trong JWT token
  - Mỗi arrival event = 1 request từ gateway
  - KHÔNG có state giữa các event (stateless)
```

## Phân tích open model

### Open model là gì?

```text
OPEN MODEL (constant-arrival-rate):
  - Rate arrival là INPUT cố định
  - Hệ thống PHẢI xử lý kịp rate đó
  - Nếu không kịp → request bị drop (mất)
  - Giống: băng chuyền nhà máy, call center, HTTP request đến server

CLOSED MODEL (constant-vus, per-vu-iterations):
  - Số lượng worker/user là INPUT cố định
  - Throughput là OUTPUT (phụ thuộc latency)
  - Không có khái niệm drop
  - Giống: nhóm công nhân làm việc, user tương tác với app
```

### Side-by-side: auth service chậm dưới open vs closed model

```text
┌──────────────────────────────────────────────────────────────────┐
│ SCENARIO: Auth service bị chậm do DB có lock 200ms mỗi 5 giây    │
│ (Mô phỏng: backup job chạy định kỳ, lock table 200ms)            │
│                                                                  │
│ Rate target: 15 arrivals/s, duration: 45s                        │
│ Normal latency: p95=23ms, during-lock latency: p95=200ms         │
└──────────────────────────────────────────────────────────────────┘

CLOSED MODEL — constant-vus (vus=8, duration=45s):

  t=0s to 5s:   latency 23ms  → throughput = 8/0.023 ≈ 348/s
  t=5s to 5.2s: latency 200ms → throughput = 8/0.200 = 40/s
  t=5.2s to 10s: latency 23ms → throughput ≈ 348/s
  ...

  Kết quả: throughput dao động 348 → 40 → 348 → 40 → ...
  Tổng request ≈ (40s × 348/s) + (5s × 40/s) = 13920 + 200 = 14120

  → Test kết luận: "Auth xử lý được ~14120 request trong 45s"
  → KHÔNG trả lời được: "15 request/s có bị drop không?"
  → Thực tế: throughput 40/s trong lúc lock > 15/s target → VẪN ĐỦ
    Nhưng nếu lock kéo dài hơn (500ms) → throughput = 8/0.5 = 16/s
    → Sát target, nguy hiểm nhưng test vẫn KHÔNG cảnh báo

OPEN MODEL — constant-arrival-rate (rate=15/s, preAllocatedVUs=8, maxVUs=24):

  t=0s to 5s:   latency 23ms  → VU cần = ceil(15 × 0.023) = 1 VU → OK
  t=5s to 5.2s: latency 200ms → VU cần = ceil(15 × 0.200) = 3 VU → OK
  t=5.2s to 10s: latency 23ms → VU cần = 1 VU → OK

  Kết quả:
    - Tất cả slot được xử lý (0 dropped_iterations)
    - VU usage tăng 1→3 trong lúc lock → thấy được trên chart VUs vs iter/s
    - p95 latency tăng 23ms→200ms trong lúc lock → thấy trên Response time

  → Test kết luận: "Auth vẫn đáp ứng 15/s, 0 drop, nhưng có latency spike
     định kỳ 200ms → cần điều tra DB backup job"

  Nếu lock kéo dài hơn (1000ms):
    VU cần = ceil(15 × 1.0) = 15 VU → preAllocatedVUs=8 không đủ
    → spawn thêm VU (từ 8 lên 15, dưới maxVUs=24) → vẫn OK
    → 0 dropped_iterations

  Nếu lock rất dài (2000ms):
    VU cần = ceil(15 × 2.0) = 30 VU → vượt maxVUs=24
    → 6 slot/s bị drop
    → dropped_iterations: 6 × 0.2s × 9 lần lock ≈ 11 dropped
    → CONTRACT BREACH → cảnh báo rõ ràng
```

### Công thức chuyển đổi giữa open và closed model

```text
Open → Closed (ước lượng VU cần cho 1 rate target):
  vus_required ≈ rate × avg_latency

Closed → Open (ước lượng rate tối đa với N VU):
  max_rate ≈ vus / avg_latency

Ví dụ case 02:
  rate = 15/s, avg_latency = 19ms = 0.019s
  vus_required ≈ 15 × 0.019 = 0.285 VU → 1 VU là đủ

  Ngược lại với 8 VU:
  max_rate ≈ 8 / 0.019 ≈ 421 requests/s
  → 8 VU có thể xử lý tới 421 auth requests/s
  → Rate=15/s chỉ dùng 3.6% năng lực VU pool
```

## Bảng service/API flow

Mỗi arrival event gọi đúng 1 API call. Đây là điểm đơn giản hóa của case 02:
không có multi-step journey như case 01 (login → browse → cart → checkout).

### Weighted branch table

| Branch | Weight | Endpoint | Method | CPU | DB | Expected per 675 slots |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| `me` | 75% | `/api/sim/auth/me?cpu_ms=1&db_rows=1&memory_kb=4` | GET | 1ms | 1 row | ~506 |
| `login` | 15% | `/api/sim/auth/login?cpu_ms=2&db_rows=1` | POST | 2ms | 1 row | ~101 |
| `refresh` | 10% | `/api/sim/auth/refresh?cpu_ms=1&db_writes=1` | POST | 1ms | 1 write | ~68 |

### WeightedPick mechanism

```js
// Từ common.js
export function weightedPick(items, n) {
  const t = items.reduce((s, i) => s + i.weight, 0); // total weight = 100
  const p = n % t;  // dùng iteration number để chọn
  let c = 0;
  for (const i of items) {
    c += i.weight;
    if (p < c) return i.name;
  }
  return items[items.length - 1].name;
}
```

**Trace weightedPick cho 10 slot đầu**:

```text
Slot #0:  n=0  → p=0%100=0  → 0<75   → me
Slot #1:  n=1  → p=1%100=1  → 1<75   → me
Slot #2:  n=2  → p=2%100=2  → 2<75   → me
...
Slot #74: n=74 → p=74%100=74 → 74<75 → me      (75 slot me đầu tiên)
Slot #75: n=75 → p=75%100=75 → 75<90? No → 75<90? Yes → login (slot login đầu)
Slot #76: n=76 → p=76%100=76 → login
...
Slot #89: n=89 → p=89%100=89 → login            (slot login thứ 15)
Slot #90: n=90 → p=90%100=90 → 90<90? No → 90<90? No → 90<100? Yes → refresh
Slot #91: n=91 → p=91%100=91 → refresh
...
Slot #99: n=99 → p=99%100=99 → refresh          (slot refresh thứ 10)
Slot #100: n=100 → p=0%100=0 → me               (lặp chu kỳ 100)
```

**Pattern**: Cứ mỗi 100 slot: 75 me + 15 login + 10 refresh. Với 675 slot,
ta có 6 chu kỳ đầy đủ (600 slot) + 75 slot lẻ → tổng khoảng 506 me, 101 login,
68 refresh.

### Request flow cho từng branch

**Branch `me` (75%)**:

```text
1. Tạo userContext với userId = arrival-user-N
2. Gọi GET /api/sim/auth/me?cpu_ms=1&db_rows=1&memory_kb=4
   + Header: Authorization: Bearer car-auth-{userId}
3. Server mô phỏng: CPU 1ms + DB query 1 row + 4KB memory
4. Check status 200
5. Ghi event constant_arrival_events_total, constant_arrival_event_duration_ms
6. Nếu check fail → constant_arrival_events_failed++
```

**Branch `login` (15%)**:

```text
1. Tạo userContext với userId = arrival-user-N
2. Gọi POST /api/sim/auth/login?cpu_ms=2&db_rows=1
   + Body: { username: userId, password: "pass-{iter}" }
3. Server mô phỏng: CPU 2ms + DB query 1 row
4. Check status 200
5. Ghi event
```

**Branch `refresh` (10%)**:

```text
1. Tạo userContext với userId = arrival-user-N
2. Gọi POST /api/sim/auth/refresh?cpu_ms=1&db_writes=1
   + Body: { refresh_token: "refresh-{userId}" }
3. Server mô phỏng: CPU 1ms + DB write 1
4. Check status 200
5. Ghi event
```

### Reconciliation

```text
constant_arrival_events_total = số event đã hoàn thành (≈ iterations)
constant_arrival_api_calls_total = số API call (≈ iterations, vì 1 event = 1 API)
http_reqs = số HTTP request (≈ iterations, vì 1 event = 1 request)
constant_arrival_events_failed = số event có ≥1 API call fail

Mối quan hệ:
  iterations ≈ constant_arrival_events_total ≈ constant_arrival_api_calls_total ≈ http_reqs ≈ 675
  (nếu 0 dropped, 0 interrupted)

  constant_arrival_events_failed ∈ [0, 675]
  (là subset của constant_arrival_events_total)
```

## Metrics & tags deep-dive

### Custom metrics

| Metric | Type | Ý nghĩa | Tag |
| --- | --- | --- | --- |
| `constant_arrival_events_total` | Counter | Tổng auth event đã hoàn thành | case_id, service, operation, user_id |
| `constant_arrival_events_failed` | Counter | Số event có ≥1 API fail | case_id, service, operation, user_id |
| `constant_arrival_api_calls_total` | Counter | Tổng API call (≈ events_total) | case_id, service, operation, endpoint, user_id |
| `constant_arrival_event_duration_ms` | Trend | End-to-end event duration (ms) | case_id, service, operation, user_id |

### Built-in metrics được dùng

| Metric | Ý nghĩa | Threshold |
| --- | --- | --- |
| `checks` | Tỷ lệ check pass | rate > 0.99 |
| `http_req_failed` | Tỷ lệ HTTP request fail | rate < 0.01 |
| `dropped_iterations` | Số slot bị drop | count <= 0 |
| `iterations` | Tổng iteration hoàn thành | ≈ 675 |
| `http_reqs` | Tổng HTTP request | ≈ 675 |

### Tags chi tiết

Mỗi event/API call được gán tags để drill-down:

```text
case_id: "car-02-auth-token-validation-rps"
service: "auth-service"

operation (theo branch):
  - "auth_arrival_me"      (GET /me)
  - "auth_arrival_login"   (POST /login)
  - "auth_arrival_refresh" (POST /refresh)

endpoint (theo branch):
  - "GET /api/sim/auth/me"
  - "POST /api/sim/auth/login"
  - "POST /api/sim/auth/refresh"

user_id: "arrival-user-N"  (N = 1..500, từ userPool)

event tag (finishEvent):
  - "auth_me_arrival"
  - "auth_login_arrival"
  - "auth_refresh_arrival"
```

### Cách drill-down theo operation

```text
Để biết branch nào gây vấn đề:

1. Lọc constant_arrival_events_failed theo operation:
   - auth_arrival_me: có fail không?
   - auth_arrival_login: có fail không?
   - auth_arrival_refresh: có fail không?

2. Lọc constant_arrival_event_duration_ms p95 theo operation:
   - auth_arrival_me p95: bao nhiêu?
   - auth_arrival_login p95: bao nhiêu?
   - auth_arrival_refresh p95: bao nhiêu?

3. Tính weighted p95 tổng:
   weighted_p95 = 0.75 × p95_me + 0.15 × p95_login + 0.10 × p95_refresh

Từ Run 90:
  p95 tổng = 23ms  (tất cả branch đều nhanh)
  → Không cần drill-down vì không có outlier
```

### Reconciliation công thức

```text
Tổng kiểm tra:

1. constant_arrival_events_total ≈ iterations
   (sai số ±1 do boundary scheduling)

2. constant_arrival_api_calls_total ≈ http_reqs
   (mỗi event gọi đúng 1 API)

3. constant_arrival_events_failed ≤ constant_arrival_events_total
   (failed là subset của total)

4. sum(count by operation) của constant_arrival_events_total = constant_arrival_events_total
   (tổng theo tag phải bằng tổng không tag)

5. dropped_iterations + iterations ≈ scheduled_slots = 675
   (nếu không có interrupted)
```

## Pass criteria

### Bảng pass criteria mở rộng

| # | Metric | Pass condition | Rationale |
| --- | --- | --- | --- |
| 1 | `dropped_iterations` | `count <= 0` | Contract breach signal chính. Auth không được drop request. |
| 2 | `checks` | `rate > 0.99` | Mọi check HTTP status phải pass (≥99%). |
| 3 | `http_req_failed` | `rate < 0.01` | HTTP errors < 1% (cho phép vài request fail do network). |
| 4 | `constant_arrival_events_failed` | `count < 10` | Số event có fail < 10. Mỗi event = 1 user request không được validate. |
| 5 | `iterations` | `≈ 675` (±5) | Gần bằng scheduled slots. Sai số vài đơn vị do boundary scheduling. |
| 6 | `p95 latency` | `< 50ms` (tổng) | Auth nằm trên critical path, latency phải thấp. |
| 7 | `p95 me` | `< 30ms` | Validate token là operation phổ biến nhất (75%), cần nhanh nhất. |
| 8 | `p95 login` | `< 100ms` | Login ít hơn nhưng vẫn phải trong ngưỡng. |
| 9 | `p95 refresh` | `< 80ms` | Refresh token cũng phải nhanh. |

### Priority của pass criteria

```text
P0 (BLOCKING — nếu fail → KHÔNG PASS):
  1. dropped_iterations <= 0
  2. http_req_failed < 0.01
  3. checks rate > 0.99

P1 (HIGH — nếu fail → cần điều tra):
  4. constant_arrival_events_failed < 10
  5. iterations ≈ 675

P2 (MEDIUM — nếu fail → optimization opportunity):
  6. p95 latency < 50ms
  7. p95 me < 30ms

P3 (LOW — monitoring):
  8. p95 login < 100ms
  9. p95 refresh < 80ms
```

## Cách chạy

### Local run

```powershell
# 1. Đảm bảo stack đã start (xem RUN_GUIDE)
# 2. Set env vars
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

# 3. Run với cloud output (xem result trên UI)
cd "E:\Khoa hoc\k6"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-02-auth-token-validation-rps.js"

# Hoặc run local nếu không cần UI
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-02-auth-token-validation-rps.js"
```

### Env override

```powershell
# Override rate (test với rate khác)
$env:CAR_02_RATE = "30"

# Override duration
$env:CAR_02_DURATION = "60s"

# Override preAllocatedVUs (giảm worker pool)
$env:CAR_02_PREALLOCATED_VUS = "4"

# Override maxVUs (giảm trần worker)
$env:CAR_02_MAX_VUS = "10"

# Override max dropped (cho phép drop)
$env:CAR_02_MAX_DROPPED = "5"
```

### Smoke test (quick health check)

```powershell
# Smoke: rate thấp, duration ngắn để kiểm script chạy đúng
$env:CAR_02_RATE = "1"
$env:CAR_02_DURATION = "10s"
$env:CAR_02_PREALLOCATED_VUS = "2"
$env:CAR_02_MAX_VUS = "4"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-02-auth-token-validation-rps.js"
```

### Verify trên UI (sau khi run xong)

```text
1. Mở http://localhost:13001
2. Paste student-token-1234567890
3. Click vào run mới nhất
4. Kiểm tra Overview KPI:
   - iterations ≈ 675 ✓
   - dropped_iterations = 0 ✓
   - http_req_failed = 0% ✓
   - checks = 100% ✓
5. Vào tab Executor:
   - executor = constant-arrival-rate ✓
   - rate = 15, timeUnit = 1s, duration = 45s ✓
   - preAllocatedVUs = 8, maxVUs = 24 ✓
```

## Phân tích output 5 bước

### Bước 1: Verify config [Header]

```text
Header cần thấy:
  executor = constant-arrival-rate
  rate = 15
  timeUnit = 1s
  duration = 45s
  preAllocatedVUs = 8
  maxVUs = 24

Kiểm tra:
  scenarios: (100.00%) 1 scenario, 24 max VUs, ...
  * auth_token_validation_rps: 15.0 iterations/s for 45s
    (executor: constant-arrival-rate, preAllocatedVUs: 8, maxVUs: 24)
```

### Bước 2: Tính scheduled slots dự kiến

```text
Công thức:
  scheduled_slots = rate × duration_seconds
                  = 15 × 45
                  = 675 slots

Đây là số iteration KỲ VỌNG nếu không có drop/interrupt.
Sai số ±2 do boundary scheduling là bình thường.
```

### Bước 3: So sánh iterations thực tế với scheduled slots

```text
Từ Run 90:
  iterations = 676

So sánh:
  676 / 675 = 100.15% → iterations hơi cao hơn scheduled slots 1 đơn vị

Nguyên nhân:
  - Boundary scheduling: slot cuối cùng được schedule ở t=44.933s
  - Nếu slot này hoàn thành, counter iterations = 675
  - Nhưng scheduler có thể schedule thêm 1 slot ở boundary (t=45.000s)
    nếu slot cuối schedule trước đó chưa tới 45s
  - → 676 iterations là BÌNH THƯỜNG, không phải lỗi

Kết luận: iterations ≈ scheduled_slots → OK
```

### Bước 4: Verify dropped_iterations và interrupted

```text
Từ Run 90:
  dropped_iterations = 0
  interrupted_iterations = 0 (hoặc không xuất hiện)

Kiểm tra chéo:
  iterations ≈ scheduled_slots - dropped_iterations - interrupted_iterations
  676 ≈ 675 - 0 - 0 = 675
  → Sai số +1 do boundary scheduling → OK

Kết luận: 0 dropped → contract không bị breach
```

### Bước 5: Phân tích latency và failed events

```text
Từ Run 90:
  http_req_failed: 0.00%
  checks: 100%
  constant_arrival_events_failed: 0
  constant_arrival_event_duration_ms p95: 23ms

Phân tích sâu:
  - p95 = 23ms → auth service đang rất nhanh
  - 0 failed events → mọi auth event đều thành công
  - 0 http_req_failed → không có HTTP errors

  Weighted p95 breakdown (ước lượng từ query params):
    GET /me:       cpu=1ms + db=1row ≈ 10-15ms
    POST /login:   cpu=2ms + db=1row ≈ 15-25ms
    POST /refresh: cpu=1ms + db=1write ≈ 15-20ms

    → p95 tổng 23ms là hợp lý, phản ánh weighted average của 3 branch

Business conclusion:
  Auth service đáp ứng ĐỦ 15/s contract, 0 drop, latency thấp
  → PASS. Auth service sẵn sàng cho production.
```

## Dashboard 3-chart deep analysis

Sau khi chạy, mở dashboard để đọc biểu đồ real-time. Case 02 đơn giản hơn case 01
vì mỗi event chỉ có 1 API call, nhưng dashboard vẫn cung cấp insight quan trọng.

### Chart 1 — Response time (drill by operation)

Chart này quan trọng NHẤT với case 02 vì auth có 3 branch latency khác nhau.

```text
Mỗi point = thống kê response time trong 1 time bucket (1 giây)

Các series chính:
  Avg response
  Batch p95
  Batch max
```

**Đọc thực tế với case 02**:

```text
Kỳ vọng shape đẹp:
  - Avg response: ổn định quanh 15-25ms
  - Batch p95: không spike > 50ms
  - Batch max: không có outlier > 200ms

Nếu chart xấu:
  - p95 spike định kỳ (mỗi 5-10 giây): có thể DB backup job hoặc GC pause
  - p95 tăng dần theo thời gian: memory leak hoặc connection pool cạn
  - max có spike rất cao nhưng p95 ổn: vài request outlier, chưa nghiêm trọng
  - p95 và max cùng spike: vấn đề hệ thống thật
```

**Drill-down theo operation**:

```text
Để drill-down, cần filter theo tag operation trên dashboard:

1. Chọn metric: constant_arrival_event_duration_ms
2. Filter tag operation = auth_arrival_me
   → Xem p95 của GET /me riêng
   → Kỳ vọng: 5-15ms (nhanh nhất)

3. Filter tag operation = auth_arrival_login
   → Xem p95 của POST /login riêng
   → Kỳ vọng: 15-40ms (chậm hơn do hash)

4. Filter tag operation = auth_arrival_refresh
   → Xem p95 của POST /refresh riêng
   → Kỳ vọng: 10-30ms

Nếu login p95 >> me p95 (vd 200ms vs 10ms):
  → Login path có vấn đề riêng (hash cost, DB query)
  → Không kết luận "auth service chậm"
  → Kết luận: "login endpoint cần optimization"
```

### Chart 2 — Execution timeline

```text
Mỗi point = trạng thái execution trong 1 time bucket

Các series chính:
  Live VUs
  RPS (HTTP reqs/s)
  Iterations hoàn thành
```

**Đọc thực tế với Run 90**:

```text
Kỳ vọng shape đẹp:
  - Live VUs: ổn định ở mức thấp (1-3 VU), không tăng vọt
  - HTTP reqs/s: gần 15/s, ổn định
  - Iterations/bucket: gần 15/s, ổn định

Giải thích VU thấp:
  - Với p95=23ms, 1 VU xử lý được ~43 request/s
  - Rate target = 15/s → 1 VU là đủ
  - preAllocatedVUs=8 là quá dư
  - → Dashboard sẽ thấy Live VUs = 1-2 trong suốt test

Nếu shape xấu:
  - Live VUs tăng dần và giữ cao: auth đang chậm, VU bị giữ lâu
  - Live VUs chạm maxVUs=24: nguy hiểm, sắp có drop
  - RPS/iterations tụt dưới 15/s: đang có drop hoặc VU không kịp
  - RPS và iterations không khớp: bất thường (case này 1 event = 1 request)
```

### Chart 3 — VUs vs iter/s

```text
Mỗi point = VU và iteration throughput trong 1 time bucket

Các series chính:
  Executor VUs (envelope)
  Actual iter/s
```

**Đọc thực tế với Run 90**:

```text
Kỳ vọng shape đẹp:
  - Executor VUs: đường envelope (dựa trên preAllocatedVUs=8, maxVUs=24)
  - Actual iter/s: dao động quanh 15/s, ổn định
  - Actual iter/s không tụt khỏi 15/s

Nếu shape xấu:
  - Actual iter/s tụt dưới 15/s trong khi VUs tăng → auth chậm, VU không kịp
  - Actual iter/s tụt + VUs chạm max → sắp drop
  - Actual iter/s dao động mạnh (>50%): auth service không ổn định

So sánh với constant-vus:
  - constant-vus: iter/s giảm khi auth chậm (closed model)
  - constant-arrival-rate: iter/s GIỮ 15/s, VUs TĂNG khi auth chậm (open model)
  - → Đây là điểm khác biệt quan trọng trên chart
```

### Executor tab

```text
executor = constant-arrival-rate

Checklist Executor tab:
  1. executor detect đúng "constant-arrival-rate"
  2. rate = 15, timeUnit = 1s, duration = 45s
  3. preAllocatedVUs = 8, maxVUs = 24
  4. dropped_iterations = 0 (khớp summary)
  5. Actual iter/s gần target rate (15/s)
  6. VU usage thấp hơn max (auth nhanh → ít VU)
```

## 4 output → decision scenarios

### Scenario A: PERFECT PASS

```text
Output:
  iterations: 676
  dropped_iterations: 0
  http_req_failed: 0.00%
  checks: 100%
  constant_arrival_events_failed: 0
  constant_arrival_event_duration_ms p95: 23ms
  VU usage: 1-2 (thấp, xa maxVUs)

Kết luận:
  - Auth service đáp ứng ĐỦ 15 arrivals/s contract
  - 0 drop → không breach
  - p95=23ms → latency rất thấp
  - VU usage thấp → còn nhiều headroom

QUYẾT ĐỊNH: Auth service PASS. Sẵn sàng production.
  Có thể tăng rate lên để tìm điểm bắt đầu drop (capacity testing).
```

### Scenario B: PASS nhưng login/refresh latency cao

```text
Output:
  iterations: 675
  dropped_iterations: 0
  http_req_failed: 0.00%
  checks: 100%
  constant_arrival_events_failed: 0
  constant_arrival_event_duration_ms p95: 45ms (tổng)

  Drill-down:
    auth_arrival_me p95: 12ms      ← OK
    auth_arrival_login p95: 180ms  ← CAO
    auth_arrival_refresh p95: 95ms ← HƠI CAO

Kết luận:
  - Contract vẫn pass (0 drop)
  - Nhưng login p95=180ms vượt SLO (target < 100ms)
  - Nguyên nhân có thể: hash cost quá cao, DB query chậm, GC pause
  - Nếu không fix: user login sẽ chậm, ảnh hưởng UX

QUYẾT ĐỊNH: PASS contract nhưng OPEN TICKET cho login endpoint optimization.
  Không chặn release nếu login SLO không phải hard requirement.
  Nhưng cần fix trước khi tăng rate lên (vd 50/s).
```

### Scenario C: CONTRACT BREACH (dropped > 0, VUs near max)

```text
Output:
  iterations: 580
  dropped_iterations: 95
  http_req_failed: 0.00%
  checks: 100%
  constant_arrival_events_failed: 0
  constant_arrival_event_duration_ms p95: 1800ms
  VU usage: 22-24 (sát maxVUs)

Kết luận:
  - CONTRACT BREACH: 95/675 = 14% request bị drop
  - Auth service quá chậm (p95=1800ms)
  - VU demand = ceil(15 × 1.8) = 27 VU > maxVUs=24
  - Kể cả tăng maxVUs lên 30 cũng không giải quyết gốc: auth latency là vấn đề
  - 95 user request không được validate → 95 user thấy lỗi

QUYẾT ĐỊNH: FAIL. Không release.
  - Điều tra auth service latency (DB, cache, network)
  - Tăng maxVUs là workaround tạm thời, không phải fix
  - Auth p95=1800ms là KHÔNG THỂ CHẤP NHẬN trong production
```

### Scenario D: Failed events tập trung ở refresh path

```text
Output:
  iterations: 673
  dropped_iterations: 0
  http_req_failed: 0.00%
  checks: 99.2%  ← có fail!
  constant_arrival_events_failed: 56
  constant_arrival_event_duration_ms p95: 28ms (tổng)

  Drill-down constant_arrival_events_failed theo operation:
    auth_arrival_me: 0 failed
    auth_arrival_login: 1 failed
    auth_arrival_refresh: 55 failed  ← TẬP TRUNG Ở ĐÂY

  Drill-down refresh:
    POST /api/sim/auth/refresh → 55 lần trả về status 500
    Nguyên nhân: refresh token store (Redis/DB) bị lỗi khi write

Kết luận:
  - Contract KHÔNG breach (0 drop)
  - Nhưng refresh path có bug: 55/68 ≈ 81% refresh request fail
  - /me và /login vẫn OK → vấn đề CỤC BỘ ở refresh endpoint
  - Không kết luận "auth service fail" vì 75% traffic (/me) vẫn OK

QUYẾT ĐỊNH: FAIL (do checks < 99% và events_failed > 10).
  - Điều tra refresh token store
  - Fix trước khi release vì refresh fail → user bị logout đột ngột
  - Đây là ví dụ drill-down theo operation CỨU kết luận sai
    (nếu chỉ nhìn p95 tổng 28ms → tưởng auth OK)
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 676 iter, 0 drop, p95=23ms, 0 fail | Auth đáp ứng contract, latency thấp | PASS, sẵn sàng production |
| 0 drop nhưng login/refresh p95 cao | Contract pass, nhưng endpoint cụ thể chậm | PASS + ticket optimization |
| drop > 0, VUs sát max | Auth không đáp ứng rate target | FAIL, điều tra auth latency |
| failed events tập trung 1 operation | Bug cục bộ ở 1 endpoint | FAIL, fix endpoint đó |
| iterations < scheduled, 0 drop, 0 fail | Interrupted (maxDuration cắt) | Tăng maxDuration, chạy lại |
| p95 thấp nhưng drop > 0 | Auth nhanh nhưng VU pool quá nhỏ | Tăng maxVUs (workaround) HOẶC điều tra auth latency distribution |

## "Nghịch lý" (counterintuitive truths)

### Nghịch lý 1: "8 preAllocatedVUs nhưng test 500 auth users"

```text
Người mới nhìn config:
  preAllocatedVUs = 8
  userPool = 500
  → "Sao 8 VU mà test được 500 users? Vô lý!"

Tại sao nghĩ vậy là SAI:
  - preAllocatedVUs = số WORKER (V8 isolates) sẵn sàng nhận slot
  - userPool = số USER IDENTITY trong pool test data
  - 1 VU có thể xử lý NHIỀU user khác nhau qua các slot
  - VU chỉ là "công nhân", không phải "khách hàng"

Tương tự đời thường:
  - 8 nhân viên ngân hàng (VU = worker)
  - 500 khách hàng (userPool = identity)
  - Mỗi khách đến quầy, nhân viên rảnh sẽ phục vụ
  - 8 nhân viên PHỤC VỤ ĐƯỢC 500 khách, chỉ là không đồng thời

Cách user identity được gán:
  user-1  → slot #0 (VU bất kỳ)
  user-2  → slot #1 (VU bất kỳ)
  ...
  user-500 → slot #499 (VU bất kỳ)
  user-1  → slot #500 (lặp, VU bất kỳ)

  → 500 users được test qua 500 slot, VU chỉ là phương tiện vận chuyển
```

### Nghịch lý 2: "Auth service pass dù p95=23ms (cao hơn storefront 4ms)"

```text
Người mới so sánh:
  Storefront case: p95 = 4ms
  Auth case:       p95 = 23ms
  → "Auth chậm hơn storefront gấp 5 lần, sao vẫn pass?"

Tại sao vẫn pass:
  1. KHÁC SLO: Auth có write operation (login/refresh), storefront toàn read
     - Storefront GET /api/products: read-only, pure cache → p95=4ms
     - Auth POST /login: hash verification + DB write → p95=20-40ms
     - Không thể so sánh ngang bằng

  2. KHÁC TRAFFIC PATTERN:
     - Storefront: 100% read, cache-friendly
     - Auth: 25% write (login 15% + refresh 10%), write luôn chậm hơn read

  3. PASS CRITERIA KHÁC NHAU:
     - Auth case: pass khi 0 drop + failed events < 10
     - Không có hard SLO "p95 < X" trong threshold (chỉ checks + drop)

  4. WEIGHTED AVERAGE:
     - 75% traffic là me (p95 ~10-15ms) → kéo average xuống
     - 25% traffic là login/refresh (p95 ~20-40ms) → đẩy p95 lên
     - p95 tổng = 23ms là weighted average tự nhiên, không phải "chậm"

  → Auth p95=23ms là HOÀN TOÀN BÌNH THƯỜNG cho workload có 25% write
  → Nếu auth p95=4ms với cùng workload → mới là bất thường (quá nhanh)
```

### Nghịch lý 3: "rate=15/s nhưng iter/s có thể khác 15"

```text
Người mới đọc dashboard:
  rate config = 15/s
  Actual iter/s trên chart: có bucket 13/s, bucket 17/s
  → "Sao không đúng 15/s? Config sai à?"

Tại sao iter/s dao động:
  1. BUCKET AGGREGATION:
     - Dashboard gom metric theo bucket 1 giây
     - Trong 1 bucket có thể có 13 iteration hoàn thành (bucket lẻ)
       hoặc 17 iteration hoàn thành (bucket chẵn)
     - TỔNG các bucket = expected iterations (675)
     - AVERAGE các bucket ≈ 15/s

  2. BOUNDARY EFFECT:
     - Slot được schedule đều đặn mỗi 67ms (1/15s)
     - Nhưng iteration HOÀN THÀNH phụ thuộc vào thời điểm kết thúc
     - Nếu 2 iteration kết thúc trong cùng 1 bucket → bucket đó có 2 iter
     - Nếu 1 iteration kéo dài qua 2 bucket → bucket đầu 0 iter, bucket sau 1 iter

  3. STARTUP/COOLDOWN:
     - Đầu test: slot đầu tiên chưa kịp hoàn thành → iter/s = 0
     - Cuối test: slot cuối hoàn thành sau khi hết duration → iter/s = 0
     - → iter/s chỉ ổn định ở giữa test

  → Giống như: "Xe chạy 60 km/h trung bình, nhưng có lúc 55, lúc 65"
  → Tốc độ TỨC THỜI khác tốc độ TRUNG BÌNH
  → Rate=15/s là target START rate, không phải completion rate từng giây
```

### Nghịch lý 4: "Auth /me nhanh nhưng login/refresh chậm → kết luận sao?"

```text
Scenario:
  p95 me: 10ms       ← rất nhanh
  p95 login: 500ms   ← rất chậm
  p95 refresh: 300ms ← chậm
  p95 tổng: 87ms     ← trông "ổn"

Người mới nhìn p95 tổng 87ms:
  → "Auth ổn, p95 < 100ms"

Tại sao kết luận này SAI:
  - 75% traffic là me (10ms) → weighted average bị kéo xuống
  - 25% traffic là login+refresh (500ms, 300ms) → tail latency rất xấu
  - p95 tổng = 87ms CHE GIẤU việc 25% user có trải nghiệm RẤT TỆ
  - User login mất 500ms → bực mình, thoát app
  - User refresh token mất 300ms → gián đoạn session

Cách đọc đúng:
  - LUÔN drill-down theo operation, không chỉ nhìn p95 tổng
  - So sánh p95 từng operation với SLO riêng:
    me < 30ms, login < 100ms, refresh < 80ms
  - Nếu 1 operation breach SLO → kết luận operation ĐÓ có vấn đề
  - Không đánh giá "auth service" như một khối đồng nhất

Bài học:
  - Weighted metrics CHE GIẤU tail latency của minority path
  - Trong auth, login/refresh dù ít (25%) nhưng QUAN TRỌNG
    (user không login được → không vào được app)
  - → Luôn drill-down, không kết luận từ metric tổng
```

## Checklist

### Pre-run

```text
[ ] Stack đã start (app + dashboard + DB)
[ ] BASE_URL trỏ đúng (http://localhost:80)
[ ] K6_CLOUD_HOST trỏ đúng (http://localhost:18080)
[ ] K6_CLOUD_TOKEN đã set (student-token-1234567890)
[ ] Script path đúng (car-02-auth-token-validation-rps.js)
[ ] Auth service endpoints accessible (test curl GET /api/sim/auth/me)
[ ] Env vars đã set đúng (rate=15, duration=45s, preAllocatedVUs=8, maxVUs=24)
[ ] Không có process nào chiếm port 80/18080/13001
```

### During run

```text
[ ] Dashboard real-time hiển thị data (http://localhost:13001)
[ ] Response time chart: không spike bất thường > 200ms
[ ] Execution timeline: Live VUs không chạm maxVUs=24
[ ] VUs vs iter/s: Actual iter/s gần 15/s
[ ] Executor tab: executor = constant-arrival-rate
[ ] Không có dropped_iterations xuất hiện giữa chừng
```

### Post-run

```text
[ ] iterations ≈ 675 (±5)
[ ] dropped_iterations = 0
[ ] http_req_failed = 0.00%
[ ] checks rate > 99%
[ ] constant_arrival_events_failed = 0 (hoặc < 10)
[ ] constant_arrival_event_duration_ms p95 < 50ms
[ ] Drill-down me/login/refresh: không operation nào p95 bất thường
[ ] http_reqs ≈ iterations (≈ 675)
[ ] constant_arrival_api_calls_total ≈ http_reqs
[ ] constant_arrival_events_total ≈ iterations
```

## Variations với code

### Variation 1: Lower rate smoke test

```powershell
# Smoke test: rate=1/s, duration=10s → 10 slots
$env:CAR_02_RATE = "1"
$env:CAR_02_DURATION = "10s"
$env:CAR_02_PREALLOCATED_VUS = "2"
$env:CAR_02_MAX_VUS = "4"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-02-auth-token-validation-rps.js"
```

```text
Mục đích:
  - Verify script chạy đúng, không lỗi syntax
  - Verify tag/metric được emit đúng
  - Verify dashboard nhận data
  - Expected: 10 iterations, 0 drop, latency thấp

Dùng khi:
  - Mới set up môi trường
  - Sau khi sửa script
  - Trước khi chạy full test
```

### Variation 2: Shrink VU pool → observe dropped

```powershell
# Giảm preAllocatedVUs và maxVUs để ép drop
$env:CAR_02_RATE = "30"
$env:CAR_02_PREALLOCATED_VUS = "1"
$env:CAR_02_MAX_VUS = "2"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-02-auth-token-validation-rps.js"
```

```text
Mục đích:
  - QUAN SÁT dropped_iterations > 0
  - Hiểu cơ chế: rate cao + VU pool nhỏ → drop
  - So sánh với run bình thường (rate=15, VU=8/24, 0 drop)

Phân tích:
  rate=30/s, W_effective≈0.023s
  VU cần = ceil(30 × 0.023) = ceil(0.69) = 1 VU (về lý thuyết)
  Nhưng với preAllocatedVUs=1, nếu auth có spike latency:
    W_effective=0.200s → VU cần = ceil(30 × 0.200) = 6 VU
    Nhưng maxVUs=2 → thiếu 4 VU → drop

  → Đây là demo "VU sizing sai → contract breach"
  → Trong production: luôn cần headroom VU cho latency spike
```

### Variation 3: Change branch weights

```js
// Sửa trong script hoặc tạo script variation
// Tăng weight login và refresh để test write-heavy scenario

const choice = weightedPick([
  { name: 'me', weight: 40 },      // giảm từ 75 → 40
  { name: 'login', weight: 35 },   // tăng từ 15 → 35
  { name: 'refresh', weight: 25 }, // tăng từ 10 → 25
], ctx.iter);
```

```powershell
# Chạy script variation
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-02-auth-token-validation-rps-write-heavy.js"
```

```text
Mục đích:
  - Test auth service với nhiều write operation hơn
  - Write (login/refresh) chậm hơn read (me)
  - → VU demand tăng, có thể gây drop nếu VU pool không đủ

Phân tích với weight mới (40/35/25):
  W_avg = 0.40 × W_me + 0.35 × W_login + 0.25 × W_refresh
  W_avg = 0.40 × 15 + 0.35 × 35 + 0.25 × 25
        = 6 + 12.25 + 6.25
        = 24.5ms

  VU cần = ceil(15 × 0.0245) = ceil(0.3675) = 1 VU
  → Vẫn an toàn với preAllocatedVUs=8

  Nhưng nếu auth service thật (không simulated):
    - Login hash cost thực tế có thể 100-500ms
    - Refresh với DB write có thể 50-200ms
    - → VU demand cao hơn nhiều
```

### Variation 4: Add external latency to auth backend

```powershell
# Thêm delay vào auth service backend (nếu backend hỗ trợ)
# Hoặc dùng env var để tăng cpu_ms, db_rows

# Giả lập auth chậm bằng cách tăng CPU time
# (nếu backend script dùng query params cpu_ms, db_rows)
```

```text
Mục đích:
  - Mô phỏng auth service bị chậm (network latency, DB slow, GC)
  - Quan sát VU demand tăng
  - Tìm điểm bắt đầu drop (capacity limit)

Cách làm (nếu backend hỗ trợ):
  GET /api/sim/auth/me?cpu_ms=50&db_rows=10  ← tăng từ 1ms lên 50ms
  → Mô phỏng auth service bị quá tải

Phân tích khi W_effective tăng:
  W_me = 50ms, W_login = 70ms, W_refresh = 60ms
  W_avg = 0.75 × 50 + 0.15 × 70 + 0.10 × 60
        = 37.5 + 10.5 + 6 = 54ms

  VU cần = ceil(15 × 0.054) = ceil(0.81) = 1 VU
  → Vẫn an toàn (auth simulated latency vẫn thấp)

  Để thấy drop: cần W_avg > maxVUs/rate = 24/15 = 1.6s
  → Auth service phải RẤT CHẬM mới drop với rate=15/s và maxVUs=24
  → Ngược lại: rate=15/s là target RẤT THẤP so với năng lực auth service
```

### Variation 5: Extend duration để thấy steady-state

```powershell
# Kéo dài duration để quan sát auth service có degradation theo thời gian không
$env:CAR_02_DURATION = "300s"
$env:CAR_02_RATE = "15"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-02-auth-token-validation-rps.js"
```

```text
Mục đích:
  - 45s có thể quá ngắn để thấy memory leak, connection pool cạn
  - 300s (5 phút) → 4500 slots → đủ dài để thấy degradation

Kỳ vọng:
  - Nếu auth service ổn: p95 ổn định trong suốt 300s
  - Nếu auth service có leak: p95 tăng dần theo thời gian
  - Nếu connection pool cạn: bắt đầu thấy http_req_failed sau 1-2 phút

Phân tích output:
  - So sánh p95 60s đầu vs 60s cuối
  - Nếu chênh > 20% → có degradation
  - Xem Executor tab: VU usage có tăng dần không?
```

## Anti-patterns (mở rộng)

### Anti-pattern 1: "8 preAllocatedVUs nghĩa là 8 auth users"

```text
SAI:
  "Config có preAllocatedVUs=8 → test với 8 users"
  "Tăng preAllocatedVUs lên 100 → test với 100 users"

ĐÚNG:
  preAllocatedVUs = số worker (V8 isolates) khởi tạo sẵn
  User identity đến từ userContext.userId = arrival-user-N
  N = (iterationInTest % userPool) + 1
  → Số user thực tế được test phụ thuộc vào số iteration và userPool

Ví dụ:
  675 iteration, userPool=500
  → User 1..500 được test ít nhất 1 lần
  → User 1..175 được test 2 lần (slot #0 và #500, #1 và #501, ...)
  → Tổng: 500 users unique, 675 auth events

  preAllocatedVUs=8 chỉ là "có 8 công nhân sẵn sàng xử lý 675 việc"
  → Số user = 500, số worker = 8, hai thứ KHÔNG liên quan
```

### Anti-pattern 2: "Có 675 http_reqs nên chắc 675 users"

```text
SAI:
  "http_reqs = 675 → có 675 users khác nhau được test"

ĐÚNG:
  http_reqs = số HTTP request đã gửi (mỗi event = 1 request)
  User pool = 500 → tối đa 500 users unique
  675 requests nhưng chỉ có 500 users (một số user xuất hiện 2 lần)

Cách tính user unique:
  unique_users = min(iterations, userPool) = min(675, 500) = 500

Tần suất mỗi user:
  user-1: slot #0, #500 → 2 lần
  user-2: slot #1, #501 → 2 lần
  ...
  user-175: slot #174, #674 → 2 lần
  user-176..500: 1 lần mỗi user

  → 675 requests, 500 unique users, KHÔNG PHẢI 675 users
```

### Anti-pattern 3: "Auth p95 thấp nên pass"

```text
SAI:
  "p95 = 23ms, rất nhanh → auth service pass"

ĐÚNG:
  Pass cần ÍT NHẤT:
    1. dropped_iterations = 0 (contract không breach)
    2. http_req_failed < 1% (request không lỗi)
    3. checks rate > 99% (response đúng)
    4. constant_arrival_events_failed < 10 (event không fail)

  p95 thấp là GOOD-TO-HAVE, không phải pass criteria chính
  Có thể p95=10ms nhưng dropped_iterations=100 → FAIL

Ví dụ phản chứng:
  rate=100/s, preAllocatedVUs=2, maxVUs=2, auth p95=10ms
  VU cần = ceil(100 × 0.010) = 1 VU → về lý thuyết đủ
  Nhưng thực tế: VU spawn không kịp, network jitter → drop
  → p95=10ms, nhưng dropped_iterations=500 → FAIL

  → Luôn kiểm dropped_iterations TRƯỚC, latency SAU
```

### Anti-pattern 4: "Tăng maxVUs để fix dropped_iterations"

```text
SAI:
  "dropped_iterations > 0 → tăng maxVUs lên là fix được"

ĐÚNG:
  Tăng maxVUs là WORKAROUND, không phải FIX
  Nguyên nhân gốc: auth service QUÁ CHẬM
  Fix thật sự: tối ưu auth service latency

Ví dụ:
  rate=15/s, auth p95=2000ms
  VU cần = ceil(15 × 2.0) = 30 VU

  Workaround: tăng maxVUs lên 30 → 0 drop
  Nhưng: auth p95=2000ms → user chờ 2 giây mỗi lần validate token
  → UX rất tệ, dù không drop

  Fix thật: tối ưu auth service (cache, index, query optimization)
  → auth p95=20ms → VU cần = 1 → 0 drop + UX tốt

  Tăng maxVUs có chi phí:
    - Mỗi VU tốn RAM (V8 isolate ~3-5MB)
    - 30 VU tốn 90-150MB RAM trên load generator
    - Nếu load generator yếu → chính load generator thành bottleneck

  → Chỉ tăng maxVUs khi:
    1. Auth latency ĐÃ được tối ưu hết mức
    2. Auth latency vẫn cần số VU đó (vd login hash cost không giảm được)
    3. Load generator đủ tài nguyên
```

### Anti-pattern 5: "Case 02 giống case 01, chỉ khác executor"

```text
SAI:
  "Case 01 (per-vu-iterations) và case 02 (constant-arrival-rate)
   đều là test load, chỉ khác executor config"

ĐÚNG:
  Hai case KHÁC NHAU HOÀN TOÀN về:
    1. MÔ HÌNH: closed (case 01) vs open (case 02)
    2. IDENTITY: VU-bound (case 01) vs slot-driven (case 02)
    3. STATE: có state qua iter (case 01) vs stateless (case 02)
    4. WORKLOAD: multi-step journey (case 01) vs single API call (case 02)
    5. PASS CRITERIA: count + p95 (case 01) vs drop + rate (case 02)
    6. FAIL MODE: count thiếu (case 01) vs drop > 0 (case 02)

  → Đây là 2 case dạy 2 EXECUTOR FAMILY khác nhau
  → Case 01: khi nào dùng per-vu-iterations
  → Case 02: khi nào dùng constant-arrival-rate
```

## Reference

- Doc tham số constant-arrival-rate: `docs/20260514_01_per-vu-iterations-quick-index.md` (xem phần so sánh executor)
- Executor mechanics tổng quát: `docs/20260114_00_vu-lifecycle-and-iteration-counters.md`
- Case 01 (per-vu-iterations): `docs/practice/per-vu-iterations/01_user-journey-replay.md`
- Case 03 (constant-vus): `docs/practice/constant-vus/03_constant-vus.md`
- Section 8.7: quy trình 5 bước phân tích output
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-02-auth-token-validation-rps.js`
- Common helpers: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\common.js`
