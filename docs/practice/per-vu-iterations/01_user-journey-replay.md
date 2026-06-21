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

Phân tích kỹ con số 9000:

  9000 = vus × duration = 30 × 300

  Đây là TÍCH (vus × duration), không phải "tổng quỹ thời gian".
  Với constant-vus, KHÔNG có chuyện 30 VU "xài chung" 9000s.

  Cách đọc CHUẨN với bản chất constant-vus (VU cố định, chạy song song):

    count = vus × (duration / iter_time)
          = 30  × (300 / iter_time)
          = 9000 / iter_time

  Đọc là:
    - Bài test kéo dài 300s, VÀ mỗi VU cũng chạy đủ 300s (vì 30 VU
      cùng start, cùng kết thúc, chạy SONG SONG suốt duration).
    - Mỗi VU có 300s RIÊNG của nó, hoàn thành được 300/iter_time iteration.
    - 30 VU chạy song song → nhân 30 → 9000/iter_time.

  timeline: |--------- 300s ---------|
  VU-1:     |--iter--|--iter--|--iter--|--iter--|...   (300/iter_time lần)
  VU-2:     |--iter--|--iter--|--iter--|--iter--|...
  VU-3:     |--iter--|--iter--|--iter--|--iter--|...
  ...
  VU-30:    |--iter--|--iter--|--iter--|--iter--|...

  Tất cả 30 VU cùng có 300s — thời gian KHÔNG bị cộng dồn.
  "9000" chỉ là tích trung gian (vus × duration), không mang ý nghĩa
  vật lý độc lập. Không nên đọc là "tổng quỹ 9000s chia cho iter_time".

  Sai: "tổng quỹ thời gian 9000s, chia cho iter_time"
       → ngụ ý 30 VU xài chung 9000s, VU nào lấy nhiều thì VU khác ít.
       → SAI với constant-vus: mỗi VU có ĐỦ 300s, không chia sẻ.

  Đúng: "30 bản sao độc lập của cùng hành vi 'chạy 300s'"
        → mỗi VU làm được 300/iter_time iteration.
        → 30 VU × 300/iter_time = 9000/iter_time.

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

### Vì sao state KHÔNG bị mất khi VU chạy iteration tiếp theo?

Đây là cơ chế quan trọng nhất của `per-vu-iterations` — là lý do cả
7 case trong series này chạy đúng.

Trong k6, mỗi VU có 1 JS RUNTIME RIÊNG (V8 isolate). Module-level code
chạy 1 LẦN duy nhất trong init phase. Sau đó, VU chỉ gọi LẠI default()
nhiều lần — các biến ở module-level KHÔNG bị reset.

**Code thật từ file pvi-01-user-journey-replay.js**:

```js
// ───── Module-level scope (top file) ─────
// Chạy 1 LẦN trong init phase, GIỮ giá trị qua MỌI iter của VU này

let session = null;       // ← GIỮ: iter 0 ghi, iter 1-4 đọc lại được
let totalCartItems = 0;   // ← GIỮ: tích lũy +1 mỗi lần addToCart()

// ───── Local scope (trong default()) ─────
// RESET mỗi lần default() được gọi

export default function () {
  // Iter đầu: login (chỉ 1 lần per VU)
  if (__ITER === 0) {
    session = login();         // ← ghi vào module-level -> GIỮ
  }

  const idempotencyKey = `idem-${__VU}-${__ITER}`;  // ← local, RESET mỗi iter
  const order = checkout(idempotencyKey);

  addToCart(`prod-${__VU}-${__ITER}-a`);   // gọi hàm dùng session.token
  totalCartItems += 1;                     // ← ghi vào module-level -> GIỮ

  // Log: đọc session từ module-level (đã ghi từ iter 0)
  console.log(`user=${session?.user.username} | cart_items=${totalCartItems}`);
}
```

**Trace execution cho VU=1 qua 5 iter**:

```text
Init phase: let session = null, let totalCartItems = 0   (1 lần duy nhất)

Iter 0: __ITER=0 -> session = login() -> session = {token: "A1", user:...}
        addToCart ×2 -> totalCartItems = 2
        Log: "user=qa-user-1 | cart_items=2"

Iter 1: __ITER=1 -> bỏ qua login (__ITER != 0)
        session VẪN = {token: "A1"}    ← ĐỌC LẠI ĐƯỢC từ module-level
        addToCart ×2 -> totalCartItems = 4 (tích lũy)
        Log: "user=qa-user-1 | cart_items=4"

Iter 2: totalCartItems = 6
Iter 3: totalCartItems = 8
Iter 4: totalCartItems = 10 (cuối)
```

**Phân biệt rõ**:

```text
Module-level scope (let ở top file):
  - session, totalCartItems                ← GIỮ QUA ITER
  - Chạy 1 lần trong init phase
  - default() đọc/ghi -> giá trị tồn tại đến khi VU kết thúc

Local scope (const/let TRONG default()):
  - idempotencyKey, order, temp variables ← RESET MỖI ITER
  - Mỗi lần default() gọi -> tạo mới
  - Hết iter -> biến bị discard
```

**So sánh với executor khác**:

```text
shared-iterations:
  iter 1 do VU=A, iter 2 do VU=B -> isolate KHÁC
  -> session ở isolate A KHÔNG tồn tại trong isolate B
  -> token "mất" -> mỗi iter phải login lại

constant-vus:
  mỗi VU cũng có isolate riêng, nhưng VU pool reuse
  -> VU=A chạy iter của user X, xong chạy iter của user Y
  -> session bị ghi đè bởi user khác -> "mất identity"

per-vu-iterations:
  VU=A LUÔN chạy iter của cùng identity A
  -> isolate A giữ state của user A qua mọi iter -> KHÔNG MẤT
```

> **Áp dụng cho series**: mọi case sau (02-07) dùng cùng cơ chế này.
> Khi thấy `let xxx = null` ở đầu file JS → đó là per-VU state sống
> qua iter. Các case doc sau sẽ không giải thích lại, chỉ note "xem
> case 01 / Per-VU state".

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

### Nghịch lý: 1 iter mất 2.45s nhưng 1 giây chạy được 3 iter?

Đây là chỗ người mới hay nhầm khi đọc output:

```text
iteration_duration: avg=2.45s    <- 1 iter mất 2.45 giây
iterations:         3.0/s         <- nhưng 1 giây ra 3 iter

Sao 1 iter mất 2.45s mà mỗi giây lại ra được 3 iter?
"Lẽ ra 2.45s mới ra 1 iter chứ?"
```

**Trả lời: vì NHIỀU VU chạy SONG SONG, không phải 1 VU.**

Phân biệt 2 con số đo 2 thứ khác nhau:

```text
iteration_duration = thời gian 1 VU làm xong 1 iter
                     (đo trên TỪNG iter riêng lẻ) = 2.45s

iterations rate    = tổng iter hoàn thành / tổng thời gian
                     (throughput của CẢ POOL VU cộng lại) = 3.0/s
```

