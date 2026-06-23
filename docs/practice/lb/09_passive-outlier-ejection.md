# Case 09: Passive Outlier Ejection

> **Case ID:** `lb-09-passive-outlier-ejection`
> **Script:** `09-passive-outlier-ejection.js`
> **Profile:** `full-no-cdn`
> **Proof:** Nginx tự động tránh backend flaky sau khi phát hiện failure signal -- request tiếp theo đi thẳng healthy upstream

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

Một hệ thống thương mại điện tử vận hành nhiều upstream backend phía sau Nginx. Trong số các backend này, có những instance hoạt động không ổn định: lúc trả về `200 OK`, lúc trả về `503 Service Unavailable`, lúc treo connection không phản hồi. Đây là tình trạng thường gặp trong thực tế vận hành:

| Nguyên nhân backend flaky | Biểu hiện | Tần suất gặp trong production |
| --- | --- | --- |
| Memory pressure / GC pause dài | Backend trả 503 trong lúc GC, hồi phục sau vài giây | Trung bình -- 2-3 lần/tuần |
| Connection pool cạn kiệt | Backend từ chối connection mới, trả 503 | Cao -- mỗi ngày vào giờ cao điểm |
| Deploy rolling không graceful | Instance cũ bị kill giữa chừng, request đang xử lý bị drop | Thấp nhưng nghiêm trọng khi xảy ra |
| Deadlock tạm thời trong app | Thread bị treo, health check chưa kịp đánh dấu unhealthy | Hiếm -- vài lần/tháng |
| Network blip giữa LB và backend | Packet loss tạm thời, connection timeout | Trung bình -- môi trường cloud shared network |

Nếu Nginx không có cơ chế tự động phát hiện và tránh các backend flaky này, mỗi request đến backend lỗi sẽ:

- Người dùng nhận được `503 Service Unavailable` -- trải nghiệm tệ nhất có thể
- Request thất bại có thể không được retry (nếu không có retry policy)
- Backend lỗi vẫn tiếp tục nhận traffic, làm trầm trọng thêm tình trạng quá tải
- MTTR (Mean Time To Recovery) kéo dài vì ops team phải can thiệp thủ công

### 1.2 Passive health check là gì

Passive health check (còn gọi là passive outlier ejection, passive health monitoring) là cơ chế Nginx **quan sát response thực tế** từ upstream backend để quyết định backend đó có "khỏe" hay không. Khác với active health check (Nginx chủ động gửi probe request định kỳ), passive health check hoạt động dựa trên chính traffic thật đi qua LB:

```text
Active health check:  Nginx → gửi probe riêng → "anh có khỏe không?"
                      Tốn thêm request, nhưng phát hiện lỗi sớm.

Passive health check: Nginx → xem response của request thật → "request vừa rồi 
                      thất bại, vậy backend này có vấn đề"
                      Không tốn thêm request, nhưng chỉ phát hiện lỗi khi có 
                      traffic thật đi qua.
```

Case 09 tập trung vào **passive health check** vì đây là cơ chế hoạt động âm thầm, không cần cấu hình probe riêng, và phản ánh chính xác trải nghiệm thực tế của người dùng.

### 1.3 Kịch bản cụ thể trong case này

Một backend trong upstream pool (`lb-ejection-backend`) được thiết kế để hoạt động flaky có chủ đích:

```text
Backend ejection hoạt động như sau:
  - Bucket "b": backend cố ý trả 503 cho request đầu tiên, sau đó hồi phục
  - Các bucket khác: backend hoạt động bình thường (200)

Kịch bản test:
  1. Gửi request với header X-LB-Ejection-Bucket: b
  2. Backend trả 503 (lỗi)
  3. Nginx ghi nhận failure → passive ejection
  4. Nginx retry sang instance khác của cùng upstream (hoặc fallback)
  5. Request hoàn thành với 200
  6. Các request tiếp theo: Nginx tránh backend vừa bị ejection, đi thẳng healthy
```

Điểm quan trọng: **người dùng cuối chỉ thấy 200**, dù backend thật đã trả 503 ở tầng upstream. Đây chính là giá trị của passive outlier ejection.

---

## 2. LB capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh Nginx passive health behavior:

> **Nginx phát hiện backend flaky thông qua failure signal trong response, đánh dấu backend đó là "không khỏe" trong khoảng `fail_timeout`, và chuyển hướng request sang backend healthy. Người dùng cuối không thấy lỗi.**

Cụ thể hơn, ba khả năng được chứng minh:

| Khả năng | Mô tả | Evidence trong case |
| --- | --- | --- |
| Phát hiện lỗi thụ động | Nginx nhận ra backend trả 503 từ request thật | `X-LB-Upstream-Status` chứa `503` |
| Retry/fallback tự động | Nginx thử lại request sang backend khác mà không để client thấy lỗi | Response cuối cùng là 200, `role: stable` |
| Duy trì ejection state | Trong khoảng `fail_timeout`, Nginx không gửi request đến backend bị đánh dấu lỗi | Các follow-up request đều có `X-LB-Upstream-Status: 200` |

### 2.2 Sơ đồ hành vi

```text
Trước ejection:
  k6 → Nginx → [backend-flaky (bucket b)] → 503 → k6 nhận 503 (KHÔNG CÓ ejection)

Trong ejection (sau khi Nginx ghi nhận failure):
  k6 → Nginx → [backend-flaky: FAIL] → Nginx chọn backend khác → 200
              → [backend-healthy] → 200 → k6 nhận 200

Sau fail_timeout:
  k6 → Nginx → [backend-flaky: hết timeout, thử lại] → có thể 503 hoặc 200
```

### 2.3 Tại sao capability này quan trọng

Nếu không có passive outlier ejection:

```text
Không có ejection:   Backend lỗi → mọi request đến nó → 503 → user thấy lỗi
Có ejection:          Backend lỗi → request đầu lỗi, Nginx ghi nhận → request sau 
                      tránh backend lỗi → 200 → user không thấy lỗi
```

Khác biệt là ranh giới giữa "site down một phần" và "site vẫn hoạt động bình thường với một backend đang được sửa chữa ngầm".

---

## 3. Vì sao phải test ở LB layer

### 3.1 LB là điểm quyết định routing

```text
Người dùng → Nginx (LB) → upstream backend 1 (flaky)
                        → upstream backend 2 (healthy)
                        → upstream backend 3 (healthy)
              ↑
         Điểm quyết định: gửi request đến backend nào?
```

Passive outlier ejection là logic nằm **trong Nginx**, không phải trong app. Nếu test ở tầng app, bạn không thể kiểm chứng được:

- Nginx có thực sự detect được failure không?
- Nginx có chuyển hướng request sang backend khác không?
- `fail_timeout` có được tôn trọng không?
- Header signal (`X-LB-Health-Mode`, `X-LB-Upstream-Status`) có được gắn đúng không?

### 3.2 Passive health check là invisible mechanism

Khác với active health check (có thể thấy probe request trong access log), passive health check hoàn toàn **vô hình** với người quan sát bên ngoài. Không có request riêng, không có log đặc biệt (trừ khi cấu hình debug log). Cách duy nhất để biết ejection đang hoạt động là:

1. Gửi request đến backend lỗi
2. Quan sát response header (`X-LB-Health-Mode`, `X-LB-Upstream-Status`)
3. Gửi request tiếp theo và xác nhận chúng đi backend healthy

Đây chính là những gì case 09 làm.

### 3.3 Phân biệt với retry/failover (case 06)

| Khía cạnh | Case 06 (Retry/Failover) | Case 09 (Passive Ejection) |
| --- | --- | --- |
| Cơ chế | Retry khi upstream trả lỗi | Đánh dấu upstream là không khỏe, tránh trong fail_timeout |
| Phạm vi thời gian | Mỗi request riêng lẻ | Trạng thái tồn tại trong fail_timeout window |
| Header chính | `X-LB-Failover=faulty->stable` | `X-LB-Health-Mode=passive-ejection` |
| Mục đích | Khắc phục lỗi cho request hiện tại | Ngăn lỗi cho các request tương lai |

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌─────────────────────────┐
                          │    k6 test script        │
                          │  (09-passive-outlier-    │
                          │   ejection.js)           │
                          └────────────┬─────────────┘
                                       │
                          public path  │ GET /api/lb/ejection-demo
                                       │ X-LB-Ejection-Bucket: b
                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx LB/Gateway)                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Nginx upstream: lb-ejection-backend                      │  │
