# Case 03: Cart write intake

## Tình huống thực tế

Cart service nhận các write events từ client: thêm sản phẩm vào giỏ (add item),
cập nhật số lượng (update quantity), và đọc summary sau khi thay đổi.
Ở production, các event này đến theo nhịp từ web/mobile clients -- backend
chậm không làm clients tự biến mất ngay.

### Vì sao "cart write intake" buộc chọn constant-arrival-rate?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của cart write intake test trước:

```text
Cart write intake test = "backend có hấp thụ được nhịp write events thật từ clients không?"
                         không phải "bao nhiêu user cùng active trong giây đó?"

Đời thường:
  Siêu thị có 12 khách/giây đến quầy thanh toán (= arrival rate)
  -> Mỗi khách cần 1 nhân viên xử lý trong ~5ms
  -> Nếu nhân viên bận, khách KHÔNG tự biến mất -- họ xếp hàng
  -> Nếu hàng quá dài (= không đủ VU), khách BỎ ĐI (= dropped_iterations)
  -> Siêu thị cần biết: "có bao nhiêu khách bỏ đi trong giờ cao điểm?"
```

Để intake test **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**.
Chỉ constant-arrival-rate mới thỏa mãn cả 2.

### 2 yêu cầu cốt lõi

#### Yêu cầu (a): FIXED ARRIVAL RATE (nhịp đến cố định, không phụ thuộc backend)

**Ý nghĩa**: Mỗi giây phải có đúng 12 cart write events được schedule,
bất kể backend nhanh hay chậm. Đây là **intake contract** với business.

**Ví dụ cụ thể**:

```text
Scenario: team đo khả năng hấp thụ write intake của cart service

Trường hợp A (backend NHANH, response 3ms):
  12 arrivals/s schedule -> tất cả được xử lý trong 3ms
  -> VU cần: ceil(12 × 0.003) = 1 VU là đủ
  -> 0 dropped -> intake contract OK

Trường hợp B (backend CHẬM, response 80ms do DB write contention):
  12 arrivals/s schedule -> mỗi event giữ VU 80ms
  -> VU cần: ceil(12 × 0.08) = ceil(0.96) = 1 VU vẫn OK về lý thuyết
  -> Nhưng với write amplification, latency tail có thể lên 150ms+
  -> Lúc đó: ceil(12 × 0.15) = ceil(1.8) = 2 VU
  -> Nếu chỉ có 1 preAllocatedVU, hệ thống phải spawn thêm VU

Trường hợp C (backend RẤT CHẬM, response 300ms):
  VU cần: ceil(12 × 0.3) = ceil(3.6) = 4 VU
  -> Nếu maxVUs=30, 4 VU vẫn trong pool -> 0 dropped
  -> Nhưng nếu DB deadlock, response lên 3000ms:
     ceil(12 × 3.0) = ceil(36) = 36 VU > maxVUs=30
     -> dropped_iterations bắt đầu tăng
```

**Vì sao rate phải chính xác?**

```text
Nếu rate phụ thuộc latency (như constant-vus):
  - latency cao  -> ít event/s được xử lý (vd 8/s)
  - latency thấp -> nhiều event/s được xử lý (vd 15/s)
  - mỗi lần test rate khác -> không biết hệ thống có giữ được 12/s không

Với constant-arrival-rate:
  - latency cao  -> rate schedule VẪN 12/s, nhưng cần thêm VU
  - latency thấp -> rate schedule VẪN 12/s, dùng ít VU hơn
  - Nếu không đủ VU -> dropped_iterations báo chính xác bao nhiêu event bị bỏ
```

**Phân tích sâu: vì sao constant-vus không đảm bảo rate?**

`constant-vus` với `vus=10, duration: "45s"`:

```text
Công thức rate khi chạy:
  actual_rate = vus / iter_time
              = 10 / iter_time

iter_time KHÔNG cố định, biến thiên do:
  - DB write latency (index update, WAL flush, replication lag)
  - Connection pool contention (nhiều write cùng DB)
  - Memory allocation (cart serialization/deserialization)
  - GC pause trong cart service

Ví dụ thực tế chạy 3 lần liên tiếp cùng config constant-vus:
  Lần 1: DB cache warm, write nhanh
    iter_time avg = 0.005s -> rate = 10/0.005 = 2000/s (cao hơn target 12/s rất nhiều)
    -> Test không mô phỏng đúng production intake
  Lần 2: DB có backup job chạy ngầm
    iter_time avg = 0.150s -> rate = 10/0.150 = 66.7/s
    -> Vẫn trên target, nhưng khác xa lần 1
  Lần 3: DB write contention nặng
    iter_time avg = 0.500s -> rate = 10/0.500 = 20/s
    -> Gần sát target 12/s, nhưng vẫn không biết chính xác

  Range: 20 - 2000/s (chênh 100x)
  -> Không thể biết hệ thống có giữ được đúng 12/s không
  -> Production intake là CỐ ĐỊNH, không tự điều chỉnh theo backend
```

`constant-arrival-rate` với `rate=12, timeUnit="1s", duration: "45s"`:

```text
Mục tiêu config: "12 arrival slots/s × 45s = 540 slots TOTAL"

Schedule sinh ra đúng 540 slot, phân bố đều 12 slot/giây.
Nhưng có thể DROP slot nếu:
  - Không đủ VU để nhận slot tại thời điểm schedule
  - VU pool cạn (maxVUs đạt trần)
  - Spawn VU không kịp (preAllocatedVUs quá thấp)

Công thức thực tế:
  N_done = N_sched - N_drop - N_int
         = 540 - N_drop - N_int

Ví dụ thực tế:
  Lần 1: pool vừa khít, write nhanh
    N_drop = 0, N_done = 541 (gần 540) -> PASS
  Lần 2: DB có 10s chậm do WAL flush
    N_drop = 0, VUs tăng lên 25 -> vẫn PASS, nhưng headroom giảm
  Lần 3: DB deadlock 5s
    N_drop = 60, N_done = 480 -> FAIL, contract breach

  Range: 480 - 541
  -> Biết CHÍNH XÁC có drop hay không
  -> Đây là thông tin business cần: "cart service có hấp thụ được 12/s không?"
```

**Trong khi đó với constant-vus**:

```text
Config: vus=10, duration=45s
N_done = 45 × 10 / iter_time (BIẾN THIÊN theo latency)

Lần 1: iter_time=5ms  -> N_done=90000 (vô nghĩa với intake test)
Lần 2: iter_time=80ms -> N_done=5625
Lần 3: iter_time=500ms -> N_done=900

Count BIẾN THIÊN mạnh.
Không có khái niệm "drop" -> không biết backend có bỏ event không.

-> constant-vus CHE MẤT overload: khi write chậm, rate tự giảm,
   trông như "hệ thống vẫn ổn" nhưng thực ra đang bỏ event.
```

**Tóm tắt 2 executor về cart write intake**:

| Executor | Rate formula | Có giữ được intake contract? | Phát hiện được drop? |
| --- | --- | --- | --- |
| **constant-arrival-rate** | `rate = 12/s` (CỐ ĐỊNH) | CÓ -- schedule luôn 12/s | CÓ -- dropped_iterations |
| constant-vus | `rate = vus / iter_time` (BIẾN THIÊN) | KHÔNG -- rate tự giảm khi chậm | KHÔNG -- không có khái niệm drop |
| ramping-vus | `rate biến thiên theo stage` | KHÔNG | KHÔNG |
| shared-iterations | `rate = iter / time_to_finish` | KHÔNG | KHÔNG |

-> RATE phải CỐ ĐỊNH 12/s, không phụ thuộc backend latency
-> Phải biết CHÍNH XÁC có event nào bị drop không
-> Chỉ constant-arrival-rate đạt được

#### Yêu cầu (b): ZERO DROPS -- không event nào bị bỏ

**Ý nghĩa**: Trong production, mỗi cart write event bị bỏ nghĩa là một thao
tác của user không được xử lý -- mất hàng trong giỏ, sai số lượng, hoặc
không đọc được summary. Contract case yêu cầu **maxDroppedIterations = 0**.

**Drop là gì?**

```text
Drop xảy ra khi:
  - Schedule báo "đến giờ chạy slot thứ N"
  - k6 tìm VU rảnh trong pool
  - KHÔNG có VU nào rảnh (tất cả đang bận xử lý event trước)
  - Và maxVUs đã đạt trần (không spawn thêm được)
  -> slot N bị BỎ QUA -> dropped_iterations++

Đây không phải "request fail".
  - Request fail = VU nhận slot, gọi API, nhưng API trả về 5xx
  - Drop = VU không nhận slot, API không được gọi
```

**Ví dụ cụ thể với cart write**:

```text
Schedule: 12 slots mỗi giây, mỗi slot cách nhau ~83ms
  t=0.000s: slot 0   -> VU#1 nhận, bắt đầu POST /api/sim/cart/add
  t=0.083s: slot 1   -> VU#2 nhận, bắt đầu POST /api/sim/cart/add
  t=0.167s: slot 2   -> VU#3 nhận, bắt đầu PATCH /api/sim/cart/items/:id
  ...
  t=0.833s: slot 10  -> VU#11 nhận
  t=0.917s: slot 11  -> TẤT CẢ 10 preAllocatedVUs ĐANG BẬN
                        maxVUs=30, k6 spawn thêm VU#12 -> OK

Tình huống xấu: DB write bị chậm 500ms do WAL flush
  t=0.000s: slot 0   -> VU#1 nhận, POST bắt đầu... (500ms)
  t=0.083s: slot 1   -> VU#2 nhận... (500ms)
  ...
  t=0.833s: slot 10  -> VU#11 nhận... (500ms)
  ...
  t=1.500s: slot 18  -> 30 VU ĐỀU ĐANG BẬN (mỗi VU giữ ~500ms)
                        maxVUs=30 đã đạt trần
                        -> slot 18 bị DROP

  Kết quả: cart event của user thứ 19 không được xử lý
  -> User thêm hàng vào giỏ nhưng server không nhận
  -> Đây chính là "contract breach"
```

**Vì sao zero drops quan trọng với cart service?**

```text
Cart write events khác với read-only browse:
  - Browse: user xem sản phẩm, miss 1 request -> user refresh là được
  - Cart add: user thêm hàng, miss 1 request -> MẤT HÀNG, user phải thêm lại
  - Cart update: user đổi quantity, miss -> sai số lượng trong giỏ
  - Cart summary: user xem giỏ, miss -> hiển thị sai

Write events có HẬU QUẢ NGHIỆP VỤ khi bị drop.
Nên contract yêu cầu tuyệt đối 0 drop.
```

#### Tổng kết: chỉ constant-arrival-rate thỏa mãn cả (a) và (b)

| Executor | (a) Fixed 12/s rate | (b) Zero drops detectable | Verdict |
| --- | --- | --- | --- |
| **constant-arrival-rate** | ✓ schedule cứng 12/s | ✓ dropped_iterations metric | ✅ DÙNG |
| constant-vus | ✗ rate = vus/iter_time | ✗ không có drop concept | ❌ |
| ramping-vus | ✗ rate biến thiên theo stage | ✗ không có drop concept | ❌ |
| shared-iterations | ✗ rate = iter/time_to_finish | ✗ không arrival schedule | ❌ |
| per-vu-iterations | ✗ rate = vus/iter_time | ✗ không arrival schedule | ❌ |

