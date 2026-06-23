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

**── Phân tích chi tiết từng nguyên nhân ──**

#### Nguyên nhân 1: VU pool tái sử dụng → token bị ghi đè

Với `constant-vus` và `arrival-rate`, VU được quản lý theo POOL — không có
ràng buộc "VU nào phải chạy iteration nào". 1 VU có thể chạy iter của user A
rồi ngay sau đó chạy iter của user B.

```text
Timeline minh họa với constant-vus (VU=2):

  Iter #1: scheduler giao cho VU #1
    VU #1 bắt đầu chạy → login user A → token_A = "tA1"
    Lưu token vào biến per-VU của VU #1

  Iter #2: scheduler giao cho VU #2
    VU #2 bắt đầu chạy → login user B → token_B = "tB1"
    Lưu token vào biến per-VU của VU #2

  Iter #3: scheduler giao cho VU #1 (VU #1 vừa rảnh)
    VU #1 đọc token từ biến per-VU → được "tA1" ✓
    → Dùng token của user A → ĐÚNG

  Iter #4: scheduler giao cho VU #2
    VU #2 xong iter trước → rảnh → nhận iter mới
    Nhưng lần này scheduler giao iter của USER C!
    → VU #2 login user C → token_C = "tC1"
    → token_B bị GHI ĐÈ bởi token_C
    → Nếu sau đó VU #2 nhận iter của user B → token đã là của C → SAI
```

Vấn đề cốt lõi: **scheduler không biết "VU này đang là user nào"**. Nó chỉ
thấy "VU rảnh → giao việc". VU có thể đang mang state của user A nhưng lại
được giao iter của user B.

```text
So sánh với per-vu-iterations:
  VU #1: iter 0=login, iter 1=dùng, iter 2=dùng, ..., iter 19=logout
  → TẤT CẢ iter của VU #1 đều là CÙNG 1 USER
  → Token không bao giờ bị ghi đè vì không có user khác xen vào

  Đây là khác biệt MẤU CHỐT:
    per-vu:        VU ↔ user (1-1, cố định)
    constant-vus:  VU ↔ iter  (n-n, scheduler giao tự do)
```

#### Nguyên nhân 2: Biến global → mọi VU share 1 token

Nếu dùng biến global (khai báo ngoài `export default function`) để lưu token:

```js
// ❌ SAI — biến global, mọi VU share
let accessToken = null;
let refreshToken = null;

export default function () {
  if (!accessToken) {
    const tokens = login();
    accessToken = tokens.access;   // ← GHI ĐÈ GLOBAL
    refreshToken = tokens.refresh;
  }
  // ...
}
```

```text
Timeline minh họa:

  VU #1 chạy iter đầu:
    accessToken = null → login user A → accessToken = "tA1"

  VU #2 chạy iter đầu (gần như đồng thời):
    accessToken = "tA1" (đã có!) → KHÔNG login → dùng token của user A
    → VU #2 tưởng mình là user A nhưng thực ra là user B
    → Tất cả request của VU #2 dùng sai token

  VU #1 chạy iter tiếp theo:
    accessToken có thể đã bị VU #2 (hoặc VU #3) ghi đè
    → VU #1 mất token của user A → 401 bất ngờ
    → Refresh bằng refreshToken — nhưng refreshToken cũng bị ghi đè rồi
```

```text
Kết quả: tất cả VU dùng chung 1 cặp token — không thể test được:
  - User A login → user B dùng ké token A
  - User B refresh → user A mất token
  - Không phân biệt được lỗi của user nào

→ Biến global PHÁ VỠ isolation giữa các VU
→ Mọi VU đều thấy cùng 1 giá trị → không có "user riêng"
```

Biến global cũng gây vấn đề với `shared-iterations`:

```text
Với shared-iterations (VU=3, iterations=30):
  Iter #1: VU #1 login user A → globalToken = "tA1"
  Iter #2: VU #2 thấy globalToken != null → dùng ké "tA1"
  Iter #3: VU #3 thấy globalToken != null → dùng ké "tA1"
  ...
  Iter #10: VU #1 refresh → globalToken = "tA2"
  → Không ai biết VU nào đang là user nào
  → Tất cả chen nhau đọc/ghi cùng 1 biến
```

