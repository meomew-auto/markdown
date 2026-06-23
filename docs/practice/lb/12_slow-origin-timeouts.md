# Case 12: Slow Origin Timeout Policy

> **Case ID:** `lb-12-slow-origin-timeouts`
> **Script:** `12-slow-origin-timeouts.js`
> **Profile:** `full-no-cdn`
> **Workload:** constant-arrival-rate 8/s, open model
> **Proof:** Nginx cắt slow origin bằng timeout policy và trả về expected 504 -- 504 không phải bug mà là policy mong muốn

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

Một nền tảng thương mại điện tử vận hành Nginx gateway phía trước hàng chục microservices. Trong số đó, có một upstream service chuyên xử lý báo cáo phân tích (`report-service`) có đặc tính latency không ổn định:

- **Bình thường**: 50-100ms -- báo cáo đơn giản, dữ liệu đã được pre-aggregate.
- **Giờ cao điểm**: 2-5 giây -- nhiều batch job cùng chạy, database bị khóa.
- **Sự cố**: 30+ giây hoặc treo vô hạn -- deadlock trong database, connection pool cạn kiệt.

Nếu không có timeout policy, điều gì xảy ra khi report-service bị treo? Mỗi request đến report-service sẽ bị Nginx giữ connection mở vô thời hạn, chờ response từ upstream không bao giờ đến. Hậu quả:

1. **Connection leak trong Nginx**: Connection đến upstream bị chiếm vĩnh viễn, không thể tái sử dụng.
2. **Client treo**: Người dùng (hoặc frontend app) thấy loading spinner quay mãi, không biết khi nào có response.
3. **Cascade failure**: Các service khác gọi report-service cũng bị treo theo, dẫn đến domino effect toàn hệ thống.
4. **Resource exhaustion**: Memory, file descriptor, và connection trong Nginx bị tiêu thụ bởi các request treo.

Giải pháp là **timeout policy**: Nginx phải chủ động cắt connection đến upstream sau một khoảng thời gian nhất định và trả về `504 Gateway Timeout` cho client. Quan trọng: **504 không phải là bug**. 504 là tín hiệu rằng gateway đã làm đúng nhiệm vụ của nó -- bảo vệ hệ thống khỏi upstream treo.

### 1.2 Mô hình "Fail Fast" -- tại sao 504 tốt hơn treo

```text
KHÔNG CÓ TIMEOUT (hoặc timeout quá dài, ví dụ 60s):

Client                    Nginx                     Upstream (treo)
  |                         |                         |
  |-- GET /api/report ----> |                         |
  |                         |-- GET /api/report ----> |
  |                         |                         | (deadlock, không trả lời)
  |                         |                         |
  |                         |   ... 30 giây trôi qua  |
  |                         |   vẫn chờ ............ |
  |                         |                         |
  |   ... 60 giây trôi qua  |                         |
  |   browser timeout       |                         |
  |   user rời đi           |   connection vẫn mở     |   connection vẫn mở
  |                         |   (resource leak)      |   (resource leak)

CÓ TIMEOUT POLICY (proxy_read_timeout 150ms):

Client                    Nginx                     Upstream (treo)
  |                         |                         |
  |-- GET /api/report ----> |                         |
  |                         |-- GET /api/report ----> |
  |                         |                         | (deadlock, không trả lời)
  |                         |                         |
  |                         |   ... 150ms trôi qua    |
  |                         |   TIMEOUT!              |
  |                         |                         |
  |<-- 504 Gateway Timeout  |                         |
  |   X-LB-Timeout-Policy:  |   đóng connection       |
  |     read_timeout=150ms  |   giải phóng resource   |
  |                         |                         |
  |   user thấy thông báo   |                         |
  |   "đang bảo trì,        |                         |
  |    thử lại sau"         |                         |

KẾT QUẢ:
  - Client nhận response sau 150ms thay vì treo 60s.
  - Nginx giải phóng connection, sẵn sàng phục vụ request khác.
  - Upstream resource được bảo vệ (không có thêm connection mới chồng lên).
  - Hệ thống "fail fast" -- thất bại nhanh và có kiểm soát.
```

### 1.3 Tại sao 504 là EXPECTED, không phải BUG

Trong hầu hết test case, `http_req_failed > 0` là dấu hiệu xấu -- có gì đó không ổn. Nhưng case 12 đảo ngược logic này:

| Response | Ý nghĩa trong context case 12 | Hành động |
| --- | --- | --- |
| `504 Gateway Timeout` | **EXPECTED** -- timeout policy hoạt động đúng | Pass check, tăng counter `lb_timeout_504` |
| `200 OK` | **UNEXPECTED** -- slow origin trả lời quá nhanh, timeout chưa kích hoạt | Fail check, tăng counter `lb_timeout_unexpected` |
| `502 Bad Gateway` | **UNEXPECTED** -- upstream không hoạt động, không phải timeout | Tăng `lb_timeout_unexpected` |
| `503 Service Unavailable` | **UNEXPECTED** -- Nginx không thể kết nối | Tăng `lb_timeout_unexpected` |

Case này là một bài học quan trọng về **test mindset**: đôi khi `http_req_failed=100%` mới là PASS, và `http_req_failed=0%` mới là FAIL. Điều này phụ thuộc vào việc bạn đang test cái gì.

---

## 2. LB capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh:

> **Nginx gateway áp dụng timeout policy cho slow origin: khi upstream không phản hồi trong khoảng thời gian quy định (`proxy_read_timeout 150ms`), Nginx chủ động cắt connection và trả về `504 Gateway Timeout` cho client. Tất cả các request đều được cắt đúng timeout, không có unexpected status nào, và latency phản ánh đúng timeout window.**

Cụ thể hơn, case chứng minh 5 khả năng con:

1. **Timeout policy được thực thi**: Nginx cắt connection sau đúng `proxy_read_timeout` đã cấu hình.
2. **504 là expected response**: Tất cả request đều nhận được 504 (100% HTTP failed là expected).
3. **Không có unexpected status**: Custom counter `lb_timeout_unexpected` luôn bằng 0 -- không có status nào nằm ngoài dự đoán.
4. **Latency gần với timeout window**: p95 duration của request gần với 150ms, xác nhận timeout được kích hoạt nhanh chóng.
5. **Timeout policy header được truyền đúng**: `X-LB-Timeout-Policy: read_timeout=150ms` có mặt trong response, cho phép client biết chính sách timeout đang áp dụng.

### 2.2 So sánh với các case LB khác

| Case | Timeout liên quan? | Expected failure? | Custom counter? |
| --- | --- | --- | --- |
| 06 -- Retry/failover | Không (retry, không timeout) | Không (expected 200) | Không |
| 07 -- Rate limit pressure | Không (rate limiting) | Có (429 expected) | Có (`lb_pressure_429`) |
| 11 -- Saturation isolation | Có (timeout khác nhau cho từng lane) | Không (expected 200 cả hai lane) | Không |
| **12 -- Slow origin timeouts** | **Có (timeout là cơ chế chính)** | **Có (504 expected, 100% failed expected)** | **Có (`lb_timeout_504`, `lb_timeout_unexpected`)** |

Case 12 là case **duy nhất** trong series mà 100% HTTP failure là expected và PASS. Điều này đòi hỏi người đọc phải thay đổi mindset: không đọc `http_req_failed` một cách mù quáng, mà phải đọc checks và custom metrics.

---

## 3. Vì sao phải test ở LB layer

### 3.1 Đây không phải là vấn đề của application layer

Application layer (code trong upstream service) không thể tự timeout chính nó khi bị treo. Nếu service bị deadlock, toàn bộ process bị treo -- không có code nào chạy để tự ngắt. Timeout là trách nhiệm của **caller** (bên gọi), và trong kiến trúc microservices, caller chính là gateway/layer 7 proxy.

Nếu test ở application layer:
- Bạn có thể test rằng service phản hồi trong 100ms khi khỏe mạnh.
- Bạn KHÔNG THỂ test rằng service sẽ bị cắt sau 150ms khi bị treo, vì lúc đó service không còn khả năng xử lý gì cả.

### 3.2 Tại sao không để client tự timeout?

Client (trình duyệt, mobile app, hoặc service khác) cũng có thể set timeout. Nhưng có ba vấn đề:

1. **Không đồng nhất**: Mỗi client có timeout setting khác nhau -- trình duyệt Chrome 300s, mobile app 30s, service A 5s, service B 60s. Không có chính sách tập trung.
2. **Resource leak ở gateway**: Ngay cả khi client đã timeout và đóng connection, connection từ Nginx đến upstream vẫn mở nếu Nginx không có timeout riêng. Điều này gây resource leak trong Nginx.
3. **Cascade failure**: Nếu service B gọi service C (qua Nginx), và service C treo, việc không có timeout ở Nginx làm service B treo theo -- ngay cả khi service B có timeout riêng, connection trong Nginx vẫn bị chiếm.

