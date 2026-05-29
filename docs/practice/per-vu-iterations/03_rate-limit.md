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

## Vì sao "rate limit test" buộc chọn per-vu-iterations?

Trước khi vào kỹ thuật, hiểu **rate limit** là gì:

```text
Rate limit = "giới hạn số request mỗi user trong 1 khoảng thời gian".

Đời thường:
  Quầy vé chỉ bán tối đa 100 vé/người/ngày
  Mua vé thứ 101 -> "hết hạn mức, mai quay lại" (= HTTP 429)

Vì sao đếm THEO USER, không phải global?
  - SLA: "100 req/phút mỗi token"
  - User A spam không được làm ảnh hưởng hạn mức user B
  - Mỗi token có bộ đếm RIÊNG
```

Để verify rate limiter **đúng**, test phải đảm bảo **2 yêu cầu cốt lõi**.
Chỉ per-vu-iterations mới thỏa mãn cả 2.

### Yêu cầu (a): CÙNG TOKEN SPAM ĐỦ N REQUEST (vượt ngưỡng)

**Ý nghĩa**: Phải có 1 user gửi đủ >100 request với CÙNG token để hit ngưỡng.
Nếu request rải rác nhiều token → không token nào đạt ngưỡng → không test được.

```text
Flow đúng (cùng user, spam liên tục):
  User A (VU 1): req 1-100  với token-A -> 200 OK
  User A (VU 1): req 101-150 với token-A -> 429 (vượt ngưỡng)

Vì sao per-vu đảm bảo?
  - 1 VU = 1 user = 1 token cố định (lưu ở iter 0)
  - iterations=150 -> VU đó gửi đúng 150 req với cùng token
  - Bộ đếm server cho token-A chắc chắn đạt 150 -> trigger 429
```

**Vì sao executor khác fail?**

```text
✗ constant-vus / arrival-rate:
  - VU pool random -> token không cố định cho 1 user qua các req
  - Request rải đều nhiều token -> mỗi token chỉ ~30 req -> KHÔNG ai đạt 100
  - 429 không bao giờ xuất hiện -> test "pass" giả (false negative)
```

### Yêu cầu (b): COUNT REQUEST PER USER CHÍNH XÁC

**Ý nghĩa**: Phải biết CHÍNH XÁC user gửi bao nhiêu req để verify "req thứ
101 bắt đầu 429". Nếu count biến thiên → không verify được ranh giới.

**3 nguyên nhân kỹ thuật khiến rate limiter dễ sai**:

#### Nguyên nhân 1: SLIDING vs FIXED WINDOW (ranh giới đếm khác nhau)

**2 kiểu đếm phổ biến**, hành vi ở ranh giới rất khác:

```text
FIXED WINDOW (đơn giản, có burst bug):
  - Chia thời gian thành ô cố định: [0-60s], [60-120s]
  - Đếm lại từ 0 mỗi ô
  - BUG: user gửi 100 req ở giây 59 + 100 req ở giây 61
         -> 200 req trong 2 giây nhưng KHÔNG bị limit
         (vì rơi vào 2 window khác nhau)

SLIDING WINDOW (chính xác hơn):
  - Đếm 60s GẦN NHẤT tính từ thời điểm request
  - req thứ 101 trong bất kỳ 60s nào -> 429

→ Test phải gửi đủ req để CHẠM ranh giới window
→ per-vu: kiểm soát chính xác số req + thời điểm -> test được cả 2 kiểu
```

#### Nguyên nhân 2: DISTRIBUTED COUNTER LAG (nhiều server đếm lệch)

**Vấn đề**: Production có nhiều instance server, mỗi instance giữ counter
riêng, sync về Redis chậm → user có thể vượt ngưỡng tạm thời.

```text
2 server, load balancer chia request:
  Server 1: đếm token-A = 50 (chưa sync)
  Server 2: đếm token-A = 50 (chưa sync)
  Redis tổng: lẽ ra 100, nhưng mỗi server tưởng mới 50
  -> user gửi được 150 req trước khi sync kịp -> vượt SLA

Fix: atomic INCR trên Redis trung tâm (không đếm local)

→ Test 1 user gửi nhiều req nhanh -> phát hiện counter lag
→ per-vu: cùng token spam liên tục -> stress counter sync
```

#### Nguyên nhân 3: TOKEN BUCKET REFILL (hồi hạn mức sai nhịp)

**Token bucket** = thuật toán phổ biến: mỗi user có "xô" chứa N token,
mỗi request tiêu 1 token, xô tự refill R token/giây.

```text
Bucket cap=100, refill=10/s:
  - Spam 100 req tức thì -> xô cạn -> req 101 bị 429
  - Chờ 1s -> refill 10 token -> gửi thêm 10 req OK
  - BUG: refill tính sai (vd refill mỗi request thay vì mỗi giây)
         -> hạn mức không bao giờ cạn -> SLA vô dụng

→ Test phải spam đủ để cạn bucket, rồi verify refill đúng nhịp
→ per-vu: iterations cố định -> biết chính xác bao nhiêu req đã tiêu
```

#### Tổng kết: chỉ per-vu thỏa mãn cả (a) và (b)

| Executor | (a) Cùng token spam đủ N | (b) Count per user chính xác | Verdict |
| --- | --- | --- | --- |
| **per-vu-iterations** | ✓ token cố định, N req | ✓ vus × iters chính xác | ✅ DÙNG |
| shared-iterations | ✗ token random theo VU | ✗ phân phối req không đều | ❌ |
| constant-vus (duration) | ✗ token không cố định | ✗ count phụ thuộc latency | ❌ |
| constant-arrival-rate | ✗ rate-driven, rải token | ✗ không bound user-token | ❌ |
| ramping-vus | ✗ VU spawn lệch | ✗ count biến thiên | ❌ |
| ramping-arrival-rate | ✗ rate-driven | ✗ không bound user | ❌ |

→ Chỉ **per-vu-iterations** đảm bảo "1 user spam đủ N req với cùng token",
điều kiện BẮT BUỘC để hit ngưỡng và verify rate limiter chính xác.

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