-> Chỉ **constant-arrival-rate** thỏa mãn cả 2 yêu cầu: intake rate cố định
và khả năng phát hiện drop.

### 3 nguyên nhân nghiệp vụ cụ thể (= 3 thông số config)

```text
1. FIXED WRITE INTAKE RATE (12 cart arrivals/s):
   - Production monitoring cho thấy peak giờ cao điểm: 12 cart write events/s
   - Đây là số đo từ production traffic, không phải con số tự chọn
   - Test phải mô phỏng ĐÚNG 12/s này để verify capacity
   -> rate = 12, timeUnit = "1s"
   -> lambda = 12 / 1 = 12 arrivals/s

2. WRITE DURATION WINDOW (45s):
   - Cần verify hệ thống giữ được intake trong 45s liên tục
   - Đủ dài để DB write buffer, connection pool, cache ổn định
   - Đủ dài để phát hiện write amplification tích lũy
   -> duration = "45s"
   -> scheduled_slots = 12 × 45 = 540 arrivals

3. ZERO DROP CONTRACT (maxDroppedIterations = 0):
   - Cart write events không được phép bỏ
   - Mỗi drop = một thao tác của user không được xử lý
   - Contract case: không chấp nhận drop nào
   -> maxDroppedIterations = 0
   -> Đây là SLO cứng, không phải "best effort"
```

> **Intake contract là gì?** = cam kết giữa hệ thống và business về số lượng
> event hệ thống có thể hấp thụ mỗi giây. Khác với throughput (có thể giảm
> khi backend chậm), intake contract nói "hệ thống PHẢI nhận đủ 12 event/s,
> nếu không nhận được thì báo lỗi".
>
> ```text
> Throughput (constant-vus):
>   "Tôi xử lý được bao nhiêu thì xử lý"
>   Backend chậm -> throughput tự giảm -> không ai biết
>
> Intake contract (constant-arrival-rate):
>   "Tôi cam kết nhận 12 event/s"
>   Backend chậm -> cần thêm VU -> nếu không đủ VU -> DROP -> báo động
> ```
>
> **Đời thường**: Nhà hàng cam kết phục vụ 100 khách/giờ. Nếu bếp chậm
> (backend), nhà hàng phải thuê thêm bồi bàn (VU) để giữ cam kết. Nếu không
> thuê được thêm (= hết VU pool), khách bỏ đi (= drop). Nhà hàng cần biết
> chính xác có bao nhiêu khách bỏ đi -- đó là `dropped_iterations`.

Yêu cầu cụ thể:

```text
- 12 cart write arrivals mỗi giây, cố định
- Duy trì trong 45 giây liên tục
- Tổng = 540 arrival slots được schedule
- 3 loại operation: add (55%), update (30%), summary (15%)
- preAllocatedVUs=10, maxVUs=30 -- đủ để hấp thụ write latency thông thường
- maxDroppedIterations=0 -- contract cứng, không chấp nhận drop
```

## Vì sao chọn `constant-arrival-rate`?

```text
Vì YÊU CẦU NGHIỆP VỤ là:
  - "12 cart write arrivals/s cố định" -> constant-arrival-rate giữ rate
  - "Không được drop event" -> cần dropped_iterations metric
  - "Write path chậm không được che mất overload" -> open model

Tại sao KHÔNG dùng executor khác?
  - constant-vus (10 VU, 45s): rate = 10/iter_time, write chậm thì rate
    tự giảm -> CHE MẤT overload -> không biết có drop không
  - shared-iterations (540 iter chung): VU nhanh cướp iter của VU chậm,
    không có arrival schedule -> không mô phỏng đúng intake stream
  - per-vu-iterations: không có arrival schedule, rate phụ thuộc iter_time
  - ramping-vus: rate thay đổi theo stage, không giữ được 12/s cố định
  - ramping-arrival-rate: có arrival schedule nhưng rate thay đổi -> phức
    tạp hóa không cần thiết cho fixed intake
```

## Mapping business -> k6 config

Source script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js
```

Default config:

| Field | Value | Ý nghĩa |
| --- | ---: | --- |
| `rate` | `12` | 12 cart arrivals mỗi giây |
| `timeUnit` | `1s` | target = 12 arrivals/s |
| `duration` | `45s` | giữ intake trong 45 giây |
| `preAllocatedVUs` | `10` | worker chuẩn bị sẵn |
| `maxVUs` | `30` | trần worker được mở thêm |
| `maxDroppedIterations` | `0` | không chấp nhận drop trong contract case |
| `userPool` | `500` | pool user identity cho arrival-user-N |

Expected scheduled slots:

```text
lambda = rate / timeUnit_seconds = 12 / 1 = 12 arrivals/s
scheduled_slots = lambda × duration_seconds = 12 × 45 = 540 arrivals
```

Đây là target -- số slot được schedule, không phải số iteration thực tế.
Thực tế có thể 539-541 do boundary rounding khi slot cuối rơi đúng biên
duration.

Env override:

```powershell
$env:CAR_03_RATE = "12"
$env:CAR_03_TIME_UNIT = "1s"
$env:CAR_03_DURATION = "45s"
$env:CAR_03_PREALLOCATED_VUS = "10"
$env:CAR_03_MAX_VUS = "30"
$env:CAR_03_MAX_DROPPED = "0"
$env:CAR_03_USER_POOL = "500"
```

## Phân tích nguyên nhân gốc kỹ thuật (5 RCs)

Mỗi RC giải thích một khía cạnh kỹ thuật của constant-arrival-rate khi áp
dụng vào cart write intake. Mỗi RC có demo trace và code thật.

### RC1: Arrival schedule = fixed timeline, cart writes đến theo lịch

**Bản chất**: Constant-arrival-rate KHÔNG đếm "bao nhiêu user", KHÔNG đếm
"bao nhiêu VU đang chạy". Nó chỉ quan tâm: "đến giây thứ T, slot thứ N
phải được giao cho một VU nào đó".

```text
Schedule cho case 03 (12/s, 45s):
  t=0.000: slot 0   scheduled
  t=0.083: slot 1   scheduled  (1/12 = 0.083s)
  t=0.167: slot 2   scheduled
  t=0.250: slot 3   scheduled
  t=0.333: slot 4   scheduled
  t=0.417: slot 5   scheduled
  t=0.500: slot 6   scheduled
  t=0.583: slot 7   scheduled
  t=0.667: slot 8   scheduled
  t=0.750: slot 9   scheduled
  t=0.833: slot 10  scheduled
  t=0.917: slot 11  scheduled
  t=1.000: slot 12  scheduled  (giây thứ 2)
  ...
  t=44.917: slot 539 scheduled (slot cuối)
```

Khoảng cách giữa 2 slot liên tiếp:

```text
inter_arrival_time = timeUnit_seconds / rate = 1 / 12 ≈ 0.0833s = 83.3ms
```

**Code thật từ common.js**:

```js
export function buildArrivalScenario(en, r, tu, d, p, m, xt = {}) {
  return {
    executor: 'constant-arrival-rate',
    exec: en,
    rate: r,           // 12 -> schedule 12 slot mỗi timeUnit
    timeUnit: tu,      // '1s' -> mỗi giây
    duration: d,       // '45s'
    preAllocatedVUs: p, // 10
    maxVUs: m,          // 30
    tags: { ... }
  };
}
```

**Vì sao schedule quan trọng với cart write?**

```text
Cart write events trong production đến theo nhịp từ clients:
  - User A bấm "Add to cart" lúc 10:00:00.123
  - User B bấm "Add to cart" lúc 10:00:00.206
  - User C bấm "Update quantity" lúc 10:00:00.289
  ...

Khoảng cách giữa các event không đều, nhưng trung bình là 12 event/s.
constant-arrival-rate mô phỏng chính xác điều này: schedule 12 slot/s,
phân bố đều trong giây.

Nếu dùng constant-vus (closed model), không có schedule:
  - VU xong iter -> bắt đầu iter mới NGAY LẬP TỨC
  - Không có khoảng cách 83ms giữa các event
  - Không mô phỏng đúng arrival pattern của production
```

### RC2: Write path (add/update) giữ VU lâu hơn read (summary) -- VU mix thay đổi

**Bản chất**: Không phải mọi cart operation đều giữ VU như nhau.
Add (POST) và update (PATCH) có DB writes, giữ VU lâu hơn summary (GET)
chỉ đọc.

```text
Case 03 weighted branches:
  add (POST):     55% -> có db_writes=1, memory_kb=4
  update (PATCH): 30% -> có db_writes=1
  summary (GET):  15% -> chỉ đọc, db_rows=3, json_items=8

Response time điển hình (Run 91):
  add:     ~5-8ms   (write + memory alloc)
  update:  ~5-8ms   (write)
  summary: ~3-5ms   (read only)

Nhưng với db_writes, latency tail khác biệt:
  add p95:     có thể 15-20ms (memory allocation + WAL)
  update p95:  có thể 10-15ms (index update)
  summary p95: có thể 5-8ms  (read from buffer pool)
