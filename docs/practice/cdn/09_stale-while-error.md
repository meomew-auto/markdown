# Case 09: Stale while origin error

> **Case ID:** `cdn-09-stale-while-error`
> **Script:** `09-stale-while-error.js`
> **Layer:** CDN / Varnish
> **Proof:** Stale object served while origin unhealthy, with headers + origin-count proof
> **Difficulty:** ★★★★ (complex — involves origin health manipulation, health probe timing, origin request counting, and multi-header proof chain)

## 1. Tinh huong thuc te

### Origin chet giua dot cao diem — CDN co cuu duoc khong?

Truong hop dien hinh: 20:00 toi thu Sau, flash sale bat dau. He thong dang phuc vu
browse + cart add cua 50,000 nguoi dong thoi. Product detail page da duoc cache day
du tren CDN voi TTL=60s. Moi object vua duoc refresh cach day 2 giay.

Dot nhien, mot microservice trong origin bi OOM. Pod restart, health check fail.
Trong 5-15 giay tiep theo, moi request CDN forward ve origin se gap 503.

**Khong co stale-while-error**: CDN nhan 503 tu origin -> tra 503 cho user.
50,000 nguoi thay trang loi. Flash sale that bai. Revenue = 0.

**Co stale-while-error**: CDN nhan ra origin khong con healthy (qua health probe
doc lap). Object da het TTL nhung van nam trong grace + stale-if-error window.
CDN QUYET DINH serve object cu thay vi forward request -> user van thay trang
san pham day du, chi co data "cu hon 2 giay." 50,000 nguoi tiep tuc mua hang.
Revenue duoc bao toan.

```text
                 KHONG CO stale-while-error
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
                             (data cu hon 2 giay, nhung VAN LA 200)
                        |
  User <- CDN <- 200 OK + X-Cache-Stale: true + data day du

  -> User van thay trang san pham -> tiep tuc mua -> revenue SAVED
```

Đây làavailability feature, không phải performance feature. Stale-while-error không làm site nhanh hơn. No làm site tốn tài khi origin không còn tồn tại.

### Khong phai "stale = xau"

Một trong những hiểu lầm lớn nhất về CDN là "stale content = bad." Thực tế:

```text
  Fresh content (origin healthy):   data cach day 0-2 giay -> PERFECT
  Stale content (origin unhealthy): data cach day 2-4 giay -> ACCEPTABLE
  503 error (origin unhealthy):     user thay trang loi      -> CATASTROPHIC

  Stale ALWAYS beats 503.
```

Trong e-commerce, product description, price (neu khong thay doi trong 2 giay),
images — tat ca deu OK neu bi "tre" vai giay. Con viec user khong the xem
duoc gi ca — do la disaster.

### Tai sao day la case QUAN TRONG NHAT trong CDN availability suite?

Trong 11 case CDN, case 09 la case **duy nhat** chung minh kha nang bao ve
availability cua CDN khi origin sap. Cac case khac:

```text
  Case 01-02: caching behavior (HIT/MISS, key isolation)
  Case 03-04: bypass rules, query normalization
  Case 05-06: invalidation (purge, ban, event)
  Case 07:    cache contract headers, 304
  Case 08:    TTL expiry
  Case 09:    STALE WHILE ERROR  <-- THE AVAILABILITY CASE
  Case 10:    request coalescing (chong stampede)
  Case 11:    negative caching (404 offload)
```

Case 09 tra loi cau hoi: "Khi origin sap, CDN co tiep tuc phuc vu user khong?"
Day la cau hoi quan trong nhat cho moi business truc tuyen. khong co stale-while-error,
moi outage cua origin la outage cua toan bo site.

### Cac tinh huong thuc te can stale-while-error

'Flash sale / campaign launch: Origin pressure cao nhất origin dễ sập nhất-while-error là defense line CUOI CUNG.

**Database failover**: Primary DB mat ket noi -> app services bat dau tra 503 ->
CDN van serve stale HTML/JSON products -> user khong thay gi.

'Deploy thất bại]: Rollout version mới bug app crash origin buffy CDN serve từ version cũ user không bị ảnh hưởng team có thời gian rollback.

ĐĐS vào origin: Attacker target trực tiếp origin origin qua tài CDN (dung origin address khác, hoặc IP allowlist) và serve từ cache +.

DNS / network partition: Origin unreachable do network — không phải origin code fail. Stale vẫn hoạt động.

### Cau hoi kinh doanh

```text
"Khi origin khong con kha dung, CDN co giu duoc nguoi dung o lai tren site
 bang cach serve stale objects thay vi tra 503 khong?"
```

Đây là câu hỏi vềbusiness continuity, không phải về technical performance.

### Phan tich so hoc: Gia tri cua stale-while-error

Gia su mot site e-commerce co 100,000 request/phut trong gio cao diem. Origin gap
su co 5 phut (OOM, restart, health check pass lai).

```text
  KHONG co stale-while-error:
    100,000 req/phut x 5 phut = 500,000 requests bi 503
    Neu conversion rate = 3%, AOV = $50:
    500,000 x 3% = 15,000 don hang bi mat
    15,000 x $50 = $750,000 revenue lost

  CO stale-while-error:
    500,000 requests van duoc serve (data cu toi da 2-60 giay)
    Conversion rate co the giam (data cu) nhung KHONG ve 0
    Gia su conversion giam 20% (tu 3% xuong 2.4%):
    500,000 x 2.4% = 12,000 don hang van duoc dat
    12,000 x $50 = $600,000 revenue saved
    15,000 - 12,000 = 3,000 don hang bi mat (thay vi 15,000)
    $750,000 - $600,000 = $150,000 loss (thay vi $750,000)

  Stale-while-error da cuu $600,000 revenue.
  Day la ROI khong lo cua 20 dong VCL config.
```

### Tai sao stale-while-error dac biet quan trong cho e-commerce

Trong e-commerce, co 3 loai page:

```text
  1. Product detail (READ-heavy): user xem san pham.
     -> Cacheable. Stale OK (description, images it thay doi).
     -> Neu 503: user roi khoi trang san pham -> mat sale.

  2. Product listing / search (READ-heavy): user browse danh sach.
     -> Cacheable. Stale OK (danh sach co the thieu san pham moi nhung van xem duoc).
     -> Neu 503: user khong tim thay gi -> roi khoi site.

  3. Cart / checkout (WRITE-heavy): user mua hang.
     -> KHONG cacheable (co cookie, auth). Stale KHONG ap dung.
     -> Neu 503: user khong the checkout. Nhung IT HON nhieu so voi browse.
     -> Cart service nen duoc protect rieng (circuit breaker, retry, queue).

  Stale-while-error bao ve loai 1 va 2 — chiem 80-90% traffic.
  10-20% con lai (cart/checkout) can chien luoc resilience khac.
```

### Storm sau outage: Ly do stale-while-error con quan trong HON

Khi đứng sau outage, mọi object trong CDN đều đã hết TTL. Toàn bộ traffic trở thành MISS. Đây là cách stampede thu cấp:

```text
  Origin outage (5 phut):
    -> CDN serve stale -> user OK -> origin duoc bao ve

  Origin recover (phut thu 6):
    -> 100,000 req/phut den CDN
    -> TAT CA deu MISS (object da het TTL trong 5 phut outage)
    -> CDN forward 100,000 requests den origin CUNG MOT LUC
    -> Origin moi recover, nhan 100,000 concurrent requests -> CO THE LAI SAP

  Stale-while-error + grace keep objects trong cache:
    -> Ngay ca sau khi TTL het, object van trong grace + keep window
    -> CDN co the serve stale trong khi ORIGIN TU TU refresh cache
    -> Tranh duoc "stampede khi recover" — origin co thoi gian on dinh
```

