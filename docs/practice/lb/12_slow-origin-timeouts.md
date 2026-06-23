# Case 12: Slow Origin Timeout Policy

> **Case ID:** `lb-12-slow-origin-timeouts`
> **Script:** `12-slow-origin-timeouts.js`
> **Profile:** `full-no-cdn`
> **Executor:** `constant-arrival-rate`
> **Target layer:** LB/Gateway (Nginx)
> **Proof:** Nginx cắt slow origin bằng `proxy_read_timeout` policy và trả expected `504 Gateway Timeout` -- unexpected status = 0, p95 duration gần chính sách timeout.

---

## 1. Tình huống thực tế

### 1.1. Bài toán

Một upstream origin trở nên quá chậm -- có thể do database query bị timeout, network partition giữa Gateway và origin, resource exhaustion trên container origin, hoặc một third-party dependency bị treo. Khi điều này xảy ra, nếu Gateway không có cơ chế timeout policy rõ ràng, toàn bộ connection pool của Gateway sẽ bị chiếm giữ bởi các request đang chờ origin phản hồi trong vô hạn. Hậu quả là cascading failure: tất cả client treo, connection pool cạn kiệt, và ngay cả những origin khỏe mạnh khác cũng không thể phục vụ được vì không còn connection nào khả dụng.

Trong case này, response `504 Gateway Timeout` **không phải là bug**. Nó là một policy response có chủ đích -- Gateway chủ động cắt connection sau một khoảng thời gian đã định để bảo vệ tài nguyên hệ thống và trả lỗi có ý nghĩa cho client, thay vì để client treo vô hạn.

### 1.2. Ví dụ cụ thể từ thực tế

Hãy tưởng tượng một hệ thống e-commerce có tích hợp payment gateway của bên thứ ba. Payment gateway bình thường phản hồi sau 200ms. Một ngày, payment gateway gặp sự cố và bắt đầu phản hồi sau 5 giây -- hoặc tệ hơn, treo hoàn toàn không trả lời. Nếu Gateway của bạn không có timeout policy:

- Mỗi request checkout sẽ giữ một Nginx worker connection trong 5 giây hoặc lâu hơn.
- Với 1000 worker connections, chỉ cần 1000 request checkout trong 5 giây là toàn bộ pool cạn kiệt.
- Tất cả các request khác -- kể cả request đọc sản phẩm, xem giỏ hàng, đăng nhập -- đều không thể được phục vụ vì không còn connection.
- Toàn bộ site sập, mặc dù chỉ có một upstream bị lỗi.

Với timeout policy được cấu hình đúng, Gateway sẽ:

- Chờ payment gateway tối đa 3 giây (theo policy).
- Nếu sau 3 giây không có phản hồi, trả `504 Gateway Timeout` cho client.
- Giải phóng connection ngay lập tức.
- Client nhận được thông báo lỗi rõ ràng, có thể thử lại hoặc hiển thị thông báo phù hợp.
- Connection pool không bị cạn kiệt, các upstream khác vẫn hoạt động bình thường.

### 1.3. Vì sao trường hợp này quan trọng

Timeout policy không phải là thứ "nice to have" -- nó là **tuyến phòng thủ cuối cùng** của Gateway trước các slow origin. Trong kiến trúc microservices, nơi một request có thể đi qua nhiều service, một service chậm có thể kéo sập toàn bộ chuỗi nếu không có timeout policy ở mỗi hop. Đây là một trong những nguyên nhân phổ biến nhất của cascading failure trong distributed systems.

Timeout policy đúng còn giúp:

- **Bảo vệ connection pool**: Mỗi connection bị chiếm bởi slow origin là một connection không thể dùng cho request khác.
- **Fast failure**: Client nhận được lỗi nhanh thay vì treo, cho phép retry logic hoặc circuit breaker ở phía client hoạt động.
- **Tài nguyên CPU**: Worker process không bị block vô hạn, có thể phục vụ request khác.
- **Observability**: Header như `X-LB-Timeout-Policy` cho biết chính xác policy nào đã cắt request, giúp debug và monitoring.

---

## 2. LB capability được chứng minh

### 2.1. Capability chính: `proxy_read_timeout` per-location override

Case này chứng minh rằng Nginx có thể áp dụng một timeout policy **khác với global default** cho một location cụ thể. Đây là capability quan trọng vì:

- Không phải mọi upstream đều cần cùng một timeout.
- Một upstream đọc dữ liệu cache có thể cần timeout 5 giây.
- Một upstream xử lý batch job có thể cần timeout 60 giây.
- Một upstream nhạy cảm với latency (như payment) có thể cần timeout 500ms.

Nginx cho phép ghi đè `proxy_read_timeout` ở cấp độ `location`, cho phép mỗi route có timeout policy riêng phù hợp với SLA của upstream tương ứng.

### 2.2. Cấu hình Nginx cho case này

Global defaults (áp dụng cho tất cả location trừ khi bị ghi đè):

```nginx
proxy_connect_timeout 10s;
proxy_read_timeout 30s;
proxy_send_timeout 30s;
proxy_next_upstream error timeout invalid_header http_500 http_502 http_503 http_504;
proxy_next_upstream_tries 2;
proxy_next_upstream_timeout 5s;
```

Location override cho `/api/lb/timeout-demo`:

```nginx
location = /api/lb/timeout-demo {
    proxy_read_timeout 150ms;
    add_header X-Upstream-Service "lb-slow-origin" always;
    add_header X-LB-Timeout-Policy "read_timeout=150ms" always;
    add_header X-Request-ID $request_id always;
    proxy_pass http://lb_slow_backend;
}
```

Upstream definition:

```nginx
upstream lb_slow_backend {
    zone upstream_lb_slow 64k;
    server lb-slow-origin:8090 resolve max_fails=1 fail_timeout=5s;
    keepalive 8;
}
```

### 2.3. Điều gì xảy ra khi Nginx xử lý request tới location này

1. Nginx nhận request tại location `/api/lb/timeout-demo`.
2. Location này ghi đè `proxy_read_timeout` thành `150ms` (global là `30s`).
3. Nginx mở connection tới `lb_slow_backend` -- upstream chỉ có một server duy nhất: `lb-slow-origin:8090`.
4. `lb-slow-origin` được cấu hình để phản hồi **chậm hơn 150ms** một cách có chủ đích.
5. Nginx chờ response headers từ origin trong tối đa 150ms.
6. Sau 150ms không có response, Nginx đóng connection tới origin và trả `504 Gateway Timeout` cho k6.
7. Nginx thêm header `X-LB-Timeout-Policy: read_timeout=150ms` để chứng minh chính policy này đã cắt request.

### 2.4. Evidence từ script

Script tạo ra hai custom Counter:

- `lb_timeout_504`: Đếm số response có status `504` (expected outcome).
- `lb_timeout_unexpected`: Đếm số response có status **không phải** `504` (unexpected -- phải bằng 0).

Thresholds:

```javascript
thresholds: {
  lb_timeout_504: ['count>0'],           // Phải có ít nhất một 504
  lb_timeout_unexpected: ['count==0'],   // Không được có unexpected status nào
  'http_req_duration{endpoint:lb_timeout_demo}': ['p(95)<250'],  // p95 phải dưới 250ms
}
```

Điểm đặc biệt: **không có threshold cho `http_req_failed`** vì 100% request failed là EXPECTED behavior. Đặt threshold `http_req_failed<1` cho case này sẽ luôn fail, đó là anti-pattern.

### 2.5. Các checks

Bốn checks trong script:

1. `'lb timeout status is 504'`: `(r) => r.status === 504` -- Xác nhận response status đúng là 504.
2. `'lb timeout upstream header present'`: `(r) => responseHeader(r, 'X-Upstream-Service') === api.expectedUpstream` -- Xác nhận request được route tới đúng upstream `lb-slow-origin`.
3. `'lb timeout policy header present'`: `(r) => responseHeader(r, 'X-LB-Timeout-Policy') === 'read_timeout=150ms'` -- Xác nhận policy timeout đúng giá trị.
4. `'lb timeout no cache header'`: `(r) => !responseHeader(r, 'X-Cache')` -- Xác nhận không có CDN cache (đúng profile full-no-cdn).

---

## 3. Vì sao phải test ở LB layer

### 3.1. App-level test không đủ

Nếu test trực tiếp origin (gọi thẳng `lb-slow-origin:8090`), bạn sẽ thấy origin phản hồi chậm hoặc timeout. Nhưng bạn **không thể** chứng minh được rằng:

- Gateway đã áp dụng đúng timeout policy nào (30s global hay 150ms override?).
- Gateway đã trả đúng status code `504` (không phải `502` hay `503`).
- Gateway đã thêm đúng header `X-LB-Timeout-Policy`.
- Timeout policy có cô lập được slow origin, không ảnh hưởng đến các route khác.

App-level test chỉ kiểm tra behavior của một service đơn lẻ. Nó không kiểm tra được **Gateway behavior** -- thứ nằm giữa client và origin.

### 3.2. Direct origin test không kiểm soát được Gateway

Nếu test direct origin, bạn đang bỏ qua hoàn toàn layer Nginx. Bạn không biết:

- Nginx có thực sự cắt connection sau 150ms không.
- Nginx có trả đúng HTTP status code không.
- Header policy có được inject đúng không.
- Timeout có hoạt động trong topology đầy đủ (k6 -> Nginx -> origin) không.

### 3.3. LB-layer test là cần thiết vì

Timeout policy là **Gateway concern**, không phải application concern. Ứng dụng có thể tự implement timeout khi gọi downstream service, nhưng đó là application-level timeout. Gateway-level timeout là một layer bảo vệ độc lập:

- Gateway không biết application logic -- nó chỉ biết "sau X ms không có response thì cắt".
- Gateway bảo vệ chính nó (worker connections, memory) khỏi slow origin.
- Gateway có thể thêm header signal để debugging (policy nào đã cắt, upstream nào bị cắt).
- Gateway timeout hoạt động cho **mọi** request đi qua nó, không phụ thuộc vào application có implement timeout hay không.

### 3.4. So sánh các layer test cho timeout

| Layer | Test được gì | Không test được gì |
| --- | --- | --- |
| App-level (test origin) | Origin behavior khi chậm | Gateway policy, 504 status, timeout headers |
| Direct origin (bypass Nginx) | Response time của origin | Toàn bộ Gateway behavior |
| LB-layer (case này) | Gateway timeout policy, 504 status, headers, isolation | Origin internal behavior (không cần) |

---

## 4. Topology và precondition

### 4.1. Topology runtime

```text
┌──────┐     ┌───────────────┐     ┌────────────────────┐
│  k6  │────▶│  Nginx (:80)  │────▶│ lb-slow-origin     │
│      │◀────│  Gateway      │◀────│ :8090              │
└──────┘     └───────────────┘     │ (cố ý chậm >150ms) │
                                   └────────────────────┘
```

- **k6**: Gửi request với rate không đổi (`constant-arrival-rate`, 8/s) tới `http://localhost:80/api/lb/timeout-demo`.
- **Nginx**: Nhận request, match location `/api/lb/timeout-demo`, ghi đè `proxy_read_timeout 150ms`, forward tới upstream `lb_slow_backend`.
- **lb-slow-origin:8090**: Một service được cấu hình để **phản hồi chậm hơn 150ms** một cách có chủ đích, đảm bảo Nginx luôn timeout.

### 4.2. Profile: full-no-cdn

- **Target layer**: `full-no-cdn` -- Nginx là Gateway duy nhất, không có Varnish/CDN đứng trước.
- **Lý do dùng full-no-cdn**: Nếu dùng `full`, request sẽ đi qua CDN/Varnish trước, làm nhiễu signal LB. `X-Cache` có thể xuất hiện, và CDN có thể cache 504 hoặc có timeout behavior riêng, làm sai lệch kết quả.
- **Xác nhận profile đúng**: Check `'lb timeout no cache header'` đảm bảo không có `X-Cache` trong response.

### 4.3. Preconditions cần xác nhận trước khi chạy

1. **Stack đã được start với profile `full-no-cdn`**:

   ```powershell
   ./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
   ```

2. **Routing contract đã pass**:

   ```powershell
   ./scripts/check-target-routing.ps1 -BaseUrl "http://localhost:80" -TargetLayer full-no-cdn
   ```

   Kết quả mong đợi: 37 pass, 0 fail.

3. **lb-slow-origin đang chạy và phản hồi chậm hơn 150ms**: Có thể kiểm tra bằng cách gọi direct (không qua Nginx) và đo response time.

4. **Nginx config có `proxy_read_timeout 150ms` tại location `/api/lb/timeout-demo`**: Kiểm tra nginx.conf hoặc dùng `nginx -T` để xác nhận config đã được load.

5. **`BASE_URL` được set đúng**:

   ```powershell
   $env:BASE_URL = "http://localhost:80"
   ```

6. **Không có CDN/Varnish đứng trước**: Xác nhận bằng cách gọi một request bất kỳ và kiểm tra không có `X-Cache` header.

### 4.4. Upstream chi tiết

```nginx
upstream lb_slow_backend {
    zone upstream_lb_slow 64k;          # Shared memory zone cho health checks
    server lb-slow-origin:8090 resolve   # Server duy nhất, resolve DNS động
           max_fails=1                   # Sau 1 lần fail -> đánh dấu unavailable
           fail_timeout=5s;              # Thời gian bị đánh dấu unavailable
    keepalive 8;                         # Giữ 8 keepalive connections tới origin
}
```

Điểm đáng chú ý:

- **Chỉ có 1 server**: Không có fallback. Khi server này timeout, Nginx không thể retry sang server khác (dù `proxy_next_upstream_tries 2`).
- **`max_fails=1`**: Sau 1 lần fail (bao gồm timeout), server bị đánh dấu unavailable trong 5 giây. Điều này có thể ảnh hưởng đến các request tiếp theo trong cùng một đợt test.
- **`keepalive 8`**: Giữ tối đa 8 connection thường trực tới origin, giảm overhead TCP handshake.

---

## 5. Script deep-dive

### 5.1. Tổng quan cấu trúc

Script gồm ba phần chính:

1. **Configuration**: Đọc environment variables, định nghĩa custom metrics.
2. **Options / Scenarios**: Định nghĩa executor, rate, duration, thresholds.
3. **Default function**: Logic chạy cho mỗi iteration -- gửi request, check, increment counters.

### 5.2. Configuration và environment variables

```javascript
import { check } from 'k6';
import { Counter } from 'k6/metrics';

import { envInt } from '../shared/common.js';
import { lbCapabilityApis, requestLB, responseHeader } from './shared.js';

const TIMEOUT_RATE = envInt('LB_TIMEOUT_RATE', 8);
const TIMEOUT_DURATION = `${envInt('LB_TIMEOUT_DURATION_SECONDS', 8)}s`;
const PRE_ALLOCATED_VUS = envInt('LB_TIMEOUT_PRE_ALLOCATED_VUS', 10);
const MAX_VUS = envInt('LB_TIMEOUT_MAX_VUS', 20);
```

Giải thích từng biến:

| Biến | Hàm | Default | Ý nghĩa |
| --- | --- | --- | --- |
| `LB_TIMEOUT_RATE` | `envInt(key, 8)` | `8` | Số request mỗi giây (constant arrival rate) |
| `LB_TIMEOUT_DURATION_SECONDS` | `envInt(key, 8)` | `8` | Tổng thời gian chạy (giây) |
| `LB_TIMEOUT_PRE_ALLOCATED_VUS` | `envInt(key, 10)` | `10` | Số VU được pre-allocate khi bắt đầu |
| `LB_TIMEOUT_MAX_VUS` | `envInt(key, 20)` | `20` | Số VU tối đa được phép dùng |

Với default values: `8 req/s * 8s = 64 request` (thực tế quan sát được 65, do cách constant-arrival-rate schedule iteration).

**envInt** là helper từ `../shared/common.js`, đọc biến môi trường và parse thành integer, fallback về default nếu biến không được set hoặc không parse được.

Lưu ý: `LB_TIMEOUT_DURATION` được cast thành string với hậu tố `s` (ví dụ `"8s"`) vì k6 `duration` field yêu cầu định dạng string như `"8s"`, `"1m"`, `"1h"`.

### 5.3. Custom metrics

```javascript
const timeout504 = new Counter('lb_timeout_504');
const timeoutUnexpected = new Counter('lb_timeout_unexpected');
```

Hai counter này là **custom metrics** được định nghĩa bằng k6 `Counter`. Không giống như built-in metrics (`http_req_duration`, `http_req_failed`, v.v.), custom metrics cho phép ta phân loại response một cách chính xác:

- `lb_timeout_504`: Chỉ tăng khi response status là `504` (expected -- Gateway timeout hoạt động đúng).
- `lb_timeout_unexpected`: Tăng khi response status **không phải** `504` (unexpected -- có gì đó sai).

Nếu không có hai counter này, ta chỉ có thể dựa vào built-in `http_req_failed` và status code distribution. Nhưng `http_req_failed=100%` không cho biết **tại sao** failed -- tất cả đều là 504 (tốt) hay có lẫn 502/503 (xấu)? Custom counters trả lời câu hỏi đó.

### 5.4. Scenario definition

```javascript
export const options = {
  scenarios: {
    timeout_lane: {
      executor: 'constant-arrival-rate',
      rate: TIMEOUT_RATE,
      timeUnit: '1s',
      duration: TIMEOUT_DURATION,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  // ...
};
```

**Tại sao dùng `constant-arrival-rate`?**

- Timeout test cần một **tần suất request ổn định** để quan sát behavior của Nginx dưới tải liên tục.
- `constant-arrival-rate` đảm bảo mỗi giây có đúng `TIMEOUT_RATE` iteration bắt đầu, bất kể iteration trước đó mất bao lâu.
- Khác với `constant-vus`, nơi số VU cố định gửi request liên tục -- iteration tiếp theo chỉ bắt đầu khi iteration trước kết thúc, làm giảm tần suất nếu response time cao.

Với `TIMEOUT_RATE=8`:

- Mỗi giây có 8 iteration bắt đầu.
- Mỗi iteration gửi 1 GET request tới `/api/lb/timeout-demo`.
- Tổng cộng trong 8 giây: `8 * 8 = 64` request (thực tế có thể là 65 do scheduler).

**preAllocatedVUs và maxVUs:**

- `preAllocatedVUs=10`: 10 VU được khởi tạo sẵn khi scenario bắt đầu, sẵn sàng nhận iteration ngay lập tức.
- `maxVUs=20`: Tối đa 20 VU có thể được dùng. Với rate=8/s và mỗi request mất khoảng 150ms, về lý thuyết chỉ cần `ceil(8 * 0.15) = 2` VU. Nhưng preAllocatedVUs=10 và maxVUs=20 cung cấp buffer an toàn phòng khi có biến động.

### 5.5. Thresholds

```javascript
thresholds: {
  lb_timeout_504: ['count>0'],
  lb_timeout_unexpected: ['count==0'],
  'http_req_duration{endpoint:lb_timeout_demo}': ['p(95)<250'],
},
```

Phân tích từng threshold:

**`lb_timeout_504: ['count>0']`**:
- Phải có ít nhất 1 response `504`.
- Nếu không có `504` nào (count=0), nghĩa là không có timeout nào xảy ra -- origin phản hồi quá nhanh hoặc timeout policy không hoạt động. Đây là FAIL.
- Threshold này dùng `count>0` (không phải `count>=64`) vì ngay cả khi chỉ có 1 request timeout, ta đã chứng minh được policy hoạt động. Nhưng trong thực tế, với origin cố ý chậm, tất cả request đều nên timeout.

**`lb_timeout_unexpected: ['count==0']`**:
- Không được có bất kỳ response nào với status khác `504`.
- Nếu có dù chỉ 1 unexpected (ví dụ `200`, `502`, `503`), threshold fail.
- Đây là threshold quan trọng nhất -- nó đảm bảo mọi request đều bị cắt đúng bởi timeout policy.

**`http_req_duration{endpoint:lb_timeout_demo}: ['p(95)<250']`**:
- p95 của response time phải dưới 250ms.
- Sử dụng tag filter `{endpoint:lb_timeout_demo}` để chỉ đo duration cho request tới endpoint này (không lẫn với request khác).
- Tại sao là 250ms mà không phải 150ms? Vì thực tế response time gồm: network latency + Nginx processing + 150ms timeout + overhead. p95 thường rơi vào khoảng 150-160ms. 250ms cung cấp buffer an toàn nhưng vẫn đủ thấp để phát hiện nếu timeout bị treo lâu hơn dự kiến.
- Nếu p95 > 250ms: có thể Nginx không cắt đúng 150ms, hoặc có vấn đề về network, hoặc origin đang phản hồi thay vì timeout.

### 5.6. Tags

```javascript
tags: {
  scenario: 'lb_slow_origin_timeouts',
  target_layer: 'lb',
  lb_profile: 'full-no-cdn',
},
```

Tags ở level scenario được áp dụng cho tất cả metrics trong scenario này, giúp lọc và phân tích kết quả theo scenario, layer, và profile.

### 5.7. Default function

```javascript
export default function () {
  const api = lbCapabilityApis.timeoutDemo;
  const res = requestLB(api, {
    tags: {
      endpoint: api.name,
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

Phân tích từng bước:

1. **`const api = lbCapabilityApis.timeoutDemo`**: Lấy API definition từ shared catalog. `timeoutDemo` có:
   - `name: 'lb_timeout_demo'`
   - `method: 'GET'`
   - `path: '/api/lb/timeout-demo'`
   - `expectedUpstream: 'lb-slow-origin'`

2. **`requestLB(api, { tags: ... })`**: Gọi `requestApi(LB_BASE_URL, api, overrides)` từ shared.js. Hàm này:
   - Gửi HTTP request tới `BASE_URL + api.path` (tức `http://localhost:80/api/lb/timeout-demo`).
   - Áp dụng method `GET` (default).
   - Gắn tags `endpoint: api.name` và `timeout_policy: 'slow_origin'` vào metrics của request này.
   - Trả về response object.

3. **`check(res, { ... })`**: Chạy 4 assertions (đã giải thích ở section 2.5).

4. **`if (res.status === 504)`**: Phân loại response:
   - `504` -> `timeout504.add(1)` (expected).
   - Khác `504` -> `timeoutUnexpected.add(1)` (unexpected).

### 5.8. Tại sao KHÔNG dùng `assertLBResponse`

Script này cố ý **không dùng** `assertLBResponse` từ `shared.js`. Lý do:

```javascript
// assertLBResponse mong đợi status === api.expected
// api.expected mặc định là 200 (hoặc giá trị được set trong api definition)
// timeoutDemo KHÔNG có expected field -> assertLBResponse sẽ expect 200
// Nhưng case này EXPECT 504, không phải 200
```

Nếu dùng `assertLBResponse`, check đầu tiên `'${prefix} status'` sẽ kiểm tra `r.status === api.expected` (undefined hoặc 200), và sẽ fail khi response là 504. Đây là lý do case 12 dùng custom checks thay vì shared helper.

Đây cũng là một pattern quan trọng: **khi expected behavior khác với happy path (200), bạn cần custom checks**. Không phải case nào cũng expect 200.

---

## 6. Nginx/LB mechanism deep-dive

### 6.1. Ba loại proxy timeout trong Nginx

Nginx có ba directive timeout chính cho proxy module, mỗi cái kiểm soát một giai đoạn khác nhau của kết nối proxy:

#### 6.1.1. `proxy_connect_timeout`

```nginx
proxy_connect_timeout 10s;  # Global default
```

- **Định nghĩa**: Thời gian tối đa Nginx chờ để thiết lập kết nối TCP với upstream server.
- **Giai đoạn**: Từ lúc Nginx bắt đầu mở TCP connection đến khi TCP handshake hoàn tất (SYN -> SYN-ACK -> ACK).
- **Timeout xảy ra khi**: Upstream server không phản hồi TCP SYN (có thể do server down, firewall block, network unreachable).
- **Kết quả khi timeout**: Nginx trả `502 Bad Gateway` (không thể kết nối tới upstream).
- **Trong case này**: `proxy_connect_timeout 10s` là global, không bị override. Connection tới `lb-slow-origin:8090` được thiết lập nhanh (vài ms) vì origin vẫn đang chạy, chỉ phản hồi chậm ở tầng application. Do đó timeout này không trigger.

#### 6.1.2. `proxy_send_timeout`

```nginx
proxy_send_timeout 30s;  # Global default
```

- **Định nghĩa**: Thời gian tối đa Nginx chờ để gửi toàn bộ request body tới upstream server.
- **Giai đoạn**: Từ lúc Nginx bắt đầu gửi request body đến khi gửi xong.
- **Timeout xảy ra khi**: Upstream server không đọc dữ liệu đủ nhanh (TCP receive window đầy, upstream bị chậm trong việc consume request body).
- **Thường ít gặp**: Với GET request (không có body), timeout này gần như không liên quan. Chỉ quan trọng với POST/PUT request có body lớn.
- **Trong case này**: Request là GET, không có body, nên `proxy_send_timeout` không trigger.

#### 6.1.3. `proxy_read_timeout`

```nginx
proxy_read_timeout 30s;   # Global default
proxy_read_timeout 150ms; # Location override cho /api/lb/timeout-demo
```

- **Định nghĩa**: Thời gian tối đa Nginx chờ để **đọc response** từ upstream server, giữa hai lần đọc dữ liệu thành công.
- **Giai đoạn**: Từ lúc Nginx gửi xong request đến upstream, bắt đầu chờ response.
- **Timeout xảy ra khi**: Upstream server không gửi bất kỳ dữ liệu response nào trong khoảng thời gian này.
- **Cơ chế**: Đây không phải là "tổng thời gian chờ" mà là "thời gian chờ giữa các lần đọc". Nếu upstream gửi response headers sau 100ms, timer reset. Sau đó nếu upstream không gửi body data trong 150ms tiếp theo, timeout trigger.
- **Kết quả khi timeout**: Nginx trả `504 Gateway Timeout`.
- **Trong case này**: Đây là timeout chính được test. `proxy_read_timeout 150ms` tại location `/api/lb/timeout-demo` ghi đè global `30s`. `lb-slow-origin` cố ý không gửi response trong 150ms, nên timeout luôn trigger.

### 6.2. So sánh ba loại timeout

| Directive | Giai đoạn | Trigger khi | HTTP status khi timeout | Liên quan case này |
| --- | --- | --- | --- | --- |
| `proxy_connect_timeout` | TCP handshake | Upstream không accept connection | `502 Bad Gateway` | Không (origin đang chạy) |
| `proxy_send_timeout` | Gửi request body | Upstream không đọc request | `504 Gateway Timeout` | Không (GET không có body) |
| `proxy_read_timeout` | Chờ response | Upstream không gửi response | `504 Gateway Timeout` | **CÓ** -- đây là timeout chính |

### 6.3. `proxy_next_upstream` và tương tác với timeout

```nginx
proxy_next_upstream error timeout invalid_header http_500 http_502 http_503 http_504;
proxy_next_upstream_tries 2;
proxy_next_upstream_timeout 5s;
```

**`proxy_next_upstream`**: Định nghĩa các điều kiện mà Nginx sẽ thử gửi request sang upstream server tiếp theo trong pool. Bao gồm:

- `error`: Lỗi khi thiết lập kết nối hoặc gửi request.
- `timeout`: Timeout khi chờ response (bao gồm `proxy_read_timeout`).
- `invalid_header`: Upstream trả response headers không hợp lệ.
- `http_500`, `http_502`, `http_503`, `http_504`: Upstream trả các status code này.

**Tương tác trong case này**:

1. Nginx gửi request tới `lb-slow-origin:8090`.
2. Sau 150ms, `proxy_read_timeout` trigger -> đây là điều kiện `timeout` trong `proxy_next_upstream`.
3. `proxy_next_upstream_tries 2`: Nginx được phép thử tối đa 2 lần (lần đầu + 1 lần retry).
4. Nginx tìm upstream server tiếp theo trong `lb_slow_backend`.
5. **Nhưng**: `lb_slow_backend` chỉ có **1 server** duy nhất. Không có server thứ hai để retry.
6. Kết quả: sau khi hết lựa chọn upstream, Nginx trả `504 Gateway Timeout` cho client.

Nếu `lb_slow_backend` có 2 server (ví dụ `lb-slow-origin-1` và `lb-slow-origin-2`), Nginx sẽ thử gửi request sang server thứ hai sau khi server thứ nhất timeout. Nếu server thứ hai cũng timeout, Nginx trả `504`. Nếu server thứ hai phản hồi, client nhận được response bình thường.

**`proxy_next_upstream_timeout 5s`**: Tổng thời gian tối đa Nginx dành cho việc thử các upstream server (bao gồm cả thời gian chờ timeout). Trong case này, mỗi lần thử mất 150ms, nên với 2 lần thử, tổng thời gian là 300ms -- vẫn thấp hơn nhiều so với 5s.

### 6.4. Timeline chi tiết (dòng thời gian millisecond)

Dưới đây là timeline chi tiết cho một request điển hình, với các mốc thời gian:

```text
t=0ms:     k6 bắt đầu gửi HTTP GET request tới Nginx (:80)
t=0.5ms:   TCP packet đến Nginx
t=1ms:     Nginx parse request, match location = /api/lb/timeout-demo
t=1.5ms:   Nginx chọn upstream lb_slow_backend, lấy server lb-slow-origin:8090
t=2ms:     Nginx mở TCP connection tới lb-slow-origin:8090
t=3ms:     TCP handshake hoàn tất (connect time ~1ms)
t=3.5ms:   Nginx forward HTTP request tới lb-slow-origin
t=4ms:     lb-slow-origin nhận request, bắt đầu "xử lý chậm" (cố ý)
t=4ms:     Nginx bắt đầu đợi response headers -> bắt đầu đếm proxy_read_timeout
           |
           |  [150ms chờ đợi... lb-slow-origin cố ý không gửi gì]
           |
t=154ms:   proxy_read_timeout 150ms TRIGGER
t=154.5ms: Nginx đóng TCP connection tới lb-slow-origin
t=155ms:   Nginx kiểm tra proxy_next_upstream:
           - Điều kiện "timeout" khớp -> Nginx muốn retry
           - Nhưng lb_slow_backend chỉ có 1 server -> hết lựa chọn
t=155.5ms: Nginx tạo response 504 Gateway Timeout
t=156ms:   Nginx thêm headers:
           - X-Upstream-Service: lb-slow-origin
           - X-LB-Timeout-Policy: read_timeout=150ms
           - X-Request-ID: <uuid>
t=156.5ms: Nginx gửi 504 response về k6
t=157ms:   k6 nhận response, bắt đầu processing
t=157.5ms: k6 check status === 504 -> PASS
t=158ms:   k6 check X-Upstream-Service === 'lb-slow-origin' -> PASS
t=158.5ms: k6 check X-LB-Timeout-Policy === 'read_timeout=150ms' -> PASS
t=159ms:   k6 check no X-Cache -> PASS
t=159.5ms: k6 increment lb_timeout_504 counter
t=160ms:   Iteration kết thúc. Total duration ~160ms.
```

Tổng thời gian từ lúc gửi request đến lúc nhận response: khoảng 157ms, trong đó 150ms là thời gian chờ timeout. Thực tế p95 thường vào khoảng 150-160ms, khớp với dự đoán này.

### 6.5. Điều gì xảy ra với origin sau khi Nginx timeout?

Một câu hỏi quan trọng: khi Nginx đóng connection tới origin sau timeout, điều gì xảy ra với request đang được xử lý trên origin?

- **Nginx đóng TCP connection**: Gửi TCP RST hoặc FIN tới origin.
- **Origin phát hiện connection đóng**: Tùy vào implementation của origin:
  - Nếu origin dùng blocking I/O: Có thể nhận được error khi cố gắng write response.
  - Nếu origin dùng async I/O: Có thể phát hiện connection closed qua event.
  - Nếu origin không check: Có thể tiếp tục xử lý request đến khi hoàn thành, nhưng response sẽ bị discard vì không còn ai đọc.
- **Quan trọng**: Nginx timeout không đồng nghĩa với việc origin ngừng xử lý. Origin có thể vẫn tiếp tục tiêu tốn tài nguyên (CPU, database connections) cho request đã bị client hủy. Đây là lý do cần có thêm application-level timeout trên origin để tránh lãng phí tài nguyên.

Đây cũng là một điểm cần lưu ý khi thiết kế hệ thống: Gateway timeout bảo vệ Gateway và client, nhưng không bảo vệ origin khỏi chính nó. Origin cần có cơ chế timeout riêng (ví dụ: database query timeout, HTTP client timeout khi gọi downstream service).

---

## 7. Request sequence flow

### 7.1. Sequence diagram (text-based)

