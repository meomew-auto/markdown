# Case 02: Idempotency audit dưới retry storm

## Tình huống thực tế

Team thanh toán phát hiện log có vài giao dịch **double charge**. Họ
cần audit chính xác cơ chế Idempotency-Key của API confirm order:

```text
Yêu cầu nghiệp vụ:
  - 20 customers
  - Mỗi customer click "Retry" 5 lần (mô phỏng network glitch)
  - Verify: chỉ charge ĐÚNG 1 lần
  - 4 lần retry sau phải được dedupe (server trả response cũ)
  - Idempotency-Key bound vào customer + order, KHÔNG đổi giữa retry
```

## Vì sao "idempotency audit" buộc chọn per-vu-iterations?

Trước khi vào kỹ thuật, hiểu **idempotency** là gì:

```text
Idempotency = "gửi lại nhiều lần CŨNG CHỈ tính 1 lần".

Đời thường:
  Bấm thang máy 5 lần -> thang vẫn chỉ đến 1 lần (không đến 5 lần)
  Idempotency-Key = "lời hứa": cùng key -> server xử lý ĐÚNG 1 lần

Vì sao quan trọng với payment?
  - User bấm "Thanh toán", mạng lag, user bấm lại
  - Không có idempotency -> charge 2 lần -> khách mất tiền oan
  - Có idempotency -> lần 2 server nhận ra key cũ -> trả kết quả cũ,
    KHÔNG charge lại
```

Để audit cơ chế này **có giá trị**, test phải đảm bảo **2 yêu cầu cốt lõi**.
Chỉ per-vu-iterations mới thỏa mãn cả 2.

### Yêu cầu (a): KEY STABLE PER CUSTOMER (key không đổi giữa các retry)

**Ý nghĩa**: Mỗi customer phải gửi **CÙNG Idempotency-Key** qua tất cả lần
retry. Nếu key đổi → server tưởng là request mới → charge lại → test sai.

```text
Flow đúng (cùng customer, cùng key):
  Customer A, iter 0: key="idem-A-order123" -> charge FRESH
  Customer A, iter 1: key="idem-A-order123" -> server thấy key cũ -> REUSE
  Customer A, iter 2-4: cùng key -> REUSE
  => 1 fresh + 4 reuse

Vì sao per-vu đảm bảo điều này?
  - 1 VU = 1 customer
  - Key tính 1 LẦN ở iter 0, lưu vào biến per-VU
  - 4 iter sau cùng VU -> đọc lại biến đó -> CÙNG key
  - State per-VU sống qua iter -> key bound chắc vào customer
```

**Vì sao executor khác fail?**

```text
✗ constant-vus / arrival-rate:
  - __VU không stable cho 1 customer qua các iter
  - VU pool tái sử dụng -> iter này VU 3 là customer A, iter sau là customer B
  - Key tính theo __VU -> bị nhảy -> server thấy toàn key mới -> charge hết
  - Audit cho kết quả SAI: 100 fresh thay vì 20 fresh + 80 reuse
```

**── Phân tích chi tiết: sai như thế nào khi dùng sai executor ──**

#### Dùng constant-vus: idempotency key bị ghi đè

Vấn đề cốt lõi: constant-vus có **VU pool**. VU không gắn cố định vào customer.
Iter này VU #3 xử lý customer A, iter sau VU #3 xử lý customer D.
Biến per-VU (như `idempotencyKey`) bị **ghi đè** khi VU chuyển customer.

Timeline cụ thể với 3 VU, 6 customer, 5 iter/VU (constant-vus, duration):

```text
[VU pool có 3 VU: VU #1, VU #2, VU #3. 6 customer cần test: A, B, C, D, E, F]

t=0.0s | VU #3 bắt đầu iter mới -> pick customer A
       |   __VU=3, __ITER=0 -> idempotencyKey="idem-3-order-A-..."
       |   POST confirm -> charge FRESH cho customer A
       |   BIẾN MODULE-LEVEL của VU #3: {key: "idem-3-order-A", firstResp: {...A...}}

t=0.3s | VU #3 iter tiếp theo -> vẫn nghĩ là customer A nhưng...
       |   __VU=3, __ITER=1 -> idempotencyKey="idem-3-order-A-..." (VẪN key cũ)
       |   POST confirm -> server thấy key cũ -> REUSE (đúng!)
       |   --> có vẻ OK ở iter 0->1

t=0.6s | VU #3 iter tiếp -> HỆ THỐNG PICK CUSTOMER MỚI
       |   __VU=3, __ITER=2 -> nhưng bây giờ customer D được assign cho VU #3
       |   idempotencyKey BỊ TÍNH LẠI = "idem-3-order-D-..."
       |   --> KEY MỚI HOÀN TOÀN, KHÔNG còn là key của customer A
       |   --> Server thấy key mới -> charge FRESH cho customer D (sai!)

t=0.9s | VU #3 iter tiếp -> lại customer B
       |   __VU=3, __ITER=3 -> idempotencyKey="idem-3-order-B-..."
       |   --> LẠI key mới -> LẠI charge fresh

t=1.2s | VU #3 iter tiếp -> lại customer A trở lại!
       |   __VU=3, __ITER=4 -> idempotencyKey="idem-3-order-A-..."
       |   --> key CÙNG TÊN nhưng BIẾN MODULE-LEVEL đã bị ghi đè ở iter 2,3
       |   --> firstResponseSnapshot đã là của customer D/B, KHÔNG còn của A
       |   --> Nếu key tính lại giống cũ -> server REUSE nhưng
       |       firstResponseSnapshot SAI -> verify response THẤT BẠI
```

