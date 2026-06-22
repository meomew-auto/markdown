# Case 09: Stale while origin error error

> Case ID: BLOCK91
> Script: BLOCK92
> *Lac: CDN / Varnish
> Proof: Stale object – while origin unhealthy, with headers + origin-countproof
> Difficulty: ★★★★ (complex — involves origin healthtion, health probe timing, origin request counting, and multi-header proof chain)

## 1. Tình huống thực tế

### Origin chết giữa đợt cao điểm — CDN có cứu được không?

Trường hợp điển hình: 20:00 tối thứ Sáu, flash sale bắt đầu. Hệ thống đang phục vụ buổi họp + cart add của 50,000 người đồng thời. Product detail page đã được cache đầy đủ trên CDN với TTL=60s. Mỗi object vừa được refresh cách đây 2 giây.

Đột nhiên, một microservice trong origin bị OOM. Pod restart, health check fail. Trong 5-15 giây tiếp theo, mỗi request CDN forward về origin sẽ gặp 503.

Không có-while-error: CDN nhận 503 từ origin tra 503 cho user. 50,000 người thay trang lời. Flash sale thất bại. Revenue = 0.

Có-while-error: CDN nhận ra origin không còn healthy (qua health probe độc lập). Object đã hết TTL nhưng vẫn nằm trong grace +-if-error window. CDN QUYET DINH serve object có thay vì forward request user vẫn thay trang sản phẩm đó d d d, chỉ có data "cơ hơn 2 giây." 50,000 người tiếp tục mua hàng. Revenue được bảo toàn. Revenue được bảo toàn. Revenue được bảo toàn. Revenue được bảo toàn. Revenue được bảo toàn. Revenue được bảo toàn. Revenue được bảo toàn.

```text
KHONG CO -while-error
                 ==========================
  User -> CDN -> [object het TTL 2s truoc] -> forward den origin
                                                       |
                                               origin DOWN (503)
                                                       |
  User <- CDN <- 503 Service Unavailable  <------------+

  -> User thay ERROR -> roi khoi site -> revenue LOST


                 CO stale-while-error
                 ==========================
  User -> CDN -> [object het TTL 2s truoc, nhung origin unhealthy]
                        |
                        +--> quyet dinh: serve stale object
(đắt cụ hơn 2 giầy, nhưng VAN LÊ 200)
                        |
  User <- CDN <- 200 OK + X-Cache-Stale: true + data day du

  -> User van thay trang san pham -> tiep tuc mua -> revenue SAVED
```

Đây làavailability feature, không phải performance feature. Stale-while-error không làm site nhanh hơn. No làm site tối tại khi origin không còn tồn tại.

### Không phải "stale = xấu"

Một trong những hiểu lầm lớn nhất về CDN là "stale content = bad." Thực tế:

```text
  Fresh content (origin healthy):   data cach day 0-2 giay -> PERFECT
  Stale content (origin unhealthy): data cach day 2-4 giay -> ACCEPTABLE
  503 error (origin unhealthy):     user thay trang loi      -> CATASTROPHIC

  Stale ALWAYS beats 503.
```

Trong e-commerce, product description, price (không thay đổi trong 2 giây), images — tất cả đều OK nếu bị "treo" vai giò. Con việc user không thể xem được gì cả — đó là disaster.

### Tại sao đây là case QUAN TRƯỜNG NHẬT trong CDN availability suite?

Trong 11 case CDN, case 09 là case đòi hỏi chứng minh khả năng bảo vệ availability của CDN khi origin sap. Các case khác::

```text
  Case 01-02: caching behavior (HIT/MISS, key isolation)
  Case 03-04: bypass rules, query normalization
Case 05-06: invalidation (purge, bán, event)
  Case 07:    cache contract headers, 304
  Case 08:    TTL expiry
  Case 09:    STALE WHILE ERROR  <-- THE AVAILABILITY CASE
  Case 10:    request coalescing (chong stampede)
  Case 11:    negative caching (404 offload)
```

Case 09 trả lời câu hỏi: "Khi origin sắp, CDN có tiếp tục phục vụ user không?" Đây là câu hỏi quan trọng nhất cho mọi business trực tuyến. không có-while-error, mỗi outage của origin là outage của toàn bộ site.

### Các tình huống thực tế cần-while-error

'Flash sale / campaign launch: Origin pressure cao nhất origin để sắc nhanh-while-error là defense line CUOI CUNG.

Database failover: Primary DB mất kết nối * app services bắt đầu tra 503 CDN và serve HTML/JSON products user không thay gì.

'Deploy thất bại]: Rollout version mới bug app crash origin buffy CDN serve từ version cũ user không bị ảnh hưởng team có thời gian rollback.

DĐS vào origin: Attacker target trực tiếp origin origin qua tài CDN (dung origin address khác, hoặc IP allowlist) và serve từ cache +.

DNS / network partition: Origin unreachable do network — không phải origin code fail. Stale vẫn hoạt động.

### Câu hỏi kinh doanh

```text
"Khi origin không còn khả dụng, CDN có giữ được người dùng ở lại trên site?
bằng cách serve objects thay vì tra 503 không?"
```

Đây là câu hỏi vềbusiness continuity, không phải về technical performance.

### Phân tích số học: Giá trị của-while-error

Giá sử một site e-commerce có 100,000 request/phut trong giờ cao điểm. Origin gặp sự cố 5 phút (OOM, restart, health check pass lại).

```text
KHONG có thể-while-error:
100,000 req/phut x 5 phút = 500,000 requests bị 503
    Neu conversion rate = 3%, AOV = $50:
500,000 x 3% = 15,000 đơn hàng bị mất.
    15,000 x $50 = $750,000 revenue lost

  CO stale-while-error:
500,000 requests vẫn được serve (data cũ tối đa 2-60 giây)
Conversion rate có thể giảm (đắt cực) nhưng KHONG về 0
Giá sữa giảm 20% (từ 3% xuống 2.4%):
500,000 x 2.4% = 12,000 đơn hàng vẫn được đặt.
    12,000 x $50 = $600,000 revenue saved
15,000 - 12,000 = 3,000 đơn hàng bị mất (thay vì 15,000)
    $750,000 - $600,000 = $150,000 loss (thay vi $750,000)

  Stale-while-error da cuu $600,000 revenue.
Đây là ROI không lỗ của 20 đồng VCL giấu.
```

### Tại sao-while-error đặc biệt quan trọng cho e-commerce?

Trong e-commerce, có 3 loại page:

```text
  1. Product detail (READ-heavy): user xem sản phẩm.
     -> Cacheable. Stale OK (description, images it thay doi).
     -> Neu 503: user roi khoi trang san pham -> mat sale.

  2. Product listing / search (READ-heavy): user browse danh sách.
     -> Cacheable. Stale OK (danh sach co the thieu san pham moi nhung van xem duoc).
     -> Neu 503: user khong tim thay gi -> roi khoi site.

  3. Cart / checkout (WRITE-heavy): user mua hàng.
     -> KHONG cacheable (co cookie, auth). Stale KHONG ap dung.
     -> Neu 503: user khong the checkout. Nhung IT HON nhieu so voi browse.
     -> Cart service nen duoc protect rieng (circuit breaker, retry, queue).

Stale-while-error bảo vệ loại 1 và 2 — chiếm 80-90% traffic.
10-20% còn lại (cart/checkout) cần chiến lược resilience khác.
```

### Storm sau outage: Ly do-while-error còn quan trọng

Khi đứng sau outage, mỗi object trong CDN đều đã hết TTL. Toàn bộ traffic trở thành MISS. Đây là cách stampede thủ công: quét sạch lớp sơn bóng.

```text
  Origin outage (5 phut):
    -> CDN serve stale -> user OK -> origin duoc bao ve

Origin (phút thứ 6):
    -> 100,000 req/phut den CDN
    -> TAT CA deu MISS (object da het TTL trong 5 phut outage)
    -> CDN forward 100,000 requests den origin CUNG MOT LUC
    -> Origin moi recover, nhan 100,000 concurrent requests -> CO THE LAI SAP

  Stale-while-error + grace keep objects trong cache:
    -> Ngay ca sau khi TTL het, object van trong grace + keep window
    -> CDN co the serve stale trong khi ORIGIN TU TU refresh cache
    -> Tranh duoc "stampede khi recover" — origin co thoi gian on dinh
```

Đây là lý do grace window (120s) và keep window (600s) được cấu hình DAI. Không chỉ để serve trong outage, mà còn để "mở mắt" origin smoothly.

## 2. CDN capability being

Case này chứng minh 4 điều:

### (a) Stale serving được kịch hoạt DIEM Y

Khi origin healthy CDN hoạt động bình thường (MISS HITHIT). Khi origin trở thành organichealthy CDN TONG DAY chuyển sang serving mode, KHONG CHAT HD. Day là automatic circuit breaker ở cache layer.

### (b) Stale serving TRA VE ĐỨNG OBJECT

Không phải "tra về cái gì đó để khởi 503." CDN trả về DUNG object đã được cache trước đó, chỉ là data cũ hơn. User vẫn thay đổi sản phẩm, dung mô ta, dung hình ảnh.

### (c) Stale serving KHONG LIÊN LẬP ĐẢNG ORIGIN

Đây là điểm MAU CHOT. Origin đã unhealthy — nếu CDN vẫn có màu gợi origin trong khi serve, thì origin vẫn bị áp lực và có thể collapse hoàn toàn. Stale serving phải là "origin " — zero additional origin requests.

### (đ) Khi origin, CDN tự động quay lại normal

Sau khi origin healthy trở lại CDN quay lại HIT/MISS bình thường. Không cần manual toggle, không cần flush cache.

### Sequence chứng minh đầy đủ sự xứng đáng đang đáng ngưỡng mộ.

```text
Phase 1: WARMUP (origin healthy)
  Request 1 -> MISS (origin tra 200, CDN cache)
  Request 2 -> HIT  (CDN serve tu cache fresh)
  -> Proves: normal caching works

Phase 2: AGING (origin still healthy, TTL expires)
  sleep(TTL + 1 second)
Object đã hết TTL nhưng vẫn trong grace window
  -> Object is "expired but retainable"

Phase 3: ORIGIN FAILURE
  setOriginProfile({healthy: false, error_status: 503})
  sleep(4s) -> Varnish health probe detects unhealthy
  -> Backend status: SICK

Phase 4: STALE PROBE
  Request 3 -> 200 HIT with X-Cache-Stale: true
  X-Cache-Backend-Healthy: false
  Origin request count: STILL 1 (unchanged from Phase 1)
  -> Proves: CDN served stale WITHOUT contacting origin

Phase 5: RECOVERY
  resetOriginProfile()
  waitOriginHealthy()
  -> Backend status: HEALTHY again
  -> Ready for next test
```

Mỗi phase đều có evidence riêng. Không phase nào được "assume" — tất cả đều được verify qua HTTP headers và origin counters.

### Mất danh sách kiểm tra (taxonomy of checks)

Case 09 có 3 lớp verification, từ nóng đến lạnh:

```text
  Lop 1 — SURFACE: HTTP Status
    ✓ stale probe status = 200
probe status = 503 (FAIL ngày lập tức)

  Lop 2 — HEADERS: Cache mechanism
    ✓ X-Cache: HIT (not MISS)
    ✓ X-Cache-Stale: true
    ✓ X-Cache-Backend-Healthy: false

  Lop 3 — ORIGIN: Request isolation (DEEPEST)
    ✓ Origin request count = 1 (unchanged)
    ✗ Origin request count > 1 (stale failed)
```

Không layer nào được bỏ qua. Lyer 1 có thể pass nhưng layer 2, 3 fail test vẫn FAIL. Đây là "defense indepth" trong CDN testing.

## 3. Vì sao test ở CDN layer

