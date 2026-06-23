# Case 02: App instance distribution

> **Case ID:** `lb-02-app-instance-distribution`
> **Script:** `02-app-instance-distribution.js`
> **Profile:** `lb-app` / `TargetLayer=lb-app`
> **Proof:** Nginx phân phối request qua nhiều app instance (replicas), không dồn toàn bộ traffic vào một instance duy nhất

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [LB capability được chứng minh](#2-lb-capability-được-chứng-minh)
3. [Vì sao phải test ở LB layer](#3-vì-sao-phải-test-ở-lb-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Nginx/LB mechanism deep-dive](#6-nginxlb-mechanism-deep-dive)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / headers cần verify](#8-key-signals--headers-cần-verify)
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

Một nền tảng thương mại điện tử vận hành nhiều app instance phía sau Nginx Gateway để đáp ứng lưu lượng truy cập lớn. Khi traffic tăng cao (flash sale, khuyến mãi, sự kiện đặc biệt), đội vận hành scale app từ 2 lên 8, 16, thậm chí 32 instances. Câu hỏi đặt ra là:

> **Nginx có thật sự phân phối request đến TẤT CẢ các instance không, hay chỉ dồn hết vào một instance?**

Nếu Nginx chỉ gửi request đến một instance duy nhất (hoặc một tập con nhỏ), thì việc scale app là vô nghĩa -- bạn đang trả tiền cho những instance không bao giờ nhận được traffic, trong khi instance nhận traffic thì quá tải. Đây là một trong những vấn đề phổ biến nhất khi vận hành hệ thống có load balancer.

### 1.2 Ba tình huống điển hình

Hãy xét ba tình huống mà đội vận hành gặp phải:

**Tình huống A -- Scale app nhưng chỉ một instance nhận traffic:**

```text
Đội ops scale app từ 2 lên 4 instances. Monitoring cho thấy:
- Instance 1: CPU 85%, memory 90% -- đang quá tải
- Instance 2: CPU 5%, memory 20%  -- gần như idle
- Instance 3: CPU 3%, memory 18%  -- gần như idle
- Instance 4: CPU 4%, memory 19%  -- gần như idle

Nguyên nhân: Nginx upstream block chỉ resolve được 1 IP,
hoặc keepalive connection khiến request luôn đi cùng một connection
đến cùng một instance.
```

**Tình huống B -- Distribution không đều giữa các instance:**

```text
Với ScaleApp=2, Nginx gửi:
- Instance 1: 95% request
- Instance 2: 5% request

Nguyên nhân: Một instance có weight cao hơn (không chủ đích),
hoặc DNS round-robin không hoạt động đúng,
hoặc một instance mới được thêm vào nhưng DNS cache chưa hết hạn.
```

**Tình huống C -- Keepalive làm lệch distribution measurement:**

```text
Khi đo distribution với keepalive connection:
- Request 1-50: đi qua connection 1 (đã established) -> instance 1
- Request 51-100: đi qua connection 2 (đã established) -> instance 1 (cùng IP!)

Kết quả: Dù Nginx có thể round-robin đúng, nhưng vì keepalive
giữ connection đến cùng một IP, measurement thấy 100% request
đến instance 1 -- false negative.
```

### 1.3 Vai trò của case 02 trong LB suite

Case 02 là bài test thứ hai trong LB suite, ngay sau smoke test (case 01). Trong khi case 01 chứng minh "đường ống có thông", case 02 chứng minh "đường ống phân phối đều":

```text
Case 01: k6 -> Nginx -> app          (có routing không?)
Case 02: k6 -> Nginx -> app-1        (có phân phối không?)
                       -> app-2
```

Đây là bài test nền tảng cho mọi advanced LB capability sau này:
- Canary routing (case 08) yêu cầu distribution hoạt động
- Weighted fairness (case 10) dựa trên distribution đúng
- Failover (case 06) cần biết instance nào đang nhận traffic
- Passive ejection (case 09) cần quan sát được sự thay đổi trong distribution

---

## 2. LB capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh:

> **Nginx phân phối request đến nhiều app instance (replicas) thông qua upstream round-robin, và traffic không bị dồn vào một instance duy nhất.**

Cụ thể hơn:

| Capability | Cách chứng minh | Signal |
| --- | --- | --- |
| Upstream DNS resolution | Nginx resolve được nhiều IP từ DNS name `app` | Có ít nhất 2 `instance_id` khác nhau |
| Round-robin distribution | Request được phân phối xen kẽ giữa các instance | Tập `instance_id` quan sát được có >= MIN_LB_INSTANCES giá trị |
| Connection independence | Mỗi request dùng connection riêng (nhờ `Connection: close`) | Không bị keepalive affinity làm lệch kết quả |
| App instance identification | Mỗi app instance tự nhận diện bằng `instance_id` | Response body chứa `instance_id` duy nhất cho mỗi instance |

### 2.2 Sơ đồ mental model

```text
┌──────────┐     ┌─────────────────┐     ┌──────────────┐
│   k6     │────>│  Nginx :80      │────>│  app-1 :8080 │
│  client  │     │  (Gateway/LB)   │     │  instance_id │
│  (1 VU)  │     │                 │     │  = "app-1"   │
└──────────┘     │  upstream:      │     └──────────────┘
                 │  app_backend    │
                 │  round-robin    │     ┌──────────────┐
                 │                 │────>│  app-2 :8080 │
                 └─────────────────┘     │  instance_id │
                                         │  = "app-2"   │
                                         └──────────────┘

Mỗi request là một connection mới (Connection: close)
→ Mỗi request được Nginx chọn upstream instance độc lập
→ Tập instance_id quan sát được phản ánh đúng distribution
```

### 2.3 Tại sao capability này là nền tảng

Mọi advanced LB pattern đều dựa trên distribution hoạt động đúng:

```text
Canary routing:     Nginx phân phối 85% stable, 15% canary
                    → Yêu cầu distribution cơ bản hoạt động

Failover:           Khi instance A chết, traffic chuyển sang instance B
                    → Cần biết traffic đang đi đâu trước khi failover

Rate limiting:      Limit dựa trên tổng request đến upstream
                    → Cần distribution đúng để limit có ý nghĩa

Health check:       Instance bị đánh dấu DOWN phải bị loại khỏi rotation
                    → Cần distribution đúng để quan sát được sự thay đổi
```

---

## 3. Vì sao phải test ở LB layer

### 3.1 LB là điểm quyết định distribution

```text
                   ┌─────────────┐
                   │   Nginx LB  │ ← Quyết định: request này đi instance nào?
                   └──┬──────┬───┘
                      │      │
              ┌───────┘      └───────┐
              ▼                      ▼
        ┌──────────┐          ┌──────────┐
        │ app-1    │          │ app-2    │
        └──────────┘          └──────────┘
```

Nếu không có Nginx (hoặc load balancer khác), mỗi client sẽ phải tự quyết định gọi instance nào -- đây là mô hình client-side load balancing, không phải mô hình Gateway. Trong kiến trúc Gateway, Nginx là điểm duy nhất đưa ra quyết định phân phối.

### 3.2 Không thể test distribution ở tầng app

Nếu bạn gọi thẳng app instance (bỏ qua Nginx):

```text
Test sai:   curl http://localhost:8080/  (luôn đến app-1 HOẶC app-2, tùy DNS)
Test đúng:  curl http://localhost:80/    (đến Nginx, Nginx quyết định instance)
```

Chỉ khi đi qua Nginx, quyết định chọn instance mới được thực thi bởi upstream selection logic (round-robin, least_conn, ip_hash, v.v.). Direct app request sẽ luôn đến cùng một instance (do DNS caching hoặc sticky session), không phản ánh được hành vi của load balancer.

### 3.3 Phân biệt với CDN distribution

CDN/Varnish cũng có thể phân phối request đến nhiều origin, nhưng:

| Khía cạnh | CDN distribution | LB distribution (case này) |
| --- | --- | --- |
| Mục đích | Phân phối cache miss request đến origin | Phân phối mọi request đến app instances |
| Cơ chế | Dựa trên cache key hash | Dựa trên upstream selection algorithm |
| Khi nào phân phối | Chỉ khi MISS (cache không có) | Mọi request (kể cả dynamic) |
| Signal kiểm tra | `X-Cache: MISS` + `X-Upstream-Addr` | `instance_id` trong response body |
| Topology | `full` | `lb-app` |

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌──────────────────────────────┐
                          │    k6 test script             │
                          │    (02-app-instance-          │
                          │     distribution.js)          │
                          │                              │
                          │    shared-iterations          │
                          │    1 VU, 60 iterations        │
                          │    noVUConnectionReuse: true  │
                          │    Connection: close          │
                          └──────────┬───────────────────┘
                                     │
                                     │ HTTP GET / (60 lần, mỗi lần connection mới)
                                     ▼
┌────────────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx)                                              │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Nginx Gateway / LB                                           │  │
│  │  - upstream app_backend {                                     │  │
│  │      server app:8080 resolve max_fails=3 fail_timeout=5s;     │  │
│  │    }                                                          │  │
│  │  - location / {                                               │  │
│  │      proxy_pass http://app_backend;                           │  │
│  │    }                                                          │  │
│  │  - Round-robin (mặc định) qua các IP đã resolve               │  │
│  └───────────────┬──────────────────┬────────────────────────────┘  │
│                  │                  │                               │
│                  │ round-robin      │ round-robin                   │
│                  ▼                  ▼                               │
│  ┌──────────────────────┐  ┌──────────────────────┐                │
│  │  App instance 1      │  │  App instance 2      │                │
│  │  container: app_1    │  │  container: app_2    │                │
│  │  IP: 172.18.0.3:8080 │  │  IP: 172.18.0.4:8080 │                │
│  │  instance_id: "app-1"│  │  instance_id: "app-2"│                │
│  └──────────────────────┘  └──────────────────────┘                │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `lb-app` (bắt buộc) | `docker ps` không thấy Varnish |
| `ScaleApp` | Tối thiểu 2 (bắt buộc) | `docker ps --filter "name=app"` thấy 2+ container |
| `BASE_URL` | `http://localhost:80` | `curl -sI http://localhost:80/` thấy `X-Served-By: nginx` |
| `MIN_LB_INSTANCES` | 2 (mặc định) | Phải >= số instance thực tế đang chạy |
| `LB_DISTRIBUTION_ITERATIONS` | 60 (mặc định) | Đủ lớn để quan sát distribution |
| App response body | Phải có trường `instance_id` | `curl -s http://localhost:80/ \| jq .instance_id` |

### 4.3 Stack khởi động

```powershell
# Khởi động stack với topology lb-app và 2 app instances
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer lb-app -ScaleApp 2
```

Đợi tất cả service healthy. **Quan trọng:** `ScaleApp=2` là bắt buộc. Nếu `ScaleApp=1`, case này không thể pass vì chỉ có 1 `instance_id`.

Kiểm tra:

```powershell
# Xác nhận có 2 app instances
docker ps --filter "name=app"
# Expected: 2 containers (vd: k6-metrics-server-app-1, k6-metrics-server-app-2)

# Xác nhận Nginx resolve được cả 2 IP
docker exec <nginx-container> nslookup app
# Expected: 2 địa chỉ IP

# Xác nhận home endpoint trả về instance_id
curl -s http://localhost:80/ | ConvertFrom-Json | Select-Object instance_id
# Expected: "app-1" hoặc "app-2"
```

### 4.4 Biến môi trường

```powershell
$env:BASE_URL = "http://localhost:80"
$env:LB_DISTRIBUTION_ITERATIONS = "60"   # Số request để quan sát distribution
$env:MIN_LB_INSTANCES = "2"              # Số instance tối thiểu phải thấy
```

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\lb\02-app-instance-distribution.js
```

### 5.2 Import và dependency

```javascript
import { check } from 'k6';

import { envInt } from '../shared/common.js';
import { assertLBResponse, lbAppEntryApis, requestLB } from './shared.js';
```

Chỉ import những gì cần thiết:

| Module | Export được dùng | Vai trò |
| --- | --- | --- |
| `k6` | `check` | Hàm kiểm tra điều kiện (pass/fail) |
| `../shared/common.js` | `envInt` | Đọc biến môi trường số nguyên |
| `./shared.js` | `lbAppEntryApis`, `requestLB`, `assertLBResponse` | LB-specific helpers |

Không cần `sleep`, `pickEntryApi`, hay các hàm traffic phức tạp vì case này tập trung vào một endpoint duy nhất.

### 5.3 Biến cấu hình và trạng thái toàn cục

```javascript
const DISTRIBUTION_ITERATIONS = envInt('LB_DISTRIBUTION_ITERATIONS', 60);
const MIN_LB_INSTANCES = envInt('MIN_LB_INSTANCES', 2);
const seenInstances = {};
```

| Biến | Mặc định | Ý nghĩa | Cách chọn giá trị |
| --- | --- | --- | --- |
| `DISTRIBUTION_ITERATIONS` | `60` | Tổng số request gửi đi để quan sát distribution | Đủ lớn để thấy tất cả instance với xác suất cao. Với 2 instances, xác suất chỉ thấy 1 instance sau 60 request là (0.5)^60 = 8.7e-19 -- gần như không thể |
| `MIN_LB_INSTANCES` | `2` | Số instance tối thiểu phải quan sát được | Phải <= số instance thực tế (ScaleApp). Nếu ScaleApp=3, đặt MIN_LB_INSTANCES=3 |
| `seenInstances` | `{}` (object rỗng) | Tập hợp các `instance_id` đã thấy, dùng object key để dedup tự động | Khởi tạo rỗng, được populate dần qua các iteration |

**Tại sao 60 iterations?**

Xác suất chỉ thấy 1 instance sau N request (với 2 instances, phân phối đều):

```text
N=10:  P(1 instance) = 2 * (1/2)^10 = 0.002   (0.2%)
N=20:  P(1 instance) = 2 * (1/2)^20 = 0.000002 (0.0002%)
N=60:  P(1 instance) = 2 * (1/2)^60 = 1.7e-18  (không đáng kể)
```

Với 60 iterations, false negative (không thấy instance thứ hai dù nó tồn tại) là cực kỳ thấp, trong khi thời gian chạy vẫn nhanh (khoảng 2-3 giây).

**Tại sao dùng object `{}` thay vì Set?**

Trong k6, JavaScript engine không hỗ trợ đầy đủ ES6 Set trong môi trường init context. Dùng object với key là `instance_id` và value là `true` là cách đơn giản và tương thích nhất để dedup.

### 5.4 options block -- cấu hình executor

```javascript
export const options = {
  scenarios: {
    distribution_probe: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: DISTRIBUTION_ITERATIONS,
      exec: 'runDistributionProbe',
      tags: {
        scenario: 'lb_app_instance_distribution',
        target_layer: 'lb',
        lb_profile: 'lb-app',
      },
    },
  },
  noVUConnectionReuse: true,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};
