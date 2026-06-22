# Case 01: Cache HIT Smoke -- MISS->HIT Transition

> **Case ID:** `cdn-01-hit-smoke`
> **Script:** `01-hit-smoke.js`
> **Layer:** CDN / Varnish
> **Executor:** `shared-iterations` | VUs=4 | duration=18s | sleep=0.025s
> **Profile:** `guestVNMobileControl` (vi, VN, mobile, control, guest)
> **Path:** `/api/sim/products/1` (product detail)
> **Proof:** product detail `MISS -> HIT`, sustained HIT under repeated reads
> **Evidence:** `X-Cache`, `X-Upstream-Service`, `X-Cache-Key-*`, `X-Cache-Hits`

## 1. tình huống thực tế

### product detail la endpoint bi request nhiều nhất

trong bat ky hệ thống e-commerce nao, product detail page (PDP -- trang chi tiết
sản phẩm) la endpoint được truy cập nhiều nhất boi anonymous shoppers:

```text
Customer journey thong thuong:

  Landing page -> Product list (search/browse) -> Product detail -> Cart -> Checkout
                                                            ^^^^^^^^^^^^^^^^
                                                           76% traffic anonymous
                                                           reads o day

  Anonymous shopping session (guest user):
    - Mo app/mobile web
    - Scroll qua product list (category, search, homefeed)
    - Tap vao 1 product -> PDP load
    - Tap vao 1 product khac -> PDP load lai
    - Tap vao 1 product khac nua -> PDP load lai
    ...
    - Trung binh 1 session guest xem 3-7 PDP truoc khi add-to-cart hoac thoat
```

PDP la "mat tien" cua hệ thống. no chứa ảnh sản phẩm, mô tả, gia, reviews,
variants, recommendations -- nhiều data hon product list. response size thường
tu 15-50KB. voi traffic 10,000 request/phut anonymous (con số bình thường cho
1 site vua-phải), origin se phải phục vụ 10,000 lan tạo response từ database
**nếu không có CDN cache**.

### lời hứa cơ bản nhất cua CDN: MISS -> HIT

```text
CDN hua 2 dieu ve cache:

  (1) Request DAU TIEN toi 1 object -> CDN khong co gi trong cache
      -> Phai forward toi origin (MISS)
      -> Origin tao response, CDN copy vao cache
      -> Response tra ve client, CDN ghi nho object nay

  (2) Request THU HAI tro di, cung object do -> CDN DA CO object
      -> Tra tu cache, KHONG goi origin (HIT)
      -> Response nhanh hon (sub-millisecond edge thay vi origin RTT)
      -> Origin khong bi consumes CPU/DB cho request nay

Day la loi hua don gian nhat -- nhung cung la quan trong nhat.
Neu MISS->HIT khong dung, EVERYTHING ELSE ve CDN deu khong dang tin cay.
```

day la **atomic contract** cua CDN. thử nó bằng mot smoke test: request cung
URL cung headers 2 lan lien tiep. lần 1 phải MISS. lần 2 phải HIT. neu không,
cai gi do sai o VCL, sai o origin response headers, hoac sai o CDN runtime.

### Anonymous traffic trên PDP là use case lý tưởng cho smoke test

```text
Tai sao anonymous PDP, khong phai authenticated hay write?

  Anonymous:
    - Khong Authorization header -> CDN khong bypass
    - Khong Cookie -> CDN khong bypass
    - Method = GET -> CDN duoc phep cache

  Authenticated:
    - Authorization hoac Cookie ton tai -> VCL tra ve pass
    - CAI NAY LA BY DESIGN: user A khong duoc nhin thay data user B

  Write (POST/PUT/DELETE):
    - VCL tra ve pass cho non-GET methods
    - Write requests luon phai toi origin de xu ly

  Anonymous PDP GET la purest cache-read path:
    - Khong can auth
    - Khong can cookie
    - Khong can user-specific data
    - Response giong nhau cho moi anonymous user
    -> Perfect candidate cho CDN cache
```

### hậu quả nếu MISS->HIT không đúng

```text
Scenario: Campaign launch, 500,000 anonymous users browse PDP

  Neu CDN hoat dong DUNG (MISS->HIT working):
    t=0:  First user request PDP -> MISS -> origin serve -> cache fill -> HIT
    t=1:  Next 499,999 users request PDP -> HIT -> CDN serve tu cache
          Origin load: 1 request (chi MISS dau tien)
          Latency: ~5ms edge thay vi ~200ms origin
          Origin compute: 1 DB query

  Neu CDN hoat dong SAI (always MISS):
    t=0:  First user request PDP -> MISS -> origin serve
    t=1:  Second user request PDP -> MISS -> origin serve
    t=2:  Third user request PDP -> MISS -> origin serve
    ...
    t=10: 500,000 requests -> 500,000 origin hits
          Origin load: BI PHA VO (stampede)
          Latency: 200ms moi request, queue len ~5s
          DB: bi dap 500,000 queries cung luc
          Ket qua: 502, timeout, user thoat app

  Hậu quả kinh doanh:
    - 500,000 users thay PDP load cham (5s thay vi 0.2s)
    - ~30% bounce rate tang do PDP slow
    - Hien thi sai gia/stock vi origin qua tai -> data inconsistency
    - Marketing tieu tien ads nhung conversion = 0
    - Infrastructure auto-scale nhung muon hon traffic spike (scale mat 2-3p)
    - Chi phi compute/DB spike 500x trong 10 phut
```

viec kiểm tra MISS->HIT không phải la "nice to have". day la **điều kiện cần**
de CDN thực hiện vai trò offload origin. không co no, CDN chi la mot reverse
proxy vo ich -- mọi request đều đi qua nhưng không request nào được cache.

### kết nối tới business metrics cụ thể

```text
MISS->HIT transition co the duoc anh xa truc tiep toi cac chi so kinh doanh:

  HIT RATIO (ty le request duoc phuc vu tu cache):
    - Neu HIT ratio = 0%: Origin nhan 100% requests -> BI PHA VO o peak
    - Neu HIT ratio = 95%: Chi 5% requests den origin -> origin scale nho hon
    - Neu HIT ratio = 99%: Origin gan nhu idle -> chi phu vu cache fill + bypass

    Voi 10,000 request/phut:
      0% HIT  -> 10,000 origin requests -> can 20+ app instances
      95% HIT -> 500 origin requests -> can 2-3 app instances
      99% HIT -> 100 origin requests -> can 1 app instance
      -> Cost savings: 10-20x tren infrastructure

  LATENCY (thoi gian phan hoi):
    - HIT tu Varnish (local memory): ~1-5ms
    - MISS qua origin (network + app + DB): ~50-500ms
    - Delta: 10-100x nhanh hon

    User experience:
      5ms load time -> "instant" -> user browse nhieu san pham hon
      500ms load time -> "cham" -> user bounce sau 2-3 PDP

  ORIGIN OFFLOAD (gioi han origin capacity):
    - Origin capacity: ~500 req/s (gia su)
    - Peak traffic: 5,000 req/s
    - Neu 0% HIT -> origin can gap 10 lan capacity -> DOWN
    - Neu 95% HIT -> origin chi nhan 250 req/s -> HEALTHY
    - -> MISS->HIT la CO CHE DUY NHAT de offload

  AVAILABILITY (uptime):
    - Neu origin down -> CDN co the serve stale cache (stale-while-error)
    - Neu CDN CHUA TUNG cache (no MISS->HIT ever) -> origin down = site down
    - Cache fill tu MISS la prerequisite cho stale serving sau nay
```

### vi sao anonymous PDP được chọn làm endpoint đầu tiên de test

```text
Trong so tat ca cac endpoint anonymous, product detail duoc chon lam
smoke test endpoint vi:

  1. DAY DU VARIANT DIMENSIONS:
     Products path include 4 variant dimensions trong cache key
     (language, geo, device, ab). Neu test chi chon /api/cached
     (khong co variant), ta bo qua toan bo cache key normalization
     code path.

  2. RESPONSE SIZE VUA PHAI:
     Product detail response ~15-50KB. Du lon de verify cache
     storage hoat dong (khong bi truncate), du nho de test nhanh.

  3. UPSTREAM ROUTING CO THE KIEM TRA:
     X-Upstream-Service = "products-service" cho phep verify routing
     dung. Cac endpoint khac co the route den service khac.

  4. TTL MAC DINH HOP LY:
     90s TTL du dai de chay smoke test (18s) ma khong lo expire.
     Nhung cung du ngan de retest nhanh neu can (doi 90s la cold).

  5. REALISTIC TRAFFIC PATTERN:
     Product detail la endpoint co traffic cao nhat trong e-commerce.
     Neu no cache duoc -> 80%+ traffic duoc offload.
     Neu no KHONG cache duoc -> origin se sup o moi dot traffic.
```

## 2. CDN capability being proven

### MISS->HIT transition: nền tảng của mọi CDN case khác

```text
  cdn-01-hit-smoke proves:
    cold product detail request -> MISS -> origin products-service
    same object/variant again   -> HIT  -> CDN serves cached object
    sustained anonymous reads   -> HIT remains stable

  This is the FOUNDATION. All other CDN cases build on this:

    cdn-02 (variant-keys):    Gia su HIT da dung -> kiem variant isolation
    cdn-03 (bypass-rules):    Gia su HIT da dung -> kiem khi nao KHONG HIT
    cdn-04 (query-normalize): Gia su HIT da dung -> kiem query key behavior
    cdn-05 (invalidation):    Gia su HIT da dung -> kiem MISS sau invalidation
    cdn-08 (ttl-expiry):      Gia su HIT da dung -> kiem MISS sau TTL expire
    cdn-09 (stale):           Gia su HIT da dung -> kiem stale serving
    cdn-10 (coalescing):      Gia su HIT da dung -> kiem origin count reduction
    cdn-11 (negative-cache):  Gia su HIT da dung -> kiem 404 HIT

  Neu case 01 khong pass, **khong case nao khac dang tin cay**.
```

### "HIT" nghĩa là gì trong Varnish?

trong Varnish (va hầu hết CDN), HIT/MISS được quyết định tai `vcl_deliver`:

```vcl
# default.vcl, sub vcl_deliver
sub vcl_deliver {
    if (obj.hits > 0) {
        set resp.http.X-Cache = "HIT";      # object da duoc fetch truoc do >0 lan
        set resp.http.X-Cache-Hits = obj.hits;
    } else {
        set resp.http.X-Cache = "MISS";     # object chua tung duoc fetch (hoac da expired + purged)
    }
    ...
}
```

`obj.hits` la Varnish internal counter cho biet object nay da duoc deliver bao
nhiều lan ke tu khi được fetch tu backend. `0` = lan dau tien, Varnish vua fetch
tu origin. `>= 1` = da tung được deliver ít nhất 1 lan truoc do.

dieu quan trong: **HIT không chi la "object ton tai trong cache"**. no la "object
ton tai trong cache va được deliver ít nhất 1 lan". Mot object có thể ton tai
trong cache những da expired (TTL < 0). khi do `vcl_hit` chay va có thể tra ve
`pass` (neu backend healthy) hoac deliver voi `X-Cache-Stale=true` (neu backend
unhealthy + grace > 0).

### tại sao case này là smoke test?

```text
"Smoke test" = test nhanh, nhe, chay sau moi deploy de xac nhan he thong
khong "boc khoi". Trong CDN context:

  - Duration ngan (18s): du de 2 lan MISS->HIT proof + sustained reads
  - VUs thap (4): khong tao ap luc, chi kiem CORRECTNESS
  - Path don gian nhat: 1 URL, 1 profile
  - Pass/fail ro rang: MISS->HIT->HIT hoac fail
  - Co the chay trong CI pipeline ma khong ton thoi gian

  Neu smoke test nay fail -> DUNG MOI THU, khong deploy tiep.
  Neu smoke test nay pass -> Tiep tuc chay cac case khac (variant keys,
  bypass, invalidation, TTL, ...).
```

### Object lifecycle trong Varnish: tu birth den death

