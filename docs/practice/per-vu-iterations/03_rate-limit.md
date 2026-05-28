# Case 03: Per-user rate limit verification

## Tình huống thực tế

API public có SLA: **100 req/min per user token**. Vượt → trả `429 Too
Many Requests` + header `Retry-After`. Team backend mới deploy rate
limiter mới, cần verify SLA chính xác:

```text
- 5 user khác nhau
- Mỗi user gửi 150 request liên tục (không sleep)
- 100 req đầu: status 200
- 50 req cuối: status 429 + có Retry-After
- KHÔNG có request nào nhầm scope (user A bị limit do user B spam)
```

## Why per-vu-iterations?

```text
Rate limit count THEO USER (theo token), không phải global.
Phải đảm bảo:
  - Mỗi VU = 1 user phân biệt
  - VU đó SPAM 150 lần liên tục với cùng token
  - Hit ngưỡng 100 -> bị throttle

per-vu-iterations đảm bảo:
  - vus=5 -> đúng 5 user phân biệt
  - iterations=150 per VU -> mỗi user spam đủ 150
  - Total = 5 × 150 = 750 request, deterministic

Nếu dùng constant-vus 5 VU × 30s:
  ❌ Không biết bao nhiêu request mỗi user gửi
  ❌ Khó verify "user X bị limit ở request thứ 101"

Nếu dùng shared-iterations 750:
  ❌ 5 VU chia chung 750 -> phân phối lệch
  ❌ User nhanh có thể spam 200 lần, user chậm chỉ 50

Nếu dùng constant-arrival-rate:
  ❌ Rate-driven, không bound user với VU
  ❌ Không đảm bảo "1 user = 150 req"
```

## Config

```js
export const options = {
  scenarios: {
    rate_limit_audit: {
      executor: "per-vu-iterations",
      vus: 5,                  // 5 users
      iterations: 150,         // 150 req per user
      maxDuration: "2m",
    },
  },
  thresholds: {
    count_200: ["count==500"],   // 5 × 100 = 500 OK
    count_429: ["count==250"],   // 5 × 50 = 250 throttled
  },
};
```

## Custom metrics

```js
const count200 = new Counter("count_200");
const count429 = new Counter("count_429");

// Trong default function: count theo res.status
```

## Per-VU state

```js
let userToken = null;  // tính ở iter 0, dùng 150 lần

if (__ITER === 0) {
  userToken = `user-token-${__VU}`;
}
```

## Endpoint flow

```text
Iter 0:
  - Tạo user_token (= "user-token-${__VU}")
  - GET /api/products với Authorization: Bearer ${token}
  - Expect 200 (counter = 1)

Iter 1-99:
  - Spam GET với cùng token
  - Expect 200 (counter < 100)

Iter 100-149:
  - Spam tiếp, đã vượt limit
  - Expect 429 + header Retry-After
```

## Pass criteria

```text
1. count_200 == 500    (5 user × 100 req đầu = 500 OK)
2. count_429 == 250    (5 user × 50 req sau = 250 throttled)
3. 429 response có Retry-After header
4. Tổng req == 750     (deterministic)
```

## Cách chạy

> Stack setup chung: xem [RUN_GUIDE.md](RUN_GUIDE.md).

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"   # mỗi VU dùng token riêng giả lập trong code

cd "E:\Khoa hoc\k6"
k6 run -o cloud .\examples\per-vu-iterations\pvi-03-rate-limit.js
```

**Verify trên UI**:

```text
1. Paste token, click run mới nhất → tab Custom metrics
2. count_200: 500 ✓     (5 user × 100 req đầu)
3. count_429: 250 ✓     (5 user × 50 req sau bị throttle)
4. checks "429 has Retry-After header": 100% pass ✓

Output kỳ vọng:
  ✓ count_200: 500
  ✓ count_429: 250
  ✓ 429 has Retry-After header
```

**Lưu ý**: case này `http_req_failed` sẽ là ~33% (vì 429 tính là failed).
KHÔNG phải lỗi nghiệp vụ — đây là response mong đợi. Custom threshold
nếu cần loại 429 ra: `http_req_failed{status:!429} < 1%`.

## Áp 5 bước phân tích output

### Bước 1: Verify config

```text
Header: "150 iterations for each of 5 VUs" ✓
```

### Bước 2: Total dự kiến

```text
total = 5 × 150 = 750 requests
```

### Bước 3: So với N_done

```text
iterations = 750 (summary) -> 100% ✓
```

### Bước 4: Verify custom metrics

```text
count_200 = 500 ✓
count_429 = 250 ✓
500 + 250 = 750 = total ✓

→ Rate limit hoạt động chính xác
```

### Bước 5: Đọc thêm http_req_failed

```text
http_req_failed = 33.3% (250/750 là 429)

⚠️ LƯU Ý: 429 KHÔNG phải lỗi nghiệp vụ - đây là response mong đợi.
Cần custom threshold: http_req_failed{status:!429} < 1%
hoặc dùng tag để loại 429 ra.
```

## Mở rộng

### Variation A: Burst test

```js
// Spam 150 req trong 1 giây (burst), sau đó nghỉ
// Test rate limiter có sliding window không?
// Iter 0-149: không sleep
// Sau khi xong: nghỉ 60s, gửi lại 1 req -> expect 200
```

### Variation B: Multi-tier rate limit

```js
// Free tier: 100/min, Premium: 1000/min
const tier = __VU <= 3 ? "free" : "premium";
const limit = tier === "free" ? 100 : 1000;
const iterations = tier === "free" ? 150 : 1500;

// Cần 2 scenario riêng vì iterations khác nhau
```

### Variation C: Verify Retry-After value

```js
if (res.status === 429) {
  const retryAfter = parseInt(res.headers["Retry-After"]);
  check(res, {
    "Retry-After in valid range": () => retryAfter > 0 && retryAfter <= 60,
  });
}
```

## Liên hệ với case khác

- **Case 02**: cũng test "cùng customer làm nhiều việc", nhưng audit idempotency thay vì rate limit
- **Case 04**: test session expire, dùng cùng pattern token bound vào VU

## Anti-pattern

```text
❌ constant-vus với duration:
   k6 run --vus 5 --duration 30s
   -> không kiểm soát được req/user, có thể VU nhanh gửi 200, VU chậm 80

❌ Bỏ qua __VU trong header:
   headers: { Authorization: "Bearer fixed-token" }
   -> rate limit count theo "fixed-token", không phải per-user
   -> 5 VU chia chung 100 req limit, hit rất sớm
```

## Reference

- Doc tham số: `docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md`
- HTTP 429 spec: RFC 6585
- Retry-After: RFC 7231 Section 7.1.3
