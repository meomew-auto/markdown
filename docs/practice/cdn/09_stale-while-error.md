# Case 09: Stale While Origin Error

> **Case ID:** `cdn-09-stale-while-error`
> **Script:** `09-stale-while-error.js`
> **Layer:** CDN / Varnish
> **Proof:** origin unhealthy nhung CDN serve stale HIT dung header/counter
> **Do phuc tap:** Cao nhat series -- 5 phase, 3 sleep, 2 control-plane mutation, 4 header assertion + 1 counter proof

---

## 1. Tinh huong thuc te (Business Scenario)

### 1.1 Boi canh

Ban dang van hanh mot san thuong mai dien tu (e-commerce) co luu luong truy cap lon tu nguoi dung khach (anonymous shoppers). Toan bo API san pham duoc cache o tang CDN edge (Varnish) de giam tai cho cac microservices phia sau nhu `products-service`, `search-service`, `homefeed-service`.

Moi thu dang chay binh thuong. CDN dang phuc vu hang nghin request/giay tu cache HIT, origin chi nhan khoang 5-10 request/giay de fill cac object moi hoac het TTL.

Dot nhien, `products-service` gap su co: database connection pool can, memory leak gay OOM, hoac mot deploy hong lam service tra ve HTTP 503 Service Unavailable.

**Cau hoi nghiep vu:** Khi origin bi loi, nguoi dung khach van thay trang san pham (stale) hay thay trang loi 503?

### 1.2 Hau qua neu khong co stale-if-error

Neu CDN khong duoc cau hinh stale serving:

| Thanh phan | Hanh vi khi origin loi | Tac dong kinh doanh |
| --- | --- | --- |
| CDN khong co stale | Tra 503 cho moi request thay vi tra object da cache | Nguoi dung thay trang loi, roi khoi site |
| Origin da qua tai | Van bi CDN goi lien tuc de thu lay object moi | Origin khong the hoi phuc vi van bi tan cong |
| Cache TTL 30s | Sau 30s object het han, CDN bat buoc goi origin | 100% request sau TTL bi loi, khong co gi de serve |
| Khong phan biet stale vs fresh | Ngay ca object con trong cache cung bi bo qua | Lang phi cache object da ton tai |

**Ket qua:** Downtime 5 phut cua `products-service` bien thanh downtime toan bo site trong mat nguoi dung. Doi DevOps chay loan fixing origin trong khi executive hoi "sao site van down, cache dau roi?"

### 1.3 Vi sao day la case PHUC TAP NHAT series

Case 09 khong don gian la "goi request roi kiem tra header". No doi hoi:

1. **Thao tung origin profile runtime** -- dung control-plane PATCH de chuyen origin tu healthy -> unhealthy
2. **Dong bo thoi gian chinh xac** -- 3 khoang sleep (post-TTL, probe-wait, teardown-wait) phai dong bo voi TTL object va health probe cycle
3. **Chung minh kem (negative proof)** -- khong chi can `X-Cache-Stale: true`, con phai chung minh origin **khong** bi goi them lan nao (origin count = 1)
4. **Teardown phuc tap** -- phai reset origin profile ve healthy de khong anh huong case sau
5. **Nhieu khai niem de gay nham lan** -- grace vs stale-if-error, health probe timing, object age vs TTL

---

## 2. CDN Capability Duoc Chung Minh

### 2.1 Phat bieu chinh xac

```text
Khi mot object da het TTL (expired) VA origin backend khong kha dung (unhealthy),
CDN van phuc vu object cu (stale) tu cache thay vi tra loi cho nguoi dung.
CDN KHONG goi origin them lan nao trong suot thoi gian origin unhealthy
(mien la van con nam trong cua so stale-if-error).
```

### 2.2 Ba dieu duoc chung minh cung luc

| # | Dieu can chung minh | Evidence trong script |
| --- | --- | --- |
| 1 | CDN serve object da het TTL khi origin loi | `assertStatus(stale, 200)` + `assertCacheState(stale, 'HIT')` |
| 2 | CDN danh dau object la stale | `assertHeaderEquals(stale, 'X-Cache-Stale', 'true')` |
| 3 | CDN khong goi origin them lan nao | `findOriginRequestCount(counts, path) === 1` |

Day la mot **correctness proof day du**: khong chi chung minh hanh vi dung mong doi, con chung minh hanh vi sai da khong xay ra.

---

## 3. Vi Sao Phai Test O CDN Layer (Khong The Test O App Layer)

### 3.1 So sanh layer

| Khia canh | Test o app layer | Test o CDN layer (case nay) |
| --- | --- | --- |
| Stale serving | App khong co khai niem "stale" -- app chi tra 200 hoac 503 | CDN quyet dinh serve stale HAY goi origin dua tren health probe |
| Health awareness | App khong biet origin co healthy khong (do la infrastructure concern) | CDN co health probe cycle rieng de danh gia origin |
| Origin protection | Neu app lam stale serving, origin van bi app goi -- khong giam tai | CDN collapse toan bo request vao stale HIT, origin nhan 0 request |
| `X-Cache-Stale` header | Khong ton tai o app layer | Chi CDN moi set header nay |
| `X-Cache-Backend-Healthy` | Khong ton tai o app layer | Chi CDN moi set header nay |
| Control-plane origin profile | Khong co endpoint nao de force origin unhealthy | CDN co control-plane PATCH `/ops/app/cdn/origin/profile` |

### 3.2 Nguyen ly cot loi

```text
Stale-while-error la mot CAPABILITY CUA CDN, khong phai cua app.
App chi chiu trach nhiem tra ve Cache-Control: stale-while-revalidate=N
hoac CDN-Cache-Control: stale-if-error=N.
CDN la ben thuc thi chinh sach stale dua tren:
  - Object age (da qua TTL chua?)
  - Origin health (backend con song khong?)
  - Stale window (con nam trong stale-if-error khong?)
```

---

## 4. Topology Va Precondition

### 4.1 Runtime topology

```text
                PUBLIC PATH
                     |
                [Varnish CDN :80]
                 /           \
          Cache HIT        Cache MISS/EXPIRED
              |                  |
         Serve stale        [Origin health check]
         tu cache            /                  \
                     Healthy? YES          Healthy? NO
                         |                      |
                    Fetch tu origin        Serve stale object
                    [Nginx -> app]         tu cache + set
                         |                 X-Cache-Stale: true
                    Tra 200/503            X-Cache-Backend-Healthy: false

                CONTROL PATH (:8088)
                     |
            /ops/app/cdn/origin/profile (PATCH)
            /ops/app/cdn/origin/profile (GET)
            /ops/app/cdn/origin/request-counts (GET/POST)
            /ops/app/cdn/origin/request-counts/reset (POST)
```

### 4.2 Precondition day du

