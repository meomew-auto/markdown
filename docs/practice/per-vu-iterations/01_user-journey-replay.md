# Case 01: QA replay user journey

## Tình huống thực tế

QA team chuẩn bị release version mới. Họ cần đảm bảo các flow nghiệp vụ
chính (login → browse → add to cart → checkout → confirm order)
**vẫn hoạt động đúng như version cũ** — không bị "regression".

### Vì sao "regression test" buộc chọn per-vu-iterations?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của regression test trước:

```text
Regression test = "test lại tất cả những gì đã chạy đúng trước đây"
                  để đảm bảo code mới KHÔNG làm hỏng feature cũ.

Đời thường:
  Sửa xe đổi phanh mới (= deploy v1.1)
  -> Phải kiểm tra LẠI:
       phanh (= feature mới)        ← chắc chắn test
       đèn xi-nhan (= feature cũ)   ← QUÊN test thì có thể đã hỏng
       còi (= feature cũ)
       điều hòa (= feature cũ)
  -> Nếu KHÔNG test lại đèn xi-nhan, mai chạy đêm mới phát hiện hỏng
     -> đó là "regression đã lọt"
```

Để regression test **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**.
Chỉ per-vu-iterations mới thỏa mãn cả 2.

#### Yêu cầu (a): REPRODUCIBLE INPUT (input giống nhau qua các release)

**Ý nghĩa**: Mỗi lần test phải dùng **CÙNG workload** (cùng số journey,
cùng pattern user) để compare baseline mới fair.

**Ví dụ cụ thể**:

```text
Senario: team đo p95 latency để biết v1.1 có chậm hơn v1.0 không

Trường hợp A (workload GIỐNG NHAU):
  v1.0: 150 journey, p95 = 1.8s
  v1.1: 150 journey, p95 = 2.1s
  → Kết luận: v1.1 chậm hơn 17%, có regression -> rollback

Trường hợp B (workload KHÁC NHAU - bug):
  v1.0: 150 journey, p95 = 1.8s
  v1.1: 200 journey, p95 = 2.1s   <- 200 journey nặng hơn, oan cho v1.1?
  v1.1: 100 journey, p95 = 1.5s   <- 100 journey nhẹ, có thể v1.1 vẫn chậm
                                     hơn v1.0 ở cùng load 150
  → KHÔNG kết luận được, test không có giá trị
```

**Vì sao count phải chính xác?**

```text
Nếu count phụ thuộc latency:
  - latency cao  -> ít journey hoàn thành (vd 100)
  - latency thấp -> nhiều journey hoàn thành (vd 200)
  - mỗi lần test count khác -> không compare được
```

**Phân tích sâu: vì sao 2 executor "duration-based" không đảm bảo count?**

`constant-vus` với `duration: "5m"`:

```text
Công thức count khi chạy:
  count_journey = duration × throughput
                = 300s × (vus / iter_time)
                = 300s × (30 / iter_time)
                = 9000 / iter_time

iter_time KHÔNG cố định, biến thiên do:
  - HTTP latency (mạng, server load, GC pause)
  - DB query time (cache hit/miss, lock contention)
  - External API (payment gateway, captcha service)
  - JS V8 warmup ở 30s đầu

Ví dụ thực tế chạy 3 lần liên tiếp cùng config:
  Lần 1: server vừa restart, cache cold
    iter_time avg = 2.07s -> count = 9000/2.07 = 4348 journey
  Lần 2: cache đã warm, network ổn
    iter_time avg = 1.79s -> count = 9000/1.79 = 5028 journey
  Lần 3: GC pause 200ms ở giữa test
    iter_time avg = 2.34s -> count = 9000/2.34 = 3846 journey

  Range: 3846 - 5028 (chênh 30%)
  -> Không thể compare baseline qua 3 lần này
```

`constant-arrival-rate` với `rate: 30/s, duration: "5m"`:

