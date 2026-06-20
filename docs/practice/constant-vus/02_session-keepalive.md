# Case 02: Session keepalive

## Tình huống thực tế

Team auth vừa deploy thay đổi session store, token rotation logic, hoặc refresh flow. Sau deploy, họ cần biết service giữ được bao nhiêu logged-in sessions khỏe mạnh trong một cửa sổ thời gian ổn định.

Mỗi active user login, gọi `/auth/me` để keepalive, và thỉnh thoảng refresh token. Đây là session stability, không phải login backlog. Khác với login benchmark (đo có bao nhiêu user login được trong 1 giây), session keepalive đo xem **sau khi đã login rồi**, các session có giữ được trạng thái khỏe mạnh liên tục trong một observation window hay không.

Case này trả lời: 15 active sessions trong 5 phút có giữ auth state ổn định, refresh token không lỗi, và keepalive latency không tăng không?

Tóm tắt đời thường:

```text
Executor model: fixed active user pool
VUs: 15
Duration: 5m
Think time: 1s
Team/service focus: auth/session
```

Case này **không** cố gắng trả lời "auth service login được bao nhiêu user mỗi giây". Nó trả lời câu hỏi session health cụ thể hơn:

Case này không hỏi:

```text
Có xử lý đủ N job không?
Có đạt đúng X RPS không?
Mỗi user có chạy đúng N vòng không?
```

Nó hỏi:

```text
Nếu giữ 15 active users trong 5m,
latency/error/natural throughput của flow này ra sao?
```

### Vì sao "Session keepalive" buộc chọn constant-vus?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của session keepalive trước:

```text
Session keepalive = "giữ 15 logged-in sessions tồn tại trong 5 phút,
                     mỗi session định kỳ gọi keepalive và refresh token,
                     xác nhận cả 2 operation đều pass và latency không degrade"

Đời thường:
  Có 15 người dùng đã đăng nhập vào app (= 15 sessions)
  Họ để app mở trong 5 phút (= observation window)
  App định kỳ gọi API để giữ session alive (= keepalive)
  Thỉnh thoảng app refresh token khi token sắp hết hạn (= refresh)
  Mỗi người tự lặp flow của mình, không chờ người khác
  Kết thúc 5 phút, ta quan sát: có session nào bị đứt không? refresh có lỗi không?
```

Để session keepalive **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ constant-vus mới thỏa mãn cả 2.

#### Yêu cầu (a): STEADY CONCURRENCY OVER TIME (không phải job count)

**Ý nghĩa**: 15 sessions phải cùng active trong suốt 5 phút. Không phải "tổng cộng có 15 lần login", mà là "tại mọi thời điểm trong 5 phút, có 15 sessions đang giữ trạng thái alive".

**Ví dụ cụ thể**:

```text
Scenario: team auth deploy token rotation mới, cần verify session stability

Trường hợp A (concurrency ĐÚNG):
  15 sessions cùng active trong 5 phút
  T=0: 15 user login, bắt đầu keepalive loop
  T=1m: 15 user vẫn đang keepalive
  T=3m: 15 user vẫn đang keepalive
  T=5m: test dừng, 15 sessions đã được observe đủ 5 phút
  → Kết luận: session stability OK, refresh flow OK

Trường hợp B (concurrency SAI - test chỉ có 3 sessions đồng thời):
  Test chạy 5 phút nhưng VUs chỉ lên được 3 ở đỉnh
  → Chỉ 3 sessions được observe đồng thời
  → Không biết auth service có giữ được 15 sessions không
  → KHÔNG kết luận được, test không có giá trị
```

**Vì sao concurrency phải phẳng ở 15 trong suốt duration?**

```text
Nếu concurrency không được giữ cố định:
  - duration cố định 5m
  - VUs biến thiên (3 → 8 → 15 → 5 → 12...)
  - Có lúc 15 sessions cùng active, có lúc chỉ 3
  
  → Session pool pressure KHÔNG ổn định
  → Không biết auth service chịu được 15 sessions liên tục không
  → Lúc VUs=3 mà latency đẹp: chưa chứng minh được gì cho 15 sessions
  → Lúc VUs=15 mà latency xấu: không biết là do spike tạm thời hay steady pressure
```

**Phân tích sâu: vì sao 2 executor "count-based" không đảm bảo concurrency?**

`shared-iterations` với `vus=15, iterations=300`:

```text
Mục tiêu config: "300 iterations tổng, 15 VU cùng chạy"
→ Có vẻ giống: 15 sessions × 20 loops mỗi session = 300 iterations

Nhưng thực tế:
  - shared-iterations là worker pool, không giữ identity
  - VU nhanh (network tốt, latency thấp) sẽ lấy 30 iterations
  - VU chậm (network kém, latency cao) sẽ lấy 8 iterations
  - Phân phối: 30, 28, 25, 22, 20, 18, 15, 12, 10, 8, 8, 7, 5, 3, 2 = 213 (chưa đủ 300!)
  - Hoặc VU nhanh nhất đã lấy hết 300 trước khi VU chậm kịp làm gì

  Vấn đề 1: Phân phối iterations không đều
    → VU nhanh chạy 30 loops, VU chậm chỉ 2 loops
    → Không phải 15 sessions cùng active ổn định

  Vấn đề 2: Không giữ được session identity qua các iteration
    → VU=1 chạy iter #0 (session A), iter #3 (session D), iter #7 (session H)...
    → Mỗi iter là một session KHÁC NHAU
    → Không có session nào được keepalive LIÊN TỤC trong 5 phút
    → Login xảy ra ở mỗi iteration → test thành login benchmark, không phải session keepalive

  Vấn đề 3: Không có observation window
    → Test dừng khi hết 300 iterations, không phải sau 5 phút
    → Nếu latency thấp: 300 iter × 1.1s = 330s ≈ 5.5 phút
    → Nếu latency cao: 300 iter × 2.5s = 750s ≈ 12.5 phút
    → Duration khác nhau mỗi lần chạy → không so sánh được session health theo thời gian
```

`per-vu-iterations` với `vus=15, iterations=20`:

```text
Mục tiêu config: "15 VU, mỗi VU chạy 20 iterations"
→ Có vẻ giống: 15 sessions × 20 keepalive loops = 300 total

Nhưng thực tế:
  - Mỗi VU chạy ĐÚNG 20 iterations rồi dừng
  - VU nhanh: 20 iter × 0.8s = 16s → xong, IDLE
  - VU chậm: 20 iter × 2.0s = 40s → vẫn đang chạy
  
  Vấn đề 1: Concurrency không ổn định
    → Sau 16s, VU nhanh đã idle → chỉ còn vài VU chậm đang chạy
    → Session pool pressure giảm dần theo thời gian
    → Không phải 15 sessions cùng active trong 5 phút

  Vấn đề 2: Observation window bị cắt thành "ai xong trước nghỉ trước"
    → Không có cửa sổ quan sát chung 5 phút
    → Mỗi VU có cửa sổ riêng (16s, 40s, 25s...)
    → Không quan sát được session health sau 1-2 phút

  Vấn đề 3: 20 iterations là quota cứng
    → Không phản ánh "user để app mở 5 phút"
    → Phản ánh "user bấm đúng 20 lần rồi thoát"
    → Không giống hành vi session keepalive thực tế
```

**Trong khi đó với `constant-vus`**:

```text
Config: vus=15, duration=5m
15 VU cùng start, mỗi VU giữ 1 session identity, loop liên tục đến khi hết 5m.

Lần 1: auth nhanh (keepalive 50ms)
  → Mỗi VU loop ~1.05s (50ms API + 1s sleep)
  → 5 phút / 1.05s ≈ 285 loops mỗi VU
  → Tổng ≈ 4275 iterations
  → 15 sessions active đủ 5 phút ✓

Lần 2: auth chậm (keepalive 500ms)
  → Mỗi VU loop ~1.5s (500ms API + 1s sleep)
  → 5 phút / 1.5s ≈ 200 loops mỗi VU
  → Tổng ≈ 3000 iterations
  → 15 sessions VẪN active đủ 5 phút ✓
  → Iterations giảm là TÍN HIỆU (auth chậm), không phải lỗi test

Lần 3: auth rất chậm (keepalive 3s)
  → Mỗi VU loop ~4.0s (3s API + 1s sleep)
  → 5 phút / 4.0s ≈ 75 loops mỗi VU
  → Tổng ≈ 1125 iterations
  → 15 sessions VẪN active đủ 5 phút ✓
  → Iterations giảm mạnh → closed-model backpressure signal

→ 15 sessions luôn active trong 5 phút (yêu cầu a)
→ Iterations thay đổi theo latency → đó CHÍNH LÀ cái cần đo
→ Session health được observe LIÊN TỤC, không bị ngắt quãng
```

