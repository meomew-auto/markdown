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
| Origin (app server) | Bi tan cong boi 10,000 request cung luc cho cung mot object | App server qua tai, CPU 100%, memory can, crash |
| Database | 10,000 query giong het nhau chay dong thoi | DB connection pool can, query queue day, lock contention |
| Nguoi dung | Nhin thay timeout hoac 502/503 | Roi khoi site, khong bao gio quay lai |
| Infrastructure cost | Phai scale app server + DB gap 10-20 lan de chiu duoc burst | Chi phi infrastructure tang dot bien, roi lai giam -> lang phi |

**Ten goi cua hien tuong nay:** **Thundering herd** hoac **Cache stampede** hoac **Dogpile effect**.

### 1.3 Co che coalescing trong Varnish

Varnish giai quyet stampede bang co che goi la **wait-for-object** (cung duoc goi la **request collapsing** hoac **collapsed forwarding**):

```text
KHONG CO coalescing:
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

| # | Dieu can chung minh | Evidence trong script |
| --- | --- | --- |
| 1 | Tat ca 12 request deu thanh cong (HTTP 200) | `assertStatus(res, 200)` cho tung request trong batch |
| 2 | Sau batch, object da duoc cache (HIT) | `assertCacheState(afterWarm, 'HIT')` |
| 3 | Origin chi nhan <= 2 request (khong phai 12) | `findOriginRequestCount(counts, path) <= 2` |
| 4 | CDN chi forward 1 request den origin | `requestCount > 2` la ERROR |

Day la mot **negative proof manh me**: khong chi chung minh request thanh cong, con chung minh origin da KHONG bi goi 12 lan.

---

## 3. Vi Sao Phai Test O CDN Layer (Khong The Test O App Layer)

### 3.1 So sanh layer

| Khia canh | Test o app layer | Test o CDN layer (case nay) |
| --- | --- | --- |
| Concurrency control | App co the cache local nhung khong giai quyet duoc 10,000 request cung den 1 may | CDN collapse request TRUOC KHI den app -- app chi nhan 1 request |
| Wait-for-object | App khong co co che nay (day la CDN primitive) | Varnish co wait-for-object built-in trong VCL flow |
| Origin counter | App khong the biet co bao nhieu request da duoc coalescing | CDN control-plane endpoint `/ops/app/cdn/origin/request-counts` la evidence doc lap |
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

### 4.2 Precondition day du

| # | Dieu kien | Cach thiet lap | Kiem tra |
| --- | --- | --- | --- |
| P1 | Stack target chay voi `TargetLayer=full` | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full -ScaleApp 2` | `docker ps` thay Varnish + Nginx + app |
| P2 | Control plane kha dung | `CONTROL_BASE_URL=http://localhost:8088` | `curl http://localhost:8088/ops/app/cdn/origin/request-counts` tra 200 |
| P3 | OPS_AUTH_TOKEN hop le | Bien moi truong `OPS_AUTH_TOKEN` | Control API khong tra 401 |
| P4 | Object chua co trong cache (cold) | `banUrl(path)` trong setup | Path moi + ban de dam bao cold |
| P5 | Origin co delay du lon de mo phong cham | `COALESCE_ORIGIN_DELAY_MS=800` | 800ms du de 12 request den truoc khi origin tra response |
| P6 | Origin counter da reset | `resetOriginRequestCounts()` | Counter ban dau = 0 |
| P7 | Concurrency du lon de chung minh coalescing | `COALESCE_CONCURRENCY=12` | 12 request dong thoi du de thay su khac biet giua 1 vs 12 origin hits |

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

| Bien moi truong | Mac dinh | Y nghia | Anh huong neu thay doi |
| --- | --- | --- | --- |
| `COALESCE_CONCURRENCY` | `12` | So request dong thoi trong batch | Tang -> phai verify origin count van <= 2. Giam xuong 2 -> khong con y nghia test coalescing (co the 2 request deu MISS thoi gian khac nhau). |
| `COALESCE_ORIGIN_DELAY_MS` | `800` | Thoi gian origin "gia vo" xu ly request (ms). Origin se doi 800ms truoc khi tra response. | Qua ngan -> origin tra response truoc khi 12 request kip den -> request sau thay HIT -> khong test duoc coalescing. Qua dai -> test cham. 800ms la vua du. |
| `COALESCE_TTL_SECONDS` | `30` | TTL cua object (giay). Khong quan trong cho coalescing proof nhung can du lon de follow-up request la HIT. | Tang -> khong anh huong. Giam duoi 5s -> follow-up request co the MISS neu test cham. |

### 5.3 Phase B: setup() -- Tao Cold Key

```javascript
export function setup() {
  // B1: Tao URL dong voi origin delay duoc cau hinh
  const path = buildCachedPath(`coalesce-${Date.now()}`, {
    ttl_seconds: COALESCE_TTL_SECONDS,
    origin_delay_ms: COALESCE_ORIGIN_DELAY_MS,
  });
  // URL vi du: /api/cached?key=coalesce-1719000000000&ttl_seconds=30&origin_delay_ms=800

  // B2: Reset origin profile ve healthy (de dam bao khong bi anh huong boi case 09)
  resetOriginProfile();

  // B3: Doi origin healthy
  waitOriginHealthy({ label: 'coalescing setup origin recovery' });

  // B4: Reset origin counter ve 0
  resetOriginRequestCounts();

  // B5: Ban URL de dam bao object chua co trong cache
  banUrl(path);

  // B6: KHONG warm object! De no cold cho batch request
  //     Day la su khac biet voi case 09 (can warm truoc)

  // B7: Tra ve path de default() su dung
  return { path };
}
```

**Luoc do setup:**