### Đây là test CDN-specific NHAT trong toàn bộ suite

Toàn bộ cơ chế — backend healthing, grace period calculation, serving decision — diễn ra hoàn toàn trong Varnish. Application code không tham gia vào-serving decision.

```text
Application chỉ cung cấp:
    - Data (HTTP response body)
    - Cache-Control headers (TTL, stale-if-error directive)
    - Health endpoint (/health/cdn-origin)

Varnish QUYET ĐIỀN:
    - Backend có healthy không? (qua probe độc lập)
    - Object co trong grace window khong? (obj.ttl + obj.grace > 0s)
    - Serve stale hay return error?
```

### Sớm diễn ra quyết định serve (VCL execution path)

Đây là CHÍNH XỨC những gì xảy ra trong Varnish khi một request đến:

```text
  Client request -> vcl_recv
      |
      +--> hash lookup (tim object trong cache)
      |
      +--> OBJECT FOUND -> vcl_hit
      |        |
      |        +--> obj.ttl >= 0s?
      |        |    YES -> return (deliver)  [FRESH HIT]
      |        |
      |        +--> obj.ttl < 0s (expired)
      |             |
      |             +--> backend healthy? (std.healthy)
      |             |    YES -> return (pass)  [FORWARD TO ORIGIN]
      |             |
      |             +--> backend unhealthy?
      |                  |
      |                  +--> obj.ttl + obj.grace > 0s?
      |                  |    YES -> set X-Cache-Stale
      |                  |           return (deliver)  [STALE HIT]
      |                  |
      |                  +--> obj.ttl + obj.grace <= 0s?
      |                       -> return (pass)  [FORWARD, WILL LIKELY FAIL]
      |
      +--> OBJECT NOT FOUND -> vcl_miss
               -> forward to origin
               -> if origin unhealthy -> origin error -> client gets error
```

Quy định "serve" chỉ xảy ra trong vài hộp, chỉ khi object expired + backend unhealthy + object trong grace window. Tất cả các path khác đều dẫn đến origin.

### Application không thể test-while-error

Neu bạn test ở application layer (direct-to-app, không qua CDN):

```text
  Application test:
    - Origin unhealthy -> app tra 503 -> test FAIL
    - KHONG CO serving, vì... là CDN feature
  
  CDN layer test:
    - Origin unhealthy -> CDN serve stale -> test PASS
    - Đây là chính xác những gì xay ra trong production.
```

Nếu bạn chỉ test application, bạn sẽ không bao giờ biết CDN có-while-error hay không. Đến khi origin sap that user thay 503 bạn mới biết.

### Vì sao không test ở mock environment?

Stale-while-error phu thuoc vao:

1. Health probe timing: Varnish probe backend moi 1 giay, window, threshold
   -> can it nhat 2-3 giay de Varnish detect unhealthy. Mock khong the mo phong
chính xác tim này.

2. 'Grace window calculation: VCL BLOCK93 la runtime calculation
của Varnish. Mock không có VCL runtime.

3. Backend health state transition: BLOCK94 la internal
state của Varnish, bị ảnh hưởng bởi probe history. Mock không mở phòng được.

4. Request : Phải chứng minh CDN KHONG gat hai origin trong serving.
Chỉ có origin request counter that sự (qua control API) mới là evidence tin cậy.

### Làm phụ thuốc

```text
Test case 09 (stale-while-error) YEU CAU:

  Layer 1: k6 script
      |
      +--> Layer 2: Varnish CDN (public :80)
      |       |
      |       +--> Backend health probe -> /health/cdn-origin
      |       +--> Grace calculation -> vcl_hit
      |       +--> Stale deliver -> vcl_deliver
      |
      +--> Layer 3: Control API (:8088)
      |       |
      |       +--> PATCH /ops/app/cdn/origin/profile  (set unhealthy)
      |       +--> POST /ops/app/cdn/origin/reset      (restore healthy)
      |       +--> GET  /ops/app/cdn/origin/request-counts (counter proof)
      |
      +--> Layer 4: Origin app + Nginx
              |
              +--> /api/cached  (returns cached-friendly responses)
              +--> /health/cdn-origin (returns health based on profile)
              +--> Origin request counter (increments on every origin hit)
```

không thể test case này nếu thiếu bất kỳ layer nào. Đây là lý do LOCK95 là bắt buộc cho toàn bộ CDN suite.

### Sổ sành: test ở layer nào thì bay nhiều evidence?

```text
Test ở APP LAYER (direct-to-app, không CDN):
    ✓ Confirm: app returns correct response
KHÔNG THẾ: test sexving (không có CDN)
KHÔNG THẾ: test health probe
KHÔNG THẾ: test origin

Test ở CDN LAYER (qua Varnish):
Confirm: all of the above
    ✓ Confirm: stale serving mechanism
    ✓ Confirm: health probe -> backend sick detection
    ✓ Confirm: origin request isolation (counter proof)
    ✓ Confirm: teardown restores clean state

  Test o MOCK LAYER (simulated Varnish):
    ✓ Confirm: VCL logic (syntax)
KHÔNG THẾ: confirm real Varnish runtime behavior
KHÔNG THẾ: confirm health probe timing
KHÔNG THẾ: confirm actual request
```

Chỉ có CDN layer test mới cung cấp được 100% evidence. Mục test có giá trị cho VCL validation, nhưng không thay thế được CDN layer test.

## 4. Topology & precondition

### Ba path trong runtime

```text
                   k6 script
                      |
          +-----------+-----------+
          |           |           |
     Public CDN   Control API   (event mock
       :80           :8088        :9091 —
                                  not used
                                  in case 09)
          |           |
     Varnish CDN   Go handlers
          |        cdn_origin_control.go
          |           |
     Nginx:80     Redis (profile
          |        + counters)
     App /api/cached
```

### Path 1: Public CDN (:80) — Cache verification path

```text
  k6 -> http://localhost:80/api/cached?key=stale-xxx&ttl_seconds=2&stale_if_error_seconds=120
        -> Varnish -> Nginx -> App -> /api/cached handler
```

Đây là path để verify cache behavior: HIT/MISS, headers, backend health headers, response body. Mọi request đi qua path này đều được Varnish xử lý đầy đủ (vclrecv vclhash vclhit/vclmiss vcl deliver).

### Path 2: Control API (:8088) — Origintion path

```text
  k6 -> http://localhost:8088/ops/app/cdn/origin/profile  (GET/PATCH)
  k6 -> http://localhost:8088/ops/app/cdn/origin/reset    (POST)
  k6 -> http://localhost:8088/ops/app/cdn/origin/request-counts (GET/POST reset)
```

Đây là bước để thao tác origin health profile và độc lập request counters. Yếu cầu BLOCK96 qua BLOCK97 và BLOCK98.

Control API làdirect path — nó đi qua Varnish nhưng Varnish BLOCK99 mới request có BLOCK100 (xem BLOCK101: BLOCK102). Điều này đảm bảo control requests không bị cache, luôn đi thẳng đến app.

### Path 3: Varnish health probe (internal)

```text
  Varnish -> http://nginx:80/health/cdn-origin
          -> App -> CDNOriginHealth handler
```

Varnish probe backend mới 1 giây. Probe này DOC LAP với k6 test — Varnish từ chay probe, k6 chỉ thay đổi origin profile và đối Varnish nhận thấy sự thay đổi.

### Precondition chỉ tiết lộ

Trước khi test bắt đầu, cần đảm bảo:

1. Origin dạng healthy: Gọi BLOCK103 để mặc profile tự dạy.
   test truoc, roi `waitOriginHealthy()` de polling den khi Varnish xac nhan
   backend healthy (profile healthy + CDN healthy + status 200).

2. Origin request counters reset: Gọi BLOCK105 để bắt
Đầu tiên từ 0. Nếu không reset, counters từ test trước sẽ làm nhiễm evidence.

3. URL được clean: Gọi BLOCK106 để object cử (neu có) khỏi Varnish
cache. Đảm bảo request đầu tiên là MISS thất sự.

4. 'Object được warm với TTL ngân: TTL +iferror=120s. TTL ngan
để test nhanh (chỉ cần đổi 3 giấy thay vì 60+ giấy). Stale window dài (120s)
để có đủ thời gian thực hiện probe.

5. Sequence warmup hoàn chỉnh: MISS HIT để xác nhận cách hoạt động::
trước khi mở phòng origin failure. Nếu không có HHIT trước, không có object.
để serve.

### Vì sao TTL = 2 giấy?

```text
  TTL = 2s -> object het han sau 2 giay
  Post-TTL wait = TTL + 1 = 3s -> dam bao object da expired
  Stale-if-error = 120s -> object van trong stale window
  Probe wait = 4s -> du thoi gian Varnish detect unhealthy
Tổng thời gian test ~ 10-12 giây
```

Nếu TTL = 60s, test sẽ cần ít nhất 65 giây (60+1+4). Với 11 cases CDN chạy tuần từ, mỗi giấy tiết kiệm đều có ý nghĩa.

### Điều kiện môi trường.

```text
  TargetLayer = full
  BASE_URL = http://localhost:80
  CONTROL_BASE_URL = http://localhost:8088
  OPS_AUTH_TOKEN = <ops-token>  (bat buoc)
```

Không có BLOCK107 không gọi được control API không set được origin unhealthy không test được. Đây là case BAT BUOC token, khác với case 01-08 có thể chạy không cần token.

## 5. Script deep-dive

Case 09 là script CDN phổ cập nhất trong toàn bộ suite (93 lines). Nó không chỉ verify cache behavior — một con điều khiển origin health state từ bên ngoài, theo đối tác của Varnish, và verify origin request.

### 5.1 Configuration & imports

```javascript
import { sleep } from 'k6';
import { envFloat, envInt } from '../shared/common.js';
import {
  buildCachedPath, banUrl, requestCdn,
  assertCacheState, assertHeaderEquals, assertStatus,
  getOriginRequestCounts, findOriginRequestCount,
  resetOriginProfile, resetOriginRequestCounts,
  setOriginProfile, waitOriginHealthy,
} from './shared.js';

const STALE_TTL_SECONDS = envInt('STALE_TTL_SECONDS', 2);
const STALE_IF_ERROR_SECONDS = envInt('STALE_IF_ERROR_SECONDS', 120);
const STALE_POST_TTL_WAIT_SECONDS = envFloat('STALE_POST_TTL_WAIT_SECONDS', STALE_TTL_SECONDS + 1);
const STALE_PROBE_WAIT_SECONDS = envFloat('STALE_PROBE_WAIT_SECONDS', 4);
```

3 trong 4 knobs được tình toán liên quan đến tim:

- BLOCK108 (2s): TTL cached object. Căng thẳng, test càng nhanh.
- BLOCK109 (120s): Stale window. Phải đủ lớn để test có
đủ thời gian thực thi (12+ giây), nhưng không được quá lớn để tránh bị phạt.
Object ton tai quái nếu teardown fail.
- BLOCK110 (TTL + 1 = 3s): Thời gian đợi sau khi object
hết TTL. +1 để đảm bảo object DA expired, không còn fresh.
- BLOCK111 (4s): Thời gian đội Varnish health probe phát hành.
  hien origin unhealthy. Varnish probe moi 1s, window=3, threshold=2 -> can
  it nhat 2 probes fail. 4s cho phep 3-4 probes -> du margin.

### 5.2Executor options

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

BLOCK112: Day lasingle-VU test. Chỉ cần 1 Vòng chạy 1 lần. Tất cả các request (setup + default + teardown) đều được thực thi tuần tự bởi 1 VU duy nhất. Không cần nhiều VU vì mục tiêu là chung minhcorrectness, không phải throughput.

BLOCK113: 100% checks phải pass. Nếu bất kỳ assertion nào thật (vd: X-Cache không phải HIT, X-Cache-Stale không phải true), k6 exit code!= 0.