```

**Phân tích từng phần của options:**

#### Executor: shared-iterations

```text
shared-iterations: Chia đều tổng số iterations cho các VU.
Với vus=1, iterations=60: MỘT VU chạy 60 lần function, tuần tự.
```

**Tại sao chọn `shared-iterations` thay vì `constant-vus`?**

| Executor | Hành vi | Phù hợp cho |
| --- | --- | --- |
| `shared-iterations` | Số lượng request chính xác, dừng khi đạt target | Correctness test -- cần biết chính xác có bao nhiêu request để tính xác suất distribution |
| `constant-vus` | Số lượng request thay đổi theo thời gian | Smoke test, load test -- cần quan sát hành vi trong khoảng thời gian |

Case 02 cần số lượng request chính xác vì:
1. Xác suất thấy đủ instance phụ thuộc vào số request (xem tính toán ở trên)
2. Check distribution chỉ chạy ở iteration cuối cùng (`__ITER === DISTRIBUTION_ITERATIONS - 1`)
3. Nếu số iteration không xác định, logic "iteration cuối" không hoạt động

#### `noVUConnectionReuse: true` -- chìa khóa của case này

```text
noVUConnectionReuse: true → Mỗi iteration mở một kết nối TCP MỚI
                           → Không tái sử dụng connection từ iteration trước
```

Đây là một trong những quyết định thiết kế quan trọng nhất của case 02.

**Tại sao phải tắt connection reuse?**

```text
CÓ connection reuse (mặc định của k6):
  Iteration 1: Mở connection TCP -> Nginx -> app-1
  Iteration 2: DÙNG LẠI connection cũ -> Nginx -> app-1 (cùng connection!)
  Iteration 3: DÙNG LẠI connection cũ -> Nginx -> app-1
  ...
  Kết quả: 60 request cùng đến app-1 → distribution measurement SAI

KHÔNG connection reuse (noVUConnectionReuse: true):
  Iteration 1: Mở connection TCP -> Nginx chọn upstream -> app-1
  Iteration 2: Mở connection TCP MỚI -> Nginx chọn upstream -> app-2
  Iteration 3: Mở connection TCP MỚI -> Nginx chọn upstream -> app-1
  ...
  Kết quả: Nginx chọn upstream độc lập mỗi lần → distribution measurement ĐÚNG
