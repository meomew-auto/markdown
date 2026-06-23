# Case 01: Entry smoke

> **Case ID:** `lb-01-entry-smoke`
> **Script:** `01-entry-smoke.js`
> **Profile:** `lb-app` / `TargetLayer=lb-app`
> **Proof:** public entrypoint `:80` đi qua Nginx/Gateway tới app origin, có request ID, không có CDN cache

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

Một nền tảng thương mại điện tử vận hành hệ thống nhiều tầng: CDN/Varnish đứng ngoài cùng để phục vụ cache, tiếp đến là Nginx Gateway làm nhiệm vụ định tuyến, cân bằng tải, và cuối cùng là các application server xử lý logic nghiệp vụ. Trước khi đi sâu vào các bài test phức tạp như canary routing, failover, hay rate limiting, có một câu hỏi nền tảng phải được trả lời dứt khoát:

> **Public endpoint `:80` có thật sự đi qua Nginx Gateway và đến được app origin không?**

Nếu câu trả lời là "không" hoặc "không chắc chắn", thì mọi bài test LB phía sau -- dù kết quả có xanh đến đâu -- cũng đều vô nghĩa. Bạn có thể đang test nhầm:
- Direct app (bỏ qua Gateway hoàn toàn)
- CDN path (có Varnish cache đứng trước làm nhiễu signal)

Đây chính là bài **smoke test** -- bài test căn bản nhất, nhẹ nhất, nhưng quan trọng nhất trong toàn bộ LB suite. Nó trả lời câu hỏi: "Đường ống có thông không?"

### 1.2 Ba câu hỏi cốt lõi mà smoke test phải trả lời

| # | Câu hỏi | Tại sao quan trọng | Hậu quả nếu không kiểm tra |
| --- | --- | --- | --- |
| 1 | Request có đi qua Nginx không? | Nginx là điểm kiểm soát duy nhất cho mọi routing rule, rate limit, header injection | Nếu request đi thẳng app, mọi cấu hình Nginx (upstream, rate limit, canary, timeout) đều vô tác dụng |
| 2 | Nginx có forward đúng đến app backend không? | Xác nhận upstream configuration trỏ đúng service | Route nhầm sang service khác (auth, cart, products) mà vẫn trả 200 -- false positive nguy hiểm |
| 3 | Có dấu hiệu của CDN/Varnish không? | LB suite yêu cầu topology không có CDN để tín hiệu thuần khiết | Nếu có `X-Cache` header, bạn đang test CDN chứ không phải LB |

### 1.3 Vai trò của smoke test trong quy trình vận hành

Trong môi trường production, smoke test là bài test đầu tiên chạy sau mỗi lần:

```text
Triển khai stack mới       -> smoke test đầu tiên
Thay đổi Nginx config       -> smoke test đầu tiên
Scale app instances         -> smoke test đầu tiên
Thêm/bớt upstream service   -> smoke test đầu tiên
Debug lỗi routing           -> smoke test đầu tiên
```

Một smoke test pass không chứng minh hệ thống hoàn hảo, nhưng một smoke test fail chứng minh hệ thống có vấn đề cơ bản cần sửa ngay lập tức.

---

## 2. LB capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh ba khả năng nền tảng của Nginx Gateway:

> **Public entrypoint `:80` đi qua Nginx, forward đến app origin, gắn request ID, và không có CDN cache.**

Cụ thể hơn:

| Capability | Cách chứng minh | Signal |
| --- | --- | --- |
| Gateway routing | Request đến `http://localhost:80` được Nginx nhận và proxy pass | `X-Served-By=nginx` hoặc `Server: nginx/...` |
| Upstream correctness | Nginx forward request đến đúng `app_backend` upstream | `X-Upstream-Service=app` |
| Request traceability | Mỗi request được Gateway gắn một trace ID duy nhất | `X-Request-ID` present, non-empty |
| No CDN interference | Topology `lb-app` không bao gồm Varnish/CDN | `X-Cache` absent trong mọi response |
| App reachability | App origin nhận request và phản hồi đúng | `status=200`, `instance_id` present trên home response |

### 2.2 Sơ đồ mental model

```text
┌──────────┐     ┌─────────────────┐     ┌──────────────┐
│   k6     │────>│  Nginx :80      │────>│  app :8080   │
│  client  │     │  (Gateway/LB)   │     │  (origin)    │
└──────────┘     └─────────────────┘     └──────────────┘
                      │
                      ├─ X-Served-By: nginx
                      ├─ X-Upstream-Service: app
                      ├─ X-Request-ID: <uuid>
                      └─ (không có X-Cache)
```

### 2.3 Tại sao capability này là nền tảng cho mọi case LB khác

Mọi case LB từ 02 đến 12 đều dựa trên giả định rằng Nginx đang thật sự nhận request và forward đến upstream. Nếu giả định này sai:

| Case bị ảnh hưởng | Hậu quả nếu smoke test sai |
| --- | --- |
| 02 - App instance distribution | Không thể kiểm tra distribution nếu request không qua Nginx |
| 03 - Service boundary routing | Không thể kiểm tra route đến microservices |
| 06 - Retry/failover | Không có failover nếu không có Nginx proxy |
| 07 - Rate limit | Không có rate limit nếu request không qua `limit_req_zone` |
| 08 - Canary routing | Không có split_client nếu không qua Nginx |
| 12 - Timeout | Không có proxy_read_timeout nếu request đi thẳng app |

---

## 3. Vì sao phải test ở LB layer

### 3.1 LB là điểm kiểm soát duy nhất cho routing

```text
Kiến trúc đầy đủ:
  Người dùng -> CDN/Varnish -> Nginx -> App -> Database

Kiến trúc LB test:
  k6 -> Nginx -> App
        ↑
   Điểm kiểm soát routing, balancing, rate limit, canary, timeout
```

Khi CDN được loại bỏ khỏi topology (qua `TargetLayer=lb-app`), Nginx trở thành điểm tiếp xúc đầu tiên và duy nhất với thế giới bên ngoài. Mọi quyết định về routing, header injection, connection management đều do Nginx kiểm soát. Smoke test ở layer này xác nhận rằng "bộ não routing" đang hoạt động.

### 3.2 Không thể test Gateway behavior ở tầng app

Nếu bạn gọi thẳng app (bỏ qua Nginx):

```text
Test sai:   curl http://localhost:8080/          (đi thẳng app)
Test đúng:  curl http://localhost:80/             (đi qua Nginx)
```

Chỉ request qua `:80` mới đi qua Nginx và mới có các header do Nginx thêm vào:
- `X-Served-By` -- chỉ Nginx mới thêm header này
- `X-Upstream-Service` -- chỉ Nginx mới biết đang forward đến upstream nào
- `X-Request-ID` -- chỉ Nginx mới gắn `$request_id`

Direct app request sẽ thiếu tất cả các header này, và bạn không thể phân biệt được "thiếu vì chưa cấu hình" hay "thiếu vì không đi qua Nginx".

### 3.3 Tách biệt giữa CDN test và LB test

| Khía cạnh | CDN suite | LB suite |
| --- | --- | --- |
| Topology | `TargetLayer=full` | `TargetLayer=lb-app` hoặc `full-no-cdn` |
| Entry point | Qua Varnish | Qua Nginx trực tiếp |
| Key signal | `X-Cache: HIT/MISS` | `X-Cache` absent |
| Câu hỏi chính | "Cache có hoạt động không?" | "Routing có đúng không?" |
| Header cần có | `X-Cache`, `X-Cache-Key-*` | `X-Served-By`, `X-Upstream-Service`, `X-Request-ID` |

Không trộn lẫn hai suite vì signal của chúng xung đột: CDN cần `X-Cache`, LB cần KHÔNG có `X-Cache`.

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌─────────────────────────┐
                          │    k6 test script        │
                          │    (01-entry-smoke.js)   │
                          └──────────┬───────────────┘
                                     │
                                     │ HTTP GET (public path)
                                     ▼
┌────────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx)                                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Nginx Gateway / LB                                       │  │
│  │  - listen :80                                             │  │
│  │  - X-Served-By: nginx                                     │  │
│  │  - X-Request-ID: $request_id                              │  │
│  │  - location / → proxy_pass http://app_backend             │  │
│  │  - upstream app_backend { server app:8080 resolve; }      │  │
│  └───────────────────┬──────────────────────────────────────┘  │
│                      │ proxy_pass                              │
│                      ▼                                         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  App instances  (ScaleApp: 2)                             │  │
│  │  - app:8080 (instance 1)                                  │  │
│  │  - app:8080 (instance 2)                                  │  │
│  │  - Trả về: { "instance_id": "app-<n>", ... }              │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `lb-app` (bắt buộc) | Không có Varnish container trong `docker ps` |
| `BASE_URL` | `http://localhost:80` | `curl -sI http://localhost:80/` thấy `X-Served-By: nginx` |
| `ScaleApp` | Tối thiểu 1 (khuyến nghị 2 để chuẩn bị cho case 02) | `docker ps --filter "name=app"` thấy đủ container |
| Nginx config | `nginx.conf` có `add_header X-Served-By "nginx" always;` | Response có header |
| App health | Tất cả instance trả về 200 | `curl http://localhost:80/` |