#### Nguyên nhân 3: Không có concept "cùng user qua N thao tác"

`constant-vus` và `arrival-rate` được thiết kế để **đo throughput** — tạo ra
dòng request liên tục với rate nhất định. Chúng không có khái niệm "phiên
làm việc" (session) của 1 user.

```text
Điều constant-vus/arrival-rate LÀM ĐƯỢC:
  → "Tạo 100 request/giây để đo server chịu tải bao nhiêu"
  → Mỗi request là ĐỘC LẬP — không cần nhớ state của request trước
  → VU nào rảnh thì nhận việc, không quan tâm "ai đã làm gì trước đó"

Điều constant-vus/arrival-rate KHÔNG LÀM ĐƯỢC:
  → "User A login → duyệt 9 trang → token expire → refresh → duyệt tiếp"
  → Cần NHỚ state qua 20 iteration: đã login chưa, token gì, đã refresh lần nào
  → Cần ĐẢM BẢO 20 iteration đó do CÙNG 1 VU thực hiện

→ Đây là 2 MỤC ĐÍCH TEST KHÁC NHAU:
    Load test:    "server chịu được bao nhiêu request/giây?"
    Lifecycle test: "1 user trải qua 20 thao tác có bị lỗi gì không?"
```

**── Bảng so sánh: ai làm được gì ──**

```text
┌──────────────────────────┬──────────────┬──────────────┬────────────────┐
│ Yêu cầu                   │ per-vu       │ constant-vus │ arrival-rate   │
├──────────────────────────┼──────────────┼──────────────┼────────────────┤
│ Token riêng mỗi user      │ ✓ (1 VU=1    │ ✗ (pool ghi  │ ✗ (identity    │
│                           │   user)      │   đè token)  │   rời VU)      │
├──────────────────────────┼──────────────┼──────────────┼────────────────┤
│ Token sống qua nhiều iter │ ✓ (biến per- │ ✗ (mỗi iter  │ ✗ (mỗi iter   │
│                           │   VU tồn tại │   là độc lập)│   là độc lập)  │
│                           │   qua iter)  │              │                │
├──────────────────────────┼──────────────┼──────────────┼────────────────┤
│ Cùng user qua N thao tác  │ ✓ (N iter =  │ ✗ (không có  │ ✗ (không có   │
│                           │   lifecycle) │   lifecycle) │   lifecycle)  │
├──────────────────────────┼──────────────┼──────────────┼────────────────┤
│ Tạo race condition        │ ✓ (dùng     │ ✗ (không     │ ✗ (không      │
│ (concurrent refresh)      │   batch)    │   kiểm soát  │   kiểm soát   │
│                           │             │   được user) │   được user)  │
├──────────────────────────┼──────────────┼──────────────┼────────────────┤
│ Đo throughput             │ ✗ (iter cố  │ ✓ (đo        │ ✓ (đo chính   │
│                           │   định, ko  │   latency)   │   xác rate)   │
│                           │   quan tâm) │              │                │
└──────────────────────────┴──────────────┴──────────────┴────────────────┘

→ Mỗi executor có 1 MỤC ĐÍCH RIÊNG. Không ai "tốt hơn" ai — chỉ là
  "đúng tool cho đúng việc".
```

**── Góc nhìn kiến trúc: VU pool trong closed model ──**

Từ phân tích trên có thể thấy 1 nguyên lý sâu hơn về cách k6 thiết kế
closed model:

```text
TẤT CẢ closed model executor (constant-vus, ramping-vus, shared-iterations)
đều dùng VU pool theo cùng 1 cách:

  ┌─────────┐     ┌──────────────────┐
  │ Công    │ ──► │ VU Pool          │
  │ việc    │     │ ┌────┐ ┌────┐   │
  │ (iter)  │     │ │VU#1│ │VU#2│   │
  │         │     │ └────┘ └────┘   │
  │ iter #1 │ ──► │   ↓              │
  │ iter #2 │ ──► │ VU nào RẢNH     │
  │ iter #3 │ ──► │ thì NHẬN việc   │
  │ ...     │     │                  │
  └─────────┘     └──────────────────┘

  → VU là "worker vô danh" — không có identity
  → Iter là "việc cần làm" — giao cho ai cũng được
  → KHÔNG CÓ RÀNG BUỘC: "việc này phải do VU kia làm"
```