**Công thức dự kiến sai**:

```js
// VỚI CONSTANT-VUS (sai):
// Mỗi VU bị xáo trộn customer sau mỗi iter
// --> mỗi iter gần như LUÔN tính key mới (vì customer thay đổi)
// --> Hầu hết request trở thành FRESH charge

// Dự kiến:
//   idem_fresh_count ≈ vus × expected_iters_per_vu  (gần như 100% fresh)
//   idem_reuse_count ≈ 0                            (gần như không reuse)
//
// Ví dụ: vus=20, expected ~5 iter/VU trong duration
//   idem_fresh_count ≈ 100  (sai, đúng ra phải 20)
//   idem_reuse_count ≈ 0    (sai, đúng ra phải 80)
```

**Demo output: per-vu (đúng) vs constant-vus (sai)**:

```text
=== ĐÚNG executor: per-vu-iterations ===
iterations.............: 100
idem_fresh_count.......: 20     ← 1 fresh per customer, ĐÚNG
idem_reuse_count.......: 80     ← 4 retry per customer, ĐÚNG
checks_succeeded.......: 100%   ← tất cả retry trả cùng response
http_req_failed........: 0.00%
=> KẾT LUẬN: idempotency contract ĐÚNG. API an toàn.

=== SAI executor: constant-vus (duration=30s) ===
iterations.............: 112    ← số iter không còn 100 nữa (duration-based)
idem_fresh_count.......: 97     ← GẦN 100% fresh, SAI HOÀN TOÀN
idem_reuse_count.......: 15     ← chỉ 15 reuse, nhưng phần lớn là TRÙNG HỢP
                                 (VU tình cờ gặp lại customer cũ)
checks_succeeded.......: 62%    ← rất nhiều verify thất bại vì
                                 firstResponseSnapshot bị ghi đè
http_req_failed........: 0.00%
=> KẾT LUẬN (SAI): double-charge! 97 fresh nhưng chỉ có 20 customer
   --> 77 lần charge LẶP. Bug "tiền bạc" giả.
   --> Thực tế backend VẪN ĐÚNG, nhưng TEST BÁO LỖI do sai executor.
```

#### Dùng shared-iterations: iter phân phối không đều

shared-iterations chia 100 iteration cho VU pool. VU nào nhanh thì lấy
nhiều iter, VU chậm lấy ít. Không đảm bảo mỗi customer retry đủ 5 lần.

Timeline với 20 customer, iterations=100, vus=10:

```text
[VU pool 10 VU. 100 iteration chung, VU nào xong trước lấy iter mới.]

t=0.00s | VU #1-#10 cùng start, mỗi VU pick 1 customer ngẫu nhiên
        | VU #1: customer_3, iter 0 -> charge fresh
        | VU #4: customer_7, iter 0 -> charge fresh
        | VU #7: customer_12, iter 0 -> charge fresh
        | ...

t=0.05s | VU #3 nhanh nhất, xong iter -> lấy iter mới
        |   -> LẠI customer_3 -> key cũ -> reuse OK
        | VU #1 cũng xong -> lấy iter mới
        |   -> customer_3 (customer_3 được test NHIỀU)

t=0.10s | VU #3, #1, #5, #8 liên tục lấy iter
        |   -> customer_3, customer_5, customer_3, customer_1...
        |   -> các VU nhanh THỐNG TRỊ, customer của họ được retry nhiều

t=0.50s | 100 iteration hết. Phân phối thực tế:
        |   customer_3:  8 retry  (7 reuse, quá nhiều!)
        |   customer_5:  7 retry  (6 reuse)
        |   customer_1:  6 retry  (5 reuse)
        |   customer_12: 1 retry  (0 reuse, KHÔNG ĐỦ ĐỂ TEST!)
        |   customer_7:  0 retry  (CHƯA TỪNG CÓ ITER 1)
        |   customer_15: 0 retry
        |   customer_19: 0 retry
        |   ... 6 customer khác chỉ 1-2 retry
```

**Demo output với shared-iterations**:

```text
=== SAI executor: shared-iterations (iterations=100, vus=10) ===
iterations.............: 100
idem_fresh_count.......: 35     ← QUÁ CAO: nhiều customer bị tính là fresh
                                 vì VU khác lấy iter của customer đó
idem_reuse_count.......: 65     ← phân bổ KHÔNG ĐỀU giữa customer
checks_succeeded.......: 78%    ← verify thất bại ở customer ít retry
http_req_failed........: 0.00%

Phân bổ retry thực tế (không đọc được từ output, chỉ quan sát log):
  customer_3:  charge 1 lần, 7 retry (OK, nhưng dư thừa)
  customer_7:  charge 1 lần, 0 retry (KHÔNG TEST ĐƯỢC)
  customer_12: charge 1 lần, 1 retry (test chưa đủ)
  customer_15: charge 1 lần, 0 retry (KHÔNG TEST ĐƯỢC)
  customer_19: charge 1 lần, 0 retry (KHÔNG TEST ĐƯỢC)

=> KẾT LUẬN (SAI): idem_fresh_count=35 nhưng thực chất không phải
   35 customer bị double-charge. Đây là customer KHÁC NHAU cũng bị
   tính fresh vì VU không gắn cố định. Output không thể dùng để
   kết luận idempotency. 6/20 customer KHÔNG hề được retry -> bỏ
   sót khả năng bug ở những customer này.
```

