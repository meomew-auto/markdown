# Case 06: Cacheable feed ingress

## Tình huống thực tế

Products/feed service là entry point chính của ứng dụng e-commerce. Mỗi khi user mở app,
họ thấy homefeed (danh sách sản phẩm được cá nhân hóa) và recommendations (sản phẩm gợi ý
dựa trên thuật toán collaborative filtering). Traffic này là **read-only, cache-friendly**,
và đến theo nhịp cố định từ mobile app + web.

### Vì sao feed ingress buộc chọn constant-arrival-rate?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của feed ingress test:

```text
Feed ingress test = "Products service có đáp ứng được 24 feed arrivals/s
                     trong 45 giây không, và có drop event nào không?"

Đời thường:
  Foodpanda/GrabFood mở app lúc 12h trưa:
    - 5000 user cùng mở app trong 1 phút
    - Mỗi user load homefeed + recommendations
    - Nếu feed service không kịp -> user thấy loading spinner
    - User thoát app -> mất đơn hàng -> mất revenue
    
  QA cần biết: service chịu được bao nhiêu arrivals/s?
  -> Test với constant-arrival-rate để mô phỏng external traffic cố định
```

Để feed ingress test **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**.
Chỉ constant-arrival-rate mới thỏa mãn cả 2.

#### Yêu cầu (a): FIXED INGRESS RATE (rate đến không đổi bất kể service chậm hay nhanh)

**Ý nghĩa**: External traffic từ app/web đến service với nhịp cố định. Nếu service
chậm, request không "chậm lại theo service" — chúng vẫn đến đúng nhịp, và nếu không
xử lý kịp thì request sẽ timeout hoặc queue.

**Ví dụ cụ thể**:

```text
Scenario: products service bị cache miss hàng loạt (Redis down)

Trường hợp A (constant-vus với duration):
  config: 12 VUs, duration=45s
  Khi cache miss -> request chậm (từ 4ms -> 80ms)
  -> throughput tụt: 12 VU / 0.08s = 150 req/s tụt còn 150 req/s... 
     thực ra vẫn 150 req/s vì 12 VU vẫn chạy liên tục
  -> NHƯNG: 12 VU × (45s / 0.004s) = 135,000 request với cache hit
           12 VU × (45s / 0.080s) = 6,750 request với cache miss
  -> Số request KHÁC NHAU hoàn toàn -> không biết "service chịu được bao nhiêu arrivals/s"
  -> Test không trả lời được câu hỏi business

Trường hợp B (constant-arrival-rate):
  config: rate=24/s, duration=45s
  Khi cache hit (4ms):   24 arrivals/s được xử lý dễ dàng, VU dư nhiều
  Khi cache miss (80ms): vẫn 24 arrivals/s đến, nhưng VU requirement tăng
                          từ ceil(24 × 0.004) = 1 VU -> ceil(24 × 0.080) = 2 VU
  -> Vẫn 1080 arrivals trong 45s
  -> Nếu thiếu VU -> dropped_iterations báo hiệu "service không kịp"
  -> Test trả lời ĐÚNG câu hỏi business
```

**Phân tích sâu: vì sao "rate cố định" là bắt buộc với feed ingress?**

```text
External traffic không tự điều chỉnh theo service capacity:
  - 1000 user mở app cùng lúc -> 1000 feed requests gửi đi
  - Service có khỏe hay yếu, request vẫn đến đúng 1000
  - Nếu service yếu -> request timeout, user thấy lỗi
  - Service không thể "bảo" mobile app gửi chậm lại

Cho nên test PHẢI giữ nguyên rate:
  - rate=24/s nghĩa là mỗi giây có đúng 24 feed arrivals
  - Dù service chậm (cache miss) hay nhanh (cache hit)
  - Dù VU pool có đủ hay không
  - Nếu không đủ VU -> drop (giống production: request timeout)
```

**So sánh với constant-vus (duration-based)**:

```text
constant-vus với vus=12, duration=45s:
  - Mỗi VU chạy liên tục: gọi API -> đợi response -> gọi tiếp
  - Cache hit (4ms/request):   12 × (45000/4) = 135,000 request
  - Cache miss (80ms/request): 12 × (45000/80) = 6,750 request
  - KHÔNG kiểm soát được số request -> test không reproducible
  - KHÔNG mô phỏng được external traffic pattern
```

**Trong khi đó với `constant-arrival-rate`**:

```text
Config: rate=24, timeUnit=1s, duration=45s

Cache hit scenario:
  N_sched = 24 × 45 = 1080 arrivals
  required_vus ≈ 24 × 0.004 = 0.1 -> 1 VU là đủ
  N_done = 1080, N_drop = 0

Cache miss scenario:
  N_sched = 24 × 45 = 1080 arrivals (VẪN 1080)
  required_vus ≈ 24 × 0.080 = 1.92 -> cần 2 VU
  N_done = 1080, N_drop = 0 (vẫn pass vì preAllocatedVUs=12 >> 2)

Cache CRISIS (200ms/request):
  N_sched = 24 × 45 = 1080 arrivals (VẪN 1080)
  required_vus ≈ 24 × 0.200 = 4.8 -> cần 5 VU
  N_done = 1080, N_drop = 0 (vẫn pass, pre=12 > 5)

-> Dù service nhanh hay chậm, số arrivals vẫn là 1080
-> Test reproducible, so sánh được qua các lần chạy
```

#### Yêu cầu (b): PHÁT HIỆN DROP KHI THIẾU CAPACITY

**Ý nghĩa**: Khi service quá chậm hoặc VU pool quá nhỏ, k6 không thể giao iteration
cho VU kịp -> slot bị drop. `dropped_iterations` chính là tín hiệu "production sẽ có
request timeout".

**Ví dụ thực tế**:

```text
Scenario: Redis cache cluster bị sập, mọi request phải query DB trực tiếp

Cache hit bình thường:
  p95=4ms, required_vus ≈ 1, preAllocatedVUs=12 -> dư thừa lớn

Cache MISS toàn bộ (DB query 200ms thay vì cache 2ms):
  p95=200ms, required_vus ≈ 24 × 0.200 = 4.8 -> cần 5 VU
  preAllocatedVUs=12 vẫn đủ -> không drop

Cache MISS + DB chậm (500ms vì thiếu index):
  p95=500ms, required_vus ≈ 24 × 0.500 = 12 VU
  preAllocatedVUs=12 -> vừa đủ, nhưng không có buffer

Cache MISS + DB quá tải (2000ms):
  p95=2000ms, required_vus ≈ 24 × 2.0 = 48 VU
  maxVUs=30 -> KHÔNG ĐỦ -> dropped_iterations > 0
  -> Test PHÁT HIỆN: service không đáp ứng được 24 arrivals/s
```

**Vì sao cần dropped_iterations làm tín hiệu?**

```text
Nếu không có dropped_iterations:
  - constant-vus: test chạy chậm hơn, ít request hơn, nhưng KHÔNG báo "drop"
  - per-vu-iterations: count cố định, không liên quan đến rate
  - shared-iterations: count cố định, không liên quan đến rate

Chỉ constant-arrival-rate có khái niệm "drop" vì:
  - Có schedule cố định (24 slots/s)
  - Có VU pool giới hạn (maxVUs=30)
  - Khi schedule > capacity -> drop
  -> Giống hệt production: request đến > server capacity -> timeout
```

**Tóm tắt 2 yêu cầu**:

| Yêu cầu | Ý nghĩa | constant-vus | constant-arrival-rate |
| --- | --- | --- | --- |
| (a) Fixed ingress rate | 24 arrivals/s không đổi dù service nhanh/chậm | ✗ rate phụ thuộc iter_time | ✓ rate cố định |
| (b) Phát hiện drop | Biết khi nào capacity không đủ | ✗ không có khái niệm drop | ✓ dropped_iterations |

→ Chỉ **constant-arrival-rate** thỏa mãn cả 2 yêu cầu cho feed ingress.

### 3 nguyên nhân nghiệp vụ cụ thể (= 3 thông số config)

```text
1. HIGHEST RATE IN PACK (24 arrivals/s):
   - Feed service nhận traffic cao nhất trong các service
   - Checkout chỉ 5/s, report chỉ 10/s, nhưng feed phải chịu 24/s
   - Đây là stress test cho cache layer và read path
   → rate = 24, timeUnit = 1s

2. CACHE-DEPENDENT LATENCY (event duration biến thiên mạnh):
   - Cache hit: ~4ms (cực nhanh)
   - Cache miss: 50-200ms (chậm hơn 10-50×)
   - Test phải chạy với cache warm để thấy "happy path", nhưng
     cũng phải hiểu cache miss scenario
   → preAllocatedVUs = 12 (dư nhiều để buffer cache miss)
   → maxVUs = 30 (trần cao để xử lý crisis)

3. WEIGHTED BRANCHES (65% homefeed, 35% recommendations):
   - Homefeed: nhẹ (personalized=1, json_items=12, gzip_kb=1)
   - Recommendations: nặng hơn (collaborative algorithm, limit=6)
   - Tỉ lệ 65/35 mô phỏng traffic pattern thực tế
   → weightedPick chọn branch theo iteration index
```

> **Feed ingress là gì?** = điểm vào của traffic feed từ app/web. Không phải
> user chủ động gọi API, mà là app tự động load feed khi user mở app.
>
> ```text
> User mở app -> app gọi GET /api/sim/products/homefeed
>             -> app gọi GET /api/sim/products/:id/recommendations
>             -> user scroll, app gọi tiếp...
> ```
>
> **Cacheable là gì?** = response có thể cache vì ít thay đổi. Homefeed thay
> đổi chậm (vài phút), recommendations thay đổi theo user behavior (chậm).
> Nên cache hit rate có thể rất cao (95%+).
>
> **Đời thường**: giống như bảng giá vàng trước tiệm vàng — 1000 người đi
> ngang nhìn bảng giá, bảng giá không đổi (cache hit). Nhưng thỉnh thoảng
> giá vàng thay đổi -> phải cập nhật bảng (cache miss). Tần suất cập nhật
> thấp, nên 99% là "cache hit".

Yêu cầu cụ thể:

```text
- 24 feed arrivals mỗi giây trong 45 giây
- 65% homefeed (GET /api/sim/products/homefeed)
- 35% recommendations (GET /api/sim/products/:id/recommendations)
- Mỗi arrival event = đúng 1 API call
- Có AB variant + geo + device segmentation headers
- Không chấp nhận dropped iterations (MAX_DROPPED = 0)
- Tổng scheduled slots = 1080
```

## Vì sao chọn constant-arrival-rate?

```text
Vì YÊU CẦU NGHIỆP VỤ là:
  - "24 feed arrivals/s cố định" -> constant-arrival-rate giữ rate cố định
  - "Phát hiện khi capacity không đủ" -> dropped_iterations là tín hiệu rõ ràng
  - "Cache hit/miss ảnh hưởng VU demand" -> open model cho phép VUs biến thiên

Tại sao KHÔNG dùng executor khác?
  - constant-vus (duration=45s): rate phụ thuộc iter_time, không giữ được 24/s
  - per-vu-iterations: count cố định, không có khái niệm "rate", không mô phỏng
                       external arrivals
  - shared-iterations: tương tự, count cố định, không rate-based
  - ramping-vus: VU thay đổi theo thời gian, không kiểm soát rate
  - ramping-arrival-rate: rate thay đổi theo stage, không giữ fixed 24/s
```