Hệ quả của kiến trúc này với session lifecycle:

```text
Ví dụ: constant-vus, VU=3, muốn test 3 user (A, B, C), mỗi user 20 thao tác.

  Timeline:
    t=0:   VU #1 rảnh → nhận iter #1 (user A, login)
    t=0.1: VU #2 rảnh → nhận iter #2 (user A, thao tác 2 — nhưng VU #2
           không có token của A!)
    t=0.2: VU #3 rảnh → nhận iter #3 (user B, login)
    t=0.3: VU #1 rảnh → nhận iter #4 (user C, login — ghi đè state A)
    ...

  → Không VU nào "sở hữu" 1 user
  → State của user A phân tán khắp 3 VU (hoặc không VU nào có)
  → Không thể tái tạo flow: login → dùng → expire → refresh → dùng tiếp
```

`per-vu-iterations` là NGOẠI LỆ DUY NHẤT trong closed model:

```text
  ┌──────────────────────────────────────┐
  │ per-vu-iterations                    │
  │                                      │
  │ VU #1: [iter0] [iter1] ... [iter19] │ ← TẤT CẢ của CÙNG user A
  │ VU #2: [iter0] [iter1] ... [iter19] │ ← TẤT CẢ của CÙNG user B
  │ VU #3: [iter0] [iter1] ... [iter19] │ ← TẤT CẢ của CÙNG user C
  │                                      │
  │ → VU = user (1-1, cố định từ đầu)    │
  │ → State nằm TRỌN trong 1 VU          │
  │ → Không bị VU khác xen vào            │
  └──────────────────────────────────────┘
```

So sánh trực quan:

```text
                    shared-iterations    constant-vus        per-vu-iterations
                    ─────────────────    ────────────        ─────────────────
Phân phối iter      iter#1→VU nào       iter#1→VU rảnh      toàn bộ iter của
                    rảnh thì nhận        đầu tiên            1 VU giao cho VU đó

VU ↔ user           KHÔNG CÓ             KHÔNG CÓ            1-1 CỐ ĐỊNH
                    (iter trộn lẫn)      (iter trộn lẫn)     (VU#k = user#k)

State per-VU        vô nghĩa             vô nghĩa             CỐT LÕI
                    (state bị ghi đè     (state bị ghi đè     (state sống qua
                     mỗi iter mới)        mỗi iter mới)        đúng N iter)

Dùng cho            1 việc độc lập       đo throughput        session lifecycle
                    chạy N lần           liên tục             user journey
                                         (không state)        (có state)
```

Tóm lại:

```text
KHÔNG PHẢI shared-iterations hay constant-vus "làm sai" — chúng được
thiết kế ĐÚNG cho mục đích của chúng: chạy nhiều việc ĐỘC LẬP, không
cần nhớ state giữa các lần chạy.

NHƯNG khi cần test session lifecycle (có state, có token, có refresh),
chỉ per-vu-iterations mới có kiến trúc VU↔user 1-1 để làm việc đó.

→ Đây không phải là "bug" của executor khác — đây là THIẾT KẾ.
→ Mỗi executor giải quyết 1 lớp bài toán khác nhau.
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

**Code thật từ file pvi-04-session-lifecycle.js**:

```js
// ───── Module-level scope (GIỮ qua 20 thao tác, kể cả khi refresh) ─────
let accessToken = null;
let refreshToken = null;
let tokenIssuedAtIter = 0;   // track iter nào token được cấp

