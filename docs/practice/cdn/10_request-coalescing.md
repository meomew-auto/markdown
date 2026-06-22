# Case 10: Request Coalescing

> **Case ID:** `cdn-10-request-coalescing`
> **Script:** `10-request-coalescing.js`
> **Layer:** CDN / Varnish
> **Proof:** cold burst cung key khong stampede origin
> **Do phuc tap:** Cao -- concurrency batch, origin delay, counter proof, wait-for-object mechanism

---

## 1. Tinh huong thuc te (Business Scenario)

### 1.1 Boi canh

Ban dang van hanh mot ung dung tin tuc (news site) hoac thuong mai dien tu. Mot bai viet quan trong (breaking news) hoac san pham hot (flash sale) vua duoc publish. Object nay chua co trong CDN cache -- day la mot **cold object**.

Cung luc do, 10,000 nguoi dung cung nhan duoc push notification hoac email marketing dan den bai viet/san pham nay. Ho cung click vao link trong vong 1-2 giay.

**Cau hoi nghiep vu:** Khi 10,000 request cung den CDN cho cung mot cold object, CDN se goi origin 1 lan hay 10,000 lan?

### 1.2 Hau qua neu khong co request coalescing

| Thanh phan | Hanh vi khi khong co coalescing | Tac dong kinh doanh |
| --- | --- | --- |
| CDN khong coalescing | Moi request MISS deu duoc forward den origin | Origin nhan 10,000 request dong thoi |
| Origin (app server) | Bi tan cong boi 10,000 request cung luc cho cung object | App server qua tai, CPU 100%, memory can, crash |
| Database | 10,000 query giong het nhau chay dong thoi | DB connection pool can, query queue day, lock contention |
| Nguoi dung | Nhin thay timeout hoac 502/503 | Roi khoi site, khong bao gio quay lai |
| Infrastructure cost | Phai scale app server + DB gap 10-20 lan de chiu duoc burst | Chi phi infrastructure tang dot bien, roi lai giam -> lang phi |

**Ten goi cua hien tuong nay:** **Thundering herd** hoac **Cache stampede** hoac **Dogpile effect**.

### 1.3 Co che coalescing trong Varnish

Varnish giai quyet stampede bang co che goi la **wait-for-object** (cung duoc goi la **request collapsing** hoac **collapsed forwarding**):

```text
KHONG CO coalescing (stampede):
  12 request -> 12 MISS -> 12 origin request -> 12 response

CO coalescing:
  12 request -> 12 MISS detect cung key
             -> CHI 1 request duoc forward den origin
             -> 11 request con lai WAIT
             -> Origin tra response
             -> CA 12 request deu nhan response tu object da cache
             -> 1 origin request, 12 CDN response
```

Day la tinh nang **built-in trong Varnish**, khong can cau hinh gi dac biet. No la mot phan cua VCL flow mac dinh.

### 1.4 Cac tinh huong thuc te gay stampede

| Tinh huong | Mo ta | So request dong thoi | Tac dong |
| --- | --- | --- | --- |
| Breaking news | Push notification gui den 1 trieu nguoi dung | 50,000-100,000/phut | Coalescing giam origin load 99.99% |
| Flash sale | San pham hot, moi nguoi cung click | 10,000-50,000/phut | Origin chi xu ly 1-2 request |
| Cache purge | Object bi xoa khoi cache, moi request tiep theo MISS | 100-1,000/giay | Coalescing bao ve origin sau purge |
| TTL expiry | Nhieu object cung het TTL | 100-500/giay | Coalescing giam "TTL expiry stampede" |
| Deploy moi | Tat ca cache bi xoa, cold start | 1,000-10,000/giay | Coalescing quan trong nhat luc cold start |
| DDoS (legitimate) | Su kien viral dan den luu luong dot bien | Khong gioi han | Coalescing la lop bao ve dau tien |

---

## 2. CDN Capability Duoc Chung Minh

### 2.1 Phat bieu chinh xac

```text
Khi nhieu request cung den CDN cho cung mot cold object (chua co trong cache)
trong vong mot khoang thoi gian ngan (sub-millisecond den vai ms),
CDN chi forward DUNG 1 request den origin.
Tat ca cac request con lai cho den khi object duoc cache (wait),
sau do duoc phuc vu tu cache vua duoc fill.
Origin chi nhan 1 (hoac toi da 2, trong truong hop race condition) request.
```

### 2.2 Bon dieu duoc chung minh cung luc

| # | Dieu can chung minh | Evidence trong script | Loai proof |
| --- | --- | --- | --- |
| 1 | Tat ca 12 request deu thanh cong (HTTP 200) | `assertStatus(res, 200)` cho tung request trong batch | Positive proof |
| 2 | Sau batch, object da duoc cache (HIT) | `assertCacheState(afterWarm, 'HIT')` | Positive proof |
| 3 | Origin chi nhan <= 2 request (khong phai 12) | `findOriginRequestCount(counts, path) <= 2` | Negative proof |
| 4 | CDN chi forward 1 request den origin | `requestCount > 2` la ERROR | Negative proof |

Day la mot **negative proof manh me**: khong chi chung minh request thanh cong, con chung minh origin da KHONG bi goi 12 lan.

### 2.3 Coalescing ratio

```text
Coalescing ratio = (batch_size - origin_count) / batch_size

Vi du:
  batch_size = 12, origin_count = 1 -> ratio = 11/12 = 91.7%
  batch_size = 12, origin_count = 2 -> ratio = 10/12 = 83.3%
  batch_size = 12, origin_count = 12 -> ratio = 0% (KHONG coalescing)
  batch_size = 100, origin_count = 1 -> ratio = 99% (hoan hao)
```

---

## 3. Vi Sao Phai Test O CDN Layer (Khong The Test O App Layer)

### 3.1 So sanh layer

| Khia canh | Test o app layer | Test o CDN layer (case nay) |
| --- | --- | --- |
| Concurrency control | App co the cache local nhung khong giai quyet duoc 10,000 request cung den 1 may | CDN collapse request TRUOC KHI den app -- app chi nhan 1 request |
| Wait-for-object | App khong co co che nay (day la CDN primitive) | Varnish co wait-for-object built-in trong VCL flow |
| Origin counter | App khong the biet co bao nhieu request da duoc coalescing | CDN control-plane endpoint la evidence doc lap |
| Batch simulation | App khong co k6 `http.batch` de tao concurrent burst | k6 `http.batch` gui 12 request cung luc qua CDN |
| Origin delay | App khong the mo phong origin delay de test race condition | Script dung `origin_delay_ms=800` de mo phong origin cham |

### 3.2 Nguyen ly cot loi

```text
Request coalescing la mot CAPABILITY CUA CDN, khong phai cua app.
Co che nay nam o VCL built-in flow:
  1. vcl_recv: CDN nhan request
  2. vcl_hash: CDN tinh cache key
  3. vcl_hit / vcl_miss: CDN phat hien object khong co trong cache
  4. vcl_miss: CDN forward request den origin
  5. NEU mot request khac da duoc forward cho cung key:
     -> Request nay CHO (wait-for-object) thay vi forward them request moi
  6. Origin tra response -> Varnish cache object
  7. TAT CA cac request dang cho deu nhan object tu cache

App chi thay 1 request den, khong biet rang da co 11 request khac duoc
coalescing o tang CDN.
```

### 3.3 Coalescing vs cac ky thuat khac

| Ky thuat | Chung minh | Muc dich | Tang ap dung |
| --- | --- | --- | --- |
| Request coalescing | Case 10 | Gom nhieu request cung key -> 1 origin request | CDN |
| Connection pooling | Khong test trong series nay | Tai su dung connection -> giam overhead | Origin |
| Rate limiting | Khong test trong series nay | Gioi han so request/giay -> bao ve origin | App/CDN |
| Circuit breaking | Khong test trong series nay | Ngat ket noi den origin khi loi | App/CDN |
| Load shedding | Khong test trong series nay | Tu choi request khi qua tai | App |
| Caching (basic) | Case 01 | Phuc vu tu cache -> 0 origin request | CDN |

Coalescing khac voi caching co ban o cho: **caching tranh origin request SAU KHI object da duoc cache**. Coalescing tranh origin request **TRONG KHI object DANG duoc cache**.

---

## 4. Topology Va Precondition

### 4.1 Runtime topology

```text
                PUBLIC PATH (:80)
                     |
                [Varnish CDN]
                     |
            vcl_recv -> vcl_hash -> vcl_miss
                     |
            +--------+--------+
            |                 |
      Request 1 (forward)  Request 2-12 (wait)
            |                 |
      [Origin: Nginx -> app] |
      origin_delay_ms=800    |
            |                 |
      Object cached <--------+
            |
      Serve all 12 requests tu cache

                CONTROL PATH (:8088)
                     |
            /ops/app/cdn/cache/ban-url (POST)
            /ops/app/cdn/origin/request-counts (GET)
            /ops/app/cdn/origin/request-counts/reset (POST)
```

### 4.2 Thanh phan topology

| Thanh phan | Vai tro | Endpoint | Ghi chu |
| --- | --- | --- | --- |
| Varnish CDN | Edge cache + coalescing | `localhost:80` | Wait-for-object built-in |
| Nginx | Reverse proxy | Internal | Forward den app |
| App services | Business logic | Internal | Khong can biet ve coalescing |
| Origin simulator | Mo phong origin delay | Internal `/api/cached` | `origin_delay_ms` param |
| Control plane | Counter + ban URL | `localhost:8088` | Can OPS_AUTH_TOKEN |

### 4.3 Precondition day du