│  │  ┌──────────────────────┐  ┌──────────────────────────┐   │  │
│  │  │ server ejection:808x │  │ server ejection:808x     │   │  │
│  │  │ (flaky -- bucket b   │  │ (healthy -- các bucket   │   │  │
│  │  │  trả 503)            │  │  khác trả 200)           │   │  │
│  │  └──────────────────────┘  └──────────────────────────┘   │  │
│  │                                                             │  │
│  │  Passive health config:                                     │  │
│  │    max_fails=1                                              │  │
│  │    fail_timeout=10s (hoặc giá trị đã cấu hình)              │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `full-no-cdn` (bắt buộc) | Không có `X-Cache` trong response |
| `BASE_URL` | `http://localhost:80` | `curl -sI http://localhost:80/` thấy `Server: nginx` |
| Nginx config | Upstream `lb-ejection-backend` với `max_fails` và `fail_timeout` | Kiểm tra trong `nginx.conf` |
| Backend ejection | Phải có ít nhất 2 instance (1 flaky, 1 healthy) | Gọi API với bucket khác nhau để xác minh |

### 4.3 Stack khởi động

```powershell
# Khởi động full-no-cdn stack
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
```

Đợi tất cả service healthy (khoảng 30-60 giây). Kiểm tra:

```powershell
# Xác nhận Nginx đang chạy
curl -sI http://localhost:80/ | findstr "Server:"

# Xác nhận upstream ejection hoạt động
curl -s http://localhost:80/api/lb/ejection-demo -H "X-LB-Ejection-Bucket: a"
```

### 4.4 Precondition đặc biệt: fail_timeout window

Điểm đặc biệt của case 09 là **timing**:

```text
Kịch bản lý tưởng:
  1. sleep(RESET_WAIT_SECONDS) -- đợi fail_timeout cũ hết hạn
  2. Request đầu tiên: backend trả 503 → Nginx ejection → retry → 200
  3. Các request sau: đi thẳng healthy backend (vẫn trong fail_timeout)

Nếu không có sleep đầu tiên:
  - Nếu case trước đó (hoặc lần chạy trước) đã ejection backend
  - fail_timeout vẫn còn hiệu lực
  - Request đầu tiên đã đi thẳng healthy → không thấy được 503
  → Test không chứng minh được ejection behavior
```

`RESET_WAIT_SECONDS = 5` (có thể ghi đè qua `$env:LB_EJECTION_RESET_WAIT_SECONDS`) là khoảng thời gian chờ để đảm bảo mọi ejection state từ lần chạy trước đã hết hạn.

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\lb\09-passive-outlier-ejection.js
```

### 5.2 Import và dependency

```javascript
import { check, sleep } from 'k6';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbCapabilityApis, requestLB, responseHeader } from './shared.js';
```

| Import | Nguồn | Vai trò |
| --- | --- | --- |
| `check`, `sleep` | `k6` | Hàm built-in: kiểm tra assertion và tạm dừng VU |
| `envInt` | `../shared/common.js` | Đọc biến môi trường kiểu integer với fallback |
| `assertLBResponse` | `./shared.js` | Kiểm tra status, upstream service, request ID, cache header |
| `lbCapabilityApis` | `./shared.js` | Object chứa định nghĩa các API endpoint cho LB tests |
| `requestLB` | `./shared.js` | Gửi HTTP request qua LB (:80) |
| `responseHeader` | `./shared.js` | Đọc case-insensitive header từ response |

### 5.3 Biến môi trường

```javascript
const RESET_WAIT_SECONDS = envInt('LB_EJECTION_RESET_WAIT_SECONDS', 5);
const SAMPLE_REQUESTS = envInt('LB_EJECTION_SAMPLE_REQUESTS', 6);
```

| Biến | Mặc định | Ý nghĩa | Ghi đè |
| --- | --- | --- | --- |
| `LB_EJECTION_RESET_WAIT_SECONDS` | `5` | Số giây chờ để fail_timeout cũ hết hạn trước khi test | `$env:LB_EJECTION_RESET_WAIT_SECONDS = "10"` |
| `LB_EJECTION_SAMPLE_REQUESTS` | `6` | Số request follow-up sau request đầu tiên để xác nhận ejection duy trì | `$env:LB_EJECTION_SAMPLE_REQUESTS = "10"` |

### 5.4 options block

```javascript
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
  tags: {
    scenario: 'lb_passive_outlier_ejection',
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};
```

**Phân tích từng trường:**

**`vus: 1, iterations: 1`**: Đây là correctness test tuần tự. Chỉ có 1 VU, chạy đúng 1 lần, thực hiện tuần tự: đợi reset -> request đầu -> N request follow-up. Không có concurrency vì ejection state là shared state trong Nginx -- nhiều VU cùng chạy sẽ làm nhiễu kết quả.

**`checks: ['rate==1']`**: Mọi check phải pass 100%. Trong case này có: check cho request đầu (health-mode, upstream status, role), N check cho request follow-up (upstream status 200, role stable), và N+1 check từ `assertLBResponse`. Nếu bất kỳ check nào fail, case fail.

**`http_req_failed: ['rate==0']`**: Tất cả request đều phải thành công từ góc nhìn HTTP. Mặc dù upstream có thể trả 503, nhưng Nginx retry/fallback khiến response cuối cùng đến client là 200.

**`tags`**: `scenario: 'lb_passive_outlier_ejection'` để phân biệt trên dashboard/cloud. `target_layer: 'lb'` và `lb_profile: 'full-no-cdn'` để lọc theo topology.

### 5.5 Helper function: `hasRetriedUpstream(statusHeader)`

```javascript
function hasRetriedUpstream(statusHeader) {
  return statusHeader.includes('503') && statusHeader.includes('200');
}
```

Hàm này kiểm tra `X-LB-Upstream-Status` header có chứa **cả** `503` và `200` không. Đây là bằng chứng cho thấy:

1. Nginx đã thử gửi request đến upstream backend đầu tiên -> nhận `503`
2. Nginx retry sang upstream backend thứ hai -> nhận `200`
3. Response cuối cùng trả về client là `200`

Nếu `X-LB-Upstream-Status` chỉ có `200` -> request đi thẳng healthy backend, không có ejection.
Nếu `X-LB-Upstream-Status` chỉ có `503` -> Nginx không retry, client nhận lỗi.

### 5.6 `default()` -- logic chính

```javascript
export default function () {
  const api = lbCapabilityApis.ejectionDemo;

  // Đợi fail_timeout cũ hết hạn
  sleep(RESET_WAIT_SECONDS);

  // REQUEST ĐẦU TIÊN -- kích hoạt ejection
  const first = requestLB(api, {
    headers: {
      'X-LB-Ejection-Bucket': 'b',
    },
    tags: {
      endpoint: api.name,
      sample: 'first',
    },
  });
  assertLBResponse(first, api, 'lb passive ejection first');

  const firstStatus = responseHeader(first, 'X-LB-Upstream-Status');
  check(first, {
    'lb passive ejection health mode present': (r) =>
      responseHeader(r, 'X-LB-Health-Mode') === 'passive-ejection',
    'lb passive ejection first request retried from unhealthy origin': () =>
      hasRetriedUpstream(firstStatus),
    'lb passive ejection first response is stable': (r) =>
      r.json('role') === 'stable',
  });

  // FOLLOW-UP REQUESTS -- xác nhận ejection duy trì
  for (let i = 1; i < SAMPLE_REQUESTS; i += 1) {
    const res = requestLB(api, {
      headers: {
        'X-LB-Ejection-Bucket': 'b',
      },
      tags: {
        endpoint: api.name,
        sample: `followup_${i}`,
      },
    });
    assertLBResponse(res, api, `lb passive ejection followup ${i}`);
    const status = responseHeader(res, 'X-LB-Upstream-Status');
    check(res, {
      [`lb passive ejection followup ${i} stayed on healthy upstream`]: () =>
        status.trim() === '200',
      [`lb passive ejection followup ${i} role stable`]: (r) =>
        r.json('role') === 'stable',
    });
    sleep(0.1);
  }
}
```

**Phân tích chi tiết từng bước:**

#### Bước 1: `sleep(RESET_WAIT_SECONDS)` -- đặt lại trạng thái

```text
Mục đích: Đảm bảo fail_timeout từ lần chạy trước đã hết hạn.
Cơ chế: Nginx lưu ejection state với TTL = fail_timeout.
        Sau khi TTL hết, backend được "thả" -- request tiếp theo sẽ 
        thử gửi đến nó một lần nữa.
        
Nếu không sleep: request đầu tiên có thể đã thấy backend healthy 
                 (vì ejection cũ hết hạn) hoặc vẫn bị ejection 
                 (vì ejection cũ còn hiệu lực). Cả hai đều làm hỏng test.
```

#### Bước 2: Request đầu tiên -- kích hoạt ejection

```text
Headers gửi đi: X-LB-Ejection-Bucket: b
                → Backend nhận được header này và biết phải trả 503

Diễn biến trong Nginx:
  1. Nginx chọn upstream server (có thể là flaky instance)
  2. Gửi request đến upstream → nhận 503
  3. Passive health check: ghi nhận 1 failure → đạt max_fails=1
  4. Đánh dấu server này là DOWN trong fail_timeout window
  5. Retry request sang server khác trong upstream group
  6. Server thứ hai trả 200
  7. Trả 200 về client với header X-LB-Upstream-Status: 503, 200