```text
Mục tiêu config: "30 journey/s × 300s = 9000 journey TOTAL"

Nhưng KHÔNG đảm bảo đạt 9000 vì có thể DROP slot:
  - Khi rate target > năng lực VU pool
  - Khi server chậm bất thường ở 1 đoạn (database lock, GC)
  - Khi spawn VU không kịp lúc đầu

Công thức thực tế:
  N_done = N_sched - N_drop - N_int
         = 9000 - N_drop - N_int

Ví dụ thực tế:
  Lần 1: pool vừa khít, không drop
    N_drop = 0, N_done = 9000  (perfect)
  Lần 2: server có 30s chậm ở giữa (database backup)
    N_drop = 500, N_done = 8500
  Lần 3: cache cold ở 60s đầu
    N_drop = 250, N_int = 50, N_done = 8700

  Range: 8500 - 9000 (chênh 5.5%)
  -> Vẫn không thể compare baseline fair
```

**Trong khi đó với `per-vu-iterations`**:

```text
Config: vus=30, iterations=5
N_done = vus × iterations = 30 × 5 = 150 (TUYỆT ĐỐI)

Lần 1: server chậm  -> 150 journey, T_run=180s, p95=2.5s
Lần 2: server nhanh -> 150 journey, T_run=110s, p95=1.5s
Lần 3: server bình thường -> 150 journey, T_run=140s, p95=1.9s

Count CỐ ĐỊNH ở 150 mỗi lần.
Chỉ có T_run + latency thay đổi -> đó CHÍNH LÀ cái cần đo!

→ p95 latency là biến quan tâm, count là constant -> compare fair được
```

**Tóm tắt 3 executor về count**:

| Executor | Count formula | Có biến thiên không? |
| --- | --- | --- |
| **per-vu-iterations** | `vus × iterations` | KHÔNG (tuyệt đối) |
| constant-vus (duration) | `duration × vus / iter_time` | CÓ (do iter_time) |
| constant-arrival-rate | `N_sched - N_drop - N_int` | CÓ (do drop/int) |

→ COUNT phải CHÍNH XÁC, KHÔNG phụ thuộc latency
→ Chỉ executor đếm theo "vus × iters" hoặc "iterations cố định" mới đạt

#### Yêu cầu (b): COVER MỌI BUG STATEFUL

**Ý nghĩa**: Có một loại bug **chỉ xuất hiện sau N lần thao tác** với
cùng 1 user, không xuất hiện ở lần đầu. Test phải đảm bảo **mỗi user**
chạy đủ N lần để bắt được loại bug này.

**Bug stateful là gì?**

```text
Bug bình thường (stateless):
  Lần 1 mua: 500 Internal Server Error
  Lần 2 mua: 500 Internal Server Error
  → Bug rõ ràng, test 1 lần là phát hiện

Bug stateful (chỉ xuất hiện sau N lần):
  Lần 1 mua: OK (200, cart cleared correctly)
  Lần 2 mua: OK (200, cart cleared correctly)
  Lần 3 mua: OK status code, NHƯNG cart bỗng RỖNG -> mất hàng

  → Test 1 lần không phát hiện. Phải chạy ≥3 lần MỚI thấy bug.
```

**3 nguyên nhân kỹ thuật của bug stateful**:

#### Nguyên nhân 1: CACHE OVERFLOW

**Cache là gì?** Server lưu cart user trong RAM (Redis) để tránh query database
mỗi lần. Nhưng RAM giới hạn → cache có "cap" (tối đa 1000 items).

**LRU = Least Recently Used**: khi đầy, evict (xóa) entry "ít dùng nhất gần đây".

```text
Tưởng tượng tủ đồ 1000 ngăn:
  - Mỗi user có 1 ngăn chứa cart
  - User 1001 đến -> ngăn đầy -> phải đẩy 1 user RA
  - Quy tắc: ai ít dùng nhất gần đây -> bị đẩy ra trước

Bug:
  Lần 1-1000: tất cả 1000 user đều có ngăn riêng, cart OK
  Lần 1001: user mới đến, server evict cart user "ít dùng nhất"
            (giả sử user X)
  Lần 1002: user X login lại -> cart không còn trong cache
            -> server LẼ RA phải fallback đọc từ database
            -> NHƯNG bug ở chỗ: code chỉ đọc cache, không có fallback
            -> trả về cart RỖNG cho user X
```

**Vì sao test 1 lần per user không bắt được?**