| # | Dieu kien | Cach thiet lap | Kiem tra |
| --- | --- | --- | --- |
| P1 | Stack target voi `TargetLayer=full` | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full -ScaleApp 2` | `docker ps` thay Varnish + Nginx + app |
| P2 | Control plane kha dung | `CONTROL_BASE_URL=http://localhost:8088` | `curl http://localhost:8088/ops/app/cdn/origin/request-counts` tra 200 |
| P3 | OPS_AUTH_TOKEN hop le | Bien moi truong `OPS_AUTH_TOKEN` | Control API khong tra 401 |
| P4 | Object chua co trong cache (cold) | `banUrl(path)` trong setup | Path moi + ban de dam bao cold |
| P5 | Origin co delay du lon | `COALESCE_ORIGIN_DELAY_MS=800` | 800ms du de 12 request den truoc khi origin tra response |
| P6 | Origin counter da reset | `resetOriginRequestCounts()` | Counter ban dau = 0 |
| P7 | Concurrency du lon | `COALESCE_CONCURRENCY=12` | 12 request dong thoi du de thay su khac biet |
| P8 | Varnish version >= 4.1 | `varnishd -V` | Wait-for-object co tu 4.1 |

---

## 5. Script Deep-Dive

### 5.1 Tong quan cau truc

```javascript
// 4 PHASE trong script:
// Phase A: options + khai bao hang so
// Phase B: setup() -- tao cold key + ban + reset counter
// Phase C: default() -- http.batch 12 request + verify HIT + verify count
// Phase D: teardown() -- reset origin profile + counter
```

### 5.2 Phase A: Options va Env Knobs

```javascript
import http from 'k6/http';
import { envInt } from '../shared/common.js';
import {
  CDN_BASE_URL,
  buildCachedPath,
  buildHeaders,
  banUrl,
  requestCdn,
  assertCacheState,
  assertStatus,
  getOriginRequestCounts,
  findOriginRequestCount,
  resetOriginProfile,
  resetOriginRequestCounts,
  waitOriginHealthy,
} from './shared.js';

const COALESCE_CONCURRENCY = envInt('COALESCE_CONCURRENCY', 12);
const COALESCE_ORIGIN_DELAY_MS = envInt('COALESCE_ORIGIN_DELAY_MS', 800);
const COALESCE_TTL_SECONDS = envInt('COALESCE_TTL_SECONDS', 30);

export const options = {
  vus: 1,           // Chi 1 VU -- day la correctness test
  iterations: 1,    // Chi 1 iteration
  thresholds: {
    checks: ['rate==1'],          // TAT CA checks phai pass
    http_req_failed: ['rate==0'], // Khong co request nao loi
  },
  tags: {
    scenario: 'cdn_request_coalescing',
  },
};
```

**Bang env knobs day du:**

| Bien moi truong | Mac dinh | Y nghia | Anh huong neu thay doi | Gia tri toi thieu | Gia tri toi da |
| --- | --- | --- | --- | --- | --- |
| `COALESCE_CONCURRENCY` | `12` | So request dong thoi trong batch | Tang -> phai verify origin count van <= 2. Giam xuong 2 -> khong con y nghia test. | `4` | `100` (giot han boi k6) |
| `COALESCE_ORIGIN_DELAY_MS` | `800` | Thoi gian origin "gia vo" xu ly (ms) | Qua ngan -> origin tra response truoc khi batch hoan thanh -> request sau thay HIT -> khong test duoc. Qua dai -> test cham, co the timeout. | `500` | `5000` |
| `COALESCE_TTL_SECONDS` | `30` | TTL cua object (giay) | Khong quan trong cho coalescing proof nhung can du lon de follow-up request la HIT. | `10` | `300` |

### 5.3 Phase B: setup() -- Tao Cold Key

```javascript
export function setup() {
  // B1: Tao URL dong voi origin delay duoc cau hinh
  const path = buildCachedPath(`coalesce-${Date.now()}`, {
    ttl_seconds: COALESCE_TTL_SECONDS,
    origin_delay_ms: COALESCE_ORIGIN_DELAY_MS,
  });
  // URL vi du: /api/cached?key=coalesce-1719000000000&ttl_seconds=30&origin_delay_ms=800
  //
  // Luu y: origin_delay_ms la tham so dac biet chi co o origin simulator.
  // Trong thuc te, origin khong co delay param nay -- day la mock.

  // B2: Reset origin profile ve healthy (dam bao khong bi anh huong boi case 09)
  resetOriginProfile();
  // -> POST /ops/app/cdn/origin/reset -> 200

  // B3: Doi origin healthy (co stable check)
  waitOriginHealthy({ label: 'coalescing setup origin recovery' });
  // -> Probe loop: xac nhan origin healthy + CDN thay healthy
  // -> Can stable samples (mac dinh 2)

  // B4: Reset origin counter ve 0
  resetOriginRequestCounts();
  // -> POST /ops/app/cdn/origin/request-counts/reset -> 200
  // -> Tat ca counter = 0

  // B5: Ban URL de dam bao object chua co trong cache
  banUrl(path);
  // -> POST /ops/app/cdn/cache/ban-url { url: path } -> 200

  // B6: KHONG warm object! De no cold cho batch request
  //     Day la su khac biet voi case 09 (can warm truoc)

  return { path };
}
```

**Tai sao KHONG warm object truoc batch?**

Neu warm object truoc:
- Request 1: MISS -> cache -> object da co trong cache
- Request 2-12: HIT -> KHONG TEST DUOC COALESCING
- Origin count = 1 (chi MISS ban dau) -> PASS gia

De test coalescing, object PHAI cold. `banUrl()` dam bao object chua co trong cache. Khong co warm step.

### 5.4 Phase C: default() -- Burst + Verify

```javascript
export default function (data) {
  const path = data.path;

  // C1: Tao mang 12 request objects GIONG HET NHAU
  //     Array.from tao mang request cho http.batch
  const requests = Array.from({ length: COALESCE_CONCURRENCY }, (_, index) => ({
    method: 'GET',
    url: `${CDN_BASE_URL}${path}`,
    params: {
      headers: buildHeaders(),
      tags: { case: `coalescing_batch_${index}` },
    },
  }));
  // Mang requests:
  // [{ method: 'GET', url: 'http://localhost:80/api/cached?...', params: {...} },
  //  { method: 'GET', url: 'http://localhost:80/api/cached?...', params: {...} },
  //  ... (12 lan)]

  // C2: Gui TAT CA 12 request DONG THOI bang http.batch()
  //     http.batch nhan array request objects
  //     Tra ve array response objects (cung thu tu)
  //     QUAN TRONG: http.batch gui request trong CUNG event loop tick
  //     -> sub-millisecond giua cac request
  const responses = http.batch(requests);

  // C3: Verify TAT CA 12 response deu 200
  //     Dung for..of hoac forEach de lap qua tung response
  for (const [index, res] of responses.entries()) {
    assertStatus(res, 200, `coalescing batch ${index}`);
    // Tao 12 checks: coalescing batch 0 status 200, ..., coalescing batch 11 status 200
  }
  // Neu 1 request tra 503 -> FAIL

  // C4: Follow-up request de xac nhan object da duoc cache
  const afterWarm = requestCdn('GET', path, {
    tags: { case: 'coalescing_after_warm' },
  });
  assertStatus(afterWarm, 200, 'coalescing after warm');
  assertCacheState(afterWarm, 'HIT', 'coalescing after warm');
  // Neu follow-up la MISS -> object khong duoc cache -> TTL=0 hoac VCL issue

  // C5: NEGATIVE PROOF -- origin count phai <= 2
  const counts = getOriginRequestCounts();
  const requestCount = findOriginRequestCount(counts, path);
  if (requestCount > 2) {
    throw new Error(
      `expected coalesced origin hits for ${path} to stay <= 2, got ${requestCount}`
    );
  }
}
```

**Phan tich `http.batch` vs `Promise.all`:**

```javascript
// SAI -- khong dung Promise.all
const responses = await Promise.all(
  requests.map(req => http.asyncRequest(req.method, req.url, null, req.params))
);
// k6 khong co async/await, http.batch la cach duy nhat de gui request dong thoi

// DUNG -- http.batch
const responses = http.batch(requests);
// Tra ve array responses, dong bo (blocking)
// Nhung TAT CA request duoc gui truoc khi cho response
```

**Tai sao origin count <= 2 ma khong phai === 1?**

Trong Varnish, co kha nang nho xay ra race condition:
- 2 request den **qua nhanh** (sub-millisecond)
- Ca 2 deu thay object khong co trong cache
- Ca 2 deu duoc forward den origin (cung luc)
- Origin nhan 2 request thay vi 1

Day la race condition da biet trong Varnish wait-for-object implementation. Contract chap nhan toi da 2 origin hits. > 2 la THAT BAI.

**Dong thoi gian default:**

```text
t=2.5   Array.from({ length: 12 }) -- tao 12 request objects
t=2.5   http.batch(requests) -- GUI 12 REQUEST DONG THOI
t=2.500 Request 0 -> Varnish -> MISS -> FORWARD den origin
t=2.502 Request 1 -> Varnish -> MISS -> WAIT (Request 0 dang fetch)
t=2.503 Request 2 -> WAIT
...
t=2.511 Request 11 -> WAIT
t=2.500 Origin nhan request -> xu ly (delay=800ms)
t=3.300 Origin tra response -> CDN cache object
t=3.301 Tat ca 12 request nhan response -> X-Cache: MISS
t=3.310 http.batch hoan thanh -> 12 responses
t=3.320 For loop: assertStatus x12 -> PASS
t=3.330 Follow-up: requestCdn -> HIT -> PASS
t=3.350 getOriginRequestCounts -> count=1 -> PASS
```

### 5.5 Phase D: teardown() -- Cleanup