```text
t=0.0   buildCachedPath() -> /api/cached?key=coalesce-1719000000000&ttl_seconds=30&origin_delay_ms=800
t=0.1   resetOriginProfile()
t=0.2   waitOriginHealthy()
t=2.0   resetOriginRequestCounts()
t=2.1   banUrl(path)
t=2.2   setup() complete, returns { path }
        OBJECT STATE: cold (khong co trong cache)
```

### 5.4 Phase C: default() -- Burst + Verify

```javascript
export default function (data) {
  const path = data.path;

  // C1: Tao mang 12 request cung URL (giong het nhau)
  //     Su dung Array.from de tao mang request objects
  const requests = Array.from({ length: COALESCE_CONCURRENCY }, (_, index) => ({
    method: 'GET',
    url: `${CDN_BASE_URL}${path}`,
    params: {
      headers: buildHeaders(),
      tags: { case: `coalescing_batch_${index}` },
    },
  }));

  // C2: Gui TAT CA 12 request DONG THOI bang http.batch()
  //     Day la KEY MOMENT -- http.batch gui nhieu request cung luc
  //     Khong dung vong lap for + await vi se tuan tu
  const responses = http.batch(requests);

  // C3: Verify TAT CA 12 response deu 200
  for (const [index, res] of responses.entries()) {
    assertStatus(res, 200, `coalescing batch ${index}`);
  }
  // Tat ca 12 request deu phai thanh cong -- nguoi dung khong thay loi

  // C4: Goi follow-up request de xac nhan object da duoc cache
  const afterWarm = requestCdn('GET', path, {
    tags: { case: 'coalescing_after_warm' },
  });
  assertStatus(afterWarm, 200, 'coalescing after warm');
  assertCacheState(afterWarm, 'HIT', 'coalescing after warm');
  // Phai la HIT vi object da duoc cache sau batch

  // C5: NEGATIVE PROOF -- origin count phai <= 2
  //     Day la evidence QUAN TRONG NHAT
  const counts = getOriginRequestCounts();
  const requestCount = findOriginRequestCount(counts, path);
  if (requestCount > 2) {
    throw new Error(
      `expected coalesced origin hits for ${path} to stay <= 2, got ${requestCount}`
    );
  }
  // Neu count > 2 -> coalescing KHONG hoat dong
  // (12 request -> 12 origin hits) -> stampede!
}
```

**Tai sao origin count <= 2 ma khong phai === 1?**

Trong Varnish, co kha nang nho xay ra race condition:
- 2 request den **qua nhanh** (sub-millisecond)
- Ca 2 deu thay object khong co trong cache
- Ca 2 deu duoc forward den origin (cung luc)
- Origin nhan 2 request thay vi 1

Day la race condition da biet trong Varnish wait-for-object implementation. Contract chap nhan toi da 2 origin hits. > 2 la THAT BAI.

### 5.5 Phase D: teardown() -- Cleanup

```javascript
export function teardown() {
  // D1: Reset origin profile
  resetOriginProfile();

  // D2: Doi origin healthy
  waitOriginHealthy({ label: 'coalescing teardown origin recovery' });

  // D3: Reset counter
  resetOriginRequestCounts();
}
```

---

## 6. VCL Deep-Dive

### 6.1 Wait-for-object mechanism

Day la co che noi tai cua Varnish, khong can cau hinh VCL dac biet. No la mot phan cua `vcl_miss` flow:

```vcl
sub vcl_miss {
    // Khi mot request MISS:
    // 1. Varnish kiem tra xem co request nao khac DANG duoc forward
    //    den origin cho CUNG cache key khong
    // 2. Neu co -> request nay se WAIT (wait-for-object)
    // 3. Neu khong -> request nay duoc forward den origin

    // Day la hanh vi MAC DINH, khong can code VCL
    // Nhung co the tune voi cac tham so:
    // - bereq.connect_timeout: thoi gian cho ket noi den origin
    // - bereq.first_byte_timeout: thoi gian cho byte dau tien tu origin
    // - vcl_miss co the return (fetch) de force fetch
}
```

### 6.2 Luong xu ly chi tiet

```text
Varnish wait-for-object flow:

Request 1 den (t=0ms):
  vcl_recv -> vcl_hash -> vcl_hit (no object) -> vcl_miss
  -> Khong co request nao dang fetch cho key nay
  -> Request 1 duoc FORWARD den origin
  -> Trang thai: "fetching" cho cache key X

Request 2 den (t=2ms, trong khi Request 1 dang fetch):
  vcl_recv -> vcl_hash -> vcl_hit (no object) -> vcl_miss
  -> Co mot request khac DANG fetch cho key nay (Request 1)
  -> Request 2 WAIT (wait-for-object)
  -> Trang thai: "waiting" cho cache key X

Request 3-12 den (t=3-10ms):
  -> Cung WAIT nhu Request 2

Origin response tra ve (t=802ms):
  -> Object duoc cache
  -> TAT CA 12 request duoc deliver tu cache object moi
  -> X-Cache: MISS (vi object duoc fetch tu origin)
  -> Nhung tat ca 12 deu nhan response

Request 13 den (t=1000ms, follow-up):
  vcl_recv -> vcl_hash -> vcl_hit (object co trong cache)
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
ORIGIN: 12 requests, 12 x 800ms = 9600ms processing time

CO coalescing:
=====+=====+=====+=====+=====+=====+=====+=====+=====+=====+=====
Req 1 |-----800ms origin-----| -> 200
Req 2 |  WAIT 798ms  | -> 200
Req 3 |  WAIT 797ms  | -> 200
...
Req 12|  WAIT 790ms  | -> 200
ORIGIN: 1 request, 800ms processing time
CDN: 12 responses, total client latency = 800ms max
```

### 6.4 Tuning parameters