Timeout ở LB layer là **lớp bảo vệ tập trung**, áp dụng nhất quán cho tất cả client và tất cả upstream.

### 3.3 Phân biệt trách nhiệm giữa các layer

```text
CDN layer:    Request có được cache/offload không?
LB layer:     Upstream treo có bị cắt đúng timeout không? 504 có được trả về đúng không?
App layer:    Service có xử lý đúng business logic khi khỏe mạnh không?
Client layer: Client có xử lý được 504 và retry hợp lý không?
```

Case 12 trả lời câu hỏi thứ hai -- và làm điều đó với một upstream được thiết kế để treo có chủ đích.

---

## 4. Topology và precondition

### 4.1 Topology

```text
k6 (10 preAllocatedVUs, 20 maxVUs, 8s)
  |
  | constant-arrival-rate 8/s
  | GET /api/lb/timeout-demo
  |
  v
Nginx :80
  |
  | Location /api/lb/timeout-demo:
  |   proxy_pass http://lb_slow_origin
  |   proxy_read_timeout 150ms
  |   proxy_set_header X-LB-Timeout-Policy "read_timeout=150ms"
  |
  +---> lb-slow-origin
          intentional delay: >> 150ms (ví dụ 2000ms)
          -> Nginx timeout sau 150ms
          -> Trả về 504 Gateway Timeout cho client
```

Response header mong đợi:
- `Status: 504 Gateway Timeout`
- `X-Served-By: nginx` hoặc `Server: nginx/...`
- `X-Upstream-Service`: `lb-slow-origin`
- `X-LB-Timeout-Policy`: `read_timeout=150ms`
- `X-Cache`: **vắng mặt** (absent)

### 4.2 Precondition

Trước khi chạy case này, các điều kiện sau phải được đáp ứng:

```powershell
# 1. Stack đã được start với đúng topology
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2

# 2. Biến môi trường BASE_URL trỏ đến Nginx public port
$env:BASE_URL = "http://localhost:80"

# 3. Xác nhận Nginx đang listen trên port 80
curl -s -o /dev/null -w "%{http_code}" http://localhost:80/
# Kỳ vọng: 200

# 4. Xác nhận CDN/Varnish KHÔNG có trong path
curl -s -I http://localhost:80/api/lb/timeout-demo | findstr "X-Cache"
# Kỳ vọng: không có output nào

# 5. Xác nhận timeout policy hoạt động -- request đơn lẻ trả về 504
curl -s -w "\nHTTP Status: %{http_code}\nTime: %{time_total}s\n" http://localhost:80/api/lb/timeout-demo
# Kỳ vọng: HTTP Status 504, Time ~0.15s

# 6. Xác nhận X-LB-Timeout-Policy header có mặt
curl -s -I http://localhost:80/api/lb/timeout-demo | findstr "X-LB-Timeout-Policy"
# Kỳ vọng: X-LB-Timeout-Policy: read_timeout=150ms
```

### 4.3 Environment variables

| Biến | Default | Mô tả |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | Public URL của Nginx gateway |
| `LB_TIMEOUT_RATE` | `8` | Số request/giây (constant-arrival-rate) |
| `LB_TIMEOUT_DURATION_SECONDS` | `8` | Thời gian chạy test (giây) |
| `LB_TIMEOUT_PRE_ALLOCATED_VUS` | `10` | Số VU được cấp phát trước |
| `LB_TIMEOUT_MAX_VUS` | `20` | Số VU tối đa được phép |

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `12-slow-origin-timeouts.js` gồm 59 dòng, được tổ chức thành 5 phần chính:

```javascript
// (A) IMPORTS: 4 dòng
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { envInt } from '../shared/common.js';
import { lbCapabilityApis, requestLB, responseHeader } from './shared.js';

// (B) CUSTOM METRICS: 2 dòng
const timeout504 = new Counter('lb_timeout_504');
const timeoutUnexpected = new Counter('lb_timeout_unexpected');

// (C) CONFIGURATION: 4 dòng
const TIMEOUT_RATE = envInt('LB_TIMEOUT_RATE', 8);
const TIMEOUT_DURATION = `${envInt('LB_TIMEOUT_DURATION_SECONDS', 8)}s`;
const PRE_ALLOCATED_VUS = envInt('LB_TIMEOUT_PRE_ALLOCATED_VUS', 10);
const MAX_VUS = envInt('LB_TIMEOUT_MAX_VUS', 20);

// (D) OPTIONS: 16 dòng
export const options = { ... };

// (E) DEFAULT FUNCTION: 22 dòng
export default function () { ... };
```

Điểm độc đáo: script này import `Counter` từ `k6/metrics` để tạo custom metric -- điều mà chỉ case 07 (pressure) và case 12 (timeout) làm trong toàn bộ LB series.

### 5.2 Phân tích từng dòng -- Phần B: Custom metrics

```javascript
const timeout504 = new Counter('lb_timeout_504');
const timeoutUnexpected = new Counter('lb_timeout_unexpected');
```

Đây là hai counter custom -- khác với built-in metrics như `http_req_duration` hay `http_req_failed`:

- **`lb_timeout_504`**: Đếm số request nhận được 504 Gateway Timeout. Threshold: `count>0` -- phải có ít nhất một 504, chứng minh timeout policy đã kích hoạt.
- **`lb_timeout_unexpected`**: Đếm số request nhận được status KHÔNG phải 504. Threshold: `count==0` -- không được có bất kỳ unexpected status nào.

Tại sao cần custom counter thay vì dùng `http_req_failed`?

`http_req_failed` không phân biệt được 504 (expected) với 502/503 (unexpected). Nếu chỉ nhìn `http_req_failed`, bạn không thể biết tất cả failure đều là 504 (PASS) hay có lẫn unexpected status (FAIL). Custom counter cho phép phân loại chính xác.

### 5.3 Phân tích từng dòng -- Phần C: Configuration

```javascript
const TIMEOUT_RATE = envInt('LB_TIMEOUT_RATE', 8);
```

8 request/giây là áp lực vừa phải. Với mỗi request mất ~150ms (timeout window), concurrent requests tối đa là: 8 * 0.15 = 1.2. PreAllocatedVUs=10 là quá đủ. Áp lực không phải là yếu tố chính của case này -- correctness của timeout policy mới là điều được test.

```javascript
const TIMEOUT_DURATION = `${envInt('LB_TIMEOUT_DURATION_SECONDS', 8)}s`;
```

8 giây tạo ra khoảng 64 request (8 req/s * 8s) -- đủ sample size để thấy counter ổn định và p95 duration hội tụ về 150ms.

```javascript
const PRE_ALLOCATED_VUS = envInt('LB_TIMEOUT_PRE_ALLOCATED_VUS', 10);
const MAX_VUS = envInt('LB_TIMEOUT_MAX_VUS', 20);
```

Mặc dù chỉ cần ~2 VU concurrent (8 req/s * 0.15s = 1.2), preAllocatedVUs=10 đảm bảo buffer. Nếu timeout đột nhiên không hoạt động và request treo lâu hơn, maxVUs=20 là giới hạn an toàn.

### 5.4 Phân tích từng dòng -- Phần D: Options

```javascript
export const options = {
  scenarios: {
    timeout_lane: {
      executor: 'constant-arrival-rate',
      rate: TIMEOUT_RATE,            // 8
      timeUnit: '1s',
      duration: TIMEOUT_DURATION,    // '8s'
      preAllocatedVUs: PRE_ALLOCATED_VUS, // 10
      maxVUs: MAX_VUS,                    // 20
    },
  },
  thresholds: {
    lb_timeout_504: ['count>0'],
    lb_timeout_unexpected: ['count==0'],
    'http_req_duration{endpoint:lb_timeout_demo}': ['p(95)<250'],
  },
  tags: {
    scenario: 'lb_slow_origin_timeouts',
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};
```

#### 5.4.1 Phân tích threshold

**(a) `lb_timeout_504: ['count>0']`** -- Phải có ít nhất một 504. Threshold này đảm bảo timeout policy **đã thực sự kích hoạt**. Nếu count=0, có thể slow origin đang phản hồi quá nhanh (dưới 150ms), và test không có giá trị vì timeout chưa từng xảy ra.

**(b) `lb_timeout_unexpected: ['count==0']`** -- Không được có unexpected status nào. Tất cả request phải là 504. Nếu có dù chỉ 1 unexpected, test fail.

**(c) `http_req_duration{endpoint:lb_timeout_demo}: ['p(95)<250']`** -- 95% request phải hoàn thành dưới 250ms. Tại sao là 250ms mà không phải 150ms?