Day la ly do grace window (120s) va keep window (600s) duoc cau hinh DAI.
Khong chi de serve stale trong outage, ma con de "ramp up" origin smoothly.

## 2. CDN capability being proved

Case nay chung minh 4 dieu:

### (a) Stale serving duoc kich hoat DUNG LUC

Khi origin healthy CDN hoạt động bình thường (MISS HITHIT). Khi origin trở thành organichealthy CDN TỔNG ĐÂY chuyển sang serving mode, KHONG CAN human. Đây là automatic circuit breaker ở cache layer.

### (b) Stale serving TRA VE DUNG OBJECT

Khong phai "tra ve cai gi do de khoi 503." CDN tra ve DUNG object da duoc cache
truoc do, chi la data cu hon. User van thay dung san pham, dung mo ta, dung hinh anh.

### (c) Stale serving KHONG LIEN LAC DEN ORIGIN

Đây là điểm MAU CHOT. Origin đã unhealthy — nếu CDN vẫn có màu gọi origin trong khi serve, thì origin vẫn bị áp lực và có thể collapse hoàn toàn. Stale serving phải là "origin " — zero additional origin requests.

### (d) Khi origin recover, CDN tu dong quay lai normal

Sau khi origin healthy trở lại CDN quay lại HIT/MISS bình thường. Không cần manual toggle, không cần flush cache.

### Sequence chung minh day du

```text
Phase 1: WARMUP (origin healthy)
  Request 1 -> MISS (origin tra 200, CDN cache)
  Request 2 -> HIT  (CDN serve tu cache fresh)
  -> Proves: normal caching works

Phase 2: AGING (origin still healthy, TTL expires)
  sleep(TTL + 1 second)
  Object da het TTL nhung van trong grace window
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

### Mat danh sach kiem tra (taxonomy of checks)

Case 09 co 3 lop verification, tu nong den sau:

```text
  Lop 1 — SURFACE: HTTP Status
    ✓ stale probe status = 200
    ✗ stale probe status = 503 (FAIL ngay lap tuc)

  Lop 2 — HEADERS: Cache mechanism
    ✓ X-Cache: HIT (not MISS)
    ✓ X-Cache-Stale: true
    ✓ X-Cache-Backend-Healthy: false

  Lop 3 — ORIGIN: Request isolation (DEEPEST)
    ✓ Origin request count = 1 (unchanged)
    ✗ Origin request count > 1 (stale failed)
```

Khong layer nao duoc bo qua. Layer 1 co the pass nhung layer 2, 3 fail -> test
van FAIL. Day la "defense in depth" trong CDN testing.

## 3. Vi sao test o CDN layer

### Day la test CDN-specific NHAT trong toan bo suite

Toàn bộ cơ chế — backend healthing, grace period calculation, serving decision — diễn ra hoàn toàn trong Varnish. Application code không tham gia vào-serving decision.

```text
  Application chi cung cap:
    - Data (HTTP response body)
    - Cache-Control headers (TTL, stale-if-error directive)
    - Health endpoint (/health/cdn-origin)

  Varnish QUYET DINH:
    - Backend co healthy khong? (qua probe doc lap)
    - Object co trong grace window khong? (obj.ttl + obj.grace > 0s)
    - Serve stale hay return error?
```

### So do ra quyet dinh serve stale (VCL execution path)

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

Quy định "serve" chỉ xảy ra trong vạch hút, chỉ khi object expired + backend unhealthy + object trong grace window. Tất cả các path khác đều dẫn đến origin.

### Application khong the test stale-while-error

Nếu bạn test ở application layer (direct-to-app, không qua CDN):

```text
  Application test:
    - Origin unhealthy -> app tra 503 -> test FAIL
    - KHONG CO stale serving, vi stale la CDN feature
  
  CDN layer test:
    - Origin unhealthy -> CDN serve stale -> test PASS
    - Day la chinh xac nhung gi xay ra trong production
```

Neu ban chi test application, ban se khong bao gio biet CDN co stale-while-error
hay khong. Den khi origin sap that -> user thay 503 -> ban moi biet.

### Vi sao khong test o mock environment?

Stale-while-error phụ thuộc vào:

1. **Health probe timing**: Varnish probe backend moi 1 giay, window=3, threshold=2
   -> can it nhat 2-3 giay de Varnish detect unhealthy. Mock khong the mo phong
   chinh xac timing nay.

2. **Grace window calculation**: VCL `obj.ttl + obj.grace > 0s` la runtime calculation
   cua Varnish. Mock khong co VCL runtime.

3. **Backend health state transition**: `std.healthy(req.backend_hint)` la internal
   state cua Varnish, bi anh huong boi probe history. Mock khong mo phong duoc.

4. **Request isolation**: Phai chung minh CDN KHONG goi origin trong stale serving.
   Chi co origin request counter that su (qua control API) moi la evidence tin cay.

### Layer phu thuoc

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

khong the test case nay neu thieu bat ky layer nao. Day la ly do `TargetLayer=full`
la bat buoc cho toan bo CDN suite.

### So sanh: test o layer nao thi bay nhieu evidence?

```text
  Test o APP LAYER (direct-to-app, khong CDN):
    ✓ Confirm: app returns correct response
    ✗ KHONG THE: test stale serving (khong co CDN)
    ✗ KHONG THE: test health probe interaction
    ✗ KHONG THE: test origin isolation

  Test o CDN LAYER (qua Varnish):
    ✓ Confirm: all of the above
    ✓ Confirm: stale serving mechanism
    ✓ Confirm: health probe -> backend sick detection
    ✓ Confirm: origin request isolation (counter proof)
    ✓ Confirm: teardown restores clean state

  Test o MOCK LAYER (simulated Varnish):
    ✓ Confirm: VCL logic (syntax)
    ✗ KHONG THE: confirm real Varnish runtime behavior
    ✗ KHONG THE: confirm health probe timing
    ✗ KHONG THE: confirm actual request isolation
```

Chi co CDN layer test moi cung cap du 100% evidence. Mock test co gia tri cho
VCL validation, nhung khong thay the duoc CDN layer test.

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

### Path 2: Control API (:8088) — Origin manipulation path

```text
  k6 -> http://localhost:8088/ops/app/cdn/origin/profile  (GET/PATCH)
  k6 -> http://localhost:8088/ops/app/cdn/origin/reset    (POST)
  k6 -> http://localhost:8088/ops/app/cdn/origin/request-counts (GET/POST reset)
```

Day la path de thao tac origin health profile va doc origin request counters.
Yeu cau `OPS_AUTH_TOKEN` qua `Authorization: Bearer <token>` va `X-Ops-Token`.

Control API la **direct path** — no di qua Varnish nhung Varnish `pass` moi
request co prefix `/ops/` (xem `vcl_recv`: `if (req.url ~ "^/ops/") { return (pass); }`).
Dieu nay dam bao control requests khong bi cache, luon di thang den app.

### Path 3: Varnish health probe (internal)

```text
  Varnish -> http://nginx:80/health/cdn-origin
          -> App -> CDNOriginHealth handler