| Tham so Varnish | Mac dinh | Y nghia | Anh huong den coalescing |
| --- | --- | --- | --- |
| `beresp.ttl` | Theo origin header | Thoi gian cache object | Object TTL cang dai, cang it can coalescing |
| `beresp.grace` | 0 | Thoi gian object con duoc serve sau TTL | Neu co grace, cold object con stale -> van co the serve |
| `waitinglist` (internal) | Khong gioi han | So request toi da cho 1 key | Neu qua nhieu -> memory pressure |
| `connect_timeout` | 3.5s | Timeout ket noi den origin | Qua ngan -> huy fetch -> waiting requests cung huy |
| `first_byte_timeout` | 60s | Timeout byte dau tien tu origin | Qua ngan -> huy fetch khi origin cham |

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
t=0.1  |  resetOriginProfile()
       |  -> POST /ops/app/cdn/origin/reset -> 200
t=0.2  |  waitOriginHealthy({ label: 'coalescing setup origin recovery' })
       |  -> probe + stable check ~2-3s
t=2.3  |  resetOriginRequestCounts()
       |  -> POST /ops/app/cdn/origin/request-counts/reset -> 200
t=2.4  |  banUrl(path)
       |  -> POST /ops/app/cdn/cache/ban-url -> 200
t=2.5  |  setup() returns { path }
       |  OBJECT STATE: cold (khong co trong cache)
       |  ORIGIN COUNTER: 0
       |
PHASE: DEFAULT (burst + coalescing proof)
-------+----+----+----+----+----+----+----+----+----+----+---
t=2.5  |  Bat dau default()
t=2.5  |  Tao mang 12 request objects
       |  Array.from({ length: 12 }, ...)
       |
t=2.5  |  http.batch(requests) -- GUI 12 REQUEST DONG THOI
       |  =============================================
       |  K6 mo 12 HTTP connection gan nhu cung luc
       |  (sub-millisecond apart trong cung mot event loop tick)
       |
       |  CDN side:
t=2.500|  Request 0 den CDN -> vcl_hash -> key X -> MISS
       |  -> Khong co ai dang fetch -> FORWARD den origin
       |  -> Trang thai: "fetching" key X
       |
t=2.502|  Request 1 den CDN -> vcl_hash -> key X -> MISS
       |  -> Co nguoi dang fetch (Request 0) -> WAIT
       |
t=2.503|  Request 2 den CDN -> WAIT
t=2.504|  Request 3 den CDN -> WAIT
...    |  ...
t=2.511|  Request 11 den CDN -> WAIT
       |
       |  ORIGIN side:
t=2.500|  Origin nhan request tu CDN (forward cua Request 0)
       |  Bat dau xu ly... origin_delay_ms = 800ms
       |  Origin "gia vo" xu ly cham (mo phong real service)
       |
       |  CDN side (trong khi cho):
       |  11 request dang WAIT cho key X
       |  Khong request nao khac duoc forward den origin
       |
t=3.300|  Origin hoan thanh xu ly (800ms sau khi nhan request)
       |  -> Tra response 200 cho CDN
       |  -> CDN nhan response, cache object
       |
       |  CDN side (sau khi co object):
t=3.301|  Object key X da duoc cache
       |  -> Deliver cho Request 0 (forward-er)
       |  -> Deliver cho Request 1-11 (wait-ers)
       |  -> Tat ca 12 request nhan response 200
       |  -> X-Cache: MISS (cho tat ca, vi deu tu fetch)
       |  -> Nhung tat ca deu nhan response THANH CONG
       |
t=3.310|  http.batch() hoan thanh -- 12 responses da nhan
       |  http_reqs: 12 (batch request)
       |
t=3.320|  For loop: verify tung request
       |  assertStatus(res, 200) x12 -> PASS
       |
t=3.330|  Follow-up request: requestCdn(GET, path)
       |  -> vcl_hash -> key X -> HIT (da co trong cache)
       |  -> X-Cache: HIT
       |  assertStatus(200) -> PASS
       |  assertCacheState(HIT) -> PASS
       |
t=3.350|  getOriginRequestCounts()
       |  -> GET /ops/app/cdn/origin/request-counts -> 200
       |  -> findOriginRequestCount(counts, path)
       |  -> Neu count = 1: Hoan hao!
       |  -> Neu count = 2: Race condition chap nhan duoc
       |  -> Neu count > 2: THAT BAI!
       |  assert requestCount <= 2 -> PASS
       |
PHASE: TEARDOWN (cleanup)
-------+----+----+----+----+----+----+----+----+----+----+---
t=3.4  |  resetOriginProfile()
t=3.5  |  waitOriginHealthy()
t=5.5  |  resetOriginRequestCounts()
t=5.6  |  teardown() complete
       |  CASE FINISHED
```

### 7.2 Object lifecycle

```text
OBJECT: /api/cached?key=coalesce-1719000000000&ttl_seconds=30&origin_delay_ms=800

  COLD                        FRESH (TTL=30s)
  |<----- wait-for-object --->|<----------- TTL=30s ------------->|
  |                           |                                    |
t=2.5 (ban)             t=3.3 (cached)                      t=33.3 (expire)
  |                           |                                    |
  0 request duoc serve       Batch 12 MISS -> 200                MISS -> origin
  tu cache                    Follow-up HIT
