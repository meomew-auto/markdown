# Case 06: Cart concurrency consistency per user

## Tình huống thực tế

User mở 3 tab browser cùng lúc, mỗi tab thêm sản phẩm khác nhau vào cart.
Nếu backend không lock đúng → race condition → lost update (cart bị mất
item).

```text
Yêu cầu test:
  - 10 users
  - Mỗi user gửi 10 đợt × 3 request song song = 30 cart_add
  - Verify: cart.total cuối == 30 items (đủ, không lost)
  - Tổng: 10 user × 30 items = 300 cart_add request
```

## Vì sao "cart race test" buộc chọn per-vu-iterations?

Trước khi vào kỹ thuật, hiểu **race condition** và **lost update** là gì:

```text
Race condition = 2 thao tác chạy ĐỒNG THỜI lên cùng dữ liệu, kết quả
                 phụ thuộc "ai xong trước" -> không đoán trước được.

Lost update = 1 dạng race: 2 update đọc cùng giá trị cũ, ghi đè lẫn nhau
              -> 1 update bị MẤT.

Đời thường:
  Sổ tiết kiệm có 100k. Vợ và chồng cùng nạp 50k đúng lúc:
    Vợ đọc số dư 100k -> +50k -> ghi 150k
    Chồng đọc số dư 100k (cùng lúc) -> +50k -> ghi 150k
  Kết quả: 150k (lẽ ra phải 200k) -> MẤT 50k của 1 người
```

Để test race này **đúng**, phải đảm bảo **2 yêu cầu cốt lõi**.
Chỉ per-vu-iterations mới thỏa mãn cả 2.

### Yêu cầu (a): CÙNG USER-ID GỬI REQUEST ĐỒNG THỜI

**Ý nghĩa**: Lost update chỉ xảy ra khi nhiều request thao tác lên cart của
CÙNG 1 user. Phải tạo được "cùng user, nhiều request song song".

```text
Flow đúng (cùng user, 3 tab song song):
  User VU=1: http.batch([
    POST /cart/add (product 1),   ┐
    POST /cart/add (product 2),   ├─ 3 request CÙNG user, ĐỒNG THỜI
    POST /cart/add (product 3),   ┘
  ])
  -> server phải atomic update cart user 1 -> đủ 3 item

Vì sao per-vu đảm bảo?
  - 1 VU = 1 user (X-User-Id cố định theo __VU)
  - http.batch() trong iter -> 3 request song song CÙNG user-id
  - Đây CHÍNH XÁC là điều kiện trigger lost update
```

**Vì sao executor khác fail?**

```text
✗ shared-iterations / constant-vus:
  - VU pool race với NHAU, nhưng mỗi VU là user KHÁC
  - VU1=userA, VU2=userB cùng add -> KHÔNG đụng cart (khác user)
  - Server lock per-user -> không có contention -> không trigger bug
  - Test "pass" giả vì không tạo được same-user race
```

### Yêu cầu (b): ĐỦ BURST ĐỂ TRIGGER LOST UPDATE

**Ý nghĩa**: Race là xác suất — không phải lần nào cũng xảy ra. Phải lặp
nhiều đợt (burst) để tăng khả năng trigger và verify tổng cuối.

**3 nguyên nhân kỹ thuật của lost update**:

#### Nguyên nhân 1: READ-MODIFY-WRITE RACE (đọc-sửa-ghi không atomic)

**Vấn đề kinh điển**: thêm item vào cart = đọc cart hiện tại, thêm item, ghi
lại. Nếu 2 request làm cùng lúc → ghi đè nhau.

```text
Cart user A đang có [item1]:
  Request 2 (add item2): đọc [item1]              ┐ cùng đọc
  Request 3 (add item3): đọc [item1]              ┘ [item1]
  Request 2: ghi [item1, item2]
  Request 3: ghi [item1, item3]   <- ghi đè, MẤT item2
  Kết quả: [item1, item3] -> mất item2 (lost update)

Fix đúng:
  - Atomic: UPDATE cart SET items = items || item WHERE user=A
  - Hoặc dùng SELECT FOR UPDATE (pessimistic lock)

→ Test phải gửi nhiều add SONG SONG cùng user -> trigger
→ per-vu + http.batch: tạo đồng thời chính xác
```