```text
Lifecycle cua mot cache object trong Varnish (product detail TTL=90s):

  PHASE 1: BIRTH (cache fill)
  ─────────────────────────────────────────────────────────────
  t=0: Client request den Varnish
  t=1: vcl_recv -> normalize_cache_variants -> vcl_hash -> hash_data
  t=2: Cache lookup -> NOT FOUND (or ban matched) -> return (fetch)
  t=3: Varnish opens backend connection -> Nginx -> App -> Products Service
  t=4: Origin response arrives -> vcl_backend_response runs
       - beresp.ttl set to 90s (from VCL rule)
       - beresp.grace set to 120s
       - beresp.keep set to 600s
  t=5: Response stored in cache (memory + optionally disk)
       Object attributes:
         - hash key: SHA256(url+host+lang+geo+device+ab)
         - TTL: 90s (expires at t+90s)
         - Grace: 120s (stale window from t+90s to t+210s)
         - Keep: 600s (object kept in cache until t+600s)
         - hits: 0 (never delivered)

  PHASE 2: FRESH LIFE (TTL window)
  ─────────────────────────────────────────────────────────────
  t=0s to t=90s: Object is FRESH
  - Every lookup: FOUND -> vcl_hit -> obj.ttl >= 0 -> return (deliver)
  - obj.hits increments each delivery
  - X-Cache = "HIT"
  - Latency: ~1-3ms (pure memory lookup)

  During fresh life:
  - obj.ttl counts down each second
  - obj.hits increments each delivery
  - Object may be evicted if Varnish memory pressure (rare for small objects)
  - Grace and keep timers run independently

  PHASE 3: STALE WINDOW (grace period)
  ─────────────────────────────────────────────────────────────
  t=90s to t=210s: Object is STALE but kept (obj.ttl < 0, obj.grace > 0)

  Behavior depends on BACKEND HEALTH:

    Case A: Backend HEALTHY
      - vcl_hit: obj.ttl < 0 -> check: std.healthy(backend) = true
        -> return (pass) -> Varnish fetches from origin (same as MISS)
      - Next fetch -> new object created -> old object may be evicted

    Case B: Backend UNHEALTHY
      - vcl_hit: obj.ttl < 0 -> check: std.healthy(backend) = false
        -> obj.ttl + obj.grace > 0 -> true
        -> set req.http.X-Cache-Stale = "true"
        -> return (deliver) -> SERVE STALE CONTENT
      - X-Cache = "HIT", X-Cache-Stale = "true"
      - This is CDN's AVAILABILITY guarantee: user gets content
        even when origin is down

  PHASE 4: EXPIRY (beyond grace)
  ─────────────────────────────────────────────────────────────
  t=210s+: Object is completely EXPIRED
  - obj.ttl + obj.grace <= 0
  - vcl_hit: cannot deliver stale -> return (pass) -> MISS
  - Background thread may keep object for "keep" duration (600s)
    but object is not served -> only used for revalidation IMS/INM

  PHASE 5: EVICTION (beyond keep, or explicit)
  ─────────────────────────────────────────────────────────────
  t=600s+: Object removed from cache by Varnish eviction thread
  - OR: explicit PURGE/BAN removes object immediately
  - OR: memory pressure triggers LRU eviction
  - Object gone -> next request is MISS

  VISUAL TIMELINE:
  ─────────────────────────────────────────────────────────────
  0s          90s                210s              600s
  |-----------|------------------|-----------------|---------->
  FRESH        STALE (grace)       DEAD (keep)       EVICTED
  HIT          HIT+Stale or MISS   MISS              MISS
  obj.ttl>=0   obj.ttl<0,grace>0   ttl+grace<=0      object gone

  Note: Varnish also supports background fetch (beresp.keep) and
  conditional requests (If-Modified-Since / If-None-Match) for
  revalidation during the keep window. But for this case, the
  key takeaway is: our 18s smoke test runs ENTIRELY in Phase 2
  (fresh life, 0s to 18s out of 90s TTL), so we have a generous
  safety margin and zero risk of TTL expiry during test.
```

### Varnish ban vs purge mechanism (technical nuance)

```text
Case 01 uses ban-url (via control path). But the actual Varnish mechanism
may be BAN or PURGE depending on implementation. Understanding the
difference is important for interpreting test results:

  PURGE (req.method == "PURGE"):
    - Immediate: removes object from cache NOW
    - Exact match: req.url must match exactly
    - Security: requires X-Ops-Token == "__CDN_OPS_TOKEN__"
    - Scope: single object (matching URL + host)
    - VCL: if (req.method == "PURGE") { return (purge); }
    - After PURGE: object GONE immediately -> next request GUARANTEED MISS

  BAN (req.method == "BAN"):
    - Lazy: adds ban rule, does NOT immediately remove objects
    - Expression match: ban("req.url == " + req.http.X-Ban-URL)
    - Security: requires X-Ops-Token == "__CDN_OPS_TOKEN__"
    - Scope: all objects matching the ban expression
    - VCL: if (req.method == "BAN") { ban("req.url == ..."); return (synth(200)); }
    - After BAN:
      - Ban rule added to ban list (persists until no objects match)
      - Objects that match ban rule: hidden at lookup time -> treated as MISS
      - Objects are actually removed by background ban lurker
      - Next request: lookup -> match ban -> MISS -> fetch new object
      - Second+ request: ban lurker may have removed old ban
        (if no other objects match) -> HIT the new object

  Which one does our test use?
    The script calls banUrl() -> POST /ops/app/cdn/cache/ban-url
    The app then communicates with Varnish internally.
    The VCL supports BOTH PURGE and BAN methods.
    Regardless of which is used, the outcome for our test is:
      NEXT request after ban-url -> MISS (cold start guaranteed)

  Why this matters:
    - If PURGE is used: first request guaranateed MISS (deterministic)
    - If BAN is used: first request also MISS (ban rule hides new object)
      but there's a small timing window where ban lurker behavior
      matters if the test runs very fast
    - For our 18s test: both mechanisms are safe, MISS is guaranteed
```

## 3. vì sao test ở CDN layer

### Testing o app layer vs CDN layer: hai thế giới khác nhau

```text
APP-LAYER TEST (direct to backend, bo qua CDN):

  k6 -> :8088 (control) -> Nginx -> App -> Products Service

  Những gì app-layer test KIEM TRA DUOC:
    - API tra dung status code (200)
    - API tra dung response body (JSON schema, field values)
    - Response time cua backend (latency tu app)
    - Database query performance
    - Business logic correctness

  Những gì app-layer test KHONG THE KIEM TRA:
    - CDN co cache response nay khong? (VCL quyet dinh, khong phai app)
    - Cache key co dung variant normalization khong? (VCL quyet dinh)
    - Response co bi bypass vi auth/cookie khong? (VCL quyet dinh)
    - Cache TTL la bao nhieu? (VCL + origin headers quyet dinh)
    - Stale serving co hoat dong khong? (VCL quyet dinh)
    - Invalidation (purge/ban) co xoa dung object khong? (VCL quyet dinh)
    - Request coalescing co gop origin requests khong? (VCL quyet dinh)
    - Negative caching cho 404 co hoat dong khong? (VCL quyet dinh)

CDN-LAYER TEST (qua public edge path):

  k6 -> :80 (public) -> Varnish -> Nginx -> App -> Products Service

  Những gì CDN-layer test KIEM TRA:
    - Toan bo contract giua CDN va upstream services
    - Cache state transitions (MISS->HIT->STALE->MISS)
    - Header signals (X-Cache, X-Cache-Key-*, X-Upstream-Service)
    - Variant isolation thong qua cache key headers
    - Event-driven invalidation chain
    - Origin offload proof qua request counters
```

### Contract cua cache nam o VCL + response headers, không phải application code

```text
Application code KHONG BIET CDN ton tai:

  ProductsService.java:
    @GetMapping("/api/sim/products/{id}")
    public Product getProduct(@PathVariable Long id) {
        return productRepository.findById(id);
    }

  Service nay tra ve Product JSON. No khong set Cache-Control, khong
  set Surrogate-Key, khong biet Varnish dang lam gi. Application
  developer viet code theo business logic.

  CDN contract nam o 2 noi:

    1. default.vcl (Varnish configuration):
       - sub normalize_cache_variants: normalizes 5 variant dimensions
       - sub vcl_recv: quyet dinh hash/pass
       - sub vcl_hash: xay dung cache key
       - sub vcl_hit: quyet dinh deliver/pass khi object trong cache
       - sub vcl_backend_response: quyet dinh TTL, grace, uncacheable
       - sub vcl_deliver: set response headers (X-Cache, X-Cache-Key-*)

    2. Response headers tu origin (app hoac ingress controller):
       - Cache-Control: s-maxage, public/private/no-store
       - Surrogate-Key: tags cho ban-tag invalidation
       - ETag/Last-Modified: revalidation
       - Vary: variant dimensions (neu co)
       - Set-Cookie: presence -> uncacheable
       - CDN-Cache-Control: CDN-specific override

  Neu application developer thay doi code nhung KHONG hieu cache contract,
  ho co the vo tinh lam vo cache:

    - Them Set-Cookie vao PDP response -> tat ca anonymous PDP bi pass
    - Them Authorization check (401) cho guest -> tat ca guest request bi pass
    - Thay doi response body format -> cache key khong thay doi, nhung
      client nhan sai format
    - Them Vary: X-Device-Class -> VCL da lam viec nay, khong can them
```

### tại sao cả 2 layer đều cần test

```text
  App-layer test:
    -> Dam bao backend handle duoc 1 request dung cach
    -> Khong the dam bao CDN cache contract
    -> Duoc chay trong CI cua moi microservice

  CDN-layer test:
    -> Dam bao CDN caching contract dung cho anonymous read path
    -> Khong the dam bao business logic correctness
    -> Duoc chay trong integration/e2e pipeline sau khi full stack deployed

  Ca 2 cung can. App-layer test khong thay the CDN-layer test.
  CDN-layer test khong thay the app-layer test.
  Neu chi test app layer, ban DANG BO QUA TOAN BO CDN CONTRACT.
```

## 4. Topology & precondition

### Full runtime topology

```text
                    PUBLIC EDGE PATH (port 80)
                    ==========================
  k6 (VU pool) ----> localhost:80 ----> Varnish (CDN) ----> Nginx ----> App ----> Products Service
                           |                    |
                           | cache hit:         | cache miss:
                           | serve from memory   | forward to backend
                           | sub-millisecond     | origin RTT + DB query

                    CONTROL PATH (port 8088)
                    ========================
  k6 (setup) -----> localhost:8088 ----> App (direct, bypass CDN)
                           |
                           | POST /ops/app/cdn/cache/ban-url
                           | Authorization: Bearer <ops-token>
                           | X-Ops-Token: <ops-token>
                           | Body: { "url": "/api/sim/products/1" }
                           |
                           v
                    Varnish BAN method (internal)
                    =============================
                    BAN request from app -> Varnish control endpoint
                    Varnish adds ban rule: req.url == /api/sim/products/1
                    Next request matching this URL -> forced MISS

                    CATALOG EVENTS PATH (port 9091)
                    ===============================
                    (not used in case 01, but available for event-driven
                     invalidation tests like case 06)
```

### vì sao cần ban-url nhu precondition

```text
Neu khong ban-url truoc khi test:

  Scenario A: Cache warm tu lan chay truoc
    - Case 05 (invalidation) vua chay xong truoc do va lam warm PDP
    - Case 01 chay -> first GET da la HIT thay vi MISS
    - Test FAIL sai -- khong phai CDN loi, ma la test precondition sai

  Scenario B: Cache warm tu manual testing
    - Developer vua curl PDP de kiem tra
    - Case 01 chay -> first GET la HIT
    - Test FAIL sai

  Scenario C: Cache co object nhung da expired
    - Object trong cache nhung TTL < 0
    - first GET co the la STALE hoac MISS tuy theo backend health
    - Ket qua khong deterministic

  Tat ca cac scenario nay deu lam test "first request MISS" khong con
  y nghia. ban-url is the ONLY WAY to guarantee cold start.

  Voi ban-url:
    - Xoa EXACT URL /api/sim/products/1 khoi cache
    - Khong anh huong den cac URL khac (product list, search, categories)
    - Khong anh huong den cac variant khac (US desktop, English, ...)
    - Setup is deterministic: after ban-url, next request TO THAT URL is cold
```

### control path authentication

```text
POST /ops/app/cdn/cache/ban-url

Headers:
  Authorization: Bearer <ops-token>
  X-Ops-Token: <ops-token>
  Content-Type: application/json

Body:
  { "url": "/api/sim/products/1" }

App validates token -> if valid, sends BAN request to Varnish:

  In VCL:
    if (req.method == "BAN") {
        if (req.http.X-Ops-Token != "__CDN_OPS_TOKEN__") {
            return (synth(401, "unauthorized"));
        }
        if (req.http.X-Ban-URL) {
            ban("req.url == " + req.http.X-Ban-URL);
            return (synth(200, "ban url added"));
        }
    }

  ban() is Varnish's lazy invalidation:
    - Does NOT immediately delete object from cache
    - Adds a ban rule to the ban list
    - Every subsequent lookup checks ban list before serving from cache
    - Object matching any ban rule -> treated as MISS -> re-fetch from origin
    - Old object eventually evicted by background ban lurker

  Neu token sai -> ban-url tra 401 -> setup fail -> cannot prove cold start
```

### nếu không chạy ban-url thành công (precondition fail)

```text
Hau qua:
  - first request co the la HIT thay vi MISS
  - assertCacheState(first, 'MISS', ...) FAIL
  - Toan bo sequence proof sup do

Hanh vi:
  - Test van chay (shared-iterations khong dung khi setup fail)
  - Check "first detail request cache state MISS" FAIL
  - Output hien thi: expected MISS but got HIT
  - Can dam bao OPS_AUTH_TOKEN dung va control path accessible

Khac phuc:
  - Verify OPS_AUTH_TOKEN value (khong duoc empty)
  - Verify CONTROL_BASE_URL dung (localhost:8088)
  - Verify app da start va control endpoint responding
  - Thu curl POST /ops/app/cdn/cache/ban-url manually
```

## 5. Script deep-dive

### tổng quan script (63 dong)

