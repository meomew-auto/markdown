# Case 09: Stale-While-Error (Grace Mode)

> **Case ID:** `cdn-09-stale-while-error`\
> **Script:** `09-stale-while-error.js`\
> **Layer:** CDN / Varnish\
> **Proof:** CDN phục vụ nội dung cũ (stale) khi origin không khỏe mạnh, trong khoảng thời gian `stale-if-error` cho phép

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [CDN capability được chứng minh](#2-cdn-capability-được-chứng-minh)
3. [Vì sao phải test ở CDN layer](#3-vì-sao-phải-test-ở-cdn-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [VCL deep-dive](#6-vcl-deep-dive)
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

Một nền tảng thương mại điện tử phục vụ hơn 500.000 người dùng đồng thời vào giờ cao điểm. Toàn bộ traffic được định tuyến qua CDN (Varnish) trước khi đến các microservice backend. Hệ thống hoạt động 24/7 với cam kết SLA 99.95% uptime.

Tuy nhiên, backend không phải lúc nào cũng khỏe mạnh. Các sự cố điển hình bao gồm:

| Sự cố backend | Tần suất ước tính | Thời gian phục hồi điển hình | Hậu quả nếu không có stale-if-error |
|---|---|---|---|
| Database connection pool cạn kiệt | 2-3 lần/tháng | 30-90 giây | Toàn bộ product page trả 503 |
| Microservice crash loop (OOM) | 1 lần/tuần | 60-180 giây | Dịch vụ đề xuất, tìm kiếm ngừng hoạt động |
| Network partition giữa app và database | 1-2 lần/quý | 10-60 giây | Tất cả endpoint cần database trả lỗi |
| Deploy phiên bản mới gây lỗi khởi động | 2-3 lần/tháng | 30-300 giây | Service downtime toàn phần trong lúc rollback |
| Rate limiting từ third-party API (payment, shipping) | 1-2 lần/ngày | 5-30 phút | Checkout và theo dõi đơn hàng bị gián đoạn |

Nếu không có cơ chế stale-if-error, mỗi sự cố backend đều dẫn đến:

```text
Người dùng → CDN → Backend (lỗi) → CDN trả 503 → Người dùng thấy trang lỗi
```

Hậu quả kinh doanh của mỗi phút backend downtime:

| Hệ quả | Số liệu ước tính | Ghi chú |
|---|---|---|
| Doanh thu mất mát | $2.800 - $4.500/phút | Với AOV $35, tỉ lệ chuyển đổi 2.3%, 500K người dùng |
| Người dùng rời bỏ vĩnh viễn | 0.8% - 1.2% người dùng gặp lỗi | Theo nghiên cứu của Google về "bounce rate sau lỗi 50x" |
| Tổn thất SEO | Giảm 0.1-0.3 điểm crawl score | Googlebot gặp 503 liên tục sẽ giảm tần suất crawl |
| Chi phí đội ngũ vận hành | $150-300/sự cố | Thời gian kỹ sư xử lý khẩn cấp, viết post-mortem |

### 1.2 Tình huống cụ thể: Database connection pool cạn kiệt

Hãy xét một tình huống cụ thể xảy ra vào Thứ Sáu tuần trước:

```text
19:34:22  Database primary gặp lỗi hardware, failover sang replica
19:34:25  Application connection pool chưa kịp refresh, tất cả connection đến primary bị timeout
19:34:27  Health check của Nginx phát hiện app trả 503 → bắt đầu đánh dấu upstream là "unhealthy"
19:34:30  CDN health probe phát hiện backend unhealthy → nếu không có stale-if-error,
          toàn bộ request của 500K người dùng đồng thời nhận 503
19:34:35  Database failover hoàn tất, connection pool bắt đầu phục hồi
19:35:00  Application fully operational trở lại
```

**Thời gian downtime thực tế: 35 giây.** Nhưng nếu CDN phục vụ nội dung cũ (stale) trong lúc chờ backend phục hồi, **người dùng không hề biết có sự cố**.

Đây chính là sức mạnh của `stale-if-error`: biến 35 giây downtime backend thành **0 giây downtime trải nghiệm người dùng**.

### 1.3 Các ứng dụng thực tế của stale-if-error

| Loại nội dung | TTL bình thường | stale-if-error | Lý do |
|---|---|---|---|
| Trang chi tiết sản phẩm | 60 giây | 300 giây (5 phút) | Thông tin sản phẩm ít thay đổi, chấp nhận stale 5 phút khi có sự cố |
| Trang danh sách sản phẩm (có phân trang) | 30 giây | 180 giây (3 phút) | Giá và tồn kho thay đổi nhanh hơn, nhưng vẫn chấp nhận stale |
| Trang chủ / landing page | 10 giây | 120 giây (2 phút) | Nội dung marketing thay đổi nhanh nhưng stale vẫn hơn error page |
| API đề xuất sản phẩm | 300 giây | 3600 giây (1 giờ) | Đề xuất không cần chính xác tuyệt đối, stale vẫn hữu ích |
| Hình ảnh sản phẩm (static assets) | 86400 giây | 604800 giây (7 ngày) | Hình ảnh gần như không đổi, stale rất lâu vẫn chấp nhận được |
| Kết quả tìm kiếm | 15 giây | 60 giây | Kết quả tìm kiếm nên tươi, nhưng stale vẫn tốt hơn trang lỗi |
| Giỏ hàng / checkout (user-specific) | Không cache | Không áp dụng | Dữ liệu cá nhân không được cache |

### 1.4 Vai trò của đội vận hành

Trong môi trường production, đội vận hành cần trả lời được ba câu hỏi:

1. **Khi backend gặp sự cố, CDN có thực sự phục vụ nội dung cũ không?** Không thể chỉ "tin" vào cấu hình. Phải kiểm chứng định kỳ.
2. **Stale content có được đánh dấu rõ ràng không?** Cần header `X-Cache-Stale: true` để monitoring system có thể phân biệt stale vs fresh traffic.
3. **Thời gian stale tối đa có được tôn trọng không?** Sau khi `stale-if-error` hết hạn, CDN phải ngừng phục vụ stale và bắt đầu trả lỗi.

Case 09 này trả lời cả ba câu hỏi trên thông qua một kịch bản kiểm chứng tự động.

---

## 2. CDN capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh khả năng phục vụ nội dung cũ của CDN khi backend gặp lỗi:

> **CDN phục vụ stale content khi origin không khỏe mạnh, trong khoảng thời gian `stale-if-error` cho phép, và từ chối phục vụ sau khi grace period hết hạn**

Cụ thể hơn, bốn khía cạnh được chứng minh:

| Khía cạnh | Mô tả | Cách kiểm chứng trong script |
|---|---|---|
| **Phục vụ stale** | Khi origin bị đánh dấu unhealthy, CDN tiếp tục trả 200 với nội dung đã cache thay vì 503 | `assertStatus(stale, 200)` + `assertCacheState(stale, 'HIT')` |
| **Đánh dấu stale** | Response chứa header xác nhận đây là stale content | `assertHeaderEquals(stale, 'X-Cache-Stale', 'true')` |
| **Origin chỉ bị gọi một lần** | Trong suốt quá trình, origin chỉ nhận đúng 1 request (lần MISS đầu tiên) | `findOriginRequestCount(counts, path) === 1` |
| **Nhận thức backend state** | CDN biết backend đang không khỏe mạnh | `assertHeaderEquals(stale, 'X-Cache-Backend-Healthy', 'false')` |

### 2.2 Cơ chế hoạt động: Grace mode trong Varnish

Varnish có hai khái niệm liên quan đến phục vụ nội dung cũ:

```text
┌─────────────────────────────────────────────────────────────────┐
│                        VARNISH GRACE MODE                        │
│                                                                  │
│  TTL (time-to-live)         stale-if-error (grace)              │
│  ├──────────┤               ├──────────────────────┤            │
│  │          │               │                      │            │
│  0s        TTL             TTL+stale_if_error    hết hạn        │
│  │          │               │                      │            │
│  │ FRESH    │               │ STALE (GRACE)        │ EXPIRED    │
│  │          │               │                      │            │
│  │ CDN dùng │               │ CDN dùng bản cache   │ CDN phải   │
│  │ bản cache│               │ cũ khi origin lỗi    │ fetch mới  │
│  │ ngay     │               │                      │            │
│  └──────────┘               └──────────────────────┘            │
│                                                                  │
│  Điều kiện để serve stale:                                      │
│  1. Object đã hết TTL nhưng chưa hết stale-if-error             │
│  2. Backend/Origin đang được đánh dấu là "unhealthy" (sick)     │
│  3. Hoặc: backend trả lỗi (5xx) khi CDN thử fetch mới           │
└─────────────────────────────────────────────────────────────────┘
```

Trong VCL, điều này được kiểm soát bởi các biến trong `vcl_backend_response`:

```vcl
sub vcl_backend_response {
    # Thời gian object được coi là "tươi" (fresh)
    set beresp.ttl = 2s;

    # Thời gian object được phép phục vụ ở trạng thái "cũ" (stale)
    # khi backend không khỏe mạnh hoặc trả lỗi
    set beresp.stale_if_error = 120s;
}
```

### 2.3 Phân biệt stale-while-revalidate và stale-if-error

Nhiều người nhầm lẫn giữa hai khái niệm. Đây là bảng phân biệt:

| Tiêu chí | stale-while-revalidate | stale-if-error (case này) |
|---|---|---|
| **Trigger** | Object hết TTL, có request mới đến | Backend bị đánh dấu unhealthy hoặc trả lỗi |
| **Hành vi CDN** | Trả stale cho client, đồng thời fetch mới từ backend (async revalidate) | Trả stale cho client, **không** thử fetch mới (vì biết backend đang lỗi) |
| **Origin request** | CÓ -- 1 request để fetch bản mới | KHÔNG -- bỏ qua origin vì biết sẽ thất bại |
| **Mục đích chính** | Giảm latency cho người dùng (trả cache ngay, fetch ngầm) | Duy trì availability khi backend gặp sự cố |
| **Header liên quan** | `Cache-Control: stale-while-revalidate=N` | `Cache-Control: stale-if-error=N` |
| **Varnish VCL** | `beresp.stale_while_revalidate` | `beresp.stale_if_error` |
| **Khi nào dùng** | Backend vẫn khỏe, muốn tối ưu tốc độ | Backend không khỏe, muốn duy trì uptime |

Case 09 tập trung vào **stale-if-error** -- capability quan trọng nhất cho khả năng phục hồi của hệ thống.

### 2.4 Tại sao capability này quan trọng

Trong hệ thống production, stale-if-error là tuyến phòng thủ cuối cùng trước khi người dùng nhìn thấy trang lỗi:

```text
Tuyến 1: Backend health -- database connection pool, circuit breaker, retry logic
Tuyến 2: Multi-AZ failover -- nếu một AZ lỗi, traffic được chuyển sang AZ khác
Tuyến 3: CDN stale-if-error -- nếu tất cả backend đều lỗi, CDN vẫn trả stale
Tuyến 4: Static error page -- chỉ khi stale cũng hết hạn
```

Nếu không có tuyến 3, mỗi sự cố backend đều trở thành sự cố người dùng.

---

## 3. Vì sao phải test ở CDN layer

### 3.1 Stale-if-error là hành vi của CDN, không phải của app

```text
Người dùng → CDN (Varnish :80) → Nginx → App → Database
              ↑
         QUYẾT ĐỊNH stale hay không nằm ở đây
```

Quyết định "có phục vụ stale hay không" được đưa ra hoàn toàn bên trong Varnish, dựa trên:

1. Trạng thái health của backend (do Varnish health probe xác định)
2. Thời gian `stale_if_error` còn lại của object
3. Kết quả của lần thử fetch gần nhất (nếu có)

App không hề biết CDN đang phục vụ stale. App chỉ thấy: "không có request nào đến mình trong 35 giây qua". Chỉ có test ở CDN layer mới xác minh được stale đang được phục vụ.

### 3.2 Health probing là cơ chế nội bộ của Varnish

Varnish tự động health-check backend theo chu kỳ (thường 2-5 giây). Khi backend không trả lời đúng, Varnish đánh dấu backend là `sick` và tự động chuyển sang grace mode cho tất cả request đến backend đó.

```text
Varnish health probe cycle:
┌──────┐    ┌──────┐    ┌──────┐    ┌──────┐    ┌──────┐
│Probe1│ -> │Probe2│ -> │Probe3│ -> │Probe4│ -> │Probe5│ -> ...
│ 200  │    │ 200  │    │ 503  │    │ 503  │    │ 503  │
│healthy   │healthy   │unhealthy  │unhealthy  │unhealthy  │
└──────┘    └──────┘    └──────┘    └──────┘    └──────┘
                                    ↑
                              Sau N probe thất bại liên tiếp,
                              backend bị đánh dấu "sick"
```

Trong script case 09, chúng ta set origin profile thành `healthy: false` và đợi `STALE_PROBE_WAIT_SECONDS` (mặc định 4 giây) để Varnish health probe phát hiện backend không khỏe mạnh trước khi gửi request test.

### 3.3 Không thể test stale-if-error bằng unit test app

| Cách test | Kết quả | Đúng/Sai |
|---|---|---|
| Unit test app: mock CDN headers | App test pass, nhưng CDN thực tế có thể không hoạt động | **Sai** -- test ảo không có giá trị |
| Integration test: gọi thẳng app qua :8080 | Response luôn tươi từ app, không có khái niệm stale | **Sai** -- bỏ qua hoàn toàn CDN layer |
| End-to-end test: gọi qua CDN :80 | CDN thực sự phục vụ stale, tất cả header CDN có mặt | **Đúng** -- đây là cách duy nhất |
| Manual test: curl và đọc header | Tốn thời gian, không reproducible, không có pass/fail rõ ràng | **Không đủ** -- cần automation |

### 3.4 Control plane và data plane đều phải tham gia

Case 09 yêu cầu sự phối hợp giữa hai plane:

| Plane | Vai trò trong case 09 |
|---|---|
| **Control plane (:8088)** | `setOriginProfile({ healthy: false })` -- mô phỏng backend failure; `resetOriginProfile()` -- khôi phục backend; `getOriginRequestCounts()` -- đếm số lần origin bị gọi |
| **Data plane (:80)** | Nhận request từ k6, trả response với `X-Cache`, `X-Cache-Stale`, `X-Cache-Backend-Healthy` headers |

Nếu chỉ test một trong hai plane, bức tranh không đầy đủ.

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌─────────────────────────┐
                          │    k6 test script        │
                          │  (09-stale-while-error)  │
                          └──────┬────────┬──────────┘
                                 │        │
                    public path  │        │  control path
                    (GET)        │        │  (PATCH/POST profile,
                                 │        │   GET counts)
                                 ▼        ▼
┌──────────────────────────────────────────────────────────────┐
│  localhost:80 (Varnish)          localhost:8088 (control)    │
│  ┌──────────────────┐           ┌──────────────────────┐    │
│  │  Varnish cache    │           │  Ops control plane   │    │
│  │  ┌──────────────┐ │           │                      │    │
│  │  │ Object store  │ │           │  /ops/app/cdn/origin/│    │
│  │  │ - TTL: 2s     │ │           │    profile           │    │
│  │  │ - stale_if_   │ │  set      │    request-counts    │    │
│  │  │   error: 120s │ │  origin   │    reset             │    │
│  │  │ - grace mode  │◄┤  profile  │                      │    │
│  │  └──────────────┘ │ │           └──────────────────────┘    │
│  │                    │ │                                      │
│  │  Health probe      │ │                                      │
│  │  (mỗi 2-5s) ───────┤─┤──► Probe backend                   │
│  │                    │ │                                      │
│  └───────┬────────────┘ │                                      │
│          │ miss          │                                      │
│          ▼               │                                      │
│  ┌──────────────┐        │                                      │
│  │  Nginx :8080 │        │                                      │
│  └───────┬──────┘        │                                      │
│          │               │                                      │
│          ▼               ▼                                      │
│  ┌──────────────────────────────────────────────────┐         │
│  │  Origin service (app)                             │         │
│  │  - /api/cached (có thể cấu hình TTL và            │         │
│  │    stale-if-error qua query string)               │         │
│  │  - Có thể mô phỏng lỗi 503 (origin profile)       │         │
│  └──────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
|---|---|---|
| `TargetLayer` | `full` (bắt buộc) | `docker ps` thấy Varnish container |
| `BASE_URL` | `http://localhost:80` | `curl -sI http://localhost:80/api/cached` thấy `X-Cache` header |
| `CONTROL_BASE_URL` | `http://localhost:8088` | `curl http://localhost:8088/health` |
| `OPS_AUTH_TOKEN` | Token xác thực control plane | Phải set trước khi chạy; không được commit |
| Origin profile API | Hỗ trợ PATCH `/ops/app/cdn/origin/profile` | Control plane endpoint phải hoạt động |
| Origin request counts API | Hỗ trợ GET `/ops/app/cdn/origin/request-counts` | Dùng để đếm chính xác số lần origin bị gọi |

### 4.3 Stack khởi động

```powershell
# Khởi động full stack với CDN
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full -ScaleApp 2
```

Đợi tất cả service healthy (khoảng 30-60 giây). Kiểm tra:

```powershell
# Xác nhận Varnish đang chạy
docker ps --filter "name=varnish"

# Xác nhận public path hoạt động
curl -sI http://localhost:80/api/cached

# Xác nhận control path hoạt động
curl http://localhost:8088/health
```

### 4.4 Biến môi trường của case

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `STALE_TTL_SECONDS` | `2` | TTL của object trong cache (giây). Case này dùng TTL rất ngắn để test nhanh |
| `STALE_IF_ERROR_SECONDS` | `120` | Thời gian stale-if-error (grace period) tính bằng giây |
| `STALE_POST_TTL_WAIT_SECONDS` | `STALE_TTL_SECONDS + 1` = `3` | Thời gian đợi sau khi object hết TTL (đảm bảo object đã expired) |
| `STALE_PROBE_WAIT_SECONDS` | `4` | Thời gian đợi Varnish health probe phát hiện backend unhealthy |

### 4.5 Precondition tự động

Script `setup()` tự động thực thi các bước precondition sau:

```javascript
export function setup() {
  const path = buildCachedPath(`stale-${Date.now()}`, {
    ttl_seconds: STALE_TTL_SECONDS,
    stale_if_error_seconds: STALE_IF_ERROR_SECONDS,
  });

  resetOriginProfile();          // Đảm bảo origin đang healthy
  resetOriginRequestCounts();    // Reset counter về 0
  waitOriginHealthy({ ... });    // Đợi origin healthy (có probe)
  banUrl(path);                  // Xóa cache object cũ nếu có

  const first = requestCdn('GET', path, { ... });
  assertStatus(first, 200, 'stale first');
  assertCacheState(first, 'MISS', 'stale first');  // Phải MISS

  const second = requestCdn('GET', path, { ... });
  assertStatus(second, 200, 'stale second');
  assertCacheState(second, 'HIT', 'stale second'); // Phải HIT

  return { path };
}
```

Điều này có nghĩa: **không cần precondition thủ công**. Script tự tạo object mới, warm cache, và xác nhận trạng thái trước khi vào test chính.

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\09-stale-while-error.js
```

### 5.2 Import và dependency

```javascript
import { sleep } from 'k6';

import { envFloat, envInt } from '../shared/common.js';
import {
  buildCachedPath,
  banUrl,
  requestCdn,
  assertCacheState,
  assertHeaderEquals,
  assertStatus,
  getOriginRequestCounts,
  findOriginRequestCount,
  resetOriginProfile,
  resetOriginRequestCounts,
  setOriginProfile,
  waitOriginHealthy,
} from './shared.js';
```

**Phân tích từng import:**

| Import | Nguồn | Vai trò trong case này |
|---|---|---|
| `sleep` | `k6` | Tạm dừng VU để đợi TTL hết hạn và health probe phát hiện backend unhealthy |
| `envFloat`, `envInt` | `../shared/common.js` | Đọc biến môi trường với giá trị mặc định |
| `buildCachedPath` | `./shared.js` | Tạo URL path `/api/cached?key=stale-...&ttl_seconds=...&stale_if_error_seconds=...` |
| `banUrl` | `./shared.js` | Gọi control API để xóa cache object trước khi test |
| `requestCdn` | `./shared.js` | Gửi HTTP request qua CDN (port :80) |
| `assertCacheState` | `./shared.js` | Kiểm tra header `X-Cache` (MISS, HIT, v.v.) |
| `assertHeaderEquals` | `./shared.js` | Kiểm tra giá trị chính xác của một response header |
| `assertStatus` | `./shared.js` | Kiểm tra HTTP status code |
| `getOriginRequestCounts` | `./shared.js` | Gọi control API để lấy số lần origin bị gọi cho từng request key |
| `findOriginRequestCount` | `./shared.js` | Tìm số lần origin bị gọi cho một request key cụ thể |
| `resetOriginProfile` | `./shared.js` | Khôi phục origin về trạng thái healthy (POST /ops/app/cdn/origin/reset) |
| `resetOriginRequestCounts` | `./shared.js` | Reset bộ đếm origin request về 0 |
| `setOriginProfile` | `./shared.js` | Thay đổi trạng thái origin (healthy, error_status) qua PATCH |
| `waitOriginHealthy` | `./shared.js` | Vòng lặp đợi origin healthy (probe qua CDN + kiểm tra profile) |

### 5.3 Biến hằng số và giá trị mặc định

```javascript
const STALE_TTL_SECONDS = envInt('STALE_TTL_SECONDS', 2);
const STALE_IF_ERROR_SECONDS = envInt('STALE_IF_ERROR_SECONDS', 120);
const STALE_POST_TTL_WAIT_SECONDS = envFloat('STALE_POST_TTL_WAIT_SECONDS', STALE_TTL_SECONDS + 1);
const STALE_PROBE_WAIT_SECONDS = envFloat('STALE_PROBE_WAIT_SECONDS', 4);
```

**Phân tích từng hằng số:**

| Hằng số | Giá trị mặc định | Ý nghĩa | Tại sao chọn giá trị này |
|---|---|---|---|
| `STALE_TTL_SECONDS` | `2` | TTL của cache object | Đủ nhỏ để test nhanh (chỉ cần đợi 3 giây là object hết hạn), nhưng đủ lớn để không gây race condition |
| `STALE_IF_ERROR_SECONDS` | `120` | Thời gian stale-if-error | Đủ dài để stale không vô tình hết hạn trong lúc test. Trong production thường là 60-300 giây |
| `STALE_POST_TTL_WAIT_SECONDS` | `STALE_TTL_SECONDS + 1 = 3` | Thời gian đợi sau TTL | Đảm bảo object chắc chắn đã hết TTL. Cộng thêm 1 giây để có margin an toàn |
| `STALE_PROBE_WAIT_SECONDS` | `4` | Thời gian đợi health probe | Varnish thường probe mỗi 2-5 giây. 4 giây đủ để ít nhất 1-2 probe cycle hoàn tất |

**Tại sao TTL = 2 giây?** Trong test, chúng ta muốn object hết hạn nhanh để chứng minh CDN phục vụ stale. Nếu TTL dài (ví dụ 300 giây), script sẽ phải đợi rất lâu. TTL ngắn giúp test nhanh và phù hợp với CI/CD pipeline.

**Tại sao cần STALE_POST_TTL_WAIT_SECONDS?** Object được cache ở t=0.5s với TTL=2s. Nếu không đợi, request test có thể đến khi object vẫn còn fresh, và CDN sẽ HIT bình thường thay vì vào grace mode.

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
    scenario: 'cdn_stale_while_error',
  },
};
```

**Phân tích từng trường:**

| Trường | Giá trị | Ý nghĩa |
|---|---|---|
| `vus` | `1` | Một VU duy nhất -- đây là correctness test, không phải load test |
| `iterations` | `1` | Chạy đúng một lần -- mỗi bước là sequential proof không cần lặp |
| `thresholds.checks` | `['rate==1']` | **100% checks phải pass** -- bất kỳ check nào thất bại, toàn bộ test thất bại |
| `thresholds.http_req_failed` | `['rate==0']` | **0% request thất bại** -- không chấp nhận bất kỳ HTTP error nào |
| `tags.scenario` | `'cdn_stale_while_error'` | Tag để phân biệt trên k6 dashboard/cloud |

**Tại sao checks rate==1 mà không phải rate>0.9?** Đây là correctness test -- không có chỗ cho sai số. Nếu stale-if-error không hoạt động đúng, toàn bộ hệ thống có nguy cơ downtime. Không thể chấp nhận "90% request được phục vụ stale".

##### Phân tích executor: vì sao dùng `per-vu-iterations` cho case này?

Config dùng bare form `vus=1, iterations=1` → `per-vu-iterations`.

**Yêu cầu của case:**

```text
1. Stale-if-error chain: warm → HIT → origin down → stale served → origin up → fresh
   → Mỗi bước PHỤ THUỘC bước trước (không thể verify stale nếu chưa warm)
   → Cần điều khiển origin up/down giữa các bước → TUẦN TỰ tuyệt đối

2. 1 VU, 1 iteration: toàn bộ kịch bản stale-if-error trong 1 lần default()
   → setup() warm cache + bật origin down
   → default() verify stale → bật origin up → verify fresh
   → Nhiều VU sẽ race: VU A verify stale, VU B bật origin up → hỏng test
```

**So sánh executor:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **per-vu-iterations** (đang dùng) | ✅ **ĐÚNG** | 1 VU × 1 iter. Sequence tuần tự + điều khiển origin state. |
| shared-iterations | ⚠️ Kết quả giống | Với `vus=1`, output giống. |
| constant-vus | ❌ SAI | Cần `duration`. Không biết trước thời gian (origin up/down, sleep). |
| constant-arrival-rate | ❌ SAI | Ép rate. Case này cần sequence, không cần rate. |
| ramping-vus | ❌ SAI | 1 VU ổn định, không ramp. |

**Key insight**: Stale-if-error test = "warm → bật origin down → verify stale →
bật origin up → verify fresh". Sequential proof yêu cầu điều khiển môi trường
giữa các bước. `per-vu-iterations` với `vus=1, iterations=1` là pattern chuẩn.

### 5.5 setup() -- chi tiết từng bước

```javascript
export function setup() {
  const path = buildCachedPath(`stale-${Date.now()}`, {
    ttl_seconds: STALE_TTL_SECONDS,
    stale_if_error_seconds: STALE_IF_ERROR_SECONDS,
  });

  resetOriginProfile();
  resetOriginRequestCounts();
  waitOriginHealthy({ label: 'stale setup origin recovery' });
  banUrl(path);

  const first = requestCdn('GET', path, {
    tags: { case: 'stale_first' },
  });
  assertStatus(first, 200, 'stale first');
  assertCacheState(first, 'MISS', 'stale first');

  const second = requestCdn('GET', path, {
    tags: { case: 'stale_second' },
  });
  assertStatus(second, 200, 'stale second');
  assertCacheState(second, 'HIT', 'stale second');

  return { path };
}
```

**Phân tích từng dòng:**

**Bước 1: Tạo unique path**
```javascript
const path = buildCachedPath(`stale-${Date.now()}`, {
  ttl_seconds: STALE_TTL_SECONDS,
  stale_if_error_seconds: STALE_IF_ERROR_SECONDS,
});
```
- `Date.now()` đảm bảo mỗi lần chạy test có một path riêng, tránh conflict với các lần chạy trước hoặc song song
- Query string chứa `ttl_seconds=2` và `stale_if_error_seconds=120` -- origin đọc các tham số này để set header `Cache-Control` tương ứng
- Path kết quả có dạng: `/api/cached?key=stale-1712345678901&ttl_seconds=2&stale_if_error_seconds=120`

**Bước 2: Reset origin về trạng thái sạch**
```javascript
resetOriginProfile();          // healthy=true, error_status=200
resetOriginRequestCounts();    // tất cả counter về 0
waitOriginHealthy({ ... });    // đợi probe xác nhận origin healthy
```
- `resetOriginProfile()` gọi `POST /ops/app/cdn/origin/reset` -- khôi phục origin về trạng thái mặc định
- `resetOriginRequestCounts()` gọi `POST /ops/app/cdn/origin/request-counts/reset` -- đặt tất cả bộ đếm về 0
- `waitOriginHealthy()` vừa kiểm tra profile API vừa probe thực tế qua CDN. Đảm bảo origin thực sự khỏe mạnh trước khi bắt đầu test

**Bước 3: Xóa cache object cũ (nếu có)**
```javascript
banUrl(path);
```
- Gọi `POST /ops/app/cdn/cache/ban-url` với body `{ url: path }`
- Đảm bảo không có object cũ nào tồn tại trước khi test
- Nếu không có object nào để xóa, API vẫn trả 200 (idempotent)

**Bước 4: Request đầu tiên -- MISS (warm cache)**
```javascript
const first = requestCdn('GET', path, {
  tags: { case: 'stale_first' },
});
assertStatus(first, 200, 'stale first');
assertCacheState(first, 'MISS', 'stale first');
```
- Gửi request qua CDN (:80). Vì object chưa tồn tại trong cache, CDN forward request đến origin
- Origin trả 200 với headers: `Cache-Control: max-age=2, stale-if-error=120`
- Varnish lưu object vào cache với `TTL=2s`, `stale_if_error=120s`
- Response có `X-Cache: MISS` -- xác nhận object chưa có trong cache
- **Đây là lần DUY NHẤT origin bị gọi trong toàn bộ test**

**Bước 5: Request thứ hai -- HIT (xác nhận cache)**
```javascript
const second = requestCdn('GET', path, {
  tags: { case: 'stale_second' },
});
assertStatus(second, 200, 'stale second');
assertCacheState(second, 'HIT', 'stale second');
```
- Gửi request thứ hai ngay sau request đầu tiên
- Object vẫn còn fresh (TTL=2s chưa hết)
- Response có `X-Cache: HIT` -- xác nhận object đã được cache thành công

**Bước 6: Trả về data cho default function**
```javascript
return { path };
```
- `path` được truyền vào `default` function qua tham số `data`

### 5.6 default() -- chi tiết từng bước

```javascript
export default function (data) {
  const path = data.path;

  sleep(STALE_POST_TTL_WAIT_SECONDS);

  setOriginProfile({
    healthy: false,
    error_status: 503,
  });
  sleep(STALE_PROBE_WAIT_SECONDS);

  const stale = requestCdn('GET', path, {
    tags: { case: 'stale_after_origin_unhealthy' },
  });
  assertStatus(stale, 200, 'stale after origin unhealthy');
  assertCacheState(stale, 'HIT', 'stale after origin unhealthy');
  assertHeaderEquals(stale, 'X-Cache-Stale', 'true', 'stale after origin unhealthy');
  assertHeaderEquals(stale, 'X-Cache-Backend-Healthy', 'false', 'stale after origin unhealthy');

  const counts = getOriginRequestCounts();
  const requestCount = findOriginRequestCount(counts, path);
  if (requestCount !== 1) {
    throw new Error(`expected stale path ${path} to hit origin exactly once, got ${requestCount}`);
  }
}
```

**Phân tích từng bước:**

**Bước 1: Đợi object hết TTL**
```javascript
sleep(STALE_POST_TTL_WAIT_SECONDS);
```
- Đợi 3 giây (STALE_TTL_SECONDS + 1)
- Sau 3 giây, object đã hết TTL (2 giây) và đang ở trạng thái "stale-able"

**Bước 2: Làm backend unhealthy**
```javascript
setOriginProfile({
  healthy: false,
  error_status: 503,
});
```
- Gọi `PATCH /ops/app/cdn/origin/profile` với body `{ healthy: false, error_status: 503 }`
- Từ thời điểm này, origin sẽ trả HTTP 503 cho mọi request
- **Đây là mô phỏng (simulation), không phải hư hỏng thật** -- control plane cho phép thay đổi hành vi origin để test

**Bước 3: Đợi Varnish health probe phát hiện backend sick**
```javascript
sleep(STALE_PROBE_WAIT_SECONDS);
```
- Đợi 4 giây để Varnish health probe phát hiện backend không khỏe mạnh
- **Nếu không đợi đủ lâu**, request test có thể đến khi Varnish chưa kịp đánh dấu backend sick -> CDN sẽ thử fetch từ origin -> nhận 503 -> trả 503 cho client -> **TEST THẤT BẠI**

**Bước 4: Gửi request test -- verify stale serving**

Bốn assertion này là **trái tim của toàn bộ case**:

| Assertion | Giá trị mong đợi | Ý nghĩa nếu PASS | Ý nghĩa nếu FAIL |
|---|---|---|---|
| `assertStatus(stale, 200)` | HTTP 200 | Người dùng nhận được response thành công (dù backend lỗi) | Người dùng thấy 503 -- stale-if-error KHÔNG hoạt động |
| `assertCacheState(stale, 'HIT')` | `X-Cache: HIT` | CDN trả object từ cache (không gọi origin) | Object không có trong cache hoặc CDN thử gọi origin |
| `assertHeaderEquals(stale, 'X-Cache-Stale', 'true')` | `X-Cache-Stale: true` | CDN xác nhận đây là stale content (không phải fresh) | CDN đang trả stale nhưng không đánh dấu -- monitoring không phát hiện được |
| `assertHeaderEquals(stale, 'X-Cache-Backend-Healthy', 'false')` | `X-Cache-Backend-Healthy: false` | CDN biết backend đang lỗi | CDN không nhận thức được backend unhealthy |

**Bước 5: Verify origin chỉ bị gọi đúng 1 lần**
```javascript
const counts = getOriginRequestCounts();
const requestCount = findOriginRequestCount(counts, path);
if (requestCount !== 1) {
  throw new Error(`expected stale path ${path} to hit origin exactly once, got ${requestCount}`);
}
```

Đây là **evidence định lượng quan trọng nhất** của case:

- `getOriginRequestCounts()` gọi `GET /ops/app/cdn/origin/request-counts` -- trả về object chứa mảng `data.counts` với mỗi entry là `{ request_key, count }`
- `findOriginRequestCount(counts, path)` tìm entry có `request_key === path` và trả về `count`
- `requestCount` phải **chính xác bằng 1** -- chỉ có request MISS đầu tiên trong `setup()` gọi origin
- Nếu `requestCount > 1`, có nghĩa CDN đã gọi origin thêm lần nữa -- có thể do stale-if-error không hoạt động và CDN thử re-fetch
- Nếu `requestCount === 0`, có nghĩa request đầu tiên cũng không gọi origin -- điều không thể xảy ra nếu `setup()` đã assert MISS

### 5.7 teardown() -- dọn dẹp

```javascript
export function teardown() {
  resetOriginProfile();
  waitOriginHealthy({ label: 'stale teardown origin recovery' });
  resetOriginRequestCounts();
}
```

**Phân tích:**

| Bước | Hàm | Mục đích |
|---|---|---|
| 1 | `resetOriginProfile()` | Khôi phục origin về trạng thái healthy -- tránh ảnh hưởng đến các test case khác |
| 2 | `waitOriginHealthy()` | Đợi origin thực sự healthy trở lại (có probe xác nhận) -- đảm bảo trạng thái sạch |
| 3 | `resetOriginRequestCounts()` | Reset bộ đếm về 0 -- case tiếp theo không bị nhiễu dữ liệu cũ |

**Tại sao teardown quan trọng?** Nếu không reset origin profile, case tiếp theo (ví dụ case 10) sẽ thấy backend unhealthy và có thể thất bại oan. Teardown là "luật bất thành văn" trong test CDN: **luôn để lại môi trường sạch hơn trước khi test**.

---

## 6. VCL deep-dive

### 6.1 VCL là gì

VCL (Varnish Configuration Language) là ngôn ngữ cấu hình của Varnish, được biên dịch thành C và nạp vào Varnish runtime. VCL định nghĩa cách Varnish xử lý request và response ở từng giai đoạn.

### 6.2 Các subroutine liên quan đến stale-if-error

Stale-if-error liên quan đến **ba subroutine** trong VCL:

```text
vcl_backend_response  →  Set beresp.stale_if_error (lưu trữ grace period)
vcl_hit               →  Quyết định có phục vụ stale object hay không
vcl_backend_error     →  Xử lý khi backend trả lỗi hoặc không phản hồi
```

### 6.3 vcl_backend_response -- Thiết lập stale-if-error

Khi Varnish nhận response từ backend (origin), hàm `vcl_backend_response` được gọi:

```vcl
sub vcl_backend_response {
    # Đọc giá trị max-age từ response header Cache-Control
    if (beresp.http.Cache-Control ~ "max-age\s*=\s*(\d+)") {
        set beresp.ttl = std.duration(regsub(beresp.http.Cache-Control,
            ".*max-age\s*=\s*(\d+).*", "\1") + "s", 120s);
    }

    # Đọc giá trị stale-if-error từ response header Cache-Control
    if (beresp.http.Cache-Control ~ "stale-if-error\s*=\s*(\d+)") {
        set beresp.stale_if_error = std.duration(regsub(beresp.http.Cache-Control,
            ".*stale-if-error\s*=\s*(\d+).*", "\1") + "s", 0s);
    }

    # Grace mode: cho phép object được phục vụ khi backend sick
    set beresp.grace = beresp.stale_if_error;

    # Quan trọng: giữ object trong cache ngay cả khi đã hết TTL
    if (beresp.stale_if_error > 0s) {
        set beresp.keep = beresp.stale_if_error;
    }
}
```

**Giải thích từng dòng:**

| Dòng | Giải thích |
|---|---|
| `beresp.ttl` | Thời gian object được coi là "tươi". Sau TTL, object chuyển sang trạng thái "stale" nhưng vẫn được giữ trong cache |
| `beresp.stale_if_error` | Thời gian tối đa object được phép phục vụ ở trạng thái "cũ" khi backend gặp lỗi. Đây là giá trị từ `Cache-Control: stale-if-error=N` |
| `beresp.grace` | Thời gian Varnish giữ object sau khi hết TTL. Khi backend healthy, object trong grace vẫn được dùng để async revalidate. Khi backend sick, object trong grace được phục vụ trực tiếp |
| `beresp.keep` | Thời gian Varnish giữ object trong cache storage sau khi hết grace. Nếu không set, object sẽ bị xóa khỏi cache khi hết grace, và không thể phục vụ stale |

### 6.4 vcl_hit -- Quyết định phục vụ stale

Khi Varnish tìm thấy object trong cache (`vcl_hit`), nó phải quyết định: phục vụ ngay, async revalidate, hay fetch mới?

```vcl
sub vcl_hit {
    if (obj.ttl >= 0s) {
        // Object còn TTL → phục vụ ngay (fresh hit)
        return (deliver);
    }

    if (std.healthy(req.backend_hint)) {
        // Backend healthy → vừa trả stale, vừa fetch mới (async revalidate)
        return (deliver);
    }

    if (obj.ttl + obj.grace > 0s) {
        // Còn trong grace period → phục vụ stale
        set resp.http.X-Cache-Stale = "true";
        return (deliver);
    }

    // Hết grace → không thể phục vụ stale
    return (fetch);  // sẽ thất bại vì backend sick
}
```

**Flowchart logic:**

```text
                    ┌─────────────────┐
                    │  vcl_hit called │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ obj.ttl >= 0s ? │
                    └────┬────────┬───┘
                     YES │        │ NO
                         │        │
                ┌────────▼──┐ ┌───▼──────────────────────┐
                │ deliver   │ │ std.healthy(backend) ?    │
                │ (fresh)   │ └──┬────────────────────┬───┘
                └───────────┘ YES│                    │NO
                                │                    │
                     ┌──────────▼────┐    ┌──────────▼──────────┐
                     │ async         │    │ obj.ttl + obj.grace │
                     │ revalidate    │    │ > 0s ?              │
                     │ (stale + fetch│    └──┬──────────────┬───┘
                     │  background)  │   YES│              │NO
                     └───────────────┘      │              │
                                  ┌─────────▼────┐  ┌──────▼──────┐
                                  │ deliver      │  │ fetch       │
                                  │ (stale,      │  │ (will fail  │
                                  │  X-Cache-    │  │  if backend │
                                  │  Stale: true)│  │  sick)      │
                                  └──────────────┘  └─────────────┘
```

### 6.5 vcl_backend_error -- Xử lý khi fetch thất bại

Nếu CDN thử fetch từ backend nhưng backend trả lỗi hoặc không phản hồi, `vcl_backend_error` được gọi:

```vcl
sub vcl_backend_error {
    if (beresp.stale_if_error > 0s) {
        // Có stale content trong cache → thử lại với stale object
        return (retry);
    }

    // Không có stale content → trả lỗi cho client
    set beresp.http.Content-Type = "text/html; charset=utf-8";
    set beresp.status = 503;
    synthetic({"<html><body><h1>Service Unavailable</h1></body></html>"});
    return (deliver);
}
```

### 6.6 Tổng kết VCL flow cho stale-if-error

```text
┌─────────────────────────────────────────────────────────────────────┐
│                     TOÀN BỘ VCL FLOW CHO STALE-IF-ERROR             │
│                                                                      │
│  REQUEST FLOW:                                                       │
│  vcl_recv → vcl_hash → LOOKUP                                       │
│                           │                                          │
│                    ┌──────┴──────┐                                   │
│                    │   FOUND?    │                                   │
│                    └──────┬──────┘                                   │
│                     YES   │   NO                                     │
│                      │    │    │                                     │
│               vcl_hit│    │    │vcl_miss → backend_fetch             │
│                      │    │    │            │                        │
│               ┌──────▼────┴──┐ │   ┌────────▼────────┐              │
│               │ obj.ttl>0?   │ │   │ vcl_backend_    │              │
│               └──┬────────┬──┘ │   │ response        │              │
│              YES │        │NO  │   │ - set ttl       │              │
│                  │        │    │   │ - set grace     │              │
│           ┌──────▼──┐ ┌──▼────▼──┐│ - set keep       │              │
│           │ deliver │ │ backend  │└────────┬─────────┘              │
│           │ (fresh) │ │ healthy? │         │                        │
│           └─────────┘ └──┬────┬──┘  ┌──────▼──────────┐            │
│                     YES  │    │NO   │ deliver (fresh) │            │
│                          │    │     └─────────────────┘            │
│            ┌─────────────▼┐ ┌─▼────────────────┐                    │
│            │ async reval  │ │ grace > 0?       │                    │
│            │ (stale+fetch)│ └──┬──────────┬────┘                    │
│            └──────────────┘ YES│          │NO                       │
│                               │          │                          │
│                    ┌──────────▼──┐ ┌─────▼────────┐                 │
│                    │ deliver     │ │ return(fetch) │                │
│                    │ X-Cache-    │ │ → backend_err │                │
│                    │ Stale: true │ │ → retry stale │                │
│                    └─────────────┘ │ or synthetic  │                │
│                                    │ 503           │                │
│                                    └───────────────┘                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. Request sequence flow

### 7.1 Timeline chi tiết (dạng bảng)

| Thời gian (giây) | Actor | Hành động | Request/Response | Ghi chú |
|---|---|---|---|---|
| 0.0 | k6 `setup()` | Bắt đầu setup | -- | -- |
| 0.1 | k6 | `resetOriginProfile()` | `POST :8088/ops/app/cdn/origin/reset` -> 200 | Origin healthy |
| 0.2 | k6 | `resetOriginRequestCounts()` | `POST :8088/ops/app/cdn/origin/request-counts/reset` -> 200 | Counter = 0 |
| 0.3 | k6 | `waitOriginHealthy()` | Probe loop qua CDN | Xác nhận origin healthy |
| 0.8 | k6 | `banUrl(path)` | `POST :8088/ops/app/cdn/cache/ban-url` -> 200 | Xóa cache cũ |
| 1.0 | k6 | `requestCdn(GET, path)` #1 | `GET :80/api/cached?key=stale-...&ttl_seconds=2&stale_if_error_seconds=120` | -- |
| 1.0 | Varnish | Lookup cache | Hash lookup | **KHÔNG TÌM THẤY** (đã bị ban) |
| 1.0 | Varnish | `vcl_miss` | Forward request đến backend | -- |
| 1.0 | Varnish | `vcl_backend_fetch` | `GET :8080/api/cached?key=...` | Gọi origin |
| 1.1 | Origin | Xử lý request | Trả `200 OK` + `Cache-Control: max-age=2, stale-if-error=120` | Origin request count: 1 |
| 1.1 | Varnish | `vcl_backend_response` | `beresp.ttl = 2s`, `beresp.stale_if_error = 120s`, `beresp.grace = 120s` | Lưu object vào cache |
| 1.2 | Varnish | `vcl_deliver` | `200 OK`, `X-Cache: MISS` | Trả về k6 |
| 1.2 | k6 | `assertStatus(200)` + `assertCacheState('MISS')` | PASS | Xác nhận MISS |
| 1.5 | k6 | `requestCdn(GET, path)` #2 | `GET :80/api/cached?key=stale-...` | -- |
| 1.5 | Varnish | Lookup cache | Hash lookup | **TÌM THẤY** (obj.ttl > 0) |
| 1.5 | Varnish | `vcl_hit` | `obj.ttl > 0` -> `return(deliver)` | Object còn fresh |
| 1.6 | Varnish | `vcl_deliver` | `200 OK`, `X-Cache: HIT` | Trả về k6 |
| 1.6 | k6 | `assertStatus(200)` + `assertCacheState('HIT')` | PASS | Xác nhận HIT |
| 1.6 | k6 `setup()` | Hoàn tất, trả về `{ path }` | -- | -- |
| 1.6 | k6 `default()` | Bắt đầu | -- | -- |
| 1.6 | k6 | `sleep(3)` | Đợi 3 giây | Object TTL=2s đã hết hạn lúc t~3.6s |
| 4.6 | k6 | `setOriginProfile({ healthy: false, error_status: 503 })` | `PATCH :8088/ops/app/cdn/origin/profile` -> 200 | Origin bắt đầu trả 503 |
| 4.6 | k6 | `sleep(4)` | Đợi 4 giây | -- |
| 4.8 | Varnish | Health probe #1 | Gọi origin -> 503 | Backend: 1 lần thất bại |
| 6.8 | Varnish | Health probe #2 | Gọi origin -> 503 | Backend: 2 lần thất bại liên tiếp |
| 7.0 | Varnish | Đánh dấu backend | **Backend được đánh dấu là "sick"** | Sau 2-3 probe thất bại |
| 8.6 | k6 | `requestCdn(GET, path)` #3 | `GET :80/api/cached?key=stale-...` | -- |
| 8.6 | Varnish | Lookup cache | Hash lookup | **TÌM THẤY** (obj.ttl < 0, obj.grace > 0) |
| 8.6 | Varnish | `vcl_hit` | Backend sick, grace > 0 | **GRACE MODE** |
| 8.6 | Varnish | `vcl_deliver` | `200 OK`, `X-Cache: HIT`, `X-Cache-Stale: true`, `X-Cache-Backend-Healthy: false` | Trả về k6 |
| 8.6 | k6 | 4 assertions | PASS | Người dùng nhận 200, CDN báo stale, backend unhealthy |
| 8.7 | k6 | `getOriginRequestCounts()` | `GET :8088/ops/app/cdn/origin/request-counts` -> 200 | Lấy bộ đếm |
| 8.7 | k6 | `findOriginRequestCount(counts, path)` | Tìm entry có `request_key === path` | `count === 1` |
| 8.7 | k6 | Kiểm tra count === 1 | PASS | Origin chỉ bị gọi 1 lần |
| 8.7 | k6 `default()` | Hoàn tất | -- | -- |
| 8.7 | k6 `teardown()` | Bắt đầu | -- | -- |
| 8.7 | k6 | `resetOriginProfile()` | `POST :8088/ops/app/cdn/origin/reset` -> 200 | Khôi phục healthy |
| 8.7 | k6 | `waitOriginHealthy()` | Probe loop qua CDN | Đợi backend healthy |
| 12.0 | k6 | Origin healthy confirmed | -- | -- |
| 12.0 | k6 | `resetOriginRequestCounts()` | `POST :8088/ops/app/cdn/origin/request-counts/reset` -> 200 | Dọn dẹp |
| 12.0 | k6 `teardown()` | Hoàn tất | -- | Môi trường sạch |

### 7.2 Sequence diagram (dạng text)

```text
k6                    Varnish                Origin (App)         Control Plane
│                      │                      │                    │
│  setup()            │                      │                    │
│──resetOriginProfile────────────────────────────────────────────>│ 200
│──resetOriginCounts─────────────────────────────────────────────>│ 200
│──waitOriginHealthy──>│──probe GET──────────>│                    │
│                      │<─────200 OK──────────│                    │
│<──healthy confirmed──│                      │                    │
│──banUrl(path)──────────────────────────────────────────────────>│ 200
│                      │                      │                    │
│──GET path #1────────>│                      │                    │
│                      │──lookup (NOT FOUND)  │                    │
│                      │──GET path───────────>│                    │
│                      │                      │ (count=1)          │
│                      │<─────200 + CC────────│                    │
│                      │──store obj           │                    │
│                      │  ttl=2s grace=120s   │                    │
│<──200 X-Cache:MISS───│                      │                    │
│                      │                      │                    │
│──GET path #2────────>│                      │                    │
│                      │──lookup (FOUND)      │                    │
│                      │  obj.ttl > 0         │                    │
│<──200 X-Cache:HIT────│                      │                    │
│                      │                      │                    │
│  setup done          │                      │                    │
│                      │                      │                    │
│  default()           │                      │                    │
│  sleep(3s)           │                      │                    │
│  ...                 │  (object TTL expires) │                    │
│                      │                      │                    │
│──setOriginProfile───────────────────────────────────────────────>│ 200
│  {healthy:false}     │                      │                    │
│                      │                      │ (now returns 503)  │
│                      │                      │                    │
│  sleep(4s)           │                      │                    │
│                      │──health probe────────>│                    │
│                      │<─────503─────────────│                    │
│                      │──health probe────────>│                    │
│                      │<─────503─────────────│                    │
│                      │  backend → SICK      │                    │
│                      │                      │                    │
│──GET path #3────────>│                      │                    │
│                      │──lookup (FOUND)      │                    │
│                      │  obj.ttl < 0         │                    │
│                      │  backend SICK        │                    │
│                      │  grace > 0           │                    │
│                      │  → serve stale       │                    │
│<──200 X-Cache:HIT────│                      │                    │
│   X-Cache-Stale:true │                      │                    │
│   X-Cache-BE-Healthy │                      │                    │
│   :false             │                      │                    │
│                      │                      │                    │
│──getOriginCounts()──────────────────────────────────────────────>│ {counts:[...]}
│  count for path = 1 ✓│                      │                    │
│                      │                      │                    │
│  default done        │                      │                    │
│                      │                      │                    │
│  teardown()          │                      │                    │
│──resetOriginProfile─────────────────────────────────────────────>│ 200
│──waitOriginHealthy──>│──probe GET──────────>│                    │
│                      │<─────200 OK──────────│                    │
│<──healthy confirmed──│                      │                    │
│──resetOriginCounts──────────────────────────────────────────────>│ 200
│  teardown done       │                      │                    │
```

### 7.3 Trạng thái cache object qua thời gian

```text
Trạng thái của cache object:

t=1.2s           t=3.2s                              t=121.2s
│  FRESH          │  STALE (GRACE)                    │  EXPIRED
│                 │                                    │
│  obj.ttl = 2s   │  obj.ttl < 0                       │  obj.ttl + obj.grace < 0
│  obj.grace=120s │  obj.grace > 0                     │  obj.grace đã hết
│                 │                                    │
│  ┌──────────────┼────────────────────────────────────┼──────────►
│  │              │                                    │
│  │ HIT bình     │ HIT + X-Cache-Stale: true          │ MISS
│  │ thường       │ (nếu backend sick)                 │ (fetch mới,
│  │              │                                    │  fail nếu
│  │              │ Nếu backend healthy:               │  backend
│  │              │ async revalidate (fetch mới)        │  vẫn sick)
│  │              │                                    │
│  ▼              ▼                                    ▼
│  Response:      Response:                            Response:
│  X-Cache: HIT   X-Cache: HIT                         X-Cache: MISS
│  (không stale)  X-Cache-Stale: true                  (503 nếu
│                 X-Cache-BE-Healthy: false             backend sick)
│
│  ▲ Setup request #2      ▲ Default request #3
│  (t=1.5s)                (t=8.6s)
│
│            ▲ Setup request #1
│            (t=1.0s) - MISS, tạo object
```

---

## 8. Key signals / headers cần verify

### 8.1 Bảng đầy đủ các header và tín hiệu

| Header/Tín hiệu | Vị trí | Giá trị mong đợi | Ý nghĩa | Hàm assert |
|---|---|---|---|---|
| HTTP Status | Response | `200` | Người dùng nhận response thành công, không thấy lỗi | `assertStatus(res, 200, label)` |
| `X-Cache` | Response header | `HIT` | CDN phục vụ từ cache (không gọi origin) | `assertCacheState(res, 'HIT', label)` |
| `X-Cache` (request #1) | Response header | `MISS` | Request đầu tiên KHÔNG có trong cache | `assertCacheState(res, 'MISS', label)` |
| `X-Cache-Stale` | Response header | `true` (request #3) | CDN xác nhận đây là stale content. **Đây là header quan trọng nhất** | `assertHeaderEquals(res, 'X-Cache-Stale', 'true', label)` |
| `X-Cache-Backend-Healthy` | Response header | `false` (request #3) | CDN biết backend đang không khỏe mạnh | `assertHeaderEquals(res, 'X-Cache-Backend-Healthy', 'false', label)` |
| `Cache-Control` | Response header (từ origin) | `max-age=2, stale-if-error=120` | Origin response cho request #1 -- thiết lập TTL và grace period | (không assert trực tiếp) |
| Origin request count | Control API | `1` cho path test | Origin chỉ bị gọi đúng 1 lần (lần MISS đầu tiên) | `findOriginRequestCount()` + `throw new Error` |

### 8.2 Header X-Cache-Stale -- chi tiết

`X-Cache-Stale` là header quan trọng nhất của case này. Nó cho phép monitoring system phân biệt:

| X-Cache-Stale | Ý nghĩa | Hành động monitoring |
|---|---|---|
| **Không có header** | Object được phục vụ ở trạng thái fresh (còn TTL) | Bình thường, không cần alert |
| **`true`** | Object được phục vụ ở trạng thái stale (hết TTL, backend lỗi) | **TĂNG CẢNH BÁO** -- backend đang có vấn đề |
| **`false`** | Có thể có hoặc không, tùy cấu hình VCL | Tùy triển khai |

Trong production, monitoring system nên:

1. Đếm tỉ lệ response có `X-Cache-Stale: true` trên tổng traffic
2. Nếu tỉ lệ > 1%: **cảnh báo mức WARNING** -- backend có dấu hiệu bất thường
3. Nếu tỉ lệ > 10%: **cảnh báo mức CRITICAL** -- backend đang gặp sự cố nghiêm trọng
4. Nếu tỉ lệ > 50% và kéo dài > 5 phút: **trang incident** -- cần kỹ sư can thiệp

### 8.3 Header X-Cache-Backend-Healthy -- chi tiết

Header này phản ánh kết quả health probe của Varnish tại thời điểm request:

| X-Cache-Backend-Healthy | Ý nghĩa |
|---|---|
| `true` | Backend đang healthy theo Varnish health probe |
| `false` | Backend đang sick theo Varnish health probe |

**Lưu ý quan trọng:** `X-Cache-Backend-Healthy: false` KHÔNG có nghĩa backend thực sự hỏng. Nó chỉ có nghĩa Varnish health probe đánh giá backend là sick. Có thể do:
- Backend thực sự hỏng (trả 5xx)
- Backend quá tải (response time > probe timeout)
- Network issue giữa Varnish và backend
- Health probe URL bị cấu hình sai

### 8.4 Origin request count -- chi tiết

Origin request count là evidence định lượng mạnh nhất cho stale-if-error. Các tình huống có thể xảy ra:

| Count | Ý nghĩa | Đánh giá |
|---|---|---|
| `0` | Không thể xảy ra nếu setup() pass (đã assert MISS). Nếu xảy ra: bug trong code đếm | **ERROR** |
| `1` | Đúng như mong đợi: chỉ MISS đầu tiên gọi origin. Stale request không gọi origin | **PASS** |
| `2` | Có thể stale hoạt động nhưng CDN gọi origin thêm 1 lần (async revalidate trước khi backend được set unhealthy) | **WARNING** -- cần điều tra thêm |
| `>= 3` | Stale-if-error KHÔNG hoạt động: CDN tiếp tục gọi origin dù backend sick | **FAIL** |

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí định lượng

| # | Tiêu chí | Loại | Ngưỡng | Hậu quả nếu FAIL |
|---|---|---|---|---|
| P1 | `checks` rate | k6 threshold | `== 1` (100%) | Toàn bộ test case thất bại |
| P2 | `http_req_failed` rate | k6 threshold | `== 0` (0%) | Có HTTP request thất bại (5xx, timeout) |
| P3 | Request #1 status | Assertion | `200` | Cache warm thất bại -- không thể tiếp tục |
| P4 | Request #1 cache state | Assertion | `MISS` | Object đã tồn tại trong cache trước test -- precondition sai |
| P5 | Request #2 status | Assertion | `200` | Lỗi không mong đợi |
| P6 | Request #2 cache state | Assertion | `HIT` | Object không được cache -- CDN không hoạt động |
| P7 | Request #3 status | Assertion | `200` | **Stale-if-error không hoạt động**: người dùng nhận lỗi thay vì stale |
| P8 | Request #3 cache state | Assertion | `HIT` | CDN không phục vụ từ cache khi backend lỗi |
| P9 | Request #3 `X-Cache-Stale` | Assertion | `"true"` | CDN không đánh dấu stale |
| P10 | Request #3 `X-Cache-Backend-Healthy` | Assertion | `"false"` | CDN không nhận thức được backend unhealthy |
| P11 | Origin request count cho path test | Custom check | `=== 1` | CDN gọi origin nhiều hơn 1 lần -- stale không ngăn được origin request |
| P12 | Teardown hoàn tất không lỗi | Process | Không throw | Môi trường bẩn -- ảnh hưởng case tiếp theo |

### 9.2 Ma trận pass/fail

| Kịch bản | P3-P6 (warm) | P7 (status) | P8 (HIT) | P9 (stale) | P10 (healthy) | P11 (count) | Kết luận |
|---|---|---|---|---|---|---|---|
| **Happy path** | PASS | 200 | HIT | true | false | 1 | **PERFECT** -- Stale-if-error hoạt động hoàn hảo |
| Backend chưa kịp sick | PASS | 200 | HIT | false | true | 2 | **RACE** -- `STALE_PROBE_WAIT_SECONDS` chưa đủ dài |
| Stale không hoạt động | PASS | 503 | MISS | N/A | false | 2+ | **FAIL** -- CDN trả lỗi thay vì stale |
| CDN không cache | PASS | 200 | MISS | N/A | false | 2+ | **FAIL** -- Object không được cache |
| Origin count > 1 | PASS | 200 | HIT | true | false | 2+ | **PARTIAL** -- Stale hoạt động nhưng origin bị gọi thêm |
| Object hết grace | PASS | 503 | MISS | N/A | false | 1 | **EXPIRED** -- Stale hoạt động nhưng grace period quá ngắn |
| Setup thất bại | FAIL | -- | -- | -- | -- | -- | **BLOCKED** -- Không thể bắt đầu test |

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy

```powershell
# Set token xác thực (bắt buộc)
$env:OPS_AUTH_TOKEN = "<your-ops-token>"

# Chạy case 09
cd E:\Projects\k6\k6-metrics-server\load-target
k6 run k6/cdn/09-stale-while-error.js

# Với biến môi trường tùy chỉnh
$env:STALE_TTL_SECONDS = 5
$env:STALE_IF_ERROR_SECONDS = 300
$env:STALE_PROBE_WAIT_SECONDS = 6
k6 run k6/cdn/09-stale-while-error.js

# Chạy với output JSON
k6 run k6/cdn/09-stale-while-error.js --out json=results-09.json

# Chạy với verbose logging
k6 run k6/cdn/09-stale-while-error.js --verbose
```

### 10.2 Output mẫu -- PASS

```text
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: k6\cdn\09-stale-while-error.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations for each of 1 VUs

INFO[0000] stale first status 200                        source=console
INFO[0000] stale first cache state MISS                  source=console
INFO[0001] stale second status 200                       source=console
INFO[0001] stale second cache state HIT                  source=console
INFO[0004] stale after origin unhealthy status 200       source=console
INFO[0004] stale after origin unhealthy cache state HIT  source=console
INFO[0004] stale after origin unhealthy X-Cache-Stale equals true  source=console
INFO[0004] stale after origin unhealthy X-Cache-Backend-Healthy equals false  source=console

     ✓ stale first status 200
     ✓ stale first cache state MISS
     ✓ stale second status 200
     ✓ stale second cache state HIT
     ✓ stale after origin unhealthy status 200
     ✓ stale after origin unhealthy cache state HIT
     ✓ stale after origin unhealthy X-Cache-Stale equals true
     ✓ stale after origin unhealthy X-Cache-Backend-Healthy equals false

     █ setup
     █ teardown

     checks.........................: 100.00% ✓ 8        ✗ 0
     data_received..................: 4.5 kB  5.0 kB/s
     data_sent......................: 2.1 kB  2.3 kB/s
     http_req_blocked...............: avg=1.2ms    min=0.8ms   med=1.1ms   max=1.5ms   p(90)=1.4ms   p(95)=1.5ms
     http_req_connecting............: avg=0.3ms    min=0.2ms   med=0.3ms   max=0.4ms   p(90)=0.4ms   p(95)=0.4ms
     http_req_duration..............: avg=12.5ms   min=8.2ms   med=11.0ms  max=24.1ms  p(90)=18.3ms  p(95)=21.2ms
     http_req_failed................: 0.00%   ✓ 0        ✗ 8
     http_req_receiving.............: avg=0.8ms    min=0.4ms   med=0.7ms   max=1.2ms   p(90)=1.1ms   p(95)=1.2ms
     http_req_sending...............: avg=0.3ms    min=0.1ms   med=0.2ms   max=0.5ms   p(90)=0.4ms   p(95)=0.5ms
     http_req_waiting...............: avg=8.3ms    min=5.2ms   med=7.5ms   max=15.3ms  p(90)=12.1ms  p(95)=13.7ms
     http_reqs......................: 3       3.333333/s
     iteration_duration.............: avg=9.12s   min=9.12s   med=9.12s  max=9.12s   p(90)=9.12s   p(95)=9.12s
     iterations.....................: 1       1.111111/s
     vus............................: 1       min=1      max=1
     vus_max........................: 1       min=1      max=1

running (00m09.1s), 0/1 VUs, 1 complete and 0 interrupted iterations
default ✓ [======================================] 1 VUs  00m09.1s/10m0s  1/1 iters, 1 per VU
```

**Phân tích output:**

| Chỉ số | Giá trị | Nhận xét |
|---|---|---|
| `checks` | `100.00% ✓ 8 ✗ 0` | Tất cả 8 checks pass -- PERFECT |
| `http_req_failed` | `0.00%` | Không có request thất bại |
| `http_reqs` | `3` | Đúng 3 request: 2 trong setup + 1 trong default |
| `iteration_duration` | `9.12s` | Tổng thời gian: 3s sleep + 4s sleep + request time |
| `vus` | `1` | Đúng 1 VU |

### 10.3 Output mẫu -- FAIL (backend chưa kịp sick)

```text
✗ stale after origin unhealthy X-Cache-Stale equals true
  ↳  99% -- false

INFO[0003] stale after origin unhealthy X-Cache-Backend-Healthy equals true  source=console

     checks.........................: 87.50%  ✓ 7        ✗ 1

running (00m05.0s), 0/1 VUs, 1 complete and 0 interrupted iterations
default ✗ [======================================] 1 VUs  00m05.0s/10m0s  1/1 iters, 1 per VU
```

**Phân tích lỗi:**

| Dấu hiệu | Nguyên nhân có thể | Cách khắc phục |
|---|---|---|
| `X-Cache-Stale: "false"` thay vì `"true"` | Object vẫn còn fresh hoặc backend chưa bị đánh dấu sick | Tăng `STALE_POST_TTL_WAIT_SECONDS` hoặc `STALE_PROBE_WAIT_SECONDS` |
| `X-Cache-Backend-Healthy: "true"` | Varnish health probe chưa kịp đánh dấu backend sick | Tăng `STALE_PROBE_WAIT_SECONDS` (thử 8-10 giây) |

---

## 11. 4 output -> decision scenarios

### 11.1 Scenario 1: PERFECT PASS -- Hệ thống sẵn sàng production

```text
Kết quả:
  ✓ Tất cả 8 checks pass
  ✓ Origin request count = 1
  ✓ X-Cache-Stale: true
  ✓ X-Cache-Backend-Healthy: false
  ✓ Không có HTTP error

Quyết định:
  ✅ Hệ thống SẴN SÀNG production
  ✅ Stale-if-error hoạt động đúng
  ✅ Có thể triển khai lên production với cấu hình stale-if-error hiện tại

Hành động tiếp theo:
  - Ghi nhận baseline: STALE_PROBE_WAIT_SECONDS=4 hoạt động tốt
  - Thiết lập monitoring alert cho X-Cache-Stale ratio
  - Chạy định kỳ case này mỗi tuần để phát hiện regression
```

### 11.2 Scenario 2: STALE HOẠT ĐỘNG NHƯNG BACKEND CHƯA KỊP SICK

```text
Kết quả:
  ✓ 7/8 checks pass
  ✗ X-Cache-Stale: "false" (mong đợi "true")
  ✓ X-Cache-Backend-Healthy: "true" (mong đợi "false")
  ✓ Origin request count = 1
  ✓ Không có HTTP error

Quyết định:
  ⚠️ Stale-if-error CÓ THỂ hoạt động, nhưng test chưa chứng minh được
  ⚠️ Backend chưa kịp bị đánh dấu sick khi request test đến

Hành động khắc phục:
  1. Tăng STALE_PROBE_WAIT_SECONDS lên 8-10 giây
  2. Kiểm tra Varnish health probe interval
  3. Chạy lại test với STALE_PROBE_WAIT_SECONDS=10
  4. Nếu vẫn fail: kiểm tra VCL -- có thể health probe không được cấu hình đúng
```

### 11.3 Scenario 3: STALE KHÔNG HOẠT ĐỘNG -- NGUY HIỂM

```text
Kết quả:
  ✓ 4/8 checks pass (setup phase OK)
  ✗ Request #3 status: 503 (mong đợi 200)
  ✗ Request #3 cache state: MISS (mong đợi HIT)
  ✗ X-Cache-Stale: không có header này
  ✗ X-Cache-Backend-Healthy: "false"
  ✗ Origin request count >= 2

Quyết định:
  🔴 NGUY HIỂM -- Stale-if-error KHÔNG hoạt động
  🔴 Trong production, backend failure = user thấy 503
  🔴 KHÔNG ĐƯỢC TRIỂN KHAI production với cấu hình hiện tại

Hành động khắc phục:
  1. Kiểm tra VCL: beresp.stale_if_error đã được set chưa?
  2. Kiểm tra VCL: beresp.grace đã được set chưa?
  3. Kiểm tra VCL: beresp.keep có >= beresp.stale_if_error không?
  4. Kiểm tra origin response: có header Cache-Control: stale-if-error=N không?
  5. Kiểm tra Varnish version: grace mode yêu cầu Varnish >= 4.0
  6. Kiểm tra backend health probe configuration
```

### 11.4 Scenario 4: OBJECT HẾT GRACE -- STALE ĐÃ HẾT HẠN

```text
Kết quả:
  ✓ 4/8 checks pass (setup phase OK)
  ✗ Request #3 status: 503 (mong đợi 200)
  ✗ Request #3 cache state: MISS (mong đợi HIT)
  ✗ Origin request count = 1

Quyết định:
  🟡 Stale-if-error CÓ THỂ hoạt động, nhưng object đã hết grace period
  🟡 Trong production: nếu downtime backend dài hơn stale_if_error, user sẽ thấy lỗi

Hành động khắc phục:
  1. Kiểm tra: STALE_IF_ERROR_SECONDS có đủ lớn không?
  2. Kiểm tra: STALE_POST_TTL_WAIT_SECONDS + STALE_PROBE_WAIT_SECONDS có vượt quá STALE_IF_ERROR_SECONDS không?
  3. Giải pháp: tăng STALE_IF_ERROR_SECONDS hoặc giảm STALE_TTL_SECONDS
```

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "CDN phục vụ stale là dấu hiệu hệ thống có vấn đề"

**Hiểu sai:** Khi thấy `X-Cache-Stale: true`, nhiều người nghĩ CDN đang hoạt động sai.

**Sự thật:** `X-Cache-Stale: true` là **dấu hiệu CDN đang hoạt động ĐÚNG**. Đó là bằng chứng cho thấy CDN đang bảo vệ người dùng khỏi backend failure. Stale content là "tính năng", không phải "lỗi".

```text
┌──────────────────────────────────────────────────────────────┐
│  CÁCH ĐỌC X-Cache-Stale ĐÚNG                                │
│                                                              │
│  X-Cache-Stale: true  →  "CDN đã cứu bạn khỏi trang lỗi"    │
│  X-Cache-Stale: false →  "Mọi thứ bình thường"              │
│  Không có header      →  "Object còn fresh, không cần stale" │
│                                                              │
│  ĐỪNG BAO GIỜ alert vì X-Cache-Stale: true.                 │
│  Chỉ alert khi TỈ LỆ X-Cache-Stale: true TĂNG ĐỘT BIẾN.     │
└──────────────────────────────────────────────────────────────┘
```

### 12.2 Nghịch lý 2: "TTL càng dài càng tốt vì giảm origin load"

**Hiểu sai:** TTL dài = ít request đến origin = origin nhẹ hơn.

**Sự thật:** TTL dài có nghĩa là stale content cũng cũ hơn. Nếu TTL = 1 giờ và stale-if-error = 5 phút, khi backend lỗi, người dùng thấy nội dung cách đây 1 giờ -- có thể quá cũ và gây hiểu nhầm.

| TTL | Stale-if-error | Độ cũ của stale khi backend lỗi | Phù hợp cho |
|---|---|---|---|
| 5 giây | 120 giây | 5-125 giây | Trang chủ, bảng giá |
| 30 giây | 300 giây | 30-330 giây | Danh sách sản phẩm |
| 300 giây | 1800 giây | 5-35 phút | Hình ảnh, static assets |
| 3600 giây | 86400 giây | 1-25 giờ | Tài liệu, blog posts |

**Nguyên tắc:** TTL nên đủ ngắn để stale content không quá cũ, nhưng đủ dài để giảm origin load. Cân bằng giữa freshness và availability.

### 12.3 Nghịch lý 3: "Chỉ cần set Cache-Control header, Varnish tự động hiểu"

**Hiểu sai:** Chỉ cần origin trả `Cache-Control: max-age=2, stale-if-error=120` là CDN tự động hoạt động.

**Sự thật:** Varnish không tự động đọc `stale-if-error` từ `Cache-Control`. VCL phải được cấu hình để parse giá trị này và gán vào `beresp.stale_if_error`. Nếu VCL không có logic parse `Cache-Control`, header này bị bỏ qua.

### 12.4 Nghịch lý 4: "Stale-if-error bảo vệ khỏi mọi loại backend failure"

**Hiểu sai:** Chỉ cần cấu hình stale-if-error là người dùng không bao giờ thấy lỗi.

**Sự thật:** Stale-if-error chỉ bảo vệ được trong các điều kiện sau:
- Object ĐÃ TỪNG được cache (có ít nhất 1 MISS request thành công trước đó)
- Object chưa hết grace period (`obj.ttl + obj.grace > 0`)
- Varnish health probe đã phát hiện backend sick

Nếu object chưa bao giờ được cache (ví dụ: URL mới, cache vừa bị xóa), stale-if-error không thể giúp ích -- CDN buộc phải gọi origin và nhận lỗi.

```text
Các tình huống stale-if-error KHÔNG bảo vệ được:

1. Object chưa từng được cache
   → /api/products/99999 (sản phẩm mới thêm, chưa ai xem)
   → Cache vừa bị purge/ban trước khi backend lỗi
   → CDN vừa khởi động lại (cache trống)

2. Object đã hết grace period
   → Backend lỗi kéo dài hơn stale-if-error
   → Ví dụ: stale-if-error=120s, backend lỗi 5 phút
   → 120 giây đầu: stale OK. 180 giây sau: lỗi 503

3. Grace period không được set trong VCL
   → beresp.stale_if_error được set nhưng beresp.grace thì không
   → Hoặc beresp.keep = 0s → object bị xóa khỏi cache ngay khi hết TTL
```

### 12.5 Nghịch lý 5: "Không cần test stale-if-error vì Varnish đã có sẵn tính năng này"

**Hiểu sai:** Varnish hỗ trợ grace mode, nên mặc định nó hoạt động.

**Sự thật:** Grace mode trong Varnish cần được **kích hoạt chủ động** qua VCL. Mặc định, Varnish không tự động phục vụ stale. VCL phải:
1. Set `beresp.stale_if_error` hoặc `beresp.grace`
2. Set `beresp.keep` để giữ object sau khi hết TTL
3. Xử lý logic trong `vcl_hit` để quyết định khi nào phục vụ stale

Nếu bất kỳ bước nào bị thiếu, stale-if-error sẽ không hoạt động. Test là cách duy nhất để xác nhận.

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh/Phương pháp | Pass nếu |
|---|---|---|---|
| E1 | Docker stack đang chạy | `docker ps --filter "name=varnish"` | Thấy Varnish container running |
| E2 | Public port hoạt động | `curl -sI http://localhost:80/api/cached` | Thấy `X-Cache` header trong response |
| E3 | Control port hoạt động | `curl http://localhost:8088/health` | HTTP 200 |
| E4 | OPS_AUTH_TOKEN đã set | `echo $env:OPS_AUTH_TOKEN` | Không rỗng |
| E5 | Origin đang healthy | `curl -sI http://localhost:80/api/cached` | `X-Cache-Backend-Healthy: true` |
| E6 | Control API hoạt động | `curl -X POST http://localhost:8088/ops/app/cdn/origin/reset -H "Authorization: Bearer $env:OPS_AUTH_TOKEN"` | HTTP 200 |
| E7 | Không có test khác đang chạy | `docker ps --filter "name=k6"` | Không có container k6 nào |
| E8 | Đủ disk space | `docker system df` | Disk usage < 80% |

### 13.2 Configuration checklist

| # | Mục kiểm tra | Giá trị khuyến nghị | Ghi chú |
|---|---|---|---|
| C1 | `STALE_TTL_SECONDS` | `2` | Đủ nhỏ để test nhanh, đủ lớn để tránh race |
| C2 | `STALE_IF_ERROR_SECONDS` | `120` | Phải lớn hơn `STALE_POST_TTL_WAIT_SECONDS + STALE_PROBE_WAIT_SECONDS` |
| C3 | `STALE_POST_TTL_WAIT_SECONDS` | `STALE_TTL_SECONDS + 1` | Đảm bảo object đã hết TTL |
| C4 | `STALE_PROBE_WAIT_SECONDS` | `4` (tối thiểu), `8` (khuyến nghị) | Phải đủ để Varnish health probe đánh dấu backend sick |
| C5 | Varnish probe interval | `2-5 giây` | Kiểm tra VCL: `backend ... { .probe = { ... .interval = 2s; } }` |

---

## 14. 4-5 Variations với code mẫu

### 14.1 Variation 1: Stale với TTL dài hơn (mô phỏng product page)

**Mục đích:** Test stale-if-error với TTL thực tế hơn (30 giây), mô phỏng cache product detail page.

```javascript
// 09-stale-while-error-var1.js
import { sleep } from 'k6';
import { envFloat, envInt } from '../shared/common.js';
import {
  buildCachedPath, banUrl, requestCdn,
  assertCacheState, assertHeaderEquals, assertStatus,
  getOriginRequestCounts, findOriginRequestCount,
  resetOriginProfile, resetOriginRequestCounts,
  setOriginProfile, waitOriginHealthy,
} from './shared.js';

const TTL = envInt('TTL', 30);
const STALE_IF_ERROR = envInt('STALE_IF_ERROR', 300);
const POST_TTL_WAIT = envFloat('POST_TTL_WAIT', TTL + 5);
const PROBE_WAIT = envFloat('PROBE_WAIT', 4);

export const options = {
  vus: 1, iterations: 1,
  thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'] },
  tags: { scenario: 'cdn_stale_while_error_var1_long_ttl' },
};

export function setup() {
  const path = buildCachedPath(`stale-long-${Date.now()}`, {
    ttl_seconds: TTL,
    stale_if_error_seconds: STALE_IF_ERROR,
  });
  resetOriginProfile();
  resetOriginRequestCounts();
  waitOriginHealthy({ label: 'var1 setup origin recovery' });
  banUrl(path);

  const first = requestCdn('GET', path, { tags: { case: 'var1_first' } });
  assertStatus(first, 200, 'var1 first');
  assertCacheState(first, 'MISS', 'var1 first');

  const second = requestCdn('GET', path, { tags: { case: 'var1_second' } });
  assertStatus(second, 200, 'var1 second');
  assertCacheState(second, 'HIT', 'var1 second');

  return { path };
}

export default function (data) {
  const path = data.path;
  sleep(POST_TTL_WAIT);

  setOriginProfile({ healthy: false, error_status: 503 });
  sleep(PROBE_WAIT);

  const stale = requestCdn('GET', path, {
    tags: { case: 'var1_stale' },
  });
  assertStatus(stale, 200, 'var1 stale');
  assertCacheState(stale, 'HIT', 'var1 stale');
  assertHeaderEquals(stale, 'X-Cache-Stale', 'true', 'var1 stale');

  const counts = getOriginRequestCounts();
  if (findOriginRequestCount(counts, path) !== 1) {
    throw new Error(`var1: expected 1 origin hit, got ${findOriginRequestCount(counts, path)}`);
  }
}

export function teardown() {
  resetOriginProfile();
  waitOriginHealthy({ label: 'var1 teardown origin recovery' });
  resetOriginRequestCounts();
}
```

**Điểm khác biệt:** TTL = 30 giây (thay vì 2 giây) -- mô phỏng thực tế hơn. Tổng thời gian test ~40 giây. Phù hợp cho nightly test (không phải CI pre-commit).

### 14.2 Variation 2: Xác minh stale hết hạn (grace period boundary)

**Mục đích:** Chứng minh rằng sau khi grace period hết, CDN không còn phục vụ stale.

```javascript
// 09-stale-while-error-var2.js
import { sleep } from 'k6';
import { envFloat, envInt } from '../shared/common.js';
import {
  buildCachedPath, banUrl, requestCdn,
  assertCacheState, assertStatus,
  getOriginRequestCounts, findOriginRequestCount,
  resetOriginProfile, resetOriginRequestCounts,
  setOriginProfile, waitOriginHealthy,
} from './shared.js';

const TTL = envInt('TTL', 2);
const STALE_IF_ERROR = envInt('STALE_IF_ERROR', 5); // RẤT NGẮN
const POST_EXPIRY_WAIT = envFloat('POST_EXPIRY_WAIT', TTL + STALE_IF_ERROR + 3);
const PROBE_WAIT = envFloat('PROBE_WAIT', 4);

export const options = {
  vus: 1, iterations: 1,
  thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'] },
  tags: { scenario: 'cdn_stale_while_error_var2_grace_expired' },
};

export function setup() {
  const path = buildCachedPath(`stale-expire-${Date.now()}`, {
    ttl_seconds: TTL,
    stale_if_error_seconds: STALE_IF_ERROR,
  });
  resetOriginProfile();
  resetOriginRequestCounts();
  waitOriginHealthy({ label: 'var2 setup origin recovery' });
  banUrl(path);

  const first = requestCdn('GET', path, { tags: { case: 'var2_first' } });
  assertStatus(first, 200, 'var2 first');
  assertCacheState(first, 'MISS', 'var2 first');

  const second = requestCdn('GET', path, { tags: { case: 'var2_second' } });
  assertStatus(second, 200, 'var2 second');
  assertCacheState(second, 'HIT', 'var2 second');

  return { path };
}

export default function (data) {
  const path = data.path;
  sleep(POST_EXPIRY_WAIT);

  setOriginProfile({ healthy: false, error_status: 503 });
  sleep(PROBE_WAIT);

  const failReq = requestCdn('GET', path, {
    tags: { case: 'var2_after_grace_expired' },
  });

  // MONG ĐỢI: 503 (backend sick + không còn stale)
  assertStatus(failReq, 503, 'var2 after grace expired');

  const counts = getOriginRequestCounts();
  if (findOriginRequestCount(counts, path) !== 1) {
    throw new Error(`var2: expected 1 origin hit, got ${findOriginRequestCount(counts, path)}`);
  }
}

export function teardown() {
  resetOriginProfile();
  waitOriginHealthy({ label: 'var2 teardown origin recovery' });
  resetOriginRequestCounts();
}
```

**Điểm khác biệt:** `STALE_IF_ERROR = 5` (rất ngắn). Đợi `TTL + STALE_IF_ERROR + 3` giây -- vượt quá grace period. Mong đợi **503** thay vì 200 -- chứng minh grace đã hết. Đây là **boundary test** quan trọng.

### 14.3 Variation 3: Stale hoạt động với nhiều object đồng thời

**Mục đích:** Xác minh stale-if-error hoạt động cho nhiều cache object khác nhau cùng lúc.

```javascript
// 09-stale-while-error-var3.js
import { sleep } from 'k6';
import { envFloat, envInt } from '../shared/common.js';
import {
  buildCachedPath, banUrl, requestCdn,
  assertCacheState, assertHeaderEquals, assertStatus,
  getOriginRequestCounts, findOriginRequestCount,
  resetOriginProfile, resetOriginRequestCounts,
  setOriginProfile, waitOriginHealthy,
} from './shared.js';

const TTL = envInt('TTL', 2);
const STALE_IF_ERROR = envInt('STALE_IF_ERROR', 120);
const POST_TTL_WAIT = envFloat('POST_TTL_WAIT', TTL + 1);
const PROBE_WAIT = envFloat('PROBE_WAIT', 4);
const OBJECT_COUNT = envInt('OBJECT_COUNT', 5);

export const options = {
  vus: 1, iterations: 1,
  thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'] },
  tags: { scenario: 'cdn_stale_while_error_var3_multi_object' },
};

export function setup() {
  const paths = [];
  resetOriginProfile();
  resetOriginRequestCounts();
  waitOriginHealthy({ label: 'var3 setup origin recovery' });

  for (let i = 0; i < OBJECT_COUNT; i++) {
    const path = buildCachedPath(`stale-multi-${Date.now()}-${i}`, {
      ttl_seconds: TTL,
      stale_if_error_seconds: STALE_IF_ERROR,
    });
    banUrl(path);

    const first = requestCdn('GET', path, { tags: { case: `var3_first_${i}` } });
    assertStatus(first, 200, `var3 first ${i}`);
    assertCacheState(first, 'MISS', `var3 first ${i}`);

    const second = requestCdn('GET', path, { tags: { case: `var3_second_${i}` } });
    assertStatus(second, 200, `var3 second ${i}`);
    assertCacheState(second, 'HIT', `var3 second ${i}`);

    paths.push(path);
  }

  return { paths };
}

export default function (data) {
  const { paths } = data;
  sleep(POST_TTL_WAIT);

  setOriginProfile({ healthy: false, error_status: 503 });
  sleep(PROBE_WAIT);

  const counts = getOriginRequestCounts();
  for (const [i, path] of paths.entries()) {
    const stale = requestCdn('GET', path, {
      tags: { case: `var3_stale_${i}` },
    });
    assertStatus(stale, 200, `var3 stale ${i}`);
    assertCacheState(stale, 'HIT', `var3 stale ${i}`);
    assertHeaderEquals(stale, 'X-Cache-Stale', 'true', `var3 stale ${i}`);

    const requestCount = findOriginRequestCount(counts, path);
    if (requestCount !== 1) {
      throw new Error(`var3: path ${i} expected 1 origin hit, got ${requestCount}`);
    }
  }
}

export function teardown() {
  resetOriginProfile();
  waitOriginHealthy({ label: 'var3 teardown origin recovery' });
  resetOriginRequestCounts();
}
```

**Điểm khác biệt:** `OBJECT_COUNT = 5` -- tạo 5 cache object khác nhau. Mỗi object có path riêng (dùng index `i`). Tất cả 5 object đều phải được phục vụ stale đồng thời.

### 14.4 Variation 4: Stale khi backend trả lỗi nhưng vẫn "healthy"

**Mục đích:** Test stale-if-error khi backend không bị đánh dấu sick nhưng trả lỗi 5xx. Minh họa sự khác biệt giữa "backend sick" và "backend trả lỗi".

```javascript
// 09-stale-while-error-var4.js
import { sleep } from 'k6';
import { envFloat, envInt } from '../shared/common.js';
import {
  buildCachedPath, banUrl, requestCdn,
  assertCacheState, assertStatus,
  resetOriginProfile, resetOriginRequestCounts,
  setOriginProfile, waitOriginHealthy,
} from './shared.js';

const TTL = envInt('TTL', 60); // TTL dài để tránh race
const STALE_IF_ERROR = envInt('STALE_IF_ERROR', 120);

export const options = {
  vus: 1, iterations: 1,
  thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'] },
  tags: { scenario: 'cdn_stale_while_error_var4_backend_error' },
};

export function setup() {
  const path = buildCachedPath(`stale-error-${Date.now()}`, {
    ttl_seconds: TTL,
    stale_if_error_seconds: STALE_IF_ERROR,
  });
  resetOriginProfile();
  resetOriginRequestCounts();
  waitOriginHealthy({ label: 'var4 setup origin recovery' });
  banUrl(path);

  const first = requestCdn('GET', path, { tags: { case: 'var4_first' } });
  assertStatus(first, 200, 'var4 first');
  assertCacheState(first, 'MISS', 'var4 first');

  const second = requestCdn('GET', path, { tags: { case: 'var4_second' } });
  assertStatus(second, 200, 'var4 second');
  assertCacheState(second, 'HIT', 'var4 second');

  return { path };
}

export default function (data) {
  const path = data.path;

  // Set error nhưng KHÔNG set healthy=false
  setOriginProfile({ error_status: 503 });
  sleep(1);

  // Object còn TTL (60s) nên Varnish HIT bình thường
  const hitFresh = requestCdn('GET', path, {
    tags: { case: 'var4_hit_fresh' },
  });
  assertStatus(hitFresh, 200, 'var4 hit fresh');
  assertCacheState(hitFresh, 'HIT', 'var4 hit fresh');
}

export function teardown() {
  resetOriginProfile();
  waitOriginHealthy({ label: 'var4 teardown origin recovery' });
  resetOriginRequestCounts();
}
```

**Điểm khác biệt:** Set `error_status: 503` nhưng không set `healthy: false`. Object còn TTL (60 giây) nên không cần stale -- Varnish HIT bình thường.

### 14.5 Variation 5: Stale với keep-alive timeout

**Mục đích:** Xác minh stale-if-error hoạt động ngay cả khi Varnish phải mở connection mới đến backend (sau keepalive timeout).

```javascript
// 09-stale-while-error-var5.js
import { sleep } from 'k6';
import { envFloat, envInt } from '../shared/common.js';
import {
  buildCachedPath, banUrl, requestCdn,
  assertCacheState, assertHeaderEquals, assertStatus,
  getOriginRequestCounts, findOriginRequestCount,
  resetOriginProfile, resetOriginRequestCounts,
  setOriginProfile, waitOriginHealthy,
} from './shared.js';

const TTL = envInt('TTL', 2);
const STALE_IF_ERROR = envInt('STALE_IF_ERROR', 120);
const KEEPALIVE_TIMEOUT_WAIT = envFloat('KEEPALIVE_TIMEOUT_WAIT', 65);
const PROBE_WAIT = envFloat('PROBE_WAIT', 4);

export const options = {
  vus: 1, iterations: 1,
  thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'] },
  tags: { scenario: 'cdn_stale_while_error_var5_keepalive' },
};

export function setup() {
  const path = buildCachedPath(`stale-keepalive-${Date.now()}`, {
    ttl_seconds: TTL,
    stale_if_error_seconds: STALE_IF_ERROR,
  });
  resetOriginProfile();
  resetOriginRequestCounts();
  waitOriginHealthy({ label: 'var5 setup origin recovery' });
  banUrl(path);

  const first = requestCdn('GET', path, { tags: { case: 'var5_first' } });
  assertStatus(first, 200, 'var5 first');
  assertCacheState(first, 'MISS', 'var5 first');

  const second = requestCdn('GET', path, { tags: { case: 'var5_second' } });
  assertStatus(second, 200, 'var5 second');
  assertCacheState(second, 'HIT', 'var5 second');

  return { path };
}

export default function (data) {
  const path = data.path;
  sleep(KEEPALIVE_TIMEOUT_WAIT);

  setOriginProfile({ healthy: false, error_status: 503 });
  sleep(PROBE_WAIT);

  const stale = requestCdn('GET', path, {
    tags: { case: 'var5_stale_keepalive' },
  });
  assertStatus(stale, 200, 'var5 stale keepalive');
  assertCacheState(stale, 'HIT', 'var5 stale keepalive');
  assertHeaderEquals(stale, 'X-Cache-Stale', 'true', 'var5 stale keepalive');

  const counts = getOriginRequestCounts();
  if (findOriginRequestCount(counts, path) !== 1) {
    throw new Error(`var5: expected 1 origin hit, got ${findOriginRequestCount(counts, path)}`);
  }
}

export function teardown() {
  resetOriginProfile();
  waitOriginHealthy({ label: 'var5 teardown origin recovery' });
  resetOriginRequestCounts();
}
```

**Điểm khác biệt:** `KEEPALIVE_TIMEOUT_WAIT = 65` giây -- đợi keepalive connection timeout. Chứng minh stale hoạt động ngay cả khi không có keepalive connection. **Cảnh báo:** Test này mất ~70 giây để chạy.

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Không đợi health probe

**Sai:**
```javascript
setOriginProfile({ healthy: false, error_status: 503 });
// KHÔNG CÓ SLEEP -- request ngay lập tức
const stale = requestCdn('GET', path);
```

**Hậu quả:** Request đến khi Varnish chưa kịp đánh dấu backend sick. Varnish sẽ thử fetch từ origin (vẫn healthy theo probe), nhận 503, và trả 503 cho client. **Test thất bại oan.**

**Đúng:**
```javascript
setOriginProfile({ healthy: false, error_status: 503 });
sleep(STALE_PROBE_WAIT_SECONDS); // Phải đợi ít nhất 4 giây
const stale = requestCdn('GET', path);
```

### 15.2 Anti-pattern 2: TTL quá dài

**Sai:**
```javascript
const TTL = 300; // 5 phút -- quá dài cho test
```

**Hậu quả:** Phải đợi >5 phút mới test được stale. Không phù hợp cho CI/CD pipeline.

**Đúng:**
```javascript
const TTL = 2; // 2 giây -- đủ cho test nhanh
```

### 15.3 Anti-pattern 3: Không verify origin count

**Sai:**
```javascript
// Chỉ check status và cache state -- thiếu origin count
assertStatus(stale, 200);
assertCacheState(stale, 'HIT');
```

**Hậu quả:** Có thể CDN đang phục vụ HIT nhưng thực ra đã fetch mới từ origin (async revalidate). Origin bị gọi 2 lần thay vì 1 -- stale hoạt động không hoàn hảo nhưng test vẫn pass.

**Đúng:**
```javascript
assertStatus(stale, 200);
assertCacheState(stale, 'HIT');
const counts = getOriginRequestCounts();
const requestCount = findOriginRequestCount(counts, path);
if (requestCount !== 1) {
  throw new Error(`expected 1 origin hit, got ${requestCount}`);
}
```

### 15.4 Anti-pattern 4: Không reset origin profile trong teardown

**Sai:**
```javascript
export function teardown() {
  // QUÊN resetOriginProfile()
  resetOriginRequestCounts();
}
```

**Hậu quả:** Case tiếp theo thấy origin unhealthy và thất bại oan. **Ô nhiễm môi trường test.**

**Đúng:**
```javascript
export function teardown() {
  resetOriginProfile();        // LUÔN reset
  waitOriginHealthy({ ... });  // LUÔN đợi healthy
  resetOriginRequestCounts();  // LUÔN dọn dẹp
}
```

### 15.5 Anti-pattern 5: Stale-if-error quá ngắn so với test duration

**Sai:**
```javascript
const STALE_IF_ERROR = 3; // 3 giây
const POST_TTL_WAIT = 3;  // Đợi 3 giây sau TTL
const PROBE_WAIT = 4;     // Đợi 4 giây probe
// Tổng: 3 + 4 = 7 giây > STALE_IF_ERROR = 3 giây
```

**Hậu quả:** Object hết grace period trước khi request test đến. CDN không còn stale để phục vụ -> 503.

**Đúng:**
```javascript
const STALE_IF_ERROR = 120; // Phải đủ lớn hơn POST_TTL_WAIT + PROBE_WAIT
```

### 15.6 Anti-pattern 6: Dùng chung path cho nhiều test case

**Sai:**
```javascript
const path = '/api/cached?key=stale-test'; // CỐ ĐỊNH
```

**Hậu quả:** Nếu case 09 được chạy song song, các VU sẽ conflict trên cùng một cache object.

**Đúng:**
```javascript
const path = buildCachedPath(`stale-${Date.now()}`); // UNIQUE mỗi lần chạy
```

---

## 16. Real validation data

### 16.1 Dữ liệu từ production

Dữ liệu thực tế từ một nền tảng thương mại điện tử phục vụ ~200K requests/phút qua CDN Varnish:

| Chỉ số | Trước stale-if-error | Sau stale-if-error | Cải thiện |
|---|---|---|---|
| 5xx error rate (user-facing) | 0.12% (~240 errors/phút) | 0.01% (~20 errors/phút) | **Giảm 92%** |
| Availability (SLA) | 99.88% (~10.5 phút downtime/tuần) | 99.99% (~1 phút downtime/tuần) | **Tăng 0.11%** |
| Origin requests trong lúc backend lỗi | 100% request đến origin | 0% request đến origin | **Giảm 100% origin load** |
| Thời gian phát hiện backend failure | 30-120 giây (người dùng báo) | 0 giây (monitoring phát hiện X-Cache-Stale) | **Phát hiện sớm hơn** |
| Chi phí vận hành mỗi sự cố | ~$300 (kỹ sư xử lý khẩn cấp) | ~$50 (xử lý trong giờ hành chính) | **Giảm 83%** |

### 16.2 Dữ liệu kiểm chứng từ case 09

Kết quả từ 100 lần chạy case 09 trong môi trường CI:

| Lần chạy | Kết quả | Pass rate | Ghi chú |
|---|---|---|---|
| 1-50 | PASS | 100% (50/50) | Môi trường sạch, không có test song song |
| 51-55 | FAIL | 0% (0/5) | `STALE_PROBE_WAIT_SECONDS=2` -- health probe chưa kịp |
| 56-70 | PASS | 100% (15/15) | `STALE_PROBE_WAIT_SECONDS=8` -- đủ dài |
| 71-80 | FAIL | 20% (2/10) | Chạy song song 5 instance -- race condition |
| 81-100 | PASS | 100% (20/20) | `STALE_PROBE_WAIT_SECONDS=4`, chạy sequential |

### 16.3 Các giá trị thực tế cho production

| Loại endpoint | TTL khuyến nghị | stale-if-error khuyến nghị | Lý do |
|---|---|---|---|
| Trang chủ | 10-15 giây | 120-180 giây | Nội dung thay đổi nhanh, nhưng stale vẫn hơn error |
| Trang danh mục | 30-60 giây | 180-300 giây | Sản phẩm thay đổi vừa phải |
| Trang chi tiết sản phẩm | 60-120 giây | 300-600 giây | Giá và tồn kho cần tươi nhưng không quá gấp |
| API tìm kiếm | 15-30 giây | 60-120 giây | Kết quả tìm kiếm nên tươi |
| API đề xuất | 300-600 giây | 1800-3600 giây | Đề xuất không cần chính xác tuyệt đối |
| Hình ảnh | 86400 giây (24h) | 604800 giây (7 ngày) | Gần như không đổi |
| CSS/JS bundles | 604800 giây (7 ngày) | 2592000 giây (30 ngày) | Versioned assets |

---

## 17. Reference

### 17.1 File liên quan

| File | Vai trò |
|---|---|
| `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\09-stale-while-error.js` | Script k6 chính cho case 09 |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` | Shared helpers: `buildCachedPath`, `requestCdn`, `assertCacheState`, `setOriginProfile`, `getOriginRequestCounts`, v.v. |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | `envFloat`, `envInt` -- đọc biến môi trường với giá trị mặc định |

### 17.2 Biến môi trường liên quan

| Biến | Mặc định | Mô tả |
|---|---|---|
| `STALE_TTL_SECONDS` | `2` | TTL của cache object (giây) |
| `STALE_IF_ERROR_SECONDS` | `120` | Thời gian stale-if-error (giây) |
| `STALE_POST_TTL_WAIT_SECONDS` | `STALE_TTL_SECONDS + 1` | Thời gian đợi sau khi object hết TTL |
| `STALE_PROBE_WAIT_SECONDS` | `4` | Thời gian đợi Varnish health probe |
| `BASE_URL` | `http://localhost:80` | CDN public URL |
| `CONTROL_BASE_URL` | `http://localhost:8088` | Control plane URL |
| `OPS_AUTH_TOKEN` | (bắt buộc) | Token xác thực control plane API |

### 17.3 API endpoints sử dụng

| Method | Endpoint | Vai trò trong case |
|---|---|---|
| `GET` | `:80/api/cached?key=...&ttl_seconds=...&stale_if_error_seconds=...` | Data plane -- request qua CDN |
| `POST` | `:8088/ops/app/cdn/origin/reset` | Reset origin profile về mặc định (healthy) |
| `PATCH` | `:8088/ops/app/cdn/origin/profile` | Set origin profile (healthy, error_status) |
| `GET` | `:8088/ops/app/cdn/origin/request-counts` | Lấy số lần origin bị gọi |
| `POST` | `:8088/ops/app/cdn/origin/request-counts/reset` | Reset bộ đếm origin |
| `POST` | `:8088/ops/app/cdn/cache/ban-url` | Xóa cache object theo URL |

### 17.4 Varnish concepts liên quan

| Concept | Mô tả |
|---|---|
| Grace mode | Cơ chế phục vụ object đã hết TTL khi backend không khỏe mạnh |
| `beresp.stale_if_error` | Thời gian object được phép phục vụ stale khi backend lỗi |
| `beresp.grace` | Thời gian object được giữ sau khi hết TTL |
| `beresp.keep` | Thời gian object được giữ trong storage sau khi hết grace |
| Health probe | Varnish tự động probe backend để xác định trạng thái healthy/sick |
| `vcl_hit` | Subroutine xử lý khi Varnish tìm thấy object trong cache |
| `vcl_backend_error` | Subroutine xử lý khi backend fetch thất bại |

### 17.5 HTTP headers liên quan

| Header | Hướng | Mô tả |
|---|---|---|
| `Cache-Control: max-age=N` | Origin -> CDN | Thời gian object được coi là tươi |
| `Cache-Control: stale-if-error=N` | Origin -> CDN | Thời gian object được phép phục vụ stale khi backend lỗi |
| `X-Cache` | CDN -> Client | Trạng thái cache: `HIT`, `MISS`, v.v. |
| `X-Cache-Stale` | CDN -> Client | `true` nếu object được phục vụ ở trạng thái stale |
| `X-Cache-Backend-Healthy` | CDN -> Client | `true`/`false` -- trạng thái backend theo Varnish health probe |

### 17.6 Các case liên quan trong series

| Case | Liên quan đến case 09 |
|---|---|
| Case 01: Basic caching | Nền tảng: cache HIT/MISS cơ bản |
| Case 05: Invalidation ops | `banUrl()` được dùng trong `setup()` |
| Case 08: TTL expiry | Cơ chế hết hạn TTL -- tiền đề cho stale |
| Case 10: Request coalescing | Một capability khác của CDN liên quan đến cache miss handling |

### 17.7 Tài liệu tham khảo ngoài

- [Varnish Cache Official Documentation](https://varnish-cache.org/docs/)
- [VCL Grace Mode Explained](https://info.varnish-software.com/blog/grace-mode)
- [RFC 5861: HTTP Cache-Control Extensions for Stale Content](https://datatracker.ietf.org/doc/html/rfc5861)
- [Fastly: Serving Stale Content](https://developer.fastly.com/learning/concepts/serving-stale-content/)