#### Nguyên nhân 2: OPTIMISTIC LOCK MISS (thiếu version check)

**Optimistic lock**: mỗi cart có `version`, update phải kèm version đang giữ.
Nếu code quên check version → lost update.

```text
Có optimistic lock đúng:
  UPDATE cart SET items=?, version=version+1
  WHERE user=A AND version=5
  -> nếu version đã đổi (request khác update trước) -> affected_rows=0
  -> retry với version mới

Bug: quên điều kiện "AND version=5"
  -> UPDATE luôn thành công -> ghi đè -> lost update

→ Test phát hiện bằng cách verify tổng item cuối = tổng đã gửi
→ per-vu: biết chính xác đã gửi 30 item -> so cart.total cuối = 30?
```

#### Nguyên nhân 3: CACHE-DB INCONSISTENCY (cache và DB lệch nhau)

**Vấn đề**: cart ghi vào cache (Redis) trước, sync DB sau. 2 request song
song → cache và DB lệch.

```text
Write-back cache:
  Request 2: ghi cache [item1,item2], chưa sync DB
  Request 3: đọc DB (chưa có item2) -> [item1] -> ghi [item1,item3]
  -> cache: [item1,item2], DB: [item1,item3] -> LỆCH
  -> lần đọc sau tùy nguồn (cache hay DB) -> kết quả khác nhau

Fix: write-through (ghi cache + DB atomic), hoặc invalidate đúng cách

→ Test verify bằng GET /cart/summary cuối (đọc nguồn thật)
→ per-vu: iter cuối check tổng -> phát hiện lệch cache-DB
```

#### Tổng kết: chỉ per-vu thỏa mãn cả (a) và (b)

| Executor | (a) Cùng user-id đồng thời | (b) Đủ burst trigger race | Verdict |
| --- | --- | --- | --- |
| **per-vu-iterations** | ✓ 1 VU=1 user + http.batch | ✓ mỗi VU đủ N burst | ✅ DÙNG |
| shared-iterations | ✗ VU khác = user khác | ✗ phân phối burst không đều | ❌ |
| constant-vus (duration) | ✗ race giữa user khác nhau | ✗ số burst phụ thuộc latency | ❌ |
| constant-arrival-rate | ✗ identity rời VU | ✗ rate-driven, khó đồng thời | ❌ |
| ramping-vus | ✗ VU = user khác | ✗ burst biến thiên | ❌ |
| ramping-arrival-rate | ✗ rate-driven | ✗ không bound user | ❌ |

→ Chỉ **per-vu-iterations** đảm bảo "cùng user-id gửi nhiều request đồng
thời đủ số burst", điều kiện BẮT BUỘC để trigger và verify lost update.

## Config

```js
export const options = {
  scenarios: {
    cart_race: {
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 10,           // 10 burst per user
      maxDuration: "2m",
    },
  },
  thresholds: {
    cart_total_match: ["count==10"],  // 10 user đều có cart đủ
    cart_total_lost: ["count==0"],    // không lost-update
  },
};
```

## Endpoint flow

```text
Iter 0: setup user_id, token
Iter 0-9: BURST mode
  - 3 request POST /cart/add SONG SONG (http.batch)
  - Mỗi request thêm 1 product khác
Iter 9 (cuối): GET /cart/summary
  - Verify total = 30 items
  - Nếu < 30: lost-update detected
```

**Code thật từ file pvi-06-cart-concurrency.js** — per-VU state mechanism:

```js
// ───── Module-level scope (GIỮ qua 10 burst) ─────
let userId = null;
let userToken = null;
let expectedItemCount = 0;    // tích lũy số item đã add qua iter

// ───── Trong default() ─────
export default function () {
  // Iter 0: setup identity
  if (__ITER === 0) {
    userId = `user-${__VU}`;           // ← GIỮ: user identity
    userToken = `token-${__VU}`;       // ← GIỮ: auth token
    expectedItemCount = 0;             // ← GIỮ: reset counter
  }

  // 3 cart_add SONG SONG (cùng user, 3 tab)
  const requests = [];
  for (let i = 0; i < 3; i++) {
    requests.push({
      method: "POST",
      url: `/api/sim/cart/add`,
      body: JSON.stringify({ product_id: ..., quantity: 1 }),
      params: { headers: {
        "Authorization": `Bearer ${userToken}`,
        "X-User-Id": userId,
      }},
    });
  }
  const responses = http.batch(requests);
  expectedItemCount += responses.filter(r => r.status === 200).length;

  // Iter cuối: verify cart.total
  if (__ITER === 9) {
    const summary = http.get(`/api/sim/cart/summary`, {
      headers: { "X-User-Id": userId },
    });
    // expectedItemCount = 10 burst × 3 items = 30
    // nếu cart chỉ có 28 -> lost-update!
  }
}
```

**Trace execution cho VU=1 qua 10 iter**:

```text
Iter 0: userId = "user-1", userToken = "token-1"
        batch add ×3 -> expectedItemCount = 3

Iter 1: userId VẪN = "user-1" ← ĐỌC TỪ MODULE-LEVEL
        batch add ×3 -> expectedItemCount = 6

...Iter 2-8: expectedItemCount = 9, 12, 15, 18, 21, 24, 27

Iter 9: batch add ×3 -> expectedItemCount = 30
        GET /cart/summary -> verify cart.total == 30
        ✓ cart total match: 30/30
```

