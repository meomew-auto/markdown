# Case 11: Saturation Isolation

> **Case ID:** `lb-11-saturation-isolation`
> **Script:** `11-saturation-isolation.js`
> **Profile:** `full-no-cdn`
> **Workload:** hai constant-arrival-rate scenarios song song (fast 25/s + slow 6/s)
> **Proof:** slow lane không kéo sập fast lane khi upstream pool được isolation đúng

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

Một nền tảng thương mại điện tử vận hành Nginx gateway phía trước hàng chục microservices. Trong số đó, có hai nhóm service với đặc tính latency hoàn toàn khác biệt:

- **Fast lane (luồng nhanh)**: Các service cốt lõi phục vụ trải nghiệm người dùng trực tiếp -- trang chủ, danh sách sản phẩm, xác thực, giỏ hàng. Các service này có latency mục tiêu dưới 50ms và được tối ưu kỹ lưỡng.
- **Slow lane (luồng chậm)**: Các service nền không đồng bộ -- báo cáo thống kê, xuất dữ liệu, xử lý batch. Các service này có latency từ 300ms đến vài giây, đôi khi bão hòa vào giờ cao điểm.

Hãy hình dung một kịch bản điển hình vào 10:00 sáng thứ Hai. Phòng kinh doanh vừa yêu cầu một báo cáo doanh thu quý -- một tác vụ nặng, quét toàn bộ cơ sở dữ liệu giao dịch 3 tháng. Request này được route đến report-service (slow lane) và mất 800ms để hoàn thành. Đồng thời, hàng trăm người dùng đang duyệt sản phẩm và thêm vào giỏ hàng (fast lane), mỗi request kỳ vọng hoàn thành trong 30-40ms.

**Câu hỏi sống còn**: Nếu slow lane bị bão hòa, liệu fast lane có bị kéo chậm theo không?

Nếu Nginx dùng chung một connection pool cho tất cả upstream, câu trả lời là **CÓ**. Khi slow origin chiếm hết connection trong pool, request đến fast origin phải xếp hàng chờ -- người dùng thấy trang sản phẩm tải chậm dù products-service vẫn đang idle. Đây gọi là **saturation contagion** (lây nhiễm bão hòa): một upstream chậm làm tắc nghẽn toàn bộ gateway, ảnh hưởng đến tất cả service khác.

Ngược lại, nếu Nginx được cấu hình với **upstream isolation** -- mỗi nhóm upstream có pool connection riêng, không chia sẻ tài nguyên -- thì fast lane hoàn toàn không bị ảnh hưởng bởi slow lane. Fast lane tiếp tục phục vụ với latency thấp, slow lane tự chịu bão hòa trong không gian riêng của nó.

### 1.2 Cơ chế lây nhiễm bão hòa

Để hiểu vì sao isolation quan trọng, cần hiểu cơ chế lây nhiễm:

```text
KHÔNG CÓ ISOLATION (dùng chung upstream pool):

NGINX worker
  |
  +-- connection pool (shared, max 16 connections)
  |     |
  |     +-- connection #1  -> slow origin (đang xử lý, 600ms elapsed)
  |     +-- connection #2  -> slow origin (đang xử lý, 500ms elapsed)
  |     +-- connection #3  -> slow origin (đang xử lý, 400ms elapsed)
  |     +-- connection #4  -> slow origin (đang xử lý, 300ms elapsed)
  |     +-- ... (tất cả connection bị slow origin chiếm)
  |     +-- connection #16 -> slow origin (đang xử lý, 100ms elapsed)
  |
  |  FAST REQUEST ĐẾN --> KHÔNG CÒN CONNECTION --> XẾP HÀNG CHỜ
  |  Kết quả: fast lane p95 tăng từ 40ms lên 600ms+

CÓ ISOLATION (upstream pool riêng):

NGINX worker
  |
  +-- fast pool (max 16 connections)
  |     |-- connection #1  -> fast origin (20ms)
  |     |-- connection #2  -> fast origin (25ms)
  |     |-- ... (luôn có connection trống cho fast request)
  |
  +-- slow pool (max 16 connections)
        |-- connection #1  -> slow origin (600ms)
        |-- connection #2  -> slow origin (500ms)
        |-- ... (slow origin chiếm hết pool của chính nó)

  Kết quả: fast lane p95 = 40ms (không đổi), slow lane p95 = 600ms
```

Đây chính xác là điều case 11 chứng minh.

### 1.3 Tại sao "song song" lại quan trọng hơn test tuần tự

Test tuần tự -- chạy fast lane trước, rồi chạy slow lane sau -- không phát hiện được saturation contagion vì hai lane không bao giờ cạnh tranh tài nguyên cùng lúc. Vấn đề chỉ xuất hiện khi cả hai lane cùng chạy **đồng thời** (concurrent), cùng lúc chiếm connection trong pool.

| Phương pháp test | Phát hiện được saturation contagion? | Vì sao |
| --- | --- | --- |
| Fast lane riêng (chỉ scenario fast) | Không | Không có slow lane để gây bão hòa |
| Slow lane riêng (chỉ scenario slow) | Không | Không có fast lane để đo mức độ ảnh hưởng |
| Fast rồi slow tuần tự | Không | Pool được giải phóng giữa hai giai đoạn |
| **Fast và slow song song (case 11)** | **Có** | Hai lane cạnh tranh connection pool đồng thời |

Đó là lý do case 11 sử dụng **hai constant-arrival-rate scenario chạy song song** -- đây là thiết kế có chủ đích, không phải ngẫu nhiên.

---

## 2. LB capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh:

> **Nginx gateway duy trì upstream pool isolation: khi slow lane bị bão hòa với request có latency cao có chủ đích, fast lane vẫn duy trì latency thấp, không bị ảnh hưởng bởi tình trạng của slow lane. Aggregate p95 toàn bộ request không được dùng làm kết luận -- phải đọc theo endpoint tag.**

Cụ thể hơn, case chứng minh 5 khả năng con:

1. **Upstream pool isolation hoạt động**: Fast lane (`lb-stable-origin`) và slow lane (`lb-slow-origin`) sử dụng upstream pool riêng biệt, không chia sẻ connection.
2. **Fast lane không bị kéo chậm**: p95 latency của `lb_isolation_fast_demo` duy trì dưới 50ms ngay cả khi slow lane đang xử lý request 600ms+.
3. **Slow lane giữ nguyên đặc tính chậm**: p95 latency của `lb_isolation_slow_demo` trên 300ms, xác nhận slow origin thực sự chậm (không phải do fast lane gây ra).
4. **Tagged threshold chính xác**: Threshold được gán theo endpoint tag, cho phép đánh giá riêng biệt từng lane thay vì bị aggregate làm nhiễu.
5. **Dual-scenario execution**: k6 chạy hai scenario `fast_lane` và `slow_lane` đồng thời trong cùng một test run, mỗi scenario có executor, rate, và exec function riêng.

### 2.2 So sánh với các case LB khác

| Case | Cơ chế isolation | Số lane song song | Tagged threshold? |
| --- | --- | --- | --- |
| 07 -- Rate limit pressure | Không (chỉ 1 upstream) | 1 lane | Không |
| 08 -- Weighted canary | Có (stable vs canary pool) | 1 lane (weighted routing) | Không |
| 09 -- Passive outlier ejection | Có (ejection backend riêng) | 1 lane | Không |
| **11 -- Saturation isolation** | **Có (fast vs slow pool hoàn toàn riêng)** | **2 lane song song** | **Có** |
| 12 -- Slow origin timeouts | Không (timeout policy, không isolation) | 1 lane | Có |

Case 11 là case **duy nhất** trong series chạy hai scenario song song với hai executor khác nhau. Điều này mô phỏng chính xác tình huống production nơi nhiều loại traffic cùng đến gateway đồng thời.

---

## 3. Vì sao phải test ở LB layer

### 3.1 Đây không phải là vấn đề của application layer

Application layer (code trong từng microservice) không biết về sự tồn tại của các service khác. `products-service` không biết `report-service` đang bị bão hòa, và cũng không có cơ chế nào để tự bảo vệ mình khỏi saturation contagion. Việc phân chia tài nguyên (connection pool, buffer, timeout) giữa các upstream là trách nhiệm **duy nhất** của gateway/layer 7 proxy.

Nếu test ở application layer:
- Bạn có thể test `products-service` phản hồi nhanh khi được gọi riêng.
- Bạn KHÔNG THỂ test rằng `products-service` vẫn nhanh khi `report-service` đang bão hòa connection pool của Nginx.

### 3.2 Đây không phải là vấn đề của CDN layer

CDN/Varnish ngồi trước Nginx. Nếu bạn test qua CDN (topology `full`):
- Request đến fast origin có thể được cache hit và trả về từ Varnish mà không qua Nginx, che giấu vấn đề isolation.
- `X-Cache: HIT` làm nhiễu signal -- bạn không biết request có thực sự đến upstream hay không.
- Header `X-LB-Isolation-Class` chỉ được thêm bởi Nginx config hoặc application origin, không phải bởi Varnish.

### 3.3 Phân biệt trách nhiệm giữa các layer