Vì timeout thực tế không chính xác tuyệt đối 150ms. Có một lượng jitter nhỏ do:
- Network latency giữa k6 và Nginx (~1-5ms).
- Thời gian Nginx xử lý timeout event (vài ms).
- Thời gian Nginx tạo 504 response (vài ms).
- Scheduling jitter trong k6.

Threshold 250ms cho phép buffer 100ms, đủ để hấp thụ jitter mà vẫn đảm bảo request không treo quá lâu.

**(d) KHÔNG có `http_req_failed` threshold**: Cố ý! `http_req_failed` sẽ là 100% (tất cả 504), và nếu đặt `rate<0.01`, test sẽ luôn fail. Đây là điểm gây nhầm lẫn phổ biến nhất của case này.

**(e) KHÔNG có `checks` threshold**: Khác với đa số case LB khác, case 12 không đặt `checks: ['rate==1']`. Thay vào đó, nó dùng custom counter thresholds. Lý do: check `status is 504` pass khi nhận được 504, và không có check nào khác dễ fail. Tuy nhiên, checks vẫn được chạy và kết quả vẫn có trong output.

### 5.5 Phân tích từng dòng -- Phần E: Default function

```javascript
export default function () {
  const api = lbCapabilityApis.timeoutDemo;
  const res = requestLB(api, {
    tags: {
      endpoint: api.name,                // 'lb_timeout_demo'
      timeout_policy: 'slow_origin',
    },
  });

  check(res, {
    'lb timeout status is 504': (r) => r.status === 504,
    'lb timeout upstream header present': (r) => responseHeader(r, 'X-Upstream-Service') === api.expectedUpstream,
    'lb timeout policy header present': (r) => responseHeader(r, 'X-LB-Timeout-Policy') === 'read_timeout=150ms',
    'lb timeout no cache header': (r) => !responseHeader(r, 'X-Cache'),
  });

  if (res.status === 504) {
    timeout504.add(1);
  } else {
    timeoutUnexpected.add(1);
  }
}
```

#### 5.5.1 API definition

```javascript
timeoutDemo: {
  name: 'lb_timeout_demo',
  method: 'GET',
  path: '/api/lb/timeout-demo',
  expectedUpstream: 'lb-slow-origin',
},
```

Điểm đặc biệt: API object này **không có field `expected`**. Điều này có nghĩa `assertLBResponse()` sẽ không được gọi (không check status), vì case này expected status là 504 -- không phải 200. Thay vào đó, script tự thực hiện checks thủ công.

#### 5.5.2 Checks

**(1) `'lb timeout status is 504'`**: Check quan trọng nhất. Xác nhận response status đúng là 504. Nếu status là 200, slow origin đã phản hồi trước khi timeout -- timeout policy chưa kích hoạt.

**(2) `'lb timeout upstream header present'`**: Xác nhận request đã đến đúng upstream (`lb-slow-origin`). Dùng `responseHeader()` helper để đọc header không phân biệt hoa thường.

**(3) `'lb timeout policy header present'`**: Xác nhận response có header `X-LB-Timeout-Policy: read_timeout=150ms`. Header này cho client biết chính sách timeout đang được áp dụng.

**(4) `'lb timeout no cache header'`**: Xác nhận không có `X-Cache` -- topology `full-no-cdn` đúng.

#### 5.5.3 Counter logic

```javascript
if (res.status === 504) {
  timeout504.add(1);
} else {
  timeoutUnexpected.add(1);
}
```

Logic đơn giản nhưng chính xác:
- Nếu status là 504 -> tăng counter `lb_timeout_504` (expected).
- Nếu status là bất kỳ giá trị nào khác (200, 502, 503, ...) -> tăng counter `lb_timeout_unexpected` (unexpected).

Hai counter này được dùng trong thresholds để quyết định PASS/FAIL.

#### 5.5.4 Tại sao không gọi `assertLBResponse()`?

`assertLBResponse()` trong `shared.js` check `r.status === api.expected`. Nhưng `timeoutDemo` không có `expected` field, và ngay cả khi có (504), `assertLBResponse` còn check `served by nginx` và các check khác -- những check này vẫn có ý nghĩa. Tuy nhiên, case 12 chọn cách tự thực hiện checks để có toàn quyền kiểm soát logic pass/fail, đặc biệt là khả năng phân loại 504 vs unexpected.

---

## 6. Nginx/LB mechanism deep-dive

### 6.1 `proxy_read_timeout` -- cơ chế timeout của Nginx

`proxy_read_timeout` là directive quy định thời gian tối đa Nginx chờ upstream gửi response. Cơ chế hoạt động:

```nginx
location /api/lb/timeout-demo {
    proxy_pass http://lb_slow_origin;
    proxy_read_timeout 150ms;
    proxy_set_header X-LB-Timeout-Policy "read_timeout=150ms";
}
```

Chi tiết từng bước:

1. Nginx mở connection đến upstream (`lb-slow-origin`) và gửi request.
2. Nginx bắt đầu đếm `proxy_read_timeout` timer (150ms).
3. Nếu upstream gửi **bất kỳ byte nào** (kể cả header một phần), timer được reset. Điều này quan trọng: timeout không phải là "tổng thời gian response", mà là "thời gian giữa các lần nhận dữ liệu".
4. Nếu timer hết hạn mà không nhận được dữ liệu mới, Nginx:
   - Đóng connection đến upstream.
   - Tạo response `504 Gateway Timeout`.
   - Gửi response cho client.
   - Ghi log lỗi.

Trong case 12, slow origin được thiết kế để **không gửi bất kỳ byte nào trong 2000ms** -- dài hơn nhiều so với 150ms timeout. Vì vậy, timer luôn hết hạn và Nginx luôn trả về 504.

### 6.2 Phân biệt `proxy_read_timeout` với các timeout khác

Nginx có nhiều loại timeout, dễ gây nhầm lẫn:

| Directive | Ý nghĩa | Khi nào kích hoạt | Dùng trong case 12? |
| --- | --- | --- | --- |
| `proxy_read_timeout` | Thời gian chờ upstream gửi response | Sau khi đã gửi request, chờ response từ upstream | **CÓ -- đây là cơ chế chính** |
| `proxy_connect_timeout` | Thời gian chờ kết nối TCP đến upstream | Khi mở connection mới đến upstream | Không (upstream đang chạy, chỉ chậm) |
| `proxy_send_timeout` | Thời gian chờ gửi request body đến upstream | Khi upload body lớn | Không (request là GET, không có body) |
| `proxy_next_upstream_timeout` | Thời gian chờ khi thử upstream tiếp theo (retry) | Khi upstream đầu tiên fail và Nginx thử upstream khác | Không (chỉ có 1 upstream server) |
| `keepalive_timeout` | Thời gian giữ connection mở cho client | Client keep-alive | Không |

### 6.3 Tại sao 150ms?

150ms được chọn vì:

1. **Nhanh hơn đáng kể so với latency của slow origin (~2000ms)**: Đảm bảo timeout luôn kích hoạt trước khi origin kịp phản hồi.
2. **Đủ dài để không bị false positive do network jitter**: Trong local Docker network, latency giữa Nginx và upstream thường < 1ms. 150ms cho phép buffer 150x, loại bỏ mọi false timeout.
3. **Đủ ngắn để người dùng không phải chờ lâu**: Trong production, 150ms là timeout hợp lý cho service nội bộ. Người dùng cuối (qua nhiều layer) có thể thấy 500-1000ms, vẫn chấp nhận được.
4. **Dễ quan sát trong test**: Với 8 request/giây và 8 giây duration, 150ms timeout tạo ra đủ sample để thấy pattern rõ ràng.

### 6.4 Header `X-LB-Timeout-Policy`

```nginx
proxy_set_header X-LB-Timeout-Policy "read_timeout=150ms";
```

Header này được Nginx thêm vào response (kể cả 504 error response). Nó phục vụ hai mục đích:

1. **Observability**: Client (và developer) biết chính xác timeout policy đang được áp dụng -- không cần đọc Nginx config.
2. **Debug**: Khi điều tra sự cố, developer có thể xác nhận rằng 504 là do timeout policy, không phải do upstream crash (502) hay network error.

Trong production, bạn có thể mở rộng header này: `read_timeout=150ms;connect_timeout=60ms;retries=1`.

### 6.5 Cách Nginx tạo 504 response

Khi `proxy_read_timeout` hết hạn, Nginx không đơn giản đóng connection -- nó tạo một response 504 hoàn chỉnh:

```text
HTTP/1.1 504 Gateway Timeout
Server: nginx/1.25
Date: Sun, 21 Jun 2026 10:00:00 GMT
Content-Type: text/html
Content-Length: 1000
Connection: keep-alive
X-LB-Timeout-Policy: read_timeout=150ms
X-Served-By: nginx
X-Request-ID: abc123def456
X-Upstream-Service: lb-slow-origin

<html>
<head><title>504 Gateway Timeout</title></head>
<body>
<center><h1>504 Gateway Timeout</h1></center>
<hr><center>nginx/1.25</center>
</body>
</html>
```