```

Varnish probe backend moi 1 giay. Probe nay DOC LAP voi k6 test — Varnish
tu chay probe, k6 chi thay doi origin profile va doi Varnish nhan thay su thay doi.

### Precondition chi tiet

Trước khi test bắt đầu, cần đảm bảo:

1. **Origin dang healthy**: Goi `resetOriginProfile()` de xoa moi profile tu
   test truoc, roi `waitOriginHealthy()` de polling den khi Varnish xac nhan
   backend healthy (profile healthy + CDN healthy + status 200).

2. **Origin request counters reset**: Goi `resetOriginRequestCounts()` de bat
   dau dem tu 0. Neu khong reset, counters tu test truoc se lam nhiem evidence.

3. **URL duoc clean**: Goi `banUrl(path)` de xoa object cu (neu co) khoi Varnish
   cache. Dam bao request dau tien la MISS that su.

4. **Object duoc warm voi TTL ngan**: TTL=2s + stale_if_error=120s. TTL ngan
   de test nhanh (chi can doi 3 giay thay vi 60+ giay). Stale window dai (120s)
   de co du thoi gian thuc hien stale probe.

5. **Sequence warmup hoan chinh**: MISS -> HIT de xac nhan caching hoat dong
   truoc khi mo phong origin failure. Neu khong co HIT truoc, khong co object
   de serve stale.

### Vi sao TTL = 2 giay?

```text
  TTL = 2s -> object het han sau 2 giay
  Post-TTL wait = TTL + 1 = 3s -> dam bao object da expired
  Stale-if-error = 120s -> object van trong stale window
  Probe wait = 4s -> du thoi gian Varnish detect unhealthy
  Tong thoi gian test ~ 10-12 giay
```

Neu TTL = 60s, test se can it nhat 65 giay (60+1+4). Voi 11 cases CDN chay
tuan tu, moi giay tiet kiem deu co y nghia.

### Dieu kien moi truong

```text
  TargetLayer = full
  BASE_URL = http://localhost:80
  CONTROL_BASE_URL = http://localhost:8088
  OPS_AUTH_TOKEN = <ops-token>  (bat buoc)
```

Khong co `OPS_AUTH_TOKEN` -> khong goi duoc control API -> khong set duoc
origin unhealthy -> khong test duoc stale. Day la case BAT BUOC token, khac
voi case 01-08 co the chay khong can token.

## 5. Script deep-dive

Case 09 la script CDN **phuc tap nhat** trong toan bo suite (93 lines). No khong
chi verify cache behavior — no con **dieu khien origin health state** tu ben ngoai,
theo doi health probe cua Varnish, va verify origin request isolation.

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

3 trong 4 knobs duoc tinh toan lien quan den timing:

- `STALE_TTL_SECONDS` (2s): TTL cached object. Cang ngan, test cang nhanh.
- `STALE_IF_ERROR_SECONDS` (120s): Stale window. Phai du lon de test co
  du thoi gian thuc thi (12+ giay), nhung khong duoc qua lon de tranh
  object ton tai qua lau neu teardown fail.
- `STALE_POST_TTL_WAIT_SECONDS` (TTL + 1 = 3s): Thoi gian doi sau khi object
  het TTL. +1 de dam bao object DA expired, khong con fresh.
- `STALE_PROBE_WAIT_SECONDS` (4s): Thoi gian doi Varnish health probe phat
  hien origin unhealthy. Varnish probe moi 1s, window=3, threshold=2 -> can
  it nhat 2 probes fail. 4s cho phep 3-4 probes -> du margin.

### 5.2 Executor options

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

`vus: 1, iterations: 1`: Day la **single-VU test**. Chi can 1 VU chay 1 lan.
Tat ca cac request (setup + default + teardown) deu duoc thuc thi tuan tu
boi 1 VU duy nhat. Khong can nhieu VU vi muc tieu la chung minh **correctness**,
khong phai throughput.

`checks: ['rate==1']`: 100% checks phai pass. Neu bat ky assertion nao fail
(vd: X-Cache khong phai HIT, X-Cache-Stale khong phai true), k6 exit code != 0.

`http_req_failed: ['rate==0']`: Khong mot HTTP request nao duoc fail (status >= 400
bi coi la fail tru khi co `responseCallback` ghi de). Trong stale serving,
response 200 la chuan — CDN KHONG tra error status.

### 5.3 setup() — Warming phase

```javascript
export function setup() {
  const path = buildCachedPath(`stale-${Date.now()}`, {
    ttl_seconds: STALE_TTL_SECONDS,
    stale_if_error_seconds: STALE_IF_ERROR_SECONDS,
  });
```

`buildCachedPath` tao URL duy nhat: `/api/cached?key=stale-1737000000000&ttl_seconds=2&stale_if_error_seconds=120`.
`Date.now()` dam bao URL la duy nhat — khong bi conflict voi test truoc.
`stale_if_error_seconds=120` duoc truyen nhu query param; `/api/cached` handler
se set `Cache-Control: s-maxage=2, stale-while-error=120` trong response.

```javascript
  resetOriginProfile();
  resetOriginRequestCounts();
  waitOriginHealthy({ label: 'stale setup origin recovery' });
  banUrl(path);
```

Bo 4 buoc khoi tao:

1. `resetOriginProfile()`: POST `/ops/app/cdn/origin/reset` — dat origin ve
   `{healthy: true, error_status: 503}`. Xoa moi profile tu test truoc (co
   the da bi set unhealthy).

2. `resetOriginRequestCounts()`: POST `/ops/app/cdn/origin/request-counts/reset` —
   bat dau dem origin requests tu 0.

3. `waitOriginHealthy()`: Polling loop — goi `getOriginProfile()` + probe
   CDN public URL. Kiem tra profile healthy=true, X-Cache-Backend-Healthy=true,
   status=200. Phai co `stableSamples=2` lan lien tiep de xac nhan. Timeout
   12 giay. Dam bao Varnish da nhan ra origin healthy.

4. `banUrl(path)`: Xoa object (neu co) khoi Varnish cache. Dam bao lan request
   dau tien se la MISS that su.

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

- **First**: Cache MISS. CDN forward request den origin. Origin tra 200,
  Varnish cache object voi TTL=2s, grace=120s (set trong `vcl_backend_response`).
  Origin request counter +1.

- **Second**: Cache HIT. CDN serve object tu cache (con fresh, obj.ttl >= 0s).
  Origin KHONG duoc lien lac. Origin request counter van = 1.

Đây làprecondition proof: Neu warming fail (không Hết sau MISS) không có object để serve test võ nghia. Script bảo lưu ngày lập tức.

```javascript
  return { path };
}
```

`setup()` tra ve `{path}` cho `default()` function. Path duoc tao trong setup,
dung lai trong default (stale probe).

### 5.4 default() — Stale serving proof

```javascript
export default function (data) {
  const path = data.path;

  sleep(STALE_POST_TTL_WAIT_SECONDS);
```

`sleep(3)` — doi object het TTL (2s) + 1s margin. Sau sleep nay, object da
expired (obj.ttl <  CODE395 ) nhung van trong grace window (obj.ttl + obj.grace > 0s
vi grace=120s > 3s).

```javascript
  setOriginProfile({
    healthy: false,
    error_status: 503,
  });
```

**Day la buoc TRONG YEU NHAT.** Goi `PATCH /ops/app/cdn/origin/profile` voi
payload `{healthy: false, error_status: 503}`.

Điều gì xảy ra sau buổi này:

1. Go handler cap nhat `cdnOriginProfile` trong memory + Redis.
2. Endpoint `/health/cdn-origin` bat dau tra 503 thay vi 200.
3. Varnish probe (chay moi 1 giay) goi `/health/cdn-origin` -> nhan 503.
4. Sau 2/3 probes fail (window=3, threshold=2) -> Varnish danh dau backend SICK.
5. `std.healthy(req.backend_hint)` tra ve `false`.

```javascript
  sleep(STALE_PROBE_WAIT_SECONDS);
```

`sleep(4)` — doi Varnish health probe detect origin unhealthy. Voi probe
interval=1s, window=3, threshold=2, Varnish can toi thieu 2 probes fail
(=~2 giay). 4 giay cho phep 4 probes -> du margin cho latency.

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

5 assertions trong stale probe:

1. `assertStatus(200)`: CDN tra 200 (khong phai 503). User thay trang binh
   thuong. Day la availability saved.

2. `assertCacheState('HIT')`: X-Cache van la HIT (khong phai MISS). CDN serve
   tu cache, khong forward den origin. Neu X-Cache la MISS -> CDN da co forward
   -> stale serving failed.

3. `assertHeaderEquals('X-Cache-Stale', 'true')`: CHUNG MINH object duoc serve
   tu stale. Header nay chi duoc set trong `vcl_deliver` khi
   `!std.healthy(req.backend_hint) && obj.hits > 0`. Day la "stale signature."

4. `assertHeaderEquals('X-Cache-Backend-Healthy', 'false')`: CHUNG MINH Varnish
   da nhan ra origin unhealthy. Header nay duoc set trong `vcl_deliver` dua
   tren `std.healthy(req.backend_hint)`.

5. Origin request count check (duoi day).

```javascript
  const counts = getOriginRequestCounts();
  const requestCount = findOriginRequestCount(counts, path);
  if (requestCount !== 1) {
    throw new Error(`expected stale path ${path} to hit origin exactly once, got ${requestCount}`);
  }
}
```

**Day la IRREFUTABLE PROOF.** `getOriginRequestCounts()` goi
`GET /ops/app/cdn/origin/request-counts` — tra ve danh sach cac URL va so
lan origin duoc goi. `findOriginRequestCount(counts, path)` tim entry cho
path cua test nay.

Neu `requestCount !== 1`:

- `requestCount === 0`: Origin chua tung duoc goi? Khong the — warming phase
  da co MISS. Co the warming fail hoac counters chua duoc ghi nhan.
- `requestCount === 2`: CDN DA GOI ORIGIN trong stale probe! Stale serving
  failed — CDN da forward request thay vi serve stale. Day la FAIL.
- `requestCount > 2`: Nghiem trong — CDN goi origin nhieu lan. Co the grace
  mechanism khong hoat dong, hoac health probe khong detect duoc unhealthy.

`requestCount === 1`: PASS hoan hao. Chi co request warming dau tien (MISS)
da goi origin. Stale probe KHONG goi origin. Origin duoc bao ve.

### 5.5 teardown() — Recovery phase

```javascript
export function teardown() {
  resetOriginProfile();
  waitOriginHealthy({ label: 'stale teardown origin recovery' });
  resetOriginRequestCounts();
}
```

3 buoc cleanup quan trong:

1. `resetOriginProfile()`: POST `/ops/app/cdn/origin/reset` — dat origin ve
   `{healthy: true, error_status: 503}`. Neu khong lam buoc nay, origin se
   **van unhealthy** cho cac test case tiep theo (case 10, 11). Toan bo suite
   se fail vi origin khong the phuc vu MISS requests.

2. `waitOriginHealthy()`: Polling cho den khi Varnish xac nhan origin healthy
   tro lai. Dam bao backend da duoc Varnish probe lai va danh dau HEALTHY.

3. `resetOriginRequestCounts()`: Reset counters cho test case tiep theo.

**Teardown la BAT BUOC.** Neu teardown fail, origin se bi de o trang thai
unhealthy -> case 10 (request coalescing) se khong the tao MISS -> fail lan
truyen. Day la "test pollution" — test A lam hong test B.

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

Đây là toàn bộ hành trình của một-while-error test. Mọi bước đều được chúng minh không có gì là "assume."

### 5.7 Bang tom tat: moi phase chung minh dieu gi

| Phase | Action | Evidence | Proves |
| --- | --- | --- | --- |
| Setup | resetOriginProfile + waitOriginHealthy | Profile healthy + CDN healthy | Clean starting state |
| Setup | banUrl | Cache cleared | No stale cache from previous run |
| Setup | Request #1 (MISS) | Status 200 + X-Cache: MISS | Object cacheable, origin working |
| Setup | Request #2 (HIT) | Status 200 + X-Cache: HIT | Caching mechanism working |
| Default | sleep(TTL+1) | Time passes | Object expired |
| Default | setOriginProfile(fail) | Profile unhealthy | Origin failure simulated |
| Default | sleep(4s) | Time passes | Varnish detected unhealthy |
| Default | Request #3 (stale probe) | 200 + HIT + Stale: true + Backend: false | **Stale serving works** |
| Default | getOriginRequestCounts | Count = 1 (unchanged) | **Origin isolated** |
| Teardown | resetOriginProfile + wait | Profile healthy + CDN healthy | Clean state restored |

Moi hang trong bang la mot "micro-assertion." Tat ca 10 micro-assertion deu
phai pass de toan bo case pass. 9/10 la FAIL.

Đây là toàn bộ hành trình của một-while-error test. Mọi bước đều được chúng minh không có gì là "assume."

## 6. Origin health model deep-dive

### 6.1 Varnish backend health probe

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

- `.url = "/health/cdn-origin"`: Endpoint duoc probe. Day la endpoint doc lap,
  khong phai public URL cua test case.
- `.timeout = 1s`: Neu probe request khong co response trong 1 giay -> coi la fail.
- `.interval = 1s`: Probe chay moi giay. Varnish lien tuc theo doi suc khoe backend.
- `.window = 3`: Xet 3 probes gan nhat de quyet dinh healthy/sick.
- `.threshold = 2`: Can 2/3 probes thanh cong (return 200) de coi backend healthy.
  Nguoc lai, can 2/3 probes fail de coi backend sick.
- `.initial = 1`: Khi Varnish khoi dong, gia su backend healthy ngay lap tuc (1).

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
  Varnish hoat dong trong stale mode
      |
  resetOriginProfile()
      |
  Probe #5 (t=4s):  /health/cdn-origin -> 200  [PASS]
  Probe #6 (t=5s):  /health/cdn-origin -> 200  [PASS]
      |
  window=3, threshold=2 -> 2/3 probes pass -> backend HEALTHY
  std.healthy = true
```