```text
CDN layer:    Request có được cache/offload không?
LB layer:     Khi hai upstream pool cạnh tranh tài nguyên, fast lane có bị slow lane kéo chậm không?
App layer:    Business logic trong từng service có đúng không?
```

Case 11 trả lời câu hỏi thứ hai -- và làm điều đó trong điều kiện khắc nghiệt nhất: hai lane chạy song song với áp lực không đổi.

---

## 4. Topology và precondition

### 4.1 Topology

```text
k6 (16 preAllocatedVUs, 32 maxVUs, 10s)
  |
  | Hai scenario song song:
  |   fast_lane: constant-arrival-rate 25/s -> GET /api/lb/isolation-fast-demo
  |   slow_lane: constant-arrival-rate 6/s  -> GET /api/lb/isolation-slow-demo
  |
  v
Nginx :80
  |
  | Upstream pool isolation:
  |
  +---> lb-stable-origin (fast pool riêng)
  |       response: role=stable, latency ~1-5ms
  |       header: X-LB-Isolation-Class=fast
  |
  +---> lb-slow-origin (slow pool riêng)
          response: role=slow, latency ~500-800ms (có chủ đích)
          header: X-LB-Isolation-Class=slow
```

Response header mong đợi:
- `X-Served-By: nginx` hoặc `Server: nginx/...`
- `X-Upstream-Service`: `lb-stable-origin` (fast) hoặc `lb-slow-origin` (slow)
- `X-LB-Isolation-Class`: `fast` hoặc `slow`
- `X-Request-ID`: UUID được Nginx gán
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
curl -s -I http://localhost:80/api/lb/isolation-fast-demo | findstr "X-Cache"
# Kỳ vọng: không có output nào

# 5. Xác nhận fast origin hoạt động và trả về role=stable
curl -s http://localhost:80/api/lb/isolation-fast-demo
# Kỳ vọng: {"role":"stable","latency_ms":...}

# 6. Xác nhận slow origin hoạt động và trả về role=slow
curl -s http://localhost:80/api/lb/isolation-slow-demo
# Kỳ vọng: {"role":"slow","latency_ms":...} (latency cao có chủ đích)
```

### 4.3 Environment variables

| Biến | Default | Mô tả |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | Public URL của Nginx gateway |
| `LB_ISOLATION_FAST_RATE` | `25` | Số request/giây cho fast lane |
| `LB_ISOLATION_SLOW_RATE` | `6` | Số request/giây cho slow lane |
| `LB_ISOLATION_DURATION_SECONDS` | `10` | Thời gian chạy test (giây) |
| `LB_ISOLATION_PRE_ALLOCATED_VUS` | `16` | Số VU được cấp phát trước |
| `LB_ISOLATION_MAX_VUS` | `32` | Số VU tối đa được phép |

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `11-saturation-isolation.js` gồm 75 dòng, được tổ chức thành 4 phần chính:

```javascript
// (A) IMPORTS: 3 dòng
import { check } from 'k6';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbCapabilityApis, requestLB } from './shared.js';

// (B) CONFIGURATION: 6 dòng
const FAST_RATE = envInt('LB_ISOLATION_FAST_RATE', 25);
const SLOW_RATE = envInt('LB_ISOLATION_SLOW_RATE', 6);
const DURATION_SECONDS = envInt('LB_ISOLATION_DURATION_SECONDS', 10);
const PRE_ALLOCATED_VUS = envInt('LB_ISOLATION_PRE_ALLOCATED_VUS', 16);
const MAX_VUS = envInt('LB_ISOLATION_MAX_VUS', 32);

// (C) OPTIONS: 32 dòng
export const options = { ... };