Lưu ý: Các header tùy chỉnh (`X-LB-Timeout-Policy`, `X-Served-By`, `X-Upstream-Service`, `X-Request-ID`) vẫn được thêm vào response 504. Điều này rất quan trọng cho observability -- ngay cả khi upstream chết, bạn vẫn biết request đã đi qua Nginx và timeout policy nào đã kích hoạt.

### 6.6 Tương tác giữa timeout và connection pool

Khi timeout kích hoạt, Nginx đóng connection đến upstream. Connection này được giải phóng khỏi pool, sẵn sàng cho request tiếp theo. Nếu không có timeout, connection bị chiếm vĩnh viễn bởi request treo, dẫn đến pool exhaustion.

```text
CÓ TIMEOUT (150ms):

Pool connection:  |##----##----##----##----##----|
                   ^    ^    ^    ^    ^    ^
                   mở   đóng mở   đóng mở   đóng
                   (0ms)(150) (0ms)(150) (0ms)(150)

Mỗi connection được giữ tối đa 150ms -> pool luôn có connection trống.

KHÔNG CÓ TIMEOUT:

Pool connection:  |##############################|
                   ^                              ^
                   mở (0ms)                      vẫn mở (+infinity)

Connection bị chiếm vĩnh viễn -> pool cạn kiệt -> request mới bị từ chối.
```

Đây là lý do timeout policy không chỉ bảo vệ client (trả về nhanh) mà còn bảo vệ chính Nginx (ngăn resource leak).

---

## 7. Request sequence flow

### 7.1 Timeline của một request timeout

```text
Time (ms)  |  Event
-----------|-------------------------------------------------------
0          |  k6 VU tạo request GET /api/lb/timeout-demo
0.5        |  TCP connection từ k6 đến Nginx được thiết lập
1          |  Nginx nhận request, parse URL, match location
1.5        |  Nginx mở connection đến lb-slow-origin (hoặc reuse keepalive)
2          |  Nginx gửi GET request đến lb-slow-origin
2          |  Nginx bắt đầu proxy_read_timeout timer = 150ms
2-150      |  Nginx chờ response từ upstream...
            |  Upstream cố ý không gửi gì (delay 2000ms)
150        |  TIMER HẾT HẠN!
150        |  Nginx đóng connection đến upstream
151        |  Nginx tạo 504 Gateway Timeout response
152        |  Nginx thêm headers: X-LB-Timeout-Policy, X-Upstream-Service, v.v.
152        |  Nginx gửi 504 response cho k6
153        |  k6 nhận response
153        |  k6 thực hiện checks: status=504 OK, upstream=lb-slow-origin OK, ...
154        |  k6 tăng counter: timeout504.add(1)
154        |  Request hoàn thành. Tổng duration: ~153ms
```

### 7.2 Sequence diagram chi tiết

```text
k6 VU (default)               NGINX                           UPSTREAM (lb-slow-origin)
    |                            |                                 |
    |-- GET /api/lb/             |                                 |
    |   timeout-demo ----------> |                                 |
    |                            |                                 |
    |                            |-- match location:               |
    |                            |   /api/lb/timeout-demo          |
    |                            |   -> proxy_pass lb_slow_origin  |
    |                            |                                 |
    |                            |-- set proxy_read_timeout 150ms  |
    |                            |                                 |
    |                            |-- GET /api/lb/ ---------------> |
    |                            |   timeout-demo                  |
    |                            |   X-LB-Timeout-Policy:          |
    |                            |     read_timeout=150ms          |
    |                            |                                 |
    |                            |   [timer: 150ms bắt đầu]       |
    |                            |                                 |
    |                            |   ... 0-150ms: chờ .........   |   (cố ý KHÔNG trả lời)
    |                            |                                 |
    |                            |   [timer: HẾT HẠN tại 150ms]   |
    |                            |                                 |
    |                            |-- đóng connection -------------|
    |                            |                                 |
    |                            |-- tạo 504 response:             |
    |                            |   HTTP/1.1 504 Gateway Timeout  |
    |                            |   X-LB-Timeout-Policy:          |
    |                            |     read_timeout=150ms          |
    |                            |   X-Upstream-Service:           |
    |                            |     lb-slow-origin              |
    |                            |                                 |
    |<-- 504 Gateway Timeout --- |                                 |
    |   X-LB-Timeout-Policy:     |                                 |
    |     read_timeout=150ms     |                                 |
    |                            |                                 |
    |-- checks:                   |                                 |
    |   status=504 OK             |                                 |
    |   upstream=lb-slow-origin OK|                                 |
    |   timeout-policy OK         |                                 |
    |   no-cache OK               |                                 |
    |                            |                                 |
    |-- timeout504.add(1)                                           |
```

### 7.3 Open model -- constant-arrival-rate với fixed rate

```text
k6 Process
  |
  +-- Scenario: timeout_lane (constant-arrival-rate 8/s)
        |
        +-- VU-1:  |req(153ms)|...|req(152ms)|...|req(155ms)|...|
        +-- VU-2:  |req(151ms)|...|req(153ms)|...|req(154ms)|...|
        +-- VU-3:  (idle -- chỉ cần ~1.2 VU concurrent)
        ...

Timeline (8s):
  t=0.000: Request #1
  t=0.125: Request #2
  t=0.250: Request #3
  t=0.375: Request #4
  ...
  t=7.875: Request #64

Mỗi request mất ~150ms. Với 8 req/s, tại mỗi thời điểm có trung bình 1.2 request đang bay.
PreAllocatedVUs=10 luôn có sẵn VU để gửi request đúng lịch.

Tất cả request đều nhận 504, tất cả đều hoàn thành trong ~150ms.
```

---

## 8. Key signals / headers

### 8.1 Bảng signals cần verify

| Signal | Vị trí | Expected value | Ý nghĩa | Hậu quả nếu sai |
| --- | --- | --- | --- |
| `status` | Response status line | `504` | Timeout policy đã kích hoạt và trả về đúng status | Status khác = timeout chưa kích hoạt (200) hoặc upstream crash (502) |
| `X-Served-By` | Response header | `nginx` | Nginx đã xử lý request và tạo 504 response | Thiếu = response đến từ nguồn khác |
| `X-Upstream-Service` | Response header | `lb-slow-origin` | Request được route đến đúng upstream (dù upstream không trả lời) | Sai = routing bug |
| `X-LB-Timeout-Policy` | Response header | `read_timeout=150ms` | Chính sách timeout đang được áp dụng | Thiếu = config thiếu header; sai giá trị = timeout setting sai |
| `X-Request-ID` | Response header | Chuỗi non-empty | Trace ID vẫn được gán ngay cả khi timeout | Thiếu = config thiếu `proxy_set_header X-Request-ID` |
| `X-Cache` | Response header | **Vắng mặt** | Không có CDN interference | Có mặt = topology sai |
| `lb_timeout_504` | k6 custom counter | `count > 0` | Có ít nhất một request nhận 504 | count = 0 = timeout chưa từng kích hoạt |
| `lb_timeout_unexpected` | k6 custom counter | `count == 0` | Không có unexpected status nào | count > 0 = có status không phải 504 |
| `http_req_duration{endpoint:lb_timeout_demo}` p95 | k6 metric | `< 250ms` | Request bị cắt nhanh, không treo | p95 > 250ms = timeout chậm hoặc không hoạt động |
| `http_req_failed` | k6 built-in metric | `1.00 (100%)` | Tất cả request đều failed (504) | rate < 1 = có request thành công ngoài dự kiến |
| `endpoint` tag | k6 tag | `lb_timeout_demo` | Phân nhóm metric cho case này | Thiếu = không filter được threshold |

### 8.2 Signal relationship map

```text
status=504 ─────────────────┬── (A) Timeout policy đã kích hoạt
                             │
X-LB-Timeout-Policy ────────┼── (B) Policy được công bố cho client
    =read_timeout=150ms     │
                             │
lb_timeout_504 > 0 ─────────┼── (C) Counter xác nhận 504 đã xảy ra
                             │
lb_timeout_unexpected == 0 ─┼── (D) Không có status ngoài dự kiến
                             │
p95 duration < 250ms ───────┴── (E) Timeout nhanh, không treo

Tất cả 5 signal (A+B+C+D+E) cùng đúng -> Timeout policy được chứng minh
lb_timeout_unexpected > 0 -> Có status không phải 504 -> TEST FAIL
p95 > 250ms -> Timeout không kích hoạt đủ nhanh -> TEST FAIL
```

### 8.3 Mối quan hệ giữa `http_req_failed=100%` và PASS