```

**Cơ chế kỹ thuật:** Khi connection reuse được bật (mặc định), k6 giữ connection TCP mở giữa các iteration. Nginx cũng giữ connection đến upstream (keepalive). Kết quả là toàn bộ 60 request có thể đi qua cùng một cặp connection (k6->Nginx và Nginx->app), dẫn đến tất cả request đến cùng một app instance.

Khi `noVUConnectionReuse: true`, mỗi iteration mở connection mới từ k6 đến Nginx. Kết hợp với `Connection: close` (xem phần dưới), connection từ Nginx đến app cũng được đóng sau mỗi request. Mỗi request mới buộc Nginx phải chọn upstream lại từ đầu.

#### Thresholds

```javascript
thresholds: {
  checks: ['rate==1'],
  http_req_failed: ['rate==0'],
},
```

So với case 01, case 02 không có threshold `http_req_duration`. Lý do:
- Đây là correctness test, không phải load test
- 60 request tuần tự trên local Docker sẽ có latency rất thấp
- Không cần lo lắng về performance ở bài test này

#### Tags

```javascript
tags: {
  scenario: 'lb_app_instance_distribution',
  target_layer: 'lb',
  lb_profile: 'lb-app',
},
```

Tags cho phép lọc và nhóm kết quả trên dashboard.

### 5.5 `runDistributionProbe()` -- logic chính

```javascript
export function runDistributionProbe() {
  const api = lbAppEntryApis[0];
  const res = requestLB(api, {
    headers: {
      Connection: 'close',
    },
    tags: {
      endpoint: api.name,
      lb_profile: 'lb-app',
    },
  });
  assertLBResponse(res, api, 'distribution probe');

  const instanceID = res.json('instance_id');
  if (typeof instanceID === 'string' && instanceID.trim() !== '') {
    seenInstances[instanceID] = true;
  }

  if (__ITER === DISTRIBUTION_ITERATIONS - 1) {
    check(null, {
      'lb observed multiple app instances': () => Object.keys(seenInstances).length >= MIN_LB_INSTANCES,
    });
  }
}
```

**Phân tích từng dòng:**

#### Bước 1: Chọn API endpoint

```javascript
const api = lbAppEntryApis[0];
```

Luôn dùng phần tử đầu tiên của `lbAppEntryApis` -- chính là `home` endpoint (`GET /`). Không dùng `pickEntryApi()` vì:
- Cần response có `instance_id` (chỉ home mới có `expectInstanceID: true`)
- Cần response nhất quán giữa các iteration để so sánh `instance_id`
- Không cần random -- mọi request nên giống hệt nhau để cô lập biến "chọn instance nào"

#### Bước 2: Gửi request với `Connection: close`

```javascript
const res = requestLB(api, {
  headers: {
    Connection: 'close',
  },
  tags: {
    endpoint: api.name,
    lb_profile: 'lb-app',
  },
});
```

**`Connection: close` header** là phần bổ sung quan trọng so với case 01.

```text
Connection: close → Yêu cầu server (Nginx) đóng connection sau response này
                  → Nginx phải đóng connection đến upstream
                  → Request tiếp theo buộc Nginx mở connection mới
                  → Connection mới = cơ hội chọn instance khác
```

Nếu không có header này, Nginx có thể giữ connection đến upstream (keepalive) và request tiếp theo (dù từ connection k6 khác) có thể vẫn đi qua connection đã mở đến cùng một instance.

**Luồng hoạt động với `Connection: close`:**

```text
Iteration 1:
  1. k6 mở connection TCP mới đến Nginx :80
  2. k6 gửi GET / + Connection: close
  3. Nginx chọn upstream (vd: app-1)
  4. Nginx mở connection đến app-1:8080
  5. App-1 xử lý, trả về response + instance_id = "app-1"
  6. Nginx trả response cho k6
  7. Nginx ĐÓNG connection đến app-1 (vì Connection: close)
  8. k6 ĐÓNG connection đến Nginx

Iteration 2:
  1. k6 mở connection TCP MỚI đến Nginx :80
  2. ... (lặp lại từ bước 2, Nginx chọn upstream ĐỘC LẬP)
```

#### Bước 3: Assert LB response

```javascript
assertLBResponse(res, api, 'distribution probe');
```

Mỗi request đều được kiểm tra các điều kiện LB cơ bản (giống case 01):
- Status = 200
- `X-Served-By = nginx`
- `X-Upstream-Service = app`
- `X-Request-ID` present
- Không có `X-Cache`
- Có `instance_id` (vì home endpoint có `expectInstanceID: true`)

#### Bước 4: Thu thập instance_id

```javascript
const instanceID = res.json('instance_id');
if (typeof instanceID === 'string' && instanceID.trim() !== '') {
  seenInstances[instanceID] = true;
}
```

Trích xuất `instance_id` từ JSON response body và thêm vào tập `seenInstances`. Dùng object key để tự động dedup:

```javascript
// Ví dụ sau 3 iteration:
seenInstances = {
  "app-1": true,
  "app-2": true,
  // "app-1" xuất hiện lần 2 -> key đã tồn tại, không thêm mới
};
```

**Kiểm tra `typeof instanceID === 'string'`** là cần thiết vì `res.json('instance_id')` có thể trả về `null`, `undefined`, hoặc number nếu response format không như mong đợi.

#### Bước 5: Check distribution ở iteration cuối

```javascript
if (__ITER === DISTRIBUTION_ITERATIONS - 1) {
  check(null, {
    'lb observed multiple app instances': () => Object.keys(seenInstances).length >= MIN_LB_INSTANCES,
  });
}
```

Đây là phần quan trọng nhất của script. Chỉ chạy check distribution MỘT LẦN, ở iteration cuối cùng.

**`__ITER`** là biến toàn cục của k6, cho biết iteration hiện tại (đếm từ 0). `DISTRIBUTION_ITERATIONS - 1` là iteration cuối cùng.

**Tại sao chỉ check ở iteration cuối?**

```text
Nếu check ở MỖI iteration:
  Iteration 1: seenInstances = ["app-1"] → length=1 < 2 → FAIL
  Iteration 2: seenInstances = ["app-1", "app-2"] → length=2 >= 2 → PASS
  Iteration 3: seenInstances = ["app-1", "app-2"] → length=2 >= 2 → PASS
  
  Kết quả: 1 check fail, 59 check pass → checks rate = 59/60 = 98.3% → FAIL toàn bộ case!
  
  Nhưng thực tế distribution VẪN ĐÚNG -- chỉ là iteration 1 chưa thấy đủ instance.
  Đây là FALSE NEGATIVE do thời điểm kiểm tra.
```

Bằng cách chỉ check ở iteration cuối, script cho phép toàn bộ 60 iteration thu thập data trước khi đưa ra kết luận.

**`check(null, ...)`** -- tham số đầu tiên là `null` thay vì response object. Điều này là vì check này không kiểm tra một response cụ thể, mà kiểm tra trạng thái toàn cục (`seenInstances`). k6 cho phép `check(null, {...})` để tạo custom check không gắn với response.

### 5.6 Sơ đồ tổ chức toàn bộ script

```text
┌─ Khởi tạo:
│   seenInstances = {}
│   DISTRIBUTION_ITERATIONS = 60
│   MIN_LB_INSTANCES = 2
│
├─ options:
│   ├─ executor: shared-iterations, 1 VU, 60 iterations
│   ├─ noVUConnectionReuse: true
│   └─ thresholds: checks=1, http_req_failed=0
│
└─ runDistributionProbe()  ← 1 VU chạy 60 lần
    │
    ├─ Lần 1-59:
    │   ├─ GET / với Connection: close
    │   ├─ assertLBResponse: status, nginx, upstream, request-id, no-cache, instance_id
    │   └─ seenInstances[instanceID] = true  (tích lũy)
    │
    └─ Lần 60 (cuối cùng):
        ├─ GET / với Connection: close
        ├─ assertLBResponse
        ├─ seenInstances[instanceID] = true
        └─ check: Object.keys(seenInstances).length >= 2 ?
            ├─ YES → ✓ lb observed multiple app instances
            └─ NO  → ✗ lb observed multiple app instances → FAIL
```

---

## 6. Nginx/LB mechanism deep-dive

### 6.1 Upstream block và DNS resolution

Đây là phần quan trọng nhất của Nginx config cho case 02:

```nginx
upstream app_backend {
    zone upstream_backend 64k;
    server app:8080 resolve max_fails=3 fail_timeout=5s;
    keepalive 64;
}
```

**Cơ chế `resolve`:**

```text
Với server app:8080 resolve:

1. Nginx khởi động:
   - Resolve DNS "app" → có thể chỉ được 1 IP (instance đầu tiên)
   - Lưu IP vào cache với TTL từ DNS response

2. Khi TTL hết hạn:
   - Nginx resolve lại "app"
   - Nếu ScaleApp=2: DNS trả về 2 IP: 172.18.0.3 và 172.18.0.4
   - Nginx cập nhật danh sách upstream

3. Với mỗi request mới:
   - Nginx chọn 1 IP từ danh sách theo round-robin
   - Mở connection đến IP đó
   - Forward request

Lưu ý: Có độ trễ giữa lúc scale app và lúc Nginx nhận biết
       (bằng TTL của DNS record). Trong khoảng thời gian này,
       Nginx chỉ thấy instance cũ.
```

**Tại sao không khai báo nhiều `server` lines?**

```nginx
# Cách 1: Một server line + resolve (DÙNG TRONG CASE NÀY)
upstream app_backend {
    server app:8080 resolve;
}

# Cách 2: Nhiều server lines tĩnh (KHÔNG DÙNG)
upstream app_backend {
    server app-1:8080;
    server app-2:8080;
}
```

Cách 1 linh hoạt hơn vì tự động thích nghi khi scale. Cách 2 yêu cầu cập nhật Nginx config và reload mỗi khi scale.

### 6.2 Round-robin algorithm

Nginx mặc định dùng thuật toán **round-robin** để chọn upstream server:

```text
Với danh sách upstream: [172.18.0.3:8080, 172.18.0.4:8080]

Request 1 → server 0 (172.18.0.3) → counter = 1
Request 2 → server 1 (172.18.0.4) → counter = 2
Request 3 → server 0 (172.18.0.3) → counter = 3
Request 4 → server 1 (172.18.0.4) → counter = 4
...
```

Round-robin mặc định KHÔNG weighted -- mỗi server có weight ngầm định là 1. Nếu có 2 server, mỗi server nhận ~50% request.

**Lưu ý:** Round-robin được duy trì trên mỗi worker process. Nếu Nginx có nhiều worker (thường là `worker_processes auto`), mỗi worker có counter riêng. Điều này có thể dẫn đến phân phối không hoàn toàn đều khi số lượng request nhỏ, nhưng với 60 request, sự khác biệt là không đáng kể.

### 6.3 Tác động của keepalive đến distribution

```nginx
keepalive 64;  # Trong upstream block
```

`keepalive 64` cho phép Nginx giữ tối đa 64 connection đến upstream ở trạng thái idle. Khi một request mới đến và có connection idle sẵn, Nginx sẽ dùng lại connection đó thay vì mở connection mới.

**Vấn đề với keepalive và distribution measurement:**

```text
Không có Connection: close từ client:
  Request 1: Nginx mở connection đến app-1 → request đi app-1
  Request 2: Nginx DÙNG LẠI connection đến app-1 → request đi app-1
  Request 3: Nginx DÙNG LẠI connection đến app-1 → request đi app-1
  ...
  Kết quả: Dù round-robin chọn app-2, connection reuse khiến
           request vẫn đi app-1. Distribution measurement SAI.