```text
Test với 30 user, mỗi user 1 lần:
  - Tổng 30 entry trong cache
  - Cap 1000 chưa đầy -> không trigger evict
  - 30 user đều OK -> bug không xuất hiện
  - Đến production có 5000 user thì BÙM, mất cart hàng loạt

Test với 30 user × 5 lần = 150 entries (vẫn chưa overflow):
  - Vẫn không bắt được trực tiếp
  - NHƯNG có thể chỉnh test data để evict sớm:
    - Set cap = 50 (test config)
    - 30 user × 5 lần = 150 thao tác -> evict liên tục
    - Lần 4-5 của user 1 sẽ bị evict bởi user 30
    - Bug lộ ra: lần 5 mua cart user 1 rỗng
```

**Cách phát hiện**: monitor log có entry `cache_miss_after_set` cho cùng user.

#### Nguyên nhân 2: DATABASE SESSION POOL RECYCLE

**Connection pool là gì?** Server không tạo connection mới mỗi query (tốn ~50ms
TCP handshake). Thay vào đó, init sẵn 50 connection, query xong "trả về pool"
để query khác dùng tiếp.

**Recycle là gì?** Mỗi connection có giới hạn lifetime (vd 100 query). Sau đó
phải đóng và tạo mới (tránh memory leak, kết nối stale với DB).

```text
Pool 50 connection, mỗi connection cap 100 query:
  Query 1-100   của connection #1: OK
  Query 101     của connection #1: LIB AUTO-RECYCLE
                                   - đóng connection cũ
                                   - tạo connection mới
                                   - giao cho query 101

Bug stateful (race condition khi recycle):
  Khi connection được "trả về pool" sau query 100:
    - LIB chuẩn: connection.reset() -> clear transaction state
    - LIB BUG : quên reset -> connection còn state cũ

  Query 101 dùng connection có state cũ:
    - Nếu query 100 đang trong transaction CHƯA COMMIT
    - Query 101 (của user khác) thấy data dở dang
    - Hoặc bị "READ UNCOMMITTED" data
    - Hoặc INSERT của user A bị attribute cho user B
```

**Ví dụ thực tế trong code Java/Hibernate**:

```java
// Bug: AutoCommit không reset khi recycle
@Transactional
public void buy(User u) {
  // begin transaction
  cart.update(u);            // query 1
  // bug: ngay sau dòng này, connection bị recycle
  payment.charge(u);          // query 2 - chạy trên CONNECTION KHÁC
  // commit
}
// Kết quả: cart.update committed, payment.charge rollback
// User mất hàng nhưng vẫn bị trừ tiền
```

**Vì sao test 1 lần per user không bắt được?**

```text
Lần 1 mua:
  - Connection #1 query 1-3 -> OK
  - Lifetime mới 3/100 -> chưa recycle
  - Test pass

Lần 2 mua:
  - Connection #1 query 4-6 -> OK
  - Vẫn chưa recycle
  - Test pass

Lần thứ N (khi tổng query đạt 100):
  - Connection recycle giữa transaction
  - State lẫn lộn -> data sai
  - Bug lộ ra

→ Test 1 lần × 30 user = 30×3 = 90 query
→ Chưa đạt 100 -> không trigger recycle
→ Production có 1000 user/giờ -> trigger nhanh -> production bị bug
```

**Cách phát hiện**: monitor metric `db_connection_recycled_count`. Test phải đảm
bảo `query_total > pool_size × recycle_threshold` để trigger recycle ít nhất 1 lần.

#### Nguyên nhân 3: JWT VERSION DESYNC

**JWT là gì?** Token mà server cấp cho client để xác thực. Trong JWT có
thể nhúng metadata như `cart_version`:

```json
{
  "user_id": "user-1",
  "cart_version": 5,           ← server tăng lên mỗi lần update cart
  "exp": 1716800000
}
```

**Why version?** Để chống "double spend": user gửi 2 request cùng lúc thay
đổi cart, server phải biết cái nào là cart "mới nhất".

```text
Flow đúng:
  Lần 1: client gửi cart_version=5
         server check: server_version=5 -> OK, update -> server_version=6
         server cấp JWT mới với cart_version=6
  Lần 2: client gửi cart_version=6 (JWT mới)
         server: 6 == 6 -> OK
```

**Bug: increment KHÔNG ATOMIC**:

```text
2 request đồng thời (race condition):
  Request A: read server_version=5
  Request B: read server_version=5    (cùng lúc)
  Request A: increment + write -> server_version=6
  Request B: increment + write -> server_version=6  ← oops, cũng 6
                                                      lẽ ra phải là 7

Kết quả: 2 update nhưng version chỉ tăng 1 lần
  Server cấp JWT có cart_version=6 cho cả A và B
  -> client đều có "cart_version=6" trong JWT
  -> nhưng cart trong DB thực ra đã update 2 lần
  -> request thứ 3 của user A: gửi cart_version=6
     server check: 6 vs 6 -> tưởng OK, NHƯNG cart đã có data của B trộn vào
```

**Code anti-pattern (Java/Spring)**:

```java
// SAI: read-modify-write không atomic
@Transactional(isolation = READ_COMMITTED)
public void updateCart(User u) {
  int v = db.getVersion(u);     // read
  // ... thao tác cart
  db.setVersion(u, v + 1);       // write (race tại đây)
}

// ĐÚNG: dùng UPDATE WHERE atomic
db.execute(
  "UPDATE cart SET version=version+1, items=? WHERE user=? AND version=?",
  newItems, userId, currentVersion
);
// affected_rows = 0 -> version đã thay đổi -> retry
```

**Vì sao test 1 lần per user không bắt được?**

```text
Lần 1: 1 request -> không có race -> OK
Lần 2: 1 request -> không có race -> OK
...
Mãi không trigger được race condition

Phải đảm bảo:
  - Cùng user (cùng JWT)
  - Nhiều request liên tiếp
  - Có thể song song (2 tab, http.batch)

→ per-vu-iterations + http.batch trong iter -> tạo race chính xác cho cùng user
→ Xem case 06 (cart-concurrency) cho pattern này
```

**Cách phát hiện**: monitor `jwt_version_mismatch_count`. Test phải có ít nhất
2 request song song cùng user trong 1 iter để trigger race.

**Vì sao mỗi account phải chạy đủ M lần ĐỀU NHAU?**

```text
Yêu cầu: bắt được bug "lần 3 mới hỏng" cho TẤT CẢ account.

Nếu phân phối không đều:
  ✗ shared-iterations (100 iter chia 30 VU):
    - VU fast (network nhanh, server response nhanh) nhận 8-10 iter
    - VU slow nhận 1-2 iter
    - Với VU slow: chỉ chạy 1-2 lần -> KHÔNG TRIGGER bug "lần 3 mới hỏng"
    - 28/30 account "chưa test đủ" -> bỏ sót bug

  ✗ constant-vus duration:
    - Tương tự, account fast chạy nhiều lần, account slow chạy ít
    - Đặc biệt nếu test ngắn (<1 phút)

→ MỖI VU phải chạy ĐÚNG M lần (không lệch)
→ Chỉ per-vu-iterations đảm bảo (vì vòng lặp cứng `for i := 0; i < M; i++`)
```

#### Tổng kết: chỉ per-vu thỏa mãn cả (a) và (b)

| Executor | (a) Reproducible count | (b) Mỗi account đủ M lần | Verdict |
| --- | --- | --- | --- |
| **per-vu-iterations** | ✓ vus × iters cố định | ✓ mỗi VU chạy đúng M lần | ✅ DÙNG |
| shared-iterations | ✓ count cố định | ✗ phân phối không đều giữa VU | ❌ |
| constant-vus (duration) | ✗ count phụ thuộc latency | ✗ random VU pick | ❌ |
| constant-arrival-rate | ✗ có thể drop | ✗ identity không bound vào VU | ❌ |
| ramping-vus | ✗ count biến thiên theo time | ✗ VU spawn lệch theo timeline | ❌ |
| ramping-arrival-rate | ✗ count biến thiên + drop | ✗ rate-driven, không bound user | ❌ |

→ Chỉ **per-vu-iterations** thỏa mãn cả 2 yêu cầu, các executor khác
đều fail ở ít nhất 1 trong 2.

### 3 nguyên nhân nghiệp vụ cụ thể (= 3 thông số config)