| # | Dieu kien | Cach thiet lap | Kiem tra |
| --- | --- | --- | --- |
| P1 | Stack target chay voi `TargetLayer=full` | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full -ScaleApp 2` | `docker ps` thay Varnish + Nginx + app |
| P2 | Control plane kha dung | `CONTROL_BASE_URL=http://localhost:8088` | `curl http://localhost:8088/ops/app/cdn/origin/profile` tra 200 |
| P3 | OPS_AUTH_TOKEN hop le | Bien moi truong `OPS_AUTH_TOKEN` | Control API khong tra 401 |
| P4 | Origin profile ban dau healthy | Script goi `resetOriginProfile()` + `waitOriginHealthy()` | Probe thay `X-Cache-Backend-Healthy: true` |
| P5 | TTL object duoc chon du nho de test nhanh | `STALE_TTL_SECONDS=2` | Object expire sau 2 giay |
| P6 | Stale window du lon de bao phu toan bo qua trinh test | `STALE_IF_ERROR_SECONDS=120` | 120s >> toan bo thoi gian test (~10s) |
| P7 | Origin request counter da reset | `resetOriginRequestCounts()` | Counter ban dau = 0 |

---

## 5. Script Deep-Dive

### 5.1 Tong quan cau truc

```javascript
// 5 PHASE trong script:
// Phase A: options + khai bao hang so
// Phase B: setup() -- warm MISS -> HIT, xac nhan cache hoat dong
// Phase C: default() -- wait TTL, force origin unhealthy, verify stale serving
// Phase D: teardown() -- reset origin profile + counter
// Phase E: shared.js -- toan bo helper da dung
```

### 5.2 Phase A: Options va Env Knobs

```javascript
export const options = {
  vus: 1,           // Chi can 1 VU -- day la correctness test
  iterations: 1,    // Chi 1 iteration -- day la single-run proof
  thresholds: {
    checks: ['rate==1'],          // TAT CA checks phai pass -- khong duoc 1 check nao fail
    http_req_failed: ['rate==0'], // Khong duoc co request nao loi
  },
  tags: {
    scenario: 'cdn_stale_while_error',
  },
};
```

**Bang env knobs day du:**

| Bien moi truong | Mac dinh | Y nghia | Anh huong neu thay doi |
| --- | --- | --- | --- |
| `STALE_TTL_SECONDS` | `2` | TTL cua object (giay). Object se expire sau thoi gian nay. | Tang -> phai doi lau hon moi vao pha stale. Giam qua thap -> object expire truoc khi kip HIT lan 2. |
| `STALE_IF_ERROR_SECONDS` | `120` | Cua so stale-if-error (giay). Trong thoi gian nay sau TTL, object con duoc serve neu origin loi. | Giam duoi 5s -> co the vuot qua cua so stale trong luc test. Tang -> an toan hon. |
| `STALE_POST_TTL_WAIT_SECONDS` | `STALE_TTL_SECONDS + 1 = 3` | Thoi gian doi sau khi warm de dam bao object da het TTL. | Phai > STALE_TTL_SECONDS de object that su het han. Cong them 1s buffer de an toan. |
| `STALE_PROBE_WAIT_SECONDS` | `4` | Thoi gian doi sau khi set origin unhealthy de CDN nhan biet su thay doi qua health probe. | Qua ngan -> CDN chua kip cap nhat health state -> stale request co the thay origin con healthy -> ban MISS thay vi stale HIT. |

### 5.3 Phase B: setup() -- Warm Cache

```javascript
export function setup() {
  // B1: Tao URL dong voi TTL va stale-if-error duoc cau hinh
  const path = buildCachedPath(`stale-${Date.now()}`, {
    ttl_seconds: STALE_TTL_SECONDS,
    stale_if_error_seconds: STALE_IF_ERROR_SECONDS,
  });
  // URL vi du: /api/cached?key=stale-1719000000000&ttl_seconds=2&stale_if_error_seconds=120

  // B2: Reset origin profile + counter ve trang thai ban dau
  resetOriginProfile();
  resetOriginRequestCounts();

  // B3: Doi origin healthy (co stable check)
  waitOriginHealthy({ label: 'stale setup origin recovery' });

  // B4: Ban URL de dam bao object chua co trong cache
  banUrl(path);

  // B5: Request dau tien -> MISS (cold cache)
  const first = requestCdn('GET', path, {
    tags: { case: 'stale_first' },
  });
  assertStatus(first, 200, 'stale first');
  assertCacheState(first, 'MISS', 'stale first');

  // B6: Request thu hai -> HIT (warm cache)
  const second = requestCdn('GET', path, {
    tags: { case: 'stale_second' },
  });
  assertStatus(second, 200, 'stale second');
  assertCacheState(second, 'HIT', 'stale second');

  // B7: Tra ve path de default() su dung
  return { path };
}
```

**Dong thoi gian setup:**

```text
t=0.0   buildCachedPath() -> /api/cached?key=stale-1719000000000&ttl_seconds=2&stale_if_error_seconds=120
t=0.1   resetOriginProfile() -> PATCH origin ve healthy
t=0.2   resetOriginRequestCounts() -> POST reset counter
t=0.3   waitOriginHealthy() -> probe + stable check (~2-3s)
t=2.5   banUrl(path) -> POST ban-url
t=2.7   requestCdn (first) -> MISS, status 200
t=2.8   requestCdn (second) -> HIT, status 200
t=2.9   setup() complete, return { path }
```

### 5.4 Phase C: default() -- Stale Serving Proof

```javascript
export default function (data) {
  const path = data.path;

  // C1: Doi object het TTL
  //     STALE_POST_TTL_WAIT_SECONDS = STALE_TTL_SECONDS + 1 = 3
  //     Object co TTL=2s da duoc cache tu t=2.7
  //     Sau 3s (t=5.8), object da expired 1.1s
  sleep(STALE_POST_TTL_WAIT_SECONDS);

  // C2: Force origin profile unhealthy
  //     Thiet lap origin tra 503 cho moi request
  setOriginProfile({
    healthy: false,
    error_status: 503,
  });

  // C3: Doi CDN health probe phat hien origin da doi
  //     Varnish health probe cycle mac dinh ~2-5s
  //     STALE_PROBE_WAIT_SECONDS = 4s dam bao it nhat 1 probe cycle da chay
  sleep(STALE_PROBE_WAIT_SECONDS);

  // C4: Request vao object da het TTL khi origin unhealthy
  //     Day la request QUAN TRONG NHAT cua toan bo case
  const stale = requestCdn('GET', path, {
    tags: { case: 'stale_after_origin_unhealthy' },
  });

  // C5: Verify 4 dieu kien cung luc
  assertStatus(stale, 200, 'stale after origin unhealthy');
  // Phai tra 200, khong duoc tra 503

  assertCacheState(stale, 'HIT', 'stale after origin unhealthy');
  // Phai la HIT (tu cache), khong duoc la MISS

  assertHeaderEquals(stale, 'X-Cache-Stale', 'true', 'stale after origin unhealthy');
  // CDN danh dau object la stale

  assertHeaderEquals(stale, 'X-Cache-Backend-Healthy', 'false', 'stale after origin unhealthy');
  // CDN xac nhan origin dang unhealthy

  // C6: Negative proof -- origin count phai giu nguyen = 1
  const counts = getOriginRequestCounts();
  const requestCount = findOriginRequestCount(counts, path);
  if (requestCount !== 1) {
    throw new Error(
      `expected stale path ${path} to hit origin exactly once, got ${requestCount}`
    );
  }
  // Chi co 1 request MISS ban dau di den origin
  // Neu > 1 -> CDN da goi origin them -> stale serving THAT BAI
}
```

**Dong thoi gian default (phase quan trong nhat):**