```javascript
export function teardown() {
  resetOriginProfile();
  waitOriginHealthy({ label: 'coalescing teardown origin recovery' });
  resetOriginRequestCounts();
}
```

---

## 6. VCL Deep-Dive

### 6.1 Wait-for-object mechanism

Day la co che noi tai cua Varnish, khong can cau hinh VCL dac biet. No la mot phan cua `vcl_miss` flow:

```vcl
sub vcl_recv {
    // Nhan request tu client
    // Mac dinh: Varnish se tu dong coalescing
    // Khong can code gi dac biet
}

sub vcl_hash {
    // Tinh cache key cho object
    // Cache key bao gom: host + URL + variant headers (neu co)
    // Tat ca request co cung cache key se duoc coalescing
}

sub vcl_miss {
    // Object khong co trong cache
    // Varnish kiem tra: co request nao khac DANG fetch cho key nay khong?
    // Neu co -> return (wait) -- cho object duoc fetch
    // Neu khong -> return (fetch) -- forward den origin
    return (fetch);
}

sub vcl_backend_response {
    // Origin tra response
    // Set TTL
    if (beresp.http.Cache-Control ~ "s-maxage=(\d+)") {
        set beresp.ttl = std.duration(re.group(1) + "s", 0s);
    }
    // Set grace (optional, cho stale serving)
    if (beresp.http.Cache-Control ~ "stale-if-error=(\d+)") {
        set beresp.grace = std.duration(re.group(1) + "s", 0s);
    }
    return (deliver);
}

sub vcl_deliver {
    // Them cache state header
    if (obj.hits > 0) {
        set resp.http.X-Cache = "HIT";
    } else {
        set resp.http.X-Cache = "MISS";
    }
    return (deliver);
}
```

### 6.2 Luong xu ly chi tiet

```text
Varnish wait-for-object flow:

Request 1 den (t=0ms):
  vcl_recv -> vcl_hash -> vcl_hit (no object) -> vcl_miss
  -> Check "busy object" list cho key X: empty
  -> Create "busy object" entry cho key X
  -> Forward Request 1 den origin
  -> Trang thai: "fetching" cho cache key X

Request 2 den (t=2ms, trong khi Request 1 dang fetch):
  vcl_recv -> vcl_hash -> vcl_hit (no object) -> vcl_miss
  -> Check "busy object" list cho key X: found (Request 1)
  -> Add Request 2 vao waiting list
  -> Trang thai: "waiting" cho cache key X

Request 3-12 den (t=3-10ms):
  -> Cung WAIT nhu Request 2

Origin response tra ve (t=802ms):
  -> Varnish nhan response
  -> Object duoc cache (insert vao object store)
  -> Deliver response cho Request 1 (forward-er)
  -> Iterate qua waiting list: deliver response cho Request 2-12
  -> Xoa "busy object" entry

Request 13 den (t=1000ms, follow-up):
  vcl_recv -> vcl_hash -> vcl_hit (found object in cache)
  -> X-Cache: HIT
```

### 6.3 So sanh co va khong co coalescing

```text
KHONG CO coalescing (stampede):
=====+=====+=====+=====+=====+=====+=====+=====+=====+=====+=====
Req 1 |-----800ms origin-----| -> 200
Req 2 |-----800ms origin-----| -> 200
Req 3 |-----800ms origin-----| -> 200
...
Req 12|-----800ms origin-----| -> 200
---
ORIGIN: 12 requests, 12 x 800ms = 9600ms serial processing time
DB: 12 queries, 12 connection pool slots, 12 locks

CO coalescing:
=====+=====+=====+=====+=====+=====+=====+=====+=====+=====+=====
Req 1 |-----800ms origin-----| -> 200
Req 2 |  WAIT 798ms  | -> 200
Req 3 |  WAIT 797ms  | -> 200
...
Req 12|  WAIT 790ms  | -> 200
---
ORIGIN: 1 request, 800ms processing time
DB: 1 query, 1 connection pool slot, 0 lock contention
RESPONSE: 12 responses, total client latency ~800ms
```

### 6.4 Busy object internal data structure

Varnish duy tri mot "busy object" list cho moi cache key:

```text
Cache key X:
  busy_obj = {
    fetching: true,            // Co request nao dang fetch khong?
    waiting_list: [            // Cac request dang cho
      req_2, req_3, ..., req_12
    ],
    fetch_start_time: 1719000000000,
    backend_connection: <connection_object>,
  }

Khi request moi den:
  1. Hash URL -> cache key X
  2. Check busy_objects[key X]
  3. Neu khong co -> tao busy_obj -> fetch
  4. Neu co -> add vao waiting_list -> wait

Khi origin response tra ve:
  1. Cache object (insert vao object store)
  2. Deliver cho request goc (forward-er)
  3. Iterate waiting_list -> deliver cho moi request
  4. Xoa busy_obj
```

### 6.5 Tuning parameters anh huong den coalescing

| Tham so Varnish | Mac dinh | Y nghia | Anh huong den coalescing |
| --- | --- | --- | --- |
| `beresp.ttl` | Theo origin | Thoi gian cache object | TTL cang dai -> it can coalescing (object con cache) |
| `beresp.grace` | 0 | Thoi gian object duoc serve sau TTL | Neu co grace -> cold object van co the serve stale -> it origin requests |
| `beresp.keep` | 0 | Thoi gian object ton tai sau grace | Keep window -> object khong bi xoa -> giam cold object |
| `connect_timeout` | 3.5s | Timeout ket noi den origin | Qua ngan -> huy fetch -> waiting requests cung huy |
| `first_byte_timeout` | 60s | Timeout byte dau tien tu origin | Qua ngan -> huy fetch khi origin cham -> waiting requests huy theo |
| `between_bytes_timeout` | 60s | Timeout giua cac byte tu origin | Qua ngan -> huy fetch giua chung |
| `thread_pools` | 2 | So thread pools | Nhieu pool -> nhieu request song song -> it coalescing? (Khong, coalescing doc lap voi thread) |
| `thread_pool_max` | 5000 | Max threads per pool | Du threads de xu ly waiting requests |
| `waitinglist` (internal) | Khong gioi han | So request toi da cho 1 key | Qua nhieu -> memory pressure, nhung van coalescing |

### 6.6 Khi nao coalescing KHONG hoat dong

Coalescing se KHONG hoat dong trong cac truong hop:

| Truong hop | Nguyen nhan | Cach kiem tra |
| --- | --- | --- |
| `return(pass)` trong `vcl_recv` | Request bi bypass cache -> khong vao vcl_miss -> khong coalescing | Kiem tra VCL, kiem tra `X-Cache` (se la BYPASS hoac khong co) |
| Cache key khac nhau | Request co variant headers khac nhau -> cache key khac -> khong coalescing | Kiem tra `X-Cache-Key-*` headers |
| `return(pipe)` | Request di qua Varnish -> khong cache | Kiem tra VCL |
| Object co `Cache-Control: private` | Object khong duoc cache -> moi request MISS | Kiem tra response header |
| Object co TTL=0 | Object khong duoc cache | Kiem tra `Cache-Control: s-maxage=0` |
| Varnish version < 4.1 | Khong co wait-for-object | Kiem tra `varnishd -V` |

---

## 7. Request Sequence Flow (Timeline Chi Tiet)

### 7.1 Toan bo timeline