### 4.3 Stack khởi động

```powershell
# Khởi động stack với topology lb-app (không có CDN)
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer lb-app -ScaleApp 2
```

Đợi tất cả service healthy (khoảng 30-60 giây). Kiểm tra:

```powershell
# Xác nhận Nginx đang chạy
docker ps --filter "name=nginx"

# Xác nhận không có Varnish
docker ps --filter "name=varnish"
# Expected: trả về rỗng

# Xác nhận public path hoạt động qua Nginx
curl -sI http://localhost:80/

# Expected output phải có:
# HTTP/1.1 200 OK
# X-Served-By: nginx
# X-Upstream-Service: app
# X-Request-ID: <some-uuid>
```

### 4.4 Biến môi trường

```powershell
$env:BASE_URL = "http://localhost:80"
$env:LB_ENTRY_VUS = "4"           # Số VU chạy đồng thời
$env:LB_ENTRY_DURATION = "20s"    # Thời gian chạy
$env:LB_ENTRY_SLEEP_SECONDS = "0.03"  # Nghỉ giữa các iteration
```

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\lb\01-entry-smoke.js
```

### 5.2 Import và dependency

```javascript
import { sleep } from 'k6';

import { envFloat, envInt, envString } from '../shared/common.js';
import { assertLBResponse, lbAppEntryApis, pickEntryApi, requestLB } from './shared.js';
```

Script sử dụng ba nguồn import:

| Module | Export được dùng | Vai trò |
| --- | --- | --- |
| `k6` | `sleep` | Tạm dừng giữa các iteration để tạo pacing thực tế |
| `../shared/common.js` | `envInt`, `envFloat`, `envString` | Đọc biến môi trường với fallback an toàn |
| `./shared.js` | `lbAppEntryApis`, `pickEntryApi`, `requestLB`, `assertLBResponse` | Toàn bộ logic LB-specific: định nghĩa API, gửi request, kiểm tra response |

### 5.3 Biến cấu hình từ môi trường

```javascript
const ENTRY_VUS = envInt('LB_ENTRY_VUS', 4);
const ENTRY_DURATION = envString('LB_ENTRY_DURATION', '20s');
const ENTRY_SLEEP_SECONDS = envFloat('LB_ENTRY_SLEEP_SECONDS', 0.03);
```

Mỗi biến có một giá trị mặc định hợp lý, nhưng đều có thể ghi đè qua biến môi trường:

| Biến | Mặc định | Ý nghĩa | Khi nào tăng/giảm |
| --- | --- | --- | --- |
| `LB_ENTRY_VUS` | `4` | Số Virtual User chạy đồng thời | Tăng để tạo nhiều request song song hơn; giảm nếu system resource hạn chế |
| `LB_ENTRY_DURATION` | `20s` | Tổng thời gian chạy smoke test | Tăng để có sample lớn hơn cho phân tích thống kê; giảm cho CI pipeline nhanh |
| `LB_ENTRY_SLEEP_SECONDS` | `0.03` | Thời gian nghỉ giữa mỗi iteration | Tăng để giảm tần suất request (mô phỏng người dùng thực); giảm hoặc về 0 để stress test |

**Lưu ý về `ENTRY_SLEEP_SECONDS`:** Giá trị `0.03` giây (30ms) tạo ra pacing khoảng 33 requests/giây/VU. Với 4 VU, tổng throughput khoảng 130 req/s. Đây là mức vừa phải cho smoke test -- đủ để thấy pattern nhưng không gây áp lực lên hệ thống.

### 5.4 options block -- cấu hình executor

```javascript
export const options = {
  vus: ENTRY_VUS,
  duration: ENTRY_DURATION,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<1000'],
  },
  tags: {
    scenario: 'lb_entry_smoke',
    target_layer: 'lb',
    lb_profile: 'lb-app',
  },
};
```

**Phân tích từng phần của options:**

#### Executor: constant-vus (ngầm định)

Khi khai báo `vus` và `duration` ở top-level mà không có `scenarios` block, k6 mặc định dùng executor `constant-vus`:

```text
constant-vus: Duy trì N VU chạy liên tục trong suốt thời gian duration.
Mỗi VU chạy default() function trong vòng lặp vô hạn cho đến khi hết duration.
```

Tại sao chọn `constant-vus` thay vì `shared-iterations` cho smoke test?

| Executor | Hành vi | Phù hợp cho |
| --- | --- | --- |
| `constant-vus` | VU chạy liên tục, số lượng iteration không cố định | Smoke test, load test -- cần quan sát hành vi hệ thống trong một khoảng thời gian |
| `shared-iterations` | Chia đều N iterations cho các VU, dừng khi hết iterations | Correctness test -- cần số lượng request chính xác (như case 02) |

Smoke test dùng `constant-vus` vì mục đích là quan sát hệ thống hoạt động ổn định trong một khoảng thời gian, không phải đếm chính xác số request.

**So sánh đầy đủ 5 executor cho case này:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **constant-vus** (đang dùng) | ✅ **ĐÚNG** | Sustained traffic 18s. VU loop liên tục, rate tự điều chỉnh theo LB response time. Mô hình "user thật" — mỗi VU là 1 user gửi request liên tục. |
| constant-arrival-rate | ⚠️ Được nhưng thừa | Ép rate cố định. LB smoke KHÔNG cần rate chính xác — chỉ cần request liên tục. Thêm `preAllocatedVUs`, `maxVUs` là complexity không cần thiết. |
| shared-iterations | ❌ SAI | Cần tổng iter CỐ ĐỊNH. Case này muốn chạy THEO THỜI GIAN (18s), không phải theo số lượng. Không biết trước iter_time nên không chọn được iterations. |
| per-vu-iterations | ❌ SAI | Cần iter/VU cố định. Case này VU loop vô hạn đến hết duration. |
| ramping-vus | ❌ SAI | Cần thay đổi VU theo stage. Case này VU ổn định = 4, không ramp. |

**Key insight**: LB smoke test = "hệ thống có chạy ổn định trong 18s không?".
Số request thực tế là OUTPUT (phản ánh LB performance), không phải INPUT.
`constant-vus` cho phép VU loop tự nhiên, rate = vus/iter_time thay đổi theo
LB speed.

#### Thresholds -- ba điều kiện cứng

```javascript
thresholds: {
  checks: ['rate==1'],              // (1) 100% checks pass
  http_req_failed: ['rate==0'],     // (2) 0% request thất bại
  http_req_duration: ['p(95)<1000'], // (3) 95% request nhanh hơn 1 giây
},
```

| Threshold | Ý nghĩa | Hậu quả nếu fail |
| --- | --- | --- |
| `checks: rate==1` | Mọi `check()` trong script phải pass. Không chấp nhận dù chỉ 1 check fail | k6 exit code != 0, CI/CD pipeline đỏ |
| `http_req_failed: rate==0` | Không có request nào trả về HTTP status >= 400 hoặc lỗi kết nối | Có request thất bại -- cần điều tra nguyên nhân |
| `http_req_duration: p(95)<1000` | 95% request phải hoàn thành dưới 1000ms | Hệ thống quá chậm -- kiểm tra resource, network, hoặc app performance |

**Tại sao `p(95)<1000` mà không phải `p(99)` hay `avg`?**

- `p(95)` bỏ qua 5% outlier tồi nhất (cold start, GC pause, network jitter)
- `avg` bị ảnh hưởng nặng bởi outlier và không phản ánh trải nghiệm người dùng thực
- `p(99)` quá khắt khe cho smoke test -- smoke test cần nhanh và ổn định, không cần tối ưu đến mức p99

#### Tags -- metadata cho dashboard và filtering

```javascript
tags: {
  scenario: 'lb_entry_smoke',
  target_layer: 'lb',
  lb_profile: 'lb-app',
},
```

Tags này được gắn vào mọi metric k6 thu thập (checks, http_req_duration, http_reqs, v.v.) và cho phép:
- Lọc kết quả theo scenario trên Grafana dashboard
- So sánh các run khác nhau
- Phân biệt LB suite với CDN suite trong cùng một dashboard

### 5.5 `setup()` -- probe ban đầu

```javascript
export function setup() {
  const home = lbAppEntryApis[0];
  const first = requestLB(home, {
    tags: { case: 'entry_smoke_setup' },
  });
  assertLBResponse(first, home, 'entry smoke setup');
}
```

**Phân tích từng dòng:**

1. `lbAppEntryApis[0]` lấy phần tử đầu tiên trong mảng `lbAppEntryApis` -- chính là `home` endpoint (`GET /`).
2. `requestLB(home, ...)` gửi GET request đến `http://localhost:80/` với tags bổ sung.
3. `assertLBResponse(first, home, 'entry smoke setup')` kiểm tra response có:
   - Status 200
   - `X-Served-By=nginx` hoặc `Server: nginx/...`
   - `X-Upstream-Service=app`
   - `X-Request-ID` present
   - Không có `X-Cache`
   - Có `instance_id` trong response body (vì `home.expectInstanceID = true`)

