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

## Vì sao "session lifecycle test" buộc chọn per-vu-iterations?

Trước khi vào kỹ thuật, hiểu **session lifecycle** là gì:

```text
Session lifecycle = vòng đời 1 phiên đăng nhập:
  login -> nhận access_token (TTL ngắn) + refresh_token (TTL dài)
  -> dùng access_token cho mọi request
  -> access_token HẾT HẠN -> dùng refresh_token xin token mới
  -> KHÔNG cần login lại

Đời thường:
  Vé vào cổng (access_token) hết hạn sau 15 phút
  Thẻ thành viên (refresh_token) đổi vé mới mà không cần mua lại
```

Để test vòng đời này **đúng**, phải đảm bảo **2 yêu cầu cốt lõi**.
Chỉ per-vu-iterations mới thỏa mãn cả 2.

### Yêu cầu (a): TOKEN BOUND VÀO VU (1 user giữ 1 cặp token)

**Ý nghĩa**: Mỗi user phải GIỮ access_token + refresh_token RIÊNG qua nhiều
thao tác. Khi token expire, phải refresh và UPDATE token của chính user đó.

```text
Flow đúng (cùng user giữ token qua iter):
  Iter 0: login -> access_token="A1", refresh_token="R1" (lưu per-VU)
  Iter 1-9: dùng A1 -> OK
  Iter 10: A1 expired -> refresh bằng R1 -> nhận A2 (update biến per-VU)
  Iter 11-19: dùng A2 -> OK

Vì sao per-vu đảm bảo?
  - 1 VU = 1 user, biến accessToken/refreshToken sống qua iter
  - Detect 401 ở iter N -> refresh -> ghi đè token -> iter N+1 dùng token mới
  - State per-VU là điều kiện BẮT BUỘC để mô phỏng lifecycle
```

**Vì sao executor khác fail?**

```text
✗ constant-vus / arrival-rate:
  - VU pool tái sử dụng -> token của user A bị user B ghi đè
  - Hoặc biến global -> mọi VU share 1 token -> không test lifecycle riêng
  - Không có concept "cùng user qua 20 thao tác"
```

### Yêu cầu (b): CHẠY ĐỦ ITER ĐỂ TOKEN EXPIRE + REFRESH

**Ý nghĩa**: Phải chạy đủ số thao tác để token thật sự expire, rồi verify
refresh hoạt động. Nếu test ngắn (token chưa expire) → không test được refresh.

**3 nguyên nhân kỹ thuật của bug refresh token**:

#### Nguyên nhân 1: REFRESH TOKEN ROTATION (refresh token cũ phải bị thu hồi)

**Rotation là gì?** Mỗi lần refresh, server cấp refresh_token MỚI và thu hồi
cái cũ (chống token bị đánh cắp dùng lại).

```text
Flow đúng:
  Iter 10: refresh bằng R1 -> nhận A2 + R2, server thu hồi R1
  Iter 20: refresh bằng R2 -> nhận A3 + R3, server thu hồi R2

Bug: server KHÔNG thu hồi R1
  -> R1 vẫn dùng được sau khi đã rotate
  -> nếu R1 bị lộ, attacker refresh vô hạn -> chiếm tài khoản

→ Test phải refresh ÍT NHẤT 2 lần (R1->R2->R3) để verify rotation
→ per-vu: kiểm soát số iter -> đảm bảo token rotate đủ số lần
```

#### Nguyên nhân 2: CONCURRENT REFRESH RACE (2 request cùng refresh)

**Vấn đề**: Khi token sắp expire, 2 request song song cùng phát hiện 401 và
cùng gọi refresh → race condition.

```text
Race:
  Request 1 (t=0.00s): A1 expired -> refresh bằng R1 -> nhận A2, thu hồi R1
  Request 2 (t=0.01s): A1 expired -> refresh bằng R1 (đã bị thu hồi!)
                       -> 403 Forbidden -> user bị logout oan

Fix đúng: refresh lock per-user, hoặc grace period cho refresh token cũ

→ Test tuần tự -> không trigger race
→ Phải gửi 2 request song song lúc token sắp hết (http.batch)
→ per-vu + batch: tạo race chính xác cho cùng user
```

#### Nguyên nhân 3: CLOCK SKEW (lệch giờ giữa client và server)

**Vấn đề**: access_token có field `exp` (thời điểm hết hạn). Nếu giờ server
lệch giờ client → token bị coi expired sớm/muộn.

```text
Clock skew:
  Server cấp token exp=12:00:00
  Client giờ chạy nhanh 30s -> client nghĩ token expired lúc 11:59:30
  -> client refresh SỚM 30s -> tăng tải refresh endpoint vô ích

Hoặc ngược lại:
  Client chậm 30s -> dùng token đã expired -> server trả 401 bất ngờ
  -> nếu client không handle 401 -> request fail

Fix: dùng leeway (cho phép lệch ±60s), sync NTP

→ Test phải chạy đủ dài qua mốc expire để phát hiện skew
→ per-vu: iter cố định + track tokenIssuedAtIter -> mô phỏng expire chính xác
```

#### Tổng kết: chỉ per-vu thỏa mãn cả (a) và (b)

| Executor | (a) Token bound vào VU | (b) Chạy đủ iter để expire | Verdict |
| --- | --- | --- | --- |
| **per-vu-iterations** | ✓ token sống qua iter | ✓ mỗi VU chạy đủ N iter | ✅ DÙNG |
| shared-iterations | ✗ token mất khi đổi VU | ✗ phân phối iter không đều | ❌ |
| constant-vus (duration) | ✗ VU pool ghi đè token | ✗ số iter phụ thuộc latency | ❌ |
| constant-arrival-rate | ✗ identity rời VU | ✗ rate-driven, iter rời rạc | ❌ |
| ramping-vus | ✗ VU spawn/despawn mất token | ✗ iter biến thiên | ❌ |
| ramping-arrival-rate | ✗ rate-driven | ✗ không bound user | ❌ |

→ Chỉ **per-vu-iterations** đảm bảo "1 user giữ token qua đủ N thao tác",
điều kiện BẮT BUỘC để mô phỏng token expire + refresh lifecycle.

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

> **Tại sao token không mất sau khi refresh?** Cùng cơ chế case 01:
> module-level variables GIỮ qua iter, kể cả khi ghi đè token mới
> sau refresh. Xem [case 01 / Per-VU state](./01_user-journey-replay.md#per-vu-state).

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

> Stack setup chung: xem [RUN_GUIDE.md](RUN_GUIDE.md).

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"   # session test với student token

cd "E:\Khoa hoc\k6"
k6 run -o cloud .\examples\per-vu-iterations\pvi-04-session-lifecycle.js
```

**Verify trên UI**:

```text
1. Paste token, click run mới nhất → tab Custom metrics
2. login_count: 10 ✓               (1 login per user)
3. refresh_count: 10 ✓             (1 refresh per user)
4. failed_after_refresh: 0 ✓       (refresh xong work tiếp)

Output kỳ vọng trong console:
  [VU=1] login successful
  [VU=1] iter#10 token expired, refreshing...
  ... (cho cả 10 VU)
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