**Công thức nối 2 con số** (chính là Little's Law):

```text
rate = vus / iter_time

Kiểm chứng ngược với output:
  iter_time = 2.45s, rate = 3.0/s
  => vus = rate × iter_time = 3.0 × 2.45 ≈ 7.35 ≈ 8 VU
  -> khớp với config VUS=8 ✓
```

**Ví dụ trực quan** (8 VU chạy song song):

```text
8 VU cùng start, mỗi VU mất 2.45s cho 1 iter:

t=0.00s: VU1..VU8 cùng bắt đầu iter
t=2.45s: VU1..VU8 cùng xong -> 8 iter trong 2.45s
         => rate = 8 / 2.45 ≈ 3.27 iter/s

Mỗi iter VẪN mất 2.45s (KHÔNG nhanh hơn).
Nhưng 8 cái chạy CÙNG LÚC -> mỗi giây "gặt" được ~3 iter.
```

Đời thường:

```text
8 đầu bếp, mỗi người nấu 1 tô phở mất 2.45 phút:
  - 1 tô VẪN mất 2.45 phút (không nhanh hơn)
  - nhưng 8 người nấu song song -> mỗi phút ra ~3 tô
```

**Vì sao 3.0 chứ không đúng 3.27 (= 8/2.45)?**

```text
- Có sleep() giữa request -> iter_time đo đã gồm sleep, nhưng ramp +
  login iter 0 làm rate thực thấp hơn lý thuyết
- 8 VU không start đúng cùng t=0 tuyệt đối (ramp-up vài ms)
- maxDuration cắt -> iter cuối chưa xong không được tính

=> rate thực 3.0 hơi thấp hơn 3.27, lệch vài % là bình thường
```

→ Ghi nhớ: **iteration_duration là thời gian 1 iter; rate là throughput
của cả pool**. Hai con số nối nhau bằng `rate = vus / iter_time`.

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

## Kết luận thực tế: đọc output này thì QA quyết định gì?

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật
của case này là **regression gate**: output ra số như vậy thì QA QUYẾT
ĐỊNH gì với release v1.1? Đây là phần ánh xạ output → hành động.

Nhắc lại bối cảnh: 150 journey cố định, so p95 với baseline v1.0.

### Kịch bản A — output sạch: RELEASE

```text
iterations.........: 150        (đủ, không thiếu)
http_req_failed....: 0.00%
checks_total.......: 1500, rate 100%
iteration_duration: p(95)=1.85s
interrupted........: 0

Baseline v1.0: p95 = 1.8s
```

Kết luận thực tế:

```text
- Count đủ 150 -> workload giống baseline -> so sánh FAIR (yêu cầu a)
- p95 1.85s vs baseline 1.8s -> lệch +2.8%, trong ngưỡng nhiễu (<5%)
- 0 fail, 0 interrupted -> không regression chức năng
=> QUYẾT ĐỊNH: release v1.1. Không có regression.
```

### Kịch bản B — count đủ nhưng latency tăng: ROLLBACK

```text
iterations.........: 150        (vẫn đủ!)
http_req_failed....: 0.00%
iteration_duration: p(95)=2.40s

Baseline v1.0: p95 = 1.8s
```

Kết luận thực tế:

```text
- Count vẫn 150 -> KHÔNG phải lỗi test, workload vẫn fair
- p95 2.40s vs 1.8s -> chậm +33% -> đây là REGRESSION HIỆU NĂNG
- code mới chạy đúng (0 fail) nhưng CHẬM hơn rõ rệt
=> QUYẾT ĐỊNH: rollback / chặn release. Bắt dev tìm nguyên nhân
   (query mới thiếu index? N+1 query? thêm sync call?).
   Đây CHÍNH LÀ giá trị của per-vu: count cố định nên latency tăng
   là tín hiệu thật, không phải do test chạy nhiều hơn.
```

### Kịch bản C — thiếu iteration / có fail: TEST CHƯA HỢP LỆ

```text
iterations.........: 138        (THIẾU 12!)
http_req_failed....: 4.2%
interrupted........: 12
```

Kết luận thực tế:

```text
- 138 < 150 -> workload KHÔNG còn giống baseline -> KHÔNG so p95 được
  (so 138 journey với baseline 150 journey là so sai, xem yêu cầu a)
- Trước khi nói gì về regression, phải sửa cho test chạy đủ 150 đã:
    interrupted=12 -> maxDuration quá ngắn so với T_max? -> tăng maxDuration
    http_req_failed=4.2% -> server thật sự lỗi, hay test data sai?
=> QUYẾT ĐỊNH: CHƯA kết luận release/rollback. Test invalid, chạy lại
   sau khi sửa nguyên nhân thiếu count. (Số liệu latency lúc này vô nghĩa.)
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 150 iter, p95 ≈ baseline, 0 fail | không regression | release |
| 150 iter, p95 tăng >5%, 0 fail | regression hiệu năng | rollback, báo dev |
| 150 iter, có http_req_failed | regression chức năng | rollback, báo dev |
| < 150 iter (drop/interrupt) | test chưa hợp lệ | sửa config, chạy lại |
| checks rate < 100% | flow nghiệp vụ sai | điều tra check nào fail |

Điểm cốt lõi của case này: **vì count luôn cố định 150, mọi thay đổi ở
p95/fail đều là tín hiệu THẬT về code mới, không bị nhiễu bởi "lần này
test chạy nhiều/ít hơn lần trước"**. Đó là lý do regression gate buộc
dùng per-vu-iterations.

## Đọc dashboard real-time charts cho case 01

Sau khi chạy bằng wrapper:

```powershell
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:K6_CLOUD_HOST = "http://localhost:18080"
.\run-with-summary.ps1 .\examples\per-vu-iterations\pvi-01-user-journey-replay.js
```

mở dashboard:

```text
http://localhost:13001/
```

paste token, chọn run mới nhất. Phần này giải thích cách đọc các biểu đồ
real-time và tab Executor. Ví dụ dưới đây lấy từ một run thật với default
hiện tại của file JS:

```text
VUS = 8
ITERS_PER_VU = 5
total_iterations = 8 × 5 = 40
```

Nếu trong lớp học bạn đổi về `VUS=30, ITERS_PER_VU=5`, chỉ cần thay:

```text
8 VUs  -> 30 VUs
40 iter -> 150 iter
```

logic đọc biểu đồ vẫn y hệt.

### 1. Overview có 3 chart cần đọc

Trong tab **Overview**, có 3 chart quan trọng:

```text
1. Response time        (real-time latency chart)
2. Execution timeline   (real-time execution/load chart)
3. VUs vs iter/s        (executor-shape + iteration throughput chart)
```

Có thể chia thành 2 nhóm:

```text
Nhóm real-time chính:
  1. Response time
  2. Execution timeline

Nhóm giải thích executor ngay trong Overview:
  3. VUs vs iter/s
```

Vì vậy khi nói "2 chart real-time" thì thường là 2 chart đầu. Nhưng khi
học sinh đọc toàn bộ tab Overview, **phải đọc cả chart thứ 3** vì nó nối
trực tiếp với tab Executor và giúp hiểu `per-vu-iterations` sinh iter/s như
thế nào.

Trước khi đọc chi tiết, nhớ bảng này:

| Biểu đồ / tab | Nó trả lời câu hỏi gì? | Không nên dùng để làm gì? |
| --- | --- | --- |
| Response time | Request nhanh/chậm theo từng giây như nào? Có spike không? | Không thay thế final summary p95 |
| Execution timeline | Tại mỗi giây có bao nhiêu VU, bao nhiêu request, bao nhiêu iter xong? | Không đọc mỗi point như 1 iteration |
| VUs vs iter/s | Executor VU envelope và iter/s theo bucket có khớp không? | Không kỳ vọng iter/s từng giây bằng average |
| Executor tab | Shape thực tế có đúng mô hình `per-vu-iterations` không? | Không dùng để verify latency |

Một cách đọc nhanh:

```text
Response time      -> chất lượng request
Execution timeline -> tải sinh ra theo thời gian
VUs vs iter/s      -> iteration throughput theo executor shape
Executor tab       -> mô hình executor có chạy đúng bản chất không
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

Ví dụ point đầu/cuối từ run thật:

```text
01:09:17  avg=84.49ms   p95=416.76ms  max=416.76ms
01:09:18  avg=170.45ms  p95=658.22ms  max=739.32ms
...
01:09:26  avg=26.93ms   p95=85.58ms   max=100.09ms
```

Đọc thực tế:

```text
- đầu run response time cao hơn vì có login/setup/request đầu
- giữa/cuối run response time thấp hơn vì flow đã warm và request nhẹ hơn
- từng point là per-batch, KHÔNG phải final summary
```

Đừng nhầm:

```text
Batch p95 ở từng point != summary p95 cuối test
```

Summary cuối test tính trên toàn bộ request:

```text
http_req_duration p95 = 144.01ms
```

Còn chart point chỉ nói:

```text
trong bucket 1 giây đó, p95 của batch này là bao nhiêu
```

Vì vậy chart này dùng để trả lời:

```text
response time thay đổi theo thời gian như nào?
đầu test có spike không?
cuối test có còn spike không?
```

không dùng để thay thế dòng summary cuối.

#### Cách phân tích sâu chart Response time

Khi nhìn chart này, đừng chỉ nhìn "cao/thấp". Hãy đọc theo 4 câu hỏi:

```text
1. Avg response có ổn định không?
2. Batch p95 có spike ở đoạn nào?
3. Batch max có outlier lớn không?
4. Spike xảy ra cùng lúc với đoạn nào của flow?
```

Với case 01, chart đẹp thường có shape:

```text
đầu run:  p95/max có thể cao hơn
giữa run: p95 ổn định thấp hơn
cuối run: p95 không tăng bất thường
```

Vì sao đầu run dễ cao hơn?

```text
- iter 0 có login
- server/cache có thể cold
- mỗi VU tạo session/cart lần đầu
- VU cùng start gần nhau -> request burst đầu lớn
```

Vì sao cuối run không nên spike mạnh?

```text
cuối run chỉ còn ít VU hơn
-> load thấp hơn
-> nếu response time lại tăng mạnh ở cuối, có thể có leak/stateful bug
```

Ví dụ đọc chart response-time của run này:

```text
01:09:17 p95=416ms
01:09:18 p95=658ms   <- spike đầu run
01:09:19 p95=118ms
...
01:09:26 p95=85ms    <- cuối run thấp hơn
```

Kết luận thực tế:

```text
- spike đầu run có, nhưng không kéo dài
- cuối run không xấu đi
- summary p95=144ms < threshold 2000ms
=> latency OK, không có dấu hiệu regression hiệu năng trong case này
```

Nếu chart xấu thì đọc như nào?

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 cao ngay từ đầu rồi ổn định | cold start / login đầu nặng | kiểm login/cache |
| p95 tăng dần càng về cuối | leak, state phình, DB/cache chậm dần | soi stateful bug |
| max spike lẻ tẻ nhưng p95 ổn | vài outlier đơn lẻ | xem log nhưng chưa vội fail |
| p95 và max cùng spike nhiều bucket | vấn đề hệ thống thật | chặn / điều tra backend |
| avg thấp nhưng p95 cao | đa số nhanh, một nhóm request rất chậm | tách theo tag endpoint |

Ghi nhớ:

```text
avg cho biết mặt bằng chung
p95 cho biết 5% request chậm nhất đang ra sao
max cho biết outlier tệ nhất
```

Với regression gate, thường ưu tiên `p95` hơn `avg`, vì user thật hay khó
chịu với tail latency chứ không chỉ trung bình.

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
RPS
```

Run thật case 01 có các point:

| Time bucket | Live VUs | HTTP reqs trong bucket | Iterations hoàn thành trong bucket |
| --- | ---: | ---: | ---: |
| 01:09:17 | 8 | 48 | 0 |
| 01:09:18 | 8 | 19 | 0 |
| 01:09:19 | 8 | 34 | 7 |
| 01:09:20 | 8 | 36 | 4 |
| 01:09:21 | 8 | 42 | 5 |
| 01:09:22 | 8 | 31 | 6 |
| 01:09:23 | 8 | 42 | 2 |
| 01:09:24 | 8 | 32 | 7 |
| 01:09:25 | 8 | 40 | 2 |
| 01:09:26 | 1 | 4 | 7 |

Kiểm tra tổng:

```text
sum(httpReqs) = 48+19+34+36+42+31+42+32+40+4 = 328
summary http_reqs = 328  ✓

sum(iterations) = 0+0+7+4+5+6+2+7+2+7 = 40
summary iterations = 40  ✓
```

Đây là cách verify chart point đúng:

```text
không cần pointCount bằng metrics_push_count
chỉ cần tổng Counter trong chart khớp summary
```

Đọc shape theo executor:

```text
01:09:17 -> 01:09:25: Live VUs = 8
01:09:26:              Live VUs = 1
sau đó:                Live VUs = 0
```

Ý nghĩa:

```text
- lúc đầu 8 VU cùng chạy quota 5 iterations/VU
- VU nhanh chạy xong trước thì idle / trả về pool
- gần cuối chỉ còn ít VU chậm chạy nốt
- hết quota thì về 0 VU
```

Đây là đúng bản chất `per-vu-iterations`:

```text
VU nhanh KHÔNG lấy thêm việc của VU chậm
```

#### Cách phân tích sâu chart Execution timeline

Chart này trả lời câu hỏi khác hẳn Response time:

```text
Response time chart:
  "request nhanh/chậm thế nào?"

Execution timeline:
  "tại mỗi giây, test đang tạo bao nhiêu tải? bao nhiêu VU còn chạy?"
```

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs
2. RPS / httpReqs mỗi bucket
3. iterations hoàn thành mỗi bucket
```

Với `per-vu-iterations`, shape "đẹp" thường là:

```text
đầu run:
  Live VUs = config VUs
  RPS cao hơn vì tất cả VU cùng hoạt động

giữa run:
  Live VUs vẫn gần config VUs nếu chưa ai xong quota
  iterations bắt đầu tăng đều

cuối run:
  Live VUs tụt xuống vì VU nhanh xong quota
  RPS tụt theo
  sau đó VUs = 0 khi toàn bộ quota xong
```

Áp vào run này:

```text
01:09:17 -> 01:09:25: Live VUs = 8
01:09:26:              Live VUs = 1
```

Đọc thực tế:

```text
- 9 bucket đầu: cả 8 VU vẫn còn active hoặc ít nhất sample thấy 8 VU active
- bucket cuối: chỉ còn một phần VU chậm đang chạy nốt
- sau bucket cuối: test kết thúc, VUs về 0
```

Điểm hay của chart này là nhìn được **đuôi idle**:

```text
8 VU cùng start
7 VU xong sớm
1 VU chậm kéo dài cuối run
```

Nếu học sinh chỉ nhìn summary:

```text
iterations = 40
iteration_duration avg = 1.91s
```

thì không thấy được timeline VU. Chart này cho thấy "ai còn chạy ở cuối".

Các shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| Live VUs không lên đủ config từ đầu | VU init/spawn có vấn đề, config/env sai | kiểm header, vus_max |
| Live VUs tụt quá sớm | nhiều VU xong quota quá nhanh, workload lệch | xem iter_time từng VU |
| Live VUs giữ cao nhưng iterations không tăng | VU bị kẹt trong request/sleep, backend chậm | xem response-time chart |
| RPS tụt nhưng Live VUs vẫn cao | request chậm hơn, ít request hoàn thành | soi latency / backend |
| iterations thiếu tổng cuối | drop/interrupt hoặc maxDuration cắt | xem CT 5, tăng maxDuration |

Đặc biệt với case 01:

```text
Live VUs tụt ở cuối là ĐÚNG, không phải lỗi.
```

Vì `per-vu-iterations` không cố giữ số VU active tới hết duration như
`constant-vus`. Nó chỉ giữ VU đến khi VU đó chạy xong quota.

### Batch 1 giây / time bucket được tính như nào?

Khi nhìn chart real-time, mỗi point trên biểu đồ KHÔNG phải là:

```text
1 VU
1 iteration
1 request
1 lần metrics_push
```

Mà là:

```text
1 time bucket = gom TẤT CẢ metric samples rơi vào cùng 1 giây
```

Ví dụ bucket:

```text
01:09:19
```

có nghĩa gần đúng là:

```text
mọi sample có timestamp trong khoảng:
  01:09:19.000 -> 01:09:19.999
được gom vào chung 1 point trên chart
```

Trong 1 bucket đó có thể có:

```text
- nhiều VU cùng chạy
- nhiều HTTP request hoàn thành
- một số iteration hoàn thành
- nhiều check pass/fail
- sample `vus` nói tại thời điểm đó còn bao nhiêu VU active
```

Với case 01 run thật, chart point:

```text
01:09:19  vus=8  httpReqs=34  iterations=7
```

đọc là:

```text
trong giây 01:09:19:
  - dashboard quan sát 8 VU đang active
  - có 34 HTTP requests hoàn thành trong giây đó
  - có 7 full journey / iterations hoàn thành trong giây đó
```

Không đọc là:

```text
1 VU chạy 34 request
hoặc 1 iteration có 34 request
```

Vì trong thời điểm đó **8 VU đang chạy song song**, nên tổng request của cả
pool VU cộng lại có thể là 34 request/giây.

#### Trong 1 bucket, các metric được gom khác nhau

| Metric trên chart | Cách gom trong bucket 1 giây | Ví dụ |
| --- | --- | --- |
| `httpReqs` / RPS | cộng số HTTP request hoàn thành trong bucket | `34` request trong giây đó |
| `iterations` / iter/s | cộng số iteration hoàn chỉnh trong bucket | `7` journey xong trong giây đó |
| `vus` | giá trị VU active quan sát được trong bucket | `8` VU đang active |
| response `avg` | trung bình response time của request trong bucket | `43.12ms` |
| response `p95` | p95 của request trong bucket | `118.47ms` |
| response `max` | request chậm nhất trong bucket | `1175.55ms` |

Vì vậy 2 chart real-time dùng 2 kiểu đọc:

```text
Execution timeline:
  đọc count/rate theo bucket: httpReqs, iterations, vus

Response time:
  đọc thống kê latency trong bucket: avg, p95, max
```

#### Vì sao phải chia theo bucket 1 giây?

Nếu dashboard vẽ từng sample riêng lẻ, chart sẽ rất khó đọc:

```text
1 run có thể sinh hàng trăm / hàng nghìn samples:
  - mỗi HTTP request là 1 sample
  - mỗi check là 1 sample
  - mỗi iteration là 1 sample
  - mỗi VU gauge là 1 sample theo thời điểm
```

Nếu vẽ raw sample:

```text
- chart quá dày
- mỗi request là 1 chấm lẻ
- không thấy xu hướng theo thời gian
- khó trả lời "giây này load cao hay thấp?"
```

Nên dashboard gom theo bucket 1 giây để học sinh đọc được:

```text
giây 1: bao nhiêu VU, bao nhiêu req/s, bao nhiêu iter/s?
giây 2: tăng hay giảm?
giây cuối: còn bao nhiêu VU?
```

Đó là lý do chart real-time dùng point theo thời gian thay vì show raw
sample từng cái.

#### Điều kiện để một event rơi vào bucket nào

Quy tắc đơn giản:

```text
event timestamp thuộc giây nào -> rơi vào bucket giây đó
```

Ví dụ:

```text
Request A hoàn thành lúc 01:09:19.123 -> bucket 01:09:19
Request B hoàn thành lúc 01:09:19.900 -> bucket 01:09:19
Request C hoàn thành lúc 01:09:20.010 -> bucket 01:09:20
```

Iteration cũng vậy:

```text
Iteration X start lúc 01:09:17.300
Iteration X end   lúc 01:09:19.200

-> HTTP requests bên trong iteration có thể nằm ở bucket 17/18/19
-> nhưng metric `iterations` chỉ tăng ở bucket 19, vì full iteration
   chỉ được tính khi iteration hoàn thành
```

Đây là lý do có thể thấy:

```text
bucket 17: httpReqs > 0 nhưng iterations = 0
bucket 18: httpReqs > 0 nhưng iterations = 0
bucket 19: iterations bắt đầu tăng
```

#### Ví dụ đọc 3 bucket liên tiếp

Từ run thật:

| Bucket | VUs | HTTP reqs | Iterations | Đọc thực tế |
| --- | ---: | ---: | ---: | --- |
| 01:09:17 | 8 | 48 | 0 | 8 VU vừa start, nhiều request đã xong, chưa full journey nào xong |
| 01:09:18 | 8 | 19 | 0 | vẫn đang trong journey đầu, request tiếp tục xong, iteration chưa complete |
| 01:09:19 | 8 | 34 | 7 | 7 VU hoàn thành journey đầu trong giây này |

Kết luận:

```text
- request-level metric đến sớm hơn
- iteration-level metric đến muộn hơn
- vì iteration chỉ được emit khi toàn bộ default() / journey xong
```

#### Batch 1s khác `metrics_push_count` như nào?

Đừng nhầm:

```text
metrics_push_count = số lần backend nhận payload metrics từ k6
chart pointCount   = số time bucket dashboard render
```

Ví dụ run này:

```text
metrics_push_count = 8
chart pointCount = 10
```

Vẫn đúng, vì chart pointCount là số bucket theo thời gian. Backend có thể
nhận 8 lần push, nhưng sau khi gom/replay theo Unix second thì thành 10
bucket timestamp.

Cách kiểm chart đúng:

```text
sum(bucket.httpReqs) == summary.http_reqs
sum(bucket.iterations) == summary.iterations
```

Không kiểm:

```text
metrics_push_count == pointCount
```

### `rawVus`, `vus`, `vusSource` trong chart JSON là gì?

Từ bản dashboard mới, khi bấm **Copy JSON** ở các chart sau:

```text
Execution timeline
VUs vs iter/s
Executor behavior
```

mỗi point có thêm 3 field để debug VU rõ hơn:

```json
{
  "rawVus": 6,
  "vus": 6,
  "vusSource": "gauge"
}
```

Đọc như sau:

| Field | Nghĩa | Dùng để làm gì? |
| --- | --- | --- |
| `rawVus` | giá trị VU gốc từ backend WebSocket/replay trước khi frontend fill | biết backend có gửi gauge thật không |
| `vus` | giá trị VU mà chart đang vẽ | đây là số nhìn trên biểu đồ |
| `vusSource` | nguồn của `vus` | biết `vus` là gauge thật hay frontend fill |

`vusSource` có 4 giá trị:

| `vusSource` | Nghĩa | Đọc thế nào? |
| --- | --- | --- |
| `gauge` | backend có gửi VU gauge thật trong bucket đó | số VU đáng tin nhất cho bucket đó |
| `filled-forward` | bucket thiếu gauge, frontend lấy VU từ point trước | dùng để tránh vẽ VU=0 giả |
| `filled-backward` | bucket thiếu gauge, frontend lấy VU từ point sau | dùng để lấp khoảng trống đầu/giữa chart |
| `missing` | không có gauge và không fill được | không nên kết luận VU ở bucket đó |

#### Vì sao cần `vusSource`?

`vus` là metric dạng Gauge, không phải Counter. Counter như `http_reqs`,
`iterations` có thể cộng theo bucket rất chắc. Nhưng `vus` là sample theo
thời điểm, có thể có bucket:

```text
có httpReqs / iterations
nhưng thiếu sample vus đúng trong bucket đó
```

Nếu frontend vẽ `vus=0` trong bucket đó thì học sinh sẽ hiểu nhầm:

```text
có request chạy nhưng không có VU nào active
```

nên frontend có thể fill VU từ bucket gần đó. `vusSource` cho biết bucket
đó là:

```text
gauge thật hay số được fill
```

#### Ví dụ run #7 đã verify

Run mới sau khi dashboard thêm field này:

```text
run #7
summary iterations = 40
summary http_reqs = 328
summary vus min/max = 6/8
```

Last point của cả 3 chart đều có:

```json
{
  "rawVus": 6,
  "vus": 6,
  "vusSource": "gauge",
  "httpReqs": 2,
  "iterations": 6
}
```

Đọc nghĩa:

```text
- backend có gửi gauge thật cho bucket cuối
- chart vẽ đúng giá trị đó
- không phải frontend fill
- summary vus_min = 6 cũng khớp
```

Cách kiểm nhanh sau này:

```text
Nếu vusSource = gauge:
  rawVus == vus -> chart đang vẽ gauge thật

Nếu vusSource = filled-forward / filled-backward:
  vus là giá trị frontend fill để giữ đường chart liên tục
  không dùng exact VU bucket đó làm bằng chứng cứng

Nếu vusSource = missing:
  không kết luận VU bucket đó
```

Vì vậy khi đọc chart, dùng quy tắc:

```text
Counter totals (iterations/httpReqs) -> dùng để verify workload
Observed VUs + vusSource             -> dùng để hiểu concurrency shape
```

### Vì sao 2 bucket đầu có `iterations = 0` nhưng vẫn có HTTP reqs?

Ở bucket đầu:

```text
httpReqs = 48
iterations = 0
```

Điều này bình thường.

Lý do:

```text
HTTP request được ghi ngay khi request hoàn tất
nhưng metric `iterations` chỉ tăng khi TOÀN BỘ iteration xong
```

Một iteration case 01 gồm nhiều bước:

```text
login/browse/detail/add-to-cart/checkout/confirm + sleep
```

Nên trong 1-2 giây đầu có thể đã có nhiều request xong, nhưng chưa có
iteration nào hoàn chỉnh. Đến khi full journey xong, `iterations` mới tăng.

Cách nhớ:

```text
http_reqs    = request event
iterations   = full journey event
```

### Chart 3 — VUs vs iter/s

Chart này có JSON debug dạng:

```text
Debug JSON: vus-vs-iterations
```

Chart này trả lời câu hỏi:

```text
Executor dự kiến có bao nhiêu VU?
Trong từng giây, thực tế hoàn thành bao nhiêu iteration?
Throughput iteration có bám theo shape VU không?
```

Nó dùng cùng dữ liệu bucket như Execution timeline, nhưng đổi góc nhìn:

```text
Execution timeline:
  nhìn VUs + HTTP RPS

VUs vs iter/s:
  nhìn VUs + completed iterations per second
```

Các series chính:

```text
Executor VUs
Actual iter/s
```

Đọc nhanh:

| Series | Nghĩa | Với case 01 kỳ vọng |
| --- | --- | --- |
| `Executor VUs` | đường VU theo executor/config/envelope | quanh `8` trong lúc run |
| `Actual iter/s` | số full journey hoàn thành trong mỗi bucket 1 giây | dao động, tổng = `40` |

Điểm khác với `Execution timeline`:

```text
Execution timeline cho bạn biết request load: req/s
VUs vs iter/s cho bạn biết business flow throughput: journey/s
```

#### Bucket của chart này có khác 2 chart realtime không?

Không khác về **cách chia thời gian**.

Cả 3 chart trong Overview đều lấy từ cùng nguồn:

```text
metricsHistory / WebSocket frames / replay frames
```

và cùng kiểu bucket:

```text
1 bucket ~= 1 giây dữ liệu
```

Khác nhau là **mỗi chart rút metric nào ra từ cùng bucket đó**:

| Chart | Cùng bucket 1 giây lấy gì? | Câu hỏi trả lời |
| --- | --- | --- |
| Response time | `http_req_duration avg/p95/max` trong bucket | request chậm/nhanh ra sao? |
| Execution timeline | `vus` + `httpReqs`/RPS trong bucket | lúc đó có bao nhiêu VU và bao nhiêu request/s? |
| VUs vs iter/s | `vus` + `iterations`/iter/s trong bucket | lúc đó có bao nhiêu VU và bao nhiêu journey/s? |

Ví dụ cùng bucket `01:09:19` có thể được 3 chart đọc khác nhau:

```text
Response time:
  avg=43ms, p95=118ms, max=1175ms

Execution timeline:
  vus=8, httpReqs=34

VUs vs iter/s:
  vus=8, iterations=7, iterationRate=7/s
```

Nghĩa là:

```text
cùng một lát cắt thời gian
nhưng mỗi chart soi một khía cạnh khác nhau
```

Cách nhớ:

```text
Response time      = chất lượng request trong bucket
Execution timeline = request load trong bucket
VUs vs iter/s      = business journey throughput trong bucket
```

Với case 01, một iteration = một full user journey:

```text
login/browse/detail/add-to-cart/checkout/confirm
```

nên `Actual iter/s` ở chart này chính là:

```text
mỗi giây có bao nhiêu full journey regression được replay xong
```

Ví dụ input của chart:

```json
{
  "configuredVUs": 8,
  "peakVUs": 8,
  "summaryIterationRate": 3.9256369728738094,
  "runIsFinished": true,
  "envelopeVUs": 8
}
```

Đọc:

```text
configuredVUs = 8
  config scenario có 8 VU

summaryIterationRate = 3.925637/s
  trung bình toàn run, lấy từ summary `iterations...: 40 3.925637/s`

Actual iter/s
  số iteration hoàn thành trong từng bucket 1 giây
```

Với run này, một lần render chart có thể cho sequence kiểu:

```text
bucket iterations: 0,0,7,4,5,6,2,7,2,7
sum = 40
```

Nhưng không cần thuộc đúng sequence này. Khi dashboard replay lại, bucket
split có thể hơi khác. Tiêu chí đúng là:

```text
sum(bucket iterations) = summary iterations
```

Nên chart đúng nếu tổng bucket vẫn bằng `40`.

#### Ý nghĩa thực tế của chart này trong case 01

Trong case 01, business question là:

```text
QA replay được bao nhiêu full user journey mỗi giây?
```

Vì vậy chart này không chỉ là chart kỹ thuật. Nó nối trực tiếp tới kết luận
nghiệp vụ:

```text
Actual iter/s cao và ổn định
  -> regression suite chạy nhanh, CI/release gate ít tốn thời gian

Actual iter/s tụt dài trong khi VUs vẫn cao
  -> VU đang bị kẹt trong journey, có thể backend chậm hoặc flow bị treo

Actual iter/s tổng lại không đủ total expected
  -> test không replay đủ workload, không được dùng để kết luận release
```

Với run này:

```text
total expected = 40 journey
sum Actual iter/s = 40
```

Kết luận:

```text
case 01 đã replay đủ toàn bộ user journey
chart iter/s khớp với summary
có thể dùng kết quả để đọc latency / pass criteria tiếp
```

#### Cách phân tích sâu chart VUs vs iter/s

Chart này dễ nhầm nhất vì nó trộn 2 thứ:

```text
Executor VUs
  đường "khung" / envelope của executor

Actual iter/s
  số iteration hoàn thành trong từng bucket
```

Với `per-vu-iterations`, đường `Executor VUs` trả lời:

```text
executor này dự kiến chạy bao nhiêu VU?
```

Còn `Actual iter/s` trả lời:

```text
mỗi giây thật sự có bao nhiêu full journey hoàn thành?
```

Đừng đọc `Actual iter/s` là tốc độ đều đặn. Nó là số rời rạc theo bucket:

```text
0, 0, 7, 4, 5, 6, 2, 7, 2, 7
```

Vì sao nó nhảy lên xuống?

```text
- iteration không kết thúc đúng mỗi 1 giây
- các VU có response time khác nhau
- một số VU xong cùng lúc -> bucket đó iterations cao
- bucket khác nhiều VU đang giữa journey -> iterations thấp
```

Ví dụ:

```text
bucket 01:09:19 có iterations=7
  -> 7 full journey cùng kết thúc trong giây đó

bucket 01:09:23 có iterations=2
  -> chỉ 2 journey kết thúc trong giây đó
```

Cả hai đều bình thường. Cần nhìn:

```text
sum toàn chart = 40
average summary = 40 / runtime ≈ 3.93/s
```

Đừng kỳ vọng mỗi bucket đều gần `3.93`. `3.93/s` là trung bình toàn run,
không phải giá trị từng giây.

Shape mong đợi của case 01:

```text
- đầu run: iter/s có thể 0 vì chưa journey nào xong
- giữa run: iter/s dao động theo batch hoàn thành
- cuối run: iter/s có thể còn cao ở bucket cuối nếu nhiều VU finish sát nhau
- sau cùng: về 0 vì test xong
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| `Actual iter/s` đầu = 0, sau đó tăng | journey đầu chưa hoàn tất, request vẫn đang chạy | bình thường |
| `Actual iter/s` dao động 2/7/4/... | nhiều VU finish không cùng thời điểm | bình thường |
| `Actual iter/s` = 0 lâu trong khi VUs cao | VU bị kẹt trong request/sleep/flow | cần điều tra |
| `Actual iter/s` tụt về 0 và VUs cũng về 0 | test xong quota | bình thường |
| sum `Actual iter/s` < expected total | thiếu iteration / drop / interrupt | test invalid |
| `Actual iter/s` quá cao bất thường | bucket/replay/counter có thể đang double count | kiểm sum với summary |

Các câu hỏi nên tự hỏi khi nhìn chart này:

```text
1. Sum Actual iter/s theo bucket có bằng total iterations không?
2. Average summary có thấp hơn peak không?
3. Đuôi cuối có còn VU nhưng iter/s thấp không?
4. Có đoạn dài VUs cao mà iter/s = 0 không? Nếu có, backend có bị kẹt không?
```

Với run này:

```text
sum bucket iter/s = 40
summary iterations = 40
predicted peak ≈ 4.18/s
summary average ≈ 3.93/s
```

Kết luận:

```text
- chart cộng đúng total
- average thấp hơn peak một chút -> hợp lý
- không có đoạn dài VUs cao nhưng iter/s=0 sau giai đoạn đầu
=> executor behavior bình thường
```

#### Kiểm chứng tính đúng đắn của chart `VUs vs iter/s`

Chart này gần giống tab Executor, nên cần kiểm riêng để tránh hiểu nhầm.
Nó đúng nếu thỏa 4 điều kiện:

```text
1. VUs trong chart khớp series `vus`
2. `vusSource` cho biết VUs là gauge thật hay frontend fill
3. Actual iter/s trong chart khớp series `iterations` đã group theo giây
4. Tổng Actual iter/s theo các bucket = summary `iterations`
5. Timeline/envelope thể hiện đúng shape của per-vu-iterations
```

Với run thật case 01:

```text
summary iterations = 40
summary http_reqs  = 328
configured VUs     = 8
```

Cách kiểm đúng KHÔNG phải là học thuộc từng point cụ thể, vì khi dashboard
live/replay lại data, số bucket có thể lệch nhẹ theo cách replay frame. Cách
kiểm đúng là:

```text
sum(Actual iter/s theo bucket) == summary iterations
sum(HTTP reqs theo bucket)    == summary http_reqs
configuredVUs                == summary vus_max
```

Một lần render chart có thể có bảng point như sau:

| Time bucket | Observed VUs | Actual iter/s | HTTP reqs |
| --- | ---: | ---: | ---: |
| bucket 1 | 8 | 0 | 48 |
| bucket 2 | 8 | 0 | 19 |
| bucket 3 | 8 | 7 | 34 |
| bucket 4 | 8 | 4 | 36 |
| bucket 5 | 8 | 5 | 42 |
| bucket 6 | 8 | 6 | 31 |
| bucket 7 | 8 | 2 | 42 |
| bucket 8 | 8 | 7 | 32 |
| bucket 9 | 8 | 2 | 40 |
| bucket 10 | 1 | 7 | 4 |

Kiểm bằng tổng Counter:

```text
sum(Actual iter/s theo bucket)
  = 40
  = summary iterations ✓

sum(HTTP reqs theo bucket)
  = 328
  = summary http_reqs ✓
```

Trong lần re-check bằng dashboard sau đó, chart render ra 11 points thay vì
10 points, nhưng vẫn đúng vì:

```text
pointCount = points.length = 11 ✓
sum(iterations) = 40 = summary iterations ✓
sum(httpReqs)   = 328 = summary http_reqs ✓
configuredVUs   = 8 = summary vus_max ✓
```

Nên kết luận là:

```text
exact bucket list có thể thay đổi nhẹ theo replay
nhưng tổng Counter + VU config phải khớp summary
```

Vì `aggregationPeriod = 1`, nên:

```text
iterations trong bucket = iterationRate của bucket
```

Nếu sau này `aggregationPeriod` khác 1 giây, phải đọc:

```text
iterationRate = iterations / aggregationPeriod
```

Còn run này bucket đang là 1 giây nên số `7` đọc được là:

```text
7 iterations hoàn thành trong giây đó = 7 iter/s tại bucket đó
```

##### Timeline/envelope có gì đặc biệt?

Chart này còn có timeline phụ để vẽ đường executor trên chart:

```text
điểm mở đầu synthetic: executorVUs=0 observedVUs=0
các bucket trong run: executorVUs≈configured VUs, observedVUs theo sample thực tế
điểm kết thúc synthetic: executorVUs=0 observedVUs=0
```

Hai điểm `0` đầu/cuối dùng để vẽ đường quay về baseline trên biểu đồ.
Không đọc chúng là "VU thật chạy 0 trong lúc test". Chúng là điểm chart
để biểu đồ nhìn đủ start/end.

Điểm quan trọng nhất cần kiểm không phải là "bucket cuối chính xác bằng
mấy VU", mà là:

```text
executorVUs / configuredVUs = 8
observedVUs không vượt quá 8
observedVUs có thể thấp hơn 8 ở đoạn cuối
```

Đọc nghĩa:

```text
config/envelope của executor là 8 VU
nhưng thực tế gần cuối có thể chỉ còn một phần VU active
```

Đây đúng bản chất `per-vu-iterations`:

```text
VU nhanh đã xong quota -> rời active pool
VU chậm còn chạy nốt -> observedVUs có thể thấp hơn Fixed/Executor VUs
```

Lưu ý từ re-check:

```text
Counter totals của chart ổn định và là tiêu chí chính:
  sum(iterations) = 40
  sum(httpReqs) = 328

Observed VUs theo từng bucket có thể khác nhẹ giữa live/replay frame,
ví dụ lần này bucket cuối có thể còn 1 VU, lần replay khác có thể còn 5 VU.
Không dùng exact VU của 1 bucket làm pass/fail chính; dùng nó để đọc shape.
```

##### Chart này giống và khác tab Executor thế nào?

| Điểm so sánh | `VUs vs iter/s` ở Overview | `Executor behavior` ở tab Executor |
| --- | --- | --- |
| Mục đích | đọc nhanh VUs + iter/s theo bucket | giải thích mô hình executor đầy đủ hơn |
| Dữ liệu điểm | dùng cùng metricsHistory points | dùng cùng metricsHistory points |
| Series chính | Executor VUs, Actual iter/s | Fixed VUs, Observed VUs, Actual iter/s, Peak if all active |
| Có peak line? | không / ít nhấn mạnh | có `Peak if all active` |
| Dùng để học gì? | bucket nào hoàn thành bao nhiêu iter | vì sao actual thấp hơn peak, vì sao VU tụt |

Nói ngắn:

```text
VUs vs iter/s = bản đọc nhanh trong Overview
Executor tab  = bản giải thích sâu theo executor model
```

Vì cùng dùng metricsHistory, nếu points của `VUs vs iter/s` cộng đúng total
và shape VU đúng, thì tab Executor cũng có nền dữ liệu đúng. Tab Executor
chỉ thêm lớp tính toán peak:

```text
predicted_peak = configuredVUs / iteration_duration_avg
               = 8 / 1.912
               ≈ 4.18 iter/s
```

Kết luận kiểm chứng chart này:

```text
- Actual iter/s cộng lại đúng 40 iterations
- HTTP reqs theo bucket cộng lại đúng 328 requests
- configuredVUs = 8 khớp summary vus_max
- observedVUs không vượt quá configuredVUs và có thể thấp hơn ở cuối run
- `rawVus/vus/vusSource` cho biết VU là gauge thật hay frontend fill
- timeline có điểm synthetic 0 đầu/cuối để vẽ chart
=> chart VUs vs iter/s đo đúng cho case 01
```

Nói cách khác: chart này PASS theo tiêu chí dữ liệu Counter + config VU.
Không dùng exact observedVUs của từng bucket làm tiêu chí cứng nếu
`vusSource` không phải `gauge`, vì frontend có thể fill VU để tránh vẽ
`0` giả.

### 2. Tab Executor / Execution

Chuyển sang tab:

```text
Executor
```

Dashboard detect đúng:

```text
EXECUTOR = per-vu-iterations
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
```

Input từ run thật:

```json
{
  "configuredVUs": 8,
  "peakVUs": 8,
  "iterationDurationAvg": 1912.2682775,
  "iterationAvgSeconds": 1.9122682775,
  "summaryIterationRate": 3.9256369728738094,
  "predictedPeakIterationRate": 4.183513419183411
}
```

Đọc từng dòng:

```text
Fixed VUs
  đường config/envelope: case này là 8 VUs

Observed VUs
  VU thật quan sát theo bucket: 8 ở đầu, 1 ở cuối, 0 khi xong

Actual iter/s
  số iteration hoàn thành theo từng bucket

Peak if all active
  throughput ước lượng nếu cả 8 VU đều còn active
```

Tự tính peak:

```text
iteration_duration avg ≈ 1.912s
predicted_peak ≈ vus / iter_time
               ≈ 8 / 1.912
               ≈ 4.18 iter/s
```

Summary thực tế:

```text
iterations rate = 3.925637/s
```

Đọc kết luận:

```text
actual average ≈ 3.93/s < predicted peak ≈ 4.18/s
```

Điều này đúng, vì:

```text
- có overhead runtime / request đầu / sleep
- các VU không xong cùng lúc tuyệt đối
- cuối run có đuôi idle: chỉ còn ít VU chạy nốt
```

Đây chính là ý "maximum throughput reached but not maintained".

#### Cách phân tích sâu tab Executor

Tab Executor không chỉ lặp lại số summary. Nó giúp trả lời câu hỏi:

```text
executor này sinh load theo MÔ HÌNH nào?
shape thực tế có đúng mô hình đó không?
```

Với case 01, executor là:

```text
per-vu-iterations
```

Nên mô hình kỳ vọng là:

```text
- có fixed quota: mỗi VU chạy đúng 5 iter
- VU chạy song song lúc đầu
- VU nào xong quota thì rời khỏi active VU pool
- không có work stealing
- throughput peak có thể đạt ở đầu, nhưng không giữ đến cuối
```

Đọc từng đường trong chart:

| Đường | Hỏi câu gì? | Với case 01 kỳ vọng |
| --- | --- | --- |
| `Fixed VUs` | config/envelope là bao nhiêu VU? | `8` VU |
| `Observed VUs` | thực tế còn bao nhiêu VU active theo thời gian? | đầu gần `8`, cuối có thể tụt thấp hơn rồi `0` |
| `Actual iter/s` | mỗi bucket hoàn thành bao nhiêu journey? | dao động, tổng = `40` |
| `Peak if all active` | nếu cả 8 VU đều chạy đều thì peak khoảng bao nhiêu? | `~4.18 iter/s` |

Với bản dashboard mới, tooltip / Copy JSON của `Observed VUs` còn cho biết
source:

```text
Observed VUs source: gauge
Observed VUs source: filled-forward
Observed VUs source: filled-backward
```

Nếu source là `gauge`, đó là sample VU thật từ backend. Nếu là `filled-*`,
đó là số frontend fill để giữ chart không bị tụt xuống 0 giả.

Điểm cần dạy học sinh: **đường Fixed VUs không có nghĩa là lúc nào cũng có
8 VU đang bận**.

Với `per-vu-iterations`:

```text
Fixed/config VUs = 8
nhưng Observed VUs có thể tụt thấp hơn 8 ở cuối
```

Đây không phải bug. Đó là do:

```text
VU nhanh xong quota -> idle / returned
VU chậm còn chạy -> Observed VUs thấp hơn Fixed VUs
```

So sánh với executor khác:

| Executor | Fixed/Observed VUs nên đọc thế nào? |
| --- | --- |
| `constant-vus` | Observed VUs thường giữ gần config trong suốt duration |
| `per-vu-iterations` | Observed VUs giảm khi VU xong quota |
| `shared-iterations` | Observed VUs cũng có thể giảm cuối test khi work chung gần hết |
| `arrival-rate` | Observed VUs là số VU cần dùng để kịp schedule, không phải target rate |

Vì vậy tab Executor là nơi học sinh trả lời:

```text
shape này có đúng với executor mình chọn không?
```

Với run này:

```text
Fixed VUs = 8
Observed VUs: đầu gần 8, cuối thấp hơn 8, rồi về 0
summary average = 3.93/s
predicted peak = 4.18/s
```

Kết luận học tập:

```text
- per-vu-iterations chạy đúng mô hình
- không giữ throughput peak đến cuối
- đuôi cuối là do VU chậm nhất
- summary average thấp hơn peak là bình thường
```

Nếu tab Executor cho shape khác thì nghi gì?

| Shape bất thường | Có thể nghĩa là gì |
| --- | --- |
| Executor detect sai | metadata filename/executor không đúng, UI override sai |
| Observed VUs không lên tới config | VU init lỗi, run bị cắt sớm, config khác mong đợi |
| Observed VUs tụt rất sớm | quota quá ít, iter_time lệch lớn, VU nhanh kết thúc quá sớm |
| Actual iter/s bằng 0 lâu dù VUs cao | request bị treo hoặc iteration rất dài |
| Actual average cao hơn peak rất nhiều | công thức peak/input iter_time sai, hoặc chart đang đọc metric khác |

### 3. `metrics_push_count` khác `pointCount` — không phải bug

Trong dashboard có thể thấy:

```text
Recent runs: batches 8
```

Run metadata:

```text
metrics_push_count = 8
```

Nhưng chart debug JSON có:

```text
response-time.pointCount = 10
execution-timeline.pointCount = 10
vus-vs-iterations.pointCount = 10
```

Điều này **hợp lệ**.

Backend contract:

```text
metrics_push_count
  = số metrics payload / MetricSet backend nhận và xử lý từ k6
  = số ingest pushes

chart pointCount
  = số time buckets / WebSocket frames dashboard render từ live/replay data
```

Hai số này không có quan hệ 1-1:

```text
metrics_push_count không cần bằng pointCount
```

Với run này:

```text
metrics_push_count = 8
chart pointCount   = 10
```

nhưng chart vẫn đúng vì:

```text
sum(chart.httpReqs)   = 328 = summary.http_reqs
sum(chart.iterations) = 40  = summary.iterations
```

Cách verify đúng:

```text
ĐỪNG kiểm: metrics_push_count == pointCount
HÃY kiểm:  sum Counter theo chart buckets == final summary Counter
```

### 4. Endpoint debug series theo metric

Nếu muốn kiểm trực tiếp series aggregate theo từng metric, backend có endpoint:

```http
GET /v1/tests/:id/series?metric=http_reqs
```

Ví dụ:

```http
GET http://localhost:13001/v1/tests/5/series?metric=http_reqs
Authorization: Bearer student-token-1234567890
```

Endpoint này trả points theo metric sau aggregation. Nó không phải raw push
log. Hiện chưa có endpoint map trực tiếp:

```text
raw push #1 -> chart bucket nào
raw push #2 -> chart bucket nào
```

nhưng để học sinh verify chart, endpoint series là đủ:

```text
series(http_reqs)    -> cộng lại phải bằng summary.http_reqs
series(iterations)   -> cộng lại phải bằng summary.iterations
```

### 5. Checklist đọc biểu đồ case 01

Khi học sinh nhìn dashboard case 01, đọc theo thứ tự này:

```text
1. Overview KPI
   - iterations = total expected?
   - http_req_failed = 0%?
   - checks = 100%?

2. Response time chart
   - batch p95 đầu có spike không?
   - cuối test còn spike không?
   - nhớ: batch p95 != final summary p95

3. Execution timeline
   - Live VUs đầu có bằng config không?
   - cuối run VUs có tụt dần không?
   - `vusSource` là gauge hay filled-*?
   - sum iterations theo bucket có bằng summary iterations không?

4. VUs vs iter/s
   - actual iter/s theo bucket dao động thế nào?
   - sum actual iter/s có bằng summary iterations không?
   - `rawVus` và `vus` có khác nhau không?
   - nếu khác, `vusSource` là filled-forward/backward hay missing?
   - summary average iter/s có nằm dưới peak không?

5. Executor tab
   - executor detect đúng `per-vu-iterations` không?
   - Fixed VUs = config không?
   - Observed VUs có xu hướng đầu gần config VUs, cuối tụt về 0 không?
   - Observed VUs source là gauge hay fill?
   - predicted peak > actual average không?
```

Kết luận của run case 01 đang đúng nếu thấy:

```text
iterations = 40/40 hoặc 150/150 (tùy config)
http_req_failed = 0%
checks = 100%
Live VUs: đầu = config VUs, cuối giảm về 0
sum chart iterations = summary iterations
sum chart httpReqs = summary http_reqs
executor = per-vu-iterations
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