Ba check được thực hiện:
  a. X-LB-Health-Mode === 'passive-ejection'
     → Xác nhận Nginx đã kích hoạt passive ejection
  
  b. X-LB-Upstream-Status chứa cả 503 và 200
     → Xác nhận request đã qua retry: lỗi → thành công
  
  c. Response body role === 'stable'
     → Xác nhận request cuối cùng đến stable backend
```

#### Bước 3: Follow-up requests -- xác nhận ejection duy trì

```text
Vòng lặp: i = 1 đến SAMPLE_REQUESTS - 1 (mặc định: 5 request)

Mỗi request:
  - Vẫn gửi X-LB-Ejection-Bucket: b (cùng bucket lỗi)
  - Nginx đã ejection backend lỗi → chọn thẳng backend healthy
  - X-LB-Upstream-Status: 200 (chỉ một lần thử, không cần retry)
  - Role: stable

Hai check mỗi request:
  a. status.trim() === '200'
     → Chỉ có 200, không có 503 → chứng minh backend lỗi đã bị tránh
  
  b. role === 'stable'
     → Response đến từ stable backend

sleep(0.1) giữa các request:
  - Không cần thiết cho ejection logic
  - Chỉ để giảm tốc độ request, giúp log dễ đọc
  - Có thể tăng nếu muốn test thêm timing behavior
```

### 5.7 API endpoint được sử dụng

Từ `shared.js`:

```javascript
ejectionDemo: {
  name: 'lb_ejection_demo',
  method: 'GET',
  path: '/api/lb/ejection-demo',
  expected: 200,
  expectedUpstream: 'lb-ejection-backend',
},
```

| Trường | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `name` | `lb_ejection_demo` | Tag dùng trong metrics và checks |
| `method` | `GET` | HTTP method |
| `path` | `/api/lb/ejection-demo` | URL path |
| `expected` | `200` | Status code kỳ vọng sau khi retry/fallback |
| `expectedUpstream` | `lb-ejection-backend` | Upstream group mà Nginx route đến |

### 5.8 `assertLBResponse` -- những gì được kiểm tra

Hàm `assertLBResponse` từ `shared.js` thực hiện các check sau cho mỗi response:

```javascript
check(res, {
  [`${prefix} status`]: (r) => r.status === api.expected,
  [`${prefix} served by nginx`]: (r) => {
    const explicit = headerValue(r, 'X-Served-By');
    const server = headerValue(r, 'Server');
    return explicit === 'nginx' || server.toLowerCase().startsWith('nginx/');
  },
  [`${prefix} upstream matches`]: (r) =>
    headerValue(r, 'X-Upstream-Service') === api.expectedUpstream,
  [`${prefix} request id present`]: (r) => !!headerValue(r, 'X-Request-ID'),
  [`${prefix} no cache header`]: (r) => !headerValue(r, 'X-Cache'),
});
```

| Check | Ý nghĩa | Tại sao quan trọng |
| --- | --- | --- |
| Status = 200 | Client không thấy lỗi | Đây là mục tiêu cuối cùng của ejection |
| Served by nginx | Request đã qua LB layer | Xác nhận không bypass Nginx |
| Upstream matches | Route đến đúng upstream group | `lb-ejection-backend` |
| Request ID present | Nginx gắn trace ID | Cho phép theo dõi request trong log |
| No cache header | Không có CDN cache | Xác nhận chạy đúng profile `full-no-cdn` |

### 5.9 Sơ đồ tổ chức toàn bộ script

```text
┌─ options: vus=1, iterations=1, thresholds checks rate==1, http_req_failed rate==0
│
├─ hasRetriedUpstream(statusHeader) ← local helper
│   └─ return statusHeader.includes('503') && statusHeader.includes('200')
│
└─ default()
    ├─ sleep(RESET_WAIT_SECONDS)  // Đợi fail_timeout cũ hết hạn
    │
    ├─ REQUEST ĐẦU: GET /api/lb/ejection-demo [bucket=b]
    │   ├─ assertLBResponse: status, nginx, upstream, request-id, no-cache
    │   ├─ check: X-LB-Health-Mode === 'passive-ejection'
    │   ├─ check: X-LB-Upstream-Status chứa cả 503 và 200
    │   └─ check: response.role === 'stable'
    │
    └─ LOOP (i=1 đến SAMPLE_REQUESTS-1):
        ├─ GET /api/lb/ejection-demo [bucket=b]
        │   ├─ assertLBResponse (như trên)
        │   ├─ check: X-LB-Upstream-Status === '200' (chỉ 200)
        │   └─ check: response.role === 'stable'
        └─ sleep(0.1)
```

---

## 6. Nginx/LB mechanism deep-dive

### 6.1 Cấu hình passive health check trong Nginx

Passive health check được cấu hình trong `upstream` block thông qua các directive `max_fails` và `fail_timeout`:

```nginx
upstream lb-ejection-backend {
    server backend1:8081 max_fails=1 fail_timeout=10s;
    server backend2:8081 max_fails=1 fail_timeout=10s;
}
```

| Directive | Ý nghĩa | Giá trị trong case |
| --- | --- | --- |
| `max_fails` | Số lần thất bại tối đa trước khi đánh dấu server là DOWN | `1` (chỉ cần 1 lần thất bại) |
| `fail_timeout` | Thời gian server bị đánh dấu DOWN trước khi được thử lại | `10s` (10 giây) |

**Với `max_fails=1`:**
- Chỉ 1 request thất bại đến backend là đủ để kích hoạt ejection
- Phù hợp cho demo/test: thể hiện rõ ejection behavior ngay
- Trong production: thường dùng `max_fails=2` hoặc `3` để tránh false positive (network blip)

**Với `fail_timeout=10s`:**
- Backend bị đánh dấu DOWN trong 10 giây
- Sau 10 giây, Nginx "thả" backend ra và thử gửi 1 request
- Case này dùng `RESET_WAIT_SECONDS=5` để đợi fail_timeout từ lần chạy trước (giả định fail_timeout < 5s)

### 6.2 `proxy_next_upstream` -- điều kiện retry

Để Nginx retry sang upstream khác khi nhận lỗi, cần directive `proxy_next_upstream`:

```nginx
location /api/lb/ejection-demo {
    proxy_pass http://lb-ejection-backend;
    proxy_next_upstream error timeout http_503 http_502 http_504;
    proxy_next_upstream_tries 2;
}
```

| Directive | Ý nghĩa |
| --- | --- |
| `proxy_next_upstream` | Những điều kiện nào kích hoạt retry sang server khác |
| `error` | Connection error (connection refused, timeout khi connect) |
| `timeout` | Read timeout (backend không phản hồi kịp) |
| `http_503` | Backend trả HTTP 503 |
| `http_502` | Backend trả HTTP 502 (Bad Gateway) |
| `http_504` | Backend trả HTTP 504 (Gateway Timeout) |
| `proxy_next_upstream_tries` | Số lần thử tối đa (bao gồm lần đầu) |

**Trong case này:** Backend trả `503` -> match điều kiện `http_503` -> Nginx retry sang server khác -> server thứ hai trả `200` -> client nhận `200`.

### 6.3 Cơ chế passive health check -- chi tiết từng bước

```text
BƯỚC 1: Nhận request từ client
  Client → Nginx: GET /api/lb/ejection-demo
  Nginx chọn upstream server theo thuật toán (mặc định: round-robin)

BƯỚC 2: Gửi request đến upstream
  Nginx → backend1:8081: GET /api/lb/ejection-demo
  backend1 → Nginx: 503 Service Unavailable

BƯỚC 3: Passive health check -- ghi nhận failure
  Nginx kiểm tra: response status có nằm trong 
  proxy_next_upstream không? 503 ∈ {error, timeout, http_503, ...} → CÓ
  → Tăng failure counter cho backend1 lên 1
  → failure counter (1) >= max_fails (1) → ĐÁNH DẤU backend1 là DOWN
  → Bắt đầu fail_timeout timer (10s)

BƯỚC 4: Retry sang upstream khác
  Nginx chọn upstream server tiếp theo (round-robin) → backend2
  Nginx → backend2:8081: GET /api/lb/ejection-demo
  backend2 → Nginx: 200 OK { role: "stable" }

BƯỚC 5: Trả response cho client
  Nginx → Client: 200 OK
  Headers:
    X-LB-Upstream-Status: 503, 200
    X-LB-Health-Mode: passive-ejection
    X-Upstream-Service: lb-ejection-backend
    X-Served-By: nginx

BƯỚC 6: Trong 10 giây tiếp theo (fail_timeout)
  Mọi request đến /api/lb/ejection-demo:
  → Nginx bỏ qua backend1 (đang DOWN)
  → Chọn thẳng backend2
  → X-LB-Upstream-Status: 200 (chỉ 1 lần thử)

BƯỚC 7: Sau 10 giây (fail_timeout hết hạn)
  backend1 được "thả" -- trở lại pool
  Request tiếp theo có thể lại đến backend1
  Nếu backend1 vẫn lỗi → ejection lần nữa
  Nếu backend1 đã hồi phục → hoạt động bình thường