```

**Trace execution cho VU mix thay đổi**:

```text
Giây 1: 12 slots, weighted pick:
  slot 0:  add     (55%) -> POST, db_writes=1 -> ~8ms -> VU#1 bận 8ms
  slot 1:  add     (55%) -> POST, db_writes=1 -> ~7ms -> VU#2 bận 7ms
  slot 2:  update  (30%) -> PATCH, db_writes=1 -> ~6ms -> VU#3 bận 6ms
  slot 3:  add     (55%) -> POST -> ~8ms -> VU#4 bận 8ms
  slot 4:  summary (15%) -> GET -> ~4ms -> VU#5 bận 4ms
  slot 5:  add     (55%) -> POST -> ~7ms -> VU#6 bận 7ms
  slot 6:  update  (30%) -> PATCH -> ~6ms -> VU#7 bận 6ms
  slot 7:  add     (55%) -> POST -> ~8ms -> VU#8 bận 8ms
  slot 8:  add     (55%) -> POST -> ~7ms -> VU#9 bận 7ms
  slot 9:  update  (30%) -> PATCH -> ~6ms -> VU#10 bận 6ms
  slot 10: add     (55%) -> POST -> ~8ms -> CẦN VU MỚI (VU#11)
  slot 11: summary (15%) -> GET -> ~4ms -> CẦN VU MỚI (VU#12)

  -> 10 preAllocatedVUs không đủ cho 12 slot nếu tất cả cùng bận
  -> Nhưng VU#1 xong sau 8ms, có thể nhận slot 12 (t=1.000s)
  -> Thực tế: 10 VU thường đủ vì latency thấp (p95=6ms)
  -> NHƯNG: nếu DB chậm, add/update lên 80ms:
     cần ceil(12 × 0.08) = ceil(0.96) = 1 VU (lý thuyết)
     nhưng với mix: 85% events là write (giữ VU 80ms) + 15% read (giữ VU 5ms)
     -> VU yêu cầu trung bình: 12 × (0.85 × 0.08 + 0.15 × 0.005)
                              = 12 × (0.068 + 0.00075)
                              = 12 × 0.06875
                              = 0.825 VU
     -> Vẫn ổn với 10 VU
```

**Code thật cho weighted pick**:

```js
const choice = weightedPick([
  { name: 'add', weight: 55 },
  { name: 'update', weight: 30 },
  { name: 'summary', weight: 15 },
], ctx.iter);
```

và:

```js
export function weightedPick(items, n) {
  const t = items.reduce((s, i) => s + i.weight, 0); // total = 100
  const pk = n % t;  // deterministic pick từ iter number
  let c = 0;
  for (const i of items) {
    c += i.weight;
    if (pk < c) return i.name;
  }
  return items[items.length - 1].name;
}
```

**Điểm quan trọng**: `weightedPick` dùng `n % t` với `n = ctx.iter`
(`exec.scenario.iterationInTest`). Đây là **deterministic** -- cùng iter
number luôn cho cùng branch. Điều này giúp test reproducible, nhưng cũng
có nghĩa branch sequence là cố định qua các lần chạy (trừ khi seed thay đổi).

### RC3: dropped_iterations = write intake contract breach

**Bản chất**: `dropped_iterations` là metric QUAN TRỌNG NHẤT của case này.
Nó không phải "request fail". Nó là "slot được schedule nhưng không có VU
nào nhận".

```text
Cơ chế drop trong k6 constant-arrival-rate:

1. Scheduler: "đến giờ chạy slot N"
2. k6 tìm VU rảnh trong pool
3. Nếu có VU rảnh -> giao slot -> VU chạy default()
4. Nếu KHÔNG có VU rảnh:
   a. Nếu active VUs < maxVUs -> spawn VU mới -> giao slot
   b. Nếu active VUs == maxVUs -> KHÔNG spawn được -> DROP slot
      -> dropped_iterations++
5. Slot tiếp theo được schedule bình thường (không delay)
```

**Ví dụ cụ thể với cart write**:

```text
Config: rate=12, preAllocatedVUs=10, maxVUs=30

Bình thường (Run 91):
  - Mỗi event mất ~6ms (p95)
  - 12 events/s × 0.006s = 0.072 VU-giây
  - Cần ceil(0.072) = 1 VU là đủ về lý thuyết
  - 10 preAllocatedVUs dư rất nhiều
  - maxVUs=30 dư càng nhiều
  -> 0 dropped

Khi DB write chậm (giả sử p95=250ms):
  - Mỗi event mất ~250ms
  - 12 events/s × 0.250s = 3.0 VU-giây
  - Cần ceil(3.0) = 3 VU
  - 10 preAllocatedVUs vẫn đủ
  -> 0 dropped

Khi DB write rất chậm (p95=3000ms = 3s):
  - Mỗi event mất ~3s
  - Tại giây thứ 1: 12 events bắt đầu, mỗi event giữ VU 3s
  - Tại giây thứ 2: 12 events nữa bắt đầu -> 24 VU đang bận
  - Tại giây thứ 3: 12 events nữa -> cần 36 VU
  - maxVUs=30 -> 6 slot bị drop trong giây thứ 3
  -> dropped_iterations = 6
```

**Công thức drop**:

```text
N_drop = số slot được schedule nhưng không có VU nhận

Điều kiện drop:
  active_VUs_at_schedule_time >= maxVUs
  VÀ không có VU nào hoàn thành kịp để nhận slot mới

Công thức ước lượng:
  required_VUs ≈ ceil(lambda × W_effective)
  trong đó:
    lambda = rate / timeUnit_seconds = 12
    W_effective = p95 event duration (giây)

  Nếu required_VUs > maxVUs -> sẽ có drop
  Số drop ≈ (required_VUs - maxVUs) × duration_seconds / W_effective

Ví dụ với W_effective = 3s:
  required_VUs ≈ ceil(12 × 3) = 36
  36 > 30 -> drop
  drop ≈ (36 - 30) × 45 / 3 = 6 × 15 = 90 slots bị drop
```

**Code thật -- threshold**:

```js
thresholds: {
  dropped_iterations: [`count<=${MAX_DROPPED}`],  // MAX_DROPPED = 0
}
```

Threshold này là SLO cứng. Nếu count > 0, test FAIL -- contract breach.

### RC4: DB writes gây latency amplification mà closed model che mất

**Bản chất**: Khi dùng constant-vus (closed model), DB write chậm làm
vòng lặp VU chậm lại, throughput tự giảm. Nhìn qua tưởng "hệ thống vẫn
ổn" nhưng thực ra đang giảm intake. Constant-arrival-rate (open model)
phơi bày vấn đề này.

```text
So sánh 2 model với cùng DB write latency spike:

Tình huống: t=20s, DB WAL flush bắt đầu, write latency từ 5ms -> 200ms

=== CLOSED MODEL (constant-vus, 10 VU) ===
Trước spike (t=0-20s):
  iter_time = 5ms
  rate = 10 / 0.005 = 2000 events/s

Trong spike (t=20-30s):
  iter_time = 200ms
  rate = 10 / 0.200 = 50 events/s

Sau spike (t=30-45s):
  iter_time = 5ms
  rate = 2000 events/s

Kết quả summary:
  iterations: 2000×20 + 50×10 + 2000×15 = 40000 + 500 + 30000 = 70500
  dropped: không có khái niệm
  http_req_failed: 0%

Nhìn summary: "70500 events, 0 fail -> hệ thống ổn!"
Nhưng SỰ THẬT: trong 10s spike, intake chỉ còn 50/s thay vì 2000/s.
Production intake là 12/s cố định -- giảm xuống 50/s vẫn trên target,
nên có vẻ OK. Nhưng nếu production intake thật sự là 2000/s, thì 50/s
là thảm họa.

=== OPEN MODEL (constant-arrival-rate, rate=12, maxVUs=30) ===
Trước spike (t=0-20s):
  rate schedule = 12/s
  iter_time = 5ms
  active VUs ≈ ceil(12 × 0.005) = 1
  dropped = 0

Trong spike (t=20-30s):
  rate schedule = 12/s (VẪN 12/s!)
  iter_time = 200ms
  active VUs ≈ ceil(12 × 0.200) = ceil(2.4) = 3
  Vẫn trong pool 30 -> dropped = 0
  NHƯNG: VUs tăng từ 1 lên 3 -> dấu hiệu cảnh báo

Sau spike (t=30-45s):
  rate schedule = 12/s
  iter_time = 5ms
  active VUs ≈ 1
  dropped = 0

Kết quả summary:
  iterations ≈ 540
  dropped = 0
  vus_max = 3 (tăng từ 1)

Nhìn summary: "540 events, 0 drop, VUs tăng lên 3"
-> Biết CHÍNH XÁC: intake vẫn giữ 12/s, nhưng cần thêm VU trong spike
-> Cảnh báo: DB write latency tăng có thể gây drop nếu nặng hơn
```

**Bài học**:

```text
Closed model (constant-vus):
  - CHE MẤT intake reduction
  - Không phân biệt được "hệ thống chậm nhưng vẫn nhận đủ"
    với "hệ thống chậm và đang bỏ event"

Open model (constant-arrival-rate):
  - PHƠI BÀY intake reality
  - VUs tăng = tín hiệu: hệ thống đang cần thêm worker để giữ intake
  - Dropped > 0 = tín hiệu: hệ thống không giữ nổi intake contract
```

### RC5: Weighted branch mix ảnh hưởng đến VU demand distribution

**Bản chất**: Với 55% add, 30% update, 15% summary, phân phối VU demand
không đều. Add events (55%) chiếm phần lớn VU time, nhưng update events
(30%) cũng đáng kể.

```text
Phân tích VU demand theo branch (Run 91, p95 latency):

add (55%):     55% × 541 = ~298 events
  latency p95: ~8ms (write + memory)
  VU-giây: 298 × 0.008 = 2.38

update (30%):  30% × 541 = ~162 events
  latency p95: ~7ms (write)
  VU-giây: 162 × 0.007 = 1.13

summary (15%): 15% × 541 = ~81 events
  latency p95: ~5ms (read only)
  VU-giây: 81 × 0.005 = 0.41

Tổng VU-giây: 2.38 + 1.13 + 0.41 = 3.92
Phân bố trên 45s: 3.92 / 45 = 0.087 VU trung bình
-> Rất thấp, 10 preAllocatedVUs dư nhiều
```

**Nhưng khi latency tăng (giả sử p95 add=200ms, update=150ms, summary=50ms)**:

```text
add (55%):     298 × 0.200 = 59.6 VU-giây
update (30%):  162 × 0.150 = 24.3 VU-giây
summary (15%): 81 × 0.050 = 4.05 VU-giây

Tổng: 59.6 + 24.3 + 4.05 = 87.95 VU-giây
Phân bố trên 45s: 87.95 / 45 ≈ 1.95 VU trung bình
-> Vẫn ổn với 10 VU

Nhưng PEAK demand (khi nhiều add xếp chồng):
  Giả sử 8/12 slot trong 1 giây là add:
  8 × 0.200 = 1.6 VU-giây trong 1 giây
  + 3 update: 3 × 0.150 = 0.45
  + 1 summary: 1 × 0.050 = 0.05
  Peak: 2.1 VU đồng thời
  -> 10 VU vẫn đủ
```

**Khi nào mix gây vấn đề?**

```text
Nếu add weight tăng từ 55% lên 80% (nhiều user thêm hàng hơn):
  add (80%):     433 × 0.200 = 86.6 VU-giây
  update (15%):  81 × 0.150 = 12.15 VU-giây
  summary (5%):  27 × 0.050 = 1.35 VU-giây
  Tổng: 100.1 VU-giây / 45s = 2.22 VU trung bình
  -> Vẫn ổn

Nhưng nếu add latency lên 500ms (DB index rebuild):
  add (55%):     298 × 0.500 = 149 VU-giây
  Tổng các branch khác: ~25 VU-giây
  Tổng: 174 VU-giây / 45s = 3.87 VU trung bình
  Peak: 8 add × 0.500 = 4.0 VU đồng thời
  -> Vẫn ổn với 10 VU

Add latency lên 3000ms (DB deadlock):
  add: 298 × 3.0 = 894 VU-giây
  Tổng: ~920 VU-giây / 45s = 20.4 VU trung bình
  Peak: 8 add × 3.0 = 24 VU đồng thời
  -> 24 < 30 maxVUs -> vẫn ổn, nhưng headroom chỉ còn 6 VU
```

## Identity model deep-dive

Đây là phần giải thích `__VU` và identity trong constant-arrival-rate,
so sánh với các executor khác.

### Bảng so sánh identity model

| Executor | `__VU` nghĩa là gì? | User identity bound vào đâu? | State có giữ qua iter không? |
| --- | --- | --- | --- |
| **per-vu-iterations** | identity cố định, mỗi VU = 1 user | `__VU` | CÓ -- module-level scope |
| **constant-arrival-rate** | anonymous worker, không có identity | KHÔNG bound vào VU | KHÔNG -- mỗi iter = VU khác |
| constant-vus | VU trong pool, reuse | `__VU` nhưng không cố định | CÓ -- nhưng user thay đổi |
| shared-iterations | VU cướp việc từ pool chung | KHÔNG bound | KHÔNG |

### Trong constant-arrival-rate: `__VU` là anonymous worker

```text
constant-arrival-rate KHÔNG có khái niệm "VU nào thuộc user nào".
Mỗi VU chỉ là một worker được giao một arrival slot để xử lý.

Trace cho case 03:
  t=0.000: slot 0  -> VU#1 nhận, chạy cartWriteIntake()
  t=0.083: slot 1  -> VU#2 nhận, chạy cartWriteIntake()
  t=0.167: slot 2  -> VU#3 nhận, chạy cartWriteIntake()
  ...
  t=0.833: slot 10 -> VU#1 nhận (VU#1 đã xong slot 0, rảnh trở lại)
                       -> VU#1 xử lý slot 10 với user KHÁC slot 0

VU#1 xử lý slot 0 (user arrival-user-1) và slot 10 (user arrival-user-297)
-> KHÔNG có identity binding giữa VU và user
```

### User identity trong case 03: `arrival-user-N`

```text
Cart write intake không cần "user thật". Mỗi cart event đến từ một user
khác nhau trong production. Identity được tạo từ iteration number:

  userId = `arrival-user-${(iter % userPool) + 1}`

Với userPool=500:
  iter 0   -> arrival-user-1
  iter 1   -> arrival-user-2
  ...
  iter 499 -> arrival-user-500
  iter 500 -> arrival-user-1   (quay vòng)
  iter 540 -> arrival-user-41

User ID chỉ dùng để gắn tag `X-User-ID` header và metric tags.
KHÔNG có session, KHÔNG có state giữa các iter.
Mỗi event là độc lập -- giống production thật.
```

**Code thật**:

```js
export function userContext(seed = 'arrival', up = 500) {
  const it = exec.scenario.iterationInTest;
  const p = Math.max(1, up);
  const un = (it % p) + 1;
  return {
    seed,
    vuId: exec.vu.idInTest,
    iter: it,
    scenarioIter: exec.scenario.iterationInInstance,
    userId: `arrival-user-${un}`,
    requestKey: `${seed}-${it}-${exec.vu.idInTest}`,
    abVariant: it % 2 === 0 ? 'b' : 'a',
  };
}
```

### So sánh với case 01 (per-vu-iterations)

```text
Case 01 (per-vu-iterations):
  - __VU = qa-user-${__VU} (identity BOUND vào VU)
  - VU#1 LUÔN là qa-user-1 qua mọi iter
  - Có session, cart state tích lũy qua iter
  -> Phù hợp regression test: replay journey của cùng user

Case 03 (constant-arrival-rate):
  - __VU = worker vô danh
  - userId = arrival-user-N (từ iter number, KHÔNG từ VU)
  - Không session, không state
  -> Phù hợp intake test: mỗi event độc lập, đến từ user ngẫu nhiên
```

## Phân tích open model

### Open model là gì?

```text
Open model = số event đến hệ thống KHÔNG phụ thuộc vào số event đang
được xử lý. Giống như khách vào siêu thị -- số khách đến mỗi phút không
phụ thuộc vào việc có bao nhiêu khách đang đứng trong siêu thị.

Closed model = số event trong hệ thống là cố định (VUs). Khi một event
xong, event mới bắt đầu. Giống như 10 nhân viên phục vụ 10 khách -- chỉ
khi khách trước xong, khách sau mới vào.
```

### Open model với cart write intake

```text
Case 03 là OPEN MODEL:
  - 12 cart write events đến mỗi giây, KHÔNG PHỤ THUỘC vào:
    * Có bao nhiêu event đang được xử lý
    * Có bao nhiêu VU đang bận
    * Cart service đang nhanh hay chậm
  - Nếu cart service chậm -> cần THÊM VU để xử lý kịp
  - Nếu không đủ VU -> event bị DROP (không tự delay)

Đây chính xác là behavior của production:
  - Users không ngừng thao tác chỉ vì backend đang chậm
  - Nếu backend không xử lý kịp -> user thấy lỗi (timeout) hoặc
    request bị drop ở load balancer
```

### Ví dụ cụ thể: điều gì xảy ra khi DB write chậm?

```text
Scenario: Cart service đang xử lý bình thường (5ms/event).
Đột nhiên DB write latency tăng lên 200ms do WAL flush.

=== OPEN MODEL (constant-arrival-rate) ===
t=0.000s: slot 0, add event, VU#1 nhận -> 200ms
t=0.083s: slot 1, add event, VU#2 nhận -> 200ms
t=0.167s: slot 2, update event, VU#3 nhận -> 200ms
t=0.250s: slot 3, add event, VU#4 nhận -> 200ms
t=0.333s: slot 4, summary event, VU#5 nhận -> 50ms (read nhanh hơn)
t=0.417s: slot 5, add event, VU#6 nhận -> 200ms
t=0.500s: slot 6, update event, VU#7 nhận -> 200ms
t=0.583s: slot 7, add event, VU#8 nhận -> 200ms
t=0.667s: slot 8, add event, VU#9 nhận -> 200ms
t=0.750s: slot 9, update event, VU#10 nhận -> 200ms
t=0.833s: slot 10, add event -> CẦN VU MỚI (VU#1-#10 đang bận)
                              -> spawn VU#11 -> 200ms
t=0.917s: slot 11, summary -> spawn VU#12 -> 50ms
t=1.000s: slot 12, add event -> spawn VU#13 -> 200ms
...

Tại t=0.200s: VU#1 xong slot 0, rảnh -> nhận slot tiếp theo
Tổng VU cần: không quá 15 VU đồng thời (tùy timing)
-> 15 < 30 maxVUs -> 0 dropped

Nhưng nếu DB latency lên 3000ms:
  Mỗi event giữ VU 3s
  Trong 3s: 36 events được schedule
  -> Cần 36 VU đồng thời
  -> 36 > 30 maxVUs -> 6 events bị drop

=== CLOSED MODEL (constant-vus, 10 VU) ===
Trước spike: rate ≈ 2000 events/s
Trong spike: rate ≈ 50 events/s (tự giảm!)
Sau spike: rate ≈ 2000 events/s

Kết quả: "hệ thống vẫn chạy, không lỗi"
Nhưng SỰ THẬT: intake tự giảm 40 lần trong spike
-> CHE MẤT vấn đề
```

### Công thức VU demand trong open model

```text
Công thức cơ bản:
  required_VUs ≈ ceil(lambda × W)

Trong đó:
  lambda = rate / timeUnit_seconds = arrival rate (events/s)
  W = thời gian xử lý 1 event (s)

Với case 03:
  lambda = 12 / 1 = 12 events/s
  W = 0.006s (p95, Run 91)
  required_VUs ≈ ceil(12 × 0.006) = ceil(0.072) = 1 VU

Với capacity:
  capacity = maxVUs / W = 30 / 0.006 = 5000 events/s
  -> Dư rất nhiều so với 12/s

Với W = 3s (DB deadlock scenario):
  required_VUs ≈ ceil(12 × 3) = 36 VU
  capacity = 30 / 3 = 10 events/s
  -> 10 < 12 -> KHÔNG ĐỦ -> drop!
```

### Vì sao preAllocatedVUs=10 mà capacity tính ra chỉ 1 VU?

```text
Đây là chỗ nhiều người mới nhầm:

Tính toán lý thuyết:
  required_VUs = ceil(12 × 0.006) = 1 VU

Nhưng thực tế cần 10 preAllocatedVUs vì:
  1. Arrival không đều -- 12 slot/s nhưng có thể dồn vào đầu giây
  2. Latency không đều -- p95=6ms nhưng max=162ms (Run 91)
  3. Write amplification -- add/update events nặng hơn summary
  4. Spawn VU mới mất thời gian -- preAllocatedVUs giúp có sẵn worker
  5. Safety margin -- nếu latency tăng nhẹ, đã có VU dự phòng

Công thức thực tế:
  preAllocatedVUs = ceil(lambda × W_p95 × safety_factor)
                  = ceil(12 × 0.006 × 10)
                  ≈ ceil(0.72)
                  = 1 VU (vẫn ít)

Nhưng với safety_factor cho write amplification và latency spike:
  preAllocatedVUs nên >= ceil(lambda × W_p99 × 3)
                        = ceil(12 × 0.162 × 3)
                        = ceil(5.83)
                        = 6 VU

10 VU là con số an toàn, dư để hấp thụ spike.
```

## Bảng service/API flow

### Endpoint flow

Weighted branches -- mỗi arrival event gọi đúng 1 API call:

| Branch | Weight | Method | Endpoint | Query params | Body | Ý nghĩa |
| --- | ---: | --- | --- | --- | --- | --- |
| `add` | 55% | POST | `/api/sim/cart/add` | `cpu_ms=1&db_writes=1&memory_kb=4` | `{product_id, quantity: 1}` | Thêm sản phẩm vào giỏ |
| `update` | 30% | PATCH | `/api/sim/cart/items/:item_id` | `cpu_ms=1&db_writes=1` | `{quantity: (iter%3)+1}` | Cập nhật số lượng |
| `summary` | 15% | GET | `/api/sim/cart/summary` | `cpu_ms=1&db_rows=3&json_items=8` | -- | Đọc summary giỏ hàng |

### Số lượng dự kiến theo branch (Run 91, 541 iterations)

| Branch | Weight | Expected count (541 × weight) | Thực tế xấp xỉ |
| --- | ---: | ---: | ---: |
| `add` | 55% | 541 × 0.55 = 297.55 ≈ 298 | ~298 |
| `update` | 30% | 541 × 0.30 = 162.3 ≈ 162 | ~162 |
| `summary` | 15% | 541 × 0.15 = 81.15 ≈ 81 | ~81 |
| **Tổng** | **100%** | **541** | **541** |

### Service tags gắn trên mỗi operation

| Operation tag | service tag | endpoint tag | user_id tag |
| --- | --- | --- | --- |
| `cart_arrival_add` | `cart-service` | `POST /api/sim/cart/add` | `arrival-user-N` |
| `cart_arrival_update` | `cart-service` | `PATCH /api/sim/cart/items/:item_id` | `arrival-user-N` |
| `cart_arrival_summary` | `cart-service` | `GET /api/sim/cart/summary` | `arrival-user-N` |

### Mối quan hệ giữa iterations, events, và API calls

```text
Case 03: mỗi iteration = 1 event = 1 API call

iterations ≈ constant_arrival_events_total ≈ constant_arrival_api_calls_total ≈ http_reqs

Run 91:
  iterations = 541
  constant_arrival_events_total = 541
  constant_arrival_api_calls_total = 541
  http_reqs = 541

Tất cả bằng nhau vì:
  - Mỗi iteration gọi finishEvent() đúng 1 lần
  - Mỗi iteration gọi requestJson() đúng 1 lần
  - requestJson() gọi http.*() đúng 1 lần
  -> 1 iteration = 1 event = 1 API call = 1 HTTP request

SO VỚI case 01 (per-vu-iterations):
  - 1 iteration = 1 journey = ~8 HTTP requests
  - iterations = 150, http_reqs = ~1200
  -> iterations KHÔNG bằng http_reqs
```

## Metrics & tags deep-dive

### Tất cả metrics trong case 03

| Metric | Loại | Ý nghĩa | Tags |
| --- | --- | --- | --- |
| `constant_arrival_events_total` | Counter | Số arrival event đã hoàn thành | case_id, service, operation, user_id |
| `constant_arrival_events_failed` | Counter | Số event thất bại (status code không khớp) | case_id, service, operation, user_id |
| `constant_arrival_api_calls_total` | Counter | Số API call đã gửi | case_id, service, operation, endpoint, user_id |
| `constant_arrival_event_duration_ms` | Trend | Thời gian hoàn thành 1 event (ms) | case_id, service, operation, user_id |
| `dropped_iterations` | Counter | Số slot bị drop (k6 metric có sẵn) | (không có tags tùy chỉnh) |
| `iterations` | Counter | Tổng iteration đã chạy (k6 metric có sẵn) | scenario, group |
| `http_reqs` | Counter | Tổng HTTP request (k6 metric có sẵn) | method, url, status, ... |
| `http_req_duration` | Trend | HTTP request duration (k6 metric có sẵn) | method, url, status, ... |
| `http_req_failed` | Rate | Tỷ lệ request thất bại (k6 metric có sẵn) | method, url, status, ... |
| `checks` | Rate | Tỷ lệ check pass (k6 metric có sẵn) | check name |
| `vus` | Gauge | Số VU active (k6 metric có sẵn) | -- |
| `vus_max` | Gauge | Số VU tối đa đã dùng (k6 metric có sẵn) | -- |

### Tags deep-dive: case_id, service, operation, endpoint

```text
Mỗi API call trong case 03 được gắn tags chi tiết:

case_id:    "car-03-cart-write-intake"
            -> Định danh case, dùng để lọc kết quả theo case

service:    "cart-service"
            -> Service được test, dùng để group metric theo service

operation:  "cart_arrival_add" | "cart_arrival_update" | "cart_arrival_summary"
            -> Loại operation, dùng để phân biệt write vs read path

endpoint:   "POST /api/sim/cart/add" | "PATCH /api/sim/cart/items/:item_id"
            | "GET /api/sim/cart/summary"
            -> Route cụ thể, dùng để xác định API nào chậm/lỗi

user_id:    "arrival-user-N"
            -> User identity, dùng để trace nếu có lỗi theo user
```

### Cách reconcile write events vs read events

```text
Từ tags, có thể tách metric theo operation:

constant_arrival_events_total{operation="cart_arrival_add"}     ~= 298
constant_arrival_events_total{operation="cart_arrival_update"}  ~= 162
constant_arrival_events_total{operation="cart_arrival_summary"} ~= 81

Tổng: 298 + 162 + 81 = 541 ✓

constant_arrival_event_duration_ms (p95) theo operation:
  cart_arrival_add:     ~8ms   (write nặng hơn)
  cart_arrival_update:  ~7ms   (write)
  cart_arrival_summary: ~5ms   (read only)

Nếu add p95 >> update p95 >> summary p95 -> DB write là bottleneck
Nếu tất cả cùng tăng -> vấn đề chung (network, CPU, mem)
Nếu chỉ summary tăng -> read path / cache issue
```

### Event duration vs HTTP request duration

```text
constant_arrival_event_duration_ms:
  - Đo từ lúc bắt đầu cartWriteIntake() đến lúc finishEvent()
  - Bao gồm: weightedPick + requestJson + finishEvent
  - Đây là "business event duration"

http_req_duration:
  - Đo từ lúc gửi HTTP request đến lúc nhận response
  - Chỉ bao gồm network + server processing
  - KHÔNG bao gồm weightedPick, finishEvent overhead

Thông thường:
  event_duration ≈ http_req_duration + 0.1-0.5ms (JS overhead)

Run 91:
  constant_arrival_event_duration_ms p95: 6ms
  http_req_duration p95: ~5-6ms (gần bằng nhau vì overhead nhỏ)
```

### Vì sao cần cả constant_arrival_events_failed?

```text
constant_arrival_events_failed đếm event thất bại -- khi status code
không khớp expected (200).

Khác với http_req_failed:
  - http_req_failed: request có status >= 400 HOẶC lỗi network
  - constant_arrival_events_failed: check status không pass (vd status=201
    nhưng expected=200)

Trong case 03, expected status = [200] cho tất cả operation.
Nếu API trả về 201, http_req_failed = 0 (vì < 400) nhưng
constant_arrival_events_failed > 0 (vì check status thất bại).

-> Cần cả 2 metric để có bức tranh đầy đủ.
```

### Thresholds đầy đủ

```js
thresholds: {
  checks: ['rate>0.99'],
  // >= 99% checks pass. Mỗi request có 1 check status.
  // Với 541 requests, tối đa 5 checks fail thì vẫn pass threshold.

  http_req_failed: ['rate<0.01'],
  // < 1% HTTP requests fail (status >= 400 hoặc network error)
  // Với 541 requests, tối đa 5 requests fail.

  dropped_iterations: [`count<=0`],
  // CONTRACT CỨNG: 0 drop. Đây là SLO chính của case.

  constant_arrival_events_failed: ['count<10'],
  // < 10 events failed (check status không pass)
  // Cao hơn threshold khác vì đây là "cảnh báo sớm", không phải SLO cứng.
},
```

## Pass criteria

### Bảng pass criteria mở rộng

| Check | Pass khi | Ý nghĩa business | Mức độ |
| --- | --- | --- | --- |
| `dropped_iterations` | `count <= 0` | Không event nào bị bỏ -> intake contract được giữ | **SLO cứng** |
| `iterations` | gần `540` (539-541) | Đủ số slot được schedule -> test workload đúng | **Validation** |
| `checks` | `rate > 0.99` | >= 99% checks pass -> API responses đúng status | **SLO** |
| `http_req_failed` | `rate < 0.01` | < 1% HTTP errors -> cart service hoạt động | **SLO** |
| `constant_arrival_events_failed` | `count < 10` | < 10 event failures -> không có lỗi hệ thống | **Cảnh báo** |
| `constant_arrival_events_total` | gần `iterations` | Events = iterations -> mỗi iter = 1 event | **Validation** |
| `constant_arrival_api_calls_total` | gần `http_reqs` | API calls = HTTP requests -> mỗi event = 1 call | **Validation** |
| `constant_arrival_event_duration_ms` (p95) | < 100ms | p95 latency trong ngưỡng -> headroom còn nhiều | **Cảnh báo** |
| `vus_max` | < `maxVUs` (30) | Chưa chạm trần VU -> còn capacity dự phòng | **Cảnh báo** |

### Pass criteria cho Run 91

```text
Run 91 results:
  iterations: 541                         -> gần 540 ✓
  dropped_iterations: 0                   -> PASS (SLO cứng) ✓
  checks: 100%                            -> PASS ✓
  http_req_failed: 0%                     -> PASS ✓
  constant_arrival_events_failed: 0       -> PASS ✓
  constant_arrival_events_total: 541      -> = iterations ✓
  constant_arrival_api_calls_total: 541   -> = http_reqs ✓
  constant_arrival_event_duration_ms p95: 6ms -> PASS (<< 100ms) ✓
  vus_max: ~10-12                         -> < 30 ✓

Kết luận: PASS -- cart service hấp thụ được 12 cart write arrivals/s.
```

### Vì sao iterations = 541 chứ không phải 540?

```text
Lý thuyết: 12/s × 45s = 540 slots

Thực tế Run 91: 541 iterations

Nguyên nhân: boundary scheduling.
  - k6 schedule slot dựa trên thời gian bắt đầu
  - Slot cuối cùng có thể rơi vào t=45.000s (vẫn trong duration)
  - Hoặc t=44.917s (slot 539), và một slot bonus ở t=45.000s

Công thức chính xác:
  N_sched = floor(lambda × duration_seconds) hoặc ceil()

Với lambda=12, duration=45:
  floor(12 × 45) = 540
  ceil(12 × 45) = 540
  -> Không có fractional slot

Nhưng thực tế: duration được tính từ thời điểm test bắt đầu,
với sai số floating-point và cách k6 implement iteration scheduling,
có thể sinh thêm 1 slot ở biên.

541 iterations, 0 dropped -> contract vẫn pass vì:
  - Không thiếu slot nào (540 hoặc hơn)
  - Không drop nào
  - Đây là "bonus slot", không phải lỗi
```

## Cách chạy

> Stack setup chung: xem RUN_GUIDE.md. Phần dưới chỉ ghi vars + command
> đặc thù cho case này.

```powershell
# 1. Đảm bảo stack đã start (xem RUN_GUIDE)
# 2. Set env vars
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

# 3. Run với cloud output (xem result trên UI)
cd "E:\Khoa hoc\k6"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js"

# Hoặc run local nếu không cần UI
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js"
```

**Env override đầy đủ**:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:CAR_03_RATE = "12"
$env:CAR_03_TIME_UNIT = "1s"
$env:CAR_03_DURATION = "45s"
$env:CAR_03_PREALLOCATED_VUS = "10"
$env:CAR_03_MAX_VUS = "30"
$env:CAR_03_MAX_DROPPED = "0"
$env:CAR_03_USER_POOL = "500"
```

**Smoke test với rate thấp hơn**:

```powershell
# Smoke: chỉ 2 arrivals/s để verify flow nhanh
$env:CAR_03_RATE = "2"
$env:CAR_03_DURATION = "10s"
$env:CAR_03_MAX_VUS = "5"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js"
```

**Verify trên UI** (sau khi run xong):

```text
1. Mở http://localhost:13001
2. Paste student-token-1234567890
3. Click vào run mới nhất
4. Tile "iterations" hiển thị gần 540 ✓
5. Tile "dropped_iterations" = 0 ✓
6. Tile "http_req_duration" p95 < 100ms ✓
```

## Phân tích output 5 bước

### Bước 1: Verify config [Header]

```text
Header in:    executor = constant-arrival-rate
              rate = 12, timeUnit = 1s, duration = 45s
              preAllocatedVUs = 10, maxVUs = 30

Config có:    rate=12, timeUnit="1s", duration="45s" ✓
              preAllocatedVUs=10, maxVUs=30 ✓
```

### Bước 2: Tính expected slots [CT]

```text
lambda = rate / timeUnit_seconds = 12 / 1 = 12 arrivals/s
scheduled_slots = lambda × duration_seconds = 12 × 45 = 540

Hoặc với floor/ceil:
  expected_iterations ≈ 540
  (chấp nhận 539-541 do boundary scheduling)
```

### Bước 3: So N_done với expected [CT 5]

```text
Summary cho:  iterations = 541
Tỷ lệ:        541 / 540 = 100.2% -> gần expected, OK

Nếu iterations < 540: kiểm tra dropped_iterations
  - Nếu dropped > 0: VU pool không đủ, contract breach
  - Nếu dropped = 0: có thể bị interrupt (maxDuration), không phải case này
```

### Bước 4: Verify dropped_iterations và failed events

```text
Summary:      dropped_iterations = 0
              constant_arrival_events_failed = 0
              http_req_failed = 0%
              checks = 100%

Nếu dropped > 0:
  -> Đọc vus_max: nếu vus_max == maxVUs -> pool cạn, cần tăng maxVUs
  -> Đọc event_duration: nếu p95 cao -> write path chậm
  -> Đọc operation breakdown: write nào chậm nhất?

Nếu events_failed > 0:
  -> Đọc operation tag: fail tập trung ở add/update hay summary?
  -> add/update fail: DB write issue
  -> summary fail: read/cache issue
  -> Tất cả fail: hệ thống chung (network, auth, ...)

KẾT LUẬN: test thành công nếu 0 drop + 0 failed
```

### Bước 5: Phân tích event duration và VU pressure

```text
Run 91:
  constant_arrival_event_duration_ms p95 = 6ms
  vus_max ≈ 10-12
  maxVUs = 30 -> headroom = 30 - 12 = 18 VUs

Công thức kiểm tra headroom:
  required_VUs = ceil(lambda × event_duration_p95)
               = ceil(12 × 0.006)
               = ceil(0.072)
               = 1 VU (lý thuyết)

  headroom = maxVUs - vus_max_actual
           = 30 - 12
           = 18 VUs

  capacity_at_p95 = maxVUs / event_duration_p95
                  = 30 / 0.006
                  = 5000 events/s

  current_usage = rate / capacity_at_p95
                = 12 / 5000
                = 0.24% capacity sử dụng

Đánh giá:
  - Headroom rất lớn (18 VUs)
  - Capacity sử dụng rất thấp (0.24%)
  - Có thể tăng rate lên nhiều mà vẫn không drop
  - Hoặc giảm preAllocatedVUs, maxVUs để tiết kiệm resource
```

## Đọc dashboard real-time charts cho case 03

Sau khi chạy, mở dashboard:

```text
http://localhost:13001/
```

Paste token, chọn run mới nhất. Phần này giải thích cách đọc các biểu đồ
real-time và tab Executor cho constant-arrival-rate.

Trước khi đọc chi tiết, nhớ bảng này:

| Biểu đồ / tab | Nó trả lời câu hỏi gì? | Không nên dùng để làm gì? |
| --- | --- | --- |
| Response time | Cart operation nhanh/chậm theo từng giây? Add khác update khác summary không? | Không thay thế final summary p95 |
| Execution timeline | Tại mỗi giây có bao nhiêu VU, bao nhiêu request, bao nhiêu iteration? Drop không? | Không đọc mỗi point như 1 iteration |
| VUs vs iter/s | Executor VU envelope và iter/s theo bucket có khớp không? | Không kỳ vọng iter/s từng giây bằng 12 |
| Executor tab | Shape thực tế có đúng mô hình constant-arrival-rate không? Dropped_iterations khớp summary? | Không dùng để verify latency |

Một cách đọc nhanh:

```text
Response time      -> chất lượng cart operation (add vs update vs summary)
Execution timeline -> arrival stream có đều 12/s không?
VUs vs iter/s      -> iteration throughput theo executor shape
Executor tab       -> mô hình open model có chạy đúng không? Có drop không?
```

### Chart 1 -- Response time

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

**Điểm đặc biệt của case 03**: Với 3 loại operation (add/update/summary),
response time chart nên được đọc **theo operation tag** để phân biệt
write path vs read path.

```text
Đọc chung (không filter):
  - avg response: ~5ms
  - p95: ~6ms
  - max: ~162ms (Run 91)

Đọc riêng theo operation (nếu dashboard hỗ trợ filter theo tag):
  cart_arrival_add avg:     ~6-8ms  (write)
  cart_arrival_update avg:  ~5-7ms  (write)
  cart_arrival_summary avg: ~3-5ms  (read)

  -> add/update chậm hơn summary ~2-3ms
  -> DB write overhead ~2-3ms cho mỗi write event
```

**Cách phân tích sâu chart Response time cho case 03**:

Khi nhìn chart này, đọc theo 4 câu hỏi:

```text
1. Avg response có ổn định không?
2. Batch p95 có spike ở đoạn nào?
3. Batch max có outlier lớn không?
4. Spike có tương quan với add/update events không?
```

Với case 03, chart đẹp thường có shape:

```text
toàn bộ run: p95 thấp và ổn định (quanh 5-8ms)
không có spike lớn
max có thể có vài outlier (162ms) nhưng không kéo dài
```

Vì sao max có thể lên 162ms?

```text
Run 91: max latency = 162ms

Nguyên nhân có thể:
  - DB WAL flush ngắn (write-ahead log)
  - Memory allocation cho cart data (memory_kb=4)
  - JSON serialization/deserialization
  - V8 GC pause trong k6
  - Network jitter

162ms là outlier đơn lẻ, không ảnh hưởng đến p95 (6ms).
p95 = 6ms nghĩa là 95% events hoàn thành trong 6ms.
Chỉ 5% events > 6ms, và outlier nhất là 162ms.
```

Nếu chart xấu thì đọc như nào:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 thấp và ổn định suốt run | Cart service khỏe, DB write OK | PASS |
| p95 tăng dần về cuối | DB write buffer đầy, WAL tích lũy | Kiểm tra DB write performance |
| p95 spike đột ngột giữa run | DB checkpoint/WAL flush | So sánh thời điểm spike với DB metrics |
| max thường xuyên > 100ms | DB write contention nặng | Tăng db_writes parameter để test |
| avg thấp nhưng p95 cao | Đa số nhanh, một nhóm write events rất chậm | Tách theo operation tag |

### Chart 2 -- Execution timeline

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
RPS
```

**Shape kỳ vọng cho case 03 (constant-arrival-rate)**:

```text
Đầu run (t=0-2s):
  - Live VUs tăng từ 0 lên preAllocatedVUs (10)
  - RPS bắt đầu ~12/s
  - iterations bắt đầu hoàn thành sau ~5ms

Giữa run (t=2-43s):
  - Live VUs ổn định quanh 1-3 (vì latency thấp, 1-2 VU là đủ)
  - RPS ≈ 12/s đều đặn
  - iterations hoàn thành ≈ 12/s

Cuối run (t=43-45s):
  - Schedule kết thúc sau 45s
  - Live VUs giảm về 0 khi các event cuối xong
  - RPS giảm về 0

Điều đặc biệt: constant-arrival-rate KHÔNG giữ VU cố định.
Live VUs chỉ là số VU đang bận xử lý event tại thời điểm đó.
Với latency 6ms, 12 events/s, chỉ cần 1-2 VU đồng thời.
```

**Khác biệt với per-vu-iterations (case 01)**:

```text
Case 01 (per-vu-iterations):
  - Live VUs = 8 (config VUs) trong suốt thời gian chạy
  - Giảm dần khi VU xong quota
  - Shape: plateau rồi giảm

Case 03 (constant-arrival-rate):
  - Live VUs = số VU đang bận (thay đổi theo latency)
  - KHÔNG có "quota" -- VU xong event thì rảnh, nhận event mới
  - Shape: thấp và ổn định (1-3 VU), không plateau cao
```

**Đọc execution timeline cho case 03**:

```text
Kiểm tra:
  1. RPS có ổn định quanh 12/s không?
  2. Live VUs có thấp và ổn định không? (1-3 VU là bình thường)
  3. Có bucket nào RPS tụt mạnh không?
  4. Cuối run có bucket nào VUs tăng đột biến không?

Nếu RPS ổn định 12/s -> arrival schedule hoạt động đúng
Nếu Live VUs tăng cao -> latency tăng, cần thêm VU để giữ intake
Nếu RPS tụt nhưng Live VUs vẫn cao -> VU bị kẹt (request timeout?)
```

**Các shape xấu cần chú ý**:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| Live VUs = 0 nhưng RPS > 0 | VU bận nhưng chưa sample gauge | Bình thường, xem vusSource |
| Live VUs = maxVUs (30) kéo dài | Pool cạn, latency cao | Kiểm tra event_duration, DB write |
| RPS < 12/s kéo dài | Có drop hoặc schedule lỗi | Kiểm tra dropped_iterations |
| RPS > 12/s | Bucket aggregation gộp nhiều hơn 1s | Bình thường nếu tổng khớp |
| Live VUs tăng dần về cuối | Write amplification tích lũy | Kiểm tra DB WAL, memory |

### Chart 3 -- VUs vs iter/s

Chart này có JSON debug dạng:

```text
Debug JSON: vus-vs-iterations
```

Chart này trả lời câu hỏi:

```text
Executor dự kiến có bao nhiêu VU?
Trong từng giây, thực tế hoàn thành bao nhiêu iteration?
Throughput iteration có bằng rate (12/s) không?
```

Các series chính:

```text
Executor VUs
Actual iter/s
```

Đọc nhanh:

| Series | Nghĩa | Với case 03 kỳ vọng |
| --- | --- | --- |
| `Executor VUs` | đường VU theo executor/config/envelope | thấp, thay đổi theo latency |
| `Actual iter/s` | số iteration hoàn thành trong mỗi bucket 1 giây | ~12/s, dao động nhẹ |

**Với constant-arrival-rate, Actual iter/s kỳ vọng là khoảng 12/s**:

```text
Khác với per-vu-iterations (iter/s dao động mạnh theo batch),
constant-arrival-rate có iter/s ổn định hơn vì schedule đều 12/s.

Run 91 kỳ vọng:
  Actual iter/s mỗi bucket: 10-14 (dao động nhẹ quanh 12)
  Tổng: 541 iterations
  Trung bình: 541 / 45 = 12.02/s

Nếu thấy bucket có iter/s = 0 kéo dài -> có vấn đề
Nếu thấy bucket có iter/s > 20 -> bucket gộp nhiều hơn 1s dữ liệu
```

**So sánh VUs vs iter/s giữa các executor**:

| Executor | Executor VUs shape | Actual iter/s shape |
| --- | --- | --- |
| **constant-arrival-rate** | Thấp, thay đổi theo latency | Ổn định ~rate |
| constant-vus | Plateau = config VUs | Biến thiên theo iter_time |
| per-vu-iterations | Plateau = config VUs, giảm cuối | Dao động theo batch hoàn thành |

### Tab Executor

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
Fixed VUs
Observed VUs
Actual iter/s
Peak if all active
Dropped iterations (nếu có)
```

**Checklist đọc Executor tab cho case 03**:

```text
1. Executor = constant-arrival-rate ✓
2. rate/timeUnit/duration = 12/1s/45s ✓
3. preAllocatedVUs=10, maxVUs=30 ✓
4. dropped_iterations = 0 ✓
5. Observed VUs thấp (1-3), không vượt maxVUs
6. Actual iter/s ≈ 12/s ổn định
7. Không có đường dropped_iterations (vì = 0)
```

**Shape đặc trưng của constant-arrival-rate**:

```text
Fixed VUs = envelope dựa trên rate và duration
  -> Đường này thể hiện "số VU cần nếu tất cả event đến cùng lúc"
  -> Với case 03: thấp, vì latency 6ms

Observed VUs = VU thực tế đang active
  -> Thấp hơn Fixed VUs (vì event hoàn thành nhanh)
  -> KHÔNG plateau như constant-vus
  -> Thay đổi theo latency thực tế

Actual iter/s = số iteration hoàn thành mỗi bucket
  -> Ổn định quanh 12/s
  -> Tổng = summary iterations

Nếu Observed VUs tăng cao -> latency tăng -> CẢNH BÁO
Nếu Observed VUs chạm maxVUs -> pool cạn -> NGUY CƠ DROP
Nếu có dropped_iterations > 0 -> CONTRACT BREACH
```

**Phân biệt shape Executor tab: case 01 vs case 03**:

| Đặc điểm | Case 01 (per-vu-iterations) | Case 03 (constant-arrival-rate) |
| --- | --- | --- |
| Observed VUs | Plateau = config VUs, giảm cuối | Thấp, biến thiên, không plateau |
| Actual iter/s | Dao động mạnh, batch-based | Ổn định ~rate |
| Peak if all active | predicted_peak > actual average | rate = actual (vì schedule) |
| Dropped iterations | Không có | Có thể có (quan trọng!) |
| VU kết thúc | Khi xong quota | Khi test duration hết |

## 4 output -> decision scenarios

### Scenario A: Perfect pass (Run 91)

```text
Output:
  iterations: 541 (gần 540)
  dropped_iterations: 0
  http_req_failed: 0%
  checks: 100%
  constant_arrival_events_failed: 0
  constant_arrival_event_duration_ms p95: 6ms
  vus_max: ~12

Kết luận business:
  - Cart service hấp thụ được 12 arrivals/s
  - 0 drop -> intake contract được giữ
  - p95 = 6ms -> latency rất thấp, headroom lớn
  - vus_max = 12 < 30 maxVUs -> còn 18 VU dự phòng
  - Có thể tăng rate lên mà không lo drop

Hành động:
  - PASS -> approve intake contract
  - Có thể thử rate cao hơn (24/s, 48/s) để tìm capacity limit
  - Ghi nhận baseline: p95=6ms, 0 drop ở 12/s
```

### Scenario B: Pass but VUs rising (write latency tăng, headroom giảm)

```text
Output:
  iterations: 540
  dropped_iterations: 0          <- vẫn pass SLO
  http_req_failed: 0%
  checks: 100%
  constant_arrival_event_duration_ms p95: 45ms  <- tăng từ 6ms
  vus_max: 25                                   <- tăng từ 12

Kết luận business:
  - VẪN pass contract (0 drop)
  - NHƯNG: latency tăng 7.5x (6ms -> 45ms)
  - VUs tăng gấp đôi (12 -> 25)
  - Headroom chỉ còn 5 VU (30 - 25)
  - Có nguy cơ drop nếu latency tăng thêm

Hành động:
  - Điều tra nguyên nhân latency tăng:
    * DB write path có vấn đề? (index, WAL, replication)
    * Memory allocation chậm? (memory_kb=4)
    * Network latency giữa k6 và cart service?
  - Tăng maxVUs lên 50 để có thêm headroom
  - HOẶC: giảm rate xuống nếu không thể cải thiện latency
  - Đây là "cảnh báo sớm" -- chưa breach nhưng sắp
```

### Scenario C: Contract breach (dropped > 0, VUs near max)

```text
Output:
  iterations: 480                 <- thiếu 60
  dropped_iterations: 60          <- CONTRACT BREACH!
  http_req_failed: 0%
  checks: 100%
  constant_arrival_event_duration_ms p95: 2800ms  <- rất chậm
  vus_max: 30                     <- chạm trần

Kết luận business:
  - CONTRACT BREACH: 60 events bị drop
  - VU pool cạn (30/30)
  - Latency rất cao (2800ms p95)
  - Cart service KHÔNG hấp thụ được 12/s ở điều kiện này

Hành động:
  - Dừng test, điều tra DB write path:
    * Deadlock? Lock contention?
    * WAL flush quá chậm?
    * Connection pool cạn?
  - Nếu latency 2800ms là bất thường -> fix DB
  - Nếu latency 2800ms là bình thường ở load cao hơn:
    * Tăng maxVUs (vd 100)
    * HOẶC: scale horizontally (thêm cart service instances)
    * HOẶC: giảm intake rate target
  - Sau khi fix, chạy lại test
```

### Scenario D: Write-path failures (events_failed tập trung ở add/update)

```text
Output:
  iterations: 540
  dropped_iterations: 0
  http_req_failed: 2.5%
  checks: 97.5%                  <- checks fail
  constant_arrival_events_failed: 14
    - cart_arrival_add: 10 failed  <- write path!
    - cart_arrival_update: 4 failed <- write path!
    - cart_arrival_summary: 0 failed <- read path OK

Kết luận business:
  - Intake contract OK (0 drop)
  - NHƯNG: write path có lỗi
    * POST /api/sim/cart/add: 10 events failed
    * PATCH /api/sim/cart/items/:id: 4 events failed
    * GET /api/sim/cart/summary: 0 failed
  - Read path OK, write path BROKEN
  - Đây là regression ở cart write endpoint

Hành động:
  - Điều tra POST và PATCH endpoint:
    * DB write permission?
    * Cart validation logic thay đổi?
    * Race condition khi nhiều write đồng thời?
  - Không release cho đến khi fix write path
  - Sau khi fix, chạy lại case 03 để verify
```

## "Nghịch lý" (4)

### Nghịch lý 1: "10 preAllocatedVUs cho 12/s write -- quá ít?"

```text
Nhìn config:
  rate = 12/s
  preAllocatedVUs = 10

Câu hỏi: "12 events/s mà chỉ có 10 VU chuẩn bị sẵn? Thiếu 2 VU à?"

Trả lời: KHÔNG thiếu. Vì VU xử lý mỗi event rất nhanh (6ms),
một VU có thể xử lý nhiều event trong 1 giây.

Công thức:
  max_events_per_VU_per_second = 1s / event_duration
                                = 1000ms / 6ms
                                ≈ 166 events/s

  needed_VUs = rate / max_events_per_VU_per_second
             = 12 / 166
             = 0.07 VU

-> Về lý thuyết, chưa đến 1 VU cũng đủ!
10 preAllocatedVUs là RẤT NHIỀU, dư > 100x so với nhu cầu.

Vì sao vẫn cần 10?
  - Safety margin cho latency spike
  - Arrival burst (12 slot dồn trong < 1s)
  - Spawn overhead (nếu cần thêm VU, có sẵn 10 rồi)
  - Write amplification (add/update chậm hơn summary)

10 VUs không phải "quá ít" -- nó là "quá nhiều" cho case bình thường.
Nhưng là con số an toàn cho worst case.
```

### Nghịch lý 2: "add/update cùng rate nhưng latency khác hẳn summary"

```text
Nhìn config:
  add (POST):    cpu_ms=1, db_writes=1, memory_kb=4
  update (PATCH): cpu_ms=1, db_writes=1
  summary (GET):  cpu_ms=1, db_rows=3, json_items=8

Câu hỏi: "Cùng cpu_ms=1, cùng 1 operation mà sao latency khác nhau?"

Trả lời: Vì db_writes và memory_kb tạo thêm latency.

Phân tích:
  summary (GET):
    - Chỉ đọc: db_rows=3 -> 3 row reads từ DB
    - json_items=8 -> serialize 8 items ra JSON
    - Không có write -> không cần WAL, không cần lock
    - latency điển hình: 3-5ms

  update (PATCH):
    - Có write: db_writes=1 -> 1 row update
    - Cần acquire row lock -> có thể chờ nếu row đang bị lock
    - Cần write WAL (write-ahead log) -> disk I/O
    - latency điển hình: 5-7ms (thêm ~2ms so với read)

  add (POST):
    - Có write: db_writes=1
    - CÓ THÊM: memory_kb=4 -> cấp phát 4KB memory
      (mô phỏng cart serialization/deserialization)
    - latency điển hình: 6-8ms (thêm ~3ms so với read)

Kết luận:
  memory_kb=4 trên add event thêm ~1-2ms so với update.
  db_writes=1 trên cả add và update thêm ~2ms so với read-only summary.
  Đây là "write amplification" -- write events chậm hơn read events.
```

### Nghịch lý 3: "p95=6ms nhưng production có thể cao hơn nhiều do DB contention"

```text
Run 91: p95 = 6ms, max = 162ms

Câu hỏi: "6ms quá thấp -- production thật có thấp vậy không?"

Trả lời: 6ms là latency trong môi trường test với simulated backend.
Simulated backend dùng cpu_ms=1, db_writes=1, memory_kb=4 -- đây là
các tham số mô phỏng, không phải latency thật của production DB.

Trong production thật:
  - DB write latency: 5-50ms (tùy index, WAL config, disk)
  - Memory allocation: 0.1-1ms
  - Network latency: 1-10ms (tùy topology)
  - JSON serialization: 0.5-2ms
  - Connection pool wait: 0-50ms (nếu pool cạn)
  - Lock contention: 0-500ms (nếu nhiều write cùng row)
  - GC pause: 0-200ms (tùy heap size, GC algorithm)

  Tổng production p95: có thể 50-200ms, không phải 6ms.

6ms trong case 03 là "lower bound" -- latency tối thiểu khi mọi thứ
hoạt động hoàn hảo. Mục đích của simulated params (cpu_ms, db_writes,
memory_kb) là:
  1. Verify flow hoạt động (functional test)
  2. Tạo baseline latency để so sánh
  3. Có thể tăng params để mô phỏng production load nặng hơn

Để test production-realistic latency:
  - Tăng cpu_ms lên 10-50
  - Tăng db_writes lên 3-5
  - Tăng memory_kb lên 64-256
  - Thêm db_rows và json_items cao hơn
```

### Nghịch lý 4: "http_reqs=541 nhưng không phải 541 cart items được thêm"

```text
Run 91: http_reqs = 541

Câu hỏi: "541 requests = 541 cart items được thêm vào giỏ?"

Trả lời: KHÔNG. 541 requests = TỔNG CÁC LOẠI OPERATION:

  add (POST):    ~298 requests -> ~298 items được thêm
  update (PATCH): ~162 requests -> ~162 items được cập nhật
  summary (GET):  ~81 requests -> ~81 lần đọc summary

Chỉ ~298 requests là thêm item mới.
~162 requests là cập nhật item đã có.
~81 requests là đọc summary.

Tổng vẫn là 541, nhưng ý nghĩa nghiệp vụ khác nhau.

Ngoài ra:
  - Mỗi add request thêm 1 item (quantity=1), product_id thay đổi
    theo ctx.iter (product_id = ((iter × 5) % 50) + 1)
  - product_id xoay vòng qua 50 sản phẩm (id 1-50)
  - Mỗi sản phẩm được thêm khoảng 298/50 ≈ 6 lần

Đây là lý do cần đọc tags (operation) để hiểu đúng bức tranh,
không chỉ nhìn tổng http_reqs.
```

## Checklist

Khi học sinh chạy case 03, đọc theo thứ tự này:

```text
1. Summary count
   - iterations có gần 540 không?
   - dropped_iterations = 0?
   - http_req_failed < 1%?
   - checks > 99%?
   - constant_arrival_events_failed < 10?

2. Config verification
   - executor = constant-arrival-rate?
   - rate = 12, timeUnit = 1s, duration = 45s?
   - preAllocatedVUs = 10, maxVUs = 30?

3. Event duration
   - constant_arrival_event_duration_ms p95 < 100ms?
   - p95(add) > p95(update) > p95(summary)? (write amplification)

4. VU pressure
   - vus_max < maxVUs? (còn headroom)
   - Nếu vus_max gần maxVUs -> cảnh báo

5. Operation breakdown
   - add count ≈ 55% × iterations?
   - update count ≈ 30% × iterations?
   - summary count ≈ 15% × iterations?
   - Failed events tập trung ở operation nào?

6. Dashboard real-time charts
   - Response time: p95 ổn định, không spike kéo dài?
   - Execution timeline: RPS ≈ 12/s đều?
   - VUs vs iter/s: Actual iter/s ≈ 12/s?
   - Executor tab: executor = constant-arrival-rate, 0 drop?

7. Business conclusion
   - 0 drop + 0 failed -> PASS: approve intake contract
   - 0 drop + VUs tăng -> PASS nhưng CẢNH BÁO: latency đang tăng
   - drop > 0 -> FAIL: contract breach, điều tra
   - failed > 0 -> FAIL: write path lỗi, điều tra
```

Kết luận của run case 03 đang đúng nếu thấy:

```text
iterations ≈ 540
dropped_iterations = 0
http_req_failed = 0%
checks = 100%
constant_arrival_events_failed = 0
constant_arrival_event_duration_ms p95 < 100ms
vus_max < 30
executor = constant-arrival-rate
RPS ≈ 12/s ổn định trên execution timeline
```

## Mở rộng / variation

### V1: Lower rate smoke test

Mục đích: verify flow nhanh trước khi chạy full rate.

```powershell
$env:CAR_03_RATE = "2"
$env:CAR_03_DURATION = "10s"
$env:CAR_03_MAX_VUS = "5"
$env:CAR_03_MAX_DROPPED = "0"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js"
```

```text
Expected: 2/s × 10s = 20 iterations, 0 drop
Dùng để: verify script chạy đúng, API response OK
Thời gian: ~10s
```

### V2: Shrink VU pool -- observe dropped under write load

Mục đích: cố ý giảm maxVUs để thấy dropped_iterations xuất hiện.

```powershell
$env:CAR_03_RATE = "12"
$env:CAR_03_DURATION = "45s"
$env:CAR_03_PREALLOCATED_VUS = "2"
$env:CAR_03_MAX_VUS = "3"
$env:CAR_03_MAX_DROPPED = "500"  # Tăng threshold để test không fail

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js"
```

```text
Expected: dropped_iterations > 0 (vì maxVUs=3 không đủ cho 12/s nếu latency cao)
Dùng để: học sinh THẤY được drop xảy ra như thế nào
Bài học: VU pool size quan trọng với open model
```

### V3: Increase write weight (nhiều add/update hơn, ít summary hơn)

Mục đích: thay đổi branch mix để thấy ảnh hưởng của write amplification.

Code thay đổi trong script (tạm thời):

```js
// Thay đổi weight:
const choice = weightedPick([
  { name: 'add', weight: 70 },     // tăng từ 55
  { name: 'update', weight: 25 },  // tăng từ 30
  { name: 'summary', weight: 5 },  // giảm từ 15
], ctx.iter);
```

```powershell
# Chạy với mix mới
$env:CAR_03_RATE = "12"
$env:CAR_03_DURATION = "45s"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js"
```

```text
Expected: p95 tổng thể có thể cao hơn vì 95% events là write
Dùng để: thấy write amplification ảnh hưởng đến VU demand
Bài học: branch mix quan trọng khi estimate capacity
```

### V4: Add DB write latency (tăng db_writes parameter)

Mục đích: mô phỏng production DB load nặng hơn.

Code thay đổi trong script (tạm thời):

```js
// Thêm query param db_writes=5 thay vì 1 để mô phỏng write nặng
// POST:
result = requestJson('POST', `${BASE_URL}/api/sim/cart/add?cpu_ms=5&db_writes=5&memory_kb=64`, ...);
// PATCH:
result = requestJson('PATCH', `${BASE_URL}/api/sim/cart/items/${itemId}?cpu_ms=5&db_writes=5`, ...);
```

```powershell
$env:CAR_03_RATE = "12"
$env:CAR_03_DURATION = "45s"
$env:CAR_03_MAX_VUS = "50"  # Tăng maxVUs vì latency cao hơn

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js"
```

```text
Expected: p95 cao hơn (có thể 50-200ms), VU demand cao hơn
Dùng để: test capacity ở production-like load
Bài học: simulated params ảnh hưởng trực tiếp đến VU requirement
```

### V5: Extend duration

Mục đích: kiểm tra stability trong thời gian dài hơn.

```powershell
$env:CAR_03_RATE = "12"
$env:CAR_03_DURATION = "5m"
$env:CAR_03_MAX_VUS = "30"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js"
```

```text
Expected: 12/s × 300s = 3600 iterations, 0 drop
Dùng để: phát hiện write amplification tích lũy theo thời gian
         (DB buffer đầy, WAL tích lũy, memory leak)
Bài học: duration dài hơn giúp phát hiện degradation dần dần
```

## Anti-patterns (mở rộng)

### Anti-pattern 1: "Cart write chậm nên RPS giảm là bình thường"

```text
SAI:
  "Khi cart write chậm, RPS tự giảm -- đó là behavior bình thường
   của hệ thống dưới tải."

ĐÚNG:
  Với open model (constant-arrival-rate), RPS target VẪN phải giữ.
  Nếu cart write chậm, hệ thống cần THÊM VU để giữ rate.
  Nếu không đủ VU, dropped_iterations tăng -- đó là CONTRACT BREACH,
  không phải "bình thường".

  Production users không tự động giảm thao tác chỉ vì backend chậm.
  Họ vẫn bấm "Add to cart" và expect hệ thống xử lý.
  Nếu hệ thống không xử lý kịp -> user thấy lỗi -> mất doanh thu.
```

### Anti-pattern 2: "http_reqs = 541 nên mọi cart operation đều chạy 541 lần"

```text
SAI:
  "541 HTTP requests nghĩa là add, update, summary mỗi cái chạy 541 lần.
   Tổng là 1623 requests."

ĐÚNG:
  541 là TỔNG requests. Branch add/update/summary CHIA THEO WEIGHT:
    add:     55% × 541 ≈ 298 requests
    update:  30% × 541 ≈ 162 requests
    summary: 15% × 541 ≈ 81 requests

  Mỗi iteration = 1 event = 1 API call = 1 HTTP request.
  Không phải mỗi iteration gọi cả 3 operation.
```

### Anti-pattern 3: "VUs tăng nghĩa là nhiều user hơn"

```text
SAI:
  "Live VUs tăng từ 3 lên 25 -- có nhiều user hơn đang dùng cart service."

ĐÚNG:
  VUs tăng nghĩa là event giữ worker LÂU HƠN, không phải nhiều user hơn.
  User identity (arrival-user-N) được tạo từ iteration number, không
  liên quan đến VU count.

  Với constant-arrival-rate:
    - Số user = số iteration (541 users, mỗi user 1 event)
    - Số VU = số worker cần để xử lý kịp schedule
    - KHÔNG có quan hệ "1 VU = 1 user"

  VUs tăng là tín hiệu: LATENCY TĂNG, cần thêm worker để giữ intake.
```

### Anti-pattern 4: "preAllocatedVUs=10 là target VUs, phải giữ đúng 10"

```text
SAI:
  "Config preAllocatedVUs=10 -> lúc nào cũng phải thấy 10 VU active.
   Nếu chart chỉ hiện 2-3 VU là có vấn đề."

ĐÚNG:
  preAllocatedVUs là số VU được khởi tạo SẴN, không phải số VU phải
  luôn active. Với latency thấp (6ms), 1-2 VU là đủ xử lý 12/s.

  preAllocatedVUs=10 có nghĩa:
    - 10 VU đã sẵn sàng trong pool
    - Khi cần, k6 dùng ngay không cần spawn
    - Nhưng nếu chỉ cần 2 VU, 8 VU còn lại idle -- bình thường

  Đây là "warm pool", không phải "active requirement".
  KHÔNG kỳ vọng Live VUs = preAllocatedVUs.
```

### Anti-pattern 5: "p95=6ms quá thấp, test không có giá trị"

```text
SAI:
  "p95 chỉ 6ms -- quá thấp so với production (50-200ms).
   Test này không mô phỏng đúng thực tế, vô giá trị."

ĐÚNG:
  Case 03 là CONTRACT TEST, không phải stress test.
  Mục đích:
    1. Verify flow hoạt động (functional)
    2. Verify intake contract được giữ (0 drop)
    3. Tạo baseline để so sánh khi tăng load

  Simulated params (cpu_ms=1, db_writes=1) là STARTING POINT.
  Có thể tăng params để mô phỏng production load (xem Variation V4).

  6ms là lower bound -- cho biết nếu backend hoàn hảo, latency tối
  thiểu là bao nhiêu. Từ baseline này, tăng dần params để tìm
  breaking point.

  Ngoài ra, 6ms p95 với max=162ms cho thấy latency tail vẫn tồn tại
  ngay cả ở load thấp. Đây là thông tin giá trị: ngay cả khi mọi thứ
  "hoàn hảo", vẫn có outlier 162ms.
```

## Liên hệ với case khác

- **Case 01 (constant-vus basics)**: so sánh closed vs open model, hiểu vì sao constant-vus không phù hợp cho intake test
- **Case 02 (constant-vus stress)**: mở rộng constant-vus lên stress level, đối chiếu với open model behavior
- **Case 04 (ramping-arrival-rate)**: arrival rate thay đổi theo stage, so sánh với fixed rate của case 03
- **Case 07 (shared-iterations)**: so sánh "iterations cố định" với "rate cố định"

## Reference

- Doc tham số: `docs/20260513_00_executor-from-simplest.md`
- Doc constant-arrival-rate: `docs/20260115_00_constant-vus-executor.md` (phần constant-arrival-rate)
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-03-cart-write-intake.js`
- Common helpers: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\common.js`
- Run 91 results: 541 iterations, 0 dropped, p95=6ms, max=162ms, PASS
- Section 8.7: quy trình 5 bước phân tích output