```text
t=3.0   sleep(STALE_POST_TTL_WAIT_SECONDS=3s) bat dau
        Object age: 0.3s (da cache luc t=2.7)
        Object TTL: 2s
t=5.0   Object het TTL luc t=4.7 (2s sau khi cache)
        Bay gio t=5.0, object da expired 0.3s
t=6.0   sleep() ket thuc
        Object da expired 1.3s

t=6.0   setOriginProfile({ healthy: false, error_status: 503 })
        Control-plane PATCH -> origin profile thay doi

t=6.0   sleep(STALE_PROBE_WAIT_SECONDS=4s) bat dau
        Varnish health probe chay moi ~2-5s
t=8.0   Probe thu 1: Phat hien origin khong healthy
t=10.0  Probe thu 2 (optional): Xac nhan origin van unhealthy
t=10.0  sleep() ket thuc

t=10.0  requestCdn('GET', path) -> stale HIT
        CDN logic:
        1. Object age = 7.3s > TTL 2s -> expired -> khong fresh
        2. Origin health = unhealthy -> khong the goi origin
        3. Object age = 7.3s < TTL + stale_if_error = 122s -> con trong stale window
        4. => Serve stale object tu cache
        5. => Set X-Cache-Stale: true
        6. => Set X-Cache-Backend-Healthy: false

t=10.1  assertStatus(200) -> PASS
t=10.1  assertCacheState(HIT) -> PASS
t=10.1  assertHeaderEquals('X-Cache-Stale', 'true') -> PASS
t=10.1  assertHeaderEquals('X-Cache-Backend-Healthy', 'false') -> PASS

t=10.2  getOriginRequestCounts() -> 1 (chi MISS ban dau)
        findOriginRequestCount() = 1 -> PASS
```

### 5.5 Phase D: teardown() -- Cleanup

```javascript
export function teardown() {
  // D1: Reset origin profile ve healthy
  //     PATCH { healthy: true } hoac POST reset
  resetOriginProfile();

  // D2: Doi origin thuc su healthy
  //     Co stable check (mac dinh 2 samples lien tiep)
  waitOriginHealthy({ label: 'stale teardown origin recovery' });

  // D3: Reset counter de khong anh huong case sau
  resetOriginRequestCounts();
}
```

**Vi sao teardown quan trong:**

Neu khong reset origin profile, case tiep theo (vd case 10, case 11) se chay voi origin unhealthy -> toan bo request MISS bi loi 503 -> fail hang loat. Teardown dam bao **isolation giua cac case**.

---

## 6. VCL Deep-Dive

### 6.1 VCL logic cho stale-if-error

Day la VCL pseudocode the hien hanh vi stale serving trong Varnish:

```vcl
sub vcl_hit {
    // Object da co trong cache
    if (obj.ttl >= 0s) {
        // Object con fresh -> deliver binh thuong
        return (deliver);
    }

    // Object da het TTL (expired)
    if (obj.ttl + obj.keep > 0s) {
        // Con keep window -> co the dung de stale serving
        if (std.healthy(req.backend_hint)) {
            // Origin healthy -> background fetch (stale-while-revalidate)
            // Hoac synchronous fetch (normal miss behavior)
            return (miss);
        } else {
            // Origin unhealthy -> serve stale
            set resp.http.X-Cache-Stale = "true";
            set resp.http.X-Cache-Backend-Healthy = "false";
            return (deliver);
        }
    }

    // Object da vuot qua ca stale window -> miss bat buoc
    return (miss);
}

sub vcl_backend_response {
    // Set grace period tu stale-if-error header
    if (beresp.http.Cache-Control ~ "stale-if-error=(\d+)") {
        set beresp.grace = std.duration(re.group(1) + "s", 0s);
    }
    // Hoac tu CDN-Cache-Control
    if (beresp.http.CDN-Cache-Control ~ "stale-if-error=(\d+)") {
        set beresp.grace = std.duration(re.group(1) + "s", 0s);
    }
}
```

### 6.2 Grace period vs Stale-if-error

Day la mot trong nhung **nghenhan lon nhat** khi hoc CDN:

| Khai niem | Dinh nghia | Header nao set? | Khi nao dung? | Varnish bien |
| --- | --- | --- | --- | --- |
| **grace** | Object co the duoc serve khi **da het TTL nhung origin healthy** (dung cho async refresh) | `Cache-Control: stale-while-revalidate=N` | Origin healthy, object expired, background fetch | `beresp.grace` |
| **stale-if-error** | Object co the duoc serve khi **da het TTL VA origin unhealthy** | `Cache-Control: stale-if-error=N` hoac `CDN-Cache-Control: stale-if-error=N` | Origin unhealthy, object expired | `beresp.grace` (Varnish dung chung truong `grace`) |
| **keep** | Object ton tai trong cache sau khi het ca grace lan stale window | Khong co header (internal Varnish) | Sau grace + stale window, object chi de phuc vu ongoing request | `obj.keep` |

**Diem gay nham lan:** Varnish dung **cung mot bien `beresp.grace`** cho ca `stale-while-revalidate` va `stale-if-error`. Su khac biet nam o `vcl_hit`:

- Neu origin **healthy** + object expired trong grace -> `stale-while-revalidate` (background fetch)
- Neu origin **unhealthy** + object expired trong grace -> `stale-if-error` (serve stale)

### 6.3 Health probe mechanism

Varnish duy tri health state cho moi backend qua health probe:

```vcl
backend default {
    .host = "nginx";
    .port = "80";
    .probe = {
        .url = "/health";
        .timeout = 1s;
        .interval = 5s;    // Khoang cach giua cac probe
        .window = 5;       // So probe gan nhat de tinh toan
        .threshold = 3;    // So probe thanh cong de coi la healthy
    }
}
```

**Dong thoi gian health probe transition:**

```text
Origin:    [HEALTHY ------> UNHEALTHY ----------> HEALTHY]
Probe 1:   [  OK  ]  OK     FAIL     FAIL     [  OK  ]
Probe 2:   [  OK  ]  OK     FAIL     FAIL     [  OK  ]
Probe 3:   [  OK  ]  OK     FAIL     FAIL     [  OK  ]

Threshold = 3, Window = 5
State:     [ HEALTHY ]   HEALTHY    UNHEALTHY    [ HEALTHY ]
                          ^                      ^
                          |                      |
                  toi thieu 3 FAIL   toi thieu 3 OK de
                  de unhealthy       tro lai healthy
```

**Vi sao `STALE_PROBE_WAIT_SECONDS = 4` trong script?**
- Probe interval mac dinh = 5s, nhung co the duoc cau hinh ngan hon (1-2s)
- 4s dam bao it nhat 2 probe da chay (voi interval 2s) hoac 1 probe (voi interval 5s)
- Cong them buffer de `waitOriginHealthy` o setup da xac nhan trang thai on dinh

---

## 7. Request Sequence Flow (Timeline Chi Tiet)

### 7.1 Toan bo timeline