### So sánh executor cho feed ingress

| Executor | Giữ được 24/s? | Phát hiện drop? | VU biến thiên theo latency? | Verdict |
| --- | --- | --- | --- | --- |
| **constant-arrival-rate** | ✓ rate cố định | ✓ dropped_iterations | ✓ open model | ✅ DÙNG |
| constant-vus | ✗ rate = vus/iter_time | ✗ không có drop | ✗ VU cố định | ❌ |
| per-vu-iterations | ✗ không có rate | ✗ không có drop | ✗ VU cố định | ❌ |
| shared-iterations | ✗ không có rate | ✗ không có drop | ✗ VU cố định | ❌ |
| ramping-vus | ✗ rate biến thiên | ✗ không có drop | ✗ VU theo stage | ❌ |
| ramping-arrival-rate | ~ rate thay đổi theo stage | ✓ có drop | ✓ open model | ~ (nếu cần fixed rate) |

→ Chỉ **constant-arrival-rate** là executor được thiết kế để giữ arrival rate cố định
và phát hiện drop khi capacity không đủ.

## Phân tích nguyên nhân gốc kỹ thuật (5 root causes)

### RC1: Little's Law — high rate × low duration = low VU requirement

Đây là **bài học quan trọng nhất** của case này. Nó đảo ngược trực giác thông thường:
"rate cao nhất pack" nhưng "VU requirement thấp nhất pack".

**Little's Law cho queueing system**:

```text
L = λ × W

Trong đó:
  L = số worker (VU) cần để xử lý throughput λ
  λ = arrival rate (24/s với case này)
  W = thời gian xử lý 1 event (iteration_duration)

Với case 06:
  λ = 24 arrivals/s
  W_effective = p95 event duration ≈ 4ms = 0.004s

  L = 24 × 0.004 = 0.096 VU

→ Về lý thuyết, 1 VU có thể xử lý toàn bộ 24 arrivals/s!
```

**Trace execution mô phỏng 1 VU xử lý 24 arrivals/s**:

```text
Timeline 1 VU xử lý arrivals (mỗi event 4ms):

t=0.000s: arrival 1  -> VU bắt đầu xử lý
t=0.004s: arrival 1  xong. VU rảnh.
t=0.042s: arrival 2  -> VU bắt đầu xử lý (schedule mỗi 41.7ms)
t=0.046s: arrival 2  xong. VU rảnh.
t=0.083s: arrival 3  -> VU bắt đầu xử lý
t=0.087s: arrival 3  xong. VU rảnh.
...

VU bận 4ms, rảnh 37.7ms trong mỗi chu kỳ 41.7ms.
Utilization = 4/41.7 = 9.6%
Còn 90.4% thời gian VU... ngồi chơi.

Đây chính là Little's Law: L = λ × W = 24 × 0.004 = 0.096
-> VU dùng chưa đến 10% capacity!
```

**Ví dụ trực quan đời thường**:

```text
Quầy bán vé tàu:
  - 24 khách đến mỗi giây (λ=24)
  - Mỗi khách mất 4ms để quét vé (W=0.004s)
  -> 1 nhân viên quét vé (L=0.096≈1) đủ phục vụ 24 khách/s
  
Quầy làm passport (checkout):
  - 5 khách đến mỗi giây (λ=5)
  - Mỗi khách mất 65ms để xử lý (W=0.065s)
  -> Cần 5 × 0.065 = 0.325 VU... nhưng thực tế cần nhiều hơn
     vì checkout có sleep/think time trong iteration
  
Cho nên: rate cao KHÔNG đồng nghĩa cần nhiều VU.
          rate × event_duration mới quyết định VU requirement.
```

**So sánh VU requirement các case**:

| Case | Executor | Rate | Event duration (p95) | Required VUs (Little) | preAllocatedVUs |
| --- | --- | ---: | ---: | ---: | ---: |
| 06 (feed) | arrival-rate | 24/s | 4ms | 0.1 ≈ 1 | 12 |
| 04 (checkout) | arrival-rate | 5/s | 65ms | 0.33 ≈ 1 | 15 |
| 05 (report) | arrival-rate | 10/s | 120ms | 1.2 ≈ 2 | 10 |

Case 06 có rate cao nhất (24/s) nhưng required VUs thấp nhất (~1) vì event duration
cực thấp (4ms). Case 04 có rate thấp hơn (5/s) nhưng preAllocatedVUs cao hơn (15)
vì event duration cao hơn (65ms) và có sleep/think time.

**Vì sao preAllocatedVUs=12 mà không phải 1?**

```text
1. Buffer cho cache miss:
   - Cache hit: W=4ms -> cần 0.1 VU
   - Cache miss: W=80ms -> cần 24 × 0.08 = 1.92 ≈ 2 VU
   - Cache miss + DB chậm: W=500ms -> cần 24 × 0.5 = 12 VU
   -> preAllocatedVUs=12 đảm bảo đủ VU ngay cả khi cache miss 100%

2. Spawn latency:
   - VU mới cần thời gian khởi tạo (V8 isolate, module init)
   - Nếu preAllocatedVUs=1 và bỗng cần 10 VU -> spawn 9 VU mới
   - Trong lúc spawn, slot có thể bị drop
   -> preAllocatedVUs=12: VU đã sẵn sàng, không cần spawn

3. Production safety margin:
   - Production không chạy ở giới hạn lý thuyết
   - PreAllocatedVUs=12 cho margin 12× so với yêu cầu tối thiểu
```

### RC2: Ticker period = 1/24 ≈ 41.7ms giữa các lần start

Constant-arrival-rate dùng ticker nội bộ để schedule iteration start:

```text
rate=24, timeUnit=1s

ticker period = timeUnit / rate = 1000ms / 24 = 41.667ms

Có nghĩa: cứ mỗi 41.667ms, executor cố gắng start 1 iteration mới.
Nếu lúc đó có VU rảnh -> iteration start ngay.
Nếu không có VU rảnh -> iteration bị DROP.
```

**Timeline schedule 24/s**:

```text
t=0.000s: schedule slot 1   -> cần VU
t=0.042s: schedule slot 2   -> cần VU
t=0.083s: schedule slot 3   -> cần VU
t=0.125s: schedule slot 4   -> cần VU
t=0.167s: schedule slot 5   -> cần VU
...
t=0.958s: schedule slot 24  -> cần VU
t=1.000s: schedule slot 25  -> chu kỳ mới

Trong 1 giây: 24 slots, mỗi slot cách nhau 41.7ms.
```

**Điều gì xảy ra nếu 1 event mất >41.7ms?**

```text
Giả sử cache miss làm event duration tăng lên 80ms:

t=0.000s: slot 1 start -> VU#1 bận đến t=0.080s
t=0.042s: slot 2 start -> VU#2 bận đến t=0.122s
t=0.083s: slot 3 start -> VU#1 vừa rảnh (xong lúc 0.080s) -> OK
t=0.125s: slot 4 start -> VU#2 vừa rảnh (xong lúc 0.122s) -> OK
t=0.167s: slot 5 start -> VU#1 rảnh -> OK
...

Với W=80ms, cần 2 VU để xử lý 24 slots/s (khớp Little's Law: 24 × 0.08 = 1.92).
Và preAllocatedVUs=12 vẫn dư sức.
```

**Điều gì xảy ra nếu event duration tăng lên 500ms?**

```text
t=0.000s: slot 1  -> VU#1 bận đến t=0.500s
t=0.042s: slot 2  -> VU#2 bận đến t=0.542s
t=0.083s: slot 3  -> VU#3 bận đến t=0.583s
...
t=0.458s: slot 12 -> VU#12 bận đến t=0.958s
t=0.500s: slot 13 -> KHÔNG CÒN VU RẢNH! VU#1 vừa xong lúc 0.500s
                     -> SCHEDULE KHỚP: VU#1 vừa rảnh đúng lúc slot 13
t=0.542s: slot 14 -> VU#2 rảnh lúc 0.542s -> đúng lúc!
...

Với W=500ms, cần chính xác 12 VU (24 × 0.5 = 12).
preAllocatedVUs=12 vừa đủ, nhưng sát giới hạn.
Nếu có bất kỳ event nào >500ms -> DROP.
```

**Ticker period quyết định "deadline" cho mỗi event**:

```text
Nếu event duration < ticker period (41.7ms):
  -> 1 VU xử lý được nhiều slot trong cùng 1 giây
  -> Ít VU cần thiết

Nếu event duration > ticker period:
  -> Cần thêm VU để slot tiếp theo không bị drop
  -> Số VU cần = ceil(event_duration / ticker_period)
                = ceil(event_duration × rate / timeUnit)
                = ceil(event_duration × 24)
```

### RC3: Cache hit vs cache miss — W_effective quyết định tất cả

Feed service cache hoạt động như thế nào, và vì sao nó ảnh hưởng đến VU requirement:

**Kiến trúc cache của products/feed service**:

```text
Request flow:
  Mobile App -> GET /api/sim/products/homefeed?personalized=1&...
             -> Cache Layer (Redis/Memcached)
                -> Cache HIT:  trả response ngay (2-4ms)
                -> Cache MISS: query DB (cpu_ms=1, db_rows=3)
                              -> build response
                              -> write cache
                              -> trả response (50-200ms)

K6 test gửi request với params mô phỏng backend work:
  homefeed:      cpu_ms=1, db_rows=3, json_items=12, gzip_kb=1
  recommendations: cpu_ms=2, db_rows=2, limit=6
```

**Backend mô phỏng latency (từ k6-metrics-server)**:

```text
K6-metrics-server nhận param cpu_ms và db_rows:
  - cpu_ms: giả lập CPU time (block event loop trong x ms)
  - db_rows: giả lập DB scan (block thêm một chút)
  - json_items: số item trong response JSON
  - gzip_kb: kích thước response sau khi gzip

Cache hit scenario (default, happy path):
  homefeed:      cpu_ms=1 + db_rows=3 + json_items=12 + gzip_kb=1
                 -> thực tế ~4ms total
  recommendations: cpu_ms=2 + db_rows=2 + limit=6
                 -> thực tế ~4-6ms total

Cache miss scenario (Redis down, hoặc fresh deploy):
  homefeed:      cpu_ms=1 + db_rows=3 + build_json(12 items) + gzip(1kb)
                 -> thực tế ~4ms (vẫn nhanh vì tham số nhẹ)
  recommendations: cpu_ms=2 + db_rows=2 + algorithm=collaborative
                 -> thực tế ~4-6ms (vẫn nhanh)

CRISIS scenario (DB quá tải, thiếu index):
  homefeed:      cpu_ms=1 -> thực tế có thể 50-200ms do DB chậm
  recommendations: cpu_ms=2 -> thực tế có thể 100-500ms
```

**Vì sao cache hit rate cao trong test với default config?**

```text
Default config của case 06:
  - USER_POOL = 1000 (1000 user identity)
  - productId = ((iter * 13) % 50) + 1 -> chỉ 50 product khác nhau
  - homefeed params luôn cố định: personalized=1, json_items=12, gzip_kb=1
  -> Request pattern LẶP LẠI cao
  -> Backend có thể cache response key theo (endpoint, userId, productId)
  -> Cache hit rate > 95% sau vài giây đầu warm-up
```

**Kịch bản cache hit (Run 94)**:

```text
Run 94: 1081 iterations, p95=4ms
  - Backend cache warm sau 1-2s
  - Mỗi event ~4ms
  - required_vus ≈ 0.1 -> 1 VU là đủ
  - preAllocatedVUs=12: dư 12×
  - dropped_iterations = 0
  -> PASS hoàn hảo
```

**Kịch bản cache miss (mô phỏng bằng env override)**:

```text
Tăng cpu_ms và db_rows để mô phỏng cache miss:
  $env:CAR_06_HOMEFEED_CPU_MS = "50"
  $env:CAR_06_HOMEFEED_DB_ROWS = "100"

Kết quả dự kiến:
  - Mỗi event ~200ms (thay vì 4ms)
  - required_vus ≈ 24 × 0.2 = 4.8 -> cần 5 VU
  - preAllocatedVUs=12 vẫn đủ -> không drop
  - Nhưng p95 tăng từ 4ms -> 200ms
  -> Test vẫn PASS, nhưng latency xấu đi rõ rệt
```

**Kịch bản CRISIS (cache miss + DB quá tải)**:

```text
$env:CAR_06_MAX_VUS = "4"  # giảm VU pool để tạo crisis
Và tăng cpu_ms lên 200ms

Kết quả dự kiến:
  - Mỗi event ~500ms
  - required_vus ≈ 24 × 0.5 = 12 VU
  - maxVUs=4 -> KHÔNG ĐỦ
  - dropped_iterations > 0
  -> Test FAIL: service không đáp ứng được 24 arrivals/s
```

### RC4: AB/geo/device segmentation — request diversity không ảnh hưởng execution model

Case 06 gửi 3 loại headers segmentation trong mỗi request:

```js
const headers = {
  'X-Ab-Variant': ctx.abVariant,       // 'a' hoặc 'b' (xen kẽ)
  'X-Geo-Country': ctx.iter % 3 === 0 ? 'VN' : 'US',  // VN 33%, US 67%
  'X-Device-Class': ctx.iter % 2 === 0 ? 'mobile' : 'desktop', // 50/50
};
```

**Mục đích của segmentation headers**:

```text
1. X-Ab-Variant (a/b):
   - Mô phỏng A/B testing trên production
   - 50% user thấy variant a, 50% thấy variant b
   - Backend có thể cache riêng cho từng variant
   -> Cache key có thể khác nhau -> tăng cache miss nhẹ

2. X-Geo-Country (VN/US):
   - Mô phỏng multi-region deployment
   - 67% traffic từ US, 33% từ VN (mô phỏng user base thực)
   - Backend có thể route đến DB region khác nhau
   -> Ảnh hưởng latency nếu backend thật sự multi-region

3. X-Device-Class (mobile/desktop):
   - Mô phỏng device-specific response
   - Mobile có thể nhận response nhẹ hơn (ít item, ảnh thumbnail)
   - Desktop nhận response đầy đủ
   -> Ảnh hưởng response size, network time
```

**Headers này KHÔNG ảnh hưởng đến k6 execution model**:

```text
Từ góc nhìn k6 executor:
  - Headers chỉ là string trong HTTP request
  - Không ảnh hưởng đến ticker schedule
  - Không ảnh hưởng đến VU allocation
  - Không ảnh hưởng đến dropped_iterations

Từ góc nhìn backend analytics:
  - Headers cho phép drill-down theo variant/geo/device
  - Biết được "mobile user có latency cao hơn desktop không?"
  - Biết được "US traffic có cache hit rate khác VN không?"
  - Value cho business analytics, không phải cho load test execution
```

**Ví dụ drill-down theo X-Geo-Country**:

```text
Nếu backend log request theo header X-Geo-Country:
  US user: p95=3ms (gần cache server hơn)
  VN user: p95=8ms (xa cache server hơn)
  -> Phát hiện: cần deploy cache server gần VN hơn

Nhưng từ góc độ k6 execution:
  Cả US và VN request đều được schedule cùng 1 ticker
  Cả 2 đều dùng chung VU pool
  Không phân biệt khi giao iteration cho VU
```

### RC5: Dropped iterations ở high rate — latency tăng nhẹ cũng có thể cascade

Đây là hệ quả nguy hiểm của high-rate arrival: chỉ cần latency tăng một chút,
VU demand có thể tăng gấp nhiều lần.

**Công thức cascade**:

```text
required_vus = λ × W_effective

Khi W_effective tăng:
  W=4ms   -> required_vus = 24 × 0.004 = 0.096 ≈ 1 VU
  W=10ms  -> required_vus = 24 × 0.010 = 0.240 ≈ 1 VU (vẫn OK)
  W=42ms  -> required_vus = 24 × 0.042 = 1.008 ≈ 2 VU (bắt đầu cần thêm)
  W=100ms -> required_vus = 24 × 0.100 = 2.4 ≈ 3 VU
  W=500ms -> required_vus = 24 × 0.500 = 12 VU (đúng preAllocatedVUs)
  W=1s    -> required_vus = 24 × 1.0 = 24 VU (vượt preAllocatedVUs, cần spawn)
  W=2s    -> required_vus = 24 × 2.0 = 48 VU (vượt maxVUs=30 -> DROP!)
```

**Ví dụ cascade thực tế**:

```text
Tình huống: 5% request bị cache miss (W=80ms thay vì 4ms)

Trung bình event duration:
  W_avg = 0.95 × 4ms + 0.05 × 80ms = 3.8 + 4.0 = 7.8ms

required_vus = 24 × 0.0078 = 0.187 -> vẫn 1 VU

Nhưng với p95:
  W_p95 = 80ms (5% request chậm)
  Tại moment có nhiều request chậm đồng thời:
    -> cần ceil(24 × 0.080) = 2 VU tạm thời
    -> preAllocatedVUs=12 vẫn dư
    -> không drop

Tình huống: 50% request bị cache miss (Redis partition)
  W_avg = 0.50 × 4ms + 0.50 × 80ms = 42ms
  required_vus = 24 × 0.042 = 1.008 ≈ 2 VU
  -> Vẫn rất an toàn với preAllocatedVUs=12

Tình huống: 100% cache miss + DB chậm 200ms
  W_avg = 200ms
  required_vus = 24 × 0.200 = 4.8 ≈ 5 VU
  -> preAllocatedVUs=12 vẫn đủ

CRISIS: 100% cache miss + DB timeout 2s
  W_avg = 2000ms
  required_vus = 24 × 2.0 = 48 VU
  maxVUs = 30 -> thiếu 18 VU
  -> 18/24 = 75% slot bị drop mỗi giây!
```

**Điểm học**: Với high rate (24/s), một thay đổi nhỏ về latency (từ 4ms -> 42ms)
có thể tăng VU demand 10× (từ 0.1 -> 1 VU). Nhưng preAllocatedVUs=12 cho margin
cực lớn, nên happy path test không bao giờ thấy drop. Chỉ khi cố tình giảm VU pool
hoặc tăng latency rất cao mới thấy drop.

## Identity model deep-dive

Case 06 dùng `userContext()` từ `common.js` để sinh identity cho mỗi iteration.
Đây là **open model**, nên identity không bound vào VU cố định.

### Bảng identity mapping

| Field | Cách tính | Giá trị ví dụ | Mục đích |
| --- | --- | --- |
| `userId` | `arrival-user-${(iter % 1000) + 1}` | `arrival-user-1` đến `arrival-user-1000` | Mô phỏng user pool 1000 |
| `abVariant` | `iter % 2 === 0 ? 'b' : 'a'` | `'a'` hoặc `'b'` xen kẽ | A/B test segmentation |
| `requestKey` | `${seed}-${iter}-${vuId}` | `"1719000000-42-3"` | Unique key cho tracing |
| `vuId` | `exec.vu.idInTest` | `1..12` (từ VU pool) | VU nào đang chạy iteration này |
| `iter` | `exec.scenario.iterationInTest` | `0..1080` | Global iteration counter |
| `scenarioIter` | `exec.scenario.iterationInInstance` | `0..N` | Iteration trong scenario instance |

### Cách user pool 1000 hoạt động

```text
iter=0:    userId = arrival-user-1
iter=1:    userId = arrival-user-2
...
iter=999:  userId = arrival-user-1000
iter=1000: userId = arrival-user-1    (quay vòng)
iter=1001: userId = arrival-user-2
...
iter=1080: userId = arrival-user-81   (1080 % 1000 = 80, +1 = 81)

-> 1081 iterations dùng 1000 user identity
-> user 1-80 được dùng 2 lần (iter 0-79 và iter 1000-1079)
-> user 81-1000 được dùng 1 lần
```

### Vì sao user pool quan trọng với cache?

```text
Nếu user pool = 10:
  - Chỉ 10 userId khác nhau
  - Cache key theo userId -> chỉ 10 cache entry
  - Cache hit rate rất cao -> latency rất thấp
  -> Test không thực tế (production có hàng triệu user)

Nếu user pool = 100000:
  - 100,000 userId khác nhau
  - Nhiều cache miss hơn (cache cap có giới hạn)
  - Latency cao hơn -> VU demand cao hơn
  -> Test nặng hơn, gần production hơn

Case 06 chọn USER_POOL = 1000:
  - Đủ lớn để không trivial (1000 user khác nhau)
  - Đủ nhỏ để vẫn thấy cache hit pattern
  - Phù hợp với test environment (không phải production-scale)
```

### Geo và device segmentation pattern

```text
iter 0: VN,  mobile  (0%3=0 -> VN, 0%2=0 -> mobile)
iter 1: US,  desktop (1%3=1 -> US, 1%2=1 -> desktop)
iter 2: US,  mobile  (2%3=2 -> US, 2%2=0 -> mobile)
iter 3: VN,  desktop (3%3=0 -> VN, 3%2=1 -> desktop)
iter 4: US,  mobile  (4%3=1 -> US, 4%2=0 -> mobile)
iter 5: US,  desktop (5%3=2 -> US, 5%2=1 -> desktop)
iter 6: VN,  mobile  (6%3=0 -> VN, 6%2=0 -> mobile)
...

Pattern lặp mỗi 6 iteration:
  VN+mobile, US+desktop, US+mobile, VN+desktop, US+mobile, US+desktop
```

### AB variant pattern

```text
ctx.abVariant = iter % 2 === 0 ? 'b' : 'a'

iter 0: variant 'b'
iter 1: variant 'a'
iter 2: variant 'b'
iter 3: variant 'a'
...
-> 50/50 a/b, xen kẽ đều
-> Đảm bảo cả 2 variant được test như nhau
```

## Phân tích open model — constant-arrival-rate

### Open model là gì?

```text
Open model (constant-arrival-rate):
  - Schedule iteration theo arrival rate cố định (24/s)
  - VU pool là "worker pool" ẩn danh
  - Không có quan hệ iteration<->VU cố định
  - VU A có thể chạy iteration cho user 1, xong chạy cho user 100

Closed model (per-vu-iterations):
  - VU pool cố định (30 VU)
  - Mỗi VU có số iteration cố định (5)
  - Identity bound vào VU
  - VU A chỉ chạy cho user A
```

### Open model áp dụng cho feed ingress

Với case 06, open model là lựa chọn tự nhiên vì:

```text
1. Traffic từ app/web:
   - Request đến độc lập với nhau
   - Không có "session" giữa các request
   - Mỗi request là 1 API call độc lập
   -> Open model mô phỏng đúng

2. Cache không yêu cầu session:
   - Cache key dựa trên (endpoint, userId, params)
   - Không cần VU cố định để giữ cache state
   -> Open model không phá vỡ cache behavior

3. Rate cố định quan trọng hơn identity:
   - Business cần biết "24/s có đáp ứng được không?"
   - Ai xử lý request không quan trọng
   -> Open model tập trung vào rate
```

### Ví dụ open model execution trace

```text
VU pool: preAllocatedVUs=12
Ticker: 24 slots/s, mỗi slot cách 41.7ms

Timeline:
t=0.000s: slot 1  -> VU#1 (rảnh) -> chạy iter 0, user arrival-user-1, homefeed
t=0.042s: slot 2  -> VU#2 (rảnh) -> chạy iter 1, user arrival-user-2, recommendations
t=0.083s: slot 3  -> VU#3 (rảnh) -> chạy iter 2, user arrival-user-3, homefeed
t=0.125s: slot 4  -> VU#1 (rảnh, xong iter 0 từ 0.004s) -> chạy iter 3, user arrival-user-4, homefeed
t=0.167s: slot 5  -> VU#2 (rảnh, xong iter 1 từ 0.046s) -> chạy iter 4, user arrival-user-5, recommendations
...

VU#1 chạy: iter 0, iter 3, iter 7, iter 11, ... (nhiều user khác nhau)
VU#2 chạy: iter 1, iter 4, iter 8, iter 12, ... (nhiều user khác nhau)

-> Mỗi VU xử lý nhiều user khác nhau
-> Không có state nào được giữ giữa các iteration
-> Đúng với bản chất stateless feed API
```

### Vì sao open model hiệu quả hơn closed model cho feed ingress?

```text
Closed model (per-vu-iterations):
  - 12 VU, mỗi VU 90 iter = 1080 iter
  - Nhưng VU có thể idle nếu server response chậm
  - VU nhanh không giúp được VU chậm
  - Iteration rate không cố định

Open model (constant-arrival-rate):
  - Ticker quyết định iteration rate = 24/s
  - VU nhanh có thể nhận nhiều iteration hơn
  - VU pool tự cân bằng
  - Iteration rate cố định 24/s

Kết quả: open model giữ rate cố định 24/s
         closed model không giữ được rate cố định
```

### So sánh cache behavior giữa open model và thực tế

| Khía cạnh | Open model (k6) | Production thực tế |
| --- | --- | --- |
| Request đến | 24/s cố định | ~24/s (dao động) |
| User identity | 1000 user, quay vòng | Hàng triệu user |
| Cache state | Stateless giữa các request (Redis) | Redis cluster |
| Cache hit rate | Phụ thuộc user pool size | Phụ thuộc traffic pattern |
| Request routing | Đến cùng 1 instance (localhost) | Load balancer -> nhiều instance |
| Connection | HTTP/1.1 keep-alive | HTTP/2 multiplexed |

Mặc dù có khác biệt, open model vẫn là lựa chọn tốt nhất để test "24/s có đáp ứng được không".

## Bảng service/API flow

### Weighted branch selection

```js
const choice = weightedPick([
  { name: 'homefeed', weight: 65 },
  { name: 'recommendations', weight: 35 },
], ctx.iter);
```

`weightedPick` hoạt động như sau:

```text
Tổng weight = 65 + 35 = 100

Với mỗi iter n:
  pick_key = n % 100
  if pick_key < 65:   -> 'homefeed'
  if pick_key >= 65:  -> 'recommendations'

Ví dụ:
  iter 0: 0 % 100 = 0 < 65 -> homefeed
  iter 1: 1 % 100 = 1 < 65 -> homefeed
  ...
  iter 64: 64 < 65 -> homefeed
  iter 65: 65 >= 65 -> recommendations
  iter 66: 66 >= 65 -> recommendations
  ...
  iter 99: 99 >= 65 -> recommendations
  iter 100: 100 % 100 = 0 -> homefeed (lặp)
```

### API call cho từng branch

| Branch | Weight | Endpoint | Method | Params | Expected |
| --- | ---: | --- | --- | --- | --- |
| homefeed | 65% | `/api/sim/products/homefeed` | GET | `personalized=1&cpu_ms=1&db_rows=3&json_items=12&gzip_kb=1` | 200 OK |
| recommendations | 35% | `/api/sim/products/:id/recommendations` | GET | `algorithm=collaborative&cpu_ms=2&db_rows=2&limit=6` | 200 OK |

### Product ID rotation

```js
const productId = ((ctx.iter * 13) % 50) + 1;
```

```text
iter 0:  (0*13) % 50 + 1 = 1
iter 1:  (1*13) % 50 + 1 = 14
iter 2:  (2*13) % 50 + 1 = 27
iter 3:  (3*13) % 50 + 1 = 40
iter 4:  (4*13) % 50 + 1 = 3
...
iter 49: (49*13) % 50 + 1 = ... -> lặp qua đủ 50 product

-> Nhân với 13 (prime) để phân phối đều qua 50 product
-> 13 là số nguyên tố, đảm bảo trải đều (không bị cluster)
-> Recommendations API cần productId để gợi ý sản phẩm liên quan
```

### Request flow chi tiết

```text
Mỗi iteration gồm:
  1. Tạo userContext (identity + headers)
  2. Tính productId từ iter * 13 % 50
  3. Build headers (AB variant, geo, device)
  4. Chọn branch (65% homefeed, 35% recommendations)
  5. Gọi API:
     - Nếu homefeed: GET /api/sim/products/homefeed?... + headers
     - Nếu recommendations: GET /api/sim/products/:id/recommendations?... + headers
  6. Check HTTP status (200)
  7. Ghi custom metrics (constant_arrival_events_total, event_duration_ms)

Không có:
  - Login (stateless API)
  - Session management
  - Cart operations
  - Checkout flow
  - Sleep/think time (fire-and-forget feed request)
```

### Expected totals

```text
scheduled slots:         24/s × 45s = 1080
iterations:              ≈ 1080 (có thể 1081 do off-by-one trong schedule)
constant_arrival_events_total: ≈ iterations (1 event/iter)
constant_arrival_api_calls_total: ≈ iterations (1 API call/iter)
http_reqs:               ≈ 1080
  homefeed requests:     ≈ 1080 × 0.65 = 702
  recommendations reqs:  ≈ 1080 × 0.35 = 378
dropped_iterations:      0 (với preAllocatedVUs=12 đủ)
```

## Metrics & tags deep-dive

### Custom metrics từ common.js

| Metric | Type | Tags | Ý nghĩa |
| --- | --- | --- | --- |
| `constant_arrival_events_total` | Counter | case_id, service, operation, user_id | Tổng số arrival event đã xử lý |
| `constant_arrival_events_failed` | Counter | case_id, service, operation, user_id | Số arrival event failed (check không pass) |
| `constant_arrival_api_calls_total` | Counter | case_id, service, operation, endpoint, user_id | Tổng số API call đã thực hiện |
| `constant_arrival_event_duration_ms` | Trend | case_id, service, operation, user_id | Thời gian xử lý 1 arrival event (ms) |

### Tags cho case 06

Mỗi event được tag với:

```js
// Homefeed branch
{
  caseId: 'car-06-cacheable-feed-ingress',
  service: 'products-service',
  operation: 'feed_arrival_homefeed',        // hoặc 'feed_homefeed_arrival' trong finishEvent
  endpoint: 'GET /api/sim/products/homefeed',
  userId: 'arrival-user-42'
}

// Recommendations branch
{
  caseId: 'car-06-cacheable-feed-ingress',
  service: 'products-service',
  operation: 'feed_arrival_recommendations', // hoặc 'feed_recommendations_arrival' trong finishEvent
  endpoint: 'GET /api/sim/products/:id/recommendations',
  userId: 'arrival-user-42'
}
```

### Drill-down quan trọng theo operation

```text
Tách homefeed vs recommendations:
  - Homefeed 65%: expected p95 thấp hơn (chỉ 1 DB table, ít compute)
  - Recommendations 35%: expected p95 cao hơn (collaborative algorithm)

Nếu chỉ nhìn overall p95=4ms -> kết luận "mọi thứ OK"
Nhưng drill-down có thể thấy:
  homefeed p95:        3ms (rất nhanh)
  recommendations p95: 8ms (chậm hơn 2.7×!)

Kết luận: recommendations là bottleneck tiềm năng.
          Nếu traffic tăng, recommendations sẽ fail trước homefeed.
```

### Cách đọc custom metrics trong output

```text
constant_arrival_events_total:
  - Phải gần iterations (mỗi iteration = 1 event)
  - Nếu events_total < iterations: có event không được finishEvent gọi (bug code)

constant_arrival_events_failed:
  - Phải = 0 nếu mọi check pass
  - Nếu > 0: có HTTP request không pass check status

constant_arrival_api_calls_total:
  - Phải gần http_reqs (mỗi event = 1 API call trong case này)
  - Nếu > http_reqs: có retry hoặc gọi API ngoài requestJson

constant_arrival_event_duration_ms:
  - p95 cho biết tail latency của feed service
  - Có thể drill theo operation để so sánh homefeed vs recommendations
```

### Built-in metrics

| Metric | Expected value | Ý nghĩa |
| --- | ---: | --- |
| `iterations` | 1080-1081 | Tổng iteration đã chạy |
| `http_reqs` | 1080-1081 | Tổng HTTP request |
| `http_req_duration` p95 | ~4ms | Tail latency tổng |
| `http_req_failed` | 0.00% | Tỉ lệ request fail |
| `checks` rate | >0.99 | Tỉ lệ check pass |
| `dropped_iterations` | 0 | Số iteration bị drop |
| `vus` | 1-12 | Active VU trong test |
| `vus_max` | 12-30 | Peak VU đã dùng |

### Tương quan giữa các metrics

```text
iterations ≈ constant_arrival_events_total ≈ constant_arrival_api_calls_total ≈ http_reqs

Đây là "chuỗi 1-1-1-1":
  1 iteration = 1 arrival event = 1 API call = 1 HTTP request

Nếu chuỗi này bị phá vỡ (vd: http_reqs > iterations):
  -> Có retry logic hoặc gọi API nhiều lần trong 1 event (không phải case này)
```

## Pass criteria — expanded rationale

| # | Check | Pass khi | Rationale |
| --- | --- | --- | --- |
| 1 | `dropped_iterations` | `count <= 0` | Không chấp nhận drop. Rate 24/s là contract cứng. |
| 2 | `checks` | `rate > 0.99` | Gần như mọi request phải trả về 200 OK |
| 3 | `http_req_failed` | `rate < 0.01` | Tối đa 1% request fail |
| 4 | `constant_arrival_events_failed` | `count < 10` | Tối đa 10 event failed (trong ~1080) |
| 5 | `iterations` | ≈ 1080 | Gần scheduled slots (có thể 1081 do off-by-one) |
| 6 | `constant_arrival_event_duration_ms` p95 | < 50ms | Cache-friendly endpoint nên latency thấp. >50ms là dấu hiệu cache miss hoặc backend issue |
| 7 | homefeed vs recommendations p95 diff | < 2× | Recommendations có thể chậm hơn, nhưng không quá 2 lần homefeed |

**Vì sao `dropped_iterations <= 0` là pass criteria cứng?**