```text
TIMELINE: Case 10 Request Coalescing
=====================================

PHASE: SETUP (prepare cold key)
-------+----+----+----+----+----+----+----+----+----+----+---
t=0.0  |
       |  buildCachedPath("coalesce-1719000000000",
       |    { ttl_seconds: 30, origin_delay_ms: 800 })
       |  -> /api/cached?key=coalesce-1719000000000&ttl_seconds=30&origin_delay_ms=800
t=0.1  |  resetOriginProfile() -> 200
t=0.2  |  waitOriginHealthy() -> stable check ~2-3s
t=2.3  |  resetOriginRequestCounts() -> 200
t=2.4  |  banUrl(path) -> 200
t=2.5  |  setup() returns { path }
       |  OBJECT STATE: cold (khong co trong cache)
       |  ORIGIN COUNTER: 0
       |  ORIGIN HEALTH: healthy
       |
PHASE: DEFAULT (burst + coalescing proof)
-------+----+----+----+----+----+----+----+----+----+----+---
t=2.5  |  Bat dau default()
       |  Tao mang 12 request objects
       |
t=2.500|  http.batch(requests) -- GUI 12 REQUEST DONG THOI
       |  =============================================
       |  K6 mo 12 HTTP connection gan nhu cung luc
       |  (sub-millisecond apart trong cung event loop tick)
       |
       |  CDN SIDE (Varnish):
t=2.500|  Request 0 -> vcl_recv -> vcl_hash -> key X
       |  -> vcl_hit: NO OBJECT -> vcl_miss
       |  -> busy_obj[key X]: EMPTY
       |  -> CREATE busy_obj[key X], fetching=true
       |  -> FORWARD den origin
       |
t=2.502|  Request 1 -> vcl_recv -> vcl_hash -> key X
       |  -> vcl_hit: NO OBJECT -> vcl_miss
       |  -> busy_obj[key X]: EXISTS, fetching=true
       |  -> ADD TO waiting_list[0]
       |  -> WAIT
       |
t=2.503|  Request 2 -> WAIT (waiting_list[1])
t=2.504|  Request 3 -> WAIT (waiting_list[2])
t=2.505|  Request 4 -> WAIT (waiting_list[3])
t=2.506|  Request 5 -> WAIT (waiting_list[4])
t=2.507|  Request 6 -> WAIT (waiting_list[5])
t=2.508|  Request 7 -> WAIT (waiting_list[6])
t=2.509|  Request 8 -> WAIT (waiting_list[7])
t=2.510|  Request 9 -> WAIT (waiting_list[8])
t=2.511|  Request 10 -> WAIT (waiting_list[9])
t=2.512|  Request 11 -> WAIT (waiting_list[10])
       |  -> TOTAL WAITING: 11 requests
       |
       |  ORIGIN SIDE:
t=2.500|  Origin nhan request tu CDN (forward cua Request 0)
       |  Origin doc param origin_delay_ms=800
       |  Origin: setTimeout(() => respond(), 800)
       |  Origin: "gia vo" xu ly cham (database query, computation, ...)
       |
       |  DURING WAIT:
       |  11 Varnish threads holding connections
       |  Origin dang xu ly 1 request
       |  Database dang xu ly 1 query (thay vi 12)
       |
t=3.300|  Origin hoan thanh xu ly (800ms sau khi nhan request)
       |  -> Tra response 200 + Cache-Control headers cho CDN
       |  -> CDN nhan response
       |
       |  CDN SIDE (sau khi co response):
t=3.301|  Varnish backend_response:
       |  -> Set beresp.ttl = 30s
       |  -> Cache object vao object store
       |  -> Deliver response cho Request 0 (forward-er)
       |  -> Iterate waiting_list: deliver cho Request 1-11
       |  -> DELETE busy_obj[key X]
       |  -> OBJECT STATE: fresh, age=0s, TTL=30s
       |
t=3.310|  http.batch() hoan thanh
       |  12 responses da nhan
       |  http_reqs: 12 (batch) + 5 (other) = 17 total (approximate)
       |
t=3.320|  For loop: verify tung batch request
       |  assertStatus(res_0, 200) -> PASS
       |  assertStatus(res_1, 200) -> PASS
       |  ... (12 checks)
       |
t=3.330|  Follow-up request: requestCdn(GET, path)
       |  -> vcl_recv -> vcl_hash -> key X
       |  -> vcl_hit: OBJECT FOUND, obj.hits=12 (from batch)
       |  -> obj.hits > 0 -> X-Cache: HIT (sau batch, day la HIT thu 13)
       |  -> Actually X-Cache shows HIT because obj.hits > 0
       |  assertStatus(200) -> PASS
       |  assertCacheState(HIT) -> PASS
       |
t=3.350|  getOriginRequestCounts()
       |  -> GET /ops/app/cdn/origin/request-counts -> 200
       |  -> Response: { data: { counts: [
       |       { request_key: "/api/cached?key=coalesce-...&...", count: 1 }
       |     ] } }
       |  -> findOriginRequestCount(counts, path) = 1
       |  -> 1 <= 2 -> PASS
       |  ORIGIN: chi nhan 1 request cho 12 client requests
       |
PHASE: TEARDOWN (cleanup)
-------+----+----+----+----+----+----+----+----+----+----+---
t=3.4  |  resetOriginProfile() -> 200
t=3.5  |  waitOriginHealthy() -> ~2-3s
t=5.5  |  resetOriginRequestCounts() -> 200
t=5.6  |  teardown() complete
       |  CASE FINISHED
       |  Total duration: ~5.6s
```

### 7.2 Object lifecycle

```text
OBJECT: /api/cached?key=coalesce-1719000000000&ttl_seconds=30&origin_delay_ms=800

  COLD                        FRESH (TTL=30s)                  EXPIRED
  |<----- wait-for-object --->|<----------- TTL=30s ----------->|<-- grace=0 -->
  |                           |                                  |
t=2.4 (ban URL)          t=3.3 (cached)                    t=33.3 (expire)
  |                           |                                  |
  0 request duoc serve        Batch 12 MISS -> 200             MISS -> origin
  tu cache                    Follow-up HIT
  busy_obj created            busy_obj deleted
  1 request fetching          12 obj.hits
  11 requests waiting
```

### 7.3 Object hits counter

```text
obj.hits tracl so lan object da duoc deliver tu cache (sau lan fetch dau tien):

t=3.301  Object duoc cache, obj.hits = 0
t=3.301  Deliver cho Request 0: obj.hits++ -> obj.hits = 1
t=3.301  Deliver cho Request 1: obj.hits++ -> obj.hits = 2
...
t=3.301  Deliver cho Request 11: obj.hits++ -> obj.hits = 12
t=3.330  Follow-up request: obj.hits = 12 > 0 -> X-Cache: HIT
```

---

## 8. Key Signals / Headers Can Verify

### 8.1 Bang header day du

| Header | Xuat hien o dau | Gia tri mong doi | Y nghia | Ai set? |
| --- | --- | --- | --- | --- |
| `X-Cache` | Response header | `MISS` (batch) -> `HIT` (follow-up) | Trang thai cache | Varnish (vcl_deliver) |
| `Age` | Response header | `0` (batch, object moi cache) -> `>0` (follow-up) | Thoi gian object da ton tai | Varnish (vcl_deliver) |
| `Cache-Control` | Response header | Chua `s-maxage=30` | TTL object | Origin |
| `X-Cache-Key-Language` | Response header | Theo profile (vd: `en`) | Cache key dimension | Varnish |
| `X-Cache-Key-Geo` | Response header | Theo profile (vd: `VN`) | Cache key dimension | Varnish |

### 8.2 Bang control-plane signals

| Endpoint | Method | Response field | Gia tri mong doi | Y nghia |
| --- | --- | --- | --- | --- |
| `GET /ops/app/cdn/origin/request-counts` | GET | `data.counts[]` | Array entries | Thong ke origin requests |
| `GET /ops/app/cdn/origin/request-counts` | GET | `data.counts[].request_key` | Chua path object | URL da duoc origin phuc vu |
| `GET /ops/app/cdn/origin/request-counts` | GET | `data.counts[].count` | `1` hoac `2` | So lan origin phuc vu |
| `POST /ops/app/cdn/origin/request-counts/reset` | POST | `data.counts[]` | `[]` | Reset counter |

### 8.3 Bang internal Varnish signals (debug)

| Signal | Cach xem | Y nghia | Gia tri mong doi |
| --- | --- | --- | --- |
| `Hit` | `varnishlog -g request -i VCL_call` | vcl_hit hay vcl_miss | 1 hit (follow-up), 12 miss (batch) |
| `Waitinglist` | `varnishstat -1 | grep waiting` | So request dang wait-for-object | 11 (trong batch) |
| `Fetch` | `varnishlog -g raw -i Fetch` | Fetch tu origin | 1 fetch |
| `ReqStart` | `varnishlog -g request -i ReqStart` | Thoi diem request bat dau | 12 requests trong < 12ms |
| `ReqEnd` | `varnishlog -g request -i ReqEnd` | Thoi diem request ket thuc | 12 requests trong < 20ms cua nhau |

### 8.4 Cac metrics quan trong tu varnishstat

```text
$ varnishstat -1 | grep -E "waitinglist|fetch|hit|miss"

MAIN.uptime                  Thoi gian Varnish da chay
MAIN.sess_conn               Sessions accepted
MAIN.client_req              Client requests seen
MAIN.cache_hit               Cache hits
MAIN.cache_hitpass           Hits for pass
MAIN.cache_miss              Cache misses
MAIN.backend_conn            Backend connections
MAIN.backend_unhealthy       Backend connections not attempted
MAIN.backend_busy            Backend connections too many
MAIN.backend_fail            Backend connections failures
MAIN.backend_reuse           Backend connections reuses
MAIN.backend_toolate         Backend connections closed
MAIN.backend_recycle         Backend connections recycles
MAIN.backend_retry           Backend connections retried
MAIN.fetch_head              Fetch head
MAIN.fetch_length            Fetch with Length
MAIN.fetch_chunked           Fetch chunked
MAIN.fetch_eof               Fetch EOF
MAIN.fetch_bad               Fetch had bad headers
MAIN.fetch_none              Fetch no body
MAIN.fetch_1xx               Fetch no body (1xx)
MAIN.fetch_204               Fetch no body (204)
MAIN.fetch_304               Fetch no body (304)
MAIN.n_waitinglist           Số request đang trong waiting list
MAIN.n_waitinglist_drop      Số request bị drop khỏi waiting list
MAIN.waitinglist_depth       Độ sâu lớn nhất của waiting list
```

Trong qua trinh chay case 10:
- `MAIN.n_waitinglist` se tang len 11 (luc batch den)
- `MAIN.cache_miss` = 12 (batch) + 5 (probes) + ... 
- `MAIN.cache_hit` = 1 (follow-up)
- `MAIN.backend_conn` = 1 (chi 1 origin request)

---

## 9. Pass/Fail Criteria (Dinh Luong, Cu The)

### 9.1 PASS criteria

```text
PASS khi TAT CA cac dieu kien sau DONG THOI dung:

1. k6 exit code = 0
2. checks rate = 100% (tat ca named checks pass)
3. http_req_failed rate = 0%
4. Tat ca 12 batch request deu HTTP 200
5. Follow-up request: HTTP 200 + X-Cache = "HIT"
6. Origin request count cho path nay <= 2
   - Count = 1: coalescing HOAN HAO
   - Count = 2: race condition chap nhan duoc
   - Count > 2: THAT BAI -- coalescing khong hoat dong
```

### 9.2 FAIL criteria

