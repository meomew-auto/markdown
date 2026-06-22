# Case 03: Bypass Rules

> **Case ID:** `cdn-03-bypass-rules`
> **Script:** `03-bypass-rules.js`
> **Layer:** CDN / Varnish
> **Proof:** Auth / Cookie / no-cache / write requests must not become `HIT`

## 1. Tinh huong thuc te

### Khong phai traffic nao cung nen duoc cache

CDN là một shared cache — một object duoc dựa vào cache sẽ duoc phức vụ lại chờ
**tat ca** nhưng request giống hết về cache key sâu này. Dieu này có nghĩa là:
Nếu một request chưa dụ liệu riêng từ (private data) bị cache, dụ liệu dở sẽ bị
**ro ri** cho nguoi khac.

```text
KHONG DUOC CACHE:
  - Authenticated user xem profile ca nhan -> chua ten, email, lich su mua hang
  - Request co session cookie -> chua gio hang, wishlist, session state
  - Client yeu cau fresh data (Cache-Control: no-cache)
  - Write operation (POST/PUT/DELETE) -> mutate du lieu

NEU CACHE NHUNG THU NAY:
  -> Authenticated user A xem profile
  -> CDN cache response chua ten + email cua user A
  -> Anonymous user B goi cung URL
  -> CDN tra ve cached response cua user A (!)
  -> User B nhin thay ten + email cua user A
  -> DATA BREACH
```

Dạy là violation nghiệm trọng về **tinh riêng tu** và **tinh toàn vẹn dụ lieu**.
Không phải là "performance issue" — dạy là **security issue**.

### Authenticated traffic: moi nguoi dung thay noi dung khac nhau

Khí một user da login (có Authorization header hoặc session Cookie), response
tu backend **phu thuoc vao danh tinh cua user do**:

```text
GET /api/sim/products/1  + Authorization: Bearer <token-cua-An>
  -> Backend tra ve: product detail + "An da mua san pham nay"
  -> Neu cache response nay -> tat ca user khac cung thay "An da mua"

GET /api/sim/products/1  + Cookie: session_id=<session-cua-Binh>
  -> Backend tra ve: product detail + personalized discount cho Binh
  -> Neu cache response nay -> tat ca user khac nhan discount cua Binh
```

Vi du thuc te tu e-commerce:

```text
Tinh huong: User VIP login, browse product detail page
  -> Backend tra ve VIP price (giam 20%) trong response
  -> CDN cache response nay vi khong co bypass rule
  -> Guest user browse cung product -> nhan VIP price (!)
  -> User mua hang voi gia VIP -> doanh thu thiet hai
  -> User VIP phat hien ra -> bao chi -> khung hoang truyen thong
```

### Cookie: khong chi la authentication

Session cookie không chỉ dành chờ "da login Hãy chưa". Cookie còn duoc dùng dễ:

```text
  - Theo doi session state (gio hang, wishlist)
  - A/B testing assignment (variant duoc gan theo cookie, khong theo header)
  - Tracking / analytics
  - CSRF token
  - Language preference override
```

Bắt kỹ request nào có Cookie header deu **co the** chưa dụ liệu riêng từ hoặc
trạng thái cả nhân. Varnish không thể biết cookie nào là "vô hại" và cookie
nao chua session — vi vay toan bo Cookie header phai trigger bypass.

### Cache-Control: no-cache — client tu choi cache

Client có thể gửi `Cache-Control: no-cache` dễ yêu cầu **fresh data** từ origin:

```text
Tinh huong:
  - Admin vua cap nhat gia san pham
  - Muon xem lai product detail de verify
  - Trinh duyet tu dong them Cache-Control: no-cache khi user bam Ctrl+Shift+R
  - Hoac front-end code explicitly set header nay khi admin preview
  - CDN PHAI bypass cache va lay fresh data tu origin
  - Neu khong bypass -> admin thay gia CU -> tuong chua update -> cap nhat lai
    -> loop vo tan
```

Note: day la `Cache-Control: no-cache` trong **request** header (tu client),
không phải trọng response header (từ origin). Response `Cache-Control: no-cache`
có Ý nghĩa khác (backend bảo "dùng cache response này").

### Write methods: mutation khong bao gio duoc cache

POST, PUT, DELETE, PATCH là nhưng HTTP method **thay dõi dụ lieu** trên server:

```text
POST /api/sim/cart/add  { product_id: 1, quantity: 1 }
  -> Backend: them san pham 1 vao gio hang cua user
  -> Response: { cart_id: 456, items: [...] }
  -> Neu CDN cache response nay:
     + Request sau cung POST /api/sim/cart/add -> CDN tra cached response
       thay vi gui len backend -> server KHONG NHAN DUOC cart add
     + Request GET cung URL -> CDN tra cached cart add response
       -> user thay gio hang "ao" khong ton tai tren server
```

Hau qua cua viec cache write method:

```text
DATA CORRUPTION SCENARIO:
  t=0:  User A POST cart/add -> CDN MISS -> backend xu ly -> CDN cache response
  t=1:  User B POST cart/add -> CDN HIT (!) -> tra cached response cua A
        -> Backend KHONG nhan duoc cart add cua B
        -> B tuong da add nhung gio hang trong
  t=2:  User C GET /api/sim/cart -> backend tra gio hang cua C
  t=3:  User A POST cart/add lan 2 -> CDN HIT (!) -> tra cached response cu
        -> Backend khong nhan duoc -> A tuong da add 2 items nhung chi co 1
  -> Du lieu gio hang bi hu, user mat don hang, doanh thu thiet hai
```

### GDPR, PCI-DSS va compliance

Không chỉ là vẫn dễ kỹ thuật, bypass cache còn là vẫn dễ **phap ly**:

```text
GDPR (General Data Protection Regulation - EU):
  Article 5(1)(f): Personal data phai duoc "processed in a manner that
  ensures appropriate security of the personal data, including protection
  against unauthorised or unlawful processing".
  -> Caching personal data WITHOUT consent -> unlawful processing
  -> CDN khong bypass authenticated content -> GDPR violation
  -> Fine: up to 4% of annual global turnover hoac 20M EUR

PCI-DSS (Payment Card Industry Data Security Standard):
  Requirement 3: Protect stored cardholder data
  Requirement 7: Restrict access to cardholder data by business need to know
  -> Neu CDN cache response chua cardholder data (cart/checkout page)
     -> unauthorized access vi bat ky ai cung co the goi URL trung cache key
  -> PCI-DSS violation -> mat kha nang xu ly thanh toan

SOC2 (Service Organization Control 2):
  Common Criteria 6.x: Logical and Physical Access Controls
  -> Phai chung minh duoc access control hoat dong dung
  -> Test bypass la EVIDENCE cho auditor

Internal security policy:
  -> "Authenticated traffic must not be cached in shared cache"
  -> Neu policy nay ton tai (va nen ton tai) -> test bypass la
     COMPLIANCE REQUIREMENT, khong phai OPTIONAL test
```

### Neu bypass rules overlap hoac xung dot

Một vẫn dễ it duoc nghĩ den: khí nhiều bypass rules cùng Kịch hoạt, có
thể gây confusion hoặc behavior không mong muốn:

```text
Vi du: request POST + Authorization + Cookie + no-cache
  -> 4 bypass rules deu kich hoat
  -> VCL thuc thi return(pass) o rule DAU TIEN match
  -> POST method check chay truoc -> return(pass)
  -> Authorization, Cookie, no-cache checks KHONG duoc thuc thi
  -> Nhung dieu nay KHONG sao — bypass la bypass

Nhung neu ai do SUA VCL va dao thu tu:
  -> Authorization check truoc, POST method check sau
  -> POST khong co Authorization -> khong match Authorization check
  -> Den method check -> return(pass)
  -> Van bypass -> van OK

TRUONG HOP NGUY HIEM:
  -> Ai do comment out POST method check (tuong Authorization
     check da bao phu)
  -> POST khong co Authorization -> khong match Authorization check
  -> KHONG match method check (da bi comment out)
  -> Request di qua hash -> POST BI CACHE
  -> DAY LA LY DO CAN TEST RIENG TUNG TRIGGER
```

### Tong ket tinh huong

```text
BOX: 4 LOAI TRAFFIC PHAI BYPASS CACHE
==============================================================
 (a) Authorization header -> nguoi dung da xac thuc
     Response phu thuoc vao identity -> khong duoc share

 (b) Cookie header -> co session state / preference
     Response co the chua du lieu rieng tu -> khong duoc share

 (c) Cache-Control: no-cache -> client yeu cau fresh data
     Client tu bo quyen duoc cache -> CDN phai ton trong

 (d) Non-GET/HEAD methods -> mutation request
     POST/PUT/DELETE thay doi du lieu -> khong duoc cache
==============================================================
```

## 2. CDN capability being proven

Case này chứng mình **4 bypass rules** hoạt dòng dốc lặp và chính xác:

```text
Rule 1: Authorization header  -> BYPASS (not HIT)
Rule 2: Cookie header         -> BYPASS (not HIT)
Rule 3: Cache-Control: no-cache (client request) -> BYPASS (not HIT)
Rule 4: POST method            -> BYPASS (not HIT)
```

Mỗi rule duoc test riêng biết — không overlap, không ambiguity:

```text
Authorization test:
  - GET /api/sim/products/1 + Authorization: Bearer <token>
  - Profile: guestVNMobileControl (anonymous profile, khong co cookie)
  - Khong co Cache-Control: no-cache
  - Chi co Authorization la trigger bypass duy nhat

Cookie test:
  - GET /api/sim/products/1 + Cookie: session_id=abc123
  - Profile: guestVNMobileControl
  - Khong co Authorization, khong co Cache-Control: no-cache
  - Chi co Cookie la trigger bypass duy nhat

Cache-Control: no-cache test:
  - GET /api/sim/products/1 + Cache-Control: no-cache
  - Profile: guestVNMobileControl
  - Khong co Authorization, khong co Cookie
  - Chi co Cache-Control: no-cache la trigger bypass duy nhat

POST test:
  - POST /api/sim/cart/add + JSON body { product_id: 1, quantity: 1 }
  - Profile: guestVNMobileControl
  - Khong co Authorization, Cookie, hoac Cache-Control: no-cache
  - Chi co POST method la trigger bypass duy nhat
```

Capability duoc chứng mình quả **2 Bước chờ mỗi bypass trigger**:

```text
Buoc 1: Goi request bypass -> assert not HIT (X-Cache != HIT)
Buoc 2: Goi lai request bypass lan 2 -> assert not HIT (still not HIT)
        -> Chung minh bypass la CONSISTENT, khong phai MISS lan dau
           roi HIT lan sau
```

Diem quán trọng: **not HIT là CORRECT BEHAVIOR** chờ bypass case. Không phải
"fail" hay "bug". Bypass la contract CDN phai giu — neu HIT thay vi bypass
thì dở mỗi là bug (security bug).

## 3. Vi sao test o CDN layer

### Quyet dinh bypass xay ra TRUOC KHI request den app

Trong architecture `client -> Varnish -> Nginx -> app`, quyet dinh bypass
duoc thực hiện **tai Varnish** trọng `vcl_recv`. Request chưa den duoc Nginx,
chưa den duoc app. Dieu này có nghĩa:

```text
Neu CDN cache sai (khong bypass):
  -> App KHONG BAO GIO BIET
  -> App nhan request, tra response binh thuong
  -> App khong the phan biet "CDN HIT" vs "CDN MISS"
  -> App khong the phat hien data leak tu CDN

Test o app layer:
  -> App chi thay "co request den" hoac "khong co request den"
  -> App KHONG BIET CDN da cache authenticated content chua
  -> App khong the assert "X-Cache != HIT" vi app khong nam giua CDN va client

Test o CDN layer (Day la noi duy nhat):
  -> k6 goi request qua CDN (public URL :80)
  -> k6 doc response header X-Cache (do Varnish set trong vcl_deliver)
  -> k6 assert X-Cache != HIT
  -> k6 assert X-Upstream-Service dung (chung minh request van den backend)
  -> Day la evidence TRUC TIEP CDN da bypass cache
```

### Ly do security & compliance

Day la **CDN-edge-only concern** vi ly do kien truc:

```text
                          [CDN quyet dinh o day]
                                |
  Client -> CDN/Varnish -> Nginx -> App -> DB
            |                                   |
            +-- BYPASS: pass request            +-- App khong biet
            |   den backend, khong              |   CDN bypass
            |   cache response                  |   hay khong
            |
            +-- KHONG BYPASS: cache
            |   authenticated response
            |   -> DATA BREACH
            |   -> App khong he biet
```

Viec test bypass tai CDN layer con lien quan den **compliance**:

```text
  - PCI-DSS: khong duoc cache cardholder data
  - GDPR: khong duoc cache personal data cua EU citizens
  - SOC2: phai chung minh duoc access control hoat dong dung
  - Internal security policy: authenticated content phai private

  Test o CDN layer la evidence cho auditor rang:
    "Chung toi da kiem tra — cache khong luu authenticated content"
```

### Neu khong test o CDN layer

```text
Neu chi test functional o app layer:
  -> Test pass: user A login -> xem profile -> 200 OK
  -> Test pass: user B anonymous -> xem profile -> 401 (vi app check auth)
  -> Nhung CDN da cache profile cua user A (!)
  -> User C cung goi GET /api/profile (trung cache key)
  -> CDN tra cached profile cua user A (200 OK + ten cua A)
  -> User C khong bi trinh duyet tu dong gui Authorization
     Nhung CDN da cache VA TRA VE response co Authorization
  -> App khong he biet vi request chua den app
  -> Test app-layer: PASS. Thuc te: DATA BREACH.
```

## 4. Topology & precondition

### Runtime topology

```text
TargetLayer = full

  k6 (test runner)
    |
    +--> http://localhost:80  (public CDN URL, qua Varnish)
    |       |
    |       v
    |    Varnish CDN (vcl_recv: bypass decision HERE)
    |       |
    |       +--> BYPASS (pass): -> Nginx -> app/microservices
    |       |                      response tra ve nhung KHONG cache
    |       |
    |       +--> CACHE (hash):  -> Nginx -> app -> cache response
    |
    +--> http://localhost:8088  (control path, khong dung case nay)
    +--> http://localhost:9091  (catalog events, khong dung case nay)
```

### Precondition

Case này **khong can** purge/ban trước khí chạy. Lý dở:

```text
  - Neu CDN hoat dong dung: moi request bypass se tu dong NOT HIT
    Khong can dam bao cache trong hay rong — bypass luon luon not HIT
  - Neu CDN hoat dong sai (da cache authenticated content tu truoc):
    Test van FAIL — Dieu nay la DUNG (phat hien bug ton dong)
```

Tuy nhien, de chung minh bypass rules hoat dong **doc lap** voi cache state,
case này duoc thiết kế dễ **khong phụ thuộc vào cache warmup**. Không có Bước
"warm cache" trọng script. Mỗi bypass duoc test trực tiếp.

### Environment variables

```text
BASE_URL               = http://localhost:80
CONTROL_BASE_URL       = http://localhost:8088
CATALOG_EVENTS_BASE_URL = http://localhost:9091
OPS_AUTH_TOKEN         = <ops-token>  (khong dung trong case nay)
```

## 5. Script deep-dive

### Source

```text
E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/03-bypass-rules.js
```

### Import va options

```javascript
import {
  cacheKeyHeaders, paths, profiles,
  requestCdn, assertHeadersAbsent,
  assertNotHit, assertStatus, assertUpstream
} from './shared.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],  // 100% checks phai pass
  },
  tags: {
    scenario: 'cdn_bypass_rules',
  },
};
```

Một chỉ tiết thiết kế quán trọng: `vus: 1, iterations: 1`. Dạy là **single-run
validation**, không phải load test. Một VU, một iteration chưa tất cả các
bypass checks ben trong default function.

### Helper: exerciseRepeatedBypass

Dạy là trợ lý chính của case, dòng gọi toàn bộ logic test chờ một bypass trigger:

```javascript
function exerciseRepeatedBypass(label, requestOptions) {
  // Request lan 1
  const first = requestCdn(requestOptions.method || 'GET', requestOptions.path, {
    profile: requestOptions.profile || null,
    headers: requestOptions.headers || {},
    body: requestOptions.body || null,
    tags: { case: `${label}_first` },
  });
  assertStatus(first, requestOptions.expectedStatus || 200, `${label} first`);
  if (requestOptions.upstream) {
    assertUpstream(first, requestOptions.upstream, `${label} first`);
  }
  assertNotHit(first, `${label} first`);
  if (requestOptions.expectNoCacheKeyHeaders !== false) {
    assertHeadersAbsent(first, cacheKeyHeaders, `${label} first`);
  }

  // Request lan 2 (identical)
  const second = requestCdn(requestOptions.method || 'GET', requestOptions.path, {
    profile: requestOptions.profile || null,
    headers: requestOptions.headers || {},
    body: requestOptions.body || null,
    tags: { case: `${label}_second` },
  });
  assertStatus(second, requestOptions.expectedStatus || 200, `${label} second`);
  if (requestOptions.upstream) {
    assertUpstream(second, requestOptions.upstream, `${label} second`);
  }
  assertNotHit(second, `${label} second`);
  if (requestOptions.expectNoCacheKeyHeaders !== false) {
    assertHeadersAbsent(second, cacheKeyHeaders, `${label} second`);
  }
}
```

### Vi sao goi 2 lan?

Dạy là một chỉ tiết thiết kế quán trọng:

```text
Lan 1 (first):
  -> Neu CDN khong bypass: response co the la MISS (chua co trong cache)
  -> assertNotHit: kiem tra X-Cache != HIT  (MISS duoc chap nhan)
  -> Nhung MISS lan dau la AMBIGUOUS: co the la "chua warm" hoac "bypass dung"

Lan 2 (second):
  -> Neu CDN da "vo tinh" cache response lan 1 -> lan 2 se HIT
  -> assertNotHit lan 2: kiem tra X-Cache != HIT
  -> Neu lan 2 van NOT HIT -> bypass that su hoat dong
  -> Neu lan 2 HIT -> bypass KHONG hoat dong -> bug

Viec goi 2 lan ELIMINATE AMBIGUITY:
  - MISS + MISS: bypass hoat dong (khong cache response lan 1)
  - MISS + HIT:  bypass KHONG hoat dong (da cache response lan 1)
```

### 4 bypass triggers trong default function