### 6.3 Go handler: CDNOriginHealth

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

- Neu `profile.Healthy == true` -> tra 200 (healthy).
- Neu `profile.Healthy == false` -> tra `profile.ErrorStatus` (mac dinh 503).
- Timeout Redis ctx: 250ms. Khong de Redis latency anh huong den probe.
- `source` cho biet profile den tu "redis" hay "memory" (fallback).

### 6.4 setOriginProfile: PATCH handler

```go
func (h *Handler) OpsSetCDNOriginProfile(c *gin.Context) {
    var patch cdnOriginProfilePatch
    // ...
    profile, source := h.patchCDNOriginProfile(ctx, patch)
    // ...
}
```

`patchCDNOriginProfile` load profile hien tai, apply patch, store vao Redis +
memory. Cap nhat ATOMIC — khong co race condition giua doc va ghi.

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
    // Fallback to in-memory only
    return h.cdnOriginState.setProfile(profile), "memory"
}
```

Hai lớp storage:

1. **Redis** (primary): Profile duoc luu trong Redis key `ops:cdn:origin:profile`.
   Khi co Redis, day la nguon duy nhat. Health probe doc tu Redis (voi 250ms timeout).

2. **In-memory** (fallback): Khi Redis khong kha dung, profile duoc luu trong
   `localCDNOriginState.profile`. Mutex-protected.

### 6.6 Tai sao can ca in-memory + Redis?

-Redis: Cho phép nhiều instance của app cùng chia sẻ origin profile. Khi API server scale ngang, tất cả instance đều đặn cùng profile từ Redis. -In-memory: Fallback khi Redis down. Origin health probe vẫn hoạt động ngay cả khi Redis không sử dụng — profile được dồn từ memory.

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

`error_status` phai nam trong range 400-599. Neu set ngoai range (vd: 200 khi
unhealthy, hoac 999), auto clamp ve 503. Dam bao Varnish probe nhan duoc
error status that su (khong the tra 200 khi `healthy: false`).

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

Ba điều kiện phải ĐƯỢC THỨC THỰC MÃO:

1. **Profile healthy**: `getOriginProfile()` tra ve `healthy: true`. Day la
   application-level check — profile da duoc reset.

2. **CDN healthy**: `X-Cache-Backend-Healthy: true`. Day la Varnish-level check —
   Varnish da probe backend va xac nhan healthy.

3. **Status 200**: Public CDN request thanh cong. Day la end-to-end check.

Can `stableSamples=2` lan lien tiep de xac nhan. Tranh tinh huong "false positive"
khi Varnish vua chuyen tu sick -> healthy nhung probe chua on dinh.

`responseCallback: http.expectedStatuses({ min: 100, max: 599 })` cho phep probe
nhan moi status, khong bi coi la HTTP error ngay ca khi backend unhealthy.
Dieu nay quan trong vi probe duoc dung de KIEM TRA unhealthy — neu no tu dong
fail, ta khong the doc duoc ket qua.

## 7. Stale-if-error vs Grace mode — THE STAR SECTION

Đây là phân QUAN TRƯỜNG NHẬT để hiểu-while-error trong Varnish. Có hai cơ chế liên quan nhưng KHÁC NHƯỢNG.

### 7.1 Grace mode

Grace la co che cua Varnish: khi object het TTL (obj.ttl <  CODE484 ) nhung van trong
grace window (obj.ttl + obj.grace > 0s) VA backend khong healthy, Varnish serve
stale object.

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

Moi cacheable object deu co grace = 120s. Dieu nay co nghia: sau khi TTL het,
object van co the duoc serve stale trong 120 giay neu backend unhealthy.

### 7.2 Stale-if-error (Cache-Control directive)

`stale-while-error` la Cache-Control extension (RFC 5861):

```text
  Cache-Control: s-maxage=2, stale-while-error=120
