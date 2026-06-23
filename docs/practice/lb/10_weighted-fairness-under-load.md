# Case 10: Weighted Fairness Under Load

> **Case ID:** `lb-10-weighted-fairness-under-load`
> **Script:** `10-weighted-fairness-under-load.js`
> **Profile:** `full-no-cdn`
> **Proof:** Tỷ lệ canary share vẫn nằm trong band kỳ vọng (8%-22%) khi có sustained load 60 req/s -- Nginx weighted routing không bị sai lệch dưới áp lực

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

Một nền tảng thương mại điện tử đang triển khai cơ chế **canary release** -- phiên bản mới của dịch vụ (canary) được triển khai song song với phiên bản hiện tại (stable), và Nginx được cấu hình để route một tỷ lệ nhỏ traffic (ví dụ: 15%) sang canary. Phần lớn traffic (85%) vẫn đi stable.

Trong quá trình thử nghiệm, đội ngũ vận hành nhận thấy một vấn đề:

```text
Test với 1 VU (case 08 -- Weighted Canary Routing): 
  → Tỷ lệ canary đúng ~15%, mọi thứ ổn.

Thực tế production (hàng trăm request/giây):
  → Tỷ lệ canary dao động mạnh: lúc 5%, lúc 25%
  → Rollout không ổn định: người dùng thấy version mới không nhất quán
  → Team không tự tin để tăng canary share lên 30%, 50%, 100%
```

Đây là vấn đề kinh điển của weighted routing: **thuật toán hoạt động đúng với sample nhỏ, nhưng bị sai lệch dưới tải cao**. Case 10 được thiết kế để kiểm chứng điều ngược lại: Nginx weighted routing vẫn giữ đúng tỷ lệ ngay cả khi có sustained load.

### 1.2 Ba tình huống production điển hình

**Tình huống A -- Rollout phiên bản mới của products-service:**

```text
Products-service v2 được triển khai trên canary instances. Nginx cấu hình
split_clients 15% sang canary. Nếu tỷ lệ thực tế là 25% thay vì 15%:
  → 25% người dùng thấy giao diện mới (có thể chưa ổn định)
  → Nếu có lỗi trong v2, 25% người dùng bị ảnh hưởng thay vì 15% 
  → Tỷ lệ lỗi cao hơn dự kiến → ops team bị page lúc 3 giờ sáng
```

**Tình huống B -- A/B test với variant mới:**

```text
Marketing team muốn A/B test layout mới cho 10% người dùng. Nginx cấu hình
split_clients 10% sang variant B. Nếu tỷ lệ thực tế chỉ là 4%:
  → Không đủ sample size để kết luận thống kê
  → A/B test kéo dài gấp đôi thời gian dự kiến
  → Marketing team mất niềm tin vào nền tảng
```

**Tình huống C -- Graceful shutdown của canary instances:**

```text
Khi giảm canary share từ 50% về 0% (kết thúc rollout), nếu weighted routing
không fairness dưới tải, một số canary instances có thể vẫn nhận traffic 
sau khi đã shutdown → request thất bại.
```

### 1.3 Sự khác biệt giữa case 08 và case 10

| Khía cạnh | Case 08 (Weighted Canary Routing) | Case 10 (Weighted Fairness Under Load) |
| --- | --- | --- |
| Mô hình tải | `vus: 1, iterations: 1` với sample loop | `constant-arrival-rate`, 60 req/s, 12s duration |
| Mục tiêu | Chứng minh routing hoạt động (forced stable, forced canary, weighted sample) | Chứng minh tỷ lệ ổn định dưới tải |
| Sample size | 120 request tuần tự | ~720 request trong 12 giây |
| Concurrency | Không có | Có (preAllocatedVUs=20, maxVUs=40) |
| Primary proof | `X-LB-Release-Channel` đúng | `lb_canary_observed` rate trong band |
| Custom metric | Không | Có (`lb_canary_observed` là Rate metric) |

Case 08 trả lời câu hỏi "có route đúng không?" Case 10 trả lời câu hỏi "có route đúng **dưới tải** không?"

---

## 2. LB capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh Nginx weighted routing fairness dưới tải:

> **Khi có sustained load (constant-arrival-rate 60 req/s), tỷ lệ phân phối traffic giữa stable và canary vẫn nằm trong band kỳ vọng (8%-22%) -- không bị sai lệch do concurrency, connection reuse, hoặc timing artifact.**

Cụ thể hơn, ba khả năng được chứng minh:

| Khả năng | Mô tả | Evidence trong case |
| --- | --- | --- |
| Weighted routing dưới tải | `split_clients` hoạt động đúng với sustained open-model load | `lb_canary_observed` rate nằm trong `[MIN_SHARE, MAX_SHARE]` |
| Custom metric collection | k6 thu thập và aggregate custom metric `lb_canary_observed` | Threshold `rate>0.08 rate<0.22` không bị vi phạm |
| Zero failure under load | Không có request thất bại nào dù đang chịu tải cao | `http_req_failed: rate==0` |

### 2.2 Sơ đồ traffic flow

```text
                  k6 (constant-arrival-rate: 60 req/s)
                  ├─ VU-1: GET /api/lb/canary-demo
                  ├─ VU-2: GET /api/lb/canary-demo
                  ├─ VU-3: GET /api/lb/canary-demo
                  ├─ ...
                  └─ VU-20: GET /api/lb/canary-demo
                           │
                           ▼
                  ┌─────────────────────┐
                  │  Nginx LB/Gateway   │
                  │  split_clients 15%  │
                  └──────┬──────┬───────┘
                         │      │
                    ~85% │      │ ~15%
                         ▼      ▼
                  ┌─────────┐ ┌──────────┐
                  │ stable  │ │ canary   │
                  │ origin  │ │ origin   │
                  └─────────┘ └──────────┘
                  
                  Custom metric:
                    lb_canary_observed = count(channel=='canary') / total
                    Expected: 0.08 <= rate <= 0.22
```

### 2.3 Tại sao capability này quan trọng

```text
Không có fairness test:
  "Tôi cấu hình canary 15%, test 1 VU thấy đúng, triển khai production."
  → 3 ngày sau: canary thực tế là 8%, rollout kéo dài gấp đôi.
  → Ops team: "Weighted routing bị lỗi!"
  → Thực ra: weighted routing vẫn đúng, nhưng không ai test với load thật.

Có fairness test:
  "Tôi cấu hình canary 15%, test với 60 req/s trong 12 giây, 
   canary observed 12.62% -- nằm trong band."
  → Triển khai production với confidence.
  → Rollout đúng tiến độ, canary share như dự kiến.
```

---

## 3. Vì sao phải test ở LB layer

### 3.1 Weighted routing là logic của LB

```text
Các layer và trách nhiệm:

App layer:       "Tôi là stable" hoặc "Tôi là canary" → trả về role trong body
LB layer:        split_clients 15% → quyết định request nào đi đâu
CDN layer:       (không liên quan -- thậm chí có thể cache response cũ)

Chỉ LB layer mới biết:
  - Thuật toán weighted routing đang dùng gì? (hash, random, round-robin weighted?)
  - Tỷ lệ thực tế có khớp với cấu hình không?
  - Header X-LB-Release-Channel có được gắn đúng không?
```

### 3.2 Concurrency làm lộ defect của weighted routing

Nhiều thuật toán weighted routing hoạt động đúng trong môi trường tuần tự (1 request tại một thời điểm) nhưng sai lệch khi có concurrency:

| Thuật toán | Tuần tự (1 VU) | Concurrent (20 VU) | Ghi chú |
| --- | --- | --- | --- |
| Hash-based (IP/client-id) | Đúng nếu phân phối key đều | Có thể sai lệch nếu hash không uniform dưới tải | Dùng `split_clients` với biến `$remote_addr` |
| Random (ngẫu nhiên) | Hội tụ về expected ratio khi sample đủ lớn | Hội tụ nhanh hơn (nhiều sample hơn) | Dùng `split_clients` với biến `$request_id` |
| Round-robin weighted | Đúng nếu Nginx worker xử lý request xen kẽ | Có thể sai lệch nếu 1 worker xử lý nhiều request dồn dập | Phụ thuộc vào Nginx worker model |

Case 10 dùng `constant-arrival-rate` để tạo ra môi trường concurrent thực sự, nơi thuật toán weighted routing bị "thử thách".

### 3.3 Phân biệt case 08 và case 10 ở LB layer

```text
Case 08 (single VU, sequential):
  for (let i = 0; i < 120; i++) {
    const res = requestLB(api, { ... });  // Tuần tự, từng request một
    // ...
  }

Case 10 (open model, concurrent):
  executor: 'constant-arrival-rate',
  rate: 60,           // 60 request mới mỗi giây
  preAllocatedVUs: 20, // 20 VU sẵn sàng chạy đồng thời
  maxVUs: 40,          // Có thể scale lên 40 VU
```

