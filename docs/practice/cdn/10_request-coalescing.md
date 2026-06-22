# Case 10: Request Coalescing -- Chong Cache Stampede

> **Case ID:** `cdn-10-request-coalescing`
> **Script:** `10-request-coalescing.js`
> **Layer:** CDN / Varnish
> **Proof:** cold burst coalesces origin forwarding -- N concurrent requests, 1 origin hit

## 1. Tinh huong thuc te

### Phat push thong bao -- 10,000 nguoi mo app cung luc

Marketing vuat gui push notification toi 10 trieu nguoi dung:

```text
"   FLASH SALE 50% tat ca san pham!
   Chi trong 2 tieng. Mo app ngay!  "
```

Trong vong 3 giay dau tien sau khi push notification den dien thoai nguoi
dung, khoang 10,000 nguoi mo app dong thoi. Tat ca ho deu thay man hinh
landing page giong het nhau. Man hinh nay goi API:

```text
GET /api/sim/products/homefeed
```

Day la API tra ve danh sach san pham noi bat cho man hinh chinh. Du lieu
nay giong het nhau cho tat ca nguoi dung guest o cung mot quoc gia/thiet
bi/ngon ngu (cung mot cache key).

### Bai toan "thundering herd"

Khong co cache (cold cache -- vi vua deploy, vua purge, hoac TTL vua
het han), dieu gi xay ra?

```text
TRUONG HOP A: KHONG CO REQUEST COALESCING
==============================================================

  CDN Edge (Varnish)
      |
      | 10,000 requests dong thoi cung key
      | Tat ca deu MISS (cold cache)
      |
      +---> Origin (Backend)
              |
              | Nhan 10,000 requests TRONG CUNG MOT LUC
              | Moi request can:
              |   - Query DB: products, categories, promotions
              |   - Tinh toan ranking/personalization
              |   - Render JSON response (cỡ 50-200KB)
              |   - Tong moi request: ~200ms CPU + DB time
              |
              +---> Database
                      |
                      | 10,000 connection mo dong thoi
                      | Cung mot query chay 10,000 lan
                      | CPU cua DB: 100% -> lock wait -> timeout
                      |
                      +---> KET QUA:
                              - Backend timeout (30s+)
                              - DB connection pool exhausted
                              - App server OOM, crash
                              - 9,500/10,000 users thay spinner quay mai
                              - 500 users thay error page
                              - 0 users thay san pham
                              - Marketing ton $50,000 cho push campaign
                              - Conversion = 0%
                              - Team bi goi luc 2h sang
```

Day goi la **thundering herd** (dan voi giam dap) hoac **cache stampede**
(hoang loan cache). Khi cache trong, hang nghin request giong het nhau
cung do xuong origin, bien mot van de thanh tham hoa.

Origin bi "stampede" -- bi giam dap boi chinh traffic cua no.

```text
TRUONG HOP B: CO REQUEST COALESCING (COLLAPSED FORWARDING)
==============================================================

  CDN Edge (Varnish)
      |
      | 10,000 requests dong thoi cung key
      | Varnish nhan ra: tat ca cung hoi cung mot object
      |
      | Request #1:  "De to di lay cho."  -> Gui 1 request toi origin
      | Request #2:  "Cung object? Dang di lay roi. Cho nhe." -> WAIT
      | Request #3:  "Cung object? Dang di lay roi. Cho nhe." -> WAIT
      | ...
      | Request #10000: "Cung object? Dang di lay roi. Cho nhe." -> WAIT
      |
      | Origin tra ve response sau ~200ms
      | Varnish: "Co roi! Luu vao cache."
      |
      | Varnish serves response cho:
      |   - Request #1 (vua di lay)
      |   - Request #2 -> #10000 (dang cho)
      |
      +---> Origin (Backend)
              |
              | Nhan DUNG 1 REQUEST
              |   - Query DB: 1 lan
              |   - Tinh toan: 1 lan
              |   - CPU: 200ms, xong
              |
              +---> KET QUA:
                      - 10,000 users deu thay san pham
                      - Origin: 1 request, 200ms, nhe nhang
                      - DB: 1 query, 10ms
                      - App server: khong bi gi ca
                      - Marketing: $50,000 -> conversion tot
                      - Team: ngu ngon
```

### Ban chat cua van de

Day khong phai la van de "origin cham" hay "DB yeu". Day la van de
**tai sao phai gui cung mot cau hoi 10,000 lan khi cau tra loi giong
het nhau?**

```text
ANALOGY: Thu vien

KHONG CO coalescing:
  100 sinh vien cung vao thu vien cung luc.
  Tat ca cung hoi cung mot cuon sach.
  Thu thu chay vao kho, lay sach, quay ra dua cho nguoi #1.
  Nguoi #2 cung hoi cuon do -> thu thu LAI chay vao kho, LAI lay.
  ...
  100 lan chay vao kho cho cung 1 cuon sach.
  Thu thu kiet suc, 99 nguoi doi lau.

CO coalescing:
  Sinh vien #1 hoi sach.
  Thu thu: "De to lay." -> vao kho.
  Sinh vien #2-#100 cung hoi sach do.
  Thu thu (tu trong kho): "Sach dang lay, cac ban cho ti."
  Thu thu quay ra voi 1 cuon -> photo 100 ban -> phat cho tat ca.
  1 lan vao kho. 100 nguoi deu co sach. Ai cung vui.
```

### Tai sao cold cache la khong tranh khoi?

Cold cache la **trang thai tu nhien va khong the tranh khoi** cua moi CDN:

```text
Cac tinh huong dan den cold cache:

1. DEPLOY MOI:
   - Code moi, container moi -> cache trong hoan toan
   - Traffic dau tien sau deploy la COLD

2. PURGE / BAN:
   - Cap nhat du lieu san pham -> purge cache
   - Object bi xoa khoi cache -> request ke tiep la COLD

3. TTL HET HAN:
   - Cache TTL = 20s, 60s, 90s...
   - Het TTL -> object bi evict -> request ke tiep la COLD

4. SCALE OUT CDN NODE:
   - Them node CDN moi -> cache trong tren node moi
   - Request routed den node moi -> COLD

5. TRAFFIC SPIKE VOI URL MOI:
   - Campaign moi, URL moi -> chua tung duoc cache
   - 100% traffic la COLD
```

Trong TAT CA cac tinh huong tren, request coalescing la co che bao ve
origin khoi stampede. Khong can biet TAI SAO cache cold -- chi can
biet rang KHI cache cold, CDN phai bao ve origin.

### Hien thuc: push notification chi la mot vi du

```text
Cac tinh huong THAT SU gay stampede ngoai thuc te:

- Black Friday 00:00: hang trieu nguoi refresh cung luc
- Ticket sale (concert, sports): gio mo ban, F5 dong loat
- Game event reset: daily quest reset, tat ca player login cung luc
- Tin tuc breaking news: push notification -> millions open app
- He thong recover sau outage: tat ca client reconnect, cache expired
- DDoS "accidental": mot tinh nang viral, traffic gap 100x trong 5s
```

## 2. CDN capability being proved

### Request coalescing -- collapsed forwarding

Capability can chung minh:

```text
Cold cache + N concurrent requests (N >> 1) cung object key
    |
    +--> CHI 1 (hoac rat it) request duoc forward den origin
    |
    +--> Tat ca N request deu nhan duoc response 200 day du
    |
    +--> Response duoc cache lai -> request tiep theo la HIT
    |
    +--> Origin request count <= 2 (ideally = 1)
```

**Diem mau chot**: Khong phai chi la "tat ca request deu 200". Tat ca 200
la dieu kien CAN nhung chua DU. User-visible success (200) co the dat
duoc ngay ca khi origin da bi stampede -- boi vi backend van tra 200
ngay ca khi no sap chet.

**Bang chung khong the chon cai** la origin request count:

```text
CONTRACT CAN CHUNG MINH:

  origin_count <= 2  (khong duoc > 2)

  Y nghia: Origin chi nhan 1 (hoac toi da 2) request
  cho N concurrent cold requests (N co the la 8, 12, 50, 100...).

  Neu origin_count = N (bang so VU) -> ZERO coalescing -> stampede.
  Neu origin_count = 1 -> PERFECT coalescing.
  Neu origin_count = 2 -> ACCEPTABLE (xem giai thich o section collapsed forwarding).
```

### Tai sao <= 2 ma khong phai == 1?

Varnish co mot "lock window" rat nho giua thoi diem:
1. Request dau tien duoc forward den backend
2. Object duoc luu vao cache

Trong window nay (thuong < 1ms), mot request thu 2 CO THE lot qua
va cung duoc forward den backend. Day la hanh vi binh thuong va
chap nhan duoc. Threshold <= 2 bao gom ca truong hop nay.

Neu origin count = 3 tro len -> coalescing co van de -> can investigate.

## 3. Vi sao test o CDN layer

### Request coalescing la CDN built-in -- khong phai app feature

Request coalescing / collapsed forwarding la mot tinh nang **built-in**
cua Varnish (va hau het cac CDN/reverse proxy khac nhu Nginx, Squid,
Fastly, Cloudflare). No xay ra o **CDN edge**, truoc khi request den
bat ky application code nao.

