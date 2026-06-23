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

**── Phân tích chi tiết: sai như thế nào khi dùng sai executor ──**

#### Dùng constant-vus: 10 VU nhưng không ai là "cùng user"

Khi chạy `constant-vus` với `vus: 10, duration: "30s"`, k6 tạo pool 10 VU.
Mỗi VU sau mỗi iter sẽ nhận user-id MỚI — không có ràng buộc VU-user cố định.

**Timeline thực tế của VU#1 trong pool 10 VU:**

```text
t=0.0s:  VU#1 nhận iter, chọn user_3  -> http.batch(3 request) -> cart user_3
         [3 request SONG SONG, nhưng CHỈ 1 lần duy nhất cho user_3]
t=0.3s:  VU#1 nhận iter mới, chọn user_7  -> http.batch(3 request) -> cart user_7
t=0.6s:  VU#1 nhận iter mới, chọn user_1  -> http.batch(3 request) -> cart user_1
t=0.9s:  VU#1 nhận iter mới, chọn user_5  -> http.batch(3 request) -> cart user_5
t=1.2s:  VU#1 nhận iter mới, chọn user_9  -> http.batch(3 request) -> cart user_9
...
t=30s:   VU#1 đã chạy ~100 iter, MỖI LẦN LÀ MỘT USER KHÁC
         -> user_3 chỉ bị VU#1 gọi ĐÚNG 1 LẦN (3 request song song)
         -> user_3 không bao giờ nhận 10 burst × 3 request từ CÙNG 1 VU
```

Trong khi đó, các VU#2..VU#10 cũng đang làm y hệt — mỗi VU nhảy lung tung qua các user.

**Công thức:**

```text
số_lần_ghi_song_song_mỗi_user ≈ tổng_iter / số_user
                              = 300 / 10 = 30 lần ghi/user

Nhưng 30 lần ghi này TRẢI ĐỀU trong 30s, KHÔNG đồng thời.
Mỗi burst chỉ có 3 request song song (trong cùng 1 iter).
=> Mỗi user chỉ nhận 1-3 burst từ 1 VU bất kỳ, không phải 10 burst như thiết kế.

Race condition cần 10 đợt × 3 request SONG SONG cùng user.
constant-vus tạo 10 đợt × 3 request nhưng KHÁC user -> race KHÔNG XẢY RA.
```

**Demo output:**

```text
CORRECT (per-vu-iterations, vus=10, iterations=10):
  [VU=0] ✓ cart total match: 30/30  (user_0: 10 burst × 3 = 30)
  [VU=5] ✓ cart total match: 30/30  (user_5: 10 burst × 3 = 30)
  ...
  cart_total_match: 10/10 ✓
  cart_total_lost:  0      ✓
  -> Mỗi user đều nhận ĐỦ 10 burst. Race đã THỰC SỰ xảy ra.
  -> Nếu có bug: cart_total_lost > 0 -> PHÁT HIỆN ĐƯỢC.

WRONG (constant-vus, vus=10, duration=30s):
  [console] user_0: 12 items  (chỉ 4 iter rơi vào user này)
  [console] user_3: 45 items  (15 iter rơi vào, nhưng trải đều 30s)
  [console] user_7: 6 items   (2 iter rơi vào)
  ...
  cart_total_match: 10/10 ✓   <- FALSE PASS!
  cart_total_lost:  0      ✓   <- FALSE PASS!
  -> Không user nào nhận 10 burst × 3 request SONG SONG.
  -> Race condition CHƯA TỪNG XẢY RA.
  -> Test "pass" nhưng KHÔNG CHỨNG MINH ĐƯỢC GÌ.
  -> Nếu cart service THỰC SỰ có bug race -> test này BỎ QUA.
```

#### Dùng shared-iterations: iter phân phối lệch

`shared-iterations` chia 100 iter cho 10 VU, nhưng KHÔNG ĐỀU. VU nhanh nhận nhiều,
VU chậm nhận ít. Mỗi VU lại là user khác -> phân phối iter theo user càng lệch.

**Timeline thực tế:**