```text
Case này test FEED INGRESS — traffic từ app/web đến service.
Trong production, nếu feed request bị drop (timeout):
  -> User thấy loading spinner
  -> User thoát app
  -> Mất engagement, mất revenue

Cho nên DROP = FAIL, không có ngoại lệ.
Khác với case khác có thể chấp nhận drop nhỏ (vd: 1-2%).
```

**Vì sao `constant_arrival_events_failed < 10` chứ không phải `= 0`?**

```text
Trong ~1080 event, 1-2 event có thể fail do:
  - Network blip (TCP reset, connection timeout)
  - Backend GC pause đúng lúc request đến
  - Race condition nhỏ trong test infrastructure

< 10 / 1080 = < 0.93% -> chấp nhận được.
Production cũng có error rate nhỏ (0.1-1%) do network issues.
```

## Cách chạy

### Local run với dashboard

```powershell
# 1. Đảm bảo stack đã start (k6-metrics-server + dashboard)
# 2. Set env vars
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

# 3. Chạy với cloud output
cd "E:\Khoa hoc\k6"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-06-cacheable-feed-ingress.js"
```

### Verify trên dashboard

```text
1. Mở http://localhost:13001
2. Paste student-token-1234567890
3. Click vào run mới nhất
4. Tile "iterations" hiển thị ~1080 ✓
5. Tile "dropped_iterations" hiển thị 0 ✓
6. Tile "http_req_duration" hiển thị p95 < 10ms ✓
7. Tab Executor: executor = constant-arrival-rate, rate=24 ✓
```

### Override env vars

```powershell
# Thay đổi rate (smoke test với rate thấp hơn)
$env:CAR_06_RATE = "10"
$env:CAR_06_DURATION = "30s"

# Thay đổi VU pool
$env:CAR_06_PREALLOCATED_VUS = "4"
$env:CAR_06_MAX_VUS = "8"

# Thay đổi user pool
$env:CAR_06_USER_POOL = "100"
```

### Chạy local không cần dashboard

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-06-cacheable-feed-ingress.js"
```

## Phân tích output 5 bước

### Bước 1: Verify config [Header]

```text
Header in:    executor = constant-arrival-rate
Config có:    rate=24, timeUnit=1s, duration=45s ✓

Header in:    preAllocatedVUs=12, maxVUs=30
Config có:    preAllocatedVUs=12, maxVUs=30 ✓

Header in:    gracefulStop=30s
Config có:    gracefulStop=30s (default) ✓
```

### Bước 2: Tính total dự kiến

```text
scheduled_slots = rate × (duration / timeUnit)
                = 24 × (45s / 1s)
                = 24 × 45
                = 1080 arrivals

Case này: 1 arrival = 1 iteration = 1 API call = 1 HTTP request
Nên expected:
  iterations ≈ 1080
  http_reqs ≈ 1080
  constant_arrival_events_total ≈ 1080
```

### Bước 3: So với N_done

Run 94:

```text
Summary cho:
  iterations.........: 1081
  http_reqs..........: 1081
  dropped_iterations.: 0

Tỷ lệ:
  iterations / scheduled = 1081 / 1080 = 100.09%
  -> Có thể có 1 iteration extra do off-by-one trong schedule cuối

Tỷ lệ vẫn đúng: gần 1080, không drop
KẾT LUẬN: test hoàn thành đủ slot
```

### Bước 4: Verify N_drop, N_int

```text
Footer:       "0 dropped iterations"
Config:       maxDroppedIterations = 0

dropped_iterations = 0 ✓
interrupted = 0 (hoặc rất ít)

KẾT LUẬN: không drop, không interrupt -> service đáp ứng được 24/s
```

### Bước 5: Đo latency và phân tích VU

```text
Run 94:
  constant_arrival_event_duration_ms p95: 4ms
  http_req_duration p95: 4ms
  vus_max: 12 (hoặc ít hơn, tùy run)

Little's Law check:
  required_vus ≈ 24 × 0.004 = 0.096 VU
  vus_max thực tế: ~1-2 VU (chỉ cần 1-2 VU active để xử lý 24/s)
  preAllocatedVUs=12: dư thừa lớn

Đánh giá:
  - Latency rất thấp (4ms) -> cache hit tốt
  - VU usage rất thấp -> nhiều headroom
  - Có thể tăng rate lên cao hơn (50/s, 100/s) mà vẫn pass