Case 10 mô phỏng production thực tế, nơi nhiều request đến cùng lúc, VU chạy song song, connection được tái sử dụng.

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌──────────────────────────────┐
                          │    k6 test script             │
                          │  (10-weighted-fairness-      │
                          │   under-load.js)             │
                          │                               │
                          │  constant-arrival-rate: 60/s  │
                          │  preAllocatedVUs: 20          │
                          │  maxVUs: 40                   │
                          │  duration: 12s                │
                          └────────────┬─────────────────┘
                                       │
                          public path  │ GET /api/lb/canary-demo
                                       │ X-Canary-Key: fair-<vu>-<iter>-<random>
                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx LB/Gateway)                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  split_clients configuration:                              │  │
│  │    ~85% → stable origin (lb-stable-origin)                 │  │
│  │    ~15% → canary origin (lb-canary-origin)                 │  │
│  │                                                             │  │
│  │  Header gắn: X-LB-Release-Channel: stable | canary         │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `full-no-cdn` (bắt buộc) | Không có `X-Cache` trong response |
| `BASE_URL` | `http://localhost:80` | `curl -sI http://localhost:80/` thấy `Server: nginx` |
| Nginx canary routing | `split_clients` hoặc equivalent weighted routing | Response có `X-LB-Release-Channel: stable` hoặc `canary` |
| Stable origin | `lb-stable-origin` | Response `role: stable` |
| Canary origin | `lb-canary-origin` | Response `role: canary` |

### 4.3 Stack khởi động

```powershell
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
```

Đợi tất cả service healthy (khoảng 30-60 giây). Kiểm tra:

```powershell
# Xác nhận canary routing hoạt động
curl -s http://localhost:80/api/lb/canary-demo | ConvertFrom-Json
# Kết quả: role = "stable" hoặc "canary"

# Gọi nhiều lần để thấy cả hai channel
for ($i=0; $i -lt 10; $i++) {
  curl -s http://localhost:80/api/lb/canary-demo | ConvertFrom-Json | Select-Object role
}
```

### 4.4 Precondition

Không có precondition đặc biệt. Khác với case 09 (cần đợi fail_timeout), case 10 có thể chạy lại nhiều lần liên tiếp không cần chờ đợi. Tuy nhiên:

- Nếu Nginx config `split_clients` dùng biến cố định (ví dụ: `$remote_addr`), kết quả có thể không thay đổi giữa các lần chạy vì k6 chạy từ cùng một IP. Đây là lý do script này dùng `X-Canary-Key` với giá trị ngẫu nhiên.
- Nếu stable và canary origin không hoạt động, mọi request đều fail -> case fail.

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\lb\10-weighted-fairness-under-load.js
```

### 5.2 Import và dependency

```javascript
import { check } from 'k6';
import { Rate } from 'k6/metrics';

import { envFloat, envInt } from '../shared/common.js';
import { lbCapabilityApis, requestLB, responseHeader } from './shared.js';
```

| Import | Nguồn | Vai trò |
| --- | --- | --- |
| `check` | `k6` | Hàm built-in: kiểm tra assertion |
| `Rate` | `k6/metrics` | Custom metric type: tỷ lệ (true/total) |
| `envFloat` | `../shared/common.js` | Đọc biến môi trường kiểu float với fallback |
| `envInt` | `../shared/common.js` | Đọc biến môi trường kiểu integer với fallback |
| `lbCapabilityApis` | `./shared.js` | Object chứa định nghĩa các API endpoint |
| `requestLB` | `./shared.js` | Gửi HTTP request qua LB (:80) |
| `responseHeader` | `./shared.js` | Đọc case-insensitive header từ response |

### 5.3 Biến môi trường

```javascript
const SAMPLE_RATE = envInt('LB_CANARY_FAIRNESS_RATE', 60);
const SAMPLE_DURATION = `${envInt('LB_CANARY_FAIRNESS_DURATION_SECONDS', 12)}s`;
const PRE_ALLOCATED_VUS = envInt('LB_CANARY_FAIRNESS_PRE_ALLOCATED_VUS', 20);
const MAX_VUS = envInt('LB_CANARY_FAIRNESS_MAX_VUS', 40);
const MIN_CANARY_SHARE = envFloat('LB_CANARY_FAIRNESS_MIN_SHARE', 0.08);
const MAX_CANARY_SHARE = envFloat('LB_CANARY_FAIRNESS_MAX_SHARE', 0.22);
```

| Biến môi trường | Mặc định | Ý nghĩa | Cách ghi đè |
| --- | --- | --- | --- |
| `LB_CANARY_FAIRNESS_RATE` | `60` | Số request mới mỗi giây (constant-arrival-rate) | `$env:LB_CANARY_FAIRNESS_RATE = "90"` |
| `LB_CANARY_FAIRNESS_DURATION_SECONDS` | `12` | Thời gian chạy (giây) | `$env:LB_CANARY_FAIRNESS_DURATION_SECONDS = "20"` |
| `LB_CANARY_FAIRNESS_PRE_ALLOCATED_VUS` | `20` | Số VU được pre-allocate | `$env:LB_CANARY_FAIRNESS_PRE_ALLOCATED_VUS = "30"` |
| `LB_CANARY_FAIRNESS_MAX_VUS` | `40` | Số VU tối đa được scale | `$env:LB_CANARY_FAIRNESS_MAX_VUS = "60"` |
| `LB_CANARY_FAIRNESS_MIN_SHARE` | `0.08` (8%) | Tỷ lệ canary tối thiểu chấp nhận được | `$env:LB_CANARY_FAIRNESS_MIN_SHARE = "0.05"` |
| `LB_CANARY_FAIRNESS_MAX_SHARE` | `0.22` (22%) | Tỷ lệ canary tối đa chấp nhận được | `$env:LB_CANARY_FAIRNESS_MAX_SHARE = "0.30"` |

### 5.4 Custom metric: `lb_canary_observed`

```javascript
const canaryObserved = new Rate('lb_canary_observed');
```

Đây là **custom metric** loại `Rate` -- một metric do người dùng định nghĩa, không phải built-in metric của k6.

| Thuộc tính | Giá trị | Ý nghĩa |
| --- | --- | --- |
| Tên | `lb_canary_observed` | Xuất hiện trong output summary và dashboard |
| Loại | `Rate` | Tỷ lệ: số lần true / tổng số lần gọi `add()` |
| Cách ghi | `canaryObserved.add(channel === 'canary')` | `true` nếu channel là canary, `false` nếu stable |
| Threshold | `rate>0.08`, `rate<0.22` | Rate phải nằm trong khoảng 8%-22% |

**Cách hoạt động của `Rate` metric:**

```text
canaryObserved.add(true)   → tăng numerator và denominator lên 1
canaryObserved.add(false)  → chỉ tăng denominator lên 1
canaryObserved.add(true)   → "    "    "       "      "    "
...

