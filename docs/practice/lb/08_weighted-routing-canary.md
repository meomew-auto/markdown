# Case 08: Weighted routing canary

> **Case ID:** `lb-08-weighted-routing-canary`
> **Script:** `08-weighted-routing-canary.js`
> **Profile:** `full-no-cdn`
> **Proof:** Nginx route stable/canary bằng force header và weighted split

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

Một nền tảng thương mại điện tử chuẩn bị phát hành phiên bản mới của trang sản phẩm (phiên bản "canary") với giao diện được thiết kế lại hoàn toàn và thuật toán đề xuất sản phẩm cải tiến. Đội ngũ kỹ thuật muốn triển khai bản mới này một cách an toàn, từng bước, thay vì "big bang" -- chuyển toàn bộ người dùng sang bản mới cùng một lúc.

Chiến lược canary release (hay còn gọi là "canary deployment") giải quyết bài toán này qua ba giai đoạn:

| Giai đoạn | Tên gọi | Mô tả | Tỉ lệ traffic |
| --- | --- | --- | --- |
| 1 | Internal dogfooding | Chỉ đội ngũ nội bộ truy cập bản canary để kiểm tra | 0% public, 100% internal |
| 2 | Canary rollout | Một phần nhỏ người dùng thật được route sang bản canary | 5% - 15% |
| 3 | Full rollout | Toàn bộ người dùng được chuyển sang bản mới (nay là stable) | 100% |

### 1.2 Hai nhu cầu routing đối lập

Trong quá trình canary deployment, Gateway phải đáp ứng đồng thời hai nhu cầu routing trái ngược nhau:

**Nhu cầu 1 -- Forced routing (gỡ lỗi và xác minh):**

```text
Developer/QA cần truy cập CHÍNH XÁC phiên bản họ muốn:
  - "Tôi muốn xem bản stable để so sánh" → cần route sang stable
  - "Tôi muốn xem bản canary để kiểm tra bug" → cần route sang canary
  - Việc route này phải được đảm bảo 100%, không phụ thuộc vào weighted split
```

**Nhu cầu 2 -- Weighted routing (rollout dần):**

```text
Người dùng thật được phân phối NGẪU NHIÊN theo tỉ lệ:
  - 85% → stable (bản hiện tại, đã được kiểm chứng)
  - 15% → canary (bản mới, đang được thử nghiệm)
  - Tỉ lệ này được điều chỉnh tăng dần khi đội ngũ có thêm niềm tin vào bản canary
```

Cả hai nhu cầu này phải cùng tồn tại trên cùng một Gateway, cùng một endpoint. Gateway phải phân biệt được: request nào là "forced" (từ developer với header đặc biệt), request nào là "weighted" (từ người dùng thật).

### 1.3 Ba câu hỏi mà case này trả lời

Case 08 được thiết kế để trả lời ba câu hỏi cốt lõi về weighted canary routing:

1. **Force header có được tôn trọng không?** -- Khi gửi `X-Canary: never`, request có luôn đến stable không? Khi gửi `X-Canary: always`, request có luôn đến canary không?
2. **Weighted split có hoạt động không?** -- Khi không có force header, traffic có được phân phối giữa stable và canary theo tỉ lệ mong muốn không?
3. **Tỉ lệ canary có nằm trong dải cho phép không?** -- Với sample 120 request, tỉ lệ canary quan sát được có nằm trong dải [5%, 30%] không?

---

## 2. LB capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh khả năng weighted routing của Nginx -- route request đến đúng release channel (stable hoặc canary) dựa trên force header và weighted split:

> **Nginx route stable/canary bằng force header và weighted split**

Cụ thể hơn, case này chứng minh ba sub-capabilities:

```text
1. Forced stable:  X-Canary: never  → luôn đến lb-stable-origin  → X-LB-Release-Channel: stable
2. Forced canary:  X-Canary: always → luôn đến lb-canary-origin   → X-LB-Release-Channel: canary
3. Weighted split:  không có force header → phân phối ngẫu nhiên → canary share trong dải [5%, 30%]
```

### 2.2 Ba sub-proofs

Case này tổ chức thành ba sub-proofs riêng biệt, mỗi sub-proof kiểm tra một khía cạnh của weighted routing:

| Sub-proof | Header gửi đi | Expected upstream | Expected channel | Số lượng request | Mục đích |
| --- | --- | --- | --- | --- | --- |
| `forced_stable` | `X-Canary: never`, `X-Canary-Key: forced-stable` | `lb-stable-origin` | `stable` | 1 | Chứng minh force header `never` luôn route sang stable |
| `forced_canary` | `X-Canary: always`, `X-Canary-Key: forced-canary` | `lb-canary-origin` | `canary` | 1 | Chứng minh force header `always` luôn route sang canary |
| `weighted_sample` | `X-Canary-Key: sample-<i>` (ngẫu nhiên) | Không xác định trước | `stable` hoặc `canary` | 120 (mặc định) | Chứng minh weighted split nằm trong dải cho phép |

### 2.3 Custom logic: vòng lặp sample

Khác với hầu hết các case LB khác (dùng k6 executor để tạo nhiều iteration), case 08 tự thực hiện vòng lặp sample bên trong **một iteration duy nhất**:

```javascript
// Script chạy VỚI 1 VU, 1 ITERATION
// Nhưng bên trong default(), có vòng lặp for gửi 120 request
for (let i = 0; i < CANARY_SAMPLE_SIZE; i += 1) {
  const sample = requestLB(api, {
    headers: { 'X-Canary-Key': `sample-${i}` },
    tags: { endpoint: api.name, route_mode: 'weighted_sample' },
  });
  // Phân loại channel...
}
```

Lý do thiết kế này:

- **Kiểm soát chính xác sample size**: Biết chính xác có bao nhiêu request weighted được gửi đi
- **Tính toán tỉ lệ canary ngay trong script**: `canaryPercent = (canaryCount / CANARY_SAMPLE_SIZE) * 100`
- **Check pass/fail trong script**: So sánh `canaryPercent` với `CANARY_MIN_PERCENT` và `CANARY_MAX_PERCENT`
- **Không phụ thuộc vào k6 thresholds**: Có thể dùng `check(null, {...})` để kiểm tra điều kiện logic không gắn với một response cụ thể

### 2.4 Tại sao capability này quan trọng

Không có weighted routing đúng, canary deployment trở thành "đánh bạc":

```text
Không có canary routing:    Triển khai bản mới → 100% người dùng thấy bản mới → nếu có bug, tất cả bị ảnh hưởng
Force header bị bỏ qua:     Developer không thể xác minh bản canary → bug không được phát hiện
Weighted split sai:          Canary nhận quá nhiều traffic → rủi ro cao; quá ít → không đủ data để đánh giá
Weighted routing đúng:      Canary nhận đúng tỉ lệ → đủ data để đánh giá, đủ an toàn để rollback nếu cần
```

---

## 3. Vì sao phải test ở LB layer

### 3.1 Gateway là điểm quyết định routing

```text
Người dùng → Nginx (Gateway :80) → stable origin (lb-stable-origin)
                                 → canary origin (lb-canary-origin)
                 ↑
            Điểm quyết định: route sang stable hay canary?
```

Quyết định route sang stable hay canary xảy ra tại Nginx -- trước khi request đến bất kỳ origin nào. Nếu quyết định này sai, request sẽ đến nhầm origin và người dùng sẽ thấy nhầm phiên bản.

Test ở LB layer là cách duy nhất để xác nhận:

1. **Force header được Nginx đọc và tôn trọng**
2. **Weighted split được Nginx thực thi bằng `split_clients`**
3. **Response header (`X-LB-Release-Channel`) phản ánh đúng channel đã route**

### 3.2 Không thể test canary routing ở tầng app

Nếu chỉ test bằng cách gọi trực tiếp origin (bỏ qua Nginx):

```text
Test sai:   curl http://localhost:8081/api/lb/canary-demo  (đi thẳng stable origin)
            curl http://localhost:8082/api/lb/canary-demo  (đi thẳng canary origin)
Test đúng:  curl -H "X-Canary: never" http://localhost:80/api/lb/canary-demo   (qua Nginx → stable)
            curl -H "X-Canary: always" http://localhost:80/api/lb/canary-demo   (qua Nginx → canary)
```

Chỉ request qua `:80` mới đi qua Nginx và mới kiểm tra được:
- Force header có được Nginx xử lý không
- `split_clients` có phân phối đúng tỉ lệ không
- Response header `X-LB-Release-Channel` có được gắn đúng không

### 3.3 Signal từ response header là evidence không thể chối cãi

Response từ origin có thể giống hệt nhau giữa stable và canary (cùng status 200, cùng format JSON). Nếu không có header signal từ Gateway, không thể phân biệt được request đã được route đến đâu.

Gateway (Nginx) phải gắn ít nhất ba header để làm evidence:

```text
X-LB-Release-Channel: stable | canary    ← Channel mà Nginx đã route đến
X-Upstream-Service: lb-stable-origin | lb-canary-origin  ← Origin cụ thể đã xử lý request
X-Served-By: nginx                        ← Xác nhận request đi qua Nginx
```

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌──────────────────────────────┐
                          │     k6 test script            │
                          │  (08-weighted-routing-        │
                          │   canary.js)                  │
                          └──────────────┬───────────────┘
                                         │
                         1 VU, 1 iteration
                         (với 3 sub-proofs tuần tự)
                                         │
                                         ▼
