# Case 06: Retry and failover

> **Case ID:** `lb-06-retry-failover`
> **Script:** `06-retry-failover.js`
> **Profile:** `full-no-cdn`
> **Workload:** 1 VU, 1 iteration
> **Proof:** Nginx retry mechanism biến upstream 503 thành client 200 thông qua failover sang stable origin

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [LB capability được chứng minh](#2-lb-capability-được-chứng-minh)
3. [Vì sao phải test ở LB layer](#3-vì-sao-phải-test-ở-lb-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Nginx/LB mechanism deep-dive](#6-nginxlb-mechanism-deep-dive)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / headers](#8-key-signals--headers)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output -> decision scenarios](#11-4-output---decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist trước khi chạy](#13-checklist-trước-khi-chạy)
14. [4-5 Variations với code mẫu](#14-4-5-variations-với-code-mẫu)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh nghiệp vụ

Hãy hình dung bạn là kỹ sư vận hành (SRE) cho một nền tảng thanh toán trực tuyến. Hệ thống của bạn xử lý khoảng 500 giao dịch mỗi phút vào giờ cao điểm. Kiến trúc như sau:

```text
Mobile App / Web Client
        |
        v
   API Gateway (Nginx)
        |
        +----> Payment Processor Primary (port 3000)
        |
        +----> Payment Processor Secondary (port 3001)
```

Vào lúc 14:32:15, Primary processor gặp lỗi -- một panic trong code xử lý khuyến mãi khiến nó trả về HTTP 503 Service Unavailable cho mọi request. Nếu không có retry/failover mechanism, điều gì sẽ xảy ra?

```text
14:32:15.100 - Client A gửi $50 thanh toán -> Primary -> 503 -> Client thấy lỗi
14:32:15.150 - Client B gửi $120 thanh toán -> Primary -> 503 -> Client thấy lỗi
14:32:15.200 - Client C gửi $35 thanh toán -> Primary -> 503 -> Client thấy lỗi
...
```

Mỗi 503 là một giao dịch thất bại. Mỗi giao dịch thất bại là doanh thu mất đi. Mỗi giây trôi qua, thiệt hại tăng lên.

Nhưng nếu Nginx được cấu hình retry/failover:

```text
14:32:15.100 - Client A gửi $50 thanh toán
               -> Primary: 503 (lỗi!)
               -> Nginx phát hiện 503, retry trên Secondary
               -> Secondary: 200 OK (giao dịch thành công!)
               -> Client A thấy 200 OK, hoàn toàn không biết có lỗi xảy ra
```

Đây chính là "seamless failover" -- người dùng cuối không hề biết có sự cố. Họ vẫn thấy giao dịch thành công. Doanh thu không bị mất. Đội SRE có thời gian để sửa Primary mà không có áp lực "mọi giao dịch đang fail".

### 1.2 Ba tình huống failover điển hình trong thực tế

**Tình huống A -- Crash loop trên một upstream instance:**

```text
Một instance của products-service vừa được deploy phiên bản mới.
Phiên bản mới có bug khiến process crash ngay sau khi start.
Kubernetes restart container, nhưng nó crash lại -- crash loop.

Nginx health check phát hiện instance này unhealthy sau 3 lần fail liên tiếp.
Các request tiếp theo được route sang instance còn lại (healthy).
Người dùng không bị ảnh hưởng.
```

**Tình huống B -- Timeout do slow database query:**

```text
Một batch job vô tình lock bảng orders trong database.
Request đến order-service bị treo 30 giây chờ database.
Nginx proxy_read_timeout = 10 giây -> cắt request sau 10 giây.
Nginx retry trên một upstream khác (có thể kết nối đến database replica).
Request thứ hai thành công trong 200ms.
```

**Tình huống C -- Network partition tạm thời:**

```text
Switch mạng giữa Nginx và upstream A bị flap (lên-xuống liên tục).
Request qua upstream A bị connection refused hoặc timeout.
Nginx retry trên upstream B (kết nối qua switch khác).
Request thành công.
Khi switch ổn định trở lại, upstream A được dùng lại bình thường.
```

Cả ba tình huống đều dựa trên cùng một cơ chế: Nginx phát hiện upstream failure, retry trên upstream khác, và trả về thành công cho client. Case 06 chứng minh cơ chế này hoạt động.

### 1.3 Tại sao failover quan trọng hơn "chỉ cần fix bug"

Có một suy nghĩ phổ biến: "Nếu upstream bị lỗi, hãy sửa bug ở upstream. Đừng dùng failover để che giấu bug."

Suy nghĩ này đúng về mặt kỹ thuật (nên sửa root cause), nhưng sai về mặt vận hành. Trong thực tế:

| Thực tế vận hành | Vai trò của failover |
| --- | --- |
| Bug cần thời gian để tìm và sửa (vài giờ đến vài ngày) | Failover giữ hệ thống hoạt động trong thời gian đó |
| Có những lỗi không thể dự đoán trước (network partition, hardware failure) | Failover là lớp bảo vệ cuối cùng |
| Deploy luôn có rủi ro (ngay cả với canary và gradual rollout) | Failover là safety net cho deploy thất bại |
| Không thể đạt 100% uptime cho từng instance riêng lẻ | Failover cho phép đạt high availability qua redundancy |

Failover không phải là "che giấu bug" -- nó là **lớp bảo vệ cho phép bạn sửa bug mà không đánh đổi availability**.

---

## 2. LB capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh:

> **Nginx gateway phát hiện upstream failure (HTTP 503), tự động retry trên upstream dự phòng (stable origin), và trả về HTTP 200 cho client kèm theo tín hiệu `X-LB-Failover` xác nhận quá trình failover đã diễn ra.**

Cụ thể hơn, case chứng minh 4 khả năng con:

1. **Upstream failure detection**: Nginx nhận được HTTP 503 từ faulty origin và nhận biết đây là failure cần retry.
2. **Automatic retry với upstream khác**: Nginx không trả 503 cho client mà thử lại trên upstream tiếp theo trong group (stable origin).
3. **Transparent failover với client**: Client (k6) nhận được HTTP 200, hoàn toàn không thấy 503 -- failover trong suốt với client.
4. **Observable failover signal**: Dù client thấy 200, hệ thống vẫn để lại audit trail (`X-LB-Failover`, `role=stable` trong body) để đội vận hành biết failover đã xảy ra.

### 2.2 So sánh với các case LB khác

| Case | Test cái gì? | Failover? | Retry? |
| --- | --- | --- | --- |
| 01 -- Entry smoke | Request đến được Nginx | Không | Không |
| 03 -- Domain boundaries | Route đúng service | Không | Không |
| 05 -- Origin service mix | Route đúng dưới concurrent load | Không | Không |
| **06 -- Retry/failover** | **Retry khi upstream lỗi** | **Có** | **Có** |
| 07 -- Rate limit pressure | Shedding khi quá tải | Không | Không |
| 09 -- Passive outlier ejection | Tránh upstream lỗi sau khi phát hiện | Có (khác cơ chế) | Có (khác cơ chế) |
| 12 -- Slow origin timeout | Timeout thay vì treo | Không | Không |

Case 06 là case **duy nhất** trong series chứng minh retry mechanism **chủ động** của Nginx -- tức là Nginx chủ động thử lại trên upstream khác khi upstream đầu tiên trả về lỗi. Case 09 (outlier ejection) cũng liên quan đến xử lý upstream lỗi, nhưng dùng cơ chế khác: "né" upstream lỗi cho các request tương lai, thay vì retry ngay trong cùng một request.

### 2.3 Phân biệt retry (case 06) và ejection (case 09)

Đây là một điểm dễ nhầm lẫn. Hãy phân biệt rõ:

| | **Retry (case 06)** | **Passive ejection (case 09)** |
| --- | --- | --- |
| **Thời điểm** | Trong cùng một request | Qua nhiều request |
| **Cơ chế** | `proxy_next_upstream` | `health_check` + `fail_timeout` |
| **Trigger** | Upstream trả về status lỗi (503, timeout, error) | Số lần fail vượt ngưỡng (`max_fails`) |
| **Hành động** | Thử ngay upstream tiếp theo trong group | Đánh dấu upstream là `down` trong `fail_timeout` giây |
| **Client thấy** | 200 OK (nếu retry thành công) | 200 OK (request được route sang upstream healthy) |
| **Scope** | Per-request | Global -- ảnh hưởng tất cả request sau đó |
| **Nginx directive chính** | `proxy_next_upstream`, `proxy_next_upstream_tries` | `max_fails`, `fail_timeout` trong `upstream` block |

Case 06 test cột bên trái. Case 09 test cột bên phải.

---

## 3. Vì sao phải test ở LB layer

### 3.1 Đây là trách nhiệm của gateway, không phải application

Application code (trong từng microservice) có thể tự implement retry logic: gọi một service khác, nếu fail thì thử lại. Nhưng cách tiếp cận này có ba vấn đề:

| Vấn đề | Giải thích | LB giải quyết thế nào |
| --- | --- | --- |
| **Mỗi service phải tự code retry** | Duplicate logic, inconsistent behavior | Retry được config một lần trong Nginx, áp dụng cho tất cả upstream |
| **Không retry được nếu service chết hoàn toàn** | Code retry nằm trong service -- nếu service crash, không có gì chạy | Nginx là process riêng, không bị ảnh hưởng bởi upstream crash |
| **Client vẫn phải chờ** | Retry ở application layer nghĩa là client đã kết nối đến service lỗi, service đó retry, rồi mới trả về -- client chờ lâu hơn | Nginx retry ở tầng proxy, client không hề biết |

### 3.2 Đây là vấn đề của infrastructure layer

Retry/failover là một **infrastructure concern**, không phải application concern. Nó liên quan đến:

- **Network topology**: upstream nào có thể thay thế upstream nào?
- **Connection management**: giữ hay đóng connection khi retry?
- **Timeout budget**: tổng thời gian retry không được vượt quá client timeout.
- **Idempotency**: request nào an toàn để retry? (GET: có, POST: thường không, trừ khi có `proxy_next_upstream non_idempotent`)

Tất cả những quyết định này thuộc về infrastructure layer, và đó là lý do chúng được test ở LB layer.

### 3.3 Phân biệt trách nhiệm

```text
Application layer:   "Tôi cần gọi payment service. Nếu fail, tôi sẽ thử lại."
                     -> Vấn đề: service chết thì không ai retry.

LB layer:            "Mọi request qua tôi đến upstream. Nếu upstream fail,
                     tôi sẽ thử upstream khác trước khi báo lỗi cho client."
                     -> Đúng: Nginx là process riêng, luôn sống.

Client layer:        "Tôi gọi API. Tôi không cần biết có retry hay không."
                     -> Đúng: client thấy 200, failover trong suốt.
```

Case 06 test LB layer làm đúng vai trò của nó: che chắn client khỏi upstream failure.

---

## 4. Topology và precondition

### 4.1 Topology

```text
k6 (1 VU, 1 iteration)
  |
  | GET /api/lb/failover-demo
  | Host: localhost:80
  v
Nginx :80 (lb-app container)
  |
  | upstream lb_failover_group {
  |   server faulty-origin:3000;   # intentionally returns 503
  |   server stable-origin:3000;   # returns 200 with role=stable
  | }
  |
  | proxy_next_upstream http_503;
  | proxy_next_upstream_tries 2;
  |
  +---(1)---] faulty-origin:3000
  |          |
  |          +-- returns HTTP 503 Service Unavailable
  |          +-- body: { "role": "faulty", "status": "intentionally_failing" }
  |
  | Nginx sees 503 -> triggers retry
  |
  +---(2)---] stable-origin:3000
             |
             +-- returns HTTP 200 OK
             +-- headers: X-LB-Failover: faulty->stable
             +-- body: { "role": "stable", "failover": true, "original_upstream": "faulty-origin" }
             |
             v
          Client receives 200 OK
```

### 4.2 Precondition

```powershell
# 1. Start stack với topology full-no-cdn
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2

# 2. Set BASE_URL
$env:BASE_URL = "http://localhost:80"

# 3. Verify faulty origin đang hoạt động (trả về 503)
curl -s -o /dev/null -w "%{http_code}" http://localhost:80/api/lb/failover-demo
# Kỳ vọng: 200 (Nginx đã retry và trả về từ stable origin)
# KHÔNG kỳ vọng: 503 (nếu retry không hoạt động)

# 4. Verify stable origin trả về đúng role
curl -s http://localhost:80/api/lb/failover-demo | jq ".role"
# Kỳ vọng: "stable"

# 5. Verify failover header có mặt
curl -s -I http://localhost:80/api/lb/failover-demo | findstr "X-LB-Failover"
# Kỳ vọng: X-LB-Failover: faulty->stable
```

### 4.3 Cấu trúc upstream group

Upstream group cho case này được thiết kế đặc biệt:

```nginx
upstream lb_failover_group {
    server faulty-origin:3000  max_fails=0;   # Không bao giờ bị đánh dấu down
    server stable-origin:3000  max_fails=0;   # Không bao giờ bị đánh dấu down

    # KHÔNG dùng health check active -- faulty origin luôn được thử đầu tiên
}

server {
    listen 80;

    location /api/lb/failover-demo {
        proxy_pass http://lb_failover_group;
        proxy_next_upstream http_503;          # Retry khi upstream trả 503
        proxy_next_upstream_tries 2;           # Thử tối đa 2 upstream
        proxy_intercept_errors off;            # Không intercept lỗi -- để retry xử lý

        proxy_set_header X-Upstream-Service "lb-stable-origin";
        proxy_set_header X-Request-ID $request_id;
    }
}
```

Điểm đặc biệt trong config này:

- `max_fails=0` cho cả hai server: ngăn Nginx đánh dấu faulty origin là `down` sau khi nó trả 503. Nếu không có `max_fails=0`, sau vài lần fail, Nginx sẽ ngừng gửi request đến faulty origin, và case này không thể tái tạo được failover scenario.
- `proxy_next_upstream http_503`: chỉ định rằng HTTP 503 là một điều kiện kích hoạt retry. Các điều kiện khác (mặc định: `error timeout`) cũng được áp dụng.
- `proxy_next_upstream_tries 2`: giới hạn số lần thử -- nếu cả hai upstream đều fail, Nginx sẽ trả lỗi cho client.

### 4.4 Environment variables

Case này không có biến môi trường đặc thù. Chỉ cần `BASE_URL` được set:

```powershell
$env:BASE_URL = "http://localhost:80"
```

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `06-retry-failover.js` gồm 33 dòng, là một trong những script ngắn nhất trong series -- nhưng đừng để độ dài đánh lừa: nó chứng minh một trong những cơ chế quan trọng nhất của gateway.

```javascript
// (A) IMPORTS: 2 dòng
import { check } from 'k6';
import { assertLBResponse, lbCapabilityApis, requestLB, responseHeader } from './shared.js';

// (B) OPTIONS: 11 dòng
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { ... },
  tags: { ... },
};

// (C) DEFAULT FUNCTION: 14 dòng
export default function () { ... };
```

### 5.2 Phân tích từng dòng -- Phần A: Imports

```javascript
import { check } from 'k6';
```

`check` từ k6 core -- khác với `assertLBResponse` (dùng `check` bên trong). Case 06 cần `check` trực tiếp vì có 2 checks bổ sung không nằm trong `assertLBResponse`: `X-LB-Failover` header và `role` trong body.

```javascript
import { assertLBResponse, lbCapabilityApis, requestLB, responseHeader } from './shared.js';
```

Bốn function từ `shared.js`:

| Function | Vai trò | Dùng trong case 06 |
| --- | --- | --- |
| `assertLBResponse(res, api, label)` | 5 checks tiêu chuẩn (status, nginx, upstream, request-id, no-cache) | Có -- để xác nhận routing cơ bản |
| `lbCapabilityApis` | Object chứa các API endpoint cho LB capability tests | Có -- dùng `lbCapabilityApis.failoverDemo` |
| `requestLB(api, overrides)` | Gửi HTTP request đến Nginx gateway | Có -- gửi request đến `/api/lb/failover-demo` |
| `responseHeader(res, name)` | Đọc case-insensitive header từ response | Có -- dùng để đọc `X-LB-Failover` |

### 5.3 Phân tích từng dòng -- Phần B: Options

```javascript
export const options = {
  vus: 1,              // (a)
  iterations: 1,       // (b)
  thresholds: {
    checks: ['rate==1'],           // (c)
    http_req_failed: ['rate==0'],  // (d)
  },
  tags: {
    scenario: 'lb_retry_failover',  // (e)
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};
```

**(a) `vus: 1`** -- Chỉ cần 1 VU. Tại sao? Vì retry/failover là cơ chế per-request: một request đơn lẻ cũng phải được retry đúng. Không cần concurrent load để chứng minh cơ chế này. Nếu retry hoạt động cho 1 request, nó sẽ hoạt động cho mọi request (vì Nginx xử lý từng request độc lập).

**(b) `iterations: 1`** -- Một iteration chứa toàn bộ kịch bản: gửi request → expect failover → verify upstream thay đổi.

**(c-e)** (tiếp tục phân tích phía dưới)

##### Phân tích executor: vì sao dùng `per-vu-iterations` cho case này?

Config dùng bare form `vus=1, iterations=1` → `per-vu-iterations`.

**Yêu cầu của case:**

```text
1. Retry/failover proof: 1 request → fail → retry → upstream thay đổi
   → Sequence TUẦN TỰ: request 1 fail → verify retry → request 2 success
   → KHÔNG phải load test — là correctness proof của cơ chế failover

2. 1 VU, 1 iteration: toàn bộ kịch bản failover trong 1 lần default()
   → setup() bật fail mode, default() verify retry → upstream khác
   → Nhiều VU sẽ race: VU A verify retry, VU B cũng đang gửi → nhiễu
```

**So sánh executor:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **per-vu-iterations** (đang dùng) | ✅ **ĐÚNG** | 1 VU × 1 iter. Sequential failover proof. Deterministic. |
| shared-iterations | ⚠️ Kết quả giống | `vus=1` → output giống. |
| constant-vus | ❌ SAI | Cần `duration`. Case này là proof 1 lần, không cần sustained traffic. |
| constant-arrival-rate | ❌ SAI | Ép rate. Case này cần sequence, không cần rate. |
| ramping-vus | ❌ SAI | 1 VU ổn định, không ramp. |

**Key insight**: Retry/failover test = "1 request fail → retry → upstream
khác". Sequential proof, 1 lần đủ. `per-vu-iterations` với `vus=1, iterations=1`.

### 5.4 Phân tích từng dòng -- Phần C: Default function

**(b) `iterations: 1`** -- Chỉ chạy 1 iteration. Tương tự như trên: một lần demo là đủ để chứng minh. Đây là điểm khác biệt quan trọng với hầu hết các case khác (có nhiều iteration). Case 06 là "proof of mechanism", không phải "statistical validation".

**(c) `checks: ['rate==1']`** -- 100% checks phải pass. Với chỉ 1 request, threshold này cực kỳ nghiêm ngặt: nếu bất kỳ check nào fail, toàn bộ test fail. Không có chỗ cho "gần đúng".

**(d) `http_req_failed: ['rate==0']`** -- 0% HTTP failure. Đây là điểm mấu chốt: **client phải thấy 200**, mặc dù upstream đầu tiên trả về 503. Nếu `http_req_failed` > 0, nghĩa là Nginx đã không retry thành công -- failover thất bại.

**(e) `scenario: 'lb_retry_failover'`** -- Tag để filter trong dashboard.

### 5.4 Phân tích từng dòng -- Phần C: Default function

```javascript
export default function () {
  const api = lbCapabilityApis.failoverDemo;       // (1)
  const res = requestLB(api, {                      // (2)
    tags: {
      endpoint: api.name,
      lb_profile: 'full-no-cdn',
    },
  });

  assertLBResponse(res, api, 'lb failover demo');  // (3)
  check(res, {                                      // (4)
    'lb failover header present': (r) =>
      responseHeader(r, 'X-LB-Failover') === 'faulty->stable',
    'lb failover response is stable': (r) =>
      r.json('role') === 'stable',
  });
}
```

**(1) `lbCapabilityApis.failoverDemo`** -- API definition:

```javascript
// Trong shared.js:
failoverDemo: {
  name: 'lb_failover_demo',
  method: 'GET',
  path: '/api/lb/failover-demo',
  expected: 200,
  expectedUpstream: 'lb-stable-origin',
}
```

Điểm đáng chú ý: `expectedUpstream` là `'lb-stable-origin'` -- stable origin, KHÔNG phải faulty origin. Điều này phản ánh kỳ vọng: sau khi retry, request sẽ đến được stable origin. Nếu retry không hoạt động và request dừng ở faulty origin, check `upstream matches` sẽ fail vì faulty origin không phải là `lb-stable-origin`.

**(2) `requestLB(api, { tags })`** -- Gửi GET request đến `http://localhost:80/api/lb/failover-demo`. Tags `endpoint: api.name` (= `lb_failover_demo`) để phân loại trong dashboard.

**(3) `assertLBResponse(res, api, 'lb failover demo')`** -- 5 checks tiêu chuẩn:

| Check | Expected | Ý nghĩa trong case 06 |
| --- | --- | --- |
| status | 200 | Mặc dù faulty origin trả 503, client phải thấy 200 (từ stable origin) |
| served by nginx | nginx | Xác nhận retry được thực hiện bởi Nginx |
| upstream matches | `lb-stable-origin` | Xác nhận request cuối cùng đến stable origin (sau retry) |
| request id present | có | `X-Request-ID` có mặt trong response |
| no cache header | vắng mặt | Không có CDN interference |

**(4) `check(res, { ... })`** -- 2 checks bổ sung, đặc thù cho case 06:

**Check 6 -- `lb failover header present`:**
```javascript
responseHeader(r, 'X-LB-Failover') === 'faulty->stable'
```

Đây là **primary proof** của case này. Header `X-LB-Failover` với giá trị `faulty->stable` xác nhận rằng:
- Request ĐÃ ĐƯỢC gửi đến faulty origin trước (`faulty`)
- Nginx ĐÃ THỰC HIỆN retry (`->`)
- Request cuối cùng ĐÃ ĐẾN stable origin (`stable`)

Nếu thiếu header này, bạn không thể phân biệt giữa "retry đã xảy ra" và "request được gửi thẳng đến stable origin ngay từ đầu". Cả hai đều trả về 200 + `X-Upstream-Service: lb-stable-origin`, nhưng chỉ trường hợp đầu tiên chứng minh failover hoạt động.

**Check 7 -- `lb failover response is stable`:**
```javascript
r.json('role') === 'stable'
```

Body response chứa field `role` với giá trị `stable`. Đây là secondary proof: stable origin tự nhận mình là `stable`, xác nhận đây là response từ stable origin (không phải faulty origin giả mạo).

### 5.5 Tại sao chỉ 1 VU và 1 iteration?

Đây là câu hỏi thường gặp. Câu trả lời có 3 phần:

**Thứ nhất: Retry là cơ chế deterministic, không cần sample size.**

Retry mechanism của Nginx không phải là probabilistic (như weighted routing). Nếu Nginx được config để retry khi upstream trả 503, nó SẼ retry. Không có yếu tố ngẫu nhiên. Một request là đủ để chứng minh.

**Thứ hai: Retry không phụ thuộc vào concurrent load.**

Khác với case 05 (cần concurrent load để phát hiện contention issue), retry hoạt động giống hệt nhau dù có 1 request hay 1000 request đồng thời. Mỗi request được xử lý độc lập qua event loop của Nginx.

**Thứ ba: Debug dễ dàng hơn.**

Với 1 request, log rất sạch. Bạn có thể trace chính xác điều gì đã xảy ra:

```text
[debug] upstream: try #1 to faulty-origin:3000
[debug] upstream: faulty-origin:3000 returned 503
[debug] upstream: retry triggered (http_503)
[debug] upstream: try #2 to stable-origin:3000
[debug] upstream: stable-origin:3000 returned 200
[debug] upstream: final upstream = stable-origin:3000
```

Với 1000 request, log sẽ có 1000 dòng debug -- khó trace hơn nhiều.

### 5.6 So sánh sequential check và parallel check

Một điểm tinh tế trong script: `assertLBResponse` và `check` bổ sung được gọi tuần tự, không phải gộp chung. Tại sao?

```javascript
// Cách case 06 viết:
assertLBResponse(res, api, 'lb failover demo');    // 5 checks
check(res, {                                         // 2 checks bổ sung
  'lb failover header present': ...,
  'lb failover response is stable': ...,
});

// Thay vì gộp thành 7 checks trong một lần gọi check():
check(res, {
  'lb failover demo status': ...,
  'lb failover demo served by nginx': ...,
  'lb failover demo upstream matches': ...,
  'lb failover demo request id present': ...,
  'lb failover demo no cache header': ...,
  'lb failover header present': ...,
  'lb failover response is stable': ...,
});
```

Lý do: `assertLBResponse` là shared function được dùng bởi tất cả các case LB. Tách biệt 2 checks đặc thù của case 06 ra khỏi shared function giúp:
- `assertLBResponse` giữ được tính tổng quát (không bị "ô nhiễm" bởi logic đặc thù của một case).
- Dễ đọc: 5 checks cơ bản + 2 checks đặc thù, phân tách rõ ràng.
- Dễ maintain: nếu thay đổi `assertLBResponse`, không ảnh hưởng đến checks đặc thù của case 06.

---

## 6. Nginx/LB mechanism deep-dive

### 6.1 `proxy_next_upstream` -- Trái tim của retry mechanism

```nginx
proxy_next_upstream http_503;
```

Directive này định nghĩa các điều kiện kích hoạt retry. Giá trị mặc định là `error timeout`. Các giá trị có thể:

| Giá trị | Mô tả | Dùng trong case 06? |
| --- | --- | --- |
| `error` | Connection error (connection refused, connection reset, etc.) | Có (mặc định) |
| `timeout` | Upstream không trả lời trong `proxy_read_timeout` | Có (mặc định) |
| `http_503` | Upstream trả về HTTP 503 Service Unavailable | **Có -- đây là trigger chính** |
| `http_502` | Upstream trả về HTTP 502 Bad Gateway | Không |
| `http_504` | Upstream trả về HTTP 504 Gateway Timeout | Không |
| `http_403` | Upstream trả về HTTP 403 Forbidden | Không |
| `http_404` | Upstream trả về HTTP 404 Not Found | Không |
| `http_500` | Upstream trả về HTTP 500 Internal Server Error | Không |
| `non_idempotent` | Cho phép retry cả POST, PATCH, DELETE (mặc định chỉ retry GET, HEAD) | Không |
| `off` | Tắt retry hoàn toàn | Không |

Trong case 06, `http_503` được chỉ định tường minh (bên cạnh `error` và `timeout` mặc định). Faulty origin được thiết kế để trả về chính xác 503 để kích hoạt điều kiện này.

### 6.2 `proxy_next_upstream_tries` -- Retry budget

```nginx
proxy_next_upstream_tries 2;
```

Giới hạn tổng số lần thử (bao gồm cả lần đầu tiên). Với giá trị `2`:
- Lần 1: thử upstream đầu tiên (faulty-origin) -> 503
- Lần 2: thử upstream thứ hai (stable-origin) -> 200 -> dừng

Nếu set `proxy_next_upstream_tries 1`, retry bị vô hiệu hóa (chỉ thử đúng 1 lần).

Nếu set `proxy_next_upstream_tries 3` nhưng upstream group chỉ có 2 server, Nginx sẽ thử:
- Lần 1: faulty-origin -> 503
- Lần 2: stable-origin -> 200 -> dừng (không cần lần 3)

### 6.3 Cách Nginx chọn upstream server trong retry

Quy trình chọn upstream của Nginx (phiên bản rút gọn):

```text
1. Nhận request từ client
2. Chọn upstream server từ group:
   a. Dùng thuật toán đã cấu hình (mặc định: round-robin)
   b. Bỏ qua các server bị đánh dấu `down` (từ health check)
   c. Bỏ qua các server đã thử trong request này
3. Gửi request đến upstream đã chọn
4. Nhận response:
   a. Nếu response OK (200, 201, ...): trả về cho client -> DONE
   b. Nếu response match điều kiện retry (503, timeout, error):
      - Nếu còn server chưa thử VÀ tries chưa đạt giới hạn: quay lại bước 2
      - Nếu hết server HOẶC đạt giới hạn tries: trả lỗi cho client
```

Trong case 06, flow cụ thể:

```text
1. Request GET /api/lb/failover-demo
2. upstream group: [faulty-origin:3000, stable-origin:3000]
3. Chọn server: round-robin -> faulty-origin:3000 (lần đầu)
4. Gửi request -> faulty-origin:3000
5. Nhận response: HTTP 503
6. 503 match http_503 -> retry
7. tries=1 < 2 -> tiếp tục
8. Chọn server: round-robin -> stable-origin:3000 (server tiếp theo)
9. Bỏ qua faulty-origin:3000 (đã thử) -> chọn stable-origin:3000
10. Gửi request -> stable-origin:3000
11. Nhận response: HTTP 200 + X-LB-Failover: faulty->stable
12. 200 không match điều kiện retry -> trả về cho client -> DONE
```

### 6.4 Tại sao `max_fails=0` quan trọng

```nginx
upstream lb_failover_group {
    server faulty-origin:3000  max_fails=0;
    server stable-origin:3000  max_fails=0;
}
```

`max_fails` là số lần fail tối đa trong khoảng thời gian `fail_timeout` trước khi Nginx đánh dấu server là `down`. Mặc định: `max_fails=1`, `fail_timeout=10s`.

Nếu KHÔNG có `max_fails=0`:
```text
Request 1: faulty-origin -> 503 -> Nginx đánh dấu faulty-origin là DOWN trong 10s
Request 2 (trong 10s tiếp theo): Nginx bỏ qua faulty-origin, gửi thẳng đến stable-origin
                                  -> Không có failover! Request đi thẳng đến stable.
```

Điều này phá hỏng mục đích của case 06. Case này muốn chứng minh retry xảy ra **trong cùng một request**, không phải request sau được route sang server khác vì server đầu đã bị đánh dấu down.

Với `max_fails=0`, Nginx không bao giờ đánh dấu faulty-origin là down. Mỗi request mới đều thử faulty-origin trước, fail, và retry sang stable-origin -- chứng minh retry mechanism hoạt động cho MỌI request.

### 6.5 `proxy_next_upstream` vs `proxy_intercept_errors`

Có một directive khác dễ nhầm lẫn với retry:

```nginx
proxy_intercept_errors on;
error_page 503 /custom_503.html;
```

Directive này bắt lỗi từ upstream và trả về error page tùy chỉnh cho client. Nó KHÔNG retry -- nó thay đổi response body. Case 06 cần `proxy_intercept_errors off` (mặc định) để retry có thể hoạt động trước khi error được intercept.

### 6.6 Retry và idempotency

Một trong những cạm bẫy lớn nhất của retry là non-idempotent request:

```text
Client gửi: POST /api/sim/checkout { "amount": 100 }
Nginx gửi đến upstream A: POST /api/sim/checkout { "amount": 100 }
Upstream A: xử lý, trừ tiền, nhưng response bị timeout trước khi về Nginx
Nginx retry trên upstream B: POST /api/sim/checkout { "amount": 100 }
Upstream B: xử lý, trừ tiền LẦN THỨ HAI
Client bị trừ 200 thay vì 100!
```

Đây là lý do Nginx **mặc định không retry non-idempotent request** (POST, PATCH, DELETE). Chỉ khi có `proxy_next_upstream non_idempotent`, Nginx mới retry cả những method này.

Case 06 dùng GET request -- idempotent, an toàn để retry. Đây là lựa chọn thiết kế có chủ đích: case này muốn chứng minh retry mechanism, không muốn phải xử lý vấn đề idempotency.

### 6.7 Timeout budget trong retry

Một khía cạnh quan trọng khác của retry là **timeout budget**:

```text
Client timeout: 30 giây (client sẽ disconnect nếu không nhận response sau 30s)
Nginx gửi request 1: mất 10 giây -> timeout -> retry
Nginx gửi request 2: mất 25 giây -> thành công nhưng tổng 35 giây -> client đã disconnect!
```

Nginx không tự động tính toán timeout budget. Đây là trách nhiệm của người cấu hình:

```nginx
proxy_read_timeout 5s;           # Mỗi lần thử tối đa 5 giây
proxy_next_upstream_tries 3;     # Tối đa 3 lần thử
# Timeout budget tối đa: 5s * 3 = 15 giây
```

Trong case 06, timeout không phải là vấn đề vì cả faulty và stable origin đều phản hồi nhanh (vài ms). Nhưng trong production, đây là một yếu tố thiết kế quan trọng.

### 6.8 Sự khác biệt giữa retry và health check

Nhiều người nhầm lẫn giữa hai cơ chế:

| | **Retry (`proxy_next_upstream`)** | **Active Health Check (`health_check`)** |
| --- | --- | --- |
| **Khi nào chạy** | Trong lúc xử lý request | Định kỳ (vài giây một lần) |
| **Mục đích** | Cứu request hiện tại khỏi fail | Phát hiện upstream không healthy để tránh cho request tương lai |
| **Ảnh hưởng** | Request hiện tại | Tất cả request sau đó |
| **Phạm vi** | Per-request | Global server state |
| **Nginx module** | `ngx_http_proxy_module` | `ngx_http_upstream_hc_module` (commercial) hoặc `nginx_upstream_check` (open source third-party) |

Case 06 test retry. Health check là một chủ đề khác, được test gián tiếp qua case 09 (outlier ejection).

---

## 7. Request sequence flow

### 7.1 Timeline chi tiết của request duy nhất

```text
Time (ms)  |  Component         |  Event
-----------|--------------------|--------------------------------------------------
0.0        | k6 VU              |  Bắt đầu iteration
0.0        | k6 VU              |  lbCapabilityApis.failoverDemo -> GET /api/lb/failover-demo
0.1        | k6 VU              |  requestLB() -> mở TCP connection đến localhost:80
0.2        | k6 -> Nginx        |  TCP SYN
0.3        | Nginx -> k6        |  TCP SYN-ACK
0.4        | k6 -> Nginx        |  TCP ACK (connection established)
0.5        | k6 -> Nginx        |  HTTP request:
           |                    |    GET /api/lb/failover-demo HTTP/1.1
           |                    |    Host: localhost:80
           |                    |    User-Agent: k6/...
0.5        | Nginx              |  Parse HTTP request
0.6        | Nginx              |  Match location: /api/lb/failover-demo
0.6        | Nginx              |  Chọn upstream: lb_failover_group
0.7        | Nginx              |  Chọn server: round-robin -> faulty-origin:3000
0.7        | Nginx -> faulty    |  TCP connection đến faulty-origin:3000 (hoặc reuse keepalive)
0.8        | Nginx -> faulty    |  HTTP request:
           |                    |    GET /api/lb/failover-demo HTTP/1.1
           |                    |    X-Request-ID: abc123def456...
           |                    |    X-Forwarded-For: ...
           |                    |    X-Upstream-Service: lb-stable-origin
0.8-2.0    | faulty-origin      |  Xử lý: intentionally return 503
2.0        | faulty -> Nginx    |  HTTP response:
           |                    |    HTTP/1.1 503 Service Unavailable
           |                    |    Content-Type: application/json
           |                    |    {"role":"faulty","status":"intentionally_failing"}
2.1        | Nginx              |  Parse response: status = 503
2.1        | Nginx              |  Check proxy_next_upstream: http_503 -> MATCH -> retry!
2.1        | Nginx              |  Check proxy_next_upstream_tries: 1 < 2 -> continue
2.2        | Nginx              |  Chọn server tiếp theo (bỏ qua faulty): stable-origin:3000
2.2        | Nginx -> stable    |  TCP connection đến stable-origin:3000
2.3        | Nginx -> stable    |  HTTP request (identical to first attempt):
           |                    |    GET /api/lb/failover-demo HTTP/1.1
           |                    |    X-Request-ID: abc123def456...  (cùng ID với lần đầu)
2.3-3.5    | stable-origin      |  Xử lý: detect đây là failover request, tạo response
3.5        | stable -> Nginx    |  HTTP response:
           |                    |    HTTP/1.1 200 OK
           |                    |    X-LB-Failover: faulty->stable
           |                    |    Content-Type: application/json
           |                    |    {"role":"stable","failover":true,"original_upstream":"faulty-origin"}
3.6        | Nginx              |  Parse response: status = 200
3.6        | Nginx              |  Check proxy_next_upstream: 200 không match -> không retry
3.7        | Nginx              |  Finalize: upstream = stable-origin:3000, status = 200
3.7        | Nginx              |  Thêm response headers: X-Served-By: nginx, Server: nginx/...
3.8        | Nginx -> k6        |  HTTP response:
           |                    |    HTTP/1.1 200 OK
           |                    |    X-Served-By: nginx
           |                    |    Server: nginx/1.25
           |                    |    X-Upstream-Service: lb-stable-origin
           |                    |    X-Request-ID: abc123def456...
           |                    |    X-LB-Failover: faulty->stable
           |                    |    {"role":"stable","failover":true,...}
3.9-4.5    | k6                 |  Nhận response, parse headers và body
4.5-5.0    | k6                 |  assertLBResponse() -> 5 checks
5.0-5.5    | k6                 |  check() -> 2 checks bổ sung
5.5        | k6                 |  Tất cả 7 checks pass
5.5        | k6                 |  Iteration kết thúc
5.6        | k6                 |  Test hoàn thành -> exit 0
```

### 7.2 Sequence diagram (dạng text)

```text
k6 VU              NGINX                  FAULTY-ORIGIN        STABLE-ORIGIN
  |                  |                        |                    |
  |-- GET /api/lb/-->|                        |                    |
  |   failover-demo  |                        |                    |
  |                  |                        |                    |
  |                  |-- (1) GET /api/lb/ --->|                    |
  |                  |   failover-demo        |                    |
  |                  |                        |                    |
  |                  |                        |-- xử lý --        |
  |                  |                        |   intentionally    |
  |                  |                        |   return 503       |
  |                  |                        |                    |
  |                  |<--(2) 503 ------------|                    |
  |                  |   Service Unavailable  |                    |
  |                  |                        |                    |
  |                  |-- DETECT 503           |                    |
  |                  |-- RETRY decision       |                    |
  |                  |                        |                    |
  |                  |-- (3) GET /api/lb/ ------------------------>|
  |                  |   failover-demo                             |
  |                  |   (same X-Request-ID)                       |
  |                  |                                             |
  |                  |                        (đã bỏ qua)          |-- xử lý --
  |                  |                                             |   detect failover
  |                  |                                             |   return 200
  |                  |                                             |
  |                  |<--(4) 200 OK ------------------------------|
  |                  |   X-LB-Failover: faulty->stable             |
  |                  |   {"role":"stable",...}                     |
  |                  |                                             |
  |                  |-- FINALIZE: status=200                      |
  |                  |   upstream=stable-origin                    |
  |                  |                                             |
  |<-- 200 OK -------|                                             |
  |   X-LB-Failover: |                                             |
  |     faulty->stable                                            |
  |   role: stable    |                                             |
  |                  |                                             |
  |-- 7 checks PASS  |                                             |
```

### 7.3 Điều gì xảy ra nếu retry cũng fail?

Nếu stable-origin cũng trả về 503 (hoặc không có stable-origin), flow sẽ là:

```text
1. Request -> faulty-origin -> 503
2. Retry -> stable-origin -> 503 (cũng lỗi!)
3. proxy_next_upstream_tries = 2 -> đã hết budget
4. Nginx trả 503 cho client (từ upstream cuối cùng)
5. Client thấy 503
6. http_req_failed = 1 -> threshold rate==0 fail
7. checks fail vì status != 200 và upstream != lb-stable-origin
```

Kịch bản này xác nhận rằng Nginx chỉ retry trong giới hạn `proxy_next_upstream_tries`, không retry vô hạn.

---

## 8. Key signals / headers

### 8.1 Bảng signals cần verify

| Signal | Vị trí | Expected value | Ý nghĩa | Là primary proof? |
| --- | --- | --- | --- | --- |
| `status` | Response status line | `200` | Client không thấy lỗi -- failover trong suốt | Không (200 có thể đến từ route thẳng) |
| `X-Served-By` | Response header | `nginx` | Nginx đã xử lý request và retry | Không |
| `X-Upstream-Service` | Response header | `lb-stable-origin` | Request cuối cùng đến stable origin | Không (có thể route thẳng) |
| `X-Request-ID` | Response header | Chuỗi non-empty | Trace ID xuyên suốt quá trình retry | Không |
| `X-Cache` | Response header | **Vắng mặt** | Không CDN interference | Không |
| **`X-LB-Failover`** | **Response header** | **`faulty->stable`** | **FAILOVER ĐÃ XẢY RA** | **CÓ -- PRIMARY PROOF** |
| `role` (trong body) | Response body (JSON) | `"stable"` | Response đến từ stable origin | CÓ -- SECONDARY PROOF |
| `failover` (trong body) | Response body (JSON) | `true` | Stable origin xác nhận đây là failover request | CÓ (nếu có) |

### 8.2 Signal dependency chain

```text
                    ┌─────────────────────────────┐
                    │ X-LB-Failover: faulty->stable │ ← PRIMARY PROOF
                    │ (header do stable origin      │   Chứng minh retry đã xảy ra
                    │  hoặc Nginx thêm vào)         │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────v──────────────┐
                    │ role: "stable" (trong body)  │ ← SECONDARY PROOF
                    │ (stable origin tự nhận dạng) │   Xác nhận response từ stable
                    └──────────────┬──────────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            │                      │                      │
┌───────────v──────┐  ┌────────────v───────┐  ┌──────────v──────────┐
│ status: 200      │  │ X-Upstream-Service │  │ X-Served-By: nginx  │
│ (client thấy OK) │  │ : lb-stable-origin │  │ (Nginx xử lý)       │
└──────────────────┘  └────────────────────┘  └─────────────────────┘
```

**Luận điểm chứng minh**:
1. Nếu `X-LB-Failover: faulty->stable` CÓ MẶT -> retry đã xảy ra -> PASS.
2. Nếu `role: stable` CÓ MẶT -> response đến từ stable origin -> PASS.
3. Nếu `status: 200` -> client không thấy lỗi -> PASS.
4. Nếu thiếu `X-LB-Failover` nhưng vẫn có 200 + `X-Upstream-Service: lb-stable-origin` -> KHÔNG THỂ kết luận retry đã xảy ra. Có thể request được route thẳng đến stable origin.

Đây chính là lý do `X-LB-Failover` là **primary proof** -- nó là signal duy nhất không thể bị "giả mạo" bởi route thẳng.

### 8.3 Cách đọc `X-LB-Failover` header

Format: `<nguồn_lỗi>-><đích_failover>`

| Giá trị | Ý nghĩa |
| --- | --- |
| `faulty->stable` | Retry từ faulty origin sang stable origin -- expected |
| `faulty->faulty` | Retry nhưng vẫn đến faulty origin (cấu hình sai -- chỉ có 1 server trong group) |
| `timeout->stable` | Retry sau timeout (không phải 503) |
| `<vắng mặt>` | Không có retry -- hoặc retry không được cấu hình, hoặc request đầu tiên đã thành công |

### 8.4 Các header "vô hình" -- những gì client KHÔNG thấy

Một phần quan trọng của failover là những gì client **không** thấy:

| Header/signal | Client có thấy không? | Ý nghĩa |
| --- | --- | --- |
| `X-Upstream-Status` (từ lần thử đầu) | **Không** | Nginx không forward 503 từ faulty origin cho client |
| Connection error log entry | **Không** | Error log của Nginx ghi lại retry, nhưng client không biết |
| `X-Upstream-Addr` của faulty origin | **Không** | Client chỉ thấy upstream cuối cùng (stable) |
| Latency của lần thử đầu (2ms đến faulty) | **Không** | Client chỉ thấy tổng latency (~4ms) |

Điều này tạo ra một tình huống thú vị: **client hoàn toàn không biết có lỗi đã xảy ra**. Đây vừa là sức mạnh (seamless failover) vừa là rủi ro (che giấu vấn đề). Đó là lý do observability (log, metrics, tracing) ở Nginx layer cực kỳ quan trọng -- nếu không có monitoring, đội vận hành sẽ không biết failover đang xảy ra.

---

## 9. Pass/fail criteria

### 9.1 PASS criteria

Tất cả 7 checks phải pass (rate=1) và HTTP failure phải = 0:

| # | Check | Expected | Diagnostic nếu fail |
| --- | --- | --- | --- |
| P1 | `lb failover demo status` | `200` | Nginx không retry thành công; client thấy 503 |
| P2 | `lb failover demo served by nginx` | `nginx` | Request không qua Nginx |
| P3 | `lb failover demo upstream matches` | `lb-stable-origin` | Route sai; hoặc Nginx trả response từ faulty origin |
| P4 | `lb failover demo request id present` | Có | Thiếu `proxy_set_header X-Request-ID` |
| P5 | `lb failover demo no cache header` | Vắng mặt | Đang chạy qua CDN (sai topology) |
| P6 | `lb failover header present` | `faulty->stable` | Retry không xảy ra; hoặc stable origin không thêm header |
| P7 | `lb failover response is stable` | `role === 'stable'` | Response không đến từ stable origin |

### 9.2 FAIL criteria

| # | Dấu hiệu | Diagnostic | Nguyên nhân khả dĩ |
| --- | --- | --- | --- |
| F1 | `status = 503`, `http_req_failed > 0` | Xem error log Nginx | Retry không hoạt động: thiếu `proxy_next_upstream http_503`, hoặc stable origin cũng lỗi |
| F2 | `status = 200` nhưng `X-Upstream-Service = "lb-faulty-origin"` (hoặc khác `lb-stable-origin`) | Xem upstream config | Route thẳng đến stable không hoạt động; Nginx trả response từ faulty origin (faulty không thực sự trả 503?) |
| F3 | `status = 200`, upstream đúng, nhưng `X-LB-Failover` vắng mặt | Xem code stable origin | Stable origin không thêm header failover; hoặc retry không xảy ra (request đi thẳng đến stable) |
| F4 | `status = 200`, upstream đúng, failover header có, nhưng `role != "stable"` | Xem body response | Stable origin trả về sai body -- có thể đang trả về body của faulty origin |
| F5 | `X-Cache` có mặt | Xem topology | Đang dùng `full` thay vì `full-no-cdn` |
| F6 | `http_req_duration` quá cao (>5s) | Xem retry config | `proxy_read_timeout` quá dài; hoặc stable origin chậm |
| F7 | `X-Request-ID` giống nhau giữa hai lần thử nhưng khác với ID trong response | Xem Nginx config | `$request_id` thay đổi giữa hai lần thử (behavior không nhất quán) |

---

## 10. Cách chạy + output mẫu

### 10.1 Cách chạy mặc định

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 06-retry-failover
```

Hoặc chạy trực tiếp bằng k6:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\lb\06-retry-failover.js
```

### 10.2 Output mẫu (PASS)

```text
     script: 06-retry-failover.js
     profile: full-no-cdn
     vus: 1
     iterations: 1

     ✓ lb failover demo status
     ✓ lb failover demo served by nginx
     ✓ lb failover demo upstream matches
     ✓ lb failover demo request id present
     ✓ lb failover demo no cache header
     ✓ lb failover header present
     ✓ lb failover response is stable

     checks.....................: 100.00% ✓ 7  ✗ 0
     http_req_failed............: 0.00%  ✓ 1  ✗ 0
     http_req_duration..........: avg=4.5ms min=4.5ms med=4.5ms max=4.5ms p(90)=4.5ms p(95)=4.5ms
     http_reqs..................: 1
     iterations.................: 1
     vus........................: 1

     Exit: 0
```

**Phân tích**:
- 7/7 checks pass (1 request x 7 checks).
- `http_req_failed = 0%`: client thấy 200 OK, mặc dù faulty origin trả 503.
- `http_req_duration = 4.5ms`: tổng thời gian bao gồm cả lần thử đầu (503) + lần thử hai (200). 4.5ms là rất nhanh -- faulty origin phản hồi 503 gần như ngay lập tức.
- Exit 0: PASS.

### 10.3 Output mẫu (FAIL -- retry không hoạt động)

```text
     ✗ lb failover demo status
       ↳  expected: 200, got: 503
     ✓ lb failover demo served by nginx
     ✗ lb failover demo upstream matches
       ↳  expected: lb-stable-origin, got: lb-faulty-origin
     ✗ lb failover demo request id present
     ✗ lb failover demo no cache header
     ✗ lb failover header present
       ↳  expected: faulty->stable, got: (empty)
     ✗ lb failover response is stable
       ↳  cannot parse JSON

     checks.....................: 14.29% ✓ 1  ✗ 6
     http_req_failed............: 100.00% ✓ 0  ✗ 1
     http_req_duration..........: avg=2.1ms
     http_reqs..................: 1

     Exit: 99
```

**Phân tích**:
- Chỉ 1/7 checks pass (`served by nginx`).
- Status client thấy là 503 -- Nginx không retry, trả thẳng lỗi cho client.
- `X-Upstream-Service = lb-faulty-origin` -- request dừng ở faulty origin.
- `X-LB-Failover` vắng mặt -- không có failover.
- Nguyên nhân: `proxy_next_upstream http_503` chưa được thêm vào Nginx config.

### 10.4 Cách debug khi fail

```powershell
# 1. Gọi trực tiếp endpoint và xem toàn bộ response headers
curl -v http://localhost:80/api/lb/failover-demo 2>&1

# 2. Kiểm tra Nginx error log (nơi ghi lại retry)
docker logs <nginx-container> 2>&1 | findstr "upstream"

# Kỳ vọng thấy dòng như:
# [error] upstream: "http://faulty-origin:3000/api/lb/failover-demo" returned 503,
#         trying next upstream

# 3. Kiểm tra faulty origin có đang trả 503 không
curl -v http://localhost:8088/api/lb/failover-demo 2>&1
# (port 8088 là direct-to-nginx, bypass port 80 mapping)
# Nếu faulty origin trả 200 thay vì 503 -> faulty origin config sai

# 4. Kiểm tra Nginx config có proxy_next_upstream không
docker exec <nginx-container> cat /etc/nginx/nginx.conf | findstr "proxy_next_upstream"
```

---

## 11. 4 output -> decision scenarios

### Scenario A: Tất cả checks pass, exit 0

```text
Exit: 0
Checks: 7/7 (100%)
HTTP failed: 0%
X-LB-Failover: faulty->stable (có mặt)
role: stable
```

**Kết luận**: Retry/failover hoạt động chính xác. Nginx phát hiện 503 từ faulty origin, retry trên stable origin, và trả 200 cho client.

**Hành động**: Không cần action. Chuyển sang case 07.

### Scenario B: Status 200, upstream đúng, nhưng `X-LB-Failover` vắng mặt

```text
Exit: 99
Checks: 5/7 pass
HTTP failed: 0%
status: 200
X-Upstream-Service: lb-stable-origin
X-LB-Failover: (vắng mặt)
```

**Kết luận**: Request đến được stable origin và trả 200, nhưng **không có bằng chứng retry đã xảy ra**. Có hai khả năng:
1. Retry không hoạt động, request được route thẳng đến stable origin (faulty origin đã bị đánh dấu down từ trước).
2. Retry hoạt động nhưng stable origin không thêm `X-LB-Failover` header.

**Hành động**:
1. Kiểm tra Nginx error log -- có dòng "trying next upstream" không?
2. Kiểm tra Nginx config -- có `max_fails=0` cho faulty origin không?
3. Restart stack để reset trạng thái upstream, chạy lại ngay lập tức.

### Scenario C: Status 503, HTTP failed 100%

```text
Exit: 99
Checks: ~1/7 pass
HTTP failed: 100%
status: 503
X-Upstream-Service: lb-faulty-origin (hoặc vắng mặt)
```

**Kết luận**: Retry không hoạt động. Nginx nhận 503 từ faulty origin và trả thẳng cho client.

**Hành động**:
1. Kiểm tra Nginx config: có `proxy_next_upstream http_503` không?
2. Kiểm tra Nginx config: có `proxy_next_upstream_tries 2` (hoặc >1) không?
3. Kiểm tra upstream group: có cả faulty-origin và stable-origin không?
4. Kiểm tra stable-origin có đang chạy không: `docker ps | findstr "stable"`.

### Scenario D: Status 200, nhưng `role = "faulty"`

```text
Exit: 99
Checks: 6/7 pass (fail "response is stable")
HTTP failed: 0%
status: 200
X-Upstream-Service: lb-stable-origin
X-LB-Failover: faulty->stable
role: faulty
```

**Kết luận**: Retry đã xảy ra (có `X-LB-Failover`), nhưng response body đến từ faulty origin, không phải stable origin. Đây là tình huống lạ: có thể stable origin forward request đến faulty origin và trả về response của faulty origin.

**Hành động**: Kiểm tra code của stable origin -- nó có đang forward request không? Stable origin phải tự tạo response với `role: "stable"`, không forward.

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "200 OK không có nghĩa là không có lỗi"

Đây là nghịch lý trung tâm của case 06. Khi bạn thấy:

```text
HTTP 200 OK
X-Upstream-Service: lb-stable-origin
```

Bạn có thể nghĩ "mọi thứ bình thường". Nhưng thực tế, một upstream (faulty origin) vừa trả về 503. Nginx đã "nuốt" lỗi này và trả về thành công.

**Bài học**: Đừng chỉ nhìn status code. Luôn kiểm tra `X-LB-Failover` (và các header tương tự) để biết có failover đã xảy ra không. Monitoring dashboard nên có alert khi tỉ lệ failover tăng đột biến -- đó là dấu hiệu có upstream đang gặp vấn đề.

### 12.2 Nghịch lý 2: "Retry làm tăng latency, nhưng lại cải thiện availability"

Retry làm request chậm hơn (thêm thời gian gọi upstream thứ hai). Trong case 06, latency tăng từ ~2ms (nếu gọi thẳng stable) lên ~4.5ms (gọi faulty trước, rồi mới stable).

```text
Không retry:  client -> stable -> 200  (2ms, nhưng nếu stable lỗi -> fail)
Có retry:     client -> faulty -> 503 -> stable -> 200  (4.5ms, luôn thành công)
```

Đây là trade-off kinh điển giữa latency và availability. Trong hầu hết hệ thống, tăng 2.5ms latency để đổi lấy availability là hoàn toàn xứng đáng.

### 12.3 Nghịch lý 3: "max_fails=0 vừa là requirement, vừa là rủi ro"

Case 06 cần `max_fails=0` để faulty origin không bị đánh dấu down, đảm bảo mỗi request đều trigger retry. Nhưng trong production, `max_fails=0` là **cực kỳ nguy hiểm**:

```text
Production với max_fails=0:
  Mỗi request -> faulty origin -> 503 -> retry -> stable origin -> 200
  Mỗi request chịu 2.5ms latency phụ thêm
  Faulty origin vẫn nhận toàn bộ traffic (dù trả 503) -> lãng phí tài nguyên
```

Trong production, bạn muốn `max_fails=1` hoặc `max_fails=2` để Nginx nhanh chóng ngừng gửi request đến upstream lỗi. Nhưng điều này có nghĩa case 06 sẽ không thể chạy được trên production config.

### 12.4 Nghịch lý 4: "Retry chỉ an toàn cho GET, nhưng production cần retry cả POST"

Như đã đề cập trong section 6.6, Nginx mặc định không retry POST/PATCH/DELETE. Nhưng trong thực tế, nhiều system cần retry cả POST -- ví dụ: thanh toán, tạo đơn hàng, gửi email.

Có ba cách giải quyết:

1. **`proxy_next_upstream non_idempotent`**: Cho phép Nginx retry mọi method. Rủi ro: duplicate operation.
2. **Idempotency key**: Application thêm idempotency key vào request. Nếu retry xảy ra, server dùng key để phát hiện duplicate.
3. **Không retry ở Nginx, để client retry**: Client nhận lỗi, tự retry với exponential backoff.

Case 06 không giải quyết vấn đề này (vì dùng GET), nhưng đây là điều người học cần hiểu khi áp dụng retry vào production.

### 12.5 Nghịch lý 5: "Một request là đủ để chứng minh, nhưng không đủ để validate"

Case 06 dùng 1 VU, 1 iteration -- đủ để chứng minh retry mechanism hoạt động. Nhưng nó KHÔNG đủ để validate rằng retry hoạt động **ổn định** trong production:

- 1 request không kiểm tra được behavior khi connection pool cạn kiệt.
- 1 request không kiểm tra được race condition trong retry logic.
- 1 request không kiểm tra được memory leak khi retry xảy ra liên tục.

Để validate toàn diện, cần thêm stress test (xem Variation 3).

---

## 13. Checklist trước khi chạy

### 13.1 Stack readiness

- [ ] Stack đã được start với `-TargetLayer full-no-cdn -ScaleApp 2`
- [ ] `docker ps` cho thấy nginx, faulty-origin, stable-origin đều running
- [ ] `curl http://localhost:80/` trả về 200 (xác nhận Nginx hoạt động)

### 13.2 Upstream health check

- [ ] Faulty origin đang trả 503: `curl -s -o /dev/null -w "%{http_code}" http://localhost:80/api/lb/failover-demo` (qua Nginx)
- [ ] Sau khi Nginx retry, client thấy 200 (xác nhận retry hoạt động)
- [ ] Stable origin trả về `role: stable`: `curl -s http://localhost:80/api/lb/failover-demo | jq ".role"`
- [ ] Failover header có mặt: `curl -s -I http://localhost:80/api/lb/failover-demo | findstr "X-LB-Failover"`

### 13.3 Nginx config verification

- [ ] `proxy_next_upstream http_503` có trong location `/api/lb/failover-demo`
- [ ] `proxy_next_upstream_tries 2` (hoặc >1) có trong config
- [ ] `max_fails=0` cho faulty-origin (để tránh bị đánh dấu down)
- [ ] Upstream group có cả faulty-origin và stable-origin
- [ ] `proxy_intercept_errors` là `off` (mặc định) -- không intercept lỗi trước khi retry

### 13.4 Environment

- [ ] `$env:BASE_URL = "http://localhost:80"`
- [ ] Không có biến môi trường nào khác can thiệp vào behavior

### 13.5 k6 readiness

- [ ] `k6 version` hoạt động
- [ ] Script tồn tại: `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\06-retry-failover.js`
- [ ] `shared.js` tồn tại và export đúng các function cần thiết

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Multi-iteration để đo reliability

```javascript
import { check } from 'k6';
import { assertLBResponse, lbCapabilityApis, requestLB, responseHeader } from './shared.js';

export const options = {
  vus: 1,
  iterations: 100,                        // Chạy 100 lần
  thresholds: {
    checks: ['rate==1'],                  // Tất cả 700 checks (100 x 7) phải pass
    http_req_failed: ['rate==0'],         // Không request nào fail
    http_req_duration: ['p(95)<10'],      // p95 dưới 10ms
  },
  tags: {
    scenario: 'lb_retry_failover_reliability',
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};

export default function () {
  const api = lbCapabilityApis.failoverDemo;
  const res = requestLB(api, {
    tags: { endpoint: api.name, lb_profile: 'full-no-cdn' },
  });

  assertLBResponse(res, api, 'lb failover demo');
  check(res, {
    'lb failover header present': (r) =>
      responseHeader(r, 'X-LB-Failover') === 'faulty->stable',
    'lb failover response is stable': (r) =>
      r.json('role') === 'stable',
  });
}
```

**Mục đích**: Xác nhận retry hoạt động ổn định qua 100 request, không có request nào bị "rò rỉ" 503. Mỗi request đều phải trigger retry và trả về 200.

### Variation 2: Test retry với timeout (thay vì 503)

```javascript
import { check } from 'k6';
import { assertLBResponse, requestLB, responseHeader } from './shared.js';

// Giả định có endpoint /api/lb/timeout-demo: faulty origin treo 30 giây,
// Nginx timeout sau 5 giây, retry trên stable origin.
const timeoutRetryApi = {
  name: 'lb_timeout_retry_demo',
  method: 'GET',
  path: '/api/lb/timeout-demo',
  expected: 200,
  expectedUpstream: 'lb-stable-origin',
};

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    // Không set http_req_duration threshold vì timeout có thể mất vài giây
  },
};

export default function () {
  const res = requestLB(timeoutRetryApi, {
    tags: { endpoint: 'lb_timeout_retry_demo' },
  });

  assertLBResponse(res, timeoutRetryApi, 'lb timeout retry');
  check(res, {
    'lb failover after timeout': (r) =>
      responseHeader(r, 'X-LB-Failover') === 'timeout->stable',
    'lb failover response is stable': (r) =>
      r.json('role') === 'stable',
    'lb retry latency reasonable': (r) =>
      r.timings.duration < 15000,  // Tổng thời gian dưới 15 giây
  });
}
```

**Mục đích**: Test retry được kích hoạt bởi timeout (không phải HTTP 503). Kiểm tra rằng `proxy_read_timeout` hoạt động và Nginx không treo vô hạn.

### Variation 3: Stress test retry dưới concurrent load

```javascript
import { check, sleep } from 'k6';
import { envInt, envString } from '../shared/common.js';
import { assertLBResponse, lbCapabilityApis, requestLB, responseHeader } from './shared.js';

const RETRY_STRESS_VUS = envInt('RETRY_STRESS_VUS', 20);
const RETRY_STRESS_DURATION = envString('RETRY_STRESS_DURATION', '15s');

export const options = {
  vus: RETRY_STRESS_VUS,
  duration: RETRY_STRESS_DURATION,
  thresholds: {
    checks: ['rate>0.99'],              // Cho phép 1% fail dưới stress
    http_req_failed: ['rate<0.01'],     // <1% HTTP failure
    http_req_duration: ['p(95)<50'],    // p95 dưới 50ms (cao hơn bình thường vì retry)
  },
  tags: {
    scenario: 'lb_retry_failover_stress',
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};

export default function () {
  const api = lbCapabilityApis.failoverDemo;
  const res = requestLB(api, {
    tags: { endpoint: api.name },
  });

  assertLBResponse(res, api, 'lb failover stress');
  check(res, {
    'lb failover header present': (r) =>
      responseHeader(r, 'X-LB-Failover') === 'faulty->stable',
    'lb failover response is stable': (r) =>
      r.json('role') === 'stable',
  });
  sleep(0.05);  // Nghỉ ngắn để không quá tải
}
```

**Mục đích**: Kiểm tra retry mechanism dưới concurrent load (20 VUs). Xác nhận rằng retry không bị "gãy" khi nhiều request cùng lúc cần retry.

### Variation 4: Test retry với nhiều cấp failover (chain)

```javascript
import { check } from 'k6';
import { requestLB, responseHeader } from './shared.js';

// Giả định upstream group có 3 server:
// faulty-1 -> 503, faulty-2 -> 502, stable -> 200
const chainRetryApi = {
  name: 'lb_chain_retry_demo',
  method: 'GET',
  path: '/api/lb/chain-retry-demo',
  expected: 200,
  expectedUpstream: 'lb-stable-origin',
};

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export default function () {
  const res = requestLB(chainRetryApi, {
    tags: { endpoint: 'chain_retry' },
  });

  check(res, {
    'chain retry status 200': (r) => r.status === 200,
    'chain retry final upstream stable': (r) =>
      responseHeader(r, 'X-Upstream-Service') === 'lb-stable-origin',
    'chain retry path was faulty-1->faulty-2->stable': (r) =>
      responseHeader(r, 'X-LB-Failover') === 'faulty-1->faulty-2->stable',
  });
}
```

**Mục đích**: Test retry chain qua nhiều upstream. Xác nhận Nginx thử từng upstream theo thứ tự cho đến khi tìm thấy upstream thành công.

### Variation 5: Test rằng POST không được retry (negative test)

```javascript
import { check } from 'k6';
import { requestLB, responseHeader } from './shared.js';

// Gọi cùng endpoint nhưng dùng POST
// Kỳ vọng: Nginx KHÔNG retry (vì POST không idempotent), client thấy 503
const postFailoverApi = {
  name: 'lb_failover_post_demo',
  method: 'POST',
  path: '/api/lb/failover-demo',
  body: { test: true },
  expected: 503,              // Kỳ vọng thấy 503 vì retry không xảy ra cho POST
  expectedUpstream: 'lb-faulty-origin',
};

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    // http_req_failed KHÔNG set rate==0 vì 503 là expected
  },
};

export default function () {
  const res = requestLB(postFailoverApi, {
    tags: { endpoint: 'post_failover_test' },
  });

  check(res, {
    'post request sees 503 (no retry for non-idempotent)': (r) =>
      r.status === 503,
    'post request upstream is faulty (not retried)': (r) =>
      responseHeader(r, 'X-Upstream-Service') === 'lb-faulty-origin',
    'no failover header (no retry occurred)': (r) =>
      responseHeader(r, 'X-LB-Failover') === '',
  });
}
```

**Mục đích**: Chứng minh rằng Nginx **không** retry POST request (đúng như thiết kế). Đây là negative test -- xác nhận rằng behavior mặc định (không retry non-idempotent) hoạt động.

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Dùng retry thay cho health check

```text
SAI: "Tôi không cần health check vì Nginx sẽ retry khi upstream lỗi."
```

**Vấn đề**: Retry chỉ giải quyết được vấn đề **trong lúc request đang xử lý**. Nó không ngăn được việc gửi request đến upstream đã biết là lỗi. Nếu không có health check:

- Mỗi request đầu tiên luôn fail (lần thử đầu vào faulty origin).
- Tổng latency tăng vì mỗi request phải retry.
- Faulty origin vẫn nhận traffic -> lãng phí tài nguyên.

**Cách đúng**: Dùng retry **và** health check cùng nhau:
- Health check: phát hiện upstream lỗi, đánh dấu down, ngừng gửi request mới đến đó.
- Retry: bảo vệ request đang bay khi upstream bất ngờ lỗi (trước khi health check kịp phát hiện).

### 15.2 Anti-pattern 2: Retry không giới hạn

```text
SAI: proxy_next_upstream_tries 10; (hoặc không set -- mặc định là 0 = không giới hạn với một số phiên bản)
```

**Vấn đề**: Nếu tất cả upstream đều lỗi, Nginx sẽ thử đi thử lại, gây ra:
- Request bị treo rất lâu (client timeout).
- Tạo ra lượng lớn request đến upstream đã lỗi -> làm tình hình tệ hơn.
- Có thể gây ra "retry storm" -- avalanche failure.

**Cách đúng**: Luôn set `proxy_next_upstream_tries` với giá trị hợp lý (thường là 2-3, tương ứng với số upstream server).

### 15.3 Anti-pattern 3: Retry POST mà không có idempotency key

```text
SAI: proxy_next_upstream non_idempotent; (cho phép retry POST) nhưng application không có idempotency mechanism.
```

**Vấn đề**: Như đã giải thích trong section 6.6 -- duplicate operation.

**Cách đúng**: Một trong ba:
- Không retry POST ở Nginx -- để client retry.
- Thêm idempotency key vào POST request.
- Chỉ retry POST cho các operation thực sự idempotent (ví dụ: `GET /api/orders/ORD-123` dù dùng POST vì lý do nào đó).

### 15.4 Anti-pattern 4: Không set `proxy_read_timeout` khi dùng retry

```text
SAI: proxy_next_upstream http_503 timeout; nhưng proxy_read_timeout vẫn là 60s (mặc định).
```

**Vấn đề**: Nếu upstream đầu tiên treo (không trả lời), Nginx sẽ chờ 60 giây trước khi timeout và retry. Client có thể đã disconnect từ lâu.

**Cách đúng**: Set `proxy_read_timeout` phù hợp:
```nginx
proxy_read_timeout 5s;           # Mỗi lần thử tối đa 5 giây
proxy_next_upstream_tries 3;     # Tối đa 3 lần thử
# Budget: 5s * 3 = 15 giây -- client timeout nên là 20-30 giây
```

### 15.5 Anti-pattern 5: Dùng case 06 làm capacity test

```text
SAI: "Case 06 pass với 1 request -> retry hoạt động. Tôi có thể dùng retry cho mọi request trong production."
```

**Vấn đề**: Case 06 chứng minh retry mechanism hoạt động cho **1 request**. Nó không chứng minh retry hoạt động cho **10,000 request đồng thời**. Dưới concurrent load cao:
- Connection pool đến faulty origin có thể cạn kiệt.
- Retry làm tăng gấp đôi số connection đến upstream group.
- Memory usage tăng vì Nginx phải buffer response từ lần thử đầu.

**Cách đúng**: Nếu muốn validate retry dưới load, dùng Variation 3 (stress test) hoặc case 07 (rate limit / connection pressure).

### 15.6 Anti-pattern 6: Không monitoring failover rate

```text
SAI: "Retry hoạt động, client luôn thấy 200, không cần alert."
```

**Vấn đề**: Failover là cơ chế bảo vệ, nhưng nó cũng là **tín hiệu cảnh báo sớm**. Nếu failover rate tăng đột biến (từ 0.1% lên 5%), có nghĩa là một upstream đang gặp vấn đề. Nếu không monitoring, bạn sẽ không biết cho đến khi cả hai upstream cùng lỗi.

**Cách đúng**: Monitoring failover rate qua `X-LB-Failover` header (hoặc Nginx error log). Alert khi failover rate > 1%.

---

## 16. Real validation data

### 16.1 Default run (1 VU, 1 iteration)

```text
     script: 06-retry-failover.js
     profile: full-no-cdn
     vus: 1
     iterations: 1

     ✓ lb failover demo status
     ✓ lb failover demo served by nginx
     ✓ lb failover demo upstream matches
     ✓ lb failover demo request id present
     ✓ lb failover demo no cache header
     ✓ lb failover header present
     ✓ lb failover response is stable

     checks.....................: 100.00% ✓ 7  ✗ 0
     http_req_failed............: 0.00%  ✓ 1  ✗ 0
     http_req_duration..........: avg=4.5ms  min=4.5ms  med=4.5ms  max=4.5ms  p(90)=4.5ms  p(95)=4.5ms
     http_reqs..................: 1      (100.00%)
     iterations.................: 1
     vus........................: 1      (min=1 max=1)

     Exit: 0
```

**Phân tích chi tiết**:

| Metric | Giá trị | Đánh giá |
| --- | --- | --- |
| Exit code | 0 | PASS -- không có lỗi |
| Checks pass | 7/7 (100%) | Tất cả 7 checks pass, bao gồm cả 2 checks đặc thù |
| http_req_failed | 0% | Client thấy 200 OK |
| http_req_duration | 4.5ms | Tổng latency ~4.5ms cho cả 2 lần thử (503 + 200) |
| http_reqs | 1 | 1 request từ client (nhưng Nginx gửi 2 request lên upstream) |

Latency breakdown (ước tính):
```text
~0.5ms: k6 -> Nginx (connection established)
~0.5ms: Nginx -> faulty-origin (connection)
~1.0ms: faulty-origin xử lý -> 503
~0.5ms: Nginx -> stable-origin (connection)
~1.0ms: stable-origin xử lý -> 200
~0.5ms: Nginx -> k6 (response)
~0.5ms: k6 check execution
----------------
~4.5ms: total
```

### 16.2 Xác nhận thủ công bằng curl

```powershell
# 1. Gọi endpoint và xem response đầy đủ
curl -v http://localhost:80/api/lb/failover-demo 2>&1
```

Output kỳ vọng:
```text
* Connected to localhost (127.0.0.1) port 80
> GET /api/lb/failover-demo HTTP/1.1
> Host: localhost
> User-Agent: curl/8.x
>
< HTTP/1.1 200 OK
< Server: nginx/1.25
< X-Served-By: nginx
< X-Upstream-Service: lb-stable-origin
< X-Request-ID: abc123def4567890abc123def4567890
< X-LB-Failover: faulty->stable
< Content-Type: application/json
<
{"role":"stable","failover":true,"original_upstream":"faulty-origin","request_id":"abc123..."}
```

```powershell
# 2. Kiểm tra Nginx error log để thấy retry
docker logs <nginx-container> 2>&1 | Select-String "upstream" | Select-Object -Last 5
```

Output kỳ vọng:
```text
[error] upstream: "http://faulty-origin:3000/api/lb/failover-demo" returned 503,
        trying next upstream
[info] upstream: "http://stable-origin:3000/api/lb/failover-demo" returned 200,
        request completed
```

### 16.3 Multi-iteration reliability test

```text
     script: 06-retry-failover.js (modified: 100 iterations)
     vus: 1
     iterations: 100

     ✓ lb failover demo status               (100/100)
     ✓ lb failover demo served by nginx      (100/100)
     ✓ lb failover demo upstream matches     (100/100)
     ✓ lb failover demo request id present   (100/100)
     ✓ lb failover demo no cache header      (100/100)
     ✓ lb failover header present            (100/100)
     ✓ lb failover response is stable        (100/100)

     checks.....................: 100.00% ✓ 700  ✗ 0
     http_req_failed............: 0.00%  ✓ 100  ✗ 0
     http_req_duration..........: avg=4.3ms min=3.8ms med=4.2ms max=7.1ms p(90)=5.0ms p(95)=5.5ms
     http_reqs..................: 100

     Exit: 0
```

Kết quả này xác nhận retry mechanism hoạt động ổn định: 100/100 request đều được retry thành công, không có request nào "lọt lưới" trả về 503.

---

## 17. Reference

### 17.1 Các file liên quan

| File | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\06-retry-failover.js` | Script chính của case |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\shared.js` | Shared library: `lbCapabilityApis.failoverDemo`, `assertLBResponse()`, `requestLB()`, `responseHeader()` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\case-catalog.json` | Catalog định nghĩa case 06, topology, expected signals |
| `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Nginx configuration với upstream group và `proxy_next_upstream` |
| `E:\Projects\k6\k6-metrics-server\scripts\run-lb-capabilities.ps1` | Runner script |

### 17.2 Các case liên quan trong series

| Case | Mối liên hệ |
| --- | --- |
| [Case 01 -- Entry smoke](./01_entry-smoke.md) | Baseline: request đến được Nginx |
| [Case 05 -- Origin service mix](./05_origin-service-mix.md) | Case trước đó trong learning order -- test routing dưới concurrent load |
| [Case 07 -- Rate limit / connection pressure](./07_rate-limit-and-connection-pressure.md) | Case tiếp theo trong learning order -- test shedding và connection management |
| [Case 09 -- Passive outlier ejection](./09_passive-outlier-ejection.md) | Cơ chế xử lý upstream lỗi khác (ejection thay vì retry) -- so sánh ở section 2.3 |
| [Case 12 -- Slow origin timeout](./12_slow-origin-timeouts.md) | Test timeout policy -- liên quan vì retry cũng có thể được trigger bởi timeout |

### 17.3 Tài liệu tổng quan

| File | Nội dung |
| --- | --- |
| [00_overview.md](./00_overview.md) | Tổng quan series LB/Gateway layer, mental model, key concepts |
| [13_validation-and-chart-analysis.md](./13_validation-and-chart-analysis.md) | Hướng dẫn validation và phân tích chart cho toàn bộ LB series |

### 17.4 Kiến thức nền

| Chủ đề | Tài liệu tham khảo |
| --- | --- |
| Nginx `proxy_next_upstream` | [nginx.org: proxy_next_upstream](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream) |
| Nginx `proxy_next_upstream_tries` | [nginx.org: proxy_next_upstream_tries](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream_tries) |
| Nginx `proxy_next_upstream_timeout` | [nginx.org: proxy_next_upstream_timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream_timeout) |
| Nginx upstream `max_fails` / `fail_timeout` | [nginx.org: upstream server](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#server) |
| Nginx `proxy_read_timeout` | [nginx.org: proxy_read_timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout) |
| Retry storm problem | [aws.amazon.com: Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) |
| Idempotency in HTTP | [RFC 7231: Idempotent Methods](https://datatracker.ietf.org/doc/html/rfc7231#section-4.2.2) |
| k6 check reference | [k6.io: checks](https://k6.io/docs/using-k6/checks/) |