BLOCK114: Khong mot HTTP request nao duoc fail (status >= 400 bi coi la that vong khi co LOCK115 ghi d). Trong serving, response 200 la chuan — CDN KHONG tra error status.

### 5.3 setup() — Warming phase

```javascript
export function setup() {
  const path = buildCachedPath(`stale-${Date.now()}`, {
    ttl_seconds: STALE_TTL_SECONDS,
    stale_if_error_seconds: STALE_IF_ERROR_SECONDS,
  });
```

BLOCK116 tạo URL duy nhất: BLOCK117. BLOCK118 đảm bảo URL là duy nhất — không bị conflict với test trước. BLOCK119 được truyền như querymaker; BLOCK120 sẽ set BLOCK121 trong response.

```javascript
  resetOriginProfile();
  resetOriginRequestCounts();
  waitOriginHealthy({ label: 'stale setup origin recovery' });
  banUrl(path);
```

Bộ 4 bước khởi tạo:

1. BLOCK122: POST BLOCK123 — đặt đầu về
   `{healthy: true, error_status: 503}`. Xoa moi profile tu test truoc (co
thế đã bị set unhealthy).

2. `resetOriginRequestCounts()`: POST `/ops/app/cdn/origin/request-counts/reset` —
bắt đầu đếm origin requests từ 0.

3. BLOCK127: Polling loop — gọi BLOCK128 + probe
CDN public URL. Kiểm tra profile healthy=true, X-Cache-Backend-Healthy=true, X-Cache
   status=200. Phai co `stableSamples=2` lan lien tiep de xac nhan. Timeout
12 giày. Đêm báo Varnish đã nhận ra origin healthy.

4. BLOCK130: Xoa object (không có) khôi Varnish cache. Đâm bảo lăn request
đầu tiên sẽ là MISS thật sự.

```javascript
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
```

Hai request warming:

- First: Cache MISS. CDN forward request đến origin. Origin tra 200, Origin tra 200.
  Varnish cache object voi TTL=2s, grace=120s (set trong `vcl_backend_response`).
  Origin request counter +1.

- Second: CacheHIT. CDN serve object tu cache (con fresh, nj.ttl >= 0s).
Origin KHONG được liên lạc. Origin request counter van = 1.

Day laprecondition proof: Neu warming fail (không Hết sau MISS) không có object để serve test vô nghĩa. Script bảo lưu ngày lập tức.

```javascript
  return { path };
}
```

BLOCK132 trả về BLOCK133 cho LOCK134 function. Path được tạo trong setup, dùng lại trong default (stale probe).

### 5.4 default() — Stale serving proof

```javascript
export default function (data) {
  const path = data.path;

  sleep(STALE_POST_TTL_WAIT_SECONDS);
```

BLOCK135 — doi thu het TTL (2s) + 1s margin. Sau sleep nay, object da expired (obj.ttl < CODE395) nhung van trong grace window (obj.ttl + obj.grace > 0s vi grace=120s > 3s).

```javascript
  setOriginProfile({
    healthy: false,
    error_status: 503,
  });
```

**Day la buoc TRONG YEU NHAT.** Goi `PATCH /ops/app/cdn/origin/profile` voi
payload `{healthy: false, error_status: 503}`.

Điều gì xảy ra sau buổi này:

1. Góc cấp nhất BLOCK138 trong memory + Redis.
2. Endpoint BLOCK139 bắt đầu trả 503 thay vì 200.
3. Varnish probe (chạy mỗi 1 giày) gọi BLOCK140 nhận 503.
4. Sau 2/3 probes fail (window, threshold) Varnish đánh dấu backend SICK.
5. BLOCK141 trả về BLOCK142.

```javascript
  sleep(STALE_PROBE_WAIT_SECONDS);
```

BLOCK143 — đối Varnish health probe detect origin unhealthy. Với probe interval=1s, window, threshold, Varnish cần tới ít 2 probes fail (=~2 giây). 4 giây cho phép 4 probes đủ margin cho latency.

```javascript
  const stale = requestCdn('GET', path, {
    tags: { case: 'stale_after_origin_unhealthy' },
  });
  assertStatus(stale, 200, 'stale after origin unhealthy');
  assertCacheState(stale, 'HIT', 'stale after origin unhealthy');
  assertHeaderEquals(stale, 'X-Cache-Stale', 'true', 'stale after origin unhealthy');
  assertHeaderEquals(stale, 'X-Cache-Backend-Healthy', 'false', 'stale after origin unhealthy');
```

Đây là probe — bước chứng minh quan trọng nhất của toàn bộ test.

5 assertions trong ẩn nghĩa:

1. BLOCK144: CĐN trả 200 (không phải 503). User thay trang bình.
Đúng. Day là availability saved.

2. BLOCK145: X-Cache vẫn là HIT (không phải MISS). CDN serve
   tu cache, khong forward den origin. Neu X-Cache la MISS -> CDN da co forward
   -> stale serving failed.

3. BLOCK146: CHUNG MINH object được serve
   tu stale. Header nay chi duoc set trong `vcl_deliver` khi
   `!std.healthy(req.backend_hint) && obj.hits > 0`. Day la "stale signature."

4. BLOCK149: CHUNG MINH Varnish
   da nhan ra origin unhealthy. Header nay duoc set trong `vcl_deliver` dua
   tren `std.healthy(req.backend_hint)`.

5. Origin request count check (đòi hỏi).

```javascript
  const counts = getOriginRequestCounts();
  const requestCount = findOriginRequestCount(counts, path);
  if (requestCount !== 1) {
    throw new Error(`expected stale path ${path} to hit origin exactly once, got ${requestCount}`);
  }
}
```

Đây là IRREFUTABLE PROOF. BLOCK152 gọi BLOCK153 — trả về danh sách các URL và số lần origin được go. BLOCK154 tìm entry cho path của test này.

Neu `requestCount !== 1`:

- BLOCK156: Origin chưa từng được gọi? Không thể — warming phase
Đã có MISS. Có thể warming fail hoặc counters chưa được ghi nhận.
- BLOCK157: CĐN ĐIỂM TRON trong probe! Stale serving
failed — CDN đã forward request thay vì serve. Đây là FAIL.
- BLOCK158: Nghiêm trọng — CĐN gọi ầm nhiều lần. Có thể gat hai.
mechanism không hoạt động, hoặc health probe không detect được oxy.

BLOCK159: PASS hoàn hảo. Chỉ có request warming đầu tiên (MISS) đã gọi origin. Stale probe KHONG gọi origin. Origin được bảo vệ.

### 5.5 teardown() — Recovery phase

```javascript
export function teardown() {
  resetOriginProfile();
  waitOriginHealthy({ label: 'stale teardown origin recovery' });
  resetOriginRequestCounts();
}
```

3 bước cleanup quan trọng:

1. BLOCK160: POST BLOCK161 — đặt dấu về
   `{healthy: true, error_status: 503}`. Neu khong lam buoc nay, origin se
vân nhealthy cho các test case tiếp theo (case 10, 11). Toàn bộ suite
sẽ fail vì origin không thể phục vụ MISS requests.

2. BLOCK163: Polling chờ đến khi Varnish xác nhận origin healthy
trở lại. Đảm bảo backend đã được Varnish lựa lại và đánh dấu HEALTHY.

3. `resetOriginRequestCounts()`: Reset counters cho test case tiep theo.

Teardown là BAT BUOC. Nếu teardown fail, origin sẽ bị ăn ở trang thái unhealthy case 10 (request coalescing) sẽ không thể tạo MISS fail lan truyền. Day là "test" — test A làm rõ rỉ test B.

### 5.6 Full timeline visualization (every sub-second)

```text
  t=0.0s   setup() called
  t=0.1s   resetOriginProfile() -> POST /reset
  t=0.2s   resetOriginRequestCounts() -> POST /counts/reset
  t=0.3s   waitOriginHealthy() starts polling
  t=1.0s   waitOriginHealthy() done (origin already healthy)
  t=1.1s   banUrl(path) -> POST /ban-url
  t=1.2s   Request #1: GET /api/cached?key=stale-xxx&ttl=2... -> 200 MISS
           Origin counter: /api/cached?key=stale-xxx = 1
  t=1.3s   Request #2: GET /api/cached?key=stale-xxx&ttl=2... -> 200 HIT
           Origin counter: /api/cached?key=stale-xxx = 1 (unchanged)
  t=1.4s   setup() returns {path}

======== TRANSITION TO default() ========

  t=1.4s   default() called with {path}
  t=1.4s   sleep(STALE_POST_TTL_WAIT_SECONDS) = 3s

  t=1.5s   [background] Varnish probe: /health/cdn-origin -> 200 (origin healthy)
  t=2.5s   [background] Varnish probe: /health/cdn-origin -> 200 (origin healthy)
  t=3.5s   [background] Varnish probe: /health/cdn-origin -> 200 (origin healthy)

  t=4.4s   sleep(3s) done. Object expired (TTL was 2s, now 3s old)
           setOriginProfile({healthy: false, error_status: 503})
  t=4.5s   sleep(STALE_PROBE_WAIT_SECONDS) = 4s

  t=5.5s   [background] Varnish probe: /health/cdn-origin -> 503 (UNHEALTHY!)
  t=6.5s   [background] Varnish probe: /health/cdn-origin -> 503 (2nd fail)
           -> window=3, threshold=2, 2 of last 3 failed -> BACKEND SICK
           -> std.healthy(backend) = false
  t=7.5s   [background] Varnish probe: /health/cdn-origin -> 503
  t=8.5s   [background] Varnish probe: /health/cdn-origin -> 503

  t=8.5s   sleep(4s) done. Backend has been sick for ~2-3s.
           *** STALE PROBE ***
           Request #3: GET /api/cached?key=stale-xxx&ttl=2... 
           -> vcl_hit: obj.ttl < 0 (expired), backend unhealthy, grace window valid
           -> set X-Cache-Stale = "true"
           -> return (deliver) -> 200 HIT
           -> Origin counter: /api/cached?key=stale-xxx = 1 (STILL 1!)
  
  t=8.6s   getOriginRequestCounts() -> findOriginRequestCount() -> 1
           assert requestCount === 1 -> PASS

  ======== TEARDOWN ========

  t=8.6s   teardown() called
  t=8.7s   resetOriginProfile() -> POST /reset
  t=8.7s   waitOriginHealthy() starts polling
  t=9.5s   [background] Varnish probe: /health/cdn-origin -> 200 (healthy!)
  t=10.5s  [background] Varnish probe: /health/cdn-origin -> 200 (2nd pass)
           -> window=3, threshold=2, 2 of last 3 passed -> BACKEND HEALTHY
  t=10.5s  waitOriginHealthy() done (profile healthy + CDN healthy + status 200)
  t=10.6s  resetOriginRequestCounts() -> POST /counts/reset
  t=10.7s  teardown() done. Test complete.

  Total time: ~10.7s
  HTTP requests: 3 (two warmup + one stale probe) + control requests
  Origin hits: 1 (only the first MISS)
  Stale served: YES (the third request)
```

Đây là toàn bộ hành trình của một-while-error test. Mỗi bước đều được chúng minh không có gì là "assume."

### 5.7 Bản tổng hợp: mỗi phase chúng mình điều gì?

| Phase | Action | Evidence | Proves |
| --- | --- | --- | --- |
| Setup | resetOriginProfile + waitOriginHealthyy | Profile healthy + CDN healthy | Clean starting state |
| Setup | bạnUrl | Cách cleared | Nổ xấu cache from previous run |
| Setup | Request (MISS) | Status 200 + X-Cache: MISS | Object cacheable, origin working Object cacheable Object cacheable Object cacheable |
| Setup | Request (HIT) | Status 200 + X-Cache: Hết! | Cách mechanism working |
| Default | sleep(TTL+1) | Time passes Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time | Object expired |
| Default | setOriginProfile(fail) | Profile unhealthy | Origin failure simulated |
| Default | sleep (s) | Time passes Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time Time | Varnish detected unhealthy |
| Default | Request (stale probe) | 200 + HIT + Stale: true + Backend: false | Stale serving works |
| Default | getOriginRequestCounts | Count = 1 (unchanged) | Origin isolated |
| Teardown | resetOriginProfile + wait | Profile healthy + CDN healthy | Clean state restored |