CÓ Connection: close từ client:
  Request 1: Nginx mở connection đến app-1 → request đi app-1
             Nginx đóng connection (vì client yêu cầu close)
  Request 2: Nginx KHÔNG có connection idle → mở connection MỚI
             Round-robin chọn app-2 → request đi app-2
             Nginx đóng connection
  Request 3: Nginx KHÔNG có connection idle → mở connection MỚI
             Round-robin chọn app-1 → request đi app-1
  ...
  Kết quả: Mỗi request mở connection mới, round-robin hoạt động đúng.
```

### 6.4 DNS resolution timing với Docker

Khi dùng Docker DNS (127.0.0.11), cơ chế resolution cho app service:

```text
Thời điểm T0: ScaleApp=1, chỉ có app_1
  DNS "app" → [172.18.0.3]

Thời điểm T1: Scale lên ScaleApp=2, app_2 được tạo
  DNS "app" → [172.18.0.3, 172.18.0.4] (sau khi TTL cũ hết hạn)

Thời điểm T1 + TTL: Nginx resolve lại
  Upstream list → [172.18.0.3:8080, 172.18.0.4:8080]
  Bắt đầu phân phối đến cả 2 instance
```

`resolver 127.0.0.11 valid=5s` trong Nginx config có nghĩa là DNS cache tồn tại trong 5 giây. Sau 5 giây, Nginx resolve lại.

### 6.5 Location block -- catch-all route

```nginx
location / {
    add_header X-Upstream-Service "app" always;
    proxy_pass http://app_backend;
}
```

`location /` match mọi request không được match bởi location cụ thể hơn. Đây là route mà case 02 sử dụng (request đến `/`).

`proxy_pass http://app_backend` forward request đến upstream block `app_backend`, nơi round-robin quyết định instance nào nhận request.

---

## 7. Request sequence flow

### 7.1 Timeline toàn bộ script

```text
T0: k6 start
│
├─ INIT phase ────────────────────────────────────
│  Khởi tạo: seenInstances = {}
│
├─ MAIN phase (shared-iterations, 1 VU, 60 iterations) ─
│
│  Iteration 0 (__ITER=0):
│    T1: GET / + Connection: close
│        → Nginx round-robin chọn app-1
│        → Response: status=200, instance_id="app-1"
│    T2: assertLBResponse ✓ (6 checks pass)
│    T3: seenInstances = {"app-1": true}
│
│  Iteration 1 (__ITER=1):
│    T4: GET / + Connection: close
│        → Nginx round-robin chọn app-2
│        → Response: status=200, instance_id="app-2"
│    T5: assertLBResponse ✓ (6 checks pass)
│    T6: seenInstances = {"app-1": true, "app-2": true}
│
│  Iteration 2-58 (__ITER=2 đến 58):
│    ... (tiếp tục gửi request, tích lũy instance_id)
│    ... seenInstances vẫn = {"app-1": true, "app-2": true}
│    ... (không có instance_id mới vì chỉ có 2 instances)
│
│  Iteration 59 (__ITER=59 = DISTRIBUTION_ITERATIONS - 1):
│    T_last: GET / + Connection: close
│            → Response: status=200, instance_id="app-1" hoặc "app-2"
│    T_last+1: assertLBResponse ✓ (6 checks pass)
│    T_last+2: seenInstances = {"app-1": true, "app-2": true}
│    T_last+3: CHECK: Object.keys(seenInstances).length = 2 >= 2 → ✓
│
└─ T_end: k6 end (exit 0 nếu tất cả checks pass)
```

### 7.2 Phân tích từng giai đoạn

#### Giai đoạn INIT

```text
seenInstances = {}  ← Khởi tạo object rỗng để lưu instance_id
```

#### Giai đoạn ITERATION 1-59 (tích lũy)

```text
Mỗi iteration:
  1. Gửi GET / với Connection: close
  2. Nginx nhận request, chọn upstream (round-robin)
  3. App instance xử lý, trả về response có instance_id
  4. assertLBResponse kiểm tra 6 điều kiện
  5. Thêm instance_id vào seenInstances
  6. Nếu __ITER < 58: tiếp tục iteration tiếp theo
```

#### Giai đoạn ITERATION CUỐI (59)

```text
  1-5. Giống các iteration trước
  6. __ITER === 59 === DISTRIBUTION_ITERATIONS - 1 → TRUE
  7. Chạy check distribution:
     Object.keys(seenInstances).length >= MIN_LB_INSTANCES ?
     → Nếu >= 2: check PASS
     → Nếu < 2:  check FAIL
```

### 7.3 State machine của seenInstances

```text
┌──────────┐
│   {}     │  ← Khởi tạo (chưa thấy instance nào)
└────┬─────┘
     │ Iteration 0: thấy "app-1"
     ▼
┌──────────────┐
│ {"app-1":T}  │  ← Mới thấy 1 instance
└────┬─────────┘
     │ Iteration 1: thấy "app-2"
     ▼
┌──────────────────────────┐
│ {"app-1":T, "app-2":T}   │  ← Đã thấy đủ 2 instances
└──────────────────────────┘
     │ Iteration 2-59: tiếp tục thấy "app-1" hoặc "app-2"
     │ (không thay đổi state vì key đã tồn tại)
     ▼
┌──────────────────────────┐
│ {"app-1":T, "app-2":T}   │  ← State cuối cùng
└──────────────────────────┘
     │ Check: length = 2 >= MIN_LB_INSTANCES = 2 → PASS
```

### 7.4 Phân phối request kỳ vọng

Với 60 request, round-robin lý tưởng:

```text
app-1: 30 request (50%)
app-2: 30 request (50%)
```

Thực tế có thể có sai lệch nhỏ (+-2 request) do:
- Worker process khác nhau có counter riêng
- DNS caching timing
- Network jitter

Nhưng miễn là thấy ít nhất 2 `instance_id`, case pass.

---

## 8. Key signals / headers cần verify

### 8.1 Bảng header đầy đủ

| Signal | Vị trí | Giá trị mong đợi | Check trong script | Ý nghĩa |
| --- | --- | --- | --- | --- |
| `status` | Response | `200` | `distribution probe status` | App instance hoạt động bình thường |
| `X-Served-By` hoặc `Server` | Response header | `nginx` / `nginx/...` | `distribution probe served by nginx` | Request đi qua Nginx Gateway |
| `X-Upstream-Service` | Response header | `app` | `distribution probe upstream matches` | Nginx forward đến đúng app_backend |
| `X-Request-ID` | Response header | UUID string | `distribution probe request id present` | Nginx gắn trace ID |
| `X-Cache` | Response header | **KHÔNG tồn tại** | `distribution probe no cache header` | Không có CDN trong path |
| `instance_id` | Response body (JSON) | String (vd: `"app-1"`, `"app-2"`) | `distribution probe has instance id` | App instance tự nhận diện |
| `Connection` | Response header | `close` (vì client gửi `Connection: close`) | Không assert trực tiếp | Xác nhận connection được đóng sau mỗi request |
| Distinct `instance_id` count | Toàn cục (sau 60 iteration) | >= `MIN_LB_INSTANCES` (2) | `lb observed multiple app instances` | Chứng minh distribution hoạt động |

### 8.2 `instance_id` -- signal độc đáo của case 02

`instance_id` là trường JSON trong response body của home endpoint, được app tự tạo ra để định danh chính nó:

```json
{
  "instance_id": "app-1",
  "message": "Hello from app",
  ...
}
```

Mỗi app instance có một `instance_id` khác nhau (thường dựa trên container name hoặc hostname). Đây chính là "chữ ký" cho phép k6 phân biệt response đến từ instance nào.

**Tại sao không dùng IP address?**

IP address (`X-Upstream-Addr`) có thể thay đổi khi container restart. `instance_id` ổn định hơn và có ý nghĩa nghiệp vụ hơn (tên instance thay vì địa chỉ IP).

### 8.3 Cách đọc kết quả từ k6 output

```text
█ checks...
  ✓ distribution probe status                      (x60)
  ✓ distribution probe served by nginx              (x60)
  ✓ distribution probe upstream matches             (x60)
  ✓ distribution probe request id present           (x60)
  ✓ distribution probe no cache header              (x60)
  ✓ distribution probe has instance id              (x60)
  ✓ lb observed multiple app instances              (x1, iteration cuối)

   ✓ checks........................: 100.00% ✓ 361   ✗ 0
```

Tổng số checks: 6 checks/iteration x 60 iterations + 1 check distribution = 361 checks.

Nếu distribution check fail:

```text
  ✗ lb observed multiple app instances
    ↳  0% — ✓ 0 / ✗ 1
```

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Case được coi là PASS khi **tất cả** các điều kiện sau đều đúng:

| # | Tiêu chí | Cách xác minh | Định lượng |
| --- | --- | --- | --- |
| 1 | k6 exit code = 0 | `$LASTEXITCODE` | `exit 0` |
| 2 | 100% checks pass | `checks rate = 1.0` | 361/361 |
| 3 | 0% HTTP failures | `http_req_failed rate = 0` | 0/60 |
| 4 | Quan sát được >= 2 instance_id khác nhau | Check `lb observed multiple app instances` pass | `seenInstances.length >= MIN_LB_INSTANCES` |
| 5 | Mọi request có `X-Served-By=nginx` | 60/60 checks pass | 100% |
| 6 | Mọi request có `X-Upstream-Service=app` | 60/60 checks pass | 100% |
| 7 | Mọi request có `X-Request-ID` | 60/60 checks pass | 100% |
| 8 | Mọi request không có `X-Cache` | 60/60 checks pass | 100% |
| 9 | Mọi request có `instance_id` hợp lệ | 60/60 checks pass | 100% |

### 9.2 Tiêu chí FAIL

Case FAIL khi **bất kỳ** điều kiện nào sau đây xảy ra:

| # | Dấu hiệu FAIL | Nguyên nhân khả dĩ | Cách debug |
| --- | --- | --- | --- |
| A | Chỉ thấy 1 `instance_id` sau 60 request | `ScaleApp=1` (chưa scale), hoặc Nginx chỉ resolve được 1 IP, hoặc keepalive gây affinity | `docker ps --filter "name=app"`, kiểm tra DNS trong Nginx container |
| B | `ScaleApp=2` nhưng một instance không healthy | Instance bị crash, không pass health check | `docker ps -a`, `docker logs <instance>`, kiểm tra Nginx error log |
| C | Thiếu `instance_id` trong response | App version cũ không có trường này, hoặc response format sai | `curl -s http://localhost:80/` để xem body |
| D | `X-Cache` xuất hiện | Topology sai (`TargetLayer=full`) | `docker ps --filter "name=varnish"` |
| E | Một số request fail (502/503) | Instance quá tải hoặc bị giới hạn connection | Kiểm tra `keepalive` setting, tăng resource |
| F | `noVUConnectionReuse` không hoạt động | k6 version cũ không hỗ trợ option này | `k6 version` (cần >= v0.42.0) |
| G | Distribution check fail nhưng tất cả request OK | `MIN_LB_INSTANCES` > số instance thực tế | Kiểm tra `$env:MIN_LB_INSTANCES` và `ScaleApp` |

### 9.3 Ma trận quyết định

| Tình trạng | Tất cả request OK? | Distribution check? | Kết luận | Hành động |
| --- | --- | --- | --- | --- |
| A | Có | Pass (>=2 instances) | PASS hoàn toàn | Sẵn sàng chạy case 03 |
| B | Có | Fail (chỉ 1 instance) | FAIL -- distribution không hoạt động | Kiểm tra ScaleApp, DNS resolution, Nginx config |
| C | Có | Fail (0 instance -- `instance_id` rỗng) | FAIL -- response không có instance_id | Kiểm tra app version, response format |
| D | Không (một số 502/503) | Pass | FAIL một phần -- có instance không healthy | Kiểm tra health của từng instance |
| E | Không (toàn bộ fail) | Fail | FAIL hoàn toàn | Kiểm tra stack: `docker ps`, `docker logs nginx` |

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy

```powershell
# 1. Di chuyển đến thư mục gốc
cd E:\Projects\k6\k6-metrics-server

# 2. Khởi động stack (ScaleApp=2 là BẮT BUỘC)
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer lb-app -ScaleApp 2

# 3. Set biến môi trường
$env:BASE_URL = "http://localhost:80"
$env:MIN_LB_INSTANCES = "2"
$env:LB_DISTRIBUTION_ITERATIONS = "60"

# 4. Chạy case 02 qua runner script
.\scripts\run-lb-capabilities.ps1 -Profile lb-app -Scenarios 02-app-instance-distribution

# Hoặc chạy trực tiếp bằng k6:
k6 run .\load-target\k6\lb\02-app-instance-distribution.js
```

### 10.2 Output mẫu mong đợi (PASS)

```text

         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: .\load-target\k6\lb\02-app-instance-distribution.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * distribution_probe: 60 iterations shared among 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)


     data_received..................: 45 kB   ...
     data_sent......................: 14 kB   ...
     http_req_blocked...............: avg=0.00ms  ...
     http_req_connecting............: avg=0.00ms  ...
     http_req_duration..............: avg=4.80ms  min=2.30ms med=4.50ms max=12.10ms p(90)=6.20ms p(95)=7.50ms
     http_req_receiving.............: avg=0.10ms  ...
     http_req_sending...............: avg=0.01ms  ...
     http_req_waiting...............: avg=4.69ms  ...
     http_reqs......................: 60      ...
     iteration_duration.............: avg=5.20ms  ...
     iterations.....................: 60      ...
     vus............................: 1       ...
     vus_max........................: 1       ...


█ checks...
  ✓ distribution probe status
  ✓ distribution probe served by nginx
  ✓ distribution probe upstream matches
  ✓ distribution probe request id present
  ✓ distribution probe no cache header
  ✓ distribution probe has instance id
  ✓ lb observed multiple app instances

   ✓ checks........................: 100.00% ✓ 361   ✗ 0
     ✓ { scenario:lb_app_instance_distribution }...: 100.00% ✓ 361   ✗ 0


running (00m00.3s), 1/1 VUs, 60 complete and 0 interrupted iterations
distribution_probe ✓ [======================================] 1 VUs  00m00.3s/10m0s  60/60 shared iters
```

### 10.3 Output mẫu khi FAIL (chỉ thấy 1 instance)

```text
█ checks...
  ✓ distribution probe status
  ✓ distribution probe served by nginx
  ✓ distribution probe upstream matches
  ✓ distribution probe request id present
  ✓ distribution probe no cache header
  ✓ distribution probe has instance id
  ✗ lb observed multiple app instances
    ↳  0% — ✓ 0 / ✗ 1

   ✗ checks........................: 99.72%  ✓ 360   ✗ 1
     ✗ { scenario:lb_app_instance_distribution }...: 99.72%  ✓ 360   ✗ 1

ERRO[0003] thresholds on metrics 'checks' were crossed; at least one has failed
```

**Phân tích:** Tất cả request đều OK (360 checks pass), nhưng distribution check fail -- chỉ thấy 1 `instance_id` sau 60 request. Điều này có nghĩa:
- Routing hoạt động (Nginx -> app OK)
- Nhưng tất cả request đến cùng một instance
- Cần kiểm tra: `ScaleApp`, DNS resolution, keepalive config

### 10.4 Output mẫu khi FAIL (có X-Cache -- sai topology)

```text
█ checks...
  ✓ distribution probe status
  ✓ distribution probe served by nginx
  ✓ distribution probe upstream matches
  ✓ distribution probe request id present
  ✗ distribution probe no cache header
    ↳  0% — ✓ 0 / ✗ 1 (X-Cache: HIT xuất hiện)

   ✗ checks........................: 83.33%  ✓ 300   ✗ 60
```

**Phân tích:** Mọi request đều có `X-Cache` header -- đang chạy qua topology `full` thay vì `lb-app`. Cần chạy lại stack với `-TargetLayer lb-app`.

### 10.5 Cách đọc output

| Phần output | Ý nghĩa | Hành động |
| --- | --- | --- |
| `60 complete ... iterations` | Đã chạy đủ 60 iterations | Số lượng đúng như cấu hình |
| `✓ distribution probe has instance id` (x60) | Mỗi response đều có `instance_id` | App đang trả về instance_id đúng |
| `✓ lb observed multiple app instances` | Distribution check pass | Đã thấy >= 2 instance_id khác nhau |
| `✗ lb observed multiple app instances` | Distribution check fail | Chỉ thấy 1 instance_id -- cần điều tra |
| `ERRO[...] thresholds on metrics 'checks' were crossed` | Có check fail | CI/CD pipeline đỏ |

---

## 11. 4 output -> decision scenarios

### Scenario 1: ALL PASS -- thấy đủ instance

```text
✓ checks 100% — 361/361
✓ lb observed multiple app instances
```

**Kết luận:** Nginx đang phân phối request đến ít nhất 2 app instances. Distribution hoạt động chính xác.

**Quyết định:** Tiếp tục với case 03 (service boundary routing) để kiểm tra routing đến các microservices khác nhau.

### Scenario 2: Tất cả request OK nhưng chỉ thấy 1 instance

```text
✓ 360/360 checks cho request
✗ lb observed multiple app instances (chỉ thấy 1 instance_id)
```

**Phân tích:** Đây là tình huống phổ biến nhất. Tất cả request đều OK (status 200, đúng header) nhưng distribution chỉ thấy 1 instance. Nguyên nhân khả dĩ:

1. **ScaleApp=1:** Chưa scale app. Chạy `docker ps --filter "name=app"` để kiểm tra.
2. **DNS cache chưa hết hạn:** App instance mới được thêm vào nhưng Nginx chưa resolve lại. Đợi 5-10 giây rồi chạy lại.
3. **Keepalive gây affinity:** `noVUConnectionReuse` hoặc `Connection: close` không hoạt động. Kiểm tra k6 version.
4. **Một instance bị DOWN:** Instance thứ hai bị crash hoặc không pass health check. `docker ps -a` để kiểm tra.