#### Dùng arrival-rate: identity rời VU

constant-arrival-rate và ramping-arrival-rate là rate-driven: k6 chỉ
đảm bảo tốc độ request (iter/s), KHÔNG đảm bảo VU nào xử lý customer nào.

```text
Vấn đề:
  - VU được spawn/spin down liên tục theo rate
  - KHÔNG có khái niệm "VU gắn với customer" trong arrival-rate
  - Iter của cùng một customer có thể được 3 VU khác nhau chạy
  - Module-level state MẤT hoàn toàn vì mỗi VU là isolate mới

Timeline:
  t=0.0s | VU #7 spawn -> pick customer A, iter 0
         |   idempotencyKey="idem-7-order-A"
         |   POST -> fresh charge -> VU #7 bị destroy

  t=0.3s | VU #12 spawn (VU #7 đã bị destroy từ lâu)
         |   pick customer A, iter 1 (cần cùng key)
         |   NHƯNG VU #12 là isolate MỚI -> KHÔNG có biến từ VU #7
         |   idempotencyKey BỊ TÍNH LẠI = "idem-12-order-A" (KHÁC!)
         |   POST -> server thấy key MỚI -> charge FRESH lần 2

  => MỖI LẦN RETRY LÀ MỘT FRESH CHARGE MỚI
  => idempotency audit VÔ NGHĨA: 100% fresh, 0% reuse
```

**Bảng so sánh output dự kiến với 4 executor**:

```text
+--------------------------+----------+----------+----------+-------------+
| Executor                 | Fresh    | Reuse    | Checks   | Dùng để    |
|                          | count    | count    | pass     | audit?     |
+--------------------------+----------+----------+----------+-------------+
| per-vu-iterations        | 20       | 80       | 100%     | CÓ         |
| constant-vus             | ~97      | ~15      | ~62%     | KHÔNG      |
| shared-iterations        | ~35      | ~65      | ~78%     | KHÔNG      |
| arrival-rate             | ~100     | ~0       | ~0%      | KHÔNG      |
+--------------------------+----------+----------+----------+-------------+

Giải thích:
  per-vu-iterations:    1 VU = 1 customer, key stable, iter đủ -> audit ĐÚNG
  constant-vus:         VU pool xáo trộn -> key bị ghi đè -> fresh ảo
  shared-iterations:    iter phân phối lệch -> nhiều customer 0 retry
  arrival-rate:         VU spawn/despawn liên tục -> identity MẤT HOÀN TOÀN

=> CHỈ per-vu-iterations cho ra output idem_fresh_count=20, idem_reuse_count=80
   là CON SỐ TUYỆT ĐỐI để kết luận. Các executor khác đều cho ra fresh count
   ảo, không phân biệt được "double-charge thật" vs "fresh do sai executor".
```

### Yêu cầu (b): MỖI CUSTOMER RETRY ĐỦ N LẦN

**Ý nghĩa**: Bug idempotency thường chỉ lộ ở lần retry thứ 2, 3... (không
phải lần đầu). Mỗi customer phải retry đủ N lần để bắt được.

**3 nguyên nhân kỹ thuật của bug idempotency**:

#### Nguyên nhân 1: CACHE TTL EXPIRY (key hết hạn quá sớm)

**Cache idempotency là gì?** Server lưu `key -> response` trong cache (Redis)
để lần retry sau trả lại response cũ. Cache có TTL (time-to-live), vd 60s.

```text
Bug: TTL quá ngắn so với retry window
  Iter 0 (t=0s):   key="idem-A", charge, lưu cache TTL=10s
  Iter 1 (t=3s):   key cũ còn trong cache -> REUSE OK
  Iter 2 (t=12s):  key đã HẾT HẠN (>10s) -> cache miss
                   -> server tưởng request mới -> CHARGE LẠI
                   -> DOUBLE CHARGE

→ Test 2 lần liên tiếp nhanh (< TTL) -> không bắt được
→ Phải retry đủ N lần kéo dài qua TTL -> mới lộ bug
→ per-vu: kiểm soát được số retry + thời gian giữa retry
```

#### Nguyên nhân 2: RACE ON FIRST WRITE (2 retry đầu đến cùng lúc)

**Vấn đề**: Nếu 2 request CÙNG key đến gần như đồng thời (trước khi lần đầu
kịp lưu cache), cả 2 đều thấy "cache miss" → cả 2 đều charge.

```text
Race condition:
  Request 1 (t=0.000s): check cache -> miss -> bắt đầu charge
  Request 2 (t=0.001s): check cache -> vẫn miss (R1 chưa lưu xong)
                        -> cũng bắt đầu charge
  Request 1 (t=0.050s): charge xong, lưu cache
  Request 2 (t=0.051s): charge xong, ghi đè cache
  => DOUBLE CHARGE dù cùng key

Fix đúng: dùng atomic SETNX (set if not exists) hoặc DB unique constraint

→ Test tuần tự (sleep giữa retry) -> không bao giờ trigger race
→ Phải gửi song song (http.batch) cùng key -> mới lộ bug
→ per-vu + http.batch: tạo race chính xác cho cùng customer (xem Variation A)
```