```

### 6.4 `X-LB-Upstream-Status` -- header quan trọng nhất

Header này ghi lại toàn bộ quá trình retry của Nginx:

```text
Định dạng: <status_lần_1>, <status_lần_2>, ...
Ví dụ: "503, 200" → lần 1 thất bại (503), lần 2 thành công (200)
       "200" → thành công ngay lần đầu, không cần retry
       "503, 503, 200" → 2 lần thất bại, lần 3 thành công
```

**Trong case 09:**
- Request đầu tiên: `X-LB-Upstream-Status: 503, 200` (có retry)
- Request follow-up: `X-LB-Upstream-Status: 200` (không cần retry vì backend lỗi đã bị ejection)

### 6.5 `X-LB-Health-Mode` -- header xác nhận ejection

```text
X-LB-Health-Mode: passive-ejection
```

Header này được Nginx (hoặc lớp middleware) gắn vào để báo hiệu rằng passive health check đã kích hoạt ejection cho request này. Nó là bằng chứng rõ ràng nhất rằng ejection đang hoạt động.

### 6.6 Phân biệt `fail_timeout` và `proxy_read_timeout`

| Directive | Ý nghĩa | Đơn vị | Ví dụ |
| --- | --- | --- | --- |
| `fail_timeout` | Thời gian server bị đánh dấu DOWN sau khi đạt `max_fails` | Giây | `fail_timeout=10s` |
| `proxy_read_timeout` | Thời gian Nginx đợi response từ upstream trước khi timeout | Giây hoặc ms | `proxy_read_timeout=150ms` |

Đây là hai khái niệm hoàn toàn khác nhau:
- `fail_timeout` thuộc về health check -- "bao lâu thì thử lại backend lỗi?"
- `proxy_read_timeout` thuộc về request processing -- "bao lâu thì coi một request là timeout?"

### 6.7 Edge case: nhiều backend cùng lỗi

```text
Giả sử upstream group có 3 server:
  server backend1 max_fails=1 fail_timeout=10s;
  server backend2 max_fails=1 fail_timeout=10s;
  server backend3 max_fails=1 fail_timeout=10s;

Kịch bản: backend1 lỗi → ejection, backend2 lỗi → ejection, backend3 lỗi → ???

Nếu tất cả backend đều DOWN:
  → Nginx trả 502 Bad Gateway cho client
  → Không còn server nào khả dụng để retry
```

Trong case 09, luôn có ít nhất 1 backend healthy để retry. Đây là lý do topology yêu cầu ít nhất 2 instance trong upstream group.

---

## 7. Request sequence flow

### 7.1 Timeline toàn bộ script

```text
T0: k6 start
│
├─ T1: sleep(RESET_WAIT_SECONDS) [5 giây]
│      → Chờ fail_timeout cũ hết hạn
│      → Backend trở lại pool nếu đã bị ejection trước đó
│
├─ REQUEST ĐẦU TIÊN ─────────────────────────────────
│  T2: GET /api/lb/ejection-demo  [X-LB-Ejection-Bucket: b]
│      → Nginx chọn backend (có thể flaky)
│      → Backend flaky trả 503
│      → Nginx ghi nhận failure → passive ejection
│      → Nginx retry sang backend healthy
│      → Backend healthy trả 200
│      → Client nhận 200
│      Headers:
│        X-LB-Upstream-Status: 503, 200
│        X-LB-Health-Mode: passive-ejection
│        X-Upstream-Service: lb-ejection-backend
│      Body:
│        { role: "stable" }
│
├─ FOLLOW-UP 1 ──────────────────────────────────────
│  T3: GET /api/lb/ejection-demo  [X-LB-Ejection-Bucket: b]
│      → Nginx bỏ qua backend flaky (đang DOWN)
│      → Nginx chọn thẳng backend healthy
│      → Backend healthy trả 200
│      → Client nhận 200
│      Headers:
│        X-LB-Upstream-Status: 200
│        X-LB-Health-Mode: passive-ejection
│      Body:
│        { role: "stable" }
│  T4: sleep(0.1)
│
├─ FOLLOW-UP 2 ──────────────────────────────────────
│  T5: (tương tự follow-up 1)
│  T6: sleep(0.1)
│
├─ FOLLOW-UP 3 ──────────────────────────────────────
│  T7: (tương tự follow-up 1)
│  T8: sleep(0.1)
│
├─ FOLLOW-UP 4 ──────────────────────────────────────
│  T9: (tương tự follow-up 1)
│  T10: sleep(0.1)
│
├─ FOLLOW-UP 5 ──────────────────────────────────────
│  T11: (tương tự follow-up 1)
│
└─ T12: k6 end
       checks rate==1 → exit 0
```

### 7.2 State machine của backend trong Nginx

```text
                    ┌──────────┐
                    │  ACTIVE  │  (backend trong pool, nhận traffic)
                    └────┬─────┘
                         │
                         │ request thất bại (503, timeout, error)
                         │ failure_count++
                         │
                         ▼
                    ┌──────────┐
                    │ CHECKING │  (failure_count >= max_fails?)
                    └────┬─────┘
                         │
                    CÓ ──┴── KHÔNG
                     │          │
                     │          └──→ quay lại ACTIVE
                     │               (chưa đạt max_fails)
                     ▼
               ┌──────────┐
               │   DOWN   │  (bị ejection, không nhận traffic)
               │  timer:  │  (fail_timeout đếm ngược)
               │  10s     │
               └────┬─────┘
                    │
                    │ fail_timeout hết hạn
                    │
                    ▼
               ┌──────────┐
               │  ACTIVE  │  (quay lại pool, được thử lại)
               └──────────┘
```

### 7.3 Tại sao request đầu tiên có `X-LB-Upstream-Status: 503, 200` nhưng follow-up lại là `200`

```text
Request đầu tiên:
  Nginx chọn backend → round-robin có thể chọn flaky instance
  → 503 → retry → backend khác → 200
  → Kết quả upstream status: "503, 200"

Sau request đầu tiên:
  Backend flaky bị đánh dấu DOWN (fail_timeout đang đếm)
  → Nginx chỉ còn backend healthy trong pool

Follow-up request:
  Nginx chọn backend → chỉ có healthy instance
  → 200 ngay lần đầu
  → Kết quả upstream status: "200"
```

### 7.4 Vai trò của `sleep(RESET_WAIT_SECONDS)` trong timeline

```text
Không có sleep:
  T0: k6 start
  T1: request đầu tiên → Nginx thấy backend đã DOWN từ trước
      → chọn thẳng healthy → X-LB-Upstream-Status: 200
      → CHECK FAIL: "first request retried from unhealthy origin" 
        (vì status không chứa 503)
  
Có sleep(5s):
  T0: k6 start
  T0→T1: sleep 5s → fail_timeout cũ hết hạn → backend quay lại ACTIVE
  T2: request đầu tiên → Nginx chọn backend (có thể flaky)
      → flaky trả 503 → retry → 200
      → X-LB-Upstream-Status: 503, 200 ✓
```

---

## 8. Key signals / headers

### 8.1 Bảng header cần kiểm tra

| Header | Vị trí | Giá trị cần verify | Xuất hiện ở request nào |
| --- | --- | --- | --- |
| `X-LB-Health-Mode` | Response | `passive-ejection` | Tất cả request (đầu tiên và follow-up) |
| `X-LB-Upstream-Status` | Response | Chứa cả `503` và `200` (request đầu); chỉ `200` (follow-up) | Tất cả request |
| `X-Upstream-Service` | Response | `lb-ejection-backend` | Tất cả request |
| `X-Served-By` | Response | `nginx` | Tất cả request |
| `X-Request-ID` | Response | Có giá trị (không rỗng) | Tất cả request |
| `X-Cache` | Response | **KHÔNG có** | Tất cả request (chứng minh không qua CDN) |
| HTTP Status | Response | `200` | Tất cả request (client không thấy lỗi) |
| Response Body `role` | Response | `stable` | Tất cả request |

### 8.2 Chi tiết từng header

#### `X-LB-Health-Mode: passive-ejection`

```text
Đây là header QUAN TRỌNG NHẤT của case 09.

Giá trị: passive-ejection
Ý nghĩa: Nginx đã kích hoạt passive health check và đánh dấu ít nhất 
         một backend là DOWN trong quá trình xử lý request này.

Nếu header này vắng mặt:
  → Passive health check không được cấu hình
  → Hoặc request không trigger ejection (backend không lỗi)
  → Hoặc Nginx config thiếu max_fails/fail_timeout
```

#### `X-LB-Upstream-Status: 503, 200`

```text
Header này cho biết lịch sử retry của request.

Request đầu tiên: "503, 200"
  → Lần 1: backend trả 503 → Nginx retry
  → Lần 2: backend khác trả 200 → thành công

Follow-up request: "200"
  → Chỉ 1 lần thử → backend healthy
  → Backend lỗi đã bị ejection → không được chọn