**Tóm tắt 3 executor về session concurrency**:

| Executor | Concurrency formula | Concurrency ổn định? | Session identity ổn định? | Session observe liên tục? |
| --- | --- | --- | --- | --- |
| **constant-vus** | `vus` cố định trong `duration` | CÓ (phẳng tuyệt đối) | CÓ (mỗi VU = 1 session) | CÓ (suốt 5 phút) |
| shared-iterations | worker pool, VU nhanh làm nhiều | KHÔNG (phân phối lệch) | KHÔNG (mỗi iter khác session) | KHÔNG (login lại mỗi iter) |
| per-vu-iterations | giảm dần khi VU nhanh xong sớm | KHÔNG (tụt dần) | CÓ (mỗi VU = 1 session) | KHÔNG (quota 20 iter, hết là dừng) |

→ CONCURRENCY phải PHẲNG trong observation window
→ SESSION IDENTITY phải ỔN ĐỊNH (cùng session được keepalive suốt 5 phút)
→ Chỉ constant-vus thỏa mãn cả 2

#### Yêu cầu (b): CLOSED-MODEL BACKPRESSURE SIGNAL (auth chậm thì RPS giảm, không phải bơm thêm)

**Ý nghĩa**: Khi auth service chậm, session keepalive test phải **giảm RPS tự nhiên** (vì mỗi session loop lâu hơn), chứ không được **bơm thêm login/keepalive để giữ RPS**. Đây là khác biệt cốt lõi giữa constant-vus và constant-arrival-rate.

**Bug "bơm thêm khi auth chậm" là gì?**

```text
Tưởng tượng quán cafe có 15 khách (15 sessions):
  - Bình thường: mỗi khách order 1 ly mỗi 1 phút
    → 15 orders/phút
  
  - Máy pha cafe bị chậm (auth service slow):
    → Mỗi khách vẫn ngồi đó, nhưng order lâu hơn (2 phút/ly)
    → 7.5 orders/phút (GIẢM tự nhiên)
    → Đây là closed model: khách không rời đi, họ chờ
    → Barista thấy áp lực vì 15 khách cùng chờ
  
  - Nếu quán CỐ bơm thêm khách mới để giữ 15 orders/phút (arrival-rate):
    → Khách cũ đang chờ + khách mới vào thêm
    → Hàng đợi chất đống, khách cũ càng chờ lâu
    → Barista quá tải, hệ thống sập
    → Che mất tín hiệu "auth đang chậm"
```

**Demo constant-arrival-rate khi auth chậm**:

```text
Config: constant-arrival-rate, rate=3/s, duration=5m, preAllocatedVUs=15

Kịch bản auth bình thường:
  keepalive latency = 50ms
  → Mỗi iter mất ~1.05s (50ms API + 1s sleep)
  → 15 VUs × (1 / 1.05s) ≈ 14.3 iter/s
  → Arrival rate 3/s: dư VUs, không drop
  → RPS giữ được 3/s (nhưng đây là login mới, không phải keepalive)

Kịch bản auth chậm (keepalive = 500ms):
  → Mỗi iter mất ~1.5s
  → 15 VUs × (1 / 1.5s) ≈ 10 iter/s
  → Arrival rate 3/s: vẫn đủ, không drop
  → NHƯNG: arrival-rate KHÔNG phân biệt "session cũ đang keepalive" với "login mới"
  → Nó cứ bơm iteration mới theo rate 3/s
  → Login mới liên tục được tạo, trong khi session cũ đang chậm
  → Session store phình lên (nhiều session hơn 15)
  → Auth service quá tải, nhưng RPS vẫn đẹp → TEST CHE MẤT VẤN ĐỀ

Kịch bản auth rất chậm (keepalive = 3s):
  → Mỗi iter mất ~4.0s
  → 15 VUs × (1 / 4.0s) ≈ 3.75 iter/s
  → Arrival rate 3/s: gần chạm giới hạn
  → Nếu thêm 1 VU chậm bất thường (5s/iter) → drop iteration
  → Dropped iterations là tín hiệu sai: không phải auth có vấn đề gì mới,
    mà là arrival-rate không đủ VUs để giữ rate
```

**Trong khi đó với constant-vus**:

```text
Kịch bản auth bình thường:
  15 VUs, keepalive = 50ms
  → iter/s ≈ 15 / 1.05 ≈ 14.3 iter/s
  → RPS ≈ 14.3 × ~1.2 API/iter ≈ 17 req/s

Kịch bản auth chậm (keepalive = 500ms):
  15 VUs, keepalive = 500ms
  → iter/s ≈ 15 / 1.5 ≈ 10 iter/s  ← GIẢM từ 14.3
  → RPS ≈ 10 × ~1.2 ≈ 12 req/s    ← GIẢM từ 17
  → Đây là TÍN HIỆU ĐÚNG: auth chậm làm giảm throughput
  → Không bơm thêm, không drop, không che vấn đề

Kịch bản auth rất chậm (keepalive = 3s):
  15 VUs, keepalive = 3s
  → iter/s ≈ 15 / 4.0 ≈ 3.75 iter/s  ← GIẢM MẠNH
  → RPS ≈ 3.75 × ~1.2 ≈ 4.5 req/s
  → VUs vẫn flat=15, nhưng iter/s giảm 74%
  → CLOSED-MODEL SIGNAL: auth service đang rất chậm
  → Hành động: investigate auth latency, không phải "tăng VUs"
```

**Demo trace closed-model backpressure với 3 VUs (rút gọn để dễ thấy)**:

```text
Config: vus=3, duration=60s, sleep=1s

Kịch bản A — Auth bình thường (keepalive 50ms):
  VU=1: login → keepalive(50ms) → sleep(1s) → keepalive(50ms) → sleep(1s) → ...
  VU=2: login → keepalive(50ms) → sleep(1s) → keepalive(50ms) → sleep(1s) → ...
  VU=3: login → keepalive(50ms) → sleep(1s) → keepalive(50ms) → sleep(1s) → ...
  
  Loop time = 50ms + 1s + tiny JS ≈ 1.05s
  Mỗi VU: 60s / 1.05s ≈ 57 loops
  Tổng: 171 iterations
  iter/s ≈ 171 / 60 ≈ 2.85

Kịch bản B — Auth chậm (keepalive 500ms, session store slow):
  VU=1: login → keepalive(500ms) → sleep(1s) → keepalive(500ms) → sleep(1s) → ...
  VU=2: login → keepalive(500ms) → sleep(1s) → keepalive(500ms) → sleep(1s) → ...
  VU=3: login → keepalive(500ms) → sleep(1s) → keepalive(500ms) → sleep(1s) → ...
  
  Loop time = 500ms + 1s = 1.5s
  Mỗi VU: 60s / 1.5s ≈ 40 loops
  Tổng: 120 iterations  ← GIẢM 30% so với bình thường
  iter/s ≈ 120 / 60 ≈ 2.0

  VUs vẫn = 3 (phẳng)
  iter/s giảm từ 2.85 → 2.0
  ← ĐÂY LÀ TÍN HIỆU: auth chậm, closed-model backpressure

Kịch bản C — Auth rất chậm (keepalive 3s, DB lock contention):
  VU=1: login → keepalive(3s) → sleep(1s) → keepalive(3s) → sleep(1s) → ...
  VU=2: login → keepalive(3s) → sleep(1s) → keepalive(3s) → sleep(1s) → ...
  VU=3: login → keepalive(3s) → sleep(1s) → keepalive(3s) → sleep(1s) → ...
  
  Loop time = 3s + 1s = 4.0s
  Mỗi VU: 60s / 4.0s ≈ 15 loops
  Tổng: 45 iterations  ← GIẢM 74% so với bình thường
  iter/s ≈ 45 / 60 ≈ 0.75

  VUs vẫn = 3 (phẳng)
  iter/s giảm từ 2.85 → 0.75
  ← ĐÂY LÀ TÍN HIỆU MẠNH: auth rất chậm, cần investigate ngay
```

### Tổng kết: chỉ constant-vus thỏa mãn cả (a) và (b)