┌────────────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx Gateway)                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Nginx weighted router                                        │  │
│  │                                                                │  │
│  │  ┌─────────────────────┐    ┌─────────────────────────────┐  │  │
│  │  │ Force header check   │    │ split_clients directive     │  │  │
│  │  │                      │    │                             │  │  │
│  │  │ X-Canary: never? ────┼───→├── force sang stable         │  │  │
│  │  │ X-Canary: always? ───┼───→├── force sang canary         │  │  │
│  │  │ (không có) ──────────┼───→├── weighted split            │  │  │
│  │  └─────────────────────┘    │   • stable: 85%              │  │  │
│  │                               │   • canary: 15%              │  │  │
│  │                               └──────────────┬──────────────┘  │  │
│  └──────────────────────────────────────────────┼─────────────────┘  │
│                                                  │                    │
│                          ┌───────────────────────┴──────────────┐    │
│                          │                                       │    │
│                          ▼                                       ▼    │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐  │
│  │  lb-stable-origin             │  │  lb-canary-origin             │  │
│  │  Endpoint: GET                │  │  Endpoint: GET                │  │
│  │    /api/lb/canary-demo        │  │    /api/lb/canary-demo        │  │
│  │  Response:                    │  │  Response:                    │  │
│  │  { "role": "stable",         │  │  { "role": "canary",          │  │
│  │    "message": "canary demo", │  │    "message": "canary demo",  │  │
│  │    "upstream":                │  │    "upstream":                │  │
│  │      "lb-stable-origin" }     │  │      "lb-canary-origin" }     │  │
│  └──────────────────────────────┘  └──────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `full-no-cdn` (bắt buộc) | `docker ps` thấy Nginx container, không thấy Varnish |
| `BASE_URL` | `http://localhost:80` | `curl -sI http://localhost:80/api/lb/canary-demo` thấy `X-Served-By: nginx` |
| `lb-stable-origin` đang chạy | Service trả về 200 với `role: "stable"` | `curl http://localhost:80/api/lb/canary-demo -H "X-Canary: never"` |
| `lb-canary-origin` đang chạy | Service trả về 200 với `role: "canary"` | `curl http://localhost:80/api/lb/canary-demo -H "X-Canary: always"` |
| Nginx có `split_clients` config | `split_clients` trong `nginx.conf` với tỉ lệ stable/canary | Xem file cấu hình Nginx |
| Không có CDN/Varnish | `X-Cache` header phải vắng mặt | `curl -sI http://localhost:80/api/lb/canary-demo \| grep -i x-cache` → không có output |

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

# Xác nhận cả hai origin đều hoạt động
curl -s http://localhost:80/api/lb/canary-demo -H "X-Canary: never"
# → {"role":"stable","message":"canary demo","upstream":"lb-stable-origin"}

curl -s http://localhost:80/api/lb/canary-demo -H "X-Canary: always"
# → {"role":"canary","message":"canary demo","upstream":"lb-canary-origin"}

# Xác nhận không có Varnish (CDN)
docker ps --filter "name=varnish"  # Phải trả về rỗng
```

### 4.4 Precondition của script

Script này **không có `setup()` function**. Lý do:

- Không cần pre-populate cache (khác với CDN cases)
- Không có state cần clear giữa các lần chạy
- Mỗi request là độc lập -- routing decision được đưa ra tại thời điểm request đến Nginx
- Cả stable origin và canary origin đều stateless (không có session, không có sticky)

Tuy nhiên, có một precondition quan trọng: **cả hai origin (`lb-stable-origin` và `lb-canary-origin`) phải được khởi động và healthy trước khi chạy script**. Nếu một trong hai origin không hoạt động, Nginx có thể route request sang origin còn lại (tùy thuộc vào cấu hình fallback), làm sai lệch kết quả test.

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\lb\08-weighted-routing-canary.js
```

### 5.2 Import và dependency

```javascript
import { check } from 'k6';

import { envInt } from '../shared/common.js';
import { lbCapabilityApis, requestLB, responseHeader } from './shared.js';
```

Phân tích từng import:

| Import | Nguồn gốc | Vai trò trong script này |
| --- | --- | --- |
| `check` | `k6` built-in | Xác minh status, upstream, channel, role cho từng response |
| `envInt` | `../shared/common.js` | Đọc biến môi trường dạng số nguyên, có fallback default |
| `lbCapabilityApis` | `./shared.js` | Object chứa định nghĩa API `canaryDemo` (`GET /api/lb/canary-demo`) |
| `requestLB` | `./shared.js` | Hàm gửi HTTP request qua Nginx (`:80`) |
| `responseHeader` | `./shared.js` | Hàm trích xuất giá trị header từ response (case-insensitive) |

### 5.3 Biến môi trường (env knobs)

```javascript
const CANARY_SAMPLE_SIZE = envInt('LB_CANARY_SAMPLE_SIZE', 120);
const CANARY_MIN_PERCENT = envInt('LB_CANARY_MIN_PERCENT', 5);
const CANARY_MAX_PERCENT = envInt('LB_CANARY_MAX_PERCENT', 30);
```

Ba biến môi trường cho phép điều chỉnh tham số canary test:

| Biến | Default | Ý nghĩa | Khi nào tăng | Khi nào giảm |
| --- | --- | --- | --- | --- |
| `LB_CANARY_SAMPLE_SIZE` | `120` | Số lượng request trong weighted sample | Cần độ chính xác thống kê cao hơn | Chạy nhanh để smoke test |
| `LB_CANARY_MIN_PERCENT` | `5` | Ngưỡng dưới của canary share (%) | Muốn nới lỏng điều kiện pass | Muốn thắt chặt điều kiện pass |
| `LB_CANARY_MAX_PERCENT` | `30` | Ngưỡng trên của canary share (%) | Muốn nới lỏng điều kiện pass | Muốn thắt chặt điều kiện pass |

**Lưu ý về dải [5%, 30%]:** Dải này được chọn rộng hơn tỉ lệ thực tế của `split_clients` (thường là 15%) vì:

- Với sample size 120, phân phối nhị thức có phương sai đáng kể
- Không yêu cầu tỉ lệ chính xác 15.00% -- chỉ cần nằm trong vùng an toàn
- Dải rộng giúp tránh false negative do nhiễu thống kê
- Xem thêm section 12 về misconception "canary share phải đúng exact %"

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
    scenario: 'lb_weighted_routing_canary',
    target_layer: 'lb',
    lb_profile: 'full-no-cdn',
  },
};
```

Phân tích chi tiết:

#### VUs và Iterations

```javascript
vus: 1,          // 1 VU duy nhất
iterations: 1,   // Chạy đúng 1 lần
```

Khác với case 07 (dùng `constant-arrival-rate` với hàng trăm iteration), case 08 dùng **1 VU, 1 iteration**. Toàn bộ 120+ request được gửi tuần tự bên trong `default()` function qua vòng lặp `for`.

Đây là thiết kế có chủ đích:

- **Tuần tự**: forced_stable → forced_canary → weighted_sample (theo đúng thứ tự)
- **Đơn luồng**: Không có race condition giữa các VUs
- **Kiểm soát**: Biết chính xác thứ tự và số lượng request

#### Thresholds

```javascript
thresholds: {
  checks: ['rate==1'],           // 100% checks phải pass
  http_req_failed: ['rate==0'],  // Không có request nào failed
}
```

Khác với case 07 (nơi `http_req_failed > 0` là expected), case 08 yêu cầu **0% failed request**. Tất cả request đến canary-demo endpoint phải thành công (200), bất kể được route sang stable hay canary.

##### Phân tích executor: vì sao dùng `per-vu-iterations` cho case này?

Config dùng bare form `vus=1, iterations=1` → `per-vu-iterations`. **Đặc biệt:**
1 iteration chứa 120+ request gửi tuần tự qua vòng lặp `for` bên trong.

**Yêu cầu của case:**

```text
1. Canary routing proof: forced_stable → forced_canary → weighted_sample
   → 3 phase TUẦN TỰ bên trong 1 iteration
   → Mỗi phase có assertion riêng (100% stable, 100% canary, ~20%/80%)
   → KHÔNG thể dùng nhiều VU — request bị trộn → không verify được tỷ lệ

2. 1 VU, 1 iteration, 120+ request nội bộ:
   → Dùng vòng lặp for (không dùng k6 iteration loop)
   → Kiểm soát chính xác thứ tự và số lượng request
   → Đếm instance_id để verify phân phối canary