```javascript
export default function () {
  // Trigger 1: Authorization header
  exerciseRepeatedBypass('authorization_header', {
    path: paths.productDetail,           // /api/sim/products/1
    profile: profiles.guestVNMobileControl,
    headers: { Authorization: 'Bearer session-user-token' },
    upstream: 'products-service',
  });

  // Trigger 2: Cookie header
  exerciseRepeatedBypass('cookie_header', {
    path: paths.productDetail,
    profile: profiles.guestVNMobileControl,
    headers: { Cookie: 'session_id=abc123' },
    upstream: 'products-service',
  });

  // Trigger 3: Cache-Control: no-cache
  exerciseRepeatedBypass('cache_control_no_cache', {
    path: paths.productDetail,
    profile: profiles.guestVNMobileControl,
    headers: { 'Cache-Control': 'no-cache' },
    upstream: 'products-service',
  });

  // Trigger 4: POST method (write operation)
  exerciseRepeatedBypass('write_method_post', {
    method: 'POST',
    path: '/api/sim/cart/add',
    body: { product_id: 1, quantity: 1 },
    upstream: 'cart-service',
    expectNoCacheKeyHeaders: false,  // Bo qua check cache key headers
  });
}
```

### Phan tich profile guestVNMobileControl

Profile duoc dùng chờ **tat ca** 4 bypass triggers:

```javascript
profiles.guestVNMobileControl = {
  name: 'guest_vn_mobile_control',
  headers: {
    'Accept-Language': 'vi',
    'X-Geo-Country': 'VN',
    'X-Device-Class': 'mobile',
    'X-Ab-Variant': 'control',
    'X-User-Segment': 'guest',
  },
};
```

Profile này là **anonymous guest user** — không có auth, không có cookie. Dieu
này quán trọng Vì Nó dam bảo chỉ có **mot** bypass trigger duoc Kịch hoạt trọng
moi test case:

```text
Authorization test:
  profile headers + Authorization: Bearer token -> CHI Authorization la trigger

Cookie test:
  profile headers + Cookie: session_id=abc123 -> CHI Cookie la trigger

Cache-Control test:
  profile headers + Cache-Control: no-cache -> CHI no-cache la trigger

POST test:
  profile headers + POST method -> CHI POST method la trigger
```

### Phan tich assertNotHit

```javascript
export function assertNotHit(res, label) {
  check(res, {
    [`${label} not hit`]: (r) => cacheState(r) !== 'HIT',
  });
}

export function cacheState(res) {
  return String(getHeader(res, 'X-Cache') || '').trim().toUpperCase();
}
```

`cacheState` doc header `X-Cache` tu response. Varnish set `X-Cache: HIT` khi
phức vụ từ cache, và `X-Cache: MISS` khí phải gọi backend. `assertNotHit` kiểm
trả rằng `X-Cache` **khong phai** là `HIT`. Dieu này chấp nhân cả `MISS` và
bắt kỹ giá trị nào khác (VD: response từ `return(pass)` có thể không có
`X-Cache` header dở Varnish không set trọng `vcl_deliver`).

Wait — dạy là một diem quán trọng về Varnish behavior. Cùng phân tích kỹ hơn.

### Phan tich assertHeadersAbsent

```javascript
export const cacheKeyHeaders = [
  'X-Cache-Key-Language',
  'X-Cache-Key-Geo',
  'X-Cache-Key-Device',
  'X-Cache-Key-AB',
  'X-Cache-Key-Segment',
];

export function assertHeadersAbsent(res, headerNames, label) {
  const expectations = {};
  for (const header of headerNames) {
    expectations[`${label} ${header} absent`] = (r) => !getHeader(r, header);
  }
  check(res, expectations);
}
```

Dõi với GET bypass (Authorization, Cookie, no-cache): cache key headers duoc
kiểm trả là **absent**. Lý dở: khí Varnish `return(pass)`, response không dĩ
quả `vcl_deliver` theo Cách thống thường — `X-Cache-*` headers không duoc set.

Doi voi POST: `expectNoCacheKeyHeaders: false` -> bo qua check nay. Ly do:
POST dĩ den `/api/sim/cart/add` (không phải products path), và backend có thể
vẫn include `X-Cache-*` response headers như là convention across services.
Check absent không ap dùng chờ endpoint khác.

### Phan tich assertUpstream

```javascript
export function assertUpstream(res, upstream, label) {
  check(res, {
    [`${label} upstream ${upstream}`]: (r) =>
      getHeader(r, 'X-Upstream-Service') === upstream,
  });
}
```

Assert này chứng mình rằng **mac dụ bypass, request vẫn den backend dung**:

```text
  - Authorization + product detail -> van den products-service
  - Cookie + product detail -> van den products-service
  - no-cache + product detail -> van den products-service
  - POST cart/add -> van den cart-service

  Neu X-Upstream-Service sai -> routing bi hu (khong phai bypass bug)
  Nhung van la FAIL -> can fix routing
```

## 6. VCL bypass logic deep-dive

### VCL la gi va tai sao can hieu?

VCL (Varnish Configuration Language) la ngon ngu cau hinh state machine cua
Varnish. Khí một request den, Nó dĩ quả các subroutine theo thứ từ:

```text
vcl_recv (receive request)
  |
  +--> return(pass)   -> bypass cache, goi backend, khong cache response
  +--> return(pipe)   -> bypass hoan toan, raw TCP tunnel (WebSocket...)
  +--> return(hash)   -> lookup cache theo hash key
  +--> return(purge)  -> xoa object khoi cache
  +--> return(synth)  -> tra response tu Varnish (khong goi backend)

vcl_hash (compute hash key)
  |
  +--> tinh toan cache key tu URL + variant headers

vcl_hit (cache hit)
  |
  +--> return(deliver)  -> tra object tu cache
  +--> return(pass)     -> object expired, goi backend

vcl_miss (cache miss)
  |
  +--> return(fetch)    -> goi backend de lay object

vcl_backend_response (backend tra response)
  |
  +--> quyet dinh co cache response nay khong

vcl_deliver (deliver response to client)
  |
  +--> set response headers (X-Cache, X-Cache-Key-*, ...)
```

### return(pass) — co che bypass cache

`return(pass)` la action quan trong nhat trong case nay. Khi Varnish gap
`return(pass)` trong `vcl_recv`:

```text
1. Varnish KHONG lookup cache
   -> Khong goi vcl_hash de tinh cache key
   -> Khong kiem tra xem object co trong cache khong

2. Varnish goi backend TRUC TIEP
   -> Mo ket noi den backend (Nginx -> app)
   -> Forward request nguyen ban den backend
   -> Nhan response tu backend

3. Varnish KHONG cache response
   -> Response duoc deliver thang den client
   -> KHONG duoc dua vao cache storage
   -> KHONG update bat ky cached object nao

4. Response van di qua vcl_deliver
   -> Nhung obj.hits = 0 (khong phai HIT cung khong phai MISS theo nghia cache)
   -> X-Cache duoc set la "MISS" (trong vcl_deliver: obj.hits > 0 -> HIT, else -> MISS)
```

**Luu y ve X-Cache khi pass**:

```text
Trong vcl_deliver:
  if (obj.hits > 0) {
      set resp.http.X-Cache = "HIT";
  } else {
      set resp.http.X-Cache = "MISS";
  }

Khi return(pass), obj.hits = 0 -> X-Cache = "MISS".
Nhung day la MISS "gia" — no khong co nghia la "backend tra response va
response duoc cache". No chi co nghia la "khong phai HIT".

assertNotHit kiem tra X-Cache != "HIT" -> MISS duoc chap nhan -> pass qua check.
```

### return(pass) vs return(pipe)

```text
BOX: pass vs pipe
==============================================================
 return(pass):
   - Varnish xu ly request/response nhu HTTP proxy thong minh
   - Backend response di qua vcl_backend_response
   - Response headers duoc xu ly (Set-Cookie, Cache-Control...)
   - Client response di qua vcl_deliver
   - Dung cho: auth request, cookie request, no-cache request

 return(pipe):
   - Varnish chi forward raw TCP bytes giua client va backend
   - KHONG xu ly HTTP
   - KHONG di qua vcl_backend_response
   - KHONG di qua vcl_deliver
   - Dung cho: WebSocket, SSE, CONNECT tunnel, upload file lon
   - NGUY HIEM neu dung cho authenticated request:
     -> Khong the set X-Cache, X-Upstream-Service headers
     -> Test helper khong the assert gi ca
==============================================================
```

Trọng case này, bypass rules dùng `return(pass)`, không phải `return(pipe)`.
Dạy là thiết kế dùng — `pass` vẫn chờ phép Varnish set response headers dễ
test có thể vềrify upstream routing.

### VCL bypass rules — source code

```vcl
sub vcl_recv {
    unset req.http.X-Cache-Stale;

    # ... PURGE/BAN handling (case 05/06) ...

    # RULE 4: Cache only safe methods
    if (req.method != "GET" && req.method != "HEAD") {
        return (pass);
    }

    # Unrelated bypass: health/metrics/nginx-status URLs
    if (req.url ~ "^/(health|metrics|nginx-status)") {
        return (pass);
    }
    if (req.url ~ "^/ops/") {
        return (pass);
    }

    # Unrelated bypass: nocache/cache_bust query params
    if (req.url ~ "[?&]_nocache=" || req.url ~ "[?&]cache_bust=") {
        return (pass);
    }

    # RULE 3: Cache-Control: no-cache from client
    if (req.http.Cache-Control ~ "(?i)no-cache") {
        return (pass);
    }

    # RULE 1 & 2: Authorization OR Cookie header
    if (req.http.Authorization || req.http.Cookie) {
        return (pass);
    }

    # Additional: product pages with explicit user token headers
    if (req.url ~ "^/api/sim/products($|\\?)"
        && (req.http.X-User-Token || req.http.X-User-ID || req.http.X-Api-Key)) {
        return (pass);
    }

    # ... tracking param cleanup, query sort ...
    # ... hash routing for cacheable paths ...
    # ... fallback pass for everything else ...
}
```