```text
VU#1 (nhanh, latency thấp):  50 iter -> 50 burst cho 1 user duy nhất
VU#2:                        15 iter -> 15 burst
VU#3..VU#7:                  mỗi VU 3-8 iter
VU#8 (chậm, latency cao):    5 iter  -> 5 burst
VU#9:                        2 iter
VU#10:                       0 iter  -> user này KHÔNG ĐƯỢC TEST!

Tổng: 50+15+... = 100 iter ✓ (đủ về số lượng)

Nhưng:
  - user của VU#1 bị "hammer" 50 burst -> nếu có race, user này dễ trigger nhất
  - user của VU#10 không hề được gọi -> hoàn toàn BỎ SÓT
  - Các user khác chỉ 3-8 burst -> KHÔNG ĐỦ 10 burst như thiết kế

=> Kết quả TEST KHÔNG ĐẠI DIỆN. Không thể kết luận "10 user đều an toàn"
   khi có user không được test, có user bị test quá nhiều.
```

**Vấn đề gốc:** vẫn là "mỗi VU là user khác". Ngay cả VU#1 nhận 50 burst cho
cùng 1 user, 50 burst đó CHẠY TUẦN TỰ (VU#1 chỉ có 1 luồng, hết iter này
mới tới iter sau). 3 request/http.batch thì song song, nhưng 50 burst thì
nối tiếp nhau -> đây là CONCURRENT WITHIN ITER, không phải CONCURRENT
ACROSS ITERS.

```text
shared-iterations:
  ✓ Có thể tạo race trong 1 iter (3 request song song)
  ✗ Không tạo 10 ĐỢT race độc lập như thiết kế
  ✗ Phân phối lệch -> 1 số user không được test
  ✗ Không user nào nhận ĐÚNG 10 burst như per-vu đảm bảo
```

#### Dùng arrival-rate: không kiểm soát được user nào bị race

`constant-arrival-rate` chỉ quan tâm tốc độ (iter/s), không quan tâm identity.
Iter đến với VU nào rảnh -> user-id tùy ý -> không đảm bảo mỗi user 10 burst.

**Bảng so sánh output với 4 executor:**

| Executor | Mỗi user 10 burst? | Cùng user trong 1 burst? | Race xảy ra? | Phát hiện được lost-update? |
| --- | --- | --- | --- | --- |
| **per-vu-iterations** | ✓ ĐÚNG 10 burst/user | ✓ http.batch cùng user | ✓ THỰC SỰ | ✓ Phát hiện nếu có bug |
| constant-vus | ✗ Ngẫu nhiên 1-15 burst | ✓ Trong 1 iter | △ Ít, không đủ burst | ✗ FALSE PASS |
| shared-iterations | ✗ Lệch 0-50 burst | ✓ Trong 1 iter | △ 1 user bị hammer, user khác bỏ sót | ✗ Test không đại diện |
| constant-arrival-rate | ✗ Không kiểm soát | ✓ Trong 1 iter | △ Ngẫu nhiên | ✗ Không kiểm soát được |

> **Tóm lại:** 3 executor kia đều có thể tạo race TRONG 1 ITER (vì vẫn dùng
> `http.batch()`), nhưng KHÔNG đảm bảo "10 ĐỢT race độc lập, mỗi đợt 3 request
> song song, cho TỪNG user". Chỉ per-vu-iterations mới đảm bảo điều kiện đó.
> Đây là lý do "cart race test" BUỘC PHẢI chọn per-vu-iterations.

### Yeu cau (b): DU BURST DE TRIGGER LOST UPDATE

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


## Đọc dashboard real-time charts cho case 06

Run thật đã verify bằng wrapper với script hiện tại:

```powershell
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:K6_CLOUD_HOST = "http://localhost:18080"
.\run-with-summary.ps1 .\examples\per-vu-iterations\pvi-06-cart-concurrency.js
```

Run đã verify:

```text
run #27
percentile_source = k6_summary

VUS = 10
ITERS_PER_VU = 10
ITEMS_PER_BURST = 3
total_iterations = 10 × 10 = 100
```

Summary quan trọng:

```text
iterations.............: 100
http_reqs..............: 310
cart_total_match.......: 10
cart_total_lost........: 0
checks_succeeded.......: 100.00%  110 out of 110
checks_failed..........: 0.00%    0 out of 110
http_req_failed........: 0.00%

http_req_duration avg..: 50.21ms
http_req_duration p95..: 99.48ms
http_req_duration p99..: 100.99ms
http_req_duration max..: 103.85ms
```

Request breakdown:

| Endpoint | Count | Vì sao có số này? |
| --- | ---: | --- |
| `cart_add` | 300 | 100 iterations × 3 parallel add requests |
| `cart_summary` | 10 | 1 summary check cuối mỗi VU |
| Tổng | 310 | đúng bằng `summary http_reqs` |