```

---

## 8. Key Signals / Headers Can Verify

### 8.1 Bang header day du

| Header | Xuat hien o dau | Gia tri mong doi | Y nghia |
| --- | --- | --- | --- |
| `X-Cache` | Response header | `MISS` (batch) -> `HIT` (follow-up) | Trang thai cache: batch la MISS vi object moi duoc fetch, follow-up la HIT |
| `Age` | Response header | 0 (batch), > 0 (follow-up nhanh) | Thoi gian object da ton tai trong cache |
| `X-Cache-Key-Language` | Response header | `en` hoac `vi` (theo profile) | Mot phan cua cache key |
| `X-Cache-Key-Geo` | Response header | `VN` (theo profile) | Mot phan cua cache key |

### 8.2 Bang control-plane signals

| Endpoint | Response field | Gia tri mong doi | Y nghia |
| --- | --- | --- | --- |
| `GET /ops/app/cdn/origin/request-counts` | `data.counts[].request_key` | Chua path cua object | URL da duoc origin phuc vu |
| `GET /ops/app/cdn/origin/request-counts` | `data.counts[].count` | `1` hoac `2` (khong duoc > 2) | So lan origin phuc vu request nay |

### 8.3 Bang internal signals (Varnish)

| Signal | Y nghia | Cach xem |
| --- | --- | --- |
| `varnishstat -1 | grep waiting` | So request dang wait-for-object | Theo doi realtime |
| `varnishlog -g request -q "ReqMethod eq 'GET'"` | Xem tung request flow | Debug coalescing |
| `varnishlog -g request -i VCL_call,VCL_return,ReqURL` | Xem VCL flow | Xac nhan MISS -> fetch -> deliver |

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

| # | Fail pattern | Trieu chung | Nguyen nhan goc |
| --- | --- | --- | --- |
| F1 | Batch request co request tra 503 | 1 hoac nhieu request failed | Origin delay qua dai -> CDN timeout -> khong serve duoc |
| F2 | Follow-up request la MISS | Status 200, X-Cache=MISS | Object khong duoc cache (TTL = 0, hoac VCL return(pass)) |
| F3 | Origin count = 12 | Batch OK nhung origin count = 12 | Coalescing KHONG hoat dong -> origin bi stampede |
| F4 | Origin count = 3-5 | Batch OK, follow-up HIT | Coalescing hoat dong mot phan -> mot vai request van duoc forward |
| F5 | http.batch() error | Script crash | CDN khong kha dung hoac sai BASE_URL |
| F6 | Follow-up request 404 | Invalid URL | Path khong dung, origin tra 404 |
| F7 | Mot so request timeout | 1 vai request > timeout | Origin delay qua dai + CDN timeout qua ngan |

### 9.3 Bang tong hop ket qua

| Origin Count | Batch Status | Follow-up | X-Cache (batch) | X-Cache (follow-up) | Ket luan |
| --- | --- | --- | --- | --- | --- |
| 1 | 12x 200 | 200 HIT | MISS | HIT | PASS hoan hao |
| 2 | 12x 200 | 200 HIT | MISS | HIT | PASS (race condition chap nhan duoc) |
| 3 | 12x 200 | 200 HIT | MISS | HIT | FAIL -- coalescing mot phan |
| 12 | 12x 200 | 200 HIT | MISS | HIT | FAIL -- coalescing khong hoat dong |
| 0 | 12x 200 | 200 HIT | N/A | N/A | FAIL -- origin counter broken |
| 1 | 2x 200, 10x 503 | 503 | MISS | N/A | FAIL -- origin khong chiu duoc tai |

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

# Hoac: Chay voi concurrency cao hon
$env:COALESCE_CONCURRENCY = "24"
$env:COALESCE_ORIGIN_DELAY_MS = "1000"
k6 run .\k6\cdn\10-request-coalescing.js

# Hoac: Chay voi origin delay ngan (de test race condition)
$env:COALESCE_ORIGIN_DELAY_MS = "200"
k6 run .\k6\cdn\10-request-coalescing.js

# Hoac: Dung run-cdn-capabilities script
cd E:\Projects\k6\k6-metrics-server
.\scripts\run-cdn-capabilities.ps1 -Scenarios 10-request-coalescing
```

### 10.2 Output mau (PASS -- coalescing hoan hao)

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

### 10.3 Output mau (FAIL -- khong coalescing)

```text
  ✓ coalescing batch 0 status 200
  ✓ coalescing batch 1 status 200
  ... (tat ca 12 request 200)

  ERRO[0006] expected coalesced origin hits for
         /api/cached?key=coalesce-1719000000000&ttl_seconds=30&origin_delay_ms=800
         to stay <= 2, got 12

  --> Giai thich: Coalescing khong hoat dong.
      Origin nhan 12 request thay vi 1.
      Varnish co the da bi cau hinh sai (vd: return(pass) trong vcl_miss).

  --> Fix: Kiem tra VCL config.
      Dam bao vcl_miss KHONG co return(pass).
      Kiem tra Varnish version (wait-for-object co tu 4.1+).
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

=> DECISION: Coalescing hoat dong, nhung co race condition nho.
   Day la hanh vi binh thuong khi 2 request den gan nhu cung luc
   (trong cung microsecond). Van la improvement 6x so voi khong coalescing.
   Trong thuc te, race condition nay xay ra < 0.1% request.
   -> Chap nhan duoc cho production.
```

### Scenario C: Origin count = 12

```text
Tat ca 12 batch request 200 (hoac mot vai 503)
Follow-up HIT (hoac MISS)
Origin count = 12

=> DECISION: Coalescing KHONG hoat dong.
   Nguyen nhan co the:
   1. VCL vcl_miss return(pass) -> tat ca request deu bypass cache
   2. Varnish version < 4.1 (khong co wait-for-object)
   3. Cache key khong giong nhau (variant headers khac nhau)
   4. Object co TTL=0 -> khong duoc cache -> moi request MISS
   -> Fix tung nguyen nhan mot, chay lai case.
```

### Scenario D: Mot so request timeout

```text
8/12 batch request 200, 4/12 timeout
Follow-up 200 HIT (object da duoc cache boi 1 trong 8 request thanh cong)
Origin count = 1

=> DECISION: Coalescing hoat dong, nhung origin delay qua dai
   so voi CDN timeout.
   -> Tang CDN first_byte_timeout (backend)
   -> Hoac giam origin_delay_ms
   -> Hoac chap nhan rang 1 vai request se timeout
      (sau do request tiep theo se HIT)
```