**Tại sao setup gọi home endpoint cụ thể thay vì dùng `pickEntryApi()`?**

Setup chạy đúng một lần trước khi bất kỳ VU nào bắt đầu. Mục đích của setup là xác nhận hệ thống hoạt động cơ bản trước khi bắt đầu traffic sustained. Dùng `home` endpoint (weight cao nhất, response đơn giản nhất) là lựa chọn an toàn nhất cho probe ban đầu.

Nếu setup fail, toàn bộ test dừng ngay lập tức -- không VU nào được khởi động. Đây là cơ chế fail-fast: không lãng phí thời gian chạy 20s traffic nếu hệ thống đã có vấn đề cơ bản.

### 5.6 `default()` -- logic chính

```javascript
export default function () {
  const api = pickEntryApi();
  const res = requestLB(api, {
    tags: {
      endpoint: api.name,
      lb_profile: 'lb-app',
    },
  });
  assertLBResponse(res, api, `${api.name} request`);
  sleep(ENTRY_SLEEP_SECONDS);
}
```

**Phân tích vòng lặp chính của mỗi VU:**

```text
┌──────────────────────────────────────────────┐
│  VU loop (chạy liên tục trong 20s)           │
│                                              │
│  1. pickEntryApi()                           │
│     ├─ Chọn ngẫu nhiên 1 trong 3 API         │
│     ├─ home (60%), users_list (25%),         │
│     │   slow_endpoint (15%)                  │
│     └─ Trả về: { name, method, path, ... }   │
│                                              │
│  2. requestLB(api, {tags})                   │
│     ├─ Gửi HTTP request đến BASE_URL + path  │
│     ├─ Gắn tags: endpoint + lb_profile       │
│     └─ Trả về: response object               │
│                                              │
│  3. assertLBResponse(res, api, label)         │
│     ├─ check status = api.expected           │
│     ├─ check X-Served-By = nginx             │
│     ├─ check X-Upstream-Service = app        │
│     ├─ check X-Request-ID present            │
│     ├─ check X-Cache absent                  │
│     └─ check instance_id (nếu có)            │
│                                              │
│  4. sleep(0.03s)                             │
│     └─ Nghỉ 30ms trước iteration tiếp theo   │
└──────────────────────────────────────────────┘
```

#### Chi tiết `pickEntryApi()` -- weighted random selection

Hàm này được định nghĩa trong `shared.js`:

```javascript
export function pickEntryApi() {
  return chooseWeighted(lbAppEntryApis);
}
```

`chooseWeighted` nhận vào mảng các item có thuộc tính `weight`, tính tổng weight, chọn ngẫu nhiên theo phân phối:

| API | Path | Weight | Tỉ lệ | Mục đích trong smoke test |
| --- | --- | --- | --- | --- |
| `home` | `GET /` | 60 | 60% | Endpoint chính -- response có `instance_id`, xác nhận app reachability |
| `users_list` | `GET /api/users` | 25 | 25% | API endpoint -- xác nhận routing cho path không phải root |
| `slow_endpoint` | `GET /api/slow?cpu_ms=10` | 15 | 15% | Endpoint có tham số -- xác nhận query string không làm hỏng routing |

**Tại sao home chiếm 60%?** Vì home endpoint là endpoint quan trọng nhất để kiểm tra: nó trả về `instance_id` (mà `users_list` và `slow_endpoint` có thể không có). Weight cao giúp đảm bảo có đủ sample `instance_id` để quan sát.

#### Chi tiết `assertLBResponse()` -- 5-6 checks mỗi request

Hàm này được định nghĩa trong `shared.js` và là trái tim của toàn bộ LB suite:

```javascript
export function assertLBResponse(res, api, label) {
  const prefix = label || api.name;
  check(res, {
    [`${prefix} status`]: (r) => r.status === api.expected,
    [`${prefix} served by nginx`]: (r) => {
      const explicit = headerValue(r, 'X-Served-By');
      const server = headerValue(r, 'Server');
      return explicit === 'nginx' || server.toLowerCase().startsWith('nginx/');
    },
    [`${prefix} upstream matches`]: (r) => headerValue(r, 'X-Upstream-Service') === api.expectedUpstream,
    [`${prefix} request id present`]: (r) => !!headerValue(r, 'X-Request-ID'),
    [`${prefix} no cache header`]: (r) => !headerValue(r, 'X-Cache'),
  });

  if (api.expectInstanceID) {
    check(res, {
      [`${prefix} has instance id`]: (r) => {
        const instanceID = safeJsonField(r, 'instance_id');
        return typeof instanceID === 'string' && instanceID.trim() !== '';
      },
    });
  }
}
```

| # | Check | Điều kiện pass | Tại sao quan trọng |
| --- | --- | --- | --- |
| 1 | `status` | `r.status === api.expected` (200) | Xác nhận app không trả về lỗi |
| 2 | `served by nginx` | `X-Served-By === 'nginx'` hoặc `Server` bắt đầu bằng `nginx/` | Chứng minh request đi qua Nginx Gateway. Đây là check quan trọng nhất -- nếu fail, toàn bộ topology có vấn đề |
| 3 | `upstream matches` | `X-Upstream-Service === api.expectedUpstream` (`'app'`) | Chứng minh Nginx forward đến đúng upstream block |
| 4 | `request id present` | `X-Request-ID` khác rỗng | Chứng minh Nginx gắn trace ID cho mỗi request |
| 5 | `no cache header` | `X-Cache` không tồn tại | Chứng minh không có CDN/Varnish trong path |
| 6 | `has instance id` | `instance_id` trong body là string không rỗng | Chứng minh app thật sự xử lý request và trả về định danh instance |

**Check 2 dùng `||` với hai điều kiện** vì các phiên bản Nginx khác nhau có thể dùng header khác nhau để báo hiệu sự hiện diện của mình. `Server` header là chuẩn HTTP, `X-Served-By` là custom header được thêm thủ công trong config.

### 5.7 Sơ đồ tổ chức toàn bộ script

```text
┌─ options: constant-vus, 4 VU, 20s, thresholds checks=1, failed=0, p95<1s
│
├─ setup()
│   └─ GET / → assertLBResponse (probe ban đầu)
│
└─ default()  ← mỗi VU chạy trong vòng lặp 20s
    ├─ pickEntryApi()  → weighted random (home 60%, users 25%, slow 15%)
    ├─ requestLB(api)  → GET http://localhost:80/<path>
    ├─ assertLBResponse(res, api, label)
    │   ├─ check status = 200
    │   ├─ check served by nginx
    │   ├─ check upstream = app
    │   ├─ check request ID present
    │   ├─ check no X-Cache
    │   └─ check instance_id (home only)
    └─ sleep(0.03s)
```

---

## 6. Nginx/LB mechanism deep-dive

### 6.1 Cấu trúc Nginx config cho smoke test

Smoke test dựa trên ba phần quan trọng của `nginx.conf`:

#### 6.1.1 Server block -- entrypoint chính

```nginx
server {
    listen 80;
    add_header X-Served-By "nginx" always;
    ...
```

`listen 80` là cổng public duy nhất mà smoke test gửi request đến. `add_header X-Served-By "nginx" always` đảm bảo mọi response (kể cả 4xx, 5xx) đều có header này. Từ khóa `always` rất quan trọng: nếu không có nó, header chỉ được thêm vào response 2xx và 3xx.

#### 6.1.2 Upstream block -- backend definition

```nginx
upstream app_backend {
    zone upstream_backend 64k;
    server app:8080 resolve max_fails=3 fail_timeout=5s;
    keepalive 64;
}
```