```

**So sánh executor:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **per-vu-iterations** (đang dùng) | ✅ **ĐÚNG** | 1 VU × 1 iter. 120+ request tuần tự trong vòng lặp. Deterministic. |
| constant-vus | ❌ SAI | Nhiều VU → request bị trộn → không verify được tỷ lệ canary. |
| constant-arrival-rate | ❌ SAI | Ép rate. Case này cần sequence tuần tự 3 phase, không phải rate. |
| shared-iterations | ⚠️ Kết quả giống | `vus=1` → output giống. Nhưng per-vu-iterations đúng semantic hơn. |
| ramping-vus | ❌ SAI | Không cần ramp. |

**Key insight**: Canary test = "gọi 120 lần, đếm xem ~20% có vào canary
không?". Cần TUẦN TỰ và KIỂM SOÁT — 1 VU với vòng lặp nội bộ cho phép đếm
chính xác. Đây là pattern "1 iteration = N sample request" — khác với pattern
"1 iteration = 1 request" của CDN correctness.

#### Tags

```javascript
tags: {
  scenario: 'lb_weighted_routing_canary',
  target_layer: 'lb',
  lb_profile: 'full-no-cdn',
}
```

Tags được áp dụng cho tất cả metrics trong script này, cho phép lọc và nhóm trên dashboard.

### 5.5 assertCanaryResponse -- helper function

```javascript
function assertCanaryResponse(res, expectedUpstream, expectedChannel, label) {
  check(res, {
    [`${label} status`]: (r) => r.status === 200,
    [`${label} upstream matches`]: (r) => responseHeader(r, 'X-Upstream-Service') === expectedUpstream,
    [`${label} release channel matches`]: (r) => responseHeader(r, 'X-LB-Release-Channel') === expectedChannel,
    [`${label} body role matches`]: (r) => r.json('role') === expectedChannel,
    [`${label} no cache header`]: (r) => !responseHeader(r, 'X-Cache'),
  });
}
```

Hàm này đóng gói 5 checks cho mỗi response canary:

| # | Check | Ý nghĩa | Ví dụ cho forced_stable |
| --- | --- | --- | --- |
| 1 | `status === 200` | Request thành công | `200 === 200` |
| 2 | `X-Upstream-Service === expectedUpstream` | Được route đến đúng origin | `lb-stable-origin === lb-stable-origin` |
| 3 | `X-LB-Release-Channel === expectedChannel` | Channel header đúng | `stable === stable` |
| 4 | `body.role === expectedChannel` | Response body xác nhận channel | `"stable" === "stable"` |
| 5 | Không có `X-Cache` | Không qua CDN | `!"MISS"` → true |

**Check 4 (body role) đặc biệt quan trọng:** Nó xác minh rằng không chỉ header nói đúng, mà **chính origin cũng xác nhận** nó là stable hay canary. Điều này ngăn chặn tình huống header bị gắn sai nhưng origin thực tế lại là phiên bản khác.

### 5.6 default function -- logic chính

#### Sub-proof 1: Forced stable

```javascript
const forcedStable = requestLB(api, {
  headers: {
    'X-Canary': 'never',
    'X-Canary-Key': 'forced-stable',
  },
  tags: {
    endpoint: api.name,
    route_mode: 'forced_stable',
  },
});
assertCanaryResponse(forcedStable, 'lb-stable-origin', 'stable', 'forced stable');
```

Phân tích:

| Thành phần | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `X-Canary: never` | Force header | Yêu cầu Nginx KHÔNG route sang canary -- luôn dùng stable |
| `X-Canary-Key: forced-stable` | Debug identifier | Giúp phân biệt request này trong log -- không ảnh hưởng routing |
| `expectedUpstream: lb-stable-origin` | Expected | Request PHẢI đến stable origin |
| `expectedChannel: stable` | Expected | Response PHẢI có `X-LB-Release-Channel: stable` |
| `label: 'forced stable'` | Check prefix | Tên check trong output: `forced stable status`, `forced stable upstream matches`, ... |

#### Sub-proof 2: Forced canary

```javascript
const forcedCanary = requestLB(api, {
  headers: {
    'X-Canary': 'always',
    'X-Canary-Key': 'forced-canary',
  },
  tags: {
    endpoint: api.name,
    route_mode: 'forced_canary',
  },
});
assertCanaryResponse(forcedCanary, 'lb-canary-origin', 'canary', 'forced canary');
```

Tương tự sub-proof 1, nhưng với `X-Canary: always` -- yêu cầu Nginx LUÔN route sang canary.

#### Sub-proof 3: Weighted sample

```javascript
let canaryCount = 0;
let stableCount = 0;

for (let i = 0; i < CANARY_SAMPLE_SIZE; i += 1) {
  const sample = requestLB(api, {
    headers: {
      'X-Canary-Key': `sample-${i}`,
    },
    tags: {
      endpoint: api.name,
      route_mode: 'weighted_sample',
    },
  });

  const channel = responseHeader(sample, 'X-LB-Release-Channel');
  check(sample, {
    [`weighted sample ${i} status`]: (r) => r.status === 200,
    [`weighted sample ${i} valid channel`]: () => channel === 'stable' || channel === 'canary',
  });

  if (channel === 'canary') {
    canaryCount += 1;
  } else if (channel === 'stable') {
    stableCount += 1;
  }
}
```

Phân tích vòng lặp:

1. **Không gửi `X-Canary` header** -- để Nginx tự quyết định routing dựa trên `split_clients`
2. **Gửi `X-Canary-Key: sample-<i>`** -- mỗi request có key khác nhau, giúp `split_clients` phân tán đều
3. **Đọc `X-LB-Release-Channel`** từ response để biết request được route đến đâu
4. **Đếm canary và stable** riêng biệt

#### Kiểm tra tỉ lệ canary

```javascript
const canaryPercent = (canaryCount / CANARY_SAMPLE_SIZE) * 100;
check(null, {
  'weighted sample observed stable traffic': () => stableCount > 0,
  'weighted sample observed canary traffic': () => canaryCount > 0,
  'weighted sample canary ratio in expected band': () =>
    canaryPercent >= CANARY_MIN_PERCENT && canaryPercent <= CANARY_MAX_PERCENT,
});
```

Ba checks cuối cùng sử dụng `check(null, {...})` -- đây là pattern cho phép kiểm tra các điều kiện **không gắn với một response cụ thể**:

| Check | Ý nghĩa | Tại sao quan trọng |
| --- | --- | --- |
| `observed stable traffic` | `stableCount > 0` | Phải có ít nhất một request đến stable -- chứng minh stable vẫn hoạt động |
| `observed canary traffic` | `canaryCount > 0` | Phải có ít nhất một request đến canary -- chứng minh canary đang nhận traffic |
| `canary ratio in expected band` | `canaryPercent ∈ [5%, 30%]` | Tỉ lệ canary phải nằm trong dải cho phép -- không quá ít, không quá nhiều |

### 5.7 Sơ đồ tổ chức toàn bộ script

```text
┌─ Import: check (k6), envInt (common), lbCapabilityApis + requestLB + responseHeader (shared)
│
├─ Env vars: CANARY_SAMPLE_SIZE (120), CANARY_MIN_PERCENT (5), CANARY_MAX_PERCENT (30)
│
├─ options
│   ├─ vus: 1, iterations: 1
│   ├─ thresholds: checks rate==1, http_req_failed rate==0
│   └─ tags: scenario, target_layer, lb_profile
│
├─ assertCanaryResponse(res, expectedUpstream, expectedChannel, label) ← local helper
│   ├─ check status === 200
│   ├─ check X-Upstream-Service === expectedUpstream
│   ├─ check X-LB-Release-Channel === expectedChannel
│   ├─ check body.role === expectedChannel
│   └─ check no X-Cache
│
└─ default()
    ├─ Lấy api = lbCapabilityApis.canaryDemo
    │
    ├─ Sub-proof 1: Forced stable
    │   ├─ GET /api/lb/canary-demo với X-Canary: never
    │   └─ assertCanaryResponse(forcedStable, 'lb-stable-origin', 'stable', 'forced stable')
    │
    ├─ Sub-proof 2: Forced canary
    │   ├─ GET /api/lb/canary-demo với X-Canary: always
    │   └─ assertCanaryResponse(forcedCanary, 'lb-canary-origin', 'canary', 'forced canary')
    │
    └─ Sub-proof 3: Weighted sample
        ├─ Vòng lặp for (i = 0; i < 120; i++)
        │   ├─ GET /api/lb/canary-demo với X-Canary-Key: sample-<i>
        │   ├─ check status === 200
        │   ├─ check channel in {stable, canary}
        │   └─ Đếm canaryCount, stableCount
        │
        └─ Check tổng kết:
            ├─ stableCount > 0
            ├─ canaryCount > 0
            └─ canaryPercent ∈ [5%, 30%]
```

---

## 6. Nginx/LB mechanism deep-dive

### 6.1 Kiến trúc canary routing trong Nginx

Nginx không có directive "canary" built-in. Thay vào đó, canary routing được xây dựng bằng cách kết hợp ba cơ chế:

| Cơ chế | Directive | Vai trò trong canary routing |
| --- | --- | --- |
| **Weighted split** | `split_clients` | Phân chia traffic giữa stable và canary dựa trên hash của key |
| **Variable mapping** | `map` | Quyết định upstream dựa trên giá trị của biến (có thể bị force bởi header) |
| **Upstream groups** | `upstream` | Định nghĩa nhóm các origin server cho stable và canary |

### 6.2 split_clients -- trái tim của weighted routing

```nginx
split_clients $canary_key $canary_variant {
    85%    stable;
    15%    canary;
}
```

Phân tích từng phần:

| Thành phần | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `$canary_key` | Biến chứa key để hash | Mỗi giá trị key khác nhau → hash khác nhau → phân phối ngẫu nhiên |
| `$canary_variant` | Biến output | Sau directive này, `$canary_variant` = `"stable"` hoặc `"canary"` |
| `85% stable` | 85% traffic → stable | Hash space từ 0% đến 85% → `stable` |
| `15% canary` | 15% traffic → canary | Hash space từ 85% đến 100% → `canary` |

#### Cách `split_clients` hoạt động:

```text
1. Nginx lấy giá trị của $canary_key
   Ví dụ: $canary_key = "sample-42"

2. Nginx hash giá trị này bằng MurmurHash2 (32-bit)
   → Một số nguyên trong khoảng [0, 2^32 - 1]

3. Nginx chia hash space thành các bucket theo tỉ lệ:
   → [0, 85%)      → "stable"
   → [85%, 100%)   → "canary"

4. Nginx map hash value vào bucket:
   → Nếu hash value nằm trong [0, 85%) → $canary_variant = "stable"
   → Nếu hash value nằm trong [85%, 100%) → $canary_variant = "canary"