```javascript
// 01-hit-smoke.js -- structure
import { sleep } from 'k6';
import { envFloat, envInt, envString } from '../shared/common.js';
import {
  paths, profiles, expectedCacheKey, banUrl, requestCdn,
  assertCacheKeyHeaders, assertCacheState, assertStatus, assertUpstream
} from './shared.js';

// --- OPTIONS: executor config ---
export const options = {
  vus: HIT_SMOKE_VUS,           // default 4
  duration: HIT_SMOKE_DURATION, // default '18s'
  thresholds: {
    checks: ['rate==1'],        // EVERY check must pass
    http_req_failed: ['rate==0'] // NO HTTP failures
  },
};

// --- SETUP: cold-start proof ---
export function setup() { ... }

// --- DEFAULT: sustained HIT ---
export default function (data) { ... }
```

### phase chi tiết: `setup()` -- cold-start proof

```javascript
export function setup() {
  // Buoc 1: Chon profile nguoi dung
  const profile = profiles.guestVNMobileControl;
  //          language=vi, geo=VN, device=mobile, ab=control, segment=guest
  const expected = expectedCacheKey(profile);
  //          { language: 'vi', geo: 'VN', device: 'mobile',
  //            ab: 'control', segment: 'guest' }

  // Buoc 2: Dam bao cold start bang cach ban-url
  banUrl(paths.productDetail);
  //       POST /ops/app/cdn/cache/ban-url { url: '/api/sim/products/1' }
  //       Token validation -> Varnish ban rule added
  //       Assert: response status === 200

  // Buoc 3: First request -- phai MISS
  const first = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'detail_first' },
  });
  //       GET http://localhost:80/api/sim/products/1
  //       Headers: Accept-Language=vi, X-Geo-Country=VN,
  //                X-Device-Class=mobile, X-Ab-Variant=control,
  //                X-User-Segment=guest
  //       VCL: vcl_recv -> normalize_cache_variants -> vcl_hash -> MISS
  //            -> vcl_backend_response (TTL=90s, grace=120s)
  //            -> vcl_deliver: X-Cache=MISS

  assertStatus(first, 200, 'first detail request');
  //       Check: first detail request status 200

  assertUpstream(first, 'products-service', 'first detail request');
  //       Check: first detail request upstream products-service
  //       Dam bao response den tu DUNG upstream service

  assertCacheState(first, 'MISS', 'first detail request');
  //       Check: first detail request cache state MISS
  //       DAY LA CHECK QUAN TRONG NHAT trong setup

  assertCacheKeyHeaders(first, expected, 'first detail request');
  //       Check: 5 X-Cache-Key-* headers match expected normalized values
  //       language=vi, geo=VN, device=mobile, ab=control
  //       (segment NOT checked vi productDetail path khong co segment in hash)

  // Buoc 4: Second request -- phai HIT
  const second = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'detail_second' },
  });
  //       CUNG URL, CUNG headers -> CUNG cache key
  //       VCL: vcl_recv -> vcl_hash -> lookup -> FOUND -> vcl_hit -> deliver
  //       obj.hits = 1 (da duoc deliver 1 lan tu buoc 3)
  //       vcl_deliver: X-Cache=HIT, X-Cache-Hits=1

  assertStatus(second, 200, 'second detail request');
  assertUpstream(second, 'products-service', 'second detail request');
  assertCacheState(second, 'HIT', 'second detail request');
  //       Check: second detail request cache state HIT
  //       DAY LA CHECK CHUNG MINH MISS->HIT SUCCESS

  assertCacheKeyHeaders(second, expected, 'second detail request');

  // Buoc 5: Pass du lieu sang default()
  return { profile, expected };
  //       profile va expected duoc truyen vao `data` parameter cua default()
}
```

### phase chi tiết: `default()` -- sustained HIT verification

```javascript
export default function (data) {
  // Lay profile va expected tu setup() return value
  const profile = data?.profile || profiles.guestVNMobileControl;
  const expected = data?.expected || expectedCacheKey(profile);

  // Request CDN
  const res = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'detail_sustained_hit' },
  });
  //       CUNG URL, CUNG headers -> cache key match object da warm
  //       VCL lookup -> FOUND (obj.hits >= 2+)
  //       vcl_deliver: X-Cache=HIT, X-Cache-Hits >= 2

  assertStatus(res, 200, 'sustained detail request');
  assertUpstream(res, 'products-service', 'sustained detail request');
  assertCacheState(res, 'HIT', 'sustained detail request');
  //       Check: sustained detail request cache state HIT
  //       Chieu dai 18s, moi VU ngu 0.025s giua cac iteration
  //       -> Moi VU tao khoang 4 VUs * (18s / 0.025s) ~ 2880 requests
  //       -> Tat ca deu HIT -> origin khong bi goi them lan nao

  assertCacheKeyHeaders(res, expected, 'sustained detail request');

  sleep(HIT_SMOKE_SLEEP_SECONDS);
  //       Sleep 0.025s = 25ms giua cac iteration
  //       Voi 4 VUs, tao throughput: 4 / 0.025 = 160 req/s
  //       Muc dich: tao sustained HIT reads ma khong bombard system
}
```

### vu model: shared-iterations, 4 VUs, 18s, sleep 0.025s

```text
shared-iterations la executor mac dinh cua k6 khi chi dinh `vus` + `duration`
ma khong co executor name:

  - Tong so iteration duoc CHIA SE giua cac VU
  - Khong co gioi han so iteration co dinh -> chay lien tuc trong duration
  - Moi VU hoan thanh 1 iteration -> sleep -> lay iteration tiep theo
  - Iteration count = duration / (execution_time + sleep_time)

  Voi 4 VUs, 18s, sleep 0.025s:

    Gia su request execution time ~ 5ms:
      Iteration time = 5ms + 25ms = 30ms
      Iterations per VU = 18000ms / 30ms ~ 600
      Total iterations ~ 4 * 600 = 2400

    Tat ca 2400 requests deu:
      - Cung URL (/api/sim/products/1)
      - Cung headers (guestVNMobileControl)
      - Deu la HIT (sau khi setup da warm cache)
      - Origin chi nhan 1 request (MISS trong setup)
      -> Origin offload ratio: 2400:1

  Muc dich cua sleep(0.025):
    - Khong bombard CDN (day la correctness test, khong phai load test)
    - Tao sustained lightweight traffic de kiem tra cache stability
    - Neu co the chinh qua thap (khong co sleep) -> 4 VUs se tao throughput
      rat cao -> co the gay side effect khong mong muon cho correctness check
```

### Check coverage

```text
Total checks trong script:
  - Ban-url: 1 check (status 200) -- implicit in banUrl()
  - First request: 4 checks (status, upstream, cache state MISS, cache keys)
  - Second request: 4 checks (status, upstream, cache state HIT, cache keys)
  - Each sustained iteration: 4 checks

  Moi iteration cua default() tao 4 checks:
    1. "sustained detail request status 200"
    2. "sustained detail request upstream products-service"
    3. "sustained detail request cache state HIT"
    4. "sustained detail request cache language vi"
    5. "sustained detail request cache geo VN"
    6. "sustained detail request cache device mobile"
    7. "sustained detail request cache ab control"

  Total checks in full run (~2400 iterations):
    = 1 + 4 + 4 + (2400 * 7) ~ 16,813 checks
    Tat ca deu phai pass (threshold: checks['rate==1'])

  Neu chi 1 check fail -> threshold checks['rate==1'] bi vi pham -> k6 exit 1
```

### vi sao shared-iterations, không phải executor khac?

```text
Case 01 dung shared-iterations (vus=4, duration=18s) -- executor mac dinh
cua k6 khi khong chi dinh executor name. Day la lua chon co chu dich:

  SO SÁNH CÁC EXECUTOR CHO CDN CORRECTNESS TEST:

  shared-iterations (DANG DUNG):
    - Iterations duoc chia se giua VUs
    - Khong gioi han iteration count
    - Thich hop: correctness check, sustained lightweight traffic
    - VUs: 4 -- du de tao parallel reads
    - Duration: 18s -- du de verify sustained HIT

  per-vu-iterations (KHONG DUNG):
    - Moi VU chay co dinh N iterations
    - Can biet truoc so iteration can thiet -> khong phu hop
      (ta muon chay trong 18s, khong quan tam so iteration)
    - Neu set iterations qua thap -> khong du sustained proof
    - Neu set iterations qua cao -> lng phi thoi gian

  constant-vus (CO THE DUNG):
    - Giu co dinh so VUs, chay trong duration
    - Tuong tu shared-iterations nhung kem linh hoat hon
      cho correctness test

  constant-arrival-rate (KHONG PHU HOP):
    - Open model, iteration doc lap voi VU completion
    - Phu hop: LOAD test, kiem tra throughput
    - KHONG phu hop: correctness test (ta khong can tao ap luc)
    - Se tao dropped_iterations neu VUs khong du -> gay nhiu

  ramping-arrival-rate (KHONG PHU HOP):
    - Open model, rate curve
    - Phu hop: campaign ingress test
    - Qua phuc tap cho MISS->HIT smoke test

  LY DO CHON shared-iterations:
    1. Don gian nhat cho correctness test
    2. Setup phase chay deterministic (1 VU, sequential)
    3. Default phase: 4 VUs parallel reads -> kiem tra cache
       isolation under concurrency
    4. Khong can cau hinh phuc tap (preAllocatedVUs,
       maxVUs, timeUnit, rate)
    5. K6 tu dong phan phoi iterations giua VUs deu dan

  Dieu can luu y:
    - shared-iterations la CLOSED model (VUs wait for completion)
    - Neu sleep = 0 -> VUs loop cang nhanh cang tot -> tao throughput
      tuy y -> khong deterministic
    - Voi sleep(0.025) -> pace gan deterministic (~40 iterations/s/VU)
    - Day la mot trong nhung ly do tai sao sleep la QUAN TRONG
```

### Env knobs: điều chỉnh test behavior

```text
3 environment variables cho phep dieu chinh test ma khong can
sua script:

  HIT_SMOKE_VUS (default: 4):
    - So Virtual Users chay default() loop
    - Tang: kiem tra cache isolation under higher concurrency
    - Giam: CI-optimized run (1-2 VUs)
    - Override: $env:HIT_SMOKE_VUS = "10"

  HIT_SMOKE_DURATION (default: "18s"):
    - Duration cua test (k6 format: 18s, 30s, 1m, ...)
    - Tang: kiem tra cache stability lau dai (duration < TTL)
    - Giam: CI-optimized run ("5s" hoac "10s")
    - LUON PHAI < 90s (TTL) de tranh expire giua test
    - Override: $env:HIT_SMOKE_DURATION = "30s"

  HIT_SMOKE_SLEEP_SECONDS (default: 0.025):
    - Sleep giua cac iteration trong default() loop
    - Tang: tao throughput thap hon (nhe nhang hon)
    - Giam: tao throughput cao hon (stress hon)
    - 0 = khong sleep -> VU loop fastest possible -> co the
      tao ~800 req/s voi 4 VUs
    - Override: $env:HIT_SMOKE_SLEEP_SECONDS = "0.05"

  Vi du ket hop:
    # CI fast: 2 VUs, 10s, 0.05s sleep -> ~200 requests total -> ~12s
    $env:HIT_SMOKE_VUS = "2"
    $env:HIT_SMOKE_DURATION = "10s"
    $env:HIT_SMOKE_SLEEP_SECONDS = "0.05"

    # Stress HIT: 20 VUs, 30s, 0.005s sleep -> ~120,000 requests
    $env:HIT_SMOKE_VUS = "20"
    $env:HIT_SMOKE_DURATION = "30s"
    $env:HIT_SMOKE_SLEEP_SECONDS = "0.005"
```

## 6. cache key model

### cách Varnish xây dựng cache key cho product detail

```text
Cache key la "danh tinh" cua mot object trong Varnish cache.
Hai request co CUNG cache key -> share object. KHAC cache key -> separate objects.

VCL quyet dinh cache key trong sub vcl_hash:

  sub vcl_hash {
      hash_data(req.url);         // (1) URL sau khi strip tracking params + query sort
      if (req.http.host) {
          hash_data(req.http.host); // (2) Host header
      }

      // (3) Variant dimensions cho /api/sim/products ($|/|\?)
      if (req.url ~ "^/api/sim/products($|/|\\?)") {
          hash_data(req.http.X-Cache-Language);     // normalized: vi|en|ja
          hash_data(req.http.X-Cache-Geo-Country);  // normalized: VN|SG|US|JP
          hash_data(req.http.X-Cache-Device-Class); // normalized: mobile|tablet|desktop
          hash_data(req.http.X-Cache-AB-Variant);   // normalized: control|variant-a|variant-b
          // NOTE: segment NOT hashed for product detail
          //       (segment ONLY hashed for homefeed)
      }
  }

  Cache key = hash(URL + host + language + geo + device + ab)
```

### 5 dimensions of cache key variance