Đọc nhanh:

```text
- Workload đủ: 100/100 iterations
- Cart add đủ: 300 add requests
- 10/10 user có cart đúng tổng mong đợi
- lost-update = 0
- HTTP/checks sạch
=> Run PASS: cart service chịu được concurrent add per user trong workload này.
```

Điểm học quan trọng:

```text
Response 200 hết vẫn chưa đủ để chứng minh không lost-update.
```

Case này phải đọc custom counters:

```text
cart_total_match = 10
cart_total_lost = 0
```

vì lost-update thường là bug stateful: request trả 200 nhưng dữ liệu cuối bị
mất item.

### 1. Overview có 3 chart cần đọc

| Chart | Câu hỏi trong cart concurrency test | Không dùng để kết luận gì? |
| --- | --- | --- |
| Response time | batch add/summary có latency ổn định không? | không tự chứng minh không mất item |
| Execution timeline | 3 request/burst tạo tải HTTP ra sao? | không tự chứng minh server ghi đủ cart |
| VUs vs iter/s | 100 burst iterations đã chạy đủ chưa? | không tự chứng minh cart total đúng |

Một cách đọc nhanh:

```text
Response time      -> concurrent add có làm request chậm không
Execution timeline -> cart_add/cart_summary dồn vào bucket nào
VUs vs iter/s      -> có đủ 100 burst không
Custom metrics     -> 10 user có cart đủ, 0 lost-update không
```

### Chart 1 — Response time

Chart debug:

```text
Debug JSON: response-time
```

Run #27:

| Metric | Giá trị | Cách đọc |
| --- | ---: | --- |
| buckets | 3 | run ngắn, 3 bucket response-time |
| total samples | 310 | đúng bằng `summary http_reqs` |
| weighted avg | 50.21ms | latency trung bình của add/summary |
| summary p95 | 99.48ms | 95% request dưới ~100ms |
| summary p99 | 100.99ms | tail vẫn quanh 101ms |
| summary max | 103.85ms | request chậm nhất vẫn thấp |
| bucket p95 peak | 103.68ms | bucket tệ nhất vẫn quanh 104ms |
| bucket max peak | 103.85ms | max chart khớp summary max |

Đọc thực tế:

```text
- latency ổn định, không có spike lớn
- concurrent writes không tạo tail latency cao
- nhưng correctness vẫn phải đọc cart_total_match/lost
```

#### Cách phân tích sâu chart Response time

Với cart concurrency, response-time chart trả lời:

```text
khi cùng user gửi nhiều cart_add song song, server có bị chậm/queue không?
```

Nó không trả lời:

```text
server có ghi đủ mọi item không?
```

Các shape cần chú ý:

| Shape | Nghĩa có thể có |
| --- | --- |
| p95/max tăng mạnh ở bucket giữa | concurrent write làm DB/cart lock nghẽn |
| latency đẹp nhưng `cart_total_lost > 0` | server nhanh nhưng ghi sai/mất update |
| `http_req_failed > 0` | concurrent write làm API lỗi trực tiếp |
| iter_time quá thấp bất thường | nghi batch chưa thật sự tạo race |

Run #27 tốt vì cả 2 điều cùng đúng:

```text
latency ổn định
cart_total_lost = 0
```

### Chart 2 — Execution timeline

Chart debug:

```text
Debug JSON: execution-timeline
```

Run #27:

| Bucket | VUs | HTTP reqs | Iterations | Ý nghĩa |
| --- | ---: | ---: | ---: | --- |
| 1 | 10 | 76 | 20 | bắt đầu các burst add đầu tiên |
| 2 | 10 | 204 | 69 | bucket bận nhất, nhiều `http.batch()` overlap |
| 3 | 10 | 30 | 11 | tail: summary/final bursts hoàn thành |

Kiểm tổng:

```text
sum(httpReqs) = 76 + 204 + 30 = 310 = summary http_reqs ✓
sum(iterations) = 20 + 69 + 11 = 100 = summary iterations ✓
```

Đọc thực tế:

```text
- HTTP reqs cao hơn iterations vì mỗi iteration gửi 3 cart_add song song
- bucket giữa peak 204 req/s là nơi race dễ xảy ra nhất
- tail 30 req gồm phần add/summary cuối run
```

Vì sao `http_reqs = 310`?