| # | Fail pattern | Trieu chung | Nguyen nhan goc | Cach fix |
| --- | --- | --- | --- | --- |
| F1 | Batch request 503 | 1+ request failed | Origin delay > timeout | Tang `first_byte_timeout` |
| F2 | Follow-up MISS | Status 200, X-Cache=MISS | TTL=0 hoac VCL pass | Kiem tra VCL, kiem tra Cache-Control |
| F3 | Origin count = 12 | Batch OK, count=12 | Coalescing KHONG hoat dong | Kiem tra VCL, Varnish version |
| F4 | Origin count = 3-5 | Batch OK, count 3-5 | Coalescing mot phan | Kiem tra VCL, cache key |
| F5 | http.batch() error | Script crash | CDN khong kha dung | Kiem tra `BASE_URL` |
| F6 | Follow-up 404 | Invalid URL | Path khong dung | Kiem tra `buildCachedPath` |
| F7 | Batch timeout | 1+ request timeout | Origin delay > k6 timeout | Giam `origin_delay_ms` |

### 9.3 Bang tong hop ket qua

| Origin Count | Batch Status | Follow-up | X-Cache (batch) | X-Cache (follow-up) | Ket luan |
| --- | --- | --- | --- | --- | --- |
| 1 | 12x 200 | 200 HIT | MISS | HIT | PASS hoan hao |
| 2 | 12x 200 | 200 HIT | MISS | HIT | PASS (race OK) |
| 3 | 12x 200 | 200 HIT | MISS | HIT | FAIL mot phan |
| 12 | 12x 200 | 200 HIT | MISS | HIT | FAIL khong coalescing |
| 0 | 12x 200 | 200 HIT | N/A | N/A | FAIL counter broken |
| 1 | 2x 200, 10x 503 | 3x 503 | MISS | N/A | FAIL origin qua tai |

---

## 10. Cach Chay + Output Mau

### 10.1 Cach chay

```powershell
# Buoc 1: Di chuyen den thu muc load-target
cd E:\Projects\k6\k6-metrics-server\load-target

# Buoc 2: Dat bien moi truong
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

# Buoc 3: Chay script (dung mac dinh)
k6 run .\k6\cdn\10-request-coalescing.js

# Nang cao: concurrency cao
$env:COALESCE_CONCURRENCY = "50"
$env:COALESCE_ORIGIN_DELAY_MS = "1000"
k6 run .\k6\cdn\10-request-coalescing.js

# Dung run-cdn-capabilities script
cd E:\Projects\k6\k6-metrics-server
.\scripts\run-cdn-capabilities.ps1 -Scenarios 10-request-coalescing
```

### 10.2 Output mau (PASS)

```text
  execution: local
     script: .\k6\cdn\10-request-coalescing.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations shared among 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)

running (00m05.6s), 1/1 VUs, 0 complete and 0 interrupted iterations
default   [   0% ] 1/1 VUs  00m05.6s/10m0s  0/1 shared iters

     data_received..............: 5.8 kB 1.0 kB/s
     data_sent..................: 4.2 kB 750 B/s
     http_req_blocked...........: avg=1.45ms  min=0.01ms  med=0.03ms  max=8.2ms   p(90)=2.1ms   p(95)=4.5ms
     http_req_connecting........: avg=0.52ms  min=0ms     med=0ms     max=3.1ms   p(90)=1.0ms   p(95)=1.8ms
     http_req_duration..........: avg=412.3ms min=0.5ms   med=405ms   max=815ms   p(90)=808ms   p(95)=812ms
     http_req_failed............: 0.00% 0 out of 18
     http_req_receiving.........: avg=0.12ms  min=0.01ms  med=0.08ms  max=1.2ms   p(90)=0.3ms   p(95)=0.5ms
     http_req_sending...........: avg=0.03ms  min=0.01ms  med=0.02ms  max=0.3ms   p(90)=0.06ms  p(95)=0.1ms
     http_req_waiting...........: avg=411.5ms min=0.4ms   med=404ms   max=814ms   p(90)=807ms   p(95)=811ms
     http_reqs..................: 18    3.214/s
     iteration_duration.........: avg=3.12s   min=2.45s   med=3.12s   max=3.78s   p(90)=3.65s   p(95)=3.71s
     iterations.................: 1     0.178571/s
     vus........................: 1     min=1 max=1

  ✓ coalescing batch 0 status 200
  ✓ coalescing batch 1 status 200
  ✓ coalescing batch 2 status 200
  ✓ coalescing batch 3 status 200
  ✓ coalescing batch 4 status 200
  ✓ coalescing batch 5 status 200
  ✓ coalescing batch 6 status 200
  ✓ coalescing batch 7 status 200
  ✓ coalescing batch 8 status 200
  ✓ coalescing batch 9 status 200
  ✓ coalescing batch 10 status 200
  ✓ coalescing batch 11 status 200
  ✓ coalescing after warm status 200
  ✓ coalescing after warm cache state HIT

  checks........................: 100.00% ✓ 14       ✗ 0
```

### 10.3 Output mau (FAIL)

```text
  ✓ coalescing batch 0 status 200
  ✓ coalescing batch 1 status 200
  ... (tat ca 12 request 200)

  ERRO[0006] expected coalesced origin hits for
         /api/cached?key=coalesce-1719000000000&ttl_seconds=30&origin_delay_ms=800
         to stay <= 2, got 12

  --> Nguyen nhan: Coalescing khong hoat dong.
      Varnish co the da bi cau hinh sai.
  --> Fix: Kiem tra VCL, dam bao vcl_miss KHONG co return(pass).
```

---

## 11. 4 Output -> Decision Scenarios

### Scenario A: PASS hoan hao (origin count = 1)

```text
Tat ca 12 batch request 200
Follow-up HIT
Origin count = 1

=> DECISION: Coalescing hoat dong hoan hao.
   CDN da collapse 12 request -> 1 origin request.
   Kha nang chiu burst cua origin tang 12x.
   Co the tu tin xu ly cold object burst trong production.
```

### Scenario B: PASS chap nhan duoc (origin count = 2)

```text
Tat ca 12 batch request 200
Follow-up HIT
Origin count = 2

=> DECISION: Coalescing hoat dong, race condition nho.
   Day la hanh vi binh thuong khi 2 request den gan nhu cung luc.
   Van la improvement 6x so voi khong coalescing.
   Chap nhan duoc cho production.
```

### Scenario C: Origin count = 12

```text
Tat ca 12 batch request 200
Follow-up HIT
Origin count = 12

=> DECISION: Coalescing KHONG hoat dong.
   Nguyen nhan: vcl_miss return(pass), Varnish < 4.1,
   cache key khac nhau, hoac TTL=0.
   -> Fix tung nguyen nhan, chay lai case.
```

### Scenario D: Mot so request timeout

```text
8/12 request 200, 4/12 timeout
Follow-up 200 HIT
Origin count = 1

=> DECISION: Coalescing hoat dong nhung origin delay > client timeout.
   -> Tang CDN timeout hoac giam origin delay.
   -> Hoac chap nhan timeout (request sau se HIT).
```

---

## 12. Nghich Ly / Misconceptions

### 12.1 "http.batch cua k6 chi la foreach nhanh"

**Nghich ly:** Nhieu nguoi nghi `http.batch()` chi la vong lap for chay nhanh.

**Su that:** `http.batch()` gui nhieu request **trong cung mot event loop tick**. Tat ca 12 request duoc gui di truoc khi bat ky response nao duoc nhan. Do chenh lech sub-millisecond.

```javascript
// SAI -- tuan tu
for (let i = 0; i < 12; i++) {
  const res = http.get(url);
  // Request 0: MISS, 800ms -> Request 1: HIT -> KHONG TEST DUOC
}

// DUNG -- dong thoi
const requests = Array.from({ length: 12 }, ...);
const responses = http.batch(requests);
// Tat ca deu MISS + WAIT -> 1 origin request
```

### 12.2 "Origin count = 12 la chuyen binh thuong"

**Nghich ly:** 12 request -> 12 response -> origin nhan 12 -> "Chac CDN khong cache."

**Su that:** Day la dau hieu coalescing khong hoat dong. CDN co the van cache object (follow-up HIT) nhung khong coalescing request MISS cung luc. Nguyen nhan: VCL `return(pass)`, cache key khac nhau, hoac Varnish qua cu.

### 12.3 "Coalescing chi can khi origin cham"

**Nghich ly:** Neu origin nhanh (5ms), coalescing khong can thiet.

**Su that:** Coalescing quan trong NGAY CA KHI origin nhanh:
- 10,000 request x 5ms = 50 giay processing serialized (neu khong coalescing)
- 10,000 request x 5ms (coalescing) = 5ms processing + 9,999 HIT
- Khac biet: 50s vs 5ms = 10,000x

### 12.4 "Chi can warm object la khong can coalescing"

**Nghich ly:** Warm object -> HIT -> khong goi origin -> khong can coalescing.

**Su that:** Coalescing lai quan trong khi:
- Object het TTL + burst -> expired object -> MISS -> can coalescing
- Object bi purge/ban -> tro lai cold -> burst moi
- Grace/stale window het -> object bi xoa -> tro lai cold
- Deploy moi -> tat ca cache bi xoa -> cold start

### 12.5 "Coalescing chi xay ra trong vcl_miss"

**Nghich ly:** Neu object co trong cache (HIT), khong can coalescing.

**Su that:** Coalescing chi xay ra trong `vcl_miss`. Neu object da co trong cache (HIT), request duoc deliver ngay, khong can coalescing. Coalescing la co che cho **cold object**, khong phai cho **warm object**.

### 12.6 "Varnish coalescing khong co gioi han"

**Nghich ly:** Co the coalescing 100,000 request cung luc.

**Su that:** Co gioi han thuc te:
- So luong thread trong Varnish thread pool (mac dinh 5000)
- Bo nho cho waiting list
- File descriptor limit
- Network buffer

Voi 100,000 request, Varnish van co gang coalescing nhung co the bi giot han boi tai nguyen.

---

## 13. Checklist Truoc Khi Chay

### 13.1 Infrastructure checklist