### Thu tu thuc thi VCL

Thứ từ các rule trọng VCL là **quan trong** Vì Varnish thực thì `vcl_recv` từ
trên xuống dưới, và **return ngày lặp tuc** khí gặp `return()` dấu tiên:

```text
Thu tu thuc te trong vcl_recv:

  (1) Non-GET/HEAD methods           -> return(pass)  [DUNG]
      Neu la POST/PUT/DELETE -> bypass NGAY, khong check cac rule sau
      -> POST request se KHONG BI ANH HUONG boi Authorization/Cookie check

  (2) Health/metrics/nginx-status    -> return(pass)
      Internal monitoring URLs

  (3) /ops/ paths                     -> return(pass)
      Control plane URLs

  (4) _nocache= / cache_bust= params -> return(pass)
      Debug/force-refresh params

  (5) Cache-Control: no-cache        -> return(pass)
      Client request header check

  (6) Authorization OR Cookie         -> return(pass)
      Auth + session check

  (7) Products + user token headers  -> return(pass)
      Additional app-level user context

  (8) Cacheable paths                -> return(hash)
      Chi nhung request "sach" moi den duoc day
```

### Vi sao POST duoc check truoc Authorization/Cookie?

```text
Neu thu tu nguoc lai:
  if (req.http.Authorization || req.http.Cookie) { return(pass); }
  if (req.method != "GET" && req.method != "HEAD") { return(pass); }

  -> POST /api/sim/cart/add + Cookie: session_id=abc123
  -> Bi bat boi Authorization/Cookie check truoc -> return(pass)
  -> Van bypass -> van OK ve mat behavior

Nhung neu POST KHONG co Cookie:
  -> Phai den method check moi bypass
  -> Cung van OK

Vay tai sao de method check truoc?
  -> Optimization: method check la string comparison don gian
  -> Authorization/Cookie check can regex hoac string matching
  -> Method check re hon -> dat truoc de nhanh hon
  -> Ngoai ra, POST request thuong KHONG co Authorization hoac Cookie
     trong cache-key context -> dat method truoc la toi uu
```

### What happens to the response when return(pass) is used

Khí `return(pass)` duoc gọi, response journey quả Varnish khác với hash/miss/hit:

```text
HASH -> MISS flow:
  vcl_recv -> vcl_hash -> vcl_miss -> fetch to backend
  -> vcl_backend_response (quyet dinh cache/khong cache)
  -> vcl_deliver (set X-Cache = "MISS")
  -> Object duoc dua vao cache storage

HASH -> HIT flow:
  vcl_recv -> vcl_hash -> vcl_hit -> vcl_deliver (set X-Cache = "HIT")
  -> Object da co san trong cache

PASS flow:
  vcl_recv -> return(pass) -> fetch to backend TRUC TIEP
  -> vcl_backend_response (VAN duoc goi!)
  -> vcl_deliver (set X-Cache = "MISS")
  -> Object KHONG duoc dua vao cache storage
  -> Nhung backend response VAN duoc xu ly boi vcl_backend_response
```

Dieu quán trọng: `vcl_backend_response` vẫn chạy khí pass. Dieu này có nghĩa:

```text
Neu backend response co Set-Cookie:
  -> vcl_backend_response: if (beresp.http.Set-Cookie) { uncacheable }
  -> Nhung do la pass -> da khong cache san -> khong anh huong

Neu backend response co Cache-Control: no-store/private:
  -> vcl_backend_response: if (beresp.http.Cache-Control ~ "no-store|private")
     { uncacheable }
  -> Cung khong anh huong vi pass da khong cache

Day la DOUBLE PROTECTION:
  Layer 1: vcl_recv return(pass) -> khong cache request nay
  Layer 2: vcl_backend_response check Set-Cookie/private -> khong cache
           response nay (neu vi ly do nao do pass khong duoc goi)
```

### Cach doc X-Cache header khi bypass

Trong VCL hien tai, `vcl_deliver` set `X-Cache` dua tren `obj.hits`:

```vcl
sub vcl_deliver {
    if (obj.hits > 0) {
        set resp.http.X-Cache = "HIT";
    } else {
        set resp.http.X-Cache = "MISS";
    }
}
```

Với `return(pass)`, `obj.hits = 0` (không lookup cache) -> `X-Cache = "MISS"`.

Dạy là Cách set `X-Cache` chú dòng dễ k6 có thể vềrify. Trọng một số Varnish
configuration phổ biến, `X-Cache` khí pass có thể không duoc set (Nếu `vcl_deliver`
chi set `X-Cache` trong truong hop `obj.hits > 0`). Trong truong hop do,
`assertNotHit` vẫn hoạt dòng dùng Vì `cacheState()` trả `""` khí không có
`X-Cache` header, và `"" !== "HIT"` -> PASS.

### Toan bo VCL bypass logic — annotated complete view

Day la toan bo bypass logic trong `vcl_recv` voi annotation ve muc dich:

```vcl
sub vcl_recv {
    unset req.http.X-Cache-Stale;

    // ... PURGE/BAN handling ...

    // [BYPASS-4] Cache chi ap dung cho safe methods
    //            Non-GET/HEAD = mutation -> khong duoc cache
    if (req.method != "GET" && req.method != "HEAD") {
        return (pass);
    }

    // [UNRELATED BYPASS] Health check URLs
    //                    Khong can cache monitoring traffic
    if (req.url ~ "^/(health|metrics|nginx-status)") {
        return (pass);
    }

    // [UNRELATED BYPASS] Control plane URLs
    //                    Ops API khong duoc cache
    if (req.url ~ "^/ops/") {
        return (pass);
    }

    // [UNRELATED BYPASS] Debug/force-refresh query params
    //                    Cho phep developer bypass cache de debug
    if (req.url ~ "[?&]_nocache=" || req.url ~ "[?&]cache_bust=") {
        return (pass);
    }

    // [BYPASS-3] Cache-Control: no-cache tu client
    //            Client explicitly requests fresh content
    if (req.http.Cache-Control ~ "(?i)no-cache") {
        return (pass);
    }

    // [BYPASS-1 + BYPASS-2] Authorization OR Cookie header
    //                        Authenticated hoac co session -> bypass
    //                        OR logic: chi can 1 trong 2
    if (req.http.Authorization || req.http.Cookie) {
        return (pass);
    }

    // [ADDITIONAL BYPASS] Product API + user token/ID/API key
    //                     User context nhung qua custom header
    if (req.url ~ "^/api/sim/products($|\\?)"
        && (req.http.X-User-Token || req.http.X-User-ID
            || req.http.X-Api-Key)) {
        return (pass);
    }

    // ... tracking param cleanup ...
    // ... query sort ...
    // ... hash routing for /api/cached ...
    // ... hash routing for /api/sim/products ...
    // ... fallback return(pass) ...
}
```

Dạy là **defense-in-depth** chờ CDN cache security. Nhiều lớp bypass rules bảo
về các scenario khác nhau, dam bảo không có private/write traffic nào bị cache.

## 7. Request sequence flow

### Flow 1: Authorization header bypass

```text
STEP 1: k6 sends request lan 1
  GET /api/sim/products/1 HTTP/1.1
  Host: localhost:80
  Accept: application/json
  Accept-Language: vi
  X-Geo-Country: VN
  X-Device-Class: mobile
  X-Ab-Variant: control
  X-User-Segment: guest
  Authorization: Bearer session-user-token
  => NO Cookie
  => NO Cache-Control: no-cache

STEP 2: Varnish receives request
  vcl_recv executes:
    -> req.method = "GET" -> khong match rule (1)
    -> req.url = "/api/sim/products/1" -> khong match health/ops rule
    -> khong co _nocache/cache_bust params
    -> khong co Cache-Control: no-cache -> khong match rule (3)
    -> req.http.Authorization = "Bearer session-user-token" -> MATCH rule (4)
    -> return(pass)

STEP 3: Varnish bypasses cache
  -> Goes straight to backend (Nginx -> products-service)
  -> Backend processes request, returns 200 OK with product data
  -> Varnish delivers response WITHOUT caching it
  -> X-Cache = "MISS" (obj.hits = 0)
  -> X-Upstream-Service = "products-service"

STEP 4: k6 assertions on response #1
  assertStatus: 200 -> PASS
  assertUpstream: "products-service" -> PASS
  assertNotHit: X-Cache = "MISS" (not "HIT") -> PASS
  assertHeadersAbsent: X-Cache-Key-* not present -> PASS

STEP 5: k6 sends request lan 2 (identical to step 1)

STEP 6: Varnish receives request
  vcl_recv executes same flow -> return(pass) again

STEP 7: k6 assertions on response #2
  assertStatus: 200 -> PASS
  assertUpstream: "products-service" -> PASS
  assertNotHit: X-Cache = "MISS" (not "HIT") -> PASS
  -> Van not HIT -> bypass CONSISTENT
```

### Flow 2: Cookie header bypass