Mỗi hàng trong bảng là một "micro-assertion." Tất cả 10 micro-assertion đều phải pass để toàn bộ case pass. 9/10 là FAIL.

Đây là toàn bộ hành trình của một-while-error test. Mỗi bước đều được chúng minh không có gì là "assume."

## 6. Origin health model deep-dive

### 6.1 Varnish backend health probe 6.1 Varnish backend health probe 6.1 Varnish backend health probe

Varnish probe backend qua `/health/cdn-origin` endpoint. Cau hinh trong
`default.vcl`:

```vcl
backend default {
    .host = "nginx";
    .port = "80";
    .probe = {
        .url = "/health/cdn-origin";
        .timeout = 1s;
        .interval = 1s;
        .window = 3;
        .threshold = 2;
        .initial = 1;
    }
}
```

Tham số probe:

- BLOCK167: Endpoint được probe. Day là endpoint độc lập,
không phải public URL của test case.
- BLOCK168: Nếu muốn request không có đáp trong 1 giây coi là fail.
- BLOCK169: Probe cháy mới giật. Varnish liên tục theo đuổi sức hấp dẫn.
- BLOCK170: Xét 3 probes gan nhất để quyết định healthy/sick.
- BLOCK171: Cần 2/3 probes thành công (return 200) để coi backend healthy.
Ngược lại, cần 2/3 probes fail để coi backend sick.
- BLOCK172: Khi Varnish khởi động, giá sự backend healthy ngày lập tức (1).

### 6.2 Health probe life cycle

```text
  Origin HEALTHY -> Varnish: HEALTHY  (std.healthy = true)
      |
  setOriginProfile({healthy: false, error_status: 503})
      |
  Probe #1 (t=0s):  /health/cdn-origin -> 503  [FAIL]
  Probe #2 (t=1s):  /health/cdn-origin -> 503  [FAIL]
      |
  window=3, threshold=2 -> 2/3 probes fail -> backend SICK
  std.healthy = false
      |
  Probe #3 (t=2s):  /health/cdn-origin -> 503  [FAIL]
  Probe #4 (t=3s):  /health/cdn-origin -> 503  [FAIL]
      |
Varnish hoạt động trong mode
      |
  resetOriginProfile()
      |
  Probe #5 (t=4s):  /health/cdn-origin -> 200  [PASS]
  Probe #6 (t=5s):  /health/cdn-origin -> 200  [PASS]
      |
  window=3, threshold=2 -> 2/3 probes pass -> backend HEALTHY
  std.healthy = true
```

### 6.3 G: CDNOriginHealth

```go
func (h *Handler) CDNOriginHealth(c *gin.Context) {
    ctx, cancel := context.WithTimeout(c.Request.Context(), cdnOriginProbeRedisTimeout)
    defer cancel()

    profile, source := h.loadCDNOriginProfile(ctx)
    if profile.Healthy {
        c.JSON(http.StatusOK, gin.H{
            "service": "app-service",
            "status":  "ok",
            "source":  source,
        })
        return
    }

    c.JSON(profile.ErrorStatus, gin.H{
        "service":      "app-service",
        "status":       "forced_unhealthy",
        "error_status": profile.ErrorStatus,
        "source":       source,
    })
}
```

Logic đơn giản nhưng CHÍNH XỨC:

- Neu BLOCK173 trả 200 (healthy).
- Nếu BLOCK174 trả BLOCK175 (mức định 503).
- Timeout Redis ctx: 250ms. Không để Redis latency ảnh hưởng đến probe.
- BLOCK176 cho biết profile đến từ "redis" hay "memory" (fallback).

### 6.4 setOriginProfile: PATCH

```go
func (h *Handler) OpsSetCDNOriginProfile(c *gin.Context) {
    var patch cdnOriginProfilePatch
    // ...
    profile, source := h.patchCDNOriginProfile(ctx, patch)
    // ...
}
```

BLOCK177 load profile hiện tại, apply patch, store vào Redis + memory. Cập nhật ATOMIC — không có race condition giữa độc và ghi.

### 6.5 In-memory + Redis dual storage

```go
func (h *Handler) storeCDNOriginProfile(ctx context.Context, profile cdnOriginProfile) (cdnOriginProfile, string) {
    profile = sanitizeCDNOriginProfile(profile)
    if h.redis != nil {
        // Store in Redis first
        if payload, err := json.Marshal(profile); err == nil {
            if err := h.redis.Set(ctx, cdnOriginProfileRedisKey, string(payload), 0); err == nil {
                h.cdnOriginState.setProfile(profile)
                return profile, "redis"
            }
        }
    }
Fallback to in-memory only
    return h.cdnOriginState.setProfile(profile), "memory"
}
```

Hai lớp storage:

1. Redis (primary): Profile được lưu trong Redis key LOCK178.
Khi có Redis, đây là nguồn duy nhất. Health probe độc từ Redis (với 250ms timeout).

2. In-memory (fallback): Khi Redis không khả dụng, profile được lưu trong
   `localCDNOriginState.profile`. Mutex-protected.

### 6.6 Tại sao cần cả in-memory + Redis?

-Redis: Cho phép nhiều instance của app cùng chia sẻ origin profile. Khi API server scale ngang, tất cả instance đều dẫn cùng profile từ Redis. -In-memory: Fallback khi Redis down. Origin health probe vẫn hoạt động ngay cả khi Redis không sử dụng — profile được đơn giản hóa.

### 6.7 Sanitization

```go
func sanitizeCDNOriginProfile(profile cdnOriginProfile) cdnOriginProfile {
    profile.ErrorStatus = clampHTTPErrorStatus(profile.ErrorStatus)
    return profile
}

func clampHTTPErrorStatus(status int) int {
    if status < 400 || status > 599 {
        return http.StatusServiceUnavailable  // 503
    }
    return status
}
```

BLOCK180 phải nằm trong range 400-599. Nếu set ngoài range (vd: 200 khi leo núi, hoặc 999), auto clamp về 503. Dam bảo Varnish mặc nhận được error status thất sự (không thể trả 200 khi LOCK181).

### 6.8 waitOriginHealthy: Polling loop

```javascript
export function waitOriginHealthy(options = {}) {
  const timeoutSeconds = options.timeoutSeconds || ORIGIN_HEALTH_WAIT_TIMEOUT_SECONDS; // 12s
  const intervalSeconds = options.intervalSeconds || ORIGIN_HEALTH_WAIT_INTERVAL_SECONDS; // 0.5s
  const stableSamples = Math.max(1, options.stableSamples || ORIGIN_HEALTH_WAIT_STABLE_SAMPLES); // 2
  // ...
  while ((Date.now() - startedAt) / 1000 <= timeoutSeconds) {
    const profile = getOriginProfile();
    lastProfileHealthy = profile?.data?.profile?.healthy === true;

    const path = buildCachedPath(`health-${Date.now()}-${consecutiveHealthy}`, {
      ttl_seconds: 1,
      origin_delay_ms: 0,
    });
    const probe = requestCdn('GET', path, {
      tags: { case: 'origin_health_wait_probe' },
      responseCallback: http.expectedStatuses({ min: 100, max: 599 }),
    });
    lastStatus = probe.status;
    lastCdnHealthy = getHeader(probe, 'X-Cache-Backend-Healthy') === 'true';

    if (lastProfileHealthy && lastCdnHealthy && lastStatus === 200) {
      consecutiveHealthy += 1;
      if (consecutiveHealthy >= stableSamples) { return { healthy: true, ... }; }
    } else {
      consecutiveHealthy = 0;
    }
    sleep(intervalSeconds);
  }
  fail(`${label} timed out ...`);
}
```

Ba điều kiện phải ĐƯỢC THỰC THỨC MÀO:

1. Profile healthy: BLOCK182 trả về LOCK183. Đây là lần đầu tiên tôi thấy LOCK183.
application-level check — profile đã được reset.

2. CDN healthy: BLOCK184. Đây là Varnish-level check —
Varnish đã probe backend và xác nhận healthy.

3. Status 200: Public CDN request thành công. Đây là end-to-end check.

Căn BLOCK185 lần liên tiếp để xác nhận. Tranh tình hưởng "false positive" khi Varnish vừa chuyển từ sick healthy nhưng chưa ổn định.

BLOCK186 cho phép probe nhận mọi status, không bị coi là HTTP error ngay cả khi backend unhealthy. Điều này quan trọng vì probe được dùng để KIEM TRA unhealthy — nếu nó tự động fail, ta không thể đọc được kết quả.

## 7. Stale-if-error vs Grace mode — THE STAR SECTION

Đây là phân QUAN TRƯỜNG NHẬT để hiệu-while-error trong Varnish. Có hai cơ chế liên quan nhưng KHAC NHƯỢNG.

### 7.1 Grace mode

Grace la co cho cua Varnish: khi object het TTL (obj.ttl < CODE484) nhung van trong grace window (obj.ttl + obj.grace > 0s) VA backend khong healthy, Varnish serve object.

```vcl
sub vcl_hit {
    if (obj.ttl >= 0s) {
        return (deliver);  // Fresh — deliver normally
    }

    // Serve stale while backend is unhealthy.
    if (!std.healthy(req.backend_hint) && obj.ttl + obj.grace > 0s) {
        set req.http.X-Cache-Stale = "true";
        return (deliver);  // Serve stale
    }

    return (pass);  // Backend healthy but object expired -> fetch from origin
}
```

Grace duoc set trong `vcl_backend_response`:

```vcl
if (beresp.ttl > 0s) {
    set beresp.grace = 120s;
    set beresp.keep = 600s;
}
```

Mở cacheable object đều có tốc = 120s. Điều này có nghĩa: sau khi TTL hết, object vẫn có thể được serve trong 120 giây nếu backend unhealthy.

### 7.2 Stale-if-error (Cache-Control directive)

`stale-while-error` la Cache-Control extension (RFC 5861):

```text
  Cache-Control: s-maxage=2, stale-while-error=120
```

Nghĩa là: "chấm object này 2 giờ (fresh). Sau đó, nếu origin tra error (5xx), serve object này thêm 120 giờ nữa."

### 7.3 Cách Varnish kết hợp cả hai

Trong VCL của chúng ta, BLOCK189 được set UNIFORM cho mọi object. Varnish KHONG parse BLOCK190 directive một cách tương tự. Thay vào đó, nó sử dụng grace như-if-error implementation:

```text
  Grace = "serve stale if backend unhealthy, regardless of why"
  Stale-if-error = "serve stale if backend returns error"
  
Trong VCL này: GRACE = STALE-IF-ERROR implementation
Ví: Varnish chỉ serve khi backend unhealthy
       (unhealthy = error responses tu health probe)
```

### 7.4 Sự khác biệt tình tứ giữa Grace và Stale-if-error

| Đác điểm điểm nhấn nhân dịp | Grace mode | Stale-if-error |
| --- | --- | --- |
| Điều kiện hạn chế rò rỉ khí thải. | Backend unhealthy | Origin trả 5xx |
| Co che | Varnish internal | Cache-Control directive |
| Async refresh?! | Có (trong Varnish default) | Không (chị serve) |
| “Health probe dependency?! | Co (std.healthy) | không nhất thiết |
| “Ai đây?! | VCL BLOCK191 | Origin BLOCK192 header |
| *Trong VCL này? | BLOCK193 | Được implement qua grace |