```

Nghia la: "cache object nay 2 giay (fresh). Sau do, neu origin tra error
(5xx), serve stale object nay them 120 giay nua."

### 7.3 Cach Varnish ket hop ca hai

Trong VCL cua chung ta, `beresp.grace = 120s` duoc set UNIFORM cho moi object.
Varnish KHONG parse `stale-while-error` directive mot cach tuong minh. Thay
vao do, no su dung grace nhu stale-if-error implementation:

```text
  Grace = "serve stale if backend unhealthy, regardless of why"
  Stale-if-error = "serve stale if backend returns error"
  
  Trong VCL nay: GRACE = STALE-IF-ERROR implementation
  Vi: Varnish chi serve stale khi backend unhealthy
       (unhealthy = error responses tu health probe)
```

### 7.4 Su khac biet tinh te giua Grace va Stale-if-error

| Dac diem | Grace mode | Stale-if-error |
| --- | --- | --- |
| **Dieu kien** | Backend unhealthy | Origin tra 5xx |
| **Co che** | Varnish internal | Cache-Control directive |
| **Async refresh?** | Co (trong Varnish default) | Khong (chi serve stale) |
| **Health probe dependency?** | Co (std.healthy) | khong nhat thiet |
| **Ai dat?** | VCL `beresp.grace` | Origin `Cache-Control` header |
| **Trong VCL nay?** | `beresp.grace = 120s` | Duoc implement qua grace |

*Điểm khác biệt cốt lõi: Trong Varnish default behavior (không có custom VCL), gạch mode bao gồmsync refresh: Varnish serve object cho client, nhưng ĐONG THỨC gửi một request xuống origin để refresh object. Stale-if-error Khối làm async refresh — NHƯỢNG CÓ serve và KHÔNG liên lạc origin.

Trong VCL cua chung ta, `vcl_hit` chi serve stale ma KHONG bat dau async refresh.
Dieu nay duoc dam bao vi code chi `return (deliver)` — khong co `return (miss)`
hay backend request nao duoc trigger.

### 7.5 Vi sao VCL chi serve stale khi backend unhealthy?

```vcl
if (!std.healthy(req.backend_hint) && obj.ttl + obj.grace > 0s) {
    set req.http.X-Cache-Stale = "true";
    return (deliver);
}
```

Điều kiện KEP:

1. `!std.healthy(req.backend_hint)`: Backend phai khong healthy. Day la prerequisite —
   khong the serve stale neu backend con healthy (se forward request thay vi serve stale).

2. `obj.ttl + obj.grace > 0s`: Object phai trong grace window. Neu qua grace
   window roi (obj da bi evict hoac keep het han), khong con stale de serve.

Đây là thiết kế AN TOÀN: chỉ được serve khi origin thật sự không khả dụng. Khi origin healthy, user luôn nhận fresh content.

### 7.6 X-Cache-Stale trong vcl_deliver

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
- Khi backend healthy, header bi unset — test se fail neu assert co header nay.
- `obj.hits > 0` dam bao object da tung duoc cache — khong the "stale" mot
  object chua tung fresh.

### 7.7 TTL, Grace, va Keep — ba giai doan cua mot object

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

Case 09 test trong GRACE PERIOD: TTL=2s -> doi 3s -> van trong grace (3s <  CODE504 ).
Neu doi > 122s, object se roi vao KEEP PERIOD va khong duoc serve stale.

### 7.8 Vi sao grace=120s, keep=600s?

```text
  grace=120s: 2 phut. Du dai de:
    - Cho Varnish detect unhealthy (4s)
    - Cho ops team detect outage + respond (vai chuc giay den 1-2 phut)
    - Phuc vu traffic trong thoi gian origin recover
    - KHONG qua dai de tranh serve stale qua lau neu origin that su down vinh vien

  keep=600s: 10 phut. Du dai de:
    - Giu object trong cache sau khi het grace
    - Cho phep conditional revalidation (304) khi origin recover
    - Tranh eviction som -> giam MISS storm khi origin recover
    - 10 phut la compromise giua "giu object" va "memory pressure"

  TTL=2s (trong test): chi de test nhanh
  TTL thuc te (production): 60s - 300s tuy loai content
    - Product detail: 60s (it thay doi)
    - Product listing: 30s (thay doi vua phai)
    - Search results: 15s (thay doi nhanh)
```

### 7.9 Grace behavior trong mot so Varnish configurations pho bien

```text
  Config A: KHONG co grace, KHONG co health check
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

  Config D: co grace, health check nhung stale-if-error qua ngan
    -> TTL=2s, grace=3s -> object expired, grace expired truoc khi probe detect
    -> Origin down -> stale khong the serve (obj.ttl + obj.grace <= 0s)
    -> Day la "misconfigured" — co co che nhung khong hoat dong
```

Config C (của chúng ta) là gold standard. Config D là lời cầu hình phổ biến — hiệu quả ngắn, không kịp hoạt động trước khi object bị rơi khỏi grace window.

## 8. Origin request counting proof — THE EVIDENCE

### 8.1 Vi sao origin request counting la EVIDENCE QUAN TRONG NHAT?

Không có origin request counting, đây là những gì bạn CO THE sai:

```text
  Tinh huong A: CDN tra 200 + X-Cache-Stale: true
  -> Ban ket luan: "STALE WORKED!"
  -> Nhung thuc te: CDN da goi origin, origin tra error,
     CDN fallback ve stale object VAF DANH DAU la stale.
  -> Origin van bi ap luc, chi la user khong thay error.
  -> STALE FAILED o muc do origin protection.

  Tinh huong B: CDN tra 200 + X-Cache-Stale: true
  -> Ban ket luan: "STALE WORKED!"
  -> Nhung thuc te: Origin da tu recover (restart pod),
     CDN goi origin thanh cong, tra fresh response.
  -> X-Cache-Stale duoc set do Varnish chua nhan ra origin da healthy.
  -> Ban mat evidence origin da thuc su duoc goi.

  Tinh huong C: CDN tra 200 + X-Cache-Stale: true
  -> Ban ket luan: "STALE WORKED!"
  -> Nhung thuc te: Object chua tung duoc cache (warming fail).
     CDN khong the serve stale vi khong co object.
  -> X-Cache-Stale la GIA? Khong — nhung object lai duoc
     cache tu mot origin request khac (background refresh).
  -> Origin counting se vach tran: count > 1.