```text
STEP 1: k6 sends request
  GET /api/sim/products/1 HTTP/1.1
  Host: localhost:80
  ... (profile headers) ...
  Cookie: session_id=abc123
  => NO Authorization
  => NO Cache-Control: no-cache

STEP 2: Varnish vcl_recv
  -> req.method = "GET" -> ok
  -> khong co Authorization -> khong match Authorization
  -> req.http.Cookie = "session_id=abc123" -> MATCH
  -> return(pass)

Note: Authorization || Cookie — chi can MOT trong hai la du.
      Day la OR logic, khong phai AND.
```

### Flow 3: Cache-Control: no-cache bypass

```text
STEP 1: k6 sends request
  GET /api/sim/products/1 HTTP/1.1
  Host: localhost:80
  ... (profile headers) ...
  Cache-Control: no-cache
  => NO Authorization
  => NO Cookie

STEP 2: Varnish vcl_recv
  -> req.http.Cache-Control ~ "(?i)no-cache" -> MATCH
  -> return(pass)

Luu y: regex "(?i)" = case-insensitive
  -> "no-cache", "No-Cache", "NO-CACHE" deu match
```

### Flow 4: POST method bypass

```text
STEP 1: k6 sends request
  POST /api/sim/cart/add HTTP/1.1
  Host: localhost:80
  Content-Type: application/json
  ... (profile headers) ...
  Body: {"product_id":1,"quantity":1}
  => NO Authorization
  => NO Cookie
  => NO Cache-Control: no-cache

STEP 2: Varnish vcl_recv
  -> req.method = "POST" -> req.method != "GET" = true
  -> return(pass) NGAY LAP TUC (rule 1 trong vcl_recv)

STEP 3: Varnish bypasses cache
  -> Pass through to backend (Nginx -> cart-service)
  -> Backend adds item to cart, returns 200 OK
  -> Varnish delivers WITHOUT caching
  -> X-Cache = "MISS"
  -> X-Upstream-Service = "cart-service"

STEP 4: k6 assertions on response
  assertStatus: 200 -> PASS
  assertUpstream: "cart-service" -> PASS (khac voi products-service)
  assertNotHit: X-Cache != "HIT" -> PASS
  assertHeadersAbsent: SKIPPED (expectNoCacheKeyHeaders = false)
```

### Tong ket flow

```text
BOX: 4 BYPASS FLOWS — TAT CA DEU DUNG return(pass)
==============================================================
 Authorization -> GET /api/sim/products/1 + Bearer token
                  upstream: products-service, not HIT

 Cookie        -> GET /api/sim/products/1 + session cookie
                  upstream: products-service, not HIT

 no-cache      -> GET /api/sim/products/1 + Cache-Control: no-cache
                  upstream: products-service, not HIT

 POST          -> POST /api/sim/cart/add + body
                  upstream: cart-service, not HIT

 Moi flow: goi 2 lan -> ca 2 lan deu not HIT -> CONSISTENT bypass
==============================================================
```

## 8. Key signals/headers

### Signals can doc de verify

```text
X-Cache              = "MISS" (not "HIT")
                       Day la signal QUAN TRONG NHAT.
                       Neu = "HIT" -> test FAIL.
                       Neu = "MISS" -> bypass hoat dong.

X-Upstream-Service   = "products-service" hoac "cart-service"
                       Chung minh request da den backend DUNG.
                       Bypass khong co nghia la "mat request" —
                       bypass la "den backend nhung khong cache".

HTTP Status          = 200
                       Bypass la hanh vi DUNG, khong phai error.
                       Status 200 la expected.

X-Cache-Key-*        = absent (cho GET bypass)
  - X-Cache-Key-Language
  - X-Cache-Key-Geo
  - X-Cache-Key-Device
  - X-Cache-Key-AB
  - X-Cache-Key-Segment
                       Khi bypass, Varnish khong tao cache key.
                       Cache key headers absent la them mot evidence
                       rang object khong duoc dua vao cache.
```

### Signals KHONG nen co

```text
X-Cache              = "HIT"  <-- DAY LA BUG
                       Neu bat ky bypass request nao tra HIT,
                       CDN da cache private data.

Set-Cookie           = bat ky gia tri nao
                       Neu backend tra Set-Cookie cho bypass request,
                       Varnish da duoc cau hinh de khong cache
                       (vcl_backend_response: if beresp.http.Set-Cookie
                        -> uncacheable). Nhung bypass van van hoat dong.

Surrogate-Key        = co the co hoac khong
                       Khong quan trong cho bypass case.
```

## 9. Pass/fail criteria

### PASS khi

```text
(1) k6 exits 0
    -> Tat ca checks deu pass

(2) Authorization bypass: 2 lan not HIT, upstream products-service
    -> Check: "authorization_header first not hit" = PASS
    -> Check: "authorization_header second not hit" = PASS

(3) Cookie bypass: 2 lan not HIT, upstream products-service
    -> Check: "cookie_header first not hit" = PASS
    -> Check: "cookie_header second not hit" = PASS

(4) Cache-Control: no-cache bypass: 2 lan not HIT, upstream products-service
    -> Check: "cache_control_no_cache first not hit" = PASS
    -> Check: "cache_control_no_cache second not hit" = PASS

(5) POST method bypass: 2 lan not HIT, upstream cart-service
    -> Check: "write_method_post first not hit" = PASS
    -> Check: "write_method_post second not hit" = PASS

(6) Tat ca cac checks con lai deu pass
    -> assertStatus, assertUpstream, assertHeadersAbsent
    -> thresholds: checks rate = 1 (100%)
```

### FAIL khi

```text
(1) Authorization request tra HIT
    -> VCL khong check Authorization header
    -> Hoac Authorization check dat SAI vi tri (sau hash)
    -> Hoac regex khong match
    -> HAU QUA: Authenticated content bi cache va serve lai
       cho anonymous user -> DATA BREACH

(2) Cookie request tra HIT
    -> VCL khong check Cookie header
    -> Hoac Cookie check bi vo hieu hoa
    -> HAU QUA: Session state bi cache -> user A thay
       gio hang cua user B -> SESSION POLLUTION

(3) Cache-Control: no-cache request tra HIT
    -> VCL khong check Cache-Control request header
    -> Hoac check sai vi tri ("(?i)no-cache" regex khong match)
    -> HAU QUA: Admin khong thay duoc fresh data, user
       luon bi serve stale content khi ho explicitly yeu cau fresh

(4) POST request tra HIT
    -> VCL khong check method != "GET" && method != "HEAD"
    -> Hoac method check dat sau hash -> khong bao gio duoc chay
    -> HAU QUA: Write operation bi "cache replay" -> data corruption

(5) X-Upstream-Service sai
    -> Bypass van hoat dong nhung routing bi hu
    -> Request den sai service -> sai response
    -> FAIL: can fix upstream routing

(6) Status khong phai 200
    -> Bypass hoat dong nhung backend tra error
    -> Co the la backend van de, khong phai CDN bypass issue
    -> Nhung van FAIL — can investigate

(7) Checks rate < 1
    -> Mot so checks khong pass -> script khong pass threshold
```

### Vi sao "not HIT" la pass chu khong phai "MISS"?

```text
assertNotHit kiem tra X-Cache != "HIT"
Khong kiem tra X-Cache == "MISS" cu the

Ly do:
  - return(pass) co the khong set X-Cache header trong mot so
    Varnish configuration (tuy thuoc vcl_deliver)
  - Neu X-Cache absent -> cacheState() tra "" -> "" !== "HIT" -> PASS
  - Neu X-Cache = "MISS" -> "MISS" !== "HIT" -> PASS
  - Chi FAIL khi X-Cache = "HIT"

Day la thiet ke DUNG: chi can chung minh response KHONG den tu cache.
Khong can phan biet giua "MISS do bypass" vs "MISS do chua warm".
```

## 10. Cach chay + output

### Cach chay

```powershell
cd E:/Projects/k6/k6-metrics-server

$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

./scripts/run-cdn-capabilities.ps1 -Scenarios 03-bypass-rules
```

Hoac chay truc tiep bang k6:

```powershell
k6 run `
  -e BASE_URL=http://localhost:80 `
  -e CONTROL_BASE_URL=http://localhost:8088 `
  -e CATALOG_EVENTS_BASE_URL=http://localhost:9091 `
  -e OPS_AUTH_TOKEN=<ops-token> `
  E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/03-bypass-rules.js
```

### Yeu cau runtime

```text
  TargetLayer = full (Varnish + Nginx + app deu phai running)
  BASE_URL = http://localhost:80 (di qua Varnish CDN)
  Khong can CONTROL_BASE_URL/CATALOG_EVENTS_BASE_URL (case nay khong dung)
  Nhung environment variables van nen duoc set de tranh error
```

### Output thanh cong

```text
     ✓ authorization_header first not hit
     ✓ authorization_header second not hit
     ✓ cookie_header first not hit
     ✓ cookie_header second not hit
     ✓ cache_control_no_cache first not hit
     ✓ cache_control_no_cache second not hit
     ✓ write_method_post first not hit
     ✓ write_method_post second not hit
     ✓ authorization_header first upstream products-service
     ✓ authorization_header second upstream products-service
     ✓ cookie_header first upstream products-service
     ✓ cookie_header second upstream products-service
     ✓ cache_control_no_cache first upstream products-service
     ✓ cache_control_no_cache second upstream products-service
     ✓ write_method_post first upstream cart-service
     ✓ write_method_post second upstream cart-service
     ...

     checks.........................: 100.00% ✓ 28       ✗ 0
```

### Output that bai (Authorization bi cache)