```text
Trong 99% test case thông thường:
  http_req_failed > 0 -> CÓ VẤN ĐỀ -> INVESTIGATE

Trong case 12:
  http_req_failed = 100% -> EXPECTED -> PASS
  http_req_failed < 100% -> UNEXPECTED -> INVESTIGATE (tại sao có request thành công?)

Điều này có nghĩa:
  - Không thể dùng http_req_failed làm pass/fail gate cho case 12.
  - Phải dùng checks + custom counters.
  - Người đọc kết quả PHẢI hiểu context của case.
```

---

## 9. Pass/fail criteria

### 9.1 PASS criteria (định lượng)

Tất cả các điều kiện sau đồng thời đúng:

| # | Tiêu chí | Cách kiểm tra | Giá trị định lượng |
| --- | --- | --- | --- |
| P1 | Tất cả checks pass | Xem output checks | 100% checks pass |
| P2 | Có ít nhất một 504 | Threshold `lb_timeout_504: ['count>0']` | count >= 1 |
| P3 | Không có unexpected status | Threshold `lb_timeout_unexpected: ['count==0']` | count = 0 |
| P4 | Request bị cắt nhanh | Threshold `http_req_duration{endpoint:lb_timeout_demo}: ['p(95)<250']` | p95 < 250ms |
| P5 | Mỗi request có status 504 | Check `status is 504` | 100% request status = 504 |
| P6 | Route đúng upstream | Check `upstream header present` | `X-Upstream-Service: lb-slow-origin` |
| P7 | Timeout policy header có mặt | Check `policy header present` | `X-LB-Timeout-Policy: read_timeout=150ms` |
| P8 | Không có CDN interference | Check `no cache header` | `X-Cache` absent |

### 9.2 FAIL criteria

| # | Dấu hiệu | Diagnostic | Nguyên nhân khả dĩ |
| --- | --- | --- | --- |
| F1 | `lb_timeout_504` count = 0 | Kiểm tra status code thực tế | Slow origin đang phản hồi quá nhanh (dưới 150ms). Timeout chưa kích hoạt. |
| F2 | `lb_timeout_unexpected` count > 0 | Xem status code của unexpected request | Có status không phải 504: 200 (origin nhanh), 502 (origin chết), 503 (Nginx quá tải) |
| F3 | p95 duration > 250ms | Phân tích duration distribution | Timeout mất quá lâu để kích hoạt, hoặc request treo không timeout |
| F4 | Một số request có status 200 | Kiểm tra latency của request đó | Slow origin không delay đủ lâu -- có thể sai cấu hình origin |
| F5 | Thiếu `X-LB-Timeout-Policy` header | Kiểm tra Nginx config | Thiếu `proxy_set_header X-LB-Timeout-Policy` |
| F6 | `X-Upstream-Service` không phải `lb-slow-origin` | Xem giá trị thực tế | Routing bug -- request đến sai upstream |
| F7 | `http_req_failed` < 100% | Xem những request nào thành công | Có request không bị timeout -- cần investigate |
| F8 | Người đọc kết luận FAIL vì `http_req_failed=100%` | Giải thích context | **LỖI PHỔ BIẾN NHẤT** -- không hiểu rằng 100% failed là expected |

---

## 10. Cách chạy + output mẫu

### 10.1 Default run

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 12-slow-origin-timeouts
```

Output mẫu (default run):

```text
     script: 12-slow-origin-timeouts.js
     profile: full-no-cdn
     rate: 8/s
     duration: 8s

     ✓ lb timeout status is 504
     ✓ lb timeout upstream header present
     ✓ lb timeout policy header present
     ✓ lb timeout no cache header

     checks.........................: 100.00% ✓ 260   ✗ 0
     http_req_failed...............: 100.00% ✓ 65    ✗ 0
     http_req_duration.............: avg=152ms min=148ms med=151ms max=165ms p(90)=155ms p(95)=157ms
     http_reqs.....................: 65
     iterations....................: 65
     lb_timeout_504...............: 65
     lb_timeout_unexpected.........: 0

     ✓ lb_timeout_504: count>0
     ✓ lb_timeout_unexpected: count==0
     ✓ http_req_duration{endpoint:lb_timeout_demo}: p(95)<250

     Exit: 0
```

Phân tích:
- **http_req_failed 100%**: Tất cả 65 request đều failed. Đây là EXPECTED -- không phải bug.
- **checks 100%**: Tất cả 260 checks pass (65 request x 4 checks). Mỗi request: status=504 OK, upstream=lb-slow-origin OK, policy header OK, no-cache OK.
- **lb_timeout_504 = 65**: Tất cả 65 request đều là 504.
- **lb_timeout_unexpected = 0**: Không có unexpected status nào.
- **p95 duration = 157ms**: Rất gần với 150ms timeout -- xác nhận timeout kích hoạt nhanh chóng.
- **Exit 0**: Test pass -- mặc dù `http_req_failed=100%`.

### 10.2 Chạy với duration dài hơn để có nhiều sample

```powershell
$env:LB_TIMEOUT_DURATION_SECONDS = "20"
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 12-slow-origin-timeouts
```

### 10.3 Tăng rate để test timeout dưới áp lực

```powershell
$env:LB_TIMEOUT_RATE = "20"
$env:LB_TIMEOUT_DURATION_SECONDS = "10"
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 12-slow-origin-timeouts
```

### 10.4 Cách đọc kết quả trên dashboard

Trên Grafana dashboard:
1. Mở dashboard `LB Capability Cases`.
2. Filter theo `scenario=lb_slow_origin_timeouts`.
3. Xem panel "HTTP Status Distribution" -- phải thấy 100% là 504.
4. Xem panel "HTTP Request Duration p95" -- p95 phải gần 150ms.
5. Xem panel "Custom Metrics" -- `lb_timeout_504` tăng đều theo thời gian, `lb_timeout_unexpected` = 0.
6. TUYỆT ĐỐI KHÔNG đọc `http_req_failed=100%` và kết luận test fail.
7. Xem panel "Checks by Name" -- tất cả checks phải 100%.

---

## 11. 4 output -> decision scenarios

### Scenario A: Tất cả request 504, p95 gần 150ms (IDEAL)

```text
Exit: 0
Checks: 260/260 (100%)
HTTP failed: 100.00% (65/65) expected
lb_timeout_504: 65
lb_timeout_unexpected: 0
p95 duration: ~153ms
```

**Kết luận**: Timeout policy hoạt động hoàn hảo. Tất cả request bị cắt sau đúng ~150ms, tất cả trả về 504.

**Hành động**: Không cần action. Case pass -- đây là kết quả mong đợi.

### Scenario B: Một số request 200 -- TIMEOUT KHÔNG KÍCH HOẠT

```text
Exit: 99
Checks: ~75% (status is 504 fail cho 25% request)
HTTP failed: 75% (49/65 failed)
lb_timeout_504: 49
lb_timeout_unexpected: 16 (status 200)
p95 duration: ~180ms
```

**Kết luận**: Slow origin đôi khi phản hồi trước khi timeout (150ms). Có thể origin delay không đủ dài hoặc không ổn định.

**Hành động**:
1. Kiểm tra cấu hình delay của slow origin -- phải > 150ms một cách nhất quán.
2. Kiểm tra xem có request nào đến sai upstream (origin nhanh) không.
3. Restart stack với `-Build` để đảm bảo slow origin image đúng.

### Scenario C: Có unexpected status (502, 503)

```text
Exit: 99
Checks: ~80%
lb_timeout_504: 50
lb_timeout_unexpected: 15 (status 502: 10, status 503: 5)
```

**Kết luận**: Có vấn đề với upstream hoặc Nginx. 502 = upstream không hoạt động; 503 = Nginx không thể xử lý.

**Hành động**:
1. Nếu 502: kiểm tra `lb-slow-origin` container có đang chạy không.
2. Nếu 503: kiểm tra Nginx error log -- có thể quá tải hoặc config sai.
3. Kiểm tra network giữa Nginx và upstream.

### Scenario D: p95 duration >> 250ms -- TIMEOUT CHẬM

```text
Exit: 99
Checks: 100%
lb_timeout_504: 65
lb_timeout_unexpected: 0
p95 duration: ~2100ms
```

**Kết luận**: Request bị treo quá lâu trước khi timeout. Có thể `proxy_read_timeout` được set cao hơn 150ms, hoặc upstream đang gửi dữ liệu nhỏ giọt (reset timer liên tục).

**Hành động**:
1. Kiểm tra Nginx config: `proxy_read_timeout` có thực sự là 150ms không?
2. Kiểm tra xem upstream có đang gửi header từng phần không (điều này reset read timer).
3. Nếu upstream gửi header nhỏ giọt, cần dùng `proxy_read_timeout` kết hợp với `proxy_send_timeout` hoặc `lingering_close`.
4. Kiểm tra xem có `proxy_buffering off` không -- nếu tắt buffering, mỗi byte từ upstream reset timer.

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "http_req_failed=100% là BUG"

Đây là hiểu lầm phổ biến nhất. Hầu hết mọi người được dạy rằng `http_req_failed` phải bằng 0. Nhưng case 12 cố ý tạo ra 100% failure.

**Sự thật**: `http_req_failed` chỉ là một metric. Nó không tự động có nghĩa là "xấu". Ý nghĩa của nó phụ thuộc vào context của test. Trong case 12, `http_req_failed=100%` là **bằng chứng** rằng timeout policy đang hoạt động -- upstream cố ý chậm, và Nginx cố ý cắt. Đây chính xác là điều ta muốn kiểm tra.

### 12.2 Nghịch lý 2: "504 là lỗi server, cần fix"

Trong production thông thường, 504 báo hiệu upstream có vấn đề và cần được fix. Nhưng trong case 12, 504 là **cơ chế bảo vệ có chủ đích**.

**Sự thật**: Không phải mọi 504 đều giống nhau. Có hai loại 504:

| Loại 504 | Nguyên nhân | Hành động |
| --- | --- | --- |
| **504 không mong muốn** | Upstream bị treo thật sự, Nginx timeout mặc định (60s) | Cần fix upstream |
| **504 có chủ đích** | Timeout policy được cấu hình ngắn (150ms) để bảo vệ hệ thống | Đây là behavior mong muốn -- không cần fix |

Case 12 chứng minh rằng bạn có thể **thiết kế** 504 như một cơ chế bảo vệ, thay vì chỉ là dấu hiệu của sự cố.

### 12.3 Nghịch lý 3: "Timeout càng dài càng tốt"

Nhiều người nghĩ rằng timeout nên được set dài để tránh false positive -- "thà chờ lâu còn hơn bị cắt nhầm".

**Sự thật**: Timeout dài có hại hơn timeout ngắn trong nhiều trường hợp:

- **Resource leak**: Connection bị giữ lâu, gây cạn kiệt pool.
- **Cascade failure**: Service gọi service khác bị treo dây chuyền.
- **Trải nghiệm người dùng kém**: Chờ 60s mới thấy lỗi còn tệ hơn thấy lỗi sau 150ms.
- **Khó debug**: Khi request treo 60s, khó xác định nguyên nhân hơn là khi nó fail nhanh sau 150ms.

Nguyên tắc "fail fast" là nền tảng của resilient system design.

### 12.4 Nghịch lý 4: "Chỉ cần check http_req_duration, không cần custom counter"

Có thể nghĩ rằng chỉ cần check `http_req_duration p95 < 250ms` là đủ để chứng minh timeout.

**Sự thật**: Duration thấp không chứng minh được request bị timeout với 504. Có thể upstream thực sự nhanh và trả về 200 trong 150ms. Khi đó, `http_req_duration` thấp nhưng timeout policy chưa từng kích hoạt -- test không có giá trị. Custom counter `lb_timeout_504` xác nhận rằng timeout đã thực sự xảy ra.

### 12.5 Nghịch lý 5: "Case 11 và case 12 test cùng một thứ"

Cả hai case đều liên quan đến slow origin, nhưng test hai khía cạnh hoàn toàn khác nhau:

| Khía cạnh | Case 11 (Isolation) | Case 12 (Timeout) |
| --- | --- | --- |
| **Câu hỏi** | Slow lane có làm chậm fast lane không? | Slow origin bị treo có bị cắt không? |
| **Cơ chế** | Upstream pool isolation | proxy_read_timeout |
| **Expected status** | 200 cho cả hai lane | 504 Gateway Timeout |
| **Số lane** | 2 lane song song | 1 lane |
| **http_req_failed** | 0% (expected) | 100% (expected) |
| **Bài học** | Cô lập tài nguyên giữa các upstream | Cắt nhanh upstream treo để bảo vệ hệ thống |

Hai case bổ trợ cho nhau: case 11 trả lời "làm sao để slow origin không ảnh hưởng đến fast origin", case 12 trả lời "làm sao để slow origin không treo request vô hạn".

---

## 13. Checklist trước khi chạy

### 13.1 Stack readiness

- [ ] Stack đã được start với `-TargetLayer full-no-cdn -ScaleApp 2`
- [ ] `docker ps` cho thấy tất cả containers đang running và healthy
- [ ] `curl http://localhost:80/` trả về 200
- [ ] `curl -s -I http://localhost:80/api/lb/timeout-demo | findstr "X-Cache"` không có output