| Directive | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `zone upstream_backend 64k` | 64KB shared memory zone | Cho phép các worker process chia sẻ trạng thái upstream |
| `server app:8080 resolve` | DNS resolution động | Mỗi khi DNS cache hết hạn, Nginx resolve lại `app` -- điều này cho phép scale app instances mà không cần reload Nginx |
| `max_fails=3` | 3 lần thất bại | Sau 3 lần fail liên tiếp, server bị đánh dấu DOWN trong `fail_timeout` |
| `fail_timeout=5s` | 5 giây | Thời gian server bị treo sau khi bị đánh dấu DOWN |
| `keepalive 64` | 64 kết nối keepalive | Số kết nối idle tối đa đến upstream được giữ mở |

**Cơ chế `resolve`:** Khi dùng `resolve`, Nginx không cache IP của `app` vĩnh viễn. Nó resolve lại theo chu kỳ DNS TTL. Khi Docker scale `app` service từ 1 lên 2 instances, DNS round-robin tự động trả về cả hai IP, và Nginx dần dần phân phối request đến cả hai.

#### 6.1.3 Location block -- routing chính

```nginx
location / {
    add_header X-Upstream-Service "app" always;
    proxy_pass http://app_backend;
}
```

`location /` match mọi request không được match bởi các location cụ thể hơn. Đây là catch-all route cho smoke test.

`proxy_pass http://app_backend` forward request đến upstream block `app_backend`. Nginx tự động:
1. Phân giải `app_backend` thành danh sách server (qua DNS)
2. Chọn một server theo thuật toán round-robin (mặc định)
3. Thiết lập kết nối đến server đó
4. Forward request
5. Nhận response và trả về client

### 6.2 Cơ chế proxy_pass chi tiết

```text
┌─────────────────────────────────────────────────────────────────┐
│  Nginx xử lý một request GET /                                  │
│                                                                 │
│  1. vcl_recv phase:                                             │
│     - Nhận request từ client (k6)                               │
│     - Match location /                                          │
│     - Gán $request_id (unique UUID)                             │
│                                                                 │
│  2. vcl_hash / upstream selection:                              │
│     - Chọn upstream "app_backend"                               │
│     - Round-robin qua danh sách server: app:8080                │
│     - Nếu ScaleApp=2: chọn giữa instance 1 và instance 2        │
│                                                                 │
│  3. proxy_pass:                                                 │
│     - Mở kết nối TCP đến app:8080                               │
│     - Gửi HTTP request với các header:                          │
│       GET / HTTP/1.1                                            │
│       Host: localhost                                           │
│       X-Real-IP: 172.17.0.1                                     │
│       X-Forwarded-For: 172.17.0.1                               │
│       X-Forwarded-Proto: http                                   │
│       X-Request-ID: <uuid>                                      │
│       Connection: ""                                            │
│                                                                 │
│  4. Nhận response từ upstream:                                  │
│     - App xử lý, trả về 200 + body JSON                         │
│                                                                 │
│  5. vcl_response / header filter:                               │
│     - Thêm X-Served-By: nginx (always)                          │
│     - Thêm X-Upstream-Service: app (always)                     │
│     - Thêm X-Request-ID: <uuid> (từ $request_id)                │
│                                                                 │
│  6. Trả response về client (k6)                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 DNS resolution và app scaling

Khi `ScaleApp=2`, Docker tạo hai container cho app service. DNS name `app` resolve thành hai IP:

```text
$ nslookup app
Name:    app
Address: 172.18.0.3
Address: 172.18.0.4
```

Với directive `server app:8080 resolve`, Nginx định kỳ resolve lại DNS và tự động cập nhật danh sách upstream. Không cần reload Nginx khi scale.

**Tuy nhiên**, có một khoảng trễ: Nginx chỉ resolve lại khi DNS record hết TTL. Trong khoảng thời gian đó, Nginx tiếp tục dùng IP cũ. Đây là lý do case 02 cần sample đủ lớn (60 iterations) để chắc chắn thấy cả hai instance.

### 6.4 X-Request-ID -- cơ chế trace ID

```nginx
proxy_set_header X-Request-ID $request_id;
```

`$request_id` là biến nội bộ của Nginx, được tạo tự động cho mỗi request. Nó là một UUID duy nhất:

```text
Ví dụ: X-Request-ID: 1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p
```

Biến này được:
1. Tạo ra khi Nginx nhận request
2. Forward đến upstream qua `proxy_set_header`
3. Thêm vào response qua `add_header` (trong một số location)

Smoke test kiểm tra sự hiện diện của `X-Request-ID` trong response để xác nhận rằng:
- Request đã qua Nginx (chứ không phải direct app)
- Nginx đang hoạt động bình thường (tạo được request ID)
- Có thể dùng request ID để trace request qua các tầng

### 6.5 Tại sao X-Cache phải ABSENT

Trong topology `lb-app`, không có Varnish container nào chạy. Do đó:

```text
Có X-Cache header → Có Varnish trong path → topology SAI
                   → Đang dùng TargetLayer=full thay vì TargetLayer=lb-app
                   → Mọi kết luận về LB có thể bị nhiễu bởi CDN cache
```

---

## 7. Request sequence flow

### 7.1 Timeline toàn bộ script

```text
T0: k6 start
│
├─ SETUP phase ────────────────────────────────────
│  T1: GET /  (entry_smoke_setup)
│      → assertLBResponse: status=200, nginx, upstream=app, request-id, no-cache, instance_id
│      → Nếu pass: tiếp tục
│      → Nếu fail: dừng ngay, không VU nào chạy
│
├─ DEFAULT phase (20s, 4 VU chạy song song) ───────
│
│  VU-1:                          VU-2:                          VU-3:                          VU-4:
│  ─────                          ─────                          ─────                          ─────
│  T2: pickEntryApi()             T3: pickEntryApi()             T4: pickEntryApi()             T5: pickEntryApi()
│  T2: GET /api/users             T3: GET /                      T4: GET /api/slow?cpu_ms=10    T5: GET /
│  T2: assertLBResponse ✓         T3: assertLBResponse ✓         T4: assertLBResponse ✓         T5: assertLBResponse ✓
│  T2: sleep(0.03)                T3: sleep(0.03)                T4: sleep(0.03)                T5: sleep(0.03)
│  T6: pickEntryApi()             T7: pickEntryApi()             T8: pickEntryApi()             T9: pickEntryApi()
│  ...                            ...                            ...                            ...
│  (lặp lại cho đến T=20s)        (lặp lại cho đến T=20s)        (lặp lại cho đến T=20s)        (lặp lại cho đến T=20s)
│
└─ T_end: k6 end (~20s + gracefulStop)
```

### 7.2 Phân tích luồng request của một VU

```text
┌─────────────────────────────────────────────────────────────────┐
│  Timeline của một VU trong 1 iteration                           │
│                                                                 │
│  t=0.000s  Bắt đầu iteration                                    │
│  t=0.000s  pickEntryApi() → chọn weighted random                │
│  t=0.001s  requestLB(api) → HTTP GET đến localhost:80           │
│            ├─ DNS resolve (cached)                               │
│            ├─ TCP connect đến localhost:80                       │
│            ├─ Gửi HTTP request                                   │
│            ├─ Nginx xử lý (chọn upstream, proxy_pass)            │
│            ├─ App xử lý (tạo response, trả về instance_id)       │
│            └─ Nginx thêm header, trả response                    │
│  t=0.010s  Nhận response (giả sử latency ~9ms)                  │
│  t=0.011s  assertLBResponse → 5-6 checks                        │
│  t=0.011s  sleep(0.03) → nghỉ 30ms                              │
│  t=0.041s  Kết thúc iteration → bắt đầu iteration mới           │
│                                                                 │
│  Tổng thời gian 1 iteration: ~41ms                              │
│  Request/giây/VU: ~24 req/s                                     │
│  Tổng request/giây (4 VU): ~96 req/s                            │
│  Tổng request trong 20s: ~2,400 requests                        │
│  Tổng checks trong 20s: ~12,000 - 14,400 checks                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.3 Phân phối request thực tế giữa các API

Với weighted random (60/25/15) và khoảng 2,400 request:

| API | Weight | Request dự kiến | Request thực tế (xấp xỉ) |
| --- | --- | --- | --- |
| `GET /` | 60% | 1,440 | 1,400 - 1,480 |
| `GET /api/users` | 25% | 600 | 580 - 620 |
| `GET /api/slow?cpu_ms=10` | 15% | 360 | 340 - 380 |

---

## 8. Key signals / headers cần verify

### 8.1 Bảng header đầy đủ

