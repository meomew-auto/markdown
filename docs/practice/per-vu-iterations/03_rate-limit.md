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

**Code thật từ file pvi-03-rate-limit.js**:

```js
// ───── Module-level scope (GIỮ qua 150 lần spam) ─────
let userToken = null;

// ───── Trong default() ─────
export default function () {
  if (__ITER === 0) {
    userToken = `user-token-${__VU}`;
    // ↑ module-level: GHI ở iter 0, ĐỌC ở iter 1-149
  }

  const res = http.get(`${BASE_URL}/api/sim/products`, {
    headers: { "Authorization": `Bearer ${userToken}` },
    tags: { name: "rate_limit_test", iter: String(__ITER) },
  });

  if (res.status === 200) count200.add(1);
  else if (res.status === 429) count429.add(1);
}
```

**Trace execution cho VU=1 qua 150 iter**:

```text
Iter 0:   userToken = "user-token-1"     ← GHI module-level
          req#1  với token "user-token-1" -> 200

Iter 50:  userToken VẪN = "user-token-1" ← ĐỌC TỪ MODULE-LEVEL
          req#51 với token "user-token-1" -> 200

Iter 100: req#101 -> 200 (vẫn OK, chưa vượt ngưỡng 100)
Iter 101: req#102 -> 429 (VƯỢT NGƯỠNG!)
          header "Retry-After" có mặt -> ✓
Iter 149: req#150 -> 429

→ 100 × 200, 50 × 429 -> đúng SLA 100 req/phút
→ token KHÔNG ĐỔI suốt 150 req -> bộ đếm server cho token này
   tăng liên tục -> hit ngưỡng
```