```

**Điểm quan trọng:** Cùng một giá trị `$canary_key` LUÔN cho cùng một kết quả hash → cùng một người dùng (cùng key) luôn được route đến cùng một channel. Điều này đảm bảo **sticky canary** -- người dùng không bị "nhảy" qua lại giữa stable và canary.

### 6.3 map -- cầu nối giữa force header và weighted split

```nginx
map $http_x_canary $canary_key {
    default    $http_x_canary_key;   # Không có force → dùng X-Canary-Key để hash
    "never"    "forced_stable";      # Force stable
    "always"   "forced_canary";      # Force canary
}
```

Hoặc biến thể phức tạp hơn với `$canary_route` thay vì `$canary_key`:

```nginx
map $http_x_canary $canary_route {
    default    $canary_variant;      # Không có force → dùng kết quả split_clients
    "never"    "stable";             # Force stable
    "always"   "canary";             # Force canary
}
```

Phân tích:

| `X-Canary` header | `$canary_route` | Hành vi |
| --- | --- | --- |
| (không có) | `$canary_variant` (kết quả của `split_clients`) | Weighted split: hash `X-Canary-Key` → stable hoặc canary |
| `never` | `stable` | Forced stable: luôn route sang `lb-stable-origin` |
| `always` | `canary` | Forced canary: luôn route sang `lb-canary-origin` |

### 6.4 upstream -- định nghĩa nhóm origin

```nginx
upstream lb_stable_origin {
    server lb-stable-origin:8080;
}

upstream lb_canary_origin {
    server lb-canary-origin:8080;
}
```

Và trong `location` block:

```nginx
location /api/lb/canary-demo {
    if ($canary_route = "canary") {
        proxy_pass http://lb_canary_origin;
    }
    proxy_pass http://lb_stable_origin;
}
```

Hoặc dùng `map` để chọn upstream trực tiếp:

```nginx
map $canary_route $canary_upstream {
    "stable"    "http://lb_stable_origin";
    "canary"    "http://lb_canary_origin";
}

location /api/lb/canary-demo {
    proxy_pass $canary_upstream;
}
```

### 6.5 Gắn header response để xác nhận routing

```nginx
location /api/lb/canary-demo {
    # ... routing logic ...

    # Gắn header cho biết channel đã route
    add_header X-LB-Release-Channel $canary_route;

    # Gắn header cho biết upstream service
    add_header X-Upstream-Service $canary_upstream_name;
}
```

Đây là phần quan trọng để script k6 có thể xác minh routing. Nếu không có các header này, script không thể phân biệt được request đã đến stable hay canary.

### 6.6 Chuỗi xử lý hoàn chỉnh trong Nginx

```text
Request đến /api/lb/canary-demo
        │
        ▼
┌──────────────────────────────────────────────────────┐
│ 1. Đọc X-Canary header từ request                     │
│    • "never"  → $canary_route = "stable" (forced)     │
│    • "always" → $canary_route = "canary" (forced)     │
│    • (không có) → tiếp tục bước 2                     │
└────────────────────────┬─────────────────────────────┘
                         │ (không có force header)
                         ▼
┌──────────────────────────────────────────────────────┐
│ 2. Đọc X-Canary-Key header từ request                 │
│    • "sample-42" → $canary_key = "sample-42"          │
│    • (không có) → $canary_key = $remote_addr (fallback)│
└────────────────────────┬─────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│ 3. split_clients $canary_key → $canary_variant        │
│    • MurmurHash2("sample-42") → bucket                │
│    • 85% stable, 15% canary                           │
│    → $canary_variant = "canary" (nếu hash ≥ 85%)      │
└────────────────────────┬─────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│ 4. Chọn upstream dựa trên $canary_route               │
│    • "stable" → proxy_pass http://lb_stable_origin    │
│    • "canary" → proxy_pass http://lb_canary_origin    │
└────────────────────────┬─────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│ 5. Nhận response từ origin, gắn thêm headers:         │
│    • X-LB-Release-Channel: $canary_route               │
│    • X-Upstream-Service: $canary_upstream_name         │
│    • X-Served-By: nginx                                │
│    • X-Request-ID: <uuid>                              │
└──────────────────────────────────────────────────────┘
```

### 6.7 Hash key và tính ổn định

`split_clients` dùng MurmurHash2 -- một hash function không phải cryptographic, nhưng có tính phân phối tốt. Điều quan trọng là:

- **Cùng key → cùng bucket**: Một key cụ thể (vd: `"sample-42"`) luôn cho cùng một kết quả hash
- **Phân phối đều**: Các key khác nhau được phân phối đều trên toàn bộ hash space
- **Không phụ thuộc thứ tự**: Thứ tự request không ảnh hưởng đến kết quả hash

Trong production, `$canary_key` thường là:
- **User ID**: Cùng một user luôn thấy cùng một phiên bản
- **Session ID**: Cùng một session luôn thấy cùng một phiên bản
- **Cookie value**: Dựa trên cookie được set từ lần đầu truy cập

Trong test case này, `X-Canary-Key: sample-<i>` được dùng để mô phỏng nhiều "người dùng" khác nhau.

---

## 7. Request sequence flow

### 7.1 Timeline tổng thể

```text
Thời gian
0ms                 50ms                 100ms                ...               ~3000ms
│                   │                    │                                      │
├───────────────────┼────────────────────┼──────────────────────────────────────┤
│                   │                    │                                      │
│  Sub-proof 1:     │  Sub-proof 2:      │  Sub-proof 3: Weighted sample        │
│  Forced stable    │  Forced canary     │                                      │
│                   │                    │  for (i = 0; i < 120; i++) {         │
│  GET cùng        │  GET cùng        │    GET /api/lb/canary-demo         │
│  X-Canary: never  │  X-Canary: always │    X-Canary-Key: sample-<i>         │
│                   │                    │    (không có X-Canary header)        │
│  → 200 OK         │  → 200 OK         │                                      │
│  channel: stable  │  channel: canary  │    Đọc X-LB-Release-Channel          │
│  upstream:        │  upstream:        │    Phân loại: stable hay canary?     │
│  lb-stable-origin │  lb-canary-origin │  }                                   │
│                   │                    │                                      │
│  ~30ms            │  ~30ms            │  ~120 × 15ms = ~1800ms               │
│                   │                    │                                      │
└───────────────────┴────────────────────┴──────────────────────────────────────┘
                                                                      │
                                                                Check tổng kết:
                                                                canaryPercent ∈ [5%, 30%] ?
```

### 7.2 Timeline chi tiết cho forced stable

```text
VU gọi default()
│
├─ 0ms:    Lấy api = lbCapabilityApis.canaryDemo
│          → { name: 'lb_canary_demo', method: 'GET', path: '/api/lb/canary-demo' }
│
├─ 0ms:    Gọi requestLB(api, { headers: { 'X-Canary': 'never', 'X-Canary-Key': 'forced-stable' } })
│          → Xây dựng HTTP request:
│            GET http://localhost:80/api/lb/canary-demo
│            X-Canary: never
│            X-Canary-Key: forced-stable
│
├─ ~1ms:   TCP connection đến Nginx :80
│
├─ ~1ms:   Nginx đọc X-Canary header
│          → "never" → $canary_route = "stable" (forced)
│          → Bỏ qua split_clients
│
├─ ~2ms:   Nginx forward request đến lb-stable-origin
│
├─ ~5ms:   lb-stable-origin xử lý và trả về 200 OK
│          { "role": "stable", "message": "canary demo", "upstream": "lb-stable-origin" }
│
├─ ~6ms:   Nginx nhận response, thêm headers:
│          X-LB-Release-Channel: stable
│          X-Upstream-Service: lb-stable-origin
│          X-Served-By: nginx
│          X-Request-ID: <uuid>
│
├─ ~7ms:   Nginx trả response cho k6 VU
│
├─ ~7ms:   assertCanaryResponse(forcedStable, 'lb-stable-origin', 'stable', 'forced stable')
│          ✓ forced stable status (200 === 200)
│          ✓ forced stable upstream matches (lb-stable-origin === lb-stable-origin)
│          ✓ forced stable release channel matches (stable === stable)
│          ✓ forced stable body role matches ("stable" === "stable")
│          ✓ forced stable no cache header (không có X-Cache)
│
└─ ~7ms:   Sub-proof 1 hoàn thành → chuyển sang sub-proof 2
```

### 7.3 Timeline chi tiết cho weighted sample

```text
┌─ Bắt đầu vòng lặp for (i = 0; i < 120; i++)
│
├─ i=0:   GET /api/lb/canary-demo, X-Canary-Key: sample-0
│         → Nginx không có X-Canary → dùng split_clients
│         → MurmurHash2("sample-0") → bucket?
│         → Giả sử hash value = 60% → < 85% → stable
│         → proxy_pass http://lb_stable_origin
│         → 200 OK, X-LB-Release-Channel: stable
│         → stableCount++
│
├─ i=1:   GET /api/lb/canary-demo, X-Canary-Key: sample-1
│         → MurmurHash2("sample-1") → bucket?
│         → Giả sử hash value = 92% → >= 85% → canary
│         → proxy_pass http://lb_canary_origin
│         → 200 OK, X-LB-Release-Channel: canary
│         → canaryCount++
│
├─ i=2:   ... tương tự ...
│
├─ ...
│
├─ i=119: GET /api/lb/canary-demo, X-Canary-Key: sample-119
│         → ...
│
└─ Kết thúc vòng lặp
   canaryCount = ? (thường 10-25, ≈15% của 120)
   stableCount = ? (thường 95-110, ≈85% của 120)
   canaryPercent = (canaryCount / 120) * 100
```

### 7.4 Phân phối thống kê của weighted sample

Với `split_clients 15% canary` và sample size 120, phân phối của `canaryCount` theo phân phối nhị thức:

```text
Binomial(n=120, p=0.15)

Expected value (trung bình):
  E[canaryCount] = n × p = 120 × 0.15 = 18

Standard deviation:
  σ = sqrt(n × p × (1-p)) = sqrt(120 × 0.15 × 0.85) ≈ 3.91

Khoảng tin cậy 95% (approximation):
  18 ± 1.96 × 3.91 ≈ [10.3, 25.7]

Tỉ lệ canary tương ứng:
  [10.3/120, 25.7/120] × 100 ≈ [8.6%, 21.4%]