| Executor | (a) Steady concurrency over time | (b) Closed-model backpressure signal | Verdict |
| --- | --- | --- | --- |
| **constant-vus** | ✓ VUs phẳng trong duration | ✓ auth chậm → RPS giảm tự nhiên | ✅ DÙNG |
| shared-iterations | ✗ phân phối lệch, không giữ identity | ✗ count-based, không quan sát theo thời gian | ❌ |
| per-vu-iterations | ✗ VU nhanh xong sớm, concurrency tụt | ✗ quota-based, không có observation window | ❌ |
| constant-arrival-rate | ✗ bơm thêm arrivals khi auth chậm | ✗ che mất backpressure signal | ❌ |
| ramping-vus | ✗ concurrency thay đổi theo thời gian | ✗ không có baseline phẳng | ❌ |
| ramping-arrival-rate | ✗ arrivals thay đổi theo thời gian | ✗ không phân biệt session cũ vs mới | ❌ |

→ Chỉ **constant-vus** thỏa mãn cả 2 yêu cầu, các executor khác đều fail ở ít nhất 1 trong 2.

### 3 thông số config ánh xạ từ yêu cầu nghiệp vụ

```text
1. SESSION POOL SIZE (số session cùng active):
   - Team auth muốn biết 15 sessions đồng thời có khỏe không
   - Không phải "tổng cộng có 15 lần login"
   - Không phải "15 sessions × N loops"
   → vus = 15 (session pool size)
   → KHÔNG dùng iterations làm input chính

2. OBSERVATION WINDOW (thời gian quan sát session health):
   - Cần observe đủ lâu để thấy refresh cycle và latency trend
   - 5 phút đủ để mỗi session refresh ít nhất vài lần
   → duration = 5m (observation window)
   → KHÔNG phải "deadline để hoàn tất N jobs"

3. THINK TIME (khoảng nghỉ giữa các keepalive):
   - Mô phỏng app gọi keepalive định kỳ, không phải gọi liên tục
   - 1 giây là khoảng nghỉ hợp lý giữa các lần keepalive
   → sleep = 1s (think interval)
   → Tác động đến iter/s nhưng đó là expected
```

## Yêu cầu cứng của case này

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Giữ 15 active logged-in users trong 5m | Vì session health cần được observe liên tục, không phải "có login thành công là xong". |
| Không biến test thành 15 users × N fixed loops; số keepalive loops là output | Vì đây là session stability, không phải quota replay. |
| Login, keepalive, refresh phải đọc riêng theo operation | Vì aggregate metrics có thể che refresh failure nếu keepalive vẫn pass. |
| Failed session loops phải dưới `constant_active_iterations_failed count<10` | Vì mỗi failed loop là một session bị đứt quãng. |
| VUs phải phẳng gần 15 trong toàn bộ regular phase | Vì nếu VUs không phẳng, session pool pressure không ổn định, kết quả không đại diện. |
| `user_id` tag phải ổn định theo VU | Vì cần trace được một session cụ thể qua nhiều iteration để chẩn đoán. |

Các invariant chung:

```text
vus + duration = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì RPS giảm
```

Do đó không được fail test chỉ vì `iterations` không bằng một số target tưởng tượng.

Nếu một trong các invariant về concurrency/session identity fail, kết quả nên coi là **invalid hoặc fail**, không phải "pass nhưng hơi lệch".

## Vì sao "Session keepalive" nên dùng `constant-vus`?

Bài toán là active sessions cùng tồn tại theo thời gian. `constant-vus` giữ số session users phẳng để auth service chịu steady session pressure.

Mental model:

```text
15 active VUs start.
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

Mental model so sánh với shared-iterations (worker pool):

```text
shared-iterations giống như:
  "Có 80 thùng hàng. 8 công nhân. Chia nhau kiểm đến khi hết 80 thùng."
  → Mục tiêu: drain hết backlog
  → Input: số job (80)
  → Output: thời gian hoàn tất

constant-vus giống như:
  "Có 15 người ngồi trong quán 5 phút. Mỗi người tự order khi muốn."
  → Mục tiêu: observe hành vi trong cửa sổ thời gian
  → Input: số người (15) + thời gian (5 phút)
  → Output: số order, latency, lỗi
```

## Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho case steady active users? |
| --- | --- | --- |
| `constant-vus` | Giữ N active users trong duration T | **Đúng**: input chính là concurrency + observation window; throughput là output tự nhiên. |
| `shared-iterations` | Cũng có nhiều VU cùng làm việc | Sai nếu không có backlog hữu hạn cần drain đủ; nó tối ưu fixed total jobs, không phải active users over time. Session identity không ổn định qua các iteration. |
| `per-vu-iterations` | VU có thể là user identity ổn định | Sai nếu không cần mỗi user chạy đúng N vòng; nó biến test thành quota replay, không phải steady active pool. VU nhanh xong sớm → concurrency tụt. |
| `constant-arrival-rate` | Có thể giữ RPS cố định | Sai nếu muốn quan sát closed-model backpressure; arrival-rate sẽ cố bơm traffic theo rate, che mất tín hiệu auth chậm. Đồng thời arrival-rate không giữ session identity — mỗi iteration là một login mới. |
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
CV_02_VUS = 15
CV_02_DURATION = 5m
CV_02_SLEEP_SECONDS = 1
```

| Config/env | Giá trị | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `CV_02_VUS` | 15 | Số active sessions |
| `CV_02_DURATION` | 5m | Observation window |
| `CV_02_SLEEP_SECONDS` | 1 | Keepalive think interval |

Mapping quan trọng:

```text
business session pool size = 15 sessions
k6 vus                     = 15
observation window         = 5m
think time between loops   = 1s
```

Threshold cap riêng:

```text
constant_active_iterations_failed: count<10
```

Operation count expected (ước lượng, không phải target cứng):

```text
session_login: ~15 (mỗi VU login 1 lần ở iteration đầu)
session_me_keepalive: mỗi iteration có 1
session_refresh: mỗi 5 iteration có 1 (iter % 5 === 0)
```

Nhưng `session_login` có thể > 15 nếu duration dài và script cho phép re-login ở các iteration sau. Đọc code để biết chính xác logic login.

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

### Identity model chi tiết: VU = session, iterationInTest = loop index

Đây là điểm khác biệt quan trọng nhất giữa constant-vus và shared-iterations khi làm session keepalive.

```text
Trong constant-vus:
  VU=1 luôn là session-user-1
  VU=2 luôn là session-user-2
  ...
  VU=15 luôn là session-user-15

  Mỗi VU login MỘT LẦN ở iteration đầu tiên,
  sau đó loop keepalive + refresh LIÊN TỤC trong suốt duration.
  Token/session state được lưu per-VU (qua biến closure hoặc module-level).

Trong shared-iterations:
  VU=1 chạy iter #0 (session A) → iter #3 (session D) → iter #7 (session H)...
  KHÔNG có persistent session identity
  Mỗi iteration phải login lại từ đầu
  → Đây là login benchmark, không phải session keepalive
```

**Demo trace identity model với constant-vus, 3 VU, duration=30s**:

```text
Config: vus=3, duration=30s, sleep=1s
Mỗi VU login ở iter đầu, sau đó keepalive loop.

t=0.0s   VU=1: iter=0, login as steady-user-1, keepalive, sleep(1s)
         VU=2: iter=0, login as steady-user-2, keepalive, sleep(1s)
         VU=3: iter=0, login as steady-user-3, keepalive, sleep(1s)

t=1.1s   VU=1: iter=1, keepalive (KHÔNG login lại), sleep(1s)
         VU=2: iter=1, keepalive (KHÔNG login lại), sleep(1s)
         VU=3: iter=1, keepalive (KHÔNG login lại), sleep(1s)

t=2.2s   VU=1: iter=2, keepalive, sleep(1s)
         VU=2: iter=2, keepalive, sleep(1s)
         VU=3: iter=2, keepalive, sleep(1s)

... tiếp tục đến t=30s

Kết quả:
  Mỗi VU: ~28 iterations (30s / 1.05s ≈ 28)
  Tổng: ~84 iterations
  session_login count: 3 (đúng 1 lần mỗi VU)
  session_me_keepalive count: 84 (mỗi iteration 1 lần)
  session_refresh count: 84/5 ≈ 16 (mỗi 5 iteration 1 lần)

Điểm quan trọng:
  - VU=1 luôn là steady-user-1 qua 28 iterations
  - Token/session state của steady-user-1 KHÔNG thay đổi giữa các iteration
  - Nếu steady-user-1 bị fail ở iter #15, tag user_id=steady-user-1
    giúp trace ngược: có phải chỉ mình session này fail? hay tất cả?
```

### Code pattern đúng cho constant-vus session keepalive

Code pattern cho session keepalive khác với shared-iterations ở chỗ **login xảy ra 1 lần ở iteration đầu, sau đó chỉ keepalive + refresh**:

```js
import exec from "k6/execution";
import { check, sleep } from "k6";
import http from "k6/http";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";
const VUS = 15;
const DURATION_SECONDS = 300; // 5 phút
const SLEEP_SECONDS = 1;

export const options = {
  scenarios: {
    session_keepalive: {
      executor: "constant-vus",
      vus: VUS,
      duration: `${DURATION_SECONDS / 60}m`,
    },
  },
};

export default function () {
  const vuId = exec.vu.idInTest;           // 1..15
  const iter = exec.scenario.iterationInTest; // 0, 1, 2, ...
  const userId = `steady-user-${vuId}`;

  // Login CHỈ ở iteration đầu tiên của mỗi VU
  // (hoặc logic: login nếu iter < VUS để đảm bảo mỗi VU login 1 lần)
  if (iter === 0) {
    const loginRes = http.post(`${BASE_URL}/api/sim/auth/login`, JSON.stringify({
      username: userId,
      password: `pass-${vuId}`,
    }), {
      headers: { "Content-Type": "application/json" },
      tags: { operation: "session_login", user_id: userId },
    });
    check(loginRes, { "login status 200": (r) => r.status === 200 });
  }

  // Keepalive — gọi MỖI iteration
  const meRes = http.get(`${BASE_URL}/api/sim/auth/me`, {
    headers: { Authorization: `Bearer cv-session-${vuId}` },
    tags: { operation: "session_me_keepalive", user_id: userId },
  });
  check(meRes, { "keepalive status 200": (r) => r.status === 200 });

  // Refresh — mỗi 5 iteration
  if (iter % 5 === 0) {
    const refreshRes = http.post(`${BASE_URL}/api/sim/auth/refresh`, JSON.stringify({
      refresh_token: `refresh-${vuId}`,
    }), {
      headers: { "Content-Type": "application/json" },
      tags: { operation: "session_refresh", user_id: userId },
    });
    check(refreshRes, { "refresh status 200": (r) => r.status === 200 });
  }

  // Think time
  sleep(SLEEP_SECONDS);
}
```

**KHÔNG viết thế này**:

```js
// SAI — login lại mỗi iteration (thành login benchmark)
export default function () {
  const loginRes = http.post(`${BASE_URL}/api/sim/auth/login`, ...);  // Mỗi iter login 1 lần
  const meRes = http.get(`${BASE_URL}/api/sim/auth/me`, ...);
  sleep(1);
}
// → 300 iterations = 300 lần login → không phải session keepalive

// SAI — dùng iterationInTest làm user identity
const userId = `user-${exec.scenario.iterationInTest}`;
// → Mỗi iteration tạo user mới → session không được giữ qua các loop
```

### Vì sao constant-vus CÓ per-VU state, shared-iterations KHÔNG có?

Trong constant-vus session keepalive, per-VU state (token, session cookie, user identity) là **cần thiết và hợp lệ**:

```text
constant-vus:
  VU=1 luôn là steady-user-1
  → Token của steady-user-1 có thể lưu trong biến closure của VU=1
  → Token này được dùng lại qua 28 iterations
  → Đây là mô phỏng ĐÚNG: 1 user giữ 1 session trong 5 phút

shared-iterations:
  VU=1 chạy iter #0 (SKU A) → iter #3 (SKU D) → iter #7 (SKU H)
  → Mỗi iter là một SKU KHÁC NHAU
  → State của SKU A không dùng được cho SKU D
  → KHÔNG có per-VU state hữu ích
```

Đây là lý do constant-vus phù hợp với session keepalive: nó cho phép mô hình hóa "1 user giữ 1 session trong thời gian dài", điều mà shared-iterations không làm được.

## Technical root causes this case catches

### Nguyên nhân kỹ thuật 1: Session pool pressure

15 active sessions gọi keepalive liên tục có thể lộ connection/session store pressure dù login đơn lẻ pass.

**Demo: 1 session vs 15 sessions cùng lúc**:

```text
Test A — 1 session đơn lẻ (VU=1, duration=30s):
  Chỉ 1 user login và keepalive
  → Auth service: 1 session trong store, 1 connection
  → Keepalive latency: 10ms
  → Login pass, keepalive pass
  → KẾT LUẬN SAI: "auth service OK"

Test B — 15 sessions đồng thời (VU=15, duration=30s):
  15 user cùng login và keepalive
  → Auth service: 15 sessions trong store, 15 connections
  → Session store có thể bị lock contention (15 session cùng read/write)
  → Connection pool có thể cạn (max connections = 10)
  → Keepalive latency: 200ms (20× chậm hơn test A)
  → Một số session bị drop do connection timeout
  → KẾT LUẬN ĐÚNG: "auth service không chịu được 15 sessions đồng thời"
```

**Cơ chế session pool pressure**:

```text
Khi 15 sessions cùng active:
  1. Session store (Redis/DB) bị 15 readers/writers đồng thời
     → Lock contention, queue depth tăng
     → Mỗi keepalive request chờ lock lâu hơn

  2. Connection pool giữa auth service và session store
     → Nếu pool size = 10, 5 sessions phải chờ connection
     → Keepalive latency tăng do chờ connection

  3. Token validation cache
     → 15 sessions × refresh mỗi 5 iteration = cache invalidation thường xuyên
     → Cache miss tăng → latency tăng

  4. Memory/CPU trên auth service
     → 15 concurrent requests xử lý đồng thời
     → Nếu auth service single-threaded hoặc thread pool nhỏ → queue
```

**Cách phát hiện**: so sánh latency của `session_me_keepalive` giữa run VU=1 và run VU=15. Nếu p95 tăng đáng kể khi VU=15, đó là session pool pressure.

### Nguyên nhân kỹ thuật 2: Refresh write path can fail while reads pass

`auth/me` là read path; refresh có db_writes/token rotation. Cần tách operation để không bị aggregate che.

**Demo refresh failure bị aggregate che**:

```text
Run 5 phút, 15 VUs, ~2000 iterations:
  session_me_keepalive: 2000 requests, 100% pass  ← READ path OK
  session_refresh: 400 requests, 10% fail         ← WRITE path FAIL

Nếu CHỈ nhìn aggregate:
  http_reqs = 2400
  http_req_failed = 40/2400 = 1.67%
  → Có vẻ "hơi fail nhưng dưới ngưỡng"
  → KẾT LUẬN SAI: "auth service OK, chỉ vài lỗi nhỏ"

Nếu TÁCH theo operation:
  session_me_keepalive: 2000/2000 pass (100%)     ← đẹp
  session_refresh: 360/400 pass (90%), 40 fail    ← CÓ VẤN ĐỀ
  → 10% refresh fail là NGHIÊM TRỌNG
  → Token rotation có vấn đề: user sắp hết hạn token, refresh fail
    → user bị logout giữa chừng
  → KẾT LUẬN ĐÚNG: "refresh write path có vấn đề, block release"
```

**Vì sao write path dễ fail hơn read path?**

```text
session_me_keepalive (GET /auth/me):
  - Đọc session state từ store
  - Không ghi gì
  - Có thể dùng cache, read replica
  → Read-only, ít rủi ro

session_refresh (POST /auth/refresh):
  - Validate refresh token
  - Tạo access token mới
  - Ghi refresh token mới vào store (token rotation)
  - Invalidate refresh token cũ
  - Có thể ghi audit log
  → Write-heavy, nhiều rủi ro:
    - DB write lock contention (15 sessions refresh gần nhau)
    - Token rotation atomicity (phải invalidate cũ + tạo mới trong 1 transaction)
    - Audit log insert có thể slow nếu bảng log lớn
```

**Cách phát hiện**: luôn tách metric theo tag `operation`. So sánh `session_me_keepalive` failed count và `session_refresh` failed count. Nếu refresh fail nhiều hơn keepalive, route về refresh/write pipeline.

### Nguyên nhân kỹ thuật 3: Login count and active session count are different

Login có thể chỉ xảy ra lúc setup/session start; active pressure nằm ở keepalive/refresh trong duration. Không được đọc `session_login` count như là "số session đang active".

**Demo sự khác biệt giữa login count và session count**:

```text
Run 5 phút, 15 VU, login logic: iter < VUS (chỉ login ở iter đầu mỗi VU)
  session_login: 15
  session_me_keepalive: ~2800
  session_refresh: ~560

Nếu learner đọc "session_login = 15":
  → "Chỉ có 15 lần login trong 5 phút? Auth service yếu vậy?"
  → SAI: 15 là số SESSIONS, không phải login throughput

Thực tế:
  - 15 sessions được tạo ở đầu test
  - Sau đó 2800 keepalive requests được gửi
  - Đây là session stability, không phải login benchmark

Nếu learner muốn đo login throughput:
  → Dùng constant-arrival-rate với operation chuyên login
  → KHÔNG dùng case này
```