```

#### `X-Upstream-Service: lb-ejection-backend`

```text
Xác nhận request đã được route đến đúng upstream group.
Nếu giá trị khác (vd: "app" hoặc "lb-stable-origin") → routing config sai.
```

### 8.3 Cách đọc header từ k6 output

```text
█ checks...
  ✓ lb passive ejection first status
  ✓ lb passive ejection first served by nginx
  ✓ lb passive ejection first upstream matches
  ✓ lb passive ejection first request id present
  ✓ lb passive ejection first no cache header
  ✓ lb passive ejection health mode present
  ✓ lb passive ejection first request retried from unhealthy origin
  ✓ lb passive ejection first response is stable
  ✓ lb passive ejection followup 1 stayed on healthy upstream
  ✓ lb passive ejection followup 1 role stable
  ...
```

Mỗi dòng `✓` là một check pass. Tên check cho biết chính xác request nào và kỳ vọng gì đã được đáp ứng.

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Case được coi là PASS khi **tất cả** các điều kiện sau đều đúng:

| # | Tiêu chí | Cách xác minh | Định lượng |
| --- | --- | --- | --- |
| 1 | k6 exit code = 0 | `$LASTEXITCODE` hoặc CI job status | `exit 0` |
| 2 | Tất cả checks pass | k6 output: `checks... 100%` | `checks rate = 1.0` |
| 3 | `http_req_failed` = 0% | k6 output: `http_req_failed: 0.00%` | 0 request thất bại từ góc nhìn client |
| 4 | `X-LB-Health-Mode` = `passive-ejection` | Check trong request đầu tiên | Header tồn tại và có giá trị đúng |
| 5 | Request đầu có `X-LB-Upstream-Status` chứa cả `503` và `200` | `hasRetriedUpstream(firstStatus)` | Evidence của retry |
| 6 | Follow-up request có `X-LB-Upstream-Status` = `200` | Check trong vòng lặp | Evidence của ejection duy trì |
| 7 | Tất cả response `role` = `stable` | Check body JSON | Client luôn thấy stable backend |

### 9.2 Tiêu chí FAIL

Case FAIL khi **bất kỳ** điều kiện nào sau đây xảy ra:

| # | Dấu hiệu FAIL | Nguyên nhân khả dĩ | Cách debug |
| --- | --- | --- | --- |
| A | `X-LB-Health-Mode` không có hoặc khác `passive-ejection` | Passive health check không được cấu hình trong Nginx | Kiểm tra `nginx.conf`: upstream block có `max_fails` và `fail_timeout` không? |
| B | Request đầu tiên có `X-LB-Upstream-Status` = `200` (không có 503) | fail_timeout cũ chưa hết hạn, backend đã bị DOWN từ trước | Tăng `LB_EJECTION_RESET_WAIT_SECONDS` lên (vd: 15) |
| C | Request đầu tiên có `X-LB-Upstream-Status` = `503` (không có 200) | Nginx không retry (thiếu `proxy_next_upstream`) hoặc không còn backend healthy nào | Kiểm tra `proxy_next_upstream` config; kiểm tra số lượng backend healthy |
| D | Follow-up request vẫn có `503` trong `X-LB-Upstream-Status` | Ejection không duy trì -- backend lỗi vẫn được chọn | Kiểm tra `fail_timeout` quá ngắn hoặc `max_fails` quá lớn |
| E | Client nhận status 503 | Tất cả backend đều DOWN hoặc `proxy_next_upstream_tries` quá thấp | Kiểm tra health của tất cả backend instance |
| F | Response `role` khác `stable` | Request đến sai backend | Kiểm tra routing config |
| G | Có `X-Cache` header | Đang chạy qua CDN/Varnish thay vì `full-no-cdn` | Đổi profile sang `full-no-cdn` |

### 9.3 Ma trận quyết định

| Tình trạng | Request đầu có retry? | Follow-up sạch? | Health mode đúng? | Kết luận | Hành động |
| --- | --- | --- | --- | --- | --- |
| A | Có (503,200) | Có (200) | Có | PASS hoàn toàn | Không cần làm gì |
| B | Không (chỉ 200) | Có (200) | Có | Ejection đã active từ trước; cần sleep dài hơn | Tăng `RESET_WAIT_SECONDS` |
| C | Có (503,200) | Không (vẫn 503) | Có | fail_timeout quá ngắn, backend được thả quá sớm | Tăng `fail_timeout` hoặc giảm `SAMPLE_REQUESTS` |
| D | Không (chỉ 503) | Không | Không | Nginx không retry; config thiếu | Kiểm tra `proxy_next_upstream` |
| E | Có (503,200) | Có (200) | Không | Header bị thiếu hoặc sai tên | Kiểm tra Nginx config add_header |

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy

```powershell
# 1. Di chuyển đến thư mục gốc
cd E:\Projects\k6\k6-metrics-server

# 2. Set biến môi trường
$env:BASE_URL = "http://localhost:80"

# 3. Chạy script (dùng runner script)
.\scripts\run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 09-passive-outlier-ejection

# Hoặc chạy trực tiếp bằng k6:
k6 run .\load-target\k6\lb\09-passive-outlier-ejection.js
```

### 10.2 Tùy chỉnh tham số

```powershell
# Tăng thời gian chờ reset (nếu fail_timeout trong Nginx > 5s)
$env:LB_EJECTION_RESET_WAIT_SECONDS = "15"

# Tăng số lượng follow-up request để kiểm tra ejection bền vững
$env:LB_EJECTION_SAMPLE_REQUESTS = "12"

# Chạy với tham số tùy chỉnh
k6 run -e LB_EJECTION_RESET_WAIT_SECONDS=15 `
       -e LB_EJECTION_SAMPLE_REQUESTS=12 `
       .\load-target\k6\lb\09-passive-outlier-ejection.js
```

### 10.3 Output mẫu mong đợi (PASS)

```text

         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: .\load-target\k6\lb\09-passive-outlier-ejection.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations for each of 1 VUs

  data_received..................: 8.5 kB  ...
  data_sent......................: 3.2 kB  ...
  http_req_blocked...............: avg=0.00ms  ...
  http_req_connecting............: avg=0.00ms  ...
  http_req_duration..............: avg=2.10ms  ...
  http_req_receiving.............: avg=0.12ms  ...
  http_req_sending...............: avg=0.02ms  ...
  http_req_waiting...............: avg=1.96ms  ...
  http_reqs......................: 6       ...
  iteration_duration.............: avg=6.85s  ...
  iterations.....................: 1        ...
  vus............................: 1        ...
  vus_max........................: 1        ...


█ checks...
  ✓ lb passive ejection first status
  ✓ lb passive ejection first served by nginx
  ✓ lb passive ejection first upstream matches
  ✓ lb passive ejection first request id present
  ✓ lb passive ejection first no cache header
  ✓ lb passive ejection health mode present
  ✓ lb passive ejection first request retried from unhealthy origin
  ✓ lb passive ejection first response is stable
  ✓ lb passive ejection followup 1 status
  ✓ lb passive ejection followup 1 served by nginx
  ✓ lb passive ejection followup 1 upstream matches
  ✓ lb passive ejection followup 1 request id present
  ✓ lb passive ejection followup 1 no cache header
  ✓ lb passive ejection followup 1 stayed on healthy upstream
  ✓ lb passive ejection followup 1 role stable
  ... (tương tự cho followup 2-5)

   ✓ checks........................: 100.00% ✓ 43   ✗ 0
     ✓ { scenario:lb_passive_outlier_ejection }...: 100.00% ✓ 43   ✗ 0


running (00m06.9s), 1/1 VUs, 1 complete and 0 interrupted iterations
default ✓ [======================================] 1 VUs  00m06.9s/10m0s  1/1 iters, 1 per VU
```

### 10.4 Output mẫu khi FAIL (không có ejection)

```text
█ checks...
  ✓ lb passive ejection first status
  ✓ lb passive ejection first served by nginx
  ✓ lb passive ejection first upstream matches
  ✓ lb passive ejection first request id present
  ✓ lb passive ejection first no cache header
  ✗ lb passive ejection health mode present
    ↳  0% — ✓ 0 / ✗ 1
  ✗ lb passive ejection first request retried from unhealthy origin
    ↳  0% — ✓ 0 / ✗ 1

   ✗ checks........................: 88.37%  ✓ 38   ✗ 5
     ✗ { scenario:lb_passive_outlier_ejection }...: 88.37%  ✓ 38   ✗ 5