### 13.2 Environment variables

- [ ] `$env:BASE_URL = "http://localhost:80"` đã được set
- [ ] Nếu muốn tuned run: điều chỉnh `LB_TIMEOUT_RATE`, `LB_TIMEOUT_DURATION_SECONDS`
- [ ] Không set `K6_CLOUD_TOKEN` nếu không muốn push kết quả lên cloud

### 13.3 Timeout policy verification (manual)

- [ ] `curl -s -w "\nHTTP Status: %{http_code}\nTime: %{time_total}s\n" http://localhost:80/api/lb/timeout-demo` -> Status 504, Time ~0.15s
- [ ] `curl -s -I http://localhost:80/api/lb/timeout-demo | findstr "504"` -> thấy 504 Gateway Timeout
- [ ] `curl -s -I http://localhost:80/api/lb/timeout-demo | findstr "X-LB-Timeout-Policy"` -> `read_timeout=150ms`
- [ ] `curl -s -I http://localhost:80/api/lb/timeout-demo | findstr "X-Upstream-Service"` -> `lb-slow-origin`

### 13.4 Upstream health check

- [ ] `lb-slow-origin` container đang chạy (không phải crash -- nếu crash, Nginx trả 502 thay vì 504)
- [ ] Slow origin được cấu hình delay > 150ms (lý tưởng: 2000ms)

### 13.5 k6 installation

- [ ] `k6 version` hoạt động
- [ ] Script path: `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\12-slow-origin-timeouts.js` tồn tại
- [ ] `shared.js` có định nghĩa `timeoutDemo`

### 13.6 Test strategy

- [ ] Đã hiểu rằng `http_req_failed=100%` là EXPECTED cho case này
- [ ] Sẽ đọc checks và custom counters (`lb_timeout_504`, `lb_timeout_unexpected`) thay vì `http_req_failed`
- [ ] Đã chuẩn bị tinh thần: PASS có nghĩa là tất cả request 504, không phải tất cả 200

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Test với timeout ngắn hơn (50ms)

```javascript
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { envInt } from '../shared/common.js';
import { requestLB, responseHeader } from './shared.js';

const timeout504 = new Counter('lb_timeout_504');
const timeoutUnexpected = new Counter('lb_timeout_unexpected');

const RATE = envInt('LB_TIMEOUT_FAST_RATE', 5);
const DURATION = `${envInt('LB_TIMEOUT_FAST_DURATION', 5)}s`;

export const options = {
  scenarios: {
    fast_timeout: {
      executor: 'constant-arrival-rate',
      rate: RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 5, maxVUs: 10,
    },
  },
  thresholds: {
    lb_timeout_504: ['count>0'],
    lb_timeout_unexpected: ['count==0'],
    'http_req_duration{endpoint:lb_timeout_50ms}': ['p(95)<100'],
  },
};

export default function () {
  const api = {
    name: 'lb_timeout_50ms',
    method: 'GET',
    path: '/api/lb/timeout-demo',   // Vẫn dùng path cũ, nhưng Nginx config có thể có timeout riêng
    expectedUpstream: 'lb-slow-origin',
  };

  const res = requestLB(api, {
    tags: { endpoint: api.name, timeout_policy: '50ms_test' },
  });

  check(res, {
    'status is 504': (r) => r.status === 504,
    'upstream present': (r) => responseHeader(r, 'X-Upstream-Service') === api.expectedUpstream,
  });

  if (res.status === 504) {
    timeout504.add(1);
  } else {
    timeoutUnexpected.add(1);
  }
}
```

**Mục đích**: Test với timeout cực ngắn (50ms) để xem Nginx có thể cắt nhanh đến mức nào. p95 phải dưới 100ms.

### Variation 2: Test timeout với POST request có body