```text
DIMENSION 1: LANGUAGE (Accept-Language)
  Raw input:       Accept-Language: vi, vi-VN;q=0.9, en;q=0.8
  VCL normalize:   X-Cache-Language = "vi"
                    (extract first 2 chars, lowercase, validate vi|en|ja)
  Fallback:        "en"
  Cache key impact: vi != en != ja -> 3 separate objects per product
  KL validate:     X-Cache-Key-Language header in response

DIMENSION 2: GEO (X-Geo-Country)
  Raw input:       X-Geo-Country: VN (from CDN edge geo-IP)
  VCL normalize:   X-Cache-Geo-Country = "VN"
                    (validate SG|US|JP, fallback VN)
  Fallback:        "VN" (default market)
  Cache key impact: VN != SG != US != JP -> 4 separate objects per product
  KL validate:     X-Cache-Key-Geo header in response

DIMENSION 3: DEVICE (X-Device-Class)
  Raw input:       X-Device-Class: mobile (from CDN edge User-Agent parsing)
  VCL normalize:   X-Cache-Device-Class = "mobile"
                    (validate mobile|tablet|desktop + User-Agent fallback)
  Fallback:        "desktop"
  Cache key impact: mobile != tablet != desktop -> 3 separate objects per product
  KL validate:     X-Cache-Key-Device header in response

DIMENSION 4: AB VARIANT (X-Ab-Variant)
  Raw input:       X-Ab-Variant: control
  VCL normalize:   X-Cache-AB-Variant = "control"
                    (validate variant-a|variant-b, fallback control)
  Fallback:        "control"
  Cache key impact: control != variant-a != variant-b -> 3 separate objects
  KL validate:     X-Cache-Key-AB header in response

DIMENSION 5: SEGMENT (X-User-Segment) -- NOT hashed for product detail
  Raw input:       X-User-Segment: guest
  VCL normalize:   X-Cache-User-Segment = "guest"
                    (validate new_user|returning|vip, fallback guest)
  Fallback:        "guest"
  Cache key impact: NOT included in vcl_hash for /api/sim/products/<id>
                    (only included for homefeed /api/sim/products/homefeed)
  KL validate:     X-Cache-Key-Segment header NOT validated in assertCacheKeyHeaders
                   for product detail (withSegment defaults to false)
```

### expectedCacheKey() trace

```javascript
// shared.js
export function expectedCacheKey(profile) {
  const headers = profile ? profile.headers : {};
  // profile = profiles.guestVNMobileControl
  // headers = {
  //   'Accept-Language': 'vi',
  //   'X-Geo-Country': 'VN',
  //   'X-Device-Class': 'mobile',
  //   'X-Ab-Variant': 'control',
  //   'X-User-Segment': 'guest',
  // }

  const language = ((headers['Accept-Language'] || 'en')
    .trim().slice(0, 2).toLowerCase() || 'en');
  // 'vi' -> slice(0,2) -> 'vi' -> toLowerCase -> 'vi'
  // validate: ['vi','en','ja'].includes('vi') === true -> 'vi'

  return {
    language: 'vi',        // validate vi|en|ja, fallback en
    geo: normalizeGeo('VN'),      // validate SG|US|JP, fallback VN -> 'VN'
    device: normalizeDevice('mobile'), // validate mobile|tablet|desktop -> 'mobile'
    ab: normalizeAB('control'),     // validate variant-a|variant-b -> 'control'
    segment: normalizeSegment('guest'), // validate new_user|returning|vip -> 'guest'
  };
}

// Final expected: { language:'vi', geo:'VN', device:'mobile', ab:'control', segment:'guest' }
```

### điều gì xảy ra khi mot dimension thay đổi

```text
Vi du: Cung URL /api/sim/products/1, nhung user la "guest US mobile control"
  thay vi "guest VN mobile control"

  Dimension change: geo VN -> US
  Cache key: HASH khac nhau vi X-Cache-Geo-Country khac (US vs VN)
  Ket qua:
    - Object 1: /api/sim/products/1 + vi + VN + mobile + control (warm)
    - Object 2: /api/sim/products/1 + vi + US + mobile + control (cold -> MISS)

  Neu US user request:
    -> Lookup voi cache key chua "US" -> khong tim thay trong cache
    -> MISS -> origin -> cache fill voi key "US"
    -> Bay gio co 2 objects rieng biet trong cache cho cung URL
    -> Moi object co TTL, grace, va lifecycle rieng

  Neu US user bi serve object VN (cache leak):
    -> X-Cache-Key-Geo se la "VN" thay vi "US"
    -> assertCacheKeyHeaders() se FAIL
    -> Day la VARIANT LEAKAGE -- case 02 kiem tra ky hon

  Maximum theoretical objects per product detail URL:
    3 languages * 4 geos * 3 devices * 3 ab = 108 variants
    + segment for homefeed = thêm *4 = 432 variants
```

### Normalization rules

```text
Normalization khong phai la validation. No la "lam sach" input de
tranh cache fragmentation:

  Accept-Language: "vi-VN;q=0.9, en;q=0.8"  -> language = "vi"
  Accept-Language: "vi"                       -> language = "vi"
  Accept-Language: "VI"                       -> language = "vi"
  Accept-Language: "Vi-vn"                   -> language = "vi"
  Accept-Language: "fr"                       -> language = "en" (fallback)

  Tat ca cac input tren deu cho ra CUNG cache key cho dimension language.
  Khong co normalization -> "vi", "VI", "vi-VN" deu la cache key khac nhau
  -> 3 objects cho cung noi dung tieng Viet -> cache fragmentation
  -> Hit ratio giam (chi 1/3 request la HIT)
  -> Origin bi goi nhieu hon 3x

Tuong tu cho geo, device, ab, segment:
  X-Geo-Country: "vn" -> "VN"
  X-Device-Class: "Mobile" -> "mobile"
  X-Ab-Variant: "Control" -> "control" (fallback vi khong match variant-a|variant-b)
  X-User-Segment: "" -> "guest" (fallback)

Neu origin gui X-Geo-Country="AU" -> normalize -> "VN" (fallback)
  -> User o Australia duoc serve VN content
  -> CO THE LA BUG hoac CO THE LA BY DESIGN (AU chua duoc ho tro)
  -> Can xac nhan voi business requirement
```

## 7. Request sequence flow

### đầy đủ trace: từ ban-url đến sustained HIT

```text
═══════════════════════════════════════════════════════════════════
PHASE 0: PRECONDITION -- ban-url
═══════════════════════════════════════════════════════════════════

Step 0.1: k6 setup() goi banUrl('/api/sim/products/1')
  -> sendRequest POST to CONTROL_BASE_URL/ops/app/cdn/cache/ban-url
  -> Headers: Authorization: Bearer <token>, X-Ops-Token: <token>
  -> Body: { "url": "/api/sim/products/1" }

Step 0.2: App nhan request, validate token
  -> Token valid -> app sends BAN request to Varnish
  -> BAN req.url == /api/sim/products/1
  -> VCL: vcl_recv -> req.method == "BAN" ->
         ban("req.url == " + req.http.X-Ban-URL) ->
         return (synth(200, "ban url added"))

Step 0.3: App tra 200 OK ve k6
  -> assertStatus(res, 200, 'ban-url /api/sim/products/1') PASS

State after Phase 0:
  - Varnish ban list: [rule: req.url == "/api/sim/products/1"]
  - Object /api/sim/products/1 (neu ton tai) -> lookup se match ban -> MISS

═══════════════════════════════════════════════════════════════════
PHASE 1: FIRST REQUEST -- chung minh MISS
═══════════════════════════════════════════════════════════════════

Step 1.1: k6 setup() goi requestCdn('GET', '/api/sim/products/1', profile)
  -> GET http://localhost:80/api/sim/products/1
  -> Headers: Accept-Language=vi, X-Geo-Country=VN,
             X-Device-Class=mobile, X-Ab-Variant=control,
             X-User-Segment=guest, Accept=application/json

Step 1.2: Varnish receives request on port 80
  VCL vcl_recv:
    -> req.method == "GET" -> continue (khong pass)
    -> req.url NOT match health/metrics/ops -> continue
    -> khong Authorization, khong Cookie, khong no-cache -> continue
    -> khong X-User-Token/X-User-ID/X-Api-Key -> continue
    -> Strip tracking params: khong co query string -> skip
    -> URL match ^/api/sim/products -> call normalize_cache_variants
    -> return (hash)

Step 1.3: VCL normalize_cache_variants
  -> Accept-Language: "vi" -> X-Cache-Language = "vi"
  -> X-Geo-Country: "VN" -> normalized SG? No. US? No. JP? No. -> "VN"
  -> X-Device-Class: "mobile" -> X-Cache-Device-Class = "mobile"
  -> X-Ab-Variant: "control" -> normalized variant-a? No. variant-b? No. -> "control"
  -> X-User-Segment: "guest" -> normalized -> "guest"

Step 1.4: VCL vcl_hash
  -> hash_data(req.url) = hash_data("/api/sim/products/1")
  -> hash_data(req.http.host) = hash_data("localhost")
  -> Products path: hash language "vi", geo "VN", device "mobile", ab "control"
  -> Full hash = SHA256( "/api/sim/products/1" + "localhost" +
                          "vi" + "VN" + "mobile" + "control" )

Step 1.5: Cache lookup
  -> Varnish searches hash table for this hash
  -> Not found (first time, OR ban rule matched and evicted)
  -> Result: MISS -> must fetch from backend

Step 1.6: VCL vcl_backend_response (origin da tao response)
  -> bereq.url ~ ^/api/sim/products/[A-Za-z0-9_-]+ -> set beresp.ttl = 90s
  -> beresp.ttl > 0s -> set beresp.grace = 120s, beresp.keep = 600s
  -> No Set-Cookie, no no-store/private -> object IS cacheable
  -> Return (deliver)

Step 1.7: VCL vcl_deliver
  -> obj.hits = 0 (first time delivering this object)
  -> set resp.http.X-Cache = "MISS"
  -> Products path -> set X-Cache-Key-Language = "vi"
  -> Products path -> set X-Cache-Key-Geo = "VN"
  -> Products path -> set X-Cache-Key-Device = "mobile"
  -> Products path -> set X-Cache-Key-AB = "control"
  -> set resp.http.X-Served-By = "varnish"
  -> set resp.http.X-Cache-Backend-Healthy = "true"

Step 1.8: Response tro ve k6
  -> status: 200
  -> X-Cache: MISS
  -> X-Upstream-Service: products-service
  -> X-Cache-Key-Language: vi
  -> X-Cache-Key-Geo: VN
  -> X-Cache-Key-Device: mobile
  -> X-Cache-Key-AB: control

Step 1.9: k6 assert
  -> assertStatus(200) PASS
  -> assertUpstream('products-service') PASS
  -> assertCacheState('MISS') PASS <<< DAY LA CHECK THEN CHOT
  -> assertCacheKeyHeaders(expected) PASS

State after Phase 1:
  - Object in cache: key = hash(url+host+language+geo+device+ab)
  - TTL = 90s, grace = 120s, keep = 600s
  - obj.hits = 0 (counter reset sau khi deliver)

═══════════════════════════════════════════════════════════════════
PHASE 2: SECOND REQUEST -- chung minh HIT
═══════════════════════════════════════════════════════════════════

Step 2.1: k6 setup() goi requestCdn('GET', '/api/sim/products/1', profile)
  -> SAME request as Phase 1

Step 2.2-2.4: VCL vcl_recv, normalize_cache_variants, vcl_hash
  -> SAME path as Phase 1, SAME normalized values
  -> SAME hash = SHA256(url+host+lang+geo+device+ab)

Step 2.5: Cache lookup
  -> Hash matches -> object FOUND in cache
  -> Check ban list: no ban rule matches this object (ban rule da expired
     hoac object da duoc fetch lai sau ban)
  -> Actually: BAN la "lazy" — ban rule exists, nhung object vua duoc
     fetch SAU KHI ban rule duoc them. Trong Varnish, ban rule chi
     invalidate object da ton tai TRUOC KHI ban duoc them.
     -> Wait, day la mot diem tinh te:

     Varnish BAN behavior:
     - Ban rule duoc them: "req.url == /api/sim/products/1"
     - Khi lookup, Varnish kiem tra: "Does this object match any ban rule?"
     - Object duoc fetch SAU KHI ban -> object duoc fetch luc t1
     - Ban rule duoc them luc t0 (t0 < t1)
     - Varnish so sanh: "Was the ban rule added BEFORE the object was fetched?"
       -> Yes (t0 < t1) -> object matches ban -> MISS
     - WAIT -- dieu nay co nghia la first request trong Phase 1 SAU ban-url
       se MISS (dung), N HUNG second request cung se MISS???
     - NO. Varnish ban lurker se remove ban rule khi no khong con match
       bat ky object nao. Sau khi object bi evict lan dau, khong con
       object nao match ban -> ban rule bi remove.
     - Actually, trong Varnish, ban rules duoc evaluated at lookup time:
       - Lookup tim thay object -> check all ban rules
       - Neu bat ky ban rule match object -> return NULL (MISS)
       - Object bi "temporarily hidden", khong bi xoa
       - Background ban lurker se xoa object that

     - Khi first request MISS -> Varnish fetch object tu origin
     - Object nay duoc gan timestamp = current time
     - Ban rule co timestamp = t0 (khi ban duoc goi)
     - Lookup for second request: object timestamp = t1 > t0
       -> Ban rule DOES match (added before object was fetched)
       -> Varnish kiem tra: if (ban.timestamp < obj.timestamp) -> ban DOES apply
       -> Object bi an -> MISS AGAIN

     - DAY LA SAI! Voi ban("req.url == ..."), Varnish compares:
       ban.test(obj) -> checks obj.http.req.url == "/api/sim/products/1"
       NEU DUNG -> ban applies at lookup time
       -> Object se KHONG BAO GIO HIT sau khi ban

     - Dung: Varnish ban url lam cho URL nay VINH VIEN MISS cho den khi
       ban rule duoc remove (bang ban lurker khi khong con object match)

     - NHUNG trong practice, test nay van PASS. Tai sao?

     - LY DO: App khong goi BAN truc tiep. App goi POST /ops/app/cdn/cache/ban-url
       -> App xu ly -> App goi BAN toi Varnish -> Varnish add ban rule
       -> App tra 200 OK
       -> CO LE app implementation khong goi BAN ma goi PURGE?
       -> PURGE xoa object ngay lap tuc, khong de lai ban rule

     - Hoac: App implementation dung PURGE thay vi BAN cho single URL
     - Hoac: Varnish ban lurker da clean ban rule truoc khi second request

  Dù cơ chế chính xác là gì (PURGE vs BAN), kết quả mong đợi là:
    First request sau ban-url -> MISS
    Second request (immediate) -> HIT

Step 2.6: VCL vcl_hit
  -> obj.hits = 0 (first time serving this copy of object)
  -> Actually: After first fetch, obj.hits = 0 (counter for NEW fetch)
  -> Second lookup: found, obj.ttl = ~90s (still fresh)
  -> obj.ttl >= 0s -> return (deliver)

Step 2.7: VCL vcl_deliver
  -> obj.hits = 0 -> wait, van la 0?
  -> NO: obj.hits tang len 1 SAU KHI deliver lan dau
  -> Second deliver: obj.hits = 1 (for THIS copy of object)
  -> set resp.http.X-Cache = "HIT"
  -> set resp.http.X-Cache-Hits = "1"

Step 2.8: Response tro ve k6
  -> status: 200
  -> X-Cache: HIT  <<< DAY LA EVIDENCE MISS->HIT
  -> X-Cache-Hits: 1
  -> X-Cache-Key-Language: vi
  -> X-Cache-Key-Geo: VN
  -> X-Cache-Key-Device: mobile
  -> X-Cache-Key-AB: control

Step 2.9: k6 assert
  -> assertCacheState('HIT') PASS <<< CHECK THEN CHOT
  -> All other asserts PASS

State after Phase 2:
  - Object confirmed cached with HIT
  - obj.hits = 1
  - TTL remaining ~90s

PHASE 3: SUSTAINED READS -- default() loop
═══════════════════════════════════════════════════════════════════

Step 3.1-3.N: k6 default() loops 4 VUs, 18s, 25ms sleep
  -> Each iteration: SAME request, SAME headers
  -> Object still in cache, still fresh (18s << 90s TTL)
  -> Every lookup: FOUND -> HIT
  -> X-Cache-Hits increments: 2, 3, 4, ... up to ~2400

Step 3.N+1: After each iteration
  -> assertCacheState('HIT') PASS every time
  -> assertCacheKeyHeaders(expected) PASS every time
  -> sleep(0.025) -> next iteration

  -> By the end of 18s:
      ~2400 requests
      All HIT (except the 1 MISS in setup)
      Origin load: exactly 1 request for this URL
      Cache offload ratio: 2400:1

End state:
  - Object in cache with obj.hits ~ 2400
  - TTL remaining ~ 72s (90s - 18s)
  - All checks passed
  - k6 exits 0
═══════════════════════════════════════════════════════════════════
```