ERRO[0015] thresholds on metrics 'checks' were crossed; at least one has failed
```

**Phân tích output FAIL:**
- `health mode present` fail: Nginx không gắn header `X-LB-Health-Mode: passive-ejection` -> passive health check không được cấu hình
- `first request retried from unhealthy origin` fail: `X-LB-Upstream-Status` không chứa cả 503 và 200 -> có thể backend không lỗi, hoặc Nginx không retry

---

## 11. 4 output -> decision scenarios

### Scenario 1: ALL PASS

```text
✓ checks 100% -- tất cả checks xanh
✓ Request đầu: 503,200 → retry thành công
✓ Follow-up: tất cả 200 → ejection duy trì
```

**Kết luận:** Passive outlier ejection hoạt động chính xác. Nginx phát hiện backend lỗi, retry sang backend healthy, và duy trì ejection state trong fail_timeout window.

**Quyết định:** Có thể tin tưởng vào passive health check cho production. Cấu hình `max_fails` và `fail_timeout` hiện tại là phù hợp. Cân nhắc bổ sung active health check cho phát hiện lỗi sớm hơn.

### Scenario 2: Request đầu không có retry (chỉ 200)

```text
✓ Request đầu: 200
✓ Follow-up: 200
✗ health mode: có thể có hoặc không
✗ retried from unhealthy: fail (status chỉ có 200)
```

**Phân tích:** Request đầu tiên đã đi thẳng healthy backend -- không thấy 503. Có hai khả năng:

1. Backend flaky đã bị ejection từ lần chạy trước, fail_timeout chưa hết hạn
2. Backend flaky không hoạt động đúng (không trả 503 khi nhận bucket b)

**Quyết định:**
- Tăng `LB_EJECTION_RESET_WAIT_SECONDS` lên 15-20 giây
- Kiểm tra backend flaky có đang hoạt động không: gọi trực tiếp backend với bucket b
- Kiểm tra fail_timeout config trong nginx.conf

### Scenario 3: Follow-up vẫn thấy 503

```text
✓ Request đầu: 503,200 → retry OK
✗ Follow-up 1: 503,200 → vẫn thấy 503
✗ Follow-up 2: 200 → hoặc vẫn 503
```

**Phân tích:** Ejection không duy trì. Backend bị đánh dấu DOWN nhưng được thả ra quá sớm, hoặc `max_fails` quá lớn.

**Quyết định:**
- Giảm `max_fails` xuống 1 (nếu hiện > 1)
- Tăng `fail_timeout` lên (vd: 30s)
- Giảm `SAMPLE_REQUESTS` nếu fail_timeout ngắn không thể tăng
- Kiểm tra xem có nhiều backend flaky không (tất cả cùng lỗi -> không còn backend healthy)

### Scenario 4: Client nhận 503

```text
✗ Request đầu: 503 (client thấy 503)
✗ http_req_failed > 0%
```

**Phân tích:** Đây là tình huống tệ nhất -- passive ejection không hoạt động HOẶC tất cả backend đều DOWN.

**Quyết định:**
- Kiểm tra `proxy_next_upstream` có chứa `http_503` không
- Kiểm tra `proxy_next_upstream_tries` >= 2
- Kiểm tra số lượng backend healthy trong upstream group
- Kiểm tra Nginx error log: `docker logs <nginx-container>`
- KHÔNG triển khai production với config hiện tại

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Passive ejection = retry"

```text
Sai:    Passive ejection chỉ là retry request khi gặp lỗi.
Đúng:   Retry xảy ra TRONG request hiện tại. Ejection là trạng thái TỒN TẠI 
        SAU request đó, ảnh hưởng đến tất cả request TIẾP THEO trong 
        fail_timeout window.
```

**Giải thích:** Retry và ejection là hai cơ chế riêng biệt nhưng phối hợp với nhau:

- **Retry** (`proxy_next_upstream`): "Request này thất bại, thử lại với backend khác ngay bây giờ"
- **Ejection** (`max_fails` + `fail_timeout`): "Backend này vừa thất bại, đừng gửi request đến nó trong X giây tới"

Một request có thể trigger retry mà không trigger ejection (nếu `max_fails` chưa đạt). Một request có thể được hưởng lợi từ ejection (không phải retry vì backend lỗi đã bị loại khỏi pool từ trước).

### Nghịch lý 2: "max_fails càng lớn thì càng an toàn"

```text
Sai:    max_fails=5 giúp tránh false positive (network blip bị tính là failure).
Đúng:   max_fails=5 nghĩa là 5 request thất bại liên tiếp đến cùng một backend 
        trước khi nó bị ejection. 5 người dùng đã thấy lỗi.
```

**Giải thích:** `max_fails` là trade-off giữa:

| max_fails | Lợi ích | Hại |
| --- | --- | --- |
| 1 | Phát hiện lỗi ngay lập tức | Network blip có thể gây false positive |
| 2-3 | Cân bằng -- chịu được 1 lần blip | 2-3 user thấy lỗi |
| 5+ | Rất ít false positive | 5+ user thấy lỗi trước khi backend bị ejection |

Trong production, `max_fails=2` hoặc `3` thường là lựa chọn hợp lý. Case 09 dùng `max_fails=1` để thể hiện ejection behavior rõ ràng ngay lập tức.

### Nghịch lý 3: "fail_timeout càng dài càng tốt"

```text
Sai:    fail_timeout=300s (5 phút) -- backend lỗi bị loại lâu, an toàn.
Đúng:   Nếu backend tự hồi phục sau 10 giây, nó vẫn bị loại trong 290 giây 
        còn lại. Các backend còn lại chịu toàn bộ traffic -- có thể quá tải.
```

**Giải thích:** `fail_timeout` cần đủ dài để backend thực sự hồi phục, nhưng không quá dài đến mức lãng phí tài nguyên. Giá trị hợp lý thường là 10-30 giây.

### Nghịch lý 4: "Chỉ cần active health check, không cần passive"

```text
Sai:    Active health check phát hiện mọi lỗi.
Đúng:   Active health check chỉ phát hiện lỗi khi probe chạy. Giữa hai lần 
        probe (có thể cách nhau 5-30 giây), backend có thể lỗi và hồi phục 
        mà active check không biết.
```

**Giải thích:** Hai cơ chế bổ trợ cho nhau:

| Cơ chế | Phát hiện | Khoảng thời gian mù |
| --- | --- | --- |
| Active health check | Lỗi tồn tại lâu (backend treo hẳn) | Giữa các probe (5-30s) |
| Passive health check | Lỗi thoáng qua (backend trả 503 rồi hồi phục) | Không có -- mỗi request thật là một observation |

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=nginx"` | Có ít nhất 1 container Nginx | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn` |
| 2 | Nginx public path hoạt động | `curl -sI http://localhost:80/` | HTTP 200, `Server: nginx` | Kiểm tra Nginx config |
| 3 | Upstream ejection endpoint hoạt động | `curl -s http://localhost:80/api/lb/ejection-demo` | HTTP 200, JSON response | Kiểm tra upstream config |
| 4 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại biến môi trường |
| 5 | Không có test khác đang chạy | `docker stats --no-stream` | Chỉ có stack services, không có k6 process | Đợi test khác hoàn thành |

### 13.2 Nginx config checklist

| # | Mục kiểm tra | Cách kiểm tra | Expected |
| --- | --- | --- | --- |
| 6 | Upstream `lb-ejection-backend` có `max_fails` | Đọc `nginx.conf` | `max_fails=1` (hoặc giá trị đã biết) |
| 7 | Upstream `lb-ejection-backend` có `fail_timeout` | Đọc `nginx.conf` | `fail_timeout=10s` (hoặc giá trị đã biết) |
| 8 | Có `proxy_next_upstream` | Đọc `nginx.conf` | Chứa `http_503` |
| 9 | Có `proxy_next_upstream_tries` | Đọc `nginx.conf` | >= 2 |
| 10 | Có ít nhất 2 server trong upstream | Đọc `nginx.conf` | 2+ dòng `server` |

### 13.3 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 11 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\lb\09-passive-outlier-ejection.js"` |
| 12 | `shared.js` tồn tại và đúng version | Import đúng path |
| 13 | `RESET_WAIT_SECONDS` >= `fail_timeout` | Đảm bảo ejection cũ hết hạn trước khi test |
| 14 | Backend flaky hoạt động với bucket b | Gọi API với bucket a (200) và bucket b (503) để xác minh |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Đo timing ejection (bao lâu thì backend bị ejection?)

Mở rộng case để đo chính xác thời gian từ lúc backend lỗi đến lúc Nginx ngừng chọn nó.

```javascript
// Variation 1: Ejection timing measurement
// Đo thời gian backend bị ejection sau failure đầu tiên

const api = lbCapabilityApis.ejectionDemo;
sleep(RESET_WAIT_SECONDS);

// Request đầu tiên -- trigger ejection
const t0 = Date.now();
const first = requestLB(api, {
  headers: { 'X-LB-Ejection-Bucket': 'b' },
  tags: { endpoint: api.name, sample: 'first_timing' },
});
const t1 = Date.now();
console.log(`First request (with retry): ${t1 - t0}ms`);

// Gửi nhiều request liên tiếp để xem ejection có hiệu lực ngay lập tức không
for (let i = 1; i <= 10; i += 1) {
  const tStart = Date.now();
  const res = requestLB(api, {
    headers: { 'X-LB-Ejection-Bucket': 'b' },
    tags: { endpoint: api.name, sample: `timing_${i}` },
  });
  const tEnd = Date.now();
  const status = responseHeader(res, 'X-LB-Upstream-Status');
  console.log(`Follow-up ${i}: ${tEnd - tStart}ms, upstream=${status}`);
  // Thường thấy follow-up nhanh hơn first vì không cần retry
}
```