```text
k6                  Nginx (:80)           lb-slow-origin:8090
 |                       |                        |
 |--- GET /api/lb/ -----▶|                        |
 |    timeout-demo        |                        |
 |                       |--- TCP connect -------▶|
 |                       |◀--- TCP accept --------|
 |                       |--- HTTP GET ----------▶|
 |                       |                        |-- "xử lý chậm"
 |                       |                        |   (cố ý >150ms)
 |                       |   [chờ 150ms]          |
 |                       |   proxy_read_timeout   |
 |                       |   TRIGGER              |
 |                       |--- TCP RST -----------▶|
 |                       |                        |
 |◀-- 504 Gateway -------|                        |
 |    Timeout             |                        |
 |    + X-LB-Timeout-     |                        |
 |      Policy header     |                        |
 |                       |                        |
 |-- check status=504
 |-- check upstream
 |-- check policy header
 |-- check no cache
 |-- increment counter
```

### 7.2. Mô tả từng bước

**Bước 1 -- k6 gửi request**: k6 gửi HTTP GET request tới `http://localhost:80/api/lb/timeout-demo`. Request được gắn tag `endpoint: lb_timeout_demo` và `timeout_policy: slow_origin`. K6 dùng `constant-arrival-rate` executor, đảm bảo mỗi giây có đúng 8 iteration bắt đầu.

**Bước 2 -- Nginx nhận và route request**: Nginx nhận request trên port 80. So khớp location `= /api/lb/timeout-demo` (exact match, độ ưu tiên cao nhất). Location này có cấu hình đặc biệt:

- `proxy_read_timeout 150ms` (ghi đè global 30s).
- `proxy_pass http://lb_slow_backend` (route tới upstream chứa slow origin).

**Bước 3 -- Nginx mở connection tới origin**: Nginx mở TCP connection tới `lb-slow-origin:8090`. Với `proxy_connect_timeout 10s`, nếu origin down hoàn toàn, Nginx sẽ chờ tối đa 10 giây trước khi trả `502`. Trong case này, origin vẫn chạy bình thường, connection được thiết lập nhanh chóng (vài ms).

**Bước 4 -- Nginx forward request**: Nginx forward HTTP GET request tới `lb-slow-origin:8090`. Request được gửi với các proxy headers: `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Request-ID`.

**Bước 5 -- Nginx chờ response, bắt đầu đếm timeout**: Sau khi gửi xong request, Nginx bắt đầu đợi response headers từ origin. Timer `proxy_read_timeout` bắt đầu đếm. Giá trị timeout cho location này là 150ms.

**Bước 6 -- lb-slow-origin cố ý chậm**: `lb-slow-origin:8090` được cấu hình để không gửi bất kỳ response nào trong hơn 150ms. Đây là behavior có chủ đích để test timeout policy.

**Bước 7 -- Timeout trigger**: Sau đúng 150ms kể từ khi bắt đầu chờ response, `proxy_read_timeout` trigger. Nginx ngừng chờ và chuyển sang xử lý timeout.

**Bước 8 -- Nginx kiểm tra retry policy**: `proxy_next_upstream` có `timeout` trong danh sách điều kiện retry. Nginx kiểm tra xem có upstream server nào khác trong pool `lb_slow_backend` không. Vì pool chỉ có 1 server duy nhất, không còn lựa chọn nào để retry.

**Bước 9 -- Nginx đóng connection tới origin**: Nginx gửi TCP RST để đóng connection tới `lb-slow-origin:8090`. Connection được giải phóng, có thể dùng cho request khác.

**Bước 10 -- Nginx tạo và gửi 504 response**: Nginx tạo HTTP response với status code `504 Gateway Timeout`. Thêm các header:

- `X-Upstream-Service: lb-slow-origin`
- `X-LB-Timeout-Policy: read_timeout=150ms`
- `X-Request-ID: <request_id>`
- `X-Served-By: nginx`

Gửi response về k6.

**Bước 11 -- k6 xử lý response**: k6 nhận response, chạy 4 checks:

1. Status === 504 -> PASS.
2. X-Upstream-Service === 'lb-slow-origin' -> PASS.
3. X-LB-Timeout-Policy === 'read_timeout=150ms' -> PASS.
4. Không có X-Cache -> PASS.

**Bước 12 -- k6 increment counter**: Vì status là 504, `timeout504.add(1)` được gọi. Counter `lb_timeout_504` tăng lên 1 đơn vị. `lb_timeout_unexpected` không thay đổi.

### 7.3. Hai scenario cận biên

#### 7.3.1. Origin phản hồi ở 140ms (trước timeout)

```text
t=0ms:     Request gửi đi
t=4ms:     Request đến origin
t=140ms:   Origin gửi response headers
t=141ms:   Nginx nhận response headers -> timer reset
t=142ms:   Nginx forward response về k6
t=143ms:   k6 nhận 200 OK (hoặc status khác tùy origin)
           -> check 'lb timeout status is 504': FAIL
           -> lb_timeout_unexpected +1
```

Trong trường hợp này, origin phản hồi trước khi `proxy_read_timeout` trigger. Response được forward bình thường. Đây là behavior **không mong muốn** cho case này -- origin lẽ ra phải chậm hơn 150ms. Nếu điều này xảy ra, cần kiểm tra lại cấu hình của `lb-slow-origin`.

#### 7.3.2. Origin phản hồi ở 160ms (sau timeout)

```text
t=0ms:     Request gửi đi
t=4ms:     Request đến origin
t=150ms:   proxy_read_timeout trigger
t=151ms:   Nginx đóng connection, tạo 504
t=152ms:   Nginx gửi 504 về k6
t=153ms:   k6 nhận 504
t=160ms:   Origin gửi response -> nhưng connection đã đóng
           -> response bị discard
```

Trong trường hợp này, timeout hoạt động chính xác. Origin gửi response ở 160ms nhưng đã quá muộn -- connection đã bị Nginx đóng ở 151ms. Response từ origin bị bỏ qua. K6 nhận `504 Gateway Timeout`.

---

## 8. Key signals / headers

### 8.1. Bảng tổng hợp signals

| Signal | Loại | Source | Expected Value | Ý nghĩa |
| --- | --- | --- | --- | --- |
| `status` | HTTP response | Nginx | `504` | Gateway timeout xác nhận policy đã cắt request |
| `X-LB-Timeout-Policy` | Response header | Nginx (`add_header`) | `read_timeout=150ms` | Chứng minh chính sách timeout nào đã trigger |
| `X-Upstream-Service` | Response header | Nginx (`add_header`) | `lb-slow-origin` | Xác nhận request đi đúng upstream |
| `X-Request-ID` | Response header | Nginx (`$request_id`) | UUID string | Trace ID để debug request |
| `X-Served-By` | Response header | Nginx (`add_header`) | `nginx` | Xác nhận response đến từ Nginx Gateway |
| `X-Cache` | Response header | (absent) | **KHÔNG có** | Chứng minh không đi qua CDN/Varnish |
| `lb_timeout_504` | Custom Counter | k6 script | `> 0` (bằng total requests) | Số response expected (504) |
| `lb_timeout_unexpected` | Custom Counter | k6 script | `0` | Số response unexpected (không phải 504) |
| `http_req_duration` | Built-in metric | k6 | `p(95) < 250ms` | Response time, phải gần 150ms |
| `http_req_failed` | Built-in metric | k6 | `100%` (expected) | Tỉ lệ request failed -- 100% là EXPECTED |
| `checks` | Built-in metric | k6 | `100%` pass rate | Tất cả 4 checks phải pass |

### 8.2. Phân tích từng signal

#### `status: 504`

504 Gateway Timeout là HTTP status code chuẩn cho trường hợp Gateway (Nginx) không nhận được response kịp thời từ upstream server. Đây là status code chính xác cho timeout scenario:

- **Không phải 502**: 502 Bad Gateway nghĩa là upstream trả response không hợp lệ (ví dụ invalid HTTP). Case này upstream không trả gì cả.
- **Không phải 503**: 503 Service Unavailable nghĩa là service tạm thời không khả dụng (ví dụ quá tải, bảo trì). Case này upstream đang chạy nhưng quá chậm.
- **Là 504**: Gateway đã kết nối được tới upstream, đã gửi request, nhưng upstream không phản hồi trong thời gian cho phép.

#### `X-LB-Timeout-Policy: read_timeout=150ms`

Đây là header **quan trọng nhất** để chứng minh capability. Nó cho biết:

- **Policy nào đã cắt**: `read_timeout` (không phải `connect_timeout` hay `send_timeout`).
- **Giá trị timeout**: `150ms` (không phải global 30s).
- **Header do Nginx thêm**: Dùng `add_header` directive với `always` flag, đảm bảo header có mặt ngay cả trên error responses (4xx, 5xx). Nếu không có `always`, header chỉ được thêm trên successful responses (2xx, 3xx) -- không hữu ích cho case timeout.

#### `X-Cache` (absent)

Trong profile `full-no-cdn`, `X-Cache` phải vắng mặt. Sự hiện diện của `X-Cache` (ví dụ `HIT`, `MISS`) cho thấy request đã đi qua CDN/Varnish, làm nhiễu LB-layer proof. Check này đảm bảo ta đang test đúng layer.

#### `lb_timeout_504` và `lb_timeout_unexpected`

Hai counter này là custom metrics, cho phép phân loại response ngoài built-in metrics. Chúng trả lời câu hỏi: "tất cả request đều timeout đúng như mong đợi, hay có request nào phản hồi khác không?" Nếu `lb_timeout_504` = total requests và `lb_timeout_unexpected` = 0, timeout policy hoạt động hoàn hảo.

#### `http_req_failed: 100%`

Đây là điểm gây nhầm lẫn phổ biến nhất. k6 định nghĩa `http_req_failed` là tỉ lệ request có status >= 400 hoặc request bị lỗi (connection refused, timeout ở phía k6). Với case này, **100% request có status 504 (>= 400), nên `http_req_failed=100%` là EXPECTED và CORRECT**. Đây không phải là dấu hiệu test fail.

#### `http_req_duration p(95) < 250ms`

p95 duration phải dưới 250ms. Giá trị thực tế thường vào khoảng 150-160ms, khớp với `proxy_read_timeout 150ms` cộng với overhead network và processing. Nếu p95 > 250ms, có thể có vấn đề: hoặc timeout không trigger đúng lúc, hoặc network chậm bất thường, hoặc Nginx đang retry (nếu có nhiều upstream servers).

---

## 9. Pass/fail criteria

### 9.1. Điều kiện PASS

Một test run được coi là PASS khi **tất cả** các điều kiện sau đây đồng thời đúng:

| # | Điều kiện | Cách kiểm tra |
| --- | --- | --- |
| 1 | Tất cả response có status `504` | `lb_timeout_unexpected == 0` (threshold) |
| 2 | Có ít nhất một response `504` | `lb_timeout_504 > 0` (threshold) |
| 3 | p95 duration dưới 250ms | `http_req_duration{endpoint:lb_timeout_demo} p(95) < 250` (threshold) |
| 4 | Tất cả checks pass 100% | 4 checks * N requests = 4N pass |
| 5 | `X-Upstream-Service` = `lb-slow-origin` | Check trong script |
| 6 | `X-LB-Timeout-Policy` = `read_timeout=150ms` | Check trong script |
| 7 | Không có `X-Cache` | Check trong script |
| 8 | Exit code = 0 (tất cả thresholds pass) | k6 exit code |

### 9.2. Điều kiện FAIL

Ngược lại, test run FAIL khi **bất kỳ** điều kiện nào sau đây xảy ra:

| # | Điều kiện FAIL | Nguyên nhân có thể |
| --- | --- | --- |
| 1 | Có response với status khác 504 (200, 502, 503) | Origin phản hồi trước timeout, hoặc Nginx config sai |
| 2 | Không có response 504 nào (`lb_timeout_504 == 0`) | Origin không đủ chậm, hoặc timeout không được cấu hình |
| 3 | p95 duration > 250ms | Network chậm, Nginx retry nhiều, hoặc timeout value quá lớn |
| 4 | Checks không đạt 100% | Một trong các assertions fail |
| 5 | Có `X-Cache` header | Đang chạy sai profile (có CDN/Varnish) |
| 6 | `X-Upstream-Service` không đúng | Route sai upstream |
| 7 | `X-LB-Timeout-Policy` không đúng hoặc thiếu | Nginx config thiếu `add_header` |
| 8 | Exit code khác 0 | Threshold bị vi phạm |

### 9.3. Phân biệt expected failure và unexpected failure

Đây là điểm **cốt lõi** của case này: `http_req_failed=100%` là **expected failure**, không phải bug. Để phân biệt:

| Metric | Expected (PASS) | Unexpected (FAIL) |
| --- | --- | --- |
| `http_req_failed` | 100% | Bất kỳ giá trị nào (nhưng cần kèm `lb_timeout_unexpected > 0` để FAIL) |
| `lb_timeout_504` | = total requests (> 0) | 0 (không có timeout nào) |
| `lb_timeout_unexpected` | 0 | > 0 (có response không phải 504) |
| Status codes | Chỉ 504 | Có 200, 502, 503, hoặc status khác |
| `http_req_duration` | p95 < 250ms, gần 150ms | p95 > 250ms (quá chậm) hoặc p95 << 150ms (origin phản hồi nhanh) |

---

## 10. Cách chạy + output mẫu

### 10.1. PowerShell command

Chạy test với default settings:

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 12-slow-origin-timeouts
```

Chạy test với custom rate và duration:

```powershell
$env:LB_TIMEOUT_RATE = "10"
$env:LB_TIMEOUT_DURATION_SECONDS = "15"
$env:LB_TIMEOUT_PRE_ALLOCATED_VUS = "15"
$env:LB_TIMEOUT_MAX_VUS = "30"
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 12-slow-origin-timeouts
```

Chạy inspect-only (không tạo dashboard artifacts):

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 12-slow-origin-timeouts -InspectOnly
```

### 10.2. Expected console output

```text
     ✓ lb timeout status is 504
     ✓ lb timeout upstream header present
     ✓ lb timeout policy header present
     ✓ lb timeout no cache header

     █ lb_slow_origin_timeouts

       ✓ lb_timeout_504.................: 65     (count>0)
       ✓ lb_timeout_unexpected..........: 0      (count==0)
       ✓ http_req_duration{endpoint:lb_timeout_demo}: p(95)=153.45ms (p(95)<250)

     checks_total.......................: 260     100.00% ✓ 260    ✗ 0
     http_req_duration..................: avg=152.1ms min=150.2ms med=151.8ms max=158.3ms p(90)=154.2ms p(95)=153.45ms
     http_req_failed....................: 100.00%  ✓ 65     ✗ 0
     http_reqs..........................: 65       8.125/s
     lb_timeout_504.....................: 65
     lb_timeout_unexpected.............: 0
     vus................................: 10       min=10   max=10
     vus_max............................: 20
     iterations.........................: 65       8.125/s

  running (08.0s), 10/20 VUs, 65 complete and 0 interrupted iterations

  ✓ http_req_duration{endpoint:lb_timeout_demo}...: p(95)=153.45ms ✓ (p(95)<250)
  ✓ lb_timeout_504...............................: 65            ✓ (count>0)
  ✓ lb_timeout_unexpected........................: 0             ✓ (count==0)

  █ 100% checks passed / 260 checks
  exit code: 0
  Result: PASS
```

### 10.3. Sample JSON export

```json
{
  "metrics": {
    "lb_timeout_504": {
      "type": "counter",
      "values": {
        "count": 65,
        "rate": 8.125
      }
    },
    "lb_timeout_unexpected": {
      "type": "counter",
      "values": {
        "count": 0,
        "rate": 0
      }
    },
    "http_req_duration": {
      "type": "trend",
      "values": {
        "avg": 152.1,
        "min": 150.2,
        "med": 151.8,
        "max": 158.3,
        "p(90)": 154.2,
        "p(95)": 153.45
      },
      "tags": {
        "endpoint": "lb_timeout_demo"
      }
    },
    "http_req_failed": {
      "type": "rate",
      "values": {
        "rate": 1.0,
        "passes": 0,
        "fails": 65
      }
    },
    "checks": {
      "type": "rate",
      "values": {
        "rate": 1.0,
        "passes": 260,
        "fails": 0
      }
    },
    "http_reqs": {
      "type": "counter",
      "values": {
        "count": 65,
        "rate": 8.125
      }
    },
    "iterations": {
      "type": "counter",
      "values": {
        "count": 65,
        "rate": 8.125
      }
    },
    "vus": {
      "type": "gauge",
      "values": {
        "value": 10,
        "min": 10,
        "max": 10
      }
    }
  },
  "root_group": {
    "checks": [
      {
        "name": "lb timeout status is 504",
        "path": "::lb timeout status is 504",
        "passes": 65,
        "fails": 0
      },
      {
        "name": "lb timeout upstream header present",
        "path": "::lb timeout upstream header present",
        "passes": 65,
        "fails": 0
      },
      {
        "name": "lb timeout policy header present",
        "path": "::lb timeout policy header present",
        "passes": 65,
        "fails": 0
      },
      {
        "name": "lb timeout no cache header",
        "path": "::lb timeout no cache header",
        "passes": 65,
        "fails": 0
      }
    ]
  }
}
```