**Login count qua các lần chạy**:

```text
Lần 1: duration=5m, VU=15, login logic: iter < VUS
  session_login = 15 (mỗi VU login 1 lần)

Lần 2: duration=30m, VU=15, login logic: iter < VUS
  session_login = 15 (vẫn 15, dù duration dài hơn!)
  → Vì login chỉ ở iter đầu, không phụ thuộc duration

Lần 3: duration=5m, VU=15, login logic: iter < VUS * 2 (re-login sau N vòng)
  session_login = 30 (mỗi VU login 2 lần)
  → Login count phụ thuộc logic script, không phải session health
```

**Cách đọc đúng**:
- `session_login` count cho biết script đã tạo bao nhiêu session mới
- 15 sessions active là từ VUs, không phải từ login count
- Đừng dùng login count để đánh giá auth throughput

### Nguyên nhân kỹ thuật 4: Stable user/session identity helps diagnosis

Dùng `user_id` tag giúp tìm một session/user lặp lại fail do token/state riêng.

**Demo giá trị của stable user identity trong diagnosis**:

```text
Run 5 phút, 15 VU, tag user_id=steady-user-{vuId}

Kịch bản: một vài iteration fail, không rõ nguyên nhân

Nếu KHÔNG có user_id tag:
  http_req_failed = 12/2400 = 0.5%
  → 12 requests fail, nhưng không biết:
    - Cùng 1 session fail 12 lần? Hay 12 session khác nhau mỗi session fail 1 lần?
    - Fail xảy ra ở đầu, giữa, hay cuối test?
    - Có pattern gì không?
  → KHÔNG diagnose được

Nếu CÓ user_id tag:
  Lọc failed requests theo user_id:
    steady-user-3: 8 fails   ← session này fail NHIỀU
    steady-user-7: 2 fails
    steady-user-12: 1 fail
    steady-user-15: 1 fail
    Còn lại 11 sessions: 0 fail

  → Pattern rõ ràng: steady-user-3 bị fail nhiều
  → Investigate: token của steady-user-3 có vấn đề gì?
    - Token được tạo lúc đầu test, có thể bị expire sớm?
    - Refresh token của user-3 bị lỗi từ iteration đầu?
    - DB record của user-3 bị corrupt?
  
  → Nếu không có user_id, 12 fails rải rác sẽ bị bỏ qua
    vì tỉ lệ 0.5% thấp. Nhưng với user_id, lộ ra 1 session
    fail 8 lần → vấn đề thật sự.
```

**Demo trace một session fail với user_id**:

```text
Timeline của steady-user-3 (VU=3):

t=0.0s   iter=0: login OK, keepalive OK, refresh OK
t=1.1s   iter=1: keepalive OK
t=2.2s   iter=2: keepalive OK
t=3.3s   iter=3: keepalive OK
t=4.4s   iter=4: keepalive OK
t=5.5s   iter=5: keepalive OK, refresh FAIL ← token rotation lỗi
t=6.6s   iter=6: keepalive FAIL (token hết hạn, refresh đã fail trước đó)
t=7.7s   iter=7: keepalive FAIL
t=8.8s   iter=8: keepalive FAIL
...
→ Sau khi refresh fail ở iter=5, tất cả keepalive sau đó đều fail
→ Đây là "cascade failure": 1 lỗi refresh → session chết hoàn toàn
→ Nếu không có user_id tag: 8 fails rải rác, không thấy cascade pattern
→ Với user_id tag: thấy rõ 1 session chết sau refresh fail
```

**Cách implement user_id tag**:

```js
// Trong common.js userContext():
export function userContext(seed) {
  return {
    vuId: exec.vu.idInTest,
    userId: `steady-user-${exec.vu.idInTest}`,  // ← stable per-VU
    // ...
  };
}

// Khi gọi API:
requestJson('GET', url, null, {
  // ...
  userId: ctx.userId,  // ← tag này theo request suốt 5 phút
});
```

## Service/API flow

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| session_login | auth-service | POST | /api/sim/auth/login | 200 | Login/start session. Chỉ gọi ở iteration đầu của mỗi VU. |
| session_me_keepalive | auth-service | GET | /api/sim/auth/me | 200 | Read session state repeatedly. Đây là operation chính, gọi mỗi iteration. |
| session_refresh | auth-service | POST | /api/sim/auth/refresh | 200 | Refresh token path. Gọi mỗi 5 iteration. Write path, dễ fail hơn read path. |

Các operation này phải được đọc bằng tag `operation`, vì aggregate metrics có thể che branch nhỏ nhưng chậm (refresh) hoặc branch nhỏ nhưng fail (refresh write path).

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
case_id       = cv-02-session-keepalive
business_case = logged_in_session_keepalive
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

Case-specific sanity checks:

```text
session_login count ≈ VUS (mỗi VU login 1 lần ở iteration đầu)
  - Nếu < VUS: có VU không login được → FAIL
  - Nếu > VUS: script cho phép re-login, kiểm tra logic

session_me_keepalive count ≈ iterations (mỗi iteration có 1 keepalive)
  - Nếu ít hơn đáng kể: có iteration bị skip keepalive → kiểm script

session_refresh count ≈ iterations / 5 (mỗi 5 iteration refresh 1 lần)
  - Tỉ lệ refresh fail quan trọng hơn count tuyệt đối
```

Không có expected exact count cho:

```text
iterations
http_reqs
RPS
iter/s
```

Chúng là observed outputs.

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-02-session-keepalive.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-02-session-keepalive.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-02-session-keepalive.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = constant-vus
vus = 15 hoặc env override
duration = 5m hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ expected counts và nhận thức lại observation window.

### Bước 2 — Verify active-user model

Summary/dashboard nên thể hiện VUs giữ gần configured VUs trong regular phase.

Nếu VUs không flat, kiểm config/ingestion trước khi kết luận backend.

Case-specific: VUs phải gần 15 trong suốt 5 phút. Nếu VUs chỉ đạt 8-10, session pool pressure chưa đạt yêu cầu → kết quả không đại diện cho 15 sessions.

### Bước 3 — Check failures trước throughput

Đọc trước:

```text
checks
http_req_failed
constant_active_iterations_failed
```

Nếu các metric này fail, xử lý correctness/failure trước khi bàn RPS.

Case-specific: tách `http_req_failed` theo `operation` để phân biệt:
- `session_me_keepalive` fail: vấn đề read path/session store
- `session_refresh` fail: vấn đề write path/token rotation
- `session_login` fail: không tạo được session → test invalid

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

Case-specific: so sánh `session_login` count với VUS. Nếu `session_login < VUS`, có VU không login được → FAIL (test invalid, không phải auth issue).

### Bước 5 — Interpret duration/throughput

Đọc:

```text
constant_flow_duration_ms
iteration_duration
http_req_duration by operation
```

Case-specific notes:

- `iterations` là số session loops hoàn tất, không phải số sessions.
- Refresh failures quan trọng hơn tổng RPS nếu business risk là token rotation.
- `constant_flow_duration_ms` tăng có thể do keepalive hoặc refresh; cần lọc operation.
- So sánh `http_req_duration` của `session_me_keepalive` và `session_refresh`: refresh thường chậm hơn (write path). Nếu keepalive chậm ngang refresh → session store có vấn đề.

## Đọc dashboard real-time charts cho case 02

> Phần này mô tả cách đọc expected dashboard. Chỉ thêm run ID/số p95/bucket thật sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? Refresh có chậm hơn keepalive không? | Total iterations target, vì không có target đó |
| Execution timeline | VUs/RPS/iter/s thay đổi theo time thế nào? Refresh có tạo spike không? | Business branch nào chậm nếu không lọc operation |
| VUs vs iter/s | VUs có flat không, iter/s có giảm không? | Fixed RPS target, vì constant-vus không config RPS |

Một cách đọc nhanh:

```text
Response time      -> chất lượng từng operation, phát hiện refresh bottleneck
Execution timeline -> session activity theo thời gian, phát hiện VUs không phẳng
VUs vs iter/s      -> closed-model signal, phát hiện auth backpressure
```

### Chart 1 — Response time

Đây là request-level latency. Với case này, đọc theo `operation`:

```text
session_login: POST /api/sim/auth/login
session_me_keepalive: GET /api/sim/auth/me
session_refresh: POST /api/sim/auth/refresh
```

Cách đọc:

```text
http_req_duration       = latency từng request
constant_flow_duration_ms = latency full user loop
iteration_duration      = duration vòng default(), thường bao gồm sleep
```

Đừng dùng aggregate p95 một mình trong mixed/multi-operation flow.