// ───── Trong default() ─────
export default function () {
  // Iter 0: login -> ghi accessToken, refreshToken vào module-level
  if (__ITER === 0) {
    const tokens = login();
    accessToken = tokens.access_token;     // ← module-level: GIỮ
    refreshToken = tokens.refresh_token;   // ← module-level: GIỮ
    tokenIssuedAtIter = 0;                 // ← module-level: GIỮ
  }

  // Mọi iter: gọi /me, nếu 401 -> refresh -> GHI ĐÈ module-level
  const { res, simulated_status } = callMe(accessToken);

  if (simulated_status === 401) {
    const tokens = refresh(refreshToken);
    accessToken = tokens.access_token;      // ← GHI ĐÈ token mới
    refreshToken = tokens.refresh_token;    // ← GHI ĐÈ token mới
    tokenIssuedAtIter = __ITER;             // ← update mốc cấp mới
  }

  doAction(accessToken);  // dùng token hiện tại (cũ hoặc vừa refresh)
}
```

**Trace execution cho VU=1 qua 20 iter**:

```text
Iter 0: login -> accessToken="A1", refreshToken="R1", issuedAt=0
        callMe("A1") -> 200
        doAction("A1") -> OK

Iter 1-9: callMe("A1") -> 200 -> OK
          (token chưa expire)

Iter 10: callMe("A1") -> 401 (token expired, đã qua TTL)
         refresh("R1") -> accessToken="A2", refreshToken="R2"
         ↑ GHI ĐÈ biến module-level
         callMe("A2") -> 200 (verify refresh OK)
         doAction("A2") -> OK

Iter 11-19: callMe("A2") -> 200 -> OK
            (token mới chưa expire)
```

> **Tại sao token không mất sau khi refresh?** Cùng cơ chế case 01:
> module-level variables GIỮ qua iter — refresh ghi đè giá trị mới
> lên CÙNG biến, iter sau đọc được token mới. Xem
> [case 01 / Per-VU state](./01_user-journey-replay.md#per-vu-state).

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


## Đọc dashboard real-time charts cho case 04

Run thật đã verify bằng wrapper:

```powershell
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:K6_CLOUD_HOST = "http://localhost:18080"
.\run-with-summary.ps1 .\examples\per-vu-iterations\pvi-04-session-lifecycle.js
```

Run đã verify:

```text
run #23
percentile_source = k6_summary

VUS = 10
ITERS_PER_VU = 20
total_iterations = 10 × 20 = 200
```

Summary quan trọng:

```text
iterations.............: 200
http_reqs..............: 430
login_count............: 10
refresh_count..........: 10
failed_after_refresh...: 0
checks_succeeded.......: 100.00%  20 out of 20
checks_failed..........: 0.00%    0 out of 20
http_req_failed........: 0.00%

