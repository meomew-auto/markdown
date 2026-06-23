# Case 07: Rate limit and connection pressure

> **Case ID:** `lb-07-rate-limit-and-connection-pressure`
> **Script:** `07-rate-limit-and-connection-pressure.js`
> **Profile:** `full-no-cdn`
> **Proof:** Nginx shed load bằng `429` đúng contract, không phát sinh status bất ngờ

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

Một nền tảng thương mại điện tử vận hành Nginx làm Gateway duy nhất trước toàn bộ hệ thống microservices phía sau. Vào các đợt cao điểm -- flash sale, khuyến mãi lớn, hoặc sự kiện ra mắt sản phẩm -- lượng request đổ về có thể tăng gấp 5 đến 10 lần so với bình thường trong vòng vài giây.

Nếu không có cơ chế bảo vệ ở tầng Gateway, toàn bộ lượng traffic này sẽ được chuyển tiếp thẳng đến các service phía sau (products-service, order-service, auth-service, v.v.). Hậu quả là:

| Hậu quả | Cơ chế gây ra | Mức độ ảnh hưởng |
| --- | --- | --- |
| Origin quá tải, response time tăng vọt | Connection pool cạn kiệt, thread pool bão hòa | Toàn bộ người dùng bị ảnh hưởng, kể cả những request hợp lệ |
| Cascade failure | Một service chết kéo theo các service khác do dependency | Hệ thống sập hoàn toàn, thời gian phục hồi tính bằng giờ |
| Không phân biệt được traffic hợp lệ và bất thường | Không có cơ chế shed load thông minh | Bot/Tấn công DDoS và người dùng thật bị đối xử như nhau |
| Mất khả năng quan sát (observability) | Không có signal phân loại request bị từ chối | Ops team không biết bao nhiêu % traffic bị shed, có bất thường không |

### 1.2 Rate limiting là tuyến phòng thủ đầu tiên

Rate limiting ở Gateway không phải là "từ chối người dùng" -- nó là **bảo vệ người dùng**. Khi Gateway shed load có kiểm soát:

```text
Không có rate limit: 10,000 request/s → origin → tất cả đều timeout → 0 người dùng được phục vụ
Có rate limit:       10,000 request/s → Gateway → 2,000 được phục vụ (200), 8,000 bị chặn (429)
                     → Ít nhất 2,000 request/s thành công thay vì 0
```

Người dùng nhận được `429 Too Many Requests` vẫn tốt hơn là nhận được timeout sau 30 giây chờ đợi.

### 1.3 Ba câu hỏi mà case này trả lời

Case 07 được thiết kế để trả lời ba câu hỏi cốt lõi về pressure policy của Nginx:

1. **Khi traffic vượt ngưỡng, Nginx có thực sự trả về `429` không?** -- Không phải "hy vọng" hay "có lẽ", mà phải chứng minh được bằng metrics.
2. **Nginx có vô tình trả về status ngoài contract không?** -- `500`, `502`, `503` là những status bất ngờ cho thấy policy bị cấu hình sai hoặc origin bị ép quá tải.
3. **Tỉ lệ 200/429 có nằm trong vùng kiểm soát không?** -- Không phải tất cả đều 429 (quá nghiêm ngặt), cũng không phải tất cả đều 200 (không có tác dụng).

---

## 2. LB capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh pressure policy của Nginx -- khả năng hấp thụ traffic vượt ngưỡng và trả về `429` có kiểm soát thay vì đẩy toàn bộ áp lực xuống origin:

> **Nginx shed load bằng `429` đúng contract, không phát sinh status bất ngờ**

Cụ thể hơn:

```text
traffic rate cao (30 request/s, constant-arrival-rate)
  → một phần request được chấp nhận (200)
  → một phần request bị từ chối có chủ đích (429)
  → không có status nào ngoài {200, 429}
  → custom metric lb_pressure_unexpected = 0
```

### 2.2 Ba custom metrics -- bộ ba chứng minh

Case này định nghĩa ba custom metrics để phân loại chính xác từng response:

| Metric | Kiểu | Ý nghĩa | Threshold |
| --- | --- | --- | --- |
| `lb_pressure_200` | `Counter` | Số request được Nginx chấp nhận và chuyển tiếp đến origin thành công | `count > 0` |
| `lb_pressure_429` | `Counter` | Số request bị Nginx từ chối tại Gateway bằng `429 Too Many Requests` | `count > 0` |
| `lb_pressure_unexpected` | `Counter` | Số request trả về status **không phải** 200 hoặc 429 -- đây là tín hiệu cảnh báo | `count == 0` |

Điểm mấu chốt: **`lb_pressure_429 > 0` là PASS, không phải FAIL**. Đây là điều khiến nhiều người mới học bối rối -- xem section 12.

### 2.3 OPEN MODEL -- constant-arrival-rate

Case này sử dụng executor `constant-arrival-rate`, khác biệt cơ bản so với `constant-vus`:

```text
constant-vus:           "Tôi có N VUs, mỗi VU gửi request, đợi response, rồi gửi tiếp"
                        → Tốc độ request phụ thuộc vào response time của origin
                        → Không tạo được áp lực ổn định nếu origin chậm dần

constant-arrival-rate:  "Tôi cần đúng R request mỗi giây, bất kể response time"
                        → Tốc độ request được giữ cố định
                        → Nếu response time tăng, k6 tự động phân bổ thêm VUs
                        → Tạo được áp lực ổn định, lý tưởng để test rate limit
```

Đây chính là lý do case này được gọi là **OPEN MODEL** -- request đến với tốc độ cố định, không bị giới hạn bởi số VUs đang bận (closed model).

### 2.4 Tại sao capability này quan trọng

Không có pressure policy đúng, Gateway trở thành "ống dẫn" thụ động:

```text
Không có rate limit:      Mọi request đến origin → origin sập → tất cả người dùng thất bại
Rate limit quá nghiêm:    Hầu hết request bị 429 → người dùng không truy cập được
Rate limit quá lỏng:      Vẫn quá nhiều request đến origin → origin vẫn sập
Rate limit đúng:          Một phần request được phục vụ, phần còn lại bị chặn có kiểm soát
                          → Origin sống sót → người dùng được phục vụ trong giới hạn
```

---

## 3. Vì sao phải test ở LB layer

### 3.1 Gateway là điểm quyết định shed/forward

```text
Người dùng → Nginx (Gateway :80) → Origin (products-service, order-service, ...)
                 ↑
            Điểm quyết định: forward hay reject bằng 429?
```

Khi một request đến, Nginx là thành phần đầu tiên tiếp nhận. Nếu Nginx không có logic rate limit, request sẽ được forward ngay xuống origin. Một khi request đã đến origin, việc từ chối nó trở nên đắt đỏ hơn nhiều: origin đã tiêu tốn connection, thread, memory để xử lý request đó.

Test ở LB layer là cách duy nhất để xác nhận:

1. **Rate limit được thực thi trước khi request đến origin**
2. **Status `429` đến từ Nginx, không phải từ origin**
3. **Origin không bị quá tải trong suốt quá trình test**

### 3.2 Không thể test rate limit ở tầng app

Nếu chỉ test rate limit ở tầng app (bỏ qua Nginx):

```text
Test sai:   curl http://localhost:8080/api/lb/pressure-demo  (đi thẳng app, không qua Nginx)
Test đúng:  curl http://localhost:80/api/lb/pressure-demo     (đi qua Nginx → rate limit policy)
```

Chỉ request qua `:80` mới đi qua Nginx và mới kích hoạt được `limit_req` / `limit_conn` policy.

### 3.3 Signal từ Nginx header là evidence không thể chối cãi

Khi Nginx từ chối request bằng `429`, nó có thể (và nên) gắn thêm header để cho biết lý do:

```text
X-LB-RateLimit: rate_exceeded
```

Header này là bằng chứng cho thấy `429` đến từ Nginx rate limit, không phải từ origin gặp lỗi. Nếu không test ở LB layer, bạn không thể xác minh được sự hiện diện của header này.

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌──────────────────────────────┐
                          │     k6 test script            │
                          │  (07-rate-limit-and-          │
                          │   connection-pressure.js)     │
                          └──────────────┬───────────────┘
                                         │
                           constant-arrival-rate
                           30 request/s, 10 giây
                                         │
                                         ▼