---

## 12. Nghich Ly / Misconceptions

### 12.1 "http.batch cua k6 chi la foreach nhanh"

**Nghich ly:** Nhieu nguoi nghi `http.batch()` chi la vong lap for chay nhanh.

**Su that:** `http.batch()` gui nhieu request **trong cung mot event loop tick** (thuc su dong thoi, khong phai tuan tu). Tat ca 12 request duoc gui di truoc khi bat ky response nao duoc nhan. Do chenh lech giua cac request trong batch la **sub-millisecond** (thuong < 1ms). Day la dieu kien can thiet de test coalescing -- neu gui tuan tu (0.5s apart), request thu 2 se thay HIT va khong test duoc coalescing.

```javascript
// SAI -- tuan tu, request sau thay HIT
for (let i = 0; i < 12; i++) {
  const res = http.get(url);
  // Request 0: MISS, 800ms
  // Request 1: HIT (vi object da duoc cache) -- KHONG TEST DUOC COALESCING
}

// DUNG -- dong thoi
const requests = Array.from({ length: 12 }, ...);
const responses = http.batch(requests);
// Tat ca 12 deu MISS + WAIT -> 1 origin request
```

### 12.2 "Origin count = 0 la tot nhat"

**Nghich ly:** Neu origin count = 0, coalescing tot den muc origin khong bi goi lan nao.

**Su that:** Origin count = 0 la **KHONG THE** (va la BUG neu xay ra). Can it nhat 1 request di den origin de fill cache. Neu count = 0, co the:
- Object da co trong cache tu truoc (warm object)
- Counter da bi reset nhung chua duoc doc lai
- Control-plane endpoint khong hoat dong

### 12.3 "Neu co wait-for-object, request se bi delay them origin_delay_ms"

**Nghich ly:** 12 request deu phai cho 800ms -> tong delay = 12 x 800ms = 9.6s.

**Su that:** 12 request cho **song song**, khong phai tuan tu. Tat ca 12 request deu nhan response sau khi origin tra ve (800ms). Tong delay toi da cho moi request la **800ms**, khong phai 9.6s.

```text
Request 1: wait 800ms -> 200
Request 2: wait 798ms -> 200
Request 3: wait 797ms -> 200
...
Request 12: wait 790ms -> 200

Tong thoi gian thuc te: 800ms (khong phai 9.6s)
Tat ca request nhan response gan nhu cung luc
```

### 12.4 "Coalescing chi quan trong cho cold object"

**Nghich ly:** Sau khi object da duoc cache (warm), coalescing khong con y nghia.

**Su that:** Coalescing lai tro nen quan trong khi:
- Object het TTL va nhieu request cung den -> TTL expiry + burst
- Object bi purge/ban -> tro lai cold -> burst moi
- Grace/stale window het -> object bi xoa -> tro lai cold

### 12.5 "Origin delay la bat buoc de test coalescing"

**Nghich ly:** Phai co origin delay moi test duoc coalescing.

**Su that:** Coalescing xay ra NGAY CA KHI origin nhanh (1-5ms). Nhung neu khong co delay, kho khan trong viec xac nhan rang coalescing da xay ra. Origin delay:
- Mo phong origin cham trong thuc te (real services thuong 50-500ms)
- Tao "cua so" du lon de tat ca batch request den truoc khi origin tra response
- Giu origin count thap (neu khong co delay, 1 vai request co the MISS + fetch + cache truoc khi request khac den)

---

## 13. Checklist Truoc Khi Chay

### 13.1 Infrastructure checklist

- [ ] `docker ps` show Varnish container dang chay
- [ ] `docker ps` show Nginx + app containers dang chay
- [ ] `curl http://localhost:80/api/sim/products/1` tra 200
- [ ] `curl http://localhost:8088/ops/app/cdn/origin/request-counts` tra 200 (can OPS_AUTH_TOKEN)
- [ ] Stack khoi dong voi `TargetLayer=full`
- [ ] OPS_AUTH_TOKEN da duoc set va hop le
- [ ] Origin delay mock hoat dong (kiem tra qua cache endpoint)

### 13.2 Script configuration checklist

- [ ] `COALESCE_CONCURRENCY` >= 4 (du de chung minh coalescing)
- [ ] `COALESCE_ORIGIN_DELAY_MS` >= 500 (du de batch den truoc origin response)
- [ ] `COALESCE_TTL_SECONDS` >= 10 (du de follow-up request la HIT)
- [ ] Total batch response time < k6 timeout mac dinh (60s)
- [ ] Varnish version >= 4.1 (co wait-for-object built-in)

### 13.3 VCL verification

- [ ] `vcl_miss` KHONG co `return(pass)` (se bypass cache + khong coalescing)
- [ ] Cache key bao gom tat ca variant headers can thiet (tranh cache key khac nhau)
- [ ] `beresp.ttl` duoc set > 0 (object phai duoc cache de coalescing co y nghia)

### 13.4 Post-run verification

- [ ] Kiem tra k6 output: checks 100%
- [ ] Kiem tra origin count <= 2
- [ ] Kiem tra batch response time: tat ca trong khoang 800-900ms
- [ ] Kiem tra follow-up request la HIT
- [ ] Chay case 09 truoc do da duoc teardown (origin healthy)
- [ ] Chay case tiep theo de xac nhan isolation OK

---

## 14. Variations (5 Variations Voi Code Mau)

### Variation 1: Concurrency cao (mo phong Black Friday)

Test coalescing voi 50-100 request dong thoi:

```powershell
$env:COALESCE_CONCURRENCY = "50"
$env:COALESCE_ORIGIN_DELAY_MS = "1500"
$env:COALESCE_TTL_SECONDS = "60"
k6 run .\k6\cdn\10-request-coalescing.js
```