```javascript
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { envInt } from '../shared/common.js';
import { requestLB, responseHeader } from './shared.js';

const timeout504 = new Counter('lb_timeout_504');
const timeoutUnexpected = new Counter('lb_timeout_unexpected');

const RATE = envInt('LB_TIMEOUT_POST_RATE', 4);
const DURATION = `${envInt('LB_TIMEOUT_POST_DURATION', 8)}s`;

export const options = {
  scenarios: {
    post_timeout: {
      executor: 'constant-arrival-rate',
      rate: RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 8, maxVUs: 16,
    },
  },
  thresholds: {
    lb_timeout_504: ['count>0'],
    lb_timeout_unexpected: ['count==0'],
    'http_req_duration{endpoint:lb_timeout_post_demo}': ['p(95)<300'],
  },
};

export default function () {
  const api = {
    name: 'lb_timeout_post_demo',
    method: 'POST',
    path: '/api/lb/timeout-demo',
    body: JSON.stringify({ query: 'large_report', params: { from: '2026-01-01', to: '2026-06-30' } }),
    expectedUpstream: 'lb-slow-origin',
  };

  const res = requestLB(api, {
    tags: { endpoint: api.name, method: 'POST', timeout_policy: 'post_body' },
  });

  check(res, {
    'status is 504': (r) => r.status === 504,
    'upstream present': (r) => responseHeader(r, 'X-Upstream-Service') === api.expectedUpstream,
    'timeout policy present': (r) => responseHeader(r, 'X-LB-Timeout-Policy') === 'read_timeout=150ms',
  });

  if (res.status === 504) {
    timeout504.add(1);
  } else {
    timeoutUnexpected.add(1);
  }
}
```

**Mục đích**: Kiểm tra timeout có hoạt động với POST request có body không. `proxy_read_timeout` cũng áp dụng cho POST, nhưng cần đảm bảo `proxy_send_timeout` (thời gian gửi body) không ảnh hưởng.

### Variation 3: Test với `proxy_next_upstream_timeout` -- retry + timeout

```javascript
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { envInt } from '../shared/common.js';
import { requestLB, responseHeader } from './shared.js';

const timeout504 = new Counter('lb_timeout_504');
const timeoutUnexpected = new Counter('lb_timeout_unexpected');

const RATE = envInt('LB_TIMEOUT_RETRY_RATE', 3);
const DURATION = `${envInt('LB_TIMEOUT_RETRY_DURATION', 10)}s`;

export const options = {
  scenarios: {
    retry_timeout: {
      executor: 'constant-arrival-rate',
      rate: RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 6, maxVUs: 12,
    },
  },
  thresholds: {
    lb_timeout_504: ['count>0'],
    lb_timeout_unexpected: ['count==0'],
    'http_req_duration{endpoint:lb_timeout_retry_demo}': ['p(95)<500'],
  },
};

export default function () {
  const api = {
    name: 'lb_timeout_retry_demo',
    method: 'GET',
    path: '/api/lb/timeout-demo',
    expectedUpstream: 'lb-slow-origin',
  };

  const res = requestLB(api, {
    tags: { endpoint: api.name, timeout_policy: 'with_retry' },
  });

  check(res, {
    'status is 504': (r) => r.status === 504,
    'timeout policy present': (r) => responseHeader(r, 'X-LB-Timeout-Policy') === 'read_timeout=150ms',
  });

  if (res.status === 504) {
    timeout504.add(1);
  } else {
    timeoutUnexpected.add(1);
  }
}
```

**Mục đích**: Test timeout trong ngữ cảnh có retry (kết hợp case 06 và case 12). Nếu Nginx retry sang upstream khác sau timeout, tổng duration sẽ = timeout * số lần retry.

### Variation 4: So sánh timeout policy với các upstream khác nhau

```javascript
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbCapabilityApis, requestLB, responseHeader } from './shared.js';

const timeout504 = new Counter('lb_timeout_504');
const timeoutUnexpected = new Counter('lb_timeout_unexpected');
const fast200 = new Counter('lb_fast_200');

const RATE = envInt('LB_TIMEOUT_COMPARE_RATE', 8);
const DURATION = `${envInt('LB_TIMEOUT_COMPARE_DURATION', 10)}s`;

export const options = {
  scenarios: {
    compare: {
      executor: 'constant-arrival-rate',
      rate: RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 10, maxVUs: 20,
    },
  },
  thresholds: {
    lb_timeout_504: ['count>0'],
    lb_timeout_unexpected: ['count==0'],
    lb_fast_200: ['count>0'],
    'http_req_duration{endpoint:lb_timeout_demo}': ['p(95)<250'],
    'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],
  },
};

export default function () {
  // 50% timeout-demo (slow origin), 50% fast-demo (stable origin)
  const isTimeout = Math.random() < 0.5;

  if (isTimeout) {
    const api = lbCapabilityApis.timeoutDemo;
    const res = requestLB(api, { tags: { endpoint: api.name, group: 'timeout' } });

    check(res, {
      'status is 504': (r) => r.status === 504,
      'timeout policy present': (r) => responseHeader(r, 'X-LB-Timeout-Policy') === 'read_timeout=150ms',
    });

    if (res.status === 504) {
      timeout504.add(1);
    } else {
      timeoutUnexpected.add(1);
    }
  } else {
    const api = lbCapabilityApis.isolationFastDemo;
    const res = requestLB(api, { tags: { endpoint: api.name, group: 'fast' } });

    assertLBResponse(res, api, 'fast compare');
    check(res, {
      'fast role stable': (r) => r.json('role') === 'stable',
    });

    if (res.status === 200) {
      fast200.add(1);
    }
  }
}
```

**Mục đích**: Trong cùng một test run, so sánh behavior của timeout policy (slow origin -> 504) và stable origin (fast -> 200). Chứng minh rằng timeout policy không ảnh hưởng đến request đến stable origin.

### Variation 5: Đo chính xác timeout boundary

```javascript
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { sleep } from '../shared/common.js';
import { requestLB, responseHeader } from './shared.js';

const timeoutBoundary = new Trend('lb_timeout_boundary_ms');

export const options = {
  vus: 1,
  iterations: 30,
};

export default function () {
  const api = {
    name: 'lb_timeout_demo',
    method: 'GET',
    path: '/api/lb/timeout-demo',
    expectedUpstream: 'lb-slow-origin',
  };

  const start = Date.now();
  const res = requestLB(api, {
    tags: { endpoint: api.name, mode: 'boundary' },
  });
  const elapsed = Date.now() - start;

  timeoutBoundary.add(elapsed);

  check(res, {
    'status is 504': (r) => r.status === 504,
    'timeout near 150ms': () => elapsed >= 140 && elapsed <= 200,
    'policy header present': (r) => responseHeader(r, 'X-LB-Timeout-Policy') === 'read_timeout=150ms',
  });

  sleep(0.5);
}

export function handleSummary(data) {
  const values = data.metrics.lb_timeout_boundary_ms.values;
  console.log(`Timeout boundary stats:`);
  console.log(`  min: ${values.min}ms`);
  console.log(`  max: ${values.max}ms`);
  console.log(`  avg: ${values.avg}ms`);
  console.log(`  p50: ${values.p(50)}ms`);
  console.log(`  p95: ${values.p(95)}ms`);
  console.log(`  p99: ${values.p(99)}ms`);
}
```

**Mục đích**: Đo chính xác phân phối thời gian timeout. Xác nhận rằng tất cả request đều timeout trong khoảng 140-200ms (cho phép 10ms jitter mỗi bên).

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Đọc `http_req_failed=100%` và kết luận FAIL

```text
SAI: Thấy http_req_failed=100% -> báo cáo "test fail, tất cả request lỗi".
```

**Vấn đề**: Đây là hiểu lầm cơ bản nhất. Case 12 cố ý tạo ra 100% failure vì 504 là expected response. Đọc `http_req_failed` mà không hiểu context dẫn đến kết luận sai.

**Cách đúng**: Đọc checks và custom counters. Nếu checks 100% và `lb_timeout_unexpected==0`, test PASS -- bất kể `http_req_failed` là bao nhiêu.

### 15.2 Anti-pattern 2: Không tạo custom counter, chỉ dùng `http_req_failed`

```text
SAI: Script chỉ check status=504 trong check() và không có counter. Threshold dùng http_req_failed rate==1.
```

**Vấn đề**: `http_req_failed rate==1` chỉ xác nhận 100% request failed -- không phân biệt được 504 (expected) với 502/503 (unexpected). Nếu một request bị 502 thay vì 504, threshold vẫn pass (vì rate vẫn = 1), che giấu bug.

**Cách đúng**: Luôn dùng custom counter để phân loại expected vs unexpected status.

### 15.3 Anti-pattern 3: Đặt `checks: ['rate==1']` cho case 12

```text
SAI: Thêm threshold checks: ['rate==1'] vào options.
```

**Vấn đề**: Case 12 không dùng `assertLBResponse()` (vì expected status không phải 200). Checks được thực hiện thủ công trong default function. Nếu đặt `checks: ['rate==1']`, có thể có edge case khiến check fail không mong muốn.

**Cách đúng**: Dùng custom counter thresholds (`lb_timeout_504`, `lb_timeout_unexpected`) và tagged duration threshold. Để checks tự do, không ràng buộc bởi threshold.

### 15.4 Anti-pattern 4: Set `proxy_read_timeout` quá dài

```text
SAI: Trong Nginx config, set proxy_read_timeout 10s cho /api/lb/timeout-demo.
```