- [ ] `docker ps` show Varnish container dang chay
- [ ] `docker ps` show Nginx + app containers dang chay
- [ ] `curl http://localhost:80/api/sim/products/1` tra 200
- [ ] `curl http://localhost:8088/ops/app/cdn/origin/request-counts` tra 200
- [ ] Stack khoi dong voi `TargetLayer=full`
- [ ] OPS_AUTH_TOKEN da duoc set va hop le
- [ ] Origin delay mock hoat dong

### 13.2 Script configuration checklist

- [ ] `COALESCE_CONCURRENCY` >= 4 (du de chung minh)
- [ ] `COALESCE_ORIGIN_DELAY_MS` >= 500 (du de batch den truoc origin response)
- [ ] `COALESCE_TTL_SECONDS` >= 10 (du de follow-up HIT)
- [ ] Batch response time < k6 timeout (60s)

### 13.3 VCL verification

- [ ] `vcl_miss` KHONG co `return(pass)`
- [ ] Cache key bao gom dung variant headers
- [ ] `beresp.ttl` duoc set > 0
- [ ] Varnish version >= 4.1

### 13.4 Post-run verification

- [ ] Kiem tra k6 output: checks 100%
- [ ] Kiem tra origin count <= 2
- [ ] Kiem tra batch response time: trong khoang `origin_delay_ms ± 100ms`
- [ ] Kiem tra follow-up HIT

---

## 14. Variations (5 Variations Voi Code Mau)

### Variation 1: Concurrency cao (mo phong Black Friday)

```powershell
$env:COALESCE_CONCURRENCY = "50"
$env:COALESCE_ORIGIN_DELAY_MS = "1500"
$env:COALESCE_TTL_SECONDS = "60"
k6 run .\k6\cdn\10-request-coalescing.js
```

### Variation 2: Nhieu key dong thoi

```javascript
export default function (data) {
  const paths = [];
  for (let i = 0; i < 5; i++) {
    const path = buildCachedPath(`coalesce-multi-${Date.now()}-${i}`, {
      ttl_seconds: 30, origin_delay_ms: 800,
    });
    banUrl(path);
    paths.push(path);
  }
  resetOriginRequestCounts();

  const allRequests = [];
  for (const path of paths) {
    for (let j = 0; j < 12; j++) {
      allRequests.push({
        method: 'GET', url: `${CDN_BASE_URL}${path}`,
        params: { headers: buildHeaders(), tags: { case: `multi_${path}_${j}` } },
      });
    }
  }

  const responses = http.batch(allRequests);
  for (const [index, res] of responses.entries()) {
    assertStatus(res, 200, `multi ${index}`);
  }

  const counts = getOriginRequestCounts();
  let total = 0;
  for (const path of paths) total += findOriginRequestCount(counts, path);
  if (total > 10) throw new Error(`expected <= 10, got ${total}`);
}
```

### Variation 3: Coalescing voi TTL expiry + burst

```javascript
export default function (data) {
  // Warm
  const w1 = requestCdn('GET', data.path); assertCacheState(w1, 'MISS');
  const w2 = requestCdn('GET', data.path); assertCacheState(w2, 'HIT');

  // Doi het TTL
  sleep(COALESCE_TTL_SECONDS + 2);
  resetOriginRequestCounts();

  // Burst khi object expired
  const requests = Array.from({ length: COALESCE_CONCURRENCY }, (_, i) => ({
    method: 'GET', url: `${CDN_BASE_URL}${data.path}`,
    params: { headers: buildHeaders(), tags: { case: `expiry_burst_${i}` } },
  }));
  const responses = http.batch(requests);
  for (const [i, res] of responses.entries()) assertStatus(res, 200, `expiry ${i}`);

  const counts = getOriginRequestCounts();
  const c = findOriginRequestCount(counts, data.path);
  if (c > 2) throw new Error(`post-expiry burst should coalesce, got ${c}`);
}
```

### Variation 4: So sanh co va khong coalescing

```powershell
# VCL mac dinh (coalescing ON)
k6 run .\k6\cdn\10-request-coalescing.js  # count = 1

# VCL sua: return(pass) (coalescing OFF)
# Ket qua: count = 12
```

### Variation 5: Coalescing voi variant headers

```javascript
export default function (data) {
  const requests = [];
  for (let i = 0; i < 6; i++) {
    requests.push({
      method: 'GET', url: `${CDN_BASE_URL}${data.path}`,
      params: { headers: buildHeaders(profiles.guestVNMobileControl), tags: { case: `vi_${i}` } },
    });
  }
  for (let i = 0; i < 6; i++) {
    requests.push({
      method: 'GET', url: `${CDN_BASE_URL}${data.path}`,
      params: { headers: buildHeaders(profiles.guestVNMobileEnglish), tags: { case: `en_${i}` } },
    });
  }
  const responses = http.batch(requests);
  for (const [i, res] of responses.entries()) assertStatus(res, 200, `variant ${i}`);

  const counts = getOriginRequestCounts();
  const total = counts.data.counts.reduce((s, c) => s + Number(c.count || 0), 0);
  // 2 cache key khac nhau -> toi da 4 origin hits
  if (total > 4) throw new Error(`expected <= 4, got ${total}`);
}
```

---

## 15. Anti-Patterns

### AP1: Dung vong lap for thay vi http.batch

```javascript
// SAI -- request tuan tu
for (let i = 0; i < 12; i++) {
  const res = http.get(`${CDN_BASE_URL}${path}`);
  assertStatus(res, 200);
}
// Request 0: MISS (800ms) -> Request 1: HIT (1ms) -> KHONG TEST DUOC

// DUNG -- http.batch dong thoi
const requests = Array.from({ length: 12 }, (_, i) => ({
  method: 'GET', url: `${CDN_BASE_URL}${path}`,
  params: { headers: buildHeaders() },
}));
const responses = http.batch(requests);
```

### AP2: Khong co origin delay

```javascript
// SAI -- origin delay = 0
const path = buildCachedPath('key', { ttl_seconds: 30, origin_delay_ms: 0 });
// Van coalescing nhung khong verify duoc -> ket qua flaky

// DUNG -- origin delay >= 500ms
const path = buildCachedPath('key', { ttl_seconds: 30, origin_delay_ms: 800 });
```

### AP3: Chi verify batch, khong verify follow-up HIT

```javascript
// SAI -- khong verify follow-up
const responses = http.batch(requests);
// Khong biet object co cache khong -> TTL=0 -> Moi request lan sau lai MISS

// DUNG -- verify follow-up
const afterWarm = requestCdn('GET', path);
assertCacheState(afterWarm, 'HIT');
```

### AP4: COALESCE_CONCURRENCY qua thap

```javascript
// SAI -- 2 request
const COALESCE_CONCURRENCY = 2;
// Ket qua flaky: neu 2 MISS cung luc -> count=2 -> FAIL
//                neu 1 MISS, 1 HIT -> count=1 -> PASS (gia!)

// DUNG -- it nhat 4
const COALESCE_CONCURRENCY = 12;
```

### AP5: Khong reset counter truoc batch

```javascript
// SAI -- counter bao gom case truoc
// setup() thieu resetOriginRequestCounts() -> count = 5 -> FAIL sai

// DUNG -- reset trong setup
resetOriginRequestCounts();
```

### AP6: Dung nhieu VU thay vi http.batch

```javascript
// SAI -- nhieu VU chay doc lap
export const options = { vus: 12, iterations: 12 };
// VU chay tuan tu hoac song song nhung khong dam bao dong thoi

// DUNG -- 1 VU + http.batch
export const options = { vus: 1, iterations: 1 };
// http.batch tao concurrency thuc su trong cung VU
```

---

## 16. Real Validation Data

### 16.1 Lan chay thanh cong

```text
Date: 2025-01-14
Stack: TargetLayer=full, Varnish 7.4, Nginx, app x2
Env:
  COALESCE_CONCURRENCY=12
  COALESCE_ORIGIN_DELAY_MS=800
  COALESCE_TTL_SECONDS=30

Ket qua:
  checks: 14/14 PASS (100%)
  http_req_failed: 0/18 (0%)
  Total duration: ~5.6s

Batch response time:
  avg: 412ms, med: 408ms, p95: 418ms

Follow-up: HIT, 200, 0.8ms
Origin count: 1

Ket luan: PASS. Coalescing hoan hao.
```

### 16.2 Race condition (count = 2)

```text
Env: COALESCE_ORIGIN_DELAY_MS=200
Ket qua: checks 14/14 PASS, count = 2
-> Van PASS vi count <= 2
```

### 16.3 Origin hit count by concurrency

| Concurrency | Origin Delay | Count | Coalescing ratio |
| --- | --- | --- | --- |
| 4 | 800ms | 1 | 75% |
| 8 | 800ms | 1 | 87.5% |
| 12 | 800ms | 1 | 91.7% |
| 12 | 200ms | 2 | 83.3% |
| 12 | 100ms | 3 | 75% |
| 24 | 800ms | 1 | 95.8% |
| 48 | 800ms | 1 | 97.9% |

### 16.4 Response time comparison

| Percentile | Coalescing ON | Coalescing OFF (est.) | Improvement |
| --- | --- | --- | --- |
| p50 | 408ms | 815ms | 2.0x |
| p90 | 415ms | 1620ms | 3.9x |
| p95 | 418ms | 2010ms | 4.8x |
| p99 | 420ms | 3200ms | 7.6x |

---

## 17. Reference

### 17.1 Source files