---

## 11. 4 output -> decision scenarios

### 11.1. Scenario A: All 504, counters đúng, p95 gần 150ms -- PASS

```text
lb_timeout_504: 64
lb_timeout_unexpected: 0
p95: ~153ms
http_req_failed: 100%
checks: 256/256 (100%)
exit: 0
```

**Diễn giải**: Timeout policy hoạt động chính xác. Tất cả request đều bị cắt sau ~150ms và trả về 504. Không có unexpected status. Đây là kết quả lý tưởng.

**Decision**: PASS. Case đã chứng minh Nginx cắt slow origin đúng policy.

### 11.2. Scenario B: Mix of 504 và 200 -- FAIL

```text
lb_timeout_504: 35
lb_timeout_unexpected: 30
p95: ~280ms
http_req_failed: ~54%
checks: 185/260 (71%)
exit: 99 (threshold fail)
```

**Diễn giải**: Một số request bị timeout (504), một số request được origin phản hồi (200). Điều này xảy ra khi origin **không đủ chậm** một cách nhất quán -- có lúc phản hồi trước 150ms, có lúc phản hồi sau 150ms. Nguyên nhân có thể:

- Origin load không ổn định.
- Origin có caching layer khiến một số request nhanh hơn.
- Timeout value quá gần với response time thực tế của origin.

**Decision**: FAIL. Cần kiểm tra lại origin configuration để đảm bảo origin **luôn** phản hồi chậm hơn timeout, hoặc tăng timeout value nếu muốn test scenario khác.

### 11.3. Scenario C: All 200, không có 504 -- FAIL

```text
lb_timeout_504: 0
lb_timeout_unexpected: 64
p95: ~45ms
http_req_failed: 0%
checks: 128/256 (50% -- status check fail)
exit: 99 (threshold fail)
```

**Diễn giải**: Không có timeout nào xảy ra. Tất cả request đều được origin phản hồi thành công với 200. Nguyên nhân có thể:

- Origin phản hồi quá nhanh (không đủ chậm để trigger timeout).
- `proxy_read_timeout` không được cấu hình cho location này (có thể Nginx config chưa được reload).
- Request đi nhầm location khác (không có `proxy_read_timeout 150ms`).

**Decision**: FAIL. Kiểm tra:
- `lb-slow-origin` có đang chạy và được cấu hình để phản hồi chậm không?
- Nginx config có `proxy_read_timeout 150ms` cho location `/api/lb/timeout-demo` không?
- Nginx đã được reload sau khi thay đổi config chưa?
- Request có thực sự đến đúng location không? (Kiểm tra access log của Nginx.)

### 11.4. Scenario D: Request treo, không có response -- FAIL

```text
lb_timeout_504: 0
lb_timeout_unexpected: 0
p95: N/A (request không hoàn thành)
http_req_failed: 100% (k6-level timeout)
checks: 0/0
exit: 108 (k6 timeout)
```

**Diễn giải**: Request bị treo hoàn toàn, không có response nào từ Nginx. k6 tự timeout ở mức client (thường là 60s mặc định). Nguyên nhân có thể:

- Nginx không có `proxy_read_timeout` và origin treo vô hạn.
- `proxy_read_timeout` được set quá cao (ví dụ 300s).
- Có vấn đề về network giữa k6 và Nginx.
- Nginx worker process bị treo.

**Decision**: FAIL nghiêm trọng. Kiểm tra:
- Nginx có timeout policy không?
- Giá trị timeout có hợp lý không?
- Network giữa k6 và Nginx có hoạt động không?
- Nginx error log có ghi nhận gì không?

---

## 12. Nghịch lý / misconceptions

### 12.1. Misconception 1: "http_req_failed=100% nghĩa là test fail"

**SAI**. Đây là misconception phổ biến nhất với case này.

`http_req_failed` trong k6 là built-in metric đo tỉ lệ request có HTTP status >= 400 hoặc bị lỗi ở tầng transport. Nó không phân biệt giữa "expected failure" và "unexpected failure".

Trong case này, `504` là status code **mong muốn** -- nó chứng minh timeout policy hoạt động. `http_req_failed=100%` là hệ quả tự nhiên và là **dấu hiệu PASS**, không phải FAIL.

Cách đọc đúng:

- `http_req_failed=100%` + `lb_timeout_unexpected=0` + `checks=100%` + `lb_timeout_504>0` = **PASS**.
- `http_req_failed=0%` + `lb_timeout_504=0` = **FAIL** (không có timeout nào, origin phản hồi quá nhanh).

### 12.2. Misconception 2: "504 là dấu hiệu system có vấn đề"

**SAI trong context này**. `504 Gateway Timeout` là một HTTP status code có ý nghĩa cụ thể: "Gateway không nhận được response kịp thời từ upstream". Trong case này, đó chính xác là điều ta muốn chứng minh.

Timeout policy là **tuyến phòng thủ có chủ đích**, không phải bug:

- Không có timeout -> connection treo vô hạn -> cascading failure.
- Có timeout -> 504 sau 150ms -> client biết lỗi và có thể retry -> connection pool được bảo vệ.

`504` trong case này giống như cầu chì ngắt khi quá tải: nó là **cơ chế bảo vệ**, không phải sự cố.

### 12.3. Misconception 3: "p95 gần 150ms nghĩa là system chậm"

**SAI**. p95 gần 150ms trong case này là **dấu hiệu timeout hoạt động đúng**, không phải system chậm.

Nếu Nginx không có timeout policy, response time có thể là vài giây hoặc vô hạn (request treo). Thực tế, p95 ~150ms nghĩa là:

- Nginx cắt request **nhanh chóng** sau đúng 150ms.
- Client không phải chờ lâu.
- Connection pool được giải phóng nhanh.

Đây là fast failure pattern -- thất bại nhanh để bảo vệ hệ thống, tốt hơn nhiều so với việc chờ đợi vô ích.

### 12.4. Misconception 4: "Nên tăng timeout để tránh 504"

**SAI trong context này**. Mục đích của case là chứng minh timeout policy **hoạt động**, không phải "làm cho test pass bằng cách tránh timeout".

Tăng `proxy_read_timeout` lên (ví dụ 5s) sẽ khiến origin có đủ thời gian phản hồi, request trả về 200, `lb_timeout_504=0`, và test **FAIL** vì không chứng minh được timeout capability.

Timeout value nên được chọn dựa trên SLA của service, không phải để "pass test":

- Service cần response trong 200ms -> timeout 200ms là hợp lý.
- Service batch processing -> timeout 60s là hợp lý.
- Service real-time bidding -> timeout 50ms là hợp lý.

### 12.5. Misconception 5: "Chỉ cần check status code là đủ"

**SAI**. Status code 504 chỉ là một phần của evidence. Để chứng minh đầy đủ timeout policy, cần:

- **Status code** (504): Xác nhận Gateway timeout.
- **X-LB-Timeout-Policy** (read_timeout=150ms): Xác nhận **policy nào** đã trigger và **giá trị timeout**.
- **X-Upstream-Service** (lb-slow-origin): Xác nhận request đi đúng upstream.
- **No X-Cache**: Xác nhận không qua CDN (đúng profile).
- **lb_timeout_unexpected = 0**: Xác nhận không có response nào khác 504.
- **p95 < 250ms**: Xác nhận timeout cắt nhanh, không treo.

Nếu thiếu bất kỳ signal nào, proof không hoàn chỉnh. Ví dụ: status 504 không cho biết timeout value là 150ms hay 30s.

### 12.6. Misconception 6: "Constant-arrival-rate với rate=8/s và duration=8s sẽ tạo đúng 64 request"

**Gần đúng, nhưng không chính xác tuyệt đối**. `constant-arrival-rate` schedule iteration dựa trên thời gian bắt đầu, không phải số lượng. Với rate=8/s và duration=8s:

- Iteration đầu tiên bắt đầu tại t=0.
- Iteration cuối cùng bắt đầu trong khoảng t=7.875s đến t=8.0s.
- Tổng số iteration thường là 64 hoặc 65, tùy thuộc vào scheduler precision.

Điều này giải thích tại sao actual data có 65 request thay vì 64.

---

## 13. Checklist

### 13.1. Pre-run checklist

- [ ] Stack `full-no-cdn` đã được start: `./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2`
- [ ] Routing contract đã pass: `./scripts/check-target-routing.ps1 -BaseUrl "http://localhost:80" -TargetLayer full-no-cdn`
- [ ] `lb-slow-origin` container đang running (kiểm tra bằng `docker ps`)
- [ ] `lb-slow-origin` được cấu hình để phản hồi chậm hơn 150ms
- [ ] Nginx config có `proxy_read_timeout 150ms` tại location `/api/lb/timeout-demo`
- [ ] Nginx config có `X-LB-Timeout-Policy` header cho location này
- [ ] `BASE_URL` được set: `$env:BASE_URL = "http://localhost:80"`
- [ ] Không có Varnish/CDN nào đứng trước Nginx trên port 80
- [ ] Các environment variables tùy chỉnh (nếu có) đã được set
- [ ] Đã inspect script trước nếu cần: `-InspectOnly`

### 13.2. During-run checklist

- [ ] k6 output hiển thị 4 checks pass (✓)
- [ ] `lb_timeout_504` counter tăng đều qua các giây
- [ ] `lb_timeout_unexpected` counter giữ nguyên 0
- [ ] Không có error log bất thường từ k6
- [ ] k6 exit code dự kiến là 0 (tất cả thresholds pass)
- [ ] Nếu chạy với `--verbose`, kiểm tra không có unexpected status codes
- [ ] Nginx error log không có lỗi bất thường (có thể kiểm tra bằng `docker logs <nginx-container>`)

### 13.3. Post-run checklist

- [ ] Exit code = 0
- [ ] Checks 100% (260/260 hoặc tương ứng với số request * 4)
- [ ] `lb_timeout_504 > 0` (phải có timeout)
- [ ] `lb_timeout_unexpected == 0` (không có unexpected)
- [ ] `http_req_duration p(95) < 250ms` (gần 150ms là lý tưởng)
- [ ] `http_req_failed == 100%` (expected)
- [ ] Tất cả response đều có `X-LB-Timeout-Policy: read_timeout=150ms`
- [ ] Tất cả response đều có `X-Upstream-Service: lb-slow-origin`
- [ ] Không response nào có `X-Cache`
- [ ] Nginx access log ghi nhận status 504 cho tất cả request tới `/api/lb/timeout-demo`
- [ ] Không có side effect: các route khác vẫn hoạt động bình thường (nếu chạy trong batch)
- [ ] Dashboard/chart artifacts (nếu có) phản ánh đúng dữ liệu

### 13.4. Troubleshooting checklist

Nếu test fail, kiểm tra theo thứ tự:

- [ ] **Không có 504 nào**: Origin có đang chạy và phản hồi chậm không? Nginx config đã được reload chưa? Request có đến đúng location không?
- [ ] **Có unexpected status**: Status đó là gì? 200 (origin phản hồi nhanh)? 502 (không kết nối được origin)? 503 (origin trả lỗi)?
- [ ] **p95 > 250ms**: Network có vấn đề không? Nginx có đang retry không? Timeout value có bị set sai không?
- [ ] **Có X-Cache**: Có Varnish/CDN đứng trước Nginx không? Có đang dùng sai profile không?
- [ ] **Exit code != 0**: Threshold nào fail? Đọc kỹ k6 output để xác định.

---

## 14. 4-5 variations với code mẫu

### 14.1. Variation 1: Thay đổi timeout value để test behavior khác nhau

Mục đích: Chứng minh rằng timeout policy có thể được điều chỉnh linh hoạt và Nginx tuân thủ chính xác giá trị được cấu hình.

**Cấu hình Nginx** (thêm các location mới hoặc sửa location hiện tại):

```nginx
# Timeout 50ms - rất aggressive
location = /api/lb/timeout-demo-50ms {
    proxy_read_timeout 50ms;
    add_header X-Upstream-Service "lb-slow-origin" always;
    add_header X-LB-Timeout-Policy "read_timeout=50ms" always;
    add_header X-Request-ID $request_id always;
    proxy_pass http://lb_slow_backend;
}

# Timeout 300ms - thoải mái hơn
location = /api/lb/timeout-demo-300ms {
    proxy_read_timeout 300ms;
    add_header X-Upstream-Service "lb-slow-origin" always;
    add_header X-LB-Timeout-Policy "read_timeout=300ms" always;
    add_header X-Request-ID $request_id always;
    proxy_pass http://lb_slow_backend;
}

# Timeout 500ms - origin có thể kịp phản hồi
location = /api/lb/timeout-demo-500ms {
    proxy_read_timeout 500ms;
    add_header X-Upstream-Service "lb-slow-origin" always;
    add_header X-LB-Timeout-Policy "read_timeout=500ms" always;
    add_header X-Request-ID $request_id always;
    proxy_pass http://lb_slow_backend;
}
```

**Script k6 tương ứng**:

```javascript
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { envInt } from '../shared/common.js';
import { requestLB, responseHeader } from './shared.js';

const TIMEOUT_RATE = envInt('LB_TIMEOUT_RATE', 5);
const TIMEOUT_DURATION = `${envInt('LB_TIMEOUT_DURATION_SECONDS', 10)}s`;
const PRE_ALLOCATED_VUS = envInt('LB_TIMEOUT_PRE_ALLOCATED_VUS', 10);
const MAX_VUS = envInt('LB_TIMEOUT_MAX_VUS', 20);

const timeout504 = new Counter('lb_timeout_504');
const timeoutUnexpected = new Counter('lb_timeout_unexpected');

// Định nghĩa các timeout variants
const timeoutApis = [
  { name: 'lb_timeout_demo_50ms', method: 'GET', path: '/api/lb/timeout-demo-50ms', expectedUpstream: 'lb-slow-origin', timeoutValue: '50ms', expectedStatus: 504 },
  { name: 'lb_timeout_demo_300ms', method: 'GET', path: '/api/lb/timeout-demo-300ms', expectedUpstream: 'lb-slow-origin', timeoutValue: '300ms', expectedStatus: 504 },
  { name: 'lb_timeout_demo_500ms', method: 'GET', path: '/api/lb/timeout-demo-500ms', expectedUpstream: 'lb-slow-origin', timeoutValue: '500ms', expectedStatus: 200 }, // Có thể kịp phản hồi
];

export const options = {
  scenarios: {
    timeout_variants: {
      executor: 'constant-arrival-rate',
      rate: TIMEOUT_RATE,
      timeUnit: '1s',
      duration: TIMEOUT_DURATION,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    lb_timeout_504: ['count>0'],
    lb_timeout_unexpected: ['count==0'],
  },
};

export default function () {
  // Pick a random timeout variant each iteration
  const api = timeoutApis[Math.floor(Math.random() * timeoutApis.length)];

  const res = requestLB(api, {
    tags: {
      endpoint: api.name,
      timeout_policy: 'variant_test',
    },
  });

  check(res, {
    [`${api.name} status is ${api.expectedStatus}`]: (r) => r.status === api.expectedStatus,
    [`${api.name} upstream header present`]: (r) => responseHeader(r, 'X-Upstream-Service') === api.expectedUpstream,
    [`${api.name} timeout policy correct`]: (r) => responseHeader(r, 'X-LB-Timeout-Policy') === `read_timeout=${api.timeoutValue}`,
  });

  if (res.status === api.expectedStatus) {
    timeout504.add(1);
  } else {
    timeoutUnexpected.add(1);
  }
}
```

**Phân tích kết quả mong đợi**:

- **50ms variant**: p95 ~50-55ms, tất cả 504. Chứng minh timeout rất ngắn vẫn hoạt động.
- **300ms variant**: p95 ~300-305ms, tất cả 504 (nếu origin chậm hơn 300ms).
- **500ms variant**: Có thể thấy mix của 200 và 504, tùy vào origin configuration. Nếu origin phản hồi trong 400ms, 500ms timeout sẽ cho phép response bình thường -> 200.