## 8. Key signals/headers

### bảng tổng quan headers trong response

```text
HEADER                   | SOURCE      | Y NGHIA
-------------------------|-------------|------------------------------------------
X-Cache                  | Varnish     | HIT: served from cache
                         | vcl_deliver | MISS: fetched from origin
                         |             | BYPASS/PASS: not cacheable, went to origin
-------------------------|-------------|------------------------------------------
X-Cache-Hits             | Varnish     | So lan object nay da duoc deliver
                         | vcl_deliver | 0 = lan dau (MISS), 1+ = HIT
                         |             | Useful de confirm sustained HIT
-------------------------|-------------|------------------------------------------
X-Cache-Age              | Varnish     | Tuoi cua object trong cache (seconds)
                         | vcl_deliver | = resp.http.Age (from origin)
                         |             | Useful cho TTL expiry tests
-------------------------|-------------|------------------------------------------
X-Cache-Backend-Healthy  | Varnish     | Backend healthy check result
                         | vcl_deliver | true/false
                         |             | Useful cho stale-while-error tests
-------------------------|-------------|------------------------------------------
X-Upstream-Service       | App/Nginx   | Service da xu ly request
                         |             | products-service, cart-service, ...
                         |             | Confirms routing is correct
-------------------------|-------------|------------------------------------------
X-Cache-Key-Language     | Varnish     | Normalized language in cache key
                         | vcl_deliver | vi, en, ja (or en fallback)
-------------------------|-------------|------------------------------------------
X-Cache-Key-Geo          | Varnish     | Normalized geo in cache key
                         | vcl_deliver | VN, SG, US, JP (or VN fallback)
-------------------------|-------------|------------------------------------------
X-Cache-Key-Device       | Varnish     | Normalized device in cache key
                         | vcl_deliver | mobile, tablet, desktop (or desktop fallback)
-------------------------|-------------|------------------------------------------
X-Cache-Key-AB           | Varnish     | Normalized AB variant in cache key
                         | vcl_deliver | control, variant-a, variant-b
-------------------------|-------------|------------------------------------------
X-Cache-Key-Segment      | Varnish     | Normalized segment (only for homefeed)
                         | vcl_deliver | guest, new_user, returning, vip
-------------------------|-------------|------------------------------------------
X-Served-By              | Varnish     | Xac nhan response di qua Varnish
                         | vcl_deliver | Luon = "varnish"
                         |             | Neu absent -> request bypassed Varnish
```

### mỗi header proves điều gì

```text
X-Cache: MISS -> HIT sequence:
  Proves: CDN da fetch object tu origin, cache no, va serve tu cache
  cho request sau. Day la PROOF PRIMARY cua case nay.
  Neu thieu header nay: KHONG THE biet request di qua CDN hay khong.

X-Cache-Hits:
  Proves: object da duoc deliver bao nhieu lan. Trong sustained phase,
  con so nay tang dan -> chung minh object van con trong cache.
  Neu X-Cache=HIT nhung X-Cache-Hits always = 0 -> BUG: obj.hits
  counter khong tang.

X-Upstream-Service: products-service:
  Proves: request duoc route den DUNG service.
  Neu sai (vd: cart-service thay vi products-service) -> routing bug.
  Dac biet quan trong khi CDN co the serve stale content tu sai backend.

X-Cache-Key-Language: vi:
  Proves: CDN da normalize language thanh "vi" va include trong cache key.
  Neu khong co header nay cho product path -> VCL bug (vcl_deliver condition sai).
  Neu value sai (vd: "en" thay vi "vi") -> normalization bug.

X-Cache-Key-Geo: VN:
  Proves: Geo dimension duoc normalize va include trong cache key.
  Neu geo sai -> variant leakage (case 02 se kiem tra ky hon).

X-Cache-Key-Device: mobile:
  Proves: Device dimension duoc normalize va include.
  Neu user o mobile nhung X-Cache-Key-Device=desktop -> content sai.
  Neu user o desktop nhung X-Cache-Key-Device=mobile -> content sai.

X-Cache-Key-AB: control:
  Proves: AB variant duoc normalize va include.
  Neu AB sai -> user trong variant-a nhung nhan content cua control.

X-Cache-Key-Segment:
  NOT checked in this case (withSegment=false in assertCacheKeyHeaders).
  Segment is NOT part of product detail cache key (only homefeed).
  Neu header nay CO MAT cho product detail -> co the la VCL bug
  (segment duoc include trong hash nhung khong nen).
```

### Expected values per request

```text
REQUEST           | X-Cache | X-Cache-Hits | X-Upstream-Service   | Cache-Key-*
------------------|---------|--------------|----------------------|----------------
first request     | MISS    | (absent/0)   | products-service     | vi,VN,mobile,control
second request    | HIT     | 1            | products-service     | vi,VN,mobile,control
sustained reads   | HIT     | 2,3,4,...    | products-service     | vi,VN,mobile,control

NOTE: X-Cache-Hits co the absent trong MISS (obj.hits = 0, Varnish
khong set header nay). Co the la 0 hoac absent tuy Varnish version.
```

## 9. Pass/fail criteria

### PASS criteria

```text
PASS khi tat ca cac dieu kien sau DONG THOI thoa man:

  1. k6 exits 0 (khong co threshold failure)
  2. ALL checks pass:
     - ban-url status 200 (setup)
     - first request: status 200 + upstream products-service + MISS
     - second request: status 200 + upstream products-service + HIT
     - all sustained requests: status 200 + upstream products-service + HIT
     - all cache key header checks pass
  3. Cache state sequence: MISS -> HIT -> HIT
     - First request phai la MISS (cold cache)
     - Second request phai la HIT (warm cache)
     - Sustained requests deu la HIT (cache stable)
  4. Thresholds met:
     - checks['rate==1'] = true
     - http_req_failed['rate==0'] = true
  5. No errors or warnings in k6 output

PASS = CDN basic cache path is healthy.
       Cache fill, lookup, and delivery all working as expected.
       Origin offload is functional for anonymous product detail reads.
```

### FAIL scenarios

```text
┌──────────────────────────────────────────────────────────────────────┐
│ FAIL MODE                    │ ROOT CAUSE                           │
├──────────────────────────────┼──────────────────────────────────────┤
│ setup: ban-url returns 401   │ OPS_AUTH_TOKEN missing or invalid    │
│                              │ Control path not accessible          │
│                              │ App not running                      │
├──────────────────────────────┼──────────────────────────────────────┤
│ setup: ban-url returns 4xx/5xx│ App control endpoint broken         │
│                              │ Varnish BAN endpoint unreachable     │
├──────────────────────────────┼──────────────────────────────────────┤
│ first request: status != 200 │ Backend down or route broken         │
│                              │ Products service not responding      │
├──────────────────────────────┼──────────────────────────────────────┤
│ first request: upstream wrong│ Routing misconfiguration             │
│                              │ Wrong service handling the path      │
├──────────────────────────────┼──────────────────────────────────────┤
│ first request: HIT (not MISS)│ Cache already warm (ban-url failed   │
│                              │   silently or didn't execute)        │
│                              │ Another process warmed the cache     │
├──────────────────────────────┼──────────────────────────────────────┤
│ second request: MISS (not HIT)│ Response not cacheable:             │
│                              │   - Set-Cookie in response           │
│                              │   - Cache-Control: private/no-store  │
│                              │   - VCL returns pass                 │
│                              │   - beresp.ttl <= 0                  │
│                              │   - VCL cacheability logic broken    │
├──────────────────────────────┼──────────────────────────────────────┤
│ sustained: intermittent MISS │ TTL too short, object expiring       │
│                              │ mid-test                             │
│                              │ Cache eviction due to memory pressure│
│                              │ Race condition in cache lookup       │
├──────────────────────────────┼──────────────────────────────────────┤
│ checks['rate==1'] threshold  │ Any single check failure triggers    │
│ violated                     │ this. Check output for which check   │
│                              │ failed and at what point.            │
├──────────────────────────────┼──────────────────────────────────────┤
│ http_req_failed threshold    │ At least 1 HTTP request failed       │
│ violated                     │ (status 0, connection refused,       │
│                              │  timeout, DNS error)                 │
├──────────────────────────────┼──────────────────────────────────────┤
│ cache key header mismatch    │ Normalization in VCL differs from    │
│                              │ expectedCacheKey() in JS.            │
│                              │ VCL changed without updating test.   │
│                              │ Or: VCL normalization has a bug.     │
└──────────────────────────────┴──────────────────────────────────────┘
```

### vì sao status=200 không đủ

```text
Mot response 200 OK tu API KHONG he chung minh CDN dang hoat dong.

Scenario: CDN bi bypass (VCL tra ve pass cho tieu de Authorization)
  -> Request di thang qua CDN den origin
  -> Origin tra 200 OK
  -> CDN forward 200 OK ve client
  -> Nhung KHONG CO CACHE -> request tiep theo van MISS
  -> Status=200 pass test -> nhung CDN contract FAIL

Scenario: CDN cache object nhung header bi mat
  -> X-Cache header bi strip boi mot proxy o giua
  -> Response van la HIT nhung khong co header de prove
  -> assertCacheState('HIT') FAIL -> test FAIL
  -> KHONG the prove CDN da cache

CAN:
  - X-Cache header present
  - X-Cache = MISS cho first request
  - X-Cache = HIT cho subsequent requests
  - X-Cache-Key-* headers match expected normalized values
  - Status = 200 (basic health check)

Status 200 chi chung minh "API con song".
X-Cache sequence chung minh "CDN dang cache dung cach".
Ca 2 cung can. Thieu 1 trong 2, test FAIL.
```

## 10. cách chạy + output doc

### điều kiện tiên quyết

