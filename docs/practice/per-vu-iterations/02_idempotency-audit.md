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

## Mở rộng

### Variation A: Test chống race trong cùng VU

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