*Điểm khác biệt cốt lõi: Trong Varnish default behavior (không có custom VCL), gạch mode bao gồmsync refresh: Varnish serve object cho client, nhưng DONG THUC gửi một request xuống origin để refresh object. Stale-if-error Khởi làm async refresh — NHUỘNG CO serve và KHONG liên lạc origin.

Trong VCL của chúng ta, BLOCK194 chỉ serve mà KHONG bắt đầu async refresh. Điều này được đảm bảo vì code chỉ BLOCK195 — không có BLOCK196 hay backend request nào được trigger.

### 7.5 Vì sao VCL chỉ serve khi backend unhealthy?

```vcl
if (!std.healthy(req.backend_hint) && obj.ttl + obj.grace > 0s) {
    set req.http.X-Cache-Stale = "true";
    return (deliver);
}
```

Điều kiện KEP:

1. BLOCK197: Backend phải không healthy. Day là prerequisite —
không thể serve nếu backend còn healthy (sẽ forward request thay vì serve).

2. BLOCK198: Object phải trong grace window. Nếu qua gap
window rơi (obj đã bị ép hoạt động hết hạn), không còn gì để serve.

Đây là thiết kế AN TOÀN: chỉ được serve khi origin thật sự không khả dụng. Khi origin healthy, user luôn nhận fresh content.

### 7.6 X-Cache-Stale trong vcldeliver

```vcl
sub vcl_deliver {
    // ...
    if (!std.healthy(req.backend_hint) && obj.hits > 0) {
        set resp.http.X-Cache-Stale = "true";
    } else {
        unset resp.http.X-Cache-Stale;
    }
    // ...
}
```

Cơ chế kiểm soát chặt chẽ:

- Header chi duoc set khi backend unhealthy VA object da tung duoc serve (obj.hits > 0).
- Khi backend healthy, header bị long — test sẽ fail nếu assert có header này.
- BLOCK199 đảm bảo object đã từng được cache — không thể "lạc" một lần
object chưa từng fresh.

### 7.7 TTL, Grace, và Keep — ba giai đoạn của một object

```text
  t=0:        Object duoc cache (MISS -> store)
              TTL = 2s, Grace = 120s, Keep = 600s

  t=0 -> 2s:  FRESH PERIOD (obj.ttl >= 0)
              -> serve fresh tu cache
              -> HIT

  t=2 -> 122s: GRACE PERIOD (obj.ttl < 0, obj.ttl + obj.grace > 0)
              -> neu backend healthy: forward den origin (MISS)
              -> neu backend unhealthy: serve stale (HIT + X-Cache-Stale)

  t=122 -> 722s: KEEP PERIOD (obj.ttl + obj.grace <= 0, obj kept)
              -> object co the duoc dung de tao conditional request
                 (If-None-Match / If-Modified-Since) den origin
              -> khong serve truc tiep cho client

  t > 722s:   OBJECT EVICTED
              -> object bi xoa khoi cache
              -> request tiep theo la MISS
```

Case 09 test trong GRACE PERIOD: TTLs doi 3s van trong dang (3s < CODE504). Neu doi > 122s, object se roi vao KEEP PERIOD va khong duoc serve.

### 7.8 Vì sao góc=120s, keep=600s?

```text
grace=120s: 2 phút. Dự đoán đề:
    - Cho Varnish detect unhealthy (4s)
    - Cho ops team detect outage + (vài giây đến 1-2 phút)
    - Phương vụ traffic trong thời gian origin
    - KHONG quá dài để tranh serve! quá lâu nếu origin thất sự bùng nổ vinh viên

keep=600s: 10 phút. Du dai dẳng:
    - Giữ object trong cache sau khi hết grace
    - Chó phấp conditional revalidation (304) khi origin
    - Tranh eviction som -> giam MISS storm khi origin recover
    - 10 phút là giữa "giọng hát" và "máy pressure"

TTLs (trong test): chỉ để test nhanh
TTL thực tế (production): 60s - 300s tuy loại content
    - Product detail: 60s (ít thay đổi)
    - Product listing: 30s (thay đổi vua phải)
    - Search results: 15s (thay đổi nhanh)
```

### 7.9 Grace behavior trong một số Varnish configurations phổ biến

```text
Config A: KHONG có gạch, KHONG có health check
    -> Origin down -> 503 -> user sees error
    -> Day la "no protection"

  Config B: co grace, KHONG co custom vcl_hit
    -> Default Varnish vcl_hit: serve stale + async refresh
    -> Origin down -> user gets stale (200) BUT origin also gets request
    -> Day la "partial protection" — user OK, origin van bi load

  Config C: co grace, co custom vcl_hit (OUR CONFIG)
    -> Custom vcl_hit: serve stale WITHOUT async refresh
    -> Origin down -> user gets stale (200) + origin NOT contacted
    -> Day la "full protection" — user OK, origin isolated

Config D: có grace, health check nhưng-if-error quá ngán ngẩm
    -> TTL=2s, grace=3s -> object expired, grace expired truoc khi probe detect
    -> Origin down -> stale khong the serve (obj.ttl + obj.grace <= 0s)
    -> Day la "misconfigured" — co co che nhung khong hoat dong
```

Config C (cũng ta) là gold standard. Config D là lời cầu hình phổ biến — hiệu quả ngắn, không kịp hoạt động trước khi object bị rơi khỏi grace window.

## 8. Origin request countingproof — THE EVIDENCE

### 8.1 Vì sao origin request counting là EVIDENCE QUAN TRONG NHẬT?

Không có origin request counting, đây là những gì bạn CO THE sai:

```text
Tình huống A: CĐN trả 200 + X-Cache-Stale: true
  -> Ban ket luan: "STALE WORKED!"
  -> Nhung thuc te: CDN da goi origin, origin tra error,
CDN fallback về object VAF DANH DỰC là.
  -> Origin van bi ap luc, chi la user khong thay error.
  -> STALE FAILED o muc do origin protection.

Tình huống B: CĐN trả 200 + X-Cache-Stale: true
  -> Ban ket luan: "STALE WORKED!"
  -> Nhung thuc te: Origin da tu recover (restart pod),
CDN gọi origin thành công, tra fresh response.
  -> X-Cache-Stale duoc set do Varnish chua nhan ra origin da healthy.
  -> Ban mat evidence origin da thuc su duoc goi.

Tình huống C: CĐN trả 200 + X-Cache-Stale: true
  -> Ban ket luan: "STALE WORKED!"
  -> Nhung thuc te: Object chua tung duoc cache (warming fail).
CDN không thể serve vì không có object.
  -> X-Cache-Stale la GIA? Khong — nhung object lai duoc
cache từ một origin request khác (background refresh).
  -> Origin counting se vach tran: count > 1.
```

Cho co origin request counting moi la irrefutable proof. Noi tra loi cau hoi: "Lau origin co thuc su KHONG bi goi trong probe khong?" Neu count = 1 (sau MISS dau tien) PASS. Neu count > 1 FAIL, bat ke headers noi gi.

### 8.2 Cách origin counter hoạt động

BLOCK200 (trong app) tự động counter mỗi khi origin nhận được request. Counter được qua:

```
GET /ops/app/cdn/origin/request-counts
```

Response:

```json
{
  "success": true,
  "data": {
    "total_requests": 1,
    "source": "redis",
    "counts": [
      {
        "request_key": "/api/cached?key=stale-1737000000000&ttl_seconds=2&stale_if_error_seconds=120",
        "count": 1
      }
    ]
  }
}
```

`findOriginRequestCount()` tim entry co `request_key` trung voi path can test:

```javascript
export function findOriginRequestCount(payload, requestKey) {
  const counts = payload?.data?.counts || [];
  for (const entry of counts) {
    if (entry?.request_key === requestKey) {
      return Number(entry.count || 0);
    }
  }
  return 0;  // path chua tung duoc goi -> count = 0
}
```

### 8.3 Counter timeline trong case 09

```text
Trước setup:
    resetOriginRequestCounts() -> count = 0 (cho moi path)

  Setup - first request (MISS):
    CDN forward den origin -> origin counter +1 -> count = 1

  Setup - second request (HIT):
    CDN serve tu cache -> origin KHONG duoc goi -> count = 1

  Default - sleep(3s):
    Khong request nao -> count = 1

  Default - setOriginProfile({healthy: false}):
    Khong request nao -> count = 1

  Default - sleep(4s):
    Varnish probe goi /health/cdn-origin (NOT /api/cached)
    -> Khong anh huong den counter cua path test -> count = 1

  Default - stale probe:
    CDN serve stale -> origin KHONG duoc goi -> count = 1
ĐIỂM LÀ ĐIỂM MẶT CHẾT

Neu count = 2 ở đây:
    CDN da forward request den origin -> STALE FAILED
```

### 8.4 Tại sao counter không bị ảnh hưởng bởi health probe?

Varnish health probe gọi BLOCK203, KHONG PHỨC BLOCK204. Health probe là request độc lập, không liên quan đến counter của URL test.

`findOriginRequestCount` tim chinh xac `request_key` trung khop — khong bi
nhầm lẫn với health probe path.

### 8.5 Counter reset va test

Nếu không reset counter trước mỗi test:

```text
  Case 08 (TTL expiry): MISS -> count +1
  Case 09 (stale): MISS -> count +1 (cua case 09) + count cua case 08 = 2
  -> findOriginRequestCount tra ve 2 -> test FAIL SAI
```

BLOCK207 trong setup và teardown đảm bảo mọi case bắt đầu từ 0. Đây là "test " — mỗi case độc lập, không bị ảnh hưởng bởi case trước.

## 9. Key signals/headers

### Bang headers và ý nghĩa

| Signal Signal | Expected Value | Y nghĩa | Vì sao QUAN TRƯỜNG |
| --- | --- | --- | --- |
| HTTP Status | BLOCK208 | User thay trang bình thường. | Stale save availability. 503 = FAIL. |
| BLOCK209 | BLOCK210 | CDN serve từ cache (không forward) | Nếu MISS CDN đã gọi origin failed failed failed |
| BLOCK211 | BLOCK212 | Object duoc serve tu xa | THE SIGNAL. Chi co khi backend unhealthy + nj.hits > 0 |
| BLOCK213 | BLOCK214 | Varnish xác nhận origin lhealthyy | Chứng minh điều kiện được kiện hoãn DUNG |
| BLOCK215 | BLOCK216 | Object đã được serve ít nhất 3 lần (warming 2 + 1) | Xác nhận object đã tồn tại trong cache |
| Origin request count | BLOCK217 | Chỉ MISS đầu tiên gọi origin | IRREFUTABLE PROOF: probe không gii nội tạng. |
| Response body | Product data | Data cũ nhưng đầy đủ. | User vẫn thay nội dung bình thường. |

### Cách độc X-Cache-Stale DUNG

```text
  X-Cache-Stale co mat -> stale serving DANG DIEN RA
  X-Cache-Stale khong co -> object duoc serve fresh HOAC tu origin
  
X-Cache-Stale CHI CO MAT khi:
    1. Backend unhealthy (std.healthy = false)
    2. Object da duoc cache (obj.hits > 0)
    3. Object trong grace window (obj.ttl + obj.grace > 0s, duoc check trong vcl_hit)
    
Nếu X-Cache-Stale có mặt nhưng X-Cache-Backend-Healthy = true:
    -> LOGIC ERROR trong VCL — khong the stale khi backend healthy
    -> Can investigate vcl_deliver logic
```

### Cách đọc X-Cache-Backend-Healthy DUNG

```text
  X-Cache-Backend-Healthy = true
    -> Varnish da probe backend va nhan 200 tu /health/cdn-origin
    -> Origin profile dang healthy
    -> Stale serving KHONG nen duoc kich hoat
  
  X-Cache-Backend-Healthy = false
    -> Varnish nhan error (503) tu /health/cdn-origin
    -> Origin profile dang unhealthy
    -> Day la dieu kien CAN cho stale serving
```