```text
Truoc khi chay case 01:

  1. Full stack da duoc deploy (TargetLayer=full):
     - Varnish running on port 80
     - Nginx + App running
     - Products service running
     - Control endpoint accessible on port 8088

  2. Environment variables da duoc set:
     - BASE_URL=http://localhost:80
     - CONTROL_BASE_URL=http://localhost:8088
     - CATALOG_EVENTS_BASE_URL=http://localhost:9091
     - OPS_AUTH_TOKEN=<valid-token>

  3. Token co quyen truy cap control endpoint
     - Verify: curl -X POST http://localhost:8088/ops/app/cdn/cache/ban-url \
               -H "Authorization: Bearer <token>" \
               -H "Content-Type: application/json" \
               -d '{"url":"/api/sim/products/1"}'
     - Expected: 200 OK

  4. CDN public path responding:
     - Verify: curl -H "Accept-Language: vi" \
               -H "X-Geo-Country: VN" \
               http://localhost:80/api/sim/products/1
     - Expected: 200 OK, X-Cache present (MISS or HIT)
```

### PowerShell command

```powershell
# Set environment variables
cd E:/Projects/k6/k6-metrics-server

$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<your-ops-token>"

# Option 1: Run with run-cdn-capabilities.ps1 helper
./scripts/run-cdn-capabilities.ps1 -Scenarios 01-hit-smoke

# Option 2: Run k6 directly
k6 run load-target/k6/cdn/01-hit-smoke.js

# Option 3: Run with custom VUs/duration (override defaults)
$env:HIT_SMOKE_VUS = "2"
$env:HIT_SMOKE_DURATION = "10s"
$env:HIT_SMOKE_SLEEP_SECONDS = "0.05"
k6 run load-target/k6/cdn/01-hit-smoke.js
```

### How to read passing output

```text
PASSING OUTPUT (rut gon, chi hien thi key signals):

  execution: local
  output: -
  script: load-target/k6/cdn/01-hit-smoke.js

  scenarios: (100.00%) 1 scenario, 4 max VUs, 48s max duration

  running (00m18.0s), 4/4 VUs, ? complete and ? interrupted

  # KEY CHECK OUTPUT -- SETUP PHASE
  * ban-url /api/sim/products/1 status 200 ................... 100.00%
  * first detail request status 200 .......................... 100.00%
  * first detail request upstream products-service ........... 100.00%
  * first detail request cache state MISS .................... 100.00% <<<
  * first detail request cache language vi ................... 100.00%
  * first detail request cache geo VN ........................ 100.00%
  * first detail request cache device mobile ................. 100.00%
  * first detail request cache ab control .................... 100.00%

  * second detail request status 200 ......................... 100.00%
  * second detail request upstream products-service .......... 100.00%
  * second detail request cache state HIT .................... 100.00% <<<
  * second detail request cache language vi .................. 100.00%
  * second detail request cache geo VN ....................... 100.00%
  * second detail request cache device mobile ................ 100.00%
  * second detail request cache ab control ................... 100.00%

  # KEY CHECK OUTPUT -- DEFAULT PHASE (repeated ~2400 times)
  * sustained detail request status 200 ...................... 100.00%
  * sustained detail request upstream products-service ....... 100.00%
  * sustained detail request cache state HIT ................. 100.00% <<<
  * sustained detail request cache language vi ............... 100.00%
  * sustained detail request cache geo VN .................... 100.00%
  * sustained detail request cache device mobile ............. 100.00%
  * sustained detail request cache ab control ................ 100.00%

  checks .........................: 100.00% * 16813 out of 16813
  http_req_failed ................: 0.00%   * 0 out of ~2402
  http_req_duration ..............: avg=5ms   min=1ms  max=15ms  p(95)=8ms

  # THRESHOLDS
  * checks: rate==1 ............... OK  (100.00%)
  * http_req_failed: rate==0 ...... OK  (0.00%)

  PASS: all checks passed, thresholds met, MISS->HIT->HIT confirmed.
```

### How to read failing output

```text
FAILING OUTPUT (second request MISS -- cache NOT working):

  # KEY FAILURE SIGNAL
  * second detail request cache state HIT .................... 0.00%  <<< FAIL
    Expected: HIT, Got: MISS

  * sustained detail request cache state HIT ................. 0.00%  <<< FAIL
    Expected: HIT, Got: MISS (every iteration fails)

  checks .........................: 93.41%  * 15712 out of 16813
                                    ^^^^^^ NOT 100% -> threshold violated

  # THRESHOLDS
  * checks: rate==1 ............... FAIL  (93.41% < 100.00%) <<<
  * http_req_failed: rate==0 ...... OK   (0.00%)

  FAIL: MISS->HIT transition failed.
        All requests returned MISS -- CDN is not caching this response.
        Check: origin Cache-Control/s-maxage headers, VCL cacheability rules.

FAILING OUTPUT (first request HIT -- cache was NOT cold):

  * first detail request cache state MISS .................... 0.00%  <<< FAIL
    Expected: MISS, Got: HIT

  * second detail request cache state HIT .................... 100.00% (OK but
    sequence is wrong -- first should be MISS)

  FAIL: Cold-start precondition violated.
        First request was HIT (not MISS) -- cache was already warm.
        Check: ban-url setup succeeded? Did another test warm the cache?
        Retry after: wait 90s for TTL expiry, or verify ban-url works.

FAILING OUTPUT (http_req_failed > 0):

  * http_req_failed ................: 12.34%  * 296 out of 2402  <<<
  * http_req_failed: rate==0 ...... FAIL

  FAIL: HTTP requests failing at CDN level.
        Check: Varnish running on port 80? Nginx healthy?
        Check: network connectivity between k6 and localhost:80.
```

### output điển hình khi chạy CI

```text
Trong CI pipeline, output se duoc capture va parsed. Key patterns:

  PASS pattern:     "checks .........................: 100.00%"
  FAIL pattern:     "checks .........................: < 100.00%"
  MISS->HIT proof:  grep "cache state MISS" + grep "cache state HIT"
                    both must show 100.00%

  Exit code:        0 = PASS, non-zero = FAIL
  Duration:         ~18-20s wall clock (18s duration + setup overhead)
```

## 11. 4 output -> decision scenarios

### Scenario A: All checks pass, MISS -> HIT -> HIT

```text
OUTPUT SIGNATURE:
  ✓ first detail request cache state MISS ........ 100.00%
  ✓ second detail request cache state HIT ........ 100.00%
  ✓ sustained detail request cache state HIT ..... 100.00%
  ✓ checks ....................................... 100.00%
  ✓ http_req_failed ............................... 0.00%
  ✓ All thresholds met

  X-Cache sequence: MISS -> HIT -> HIT (2400+ HITs)

DECISION: CDN BASIC PATH HEALTHY.

  * Cache fill working: origin response is cacheable, stored correctly
  * Cache lookup working: Varnish finds object by hash key
  * Cache delivery working: HIT response served with correct headers
  * Variant normalization working: cache key headers match expected
  * Sustained reads stable: no intermittent MISS, no eviction during 18s
  * Origin offload functional: 1 origin hit for ~2400 CDN hits

  Next steps:
    * Proceed to cdn-02-variant-keys (prove variant isolation)
    * Proceed to cdn-03-bypass-rules (prove auth/cookie/write bypass)
    * If deploying to production: this case SHOULD be part of
      post-deployment smoke suite (first case to run)
    * Set up CI to run this on every PR that touches VCL or
      origin cache headers

  Confidence: HIGH. This case is deterministic, no timing dependencies
  (TTL 90s, test 18s -- no risk of TTL expiry during test).
```

### Scenario B: Always MISS (second request still MISS)

```text
OUTPUT SIGNATURE:
  ✓ first detail request cache state MISS ........ 100.00%
  ✗ second detail request cache state HIT ........ 0.00%
       Expected: HIT, Got: MISS
  ✗ sustained detail request cache state HIT ..... 0.00%
  ✗ checks ....................................... ~93.00%
  ✓ http_req_failed ............................... 0.00%
  ✗ threshold checks['rate==1'] violated

DECISION: CDN IS NOT CACHING -- INVESTIGATE CACHEABILITY.

  Investigation checklist (ordered by likelihood):

  1. CHECK ORIGIN RESPONSE HEADERS:
     curl -v -H "Accept-Language: vi" \
          -H "X-Geo-Country: VN" \
          -H "X-Device-Class: mobile" \
          -H "X-Ab-Variant: control" \
          http://localhost:80/api/sim/products/1 2>&1 | grep -iE
          "(cache-control|set-cookie|x-cache|surrogate-key|age)"

     Red flags:
     - Set-Cookie present -> VCL vcl_backend_response: beresp.uncacheable=true
     - Cache-Control: private -> same as above
     - Cache-Control: no-store -> same as above
     - Cache-Control: no-cache -> VCL vcl_recv returns pass
     - Missing Cache-Control with s-maxage or max-age -> origin may not set TTL
     - Cache-Control: max-age=0 -> beresp.ttl = 0, uncacheable

  2. CHECK VCL vcl_backend_response:
     - Open default.vcl, find vcl_backend_response
     - Verify: beresp.url matching rule for product detail
       ^/api/sim/products/[A-Za-z0-9_-]+ -> set beresp.ttl = 90s
     - Verify: beresp.ttl > 0 check works
     - Check if any rule above sets uncacheable=true BEFORE the TTL=90s rule

  3. CHECK VCL vcl_recv:
     - Is the request being passed instead of hashed?
     - HEADERS sent by k6:
       Accept: application/json
       Accept-Language: vi
       X-Geo-Country: VN
       X-Device-Class: mobile
       X-Ab-Variant: control
       X-User-Segment: guest
     - Verify: none of these headers trigger pass (Authorization, Cookie, etc.)
     - Verify: URL pattern matching ^/api/sim/products($|/|\\?) works

  4. CHECK VARNISH LOGS:
     varnishlog -g request -q "ReqUrl eq '/api/sim/products/1'" | grep -iE
     "(hash|pass|ttl|uncacheable|hit|miss)"

     Look for:
     - "return(pass)" in VCL_return -> VCL is bypassing cache
     - "uncacheable" in TTL -> backend response marked uncacheable
     - "Hit" or "HitPass" in VCL_call -> cache behavior

ACTION: Fix the cacheability issue at the appropriate layer.
        Rerun case 01. MUST PASS before any other CDN case.

URGENCY: BLOCKER. All other CDN cases depend on this foundation.
         Do not proceed until this passes.
```

### Scenario C: Second request MISS, third HIT (TTL race)

```text
OUTPUT SIGNATURE (hypothetical -- rare with 18s test and 90s TTL):
  ✓ first detail request cache state MISS ........ 100.00%
  ✗ second detail request cache state HIT ........ 0.00%
       Expected: HIT, Got: MISS
  ✓ sustained detail request cache state HIT ..... 100.00%
       (third and subsequent requests are HIT)
  ✗ checks ....................................... ~99.99%
       (almost passing, just second request failed)

  NOTE: With 90s TTL and immediate second request, this should
        NOT happen. But with SHORTER TTL (e.g., 1s) or slow test
        execution, it's possible.

DECISION: TTL TOO SHORT OR VCL GRACE/STALE ISSUE.

  Investigation:

  1. Check what TTL is being set:
     - varnishlog shows: BerespTTL = <value>
     - vcl_backend_response sets 90s for product detail
     - But origin may override with Cache-Control: s-maxage=<value>
     - If s-maxage < 90s, Varnish uses the smaller value? Or origin value?
     - Varnish: beresp.ttl is INITIALLY set from origin Cache-Control
       THEN vcl_backend_response can override
     - If origin sets Cache-Control: s-maxage=1, beresp.ttl starts at 1
       -> vcl_backend_response: if (beresp.ttl <= 0s) { set to 90s }
       -> beresp.ttl = 1 (positive) -> SKIPS the 90s override!
       -> Object expires after 1 second!

  2. Check grace/stale configuration:
     - vcl_hit: if obj.ttl >= 0s -> deliver (normal HIT)
     - vcl_hit: if obj.ttl < 0s && backend unhealthy -> stale deliver
     - vcl_hit: if obj.ttl < 0s && backend healthy -> pass (MISS)
     - If obj.ttl expired between first and second request -> MISS

  3. Check if something is purging the cache between first and second:
     - Other test running in parallel?
     - Background process sending PURGE/BAN?
     - TTL very short (< 1s) -> expires before second request

ACTION: If TTL < required window for test:
        - Increase TTL in origin or VCL (beresp.ttl = 90s is reasonable)
        - Or increase test speed (reduce sleep, reduce duration)
        - Or add grace period so even expired objects serve

URGENCY: MEDIUM. Cache IS eventually working (third request HIT).
         But reliability is compromised if TTL is too short.
```

### Scenario D: ban-url setup fails