> **Tại sao token không mất sau 150 lần spam?** Cùng cơ chế case 01:
> module-level variable GIỮ qua iter. Xem
> [case 01 / Per-VU state](./01_user-journey-replay.md#per-vu-state).

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


## Đọc dashboard real-time charts cho case 03

Ví dụ dưới đây lấy từ run thật sau khi backend rate-limit đã được fix và chạy
bằng wrapper:

```powershell
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:K6_CLOUD_HOST = "http://localhost:18080"
.\run-with-summary.ps1 .\examples\per-vu-iterations\pvi-03-rate-limit.js
```

Run đã verify:

```text
run #30
exit = 0
pushed = true
finished = true
percentile_source = k6_summary

VUS = 5
ITERS_PER_VU = 150
total_iterations = 5 × 150 = 750
```

Summary quan trọng:

```text
iterations.............: 750
http_reqs..............: 750
count_200..............: 500
count_429..............: 250
checks_succeeded.......: 100.00%  250 out of 250
checks_failed..........: 0.00%    0 out of 250
http_req_failed........: 33.33%   250 out of 750

http_req_duration p95..: 95.49ms
http_req_duration p99..: 99.04ms
http_req_duration max..: 103.44ms
```

Request breakdown:

| Endpoint / status | Count | Ý nghĩa |
| --- | ---: | --- |
| `rate_limit_test` `200` | 500 | 100 request đầu của mỗi user được cho qua |
| `rate_limit_test` `429` | 250 | 50 request cuối của mỗi user bị throttle đúng kỳ vọng |

Đọc nhanh:

```text
- Workload đủ: 750/750 requests
- Rate-limit đúng: 500 OK + 250 throttled
- 250 response 429 đều có Retry-After nên checks pass
- http_req_failed = 33.33% là expected vì k6 tính 429 là failed HTTP
=> Run PASS theo mục tiêu rate-limit.
```

Đừng nhầm điểm này:

```text
http_req_failed 33.33% KHÔNG phải business failure trong case 03.
```

Lý do:

```text
250 / 750 request phải trả 429
k6 mặc định xem status >= 400 là failed
nhưng nghiệp vụ lại mong 429 để chứng minh limiter hoạt động
```

Vì vậy verdict của case 03 dựa vào:

```text
count_200 = 500
count_429 = 250
checks_fails = 0
```

không dựa vào raw `http_req_failed` một mình.

### 1. Overview có 3 chart cần đọc

| Chart | Câu hỏi trong rate-limit audit | Không dùng để kết luận gì? |
| --- | --- | --- |
| Response time | limiter trả 200/429 nhanh hay có spike? | không tự chứng minh quota đúng |
| Execution timeline | 5 user spam request phân bổ theo thời gian ra sao? | không phân biệt 200 với 429 nếu chỉ nhìn tổng req |
| VUs vs iter/s | đã spam đủ 750 iteration chưa? | không tự chứng minh có Retry-After header |

Một cách đọc nhanh:

```text
Response time      -> limiter có xử lý nhanh không
Execution timeline -> 5 VU tạo load như nào
VUs vs iter/s      -> có đủ 750 request không
Custom metrics     -> 500 OK + 250 429 có đúng không
Checks             -> 429 có Retry-After không
```

### Chart 1 — Response time

Chart debug:

```text
Debug JSON: response-time
```

Run #30:

| Metric | Giá trị | Cách đọc |
| --- | ---: | --- |
| buckets | 5 | run ngắn, dashboard render 5 bucket |
| total samples | 750 | đúng bằng `summary http_reqs` |
| weighted avg | 28.86ms | request 200/429 xử lý rất nhanh |
| summary p95 | 95.49ms | p95 authoritative cuối test |
| summary p99 | 99.04ms | tail vẫn quanh 100ms |
| summary max | 103.44ms | request chậm nhất vẫn thấp |
| bucket p95 peak | ~103.68ms | bucket tệ nhất vẫn quanh 100ms |
| bucket max peak | ~103.44ms | không có latency spike lớn |

Đọc thực tế:

```text
- latency thấp và bị chặn quanh ~100ms
- không có spike nhiều giây
- limiter quyết định 200/429 nhanh
```

Kết luận:

```text
Chart response-time cho thấy rate limiter không tạo latency bất thường.
Nhưng rate limit đúng hay sai vẫn phải nhìn count_200/count_429.
```

#### Cách phân tích sâu chart Response time

Với rate-limit test, chart latency trả lời câu hỏi:

```text
khi user spam vượt quota, backend có trả quyết định nhanh không?
```

Các shape cần chú ý:

| Shape | Nghĩa có thể có |
| --- | --- |
| p95 thấp cả run | limiter check nhanh, không gây queueing |
| p95 tăng mạnh sau khi bắt đầu 429 | limiter/counter backend có thể bị nghẽn |
| max cao nhưng count_429 đúng | business đúng nhưng limiter có tail latency |
| latency đẹp nhưng count_429 sai | limiter nhanh nhưng logic quota sai |

Run #30 thuộc nhóm tốt:

```text
count_200/count_429 đúng
checks 429 header pass
latency quanh 100ms
```

### Chart 2 — Execution timeline

Chart debug:

```text
Debug JSON: execution-timeline
```

Run #30:

| Bucket | VUs | HTTP reqs | Iterations | Ý nghĩa |
| --- | ---: | ---: | ---: | --- |
| 1 | 5 | 55 | 55 | bắt đầu spam với 5 user |
| 2 | 5 | 110 | 110 | request rate tăng |
| 3 | 5 | 133 | 133 | steady spam |
| 4 | 5 | 134 | 134 | steady spam |
| 5 | 5 | 318 | 318 | nhiều iteration kết thúc dồn ở tail |

Kiểm tổng:

```text
sum(httpReqs) = 55 + 110 + 133 + 134 + 318 = 750 = summary http_reqs ✓
sum(iterations) = 55 + 110 + 133 + 134 + 318 = 750 = summary iterations ✓
```

Đọc thực tế:

```text
- 5 VUs giữ ổn định trong active window
- mỗi iteration = 1 GET, nên HTTP reqs và iterations trùng nhau theo bucket
- chart chứng minh test đã spam đủ 750 request
```

Điểm dễ nhầm:

```text
Execution timeline chỉ thấy tổng request/iteration.
Nó không cho biết bucket nào là 200, bucket nào là 429 nếu không xem breakdown/tag.
```

Muốn kết luận limiter đúng, phải kết hợp với:

```text
count_200 = 500
count_429 = 250
checks_fails = 0
```

### Batch 1 giây / time bucket đọc như nào?

Mỗi point là một time bucket, không phải một request riêng lẻ:

```text
http_reqs  -> số request trong bucket
iterations -> số iteration hoàn thành trong bucket
vus        -> VU gauge/filled value của bucket
```

Vì case 03 có 1 request/iteration:

```text
http_reqs per bucket ≈ iterations per bucket
```

Nhưng ở các case nhiều request/iteration, hai series này sẽ khác. Chi tiết cơ
chế bucket xem case 01, phần “Batch 1 giây / time bucket được tính như nào?”.

### Chart 3 — VUs vs iter/s

Chart debug:

```text
Debug JSON: vus-vs-iterations
```

Run #30:

| Bucket | Observed VUs | Actual iter/s | HTTP reqs | Ý nghĩa |
| --- | ---: | ---: | ---: | --- |
| 1 | 5 | 55 | 55 | bắt đầu workload |
| 2 | 5 | 110 | 110 | throughput tăng |
| 3 | 5 | 133 | 133 | 5 user spam ổn định |
| 4 | 5 | 134 | 134 | 5 user spam ổn định |
| 5 | 5 | 318 | 318 | hoàn thành nốt quota 150/user |

Kiểm tổng:

```text
sum(Actual iter/s) = 750 = summary iterations ✓
sum(httpReqs) = 750 = summary http_reqs ✓
```

Chart này chứng minh:

```text
5 user đã gửi đủ 750 request.
```

Chart này KHÔNG chứng minh:

```text
rate limit đã chặn đúng 250 request.
```

Câu đó chỉ được trả lời bởi custom counters:

```text
count_200 = 500
count_429 = 250
```

### 2. Tab Executor / Execution

Với `per-vu-iterations`, case 03 có shape ổn định hơn case 02 vì mỗi VU chạy
150 iteration rất nhanh và đều:

```text
5 VUs active -> mỗi VU chạy 150 request -> kết thúc khi đủ quota
```

Điều cần nhìn ở Executor tab:

```text
- configured VUs = 5
- observed VUs giữ quanh 5 trong active window
- không có dropped_iterations
- total iterations cuối cùng = 750
```

Nếu VU line giảm ở cuối, đó thường là tail bình thường: VU đã hoàn thành đủ
150 request. Không được kết luận thiếu tải nếu summary vẫn đủ 750.

### 3. `metrics_push_count` khác `pointCount` — không phải bug

Dashboard có thể render 5 bucket trong khi backend metrics push count là số
khác. Đây không phải bug. Với rate-limit test, kiểm đúng là:

```text
sum chart httpReqs = 750
sum chart iterations = 750
```

không phải:

```text
pointCount == metrics_push_count
```

### 4. Endpoint debug series theo metric

Các endpoint debug hữu ích:

```text
GET http://localhost:13001/v1/tests/30/series?metric=http_reqs
GET http://localhost:13001/v1/tests/30/series?metric=iterations
GET http://localhost:13001/v1/tests/30/series?metric=http_req_duration
GET http://localhost:13001/v1/tests/30/series?metric=count_200
GET http://localhost:13001/v1/tests/30/series?metric=count_429
```

Nếu custom counter series không hiển thị đầy đủ, dùng tab Custom metrics hoặc
summary/threshold output để đọc `count_200` và `count_429`.

### 5. Checklist đọc biểu đồ case 03

| Bước | Câu hỏi | Kết quả run #30 |
| --- | --- | --- |
| 1 | `iterations == 750`? | 750 ✓ |
| 2 | `http_reqs == 750`? | 750 ✓ |
| 3 | `count_200 == 500`? | 500 ✓ |
| 4 | `count_429 == 250`? | 250 ✓ |
| 5 | `checks_fails == 0`? | 0 ✓ |
| 6 | `http_req_failed ≈ 33.33%` có expected không? | expected vì 429 ✓ |
| 7 | sum chart `httpReqs == 750`? | 55+110+133+134+318=750 ✓ |
| 8 | sum chart `iterations == 750`? | 55+110+133+134+318=750 ✓ |
| 9 | VUs giữ quanh 5? | 5 ✓ |

### Cách chốt từ summary -> 3 chart

| Bước | Nhìn ở đâu | Kết luận run #30 |
| --- | --- | --- |
| Workload | summary + VUs vs iter/s | đủ 750/750 request |
| Rate-limit contract | custom metrics | 500 OK + 250 throttled đúng |
| Retry-After contract | checks | 250/250 check pass |
| HTTP failed raw | summary | 33.33% expected vì 429 |
| Latency shape | Response time | p95 quanh 95ms, không spike lớn |
| Execution shape | Execution timeline | 5 VU spam ổn định, tổng bucket khớp summary |
| Final verdict | tổng hợp | PASS: per-user rate limit hoạt động đúng |

## Kết luận thực tế: đọc output này thì team API quyết định gì?

Mục tiêu nghiệp vụ: xác nhận **rate limit per-user** đúng SLA "100
req/phút mỗi user", và quan trọng nhất — **limit đếm RIÊNG từng user**,
không phải gộp chung (user A spam không được làm user B bị chặn oan).

Nhắc lại kỳ vọng: mỗi user 100×200 + 50×429, tổng 500 OK + 250 throttled.

### Kịch bản A — đúng SLA: LIMIT HOẠT ĐỘNG ĐÚNG

```text
count_200..........: 500
count_429..........: 250
checks "429 has Retry-After": 100%
iterations.........: 750
```

Kết luận thực tế:

```text
- Mỗi user đúng 100 OK rồi mới bị chặn -> SLA "100 req/phút" chính xác
- 250 lần 429 đều có Retry-After -> client biết khi nào thử lại được
- 5 user × cùng pattern -> limit đếm ĐỘC LẬP từng user (không gộp)
=> QUYẾT ĐỊNH: rate limit đạt SLA, an toàn để bật production.
   (http_req_failed ~33% là 429 mong đợi, KHÔNG phải lỗi — xem lưu ý trên.)
```

### Kịch bản B — count_200 > 500: LIMIT QUÁ LỎNG

```text
count_200..........: 640        (> 500!)
count_429..........: 110
```

Kết luận thực tế:

```text
- Có user vượt 100 req mà vẫn được 200 -> limit không chặn đúng ngưỡng
- vd limit thực tế đang là ~128 req thay vì 100 -> SLA sai
- nguy cơ: 1 user spam có thể làm quá tải backend / lách quota tính tiền
=> QUYẾT ĐỊNH: chưa bật. Báo team chỉnh ngưỡng counter về đúng 100.
   (cửa sổ tính sai? counter reset sớm? off-by-one ở so sánh >=  vs >?)
```

### Kịch bản C — count_429 quá cao / lệch giữa user: LIMIT GỘP CHUNG

```text
count_200..........: 300        (< 500)
count_429..........: 450        (> 250)

Chia theo user (đọc tag/log):
  user-1: 200 OK, user-2: 60 OK, user-3..5: ~13 OK mỗi user
```

Kết luận thực tế:

```text
- Tổng OK chỉ 300, và phân bố LỆCH giữa các user
- user đầu "ăn" hết quota, user sau bị 429 dù chưa spam đủ 100
- => limit đang đếm GỘP CHUNG cho cả hệ thống, KHÔNG tách theo user
- đây là bug nghiêm trọng: user vô tội bị chặn vì user khác spam
=> QUYẾT ĐỊNH: chặn. Báo dev: rate limit key phải bound theo user_id/token,
   không phải global counter. Đây đúng cái per-vu sinh ra để phát hiện —
   vì mỗi VU = 1 user cố định, lệch phân bố lộ ra ngay.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 500 OK + 250 429, đều theo user | SLA đúng, tách theo user | bật production |
| count_200 > 500 | limit quá lỏng | chỉnh ngưỡng về 100 |
| 429 thiếu Retry-After | client không biết chờ bao lâu | sửa header |
| OK lệch nhiều giữa user | limit gộp chung (bug) | bound key theo user |
| tổng req ≠ 750 | test chưa chạy đủ | sửa count, chạy lại |

Điểm cốt lõi: **429 ở đây là KẾT QUẢ MONG ĐỢI, không phải lỗi**. Đừng
nhìn `http_req_failed=33%` mà tưởng test fail. Phải nhìn `count_200` /
`count_429` theo từng user. Vì per-vu cố định 5 user × 150 req, nếu limit
tách đúng thì phân bố phải đều — lệch là bug "gộp chung".

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