```text
TIMELINE: Case 09 Stale While Origin Error
==========================================

PHASE: SETUP (warm cache)
-------+----+----+----+----+----+----+----+----+----+----+---
t=0.0  |
       |  buildCachedPath("stale-1719000000000",
       |    { ttl_seconds: 2, stale_if_error_seconds: 120 })
       |  -> /api/cached?key=stale-1719000000000&ttl_seconds=2&stale_if_error_seconds=120
t=0.1  |  resetOriginProfile()
       |  -> POST /ops/app/cdn/origin/reset -> 200
t=0.2  |  resetOriginRequestCounts()
       |  -> POST /ops/app/cdn/origin/request-counts/reset -> 200
t=0.3  |  waitOriginHealthy()
       |  -> probe: GET /api/cached?key=health-... -> 200, X-Cache-Backend-Healthy: true
       |  -> stable check: 2 samples lien tiep OK
t=2.5  |  banUrl(path)
       |  -> POST /ops/app/cdn/cache/ban-url -> 200
t=2.7  |  requestCdn(GET, path) -> MISS (first)
       |  -> CDN -> origin -> app -> 200
       |  -> X-Cache: MISS
       |  -> Origin counter: +1 -> total = 1
t=2.8  |  requestCdn(GET, path) -> HIT (second)
       |  -> CDN serve tu cache
       |  -> X-Cache: HIT
       |  -> Origin counter: unchanged -> total = 1
t=2.9  |  setup() returns { path }
       |  OBJECT STATE: fresh, age=0.1s, TTL=2s, stale-if-error=120s
       |
PHASE: DEFAULT (stale proof)
-------+----+----+----+----+----+----+----+----+----+----+---
t=3.0  |  sleep(STALE_POST_TTL_WAIT_SECONDS=3s) bat dau
       |  OBJECT STATE: fresh, age=0.2s
t=4.8  |  OBJECT STATE: expired! age=2.0s > TTL=2s
       |  Nhung con trong grace window: age=2.0s < TTL+stale_if_error=122s
t=6.0  |  sleep() ket thuc
       |  OBJECT STATE: expired, age=3.2s
       |
t=6.1  |  setOriginProfile({ healthy: false, error_status: 503 })
       |  -> PATCH /ops/app/cdn/origin/profile -> 200
       |  ORIGIN STATE: profile da set unhealthy
       |  CDN HEALTH STATE: van la healthy (chua co probe moi)
       |
t=6.1  |  sleep(STALE_PROBE_WAIT_SECONDS=4s) bat dau
       |  OBJECT STATE: expired, age=3.3s
t=7.0  |  Health probe 1: CDN probe origin -> origin tra 503
       |  CDN HEALTH STATE: chuyen sang unhealthy (neu threshold dat)
t=9.0  |  Health probe 2: CDN probe origin -> origin tra 503
       |  CDN HEALTH STATE: unhealthy (xac nhan)
t=10.1 |  sleep() ket thuc
       |  OBJECT STATE: expired, age=7.3s, trong stale window
       |  CDN HEALTH STATE: unhealthy
       |
t=10.2 |  requestCdn(GET, path) -> stale HIT (THE CRITICAL REQUEST)
       |  -> CDN check: object expired? YES
       |  -> CDN check: origin healthy? NO
       |  -> CDN check: in stale window? YES (age 7.3s < 122s)
       |  -> CDN: serve stale object tu cache
       |  -> X-Cache: HIT
       |  -> X-Cache-Stale: true
       |  -> X-Cache-Backend-Healthy: false
       |  -> Status: 200
       |  -> Origin counter: unchanged -> total = 1
       |
t=10.3 |  assertStatus(200) -> PASS
t=10.3 |  assertCacheState(HIT) -> PASS
t=10.3 |  assertHeaderEquals(X-Cache-Stale, true) -> PASS
t=10.3 |  assertHeaderEquals(X-Cache-Backend-Healthy, false) -> PASS
       |
t=10.4 |  getOriginRequestCounts()
       |  -> GET /ops/app/cdn/origin/request-counts -> 200
       |  -> findOriginRequestCount(counts, path) = 1
       |  -> 1 === 1 -> PASS (origin chi bi goi dung 1 lan)
       |
PHASE: TEARDOWN (cleanup)
-------+----+----+----+----+----+----+----+----+----+----+---
t=10.5 |  resetOriginProfile()
       |  -> POST /ops/app/cdn/origin/reset -> 200
t=10.6 |  waitOriginHealthy({ label: 'stale teardown origin recovery' })
       |  -> probe + stable check ~2-5s
       |  -> xac nhan origin da healthy tro lai
t=13.0 |  resetOriginRequestCounts()
       |  -> POST /ops/app/cdn/origin/request-counts/reset -> 200
t=13.1 |  teardown() complete
       |  CASE FINISHED
```

### 7.2 Object lifecycle

```text
OBJECT: /api/cached?key=stale-1719000000000&ttl_seconds=2&stale_if_error_seconds=120

  FRESH                     EXPIRED (STALE WINDOW)              DEAD
  |<------ TTL=2s --------->|<------ stale-if-error=120s ------>|<-- keep=0 -->
  |                         |                                    |
t=2.7                    t=4.7                               t=124.7
  |                         |                                    |
  MISS -> origin           HIT (stale) neu origin unhealthy     MISS -> 503
  HIT (fresh)              MISS -> 503 neu origin healthy       neu origin unhealthy
                           & ko con stale                       & ko con stale
```

---

## 8. Key Signals / Headers Can Verify

### 8.1 Bang header day du

| Header | Xuat hien o dau | Gia tri mong doi trong case nay | Y nghia |
| --- | --- | --- | --- |
| `X-Cache` | Response header | `HIT` (ca 3 request: warm HIT, cold MISS, stale HIT) | Trang thai cache cua request nay |
| `X-Cache-Stale` | Response header | `true` (chi o stale request) | CDN danh dau object da expired nhung van duoc serve |
| `X-Cache-Backend-Healthy` | Response header | `true` (warm) -> `false` (stale) | CDN danh gia backend health |
| `Cache-Control` | Response header | Chua `s-maxage=2` hoac `stale-if-error=120` | Origin khai bao TTL va stale policy |
| `CDN-Cache-Control` | Response header (optional) | Chua `stale-if-error=120` | Override CDN-specific policy |
| `Age` | Response header | Tang dan qua cac request | Thoi gian object da ton tai trong cache |

### 8.2 Bang control-plane signals

| Endpoint | Response field | Gia tri mong doi | Y nghia |
| --- | --- | --- | --- |
| `GET /ops/app/cdn/origin/profile` | `data.profile.healthy` | `true` -> `false` -> `true` | Trang thai origin profile trong control plane |
| `GET /ops/app/cdn/origin/profile` | `data.profile.error_status` | `503` (khi unhealthy) | HTTP status origin se tra khi unhealthy |
| `GET /ops/app/cdn/origin/request-counts` | `data.counts[].request_key` | Chua path cua object | URL da duoc origin phuc vu |
| `GET /ops/app/cdn/origin/request-counts` | `data.counts[].count` | `1` (chi MISS ban dau) | So lan origin phuc vu request nay |

---

## 9. Pass/Fail Criteria (Dinh Luong, Cu The)

### 9.1 PASS criteria

```text
PASS khi TAT CA cac dieu kien sau DONG THOI dung:

1. k6 exit code = 0
2. checks rate = 100% (tat ca named checks pass)
3. http_req_failed rate = 0%
4. Request "stale_after_origin_unhealthy":
   a. HTTP status = 200
   b. X-Cache = "HIT"
   c. X-Cache-Stale = "true"
   d. X-Cache-Backend-Healthy = "false"
5. Origin request count cho path nay = 1 (chi MISS ban dau)
6. Teardown hoan thanh khong loi (origin profile reset thanh cong)
```