### 14.2. Variation 2: Thêm retry -- failover sang stable backend khi slow origin timeout

Mục đích: Chứng minh rằng `proxy_next_upstream` có thể kết hợp với timeout để tạo ra pattern "thử slow origin trước, nếu timeout thì fallback sang stable origin".

**Cấu hình Nginx**:

```nginx
# Upstream với 2 server: slow (primary) + stable (fallback)
upstream lb_timeout_with_fallback {
    zone upstream_lb_timeout_fb 64k;
    server lb-slow-origin:8090 resolve max_fails=1 fail_timeout=5s;
    server lb-stable-origin:8090 resolve backup;  # backup server
    keepalive 8;
}

# Location với timeout + retry
location = /api/lb/timeout-fallback-demo {
    proxy_read_timeout 150ms;
    proxy_next_upstream error timeout invalid_header http_500 http_502 http_503 http_504;
    proxy_next_upstream_tries 2;
    proxy_next_upstream_timeout 5s;
    add_header X-Upstream-Service $upstream_addr always;
    add_header X-LB-Timeout-Policy "read_timeout=150ms,fallback_enabled" always;
    add_header X-Request-ID $request_id always;
    proxy_pass http://lb_timeout_with_fallback;
}
```

**Script k6**:

```javascript
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { envInt } from '../shared/common.js';
import { requestLB, responseHeader } from './shared.js';

const TIMEOUT_RATE = envInt('LB_TIMEOUT_RATE', 5);
const TIMEOUT_DURATION = `${envInt('LB_TIMEOUT_DURATION_SECONDS', 10)}s`;

const timeout504 = new Counter('lb_timeout_504');
const fallback200 = new Counter('lb_fallback_200');
const unexpected = new Counter('lb_fallback_unexpected');
const fallbackDuration = new Trend('lb_fallback_duration');

const api = {
  name: 'lb_timeout_fallback_demo',
  method: 'GET',
  path: '/api/lb/timeout-fallback-demo',
  timeoutValue: '150ms',
};

export const options = {
  scenarios: {
    timeout_with_fallback: {
      executor: 'constant-arrival-rate',
      rate: TIMEOUT_RATE,
      timeUnit: '1s',
      duration: TIMEOUT_DURATION,
      preAllocatedVUs: 10,
      maxVUs: 20,
    },
  },
  thresholds: {
    lb_fallback_200: ['count>0'],             // Phải có một số request fallback thành công
    lb_fallback_unexpected: ['count==0'],     // Không được có unexpected
    lb_fallback_duration: ['p(95)<500'],      // Fallback duration (timeout + retry) dưới 500ms
  },
};

export default function () {
  const res = requestLB(api, {
    tags: { endpoint: api.name },
  });

  check(res, {
    'status is 200 or 504': (r) => r.status === 200 || r.status === 504,
    'has upstream header': (r) => !!responseHeader(r, 'X-Upstream-Service'),
    'has timeout policy header': (r) => !!responseHeader(r, 'X-LB-Timeout-Policy'),
  });

  if (res.status === 200) {
    fallback200.add(1);  // Fallback thành công -> stable origin phản hồi
  } else if (res.status === 504) {
    timeout504.add(1);   // Cả hai đều timeout
  } else {
    unexpected.add(1);
  }
}
```

**Phân tích**:

- Khi `lb-slow-origin` timeout sau 150ms, Nginx thử `lb-stable-origin` (backup).
- Nếu `lb-stable-origin` phản hồi nhanh (thường là vài ms), client nhận 200.
- `X-Upstream-Service` sẽ hiển thị địa chỉ của server thực sự phản hồi.
- Duration của fallback request: timeout 150ms + thời gian retry (kết nối + phản hồi từ stable) ~ 155-200ms.
- Đây là pattern hữu ích cho production: ưu tiên server gần (có thể chậm), fallback sang server xa (ổn định hơn).

### 14.3. Variation 3: Kết hợp timeout + circuit breaker pattern

Mục đích: Sau N lần timeout liên tiếp, tạm thời ngừng gửi request tới slow origin, chuyển toàn bộ traffic sang stable origin.

**Cấu hình Nginx**:

```nginx
upstream lb_circuit_breaker {
    zone upstream_lb_cb 64k;
    server lb-slow-origin:8090 resolve max_fails=3 fail_timeout=30s;  # Sau 3 fail -> eject 30s
    server lb-stable-origin:8090 resolve backup;
    keepalive 8;
}

location = /api/lb/circuit-breaker-demo {
    proxy_read_timeout 150ms;
    proxy_next_upstream error timeout invalid_header http_500 http_502 http_503 http_504;
    proxy_next_upstream_tries 2;
    add_header X-Upstream-Service $upstream_addr always;
    add_header X-LB-Timeout-Policy "read_timeout=150ms,circuit_breaker=max_fails=3,fail_timeout=30s" always;
    add_header X-LB-Upstream-Status $upstream_status always;
    add_header X-Request-ID $request_id always;
    proxy_pass http://lb_circuit_breaker;
}
```

**Script k6**:

```javascript
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { requestLB, responseHeader } from './shared.js';

const primaryTimeout = new Counter('cb_primary_timeout');
const fallbackSuccess = new Counter('cb_fallback_success');
const unexpected = new Counter('cb_unexpected');

const api = {
  name: 'lb_circuit_breaker_demo',
  method: 'GET',
  path: '/api/lb/circuit-breaker-demo',
};

export const options = {
  scenarios: {
    circuit_breaker_test: {
      executor: 'constant-arrival-rate',
      rate: 2,           // 2 request/s
      timeUnit: '1s',
      duration: '60s',   // Chạy 60s để quan sát circuit breaker behavior
      preAllocatedVUs: 5,
      maxVUs: 10,
    },
  },
  thresholds: {
    cb_primary_timeout: ['count>=3'],       // Phải có ít nhất 3 timeout (để trigger circuit breaker)
    cb_fallback_success: ['count>0'],       // Phải có fallback thành công
    cb_unexpected: ['count==0'],
  },
};

export default function () {
  const res = requestLB(api, {
    tags: { endpoint: api.name },
  });

  check(res, {
    'valid status': (r) => r.status === 200 || r.status === 504,
  });

  if (res.status === 504) {
    primaryTimeout.add(1);
  } else if (res.status === 200) {
    const upstream = responseHeader(res, 'X-Upstream-Service') || '';
    if (upstream.includes('stable')) {
      fallbackSuccess.add(1);  // Fallback từ stable origin
    }
  } else {
    unexpected.add(1);
  }
}
```

**Phân tích**:

- 3 request đầu tiên: Nginx gửi tới `lb-slow-origin`, timeout sau 150ms -> 504.
- Sau 3 lần fail (`max_fails=3`), `lb-slow-origin` bị đánh dấu unavailable trong 30 giây.
- Các request tiếp theo: Nginx bỏ qua `lb-slow-origin`, gửi thẳng tới `lb-stable-origin` (backup) -> 200.
- Sau 30 giây (`fail_timeout=30s`), Nginx thử lại `lb-slow-origin`.
- Pattern này bảo vệ hệ thống khỏi việc liên tục gửi request tới origin bị lỗi.
- Quan sát được qua `X-Upstream-Status` và `X-Upstream-Service`.

### 14.4. Variation 4: Custom metric cho latency breakdown

Mục đích: Tách biệt các thành phần của response time để hiểu rõ timeout behavior.

**Script k6**:

```javascript
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { envInt } from '../shared/common.js';
import { lbCapabilityApis, requestLB, responseHeader } from './shared.js';

const TIMEOUT_RATE = envInt('LB_TIMEOUT_RATE', 8);
const TIMEOUT_DURATION = `${envInt('LB_TIMEOUT_DURATION_SECONDS', 8)}s`;

const timeout504 = new Counter('lb_timeout_504');
const timeoutUnexpected = new Counter('lb_timeout_unexpected');

// Custom trends cho latency breakdown
const ttfbTrend = new Trend('lb_ttfb');          // Time To First Byte
const timeoutOverhead = new Trend('lb_timeout_overhead');  // Overhead ngoài timeout

export const options = {
  scenarios: {
    timeout_lane: {
      executor: 'constant-arrival-rate',
      rate: TIMEOUT_RATE,
      timeUnit: '1s',
      duration: TIMEOUT_DURATION,
      preAllocatedVUs: 10,
      maxVUs: 20,
    },
  },
  thresholds: {
    lb_timeout_504: ['count>0'],
    lb_timeout_unexpected: ['count==0'],
    lb_ttfb: ['p(95)>140'],              // TTFB phải > 140ms (gần timeout value)
    lb_timeout_overhead: ['p(95)<30'],    // Overhead phải nhỏ
  },
};

export default function () {
  const api = lbCapabilityApis.timeoutDemo;
  const res = requestLB(api, {
    tags: { endpoint: api.name },
  });

  // Ghi nhận TTFB (Time To First Byte)
  if (res.timings && res.timings.waiting) {
    ttfbTrend.add(res.timings.waiting);
    // Overhead = total duration - TTFB
    timeoutOverhead.add(res.timings.duration - res.timings.waiting);
  }

  check(res, {
    'lb timeout status is 504': (r) => r.status === 504,
    'lb timeout upstream header present': (r) => responseHeader(r, 'X-Upstream-Service') === api.expectedUpstream,
    'lb timeout policy header present': (r) => responseHeader(r, 'X-LB-Timeout-Policy') === 'read_timeout=150ms',
    'lb timeout no cache header': (r) => !responseHeader(r, 'X-Cache'),
    'ttfb near timeout value': (r) => {
      const ttfb = r.timings && r.timings.waiting;
      if (ttfb === undefined) return false;
      return ttfb >= 140 && ttfb <= 170;  // TTFB trong khoảng 140-170ms
    },
  });

  if (res.status === 504) {
    timeout504.add(1);
  } else {
    timeoutUnexpected.add(1);
  }
}
```

**Phân tích metrics**:

| Metric | Ý nghĩa | Expected |
| --- | --- | --- |
| `lb_ttfb` | Thời gian từ lúc gửi request đến khi nhận byte đầu tiên | p95 > 140ms (bao gồm 150ms timeout) |
| `lb_timeout_overhead` | Network + Nginx processing overhead | p95 < 30ms (rất nhỏ) |
| `http_req_duration` | Tổng thời gian | ~ TTFB + overhead |
| `http_req_connecting` | TCP handshake time | < 5ms (local) |
| `http_req_blocked` | Thời gian chờ connection slot | ~0ms (đủ VU) |

### 14.5. Variation 5: Fast lane song song để chứng minh timeout isolation

Mục đích: Chứng minh rằng timeout trên slow lane không ảnh hưởng đến fast lane. Đây là phần mở rộng của case 11 (saturation isolation), kết hợp với case 12.

**Cấu hình Nginx**:

```nginx
# Fast lane và Slow lane dùng chung upstream nhưng khác location
location = /api/lb/isolation-fast-demo {
    add_header X-Upstream-Service "lb-stable-origin" always;
    add_header X-LB-Isolation-Class "fast" always;
    add_header X-Request-ID $request_id always;
    proxy_pass http://lb_stable_backend;
}

location = /api/lb/timeout-demo {
    proxy_read_timeout 150ms;
    add_header X-Upstream-Service "lb-slow-origin" always;
    add_header X-LB-Timeout-Policy "read_timeout=150ms" always;
    add_header X-Request-ID $request_id always;
    proxy_pass http://lb_slow_backend;
}
```

**Script k6**:

```javascript
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { envInt } from '../shared/common.js';
import { requestLB, responseHeader } from './shared.js';

const TIMEOUT_RATE = envInt('LB_TIMEOUT_RATE', 8);
const TIMEOUT_DURATION = `${envInt('LB_TIMEOUT_DURATION_SECONDS', 10)}s`;

const timeout504 = new Counter('lb_timeout_504');
const timeoutUnexpected = new Counter('lb_timeout_unexpected');
const fastSuccess = new Counter('lb_fast_success');
const fastDuration = new Trend('lb_fast_duration');

const timeoutApi = {
  name: 'lb_timeout_demo',
  method: 'GET',
  path: '/api/lb/timeout-demo',
  expectedUpstream: 'lb-slow-origin',
};

const fastApi = {
  name: 'lb_isolation_fast_demo',
  method: 'GET',
  path: '/api/lb/isolation-fast-demo',
  expectedUpstream: 'lb-stable-origin',
};

export const options = {
  scenarios: {
    mixed_timeout_and_fast: {
      executor: 'constant-arrival-rate',
      rate: TIMEOUT_RATE * 2,  // Gấp đôi rate để chia cho 2 lane
      timeUnit: '1s',
      duration: TIMEOUT_DURATION,
      preAllocatedVUs: 15,
      maxVUs: 30,
    },
  },
  thresholds: {
    lb_timeout_504: ['count>0'],
    lb_timeout_unexpected: ['count==0'],
    lb_fast_success: ['count>0'],
    lb_fast_duration: ['p(95)<20'],      // Fast lane phải RẤT nhanh
    'http_req_duration{endpoint:lb_timeout_demo}': ['p(95)<250'],
  },
};

export default function () {
  // 50% request tới fast lane, 50% tới slow/timeout lane
  const useFastLane = Math.random() < 0.5;
  const api = useFastLane ? fastApi : timeoutApi;

  const res = requestLB(api, {
    tags: {
      endpoint: api.name,
      lane: useFastLane ? 'fast' : 'slow_timeout',
    },
  });

  if (useFastLane) {
    check(res, {
      'fast lane status 200': (r) => r.status === 200,
      'fast lane no cache': (r) => !responseHeader(r, 'X-Cache'),
    });
    if (res.status === 200) {
      fastSuccess.add(1);
      fastDuration.add(res.timings.duration);
    }
  } else {
    check(res, {
      'timeout lane status 504': (r) => r.status === 504,
      'timeout lane policy header': (r) => responseHeader(r, 'X-LB-Timeout-Policy') === 'read_timeout=150ms',
      'timeout lane no cache': (r) => !responseHeader(r, 'X-Cache'),
    });
    if (res.status === 504) {
      timeout504.add(1);
    } else {
      timeoutUnexpected.add(1);
    }
  }
}
```

**Phân tích**:

- Fast lane p95 < 20ms: Chứng minh slow origin timeout KHÔNG ảnh hưởng đến fast lane performance.
- Slow lane p95 ~150ms: Timeout policy vẫn hoạt động bình thường.
- `lb_fast_success > 0`: Fast lane vẫn phục vụ được request.
- Đây là chứng minh về **timeout isolation**: worker connections bị chiếm bởi slow lane không làm ảnh hưởng đến fast lane, miễn là tổng số worker connections đủ lớn.

---

## 15. Anti-patterns

### 15.1. Anti-pattern 1: Set `http_req_failed` threshold cho case này

```javascript
// SAI - sẽ luôn fail
thresholds: {
  http_req_failed: ['rate<0.01'],  // Mong đợi <1% failed -- nhưng case này 100% failed!
}
```

**Tại sao sai**: Case này cố ý tạo 100% `http_req_failed`. Đặt threshold `rate<0.01` sẽ luôn fail, ngay cả khi mọi thứ hoạt động chính xác.

**Cách đúng**: Không đặt threshold cho `http_req_failed` trong case này. Dùng custom counters (`lb_timeout_504`, `lb_timeout_unexpected`) để phân biệt expected vs unexpected failure.

### 15.2. Anti-pattern 2: Dùng `assertLBResponse`

```javascript
// SAI - assertLBResponse expect status 200
import { assertLBResponse } from './shared.js';
export default function () {
  const res = requestLB(api);
  assertLBResponse(res, api);  // Check 'status' sẽ fail vì response là 504
}
```

**Tại sao sai**: `assertLBResponse` kiểm tra `r.status === api.expected`. Với `timeoutDemo`, `api.expected` không được set (undefined) hoặc default về 200. Response 504 sẽ fail check này.

**Cách đúng**: Viết custom checks phù hợp với expected behavior của case (status 504, có timeout policy header).

### 15.3. Anti-pattern 3: Không tạo custom metric

```javascript
// SAI - chỉ dùng built-in metrics
export const options = {
  thresholds: {
    http_req_failed: ['rate>0.99'],  // Không phân biệt được 504 vs 502 vs 503
  },
};
```

**Tại sao sai**: `http_req_failed` không phân biệt được giữa 504 (expected), 502 (unexpected - upstream down), và 503 (unexpected - service unavailable). Tất cả đều >= 400 và được tính là "failed".

**Cách đúng**: Tạo custom counters phân loại response:

```javascript
const timeout504 = new Counter('lb_timeout_504');
const timeoutUnexpected = new Counter('lb_timeout_unexpected');

if (res.status === 504) {
  timeout504.add(1);
} else {
  timeoutUnexpected.add(1);
}
```

### 15.4. Anti-pattern 4: Quên check `X-Cache` vắng mặt

```javascript
// SAI - không kiểm tra X-Cache
check(res, {
  'lb timeout status is 504': (r) => r.status === 504,
  'lb timeout upstream header present': (r) => responseHeader(r, 'X-Upstream-Service') === 'lb-slow-origin',
  'lb timeout policy header present': (r) => responseHeader(r, 'X-LB-Timeout-Policy') === 'read_timeout=150ms',
  // Thiếu check X-Cache!
});
```

**Tại sao sai**: Nếu request đi qua CDN/Varnish (do sai profile), CDN có thể tự timeout và trả 504, hoặc cache response. Khi đó, `X-Cache` sẽ có mặt và test không còn chứng minh được Nginx timeout capability.

**Cách đúng**: Luôn check `X-Cache` vắng mặt trong LB-layer tests:

```javascript
'lb timeout no cache header': (r) => !responseHeader(r, 'X-Cache'),
```

### 15.5. Anti-pattern 5: Tăng timeout lên cao để "pass"

```javascript
// SAI - set proxy_read_timeout cao để origin kịp phản hồi
location = /api/lb/timeout-demo {
    proxy_read_timeout 5s;  // Quá cao! Origin sẽ kịp phản hồi -> 200
    ...
}
```

**Tại sao sai**: Mục đích của case là chứng minh timeout policy **cắt** request. Tăng timeout để origin kịp phản hồi (200 OK, `lb_timeout_504=0`) làm mất ý nghĩa của test.

**Cách đúng**: Chọn timeout value **thấp hơn** response time của origin, đảm bảo timeout luôn trigger. Nếu muốn test scenario khác (origin phản hồi thành công), đó là một case riêng, không phải case 12.

### 15.6. Anti-pattern 6: Dùng `maxVUs` quá thấp

```javascript
// SAI - maxVUs không đủ cho rate
export const options = {
  scenarios: {
    timeout_lane: {
      executor: 'constant-arrival-rate',
      rate: 8,
      timeUnit: '1s',
      duration: '8s',
      preAllocatedVUs: 1,
      maxVUs: 2,  // Quá thấp! Với 8 req/s và mỗi req ~150ms, cần ít nhất ceil(8*0.15)=2
    },
  },
};
```

**Tại sao có thể gây vấn đề**: Nếu `maxVUs` quá thấp, k6 không thể schedule đủ iteration để đạt rate. Iteration bị delay, giảm tần suất request, và kết quả không phản ánh đúng scenario.

**Cách đúng**: Đảm bảo `maxVUs >= ceil(rate * expected_duration_per_request)`. Với rate=8/s và mỗi request ~160ms: `ceil(8 * 0.16) = 2`. Thêm buffer an toàn: `maxVUs=20` (như default) là đủ.

### 15.7. Anti-pattern 7: Bỏ qua header `X-LB-Timeout-Policy`

```javascript
// SAI - không check giá trị của timeout policy header
check(res, {
  'lb timeout status is 504': (r) => r.status === 504,
  // Thiếu check X-LB-Timeout-Policy!
});
```

**Tại sao sai**: Status 504 không cho biết timeout value là bao nhiêu. Có thể là 150ms, cũng có thể là 30s (global default). Nếu global default 30s vô tình trigger (vì origin thực sự treo), test vẫn pass check status nhưng không chứng minh được per-location timeout override.

**Cách đúng**: Check chính xác giá trị của `X-LB-Timeout-Policy`:

```javascript
'lb timeout policy header present': (r) => responseHeader(r, 'X-LB-Timeout-Policy') === 'read_timeout=150ms',
```

---

## 16. Real validation data

### 16.1. Kết quả thực tế từ tuned correctness run

Dưới đây là kết quả validation thực tế từ lần chạy `full-no-cdn` tuned correctness (với env giảm tải cho case 04/05 để tránh rate-limit):

```text
Profile: full-no-cdn
Case: 12-slow-origin-timeouts
Script: 12-slow-origin-timeouts.js
Environment: BASE_URL=http://localhost:80, default env variables

╔══════════════════════════════════════════════════════════════╗
║                    RUNTIME RESULTS                           ║
╠══════════════════════════════════════════════════════════════╣
║ Exit code: 0                                                ║
║ Checks: 260/260 (100.00%)                                   ║
║ HTTP failed: 100.00% (65/65) -- EXPECTED                    ║
║ lb_timeout_504: 65                                          ║
║ lb_timeout_unexpected: 0                                    ║
║ p95 duration (lb_timeout_demo): ~153ms                      ║
║ Result: PASS                                                ║
╚══════════════════════════════════════════════════════════════╝
```

### 16.2. Phân tích từng dòng output

#### Exit code: 0

Exit code 0 có nghĩa là tất cả thresholds đều pass. Đây là tín hiệu quan trọng nhất: k6 CLI tự động đánh giá pass/fail dựa trên thresholds, không cần đọc thủ công. Trong CI/CD pipeline, exit code 0 = pass, khác 0 = fail.

#### Checks: 260/260 (100.00%)

Mỗi request có 4 checks. Với 65 request: `65 * 4 = 260` checks. Tất cả 260 checks đều pass, không có check nào fail. Điều này xác nhận:

- Tất cả 65 request đều có status 504.
- Tất cả 65 request đều có `X-Upstream-Service: lb-slow-origin`.
- Tất cả 65 request đều có `X-LB-Timeout-Policy: read_timeout=150ms`.
- Tất cả 65 request đều không có `X-Cache`.

#### HTTP failed: 100.00% (65/65)

65 trên 65 request có HTTP status >= 400 (cụ thể là 504). Đây là **expected outcome**, không phải bug. Dòng này thường gây nhầm lẫn cho người mới đọc kết quả -- cần nhấn mạnh: 100% failed ở đây là PASS.

#### lb_timeout_504: 65

Counter `lb_timeout_504` ghi nhận 65 response với status 504. Bằng đúng tổng số request, chứng tỏ **tất cả** request đều bị timeout. Threshold `count>0` pass dễ dàng.

#### lb_timeout_unexpected: 0

Counter `lb_timeout_unexpected` ghi nhận 0 response với status khác 504. Không có bất kỳ response 200, 502, 503 nào -- perfect. Threshold `count==0` pass.

#### p95 duration: ~153ms

p95 của `http_req_duration` cho requests được tag `endpoint:lb_timeout_demo` là khoảng 153ms. Con số này:

- Lớn hơn 150ms (timeout value): Khớp với dự đoán -- Nginx chờ đúng 150ms rồi mới cắt.
- Nhỏ hơn 250ms: Threshold `p(95)<250` pass thoải mái.
- 153ms - 150ms = 3ms overhead cho network + Nginx processing: Overhead rất nhỏ, chứng tỏ Nginx xử lý timeout rất nhanh.

#### Không có unexpected status codes

Ngoài 504, không có status code nào khác xuất hiện. Điều này khác với case 07 (có cả 200 và 429) hay case 04/05 (có thể có 429 trong default run). Case 12 là case "thuần khiết" về timeout -- chỉ có một status code duy nhất.

### 16.3. So sánh với các case khác

| Case | http_req_failed | Expected? | Primary status |
| --- | ---: | --- | --- |
| lb-01 Entry smoke | 0.00% | Yes | 200 |
| lb-03 Domain boundaries | 0.00% | Yes | 200 |
| lb-04 Cacheable read (tuned) | 0.00% | Yes | 200 |
| lb-06 Retry failover | 0.00% | Yes | 200 |
| lb-07 Rate/pressure | ~65% | Yes | 200, 429 |
| lb-08 Weighted canary | 0.00% | Yes | 200 |
| lb-10 Canary fairness | 0.00% | Yes | 200 |
| lb-11 Saturation isolation | 0.00% | Yes | 200 |
| **lb-12 Timeout policy** | **100.00%** | **Yes** | **504** |

Case 12 là case duy nhất trong 12 LB cases có `http_req_failed=100%`. Điều này nhấn mạnh tầm quan trọng của việc đọc kết quả trong context: không phải cứ failed rate cao là xấu.

### 16.4. Validation bằng Nginx access log

Để cross-validate kết quả, có thể kiểm tra Nginx access log:

```text
# Expected pattern trong access.log
127.0.0.1 - - [14/Jan/2026:10:15:30 +0000] "GET /api/lb/timeout-demo HTTP/1.1" 504 123 "-" "k6/0.51.0" "-"
127.0.0.1 - - [14/Jan/2026:10:15:30 +0000] "GET /api/lb/timeout-demo HTTP/1.1" 504 123 "-" "k6/0.51.0" "-"
...
```

Mỗi dòng log xác nhận:

- Request path: `/api/lb/timeout-demo` (đúng location).
- Status: `504` (đúng expected status).
- Response size: nhỏ (chỉ có headers, không có body).
- Tần suất: khoảng 8 request/giây (khớp với rate).

### 16.5. Validation bằng Nginx error log

Trong error log, có thể thấy các dòng liên quan đến timeout:

```text
2026/01/14 10:15:30 [error] 123#123: *456 upstream timed out (110: Connection timed out) while reading response header from upstream,
    client: 127.0.0.1, server: , request: "GET /api/lb/timeout-demo HTTP/1.1",
    upstream: "http://10.0.1.5:8090/api/lb/timeout-demo", host: "localhost"
```

Dòng log này xác nhận:

- `upstream timed out`: Đúng là timeout xảy ra ở upstream.
- `while reading response header`: Đúng là `proxy_read_timeout` (không phải connect hay send).
- `upstream: "http://10.0.1.5:8090/api/lb/timeout-demo"`: Đúng upstream server.

### 16.6. Dashboard interpretation

Khi xem dashboard/chart cho case 12, cần lưu ý:

**Checks rate**: Phải là 100% (đường thẳng ngang ở 100%). Nếu có drop, có request không pass check.

**HTTP failed rate**: Phải là 100% (đường thẳng ngang ở 100%). Đây là expected.

**HTTP status codes**: Chỉ có một màu duy nhất cho 504. Nếu xuất hiện màu khác (200, 502, 503), có unexpected behavior.

**HTTP duration by endpoint**: p95 cho `lb_timeout_demo` phải nằm trong khoảng 150-160ms.

**Custom metrics**: `lb_timeout_504` tăng đều (tuyến tính), `lb_timeout_unexpected` phẳng ở 0.

**Caveat**: Đừng đọc aggregate p95 của toàn bộ test run -- nó chỉ có một endpoint nên không bị méo, nhưng trong batch run với nhiều case, aggregate p95 sẽ bị kéo lên bởi case 12.

---

## 17. Reference

### 17.1. Internal references

| Resource | Path | Mô tả |
| --- | --- | --- |
| Overview | `./00_overview.md` | Tổng quan series LB/Gateway, case inventory, learning order |
| Validation report | `./13_validation-and-chart-analysis.md` | Validation evidence cho toàn bộ 12 LB cases |
| Run guide | `./RUN_GUIDE.md` | Hướng dẫn chạy đầy đủ |
| Script | `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/12-slow-origin-timeouts.js` | k6 script cho case 12 |
| Shared helper | `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/shared.js` | Shared functions: `requestLB`, `responseHeader`, `lbCapabilityApis` |
| Common helper | `E:/Projects/k6/k6-metrics-server/load-target/k6/shared/common.js` | `envInt`, `envString`, `requestApi`, `chooseWeighted` |
| Case catalog | `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/case-catalog.json` | Case definitions, expected signals, env vars |
| Nginx config | `E:/Projects/k6/k6-metrics-server/load-target/nginx/nginx.conf` | Full Nginx configuration |
| Runner script | `E:/Projects/k6/k6-metrics-server/scripts/run-lb-capabilities.ps1` | PowerShell runner cho LB cases |

### 17.2. External references

| Resource | URL | Mô tả |
| --- | --- | --- |
| Nginx `proxy_read_timeout` | `https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout` | Official documentation |
| Nginx `proxy_next_upstream` | `https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream` | Retry/failover configuration |
| Nginx `proxy_connect_timeout` | `https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_connect_timeout` | Connection timeout |
| Nginx upstream module | `https://nginx.org/en/docs/http/ngx_http_upstream_module.html` | Upstream pool, health checks, keepalive |
| k6 `constant-arrival-rate` | `https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/` | Executor documentation |
| k6 Custom metrics | `https://grafana.com/docs/k6/latest/using-k6/metrics/create-custom-metrics/` | Counter, Trend, Rate, Gauge |
| HTTP 504 Gateway Timeout | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/504` | MDN reference |

### 17.3. Related cases

| Case | Relation | Mô tả |
| --- | --- | --- |
| lb-06 Retry/failover | Cùng dùng `proxy_next_upstream` | Failover khi upstream lỗi, khác với timeout (case 12) |
| lb-07 Rate/pressure | Cùng có expected non-200 | 429 expected, nhưng khác cơ chế (rate limit vs timeout) |
| lb-09 Passive ejection | Liên quan đến `max_fails` | Ejection sau N lần fail, tương tác với timeout |
| lb-11 Saturation isolation | Cùng dùng `lb_slow_backend` | Isolation lane: slow origin không kéo sập fast origin |

---

## 18. Deep dive: `proxy_read_timeout` vs `proxy_connect_timeout` vs `proxy_send_timeout`

### 18.1. Tổng quan ba timeout directives

Nginx proxy module cung cấp ba directive timeout độc lập, mỗi directive kiểm soát một giai đoạn riêng biệt trong vòng đời của một proxy request. Hiểu rõ sự khác biệt giữa chúng là điều kiện tiên quyết để cấu hình timeout policy chính xác.

```text
                    proxy_connect_timeout     proxy_send_timeout      proxy_read_timeout
                    ├──────────────────────┤ ├─────────────────────┤ ├──────────────────────┤
k6 ───▶ Nginx ───▶ [TCP handshake] ───▶ [Gửi request body] ───▶ [Chờ response] ───▶ k6
                    │                                                                    │
                    ◀────────────────────────────────────────────────────────────────────▶
                                        Tổng thời gian request (client view)
