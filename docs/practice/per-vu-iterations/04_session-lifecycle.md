# Case 04: Session lifecycle + refresh token

## Tình huống thực tế

Hệ thống dùng JWT có TTL ngắn (5-15 phút). Khi access token expire,
client phải gọi `/auth/refresh` để lấy token mới mà không cần login lại.

```text
Yêu cầu test:
  - 10 users, mỗi user làm 20 thao tác liên tiếp
  - Login 1 LẦN ở đầu
  - Token expire sau iter 10 (TTL giả lập)
  - Verify: client tự refresh, tiếp tục thao tác
  - Sau refresh, /me phải trả 200 (không bị 401 lần nữa)
```

## Why per-vu-iterations?

```text
Token lifecycle bound theo VU:
  - 1 user = 1 access_token + 1 refresh_token
  - Phải GIỮ token qua 20 iter
  - Phải DETECT 401, gọi refresh, UPDATE token

Không executor nào khác làm được:
  - constant-vus: VU pool random, token mất giữa iter
  - shared-iterations: 200 iter chung, không có concept "20 iter per user"
  - arrival-rate: rate-driven, không bound user-VU
```

## Config

```js
export const options = {
  scenarios: {
    session_lifecycle: {
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 20,
      maxDuration: "3m",
    },
  },
  thresholds: {
    login_count: ["count==10"],         // 1 login per user
    refresh_count: ["count==10"],       // 1 refresh per user
    failed_after_refresh: ["count==0"], // refresh phải thành công
  },
};
```

## Per-VU state

```js
let accessToken = null;
let refreshToken = null;
let tokenIssuedAtIter = 0;  // track khi nào token cấp -> tính TTL
```

## Endpoint flow

```text
Iter 0: POST /api/sim/auth/login
        -> nhận access_token, refresh_token

Iter 1-9: GET /api/sim/auth/me (verify token)
          GET /api/sim/products (action)

Iter 10: GET /api/sim/auth/me -> 401 (token expired)
         POST /api/sim/auth/refresh -> token mới
         GET /api/sim/auth/me -> 200 (verify refresh OK)
         GET /api/sim/products

Iter 11-19: tiếp tục với token mới
```

## Pass criteria

```text
1. login_count == 10            (1 login per user)
2. refresh_count == 10          (1 refresh per user khi token expire)
3. failed_after_refresh == 0    (sau refresh phải work)
4. iterations == 200            (10 × 20 = 200, deterministic)
```

## Custom metrics

```js
const loginCount = new Counter("login_count");
const refreshCount = new Counter("refresh_count");
const failedAfterRefresh = new Counter("failed_after_refresh");
```

## Cách chạy

```bash
k6 run examples/per-vu-iterations/pvi-04-session-lifecycle.js
```

## Phân tích output

```text
Bước 1: Header "20 iterations for each of 10 VUs" ✓
Bước 2: total = 10 × 20 = 200
Bước 3: iterations = 200 (summary) -> 100% ✓
Bước 4: login_count=10, refresh_count=10, failed_after_refresh=0 ✓
Bước 5: iter_time = action time + occasional refresh overhead
```

## Mở rộng

### A: Random TTL per user

```js
// Mỗi user có TTL khác nhau (mô phỏng load balancer phân tải)
const ttl = 8 + (__VU % 5); // 8-12 iter
if (__ITER - tokenIssuedAtIter >= ttl) { /* refresh */ }
```

### B: Concurrent refresh (race condition)

```js
// 2 request song song khi token sắp expire
// Verify: chỉ 1 refresh thành công, request 2 dùng token mới
```

### C: Refresh fail handling

```js
// Mock: refresh trả 403 (refresh_token expired)
// User phải re-login
if (refreshRes.status === 403) {
  const tokens = login();  // re-login
}
```

## Anti-pattern

```text
❌ constant-vus với --duration:
   Token có thể bị stuck trong iter 0 mãi nếu test ngắn
   VU random pick -> không đảm bảo "user X gặp token expire"

❌ Init phase set token toàn cục:
   const TOKEN = login();  // chạy 1 lần, share giữa VU
   -> tất cả VU dùng cùng token, không test được lifecycle riêng
```

## Reference

- Doc tham số: `docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md`
- Pattern liên quan: case 02 (idempotency) cũng dùng per-VU token