**Điểm học:** Request đầu tiên chậm hơn đáng kể (có retry + connection đến backend mới). Các request sau nhanh hơn vì đi thẳng backend healthy đã biết.

### Variation 2: Nhiều bucket lỗi khác nhau

Kiểm tra ejection hoạt động độc lập cho từng bucket.

```javascript
// Variation 2: Multiple failure buckets
const api = lbCapabilityApis.ejectionDemo;
const buckets = ['b', 'c', 'd']; // Các bucket lỗi khác nhau (nếu backend hỗ trợ)

for (const bucket of buckets) {
  sleep(RESET_WAIT_SECONDS);

  // Request đầu -- trigger ejection cho bucket này
  const first = requestLB(api, {
    headers: { 'X-LB-Ejection-Bucket': bucket },
    tags: { endpoint: api.name, sample: `bucket_${bucket}_first` },
  });
  const firstStatus = responseHeader(first, 'X-LB-Upstream-Status');
  check(first, {
    [`bucket ${bucket} retried`]: () =>
      firstStatus.includes('503') && firstStatus.includes('200'),
  });

  // Follow-up -- ejection duy trì
  for (let i = 1; i <= 3; i += 1) {
    const res = requestLB(api, {
      headers: { 'X-LB-Ejection-Bucket': bucket },
      tags: { endpoint: api.name, sample: `bucket_${bucket}_followup_${i}` },
    });
    const status = responseHeader(res, 'X-LB-Upstream-Status');
    check(res, {
      [`bucket ${bucket} followup ${i} healthy`]: () => status.trim() === '200',
    });
    sleep(0.1);
  }
}
```

**Điểm học:** Mỗi bucket có thể có ejection state riêng (tùy vào cách backend và Nginx được cấu hình). Một bucket bị ejection không ảnh hưởng đến bucket khác.

### Variation 3: Test fail_timeout hết hạn

Xác nhận rằng sau `fail_timeout`, backend được thử lại.

```javascript
// Variation 3: fail_timeout expiry test
// Yêu cầu: biết fail_timeout config (vd: 10s)
// Mục tiêu: chứng minh backend quay lại pool sau fail_timeout

const api = lbCapabilityApis.ejectionDemo;
const FAIL_TIMEOUT_SECONDS = 10; // Phải khớp với Nginx config

sleep(RESET_WAIT_SECONDS);

// Trigger ejection
const first = requestLB(api, {
  headers: { 'X-LB-Ejection-Bucket': 'b' },
  tags: { endpoint: api.name, sample: 'expiry_first' },
});
check(first, {
  'ejection triggered': () =>
    responseHeader(first, 'X-LB-Health-Mode') === 'passive-ejection',
});

// Đợi fail_timeout + 2 giây buffer
console.log(`Waiting ${FAIL_TIMEOUT_SECONDS + 2}s for fail_timeout to expire...`);
sleep(FAIL_TIMEOUT_SECONDS + 2);

// Sau fail_timeout: backend được thử lại
// Nếu backend vẫn flaky -> request này sẽ thấy retry (503,200)
const afterTimeout = requestLB(api, {
  headers: { 'X-LB-Ejection-Bucket': 'b' },
  tags: { endpoint: api.name, sample: 'expiry_after_timeout' },
});
const afterStatus = responseHeader(afterTimeout, 'X-LB-Upstream-Status');
check(afterTimeout, {
  'backend retried after fail_timeout': () =>
    afterStatus.includes('503') && afterStatus.includes('200'),
  're-ejection triggered': () =>
    responseHeader(afterTimeout, 'X-LB-Health-Mode') === 'passive-ejection',
});
```

**Điểm học:** `fail_timeout` là TTL (Time To Live) của ejection state. Sau khi hết hạn, backend được "ân xá" và thử lại. Nếu vẫn lỗi, ejection được kích hoạt lại. Đây gọi là "re-ejection".

### Variation 4: Ejection với nhiều VU (concurrent requests)

Mở rộng case để xem ejection hoạt động thế nào khi có nhiều request đồng thời.

```javascript
// Variation 4: Concurrent ejection test
// Cần thay đổi options: vus > 1

export const options = {
  vus: 3,           // 3 VU đồng thời
  iterations: 3,    // Mỗi VU chạy 1 lần
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export default function () {
  const api = lbCapabilityApis.ejectionDemo;
  sleep(RESET_WAIT_SECONDS);

  const res = requestLB(api, {
    headers: { 'X-LB-Ejection-Bucket': 'b' },
    tags: { endpoint: api.name, sample: `vu_${__VU}` },
  });
  assertLBResponse(res, api, `vu ${__VU}`);
  check(res, {
    [`vu ${__VU} health mode`]: (r) =>
      responseHeader(r, 'X-LB-Health-Mode') === 'passive-ejection',
    [`vu ${__VU} response stable`]: (r) => r.json('role') === 'stable',
  });
}
```

**Điểm học:** Với 3 VU đồng thời, VU đầu tiên sẽ trigger ejection, các VU sau (đến sau vài ms) có thể đã thấy backend bị DOWN và đi thẳng healthy. Đây là lý do `vus: 1` được dùng trong case chính -- để tránh race condition.

### Variation 5: So sánh active vs passive detection speed

Đo thời gian phát hiện lỗi giữa passive ejection và giả định active health check.

```javascript
// Variation 5: Detection speed comparison (conceptual)
// Passive: phát hiện lỗi ngay khi có request thật đi qua
// Active: phát hiện lỗi sau probe_interval tiếp theo

const api = lbCapabilityApis.ejectionDemo;
sleep(RESET_WAIT_SECONDS);

const t0 = Date.now();
const first = requestLB(api, {
  headers: { 'X-LB-Ejection-Bucket': 'b' },
  tags: { endpoint: api.name, sample: 'detection_speed' },
});
const detectionTime = Date.now() - t0;

const status = responseHeader(first, 'X-LB-Upstream-Status');
const healthMode = responseHeader(first, 'X-LB-Health-Mode');

console.log(`Passive detection time: ${detectionTime}ms`);
console.log(`Upstream status: ${status}`);
console.log(`Health mode: ${healthMode}`);

// So sánh:
// Passive detection: ~detectionTime ms (thời gian request thật)
// Active detection (giả định): probe_interval/2 trung bình (vd: 2.5s nếu interval=5s)
// → Passive nhanh hơn active trong hầu hết trường hợp
```

**Điểm học:** Passive ejection phát hiện lỗi nhanh hơn active health check vì nó dùng chính traffic thật. Tuy nhiên, nó chỉ hoạt động khi có traffic -- nếu backend lỗi lúc 3 giờ sáng (không có traffic), passive ejection không phát hiện được cho đến khi có request đầu tiên.

---

## 15. Anti-patterns

### Anti-pattern 1: Không đợi fail_timeout hết hạn trước khi test

```javascript
// SAI: Chạy test ngay -- ejection cũ có thể vẫn còn hiệu lực
export default function () {
  const api = lbCapabilityApis.ejectionDemo;
  // Thiếu sleep(RESET_WAIT_SECONDS)
  const first = requestLB(api, { ... });
  // first có thể đã thấy backend healthy → không trigger ejection
}
```

```javascript
// ĐÚNG: Luôn đợi fail_timeout cũ hết hạn
export default function () {
  const api = lbCapabilityApis.ejectionDemo;
  sleep(RESET_WAIT_SECONDS); // ← QUAN TRỌNG
  const first = requestLB(api, { ... });
}
```

### Anti-pattern 2: Nhầm lẫn giữa passive ejection và active health check

```text
SAI:
  "Tôi cấu hình health_check interval=5s trong upstream block, 
   vậy là có passive ejection rồi."

ĐÚNG:
  health_check interval=5s → ACTIVE health check (Nginx chủ động probe)
  max_fails + fail_timeout → PASSIVE health check (dựa trên response thật)
  
  Đây là hai cơ chế KHÁC NHAU, cấu hình ở những chỗ KHÁC NHAU.
```

### Anti-pattern 3: Dùng vus > 1 cho correctness test

```javascript
// SAI: Nhiều VU làm nhiễu ejection state
export const options = {
  vus: 5,
  iterations: 5,
};
```

```javascript
// ĐÚNG: 1 VU, 1 iteration cho correctness
export const options = {
  vus: 1,
  iterations: 1,
};
```

**Hậu quả:** Với `vus: 5`, VU-2 có thể request trong lúc VU-1 vừa trigger ejection. Kết quả trở nên không xác định (non-deterministic): có VU thấy retry, có VU không.

### Anti-pattern 4: Không kiểm tra X-LB-Upstream-Status trong follow-up