```

**Chi co origin request counting moi la irrefutable proof.** No tra loi cau hoi:
"Lieu origin co thuc su KHONG bi goi trong stale probe khong?" Neu count = 1
(sau MISS dau tien) -> PASS. Neu count > 1 -> FAIL, bat ke headers noi gi.

### 8.2 Cach origin counter hoat dong

`/api/cached` handler (trong app) tu dong increment counter moi khi origin
nhan duoc request. Counter duoc expose qua:

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
  Truoc setup:
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
    *** DAY LA DIEM MAU CHOT ***

  Neu count = 2 o day:
    CDN da forward request den origin -> STALE FAILED
```

### 8.4 Tai sao counter khong bi anh huong boi health probe?

Varnish health probe goi `/health/cdn-origin`, KHONG PHAI `/api/cached?key=stale-...`.
Health probe la request doc lap, khong lien quan den counter cua URL test.

`findOriginRequestCount` tim chinh xac `request_key` trung khop — khong bi
nham lan voi health probe path.

### 8.5 Counter reset va test pollution

Nếu không reset counter trước mỗi test:

```text
  Case 08 (TTL expiry): MISS -> count +1
  Case 09 (stale): MISS -> count +1 (cua case 09) + count cua case 08 = 2
  -> findOriginRequestCount tra ve 2 -> test FAIL SAI
```

`resetOriginRequestCounts()` trong setup va teardown dam bao moi case bat dau
tu 0. Day la "test isolation" — moi case doc lap, khong bi anh huong boi case truoc.

## 9. Key signals/headers

### Bang headers va y nghia

| Signal | Expected Value | Y nghia | Vi sao QUAN TRONG |
| --- | --- | --- | --- |
| HTTP Status | `200` | User thay trang binh thuong | Stale save availability. 503 = FAIL. |
| `X-Cache` | `HIT` | CDN serve tu cache (khong forward) | Neu MISS -> CDN da goi origin -> stale failed |
| `X-Cache-Stale` | `true` | Object duoc serve tu stale | THE SIGNAL. Chi co khi backend unhealthy + obj.hits > 0 |
| `X-Cache-Backend-Healthy` | `false` | Varnish xac nhan origin unhealthy | Chung minh dieu kien stale duoc kich hoat DUNG |
| `X-Cache-Hits` | `>= 3` | Object da duoc serve it nhat 3 lan (warming 2 + stale 1) | Xac nhan object da ton tai trong cache |
| Origin request count | `1` | Chi MISS dau tien goi origin | IRREFUTABLE PROOF: stale probe khong goi origin |
| Response body | Product data | Data cu nhung day du | User van thay noi dung binh thuong |

### Cach doc X-Cache-Stale DUNG

```text
  X-Cache-Stale co mat -> stale serving DANG DIEN RA
  X-Cache-Stale khong co -> object duoc serve fresh HOAC tu origin
  
  X-Cache-Stale CHI CO MAT khi:
    1. Backend unhealthy (std.healthy = false)
    2. Object da duoc cache (obj.hits > 0)
    3. Object trong grace window (obj.ttl + obj.grace > 0s, duoc check trong vcl_hit)
    
  Neu X-Cache-Stale co mat nhung X-Cache-Backend-Healthy = true:
    -> LOGIC ERROR trong VCL — khong the stale khi backend healthy
    -> Can investigate vcl_deliver logic
```

### Cach doc X-Cache-Backend-Healthy DUNG

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

### Cac header BO SUNG (khong assert nhung co gia tri debug)

| Header | Mo ta | Khi nao co mat |
| --- | --- | --- |
| `X-Cache-Age` | Tuoi cua object (seconds) | Khi object da duoc cache |
| `X-Served-By` | Node Varnish da xu ly request | Luon co |
| `X-Upstream-Service` | Origin service da xu ly | Chi khi MISS |
| `Age` | Standard HTTP Age header | Khi tu cache |
| `Cache-Control` | Cache directives | Do origin set |

## 10. Pass/fail criteria

### PASS criteria (tat ca phai DONG THOI)

| # | Criteria | Assertion in script | Weight |
| --- | --- | --- | --- |
| P1 | k6 exit code = 0 | Natural (checks rate=1, no throw) | Mandatory |
| P2 | Warmup sequence MISS -> HIT | `assertCacheState(first, 'MISS')` + `assertCacheState(second, 'HIT')` | Mandatory |
| P3 | Stale probe status = 200 | `assertStatus(stale, 200)` | Mandatory |
| P4 | Stale probe X-Cache = HIT | `assertCacheState(stale, 'HIT')` | Mandatory |
| P5 | X-Cache-Stale = true | `assertHeaderEquals(stale, 'X-Cache-Stale', 'true')` | Mandatory |
| P6 | X-Cache-Backend-Healthy = false | `assertHeaderEquals(stale, 'X-Cache-Backend-Healthy', 'false')` | Mandatory |
| P7 | Origin request count = 1 | `requestCount !== 1 -> throw Error` | **Critical** |
| P8 | Teardown restores healthy origin | `waitOriginHealthy()` in teardown | Mandatory |
| P9 | Zero HTTP errors | `http_req_failed: ['rate==0']` | Mandatory |

### FAIL scenarios (chi can 1 la FAIL)

| # | Symptom | What failed | Impact |
| --- | --- | --- | --- |
| F1 | k6 exit != 0 | Any assertion failed | Test invalid |
| F2 | Warmup MISS -> MISS (no HIT) | Object not cached — can't test stale | Test meaningless |
| F3 | Stale probe = 503 | CDN returned error instead of stale | **CDN stale serving broken** |
| F4 | Stale probe = 200 but X-Cache = MISS | CDN forwarded to origin despite unhealthy | Stale didn't kick in |
| F5 | Stale probe = 200, HIT but no X-Cache-Stale | Response fresh, not stale | Origin may have recovered or stale not configured |
| F6 | X-Cache-Backend-Healthy = true during stale probe | Origin not marked unhealthy by Varnish | Health profile change didn't propagate |
| F7 | Origin request count > 1 | CDN contacted origin during stale probe | **Stale origin protection FAILED** |
| F8 | Origin request count = 0 | Warming phase may have got cache HIT from previous test | Counters not reset properly |
| F9 | Teardown fail (waitOriginHealthy timeout) | Origin stuck unhealthy | **Pollutes all subsequent cases** |

### Vi sao P7 (origin count=1) la CRITICAL?

P7 phân biệt "stale thất sự" và "stale giả":

- **Stale that su**: CDN serve object cu, KHONG lien lac origin -> count = 1.
- **Stale gia**: CDN goi origin (origin error/healthy), roi serve object cu -> count > 1.
- **Stale gia (background refresh)**: CDN serve stale cho client nhung async
  refresh tu origin -> count > 1 (co the la 2).

Chỉ có P7 mới phân biệt được ba tính hưởng này. Headers không thể.

## 11. Cach chay + output

### Prerequisites