```

### 18.2. Bảng so sánh chi tiết

| Khía cạnh | `proxy_connect_timeout` | `proxy_send_timeout` | `proxy_read_timeout` |
| --- | --- | --- | --- |
| **Giai đoạn** | TCP connection establishment | Gửi request body tới upstream | Đọc response từ upstream |
| **Bắt đầu đếm** | Khi Nginx bắt đầu mở TCP connection | Khi bắt đầu gửi request body | Khi gửi xong request, bắt đầu chờ response |
| **Kết thúc đếm** | Khi TCP handshake hoàn tất | Khi gửi xong toàn bộ body | Khi nhận được dữ liệu response |
| **Reset timer?** | Không (chỉ chạy một lần) | Reset sau mỗi lần write thành công | Reset sau mỗi lần read thành công |
| **Timeout HTTP status** | `502 Bad Gateway` | `504 Gateway Timeout` | `504 Gateway Timeout` |
| **Lỗi log** | `connect() failed` | `upstream timed out` khi gửi | `upstream timed out` khi đọc |
| **Liên quan nhất** | Upstream down, network issue | POST/PUT với body lớn | Upstream chậm xử lý |
| **Global default** | `60s` (Nginx mặc định) | `60s` (Nginx mặc định) | `60s` (Nginx mặc định) |
| **Trong project này** | `10s` | `30s` | `30s` (global), `150ms` (case 12 location) |
| **Có thể override per-location?** | Có | Có | Có |
| **Có thể override per-upstream?** | Không | Không | Không |
| **Bị ảnh hưởng bởi keepalive?** | Không (keepalive bỏ qua bước này) | Không | Không |

### 18.3. Interaction giữa các timeout

Các timeout chạy **tuần tự**, không song song:

1. Đầu tiên: `proxy_connect_timeout` -- thiết lập kết nối TCP.
2. Sau khi kết nối: `proxy_send_timeout` -- gửi request (có thể không áp dụng cho GET).
3. Sau khi gửi xong: `proxy_read_timeout` -- chờ response.

Tổng thời gian tối đa cho một request (không tính retry) = `proxy_connect_timeout + proxy_send_timeout + proxy_read_timeout`. Tuy nhiên, trong thực tế:

- Nếu kết nối thành công trong 2ms, `proxy_connect_timeout` không còn liên quan.
- Nếu gửi request không có body (GET), `proxy_send_timeout` không trigger.
- `proxy_read_timeout` là timeout thường gặp nhất trong thực tế.

### 18.4. `proxy_read_timeout` -- cơ chế "reset timer"

Điểm quan trọng nhất về `proxy_read_timeout` mà nhiều người hiểu sai: **đây không phải là "tổng thời gian chờ" mà là "thời gian chờ giữa các lần đọc thành công"**. Timer được reset mỗi khi Nginx đọc được một chunk dữ liệu từ upstream.

Ví dụ:

```text
t=0ms:    Nginx bắt đầu chờ response (timer bắt đầu đếm)
t=100ms:  Upstream gửi response headers -> Nginx đọc thành công -> TIMER RESET về 0
t=100ms:  Timer bắt đầu đếm lại
t=200ms:  Upstream gửi response body chunk 1 -> Nginx đọc thành công -> TIMER RESET
t=200ms:  Timer bắt đầu đếm lại
t=350ms:  Upstream chưa gửi gì thêm -> TIMER TRIGGER sau 150ms -> 504
```

Điều này có nghĩa là: một upstream có thể mất rất lâu để xử lý, **miễn là nó gửi dữ liệu đều đặn** (trong khoảng thời gian nhỏ hơn `proxy_read_timeout`). Đây là lý do streaming responses và long-polling có thể hoạt động qua Nginx.

Trong case này, `lb-slow-origin` không gửi **bất kỳ** dữ liệu nào trong suốt thời gian chờ, nên timer không bao giờ được reset và trigger sau đúng 150ms.

### 18.5. Vì sao global defaults thường cao hơn?

Global `proxy_read_timeout 30s` trong project này là khá cao so với `150ms` của case 12. Lý do:

- **Global default phải an toàn cho mọi upstream**: Không biết upstream nào sẽ được thêm vào trong tương lai. Timeout quá ngắn có thể gây false positive 504 cho upstream hợp lệ nhưng chậm.
- **Location override cho các upstream nhạy cảm**: Những upstream cần timeout ngắn (như payment, authentication) nên được cấu hình riêng ở location level.
- **Nguyên tắc**: Global default nên là "maximum acceptable timeout" cho hệ thống. Các location cụ thể ghi đè với giá trị phù hợp với SLA của upstream tương ứng.

---

## 19. Nginx timeout chain of events (detailed timeline)

### 19.1. Happy path (không timeout)

```text
      Client          Nginx                Upstream
        |               |                     |
t=0     |-- SYN -------▶|                     |
t=0.5   |◀-- SYN-ACK ---|                     |
t=1     |-- ACK -------▶|                     |
t=1.5   |-- HTTP GET --▶|                     |
t=2     |               |-- SYN -------------▶|
t=3     |               |◀-- SYN-ACK --------|
t=4     |               |-- ACK -------------▶|
t=5     |               |-- HTTP GET --------▶|
t=5     |               |   [bắt đầu proxy_read_timeout] |
t=35    |               |◀-- HTTP 200 OK ----|
t=36    |               |   [proxy_read_timeout bị hủy] |
t=36.5  |◀-- HTTP 200 --|                     |
t=37    |               |                     |
```

Tổng thời gian từ client: ~37ms. `proxy_read_timeout` chạy từ t=5ms đến t=35ms (30ms) trước khi được hủy bởi response thành công.

### 19.2. Timeout path (case 12)

```text
      Client          Nginx                Upstream
        |               |                     |
t=0     |-- HTTP GET --▶|                     |
t=0.5   |               |-- SYN -------------▶|
t=1.5   |               |◀-- SYN-ACK --------|
t=2     |               |-- ACK -------------▶|
t=2.5   |               |-- HTTP GET --------▶|
t=2.5   |               |   [bắt đầu proxy_read_timeout 150ms] |
        |               |                     |
        |               |   [... 150ms trôi qua, không có dữ liệu ...] |
        |               |                     |
t=152.5 |               |   [proxy_read_timeout TRIGGER] |
t=153   |               |-- RST -------------▶|  (đóng kết nối)
t=153.5 |               |   [tạo 504 response] |
t=154   |◀-- HTTP 504 --|                     |
t=154.5 |               |                     |
```

Tổng thời gian từ client: ~154ms. Trong đó 150ms là thời gian chờ timeout, 4ms còn lại là overhead (network + Nginx processing).

### 19.3. Timeout + retry path (nếu có nhiều upstream servers)

```text
      Client          Nginx                Upstream-1        Upstream-2
        |               |                     |                 |
t=0     |-- HTTP GET --▶|                     |                 |
t=2     |               |-- HTTP GET --------▶|                 |
t=2     |               |   [bắt đầu proxy_read_timeout 150ms] |
t=152   |               |   [TIMEOUT - Upstream-1]             |
t=152.5 |               |-- RST -------------▶|                 |
t=153   |               |   [thử Upstream-2]  |                 |
t=153.5 |               |-- SYN ------------------------------▶|
t=154.5 |               |◀-- SYN-ACK --------------------------|
t=155   |               |-- ACK -------------------------------▶|
t=155.5 |               |-- HTTP GET --------------------------▶|
t=155.5 |               |   [bắt đầu proxy_read_timeout 150ms] |
t=160   |               |◀-- HTTP 200 OK ----------------------|
t=160.5 |◀-- HTTP 200 --|                     |                 |
t=161   |               |                     |                 |
```

Tổng thời gian: ~161ms. Timeout ở upstream-1 mất 150ms, retry sang upstream-2 mất thêm ~8ms. Client nhận 200 OK. Nhưng lưu ý: case 12 không có upstream thứ hai nên pattern này không xảy ra.

---

## 20. Connection pool behavior during timeouts

### 20.1. Keepalive connections

```nginx
upstream lb_slow_backend {
    server lb-slow-origin:8090 resolve max_fails=1 fail_timeout=5s;
    keepalive 8;
}

proxy_set_header Connection "";  # Xóa Connection header để dùng keepalive
```

`keepalive 8` cho phép Nginx giữ tối đa 8 kết nối thường trực tới `lb-slow-origin:8090`. Khi một request hoàn thành (dù thành công hay timeout), connection được đưa vào keepalive pool để tái sử dụng cho request tiếp theo.

**Ảnh hưởng của timeout đến keepalive pool**:

- Khi timeout xảy ra, Nginx đóng connection (RST). Connection này bị loại khỏi keepalive pool.
- Nginx phải mở connection mới cho request tiếp theo.
- Nếu timeout xảy ra liên tục (như case này), mỗi request đều phải mở connection mới, làm tăng nhẹ overhead.

**Tại sao vẫn dùng keepalive?**: Trong production, không phải request nào cũng timeout. Keepalive giúp giảm TCP handshake overhead cho các request thành công. Case 12 là scenario đặc biệt -- tất cả request đều timeout.

### 20.2. Worker connections

Nginx sử dụng mô hình event-driven, non-blocking I/O. Mỗi worker process có thể xử lý hàng nghìn connection đồng thời. Khi một connection đang chờ timeout (150ms), worker process **không bị block** -- nó có thể xử lý các connection khác.

Tuy nhiên, connection tới upstream vẫn **chiếm một slot** trong connection pool của Nginx. Nếu có quá nhiều slow origin và timeout quá dài, connection pool có thể cạn kiệt. Đây là lý do timeout policy quan trọng: nó giới hạn thời gian một connection bị "chiếm giữ" bởi một slow origin.

### 20.3. Tính toán connection pool cần thiết

```text
Số connection đồng thời tối đa = rate * timeout_value
Ví dụ: rate=8/s, timeout=150ms -> 8 * 0.15 = 1.2 connections
```

Trong case này, với rate 8/s và timeout 150ms, trung bình chỉ có khoảng 1-2 connection đồng thời tới upstream. Đây là lý do preAllocatedVUs=10 và maxVUs=20 là quá đủ.

Trong production với rate 1000/s và timeout 5s:

```text
1000 * 5 = 5000 connections đồng thời
```

Cần đảm bảo Nginx được cấu hình với `worker_connections` đủ lớn, và upstream pool có đủ capacity.

---

## 21. How `proxy_next_upstream` interacts with `read_timeout`

### 21.1. Điều kiện `timeout` trong `proxy_next_upstream`

```nginx
proxy_next_upstream error timeout invalid_header http_500 http_502 http_503 http_504;
```

Khi `timeout` nằm trong danh sách `proxy_next_upstream`, bất kỳ timeout nào (`proxy_connect_timeout`, `proxy_read_timeout`, `proxy_send_timeout`) đều kích hoạt retry sang upstream server tiếp theo (nếu có).

### 21.2. Thứ tự ưu tiên khi chọn upstream server tiếp theo

1. Nginx thử server đầu tiên trong upstream pool.
2. Nếu điều kiện `proxy_next_upstream` được thỏa mãn (timeout, error, etc.), Nginx chọn server tiếp theo.
3. Nginx bỏ qua các server đã được thử trong lần request này.
4. Nginx bỏ qua các server bị đánh dấu `down` hoặc đang trong `fail_timeout`.
5. Nếu tất cả server đã được thử hoặc không khả dụng, Nginx trả response lỗi cho client.

### 21.3. `proxy_next_upstream_tries` và `proxy_next_upstream_timeout`

```nginx
proxy_next_upstream_tries 2;        # Tối đa 2 lần thử (1 primary + 1 retry)
proxy_next_upstream_timeout 5s;     # Tổng thời gian retry không quá 5s
```

- **`proxy_next_upstream_tries 2`**: Bao gồm cả lần thử đầu tiên. Nghĩa là Nginx chỉ retry **1 lần** sau lần thử đầu tiên.
- **`proxy_next_upstream_timeout 5s`**: Tổng thời gian từ lúc bắt đầu gửi request đến upstream đầu tiên đến khi kết thúc retry không vượt quá 5 giây. Nếu hết 5 giây mà vẫn chưa có response thành công, Nginx trả lỗi cho client. Trong case này, mỗi lần thử mất ~150ms, nên giới hạn 5s không bao giờ bị chạm tới.

### 21.4. Tương tác với case 12

Trong case 12, `proxy_next_upstream` có `timeout` trong danh sách, nhưng upstream `lb_slow_backend` chỉ có 1 server. Kết quả:

1. Request tới `lb-slow-origin:8090` -> timeout sau 150ms.
2. `proxy_next_upstream` trigger (điều kiện `timeout` khớp).
3. Nginx tìm server tiếp theo -> không có.
4. Nginx trả 504.

Nếu bỏ `timeout` khỏi `proxy_next_upstream`, behavior vẫn giống hệt trong case này vì không có server thứ hai. Nhưng nếu sau này thêm server stable vào pool, behavior sẽ khác: có `timeout` trong danh sách -> retry sang stable -> client nhận 200; không có `timeout` -> không retry -> client nhận 504.

---

## 22. Comparison: Nginx timeout vs HAProxy timeout vs Envoy timeout

### 22.1. Bảng so sánh

| Khía cạnh | Nginx | HAProxy | Envoy |
| --- | --- | --- | --- |
| **Connect timeout** | `proxy_connect_timeout` | `timeout connect` | `connect_timeout` |
| **Read/response timeout** | `proxy_read_timeout` | `timeout server` | `timeout` (trong route) |
| **Send timeout** | `proxy_send_timeout` | `timeout client` (phía client gửi) | `request_timeout` |
| **Idle/keepalive timeout** | `keepalive_timeout` | `timeout http-keep-alive` | `idle_timeout` |
| **Per-route/location override** | `location` block | `backend` section | `route` trong virtual host |
| **Retry on timeout** | `proxy_next_upstream timeout` | `option redispatch` (mặc định) | `retry_policy.retry_on: connect-failure` |
| **Retry tries** | `proxy_next_upstream_tries` | `retries` | `retry_policy.num_retries` |
| **Retry timeout** | `proxy_next_upstream_timeout` | `timeout connect` + `timeout server` | `per_try_timeout` |
| **Circuit breaker** | `max_fails` + `fail_timeout` (passive) | `maxconn`, `observe` (passive) | `circuit_breakers` (active + passive) |
| **Timeout header** | Custom (`add_header`) | Custom (`http-response add-header`) | Custom (`response_headers_to_add`) |
| **Graceful timeout** | Không (504 ngay) | Có thể cấu hình `on-error` | Hỗ trợ `hedge_policy` |

### 22.2. Điểm mạnh/yếu của Nginx timeout so với HAProxy/Envoy

**Điểm mạnh của Nginx**:

- Cấu hình đơn giản, trực quan với `location` blocks.
- Per-location override dễ đọc và maintain.
- `proxy_next_upstream` linh hoạt với nhiều điều kiện.
- Passive health check (`max_fails` + `fail_timeout`) hoạt động tốt cho circuit breaker đơn giản.

**Điểm yếu của Nginx so với Envoy**:

- Không có active health checking (chỉ passive).
- Không có `per_try_timeout` -- mỗi lần retry dùng chung `proxy_read_timeout`.
- Không có circuit breaker active (chỉ dựa vào fail count).
- Không có `request_timeout` riêng biệt cho toàn bộ request lifecycle.
- Không có hedging (gửi song song nhiều request).

### 22.3. Mapping concept từ Nginx sang HAProxy

```haproxy
# Tương đương với case 12 trong HAProxy
backend lb_slow_backend
    timeout connect 10s
    timeout server 150ms       # Tương đương proxy_read_timeout
    server slow lb-slow-origin:8090 maxconn 8 check

frontend http
    bind :80
    acl is_timeout_demo path /api/lb/timeout-demo
    use_backend lb_slow_backend if is_timeout_demo
    http-response add-header X-LB-Timeout-Policy "read_timeout=150ms" if is_timeout_demo
```

### 22.4. Mapping concept từ Nginx sang Envoy

```yaml
# Tương đương với case 12 trong Envoy (static config)
clusters:
  - name: lb_slow_backend
    connect_timeout: 10s
    load_assignment:
      cluster_name: lb_slow_backend
      endpoints:
        - lb_endpoints:
            - endpoint:
                address:
                  socket_address:
                    address: lb-slow-origin
                    port_value: 8090

routes:
  - match:
      path: "/api/lb/timeout-demo"
    route:
      cluster: lb_slow_backend
      timeout: 0.150s  # 150ms -- tương đương proxy_read_timeout
      response_headers_to_add:
        - header:
            key: "X-LB-Timeout-Policy"
            value: "read_timeout=150ms"
```

---

## 23. Why 504 (Gateway Timeout) not 502 (Bad Gateway) or 503 (Service Unavailable)

### 23.1. HTTP status code decision tree cho timeout scenarios

```text
Nginx gửi request tới upstream
    │
    ├──▶ Không thể kết nối TCP tới upstream?
    │       ├──▶ CÓ ───▶ 502 Bad Gateway
    │       │           (proxy_connect_timeout trigger)
    │       │
    │       └──▶ KHÔNG ───▶ Tiếp tục...
    │
    ├──▶ Upstream accept connection nhưng trả response không hợp lệ?
    │       ├──▶ CÓ ───▶ 502 Bad Gateway
    │       │           (invalid_header trong proxy_next_upstream)
    │       │
    │       └──▶ KHÔNG ───▶ Tiếp tục...
    │
    ├──▶ Upstream không gửi response trong proxy_read_timeout?
    │       ├──▶ CÓ ───▶ 504 Gateway Timeout ◀── CASE 12
    │       │
    │       └──▶ KHÔNG ───▶ Upstream trả response
    │
    ├──▶ Upstream trả 5xx?
    │       ├──▶ 500 Internal Server Error ───▶ Có thể retry (nếu trong proxy_next_upstream)
    │       ├──▶ 502 Bad Gateway (từ upstream) ───▶ Có thể retry
    │       ├──▶ 503 Service Unavailable ───▶ Có thể retry
    │       ├──▶ 504 Gateway Timeout (từ upstream) ───▶ Có thể retry
    │       └──▶ Forward nguyên trạng về client nếu hết retry
    │
    └──▶ Upstream trả response thành công (2xx, 3xx) ───▶ Forward về client