### 9.2 FAIL criteria

| # | Fail pattern | Trieu chung | Nguyen nhan goc |
| --- | --- | --- | --- |
| F1 | Stale request tra 503 | Status 503, X-Cache=MISS | CDN khong co stale object hoac object da vuot stale window |
| F2 | Stale request tra 200 nhung MISS | Status 200, X-Cache=MISS | CDN goi origin thay vi serve stale -> origin van healthy (health probe chua detect) |
| F3 | Stale request HIT nhung khong co X-Cache-Stale | Status 200, HIT, X-Cache-Stale trong | Object chua het TTL -> van con fresh, khong can stale |
| F4 | Origin count > 1 | Stale request PASS nhung count > 1 | CDN da goi origin them ngoai MISS ban dau -> stale serving KHONG bao ve origin |
| F5 | X-Cache-Backend-Healthy = "true" trong stale request | Header khong dung | CDN chua detect origin unhealthy -> can tang STALE_PROBE_WAIT_SECONDS |
| F6 | Teardown fail | Khong reset duoc origin profile | Control plane khong kha dung hoac OPS_AUTH_TOKEN sai |

### 9.3 Bang tong hop ket qua

| Scenario | Status | X-Cache | X-Cache-Stale | X-Cache-Backend-Healthy | Origin Count | Ket luan |
| --- | --- | --- | --- | --- | --- | --- |
| PASS | 200 | HIT | true | false | 1 | Stale serving hoat dong dung |
| FAIL mode 1 | 503 | MISS | N/A | false | 1 | Khong co stale object (vuot stale window) |
| FAIL mode 2 | 200 | MISS | false | true | 2 | CDN goi origin (chua detect unhealthy) |
| FAIL mode 3 | 200 | HIT | false | true | 1 | Object con fresh (chua het TTL) |
| FAIL mode 4 | 200 | HIT | true | false | 3 | CDN serve stale nhung van goi origin (double-check) |

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
k6 run .\k6\cdn\09-stale-while-error.js

# Hoac: Chay voi TTL dai hon
$env:STALE_TTL_SECONDS = "5"
$env:STALE_POST_TTL_WAIT_SECONDS = "7"
$env:STALE_PROBE_WAIT_SECONDS = "6"
k6 run .\k6\cdn\09-stale-while-error.js

# Hoac: Dung run-cdn-capabilities script
cd E:\Projects\k6\k6-metrics-server
.\scripts\run-cdn-capabilities.ps1 -Scenarios 09-stale-while-error
```

### 10.2 Output mau (PASS)

```text
  execution: local
     script: .\k6\cdn\09-stale-while-error.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations shared among 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)

running (00m13.1s), 1/1 VUs, 0 complete and 0 interrupted iterations
default   [   0% ] 1/1 VUs  00m13.1s/10m0s  0/1 shared iters

     data_received..............: 2.1 kB 161 B/s
     data_sent..................: 1.8 kB 140 B/s
     http_req_blocked...........: avg=1.23ms  min=0.01ms  med=0.02ms  max=12.3ms  p(90)=3.7ms   p(95)=7.9ms
     http_req_connecting........: avg=0.45ms  min=0ms     med=0ms     max=4.5ms   p(90)=1.3ms   p(95)=2.9ms
     http_req_duration..........: avg=5.67ms  min=0.12ms  med=2.1ms   max=45.2ms  p(90)=12.4ms  p(95)=28.6ms
     http_req_failed............: 0.00% 0 out of 12
     http_req_receiving.........: avg=0.34ms  min=0.02ms  med=0.15ms  max=2.1ms   p(90)=0.89ms  p(95)=1.4ms
     http_req_sending...........: avg=0.05ms  min=0.01ms  med=0.03ms  max=0.5ms   p(90)=0.11ms  p(95)=0.28ms
     http_req_tls_handshaking...: avg=0ms     min=0ms     med=0ms     max=0ms     p(90)=0ms     p(95)=0ms
     http_req_waiting...........: avg=5.28ms  min=0.08ms  med=1.91ms  max=43.5ms  p(90)=11.8ms  p(95)=27.3ms
     http_reqs..................: 12    0.916264/s
     iteration_duration.........: avg=7.12s   min=2.89s   med=7.12s   max=11.34s  p(90)=10.6s   p(95)=10.9s
     iterations.................: 1     0.076355/s
     vus........................: 1     min=1 max=1
     vus_max....................: 1     min=1 max=1

  ✓ stale first status 200
  ✓ stale first cache state MISS
  ✓ stale second status 200
  ✓ stale second cache state HIT
  ✓ stale after origin unhealthy status 200
  ✓ stale after origin unhealthy cache state HIT
  ✓ stale after origin unhealthy X-Cache-Stale equals true
  ✓ stale after origin unhealthy X-Cache-Backend-Healthy equals false

  checks........................: 100.00% ✓ 8        ✗ 0
```

### 10.3 Output mau (FAIL -- probe chua kip)

```text
  ✗ stale after origin unhealthy status 200
    ↳  0% — ✓ 0 / ✗ 1
  ✗ stale after origin unhealthy cache state HIT
    ↳  0% — ✓ 0 / ✗ 1
  ✗ stale after origin unhealthy X-Cache-Stale equals true
    ↳  0% — ✓ 0 / ✗ 1

  checks........................: 62.50% ✓ 5        ✗ 3

  ERRO[0013] expected stale path /api/cached?key=stale-1719000000000&ttl_seconds=2&stale_if_error_seconds=120
         to hit origin exactly once, got 2

  --> Giai thich: STALE_PROBE_WAIT_SECONDS qua ngan,
      CDN chua detect origin unhealthy -> request goi origin (MISS)
      -> status van 200 nhung la MISS, khong phai stale HIT
      -> origin count tang len 2

  --> Fix: Tang STALE_PROBE_WAIT_SECONDS len 6 hoac 8
```

---

## 11. 4 Output -> Decision Scenarios

### Scenario A: PASS hoan hao

```text
Tat ca 8 checks pass
Origin count = 1
X-Cache-Stale = true
X-Cache-Backend-Healthy = false

=> DECISION: Stale serving contract duoc xac nhan.
   CDN da cau hinh dung stale-if-error.
   Co the tu tin deploy len production.
   Origin co the gap su co ma nguoi dung khong bi anh huong
   (trong thoi gian stale window).
```

### Scenario B: Status 200 nhung X-Cache-Stale trong

```text
Status 200
X-Cache = HIT
X-Cache-Stale (missing)
X-Cache-Backend-Healthy = true

=> DECISION: Object van con fresh (chua het TTL).
   Co the STALE_POST_TTL_WAIT_SECONDS qua ngan
   hoac TTL thuc te dai hon STALE_TTL_SECONDS da cau hinh.
   -> Tang STALE_POST_TTL_WAIT_SECONDS them 2-3s.
   -> Kiem tra response header "Age" de xac nhan object age.
```

### Scenario C: Status 503

```text
Status 503
X-Cache = MISS (hoac khong co)