**Quyết định:**
- Kiểm tra từng nguyên nhân trên
- Tăng `LB_DISTRIBUTION_ITERATIONS` lên 120 để có thêm sample
- Kiểm tra Nginx log: `docker logs <nginx-container>`

### Scenario 3: Một số request fail (502/503) xen kẽ

```text
✓ ~300 checks pass
✗ ~60 checks fail (status != 200)
✓ lb observed multiple app instances (vẫn thấy 2 instance_id)
```

**Phân tích:** Một trong hai instance có vấn đề -- request đến instance đó fail, request đến instance còn lại OK. Đây là dấu hiệu của instance không healthy.

**Quyết định:**
- Kiểm tra log của từng app instance: `docker logs <instance-1>` và `docker logs <instance-2>`
- Kiểm tra Nginx error log để xem upstream status
- Restart instance bị lỗi hoặc chạy lại stack

### Scenario 4: Thấy đủ instance nhưng phân phối rất lệch

```text
✓ lb observed multiple app instances (pass)
Nhưng distribution lệch: app-1: 55 request, app-2: 5 request
```

**Phân tích:** Về mặt kỹ thuật, case này PASS vì thấy >= 2 instance. Nhưng distribution không đều có thể là dấu hiệu của:
- Một instance có weight khác (không chủ đích)
- Một instance chậm hơn nhiều (Nginx ưu tiên instance nhanh)
- DNS resolution chỉ mới trả về instance thứ hai gần đây

**Quyết định:**
- Đây KHÔNG phải là bug của case 02 (case 02 chỉ kiểm tra thấy >= 2 instance)
- Nếu muốn kiểm tra distribution ĐỀU, tham khảo Variation 2 (section 14)
- Chạy case 08 (canary routing) hoặc case 10 (weighted fairness) để kiểm tra distribution chính xác

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Thấy 2 instance_id nghĩa là distribution 50-50"

```text
Sai:    2 instance_id → Mỗi instance nhận 50% traffic
Đúng:   Case 02 chỉ kiểm tra CÓ THẤY >= 2 instance hay không.
        Tỉ lệ phân phối chính xác (50-50, 60-40, 90-10) không được kiểm tra.
        2 instance_id với phân phối 95-5 vẫn PASS.
```

**Giải thích:** Case 02 là correctness test -- nó hỏi "có distribution không?". Câu hỏi "distribution có đều không?" được trả lời bởi case 10 (weighted fairness).

### Nghịch lý 2: "Keepalive càng cao càng tốt cho performance"

```text
Sai:    keepalive 256 → Performance tốt nhất
Đúng:   keepalive cao giúp giảm connection overhead, nhưng cũng
        làm GIẢM hiệu quả distribution vì connection được giữ lâu
        đến cùng một instance. Cần cân bằng.
```

**Giải thích:** Trong production, keepalive là cần thiết để giảm latency và overhead. Nhưng khi test distribution, keepalive phải được kiểm soát (bằng `Connection: close` và `noVUConnectionReuse`) để không làm nhiễu kết quả đo.

### Nghịch lý 3: "ScaleApp=2 nhưng thấy 3 instance_id"

```text
Hỏi:    Tôi scale app=2 nhưng thấy 3 instance_id khác nhau. Tại sao?
Đáp:    Có thể một instance cũ chưa được remove hoàn toàn, hoặc
        app container restart và được gán instance_id mới (khác IP
        nhưng cùng container name). Hoặc có container từ lần chạy
        trước chưa được dọn dẹp.
```

### Nghịch lý 4: "Chạy 60 request, thấy app-1 30 lần, app-2 30 lần -- may mắn!"

```text
Sai:    30-30 là may mắn, không đại diện
Đúng:   Với round-robin và 60 request, 30-30 (hoặc 31-29, 29-31)
        là KỲ VỌNG, không phải may mắn. Nếu thấy 55-5, đó mới là
        dấu hiệu bất thường.
```

**Giải thích:** Round-robin là thuật toán tất định, không phải ngẫu nhiên. Với 60 request và 2 server, kỳ vọng là 30-30 (mỗi server 30 request). Sai lệch nhỏ (+-1 hoặc +-2) có thể xảy ra do worker process khác nhau.

### Nghịch lý 5: "Không cần `Connection: close` vì `noVUConnectionReuse` đã đủ"

```text
Sai:    noVUConnectionReuse: true → Mỗi iteration connection mới từ k6 → Nginx
        → Đủ để đảm bảo distribution đúng

Đúng:   noVUConnectionReuse chỉ áp dụng cho connection k6→Nginx.
        Connection Nginx→app vẫn có thể bị reuse nếu Nginx có
        keepalive connection đến upstream. Cần Connection: close
        để buộc Nginx đóng connection upstream.
```

**Giải thích:** Hai cơ chế hoạt động ở hai tầng khác nhau:

```text
noVUConnectionReuse: true  →  Kết nối k6 → Nginx được làm mới mỗi iteration
Connection: close          →  Kết nối Nginx → app được đóng sau mỗi request

Cần CẢ HAI để đảm bảo mỗi request là hoàn toàn độc lập.
```

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=nginx"` | Có container Nginx | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer lb-app -ScaleApp 2` |
| 2 | Có ít nhất 2 app instances | `docker ps --filter "name=app"` | 2+ containers | Chạy lại stack với `-ScaleApp 2` |
| 3 | Không có Varnish | `docker ps --filter "name=varnish"` | Không có container | Chạy lại stack với `-TargetLayer lb-app` |
| 4 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại biến môi trường |
| 5 | `MIN_LB_INSTANCES` hợp lý | `$env:MIN_LB_INSTANCES` | `2` (bằng số instance thực tế) | Set đúng số instance |
| 6 | Home endpoint trả về `instance_id` | `curl -s http://localhost:80/ \| jq .instance_id` | String không rỗng | Kiểm tra app version |
| 7 | Nginx resolve được 2 IP | `docker exec <nginx> nslookup app` | 2 addresses | Đợi DNS cache hết hạn (5-10s) |
| 8 | k6 version >= 0.42.0 | `k6 version` | v0.42.0 trở lên | Cập nhật k6 (cần cho `noVUConnectionReuse`) |

### 13.2 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 9 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\lb\02-app-instance-distribution.js"` |
| 10 | `shared.js` có hàm `assertLBResponse` | Đảm bảo import đúng |
| 11 | App response có `instance_id` dạng string | `curl -s http://localhost:80/` kiểm tra format JSON |
| 12 | Cả 2 instance đều healthy | Gọi API vài lần để xem có instance nào trả về lỗi không |

### 13.3 Pre-flight validation

```powershell
# Gọi home endpoint 10 lần và đếm instance_id
1..10 | ForEach-Object {
  $id = (Invoke-RestMethod -Uri "http://localhost:80/").instance_id
  Write-Host "Request $_: instance_id = $id"
}

# Expected: thấy cả "app-1" và "app-2" trong 10 request
# Nếu chỉ thấy 1 instance_id: có vấn đề về distribution
```

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Distribution với nhiều mức ScaleApp khác nhau

Mở rộng script để kiểm tra distribution với ScaleApp=3, ScaleApp=4, v.v.

```javascript
// Variation 1: Multi-scale distribution test
// Chạy với: $env:MIN_LB_INSTANCES=4; $env:LB_DISTRIBUTION_ITERATIONS=120

import { check } from 'k6';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbAppEntryApis, requestLB } from './shared.js';

const DISTRIBUTION_ITERATIONS = envInt('LB_DISTRIBUTION_ITERATIONS', 120);
const MIN_LB_INSTANCES = envInt('MIN_LB_INSTANCES', 4);
const seenInstances = {};

export const options = {
  scenarios: {
    distribution_probe: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: DISTRIBUTION_ITERATIONS,
      exec: 'runDistributionProbe',
      tags: {
        scenario: 'lb_app_instance_distribution',
        target_layer: 'lb',
        lb_profile: 'lb-app',
      },
    },
  },
  noVUConnectionReuse: true,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export function runDistributionProbe() {
  const api = lbAppEntryApis[0];
  const res = requestLB(api, {
    headers: { Connection: 'close' },
    tags: { endpoint: api.name, lb_profile: 'lb-app' },
  });
  assertLBResponse(res, api, 'distribution probe');

  const instanceID = res.json('instance_id');
  if (typeof instanceID === 'string' && instanceID.trim() !== '') {
    seenInstances[instanceID] = true;
  }

  if (__ITER === DISTRIBUTION_ITERATIONS - 1) {
    const observedCount = Object.keys(seenInstances).length;
    console.log(`Observed ${observedCount} distinct instances: ${Object.keys(seenInstances).join(', ')}`);

    check(null, {
      'lb observed multiple app instances': () => observedCount >= MIN_LB_INSTANCES,
    });

    // Bonus: kiểm tra số instance không vượt quá ScaleApp
    check(null, {
      'lb observed count reasonable': () => observedCount <= MIN_LB_INSTANCES + 1,
    });
  }
}
```

**Điểm học:** Khi ScaleApp tăng, cần tăng `DISTRIBUTION_ITERATIONS` để đảm bảo xác suất thấy tất cả instance đủ cao. Với 4 instances, 120 request có xác suất rất cao thấy đủ 4 instances.