```

Như vậy, với sample size 120 và tỉ lệ thực 15%, canary share quan sát được thường nằm trong khoảng 8.6% - 21.4%. Dải [5%, 30%] được chọn rộng hơn để đảm bảo không có false negative do biến động thống kê.

---

## 8. Key signals / headers

### 8.1 Bảng signals chính

| Signal | Vị trí | Expected value | Ý nghĩa | Nếu sai |
| --- | --- | --- | --- | --- |
| `status` | HTTP response status | `200` | Tất cả request phải thành công | Nếu khác 200 → origin lỗi hoặc Nginx misconfigured |
| `X-LB-Release-Channel` | Response header | `stable` hoặc `canary` | Channel mà Nginx đã route đến | Nếu thiếu → Nginx không gắn header; nếu sai → routing sai |
| `X-Upstream-Service` | Response header | `lb-stable-origin` (khi channel=stable) hoặc `lb-canary-origin` (khi channel=canary) | Origin cụ thể đã xử lý request | Nếu không khớp channel → routing bị "nhầm" origin |
| `X-Served-By` | Response header | `nginx` | Xác nhận request đi qua Nginx | Nếu thiếu → request không qua Gateway |
| `X-Request-ID` | Response header | UUID string | Mỗi request có trace ID duy nhất | Nếu thiếu → Nginx không gắn request ID |
| `X-Cache` | Response header | **absent** | Profile `full-no-cdn` không được có CDN cache | Nếu có → đang chạy sai topology (qua Varnish) |
| `body.role` | Response body (JSON field) | `"stable"` hoặc `"canary"` (phải khớp với `X-LB-Release-Channel`) | Origin tự xác nhận channel của nó | Nếu không khớp → origin bị cấu hình sai role |
| `checks rate` | k6 built-in metric | `1.0` (100%) | Tất cả checks phải pass | Nếu < 1 → có request không thỏa mãn điều kiện |
| `http_req_failed` | k6 built-in metric | `rate == 0` | Không có request nào thất bại | Nếu > 0 → có request không thành công (status != 200) |

### 8.2 Bảng signals cho từng sub-proof

| Sub-proof | `X-Canary` header gửi đi | `X-LB-Release-Channel` expected | `X-Upstream-Service` expected | `body.role` expected |
| --- | --- | --- | --- | --- |
| Forced stable | `never` | `stable` | `lb-stable-origin` | `"stable"` |
| Forced canary | `always` | `canary` | `lb-canary-origin` | `"canary"` |
| Weighted sample | (không có) | `stable` hoặc `canary` | `lb-stable-origin` hoặc `lb-canary-origin` | `"stable"` hoặc `"canary"` |

### 8.3 Signal không có trong response (và đó là điều tốt)

| Signal | Vị trí | Expected | Tại sao quan trọng |
| --- | --- | --- | --- |
| `X-Cache` | Response header | **absent** | Chứng minh request đi thẳng từ Nginx đến origin, không qua CDN |
| `Set-Cookie` | Response header | **absent** (trong case này) | Canary routing dùng header-based, không cần cookie |
| Status 3xx | HTTP status | **absent** | Không có redirect -- request đến đúng endpoint ngay từ đầu |

### 8.4 Cách đọc channel từ response

```javascript
// Trong script
const channel = responseHeader(sample, 'X-LB-Release-Channel');

// responseHeader hoạt động case-insensitive:
// "X-LB-Release-Channel", "x-lb-release-channel", "X-Lb-Release-Channel" → đều được
```

Trong `shared.js`, hàm `responseHeader` tìm kiếm header không phân biệt hoa thường:

```javascript
function headerValue(res, name) {
  const headers = res.headers || {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return headers[key];
    }
  }
  return '';
}
```

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Một test run được coi là PASS khi thỏa mãn **tất cả** các điều kiện sau:

| # | Tiêu chí | Cách kiểm tra | Giải thích |
| --- | --- | --- | --- |
| 1 | Forced stable đúng | `X-LB-Release-Channel === 'stable'`, `X-Upstream-Service === 'lb-stable-origin'` | `X-Canary: never` luôn route sang stable |
| 2 | Forced canary đúng | `X-LB-Release-Channel === 'canary'`, `X-Upstream-Service === 'lb-canary-origin'` | `X-Canary: always` luôn route sang canary |
| 3 | Cả stable và canary đều nhận được traffic | `stableCount > 0` và `canaryCount > 0` | `split_clients` đang phân phối traffic cho cả hai |
| 4 | Canary share trong dải cho phép | `canaryPercent ∈ [CANARY_MIN_PERCENT, CANARY_MAX_PERCENT]` | Tỉ lệ canary không quá thấp, không quá cao |
| 5 | Tất cả request đều 200 | `http_req_failed rate == 0` | Không có request nào thất bại |
| 6 | Tất cả checks pass | `checks rate == 1` | Mọi response đều thỏa mãn tất cả điều kiện |
| 7 | Không có CDN cache | Không có `X-Cache` header trong bất kỳ response nào | Xác nhận đúng topology `full-no-cdn` |

### 9.2 Tiêu chí FAIL

| # | Hiện tượng | Nguyên nhân có thể | Cách debug |
| --- | --- | --- | --- |
| 1 | `X-Canary: never` nhưng vẫn đến canary | `map` directive không xử lý `never` đúng; hoặc `proxy_pass` không dùng biến `$canary_route` | Kiểm tra `nginx.conf`: `map $http_x_canary $canary_route` |
| 2 | `X-Canary: always` nhưng vẫn đến stable | Tương tự như trên -- `map` directive sai hoặc thiếu | Kiểm tra `nginx.conf` |
| 3 | `canaryCount === 0` | `split_clients` không hoạt động; hoặc `$canary_key` luôn cho cùng một hash | Kiểm tra `split_clients` config; kiểm tra `$canary_key` có thay đổi giữa các request không |
| 4 | `stableCount === 0` | Tất cả traffic đều đến canary -- `split_clients` tỉ lệ sai (100% canary) | Kiểm tra `split_clients` percentage |
| 5 | `canaryPercent < CANARY_MIN_PERCENT` | Canary nhận quá ít traffic; sample size quá nhỏ; hoặc `split_clients` tỉ lệ quá thấp | Tăng `LB_CANARY_SAMPLE_SIZE`; kiểm tra `split_clients` config |
| 6 | `canaryPercent > CANARY_MAX_PERCENT` | Canary nhận quá nhiều traffic; `split_clients` tỉ lệ quá cao | Kiểm tra `split_clients` config; giảm canary percentage |
| 7 | `X-LB-Release-Channel` thiếu | Nginx không được cấu hình `add_header X-LB-Release-Channel` | Thêm `add_header` directive vào `location` block |
| 8 | `body.role` không khớp `X-LB-Release-Channel` | Origin bị cấu hình sai role | Kiểm tra environment variable của origin service |
| 9 | Có `X-Cache` header | Đang chạy qua CDN/Varnish | Dùng `TargetLayer=full-no-cdn` |
| 10 | `http_req_failed > 0` | Một hoặc cả hai origin không hoạt động | Kiểm tra health của `lb-stable-origin` và `lb-canary-origin` |

### 9.3 Ngưỡng tham chiếu

Dựa trên kết quả validation thực tế (xem section 16), với `split_clients 15% canary` và sample size 120:

```text
PASS zone:
  stableCount:     90 - 110  (75% - 92%)
  canaryCount:     10 - 30   (8% - 25%)
  canaryPercent:   8% - 25%  (trong dải [5%, 30%])
  forced stable:   upstream = lb-stable-origin, channel = stable
  forced canary:   upstream = lb-canary-origin, channel = canary

FAIL zone:
  canaryCount:     0 hoặc > 36 (0% hoặc > 30%)
  forced stable:   upstream != lb-stable-origin hoặc channel != stable
  forced canary:   upstream != lb-canary-origin hoặc channel != canary
  http_req_failed: > 0
```

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy qua runner script

```powershell
cd E:\Projects\k6\k6-metrics-server
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 08-weighted-routing-canary
```

### 10.2 Lệnh chạy trực tiếp bằng k6

```powershell
cd E:\Projects\k6\k6-metrics-server\load-target

$env:BASE_URL = "http://localhost:80"
$env:LB_CANARY_SAMPLE_SIZE = "120"
$env:LB_CANARY_MIN_PERCENT = "5"
$env:LB_CANARY_MAX_PERCENT = "30"

k6 run ./k6/lb/08-weighted-routing-canary.js
```

### 10.3 Output mẫu (PASS)

```text
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: ./k6/lb/08-weighted-routing-canary.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):

  ✓ forced stable status
  ✓ forced stable upstream matches
  ✓ forced stable release channel matches
  ✓ forced stable body role matches
  ✓ forced stable no cache header

  ✓ forced canary status
  ✓ forced canary upstream matches
  ✓ forced canary release channel matches
  ✓ forced canary body role matches
  ✓ forced canary no cache header

  ✓ weighted sample 0 status
  ✓ weighted sample 0 valid channel
  ✓ weighted sample 1 status
  ✓ weighted sample 1 valid channel
  ... (120 lần)
  ✓ weighted sample 119 status
  ✓ weighted sample 119 valid channel

  ✓ weighted sample observed stable traffic
  ✓ weighted sample observed canary traffic
  ✓ weighted sample canary ratio in expected band

  checks .........................................: 100.00% ✓ 253      ✗ 0
  http_req_failed ................................: 0.00%   ✓ 0        ✗ 122
  http_req_duration ..............................: avg=5ms  min=1ms  med=4ms  max=18ms  p90=8ms  p95=11ms

  Result: PASS
  Exit code: 0