```

## Đọc dashboard real-time charts cho case 06

Sau khi chạy, mở dashboard:

```text
http://localhost:13001/
```

paste token, chọn run mới nhất. Phần này giải thích cách đọc các biểu đồ
real-time và tab Executor cho case 06. Ví dụ dưới đây lấy từ một run thật với
default config.

```text
RATE = 24/s
DURATION = 45s
PREALLOCATED_VUS = 12
MAX_VUS = 30
Expected iterations ≈ 1080
```

Trước khi đọc chi tiết, nhớ bảng này:

| Biểu đồ / tab | Nó trả lời câu hỏi gì? | Không nên dùng để làm gì? |
| --- | --- | --- |
| Response time | Homefeed vs recommendations latency khác nhau thế nào? Có spike không? | Không thay thế final summary p95 |
| Execution timeline | 24/s có được duy trì đều không? Có bucket nào bị hụt không? | Không đọc mỗi point như 1 iteration |
| VUs vs iter/s | VU thấp nhưng iter/s cao — Little's Law visualization | Không kỳ vọng VU luôn ở mức cao |
| Executor tab | Arrival rate có đúng 24/s không? Schedule có bị miss không? | Không dùng để verify latency |

Một cách đọc nhanh:

```text
Response time      -> homefeed nhanh, recommendations chậm hơn một chút
Execution timeline -> 24 req/s đều, không bucket nào hụt
VUs vs iter/s      -> VU thấp (~1-2) nhưng iter/s = 24/s -> Little's Law
Executor tab       -> constant-arrival-rate, rate=24/s, 0 drop
```

### Chart 1 — Response time

Chart này có JSON debug dạng:

```text
Debug JSON: response-time
```

Ý nghĩa:

```text
mỗi point = thống kê response time trong 1 time bucket / metrics frame
```

Các series chính:

```text
Avg response
Batch p95
Batch max
```

Ví dụ point từ run 94:

```text
01:15:30  avg=3.2ms   p95=4.1ms   max=8.3ms
01:15:31  avg=3.5ms   p95=4.5ms   max=9.1ms
01:15:32  avg=3.8ms   p95=5.2ms   max=12.4ms
...
01:16:14  avg=3.1ms   p95=4.0ms   max=7.8ms
01:16:15  avg=3.3ms   p95=4.2ms   max=8.5ms
```

Đọc thực tế:

```text
- Response time cực thấp (avg 3-4ms) và ổn định suốt 45s
- p95 dao động 4-5ms -> không có tail latency đáng kể
- max thỉnh thoảng 12ms -> vài outlier nhỏ, không đáng lo
- Không có spike ở đầu hoặc cuối -> cache warm nhanh, không degradation
```

#### Cách phân tích sâu chart Response time cho case 06

Khi nhìn chart này, đừng chỉ nhìn "cao/thấp". Hãy đọc theo 4 câu hỏi:

```text
1. Avg response có ổn định quanh 3-4ms không?
2. Batch p95 có spike ở đoạn nào không?
3. Batch max có outlier lớn (>50ms) không?
4. Nếu drill được theo operation, homefeed có nhanh hơn recommendations không?
```

Với case 06, chart đẹp thường có shape:

```text
đầu run:  p95 có thể 5-8ms (cold start, cache warm)
giữa run: p95 ổn định 3-5ms (cache warm, pattern ổn định)
cuối run: p95 không tăng (không leak, không degradation)
```

Vì sao đầu run có thể cao hơn?

```text
- Cache chưa warm (Redis/Memcached trống)
- Backend chưa JIT compile (nếu dùng Java/C#)
- K6 VU init phase chưa hoàn tất hoàn toàn
- Nhưng khác biệt nhỏ (vài ms) vì backend simulate đơn giản
```

Vì sao cuối run không nên spike mạnh?

```text
- Rate vẫn 24/s đều đến cuối
- Cache đã đầy đủ
- Không có stateful operation (stateless read)
- Nếu cuối run p95 tăng: có thể backend resource leak hoặc GC pressure
```

Ví dụ đọc chart response-time của run 94:

```text
01:15:30 p95=4.1ms  <- đầu run, OK
01:15:31 p95=4.5ms
...
01:16:14 p95=4.0ms  <- cuối run, vẫn OK
01:16:15 p95=4.2ms
```

Kết luận thực tế:

```text
- Response time ổn định suốt 45s
- p95 luôn < 10ms -> cache hit rate cao
- Không có spike bất thường
- Summary p95=4ms < threshold 50ms
=> Feed service latency OK, cache hoạt động tốt
```

Nếu chart xấu thì đọc như nào?

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 tăng dần theo thời gian | Cache đang bị evict/churn, hit rate giảm | Tăng cache size, kiểm TTL |
| p95 có spike định kỳ (mỗi 5-10s) | GC pause hoặc background job | Kiểm backend GC log |
| p95 đột ngột tăng ở giữa run | Cache server crash/failover | Kiểm Redis/K8s event |
| p95 cao nhưng ổn định | Cache miss toàn bộ, DB query path OK | Kiểm cache config, prewarm |
| avg thấp nhưng p95 cao | Đa số request cache hit, vài request cache miss | Tăng cache hit rate, kiểm eviction policy |

Ghi nhớ:

```text
avg cho biết mặt bằng chung (cache hit baseline)
p95 cho biết tail latency (bao gồm cả cache miss)
max cho biết outlier tệ nhất (1 request cực chậm)
```

Với feed ingress, p95 quan trọng hơn avg vì:

```text
User không quan tâm "trung bình feed load nhanh".
User quan tâm: "lúc tôi mở app, feed có load nhanh không?"
Nếu 5% user gặp feed load chậm -> 5% user thoát app.
```

### Chart 2 — Execution timeline

Chart này có JSON debug dạng:

```text
Debug JSON: execution-timeline
```

Ý nghĩa:

```text
mỗi point = trạng thái execution trong 1 time bucket
```

Các series chính:

```text
Live VUs
RPS (httpReqs/s)
```

Run case 06 có các point điển hình:

| Time bucket | Live VUs | HTTP reqs trong bucket | Iterations hoàn thành trong bucket |
| --- | ---: | ---: | ---: |
| 01:15:30 | 2 | 24 | 24 |
| 01:15:31 | 2 | 24 | 24 |
| 01:15:32 | 2 | 24 | 24 |
| ... | ... | ... | ... |
| 01:16:14 | 2 | 24 | 24 |
| 01:16:15 | 1 | 24 | 24 |

**Đặc điểm quan trọng của case 06 trên Execution timeline**:

```text
1. HTTP reqs mỗi bucket gần như đúng 24:
   - Đây là bằng chứng rate=24/s được duy trì đều
   - Mỗi bucket 1 giây có ~24 HTTP request hoàn thành
   - KHÔNG có bucket nào hụt (vd: 15, 18, 20...)
   -> Ticker schedule hoạt động đúng

2. Iterations mỗi bucket cũng ~24:
   - Vì mỗi iteration = 1 HTTP request (case này)
   - Iterations và httpReqs gần như bằng nhau từng bucket

3. Live VUs rất thấp (1-2 VU):
   - Dù rate=24/s, nhưng chỉ cần 1-2 VU active
   - Đây là minh chứng trực quan cho Little's Law
   - 1 VU xử lý 24 request/s vì mỗi request chỉ 4ms

4. Không có dropped_iterations:
   - Tất cả bucket đều đạt target
   - preAllocatedVUs=12 dư thừa lớn
```

#### Cách phân tích sâu chart Execution timeline cho case 06

Chart này trả lời câu hỏi khác hẳn Response time:

```text
Response time chart:
  "request nhanh/chậm thế nào?"

Execution timeline:
  "24/s có được duy trì đều không? Từng giây có bao nhiêu request?"
```

Với `constant-arrival-rate`, shape "đẹp" là:

```text
Toàn bộ run:
  Live VUs thấp và ổn định (1-3 VU)
  RPS ≈ 24/s mỗi bucket
  iterations ≈ 24/s mỗi bucket

Đây là "dense but light" pattern:
  - Dense: 24 request mỗi giây (bucket dày)
  - Light: mỗi request chỉ 4ms (VU nhàn)
```

**So sánh Execution timeline với case 04 (checkout)**:

```text
Case 04 (checkout, rate=5/s):
  Live VUs: ~8-15 (cao hơn vì checkout chậm)
  RPS: ~5/s (bucket thưa hơn)

Case 06 (feed, rate=24/s):
  Live VUs: ~1-2 (thấp hơn vì feed nhanh)
  RPS: ~24/s (bucket dày hơn)

-> Case 06 có RPS cao gấp ~5× nhưng VU thấp hơn ~5×
-> Little's Law visualization: rate cao + duration thấp = ít VU
```

Các shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| RPS < 24 ở nhiều bucket | Schedule bị miss, có thể do VU không kịp | Kiểm dropped_iterations, tăng maxVUs |
| RPS dao động mạnh (10-30) | VU pool không ổn định, spawn/churn | Kiểm preAllocatedVUs |
| Live VUs tăng cao bất thường | Cache miss hoặc backend chậm -> VU bận lâu hơn | Kiểm response time chart |
| RPS tụt về 0 trước 45s | Test kết thúc sớm, có thể do error/interrupt | Kiểm log, summary |
| iterations != httpReqs ở nhiều bucket | Có retry hoặc 1 event gọi nhiều API | Kiểm code, không phải case này |

### Batch 1 giây / time bucket với constant-arrival-rate

Với case 06, bucket 1 giây có ý nghĩa đặc biệt vì:

```text
timeUnit = 1s
rate = 24

Mỗi bucket 1 giây chứa chính xác 24 scheduled slots.
Nên bucket là đơn vị tự nhiên để kiểm tra "24/s có đạt không?"
```

Ví dụ bucket:

```text
01:15:31  vus=2  httpReqs=24  iterations=24
```

đọc là:

```text
trong giây 01:15:31:
  - dashboard quan sát 2 VU đang active
  - có 24 HTTP requests hoàn thành -> đúng rate 24/s
  - có 24 iterations hoàn thành -> đúng rate 24/s
  -> PASS: bucket này đạt target
```

Tổng kiểm:

```text
sum(httpReqs theo bucket) ≈ 1080 = summary http_reqs ✓
sum(iterations theo bucket) ≈ 1080 = summary iterations ✓
```

### Chart 3 — VUs vs iter/s

Chart này có JSON debug dạng:

```text
Debug JSON: vus-vs-iterations
```

Chart này trả lời câu hỏi:

```text
VU requirement có thấp như Little's Law dự đoán không?
Iter/s có bám sát rate=24/s không?
```

Đây là chart **quan trọng nhất** cho case 06, vì nó trực quan hóa bài học chính:
**high rate + low duration = low VU requirement**.

Các series chính:

```text
Executor VUs
Actual iter/s
```

Đọc nhanh:

| Series | Nghĩa | Với case 06 kỳ vọng |
| --- | --- | --- |
| `Executor VUs` | envelope VU (preAllocatedVUs=12, maxVUs=30) | đường cao ở 12 (preAllocated), nhưng Observed thấp hơn nhiều |
| `Actual iter/s` | số iteration hoàn thành trong mỗi bucket | gần 24/s mỗi bucket, ổn định |

**Điểm đặc biệt của case 06 trên chart này**:

```text
Executor VUs (envelope): 12-30
Observed VUs (thực tế): 1-3

Khoảng cách giữa Executor VUs và Observed VUs RẤT LỚN.
Đây không phải là bug. Đây là:

1. Executor VUs = preAllocatedVUs (12) = số VU đã sẵn sàng
2. Observed VUs = số VU thực sự phải làm việc (1-3)
3. 9-11 VU còn lại "ngồi chơi" vì không có việc để làm

Tại sao?
  - 1 VU xử lý 1 event trong 4ms
  - Tick mỗi 41.7ms mới có event mới
  - 1 VU chỉ bận 4/41.7 = 9.6% thời gian
  - 2 VU thay phiên nhau -> utilization ~5% mỗi VU
  - 12 VU preAllocated -> 10-11 VU idle hoàn toàn

Đây là điều BÌNH THƯỜNG với cache-friendly read endpoint.
Không có nghĩa là "lãng phí VU". PreAllocatedVUs=12 là buffer cho:
  - Cache miss scenario
  - Traffic spike
  - Cold start
```

#### Ý nghĩa thực tế của chart này trong case 06

Trong case 06, business question là:

```text
Feed service có đáp ứng được 24 arrivals/s không?
Cần bao nhiêu worker (VU) để đáp ứng?
```

Chart này trả lời trực tiếp:

```text
Actual iter/s = ~24/s (đều, ổn định)
  -> Đáp ứng được 24 arrivals/s ✓

Observed VUs = 1-3 (rất thấp)
  -> Chỉ cần 1-3 worker để đáp ứng 24/s
  -> Service còn rất nhiều headroom
  -> Có thể tăng rate lên 50/s, 100/s mà vẫn OK
```

Kết luận nghiệp vụ:

```text
Với cache hit scenario:
  - 1-2 VU đủ xử lý 24/s
  - preAllocatedVUs=12 dư 10-11 VU
  - Có thể tăng rate hoặc giảm VU pool

Với cache miss scenario (dự kiến):
  - 5-12 VU cần để xử lý 24/s
  - preAllocatedVUs=12 vừa đủ hoặc dư ít
  - maxVUs=30 cho buffer crisis

Đây chính là lý do preAllocatedVUs=12:
  Không phải cho happy path (chỉ cần 1-2 VU)
  Mà cho worst case (cache miss toàn bộ)
```

#### Cách phân tích sâu chart VUs vs iter/s

Chart này dễ nhầm nhất vì khoảng cách Executor vs Observed VUs quá lớn:

```text
Executor VUs = 12
Observed VUs = 1-3

Người mới có thể nghĩ: "Sao Executor bảo cần 12 VU mà thực tế chỉ dùng 2?"
```

Trả lời:

```text
Executor VUs (hay envelopeVUs) KHÔNG phải là "số VU executor dự kiến sẽ dùng".
Nó là "số VU executor ĐÃ CẤP PHÁT" (preAllocatedVUs).

Với constant-arrival-rate:
  - preAllocatedVUs: VU được tạo sẵn, sẵn sàng nhận việc
  - maxVUs: trần VU có thể spawn thêm
  - Observed VUs: số VU THỰC SỰ đang làm việc tại thời điểm sample

Nếu Observed VUs << Executor VUs:
  -> VU pool dư thừa, service xử lý nhanh hơn rate yêu cầu
  -> Đây là tín hiệu TỐT (có headroom)

Nếu Observed VUs ≈ Executor VUs:
  -> VU pool đang được dùng gần hết
  -> Có thể sắp chạm giới hạn

Nếu Observed VUs = maxVUs và vẫn có drop:
  -> VU pool không đủ, cần tăng maxVUs hoặc giảm rate
```

Shape mong đợi của case 06:

```text
- Executor VUs: đường phẳng ở 12 (preAllocatedVUs)
- Observed VUs: dao động thấp 1-3 (vì event nhanh)
- Actual iter/s: ~24/s mỗi bucket, ổn định
- Không có drop
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| Observed VUs ~1-2, iter/s=24 | Cache hit tốt, event nhanh | Bình thường, OK |
| Observed VUs ~5-10, iter/s=24 | Cache miss một phần, event chậm hơn | Cần điều tra cache |
| Observed VUs = 12, iter/s=24 | Cache miss toàn bộ, event chậm | Sắp hết VU, nguy cơ drop |
| Observed VUs = 12, iter/s < 24 | VU pool không đủ, đang drop | CRISIS, tăng maxVUs |
| Observed VUs tăng dần theo thời gian | Cache churn/eviction tăng dần | Kiểm cache TTL, cap |

### Executor tab

Chuyển sang tab:

```text
Executor
```

Dashboard detect đúng:

```text
EXECUTOR = constant-arrival-rate
```

Tab này có 1 chart chính:

```text
Debug JSON: executor-behavior
```

Series:

```text
Fixed/Executor VUs (envelope)
Observed VUs
Actual iter/s
Peak if all active
Schedule rate (24/s)
```

Input từ run 94:

```json
{
  "executor": "constant-arrival-rate",
  "rate": 24,
  "timeUnit": "1s",
  "duration": "45s",
  "preAllocatedVUs": 12,
  "maxVUs": 30,
  "droppedIterations": 0,
  "iterations": 1081
}
```

Đọc từng dòng:

```text
Executor
  Hiển thị: constant-arrival-rate
  Config: rate=24, timeUnit=1s, duration=45s

Schedule info:
  Target rate: 24 iterations/s
  Schedule period: 1/24 = 41.7ms

VU pool:
  preAllocatedVUs: 12 (VU sẵn sàng)
  maxVUs: 30 (trần spawn thêm)
  Observed VUs: 1-3 (thực tế dùng)

Drop info:
  dropped_iterations: 0
  -> Schedule không miss slot nào
```

#### Cách phân tích sâu tab Executor cho constant-arrival-rate

Tab Executor với constant-arrival-rate khác hẳn với per-vu-iterations:

| Khía cạnh | per-vu-iterations (case 01) | constant-arrival-rate (case 06) |
| --- | --- | --- |
| VU model | Fixed VUs, mỗi VU có quota | VU pool ẩn danh, nhận việc theo schedule |
| Observed VUs cuối run | Giảm về 0 khi hết quota | Vẫn có thể >0 đến hết duration |
| iter/s shape | Batch hoàn thành không đều | Đều ~24/s (theo ticker) |
| Drop | Không có khái niệm drop (chỉ interrupt) | Có dropped_iterations |
| Peak | predicted_peak = vus/iter_time | Peak = rate (24/s) |

Checklist tab Executor cho case 06:

```text
1. Executor type hiển thị: constant-arrival-rate ✓
2. Rate hiển thị: 24/s ✓
3. preAllocatedVUs: 12 ✓
4. maxVUs: 30 ✓
5. dropped_iterations: 0 ✓
6. Observed VUs không vượt maxVUs ✓
7. iter/s ổn định ~24/s ✓
```

Nếu tab Executor cho shape khác thì nghi gì?

| Shape bất thường | Có thể nghĩa là gì |
| --- | --- |
| Executor detect sai (hiển thị constant-vus) | metadata filename không khớp, UI override |
| dropped_iterations > 0 | VU pool không đủ, tăng maxVUs hoặc giảm rate |
| iter/s < 24 ở nhiều bucket | Schedule đang miss, VU không kịp |
| Observed VUs = maxVUs = 30 | Đã dùng hết VU pool, nguy cơ drop |
| Observed VUs = 0 nhưng vẫn có request | Bug dashboard, hoặc request đến từ scenario khác |

### Tổng kết đọc dashboard case 06

```text
1. Response time chart:
   - p95 ~4ms, ổn định suốt 45s
   - Không spike, không degradation
   -> Cache hit rate cao, service latency thấp

2. Execution timeline:
   - RPS ~24/s mỗi bucket, đều đặn
   - Live VUs ~1-2 (rất thấp)
   -> Rate 24/s được duy trì hoàn hảo, VU requirement thấp

3. VUs vs iter/s:
   - Executor VUs = 12, Observed VUs = 1-3
   - Actual iter/s ~24/s
   -> Little's Law visualization: rate cao + duration thấp = VU thấp

4. Executor tab:
   - constant-arrival-rate, rate=24/s, 0 drop
   -> Executor chạy đúng, schedule không miss
```

## 4 output -> decision scenarios

### Kịch bản A — perfect pass (Run 94): SERVICE READY

```text
iterations.........: 1081       (đủ, không thiếu)
dropped_iterations.: 0
http_req_failed....: 0.00%
checks..............: 100%
constant_arrival_event_duration_ms p95: 4ms
http_req_duration p95: 4ms
vus_max............: 3
```

Kết luận thực tế:

```text
- 1081 iteration, 0 drop -> service đáp ứng 24/s hoàn hảo
- p95=4ms -> cache hit rate cao, response nhanh
- vus_max=3 -> VU requirement thấp (Little's Law xác nhận)
- Còn 9/12 preAllocatedVUs idle -> nhiều headroom
=> QUYẾT ĐỊNH: Service sẵn sàng cho production. Có thể tăng rate lên
   50/s hoặc 100/s mà không cần thay đổi infrastructure.
```

### Kịch bản B — pass nhưng p95 tăng: CACHE MISS ĐANG TĂNG

```text
iterations.........: 1080       (vẫn đủ!)
dropped_iterations.: 0         (vẫn pass)
http_req_failed....: 0.00%
constant_arrival_event_duration_ms p95: 45ms    (TĂNG 11× so với baseline 4ms!)
http_req_duration p95: 45ms
vus_max............: 8         (TĂNG từ 3 lên 8)
```

Kết luận thực tế:

```text
- Vẫn 0 drop -> service vẫn đáp ứng 24/s
- NHƯNG p95 tăng 4ms -> 45ms (11×)
- vus_max tăng 3 -> 8 (2.7×)
-> Đây là dấu hiệu cache hit rate đang GIẢM
   (cache miss tăng, request phải query DB)
-> Service CHƯA fail, nhưng đang đi sai hướng
=> QUYẾT ĐỊNH: Điều tra cache hit rate. Không release vội.
   Kiểm tra:
   - Redis/ Memcached có vấn đề không?
   - Cache TTL có quá ngắn không?
   - Có deployment mới làm mất cache không?
```

### Kịch bản C — contract breach (dropped > 0): SERVICE KHÔNG ĐỦ CAPACITY

```text
iterations.........: 895        (THIẾU 185 so với 1080!)
dropped_iterations.: 185
http_req_failed....: 2.3%      (có fail)
constant_arrival_event_duration_ms p95: 850ms   (RẤT CAO)
http_req_duration p95: 850ms
vus_max............: 30        (CHẠM TRẦN maxVUs)
```

Kết luận thực tế:

```text
- 185 iteration bị drop -> 17% request không được phục vụ
- p95=850ms -> event duration quá cao (cache miss + DB chậm)
- vus_max=30 -> đã dùng hết VU pool, không spawn thêm được
- required_vus ≈ 24 × 0.85 = 20.4 VU -> vượt maxVUs=30? Không...
  Thực ra với p95=850ms, một số event còn chậm hơn (p99 có thể 2-3s)
  -> required_vus thực tế có thể >30
-> Service KHÔNG đáp ứng được 24/s
=> QUYẾT ĐỊNH: ROLLBACK hoặc emergency fix. Service không sẵn sàng.
   Nguyên nhân có thể:
   - Cache cluster down (Redis/K8s fail)
   - DB quá tải (thiếu index, lock contention)
   - Network latency giữa service và cache/DB
```

### Kịch bản D — recommendations chậm nhưng homefeed nhanh: BOTTLENECK Ở ALGORITHM

```text
Tổng quan:
  iterations.........: 1080
  dropped_iterations.: 0
  overall p95........: 8ms    (vẫn pass, nhưng drill-down thấy...)

Drill-down theo operation:
  feed_arrival_homefeed p95:        3ms   (rất nhanh)
  feed_arrival_recommendations p95: 35ms  (CHẬM 12×!)
```

Kết luận thực tế:

```text
- Tổng quan vẫn pass (0 drop, p95=8ms)
- Nhưng recommendations chậm hơn homefeed 12×
- Nếu traffic tăng hoặc tỉ lệ recommendations tăng:
  -> p95 tổng sẽ tăng theo
  -> VU requirement sẽ tăng (vì W_effective tăng)
-> Recommendations là bottleneck
=> QUYẾT ĐỊNH: Tối ưu collaborative algorithm.
   - Cache kết quả recommendations (user-specific cache)
   - Precompute recommendations offline
   - Giảm limit=6 xuống 3 nếu UX cho phép
```

### Bảng ánh xạ nhanh output -> hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 1080 iter, 0 drop, p95=4ms, VU thấp | Cache hit tốt, service khỏe | Release, có thể tăng rate |
| 1080 iter, 0 drop, p95 tăng, VU tăng | Cache miss đang tăng | Điều tra cache, chưa release |
| <1080 iter, drop > 0, p95 cao, VU max | Service không đủ capacity | Rollback, fix infrastructure |
| 1080 iter, 0 drop, nhưng 1 operation chậm | Bottleneck ở operation cụ thể | Tối ưu operation đó |
| checks < 100%, http_req_failed > 1% | Service có bug (500 error...) | Fix bug, chạy lại |

## "Nghịch lý" — 4 điều trái với trực giác

### Nghịch lý 1: "Rate cao nhất pack nhưng preAllocatedVUs thấp hơn case rate thấp"

```text
Trực giác: "24/s là rate cao nhất trong pack -> chắc cần nhiều VU nhất."

Thực tế: case 06 preAllocatedVUs=12
         case 04 (checkout, rate=5/s) preAllocatedVUs=15

Vì sao?
  Case 04: W_effective ≈ 65ms (checkout có DB write, cart update, ...)
           required_vus ≈ 5 × 0.065 = 0.33 ≈ 1 VU (lý thuyết)
           Nhưng checkout có sleep/think time, stateful flow
           -> preAllocatedVUs=15 để buffer

  Case 06: W_effective ≈ 4ms (cache hit, stateless read)
           required_vus ≈ 24 × 0.004 = 0.1 ≈ 1 VU (lý thuyết)
           Không có sleep, stateless
           -> preAllocatedVUs=12 vẫn dư nhiều

Bài học: Rate KHÔNG quyết định VU requirement.
         Rate × event_duration mới quyết định.
         Đây chính là Little's Law.
```

### Nghịch lý 2: "1 VU đủ chạy 24/s nhưng production cần buffer"

```text
Trực giác: "Nếu 1 VU đủ xử lý 24/s (Little's Law), sao lại cần preAllocatedVUs=12?"

Thực tế: 1 VU đủ cho HAPPY PATH (cache hit 100%, event 4ms).
         Nhưng production không chạy ở happy path 100% thời gian.

Các scenario cần buffer:
  1. Cache miss: W=80ms -> cần 2 VU
  2. Cache miss + DB chậm: W=200ms -> cần 5 VU
  3. Cache cluster failover: W=500ms -> cần 12 VU
  4. Deployment rolling update: VU restart, cache cold -> cần thêm VU
  5. Traffic spike: 24/s -> 50/s bất ngờ

preAllocatedVUs=12 không phải cho happy path.
Nó là INSURANCE cho worst case.

Giống như: xe máy chạy 40km/h bình thường (happy path).
Nhưng vẫn cần phanh tốt, lốp tốt (buffer) cho tình huống khẩn cấp.
```

### Nghịch lý 3: "Cùng một code, cache hit 100% -> pass dễ; cache miss 50% -> có thể fail"

```text
Trực giác: "Test pass hay fail phụ thuộc vào code test."

Thực tế: Code test không đổi. Cùng file JS, cùng config.
         Nhưng backend state (cache hit rate) quyết định pass/fail.

Ví dụ:
  Lần 1 (cache warm, Redis khỏe):
    p95=4ms, required_vus≈1, 0 drop -> PASS

  Lần 2 (Redis vừa restart, cache cold):
    p95=45ms, required_vus≈2, 0 drop -> VẪN PASS (vì preAllocatedVUs=12 dư)

  Lần 3 (Redis down, DB quá tải):
    p95=2000ms, required_vus≈48, drop > 0 -> FAIL

Cùng code test, 3 kết quả khác nhau!
Đây KHÔNG phải là bug của test. Đây là test ĐANG LÀM ĐÚNG:
  - Nó phát hiện service không đáp ứng được khi cache down
  - Nó cho pass khi service OK

Bài học: Pass/fail của constant-arrival-rate test phụ thuộc vào
         SERVICE CAPACITY, không chỉ code test.
         Đây là điều LÀM CHO NÓ GIÁ TRỊ: nó test service thật,
         không phải test "code k6 có chạy không".
```

### Nghịch lý 4: "1081 iter với pre=12 — tưởng 12 VU mỗi VU chạy ~90 iteration"

```text
Trực giác: "12 VU, 1081 iteration -> mỗi VU chạy 1081/12 ≈ 90 iteration."

Thực tế: Với open model, iteration KHÔNG được phân phối đều cho VU.
         VU nhanh (CPU khỏe, network gần) nhận nhiều iteration hơn.
         VU chậm nhận ít hơn.

Trong case 06:
  - VU#1 có thể chạy 200 iteration
  - VU#12 có thể chạy 10 iteration
  - Phân phối KHÔNG đều -> đây là bình thường với open model

Vì sao?
  - Ticker schedule iteration, ai rảnh thì nhận
  - VU#1 xử lý xong event trong 3ms -> rảnh nhanh -> nhận slot tiếp theo
  - VU#12 xử lý event trong 5ms -> rảnh chậm hơn -> nhận ít slot hơn
  - VU nào nhanh thì nhận nhiều việc hơn

Đây là điểm KHÁC BIỆT với per-vu-iterations:
  per-vu-iterations: mỗi VU chạy ĐÚNG 5 iter (công bằng tuyệt đối)
  constant-arrival-rate: VU nhanh chạy nhiều, VU chậm chạy ít (công bằng
                         theo năng lực thực tế)

Trong production:
  - Server instance mạnh (nhiều CPU) xử lý nhiều request hơn
  - Server instance yếu (ít CPU) xử lý ít request hơn
  -> Open model mô phỏng đúng thực tế này
```

## Checklist thực hành case 06

```text
Trước khi chạy:
  [ ] Đọc và hiểu Little's Law: L = λ × W
  [ ] Hiểu vì sao rate=24/s nhưng VU requirement thấp
  [ ] Hiểu cache hit vs cache miss ảnh hưởng W_effective
  [ ] Biết cách override env vars (rate, VU, duration)

Trong khi chạy:
  [ ] Quan sát dashboard real-time
  [ ] Chart Response time: p95 có ổn định ~4ms không?
  [ ] Chart Execution timeline: RPS có ≈ 24/s mỗi bucket không?
  [ ] Chart VUs vs iter/s: Observed VUs có thấp hơn Executor VUs không?
  [ ] Tab Executor: rate=24/s, 0 drop?

Sau khi chạy:
  [ ] iterations ≈ 1080?
  [ ] dropped_iterations = 0?
  [ ] constant_arrival_event_duration_ms p95 < 10ms?
  [ ] http_req_failed = 0%?
  [ ] So sánh homefeed vs recommendations p95 (nếu drill được)

Phân tích:
  [ ] Tính required_vus = rate × p95_duration (Little's Law check)
  [ ] So sánh required_vus với vus_max thực tế
  [ ] Đánh giá headroom: preAllocatedVUs - required_vus
  [ ] Kết luận: service có đáp ứng được 24/s không? Còn headroom không?

Các câu hỏi tự hỏi:
  [ ] Nếu tăng rate lên 50/s, có pass không?
  [ ] Nếu cache miss 50%, còn pass không?
  [ ] Nếu chỉ có preAllocatedVUs=2, có pass không?
  [ ] Homefeed có nhanh hơn recommendations không? Bao nhiêu lần?
```

## 5 variations với code

### V1: Lower rate smoke test

```powershell
# Smoke test với rate thấp để verify setup
$env:CAR_06_RATE = "5"
$env:CAR_06_DURATION = "15s"
$env:CAR_06_PREALLOCATED_VUS = "2"
$env:CAR_06_MAX_VUS = "4"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-06-cacheable-feed-ingress.js"
```

```text
Expected:
  - scheduled_slots = 5 × 15 = 75
  - iterations ≈ 75
  - dropped_iterations = 0
  - p95 ~4ms (vẫn cache hit)

Mục đích: verify setup nhanh trước khi chạy full 24/s
```

### V2: Shrink VU pool — quan sát drop (dạy Little's Law)

```powershell
# Giảm VU pool để tạo crisis và quan sát drop
$env:CAR_06_PREALLOCATED_VUS = "2"
$env:CAR_06_MAX_VUS = "2"
$env:CAR_06_RATE = "24"
$env:CAR_06_DURATION = "20s"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-06-cacheable-feed-ingress.js"
```

```text
Với cache hit (p95=4ms):
  required_vus ≈ 24 × 0.004 = 0.1 -> 2 VU vẫn đủ
  -> KHÔNG drop (vẫn pass)

NHƯNG nếu backend chậm hơn (p95=100ms):
  required_vus ≈ 24 × 0.1 = 2.4 -> cần 3 VU
  maxVUs=2 -> KHÔNG ĐỦ -> dropped_iterations > 0

Mục đích: chứng minh Little's Law bằng thực nghiệm.
         Khi maxVUs < required_vus -> drop.
         Khi maxVUs >= required_vus -> không drop.
```

### V3: Tăng cpu_ms/db_rows — mô phỏng cache miss

```powershell
# Mô phỏng cache miss bằng cách tăng backend latency
# (cần sửa code thêm env vars cho cpu_ms, db_rows)
$env:CAR_06_HOMEFEED_CPU_MS = "50"
$env:CAR_06_HOMEFEED_DB_ROWS = "100"
$env:CAR_06_RECOMMENDATIONS_CPU_MS = "100"
$env:CAR_06_RECOMMENDATIONS_DB_ROWS = "200"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-06-cacheable-feed-ingress.js"
```

```text
Expected:
  - p95 tăng từ 4ms -> 200-400ms
  - required_vus ≈ 24 × 0.3 = 7.2 -> cần 8 VU
  - preAllocatedVUs=12 vẫn đủ -> không drop
  - Nhưng vus_max tăng lên ~8-10 (thay vì 1-3)

Mục đích: thấy được cache miss làm tăng VU demand như thế nào.
         Dù chưa drop, nhưng VU usage tăng là dấu hiệu cảnh báo sớm.
```

### V4: Thay đổi geo distribution

```powershell
# Sửa code hoặc thêm env var để thay đổi geo distribution
# Mặc định: VN 33%, US 67%
# Thay đổi: VN 100% (tất cả user từ VN)
```

```text
Nếu tất cả user từ VN (xa cache server):
  - Latency có thể cao hơn (network latency US-VN)
  - p95 tăng -> VU requirement tăng
  -> Thấy được ảnh hưởng của geo distribution đến capacity

Nếu tất cả user từ US (gần cache server):
  - Latency thấp hơn
  - p95 thấp -> VU requirement thấp
  -> Baseline tốt nhất
```

### V5: Higher rate stress test

```powershell
# Tăng rate lên 50/s để test giới hạn
$env:CAR_06_RATE = "50"
$env:CAR_06_DURATION = "30s"
$env:CAR_06_PREALLOCATED_VUS = "12"
$env:CAR_06_MAX_VUS = "30"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-06-cacheable-feed-ingress.js"
```

```text
Với cache hit (p95=4ms):
  required_vus ≈ 50 × 0.004 = 0.2 -> 1 VU
  -> VẪN PASS với 50/s!

Với cache miss 10% (p95 trung bình ~12ms):
  required_vus ≈ 50 × 0.012 = 0.6 -> 1 VU
  -> Vẫn pass

Với cache miss 50% (p95 trung bình ~42ms):
  required_vus ≈ 50 × 0.042 = 2.1 -> 3 VU
  -> Vẫn pass

-> Feed service có thể chịu được rate rất cao nếu cache hit rate tốt.
   Đây là sức mạnh của cacheable read endpoint.
```

## Anti-patterns (mở rộng)

### Anti-pattern 1: "Rate cao nhất nên cần nhiều VU nhất"

```text
SAI: "Case 06 có rate=24/s (cao nhất pack) -> cần nhiều VU nhất."

ĐÚNG: VU requirement = rate × event_duration (Little's Law).
      Case 06: 24 × 0.004 = 0.1 VU
      Case 04: 5 × 0.065 = 0.33 VU
      -> Case 04 cần nhiều VU hơn case 06, dù rate thấp hơn 5×.

Giải thích: Feed là cacheable read (4ms), checkout là transactional write (65ms).
           Loại operation quan trọng hơn rate.
```

### Anti-pattern 2: "Cacheable endpoint không cần đọc dropped_iterations"

```text
SAI: "Feed cache hit 99% -> không bao giờ drop -> không cần check dropped_iterations."

ĐÚNG: dropped_iterations vẫn là pass criteria CỨNG.
      Cache hit 99% hôm nay, nhưng ngày mai Redis down -> cache miss 100%.
      Lúc đó drop là tín hiệu DUY NHẤT báo động.
      Bỏ qua dropped_iterations = mù với crisis.

Giải thích: Test không chỉ verify happy path. Nó là CONTRACT:
           "24/s phải được đáp ứng, dù cache có hoạt động hay không."
```

### Anti-pattern 3: "1080 http_reqs nghĩa là 1080 user"

```text
SAI: "Có 1080 HTTP requests -> 1080 user khác nhau đã gọi API."

ĐÚNG: Đó là 1080 ARRIVALS (HTTP requests), không phải 1080 user.
      User pool = 1000, user được reuse (quay vòng).
      User arrival-user-1 có thể gọi 2 lần (iter 0 và iter 1000).

Giải thích: Constant-arrival-rate test ARRIVAL RATE, không phải UNIQUE USER COUNT.
           Trong production cũng vậy: 1 user mở app nhiều lần -> nhiều request.
```

### Anti-pattern 4: "preAllocatedVUs=12 là lãng phí vì chỉ cần 1-2 VU"

```text
SAI: "Observed VUs chỉ 1-3, preAllocatedVUs=12 -> lãng phí 9-11 VU."

ĐÚNG: preAllocatedVUs không phải để dùng hết. Nó là buffer.
      - Happy path: chỉ cần 1-2 VU, 10 VU idle
      - Cache miss: cần 5-8 VU, 4-7 VU idle
      - Crisis: cần 12 VU, 0 VU idle
      - Super crisis: cần >12 VU, spawn thêm đến maxVUs=30

      Nếu preAllocatedVUs=2, crisis sẽ drop ngay lập tức
      (vì spawn VU mới mất thời gian).
      preAllocatedVUs=12 cho phép xử lý crisis mà không cần spawn.

Giải thích: Giống như RAM trong laptop. Bình thường dùng 4GB/16GB.
           12GB "lãng phí" — cho đến khi mở nhiều tab Chrome.
           Lúc đó 16GB mới là vừa đủ.
```

### Anti-pattern 5: "p95=4ms quá thấp, chắc test không thực tế"

```text
SAI: "Production không thể có p95=4ms -> test này không thực tế."

ĐÚNG: p95=4ms là kết quả của:
      1. Backend mô phỏng (cpu_ms=1-2, db_rows=2-3) -> nhẹ
      2. Cache hit 100% (user pool=1000, pattern lặp) -> nhanh
      3. Localhost (không network latency) -> nhanh
      4. Không có external dependency (auth, payment) -> đơn giản

      Đây là TEST ENVIRONMENT, không phải production.
      Mục đích không phải đo latency tuyệt đối.
      Mục đích là:
      - Verify rate=24/s được duy trì
      - Hiểu quan hệ rate - duration - VU (Little's Law)
      - Thấy được cache hit vs cache miss ảnh hưởng thế nào

      Trong production, p95 có thể 20-50ms (network latency).
      Nhưng pattern rate-VU vẫn đúng: 24 × 0.030 = 0.72 VU.

Giải thích: Test dạy NGUYÊN LÝ, không phải dự đoán production latency.
           Khi tăng cpu_ms/db_rows, pattern vẫn đúng, chỉ scale lên.
```

## Kết quả validation 2026-06-21

Full run với default config:

```text
Run id: 94
Test file: car-06-cacheable-feed-ingress.js
Config: rate=24, timeUnit=1s, duration=45s
        preAllocatedVUs=12, maxVUs=30

Target slots: 24 × 45 = 1080

Results:
  Iterations:              1081
  HTTP requests:           1081
  Dropped iterations:      0
  Checks:                  100% (rate > 0.99)
  HTTP failed:             0% (rate < 0.01)
  constant_arrival_events_failed: 0
  constant_arrival_event_duration_ms p95: 4ms
  http_req_duration p95:   4ms
  vus_max:                 3

Result: PASS

Phân tích:
  - 1081 iteration > 1080 scheduled (off-by-one bình thường)
  - 0 drop: service đáp ứng 24/s hoàn hảo
  - p95=4ms: cache hit rate cao, event duration cực thấp
  - vus_max=3: VU requirement thấp (Little's Law xác nhận)
  - Còn 9/12 preAllocatedVUs idle -> headroom lớn

Chart analysis chi tiết nằm ở 08_validation-and-chart-analysis.md.
```

## Reference

- Doc tham số constant-arrival-rate: `docs/...constant-arrival-rate-tham-so-cong-thuc.md`
- Case 04 (checkout, rate=5/s): so sánh VU requirement với high-rate case này
- Case 05 (report, rate=10/s): một high-rate read khác
- Little's Law: L = λ × W (queueing theory)
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-06-cacheable-feed-ingress.js`
- Common helpers: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\common.js`