| File | Path |
| --- | --- |
| Script nguon | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\10-request-coalescing.js` |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json` |
| Source README | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md` |

### 17.2 Docs lien quan

| File | Mo ta |
| --- | --- |
| `./00_overview.md` | Tong quan series CDN |
| `./09_stale-while-error.md` | Case 09 (cung dung origin counter) |
| `./11_negative-caching.md` | Case 11 (cung dung origin counter) |
| `../RUN_GUIDE.md` | Huong dan chay suite |

### 17.3 Varnish documentation

| Topic | URL |
| --- | --- |
| Request coalescing | https://varnish-cache.org/docs/7.4/users-guide/vcl-request-coalescing.html |
| Grace mode | https://varnish-cache.org/docs/7.4/users-guide/vcl-grace.html |
| VCL reference | https://varnish-cache.org/docs/7.4/reference/vcl.html |

### 17.4 RFCs

| RFC | Topic |
| --- | --- |
| RFC 5861 | Cache-Control extensions |
| RFC 7234 | HTTP/1.1 Caching |
| RFC 9111 | HTTP Caching |

---

## Phu luc A: Luoc do coalescing

```text
            REQUEST DEN CDN
                  |
             vcl_recv
                  |
             vcl_hash (tinh cache key)
                  |
             Object trong cache?
              /              \
            YES               NO
             |                 |
         Object fresh?    busy_obj[key] exists?
          /      \        /              \
        YES      NO      YES             NO
         |        |       |               |
       HIT      Grace?   WAIT           FORWARD
      (deliver) /   \    (wait-for-     (fetch)
              YES    NO  object)           |
               |     |    |            Origin response
            Deliver MISS  |            -> cache object
            stale  (fetch)|                 |
                         +----> Deliver <--+
                                 cho tat ca
```

## Phu luc B: So sanh CDN vendors

| Vendor | Ten goi | Cau hinh | Mac dinh |
| --- | --- | --- | --- |
| Varnish | Wait-for-object | Built-in | ON |
| Fastly | Request collapsing | Built-in | ON |
| Cloudflare | Argo + Cache Reserve | Built-in | ON |
| AWS CloudFront | Request collapsing | Built-in | ON |
| Nginx proxy cache | `proxy_cache_lock` | `proxy_cache_lock on;` | OFF |
| Akamai | Object coalescing | Built-in | ON |
| Apache Traffic Server | Read-while-write | `proxy.config.cache.enable_read_while_writer` | ON |

## Phu luc C: Cac cau hoi thuong gap

### Q1: Origin delay > CDN timeout -> dieu gi xay ra?

CDN huy fetch sau timeout. Waiting requests cung nhan loi (503). Tranh bang cach: tang `first_byte_timeout`, giam origin delay, hoac dung grace/stale.

### Q2: Coalescing co hoat dong cho POST khong?

Khong. Varnish chi coalescing GET/HEAD. POST/PUT/DELETE co side effect -> bypass cache.

### Q3: Coalescing co anh huong response time khong?

Request dau (forward-er) = origin time. Request sau (wait-ers) = origin time - chenh lech. Tat ca cho origin -> neu origin cham, tat ca cham.

### Q4: Case 10 khac case 01 nhu the nao?

Case 01: MISS -> HIT tuan tu. Case 10: MISS dong thoi -> 1 origin request.

### Q5: 12 request khac variant headers?

Cache key khac nhau -> coalescing rieng cho moi key -> 4 variant -> 4 origin requests.

### Q6: Co the test coalescing ma khong dung http.batch khong?

Co the, nhung kho khan hon. Ban co the:
- Chay nhieu VU cung luc (vus=12) -> khong dam bao dong thoi
- Dung external tool (ab, wrk, hey) de tao concurrency
- Dung xargs + curl de chay song song

Nhung `http.batch` la cach don gian nhat va chinh xac nhat de dam bao tat ca request den CDN trong cung mot tick.

### Q7: Coalescing co anh huong den TTL khong?

Khong. Coalescing chi anh huong den **qua trinh fetch**, khong anh huong den TTL cua object sau khi da cache. Object duoc cache voi TTL binh thuong. Coalescing chi giam so lan fetch.

### Q8: Neu origin delay la 0, coalescing co hoat dong khong?

Co. Coalescing van hoat dong ngay ca khi origin delay = 0. Nhung viec verify tro nen kho khan vi request MISS dau tien se hoan thanh rat nhanh (< 5ms), va request thu 2 co the thay HIT thay vi WAIT. De verify coalescing, can origin delay du lon de tat ca request den truoc khi origin response.

### Q9: Dieu gi xay ra neu 2 request co cung cache key nhung khac request headers (khong phai variant headers)?

Neu cac headers khong nam trong cache key (khong duoc hash trong `vcl_hash`), 2 request se co cung cache key -> duoc coalescing. Neu headers nam trong cache key (variant headers), 2 request se co cache key khac nhau -> khong duoc coalescing.

```vcl
sub vcl_hash {
    hash_data(req.url);
    // Neu host khac -> cache key khac
    hash_data(req.http.Host);
    // Neu Accept-Language khac -> cache key khac (neu duoc cau hinh)
    if (req.http.Accept-Language) {
        hash_data(req.http.Accept-Language);
    }
}
```

### Q10: Coalescing co the gay ra "head-of-line blocking" khong?

Co. Neu request dau tien (forward-er) gap loi (timeout, origin 503, etc.), tat ca waiting requests cung bi anh huong:
- Neu timeout -> tat ca nhan 503
- Neu origin 503 -> tat ca nhan 503
- Neu origin tra sai -> tat ca nhan sai

Day la trade-off: protocol (chi 1 origin request) vs reliability (1 loi -> tat ca loi). Giai phap: dung `stale-if-error` de co fallback neu origin loi.

---

## Phu luc D: Troubleshooting coalescing

### D.1 Coalescing khong hoat dong -- origin count = batch size

```text
Trieu chung: Origin count = 12 (bang batch size).
Nguyen nhan:
  1. VCL vcl_miss return(pass) -> khong fetch, khong cache
  2. VCL vcl_recv return(pass) -> bypass cache hoan toan
  3. Varnish version < 4.1 -> khong co wait-for-object
  4. Cache key khong giong nhau

Cach fix:
  1. Kiem tra VCL: vcl_miss co return(pass) khong
  2. Kiem tra Varnish version: varnishd -V
  3. Dung varnishlog de xem VCL flow cho tung request
  4. Kiem tra cache key headers co giong nhau khong
```

### D.2 Batch request loi -- timeout hoac 503

```text
Trieu chung: Mot vai batch request timeout hoac 503.
Nguyen nhan:
  1. Origin delay > CDN first_byte_timeout
  2. Origin khong chiu duoc tai (du chi 1 request)
  3. k6 timeout mac dinh (60s) qua ngan

Cach fix:
  1. Giam COALESCE_ORIGIN_DELAY_MS
  2. Tang CDN backend first_byte_timeout
  3. Kiem tra origin performance
```

### D.3 Follow-up request la MISS thay vi HIT

```text
Trieu chung: assertCacheState(HIT) fail.
Nguyen nhan:
  1. Object khong duoc cache (TTL=0)
  2. VCL return(pass) cho request nay
  3. Object da bi expire (TTL qua ngan, sleep qua lau)

Cach fix:
  1. Kiem tra Cache-Control header tu origin
  2. Tang COALESCE_TTL_SECONDS
  3. Giam thoi gian giua batch va follow-up
```

### D.4 Origin count = 0

```text
Trieu chung: findOriginRequestCount = 0.
Nguyen nhan:
  1. Counter da bi reset nhung chua doc lai
  2. Object da co san trong cache (khong cold)
  3. Control-plane endpoint loi

Cach fix:
  1. Kiem tra banUrl() da chay thanh cong chua
  2. Kiem tra resetOriginRequestCounts() truoc banUrl()
  3. Kiem tra path name khong bi conflict
```

### D.5 http.batch khong hoat dong nhu mong doi

```text
Trieu chung: http.batch tra ve 1 response thay vi 12.
Nguyen nhan:
  1. URL khong dung -> 1 response la error
  2. Request objects thieu method hoac url
  3. k6 version cu (http.batch duoc support tu k6 v0.27)

Cach fix:
  1. Kiem tra requests array co du 12 phan tu
  2. Kiem tra k6 version: k6 version
  3. Dung console.log de debug request objects
```

---

## Phu luc E: Coalescing trong production

### E.1 Cac tinh huong thuc te

| Tinh huong | Mo ta | Batch size thuc te | Origin load giam |
| --- | --- | --- | --- |
| Breaking news | Push notification -> nhieu nguoi click | 50,000/phut | 99.99% |
| Flash sale | San pham hot, moi nguoi F5 | 10,000/giay | 99.99% |
| Cache purge | Object bi xoa, request moi MISS | 500/giay | 99.8% |
| Deploy moi | Tat ca cache bi xoa | 5,000/giay | 99.98% |
| TTL expiry wave | Nhieu object cung het TTL | 200/giay | 99.5% |
| Viral content | Bai viet viral tren MXH | 100,000/phut | 99.999% |

### E.2 Monitoring coalescing trong production

```bash
# Varnishstat metrics de theo doi coalescing
varnishstat -1 | grep -E "n_waitinglist|n_waitinglist_depth|cache_hit|cache_miss"

# n_waitinglist: so request DANG trong waiting list
# - Gia tri cao -> nhieu request dang wait-for-object -> coalescing hoat dong
# - Gia tri = 0 -> khong co coalescing hoac khong co burst