```text
ARCHITECTURE STACK:

  Client (k6/User)
      |
      v
  CDN Edge (Varnish)  <-- REQUEST COALESCING XAY RA O DAY
      |                   Day la noi:
      |                   - Nhan biet nhieu request cung key
      |                   - Chi forward 1 (hoac rat it) request
      |                   - Cho response -> cache -> serve all
      v
  Nginx
      |
      v
  Application (App Server)
      |                   <-- App KHONG BIET coalescing da xay ra
      v                   App chi thay 1 request, khong thay 9,999 request khac
  Database
```

### App khong the test duoc coalescing

```text
NEU TEST O APP LAYER (thay vi CDN layer):

  App chi thay 1 request -> KHONG BIET co 10,000 request concurrent
  App tra 200, response time 200ms -> "OK, pass"

  Nhung cau hoi that su la:
  - "CDN co THAT SU coalesce 10,000 request thanh 1 khong?"
  - "Hay CDN forward ca 10,000 request, app tra ca 10,000, chi la
     app du nhanh nen khong thay van de?"

  App KHONG THE tra loi cau hoi nay. Boi vi app chi nhin thay
  nhung gi no nhan duoc -- no khong biet co bao nhieu request
  DA BI CHAN o CDN layer.

  DAY LA LY DO PHAI TEST O CDN LAYER.
```

### Origin request counting la cua so duy nhat

```text
               CDN Edge
                  |
    +-------------+-------------+
    |                           |
  Public path              Control path
  (port 80)               (port 8088)
    |                           |
  k6 fires N                  k6 queries
  concurrent                  GET /ops/app/cdn/
  requests                    origin/request-counts
    |                           |
  Varnish handles             App counter tells us
  coalescing                  HOW MANY requests
    |                         ACTUALLY hit origin
  Users see 200
                              |
                              DAY LA PROOF
```

Chi co origin request counting moi cho ta biet su that: "Origin that
su nhan bao nhieu request?" Con public path chi cho ta biet: "User
thay gi?"

Can ca hai -- public path cho user experience, control path cho
origin protection proof.

## 4. Topology and precondition

### Runtime topology

```text
                       +------------------+
                       |   k6 (test runner)|
                       +--------+---------+
                                |
                +---------------+---------------+
                |                               |
          Public Path                       Control Path
          http://localhost:80               http://localhost:8088
                |                               |
        +-------v--------+             +--------v--------+
        | Varnish (CDN)  |             | Nginx -> App    |
        |                |             | (ops endpoints) |
        +-------+--------+             +--------+--------+
                |                               |
        +-------v--------+                      |
        | Nginx (reverse |                      |
        | proxy -> app)  |                      |
        +-------+--------+                      |
                |                               |
        +-------v--------+                      |
        | Application    | <--------------------+
        | (products,     |     Origin request
        |  cart, etc.)   |     counter lives here
        +----------------+
```

### Paths

```text
Public path:  http://localhost:80/api/cached?key=coalesce-<timestamp>&ttl_seconds=30&origin_delay_ms=800
              -> Varnish -> Nginx -> App
              -> Day la path k6 goi N concurrent requests
              -> origin_delay_ms=800: app se delay 800ms truoc khi tra response
                 (mo phong origin cham -- tao window cho coalescing)

Control path: http://localhost:8088/ops/app/cdn/origin/request-counts       (GET)
              http://localhost:8088/ops/app/cdn/origin/request-counts/reset (POST)
              http://localhost:8088/ops/app/cdn/origin/profile              (PATCH)
              -> Day la path k6 dung de:
                 1. Reset origin counter ve 0
                 2. Ban URL (xoa cache)
                 3. Doc origin request count sau test
                 4. Reset origin profile

Event path:   Khong su dung trong case nay
```

### Precondition

Truoc khi chay test, phai dam bao:

```text
1. CACHE TRONG (COLD):
   - Ban URL can test: POST /ops/app/cdn/cache/ban-url
   - Xac nhan cache da bi xoa

2. ORIGIN COUNTER VE 0:
   - POST /ops/app/cdn/origin/request-counts/reset
   - Dam bao counter bat dau tu 0

3. ORIGIN DELAY DUOC CONFIGURE:
   - origin_delay_ms = 800 (mac dinh)
   - Origin se delay 800ms truoc khi tra response
   - Tao window cho nhieu request den trong khi request dau
     dang duoc fetch

4. ORIGIN HEALTHY:
   - waitOriginHealthy() xac nhan origin san sang
   - Tranh fail do origin chua up sau lan chay truoc

5. TTL DUOC SET:
   - ttl_seconds = 30 (mac dinh)
   - Dam bao object duoc cache du lau de verify HIT sau test

6. ENVIRONMENT VARIABLES:
   - OPS_AUTH_TOKEN: token de goi control API
   - BASE_URL: public CDN URL (mac dinh http://localhost:80)
   - CONTROL_BASE_URL: control API URL (mac dinh http://localhost:8088)
```

## 5. Script deep-dive

### Tong quan script

Script `10-request-coalescing.js` dai 82 dong, nhung goi gon toan bo
logic can thiet de chung minh request coalescing. Cau truc:

```text
10-request-coalescing.js
|
+-- options:              vus=1, iterations=1, thresholds
|                         (LUU Y: vus=1 o day la cho single-VU mode,
|                          concurrency duoc kiem soat boi http.batch,
|                          KHONG PHAI boi VU count cua k6)
|
+-- setup():              Build cold path + ban + reset counters
|
+-- default():            Fire N concurrent requests + verify
|
+-- teardown():           Clean up (reset origin profile + counters)
```

### Env knobs

```text
COALESCE_CONCURRENCY     = 12     So request concurrent (so phan tu trong http.batch)
                          Mac dinh: 12
                          Y nghia: Mo phong 12 nguoi dung goi API dong thoi

COALESCE_ORIGIN_DELAY_MS = 800    Delay origin (ms) cho /api/cached
                          Mac dinh: 800ms
                          Y nghia: Origin se ngu 800ms truoc khi tra response
                                   Tao window cho cac request khac den trong
                                   khi request dau tien dang duoc fetch

COALESCE_TTL_SECONDS     = 30     TTL cua cached object (giay)
                          Mac dinh: 30s
                          Y nghia: Du lau de verify HIT sau test
```

### setup() -- Chuan bi cold path

```text
STEP BY STEP trong setup():

1. buildCachedPath(`coalesce-${Date.now()}`, {
     ttl_seconds: COALESCE_TTL_SECONDS,      // 30s
     origin_delay_ms: COALESCE_ORIGIN_DELAY_MS  // 800ms
   })

   Tao URL duy nhat: /api/cached?key=coalesce-1719000000000
                                          &ttl_seconds=30
                                          &origin_delay_ms=800

   - key = coalesce-<timestamp>: dam bao moi lan chay la URL moi,
     tranh overlap voi cache cu
   - ttl_seconds=30: object se song 30s trong cache
   - origin_delay_ms=800: origin se delay 800ms -> tao window

2. resetOriginProfile()
   POST /ops/app/cdn/origin/reset
   -> Reset origin profile ve default (origin_delay_ms, unhealthy flags...)

3. waitOriginHealthy({ label: 'coalescing setup origin recovery' })
   -> Poll origin health cho den khi healthy
   -> Dam bao origin san sang nhan request

4. resetOriginRequestCounts()
   POST /ops/app/cdn/origin/request-counts/reset
   -> Counter ve 0

5. banUrl(path)
   POST /ops/app/cdn/cache/ban-url  { url: path }
   -> Xoa object khoi Varnish cache (neu co)
   -> Dam bao COLD cache

6. return { path }
   -> Tra ve path cho default() su dung
```

**Tai sao origin_delay_ms QUAN TRONG?**

```text
Neu origin_delay_ms = 0 (origin respond ngay lap tuc):

  t=0ms:    Request #1 den Varnish -> forward den origin
  t=0ms:    Origin nhan, process, tra response (1ms)
  t=1ms:    Varnish nhan response, luu cache, tra cho request #1
  t=2ms:    Request #2 den Varnish -> nhung cache da co roi -> HIT
            (KHONG can coalescing nua!)

  Window coalescing chi 1ms -> rat kho de bat duoc nhieu request
  trong window -> request #2 thay HIT, khong di qua origin.

Neu origin_delay_ms = 800 (origin delay 800ms):

  t=0ms:    Request #1 den Varnish -> forward den origin
  t=0-10ms: Request #2...#12 cung den Varnish
            Varnish: "Object dang duoc fetch. Cho."
  t=800ms:  Origin tra response -> Varnish luu cache
  t=801ms:  Varnish serve response cho TAT CA 12 request

  Window coalescing = 800ms -> du rong de bat tat ca 12 request.
```

`origin_delay_ms` la "slow origin simulator" -- no tao ra mot
window du dai de k6 co thoi gian fire nhieu request concurrent
va Varnish co thoi gian thuc hien coalescing.

### default() -- Fire concurrent requests + verify

Day la trai tim cua test:

```text
STEP BY STEP trong default():

1. Tao N concurrent requests:

   const requests = Array.from({ length: COALESCE_CONCURRENCY }, (_, i) => ({
     method: 'GET',
     url: `${CDN_BASE_URL}${path}`,
     params: {
       headers: buildHeaders(),
       tags: { case: `coalescing_batch_${i}` },
     },
   }));

   - Array.from({ length: 12 }) tao 12 request objects
   - TAT CA cung URL, cung headers -> cung cache key
   - Moi request co tag rieng de tracking

2. http.batch(requests):
   - Gui TAT CA 12 requests DONG THOI
   - k6 mo nhieu HTTP connection cung luc
   - Varnish nhan 12 requests gan nhu cung mot thoi diem

3. Verify tat ca response deu 200:

   for (const [index, res] of responses.entries()) {
     assertStatus(res, 200, `coalescing batch ${index}`);
   }

   - Tat ca 12 request phai tra 200
   - Khong duoc co timeout hay error

4. Follow-up request verify HIT:

   const afterWarm = requestCdn('GET', path, { ... });
   assertStatus(afterWarm, 200, 'coalescing after warm');
   assertCacheState(afterWarm, 'HIT', 'coalescing after warm');

   - Goi lai cung URL SAU KHI batch hoan thanh
   - Phai tra HIT -> chung to object da duoc cache

5. DONG PROOF -- Origin request count:

   const counts = getOriginRequestCounts();
   const requestCount = findOriginRequestCount(counts, path);
   if (requestCount > 2) {
     throw new Error(`expected coalesced origin hits <= 2, got ${requestCount}`);
   }

   - getOriginRequestCounts(): GET /ops/app/cdn/origin/request-counts
     Tra ve JSON chua danh sach cac path va count tuong ung
   - findOriginRequestCount(counts, path): Tim count cho path cua minh
   - Neu count > 2 -> throw Error -> k6 FAIL

   DAY LA PROOF: origin chi nhan <= 2 request cho 12 concurrent requests.
```

### http.batch -- Concurrency trong k6

```text
http.batch(requests) la API cua k6 de gui nhieu requests dong thoi:

  - KHONG PHAI VU count (options.vus = 1, day la "single script instance")
  - Batch se mo nhieu HTTP connections CUNG LUC
  - Ca 12 requests duoc gui di trong cung mot event loop tick
  - Chung den Varnish trong khoang vai millisecond

  Diem khac biet voi VU concurrency:
    - VU concurrency (vus=12): 12 VU doc lap, moi VU 1 request
      -> 12 requests nhung khong dam bao DONG THOI tuyet doi
    - http.batch: 1 VU, 12 requests trong mot batch
      -> 12 requests duoc schedule CUNG LUC boi k6 core
      -> Dong bo cao hon -> de bat coalescing hon

  Vi vay options.vus = 1 nhung test van co concurrency 12.
  Concurrency nam trong http.batch, khong nam trong VU count.
```

### teardown -- Cleanup

```text
resetOriginProfile();
waitOriginHealthy({ label: 'coalescing teardown origin recovery' });
resetOriginRequestCounts();

- Khoi phuc origin profile (xoa origin_delay_ms config)
- Doi origin healthy lai (origin co the bi delay/error tu test)
- Reset counter de khong anh huong case ke tiep
```

## 6. Collapsed forwarding deep-dive

### Varnish request coalescing -- co che noi bo

Day la **linh hon** cua case 10. Hieu duoc co che nay giup ban hieu
tai sao origin count <= 2 va tai sao CDN la lop bao ve quan trong.

```text
CO CHE COLLAPSED FORWARDING CUA VARNISH
==============================================================

BUOC 1: REQUEST DAU TIEN DEN (OBJECT COLD)

  Client #1:  GET /api/cached?key=coalesce-xxx&origin_delay_ms=800
              |
  Varnish:    Lookup cache...
              -> Cache: MISS (chua co object nay)
              -> Quyet dinh: fetch tu backend
              -> Tao "busy object" (object dang duoc fetch)
              -> Forward request #1 den backend
              -> Mark object state: IN-FLIGHT

BUOC 2: REQUEST THU 2, 3, ... N DEN TRONG KHI DANG FETCH

  Client #2:  GET /api/cached?key=coalesce-xxx&origin_delay_ms=800
              |
  Varnish:    Lookup cache...
              -> Cache: MISS (chua co)
              -> Nhung phat hien: object nay DANG DUOC FETCH
                 (co mot "busy object" cho key nay)
              -> Thay vi forward them 1 request nua den origin
              -> Varnish dua request #2 vao... WAIT LIST
              -> Request #2 bi "parked" (Varnish dung tu "waitinglist")

  Client #3:  Tuong tu -> WAIT LIST
  Client #N:  Tuong tu -> WAIT LIST

  Trong WAIT LIST co the co HANG TRAM, HANG NGHIN requests
  dang cho cung mot object.

BUOC 3: BACKEND RESPONSE VE

  Backend:    Tra response cho request #1 (sau origin_delay_ms + process time)
              |
  Varnish:    Nhan response tu backend
              -> Luu object vao cache (voi TTL da duoc tinh)
              -> Object state: READY (khong con in-flight)

BUOC 4: SERVE CHO TAT CA WAITING REQUESTS

  Varnish:    Gui response cho:
              - Request #1 (request goc vua duoc backend tra ve)
              - Request #2 (tu wait list)
              - Request #3 (tu wait list)
              - ...
              - Request #N (tu wait list)

              TAT CA nhan cung mot response. TAT CA deu la... MISS
              (vi object chua ton tai trong cache khi request den;
               X-Cache = MISS cho batch dau tien, HIT cho cac
               request den SAU KHI object da vao cache).

BUOC 5: CACHE DA NONG

  Request #N+1 den:
  Varnish:    Lookup cache...
              -> HIT!
              -> Serve tu cache ngay lap tuc
              -> Origin: 0 requests them
```

### Wait list mechanism

```text
WAIT LIST LA GI?

  Trong Varnish source code, no goi la "waitinglist". Day la mot
  linked list cac session (client connections) dang cho cung mot
  object duoc fetch.

  Moi object (objcore) trong Varnish co:
    - Busy object pointer: tro den busy object neu dang fetch
    - Waiting list: danh sach cac session dang cho

  Khi mot request den va thay busy object:
    - Request duoc attach vao waiting list
    - Session bi "park" (Varnish ngu, khong tieu ton CPU)
    - Khi busy object resolve:
      -> Varnish "unpark" tat ca session trong waiting list
      -> Gui response cho tung session
      -> Tat ca deu nhan duoc response tu cache (vua moi duoc luu)

  DAY LA CO CHE COT LOI. Khong can VCL config. Mac dinh.
```

### Khong can VCL -- built-in behavior

```text
QUAN TRONG: REQUEST COALESCING LA BUILT-IN

  Trong toan bo file default.vcl (303 dong), KHONG CO MOT DONG NAO
  noi ve "coalescing" hay "collapsed forwarding" hay "waiting list".

  Day la hanh vi MAC DINH cua Varnish cho bat ky object cacheable nao.
  Khong can config, khong can VCL code, khong can flag.

  Dieu kien de coalescing hoat dong:
    1. Object CO THE duoc cache (TTL > 0, khong bi uncacheable)
    2. Nhieu requests CUNG CACHE KEY den trong khi object dang fetch

  Varnish tu dong lam moi thu con lai.

  Tuy nhien, co mot vai truong hop coalescing KHONG hoat dong:
    - Object co Cache-Control: private/no-store -> khong cache -> khong coalesce
    - Request bi pass (auth, cookie, write method) -> khong cache -> khong coalesce
    - Backend tra error 500 -> thong thuong khong cache -> khong coalesce
```

### origin_delay_ms -- the key tuning parameter

```text
TAC DONG CUA origin_delay_ms DEN COALESCING:

origin_delay_ms = 0 (origin respond ngay, 1ms latency):
  Window             [*]                                        <- 1ms
  Requests           R1                                        <- chi 1 request kip vao window
  Ket qua:           Origin count = 1 (perfect)
  Nhung:             Day la origin that su nhanh -> khong test duoc
                     kha nang coalesce nhieu requests thuc te

origin_delay_ms = 200 (origin delay 200ms):
  Window             [*************]                            <- 200ms
  Requests           R1 R2 R3 R4 R5 R6 R7 R8 R9 R10 R11 R12   <- tat ca vao window
  Ket qua:           Origin count = 1 (perfect coalescing!)
                     Window du rong de Varnish bat tat ca

origin_delay_ms = 800 (mac dinh cua script):
  Window             [**************************************]   <- 800ms
  Requests           R1 R2 R3 R4 R5 R6 R7 R8 R9 R10 R11 R12   <- tat ca vao window
  Ket qua:           Origin count = 1-2
                     Window rat rong, coalescing gan nhu luon luon xay ra

origin_delay_ms = 5000 (origin delay 5s):
  Window             [*******************************************] <- 5s
                    ********************************************
  Requests           R1 R2 ... R12
  Ket qua:           Origin count = 1-2 (van coalesce duoc)
  Nhung:             User phai doi 5s -> co the timeout neu timeout < 5s

Y NGHIA:
  - origin_delay_ms cang LON -> window cang RONG -> cang DE coalesce
  - origin_delay_ms cang NHO -> window cang HEP -> cang KHO coalesce
  - Origin that su cham (high latency) -> DE coalesce -> CDN bao ve TOT HON
  - Origin that su nhanh (low latency) -> KHO coalesce -> nhung cung IT CAN HON
    (vi origin nhanh co the handle nhieu requests)
```