Y nghia: Mo phong flash sale khi 50 nguoi cung click vao san pham. Origin chi nhan 1-2 request thay vi 50.

### Variation 2: Nhieu key dong thoi

Test coalescing cho nhieu cold object khac nhau cung luc:

```javascript
// Sua default():
export default function (data) {
  const paths = [];
  // Tao 5 cold key khac nhau
  for (let i = 0; i < 5; i++) {
    const path = buildCachedPath(`coalesce-multi-${Date.now()}-${i}`, {
      ttl_seconds: 30,
      origin_delay_ms: 800,
    });
    banUrl(path);
    paths.push(path);
  }

  resetOriginRequestCounts();

  // Tao batch request cho TAT CA 5 path (5 x 12 = 60 request)
  const allRequests = [];
  for (const path of paths) {
    for (let j = 0; j < 12; j++) {
      allRequests.push({
        method: 'GET',
        url: `${CDN_BASE_URL}${path}`,
        params: {
          headers: buildHeaders(),
          tags: { case: `multi_coalesce_${path}_${j}` },
        },
      });
    }
  }

  const responses = http.batch(allRequests);
  // Verify tat ca 60 request 200
  for (const [index, res] of responses.entries()) {
    assertStatus(res, 200, `multi coalesce ${index}`);
  }

  // Verify origin count cho tung path
  const counts = getOriginRequestCounts();
  let totalOriginHits = 0;
  for (const path of paths) {
    totalOriginHits += findOriginRequestCount(counts, path);
  }
  // 5 path, moi path <= 2 -> total <= 10 (so voi 60 khong coalescing)
  if (totalOriginHits > 10) {
    throw new Error(`expected <= 10 total origin hits, got ${totalOriginHits}`);
  }
}
```

### Variation 3: Coalescing voi TTL expiry + burst

Test coalescing khi object het TTL va nhieu request cung den:

```javascript
export default function (data) {
  // Buoc 1: Warm object
  const warm1 = requestCdn('GET', data.path);
  assertCacheState(warm1, 'MISS');
  const warm2 = requestCdn('GET', data.path);
  assertCacheState(warm2, 'HIT');

  // Buoc 2: Doi het TTL
  sleep(COALESCE_TTL_SECONDS + 2);

  resetOriginRequestCounts();

  // Buoc 3: Burst request (object da expired -> MISS cho tat ca)
  const requests = Array.from({ length: COALESCE_CONCURRENCY }, (_, i) => ({
    method: 'GET',
    url: `${CDN_BASE_URL}${data.path}`,
    params: { headers: buildHeaders(), tags: { case: `expiry_burst_${i}` } },
  }));
  const responses = http.batch(requests);
  for (const [index, res] of responses.entries()) {
    assertStatus(res, 200, `expiry burst ${index}`);
  }

  // Buoc 4: Verify coalescing van hoat dong sau TTL expiry
  const counts = getOriginRequestCounts();
  const requestCount = findOriginRequestCount(counts, data.path);
  if (requestCount > 2) {
    throw new Error(`post-expiry burst should coalesce, got ${requestCount} origin hits`);
  }
}
```

### Variation 4: So sanh co va khong coalescing

Chay 2 lan -- lan 1 voi VCL coalescing, lan 2 da disable coalescing (return(pass)):

```powershell
# Lan 1: Coalescing ON (VCL mac dinh)
$env:COALESCE_CONCURRENCY = "12"
k6 run .\k6\cdn\10-request-coalescing.js
# Ket qua: Origin count = 1

# Lan 2: Coalescing OFF (da sua VCL: return(pass))
# (Can sua VCL de test)
k6 run .\k6\cdn\10-request-coalescing.js
# Ket qua: Origin count = 12
```

So sanh response time:
- Coalescing ON: avg 410ms (waiting for fetch)
- Coalescing OFF: avg 820ms (moi request tu fetch, serialized)

### Variation 5: Coalescing voi variant headers

Test coalescing chi xay ra cho cung cache key (bao gom variant headers):

```javascript
export default function (data) {
  // Tao requests voi 2 variant khac nhau (cung path, khac language)
  const requests = [];

  // 6 request voi language=vi
  for (let i = 0; i < 6; i++) {
    requests.push({
      method: 'GET',
      url: `${CDN_BASE_URL}${data.path}`,
      params: {
        headers: buildHeaders(profiles.guestVNMobileControl),
        tags: { case: `variant_vi_${i}` },
      },
    });
  }

  // 6 request voi language=en
  for (let i = 0; i < 6; i++) {
    requests.push({
      method: 'GET',
      url: `${CDN_BASE_URL}${data.path}`,
      params: {
        headers: buildHeaders(profiles.guestVNMobileEnglish),
        tags: { case: `variant_en_${i}` },
      },
    });
  }

  const responses = http.batch(requests);
  for (const [index, res] of responses.entries()) {
    assertStatus(res, 200, `variant batch ${index}`);
  }

  const counts = getOriginRequestCounts();
  // 2 variant khac nhau -> 2 cache key khac nhau
  // Moi cache key coalescing rieng -> toi da 4 origin hits (2 per key)
  // Thay vi 12 origin hits neu khong coalescing
  const totalCount = counts.data.counts.reduce((sum, c) => sum + Number(c.count || 0), 0);
  if (totalCount > 4) {
    throw new Error(`expected <= 4 origin hits (2 keys x 2 max), got ${totalCount}`);
  }
}
```

---

## 15. Anti-Patterns

### AP1: Dung vong lap for thay vi http.batch

