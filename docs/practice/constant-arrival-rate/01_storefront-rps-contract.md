# Case 01: Storefront RPS contract

## Tình huống thực tế

Storefront là mặt tiền của hệ thống e-commerce. Khi người dùng mở mobile app hoặc
truy cập web, request đầu tiên gần như luôn là **browse/list sản phẩm** -- xem
danh sách hàng hóa theo danh mục, tìm kiếm, sắp xếp, lọc. Đây là traffic lớn nhất,
ổn định nhất, và cũng là traffic **phải chịu được theo contract với business**.

### Contract kinh doanh là gì?

Trong hệ thống production, team infrastructure thường ký một **Service Level
Agreement (SLA)** hoặc **RPS contract** với business:

```text
"Products service sẽ xử lý 20 browse/list arrivals mỗi giây,
 liên tục trong 45 giây, với tỉ lệ lỗi < 1% và không drop request."
```

Đây không phải là "ước lượng" -- đây là **cam kết**. Nếu service không giữ được
contract này, hậu quả kinh doanh có thể là:

```text
- Người dùng thấy spinner quay mãi -> thoát app -> mất sale
- CDN timeout trả về lỗi -> user nghĩ app "sập" -> uninstall
- Traffic bị drop ở load balancer -> mất data analytics -> báo cáo sai
- Promotion campaign (vd Black Friday) đổ traffic -> service sập ngay phút đầu
```

### Vì sao câu hỏi đúng là "arrivals/s", không phải "bao nhiêu user"?

Team business và infrastructure không hỏi:

```text
"Có bao nhiêu user đang online cùng lúc?"
"Có bao nhiêu session đang mở?"
"Mỗi user browse bao nhiêu sản phẩm?"
```

Họ hỏi đúng một câu:

```text
"Products service có chịu được 20 arrivals/s trong 45s không?"
```

Lý do: traffic từ bên ngoài (CDN, mobile app, web client) đến theo **nhịp cố
định**, không phụ thuộc vào việc backend đang nhanh hay chậm. Người dùng không
"chờ backend xong rồi mới gửi request tiếp" -- họ scroll, tap, vuốt liên tục.

```text
                        Mobile App
                            |
                            v
    [CDN / API Gateway] ---------> Products Service
                            |
                arrivals/s = 20 (contract)
                KHÔNG đợi response mới gửi tiếp
```

### Hệ quả của việc chọn sai executor

Nếu dùng `constant-vus` (closed model) để test contract này:

```text
Tình huống: Backend products service bị chậm (cache miss, DB lock)

constant-vus với vus=12:
  Mỗi VU: gửi request -> đợi response -> gửi request tiếp
  Khi backend chậm (response time tăng từ 4ms lên 50ms):
    - Mỗi VU loop chậm hơn -> throughput TỰ GIẢM
    - 12 VUs / 0.05s = 240 req/s -> thực tế chỉ đạt ~200 req/s
    - Test báo "pass" vì không có lỗi gì
    - NHƯNG: contract yêu cầu 20 arrivals/s, không phải "tùy backend nhanh chậm"

  -> Test không phát hiện được contract breach!
  -> Lên production: 20 arrivals/s thật từ CDN -> backend chậm -> queue đầy ->
     timeout -> 502 Bad Gateway -> user thấy lỗi
```

Đây là **lỗi cơ bản nhất** khi chọn executor: dùng closed model để test open-model
traffic.

## 2 yêu cầu cốt lõi

Case này có **2 yêu cầu cốt lõi** mà chỉ `constant-arrival-rate` mới thỏa mãn
được đồng thời.

### Yêu cầu (a): GIỮ INGRESS RATE CỐ ĐỊNH (fixed arrival rate)

**Ý nghĩa**: K6 phải bắt đầu iteration mới theo đúng nhịp `rate/timeUnit`, bất kể
backend đang nhanh hay chậm. Đây là điều kiện tiên quyết để test RPS contract.

**Ví dụ cụ thể**:

```text
Config: rate=20, timeUnit=1s, duration=45s

Timeline 45 giây:
  t=0.00s: slot #0   được schedule, bắt đầu event
  t=0.05s: slot #1   được schedule, bắt đầu event
  t=0.10s: slot #2   được schedule, bắt đầu event
  t=0.15s: slot #3   được schedule, bắt đầu event
  ...
  t=0.95s: slot #19  được schedule, bắt đầu event
  t=1.00s: slot #20  được schedule, bắt đầu event (giây thứ 2)
  ...
  t=44.95s: slot #899 được schedule, bắt đầu event

Tổng: 20 slots/s × 45s = 900 slots được schedule
```

Điểm quan trọng: các slot được schedule **đúng giờ**, không phụ thuộc vào việc
slot trước đã xong hay chưa. Giống như:

```text
Xe bus chạy đúng lịch mỗi 3 phút.
Dù hành khách lên/xuống chậm -> bus vẫn phải rời bến đúng giờ.
Nếu tài xế không có mặt -> chuyến đó bị hủy (= dropped_iterations).
```

**Kiểm chứng với số liệu thật từ Run 89**:

```text
rate = 20/s, duration = 45s
scheduled_slots = 20 × 45 = 900
iterations thực tế = 900
dropped_iterations = 0
interrupted_iterations = 0

=> N_sched = N_done + N_drop + N_int = 900 + 0 + 0 = 900
=> Contract giữ được 100%
```

### Yêu cầu (b): PHÁT HIỆN CONTRACT BREACH QUA dropped_iterations

**Ý nghĩa**: Khi backend không đủ capacity để xử lý 20 arrivals/s, test phải
**báo lỗi rõ ràng** qua `dropped_iterations`, không được "im lặng pass" như
closed model.

**Ví dụ cụ thể**:

```text
Tình huống: Backend bị chậm đột ngột (database lock 200ms)

Với constant-vus (closed model):
  - VU loop chậm hơn -> throughput tự giảm
  - Test vẫn pass (không có error, không có drop)
  - KHÔNG phát hiện được vấn đề

Với constant-arrival-rate (open model):
  - Slot vẫn đến đúng giờ (20/s)
  - Backend chậm -> mỗi event tốn nhiều thời gian hơn
  - Cần nhiều VU hơn để giữ nhịp
  - VU pool cạn -> slot không có worker -> dropped_iterations++
  - Test FAIL -> phát hiện được contract breach
```

**Kiểm chứng với số liệu thật**:

Case `car-05` trong cùng series là ví dụ điển hình:

```text
car-05 report API (Run 93):
  rate = 6/s, duration = 45s
  scheduled_slots = 270
  iterations thực tế = 249
  dropped_iterations = 22
  event p95 = 7950 ms

  => Contract breach được phát hiện!
  => dropped_iterations = 22 > maxDroppedIterations = 0 -> FAIL
```

Trong khi nếu dùng `constant-vus` cho car-05, test có thể vẫn pass vì throughput
tự giảm -- nhưng lên production với 6 arrivals/s thật thì service sẽ sập.

### Tại sao cả 2 yêu cầu phải thỏa mãn ĐỒNG THỜI?

```text
Nếu CHỈ có (a) mà không có (b):
  - Arrival rate cố định nhưng không có cơ chế báo breach
  - Giống như đồng hồ báo thức reo đúng giờ nhưng không ai nghe

Nếu CHỈ có (b) mà không có (a):
  - Có báo lỗi nhưng arrival rate không cố định
  - Không test được đúng RPS contract
  - Giống như báo cháy nhưng không có lửa

Cả 2 cùng có -> constant-arrival-rate là executor DUY NHẤT thỏa mãn.
```

## Vì sao chọn `constant-arrival-rate`?

### So sánh 5 executor

Bảng dưới đây so sánh tất cả executor mà k6 cung cấp, phân tích vì sao mỗi cái
**không phù hợp** cho case RPS contract:

| Executor | Model | Cách hoạt động | Vì sao KHÔNG phù hợp cho RPS contract? |
| --- | --- | --- | --- |
| **constant-arrival-rate** | Open | Schedule iteration theo rate/timeUnit cố định. VU là worker pool. | **PHÙ HỢP**: ingress rate cố định độc lập với backend latency. Drop báo contract breach. |
| constant-vus | Closed | Giữ N VU chạy liên tục trong duration. Mỗi VU loop: gửi request -> đợi -> gửi tiếp. | Backend chậm -> VU loop chậm -> throughput tự giảm. Không phát hiện contract breach. KHÔNG test được RPS cố định. |
| shared-iterations | Closed | Chia N iterations cho M VUs. VU nào xong trước nhận iteration tiếp. | Tổng iteration cố định, nhưng rate phụ thuộc VU speed. Không có schedule. Không test được "20/s liên tục". |
| per-vu-iterations | Closed | Mỗi VU chạy đúng K iterations. Không chia sẻ. | Count cố định nhưng rate không kiểm soát. Dùng để regression test (input giống nhau qua các release), không phải RPS contract. |
| ramping-vus | Closed | Tăng/giảm số VU theo stage. Throughput phụ thuộc VU count và loop time. | VU count thay đổi theo stage, nhưng throughput vẫn phụ thuộc latency. Không giữ được rate cố định. |

### Phân tích sâu: vì sao constant-vus "im lặng pass" là nguy hiểm nhất?

Đây là **anti-pattern nguy hiểm nhất** mà team thường mắc phải. Hãy xem xét kỹ:

```text
Config constant-vus: vus=12, duration=45s

Case A: Backend khỏe (response time avg = 4ms)
  Throughput = 12 VUs / 0.004s = 3000 req/s
  Test pass -> contract 20/s chắc chắn đạt

Case B: Backend yếu (response time avg = 80ms, do cache miss)
  Throughput = 12 VUs / 0.080s = 150 req/s
  Test VẪN PASS (không có error, không có drop)
  NHƯNG: contract yêu cầu giữ 20/s khi backend chậm
  Với 150 req/s ở 12 VU, mỗi VU xử lý 12.5 req/s
  -> 20 arrivals/s thật -> cần 20/12.5 × 12 = 19.2 VU
  -> 12 VU không đủ -> queue đầy -> 502

  => Test pass nhưng production fail!
  => Đây là "false positive" nguy hiểm nhất
```

**Với constant-arrival-rate**:

```text
Config: rate=20/s, timeUnit=1s, duration=45s, preAllocatedVUs=12, maxVUs=30

Case A: Backend khỏe (response time avg = 4ms)
  Mỗi event tốn ~4ms -> 1 VU xử lý được 250 events/s
  Cần tối thiểu: ceil(20 × 0.004) = 1 VU
  Có 12 VU preAllocated -> dư dả
  dropped_iterations = 0 -> PASS

Case B: Backend yếu (response time avg = 80ms)
  Mỗi event tốn ~80ms -> 1 VU xử lý được 12.5 events/s
  Cần tối thiểu: ceil(20 × 0.080) = 2 VU
  Có 12 VU preAllocated -> vẫn đủ
  dropped_iterations = 0 -> PASS

Case C: Backend rất yếu (response time avg = 800ms)
  Mỗi event tốn ~800ms -> 1 VU xử lý được 1.25 events/s
  Cần tối thiểu: ceil(20 × 0.800) = 16 VU
  preAllocatedVUs=12, maxVUs=30 -> cần mở thêm 4 VU -> OK
  dropped_iterations = 0 -> PASS

Case D: Backend siêu yếu (response time avg = 2000ms)
  Mỗi event tốn ~2000ms -> 1 VU xử lý được 0.5 events/s
  Cần tối thiểu: ceil(20 × 2.000) = 40 VU
  maxVUs=30 -> không đủ! -> 10 slots/s không có worker
  dropped_iterations = 10/s × 45s = 450
  Test FAIL -> phát hiện contract breach!

  => Đây chính là giá trị của constant-arrival-rate:
     Khi backend thực sự không chịu được contract, test BÁO LỖI.
```

### Bảng tóm tắt hành vi qua 4 mức latency