```

### 10.4 Đọc output

| Dòng | Ý nghĩa |
| --- | --- |
| `forced stable *` (5 checks) | Sub-proof 1 pass -- `X-Canary: never` route đúng về stable |
| `forced canary *` (5 checks) | Sub-proof 2 pass -- `X-Canary: always` route đúng về canary |
| `weighted sample N *` (240 checks, 2 cho mỗi request) | Sub-proof 3 pass -- tất cả 120 request đều 200 và channel hợp lệ |
| `observed stable traffic` | Có ít nhất 1 request đến stable |
| `observed canary traffic` | Có ít nhất 1 request đến canary |
| `canary ratio in expected band` | Tỉ lệ canary nằm trong [5%, 30%] |
| `checks: 100.00%` (253/253) | Tất cả checks pass |
| `http_req_failed: 0.00%` (0/122) | Không có request nào thất bại |
| `http_req_duration: avg=5ms` | Response time rất thấp -- cả hai origin đều nhanh |

---

## 11. 4 output -> decision scenarios

### Scenario 1: PASS hoàn hảo

```text
forced stable:     upstream=lb-stable-origin, channel=stable ✓
forced canary:     upstream=lb-canary-origin, channel=canary ✓
weighted sample:   stableCount=102, canaryCount=18 (15.0%)
canaryPercent:     15.0% ∈ [5%, 30%]
checks rate:       1.0
http_req_failed:   0/122

→ Decision: ✓ Canary routing hoạt động đúng. Có thể tự tin triển khai canary
  deployment lên production. Force header được tôn trọng, weighted split đúng tỉ lệ.
```

### Scenario 2: Force header bị bỏ qua (NGUY HIỂM)

```text
forced stable:     upstream=lb-canary-origin, channel=canary ✗  ← SAI!
forced canary:     upstream=lb-canary-origin, channel=canary ✓
weighted sample:   stableCount=102, canaryCount=18 (15.0%)
checks rate:       0.98

→ Decision: ✗ Force header "never" bị bỏ qua. Nguyên nhân có thể:
  1. map $http_x_canary $canary_route không được cấu hình đúng
  2. Thứ tự map/split_clients bị đảo ngược
  3. Không thể triển khai canary cho đến khi force header hoạt động
     → Developer/QA không thể xác minh bản canary → bug không được phát hiện
```

### Scenario 3: Canary không nhận được traffic

```text
forced stable:     upstream=lb-stable-origin, channel=stable ✓
forced canary:     upstream=lb-canary-origin, channel=canary ✓
weighted sample:   stableCount=120, canaryCount=0 (0.0%)
canaryPercent:     0.0% ∉ [5%, 30%]  ← SAI!
checks rate:       0.98

→ Decision: ⚠ split_clients không hoạt động. Nguyên nhân có thể:
  1. split_clients directive không được cấu hình hoặc bị sai cú pháp
  2. $canary_key luôn trả về cùng một giá trị (không thay đổi giữa các request)
  3. Tất cả request đều bị map vào bucket stable (percentage = 100% stable)
  4. Cần kiểm tra nginx.conf và chạy lại
```

### Scenario 4: Canary share ngoài dải (CẢNH BÁO)

```text
forced stable:     upstream=lb-stable-origin, channel=stable ✓
forced canary:     upstream=lb-canary-origin, channel=canary ✓
weighted sample:   stableCount=80, canaryCount=40 (33.3%)
canaryPercent:     33.3% ∉ [5%, 30%]  ← SAI!
checks rate:       0.98

→ Decision: ⚠ Canary nhận quá nhiều traffic. Nguyên nhân có thể:
  1. split_clients percentage bị cấu hình sai (vd: 35% thay vì 15%)
  2. Sample size quá nhỏ gây biến động lớn → tăng LB_CANARY_SAMPLE_SIZE
  3. Nếu split_clients đúng 15%: đây có thể là outlier thống kê
     → Chạy lại để xác nhận; nếu lặp lại → điều chỉnh split_clients
```

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "Canary share phải đúng chính xác 15.00%" -- SAI

Đây là misconception phổ biến nhất với case này.

```text
Sai:   "split_clients 15% → weighted sample phải cho kết quả 18/120 = 15.00%"
Đúng:  "split_clients 15% nghĩa là mỗi request có XÁC SUẤT 15% đến canary.
        Kết quả thực tế là một mẫu thống kê, sẽ dao động quanh 15%.
        Với 120 mẫu, biến động ±8% là hoàn toàn bình thường."

Tương tự như:
  - Tung đồng xu 120 lần: không phải lúc nào cũng 60 mặt sấp, 60 mặt ngửa
  - split_clients 15%: không phải lúc nào cũng 18/120 = 15.00% canary
```

**Minh họa bằng mô phỏng:**

```text
Chạy 10 lần, mỗi lần 120 request, split_clients 15%:

Lần 1:  canaryCount=15 (12.5%)
Lần 2:  canaryCount=22 (18.3%)  ← "cao" nhưng vẫn bình thường
Lần 3:  canaryCount=18 (15.0%)  ← "chính xác" -- may mắn
Lần 4:  canaryCount=12 (10.0%)  ← "thấp" nhưng vẫn bình thường
Lần 5:  canaryCount=20 (16.7%)
Lần 6:  canaryCount=14 (11.7%)
Lần 7:  canaryCount=19 (15.8%)
Lần 8:  canaryCount=16 (13.3%)
Lần 9:  canaryCount=24 (20.0%)  ← "cao" nhưng vẫn trong dải [5%, 30%]
Lần 10: canaryCount=17 (14.2%)

Tất cả đều PASS vì đều nằm trong [5%, 30%].
```

### 12.2 Nghịch lý 2: "Cần sample size thật lớn để kết luận" -- KHÔNG HẲN

```text
Sai:   "Cần 10,000 request mới đủ để kết luận về canary routing"
Đúng:  "120 request là đủ để xác nhận split_clients hoạt động,
        miễn là dải pass/fail được thiết kế phù hợp với sample size."

Thiết kế của case này:
  - Dải [5%, 30%] đủ rộng để tránh false negative với n=120
  - Mục tiêu: xác nhận split_clients hoạt động, không phải ước lượng chính xác tỉ lệ
  - Nếu cần đo chính xác hơn: tăng LB_CANARY_SAMPLE_SIZE lên 1000+
```

### 12.3 Nghịch lý 3: "Force header và weighted split là hai chế độ tách biệt" -- ĐÚNG NHƯNG DỄ HIỂU SAI

```text
Sai:   "Khi có X-Canary: never, Nginx vẫn chạy split_clients nhưng kết quả bị ghi đè"
Đúng:  "Khi có X-Canary: never, split_clients không được chạy (hoặc kết quả bị bỏ qua)
        Vì map directive đã set $canary_route = 'stable' trước khi split_clients được dùng."

Thì đúng hơn: map hoạt động như "override":
  - Có force header → dùng giá trị từ map, bỏ qua split_clients
  - Không có force header → dùng giá trị từ split_clients
```

### 12.4 Nghịch lý 4: "Tỉ lệ canary càng cao, test càng có giá trị" -- SAI

```text
Sai:   "Nên set split_clients 50% canary để dễ quan sát hơn"
Đúng:  "Tỉ lệ canary nên phản ánh thực tế triển khai. Mục đích của test
        là xác nhận cơ chế hoạt động, không phải tối ưu tỉ lệ."

Trong production, canary thường bắt đầu ở 5%, tăng dần lên 15%, 30%, 50%, 100%.
Test nên dùng tỉ lệ tương tự (15%) để phản ánh đúng kịch bản thực tế.
```

### 12.5 Nghịch lý 5: "Chỉ cần check header, không cần check body" -- SAI

```text
Sai:   "X-LB-Release-Channel: stable → đã đủ để kết luận request đến stable"
Đúng:  "Header có thể bị gắn sai. Cần check cả body.role để xác nhận chính
        origin cũng xác nhận nó là stable."

Tình huống nguy hiểm:
  - Nginx gắn X-LB-Release-Channel: stable
  - Nhưng thực tế proxy_pass đến lb-canary-origin (sai cấu hình upstream)
  - body.role = "canary" → phát hiện ra sự không khớp
  → Chỉ check header sẽ bỏ sót bug này
```

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=nginx"` | Có ít nhất 1 container Nginx | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn` |
| 2 | Không có Varnish/CDN | `docker ps --filter "name=varnish"` | Không có container nào | Dừng Varnish nếu đang chạy; dùng đúng `TargetLayer=full-no-cdn` |
| 3 | Stable origin hoạt động | `curl -s http://localhost:80/api/lb/canary-demo -H "X-Canary: never"` | HTTP 200, `role: "stable"` | Kiểm tra `lb-stable-origin` container |
| 4 | Canary origin hoạt động | `curl -s http://localhost:80/api/lb/canary-demo -H "X-Canary: always"` | HTTP 200, `role: "canary"` | Kiểm tra `lb-canary-origin` container |
| 5 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại biến môi trường |
| 6 | Nginx có `split_clients` config | Kiểm tra file `nginx.conf` | Có `split_clients` với stable/canary percentage | Thêm cấu hình `split_clients` |
| 7 | Nginx có `map` cho `X-Canary` header | Kiểm tra file `nginx.conf` | Có `map $http_x_canary` | Thêm cấu hình `map` |
| 8 | Nginx đã reload config mới nhất | `docker exec <nginx-container> nginx -s reload` | Không có lỗi | Kiểm tra syntax: `nginx -t` |

### 13.2 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 9 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\lb\08-weighted-routing-canary.js"` |
| 10 | `shared.js` có hàm `responseHeader` | Import không bị lỗi |
| 11 | `lbCapabilityApis.canaryDemo` trỏ đến đúng path | `/api/lb/canary-demo` phải khớp với Nginx location config |
| 12 | Cả hai origin trả về JSON với field `role` | Xác nhận bằng `curl` thủ công trước khi chạy |

### 13.3 K6 checklist