┌────────────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx Gateway)                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Nginx pressure policy                                        │  │
│  │  ┌──────────────────┐  ┌──────────────────┐                  │  │
│  │  │ limit_req_zone   │  │ limit_conn       │                  │  │
│  │  │ rate=10r/s       │  │ max_conn=4       │                  │  │
│  │  │ burst=5 nodelay  │  │                  │                  │  │
│  │  └────────┬─────────┘  └────────┬─────────┘                  │  │
│  │           │                     │                              │  │
│  │           ▼                     ▼                              │  │
│  │  ┌──────────────────────────────────────────────────────┐    │  │
│  │  │              Request processing                       │    │  │
│  │  │   • Nếu trong hạn mức → forward (200)                 │    │  │
│  │  │   • Nếu vượt hạn mức → reject (429)                   │    │  │
│  │  │   • Nếu lỗi khác → unexpected                         │    │  │
│  │  └──────────────────────────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                │                                     │
│                    (chỉ request 200)                                  │
│                                ▼                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  lb-stable-origin                                              │  │
│  │  Endpoint: GET /api/lb/pressure-demo                           │  │
│  │  Response: { "role": "stable", "message": "pressure test" }    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `full-no-cdn` (bắt buộc) | `docker ps` thấy Nginx container, không thấy Varnish |
| `BASE_URL` | `http://localhost:80` | `curl -sI http://localhost:80/api/lb/pressure-demo` thấy `X-Served-By: nginx` |
| Nginx có rate limit config | `limit_req_zone` và `limit_req` trong `nginx.conf` | Xem file cấu hình Nginx |
| `lb-stable-origin` đang chạy | Service trả về 200 tại `/api/lb/pressure-demo` | `curl http://localhost:80/api/lb/pressure-demo` |
| Không có CDN/Varnish | `X-Cache` header phải vắng mặt | `curl -sI http://localhost:80/api/lb/pressure-demo \| grep -i x-cache` → không có output |

### 4.3 Stack khởi động

```powershell
# Khởi động full stack không có CDN
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
```

Đợi tất cả service healthy (khoảng 30-60 giây). Kiểm tra:

```powershell
# Xác nhận Nginx đang chạy
docker ps --filter "name=nginx"

# Xác nhận public path hoạt động
curl -sI http://localhost:80/api/lb/pressure-demo

# Xác nhận không có Varnish (CDN)
docker ps --filter "name=varnish"  # Phải trả về rỗng
```

### 4.4 Precondition của script

Script này **không có `setup()` function**. Lý do:

- Không cần pre-populate cache (khác với CDN cases)
- Không cần clear state từ lần chạy trước (rate limit counter reset theo từng request)
- Mỗi lần chạy là độc lập -- không có state tồn đọng giữa các lần chạy

Tuy nhiên, có một precondition ngầm: **Nginx phải được cấu hình rate limit trước khi chạy script**. Script không tự động cấu hình Nginx -- việc này thuộc về stack startup.

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\lb\07-rate-limit-and-connection-pressure.js
```

### 5.2 Import và dependency

```javascript
import { check } from 'k6';
import { Counter } from 'k6/metrics';