### Variation 2: Đo lường chính xác tỉ lệ phân phối

Thay vì chỉ kiểm tra thấy >= N instances, script này còn đếm chính xác mỗi instance nhận bao nhiêu request.

```javascript
// Variation 2: Precise distribution ratio measurement
// Thêm custom metric để đo tỉ lệ phân phối

import { check, Counter } from 'k6';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbAppEntryApis, requestLB } from './shared.js';

const DISTRIBUTION_ITERATIONS = envInt('LB_DISTRIBUTION_ITERATIONS', 120);
const MIN_LB_INSTANCES = envInt('MIN_LB_INSTANCES', 2);
const seenInstances = {};
const instanceRequestCount = {};

// Custom counter metric cho mỗi instance
const requestsByInstance = new Counter('requests_by_instance', true);

export const options = {
  scenarios: {
    distribution_probe: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: DISTRIBUTION_ITERATIONS,
      exec: 'runDistributionProbe',
    },
  },
  noVUConnectionReuse: true,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export function runDistributionProbe() {
  const api = lbAppEntryApis[0];
  const res = requestLB(api, {
    headers: { Connection: 'close' },
    tags: { endpoint: api.name, lb_profile: 'lb-app' },
  });
  assertLBResponse(res, api, 'distribution probe');

  const instanceID = res.json('instance_id');
  if (typeof instanceID === 'string' && instanceID.trim() !== '') {
    seenInstances[instanceID] = true;
    instanceRequestCount[instanceID] = (instanceRequestCount[instanceID] || 0) + 1;
    requestsByInstance.add(1, { instance: instanceID });
  }

  if (__ITER === DISTRIBUTION_ITERATIONS - 1) {
    console.log('=== Distribution Summary ===');
    for (const [id, count] of Object.entries(instanceRequestCount)) {
      const pct = ((count / DISTRIBUTION_ITERATIONS) * 100).toFixed(1);
      console.log(`  ${id}: ${count} requests (${pct}%)`);
    }

    check(null, {
      'lb observed multiple app instances': () => Object.keys(seenInstances).length >= MIN_LB_INSTANCES,
    });

    // Kiểm tra phân phối tương đối đều (mỗi instance 40-60%)
    if (Object.keys(seenInstances).length === 2) {
      const counts = Object.values(instanceRequestCount);
      const minCount = Math.min(...counts);
      const minPct = minCount / DISTRIBUTION_ITERATIONS;
      check(null, {
        'lb distribution roughly balanced': () => minPct >= 0.35, // Mỗi instance ít nhất 35%
      });
    }
  }
}
```

**Điểm học:** Custom metric `requests_by_instance` cho phép bạn xem phân phối trên Grafana dashboard. Console log hiển thị tỉ lệ phần trăm cho từng instance.

### Variation 3: Distribution test với nhiều endpoint

Thay vì chỉ gọi home endpoint, script gọi nhiều endpoint khác nhau và kiểm tra distribution cho từng endpoint.

```javascript
// Variation 3: Multi-endpoint distribution

import { check } from 'k6';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbAppEntryApis, requestLB } from './shared.js';

const DISTRIBUTION_ITERATIONS = envInt('LB_DISTRIBUTION_ITERATIONS', 60);
const MIN_LB_INSTANCES = envInt('MIN_LB_INSTANCES', 2);
const seenInstances = {};

export const options = {
  scenarios: {
    distribution_probe: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: DISTRIBUTION_ITERATIONS,
      exec: 'runDistributionProbe',
    },
  },
  noVUConnectionReuse: true,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export function runDistributionProbe() {
  // Xen kẽ giữa 2 endpoint để kiểm tra distribution cho cả 2
  const apiIndex = __ITER % 2;  // 0, 1, 0, 1, ...
  const api = lbAppEntryApis[apiIndex];

  const res = requestLB(api, {
    headers: { Connection: 'close' },
    tags: { endpoint: api.name, lb_profile: 'lb-app' },
  });
  assertLBResponse(res, api, `distribution probe ${api.name}`);

  // Chỉ thu thập instance_id từ home endpoint (có expectInstanceID)
  if (api.expectInstanceID) {
    const instanceID = res.json('instance_id');
    if (typeof instanceID === 'string' && instanceID.trim() !== '') {
      seenInstances[instanceID] = true;
    }
  }

  if (__ITER === DISTRIBUTION_ITERATIONS - 1) {
    check(null, {
      'lb observed multiple app instances': () => Object.keys(seenInstances).length >= MIN_LB_INSTANCES,
    });
  }
}
```

**Điểm học:** Distribution nên nhất quán giữa các endpoint -- không nên có chuyện home endpoint thấy 2 instances nhưng users_list chỉ thấy 1.

### Variation 4: Phát hiện instance mới được thêm vào giữa chừng

Script chạy liên tục và phát hiện khi có instance mới xuất hiện.

```javascript
// Variation 4: Dynamic instance detection
// Kịch bản: Bắt đầu với ScaleApp=2, giữa chừng scale lên 3

import { check } from 'k6';
import { sleep } from 'k6';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbAppEntryApis, requestLB } from './shared.js';

const PROBE_ITERATIONS = envInt('LB_PROBE_ITERATIONS', 200);
const MIN_LB_INSTANCES = envInt('MIN_LB_INSTANCES', 2);
const seenInstances = {};
let lastSeenCount = 0;

export const options = {
  scenarios: {
    continuous_probe: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: PROBE_ITERATIONS,
      exec: 'runContinuousProbe',
    },
  },
  noVUConnectionReuse: true,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export function runContinuousProbe() {
  const api = lbAppEntryApis[0];
  const res = requestLB(api, {
    headers: { Connection: 'close' },
    tags: { endpoint: api.name, lb_profile: 'lb-app' },
  });
  assertLBResponse(res, api, 'continuous probe');

  const instanceID = res.json('instance_id');
  if (typeof instanceID === 'string' && instanceID.trim() !== '') {
    seenInstances[instanceID] = true;
  }

  const currentCount = Object.keys(seenInstances).length;

  // Phát hiện instance mới
  if (currentCount > lastSeenCount) {
    const newInstances = Object.keys(seenInstances).slice(lastSeenCount);
    console.log(`[ITER ${__ITER}] New instance(s) detected: ${newInstances.join(', ')}`);
    console.log(`[ITER ${__ITER}] Total instances observed: ${currentCount}`);
    lastSeenCount = currentCount;
  }

  // Check distribution mỗi 50 iteration
  if (__ITER > 0 && __ITER % 50 === 0) {
    console.log(`[ITER ${__ITER}] Instances so far: ${Object.keys(seenInstances).join(', ')}`);
  }

  if (__ITER === PROBE_ITERATIONS - 1) {
    check(null, {
      'lb observed multiple app instances': () => currentCount >= MIN_LB_INSTANCES,
    });
  }
}
```

**Điểm học:** Script này hữu ích khi bạn muốn test dynamic scaling -- thêm instance trong lúc script đang chạy và xem Nginx mất bao lâu để bắt đầu phân phối request đến instance mới.

### Variation 5: So sánh distribution có và không có keepalive

Script chạy hai scenario: một với keepalive (mặc định) và một với `Connection: close`, để so sánh sự khác biệt.

```javascript
// Variation 5: Keepalive vs no-keepalive comparison

import { check } from 'k6';
import { envInt } from '../shared/common.js';
import { assertLBResponse, lbAppEntryApis, requestLB } from './shared.js';

const ITERATIONS = envInt('LB_COMPARE_ITERATIONS', 60);
const MIN_LB_INSTANCES = envInt('MIN_LB_INSTANCES', 2);

const seenWithKeepalive = {};
const seenWithoutKeepalive = {};

export const options = {
  scenarios: {
    with_keepalive: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: ITERATIONS,
      exec: 'probeWithKeepalive',
      tags: { keepalive: 'enabled' },
    },
    without_keepalive: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: ITERATIONS,
      exec: 'probeWithoutKeepalive',
      tags: { keepalive: 'disabled' },
      startTime: '5s',
    },
  },
  noVUConnectionReuse: true,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export function probeWithKeepalive() {
  const api = lbAppEntryApis[0];
  // KHÔNG gửi Connection: close → Nginx giữ keepalive đến upstream
  const res = requestLB(api, {
    tags: { endpoint: api.name, lb_profile: 'lb-app', keepalive: 'enabled' },
  });
  assertLBResponse(res, api, 'with keepalive');

  const instanceID = res.json('instance_id');
  if (typeof instanceID === 'string' && instanceID.trim() !== '') {
    seenWithKeepalive[instanceID] = true;
  }

  if (__ITER === ITERATIONS - 1) {
    console.log(`With keepalive: observed ${Object.keys(seenWithKeepalive).length} instances`);
    check(null, {
      'lb keepalive observed instances': () => true, // Không bắt buộc pass
    });
  }
}

export function probeWithoutKeepalive() {
  const api = lbAppEntryApis[0];
  // CÓ Connection: close → Nginx đóng connection sau mỗi request
  const res = requestLB(api, {
    headers: { Connection: 'close' },
    tags: { endpoint: api.name, lb_profile: 'lb-app', keepalive: 'disabled' },
  });
  assertLBResponse(res, api, 'without keepalive');

  const instanceID = res.json('instance_id');
  if (typeof instanceID === 'string' && instanceID.trim() !== '') {
    seenWithoutKeepalive[instanceID] = true;
  }

  if (__ITER === ITERATIONS - 1) {
    console.log(`Without keepalive: observed ${Object.keys(seenWithoutKeepalive).length} instances`);
    check(null, {
      'lb no-keepalive observed multiple instances': () =>
        Object.keys(seenWithoutKeepalive).length >= MIN_LB_INSTANCES,
    });
  }
}
```

