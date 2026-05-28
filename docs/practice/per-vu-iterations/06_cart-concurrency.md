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

## Why per-vu-iterations?

```text
Race condition CHỈ test được khi cùng user-id concurrent:
  - 1 VU = 1 user
  - http.batch() trong iter -> 3 request song song CÙNG user
  - Server: phải atomic update cart per user

shared-iterations:
  ❌ random VU pick -> 1 user có thể bị 1 VU spam, user khác 0
  ❌ Không tạo được "same user, 3 tab concurrent"

constant-vus:
  ❌ Không cố định số burst per user
  ❌ VU pool race với nhau, không phải user pool
```

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

```bash
k6 run examples/per-vu-iterations/pvi-06-cart-concurrency.js
```

## Mở rộng

### A: Test với load tăng dần concurrent count

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