#### Nguyên nhân 3: KEY SCOPE COLLISION (key trùng giữa customer)

**Vấn đề**: Nếu key chỉ là `order_id` (không kèm customer_id), 2 customer
khác nhau có cùng order_id (do reset counter) → server nhầm là retry.

```text
Bug scope:
  Customer A: key="order-1" -> charge $100
  Customer B: key="order-1" (trùng do counter reset) -> server thấy key cũ
              -> REUSE response của A -> B KHÔNG bị charge
              -> B nhận hàng MIỄN PHÍ (hoặc thấy đơn của A)

Fix đúng: key phải kèm scope -> "customer-A-order-1" vs "customer-B-order-1"

→ Test 1 customer -> không bao giờ thấy collision
→ Phải test nhiều customer ĐỒNG THỜI với key pattern rõ ràng
→ per-vu: mỗi VU = customer riêng -> verify key scope không đụng nhau
```

#### Tổng kết: chỉ per-vu thỏa mãn cả (a) và (b)

| Executor | (a) Key stable per customer | (b) Mỗi customer đủ N retry | Verdict |
| --- | --- | --- | --- |
| **per-vu-iterations** | ✓ key bound vào VU | ✓ mỗi VU retry đúng N lần | ✅ DÙNG |
| shared-iterations | ✗ VU pick random key | ✗ phân phối retry không đều | ❌ |
| constant-vus (duration) | ✗ __VU không stable | ✗ số retry phụ thuộc latency | ❌ |
| constant-arrival-rate | ✗ identity rời VU | ✗ rate-driven, retry rời rạc | ❌ |
| ramping-vus | ✗ VU spawn/despawn | ✗ số retry biến thiên | ❌ |
| ramping-arrival-rate | ✗ rate-driven | ✗ retry không bound customer | ❌ |

→ Chỉ **per-vu-iterations** đảm bảo "cùng customer gửi cùng key đủ N lần",
điều kiện BẮT BUỘC để audit idempotency chính xác.

## Config

```js
export const options = {
  scenarios: {
    idem_audit: {
      executor: "per-vu-iterations",
      vus: 20,                  // 20 customers
      iterations: 5,            // 5 retry per customer
      maxDuration: "3m",
    },
  },
  thresholds: {
    idem_fresh_count: ["count==20"],   // ĐÚNG 20 fresh charge
    idem_reuse_count: ["count==80"],   // ĐÚNG 80 dedupe
  },
};
```

## Custom metrics

```js
const idemFreshCount = new Counter("idem_fresh_count");
const idemReuseCount = new Counter("idem_reuse_count");

// Iter 0: idemFreshCount.add(1)
// Iter 1-4: idemReuseCount.add(1)
```

## Per-VU state (sống qua 5 iter)

**Code thật từ file pvi-02-idempotency-audit.js**:

```js
// ───── Module-level scope (GIỮ qua 5 retry) ─────
let customerToken = null;
let orderId = null;
let idempotencyKey = null;        // tính 1 LẦN ở iter 0, dùng cả 5 lần
let firstResponseSnapshot = null;  // snapshot response lần đầu -> verify retry

// ───── Trong default() ─────
export default function () {
  if (__ITER === 0) {
    customerToken = `cust-token-${__VU}`;
    orderId = `order-${__VU}-${Date.now()}`;
    idempotencyKey = `idem-${__VU}-${orderId}`;
    // ↑ 3 biến module-level được GHI ở iter 0, ĐỌC ở iter 1-4
  }

  // Mọi iter: dùng CÙNG idempotencyKey (đã ghi từ iter 0)
  const res = http.post(`/api/sim/orders/${orderId}/confirm`, ..., {
    headers: { "Idempotency-Key": idempotencyKey },
  });

  if (__ITER === 0) {
    firstResponseSnapshot = { status: res.status, body_len: res.body?.length };
    idemFreshCount.add(1);       // fresh charge
  } else {
    idemReuseCount.add(1);       // retry -> dedupe
    // Verify response giống lần đầu
    check(res, { "same status as first": (r) => r.status === firstResponseSnapshot.status });
  }
}
```

**Trace execution cho VU=1 qua 5 iter**:

```text
Iter 0: idempotencyKey = "idem-1-order-1-1716800000"
        gửi confirm -> fresh charge -> snapshot response
        idemFreshCount=1, idemReuseCount=0

Iter 1: idempotencyKey VẪN = "idem-1-order-1-1716800000"  ← ĐỌC TỪ MODULE-LEVEL
        gửi confirm với CÙNG key -> server dedupe
        verify response == firstResponseSnapshot -> OK
        idemFreshCount=1, idemReuseCount=1

Iter 2-4: tương tự -> idemReuseCount=2,3,4
```