### Các header BO SUNG (không đẹp nhưng có giá trị diệt)

| Header | Mo ta | Khi nào có mắt. |
| --- | --- | --- |
| BLOCK218 | Tuổi của object (seconds) | Khi object đã được cache. |
| BLOCK219 | Node Varnish đã xử lý request | Luật có hiệu lực. |
| BLOCK220 | Origin service đã xử lý | Chỉ khi MISS |
| BLOCK221 | Standard HTTP Age header | Khi từ cache |
| BLOCK222 | Cách directives | Đổ origin set |

## 10. Pass/fail criteria

### PASS criteria (tập cả phải ĐƯỜNG THỨC)

| # | Criteria | Assertion in script | Weight |
| --- | --- | --- | --- |
| P1 | k6 exit code = 0 | Natural (checks rate=1, no throw) | Mandatory |
| P2 | Warmup sequence MISS HIT | BLOCK223 + BLOCK224 | Mandatory |
| P3 | Stale probe status = 200 | BLOCK225 | Mandatory |
| P4 | Stale probe X-Cache = HIT | BLOCK226 | Mandatory |
| P5 | X-Cache-Stale = true | BLOCK227 | Mandatory |
| P6 | X-Cache-Backend-Healthy = false | BLOCK228 | Mandatory |
| P7 | Origin request count = 1 | BLOCK229 | Critical |
| P8 | Teardown restores healthy origin | BLOCK230 in teardown | Mandatory |
| P9 | Zero HTTP errors. | BLOCK231 | Mandatory |

### FAILs (chỉ cần 1 là FAIL)

| # |  | What failed | Impact |
| --- | --- | --- | --- |
| F1 | k6 exit!= 0 | Any assertion failed | Test invalid |
| F2 | Warmup MISS MISS (nổ HẬT) | Object not cached — cần't test Object not cached Object | Test meaninglessless |
| F3 | Stale probe = 503 | CDN error instead of error. | CDN - serving broken |
| F4 | Stale probe = 200 but X-Cache = MISS | CDN forwarded to origin despite unhealthy drugs | Stale dot ngot kick inbox |
| F5 | Stale probe = 200, HIGH Bang no X-Cache-Stale | Response fresh, not Scratch. | Origin máy bayed or not configured? |
| F6 | X-Cache-Backend-Healthy = true during probe | Origin not unhealthy by Varnish | Health profile change didn't 'totete' |
| F7 | Origin request count > 1 | CDN contacted origin during probe | 'Stale origin protection FAILED® |
| F8 | Origin request count = 0 | Warming phase may have got cache HIT from previous test. | Counters not reset. |
| F9 | Teardown fail (waitOriginHealthy timeout) | Origin stuck unhealthy | Pollutes all subsequent cases. |

### Vì sao P7 (origin count=1) là CRITICAL?

P7 phân biệt "stale thất sự" và "stale giả":

- Stale thất sự: CDN serve object cũ, KHONG liên lạc origin = 1.
- Stale gia re: CDN goi origin (origin error/healthy), roi serve object cu = count > 1.
- Stale giá (background refresh): CDN serve cho client những async
  refresh tu origin -> count > 1 (co the la 2).

Chỉ có P7 mới phân biệt được ba tính hưởng này. Headers không thể.

## 11. Cách chạy + output

### Prerequisites

```powershell
# 1. Tất cả dịch phải chạy (TargetLayer=full)
#    - Nginx, Varnish, App, Redis

# 2. Đảm bảo Varnish đang mặc backend
#    Kiem tra: Varnish log hoac GET http://localhost/health/cdn-origin

# 3. Co OPS_AUTH_TOKEN
#    Case 09 BAT BUOC tống vì can thiệp control API
```

### Run command

```powershell
cd E:/Projects/k6/k6-metrics-server

$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

./scripts/run-cdn-capabilities.ps1 -Scenarios 09-stale-while-error
```

### Timing overrides (optional)

```powershell
# Mac dinh: TTL=2s, wait=3s, probe_wait=4s -> ~10s total
# Có thể override để dbug hoặc performance testing:

$env:STALE_TTL_SECONDS = "5"          # TTL dai hon
$env:STALE_POST_TTL_WAIT_SECONDS = "6" # Wait theo TTL
$env:STALE_PROBE_WAIT_SECONDS = "5"    # Them margin cho probe
```

### Expected output (PASS)

```text
  running (00m10.0s), 1/1 VUs, 9 complete and 0 interrupted iterations
  default ✓ [======================================] 1 VUs  00m10.0s/10m0s  1/1 shared iters

  ✓ stale first status 200
  ✓ stale first cache state MISS
  ✓ stale second status 200
  ✓ stale second cache state HIT
  ✓ stale after origin unhealthy status 200
  ✓ stale after origin unhealthy cache state HIT
  ✓ stale after origin unhealthy X-Cache-Stale equals true
  ✓ stale after origin unhealthy X-Cache-Backend-Healthy equals false

  checks.........................: 100.00% ✓ 8        ✗ 0
  http_req_failed................: 0.00%   ✓ 0        ✗ 9

  All checks passed. Exit code: 0
```

### Điểm cần lưu ý trong output

1. Số lượng checks = 8: 2 warmup + 4 + 2 health wait (không hiện thị).
trong output trên những waitOriginHealthy tạo checks riêng). Tất cả phải pass.

2. httphttpreqfailed = 0.00%: Tất cả requests đều thành công. Nếu có request
   fail, kiem tra `responseCallback` cua health probe — no cho phep 100-599,
nhưng probe phải là 200.

3. Thời gian ~10s: 3s (post-TTL wait) + 4s (probe wait) + request latency.
   Neu dai hon nhieu, co the `waitOriginHealthy` dang polling lau.

4. Không có BLOCK234 assertion fail: Neu header này thật, có thể
Varnish chưa detect oxyy (probe hất khí dương) hoặc VCL thiếu logic.

### Cháy trong CI pipeline

```powershell
# CI can override timing for speed:
$env:STALE_TTL_SECONDS = "1"
$env:STALE_POST_TTL_WAIT_SECONDS = "1.5"
$env:STALE_PROBE_WAIT_SECONDS = "3"

# Total CI time: ~5.5s (vs ~10s local)
# Trade-off: less margin for health probe detection
# If CI flakes: increase STALEPROBEWAITSECONDS to 5

# CI must have OPS_AUTH_TOKEN secret
$env:OPS_AUTH_TOKEN = $env:CI_OPS_AUTH_TOKEN

# Run single case for speed in PR checks
./scripts/run-cdn-capabilities.ps1 -Scenarios 09-stale-while-error
```

### Cách verify kết quả trực tiếp (manual)

Ngoại k6 output, bạn có thể verify từng bước bằng curl:

```bash
# 1. Kiểm tra origin profile hiện tại
curl -s http://localhost:8088/ops/app/cdn/origin/profile \
  -H "Authorization: Bearer $OPS_AUTH_TOKEN" | jq .

# 2. Kiểm tra origin request counts
curl -s http://localhost:8088/ops/app/cdn/origin/request-counts \
  -H "Authorization: Bearer $OPS_AUTH_TOKEN" | jq .

# 3. Set origin unhealthy
curl -s -X PATCH http://localhost:8088/ops/app/cdn/origin/profile \
  -H "Authorization: Bearer $OPS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"healthy": false, "error_status": 503}' | jq .

# 4. Probe stale (after waiting for Varnish to detect unhealthy)
curl -s -I "http://localhost/api/cached?key=manual-test&ttl_seconds=2&stale_if_error_seconds=120"

# 5. Reset origin
curl -s -X POST http://localhost:8088/ops/app/cdn/origin/reset \
  -H "Authorization: Bearer $OPS_AUTH_TOKEN" | jq .
```

### Đác điểm tim của case 09 so với các case CDN khác

| Case | Thời gian. | Sleep | Ly do |
| --- | --- | --- | --- |
| cdn-01 | ~1s | 0 | Simple MISSHIT, no wait needed! |
| cdn-08 | ~22s | 21s (TTL wait) | Wait for TTL expiry |
| cdn-09 | *10s | 3s + 4s | TTL expiry + health probe detection |
| cdn-10 | ~1s | 0 | Concurrent requests, no wait! |
| cdn-11 | ~35s | 15s + 15s | Two TTL waits for negative cache. |

Case 09 có thời gian chạy vừa phải (~10s) — dài hơn case đơn gian (01-07) nhưng ngắn hơn case TTL (08, 11). Lý do cần 2 lần sleep: một để object hết TTL, một để Varnish phát hiện unhealthy.

### Expected output (FAIL vì dụ)

```text
  ✗ stale after origin unhealthy status 200
    ↳  92% — expected 200, got 503

  ✗ stale after origin unhealthy X-Cache-Stale equals true
    ↳  92% — expected 'true', got ''

  ERRO[0010] expected stale path /api/cached?... to hit origin exactly once, got 2
```

Fail này có nghĩa: CDN đã gọi origin (count) VA tra 503. Stale hoàn toàn không hoạt động. Nguyên nhân có thể:

- VCL BLOCK235 không có logic (thiếu LCK236).
- BLOCK237 không được set = obj.ttl + nj.grace = 0 (grace không tới tại)
- Origin unhealthy profile không được apply (control API fail)
- Health probe không detect được unhealthy (probe URL sai, lập quá dài)

## 12. 4 output = decision

### Scenario A: ALL PASS — "CDN-while-error, origin outage protected"

```text
  Output:
    ✓ stale first MISS
    ✓ stale second HIT
    ✓ stale probe 200 + HIT + X-Cache-Stale: true + X-Cache-Backend-Healthy: false
    Origin request count = 1

  Decision: DEPLOY READY
    -> CDN da chung minh kha nang bao ve availability khi origin sap.
    -> Neu origin that su chet trong production, user van thay noi dung.
    -> Doi ngung co the ngu ngon khi flash sale dien ra.

  Next steps:
    -> Tiep tuc test case 10 (request coalescing) va 11 (negative caching).
    -> Consider: vary stale-if-error duration (variation 1).
    -> Consider: test with real traffic spike (variation 2).
```

### Scenario B: 503 INSTEAD OF STALE — "stale-if-error not configured"

```text
  Output:
    ✓ stale first MISS
    ✓ stale second HIT
    ✗ stale probe status 200 -> got 503
    ✗ X-Cache-Stale -> not present

  Root cause analysis:

    1. Check VCL vcl_hit:
       sub vcl_hit {
           if (obj.ttl >= 0s) { return (deliver); }
           if (!std.healthy(req.backend_hint) && obj.ttl + obj.grace > 0s) {
               set req.http.X-Cache-Stale = "true";
               return (deliver);
           }
           return (pass);
       }
       -> Is this code block present? If missing -> stale never triggers.

    2. Check beresp.grace:
       if (beresp.ttl > 0s) {
           set beresp.grace = 120s;
       }
       -> Is grace being set? If beresp.grace = 0s -> obj.ttl + 0 > 0s = false.

    3. Check health probe:
       backend default {
           .probe = {
               .url = "/health/cdn-origin";
               .interval = 1s;
               .window = 3;
               .threshold = 2;
           }
       }
       -> Is probe working? Check Varnish log: varnishlog -g request -q "ReqUrl eq '/health/cdn-origin'"

    4. Check origin profile change:
       GET http://localhost:8088/ops/app/cdn/origin/profile
       -> Is healthy: false? If still true -> PATCH didn't work.

Decision: DO NOT DEPLOY
    -> No stale serving. Any origin outage = full site outage.
    -> Fix VCL or origin health configuration before proceeding.
```