> **Tại sao cùng user gửi request suốt 10 burst?** Cùng cơ chế case 01:
> `let userId, userToken, expectedItemCount` ở module-level GIỮ qua iter
> — user identity không đổi, cart count tích lũy. Xem
> [case 01 / Per-VU state](./01_user-journey-replay.md#per-vu-state).

## Pattern http.batch

```js
const requests = [];
for (let i = 0; i < 3; i++) {
  requests.push({
    method: "POST",
    url: `${BASE_URL}/api/sim/cart/add`,
    body: JSON.stringify({
      user_id: userId,
      product_id: `prod-${__VU}-${__ITER}-${i}`,
    }),
    params: {
      headers: { Authorization: `Bearer ${userToken}` },
      tags: { name: "cart_add" },
    },
  });
}
const responses = http.batch(requests);
```

## Pass criteria

```text
1. cart_total_match == 10 (mọi user có cart đủ)
2. cart_total_lost == 0   (không lost-update)
3. Total iterations == 100 (10 × 10)
4. http_req_failed == 0%
```

## Cách chạy

> Stack setup chung: xem [RUN_GUIDE.md](RUN_GUIDE.md).

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

cd "E:\Khoa hoc\k6"
k6 run -o cloud .\examples\per-vu-iterations\pvi-06-cart-concurrency.js
```

**Verify trên UI**:

```text
1. Paste token, click run mới nhất → tab Custom metrics
2. cart_total_match: 10 ✓     (mọi user có cart đủ)
3. cart_total_lost: 0 ✓       (không lost-update)
4. http_req_failed: 0% ✓

Output console:
  [VU=N] ✓ cart total match: 30/30
  ... cho cả 10 VU
```

## Kết luận thực tế: đọc output này thì team backend quyết định gì?

Mục tiêu nghiệp vụ: phát hiện **lost-update** — khi cùng 1 user gửi nhiều
request thêm giỏ hàng SONG SONG (mở nhiều tab, bấm nhanh), server có ghi
đủ mọi item hay bị mất do race condition. Mỗi user thêm 30 item; nếu cart
cuối < 30 thì có item bị "nuốt".

Nhắc lại kỳ vọng: 10 user đều cart đủ 30, 0 lost-update, tổng 100 iter.

### Kịch bản A — cart đủ: GHI CART AN TOÀN

```text
cart_total_match...: 10
cart_total_lost....: 0
http_req_failed....: 0.00%
iterations.........: 100
```

Kết luận thực tế:

```text
- 10/10 user có cart đúng 30 item dù 3 request/burst gửi song song
- 0 lost-update -> server xử lý concurrent add an toàn (atomic/khóa đúng)
=> QUYẾT ĐỊNH: cart service chịu được concurrent write per-user, an toàn.
   User mở nhiều tab thêm hàng không bị mất item.
```

### Kịch bản B — cart_total_lost > 0: LOST-UPDATE (bug race)

```text
cart_total_match...: 6
cart_total_lost....: 4         (> 0!)
http_req_failed....: 0.00%

console: [VU=3] ✗ cart total: 27/30  (mất 3 item)
```

Kết luận thực tế:

```text
- 4 user có cart THIẾU item dù mọi request đều trả 200 (0 fail)
- vd user-3 add 30 nhưng cart chỉ 27 -> 3 lần ghi bị đè mất
- nguyên nhân điển hình: read-modify-write không atomic
  (2 request cùng đọc cart=[x], cùng ghi đè -> 1 lần ghi mất)
=> QUYẾT ĐỊNH: chặn release. Báo dev sửa concurrency:
   dùng atomic increment / row lock / optimistic version trên cart.
   Đây là bug ẩn nhất — status 200 hết, chỉ lộ qua so item count.
```

### Kịch bản C — pass nhưng iter_time thấp bất thường: BATCH KHÔNG THẬT SỰ SONG SONG

```text
cart_total_match...: 10
cart_total_lost....: 0
iteration_duration: avg=15ms      (quá nhanh cho 3 request mạng!)
```

Kết luận thực tế:

```text
- "Pass" nhưng iter quá nhanh -> nghi 3 request KHÔNG chạy song song thật,
  hoặc server xử lý tuần tự hóa (serialize) hết -> race chưa từng xảy ra
- nếu race không xảy ra trong test thì "0 lost-update" KHÔNG chứng minh
  được gì -> false confidence
=> QUYẾT ĐỊNH: chưa tin kết quả. Kiểm tra http.batch có thật sự gửi song
   song (xem timing từng request), hoặc tăng burst_size để ép race.
   Pass mà không tạo được điều kiện race là "false pass".
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| match=10, lost=0, batch song song thật | ghi cart an toàn | release |
| cart_total_lost > 0 | lost-update (race bug) | chặn, sửa atomic write |
| match=10 nhưng iter quá nhanh | race chưa xảy ra | ép song song, chạy lại |
| http_req_failed > 0 | server lỗi khi concurrent | điều tra lỗi server |
| tổng ≠ 100 | test chưa chạy đủ | sửa count, chạy lại |

Điểm cốt lõi: lost-update **chỉ xảy ra khi nhiều request CÙNG USER chạy
song song**. Phải có cả hai: identity bound vào VU (per-vu đảm bảo) +
http.batch (song song trong iter). status 200 không phát hiện được — chỉ
so `cart.total` với số đã add mới thấy. Đây là bug stateful điển hình mục
"Nguyên nhân 3" ở case 01 nói tới.

## Mở rộng

```js
// Mỗi đợt tăng số tab mở
const burst_size = Math.min(__ITER + 1, 10);
// Iter 0: 1 tab, iter 9: 10 tab
```

### B: Verify ordering (last-write-wins)

```js
// Server có support last-write-wins không?
// Test 2 update cùng key, request gửi sau phải win
```

### C: Stress test transaction isolation

```js
// 100 users × 50 burst × 5 concurrent = 25000 cart_add
// Verify: không có user nào lost item
```

## Anti-pattern

```text
❌ shared-iterations 100 chia 10 VU:
   VU 1 có thể nhận 50 iter, VU 2 nhận 0 -> không tạo race per user

❌ constant-vus với 30s duration:
   Không kiểm soát được "1 user 30 items"
   1 user có thể chỉ add 5 items, user khác add 100

❌ Không dùng http.batch():
   Gửi request tuần tự -> không có race
   Phải PARALLEL request cùng user mới reproduce bug
```

## Reference

- Doc tham số: `docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md`
- http.batch(): https://k6.io/docs/javascript-api/k6-http/batch/