| Backend latency (avg) | VU cần thiết | VU có sẵn (max 30) | Kết quả constant-vus | Kết quả constant-arrival-rate |
| ---: | ---: | ---: | --- | --- |
| 4ms | ceil(20×0.004) = 1 | 30 | PASS (throughput ~3000/s) | PASS (0 drop) |
| 80ms | ceil(20×0.080) = 2 | 30 | PASS (throughput ~150/s) | PASS (0 drop) |
| 800ms | ceil(20×0.800) = 16 | 30 | PASS (throughput ~15/s) | PASS (0 drop) |
| 2000ms | ceil(20×2.000) = 40 | 30 (thiếu 10) | PASS (throughput ~6/s) | FAIL (450 dropped) |

Điểm mấu chốt: `constant-vus` pass ở CẢ 4 trường hợp, trong khi `constant-arrival-rate`
phát hiện chính xác trường hợp cuối cùng là contract breach.

## Phân tích nguyên nhân gốc kỹ thuật (Root Cause Analysis)

Mỗi root cause dưới đây giải thích MỘT khía cạnh kỹ thuật của `constant-arrival-rate`
mà nếu không hiểu, team sẽ đọc sai output.

### Root Cause 1: Arrival schedule là fixed timeline, VU là anonymous worker

**Vấn đề**: Người mới thường nghĩ "12 preAllocatedVUs = test với 12 user".
Đây là sai lầm cơ bản.

**Nguyên nhân gốc**:

Trong `constant-arrival-rate`, k6 duy trì 2 thứ ĐỘC LẬP với nhau:

1. **Arrival schedule**: một timeline cố định các slot phải bắt đầu
2. **VU pool**: tập hợp worker có thể nhận slot để chạy

Hai thứ này không có quan hệ 1-1. Một VU có thể chạy hàng trăm slot trong suốt
thời gian test.

**Demo trace cho 1 VU trong 45s**:

```text
Timeline của VU #3 (preAllocated):

t=0.000s: VU #3 khởi tạo, sẵn sàng
t=0.000s: slot #0 đến -> VU #3 nhận -> chạy event (list)
t=0.004s: event #0 xong (4ms) -> VU #3 trả về pool
t=0.050s: slot #1 đến -> VU #3 nhận -> chạy event (detail)
t=0.054s: event #1 xong -> VU #3 trả về pool
t=0.100s: slot #2 đến -> VU #3 nhận -> chạy event (list)
t=0.104s: event #2 xong -> VU #3 trả về pool
...
t=44.950s: slot #899 đến -> VU #3 nhận -> chạy event (list)
t=44.954s: event #899 xong -> VU #3 trả về pool

Tổng cộng VU #3 đã xử lý: khoảng 45s / 0.05s = 900 events
(Nếu chỉ có 1 VU, cần 0.05s mỗi event -> 20 events/s -> đúng bằng rate)

Thực tế có 12 VUs -> mỗi VU chỉ xử lý ~900/12 = 75 events
```

**Code path minh họa**:

```js
// Trong common.js - userContext KHÔNG dùng vuId làm identity
export function userContext(seed = 'arrival', userPool = 500) {
  const iteration = exec.scenario.iterationInTest;  // <-- slot index toàn cục
  const pool = Math.max(1, userPool);
  const userNumber = (iteration % pool) + 1;        // <-- user luân phiên theo slot
  return {
    seed,
    vuId: exec.vu.idInTest,                         // <-- CHỈ là worker id
    iter: iteration,
    userId: `arrival-user-${userNumber}`,            // <-- business user từ slot
  };
}
```

**Hệ quả quan trọng**:

```text
- VU #3 có thể xử lý event cho user-1, user-5, user-100... tùy slot
- userId KHÔNG gắn với vuId
- Một business user có thể được "phục vụ" bởi nhiều VU khác nhau
- preAllocatedVUs=12 không có nghĩa "12 user" mà là "12 worker sẵn sàng"
```

### Root Cause 2: Backend chậm -> VU demand TĂNG (không phải throughput GIẢM)

**Vấn đề**: Trực giác sai phổ biến: "backend chậm thì hệ thống chậm, throughput
giảm". Điều này ĐÚNG cho closed model, SAI cho open model.

**Nguyên nhân gốc**:

Open model có arrival rate cố định từ bên ngoài. Khi mỗi event tốn nhiều thời
gian hơn, hệ thống phải xử lý **cùng số lượng event trên cùng đơn vị thời gian**,
nên cần **nhiều worker hơn** để làm song song.

```text
Closed model (constant-vus):
  VU giống như dây chuyền sản xuất:
    - 12 công nhân, mỗi người làm 1 sản phẩm rồi làm tiếp
    - Công nhân làm chậm -> sản lượng/giờ GIẢM
    - KHÔNG có deadline cứng cho từng sản phẩm

Open model (constant-arrival-rate):
  VU giống như quầy checkout siêu thị:
    - Khách đến đúng 20 người/phút (arrival rate)
    - Thu ngân làm chậm -> hàng đợi dài -> cần MỞ THÊM quầy
    - Nếu không mở kịp -> khách bỏ đi (= dropped_iterations)
    - Số khách đến KHÔNG GIẢM dù thu ngân chậm
```

**Công thức**:

```text
VU cần thiết = ceil(lambda × W)

Trong đó:
  lambda = rate / timeUnit_seconds = 20 / 1 = 20 events/s
  W = thời gian trung bình mỗi event (response time + JS overhead)

Ví dụ:
  W = 0.004s (4ms) -> VU cần = ceil(20 × 0.004) = 1 VU
  W = 0.100s (100ms) -> VU cần = ceil(20 × 0.100) = 2 VU
  W = 0.500s (500ms) -> VU cần = ceil(20 × 0.500) = 10 VU
  W = 1.000s (1s) -> VU cần = ceil(20 × 1.000) = 20 VU
  W = 2.000s (2s) -> VU cần = ceil(20 × 2.000) = 40 VU
```

**Với Run 89 (p95 = 4ms)**:

```text
W_effective ~ 0.004s (dùng p95 làm conservative estimate)
VU cần = ceil(20 × 0.004) = ceil(0.08) = 1 VU

Có 12 preAllocatedVUs -> dư 11 VU -> margin an toàn rất lớn
Đây là lý do Run 89 pass dễ dàng với 0 drop.
```

**Ngược lại, nếu backend chậm (W = 2s)**:

```text
VU cần = ceil(20 × 2.0) = 40 VU
maxVUs = 30 -> thiếu 10 VU
drop_rate = lambda - capacity = 20 - 30/2.0 = 20 - 15 = 5 events/s
Tổng drop trong 45s = 5 × 45 = 225 dropped_iterations

=> Contract breach!
```

### Root Cause 3: dropped_iterations là tín hiệu contract breach của open model

**Vấn đề**: Team thường chỉ nhìn checks, http_req_failed, latency mà bỏ qua
`dropped_iterations`. Đây là metric QUAN TRỌNG NHẤT của open model.

**Nguyên nhân gốc**:

`dropped_iterations` không phải là "lỗi HTTP", không phải là "timeout", không
phải là "exception". Nó là **slot đến giờ mà không có VU rảnh để nhận**.

```text
Cơ chế drop trong k6 constant-arrival-rate:

1. Scheduler tính toán thời điểm bắt đầu cho slot thứ i:
   t_i = t_0 + i × (timeUnit_seconds / rate)

2. Đến t_i, scheduler kiểm tra:
   a) Có VU nào đang idle không?
      -> Có: giao slot cho VU đó, iteration bắt đầu
   b) Không có VU idle, nhưng activeVUs < maxVUs?
      -> Tạo VU mới (spawn), giao slot
   c) Không có VU idle VÀ activeVUs == maxVUs?
      -> SLOT BỊ DROP: dropped_iterations += 1

3. Slot bị drop KHÔNG được thử lại, KHÔNG có retry.
   Nó mất vĩnh viễn.
```

**Tại sao dropped_iterations là PRIMARY signal?**

```text
checks pass (100%) + http_req_failed = 0% + p95 = 4ms
NHƯNG dropped_iterations = 450

=> Test FAIL!

Lý do: Contract nói "20 arrivals/s được xử lý".
      450 arrivals bị drop = 450 arrivals KHÔNG được xử lý.
      Dù 450 arrival còn lại xử lý hoàn hảo, contract vẫn bị breach.
      Giống như: 50% đơn hàng giao đúng hẹn, 50% bị hủy -> không thể nói
      "dịch vụ tốt" vì 50% đơn giao hoàn hảo.
```

**Cách đọc dropped_iterations trong summary**:

```text
Run 89 (PASS):
  iterations: 900
  dropped_iterations: 0
  => Tất cả 900 slot đều có worker -> contract giữ 100%

Run 93 car-05 (FAIL):
  iterations: 249
  dropped_iterations: 22
  scheduled_slots = 249 + 22 + 0 = 271 (~270 target)
  => 22/271 = 8.1% slot bị drop -> contract breach
```

### Root Cause 4: preAllocatedVUs vs maxVUs là capacity parameter, không phải concurrency target

**Vấn đề**: Team thường cấu hình `preAllocatedVUs` và `maxVUs` theo kiểu "tôi
muốn test với X user", giống như `vus` trong `constant-vus`. Đây là sai.

**Nguyên nhân gốc**:

Trong `constant-arrival-rate`, 2 tham số này có ý nghĩa HOÀN TOÀN KHÁC:

```text
preAllocatedVUs:
  - Số VU được tạo sẵn TRƯỚC KHI test bắt đầu
  - Mục đích: tránh cold-start delay khi những slot đầu tiên đến
  - NÊN đặt = ceil(lambda × W_expected) + buffer (vd 20-50%)
  - KHÔNG phải là "số user mô phỏng"

maxVUs:
  - Số VU TỐI ĐA k6 được phép tạo ra (kể cả preAllocated)
  - Mục đích: trần bảo vệ, tránh k6 spawn vô hạn làm sập máy test
  - NÊN đặt = ceil(lambda × W_max_tolerable) × safety_factor
  - KHÔNG phải là "peak concurrency"

Mối quan hệ:
  - preAllocatedVUs <= activeVUs <= maxVUs
  - activeVUs tự động tăng/giảm theo nhu cầu
  - Khi activeVUs == maxVUs và vẫn thiếu -> drop bắt đầu
```

**Ví dụ tính toán cho case 01**:

```text
lambda = 20 events/s

W_expected (p95 norm) = 0.010s (10ms - dự phòng)
W_max_tolerable = 0.500s (500ms - nếu chậm hơn thì system đã có vấn đề)

preAllocatedVUs = ceil(20 × 0.010) × 1.5 = ceil(0.2) × 1.5 = 1 × 1.5 = 1.5 -> 2
  Nhưng config dùng 12 -> rất conservative, OK

maxVUs = ceil(20 × 0.500) × 1.5 = 10 × 1.5 = 15
  Nhưng config dùng 30 -> gấp đôi conservative, đảm bảo không drop oan
```

**Tại sao config dùng 12 preAllocatedVUs và 30 maxVUs?**

```text
- 12 preAllocatedVUs: đảm bảo cold start mượt, buffer dư dả cho latency spike
- 30 maxVUs: cho phép mở rộng gấp 2.5 lần nếu backend chậm bất thường
- Đây là config "an toàn" cho contract test: ưu tiên không drop oan
- Trong production test thật, nên đặt maxVUs sát với capacity thực tế hơn
```

### Root Cause 5: Event duration = VU busy time, bao gồm HTTP + JS + wait

**Vấn đề**: Team thường nhìn `http_req_duration` và nghĩ đó là toàn bộ thời gian
xử lý. Thực tế, event duration còn bao gồm JS execution và bất kỳ `sleep()` nào.

**Nguyên nhân gốc**:

```text
Event duration (constant_arrival_event_duration_ms) =
  thời gian từ lúc VU nhận slot đến lúc VU gọi finishEvent()

Bao gồm:
  - JS execution trước HTTP request (userContext, weightedPick)
  - HTTP request time (http_req_duration)
  - JS execution sau HTTP request (parse response, checks)
  - BẤT KỲ sleep() hoặc wait() nào trong event

Quan trọng: Trong thời gian này, VU BẬN -> không nhận slot mới.
           Nên event duration càng dài -> cần càng nhiều VU để giữ rate.
```

**Demo trace chi tiết 1 event**:

```text
Event #42 (slot index = 42, VU #7 đảm nhận):

t=2.100s: VU #7 nhận slot, bắt đầu event
t=2.100s: JS: userContext() -> tính userId, abVariant (0.01ms)
t=2.100s: JS: weightedPick() -> chọn branch (0.005ms)
t=2.100s: JS: tính productId (0.001ms)
t=2.101s: HTTP GET /api/sim/products?limit=10&... bắt đầu
t=2.104s: HTTP response 200 (3ms)
t=2.104s: JS: check status code (0.01ms)
t=2.104s: JS: finishEvent() -> ghi metrics
t=2.104s: VU #7 trả về pool, sẵn sàng cho slot tiếp

Event duration = 2.104 - 2.100 = 4ms
Trong đó:
  - HTTP = 3ms (http_req_duration)
  - JS overhead = 1ms (userContext + weightedPick + check + finishEvent)
```

**Tại sao event duration quan trọng cho VU planning?**

```text
Nếu mỗi event có thêm sleep(0.5) (ví dụ: mô phỏng user think time):

  Event duration = 4ms + 500ms = 504ms
  VU cần = ceil(20 × 0.504) = ceil(10.08) = 11 VU

  So với không có sleep: chỉ cần 1 VU!
  -> 1 dòng sleep(0.5) làm tăng VU demand từ 1 lên 11!
  -> Đây là lý do case 01 KHÔNG dùng sleep: đây là API contract test,
     không phải user journey test.
```

## Identity model deep-dive

Hiểu sai identity model là nguyên nhân #1 dẫn đến đọc sai output. Phần này giải
thích từng identity trong `constant-arrival-rate` và so sánh với executor khác.

### Các identity trong k6

| Identity | Ý nghĩa | Ai gán? | Thay đổi khi nào? |
| --- | --- | --- | --- |
| `__VU` | Virtual User - worker thread | k6 engine | Khởi tạo 1 lần, tồn tại đến hết test |
| `__ITER` | Iteration counter toàn cục | k6 engine | Tăng mỗi lần BẮT ĐẦU iteration mới |
| `exec.scenario.iterationInTest` | Slot index của iteration HIỆN TẠI trong toàn bộ test | k6 engine | Mỗi iteration có 1 giá trị riêng |
| `exec.vu.idInTest` | ID của VU hiện tại trong test | k6 engine | Cố định cho mỗi VU |
| `exec.scenario.iterationInInstance` | Slot index trong instance HIỆN TẠI của VU | k6 engine | Reset khi VU bị destroy và tạo lại |
| `userContext.userId` | Business user identity | Script (common.js) | Từ `iterationInTest % userPool` |
| `userContext.abVariant` | A/B test variant | Script (common.js) | Từ `iterationInTest % 2` |

### Bảng so sánh identity model qua 4 executor

| Khía cạnh | constant-arrival-rate | constant-vus | per-vu-iterations | shared-iterations |
| --- | --- | --- | --- | --- |
| `__VU` là gì? | Worker nhận slot từ scheduler | Vòng lặp xử lý tuần tự | Actor chạy đúng K lần | Worker nhận iteration từ pool |
| `__ITER` có ý nghĩa gì? | Global arrival slot index | Global completion index | VU-local iteration index | Global completion index |
| `iterationInTest` | 0..899 cho 900 slot | 0..N (N phụ thuộc latency) | 0..(vus×iters-1) | 0..(iters-1) |
| userId gắn với gì? | `iterationInTest % userPool` | `vuId` hoặc `__ITER` | `vuId` và `vu-local-iter` | `__ITER % userPool` |
| 1 user được 1 VU phục vụ? | KHÔNG - user luân phiên qua các VU | TÙY script | CÓ - trừ khi script tự đổi | KHÔNG - pool chia sẻ |

### Identity mapping trong case 01

```text
Ví dụ cụ thể 10 slot đầu tiên:

Slot  | iterationInTest | userId             | VU đảm nhận | Branch
------|-----------------|--------------------|-------------|--------
#0    | 0               | arrival-user-1     | VU #1       | list (70%)
#1    | 1               | arrival-user-2     | VU #2       | detail (30%)
#2    | 2               | arrival-user-3     | VU #3       | list
#3    | 3               | arrival-user-4     | VU #1       | list
#4    | 4               | arrival-user-5     | VU #4       | detail
#5    | 5               | arrival-user-6     | VU #2       | list
#6    | 6               | arrival-user-7     | VU #5       | list
#7    | 7               | arrival-user-8     | VU #3       | detail
#8    | 8               | arrival-user-9     | VU #1       | list
#9    | 9               | arrival-user-10    | VU #6       | list

Nhận xét:
  - VU #1 xử lý slot #0, #3, #8 -> phục vụ user-1, user-4, user-9
  - userId tuần tự: user-1, user-2, ..., user-10
  - VU assignment: ai rảnh thì nhận, không theo pattern cố định
  - Branch: deterministic từ weightedPick(iterationInTest)
```

### Vì sao userId = arrival-user-N (không phải tên thật)?

```text
Đây là LOAD TEST, không phải functional test:

- Functional test: "User alice@example.com login, browse, checkout"
  -> Cần identity thật, session thật, data thật

- Load test: "20 arrivals/s của tập user vô danh"
  -> Chỉ cần identity để:
     a) Phân biệt các request trong log/server-side tracing
     b) Mô phỏng cache hit/miss pattern (user quay lại)
     c) Tránh rate limiting (nếu server limit per-user)
  -> Không cần user "thật"
```

### A/B variant pattern

```text
abVariant = iterationInTest % 2 === 0 ? 'b' : 'a'

Slot 0: 'b', Slot 1: 'a', Slot 2: 'b', Slot 3: 'a', ...

Với 900 slot: 450 slot variant 'a', 450 slot variant 'b'
Phân bố đều 50/50 -> test A/B test infrastructure không bias
```

## Phân tích open model

Đây là phần quan trọng nhất để hiểu **tại sao** `constant-arrival-rate` hoạt động
khác biệt so với mọi executor khác trong k6.

### Open model vs Closed model: định nghĩa

```text
CLOSED MODEL (hầu hết executor trong k6):
  - Số lượng "actor" (VU) cố định
  - Mỗi actor hoàn thành 1 việc -> bắt đầu việc tiếp
  - Throughput = f(số actor, thời gian mỗi việc)
  - Hệ thống tự "throttle" khi quá tải: actor chậm -> throughput giảm
  - Giống như: dây chuyền sản xuất với N công nhân

OPEN MODEL (chỉ constant-arrival-rate và ramping-arrival-rate):
  - Arrival rate từ bên ngoài cố định
  - Actor (VU) chỉ là tài nguyên để xử lý arrivals
  - Throughput target = arrival rate (cố định, không phụ thuộc actor)
  - Hệ thống KHÔNG tự throttle: arrival vẫn đến, nếu không xử lý kịp -> drop
  - Giống như: quầy checkout với khách đến theo lịch cố định
```

### So sánh side-by-side: constant-vus vs constant-arrival-rate

Cùng 1 backend, cùng 1 thời điểm, 2 executor cho kết quả HOÀN TOÀN KHÁC NHAU:

```text
BACKEND STATE: Products service bị cache miss hàng loạt
  -> http_req_duration tăng từ 4ms lên 200ms

═══════════════════════════════════════════════════════════════
CONSTANT-VUS (vus=12, duration=45s)
───────────────────────────────────────────────────────────────
Trước khi cache miss (0-15s):
  iter_time = 0.004s
  throughput = 12 / 0.004 = 3000 req/s
  Mỗi VU: 250 req/s

Sau khi cache miss (15-45s):
  iter_time = 0.200s
  throughput = 12 / 0.200 = 60 req/s
  Mỗi VU: 5 req/s

Tổng kết:
  iterations ≈ 250×15 + 5×30 = 3750 + 150 = 3900
  http_reqs ≈ 3900
  dropped_iterations = 0
  checks = 100%
  http_req_failed = 0%

  => Test PASS! Nhưng throughput thực tế giảm từ 3000 xuống 60 req/s.
     Lên production: 20 arrivals/s thật -> 0.200s mỗi event -> cần 4 VU
     thực tế có 12 VU -> vẫn OK.
     Nhưng nếu production có 100 arrivals/s thật -> cần 20 VU, chỉ có 12
     -> queue đầy -> 502.

  => Test "pass" nhưng không phát hiện được giới hạn thực sự của hệ thống!

═══════════════════════════════════════════════════════════════
CONSTANT-ARRIVAL-RATE (rate=20/s, duration=45s, maxVUs=30)
───────────────────────────────────────────────────────────────
Trước khi cache miss (0-15s):
  event_time = 0.004s
  VU cần = ceil(20 × 0.004) = 1 VU
  Có 12 VU -> dư dả, 0 drop

Sau khi cache miss (15-45s):
  event_time = 0.200s
  VU cần = ceil(20 × 0.200) = 4 VU
  Có tối đa 30 VU -> vẫn đủ, 0 drop

Tổng kết:
  iterations ≈ 900
  http_reqs ≈ 900
  dropped_iterations = 0
  checks = 100%

  => Test PASS! Và đây là pass THẬT: 20 arrivals/s được xử lý hết.
     Nếu event_time tăng lên 2000ms:
     VU cần = ceil(20 × 2.0) = 40 VU
     maxVUs = 30 -> thiếu 10 VU -> dropped_iterations = 10/s × 30s = 300
     => Test FAIL! Phát hiện chính xác contract breach.

═══════════════════════════════════════════════════════════════
```

### Công thức toán học của open model

```text
Ký hiệu:
  lambda = rate / timeUnit_seconds         (target arrival rate)
  T = duration_seconds                      (test duration)
  N_sched = lambda × T                      (scheduled slots)
  W = event_duration trung bình             (service time)
  M = số VU hiện có (activeVUs)

Định luật Little cho open model:
  L = lambda × W                            (số event trong hệ thống TB)
                                            = số VU bận TB

Capacity của hệ thống với M VU:
  capacity = M / W                          (events/s tối đa)

Điều kiện không drop:
  capacity >= lambda
  <=> M / W >= lambda
  <=> M >= lambda × W

Drop rate khi thiếu VU:
  drop_rate = max(0, lambda - M / W)

Tổng drop trong thời gian T:
  total_drop ≈ drop_rate × T (nếu điều kiện ổn định)
```

**Áp dụng cho case 01 (Run 89)**:

```text
lambda = 20 / 1 = 20 events/s
T = 45s
N_sched = 20 × 45 = 900 slots

W = 0.004s (p95 từ Run 89)

M_min = ceil(20 × 0.004) = ceil(0.08) = 1 VU
M_available = 12 preAllocated, max 30

Vì M_available (12) >> M_min (1):
  capacity = 12 / 0.004 = 3000 events/s >> lambda (20)
  => drop_rate = 0
  => dropped_iterations = 0

Kết quả khớp với Run 89: 900 iterations, 0 dropped.
```

**Áp dụng cho giả định backend chậm (W = 2s)**:

```text
M_min = ceil(20 × 2.0) = 40 VU
M_available = 30 (max)

capacity = 30 / 2.0 = 15 events/s
lambda = 20 events/s

drop_rate = 20 - 15 = 5 events/s
total_drop ≈ 5 × 45 = 225

=> N_done ≈ 900 - 225 = 675 iterations
=> dropped_iterations = 225
=> Test FAIL (maxDroppedIterations = 0)
```

### Khi nào open model "biến thành" closed model?

Một insight thú vị: nếu `maxVUs` được đặt rất cao (vd 10000) và backend không
quá chậm, `constant-arrival-rate` hành xử **giống như** closed model với infinite
VU pool -- không bao giờ drop. Nhưng đây là **cấu hình sai**:

```text
Sai: maxVUs = 10000 "để không bao giờ drop"
  -> Test không phát hiện được contract breach
  -> Mất giá trị của open model
  -> Lãng phí tài nguyên test machine

Đúng: maxVUs = capacity_threshold × safety_factor
  -> capacity_threshold: số VU tối đa mà hệ thống production có thể
     cung cấp (tương đương max pods, max threads, ...)
  -> safety_factor: 1.2-1.5 để tránh drop oan do VU spawn delay
  -> Nếu vượt qua capacity_threshold -> drop -> contract breach THẬT
```