// (D) EXPORT FUNCTIONS: 30 dòng
export function fastLane() { ... };
export function slowLane() { ... };
```

Điểm độc đáo: script này **không có default function**. Thay vào đó, nó export hai named function `fastLane` và `slowLane`, mỗi function được gán cho một scenario riêng qua `exec` property.

### 5.2 Phân tích từng dòng -- Phần B: Configuration

```javascript
const FAST_RATE = envInt('LB_ISOLATION_FAST_RATE', 25);
const SLOW_RATE = envInt('LB_ISOLATION_SLOW_RATE', 6);
```

Tại sao fast lane 25/s và slow lane 6/s?

- **Fast lane 25/s**: Mô phỏng traffic người dùng thật. Với p95 target dưới 50ms, 25 request/giây là áp lực vừa đủ để thấy isolation hoạt động mà không làm quá tải local environment.
- **Slow lane 6/s**: Tỉ lệ khoảng 19% tổng traffic (6/31). Con số này phản ánh thực tế: traffic nền (báo cáo, batch) thường chiếm 15-25% tổng request trong hệ thống thương mại điện tử.
- **Tổng 31 request/giây**: Với preAllocatedVUs=16 và response time fast khoảng 5ms + slow khoảng 600ms, hệ thống cần khoảng: 25 * 0.005 + 6 * 0.6 = 0.125 + 3.6 = 3.725 VUs concurrent. PreAllocatedVUs=16 là dư dả, đảm bảo không thiếu VU.

```javascript
const DURATION_SECONDS = envInt('LB_ISOLATION_DURATION_SECONDS', 10);
```

10 giây tạo ra khoảng 250 request fast + 60 request slow = 310 request tổng cộng -- đủ sample size cho p95 ổn định.

```javascript
const PRE_ALLOCATED_VUS = envInt('LB_ISOLATION_PRE_ALLOCATED_VUS', 16);
const MAX_VUS = envInt('LB_ISOLATION_MAX_VUS', 32);
```

- `preAllocatedVUs=16`: Với constant-arrival-rate executor, đây là số VU được khởi tạo sẵn để đảm bảo đạt được target rate ngay từ đầu.
- `maxVUs=32`: Giới hạn trên -- nếu cần nhiều hơn 32 VU để duy trì rate (ví dụ nếu latency tăng đột biến), k6 sẽ không cấp thêm.

### 5.3 Phân tích từng dòng -- Phần C: Options (trái tim của case)

```javascript
export const options = {
  scenarios: {
    fast_lane: {
      executor: 'constant-arrival-rate',
      rate: FAST_RATE,            // 25
      timeUnit: '1s',
      duration: `${DURATION_SECONDS}s`,  // '10s'
      preAllocatedVUs: PRE_ALLOCATED_VUS, // 16
      maxVUs: MAX_VUS,                    // 32
      exec: 'fastLane',
    },
    slow_lane: {
      executor: 'constant-arrival-rate',
      rate: SLOW_RATE,            // 6
      timeUnit: '1s',
      duration: `${DURATION_SECONDS}s`,  // '10s'
      preAllocatedVUs: PRE_ALLOCATED_VUS, // 16
      maxVUs: MAX_VUS,                    // 32
      exec: 'slowLane',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    'http_req_failed{endpoint:lb_isolation_fast_demo}': ['rate==0'],
    'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],
    'http_req_failed{endpoint:lb_isolation_slow_demo}': ['rate==0'],
    'http_req_duration{endpoint:lb_isolation_slow_demo}': ['p(95)>300'],
  },
  tags: {
    scenario: 'lb_saturation_isolation',
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};
```

#### 5.3.1 Tại sao dùng constant-arrival-rate?

Constant-arrival-rate executor tạo ra áp lực không đổi theo thời gian -- đúng 25 request/giây cho fast lane, đúng 6 request/giây cho slow lane -- bất kể latency của request trước đó là bao nhiêu. Điều này quan trọng vì:

- Nếu dùng constant-vus (như case 05), số request/giây sẽ giảm khi latency tăng. Slow lane sẽ tự nhiên gửi ít request hơn khi bị chậm, làm giảm áp lực lên pool và che giấu vấn đề isolation.
- Constant-arrival-rate đảm bảo slow lane luôn gửi 6 request/giây ngay cả khi mỗi request mất 600ms -- tạo áp lực thực sự lên connection pool.
- Fast lane cũng dùng constant-arrival-rate để có baseline ổn định: luôn 25 request/giây, p95 baseline có thể đo được chính xác.

**So sánh đầy đủ 5 executor cho case này:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **constant-arrival-rate** (đang dùng) | ✅ **ĐÚNG** | Dual-scenario open model. Fast lane 25 req/s, slow lane 6 req/s. Rate cố định đảm bảo áp lực KHÔNG ĐỔI — slow lane không được "nghỉ" khi chậm. |
| constant-vus | ❌ SAI | Closed model: slow lane chậm → VU bận lâu → rate giảm → áp lực giảm → fast lane không bị ảnh hưởng → test không phát hiện được isolation bug. |
| ramping-arrival-rate | ⚠️ Có thể | Nếu muốn test "tăng rate đến khi isolation break". Nhưng case này cần rate ổn định để có baseline so sánh. |
| shared-iterations | ❌ SAI | Cần tổng iter cố định. Isolation test cần rate THEO THỜI GIAN để tạo áp lực liên tục. |
| per-vu-iterations | ❌ SAI | Cần iter/VU cố định. Không phù hợp. |

**Key insight**: Saturation isolation test CẦN dual-scenario open model. Nếu
dùng closed model, slow lane tự "giảm ga" khi chậm → không tạo áp lực thật →
không test được isolation. `constant-arrival-rate` ép cả 2 lane giữ rate — fast
lane phải "chiến đấu" với slow lane để giữ p95<50ms.

#### 5.3.2 Tại sao `preAllocatedVUs=16` và `maxVUs=32`?

Đây là tham số của constant-arrival-rate executor, không phải của constant-vus:

- `preAllocatedVUs=16`: k6 khởi tạo 16 VU sẵn sàng. Với 31 request/giây và latency trung bình khoảng 120ms (weighted average của fast và slow), số VU cần thiết khoảng: 31 * 0.120 = 3.72. PreAllocatedVUs=16 dư khoảng 4.3x, đủ buffer cho spike.
- `maxVUs=32`: nếu latency đột biến tăng (ví dụ slow lane bất ngờ chậm hơn dự kiến), k6 có thể tăng lên tối đa 32 VU để duy trì rate. Nếu cần hơn 32 VU, k6 sẽ drop request -- và `http_req_failed` sẽ tăng, báo hiệu vấn đề.

#### 5.3.3 Phân tích threshold -- đây là điểm QUAN TRỌNG NHẤT

```javascript
'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],
'http_req_duration{endpoint:lb_isolation_slow_demo}': ['p(95)>300'],
```

Hai threshold này là bằng chứng cốt lõi của case:

**(a) `http_req_duration{endpoint:lb_isolation_fast_demo} p(95)<50`**: 95% request fast lane phải hoàn thành dưới 50ms. Đây là gate bảo vệ fast lane -- nếu p95 fast lane vượt 50ms, có nghĩa là saturation contagion đã xảy ra, fast lane bị slow lane kéo chậm. TEST FAIL.

**(b) `http_req_duration{endpoint:lb_isolation_slow_demo} p(95)>300`**: 95% request slow lane phải **lớn hơn** 300ms. Nghe có vẻ ngược đời -- tại sao threshold lại là "phải chậm hơn X"? Đây là self-check: nó xác nhận slow origin **thực sự chậm**. Nếu p95 slow lane dưới 300ms, có thể slow origin không hoạt động đúng (không tạo ra delay có chủ đích), và test không có giá trị vì không có saturation để test isolation.

**(c) KHÔNG có aggregate `http_req_duration` threshold**: Đây là quyết định thiết kế có chủ đích. Aggregate p95 sẽ trộn fast (5ms) và slow (600ms), cho ra một con số vô nghĩa khoảng 300ms. Nếu đặt aggregate threshold, bạn sẽ không biết fast lane có bị kéo chậm hay không.

**(d) `checks: ['rate==1']`**: Tất cả checks phải pass -- bao gồm check `role===stable` cho fast lane và `role===slow` cho slow lane.

### 5.4 Phân tích từng dòng -- Phần D: Export functions

```javascript
export function fastLane() {
  const api = lbCapabilityApis.isolationFastDemo;
  const res = requestLB(api, {
    tags: {
      endpoint: api.name,      // 'lb_isolation_fast_demo'
      lane: 'fast',
    },
  });

  assertLBResponse(res, api, 'lb isolation fast lane');
  check(res, {
    'lb isolation fast lane role stable': (r) => r.json('role') === 'stable',
  });
}
```

**(1) `lbCapabilityApis.isolationFastDemo`**: API object được định nghĩa trong `shared.js`:

```javascript
isolationFastDemo: {
  name: 'lb_isolation_fast_demo',
  method: 'GET',
  path: '/api/lb/isolation-fast-demo',
  expected: 200,
  expectedUpstream: 'lb-stable-origin',
},
```

**(2) `tags: { endpoint: api.name, lane: 'fast' }`**: Tag `endpoint` cực kỳ quan trọng -- nó cho phép threshold filter theo endpoint. Tag `lane` bổ sung thêm chiều phân tích (fast vs slow).

**(3) `assertLBResponse(res, api, ...)`**: 5 checks chuẩn: status, nginx signature, upstream, request-id, no-cache.

**(4) `check(res, { 'role stable': ... })`**: Check bổ sung -- body response phải có `role: "stable"`. Check này xác nhận fast origin thực sự là stable origin, không phải slow origin do route nhầm.

```javascript
export function slowLane() {
  const api = lbCapabilityApis.isolationSlowDemo;
  const res = requestLB(api, {
    tags: {
      endpoint: api.name,      // 'lb_isolation_slow_demo'
      lane: 'slow',
    },
  });

  assertLBResponse(res, api, 'lb isolation slow lane');
  check(res, {
    'lb isolation slow lane role slow': (r) => r.json('role') === 'slow',
  });
}
```

Cấu trúc tương tự `fastLane()`, nhưng:
- Dùng `isolationSlowDemo` API object: `expectedUpstream: 'lb-slow-origin'`
- Check `role === 'slow'` -- xác nhận slow origin thực sự trả về slow response
- Tag `lane: 'slow'` để phân biệt trong dashboard

### 5.5 Deep-dive: API definitions trong shared.js

```javascript
isolationFastDemo: {
  name: 'lb_isolation_fast_demo',
  method: 'GET',
  path: '/api/lb/isolation-fast-demo',
  expected: 200,
  expectedUpstream: 'lb-stable-origin',
},
isolationSlowDemo: {
  name: 'lb_isolation_slow_demo',
  method: 'GET',
  path: '/api/lb/isolation-slow-demo',
  expected: 200,
  expectedUpstream: 'lb-slow-origin',
},
```

Điểm đáng chú ý:
- Cả hai API đều expected 200 -- không phải 504 như case 12. Slow lane vẫn trả về 200 thành công, chỉ là latency cao hơn.
- Hai upstream khác nhau (`lb-stable-origin` vs `lb-slow-origin`) -- đây là nền tảng của isolation. Nếu cả hai dùng chung upstream, sẽ không có isolation để test.
- Path khác nhau: `/api/lb/isolation-fast-demo` và `/api/lb/isolation-slow-demo` -- Nginx dùng path-based routing để chọn upstream.

---

## 6. Nginx/LB mechanism deep-dive

### 6.1 Upstream pool isolation trong Nginx

Nginx thực hiện upstream pool isolation thông qua việc định nghĩa các `upstream` block riêng biệt:

```nginx
# Fast pool -- dành riêng cho stable origin
upstream lb_stable_origin {
    server lb-stable-origin:3000 max_conns=32;
    keepalive 16;
}

# Slow pool -- dành riêng cho slow origin
upstream lb_slow_origin {
    server lb-slow-origin:3000 max_conns=32;
    keepalive 16;
}

server {
    listen 80;

    # Fast lane location
    location /api/lb/isolation-fast-demo {
        proxy_pass http://lb_stable_origin;
        proxy_set_header X-Upstream-Service "lb-stable-origin";
        proxy_set_header X-LB-Isolation-Class "fast";
        proxy_read_timeout 2s;
    }

    # Slow lane location
    location /api/lb/isolation-slow-demo {
        proxy_pass http://lb_slow_origin;
        proxy_set_header X-Upstream-Service "lb-slow-origin";
        proxy_set_header X-LB-Isolation-Class "slow";
        proxy_read_timeout 5s;
    }
}
```

### 6.2 Cơ chế `keepalive` và connection pool

Directive `keepalive 16` trong mỗi upstream block là chìa khóa của isolation:

- Mỗi upstream block có **connection pool riêng** với tối đa 16 keepalive connection đến upstream server.
- Khi slow origin chiếm hết 16 connection trong pool `lb_slow_origin`, các request tiếp theo đến slow origin phải chờ -- nhưng **không ảnh hưởng** đến pool `lb_stable_origin`.
- Fast lane có pool riêng với 16 connection, luôn sẵn sàng phục vụ request nhanh.

Nếu không có `keepalive` directive (mặc định là 0), Nginx sẽ mở connection mới cho mỗi request và đóng ngay sau khi dùng xong. Khi đó, isolation ít quan trọng hơn vì không có pool để cạn kiệt. Nhưng trong production, keepalive là bắt buộc để giảm latency và overhead -- và chính vì có keepalive mà isolation trở nên quan trọng.

### 6.3 `proxy_read_timeout` khác nhau cho từng lane

```nginx
# Fast lane: timeout ngắn (2s) -- nếu stable origin đột nhiên chậm, cắt nhanh
location /api/lb/isolation-fast-demo {
    proxy_read_timeout 2s;
}

# Slow lane: timeout dài hơn (5s) -- chấp nhận latency cao có chủ đích
location /api/lb/isolation-slow-demo {
    proxy_read_timeout 5s;
}
```

Đây là một lớp isolation thứ hai: timeout policy khác nhau cho từng lane. Nếu stable origin bất ngờ chậm (có thể do bug), fast lane sẽ timeout sau 2 giây thay vì treo vô hạn. Slow lane có timeout dài hơn vì chậm là expected behavior.

### 6.4 Header `X-LB-Isolation-Class`

```nginx
proxy_set_header X-LB-Isolation-Class "fast";   // cho fast lane
proxy_set_header X-LB-Isolation-Class "slow";   // cho slow lane
```

Header này được Nginx thêm vào request gửi đến upstream, và upstream echo lại trong response. Nó phục vụ hai mục đích:

1. **Observability**: Cho phép log/APM tool phân loại request theo lane.
2. **Debug**: Nếu response có `X-LB-Isolation-Class=slow` nhưng body có `role=stable`, có bug trong routing.

### 6.5 Tương tác giữa constant-arrival-rate và connection pool

Đây là điểm tinh tế nhất của case 11:

```text
Fast lane: 25 req/s, mỗi request ~5ms
  -> Tại mỗi thời điểm, trung bình 25 * 0.005 = 0.125 concurrent requests
  -> Pool 16 connection luôn thừa (>100x buffer)

Slow lane: 6 req/s, mỗi request ~600ms
  -> Tại mỗi thời điểm, trung bình 6 * 0.6 = 3.6 concurrent requests
  -> Pool 16 connection cũng thừa, nhưng nếu latency tăng lên 3s, sẽ cần 6 * 3 = 18 connections
  -> Lúc đó pool 16 bắt đầu cạn -> saturation trong slow pool
  -> FAST POOL VẪN ỔN vì không chia sẻ connection
```

Nếu không có isolation, concurrent requests từ slow lane sẽ chiếm connection trong pool chung, và fast lane sẽ phải xếp hàng sau slow requests -- p95 fast lane tăng vọt.

### 6.6 Nginx worker model và event loop

Nginx dùng event-driven architecture với một event loop duy nhất cho mỗi worker process. Điều này có nghĩa:

- Mỗi worker có thể xử lý hàng ngàn connection đồng thời.
- Khi một connection đến slow origin đang chờ response, worker **không block** -- nó chuyển sang xử lý event khác (epoll/kqueue).
- Điều này quan trọng: Nginx không cần thread pool để không block. Nhưng connection pool (`keepalive`) vẫn là tài nguyên hữu hạn cần được quản lý.

Isolation đảm bảo rằng ngay cả khi event loop bận xử lý I/O cho slow connections, fast connections vẫn có connection pool riêng để sử dụng ngay lập tức.

---

## 7. Request sequence flow

### 7.1 Timeline với hai lane song song

```text
Time (ms)  |  FAST LANE (25 req/s)              |  SLOW LANE (6 req/s)
-----------|--------------------------------------|--------------------------------------
0          |  VU-F1 gửi request #1               |  VU-S1 gửi request #1
2          |  VU-F2 gửi request #2               |
4          |  VU-F3 gửi request #3               |
5          |  VU-F1 nhận response #1 (5ms)       |
7          |  VU-F1 gửi request #4               |
10         |  VU-F2 nhận response #2 (8ms)       |
...        |  (liên tục request mỗi ~40ms)       |
150        |                                      |  VU-S2 gửi request #2
300        |                                      |  VU-S3 gửi request #3
450        |                                      |  VU-S4 gửi request #4
600        |                                      |  VU-S1 nhận response #1 (600ms)
605        |                                      |  VU-S1 gửi request #5
750        |                                      |  VU-S2 nhận response #2 (600ms)
...        |  (fast lane tiếp tục 5ms latency)   |  (slow lane tiếp tục 600ms latency)

KẾT QUẢ:
  Fast lane: 250 request trong 10s, p95 = 12ms
  Slow lane: 60 request trong 10s, p95 = 616ms
  Fast lane KHÔNG bị ảnh hưởng bởi slow lane
```

### 7.2 Sequence của một fast lane request qua Nginx

```text
k6 VU (fastLane)              NGINX                           UPSTREAM (lb-stable-origin)
    |                            |                                 |
    |-- GET /api/lb/             |                                 |
    |   isolation-fast-demo ---> |                                 |
    |                            |                                 |
    |                            |-- match location:               |
    |                            |   /api/lb/isolation-fast-demo   |
    |                            |   -> proxy_pass lb_stable_origin|
    |                            |                                 |
    |                            |-- chọn connection từ             |
    |                            |   fast pool (keepalive 16)      |
    |                            |   -> có sẵn ngay                |
    |                            |                                 |
    |                            |-- GET /api/lb/                ->|
    |                            |   isolation-fast-demo           |
    |                            |   X-LB-Isolation-Class: fast    |
    |                            |                                 |
    |                            |                    (xử lý 1-3ms)|
    |                            |                                 |
    |                            |<-- 200 OK --------------------- |
    |                            |   {"role":"stable",...}         |
    |                            |                                 |
    |                            |-- thêm headers:                 |
    |                            |   X-Upstream-Service:           |
    |                            |     lb-stable-origin            |
    |                            |   X-LB-Isolation-Class: fast    |
    |                            |                                 |
    |<-- 200 OK ---------------- |
    |   duration: ~5ms           |
    |                            |                                 |
    |-- checks:                   |                                 |
    |   status=200 ✓              |                                 |
    |   upstream=lb-stable ✓      |                                 |
    |   role=stable ✓             |                                 |
```

### 7.3 Sequence của một slow lane request qua Nginx

```text
k6 VU (slowLane)              NGINX                           UPSTREAM (lb-slow-origin)
    |                            |                                 |
    |-- GET /api/lb/             |                                 |
    |   isolation-slow-demo ---> |                                 |
    |                            |                                 |
    |                            |-- match location:               |
    |                            |   /api/lb/isolation-slow-demo   |
    |                            |   -> proxy_pass lb_slow_origin  |
    |                            |                                 |
    |                            |-- chọn connection từ             |
    |                            |   slow pool (keepalive 16)      |
    |                            |                                 |
    |                            |-- GET /api/lb/                ->|
    |                            |   isolation-slow-demo           |
    |                            |   X-LB-Isolation-Class: slow    |
    |                            |                                 |
    |                            |               (cố ý delay       |
    |                            |                500-800ms)       |
    |                            |                                 |
    |                            |<-- 200 OK --------------------- |
    |                            |   {"role":"slow",...}           |
    |                            |                                 |
    |                            |-- thêm headers:                 |
    |                            |   X-Upstream-Service:           |
    |                            |     lb-slow-origin              |
    |                            |   X-LB-Isolation-Class: slow    |
    |                            |                                 |
    |<-- 200 OK ---------------- |
    |   duration: ~600ms         |
    |                            |                                 |
    |-- checks:                   |                                 |
    |   status=200 ✓              |                                 |
    |   upstream=lb-slow ✓        |                                 |
    |   role=slow ✓               |                                 |
```

### 7.4 Concurrency model với hai scenario

```text
k6 Process
  |
  +-- Scenario: fast_lane (constant-arrival-rate 25/s)
  |     |-- VU-F1: |req|...|req|...|req|...|req|...| (mỗi req ~5ms, nghỉ ~35ms)
  |     |-- VU-F2: |req|...|req|...|req|...|req|...|
  |     |-- ...
  |     +-- VU-F16: (idle nếu không cần)
  |
  +-- Scenario: slow_lane (constant-arrival-rate 6/s)
        |-- VU-S1: |req|............|req|............| (mỗi req ~600ms, 6 req/s cần ~3.6 VU)
        |-- VU-S2: |req|............|req|............|
        |-- VU-S3: |req|............|req|............|
        +-- VU-S4: |req|............|req|............|

Hai scenario chạy ĐỘC LẬP trong cùng process k6.
Tổng VUs: fast cần ~1-2 VU (do latency thấp), slow cần ~4 VU (do latency cao)
PreAllocatedVUs=16 đủ cho cả hai, không cần scale lên maxVUs=32
```

---

## 8. Key signals / headers

### 8.1 Bảng signals cần verify

| Signal | Vị trí | Expected value | Ý nghĩa | Hậu quả nếu sai |
| --- | --- | --- | --- | --- |
| `status` cho fast lane | Response status line | `200` | Fast origin hoạt động bình thường | Status khác 200 = fast origin có vấn đề hoặc route sai |
| `status` cho slow lane | Response status line | `200` | Slow origin hoạt động bình thường (chậm nhưng thành công) | Status khác 200 = slow origin không hoạt động đúng |
| `X-Served-By` | Response header | `nginx` | Xác nhận Nginx đã xử lý request | Thiếu = request bypass gateway |
| `X-Upstream-Service` (fast) | Response header | `lb-stable-origin` | Fast lane được route đến đúng upstream | Sai = routing bug, có thể fast lane đang gọi slow origin |
| `X-Upstream-Service` (slow) | Response header | `lb-slow-origin` | Slow lane được route đến đúng upstream | Sai = routing bug |
| `X-LB-Isolation-Class` (fast) | Response header | `fast` | Xác nhận request thuộc fast lane | Sai = isolation class bị gán nhầm |
| `X-LB-Isolation-Class` (slow) | Response header | `slow` | Xác nhận request thuộc slow lane | Sai = isolation class bị gán nhầm |
| `X-Request-ID` | Response header | Chuỗi non-empty | Trace ID được Nginx gán | Thiếu = config thiếu `proxy_set_header X-Request-ID` |
| `X-Cache` | Response header | **Vắng mặt** | Không có CDN interference | Có mặt = topology sai |
| `role` (fast body) | Response body | `"stable"` | Fast origin xác nhận danh tính | Sai = origin không đúng hoặc route sai |
| `role` (slow body) | Response body | `"slow"` | Slow origin xác nhận danh tính | Sai = origin không đúng hoặc route sai |
| `endpoint` tag (fast) | k6 tag | `lb_isolation_fast_demo` | Phân nhóm metric cho fast lane | Thiếu = không filter được threshold theo lane |
| `endpoint` tag (slow) | k6 tag | `lb_isolation_slow_demo` | Phân nhóm metric cho slow lane | Thiếu = không filter được threshold theo lane |
| `lane` tag (fast) | k6 tag | `fast` | Bổ sung chiều phân tích | Thiếu = không so sánh được fast vs slow |
| `lane` tag (slow) | k6 tag | `slow` | Bổ sung chiều phân tích | Thiếu = không so sánh được fast vs slow |

### 8.2 Signal relationship map

```text
X-Served-By=nginx ──────┬── (A) Request đi qua gateway
                         │
X-Upstream-Service ──────┼── (B) Route đúng upstream pool
    fast -> lb-stable    │
    slow -> lb-slow      │
                         │
X-LB-Isolation-Class ────┼── (C) Isolation class được gán đúng
                         │
body.role ───────────────┼── (D) Origin identity được xác nhận
    fast -> "stable"     │
    slow -> "slow"       │
                         │
Endpoint-tagged p95 ─────┴── (E) Latency per lane -- BẰNG CHỨNG CHÍNH
    fast p95 < 50ms          (fast lane không bị kéo chậm)
    slow p95 > 300ms         (slow lane thực sự chậm)

Tất cả 5 signal (A+B+C+D+E) cùng đúng -> Isolation được chứng minh
Fast p95 > 50ms -> Saturation contagion đã xảy ra -> TEST FAIL
```

### 8.3 Tại sao KHÔNG đọc aggregate p95

```text
Aggregate p95 = trộn 250 fast request (p95=12ms) + 60 slow request (p95=616ms)
              ~ p95 của 310 request hỗn hợp
              ~ khoảng 400-500ms (tùy phân phối)

CON SỐ NÀY VÔ NGHĨA vì:
- Không cho biết fast lane có bị chậm không
- Không cho biết slow lane có thực sự chậm không
- Che giấu sự khác biệt giữa hai lane
- Nếu ai đó chỉ nhìn aggregate và kết luận "p95=450ms, hệ thống chậm", họ đã bỏ lỡ
  sự thật rằng fast lane vẫn 12ms và chỉ slow lane mới chậm
```

---

## 9. Pass/fail criteria

### 9.1 PASS criteria (định lượng)

Tất cả các điều kiện sau đồng thời đúng:

| # | Tiêu chí | Cách kiểm tra | Giá trị định lượng |
| --- | --- | --- | --- |
| P1 | Tất cả checks pass | Threshold `checks: ['rate==1']` | rate = 1.00 |
| P2 | Fast lane không có HTTP failure | Threshold `http_req_failed{endpoint:lb_isolation_fast_demo}: ['rate==0']` | rate = 0 |
| P3 | Fast lane p95 dưới 50ms | Threshold `http_req_duration{endpoint:lb_isolation_fast_demo}: ['p(95)<50']` | p95 < 50ms |
| P4 | Slow lane không có HTTP failure | Threshold `http_req_failed{endpoint:lb_isolation_slow_demo}: ['rate==0']` | rate = 0 |
| P5 | Slow lane p95 trên 300ms | Threshold `http_req_duration{endpoint:lb_isolation_slow_demo}: ['p(95)>300']` | p95 > 300ms |
| P6 | Fast lane route đúng upstream | Check `upstream matches` | `X-Upstream-Service: lb-stable-origin` |
| P7 | Slow lane route đúng upstream | Check `upstream matches` | `X-Upstream-Service: lb-slow-origin` |
| P8 | Fast lane body role đúng | Check `role stable` | `role: "stable"` |
| P9 | Slow lane body role đúng | Check `role slow` | `role: "slow"` |
| P10 | Tất cả response có `X-Request-ID` | Check `request id present` | non-empty string |
| P11 | Không response nào có `X-Cache` | Check `no cache header` | absent |

### 9.2 FAIL criteria

| # | Dấu hiệu | Diagnostic | Nguyên nhân khả dĩ |
| --- | --- | --- | --- |
| F1 | Fast lane p95 > 50ms | So sánh p95 fast lane khi chạy riêng (không có slow lane) | Saturation contagion: slow lane đang chiếm connection trong pool chung. Isolation không hoạt động. |
| F2 | Fast lane có HTTP failure | Xem status code của request fail | Fast origin bị lỗi, hoặc rate quá cao gây 429/503 |
| F3 | Slow lane p95 < 300ms | Kiểm tra response body `latency_ms` | Slow origin không tạo delay có chủ đích -- test không có giá trị |
| F4 | `upstream matches` fail cho fast lane | Xem `X-Upstream-Service` thực tế | Fast lane đang bị route đến sai upstream (ví dụ: lb-slow-origin) |
| F5 | `upstream matches` fail cho slow lane | Xem `X-Upstream-Service` thực tế | Slow lane đang bị route đến sai upstream |
| F6 | `role` check fail | So sánh body role với expected | Origin identity không khớp -- có thể hai origin bị swap cấu hình |
| F7 | `X-LB-Isolation-Class` sai hoặc thiếu | Kiểm tra response header | Nginx config thiếu `proxy_set_header X-LB-Isolation-Class` |
| F8 | Kết luận dựa trên aggregate p95 | Xem dashboard hoặc CLI output | Người đọc không hiểu cần đọc tagged metric -- **LỖI PHỔ BIẾN NHẤT** |
| F9 | `http_req_failed` rate > 0 cho cả hai lane | Phân tích pattern | Có thể do network issue hoặc Nginx không hoạt động |

---

## 10. Cách chạy + output mẫu

### 10.1 Default run

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 11-saturation-isolation
```

Output mẫu (default run):

```text
     script: 11-saturation-isolation.js
     profile: full-no-cdn

     ✓ lb isolation fast lane status
     ✓ lb isolation fast lane served by nginx
     ✓ lb isolation fast lane upstream matches
     ✓ lb isolation fast lane request id present
     ✓ lb isolation fast lane no cache header
     ✓ lb isolation fast lane role stable
     ✓ lb isolation slow lane status
     ✓ lb isolation slow lane served by nginx
     ✓ lb isolation slow lane upstream matches
     ✓ lb isolation slow lane request id present
     ✓ lb isolation slow lane no cache header
     ✓ lb isolation slow lane role slow

     checks.........................: 100.00% ✓ 1872  ✗ 0
     http_req_failed...............: 0.00%   ✓ 312   ✗ 0
     http_req_duration.............: avg=125ms p(95)=580ms
     http_reqs.....................: 312
     iterations....................: 312

     ✓ http_req_failed{endpoint:lb_isolation_fast_demo}: rate==0
     ✓ http_req_duration{endpoint:lb_isolation_fast_demo}: p(95)<50
     ✓ http_req_failed{endpoint:lb_isolation_slow_demo}: rate==0
     ✓ http_req_duration{endpoint:lb_isolation_slow_demo}: p(95)>300

     Exit: 0
```

Phân tích:
- **checks 100%**: 1872/1872 checks pass (312 request x 6 checks).
- **http_req_failed 0%**: Không có HTTP failure ở cả hai lane.
- **Aggregate p95=580ms**: Đây là con số vô nghĩa (xem section 8.3). Điều quan trọng là các tagged threshold bên dưới.
- **Tagged thresholds ALL PASS**: Fast lane p95 < 50ms (isolation hoạt động), slow lane p95 > 300ms (slow origin thực sự chậm).
- **Exit 0**: Test pass.

### 10.2 Chạy riêng từng lane để có baseline

```powershell
# Chỉ chạy fast lane để có baseline latency khi không có slow lane
k6 run ./k6/lb/11-saturation-isolation.js --env LB_ISOLATION_SLOW_RATE=0

# Chỉ chạy slow lane để xác nhận slow origin thực sự chậm
k6 run ./k6/lb/11-saturation-isolation.js --env LB_ISOLATION_FAST_RATE=0
```

### 10.3 Tăng áp lực để test isolation mạnh hơn

```powershell
# Tăng slow rate để tạo áp lực lớn hơn lên slow pool
$env:LB_ISOLATION_SLOW_RATE = "15"
$env:LB_ISOLATION_DURATION_SECONDS = "20"
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 11-saturation-isolation
```

### 10.4 Cách đọc kết quả trên dashboard

Trên Grafana dashboard:
1. Mở dashboard `LB Capability Cases`.
2. Filter theo `scenario=lb_saturation_isolation`.
3. Xem panel "HTTP Request Duration by Endpoint" -- quan sát hai đường: `lb_isolation_fast_demo` (thấp, ~5-15ms) và `lb_isolation_slow_demo` (cao, ~500-800ms).
4. Xem panel "HTTP Request Duration p95 by Endpoint" -- xác nhận fast p95 < 50ms và slow p95 > 300ms.
5. TUYỆT ĐỐI KHÔNG đọc panel "HTTP Request Duration (aggregate)" để đưa ra kết luận.
6. Xem panel "Upstream Service Distribution" -- xác nhận fast request đến `lb-stable-origin`, slow request đến `lb-slow-origin`.

---

## 11. 4 output -> decision scenarios

### Scenario A: Cả hai lane pass tất cả threshold (IDEAL)

```text
Exit: 0
Checks: 100%
Fast lane p95: ~12ms (< 50ms OK)
Slow lane p95: ~616ms (> 300ms OK)
HTTP failed: 0% cả hai lane
```

**Kết luận**: Upstream pool isolation hoạt động hoàn hảo. Fast lane duy trì latency thấp dù slow lane đang chậm có chủ đích.

**Hành động**: Không cần action. Case pass -- tiếp tục sang case 12.

### Scenario B: Fast lane p95 > 50ms -- SATURATION CONTAGION

```text
Exit: 99
Checks: 100%
Fast lane p95: ~450ms (FAIL: > 50ms)
Slow lane p95: ~620ms (> 300ms OK)
HTTP failed: 0%
```

**Kết luận**: Saturation contagion đã xảy ra. Fast lane bị slow lane kéo chậm.

**Hành động**:
1. Kiểm tra Nginx config: hai upstream có dùng chung một `upstream` block không?
2. Kiểm tra `keepalive` directive trong mỗi upstream block.
3. Xác nhận `proxy_pass` trong location block trỏ đến đúng upstream.
4. Kiểm tra xem có Nginx module hoặc middleware nào merge connection pool không.
5. Thử tăng `keepalive` để giảm contention.

### Scenario C: Slow lane p95 < 300ms -- SLOW ORIGIN KHÔNG CHẬM

```text
Exit: 99 (threshold p(95)>300 fail)
Checks: 100%
Fast lane p95: ~10ms (< 50ms OK)
Slow lane p95: ~45ms (FAIL: không > 300ms)
```

**Kết luận**: Slow origin không tạo ra delay có chủ đích. Test không có giá trị vì không có saturation để chứng minh isolation.

**Hành động**:
1. Kiểm tra slow origin có đang hoạt động đúng không -- có thể đang trả về response ngay lập tức thay vì delay 500-800ms.
2. Kiểm tra xem request có đang đến đúng upstream `lb-slow-origin` không.
3. Restart stack với `-Build` để đảm bảo slow origin image đúng.

### Scenario D: Một trong hai lane có HTTP failure

```text
Exit: 99
Checks: ~95%
Fast lane HTTP failed: 5%
Slow lane HTTP failed: 0%
```

**Kết luận**: Có vấn đề với upstream hoặc rate limit.

**Hành động**:
1. Xác định status code của request fail (429? 502? 503? 504?).
2. Nếu 429: quá tải, giảm rate.
3. Nếu 502/503: upstream không hoạt động, kiểm tra container.
4. Nếu 504: timeout -- `proxy_read_timeout` quá ngắn cho lane đó.
5. Thử tuned run với rate thấp hơn.

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "Aggregate p95 cao nghĩa là hệ thống chậm"

Người mới thường thấy aggregate `http_req_duration p95=580ms` và kết luận "hệ thống quá chậm". Nhưng con số này là trung bình trọng số của hai lane có latency khác biệt 100 lần.

**Sự thật**: Aggregate p95 trong case này là **con số vô nghĩa**. Hệ thống không chậm -- fast lane vẫn 12ms. Chỉ slow lane mới chậm, và đó là expected behavior. Đây chính là lý do case này sử dụng tagged threshold thay vì aggregate threshold.

### 12.2 Nghịch lý 2: "Threshold p95 > 300ms là ngược đời"

Tại sao lại có threshold yêu cầu latency **lớn hơn** một giá trị? Thông thường threshold yêu cầu latency nhỏ hơn.

**Sự thật**: `p(95)>300` là self-check để đảm bảo test có giá trị. Nếu slow origin không thực sự chậm, test không chứng minh được gì về isolation. Đây là một kỹ thuật test nâng cao: dùng threshold không chỉ để bắt lỗi, mà còn để **xác nhận điều kiện tiên quyết** của test.

### 12.3 Nghịch lý 3: "Chỉ cần test fast lane riêng là đủ"

Nếu fast lane chạy riêng và p95=12ms, điều đó chỉ chứng minh fast origin nhanh -- không chứng minh được nó vẫn nhanh khi slow lane đang bão hòa.

**Sự thật**: Isolation chỉ được chứng minh khi fast lane duy trì latency thấp **trong lúc** slow lane đang chạy song song với latency cao. Test fast lane riêng không đủ.

### 12.4 Nghịch lý 4: "Constant-vus cũng test được saturation"

Với constant-vus, khi slow lane latency tăng, slow lane sẽ tự nhiên gửi ít request hơn (vì mỗi VU bị block lâu hơn). Điều này làm giảm áp lực lên connection pool và che giấu vấn đề isolation.

**Sự thật**: Constant-arrival-rate mới là executor đúng cho case này vì nó duy trì áp lực không đổi bất kể latency -- tạo ra điều kiện khắc nghiệt nhất để test isolation.

### 12.5 Nghịch lý 5: "Isolation chỉ cần khác upstream là đủ"

Định nghĩa hai upstream block khác nhau (`lb_stable_origin` và `lb_slow_origin`) là cần nhưng chưa đủ. Nếu Nginx có cấu hình global connection pool (một số Nginx fork hoặc custom module), hai upstream có thể vẫn chia sẻ tài nguyên.

**Sự thật**: Isolation yêu cầu cả tách biệt về cấu hình (`upstream` block riêng) lẫn tách biệt về runtime (connection pool riêng, timeout riêng, buffer riêng). Case 11 test cả hai khía cạnh này.

---

## 13. Checklist trước khi chạy

### 13.1 Stack readiness

- [ ] Stack đã được start với `-TargetLayer full-no-cdn -ScaleApp 2`
- [ ] `docker ps` cho thấy tất cả containers đang running và healthy
- [ ] `curl http://localhost:80/` trả về 200
- [ ] `curl -s -I http://localhost:80/api/lb/isolation-fast-demo | findstr "X-Cache"` không có output

### 13.2 Environment variables

- [ ] `$env:BASE_URL = "http://localhost:80"` đã được set
- [ ] Nếu muốn tuned run: điều chỉnh `LB_ISOLATION_FAST_RATE`, `LB_ISOLATION_SLOW_RATE`, `LB_ISOLATION_DURATION_SECONDS`
- [ ] Không set `K6_CLOUD_TOKEN` nếu không muốn push kết quả lên cloud

### 13.3 Upstream health check

- [ ] `curl -s http://localhost:80/api/lb/isolation-fast-demo` -> 200 + `X-Upstream-Service: lb-stable-origin` + body `role: "stable"`
- [ ] `curl -s http://localhost:80/api/lb/isolation-slow-demo` -> 200 + `X-Upstream-Service: lb-slow-origin` + body `role: "slow"`
- [ ] Fast origin latency < 10ms (kiểm tra `latency_ms` trong body)
- [ ] Slow origin latency > 300ms (kiểm tra `latency_ms` trong body)

### 13.4 k6 installation

- [ ] `k6 version` hoạt động
- [ ] Script path: `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\11-saturation-isolation.js` tồn tại
- [ ] `shared.js` có định nghĩa `isolationFastDemo` và `isolationSlowDemo`

### 13.5 Test strategy

- [ ] Xác định mục tiêu: chứng minh isolation hay stress test?
- [ ] Nếu chứng minh isolation: dùng default rate (fast 25/s, slow 6/s), kỳ vọng fast p95 < 50ms
- [ ] Nếu stress test: tăng slow rate lên 15-20/s, kỳ vọng fast p95 vẫn < 50ms (nếu isolation đúng)
- [ ] Đã chuẩn bị sẵn baseline: fast lane chạy riêng p95 bao nhiêu? slow lane chạy riêng p95 bao nhiêu?

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Chỉ chạy fast lane với constant-arrival-rate (baseline)

```javascript
import { check } from 'k6';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbCapabilityApis, requestLB } from './shared.js';

const FAST_RATE = envInt('LB_ISOLATION_FAST_RATE', 25);
const DURATION_SECONDS = envInt('LB_ISOLATION_DURATION_SECONDS', 10);
const PRE_ALLOCATED_VUS = envInt('LB_ISOLATION_PRE_ALLOCATED_VUS', 8);
const MAX_VUS = envInt('LB_ISOLATION_MAX_VUS', 16);

export const options = {
  scenarios: {
    fast_lane_only: {
      executor: 'constant-arrival-rate',
      rate: FAST_RATE,
      timeUnit: '1s',
      duration: `${DURATION_SECONDS}s`,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    checks: ['rate==1'],
    'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],
  },
};

export default function () {
  const api = lbCapabilityApis.isolationFastDemo;
  const res = requestLB(api, {
    tags: { endpoint: api.name, lane: 'fast', mode: 'baseline' },
  });
  assertLBResponse(res, api, 'lb isolation fast baseline');
  check(res, {
    'fast baseline role stable': (r) => r.json('role') === 'stable',
  });
}
```

**Mục đích**: Có baseline latency của fast lane khi chạy một mình, để so sánh với khi chạy song song với slow lane.

### Variation 2: Tăng số lượng slow lane -- test với 3 slow origin khác nhau

```javascript
import { check } from 'k6';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbCapabilityApis, requestLB } from './shared.js';

const FAST_RATE = envInt('LB_ISO_FAST_RATE', 25);
const SLOW_A_RATE = envInt('LB_ISO_SLOW_A_RATE', 4);
const SLOW_B_RATE = envInt('LB_ISO_SLOW_B_RATE', 4);
const SLOW_C_RATE = envInt('LB_ISO_SLOW_C_RATE', 4);
const DURATION = `${envInt('LB_ISO_DURATION', 15)}s`;

export const options = {
  scenarios: {
    fast_lane: {
      executor: 'constant-arrival-rate',
      rate: FAST_RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 16, maxVUs: 32,
      exec: 'fastLane',
    },
    slow_lane_a: {
      executor: 'constant-arrival-rate',
      rate: SLOW_A_RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 16, maxVUs: 32,
      exec: 'slowLaneA',
    },
    slow_lane_b: {
      executor: 'constant-arrival-rate',
      rate: SLOW_B_RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 16, maxVUs: 32,
      exec: 'slowLaneB',
    },
    slow_lane_c: {
      executor: 'constant-arrival-rate',
      rate: SLOW_C_RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 16, maxVUs: 32,
      exec: 'slowLaneC',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],
    'http_req_duration{endpoint:lb_isolation_slow_demo}': ['p(95)>300'],
  },
};

function doFastLane() {
  const api = lbCapabilityApis.isolationFastDemo;
  const res = requestLB(api, { tags: { endpoint: api.name, lane: 'fast' } });
  assertLBResponse(res, api, 'fast multi-slow');
  check(res, { 'fast role stable': (r) => r.json('role') === 'stable' });
}

function doSlowLane(tag) {
  const api = lbCapabilityApis.isolationSlowDemo;
  const res = requestLB(api, { tags: { endpoint: api.name, lane: 'slow', slow_group: tag } });
  assertLBResponse(res, api, `slow ${tag}`);
  check(res, { [`slow ${tag} role slow`]: (r) => r.json('role') === 'slow' });
}

export function fastLane() { doFastLane(); }
export function slowLaneA() { doSlowLane('slow-a'); }
export function slowLaneB() { doSlowLane('slow-b'); }
export function slowLaneC() { doSlowLane('slow-c'); }
```

**Mục đích**: Test isolation khi có nhiều slow consumer cùng lúc -- mô phỏng tình huống nhiều service nền cùng chạy batch job.

### Variation 3: Test với weighted traffic thay vì fixed rate

```javascript
import { check, sleep } from 'k6';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbCapabilityApis, requestLB } from './shared.js';

const VUS = envInt('LB_ISO_MIXED_VUS', 20);
const DURATION = `${envInt('LB_ISO_MIXED_DURATION', 20)}s`;

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    checks: ['rate==1'],
    'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],
    'http_req_duration{endpoint:lb_isolation_slow_demo}': ['p(95)>300'],
  },
};

export default function () {
  // 80% fast, 20% slow
  const isFast = Math.random() < 0.8;
  const api = isFast ? lbCapabilityApis.isolationFastDemo : lbCapabilityApis.isolationSlowDemo;
  const lane = isFast ? 'fast' : 'slow';

  const res = requestLB(api, {
    tags: { endpoint: api.name, lane, mode: 'weighted-mix' },
  });

  assertLBResponse(res, api, `lb isolation ${lane}`);
  check(res, {
    [`lb isolation ${lane} role`]: (r) => r.json('role') === (isFast ? 'stable' : 'slow'),
  });

  sleep(Math.random() * 0.1);
}
```

**Mục đích**: Dùng weighted random thay vì hai scenario riêng biệt. Đơn giản hơn nhưng kém chính xác hơn vì không kiểm soát được rate chính xác của từng lane.

### Variation 4: Thêm ramp-up để quan sát quá trình bão hòa

```javascript
import { check } from 'k6';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbCapabilityApis, requestLB } from './shared.js';

const MAX_SLOW_RATE = envInt('LB_ISO_MAX_SLOW_RATE', 30);
const DURATION = `${envInt('LB_ISO_RAMP_DURATION', 30)}s`;

export const options = {
  scenarios: {
    fast_lane: {
      executor: 'constant-arrival-rate',
      rate: 25, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 16, maxVUs: 32,
      exec: 'fastLane',
    },
    slow_lane_ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 2, timeUnit: '1s',
      stages: [
        { target: 6, duration: '10s' },    // 0-10s: 2 -> 6 req/s
        { target: 15, duration: '10s' },   // 10-20s: 6 -> 15 req/s
        { target: 30, duration: '10s' },   // 20-30s: 15 -> 30 req/s
      ],
      preAllocatedVUs: 16, maxVUs: 48,
      exec: 'slowLane',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],
    'http_req_duration{endpoint:lb_isolation_slow_demo}': ['p(95)>300'],
  },
};

export function fastLane() {
  const api = lbCapabilityApis.isolationFastDemo;
  const res = requestLB(api, { tags: { endpoint: api.name, lane: 'fast' } });
  assertLBResponse(res, api, 'fast ramp');
  check(res, { 'fast role stable': (r) => r.json('role') === 'stable' });
}

export function slowLane() {
  const api = lbCapabilityApis.isolationSlowDemo;
  const res = requestLB(api, { tags: { endpoint: api.name, lane: 'slow' } });
  assertLBResponse(res, api, 'slow ramp');
  check(res, { 'slow role slow': (r) => r.json('role') === 'slow' });
}
```

**Mục đích**: Quan sát fast lane latency có thay đổi không khi slow lane rate tăng dần từ 2 lên 30 req/s. Nếu isolation hoạt động, fast lane p95 phải giữ nguyên trong suốt quá trình ramp.

### Variation 5: Thêm custom metric để đo saturation level

```javascript
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbCapabilityApis, requestLB } from './shared.js';

const FAST_RATE = envInt('LB_ISO_FAST_RATE', 25);
const SLOW_RATE = envInt('LB_ISO_SLOW_RATE', 6);
const DURATION = `${envInt('LB_ISO_DURATION', 10)}s`;

// Custom metric: đo latency gap giữa fast và slow
const isolationGap = new Trend('lb_isolation_latency_gap_ms');

export const options = {
  scenarios: {
    fast_lane: {
      executor: 'constant-arrival-rate',
      rate: FAST_RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 16, maxVUs: 32,
      exec: 'fastLane',
    },
    slow_lane: {
      executor: 'constant-arrival-rate',
      rate: SLOW_RATE, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: 16, maxVUs: 32,
      exec: 'slowLane',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    'http_req_duration{endpoint:lb_isolation_fast_demo}': ['p(95)<50'],
    'http_req_duration{endpoint:lb_isolation_slow_demo}': ['p(95)>300'],
    lb_isolation_latency_gap_ms: ['p(95)>200'],  // Gap phải > 200ms
  },
};

export function fastLane() {
  const api = lbCapabilityApis.isolationFastDemo;
  const res = requestLB(api, { tags: { endpoint: api.name, lane: 'fast' } });
  isolationGap.add(res.timings.duration);
  assertLBResponse(res, api, 'fast gap');
}

export function slowLane() {
  const api = lbCapabilityApis.isolationSlowDemo;
  const res = requestLB(api, { tags: { endpoint: api.name, lane: 'slow' } });
  // Không add vào isolationGap -- chỉ đo fast lane latency
  assertLBResponse(res, api, 'slow gap');
}
```

**Mục đích**: Đo latency gap giữa fast và slow lane như một metric bổ sung. Nếu gap < 200ms, có thể isolation không còn hiệu quả (fast lane bị kéo chậm).

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Đọc aggregate p95 để kết luận

```text
SAI: Thấy http_req_duration p95=580ms -> kết luận "hệ thống chậm, cần tối ưu".
```

**Vấn đề**: Aggregate p95 trộn fast (12ms) và slow (600ms), cho ra con số không có ý nghĩa. Bạn không thể phân biệt "hệ thống chậm toàn bộ" và "chỉ slow lane chậm".

**Cách đúng**: Luôn đọc tagged metric: `http_req_duration{endpoint:lb_isolation_fast_demo}` và `http_req_duration{endpoint:lb_isolation_slow_demo}` riêng biệt.

### 15.2 Anti-pattern 2: Bỏ qua tag `endpoint` trong request

```text
SAI: requestLB(api) không có tags.endpoint -> threshold không filter được -> false pass.
```

**Vấn đề**: Không có tag `endpoint`, tất cả threshold dùng aggregate metric. Bạn sẽ thấy `http_req_duration p(95)<50` pass (vì 80% request là fast, p95 aggregate vẫn thấp) nhưng thực tế fast lane có thể đã bị kéo chậm.

**Cách đúng**: Luôn gán `tags: { endpoint: api.name }` cho mỗi request. Đây là yêu cầu bắt buộc cho case này.

### 15.3 Anti-pattern 3: Dùng constant-vus thay vì constant-arrival-rate

```text
SAI: Đổi executor thành constant-vus vì "quen thuộc hơn".
```

**Vấn đề**: Với constant-vus, slow lane sẽ tự động giảm request rate khi latency tăng, làm giảm áp lực lên connection pool và che giấu saturation contagion.

**Cách đúng**: Giữ nguyên constant-arrival-rate. Đây là lựa chọn thiết kế có chủ đích.

### 15.4 Anti-pattern 4: Gộp hai lane vào một scenario

```text
SAI: Dùng một default function với weighted random 80% fast / 20% slow.
```

**Vấn đề**: Không kiểm soát được rate chính xác của từng lane. Nếu slow request bắt đầu chậm, VUs bị block và tỉ lệ fast/slow thay đổi -- làm nhiễu kết quả.

**Cách đúng**: Dùng hai scenario riêng với `exec` function riêng, mỗi scenario có rate được kiểm soát độc lập.

### 15.5 Anti-pattern 5: Không có baseline

```text
SAI: Chạy case 11 lần đầu, thấy fast p95=45ms, kết luận "isolation hoạt động".
```

**Vấn đề**: 45ms có thể là normal latency của fast lane, hoặc có thể đã bị kéo chậm từ 10ms lên 45ms. Bạn không biết nếu không có baseline.

**Cách đúng**: Luôn chạy fast lane riêng (Variation 1) để có baseline latency. So sánh baseline với latency khi chạy song song. Nếu khác biệt > 20%, cần investigate.

### 15.6 Anti-pattern 6: Bỏ qua `X-LB-Isolation-Class` header

```text
SAI: Chỉ check upstream và status, không check X-LB-Isolation-Class.
```

**Vấn đề**: Có thể upstream đúng nhưng isolation class bị gán sai -- request fast lane có thể được gán `X-LB-Isolation-Class=slow` hoặc ngược lại. Điều này gây sai lệch trong monitoring và alerting thực tế.

**Cách đúng**: Thêm check cho `X-LB-Isolation-Class` trong script, hoặc ít nhất kiểm tra thủ công bằng curl trước khi chạy.

---

## 16. Real validation data

### 16.1 Individual run

```text
     script: 11-saturation-isolation.js
     profile: full-no-cdn
     fast_rate: 25/s
     slow_rate: 6/s
     duration: 10s
     preAllocatedVUs: 16
     maxVUs: 32

     ✓ lb isolation fast lane status
     ✓ lb isolation fast lane served by nginx
     ✓ lb isolation fast lane upstream matches
     ✓ lb isolation fast lane request id present
     ✓ lb isolation fast lane no cache header
     ✓ lb isolation fast lane role stable
     ✓ lb isolation slow lane status
     ✓ lb isolation slow lane served by nginx
     ✓ lb isolation slow lane upstream matches
     ✓ lb isolation slow lane request id present
     ✓ lb isolation slow lane no cache header
     ✓ lb isolation slow lane role slow

     checks.........................: 100.00% ✓ 1872  ✗ 0
     http_req_failed...............: 0.00%   ✓ 312   ✗ 0
     http_req_duration.............: avg=125ms min=3ms med=8ms max=780ms p(90)=590ms p(95)=610ms
     http_reqs.....................: 312
     iterations....................: 312
     vus............................: 8
     vus_max........................: 16

     ✓ checks: rate==1
     ✓ http_req_failed{endpoint:lb_isolation_fast_demo}: rate==0
     ✓ http_req_duration{endpoint:lb_isolation_fast_demo}: p(95)<50
     ✓ http_req_failed{endpoint:lb_isolation_slow_demo}: rate==0
     ✓ http_req_duration{endpoint:lb_isolation_slow_demo}: p(95)>300

     Exit: 0
     Result: PASS
```

**Phân tích**:
- 312 iteration trong 10s = 31.2 req/s (đúng bằng 25 + 6 = 31 target rate).
- VUs = 8 (thấp hơn preAllocatedVUs=16 vì latency không quá cao).
- Fast lane p95 khoảng 4-12ms -- dưới ngưỡng 50ms.
- Slow lane p95 khoảng 616ms -- trên ngưỡng 300ms.
- Tất cả threshold pass, tất cả checks pass -> isolation được chứng minh.

### 16.2 Tuned full profile run

```text
     checks.........................: 100.00% ✓ 1866  ✗ 0
     http_req_failed...............: 0.00%   ✓ 311   ✗ 0
     http_req_duration.............: avg=118ms p(95)=608ms

     Exit: 0
     Result: PASS
```

### 16.3 Phân tích per-lane latency

| Lane | Requests (ước tính) | p95 latency | Threshold | Kết quả |
| --- | --- | --- | --- | --- |
| Fast (`lb_isolation_fast_demo`) | ~250 | ~4.29ms | < 50ms | PASS |
| Slow (`lb_isolation_slow_demo`) | ~62 | ~616.27ms | > 300ms | PASS |
| **Aggregate (KHÔNG DÙNG)** | **312** | **~610ms** | **Không có** | **VÔ NGHĨA** |

### 16.4 Kiểm tra nhanh bằng curl (manual validation)

```powershell
# Kiểm tra fast lane
$fastResponse = Invoke-WebRequest -Uri "http://localhost:80/api/lb/isolation-fast-demo" -UseBasicParsing
$fastBody = $fastResponse.Content | ConvertFrom-Json
Write-Host "Fast lane:"
Write-Host "  Status: $($fastResponse.StatusCode)"
Write-Host "  X-Upstream-Service: $($fastResponse.Headers['X-Upstream-Service'])"
Write-Host "  X-LB-Isolation-Class: $($fastResponse.Headers['X-LB-Isolation-Class'])"
Write-Host "  Role: $($fastBody.role)"
Write-Host "  Latency: $($fastBody.latency_ms)ms"

# Kiểm tra slow lane
$slowResponse = Invoke-WebRequest -Uri "http://localhost:80/api/lb/isolation-slow-demo" -UseBasicParsing
$slowBody = $slowResponse.Content | ConvertFrom-Json
Write-Host "Slow lane:"
Write-Host "  Status: $($slowResponse.StatusCode)"
Write-Host "  X-Upstream-Service: $($slowResponse.Headers['X-Upstream-Service'])"
Write-Host "  X-LB-Isolation-Class: $($slowResponse.Headers['X-LB-Isolation-Class'])"
Write-Host "  Role: $($slowBody.role)"
Write-Host "  Latency: $($slowBody.latency_ms)ms"
```

Output kỳ vọng:
```text
Fast lane:
  Status: 200
  X-Upstream-Service: lb-stable-origin
  X-LB-Isolation-Class: fast
  Role: stable
  Latency: 3ms
Slow lane:
  Status: 200
  X-Upstream-Service: lb-slow-origin
  X-LB-Isolation-Class: slow
  Role: slow
  Latency: 612ms
```

---

## 17. Reference

### 17.1 Các file liên quan

| File | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\11-saturation-isolation.js` | Script chính của case |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\shared.js` | Shared library: `lbCapabilityApis.isolationFastDemo`, `isolationSlowDemo`, `assertLBResponse()`, `requestLB()` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | `envInt()`, `envString()`, `requestApi()` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\case-catalog.json` | Catalog định nghĩa case 11, topology, expected signals |
| `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Nginx configuration với upstream isolation blocks |
| `E:\Projects\k6\k6-metrics-server\scripts\run-lb-capabilities.ps1` | Runner script |

### 17.2 Các case liên quan trong series

| Case | Mối liên hệ |
| --- | --- |
| [Case 07 -- Rate limit/connection pressure](./07_rate-limit-and-connection-pressure.md) | Cùng dùng constant-arrival-rate, nhưng test shedding thay vì isolation |
| [Case 09 -- Passive outlier ejection](./09_passive-outlier-ejection.md) | Cùng liên quan đến upstream health, nhưng test ejection thay vì pool isolation |
| [Case 10 -- Weighted fairness under load](./10_weighted-fairness-under-load.md) | Cùng test dưới concurrent load, nhưng test canary fairness thay vì isolation |
| [Case 12 -- Slow origin timeouts](./12_slow-origin-timeouts.md) | Cùng liên quan đến slow origin, nhưng test timeout policy thay vì pool isolation. Case 11 là "slow origin không được làm chậm fast origin"; case 12 là "slow origin phải bị cắt nếu quá chậm" |

### 17.3 Tài liệu tổng quan

| File | Nội dung |
| --- | --- |
| [00_overview.md](./00_overview.md) | Tổng quan series LB/Gateway layer, mental model, key concepts |
| [13_validation-and-chart-analysis.md](./13_validation-and-chart-analysis.md) | Hướng dẫn validation và phân tích chart cho toàn bộ LB series |
| [RUN_GUIDE.md](../RUN_GUIDE.md) | Hướng dẫn chạy toàn bộ test suite |

### 17.4 Kiến thức nền

| Chủ đề | Tài liệu tham khảo |
| --- | --- |
| Nginx upstream module | [nginx.org: upstream](https://nginx.org/en/docs/http/ngx_http_upstream_module.html) |
| Nginx keepalive directive | [nginx.org: keepalive](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive) |
| Nginx proxy_read_timeout | [nginx.org: proxy_read_timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout) |
| k6 constant-arrival-rate executor | [k6.io: constant-arrival-rate](https://k6.io/docs/using-k6/scenarios/executors/constant-arrival-rate/) |
| k6 multiple scenarios | [k6.io: scenarios](https://k6.io/docs/using-k6/scenarios/) |
| k6 tagged thresholds | [k6.io: thresholds on tags](https://k6.io/docs/using-k6/thresholds/#thresholds-on-tags) |
| Saturation contagion pattern | [Microsoft: Circuit Breaker pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker) |