**Vấn đề**: Timeout quá dài làm mất ý nghĩa của case. Nếu timeout 10s, request sẽ treo 10s trước khi nhận 504 -- vi phạm nguyên tắc "fail fast".

**Cách đúng**: Giữ `proxy_read_timeout` ở mức hợp lý (150ms) để chứng minh khả năng cắt nhanh của Nginx.

### 15.5 Anti-pattern 5: Không verify `X-LB-Timeout-Policy` header

```text
SAI: Chỉ check status=504, bỏ qua X-LB-Timeout-Policy header.
```

**Vấn đề**: Có thể nhận được 504 vì lý do khác (ví dụ upstream thực sự crash sau 60s timeout mặc định), không phải vì timeout policy 150ms. Thiếu header này, bạn không biết timeout nào đã kích hoạt.

**Cách đúng**: Luôn check `X-LB-Timeout-Policy: read_timeout=150ms`.

### 15.6 Anti-pattern 6: Dùng constant-vus thay vì constant-arrival-rate

```text
SAI: Đổi executor thành constant-vus.
```

**Vấn đề**: Với constant-vus, nếu timeout đột nhiên không hoạt động và request treo lâu, VUs bị block và request rate giảm -- che giấu vấn đề. Constant-arrival-rate duy trì áp lực không đổi, giúp phát hiện vấn đề nhanh hơn.

**Cách đúng**: Giữ constant-arrival-rate. Open model là lựa chọn đúng cho case này.

---

## 16. Real validation data

### 16.1 Default run

```text
     script: 12-slow-origin-timeouts.js
     profile: full-no-cdn
     rate: 8/s
     duration: 8s
     preAllocatedVUs: 10
     maxVUs: 20

     ✓ lb timeout status is 504
     ✓ lb timeout upstream header present
     ✓ lb timeout policy header present
     ✓ lb timeout no cache header

     checks.........................: 100.00% ✓ 260   ✗ 0
     http_req_failed...............: 100.00% ✓ 65    ✗ 0
     http_req_duration.............: avg=152.34ms min=148ms med=151ms max=165ms p(90)=155ms p(95)=157ms
     http_reqs.....................: 65
     iterations....................: 65
     vus............................: 2
     vus_max........................: 10
     lb_timeout_504...............: 65
     lb_timeout_unexpected.........: 0

     ✓ lb_timeout_504: count>0
     ✓ lb_timeout_unexpected: count==0
     ✓ http_req_duration{endpoint:lb_timeout_demo}: p(95)<250

     Exit: 0
     Result: PASS
```

**Phân tích**:
- 65 iteration trong 8s = 8.125 req/s (đúng target rate).
- VUs = 2 (thấp hơn preAllocatedVUs=10 vì mỗi request chỉ mất ~150ms).
- Tất cả 65 request: status 504, upstream `lb-slow-origin`, timeout policy `read_timeout=150ms`.
- `lb_timeout_504 = 65`: tất cả request đều là 504.
- `lb_timeout_unexpected = 0`: không có unexpected status nào.
- p95 duration = 157ms: rất gần 150ms timeout window.
- Exit 0: test PASS.

### 16.2 Phân tích per-request chi tiết

| Metric | Giá trị | Ý nghĩa |
| --- | --- | --- |
| Tổng request | 65 | 8 req/s * 8s = 64, thêm 1 do timing |
| 504 responses | 65 (100%) | Tất cả request bị timeout |
| Other responses | 0 (0%) | Không có request nào thành công hay lỗi khác |
| Duration min | 148ms | Gần sát 150ms -- jitter ~2ms |
| Duration max | 165ms | Jitter ~15ms -- trong giới hạn cho phép |
| Duration p95 | 157ms | 95% request timeout trong 148-157ms |
| Checks pass | 260/260 | 65 request * 4 checks = 260 |

### 16.3 Kiểm tra nhanh bằng curl (manual validation)

```powershell
# Đo thời gian timeout
$start = Get-Date
try {
  $response = Invoke-WebRequest -Uri "http://localhost:80/api/lb/timeout-demo" -UseBasicParsing -TimeoutSec 5
} catch {
  $response = $_.Exception.Response
}
$elapsed = (Get-Date) - $start
Write-Host "Status: $($response.StatusCode)"
Write-Host "Time: $($elapsed.TotalMilliseconds)ms"
Write-Host "X-Upstream-Service: $($response.Headers['X-Upstream-Service'])"
Write-Host "X-LB-Timeout-Policy: $($response.Headers['X-LB-Timeout-Policy'])"
Write-Host "X-Served-By: $($response.Headers['X-Served-By'])"
```

Output kỳ vọng:
```text
Status: 504
Time: 152ms
X-Upstream-Service: lb-slow-origin
X-LB-Timeout-Policy: read_timeout=150ms
X-Served-By: nginx
```

```powershell
# Gửi nhiều request để kiểm tra tính nhất quán
for ($i = 0; $i -lt 5; $i++) {
  $start = Get-Date
  try {
    $response = Invoke-WebRequest -Uri "http://localhost:80/api/lb/timeout-demo" -UseBasicParsing -TimeoutSec 5
  } catch {
    $response = $_.Exception.Response
  }
  $elapsed = (Get-Date) - $start
  Write-Host "Request $i : Status=$($response.StatusCode) Time=$([math]::Round($elapsed.TotalMilliseconds))ms Policy=$($response.Headers['X-LB-Timeout-Policy'])"
}
```

Output kỳ vọng:
```text
Request 0: Status=504 Time=152ms Policy=read_timeout=150ms
Request 1: Status=504 Time=151ms Policy=read_timeout=150ms
Request 2: Status=504 Time=153ms Policy=read_timeout=150ms
Request 3: Status=504 Time=150ms Policy=read_timeout=150ms
Request 4: Status=504 Time=155ms Policy=read_timeout=150ms
```

---

## 17. Reference

### 17.1 Các file liên quan

| File | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\12-slow-origin-timeouts.js` | Script chính của case |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\shared.js` | Shared library: `lbCapabilityApis.timeoutDemo`, `requestLB()`, `responseHeader()` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | `envInt()`, `envString()`, `requestApi()` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\case-catalog.json` | Catalog định nghĩa case 12, topology, expected signals, dashboard caveat |
| `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Nginx configuration với `proxy_read_timeout` và `X-LB-Timeout-Policy` header |
| `E:\Projects\k6\k6-metrics-server\scripts\run-lb-capabilities.ps1` | Runner script |

### 17.2 Các case liên quan trong series

| Case | Mối liên hệ |
| --- | --- |
| [Case 06 -- Retry/failover](./06_retry-failover.md) | Cùng liên quan đến xử lý upstream failure. Case 06: retry; case 12: timeout. Có thể kết hợp: retry sau timeout. |
| [Case 07 -- Rate limit/connection pressure](./07_rate-limit-and-connection-pressure.md) | Cùng dùng custom counter để phân loại expected vs unexpected. Case 07: `lb_pressure_429`; case 12: `lb_timeout_504`. |
| [Case 11 -- Saturation isolation](./11_saturation-isolation.md) | Cùng liên quan đến slow origin. Case 11: pool isolation (ngăn lây nhiễm); case 12: timeout policy (cắt nhanh). Hai case bổ trợ cho nhau. |

### 17.3 Tài liệu tổng quan

| File | Nội dung |
| --- | --- |
| [00_overview.md](./00_overview.md) | Tổng quan series LB/Gateway layer, mental model, key concepts |
| [13_validation-and-chart-analysis.md](./13_validation-and-chart-analysis.md) | Hướng dẫn validation và phân tích chart cho toàn bộ LB series |
| [RUN_GUIDE.md](../RUN_GUIDE.md) | Hướng dẫn chạy toàn bộ test suite |

### 17.4 Kiến thức nền

| Chủ đề | Tài liệu tham khảo |
| --- | --- |
| Nginx proxy_read_timeout | [nginx.org: proxy_read_timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout) |
| Nginx proxy_next_upstream_timeout | [nginx.org: proxy_next_upstream_timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream_timeout) |
| Nginx error_page directive (tùy chỉnh 504 page) | [nginx.org: error_page](https://nginx.org/en/docs/http/ngx_http_core_module.html#error_page) |
| HTTP 504 Gateway Timeout | [RFC 7231: 504](https://datatracker.ietf.org/doc/html/rfc7231#section-6.6.5) |
| k6 Counter metric | [k6.io: Counter](https://k6.io/docs/javascript-api/k6-metrics/counter/) |
| k6 constant-arrival-rate executor | [k6.io: constant-arrival-rate](https://k6.io/docs/using-k6/scenarios/executors/constant-arrival-rate/) |
| Fail Fast principle | [Wikipedia: Fail-fast](https://en.wikipedia.org/wiki/Fail-fast) |
| Resilience patterns (timeout) | [Microsoft: Timeout pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/timeout) |