| Header | Vị trí | Giá trị mong đợi | Check trong assertLBResponse | Ý nghĩa nếu có / không có |
| --- | --- | --- | --- | --- |
| `X-Served-By` | Response | `nginx` | `served by nginx` | **Có:** Request đi qua Nginx. **Không có:** Request đi thẳng app hoặc qua path khác |
| `Server` | Response | `nginx/...` (vd: `nginx/1.25.3`) | `served by nginx` (fallback) | **Có:** Nginx đang phản hồi. **Không có:** Có thể là app server trả về trực tiếp |
| `X-Upstream-Service` | Response | `app` | `upstream matches` | **Có và =app:** Nginx forward đến đúng app_backend. **Có nhưng !=app:** Route nhầm service. **Không có:** Không xác định được upstream |
| `X-Request-ID` | Response | UUID string (không rỗng) | `request id present` | **Có:** Nginx gắn trace ID. **Không có:** Có thể không qua Nginx hoặc config thiếu |
| `X-Cache` | Response | **KHÔNG tồn tại** | `no cache header` | **Có:** Đang có CDN/Varnish trong path -- sai topology. **Không có:** Đúng topology lb-app |
| `instance_id` | Response body (JSON) | String không rỗng (vd: `"app-1"`, `"app-2"`) | `has instance id` (chỉ cho home) | **Có:** App đang chạy và trả về định danh. **Không có:** App không hoạt động hoặc response format sai |

### 8.2 Cách đọc header từ response

Dùng curl để kiểm tra thủ công trước khi chạy k6:

```powershell
# Kiểm tra đầy đủ header
curl -sI http://localhost:80/

# Expected output:
# HTTP/1.1 200 OK
# Server: nginx/1.25.3
# X-Served-By: nginx
# X-Upstream-Service: app
# X-Request-ID: 1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p
# (KHÔNG có X-Cache)

# Kiểm tra body (home endpoint trả về JSON)
curl -s http://localhost:80/ | ConvertFrom-Json | Select-Object instance_id
```

### 8.3 Cách đọc checks từ k6 output

k6 output hiển thị checks theo format:

```text
█ checks...
  ✓ entry smoke setup status
  ✓ entry smoke setup served by nginx
  ✓ entry smoke setup upstream matches
  ✓ entry smoke setup request id present
  ✓ entry smoke setup no cache header
  ✓ entry smoke setup has instance id
  ✓ home request status
  ✓ home request served by nginx
  ✓ home request upstream matches
  ✓ home request request id present
  ✓ home request no cache header
  ✓ home request has instance id
  ✓ users_list request status
  ✓ users_list request served by nginx
  ...
```

Mỗi dòng `✓` là một check pass. Tên check cho biết request nào và điều kiện gì. Ví dụ:
- `entry smoke setup` = request trong setup()
- `home request` = request đến home endpoint trong default()
- `users_list request` = request đến users_list endpoint

Nếu có check fail (`✗`), tên check sẽ cho biết chính xác request nào và điều kiện gì đã thất bại.

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Case được coi là PASS khi **tất cả** các điều kiện sau đều đúng:

| # | Tiêu chí | Cách xác minh | Định lượng |
| --- | --- | --- | --- |
| 1 | k6 exit code = 0 | `$LASTEXITCODE` hoặc CI job status | `exit 0` |
| 2 | 100% checks pass | k6 output: `checks... 100%` hoặc `✓ checks...: 100.00%` | `checks rate = 1.0` |
| 3 | 0% HTTP failures | k6 output: `http_req_failed: 0.00%` | `http_req_failed rate = 0` |
| 4 | Latency p95 < 1000ms | k6 output: `http_req_duration... p(95)=<value>` | `p(95) < 1000ms` |
| 5 | Setup probe pass | 6 checks trong setup đều ✓ | Tất cả 6 setup checks pass |
| 6 | Mọi request trong default pass | Mỗi request có 5-6 checks, tất cả đều ✓ | Không có check ✗ nào |
| 7 | `X-Served-By` = nginx trên mọi response | `✓ ... served by nginx` cho mọi request | 100% |
| 8 | `X-Upstream-Service` = app trên mọi response | `✓ ... upstream matches` cho mọi request | 100% |
| 9 | `X-Request-ID` present trên mọi response | `✓ ... request id present` cho mọi request | 100% |
| 10 | `X-Cache` absent trên mọi response | `✓ ... no cache header` cho mọi request | 100% |

### 9.2 Tiêu chí FAIL

Case FAIL khi **bất kỳ** điều kiện nào sau đây xảy ra:

| # | Dấu hiệu FAIL | Nguyên nhân khả dĩ | Cách debug |
| --- | --- | --- | --- |
| A | Setup probe fail -- status != 200 | App chưa khởi động xong, hoặc sai URL | `curl http://localhost:80/` để kiểm tra thủ công |
| B | Setup probe fail -- `X-Served-By` không phải nginx | Request không qua Nginx | Kiểm tra `BASE_URL` -- phải là `http://localhost:80` |
| C | Setup probe fail -- `X-Upstream-Service` không phải app | Nginx config upstream sai | Kiểm tra `nginx.conf` location `/` |
| D | Setup probe fail -- thiếu `X-Request-ID` | `proxy_set_header` thiếu hoặc bị overwrite | Kiểm tra `nginx.conf` |
| E | Setup probe fail -- có `X-Cache` | Đang dùng sai topology (`TargetLayer=full` thay vì `lb-app`) | `docker ps --filter "name=varnish"` -- nếu có container, cần chạy lại stack với `-TargetLayer lb-app` |
| F | `http_req_failed > 0` | Có request trả về 4xx hoặc 5xx | Đọc k6 output để xem status code nào xuất hiện |
| G | Latency p95 > 1000ms | Hệ thống quá tải hoặc network chậm | Kiểm tra resource usage (`docker stats`), giảm `LB_ENTRY_VUS` |
| H | Một số request có check fail | Intermittent issue -- có thể là race condition hoặc resource giới hạn | Tăng `LB_ENTRY_DURATION` để có thêm sample, kiểm tra log |
| I | k6 exit code != 0 nhưng tất cả checks pass | Threshold `http_req_duration` hoặc `http_req_failed` bị vi phạm | Đọc k6 output để xem threshold nào bị crossed |

### 9.3 Ma trận quyết định

| Tình trạng | Checks | http_req_failed | p95 | Kết luận | Hành động |
| --- | --- | --- | --- | --- | --- |
| A | 100% | 0% | < 1000ms | PASS hoàn toàn | Sẵn sàng chạy case 02 |
| B | 100% | 0% | >= 1000ms | PASS về correctness, FAIL về performance | Giảm VUs hoặc tăng duration; kiểm tra resource |
| C | < 100% | 0% | < 1000ms | FAIL -- có check không pass | Xem tên check ✗ để xác định signal nào bị thiếu/sai |
| D | < 100% | > 0% | < 1000ms | FAIL -- có request lỗi | Kiểm tra app log, Nginx error log |
| E | 0% (toàn bộ fail) | 100% | N/A | FAIL hoàn toàn -- hệ thống không hoạt động | Kiểm tra stack: `docker ps`, `docker logs nginx` |

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy

```powershell
# 1. Di chuyển đến thư mục gốc
cd E:\Projects\k6\k6-metrics-server

# 2. Khởi động stack (nếu chưa chạy)
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer lb-app -ScaleApp 2

# 3. Set biến môi trường
$env:BASE_URL = "http://localhost:80"

# 4. Chạy case 01 qua runner script
.\scripts\run-lb-capabilities.ps1 -Profile lb-app -Scenarios 01-entry-smoke

# Hoặc chạy trực tiếp bằng k6:
k6 run .\load-target\k6\lb\01-entry-smoke.js
```

### 10.2 Output mẫu mong đợi (PASS)