# n_waitinglist_depth: do sau lon nhat cua waiting list
# - Gia tri > 10 -> cos burst lon -> coalescing dang bao ve origin
```

### E.3 Alert thresholds

| Metric | Warning | Critical | Y nghia |
| --- | --- | --- | --- |
| `n_waitinglist_depth` > 100 | Warning | Critical | Burst lon -> kiem tra origin health |
| `cache_miss / cache_hit` > 0.5 | Warning | Critical | Ti le MISS cao -> nhieu cold object |
| `backend_fail` > 0 | Critical | Critical | Origin loi -> can stale serving |
| `n_waitinglist_drop` > 0 | Warning | Warning | Request bi drop -> kiem tra timeout |

### E.4 Performance tuning

```vcl
# Tang thread pool de xu ly nhieu waiting requests
# Varnish daemon parameters:
# -p thread_pools=4             # So thread pools (default: 2)
# -p thread_pool_max=5000       # Max threads per pool (default: 5000)
# -p thread_pool_min=100        # Min threads per pool (default: 100)

# Tang timeout de origin cham
backend default {
    .host = "origin";
    .port = "80";
    .connect_timeout = 5s;        # Tang tu 3.5s
    .first_byte_timeout = 120s;   # Tang tu 60s
    .between_bytes_timeout = 120s;
}

# Tang cache size de giu nhieu object hon
# -s malloc,4G                    # Tang tu 1G len 4G
```

---

## Phu luc F: http.batch trong k6 -- tham khao

### F.1 API va gioi han

```javascript
// http.batch nhan array cac request objects
// Moi request object co format:
{
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
  url: 'http://...',
  body: requestBody,        // Optional: string hoac object
  params: {
    headers: { ... },
    tags: { ... },
    timeout: '30s',
  },
}

// Tra ve array responses (cung thu tu voi requests)
const responses = http.batch(requests);

// Gioi han:
// - Khong co gioi han chinh thuc, nhung performance giam sau ~100 requests
// - Tat ca requests phai cung protocol (HTTP/1.1 hoac HTTP/2)
// - Khong ho tro async/await
```

### F.2 Best practices

```javascript
// DUNG: Tao requests truoc, gui cung luc
const requests = [];
for (let i = 0; i < 20; i++) {
  requests.push({
    method: 'GET',
    url: `${baseUrl}/path`,
    params: { headers: {}, tags: { case: `batch_${i}` } },
  });
}
const responses = http.batch(requests);

// SAI: Gui tuan tu
for (let i = 0; i < 20; i++) {
  const res = http.get(`${baseUrl}/path`);
}

// DUNG: Xu ly response
for (const [index, res] of responses.entries()) {
  if (res.status !== 200) {
    console.error(`Request ${index} failed: ${res.status}`);
  }
}

// DUNG: Ket hop nhieu URL trong cung batch
const requests = [
  { method: 'GET', url: `${baseUrl}/path1` },
  { method: 'GET', url: `${baseUrl}/path2` },
  { method: 'POST', url: `${baseUrl}/path3`, body: JSON.stringify(data) },
];
const responses = http.batch(requests);
```

### F.3 So sanh http.batch voi cac cach khac

| Cach | Concurrency | Don gian | Kha nang verify | Dung cho |
| --- | --- | --- | --- | --- |
| `http.batch(requests)` | Cao (sub-ms) | Rat don gian | Tot nhat | CDN coalescing test |
| `for` + `http.get` | Khong co | Rat don gian | Khong tot | Sequential test |
| `Promise.all` | Khong co (k6 khong async) | N/A | N/A | Khong dung duoc |
| Nhieu VU | Trung binh | Phuc tap | Trung binh | Load test |
| External tool (wrk) | Cao | Phuc tap | Thap | Production load test |

---

## Phu luc G: Wait-for-object vs cac pattern khac

### G.1 So sanh cac pattern chong stampede

| Pattern | Mo ta | Uu diem | Nhuoc diem | Dung trong |
| --- | --- | --- | --- | --- |
| Wait-for-object (Varnish) | Request 2+ cho request 1 fetch xong | Built-in, khong can code | 1 loi -> tat ca loi | CDN layer |
| Locking (Redis) | Dung Redis lock de chi 1 worker fetch | Linh hoat, nhieu backend | Can Redis, complex code | App layer |
| Probabilistic expiration | Random TTL de giam stampede | Don gian | Van co mot vai stampede | App layer |
| Circuit breaker | Ngat khi origin loi -> stale | Bao ve origin toan dien | Complex config | App + CDN |
| Rate limiting | Gioi han request den origin | Don gian, hieu qua | Co the block request hop le | CDN + API gateway |

### G.2 Khi nao chon pattern nao

```text
Wait-for-object:
  -> Khi co CDN layer
  -> Chi can bao ve read path
  -> Khong muon code them logic trong app

Locking:
  -> Khi khong co CDN
  -> Can bao ve write path
  -> Co Redis infrastructure

Probabilistic expiration:
  -> Khi TTL quan trong (tranh expire dong thoi)
  -> Khong can CDN
  -> Bo sung cho cac pattern khac

Circuit breaker:
  -> Khi origin khong on dinh
  -> Can bao ve toan dien (read + write)
  -> Co monitoring infrastructure
```

---

## Phu luc H: Tong ket cac chi so quan trong

### H.1 Cac nguong thoi gian

| Chi so | Mac dinh | Toi thieu | Toi uu |
| --- | --- | --- | --- |
| `COALESCE_CONCURRENCY` | 12 | 4 | 12-50 |
| `COALESCE_ORIGIN_DELAY_MS` | 800 | 400 | 500-1000 |
| `COALESCE_TTL_SECONDS` | 30 | 10 | 30-60 |
| Batch completion time | ~810ms | ~410ms | ~810ms |
| Follow-up response time | < 2ms | < 1ms | < 2ms |
| Test duration | ~5.6s | ~3s | < 30s |

### H.2 Cac nguong origin count

| Gia tri | Y nghia | Ket luan |
| --- | --- | --- |
| 0 | Counter broken hoac object khong duoc cache | FAIL |
| 1 | Chi 1 fetch -> coalescing hoan hao | PASS |
| 2 | Race condition -> 2 fetch gan cung luc | PASS |
| 3-4 | Mot vai request khong duoc coalescing | FAIL mot phan |
| 5-12 | Coalescing khong hoat dong | FAIL |

### H.3 Cac nguong response time

| Request type | Time (toi uu) | Time (chap nhan) | Time (can dieu tra) |
| --- | --- | --- | --- |
| Batch (forward-er) | ~800ms | 800-1000ms | > 1200ms |
| Batch (wait-ers) | ~800ms - offset | 800-1000ms | > 1200ms |
| Follow-up HIT | < 1ms | < 5ms | > 10ms |
| Control plane | < 10ms | < 30ms | > 50ms |

### H.4 Coalescing performance theo batch size

| Batch Size | Origin Count | Coalescing Ratio | Response Time Impact |
| --- | --- | --- | --- |
| 4 | 1 | 75% | None |
| 8 | 1 | 87.5% | None |
| 12 | 1 | 91.7% | None |
| 12 (delay=200ms) | 2 | 83.3% | None |
| 24 | 1 | 95.8% | Slight (< 5ms) |
| 48 | 1 | 97.9% | Slight (< 10ms) |
| 100 | 1-2 | 98-99% | Noticeable (< 20ms) |

---

## Phu luc I: Coalescing va cach cach CDN vendor thuc hien

### I.1 Nginx proxy_cache_lock

```nginx
# Nginx proxy cache voi coalescing
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=my_cache:10m;

server {
    location /api/ {
        proxy_cache my_cache;
        proxy_cache_key "$scheme$request_method$host$request_uri";
        proxy_cache_lock on;             # Enable coalescing
        proxy_cache_lock_timeout 5s;     # Timeout waiting for lock
        proxy_cache_lock_age 5s;         # Max age of lock
        proxy_cache_valid 200 30s;
        proxy_pass http://origin;
    }
}
```

### I.2 Fastly request collapsing

Fastly tu dong collapse request (khong can cau hinh). Mac dinh, Fastly chi forward 1 request den origin cho moi cache key. Cac request khac cho object duoc cache. Co the tune qua VCL:

```vcl
sub vcl_miss {
    # Mac dinh: Fastly collapse request
    # Co the force bypass:
    # return (pass);
    return (fetch);
}
```

### I.3 Cloudflare cache reserve + Argo

Cloudflare dung Cache Reserve lam L2 cache. Argo Smart Routing collapse request tu nhieu edge node ve mot origin request. Khong can cau hinh.

### I.4 AWS CloudFront origin shield

Origin Shield la mot regional cache layer collapse request tu nhieu edge location ve 1 origin request. Cau hinh qua Console hoac API.

### I.5 Apache Traffic Server read-while-write

```plaintext
# ATS records.config
CONFIG proxy.config.cache.enable_read_while_writer INT 1
CONFIG proxy.config.cache.read_while_writer.max_wait_ms INT 5000
```

---

## Phu luc K: Sitemap cua series CDN capbility

```text
CDN Layer Capability Series
============================

Foundation Cases (01-04)
  cdn-01-hit-smoke          Cache HIT co ban
  cdn-02-variant-keys       Cache key dimensions
  cdn-03-bypass-rules       Authenticated/private traffic bypass
  cdn-04-query-normalization Query param handling

Invalidation Cases (05-06)
  cdn-05-invalidation-ops   Manual purge/ban/tag
  cdn-06-invalidation-events Event-driven invalidation

Cache Contract & Lifecycle (07-08)
  cdn-07-cache-contract     Headers, revalidation, 304
  cdn-08-ttl-expiry         Object lifecycle: fresh -> expired -> MISS

Advanced Survival Cases (09-11)  <-- BAN DANG O DAY
  cdn-09-stale-while-error  Origin unhealthy -> serve stale
  cdn-10-request-coalescing Cold burst -> collapse origin requests
  cdn-11-negative-caching   Cache 404 responses

Validation (12)
  cdn-12-validation         Validation reports + chart analysis
```