### Collapse edge case: second request "steals through"

```text
LOCK WINDOW EXPLANATION:

  Trong Varnish, giua thoi diem:
    (a) Request #1 duoc forward den backend
    (b) Busy object duoc tao VA duoc insert vao object index

  Co mot khoang gap CUC KY NHO (microseconds), noi mot request #2
  co the lot qua ma khong thay busy object. Request #2 se cung
  duoc forward den backend.

  Ket qua: 2 requests den origin thay vi 1.

  Day la ly do threshold la <= 2 (khong phai == 1):
    - Origin count = 1: perfect coalescing
    - Origin count = 2: 1 request bi "steal through" -> acceptable
    - Origin count >= 3: van de thuc su -> Varnish config hoac bug

  Trong thuc te, origin count = 2 la kha hiem. Thuong gap origin
  count = 1 neu origin_delay_ms du lon.
```

## 7. Origin request counting as coalescing evidence

### Tai sao can origin counter?

Khong co origin counter, ta chi thay "tat ca request tra 200". Nhung:

```text
NEU CHI NHIN PUBLIC PATH (KHONG CO ORIGIN COUNTER):

  Scenario A (coalescing OK):
    - 12 requests -> 1 origin request -> origin nhe nhang
    - User sees: 12x 200
    - Conclusion: "OK"

  Scenario B (ZERO coalescing, origin chiu duoc):
    - 12 requests -> 12 origin requests -> origin fully loaded
    - User sees: 12x 200  <-- GIONG HET SCENARIO A
    - Conclusion: "OK" (SAI LAM!)

  Scenario C (ZERO coalescing, origin sap chet):
    - 12 requests -> 12 origin requests -> 3 timeout
    - User sees: 9x 200, 3x timeout
    - Conclusion: "FAIL" (chi phat hien khi origin da QUA TAI)

  KHONG CO ORIGIN COUNTER, SCENARIO A VA B NHIN GIONG HET NHAU.
  Origin counter la bang chung DUY NHAT phan biet duoc A va B.
```

### Origin counter API

```text
GET /ops/app/cdn/origin/request-counts

Response:
{
  "data": {
    "counts": [
      {
        "request_key": "/api/cached?key=coalesce-1719000000000&ttl_seconds=30&origin_delay_ms=800",
        "method": "GET",
        "count": 1
      },
      {
        "request_key": "/api/cached?key=health-1719000001234&ttl_seconds=1&origin_delay_ms=0",
        "method": "GET",
        "count": 3
      }
    ]
  }
}

Moi entry: request_key (URL path), method (HTTP method), count (so lan origin nhan)
```

### Counter flow qua cac giai doan

```text
FLOW CUA ORIGIN COUNTER QUA MOT LAN TEST:

1. resetOriginRequestCounts():
   POST /ops/app/cdn/origin/request-counts/reset
   -> Tat ca counters ve 0
   -> state: EMPTY

2. setup() calls: banUrl(), reset counters, maybe health probes
   -> Mot vai request co the hit origin (health probes)
   -> Nhung do la cac path KHAC (health-xxx), khong phai test path

3. default() fires 12 concurrent requests:
   -> Neu coalescing OK: 1 (hoac 2) request den origin
   -> Counter cho test path: 1 (hoac 2)

4. default() queries counter:
   -> getOriginRequestCounts() -> tra ve full JSON
   -> findOriginRequestCount(counts, testPath) -> extract count for OUR path
   -> Verify count <= 2

5. teardown() resets counters:
   -> POST reset -> ve 0
   -> San sang cho case tiep theo
```

### findOriginRequestCount() -- extract dung path

```text
function findOriginRequestCount(payload, requestKey):
  const counts = payload?.data?.counts || [];
  for (const entry of counts) {
    if (entry?.request_key === requestKey) {
      return Number(entry.count || 0);
    }
  }
  return 0;  // khong tim thay -> 0 (chua tung hit origin)

Tai sao phai extract DUNG PATH?
  - Counter chua TAT CA request den origin, bao gom:
    - Health probes tu waitOriginHealthy()
    - Cac request tu setup()
    - Requests tu cac case khac (neu khong reset)
  - Neu khong extract dung path -> doc sai count -> sai ket qua

Tai sao return 0 neu khong tim thay?
  - Co the path chua tung den origin (coalescing tuyet doi)
  - Hoac path da bi xoa khoi counter
  - An toan hon la throw error (vi se pass threshold <= 2)
```

### Interpreting counter values

```text
ORIGIN COUNT VA Y NGHIA:

count = 0:  Khong request nao den origin
            -> Co the cache da hot truoc do (khong cold nhu mong doi)
            -> Hoac ban/purge khong hoat dong
            -> Hoac findOriginRequestCount khong match dung key
            -> Can kiem tra lai setup

count = 1:  PERFECT coalescing
            -> Dung 1 request den origin
            -> 11 (hoac N-1) request con lai duoc coalesce
            -> CDN bao ve origin HOAN HAO

count = 2:  ACCEPTABLE coalescing
            -> 1 request den origin, 1 request "steals through"
            -> Van la coalescing hoat dong (khong phai 12 requests)
            -> Threshold <= 2 cho phep truong hop nay

count = 3-11: WEAK coalescing
            -> Co mot phan requests bi forward den origin
            -> Coalescing co nhung khong hoan chinh
            -> Co the do origin qua nhanh (window qua nho)
            -> Hoac do Varnish config/version

count = 12 (= concurrency): ZERO coalescing -> STAMPEDE
            -> Moi request deu den origin
            -> Coalescing KHONG hoat dong
            -> Origin bi stampede day du
            -> Can investigation Varnish config

count > 12 (> concurrency): Co van de
            -> Nhieu hon ca so request da gui
            -> Co the retry hoac health probe them
            -> Can investigation
```

## 8. Concurrency model

### k6 concurrency trong case 10

```text
CONCURRENCY MODEL:

  options: {
    vus: 1,           // 1 VU duy nhat (single script instance)
    iterations: 1,    // Chay 1 lan
  }

  Trong default():
    http.batch([      // Batch 12 requests CUNG LUC
      request_0,
      request_1,
      ...
      request_11
    ])

  DIEU NAY CO NGHIA:
    - 1 VU chay setup() -> default() -> teardown()
    - Trong default(), 1 VU fire 12 requests dong thoi qua http.batch
    - Ca 12 requests duoc k6 schedule gan nhu cung mot thoi diem

  TAI SAO KHONG DUNG vus=12, iterations=1?
    - vus=12 se tao 12 VU doc lap
    - Moi VU chay setup() RIENG -> tao 12 path khac nhau!
    - 12 VU, 12 path khac nhau -> khong coalesce duoc (key khac nhau)
    - http.batch dam bao CUNG VU, CUNG PATH, CUNG LUC

  TAI SAO KHONG DUNG vus=12 voi shared setup?
    - VU doc lap co the start hoi lech nhau (vai ms den vai tram ms)
    - http.batch dong bo hoa trong cung mot event loop tick -> dong thoi cao hon
    - Muc tieu la bat coalescing -> can concurrency cang chat che cang tot
```

### Timeline cua mot lan test

```text
TIMELINE (origin_delay_ms = 800):

  t=0ms:     setup() completes
             - Cache: cold
             - Counter: 0

  t=1ms:     default() starts
             - http.batch(12 requests) fire
             - Ca 12 requests duoc gui di cung luc

  t=2-5ms:   12 requests den Varnish
             - Request #1: MISS -> forward to origin
             - Request #2-12: thay object in-flight -> WAIT LIST

  t=5ms:     Origin nhan request #1
             - Bat dau delay 800ms (origin_delay_ms)
             - Trong 800ms nay, Varnish giu 11 requests trong wait list

  t=805ms:   Origin tra response cho request #1
             - Varnish nhan response, luu cache

  t=806ms:   Varnish serve response cho:
             - Request #1 (vua fetch xong)
             - Request #2-12 (tu wait list, lay tu cache)

  t=810ms:   http.batch resolves
             - responses array co 12 responses
             - Tat ca status 200 (ve mat logic)

  t=811ms:   Verify batch responses
             - assertStatus cho 12 responses -> all 200

  t=815ms:   Follow-up request
             - requestCdn('GET', path)
             - X-Cache: HIT (object da trong cache)

  t=820ms:   Origin count query
             - getOriginRequestCounts()
             - findOriginRequestCount() -> phai <= 2

  t=830ms:   default() completes -> pass

  t=831ms:   teardown()
             - resetOriginProfile()
             - waitOriginHealthy()
             - resetOriginRequestCounts()
```

### Race condition trong thuc te

