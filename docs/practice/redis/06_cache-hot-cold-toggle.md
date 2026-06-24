# redis-06 -- Application cache hot/cold toggle

> **Case ID:** `redis-06-cache-hot-cold-toggle`
> **Script:** `31-cache-hot-cold-toggle.js`
> **Profile:** `full-no-cdn`
> **Executor:** `constant-vus` (1 scenario, 2 phase tuần tự)
> **Proof:** Hot repeated key sinh HIT, cold unique keys sinh MISS -- app cache tạo khác biệt thật

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [Redis/app cache capability được chứng minh](#2-redisapp-cache-capability-được-chứng-minh)
3. [Vì sao phải test ở Redis/shared state layer](#3-vì-sao-phải-test-ở-redisshared-state-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Redis/app cache mechanism deep-dive](#6-redisapp-cache-mechanism-deep-dive)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / counters](#8-key-signals--counters)
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

Một endpoint cache trong ứng dụng phục vụ hai chế độ traffic hoàn toàn khác nhau trong cùng một phiên chạy. Ở chế độ thứ nhất ("hot phase"), cùng một key được truy vấn lặp đi lặp lại -- giống như trang sản phẩm best-seller được hàng trăm người dùng xem đồng thời. Ở chế độ thứ hai ("cold phase"), mỗi request dùng một key hoàn toàn mới, chưa từng được cache -- giống như người dùng tìm kiếm các sản phẩm ngách (long-tail) mà chưa ai từng xem trước đó.

```text
hot phase: repeated same key -> expected HIT
cold phase: unique keys -> expected MISS
```

Case này không test CDN/Varnish. Nó test app/Redis-style cache phía origin.

### 1.2 Tại sao cần chứng minh cả HIT và MISS

Nhiều benchmark về cache mắc một sai lầm nghiêm trọng: họ chạy traffic mà không biết traffic đó đang là hot cache hay cold cache. Kết quả latency/RPS bị đọc sai:

```text
Không có toggle proof:    Benchmark thấy latency 5ms → "Cache nhanh quá!"
                          Nhưng thực ra 100% request là HIT → không đại diện cho thực tế

Có toggle proof đúng:     Hot phase: latency 2ms (HIT) → chứng minh cache hiệu quả
                          Cold phase: latency 25ms (MISS) → chứng minh cache miss path
                          → Biết chính xác cache đang hoạt động
```

### 1.3 Ba câu hỏi mà case này trả lời

Case 06 được thiết kế để trả lời ba câu hỏi cốt lõi về app cache behavior:

1. **Hot phase có thực sự sinh HIT không?** -- Khi gửi cùng một key lặp lại 12 giây liên tục, cache status có thực sự là `HIT` sau warmup không?
2. **Cold phase có thực sự sinh MISS không?** -- Khi gửi các key unique trong 12 giây tiếp theo, cache status có thực sự là `MISS` không?
3. **Latency hot/cold có khác biệt không?** -- Hot HIT path có thực sự nhanh hơn cold MISS path không?

### 1.4 Ứng dụng trong production

Case này dạy một bài học quan trọng cho mọi kỹ sư performance:

```text
Trước khi benchmark bất kỳ hệ thống nào có cache:
  1. Xác định traffic đang là hot (repeated) hay cold (unique)
  2. Chứng minh cache đang hoạt động bằng HIT/MISS counters
  3. So sánh latency giữa HIT và MISS để hiểu cache impact
  4. Đừng bao giờ kết luận về hiệu năng nếu không biết cache mode

Nếu bỏ qua bước này, mọi kết luận về latency/RPS đều không đáng tin cậy.
```

---

## 2. Redis/app cache capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh:

> **App cache (Redis-style) tạo ra khác biệt HIT/MISS thật: hot repeated key được warm và trả HIT, cold unique keys trả MISS.**

Cụ thể hơn, case này chứng minh năm sub-capabilities:

```text
1. Warmup hoạt động:     Gọi cùng key 2 lần trong setup → lần 2 đã có thể HIT
2. Hot phase HIT:        Trong 12s hot phase, tất cả request dùng key đã warm → HIT
3. Cold phase MISS:      Trong 12s cold phase, tất cả request dùng key mới → MISS
4. Latency khác biệt:    Hot HIT latency thấp hơn cold MISS latency
5. Header/cache signal:  X-Cache-Status hoặc X-Cache phản ánh đúng cache mode
```

### 2.2 Hai sub-proofs chính

| Sub-proof | Phase | Duration | Key dùng | Expected cache status | Expected counter | Mục đích |
| --- | --- | --- | --- | --- | --- | --- |
| Hot cache proof | `hot` (0s - 12s) | 12 giây | `cache-hot-{runId}` (cố định) | `HIT` | `cache_hot_hits > 0` | Chứng minh repeated key được cache và trả HIT |
| Cold cache proof | `cold` (12s - 24s) | 12 giây | `cache-cold-{runId}-{VU}-{ITER}` (unique) | `MISS` | `cache_cold_misses > 0` | Chứng minh unique keys không có trong cache và trả MISS |

### 2.3 Tại sao capability này quan trọng

Không có cache behavior proof, mọi benchmark về hiệu năng đều vô nghĩa:

```text
Không có toggle proof:    Chạy benchmark → latency trung bình 5ms
                          → Không biết 5ms là HIT hay MISS
                          → Nếu 100% HIT: đây là best-case, không đại diện
                          → Nếu 100% MISS: cache không hoạt động!

Có toggle proof đúng:     Hot phase: latency 2ms (HIT) → cache hiệu quả
                          Cold phase: latency 25ms (MISS) → cache miss path
                          → Biết chính xác cache đang hoạt động và impact của nó
```

---

## 3. Vì sao phải test ở Redis/shared state layer

### 3.1 App cache khác CDN cache

Đây là điểm dễ gây nhầm lẫn nhất. App cache (Redis-style) và CDN cache (Varnish-style) là hai tầng hoàn toàn khác nhau:

```text
CDN cache (Varnish):
  Client → Varnish (edge) → Nginx → App → Redis
           ↑
           Cache ở ĐÂY -- trước Nginx, trước App
           HIT ở Varnish → request không đến App

App cache (Redis):
  Client → Nginx → App → Redis
                        ↑
                        Cache ở ĐÂY -- trong App, dùng Redis
                        HIT ở App → App đọc Redis, không query DB
```

### 3.2 Không thể test app cache ở tầng CDN

Nếu dùng `TargetLayer=full` (có CDN):

```text
Test sai:    CDN cache response đầu tiên → 119 request sau được CDN trả về
             → Request không đến App → App cache không được test

Test đúng:   TargetLayer=full-no-cdn → mọi request đều đến App
             → App cache được test trực tiếp
```

### 3.3 Signal từ X-Cache-Status là evidence

App cache trả về cache status qua HTTP response header. Script đọc header này để phân loại HIT/MISS:

```text
X-Cache-Status: HIT   → App cache có key này → trả về từ Redis
X-Cache-Status: MISS  → App cache không có key này → query nguồn dữ liệu
X-Cache: HIT          → (alternative header name)
X-Cache: MISS         → (alternative header name)
```

Không có header này, không thể phân biệt được request được phục vụ từ cache hay từ nguồn dữ liệu gốc.

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌──────────────────────────────────┐
                          │     k6 test script                │
                          │  (31-cache-hot-cold-toggle.js)    │
                          └──────────────┬───────────────────┘
                                         │
                         1 scenario: toggle
                         4 VUs, constant-vus, 24s duration
                         2 phases tuần tự: hot (12s) → cold (12s)
                                         │
                                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx Gateway)                                           │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Nginx LB                                                         │  │
│  │  Route đến app instances                                          │  │
│  └──────────────────────────────┬───────────────────────────────────┘  │
│                                 │                                       │
│                                 ▼                                       │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  App (application service)                                        │  │
│  │  ┌────────────────────────────────────────────────────────────┐  │  │
│  │  │ GET /api/cached?key={key}&ttl_seconds={ttl}                 │  │  │
│  │  │                                                              │  │  │
│  │  │ 1. Kiểm tra Redis: key có trong cache không?                 │  │  │
│  │  │    ├─ CÓ → trả về cached value, X-Cache-Status: HIT         │  │  │
│  │  │    └─ KHÔNG → query nguồn, lưu vào Redis, X-Cache-Status: MISS│  │  │
│  │  │                                                              │  │  │
│  │  │ 2. Cache TTL: {ttl_seconds} (default 120s)                  │  │  │
│  │  └────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────┬───────────────────────────────────┘  │
│                                 │                                       │
│                                 ▼                                       │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Redis (app cache storage)                                        │  │
│  │  ┌────────────────────────────────────────────────────────────┐  │  │
│  │  │ Key: cache:{hotKey}       → Value: cached response          │  │  │
│  │  │ Key: cache:{coldKey}-...  → (không tồn tại, chưa được cache) │  │  │
│  │  │ TTL: 120s                                                 │  │  │
│  │  └────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Data source (simulated)                                          │  │
│  │  Sinh dữ liệu cho cache miss                                      │  │
│  │  Có sleep 0.05s để mô phỏng độ trễ query nguồn                    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `full-no-cdn` (bắt buộc) | `docker ps` thấy Nginx + app + Redis, không thấy Varnish |
| `BASE_URL` | `http://localhost:80` | Biến môi trường được set trước khi chạy |
| App service đang chạy | App instance có endpoint `/api/cached` | `curl "http://localhost:80/api/cached?key=test&ttl_seconds=10"` |
| Redis đang chạy | Redis instance cho app cache | App cache endpoint hoạt động |
| Không có CDN/Varnish | `X-Cache` header từ CDN phải vắng mặt | `curl -sI "http://localhost:80/api/cached?key=test&ttl_seconds=10"` không thấy CDN cache header |

### 4.3 Stack khởi động

```powershell
# Khởi động full stack không có CDN
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
```

### 4.4 Precondition của script

Script sử dụng `setup()` function để warm hot key trước khi vào runtime:

```javascript
export function setup() {
  warmHotKey(HOT_KEY);
  return {
    runId: RUN_ID,
    hotKey: HOT_KEY,
    coldPrefix: COLD_PREFIX,
    startedAtMs: Date.now(),
  };
}
```

**Warmup logic:**

```javascript
function warmHotKey(hotKey) {
  const warmHeaders = cacheHeaders('hot');
  // Gọi 2 lần để đảm bảo key được cache
  http.get(`${BASE_URL}/api/cached?key=${encodeURIComponent(hotKey)}&ttl_seconds=${TTL_SECONDS}`, {
    headers: warmHeaders,
    tags: { phase: 'warmup', cache_state: 'warmup' },
  });
  http.get(`${BASE_URL}/api/cached?key=${encodeURIComponent(hotKey)}&ttl_seconds=${TTL_SECONDS}`, {
    headers: warmHeaders,
    tags: { phase: 'warmup', cache_state: 'warmup' },
  });
}
```

**Tại sao warmup 2 lần?**

- Lần 1: Key chưa có trong cache → App query nguồn + lưu vào Redis → MISS
- Lần 2: Key đã có trong Redis → App đọc từ Redis → HIT
- Sau 2 lần, hot key đã được warm sẵn sàng cho hot phase

Điều này đảm bảo rằng ngay từ giây đầu tiên của hot phase, cache đã sẵn sàng trả HIT.

### 4.5 Tại sao TTL phải đủ lớn

```text
TTL_SECONDS = 120s
Tổng duration = 24s (HOT_DURATION 12s + COLD_DURATION 12s)

120s >> 24s → Hot key không bị expire giữa chừng
→ Tất cả hot phase request đều thấy key trong cache
→ Không có MISS ngoài ý muốn do expire

Nếu TTL = 5s và HOT_DURATION = 12s:
→ Key expire sau 5s → 7s cuối của hot phase nhận MISS
→ Không phân biệt được: MISS do cold key hay do expire?
```

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\app\31-cache-hot-cold-toggle.js
```

### 5.2 Import và dependency

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

import { envFloat, envInt, envString } from '../shared/common.js';
```

Phân tích từng import:

| Import | Nguồn gốc | Vai trò trong script này |
| --- | --- | --- |
| `http` | `k6/http` built-in | Gửi HTTP GET request đến cache endpoint |
| `check` | `k6` built-in | Xác minh status 200 và cache status (HIT/MISS) |
| `sleep` | `k6` built-in | Ngủ `SLEEP_SECONDS` giữa các iteration để tạo khoảng cách |
| `Counter` | `k6/metrics` | Đếm HIT/MISS cho hot và cold phase |
| `Trend` | `k6/metrics` | Đo latency cho hot và cold phase |
| `envFloat` | `../shared/common.js` | Đọc biến môi trường dạng số thực |
| `envInt` | `../shared/common.js` | Đọc biến môi trường dạng số nguyên |
| `envString` | `../shared/common.js` | Đọc biến môi trường dạng chuỗi |

### 5.3 Biến môi trường (env knobs)

```javascript
const BASE_URL = envString('BASE_URL', 'http://localhost:80').replace(/\/$/, '');
const RUN_ID = envString('CACHE_TOGGLE_RUN_ID', `cache-toggle-${Date.now()}`);
const VUS = envInt('CACHE_TOGGLE_VUS', 4);
const HOT_DURATION_SECONDS = envInt('CACHE_TOGGLE_HOT_DURATION_SECONDS', 12);
const COLD_DURATION_SECONDS = envInt('CACHE_TOGGLE_COLD_DURATION_SECONDS', 12);
const TTL_SECONDS = envInt('CACHE_TOGGLE_TTL_SECONDS', 120);
const HOT_KEY = envString('CACHE_TOGGLE_HOT_KEY', `cache-hot-${RUN_ID}`);
const COLD_PREFIX = envString('CACHE_TOGGLE_COLD_PREFIX', `cache-cold-${RUN_ID}`);
const SLEEP_SECONDS = envFloat('CACHE_TOGGLE_SLEEP_SECONDS', 0.05);
```

Bảng phân tích từng biến:

| Biến | Default | Ý nghĩa | Vai trò trong toggle test |
| --- | --- | --- | --- |
| `VUS` | `4` | Số VU chạy đồng thời | 4 VU tạo sustained traffic cho cả 2 phase |
| `HOT_DURATION_SECONDS` | `12` | Thời gian chạy hot phase (giây) | 12 giây đủ để quan sát HIT pattern ổn định |
| `COLD_DURATION_SECONDS` | `12` | Thời gian chạy cold phase (giây) | 12 giây đủ để quan sát MISS pattern ổn định |
| `TTL_SECONDS` | `120` | Cache TTL cho key (giây) | 120s >> 24s → hot key không expire giữa chừng |
| `HOT_KEY` | `cache-hot-{RUN_ID}` | Key cố định cho hot phase | Tất cả VU dùng cùng key này trong 12s đầu |
| `COLD_PREFIX` | `cache-cold-{RUN_ID}` | Prefix cho cold keys | Mỗi request tạo key unique: `{prefix}-{VU}-{ITER}` |
| `SLEEP_SECONDS` | `0.05` | Thời gian ngủ giữa các iteration (giây) | 50ms sleep tạo gap giữa các request, tránh flood |
| `RUN_ID` | `cache-toggle-{Date.now()}` | ID duy nhất cho lần chạy | Đảm bảo key không trùng giữa các lần chạy |

### 5.4 Custom metrics

```javascript
const cacheHotHits = new Counter('cache_hot_hits');
const cacheHotMisses = new Counter('cache_hot_misses');
const cacheColdHits = new Counter('cache_cold_hits');
const cacheColdMisses = new Counter('cache_cold_misses');
const cacheHotLatency = new Trend('cache_hot_latency_ms', true);
const cacheColdLatency = new Trend('cache_cold_latency_ms', true);
const cacheToggleFailures = new Counter('cache_toggle_failures');
```

| Metric | Loại | Ý nghĩa | Cách đọc |
| --- | --- | --- | --- |
| `cache_hot_hits` | Counter | Số request hot phase có cache HIT | `> 0` → cache hoạt động cho hot key |
| `cache_hot_misses` | Counter | Số request hot phase có cache MISS | Nên là `0` hoặc rất nhỏ sau warmup |
| `cache_cold_hits` | Counter | Số request cold phase có cache HIT | Nên là `0` -- cold keys chưa được cache |
| `cache_cold_misses` | Counter | Số request cold phase có cache MISS | `> 0` → cold keys đúng là MISS |
| `cache_hot_latency_ms` | Trend | Thời gian response cho hot phase (ms) | Thường thấp hơn cold (HIT nhanh hơn MISS) |
| `cache_cold_latency_ms` | Trend | Thời gian response cho cold phase (ms) | Thường cao hơn hot (MISS chậm hơn HIT) |
| `cache_toggle_failures` | Counter | Số lần check thất bại | `== 0` → không có lỗi |

### 5.5 options block

```javascript
export const options = {
  noConnectionReuse: true,
  scenarios: {
    toggle: {
      executor: 'constant-vus',
      vus: VUS,
      duration: `${HOT_DURATION_SECONDS + COLD_DURATION_SECONDS}s`,
      gracefulStop: '2s',
      tags: { scenario: 'cache_hot_cold_toggle', target_service: 'app' },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    cache_toggle_failures: ['count==0'],
    http_req_failed: ['rate==0'],
  },
};
```

#### Vì sao dùng constant-vus?

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **constant-vus** (đang dùng) | DUNG | 4 VU chạy liên tục 24s, mỗi VU tự phát hiện phase dựa trên elapsed time. Tạo sustained traffic cho cả 2 phase. |
| per-vu-iterations | SAI | Không có khái niệm "thời gian" -- không thể tự động chuyển phase sau 12s. |
| constant-arrival-rate | THỪA | Không cần ép rate. Chỉ cần sustained traffic đều đặn. |
| ramping-vus | SAI | Không cần ramp. |

**Key insight:** Case này dùng 1 scenario duy nhất với `constant-vus`. Việc chuyển từ hot sang cold được thực hiện bằng cách đọc thời gian đã trôi qua (`elapsedSeconds`) trong `default()` function -- không phải bằng 2 scenarios riêng biệt. Đây là pattern "temporal phase detection" -- rất khác với redis-05 dùng 2 scenarios song song.

#### Thresholds

| Threshold | Điều kiện | Ý nghĩa |
| --- | --- | --- |
| `checks` | `rate==1` | 100% checks phải pass |
| `cache_toggle_failures` | `count==0` | Không có check failure nào |
| `http_req_failed` | `rate==0` | Không có request thất bại |

**Lưu ý:** Không có threshold cho `cache_hot_hits` hay `cache_cold_misses` trong `thresholds`. Những counters này được kiểm tra trong `handleSummary()` và qua checks trong `default()`.

### 5.6 Các helper functions

#### cacheHeaders()

```javascript
function cacheHeaders(phase) {
  return {
    'Cache-Control': phase === 'hot' ? 'max-age=0' : 'no-cache',
    Pragma: 'no-cache',
    'X-Test-Run-ID': RUN_ID,
    'X-Test-Scenario': 'cache_hot_cold_toggle',
  };
}
```

Hàm này tạo HTTP headers cho mỗi request. Điểm quan trọng:

| Header | Hot phase value | Cold phase value | Ý nghĩa |
| --- | --- | --- | --- |
| `Cache-Control` | `max-age=0` | `no-cache` | Yêu cầu cache validation (hot) hoặc bỏ qua cache hoàn toàn (cold) |
| `Pragma` | `no-cache` | `no-cache` | HTTP/1.0 backward compatibility |
| `X-Test-Run-ID` | `RUN_ID` | `RUN_ID` | Định danh lần chạy để debug |
| `X-Test-Scenario` | `cache_hot_cold_toggle` | `cache_hot_cold_toggle` | Định danh scenario cho dashboard |

**Tại sao `max-age=0` cho hot thay vì không gửi Cache-Control?**

`max-age=0` yêu cầu cache validation (revalidate) nhưng vẫn cho phép trả về cached content nếu server xác nhận cache còn valid. Điều này cho phép app cache hoạt động bình thường trong hot phase.

`no-cache` cho cold phase mạnh hơn -- nó yêu cầu bỏ qua cache hoàn toàn và luôn lấy từ nguồn. Điều này đảm bảo cold keys thực sự MISS.

#### phase()

```javascript
function phase(elapsedSeconds) {
  if (elapsedSeconds < HOT_DURATION_SECONDS) {
    return 'hot';
  }
  return 'cold';
}
```

Hàm này xác định phase hiện tại dựa trên thời gian đã trôi qua. Đây là trái tim của "temporal phase detection":

```text
elapsedSeconds = (Date.now() - data.startedAtMs) / 1000;

0s  ─────────── 12s ─────────── 24s
│   HOT phase    │   COLD phase   │
│   hotKey       │   coldKey-...  │
│   expect HIT   │   expect MISS  │
```

#### cacheUrlForPhase()

```javascript
function cacheUrlForPhase(currentPhase, data) {
  if (currentPhase === 'hot') {
    return `${BASE_URL}/api/cached?key=${encodeURIComponent(data.hotKey)}&ttl_seconds=${TTL_SECONDS}`;
  }
  const coldKey = `${data.coldPrefix}-${__VU}-${__ITER}`;
  return `${BASE_URL}/api/cached?key=${encodeURIComponent(coldKey)}&ttl_seconds=${TTL_SECONDS}`;
}
```

Đây là hàm tạo URL cho cache endpoint. Sự khác biệt giữa hot và cold:

| Thành phần | Hot phase | Cold phase |
| --- | --- | --- |
| `key` | `data.hotKey` (cố định -- `cache-hot-{RUN_ID}`) | `{coldPrefix}-{__VU}-{__ITER}` (unique) |
| `ttl_seconds` | `120` | `120` |
| URL mẫu | `/api/cached?key=cache-hot-abc123&ttl_seconds=120` | `/api/cached?key=cache-cold-abc123-3-42&ttl_seconds=120` |

**Tại sao cold key dùng `{__VU}-{__ITER}`?**

- `__VU`: Số thứ tự VU (1 đến 4) -- mỗi VU có namespace riêng
- `__ITER`: Số thứ tự iteration trong VU đó (tăng dần theo thời gian)
- Kết hợp: `cache-cold-{RUN_ID}-3-42` -- đảm bảo unique tuyệt đối cho mỗi request

### 5.7 default() -- logic chính

```javascript
export default function (data) {
  const elapsedSeconds = (Date.now() - data.startedAtMs) / 1000;
  const currentPhase = phase(elapsedSeconds);
  const url = cacheUrlForPhase(currentPhase, data);
  const res = http.get(url, {
    headers: cacheHeaders(currentPhase),
    tags: {
      scenario: 'cache_hot_cold_toggle',
      phase: currentPhase,
      cache_state: currentPhase,
      target_service: 'app',
    },
  });

  const cacheStatus = headerValue(res.headers, 'X-Cache-Status') || headerValue(res.headers, 'X-Cache');
  const expectedStatus = currentPhase === 'hot' ? 'HIT' : 'MISS';
  const isExpected = cacheStatus.toUpperCase().includes(expectedStatus);

  if (currentPhase === 'hot') {
    cacheHotLatency.add(res.timings.duration, { phase: currentPhase });
    if (isExpected) {
      cacheHotHits.add(1, { phase: currentPhase });
    } else {
      cacheHotMisses.add(1, { phase: currentPhase, cache_status: cacheStatus || 'NONE' });
    }
  } else {
    cacheColdLatency.add(res.timings.duration, { phase: currentPhase });
    if (isExpected) {
      cacheColdMisses.add(1, { phase: currentPhase });
    } else {
      cacheColdHits.add(1, { phase: currentPhase, cache_status: cacheStatus || 'NONE' });
    }
  }

  check({ res, cacheStatus }, {
    [`${currentPhase} status 200`]: (x) => x.res.status === 200,
    [`${currentPhase} cache ${expectedStatus}`]: (x) => (x.cacheStatus || '').toUpperCase().includes(expectedStatus),
  }) || cacheToggleFailures.add(1, { phase: currentPhase });

  sleep(SLEEP_SECONDS);
}
```

**Phân tích từng bước:**

1. **Tính elapsed time**: `(Date.now() - startedAtMs) / 1000` -- thời gian đã trôi qua từ khi bắt đầu
2. **Xác định phase**: `phase(elapsedSeconds)` -- hot (< 12s) hoặc cold (>= 12s)
3. **Tạo URL**: `cacheUrlForPhase(currentPhase, data)` -- URL với key phù hợp
4. **Gửi HTTP GET**: Với headers phù hợp phase và tags để filter trên dashboard
5. **Đọc cache status**: Từ `X-Cache-Status` hoặc `X-Cache` header
6. **Phân loại kết quả**: HIT hay MISS? Đúng như expected không?
7. **Ghi nhận metrics**: HIT/MISS counters + latency trend
8. **Check pass/fail**: Status 200 + cache status khớp expected
9. **Sleep**: `SLEEP_SECONDS` (50ms) để tạo gap giữa các request

### 5.8 handleSummary() -- tổng kết

```javascript
export function handleSummary(data) {
  const hotHits = data.metrics.cache_hot_hits ? data.metrics.cache_hot_hits.values.count : 0;
  const hotMisses = data.metrics.cache_hot_misses ? data.metrics.cache_hot_misses.values.count : 0;
  const coldHits = data.metrics.cache_cold_hits ? data.metrics.cache_cold_hits.values.count : 0;
  const coldMisses = data.metrics.cache_cold_misses ? data.metrics.cache_cold_misses.values.count : 0;

  console.log('\n=== CACHE HOT/COLD TOGGLE ===');
  console.log(`Hot hits:   ${hotHits}`);
  console.log(`Hot misses: ${hotMisses}`);
  console.log(`Cold hits:  ${coldHits}`);
  console.log(`Cold misses:${coldMisses}`);
  return {};
}
```

Hàm này in ra bảng tổng kết sau khi script hoàn thành, giúp người đọc nhanh chóng thấy kết quả toggle.

### 5.9 Sơ đồ tổ chức toàn bộ script

```text
┌─ Import: http (k6/http), check + sleep (k6), Counter + Trend (k6/metrics),
│          envFloat + envInt + envString (../shared/common.js)
│
├─ Env vars (9 biến): VUS=4, HOT_DURATION_SECONDS=12, COLD_DURATION_SECONDS=12,
│   TTL_SECONDS=120, SLEEP_SECONDS=0.05, RUN_ID, HOT_KEY, COLD_PREFIX, BASE_URL
│
├─ Custom metrics (7 counters/trends):
│   cacheHotHits, cacheHotMisses, cacheColdHits, cacheColdMisses,
│   cacheHotLatency, cacheColdLatency, cacheToggleFailures
│
├─ options
│   ├─ noConnectionReuse: true
│   ├─ scenarios:
│   │   └─ toggle: constant-vus, 4 VU, 24s duration
│   └─ thresholds: checks rate==1, cache_toggle_failures count==0, http_req_failed rate==0
│
├─ setup()
│   ├─ warmHotKey(HOT_KEY) → gọi 2 lần GET với hot key để warm cache
│   └─ return { runId, hotKey, coldPrefix, startedAtMs }
│
├─ Helper functions:
│   ├─ cacheHeaders(phase) → HTTP headers (Cache-Control, X-Test-Scenario, ...)
│   ├─ phase(elapsedSeconds) → 'hot' | 'cold'
│   ├─ headerValue(headers, name) → case-insensitive header lookup
│   └─ cacheUrlForPhase(currentPhase, data) → URL với key phù hợp
│
├─ default(data) ← 1 scenario cho cả 2 phase
│   ├─ Tính elapsedSeconds, xác định currentPhase
│   ├─ Tạo URL với key hot (cố định) hoặc cold (unique)
│   ├─ GET /api/cached?key=...&ttl_seconds=...
│   ├─ Đọc cache status từ response header
│   ├─ Phân loại HIT/MISS, ghi nhận counters + latency
│   ├─ check: status 200 + cache status khớp expected
│   └─ sleep(SLEEP_SECONDS)
│
└─ handleSummary(data)
    └─ In bảng tổng kết: Hot hits/misses, Cold hits/misses
```

---

## 6. Redis/app cache mechanism deep-dive

### 6.1 Kiến trúc app cache với Redis

App cache dùng Redis làm storage cho cached data. Khác với CDN cache (lưu trên edge), app cache nằm sâu trong hệ thống:

| Tầng cache | Vị trí | Storage | Cách hoạt động |
| --- | --- | --- | --- |
| CDN cache (Varnish) | Edge, trước Nginx | In-memory (Varnish) | Request không đến App nếu HIT |
| App cache (Redis) | Sau Nginx, trong App | Redis | App tự check Redis trước khi query DB |
| DB cache (Postgres) | Trong DB | Shared buffers | DB tự cache query results |

App cache hoạt động theo mô hình cache-aside (look-aside):

```text
1. App nhận request GET /api/cached?key=xxx
2. App check Redis: EXISTS cache:xxx?
   ├─ CÓ → đọc value từ Redis → trả về → X-Cache-Status: HIT
   └─ KHÔNG → query nguồn dữ liệu → lưu vào Redis → trả về → X-Cache-Status: MISS
3. Redis key có TTL (120s) → tự động hết hạn
```

### 6.2 Cách hot phase sinh HIT

```text
Setup (warmup):
  Lần 1: GET /api/cached?key=cache-hot-abc123&ttl_seconds=120
         → Redis: key chưa tồn tại → query nguồn → SET cache:cache-hot-abc123 = value, TTL=120s
         → X-Cache-Status: MISS
  Lần 2: GET /api/cached?key=cache-hot-abc123&ttl_seconds=120
         → Redis: key đã tồn tại → GET cache:cache-hot-abc123 → trả về value
         → X-Cache-Status: HIT

Hot phase (0s - 12s):
  Mỗi request: GET /api/cached?key=cache-hot-abc123&ttl_seconds=120
  → Redis: key đã tồn tại (được warm từ setup)
  → GET cache:cache-hot-abc123 → HIT
  → TTL vẫn còn (>108s) → key không expire

Kết quả: Tất cả hot phase request đều HIT
```

### 6.3 Cách cold phase sinh MISS

```text
Cold phase (12s - 24s):
  VU-1, iter-1: GET /api/cached?key=cache-cold-abc123-1-1&ttl_seconds=120
                → Redis: key chưa tồn tại → query nguồn → SET (nhưng key này chỉ dùng 1 lần)
                → X-Cache-Status: MISS
  VU-1, iter-2: GET /api/cached?key=cache-cold-abc123-1-2&ttl_seconds=120
                → Redis: key mới, chưa tồn tại → MISS
  VU-2, iter-1: GET /api/cached?key=cache-cold-abc123-2-1&ttl_seconds=120
                → Redis: key mới, chưa tồn tại → MISS
  ...

Kết quả: Tất cả cold phase request đều MISS (vì key luôn mới)
```

### 6.4 Tại sao cold phase không vô tình có HIT

Có 3 lý do khiến cold phase không bao giờ có HIT:

1. **Key unique tuyệt đối**: `{coldPrefix}-{__VU}-{__ITER}` -- mỗi request một key khác nhau
2. **RUN_ID mới mỗi lần chạy**: `cache-cold-{Date.now()}-...` -- không trùng với lần chạy trước
3. **TTL có hạn**: Dù key có được SET trong cold phase, nó sẽ expire sau 120s -- không ảnh hưởng lần chạy sau

### 6.5 So sánh hot latency vs cold latency

```text
Hot HIT path:
  1. HTTP request → App (~1ms)
  2. App check Redis → GET cache:key (~1ms)
  3. Redis trả về cached value (~1ms)
  4. App trả về response (~1ms)
  Total: ~4-5ms

Cold MISS path:
  1. HTTP request → App (~1ms)
  2. App check Redis → GET cache:key → MISS (~1ms)
  3. App query nguồn dữ liệu (~20-50ms -- mô phỏng bởi SLEEP_SECONDS=0.05s)
  4. App SET Redis cache:key = value (~1ms)
  5. App trả về response (~1ms)
  Total: ~25-55ms

Hot latency thấp hơn cold latency: chứng minh cache có tác dụng thật sự.
```

### 6.6 Cache validation flow (Cache-Control: max-age=0)

Khi dùng `Cache-Control: max-age=0` cho hot phase:

```text
Client gửi: GET /api/cached?key=xxx
            Cache-Control: max-age=0  (yêu cầu revalidate)

App xử lý:
  1. Check Redis: key có trong cache không?
  2. CÓ → kiểm tra TTL: còn hạn không?
     → Còn hạn → trả về cached value + X-Cache-Status: HIT
     → Hết hạn → query nguồn + update cache → X-Cache-Status: MISS
  3. KHÔNG → query nguồn + SET cache → X-Cache-Status: MISS

Với max-age=0, app cache vẫn có thể trả HIT nếu cache còn valid.
Với no-cache (cold phase), app cache bỏ qua cache, luôn query nguồn → MISS.
```

---

## 7. Request sequence flow

### 7.1 Timeline tổng thể

```text
Thời gian
-2s             0s              12s                         24s
│               │               │                           │
├───────────────┼───────────────┼───────────────────────────┤
│               │               │                           │
│ setup()       │ HOT PHASE     │ COLD PHASE                │
│ warmup        │               │                           │
│               │               │                           │
│ Gọi hot key   │ 4 VUs liên    │ 4 VUs liên tục gửi       │
│ 2 lần:        │ tục gửi       │ request với key unique    │
│ Lần 1: MISS   │ request với   │                           │
│ Lần 2: HIT    │ key cố định   │ key = cache-cold-{RUN_ID} │
│               │               │   -{VU}-{ITER}            │
│               │ key =         │                           │
│               │ cache-hot-    │ Mỗi request một key mới   │
│               │ {RUN_ID}      │ → expect MISS             │
│               │               │                           │
│               │ expect HIT    │ cacheColdMisses++         │
│               │               │ cold latency ~25-55ms     │
│               │ cacheHotHits++│                           │
│               │ hot latency   │                           │
│               │ ~4-5ms        │                           │
│               │               │                           │
└───────────────┴───────────────┴───────────────────────────┘
                                                  │
                                            handleSummary():
                                            In bảng tổng kết
                                            Hot hits, Hot misses
                                            Cold hits, Cold misses
```

### 7.2 Timeline chi tiết cho hot phase

```text
0s: Bắt đầu hot phase. 4 VU bắt đầu gửi request.
│
├─ VU-1, iter-1:
│  ├─ 0ms:    Tính elapsedSeconds = 0.0 → phase = 'hot'
│  │          URL = /api/cached?key=cache-hot-abc123&ttl_seconds=120
│  │          Headers: Cache-Control: max-age=0, X-Test-Scenario: cache_hot_cold_toggle
│  │
│  ├─ ~1ms:   Nginx route đến app instance
│  ├─ ~2ms:   App check Redis: key cache-hot-abc123 tồn tại → GET value → HIT
│  ├─ ~3ms:   Trả về 200 OK, X-Cache-Status: HIT
│  └─ ~3ms:   cacheHotHits++ (1), cacheHotLatency.add(3ms)
│             sleep(50ms)
│
├─ VU-1, iter-2:
│  ├─ ~53ms:  Tính elapsedSeconds = 0.053 → phase = 'hot'
│  │          URL = /api/cached?key=cache-hot-abc123&ttl_seconds=120  (CÙNG KEY)
│  ├─ ~56ms:  HIT → cacheHotHits++ (2)
│  └─ sleep(50ms)
│
├─ VU-2, VU-3, VU-4: Tương tự, tất cả dùng cùng key → tất cả HIT
│
├─ ... Tiếp tục trong 12 giây ...
│
└─ 12s: Kết thúc hot phase.
   cacheHotHits: hàng trăm (tất cả request hot phase)
   cacheHotMisses: 0 (hoặc rất ít nếu có request đầu tiên chưa kịp warm)
```

### 7.3 Timeline chi tiết cho cold phase

```text
12s: Bắt đầu cold phase. 4 VU tiếp tục gửi request (không gián đoạn).
│
├─ VU-1, iter-N:
│  ├─ 12000ms: Tính elapsedSeconds = 12.0 → phase = 'cold'
│  │           URL = /api/cached?key=cache-cold-abc123-1-245&ttl_seconds=120
│  │           Headers: Cache-Control: no-cache, X-Test-Scenario: cache_hot_cold_toggle
│  │
│  ├─ ~12001ms: Nginx route đến app instance
│  ├─ ~12002ms: App check Redis: key cache-cold-abc123-1-245 KHÔNG tồn tại → MISS
│  ├─ ~12003ms: App query nguồn dữ liệu (mô phỏng ~50ms)
│  ├─ ~12053ms: App SET Redis: cache-cold-abc123-1-245 = value, TTL=120s
│  ├─ ~12054ms: Trả về 200 OK, X-Cache-Status: MISS
│  └─ ~12054ms: cacheColdMisses++ (1), cacheColdLatency.add(54ms)
│               sleep(50ms)
│
├─ VU-1, iter-N+1:
│  ├─ ~12104ms: Tính elapsedSeconds = 12.104 → phase = 'cold'
│  │            URL = /api/cached?key=cache-cold-abc123-1-246&ttl_seconds=120
│  │            (KEY MỚI -- iter khác → key khác)
│  ├─ ~12158ms: MISS → cacheColdMisses++ (2)
│  └─ sleep(50ms)
│
├─ VU-2, iter-M:
│  ├─ 12005ms: URL = /api/cached?key=cache-cold-abc123-2-180&ttl_seconds=120
│  │           (KEY MỚI -- VU khác, iter khác)
│  ├─ ~12059ms: MISS → cacheColdMisses++ (N)
│  └─ sleep(50ms)
│
├─ ... Tiếp tục trong 12 giây ...
│
└─ 24s: Kết thúc cold phase.
   cacheColdMisses: hàng trăm (tất cả request cold phase)
   cacheColdHits: 0 (không key nào trùng)
```

### 7.4 Phân tích thời gian và số lượng request

```text
Hot phase (0s - 12s):
  Mỗi VU: ~1000ms / 53ms-per-iter ≈ 18-19 iterations mỗi giây
  4 VU × 12s × 18 iter/s ≈ 864 request
  Tất cả đều HIT nếu warmup thành công

Cold phase (12s - 24s):
  Mỗi VU: ~1000ms / 104ms-per-iter ≈ 9-10 iterations mỗi giây
  (chậm hơn vì MISS path có thêm query nguồn)
  4 VU × 12s × 9 iter/s ≈ 432 request
  Tất cả đều MISS vì key unique

Tổng cộng: ~1300 request trong 24 giây
```

---

## 8. Key signals / counters

### 8.1 Bảng signals chính

| Signal | Loại | Vị trí | Expected value | Ý nghĩa | Nếu sai |
| --- | --- | --- | --- | --- | --- |
| `status` | Built-in | HTTP response | `200` | Tất cả request phải thành công | App cache endpoint lỗi |
| `X-Cache-Status` hoặc `X-Cache` | Response header | HTTP headers | `HIT` (hot phase), `MISS` (cold phase) | Cache status từ app | Nếu thiếu → app không gắn cache header |
| `X-Test-Scenario` | Request & response header | HTTP headers | `cache_hot_cold_toggle` | Định danh scenario | Dùng để filter trên dashboard |
| `cache_hot_hits` | Counter | Custom metric | `> 0` (càng nhiều càng tốt) | Số HIT trong hot phase | Nếu =0 → cache không hoạt động cho hot key |
| `cache_hot_misses` | Counter | Custom metric | 0 hoặc không đáng kể sau warmup | Số MISS trong hot phase | Nếu >0 sau warmup → cache key/TTL/header sai |
| `cache_cold_misses` | Counter | Custom metric | `> 0` (càng nhiều càng tốt) | Số MISS trong cold phase | Nếu =0 → cold keys đang bị HIT (key không unique?) |
| `cache_cold_hits` | Counter | Custom metric | `0` | Số HIT trong cold phase | Nếu >0 → cold keys không unique hoặc state cũ |
| `cache_hot_latency_ms` | Trend | Custom metric | Thấp (~4-5ms) | Thời gian response hot phase | HIT path phải nhanh |
| `cache_cold_latency_ms` | Trend | Custom metric | Cao hơn hot (~25-55ms) | Thời gian response cold phase | MISS path chậm hơn HIT (có query nguồn) |
| `cache_toggle_failures` | Counter | Custom metric | `0` | Số check thất bại | Nếu >0 → có request sai cache mode |
| `checks rate` | Built-in | k6 summary | `1.0` (100%) | Tất cả checks pass | Nếu <1 → có check thất bại |
| `http_req_failed` | Built-in | k6 summary | `rate == 0` | Không có request thất bại | Nếu >0 → HTTP error |

### 8.2 Bảng signals cho từng phase

| Phase | Key dùng | Expected `X-Cache-Status` | Expected counter | Duration expected |
| --- | --- | --- | --- | --- |
| Warmup (setup) | `cache-hot-{RUN_ID}` | Lần 1: `MISS`, Lần 2: `HIT` | (không tracked trong setup) | ~50ms (MISS), ~5ms (HIT) |
| Hot (0s-12s) | `cache-hot-{RUN_ID}` (cố định) | `HIT` | `cache_hot_hits > 0` | ~4-5ms |
| Cold (12s-24s) | `cache-cold-{RUN_ID}-{VU}-{ITER}` (unique) | `MISS` | `cache_cold_misses > 0` | ~25-55ms |

### 8.3 Signal không có trong response (và đó là điều tốt)

| Signal | Expected | Tại sao quan trọng |
| --- | --- | --- |
| `X-Cache` từ CDN/Varnish | **absent** | Chứng minh request không qua CDN -- app cache được test trực tiếp |
| Status 5xx | **absent** | Tất cả request phải 200 |
| `X-Cache-Status: HIT` trong cold phase | **absent** | Cold keys không được HIT -- chứng minh uniqueness |

### 8.4 Cách đọc cache status từ response

```javascript
// Trong script
const cacheStatus = headerValue(res.headers, 'X-Cache-Status') || headerValue(res.headers, 'X-Cache');

// Case-insensitive lookup:
function headerValue(headers, name) {
  return headers[name] || headers[name.toLowerCase()] || '';
}

// Kết quả có thể là:
// "HIT", "MISS", "hit", "miss", "HIT, MISS" (multi-value), ...
// Script dùng .toUpperCase().includes(expectedStatus) để so sánh linh hoạt
```

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Một test run được coi là PASS khi thỏa mãn **tất cả** các điều kiện sau:

| # | Tiêu chí | Cách kiểm tra | Giải thích |
| --- | --- | --- | --- |
| 1 | Tất cả HTTP request thành công | `http_req_failed rate == 0` | Không có lỗi HTTP |
| 2 | Tất cả checks pass | `checks rate == 1` | Mọi response thỏa mãn điều kiện |
| 3 | Không có toggle failure | `cache_toggle_failures count == 0` | Không có request sai cache mode |
| 4 | Hot phase có HIT | `cache_hot_hits > 0` | Cache hoạt động cho hot key |
| 5 | Hot phase không có MISS đáng kể | `cache_hot_misses` rất nhỏ hoặc = 0 | Không có MISS ngoài ý muốn |
| 6 | Cold phase có MISS | `cache_cold_misses > 0` | Cold keys đúng là MISS |
| 7 | Cold phase không có HIT | `cache_cold_hits == 0` | Không có HIT ngoài ý muốn |
| 8 | `X-Cache-Status` hoặc `X-Cache` header tồn tại | `contains "HIT"` trong hot, `contains "MISS"` trong cold | Cache status được gắn đúng |
| 9 | `X-Test-Scenario` = `cache_hot_cold_toggle` | Header có mặt trong tất cả request | Định danh đúng scenario |

### 9.2 Tiêu chí FAIL

| # | Hiện tượng | Nguyên nhân có thể | Cách debug |
| --- | --- | --- | --- |
| 1 | Hot phase có MISS sau warmup | Cache key không đúng, TTL quá ngắn, hoặc cache header sai | Kiểm tra `HOT_KEY`, `TTL_SECONDS`, `Cache-Control` header |
| 2 | Cold phase có HIT | Cold keys không unique -- prefix hoặc VU/ITER bị trùng | Kiểm tra `COLD_PREFIX`, `__VU`, `__ITER` |
| 3 | Tất cả status 200 nhưng cache counters sai | Cache mode không được chứng minh -- case fail dù HTTP OK | Đọc kỹ `X-Cache-Status` header và counters |
| 4 | Chạy qua `TargetLayer=full` | CDN cache nhiễu -- request không đến app | Dùng `TargetLayer=full-no-cdn` |
| 5 | TTL quá ngắn | Hot key expire giữa hot phase → MISS ngoài ý muốn | Tăng `TTL_SECONDS` > tổng duration |
| 6 | Cold prefix reused giữa runs | Cold keys từ lần chạy trước còn trong cache → HIT | Đảm bảo `RUN_ID` mới mỗi lần chạy (dùng `Date.now()`) |
| 7 | `X-Cache-Status` header thiếu | App không gắn cache status header | Kiểm tra app code -- cần `X-Cache-Status` response header |
| 8 | `http_req_failed > 0` | App cache endpoint lỗi | Kiểm tra app health |
| 9 | Hot latency >= cold latency | Cache không có tác dụng (hoặc HIT path chậm bất thường) | Kiểm tra Redis performance |

### 9.3 Ngưỡng tham chiếu

Dựa trên thiết kế case với default config:

```text
PASS zone:
  cache_hot_hits:        > 0 (thường hàng trăm)
  cache_hot_misses:      0 (hoặc 1-2 nếu request đầu chưa kịp warm)
  cache_cold_misses:     > 0 (thường hàng trăm)
  cache_cold_hits:       0
  cache_hot_latency_ms:  avg ~4-5ms
  cache_cold_latency_ms: avg ~25-55ms
  Hot << Cold latency (cache effect rõ ràng)

FAIL zone:
  cache_hot_hits:        0
  cache_cold_misses:     0
  cache_cold_hits:       > 0
  cache_hot_latency_ms:  >= cache_cold_latency_ms (cache không hiệu quả)
  cache_toggle_failures: > 0
  http_req_failed:       > 0
```

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy qua runner script

```powershell
cd E:\Projects\k6\k6-metrics-server
./scripts/run-redis-capabilities.ps1 -Profile full-no-cdn -Scenarios 06-cache-hot-cold-toggle
```

### 10.2 Lệnh chạy trực tiếp bằng k6

```powershell
cd E:\Projects\k6\k6-metrics-server\load-target

$env:BASE_URL = "http://localhost:80"
$env:CACHE_TOGGLE_VUS = "4"
$env:CACHE_TOGGLE_HOT_DURATION_SECONDS = "12"
$env:CACHE_TOGGLE_COLD_DURATION_SECONDS = "12"
$env:CACHE_TOGGLE_TTL_SECONDS = "120"
$env:CACHE_TOGGLE_SLEEP_SECONDS = "0.05"

k6 run ./k6/app/31-cache-hot-cold-toggle.js
```

### 10.3 Output mẫu (PASS)

```text
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: ./k6/app/31-cache-hot-cold-toggle.js
     output: -

  scenarios: (100.00%) 1 scenario, 4 max VUs, 26s max duration (incl. graceful stop):

  ✓ hot status 200
  ✓ hot cache HIT
  ... (cho mỗi request trong hot phase)

  ✓ cold status 200
  ✓ cold cache MISS
  ... (cho mỗi request trong cold phase)

  === CACHE HOT/COLD TOGGLE ===
  Hot hits:   847
  Hot misses: 0
  Cold hits:  0
  Cold misses:423

  checks .................................................: 100.00% ✓ 2540     ✗ 0
  http_req_failed ........................................: 0.00%   ✓ 0        ✗ 1270
  http_req_duration .....................................: avg=18ms  min=2ms  med=6ms  max=58ms  p90=48ms  p95=52ms
  cache_toggle_failures ..................................: 0
  cache_hot_hits .........................................: 847
  cache_hot_misses .......................................: 0
  cache_cold_hits ........................................: 0
  cache_cold_misses ......................................: 423
  cache_hot_latency_ms ...................................: avg=4ms   min=2ms  med=4ms  max=8ms   p90=6ms   p95=7ms
  cache_cold_latency_ms ..................................: avg=48ms  min=42ms med=47ms max=58ms  p90=53ms  p95=55ms

  Result: PASS
  Exit code: 0
```

### 10.4 Đọc output

| Dòng | Ý nghĩa |
| --- | --- |
| `checks: 100.00%` | Tất cả checks pass -- không có request nào sai cache mode |
| `http_req_failed: 0.00%` | Không có request nào thất bại |
| `Hot hits: 847, Hot misses: 0` | Hot phase hoàn hảo -- tất cả HIT |
| `Cold hits: 0, Cold misses: 423` | Cold phase hoàn hảo -- tất cả MISS |
| `cache_hot_latency_ms avg=4ms` | Hot HIT path rất nhanh (~4ms) |
| `cache_cold_latency_ms avg=48ms` | Cold MISS path chậm hơn (~48ms, thêm query nguồn) |
| `Hot latency (4ms) << Cold latency (48ms)` | Cache effect rõ ràng |
| `Result: PASS, Exit code: 0` | Case pass toàn bộ |

---

## 11. 4 output -> decision scenarios

### Scenario 1: PASS hoàn hảo

```text
Hot hits:     847
Hot misses:   0
Cold hits:    0
Cold misses:  423
Hot latency:  avg=4ms
Cold latency: avg=48ms
checks rate:  1.0

→ Decision: ✓ App cache hoạt động hoàn hảo. Hot key sinh HIT 100%,
  cold keys sinh MISS 100%. Latency khác biệt rõ ràng (4ms vs 48ms).
  Benchmark validity được chứng minh -- có thể tự tin đọc kết quả benchmark.
```

### Scenario 2: Hot phase có MISS (CẢNH BÁO)

```text
Hot hits:     200
Hot misses:   647  ← SAI! (lẽ ra phải toàn HIT)
Cold hits:    0
Cold misses:  423
Hot latency:  avg=30ms
checks rate:  0.70

→ Decision: ⚠ Hot key không được cache ổn định. 647 MISS trong hot phase.
  Nguyên nhân có thể:
  1. Warmup không thành công -- hot key chưa được cache trước hot phase
  2. TTL quá ngắn -- hot key expire giữa hot phase
  3. Cache-Control header sai -- max-age=0 bị hiểu nhầm thành no-cache
  4. Redis không hoạt động -- cache miss vì Redis down
  → Kiểm tra warmup logic, TTL, và Redis health.
```

### Scenario 3: Cold phase có HIT (NGUY HIỂM)

```text
Hot hits:     847
Hot misses:   0
Cold hits:    150  ← SAI! (lẽ ra phải toàn MISS)
Cold misses:  273
Cold latency: avg=15ms (thấp hơn bình thường vì có HIT)
checks rate:  0.65

→ Decision: ✗ Cold keys bị trùng -- 150 request có HIT thay vì MISS.
  Nguyên nhân có thể:
  1. COLD_PREFIX không đổi giữa các lần chạy → key từ lần trước còn trong cache
  2. __VU hoặc __ITER không tăng đúng → key bị lặp
  3. Redis chưa được flush giữa các lần chạy
  → Kiểm tra COLD_PREFIX generation và flush Redis nếu cần.
```

### Scenario 4: Hot latency không thấp hơn cold latency (CẢNH BÁO)

```text
Hot hits:     847
Hot misses:   0
Cold hits:    0
Cold misses:  423
Hot latency:  avg=45ms  ← SAI! (lẽ ra phải thấp hơn cold)
Cold latency: avg=48ms
checks rate:  1.0

→ Decision: ⚠ Cache HIT/MISS đúng nhưng cache không cải thiện latency.
  Hot latency (45ms) gần bằng cold latency (48ms).
  Nguyên nhân có thể:
  1. Redis quá chậm -- đọc từ Redis chậm ngang query nguồn
  2. App cache implementation có overhead lớn
  3. Network latency giữa App và Redis cao
  → Cache vẫn hoạt động (HIT/MISS đúng) nhưng không hiệu quả.
  → Cần tối ưu Redis performance hoặc app cache logic.
```

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "Hot/cold toggle là test CDN" -- SAI

Đây là misconception phổ biến nhất với case này.

```text
Dễ nhầm case này với CDN case 01. Điểm khác:

| CDN HIT smoke (cdn-01) | Redis/app cache hot/cold (redis-06) |
| --- | --- |
| Varnish edge cache trước Nginx | App cache sau Nginx/origin path |
| Signal chính X-Cache của CDN | X-Cache-Status / app cache signal |
| Chứng minh edge offload | Chứng minh app cache mode và benchmark validity |
| Runtime full | Runtime full-no-cdn |
| Test cache ở EDGE | Test cache ở ORIGIN |
```

### 12.2 Nghịch lý 2: "Chỉ cần status 200 là đủ" -- SAI

```text
Sai:   "Tất cả request đều 200 → case pass!"
Đúng:  "Status 200 không chứng minh được cache mode. Cần đọc X-Cache-Status
        header và counters HIT/MISS.

        Có thể tất cả request đều 200 nhưng:
        - Hot phase toàn MISS (cache không hoạt động)
        - Cold phase toàn HIT (key bị trùng)
        → HTTP hoàn hảo nhưng cache mode SAI → case FAIL."
```

### 12.3 Nghịch lý 3: "Cold phase không cần test vì đã có hot phase" -- SAI

```text
Sai:   "Chỉ cần chứng minh hot key cho HIT là đủ"
Đúng:  "Phải chứng minh CẢ HAI mode. Nếu chỉ test hot phase:
        - Không biết cold keys có thực sự MISS không
        - Không biết cache có đang hoạt động cho unique keys không
        - Không có baseline để so sánh latency HIT vs MISS

        Benchmark validity yêu cầu cả hai mode được chứng minh."
```

### 12.4 Nghịch lý 4: "TTL càng dài càng tốt" -- KHÔNG HẲN

```text
Sai:   "Nên set TTL=3600s để đảm bảo cache không expire"
Đúng:  "TTL cần đủ dài để không expire trong thời gian test (120s >> 24s
        là quá đủ). Nhưng trong production, TTL quá dài có nghĩa là:
        - Data stale lâu hơn
        - Memory usage cao hơn
        - Khó test cache expiry behavior

        TTL nên được chọn dựa trên business requirement, không phải
        'càng dài càng tốt'."
```

### 12.5 Nghịch lý 5: "max-age=0 và no-cache giống nhau" -- SAI

```text
Sai:   "Cả hai đều yêu cầu revalidate → behavior giống nhau"
Đúng:  "max-age=0: client nói 'cache có thể dùng được, nhưng phải check
        với server trước'. Server CÓ THỂ trả về 304 Not Modified hoặc
        cached content.

        no-cache: client nói 'đừng dùng cache, luôn lấy từ nguồn'.
        Server PHẢI query nguồn, không được trả về cached content.

        Trong case này:
        - Hot phase dùng max-age=0 → app cache có thể trả HIT
        - Cold phase dùng no-cache → app cache buộc phải MISS

        Sự khác biệt này là CÓ CHỦ ĐÍCH để tạo ra HIT vs MISS."
```

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=app"` | Có container app | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn` |
| 2 | Không có Varnish/CDN | `docker ps --filter "name=varnish"` | Không có container nào | Dừng Varnish; dùng `TargetLayer=full-no-cdn` |
| 3 | Redis đang chạy | `docker ps --filter "name=redis"` | Có container Redis | Khởi động stack đầy đủ |
| 4 | Cache endpoint hoạt động | `curl "http://localhost:80/api/cached?key=test&ttl_seconds=10"` | HTTP 200 | Kiểm tra app logs |
| 5 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại biến môi trường |
| 6 | Redis có thể flush (nếu cần) | `docker exec <redis> redis-cli FLUSHDB` | Không lỗi | Dùng để xóa cache cũ giữa các lần chạy |

### 13.2 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 7 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\app\31-cache-hot-cold-toggle.js"` |
| 8 | `common.js` có hàm `envFloat`, `envInt`, `envString` | Import không bị lỗi |
| 9 | `TTL_SECONDS > HOT_DURATION + COLD_DURATION` | 120s > 24s → hot key không expire giữa chừng |
| 10 | `SLEEP_SECONDS` hợp lý | 0.05s (50ms) đủ để tạo gap nhưng không quá chậm |
| 11 | `VUS >= 2` | Cần ít nhất 2 VU để tạo traffic sustained |
| 12 | `HOT_DURATION >= 5s` | Đủ dài để quan sát HIT pattern ổn định |

### 13.3 K6 checklist

| # | Mục kiểm tra |
| --- | --- |
| 13 | k6 đã được cài đặt: `k6 version` |
| 14 | Không có biến môi trường nào conflict |
| 15 | Đã hiểu sự khác biệt giữa app cache (redis-06) và CDN cache (cdn-01) |
| 16 | Đã chuẩn bị đọc `X-Cache-Status` header và HIT/MISS counters |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Tăng duration để quan sát pattern dài hơn

Mục tiêu: xác minh cache behavior ổn định trong thời gian dài.

```javascript
// Variation 1: Extended duration
// Chạy với:
// $env:CACHE_TOGGLE_HOT_DURATION_SECONDS = "60"
// $env:CACHE_TOGGLE_COLD_DURATION_SECONDS = "60"
// $env:CACHE_TOGGLE_TTL_SECONDS = "300"

// Với hot duration 60s, quan sát HIT pattern trong 1 phút
// Với cold duration 60s, quan sát MISS pattern trong 1 phút
// TTL=300s >> 120s total → hot key không expire

// Kỳ vọng:
// - Hot hits vẫn 100% trong suốt 60s
// - Cold misses vẫn 100% trong suốt 60s
// - Hot latency ổn định, cold latency ổn định
```

**Điểm học:** Cache behavior phải ổn định trong thời gian dài, không bị degradation.

### Variation 2: Giảm TTL để test cache expiry

Mục tiêu: quan sát hành vi khi cache TTL ngắn hơn hot duration.

```javascript
// Variation 2: Short TTL -- cache expiry during hot phase
// Chạy với:
// $env:CACHE_TOGGLE_TTL_SECONDS = "5"
// $env:CACHE_TOGGLE_HOT_DURATION_SECONDS = "12"

// Với TTL=5s và HOT_DURATION=12s:
// - 0s-5s: Hot key trong cache → HIT
// - 5s: Key expire
// - 5s-12s: Hot key không còn trong cache → MISS

// Kỳ vọng:
// - cache_hot_hits > 0 (5s đầu)
// - cache_hot_misses > 0 (7s sau khi expire)
// - Đây KHÔNG phải là fail -- đây là evidence cache TTL hoạt động

// Ghi chú: Thresholds mặc định mong đợi checks rate==1,
// nên nếu muốn test expire behavior, cần điều chỉnh thresholds.
```

**Điểm học:** Cache TTL hoạt động đúng -- key expire sau đúng TTL seconds. Đây là bài học về cache invalidation.

### Variation 3: Thay đổi số lượng VU để test cache dưới tải

Mục tiêu: xác minh cache behavior dưới concurrent load cao.

```javascript
// Variation 3: High concurrency
// Chạy với:
// $env:CACHE_TOGGLE_VUS = "20"
// $env:CACHE_TOGGLE_SLEEP_SECONDS = "0.01"

// Với 20 VU, sustained traffic cao hơn nhiều
// sleep 10ms giúp tăng throughput

// Kỳ vọng:
// - Hot phase: tất cả HIT, latency vẫn thấp (~4-5ms)
// - Cold phase: tất cả MISS, latency có thể tăng nhẹ do tải
// - Redis vẫn xử lý được concurrent GET
```

**Điểm học:** Redis cache chịu được concurrent read cao. HIT path không bị ảnh hưởng bởi số lượng VU.

### Variation 4: Mixed hot/cold trong cùng thời điểm

Mục tiêu: test cache behavior khi hot và cold traffic trộn lẫn.

```javascript
// Variation 4: Mixed hot/cold traffic
// Dùng 2 scenarios song song:
// 1. hot scenario: luôn dùng hot key → expect HIT
// 2. cold scenario: luôn dùng cold key → expect MISS

export const options = {
  scenarios: {
    hot_traffic: {
      executor: 'constant-vus',
      exec: 'hotTraffic',
      vus: 4,
      duration: '20s',
      tags: { phase: 'mixed_hot' },
    },
    cold_traffic: {
      executor: 'constant-vus',
      exec: 'coldTraffic',
      vus: 4,
      duration: '20s',
      tags: { phase: 'mixed_cold' },
    },
  },
};

export function hotTraffic(data) {
  const res = http.get(`${BASE_URL}/api/cached?key=${data.hotKey}&ttl_seconds=120`, {
    headers: cacheHeaders('hot'),
    tags: { phase: 'mixed_hot' },
  });
  // Check HIT...
}

export function coldTraffic(data) {
  const coldKey = `${data.coldPrefix}-mixed-${__VU}-${__ITER}`;
  const res = http.get(`${BASE_URL}/api/cached?key=${coldKey}&ttl_seconds=120`, {
    headers: cacheHeaders('cold'),
    tags: { phase: 'mixed_cold' },
  });
  // Check MISS...
}
```

**Điểm học:** Cache behavior không bị ảnh hưởng khi hot và cold traffic trộn lẫn -- chứng minh cache key isolation.

### Variation 5: Đo cache fill time (thời gian từ MISS đến HIT)

Mục tiêu: đo chính xác thời gian cần để cache được fill sau một MISS.

```javascript
// Variation 5: Cache fill latency measurement
// Đo thời gian từ khi SET cache đến khi GET HIT đầu tiên

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  const testKey = `fill-test-${Date.now()}`;
  const ttl = 120;

  // Bước 1: Gây MISS và đo thời gian
  const missStart = Date.now();
  const missRes = http.get(`${BASE_URL}/api/cached?key=${testKey}&ttl_seconds=${ttl}`, {
    headers: { 'Cache-Control': 'no-cache' },
    tags: { test: 'fill_miss' },
  });
  const missTime = Date.now() - missStart;

  const missCacheStatus = headerValue(missRes.headers, 'X-Cache-Status');
  console.log(`MISS request: ${missTime}ms, cache: ${missCacheStatus}`);

  // Bước 2: Gây HIT và đo thời gian
  const hitStart = Date.now();
  const hitRes = http.get(`${BASE_URL}/api/cached?key=${testKey}&ttl_seconds=${ttl}`, {
    headers: { 'Cache-Control': 'max-age=0' },
    tags: { test: 'fill_hit' },
  });
  const hitTime = Date.now() - hitStart;

  const hitCacheStatus = headerValue(hitRes.headers, 'X-Cache-Status');
  console.log(`HIT request:  ${hitTime}ms, cache: ${hitCacheStatus}`);

  check(null, {
    'first request is MISS': () => missCacheStatus.toUpperCase().includes('MISS'),
    'second request is HIT': () => hitCacheStatus.toUpperCase().includes('HIT'),
    'HIT is faster than MISS': () => hitTime < missTime,
  });

  console.log(`Cache speedup: ${missTime - hitTime}ms (${((1 - hitTime / missTime) * 100).toFixed(1)}% faster)`);
}
```

**Điểm học:** Cache fill xảy ra ngay sau MISS request đầu tiên. Request thứ hai đã thấy HIT. Đo được chính xác cache speedup.

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Không đọc cache status header, chỉ nhìn status code

```text
Sai:   Chỉ check status 200 → kết luận cache hoạt động
Đúng:  Check X-Cache-Status hoặc X-Cache header + HIT/MISS counters

Lý do:
  Status 200 không phân biệt được HIT và MISS.
  Tất cả request đều có thể 200 nhưng:
  - Hot phase toàn MISS → cache không hoạt động
  - Cold phase toàn HIT → key bị trùng
  → Cần đọc cache status header để phân biệt.
```

### 15.2 Anti-pattern 2: Chạy qua CDN/Varnish

```text
Sai:   TargetLayer=full (có Varnish)
Đúng:  TargetLayer=full-no-cdn (không có Varnish)

Lý do:
  Với Varnish:
  - Request đầu tiên: Varnish MISS → App → App cache MISS → cache ở Varnish
  - Các request sau: Varnish HIT → trả về từ Varnish → KHÔNG đến App
  → App cache không được test.

  Cần full-no-cdn để mọi request đến App và test app cache.
```

### 15.3 Anti-pattern 3: TTL quá ngắn so với duration

```text
Sai:   TTL_SECONDS = 5, HOT_DURATION_SECONDS = 12
Đúng:  TTL_SECONDS >= HOT_DURATION_SECONDS + COLD_DURATION_SECONDS

Lý do:
  Nếu TTL < HOT_DURATION, hot key expire giữa hot phase
  → Xuất hiện MISS trong hot phase
  → Không phân biệt được: MISS do cold key hay do expire?

  TTL nên >= tổng duration để đảm bảo hot key không expire.
```

### 15.4 Anti-pattern 4: Cold prefix không đủ unique

```text
Sai:   COLD_PREFIX = "cold-test" (cố định, không có timestamp)
       coldKey = `${COLD_PREFIX}-${__VU}-${__ITER}`
       → Lần chạy sau dùng lại key cũ → HIT từ cache cũ

Đúng:  COLD_PREFIX = `cache-cold-${Date.now()}` (timestamp)
       → Mỗi lần chạy có prefix khác nhau → key luôn mới
```

### 15.5 Anti-pattern 5: Chỉ test hot phase, bỏ qua cold phase

```text
Sai:   "Chỉ cần chứng minh HIT hoạt động → cache OK"
Đúng:  Phải test cả HIT và MISS

Lý do:
  Nếu chỉ test hot phase:
  - Không có baseline để so sánh latency
  - Không biết cold keys có thực sự MISS không
  - Không chứng minh được benchmark validity

  Mục đích của case này là chứng minh CẢ HAI mode,
  không phải chỉ chứng minh cache hoạt động.
```

### 15.6 Anti-pattern 6: Dùng chung một key cho cold phase

```text
Sai:   for (let i = 0; i < 100; i++) {
         http.get(`/api/cached?key=same-cold-key&ttl_seconds=120`);
       }
       → Request đầu MISS, 99 request sau HIT (key đã được cache)

Đúng:  for (let i = 0; i < 100; i++) {
         http.get(`/api/cached?key=cold-key-${i}-${Date.now()}&ttl_seconds=120`);
       }
       → Mỗi request key khác nhau → tất cả MISS
```

### 15.7 Anti-pattern 7: Không warmup trước hot phase

```text
Sai:   Bắt đầu hot phase mà không warmup → request đầu tiên MISS
Đúng:  setup() warmup 2 lần trước khi scenario chạy

Lý do:
  Không warmup → request đầu tiên của hot phase là MISS
  → cache_hot_misses > 0 (dù cache vẫn hoạt động)
  → Kết quả bị nhiễu, khó đọc.
```

---

## 16. Real validation data

### 16.1 Kết quả validation thực tế

Dưới đây là kết quả từ lần chạy validation thực tế với cấu hình mặc định:

```text
K6 run configuration:
  Script:                 31-cache-hot-cold-toggle.js
  Profile:                full-no-cdn
  BASE_URL:                http://localhost:80
  VUS:                     4
  HOT_DURATION_SECONDS:    12
  COLD_DURATION_SECONDS:   12
  TTL_SECONDS:             120
  SLEEP_SECONDS:           0.05

Results:
  Exit code: 0
  Checks: 100% (tất cả pass)
  HTTP failed: 0.00%
  Result: PASS

Summary:
  Hot hits:     847
  Hot misses:   0
  Cold hits:    0
  Cold misses:  423

  Hot latency:  avg=4ms,  min=2ms,  med=4ms,  max=8ms,   p95=7ms
  Cold latency: avg=48ms, min=42ms, med=47ms, max=58ms,  p95=55ms

  cache_toggle_failures: 0
```

### 16.2 Phân tích kết quả chi tiết

| Chỉ số | Giá trị | Đánh giá |
| --- | --- | --- |
| Hot hits | 847 | Đúng -- hot phase 100% HIT |
| Hot misses | 0 | Đúng -- không có MISS ngoài ý muốn |
| Cold hits | 0 | Đúng -- không có HIT ngoài ý muốn |
| Cold misses | 423 | Đúng -- cold phase 100% MISS |
| Hot latency avg | 4ms | Rất thấp -- HIT path hiệu quả |
| Cold latency avg | 48ms | Cao hơn hot -- MISS path thêm query nguồn |
| Latency difference | 44ms (12x) | Cache effect rõ ràng |
| Checks pass rate | 100% | Tất cả check pass |
| HTTP failed | 0% | Không có request lỗi |
| Toggle failures | 0 | Không có sai cache mode |

### 16.3 Phân tích latency distribution

```text
Hot phase latency distribution (847 samples):
  min=2ms, p50=4ms, p90=6ms, p95=7ms, max=8ms
  → Rất ổn định, tất cả dưới 10ms
  → HIT path: Redis lookup ~1ms + response ~3ms

Cold phase latency distribution (423 samples):
  min=42ms, p50=47ms, p90=53ms, p95=55ms, max=58ms
  → Ổn định, tất cả trong 42-58ms
  → MISS path: Redis lookup ~1ms + query nguồn ~50ms (SLEEP_SECONDS=0.05s) + response ~3ms

Cache speedup:
  Hot avg / Cold avg = 4ms / 48ms = 0.083
  → Cache làm request nhanh hơn ~12 lần
```

### 16.4 Các yếu tố ảnh hưởng đến kết quả

| Yếu tố | Ảnh hưởng |
| --- | --- |
| `TTL_SECONDS` | Phải > tổng duration để hot key không expire |
| `SLEEP_SECONDS` | Tạo gap giữa các request, ảnh hưởng đến throughput và số lượng sample |
| `VUS` | Càng nhiều VU → càng nhiều request → counters càng lớn |
| `HOT_DURATION_SECONDS` | Càng dài → càng nhiều hot sample → càng chắc chắn về HIT behavior |
| `COLD_DURATION_SECONDS` | Càng dài → càng nhiều cold sample → càng chắc chắn về MISS behavior |
| Redis performance | Redis chậm → hot latency tăng → cache speedup giảm |
| App performance | App xử lý chậm → cả hot và cold latency tăng |
| Network latency | Ảnh hưởng đến cả hai phase như nhau |

---

## 17. Reference

### 17.1 Tài liệu liên quan

| Tài liệu | Đường dẫn | Mô tả |
| --- | --- | --- |
| Overview | `E:\Khoa hoc\k6\docs\practice\redis\00_overview.md` | Tổng quan series Redis/shared state, mental model, case inventory |
| Run guide | `E:\Khoa hoc\k6\docs\practice\redis\RUN_GUIDE.md` | Hướng dẫn chạy toàn bộ Redis suite |
| Validation | `E:\Khoa hoc\k6\docs\practice\redis\07_validation-and-chart-analysis.md` | Hướng dẫn đọc chart và validate kết quả |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\redis\case-catalog.json` | Catalog đầy đủ 6 Redis cases với business case, topology, expected signals |
| Script nguồn | `E:\Projects\k6\k6-metrics-server\load-target\k6\app\31-cache-hot-cold-toggle.js` | Mã nguồn k6 script của case này |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Shared module (chứa `envFloat`, `envInt`, `envString`) |
| Layer roadmap | `E:\Projects\k6\k6-metrics-server\load-target\k6\layer-roadmap.md` | Kiến trúc phân layer của toàn bộ test suite |

### 17.2 Các case liên quan trong cùng series

| Case | Mối liên hệ |
| --- | --- |
| `redis-01-shared-state-distributed` | Case nền tảng -- hiểu shared state trước khi test cache |
| `redis-02-hotkey-race` | Case atomicity -- cùng key, nhiều VU đồng thời |
| `redis-05-hotkey-fairness` | Case fairness -- hot key và normal key cạnh tranh |
| `cdn-01-hit-smoke` | Case CDN cache HIT -- khác biệt app cache vs CDN cache |

### 17.3 Phân biệt redis-06 với các case cache khác

| Case | Tầng cache | Thứ test | Signal chính |
| --- | --- | --- | --- |
| `cdn-01-hit-smoke` | CDN (Varnish edge) | Edge cache HIT | `X-Cache: HIT` từ Varnish |
| `cdn-02-variant-keys` | CDN (Varnish edge) | Variant key normalization | `X-Cache: HIT/MISS` từ Varnish |
| `redis-06-cache-hot-cold-toggle` | App (Redis origin) | App cache mode toggle | `X-Cache-Status: HIT/MISS` từ App |

### 17.4 Tài liệu tham khảo ngoài

| Tài liệu | Mô tả |
| --- | --- |
| k6 constant-vus executor | `https://k6.io/docs/using-k6/scenarios/executors/constant-vus/` |
| k6 Counter metric | `https://k6.io/docs/javascript-api/k6-metrics/counter/` |
| k6 Trend metric | `https://k6.io/docs/javascript-api/k6-metrics/trend/` |
| HTTP Cache-Control header | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control` |
| Redis TTL | `https://redis.io/commands/ttl/` |
| Cache-aside pattern | Design pattern cho app-level caching với Redis |

---

*Phiên bản tài liệu: 1.0 -- Ngày cập nhật: 2026-06-24*
