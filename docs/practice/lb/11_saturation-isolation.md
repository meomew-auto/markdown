# Case 11: Saturation Isolation

> **Case ID:** `lb-11-saturation-isolation`
> **Script:** `11-saturation-isolation.js`
> **Profile:** `full-no-cdn`
> **Proof:** slow lane không kéo sập fast lane -- upstream isolation hoạt động đúng
> **Executor:** `constant-arrival-rate` (hai scenario song song)
> **Ngày cập nhật:** 2026-06-23

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
13. [Checklist trước, trong và sau khi chạy](#13-checklist-trước-trong-và-sau-khi-chạy)
14. [4-5 Variations với code mẫu](#14-4-5-variations-với-code-mẫu)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)
18. [Deep-dive: constant-arrival-rate executor](#18-deep-dive-constant-arrival-rate-executor)
19. [Deep-dive: k6 threshold tag filtering](#19-deep-dive-k6-threshold-tag-filtering)
20. [Deep-dive: connection pooling isolation](#20-deep-dive-connection-pooling-isolation)
21. [Deep-dive: Nginx upstream zone và shared memory](#21-deep-dive-nginx-upstream-zone-và-shared-memory)
22. [Deep-dive: Docker DNS resolution](#22-deep-dive-docker-dns-resolution)
23. [Hướng dẫn đọc output chi tiết](#23-hướng-dẫn-đọc-output-chi-tiết)
24. [So sánh kiến trúc: isolation vs no-isolation](#24-so-sánh-kiến-trúc-isolation-vs-no-isolation)
25. [Troubleshooting guide](#25-troubleshooting-guide)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh nghiệp vụ

Một hệ thống thương mại điện tử điển hình vận hành nhiều microservice phía sau một Gateway (Nginx). Trong số các service này, có những service có đặc tính hiệu năng hoàn toàn khác nhau:

| Service | Chức năng | Độ trễ điển hình | Lý do |
| --- | --- | --- | --- |
| Product search | Tìm kiếm sản phẩm theo từ khóa | 3-10ms | Chỉ đọc từ Elasticsearch index đã tối ưu |
| Product detail | Chi tiết sản phẩm | 3-15ms | Đọc từ cache layer (Redis) hoặc database đã index |
| Cart operations | Thêm/xóa/sửa giỏ hàng | 5-20ms | Write đơn giản vào database |
| Order history | Lịch sử đơn hàng 12 tháng | 200-800ms | Query aggregation trên dataset lớn, join nhiều bảng |
| Report generation | Báo cáo doanh thu theo quý | 2000-8000ms | Heavy query, scan toàn bộ bảng orders |
| Inventory sync | Đồng bộ tồn kho từ warehouse | 500-3000ms | Gọi external API của warehouse management system |

Câu hỏi đặt ra: **Nếu report generation service và inventory sync service bị chậm hoặc bão hòa, liệu product search và cart operations có bị ảnh hưởng không?**

Nếu tất cả service dùng chung một connection pool phía Gateway, câu trả lời là **CÓ**. Connection pool bị bão hòa bởi các request chậm sẽ khiến request nhanh phải chờ connection rảnh -- gây ra cascading failure trên toàn hệ thống.

### 1.2 Cascading failure là gì

Cascading failure (sự cố dây chuyền) là một trong những failure mode nguy hiểm nhất trong hệ thống phân tán:

```text
1. Service A (report) bắt đầu chậm do query nặng
   → Connection giữ lâu trong pool → pool cạn dần
2. Service B (search) cần connection mới
   → Không còn connection rảnh → request B bị queue
3. Client của B thấy timeout → retry → thêm request vào queue
4. Queue quá dài → memory pressure trên Gateway
5. Gateway bắt đầu từ chối connection mới → 503
6. Tất cả service đều không reachable, kể cả những service vốn nhanh
```

Hậu quả:
- **MTTR kéo dài**: Phải restart Gateway, restart service chậm, clear connection pool
- **Ảnh hưởng diện rộng**: Một service chậm làm sập toàn bộ platform
- **Khó diagnose**: Khi tất cả cùng fail, rất khó xác định root cause là service nào
- **Mất doanh thu**: Trong thời gian downtime, toàn bộ giao dịch bị gián đoạn

### 1.3 Gateway pattern: upstream isolation

Giải pháp cho cascading failure là **upstream isolation** -- mỗi route được map vào một upstream pool riêng biệt, với connection pool và health check độc lập:

```text
                    ┌─────────────────────────┐
                    │      Nginx Gateway       │
                    │                          │
  GET /search  ────►│  location /api/search     │──► lb_fast_backend  ──► search-svc:8090
                    │                          │
  POST /cart   ────►│  location /api/cart       │──► lb_fast_backend  ──► cart-svc:8090
                    │                          │
  GET /report  ────►│  location /api/report     │──► lb_slow_backend  ──► report-svc:8090
                    │                          │
                    └─────────────────────────┘

  lb_fast_backend:  keepalive 64, max_conns 512, health check độc lập
  lb_slow_backend:  keepalive 8,  max_conns 32,  health check độc lập
```

Khi `report-svc` bị chậm:
- Connection trong `lb_slow_backend` pool bị giữ lâu → pool này cạn
- **Nhưng `lb_fast_backend` pool hoàn toàn không bị ảnh hưởng**
- Search và cart vẫn phục vụ với latency thấp như bình thường

Đây chính là điều case 11 chứng minh.

### 1.4 Tại sao case này quan trọng trong production

Trong môi trường production thực tế, upstream isolation không phải là "nice to have" -- nó là **yêu cầu bắt buộc** cho bất kỳ hệ thống nào có nhiều hơn một loại workload với đặc tính hiệu năng khác nhau:

| Nếu không có isolation | Nếu có isolation |
| --- | --- |
| Một service chậm → tất cả cùng chậm | Một service chậm → chỉ service đó chậm |
| Không thể xác định root cause từ phía Gateway | Có thể xác định chính xác pool nào đang bão hòa |
| Phải scale ngang tất cả service | Chỉ cần scale service đang có vấn đề |
| Timeout setting "one size fits all" | Mỗi pool có timeout phù hợp với workload |
| Không thể áp dụng rate limit riêng cho slow service | Rate limit độc lập cho từng pool |
| SLA của fast service bị kéo xuống bởi slow service | SLA của từng service độc lập với nhau |

---

## 2. LB capability được chứng minh

### 2.1 Capability chính

Case 11 chứng minh **một** capability cốt lõi của Nginx Gateway:

> **Upstream pool isolation**: Hai upstream block riêng biệt (`lb_stable_backend` và `lb_slow_backend`) hoạt động độc lập hoàn toàn. Request vào fast lane không bao giờ bị ảnh hưởng bởi tình trạng bão hòa trong slow lane.

### 2.2 Cơ chế chứng minh

Case này chạy **song song** hai scenario `constant-arrival-rate`:

| Scenario | Exec function | Endpoint | Upstream target | Rate | Expected p95 |
| --- | --- | --- | --- | --- | --- |
| `fast_lane` | `fastLane()` | `lb_isolation_fast_demo` | `lb-stable-origin:8090` | 25 req/s | < 50ms |
| `slow_lane` | `slowLane()` | `lb_isolation_slow_demo` | `lb-slow-origin:8090` | 6 req/s | > 300ms |

Hai scenario chạy đồng thời trên cùng một Gateway (`localhost:80`), nhưng đi qua hai upstream pool hoàn toàn khác nhau.

### 2.3 Cấu trúc Nginx đảm bảo isolation

Hai `location` block riêng biệt trong Nginx config:

```nginx
location = /api/lb/isolation-fast-demo {
    add_header X-Upstream-Service "lb-stable-origin" always;
    add_header X-LB-Isolation-Class "fast" always;
    add_header X-Request-ID $request_id always;
    proxy_pass http://lb_stable_backend;
}

location = /api/lb/isolation-slow-demo {
    add_header X-Upstream-Service "lb-slow-origin" always;
    add_header X-LB-Isolation-Class "slow" always;
    add_header X-Request-ID $request_id always;
    proxy_pass http://lb_slow_backend;
}
```

Hai `upstream` block riêng biệt:

```nginx
upstream lb_stable_backend {
    zone upstream_lb_stable 64k;
    server lb-stable-origin:8090 resolve max_fails=3 fail_timeout=5s;
    keepalive 16;
}

upstream lb_slow_backend {
    zone upstream_lb_slow 64k;
    server lb-slow-origin:8090 resolve max_fails=1 fail_timeout=5s;
    keepalive 8;
}
```

Điểm mấu chốt:
- `proxy_pass http://lb_stable_backend` và `proxy_pass http://lb_slow_backend` trỏ vào hai upstream block khác nhau
- Mỗi upstream block có `zone` riêng (shared memory zone cho health check và load balancing state)
- Mỗi upstream block có `keepalive` riêng (connection pool riêng)
- Mỗi upstream block có `max_fails` riêng (health check policy riêng)

### 2.4 Evidence chain (chuỗi bằng chứng)

```text
Evidence 1: X-Upstream-Service header
  → Fast request luôn có X-Upstream-Service = "lb-stable-origin"
  → Slow request luôn có X-Upstream-Service = "lb-slow-origin"
  → Chứng minh: request đã được route đúng upstream pool

Evidence 2: X-LB-Isolation-Class header
  → Fast request có X-LB-Isolation-Class = "fast"
  → Slow request có X-LB-Isolation-Class = "slow"
  → Chứng minh: Gateway nhận biết và phân loại lane

Evidence 3: Endpoint-tagged latency
  → fast endpoint p95 < 50ms (thấp)
  → slow endpoint p95 > 300ms (cao có chủ đích)
  → Chứng minh: hai lane có hiệu năng độc lập, không ảnh hưởng lẫn nhau

Evidence 4: Failed rate = 0% cho cả hai endpoint
  → Chứng minh: không có request nào bị fail do pool saturation

Evidence 5: No X-Cache header
  → Chứng minh: request đi thẳng qua Nginx, không qua CDN
```

---

## 3. Vì sao phải test ở LB layer

### 3.1 App-level test không thấy được upstream routing

Nếu bạn test từ phía application (gọi trực tiếp `lb-stable-origin:8090` và `lb-slow-origin:8090`), bạn có thể verify rằng:
- Stable origin trả về nhanh
- Slow origin trả về chậm

Nhưng bạn **không thể** verify rằng:
- Request từ client vào Gateway được route đúng upstream pool
- Connection pool của fast lane không bị ảnh hưởng bởi slow lane
- Gateway inject header `X-Upstream-Service` và `X-LB-Isolation-Class` đúng
- Gateway không vô tình route fast request vào slow pool

### 3.2 Direct origin test không thấy được isolation mechanism

Nếu bạn test trực tiếp origin (bỏ qua Gateway), bạn đang test **application performance**, không phải **Gateway isolation capability**. Gateway chính là điểm quyết định:

```text
Test qua Gateway (LB layer):
  k6 → :80 → Nginx → [route decision] → upstream pool A hoặc B → origin
  ✓ Thấy được route decision
  ✓ Thấy được header injection
  ✓ Thấy được connection pool isolation
  ✓ Thấy được toàn bộ path từ client đến origin

Test direct origin (App layer):
  k6 → origin:8090
  ✗ Không thấy route decision
  ✗ Không thấy header injection
  ✗ Không thấy connection pool
  ✗ Chỉ thấy application performance
```

### 3.3 Chỉ LB-layer test mới chứng minh được "cùng Gateway, khác pool"

Đây là điểm tinh tế nhất của case 11. Cả hai scenario đều gửi request đến **cùng một địa chỉ** `localhost:80`:

```javascript
// Cả fastLane() và slowLane() đều gọi:
const res = requestLB(api, { tags: { endpoint: api.name, lane: 'fast' } });
// BASE_URL = http://localhost:80
// Chỉ khác nhau ở api path:
//   fast:  /api/lb/isolation-fast-demo
//   slow:  /api/lb/isolation-slow-demo
```

Từ góc nhìn của k6, cả hai request đều đi vào cùng một cổng `:80`. Nhưng từ góc nhìn của Nginx, hai request đi vào hai `location` block khác nhau, được `proxy_pass` đến hai upstream block khác nhau, dùng hai connection pool khác nhau.

**Đây chính là định nghĩa của upstream isolation**: cùng entrypoint, khác backend pool, không shared state.

### 3.4 So sánh các layer test

| Test layer | Thấy được gì | Không thấy được gì | Dùng khi nào |
| --- | --- | --- | --- |
| LB layer (case này) | Route decision, header injection, pool isolation, connection management | Application business logic | Verify Gateway capability |
| App layer | Business logic, data correctness, API contract | Routing, load balancing, failover | Verify application functionality |
| E2E (full stack) | Toàn bộ user journey | Root cause khi fail (layer nào gây ra?) | Smoke test, integration test |
| Direct origin | Raw application performance | Gateway behavior, routing | Performance profiling của app |
| CDN layer | Cache hit/miss, TTL, stale, invalidation | Origin routing, upstream health | Verify CDN capability |

---

## 4. Topology và precondition

### 4.1 Topology diagram

```text
┌──────────────────────────────────────────────────────────────┐
│                      Docker Network                          │
│                                                              │
│  ┌──────┐     ┌──────────────┐     ┌──────────────────────┐ │
│  │ k6   │────►│ Nginx (:80)  │────►│ lb-stable-origin     │ │
│  │      │     │              │     │ :8090                │ │
│  │      │     │ location     │     │ role: stable         │ │
│  │      │     │ /api/lb/     │     │ latency: ~1-5ms      │ │
│  │      │     │ isolation-   │     └──────────────────────┘ │
│  │      │     │ fast-demo    │                               │
│  │      │     │              │     ┌──────────────────────┐ │
│  │      │     │ location     │────►│ lb-slow-origin       │ │
│  │      │     │ /api/lb/     │     │ :8090                │ │
│  │      │     │ isolation-   │     │ role: slow           │ │
│  │      │     │ slow-demo    │     │ latency: ~500-700ms  │ │
│  └──────┘     └──────────────┘     └──────────────────────┘ │
│                                                              │
│  Profile: full-no-cdn (không Varnish, không CDN)             │
│  ScaleApp: 2 (cho app replicas, không ảnh hưởng case này)    │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Profile và tham số

| Tham số | Giá trị | Giải thích |
| --- | --- | --- |
| Profile | `full-no-cdn` | Bắt buộc -- không có CDN/Varnish đứng trước |
| TargetLayer | `full-no-cdn` | Stack khởi động với Nginx nhưng không có Varnish |
| ScaleApp | `2` | Số lượng app replica (không ảnh hưởng trực tiếp case này) |
| BASE_URL | `http://localhost:80` | Cổng public Gateway |
| LB_ISOLATION_FAST_RATE | `25` (default) | Tần suất gửi request fast lane (requests/giây) |
| LB_ISOLATION_SLOW_RATE | `6` (default) | Tần suất gửi request slow lane (requests/giây) |
| LB_ISOLATION_DURATION_SECONDS | `10` (default) | Thời gian chạy mỗi scenario (giây) |
| LB_ISOLATION_PRE_ALLOCATED_VUS | `16` (default) | Số VU cấp trước cho mỗi scenario |
| LB_ISOLATION_MAX_VUS | `32` (default) | Số VU tối đa cho mỗi scenario |

### 4.3 Precondition bắt buộc

Trước khi chạy case 11, các điều kiện sau phải được đáp ứng:

| # | Precondition | Cách kiểm tra | Expected |
| --- | --- | --- | --- |
| P1 | Stack `full-no-cdn` đã được khởi động | `docker ps --filter "name=nginx"` | Container nginx đang chạy |
| P2 | Nginx config có `location = /api/lb/isolation-fast-demo` | `curl -s http://localhost:80/api/lb/isolation-fast-demo \| jq '.role'` | `"stable"` |
| P3 | Nginx config có `location = /api/lb/isolation-slow-demo` | `curl -s http://localhost:80/api/lb/isolation-slow-demo \| jq '.role'` | `"slow"` |
| P4 | `lb-stable-origin` container healthy | `docker ps --filter "name=lb-stable-origin"` | Container đang chạy |
| P5 | `lb-slow-origin` container healthy | `docker ps --filter "name=lb-slow-origin"` | Container đang chạy |
| P6 | Không có CDN/Varnish | `curl -sI http://localhost:80/api/lb/isolation-fast-demo \| grep -i x-cache` | Không có output (header vắng mặt) |
| P7 | Route contract pass | `./scripts/check-target-routing.ps1 -TargetLayer full-no-cdn` | PASS |
| P8 | Slow origin thực sự chậm (~500-700ms) | Gọi curl thủ công và đo thời gian | > 300ms |

### 4.4 Env vars override

Tất cả tham số của case đều có thể override qua environment variables. Điều này cho phép điều chỉnh test mà không cần sửa script:

```powershell
# Tăng fast rate để test isolation ở load cao hơn
$env:LB_ISOLATION_FAST_RATE = "50"

# Tăng slow rate để test xem fast lane có bị ảnh hưởng khi slow lane tăng tải không
$env:LB_ISOLATION_SLOW_RATE = "20"

# Kéo dài thời gian chạy để có nhiều sample hơn
$env:LB_ISOLATION_DURATION_SECONDS = "30"

# Tăng VU pool để đảm bảo đủ capacity
$env:LB_ISOLATION_PRE_ALLOCATED_VUS = "32"
$env:LB_ISOLATION_MAX_VUS = "64"
```

Mechanism đọc env vars trong script:

```javascript
import { envInt } from '../shared/common.js';

const FAST_RATE = envInt('LB_ISOLATION_FAST_RATE', 25);
// envInt đọc từ process.env, nếu không có hoặc không parse được thì dùng default 25
```

---

## 5. Script deep-dive

### 5.1 Tổng quan cấu trúc script

Script `11-saturation-isolation.js` có cấu trúc rõ ràng, chia làm ba phần chính:

```text
1. IMPORTS & CONSTANTS (dòng 1-5)
   - Import check từ k6
   - Import envInt từ shared/common.js
   - Import assertLBResponse, lbCapabilityApis, requestLB từ shared.js
   - Khai báo constants với envInt (có default value)

2. OPTIONS BLOCK (dòng 7-40)
   - scenarios: fast_lane + slow_lane (cả hai dùng constant-arrival-rate)
   - thresholds: checks + endpoint-specific HTTP metrics
   - tags: scenario metadata

3. EXEC FUNCTIONS (dòng 42-64)
   - fastLane(): gọi isolationFastDemo API, assert + check role=stable
   - slowLane(): gọi isolationSlowDemo API, assert + check role=slow
```

### 5.2 Constants và env vars

```javascript
import { check } from 'k6';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbCapabilityApis, requestLB } from './shared.js';

const FAST_RATE = envInt('LB_ISOLATION_FAST_RATE', 25);
const SLOW_RATE = envInt('LB_ISOLATION_SLOW_RATE', 6);
const DURATION_SECONDS = envInt('LB_ISOLATION_DURATION_SECONDS', 10);
const PRE_ALLOCATED_VUS = envInt('LB_ISOLATION_PRE_ALLOCATED_VUS', 16);
const MAX_VUS = envInt('LB_ISOLATION_MAX_VUS', 32);
```

Phân tích từng constant:

| Constant | Default | Vai trò | Tại sao giá trị này |
| --- | --- | --- | --- |
| `FAST_RATE` | 25 req/s | Tần suất fast lane | Đủ cao để tạo áp lực lên connection pool fast, nhưng không quá cao để gây quá tải |
| `SLOW_RATE` | 6 req/s | Tần suất slow lane | Đủ để tạo connection trong slow pool, nhưng mỗi connection giữ ~600ms nên 6 req/s tạo concurrent load đáng kể |
| `DURATION_SECONDS` | 10s | Thời gian chạy | Đủ để slow lane có đủ sample, nhưng không quá dài để test nhanh |
| `PRE_ALLOCATED_VUS` | 16 | VU cấp trước | Đủ cho fast lane (25 req/s * ~5ms mỗi request ~ 1 VU concurrent) và slow lane (6 req/s * ~600ms ~ 4 VU concurrent) |
| `MAX_VUS` | 32 | VU tối đa | Gấp đôi preAllocated, cho phép buffer khi có spike |

### 5.3 Options block -- scenario definition

```javascript
export const options = {
  scenarios: {
    fast_lane: {
      executor: 'constant-arrival-rate',
      rate: FAST_RATE,           // 25 req/s
      timeUnit: '1s',
      duration: `${DURATION_SECONDS}s`,  // "10s"
      preAllocatedVUs: PRE_ALLOCATED_VUS, // 16
      maxVUs: MAX_VUS,                    // 32
      exec: 'fastLane',
    },
    slow_lane: {
      executor: 'constant-arrival-rate',
      rate: SLOW_RATE,           // 6 req/s
      timeUnit: '1s',
      duration: `${DURATION_SECONDS}s`,  // "10s"
      preAllocatedVUs: PRE_ALLOCATED_VUS, // 16
      maxVUs: MAX_VUS,                    // 32
      exec: 'slowLane',
    },
  },
  // ...
};
```

Điểm quan trọng về thiết kế scenario:

**Tại sao `constant-arrival-rate` mà không phải executor khác?**

| Executor | Có phù hợp không? | Lý do |
| --- | --- | --- |
| `constant-arrival-rate` | **CÓ** (đang dùng) | Tạo áp lực liên tục ở một rate cố định, không phụ thuộc vào thời gian response. Điều này đảm bảo slow lane luôn có 6 req/s đến pool, bất kể mỗi request mất bao lâu. |
| `constant-vus` | Không | Số VU cố định, request tiếp theo chỉ gửi khi request trước hoàn thành. Với slow lane (600ms/request), 4 VU chỉ tạo được ~6.67 req/s. Nếu response time thay đổi, arrival rate cũng thay đổi -- không kiểm soát được. |
| `shared-iterations` | Không | Tổng số iteration chia đều cho VU. Không đảm bảo rate ổn định, không phù hợp để test isolation dưới áp lực liên tục. |
| `ramping-arrival-rate` | Có thể (variation) | Cho phép thay đổi rate theo thời gian. Hữu ích để test isolation khi traffic thay đổi, nhưng phức tạp hơn mức cần thiết cho case cơ bản. |

**Tại sao hai scenario dùng chung `preAllocatedVUs` và `maxVUs`?**

Đây là một lựa chọn thiết kế có chủ đích:
- Cả hai scenario có tổng preAllocatedVUs = 16 + 16 = 32 VU
- Nếu tổng VU yêu cầu vượt quá khả năng của máy test, k6 sẽ báo lỗi `dropped_iterations`
- Việc dùng chung giá trị `PRE_ALLOCATED_VUS` cho cả hai lane giúp cấu hình đơn giản và nhất quán
- Trong thực tế, fast lane cần ít VU hơn (vì response nhanh), nhưng cấp dư VU không gây hại

### 5.4 Thresholds -- endpoint-tagged metrics

```javascript
thresholds: {
    checks: ['rate==1'],
    'http_req_failed{endpoint:lb_isolation_fast_demo}': ['rate==0'],
    'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],
    'http_req_failed{endpoint:lb_isolation_slow_demo}': ['rate==0'],
    'http_req_duration{endpoint:lb_isolation_slow_demo}': ['p(95)>300'],
},
```

Đây là phần **quan trọng nhất** của threshold configuration. Phân tích từng dòng:

| Threshold | Ý nghĩa | Tại sao |
| --- | --- | --- |
| `checks['rate==1']` | Tất cả check phải pass (100%) | Đảm bảo assertions về role và response headers đều đúng |
| `http_req_failed{endpoint:lb_isolation_fast_demo}['rate==0']` | Không có request fast lane nào fail | Fast pool phải luôn khỏe mạnh |
| `http_req_duration{endpoint:lb_isolation_fast_demo}['p(95)<50']` | p95 fast lane < 50ms | Fast lane phải nhanh, không bị kéo chậm |
| `http_req_failed{endpoint:lb_isolation_slow_demo}['rate==0']` | Không có request slow lane nào fail | Slow pool cũng không được fail (chỉ chậm thôi) |
| `http_req_duration{endpoint:lb_isolation_slow_demo}['p(95)>300']` | p95 slow lane > 300ms | Đây là **expected slowness** có chủ đích |

**CRITICAL: `p(95)>300` -- threshold "lớn hơn" thay vì "nhỏ hơn"**

Đây là một pattern hiếm gặp trong k6 thresholds. Hầu hết threshold dùng `<` (less than) để đảm bảo hiệu năng không vượt ngưỡng. Nhưng case 11 dùng `>` (greater than) cho slow lane. Lý do:

```text
Nếu slow lane p95 < 300ms:
  → Slow origin không thực sự chậm
  → Không thể chứng minh isolation (vì không có "chậm" để cô lập)
  → Test vô nghĩa -- cả hai lane đều nhanh thì không phân biệt được isolation

Nếu slow lane p95 > 300ms VÀ fast lane p95 < 50ms:
  → Slow origin thực sự chậm
  → Fast origin vẫn nhanh
  → Isolation hoạt động ✓
```

### 5.5 Exec functions

```javascript
export function fastLane() {
  const api = lbCapabilityApis.isolationFastDemo;
  const res = requestLB(api, {
    tags: {
      endpoint: api.name,    // 'lb_isolation_fast_demo'
      lane: 'fast',
    },
  });

  assertLBResponse(res, api, 'lb isolation fast lane');
  check(res, {
    'lb isolation fast lane role stable': (r) => r.json('role') === 'stable',
  });
}

export function slowLane() {
  const api = lbCapabilityApis.isolationSlowDemo;
  const res = requestLB(api, {
    tags: {
      endpoint: api.name,    // 'lb_isolation_slow_demo'
      lane: 'slow',
    },
  });

  assertLBResponse(res, api, 'lb isolation slow lane');
  check(res, {
    'lb isolation slow lane role slow': (r) => r.json('role') === 'slow',
  });
}
```

Phân tích từng exec function:

**`fastLane()`**:
1. Lấy API definition từ `lbCapabilityApis.isolationFastDemo`
   - Method: `GET`
   - Path: `/api/lb/isolation-fast-demo`
   - `expectedUpstream`: `'lb-stable-origin'`
2. Gọi `requestLB(api, { tags })` -- gửi HTTP request qua Gateway
   - Tags: `endpoint` (để threshold filtering) + `lane` (để phân loại trong dashboard)
3. `assertLBResponse(res, api, ...)` kiểm tra:
   - Status code = 200
   - `X-Served-By` = `nginx`
   - `X-Upstream-Service` = `lb-stable-origin` (đúng upstream)
   - `X-Request-ID` present (có trace ID)
   - Không có `X-Cache` (không qua CDN)
4. `check()` bổ sung: body JSON có `role === 'stable'`

**`slowLane()`**:
1. Lấy API definition từ `lbCapabilityApis.isolationSlowDemo`
   - Method: `GET`
   - Path: `/api/lb/isolation-slow-demo`
   - `expectedUpstream`: `'lb-slow-origin'`
2. Gọi `requestLB(api, { tags })` -- tương tự nhưng lane khác
3. `assertLBResponse(res, api, ...)` kiểm tra tương tự nhưng expectedUpstream khác
4. `check()` bổ sung: body JSON có `role === 'slow'`

**`lbCapabilityApis` definitions** (từ shared.js):

```javascript
isolationFastDemo: {
    method: 'GET',
    path: '/api/lb/isolation-fast-demo',
    expectedUpstream: 'lb-stable-origin',
},
isolationSlowDemo: {
    method: 'GET',
    path: '/api/lb/isolation-slow-demo',
    expectedUpstream: 'lb-slow-origin',
},
```

**`assertLBResponse()` behavior** (từ shared.js):

```javascript
function assertLBResponse(res, api, label) {
    // Check status = 200
    // Check X-Served-By = nginx
    // Check X-Upstream-Service = api.expectedUpstream
    // Check X-Request-ID present
    // Check X-Cache absent
}
```

### 5.6 Tags và metadata

```javascript
tags: {
    scenario: 'lb_saturation_isolation',
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
},
```

Các tags này không ảnh hưởng đến threshold (vì threshold đã dùng endpoint-specific tags), nhưng rất hữu ích cho:
- Lọc kết quả trong k6 summary JSON export
- Phân nhóm trong dashboard (Grafana)
- Cross-case analysis (so sánh các LB case với nhau)

---

## 6. Nginx/LB mechanism deep-dive

### 6.1 Upstream block isolation

Trong Nginx, mỗi `upstream` block là một đơn vị độc lập hoàn toàn:

```nginx
upstream lb_stable_backend {
    zone upstream_lb_stable 64k;
    server lb-stable-origin:8090 resolve max_fails=3 fail_timeout=5s;
    keepalive 16;
}

upstream lb_slow_backend {
    zone upstream_lb_slow 64k;
    server lb-slow-origin:8090 resolve max_fails=1 fail_timeout=5s;
    keepalive 8;
}
```

Mỗi upstream block có:

| Thành phần | `lb_stable_backend` | `lb_slow_backend` | Ý nghĩa |
| --- | --- | --- | --- |
| `zone` | `upstream_lb_stable 64k` | `upstream_lb_slow 64k` | Shared memory zone riêng -- lưu trữ state của upstream (peer status, health check counters, least_conn counters) |
| `server` | `lb-stable-origin:8090` | `lb-slow-origin:8090` | Backend server khác nhau |
| `max_fails` | `3` | `1` | Stable backend chịu được 3 lần fail liên tiếp trước khi bị đánh dấu down; slow backend chỉ chịu 1 lần (cố ý aggressive hơn) |
| `fail_timeout` | `5s` | `5s` | Thời gian backend bị đánh dấu down trước khi thử lại |
| `keepalive` | `16` | `8` | Số connection keep-alive tối đa đến backend -- stable pool có capacity lớn hơn |

### 6.2 Connection pool isolation

Đây là cơ chế cốt lõi đảm bảo isolation:

```text
lb_stable_backend connection pool:
  ┌─────────────────────────────────┐
  │ conn1: Nginx → stable-origin    │ (đang dùng cho request A)
  │ conn2: Nginx → stable-origin    │ (idle, sẵn sàng)
  │ conn3: Nginx → stable-origin    │ (idle, sẵn sàng)
  │ ...                             │
  │ conn16: Nginx → stable-origin   │ (idle, sẵn sàng)
  └─────────────────────────────────┘
  Tổng: tối đa 16 connection keep-alive
  Mỗi connection phục vụ request nhanh (~5ms) → pool hiếm khi cạn

lb_slow_backend connection pool:
  ┌─────────────────────────────────┐
  │ conn1: Nginx → slow-origin      │ (đang dùng, giữ ~600ms)
  │ conn2: Nginx → slow-origin      │ (đang dùng, giữ ~600ms)
  │ conn3: Nginx → slow-origin      │ (đang dùng, giữ ~600ms)
  │ conn4: Nginx → slow-origin      │ (đang dùng, giữ ~600ms)
  │ conn5: Nginx → slow-origin      │ (idle, sẵn sàng)
  │ ...                             │
  │ conn8: Nginx → slow-origin      │ (idle, sẵn sàng)
  └─────────────────────────────────┘
  Tổng: tối đa 8 connection keep-alive
  Mỗi connection giữ lâu (~600ms) → với 6 req/s, cần ~4 connection concurrent
```

Điểm mấu chốt: **Connection từ `lb_stable_backend` pool không bao giờ được dùng cho request đến `lb_slow_backend`, và ngược lại.** Điều này được đảm bảo bởi Nginx upstream architecture -- mỗi `proxy_pass` directive trỏ đến một upstream block duy nhất.

### 6.3 DNS resolver và dynamic upstream

```nginx
server lb-stable-origin:8090 resolve max_fails=3 fail_timeout=5s;
server lb-slow-origin:8090 resolve max_fails=1 fail_timeout=5s;
```

Từ khóa `resolve` trong `server` directive báo Nginx phải resolve DNS name mỗi khi cần. Điều này đặc biệt quan trọng trong môi trường Docker, nơi container IP có thể thay đổi khi restart.

Cấu hình resolver trong Nginx:

```nginx
resolver 127.0.0.11 valid=5s;
```

- `127.0.0.11`: Docker embedded DNS server
- `valid=5s`: Cache DNS result trong 5 giây, sau đó resolve lại

Nếu không có `resolve`, Nginx chỉ resolve DNS name một lần khi start/reload. Nếu container restart và IP thay đổi, Nginx sẽ tiếp tục gửi request đến IP cũ → lỗi.

### 6.4 Header injection

```nginx
add_header X-Upstream-Service "lb-stable-origin" always;
add_header X-LB-Isolation-Class "fast" always;
add_header X-Request-ID $request_id always;
```

Ba header này được inject vào response trước khi trả về client:

| Header | Giá trị (fast lane) | Giá trị (slow lane) | Nguồn |
| --- | --- | --- | --- |
| `X-Upstream-Service` | `lb-stable-origin` | `lb-slow-origin` | Hardcoded trong location block |
| `X-LB-Isolation-Class` | `fast` | `slow` | Hardcoded trong location block |
| `X-Request-ID` | `$request_id` | `$request_id` | Nginx built-in variable, unique per request |

Từ khóa `always` trong `add_header` đảm bảo header được thêm vào response **kể cả khi status code không phải 200** (ví dụ 503, 504). Không có `always`, Nginx mặc định chỉ thêm header cho response 200, 201, 204, 206, 301, 302, 303, 304, 307, 308.

### 6.5 max_fails khác nhau giữa hai pool

```nginx
# Stable backend: max_fails=3
server lb-stable-origin:8090 resolve max_fails=3 fail_timeout=5s;

# Slow backend: max_fails=1
server lb-slow-origin:8090 resolve max_fails=1 fail_timeout=5s;
```

Đây là một lựa chọn thiết kế có chủ đích:

| Pool | max_fails | Lý do |
| --- | --- | --- |
| `lb_stable_backend` | `3` | Stable backend được kỳ vọng luôn khỏe. Nếu fail 3 lần liên tiếp mới đánh dấu down -- tránh false positive. |
| `lb_slow_backend` | `1` | Slow backend vốn đã có vấn đề. Chỉ cần fail 1 lần là đánh dấu down luôn -- aggressive failure detection cho service không ổn định. |

Điều này mô phỏng một pattern thực tế: service quan trọng (fast lane) được cấu hình tolerant hơn với transient error, trong khi service không ổn định (slow lane) bị đánh dấu fail nhanh hơn để tránh lãng phí connection.

### 6.6 Không có shared state giữa hai location block

Hai `location` block này hoàn toàn độc lập:

```text
location = /api/lb/isolation-fast-demo {
    # Chỉ match path CHÍNH XÁC này
    # proxy_pass → lb_stable_backend
    # Không share biến, không share connection pool
    # Không share rate limit zone
}

location = /api/lb/isolation-slow-demo {
    # Chỉ match path CHÍNH XÁC này
    # proxy_pass → lb_slow_backend
    # Không share biến, không share connection pool
    # Không share rate limit zone
}
```

Toán tử `=` trong `location = /path` nghĩa là exact match -- chỉ match chính xác path này, không match prefix, không match regex. Điều này đảm bảo request không thể vô tình rơi vào sai location block.

---

## 7. Request sequence flow

### 7.1 Timeline diagram

```text
Time (ms)   FAST LANE                    SLOW LANE
────────────────────────────────────────────────────────────
0           k6 gửi GET /api/lb/          k6 gửi GET /api/lb/
            isolation-fast-demo          isolation-slow-demo
            ↓                            ↓
1           Nginx nhận request           Nginx nhận request
            Match location exact         Match location exact
            ↓                            ↓
2           Chọn upstream:               Chọn upstream:
            lb_stable_backend            lb_slow_backend
            ↓                            ↓
3           Lấy connection từ            Lấy connection từ
            stable pool (có sẵn)         slow pool (có sẵn)
            ↓                            ↓
4           Proxy pass đến               Proxy pass đến
            lb-stable-origin:8090        lb-slow-origin:8090
            ↓                            ↓
5           Origin xử lý (~2ms)          Origin xử lý (~600ms)
            ↓                            ↓  (cố ý chậm: sleep)
6           Origin trả 200 +             │
            body {role:"stable"}         │
            ↓                            │
7           Nginx inject headers:        │
            X-Upstream-Service           │
            X-LB-Isolation-Class         │
            X-Request-ID                 │
            ↓                            │
8           Trả connection về            │
            stable pool (idle)           │
            ↓                            │
9           k6 nhận response             │
            assertLBResponse()           │
            check role=stable            │
            ↓                            │
10          KẾT THÚC (~8ms total)        │
                                         │
...                                      │
                                         │
600                                      │ (vẫn đang xử lý...)
                                         │
605                                      Origin trả 200 +
                                         body {role:"slow"}
                                         ↓
606                                      Nginx inject headers:
                                         X-Upstream-Service
                                         X-LB-Isolation-Class
                                         X-Request-ID
                                         ↓
607                                      Trả connection về
                                         slow pool (idle)
                                         ↓
608                                      k6 nhận response
                                         assertLBResponse()
                                         check role=slow
                                         ↓
609                                      KẾT THÚC (~609ms total)
```

### 7.2 Concurrent request flow

Trong thực tế, nhiều request chạy song song:

```text
Tại giây thứ 3 của test:

Fast lane (25 req/s, mỗi request ~5ms):
  Request F1: bắt đầu 3000ms → kết thúc 3005ms
  Request F2: bắt đầu 3000ms → kết thúc 3005ms  (song song)
  Request F3: bắt đầu 3040ms → kết thúc 3045ms
  Request F4: bắt đầu 3040ms → kết thúc 3045ms  (song song)
  ...
  Request F25: bắt đầu 3960ms → kết thúc 3965ms
  → Tổng 25 request trong 1 giây, tất cả hoàn thành nhanh

Slow lane (6 req/s, mỗi request ~600ms):
  Request S1: bắt đầu 3000ms → kết thúc 3600ms  (đang chạy)
  Request S2: bắt đầu 3166ms → kết thúc 3766ms  (đang chạy)
  Request S3: bắt đầu 3333ms → kết thúc 3933ms  (đang chạy)
  Request S4: bắt đầu 3500ms → kết thúc 4100ms  (đang chạy)
  Request S5: bắt đầu 3666ms → kết thúc 4266ms  (đang chạy)
  Request S6: bắt đầu 3833ms → kết thúc 4433ms  (đang chạy)
  → 6 request đang chạy song song, mỗi request giữ connection ~600ms

Kết quả:
  - 4 connection trong slow pool đang bận (occupied)
  - 2 request đang queue chờ connection rảnh
  - NHƯNG: 16 connection trong fast pool vẫn idle hoặc xoay vòng nhanh
  - Fast request không hề bị ảnh hưởng!
```

### 7.3 Connection pooling flow

```text
Fast connection lifecycle (mỗi connection tồn tại ~5ms occupied):
  [Idle] → [Lấy ra dùng cho request] → [~5ms occupied] → [Trả về pool idle]
  → Một connection có thể phục vụ ~200 request/giây
  → Với 25 req/s, về lý thuyết chỉ cần 1 connection, nhưng pool có 16 để dự phòng

Slow connection lifecycle (mỗi connection tồn tại ~600ms occupied):
  [Idle] → [Lấy ra dùng cho request] → [~600ms occupied] → [Trả về pool idle]
  → Một connection chỉ phục vụ ~1.67 request/giây
  → Với 6 req/s, cần ít nhất 4 connection concurrent
  → Pool có 8 connection → đủ dùng

ĐIỂM MẤU CHỐT:
  Connection từ fast pool không bao giờ được "mượn" để phục vụ slow request
  Connection từ slow pool không bao giờ làm "tắc" fast pool
  → ISOLATION HOÀN TOÀN
```

### 7.4 Điều gì xảy ra nếu isolation không tồn tại (shared pool scenario)

Để hiểu rõ hơn giá trị của isolation, hãy xem xét kịch bản ngược lại -- nếu cả hai lane dùng chung một upstream block:

```text
Shared pool (keepalive 24):

Tại giây thứ 3:
  - 4 connection đang occupied bởi slow request (mỗi request ~600ms)
  - 6 connection đang occupied bởi fast request (mỗi request ~5ms, nhưng vẫn chiếm slot)
  - Còn 14 connection idle
  → Vẫn ổn

Tại giây thứ 6 (slow request tích lũy):
  - 12 connection đang occupied bởi slow request (tích lũy từ các giây trước)
  - 6 connection đang occupied bởi fast request
  - Còn 6 connection idle
  → Bắt đầu căng

Tại giây thứ 8:
  - 18 connection đang occupied bởi slow request
  - 6 connection đang occupied bởi fast request
  - 0 connection idle → POOL CẠN!
  → Fast request mới đến PHẢI CHỜ connection rảnh
  → Fast latency tăng từ ~5ms lên hàng trăm ms
  → Fast lane bị kéo chậm bởi slow lane
  → ISOLATION THẤT BẠI
```

Đây chính xác là những gì case 11 kiểm tra -- và với isolation đúng, kịch bản này không bao giờ xảy ra.

---

## 8. Key signals / headers

### 8.1 Bảng tổng hợp signals

| # | Signal | Layer | Source | Fast lane expected | Slow lane expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | `X-Upstream-Service` | Response header | Nginx inject | `lb-stable-origin` | `lb-slow-origin` | Xác nhận request được route đến đúng upstream pool |
| S2 | `X-LB-Isolation-Class` | Response header | Nginx inject | `fast` | `slow` | Phân loại lane -- dùng để verify trong dashboard |
| S3 | `X-Request-ID` | Response header | Nginx inject (`$request_id`) | Present, unique | Present, unique | Trace ID -- mỗi request có ID riêng |
| S4 | `X-Served-By` | Response header | Nginx inject | `nginx` | `nginx` | Xác nhận request đi qua Nginx Gateway |
| S5 | `X-Cache` | Response header | (vắng mặt) | ABSENT | ABSENT | Xác nhận không có CDN/Varnish đứng trước |
| S6 | `http_req_duration{endpoint:lb_isolation_fast_demo}` | k6 built-in metric | k6 measurement | p95 < 50ms | N/A | Fast lane latency -- phải thấp |
| S7 | `http_req_duration{endpoint:lb_isolation_slow_demo}` | k6 built-in metric | k6 measurement | N/A | p95 > 300ms | Slow lane latency -- phải cao có chủ đích |
| S8 | `http_req_failed{endpoint:lb_isolation_fast_demo}` | k6 built-in metric | k6 measurement | rate == 0 | N/A | Fast lane không có lỗi |
| S9 | `http_req_failed{endpoint:lb_isolation_slow_demo}` | k6 built-in metric | k6 measurement | N/A | rate == 0 | Slow lane không có lỗi HTTP |
| S10 | `role` (JSON body field) | Response body | Origin app | `"stable"` | `"slow"` | Xác nhận origin identity -- đúng origin đã trả lời |
| S11 | `checks` | k6 built-in metric | k6 assertion | rate == 1 (100%) | rate == 1 (100%) | Tất cả assertion đều pass |

### 8.2 Cách đọc từng signal

#### S1: `X-Upstream-Service`

```bash
# Kiểm tra thủ công
curl -sI http://localhost:80/api/lb/isolation-fast-demo | grep -i x-upstream-service
# Expected: X-Upstream-Service: lb-stable-origin

curl -sI http://localhost:80/api/lb/isolation-slow-demo | grep -i x-upstream-service
# Expected: X-Upstream-Service: lb-slow-origin
```

Header này được `assertLBResponse()` tự động kiểm tra. Nếu giá trị không khớp với `api.expectedUpstream`, assertion sẽ fail.

#### S2: `X-LB-Isolation-Class`

```bash
curl -sI http://localhost:80/api/lb/isolation-fast-demo | grep -i x-lb-isolation-class
# Expected: X-LB-Isolation-Class: fast

curl -sI http://localhost:80/api/lb/isolation-slow-demo | grep -i x-lb-isolation-class
# Expected: X-LB-Isolation-Class: slow
```

Header này không được assert trực tiếp trong script, nhưng có thể kiểm tra bằng custom check nếu cần. Nó hữu ích cho dashboard filtering và manual verification.

#### S3: `X-Request-ID`

```bash
curl -sI http://localhost:80/api/lb/isolation-fast-demo | grep -i x-request-id
# Expected: X-Request-ID: <uuid-like-string>
```

Mỗi request có một ID duy nhất, được Nginx generate qua `$request_id`. Header này được `assertLBResponse()` kiểm tra presence.

#### S5: `X-Cache` ABSENCE

```bash
curl -sI http://localhost:80/api/lb/isolation-fast-demo | grep -i x-cache
# Expected: NO OUTPUT (header vắng mặt)

# Nếu có output, ví dụ:
# X-Cache: HIT
# → Bạn đang chạy sai profile (có CDN đứng trước)!
```

Đây là một **negative signal** quan trọng. Sự vắng mặt của `X-Cache` chứng minh request không đi qua CDN. Nếu có `X-Cache`, toàn bộ kết quả case không có giá trị vì CDN có thể cache response và làm thay đổi latency measurement.

#### S6 & S7: Endpoint-tagged latency

```text
http_req_duration{endpoint:lb_isolation_fast_demo}
  avg: ~4-5ms
  p95: < 50ms
  p99: < 100ms
  → Fast lane latency thấp, ổn định

http_req_duration{endpoint:lb_isolation_slow_demo}
  avg: ~500-700ms
  p95: > 300ms
  p99: ~700-1000ms
  → Slow lane latency cao có chủ đích
```

**Tuyệt đối không dùng aggregate `http_req_duration`** (không có tag filter) để kết luận. Aggregate trộn cả fast và slow request, tạo ra một con số vô nghĩa:

```text
Aggregate p95 (SAI):
  250 request fast (~5ms) + 60 request slow (~600ms)
  → p95 sẽ rơi vào khoảng ~500-600ms
  → Kết luận sai: "System chậm, p95 = 550ms"
  → Thực tế: fast lane vẫn 5ms, chỉ slow lane chậm
```

#### S10: `role` JSON field

```bash
curl -s http://localhost:80/api/lb/isolation-fast-demo | jq '.role'
# Expected: "stable"

curl -s http://localhost:80/api/lb/isolation-slow-demo | jq '.role'
# Expected: "slow"
```

Đây là identity check của origin. Nó xác nhận rằng response thực sự đến từ đúng origin service, không phải từ một service khác do routing sai.

---

## 9. Pass/fail criteria

### 9.1 PASS criteria

Case được coi là **PASS** khi **TẤT CẢ** các điều kiện sau đồng thời đúng:

| # | Criterion | Loại | Cách kiểm tra | Giá trị PASS |
| --- | --- | --- | --- | --- |
| C1 | Tất cả checks pass | k6 threshold | `checks rate` | `==1` (100%) |
| C2 | Fast lane không có request fail | k6 threshold | `http_req_failed{endpoint:lb_isolation_fast_demo}` | `rate==0` |
| C3 | Slow lane không có request fail | k6 threshold | `http_req_failed{endpoint:lb_isolation_slow_demo}` | `rate==0` |
| C4 | Fast lane latency thấp | k6 threshold | `http_req_duration{endpoint:lb_isolation_fast_demo}` p95 | `< 50ms` |
| C5 | Slow lane latency cao có chủ đích | k6 threshold | `http_req_duration{endpoint:lb_isolation_slow_demo}` p95 | `> 300ms` |
| C6 | Fast request route đúng upstream | assertLBResponse | `X-Upstream-Service` header | `lb-stable-origin` |
| C7 | Slow request route đúng upstream | assertLBResponse | `X-Upstream-Service` header | `lb-slow-origin` |
| C8 | Fast request có đúng isolation class | Manual/optional check | `X-LB-Isolation-Class` header | `fast` |
| C9 | Slow request có đúng isolation class | Manual/optional check | `X-LB-Isolation-Class` header | `slow` |
| C10 | Không có X-Cache trong bất kỳ response nào | assertLBResponse | `X-Cache` header | ABSENT |
| C11 | Fast origin identity đúng | check trong script | `role` JSON field | `"stable"` |
| C12 | Slow origin identity đúng | check trong script | `role` JSON field | `"slow"` |

Nếu **tất cả** C1-C12 đều PASS, case đạt yêu cầu. Kết luận: **Isolation hoạt động đúng -- slow lane bão hòa không ảnh hưởng đến fast lane.**

### 9.2 FAIL criteria

Case bị coi là **FAIL** khi **BẤT KỲ** điều kiện nào sau đây xảy ra:

| # | Failure mode | Nguyên nhân có thể | Mức độ nghiêm trọng |
| --- | --- | --- | --- |
| F1 | Fast lane p95 >= 50ms | Fast pool bị ảnh hưởng bởi slow pool -- isolation không hoạt động | **CRITICAL** |
| F2 | Fast lane p95 xấp xỉ slow lane p95 | Cả hai lane dùng chung connection pool (shared upstream) | **CRITICAL** |
| F3 | Fast lane có failed request (status != 200) | Fast pool bị cạn connection do slow lane chiếm dụng | **CRITICAL** |
| F4 | `X-Upstream-Service` sai cho fast request | Routing config sai -- fast request đi vào slow pool | **CRITICAL** |
| F5 | `X-Upstream-Service` sai cho slow request | Routing config sai -- slow request đi vào fast pool | **CRITICAL** |
| F6 | `X-LB-Isolation-Class` sai | Header injection config sai | LOW |
| F7 | Slow lane p95 < 300ms | Slow origin không thực sự chậm -- không thể chứng minh isolation | **BLOCKER** |
| F8 | Slow lane có failed request | Slow pool bị lỗi không liên quan đến isolation | MEDIUM |
| F9 | Có `X-Cache` header | Chạy sai profile (có CDN) -- toàn bộ kết quả không có giá trị | **BLOCKER** |
| F10 | checks rate < 100% | Một hoặc nhiều assertion fail | **CRITICAL** |
| F11 | `role` không khớp | Origin identity sai -- có thể request đến sai service | **CRITICAL** |
| F12 | Aggregate p95 được dùng làm kết luận duy nhất | **SAI METHOD** -- không phải lỗi kỹ thuật nhưng là lỗi phân tích nghiêm trọng | N/A |

### 9.3 Phân biệt FAIL do isolation vs FAIL do setup

Quan trọng: không phải mọi FAIL đều là lỗi isolation. Cần phân biệt:

| Triệu chứng | Có thể là lỗi isolation? | Có thể là lỗi setup? |
| --- | --- | --- |
| Fast lane p95 cao, slow lane p95 cao | **CÓ** -- có thể shared pool | Có thể -- slow origin không chậm, cả hai cùng nhanh (F7) |
| Fast lane p95 thấp, slow lane p95 thấp | Không -- isolation vẫn tốt | **CÓ** -- slow origin không được cấu hình chậm (F7) |
| Fast lane có failed request | **CÓ** -- pool saturation | Có thể -- network issue hoặc origin crash |
| `X-Upstream-Service` sai | **CÓ** -- routing config sai | Có thể -- Nginx config chưa được reload |
| Có `X-Cache` | Không -- không liên quan isolation | **CÓ** -- sai profile, đang chạy với CDN |

---

## 10. Cách chạy + output mẫu

### 10.1 Khởi động stack

```powershell
# Bước 1: Khởi động stack với profile full-no-cdn
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2

# Đợi tất cả container healthy
docker ps --format "table {{.Names}}\t{{.Status}}"
```

### 10.2 Kiểm tra precondition

```powershell
# Bước 2: Kiểm tra route contract
.\scripts\check-target-routing.ps1 -BaseUrl "http://localhost:80" -TargetLayer full-no-cdn

# Bước 3: Kiểm tra thủ công từng lane
curl -s http://localhost:80/api/lb/isolation-fast-demo | jq .
# Expected: { "role": "stable", ... }

curl -s http://localhost:80/api/lb/isolation-slow-demo | jq .
# Expected: { "role": "slow", ... }

# Kiểm tra không có CDN
curl -sI http://localhost:80/api/lb/isolation-fast-demo | grep -i x-cache
# Expected: (no output)

# Đo latency slow lane để xác nhận nó thực sự chậm
curl -w "\nTime: %{time_total}s\n" -s http://localhost:80/api/lb/isolation-slow-demo
# Expected: > 0.3s
```

### 10.3 Chạy case

```powershell
# Bước 4: Chạy riêng case 11
.\scripts\run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 11-saturation-isolation

# Hoặc chạy với env vars override
$env:LB_ISOLATION_FAST_RATE = "50"
$env:LB_ISOLATION_DURATION_SECONDS = "30"
.\scripts\run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 11-saturation-isolation

# Inspect trước khi chạy (dry-run)
.\scripts\run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 11-saturation-isolation -InspectOnly
```

### 10.4 Output mẫu

```text
============================================================
Case: 11-saturation-isolation
Script: 11-saturation-isolation.js
Profile: full-no-cdn
============================================================

  scenarios: (100.00%) 2 valid, 0 invalid

     [-------------------------------------------------------]
     fast_lane:
        executor: constant-arrival-rate
        rate: 25/s
        duration: 10s
        preAllocatedVUs: 16
        maxVUs: 32

     slow_lane:
        executor: constant-arrival-rate
        rate: 6/s
        duration: 10s
        preAllocatedVUs: 16
        maxVUs: 32

--------------------------------------------------------------
Running: 11-saturation-isolation.js

     ✓ lb isolation fast lane role stable
     ✓ lb isolation slow lane role slow
     ✓ lb isolation fast demo status 200
     ✓ lb isolation fast demo X-Served-By nginx
     ✓ lb isolation fast demo X-Upstream-Service lb-stable-origin
     ✓ lb isolation fast demo X-Request-ID present
     ✓ lb isolation fast demo no X-Cache
     ✓ lb isolation slow demo status 200
     ✓ lb isolation slow demo X-Served-By nginx
     ✓ lb isolation slow demo X-Upstream-Service lb-slow-origin
     ✓ lb isolation slow demo X-Request-ID present
     ✓ lb isolation slow demo no X-Cache

     ████████████████████████████████████████████████ 100%

     checks........................: 100.00% (1872/1872)
     http_req_failed..............: 0.00%  (0/312)
     http_req_duration............: avg=132.45ms p(95)=598.21ms
       { endpoint:lb_isolation_fast_demo }: avg=4.29ms  p(95)=8.12ms
       { endpoint:lb_isolation_slow_demo }: avg=589.73ms p(95)=616.27ms

     fast_lane_scenario...........: 250 iterations, 25.00/s
     slow_lane_scenario...........: 62 iterations, 6.20/s

Exit code: 0
Result: PASS ✓
```

### 10.5 Cách đọc output

**Dòng quan trọng nhất** trong output:

```text
http_req_duration............: avg=132.45ms p(95)=598.21ms       ← ĐỪNG ĐỌC DÒNG NÀY!
  { endpoint:lb_isolation_fast_demo }: avg=4.29ms  p(95)=8.12ms   ← ĐÂY MỚI LÀ FAST LANE
  { endpoint:lb_isolation_slow_demo }: avg=589.73ms p(95)=616.27ms ← ĐÂY MỚI LÀ SLOW LANE
```

Giải thích:
1. **Dòng aggregate `http_req_duration`**: avg=132.45ms, p95=598.21ms -- con số này là vô nghĩa vì nó trộn lẫn fast request (~5ms) và slow request (~600ms). Nếu bạn chỉ nhìn dòng này, bạn sẽ kết luận "hệ thống chậm, p95=598ms". Đây là kết luận **SAI**.
2. **Dòng `{endpoint:lb_isolation_fast_demo}`**: avg=4.29ms, p95=8.12ms -- tất cả request fast lane đều nhanh. Đây là bằng chứng isolation hoạt động.
3. **Dòng `{endpoint:lb_isolation_slow_demo}`**: avg=589.73ms, p95=616.27ms -- slow lane chậm có chủ đích. Đây là expected.

**Cách đọc checks**:

```text
✓ lb isolation fast lane role stable         ← Body role = "stable"
✓ lb isolation slow lane role slow           ← Body role = "slow"
✓ lb isolation fast demo status 200          ← HTTP 200
✓ lb isolation fast demo X-Served-By nginx   ← Đi qua Gateway
✓ lb isolation fast demo X-Upstream-Service lb-stable-origin ← Route đúng
✓ lb isolation fast demo X-Request-ID present ← Có trace ID
✓ lb isolation fast demo no X-Cache           ← Không qua CDN
✓ lb isolation slow demo status 200
✓ lb isolation slow demo X-Served-By nginx
✓ lb isolation slow demo X-Upstream-Service lb-slow-origin
✓ lb isolation slow demo X-Request-ID present
✓ lb isolation slow demo no X-Cache
```

Tất cả check đều pass (1872/1872) -- không có assertion nào fail.

### 10.6 JSON summary export

k6 có thể export kết quả dưới dạng JSON để phân tích thêm:

```powershell
# Chạy với JSON export
k6 run --out json=results.json scripts/practice/lb/11-saturation-isolation.js
```

Một phần của JSON export:

```json
{
  "metrics": {
    "http_req_duration": {
      "type": "trend",
      "contains": "time",
      "values": {
        "avg": 132.45,
        "p(95)": 598.21
      },
      "thresholds": {
        "http_req_duration{endpoint:lb_isolation_fast_demo}": {
          "p(95)<50": true
        },
        "http_req_duration{endpoint:lb_isolation_slow_demo}": {
          "p(95)>300": true
        }
      }
    },
    "http_req_failed": {
      "type": "rate",
      "values": {
        "rate": 0.0
      },
      "thresholds": {
        "http_req_failed{endpoint:lb_isolation_fast_demo}": {
          "rate==0": true
        },
        "http_req_failed{endpoint:lb_isolation_slow_demo}": {
          "rate==0": true
        }
      }
    },
    "checks": {
      "type": "rate",
      "values": {
        "rate": 1.0
      },
      "thresholds": {
        "rate==1": true
      }
    }
  }
}
```

---

## 11. 4 output -> decision scenarios

### Scenario A: Fast p95 low, slow p95 high, both 0% failed

```text
Fast lane: p95 ~4-8ms,  failed=0%
Slow lane: p95 ~600ms,  failed=0%
Checks: 100%
```

**Kết luận: PASS -- Isolation hoạt động đúng.**

Đây là kết quả lý tưởng. Fast lane duy trì latency thấp mặc dù slow lane có request kéo dài hàng trăm ms. Hai pool hoàn toàn độc lập. **Đây là trạng thái production mong muốn.**

Quyết định: Không cần thay đổi gì. Isolation configuration hiện tại đáp ứng yêu cầu. Có thể triển khai pattern này cho các service khác có đặc tính hiệu năng khác nhau.

### Scenario B: Fast p95 high (bị kéo), slow p95 high

```text
Fast lane: p95 ~400-600ms,  failed=0%
Slow lane: p95 ~600ms,      failed=0%
Checks: 100% (về mặt assertion headers, nhưng threshold p95<50 fail)
```

**Kết luận: FAIL -- Upstream pools not isolated.**

Fast lane bị kéo chậm theo slow lane. Có thể do:
1. **Shared upstream block**: Cả hai location `proxy_pass` đến cùng một upstream → connection pool dùng chung
2. **Wrong proxy_pass**: `proxy_pass http://lb_slow_backend` được dùng cho cả hai location
3. **Resource contention ở tầng thấp hơn**: CPU, memory, hoặc network bandwidth giữa Nginx và origin bị bão hòa

Quyết định:
- Kiểm tra Nginx config: xác nhận mỗi location block `proxy_pass` đến upstream block riêng
- Kiểm tra `nginx -T` output để xem config runtime thực tế
- Tăng `keepalive` cho fast pool nếu pool đang bị cạn
- Kiểm tra resource usage của Nginx container (`docker stats nginx`)

### Scenario C: Fast p95 low, slow p95 low

```text
Fast lane: p95 ~4-8ms,   failed=0%
Slow lane: p95 ~5-15ms,  failed=0%
Checks: 100%
```

**Kết luận: FAIL -- Slow origin không thực sự chậm (test setup wrong).**

Nếu slow origin cũng nhanh như fast origin, case này không chứng minh được isolation -- vì không có gì để cô lập. Threshold `p(95)>300` sẽ fail.

Nguyên nhân có thể:
1. Slow origin service không được cấu hình delay (thiếu sleep/delay logic)
2. Slow origin container không phải là phiên bản có delay (wrong image tag)
3. Request bị cache ở đâu đó (CDN, browser cache) mặc dù không nên có

Quyết định:
- Kiểm tra slow origin container image và logic delay
- Gọi curl thủ công và đo thời gian: `curl -w "\nTime: %{time_total}s\n" http://localhost:80/api/lb/isolation-slow-demo`
- Đảm bảo đang chạy đúng profile `full-no-cdn` (không có CDN)

### Scenario D: Fast has failed requests

```text
Fast lane: p95 ~10-50ms,  failed=5-20%
Slow lane: p95 ~600ms,    failed=0%
Checks: < 100%
```

**Kết luận: FAIL -- Fast pool bị ảnh hưởng bởi slow pool saturation.**

Dù fast latency vẫn thấp (p95 < 50ms), một số request fast lane bị fail. Điều này có thể xảy ra khi:
1. **Connection pool fast bị cạn**: Dù pool riêng, nhưng nếu `keepalive` quá thấp so với `FAST_RATE`, request mới sẽ bị từ chối
2. **Nginx worker process bị quá tải**: Quá nhiều connection đến slow pool làm Nginx worker không kịp xử lý request mới
3. **Resource limit của Nginx container**: `worker_connections` hoặc `worker_rlimit_nofile` bị hit

Quyết định:
- Tăng `keepalive` cho `lb_stable_backend`
- Tăng `worker_connections` trong Nginx config
- Kiểm tra `dmesg` hoặc Nginx error log để tìm dấu hiệu resource exhaustion
- Cân nhắc tách Nginx instance riêng cho fast và slow traffic (extreme case)

---

## 12. Nghịch lý / misconceptions

### Paradox 1: "Aggregate p95 cao nghĩa là hệ thống chậm"

**Đây là SAI và là misconception nguy hiểm nhất.**

```text
Aggregate p95 = 598ms ← Đây là con số "rác" (misleading aggregate)

Thực tế:
  Fast lane p95 = 4.29ms  ← Nhanh!
  Slow lane p95 = 616ms   ← Chậm có chủ đích!

Hai con số này trộn vào nhau cho ra 598ms,
nhưng không có request nào thực sự mất 598ms cả!
```

Trong một hệ thống có nhiều loại workload với đặc tính hiệu năng khác nhau, **aggregate percentile là vô nghĩa**. Bạn phải luôn phân tích latency theo từng endpoint riêng biệt.

Hệ quả thực tế: Nếu ops team chỉ nhìn vào aggregate dashboard, họ sẽ thấy "p95 = 598ms, hệ thống đang chậm" và có thể trigger false alarm, scale up không cần thiết, hoặc rollback deployment đang hoạt động tốt.

### Paradox 2: "Tất cả request 200 là pass"

**SAI.** HTTP 200 chỉ có nghĩa là request không bị lỗi HTTP. Nó không nói lên điều gì về:
- Route có đúng không (X-Upstream-Service)
- Latency có đúng kỳ vọng không (endpoint-specific p95)
- Isolation class có đúng không (X-LB-Isolation-Class)
- Có qua CDN không (X-Cache absence)

Một case có thể có 100% HTTP 200 nhưng vẫn FAIL nếu:
- Fast lane p95 > 50ms (isolation không hoạt động)
- `X-Upstream-Service` sai (route nhầm pool)
- Có `X-Cache` (đang test CDN, không phải LB)

### Paradox 3: "Slow lane p95 > 300ms là BAD"

**SAI -- đây là EXPECTED BEHAVIOR.**

Slow lane được thiết kế để chậm có chủ đích. Threshold `p(95)>300` là threshold "lớn hơn" (greater than), không phải "nhỏ hơn". Nếu slow lane nhanh (< 300ms), test thất bại vì không có "chậm" để chứng minh isolation.

Đây là một pattern test quan trọng:

```text
Test thông thường:  "Chứng minh X đủ nhanh"  → threshold < X
Case 11 slow lane:  "Chứng minh Y đủ chậm"   → threshold > Y

Cả hai đều là threshold hợp lệ, phục vụ mục đích khác nhau.
```

### Paradox 4: "Cùng Gateway nghĩa là shared everything"

**SAI.** Đây là hiểu lầm phổ biến về Nginx architecture.

Cùng một Nginx instance có thể phục vụ nhiều upstream pool hoàn toàn độc lập:

```text
Cùng Nginx process:
  ├── upstream pool A (keepalive 64, zone riêng, health check riêng)
  ├── upstream pool B (keepalive 16, zone riêng, health check riêng)
  ├── upstream pool C (keepalive 8,  zone riêng, health check riêng)
  └── upstream pool D (keepalive 32, zone riêng, health check riêng)

Mỗi pool có:
  - Connection pool riêng (keepalive connections)
  - Health check state riêng (shared memory zone)
  - Load balancing state riêng (least_conn, round_robin counters)
  - DNS resolution cache riêng
```

"Shared" duy nhất là Nginx worker process và network socket -- nhưng đây là resource ở tầng OS, không phải tầng application.

### Paradox 5: "Chỉ cần test fast lane một mình"

**SAI.** Nếu chỉ test fast lane (không có slow lane chạy song song), bạn chỉ chứng minh được "fast lane nhanh khi không có áp lực". Nhưng bạn không chứng minh được "fast lane vẫn nhanh KHI slow lane đang bão hòa".

```text
Test fast lane một mình:
  → Fast p95 = 5ms
  → Kết luận: "Fast lane hoạt động tốt"
  → NHƯNG: chưa chứng minh được isolation!

Test cả hai lane song song (case này):
  → Fast p95 = 5ms (dù slow lane đang chạy 6 req/s, mỗi req 600ms)
  → Slow p95 = 600ms
  → Kết luận: "Fast lane hoạt động tốt NGAY CẢ KHI slow lane bão hòa"
  → ĐÃ chứng minh được isolation!
```

### Paradox 6: "p95 của fast lane < 1ms là tốt hơn < 50ms"

**Không hẳn.** Threshold `p95 < 50ms` được chọn có chủ đích, không phải là "càng thấp càng tốt":

- Nếu đặt threshold quá thấp (ví dụ `p95 < 5ms`), test có thể fail vì network jitter hoặc GC pause, không phải vì isolation fail. Đây là **false negative**.
- `50ms` là ngưỡng đủ rộng để absorb variance bình thường của môi trường test (Docker networking, CPU scheduling, etc.), nhưng đủ hẹp để phát hiện isolation failure thực sự.
- Trong production, threshold nên được calibrate dựa trên baseline latency thực tế + buffer cho variance.

---

## 13. Checklist trước, trong và sau khi chạy

### 13.1 Pre-run checklist

| # | Check | Command / Method | Expected | Nếu fail |
| --- | --- | --- | --- | --- |
| PR1 | Docker daemon đang chạy | `docker info` | Thông tin Docker | Khởi động Docker Desktop |
| PR2 | Stack `full-no-cdn` đã up | `docker ps --filter "name=nginx"` | Container nginx running | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2` |
| PR3 | Tất cả container healthy | `docker ps --format "{{.Names}} {{.Status}}"` | Tất cả "Up" | `docker-compose restart` hoặc check logs |
| PR4 | Route contract pass | `.\scripts\check-target-routing.ps1 -TargetLayer full-no-cdn` | PASS | Check Nginx config, reload nếu cần |
| PR5 | Fast lane trả về role=stable | `curl -s http://localhost:80/api/lb/isolation-fast-demo \| jq .role` | `"stable"` | Check origin container, app code |
| PR6 | Slow lane trả về role=slow | `curl -s http://localhost:80/api/lb/isolation-slow-demo \| jq .role` | `"slow"` | Check origin container, app code |
| PR7 | Slow lane thực sự chậm | `curl -w "Time: %{time_total}s" -s http://localhost:80/api/lb/isolation-slow-demo` | > 0.3s | Check slow origin delay config |
| PR8 | Không có X-Cache | `curl -sI http://localhost:80/api/lb/isolation-fast-demo \| grep -i x-cache` | No output | Đảm bảo profile `full-no-cdn`, không phải `full` |
| PR9 | Script inspect pass | `.\scripts\run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 11-saturation-isolation -InspectOnly` | Exit 0 | Sửa lỗi script hoặc config |
| PR10 | Không có process k6 cũ đang chạy | `Get-Process k6 -ErrorAction SilentlyContinue` | No output | `Stop-Process -Name k6 -Force` |

### 13.2 During-run checklist

| # | Check | Method | Expected |
| --- | --- | --- | --- |
| DR1 | k6 không báo `dropped_iterations` | Quan sát output trong lúc chạy | Không có warning về dropped iterations |
| DR2 | Cả hai scenario đều đang chạy | k6 progress bar hiển thị 2 scenario | Cả hai active |
| DR3 | Không có error log bất thường | Quan sát stderr | Không có exception hoặc connection error |
| DR4 | Iteration rate ổn định | `fast_lane: X iterations, ~25/s` | Gần đúng target rate |
| DR5 | Không có timeout error từ k6 | Output trong lúc chạy | Không có `request timed out` |

### 13.3 Post-run checklist

| # | Check | Method | Expected |
| --- | --- | --- | --- |
| PO1 | Exit code = 0 | Dòng cuối của output | `Exit code: 0` |
| PO2 | Checks rate = 100% | Output summary | `checks: 100.00%` |
| PO3 | HTTP failed = 0% cho cả hai endpoint | Output summary (endpoint-tagged) | `http_req_failed{endpoint:lb_isolation_fast_demo}: 0.00%` |
| PO4 | Fast lane p95 < 50ms | Output summary | `p(95)=<50` |
| PO5 | Slow lane p95 > 300ms | Output summary | `p(95)=>300` |
| PO6 | Tất cả threshold pass | k6 threshold section | Không có threshold nào màu đỏ (fail) |
| PO7 | Không có X-Cache trong bất kỳ sample response nào | Manual check hoặc custom metric | Vắng mặt |
| PO8 | Tất cả check assertions pass | Check list trong output | Tất cả có dấu ✓ |
| PO9 | Số lượng iteration hợp lý | fast: ~250 (± variance), slow: ~60-62 | Gần target: FAST_RATE * DURATION |
| PO10 | Lưu kết quả để so sánh sau | JSON export hoặc screenshot | Đã lưu |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Tăng slow rate để test isolation boundary

**Mục đích**: Xác định ngưỡng mà slow lane bắt đầu ảnh hưởng đến fast lane (nếu có).

```powershell
# Tăng SLOW_RATE từ 6 lên 20 req/s
$env:LB_ISOLATION_SLOW_RATE = "20"
$env:LB_ISOLATION_DURATION_SECONDS = "15"
.\scripts\run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 11-saturation-isolation
```

Kỳ vọng: Với `keepalive 8` cho slow pool, 20 req/s * 600ms = cần ~12 connection concurrent, nhưng pool chỉ có 8. Nếu isolation hoạt động đúng:
- Slow lane sẽ bắt đầu có queue/backpressure, nhưng chỉ trong slow pool
- Fast lane vẫn không bị ảnh hưởng (p95 < 50ms)

Nếu fast lane bắt đầu chậm khi slow rate tăng, điều này có thể chỉ ra resource contention ở tầng Nginx worker hoặc OS.

**Code thay đổi**: Không cần sửa script, chỉ cần env var override.

### Variation 2: Giảm fast rate để verify fast vẫn nhanh ở low load

**Mục đích**: Xác nhận fast lane performance không phụ thuộc vào load level.

```powershell
# Giảm FAST_RATE từ 25 xuống 5 req/s
$env:LB_ISOLATION_FAST_RATE = "5"
.\scripts\run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 11-saturation-isolation
```

Kỳ vọng: Fast lane p95 vẫn < 50ms, thậm chí còn thấp hơn (có thể < 5ms). Điều này xác nhận fast lane performance không bị ảnh hưởng bởi bất kỳ yếu tố nào ngoài chính nó.

### Variation 3: Thêm medium lane với pool thứ ba

**Mục đích**: Test isolation với 3 lane thay vì 2, mô phỏng môi trường production có nhiều service class.

```javascript
// Thêm vào script 11-saturation-isolation.js

const MEDIUM_RATE = envInt('LB_ISOLATION_MEDIUM_RATE', 12);
// Giả định có thêm location /api/lb/isolation-medium-demo
// và upstream lb_medium_backend

export const options = {
  scenarios: {
    fast_lane: {
      executor: 'constant-arrival-rate',
      rate: FAST_RATE,      // 25/s
      timeUnit: '1s',
      duration: `${DURATION_SECONDS}s`,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      exec: 'fastLane',
    },
    medium_lane: {           // ← THÊM
      executor: 'constant-arrival-rate',
      rate: MEDIUM_RATE,    // 12/s
      timeUnit: '1s',
      duration: `${DURATION_SECONDS}s`,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      exec: 'mediumLane',
    },
    slow_lane: {
      executor: 'constant-arrival-rate',
      rate: SLOW_RATE,      // 6/s
      timeUnit: '1s',
      duration: `${DURATION_SECONDS}s`,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      exec: 'slowLane',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    'http_req_failed{endpoint:lb_isolation_fast_demo}': ['rate==0'],
    'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],
    'http_req_failed{endpoint:lb_isolation_medium_demo}': ['rate==0'],      // ← THÊM
    'http_req_duration{endpoint:lb_isolation_medium_demo}': ['p(95)<150'],   // ← THÊM
    'http_req_failed{endpoint:lb_isolation_slow_demo}': ['rate==0'],
    'http_req_duration{endpoint:lb_isolation_slow_demo}': ['p(95)>300'],
  },
  tags: {
    scenario: 'lb_saturation_isolation_3lane',  // ← THAY ĐỔI
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};

export function mediumLane() {    // ← THÊM
  const api = lbCapabilityApis.isolationMediumDemo;
  const res = requestLB(api, {
    tags: { endpoint: api.name, lane: 'medium' },
  });
  assertLBResponse(res, api, 'lb isolation medium lane');
  check(res, {
    'lb isolation medium lane role medium': (r) => r.json('role') === 'medium',
  });
}
```

**Lưu ý**: Cần thêm Nginx config cho medium lane (location block + upstream block) và origin service tương ứng.

### Variation 4: Thay executor thành ramping-arrival-rate

**Mục đích**: Test isolation khi traffic thay đổi theo thời gian (ramp up/down).

```javascript
// Thay thế scenario definition

export const options = {
  scenarios: {
    fast_lane: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      stages: [
        { target: 5, duration: '5s' },    // Warm-up
        { target: 50, duration: '10s' },  // Ramp up
        { target: 50, duration: '10s' },  // Sustained high
        { target: 5, duration: '5s' },    // Ramp down
      ],
      preAllocatedVUs: 32,
      maxVUs: 64,
      exec: 'fastLane',
    },
    slow_lane: {
      executor: 'ramping-arrival-rate',
      startRate: 2,
      timeUnit: '1s',
      stages: [
        { target: 2, duration: '5s' },    // Warm-up
        { target: 15, duration: '10s' },  // Ramp up
        { target: 15, duration: '10s' },  // Sustained high
        { target: 2, duration: '5s' },    // Ramp down
      ],
      preAllocatedVUs: 32,
      maxVUs: 64,
      exec: 'slowLane',
    },
  },
  // thresholds giữ nguyên
};
```

Kỳ vọng: Fast lane p95 duy trì < 50ms trong suốt tất cả các giai đoạn, kể cả khi slow lane ramp up đến 15 req/s.

### Variation 5: Thêm custom metric `lb_isolation_crossover`

**Mục đích**: Phát hiện request bị route sai lane (fast request đi vào slow pool hoặc ngược lại).

```javascript
import { Trend, Counter } from 'k6/metrics';

// Custom metric để detect crossover
const lbIsolationCrossover = new Counter('lb_isolation_crossover');

export function fastLane() {
  const api = lbCapabilityApis.isolationFastDemo;
  const res = requestLB(api, {
    tags: { endpoint: api.name, lane: 'fast' },
  });

  assertLBResponse(res, api, 'lb isolation fast lane');

  // Phát hiện crossover: fast request mà upstream service là slow origin
  const upstreamService = res.headers['X-Upstream-Service'];
  if (upstreamService && upstreamService !== 'lb-stable-origin') {
    lbIsolationCrossover.add(1, { lane: 'fast', wrong_upstream: upstreamService });
  }

  check(res, {
    'lb isolation fast lane role stable': (r) => r.json('role') === 'stable',
    'lb isolation fast lane no crossover': (r) =>
      r.headers['X-Upstream-Service'] === 'lb-stable-origin',
  });
}

export function slowLane() {
  const api = lbCapabilityApis.isolationSlowDemo;
  const res = requestLB(api, {
    tags: { endpoint: api.name, lane: 'slow' },
  });

  assertLBResponse(res, api, 'lb isolation slow lane');

  // Phát hiện crossover: slow request mà upstream service là stable origin
  const upstreamService = res.headers['X-Upstream-Service'];
  if (upstreamService && upstreamService !== 'lb-slow-origin') {
    lbIsolationCrossover.add(1, { lane: 'slow', wrong_upstream: upstreamService });
  }

  check(res, {
    'lb isolation slow lane role slow': (r) => r.json('role') === 'slow',
    'lb isolation slow lane no crossover': (r) =>
      r.headers['X-Upstream-Service'] === 'lb-slow-origin',
  });
}

// Thêm threshold cho custom metric
export const options = {
  // ... scenarios giữ nguyên ...
  thresholds: {
    // ... thresholds hiện tại ...
    'lb_isolation_crossover': ['count==0'],  // Không được có bất kỳ crossover nào
  },
};
```

---

## 15. Anti-patterns

### AP1: Dùng aggregate p95 để kết luận

```text
❌ SAI:
  "http_req_duration p95 = 598ms → hệ thống đang chậm, cần optimize"

✅ ĐÚNG:
  "http_req_duration{endpoint:lb_isolation_fast_demo} p95 = 4.29ms → fast lane OK"
  "http_req_duration{endpoint:lb_isolation_slow_demo} p95 = 616ms → slow lane expected slow"
  "Kết luận: isolation hoạt động đúng"
```

**Hậu quả**: False alarm, scale up không cần thiết, hoặc bỏ qua vấn đề thực sự.

### AP2: Không tag endpoint trong thresholds

```text
❌ SAI:
  thresholds: {
    'http_req_duration': ['p(95)<50'],  // Áp dụng cho TẤT CẢ request
  }
  → Threshold này sẽ fail vì slow lane p95 = 600ms > 50ms
  → Không thể phân biệt được fast lane có vấn đề hay không

✅ ĐÚNG:
  thresholds: {
    'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],
    'http_req_duration{endpoint:lb_isolation_slow_demo}': ['p(95)>300'],
  }
```

**Hậu quả**: Threshold vô dụng -- hoặc quá chặt (fast lane pass nhưng báo fail vì slow lane), hoặc quá lỏng (bỏ lỡ vấn đề thực sự).

### AP3: Chạy sai profile (có CDN)

```text
❌ SAI:
  .\scripts\stack.ps1 -TargetLayer full    ← CÓ Varnish CDN
  .\scripts\run-lb-capabilities.ps1 -Profile full

✅ ĐÚNG:
  .\scripts\stack.ps1 -TargetLayer full-no-cdn
  .\scripts\run-lb-capabilities.ps1 -Profile full-no-cdn
```

**Hậu quả**: CDN cache response → latency cả hai lane đều thấp → không thể chứng minh isolation. Có `X-Cache: HIT` trong response.

### AP4: Quên check X-Cache absence

```text
❌ SAI:
  Chỉ assert status=200 và role, không check X-Cache
  → Có thể đang test CDN cache behavior thay vì LB isolation

✅ ĐÚNG:
  assertLBResponse() đã bao gồm check "no X-Cache"
  → Đảm bảo request thực sự đi đến origin qua LB
```

**Hậu quả**: Kết quả test không có giá trị cho LB layer -- bạn đang test CDN, không phải LB.

### AP5: Dùng chung connection pool cho cả hai lane

```nginx
# ❌ SAI: Cả hai location proxy_pass đến cùng một upstream
location = /api/lb/isolation-fast-demo {
    proxy_pass http://lb_shared_backend;   # ← Dùng chung!
}
location = /api/lb/isolation-slow-demo {
    proxy_pass http://lb_shared_backend;   # ← Dùng chung!
}

# ✅ ĐÚNG: Mỗi location có upstream riêng
location = /api/lb/isolation-fast-demo {
    proxy_pass http://lb_stable_backend;   # ← Pool riêng cho fast
}
location = /api/lb/isolation-slow-demo {
    proxy_pass http://lb_slow_backend;     # ← Pool riêng cho slow
}
```

**Hậu quả**: Không có isolation. Slow lane sẽ làm cạn connection pool chung, kéo chậm fast lane.

### AP6: Không set PRE_ALLOCATED_VUS đủ cao

```text
❌ SAI:
  PRE_ALLOCATED_VUS = 4  (cho mỗi scenario)
  → Tổng 8 VU, nhưng slow lane cần ~4 VU concurrent (6 req/s * 600ms)
  → Fast lane cần thêm VU cho 25 req/s (dù mỗi request nhanh)
  → Có thể dẫn đến dropped_iterations nếu không đủ VU

✅ ĐÚNG:
  PRE_ALLOCATED_VUS = 16 (cho mỗi scenario)
  → Tổng 32 VU, dư dả cho cả hai scenario
  → k6 không bị bottleneck bởi VU allocation
```

**Hậu quả**: `dropped_iterations` trong k6 output -- không phải lỗi isolation, mà là lỗi test configuration.

### AP7: Không có `resolve` trong upstream server directive

```nginx
# ❌ SAI trong môi trường Docker:
upstream lb_stable_backend {
    server lb-stable-origin:8090;    # ← Không có resolve
}

# ✅ ĐÚNG:
upstream lb_stable_backend {
    server lb-stable-origin:8090 resolve;  # ← Có resolve
}
```

**Hậu quả**: Nếu container restart và IP thay đổi, Nginx tiếp tục gửi request đến IP cũ → connection refused hoặc timeout.

### AP8: Không kiểm tra slow origin thực sự chậm trước khi chạy

```text
❌ SAI:
  Không verify slow lane latency trước khi chạy test
  → Chạy test, slow lane p95 = 10ms → threshold p(95)>300 FAIL
  → Mất thời gian debug tại sao test fail

✅ ĐÚNG:
  curl -w "Time: %{time_total}s" http://localhost:80/api/lb/isolation-slow-demo
  → Xác nhận > 0.3s trước khi chạy test chính thức
```

**Hậu quả**: Test fail không phải do isolation, mà do setup sai -- nhưng mất thời gian phân biệt.

---

## 16. Real validation data

### 16.1 Individual run -- default parameters

```text
============================================================
Environment:
  Profile: full-no-cdn
  FAST_RATE: 25 (default)
  SLOW_RATE: 6 (default)
  DURATION_SECONDS: 10 (default)
  PRE_ALLOCATED_VUS: 16 (default)
  MAX_VUS: 32 (default)
============================================================

Run results:
  Exit code: 0
  Checks: 1872/1872 (100.00%)
  HTTP failed: 0.00% (0/312)

  http_req_duration (aggregate):
    avg=132.45ms min=1.2ms med=8.5ms max=712.3ms p(90)=601.5ms p(95)=608.1ms

  http_req_duration{endpoint:lb_isolation_fast_demo}:
    avg=4.29ms  min=1.8ms med=3.9ms  max=18.2ms  p(90)=6.1ms  p(95)=8.1ms

  http_req_duration{endpoint:lb_isolation_slow_demo}:
    avg=589.73ms min=512.4ms med=587.2ms max=712.3ms p(90)=611.2ms p(95)=616.27ms

  http_req_failed: 0.00% (0/312)
    {endpoint:lb_isolation_fast_demo}: 0.00% (0/250)
    {endpoint:lb_isolation_slow_demo}: 0.00% (0/62)

  fast_lane iterations: 250 (25.00/s target)
  slow_lane iterations: 62 (6.20/s actual)

Thresholds:
  ✓ checks rate==1 (100.00%)
  ✓ http_req_failed{endpoint:lb_isolation_fast_demo} rate==0
  ✓ http_req_duration{endpoint:lb_isolation_fast_demo} p(95)=8.1ms < 50ms
  ✓ http_req_failed{endpoint:lb_isolation_slow_demo} rate==0
  ✓ http_req_duration{endpoint:lb_isolation_slow_demo} p(95)=616.27ms > 300ms

All checks passed:
  ✓ lb isolation fast lane role stable
  ✓ lb isolation slow lane role slow
  ✓ lb isolation fast demo status 200
  ✓ lb isolation fast demo X-Served-By nginx
  ✓ lb isolation fast demo X-Upstream-Service lb-stable-origin
  ✓ lb isolation fast demo X-Request-ID present
  ✓ lb isolation fast demo no X-Cache
  ✓ lb isolation slow demo status 200
  ✓ lb isolation slow demo X-Served-By nginx
  ✓ lb isolation slow demo X-Upstream-Service lb-slow-origin
  ✓ lb isolation slow demo X-Request-ID present
  ✓ lb isolation slow demo no X-Cache

Result: PASS ✓
```

### 16.2 Tuned full profile run

```text
============================================================
Environment:
  Profile: full-no-cdn (tuned -- all 12 cases chạy tuần tự)
  Các case khác đã được tune VU/duration trước đó
============================================================

Run results:
  Checks: 1866/1866 (100.00%)
  HTTP failed: 0.00% (0/311)

  http_req_duration{endpoint:lb_isolation_fast_demo}:
    avg=4.31ms  p(95)=8.3ms

  http_req_duration{endpoint:lb_isolation_slow_demo}:
    avg=591.12ms p(95)=618.5ms

Result: PASS ✓
```

Lưu ý: Số checks thấp hơn một chút so với individual run (1866 vs 1872) do variance trong số lượng iteration khi chạy trong batch lớn.

### 16.3 Phân tích con số

**Fast lane p95 ~4.29ms (individual) / ~4.31ms (tuned)**:

Con số này bao gồm:
- k6 → Nginx: ~0.1-0.3ms (localhost, loopback interface)
- Nginx xử lý (match location, chọn upstream, lấy connection): ~0.1-0.5ms
- Nginx → stable origin: ~0.5-1ms (Docker network)
- Origin xử lý: ~1-3ms (business logic tối thiểu, trả về JSON)
- Nginx → k6: ~0.1-0.3ms (Docker network)

Tổng: ~2-5ms, phù hợp với p95 = 4.29ms.

Con số này xác nhận:
1. Gateway overhead rất thấp (< 1ms)
2. Stable origin phản hồi nhanh
3. Connection pool fast không bị cạn (keepalive 16, chỉ cần 1-2 connection concurrent)
4. **Isolation hoạt động**: dù slow lane đang giữ 4-6 connection với thời gian 600ms/request, fast lane không hề bị ảnh hưởng

**Slow lane p95 ~616.27ms (individual) / ~618.5ms (tuned)**:

Con số này bao gồm:
- k6 → Nginx: ~0.1-0.3ms
- Nginx xử lý: ~0.1-0.5ms
- Nginx → slow origin: ~0.5-1ms (Docker network)
- **Origin delay có chủ đích: ~500-600ms** (sleep/delay logic)
- Origin xử lý thực tế: ~1-5ms
- Nginx → k6: ~0.1-0.3ms

Tổng: ~500-620ms, phù hợp với p95 = 616ms.

**Tỉ lệ fast/slow iteration: 250/62**:
- Fast: 25 req/s * 10s = 250 iterations (đúng target)
- Slow: 6 req/s * 10s = 60 iterations (thực tế 62, hơi cao hơn một chút do timing variance)
- Tổng request: 312

**HTTP failed = 0 cho cả hai lane**: Xác nhận không có request nào bị lỗi. Connection pool cho cả hai lane đều đủ capacity.

### 16.4 Ý nghĩa của kết quả

Kết quả này chứng minh ba điều:

1. **Isolation hoạt động**: Fast lane (p95=4.29ms) và slow lane (p95=616ms) có latency khác biệt ~140 lần, chứng tỏ hai pool hoạt động độc lập.

2. **Gateway overhead tối thiểu**: Nginx thêm < 1ms overhead cho mỗi request. Không có bottleneck ở tầng Gateway.

3. **Test design đúng**: Slow origin thực sự chậm (~600ms delay), đủ để tạo áp lực lên connection pool slow nhưng không ảnh hưởng đến pool fast.

---

## 17. Reference

### 17.1 Docs liên quan

| File | Mô tả |
| --- | --- |
| `./00_overview.md` | Tổng quan series LB/Gateway -- mental model, profile, key concepts |
| `./13_validation-and-chart-analysis.md` | Tổng hợp validation cho toàn bộ 12 LB capability cases |
| `./RUN_GUIDE.md` | Hướng dẫn chạy LB cases -- commands, env vars, troubleshooting |
| `../cdn/12_validation-and-chart-analysis.md` | Validation doc cho CDN layer -- tham khảo methodology |

### 17.2 Script và config

| File | Mô tả |
| --- | --- |
| `scripts/practice/lb/11-saturation-isolation.js` | Script k6 cho case này |
| `scripts/practice/lb/shared.js` | Shared utilities -- `requestLB()`, `assertLBResponse()`, `lbCapabilityApis` |
| `scripts/practice/shared/common.js` | Common utilities -- `envInt()` |
| Nginx config (runtime) | `nginx -T` hoặc file config trong container/volume |

### 17.3 Case catalog entry

```yaml
case_id: lb-11-saturation-isolation
topology: full-no-cdn
customMetrics: none
thresholdTags: endpoint-specific (fast vs slow)
runDefaults:
  FAST_RATE: 25
  SLOW_RATE: 6
  DURATION_SECONDS: 10
  PRE_ALLOCATED_VUS: 16
  MAX_VUS: 32
expectedSignals:
  - fast lane p95 low (< 50ms)
  - slow lane p95 high intentionally (> 300ms)
  - both lanes failed=0%
  - aggregate p95 misleading (do not use for conclusion)
```

### 17.4 Nginx documentation references

| Topic | Link / Reference |
| --- | --- |
| `upstream` directive | https://nginx.org/en/docs/http/ngx_http_upstream_module.html |
| `keepalive` directive | https://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive |
| `zone` directive | https://nginx.org/en/docs/http/ngx_http_upstream_module.html#zone |
| `proxy_pass` directive | https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass |
| `add_header` directive | https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header |
| `server resolve` parameter | https://nginx.org/en/docs/http/ngx_http_upstream_module.html#server |
| `max_fails` / `fail_timeout` | https://nginx.org/en/docs/http/ngx_http_upstream_module.html#max_fails |

### 17.5 k6 documentation references

| Topic | Link / Reference |
| --- | --- |
| `constant-arrival-rate` executor | https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/ |
| Thresholds with tags | https://grafana.com/docs/k6/latest/using-k6/thresholds/ |
| URL grouping / tags | https://grafana.com/docs/k6/latest/using-k6/tags-and-groups/ |
| `check` function | https://grafana.com/docs/k6/latest/javascript-api/k6/check/ |

---

## 18. Deep-dive: constant-arrival-rate executor

### 18.1 Tại sao chọn constant-arrival-rate

Case 11 sử dụng `constant-arrival-rate` executor cho cả hai scenario. Đây không phải là lựa chọn ngẫu nhiên -- nó được chọn vì những lý do cụ thể liên quan đến bản chất của bài toán isolation.

**Đặc tính của constant-arrival-rate**:

```text
constant-arrival-rate:
  - Gửi request với một TẦN SUẤT CỐ ĐỊNH (rate)
  - Không phụ thuộc vào thời gian response
  - Số lượng VU được điều chỉnh tự động để đạt target rate
  - Nếu không đủ VU, iteration bị drop (dropped_iterations)
```

**Tại sao phù hợp với case isolation**:

| Yêu cầu của case | constant-arrival-rate đáp ứng thế nào |
| --- | --- |
| Tạo áp lực liên tục lên connection pool | Gửi request với rate cố định, bất kể response time |
| Slow lane vẫn phải nhận 6 req/s dù mỗi request mất 600ms | Executor tự động cấp thêm VU để duy trì 6 req/s |
| Fast lane 25 req/s không bị gián đoạn | Rate được duy trì độc lập với slow lane |
| Có thể so sánh latency giữa hai lane | Cả hai lane có arrival pattern nhất quán (constant rate) |

### 18.2 So sánh với các executor khác

| Executor | Cách hoạt động | Phù hợp cho case 11? | Lý do |
| --- | --- | --- | --- |
| `constant-arrival-rate` | Gửi N request/giây, tự động điều chỉnh VU | **CÓ (đang dùng)** | Đảm bảo áp lực liên tục, rate cố định, VU tự động scale |
| `constant-vus` | N VU chạy liên tục, request tiếp theo chỉ gửi khi request trước hoàn thành | **KHÔNG** | Slow lane: 4 VU, mỗi request 600ms → rate = 4/0.6 = 6.67 req/s. Nhưng nếu response time thay đổi (ví dụ origin chậm hơn), rate giảm theo → không kiểm soát được áp lực |
| `shared-iterations` | Tổng số iteration chia đều cho VU | **KHÔNG** | Không duy trì rate ổn định. VU chạy hết iteration rồi dừng. Không phù hợp để test isolation dưới áp lực liên tục |
| `ramping-arrival-rate` | Rate thay đổi theo stages | **CÓ THỂ (variation)** | Hữu ích để test isolation khi traffic thay đổi. Nhưng cho case cơ bản, constant rate đơn giản và đủ mạnh |
| `per-vu-iterations` | Mỗi VU chạy N iteration | **KHÔNG** | Không kiểm soát được arrival pattern. VU nhanh hoàn thành trước, VU chậm hoàn thành sau |
| `externally-controlled` | Điều khiển từ bên ngoài qua API | **KHÔNG** | Quá phức tạp cho case này, cần external controller |

### 18.3 Cách constant-arrival-rate quản lý VU

```text
Scenario: fast_lane, rate=25/s, preAllocatedVUs=16, maxVUs=32

1. Khi test bắt đầu, k6 cấp 16 VU (preAllocatedVUs)
2. k6 tính toán: 25 req/s * ~5ms/request = cần ~1 VU concurrent
   → 16 VU là dư dả, VU sẽ ở trạng thái idle phần lớn thời gian
3. K6 gửi request với rate 25/s (mỗi 40ms một request)
4. Nếu có spike latency (ví dụ GC pause), k6 dùng thêm VU để duy trì rate
5. Nếu cần > 32 VU (maxVUs) mà vẫn không đạt rate → dropped_iterations

Scenario: slow_lane, rate=6/s, preAllocatedVUs=16, maxVUs=32

1. Khi test bắt đầu, k6 cấp 16 VU (preAllocatedVUs)
2. k6 tính toán: 6 req/s * ~600ms/request = cần ~4 VU concurrent
   → 16 VU là dư dả
3. K6 gửi request với rate 6/s (mỗi ~167ms một request)
4. Mỗi VU bận ~600ms cho một request, nhưng vì có 16 VU,
   k6 luân phiên dùng VU khác nhau để duy trì rate
5. Concurrent VU thực tế: ~4 (đúng như tính toán)
```

### 18.4 Mối quan hệ giữa rate, VU, và response time

Công thức Little's Law áp dụng cho k6 scenario:

```text
Concurrent VUs cần thiết = Arrival Rate × Average Response Time

Fast lane: 25 req/s × 0.005s = 0.125 VU (về lý thuyết)
           → Thực tế cần thêm buffer cho variance → 1-2 VU

Slow lane: 6 req/s × 0.6s = 3.6 VU
           → Thực tế cần ~4-5 VU cho variance

Tổng: ~5-7 VU concurrent cho cả hai scenario
Với preAllocatedVUs=16 mỗi scenario (tổng 32), dư dả rất nhiều
```

Điều này có nghĩa là test không bị giới hạn bởi VU -- bất kỳ vấn đề về latency đều đến từ Gateway/origin, không phải từ k6.

### 18.5 Khi nào constant-arrival-rate không phù hợp

| Tình huống | Vấn đề | Giải pháp thay thế |
| --- | --- | --- |
| Cần test với số lượng VU cố định (giả lập N user thật) | constant-arrival-rate tự động điều chỉnh VU → không giả lập được user behavior | `constant-vus` |
| Cần test pattern truy cập không đều (burst, think time) | Constant rate không mô phỏng được user behavior thực tế | `ramping-arrival-rate` với stages, hoặc custom executor |
| Hệ thống có cơ chế rate limiting phức tạp | Constant rate có thể trigger rate limit và làm sai lệch kết quả | Giảm rate, hoặc dùng `constant-vus` với delay |

---

## 19. Deep-dive: k6 threshold tag filtering

### 19.1 Cú pháp tag filter trong thresholds

k6 cho phép lọc metric theo tag bằng cú pháp `metric_name{tag_key:tag_value}`:

```javascript
thresholds: {
    // Threshold cho TẤT CẢ request (không filter)
    'http_req_duration': ['p(95)<1000'],

    // Threshold CHỈ cho request có tag endpoint=lb_isolation_fast_demo
    'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],

    // Threshold CHỈ cho request có tag endpoint=lb_isolation_slow_demo
    'http_req_duration{endpoint:lb_isolation_slow_demo}': ['p(95)>300'],

    // Threshold cho request có tag lane=fast (filter theo tag lane thay vì endpoint)
    'http_req_failed{lane:fast}': ['rate==0'],
}
```

### 19.2 Cách tag được gán trong script này

Tags được gán qua tham số thứ hai của `requestLB()`:

```javascript
const res = requestLB(api, {
    tags: {
        endpoint: api.name,    // 'lb_isolation_fast_demo' hoặc 'lb_isolation_slow_demo'
        lane: 'fast',          // 'fast' hoặc 'slow'
    },
});
```

`requestLB()` (từ shared.js) truyền tags này vào `http.get()` hoặc `http.post()` của k6. k6 tự động gán tags cho tất cả metric liên quan đến request đó: `http_req_duration`, `http_req_failed`, `http_req_sending`, `http_req_waiting`, `http_req_receiving`, `http_req_connecting`, `http_req_tls_handshaking`, `http_req_blocked`, v.v.

### 19.3 Tại sao endpoint-tagged threshold quan trọng cho case này

Nếu không có tag filter, threshold sẽ áp dụng cho **tất cả** request:

```javascript
// SAI -- threshold này áp dụng cho cả fast và slow request
thresholds: {
    'http_req_duration': ['p(95)<50'],
}
// → Slow lane p95=616ms > 50ms → threshold FAIL
// → Nhưng đây không phải lỗi! Slow lane expected slow!
```

Với tag filter, mỗi endpoint có threshold riêng:

```javascript
// ĐÚNG -- mỗi endpoint có expectation riêng
thresholds: {
    'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],
    'http_req_duration{endpoint:lb_isolation_slow_demo}': ['p(95)>300'],
}
// → Fast p95=4.29ms < 50ms → PASS
// → Slow p95=616ms > 300ms → PASS
```

### 19.4 Các tag được dùng trong case

| Tag key | Tag value | Gán ở đâu | Dùng để filter gì |
| --- | --- | --- | --- |
| `endpoint` | `lb_isolation_fast_demo` | `requestLB()` tags | Threshold cho fast lane latency và failed rate |
| `endpoint` | `lb_isolation_slow_demo` | `requestLB()` tags | Threshold cho slow lane latency và failed rate |
| `lane` | `fast` | `requestLB()` tags | Dashboard grouping, manual analysis |
| `lane` | `slow` | `requestLB()` tags | Dashboard grouping, manual analysis |
| `scenario` | `lb_saturation_isolation` | `options.tags` | Global tag cho toàn bộ test |
| `target_layer` | `lb` | `options.tags` | Phân loại layer |
| `lb_profile` | `full-no-cdn` | `options.tags` | Phân loại profile |

### 19.5 Tag inheritance và scope

Trong k6, tags có cơ chế kế thừa:

```text
options.tags (global)
  └── Được merge vào TẤT CẢ metric trong test
  └── Nhưng có thể bị override bởi request-level tags

request tags (từ requestLB)
  └── Chỉ áp dụng cho metric của request đó
  └── Có thể override global tags nếu trùng key
```

Trong case này:
- Global tags (`scenario`, `target_layer`, `lb_profile`) xuất hiện trong tất cả metric
- Request tags (`endpoint`, `lane`) chỉ xuất hiện trong metric của request tương ứng
- Nếu request tag trùng key với global tag, request tag thắng

### 19.6 Lọc metric trong output

k6 tự động hiển thị tag-filtered metrics trong output nếu có thresholds định nghĩa với tag filter:

```text
http_req_duration............: avg=132.45ms p(95)=598.21ms       ← Tất cả
  { endpoint:lb_isolation_fast_demo }: avg=4.29ms  p(95)=8.12ms   ← Filtered
  { endpoint:lb_isolation_slow_demo }: avg=589.73ms p(95)=616.27ms ← Filtered
```

k6 chỉ tự động hiển thị sub-metrics cho các tag values mà **có threshold định nghĩa**. Nếu bạn muốn xem sub-metric cho `lane` tag, bạn cần định nghĩa threshold với `{lane:fast}` hoặc dùng `--summary-trend-stats` flag.

---

## 20. Deep-dive: connection pooling isolation

### 20.1 Connection pooling trong Nginx

Nginx duy trì một pool các connection keep-alive đến mỗi upstream backend. Đây là cơ chế quan trọng để giảm latency và overhead:

```text
Không có keepalive (mỗi request mở connection mới):
  k6 → Nginx → [mở TCP connection đến origin] → [gửi request] →
  [nhận response] → [đóng TCP connection]
  Overhead: TCP 3-way handshake (~1-3ms), TLS handshake (nếu có, ~5-50ms)

Có keepalive (tái sử dụng connection):
  k6 → Nginx → [lấy connection từ pool] → [gửi request] →
  [nhận response] → [trả connection về pool]
  Overhead: gần như 0 (connection đã được thiết lập sẵn)
```

### 20.2 Cấu trúc connection pool

```text
upstream lb_stable_backend {
    keepalive 16;  ← Số connection keep-alive TỐI ĐA đến upstream này
}

upstream lb_slow_backend {
    keepalive 8;   ← Số connection keep-alive TỐI ĐA đến upstream này
}
```

`keepalive` không phải là số connection tối đa -- Nginx có thể mở nhiều hơn nếu cần. `keepalive` chỉ định số connection được **giữ lại** (không đóng) sau khi request hoàn thành, để tái sử dụng cho request tiếp theo. Connection vượt quá `keepalive` sẽ bị đóng sau khi dùng xong.

```text
Ví dụ: lb_stable_backend, keepalive 16

Tại thời điểm t:
  - 3 connection đang occupied (đang phục vụ request)
  - 13 connection idle (trong pool, sẵn sàng tái sử dụng)
  → Tổng 16 connection đang mở

Request mới đến:
  → Lấy 1 connection idle từ pool (còn 12 idle)
  → Dùng xong → trả về pool (lại có 13 idle)

Nếu có 17 request đồng thời:
  → 16 request dùng 16 connection hiện có
  → Request thứ 17 mở connection mới (thứ 17)
  → Connection thứ 17 bị đóng sau khi dùng xong (vượt keepalive)
```

### 20.3 Tại sao pool isolation quan trọng

Hãy tưởng tượng nếu cả hai lane dùng chung một pool với `keepalive 24`:

```text
Shared pool, keepalive 24:

Tại giây thứ 5 của test:
  Fast lane: 25 req/s, mỗi request 5ms → ~1 connection occupied (luân chuyển nhanh)
  Slow lane: 6 req/s, mỗi request 600ms → ~4 connections occupied (giữ lâu)
  → Tổng: ~5 connections occupied, 19 idle → VẪN ỔN

Tại giây thứ 10:
  Fast lane: vẫn ~1 connection occupied
  Slow lane: 6 req/s × 600ms = 3.6 concurrent → nhưng do connection bị giữ,
    các request trước chưa trả connection về pool kịp
  → Bắt đầu tích lũy: 4 → 5 → 6 → 7 connections occupied
  → 24 - 7 = 17 idle → VẪN ỔN

Tại giây thứ 20 (nếu test kéo dài):
  Slow lane đã gửi 120 request, mỗi request 600ms
  → Nếu rate 6/s ổn định, concurrent = 6 × 0.6 = 3.6 → không tăng thêm
  → Pool vẫn ổn với keepalive 24
```

Trong ví dụ trên, shared pool với `keepalive 24` vẫn đủ cho cả hai lane ở rate hiện tại. Nhưng vấn đề xảy ra khi:
- Slow rate tăng (ví dụ 20 req/s → cần 12 concurrent connections)
- Slow response time tăng (ví dụ 2000ms → cần 40 concurrent connections)
- Fast rate tăng (ví dụ 100 req/s)
- Có thêm service khác dùng chung pool

Với pool riêng, mỗi pool chỉ cần đủ capacity cho lane của nó. Slow lane có thể tăng đến 50 req/s mà không ảnh hưởng đến fast lane.

### 20.4 Connection pool metrics

Để giám sát connection pool trong production, Nginx cung cấp các trạng thái qua stub_status hoặc API:

```text
Active connections: 45
server accepts handled requests
 12500 12500 250000
Reading: 2 Writing: 38 Waiting: 5
```

Tuy nhiên, stub_status không phân biệt được connection thuộc pool nào. Để giám sát chi tiết hơn, cần dùng Nginx Plus (có upstream-level metrics) hoặc custom monitoring qua access log + tag.

---

## 21. Deep-dive: Nginx upstream zone và shared memory

### 21.1 Zone là gì

```nginx
upstream lb_stable_backend {
    zone upstream_lb_stable 64k;
    server lb-stable-origin:8090 resolve max_fails=3 fail_timeout=5s;
    keepalive 16;
}

upstream lb_slow_backend {
    zone upstream_lb_slow 64k;
    server lb-slow-origin:8090 resolve max_fails=1 fail_timeout=5s;
    keepalive 8;
}
```

`zone` directive trong `upstream` block định nghĩa một vùng shared memory để lưu trữ runtime state của upstream group. Mỗi zone có tên và kích thước riêng.

### 21.2 Zone lưu trữ những gì

Trong shared memory zone, Nginx lưu trữ cho mỗi upstream peer:

| Dữ liệu | Mô tả | Dùng cho |
| --- | --- | --- |
| Peer address và port | Địa chỉ IP:port của backend | Kết nối đến backend |
| Current state | `up`, `down`, `unavailable`, `checking` | Quyết định có route request đến peer không |
| Fail count | Số lần fail liên tiếp | `max_fails` check |
| Last fail time | Thời điểm fail gần nhất | `fail_timeout` check |
| Weight | Trọng số cho weighted load balancing | Tính toán phân phối request |
| Current connections | Số connection đang active đến peer này | `least_conn` balancing |
| Response time (nếu có health check) | Latency trung bình | `least_time` balancing |
| DNS resolved addresses | Cache của DNS resolution | Kết nối đến IP đúng |

### 21.3 Tại sao mỗi upstream cần zone riêng

Nếu hai upstream dùng chung zone, state của chúng sẽ bị trộn lẫn:

```nginx
# SAI -- cả hai upstream dùng chung zone name
upstream lb_stable_backend {
    zone upstream_shared 64k;  # ← Tên zone "upstream_shared"
    server lb-stable-origin:8090;
}
upstream lb_slow_backend {
    zone upstream_shared 64k;  # ← CÙNG tên zone!
    server lb-slow-origin:8090;
}
# → Nginx sẽ báo lỗi: duplicate zone name
# → HOẶC nếu không báo lỗi, state của hai pool bị merge → sai hoàn toàn
```

Với zone riêng (`upstream_lb_stable` và `upstream_lb_slow`), state của mỗi pool được lưu trữ và quản lý độc lập.

### 21.4 Zone size (64k)

Kích thước 64KB cho mỗi zone là đủ cho:
- Lưu trữ state của vài chục peer
- DNS cache cho mỗi peer
- Counter cho load balancing

Nếu có nhiều peer (> 50), cần tăng zone size. Công thức ước lượng: ~1KB/peer cho state cơ bản, thêm buffer cho DNS cache và counters.

### 21.5 Zone và worker process

Trong Nginx multi-worker, zone dùng shared memory (mmap) để tất cả worker process có thể đọc/ghi cùng một state:

```text
Worker 1 ──┐
            ├──► Shared Memory Zone "upstream_lb_stable" (64KB)
Worker 2 ──┤      ├── peer: lb-stable-origin:8090
            │      │   state: up
Worker 3 ──┘      │   fail_count: 0
                   │   current_conns: 3
                   └── ...
```

Nhờ shared memory, khi một worker phát hiện backend fail (và tăng fail_count), tất cả worker khác đều thấy state mới ngay lập tức. Điều này đảm bảo passive health check hoạt động nhất quán trên tất cả worker.

---

## 22. Deep-dive: Docker DNS resolution

### 22.1 Tại sao DNS resolution quan trọng

Trong môi trường Docker, địa chỉ IP của container có thể thay đổi khi:
- Container restart
- Container được recreate (docker-compose up --force-recreate)
- Service scale up/down (với Docker Swarm)
- Network thay đổi

Nếu Nginx cache IP của upstream backend vĩnh viễn, khi IP thay đổi, Nginx sẽ gửi request đến IP cũ (có thể không còn tồn tại) → connection refused.

### 22.2 Cấu hình resolver trong Nginx

```nginx
resolver 127.0.0.11 valid=5s;
```

| Tham số | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `resolver` | `127.0.0.11` | Địa chỉ Docker embedded DNS server |
| `valid` | `5s` | Thời gian cache DNS result. Sau 5 giây, Nginx resolve lại |

`127.0.0.11` là địa chỉ loopback đặc biệt mà Docker daemon lắng nghe để phục vụ DNS resolution cho tất cả container trong Docker network.

### 22.3 `resolve` parameter trong server directive

```nginx
server lb-stable-origin:8090 resolve max_fails=3 fail_timeout=5s;
#                            ^^^^^^^
#                            Cho phép Nginx resolve DNS name này động
```

Nếu không có `resolve`:

```nginx
server lb-stable-origin:8090 max_fails=3 fail_timeout=5s;
#                            ^^^ không có resolve
# → Nginx resolve DNS name MỘT LẦN khi start/reload
# → IP được cache vĩnh viễn
# → Nếu container restart, Nginx vẫn dùng IP cũ → fail
```

Với `resolve`, Nginx sẽ:
1. Resolve DNS name khi start/reload
2. Dùng IP đã resolve để kết nối
3. Sau `valid=5s`, nếu cần kết nối mới, resolve lại DNS name
4. Nếu IP thay đổi, Nginx tự động dùng IP mới

### 22.4 DNS resolution flow

```text
1. Nginx start/reload
   → Resolve "lb-stable-origin" qua 127.0.0.11:53
   → Docker DNS trả về: 172.20.0.5
   → Cache IP này trong 5 giây

2. Request đầu tiên đến upstream
   → Nginx kết nối đến 172.20.0.5:8090
   → OK

3. Container "lb-stable-origin" restart
   → IP mới: 172.20.0.12

4. Sau 5 giây từ lần resolve trước, cache hết hạn
   → Request tiếp theo: Nginx resolve lại "lb-stable-origin"
   → Docker DNS trả về: 172.20.0.12 (IP mới)
   → Nginx kết nối đến IP mới
   → OK (không fail!)

5. Trong thời gian cache còn hiệu lực (< 5s từ restart)
   → Nginx vẫn dùng IP cũ 172.20.0.5
   → Connection refused (IP cũ không còn tồn tại)
   → Đây là failover scenario (case 06)
```

### 22.5 Trade-off của `valid` value

| `valid` | Ưu điểm | Nhược điểm |
| --- | --- | --- |
| Ngắn (1-2s) | Phát hiện IP change nhanh, ít downtime khi container restart | Nhiều DNS query hơn → tăng load lên Docker DNS |
| Dài (30-60s) | Ít DNS query, giảm load hệ thống | Chậm phát hiện IP change, downtime dài hơn khi container restart |
| `5s` (đang dùng) | Cân bằng tốt giữa responsiveness và load | Phù hợp cho môi trường development/test |

Trong production với Kubernetes, DNS resolution thường được xử lý bởi CoreDNS và có cơ chế phức tạp hơn (headless service, pod DNS, etc.).

---

## 23. Hướng dẫn đọc output chi tiết

### 23.1 Cấu trúc output của k6

Output của k6 khi chạy case 11 có cấu trúc sau:

```text
1. Scenario validation                  ← k6 kiểm tra scenario config
2. Execution progress bar               ← Hiển thị tiến độ chạy
3. Checks summary                       ← Danh sách checks và kết quả
4. Metric summary                       ← Tổng hợp tất cả metric
5. Threshold summary                    ← Kết quả threshold pass/fail
6. Exit code                            ← 0 = pass, khác 0 = fail
```

### 23.2 Đọc checks summary

```text
✓ lb isolation fast lane role stable
✓ lb isolation slow lane role slow
✓ lb isolation fast demo status 200
✓ lb isolation fast demo X-Served-By nginx
✓ lb isolation fast demo X-Upstream-Service lb-stable-origin
✓ lb isolation fast demo X-Request-ID present
✓ lb isolation fast demo no X-Cache
✓ lb isolation slow demo status 200
✓ lb isolation slow demo X-Served-By nginx
✓ lb isolation slow demo X-Upstream-Service lb-slow-origin
✓ lb isolation slow demo X-Request-ID present
✓ lb isolation slow demo no X-Cache
```

Mỗi dòng:
- `✓` = check pass
- `✗` = check fail (nếu có)
- Tên check được đặt trong `check()` function call
- Số lượng pass/fail được tổng hợp: `checks: 1872/1872 (100.00%)`

Nếu có check fail, output sẽ hiển thị chi tiết:

```text
✗ lb isolation fast lane role stable
  → expected: 'stable', got: 'slow'     ← Ví dụ: route sai pool
```

### 23.3 Đọc metric summary -- aggregate vs filtered

```text
http_req_duration............: avg=132.45ms min=1.2ms med=8.5ms max=712.3ms p(90)=601.5ms p(95)=608.1ms
  { endpoint:lb_isolation_fast_demo }: avg=4.29ms  min=1.8ms med=3.9ms  max=18.2ms  p(90)=6.1ms  p(95)=8.1ms
  { endpoint:lb_isolation_slow_demo }: avg=589.73ms min=512.4ms med=587.2ms max=712.3ms p(90)=611.2ms p(95)=616.27ms
```

Cách đọc:
1. **Dòng 1** (`http_req_duration`): Aggregate cho **tất cả** request. Có ích để biết overall picture, nhưng **KHÔNG dùng để kết luận**.
2. **Dòng 2** (`{endpoint:lb_isolation_fast_demo}`): Chỉ fast lane request. **Đây là dòng quan trọng cho fast lane.**
3. **Dòng 3** (`{endpoint:lb_isolation_slow_demo}`): Chỉ slow lane request. **Đây là dòng quan trọng cho slow lane.**

Các giá trị thống kê:
- `avg`: Trung bình -- hữu ích cho overall trend
- `min`/`max`: Min/max -- phát hiện outlier
- `med` (median/p50): 50% request nhanh hơn giá trị này
- `p(90)`: 90% request nhanh hơn giá trị này
- `p(95)`: 95% request nhanh hơn giá trị này -- **Ngưỡng chính cho threshold**

### 23.4 Đọc http_req_failed

```text
http_req_failed..............: 0.00%  (0/312)
  { endpoint:lb_isolation_fast_demo }: 0.00% (0/250)
  { endpoint:lb_isolation_slow_demo }: 0.00% (0/62)
```

- `0.00%` = tỉ lệ fail
- `(0/312)` = 0 request fail trên tổng số 312 request
- Nếu có request fail, tỉ lệ > 0% và threshold `rate==0` sẽ fail

**Lưu ý**: `http_req_failed` trong k6 bao gồm:
- HTTP status >= 400 (client error hoặc server error)
- Connection error (timeout, refused, reset)
- DNS resolution error
- TLS error

### 23.5 Đọc scenario iterations

```text
fast_lane_scenario...........: 250 iterations, 25.00/s
slow_lane_scenario...........: 62 iterations, 6.20/s
```

- `250 iterations` = số lần `fastLane()` được gọi
- `25.00/s` = actual rate đạt được (target là 25/s)
- `62 iterations` = số lần `slowLane()` được gọi (target là 60 = 6/s * 10s)
- `6.20/s` = actual rate (hơi cao hơn target 6/s do timing variance)

Nếu actual rate thấp hơn nhiều so với target, có thể do:
- Không đủ VU → `dropped_iterations`
- Response time quá lâu → VU bị block
- Network issue → connection chậm

### 23.6 Đọc threshold summary

```text
✓ checks........................: rate==1 (100.00%)
✓ http_req_failed{endpoint:lb_isolation_fast_demo}: rate==0
✓ http_req_duration{endpoint:lb_isolation_fast_demo}: p(95)=8.12ms (< 50ms)
✓ http_req_failed{endpoint:lb_isolation_slow_demo}: rate==0
✓ http_req_duration{endpoint:lb_isolation_slow_demo}: p(95)=616.27ms (> 300ms)
```

- `✓` = threshold pass (giá trị thực tế nằm trong ngưỡng cho phép)
- `✗` = threshold fail (giá trị thực tế vượt ngưỡng)
- Mỗi dòng hiển thị: metric name, threshold expression, actual value, và (so sánh với ngưỡng)

Nếu threshold fail, output sẽ có màu đỏ (trên terminal) và exit code != 0.

### 23.7 Exit code

```text
Exit code: 0
```

- `0` = tất cả threshold pass
- `99` = một hoặc nhiều threshold fail (k6 default)
- `108` = không có threshold nào được định nghĩa (k6 default, nhưng case này luôn có threshold)

Exit code rất quan trọng cho CI/CD pipeline -- nếu exit code != 0, pipeline nên fail.

---

## 24. So sánh kiến trúc: isolation vs no-isolation

### 24.1 Bảng so sánh tổng quan

| Khía cạnh | Có isolation (case này) | Không có isolation (shared pool) |
| --- | --- | --- |
| **Số upstream block** | 2+ (mỗi service class một block) | 1 (tất cả dùng chung) |
| **Số connection pool** | 2+ pool riêng biệt | 1 pool chung |
| **Health check policy** | Mỗi pool có `max_fails` và `fail_timeout` riêng | Một policy cho tất cả |
| **Connection limit** | Mỗi pool có `keepalive` riêng | Một giới hạn cho tất cả |
| **Timeout policy** | Mỗi pool có thể có `proxy_read_timeout` riêng | Một timeout cho tất cả |
| **Rate limit** | Có thể áp dụng rate limit riêng cho từng pool | Rate limit chung |
| **Slow service impact** | Chỉ ảnh hưởng pool của nó | Ảnh hưởng tất cả service |
| **Cascading failure risk** | THẤP -- failure cô lập trong pool | CAO -- failure lan truyền |

### 24.2 Kiến trúc no-isolation

```text
                    ┌─────────────────────────┐
                    │      Nginx Gateway       │
                    │                          │
  GET /search  ────►│                          │
  POST /cart   ────►│   location blocks khác    │
  GET /report  ────►│   nhau nhưng CÙNG         │──► lb_shared_backend
  GET /inventory──►│   proxy_pass đến          │    (keepalive 64)
                    │   lb_shared_backend       │    ↓
                    │                          │    search-svc:8090
                    │                          │    cart-svc:8090
                    │                          │    report-svc:8090
                    │                          │    inventory-svc:8090
                    └─────────────────────────┘

  Vấn đề: Connection pool CHUNG
  - Nếu report-svc chậm (giữ connection 5s), 10 user report →
    10 connection bị chiếm
  - Nếu inventory-svc cũng chậm (giữ connection 3s), 5 user →
    5 connection bị chiếm
  - Tổng: 15/64 connection bị chiếm → vẫn ổn

  Nhưng khi traffic tăng:
  - 50 user report + 20 user inventory → 50 + 20 = 70 connection cần
  - Pool chỉ có 64 → 6 request phải chờ
  - Trong số đó có search và cart request (lẽ ra nhanh) cũng phải chờ!
```

### 24.3 Kiến trúc có isolation

```text
                    ┌─────────────────────────┐
                    │      Nginx Gateway       │
                    │                          │
  GET /search  ────►│  proxy_pass →             │──► lb_fast_backend
  POST /cart   ────►│  lb_fast_backend          │    (keepalive 32)
                    │                           │    ↓
                    │                           │    search-svc:8090
                    │                           │    cart-svc:8090
                    │                           │
  GET /report  ────►│  proxy_pass →             │──► lb_slow_backend
                    │  lb_slow_backend           │    (keepalive 16)
                    │                           │    ↓
                    │                           │    report-svc:8090
                    │                           │
  GET /inventory──►│  proxy_pass →             │──► lb_external_backend
                    │  lb_external_backend       │    (keepalive 64)
                    │                           │    ↓
                    │                           │    inventory-svc:8090
                    └─────────────────────────┘

  Ưu điểm:
  - 50 user report → chiếm 16 connection trong lb_slow_backend pool
    → Pool này cạn → request report mới bị queue/reject
  - Search và cart: lb_fast_backend pool (32 connection)
    → KHÔNG BỊ ẢNH HƯỞNG
  - Inventory: lb_external_backend pool (64 connection)
    → KHÔNG BỊ ẢNH HƯỞNG
```

### 24.4 Chi phí của isolation

Isolation không miễn phí:

| Chi phí | Mô tả | Cách giảm thiểu |
| --- | --- | --- |
| **Cấu hình phức tạp hơn** | Nhiều upstream block, nhiều location block, nhiều tham số cần tune | Dùng template/script để generate config |
| **Tốn nhiều connection hơn** | Mỗi pool có keepalive riêng → tổng connection có thể nhiều hơn shared pool | Điều chỉnh keepalive dựa trên actual usage |
| **Tốn shared memory hơn** | Mỗi pool cần zone riêng → tổng memory cho zone tăng | Zone size 64K là đủ cho hầu hết use case |
| **Khó giám sát hơn** | Phải giám sát nhiều pool riêng biệt | Dùng Nginx Plus hoặc custom metrics export |
| **DNS resolution nhiều hơn** | Mỗi pool resolve DNS riêng | Tăng `valid` time nếu IP ổn định |

Tuy nhiên, chi phí này là **xứng đáng** so với rủi ro cascading failure khi không có isolation. Trong bất kỳ hệ thống production nào có nhiều service class, isolation là bắt buộc.

### 24.5 Khi nào isolation KHÔNG cần thiết

| Tình huống | Lý do |
| --- | --- |
| Tất cả service có cùng đặc tính hiệu năng (cùng latency profile) | Không có service nào chậm hơn service khác → không cần cô lập |
| Hệ thống quá nhỏ (< 3 service) | Overhead của isolation không đáng kể, nhưng cũng không cần thiết |
| Đã có circuit breaker ở application level | Application đã tự bảo vệ khỏi cascading failure |
| Dùng service mesh (Istio, Linkerd) | Service mesh xử lý isolation ở tầng sidecar proxy |
| Môi trường development | Chỉ có một developer, không có traffic thật |

---

## 25. Troubleshooting guide

### Problem 1: Fast lane p95 > 50ms nhưng slow lane p95 > 300ms

**Triệu chứng**: Cả hai lane đều chậm, nhưng slow lane vẫn chậm hơn fast lane.

**Nguyên nhân có thể**:
1. **Shared connection pool**: Cả hai location proxy_pass đến cùng một upstream block
2. **Nginx worker overload**: Số lượng worker_connections không đủ
3. **Resource contention**: CPU hoặc memory của Nginx container bị giới hạn
4. **Network bottleneck**: Docker network bridge bị bão hòa

**Cách debug**:

```powershell
# 1. Kiểm tra Nginx config runtime
docker exec nginx nginx -T | grep -A5 "upstream lb_"
# Xác nhận có HAI upstream block riêng biệt

# 2. Kiểm tra proxy_pass trong location blocks
docker exec nginx nginx -T | grep -B2 -A5 "isolation-fast-demo\|isolation-slow-demo"
# Xác nhận mỗi location proxy_pass đến upstream khác nhau

# 3. Kiểm tra resource usage
docker stats nginx --no-stream

# 4. Kiểm tra Nginx error log
docker logs nginx 2>&1 | tail -50

# 5. Kiểm tra worker_connections
docker exec nginx nginx -T | grep worker_connections
# Nếu thấp (< 1024), tăng lên
```

**Cách fix**:
- Đảm bảo mỗi location có `proxy_pass` đến upstream block riêng
- Tăng `worker_connections` lên ít nhất 2048
- Tăng `worker_rlimit_nofile`
- Đảm bảo Nginx container không bị giới hạn CPU/memory

### Problem 2: Slow lane p95 < 300ms

**Triệu chứng**: Slow lane nhanh bất thường, threshold `p(95)>300` fail.

**Nguyên nhân có thể**:
1. **Slow origin không có delay**: Service không được cấu hình sleep/delay
2. **CDN cache**: Request đi qua CDN (có X-Cache header)
3. **Wrong slow origin**: Request đi nhầm vào fast origin
4. **DNS cache hit**: Response được cache ở tầng DNS hoặc application

**Cách debug**:

```powershell
# 1. Kiểm tra thủ công
curl -w "\nTime: %{time_total}s\n" -s http://localhost:80/api/lb/isolation-slow-demo
# Expected: > 0.3s

# 2. Kiểm tra role
curl -s http://localhost:80/api/lb/isolation-slow-demo | jq '.role'
# Expected: "slow"

# 3. Kiểm tra X-Cache
curl -sI http://localhost:80/api/lb/isolation-slow-demo | grep -i x-cache
# Expected: NO OUTPUT

# 4. Kiểm tra X-Upstream-Service
curl -sI http://localhost:80/api/lb/isolation-slow-demo | grep -i x-upstream-service
# Expected: X-Upstream-Service: lb-slow-origin

# 5. Gọi trực tiếp origin (bỏ qua Nginx)
curl -w "\nTime: %{time_total}s\n" http://localhost:8090/api/lb/isolation-slow-demo
# Nếu vẫn nhanh → origin không có delay logic
```

**Cách fix**:
- Kiểm tra slow origin container image và code
- Đảm bảo slow origin có delay logic (sleep, busy wait, hoặc heavy computation)
- Nếu delay quá ngắn, điều chỉnh cho phù hợp (target: 500-700ms)
- Nếu không thể sửa origin, giảm threshold `p(95)>300` xuống `p(95)>100` (nhưng sẽ kém thuyết phục hơn)

### Problem 3: Fast lane có failed requests

**Triệu chứng**: `http_req_failed{endpoint:lb_isolation_fast_demo} > 0%`.

**Nguyên nhân có thể**:
1. **Fast pool keepalive quá thấp**: Pool cạn connection, request mới bị refuse
2. **Stable origin bị lỗi**: Container crash, OOM, hoặc app error
3. **Nginx connection limit**: `worker_connections` bị hit
4. **Docker network issue**: Packet loss, DNS resolution fail

**Cách debug**:

```powershell
# 1. Kiểm tra chi tiết lỗi
# Xem output của k6 -- thường hiển thị status code của request fail
# Nếu là 502 hoặc 504 → origin không phản hồi
# Nếu là 503 → Nginx không có backend available
# Nếu là connection refused → pool cạn hoặc origin down

# 2. Kiểm tra stable origin health
curl -s http://localhost:8090/api/lb/isolation-fast-demo | jq .
curl -sI http://localhost:8090/api/lb/isolation-fast-demo | head -1

# 3. Kiểm tra Nginx error log
docker logs nginx 2>&1 | grep -i "upstream\|error\|timeout" | tail -20

# 4. Kiểm tra keepalive setting
docker exec nginx nginx -T | grep -A5 "upstream lb_stable"

# 5. Test với rate thấp hơn để isolate vấn đề
$env:LB_ISOLATION_FAST_RATE = "5"
.\scripts\run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 11-saturation-isolation
```

**Cách fix**:
- Nếu pool cạn: tăng `keepalive` cho `lb_stable_backend`
- Nếu origin lỗi: restart container, kiểm tra app log
- Nếu Nginx connection limit: tăng `worker_connections` và `worker_rlimit_nofile`
- Nếu Docker network: kiểm tra `docker network inspect`, restart network nếu cần

### Problem 4: X-Upstream-Service header sai

**Triệu chứng**: Fast request có `X-Upstream-Service: lb-slow-origin` hoặc ngược lại.

**Nguyên nhân**:
- **Nginx config sai**: Location block proxy_pass đến sai upstream
- **Nginx config chưa được reload**: Thay đổi config nhưng chưa `nginx -s reload`
- **Location match sai**: Regex hoặc prefix match khác bắt request trước

**Cách debug**:

```powershell
# 1. Xem toàn bộ Nginx config runtime
docker exec nginx nginx -T > nginx-runtime.conf
# Tìm location = /api/lb/isolation-fast-demo và location = /api/lb/isolation-slow-demo

# 2. Kiểm tra thứ tự location match
# Nginx ưu tiên: exact match (=) > prefix match (^~) > regex match (~, ~*) > prefix match

# 3. Reload Nginx config
docker exec nginx nginx -s reload

# 4. Test lại
curl -sI http://localhost:80/api/lb/isolation-fast-demo | grep -i x-upstream-service
```

**Cách fix**:
- Sửa `proxy_pass` directive trong location block cho đúng upstream
- Đảm bảo dùng exact match (`=`) cho các path này
- Reload Nginx config sau khi sửa

### Problem 5: Có X-Cache header trong response

**Triệu chứng**: `X-Cache: HIT` hoặc `X-Cache: MISS` xuất hiện trong response header.

**Nguyên nhân**:
- **Sai profile**: Đang chạy `TargetLayer=full` (có Varnish CDN) thay vì `full-no-cdn`
- **Sai port**: Đang gọi port có CDN (80 có Varnish nếu profile full?)

**Cách debug**:

```powershell
# 1. Kiểm tra stack hiện tại
docker ps --format "{{.Names}}" | grep -i varnish
# Nếu có container varnish → đang chạy sai profile

# 2. Kiểm tra xem Nginx có đứng sau Varnish không
curl -sI http://localhost:80/api/lb/isolation-fast-demo | grep -i "x-cache\|x-varnish\|via"
# Nếu có bất kỳ header nào → có CDN

# 3. Restart stack với đúng profile
.\scripts\stack.ps1 -Stack target -Action down
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
```

**Cách fix**:
- Chạy lại stack với `-TargetLayer full-no-cdn`
- Xác nhận không có Varnish container
- Xác nhận `BASE_URL=http://localhost:80` đi thẳng đến Nginx

### Problem 6: dropped_iterations hoặc iteration rate không đạt target

**Triệu chứng**: k6 output có `dropped_iterations` hoặc actual rate thấp hơn nhiều so với target rate.

**Nguyên nhân**:
- **Không đủ VU**: `preAllocatedVUs` hoặc `maxVUs` quá thấp
- **Response time quá lâu**: VU bị block quá lâu, không kịp gửi request mới
- **CPU/memory limit của k6**: Máy chạy k6 không đủ resource

**Cách debug**:

```powershell
# 1. Tăng maxVUs
$env:LB_ISOLATION_MAX_VUS = "64"
$env:LB_ISOLATION_PRE_ALLOCATED_VUS = "32"

# 2. Giảm rate để test
$env:LB_ISOLATION_FAST_RATE = "10"
$env:LB_ISOLATION_SLOW_RATE = "3"

# 3. Kiểm tra resource usage trong lúc chạy
# Mở terminal khác:
docker stats

# 4. Tăng timeout của k6
$env:K6_HTTP_DEBUG = "false"
$env:K6_NO_USAGE_REPORT = "true"
```

**Cách fix**:
- Tăng `maxVUs` (có thể lên 64 hoặc 128)
- Đảm bảo máy test đủ CPU và memory
- Giảm rate nếu cần (nhưng vẫn đủ để chứng minh isolation)
- Nếu response time của slow lane quá lâu (> 2s), cần tăng `maxVUs` tương ứng

---

## 26. Tổng kết

### 26.1 Case này chứng minh điều gì

Case 11 chứng minh rằng **Nginx upstream pool isolation** hoạt động đúng: khi một upstream pool bị bão hòa (slow lane với request duration ~600ms), pool khác (fast lane) hoàn toàn không bị ảnh hưởng.

### 26.2 Điều kiện để isolation hoạt động

1. Mỗi service class phải có `upstream` block riêng với `zone` riêng
2. Mỗi route phải `proxy_pass` đến đúng upstream block
3. `keepalive` được cấu hình phù hợp với expected concurrency
4. `max_fails` và `fail_timeout` được tune cho đặc tính của từng pool
5. DNS resolution được cấu hình đúng (`resolve` + `resolver`)

### 26.3 Bài học cho production

1. **Luôn cô lập pool cho các service có đặc tính hiệu năng khác nhau**
2. **Không dùng aggregate metrics để đánh giá hệ thống có nhiều service class** -- luôn phân tích theo endpoint
3. **Thiết kế test phản ánh đúng production pattern**: chạy song song fast và slow lane, không test riêng lẻ
4. **Threshold nên phản ánh expectation thực tế**: fast lane < 50ms, slow lane > 300ms (có chủ đích)
5. **Header signal (`X-Upstream-Service`, `X-LB-Isolation-Class`) là bằng chứng routing quan trọng** -- không chỉ dựa vào latency

### 26.4 Maturity model cho upstream isolation

| Mức độ | Mô tả | Case này đạt? |
| --- | --- | --- |
| **Level 0: Không có isolation** | Tất cả service dùng chung một upstream pool | Không -- đây là trạng thái cần tránh |
| **Level 1: Isolation cơ bản** | Mỗi service class có pool riêng, keepalive khác nhau | **CÓ** -- Case 11 chứng minh level này |
| **Level 2: Isolation + health check riêng** | Mỗi pool có `max_fails` và `fail_timeout` riêng | **CÓ** -- stable=3, slow=1 |
| **Level 3: Isolation + circuit breaker** | Thêm `max_conns` limit, queue, và backpressure | Chưa -- cần thêm cấu hình |
| **Level 4: Isolation + adaptive** | Tự động điều chỉnh keepalive và timeout dựa trên real-time metrics | Chưa -- cần Nginx Plus hoặc custom module |

### 26.5 Next steps sau khi case này PASS

Sau khi case 11 PASS, các bước tiếp theo:
1. Chạy variations (section 14) để test isolation ở các mức load khác nhau
2. Tích hợp case này vào CI/CD pipeline để phát hiện regression
3. Áp dụng pattern isolation cho tất cả service class trong production
4. Thiết lập monitoring riêng cho từng upstream pool
5. Document lại topology và config cho ops team

---

*Document version: 2.0.0 | Last updated: 2026-06-23 | Total lines: 1,500+*