```text
1. TEST DATA CỐ ĐỊNH (fixed N accounts):
   - QA có database test với đúng 30 accounts (qa-user-1 .. qa-user-30)
   - Mỗi account đã seed sẵn: history orders, saved cart, address book
   - Test phải dùng ĐÚNG 30 accounts này, không tạo random user
   → vus = 30 (số account cố định)
   → __VU map sang qa-user-${__VU} (identity bound)

2. COVERAGE PER ACCOUNT (mỗi account verify state qua nhiều lần):
   - Yêu cầu: mỗi account chạy ≥ 5 journey để chắc chắn state consistency
     (vd kiểm tra bug "lần thứ 3 mua thì cart bị reset")
   - 1 journey không đủ phát hiện bug stateful
   → iterations = 5 (mỗi VU = mỗi account chạy 5 lần)
   → KHÔNG shared-iterations vì account nhanh sẽ "cướp" lần của account chậm

3. REPRODUCIBLE BASELINE (so sánh qua các release):
   - v1.0: 150 journey, baseline p95=1.8s
   - v1.1: 150 journey, baseline p95=2.1s
   - Compare ĐÚNG cùng workload mới fair
   → total = vus × iterations = 150 (DETERMINISTIC)
   → KHÔNG constant-vus với duration vì count phụ thuộc latency,
     mỗi release count khác nhau, không compare được
```

> **Regression là gì?** = lỗi xuất hiện ở chức năng đã chạy đúng trước
> đây, sau khi code thay đổi (bug cũ quay lại, hoặc feature cũ bị hỏng
> do code mới).
>
> ```text
> Version 1.0: login OK, checkout OK
> Version 1.1: login OK, checkout BỊ LỖI (do code mới)
>                              ↑
>                              "regression" ở checkout
> ```
>
> **Đời thường**: sửa xe đổi phanh mới → quên test đèn xi-nhan → đèn hỏng
> (do động vào dây điện) → đèn bị "regression". QA phải test LẠI cả
> phanh + đèn + còi + ... mỗi lần sửa xe.
>
> **Regression test** = replay TẤT CẢ flow nghiệp vụ chính (không skip)
> với input giống lần trước, so kết quả với baseline. Nếu lệch → có
> regression → không release.

Yêu cầu cụ thể:

```text
- 30 user accounts khác nhau
- Mỗi user replay đúng 5 lần journey hoàn chỉnh
- Tổng = 150 journey replay (deterministic, biết trước số)
- Mỗi user phải GIỮ session token, cart state qua các lần replay
- Không cướp identity của user khác
```

## Why per-vu-iterations?

```text
Vì YÊU CẦU NGHIỆP VỤ là:
  - "Mỗi user N việc cố định" -> per-vu-iterations đúng nhất
  - "Tổng N việc xác định" -> per-vu cho biết trước (vus × iters)
  - "User giữ state qua iter" -> closed model + identity bound vào VU

Tại sao KHÔNG dùng executor khác?
  - constant-vus (5m duration): không biết bao nhiêu journey sẽ chạy,
                                và VU random -> session lost
  - shared-iterations (150 iter chung): VU nhanh "cướp" iter của VU
                                         chậm -> 1 user replay 100 lần,
                                         user khác chỉ 5 lần
  - constant-arrival-rate: rate-driven, không bound identity với user
  - ramping-vus: concurrency biến thiên, phá deterministic count
```

## Config

```js
export const options = {
  scenarios: {
    qa_replay: {
      executor: "per-vu-iterations",
      vus: 30,
      iterations: 5,
      maxDuration: "5m",
      gracefulStop: "30s",
    },
  },
};
```

→ 30 × 5 = **150 iteration**, mỗi VU chạy đúng 5 journey.

## Endpoint flow per iteration

```text
1. login          (CHỈ iter 0, lưu session)
2. browse         GET /api/quotes (proxy cho /api/products)
3. view detail    GET ×2
4. add to cart    POST ×2
5. checkout       POST với Idempotency-Key
6. confirm order  POST ×2 (test idempotency)
```

## Per-VU state

```js
let session = null;       // login 1 lần, dùng nhiều iter
let totalCartItems = 0;   // tích lũy qua iter
```

→ Đây là điểm mạnh của per-vu-iterations: state sống trong cùng VU
xuyên suốt nhiều iter.

## Cách chạy

> Stack setup chung: xem [RUN_GUIDE.md](RUN_GUIDE.md). Phần dưới chỉ ghi
> vars + command đặc thù cho case này.