#### Cách phân tích sâu chart Response time

Khi nhìn chart này, đừng chỉ nhìn "cao/thấp". Hãy đọc theo 4 câu hỏi:

```text
1. Keepalive latency có ổn định suốt 5 phút không?
2. Refresh latency có cao hơn keepalive không? (expected: có, vì write path)
3. Có operation nào có p95 spike bất thường không?
4. Spike xảy ra ở tất cả operation hay chỉ 1 operation?
```

Với case 02, shape đẹp thường có:

```text
đầu run: session_login p95 có thể cao hơn (cold start, tạo 15 session đồng thời)
giữa run: keepalive p95 ổn định thấp, refresh p95 cao hơn keepalive
cuối run: p95 không tăng bất thường (session store không bị phình)
```

Vì sao refresh p95 thường cao hơn keepalive?

```text
session_me_keepalive: GET, read-only, có thể cache
session_refresh: POST, write (token rotation, invalidate token cũ, audit log)
→ Write path luôn chậm hơn read path
→ Refresh p95 > keepalive p95 là EXPECTED
→ Nhưng nếu refresh p95 cao gấp 5-10× keepalive → cần investigate write pipeline
```

Case-specific bottleneck hints:

- `session_me_keepalive` latency tăng dần theo thời gian: session store bị phình (nhiều session, lookup chậm dần).
- `session_refresh` latency spike định kỳ: token rotation transaction lock contention (nhiều session refresh cùng lúc).
- `session_login` p95 cao: auth service cold start hoặc connection pool init.
- Cả 3 operation cùng tăng: auth service quá tải toàn diện.

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| keepalive p95 tăng dần theo thời gian | session store phình, lookup chậm dần | kiểm session store size, index |
| refresh p95 spike định kỳ | token rotation lock contention | kiểm refresh transaction isolation |
| refresh fail nhưng keepalive pass | write path lỗi, read path OK | block, investigate refresh pipeline |
| keepalive p95 cao ngay từ đầu | session store cold, connection pool chưa warm | kiểm pool size, cache warm-up |
| login p95 spike đơn lẻ ở đầu | 15 session tạo đồng thời | expected, nhưng nếu quá cao → kiểm rate limit |
| cả 3 operation cùng tăng đột ngột | auth service crash/restart/OOM | investigate auth service health |

### Chart 2 — Execution timeline

Chart này chứng minh session activity ổn định theo thời gian.

Với constant-vus:

```text
VUs should be flat near 15 during regular phase.
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

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs — có phẳng ở 15 suốt 5 phút không?
2. HTTP reqs mỗi bucket — có sự khác biệt giữa bucket có refresh và bucket không refresh?
3. Iterations hoàn thành mỗi bucket — có giảm dần theo thời gian không?
```

Với constant-vus session keepalive, shape "đẹp" thường là:

```text
đầu run:
  Live VUs = 15 (tất cả session bắt đầu)
  RPS ổn định sau vài giây đầu (warm-up)

giữa run:
  Live VUs vẫn = 15 (phẳng)
  HTTP reqs/bucket dao động nhẹ (refresh mỗi 5 iter tạo thêm request)
  iterations tăng đều theo bucket

cuối run:
  Live VUs vẫn = 15 (đến khi duration hết)
  gracefulStop có thể tạo end-tail shape
```

Refresh spike pattern:

```text
Với script refresh mỗi 5 iteration:
  Mỗi VU refresh ở iter 0, 5, 10, 15, 20, ...
  
  Khi 15 VU bắt đầu cùng lúc:
    iter=0: 15 refresh requests cùng lúc (spike)
    iter=5: 15 refresh requests cùng lúc (spike sau ~5×1.05s ≈ 5.25s)
    iter=10: 15 refresh requests cùng lúc (spike sau ~10.5s)
    
  → Refresh tạo spike ĐỊNH KỲ trong execution timeline
  → Đây là expected, nhưng nếu spike quá cao và gây latency tăng
    → auth service không xử lý được 15 refresh đồng thời
```

Invalid patterns:

| Pattern | Nghĩa |
| --- | --- |
| VUs không đạt 15 từ đầu | config/env sai, VU init lỗi |
| VUs tụt giữa chừng | VU bị crash/exception, script lỗi |
| VUs giữ 15 nhưng iterations = 0 kéo dài | VU bị kẹt trong request (auth quá chậm hoặc timeout) |
| RPS giảm dần dù VUs flat | closed-model backpressure (session loop chậm dần) |
| Refresh spike biến mất sau vài phút | script logic thay đổi hoặc VU bị skip refresh |
| `http_req_failed` spike ở bucket cụ thể | auth service có vấn đề ở thời điểm đó |

#### Batch 1 giây / time bucket

Mỗi point trên chart là 1 time bucket gom tất cả metric samples trong cùng 1 giây:

```text
01:09:19
→ mọi sample có timestamp trong khoảng 01:09:19.000 -> 01:09:19.999
→ được gom vào chung 1 point trên chart
```

Trong 1 bucket đó có thể có:

```text
- 15 VU cùng chạy (mỗi VU đang ở 1 iteration khác nhau)
- Nhiều HTTP request hoàn thành (keepalive + refresh nếu iter % 5)
- Một số iteration hoàn thành
- Nhiều check pass/fail
```

#### Vì sao bucket đầu có thể có httpReqs > 0 nhưng iterations = 0?

```text
Bucket đầu: VU vừa start, keepalive request đầu đã xong
nhưng full iteration (login + keepalive + check + sleep) chưa hoàn tất

→ httpReqs > 0 (request-level metric đến sớm)
→ iterations = 0 (iteration-level metric đến muộn hơn, cần full loop xong)
```

### Chart 3 — VUs vs iter/s

Chart này là trọng tâm của executor này.

Expected:

```text
VUs: flat near configured value
iter/s: dao động theo backend latency + think time + branch mix
```

#### Cách phân tích sâu chart VUs vs iter/s

Chart này trả lời câu hỏi:

```text
Session pool có giữ được 15 sessions phẳng không?
Throughput iteration có bám theo shape VU không?
Có closed-model backpressure signal không?
```

Với constant-vus session keepalive, đường `Executor VUs` và `Actual iter/s` có quan hệ:

```text
peak_rate ≈ vus / loop_duration
         ≈ 15 / loop_duration

Nếu loop_duration avg = 1.05s (50ms API + 1s sleep):
  peak_rate ≈ 15 / 1.05 ≈ 14.3 iter/s

Nếu loop_duration avg = 1.5s (500ms API + 1s sleep):
  peak_rate ≈ 15 / 1.5 ≈ 10 iter/s

Nếu loop_duration avg = 4.0s (3s API + 1s sleep):
  peak_rate ≈ 15 / 4.0 ≈ 3.75 iter/s
```

Shape mong đợi:

```text
- đầu run: iter/s tăng nhanh khi 15 VU bắt đầu loop
- giữa run: iter/s dao động nhẹ, phụ thuộc loop duration
- cuối run: iter/s có thể biến động ở gracefulStop
- đường VUs: phẳng ở 15 trong suốt regular phase
```

Bad shapes:

| Shape | Nghĩa |
| --- | --- |
| VUs flat, iter/s slowly falling | Backend/flow duration tăng, closed-model backpressure |
| VUs not flat | Scenario/config/dashboard issue cần kiểm trước |
| iter/s spike/drop theo branch | Weighted branch hoặc dependency latency thay đổi |
| end-tail odd shape | duration/gracefulStop/end bucket effect |
| VUs flat, iter/s rất thấp (< 3 với sleep=1s) | Auth service quá chậm, cần investigate |
| VUs flat nhưng iter/s = 0 từng đoạn | VU bị kẹt trong request (timeout hoặc treo) |

Điểm khác biệt với case 01 (storefront):