=> DECISION: CDN khong co stale object de serve.
   Nguyen nhan co the:
   1. Object da vuot qua stale-if-error window
      -> Tang STALE_IF_ERROR_SECONDS
   2. Object chua tung duoc cache (khong co MISS ban dau)
      -> Kiem tra setup phase co MISS thanh cong khong
   3. grace/keep khong duoc set trong VCL
      -> Kiem tra VCL config: beresp.grace
```

### Scenario D: Origin count > 2

```text
Tat ca checks pass (status 200, HIT, stale headers dung)
Nhung origin count = 3 hoac cao hon

=> DECISION: CDN serve stale nhung van goi origin.
   Day la tinh huong "background fetch" khi origin healthy trong mot
   khoanh khac, roi origin lai unhealthy.
   -> Kiem tra health probe timing
   -> Kiem tra VCL logic: dam bao chi serve stale khi origin unhealthy
   -> Kiem tra co request nao khac cung URL khong (VU khac, iteration khac)
```

---

## 12. Nghich Ly / Misconceptions

### 12.1 Grace vs Stale-if-error (Nham lan PHO BIEN NHAT)

**Nghich ly:** Nhieu nguoi nghi rang `stale-while-revalidate` va `stale-if-error` la cung mot thu. Hoac nghi rang Varnish dung 2 bien khac nhau cho 2 muc dich nay.

**Su that:** Varnish dung **cung mot bien `beresp.grace`** de thuc thi ca 2 chinh sach. Su khac biet nam o **hanh vi trong `vcl_hit`**, khong phai o cach set grace:

```text
stale-while-revalidate:  dung khi origin HEALTHY
  -> return (miss) de background fetch
  -> trong khi cho fetch, van deliver object cu

stale-if-error:          dung khi origin UNHEALTHY
  -> khong goi origin (vi origin khong kha dung)
  -> deliver object cu + set X-Cache-Stale: true
```

### 12.2 "Object het TTL la phai MISS"

**Nghich ly:** Nhieu nguoi tu duy "TTL expired -> phai goi origin de lay object moi -> MISS". Day la tu duy thieu sot.

**Su that:** TTL expired chi co nghia la object **khong con fresh**. No **khong** co nghia la object khong the duoc serve. Object con co the duoc serve trong grace window (stale-while-revalidate) hoac stale window (stale-if-error).

```text
FRESH:    TTL con hieu luc       -> HIT, khong goi origin
EXPIRED:  TTL het han            -> co the van HIT neu con grace/stale
DEAD:     Het grace + keep       -> MISS bat buoc, goi origin
```

### 12.3 "Health probe detect ngay lap tuc"

**Nghich ly:** `setOriginProfile()` thay doi profile trong control plane -> CDN se biet ngay lap tuc.

**Su that:** Co **2 he thong doc lap**:

1. **Control plane profile** -- duoc cap nhat qua PATCH, CDN doc profile nay de quyet dinh hanh vi
2. **CDN health probe** -- CDN tu probe origin theo chu ky de danh gia health

Thoi gian giua `setOriginProfile()` va CDN thuc su nhan biet origin unhealthy co the mat 2-10s, phu thuoc vao:
- Probe interval (mac dinh 5s)
- Probe window va threshold
- Cache TTL cua health probe response

Day la **ly do can `STALE_PROBE_WAIT_SECONDS`** trong script.

### 12.4 "Stale HIT co X-Cache=HIT la sai, phai la STALE"

**Nghich ly:** Stale object dang duoc serve -> `X-Cache` phai la `STALE`, khong phai `HIT`.

**Su that:** Trong Varnish, khong co cache state `STALE`. Chi co `HIT`, `MISS`, `HIT-FOR-PASS`, `HIT-FOR-MISS`. Stale la mot **trang thai bo sung**, duoc danh dau qua `X-Cache-Stale: true`, khong phai qua `X-Cache`. `X-Cache` van la `HIT` vi object van duoc serve **tu cache**.

### 12.5 "Chi can status 200 la du"

**Nghich ly:** Neu stale request tra 200, stale serving da hoat dong.

**Su that:** Status 200 co the la:
- MISS thanh cong tu origin (neu origin chua bi detect la unhealthy)
- HIT fresh (neu object chua het TTL)
- HIT stale (neu stale serving hoat dong)

**Can phai verify ca 4 signals** de xac nhan stale serving: status 200, X-Cache=HIT, X-Cache-Stale=true, X-Cache-Backend-Healthy=false.

### 12.6 "Tang STALE_PROBE_WAIT_SECONDS cang lon cang an toan"

**Nghich ly:** De an toan, dat `STALE_PROBE_WAIT_SECONDS=30`.

**Su that:** Qua dai se gay:
- Tong thoi gian test lau -> cham feedback loop
- Object age tang -> gan vuot stale window -> FAIL sai
- Ton tai nguyen trong CI/CD pipeline

Gia tri toi uu: **2x probe interval + 1s buffer**. Neu probe interval = 2s, dat 5s. Neu = 5s, dat 11s.

---

## 13. Checklist Truoc Khi Chay

### 13.1 Infrastructure checklist

- [ ] `docker ps` show Varnish container dang chay
- [ ] `docker ps` show Nginx + app containers dang chay
- [ ] `curl http://localhost:80/api/sim/products/1` tra 200
- [ ] `curl http://localhost:8088/ops/app/cdn/origin/profile` tra 200 (can OPS_AUTH_TOKEN)
- [ ] `curl http://localhost:8088/ops/app/cdn/origin/request-counts` tra 200
- [ ] Stack khoi dong voi `TargetLayer=full`
- [ ] OPS_AUTH_TOKEN da duoc set va hop le

### 13.2 Script configuration checklist

- [ ] `STALE_TTL_SECONDS` >= 1 (khong duoc 0)
- [ ] `STALE_POST_TTL_WAIT_SECONDS` > `STALE_TTL_SECONDS` (it nhat +1s)
- [ ] `STALE_IF_ERROR_SECONDS` du lon (>= 60, tranh vuot window)
- [ ] `STALE_PROBE_WAIT_SECONDS` >= 4 (dam bao probe da chay)
- [ ] Total test duration khong vuot qua stale window: `STALE_TTL_SECONDS + STALE_POST_TTL_WAIT_SECONDS + STALE_PROBE_WAIT_SECONDS < STALE_IF_ERROR_SECONDS`

### 13.3 Pre-run verification

- [ ] Chay case 01 (hit-smoke) truoc de xac nhan cache co ban hoat dong
- [ ] Origin profile hien tai la healthy (kiem tra manual)
- [ ] Khong co script nao khac dang chay (tranh conflict control plane)
- [ ] Network connectivity: localhost:80, localhost:8088 deu reachable

### 13.4 Post-run verification

- [ ] Kiem tra k6 output: checks 100%
- [ ] Kiem tra X-Cache-Stale header trong output
- [ ] Kiem tra origin count = 1
- [ ] Chay case tiep theo (case 10) de xac nhan isolation OK
- [ ] Origin profile da duoc reset (kiem tra manual)

---

## 14. Variations (5 Variations Voi Code Mau)

### Variation 1: Stale voi thoi gian dai (production simulation)

Mo phong stale serving trong 5 phut downtime:

```powershell
$env:STALE_TTL_SECONDS = "30"
$env:STALE_IF_ERROR_SECONDS = "600"
$env:STALE_POST_TTL_WAIT_SECONDS = "35"
$env:STALE_PROBE_WAIT_SECONDS = "6"
k6 run .\k6\cdn\09-stale-while-error.js
```

Y nghia: TTL 30s (dien hinh cho product page), stale window 600s (10 phut) -- du thoi gian de DevOps fix origin.

### Variation 2: Nhieu request stale lien tiep

Sua script de goi nhieu stale request lien tiep, chung minh origin khong bi goi them:

```javascript
// Them trong default():
// Sau khi verify stale request dau tien, goi them 5 request nua
for (let i = 0; i < 5; i++) {
  const extraStale = requestCdn('GET', path, {
    tags: { case: `stale_extra_${i}` },
  });
  assertStatus(extraStale, 200, `stale extra ${i}`);
  assertCacheState(extraStale, 'HIT', `stale extra ${i}`);
  assertHeaderEquals(extraStale, 'X-Cache-Stale', 'true', `stale extra ${i}`);
  sleep(0.5);
}
// Origin count van phai = 1
const counts = getOriginRequestCounts();
const finalCount = findOriginRequestCount(counts, path);
if (finalCount !== 1) {
  throw new Error(`origin count still must be 1 after multiple stale serves, got ${finalCount}`);
}
```

### Variation 3: Stale voi nhieu object khac nhau

Chung minh stale serving hoat dong doc lap cho nhieu URL:

```javascript
export function setup() {
  const paths = [];
  for (let i = 0; i < 5; i++) {
    const path = buildCachedPath(`stale-multi-${Date.now()}-${i}`, {
      ttl_seconds: 2,
      stale_if_error_seconds: 120,
    });
    banUrl(path);
    const first = requestCdn('GET', path, { tags: { case: 'warm_miss' } });
    const second = requestCdn('GET', path, { tags: { case: 'warm_hit' } });
    paths.push(path);
  }
  resetOriginRequestCounts();
  return { paths };
}

export default function (data) {
  sleep(4); // wait TTL + buffer

  setOriginProfile({ healthy: false, error_status: 503 });
  sleep(5); // wait probe

  for (const path of data.paths) {
    const stale = requestCdn('GET', path, {
      tags: { case: 'stale_multi' },
    });
    assertStatus(stale, 200);
    assertCacheState(stale, 'HIT');
    assertHeaderEquals(stale, 'X-Cache-Stale', 'true');
  }

  const counts = getOriginRequestCounts();
  let totalOriginHits = 0;
  for (const path of data.paths) {
    totalOriginHits += findOriginRequestCount(counts, path);
  }
  // Moi path chi co 1 MISS ban dau
  if (totalOriginHits !== 5) {
    throw new Error(`expected 5 origin hits total, got ${totalOriginHits}`);
  }
}
```

### Variation 4: Stale sau do origin hoi phuc

Chung minh sau khi origin hoi phuc, CDN tu dong chuyen ve MISS:

```javascript
export default function (data) {
  sleep(STALE_POST_TTL_WAIT_SECONDS);

  // Phase 1: Origin unhealthy -> stale
  setOriginProfile({ healthy: false, error_status: 503 });
  sleep(STALE_PROBE_WAIT_SECONDS);

  const stale = requestCdn('GET', data.path, { tags: { case: 'stale' } });
  assertHeaderEquals(stale, 'X-Cache-Stale', 'true');
  assertHeaderEquals(stale, 'X-Cache-Backend-Healthy', 'false');

  // Phase 2: Origin hoi phuc -> MISS
  setOriginProfile({ healthy: true });
  sleep(STALE_PROBE_WAIT_SECONDS);

  const fresh = requestCdn('GET', data.path, { tags: { case: 'fresh' } });
  assertStatus(fresh, 200);
  assertCacheState(fresh, 'MISS', 'fresh after recovery');
  // Phai la MISS vi CDN goi origin de refresh object
}
```

### Variation 5: Stale window vuot qua -> 503

Chung minh khi stale window het, CDN tra loi:

```powershell
# Dat stale window RAT NGAN (1s) va TTL dai (10s)
# de stale window het truoc khi test hoan thanh
$env:STALE_TTL_SECONDS = "2"
$env:STALE_IF_ERROR_SECONDS = "1"
$env:STALE_POST_TTL_WAIT_SECONDS = "4"
$env:STALE_PROBE_WAIT_SECONDS = "6"
k6 run .\k6\cdn\09-stale-while-error.js
# EXPECTED: FAIL
# Object se vuot stale window -> request tra 503
```

---

## 15. Anti-Patterns

### AP1: Khong verify X-Cache-Backend-Healthy

```javascript
// SAI -- chi verify status va X-Cache
assertStatus(stale, 200);
assertCacheState(stale, 'HIT');
// Thieu: assertHeaderEquals(stale, 'X-Cache-Stale', 'true');
// Thieu: assertHeaderEquals(stale, 'X-Cache-Backend-Healthy', 'false');

// DUNG -- verify day du 4 signals
assertStatus(stale, 200);
assertCacheState(stale, 'HIT');
assertHeaderEquals(stale, 'X-Cache-Stale', 'true');
assertHeaderEquals(stale, 'X-Cache-Backend-Healthy', 'false');
```

### AP2: Khong verify origin count

```javascript
// SAI -- chi verify header, khong check origin counter
// Co the CDN serve stale nhung van goi origin background fetch
// -> origin bi tan cong ngam

// DUNG -- luon verify origin count
const counts = getOriginRequestCounts();
const requestCount = findOriginRequestCount(counts, path);
if (requestCount !== 1) {
  throw new Error(`origin count must be 1, got ${requestCount}`);
}
```

### AP3: Khong doi health probe sau setOriginProfile

```javascript
// SAI -- set origin unhealthy roi request ngay
setOriginProfile({ healthy: false, error_status: 503 });
const stale = requestCdn('GET', path); // CDN chua biet origin unhealthy
// Ket qua: MISS thay vi stale HIT

// DUNG -- luon doi probe cycle
setOriginProfile({ healthy: false, error_status: 503 });
sleep(STALE_PROBE_WAIT_SECONDS); // >= 4s
const stale = requestCdn('GET', path);
```

### AP4: Khong reset origin profile trong teardown

```javascript
// SAI -- khong co teardown hoac teardown khong reset
export function teardown() {
  // Quen reset origin profile!
  resetOriginRequestCounts(); // Chi reset counter, khong reset profile
}
// -> Case tiep theo chay voi origin unhealthy -> fail

// DUNG -- teardown day du
export function teardown() {
  resetOriginProfile();
  waitOriginHealthy({ label: 'teardown' });
  resetOriginRequestCounts();
}
```

### AP5: Dat TTL qua ngan (< 1s)

```javascript
// SAI -- TTL = 0.1s
const STALE_TTL_SECONDS = 0.1;
// Object expire truoc khi kip warm HIT lan 2
// -> warm sequence: MISS -> MISS (thay vi MISS -> HIT)
// -> AssertCacheState(second, 'HIT') FAIL

// DUNG -- TTL >= 1s
const STALE_TTL_SECONDS = 2;
// Du thoi gian de warm MISS -> HIT
```

### AP6: Chay song song voi case khac