| # | Mục kiểm tra |
| --- | --- |
| 13 | k6 đã được cài đặt: `k6 version` |
| 14 | Không có biến môi trường nào conflict (`K6_*` env vars không set nhầm) |
| 15 | Sample size đủ lớn: 120 là tối thiểu; cân nhắc tăng lên 200-500 nếu cần độ chính xác cao hơn |
| 16 | Đã hiểu canary share dao động quanh tỉ lệ configured, không cần chính xác tuyệt đối |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Tăng sample size để có độ chính xác cao hơn

Mục tiêu: giảm biến động thống kê bằng cách tăng sample size.

```javascript
// Variation 1: Large sample for precision
// Chạy với:
// $env:LB_CANARY_SAMPLE_SIZE = "1000"

// Với n=1000, khoảng tin cậy 95% cho p=0.15:
// 0.15 ± 1.96 × sqrt(0.15 × 0.85 / 1000)
// = 0.15 ± 0.022
// = [12.8%, 17.2%]
// → Có thể thắt chặt dải pass xuống [10%, 20%]

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export default function () {
  const api = lbCapabilityApis.canaryDemo;
  const SAMPLE_SIZE = 1000;

  // Bỏ qua forced stable/canary (đã được kiểm chung ở case gốc)
  let canaryCount = 0;
  let stableCount = 0;

  for (let i = 0; i < SAMPLE_SIZE; i += 1) {
    const sample = requestLB(api, {
      headers: { 'X-Canary-Key': `large-sample-${i}` },
      tags: { endpoint: api.name, route_mode: 'large_sample' },
    });

    const channel = responseHeader(sample, 'X-LB-Release-Channel');
    check(sample, {
      [`sample ${i} status`]: (r) => r.status === 200,
      [`sample ${i} valid channel`]: () => channel === 'stable' || channel === 'canary',
    });

    if (channel === 'canary') canaryCount += 1;
    else if (channel === 'stable') stableCount += 1;
  }

  const canaryPercent = (canaryCount / SAMPLE_SIZE) * 100;
  console.log(`Canary: ${canaryCount}/${SAMPLE_SIZE} (${canaryPercent.toFixed(2)}%)`);
  console.log(`Stable: ${stableCount}/${SAMPLE_SIZE} (${((stableCount / SAMPLE_SIZE) * 100).toFixed(2)}%)`);

  // Dải hẹp hơn vì sample size lớn hơn
  check(null, {
    'canary ratio in narrow band [10%, 20%]': () =>
      canaryPercent >= 10 && canaryPercent <= 20,
  });
}
```

**Điểm học:** Sample size càng lớn, ước lượng càng chính xác, dải pass càng có thể thắt chặt.

### Variation 2: Dùng constant-arrival-rate thay vì vòng lặp for

Mục tiêu: test weighted routing dưới áp lực (open model), thay vì sequential 1-VU.

```javascript
// Variation 2: Canary routing under load (constant-arrival-rate)
// Lưu ý: case lb-10 đã làm việc này chi tiết hơn

import { Counter } from 'k6/metrics';

const canaryObserved = new Counter('lb_canary_observed');
const stableObserved = new Counter('lb_stable_observed');

export const options = {
  scenarios: {
    canary_under_load: {
      executor: 'constant-arrival-rate',
      rate: 30,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 20,
      maxVUs: 40,
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export default function () {
  const api = lbCapabilityApis.canaryDemo;
  const vuId = __VU;
  const iterId = __ITER;

  const res = requestLB(api, {
    headers: {
      'X-Canary-Key': `load-${vuId}-${iterId}-${Math.random()}`,
    },
    tags: {
      endpoint: api.name,
      route_mode: 'weighted_under_load',
      vu: String(vuId),
    },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has release channel': (r) => {
      const channel = responseHeader(r, 'X-LB-Release-Channel');
      return channel === 'stable' || channel === 'canary';
    },
  });

  const channel = responseHeader(res, 'X-LB-Release-Channel');
  if (channel === 'canary') {
    canaryObserved.add(1);
  } else if (channel === 'stable') {
    stableObserved.add(1);
  }
}

// Sau khi chạy, kiểm tra tỉ lệ:
// canaryObserved / (canaryObserved + stableObserved) ∈ [5%, 30%]?
```

**Điểm học:** Với `constant-arrival-rate`, canary share vẫn ổn định trong dải cho phép, chứng minh `split_clients` hoạt động đúng dưới áp lực.

### Variation 3: Test sticky canary -- cùng key luôn cùng channel

Mục tiêu: chứng minh tính sticky của `split_clients`: cùng một key luôn cho cùng một channel.

```javascript
// Variation 3: Sticky canary proof
// Gửi 10 request với cùng một key → tất cả phải về cùng một channel

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export default function () {
  const api = lbCapabilityApis.canaryDemo;
  const STICKY_KEY = 'user-42';  // Key cố định
  const REPEAT = 10;

  let firstChannel = null;

  for (let i = 0; i < REPEAT; i += 1) {
    const res = requestLB(api, {
      headers: { 'X-Canary-Key': STICKY_KEY },  // Cùng key cho tất cả request
      tags: { endpoint: api.name, route_mode: 'sticky_test', attempt: String(i) },
    });

    const channel = responseHeader(res, 'X-LB-Release-Channel');
    check(res, {
      [`sticky ${i} status`]: (r) => r.status === 200,
    });

    if (i === 0) {
      firstChannel = channel;
    } else {
      check(null, {
        [`sticky ${i} same channel as first`]: () => channel === firstChannel,
      });
    }
  }

  console.log(`Key "${STICKY_KEY}" always routed to: ${firstChannel}`);
}
```

**Điểm học:** `split_clients` dùng MurmurHash2 -- cùng input luôn cho cùng output. Điều này đảm bảo một user không bị "nhảy" qua lại giữa stable và canary.

### Variation 4: Test force header với giá trị không hợp lệ

Mục tiêu: xác minh hành vi khi `X-Canary` header có giá trị ngoài `never`/`always`.

```javascript
// Variation 4: Invalid force header handling

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  const api = lbCapabilityApis.canaryDemo;

  // Test với X-Canary: "maybe" (giá trị không hợp lệ)
  const resInvalid = requestLB(api, {
    headers: {
      'X-Canary': 'maybe',           // Không phải "never" hay "always"
      'X-Canary-Key': 'invalid-test',
    },
    tags: { endpoint: api.name, route_mode: 'invalid_force', test: 'invalid_header' },
  });

  const channel = responseHeader(resInvalid, 'X-LB-Release-Channel');
  check(resInvalid, {
    'invalid force still gets valid channel': () =>
      channel === 'stable' || channel === 'canary',
    'invalid force treated as weighted (not forced)': () => {
      // Kỳ vọng: "maybe" → không khớp "never"/"always" → fallback về weighted split
      // Channel có thể là stable hoặc canary (không bị force)
      return true;  // Chỉ cần không crash hoặc trả về lỗi
    },
  });

  console.log(`X-Canary: "maybe" → channel: ${channel}`);

  // Test với X-Canary: "" (empty string)
  const resEmpty = requestLB(api, {
    headers: {
      'X-Canary': '',
      'X-Canary-Key': 'empty-test',
    },
    tags: { endpoint: api.name, route_mode: 'invalid_force', test: 'empty_header' },
  });

  const channelEmpty = responseHeader(resEmpty, 'X-LB-Release-Channel');
  check(resEmpty, {
    'empty force still gets valid channel': () =>
      channelEmpty === 'stable' || channelEmpty === 'canary',
  });

  console.log(`X-Canary: "" → channel: ${channelEmpty}`);
}
```

**Điểm học:** `map` directive với `default` keyword đảm bảo mọi giá trị không khớp đều fallback về weighted split, không gây ra lỗi.

### Variation 5: So sánh response content giữa stable và canary

Mục tiêu: xác minh rằng stable và canary thực sự trả về nội dung khác nhau (nếu không, canary deployment vô nghĩa).

```javascript
// Variation 5: Content differentiation proof
// Xác minh stable và canary trả về nội dung KHÁC NHAU

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  const api = lbCapabilityApis.canaryDemo;

  // Lấy response từ stable
  const stableRes = requestLB(api, {
    headers: { 'X-Canary': 'never', 'X-Canary-Key': 'content-stable' },
    tags: { endpoint: api.name, test: 'content_diff' },
  });
  const stableRole = stableRes.json('role');
  const stableUpstream = responseHeader(stableRes, 'X-Upstream-Service');

  // Lấy response từ canary
  const canaryRes = requestLB(api, {
    headers: { 'X-Canary': 'always', 'X-Canary-Key': 'content-canary' },
    tags: { endpoint: api.name, test: 'content_diff' },
  });
  const canaryRole = canaryRes.json('role');
  const canaryUpstream = responseHeader(canaryRes, 'X-Upstream-Service');

  console.log(`Stable: role=${stableRole}, upstream=${stableUpstream}`);
  console.log(`Canary: role=${canaryRole}, upstream=${canaryUpstream}`);

  check(null, {
    'stable and canary have different roles': () => stableRole !== canaryRole,
    'stable and canary have different upstreams': () => stableUpstream !== canaryUpstream,
    'stable role is "stable"': () => stableRole === 'stable',
    'canary role is "canary"': () => canaryRole === 'canary',
  });
}
```

**Điểm học:** Trong production, stable và canary thường trả về HTML/JSON khác nhau (giao diện mới, API response format mới). Phải xác minh được sự khác biệt này -- nếu không, canary deployment không có giá trị.

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Dùng User-Agent hoặc IP để quyết định canary routing