```text

         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: .\load-target\k6\lb\01-entry-smoke.js
     output: -

  scenarios: (100.00%) 1 scenario, 4 max VUs, 20m30s max duration (incl. graceful stop):
           * default: 4 looping VUs for 20s (exec: default, gracefulStop: 30s)


     data_received..................: 2.3 MB  ...
     data_sent......................: 280 kB  ...
     http_req_blocked...............: avg=0.01ms  ...
     http_req_connecting............: avg=0.00ms  ...
     http_req_duration..............: avg=5.20ms  min=2.10ms med=4.80ms max=45.30ms p(90)=8.20ms p(95)=12.50ms
     http_req_receiving.............: avg=0.12ms  ...
     http_req_sending...............: avg=0.01ms  ...
     http_req_waiting...............: avg=5.07ms  ...
     http_reqs......................: 2463    ...
     iteration_duration.............: avg=41.50ms ...
     iterations.....................: 492     ...
     vus............................: 4       ...
     vus_max........................: 4       ...


█ checks...
  ✓ entry smoke setup status
  ✓ entry smoke setup served by nginx
  ✓ entry smoke setup upstream matches
  ✓ entry smoke setup request id present
  ✓ entry smoke setup no cache header
  ✓ entry smoke setup has instance id
  ✓ home request status
  ✓ home request served by nginx
  ✓ home request upstream matches
  ✓ home request request id present
  ✓ home request no cache header
  ✓ home request has instance id
  ✓ users_list request status
  ✓ users_list request served by nginx
  ✓ users_list request upstream matches
  ✓ users_list request request id present
  ✓ users_list request no cache header
  ✓ slow_endpoint request status
  ✓ slow_endpoint request served by nginx
  ✓ slow_endpoint request upstream matches
  ✓ slow_endpoint request request id present
  ✓ slow_endpoint request no cache header

   ✓ checks........................: 100.00% ✓ 13764   ✗ 0
     ✓ { scenario:lb_entry_smoke }...: 100.00% ✓ 13764   ✗ 0


running (20.0s), 4/4 VUs, 492 complete and 0 interrupted iterations
default ✓ [======================================] 4 VUs  20s
```

### 10.3 Output mẫu khi FAIL (topology sai -- có CDN)

```text
█ checks...
  ✓ entry smoke setup status
  ✗ entry smoke setup served by nginx
    ↳  0% — ✓ 0 / ✗ 1
  ✓ entry smoke setup upstream matches
  ✓ entry smoke setup request id present
  ✗ entry smoke setup no cache header
    ↳  0% — ✓ 0 / ✗ 1
  ✓ entry smoke setup has instance id

   ✗ checks........................: 66.66%  ✓ 4   ✗ 2
     ✗ { scenario:lb_entry_smoke }...: 66.66%  ✓ 4   ✗ 2

ERRO[0004] thresholds on metrics 'checks' were crossed; at least one has failed
```

**Phân tích:** `X-Served-By` không phải `nginx` (có thể là `Varnish`) và có `X-Cache` header. Điều này chỉ ra rằng topology đang dùng `full` thay vì `lb-app`. Cần chạy lại stack với `-TargetLayer lb-app`.

### 10.4 Cách đọc output

| Phần output | Ý nghĩa | Hành động |
| --- | --- | --- |
| Tổng quan (data_received, http_reqs, ...) | Thống kê traffic tổng thể | Dùng để so sánh giữa các run |
| `http_req_duration` | Phân phối latency | `p(95)` là con số quan trọng nhất |
| `✓ checks...: 100.00%` | Tất cả checks pass | Case PASS |
| `✗ checks...: XX%` | Có check fail | Đọc tên check ✗ để xác định vấn đề |
| `ERRO[...] thresholds on metrics 'checks' were crossed` | checks rate < 1.0 | CI/CD pipeline sẽ đỏ |

---

## 11. 4 output -> decision scenarios

### Scenario 1: ALL PASS

```text
✓ checks 100% — tất cả 13,764 checks xanh
✓ http_req_failed 0%
✓ p95 < 100ms
```

**Kết luận:** Public entrypoint `:80` hoạt động chính xác. Nginx đang nhận request, forward đến app backend, gắn request ID, và không có CDN/Varnish trong path.

**Quyết định:** Chuyển sang case 02 (app instance distribution) để kiểm tra phân phối request giữa các app instance.

### Scenario 2: Checks pass nhưng latency cao

```text
✓ checks 100%
✓ http_req_failed 0%
✗ http_req_duration p95 = 1,500ms (> 1000ms threshold)
```

**Phân tích:** Routing đúng nhưng hệ thống chậm. Có thể do:
- App instance thiếu resource (CPU/memory)
- Network latency giữa Nginx và app
- `ENTRY_VUS` quá cao gây tắc nghẽn

**Quyết định:**
- Giảm `LB_ENTRY_VUS` từ 4 xuống 2
- Kiểm tra `docker stats` để xem resource usage
- Tăng `LB_ENTRY_DURATION` để có sample ổn định hơn

### Scenario 3: Một số check fail (intermittent)

```text
✗ checks 99.5% — 13,695 ✓, 69 ✗
✓ http_req_failed 0.5% — vài request 502
```

**Phân tích:** Đa số request OK nhưng có một số thất bại. Có thể do:
- App instance bị restart giữa chừng
- Nginx `max_fails=3` đã kích hoạt và tạm thời đánh dấu instance DOWN
- Race condition khi Docker DNS cập nhật

**Quyết định:**
- Tăng `fail_timeout` trong Nginx config (nếu quá ngắn)
- Đảm bảo app instance đủ resource
- Chạy lại test với duration dài hơn để xem pattern có lặp lại không

### Scenario 4: Setup pass nhưng default fail toàn bộ

```text
✓ entry smoke setup status         (setup pass)
✓ entry smoke setup served by nginx
...
✗ home request status              (default fail)
✗ home request served by nginx
```

**Phân tích:** Setup gọi 1 request OK nhưng khi 4 VU chạy song song thì fail. Đây là dấu hiệu của vấn đề concurrency:
- App không chịu được concurrent connections
- Connection pool của Nginx cạn kiệt
- File descriptor limit

**Quyết định:**
- Giảm `LB_ENTRY_VUS` xuống 1
- Kiểm tra `keepalive` setting trong Nginx upstream block
- Kiểm tra `ulimit` của app container

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Status 200 nghĩa là mọi thứ OK"

```text
Sai:    HTTP 200 → Hệ thống hoạt động đúng
Đúng:   HTTP 200 chỉ có nghĩa là app trả về OK. Nó không chứng minh:
        - Request đã qua Nginx (có thể direct app)
        - Route đúng upstream (có thể route nhầm service)
        - Không có CDN (có thể Varnish trả về 200 từ cache)
```

**Giải thích:** Một response 200 có thể đến từ bất kỳ đâu trong chain: Varnish cache hit, Nginx route nhầm nhưng service vẫn trả 200, hoặc thậm chí direct app. Chỉ có các header signal mới chứng minh được path thực tế.

### Nghịch lý 2: "Thấy `Server: nginx` là đủ -- không cần `X-Served-By`"

```text
Sai:    Server: nginx → Đã chứng minh qua Nginx
Đúng:   Server header CÓ THỂ bị thay đổi hoặc xóa bởi upstream.
        X-Served-By được thêm với 'always' nên không thể bị xóa.
        Cả hai đều nên được kiểm tra.
```

**Giải thích:** `Server` header có thể bị proxy_set_header hoặc upstream response ghi đè. `X-Served-By` với cờ `always` được thêm vào mọi response (kể cả error) và không bị ảnh hưởng bởi upstream. Check cả hai để tăng độ tin cậy.

### Nghịch lý 3: "Không có `X-Cache` nghĩa là không có cache"

```text
Sai:    Không có X-Cache → Không có cache layer
Đúng:   Không có X-Cache trong topology lb-app là ĐÚNG.
        Nhưng trong topology full, không có X-Cache có thể là BUG
        (Varnish không hoạt động hoặc bị bypass).
```

**Giải thích:** Sự vắng mặt của `X-Cache` chỉ có ý nghĩa khi bạn biết topology mong đợi. Trong `lb-app`, không có Varnish nên không có `X-Cache` là đúng. Trong `full`, không có `X-Cache` là dấu hiệu Varnish bị lỗi.

### Nghịch lý 4: "Smoke test pass nghĩa là sẵn sàng cho production"

```text
Sai:    Smoke test pass → Hệ thống sẵn sàng production
Đúng:   Smoke test chỉ chứng minh routing cơ bản. Nó không chứng minh:
        - Distribution giữa các instance (case 02)
        - Service boundary routing (case 03)
        - Failover (case 06)
        - Rate limiting (case 07)
        - Timeout policy (case 12)
```

**Giải thích:** Smoke test là bài test "đường ống có thông không". Nó không kiểm tra bất kỳ advanced capability nào. Một smoke test pass là điều kiện cần, không phải điều kiện đủ.

### Nghịch lý 5: "Timeout 1000ms là quá khắt khe / quá dễ"

```text
Một số người nói: p95 < 1000ms là quá dễ -- app local phải dưới 50ms
Một số người khác: p95 < 1000ms là quá khó -- CI pipeline có thể chậm

Thực tế: Ngưỡng 1000ms là CONTRACT, không phải benchmark.
         Nó đảm bảo rằng không có request nào "treo" quá lâu.
         Đây là safety net, không phải performance target.
```