```text
     ✗ authorization_header first not hit
       ↳ 98% — expected false, got true
     ✗ authorization_header second not hit
       ↳ 98% — expected false, got true

     X-Cache = "HIT" -> Varnish da cache authenticated response
     -> Can kiem tra VCL: if (req.http.Authorization) { return(pass); }
```

### Output that bai (POST HIT)

```text
     ✗ write_method_post first not hit
       ↳ 98% — expected false, got true
     ✗ write_method_post second not hit
       ↳ 98% — expected false, got true

     POST request tra HIT -> POST bi cache
     -> Can kiem tra VCL: if (req.method != "GET" && req.method != "HEAD")
     -> Co the rule bi comment out, hoac bi dat sau return(hash)
```

## 11. 4 output -> decision scenarios

### Scenario 1: Authenticated content cached and served to anonymous user

```text
OUTPUT:
  ✗ authorization_header first not hit
    X-Cache = "HIT"

ROOT CAUSE:
  VCL thieu bypass rule cho Authorization header.
  Hoac rule co nhung bi dat SAI vi tri (sau return(hash)).

IMPACT: CRITICAL SECURITY BUG
  -> CDN cache authenticated response cua user A
  -> Anonymous user B goi cung URL -> CDN tra HIT
  -> User B thay du lieu rieng tu cua user A
  -> DAY LA DATA BREACH

DECISION:
  1. Kiem tra VCL: co dong "if (req.http.Authorization) { return(pass); }"?
  2. Kiem tra vi tri: rule co nam TRUOC return(hash) khong?
     -> Neu nam sau -> rule khong bao gio duoc thuc thi
  3. Kiem tra regex: co dung "req.http.Authorization" khong?
     -> "req.http.Authorization" (present/truthy check)
     -> KHONG PHAI "req.http.Authorization ~ ..." (regex match)
     -> Trong VCL, string rong la falsy -> chi can check existence
  4. Kiem tra co rule nao vo tinh overwrite Authorization header khong?
     -> VD: unset req.http.Authorization truoc khi check
  5. Deploy fix -> rerun 03-bypass-rules -> verify PASS
  6. Rotate all cached objects vi chua biet bao nhieu authenticated
     content da bi cache -> purge/ban prefix
  7. Security incident review: kiem tra access logs de xac dinh
     co unauthorized access da xay ra khong
```

### Scenario 2: Cookie bypass not working — session pollution

```text
OUTPUT:
  ✗ cookie_header first not hit
    X-Cache = "HIT"

ROOT CAUSE:
  VCL thieu bypass rule cho Cookie header.
  Hoac rule khong duoc apply cho endpoint duoc test.

IMPACT: SESSION POLLUTION
  -> User A browse product voi session cookie -> CDN cache
  -> User B browse cung product -> nhan response cua user A
  -> Response co the chua personalized content (discount, wishlist)
  -> Neu response chua session-specific data -> PRIVACY BREACH

DECISION:
  1. Kiem tra VCL: "if (req.http.Cookie) { return(pass); }"?
  2. Kiem tra: Authorization va Cookie duoc check CUNG MOT DONG?
     -> "if (req.http.Authorization || req.http.Cookie) { return(pass); }"
     -> Neu chi check Authorization -> Cookie se HIT
  3. Kiem tra: co VCL nao unset Cookie header truoc khi check khong?
     -> VD: "unset req.http.Cookie" (lam sach Cookie cho hash)
     -> Neu unset truoc check -> check khong bao gio match
  4. Neu co unset Cookie: di chuyen unset XUONG DUOI bypass check
  5. Deploy fix -> rerun -> verify PASS
  6. Purge all cached objects
```

### Scenario 3: POST cached and replayed

```text
OUTPUT:
  ✗ write_method_post first not hit
    X-Cache = "HIT"

  ✗ write_method_post first upstream cart-service
    X-Upstream-Service = "" (absent) hoac sai

ROOT CAUSE 1: Method check thieu
  -> VCL khong co "if (req.method != "GET" && req.method != "HEAD")
     { return(pass); }"
  -> POST request di qua hash -> duoc cache nhu GET request

ROOT CAUSE 2: Method check co nhung bi dat SAI VI TRI
  -> if (req.method != "GET" ...) { return(pass); }
  -> Nhung nam SAU dong return(hash)
  -> POST request da duoc hash truoc khi method check chay
  -> hash KHONG CHECK METHOD -> POST duoc cache

ROOT CAUSE 3: Hash key trung voi GET request
  -> POST /api/sim/cart/add va GET /api/sim/products/1
  -> Neu hash chi dung URL, khong dung method -> trung key
  -> POST response duoc cache va serve cho GET request khac URL
  -> Can them hash_data(req.method) trong vcl_hash

IMPACT: DATA CORRUPTION + MUTATION LOSS
  -> POST cart/add bi cache -> user A add to cart -> CDN HIT
  -> User B POST cart/add -> CDN tra cached response -> backend
     KHONG NHAN DUOC cart add -> gio hang cua B khong duoc cap nhat
  -> Nghiem trong: don hang bi mat, user thanh toan nhung
     khong nhan duoc hang

DECISION:
  1. Kiem tra VCL co method check khong
  2. Kiem tra vi tri: method check PHAI nam TRUOC TAT CA return(hash)
  3. Kiem tra vcl_hash: co hash_data(req.method) khong?
     -> Neu khong -> hash key khong phan biet GET/POST
     -> Nhung tot hon la POST khong bao gio den duoc vcl_hash
  4. Sau khi fix: rerun 03-bypass-rules -> verify POST not HIT
  5. Kiem tra them: PUT, DELETE, PATCH cung phai bypass?
     -> Hien tai rule chi check GET/HEAD -> tat ca method khac deu pass
     -> Neu chi muon cache GET/HEAD -> rule hien tai DUNG
     -> Neu muon cache them PUT (cho idempotent ops) -> can update rule
```

### Scenario 4: Cache-Control: no-cache khong duoc ton trong

```text
OUTPUT:
  ✗ cache_control_no_cache first not hit
    X-Cache = "HIT"

ROOT CAUSE:
  VCL thieu check Cache-Control request header.
  Hoac regex sai -> khong match "no-cache" trong header.

  Phan biet:
    - Cache-Control TRONG REQUEST (tu client): "no-cache" = bypass
    - Cache-Control TRONG RESPONSE (tu origin): "no-cache" = khong cache

  Trong case nay ta test REQUEST header.
  VCL phai check req.http.Cache-Control (request), khong phai
  beresp.http.Cache-Control (backend response).

IMPACT: STALE DATA SERVED TO CLIENT
  -> Admin preview: update product price -> Ctrl+Shift+R (no-cache)
  -> CDN tra HIT (stale cached data) -> admin thay gia CU
  -> Admin tuong chua update -> update lai -> duplicate effort
  -> Hoac admin tuong da update nhung thuc te price van cu
  -> Neu la pharmacy/finance -> stale price/data co the gay
     thiet hai nghiem trong

DECISION:
  1. Kiem tra VCL: "if (req.http.Cache-Control ~ "(?i)no-cache")
     { return(pass); }"?
  2. Kiem tra vi tri: truoc return(hash)?
  3. Kiem tra regex: "(?i)no-cache" co match duoc:
     -> "no-cache" (lowercase)
     -> "No-Cache" (title case)
     -> "NO-CACHE" (uppercase)
     -> "no-cache, no-store" (multiple directives)
     -> Luu y: "max-age=0, no-cache" -> co the khong match neu
        regex chi check "no-cache" dau dong -> can kiem tra
  4. Kiem tra: co vo tinh strip Cache-Control header truoc khi check?
  5. Deploy fix -> rerun -> verify PASS
```

### Scenario 5: Only some bypass rules work — partial coverage

```text
OUTPUT:
  ✓ authorization_header first not hit       (PASS)
  ✓ authorization_header second not hit      (PASS)
  ✓ cookie_header first not hit              (PASS)
  ✓ cookie_header second not hit             (PASS)
  ✗ cache_control_no_cache first not hit     (FAIL - HIT)
  ✗ cache_control_no_cache second not hit    (FAIL - HIT)
  ✓ write_method_post first not hit          (PASS)
  ✓ write_method_post second not hit         (PASS)

ROOT CAUSE:
  VCL co Authorization/Cookie check va method check,
  nhung THIEU Cache-Control request header check.
  Hoac Cache-Control check bi dat SAI vi tri (sau khi
  da hash request).

IMPACT: PARTIAL PROTECTION — NGUY HIEM NHAT
  -> He thong nhin co ve an toan (Auth/Cookie/POST OK)
  -> Nhung client co the bypass stale cache KHI HO MUON
  -> Admin refresh (Ctrl+Shift+R) khong co hieu luc
  -> Neu la trang thai don hang/thanh toan -> user thay
     stale status -> dua ra quyet dinh sai

DECISION:
  1. KHONG DUOC bo qua vi "3/4 rules pass"
  2. Fail o BAT KY rule nao cung la CRITICAL
  3. Fix thieu rule -> rerun toan bo
  4. Dung scenario nay nhu regression test moi khi VCL thay doi
```

## 12. Nghich ly / misconceptions

### Nghich ly 1: "bypass = CDN khong hoat dong"