Kết quả: lb_canary_observed = 2/3 = 0.6667 (66.67%)
```

### 5.5 options block -- OPEN MODEL

```javascript
export const options = {
  scenarios: {
    fairness: {
      executor: 'constant-arrival-rate',
      rate: SAMPLE_RATE,           // 60 request mới mỗi giây
      timeUnit: '1s',
      duration: SAMPLE_DURATION,   // 12 giây
      preAllocatedVUs: PRE_ALLOCATED_VUS,  // 20 VU sẵn sàng
      maxVUs: MAX_VUS,                     // Tối đa 40 VU
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    lb_canary_observed: [`rate>${MIN_CANARY_SHARE}`, `rate<${MAX_CANARY_SHARE}`],
  },
  tags: {
    scenario: 'lb_weighted_fairness_under_load',
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};
```

**Phân tích từng phần của options:**

#### Scenario `fairness` -- constant-arrival-rate

```text
executor: 'constant-arrival-rate'
  → OPEN MODEL: k6 tự quyết định số VU cần thiết để đạt target rate
  → Không giống constant-vus (đóng -- cố định số VU)
  → Mỗi giây, k6 cố gắng bắt đầu SAMPLE_RATE iteration mới

rate: 60, timeUnit: '1s'
  → 60 iteration mới mỗi giây
  → Tổng cộng: 60 * 12 = 720 iterations trong 12 giây

preAllocatedVUs: 20
  → 20 VU được tạo sẵn từ đầu, sẵn sàng nhận iteration
  → Tiết kiệm thời gian khởi tạo VU khi iteration mới bắt đầu

maxVUs: 40
  → Nếu 20 VU không đủ để đạt 60 req/s (mỗi request mất > 333ms),
    k6 có thể scale lên tới 40 VU

##### Phân tích executor: vì sao dùng `constant-arrival-rate` cho case này?

Đây là case thứ 2 trong LB suite dùng open model (sau case 07).

**Yêu cầu của case:**

```text
1. Rate cố định để test fairness: 60 req/s chính xác trong 12s
   → Muốn verify "dưới tải ổn định, canary có nhận đúng ~20% traffic không?"
   → Nếu dùng constant-vus: rate dao động → tỷ lệ canary dao động → không verify được
   → constant-arrival-rate: rate LUÔN 60/s → sample đủ lớn (720 iter) → tỷ lệ hội tụ

2. Cần sample LỚN và ĐỀU: 720 iteration trong 12s
   → Tỷ lệ canary chỉ có ý nghĩa thống kê với sample lớn
   → Rate ổn định đảm bảo sample không bị "cluster" vào lúc server nhanh
```

**So sánh executor:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **constant-arrival-rate** (đang dùng) | ✅ **ĐÚNG** | Rate cố định 60/s. 720 sample deterministic. Open model đảm bảo rate không đổi. |
| constant-vus | ❌ SAI | Rate dao động theo response time → tỷ lệ canary không ổn định → không verify được fairness. |
| shared-iterations | ❌ SAI | Cần tổng iter cố định. Fairness cần rate THEO THỜI GIAN để tạo áp lực liên tục. |
| per-vu-iterations | ❌ SAI | Cần iter/VU cố định. Case này cần sustained rate, không phải quota. |
| ramping-arrival-rate | ⚠️ Có thể nếu cần ramp | Nếu muốn test "tăng rate đến khi fairness break". Case này dùng rate cố định. |

**Key insight**: Fairness test CẦN rate ổn định. Nếu rate dao động, tỷ lệ
canary dao động theo → không phân biệt được "fairness sai" vs "sample không
đủ". `constant-arrival-rate` cho 720 sample đều đặn → tỷ lệ hội tụ về true
share.
  → Công thức: VUs_needed = rate * avg_iteration_duration
    Với rate=60, nếu mỗi iteration mất 500ms: cần 60 * 0.5 = 30 VU
```

#### Threshold đặc biệt: `lb_canary_observed`

```text
lb_canary_observed: [`rate>0.08`, `rate<0.22`]
```

Đây là threshold trên **custom metric**. Nó nói rằng:

- `rate>0.08`: tỷ lệ canary phải lớn hơn 8% (nếu thấp hơn -> quá ít traffic đến canary -> FAIL)
- `rate<0.22`: tỷ lệ canary phải nhỏ hơn 22% (nếu cao hơn -> quá nhiều traffic đến canary -> FAIL)

Khoảng chấp nhận [8%, 22%] rộng hơn giá trị cấu hình (15%) vì:

1. Biến thiên thống kê (statistical variance): với 720 request, tỷ lệ 15% có standard deviation khoảng 1.3%
2. `split_clients` không đảm bảo chính xác tuyệt đối 15% -- nó là probabilistic
3. Khoảng rộng hơn cho phép chạy trên các môi trường khác nhau mà không bị false negative

### 5.6 `default()` -- logic chính

```javascript
export default function () {
  const api = lbCapabilityApis.canaryDemo;
  const key = `fair-${__VU}-${__ITER}-${Math.random().toString(16).slice(2)}`;
  const res = requestLB(api, {
    headers: {
      'X-Canary-Key': key,
    },
    tags: {
      endpoint: api.name,
      route_mode: 'weighted_fairness',
    },
  });

  const channel = responseHeader(res, 'X-LB-Release-Channel');
  canaryObserved.add(channel === 'canary');

  check(res, {
    'lb canary fairness status': (r) => r.status === 200,
    'lb canary fairness valid channel': () =>
      channel === 'stable' || channel === 'canary',
    'lb canary fairness no cache header': (r) =>
      !responseHeader(r, 'X-Cache'),
  });
}
```

**Phân tích chi tiết từng bước:**

#### Bước 1: Tạo key ngẫu nhiên

```javascript
const key = `fair-${__VU}-${__ITER}-${Math.random().toString(16).slice(2)}`;
```

```text
Mục đích: Mỗi request có một key duy nhất để Nginx weighted routing 
         phân phối đều, không bị ảnh hưởng bởi sticky session hay 
         hash collision.

__VU:     ID của Virtual User hiện tại (1 đến maxVUs)
__ITER:   Số iteration của VU này
Math.random().toString(16).slice(2): Chuỗi hex ngẫu nhiên ~10-13 ký tự

Ví dụ key: "fair-3-15-a1b2c3d4e5f6"
```

**Tại sao không dùng `$remote_addr`?** Vì tất cả k6 VU đều chạy từ cùng một IP (localhost hoặc Docker network). Nếu Nginx `split_clients` dùng `$remote_addr`, tất cả request sẽ đi cùng một channel -> không test được fairness.

**Tại sao không dùng `$request_id`?** Đây cũng là lựa chọn tốt. Tùy vào Nginx config, `$request_id` là unique cho mỗi request và phân phối đều.

**Tại sao thêm `Math.random()`?** Để đảm bảo key thực sự ngẫu nhiên và phân phối đều, không bị pattern từ `__VU` và `__ITER`.

#### Bước 2: Gửi request và đọc channel

```javascript
const res = requestLB(api, {
  headers: {
    'X-Canary-Key': key,
  },
  tags: {
    endpoint: api.name,
    route_mode: 'weighted_fairness',
  },
});

const channel = responseHeader(res, 'X-LB-Release-Channel');
```

```text
requestLB gửi GET đến /api/lb/canary-demo với header X-Canary-Key.

Nginx nhận request, dùng giá trị X-Canary-Key (hoặc biến khác) 
trong split_clients để quyết định route sang stable hay canary.

Response chứa header X-LB-Release-Channel: "stable" hoặc "canary".
Body cũng chứa role: "stable" hoặc "canary".
```

#### Bước 3: Ghi custom metric

```javascript
canaryObserved.add(channel === 'canary');
```

```text
Nếu channel === 'canary'  → add(true)  → tăng numerator và denominator
Nếu channel === 'stable'  → add(false) → chỉ tăng denominator

Sau 720 request, nếu 91 request là canary:
  lb_canary_observed rate = 91/720 = 0.1264 = 12.64%
  → 12.64% nằm trong [8%, 22%] → threshold PASS
```

#### Bước 4: Checks

```javascript
check(res, {
  'lb canary fairness status': (r) => r.status === 200,
  'lb canary fairness valid channel': () =>
    channel === 'stable' || channel === 'canary',
  'lb canary fairness no cache header': (r) =>
    !responseHeader(r, 'X-Cache'),
});
```

| Check | Ý nghĩa | Tại sao quan trọng |
| --- | --- | --- |
| Status 200 | Tất cả request thành công | Dù có tải cao, không request nào fail |
| Valid channel | Channel phải là `stable` hoặc `canary` | Không có channel thứ ba bí ẩn |
| No cache header | Không có CDN cache | Xác nhận chạy đúng profile `full-no-cdn` |

### 5.7 API endpoint được sử dụng

Từ `shared.js`:

```javascript
canaryDemo: {
  name: 'lb_canary_demo',
  method: 'GET',
  path: '/api/lb/canary-demo',
},
```

| Trường | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `name` | `lb_canary_demo` | Tag dùng trong metrics và checks |
| `method` | `GET` | HTTP method |
| `path` | `/api/lb/canary-demo` | URL path cho canary routing test |
| `expected` | (không set -- không assert status cụ thể trong API definition) | Script tự check status=200 |
| `expectedUpstream` | (không set) | Có thể là stable hoặc canary |

### 5.8 Sơ đồ tổ chức toàn bộ script

```text
┌─ options: 
│   ├─ scenarios.fairness: 
│   │   executor='constant-arrival-rate', rate=60, timeUnit='1s',
│   │   duration='12s', preAllocatedVUs=20, maxVUs=40
│   └─ thresholds:
│       ├─ checks: rate==1
│       ├─ http_req_failed: rate==0
│       └─ lb_canary_observed: rate>0.08, rate<0.22
│
├─ canaryObserved = new Rate('lb_canary_observed')
│
└─ default() [chạy 720 lần trong 12 giây]
    ├─ Tạo key: fair-${__VU}-${__ITER}-${random}
    ├─ GET /api/lb/canary-demo [X-Canary-Key: key]
    ├─ Đọc X-LB-Release-Channel
    ├─ canaryObserved.add(channel === 'canary')
    └─ checks:
        ├─ status === 200
        ├─ channel ∈ {stable, canary}
        └─ không có X-Cache
```

---

## 6. Nginx/LB mechanism deep-dive

### 6.1 Cấu hình `split_clients` cho weighted routing

`split_clients` là directive trong Nginx dùng để phân phối request vào các biến dựa trên tỷ lệ phần trăm:

```nginx
split_clients $canary_key $release_channel {
    15%    canary;
    *      stable;
}
```

| Thành phần | Ý nghĩa | Ví dụ trong case |
| --- | --- | --- |
| `$canary_key` | Biến đầu vào để hash | `$http_x_canary_key` (header `X-Canary-Key`) |
| `$release_channel` | Biến đầu ra -- kết quả phân phối | `canary` hoặc `stable` |
| `15%` | Tỷ lệ request đi vào bucket `canary` | 15% |
| `*` | Tất cả request còn lại | ~85% |

### 6.2 Cách `split_clients` hoạt động -- chi tiết

```text
BƯỚC 1: Nginx nhận request với header X-Canary-Key
  Client → Nginx: GET /api/lb/canary-demo
                 X-Canary-Key: fair-3-15-a1b2c3d4e5f6

BƯỚC 2: Nginx hash giá trị của biến đầu vào
  hash = murmurhash2("fair-3-15-a1b2c3d4e5f6")
  hash_value = hash % 4294967296  (2^32)

BƯỚC 3: Map hash value vào bucket
  0% - 15% của không gian hash → bucket "canary"
  15% - 100% của không gian hash → bucket "stable"

BƯỚC 4: Set biến $release_channel
  $release_channel = "canary" hoặc "stable"

BƯỚC 5: Dùng biến này để route
  if ($release_channel = "canary") {
      proxy_pass http://lb-canary-origin;
  }
  if ($release_channel = "stable") {
      proxy_pass http://lb-stable-origin;
  }

BƯỚC 6: Gắn header cho client
  add_header X-LB-Release-Channel $release_channel;
```

### 6.3 Hash function và phân phối

`split_clients` dùng MurmurHash2 -- một hash function không cryptographic nhưng phân phối đều:

```text
Tính chất của MurmurHash2 trong split_clients:
  1. Deterministic: cùng input → cùng output (cùng key → cùng channel)
  2. Uniform distribution: hash value phân phối đều trên [0, 2^32)
  3. Avalanche effect: thay đổi nhỏ trong input → thay đổi lớn trong hash
  4. Fast: rất nhanh, phù hợp cho xử lý request real-time
```

**Ví dụ về phân phối đều:**

```text
Key "fair-1-1-abc"  → hash = 1234567890 → 1234567890 / 2^32 = 28.7% → stable
Key "fair-1-2-def"  → hash = 3456789012 → 3456789012 / 2^32 = 80.4% → stable
Key "fair-1-3-ghi"  → hash =  567890123 →  567890123 / 2^32 = 13.2% → canary
Key "fair-1-4-jkl"  → hash = 2345678901 → 2345678901 / 2^32 = 54.6% → stable
Key "fair-1-5-mno"  → hash = 4012345678 → 4012345678 / 2^32 = 93.4% → stable
Key "fair-1-6-pqr"  → hash =  123456789 →  123456789 / 2^32 =  2.9% → canary
...
```

Với 720 request và hash phân phối đều, kỳ vọng khoảng 15% * 720 = 108 request đi canary. Thực tế có thể dao động 91-126 request (12.6% - 17.5%).

### 6.4 Tại sao custom metric `lb_canary_observed` là primary proof

Khác với case 08 (primary proof là header `X-LB-Release-Channel`), case 10 dùng custom metric làm primary proof. Lý do:

| Khía cạnh | Case 08 | Case 10 |
| --- | --- | --- |
| Số request | 120 (sample loop) | ~720 (constant-arrival-rate) |
| Cần aggregate? | Không (có thể đếm thủ công) | Có (720 request, cần metric tổng hợp) |
| Proof | Từng request riêng lẻ route đúng | Tỷ lệ tổng thể nằm trong band |
| Cơ chế | `check()` | `Rate` metric + threshold |

**`Rate` metric là lựa chọn đúng cho case này vì:**

1. Nó tự động aggregate trên tất cả VU và iteration
2. Threshold trên Rate metric cho phép define pass/fail ở mức tổng thể
3. Không cần đếm thủ công hoặc post-processing

### 6.5 Open model vs Closed model

Case 10 sử dụng **open model** (constant-arrival-rate), khác với hầu hết các case LB khác dùng **closed model** (constant-vus hoặc shared-iterations):

| Khía cạnh | Closed model (constant-vus) | Open model (constant-arrival-rate) |
| --- | --- | --- |
| Điều khiển | Số VU cố định | Tốc độ arrival cố định |
| Concurrency | VU quyết định (nếu VU bận → request đợi) | k6 tự thêm VU để đạt target rate |
| Mô phỏng | Người dùng cố định, kiên nhẫn | Người dùng mới đến liên tục |
| Khi nào dùng | Load test thông thường | Test fairness dưới sustained load |
| Iteration duration ảnh hưởng? | Có -- VU bận thì request đợi | Có -- nếu duration > 1/rate, cần thêm VU |

**Công thức tính VU cần thiết cho open model:**

```text
VUs_needed = rate * avg_iteration_duration

Ví dụ:
  rate = 60/s
  avg_iteration_duration = 200ms = 0.2s
  VUs_needed = 60 * 0.2 = 12 VU

  → preAllocatedVUs=20 là đủ, không cần scale lên maxVUs=40

Nếu avg_iteration_duration tăng lên 500ms:
  VUs_needed = 60 * 0.5 = 30 VU
  → preAllocatedVUs=20 không đủ, k6 scale lên 30 VU (< maxVUs=40)
```

### 6.6 `preAllocatedVUs` và `maxVUs` -- trade-off

| Tham số | Giá trị | Ý nghĩa | Nếu quá thấp | Nếu quá cao |
| --- | --- | --- | --- |
| `preAllocatedVUs` | 20 | VU được tạo sẵn, không mất thời gian khởi tạo | k6 mất thời gian tạo VU giữa chừng → arrival rate không đều | Tốn memory (mỗi VU ~vài MB) |
| `maxVUs` | 40 | Giới hạn cứng -- k6 không tạo quá số này | Nếu iteration chậm, arrival rate không đạt target → warning | Tốn memory, nhưng arrival rate được đảm bảo |

---

## 7. Request sequence flow

### 7.1 Timeline toàn bộ script

```text
T0: k6 start
│
├─ T0→T0.1: k6 pre-allocate 20 VU
│
├─ SCENARIO "fairness" BẮT ĐẦU ──────────────────────────────
│  duration: 12s, rate: 60/s
│
│  T0.1: Iteration 1  (VU-1):  GET /api/lb/canary-demo [key=fair-1-1-xxx]
│  T0.1: Iteration 2  (VU-2):  GET /api/lb/canary-demo [key=fair-2-1-yyy]
│  T0.1: Iteration 3  (VU-3):  GET /api/lb/canary-demo [key=fair-3-1-zzz]
│  ... (60 iteration bắt đầu trong giây đầu tiên)
│
│  T1.0: Iteration 61 (VU-1):  GET ... (VU-1 đã xong iteration đầu)
│  ...
│
│  (Tiếp tục trong 12 giây, mỗi giây ~60 iteration mới)
│
│  T12.0: Iteration cuối cùng kết thúc
│
├─ SCENARIO KẾT THÚC ────────────────────────────────────────
│
│  T12.0→T12.5: gracefulStop (30s mặc định, cho các iteration đang chạy hoàn thành)
│
└─ T12.5: k6 end
         Tổng hợp metrics:
           lb_canary_observed: X.XX%
           checks: rate==1
           http_req_failed: rate==0
         → exit 0 nếu thresholds pass
```

### 7.2 Phân phối request qua các channel

```text
Với 720 request, split_clients 15%:

Kỳ vọng (expected):
  stable:  720 * 85% = 612 request
  canary:  720 * 15% = 108 request

Thực tế (observed) -- ví dụ từ validation data:
  stable:  630 request (87.38%)
  canary:   91 request (12.62%)
  
  → lb_canary_observed = 91/720 = 0.1262 = 12.62%
  → 12.62% nằm trong [8%, 22%] → PASS
```

### 7.3 State machine của từng iteration

```text
┌──────────┐
│  START   │  (k6 scheduler quyết định bắt đầu iteration mới)
└────┬─────┘
     │
     ▼
┌──────────┐
│ GENERATE │  Tạo key: fair-${__VU}-${__ITER}-${random}
│   KEY    │
└────┬─────┘
     │
     ▼
┌──────────┐
│  REQUEST │  GET /api/lb/canary-demo
│   LB     │  Header: X-Canary-Key
└────┬─────┘
     │
     ▼
┌──────────┐
│  NGINX   │  Hash key → map vào bucket → route
│  ROUTE   │  → stable origin hoặc canary origin
└────┬─────┘
     │
     ▼
┌──────────┐
│ RESPONSE │  Nhận response: status 200, body { role }
│  READ    │  Đọc header: X-LB-Release-Channel
└────┬─────┘
     │
     ▼
┌──────────┐
│  METRIC  │  canaryObserved.add(channel === 'canary')
│  RECORD  │  check(res, { status, channel, no-cache })
└────┬─────┘
     │
     ▼
┌──────────┐
│   END    │  Iteration hoàn thành, VU sẵn sàng cho iteration mới
└──────────┘
```

---

## 8. Key signals / headers

### 8.1 Bảng tín hiệu cần kiểm tra

| Tín hiệu | Loại | Giá trị cần verify | Cách kiểm tra |
| --- | --- | --- | --- |
| `lb_canary_observed` | Custom metric (Rate) | Rate trong `[MIN_SHARE, MAX_SHARE]` (mặc định 8%-22%) | Threshold trong options |
| `X-LB-Release-Channel` | Response header | `stable` hoặc `canary` | `responseHeader(res, 'X-LB-Release-Channel')` |
| HTTP Status | Response | `200` | `check(res, { status: 200 })` |
| `X-Cache` | Response header | **KHÔNG có** | `check(res, { no-cache })` |
| `checks` | Built-in metric | `rate==1` | Threshold |
| `http_req_failed` | Built-in metric | `rate==0` | Threshold |

### 8.2 `lb_canary_observed` -- primary proof

```text
Đây là tín hiệu QUAN TRỌNG NHẤT của case 10.

Loại:       Rate (custom metric)
Ý nghĩa:    Tỷ lệ request đi vào canary channel
Cách tính:  count(canary) / total_requests

Threshold:
  rate > MIN_CANARY_SHARE  (mặc định: > 0.08 = > 8%)
  rate < MAX_CANARY_SHARE  (mặc định: < 0.22 = < 22%)

Xuất hiện trong output:
  lb_canary_observed.........: 12.62%  ✓ 91/721
```

### 8.3 `X-LB-Release-Channel` -- channel signal

```text
Giá trị: "stable" hoặc "canary"
Ý nghĩa: Nginx cho biết request này được route đến channel nào.

Check: channel === 'stable' || channel === 'canary'
→ Xác nhận không có giá trị thứ ba bất thường
→ Nếu thiếu header này → Nginx config không có add_header
```

### 8.4 Phân biệt giữa custom metric và built-in metric

| Metric | Loại | Ai tạo | Threshold |
| --- | --- | --- | --- |
| `lb_canary_observed` | Custom (Rate) | Script (`canaryObserved.add()`) | `rate>0.08`, `rate<0.22` |
| `http_req_duration` | Built-in (Trend) | k6 tự động | Không set (optional) |
| `http_req_failed` | Built-in (Rate) | k6 tự động | `rate==0` |
| `checks` | Built-in (Rate) | k6 tự động (từ `check()`) | `rate==1` |
| `iterations` | Built-in (Counter) | k6 tự động | Không set |
| `vus` | Built-in (Gauge) | k6 tự động | Không set |

### 8.5 Cách đọc output summary

```text
█ metrics summary

  lb_canary_observed.........: 0.126247   ✓ 91/721
    ✓ { scenario:lb_weighted_fairness_under_load }...: 0.126247
    ✓ rate>0.08 ........................................: 0.126247
    ✓ rate<0.22 ........................................: 0.126247

  checks......................: 100.00% ✓ 2163 ✗ 0
    ✓ { scenario:lb_weighted_fairness_under_load }...: 100.00%

  http_req_failed.............: 0.00%   ✓ 0/721
    ✓ { scenario:lb_weighted_fairness_under_load }...: 0.00%
```

Cách đọc:
- `lb_canary_observed: 0.126247` = 12.62% request đi canary
- `✓ rate>0.08` và `✓ rate<0.22` = threshold pass
- `checks: 100.00% ✓ 2163 ✗ 0` = 2163 checks, không có check nào fail

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Case được coi là PASS khi **tất cả** các điều kiện sau đều đúng:

| # | Tiêu chí | Cách xác minh | Định lượng |
| --- | --- | --- | --- |
| 1 | k6 exit code = 0 | `$LASTEXITCODE` hoặc CI job status | `exit 0` |
| 2 | Tất cả checks pass | k6 output: `checks... 100%` | `checks rate = 1.0` |
| 3 | `http_req_failed` = 0% | k6 output: `http_req_failed: 0.00%` | 0 request thất bại |
| 4 | `lb_canary_observed` rate > `MIN_CANARY_SHARE` | Threshold trong output | Rate > 0.08 (8%) |
| 5 | `lb_canary_observed` rate < `MAX_CANARY_SHARE` | Threshold trong output | Rate < 0.22 (22%) |
| 6 | Tất cả response channel là `stable` hoặc `canary` | Checks | 100% channel valid |

### 9.2 Tiêu chí FAIL

Case FAIL khi **bất kỳ** điều kiện nào sau đây xảy ra:

| # | Dấu hiệu FAIL | Nguyên nhân khả dĩ | Cách debug |
| --- | --- | --- | --- |
| A | `lb_canary_observed` = 0% | Tất cả request đi stable -- `split_clients` không hoạt động hoặc dùng biến cố định | Kiểm tra Nginx config: `split_clients` dùng biến gì? Có đọc `X-Canary-Key` không? |
| B | `lb_canary_observed` = 100% | Tất cả request đi canary -- cấu hình sai tỷ lệ hoặc stable origin DOWN | Kiểm tra stable origin health |
| C | `lb_canary_observed` < 8% | Tỷ lệ canary quá thấp -- hash không uniform hoặc sample size quá nhỏ | Tăng `SAMPLE_DURATION` hoặc `SAMPLE_RATE` |
| D | `lb_canary_observed` > 22% | Tỷ lệ canary quá cao -- cấu hình `split_clients` sai tỷ lệ | Kiểm tra Nginx config: tỷ lệ trong `split_clients` |
| E | `checks` < 100% | Có ít nhất 1 request fail (status không 200 hoặc channel không hợp lệ) | Đọc check fail cụ thể |
| F | `http_req_failed` > 0% | Có request thất bại ở tầng HTTP (connection refused, timeout, 5xx) | Kiểm tra origin health |
| G | Không thấy metric `lb_canary_observed` trong output | Custom metric không được export hoặc dashboard không hỗ trợ | Xem output summary ở local (cloud có thể không hiển thị custom metric) |

### 9.3 Ma trận quyết định

| Tình trạng | checks 100%? | http_req_failed 0%? | canary rate trong band? | Kết luận | Hành động |
| --- | --- | --- | --- | --- | --- |
| A | Có | Có | Có | PASS hoàn toàn | Có thể tin tưởng weighted routing dưới tải |
| B | Có | Có | Không -- quá thấp | Canary share thấp hơn dự kiến | Tăng sample size hoặc kiểm tra hash distribution |
| C | Có | Có | Không -- quá cao | Canary share cao hơn dự kiến | Kiểm tra `split_clients` config |
| D | Có | Có | Không -- = 0% | Không có request nào đi canary | Kiểm tra Nginx config: biến dùng cho split_clients |
| E | Không | Có | Có | Có request với channel không hợp lệ | Kiểm tra response header từ origin |
| F | Không | Không | Bất kỳ | Có request thất bại | Kiểm tra origin health, network |

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy

```powershell
# 1. Di chuyển đến thư mục gốc
cd E:\Projects\k6\k6-metrics-server

# 2. Set biến môi trường
$env:BASE_URL = "http://localhost:80"

# 3. Chạy script (dùng runner script)
.\scripts\run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 10-weighted-fairness-under-load

# Hoặc chạy trực tiếp bằng k6:
k6 run .\load-target\k6\lb\10-weighted-fairness-under-load.js
```

### 10.2 Tùy chỉnh tham số

```powershell
# Tăng rate lên 90 req/s để test fairness ở tải cao hơn
$env:LB_CANARY_FAIRNESS_RATE = "90"

# Kéo dài thời gian chạy để có sample size lớn hơn
$env:LB_CANARY_FAIRNESS_DURATION_SECONDS = "20"

# Nới rộng band chấp nhận (nếu split_clients config khác 15%)
$env:LB_CANARY_FAIRNESS_MIN_SHARE = "0.05"
$env:LB_CANARY_FAIRNESS_MAX_SHARE = "0.30"

# Tăng VU pool nếu iteration chậm
$env:LB_CANARY_FAIRNESS_PRE_ALLOCATED_VUS = "30"
$env:LB_CANARY_FAIRNESS_MAX_VUS = "60"

# Chạy với tất cả tham số tùy chỉnh
k6 run -e LB_CANARY_FAIRNESS_RATE=90 `
       -e LB_CANARY_FAIRNESS_DURATION_SECONDS=20 `
       -e LB_CANARY_FAIRNESS_MIN_SHARE=0.05 `
       -e LB_CANARY_FAIRNESS_MAX_SHARE=0.30 `
       .\load-target\k6\lb\10-weighted-fairness-under-load.js
```

### 10.3 Output mẫu mong đợi (PASS)

```text

         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: .\load-target\k6\lb\10-weighted-fairness-under-load.js
     output: -

  scenarios: (100.00%) 1 scenario, 40 max VUs, 42s max duration
           * fairness: 60.00 iterations/s for 12s (maxVUs: 40, gracefulStop: 30s)


  lb_canary_observed.........: 0.126247   ✓ 91/721
    ✓ { scenario:lb_weighted_fairness_under_load }...: 0.126247
    ✓ rate>0.08 ........................................: 0.126247
    ✓ rate<0.22 ........................................: 0.126247

  checks......................: 100.00% ✓ 2163 ✗ 0
    ✓ { scenario:lb_weighted_fairness_under_load }...: 100.00%

  data_received..................: 280 kB  ...
  data_sent......................: 95 kB   ...
  http_req_blocked...............: avg=0.00ms  ...
  http_req_connecting............: avg=0.00ms  ...
  http_req_duration..............: avg=1.80ms  ...
  http_req_failed................: 0.00%   ✓ 0/721
  http_req_receiving.............: avg=0.08ms  ...
  http_req_sending...............: avg=0.01ms  ...
  http_req_waiting...............: avg=1.71ms  ...
  http_reqs......................: 721     ...
  iteration_duration.............: avg=1.85ms  ...
  iterations.....................: 721     ...
  vus............................: 19      ...
  vus_max........................: 20      ...


running (12.0s), 20/40 VUs, 721 complete and 0 interrupted iterations
fairness ✓ [======================================] 20/40 VUs  12s
```

### 10.4 Output mẫu khi FAIL (canary rate ngoài band)

```text
  lb_canary_observed.........: 0.034771   ✗ 25/719
    ✓ { scenario:lb_weighted_fairness_under_load }...: 0.034771
    ✗ rate>0.08 ........................................: 0.034771
    ✓ rate<0.22 ........................................: 0.034771

  checks......................: 100.00% ✓ 2157 ✗ 0

ERRO[0018] thresholds on metrics 'lb_canary_observed' were crossed
```

**Phân tích output FAIL:**
- `lb_canary_observed: 0.034771` = 3.48% -- quá thấp
- `✗ rate>0.08`: threshold `rate>0.08` bị vi phạm vì 3.48% < 8%
- `✓ rate<0.22`: threshold `rate<0.22` pass (3.48% < 22%)
- `checks: 100%`: tất cả checks pass (status 200, channel hợp lệ) -- vấn đề chỉ là tỷ lệ

---

## 11. 4 output -> decision scenarios

### Scenario 1: ALL PASS

```text
✓ lb_canary_observed: 12.62% (trong band 8%-22%)
✓ checks: 100%
✓ http_req_failed: 0%
```

**Kết luận:** Nginx weighted routing hoạt động chính xác dưới sustained load 60 req/s. Tỷ lệ canary observed nằm trong dải kỳ vọng, không có request thất bại.

**Quyết định:** Triển khai canary routing cho production với confidence. Có thể tăng dần canary share (15% -> 30% -> 50% -> 100%) với cơ chế giám sát `lb_canary_observed`.

### Scenario 2: Canary rate = 0% (tất cả stable)

```text
✗ lb_canary_observed: 0.00%
✓ checks: 100%
✓ http_req_failed: 0%
```

**Phân tích:** Toàn bộ 720 request đi stable, không có request nào đi canary. Ba khả năng:

1. `split_clients` không được cấu hình
2. `split_clients` dùng biến cố định (vd: `$remote_addr`) và tất cả request từ cùng IP
3. Canary origin không hoạt động -> Nginx fallback toàn bộ sang stable

**Quyết định:**
- Kiểm tra Nginx config: có `split_clients` directive không?
- Kiểm tra `split_clients` dùng biến gì? Nếu là `$remote_addr`, đổi sang `$http_x_canary_key`
- Kiểm tra canary origin health
- **Không triển khai canary routing** -- hiện tại 0% traffic đến canary

### Scenario 3: Canary rate quá cao (> 22%)

```text
✗ lb_canary_observed: 28.50%
✓ checks: 100%
✓ http_req_failed: 0%
```

**Phân tích:** 28.5% traffic đi canary, cao hơn nhiều so với 15% cấu hình. Nguyên nhân khả dĩ:

1. `split_clients` cấu hình sai tỷ lệ (vd: 30% thay vì 15%)
2. Hash function có vấn đề (rất hiếm -- MurmurHash2 đã được kiểm chứng)
3. Stable origin chậm hơn canary -> Nginx dùng canary nhiều hơn (nếu có fallback logic)

**Quyết định:**
- Kiểm tra chính xác giá trị phần trăm trong `split_clients`
- So sánh latency giữa stable và canary origin
- Điều chỉnh `MAX_CANARY_SHARE` nếu tỷ lệ cấu hình khác 15%

### Scenario 4: Có request thất bại dưới tải

```text
✓ hoặc ✗ lb_canary_observed
✗ checks < 100%
✗ http_req_failed > 0%
```

**Phân tích:** Một số request thất bại dưới tải. Nguyên nhân khả dĩ:

1. `preAllocatedVUs` không đủ, iteration bị timeout
2. Origin (stable hoặc canary) không chịu được tải
3. Network bottleneck giữa k6 và Nginx

**Quyết định:**
- Tăng `preAllocatedVUs` và `maxVUs`
- Giảm `SAMPLE_RATE` nếu origin không chịu được tải
- Kiểm tra resource usage của origin container (`docker stats`)
- Xem xét tăng tài nguyên cho origin

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "split_clients 15% nghĩa là chính xác 15% request đi canary"

```text
Sai:    Tôi cấu hình 15%, vậy 1000 request sẽ có chính xác 150 request đi canary.
Đúng:   split_clients dùng hash function để phân phối. Với 1000 request, 
        expected value là 150, nhưng thực tế có thể là 137 hoặc 164. 
        Đây là BIẾN THIÊN THỐNG KÊ, không phải lỗi.
```

**Giải thích:** `split_clients` phân phối dựa trên hash value của input. Nếu input được tạo ngẫu nhiên đều, phân phối sẽ hội tụ về expected ratio khi sample size tăng. Với 720 request, standard deviation khoảng sqrt(720 * 0.15 * 0.85) = 9.6 request, tương đương 1.3%.

### Nghịch lý 2: "Sample size càng lớn thì rate càng chính xác"

```text
Sai:    Tăng sample lên 10,000 request để có tỷ lệ chính xác tuyệt đối.
Đúng:   Sample size lớn hơn giúp KHOẢNG TIN CẬY hẹp hơn, nhưng không bao giờ 
        đạt chính xác tuyệt đối. Hơn nữa, tăng sample size đồng nghĩa với 
        tăng thời gian chạy và tài nguyên.
```

**Giải thích:** Có point of diminishing returns:

| Sample size | Expected canary | 95% CI | CI width | Thời gian (60 req/s) |
| --- | --- | --- | --- | --- |
| 120 | 18 | [12, 24] | 10% | 2 giây |
| 720 | 108 | [92, 124] | 4.4% | 12 giây |
| 7,200 | 1080 | [1016, 1144] | 1.8% | 120 giây (2 phút) |
| 72,000 | 10800 | [10730, 10870] | 0.2% | 1200 giây (20 phút) |

Với 720 request, CI width ~4.4% là đủ để phát hiện sai lệch lớn (> 5%) nhưng không quá hẹp đến mức gây false positive.

### Nghịch lý 3: "Primary proof là latency, không phải canary rate"

```text
Sai:    Case này test performance -- latency p95 phải dưới ngưỡng.
Đúng:   Case này test FAIRNESS -- tỷ lệ phân phối phải nằm trong band.
        Latency có thể được kiểm tra thêm (optional), nhưng không phải 
        primary proof.
```

**Giải thích:** Case 10 không set threshold cho `http_req_duration`. Lý do:

1. Mục tiêu của case là fairness, không phải performance
2. Latency phụ thuộc vào môi trường (local Docker vs cloud vs production)
3. Nếu set threshold latency, case có thể fail vì môi trường chậm, không phải vì weighted routing sai

Nếu muốn thêm latency check, thêm optional threshold:

```javascript
thresholds: {
  http_req_duration: ['p95<50ms'],  // Optional: performance check
}
```

### Nghịch lý 4: "Mọi key ngẫu nhiên đều cho phân phối đều"

```text
Sai:    Dùng Math.random() là đủ để đảm bảo phân phối đều.
Đúng:   Math.random() trong k6 JavaScript runtime (Goja) có thể không 
        có entropy cao như crypto.randomUUID(). Tuy nhiên, cho mục đích 
        test fairness với 720 request, nó hoàn toàn đủ.
```

**Giải thích:** `Math.random()` trong Goja (JavaScript runtime của k6, viết bằng Go) dùng Go's `math/rand` -- không phải cryptographic, nhưng đủ ngẫu nhiên cho việc test phân phối. Với 720 request, không có sự khác biệt thực tế giữa `Math.random()` và cryptographic random.

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=nginx"` | Có ít nhất 1 container Nginx | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn` |
| 2 | Nginx public path hoạt động | `curl -sI http://localhost:80/` | HTTP 200, `Server: nginx` | Kiểm tra Nginx config |
| 3 | Canary endpoint hoạt động | `curl -s http://localhost:80/api/lb/canary-demo` | HTTP 200, JSON response | Kiểm tra upstream config |
| 4 | Stable origin hoạt động | Gọi canary endpoint nhiều lần, kiểm tra có response `role: stable` | Thấy ít nhất 1 response stable | Kiểm tra stable origin |
| 5 | Canary origin hoạt động | Gọi canary endpoint nhiều lần, kiểm tra có response `role: canary` | Thấy ít nhất 1 response canary | Kiểm tra canary origin |
| 6 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại biến môi trường |

### 13.2 Nginx config checklist

| # | Mục kiểm tra | Cách kiểm tra | Expected |
| --- | --- | --- | --- |
| 7 | Có `split_clients` directive | Đọc `nginx.conf` | Có block `split_clients` |
| 8 | Biến đầu vào là `X-Canary-Key` | Đọc `nginx.conf` | `$http_x_canary_key` |
| 9 | Tỷ lệ canary đúng như kỳ vọng | Đọc `nginx.conf` | 15% (hoặc giá trị đã biết) |
| 10 | `add_header X-LB-Release-Channel` | Đọc `nginx.conf` | Response có header này |

### 13.3 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 11 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\lb\10-weighted-fairness-under-load.js"` |
| 12 | `shared.js` tồn tại và đúng version | Import đúng path |
| 13 | `MIN_CANARY_SHARE` và `MAX_CANARY_SHARE` phù hợp với config | Nếu `split_clients` là 10%, band nên là [5%, 18%] thay vì [8%, 22%] |
| 14 | `SAMPLE_RATE` và `SAMPLE_DURATION` đủ lớn để có ý nghĩa thống kê | Tối thiểu 360 request (= 60/s * 6s) |
| 15 | `preAllocatedVUs` đủ để đạt target rate | `preAllocatedVUs >= SAMPLE_RATE * expected_iteration_duration` |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: So sánh fairness ở nhiều mức tải

Chạy case ở nhiều rate khác nhau để xem canary share có ổn định không.

```javascript
// Variation 1: Multi-rate fairness comparison
// Chạy 3 scenario với rate khác nhau trong cùng 1 script

export const options = {
  scenarios: {
    low_load: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 5,
      maxVUs: 10,
      tags: { load_level: 'low' },
    },
    medium_load: {
      executor: 'constant-arrival-rate',
      rate: 60,
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 20,
      maxVUs: 40,
      tags: { load_level: 'medium' },
      startTime: '16s',  // Bắt đầu sau scenario low_load
    },
    high_load: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 40,
      maxVUs: 80,
      tags: { load_level: 'high' },
      startTime: '32s',  // Bắt đầu sau scenario medium_load
    },
  },
};

// default() giữ nguyên -- mỗi request ghi canaryObserved.add()
// Kết quả: so sánh lb_canary_observed rate ở 3 mức tải
// Kỳ vọng: rate không thay đổi đáng kể giữa các mức tải
```

**Điểm học:** Weighted routing fairness nên ổn định không phụ thuộc vào mức tải. Nếu rate thay đổi khi tải tăng -> có vấn đề với thuật toán hash hoặc origin selection.

### Variation 2: Fairness với header cố định (sticky canary)

Test xem weighted routing có fairness khi một số client luôn đi canary.

```javascript
// Variation 2: Sticky canary fairness
// Một số key cố định luôn đi canary, còn lại là ngẫu nhiên

const STICKY_CANARY_KEYS = ['admin-1', 'admin-2', 'beta-tester'];
const STICKY_RATIO = 0.2;  // 20% request dùng sticky key

export default function () {
  const api = lbCapabilityApis.canaryDemo;
  
  let key;
  if (Math.random() < STICKY_RATIO) {
    // Dùng key cố định (sticky) -- Nginx có thể luôn route sang canary
    key = STICKY_CANARY_KEYS[Math.floor(Math.random() * STICKY_CANARY_KEYS.length)];
  } else {
    // Dùng key ngẫu nhiên
    key = `fair-${__VU}-${__ITER}-${Math.random().toString(16).slice(2)}`;
  }
  
  const res = requestLB(api, {
    headers: { 'X-Canary-Key': key },
    tags: { endpoint: api.name, sticky: key in STICKY_CANARY_KEYS ? 'yes' : 'no' },
  });
  
  const channel = responseHeader(res, 'X-LB-Release-Channel');
  canaryObserved.add(channel === 'canary');
  
  // Tag riêng cho sticky request để phân tích sau
  // Nếu sticky key luôn đi canary, canary rate tổng thể sẽ tăng
}
```

**Điểm học:** Khi có sticky keys (luôn map vào canary bucket), tỷ lệ canary tổng thể sẽ cao hơn tỷ lệ cấu hình. Đây là expected behavior -- cần tính đến khi thiết kế canary rollout.

### Variation 3: Kiểm tra cả hai channel đều nhận traffic

Thêm check để đảm bảo cả stable và canary đều có traffic.

```javascript
// Variation 3: Both channels receive traffic
// Dùng custom Counter metric để đếm riêng stable và canary

import { Counter } from 'k6/metrics';

const stableCount = new Counter('lb_stable_count');
const canaryCount = new Counter('lb_canary_count');

export default function () {
  const api = lbCapabilityApis.canaryDemo;
  const key = `fair-${__VU}-${__ITER}-${Math.random().toString(16).slice(2)}`;
  const res = requestLB(api, {
    headers: { 'X-Canary-Key': key },
    tags: { endpoint: api.name },
  });
  
  const channel = responseHeader(res, 'X-LB-Release-Channel');
  canaryObserved.add(channel === 'canary');
  
  if (channel === 'stable') {
    stableCount.add(1);
  } else if (channel === 'canary') {
    canaryCount.add(1);
  }
  
  check(res, {
    'status 200': (r) => r.status === 200,
    'valid channel': () => channel === 'stable' || channel === 'canary',
  });
}

// Trong options thêm thresholds:
//   lb_stable_count: ['count>0'],  // Phải có ít nhất 1 request stable
//   lb_canary_count: ['count>0'],  // Phải có ít nhất 1 request canary
```

**Điểm học:** Không chỉ kiểm tra tỷ lệ, mà còn cần xác nhận cả hai channel đều thực sự nhận traffic. Nếu `lb_canary_count = 0` -> tất cả traffic đi stable (cảnh báo đỏ).

### Variation 4: So sánh latency giữa stable và canary

Mở rộng case để so sánh latency giữa hai channel -- phát hiện nếu canary chậm hơn stable.

```javascript
// Variation 4: Stable vs canary latency comparison
import { Trend } from 'k6/metrics';

const stableLatency = new Trend('lb_stable_latency', true);
const canaryLatency = new Trend('lb_canary_latency', true);

export default function () {
  const api = lbCapabilityApis.canaryDemo;
  const key = `fair-${__VU}-${__ITER}-${Math.random().toString(16).slice(2)}`;
  const res = requestLB(api, {
    headers: { 'X-Canary-Key': key },
    tags: { endpoint: api.name },
  });
  
  const channel = responseHeader(res, 'X-LB-Release-Channel');
  canaryObserved.add(channel === 'canary');
  
  // Ghi latency riêng cho từng channel
  if (channel === 'stable') {
    stableLatency.add(res.timings.duration);
  } else if (channel === 'canary') {
    canaryLatency.add(res.timings.duration);
  }
  
  check(res, {
    'status 200': (r) => r.status === 200,
    'valid channel': () => channel === 'stable' || channel === 'canary',
  });
}

// Output sẽ hiển thị:
//   lb_stable_latency: avg=1.5ms p95=3ms
//   lb_canary_latency: avg=1.7ms p95=3ms
// Kỳ vọng: latency của hai channel tương đương nhau
```

**Điểm học:** Weighted routing fairness không chỉ là về số lượng request, mà còn về chất lượng. Nếu canary chậm hơn stable đáng kể, người dùng trong canary group có trải nghiệm kém hơn.

### Variation 5: Fairness với `split_clients` dùng biến khác

Test fairness khi Nginx dùng biến khác ngoài `X-Canary-Key`.

```javascript
// Variation 5: Alternative split variable
// Nếu Nginx dùng $request_id thay vì $http_x_canary_key:
//   split_clients $request_id $release_channel { ... }
//
// Thì script không cần gửi X-Canary-Key header nữa:

export default function () {
  const api = lbCapabilityApis.canaryDemo;
  
  // Không gửi X-Canary-Key -- Nginx dùng $request_id (unique cho mỗi request)
  const res = requestLB(api, {
    tags: { endpoint: api.name, route_mode: 'request_id_based' },
  });
  
  const channel = responseHeader(res, 'X-LB-Release-Channel');
  canaryObserved.add(channel === 'canary');
  
  check(res, {
    'status 200': (r) => r.status === 200,
    'valid channel': () => channel === 'stable' || channel === 'canary',
  });
}
```

**Điểm học:** `$request_id` do Nginx tự sinh cho mỗi request, đảm bảo duy nhất và ngẫu nhiên. Đây là lựa chọn tốt nếu không muốn client kiểm soát routing key. Tuy nhiên, client không thể "force" một channel cụ thể như với `X-Canary-Key`.

---

## 15. Anti-patterns

### Anti-pattern 1: Dùng closed model (constant-vus) để test fairness

```javascript
// SAI cho case này: constant-vus không tạo sustained arrival rate
export const options = {
  vus: 20,
  duration: '12s',
};
```

```javascript
// ĐÚNG: constant-arrival-rate tạo sustained load
export const options = {
  scenarios: {
    fairness: {
      executor: 'constant-arrival-rate',
      rate: 60,
      timeUnit: '1s',
      duration: '12s',
      preAllocatedVUs: 20,
      maxVUs: 40,
    },
  },
};
```

**Hậu quả của anti-pattern:** Với `constant-vus`, nếu iteration nhanh (1ms), 20 VU tạo ra 20,000 req/s -- không giống production. Nếu iteration chậm (100ms), 20 VU tạo ra 200 req/s. Arrival rate không kiểm soát được, phụ thuộc vào iteration duration.

### Anti-pattern 2: Sample size quá nhỏ

```javascript
// SAI: 60 request -- không đủ ý nghĩa thống kê
const SAMPLE_DURATION = '1s';  // 60 * 1 = 60 request
```

```javascript
// ĐÚNG: 720 request -- đủ để phát hiện sai lệch
const SAMPLE_DURATION = '12s';  // 60 * 12 = 720 request
```

**Hậu quả:** Với 60 request, expected canary = 9 request. Nếu actual = 5 request (8.3%), vẫn trong band [8%, 22%] nhưng sai lệch thực tế là 44% so với expected. Sample quá nhỏ không phát hiện được vấn đề.

### Anti-pattern 3: Band quá hẹp

```javascript
// SAI: Band quá hẹp -- dễ false positive
const MIN_CANARY_SHARE = 0.13;  // 13%
const MAX_CANARY_SHARE = 0.17;  // 17%
```

```javascript
// ĐÚNG: Band đủ rộng để chịu statistical variance
const MIN_CANARY_SHARE = 0.08;  // 8%
const MAX_CANARY_SHARE = 0.22;  // 22%
```

**Hậu quả:** Với band [13%, 17%] và 720 request, CI width ~4.4%. Có khoảng 15-20% khả năng kết quả nằm ngoài band ngay cả khi weighted routing hoạt động đúng -- false positive.

### Anti-pattern 4: Không gửi key ngẫu nhiên

```javascript
// SAI: Key cố định -- Nginx hash ra cùng một bucket cho mọi request
const key = 'fixed-key';
```

```javascript
// ĐÚNG: Key ngẫu nhiên cho mỗi request
const key = `fair-${__VU}-${__ITER}-${Math.random().toString(16).slice(2)}`;
```

**Hậu quả:** Với key cố định, hash luôn cho cùng một giá trị -> tất cả request đi cùng một channel. `lb_canary_observed` sẽ là 0% hoặc 100% -- case luôn FAIL.

### Anti-pattern 5: Bỏ qua `preAllocatedVUs` và `maxVUs`

```javascript
// SAI: Không set preAllocatedVUs -- k6 phải tạo VU động, gây delay
export const options = {
  scenarios: {
    fairness: {
      executor: 'constant-arrival-rate',
      rate: 60,
      timeUnit: '1s',
      duration: '12s',
      // Thiếu preAllocatedVUs và maxVUs
    },
  },
};
```

```javascript
// ĐÚNG: Set preAllocatedVUs và maxVUs phù hợp
export const options = {
  scenarios: {
    fairness: {
      executor: 'constant-arrival-rate',
      rate: 60,
      timeUnit: '1s',
      duration: '12s',
      preAllocatedVUs: 20,  // Đủ để đạt 60 req/s với latency < 333ms
      maxVUs: 40,           // Buffer an toàn
    },
  },
};
```

**Hậu quả:** Nếu không set `preAllocatedVUs`, k6 khởi tạo VU động khi cần. 1-2 giây đầu tiên, arrival rate thấp hơn target vì VU chưa đủ. Điều này làm giảm sample size hiệu quả.

---

## 16. Real validation data

### 16.1 Dữ liệu từ lần chạy thực tế

Dưới đây là kết quả validation thực tế trên môi trường local `TargetLayer=full-no-cdn`:

**Môi trường:**
```text
OS: Windows 11
Docker: Docker Desktop 4.x
Stack: target (full-no-cdn) với Nginx + Stable origin + Canary origin
k6 version: 0.51.x
```

**Kết quả:**

```text
█ metrics summary

  lb_canary_observed.........: 0.126247   ✓ 91/721
    ✓ { scenario:lb_weighted_fairness_under_load }...: 0.126247
    ✓ rate>0.08 ........................................: 0.126247
    ✓ rate<0.22 ........................................: 0.126247

  checks......................: 100.00% ✓ 2163 ✗ 0
  http_req_failed.............: 0.00%   ✓ 0/721

Exit: 0
Checks: 2163/2163
HTTP failed: 0.00% (0/721)
lb_canary_observed: 12.62% (91/721)
Result: PASS
```

### 16.2 Phân tích chi tiết

#### Phân phối channel

| Chỉ số | Giá trị |
| --- | --- |
| Tổng số request | 721 |
| Số request stable | 630 (87.38%) |
| Số request canary | 91 (12.62%) |
| Tỷ lệ cấu hình (expected) | ~15% |
| Tỷ lệ thực tế (observed) | 12.62% |
| Sai lệch | -2.38 điểm phần trăm |
| Trong band [8%, 22%]? | Có |

#### Checks

| Check | Kết quả |
| --- | --- |
| Status 200 | 721/721 (100%) |
| Channel valid (stable hoặc canary) | 721/721 (100%) |
| No cache header | 721/721 (100%) |
| Tổng checks | 2163/2163 (100%) |

### 16.3 Timing metrics

| Metric | avg | p(95) | max | Ghi chú |
| --- | --- | --- | --- | --- |
| `http_req_duration` | 1.80ms | 3.50ms | 12ms | Rất nhanh -- local environment |
| `http_req_waiting` | 1.71ms | 3.20ms | 10ms | Thời gian chờ response từ Nginx/origin |
| `iteration_duration` | 1.85ms | 3.60ms | 13ms | Thời gian toàn bộ iteration |

**Nhận xét:** Với avg iteration duration 1.85ms và rate 60/s, cần 60 * 0.00185 = 0.11 VU. Nhưng thực tế k6 dùng ~19 VUs vì có thời gian blocked (connection setup, v.v.), và để đảm bảo arrival rate ổn định.

### 16.4 Manual test bổ trợ

```powershell
# Manual test 1: Gọi canary endpoint 20 lần, đếm stable vs canary
PS> $stable = 0; $canary = 0
PS> for ($i=0; $i -lt 20; $i++) {
      $r = curl -s http://localhost:80/api/lb/canary-demo `
           -H "X-Canary-Key: manual-$i" | ConvertFrom-Json
      if ($r.role -eq 'stable') { $stable++ } else { $canary++ }
    }
PS> Write-Host "Stable: $stable, Canary: $canary"
Stable: 17, Canary: 3    # 15% -- khớp với cấu hình

# Manual test 2: Xem header X-LB-Release-Channel
PS> curl -sI http://localhost:80/api/lb/canary-demo `
     -H "X-Canary-Key: test-1" | findstr X-LB-Release
X-LB-Release-Channel: stable

PS> curl -sI http://localhost:80/api/lb/canary-demo `
     -H "X-Canary-Key: test-2" | findstr X-LB-Release
X-LB-Release-Channel: canary
```

---

## 17. Reference

### 17.1 Source files

| File | Vị trí | Mô tả |
| --- | --- | --- |
| Script chính | `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\10-weighted-fairness-under-load.js` | k6 test script cho weighted fairness under load |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\shared.js` | Các hàm `requestLB`, `responseHeader`, `lbCapabilityApis` |
| Common helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Các hàm `envInt`, `envFloat`, `envString` |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\case-catalog.json` | Định nghĩa structured metadata cho tất cả LB cases |
| Nginx config | `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Cấu hình Nginx `split_clients`, upstream |

### 17.2 Documents liên quan

| Tài liệu | Vị trí | Mô tả |
| --- | --- | --- |
| Series overview | `E:\Khoa hoc\k6\docs\practice\lb\00_overview.md` | Tổng quan 12 LB cases và mental model |
| Case 08 - Weighted Canary | `E:\Khoa hoc\k6\docs\practice\lb\08_weighted-routing-canary.md` | Case liên quan: weighted routing cơ bản |
| Run guide | `E:\Khoa hoc\k6\docs\practice\lb\RUN_GUIDE.md` | Hướng dẫn chạy toàn bộ LB suite |
| Validation report | `E:\Khoa hoc\k6\docs\practice\lb\13_validation-and-chart-analysis.md` | Phân tích chart và dữ liệu validation |

### 17.3 Các case liên quan trong LB suite

| Case | Mối liên hệ |
| --- | --- |
| Case 08 -- Weighted Canary Routing | Cùng sử dụng `split_clients` cho canary routing |
| Case 07 -- Rate Limit/Pressure | Cùng dùng `constant-arrival-rate` executor |
| Case 11 -- Saturation Isolation | Cùng dùng open model với nhiều scenario |
| Case 09 -- Passive Outlier Ejection | Cùng kiểm tra hành vi Nginx với upstream group |

### 17.4 External references

| Resource | URL / Mô tả |
| --- | --- |
| Nginx split_clients | https://nginx.org/en/docs/http/ngx_http_split_clients_module.html -- Reference cho `split_clients` directive |
| k6 Rate metric | https://grafana.com/docs/k6/latest/javascript-api/k6-metrics/rate/ -- Custom Rate metric documentation |
| k6 constant-arrival-rate | https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/ -- Open model executor |
| k6 Scenarios | https://grafana.com/docs/k6/latest/using-k6/scenarios/ -- Multi-scenario configuration |

### 17.5 Key takeaways

1. **Weighted routing fairness** là việc tỷ lệ phân phối traffic giữ nguyên dưới sustained load, không bị sai lệch bởi concurrency.
2. **`lb_canary_observed` custom metric** là primary proof -- dùng `Rate` metric để aggregate canary share từ tất cả VU.
3. **OPEN MODEL (`constant-arrival-rate`)** là bắt buộc để tạo sustained load thực sự. Closed model không kiểm soát được arrival rate.
4. **Band chấp nhận [8%, 22%]** rộng hơn tỷ lệ cấu hình 15% để chịu statistical variance và tránh false positive.
5. **Key ngẫu nhiên** (`Math.random()`) cho mỗi request đảm bảo hash phân phối đều trong `split_clients`.
6. **`preAllocatedVUs` và `maxVUs`** phải đủ lớn để đạt target arrival rate.
7. **Primary proof là canary share stability, không phải latency** -- đây là fairness test, không phải performance test.

---

*Tài liệu này được tạo từ script nguồn `10-weighted-fairness-under-load.js`, `shared.js`, và `case-catalog.json`. Mọi thông tin về Nginx mechanism, custom metric, scenario configuration, và flow logic đều được trích xuất trực tiếp từ code nguồn.*