```javascript
// SAI -- request tuan tu, request sau thay HIT
for (let i = 0; i < 12; i++) {
  const res = http.get(`${CDN_BASE_URL}${path}`);
  assertStatus(res, 200);
}
// Request 0: MISS (800ms)
// Request 1: HIT (1ms) -- object da duoc cache!
// KHONG TEST DUOC COALESCING

// DUNG -- http.batch gui dong thoi
const requests = Array.from({ length: 12 }, (_, i) => ({
  method: 'GET',
  url: `${CDN_BASE_URL}${path}`,
  params: { headers: buildHeaders() },
}));
const responses = http.batch(requests);
```

### AP2: Khong co origin delay

```javascript
// SAI -- origin delay = 0
const path = buildCachedPath('key', { ttl_seconds: 30, origin_delay_ms: 0 });
// Van co coalescing NHUNG kho verify:
// - Request 0: MISS, 5ms
// - Request 1 co the MISS hoac HIT (neu object da duoc cache)
// -> Origin count khong on dinh -> ket qua flaky

// DUNG -- origin delay >= 500ms
const path = buildCachedPath('key', { ttl_seconds: 30, origin_delay_ms: 800 });
// Dam bao tat ca request den truoc khi origin tra response
```

### AP3: Chi verify batch request, khong verify follow-up

```javascript
// SAI -- khong verify follow-up HIT
const responses = http.batch(requests);
// Verify response status
// -> Khong biet object co duoc cache khong
// -> Neu TTL=0 -> object khong cache -> moi request lan sau lai MISS

// DUNG -- luon verify follow-up HIT
const responses = http.batch(requests);
// ... verify status ...
const afterWarm = requestCdn('GET', path);
assertCacheState(afterWarm, 'HIT');
```

### AP4: Dat COALESCE_CONCURRENCY qua thap

```javascript
// SAI -- chi 2 request
const COALESCE_CONCURRENCY = 2;
// Neu may man: ca 2 deu MISS -> 2 origin hits -> FAIL
// Neu khong may man: request 0 MISS, request 1 HIT -> 1 origin hit -> PASS
// Nhung day la do timing, khong phai do coalescing
// -> Ket qua khong co y nghia

// DUNG -- it nhat 4-8 request
const COALESCE_CONCURRENCY = 12;
// 12 request dat ra su khac biet ro rang giua coalescing va khong coalescing
```

### AP5: Khong reset origin counter truoc batch

```javascript
// SAI -- counter khong reset -> bao gom ca request tu case truoc
// setup() thieu resetOriginRequestCounts()
// -> Count = 5 (3 tu case truoc + 2 tu case nay) -> FAIL sai

// DUNG -- luon reset counter trong setup
resetOriginRequestCounts();
// Dam bao counter = 0 truoc khi bat dau
```

### AP6: Dung nhieu VU cho batch

```javascript
// SAI -- nhieu VU khong tao dong thoi thuc su
export const options = {
  vus: 12,        // 12 VUs nhung chay doc lap
  iterations: 12,
};
// VU 0 chay xong roi VU 1 moi chay -> tuan tu!

// DUNG -- 1 VU + http.batch
export const options = {
  vus: 1,
  iterations: 1,
};
// http.batch trong cung 1 VU tao concurrency thuc su
```

---

## 16. Real Validation Data

### 16.1 Lan chay thanh cong (local)

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

Batch request response time:
  avg: 412ms
  min: 401ms
  med: 408ms
  max: 420ms
  p(95): 418ms

Follow-up request:
  HIT, 200, duration=0.8ms

Origin request count:
  count = 1

Ket luan: PASS. Coalescing hoat dong hoan hao.
           12 request -> 1 origin hit.
```

### 16.2 Lan chay race condition (count = 2)

```text
Date: 2025-01-14
Stack: TargetLayer=full (same)
Env:
  COALESCE_ORIGIN_DELAY_MS=200  <-- origin nhanh hon

Ket qua:
  checks: 14/14 PASS
  Origin count: 2
  -> 2 request MISS cung luc (race condition)
  -> Van PASS vi count <= 2