```text
SAI. Bypass LA CDN HOAT DONG DUNG.

CDN khong chi "cache". CDN co nhieu nhiem vu:
  (a) Cache public traffic de offload origin
  (b) BYPASS cache cho private/write traffic de dam bao security
  (c) Invalidate cache khi data thay doi
  (d) Route request den dung backend
  (e) Protect origin (rate limiting, DDoS protection)

Bypass la nhiem vu (b) — quan trong khong kem gi cache.
Neu CDN cache TAT CA traffic bao gom authenticated -> CDN dang LAM SAI.

Tuong tu: mot bao ve khong chi "cho nguoi vao" (cache public),
ma con phai "chan nguoi khong duoc vao" (bypass private).
Neu bao ve cho tat ca moi nguoi vao -> bao ve dang khong lam viec.
```

### Nghich ly 2: "them bypass rule de an toan"

```text
SAI. Them bypass rule LAM TANG origin load.

Moi bypass rule them vao -> nhieu traffic hon di thang den backend
-> origin load tang -> can nhieu backend capacity hon.

Can bang:
  - Cache cang nhieu -> origin load cang thap, nhung security risk cang cao
  - Bypass cang nhieu -> cang an toan, nhung origin load cang cao

Case nay test 4 bypass rules la muc TOI THIEU:
  - Authorization + Cookie: bat buoc cho security
  - Cache-Control: no-cache: bat buoc cho HTTP spec compliance
  - Non-GET/HEAD methods: bat buoc cho data integrity

Khong nen them bypass rule "cho an toan" neu khong co ly do cu the.
Moi rule bypass phai duoc validate la CAN THIET va DOC LAP.
```

### Nghich ly 3: "Authorization header luon gay bypass"

```text
KHONG PHAI LUON LUON. Phu thuoc vao VCL implementation.

Mot so CDN configuration:
  - Strip Authorization header, hash request -> van cache
  - Hash Authorization header vao cache key -> moi user co key rieng
    -> Khong bi leak giua cac user, nhung ton bo nho cache
  - Check Authorization nhung chi bypass cho mot so path nhat dinh
  - Bypass Authorization nhung van hash cac variant headers

Case nay chung minh rang VCL HIEN TAI bypass Authorization.
Neu VCL thay doi -> test nay phai FAIL de bao dong.

Khong duoc gia dinh "Authorization -> always bypass".
Day la LY DO test nay ton tai — de VERIFY rang VCL dang bypass.
```

### Nghich ly 4: "X-Cache = MISS nghia la bypass hoat dong"

```text
KHONG HOAN TOAN CHINH XAC.

X-Cache = MISS co the la:
  (a) Bypass hoat dong: return(pass) -> obj.hits = 0 -> MISS
  (b) Object chua duoc cache: lan dau tien request -> MISS
  (c) Object expired: TTL het han -> MISS + fetch moi
  (d) Object bi evict: cache full -> MISS

Vi vay case nay goi 2 LAN:
  - Lan 1: MISS -> co the la (a) hoac (b)
  - Lan 2: Neu (b) -> response lan 1 duoc cache -> lan 2 HIT
           Neu (a) -> response lan 1 khong cache -> lan 2 van MISS
  - Lan 2 MISS -> xac nhan la (a): bypass that su

Neu chi goi 1 lan -> khong du evidence de xac nhan bypass.
Day la ly do exerciseRepeatedBypass goi 2 lan.
```

### Nghich ly 5: "POST cart/add tra 200 la OK"

```text
CHUA DU. 200 la STATUS tu backend, khong phai tu CDN.

Bypass case quan tam den X-Cache, khong phai HTTP status:
  - POST -> backend xu ly -> 200 OK -> X-Cache = MISS -> PASS
  - POST -> backend xu ly -> 200 OK -> X-Cache = HIT  -> FAIL (bat ke 200)

Neu POST tra HIT:
  -> 200 OK do CDN serve tu cache
  -> Backend KHONG NHAN DUOC POST request
  -> Cart add KHONG duoc thuc thi
  -> Nhung client thay 200 -> tuong thanh cong

Day la LOI NGUY HIEM NHAT: CDN "gia mao" backend response
ma backend khong he xu ly request.
```

## 13. Checklist

```text
TRUOC KHI CHAY:
  [ ] TargetLayer = full (Varnish + Nginx + app deu running)
  [ ] BASE_URL tro den public CDN URL (localhost:80)
  [ ] VCL chua 4 bypass rules:
      [ ] if (req.method != "GET" && req.method != "HEAD") { return(pass); }
      [ ] if (req.http.Cache-Control ~ "(?i)no-cache") { return(pass); }
      [ ] if (req.http.Authorization || req.http.Cookie) { return(pass); }
  [ ] Tat ca cac bypass rules nam TRUOC return(hash)
  [ ] Environment variables duoc set (OPS_AUTH_TOKEN khong can
      nhung nen set de tranh warning)
  [ ] Khong co purge/ban nao dang chay song song

TRONG KHI CHAY:
  [ ] Tat ca 4 bypass triggers duoc test
  [ ] Moi trigger duoc goi 2 lan
  [ ] Tat ca checks pass (rate = 1)

SAU KHI CHAY:
  [ ] X-Cache = "MISS" (hoac khong HIT) cho TAT CA 8 requests
  [ ] X-Upstream-Service dung cho tung request
  [ ] HTTP status 200 cho tat ca
  [ ] Khong co X-Cache-Key-* headers trong GET bypass responses
  [ ] k6 exit code 0

DEBUG KHI FAIL:
  [ ] Kiem tra VCL: bypass rules co ton tai khong?
  [ ] Kiem tra vi tri: bypass rules co truoc return(hash) khong?
  [ ] Kiem tra regex: dung cu phap VCL khong?
  [ ] Kiem tra: co go purge/ban de reset cache state khong?
  [ ] Kiem tra: Varnish da reload VCL moi nhat chua?
      -> sudo varnishadm vcl.list
      -> sudo varnishadm vcl.use <config-name>
```

## 14. Variations

### Variation 1: Custom bypass header

Một số hệ thống dùng custom header thấy Vì Authorization/Cookie dễ xác dinh
user context. Vi du: `X-User-Token`, `X-API-Key`, `X-Session-ID`.

```javascript
// Them test case vao default function
exerciseRepeatedBypass('custom_user_token', {
  path: paths.productDetail,
  profile: profiles.guestVNMobileControl,
  headers: { 'X-User-Token': 'custom-token-xyz' },
  upstream: 'products-service',
});
```

VCL cần duoc cấp nhất dễ bypass header này:

```vcl
if (req.http.X-User-Token) {
    return (pass);
}
```

Hoặc combine vào rule hiện có (da có sẵn trọng VCL hiện tại):

```vcl
if (req.url ~ "^/api/sim/products($|\\?)"
    && (req.http.X-User-Token || req.http.X-User-ID || req.http.X-Api-Key)) {
    return (pass);
}
```

Lưu Ý: rule này CHI ap dùng chờ `/api/sim/products` paths, không phải global.
Neu muon bypass toan bo, can dat truoc hash routing.

### Variation 2: Method-based bypass expansion (PUT, DELETE, PATCH)

Test them cac method khac:

```javascript
// PUT
exerciseRepeatedBypass('write_method_put', {
  method: 'PUT',
  path: '/api/sim/products/1',
  body: { name: 'Updated Product', price: 99.99 },
  upstream: 'products-service',
  expectNoCacheKeyHeaders: false,
});

// DELETE
exerciseRepeatedBypass('write_method_delete', {
  method: 'DELETE',
  path: '/api/sim/cart/remove/1',
  body: null,
  upstream: 'cart-service',
  expectedStatus: 204,  // DELETE thuong tra 204 No Content
  expectNoCacheKeyHeaders: false,
});

// PATCH
exerciseRepeatedBypass('write_method_patch', {
  method: 'PATCH',
  path: '/api/sim/products/1',
  body: { price: 89.99 },
  upstream: 'products-service',
  expectNoCacheKeyHeaders: false,
});
```

VCL hiện tại da bảo phụ tất cả non-GET/HEAD methods:

```vcl
if (req.method != "GET" && req.method != "HEAD") {
    return (pass);
}
```

Nhưng test từng method riêng biết chờ tả evidence rõ rằng rằng **tung method**
deu duoc bypass, chú không chỉ "tất cả method khác". Dac biết quán trọng Nếu
sâu này ai dở chính sửa VCL chỉ bypass POST nhưng quên PUT/DELETE.

### Variation 3: Cookie prefix whitelist

Một pattern phổ biến là **strip cookie không quán trong** thấy Vì bypass toàn bộ:

```vcl
// Strip tracking/analytics cookies, keep session cookies
if (req.http.Cookie) {
    set req.http.Cookie = ";" + req.http.Cookie;
    set req.http.Cookie = regsuball(req.http.Cookie, "; +", ";");
    set req.http.Cookie = regsuball(req.http.Cookie,
        ";(__utm[^;]*|_ga[^;]*|_gid[^;]*|_gat[^;]*)=", ";");
    set req.http.Cookie = regsub(req.http.Cookie, "^; ", "");
    if (req.http.Cookie == "") {
        unset req.http.Cookie;
    }
}
// Sau khi strip, neu van con cookie -> bypass
if (req.http.Cookie) {
    return (pass);
}
```

Test cho variation nay:

```javascript
// Cookie chi co tracking -> should HIT (khong bypass)
exerciseRepeatedBypass('tracking_cookie_only', {
  path: paths.productDetail,
  profile: profiles.guestVNMobileControl,
  headers: { Cookie: '__utma=123; _ga=GA1.2.456; _gid=GA1.2.789' },
  upstream: 'products-service',
  // Neu VCL strip tracking cookies -> request nay nen HIT
  // Can assertHit() thay vi assertNotHit()
});

// Cookie co session -> should bypass
exerciseRepeatedBypass('session_cookie', {
  path: paths.productDetail,
  profile: profiles.guestVNMobileControl,
  headers: { Cookie: 'session_id=abc123; __utma=123' },
  upstream: 'products-service',
  // Session cookie van con sau khi strip -> bypass
});
```

Cảnh bảo: Cookie stripping có thể **vo tính strip sai** và cache session data.
Test nay chung minh rang chi tracking cookies bi strip, con session cookies
vẫn trigger bypass.

### Variation 4: Combining bypass triggers

Test nhiều bypass triggers cùng lúc dễ vềrify **OR logic**:

```javascript
// Authorization + Cookie + no-cache cung luc
// Neu 1 trong 3 trigger bypass -> request se bi bypass
exerciseRepeatedBypass('combined_auth_cookie_nocache', {
  path: paths.productDetail,
  profile: profiles.guestVNMobileControl,
  headers: {
    Authorization: 'Bearer token',
    Cookie: 'session=abc',
    'Cache-Control': 'no-cache',
  },
  upstream: 'products-service',
});

// Authorization + POST method
// POST method check CHAY TRUOC Authorization check trong VCL
// -> bypass vi method, khong phai vi Authorization
// -> Van bypass -> van PASS, nhung can doc VCL de biet
//    rule nao da kich hoat bypass
exerciseRepeatedBypass('combined_auth_post', {
  method: 'POST',
  path: paths.productDetail,
  profile: profiles.guestVNMobileControl,
  headers: { Authorization: 'Bearer token' },
  body: { product_id: 1 },
  upstream: 'products-service',
  expectNoCacheKeyHeaders: false,
});
```

### Variation 5: Smoke test — prove cache works before bypass test

Dạy là một variation quán trọng: trước khí test bypass, warm cache dễ chứng
mình rằng cache **dang hoạt dong** chờ traffic bình thường. Dieu này loại trừ
khá năng "bypass nốt HIT nhưng không phải dở bypass rule — dở cache không
hoat dong".

```javascript
function warmCacheAndVerify() {
  // Warm: goi request khong co bypass trigger
  const warm1 = requestCdn('GET', paths.productDetail, {
    profile: profiles.guestVNMobileControl,
    tags: { case: 'warm_first' },
  });
  assertStatus(warm1, 200, 'warm first');
  // Warm request lan 1: MISS (lan dau)

  const warm2 = requestCdn('GET', paths.productDetail, {
    profile: profiles.guestVNMobileControl,
    tags: { case: 'warm_second' },
  });
  assertStatus(warm2, 200, 'warm second');
  // Warm request lan 2: PHAI HIT (chung minh cache hoat dong)

  // assertCacheState khong co trong shared.js, dung check truc tiep:
  check(warm2, {
    'cache works baseline': (r) => cacheState(r) === 'HIT',
  });

  // Neu warm2 khong HIT -> cache khong hoat dong -> skip bypass tests
  if (cacheState(warm2) !== 'HIT') {
    console.error('CACHE NOT WORKING — bypass tests not meaningful');
  }
}
```

Dạy là một best practice: chứng mình cache hoạt dòng TRUOC khí chứng mình
bypass hoạt dòng. Nếu cache không hoạt dòng -> nốt HIT không có Ý nghĩa.

## 15. Anti-patterns

### Anti-pattern 1: Khong test bypass

```text
"Chi can test cache HIT la du. Neu cache HIT thi tot."

SAI. Test HIT chi chung minh cache HOAT DONG.
Khong chung minh duoc cache KHONG CACHE SAI THU.

He thong co the:
  -> Cache public traffic VERY WELL (HIT 99%)
  -> NHUNG dong thoi cache authenticated content (HIT 99%)
  -> User khong biet vi ho van thay data binh thuong
  -> Nhung data bi leak giua cac user

Test bypass la REQUIRED, khong phai OPTIONAL.
```

### Anti-pattern 2: Test bypass nhung khong test cache HIT truoc

```text
"Bypass test not HIT -> pass. Vay la du."

SAI. Co the cache KHONG HOAT DONG cho bat ky traffic nao.
Neu cache khong hoat dong -> TAT CA request deu MISS (hoac not HIT)
-> Bypass test PASS nhung khong co nghia bypass rule hoat dong.

Phai chung minh:
  1. Cache HOAT DONG (anonymous request HIT)
  2. Bypass HOAT DONG (private request not HIT)

Day la causal chain: neu khong co (1) -> (2) khong co y nghia.
```

### Anti-pattern 3: Confusing pass (Varnish action) vs PASS (test result)

```text
"return(pass)" trong VCL:
  -> Hanh dong cua Varnish: bypass cache, goi backend
  -> Neu CDN gap return(pass) -> request se not HIT
  -> Test se PASS (vi assertNotHit se pass)

"PASS" trong test result:
  -> Test case dat yeu cau -> threshold checks rate == 1
  -> Co nghia tat ca assertions deu dung

Confusion:
  - "return(pass) -> PASS" la DUNG
  - "return(pass) -> FAIL" co nghia test da phat hien cai gi do SAI
    (vd: return(pass) khong duoc goi, hoac X-Cache van HIT)
  - "khong return(pass) nhung test van PASS" -> DAY LA ANTI-PATTERN:
    Test thieu assert, khong phat hien duoc cache sai behavior.

Rule: Neu test bypass ma khong verify X-Cache != HIT -> test khong
      co y nghia.
```

### Anti-pattern 4: Dung sai profile cho bypass test

```text
"Sao cung duoc, chi can goi request la xong."

SAI. Neu dung profile da co Authorization header san:
  -> Khong biet Authorization trigger bypass, hay la profile
  -> Khong isolation giua cac triggers

Phai dung profile SACH (guest, khong auth, khong cookie):
  -> guestVNMobileControl: profile co ban, khong auth
  -> Sau do THEM MOT bypass trigger vao headers
  -> Dam bao chi co MOT trigger duoc test

Neu dung profile co Cookie san (vd: returningVNMobileVariantA
neu co Cookie trong profile headers) -> Cookie test se overlap
voi profile -> khong biet Cookie co that su trigger bypass khong.
```

### Anti-pattern 5: Chi goi 1 lan cho moi bypass trigger

```text
"Goi 1 lan, not HIT -> bypass OK."

SAI. Co the:
  - Lan 1: MISS vi object chua duoc cache (khong phai bypass)
  - Lan 2: HIT vi object da duoc cache (bypass KHONG hoat dong)

Chi voi 2 lan moi co the phan biet "MISS do chua warm" vs
"MISS do bypass".

Quy tac: ALWAYS goi 2 lan cho moi bypass trigger.
```

## 16. Real validation data

### Case ID va metadata

```text
  Case ID:          cdn-03-bypass-rules
  Script:           03-bypass-rules.js
  Layer:            CDN / Varnish
  Executor:         shared-iterations (vus: 1, iterations: 1)
  Open/Closed:      N/A (single-run validation, khong phai load test)
  TargetLayer:      full
  Base URL:         http://localhost:80
  Control URL:      http://localhost:8088 (unused)
  Event URL:        http://localhost:9091 (unused)

  Profiles used:
    - guestVNMobileControl (cho ca 4 bypass triggers)

  Assertions per run: 28 checks
    - 4 triggers x 2 requests x 3 assertions (status, upstream, not hit)
    - 3 triggers x 2 requests x 1 assertion (headers absent)
    - 1 trigger x 2 requests x 0 assertion (headers absent skip)
    = 24 + 6 + 0 = 30 checks (?)
    Thuc te: estimately 26-28 checks tuy vao post-processing

  Pass condition: checks rate = 1 (100%)
  Fail condition: bat ky assertion nao fail -> checks rate < 1
```

### Expected outcomes

```text
  authorization_header:
    first:  status=200, upstream=products-service, not HIT, no cache-key headers
    second: status=200, upstream=products-service, not HIT, no cache-key headers

  cookie_header:
    first:  status=200, upstream=products-service, not HIT, no cache-key headers
    second: status=200, upstream=products-service, not HIT, no cache-key headers

  cache_control_no_cache:
    first:  status=200, upstream=products-service, not HIT, no cache-key headers
    second: status=200, upstream=products-service, not HIT, no cache-key headers

  write_method_post:
    first:  status=200, upstream=cart-service, not HIT
    second: status=200, upstream=cart-service, not HIT
```

### VCL rules verified

```text
  Rule checked                      VCL line            Expected behavior
  --------------------------------  ------------------  -----------------
  req.method != "GET" && != "HEAD"  return(pass) #121   POST -> not HIT
  req.http.Cache-Control ~ no-cache return(pass) #135   no-cache -> not HIT
  req.http.Authorization            return(pass) #138   Auth -> not HIT
  req.http.Cookie                   return(pass) #138   Cookie -> not HIT
```

## 17. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Script source: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/03-bypass-rules.js`
- Shared helpers: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js`
- VCL source: `E:/Projects/k6/k6-metrics-server/load-target/varnish/default.vcl`
- Source README: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md`
- Varnish docs on `return(pass)`: https://varnish-cache.org/docs/7.6/reference/vcl.html#pass
- HTTP spec Cache-Control request directives: RFC 9111 Section 5.2
- OWASP caching guidance: https://cheatsheetseries.owasp.org/cheatsheets/Caching_Cheat_Sheet.html