```text
Case 01 (storefront): weighted mix 70/25/5, iter/s dao động do branch mix
Case 02 (session): flow đơn giản hơn (keepalive + optional refresh)
  → iter/s ổn định hơn (không có branch nặng như checkout)
  → Nhưng refresh mỗi 5 iter có thể tạo pattern nhỏ trong iter/s
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

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **session stability gate**: output ra số như vậy thì team auth quyết định gì với việc deploy session/token rotation?

### Kịch bản A — Output sạch: SESSION HEALTHY

```text
VUs................: 15 phẳng suốt 5m
iterations.........: ~2800 (observed, không phải target)
http_req_failed....: 0.02%
checks.............: 99.8%
constant_active_iterations_failed: 3 (< 10)
session_login......: 15
session_me_keepalive: ~2800
session_refresh.....: ~560
http_req_duration {operation:session_me_keepalive}: p(95)=45ms
http_req_duration {operation:session_refresh}: p(95)=120ms
```

Kết luận thực tế:

```text
- 15 sessions phẳng suốt 5 phút → concurrency đúng yêu cầu (a)
- 3 failed iterations / 2800 → tỉ lệ fail 0.1% → chấp nhận được
- Keepalive p95=45ms, Refresh p95=120ms → read nhanh, write chậm hơn (expected)
- Refresh count ~560, không có fail đáng kể → token rotation OK
- session_login=15 → mỗi session login 1 lần, đúng mô hình
=> QUYẾT ĐỊNH: auth session stability OK. Cho phép deploy session/token rotation.
```

### Kịch bản B — Refresh failures: BLOCK

```text
VUs................: 15 phẳng suốt 5m
iterations.........: ~2800
http_req_failed....: 1.8%
checks.............: 98.2%
constant_active_iterations_failed: 42 (> 10, FAIL)
session_me_keepalive: 2800 requests, 0.1% fail
session_refresh.....: 560 requests, 7% fail ← REFRESH FAIL
```

Kết luận thực tế:

```text
- VUs vẫn phẳng 15 → không phải lỗi test
- Nhưng refresh fail 7% → 39/560 refresh requests fail
- Keepalive chỉ fail 0.1% → read path OK, write path FAIL
- constant_active_iterations_failed = 42 > 10 → vượt threshold
→ Đây là tín hiệu THẬT: token rotation có vấn đề
=> QUYẾT ĐỊNH: BLOCK deploy. Investigate refresh/token rotation pipeline.
   Nếu refresh fail, user sẽ bị logout khi token hết hạn.
   Dù keepalive vẫn pass, session sẽ chết sau khi token expire.
```

### Kịch bản C — Keepalive latency grows: INVESTIGATE

```text
VUs................: 15 phẳng suốt 5m
iterations.........: giảm từ ~2800 → ~1800 (giảm 36%)
http_req_failed....: 0.1% (vẫn thấp!)
constant_active_iterations_failed: 5 (vẫn pass)
http_req_duration {operation:session_me_keepalive}: p(95)=350ms ← TĂNG
http_req_duration {operation:session_refresh}: p(95)=180ms (bình thường)
```

Kết luận thực tế:

```text
- VUs phẳng, http_req_failed vẫn thấp → không có lỗi HTTP
- Nhưng keepalive p95=350ms (tăng ~8× so với baseline 45ms)
- iterations giảm 36% → closed-model backpressure signal
- Refresh p95 vẫn bình thường → chỉ read path bị ảnh hưởng
→ Session store read path đang chậm (cache miss? index? lock?)
=> QUYẾT ĐỊNH: INVESTIGATE session store read path trước khi kết luận pass/fail.
   Đây là tín hiệu sớm: session store đang degrade.
   Nếu không fix, có thể dẫn đến timeout khi nhiều sessions hơn.
```

### Kịch bản D — iter/s drops (closed-model backpressure): INVESTIGATE AUTH

```text
VUs................: 15 phẳng suốt 5m
iterations.........: giảm từ ~2800 → ~700 (giảm 75%!)
iter/s.............: giảm từ ~9.3 → ~2.3
http_req_failed....: 0.05% (vẫn rất thấp!)
checks.............: 99.9%
http_req_duration {operation:session_me_keepalive}: p(95)=2800ms
http_req_duration {operation:session_refresh}: p(95)=3500ms
```

Kết luận thực tế:

```text
- VUs vẫn phẳng 15 → test infrastructure OK
- http_req_failed thấp → không có lỗi protocol
- Nhưng iter/s giảm 75% → CLOSED-MODEL BACKPRESSURE MẠNH
- Keepalive p95=2800ms → auth service RẤT CHẬM
- Refresh p95=3500ms → write path còn chậm hơn
→ Auth service đang bị quá tải hoặc có vấn đề nghiêm trọng
=> QUYẾT ĐỊNH: INVESTIGATE auth service ngay.
   Dù không có HTTP failures, latency 2.8s cho keepalive là không chấp nhận được.
   Đây là giá trị của closed model: VUs phẳng + iter/s giảm = auth backpressure.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| keepalive/refresh pass under flat VUs | Auth steady sessions healthy | Accept baseline |
| refresh failures | Token rotation/write issue | Block auth release |
| keepalive latency grows | Auth read/session store issue | Inspect session store |
| VUs flat but iter/s drops | Auth latency/backpressure | Investigate operation p95 |
| session_login < VUS | Không tạo đủ session → test invalid | Kiểm auth service, chạy lại |
| session_login > VUS | Script re-login (có thể không mong muốn) | Kiểm login logic trong script |
| refresh count << iterations/5 | Refresh bị skip (có thể do fail sớm) | Kiểm refresh logic và failures |
| VUs không flat | Test infrastructure/config vấn đề | Sửa config trước khi kết luận auth |

Điểm cốt lõi của case này: **vì VUs luôn phẳng 15 và duration luôn 5 phút, mọi thay đổi ở iter/s, latency, và failure rate đều là tín hiệu THẬT về auth service, không bị nhiễu bởi "lần này test chạy ít/mất concurrency hơn lần trước"**. Đó là lý do session stability gate dùng constant-vus.

## Real run — default constant-vus baseline after X-User-ID header

Run verify qua local cloud/dashboard sau khi k6 helper gửi `X-User-ID: ctx.userId`:

```text
Run ID: #82
Script: cv-02-session-keepalive.js
Exit code: 0
summary_pushed: true
finish_status: 200
Config: 15 VUs, duration 5m, default sleep/env
```

### Summary chính

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes/checks_fails` | `5,379 / 0` |
| `http_req_failed_rate` | `0` |
| `iterations` | `4,470` |
| `iterations_rate` | `14.87/s` |
| `http_reqs` | `5,379` |
| `http_reqs_rate` | `17.90/s` |
| `vus_min/vus_max` | `15 / 15` |
| `constant_flow_duration_ms avg/med/p95/p99/max` | `7.90 / 3 / 26 / 28 / 155 ms` |
| `http_req_duration avg/med/p95/p99/max` | `6.49 / 2.68 / 23.03 / 24.90 / 105.53 ms` |

Request breakdown:

```text
session_me_keepalive GET 200 count=4,470
session_refresh POST 200 count=894
session_login POST 200 count=15
```

### Đọc 3 chart dashboard cho run #82

**Chart 1 — Response time.** `http_req_duration` p95 ~23.03ms, p99 thấp; `constant_flow_duration_ms` p95 ~26ms trước sleep 1s. Login/keepalive/refresh đều sạch.

**Chart 2 — Execution timeline.** `iterations` sum 4,470 và `http_reqs` sum 5,379. Breakdown đúng mô hình: login 15, keepalive 4,470, refresh 894 (~iterations/5).

Dashboard/API bucket summary:

```text
iterations buckets: count=300, sum=4470, min=10.00, max=15.00
http_reqs buckets:  count=300, sum=5379, min=12.00, max=33.00
không có failed iteration buckets
```

**Chart 3 — VUs vs iter/s.** VUs flat đúng 15 trong 300 buckets. Iter/s dao động 10–15 iter/s, phù hợp sleep 1s và refresh định kỳ.

```text
vus buckets: count=300, min=15.00, max=15.00, avg=15.00
```

### Backend verdict

```text
PASS — không thấy vấn đề BE trong run này.
```

Không cần báo BE.

## "Nghịch lý" và misconceptions của constant-vus

### Nghịch lý 1: "15 sessions active mà total iterations có ~2800 thôi á?"

```text
"15 sessions, mỗi session keepalive mỗi 1 giây,
 5 phút = 300 giây, lẽ ra 15 × 300 = 4500 iterations chứ?"

Trả lời: Vì sleep(1s) là think time GIỮA các lần keepalive,
nhưng bản thân keepalive request cũng tốn thời gian.
Loop duration = API time + sleep time, không phải chỉ sleep.

Công thức:
  loop_duration = keepalive_latency + (refresh_latency nếu iter % 5) + sleep + JS overhead
  
  Với keepalive 50ms, refresh 120ms:
    Loop không refresh: 50ms + 1s + ~5ms JS ≈ 1.055s
    Loop có refresh: 50ms + 120ms + 1s + ~5ms JS ≈ 1.175s
    
    Trung bình 5 loop: (4 × 1.055s + 1 × 1.175s) / 5 ≈ 1.079s
  
  iterations mỗi VU = 300s / 1.079s ≈ 278
  Tổng iterations = 15 × 278 ≈ 4170

  Với keepalive 500ms (auth chậm):
    Loop không refresh: 500ms + 1s ≈ 1.5s
    Loop có refresh: 500ms + 120ms + 1s ≈ 1.62s
    Trung bình: (4 × 1.5 + 1 × 1.62) / 5 ≈ 1.524s
    
    iterations mỗi VU = 300s / 1.524s ≈ 197
    Tổng iterations = 15 × 197 ≈ 2955  ← GIẢM 29%