### Scenario C: 200 BUT X-Cache-Stale MISSING — "fresh response, origin may not actually be unhealthy" Scenario

```text
  Output:
    ✓ stale probe status 200
    ✓ stale probe X-Cache: HIT
    ✗ X-Cache-Stale: expected 'true', got '' (or header absent)

  Sub-type analysis:

  C1: X-Cache-Backend-Healthy = true, X-Cache-Stale absent
      -> Origin was NEVER marked unhealthy by Varnish
      -> Varnish health probe may still show healthy
      -> Root cause: probe wait too short, or profile change didn't propagate
      -> Fix: Increase STALE_PROBE_WAIT_SECONDS to 8s
      -> Verify: curl /ops/app/cdn/origin/profile -> healthy should be false

  C2: X-Cache-Backend-Healthy = false, X-Cache-Stale absent
      -> Origin IS unhealthy per Varnish
      -> But stale header logic is missing from vcl_deliver
      -> Root cause: vcl_deliver doesn't set X-Cache-Stale header
      -> Fix: Add the header set logic in vcl_deliver

  C3: X-Cache: MISS (not HIT) + X-Cache-Stale absent
      -> CDN forwarded to origin (object not found in cache)
      -> Root cause: object evicted before grace window
      -> Check: Is keep >= total test duration?

  Decision tree:
    X-Cache is HIT?
      YES -> X-Cache-Backend-Healthy is false?
             YES  -> C2 (VCL missing stale header)
             NO   -> C1 (origin not actually unhealthy)
      NO  -> C3 (object evicted or not cached)

  Possible explanations:

    A. X-Cache-Backend-Healthy = true
       -> Origin was NOT marked unhealthy by Varnish.
       -> Health probe may not have detected the change yet.
       -> Solution: Increase STALE_PROBE_WAIT_SECONDS (try 6-8s).
       -> Or: Check Varnish probe interval — may be > 1s.

    B. X-Cache-Backend-Healthy = false, but X-Cache-Stale absent
       -> VCL vcl_deliver may be missing the X-Cache-Stale set logic:
          if (!std.healthy(req.backend_hint) && obj.hits > 0) {
              set resp.http.X-Cache-Stale = "true";
          }
       -> Check if this block exists in vcl_deliver.

    C. Object was never cached (obj.hits = 0)
       -> Warmup phase may have failed silently.
       -> Check: did second request return HIT?
       -> If second was MISS (not HIT) -> object not cached -> can't serve stale.

  Decision: INVESTIGATE
    -> The 200 is misleading — it may be a fresh response that happened
       to succeed (origin recovered before probe), not a stale serve.
    -> Fix the VCL or timing before retesting.
```

### Scenario D: ORIGIN COUNT INCREASED — "CDN contacted origin despite unhealthy status" Scenario

```text
  Output:
    ✓ All header checks pass (200, HIT, X-Cache-Stale: true, X-Cache-Backend-Healthy: false)
    ✗ Origin request count = 2 (or more) — expected 1

  This is the MOST DANGEROUS failure mode. Everything LOOKS correct —
  headers say stale, status is 200 — but the CDN actually contacted origin.

  Root cause analysis:

    A. Async refresh (Varnish grace behavior):
       Default Varnish grace includes async refresh:
       - Serve to client
       - BBUT ALSO send background request to origin to refresh
       -> Origin counter +1
       -> Solution: Custom VCL vcl_hit that does NOT trigger background refresh.
          Our VCL only does "return (deliver)" — no background fetch.

    B. Vcl_miss triggered instead of vcl_hit:
       If object was evicted from cache (not just expired, but evicted):
       - vcl_hit not executed -> vcl_miss -> fetch from origin -> counter +1
       -> Check: Is grace/keep configured? keep = 600s prevents eviction.

    C. Stale serving in vcl_deliver but request still went to backend:
       Some VCL patterns: vcl_hit returns (pass) -> vcl_miss -> fetch backend
       -> Response delivered but headers added in vcl_deliver
       -> Solution: vcl_hit must return (deliver), NOT (pass).

    D. Multiple probe requests counted incorrectly:
       Health probe path (/health/cdn-origin) is DIFFERENT from cache path.
       But if findOriginRequestCount matches wrong path...
       -> Check: is the path matching correct?

  Decision: CRITICAL FAILURE
    -> CDN is NOT protecting origin. This is a silent failure —
       users see 200, but origin is still under load.
    -> In production, this means origin will collapse under
       retry storms even with "stale serving enabled."
    -> Fix VCL immediately.

  Specific VCL checklist for scenario D:

    1. Open default.vcl, go to vcl hit:
       - Does it have the stale serving block?
       - Does stale block return (deliver) not (pass)?
       - Is the condition: !std.healthy(backend) && obj.ttl + obj.grace > 0s?

    2. Check vcl_backend_response:
       - Is beresp.grace set? (beresp.grace = 120s;)
       - Is it set for ALL cacheable objects, or only some?
       - 5xx responses have beresp.uncacheable = true — make sure
         the test object doesn't trigger this rule

    3. Check vcl_deliver:
       - Does it set X-Cache-Stale? (informational only, not causal)
       - Does it have the correct condition?

    4. Check vcl_backend_fetch (if exists):
       - Is there any logic that retries on backend failure?
       - Retry = additional origin requests = counter increases

    5. Verify with varnishlog:
       varnishlog -g request -q "ReqUrl ~ 'api/cached'"
       -> Check if request went through vcl_hit or vcl_miss
       -> If vcl_miss: object not found in cache -> eviction issue
       -> If vcl_hit but backend contacted: async refresh enabled
```

## 13. Nghịch lý / misconceptions

### Misconception 1: "Stale = xấu, fresh = tốt"

```text
SAI. Trong bộ cánh origin failure:

  Fresh 0s old + 503 status  = user thay ERROR       = CATASTROPHE
Stale 4s old + 200 status = user thay sản phẩm = BUSINESS AS USUAL

Stale trong trường hợp này LA TOT. Nó là safety net.
Stale luôn luôn TOT HỢP error.
```

### Misconception 2: "Origin down = site down"

```text
SAI (neu có-while-error). Với-while-error:

  Origin down + CDN co cache + stale policy = site VAN UP (serving stale)
Origin down + CDN KHONG có cache = site DOWN (không có gì để serve)

Stale-while-error biến CDN thành "static backup" cho dynamic content.
```

### Misconception 3: "Stale-while-error chi chostatic content"

```text
SAI. Stale-while-error hoạt động cho BAT KY cacheable object nào:
  - HTML fragments (product descriptions)
  - JSON API responses (product detail, category list)
  - Images (đã được cache)
  - Search results (neu được cache)
  
Điều kiện duy nhất: object phải được cache VA trong grace window.
Không phân biệtstatic vs dynamic.
```

### Misconception 4: "Grace vaif-error giong het nhau"

```text
SAI. Sự khác biệt (xem Section 7):

Grace: Varnish-specific. Có thể bao gồm async refresh.
Stale-if-error: HTTP Cache-Control directive. Chỉ serve, không refresh.

Trong VCL này: GĐ ĐƯỢC SỰ DÙNG để implement-if-error.
Nhưng chúng là hai khai niệm khác nhau.
```

### Misconception 5: "Nếu origin healthy, không bao giờ được serve"

```text
ĐƯỜNG — những dấu là ĐIỂM TOT. Stale chỉ nên được serve khi origin.
KHÓNG KHỨNG. Khi origin healthy, user xung đăng nhận fresh content.

Neu được serve ngay cả khi origin healthy:
  -> Stale policy qua aggressive -> user nhan data cu khong can thiet
  -> Can adjust: chi serve stale khi origin unhealthy, khong phai luon luon
```

### Misconception 6: "Status 200 nghĩa là chết hoạt động"

```text
SAI. Status 200 có thể đến từ:
  - Stale serving (WHAT WE WANT TO PROVE)
  - Origin đã (tương đương nhưng thực tế là fresh)
  - CĐN gọi origin, origin trả 200 (số KHONG hoạt động)
  
Phải verify QUA HEADERS + ORIGIN COUNT. Status 200 không đủ.
```

### Misconception 7: "TTL ngân + gạch đá là vô nghĩa"

```text
SAI. TTL ngân + hiệu bạc là STRATEGY:

TTL = 2s: object được refresh thường xuyên khi origin healthy.
Grace = 120s: khi origin unhealthy, object có thể serve 120s.
  
Đây là "fresh when possible, when necessary."
Không phải "stale luôn luôn."
```

### Misconception 8: "Stale-while-error thay thế được monitoring và alerting"

```text
SAI. Stale-while-error là LAST LINE OFDEFENSE, không phải replacement:

Monitoring + Alerting: PHÁT HÀNH outage, notify team.
Stale-while-error: GIU site running TRONG KỶ HỆP.
  
Nếu chỉ có-while-error mà không monitoring:
  -> Origin co the down 10 phut, CDN serve stale, user OK
  -> Nhung team KHONG BIET origin down -> khong fix
  -> Object het grace window -> site DOWN -> user moi biet
  
Stale-while-error MUA THỨC GIAN cho team fix. NÓ KHỨNG FIX outage.
```

### Misconception 9: "Cánh cảnh tra Cache-Control:-while-error mới hoạt động"

```text
SAI (trong cấu hình VCL này). VCL đặt UNIFORM grace=120s cho
TAT CA cacheable objects. Origin KHONG CAN set-while-error.
directive. Varnish từ áp dụng grace policy.

Tuy nhiên, trong production thực tế:
  - Origin NEN set-while-error để bảo hiệu
  - Varnish CO THE ton trong directive này (neu được cấu hình)
  - Những trong VCL của chúng ta: gạch được set uniform, bắt kẻ origin header...
```

## 14. Checklist

### Pre-run

- [ ] BLOCK238 — tất cả dịch chay (Varnish + Nginx + App + Redis)
- [ ] Varnish đang chạy và probe BLOCK239
- [ ] Control API tại BLOCK240
- [ ] BLOCK241 được set (case này BAT BUOC)
- [ ] Origin request counters hoạt động (kiem tra GET endpoint)
- [ ] Không có case CDN nào khác đang chạy (tranh shared state)

### Run-time

- [ ] Warmup sequence: MISS HIT (xác nhận cách hoạt động)
- [ ] BLOCK242 thành công (kỳ tra hiệu)
- [ ] Du thoi gian cho Varnish probe detect unhealthy (>= 4s voi interval=1s)
- [ ] Stale probe: 200 + HIT + X-Cache-Stale: true + X-Cache-Backend-Healthy: false
- [ ] Origin request count = 1 (chỉ MISS đầu tiên)
- [ ] Teardown successful: origin healthy trở lại

### Post-run

- [ ] k6 exit code = 0
- [ ] Tất cả checks pass (checks rate = 100%)
- [ ] Zero HTTP errors (httpreqfailed = 0%)
- [ ] Origin profile đã được reset (kỳ tra GET endpoint)
- [ ] Origin counters đã được reset (sách cho case tiếp theo)
- [ ] Nợ xấu state pollutes cdn-10, cdn-11

## 15. 4-5 variations

### Variation 1: Different-if-error durations