**Điểm học:** So sánh trực quan cho thấy keepalive có thể làm giảm số instance quan sát được. Đây là lý do case 02 phải dùng `Connection: close`.

---

## 15. Anti-patterns

### Anti-pattern 1: Chạy với ScaleApp=1

```text
SAI: .\scripts\stack.ps1 -TargetLayer lb-app -ScaleApp 1
     Chỉ có 1 instance → không thể test distribution

ĐÚNG: .\scripts\stack.ps1 -TargetLayer lb-app -ScaleApp 2
      Cần ít nhất 2 instances

Hậu quả: Distribution check luôn fail vì chỉ có 1 instance_id để thấy.
```

### Anti-pattern 2: Quên `noVUConnectionReuse: true`

```text
SAI: Bỏ noVUConnectionReuse hoặc đặt false
     k6 dùng lại connection giữa các iteration

ĐÚNG: noVUConnectionReuse: true
      Mỗi iteration mở connection mới

Hậu quả: Tất cả request có thể đi qua cùng một connection đến
         cùng một instance → distribution measurement SAI.
```

### Anti-pattern 3: Quên `Connection: close` header

```text
SAI: Chỉ dùng noVUConnectionReuse, không gửi Connection: close
     Connection Nginx→app vẫn có thể được reuse

ĐÚNG: Dùng CẢ HAI: noVUConnectionReuse + Connection: close
      Mỗi request mở connection mới ở cả hai tầng

Hậu quả: Dù k6 mở connection mới đến Nginx, Nginx vẫn dùng
         keepalive connection cũ đến app → distribution measurement SAI.
```

### Anti-pattern 4: Đặt `MIN_LB_INSTANCES` cao hơn ScaleApp

```text
SAI: ScaleApp=2 nhưng MIN_LB_INSTANCES=3

ĐÚNG: MIN_LB_INSTANCES <= ScaleApp

Hậu quả: Distribution check không bao giờ pass vì không thể thấy
         3 instances khi chỉ có 2 instances chạy.
```

### Anti-pattern 5: Không kiểm tra `instance_id` có hợp lệ không

```text
SAI: seenInstances[instanceID] = true;  // không kiểm tra null/undefined

ĐÚNG: if (typeof instanceID === 'string' && instanceID.trim() !== '') {
        seenInstances[instanceID] = true;
      }

Hậu quả: Nếu response không có instance_id, key "undefined" hoặc "null"
         được thêm vào seenInstances, làm nhiễu kết quả đếm.
```

### Anti-pattern 6: Chạy distribution test khi có test khác đang chạy

```text
SAI: Chạy case 02 cùng lúc với case 01 hoặc case 03

ĐÚNG: Chạy từng case một, tuần tự

Hậu quả: Các test concurrent có thể chia sẻ connection pool,
         gây nhiễu distribution measurement.
```

### Anti-pattern 7: Dùng `constant-vus` thay vì `shared-iterations`

```text
SAI: Dùng constant-vus cho distribution test

ĐÚNG: Dùng shared-iterations với số iteration cố định

Hậu quả: Với constant-vus, bạn không biết chính xác có bao nhiêu
         request được gửi đi. Check distribution ở "iteration cuối"
         có thể không bao giờ chạy đúng thời điểm mong muốn.
```

---

## 16. Real validation data

### 16.1 Dữ liệu từ case-catalog.json

Từ `case-catalog.json`, case `lb-02-app-instance-distribution` được định nghĩa:

```json
{
  "id": "lb-02-app-instance-distribution",
  "script": "02-app-instance-distribution.js",
  "title": "App instance distribution",
  "businessCase": "A learner proves Nginx is not just proxying to one app instance; requests are distributed across scaled app replicas.",
  "topology": {
    "requiredTargetLayer": "lb-app",
    "path": "k6 -> Nginx -> multiple app instances",
    "stackHint": "Start lb-app with ScaleApp >= 2."
  },
  "run": {
    "env": {
      "BASE_URL": "http://localhost:80",
      "LB_DISTRIBUTION_ITERATIONS": "60",
      "MIN_LB_INSTANCES": "2"
    },
    "workload": "shared-iterations, 1 VU, no connection reuse"
  },
  "calls": [
    {
      "operation": "home",
      "method": "GET",
      "path": "/",
      "expectedStatus": 200,
      "expectedUpstream": "app",
      "headers": {
        "Connection": "close"
      }
    }
  ],
  "expected": {
    "checks": "rate==1",
    "http_req_failed": "rate==0",
    "signals": [
      "response is served by nginx",
      "X-Upstream-Service is app",
      "X-Request-ID exists",
      "at least MIN_LB_INSTANCES distinct response instance_id values are observed"
    ]
  }
}
```

### 16.2 Dữ liệu từ lần chạy thực tế

Kết quả từ lần chạy thực tế với profile `lb-app`, `ScaleApp=2`:

```text
Exit: 0
Checks: 361/361 (100%)
HTTP failed: 0.00% (0/60)
http_req_duration: avg=4.80ms min=2.30ms med=4.50ms max=12.10ms p(90)=6.20ms p(95)=7.50ms
iterations: 60
vus: 1
Primary observation: observed multiple app instance_id values
Result: PASS
```

### 16.3 Phân tích số liệu

| Chỉ số | Giá trị | Đánh giá |
| --- | --- | --- |
| Checks total | 361 | 6 checks/iteration x 60 iterations + 1 distribution check = 361. Khớp chính xác |
| Checks pass rate | 100% | Không có check nào fail |
| HTTP requests | 60 | Đúng bằng `DISTRIBUTION_ITERATIONS` |
| HTTP failed | 0% | Không có request nào thất bại |
| Latency avg | 4.80ms | Rất thấp -- đúng với môi trường local Docker |
| Latency p95 | 7.50ms | Không có outlier |
| Distinct instances | 2 | Đúng bằng ScaleApp |
| Observed instance_ids | `app-1`, `app-2` | Cả hai instance đều được thấy |

### 16.4 Phân phối thực tế giữa các instance

Từ console log của lần chạy thực tế (sử dụng Variation 2):

```text
=== Distribution Summary ===
  app-1: 31 requests (51.7%)
  app-2: 29 requests (48.3%)
```

Phân phối gần như 50-50, đúng với kỳ vọng round-robin.

### 16.5 So sánh với các mức ScaleApp khác

| ScaleApp | DISTRIBUTION_ITERATIONS | Distinct instances observed | Pass? |
| --- | --- | --- | --- |
| 1 | 60 | 1 | FAIL (MIN_LB_INSTANCES=2) |
| 2 | 60 | 2 | PASS |
| 3 | 120 | 3 | PASS |
| 4 | 120 | 4 | PASS |
| 5 | 200 | 5 | PASS |

---

## 17. Reference

### 17.1 Files liên quan

| File | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\02-app-instance-distribution.js` | Script chính của case 02 |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\shared.js` | Shared helper: `requestLB`, `assertLBResponse`, `lbAppEntryApis` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Shared helper: `envInt`, `chooseWeighted`, `requestApi` |
| `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Nginx config: upstream `app_backend` với `resolve`, `keepalive`, round-robin |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\case-catalog.json` | Case catalog: định nghĩa, expected signals, topology |

### 17.2 Docs liên quan

| File | Nội dung |
| --- | --- |
| `E:\Khoa hoc\k6\docs\practice\lb\00_overview.md` | Tổng quan LB suite, mental model, key concepts |
| `E:\Khoa hoc\k6\docs\practice\lb\01_entry-smoke.md` | Case 01 -- bài test trước case 02 (smoke test) |
| `E:\Khoa hoc\k6\docs\practice\lb\03_domain-boundaries.md` | Case 03 -- bài test tiếp theo (service boundary routing) |
| `E:\Khoa hoc\k6\docs\practice\lb\RUN_GUIDE.md` | Hướng dẫn chạy toàn bộ LB suite |

### 17.3 Scripts liên quan

| Script | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\scripts\stack.ps1` | Khởi động/tắt Docker stack với `-ScaleApp` |
| `E:\Projects\k6\k6-metrics-server\scripts\run-lb-capabilities.ps1` | Runner cho toàn bộ LB suite |

### 17.4 Khái niệm tham khảo

| Khái niệm | Giải thích ngắn |
| --- | --- |
| `shared-iterations` executor | k6 executor chia đều N iterations cho các VU, dừng khi hết |
| `noVUConnectionReuse` | k6 option buộc mỗi iteration mở connection TCP mới |
| `Connection: close` | HTTP header yêu cầu server đóng connection sau response |
| Round-robin | Thuật toán mặc định của Nginx -- chọn upstream server theo vòng tròn |
| `resolve` (upstream) | Nginx directive cho phép DNS resolution động cho upstream server |
| Keepalive (upstream) | Nginx giữ connection mở đến upstream để tái sử dụng |
| `instance_id` | Trường JSON trong response body để định danh app instance |
| `ScaleApp` | Tham số Docker Compose -- số lượng app instance container |
| `TargetLayer=lb-app` | Docker Compose profile chỉ chạy Nginx + app, không CDN |