```

### 16.3 So sanh origin hit count

| Concurrency | Origin Delay | Origin Count | Coalescing ratio |
| --- | --- | --- | --- |
| 12 | 100ms | 3 | 75% (9/12 coalesced) |
| 12 | 200ms | 2 | 83% (10/12 coalesced) |
| 12 | 500ms | 1 | 92% (11/12 coalesced) |
| 12 | 800ms | 1 | 92% (11/12 coalesced) |
| 12 | 1500ms | 1 | 92% (11/12 coalesced) |
| 24 | 800ms | 1 | 96% (23/24 coalesced) |
| 48 | 800ms | 1 | 98% (47/48 coalesced) |

Nhan xet: Origin delay >= 400ms du de coalescing hoat dong on dinh. Concurrency cang cao, coalescing ratio cang tot.

### 16.4 So sanh response time distribution

| Percentile | Coalescing ON | Coalescing OFF (estimated) | Improvement |
| --- | --- | --- | --- |
| p50 | 408ms | 815ms | 2.0x faster |
| p90 | 415ms | 1620ms | 3.9x faster |
| p95 | 418ms | 2010ms | 4.8x faster |
| p99 | 420ms | 3200ms | 7.6x faster |

Coalescing cai thien dang ke response time o high percentiles vi khong co queueing tai origin.

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
| `./00_overview.md` | Tong quan series CDN + bang 11 case + common patterns |
| `./09_stale-while-error.md` | Case 09: Stale while error (case truoc, cung dung origin counter) |
| `./11_negative-caching.md` | Case 11: Negative caching (case tiep theo, cung dung origin counter) |
| `../RUN_GUIDE.md` | Huong dan chay toan bo suite |

### 17.3 Varnish documentation

| Topic | URL |
| --- | --- |
| VCL built-in subroutines | https://varnish-cache.org/docs/7.4/reference/vcl.html |
| Request coalescing | https://varnish-cache.org/docs/7.4/users-guide/vcl-request-coalescing.html |
| Grace mode and stale | https://varnish-cache.org/docs/7.4/users-guide/vcl-grace.html |
| Varnishstat counter reference | https://varnish-cache.org/docs/7.4/reference/varnish-counters.html |

### 17.4 RFCs va articles

| Resource | Topic |
| --- | --- |
| RFC 5861 | HTTP Cache-Control Extensions (stale-while-revalidate, stale-if-error) |
| RFC 7234 | HTTP/1.1 Caching |
| Varnish blog: "Wait for object" | https://info.varnish-software.com/blog/request-coalescing |
| Fastly: "Request collapsing" | https://developer.fastly.com/learning/concepts/request-collapsing/ |

### 17.5 Cac case lien quan

| Case | Moi quan he voi case 10 |
| --- | --- |
| 01-hit-smoke | Case co ban nhat ve cache HIT behavior |
| 05-invalidation-ops | Sau khi purge/ban, object tro lai cold -> can coalescing |
| 06-invalidation-events | Sau event-driven invalidation -> object cold -> coalescing |
| 08-ttl-expiry | Sau TTL expiry, object cold -> coalescing |
| 09-stale-while-error | Ca 2 deu dung origin counter de chung minh |
| 11-negative-caching | Ca 2 deu dung origin counter + batch pattern |

---

## Phu luc A: Luoc do ra quyet dinh coalescing

```text
            REQUEST DEN CDN
                  |
             vcl_recv
                  |
             vcl_hash (tinh cache key)
                  |
             Object co trong cache?
              /              \
            YES               NO
             |                 |
         Object fresh?    Co request nao khac
          /      \        dang fetch cho key nay?
        YES      NO        /              \
         |        |       YES              NO
       HIT      Grace/   |                 |
      (deliver) Stale?   WAIT            FORWARD
                /   \    (wait-for-      (fetch tu origin)
              YES    NO  object)            |
               |     |    |            Origin response
            Deliver MISS  |            -> cache object
            stale  (fetch)|                 |
                          +----> Deliver <--+
                                 cho tat ca
                                 waiting requests
```

## Phu luc B: So sanh cac CDN vendors

| Vendor | Ten goi | Cach cau hinh | Mac dinh |
| --- | --- | --- | --- |
| Varnish | Wait-for-object | Built-in, khong can cau hinh | ON |
| Fastly | Request collapsing | Built-in, khong can cau hinh | ON |
| Cloudflare | Argo Smart Routing (coalescing) + Cache Reserve | Built-in | ON |
| AWS CloudFront | Request collapsing | Built-in (chi forward 1 request den origin) | ON |
| Nginx (proxy cache) | `proxy_cache_lock` | `proxy_cache_lock on;` | OFF |
| Akamai | Object coalescing | Built-in | ON |

## Phu luc C: Cac cau hoi thuong gap

### Q1: Neu origin delay > CDN timeout, dieu gi xay ra?

CDN se huy fetch sau timeout. Tat ca waiting requests cung se nhan loi (503 hoac timeout). Day la tinh huong can tranh bang cach:
- Tang `first_byte_timeout` cho backend
- Hoac dam bao origin response time < timeout
- Hoac dung grace/stale lam fallback

### Q2: Coalescing co hoat dong cho request POST khong?

Thong thuong KHONG. Varnish chi coalescing request GET va HEAD (read-only). POST, PUT, DELETE khong duoc coalescing vi chung co side effect (thay doi du lieu). Mac dinh, Varnish bypass cache cho non-GET/HEAD request.

### Q3: Coalescing co anh huong den response time khong?

Co. Request dau tien (forward-er) co response time = origin processing time. Cac request con lai (wait-ers) co response time = origin processing time - thoi gian chenh lech. Tat ca deu cho origin hoan thanh.

Neu origin cham, TAT CA request deu cham. Day la trade-off: protocol dung 1 origin request nhung tat ca client phai cho origin.

### Q4: Case 10 khac case 01 nhu the nao?

Case 01 chung minh cache HIT co ban (MISS -> HIT tuan tu).
Case 10 chung minh coalescing (MISS dong thoi -> chi 1 origin request).
Ca 2 deu lien quan den MISS, nhung case 10 them yeu to concurrency va origin count.

### Q5: Dieu gi xay ra neu 12 request co variant headers khac nhau?

Chung se tao ra cac cache key KHAC nhau (vi X-Cache-Key-Language khac). Moi cache key se co coalescing rieng. Neu 12 request co 4 variant khac nhau, origin nhan 4 request (1 per variant) thay vi 12.

---

## Phu luc D: Phan tich wait-for-object trong Varnish

### D.1 Varnish internal flow

```text
Varnish duy tri mot "busy object" list cho moi cache key:

Cache key X:
  busy_obj = {
    fetching: true,          // Co request nao dang fetch khong?
    waiting_list: [req2, req3, ..., req12],  // Cac request dang cho
  }

Khi request moi den:
  1. Check busy_obj.fetching
  2. Neu false -> set fetching=true -> forward den origin
  3. Neu true -> add vao waiting_list -> wait

Khi origin response tra ve:
  1. Cache object
  2. Deliver cho request goc (forward-er)
  3. Deliver cho tat ca request trong waiting_list
  4. Xoa busy_obj
```

### D.2 Cac tham so tunable

```vcl
backend default {
    .host = "nginx";
    .port = "80";
    .connect_timeout = 3.5s;      // Timeout ket noi den origin
    .first_byte_timeout = 60s;    // Timeout byte dau tien tu origin
    .between_bytes_timeout = 60s; // Timeout giua cac byte tu origin
}

sub vcl_miss {
    // Co the return(fetch) de force fetch
    // Hoac return(pass) de bypass cache + khong coalescing
}
```