```javascript
// 09-stale-while-error-duration.js
// Test: stale-if-error = 10s (very short)
// vs  stale-if-error = 3600s (1 hour)

const SHORT_STALE = envInt('STALE_IF_ERROR_SECONDS', 10);

// Test sequence:
// 1. Warm object with TTL=2s, stale-if-error=10s
// 2. Origin unhealthy at t=5s -> stale serve SUCCEEDS (5 < 10)
// 3. Origin unhealthy at t=15s -> stale serve FAILS (15 > 10)
// -> Proves: stale window is respected exactly
// -> Proves: after stale window, object cannot serve (returns error)

// Diagnostic value:
// - If stale succeeds at t=15s when window is 10s ->
//   VCL is using a different grace value, not respecting stale-if-error
// - If stale fails at t=5s when window is 10s ->
//   Stale mechanism not working at all

const LONG_STALE = envInt('STALE_IF_ERROR_SECONDS', 3600);

// Test sequence:
// 1. Warm object with TTL=2s, stale-if-error=3600s
// 2. Origin unhealthy at t=100s -> stale serve SUCCEEDS
// 3. Origin unhealthy at t=500s -> stale serve SUCCEEDS
// 4. Origin unhealthy at t=3500s -> stale serve SUCCEEDS
// 5. Origin unhealthy at t=3700s -> stale serve FAILS
// -> Proves: long stale window covers extended outages
// -> Proves: boundary condition at exactly 3600s
```

### Variation 2: Origin slow (not dead)

```javascript
// 09-stale-while-error-slow.js
Thay vì origin tra 503, origin CHAM (30s timeout)
// Varnish probe: first_byte_timeout = 30s
// Neu probe timeout -> Varnish marks backend sick -> serve stale

// Test:
// setOriginProfile({healthy: true, error_delay_ms: 30000})
// -> /health/cdn-origin treo 30s
// -> Varnish probe timeout (1s probe timeout)
// -> Backend marked sick
// -> Stale serve succeeds
// -> Origin NOT contacted during slowdown

// DIFFERENCE from main case:
// - Main case: origin returns 503 (error)
// - This case: origin is SLOW (timeout, not error)
// - Both should trigger stale serving
// - Proves: stale works for BOTH hard failures and degradations

// Diagnostic value:
// - Timeout-based detection is often HARDER than status-based
// - If status-based works but timeout-based fails ->
//   Varnish first_byte_timeout may be too long or probe timeout not configured
// - If both work -> CDN protects against all failure modes
```

### Variation 3: Stale + revalidation (conditional request)

```javascript
// 09-stale-while-error-revalidate.js
// Object has ETag from origin
// During stale serving: CDN serves stale response
// When origin recovers: CDN sends If-None-Match -> 304 -> serve fresh

// Test:
// 1. Warm object (get ETag)
// 2. Origin unhealthy -> stale serve (200 + X-Cache-Stale)
// 3. Origin healthy -> next request = MISS (expired) + If-None-Match
//    -> 304 if unchanged, 200 if changed
// -> Proves: stale doesn't break revalidation chain
```

### Variation 4: Multiple objectseously

```javascript
// 09-stale-while-error-multi.js
// Cache 10 different objects with TTL=2s, stale=120s
// Set origin unhealthy
// Probe all 10 -> ALL must return 200 + stale headers
// Origin count = 10 (each object had 1 MISS in warmup) — not 11+

// Test:
// const paths = [];
// for (let i = 0; i < 10; i++) {
//   const path = buildCachedPath(`stale-multi-${Date.now()}-${i}`, {
//     ttl_seconds: 2, stale_if_error_seconds: 120
//   });
//   // Warm each: MISS -> HIT
//   paths.push({path, warmed: true});
// }
// setOriginProfile({healthy: false, error_status: 503});
// sleep(4);
// for (const {path} of paths) {
//   const res = requestCdn('GET', path);
//   assertStatus(res, 200);
//   assertCacheState(res, 'HIT');
//   assertHeaderEquals(res, 'X-Cache-Stale', 'true');
// }
// const counts = getOriginRequestCounts();
// // Each path should have EXACTLY 1 origin hit
// for (const {path} of paths) {
//   const c = findOriginRequestCount(counts, path);
//   if (c !== 1) throw new Error(`path ${path}: expected 1, got ${c}`);
// }
// -> Proves: stale serving scales to many objects
// -> Proves: origin isolation holds for ALL objects, not just first one

// Diagnostic value:
// - If some objects pass but others fail -> cache eviction issue
// - If all fail -> stale mechanism broken globally
// - If origin count > 10 -> some origin requests leaked through
```

### Variation 5: Smoke (fast check)

```javascript
// 09-stale-while-error-smoke.js
// Minimal version: TTL=1s, post-TTL wait=2s, probe wait=3s
// Total time: ~6s instead of ~10s
// Use in CI pipeline where speed matters

// Test:
// Same assertions as full case, but with tighter timing
// -> Fast PASS/FAIL for regression detection
// -> If smoke fails -> run full case for debugging
```

## 16. Anti-patterns

### Anti-pattern 1: Trusting status codes without origin count

```text
  SAI: "Stale probe returns 200 -> PASS"
  DUNG: "Stale probe returns 200 + X-Cache-Stale + origin count=1 -> PASS"
  
Status 200 là căn cứ KHONG dự. Origin count là bằng chứng.
  CDN KHONG lien lac origin. Thieu origin count -> khong biet
! có thật sự hoạt động hay không.
```

### Anti-pattern 2: Too-short-if-error (or none at all)

```text
SAI:-if-error = 2s (bảng TTL)
  -> Object vua het TTL cung het stale window
  -> Khong co thoi gian de detect unhealthy
  
  DUNG: stale-if-error >> TTL + probe wait
  -> stale-if-error = 120s, TTL = 2s, probe wait = 4s
  -> 2 + 4 = 6s << 120s -> du thoi gian
```

### Anti-pattern 3: Forgetting to reset origin health in teardown

```text
  SAI: Test stale xong -> khong reset origin -> origin van unhealthy
  -> Case 10 (request coalescing) can MISS -> goi origin -> origin 503
  -> Case 10 FAIL vi origin unhealthy
  
  DUNG: teardown() LUON reset origin + wait healthy + reset counters
  -> Day la "leave no trace" pattern
```

### Anti-pattern 4: Testing before proving normal caching works

```text
  SAI: Skip warmup -> set unhealthy ngay -> request
  -> Neu response 503: la do origin unhealthy hay do cache chua co object?
  -> KHONG THE BIET -> test meaningless
  
  DUNG: MISS -> HIT (prove caching works) -> then test stale
  -> Neu stale fail, ta biet chac la do stale mechanism,
không phải do cách cô bán.
```

### Anti-pattern 5: Setting probe wait too short

```text
  SAI: sleep(1) after setOriginProfile -> probe immediately
  -> Varnish moi co <= 1 probe -> chua du window=3, threshold=2
  -> std.healthy() van true -> stale khong kich hoat
  
  DUNG: sleep(4) minimum -> 4 probes, it nhat 2-3 fail
  -> 2/3 window, threshold=2 -> backend SICK -> std.healthy() = false
```

### Anti-pattern 6: Using the same URL across test runs

```text
  SAI: path = buildCachedPath('stale-fixed') -> same path every run
  -> Object co the con trong Varnish cache tu run truoc
  -> Warmup MISS thanh HIT -> counter = 0 (chua tung goi origin)
  -> assertion requestCount !== 1 -> fail SAI
  
  DUNG: path = buildCachedPath(`stale-${Date.now()}`) -> unique every run
  -> banUrl() clean + Date.now() unique -> MISS that su
```

## 17. Real validation data

### Expected values (template)

```text
  Case ID:          cdn-09-stale-while-error
  Script version:   09-stale-while-error.js (93 lines)
  Executor:         shared-iterations (vus=1, iterations=1)
  Duration:         ~10-12s

  Stage 1: Warmup (setup)
    Request 1: GET /api/cached?key=stale-{ts}&ttl_seconds=2&stale_if_error_seconds=120
               Status: 200, X-Cache: MISS
    Request 2: Same URL
               Status: 200, X-Cache: HIT

  Stage 2: Origin failure
    PATCH /ops/app/cdn/origin/profile {"healthy":false,"error_status":503}
    -> Response: {"success":true,"data":{"profile":{"healthy":false,"error_status":503}}}

  Stage 3: Stale probe (default function)
    Request 3: Same URL
               Status: 200
               X-Cache: HIT
               X-Cache-Stale: true
               X-Cache-Backend-Healthy: false
               X-Cache-Hits: >= 3

  Stage 4: Origin count verification
    GET /ops/app/cdn/origin/request-counts
    -> count for this path: 1

  Stage 5: Teardown
    POST /ops/app/cdn/origin/reset
    -> Response: {"success":true,"data":{"profile":{"healthy":true,"error_status":503}}}

  Expected checks: 8 passed, 0 failed
  Expected exit code: 0
```

### Actual run notes (to fill after execution)

```text
  Run date:      [YYYY-MM-DD HH:MM]
  Run by:        [name]
  Environment:   [local / staging / CI]
  Result:        [PASS / FAIL]
  Duration:      [actual seconds]
  Origin count:  [actual number]
  Notes:         [any observations]
```

### Troubleshooting quick reference

```text: k6 exits with "OPSAUTHTOKEN (or OPSTOKEN) is required" FIX: BLOCK272 = "<token>" This case is MANDATORY token — cannot run without it.

: waitOriginHealthy() timeout (12s) CAUSE: Varnish health probe may not be reaching /health/cdn-origin CHECK: curl BLOCK268 Should return 200 OK CHECK: curl BLOCK269 Should show {"healthy":true,...} FIX: Ensure Varnish + Nginx + App are running Ensure Varnish backend probe URL is correct Ensure Varnish backend probe URL is correct Ensure Varnish backend probe URL is correct Ensure Varnish backend probe URL is correct

: Stale probe returns 503 instead of 200 CAUSE: Object may have been evicted from cache, or grace window too short CHECK: Is obj.ttl + obj.grace > 0s? Grace must be set in VCL. CHECK: Did the second request in setup return HIT? If not, object't cached. FIX: Increase STALEIF ERRORSECONDS (ensure grace window is) Check vclbackendresponse: beresp.grace must be > 0

: Stale probe returns 200 but X-Cache-Stale is CAUSE: X-Cache-Stale is only set when backend is unhealthy. If backend is still healthy serving not triggered. CHECK: curl LOCK270 healthy should be false CHECK: Wait longer: STALEPROBEWAITSECONDS may not be enough for Varnish to detect unhealthy (probe interval 2 fails) FIX: Increase STALEPROBEWAITSECONDS to 6 or 8 users (tuy theo từng người)

: Origin request count = 2 (or more) CAUSE: CDN contacted origin during probe CHECK: Is vcl hit returning (deliver) or (pass)? If (pass) vcl hit returning (deliver) for

: Teardown waitOriginHealthy() timeout — origin stuck unhealthy CAUSE: resetOriginProfile() may have failed silently CHECK: curl -X POST BLOCK271 \ -H "Authorization: Bearer BLOCK273" Should return {"success":true,"data":{"profile":{"healthy":true}}} FIX: Manually call reset before running next case If persistent: restart app to clear in-memory state, restart all data in the app, restart all data in the app, restart all data in the app

## 18. Reference

- Run guide: BLOCK243
- Overview (00overview.md): BLOCK244 — especially the "Common invalid-result patterns" table (stale case pass vi status 200 is a listed anti-pattern)
- Script source: BLOCK245 (93 lines)
- Shared helpers: BLOCK246 — BLOCK247, BLOCK248, BLOCK249, BLOCK250, BLOCK251, BLOCK252, BLOCK24
- VCL (stale logic): BLOCK253 — BLOCK254 (lines 190-202), BLOCK255 (lines 204-258), BLOCK256 (lines 270-302), BLOCK256 (lines 263-382), BLOCK256 (lines 263-382)
- Origin health: BLOCK257 (357 lines) — BLOCK258, BLOCK259, BLOCK260, BLOCK261, BLOCK262, BLOCK262, BLOCK
- Case catalog: BLOCK263
- CDN README: BLOCK264
- Lyer roadmap: BLOCK265
- Sibling cases: cdn-01 through cdn-11 (full CDN suite)
- RFC 5861 (HTTP Cache-Control Extensions for Stale Content): BLOCK266 directive specification
- Varnish dac: Grace mode and health checks: BLOCK267