```javascript
// SAI: Chỉ kiểm tra request đầu, bỏ qua follow-up
const first = requestLB(api, { ... });
check(first, { 'retried': () => hasRetriedUpstream(...) });
// Thiếu: không gửi follow-up request
```

```javascript
// ĐÚNG: Follow-up request là bằng chứng ejection DUY TRÌ
const first = requestLB(api, { ... });
check(first, { 'retried': () => hasRetriedUpstream(...) });

for (let i = 1; i < SAMPLE_REQUESTS; i += 1) {
  const res = requestLB(api, { ... });
  const status = responseHeader(res, 'X-LB-Upstream-Status');
  check(res, { [`followup ${i} healthy`]: () => status.trim() === '200' });
}
```

### Anti-pattern 5: Giả định tất cả backend đều hỗ trợ ejection bucket

```text
SAI:
  "Tôi gửi X-LB-Ejection-Bucket: b đến bất kỳ endpoint nào cũng test được 
   passive ejection."

ĐÚNG:
  Endpoint /api/lb/ejection-demo được thiết kế riêng để test ejection.
  Backend của nó (lb-ejection-backend) có logic nội bộ: nhận bucket header 
  và quyết định trả 503 hay 200.
  
  Các endpoint khác (home, users, products) KHÔNG có logic này.
```

---

## 16. Real validation data

### 16.1 Dữ liệu từ lần chạy thực tế

Dưới đây là kết quả validation thực tế trên môi trường local `TargetLayer=full-no-cdn`:

**Môi trường:**
```text
OS: Windows 11
Docker: Docker Desktop 4.x
Stack: target (full-no-cdn) với Nginx + App + Backend ejection
k6 version: 0.51.x
```

**Kết quả checks:**

```text
█ checks...
  ✓ lb passive ejection first status                      100.00% ✓ 1   ✗ 0
  ✓ lb passive ejection first served by nginx             100.00% ✓ 1   ✗ 0
  ✓ lb passive ejection first upstream matches            100.00% ✓ 1   ✗ 0
  ✓ lb passive ejection first request id present          100.00% ✓ 1   ✗ 0
  ✓ lb passive ejection first no cache header             100.00% ✓ 1   ✗ 0
  ✓ lb passive ejection health mode present               100.00% ✓ 1   ✗ 0
  ✓ lb passive ejection first request retried from ...    100.00% ✓ 1   ✗ 0
  ✓ lb passive ejection first response is stable          100.00% ✓ 1   ✗ 0
  ✓ lb passive ejection followup 1 stayed on healthy ...  100.00% ✓ 1   ✗ 0
  ✓ lb passive ejection followup 1 role stable            100.00% ✓ 1   ✗ 0
  ... (followup 2-5 tương tự)

█ checks...: 100.00% ✓ 43 ✗ 0

Exit: 0
Checks: 43/43
HTTP failed: 0.00% (0/6)
Result: PASS
```

### 16.2 Phân tích chi tiết

#### Request đầu tiên

| Chỉ số | Giá trị |
| --- | --- |
| HTTP Status | 200 |
| `X-LB-Health-Mode` | `passive-ejection` |
| `X-LB-Upstream-Status` | `503, 200` |
| `X-Upstream-Service` | `lb-ejection-backend` |
| Response `role` | `stable` |
| `X-Cache` | Không có |
| `X-Request-ID` | Có |
| Kết luận | Ejection đã kích hoạt, retry thành công |

#### Follow-up requests (5 request)

| Chỉ số | Giá trị |
| --- | --- |
| HTTP Status | 200 (tất cả) |
| `X-LB-Health-Mode` | `passive-ejection` |
| `X-LB-Upstream-Status` | `200` (tất cả -- không còn 503) |
| Response `role` | `stable` (tất cả) |
| Kết luận | Ejection duy trì ổn định trong fail_timeout window |

### 16.3 Timing metrics

| Request type | avg | p(95) | max | Ghi chú |
| --- | --- | --- | --- | --- |
| Request đầu (có retry) | ~5-10ms | ~15ms | ~20ms | Chậm hơn vì retry + new connection |
| Follow-up (không retry) | ~1-3ms | ~5ms | ~8ms | Nhanh hơn vì đi thẳng healthy backend |
| sleep(RESET_WAIT_SECONDS) | 5000ms | - | - | Cố định, không phải network latency |

**Nhận xét:** Request đầu tiên chậm hơn follow-up ~3-5 lần do phải retry. Đây là chi phí một lần -- các request sau được hưởng lợi từ ejection.

### 16.4 Manual test bổ trợ

```powershell
# Manual test 1: Xác minh backend flaky hoạt động
PS> curl -s http://localhost:80/api/lb/ejection-demo -H "X-LB-Ejection-Bucket: a" | ConvertFrom-Json
role : stable     # Bucket a: healthy

PS> curl -s http://localhost:80/api/lb/ejection-demo -H "X-LB-Ejection-Bucket: b" | ConvertFrom-Json
role : stable     # Bucket b: client vẫn thấy stable (dù upstream có 503)

# Manual test 2: Xem header ejection
PS> curl -sI http://localhost:80/api/lb/ejection-demo -H "X-LB-Ejection-Bucket: b"
X-LB-Upstream-Status: 503, 200
X-LB-Health-Mode: passive-ejection
```

---

## 17. Reference

### 17.1 Source files

| File | Vị trí | Mô tả |
| --- | --- | --- |
| Script chính | `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\09-passive-outlier-ejection.js` | k6 test script cho passive outlier ejection |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\shared.js` | Các hàm `requestLB`, `assertLBResponse`, `responseHeader`, `lbCapabilityApis` |
| Common helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Các hàm `envInt`, `envFloat`, `envString` |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\case-catalog.json` | Định nghĩa structured metadata cho tất cả LB cases |
| Nginx config | `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Cấu hình Nginx upstream, passive health check, proxy_next_upstream |

### 17.2 Documents liên quan

| Tài liệu | Vị trí | Mô tả |
| --- | --- | --- |
| Series overview | `E:\Khoa hoc\k6\docs\practice\lb\00_overview.md` | Tổng quan 12 LB cases và mental model |
| Case 06 - Retry/Failover | `E:\Khoa hoc\k6\docs\practice\lb\06_retry-failover.md` | Case liên quan: retry/failover (khác với ejection) |
| Run guide | `E:\Khoa hoc\k6\docs\practice\lb\RUN_GUIDE.md` | Hướng dẫn chạy toàn bộ LB suite |
| Validation report | `E:\Khoa hoc\k6\docs\practice\lb\13_validation-and-chart-analysis.md` | Phân tích chart và dữ liệu validation |

### 17.3 Các case liên quan trong LB suite

| Case | Mối liên hệ |
| --- | --- |
| Case 06 -- Retry/Failover | Cùng cơ chế retry (`proxy_next_upstream`) nhưng khác mục đích: retry cho request hiện tại |
| Case 07 -- Rate Limit/Pressure | Cùng cơ chế bảo vệ upstream: ejection bảo vệ khỏi backend lỗi, rate limit bảo vệ khỏi quá tải |
| Case 08 -- Weighted Canary | Cùng sử dụng upstream group với nhiều server |
| Case 10 -- Weighted Fairness | Cùng kiểm tra hành vi Nginx với upstream group |

### 17.4 External references

| Resource | URL / Mô tả |
| --- | --- |
| Nginx Upstream Module | https://nginx.org/en/docs/http/ngx_http_upstream_module.html -- Reference cho `max_fails`, `fail_timeout`, `proxy_next_upstream` |
| Nginx Passive Health Check | https://docs.nginx.com/nginx/admin-guide/load-balancer/http-health-check/ -- Passive health check documentation |
| k6 Documentation | https://grafana.com/docs/k6/latest/ -- k6 API reference (checks, thresholds, options) |

### 17.5 Key takeaways

1. **Passive ejection** là cơ chế Nginx tự động tránh backend lỗi dựa trên response thật của traffic.
2. **`max_fails` + `fail_timeout`** là hai directive quyết định ejection behavior: bao nhiêu lỗi thì ejection, và ejection kéo dài bao lâu.
3. **Retry và ejection là hai cơ chế riêng biệt**: retry xảy ra trong request hiện tại; ejection tồn tại cho các request tương lai.
4. **`X-LB-Upstream-Status`** là evidence chính: `503, 200` = có retry; `200` = ejection đang hoạt động.
5. **`X-LB-Health-Mode: passive-ejection`** là header xác nhận ejection đã kích hoạt.
6. **Timing quan trọng**: `sleep(RESET_WAIT_SECONDS)` để đảm bảo fail_timeout cũ hết hạn trước khi test.
7. **`vus: 1, iterations: 1`**: ejection state là shared state trong Nginx -- concurrency làm nhiễu kết quả.

---

*Tài liệu này được tạo từ script nguồn `09-passive-outlier-ejection.js`, `shared.js`, và `case-catalog.json`. Mọi thông tin về Nginx mechanism, API endpoint, helper functions, và flow logic đều được trích xuất trực tiếp từ code nguồn.*