## Bảng service/API flow

Case 01 có flow đơn giản nhất trong toàn bộ series: mỗi arrival event gọi đúng
1 API call. Đây là case "hello world" của constant-arrival-rate, giúp người học
dễ reconcile counters trước khi gặp case phức tạp hơn (multi-request).

### Branch logic

Branch được chọn **deterministic** theo iteration number, dùng weighted pick:

```js
const choice = weightedPick([
  { name: 'list', weight: 70 },
  { name: 'detail', weight: 30 },
], ctx.iter);
```

Cơ chế weightedPick (từ common.js):

```js
export function weightedPick(items, n) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  const pick = n % total;
  let cursor = 0;
  for (const item of items) {
    cursor += item.weight;
    if (pick < cursor) return item.name;
  }
  return items[items.length - 1].name;
}
```

### Bảng phân bố branch theo iteration

| Iteration | pick = iter % 100 | Branch | Endpoint |
| ---: | ---: | --- | --- |
| 0 | 0 | list | GET /api/sim/products?limit=10&sort=popular&view=grid |
| 1 | 1 | list | GET /api/sim/products?limit=10&sort=popular&view=grid |
| ... | ... | list | ... |
| 69 | 69 | list | GET /api/sim/products?limit=10&sort=popular&view=grid |
| 70 | 70 | detail | GET /api/sim/products/:id?view=full |
| 71 | 71 | detail | GET /api/sim/products/:id?view=full |
| ... | ... | detail | ... |
| 99 | 99 | detail | GET /api/sim/products/:id?view=full |
| 100 | 0 | list | (chu kỳ mới, quay lại list) |

### Phân tích phân bố

```text
Trong mỗi block 100 iteration:
  - 70 iteration branch 'list' (pick 0-69)
  - 30 iteration branch 'detail' (pick 70-99)

Với 900 iteration = 9 block × 100:
  - 9 × 70 = 630 request list
  - 9 × 30 = 270 request detail
  - Tổng: 900 API calls

Tỉ lệ: 70% list, 30% detail -- khớp weight cấu hình
```

### Product ID generator

```js
const productId = ((ctx.iter * 7) % 50) + 1;
```

```text
Công thức: productId = (iter × 7) mod 50 + 1
  -> Tạo product ID từ 1 đến 50
  -> Nhân với 7 (số nguyên tố) để tránh pattern lặp quá rõ
  -> Phân bố đều trên 50 sản phẩm

Ví dụ:
  iter=0:  (0×7)%50+1 = 1
  iter=1:  (1×7)%50+1 = 8
  iter=2:  (2×7)%50+1 = 15
  iter=3:  (3×7)%50+1 = 22
  iter=7:  (7×7)%50+1 = 50
  iter=8:  (8×7)%50+1 = 7   (56%50=6 -> +1=7)
  ...
  iter=50: (50×7)%50+1 = 1  (350%50=0 -> +1=1) -> quay lại ID 1 sau 50 iter

=> Mỗi product ID xuất hiện 900/50 = 18 lần trong toàn bộ test
```

### Flow diagram

```text
┌─────────────────────────────────────────────────┐
│          ARRIVAL EVENT (1 slot = 1 event)        │
├─────────────────────────────────────────────────┤
│  1. userContext(seed, userPool=1000)             │
│     -> userId = arrival-user-{N}                 │
│     -> abVariant = 'a' hoặc 'b'                  │
│     -> requestKey = seed-{iter}-{vuId}           │
│                                                  │
│  2. productId = (iter × 7) % 50 + 1              │
│                                                  │
│  3. weightedPick (70% list, 30% detail)          │
│     ┌─ list (70%) ───────────────────────────┐   │
│     │  GET /api/sim/products                 │   │
│     │    ?limit=10&sort=popular&view=grid     │   │
│     │    &cpu_ms=1&db_rows=2                 │   │
│     │  tags:                                 │   │
│     │    caseId: car-01-storefront-rps-...    │   │
│     │    service: products-service            │   │
│     │    operation: storefront_arrival_list   │   │
│     │    endpoint: GET /api/sim/products      │   │
│     └────────────────────────────────────────┘   │
│     ┌─ detail (30%) ─────────────────────────┐   │
│     │  GET /api/sim/products/{productId}     │   │
│     │    ?view=full&cpu_ms=1&db_rows=1       │   │
│     │  tags:                                 │   │
│     │    caseId: car-01-storefront-rps-...    │   │
│     │    service: products-service            │   │
│     │    operation: storefront_arrival_detail │   │
│     │    endpoint: GET /api/sim/products/:id  │   │
│     └────────────────────────────────────────┘   │
│                                                  │
│  4. finishEvent(started, ok, tags)               │
│     -> constant_arrival_events_total += 1        │
│     -> constant_arrival_event_duration_ms add    │
│     -> nếu !ok: constant_arrival_events_failed++ │
└─────────────────────────────────────────────────┘
```

### Counter reconciliation (happy path)

```text
Với 900 slot, 0 drop, 0 interrupt, 0 fail:

  iterations                            = 900
  http_reqs                             = 900  (1 request/event)
  constant_arrival_events_total         = 900  (1 event/slot)
  constant_arrival_api_calls_total      = 900  (1 API call/event)
  constant_arrival_events_failed        = 0
  dropped_iterations                    = 0

Công thức reconcile:
  iterations ≈ constant_arrival_events_total ≈ http_reqs
  http_reqs ≈ constant_arrival_api_calls_total

  (Vì mỗi event = 1 API call, nên các counter xấp xỉ bằng nhau)
```

## Metrics & tags deep-dive

### Custom metrics (từ common.js)

#### `constant_arrival_events_total` (Counter)

```text
Loại: Counter
Khi nào tăng: Mỗi lần finishEvent() được gọi (kết thúc 1 arrival event)
Tags: case_id, service, operation, user_id
Ý nghĩa: Tổng số arrival event ĐÃ HOÀN THÀNH (thành công hoặc thất bại)

Trong case 01:
  - Mỗi event gọi finishEvent() đúng 1 lần
  - Nên counter này ≈ iterations (nếu không có iteration nào fail trước finishEvent)

Cách đọc:
  - constant_arrival_events_total ≈ iterations -> flow bình thường
  - constant_arrival_events_total < iterations -> có event không finish (crash/exception)
```

#### `constant_arrival_events_failed` (Counter)

```text
Loại: Counter
Khi nào tăng: finishEvent() được gọi với ok=false
Tags: case_id, service, operation, user_id
Ý nghĩa: Số arrival event có ÍT NHẤT 1 API call thất bại

Trong case 01:
  - Mỗi event gọi 1 API call -> nếu API call fail (check status != 200), event fail
  - Threshold: count < 10 (cho phép vài fail do network hiccup)

Cách đọc:
  - events_failed = 0 -> tất cả event đều thành công
  - events_failed > 0 -> kiểm tra tag operation để biết list hay detail bị fail
```

#### `constant_arrival_api_calls_total` (Counter)

```text
Loại: Counter
Khi nào tăng: Mỗi lần requestJson() gọi HTTP request
Tags: case_id, service, operation, endpoint, user_id, name
Ý nghĩa: Tổng số HTTP API call từ tất cả arrival event

Trong case 01:
  - Mỗi event 1 API call -> counter này ≈ http_reqs
  - Nếu 1 event gọi nhiều API (case 04, 07) -> counter > http_reqs

Cách đọc:
  - constant_arrival_api_calls_total ≈ http_reqs -> mỗi event 1 request (case 01)
  - constant_arrival_api_calls_total > http_reqs -> event gọi nhiều request
```

#### `constant_arrival_event_duration_ms` (Trend)

```text
Loại: Trend (percentiles)
Khi nào ghi: finishEvent() tính Date.now() - startedAt
Tags: case_id, service, operation, user_id
Ý nghĩa: Thời gian end-to-end của 1 arrival event (từ lúc VU nhận slot đến lúc finish)

Trong case 01 (Run 89): p95 = 4ms
  - HTTP: ~3ms
  - JS overhead: ~1ms

Đây là metric quan trọng NHẤT để ước tính VU demand:
  VU_cần = ceil(rate × p95_event_duration)

Cách đọc:
  - p95 thấp (4ms) -> backend khỏe, VU demand thấp
  - p95 cao (500ms+) -> backend chậm, VU demand cao, nguy cơ drop
  - p95 tăng dần theo thời gian -> leak/resource pressure
```

### k6 built-in metrics liên quan

#### `dropped_iterations` (Counter)

```text
Loại: Counter (k6 built-in)
Ý nghĩa: Số slot đến giờ start nhưng không có VU rảnh
Mức độ quan trọng: CRITICAL - PRIMARY pass/fail signal

Trong case 01 (Run 89): 0
Threshold: count <= 0 (contract case, không chấp nhận drop)

Đây là metric KHÔNG có trong constant-vus hay shared-iterations.
Nó là "chữ ký" của open model.
```

#### `iterations` (Counter)

```text
Loại: Counter (k6 built-in)
Ý nghĩa: Tổng số iteration đã HOÀN THÀNH
Công thức: iterations = scheduled_slots - dropped_iterations - interrupted_iterations

Trong case 01 (Run 89): 900
Expected: gần 900 (20×45)
```

#### `http_reqs` (Counter)

```text
Loại: Counter (k6 built-in)
Ý nghĩa: Tổng số HTTP request đã gửi

Trong case 01 (Run 89): 900
Expected: gần iterations (vì mỗi iteration 1 request)
```

#### `http_req_duration` (Trend)

```text
Loại: Trend (k6 built-in)
Ý nghĩa: Thời gian HTTP request (chỉ HTTP, không gồm JS)

So sánh với constant_arrival_event_duration_ms:
  http_req_duration: CHỈ thời gian trên wire (TCP -> response)
  event_duration: HTTP + toàn bộ JS trong event

Trong case 01: 2 giá trị gần bằng nhau (vì JS overhead nhỏ)
```

### Tags deep-dive

Mỗi metric được gắn tags để lọc và phân tích trên dashboard:

| Tag | Nguồn | Giá trị ví dụ | Mục đích |
| --- | --- | --- | --- |
| `case_id` | common.js | `car-01-storefront-rps-contract` | Lọc metric theo case |
| `service` | common.js | `products-service` | Nhóm theo service |
| `operation` | common.js | `storefront_arrival_list`, `storefront_arrival_detail` | Phân biệt API operation |
| `endpoint` | common.js | `GET /api/sim/products`, `GET /api/sim/products/:id` | Route pattern |
| `user_id` | common.js | `arrival-user-1`, `arrival-user-42` | Trace per-user |
| `executor_family` | buildArrivalScenario | `constant_arrival_rate` | Nhóm test theo executor |
| `workload_shape` | buildArrivalScenario | `fixed_ingress_rate` | Phân loại workload pattern |
| `business_case` | buildArrivalScenario | `storefront_fixed_rps_contract` | Mục đích business |

### Cách reconcile counters

```text
Step 1: Kiểm tra iterations và dropped_iterations
  iterations + dropped_interruptions + dropped_iterations ≈ scheduled_slots

Step 2: Kiểm tra events_total và iterations
  constant_arrival_events_total ≈ iterations
  (nếu thấp hơn nhiều -> event bị crash trước finishEvent)

Step 3: Kiểm tra api_calls_total và http_reqs
  constant_arrival_api_calls_total ≈ http_reqs
  (case 01: 1 request/event -> 2 giá trị bằng nhau)

Step 4: Kiểm tra events_failed
  constant_arrival_events_failed = số event có !ok
  (nếu > 0 -> kiểm tra operation tag để xác định endpoint lỗi)

Step 5: Business conclusion
  - Tất cả khớp, 0 drop, 0 fail -> PASS, contract đạt
  - Có sai lệch -> điều tra tag để xác định vấn đề
```

**Reconciliation cho Run 89**:

```text
scheduled_slots = 20 × 45 = 900

iterations = 900                              ✓
dropped_iterations = 0                        ✓
constant_arrival_events_total = 900           ✓
constant_arrival_api_calls_total = 900        ✓
http_reqs = 900                               ✓
constant_arrival_events_failed = 0            ✓

900 = 900 + 0 + 0 -> khớp                     ✓
900 ≈ 900 -> khớp                             ✓
900 ≈ 900 -> khớp                             ✓

=> Tất cả counter reconcile hoàn hảo
=> Đây là case dễ nhất để reconcile trong toàn bộ series
```

## Pass criteria

### Thresholds trong script

| Threshold | Điều kiện | Ý nghĩa |
| --- | --- | --- |
| `checks` | `rate > 0.99` | >99% checks pass (status code check) |
| `http_req_failed` | `rate < 0.01` | <1% HTTP request fail |
| `dropped_iterations` | `count <= MAX_DROPPED` (= 0) | Không slot nào bị drop |
| `constant_arrival_events_failed` | `count < 10` | Dưới 10 event thất bại |

### Phân tích từng threshold

#### checks > 0.99

```text
Check trong case 01: kiểm tra HTTP status code = 200

Với 900 request:
  - Pass nếu ≥ 891 request có status 200
  - Cho phép tối đa 9 request fail status check

Tại sao không phải 1.0?
  - Network hiccup, TCP reset, connection reuse stale -> không tránh được
  - Cho phép 1% fail là industry standard cho HTTP API test
  - Nhưng case CONTRACT (maxDroppedIterations=0) có thể yêu cầu nghiêm ngặt hơn
```

#### http_req_failed < 0.01

```text
http_req_failed khác với checks fail:
  - checks fail: response OK nhưng sai status code (vd 500)
  - http_req_failed: KHÔNG có response (timeout, connection refused, DNS fail)

Run 89: http_req_failed = 0% -> không có request nào fail hoàn toàn
```

#### dropped_iterations <= 0

```text
Đây là threshold QUAN TRỌNG NHẤT cho contract case.

maxDroppedIterations = 0 nghĩa là:
  - KHÔNG CHẤP NHẬN bất kỳ slot nào bị drop
  - Nếu có dù chỉ 1 drop -> test FAIL
  - Đây là "contract case" khó nhất

Trong thực tế, team có thể đặt maxDroppedIterations cao hơn:
  - maxDroppedIterations = 5 (cho phép 5 drop trên 900 slot = 0.5%)
  - maxDroppedIterations = 45 (cho phép 5% drop rate)
  - Tùy vào SLA thực tế với business

Nhưng cho case HỌC TẬP này, đặt = 0 để thấy rõ cơ chế drop.
```

#### constant_arrival_events_failed < 10

```text
Event failed = sự kiện có ÍT NHẤT 1 API call không pass check

Trong case 01 (1 event = 1 API call):
  events_failed ≈ checks_failed

Tại sao < 10 mà không phải = 0?
  - Cho phép vài event fail do transient error (network, GC pause)
  - Nếu fail nhiều -> vấn đề hệ thống, không phải ngẫu nhiên
  - Ngưỡng 10/900 ≈ 1.1% -> tương đương checks threshold
```

### Bảng tổng hợp pass criteria

| Metric | Run 89 value | Threshold | Pass? |
| --- | ---: | --- | --- |
| checks | 100% | > 99% | PASS |
| http_req_failed | 0% | < 1% | PASS |
| dropped_iterations | 0 | <= 0 | PASS |
| events_failed | 0 | < 10 | PASS |
| iterations | 900 | ~900 | PASS |
| p95 event duration | 4ms | (không có threshold cứng) | OK |

## Cách chạy

### Full run (local + dashboard)

```powershell
cd "E:\Khoa hoc\k6"

# Set environment
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

# Chạy với summary export
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js"
```

### Env override cho từng tham số

Tất cả tham số đều có thể override qua environment variables:

| Variable | Default | Mô tả |
| --- | --- | --- |
| `CAR_01_RATE` | `20` | Arrival rate (events per timeUnit) |
| `CAR_01_TIME_UNIT` | `1s` | Đơn vị thời gian cho rate |
| `CAR_01_DURATION` | `45s` | Thời gian giữ contract |
| `CAR_01_PREALLOCATED_VUS` | `12` | Số VU khởi tạo sẵn |
| `CAR_01_MAX_VUS` | `30` | Số VU tối đa |
| `CAR_01_USER_POOL` | `1000` | Số user trong pool |
| `CAR_01_MAX_DROPPED` | `0` | Ngưỡng dropped_iterations |

### Smoke test nhanh (5s)

```powershell
$env:CAR_01_RATE = "5"
$env:CAR_01_DURATION = "5s"
$env:CAR_01_PREALLOCATED_VUS = "4"
$env:CAR_01_MAX_VUS = "8"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js"
Remove-Item Env:CAR_01_RATE, Env:CAR_01_DURATION, Env:CAR_01_PREALLOCATED_VUS, Env:CAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

```text
Smoke config khác full run:
  - rate: 5/s (thay vì 20/s) -> nhẹ hơn 4 lần
  - duration: 5s (thay vì 45s) -> nhanh hơn 9 lần
  - preAllocatedVUs: 4 (thay vì 12) -> ít worker hơn
  - maxVUs: 8 (thay vì 30) -> trần thấp hơn
  - Expected slots: 5 × 5 = 25 (thay vì 900)

Mục đích: xác nhận script chạy được, không lỗi syntax, kết nối được backend
```

### Chạy không có dashboard (local only)

```powershell
$env:BASE_URL = "http://localhost:80"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js"
```

```text
Kết quả hiển thị trên terminal:
  - execution: local
  - output: stdout (không gửi lên cloud/dashboard)
  - Phù hợp để debug nhanh, không cần xem chart