```powershell
# 1. Tat ca services phai chay (TargetLayer=full)
#    - Nginx, Varnish, App, Redis

# 2. Dam bao Varnish dang probe backend
#    Kiem tra: Varnish log hoac GET http://localhost/health/cdn-origin

# 3. Co OPS_AUTH_TOKEN
#    Case 09 BAT BUOC token vi can goi control API
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
# Co the override de debug hoac performance testing:

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

### Diem can luu y trong output

1. **So luong checks = 8**: 2 warmup + 4 stale + 2 health wait (khong hien thi
   trong output tren nhung waitOriginHealthy tao checks rieng). Tat ca phai pass.

2. **http_req_failed = 0.00%**: Tat ca requests deu thanh cong. Neu co request
   fail, kiem tra `responseCallback` cua health probe — no cho phep 100-599,
   nhung stale probe phai la 200.

3. **Thoi gian ~10s**: 3s (post-TTL wait) + 4s (probe wait) + request latency.
   Neu dai hon nhieu, co the `waitOriginHealthy` dang polling lau.

4. **Khong co `X-Cache-Stale` assertion fail**: Neu header nay fail, co the
   Varnish chua detect unhealthy (probe wait chua du) hoac VCL thieu stale logic.

### Chay trong CI pipeline

```powershell
# CI can override timing for speed:
$env:STALE_TTL_SECONDS = "1"
$env:STALE_POST_TTL_WAIT_SECONDS = "1.5"
$env:STALE_PROBE_WAIT_SECONDS = "3"

# Total CI time: ~5.5s (vs ~10s local)
# Trade-off: less margin for health probe detection
# If CI flakes: increase STALE_PROBE_WAIT_SECONDS to 5

# CI must have OPS_AUTH_TOKEN secret
$env:OPS_AUTH_TOKEN = $env:CI_OPS_AUTH_TOKEN

# Run single case for speed in PR checks
./scripts/run-cdn-capabilities.ps1 -Scenarios 09-stale-while-error
```

### Cach verify ket qua truc tiep (manual)

Ngoại k6 output, bạn có thể verify từng bước bằng curl:

```bash
# 1. Kiem tra origin profile hien tai
curl -s http://localhost:8088/ops/app/cdn/origin/profile \
  -H "Authorization: Bearer $OPS_AUTH_TOKEN" | jq .

# 2. Kiem tra origin request counts
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

### Dac diem timing cua case 09 so voi cac case CDN khac

| Case | Thoi gian | Sleep | Ly do |
| --- | --- | --- | --- |
| cdn-01 | ~1s | 0 | Simple MISS -> HIT, no wait needed |
| cdn-08 | ~22s | 21s (TTL wait) | Wait for TTL expiry |
| **cdn-09** | **~10s** | **3s + 4s** | **TTL expiry + health probe detection** |
| cdn-10 | ~1s | 0 | Concurrent requests, no wait |
| cdn-11 | ~35s | 15s + 15s | Two TTL waits for negative cache |

Case 09 co thoi gian chay vua phai (~10s) — dai hon case don gian (01-07)
nhung ngan hon case TTL (08, 11). Ly do can 2 lan sleep: mot de object het
TTL, mot de Varnish phat hien unhealthy.

### Expected output (FAIL vi du)

```text
  ✗ stale after origin unhealthy status 200
    ↳  92% — expected 200, got 503

  ✗ stale after origin unhealthy X-Cache-Stale equals true
    ↳  92% — expected 'true', got ''

  ERRO[0010] expected stale path /api/cached?... to hit origin exactly once, got 2
```

Fail nay co nghia: CDN da goi origin (count=2) VA tra 503. Stale hoan toan
khong hoat dong. Nguyen nhan co the:

- VCL `vcl_hit` khong co stale logic (thieu `!std.healthy(backend) && obj.ttl + obj.grace > 0s`)
- `beresp.grace` khong duoc set -> obj.ttl + obj.grace = 0 (grace khong ton tai)
- Origin unhealthy profile khong duoc apply (control API fail)
- Health probe khong detect duoc unhealthy (probe URL sai, interval qua dai)

## 12. 4 output -> decision scenarios

### Scenario A: ALL PASS — "CDN stale-while-error proven, origin outage protected"

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

### Scenario C: 200 BUT X-Cache-Stale MISSING — "fresh response, origin may not actually be unhealthy"

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

### Scenario D: ORIGIN COUNT INCREASED — "CDN contacted origin despite unhealthy status"

```text
  Output:
    ✓ All header checks pass (200, HIT, X-Cache-Stale: true, X-Cache-Backend-Healthy: false)
    ✗ Origin request count = 2 (or more) — expected 1

  This is the MOST DANGEROUS failure mode. Everything LOOKS correct —
  headers say stale, status is 200 — but the CDN actually contacted origin.

  Root cause analysis:

    A. Async refresh (Varnish grace behavior):
       Default Varnish grace includes async refresh:
       - Serve stale to client
       - BUT ALSO send background request to origin to refresh
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

    1. Open default.vcl, go to vcl_hit:
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

## 13. Nghich ly / misconceptions

### Misconception 1: "Stale = xau, fresh = tot"

```text
  SAI. Trong bo canh origin failure:

  Fresh 0s old + 503 status  = user thay ERROR       = CATASTROPHE
  Stale 4s old  + 200 status  = user thay san pham    = BUSINESS AS USUAL

  Stale trong truong hop nay LA TOT. No la safety net.
  Stale luon luon TOT HON error.
```

### Misconception 2: "Origin down = site down"

```text
  SAI (neu co stale-while-error). Voi stale-while-error:

  Origin down + CDN co cache + stale policy = site VAN UP (serving stale)
  Origin down + CDN KHONG co cache = site DOWN (khong co gi de serve)

  Stale-while-error bien CDN thanh "static backup" cho dynamic content.
```

### Misconception 3: "Stale-while-error chi cho static content"

```text
  SAI. Stale-while-error hoat dong cho BAT KY cacheable object nao:
  - HTML fragments (product descriptions)
  - JSON API responses (product detail, category list)
  - Images (da duoc cache)
  - Search results (neu duoc cache)
  
  Dieu kien duy nhat: object phai duoc cache VA trong grace window.
  Khong phan biet static vs dynamic.
```

### Misconception 4: "Grace va stale-if-error giong het nhau"

```text
  SAI. Su khac biet (xem Section 7):

  Grace: Varnish-specific. Co the bao gom async refresh.
  Stale-if-error: HTTP Cache-Control directive. Chi serve stale, khong refresh.

  Trong VCL nay: grace DUOC SU DUNG de implement stale-if-error.
  Nhung chung la hai khai niem khac nhau.
```

### Misconception 5: "Neu origin healthy, stale khong bao gio duoc serve"

```text
  DUNG — nhung day la DIEU TOT. Stale chi nen duoc serve khi origin
  KHONG kha dung. Khi origin healthy, user xung dang nhan fresh content.

  Neu stale duoc serve ngay ca khi origin healthy:
  -> Stale policy qua aggressive -> user nhan data cu khong can thiet
  -> Can adjust: chi serve stale khi origin unhealthy, khong phai luon luon
```

### Misconception 6: "Status 200 nghia la stale serving hoat dong"

```text
  SAI. Status 200 co the den tu:
  - Stale serving (WHAT WE WANT TO PROVE)
  - Origin da recover (tuong stale nhung thuc te la fresh)
  - CDN goi origin, origin tra 200 (stale KHONG hoat dong)
  
  Phai verify QUA HEADERS + ORIGIN COUNT. Status 200 khong du.
```

### Misconception 7: "TTL ngan + grace dai la vo nghia"

```text
  SAI. TTL ngan + grace dai la STRATEGY:

  TTL = 2s: object duoc refresh thuong xuyen khi origin healthy.
  Grace = 120s: khi origin unhealthy, object co the serve stale 120s.
  
  Day la "fresh when possible, stale when necessary."
  Khong phai "stale luon luon."
```

### Misconception 8: "Stale-while-error thay the duoc monitoring va alerting"

```text
  SAI. Stale-while-error la LAST LINE OF DEFENSE, khong phai replacement:

  Monitoring + Alerting: PHAT HIEN outage, notify team.
  Stale-while-error: GIU site running TRONG KHI team respond.
  
  Neu chi co stale-while-error ma khong monitoring:
  -> Origin co the down 10 phut, CDN serve stale, user OK
  -> Nhung team KHONG BIET origin down -> khong fix
  -> Object het grace window -> site DOWN -> user moi biet
  
  Stale-while-error MUA THOI GIAN cho team fix. No KHONG FIX outage.