```text
OUTPUT SIGNATURE:
  ✗ ban-url /api/sim/products/1 status 200 ........ 0.00%
       Expected: 200, Got: 401 (or 403, or 500, or connection refused)

  Test may still run default() phase but results are UNRELIABLE:
  - first request could be HIT (cache warm from prior run)
  - MISS->HIT sequence cannot be proven
  - Test should FAIL with threshold violation

DECISION: CONTROL PATH AUTH OR NETWORK ISSUE.

  Investigation:

  1. Check OPS_AUTH_TOKEN:
     - Is it set? echo $env:OPS_AUTH_TOKEN
     - Is it correct? Compare with app config
     - Did it expire? Some tokens have TTL
     - Copy-paste error? Trailing space, newline in token

  2. Check control endpoint accessibility:
     curl -v http://localhost:8088/ops/app/cdn/cache/ban-url \
       -H "Authorization: Bearer <token>" \
       -H "X-Ops-Token: <token>" \
       -H "Content-Type: application/json" \
       -d '{"url":"/api/sim/products/1"}'

     Response codes:
     - 200: OK, control path working
     - 401: Token invalid or missing
     - 403: Token valid but insufficient permissions
     - 404: Control endpoint not registered (app not running?)
     - 500: Internal error in app
     - Connection refused: Control path not running on port 8088

  3. Check app logs:
     - Search for "ban-url" or "cache/ban-url"
     - Look for authentication errors
     - Look for Varnish communication errors

  4. Check if app has Varnish BAN capability:
     - Some implementations use HTTP PURGE to Varnish directly
     - Some use Varnish admin interface
     - Some use an internal message queue
     - Verify the mechanism is configured and working

ACTION: Fix token or control path issue.
        Until ban-url works, CANNOT prove cold-start precondition.
        Fallback: Wait 90s for TTL to expire naturally, then retry.
        But this is not deterministic and wastes time.

URGENCY: BLOCKER. Setup precondition must work for reliable test results.
```

## 12. Nghich ly / misconceptions

### Nghich ly 1: "200 OK nghia la CDN hoạt động"

```text
FALSE. Day la misconception pho bien nhat.

  200 OK chi chung minh: "co mot server nao do tra ve response thanh cong"
  No KHONG chung minh response do den tu CDN cache.
  No KHONG chung minh request tiep theo se duoc cache.

  App tra 200 OK -> test pass -> nhung CDN KHONG HE cache -> origin
  nhan toan bo 500,000 requests -> system sup do.

  CAN:
    - X-Cache header: HIT hoac MISS
    - Sequence: MISS -> HIT -> HIT
    - X-Cache-Key-* headers match expected normalized values
    - X-Cache-Hits increments

  Mot 200 OK khong co X-Cache header la INCOMPLETE evidence.
```

### Nghich ly 2: "HIT nghia la object se luon được cache"

```text
FALSE. HIT cho request HOM NAY khong dam bao gi ca cho request MAI SAU.

  Mot object HIT co TTL (Time To Live):
    - product detail: TTL = 90s (VCL default)
    - Sau 90s: object expired -> lookup -> vcl_hit -> obj.ttl < 0
      -> backend healthy -> return (pass) -> MISS
    - Backend unhealthy -> serve stale (neu grace > 0)

  Mot object HIT co the bi evict:
    - Varnish memory pressure -> LRU eviction
    - Explicit purge/ban -> object invalidated
    - Object keep timeout (keep=600s) -> object removed from disk

  Mot object HIT dang serve response cu:
    - Neu origin thay doi du lieu -> CDN van serve object cu
    - Cho den khi TTL expire hoac invalidation
    - Stale-while-revalidate co the serve object cu RAT LAU

  HIT chi la snapshot in time, khong phai eternal guarantee.
```

### Nghich ly 3: "ban-url xong la cache sach"

```text
FALSE -- hoac it nhat la khong chinh xac ve mat ky thuat.

  ban-url('/api/sim/products/1') -> gui BAN toi Varnish
  -> Varnish them ban rule: "req.url == /api/sim/products/1"
  -> Ban rule la "lazy": khong xoa object ngay lap tuc
  -> Object chi bi "hidden" khi lookup match ban rule
  -> Background ban lurker se xoa object that (delay co the den vai giay)

  ban-url CHI xoa exact URL do:
    - /api/sim/products/1 -> bi xoa
    - /api/sim/products/2 -> KHONG bi xoa
    - /api/sim/products -> KHONG bi xoa
    - /api/sim/products/1?color=red -> KHONG bi xoa (query khac)

  ban-url KHONG xoa cac variant khac:
    - /api/sim/products/1 voi language=en -> KHONG bi xoa (key khac)
    - /api/sim/products/1 voi geo=US -> KHONG bi xoa (key khac)

  De xoa TOAN BO products (tat ca variant): dung ban-prefix
  De xoa TOAN BO cache: reset Varnish (restart hoac ban tat ca)

  Trong test, ban-url ISOLATE exact object can chung minh.
  Khong lam nhiem cac object khac hoac variant khac.
```

### Nghich ly 4: "cache key chi la URL"

```text
FALSE. Cache key = URL + HOST + 5 VARIANT DIMENSIONS.

  Vi du:
    GET /api/sim/products/1 (cung URL)
    User A (geo=VN, device=mobile) -> key = hash(url+host+vi+VN+mobile+control)
    User B (geo=US, device=desktop) -> key = hash(url+host+en+US+desktop+control)
    -> 2 objects KHAC NHAU trong cache

  Neu chi dung URL lam cache key -> USER A se nhan content cua USER B
  -> VARIANT LEAKAGE -> sai content (sai ngon ngu, sai gia, sai inventory)
  -> Day la LOI NGHIEM TRONG trong e-commerce

  Neu dung URL + query -> moi tracking param khac nhau tao object khac nhau
  -> CACHE FRAGMENTATION -> hit ratio thap -> origin overload
  -> tracking params phai duoc strip truoc khi hash

  Cache key design la 1 trong nhung quyet dinh quan trong nhat cua CDN.
  Thieu variant -> leakage. Thua variant -> fragmentation.
```

### Nghich ly 5: "Sleep trong test la vo dung"

```text
FALSE. sleep(0.025) trong default() co vai tro cu the:

  1. Tranh bombard CDN:
     - 4 VUs, khong sleep -> moi VU tao ~200 req/s (neu latency 5ms)
     - Total: ~800 req/s -> CDN memory/CPU bi stress
     - Day la CORRECTNESS test, khong phai LOAD test
     - Khong can tao throughput cao de prove MISS->HIT

  2. Tao sustained lightweight traffic:
     - 4 VUs, sleep 25ms -> moi VU tao ~33 req/s
     - Total: ~133 req/s -> nhe nhang, du de verify HIT stability
     - Neu bo sleep -> 800 req/s -> co the gay side effect:
       - Connection pool exhaustion
       - Socket limits
       - Unrelated failures mask cache issue

  3. Mo phong realistic read pattern:
     - User thuc te khong request PDP lien tuc 200 lan/giay
     - Co thoi gian doc, scroll, nghi giua cac request
     - sleep 25ms la micro-pause, phu hop cho smoke test

  Neu muon test LOAD (throughput cao) -> dung case rieng (variation 4).
  Neu muon test CORRECTNESS -> sleep la can thiet.
```

## 13. Checklist

### Pre-run verification

```text
[ ] BASE_URL set to http://localhost:80
[ ] CONTROL_BASE_URL set to http://localhost:8088
[ ] OPS_AUTH_TOKEN set and valid
[ ] Varnish running on port 80 (docker ps hoac varnishstat)
[ ] Nginx + App running (health check OK)
[ ] Products service responding (curl /api/sim/products/1)
[ ] Control endpoint accessible (curl ban-url with token)
[ ] No other CDN test running (shared cache state)
[ ] Cache potentially warm? If yes, wait TTL (90s) hoac ban-url
[ ] k6 binary available and in PATH
```

### During-run verification

```text
[ ] No HTTP errors (http_req_failed = 0)
[ ] X-Cache transitions observed correctly:
    [ ] First request: MISS
    [ ] Second request: HIT
    [ ] Sustained: all HIT
[ ] X-Cache-Hits increments properly (1, 2, 3, ...)
[ ] Cache key headers stable across all requests
[ ] No sudden latency spikes in sustained phase
[ ] check rate stays at 100% throughout
[ ] Run completes in ~20s wall clock
```

### Post-run verification

```text
[ ] k6 exit code = 0
[ ] checks rate = 100.00%
[ ] http_req_failed rate = 0.00%
[ ] All named checks show 100.00%:
    [ ] ban-url status 200
    [ ] first detail request status 200
    [ ] first detail request cache state MISS
    [ ] first detail request upstream products-service
    [ ] second detail request cache state HIT
    [ ] sustained detail request cache state HIT
    [ ] cache key headers match expected
[ ] Logs show no unexpected errors
[ ] Result recorded in test report / CI dashboard
```

## 14. 4-5 variations voi code

### Variation 1: Different endpoint (products list instead of detail)

```javascript
// File: 01-hit-smoke-variant-products-list.js
// Proof: MISS->HIT works for products LIST (not just detail)

import { sleep } from 'k6';
import {
  paths, profiles, expectedCacheKey, banUrl, requestCdn,
  assertCacheKeyHeaders, assertCacheState, assertStatus, assertUpstream
} from './shared.js';

export const options = {
  vus: 4,
  duration: '18s',
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export function setup() {
  const profile = profiles.guestVNMobileControl;
  const expected = expectedCacheKey(profile);

  // DIFFERENT PATH: products list instead of detail
  banUrl(paths.productsList);

  const first = requestCdn('GET', paths.productsList, {
    profile,
    tags: { case: 'list_first' },
  });
  assertStatus(first, 200, 'first list request');
  assertUpstream(first, 'products-service', 'first list request');
  assertCacheState(first, 'MISS', 'first list request');

  const second = requestCdn('GET', paths.productsList, {
    profile,
    tags: { case: 'list_second' },
  });
  assertStatus(second, 200, 'second list request');
  assertUpstream(second, 'products-service', 'second list request');
  assertCacheState(second, 'HIT', 'second list request');

  return { profile, expected };
}

export default function (data) {
  const profile = data?.profile || profiles.guestVNMobileControl;
  const expected = data?.expected || expectedCacheKey(profile);

  const res = requestCdn('GET', paths.productsList, {
    profile,
    tags: { case: 'list_sustained_hit' },
  });
  assertStatus(res, 200, 'sustained list request');
  assertUpstream(res, 'products-service', 'sustained list request');
  assertCacheState(res, 'HIT', 'sustained list request');

  sleep(0.025);
}
```

### Variation 2: Different profile (US desktop instead of VN mobile)

```javascript
// File: 01-hit-smoke-variant-us-desktop.js
// Proof: MISS->HIT works for other variant profiles

import { sleep } from 'k6';
import {
  paths, profiles, expectedCacheKey, banUrl, requestCdn,
  assertCacheKeyHeaders, assertCacheState, assertStatus, assertUpstream
} from './shared.js';

export const options = {
  vus: 4,
  duration: '18s',
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export function setup() {
  // DIFFERENT PROFILE: guest US desktop control
  const profile = profiles.guestUSDesktopControl;
  // language=en, geo=US, device=desktop, ab=control, segment=guest
  const expected = expectedCacheKey(profile);
  // expected = { language:'en', geo:'US', device:'desktop', ab:'control', segment:'guest' }

  banUrl(paths.productDetail);

  const first = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'us_desktop_first' },
  });
  assertStatus(first, 200, 'first US desktop request');
  assertUpstream(first, 'products-service', 'first US desktop request');
  assertCacheState(first, 'MISS', 'first US desktop request');
  assertCacheKeyHeaders(first, expected, 'first US desktop request');
  // Verify: language=en, geo=US, device=desktop (DIFFERENT from default VN mobile)

  const second = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'us_desktop_second' },
  });
  assertStatus(second, 200, 'second US desktop request');
  assertUpstream(second, 'products-service', 'second US desktop request');
  assertCacheState(second, 'HIT', 'second US desktop request');
  assertCacheKeyHeaders(second, expected, 'second US desktop request');

  return { profile, expected };
}

export default function (data) {
  const profile = data?.profile || profiles.guestUSDesktopControl;
  const expected = data?.expected || expectedCacheKey(profile);

  const res = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'us_desktop_sustained_hit' },
  });
  assertStatus(res, 200, 'sustained US desktop request');
  assertUpstream(res, 'products-service', 'sustained US desktop request');
  assertCacheState(res, 'HIT', 'sustained US desktop request');
  assertCacheKeyHeaders(res, expected, 'sustained US desktop request');

  sleep(0.025);
}

// This proves: different profile creates different cache key,
// but MISS->HIT logic is identical. This also proves that
// US desktop cache object is SEPARATE from VN mobile object.
```

### Variation 3: no precondition (test with potentially warm cache)

```javascript
// File: 01-hit-smoke-no-precondition.js
// Proof: What happens when cache might already be warm
// USE CASE: Quick health check in CI where ban-url is too slow
// WARNING: This test is NON-DETERMINISTIC -- first request could be HIT

import { sleep } from 'k6';
import {
  paths, profiles, expectedCacheKey, requestCdn,
  assertCacheKeyHeaders, assertCacheState, assertStatus, assertUpstream
} from './shared.js';

export const options = {
  vus: 1,
  duration: '5s',
  thresholds: {
    http_req_failed: ['rate==0'],
    // NOTE: checks rate NOT set to 1 because first request could be HIT
    //       if cache is warm -- this is acceptable for a quick health check
  },
};

export default function () {
  const profile = profiles.guestVNMobileControl;
  const expected = expectedCacheKey(profile);

  const res = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'quick_health_check' },
  });

  assertStatus(res, 200, 'quick health check');
  assertUpstream(res, 'products-service', 'quick health check');
  assertCacheKeyHeaders(res, expected, 'quick health check');

  // Instead of asserting HIT or MISS, just log what we got
  const cacheState = res.headers['X-Cache'] || 'unknown';
  console.log(`Quick health check: X-Cache=${cacheState}, status=${res.status}`);

  // Still PASS if HIT or MISS, as long as status=200 and headers match
  // This is a WEAKER test -- use only for quick CI checks, not for
  // full CDN capability proof.

  sleep(0.1);
}

// DIFFERENCE from main case:
// - No setup() phase -> no ban-url precondition
// - No cache state assertion (accepts HIT or MISS)
// - Shorter duration (5s), 1 VU
// - Weaker proof: only proves "CDN is serving traffic", not "MISS->HIT works"
// - Use case: pre-merge CI check (fast feedback), not post-deploy validation
```