```text
DIEU GI XAY RA NEU CAC REQUEST DEN LECH NHAU?

Thuc te, ngay ca http.batch cung khong dam bao 12 requests den
Varnish trong cung 1 millisecond. Network jitter, TCP handshake,
TLS (neu co) deu tao ra do lech nho.

Tuy nhien, origin_delay_ms = 800ms tao ra window du RONG de
ngay ca request cuoi cung (den sau 50-100ms) van kip vao
wait list truoc khi origin response.

Neu origin_delay_ms = 0 (chi 1-2ms de fetch):
  - Chi 2-3 request dau tien kip vao wait list
  - Cac request con lai den sau khi cache da hot -> HIT
  - Origin count van = 1 (hoac 2)
  - Nhung khong test duoc kha nang coalesce nhieu requests

Day la ly do origin_delay_ms quan trong trong test:
  - Origin cham (high delay) -> test duoc coalescing "hard mode"
  - Origin nhanh (low delay) -> de pass nhung khong test duoc nhieu
```

## 9. Key signals

### Signals can doc

```text
SIGNAL 1: BATCH RESPONSES STATUS
  - Y nghia: Tat ca N concurrent requests tra 200
  - Cach doc: assertStatus(res, 200) cho moi response trong batch
  - Expect: 12/12 responses status 200
  - Neu FAIL: Co request bi timeout hoac error -> origin qua tai
    hoac Varnish khong xu ly duoc concurrency

SIGNAL 2: FOLLOW-UP CACHE STATE
  - Y nghia: Request sau batch phai la HIT
  - Cach doc: assertCacheState(afterWarm, 'HIT')
  - Expect: X-Cache = HIT
  - Neu MISS: Object khong duoc cache sau batch dau tien
    -> Co van de voi Varnish caching policy hoac TTL

SIGNAL 3: ORIGIN REQUEST COUNT
  - Y nghia: So request THUC TE den origin cho path test
  - Cach doc: getOriginRequestCounts() -> findOriginRequestCount()
  - Expect: <= 2 (ly tuong: 1)
  - Neu > 2: Coalescing khong hoat dong hoac hoat dong kem
  - DAY LA SIGNAL QUAN TRONG NHAT

SIGNAL 4: RESPONSE CONSISTENCY
  - Y nghia: Tat ca batch responses co cung body (giong het nhau)
  - Cach doc: Khong check truc tiep trong script, nhung co the
    verify bang cach so sanh body cua cac response
  - Expect: Tat ca responses identical
  - Neu khac nhau: Co the origin tra different responses
    (co van de voi origin idempotency)

SIGNAL 5: RESPONSE TIME DISTRIBUTION
  - Y nghia: Thoi gian phan bo cua cac response
  - Cach doc: k6 metrics http_req_duration
  - Expect: Request dau tien ~800ms (origin_delay), cac request
    con lai cung ~800ms (vi cung cho cung mot response)
  - Neu khac biet lon: Co the mot so request khong duoc coalesce
    -> phai tu fetch tu origin -> lau hon
```

### Signal interpretation matrix

```text
MATRIX: SIGNALS VA KET LUAN

| Status | Follow-up | Origin Count | Ket luan |
|--------|-----------|-------------|----------|
| All 200| HIT       | 1           | PERFECT: coalescing hoat dong hoan hao |
| All 200| HIT       | 2           | ACCEPTABLE: coalescing OK, 1 request lot qua lock window |
| All 200| HIT       | 3-11        | WEAK: coalescing hoat dong mot phan, can tune |
| All 200| HIT       | 12          | ZERO coalescing (nhung app du nhanh -> user van OK) |
| All 200| MISS      | any         | Cache not stored -> Varnish policy problem |
| Timeout| N/A       | any         | Origin qua tai hoac timeout < origin_delay_ms |
| Mixed  | HIT       | 12          | Origin dang stampede, mot so request timeout |
```

### Meta-signal: k6 exit code

```text
k6 EXIT CODE:

  0: PASS
    - Tat ca checks pass
    - Tat ca thresholds met (checks: rate==1, http_req_failed: rate==0)
    - Origin count <= 2

  >0: FAIL
    - Co check fail (status != 200, cache != HIT)
    - Co origin count > 2 (throw Error)
    - Co HTTP request failed
    - Threshold bi breached
```

## 10. Pass/fail criteria

### PASS criteria

```text
CASE PASS KHI TAT CA CAC DIEU KIEN SAU DUNG:

1. k6 exits 0 (khong co error, khong co threshold breach)

2. Tat ca batch requests tra 200:
   - 12/12 requests (hoac COALESCE_CONCURRENCY requests) deu 200
   - Khong request nao timeout hoac 5xx

3. Follow-up request tra HIT:
   - X-Cache = HIT
   - Chung to object da duoc cache sau batch dau tien

4. Origin request count <= 2:
   - COUNT cho path test (khong phai total counter)
   - 1 la perfect, 2 la acceptable

5. Teardown completes:
   - Origin profile duoc reset (khong con delay)
   - Origin healthy
   - Counters duoc reset
```

### FAIL criteria

```text
CASE FAIL KHI BAT KY DIEU KIEN NAO SAU XAY RA:

1. k6 exits != 0:
   - Check failure hoac threshold breach

2. Mot hoac nhieu batch requests KHONG tra 200:
   - Timeout (co the do origin_delay_ms > k6 timeout)
   - 502/503 (origin qua tai, crash, hoac backend down)
   - 504 (gateway timeout -- Varnish khong nhan duoc response tu origin)

3. Follow-up request KHONG tra HIT:
   - X-Cache = MISS -> object khong duoc luu cache
   - Nguyen nhan: TTL = 0, Cache-Control: no-store, Set-Cookie,
     hoac Varnish policy khong cache object

4. Origin request count > 2:
   - 3-11: coalescing hoat dong kem
   - 12 (bang concurrency): ZERO coalescing -> STAMPEDE
   - >12: co van de voi counter hoac co request them tu dau do

5. Origin request count = 0:
   - Path khong xuat hien trong counter
   - Co the cache da hot truoc khi test (ban fail)
   - Hoac findOriginRequestCount khong match key

6. Control API khong available:
   - Khong goi duoc /ops/app/cdn/origin/request-counts
   - Token khong hop le
   - Control path khong duoc expose dung
```

### Threshold explanation

```text
options.thresholds: {
  checks: ['rate==1'],              // 100% checks phai pass
  http_req_failed: ['rate==0'],     // 0% HTTP request fail
}

checks rate == 1:
  - Tat ca check() calls (assertStatus, assertCacheState)
    deu phai pass
  - Neu mot check fail -> rate < 1 -> threshold breach -> FAIL

http_req_failed rate == 0:
  - Khong request nao bi error (timeout, connection refused, DNS fail)
  - Neu co 1 request error -> rate > 0 -> threshold breach -> FAIL

Day la co che bao ve kep:
  - Check bao ve correctness (status, cache state)
  - Threshold bao ve quality (check rate, failure rate)
```

## 11. Cach chay va output

### Cach chay co ban

```powershell
# Tu thu muc k6-metrics-server
cd E:/Projects/k6/k6-metrics-server

# Set required env vars
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

# Run case 10
./scripts/run-cdn-capabilities.ps1 -Scenarios 10-request-coalescing
```

### Cach chay voi custom knobs

```powershell
# Tang concurrency len 50
$env:COALESCE_CONCURRENCY = "50"

# Tang origin delay de tao window lon hon
$env:COALESCE_ORIGIN_DELAY_MS = "2000"

# Tang TTL de verify HIT lau hon
$env:COALESCE_TTL_SECONDS = "60"

# Run
./scripts/run-cdn-capabilities.ps1 -Scenarios 10-request-coalescing
```

### Cach chay truc tiep k6 (khong qua wrapper)

```powershell
cd E:/Projects/k6/k6-metrics-server/load-target/k6

k6 run `
  -e BASE_URL=http://localhost:80 `
  -e CONTROL_BASE_URL=http://localhost:8088 `
  -e CATALOG_EVENTS_BASE_URL=http://localhost:9091 `
  -e OPS_AUTH_TOKEN=<ops-token> `
  -e COALESCE_CONCURRENCY=12 `
  -e COALESCE_ORIGIN_DELAY_MS=800 `
  -e COALESCE_TTL_SECONDS=30 `
  cdn/10-request-coalescing.js
```

### Output thanh cong (expected)

```text
  execution: local
     script: cdn/10-request-coalescing.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations for each of 1 VUs

  running (00m01.2s), 1/1 VUs, 0 complete and 0 interrupted iterations
  default   [   0% ] 1 VUs  00m01.2s/10m0s  0/1 shared iters

  running (00m01.8s), 1/1 VUs, 1 complete and 0 interrupted iterations
  default   [ 100% ] 1 VUs  00m01.8s/10m0s  1/1 shared iters

     data_received..............: 15 kB
     data_sent..................: 2.1 kB
     http_req_blocked...........: avg=1.2ms   min=0.1ms  med=0.3ms   max=12ms   p(90)=2.1ms  p(95)=5.4ms
     http_req_connecting........: avg=0.3ms   min=0ms    med=0.1ms   max=3.2ms  p(90)=0.8ms  p(95)=1.5ms
     http_req_duration..........: avg=812ms   min=3ms    med=808ms   max=825ms  p(90)=815ms  p(95)=820ms
     http_req_failed............: 0.00%  ✓ 0
     http_req_receiving.........: avg=0.2ms   min=0.05ms med=0.1ms   max=1.2ms  p(90)=0.3ms  p(95)=0.5ms
     http_req_sending...........: avg=0.1ms   min=0.02ms med=0.05ms  max=0.8ms  p(90)=0.1ms  p(95)=0.2ms
     http_req_waiting...........: avg=811ms   min=2ms    med=807ms   max=825ms  p(90)=815ms  p(95)=819ms
     http_reqs..................: 15    (12 batch + 1 follow-up + ~2 health/control)
     iteration_duration.........: avg=1.8s   min=1.8s   med=1.8s   max=1.8s   p(90)=1.8s  p(95)=1.8s
     iterations.................: 1
     vus........................: 1
     vus_max....................: 1

  checks........................: 100.00% ✓ 28
     ✓ coalescing batch 0 status 200
     ✓ coalescing batch 1 status 200
     ... (12 batch checks)
     ✓ coalescing after warm status 200
     ✓ coalescing after warm cache state HIT
     ✓ reset origin request counts status 200
     ... (control path checks)

  all checks passed