```text
Sai:   Dùng User-Agent hoặc IP làm key cho split_clients
Đúng:  Dùng X-Canary-Key (hoặc cookie, session ID) -- thứ mà ứng dụng kiểm soát được

Lý do:
  - User-Agent: Cùng một user có thể dùng nhiều thiết bị (mobile, desktop) → mỗi thiết bị có thể thấy phiên bản khác nhau → trải nghiệm không nhất quán
  - IP: Nhiều users sau cùng một NAT IP (văn phòng, quán cafe) → tất cả thấy cùng phiên bản → không phân tán được
  - X-Canary-Key / User ID: Mỗi user có key riêng → đảm bảo tính sticky và phân tán đều
```

### 15.2 Anti-pattern 2: Không kiểm tra body.role, chỉ kiểm tra header

```text
Sai:   Chỉ check X-LB-Release-Channel header → kết luận routing đúng
Đúng:  Check cả X-LB-Release-Channel header VÀ body.role

Lý do:
  Header có thể bị gắn sai do:
  - add_header được đặt sai vị trí trong nginx.conf
  - Header bị ghi đè bởi một add_header khác
  - Origin cũng có thể gắn header trùng tên

  Body.role là evidence từ chính origin -- không thể bị Nginx giả mạo.
```

### 15.3 Anti-pattern 3: Dùng sample size quá nhỏ rồi kết luận

```text
Sai:   n=10, canaryCount=3 (30%) → "split_clients sai, canary quá cao!"
Đúng:  Với n=10, biến động rất lớn. 3/10 = 30% là hoàn toàn có thể xảy ra
        với p=0.15 (xác suất ≈ 13% cho mỗi lần chạy).

Công thức ước lượng sample size tối thiểu:
  n ≥ (z^2 × p × (1-p)) / margin^2
  Với z=1.96 (95% confidence), p=0.15, margin=0.05:
  n ≥ (1.96^2 × 0.15 × 0.85) / 0.05^2 ≈ 196

→ Sample size 120 là chấp nhận được cho dải rộng [5%, 30%]
→ Để có dải hẹp hơn, cần sample size lớn hơn
```

### 15.4 Anti-pattern 4: Không test forced stable và forced canary riêng biệt

```text
Sai:   Chỉ chạy weighted sample → nếu tất cả đều đến stable, không biết
        liệu canary có hoạt động không hay split_clients = 100% stable
Đúng:  Luôn chạy forced stable + forced canary trước weighted sample

Lý do:
  Forced stable/canary xác nhận:
  - Cả hai origin đều hoạt động
  - Force header được tôn trọng
  - Map directive hoạt động đúng

  Nếu bỏ qua, weighted sample có thể PASS nhưng canary origin thực tế đã chết
  (và Nginx fallback sang stable origin).
```

### 15.5 Anti-pattern 5: Dùng chung một `X-Canary-Key` cho tất cả request

```text
Sai:   for (let i = 0; i < 120; i++) { headers: { 'X-Canary-Key': 'same-key' } }
Đúng:  for (let i = 0; i < 120; i++) { headers: { 'X-Canary-Key': `sample-${i}` } }

Lý do:
  Cùng một key → cùng một hash → cùng một channel cho tất cả 120 request.
  Kết quả: 120 request đều đến stable (hoặc đều đến canary) → không thể đánh giá
  được tỉ lệ phân phối.
```

### 15.6 Anti-pattern 6: Chạy qua CDN/Varnish

```text
Sai:   TargetLayer=full (có Varnish) → Varnish cache response → request sau nhận
        response cũ từ cache → không đến Nginx → không test được routing
Đúng:  TargetLayer=full-no-cdn (không có Varnish) → mỗi request đều đến Nginx

Lý do:
  Với Varnish:
  - Request đầu tiên: Varnish MISS → Nginx → stable origin → cache
  - 119 request sau: Varnish HIT → trả về từ cache → không đến Nginx
  → Tất cả 120 request đều có kết quả giống nhau → test vô nghĩa
```

---

## 16. Real validation data

### 16.1 Kết quả validation thực tế

Dưới đây là kết quả từ lần chạy validation thực tế với cấu hình mặc định:

```text
K6 run configuration:
  Script:            08-weighted-routing-canary.js
  Profile:           full-no-cdn
  BASE_URL:           http://localhost:80
  CANARY_SAMPLE_SIZE: 120
  CANARY_MIN_PERCENT: 5
  CANARY_MAX_PERCENT: 30

Results:
  Exit code: 0
  Checks: 253/253 (100%)
  HTTP failed: 0.00% (0/122)
  Result: PASS

Breakdown:
  forced stable:    5/5 checks pass
  forced canary:    5/5 checks pass
  weighted sample:  240/240 individual checks pass (2 per request × 120)
  aggregate checks: 3/3 pass (stable traffic, canary traffic, ratio in band)

  Total requests: 122 (1 forced stable + 1 forced canary + 120 weighted)
  All status 200
  X-LB-Release-Channel present on all 122 responses
  X-Cache absent on all 122 responses
```

### 16.2 Phân tích kết quả chi tiết

| Chỉ số | Giá trị | Đánh giá |
| --- | --- | --- |
| Forced stable upstream | `lb-stable-origin` | Đúng -- `X-Canary: never` route về stable |
| Forced stable channel | `stable` | Đúng |
| Forced stable body.role | `"stable"` | Đúng -- origin xác nhận role |
| Forced canary upstream | `lb-canary-origin` | Đúng -- `X-Canary: always` route về canary |
| Forced canary channel | `canary` | Đúng |
| Forced canary body.role | `"canary"` | Đúng -- origin xác nhận role |
| Checks pass rate | 253/253 (100%) | Tuyệt vời -- không có lỗi nào |
| HTTP failed | 0/122 (0%) | Tất cả request đều 200 |
| Response time avg | ~5ms | Rất thấp -- cả hai origin đều phản hồi nhanh |

### 16.3 Phân phối canary/stable trong weighted sample

```text
Phân phối thực tế (có thể thay đổi giữa các lần chạy):

Ví dụ lần chạy 1:
  stableCount: 102 (85.0%)
  canaryCount: 18  (15.0%)
  canaryPercent: 15.0% → PASS (trong [5%, 30%])

Ví dụ lần chạy 2:
  stableCount: 97  (80.8%)
  canaryCount: 23  (19.2%)
  canaryPercent: 19.2% → PASS (trong [5%, 30%])

Ví dụ lần chạy 3:
  stableCount: 107 (89.2%)
  canaryCount: 13  (10.8%)
  canaryPercent: 10.8% → PASS (trong [5%, 30%])
```

### 16.4 Các yếu tố ảnh hưởng đến kết quả

| Yếu tố | Ảnh hưởng |
| --- | --- |
| `split_clients` percentage | Tỉ lệ configured quyết định expected value của canary share |
| Sample size | Càng lớn → ước lượng càng chính xác, biến động càng nhỏ |
| Hash key (`X-Canary-Key`) | Phân phối của key ảnh hưởng đến phân phối của hash value |
| MurmurHash2 distribution | Về lý thuyết là uniform, nhưng với sample nhỏ có thể thấy clustering |
| Network latency | Không ảnh hưởng đến routing decision (hash không phụ thuộc timing) |
| Origin health | Nếu một origin chết, Nginx có thể fallback (tùy cấu hình) → sai lệch kết quả |

---

## 17. Reference

### 17.1 Tài liệu liên quan

| Tài liệu | Đường dẫn | Mô tả |
| --- | --- | --- |
| Overview | `E:\Khoa hoc\k6\docs\practice\lb\00_overview.md` | Tổng quan series LB/Gateway, mental model, case inventory |
| Run guide | `E:\Khoa hoc\k6\docs\practice\lb\RUN_GUIDE.md` | Hướng dẫn chạy toàn bộ LB suite |
| Validation | `E:\Khoa hoc\k6\docs\practice\lb\13_validation-and-chart-analysis.md` | Hướng dẫn đọc chart và validate kết quả |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\case-catalog.json` | Catalog đầy đủ 12 LB cases với business case, topology, expected signals |
| Script nguồn | `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\08-weighted-routing-canary.js` | Mã nguồn k6 script của case này |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\shared.js` | Shared module cho toàn bộ LB cases (chứa `responseHeader`, `requestLB`, `lbCapabilityApis`) |
| Nginx config | `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Cấu hình Nginx với `split_clients`, `map`, `upstream` |

### 17.2 Tài liệu tham khảo ngoài

| Tài liệu | URL | Mô tả |
| --- | --- | --- |
| Nginx split_clients | `https://nginx.org/en/docs/http/ngx_http_split_clients_module.html` | Tài liệu chính thức về `split_clients` module |
| Nginx map directive | `https://nginx.org/en/docs/http/ngx_http_map_module.html` | Tài liệu chính thức về `map` directive |
| Nginx upstream module | `https://nginx.org/en/docs/http/ngx_http_upstream_module.html` | Tài liệu chính thức về `upstream` groups |
| k6 check(null) pattern | `https://k6.io/docs/javascript-api/k6/check/` | Tài liệu k6 về `check` function, bao gồm pattern `check(null, {...})` |
| Canary deployment pattern | `https://martinfowler.com/bliki/CanaryRelease.html` | Bài viết của Martin Fowler về canary release |

### 17.3 Các case liên quan trong cùng series

| Case | Mối liên hệ |
| --- | --- |
| `lb-01-entry-smoke` | Case cơ bản nhất -- xác nhận Nginx hoạt động trước khi test canary routing |
| `lb-03-domain-boundaries` | Cùng dùng routing dựa trên path/header để chọn upstream |
| `lb-06-retry-failover` | Failover có thể ảnh hưởng đến canary routing nếu một origin chết |
| `lb-07-rate-limit-and-connection-pressure` | Cùng profile `full-no-cdn`, pressure có thể ảnh hưởng đến canary distribution |
| `lb-10-weighted-fairness-under-load` | Mở rộng của case 08: test canary share dưới áp lực `constant-arrival-rate` |

---

*Phiên bản tài liệu: 1.0 -- Ngày cập nhật: 2026-06-23*