→ Iterations phụ thuộc vào auth latency, không phải hằng số.
→ Đây là TÍN HIỆU, không phải "test chạy thiếu".
```

### Nghịch lý 2: "Login pass hết mà sao session fail?"

```text
"session_login = 15/15 pass (100%)
 sao constant_active_iterations_failed = 8?"

Trả lời: Login chỉ xảy ra ở iteration đầu tiên của mỗi VU.
Sau đó, mỗi VU chạy keepalive + refresh LIÊN TỤC trong 5 phút.
Login pass không đảm bảo keepalive/refresh pass ở iteration sau.

Timeline một session bị fail:
  iter=0:  login OK, keepalive OK, refresh OK     ← login pass
  iter=1:  keepalive OK
  iter=2:  keepalive OK
  ...
  iter=15: keepalive OK, refresh FAIL             ← token rotation lỗi
  iter=16: keepalive FAIL (token đã hết hạn)      ← session chết
  iter=17: keepalive FAIL
  ...

→ Login pass 1 lần, nhưng session fail từ iteration 15 trở đi
→ constant_active_iterations_failed tăng, dù session_login vẫn 15/15
→ Đây là lý do case này đo SESSION HEALTH, không phải LOGIN SUCCESS RATE
```

### Nghịch lý 3: "Refresh ít hơn keepalive (mỗi 5 iter) nhưng p95 cao hơn?"

```text
"session_refresh: 560 requests, p95=250ms
 session_me_keepalive: 2800 requests, p95=35ms

 Refresh ít hơn 5× mà p95 cao hơn 7×? Sao lạ vậy?"

Trả lời: Refresh là WRITE PATH, keepalive là READ PATH.
Write path luôn chậm hơn read path, không liên quan đến số lượng request.

Cụ thể:
  session_me_keepalive:
    - GET request, read-only
    - Có thể cache (session store cache, CDN)
    - Không cần transaction
    → Nhanh

  session_refresh:
    - POST request, write
    - Cần transaction: validate refresh token + tạo access token mới
      + ghi refresh token mới + invalidate token cũ
    - Có thể ghi audit log
    - Token rotation cần atomicity → lock/serializable isolation
    → Chậm hơn, và latency dễ bị ảnh hưởng bởi lock contention

Khi 15 sessions refresh cùng lúc (iter % 5):
  - 15 transactions cùng chạy trên session store
  - Lock contention: transaction này chờ transaction kia release lock
  - p95 tăng do 1-2 transaction phải chờ lâu nhất

→ Refresh p95 cao hơn keepalive là EXPECTED
→ Nhưng nếu refresh p95 cao gấp 10× keepalive → write path có vấn đề
```

Đừng dùng case này để đo login throughput tối đa. Nó đo active session health, không phải login RPS benchmark.

Nhớ 3 câu:

```text
vus + duration = input
iterations/RPS = output
backend chậm -> RPS giảm là tín hiệu đúng của closed model
```

## Checklist đọc biểu đồ case 02

Khi học sinh nhìn dashboard case 02, đọc theo thứ tự này:

```text
1. Overview KPI
   - VUs có phẳng gần 15 không?
   - http_req_failed < 1%?
   - checks > 99%?
   - constant_active_iterations_failed < 10?

2. Response time chart
   - Tách theo operation (login vs keepalive vs refresh) chưa?
   - Refresh p95 có cao hơn keepalive không? (expected: có)
   - Keepalive p95 có tăng dần theo thời gian không?
   - Refresh p95 có spike định kỳ không?
   - Login p95 có bất thường không?

3. Execution timeline
   - Live VUs đầu có = 15 không?
   - Live VUs có phẳng suốt 5 phút không?
   - HTTP reqs/bucket có ổn định không?
   - Có refresh spike định kỳ không? (expected: có mỗi ~5s)
   - http_req_failed có spike ở bucket cụ thể không?

4. VUs vs iter/s
   - VUs có flat ở 15 không?
   - iter/s có dao động nhẹ theo loop duration không?
   - iter/s có giảm dần theo thời gian không? (nếu có → auth backpressure)
   - iter/s có = 0 từng đoạn không? (nếu có → VU bị kẹt)

5. Business decision
   - Tất cả counters pass?
   - Refresh failure rate có chấp nhận được không?
   - Keepalive latency có ổn định không?
   - iter/s có giảm bất thường không?
   - Nếu tất cả pass → session stability PASS
```

Kết luận của run case 02 đang đúng nếu thấy:

```text
VUs phẳng = 15 suốt 5 phút
http_req_failed < 1%
checks > 99%
constant_active_iterations_failed < 10
session_login ≈ 15
session_me_keepalive count ≈ iterations
session_refresh count ≈ iterations / 5
http_req_duration {operation:session_refresh} > http_req_duration {operation:session_me_keepalive}
iter/s ổn định, không giảm mạnh theo thời gian
executor = constant-vus
```

## Mở rộng / variation

### Variation A: Thay đổi refresh interval để test token rotation load

```powershell
# Refresh mỗi 3 iteration thay vì 5 (tăng tần suất refresh)
# Sửa script: if (ctx.iter % 3 === 0) { ... refresh ... }

$env:BASE_URL = "http://localhost:80"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-02-session-keepalive.js
```

Mục đích: tăng áp lực lên refresh/write path để tìm bottleneck sớm hơn.

### Variation B: Tăng VUs để tìm session capacity limit

```powershell
$env:CV_02_VUS = 50
$env:CV_02_DURATION = "5m"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-02-session-keepalive.js
```

Mục đích: tìm ngưỡng session pool mà auth service bắt đầu degrade.
Quan sát: VUs có còn flat ở 50 không? Keepalive latency có tăng đột biến không?
Refresh failure có tăng không?

### Variation C: Thêm threshold latency theo operation

```js
export const options = {
  thresholds: {
    "http_req_duration{operation:session_me_keepalive}": ["p(95)<100"],
    "http_req_duration{operation:session_refresh}": ["p(95)<300"],
    "http_req_duration{operation:session_login}": ["p(95)<500"],
  },
};
```

Mục đích: chuyển từ functional test sang performance gate. Nếu keepalive p95 vượt 100ms, test fail (dù HTTP status vẫn 200).

### Variation D: Tăng duration để thành session soak test

```powershell
$env:CV_02_DURATION = "30m"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-02-session-keepalive.js
```

Mục đích: kiểm tra session health trong thời gian dài. Quan sát:
- Session store có bị phình không? (keepalive latency tăng dần)
- Token rotation có hoạt động ổn định qua nhiều chu kỳ refresh không?
- Có memory leak trong auth service không?

### Variation E: Giảm sleep để tăng keepalive frequency

```powershell
$env:CV_02_SLEEP_SECONDS = 0.2
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-02-session-keepalive.js
```

Mục đích: mô phỏng app aggressive keepalive (gọi keepalive thường xuyên hơn).
Quan sát: iter/s tăng, nhưng auth service có bị quá tải không?
Keepalive latency có tăng do request rate cao hơn không?

## Anti-pattern

- Dùng total `iterations` như pass/fail target cứng.
- Kỳ vọng fixed RPS từ `constant-vus`.
- So sánh 2 run có sleep/duration/VUs khác nhau rồi kết luận backend regress.
- Chỉ nhìn aggregate p95 trong flow nhiều operation (bỏ qua refresh failure).
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với per-user quota của `per-vu-iterations`.
- Đọc `session_login` count như là auth throughput.
- Không tách operation khi đọc failures (aggregate che refresh failure).
- Không tag `user_id` rồi không diagnose được session-specific failure.
- Login lại mỗi iteration (biến session keepalive thành login benchmark).
- Dùng `exec.scenario.iterationInTest` làm user identity thay vì `exec.vu.idInTest`.
- Cho rằng refresh p95 cao hơn keepalive là bất thường (write path luôn chậm hơn read path).
- Fail test vì "iterations không đủ nhiều" mà không kiểm tra auth latency trước.
- Dùng constant-arrival-rate rồi thắc mắc "sao auth chậm mà RPS vẫn giữ được?" (vì arrival-rate bơm thêm).

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Constant-vus quick index: `../../20260516_01_constant-vus-quick-index.md`
- Tham số/công thức: `../../20260516_02_constant-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-02-session-keepalive.js`