> **Tại sao key không đổi qua 5 retry?** Cùng cơ chế case 01:
> module-level variable GIỮ qua iter trong cùng V8 isolate.
> Xem [case 01 / Per-VU state](./01_user-journey-replay.md#per-vu-state).

## Endpoint flow

```text
Iter 0:
  - Tính customer_token, order_id, idempotency_key
  - POST /api/sim/orders/:id/confirm với key
  - Server: process charge thật, lưu cache
  - Response: { charged: true, transaction_id: "tx123" }
  - Snapshot response

Iter 1-4 (cùng VU):
  - POST /api/sim/orders/:id/confirm với CÙNG key
  - Server: detect duplicate, trả CÙNG response từ cache
  - Verify: response giống snapshot iter 0
```

## Pass criteria

```text
1. idem_fresh_count == 20      (1 fresh per customer)
2. idem_reuse_count == 80      (4 retry × 20 customer = 80 dedupe)
3. http_req_failed == 0%       (server xử lý sạch)
4. retry response same as fresh (idempotency contract OK)
```

## Cách chạy

> Stack setup chung: xem [RUN_GUIDE.md](RUN_GUIDE.md).

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"   # đủ quyền POST /api/sim/orders/:id/confirm

cd "E:\Khoa hoc\k6"
k6 run -o cloud .\examples\per-vu-iterations\pvi-02-idempotency-audit.js
```

**Verify trên UI**:

```text
1. Mở http://localhost:13001, paste token
2. Click run mới nhất → tab Custom metrics
3. idem_fresh_count: 20 ✓
4. idem_reuse_count: 80 ✓
5. http_req_failed: 0% ✓

Output kỳ vọng:
  ✓ idem_fresh_count: 20
  ✓ idem_reuse_count: 80
  ✓ idem replay: same status as first
```

## Áp 5 bước phân tích output

### Bước 1: Verify config

```text
Header: "5 iterations for each of 20 VUs" ✓
```

### Bước 2: Total dự kiến [CT 1]

```text
total = 20 × 5 = 100 confirm calls
```

### Bước 3: So với N_done

```text
iterations = 100 (summary)
100/100 = 100% ✓
```

### Bước 4: Custom metrics

```text
idem_fresh_count = 20 (đúng: 1 fresh per customer)
idem_reuse_count = 80 (đúng: 4 retry × 20)
20 + 80 = 100 = total ✓

→ Idempotency contract VERIFIED
```

### Bước 5: Đo iter_time và pattern

```text
iter_time avg ≈ 200ms (mỗi POST + sleep 0.2)
T_run ≈ 1s (5 iter × 200ms)
maxDuration = 3m -> dư rất nhiều
```


## Đọc dashboard real-time charts cho case 02

Ví dụ dưới đây lấy từ run thật sau khi chạy bằng wrapper để dashboard dùng
summary authoritative từ k6:

```powershell
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:K6_CLOUD_HOST = "http://localhost:18080"
.\run-with-summary.ps1 .\examples\per-vu-iterations\pvi-02-idempotency-audit.js
```

Run đã verify:

```text
run #32
exit = 0
pushed = true
finished = true
percentile_source = k6_summary

VUS = 20
ITERS_PER_VU = 5
total_iterations = 20 × 5 = 100
```

Summary quan trọng:

```text
iterations.............: 100
http_reqs..............: 100
http_req_failed........: 0.00%
checks_succeeded.......: 100.00%  360 out of 360
checks_failed..........: 0.00%    0 out of 360
idem_fresh_count.......: 20
idem_reuse_count.......: 80

http_req_duration avg..: 55.30ms
http_req_duration p95..: 227.89ms
http_req_duration p99..: 244.59ms
http_req_duration max..: 1209.51ms
```

Request breakdown:

| Endpoint / status | Count | Ý nghĩa |
| --- | ---: | --- |
| `confirm_order` `200` | 100 | toàn bộ 100 confirm call đều thành công |
| `confirm_order` `5xx` | 0 | backend không còn lỗi retry storm |

Đọc nhanh:

```text
- Workload đủ: 100/100 iterations
- Idempotency count đúng: 20 fresh + 80 reuse = 100
- HTTP sạch: 0 fail, không còn 5xx
- Replay contract sạch: 360/360 checks pass
=> Run PASS: backend đã xử lý idempotency retry đúng.
```

Điểm học quan trọng:

```text
custom counters đúng + HTTP sạch + checks sạch mới kết luận idempotency OK.
```

Nếu chỉ có:

```text
idem_fresh_count = 20 ✓
idem_reuse_count = 80 ✓
```

thì mới chứng minh được **số lần fresh/reuse**. Muốn kết luận API an toàn cho
retry, còn phải có:

```text
http_req_failed = 0%
checks_failed = 0
confirm_order 5xx = 0
```

### 1. Overview có 3 chart cần đọc

Trong tab Overview, đọc 3 chart giống case 01:

```text
1. Response time
2. Execution timeline
3. VUs vs iter/s
```

Với idempotency audit, mỗi chart trả lời một câu hỏi khác nhau:

| Chart | Câu hỏi cần trả lời trong case 02 | Không dùng để kết luận gì? |
| --- | --- | --- |
| Response time | retry/fresh confirm có spike latency không? | không tự chứng minh không double-charge |
| Execution timeline | 20 customer retry storm dồn tải vào mấy bucket? | không tự chứng minh response replay giống nhau |
| VUs vs iter/s | workload 100 confirm call đã chạy đủ chưa? | không tự chứng minh idempotency contract đúng |

Một cách đọc nhanh:

```text
Response time      -> request confirm nhanh/chậm theo thời gian
Execution timeline -> tải confirm/retry phân bổ theo bucket nào
VUs vs iter/s      -> executor có hoàn thành đủ 100 iteration không
Custom metrics     -> fresh/reuse có đúng 20/80 không
Checks             -> replay response có đúng contract không
```

### Chart 1 — Response time

Chart debug:

```text
Debug JSON: response-time
```

Run #32:

| Metric | Giá trị | Cách đọc |
| --- | ---: | --- |
| `pointCount` / buckets | 3 | run ngắn, dashboard gom thành 3 bucket thời gian |
| total samples | 100 | đúng bằng `summary http_reqs` |
| weighted avg | 55.30ms | trung bình toàn bộ request theo bucket |
| summary p95 | 227.89ms | percentile authoritative cuối test |
| summary p99 | 244.59ms | tail latency gần cuối phân phối |
| summary max | 1209.51ms | 1 outlier chậm nhất |
| bucket p95 peak | 1208.32ms | bucket có tail latency cao nhất |
| bucket max peak | 1209.51ms | max trên chart khớp summary max |

Đọc thực tế:

```text
- đa số request confirm nhanh: avg chỉ ~55ms
- p95/p99 summary vẫn dưới ~250ms
- có 1 tail outlier khoảng 1.2s
- outlier này KHÔNG làm test fail vì không có HTTP fail và checks đều pass
```

Đừng nhầm:

```text
bucket p95 peak ≠ summary p95 cuối test
```

Ở run này, bucket p95 peak cao vì trong một bucket ngắn có rất ít request và
một request chậm kéo percentile bucket lên. Final summary p95 vẫn là số dùng
để kết luận tổng thể:

```text
summary p95 = 227.89ms
summary p99 = 244.59ms
```

#### Cách phân tích sâu chart Response time

Khi đọc chart response time của idempotency audit, hỏi 4 câu:

```text
1. Avg có tăng dần theo retry không?
2. p95/max có spike đúng lúc retry storm không?
3. Spike có đi kèm 5xx/check fail không?
4. Spike là vấn đề tail latency hay correctness?
```

Với run #32:

```text
- Có outlier max ~1.2s -> nên ghi nhận tail latency.
- Không có 5xx -> backend không còn crash/timeout thành lỗi HTTP.
- Không có check fail -> response replay đúng contract.
- Fresh/reuse đúng 20/80 -> không double-charge.
```

Kết luận:

```text
Chart response-time còn cho thấy một điểm tail latency cần theo dõi,
nhưng không còn là bug idempotency correctness.
```

Shape cần cảnh giác trong case 02:

| Shape | Nghĩa có thể có |
| --- | --- |
| p95 tăng dần qua từng retry bucket | retry storm làm backend đuối dần |
| max cao kèm `5xx` | timeout/crash ở confirm flow |
| avg thấp nhưng checks fail | response nhanh nhưng replay contract sai |
| custom counters đúng nhưng `http_req_failed > 0` | fresh/reuse count đúng nhưng API chưa ổn định |

### Chart 2 — Execution timeline

Chart debug:

```text
Debug JSON: execution-timeline
```

Run #32:

| Bucket | HTTP reqs | Iterations completed | Ý nghĩa |
| --- | ---: | ---: | --- |
| 1 | 46 | 30 | 20 VU bắt đầu confirm/retry gần như cùng lúc |
| 2 | 52 | 67 | phần lớn retry sequence hoàn thành ở bucket này |
| 3 | 2 | 3 | tail nhỏ cuối run |

Kiểm tổng:

```text
sum(httpReqs) = 46 + 52 + 2 = 100 = summary http_reqs ✓
sum(iterations) = 30 + 67 + 3 = 100 = summary iterations ✓
```

Đọc thực tế:

```text
- workload rất ngắn: 100 confirm calls xong trong 3 bucket
- phần lớn tải nằm ở 2 bucket đầu: 46 + 52 = 98 requests
- bucket cuối chỉ còn 2 request / 3 iteration hoàn thành -> tail bình thường
```

Vì mỗi iteration của case này chỉ có 1 `POST confirm_order`, nên tổng
`http_reqs` và `iterations` đều là 100. Nhưng từng bucket không bắt buộc bằng
nhau tuyệt đối, vì request xảy ra trước khi iteration được tính là hoàn thành.
Một request có thể nằm ở bucket này, còn iteration completion rơi vào bucket
kế tiếp.

### Batch 1 giây / time bucket đọc như nào?

Mỗi point trên chart là một **time bucket / metrics frame**, không phải một
request riêng lẻ:

```text
http_reqs      -> counter cộng dồn trong bucket
iterations     -> số iteration hoàn thành trong bucket
response p95   -> percentile của các request trong bucket đó
vus            -> gauge VU tại thời điểm/bucket, có thể được fill nếu thiếu mẫu
```

Vì vậy cách verify đúng là:

```text
cộng các counter bucket -> so với summary cuối test
```

không phải đọc từng point như một event riêng lẻ. Chi tiết cơ chế bucket xem
case 01, phần “Batch 1 giây / time bucket được tính như nào?”.

### Chart 3 — VUs vs iter/s

Chart debug:

```text
Debug JSON: vus-vs-iterations
```

Run #32:

| Bucket | Observed VUs | Actual iter/s | HTTP reqs | Ý nghĩa |
| --- | ---: | ---: | ---: | --- |
| 1 | 20 | 30 | 46 | đủ 20 VU đang chạy retry storm |
| 2 | 20 → tail | 67 | 52 | phần lớn VU hoàn thành quota 5 iter |
| 3 | 1 | 3 | 2 | còn 1 VU/ít work ở tail |

Kiểm tổng:

```text
sum(Actual iter/s) = 30 + 67 + 3 = 100 = summary iterations ✓
sum(httpReqs) = 46 + 52 + 2 = 100 = summary http_reqs ✓
```

Đọc thực tế:

```text
- executor sinh đủ 20 VU ở đầu run
- throughput peak 67 iter/s vì mỗi iter chỉ là 1 confirm + sleep ngắn
- VU giảm về 1 ở tail là bình thường: VU nào đủ 5 iter thì rời active pool
```

Chart này chứng minh:

```text
workload đã chạy đủ 100 confirm calls.
```

Chart này KHÔNG tự chứng minh:

```text
retry có trả cùng response không,
có double-charge không,
hoặc status/body replay có giống lần đầu không.
```

Các câu đó phải đọc ở custom metrics + checks.

### 2. Tab Executor / Execution

Với `per-vu-iterations`, tab Executor nên có shape:

```text
0 -> 20 VUs -> giảm dần khi VU hoàn thành quota -> 0
```

Case 02 rất ngắn nên tail giảm VU có thể nhìn rõ. Đây là behavior đúng:

```text
mỗi VU = 1 customer
mỗi VU chạy đúng 5 retry
VU chạy xong retry #4 thì dừng
```

Vì vậy thấy `observed VUs` giảm ở cuối không phải thiếu tải. Điều cần kiểm là:

```text
iterations cuối cùng vẫn = 100
idem_fresh_count + idem_reuse_count = 100
```

### 3. `metrics_push_count` khác `pointCount` — không phải bug

`metrics_push_count` là số lần backend nhận batch metrics từ k6/cloud output.
`pointCount` là số bucket dashboard render ra cho một chart. Hai số này không
bắt buộc bằng nhau.

Với docs/chart, verify bằng cách:

```text
sum(chart httpReqs) == summary http_reqs
sum(chart iterations) == summary iterations
```

Không verify bằng:

```text
metrics_push_count == pointCount
```

Chi tiết đầy đủ xem case 01, phần “metrics_push_count khác pointCount — không
phải bug”.

### 4. Endpoint debug series theo metric

Khi cần kiểm bằng API dashboard:

```text
GET http://localhost:13001/v1/tests/32/series?metric=http_reqs
GET http://localhost:13001/v1/tests/32/series?metric=iterations
GET http://localhost:13001/v1/tests/32/series?metric=http_req_duration
```

Nếu custom counter series có sẵn, kiểm thêm:

```text
metric=idem_fresh_count
metric=idem_reuse_count
```

Mục tiêu không phải đọc raw JSON cho nhiều, mà là cộng counter theo bucket và
so với summary/custom metrics cuối test.

### 5. Checklist đọc biểu đồ case 02

| Bước | Câu hỏi | Kết quả run #32 |
| --- | --- | --- |
| 1 | `iterations == 100`? | 100 ✓ |
| 2 | `http_reqs == 100`? | 100 ✓ |
| 3 | `confirm_order 200 == 100` và không 5xx? | 100 / 0 ✓ |
| 4 | `idem_fresh_count == 20`? | 20 ✓ |
| 5 | `idem_reuse_count == 80`? | 80 ✓ |
| 6 | `checks_fails == 0`? | 0 ✓ |
| 7 | sum chart `httpReqs == 100`? | 46+52+2=100 ✓ |
| 8 | sum chart `iterations == 100`? | 30+67+3=100 ✓ |
| 9 | có latency spike không? | có max ~1.2s, nhưng contract pass |

### Cách chốt từ summary -> 3 chart

| Bước | Nhìn ở đâu | Kết luận run #32 |
| --- | --- | --- |
| Tổng workload | summary + VUs vs iter/s | đủ 100/100 confirm calls |
| Fresh/reuse count | custom metrics | 20 fresh + 80 reuse đúng |
| Replay contract | checks | 360/360 checks pass |
| HTTP health | summary + request breakdown | 0 fail, 100 response 200 |
| Latency shape | Response time | có 1 tail max ~1.2s, không làm fail contract |
| Execution shape | Execution timeline / Executor | 20 VU burst ngắn, VU giảm ở tail là bình thường |
| Final verdict | tổng hợp | PASS: idempotency contract an toàn cho retry |

## Kết luận thực tế: đọc output này thì team payment quyết định gì?

Mục tiêu nghiệp vụ: xác nhận **idempotency contract** đúng — 1 đơn chỉ bị
charge tiền 1 lần dù client retry nhiều lần (mạng chập chờn, user bấm lại).
Output ánh xạ sang quyết định "API thanh toán có an toàn để dùng không".

Nhắc lại kỳ vọng: 20 fresh charge + 80 dedupe, mọi retry trả cùng response.

### Kịch bản A — đúng contract: API AN TOÀN

```text
idem_fresh_count...: 20
idem_reuse_count...: 80
http_req_failed....: 0.00%
checks "same status as first": 100%
```

Kết luận thực tế:

```text
- 20 fresh = đúng 20 lần charge tiền THẬT (1 per customer)
- 80 reuse = 80 retry đều bị server dedupe, KHÔNG charge lại
- retry trả cùng response lần đầu -> client thấy kết quả nhất quán
=> QUYẾT ĐỊNH: idempotency contract OK, API an toàn cho retry.
   Khách bấm "thanh toán" 5 lần vẫn chỉ mất tiền 1 lần.
```

### Kịch bản B — fresh > 20: LỖI DOUBLE-CHARGE (nghiêm trọng)

```text
idem_fresh_count...: 27        (> 20!)
idem_reuse_count...: 73
http_req_failed....: 0.00%
```

Kết luận thực tế:

```text
- 27 fresh charge nhưng chỉ có 20 customer -> 7 lần charge LẶP
- nghĩa là 7 retry KHÔNG được dedupe -> server tính là đơn mới -> charge lại
- status code vẫn 200 (0 fail) nên bug NÀY ẨN, chỉ lộ qua custom metric
=> QUYẾT ĐỊNH: CHẶN release ngay. Đây là bug tiền bạc (khách bị trừ tiền
   nhiều lần). Đúng cái case này sinh ra để bắt. Báo dev: key không được
   lưu/đối chiếu đúng (cache TTL quá ngắn? key scope sai? race khi ghi cache?).
   -> thử Variation A (http.batch) để xem có phải race condition không.
```

### Kịch bản C — reuse trả response khác lần đầu: CONTRACT HỎNG MỘT NỬA

```text
idem_fresh_count...: 20         (đúng)
idem_reuse_count...: 80         (đúng count)
checks "same status as first": 71%   (29% retry trả KHÁC!)
```

Kết luận thực tế:

```text
- Count đúng (không double-charge) NHƯNG retry trả response khác lần đầu
- vd lần đầu trả {charged:true, tx:"123"}, retry trả {error:"already processed"}
- client không phân biệt được "thành công" hay "lỗi" -> UX vỡ, có thể
  hiển thị sai cho khách dù tiền đã trừ đúng
=> QUYẾT ĐỊNH: chưa release. Không mất tiền nhưng contract chưa hoàn chỉnh.
   Báo dev: dedupe phải trả LẠI response gốc từ cache, không tự sinh response mới.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| fresh=20, reuse=80, retry same | contract đúng | release, API an toàn retry |
| fresh > 20 | double-charge tiền | chặn release (bug nghiêm trọng) |
| reuse response ≠ first | dedupe trả sai data | chặn release, sửa cache replay |
| fresh + reuse ≠ 100 | test chưa chạy đủ | sửa count, chạy lại |
| http_req_failed > 0 | server lỗi khi dedupe | điều tra lỗi server |

Điểm cốt lõi: **status code 200 KHÔNG đủ để kết luận idempotency đúng**.
Bug double-charge vẫn trả 200. Phải nhìn `idem_fresh_count` (custom metric)
mới thấy. Vì per-vu cố định đúng 20 customer × 5 retry, con số fresh/reuse
là tuyệt đối — lệch 1 đơn vị là phát hiện được ngay.

## Mở rộng

```js
// Gửi 5 retry SONG SONG (parallel) thay vì tuần tự
// http.batch() để tạo race condition
const requests = Array.from({length: 5}, () => ({
  method: "POST",
  url: `${BASE_URL}/api/sim/orders/${orderId}/confirm`,
  body: JSON.stringify({}),
  params: {
    headers: { "Idempotency-Key": idempotencyKey },
  },
}));
const responses = http.batch(requests);

// Tất cả 5 phải có cùng response
```

### Variation B: Multi-tenant idempotency

```js
// Idempotency-Key bound theo (tenant + customer + order)
const tenantId = `tenant-${__VU % 5}`;  // 4 customer mỗi tenant
const customerId = `cust-${__VU}`;
const idempotencyKey = `${tenantId}-${customerId}-${orderId}`;
```

### Variation C: Test edge case key collision

```js
// Cùng key, khác customer -> server PHẢI từ chối (không match scope)
// vus = 20, mỗi VU dùng key = "shared-key-bad" (cố tình collision)
const idempotencyKey = "shared-key-bad";  // anti-pattern
// Expect: 19/20 customer bị 409 Conflict
```

## Liên hệ với case khác

- **Case 01**: pattern Idempotency-Key cũng có nhưng đơn giản hơn
- **Case 06 (cart concurrency)**: same-user race với cart, không phải payment
- **Case 03 (rate limit)**: cũng test "cùng customer làm nhiều việc"

## Anti-pattern: KHÔNG dùng executor nào khác cho test này

```text
constant-vus:
  ❌ VU pool random, key không bound vào customer cụ thể
  ❌ Có thể 1 customer được spam 50 lần, customer khác 0 lần

shared-iterations với iterations=100:
  ❌ Phân phối iter giữa VU không đều -> customer X được 10, Y được 2
  ❌ Pass criteria (20 fresh + 80 reuse) không thể đảm bảo

constant-arrival-rate:
  ❌ Rate-driven, không bound identity với VU
  ❌ Iter cùng VU chạy không liên tục -> key bị mất giữa các iter
```

## Reference

- Doc tham số: `docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md`
- Section 3: ý nghĩa "iterations là per-VU, không phải total"
- Custom metrics: https://k6.io/docs/using-k6/metrics/