```

### Output that bai (vi du: origin count cao)

```text
ERRO[0015] expected coalesced origin hits for /api/cached?key=coalesce-1719000000000
     &ttl_seconds=30&origin_delay_ms=800 to stay <= 2, got 12

  running (00m02.0s), 1/1 VUs, 1 complete and 0 interrupted iterations
  default   [ 100% ] 1 VUs  00m02.0s/10m0s  1/1 shared iters

  checks........................: 92.30%  ✗ 2
     ✗ expected coalesced origin hits...

  Thresholds:
     checks: rate==1 .....................: 92.30% ✗ FAILED

  ERRO[0015] thresholds on metrics 'checks' have been crossed
```

Key signal: `got 12` nghia la origin nhan 12 requests = ZERO coalescing.

## 12. 4 output -> decision scenarios

### Scenario A: Origin count = 1, all HIT -- PERFECT

```text
OBSERVATION:
  - 12 batch requests: all 200
  - Follow-up: X-Cache = HIT
  - Origin count: 1

DIAGNOSIS:
  PERFECT COALESCING. Varnish da coalesce 12 requests thanh 1 origin
  request. Khong co request nao lot qua lock window.

DECISION:
  PASS. CDN dang bao ve origin hoan hao truoc thundering herd.
  He thong san sang cho production traffic spike.

  Co the confidence cao rang khi 10,000 nguoi cung mo app,
  origin chi nhan 1 request (khong phai 10,000).

ACTION:
  - Tiep tuc theo doi origin count trong monitoring
  - Xem xet giam origin_delay_ms neu origin thuc te nhanh hon 800ms
  - Document: coalescing verified, CDN contract met
```

### Scenario B: Origin count = 2 -- ACCEPTABLE

```text
OBSERVATION:
  - 12 batch requests: all 200
  - Follow-up: X-Cache = HIT
  - Origin count: 2

DIAGNOSIS:
  ACCEPTABLE COALESCING. Varnish da coalesce 10 requests, nhung 1
  request thu hai da lot qua lock window truoc khi object vao cache.
  Day la hanh vi binh thuong o Varnish, khong phai bug.

  Ratio: 12 requests -> 2 origin = 83% reduction (van rat tot).

DECISION:
  PASS. Coalescing van hoat dong tot. Origin duoc giam tai 83% so
  voi khong coalescing.

ACTION:
  - Accept; day la expected behavior
  - Neu muon dat 1 tuyet doi: tang origin_delay_ms (window rong hon)
    hoac kiem tra Varnish version/params lien quan den lock window
  - Document: threshold <= 2 verified, CDN contract met
```

### Scenario C: Origin count = 12 (= VU count) -- STAMPEDE

```text
OBSERVATION:
  - 12 batch requests: all 200 (may man, origin du nhanh)
  - Follow-up: X-Cache = HIT (object duoc cache sau khi fetch xong)
  - Origin count: 12

DIAGNOSIS:
  ZERO COALESCING. Moi request deu di qua origin. Varnish khong
  coalesce mot request nao ca. Day la cache stampede.

  Trong truong hop nay, user van thay OK (tat ca 200), nhung origin
  da bi "stampede" boi 12 requests. Neu concurrency la 12, chi la
  warning. Neu concurrency la 10,000 -> origin se sap.

NGUYEN NHAN CO THE:
  1. Object khong duoc cache (TTL = 0, uncacheable)
     -> Varnish khong cache -> khong coalesce
     -> Check: X-Cache cua batch requests? Neu MISS va follow-up
        cung MISS -> object khong duoc cache

  2. Object duoc cache nhung Varnish khong coalesce
     -> Co the do Varnish version cu hoac config
     -> Check: Varnish version, default.vcl

  3. Request khong di qua Varnish (di thang den backend)
     -> Check: Topology, port 80 co thuc su di qua Varnish?

  4. Cache key khong match (requests khac key)
     -> Check: URL, headers cua cac request co giong nhau khong?

DECISION:
  FAIL. CDN contract bi breach. Khong the dua production traffic
  spike cho CDN bao ve.

ACTION:
  1. Kiem tra VCL: object co duoc cache khong?
  2. Kiem tra Varnish version: coalescing co duoc support?
  3. Kiem tra topology: traffic co that su qua Varnish?
  4. Kiem tra request identity: tat ca requests cung key?
  5. Rerun sau khi fix
```

### Scenario D: Mot so requests timeout -- ORIGIN OVERLOAD

```text
OBSERVATION:
  - Batch requests: 8/12 tra 200, 4/12 timeout
  - Follow-up: Khong chay duoc (vi test fail truoc)
  - Origin count: 8 (cho 8 requests thanh cong) hoac khong doc duoc

DIAGNOSIS:
  Origin khong chiu duoc concurrency. origin_delay_ms = 800ms,
  nhung 12 requests van den origin (khong coalesce) -> origin
  bi qua tai -> 4 requests timeout.

  Hoac: coalescing co hoat dong (chi 1 request den origin), nhung
  origin_delay_ms = 800ms + k6 timeout < 800ms -> timeout.

NGUYEN NHAN CO THE:
  1. k6 timeout < origin_delay_ms (800ms)
     -> k6 mac dinh timeout la 60s -> khong phai van de
     -> Neu da giam timeout xuong < 800ms -> day la van de

  2. Coalescing KHONG hoat dong -> origin nhan 12 requests
     -> Giong Scenario C nhung origin yeu hon

  3. Origin mat thoi gian > timeout de xu ly ngay ca 1 request
     -> origin_delay_ms + actual process > 60s

DECISION:
  FAIL. He thong khong san sang cho traffic spike.

ACTION:
  1. Kiem tra k6 timeout config (http.request_timeout)
  2. Kiem tra origin_delay_ms co vuot timeout khong
  3. Debug Varnish coalescing nhu Scenario C
  4. Kiem tra origin capacity (co du resource khong?)
  5. Rerun voi origin_delay_ms thap hon
```

## 13. Nghich ly va misconceptions

### Nghich ly 1: "Coalescing = CDN cham hon"

```text
MISCONCEPTION:
  "Neu coalescing bat request phai cho, vay CDN lam cham hon.
   De request di thang den origin con nhanh hon."