```text
100 iterations × 3 cart_add = 300
10 VUs × 1 cart_summary cuối = 10
300 + 10 = 310
```

### Batch 1 giây / time bucket đọc như nào?

Trong case 06:

```text
iterations trong bucket = số burst hoàn thành
http_reqs trong bucket  = 3× cart_add của các burst + cart_summary nếu có
```

Do đó `http_reqs` phải lớn hơn `iterations`. Đọc đúng là cộng tổng bucket,
không so từng point 1:1.

### Chart 3 — VUs vs iter/s

Chart debug:

```text
Debug JSON: vus-vs-iterations
```

Run #27:

| Bucket | Observed VUs | Actual iter/s | HTTP reqs | Ý nghĩa |
| --- | ---: | ---: | ---: | --- |
| 1 | 10 | 20 | 76 | các burst đầu bắt đầu |
| 2 | 10 | 69 | 204 | peak burst throughput |
| 3 | 10 | 11 | 30 | tail hoàn thành nốt 100 iterations |

Kiểm tổng:

```text
sum(Actual iter/s) = 20 + 69 + 11 = 100 = summary iterations ✓
sum(httpReqs) = 76 + 204 + 30 = 310 = summary http_reqs ✓
```

Chart này chứng minh:

```text
đã chạy đủ 100 burst iterations với 10 VUs.
```

Chart này KHÔNG chứng minh:

```text
server không lost-update.
```

Câu đó phải đọc ở:

```text
cart_total_match = 10
cart_total_lost = 0
```

### 2. Tab Executor / Execution

Case 06 cần 10 VUs vì mỗi VU đại diện cho 1 user/cart riêng:

```text
VU 1 -> user/cart 1
VU 2 -> user/cart 2
...
VU 10 -> user/cart 10
```

Tab Executor dùng để kiểm:

```text
- 10 VUs được active
- mỗi VU hoàn thành 10 burst iterations
- total iterations = 100
- không dropped/interrupted
```

Nếu dùng shared-iterations, phân phối iteration theo user sẽ không còn chắc
chắn. Đây là lý do case này cần `per-vu-iterations`.

### 3. `metrics_push_count` khác `pointCount` — không phải bug

Với run ngắn, dashboard chỉ có vài bucket. Không cần số bucket bằng số metrics
push. Kiểm đúng:

```text
76 + 204 + 30 = 310
20 + 69 + 11 = 100
```

### 4. Endpoint debug series theo metric

```text
GET http://localhost:13001/v1/tests/27/series?metric=http_reqs
GET http://localhost:13001/v1/tests/27/series?metric=iterations
GET http://localhost:13001/v1/tests/27/series?metric=http_req_duration
GET http://localhost:13001/v1/tests/27/series?metric=cart_total_match
GET http://localhost:13001/v1/tests/27/series?metric=cart_total_lost
```

Nếu custom series thiếu, dùng tab Custom metrics và console output cuối run.

### 5. Checklist đọc biểu đồ case 06

| Bước | Câu hỏi | Kết quả run #27 |
| --- | --- | --- |
| 1 | `iterations == 100`? | 100 ✓ |
| 2 | `cart_add == 300`? | 300 ✓ |
| 3 | `cart_summary == 10`? | 10 ✓ |
| 4 | `http_reqs == 310`? | 310 ✓ |
| 5 | `cart_total_match == 10`? | 10 ✓ |
| 6 | `cart_total_lost == 0`? | 0 ✓ |
| 7 | `checks_fails == 0`? | 0 ✓ |
| 8 | chart `httpReqs` sum = 310? | 76+204+30=310 ✓ |
| 9 | chart `iterations` sum = 100? | 20+69+11=100 ✓ |
| 10 | batch có tạo concurrency không? | peak 204 req/s, http.batch tạo burst |

### Cách chốt từ summary -> 3 chart

| Bước | Nhìn ở đâu | Kết luận run #27 |
| --- | --- | --- |
| Workload | summary + VUs vs iter/s | đủ 100 burst iterations |
| Request mix | breakdown | 300 cart_add + 10 cart_summary |
| Race correctness | custom metrics | 10 match, 0 lost-update |
| HTTP health | summary + Response time | 0 fail, p95 quanh 100ms |
| Execution shape | timeline / Executor | 10 VU ổn định, bucket giữa tạo concurrency cao |
| Final verdict | tổng hợp | PASS: cart concurrent add an toàn trong workload này |

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