```

### Misconception 9: "Can origin tra Cache-Control: stale-while-error moi hoat dong"

```text
  SAI (trong cau hinh VCL nay). VCL dat UNIFORM grace=120s cho
  TAT CA cacheable objects. Origin KHONG CAN set stale-while-error
  directive. Varnish tu ap dung grace policy.

  Tuy nhien, trong production thuc te:
  - Origin NEN set stale-while-error de bao hieu intent
  - Varnish CO THE ton trong directive nay (neu duoc cau hinh)
  - Nhung trong VCL cua chung ta: grace duoc set uniform, bat ke origin header
```

## 14. Checklist

### Pre-run

- [ ] `TargetLayer=full` — tat ca services chay (Varnish + Nginx + App + Redis)
- [ ] Varnish dang chay va probe `/health/cdn-origin`
- [ ] Control API accessible tai `:8088/ops/app/cdn/origin/profile`
- [ ] `OPS_AUTH_TOKEN` duoc set (case nay BAT BUOC)
- [ ] Origin request counters hoat dong (kiem tra GET endpoint)
- [ ] Khong co case CDN nao khac dang chay (tranh shared state pollution)

### Run-time

- [ ] Warmup sequence: MISS -> HIT (xac nhan caching hoat dong)
- [ ] `setOriginProfile({healthy: false})` thanh cong (kiem tra response)
- [ ] Du thoi gian cho Varnish probe detect unhealthy (>= 4s voi interval=1s)
- [ ] Stale probe: 200 + HIT + X-Cache-Stale: true + X-Cache-Backend-Healthy: false
- [ ] Origin request count = 1 (chi MISS dau tien)
- [ ] Teardown successful: origin healthy tro lai

### Post-run

- [ ] k6 exit code = 0
- [ ] Tat ca checks pass (checks rate = 100%)
- [ ] Zero HTTP errors (http_req_failed = 0%)
- [ ] Origin profile da duoc reset (kiem tra GET endpoint)
- [ ] Origin counters da duoc reset (sach cho case tiep theo)
- [ ] No stale state pollutes cdn-10, cdn-11

## 15. 4-5 variations

### Variation 1: Different stale-if-error durations

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

### Variation 2: Origin slow (not dead) scenario

```javascript
// 09-stale-while-error-slow.js
// Thay vi origin tra 503, origin CHAM (30s timeout)
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

### Variation 4: Multiple objects stale simultaneously

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
  
  Status 200 la can but KHONG du. Origin count la bang chung
  CDN KHONG lien lac origin. Thieu origin count -> khong biet
  stale co that su hoat dong hay khong.
```

### Anti-pattern 2: Too-short stale-if-error (or none at all)

```text
  SAI: stale-if-error = 2s (bang TTL)
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

### Anti-pattern 4: Testing stale before proving normal caching works

```text
  SAI: Skip warmup -> set unhealthy ngay -> request
  -> Neu response 503: la do origin unhealthy hay do cache chua co object?
  -> KHONG THE BIET -> test meaningless
  
  DUNG: MISS -> HIT (prove caching works) -> then test stale
  -> Neu stale fail, ta biet chac la do stale mechanism,
     khong phai do caching co ban.
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

```text
  PROBLEM: k6 exits with "OPS_AUTH_TOKEN (or OPS_TOKEN) is required"
  FIX:     $env:OPS_AUTH_TOKEN = "<token>"
           This case is MANDATORY token — cannot run without it.

  PROBLEM: waitOriginHealthy() timeout (12s)
  CAUSE:   Varnish health probe may not be reaching /health/cdn-origin
  CHECK:   curl http://localhost/health/cdn-origin
           -> Should return 200 OK
  CHECK:   curl http://localhost:8088/ops/app/cdn/origin/profile
           -> Should show {"healthy":true,...}
  FIX:     Ensure Varnish + Nginx + App are running
           Ensure Varnish backend probe URL is correct

  PROBLEM: Stale probe returns 503 instead of 200
  CAUSE:   Object may have been evicted from cache, or grace window too short
  CHECK:   Is obj.ttl + obj.grace > 0s? Grace must be set in VCL.
  CHECK:   Did the second request in setup return HIT? If not, object wasn't cached.
  FIX:     Increase STALE_IF_ERROR_SECONDS (ensure grace window is adequate)
           Check vcl_backend_response: beresp.grace must be > 0

  PROBLEM: Stale probe returns 200 but X-Cache-Stale is absent
  CAUSE:   X-Cache-Stale is only set when backend is unhealthy.
           If backend is still healthy -> stale serving not triggered.
  CHECK:   curl http://localhost:8088/ops/app/cdn/origin/profile
           -> healthy should be false
  CHECK:   Wait longer: STALE_PROBE_WAIT_SECONDS may not be enough
           for Varnish to detect unhealthy (probe interval 1s, need 2 fails)
  FIX:     Increase STALE_PROBE_WAIT_SECONDS to 6 or 8

  PROBLEM: Origin request count = 2 (or more)
  CAUSE:   CDN contacted origin during stale probe
  CHECK:   Is vcl_hit returning (deliver) or (pass)?
           If (pass) -> vcl_miss -> origin request -> counter +1
  FIX:     Ensure vcl_hit returns (deliver) for stale case, NOT (pass)
           Ensure no background/async refresh is triggered

  PROBLEM: Teardown waitOriginHealthy() timeout — origin stuck unhealthy
  CAUSE:   resetOriginProfile() may have failed silently
  CHECK:   curl -X POST http://localhost:8088/ops/app/cdn/origin/reset \
             -H "Authorization: Bearer $OPS_AUTH_TOKEN"
           -> Should return {"success":true,"data":{"profile":{"healthy":true,...}}}
  FIX:     Manually call reset and wait for healthy before running next case
           If persistent: restart app to clear in-memory state

## 18. Reference

- **Run guide**: `E:\Khoa hoc\k6\docs\practice\cdn\RUN_GUIDE.md`
- **Overview (00_overview.md)**: `E:\Khoa hoc\k6\docs\practice\cdn\00_overview.md` — especially the "Common invalid-result patterns" table (stale case pass vi status 200 is a listed anti-pattern)
- **Script source**: `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\09-stale-while-error.js` (93 lines)
- **Shared helpers**: `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` — `setOriginProfile`, `resetOriginProfile`, `waitOriginHealthy`, `getOriginRequestCounts`, `findOriginRequestCount`, `assertHeaderEquals`
- **VCL (stale logic)**: `E:\Projects\k6\k6-metrics-server\load-target\varnish\default.vcl` — `vcl_hit` (lines 190-202), `vcl_backend_response` (lines 204-258), `vcl_deliver` (lines 270-302)
- **Origin health handler**: `E:\Projects\k6\k6-metrics-server\load-target\handlers\cdn_origin_control.go` (357 lines) — `CDNOriginHealth`, `OpsSetCDNOriginProfile`, `OpsResetCDNOriginProfile`, `OpsCDNOriginRequestCounts`, `OpsResetCDNOriginRequestCounts`
- **Case catalog**: `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json`
- **CDN README**: `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md`
- **Layer roadmap**: `E:\Projects\k6\k6-metrics-server\load-target\k6\layer-roadmap.md`
- **Sibling cases**: cdn-01 through cdn-11 (full CDN suite)
- **RFC 5861** (HTTP Cache-Control Extensions for Stale Content): `stale-while-error` directive specification
- **Varnish docs**: Grace mode and health checks: `https://varnish-cache.org/docs/`