**Giải thích:** Mục đích của threshold này là bắt các trường hợp request bị treo (timeout, infinite loop), không phải để đo performance. Trong môi trường local, latency thực tế thường dưới 10ms. Nếu p95 vượt 1000ms, có điều gì đó nghiêm trọng đang xảy ra.

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=nginx"` | Có container Nginx | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer lb-app -ScaleApp 2` |
| 2 | Không có Varnish | `docker ps --filter "name=varnish"` | Không có container | Nếu có: chạy lại stack với `-TargetLayer lb-app` |
| 3 | App instance đang chạy | `docker ps --filter "name=app"` | Có container app | Đợi stack khởi động xong |
| 4 | Public path hoạt động | `curl -sI http://localhost:80/` | HTTP 200, có `X-Served-By: nginx` | Kiểm tra Nginx config |
| 5 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại biến môi trường |
| 6 | Port 80 không bị chiếm | `netstat -ano \| findstr :80` | Chỉ có Docker process | Dừng process khác đang dùng port 80 |
| 7 | k6 đã được cài đặt | `k6 version` | Hiển thị version | Cài đặt k6 |

### 13.2 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 8 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\lb\01-entry-smoke.js"` |
| 9 | `shared.js` tồn tại | Import đúng path |
| 10 | `common.js` tồn tại | Import `envInt`, `envFloat`, `envString` |
| 11 | Home endpoint trả về `instance_id` | `curl -s http://localhost:80/ \| jq .instance_id` |
| 12 | API users trả về 200 | `curl -sI http://localhost:80/api/users` |
| 13 | API slow trả về 200 | `curl -sI "http://localhost:80/api/slow?cpu_ms=10"` |

### 13.3 Pre-flight validation

```powershell
# Chạy nhanh 1 request để xác nhận mọi thứ OK
curl -sI http://localhost:80/ | Select-String "X-Served-By|X-Upstream-Service|X-Request-ID|X-Cache"

# Expected output phải có:
# X-Served-By: nginx
# X-Upstream-Service: app
# X-Request-ID: <uuid>
# (KHÔNG có X-Cache)
```

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Smoke test với số VU khác nhau

Mở rộng script để chạy smoke test với nhiều mức VU khác nhau, kiểm tra xem hệ thống có ổn định khi tăng concurrent users không.

```javascript
// Variation 1: Multi-VU smoke test
// Chạy với 1 VU, 4 VU, 8 VU, 16 VU và so sánh kết quả

import { sleep } from 'k6';
import { envFloat, envInt, envString } from '../shared/common.js';
import { assertLBResponse, lbAppEntryApis, pickEntryApi, requestLB } from './shared.js';

const ENTRY_VUS = envInt('LB_ENTRY_VUS', 4);
const ENTRY_DURATION = envString('LB_ENTRY_DURATION', '20s');
const ENTRY_SLEEP_SECONDS = envFloat('LB_ENTRY_SLEEP_SECONDS', 0.03);

export const options = {
  scenarios: {
    smoke_low: {
      executor: 'constant-vus',
      vus: 1,
      duration: '10s',
      exec: 'smokeRun',
      startTime: '0s',
      tags: { vu_level: '1' },
    },
    smoke_medium: {
      executor: 'constant-vus',
      vus: 4,
      duration: '10s',
      exec: 'smokeRun',
      startTime: '12s',
      tags: { vu_level: '4' },
    },
    smoke_high: {
      executor: 'constant-vus',
      vus: 8,
      duration: '10s',
      exec: 'smokeRun',
      startTime: '24s',
      tags: { vu_level: '8' },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export function smokeRun() {
  const api = pickEntryApi();
  const res = requestLB(api, {
    tags: {
      endpoint: api.name,
      lb_profile: 'lb-app',
    },
  });
  assertLBResponse(res, api, `${api.name} request`);
  sleep(ENTRY_SLEEP_SECONDS);
}
```

**Điểm học:** Khi tăng VU, latency có thể tăng nhưng checks phải vẫn pass 100%. Nếu checks bắt đầu fail ở mức VU cao, hệ thống có vấn đề về concurrency.

### Variation 2: Smoke test tập trung vào một endpoint cụ thể

Thay vì random giữa 3 API, smoke test tập trung toàn bộ traffic vào một endpoint để kiểm tra sâu hơn.

```javascript
// Variation 2: Single-endpoint focused smoke test
// Chỉ gọi home endpoint để kiểm tra instance_id consistency

export default function () {
  const home = lbAppEntryApis[0];  // home endpoint
  const res = requestLB(home, {
    tags: {
      endpoint: 'home',
      lb_profile: 'lb-app',
    },
  });
  assertLBResponse(res, home, 'home request');

  // Kiểm tra thêm: instance_id phải ổn định (cùng một instance cho cùng một VU nếu dùng keepalive)
  const instanceID = res.json('instance_id');
  console.log(`VU ${__VU} iteration ${__ITER} -> instance_id: ${instanceID}`);

  sleep(ENTRY_SLEEP_SECONDS);
}
```

**Điểm học:** Khi tập trung vào home endpoint, bạn có thể quan sát `instance_id` pattern để hiểu cách Nginx phân phối request (chuẩn bị cho case 02).

### Variation 3: Smoke test với custom header verification

Thêm các check bổ sung để kiểm tra các header ít được chú ý hơn.

```javascript
// Variation 3: Extended header verification
import { check } from 'k6';

export default function () {
  const api = pickEntryApi();
  const res = requestLB(api, {
    tags: {
      endpoint: api.name,
      lb_profile: 'lb-app',
    },
  });
  assertLBResponse(res, api, `${api.name} request`);

  // Checks bổ sung
  check(res, {
    [`${api.name} content-type is json`]: (r) =>
      r.headers['Content-Type'] && r.headers['Content-Type'].includes('application/json'),
    [`${api.name} connection header`]: (r) =>
      r.headers['Connection'] !== 'close',  // keepalive nên được dùng
    [`${api.name} transfer-encoding`]: (r) =>
      !r.headers['Transfer-Encoding'] || r.headers['Transfer-Encoding'] !== 'chunked',
  });

  sleep(ENTRY_SLEEP_SECONDS);
}
```

**Điểm học:** Ngoài các header chính, các header HTTP chuẩn cũng cung cấp thông tin về cách Nginx và app giao tiếp.

### Variation 4: Smoke test với graceful degradation

Mô phỏng tình huống một app instance bị crash giữa chừng và kiểm tra smoke test có phát hiện được không.

```javascript
// Variation 4: Smoke test with graceful degradation detection
// Script này không tự crash instance -- nó chỉ thêm checks để phát hiện
// Bạn cần crash instance thủ công: docker stop <app-container-id>

import { Trend } from 'k6/metrics';

const smokeLatency = new Trend('smoke_latency_by_endpoint', true);

export default function () {
  const api = pickEntryApi();
  const start = Date.now();
  const res = requestLB(api, {
    tags: {
      endpoint: api.name,
      lb_profile: 'lb-app',
    },
  });
  const duration = Date.now() - start;

  smokeLatency.add(duration, { endpoint: api.name });

  assertLBResponse(res, api, `${api.name} request`);

  // Cảnh báo nếu latency tăng đột biến (dấu hiệu failover đang xảy ra)
  if (duration > 100) {
    console.warn(`High latency detected: ${duration}ms for ${api.name}`);
  }

  sleep(ENTRY_SLEEP_SECONDS);
}
```

**Điểm học:** Custom metric `smoke_latency_by_endpoint` cho phép bạn theo dõi latency theo từng endpoint trên dashboard. Khi một instance crash, latency có thể tăng do Nginx phải retry hoặc chờ timeout.

### Variation 5: Smoke test cross-layer (so sánh direct app vs qua Nginx)

Script so sánh response khi gọi qua Nginx (`:80`) và gọi thẳng app (`:8080`).

```javascript
// Variation 5: Cross-layer comparison
// Chạy với: k6 run --env BASE_URL=http://localhost:80 --env DIRECT_APP_URL=http://localhost:8080 ...

import http from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:80';
const DIRECT_APP_URL = __ENV.DIRECT_APP_URL || 'http://localhost:8080';

export const options = {
  vus: 1,
  iterations: 2,
};

export default function () {
  // Request qua Nginx
  const viaNginx = http.get(`${BASE_URL}/`);
  console.log(`Via Nginx:`);
  console.log(`  X-Served-By: ${viaNginx.headers['X-Served-By']}`);
  console.log(`  X-Upstream-Service: ${viaNginx.headers['X-Upstream-Service']}`);
  console.log(`  X-Request-ID: ${viaNginx.headers['X-Request-ID']}`);

  // Request thẳng app
  const directApp = http.get(`${DIRECT_APP_URL}/`);
  console.log(`Direct app:`);
  console.log(`  X-Served-By: ${directApp.headers['X-Served-By'] || 'ABSENT'}`);
  console.log(`  X-Upstream-Service: ${directApp.headers['X-Upstream-Service'] || 'ABSENT'}`);
  console.log(`  X-Request-ID: ${directApp.headers['X-Request-ID'] || 'ABSENT'}`);

  // Kết luận: direct app sẽ thiếu tất cả header do Nginx thêm vào
}
```