```text
SAI:
  Terminal 1: k6 run 09-stale-while-error.js
  Terminal 2: k6 run 10-request-coalescing.js
  -> Ca 2 cung dung control plane -> origin profile bi thay doi
     lien tuc -> ket qua khong xac dinh

DUNG:
  Chay tuan tu, moi lan chi 1 case
  Hoac: moi case dung target stack rieng
```

---

## 16. Real Validation Data

### 16.1 Lan chay thanh cong (local)

```text
Date: 2025-01-14
Stack: TargetLayer=full, Varnish 7.4, Nginx, app x2
Env:
  STALE_TTL_SECONDS=2
  STALE_IF_ERROR_SECONDS=120
  STALE_POST_TTL_WAIT_SECONDS=3
  STALE_PROBE_WAIT_SECONDS=4

Ket qua:
  checks: 8/8 PASS (100%)
  http_req_failed: 0/12 (0%)
  Total duration: ~13.1s

Request timeline:
  stale_first:  MISS, 200, duration=12ms
  stale_second: HIT,  200, duration=1ms
  stale_after_origin_unhealthy: HIT, 200, duration=0.5ms
  X-Cache-Stale: true
  X-Cache-Backend-Healthy: false
  Origin count: 1

Ket luan: PASS. Stale serving hoat dong dung contract.
```

### 16.2 Lan chay that bai (probe chua kip)

```text
Date: 2025-01-14
Stack: TargetLayer=full (same)
Env:
  STALE_PROBE_WAIT_SECONDS=1  <-- QUA NGAN

Ket qua:
  checks: 5/8 PASS (62.5%)
  stale_after_origin_unhealthy: status 200, X-Cache=MISS
  X-Cache-Stale: false
  X-Cache-Backend-Healthy: true
  Origin count: 2

Ket luan: FAIL. CDN chua detect origin unhealthy.
           Tang STALE_PROBE_WAIT_SECONDS len 4 -> PASS.
```

### 16.3 So sanh response time

| Request type | Response time (median) | Response time (p95) | Ghi chu |
| --- | --- | --- | --- |
| MISS (warm) | 12ms | 28ms | Origin delay + cache fill |
| HIT (fresh) | 1ms | 2ms | Tu RAM cache |
| HIT (stale) | 0.5ms | 1ms | Tu RAM cache, khong goi origin |
| Origin probe | 2ms | 5ms | Health check nhe |

Stale HIT **nhanh nhat** vi CDN khong can kiem tra origin (da biet unhealthy) va khong can background fetch.

---

## 17. Reference

### 17.1 Source files

| File | Path |
| --- | --- |
| Script nguon | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\09-stale-while-error.js` |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json` |
| Source README | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md` |

### 17.2 Docs lien quan

| File | Mo ta |
| --- | --- |
| `./00_overview.md` | Tong quan series CDN + bang 11 case + common patterns |
| `./08_ttl-expiry.md` | Case 08: TTL expiry (tien quyet de hieu stale) |
| `./10_request-coalescing.md` | Case 10: Request coalescing (case tiep theo) |
| `../RUN_GUIDE.md` | Huong dan chay toan bo suite |

### 17.3 Varnish documentation

| Topic | URL |
| --- | --- |
| VCL built-in subroutines | https://varnish-cache.org/docs/7.4/reference/vcl.html |
| Grace mode and stale | https://varnish-cache.org/docs/7.4/users-guide/vcl-grace.html |
| Health checks | https://varnish-cache.org/docs/7.4/users-guide/vcl-backends.html#health-checks |
| Request coalescing | https://varnish-cache.org/docs/7.4/users-guide/vcl-request-coalescing.html |

### 17.4 RFCs

| RFC | Topic |
| --- | --- |
| RFC 5861 | HTTP Cache-Control Extensions for Stale Content (`stale-while-revalidate`, `stale-if-error`) |
| RFC 7234 | HTTP/1.1 Caching |
| RFC 9111 | HTTP Caching |

### 17.5 Cac case lien quan

| Case | Moi quan he voi case 09 |
| --- | --- |
| 07-cache-contract | Origin phai tra `Cache-Control: stale-if-error=N` de CDN set grace |
| 08-ttl-expiry | Phai hieu TTL expiry truoc khi hieu stale serving |
| 10-request-coalescing | Ca 2 case deu dung origin request counter de chung minh |
| 11-negative-caching | Ca 2 case deu co stale/negative serving pattern |

---

## Phu luc A: Luoc do ra quyet dinh stale serving

```text
                    REQUEST DEN CDN
                          |
                     Object trong cache?
                      /           \
                    YES             NO
                     |               |
                 Object con         MISS -> origin
                 fresh (TTL)?
                  /       \
                YES        NO
                 |          |
              HIT fresh    Origin healthy?
                           /           \
                         YES            NO
                          |              |
                    Con trong grace?   Con trong stale-if-error?
                     /        \         /        \
                   YES        NO      YES        NO
                    |          |       |          |
              Background    MISS    Stale HIT    MISS -> 503
              fetch + HIT   -> origin  + set     (origin loi,
              (stale-while-            stale      khong con
              revalidate)             headers     stale)
```

## Phu luc B: So sanh chinh sach Cache-Control

| Directive | Y nghia | Vi du | Dung cho |
| --- | --- | --- | --- |
| `s-maxage=N` | TTL cho shared cache (giay) | `s-maxage=30` | Thoi gian object con fresh |
| `stale-while-revalidate=N` | Cho phep serve stale khi origin healthy, trong khi background fetch | `stale-while-revalidate=60` | Async refresh, giam latency |
| `stale-if-error=N` | Cho phep serve stale khi origin unhealthy | `stale-if-error=120` | Origin outage protection |
| `max-age=N` | TTL cho private cache (giay) | `max-age=10` | Browser cache |
| `must-revalidate` | Bat buoc revalidate khi expired, khong dung stale | `must-revalidate` | Data can fresh tuyen doi |
| `no-cache` | Luon revalidate truoc khi serve | `no-cache` | Data nhay cam |
| `no-store` | Khong duoc cache | `no-store` | Data mat, private |

---

## Phu luc C: Cac cau hoi thuong gap

### Q1: Neu origin healthy tro lai trong stale window, CDN xu ly the nao?

Khi origin healthy tro lai, health probe tiep theo se detect dieu nay. Request tiep theo se:
- Neu object con fresh -> HIT binh thuong
- Neu object expired nhung con trong grace/stale -> background fetch (stale-while-revalidate) hoac MISS
- Khong con serve stale nua

### Q2: Dieu gi xay ra neu ca TTL va stale window deu het?

CDN se co gang goi origin. Neu origin unhealthy -> 503. Neu origin healthy -> MISS (fetch object moi).

### Q3: Tai sao khong dat stale-if-error = 1 tuan?

Vi object cu co the tro nen "qua cu" (qua doi voi business). Vi du: gia san pham da thay doi, inventory da het, description da duoc cap nhat. Stale la giai phap **tam thoi**, khong phai vinh vien.

### Q4: Case 09 khac case 08 nhu the nao?

Case 08 chung minh object HIT truoc TTL va MISS sau TTL (origin van healthy).
Case 09 chung minh object HIT SAU TTL khi origin unhealthy (stale serving).
Ca 2 deu lien quan den TTL, nhung case 09 them yeu to origin health.