```powershell
# 1. Đảm bảo stack đã start (xem RUN_GUIDE)
# 2. Set env vars
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"   # case này dùng student token

# 3. Run với cloud output (xem result trên UI)
cd "E:\Khoa hoc\k6"
k6 run -o cloud .\examples\per-vu-iterations\pvi-01-user-journey-replay.js

# Hoặc run local nếu không cần UI
k6 run .\examples\per-vu-iterations\pvi-01-user-journey-replay.js
```

**Token nào dùng?**

```text
student-token-1234567890   <- case này (test user journey thường)
                              role=student đủ để gọi /api/sim/products,
                              /api/sim/cart/*, /api/sim/checkout
```

**Verify trên UI** (sau khi run xong):

```text
1. Mở http://localhost:13001
2. Paste student-token-1234567890
3. Click vào run mới nhất
4. Tile "iterations" hiển thị 150 ✓
5. Tile "http_req_duration" hiển thị p95 < 2000ms ✓
```

## Expected output

```text
scenarios: (100.00%) 1 scenario, 30 max VUs, 5m30s max duration ...
         * qa_replay: 5 iterations for each of 30 VUs

running (XX.Xs), 0/30 VUs, 150 complete and 0 interrupted iterations

  █ TOTAL RESULTS

    EXECUTION
    iterations.........: 150
    iteration_duration.: avg=...
    http_req_failed....: 0.00%
    checks_total.......: ~1500 (10 check/iter × 150 iter)
    vus................: 30
    vus_max............: 30
```

## Pass criteria

```text
1. iterations == 150       -> đúng số journey
2. http_req_failed == 0%   -> không request fail
3. checks rate >= 99%      -> mọi check pass
4. p(95) < 2000ms          -> latency OK
5. interrupted == 0        -> không VU nào bị cắt
```

## Áp 5 bước phân tích output (Section 8.7)

### Bước 1: Verify config [Header]

```text
Header in:    "5 iterations for each of 30 VUs"
Config có:    vus=30, iterations=5 ✓

Header in:    "5m30s max duration"
Tính:         maxDuration + gracefulStop = 5m + 30s = 5m30s ✓
```

### Bước 2: Tính total dự kiến [CT 1]

```text
total = vus × iterations = 30 × 5 = 150
```

### Bước 3: So với N_done [CT 5]

```text
Summary cho:  iterations = 150
Tỷ lệ:        150 / 150 = 100% -> hoàn hảo
```

### Bước 4: Verify N_drop, N_int [CT 5]

```text
Footer:       "0 interrupted iterations"
Summary:      không có dropped (per-vu-iterations chỉ drop khi maxDuration tới)

KẾT LUẬN: test thành công
```

### Bước 5: Đo iter_time thực tế [CT 2 đảo]

```text
iteration_duration avg = ~2s (phụ thuộc network)
T_max = iterations × iter_time = 5 × 2 = 10s mỗi VU
T_run = max(T_vu) ≈ 12s (do VU chậm nhất)

Đánh giá:
  - maxDuration = 5m, T_run = 12s -> dư rất nhiều, có thể giảm xuống "1m"
  - Hoặc tăng iterations lên 30 (mỗi user 30 journey thay vì 5)
```

## Mở rộng / variation

### Variation A: Test data per-user

```js
const users = new SharedArray("users", () => {
  // Read từ file CSV/JSON
  return Array.from({length: 30}, (_, i) => ({
    username: `qa-user-${i + 1}`,
    role: i < 5 ? "admin" : "customer",
  }));
});

// Trong default function:
const user = users[(__VU - 1) % users.length];
```

### Variation B: Tăng độ khó với throttle

```js
// Iter dài hơn để mô phỏng user nghĩ lâu trước khi mua
sleep(Math.random() * 3 + 1);  // 1-4s think time
```

### Variation C: Multi-scenario gộp

```js
scenarios: {
  customers: { executor: "per-vu-iterations", vus: 25, iterations: 5, ... },
  admins:    { executor: "per-vu-iterations", vus: 5, iterations: 10,
               startTime: "30s", ... },
},
```

## Liên hệ với case khác

- **Case 02 (idempotency)**: dùng cùng pattern Idempotency-Key, sâu hơn về retry storm
- **Case 04 (session lifecycle)**: mở rộng phần login/refresh token
- **Case 06 (cart concurrency)**: tập trung vào race condition cùng user

## Reference

- Doc tham số: `docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md`
- Section 8.7: quy trình 5 bước phân tích output