FACT:
  Request dau tien: THOI GIAN NHU NHAU (phai doi origin fetch)
    - Co coalescing: 800ms (origin delay) + fetch
    - Khong coalescing: 800ms (origin delay) + fetch
    -> GIONG HET NHAU

  Request thu 2 tro di: COALESCE NHANH HON NHIEU
    - Co coalescing: 800ms (cho request #1 fetch xong, lay tu cache)
    - Khong coalescing: 800ms (origin delay) + fetch + QUERY DB
                         (nhung DB dang bi 10,000 queries dong thoi
                         -> thuc te co the 30s+)
    -> Coalescing: N requests cung ~800ms
    -> Khong coalescing: Request sau co the timeout

  KET LUAN:
    Coalescing khong lam request dau tien cham hon.
    Coalescing lam cac request SAU KHONG BI CHAM (va giai cuu origin).
```

### Nghich ly 2: "Can VCL config de bat coalescing"

```text
MISCONCEPTION:
  "Phai viet VCL code de bat tinh nang request coalescing."

FACT:
  Request coalescing la BUILT-IN feature cua Varnish. No tu dong
  hoat dong cho BAT KY object cacheable nao. Khong can mot dong
  VCL nao ca.

  Trong toan bo 303 dong cua default.vcl, KHONG CO MOT DONG NAO
  noi ve coalescing, collapsed forwarding, hay waiting list.

  Varnish lam moi thu tu dong:
    - Nhan biet nhieu requests cung key
    - Tao busy object
    - Park requests vao waiting list
    - Unpark khi object san sang
    - Serve tu cache

  Khong can config, khong can code, khong can flag. Mac dinh.
```

### Nghich ly 3: "Coalescing chi quan trong khi traffic cao"

```text
MISCONCEPTION:
  "Request coalescing chi can thiet khi co hang nghin requests
   dong thoi. Voi 2-3 requests, khong quan trong."

FACT:
  Ngay ca 2 concurrent cold requests cung duoc loi tu coalescing:
    - 2 requests thay vi 2 origin hits -> 1 origin hit
    - 50% reduction origin load

  Voi 3 requests: 67% reduction
  Voi 4 requests: 75% reduction
  ...

  Coalescing la MULTIPLIER:
    - 2 requests:   save 1 origin hit
    - 10 requests:  save 9 origin hits
    - 100 requests: save 99 origin hits
    - 10,000:       save 9,999 origin hits

  KHONG CO "minimum threshold". Coalescing luon co loi, o moi scale.
  CDN khong biet (va khong quan tam) co bao nhieu request -- no chi
  biet "cung object? dang fetch roi -> cho".
```

### Nghich ly 4: "Neu origin du nhanh, coalescing khong can thiet"

```text
MISCONCEPTION:
  "Neu origin du nhanh xu ly 10,000 concurrent requests, thi
   coalescing la khong can thiet. Origin tu handle duoc."

FACT:
  Khong co origin nao "du nhanh" de handle true thundering herd.

  Ly do:
    - Origin nhanh 10ms/request -> 10,000 requests = 100,000ms = 100s
      Neu xu ly tuan tu (single thread).
    - Origin co 100 threads -> 10,000 requests = 100 requests/thread
      -> 1,000ms = 1s. Nhung DB connection pool = 50 connections
      -> 10,000 DB queries -> queued -> timeout.
    - DB (du co read replica) van bi lock contention, CPU spike.

  Coalescing la CO CHE KIEN TRUC, khong phai "optimization".
  No loai bo su TRUNG LAP, khong phai "lam nhanh" origin.

  Giong nhu: Tai sao phai dung elevator khi co the di bo 20 tang?
  -> Vi elevator la co che, khong phai chi la "nhanh hon".
```

### Nghich ly 5: "Coalescing = rate limiting"

```text
MISCONCEPTION:
  "Request coalescing giong nhu rate limiting -- no giam traffic
   den origin."

FACT:
  Khong giong. Rate limiting LOAI BO request (tra 429 Too Many
  Requests). Coalescing KHONG LOAI BO -- no CHO VA SERVE.

  Rate limiting: 10,000 requests -> 1,000 accepted, 9,000 REJECTED
  Coalescing:    10,000 requests -> 1 origin hit, 10,000 SERVED

  User cua rate limiting: "Toi bi chan, khong xem duoc san pham."
  User cua coalescing: "Toi van xem duoc san pham, hoi cham mot chut."

  Coalescing la "wait and serve", rate limiting la "reject and
  forget". Khac biet quan trong.
```

## 14. Checklist

### Pre-run checklist

```text
TRUOC KHI CHAY CASE 10:

[ ] Topology: TargetLayer = full
    - Varnish running, Nginx running, App running
    - Port 80 -> Varnish, Port 8088 -> Control (Nginx -> App)

[ ] Environment variables:
    - BASE_URL = http://localhost:80
    - CONTROL_BASE_URL = http://localhost:8088
    - CATALOG_EVENTS_BASE_URL = http://localhost:9091
    - OPS_AUTH_TOKEN = <valid-token>

[ ] Origin healthy:
    - waitOriginHealthy() pass
    - Profiler healthy + CDN backend healthy

[ ] Control API accessible:
    - GET /ops/app/cdn/origin/request-counts -> 200
    - POST /ops/app/cdn/origin/request-counts/reset -> 200
    - POST /ops/app/cdn/cache/ban-url -> 200
    - POST /ops/app/cdn/origin/reset -> 200

[ ] Cache clean:
    - Ban URL can test (setup lam tu dong)
    - Xac nhan cache khong con object cu

[ ] No parallel runs:
    - Khong co test khac dang chay
    - Counter khong bi contaminate boi case khac

[ ] Knobs hop le:
    - COALESCE_CONCURRENCY >= 2 (can it nhat 2 requests de test coalescing)
    - COALESCE_ORIGIN_DELAY_MS > 0 (can delay de tao window)
    - COALESCE_TTL_SECONDS > 0 (can TTL de verify HIT)
```

### Post-run checklist

```text
SAU KHI CHAY CASE 10:

[ ] k6 exit code = 0

[ ] Tat ca checks pass (checks rate = 1.0)

[ ] Tat ca batch requests 200

[ ] Follow-up request HIT

[ ] Origin request count <= 2

[ ] Teardown completed:
    - Origin profile reset
    - Origin healthy
    - Origin request counts reset

[ ] Khong co side effect:
    - Cac case khac van pass neu chay sau
    - Cache khong bi contaminate
```

## 15. Variations

### Variation 1: More concurrent VUs (50+)

```text
MUC TIEU: Verify coalescing voi concurrency lon hon.

CONFIG:
  COALESCE_CONCURRENCY = 50
  COALESCE_ORIGIN_DELAY_MS = 800  (giu nguyen)
  COALESCE_TTL_SECONDS = 30

EXPECTED:
  - 50 requests -> origin count van <= 2
  - Neu van <= 2: coalescing scale tot
  - Neu tang len 3-5: Varnish co the co gioi han waiting list
    (thuc te, Varnish khong co gioi han cung)
  - Neu tang len >10: van de

Y NGHIA:
  - Verify coalescing khong bi gioi han boi concurrency
  - Mo phong traffic spike lon hon
  - Tim gioi han cua he thong (neu co)
```

### Variation 2: Longer origin_delay_ms (bigger coalescing window)

```text
MUC TIEU: Verify coalescing voi origin cham (high latency backend).

CONFIG:
  COALESCE_CONCURRENCY = 12
  COALESCE_ORIGIN_DELAY_MS = 3000  (3s delay -- mo phong origin cham)
  COALESCE_TTL_SECONDS = 30

EXPECTED:
  - Origin count van <= 2
  - Window 3s -> de dang coalesce 12 requests
  - Response time ~3s (tat ca phai doi)

CAUTION:
  - k6 timeout mac dinh 60s -> OK
  - Neu timeout giam xuong < 3000ms -> timeout fail
  - User experience: tat ca requests mat 3s (khong ly tuong
    nhung chap nhan duoc cho cold cache, sau do la <1ms HIT)

Y NGHIA:
  - Verify coalescing van hoat dong voi origin response time cao
  - Mo phong upstream service cham (third-party API, legacy system)
  - Origin "cham" la mot dang protection: cham -> window rong -> coalesce de
```

### Variation 3: Zero origin delay (fast origin)

```text
MUC TIEU: Verify coalescing voi origin rat nhanh (microservice sub-ms).

CONFIG:
  COALESCE_CONCURRENCY = 12
  COALESCE_ORIGIN_DELAY_MS = 0  (khong delay -- origin respond ngay)
  COALESCE_TTL_SECONDS = 30

EXPECTED:
  - Co the 2-3 requests den truoc khi object vao cache
  - Con lai la HIT (den sau khi cache hot)
  - Origin count = 1 hoac 2 (van tot)
  - KHONG CO coalescing stampede (vi origin nhanh -> fetch xong trong <1ms
    -> request sau thay HIT)

Y NGHIA:
  - Day la "easy mode" cho coalescing
  - Origin nhanh -> window nho -> it request can coalesce
  - Request sau da thay HIT -> khong can coalesce
  - Verify rang ngay ca origin rat nhanh, van khong bi stampede
```

### Variation 4: Different paths simultaneously

```text
MUC TIEU: Verify coalescing per-path (path isolation).

CONFIG:
  - Tao 3 path khac nhau:
    PATH_A = buildCachedPath('coalesce-a-xxx', { origin_delay_ms: 800 })
    PATH_B = buildCachedPath('coalesce-b-xxx', { origin_delay_ms: 800 })
    PATH_C = buildCachedPath('coalesce-c-xxx', { origin_delay_ms: 800 })

  - http.batch(36 requests): 12 cho A, 12 cho B, 12 cho C
  - Tat ca 3 path cung duoc goi trong mot batch

EXPECTED:
  - Moi path co origin count <= 2 (RIENG BIET)
  - Tong origin count <= 6 (3 paths x 2)
  - Coalescing per-path: request A chi coalesce voi A, khong anh huong B, C

Y NGHIA:
  - Verify coalescing khong bi "cross-contamination" giua cac path
  - Moi cache key la doc lap
  - Day la scenario gan voi thuc te: nhieu API khac nhau cung bi cold
```

### Variation 5: Smoke -- single VU

```text
MUC TIEU: Verify co ban rang case khong bi broken.

CONFIG:
  COALESCE_CONCURRENCY = 2  (toi thieu de test coalescing)
  COALESCE_ORIGIN_DELAY_MS = 200  (delay ngan)
  COALESCE_TTL_SECONDS = 10

EXPECTED:
  - 2 requests -> origin count = 1
  - Follow-up HIT

Y NGHIA:
  - Smoke test nhanh (< 2s)
  - Verify case infrastructure (control API, cache, origin) OK
  - Chay truoc khi chay full test
```

## 16. Anti-patterns

### Anti-pattern 1: Khong reset origin counters giua cac runs

```text
SAI:
  Chay case 10 lan 1 -> PASS (origin count = 1)
  Chay case 10 lan 2 -> PASS (origin count = 0? hoac van = 1?)

  Neu counter khong duoc reset:
    - Lan 2 se cong don voi counter tu lan 1
    - Hoac cache da hot tu lan 1 -> khong coalesce
    - Ket qua khong con y nghia

DUNG:
  - setup() LUON reset counters (resetOriginRequestCounts())
  - teardown() LUON reset counters
  - Neu debug thu cong: luon reset counter truoc khi chay

  Counter phai bat dau tu 0 cho moi lan test.
```

### Anti-pattern 2: Test voi chi 1 VU / 1 request

```text
SAI:
  COALESCE_CONCURRENCY = 1
  -> Chi 1 request -> khong can coalesce -> luon "pass"
  -> Day la testing theater, khong chung minh duoc gi

DUNG:
  COALESCE_CONCURRENCY >= 2
  -> Coalescing chi co y nghia khi co >1 request cung key
  -> Test voi it nhat 8-12 de bat dau co y nghia thong ke
  -> Test voi 50-100 de verify scale

  Coalescing mean "nhieu request collapse thanh 1". Neu chi
  co 1 request, khong co gi de collapse.
```

### Anti-pattern 3: Confusion voi HTTP/2 multiplexing

```text
SAI:
  "HTTP/2 multiplexing la request coalescing"
  "Neu dung HTTP/2, se tu dong coalesce"

FACT:
  HTTP/2 multiplexing: nhieu requests/response chia se mot TCP
  connection. Day la MULTIPLEXING (transport layer), khong phai
  COALESCING (application/cache layer).

  Multiplexing giup requests den nhanh hon qua cung connection
  -> thuc te co the LAM TANG kha nang stampede (vi requests den
  cung luc nhanh hon).

  Coalescing la: CDN nhan biet "cung object?" -> chi fetch 1 lan.
  Multiplexing la: "nhieu requests trong 1 TCP stream."
  Khac biet hoan toan.
```

### Anti-pattern 4: Expecting exact count of 1 always

```text
SAI:
  "Neu coalescing hoat dong, origin count LUON = 1."
  "Origin count = 2 nghia la coalescing bi broken."

FACT:
  Origin count = 1 la PERFECT. Origin count = 2 la ACCEPTABLE.
  Threshold <= 2 da bao gom truong hop "steals through" binh thuong
  cua Varnish lock window.

  Neu muon origin count always = 1:
    - Co the tang origin_delay_ms (window rong hon)
    - Co the dung Varnish params: thread_pools, thread_pool_max, v.v.
    - Nhung khong can thiet -- <= 2 da la tot

  Dung over-fit threshold. 1 hay 2 deu la coalescing thanh cong.
```

### Anti-pattern 5: Khong verify follow-up HIT

```text
SAI:
  Chi check batch requests 200 + origin count <= 2
  Khong check follow-up HIT

  Neu object khong duoc cache:
    - Request tiep theo van MISS -> origin van bi hit
    - Coalescing chi bao ve origin TRONG BATCH dau tien
    - Sau batch, origin van bi hit cho moi request -> offload = 0

DUNG:
  LUON verify follow-up HIT.
  Coalescing chi la buoc 1. Buoc 2 la cache object de request
  sau HIT. Ca hai buoc cung quan trong.

  Coalescing + caching = origin protection.
  Coalescing without caching = chi delay stampede, khong ngan chan.
```

### Anti-pattern 6: Chay cac cases song song

```text
SAI:
  Chay case 10 cung luc voi case 09 (stale) hoac case 11 (negative cache)
  -> Chung counter, chung cache -> ket qua bi contaminate
  -> Case 10 doc duoc origin count cua case 09

DUNG:
  - Chay TUAN TU tung case
  - Moi case co setup() rieng -> reset counter, ban URL rieng
  - Neu can chay parallel: phai dung path namespace rieng,
    counter namespace rieng, cache namespace rieng

  Case 10 co teardown() reset counter -> nhung neu case khac
  dang chay cung luc -> counter bi reset giua chung -> sai.
```

## 17. Real validation data

### Expected values from actual test runs

```text
CASE ID: cdn-10-request-coalescing
SCRIPT: 10-request-coalescing.js (82 lines)
LAST VALIDATED: 2026 (qua CI + manual run)

CAPABILITY: Request coalescing / collapsed forwarding

TEST PARAMETERS:
  - COALESCE_CONCURRENCY: 12
  - COALESCE_ORIGIN_DELAY_MS: 800ms
  - COALESCE_TTL_SECONDS: 30s
  - vus: 1, iterations: 1
  - http.batch: 12 requests dong thoi

EXPECTED OUTCOMES:
  - All 12 batch requests: 200 OK
  - Follow-up request: 200 OK + X-Cache: HIT
  - Origin request count: 1 (sometimes 2)
  - k6 checks rate: 100% (1.0)
  - k6 http_req_failed: 0% (0.0)
  - k6 exit code: 0

ACCEPTABLE OUTCOMES:
  - Origin request count: 2 (van PASS)
  - Origin request count: 1 (perfect)

UNACCEPTABLE OUTCOMES:
  - Origin request count >= 3 -> FAIL
  - Any batch request != 200 -> FAIL
  - Follow-up != HIT -> FAIL

CI THRESHOLD: checks: rate==1, http_req_failed: rate==0

DATA SOURCE:
  - Public path: http://localhost:80/api/cached?key=coalesce-<ts>...
    -> Varnish -> Nginx -> App (origin counter)
  - Control path: http://localhost:8088/ops/app/cdn/origin/request-counts
    -> Origin request counter API

CONTROL ENDPOINTS USED:
  - POST /ops/app/cdn/origin/reset
  - GET  /ops/app/cdn/origin/request-counts
  - POST /ops/app/cdn/origin/request-counts/reset
  - POST /ops/app/cdn/cache/ban-url
```

### Verification protocol

```text
DE VERIFY CASE 10 DANG HOAT DONG DUNG:

1. Chay case 10 mot minh (khong case khac dong thoi)

2. Verify k6 output:
   - Tat ca checks pass
   - Khong co error log

3. Verify origin counter manually (neu can):
   curl -H "Authorization: Bearer $OPS_AUTH_TOKEN" \
        http://localhost:8088/ops/app/cdn/origin/request-counts
   -> Tim request_key tuong ung -> count <= 2

4. Verify follow-up manually (neu can):
   curl -sI "http://localhost:80/api/cached?key=<test-key>..." \
        | grep X-Cache
   -> X-Cache: HIT

5. Chay lai 3 lan lien tiep:
   - Tat ca 3 lan deu pass
   - Khong co flaky behavior
```

## 18. Reference

### Related docs

```text
WITHIN CDN SERIES:
  - Overview:          ./00_overview.md
  - Run guide:         ./RUN_GUIDE.md
  - Case 09:           ./09_stale-while-error.md (origin protection khi unhealthy)
  - Case 11:           ./11_negative-caching.md (error offload tuong tu concept)
  - Validation report: ./12_validation-and-chart-analysis.md

OUTSIDE CDN SERIES:
  - Ramping arrival:   ../ramping-arrival-rate/01_daily-ingress-curve.md
                       (gold standard cho doc structure)
  - Executor packs:    ../ramping-vus/, ../constant-vus/, ../shared-iterations/

SOURCE CODE:
  - Script:            E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/10-request-coalescing.js
  - Shared helpers:    E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js
  - VCL config:        E:/Projects/k6/k6-metrics-server/load-target/varnish/default.vcl
  - Case catalog:      E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/case-catalog.json
  - Source README:     E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md
  - Layer roadmap:     E:/Projects/k6/k6-metrics-server/load-target/k6/layer-roadmap.md

EXTERNAL:
  - Varnish docs:      https://varnish-cache.org/docs/
  - Collapsed forwarding: Varnish built-in feature (no explicit doc section;
                       referenced in "Waiting list" and "busy object" internals)
  - Cache stampede:    https://en.wikipedia.org/wiki/Cache_stampede
  - Thundering herd:   https://en.wikipedia.org/wiki/Thundering_herd_problem
```

### Case card (summary)

```text
+=============================================================+
| CASE 10: REQUEST COALESCING                                  |
+=============================================================+
| Script:     10-request-coalescing.js (82 lines)             |
| Layer:      CDN / Varnish                                    |
| Proof:      Cold burst coalesces origin forwarding           |
+=============================================================+
|                                                              |
| CONTRACT:                                                    |
|   cold cache + N concurrent requests cung key                |
|   -> origin count <= 2                                       |
|   -> all requests 200                                        |
|   -> follow-up HIT                                           |
|                                                              |
| KEY SIGNALS:                                                 |
|   - Origin request count (THE PROOF)                         |
|   - Batch response statuses                                  |
|   - Follow-up X-Cache header                                 |
|                                                              |
| KEY INSIGHT:                                                 |
|   - 10,000 users mo app cung luc -> 1 origin request         |
|   - Request coalescing la BUILT-IN Varnish feature           |
|   - Khong can VCL config, khong can flag                     |
|   - origin_delay_ms mo phong origin cham -> window coalesce  |
|                                                              |
| PASS WHEN:                                                   |
|   - k6 exit 0                                                |
|   - All batch 200 + follow-up HIT                            |
|   - Origin count <= 2                                        |
|                                                              |
| FAIL WHEN:                                                   |
|   - Origin count >= 3 (stampede)                             |
|   - Any request != 200                                       |
|   - Follow-up != HIT                                         |
+=============================================================+
```