import { envInt } from '../shared/common.js';
import { lbCapabilityApis, requestLB } from './shared.js';
```

Phân tích từng import:

| Import | Nguồn gốc | Vai trò trong script này |
| --- | --- | --- |
| `check` | `k6` built-in | Xác minh mỗi response có status 200 hoặc 429, và không có `X-Cache` header |
| `Counter` | `k6/metrics` built-in | Tạo ba custom metrics: `lb_pressure_200`, `lb_pressure_429`, `lb_pressure_unexpected` |
| `envInt` | `../shared/common.js` | Đọc biến môi trường dạng số nguyên, có fallback default |
| `lbCapabilityApis` | `./shared.js` | Object chứa định nghĩa API `pressureDemo` (`GET /api/lb/pressure-demo`) |
| `requestLB` | `./shared.js` | Hàm gửi HTTP request qua Nginx (`:80`), wrapper quanh `requestApi` |

### 5.3 Biến môi trường (env knobs)

```javascript
const PRESSURE_RATE = envInt('LB_PRESSURE_RATE', 30);
const PRESSURE_DURATION = `${envInt('LB_PRESSURE_DURATION_SECONDS', 10)}s`;
const PRESSURE_PRE_ALLOCATED_VUS = envInt('LB_PRESSURE_PRE_ALLOCATED_VUS', 20);
const PRESSURE_MAX_VUS = envInt('LB_PRESSURE_MAX_VUS', 40);
```

Bốn biến môi trường cho phép điều chỉnh áp lực test mà không cần sửa script:

| Biến | Default | Ý nghĩa | Khi nào tăng | Khi nào giảm |
| --- | --- | --- | --- | --- |
| `LB_PRESSURE_RATE` | `30` | Request mỗi giây (constant arrival rate) | Muốn test ngưỡng rate limit cao hơn | Muốn test với áp lực nhẹ hơn |
| `LB_PRESSURE_DURATION_SECONDS` | `10` | Thời gian duy trì áp lực (giây) | Cần sample lớn hơn để quan sát pattern ổn định | Chạy nhanh để kiểm tra smoke |
| `LB_PRESSURE_PRE_ALLOCATED_VUS` | `20` | Số VUs được khởi tạo sẵn khi bắt đầu scenario | Response time cao, cần nhiều VUs hơn để đạt target rate | Tiết kiệm tài nguyên |
| `LB_PRESSURE_MAX_VUS` | `40` | Số VUs tối đa k6 được phép sử dụng | `preAllocatedVUs` không đủ để duy trì target rate | Giới hạn tài nguyên hệ thống |

**Lưu ý quan trọng:** `PRESSURE_DURATION` được chuyển thành string có hậu tố `s` (vd: `"10s"`) để phù hợp với format duration của k6 options.

### 5.4 Custom metrics -- bộ ba Counter

```javascript
const pressure200 = new Counter('lb_pressure_200');
const pressure429 = new Counter('lb_pressure_429');
const pressureUnexpected = new Counter('lb_pressure_unexpected');
```

Mỗi metric là một `Counter` -- giá trị chỉ tăng, không giảm. Đây là kiểu metric phù hợp nhất cho việc đếm số lượng response theo phân loại status:

```text
lb_pressure_200:        Mỗi lần response.status === 200 → +1
lb_pressure_429:        Mỗi lần response.status === 429 → +1
lb_pressure_unexpected: Mỗi lần response.status không phải 200 hoặc 429 → +1
```

Cả ba được khởi tạo ở module scope (không nằm trong function nào), nên chúng tồn tại trong suốt vòng đời của test run và được k6 tự động aggregate vào cuối run.

### 5.5 options block

```javascript
export const options = {
  scenarios: {
    pressure: {
      executor: 'constant-arrival-rate',
      rate: PRESSURE_RATE,
      timeUnit: '1s',
      duration: PRESSURE_DURATION,
      preAllocatedVUs: PRESSURE_PRE_ALLOCATED_VUS,
      maxVUs: PRESSURE_MAX_VUS,
    },
  },
  thresholds: {
    'lb_pressure_200': ['count>0'],
    'lb_pressure_429': ['count>0'],
    'lb_pressure_unexpected': ['count==0'],
  },
  tags: {
    scenario: 'lb_rate_limit_and_connection_pressure',
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};
```

Phân tích chi tiết từng phần:

#### Scenarios

```javascript
pressure: {
  executor: 'constant-arrival-rate',
  rate: 30,             // 30 request mỗi giây
  timeUnit: '1s',       // Đơn vị thời gian là 1 giây
  duration: '10s',      // Chạy trong 10 giây → tổng ~300 request
  preAllocatedVUs: 20,  // Khởi tạo sẵn 20 VUs
  maxVUs: 40,           // Cho phép mở rộng lên đến 40 VUs nếu cần
}
```

Điểm quan trọng: `rate: 30` với `timeUnit: '1s'` nghĩa là 30 request/giây. Với `duration: '10s'`, tổng số request lý tưởng là 300. Tuy nhiên, con số thực tế có thể khác do:
- Thời gian khởi tạo VUs ban đầu
- Graceful ramp-down ở cuối scenario
- Một số request bị drop nếu không đủ VUs (dù `maxVUs` đã được set)

##### Phân tích executor: vì sao dùng `constant-arrival-rate` cho case này?

Đây là case DUY NHẤT trong LB suite dùng `constant-arrival-rate` (open model).
Khác biệt cơ bản với `constant-vus` (closed model) ở các case khác.

**Yêu cầu của case:**

```text
1. Rate cố định BẮT BUỘC: 30 req/s chính xác, không phụ thuộc response time
   → Muốn test "server phản ứng thế nào khi bị ép đúng 30 req/s?"
   → Nếu dùng constant-vus: rate = vus/iter_time → khi server chậm, rate GIẢM
   → Với constant-arrival-rate: rate LUÔN 30/s, dù server chậm → tạo áp lực thật

2. Cần thấy 429 (rate limit): nếu server chậm + rate không đổi → queue đầy → 429
   → Đây là MỤC TIÊU TEST — verify rate limiting hoạt động
   → Threshold: 'lb_pressure_429' phải count>0 → phải có 429!

3. Open model: iteration được schedule theo rate, KHÔNG đợi iter trước xong
   → preAllocatedVUs=20, maxVUs=40: cho phép spawn thêm VU khi cần
```

**So sánh executor:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **constant-arrival-rate** (đang dùng) | ✅ **ĐÚNG** | Rate cố định 30/s. Open model — iteration schedule độc lập với completion. Cần thấy 429 khi quá tải. |
| constant-vus | ❌ SAI | Closed model — rate = vus/iter_time. Khi server chậm, rate GIẢM → không tạo đủ áp lực → không thấy 429. |
| ramping-arrival-rate | ⚠️ Có thể nếu cần ramp | Nếu muốn test "tăng dần rate đến khi thấy 429". Case này dùng rate cố định → constant-arrival-rate đơn giản hơn. |
| shared-iterations | ❌ SAI | Cần tổng iter cố định. Case này cần rate THEO THỜI GIAN. |
| per-vu-iterations | ❌ SAI | Cần iter/VU cố định. Không phù hợp. |

**Key insight**: Rate limit test CẦN open model. Nếu dùng closed model, server
chậm → VU bận lâu → rate giảm → server hết quá tải → rate limit KHÔNG BAO GIỜ
kích hoạt. `constant-arrival-rate` ép rate 30/s bất kể server state → tạo áp
lực thật → verify 429 xuất hiện.

#### Thresholds

```javascript
thresholds: {
  'lb_pressure_200': ['count>0'],         // Phải có ít nhất 1 request được chấp nhận
  'lb_pressure_429': ['count>0'],         // Phải có ít nhất 1 request bị từ chối
  'lb_pressure_unexpected': ['count==0'], // KHÔNG được có bất kỳ status lạ nào
}
```

Ba thresholds này tạo thành "tam giác chứng minh":

```text
lb_pressure_200 > 0      → Có traffic được phục vụ (rate limit không chặn tất cả)
lb_pressure_429 > 0      → Rate limit đang hoạt động (không phải "vô hiệu")
lb_pressure_unexpected == 0 → Rate limit hoạt động đúng (không có side effect)
```

Nếu **chỉ** có `lb_pressure_200 > 0` và `lb_pressure_429 === 0`: rate limit không hoạt động -- FAIL.
Nếu **chỉ** có `lb_pressure_429 > 0` và `lb_pressure_200 === 0`: rate limit quá nghiêm ngặt, chặn tất cả -- FAIL.
Nếu `lb_pressure_unexpected > 0`: có status ngoài contract -- FAIL.

#### Tags

```javascript
tags: {
  scenario: 'lb_rate_limit_and_connection_pressure',
  target_layer: 'lb',
  lb_profile: 'full-no-cdn',
}
```

Tags được áp dụng cho tất cả metrics trong script này. Chúng cho phép lọc và nhóm kết quả trên dashboard/cloud theo scenario, layer, và profile.

### 5.6 default function -- logic chính

```javascript
export default function () {
  const api = lbCapabilityApis.pressureDemo;
  const res = requestLB(api, {
    headers: {
      Connection: 'close',
    },
    tags: {
      endpoint: api.name,
      lb_profile: 'full-no-cdn',
    },
  });

  check(res, {
    'lb pressure status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'lb pressure no cache header': (r) => !(r.headers['X-Cache'] || ''),
  });

  if (res.status === 200) {
    pressure200.add(1);
  } else if (res.status === 429) {
    pressure429.add(1);
  } else {
    pressureUnexpected.add(1);
  }
}
```

#### Bước 1: Chọn API endpoint

```javascript
const api = lbCapabilityApis.pressureDemo;
```

`lbCapabilityApis.pressureDemo` được định nghĩa trong `shared.js`:

```javascript
pressureDemo: {
  name: 'lb_pressure_demo',
  method: 'GET',
  path: '/api/lb/pressure-demo',
  expectedUpstream: 'lb-stable-origin',
}
```

#### Bước 2: Gửi request với Connection: close

```javascript
const res = requestLB(api, {
  headers: {
    Connection: 'close',
  },
  tags: {
    endpoint: api.name,
    lb_profile: 'full-no-cdn',
  },
});
```

`Connection: close` là một chi tiết quan trọng: nó yêu cầu Nginx đóng connection sau khi response được gửi, thay vì giữ connection alive (keep-alive). Trong bối cảnh test connection pressure, điều này đảm bảo mỗi request tạo một connection mới, làm tăng áp lực connection lên Nginx.

#### Bước 3: Checks

```javascript
check(res, {
  'lb pressure status is 200 or 429': (r) => r.status === 200 || r.status === 429,
  'lb pressure no cache header': (r) => !(r.headers['X-Cache'] || ''),
});
```

Hai checks:

1. **Status check**: Xác nhận mỗi response có status `200` hoặc `429`. Nếu xuất hiện bất kỳ status nào khác (`500`, `502`, `503`, v.v.), check này fail cho request đó.
2. **No cache check**: Xác nhận không có `X-Cache` header. Vì profile `full-no-cdn` cố ý bypass CDN, sự hiện diện của `X-Cache` cho thấy topology sai (đang chạy qua Varnish).

#### Bước 4: Phân loại và đếm

```javascript
if (res.status === 200) {
  pressure200.add(1);
} else if (res.status === 429) {
  pressure429.add(1);
} else {
  pressureUnexpected.add(1);
}
```

Logic phân loại đơn giản nhưng chính xác:
- `200` → `lb_pressure_200` (accepted)
- `429` → `lb_pressure_429` (shed)
- Mọi status khác → `lb_pressure_unexpected` (cảnh báo)

### 5.7 Sơ đồ tổ chức toàn bộ script

```text
┌─ Import: check (k6), Counter (k6/metrics), envInt (common), lbCapabilityApis + requestLB (shared)
│
├─ Env vars: PRESSURE_RATE (30), PRESSURE_DURATION (10s),
│            PRESSURE_PRE_ALLOCATED_VUS (20), PRESSURE_MAX_VUS (40)
│
├─ Custom metrics: pressure200 (Counter), pressure429 (Counter), pressureUnexpected (Counter)
│
├─ options
│   ├─ scenarios: pressure = constant-arrival-rate, 30/s, 10s, 20-40 VUs
│   ├─ thresholds: lb_pressure_200 count>0, lb_pressure_429 count>0, lb_pressure_unexpected count==0
│   └─ tags: scenario, target_layer, lb_profile
│
└─ default()
    ├─ Lấy api = lbCapabilityApis.pressureDemo
    ├─ Gửi GET /api/lb/pressure-demo với Connection: close
    ├─ Check: status in {200, 429}, no X-Cache
    └─ Phân loại: 200→pressure200, 429→pressure429, khác→pressureUnexpected
```

---

## 6. Nginx/LB mechanism deep-dive

### 6.1 Hai cơ chế bảo vệ độc lập

Nginx cung cấp hai cơ chế bảo vệ khác nhau, hoạt động ở hai tầng khác nhau:

| Cơ chế | Directive | Bảo vệ chống lại | Hoạt động ở tầng |
| --- | --- | --- | --- |
| **Rate limiting** | `limit_req_zone` + `limit_req` | Quá nhiều request trên cùng một đơn vị thời gian | Request rate |
| **Connection limiting** | `limit_conn_zone` + `limit_conn` | Quá nhiều connection đồng thời từ cùng một client IP | Connection count |

Hai cơ chế này **độc lập** với nhau. Một request có thể vượt qua rate limit nhưng bị chặn bởi connection limit, hoặc ngược lại.

### 6.2 Rate limiting: limit_req_zone và limit_req

#### Khai báo zone (trong http block)

```nginx
limit_req_zone $binary_remote_addr zone=pressure_zone:10m rate=10r/s;
```

Phân tích từng phần:

| Thành phần | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `$binary_remote_addr` | Địa chỉ IP của client (dạng binary, tiết kiệm memory) | Key để định danh client -- mỗi IP có bucket riêng |
| `zone=pressure_zone:10m` | Tên zone là `pressure_zone`, kích thước 10MB | 10MB đủ cho ~160,000 IPs (binary format) |
| `rate=10r/s` | 10 request mỗi giây | Tốc độ tối đa cho phép: 10 request/giây/IP |

#### Áp dụng zone (trong location hoặc server block)

```nginx
location /api/lb/pressure-demo {
    limit_req zone=pressure_zone burst=5 nodelay;
    proxy_pass http://lb_stable_origin;
}
```

| Tham số | Ý nghĩa | Hành vi |
| --- | --- | --- |
| `zone=pressure_zone` | Sử dụng zone đã khai báo ở trên | Mỗi IP được giới hạn 10r/s |
| `burst=5` | Cho phép 5 request vượt quá rate được xếp hàng (queue) | Nếu không có `nodelay`, 5 request này sẽ bị delay; với `nodelay`, chúng được xử lý ngay |
| `nodelay` | Không delay burst request | Request trong burst được xử lý ngay, nhưng vẫn tính vào hạn mức |

#### Mô hình token bucket

Rate limiting trong Nginx hoạt động theo mô hình **token bucket**:

```text
┌──────────────────────────────────────────────────┐
│                Token Bucket                       │
│  ┌────────────────────────────────────┐          │
│  │  Capacity: burst + 1 tokens        │          │
│  │  Fill rate: rate tokens/second     │          │
│  │  ┌───┬───┬───┬───┬───┬───┐        │          │
│  │  │ T │ T │ T │ T │ T │ T │  ...   │          │
│  │  └───┴───┴───┴───┴───┴───┘        │          │
│  └────────────────────────────────────┘          │
│                                                    │
│  Mỗi request đến:                                  │
│  • Nếu còn token → lấy 1 token, forward request    │
│  • Nếu hết token → từ chối (429 hoặc delay)        │
│                                                    │
│  Token được thêm vào bucket với tốc độ rate=10r/s  │
│  Tối đa burst+1 = 6 tokens trong bucket            │
└──────────────────────────────────────────────────┘
```

Với cấu hình `rate=10r/s burst=5 nodelay`:

- Bucket có tối đa 6 tokens (burst + 1)
- Token được thêm với tốc độ 10 token/giây
- Request đến lấy 1 token nếu có
- Nếu không còn token: trả về `429` ngay lập tức (vì `nodelay`)

### 6.3 Connection limiting: limit_conn_zone và limit_conn

#### Khai báo zone

```nginx
limit_conn_zone $binary_remote_addr zone=conn_zone:10m;
```

#### Áp dụng zone

```nginx
location /api/lb/pressure-demo {
    limit_conn conn_zone 4;
    limit_req zone=pressure_zone burst=5 nodelay;
    proxy_pass http://lb_stable_origin;
}
```

`limit_conn conn_zone 4` nghĩa là: mỗi IP không được có quá **4 connections đồng thời**. Connection thứ 5 trở đi sẽ bị từ chối.

### 6.4 Cấu hình status code trả về

```nginx
limit_req_status 429;
limit_conn_status 429;
```

Hai directive này đảm bảo cả rate limit và connection limit đều trả về cùng một status code: `429 Too Many Requests`. Điều này giúp client (và script test) có thể xử lý thống nhất.

### 6.5 Tương tác giữa rate limit và connection limit

```text
Request đến /api/lb/pressure-demo
        │
        ▼
┌──────────────────┐
│  Connection limit │──→ Vượt quá 4 connections? ──→ 429 (limit_conn_status)
│  (limit_conn)    │
└────────┬─────────┘
         │ OK (≤ 4 connections)
         ▼
┌──────────────────┐
│  Rate limit       │──→ Vượt quá 10r/s + burst 5? ──→ 429 (limit_req_status)
│  (limit_req)      │
└────────┬─────────┘
         │ OK (còn token trong bucket)
         ▼
┌──────────────────┐
│  Forward đến      │
│  lb-stable-origin │──→ 200 OK
└──────────────────┘
```

Thứ tự kiểm tra: **connection limit trước, rate limit sau**. Điều này có ý nghĩa: nếu connection đã bị chặn, không cần kiểm tra rate limit nữa.

### 6.6 Header signal từ Nginx

Khi Nginx từ chối request, nó có thể gắn thêm header để ops team biết lý do:

```text
# Khi bị rate limit:
X-LB-RateLimit: rate_exceeded

# Khi bị connection limit:
X-LB-RateLimit: connection_exceeded
```

Khi request được chấp nhận và forward đến origin thành công:

```text
X-Served-By: nginx
X-Upstream-Service: lb-stable-origin
X-Request-ID: <uuid>
```

---

## 7. Request sequence flow

### 7.1 Timeline tổng thể

```text
Thời gian (giây)
0s          1s          2s          ...        9s         10s
│           │           │                       │           │
├───────────┼───────────┼───────────────────────┼───────────┤
│           │           │                       │           │
│  k6 khởi tạo 20 VUs, bắt đầu gửi request với tốc độ 30/s
│           │           │                       │           │
│  Mỗi VU thực thi default() liên tục:
│  GET /api/lb/pressure-demo (Connection: close)
│           │           │                       │           │
│  Nginx tiếp nhận, kiểm tra limit_conn → limit_req
│  • Trong hạn mức → forward → 200
│  • Vượt hạn mức → reject → 429
│           │           │                       │           │
│  Mỗi response được phân loại:
│  200 → pressure200.add(1)
│  429 → pressure429.add(1)
│  khác → pressureUnexpected.add(1)
│           │           │                       │           │
└───────────┴───────────┴───────────────────────┴───────────┘
                                                        │
                                                  k6 dừng scenario
                                                  Tính toán thresholds
                                                  In kết quả
```

### 7.2 Timeline chi tiết cho một request

```text
VU gọi default()
│
├─ 0ms:    Lấy api = lbCapabilityApis.pressureDemo
│          → { name: 'lb_pressure_demo', method: 'GET', path: '/api/lb/pressure-demo' }
│
├─ 0ms:    Gọi requestLB(api, { headers: { Connection: 'close' }, tags: {...} })
│          → Xây dựng HTTP request:
│            GET http://localhost:80/api/lb/pressure-demo
│            Connection: close
│
├─ ~1ms:   TCP connection đến Nginx :80
│
├─ ~1ms:   Nginx kiểm tra limit_conn:
│          • Đếm số connections hiện tại từ IP này
│          • Nếu ≥ 4 → trả 429, đóng connection → KẾT THÚC
│          • Nếu < 4 → tiếp tục
│
├─ ~1ms:   Nginx kiểm tra limit_req:
│          • Kiểm tra token bucket cho IP này
│          • Nếu còn token → lấy 1 token → tiếp tục
│          • Nếu hết token → trả 429, đóng connection → KẾT THÚC
│
├─ ~2ms:   Nginx forward request đến lb-stable-origin
│
├─ ~5ms:   lb-stable-origin xử lý và trả về 200 OK
│          { "role": "stable", "message": "pressure test" }
│
├─ ~6ms:   Nginx nhận response, thêm headers:
│          X-Served-By: nginx
│          X-Upstream-Service: lb-stable-origin
│          X-Request-ID: <uuid>
│
├─ ~7ms:   Nginx trả response cho k6 VU
│
├─ ~7ms:   k6 VU nhận response
│          check(res, { status is 200 or 429, no X-Cache })
│          → status === 200 → pressure200.add(1)
│
└─ ~7ms:   VU kết thúc iteration, sẵn sàng cho iteration tiếp theo
```

### 7.3 Phân phối 200/429 theo thời gian

Với `rate=10r/s burst=5 nodelay` và áp lực 30 request/s từ k6:

```text
Giây thứ 1:
  Token bucket có 6 tokens ban đầu (burst + 1)
  30 request đến:
  • 6 request đầu → có token → 200
  • 24 request sau → hết token → 429
  Token nạp thêm: 10 token/giây → nhưng đã dùng hết

Giây thứ 2:
  Bắt đầu với 0 token (đã dùng hết burst)
  Token nạp với tốc độ 10/giây → trong 1 giây có 10 tokens
  30 request đến:
  • ~10 request → có token → 200
  • ~20 request → hết token → 429

Giây thứ 3 đến 10: Tương tự giây thứ 2
  • ~10 request/giây → 200
  • ~20 request/giây → 429

Tổng kết sau 10 giây (300 request):
  • lb_pressure_200 ≈ 6 + 9×10 = 96
  • lb_pressure_429 ≈ 24 + 9×20 = 204
  • Tỉ lệ 200 ≈ 32%, 429 ≈ 68%
```

Con số thực tế có thể dao động do network jitter, timing của token bucket, và connection limit (giới hạn 4 connections đồng thời có thể làm giảm số request thực tế).

---

## 8. Key signals / headers

### 8.1 Bảng signals chính

| Signal | Vị trí | Expected value | Ý nghĩa | Nếu sai |
| --- | --- | --- | --- | --- |
| `status` | HTTP response status | `200` hoặc `429` | Chỉ hai status này được phép xuất hiện | Xuất hiện `500`, `502`, `503` → policy sai hoặc origin lỗi |
| `X-Served-By` | Response header | `nginx` | Xác nhận response đi qua Nginx | Nếu thiếu → request không qua Gateway |
| `X-Upstream-Service` | Response header (chỉ khi 200) | `lb-stable-origin` | Xác nhận request được forward đến đúng origin | Nếu sai → routing config sai |
| `X-Request-ID` | Response header (chỉ khi 200) | UUID string | Mỗi request có trace ID duy nhất | Nếu thiếu → Nginx không gắn request ID |
| `X-LB-RateLimit` | Response header (chỉ khi 429) | `rate_exceeded` hoặc `connection_exceeded` | Cho biết lý do bị từ chối | Nếu thiếu → không phân biệt được lý do 429 |
| `X-Cache` | Response header | **absent** | Profile `full-no-cdn` không được có CDN cache | Nếu có → đang chạy sai topology (qua Varnish) |
| `lb_pressure_200` | k6 custom metric | `count > 0` | Có ít nhất một request được chấp nhận | Nếu = 0 → rate limit chặn tất cả |
| `lb_pressure_429` | k6 custom metric | `count > 0` | Có ít nhất một request bị từ chối | Nếu = 0 → rate limit không hoạt động |
| `lb_pressure_unexpected` | k6 custom metric | `count == 0` | Không có status ngoài contract | Nếu > 0 → có lỗi bất thường |
| `http_req_failed` | k6 built-in metric | `rate > 0` (expected) | Tỉ lệ request failed cao là **expected** vì 429 được tính là failed | Đừng hoảng khi thấy con số này cao |
| `checks` | k6 built-in metric | `rate == 1` | Tất cả checks đều pass | Nếu < 1 → có request trả về status ngoài {200, 429} |

### 8.2 Cách đọc `http_req_failed`

Đây là điểm gây nhầm lẫn phổ biến nhất. Trong k6, `http_req_failed` được tính là `true` khi status code >= 400. Vì `429 >= 400`, **tất cả request bị shed đều được tính là failed**.

```text
Trong case này:
  http_req_failed cao (~65%) → ĐÚNG, KHÔNG PHẢI BUG
  Đây là expected behavior vì 429 là một phần của contract
```

Cách phân biệt:
- `http_req_failed` cao **nhưng** `lb_pressure_unexpected == 0` → PASS (chỉ có 429, không có status lạ)
- `http_req_failed` cao **và** `lb_pressure_unexpected > 0` → FAIL (có status lạ như 500, 502, 503)

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Một test run được coi là PASS khi thỏa mãn **tất cả** các điều kiện sau:

| # | Tiêu chí | Cách kiểm tra | Giải thích |
| --- | --- | --- | --- |
| 1 | Có traffic được chấp nhận | `lb_pressure_200 > 0` | Rate limit không chặn tất cả -- vẫn có request đến được origin |
| 2 | Có traffic bị từ chối | `lb_pressure_429 > 0` | Rate limit đang hoạt động -- có request bị chặn ở Gateway |
| 3 | Không có status bất thường | `lb_pressure_unexpected == 0` | Không có `500`, `502`, `503`, hoặc bất kỳ status nào ngoài {200, 429} |
| 4 | Tất cả checks pass | `checks rate == 1` | Mọi response đều thỏa mãn: status in {200, 429} và không có `X-Cache` |
| 5 | Không có CDN cache | Không có `X-Cache` header trong bất kỳ response nào | Xác nhận đang chạy đúng topology `full-no-cdn` |

### 9.2 Tiêu chí FAIL

| # | Hiện tượng | Nguyên nhân có thể | Cách debug |
| --- | --- | --- | --- |
| 1 | Xuất hiện `5xx` | Origin quá tải hoặc lỗi; Nginx không bảo vệ được origin | Kiểm tra origin logs, tăng rate limit, kiểm tra `proxy_pass` config |
| 2 | Tất cả request đều `429` | Rate limit quá nghiêm ngặt; `rate` quá thấp hoặc `burst` quá nhỏ | Tăng `rate` hoặc `burst`; kiểm tra xem có đang test từ nhiều IP không |
| 3 | Tất cả request đều `200` | Rate limit không hoạt động; `limit_req` không được áp dụng đúng location | Kiểm tra `nginx.conf`: `limit_req` có nằm trong đúng `location` block không |
| 4 | `lb_pressure_unexpected > 0` | Có status lạ xuất hiện; origin crash; timeout | Kiểm tra k6 logs để biết status cụ thể; kiểm tra origin health |
| 5 | `lb_pressure_200 == 0` | Rate limit chặn tất cả traffic | Giảm `LB_PRESSURE_RATE` hoặc tăng rate limit trong Nginx config |
| 6 | `lb_pressure_429 == 0` | Rate limit không hoạt động; áp lực chưa đủ | Tăng `LB_PRESSURE_RATE` hoặc giảm rate limit trong Nginx config |
| 7 | Có `X-Cache` header | Đang chạy sai topology (qua CDN/Varnish) | Dùng `TargetLayer=full-no-cdn`, không dùng `full` |

### 9.3 Ngưỡng tham chiếu

Dựa trên kết quả validation thực tế (xem section 16), với cấu hình `rate=30/s` và Nginx `limit_req rate=10r/s burst=5`:

```text
PASS zone:
  lb_pressure_200:     30% - 50% của tổng request
  lb_pressure_429:     50% - 70% của tổng request
  lb_pressure_unexpected: 0
  http_req_failed:     ~50% - 70% (expected, vì 429)

FAIL zone:
  lb_pressure_200:     0% hoặc 100%
  lb_pressure_429:     0% hoặc 100%
  lb_pressure_unexpected: > 0
```

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy qua runner script

```powershell
cd E:\Projects\k6\k6-metrics-server
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 07-rate-limit-and-connection-pressure
```

### 10.2 Lệnh chạy trực tiếp bằng k6

```powershell
cd E:\Projects\k6\k6-metrics-server\load-target

$env:BASE_URL = "http://localhost:80"
$env:LB_PRESSURE_RATE = "30"
$env:LB_PRESSURE_DURATION_SECONDS = "10"
$env:LB_PRESSURE_PRE_ALLOCATED_VUS = "20"
$env:LB_PRESSURE_MAX_VUS = "40"

k6 run ./k6/lb/07-rate-limit-and-connection-pressure.js
```

### 10.3 Output mẫu (PASS)

```text
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: ./k6/lb/07-rate-limit-and-connection-pressure.js
     output: -

  scenarios: (100.00%) 1 scenario, 40 max VUs, 40s max duration (incl. graceful stop):
           * pressure: 30.00 iterations/s for 10s (maxVUs: 40, gracefulStop: 30s)

  ✓ lb pressure status is 200 or 429
  ✓ lb pressure no cache header

  █ custom metrics

    ✓ lb_pressure_200 .............................: 105
    ✓ lb_pressure_429 .............................: 195
    ✓ lb_pressure_unexpected ......................: 0

  checks .........................................: 100.00% ✓ 300       ✗ 0
  http_req_failed ................................: 65.00%  ✓ 195       ✗ 105
  http_req_duration ..............................: avg=12ms   min=2ms  med=8ms   max=45ms  p90=20ms  p95=28ms
    ✓ {endpoint:lb_pressure_demo} ................: avg=12ms   min=2ms  med=8ms   max=45ms  p90=20ms  p95=28ms

  Result: PASS
  Exit code: 0
```

### 10.4 Đọc output

| Dòng | Ý nghĩa |
| --- | --- |
| `lb_pressure_200: 105` | 105 request được chấp nhận và forward đến origin thành công |
| `lb_pressure_429: 195` | 195 request bị Nginx từ chối bằng `429` -- expected behavior |
| `lb_pressure_unexpected: 0` | Không có status nào ngoài 200 và 429 -- quan trọng nhất |
| `checks: 100.00%` | Tất cả checks pass -- mọi response đều thỏa mãn điều kiện |
| `http_req_failed: 65.00%` | 65% request failed -- expected vì 195/300 = 65% là 429 |
| `http_req_duration: avg=12ms` | Response time thấp vì 429 được trả về ngay lập tức, không cần chờ origin |

---

## 11. 4 output -> decision scenarios

### Scenario 1: PASS hoàn hảo

```text
lb_pressure_200: 105     (35%)
lb_pressure_429: 195     (65%)
lb_pressure_unexpected: 0
checks rate: 1.0

→ Decision: ✓ Rate limit hoạt động đúng. Có thể tự tin triển khai lên production.
  Gateway đang bảo vệ origin đúng contract.
```

### Scenario 2: Rate limit quá nghiêm ngặt

```text
lb_pressure_200: 0       (0%)
lb_pressure_429: 300     (100%)
lb_pressure_unexpected: 0
checks rate: 1.0

→ Decision: ⚠ Rate limit đang chặn TẤT CẢ traffic. Cần điều chỉnh:
  1. Tăng `rate` trong `limit_req_zone` (vd: từ 10r/s lên 20r/s)
  2. Tăng `burst` (vd: từ 5 lên 10)
  3. Hoặc giảm `LB_PRESSURE_RATE` nếu đang test với áp lực không thực tế
  4. Chạy lại test sau khi điều chỉnh
```

### Scenario 3: Rate limit không hoạt động

```text
lb_pressure_200: 300     (100%)
lb_pressure_429: 0       (0%)
lb_pressure_unexpected: 0
checks rate: 1.0

→ Decision: ⚠ Rate limit KHÔNG hoạt động. Cần kiểm tra:
  1. `limit_req` có được cấu hình trong đúng `location` block không?
  2. Nginx đã được reload sau khi thay đổi config chưa? (`nginx -s reload`)
  3. Có đang test từ nhiều IP khác nhau không? (mỗi IP có bucket riêng)
  4. `LB_PRESSURE_RATE` có đủ cao để vượt ngưỡng không?
  5. Chạy lại test sau khi fix.
```

### Scenario 4: Có status bất thường (NGUY HIỂM)

```text
lb_pressure_200: 80      (27%)
lb_pressure_429: 190     (63%)
lb_pressure_unexpected: 30  (10%)  ← NGUY HIỂM
checks rate: 0.90

→ Decision: ✗ CÓ LỖI BẤT THƯỜNG. Cần điều tra khẩn cấp:
  1. Kiểm tra 30 request unexpected có status gì? (500, 502, 503, ...?)
  2. Nếu 502/503: origin có thể đang bị quá tải dù có rate limit
  3. Nếu 500: origin đang gặp lỗi internal
  4. Kiểm tra origin logs để xác định nguyên nhân
  5. Có thể cần giảm rate limit xuống thấp hơn nữa
  6. KHÔNG triển khai lên production cho đến khi `lb_pressure_unexpected == 0`
```

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "429 là lỗi" -- SAI

Đây là misconception phổ biến nhất với case này.

```text
Sai:   "429 Too Many Requests là lỗi server, cần fix"
Đúng:  "429 là response có chủ đích từ Gateway để bảo vệ origin. Nó là expected behavior."

Tương tự như:
  - 401 Unauthorized: không phải lỗi server, mà là "bạn cần đăng nhập"
  - 404 Not Found: không phải lỗi server, mà là "resource không tồn tại"
  - 429 Too Many Requests: không phải lỗi server, mà là "bạn đang gửi quá nhiều request, hãy chậm lại"
```

Trong ngữ cảnh của case này, `429` là **tín hiệu thành công** -- nó chứng minh Gateway đang làm đúng nhiệm vụ bảo vệ origin.

### 12.2 Nghịch lý 2: "http_req_failed cao là bug" -- SAI

```text
Sai:   "http_req_failed = 65% → hệ thống có vấn đề"
Đúng:  "http_req_failed = 65% là expected vì 65% response là 429.
        Chỉ đáng lo nếu lb_pressure_unexpected > 0."
```

k6 định nghĩa `http_req_failed = true` cho mọi status >= 400. Trong case này, `429 >= 400` nên tất cả request bị shed đều được tính là failed. Đây là hạn chế trong cách k6 phân loại, không phải vấn đề của hệ thống.

**Cách đọc đúng:** Đừng nhìn `http_req_failed` một mình. Luôn đọc cùng `lb_pressure_unexpected`.

### 12.3 Nghịch lý 3: "Rate limit càng nghiêm ngặt càng tốt" -- SAI

```text
Sai:   "rate=1r/s, burst=0 → an toàn nhất"
Đúng:  "Rate limit quá nghiêm ngặt → người dùng hợp lệ bị chặn → mất doanh thu"

Rate limit là bài toán cân bằng:
  - Quá lỏng: không bảo vệ được origin
  - Quá chặt: từ chối người dùng hợp lệ
  - Tối ưu: chặn đủ để bảo vệ origin, nhưng vẫn phục vụ được lượng traffic hợp lệ tối đa
```

### 12.4 Nghịch lý 4: "Chỉ cần rate limit, không cần connection limit" -- SAI

```text
Sai:   "limit_req là đủ, không cần limit_conn"
Đúng:  "Rate limit và connection limit bảo vệ hai thứ khác nhau"

Rate limit bảo vệ chống lại:
  - HTTP flood (nhiều request trên một connection)
  - Brute force attack

Connection limit bảo vệ chống lại:
  - Slowloris attack (mở nhiều connection, gửi request rất chậm)
  - Exhaustion file descriptors của Nginx
  - Một client độc chiếm toàn bộ connection pool
```

### 12.5 Nghịch lý 5: "Dùng constant-vus để test rate limit" -- SAI

```text
Sai:   "Dùng constant-vus với nhiều VUs để tạo áp lực"
Đúng:  "constant-vus không tạo được áp lực ổn định vì request rate phụ thuộc vào response time"

Với constant-vus:
  - Khi origin bắt đầu chậm → VUs đợi lâu hơn → request rate GIẢM
  - Kết quả: không thể test rate limit vì request rate không ổn định

Với constant-arrival-rate:
  - Request rate được giữ cố định bất kể response time
  - Nếu response time tăng, k6 tự động thêm VUs để duy trì rate
  - Kết quả: áp lực ổn định, lý tưởng để test rate limit
```

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=nginx"` | Có ít nhất 1 container Nginx | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn` |
| 2 | Không có Varnish/CDN | `docker ps --filter "name=varnish"` | Không có container nào | Dừng Varnish nếu đang chạy; dùng đúng `TargetLayer=full-no-cdn` |
| 3 | Public path hoạt động | `curl -sI http://localhost:80/api/lb/pressure-demo` | HTTP 200, có `X-Served-By: nginx` | Kiểm tra Nginx upstream config |
| 4 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại biến môi trường |
| 5 | `lb-stable-origin` đang chạy | `curl http://localhost:80/api/lb/pressure-demo` | HTTP 200, JSON response | Kiểm tra origin service |
| 6 | Nginx có rate limit config | Kiểm tra file `nginx.conf` | Có `limit_req_zone` và `limit_req` | Thêm cấu hình rate limit vào nginx.conf |
| 7 | Nginx đã reload config mới nhất | `docker exec <nginx-container> nginx -s reload` (nếu vừa sửa config) | Không có lỗi | Kiểm tra syntax: `nginx -t` |

### 13.2 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 8 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\lb\07-rate-limit-and-connection-pressure.js"` |
| 9 | `shared.js` tồn tại và đúng version | Import đúng path, không có lỗi syntax |
| 10 | `lbCapabilityApis.pressureDemo` trỏ đến đúng path | `/api/lb/pressure-demo` phải khớp với Nginx location config |
| 11 | `common.js` có hàm `envInt` | Import không bị lỗi |

### 13.3 k6 checklist

| # | Mục kiểm tra |
| --- | --- |
| 12 | k6 đã được cài đặt: `k6 version` |
| 13 | Không có biến môi trường nào conflict (`K6_*` env vars không set nhầm) |
| 14 | Terminal/CI có đủ timeout (script chạy ~10 giây + graceful stop) |
| 15 | Đã hiểu `429` là expected, không phải bug |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Tăng áp lực -- tìm điểm gãy

Mục tiêu: tìm ngưỡng mà tại đó `lb_pressure_unexpected > 0` (origin bắt đầu có dấu hiệu quá tải).

```javascript
// Variation 1: Pressure escalation
// Lưu thành file riêng hoặc sửa biến môi trường

// Chạy với rate tăng dần:
// Lần 1: LB_PRESSURE_RATE=50
// Lần 2: LB_PRESSURE_RATE=100
// Lần 3: LB_PRESSURE_RATE=200
// ... cho đến khi lb_pressure_unexpected > 0

// Thêm custom metric để theo dõi latency của request 200
import { Trend } from 'k6/metrics';

const pressure200Duration = new Trend('lb_pressure_200_duration');

export default function () {
  const api = lbCapabilityApis.pressureDemo;
  const res = requestLB(api, {
    headers: { Connection: 'close' },
    tags: { endpoint: api.name, lb_profile: 'full-no-cdn' },
  });

  check(res, {
    'lb pressure status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'lb pressure no cache header': (r) => !(r.headers['X-Cache'] || ''),
  });

  if (res.status === 200) {
    pressure200.add(1);
    pressure200Duration.add(res.timings.duration);  // Theo dõi latency
  } else if (res.status === 429) {
    pressure429.add(1);
  } else {
    pressureUnexpected.add(1);
  }
}

// Thêm threshold cho latency
export const options = {
  scenarios: {
    pressure: {
      executor: 'constant-arrival-rate',
      rate: __ENV.LB_PRESSURE_RATE ? parseInt(__ENV.LB_PRESSURE_RATE) : 30,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 20,
      maxVUs: __ENV.LB_PRESSURE_RATE ? parseInt(__ENV.LB_PRESSURE_RATE) : 40,
    },
  },
  thresholds: {
    'lb_pressure_200': ['count>0'],
    'lb_pressure_429': ['count>0'],
    'lb_pressure_unexpected': ['count==0'],
    'lb_pressure_200_duration': ['p95<100'],  // Request 200 phải nhanh
  },
};
```

**Điểm học:** Khi rate vượt quá khả năng của origin (dù có rate limit), `lb_pressure_unexpected` sẽ > 0. Đây là tín hiệu cần scale origin hoặc điều chỉnh rate limit.

### Variation 2: Test connection limit riêng biệt

Mục tiêu: cô lập connection limit khỏi rate limit để test riêng.

```javascript
// Variation 2: Connection pressure only
// Vô hiệu hóa rate limit (set rate rất cao), chỉ test connection limit

export const options = {
  scenarios: {
    connection_pressure: {
      executor: 'constant-arrival-rate',
      rate: 50,             // Rate cao
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 30,
      maxVUs: 60,
    },
  },
  thresholds: {
    'lb_pressure_200': ['count>0'],
    'lb_pressure_429': ['count>0'],      // 429 từ connection limit
    'lb_pressure_unexpected': ['count==0'],
  },
};

export default function () {
  const api = lbCapabilityApis.pressureDemo;

  // Gửi request nhưng KHÔNG đóng connection ngay
  // Giữ connection open để test connection limit
  const res = requestLB(api, {
    headers: {
      Connection: 'keep-alive',  // Giữ connection
    },
    tags: {
      endpoint: api.name,
      lb_profile: 'full-no-cdn',
      test: 'connection_pressure',
    },
  });

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
  });

  if (res.status === 200) {
    pressure200.add(1);
  } else if (res.status === 429) {
    pressure429.add(1);
    // Kiểm tra header để biết lý do 429
    const rateLimitReason = res.headers['X-LB-RateLimit'];
    check(res, {
      '429 due to connection limit': () => rateLimitReason === 'connection_exceeded',
    });
  } else {
    pressureUnexpected.add(1);
  }
}
```

**Điểm học:** Khi rate limit được nới lỏng nhưng connection limit vẫn giữ nguyên, `429` vẫn xuất hiện -- nhưng lý do là `connection_exceeded` thay vì `rate_exceeded`.

### Variation 3: Test với nhiều IP (phân tán client)

Mục tiêu: chứng minh rate limit là per-IP, không phải global.

```javascript
// Variation 3: Multi-IP pressure
// Mỗi VU dùng một IP giả lập khác nhau qua header

export default function () {
  const api = lbCapabilityApis.pressureDemo;
  const vuId = __VU;           // ID của VU hiện tại
  const iterId = __ITER;       // Iteration hiện tại

  const res = requestLB(api, {
    headers: {
      Connection: 'close',
      'X-Forwarded-For': `192.168.1.${vuId}`,  // Mỗi VU có IP riêng
    },
    tags: {
      endpoint: api.name,
      lb_profile: 'full-no-cdn',
      vu: String(vuId),
    },
  });

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
  });

  if (res.status === 200) {
    pressure200.add(1);
  } else if (res.status === 429) {
    pressure429.add(1);
  } else {
    pressureUnexpected.add(1);
  }
}
```

**Điểm học:** Khi nhiều IP cùng gửi request, mỗi IP có bucket riêng. Tổng request có thể vượt xa `rate * số_IP` mà không bị chặn. Đây là lý do rate limit nên dùng key phù hợp (IP, user ID, API key) tùy theo use case.

### Variation 4: Test burst behavior (có delay vs nodelay)

Mục tiêu: so sánh hành vi của `burst` với và không có `nodelay`.

```javascript
// Variation 4: Burst behavior comparison
// Yêu cầu: cấu hình Nginx với hai location khác nhau:
//   /api/lb/pressure-demo-burst-delay:    limit_req burst=5 (không có nodelay)
//   /api/lb/pressure-demo-burst-nodelay:  limit_req burst=5 nodelay

// Script này so sánh response time giữa hai chế độ burst

import { Trend } from 'k6/metrics';

const burstDelayDuration = new Trend('burst_delay_duration');
const burstNodelayDuration = new Trend('burst_nodelay_duration');

export const options = {
  vus: 1,
  iterations: 30,
};

export default function () {
  // Test burst với delay
  const resDelay = requestLB({
    name: 'pressure_burst_delay',
    method: 'GET',
    path: '/api/lb/pressure-demo-burst-delay',
  }, {
    headers: { Connection: 'close' },
    tags: { burst_mode: 'delay' },
  });

  if (resDelay.status === 200) {
    burstDelayDuration.add(resDelay.timings.duration);
  }

  // Test burst với nodelay
  const resNodelay = requestLB({
    name: 'pressure_burst_nodelay',
    method: 'GET',
    path: '/api/lb/pressure-demo-burst-nodelay',
  }, {
    headers: { Connection: 'close' },
    tags: { burst_mode: 'nodelay' },
  });

  if (resNodelay.status === 200) {
    burstNodelayDuration.add(resNodelay.timings.duration);
  }
}

// So sánh kết quả:
// burst_delay_duration p95 sẽ CAO hơn nhiều so với burst_nodelay_duration p95
// Vì không có nodelay, burst request bị delay (xếp hàng) trước khi xử lý
```

**Điểm học:** `nodelay` cho phép burst request được xử lý ngay lập tức, phù hợp cho API cần response nhanh. Không có `nodelay`, burst request bị xếp hàng và chịu delay -- phù hợp cho background job hoặc batch processing.

### Variation 5: Dry-run -- xác nhận rate limit có hoạt động không

Mục tiêu: smoke test nhanh để xác nhận rate limit đang được cấu hình.

```javascript
// Variation 5: Rate limit dry-run
// Script ngắn gọn, chạy trong 2 giây, chỉ để xác nhận rate limit hoạt động

export const options = {
  scenarios: {
    dry_run: {
      executor: 'constant-arrival-rate',
      rate: 50,            // Rate cao để chắc chắn vượt ngưỡng
      timeUnit: '1s',
      duration: '2s',      // Chỉ 2 giây
      preAllocatedVUs: 10,
      maxVUs: 20,
    },
  },
  thresholds: {
    'lb_pressure_429': ['count>0'],         // Chỉ cần có 429 là đủ
    'lb_pressure_unexpected': ['count==0'], // Không được có status lạ
  },
};

export default function () {
  const api = lbCapabilityApis.pressureDemo;
  const res = requestLB(api, {
    headers: { Connection: 'close' },
    tags: { endpoint: api.name, mode: 'dry_run' },
  });

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
  });

  if (res.status === 200) {
    pressure200.add(1);
  } else if (res.status === 429) {
    pressure429.add(1);
  } else {
    pressureUnexpected.add(1);
  }
}
```

**Điểm học:** Không cần chạy 10 giây với 300 request để biết rate limit có hoạt động không. 2 giây với rate cao là đủ để xác nhận.

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Dùng constant-vus thay vì constant-arrival-rate

```text
Sai:   executor: 'constant-vus', vus: 30, duration: '10s'
Đúng:  executor: 'constant-arrival-rate', rate: 30, timeUnit: '1s', duration: '10s'

Lý do:
  constant-vus: request rate = số VUs / response time.
  Nếu response time = 100ms → rate ≈ 300/s (vượt xa mong đợi)
  Nếu response time = 1s   → rate ≈ 30/s  (đúng)
  Nếu response time = 5s   → rate ≈ 6/s   (quá thấp)
  → Không kiểm soát được request rate

  constant-arrival-rate: request rate được giữ cố định.
  Không phụ thuộc vào response time.
  → Kiểm soát được chính xác áp lực
```

### 15.2 Anti-pattern 2: Hoảng khi thấy `http_req_failed` cao

```text
Sai:   "http_req_failed = 65% → test FAIL, cần fix hệ thống"
Đúng:  "http_req_failed = 65% → expected, vì 429 là một phần của contract"

Cách tránh:
  - Luôn đọc lb_pressure_unexpected cùng với http_req_failed
  - Nếu lb_pressure_unexpected == 0: http_req_failed cao là bình thường
  - Nếu lb_pressure_unexpected > 0: mới cần điều tra
```

### 15.3 Anti-pattern 3: Không set `maxVUs` đủ cao

```text
Sai:   preAllocatedVUs: 20, maxVUs: 25 (chỉ hơn 5)
Đúng:  preAllocatedVUs: 20, maxVUs: 40 (gấp đôi)

Lý do:
  constant-arrival-rate cần thêm VUs khi response time tăng.
  Nếu maxVUs quá thấp, k6 không thể duy trì target rate.
  Kết quả: request rate thực tế < target rate → áp lực không đủ → rate limit không kích hoạt.

Công thức ước lượng:
  maxVUs ≥ target_rate × p95_response_time
  Với rate=30/s, p95=1s → maxVUs ≥ 30
  Với rate=30/s, p95=2s → maxVUs ≥ 60
```

### 15.4 Anti-pattern 4: Dùng chung một IP cho tất cả VUs

```text
Sai:   Tất cả VUs từ cùng một IP (mặc định của k6)
Đúng:  Hiểu rằng rate limit là per-IP (với cấu hình $binary_remote_addr)

Hệ quả:
  - 30 VUs từ 1 IP: tất cả dùng chung 1 bucket → dễ bị rate limit
  - 30 VUs từ 30 IPs: mỗi IP có bucket riêng → khó bị rate limit hơn

Đây không hẳn là "sai" -- nó phụ thuộc vào điều bạn muốn test:
  - Test rate limit cho 1 user: dùng 1 IP
  - Test rate limit cho nhiều users: dùng nhiều IPs (qua X-Forwarded-For)
```

### 15.5 Anti-pattern 5: Bỏ qua `lb_pressure_unexpected`

```text
Sai:   Chỉ nhìn lb_pressure_200 và lb_pressure_429, bỏ qua unexpected
Đúng:  lb_pressure_unexpected là metric QUAN TRỌNG NHẤT

Lý do:
  Một test có thể có 200 và 429 hợp lý, nhưng VẪN thất bại nếu có 500, 502, 503.
  lb_pressure_unexpected là "canary trong mỏ than" -- nó cảnh báo sớm về vấn đề.
```

### 15.6 Anti-pattern 6: Chạy qua CDN/Varnish

```text
Sai:   TargetLayer=full (có Varnish) → Varnish cache response → không thấy rate limit
Đúng:  TargetLayer=full-no-cdn (không có Varnish) → request đến thẳng Nginx

Lý do:
  Nếu có Varnish phía trước:
  - Varnish cache response 200 đầu tiên
  - Request sau được Varnish trả về từ cache (HIT) → không đến Nginx
  - Rate limit không bao giờ được kích hoạt
  → Test vô nghĩa
```

---

## 16. Real validation data

### 16.1 Kết quả validation thực tế

Dưới đây là kết quả từ lần chạy validation thực tế với cấu hình mặc định:

```text
K6 run configuration:
  Script:    07-rate-limit-and-connection-pressure.js
  Profile:   full-no-cdn
  BASE_URL:  http://localhost:80
  PRESSURE_RATE: 30
  PRESSURE_DURATION_SECONDS: 10
  PRESSURE_PRE_ALLOCATED_VUS: 20
  PRESSURE_MAX_VUS: 40

Results:
  Exit code: 0
  Checks: 600/600 individual run; 602/602 tuned full profile
  HTTP failed: ~65% expected 429s
  lb_pressure_200: ~105
  lb_pressure_429: ~195
  lb_pressure_unexpected: 0
  Result: PASS
```

### 16.2 Phân tích kết quả

| Chỉ số | Giá trị | Đánh giá |
| --- | --- | --- |
| `lb_pressure_200` | ~105 (35%) | Tốt -- khoảng 1/3 request được phục vụ |
| `lb_pressure_429` | ~195 (65%) | Tốt -- rate limit đang hoạt động, shed ~2/3 request |
| `lb_pressure_unexpected` | 0 | Tuyệt vời -- không có status ngoài contract |
| Tỉ lệ 200:429 | ~35:65 | Hợp lý với cấu hình `rate=10r/s burst=5` và áp lực 30r/s |
| `http_req_failed` | ~65% | Expected -- 429 >= 400 nên được tính là failed |
| Exit code | 0 | Tất cả thresholds pass |

### 16.3 Diễn giải tỉ lệ 200:429

Với cấu hình Nginx `rate=10r/s burst=5 nodelay` và áp lực 30 request/s:

```text
Lý thuyết:
  Burst bucket: 6 tokens ban đầu (burst + 1)
  Sau khi dùng hết burst, token được nạp với tốc độ 10/giây
  Trong 10 giây: 6 + 9×10 = 96 tokens → ~96 request được chấp nhận
  Còn lại: 300 - 96 = 204 request bị từ chối
  Tỉ lệ expected: 32% accepted, 68% shed

Thực tế:
  lb_pressure_200: ~105 → 35% (cao hơn lý thuyết một chút do timing)
  lb_pressure_429: ~195 → 65%
  → Khớp với dự đoán lý thuyết
```

### 16.4 Các yếu tố ảnh hưởng đến kết quả

| Yếu tố | Ảnh hưởng |
| --- | --- |
| Network latency giữa k6 và Nginx | Tăng response time → cần thêm VUs để duy trì rate |
| `Connection: close` | Mỗi request tạo connection mới → tăng áp lực connection |
| `limit_conn 4` | Giới hạn 4 connections đồng thời/IP → có thể giảm số request thực tế |
| Token bucket timing | Token được nạp liên tục, không phải mỗi giây một lần → phân phối mịn hơn |
| k6 graceful stop | Một số request ở cuối scenario có thể không được tính |

---

## 17. Reference

### 17.1 Tài liệu liên quan

| Tài liệu | Đường dẫn | Mô tả |
| --- | --- | --- |
| Overview | `E:\Khoa hoc\k6\docs\practice\lb\00_overview.md` | Tổng quan series LB/Gateway, mental model, case inventory |
| Run guide | `E:\Khoa hoc\k6\docs\practice\lb\RUN_GUIDE.md` | Hướng dẫn chạy toàn bộ LB suite |
| Validation | `E:\Khoa hoc\k6\docs\practice\lb\13_validation-and-chart-analysis.md` | Hướng dẫn đọc chart và validate kết quả |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\case-catalog.json` | Catalog đầy đủ 12 LB cases với business case, topology, expected signals |
| Script nguồn | `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\07-rate-limit-and-connection-pressure.js` | Mã nguồn k6 script của case này |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\shared.js` | Shared module cho toàn bộ LB cases |
| Nginx config | `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Cấu hình Nginx với `limit_req_zone`, `limit_req`, `limit_conn` |

### 17.2 Tài liệu tham khảo ngoài

| Tài liệu | URL | Mô tả |
| --- | --- | --- |
| Nginx rate limiting | `https://nginx.org/en/docs/http/ngx_http_limit_req_module.html` | Tài liệu chính thức về `limit_req` module |
| Nginx connection limiting | `https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html` | Tài liệu chính thức về `limit_conn` module |
| k6 constant-arrival-rate | `https://k6.io/docs/using-k6/scenarios/executors/constant-arrival-rate/` | Tài liệu k6 về open model executor |
| k6 Counter metric | `https://k6.io/docs/javascript-api/k6-metrics/counter/` | Tài liệu k6 về custom Counter metric |
| RFC 6585 (429 status) | `https://datatracker.ietf.org/doc/html/rfc6585#section-4` | RFC định nghĩa `429 Too Many Requests` |

### 17.3 Các case liên quan trong cùng series

| Case | Mối liên hệ |
| --- | --- |
| `lb-01-entry-smoke` | Case cơ bản nhất -- xác nhận Nginx hoạt động trước khi test pressure |
| `lb-06-retry-failover` | Failover đúng giúp origin không bị lỗi khi đang bị pressure |
| `lb-10-weighted-fairness-under-load` | Cũng dùng `constant-arrival-rate`, test canary share dưới áp lực |
| `lb-11-saturation-isolation` | Cũng dùng `constant-arrival-rate`, test phân cách fast/slow lane |
| `lb-12-slow-origin-timeouts` | Cũng dùng `constant-arrival-rate`, test timeout policy |

---

*Phiên bản tài liệu: 1.0 -- Ngày cập nhật: 2026-06-23*