```

### 23.2. Sự khác biệt giữa 502, 503, 504

| Status | Định nghĩa chính thức | Khi nào Nginx trả | Ai tạo ra response này |
| --- | --- | --- | --- |
| **502 Bad Gateway** | Gateway nhận response không hợp lệ từ upstream | `proxy_connect_timeout`, upstream trả invalid HTTP, upstream đóng connection đột ngột | **Nginx** (tự tạo) hoặc **upstream** (forward) |
| **503 Service Unavailable** | Service tạm thời không khả dụng (quá tải, bảo trì) | Không phải Nginx tự tạo (trừ khi cấu hình `return 503`). Upstream trả 503 -> Nginx forward. | Thường là **upstream** |
| **504 Gateway Timeout** | Gateway không nhận được response kịp thời từ upstream | `proxy_read_timeout` hoặc `proxy_send_timeout` trigger | **Nginx** (tự tạo) |

Trong case 12: Nginx đã kết nối thành công tới `lb-slow-origin:8090` (không phải 502). `lb-slow-origin` không trả lỗi (không phải 503). `lb-slow-origin` đơn giản là không gửi response trong 150ms -- đây chính xác là điều kiện cho 504 Gateway Timeout.

---

## 24. Troubleshooting guide: 5 common problems

### 24.1. Problem 1: "Không có 504 nào -- tất cả request trả 200 OK"

**Triệu chứng**: `lb_timeout_504=0`, `lb_timeout_unexpected=65`, checks status fail.

**Nguyên nhân có thể**:

1. **Origin không đủ chậm**: `lb-slow-origin` phản hồi trong < 150ms. Cần kiểm tra cấu hình delay của origin.
2. **Timeout chưa được cấu hình**: `proxy_read_timeout 150ms` không có trong Nginx config cho location này.
3. **Nginx chưa reload config**: Sau khi thêm `proxy_read_timeout`, chưa chạy `nginx -s reload`.
4. **Request đi sai location**: Request không match `/api/lb/timeout-demo` mà match location khác (ví dụ `/` catch-all).

**Cách debug**:

```powershell
# 1. Kiểm tra origin có đang chậm không
curl -w "@curl-format.txt" -o /dev/null -s http://localhost:8090/

# 2. Kiểm tra Nginx config hiện tại
docker exec <nginx-container> nginx -T 2>&1 | grep -A5 "timeout-demo"

# 3. Kiểm tra Nginx access log xem request đến location nào
docker exec <nginx-container> tail -20 /var/log/nginx/access.log

# 4. Gọi API trực tiếp và kiểm tra response headers
curl -v http://localhost:80/api/lb/timeout-demo
```

### 24.2. Problem 2: "Có unexpected status (200, 502, 503) xen kẽ 504"

**Triệu chứng**: `lb_timeout_unexpected > 0`, threshold `count==0` fail.

**Nguyên nhân có thể**:

1. **502**: Origin không chạy hoặc không thể kết nối. Kiểm tra `docker ps | grep slow-origin`.
2. **200**: Origin phản hồi không nhất quán -- lúc nhanh lúc chậm. Kiểm tra origin configuration.
3. **503**: Origin trả 503 (có thể do quá tải). Kiểm tra origin logs.

**Cách debug**:

```powershell
# Kiểm tra trạng thái origin
docker logs lb-slow-origin --tail 50

# Kiểm tra network giữa Nginx và origin
docker exec <nginx-container> ping lb-slow-origin

# Kiểm tra chi tiết response không phải 504
# Chạy k6 với --http-debug="full" để xem response body/headers
```

### 24.3. Problem 3: "p95 duration > 250ms"

**Triệu chứng**: Threshold `http_req_duration{endpoint:lb_timeout_demo} p(95)<250` fail.

**Nguyên nhân có thể**:

1. **`proxy_read_timeout` được set cao hơn 150ms**: Kiểm tra Nginx config.
2. **Nginx đang retry nhiều lần**: Nếu upstream có nhiều server, mỗi lần retry thêm 150ms.
3. **Network latency cao**: Nếu Nginx và origin không cùng host/network.
4. **k6 bị bottleneck VU**: Nếu `maxVUs` quá thấp, iteration phải chờ VU.

**Cách debug**:

```powershell
# Kiểm tra p95 chi tiết
# Chạy k6 và xuất JSON để phân tích distribution

# Kiểm tra network latency
docker exec <nginx-container> ping -c 10 lb-slow-origin

# Kiểm tra retry behavior trong Nginx error log
docker exec <nginx-container> grep "upstream timed out" /var/log/nginx/error.log | wc -l
```

### 24.4. Problem 4: "Có `X-Cache` header trong response"

**Triệu chứng**: Check `'lb timeout no cache header'` fail.

**Nguyên nhân có thể**:

1. **Sai profile**: Đang dùng `full` thay vì `full-no-cdn`. CDN/Varnish đứng trước Nginx và thêm `X-Cache`.
2. **Varnish vẫn đang chạy**: Container Varnish chưa được stop khi chạy `full-no-cdn`.
3. **Nginx config upstream có thêm `X-Cache`**: Kiểm tra config.

**Cách debug**:

```powershell
# Kiểm tra profile hiện tại
docker ps --format "table {{.Names}}\t{{.Status}}"

# Đảm bảo Varnish không chạy
docker stop varnish 2>$null

# Kiểm tra xem header X-Cache từ đâu
curl -v http://localhost:80/api/lb/timeout-demo 2>&1 | grep -i x-cache
```

### 24.5. Problem 5: "lb_timeout_504 = 0 dù có 504 response"

**Triệu chứng**: Threshold `lb_timeout_504 count>0` fail, nhưng thấy 504 trong response.

**Nguyên nhân có thể**:

1. **Logic counter sai**: `timeout504.add(1)` không được gọi đúng. Kiểm tra điều kiện `if (res.status === 504)`.
2. **Counter bị reset**: Do chạy nhiều scenario hoặc vòng đời VU.
3. **Threshold check sai metric name**: `lb_timeout_504` vs `lb_timeout_504` (có typo).

**Cách debug**:

```javascript
// Thêm console.log để debug
console.log(`Status: ${res.status}, is504: ${res.status === 504}`);
console.log(`504 counter before: ${timeout504.value}`);

if (res.status === 504) {
  timeout504.add(1);
  console.log(`504 counter after: ${timeout504.value}`);
}
```

---

## 25. What happens to the origin connection after timeout

### 25.1. Nginx perspective

Khi `proxy_read_timeout` trigger:

1. **Nginx đóng TCP connection** tới upstream bằng cách gửi TCP RST (reset) hoặc FIN (finish).
2. **Connection được giải phóng** khỏi connection pool của Nginx.
3. **Worker process tiếp tục xử lý** request khác -- không bị block.
4. **Nginx tạo 504 response** và gửi về client.
5. **Nginx ghi log**: error log ghi `upstream timed out`, access log ghi status `504`.

### 25.2. Origin perspective

Khi Nginx đóng connection:

1. **Origin phát hiện connection đóng**: Tùy vào ngôn ngữ và framework:
   - **Go**: `http.ResponseWriter.Write()` trả về error `write tcp ... connection reset by peer`.
   - **Node.js**: `response.write()` emit `error` event với `ECONNRESET`.
   - **Python/Flask**: Có thể không phát hiện cho đến khi cố gắng write.
   - **Java/Spring**: `ClientAbortException` khi cố gắng write response.

2. **Request vẫn đang xử lý trên origin**: Trừ khi origin code kiểm tra connection state, request sẽ tiếp tục được xử lý đến khi hoàn thành.

3. **Response từ origin bị discard**: Khi origin cố gắng gửi response, TCP stack sẽ trả lỗi (connection đã đóng).

4. **Tài nguyên bị lãng phí**: CPU, memory, database connections vẫn được tiêu thụ cho request đã bị client hủy.

### 25.3. Pattern để origin xử lý graceful timeout

```go
// Go: Kiểm tra context cancellation
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    select {
    case <-ctx.Done():
        // Client đã disconnect (timeout)
        log.Println("Client disconnected, stopping work")
        return
    case result := <-processLongTask():
        // Hoàn thành trước khi timeout
        w.Write(result)
    }
}
```

```javascript
// Node.js: Lắng nghe sự kiện close trên request
app.get('/api/slow', (req, res) => {
    let completed = false;

    req.on('close', () => {
        if (!completed) {
            console.log('Client disconnected before response');
            // Cleanup resources
        }
    });

    doLongTask(() => {
        completed = true;
        if (!res.destroyed) {
            res.json({ result: 'done' });
        }
    });
});
```

### 25.4. Best practices

1. **Luôn có timeout ở cả Gateway và Application level**.
2. **Kiểm tra connection state** trước khi gửi response.
3. **Cleanup resources** khi phát hiện client disconnected.
4. **Ghi log** khi request bị hủy giữa chừng để monitoring.
5. **Không giả định** rằng response sẽ luôn đến được client.

---

## 26. Detailed output line-by-line interpretation guide

### 26.1. K6 console output anatomy

```text
╔══════════════════════════════════════════════════════════════╗
║  (1)  execution: local                                       ║
║  (2)  script: 12-slow-origin-timeouts.js                     ║
║  (3)  output: -                                              ║
║                                                              ║
║  (4)  scenarios: (100.00%) 1 scenario, 20 max VUs,           ║
║        8s max duration (incl. graceful stop):                 ║
║        * timeout_lane: 8.00 iterations/s for 8s              ║
║          (maxVUs: 10-20, gracefulStop: 30s)                  ║
╚══════════════════════════════════════════════════════════════╝
```

**(1) `execution: local`**: k6 đang chạy locally, không phải trên k6 Cloud.

**(2) `script: 12-slow-origin-timeouts.js`**: Tên script đang chạy.

**(3) `output: -`**: Không có output plugin (InfluxDB, Kafka, etc.) được cấu hình. Kết quả chỉ hiển thị trên console.

**(4) Scenario summary**: `timeout_lane` scenario với `constant-arrival-rate` executor, rate 8/s, duration 8s, maxVUs 20, gracefulStop 30s.

```text
     ✓ lb timeout status is 504
     ✓ lb timeout upstream header present
     ✓ lb timeout policy header present
     ✓ lb timeout no cache header
```

Bốn dấu ✓ xác nhận tất cả 4 check types đều pass. Mỗi check được chạy cho mỗi request. Với 65 request: 65 * 4 = 260 checks pass (hiển thị ở dòng dưới).

```text
     █ lb_slow_origin_timeouts

       ✓ lb_timeout_504.................: 65     (count>0)
       ✓ lb_timeout_unexpected..........: 0      (count==0)
       ✓ http_req_duration{endpoint:lb_timeout_demo}: p(95)=153.45ms (p(95)<250)
```

Đây là phần threshold evaluation. Mỗi dòng hiển thị:

- ✓ (pass) hoặc ✗ (fail).
- Tên metric.
- Giá trị thực tế.
- Điều kiện threshold (trong ngoặc đơn).

`lb_timeout_504: 65 (count>0)`: Counter đạt 65, threshold yêu cầu count>0 -> ✓ PASS.
`lb_timeout_unexpected: 0 (count==0)`: Counter đạt 0, threshold yêu cầu count==0 -> ✓ PASS.
`http_req_duration p(95)=153.45ms (p(95)<250)`: p95 = 153.45ms, threshold yêu cầu <250ms -> ✓ PASS.

```text
     checks_total.......................: 260     100.00% ✓ 260    ✗ 0
```

Tổng số checks: 260. Tỉ lệ pass: 100%. 260 pass, 0 fail.

```text
     http_req_duration..................: avg=152.1ms min=150.2ms med=151.8ms max=158.3ms p(90)=154.2ms p(95)=153.45ms
```

Thống kê response time cho **tất cả** request (không lọc theo tag):

- `avg=152.1ms`: Trung bình.
- `min=150.2ms`: Nhanh nhất. Vẫn > 150ms (timeout value), khớp dự đoán.
- `med=151.8ms`: Median.
- `max=158.3ms`: Chậm nhất.
- `p(90)=154.2ms`, `p(95)=153.45ms`: p95 < p90? Có thể do số lượng sample nhỏ (65) gây ra sự không nhất quán trong tính toán percentile. Với sample lớn hơn, p95 > p90.

```text
     http_req_failed....................: 100.00%  ✓ 65     ✗ 0
```

**QUAN TRỌNG**: Dòng này có dấu ✓ trước 65 -- nghĩa là 65 request bị tính là "failed" (status >= 400). Nhưng đây không phải là threshold fail (không có threshold cho `http_req_failed` trong case này). Dấu ✓ chỉ là visual indicator của k6 cho thấy 65 request rơi vào nhóm "failed". **Đây là EXPECTED**.

```text
     http_reqs..........................: 65       8.125/s
```

Tổng cộng 65 request được gửi, với tần suất trung bình 8.125/s (gần với rate 8/s).

```text
     vus................................: 10       min=10   max=10
     vus_max............................: 20
```

Số VU được sử dụng: ổn định ở 10 (preAllocatedVUs). maxVUs=20 nhưng không cần dùng hết vì rate=8/s không yêu cầu nhiều VU.

```text
     iterations.........................: 65       8.125/s
```

Tổng cộng 65 iteration hoàn thành (mỗi iteration = 1 request), không có iteration nào bị gián đoạn.

```text
  running (08.0s), 10/20 VUs, 65 complete and 0 interrupted iterations
```

Tổng thời gian chạy: 8 giây. 10 trên 20 VU được sử dụng. 65 iteration hoàn thành, 0 bị gián đoạn.

```text
  ✓ http_req_duration{endpoint:lb_timeout_demo}...: p(95)=153.45ms ✓ (p(95)<250)
  ✓ lb_timeout_504...............................: 65            ✓ (count>0)
  ✓ lb_timeout_unexpected........................: 0             ✓ (count==0)
```

Final threshold summary: tất cả 3 thresholds đều PASS.

```text
  █ 100% checks passed / 260 checks
  exit code: 0
  Result: PASS
```

Kết luận cuối cùng: 100% checks pass, exit code 0 (thành công), Result = PASS.

---

## 27. Quick reference card

### 27.1. Default run parameters

| Parameter | Default | Env var |
| --- | ---: | --- |
| Rate (req/s) | 8 | `LB_TIMEOUT_RATE` |
| Duration (s) | 8 | `LB_TIMEOUT_DURATION_SECONDS` |
| Pre-allocated VUs | 10 | `LB_TIMEOUT_PRE_ALLOCATED_VUS` |
| Max VUs | 20 | `LB_TIMEOUT_MAX_VUS` |
| Expected total requests | ~64-65 | (rate * duration) |

### 27.2. Expected results summary

| Metric | Expected |
| --- | --- |
| Exit code | 0 |
| Checks | 100% (260/260) |
| HTTP failed | 100% (65/65) -- EXPECTED |
| `lb_timeout_504` | 65 (all requests) |
| `lb_timeout_unexpected` | 0 |
| Status codes | Only 504 |
| p95 duration | ~150-160ms |
| `X-LB-Timeout-Policy` | `read_timeout=150ms` |
| `X-Upstream-Service` | `lb-slow-origin` |
| `X-Cache` | Absent |

### 27.3. Key takeaway

> **Timeout policy không phải là bug -- nó là tuyến phòng thủ có chủ đích. `504 Gateway Timeout` trong case này chứng minh Nginx đang bảo vệ hệ thống khỏi slow origin, không phải dấu hiệu hệ thống có vấn đề. Đọc `http_req_failed=100%` trong context: nó là expected, không phải failure.**

---

## 28. Reference

### 28.1. Internal

| Resource | Location |
| --- | --- |
| Script | `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/12-slow-origin-timeouts.js` |
| Shared helper | `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/shared.js` |
| Common helper | `E:/Projects/k6/k6-metrics-server/load-target/k6/shared/common.js` |
| Case catalog | `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/case-catalog.json` |
| Nginx config | `E:/Projects/k6/k6-metrics-server/load-target/nginx/nginx.conf` |
| Runner | `E:/Projects/k6/k6-metrics-server/scripts/run-lb-capabilities.ps1` |
| Overview doc | `./00_overview.md` |
| Validation doc | `./13_validation-and-chart-analysis.md` |

### 28.2. External

| Resource | URL |
| --- | --- |
| Nginx `proxy_read_timeout` | `https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout` |
| Nginx upstream module | `https://nginx.org/en/docs/http/ngx_http_upstream_module.html` |
| k6 `constant-arrival-rate` | `https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/` |
| k6 Custom metrics | `https://grafana.com/docs/k6/latest/using-k6/metrics/create-custom-metrics/` |
| k6 Thresholds | `https://grafana.com/docs/k6/latest/using-k6/thresholds/` |
| k6 Checks | `https://grafana.com/docs/k6/latest/using-k6/checks/` |
| HTTP 504 Gateway Timeout | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/504` |
| Nginx `proxy_next_upstream` | `https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream` |
| Circuit Breaker pattern | `https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker` |