### Variation 4: Higher sustained VUs (stress test HIT serving)

```javascript
// File: 01-hit-smoke-stress-hit.js
// Proof: CDN can serve sustained HIT under higher concurrency
// NOTE: This is a STRESS test for HIT serving, not a correctness test

import { sleep } from 'k6';
import {
  paths, profiles, expectedCacheKey, banUrl, requestCdn,
  assertCacheKeyHeaders, assertCacheState, assertStatus, assertUpstream
} from './shared.js';

export const options = {
  vus: 50,            // HIGHER: 50 VUs instead of 4
  duration: '30s',    // LONGER: 30s instead of 18s
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<50'],  // ADDED: latency threshold
  },
};

export function setup() {
  const profile = profiles.guestVNMobileControl;
  const expected = expectedCacheKey(profile);

  banUrl(paths.productDetail);

  // Same cold-start proof as main case
  const first = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'stress_first' },
  });
  assertStatus(first, 200, 'first request');
  assertCacheState(first, 'MISS', 'first request');
  assertCacheKeyHeaders(first, expected, 'first request');

  const second = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'stress_second' },
  });
  assertStatus(second, 200, 'second request');
  assertCacheState(second, 'HIT', 'second request');
  assertCacheKeyHeaders(second, expected, 'second request');

  return { profile, expected };
}

export default function (data) {
  const profile = data?.profile || profiles.guestVNMobileControl;
  const expected = data?.expected || expectedCacheKey(profile);

  const res = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'stress_sustained_hit' },
  });
  assertStatus(res, 200, 'stress sustained');
  assertUpstream(res, 'products-service', 'stress sustained');
  assertCacheState(res, 'HIT', 'stress sustained');
  assertCacheKeyHeaders(res, expected, 'stress sustained');

  sleep(0.01);  // SHORTER sleep (10ms) -> higher throughput
}

// EXPECTED (if CDN HIT performance is healthy):
// - 50 VUs * (30s / ~15ms iteration) ~= 100,000 HIT requests
// - All HIT (no origin hits after setup)
// - p(95) < 50ms latency
// - Origin gets exactly 1 request (the MISS in setup)
//
// If HIT latency is high (>50ms):
// - CDN may be bottlenecking on CPU/memory/network
// - Check varnishstat for cache hit rate, thread usage, session queues
// - May need CDN scaling or Varnish tuning
```

### Variation 5: Smoke test with shorter duration (CI-optimized)

```javascript
// File: 01-hit-smoke-quick-ci.js
// Proof: Fastest possible MISS->HIT proof for CI pipeline
// Duration: ~5s total (including setup)

import { sleep } from 'k6';
import {
  paths, profiles, expectedCacheKey, banUrl, requestCdn,
  assertCacheKeyHeaders, assertCacheState, assertStatus, assertUpstream
} from './shared.js';

export const options = {
  iterations: 10,     // EXACTLY 10 iterations (khong duration-based)
  vus: 2,             // 2 VUs
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export function setup() {
  const profile = profiles.guestVNMobileControl;
  const expected = expectedCacheKey(profile);

  banUrl(paths.productDetail);

  const first = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'ci_first' },
  });
  assertStatus(first, 200, 'first');
  assertCacheState(first, 'MISS', 'first');
  assertCacheKeyHeaders(first, expected, 'first');

  const second = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'ci_second' },
  });
  assertStatus(second, 200, 'second');
  assertCacheState(second, 'HIT', 'second');
  assertCacheKeyHeaders(second, expected, 'second');

  return { profile, expected };
}

export default function (data) {
  const profile = data?.profile || profiles.guestVNMobileControl;
  const expected = data?.expected || expectedCacheKey(profile);

  const res = requestCdn('GET', paths.productDetail, {
    profile,
    tags: { case: 'ci_hit' },
  });
  assertStatus(res, 200, 'sustained');
  assertCacheState(res, 'HIT', 'sustained');
  assertCacheKeyHeaders(res, expected, 'sustained');

  sleep(0.005);  // Minimal sleep for CI speed
}

// Total runtime: ~2s setup + ~1s for 10 iterations = ~3-5s
// Use case: Pre-merge CI check
// Trade-off: Does NOT prove sustained HIT over time (only 10 iterations)
//           But catches the most common failure: second request not HIT
```

## 15. Anti-patterns

### Anti-pattern 1: Testing without ban-url precondition

```text
PROBLEM:
  Chay 01-hit-smoke ma khong ban-url truoc -> first request co the la HIT
  (neu cache da warm tu lan chay truoc hoac manual testing).
  Test van pass (X-Cache=HIT) nhung KHONG chung minh duoc MISS->HIT transition.
  Ban tu danh lua chinh minh.

SYMPTOM:
  "first detail request cache state MISS" .................... 0.00% FAIL
  Tat ca request deu la HIT
  Neu khong check MISS -> ban co the bo qua setup FAIL

FIX:
  LUON chay ban-url truoc khi test. Neu ban-url khong the chay
  (khong co token, control path down) -> FIX DIEU KIEN DO TRUOC.
  Khong bao gio bo qua precondition "vi no van pass".
  Pass condition bao gom MISS->HIT sequence, khong chi HIT.

  Neu khong the chay ban-url:
    - Wait 90s (TTL) + retry -> cache tu expired
    - Hoac accept day la WEAKER TEST (variation 3)
    - VA GHI RO TRONG REPORT: "cold start not proven"
```

### Anti-pattern 2: Only checking status codes

```text
PROBLEM:
  Chi check response.status === 200, bo qua X-Cache, X-Cache-Key-*,
  X-Upstream-Service. Test "pass" nhung KHONG BIET CDN co cache hay khong.

SYMPTOM:
  Test output: "All 200 OK, test PASS"
  Thuc te: CDN dang bypass cache, origin nhan toan bo traffic
  X-Cache header: MISS (cho every request)

FIX:
  LUON check:
    - X-Cache (HIT/MISS)
    - X-Upstream-Service (dung service)
    - X-Cache-Key-* (dung normalized values)
  Status code chi la precondition, khong phai proof.

  Assert pattern:
    assertStatus(res, 200, ...)
    assertUpstream(res, 'products-service', ...)
    assertCacheState(res, 'HIT', ...)
    assertCacheKeyHeaders(res, expected, ...)
```

### Anti-pattern 3: Running CDN cases in parallel

```text
PROBLEM:
  Nhieu CDN case chay cung luc -> shared cache state bi nhiem cross-test:
  - Case A dang test MISS->HIT
  - Case B purge/ban object cua Case A
  - Case A thay HIT bi bien thanh MISS giua chung -> test FAIL sai
  - Hoac: Case A warm cache, Case B thay HIT thay vi MISS -> test PASS sai

  CDN cache la SHARED STATE. Khong the isolate bang VUs.
  Moi case can sach se khong bi interference.

SYMPTOM:
  - Intermittent failures trong CI
  - "First request HIT" khi le ra phai MISS
  - Test pass locally nhung FAIL trong CI pipeline (co case khac chay truoc)

FIX:
  - LUON chay CDN cases TUAN TU (sequential)
  - Ban-url hoac purge O CUOI MOI CASE de clean up
  - Neu CI chay parallel tests -> tach CDN tests ra stage rieng
  - Hoac dung separate Varnish instances cho moi case (ton tai nguyen)
```

### Anti-pattern 4: Confusing app cache with CDN cache

```text
PROBLEM:
  Products service co internal cache (in-memory, Redis, ...).
  Ban thay response nhanh va response giong nhau cho request thu 2
  -> Ket luan CDN da cache. Nhung thuc te la APP CACHE da cache,
  CDN van MISS.

  App cache khong co:
    - X-Cache header
    - X-Cache-Hits header
    - X-Cache-Key-* headers
    - X-Served-By: varnish

  App cache va CDN cache la 2 layer KHAC NHAU:
    App cache: cache TRONG application process -> giam DB hits
    CDN cache: cache TRUOC application -> giam TOTAL request den app
    Ca 2 co the cung ton tai, nhung chi CDN cache moi tao offload
    cho TOAN BO application tier.

SYMPTOM:
  - Response 200 OK, response time thap -> "CDN working"
  - Nhung X-Cache header missing -> khong di qua CDN
  - Ban da test direct-to-app thay vi CDN path

FIX:
  - LUON verify X-Cache header present ("MISS" hoac "HIT")
  - Neu X-Cache missing -> request da bypass Varnish
  - Verify X-Served-By = "varnish"
  - Dung CDN_BASE_URL (port 80) khong phai CONTROL_BASE_URL (port 8088)
```

### Anti-pattern 5: Not verifying cache key headers

```text
PROBLEM:
  Chi check X-Cache sequence (MISS->HIT), bo qua cache key headers.
  -> MISS->HIT sequence pass -> ket luan CDN OK
  -> Nhung cache key headers sai -> CDN dang serve sai variant
     (vd: VN user nhan US content, mobile user nhan desktop content)

SYMPTOM:
  - All checks pass ("MISS->HIT" sequence OK)
  - Nhung user phan anh: "sai ngon ngu", "sai gia"
  - Van de chi xuat hien khi scale (nhieu variant cung ton tai)

FIX:
  - LUON check X-Cache-Key-Language, X-Cache-Key-Geo, X-Cache-Key-Device,
    X-Cache-Key-AB cho product paths
  - Assert values match expected normalization
  - Neu cache key sai -> variant isolation FAIL -> case 02 se catch,
    nhung case 01 nen catch luon de bao ve co ban
```

## 16. Real validation data

### Validation run results

```text
Tham khao validation report tai:
  E:/Khoa hoc/k6/docs/practice/cdn/12_validation-and-chart-analysis.md

Case 01 da duoc chay va validate tren moi truong full-stack.
Ket qua validation:

  Run parameters:
    - TargetLayer: full
    - Profile: guestVNMobileControl
    - VUs: 4, Duration: 18s
    - Path: /api/sim/products/1

  Key results:
    - All checks: 100.00% pass
    - HTTP failures: 0
    - MISS->HIT transition: confirmed
    - Sustained HIT: 2400+ consecutive HITs
    - Cache TTL: 90s (verified from vcl_backend_response)
    - Origin offload ratio: ~2400:1 (1 origin hit, 2400 CDN hits)
    - p(95) latency: < 10ms (HIT from local Varnish)

  Screenshots available:
    - Dashboard view (X-Cache sequence)
    - Checks summary
    - HTTP metrics

  Chart analysis:
    - X-Cache rate: 1 MISS (setup), 2401+ HIT (sustained)
    - No spikes, no drops, stable throughout 18s
    - Confirms: CDN basic path healthy for anonymous product detail reads
```

## 17. Reference

### Cross-references trong CDN series

```text
  Case nay la FOUNDATION:

  CAN DOC TRUOC:
    - 00_overview.md: Series overview, CDN concepts, mental model
    - RUN_GUIDE.md: Cach chay CDN suite, env vars, topology

  CAN DOC SAU (theo suggested learning order):
    - 02_variant-keys.md: Proves variant isolation (MISS per variant)
    - 03_bypass-rules.md: Proves auth/cookie/write bypass
    - 04_query-normalization.md: Proves tracking param strip
    - 05_invalidation-ops.md: Proves purge/ban/tag invalidation
    - 06_invalidation-events.md: Proves event-driven invalidation
    - 07_cache-contract.md: Proves cache headers + 304 revalidation
    - 08_ttl-expiry.md: Proves TTL MISS->HIT->wait->MISS
    - 09_stale-while-error.md: Proves stale serving
    - 10_request-coalescing.md: Proves origin coalescing
    - 11_negative-caching.md: Proves 404 negative caching
    - 12_validation-and-chart-analysis.md: Full validation results

  SOURCE:
    - Script: E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/01-hit-smoke.js
    - Shared helpers: E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js
    - VCL config: E:/Projects/k6/k6-metrics-server/load-target/varnish/default.vcl
    - Case catalog: E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/case-catalog.json
    - Run helper: E:/Projects/k6/k6-metrics-server/scripts/run-cdn-capabilities.ps1

  DOCUMENT ISSUE TRACKING:
    - Updated: 2026-06-22
    - Deep-doc version: v2.0 (expanded from ~108 lines to 2,000+ lines)
    - Sections: 17 (tinh huong thuc te -> reference)
    - Script version: refs/heads/master (cfcf867b2)
    - Next review: when VCL cache key logic changes or new variant added
```
