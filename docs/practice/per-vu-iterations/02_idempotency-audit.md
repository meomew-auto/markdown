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

## Why per-vu-iterations?

```text
Mỗi VU = 1 customer:
  - Idempotency-Key tính 1 LẦN ở iter 0
  - 4 iter sau dùng CÙNG key
  - server PHẢI nhận ra "đây là retry" và dedupe

Nếu dùng constant-vus:
  - VU random pick -> 1 customer có thể bị 1 VU spam, customer khác 0 lần
  - hoặc __VU không stable trên session-level -> key không đoán được

Nếu dùng shared-iterations:
  - 100 iter chia chung 20 VU -> không đảm bảo "mỗi customer 5 retry"
  - VU nhanh có thể nhận 10 retry, VU chậm chỉ 2 -> audit sai
```

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

```js
let customerToken = null;
let orderId = null;
let idempotencyKey = null;       // tính ở iter 0, dùng cả 5 lần
let firstResponseSnapshot = null; // verify retry response giống fresh
```

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

```bash
k6 run examples/per-vu-iterations/pvi-02-idempotency-audit.js

# Output kỳ vọng:
#   ✓ idem_fresh_count: 20
#   ✓ idem_reuse_count: 80
#   ✓ idem replay: same status as first
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