http_req_duration avg..: 13.83ms
http_req_duration p95..: 55.31ms
http_req_duration p99..: 365.61ms
http_req_duration max..: 367.86ms
```

Request breakdown:

| Endpoint | Count | Vì sao có số này? |
| --- | ---: | --- |
| `auth_me` | 210 | 200 lần check session + 10 lần retry sau refresh |
| `user_action` | 200 | 1 action mỗi iteration |
| `refresh` | 10 | 1 lần refresh mỗi VU khi token expire |
| `login` | 10 | 1 login mỗi VU ở đầu lifecycle |
| Tổng | 430 | đúng bằng `summary http_reqs` |

Đọc nhanh:

```text
- Workload đủ: 200/200 iterations
- Session lifecycle đúng: 10 login + 10 refresh + 0 fail sau refresh
- HTTP sạch: 0 fail
- Checks sạch: 20/20 pass
=> Run PASS cho mục tiêu auth/session.
```

Điểm học quan trọng:

```text
http_reqs không cần bằng iterations.
```

Case này có nhiều request trong cùng lifecycle, nên:

```text
200 iterations -> 430 HTTP requests
```

### 1. Overview có 3 chart cần đọc

| Chart | Câu hỏi trong session lifecycle test | Không dùng để kết luận gì? |
| --- | --- | --- |
| Response time | login/refresh có gây latency spike không? | không tự chứng minh token mới dùng được |
| Execution timeline | login/refresh/action tạo request load theo thời gian ra sao? | không tự phân biệt token cũ/mới đúng sai |
| VUs vs iter/s | có hoàn thành đủ 200 session action không? | không tự chứng minh refresh contract đúng |

Một cách đọc nhanh:

```text
Response time      -> auth/session endpoint nhanh chậm ra sao
Execution timeline -> 430 request phân bổ qua các bucket như nào
VUs vs iter/s      -> 200 iteration hoàn thành đủ chưa
Custom metrics     -> 10 login, 10 refresh, 0 fail sau refresh
```

### Chart 1 — Response time

Chart debug:

```text
Debug JSON: response-time
```

Run #23:

| Metric | Giá trị | Cách đọc |
| --- | ---: | --- |
| buckets | 6 | run có 6 bucket response-time |
| total samples | 430 | đúng bằng `summary http_reqs` |
| weighted avg | 13.83ms | đa số request auth/action rất nhanh |
| summary p95 | 55.31ms | 95% request dưới ~56ms |
| summary p99 | 365.61ms | một nhóm rất nhỏ request chậm hơn |
| summary max | 367.86ms | request chậm nhất |
| bucket p95 peak | 367.62ms | bucket chứa request auth/session chậm nhất |
| bucket max peak | 367.86ms | max chart khớp max summary |

Đọc thực tế:

```text
- avg thấp: flow chính chạy nhanh
- p95 thấp: phần lớn user action/auth check ổn
- p99/max ~366-368ms: có vài request auth/session chậm hơn
- không có fail sau refresh, nên spike này không phải correctness bug
```

#### Cách phân tích sâu chart Response time

Với session lifecycle, câu hỏi không chỉ là “có chậm không”, mà là:

```text
refresh xảy ra giữa lifecycle có làm user bị gián đoạn không?
```

Đọc chart theo 4 bước:

```text
1. p95 có tăng mạnh ở đoạn refresh không?
2. nếu có spike, spike đó có đi kèm failed_after_refresh > 0 không?
3. login/refresh endpoint có max cao bất thường không?
4. iteration vẫn hoàn thành đủ 200 không?
```

Run #23:

```text
failed_after_refresh = 0
checks_failed = 0
iterations = 200
```

nên kết luận:

```text
Có tail latency nhỏ ở một vài request, nhưng refresh flow vẫn đúng.
User không bị đá ra sau khi token expire.
```

Shape cần cảnh giác:

| Shape | Nghĩa có thể có |
| --- | --- |
| p95 spike đúng lúc refresh + `failed_after_refresh > 0` | token refresh hỏng hoặc token mới chưa usable |
| login max cao ở đầu run | auth service/cold start cần kiểm tra |
| avg thấp nhưng `failed_after_refresh > 0` | request nhanh nhưng contract sai |
| iterations thiếu | lifecycle chưa chạy đủ để token expire/refresh |

### Chart 2 — Execution timeline

Chart debug:

```text
Debug JSON: execution-timeline
```

Run #23:

| Bucket | VUs | HTTP reqs | Iterations | Ý nghĩa |
| --- | ---: | ---: | ---: | --- |
| 1 | 10 | 4 | 0 | vài request đầu rơi trước khi iteration hoàn thành |
| 2 | 10 | 106 | 40 | login/auth/action bắt đầu ổn định |
| 3 | 10 | 94 | 50 | throughput session action cao |
| 4 | 10 | 112 | 44 | có thêm refresh/auth activity |
| 5 | 10 | 94 | 46 | lifecycle tiếp tục ổn định |
| 6 | 10 | 20 | 20 | tail hoàn thành nốt iterations |

Kiểm tổng:

```text
sum(httpReqs) = 4 + 106 + 94 + 112 + 94 + 20 = 430 = summary http_reqs ✓
sum(iterations) = 40 + 50 + 44 + 46 + 20 = 200 = summary iterations ✓
```

Đọc thực tế:

```text
- VUs giữ ổn định 10 trong active window
- HTTP reqs cao hơn iterations vì mỗi iteration có nhiều request auth/action
- bucket đầu có HTTP reqs nhưng chưa có iteration hoàn chỉnh là bình thường
```

Vì sao bucket đầu có request nhưng chưa có iteration?

```text
iteration chỉ được count khi default function chạy xong.
HTTP request xảy ra bên trong iteration trước.
Nếu request rơi vào bucket 1 nhưng iteration kết thúc ở bucket 2,
thì chart sẽ thấy HTTP trước, iterations sau.
```

### Batch 1 giây / time bucket đọc như nào?

Mỗi bucket là một lát thời gian. Với case 04:

```text
http_reqs trong bucket      = login + auth_me + refresh + user_action request
iterations trong bucket     = số lifecycle step hoàn thành
response-time trong bucket  = latency của request thuộc bucket đó
```

Vì flow có nhiều endpoint, không được kỳ vọng:

```text
http_reqs == iterations
```

Điều đúng là:

```text
sum(httpReqs) = 430
sum(iterations) = 200
```

Chi tiết cơ chế bucket xem case 01.

### Chart 3 — VUs vs iter/s

Chart debug:

```text
Debug JSON: vus-vs-iterations
```

Run #23:

| Bucket | Observed VUs | Actual iter/s | HTTP reqs | Ý nghĩa |
| --- | ---: | ---: | ---: | --- |
| 1 | 10 | 0 | 4 | request đầu trước khi iter hoàn thành |
| 2 | 10 | 40 | 106 | login/auth/action bắt đầu nhiều |
| 3 | 10 | 50 | 94 | throughput tốt |
| 4 | 10 | 44 | 112 | có refresh/auth overhead |
| 5 | 10 | 46 | 94 | tiếp tục ổn định |
| 6 | 10 | 20 | 20 | tail hoàn thành nốt work |

Kiểm tổng:

```text
sum(Actual iter/s) = 40 + 50 + 44 + 46 + 20 = 200 = summary iterations ✓
sum(httpReqs) = 430 = summary http_reqs ✓
```

Chart này chứng minh:

```text
10 VU đã chạy đủ 200 lifecycle iterations.
```

Chart này KHÔNG tự chứng minh:

```text
refresh token mới dùng được sau khi expire.
```

Câu đó phải đọc ở:

```text
refresh_count = 10
failed_after_refresh = 0
checks_fails = 0
```

### 2. Tab Executor / Execution

Case 04 dùng `per-vu-iterations` nhưng vì mỗi VU chạy 20 actions, VU line
thường ổn định hơn các case rất ngắn:

```text
10 VUs active -> mỗi VU chạy 20 lifecycle actions -> dừng khi đủ quota
```

Tab Executor dùng để kiểm:

```text
- configured VUs = 10
- observed VUs quanh 10 trong active window
- không có dropped/interrupted iterations
- final iterations = 200
```

Nếu tail có VU giảm nhẹ, đó là bình thường khi một số VU hoàn thành quota
sớm hơn. Không kết luận session bug từ VU tail; session bug phải nhìn
`failed_after_refresh`.

### 3. `metrics_push_count` khác `pointCount` — không phải bug

Với run ngắn, số push metrics và số point chart có thể khác nhau. Đây là bình
thường vì dashboard gom/merge/fill theo time bucket.

Verify đúng:

```text
sum chart httpReqs = 430
sum chart iterations = 200
```

### 4. Endpoint debug series theo metric

Các metric hữu ích:

```text
GET http://localhost:13001/v1/tests/23/series?metric=http_reqs
GET http://localhost:13001/v1/tests/23/series?metric=iterations
GET http://localhost:13001/v1/tests/23/series?metric=http_req_duration
GET http://localhost:13001/v1/tests/23/series?metric=login_count
GET http://localhost:13001/v1/tests/23/series?metric=refresh_count
GET http://localhost:13001/v1/tests/23/series?metric=failed_after_refresh
```

Nếu custom counter series thiếu, dùng tab Custom metrics hoặc summary output.

### 5. Checklist đọc biểu đồ case 04

| Bước | Câu hỏi | Kết quả run #23 |
| --- | --- | --- |
| 1 | `iterations == 200`? | 200 ✓ |
| 2 | `http_reqs == 430`? | 430 ✓ |
| 3 | `login_count == 10`? | 10 ✓ |
| 4 | `refresh_count == 10`? | 10 ✓ |
| 5 | `failed_after_refresh == 0`? | 0 ✓ |
| 6 | request breakdown sum = 430? | 210+200+10+10=430 ✓ |
| 7 | chart `httpReqs` sum = 430? | 4+106+94+112+94+20=430 ✓ |
| 8 | chart `iterations` sum = 200? | 40+50+44+46+20=200 ✓ |
| 9 | có spike refresh gây fail không? | không, checks pass |

### Cách chốt từ summary -> 3 chart

| Bước | Nhìn ở đâu | Kết luận run #23 |
| --- | --- | --- |
| Workload | summary + VUs vs iter/s | đủ 200/200 lifecycle actions |
| Session contract | custom metrics | 10 login, 10 refresh, 0 fail sau refresh |
| HTTP health | summary + Response time | 0 fail, p95 thấp |
| Request mix | request breakdown | 430 request đúng flow auth/session |
| Execution shape | Execution timeline | 10 VU ổn định, bucket sums khớp summary |
| Final verdict | tổng hợp | PASS: session lifecycle đúng, user không bị logout đột ngột |

## Kết luận thực tế: đọc output này thì team auth quyết định gì?

Mục tiêu nghiệp vụ: xác nhận **vòng đời session** đúng — token hết hạn
giữa chừng thì refresh tự động THÀNH CÔNG, user không bị đá ra đăng nhập
lại. Đây là trải nghiệm "đang dùng app thì bị logout đột ngột" mà case
này phải chặn.

Nhắc lại kỳ vọng: 10 login + 10 refresh + 0 fail sau refresh, tổng 200 iter.

### Kịch bản A — refresh mượt: SESSION FLOW ĐÚNG

```text
login_count..........: 10
refresh_count........: 10
failed_after_refresh.: 0
iterations...........: 200
```

Kết luận thực tế:

```text
- 10 login (1/user) + 10 refresh (1/user khi token expire ở iter 10)
- 0 fail sau refresh -> token mới luôn dùng được ngay
- user chạy đủ 20 thao tác không bị gián đoạn dù token hết hạn giữa chừng
=> QUYẾT ĐỊNH: session lifecycle OK, refresh flow an toàn.
   User dùng app liên tục không bị logout đột ngột.