```

## Phân tích output 5 bước

Mỗi bước phân tích một khía cạnh của output. Làm theo thứ tự để không bỏ sót.

### Bước 1: Header -- xác nhận config

Đọc phần đầu output để xác nhận test đang chạy đúng config:

```text
execution: local
  script: ...\car-01-storefront-rps-contract.js
  output: cloud (http://localhost:18080)

scenarios: (100.00%) 1 scenario, 30 max VUs, 1m15s max duration
  storefront_rps_contract: constant-arrival-rate, 20.00 iterations/s, 45s
```

Checklist:
```text
[ ] executor = constant-arrival-rate (không phải constant-vus)
[ ] rate = 20/s (không phải 20 total)
[ ] duration = 45s
[ ] max VUs = 30
[ ] preAllocatedVUs = 12 (có thể không hiển thị ở header)
```

### Bước 2: Expected slots -- tính toán target

```text
Công thức: scheduled_slots = rate × duration_seconds
                          = 20 × 45
                          = 900

Đây là CON SỐ MỤC TIÊU. Mọi phân tích sau đó xoay quanh 900.
```

### Bước 3: Summary counts -- đọc iteration và drop

Đây là bước QUAN TRỌNG NHẤT. Đọc summary:

```text
Run 89 healthy output:
  iterations: 900
  http_reqs: 900
  dropped_iterations: 0
  interrupted_iterations: 0 (nếu có)
  checks: 100% (900/900 passed)
  http_req_failed: 0% (0/900)

Kiểm tra:
  [ ] iterations ≈ 900? (có thể 899-901 do boundary)
  [ ] dropped_iterations = 0?
  [ ] iterations + dropped + interrupted ≈ 900?
```

**Nếu iterations thấp hơn 900**:

```text
Nguyên nhân có thể:
  1. dropped_iterations > 0 -> VU pool không đủ
  2. interrupted_iterations > 0 -> test bị ngắt giữa chừng
  3. k6 shutdown sớm (gracefulStop, timeout)

Cách điều tra:
  1. Đọc dropped_iterations TRƯỚC
  2. Nếu dropped > 0 -> kiểm tra VU pressure (active VUs có chạm maxVUs không?)
  3. Nếu dropped = 0 nhưng iterations < 900 -> kiểm tra interrupted và duration
```

### Bước 4: Custom metrics -- reconcile event counters

```text
Run 89:
  constant_arrival_events_total: 900
  constant_arrival_events_failed: 0
  constant_arrival_api_calls_total: 900
  constant_arrival_event_duration_ms: avg=3.5ms, p95=4ms, p99=6ms

Reconcile:
  [ ] events_total (900) ≈ iterations (900)?
  [ ] api_calls_total (900) ≈ http_reqs (900)?
  [ ] events_failed (0) = 0?
  [ ] p95 event duration < ngưỡng chấp nhận?

Nếu events_failed > 0:
  -> Lọc dashboard theo tag operation:
     - operation=storefront_arrival_list: list endpoint fail
     - operation=storefront_arrival_detail: detail endpoint fail
  -> Xác định endpoint nào gây lỗi
```

### Bước 5: Business conclusion -- ra quyết định

Tổng hợp tất cả các bước trên để đưa ra kết luận kinh doanh:

```text
Run 89:
  Target: 900 arrivals trong 45s, 0 drop, 0 fail
  Actual: 900 iterations, 0 drop, 0 fail, p95=4ms

  => PASS: Products service chịu được 20 browse/list arrivals/s
           trong 45s với margin an toàn cao (p95=4ms, cần ~1 VU nhưng
           có 12-30 VU).
```

Bảng quyết định nhanh:

| iterations | drop | fail | p95 | Kết luận |
| ---: | ---: | ---: | ---: | --- |
| 900 | 0 | 0 | 4ms | PASS hoàn hảo |
| 900 | 0 | 0 | 500ms | PASS contract nhưng latency cao -> tối ưu |
| 900 | 0 | 5 | 4ms | PASS contract nhưng có transient error -> điều tra |
| 850 | 50 | 0 | 4ms | FAIL: contract breach do thiếu VU -> tăng maxVUs |
| 850 | 0 | 0 | 4000ms | FAIL: backend quá chậm -> tối ưu backend trước |
| 500 | 400 | 0 | 2000ms | FAIL: hệ thống không chịu được load -> crisis |

## Dashboard 3-chart deep analysis

Dashboard real-time cung cấp 4 biểu đồ chính để phân tích trong và sau khi chạy.
Phần này mô tả cách đọc từng biểu đồ cho case 01.

### Chart 1: Overview -- Response time

**Mô tả**: Biểu đồ hiển thị p95/p99/http_req_duration theo thời gian.

**Kỳ vọng cho case 01**:

```text
Run 89 thực tế:
  - p95 ổn định ở ~4ms suốt 45s
  - Không có spike đột ngột
  - p99 có thể cao hơn (6-8ms) nhưng không leo thang
  - Không có pattern "tăng dần" (memory leak, cache degradation)
```

**Những gì cần tìm**:

```text
1. Cold start spike:
   - 5-10s đầu p95 cao hơn bình thường
   - Nguyên nhân: VU warmup, connection pool init, JIT compilation
   - Bình thường nếu ổn định sau 10s

2. Tăng dần (gradual increase):
   - p95 tăng từ 4ms -> 20ms -> 50ms -> 100ms theo thời gian
   - NGUY HIỂM: dấu hiệu memory leak, DB connection leak, cache fragmentation
   - Không xuất hiện trong Run 89

3. Spike đơn lẻ:
   - 1-2 điểm p95 cao đột ngột rồi trở lại bình thường
   - Có thể là GC pause, network hiccup, hoặc cron job trên server
   - Không tự động fail test (trừ khi kéo dài)

4. p95 detail cao hơn list:
   - detail endpoint có DB query phức tạp hơn -> p95 cao hơn list
   - Bình thường nếu chênh lệch < 2x
   - Nếu detail p95 = 500ms trong khi list p95 = 4ms -> detail endpoint
     có vấn đề riêng
```

**Run 89 analysis**:

```text
p95 = 4ms toàn bộ test:
  - Backend products service response cực nhanh
  - CPU + DB đều nhẹ (cpu_ms=1, db_rows=1-2)
  - Đây là baseline lý tưởng để so sánh với case khác
```

### Chart 2: Overview -- Execution timeline

**Mô tả**: Biểu đồ hiển thị iterations/s và http_reqs/s theo thời gian (bucket).

**Kỳ vọng cho case 01**:

```text
Run 89 thực tế:
  - iterations/s ≈ 20 (gần bằng rate target)
  - http_reqs/s ≈ 20 (gần bằng iterations/s)
  - Cả 2 đường gần như chồng khít lên nhau
  - Không có bucket nào bị tụt đột ngột
```

**Những gì cần tìm**:

```text
1. iterations/s < 20 ở nhiều bucket:
   - dropped_iterations > 0 (VU pool không đủ)
   - Hoặc backend quá chậm làm iteration kéo dài qua bucket boundary
   - -> Kiểm tra dropped_iterations trong summary

2. http_reqs/s < iterations/s:
   - Một số iteration không gọi HTTP request (skip branch)
   - KHÔNG xảy ra trong case 01 (mỗi event luôn gọi 1 request)
   - Nếu xảy ra -> bug trong script

3. http_reqs/s > iterations/s:
   - Một số iteration gọi nhiều hơn 1 HTTP request
   - KHÔNG xảy ra trong case 01
   - Xảy ra trong case 04 (checkout gọi 2 request)

4. iterations/s = 0 ở 1-2 bucket đầu:
   - Cold start, VU đang spawn
   - Bình thường nếu test dài, nhưng với 45s ngắn -> chú ý
```

**Run 89 analysis**:

```text
iterations/s và http_reqs/s đều ≈ 20/s, ổn định suốt 45s:
  - Contract được giữ đều
  - Không có bucket nào tụt
  - Không có bucket nào vượt (k6 schedule đều)
```

### Chart 3: Overview -- VUs vs iter/s

**Mô tả**: Biểu đồ hiển thị số VU đang active và iteration rate thực tế.

**Kỳ vọng cho case 01**:

```text
Run 89 thực tế:
  - active VUs: ổn định ở mức thấp (3-5 VU)
  - iter/s: ổn định ở ~20/s
  - KHÔNG có tương quan: VUs không tăng khi iter/s ổn định
  - VUs << maxVUs (30) -> margin an toàn lớn
```

**Những gì cần tìm**:

```text
1. active VUs = maxVUs:
   - VU pool đã chạm trần -> nguy cơ drop
   - Nếu đồng thời iter/s < target rate -> drop đang xảy ra

2. active VUs tăng dần:
   - Backend đang chậm dần -> mỗi event tốn nhiều thời gian hơn
   - k6 spawn thêm VU để bù -> VU count tăng
   - Nếu chạm maxVUs -> drop bắt đầu

3. active VUs dao động mạnh:
   - Backend latency không ổn định
   - Có thể do GC, connection pool exhaust, hoặc resource contention

4. iter/s không ổn định dù VUs ổn định:
   - Vấn đề không phải VU pool mà là schedule hoặc script
   - Kiểm tra xem có sleep(), wait(), hoặc điều kiện rẽ nhánh không
```

**Run 89 analysis**:

```text
active VUs thấp (3-5), iter/s = 20/s ổn định:
  - Backend cực nhanh (p95=4ms) -> VU quay vòng nhanh
  - 3-5 VU đủ để xử lý 20 arrivals/s
  - 12 preAllocatedVUs là quá dư -> có thể giảm xuống 5-6
  - Đây là dấu hiệu của system khỏe mạnh
```

### Chart 4: Executor tab

**Mô tả**: Tab hiển thị thông tin executor-specific, bao gồm config và metrics.

**Checklist**:

```text
[ ] Executor detected: constant-arrival-rate
[ ] rate: 20
[ ] timeUnit: 1s
[ ] duration: 45s
[ ] preAllocatedVUs: 12
[ ] maxVUs: 30
[ ] dropped_iterations: khớp với summary (Run 89: 0)
[ ] Số VU max observed: khớp với chart VUs vs iter/s
```

**Những gì cần tìm**:

```text
1. Executor detected khác constant-arrival-rate:
   -> Script bị lỗi, sai executor

2. rate/timeUnit/duration khác expected:
   -> Env override không hoạt động, hoặc default bị thay đổi

3. dropped_iterations trong executor tab khác summary:
   -> Có thể dashboard aggregate khác summary export
   -> Luôn tin summary export hơn (là final)

4. preAllocatedVUs/maxVUs khác config:
   -> Env override hoặc default script bị sai
```

## 4 output -> decision scenarios

Mỗi scenario dưới đây là một output mẫu (dựa trên các lần chạy thật hoặc mô phỏng)
và quyết định kinh doanh tương ứng.

### Scenario A: Perfect pass (Run 89 thực tế)

```text
═══════════════════════════════════════════════════════
OUTPUT
───────────────────────────────────────────────────────
iterations:              900
http_reqs:               900
dropped_iterations:      0
interrupted_iterations:  0
checks:                  100% (900/900)
http_req_failed:         0% (0/900)
events_total:            900
events_failed:           0
api_calls_total:         900
event_duration p95:      4 ms
event_duration avg:      3.5 ms
active VUs max:          5 (observed)

THRESHOLDS
───────────────────────────────────────────────────────
checks > 0.99:           PASS (1.00)
http_req_failed < 0.01:  PASS (0.00)
dropped <= 0:            PASS (0)
events_failed < 10:      PASS (0)

═══════════════════════════════════════════════════════
BUSINESS DECISION
───────────────────────────────────────────────────────
VERDICT: PASS - Products service sẵn sàng production

Phân tích:
  - 900/900 arrivals được xử lý (100% contract)
  - 0 drop -> VU pool đủ capacity
  - 0 fail -> tất cả endpoint hoạt động
  - p95=4ms -> latency rất thấp, margin an toàn cao
  - Chỉ cần 5 VU để xử lý 20 arrivals/s -> dư địa lớn

Hành động:
  - Deploy lên production với confidence cao
  - Có thể tăng rate lên 50/s hoặc 100/s để test giới hạn
  - Document baseline này cho regression test tương lai
```

### Scenario B: Pass nhưng high latency

```text
═══════════════════════════════════════════════════════
OUTPUT (mô phỏng)
───────────────────────────────────────────────────────
iterations:              900
http_reqs:               900
dropped_iterations:      0
interrupted_iterations:  0
checks:                  100% (900/900)
http_req_failed:         0% (0/900)
events_total:            900
events_failed:           0
api_calls_total:         900
event_duration p95:      450 ms
event_duration avg:      380 ms
active VUs max:          18 (observed)

THRESHOLDS
───────────────────────────────────────────────────────
checks > 0.99:           PASS (1.00)
http_req_failed < 0.01:  PASS (0.00)
dropped <= 0:            PASS (0)
events_failed < 10:      PASS (0)

═══════════════════════════════════════════════════════
BUSINESS DECISION
───────────────────────────────────────────────────────
VERDICT: PASS contract nhưng CẢNH BÁO latency

Phân tích:
  - 900/900 arrivals được xử lý -> contract đạt
  - 0 drop -> VU pool vừa đủ (dùng 18/30 VU)
  - p95=450ms -> latency cao gấp 100 lần baseline (4ms)
  - VU demand: ceil(20 × 0.450) = 9 VU -> dùng tới 18 VU

Điều tra:
  - So sánh với Run 89 baseline p95=4ms
  - Tại sao latency tăng 100x? Cache miss? DB query chậm?
  - Network latency? Server resource pressure?
  - Dùng tag operation để xem list vs detail latency

Nguy cơ:
  - Nếu latency tăng thêm (vd lên 800ms):
    VU cần = ceil(20 × 0.800) = 16 -> vẫn OK với maxVUs=30
  - Nếu latency tăng lên 2000ms:
    VU cần = 40 > 30 -> drop bắt đầu!
  - Margin an toàn thấp -> cần оптимизация backend

Hành động:
  - Điều tra root cause của latency cao
  - Có thể deploy với warning (theo dõi latency sau deploy)
  - KHÔNG deploy nếu SLA yêu cầu p95 < 50ms
  - Thiết lập alert latency trên production
```

### Scenario C: Contract breach (dropped > 0)

```text
═══════════════════════════════════════════════════════
OUTPUT (mô phỏng - backend siêu chậm + VU pool nhỏ)
───────────────────────────────────────────────────────
iterations:              580
http_reqs:               580
dropped_iterations:      320
interrupted_iterations:  0
checks:                  100% (580/580)
http_req_failed:         0% (0/580)
events_total:            580
events_failed:           0
api_calls_total:         580
event_duration p95:      1900 ms
event_duration avg:      1700 ms
active VUs max:          30 (CHẠM TRẦN)

THRESHOLDS
───────────────────────────────────────────────────────
checks > 0.99:           PASS (1.00)
http_req_failed < 0.01:  PASS (0.00)
dropped <= 0:            FAIL (320 > 0)  ← BREACH!
events_failed < 10:      PASS (0)

═══════════════════════════════════════════════════════
BUSINESS DECISION
───────────────────────────────────────────────────────
VERDICT: FAIL - Products service KHÔNG chịu được contract

Phân tích:
  - 320/900 slot bị drop (35.5% mất) -> contract breach nghiêm trọng
  - active VUs chạm trần 30 -> không thể mở thêm worker
  - p95=1900ms -> mỗi event tốn gần 2s
  - VU cần: ceil(20 × 1.9) = 38 > 30 -> thiếu 8 VU
  - Drop rate: 20 - 30/1.9 = 20 - 15.8 = 4.2/s × 45s ≈ 189
    (thực tế 320 -> backend không ổn định, có lúc chậm hơn 1.9s)

Chẩn đoán:
  - Nguyên nhân gốc CÓ THỂ là:
    a) Backend thực sự chậm (DB query 2s) -> cần tối ưu backend
    b) Network latency cao giữa k6 và server -> kiểm tra mạng
    c) VU pool quá nhỏ -> thử tăng maxVUs
  - KHÔNG kết luận ngay "backend fail" khi chưa kiểm tra VU capacity

Phương án A: Tăng VU pool (nếu backend latency chấp nhận được)
  maxVUs = 50 (thay vì 30)
  VU cần = 38 -> OK với 50
  Kỳ vọng: drop giảm hoặc về 0

Phương án B: Tối ưu backend (nếu latency là vấn đề)
  Target: giảm p95 từ 1900ms xuống < 500ms
  VU cần = ceil(20 × 0.5) = 10 -> OK với 30

Hành động:
  - KHÔNG deploy lên production
  - Thử tăng maxVUs để xác định: bottleneck là backend hay VU pool?
  - Nếu tăng VU pool vẫn drop -> backend là bottleneck
  - Nếu tăng VU pool hết drop -> VU pool là bottleneck
  - Dù kết quả nào, p95=1900ms là KHÔNG chấp nhận được cho production
```

### Scenario D: Mixed signals (0 drop nhưng events_failed > 0)

```text
═══════════════════════════════════════════════════════
OUTPUT (mô phỏng - detail endpoint bị lỗi 500)
───────────────────────────────────────────────────────
iterations:              900
http_reqs:               900
dropped_iterations:      0
interrupted_iterations:  0
checks:                  96.7% (870/900)
http_req_failed:         0% (0/900)
events_total:            900
events_failed:           30
api_calls_total:         900
event_duration p95:      4 ms
active VUs max:          5 (observed)

Breakdown theo operation:
  storefront_arrival_list:    630/630 checks pass
  storefront_arrival_detail:  240/270 checks pass (30 fail)

THRESHOLDS
───────────────────────────────────────────────────────
checks > 0.99:           FAIL (0.967 < 0.99)
http_req_failed < 0.01:  PASS (0.00)
dropped <= 0:            PASS (0)
events_failed < 10:      FAIL (30 > 10)

═══════════════════════════════════════════════════════
BUSINESS DECISION
───────────────────────────────────────────────────────
VERDICT: FAIL - detail endpoint có vấn đề

Phân tích:
  - 0 drop -> contract arrival rate được giữ (VU pool OK)
  - Nhưng 30 event fail -> detail endpoint trả về lỗi
  - List endpoint: 630/630 OK (100%)
  - Detail endpoint: 240/270 OK (88.9% - 30 fail)
  - Tỉ lệ fail của detail: 30/270 = 11.1%

Chẩn đoán:
  - 30 fail đều ở detail endpoint -> vấn đề cục bộ
  - Không phải vấn đề toàn hệ thống (list vẫn OK)
  - Có thể: product ID không tồn tại, DB query sai, permission lỗi
  - Detail endpoint có DB query khác list -> check DB