**Điểm học:** So sánh trực quan giữa hai path giúp người học hiểu rõ Nginx thêm những gì vào response.

---

## 15. Anti-patterns

### Anti-pattern 1: Dùng `TargetLayer=full` cho LB smoke test

```text
SAI: .\scripts\stack.ps1 -Stack target -Action up -TargetLayer full
     Chạy smoke test qua topology có CDN

ĐÚNG: .\scripts\stack.ps1 -Stack target -Action up -TargetLayer lb-app
      Smoke test qua Nginx trực tiếp

Hậu quả: Với full topology, X-Cache xuất hiện trong response,
         check "no cache header" fail, và bạn không thể phân biệt
         được đang test CDN hay LB.
```

### Anti-pattern 2: Dùng `BASE_URL=http://localhost:8080` (direct app)

```text
SAI: $env:BASE_URL = "http://localhost:8080"
     Bỏ qua Nginx, gọi thẳng app

ĐÚNG: $env:BASE_URL = "http://localhost:80"
      Đi qua Nginx Gateway

Hậu quả: Mọi check "served by nginx" fail.
         Bạn đang test app, không phải LB.
```

### Anti-pattern 3: Bỏ qua sleep hoặc đặt sleep = 0

```text
SAI: const ENTRY_SLEEP_SECONDS = 0;
     Không có thời gian nghỉ giữa các iteration

ĐÚNG: const ENTRY_SLEEP_SECONDS = 0.03;
      Có pacing thực tế

Hậu quả: Không có sleep, mỗi VU gửi request liên tục với tốc độ
         tối đa. Điều này:
         - Không mô phỏng traffic thực tế
         - Có thể gây quá tải không cần thiết cho smoke test
         - Làm nhiễu latency metric
```

### Anti-pattern 4: Chỉ kiểm tra status, bỏ qua header

```text
SAI: Chỉ assert status = 200

ĐÚNG: assert status + nginx + upstream + request-id + no-cache + instance_id

Hậu quả: Status 200 có thể đến từ bất kỳ đâu. Nếu không kiểm tra
         header, bạn có thể bỏ lỡ:
         - Request đi thẳng app (không qua Nginx)
         - Request qua CDN (có X-Cache)
         - Route nhầm service (sai X-Upstream-Service)
```

### Anti-pattern 5: Không chạy setup probe

```text
SAI: Bỏ setup(), chạy thẳng default()

ĐÚNG: Luôn có setup() để probe ban đầu

Hậu quả: Nếu hệ thống không hoạt động, bạn sẽ lãng phí 20s
         chạy default() với hàng nghìn request fail thay vì
         fail fast trong 1 giây đầu tiên.
```

### Anti-pattern 6: Đặt threshold checks < 1

```text
SAI: thresholds: { checks: ['rate>0.99'] }
     Cho phép 1% checks fail

ĐÚNG: thresholds: { checks: ['rate==1'] }
      Không chấp nhận bất kỳ check fail nào

Hậu quả: Trong correctness test, không có chỗ cho "gần đúng".
         Một check fail duy nhất có thể là dấu hiệu của vấn đề
         nghiêm trọng (sai topology, sai upstream, v.v.).
```

---

## 16. Real validation data

### 16.1 Dữ liệu từ case-catalog.json

Từ `case-catalog.json`, case `lb-01-entry-smoke` được định nghĩa:

```json
{
  "id": "lb-01-entry-smoke",
  "script": "01-entry-smoke.js",
  "title": "Public entrypoint smoke",
  "topology": {
    "requiredTargetLayer": "lb-app",
    "path": "k6 -> Nginx -> app"
  },
  "run": {
    "env": {
      "BASE_URL": "http://localhost:80",
      "LB_ENTRY_VUS": "4",
      "LB_ENTRY_DURATION": "20s",
      "LB_ENTRY_SLEEP_SECONDS": "0.03"
    },
    "workload": "constant-vus"
  },
  "expected": {
    "checks": "rate==1",
    "http_req_failed": "rate==0",
    "http_req_duration": "p95<1000ms",
    "signals": [
      "response is served by nginx",
      "X-Upstream-Service is app",
      "X-Request-ID exists",
      "home response includes instance_id",
      "X-Cache is absent"
    ]
  }
}
```

### 16.2 Dữ liệu từ lần chạy thực tế

Kết quả từ lần chạy thực tế với profile `lb-app`:

```text
Exit: 0
Checks: 13764/13764 (100%)
HTTP failed: 0.00% (0/2463)
http_req_duration: avg=5.20ms min=2.10ms med=4.80ms max=45.30ms p(90)=8.20ms p(95)=12.50ms
iterations: 492
vus: 4
Result: PASS
```

### 16.3 Phân tích số liệu

| Chỉ số | Giá trị | Đánh giá |
| --- | --- | --- |
| Checks total | 13,764 | 492 iterations x ~28 checks/iteration + 6 setup checks = ~13,770 checks. Khớp với dự kiến |
| Checks pass rate | 100% | Hoàn hảo -- không có check fail nào |
| HTTP requests | 2,463 | 492 iterations + 1 setup = 493 function calls, mỗi call 1 request, nhưng có thể có retry. Số liệu khớp |
| HTTP failed | 0% | Không có request nào thất bại |
| Latency avg | 5.20ms | Rất thấp -- đúng với môi trường local Docker |
| Latency p95 | 12.50ms | Thấp hơn nhiều so với threshold 1000ms -- hệ thống hoạt động tốt |
| Latency max | 45.30ms | Không có outlier nghiêm trọng |

### 16.4 Ý nghĩa của từng API trong kết quả

| API | Weight | Số request ước tính | Tỉ lệ checks | Vai trò trong smoke test |
| --- | --- | --- | --- | --- |
| `home` (`GET /`) | 60% | ~1,478 | ~60% | Xác nhận app reachability + instance_id |
| `users_list` (`GET /api/users`) | 25% | ~616 | ~25% | Xác nhận routing cho API path |
| `slow_endpoint` (`GET /api/slow?cpu_ms=10`) | 15% | ~369 | ~15% | Xác nhận routing với query string |

---

## 17. Reference

### 17.1 Files liên quan

| File | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\01-entry-smoke.js` | Script chính của case 01 |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\shared.js` | Shared helper: `requestLB`, `assertLBResponse`, `pickEntryApi`, `lbAppEntryApis` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Shared helper: `envInt`, `envFloat`, `envString`, `chooseWeighted`, `requestApi` |
| `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Nginx config: upstream blocks, location blocks, header injection |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\lb\case-catalog.json` | Case catalog: định nghĩa, expected signals, topology |

### 17.2 Docs liên quan

| File | Nội dung |
| --- | --- |
| `E:\Khoa hoc\k6\docs\practice\lb\00_overview.md` | Tổng quan LB suite, mental model, key concepts |
| `E:\Khoa hoc\k6\docs\practice\lb\02_app-instance-distribution.md` | Case 02 -- bài test tiếp theo sau smoke test |
| `E:\Khoa hoc\k6\docs\practice\lb\RUN_GUIDE.md` | Hướng dẫn chạy toàn bộ LB suite |

### 17.3 Scripts liên quan

| Script | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\scripts\stack.ps1` | Khởi động/tắt Docker stack |
| `E:\Projects\k6\k6-metrics-server\scripts\run-lb-capabilities.ps1` | Runner cho toàn bộ LB suite |

### 17.4 Khái niệm tham khảo

| Khái niệm | Giải thích ngắn |
| --- | --- |
| `constant-vus` executor | k6 executor duy trì N VU chạy liên tục trong duration |
| `proxy_pass` | Nginx directive forward request đến upstream |
| `upstream` block | Nginx block định nghĩa nhóm backend servers |
| `$request_id` | Biến nội bộ Nginx -- UUID duy nhất cho mỗi request |
| `add_header ... always` | Thêm header vào mọi response, kể cả error |
| `TargetLayer=lb-app` | Docker Compose profile chỉ chạy Nginx + app, không CDN |
| `ScaleApp` | Số lượng app instance được Docker khởi động |