```

### Kịch bản B — failed_after_refresh > 0: REFRESH HỎNG (đá user ra)

```text
login_count..........: 10
refresh_count........: 10
failed_after_refresh.: 7        (> 0!)
```

Kết luận thực tế:

```text
- Refresh chạy (10 lần) nhưng 7 user sau refresh vẫn gọi /me thất bại
- nghĩa là token mới KHÔNG hợp lệ -> user bị 401 tiếp -> phải re-login
- đây là bug "đang dùng app bị logout giữa chừng" -> mất giỏ hàng, mất form
=> QUYẾT ĐỊNH: chặn release. Báo dev: refresh cấp token sai
   (token mới chưa kịp propagate? cache cũ? refresh trả token nhưng
   server chưa nhận?). Đây đúng bug mà test 1-lần-per-user KHÔNG bắt được
   vì phải chạy QUA mốc expire mới lộ.
```

### Kịch bản C — refresh_count ≠ 10: TTL SAI

```text
login_count..........: 10
refresh_count........: 0         (KHÔNG refresh lần nào!)
failed_after_refresh.: 0
```

Kết luận thực tế:

```text
- 0 refresh nghĩa là token KHÔNG expire trong 20 iter -> TTL quá dài
- test không thực sự kiểm tra được refresh flow -> "pass" này VÔ NGHĨA
- (hoặc ngược lại refresh_count=40 -> token expire quá nhanh -> phiền user)
=> QUYẾT ĐỊNH: chưa kết luận được gì về refresh. Chỉnh TTL test data để
   token expire đúng quanh iter 10, chạy lại. Pass mà không refresh lần nào
   là "false pass" — flow chính chưa được chạm tới.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 10 login, 10 refresh, 0 fail | session flow đúng | release |
| failed_after_refresh > 0 | refresh cấp token sai | chặn, user bị logout |
| refresh_count = 0 | token không expire (TTL dài) | chỉnh TTL, chạy lại |
| refresh_count quá cao | token expire quá nhanh | chỉnh TTL, phiền user |
| login_count > 10 | có user phải re-login | điều tra vì sao mất session |

Điểm cốt lõi: bug này **chỉ lộ khi 1 user chạy QUA mốc token expire** rồi
tiếp tục thao tác. Test 1 lần/user (iter < TTL) sẽ luôn pass mà không bao
giờ chạm refresh. Vì per-vu cho mỗi user chạy đủ 20 iter liên tục trên
cùng session, mốc expire ở iter 10 chắc chắn xảy ra — đó là điều kiện
cần để verify refresh.

## Mở rộng

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