Điều tra sâu:
  - Lọc metric theo operation=storefront_arrival_detail
  - Xem status code của 30 request fail (500? 404? 403?)
  - Xem productId có pattern không (vd toàn bộ fail ở ID > 40?)
  - Check server log để tìm stack trace

Hành động:
  - KHÔNG deploy (detail endpoint fail)
  - Fix detail endpoint -> rerun test
  - Sau khi fix, target: events_failed = 0, checks = 100%
```

## "Nghịch lý" -- những sự thật gây ngạc nhiên

Đây là những điều **phản trực giác** mà người mới học `constant-arrival-rate`
thường bất ngờ. Hiểu được chúng là dấu hiệu đã nắm vững executor.

### Nghịch lý 1: "12 preAllocatedVUs nhưng test tới 1000 user"

**Vì sao gây ngạc nhiên**:

Người mới nhìn `preAllocatedVUs=12` và nghĩ "chỉ có 12 user được test". Nhưng
config `USER_POOL=1000` và userId chạy từ `arrival-user-1` đến `arrival-user-1000`.

```text
Sai: "12 VU = 12 user, sao test được 1000 user?"
Đúng: VU là worker, không phải user.
      userPool=1000 nghĩa là identity pool có 1000 user name.
      Nhưng user KHÔNG "chiếm" VU. VU chỉ là người thực thi event.
      1 VU có thể phục vụ user-1, user-5, user-100... trong các event khác nhau.
```

**Demo**:

```text
VU #3 (1 worker) trong 45s:
  Event #0:  phục vụ arrival-user-1   (list)
  Event #3:  phục vụ arrival-user-4   (list)
  Event #8:  phục vụ arrival-user-9   (list)
  Event #12: phục vụ arrival-user-13  (detail)
  Event #17: phục vụ arrival-user-18  (list)
  ...

  VU #3 đã phục vụ ~75 user khác nhau trong 45s!
  Mỗi user được phục vụ trong 1 event (~4ms), VU không "nhớ" user đó.
```

**Trực giác đúng**:

```text
Hãy tưởng tượng quầy lễ tân khách sạn:
  - Có 12 nhân viên (preAllocatedVUs)
  - Mỗi phút có 20 khách đến (rate)
  - Khách sạn có 1000 phòng (userPool) -> mỗi khách có số phòng riêng
  - 12 nhân viên phục vụ 1000 khách luân phiên -> hoàn toàn bình thường
  - Nhân viên không "thuộc về" khách nào cả
```

### Nghịch lý 2: "p95=4ms nhưng test vẫn có thể fail contract"

**Vì sao gây ngạc nhiên**:

p95 thấp thường được hiểu là "hệ thống khỏe, test pass". Nhưng trong open model,
test có thể fail dù p95=4ms.

```text
Làm sao p95=4ms mà vẫn fail?

Tình huống: maxVUs = 1 (chỉ có 1 worker)
  - Mỗi event tốn 4ms -> 1 VU xử lý được 250 events/s
  - Rate = 20/s -> VU dư sức, 0 drop -> PASS

Tình huống: maxVUs = 1, rate = 300/s
  - Mỗi event tốn 4ms -> 1 VU xử lý được 250 events/s
  - Rate = 300/s -> thiếu 50 events/s
  - drop_rate = 50/s -> dropped_iterations = 2250 trong 45s
  - Test FAIL dù p95 vẫn 4ms!

Kết luận: p95 thấp là ĐIỀU KIỆN CẦN nhưng CHƯA ĐỦ.
         Phải check dropped_iterations nữa.
```

**Trực giác đúng**:

```text
p95 quyết định VU demand (cần bao nhiêu VU).
Nhưng có đủ VU hay không phụ thuộc vào maxVUs config.

Công thức: pass khi maxVUs >= ceil(rate × p95)

Với rate=20/s, p95=4ms:
  VU cần = ceil(20 × 0.004) = 1 -> dễ pass

Với rate=300/s, p95=4ms:
  VU cần = ceil(300 × 0.004) = 2 -> vẫn dễ pass

Với rate=20/s, p95=2000ms:
  VU cần = ceil(20 × 2.0) = 40 -> khó pass với maxVUs=30

=> p95 và rate CÙNG quyết định VU demand.
   p95 thấp + rate cao vẫn có thể gây drop nếu maxVUs thấp.
```

### Nghịch lý 3: "rate=20/s nhưng actual completed rate có thể < 20/s dù không drop"

**Vì sao gây ngạc nhiên**:

Nếu không có drop, người ta nghĩ completed rate phải = target rate 20/s. Nhưng
k6 summary hiển thị `iterations/s` là **completed iteration rate**, không phải
scheduled rate.

```text
Tại sao completed rate < 20/s dù drop=0?

Nguyên nhân: test duration không khớp với bucket aggregation.

Ví dụ:
  - Test chạy 45s, nhưng 1-2s đầu là VU spawn (chưa có iteration)
  - 1-2s cuối là graceful shutdown (không schedule slot mới)
  - Tổng iteration = 860 (schedule trong 43s, không phải 45s)
  - k6 summary: iterations/s = 860/45 = 19.1/s (< 20/s!)
  - Nhưng dropped_iterations = 0!

  => iterations/s trong summary là AVERAGE trên toàn bộ duration,
     bao gồm cả thời gian không schedule.
  => 19.1/s không có nghĩa contract bị breach.
  => Luôn kiểm tra dropped_iterations, không chỉ nhìn iterations/s.
```

**Trực giác đúng**:

```text
iterations/s (summary) = iterations / test_duration
Đây là average, bao gồm ramp-up và shutdown.

Để đánh giá contract:
  - scheduled_slots ≈ rate × duration -> so sánh với iterations
  - dropped_iterations = 0 -> không slot nào bị bỏ
  - iterations/s có thể thấp hơn rate do ramp-up/shutdown -> bình thường

Run 89: iterations=900, duration=45s -> iterations/s = 900/45 = 20.0/s
        (hoàn hảo vì backend quá nhanh, không có ramp-up delay)
```

### Nghịch lý 4: "checks=100% nhưng test vẫn fail"

**Vì sao gây ngạc nhiên**:

checks=100% nghĩa là tất cả HTTP request đều trả về status code mong đợi (200).
Người mới nghĩ "100% checks = pass hoàn hảo". Nhưng test có thể fail vì lý do
không liên quan đến HTTP status.

```text
Run 93 car-05 thực tế:
  checks: 100%
  http_req_failed: 0%
  NHƯNG: dropped_iterations = 22
         maxDroppedIterations = 0
  => FAIL!

Tại sao?
  - checks=100%: 249 request gửi đi đều trả về 200
  - Nhưng 22 slot KHÔNG BAO GIỜ được gửi request!
  - 22 slot bị drop trước khi kịp tạo HTTP request
  - checks không đo được drop vì drop xảy ra TRƯỚC khi HTTP request
    được tạo

=> checks=100% là "tất cả request ĐÃ GỬI đều OK"
   KHÔNG phải "tất cả arrivals đều được xử lý"
```

**Trực giác đúng**:

```text
Trong open model, thứ tự kiểm tra:
  1. Slot đến -> có VU không?
     - Có: tạo iteration, gửi HTTP request -> checks áp dụng
     - Không: drop -> checks KHÔNG áp dụng (không có request để check)

=> dropped_iterations phải được check ĐỘC LẬP với checks.
   Đây là 2 chiều khác nhau của contract:
   - checks: chất lượng request đã gửi
   - dropped_iterations: số lượng request đã được gửi
```

## Checklist

### Pre-run (trước khi chạy)

```text
[ ] Backend health check: curl http://localhost:80/health -> 200 OK
[ ] k6 version: k6.exe v2.0.0+
[ ] Metrics server: curl http://localhost:18080/v1/capabilities -> 200 OK
[ ] Token valid: curl -H "Authorization: Bearer student-token-1234567890"
      http://localhost:18080/v1/me -> 200 OK
[ ] Script inspect: k6 inspect <script.js> -> không lỗi syntax
[ ] Env vars sẵn sàng: BASE_URL, K6_CLOUD_HOST, K6_CLOUD_TOKEN
[ ] Dashboard accessible: http://localhost:18080
[ ] Xác nhận rate/duration/preAllocatedVUs/maxVUs đúng config mong muốn
[ ] Dọn dẹp dữ liệu test cũ nếu cần (database, cache)
```

### During-run (trong khi chạy)

```text
[ ] Dashboard Overview chart xuất hiện data
[ ] iter/s gần target rate (20/s) sau 5s đầu
[ ] dropped_iterations = 0 (theo dõi real-time trên Executor tab)
[ ] Không có HTTP error spike
[ ] p95 latency ổn định, không tăng dần
[ ] active VUs không chạm maxVUs (nếu chạm -> nguy cơ drop)
[ ] Không có log lỗi từ k6 process
[ ] CPU/memory của k6 process không quá cao
```

### Post-run (sau khi chạy)

```text
[ ] iterations ≈ rate × duration (vd 900 cho 20/s × 45s)
[ ] dropped_iterations <= maxDroppedIterations (0 cho contract case)
[ ] interrupted_iterations = 0 hoặc thấp
[ ] checks rate > threshold (0.99)
[ ] http_req_failed rate < threshold (0.01)
[ ] events_failed < threshold (10)
[ ] events_total ≈ iterations
[ ] api_calls_total ≈ http_reqs
[ ] event_duration p95 trong ngưỡng chấp nhận
[ ] Reconciliation: iteration + drop + interrupt ≈ scheduled_slots
[ ] Dashboard charts khớp với summary numbers
[ ] Lưu summary export file để reference sau này
[ ] Ghi lại run ID để trace
```

## 5 Variations -- thay đổi config để thấy executor behavior

Mỗi variation dưới đây thay đổi một khía cạnh của config để minh họa hành vi
của `constant-arrival-rate`. Chạy từng variation và so sánh output.

### Variation 1: Smoke test (rate thấp, duration ngắn)

**Mục đích**: Xác nhận script hoạt động, kết nối backend OK.

```powershell
$env:CAR_01_RATE = "5"
$env:CAR_01_DURATION = "5s"
$env:CAR_01_PREALLOCATED_VUS = "4"
$env:CAR_01_MAX_VUS = "8"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js"

Remove-Item Env:CAR_01_RATE, Env:CAR_01_DURATION, Env:CAR_01_PREALLOCATED_VUS, Env:CAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

```text
Expected:
  scheduled_slots = 5 × 5 = 25
  iterations ≈ 25
  dropped_iterations = 0
  p95 < 100ms

Observation:
  - Kiểm tra script không lỗi
  - Kiểm tra kết nối backend
  - Làm quen với output format
```

### Variation 2: Thu nhỏ VU pool để thấy dropped_iterations

**Mục đích**: Cố ý gây drop để thấy cơ chế drop hoạt động.

```powershell
$env:CAR_01_RATE = "20"
$env:CAR_01_DURATION = "15s"
$env:CAR_01_PREALLOCATED_VUS = "1"
$env:CAR_01_MAX_VUS = "2"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js"

Remove-Item Env:CAR_01_RATE, Env:CAR_01_DURATION, Env:CAR_01_PREALLOCATED_VUS, Env:CAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

```text
Expected:
  scheduled_slots = 20 × 15 = 300
  VU cần tối thiểu = ceil(20 × 0.004) = 1 VU
  maxVUs = 2 -> chạm trần nếu latency tăng

  Nếu p95 vẫn 4ms: 1 VU xử lý được 250 events/s -> 0 drop
  Nhưng nếu có latency spike (>100ms): 1 VU chỉ xử lý 10 events/s -> drop

Observation quan trọng:
  - Nếu 0 drop: chứng tỏ backend quá nhanh, 1 VU đủ
  - Nếu drop > 0: thấy cơ chế drop hoạt động -> học được cách đọc
  - Thử tăng dần maxVUs từ 1->2->4->8 để thấy drop giảm dần
```

### Variation 3: Tăng duration để thấy steady-state

**Mục đích**: Xem hành vi của hệ thống trong thời gian dài (phát hiện memory leak,
connection leak, cache degradation).

```powershell
$env:CAR_01_RATE = "20"
$env:CAR_01_DURATION = "5m"
$env:CAR_01_PREALLOCATED_VUS = "12"
$env:CAR_01_MAX_VUS = "30"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js"

Remove-Item Env:CAR_01_DURATION -ErrorAction SilentlyContinue
```

```text
Expected:
  scheduled_slots = 20 × 300 = 6000
  iterations ≈ 6000 (nếu 0 drop)
  p95: theo dõi xem có tăng dần theo thời gian không

Observation:
  - Nếu p95 ổn định suốt 5 phút -> system khỏe
  - Nếu p95 tăng dần (4ms -> 20ms -> 50ms -> ...) -> leak
  - Nếu drop xuất hiện ở phút thứ 3-5 -> system degrade theo thời gian
  - Dashboard chart: xem p95 trend line (tăng dần = nguy hiểm)
```

### Variation 4: Thay đổi branch weights

**Mục đích**: Xem ảnh hưởng của traffic pattern đến latency và VU demand.

```powershell
# Không có env var để override weight (weight hardcoded trong script)
# Cần sửa script tạm:
#   const choice = weightedPick([
#     { name: 'list', weight: 90 },
#     { name: 'detail', weight: 10 },
#   ], ctx.iter);

# Hoặc tạo script variation riêng
```

```text
Thử nghiệm:
  - 90/10 list/detail: detail ít hơn -> p95 tổng thấp hơn?
  - 50/50 list/detail: detail nhiều hơn -> p95 tổng cao hơn?
  - 0/100 detail only: chỉ test detail endpoint -> tìm bottleneck của detail

Observation:
  - So sánh p95 của list vs detail (dùng tag operation trên dashboard)
  - Detail có DB query khác -> có thể chậm hơn
  - Nếu detail chậm hơn nhiều -> cần tối ưu riêng detail endpoint
```

### Variation 5: Thêm external latency để mô phỏng backend chậm

**Mục đích**: Mô phỏng backend chậm mà không cần thay đổi backend thật.

```powershell
# Cách 1: Thêm delay ở load-target server (nếu hỗ trợ)
$env:CAR_01_RATE = "20"
$env:CAR_01_DURATION = "45s"

# Thêm cpu_ms và db_rows cao hơn qua query param (nếu load-target hỗ trợ)
# Hoặc sửa script để thêm ?cpu_ms=50&db_rows=10

# Cách 2: Dùng network throttling tool (tc, clumsy, ...)

# Cách 3: Thêm sleep() trong script (chỉ để demo)
# sleep(0.5) trong mỗi event -> event duration = 4ms + 500ms = 504ms
# VU cần = ceil(20 × 0.504) = 11 VU (thay vì 1)
```

```text
Expected với event duration 500ms:
  VU cần = ceil(20 × 0.500) = 10 VU
  preAllocatedVUs=12 -> vừa đủ
  maxVUs=30 -> dư

  Nếu event duration 1000ms:
  VU cần = ceil(20 × 1.0) = 20 VU
  preAllocatedVUs=12 -> cần spawn thêm 8
  maxVUs=30 -> vẫn OK

  Nếu event duration 2000ms:
  VU cần = ceil(20 × 2.0) = 40 VU
  maxVUs=30 -> thiếu 10 -> drop!

Observation quan trọng:
  - Thấy rõ mối quan hệ: event duration tăng -> VU demand tăng -> drop
  - Tại sao KHÔNG nên thêm sleep() trong RPS contract test:
    sleep mô phỏng "user think time", nhưng contract test là API->API,
    không có user think time.
```

## Anti-patterns (mở rộng)

Đây là những sai lầm phổ biến khi đọc output của `constant-arrival-rate`, kèm
giải thích vì sao sai và cách đọc đúng.

### Anti-pattern 1: "12 preAllocatedVUs nghĩa là chỉ test 12 user"

```text
SAI:
  "Config preAllocatedVUs=12 -> test với 12 concurrent user.
   User pool 1000 là vô nghĩa vì chỉ có 12 VU."

VÌ SAO SAI:
  - VU là worker thread, không phải business user
  - userPool=1000 là identity pool để gán userId
  - Mỗi VU có thể phục vụ hàng trăm user khác nhau trong 45s
  - userId = arrival-user-N được gán từ iterationInTest % userPool
  - 12 VU phục vụ 900 events cho 900 user khác nhau (hoặc ít hơn nếu
    userPool < 900)

ĐÚNG:
  "preAllocatedVUs=12 là số worker sẵn sàng nhận arrival slot.
   Mỗi slot có 1 userId riêng từ pool 1000.
   Số user được test = min(scheduled_slots, userPool) = min(900, 1000) = 900."
```

### Anti-pattern 2: "Latency thấp (p95=4ms) nên chắc chắn pass"

```text
SAI:
  "p95=4ms -> test pass. Không cần kiểm tra gì thêm."

VÌ SAO SAI:
  - p95 thấp = VU demand thấp = dễ giữ contract
  - NHƯNG: vẫn phải kiểm tra dropped_iterations (có thể maxVUs quá thấp)
  - Vẫn phải kiểm tra checks (có thể status code sai dù latency thấp)
  - Vẫn phải kiểm tra events_failed (có thể request fail dù latency thấp)
  - p95 là 1 trong NHIỀU tín hiệu, không phải tín hiệu DUY NHẤT

ĐÚNG:
  "p95=4ms là tín hiệu tốt về latency. Nhưng pass/fail được quyết định bởi
   TẤT CẢ các threshold: dropped_iterations, checks, http_req_failed,
   events_failed. p95 thấp không bù đắp được dropped_iterations > 0."
```

### Anti-pattern 3: "http_reqs/s < 20 một chút nên chắc backend fail"

```text
SAI:
  "Dashboard chart http_reqs/s hiển thị 18/s ở bucket thứ 3.
   Backend không đạt 20/s -> FAIL."

VÌ SAO SAI:
  - Dashboard aggregate theo bucket (có thể 1s, 5s, 10s tùy config)
  - http_reqs/s là AVERAGE trong bucket, không phải instantaneous
  - Nếu bucket boundary cắt ngang iteration đang chạy -> count bị lệch
  - Nếu 1 bucket có 18 requests, bucket khác có 22 -> average vẫn 20
  - Summary iterations/s mới là con số cuối cùng

ĐÚNG:
  "Dashboard chart dùng để phát hiện PATTERN (tăng/giảm đột ngột, trend),
   không dùng để kết luận pass/fail chính xác đến từng request.
   Luôn dùng summary numbers (iterations, dropped_iterations) để kết luận."
```

### Anti-pattern 4: "Tăng maxVUs lên thật cao để không bao giờ drop"

```text
SAI:
  "maxVUs=10000 -> không bao giờ drop -> test luôn pass.
   Đây là cách 'an toàn' để test RPS contract."

VÌ SAO SAI:
  - maxVUs quá cao -> mất giá trị của open model
  - Không phát hiện được contract breach thật sự
  - Backend có thể chậm 10s/request, k6 vẫn spawn đủ VU để giữ rate
    -> test pass nhưng production không thể có 10000 worker
  - Lãng phí tài nguyên test machine (10000 VU tốn RAM/CPU)
  - Che giấu vấn đề backend (lẽ ra phải thấy "backend quá chậm, cần tối ưu")

ĐÚNG:
  "maxVUs nên phản ánh capacity thực tế của production:
   - Số pod/container tối đa
   - Số thread/connection pool tối đa
   - Ngân sách infrastructure
   Nhân với safety factor 1.2-1.5 để tránh drop oan.
   Nếu test drop với maxVUs production-realistic -> production sẽ drop thật."
```

### Anti-pattern 5: "Dùng constant-arrival-rate cho mọi test vì nó 'xịn hơn'"

```text
SAI:
  "constant-arrival-rate là executor mạnh nhất, dùng nó cho mọi test."

VÌ SAO SAI:
  - Mỗi executor có use case riêng:
    - constant-vus: test concurrent user (web socket, long-poll)
    - per-vu-iterations: regression test (fixed input)
    - shared-iterations: batch job, queue drain
    - ramping-vus: stress test, soak test
    - constant-arrival-rate: RPS contract, API gateway

  - Dùng constant-arrival-rate cho regression test -> count không cố định
    (phụ thuộc drop/interrupt) -> không compare được baseline

  - Dùng constant-arrival-rate cho stress test (tăng dần rate) -> dùng
    ramping-arrival-rate mới đúng

ĐÚNG:
  "Chọn executor dựa trên CÂU HỎI BUSINESS:
   - 'Bao nhiêu user đồng thời?' -> constant-vus
   - 'Mỗi user chạy đúng N lần?' -> per-vu-iterations
   - 'Xử lý hết N jobs?' -> shared-iterations
   - 'Chịu được X arrivals/s?' -> constant-arrival-rate
   - 'Chịu được traffic tăng dần?' -> ramping-arrival-rate"
```

### Anti-pattern 6: "Nhìn iterations/s trong summary để đánh giá contract"

```text
SAI:
  "Summary hiển thị iterations/s = 18.5/s, thấp hơn target 20/s.
   Contract bị breach!"

VÌ SAO SAI:
  - iterations/s trong summary = iterations / test_duration
  - test_duration bao gồm ramp-up, ramp-down, graceful shutdown
  - Trong thời gian ramp-up, chưa có iteration nào -> kéo average xuống
  - Trong thời gian shutdown, không schedule slot mới -> kéo average xuống

  - Ví dụ: test 45s, nhưng 5s đầu là spawn VU, 0 iteration
           40s thực sự schedule: 20/s × 40s = 800 iterations
           iterations/s = 800/45 = 17.8/s
           Nhưng dropped_iterations = 0 -> contract VẪN đạt!

ĐÚNG:
  "Đánh giá contract bằng:
   1. scheduled_slots ≈ rate × duration
   2. iterations + dropped + interrupted ≈ scheduled_slots
   3. dropped_iterations <= maxDroppedIterations
   iterations/s trong summary chỉ là con số tham khảo,
   không phải pass/fail criteria."
```

## Reference

### Trong cùng series

| Doc | Nội dung |
| --- | --- |
| `00_overview.md` | Tổng quan series, công thức, mental model |
| `02_auth-token-validation-rps.md` | Case 02: Auth service RPS contract |
| `03_cart-write-intake.md` | Case 03: Cart write intake |
| `04_checkout-order-intake.md` | Case 04: Checkout multi-request |
| `05_report-api-ingress.md` | Case 05: Report API -- dropped_iterations thực tế |
| `06_cacheable-feed-ingress.md` | Case 06: Cacheable feed with high rate |
| `07_production-ingress-mix.md` | Case 07: Mixed traffic pattern |
| `08_validation-and-chart-analysis.md` | Full validation data + chart analysis 7 case |
| `RUN_GUIDE.md` | Hướng dẫn chạy đầy đủ |

### Source code

```text
Script:     E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-01-storefront-rps-contract.js
Common:     E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\common.js
Run helper: E:\Khoa hoc\k6\run-with-summary.ps1
```

### Cross-series reference

| Doc | Nội dung |
| --- | --- |
| `docs/practice/per-vu-iterations/01_user-journey-replay.md` | Regression test với per-vu-iterations |
| `docs/practice/shared-iterations/01_*` | Shared-iterations series |
| `docs/20260513_00_executor-from-simplest.md` | Executor từ đơn giản nhất |

### Key formulas (từ 00_overview.md)

```text
lambda = rate / timeUnit_seconds
scheduled_slots ≈ lambda × duration_seconds
required_vus_min ≈ ceil(lambda × W_effective)
capacity_with_M_vus ≈ M / W_effective
drop_rate ≈ max(0, lambda - capacity_with_M_vus)
observed_scheduled_slots ≈ completed_iterations + interrupted_iterations + dropped_iterations
target_http_req_rate_if_no_drop ≈ lambda × http_requests_per_iteration
```

### Run 89 reference data

```text
Run ID:       89
Date:         2026-06-21
Rate:         20/s
Duration:     45s
Target slots: 900
Iterations:   900
Dropped:      0
HTTP reqs:    900
Checks:       100%
HTTP failed:  0%
Events failed: 0
Event p95:    4 ms
Verdict:      PASS
```
