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

### 1.4 Vi du thuc te: Flash sale ngay Black Friday

Gia su ban co mot dot flash sale vao Black Friday. San pham duoc cache voi TTL 30 giay. Luc 00:00:00, `products-service` crash vi qua tai.

- **Khong co stale-if-error:** Tat ca nguoi dung an "503 Service Unavailable" sau 30 giay. Doanh thu = 0.
- **Co stale-if-error voi window 10 phut:** Nguoi dung van thay san pham (du cache cu, gia co the da thay doi). Doanh thu van co. DevOps co 10 phut de fix origin.

### 1.5 Cac nghanh bi anh huong

| Nghanh | Vi sao quan trong |
| --- | --- |
| E-commerce | San pham, gia, inventory can duoc hien thi ke ca khi backend loi |
| News / Media | Bai viet, tin tuc van doc duoc khi CMS backend down |
| Streaming | Catalog, metadata van hien thi khi recommendation engine loi |
| SaaS | Trang landing, pricing van hien thi khi API backend bao tri |
| Gaming | Asset, config van duoc tai khi asset server qua tai |

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

### 2.3 Cac dieu KIEN de stale serving hoat dong

De stale serving hoat dong, can dong thoi 4 dieu kien:

| # | Dieu kien | Ai chiu trach nhiem | Cach kiem tra |
| --- | --- | --- | --- |
| 1 | Object da het TTL (expired) | Script: cho `STALE_POST_TTL_WAIT_SECONDS` > TTL | Kiem tra `Age` header > TTL |
| 2 | Origin dang unhealthy | Script: `setOriginProfile({ healthy: false })` | `X-Cache-Backend-Healthy: false` |
| 3 | Object con trong stale-if-error window | Origin: set `Cache-Control: stale-if-error=N` | Kiem tra object age < TTL + N |
| 4 | Object con trong cache (chua bi xoa) | CDN: `beresp.grace` > 0 trong VCL | Kiem tra `X-Cache: HIT` |

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
| Transparent to client | App phai duoc modify de tra stale response | CDN lam viec transparent, app khong can thay doi gi |
| Tach biet giua read va write | App khong biet request nao la cacheable read | CDN ap dung stale policy dua tren VCL rules |

### 3.2 Nguyen ly cot loi

```text
Stale-while-error la mot CAPABILITY CUA CDN, khong phai cua app.
App chi chiu trach nhiem tra ve Cache-Control: stale-while-revalidate=N
hoac CDN-Cache-Control: stale-if-error=N.
CDN la ben thuc thi chinh sach stale dua tren:
  - Object age (da qua TTL chua?)
  - Origin health (backend con song khong?)
  - Stale window (con nam trong stale-if-error khong?)

Day la mot vi du kinh dien cua Separation of Concerns:
  - App: "Day la data, no co hiêu luc trong TTL giay, nhung neu toi chet,
          ban co the dung data cu them N giay."
  - CDN: "Toi se giu data, theo doi suc khoe cua ban, va tu quyet dinh
          khi nao nen serve stale."
```

### 3.3 Tai sao khong the test o tang unit test hoac integration test

| Loai test | Han che |
| --- | --- |
| Unit test (app) | App khong co Varnish, khong co health probe, khong co `X-Cache` header |
| Integration test (app + DB) | Khong co CDN layer -> khong the test health probe timing |
| E2E test (qua browser) | Khong the force origin unhealthy mot cach dong bo + khong doc duoc CDN headers |
| Contract test (API) | Chi verify response format, khong verify CDN behavior |

Chi co **CDN-layer test** voi k6 (nhu case nay) moi co the:
1. Dieu khien origin profile runtime
2. Dong bo sleep/thoi gian
3. Doc CDN-specific headers
4. Verify origin counter

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

### 4.2 Thanh phan topology

| Thanh phan | Vai tro | Endpoint |
| --- | --- | --- |
| Varnish CDN | Edge cache, stale serving, health probe | `localhost:80` |
| Nginx | Reverse proxy den app | Internal |
| App services | Business logic | Internal |
| Origin simulator | Mo phong origin delay + error | Internal `/api/cached` |
| Control plane | Quan ly origin profile + counter | `localhost:8088` |

### 4.3 Precondition day du

| # | Dieu kien | Cach thiet lap | Kiem tra |
| --- | --- | --- | --- |
| P1 | Stack target chay voi `TargetLayer=full` | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full -ScaleApp 2` | `docker ps` thay Varnish + Nginx + app |
| P2 | Control plane kha dung | `CONTROL_BASE_URL=http://localhost:8088` | `curl http://localhost:8088/ops/app/cdn/origin/profile` tra 200 |
| P3 | OPS_AUTH_TOKEN hop le | Bien moi truong `OPS_AUTH_TOKEN` | Control API khong tra 401 |
| P4 | Origin profile ban dau healthy | Script goi `resetOriginProfile()` + `waitOriginHealthy()` | Probe thay `X-Cache-Backend-Healthy: true` |
| P5 | TTL object duoc chon du nho de test nhanh | `STALE_TTL_SECONDS=2` | Object expire sau 2 giay |
| P6 | Stale window du lon de bao phu toan bo qua trinh test | `STALE_IF_ERROR_SECONDS=120` | 120s >> toan bo thoi gian test (~10s) |
| P7 | Origin request counter da reset | `resetOriginRequestCounts()` | Counter ban dau = 0 |
| P8 | VCL cau hinh `beresp.grace` > 0 | Kiem tra VCL file | `varnishadm vcl.list` + inspect |

### 4.4 Kiem tra precondition bang tay

```powershell
# Kiem tra P2: Control plane kha dung
curl -H "Authorization: Bearer $env:OPS_AUTH_TOKEN" `
     http://localhost:8088/ops/app/cdn/origin/profile

# Kiem tra P3: Token hop le
# Response phai la 200, khong phai 401

# Kiem tra P4: Origin profile healthy
curl -s -H "Authorization: Bearer $env:OPS_AUTH_TOKEN" `
     http://localhost:8088/ops/app/cdn/origin/profile | jq .data.profile.healthy
# Phai tra ve: true

# Kiem tra P5+P6: Kha nang tao cached object
curl -s -o /dev/null -w "%{http_code}" `
     "http://localhost:80/api/cached?key=test&ttl_seconds=2&stale_if_error_seconds=120"
# Phai tra ve: 200
```

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

**Phan tich vi sao `vus: 1, iterations: 1`:**

Day la mot correctness test, khong phai load test. Chung ta chi can:
- 1 VU de chay setup -> default -> teardown tuan tu
- 1 iteration de thuc hien chinh xac 1 lan sequence MISS -> HIT -> wait -> stale HIT
- Nhieu VU hoac nhieu iteration se gay race condition (vd: VU khac request cung URL -> origin count tang -> FAIL sai)

**Bang env knobs day du:**

| Bien moi truong | Mac dinh | Y nghia | Anh huong neu thay doi | Gia tri toi thieu | Gia tri toi da |
| --- | --- | --- | --- | --- | --- |
| `STALE_TTL_SECONDS` | `2` | TTL cua object (giay) | Tang -> phai doi lau hon moi vao pha stale. Giam qua thap -> object expire truoc khi kip HIT lan 2. | `1` | `STALE_IF_ERROR_SECONDS - 5` |
| `STALE_IF_ERROR_SECONDS` | `120` | Cua so stale-if-error (giay) | Giam duoi 10s -> co the vuot qua cua so stale trong luc test. | `10` | `3600` (1 gio) |
| `STALE_POST_TTL_WAIT_SECONDS` | `3` (TTL+1) | Thoi gian doi sau warm de dam bao object het TTL | Phai > STALE_TTL_SECONDS. Buffer 1s de an toan. | `STALE_TTL_SECONDS + 1` | `STALE_TTL_SECONDS + 5` |
| `STALE_PROBE_WAIT_SECONDS` | `4` | Thoi gian doi sau set unhealthy de CDN detect | Qua ngan -> CDN chua detect -> request MISS thay vi stale HIT. | `2` (probe interval) | `STALE_IF_ERROR_SECONDS - STALE_POST_TTL_WAIT_SECONDS - 2` |

### 5.3 Phase B: setup() -- Warm Cache

```javascript
export function setup() {
  // B1: Tao URL dong voi TTL va stale-if-error duoc cau hinh
  const path = buildCachedPath(`stale-${Date.now()}`, {
    ttl_seconds: STALE_TTL_SECONDS,
    stale_if_error_seconds: STALE_IF_ERROR_SECONDS,
  });
  // URL vi du: /api/cached?key=stale-1719000000000&ttl_seconds=2&stale_if_error_seconds=120
  //
  // Luu y: Date.now() dam bao moi lan chay la mot key moi
  // -> Khong bi anh huong boi cache cu tu lan chay truoc

  // B2: Reset origin profile + counter ve trang thai ban dau
  resetOriginProfile();
  // -> POST /ops/app/cdn/origin/reset -> 200
  // -> Origin profile: { healthy: true, error_status: null }

  resetOriginRequestCounts();
  // -> POST /ops/app/cdn/origin/request-counts/reset -> 200
  // -> Tat ca counter = 0

  // B3: Doi origin healthy (co stable check)
  waitOriginHealthy({ label: 'stale setup origin recovery' });
  // -> Probe loop: GET /api/cached?key=health-... -> kiem tra
  //    - X-Cache-Backend-Healthy: true
  //    - HTTP status: 200
  //    - Profile: healthy=true
  // -> Yeu cau 2 samples lien tiep OK (stable check)
  // -> Neu timeout (12s) -> fail()

  // B4: Ban URL de dam bao object chua co trong cache
  banUrl(path);
  // -> POST /ops/app/cdn/cache/ban-url { url: path } -> 200
  // -> Xoa object khoi cache neu co

  // B5: Request dau tien -> MISS (cold cache fill)
  const first = requestCdn('GET', path, {
    tags: { case: 'stale_first' },
  });
  // -> GET http://localhost:80/api/cached?key=stale-...&ttl_seconds=2&...
  // -> CDN: object khong co trong cache -> MISS
  // -> CDN forward den origin
  // -> Origin xu ly -> tra 200
  // -> CDN cache object (TTL=2s, stale-if-error=120s)
  // -> Response: X-Cache=MISS, X-Cache-Stale=false, X-Cache-Backend-Healthy=true

  assertStatus(first, 200, 'stale first');
  // -> Kiem tra HTTP status = 200
  assertCacheState(first, 'MISS', 'stale first');
  // -> Kiem tra X-Cache = MISS

  // B6: Request thu hai -> HIT (warm cache)
  const second = requestCdn('GET', path, {
    tags: { case: 'stale_second' },
  });
  // -> GET cung URL
  // -> CDN: object co trong cache, con fresh -> HIT
  // -> Response: X-Cache=HIT, Age ~ 0.1s

  assertStatus(second, 200, 'stale second');
  assertCacheState(second, 'HIT', 'stale second');

  // B7: Tra ve path de default() su dung
  return { path };
}
```

**Phan tich `buildCachedPath`:**

Ham `buildCachedPath` trong `shared.js` tao URL voi query params duoc origin simulator doc de cau hinh hanh vi:

```javascript
export function buildCachedPath(key, params = {}) {
  return `${paths.cached}${buildQueryString({ key, ...params })}`;
}
// paths.cached = '/api/cached'
// Ket qua: /api/cached?key=stale-1719000000000&ttl_seconds=2&stale_if_error_seconds=120
```

Origin simulator doc `ttl_seconds` va `stale_if_error_seconds` de set response headers:

```http
HTTP/1.1 200 OK
Cache-Control: s-maxage=2, stale-if-error=120
CDN-Cache-Control: stale-if-error=120
Content-Type: application/json
```

**Tai sao can warm MISS -> HIT truoc?**

Day la de chung minh rang:
1. Object co the duoc cache binh thuong (MISS -> HIT)
2. CDN dang hoat dong dung (khong bi loi cau hinh)
3. Origin healthy ban dau (X-Cache-Backend-Healthy: true)
4. Origin counter = 1 sau MISS (baseline de so sanh)

Neu bo qua buoc warm, khong the biet duoc:
- Object co that su duoc cache khong?
- Origin co hoat dong binh thuong khong?
- Co van de gi ve VCL khong?

**Dong thoi gian setup:**

```text
t=0.0   buildCachedPath() -> /api/cached?key=stale-1719000000000&ttl_seconds=2&stale_if_error_seconds=120
t=0.1   resetOriginProfile() -> PATCH origin ve healthy
t=0.2   resetOriginRequestCounts() -> POST reset counter
t=0.3   waitOriginHealthy() -> probe + stable check (~2-3s)
        - Probe 1: GET /api/cached?key=health-... -> 200, healthy=true
        - Sleep 0.5s
        - Probe 2: GET /api/cached?key=health-... -> 200, healthy=true
        - 2 samples lien tiep OK -> pass
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
  //     PATCH /ops/app/cdn/origin/profile
  //     Body: { healthy: false, error_status: 503 }
  setOriginProfile({
    healthy: false,
    error_status: 503,
  });
  // Sau buoc nay, origin profile da chuyen sang unhealthy
  // NHUNG CDN chua biet! Can health probe cycle

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
  //     Chi co request MISS ban dau di den origin
  //     Request stale khong duoc goi origin
  const counts = getOriginRequestCounts();
  // -> GET /ops/app/cdn/origin/request-counts -> 200
  // -> Response: { data: { counts: [{ request_key: path, count: 1 }] } }

  const requestCount = findOriginRequestCount(counts, path);
  // -> Tim entry co request_key === path
  // -> Lay count

  if (requestCount !== 1) {
    throw new Error(
      `expected stale path ${path} to hit origin exactly once, got ${requestCount}`
    );
  }
  // Neu count > 1 -> CDN da goi origin them -> stale serving THAT BAI
  // Neu count = 0 -> origin counter broken hoac chua co MISS ban dau
}
```

**Phan tich tai sao can 2 sleep thay vi 1:**

Tai sao khong gop `STALE_POST_TTL_WAIT_SECONDS` va `STALE_PROBE_WAIT_SECONDS` thanh 1?

```text
SAI (gop sleep):
  sleep(7); // 3 + 4
  setOriginProfile({ healthy: false });
  // Khong doi health probe -> request ngay -> CDN chua detect unhealthy -> MISS

SAI (set unhealthy truoc, roi sleep):
  setOriginProfile({ healthy: false });
  sleep(7); // 3 + 4
  // Object da expired luc nay, nhung CDN co the da detect unhealthy
  // -> stale serving co the hoat dong -> PASS nhung KHONG CHINH XAC
  // Vi ta khong biet duoc thoi diem object expire vs thoi diem CDN detect unhealthy

DUNG (2 sleep rieng biet):
  sleep(3);  // Chi de object expire
  setOriginProfile({ healthy: false });
  sleep(4);  // Chi de CDN detect unhealthy
  // -> Co lap 2 bien: object age va origin health
  // -> Chung minh duoc: CDN serve stale VI origin unhealthy,
  //    khong phai vi object chua expire
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
  //     POST /ops/app/cdn/origin/reset
  resetOriginProfile();

  // D2: Doi origin thuc su healthy
  //     Co stable check (mac dinh 2 samples lien tiep)
  waitOriginHealthy({ label: 'stale teardown origin recovery' });
  // -> Neu khong reset hoac origin khong hoi phuc:
  //    Case 10, 11 se chay voi origin unhealthy -> fail hang loat

  // D3: Reset counter de khong anh huong case sau
  resetOriginRequestCounts();
}
```

**Vi sao teardown quan trong -- isolation giua cac case:**

```text
NEU KHONG CO TEARDOWN:
  Case 09: set origin unhealthy -> test stale -> KET THUC
  Case 10: chay voi origin unhealthy -> MISS den origin -> 503 -> FAIL
  Case 11: chay voi origin unhealthy -> MISS den origin -> 503 -> FAIL

CO TEARDOWN:
  Case 09: set origin unhealthy -> test stale -> teardown reset healthy
  Case 10: chay voi origin healthy -> MISS den origin -> 200 -> OK
  Case 11: chay voi origin healthy -> MISS den origin -> 200 -> OK
```

---

## 6. VCL Deep-Dive

### 6.1 VCL logic cho stale-if-error

Day la VCL pseudocode the hien hanh vi stale serving trong Varnish:

```vcl
sub vcl_recv {
    // Request den tu client
    // Varnish se tu dong ap dung grace/stale logic
    // Khong can code gi dac biet trong vcl_recv
}

sub vcl_hit {
    // Object da co trong cache
    if (obj.ttl >= 0s) {
        // Object con fresh (chua het TTL) -> deliver binh thuong
        // Khong set X-Cache-Stale
        set resp.http.X-Cache-Stale = "false";
        set resp.http.X-Cache-Backend-Healthy = std.healthy(bereq.backend) ? "true" : "false";
        return (deliver);
    }

    // Object da het TTL (expired)
    // Kiem tra xem con grace khong
    if (obj.ttl + obj.grace > 0s) {
        // Con trong grace window
        if (std.healthy(bereq.backend)) {
            // Origin healthy -> background fetch (stale-while-revalidate)
            // Hoac synchronous fetch (neu khong duoc cau hinh grace)
            set resp.http.X-Cache-Stale = "false";
            return (miss); // Trigger fetch
        } else {
            // Origin unhealthy -> serve stale
            set resp.http.X-Cache-Stale = "true";
            set resp.http.X-Cache-Backend-Healthy = "false";
            // Object age < TTL + grace, serve tu cache
            return (deliver);
        }
    }

    // Object da vuot qua ca grace window -> MISS bat buoc
    set resp.http.X-Cache-Stale = "false";
    return (miss);
}

sub vcl_miss {
    // Request MISS: khong co object trong cache
    // -> Forward den origin (fetch)
    // -> Object se duoc cache sau khi origin response
    return (fetch);
}

sub vcl_backend_response {
    // Origin vua tra response
    // Set grace period tu Cache-Control header
    if (beresp.http.Cache-Control ~ "stale-if-error=(\d+)") {
        set beresp.grace = std.duration(re.group(1) + "s", 0s);
    }
    // Hoac tu CDN-Cache-Control (uu tien hon)
    if (beresp.http.CDN-Cache-Control ~ "stale-if-error=(\d+)") {
        set beresp.grace = std.duration(re.group(1) + "s", 0s);
    }

    // Cung co the set grace tu stale-while-revalidate
    if (beresp.http.Cache-Control ~ "stale-while-revalidate=(\d+)") {
        // Varnish dung chung grace cho ca 2
        // Neu chua set (hoac gia tri nho hon), set grace
        if (beresp.grace < std.duration(re.group(1) + "s", 0s)) {
            set beresp.grace = std.duration(re.group(1) + "s", 0s);
        }
    }

    // Set TTL tu s-maxage hoac max-age
    if (beresp.http.Cache-Control ~ "s-maxage=(\d+)") {
        set beresp.ttl = std.duration(re.group(1) + "s", 0s);
    }

    return (deliver);
}

sub vcl_deliver {
    // Them X-Cache header de client biet cache state
    if (obj.hits > 0) {
        set resp.http.X-Cache = "HIT";
    } else {
        set resp.http.X-Cache = "MISS";
    }

    // Them age header
    set resp.http.Age = obj.age;

    return (deliver);
}
```

### 6.2 Grace period vs Stale-if-error

Day la mot trong nhung **nghenhan lon nhat** khi hoc CDN:

| Khai niem | Dinh nghia | Header nao set? | Khi nao dung? | Varnish bien | Uu tien |
| --- | --- | --- | --- | --- | --- |
| **TTL** | Thoi gian object con fresh | `Cache-Control: s-maxage=N` | Object age < TTL | `beresp.ttl` | Cao nhat |
| **grace** | Object co the duoc serve khi da het TTL nhung origin healthy (async refresh) | `Cache-Control: stale-while-revalidate=N` | Origin healthy + object expired + object age < TTL + grace | `beresp.grace` | Trung binh |
| **stale-if-error** | Object co the duoc serve khi da het TTL VA origin unhealthy | `Cache-Control: stale-if-error=N` hoac `CDN-Cache-Control: stale-if-error=N` | Origin unhealthy + object expired + object age < TTL + grace | `beresp.grace` (chung voi grace) | Thap (chi khi origin unhealthy) |
| **keep** | Object ton tai trong cache sau khi het ca grace lan stale window | Khong co header (internal Varnish) | Sau grace + stale window het | `obj.keep` | Thap nhat |

**Diem gay nham lan:** Varnish dung **cung mot bien `beresp.grace`** cho ca `stale-while-revalidate` va `stale-if-error`. Su khac biet nam o `vcl_hit`:

- Neu origin **healthy** + object expired trong grace -> `stale-while-revalidate` (background fetch, return(miss))
- Neu origin **unhealthy** + object expired trong grace -> `stale-if-error` (serve stale, return(deliver))

### 6.3 Health probe mechanism

Varnish duy tri health state cho moi backend qua health probe:

```vcl
backend default {
    .host = "nginx";
    .port = "80";
    .probe = {
        .url = "/health";
        .timeout = 1s;       // Timeout cho moi probe
        .interval = 5s;      // Khoang cach giua cac probe
        .window = 5;         // So probe gan nhat de tinh toan
        .threshold = 3;      // So probe thanh cong de coi la healthy
        .initial = 3;        // So probe ban dau (khoi dong)
    }
}
```

**Cach tinh health state:**

```text
Health state = (so probe thanh cong trong window >= threshold)

Vi du: window=5, threshold=3
Probe history: [OK, OK, FAIL, FAIL, FAIL]
So OK = 2 < threshold 3 -> UNHEALTHY

Probe history: [FAIL, FAIL, OK, OK, OK]
So OK = 3 >= threshold 3 -> HEALTHY
```

**Dong thoi gian health probe transition:**

```text
Origin:    [HEALTHY ------> UNHEALTHY ----------> HEALTHY]
Probe 1:   [  OK  ]  OK     FAIL     FAIL     [  OK  ]
Probe 2:   [  OK  ]  OK     FAIL     FAIL     [  OK  ]
Probe 3:   [  OK  ]  OK     FAIL     FAIL     [  OK  ]
Probe 4:   [  OK  ]  OK     FAIL     FAIL     [  OK  ]
Probe 5:   [  OK  ]  OK     FAIL     FAIL     [  OK  ]

Threshold=3, Window=5, Interval=5s
State:     [ HEALTHY ]  HEALTHY  UNHEALTHY  UNHEALTHY [ HEALTHY ]
                          ^                      ^
                          |                      |
                  toi thieu 3 FAIL   toi thieu 3 OK de
                  + interval=15s     tro lai healthy
                  de chuyen unhealthy
```

### 6.4 Ops endpoint health vs probe health

Co 2 co che "health" doc lap trong he thong nay:

| Co che | Mo ta | Endpoint | Cap nhat | Su dung boi |
| --- | --- | --- | --- | --- |
| Ops endpoint health | `setOriginProfile({ healthy: false })` ghi vao control plane | `PATCH /ops/app/cdn/origin/profile` | Ngay lap tuc (sau PATCH) | App simulator (tra 503 neu unhealthy) |
| Probe health | Varnish tu probe origin theo chu ky | Internal Varnish | Sau probe cycle (2-5s) | Varnish (quyet dinh stale serving) |

**Luong tuong tac:**

```text
1. setOriginProfile({ healthy: false, error_status: 503 })
   -> GHI: origin profile trong control plane = unhealthy
   -> App simulator doc profile -> tra 503 cho request moi

2. Varnish health probe (sau interval=5s)
   -> Goi GET /health -> origin tra 503 -> FAIL
   -> Sau threshold=3 lan FAIL -> Varnish health state = unhealthy

3. Request den Varnish
   -> std.healthy(backend) = false (Varnish health state)
   -> vcl_hit: origin unhealthy -> serve stale
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
                           background fetch (stale-while-rev)
                           neu origin healthy & co grace
```

### 7.3 Origin health state machine

```text
                    resetOriginProfile()
                    +-------------------+
                    |                   |
                    v                   |
    +--------+  PATCH unhealthy  +------------+
    |HEALTHY | ----------------> | UNHEALTHY  |
    +--------+                   +------------+
         ^                            |
         |                            |
         +----------------------------+
           PATCH healthy /
           resetOriginProfile()

    CDN health probe:
    - HEALTHY: threshold=3 OK in window=5
    - UNHEALTHY: < 3 OK in window=5
    - Transition delay: up to interval * threshold (15s max)
```

---

## 8. Key Signals / Headers Can Verify

### 8.1 Bang header day du

| Header | Xuat hien o dau | Gia tri mong doi trong case nay | Y nghia | Ai set? | Khi nao set? |
| --- | --- | --- | --- | --- | --- |
| `X-Cache` | Response header | `MISS` -> `HIT` -> `HIT` | Trang thai cache | Varnish (vcl_deliver) | Moi response |
| `X-Cache-Stale` | Response header | `false` -> `false` -> `true` | CDN danh dau object expired nhung van serve | Varnish (vcl_hit) | Chi khi serve stale |
| `X-Cache-Backend-Healthy` | Response header | `true` -> `true` -> `false` | Trang thai origin health | Varnish (vcl_hit) | Moi response |
| `Cache-Control` | Response header | Chua `s-maxage=2`, `stale-if-error=120` | Origin khai bao TTL + stale policy | Origin (app) | Moi response |
| `CDN-Cache-Control` | Response header (optional) | Chua `stale-if-error=120` | Override CDN-specific policy | Origin (app) | Moi response |
| `Age` | Response header | `0` -> `~0` -> `~7` | Thoi gian object da ton tai trong cache (giay) | Varnish (vcl_deliver) | Moi response |
| `X-Cache-Key-*` | Response header | Theo profile (vd: language=en) | Cache key dimensions | Varnish (vcl_deliver) | Moi response |

### 8.2 Bang control-plane signals

| Endpoint | Method | Response field | Gia tri mong doi | Y nghia |
| --- | --- | --- | --- | --- |
| `GET /ops/app/cdn/origin/profile` | GET | `data.profile.healthy` | `true` -> `false` -> `true` | Trang thai origin profile |
| `PATCH /ops/app/cdn/origin/profile` | PATCH | `data.profile.healthy` | `false` (sau patch) | Cap nhat origin profile |
| `POST /ops/app/cdn/origin/reset` | POST | `data.profile.healthy` | `true` | Reset origin profile |
| `GET /ops/app/cdn/origin/request-counts` | GET | `data.counts[]` | Array cac entries | Thong ke origin requests |
| `GET /ops/app/cdn/origin/request-counts` | GET | `data.counts[].request_key` | Chua path object | URL da duoc origin phuc vu |
| `GET /ops/app/cdn/origin/request-counts` | GET | `data.counts[].count` | `1` (chi MISS ban dau) | So lan origin phuc vu |
| `POST /ops/app/cdn/origin/request-counts/reset` | POST | `data.counts[]` | `[]` (rỗng) | Reset counter |

### 8.3 Bang internal Varnish signals (debug)

| Signal | Cach xem | Y nghia | Gia tri binh thuong |
| --- | --- | --- | --- |
| `backend_health` | `varnishlog -g raw -i Backend_health` | Health state cua backend | `healthy` hoac `sick` |
| `Hit` | `varnishlog -g request -i VCL_call -i VCL_return` | Request la HIT hay MISS | `vcl_hit` / `vcl_miss` |
| `TTL` | `varnishlog -g request -i TTL` | TTL cua object tai thoi diem request | So am = expired |
| `Grace` | `varnishlog -g request -i Grace` | Grace cua object | > 0 = con trong grace |
| `Age` | `varnishlog -g request -i Age` | Age cua object | Tang dan theo thoi gian |
| `FetchError` | `varnishlog -g raw -i FetchError` | Loi khi fetch tu origin | Rỗng = khong co loi |

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

| # | Fail pattern | Trieu chung | Nguyen nhan goc | Cach fix |
| --- | --- | --- | --- | --- |
| F1 | Stale request tra 503 | Status 503, X-Cache=MISS | Khong co stale object hoac vuot stale window | Tang `STALE_IF_ERROR_SECONDS`, kiem tra `beresp.grace` trong VCL |
| F2 | Stale request MISS | Status 200, X-Cache=MISS | CDN goi origin (origin van healthy theo probe) | Tang `STALE_PROBE_WAIT_SECONDS` |
| F3 | Stale request HIT nhung khong X-Cache-Stale | Status 200, HIT, X-Cache-Stale trong | Object chua het TTL -> van fresh | Tang `STALE_POST_TTL_WAIT_SECONDS` |
| F4 | Origin count > 1 | Stale PASS nhung count > 1 | CDN goi origin them -> stale serving khong bao ve origin | Kiem tra VCL `vcl_hit` logic, kiem tra probe health |
| F5 | X-Cache-Backend-Healthy = true | Header khong dung | CDN chua detect unhealthy | Tang `STALE_PROBE_WAIT_SECONDS`, kiem tra probe interval |
| F6 | Teardown fail | Khong reset duoc origin | Control plane khong kha dung | Kiem tra `CONTROL_BASE_URL`, `OPS_AUTH_TOKEN` |
| F7 | Setup fail (MISS ban dau 503) | `assertStatus(first, 200)` fail | Origin unhealthy ngay tu dau | Chay case 01 truoc, kiem tra stack |

### 9.3 Bang tong hop ket qua

| Scenario | Status | X-Cache | X-Cache-Stale | X-Cache-Backend-Healthy | Origin Count | Ket luan |
| --- | --- | --- | --- | --- | --- | --- |
| PASS | 200 | HIT | true | false | 1 | Stale serving dung contract |
| FAIL F1 | 503 | MISS | N/A | false | 1 | Vuot stale window |
| FAIL F2 | 200 | MISS | false | true | 2 | Chua detect unhealthy |
| FAIL F3 | 200 | HIT | false | true | 1 | Object con fresh |
| FAIL F4 | 200 | HIT | true | false | 3 | Goi origin them |
| FAIL F5 | 200 | HIT | true | true | 1 | Probe state sai |
| FAIL F6 | N/A | N/A | N/A | N/A | N/A | Control plane loi |
| FAIL F7 | 503 | MISS | N/A | false | 0 | Origin unhealthy ban dau |

---

## 10. Cach Chay + Output Mau

### 10.1 Cach chay co ban

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
```

### 10.2 Cach chay nang cao

```powershell
# Voi TTL dai hon (mo phong production)
$env:STALE_TTL_SECONDS = "30"
$env:STALE_IF_ERROR_SECONDS = "600"
$env:STALE_POST_TTL_WAIT_SECONDS = "35"
$env:STALE_PROBE_WAIT_SECONDS = "6"
k6 run .\k6\cdn\09-stale-while-error.js

# Voi probe interval ngan (neu da cau hinh VCL)
$env:STALE_TTL_SECONDS = "1"
$env:STALE_PROBE_WAIT_SECONDS = "2"
k6 run .\k6\cdn\09-stale-while-error.js

# Dung run-cdn-capabilities script
cd E:\Projects\k6\k6-metrics-server
.\scripts\run-cdn-capabilities.ps1 -Scenarios 09-stale-while-error
```

### 10.3 Output mau (PASS)

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

### 10.4 Output mau (FAIL -- probe chua kip)

```text
  ✗ stale after origin unhealthy status 200
    ↳  0% -- ✓ 0 / ✗ 1
  ✗ stale after origin unhealthy cache state HIT
    ↳  0% -- ✓ 0 / ✗ 1
  ✗ stale after origin unhealthy X-Cache-Stale equals true
    ↳  0% -- ✓ 0 / ✗ 1

  checks........................: 62.50% ✓ 5        ✗ 3

  ERRO[0013] expected stale path /api/cached?key=stale-1719000000000&ttl_seconds=2&stale_if_error_seconds=120
         to hit origin exactly once, got 2

  --> Giai thich: STALE_PROBE_WAIT_SECONDS qua ngan,
      CDN chua detect origin unhealthy -> request goi origin (MISS)
      -> status van 200 nhung la MISS, khong phai stale HIT
      -> origin count tang len 2

  --> Fix: Tang STALE_PROBE_WAIT_SECONDS len 6 hoac 8
```

### 10.5 Output mau (FAIL -- vuot stale window)

```text
  ✗ stale after origin unhealthy status 200
    ↳  0% -- ✓ 0 / ✗ 1
  ✗ stale after origin unhealthy cache state HIT
    ↳  0% -- ✓ 0 / ✗ 1

  checks........................: 75.00% ✓ 6        ✗ 2

  ERRO[0030] expected stale path ... to hit origin exactly once, got 1

  --> Giai thich: Stale window qua ngan, object da bi xoa khoi cache.
      CDN khong con stale object -> phai goi origin -> origin unhealthy -> 503.

  --> Fix: Tang STALE_IF_ERROR_SECONDS hoac giam STALE_POST_TTL_WAIT_SECONDS.
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

### 12.7 "Stale serving thay the hoan toan cho high availability"

**Nghich ly:** Neu co stale serving, khong can load balancer, circuit breaker, hoac retry logic.

**Su that:** Stale serving chi la mot **lop phong ve cuoi cung**. No khong thay the:
- Load balancer: phan phoi request den nhieu instance
- Circuit breaker: ngan khong cho request den origin da chet
- Retry: thu lai request neu that bai
- Replication: du phong database

Stale serving la lop bao ve cho **read path** trong thoi gian origin gap su co. No khong bao ve write path.

### 12.8 "Stale-if-error chi can cau hinh mot lan"

**Nghich ly:** Set `stale-if-error=120` mot lan, xong.

**Su that:** Stale-if-error can duoc:
1. Origin tra ve `Cache-Control: stale-if-error=N` (hoac `CDN-Cache-Control`)
2. VCL doc va set `beresp.grace` tu header do
3. `vcl_hit` kiem tra origin health truoc khi quyet dinh serve stale
4. VCL duoc test va verify dinh ky (khong bi thay doi boi nham)

Neu bat ky buoc nao bi bo qua, stale serving se khong hoat dong.

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
- [ ] Khong co Varnish restart gan day (probe can thoi gian de stable)

### 13.2 Script configuration checklist

- [ ] `STALE_TTL_SECONDS` >= 1 (khong duoc 0)
- [ ] `STALE_POST_TTL_WAIT_SECONDS` > `STALE_TTL_SECONDS` (it nhat +1s)
- [ ] `STALE_IF_ERROR_SECONDS` du lon (>= 60, tranh vuot window)
- [ ] `STALE_PROBE_WAIT_SECONDS` >= 4 (dam bao probe da chay)
- [ ] Total test duration khong vuot qua stale window:
      `STALE_TTL_SECONDS + STALE_POST_TTL_WAIT_SECONDS + STALE_PROBE_WAIT_SECONDS < STALE_IF_ERROR_SECONDS`
- [ ] Neu `STALE_TTL_SECONDS` < 1, k6 `sleep` co the khong du chinh xac

### 13.3 VCL verification

- [ ] `beresp.grace` duoc set > 0 trong `vcl_backend_response`
- [ ] `vcl_hit` kiem tra `std.healthy(bereq.backend)` truoc khi serve stale
- [ ] Khong co `return(pass)` trong `vcl_hit` cho cacheable requests
- [ ] `vcl_deliver` set `X-Cache-Stale` header
- [ ] Health probe duoc cau hinh dung (`interval`, `threshold`, `window`)

### 13.4 Pre-run verification

- [ ] Chay case 01 (hit-smoke) truoc de xac nhan cache co ban hoat dong
- [ ] Origin profile hien tai la healthy (kiem tra manual)
- [ ] Khong co script nao khac dang chay (tranh conflict control plane)
- [ ] Network connectivity: localhost:80, localhost:8088 deu reachable

### 13.5 Post-run verification

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

Chung minh origin khong bi goi them khi co nhieu stale request:

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
  assertHeaderEquals(extraStale, 'X-Cache-Backend-Healthy', 'false', `stale extra ${i}`);
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
    const first = requestCdn('GET', path);
    assertCacheState(first, 'MISS');
    const second = requestCdn('GET', path);
    assertCacheState(second, 'HIT');
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
    const stale = requestCdn('GET', path, { tags: { case: 'stale_multi' } });
    assertStatus(stale, 200);
    assertCacheState(stale, 'HIT');
    assertHeaderEquals(stale, 'X-Cache-Stale', 'true');
  }

  const counts = getOriginRequestCounts();
  let totalOriginHits = 0;
  for (const path of data.paths) {
    totalOriginHits += findOriginRequestCount(counts, path);
  }
  // Moi path chi co 1 MISS ban dau -> 5 total
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

  const fresh = requestCdn('GET', data.path, { tags: { case: 'fresh_after_recovery' } });
  assertStatus(fresh, 200);
  assertCacheState(fresh, 'MISS', 'fresh after recovery');
  assertHeaderEquals(fresh, 'X-Cache-Backend-Healthy', 'true');
  // Phai la MISS vi CDN goi origin de refresh object
}
```

### Variation 5: Stale window vuot qua -> 503

Chung minh khi stale window het, CDN tra loi:

```powershell
$env:STALE_TTL_SECONDS = "2"
$env:STALE_IF_ERROR_SECONDS = "1"    # RAT NGAN!
$env:STALE_POST_TTL_WAIT_SECONDS = "4"
$env:STALE_PROBE_WAIT_SECONDS = "6"
k6 run .\k6\cdn\09-stale-while-error.js
# EXPECTED: FAIL
# Object vuot stale window -> request tra 503
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
// -> assertCacheState(second, 'HIT') FAIL

// DUNG -- TTL >= 1s
const STALE_TTL_SECONDS = 2;
// Du thoi gian de warm MISS -> HIT
```

### AP6: Chay song song voi case khac

```text
SAI:
  Terminal 1: k6 run 09-stale-while-error.js
  Terminal 2: k6 run 10-request-coalescing.js
  -> Ca 2 cung dung control plane -> origin profile bi thay doi lien tuc
  -> Ket qua khong xac dinh

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
  stale_first:  MISS, 200, duration=12ms, X-Cache-Stale=false, X-Cache-Backend-Healthy=true
  stale_second: HIT,  200, duration=1ms,  X-Cache-Stale=false, X-Cache-Backend-Healthy=true
  stale_after_origin_unhealthy: HIT, 200, duration=0.5ms, X-Cache-Stale=true, X-Cache-Backend-Healthy=false

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
| HIT (fresh) | 1ms | 2ms | Tu RAM cache, khong goi origin |
| HIT (stale) | 0.5ms | 1ms | Tu RAM cache, khong goi origin |
| Origin probe | 2ms | 5ms | Health check nhe |

Stale HIT **nhanh nhat** vi CDN khong can kiem tra origin (da biet unhealthy) va khong can background fetch.

### 16.4 Kiem tra cross-case isolation

```text
Test: Chay case 09 -> case 10 -> case 11 lien tuc
Ket qua:
  Case 09: PASS (8/8 checks)
  Case 10: PASS (14/14 checks) -- origin healthy
  Case 11: PASS (10/10 checks) -- origin healthy

Ket luan: Teardown hoat dong dung, isolation giua cac case dam bao.
```

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
| `../12_validation-and-chart-analysis.md` | Validation data va chart analysis |

### 17.3 Varnish documentation

| Topic | URL |
| --- | --- |
| VCL built-in subroutines | https://varnish-cache.org/docs/7.4/reference/vcl.html |
| Grace mode and stale | https://varnish-cache.org/docs/7.4/users-guide/vcl-grace.html |
| Health checks | https://varnish-cache.org/docs/7.4/users-guide/vcl-backends.html#health-checks |
| Request coalescing | https://varnish-cache.org/docs/7.4/users-guide/vcl-request-coalescing.html |
| VSL query language | https://varnish-cache.org/docs/7.4/reference/vsl-query.html |

### 17.4 RFCs

| RFC | Topic |
| --- | --- |
| RFC 5861 | HTTP Cache-Control Extensions for Stale Content (`stale-while-revalidate`, `stale-if-error`) |
| RFC 7234 | HTTP/1.1 Caching |
| RFC 9111 | HTTP Caching |

### 17.5 Cac case lien quan

| Case | Moi quan he voi case 09 |
| --- | --- |
| 01-hit-smoke | Hieu MISS -> HIT co ban, nen tac cua case 09 |
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

| Directive | Header | Y nghia | Vi du | Uu tien | Dung cho |
| --- | --- | --- | --- | --- | --- |
| `s-maxage` | `Cache-Control` | TTL cho shared cache | `s-maxage=30` | 1 | Thoi gian object fresh |
| `max-age` | `Cache-Control` | TTL cho private cache | `max-age=10` | 2 | Browser cache |
| `stale-while-revalidate` | `Cache-Control` | Serve stale + background fetch khi origin healthy | `stale-while-revalidate=60` | 3 | Async refresh |
| `stale-if-error` | `Cache-Control` hoac `CDN-Cache-Control` | Serve stale khi origin unhealthy | `stale-if-error=120` | 4 | Origin outage protection |
| `must-revalidate` | `Cache-Control` | Bat buoc revalidate khi expired | `must-revalidate` | 5 | Data can fresh |
| `no-cache` | `Cache-Control` | Luon revalidate truoc khi serve | `no-cache` | 6 | Data nhay cam |
| `no-store` | `Cache-Control` | Khong duoc cache | `no-store` | 7 | Data mat |

## Phu luc C: Cac cau hoi thuong gap

### Q1: Neu origin healthy tro lai trong stale window, CDN xu ly the nao?

Khi origin healthy tro lai, health probe tiep theo se detect dieu nay. Request tiep theo se:
- Neu object con fresh -> HIT binh thuong
- Neu object expired nhung con trong grace -> background fetch (stale-while-revalidate) hoac MISS
- Khong con serve stale nua (vi `X-Cache-Stale` chi set khi origin unhealthy)

### Q2: Dieu gi xay ra neu ca TTL va stale window deu het?

CDN se co gang goi origin:
- Neu origin unhealthy -> 503 Service Unavailable
- Neu origin healthy -> MISS, fetch object moi

### Q3: Tai sao khong dat stale-if-error = 1 tuan?

Vi object cu co the tro nen "qua cu" (qua doi voi business):
- Gia san pham da thay doi
- Inventory da het
- Description da duoc cap nhat
- Bai viet da duoc sua

Stale la giai phap **tam thoi** de bao ve trai nghiem nguoi dung, khong phai giai phap **vinh vien** de thay the origin.

### Q4: Case 09 khac case 08 nhu the nao?

| Khia canh | Case 08 (TTL expiry) | Case 09 (Stale while error) |
| --- | --- | --- |
| Origin health | Luon healthy | Thay doi: healthy -> unhealthy -> healthy |
| Object state | HIT truoc TTL, MISS sau TTL | HIT truoc TTL, HIT stale sau TTL |
| Header dac biet | Khong | X-Cache-Stale, X-Cache-Backend-Healthy |
| Origin counter | Khong verify | Phai verify = 1 |
| Sleep | 1 (wait TTL) | 2 (wait TTL + wait probe) |

### Q5: Co the dung stale-if-error cho ca POST request khong?

Khong. Stale serving chi ap dung cho request GET va HEAD (read-only). POST, PUT, DELETE, PATCH luon di qua origin (hoac bi tu choi neu origin unhealthy).

### Q6: Neu muon stale serving nhung khong muon dung Varnish grace?

Co the dung `stale-while-revalidate` va `stale-if-error` qua header `CDN-Cache-Control` thay vi `Cache-Control`. `CDN-Cache-Control` duoc thiet ke rieng cho CDN, khong anh huong den browser cache:

```http
CDN-Cache-Control: s-maxage=30, stale-if-error=120
Cache-Control: max-age=10
```

Browser chi thay `max-age=10`, CDN thay `s-maxage=30, stale-if-error=120`.

### Q7: Stale serving co hoat dong khi CDN cung bi loi khong?

Khong. Stale serving chi bao ve khi **origin** bi loi. Neu **Varnish CDN** bi loi (crash, restart, mat dien), toan bo cache bi mat. Stale object khong the duoc phuc vu neu CDN khong hoat dong. Day la ly do can nhieu CDN node hoac CDN provider co high availability.

### Q8: Co the test stale serving ma khong can control plane khong?

Co the, nhung kho khan hon. Thay vi dung `setOriginProfile()`, ban co the:
- Dung firewall block origin IP
- Stop origin container (`docker stop <container>`)
- Dung network policy de chan traffic den origin

Nhung cach nay cham hon (mat vai giay de co hieu luc) va kho dong bo voi script k6. Control plane cho phep thay doi origin profile ngay lap tuc, dong bo voi script.

### Q9: Stale serving co anh huong den SEO khong?

Co the. Neu CDN serve stale content trong thoi gian dai:
- Googlebot co the crawl stale content
- Noi dung cu co the duoc index
- Gia san pham cu co the hien thi trong search results

Giai phap: set `stale-if-error` vua du (5-10 phut), khong qua dai (1-24 gio). Ket hop voi `Surrogate-Key` de invalidation nhanh khi origin hoi phuc.

### Q10: Su khac biet giua CDN-Cache-Control va Cache-Control?

| Header | Doc boi | Uu tien |
| --- | --- | --- |
| `Cache-Control` | Browser + CDN + Proxy | Thap (bi ghi de boi CDN-Cache-Control) |
| `CDN-Cache-Control` | CHI CDN | Cao (CDN uu tien header nay) |

```http
# Browser cache 10s, CDN cache 30s + stale 120s
Cache-Control: max-age=10
CDN-Cache-Control: s-maxage=30, stale-if-error=120
```

---

## Phu luc D: Troubleshooting stale serving

### D.1 Stale serving khong hoat dong -- 503

```text
Trieu chung: Request tra 503 thay vi 200 stale HIT.
Nguyen nhan:
  1. beresp.grace = 0 trong VCL -> khong co grace window
  2. Stale-if-error window da het
  3. Object da bi xoa khoi cache (LRU eviction)
  4. VCL vcl_hit khong kiem tra origin health

Cach fix:
  1. Kiem tra VCL: set beresp.grace = std.duration(...)
  2. Tang STALE_IF_ERROR_SECONDS
  3. Tang cache size (storage)
  4. Kiem tra vcl_hit co std.healthy() check
```

### D.2 Origin count tang sau moi stale request

```text
Trieu chung: Origin count > 1, tang dan sau moi request.
Nguyen nhan:
  1. CDN van background fetch khi origin healthy (grace mode)
  2. Nhieu VU/iteration cung request
  3. Probe health flapping (healthy/unhealthy dao dong)

Cach fix:
  1. Dam bao origin unhealthy TRUOC KHI request den
  2. Dung vus=1, iterations=1
  3. Tang STALE_PROBE_WAIT_SECONDS de health state on dinh
```

### D.3 X-Cache-Stale khong xuat hien

```text
Trieu chung: Request 200, X-Cache=HIT, nhung X-Cache-Stale khong co.
Nguyen nhan:
  1. Object chua het TTL -> van fresh
  2. VCL khong set X-Cache-Stale header
  3. vcl_deliver khong duoc customize

Cach fix:
  1. Tang STALE_POST_TTL_WAIT_SECONDS
  2. Them vao VCL: set resp.http.X-Cache-Stale = "true"; trong vcl_hit khi serve stale
```

### D.4 Control plane khong kha dung

```text
Trieu chung: resetOriginProfile() fail, setOriginProfile() fail.
Nguyen nhan:
  1. CONTROL_BASE_URL sai
  2. OPS_AUTH_TOKEN sai hoac het han
  3. Control plane service khong chay

Cach fix:
  1. Kiem tra CONTROL_BASE_URL (phai la localhost:8088)
  2. Kiem tra OPS_AUTH_TOKEN (curl thu cong)
  3. Kiem tra docker ps (control plane container)
```

### D.5 waitOriginHealthy() timeout

```text
Trieu chung: fail() "origin health wait timed out after 12s"
Nguyen nhan:
  1. Origin thuc su khong healthy
  2. Probe interval qua dai
  3. ORIGIN_HEALTH_WAIT_TIMEOUT_SECONDS qua ngan

Cach fix:
  1. Kiem tra origin container: docker ps, docker logs
  2. Tang ORIGIN_HEALTH_WAIT_TIMEOUT_SECONDS (env var)
  3. Tang ORIGIN_HEALTH_WAIT_STABLE_SAMPLES (neu can)
```

---

## Phu luc E: Stale serving trong cac CDN vendor khac

### E.1 So sanh cau hinh

| Vendor | Cach cau hinh | Header | Mac dinh |
| --- | --- | --- | --- |
| Varnish | `set beresp.grace = ...` trong VCL | `Cache-Control: stale-if-error=N` | Can cau hinh VCL |
| Fastly | `stale-if-error` trong VCL hoac header | `Cache-Control: stale-if-error=N` | Can cau hinh |
| Cloudflare | Cache Rules + `stale-if-error` support | `CDN-Cache-Control: stale-if-error=N` | Can enable |
| AWS CloudFront | `Origin Shield` + `stale-if-error` | `Cache-Control: stale-if-error=N` | Co san |
| Nginx | `proxy_cache_use_stale error timeout;` | Khong can header dac biet | Can cau hinh |
| Akamai | `stale-if-error` trong property config | `Cache-Control: stale-if-error=N` | Can cau hinh |

### E.2 Vi du cau hinh Nginx

```nginx
# Nginx proxy cache voi stale serving
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=my_cache:10m;

server {
    location /api/ {
        proxy_cache my_cache;
        proxy_cache_valid 200 30s;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_background_update on;
        proxy_pass http://origin;
    }
}
```

### E.3 Vi du cau hinh Fastly VCL

```vcl
sub vcl_backend_response {
    if (beresp.http.Cache-Control ~ "stale-if-error=(\d+)") {
        set beresp.stale_if_error = std.duration(re.group(1) + "s", 0s);
    }
    return (deliver);
}

sub vcl_hit {
    if (!std.healthy(req.backend) && obj.stale_if_error > 0s) {
        set resp.http.X-Cache-Stale = "true";
        return (deliver);
    }
    return (fetch);
}
```

---

## Phu luc F: Health probe trong Varnish -- cau hinh chi tiet

### F.1 Cac tham so probe

```vcl
backend default {
    .host = "nginx";
    .port = "80";
    .probe = {
        .url = "/health";           // URL probe
        .timeout = 2s;              // Timeout cho moi probe
        .interval = 5s;             // Khoang cach giua cac probe
        .window = 8;                // So probe gan nhat de tinh toan
        .threshold = 3;             // So probe thanh cong toi thieu de healthy
        .initial = 4;               // So probe ban dau (warm-up)
        .expected_response = 200;   // HTTP status mong doi
        .request =                  // Custom request (optional)
            "GET /health HTTP/1.1"
            "Host: localhost"
            "Connection: close";
    }
}
```

### F.2 Cach tinh health state

```text
Health = (so_probe_ok_trong_window >= threshold)

Vi du: window=5, threshold=3
[OK, OK, OK, FAIL, FAIL] -> count_ok=3 -> HEALTHY
[OK, FAIL, FAIL, FAIL, FAIL] -> count_ok=1 -> UNHEALTHY
[FAIL, FAIL, FAIL, OK, OK] -> count_ok=2 -> UNHEALTHY
[FAIL, OK, OK, OK, OK] -> count_ok=4 -> HEALTHY (sau khi du threshold)
```

### F.3 So sanh probe policy

| Policy | Threshold | Window | Interval | Thoi gian detect unhealthy | Do nhay |
| --- | --- | --- | --- | --- | --- |
| Nhanh | 1 | 1 | 2s | 2s | Cao (false positive) |
| Can bang | 2 | 3 | 5s | 10s | Trung binh |
| An toan | 3 | 5 | 5s | 15s | Thap (false negative) |
| Rat an toan | 5 | 8 | 10s | 50s | Rat thap |

### F.4 Health probe trong script test

Script `waitOriginHealthy()` trong `shared.js` khong chi kiem tra Varnish health probe, con kiem tra:

1. Origin profile trong control plane (`data.profile.healthy === true`)
2. Varnish `X-Cache-Backend-Healthy === 'true'`
3. HTTP status = 200
4. Stable: can it nhat 2 samples lien tiep (configurable)

```javascript
export function waitOriginHealthy(options = {}) {
  const timeoutSeconds = options.timeoutSeconds || 12;
  const intervalSeconds = options.intervalSeconds || 0.5;
  const stableSamples = options.stableSamples || 2;
  let consecutiveHealthy = 0;

  while ((Date.now() - startedAt) / 1000 <= timeoutSeconds) {
    const profile = getOriginProfile();
    const isProfileHealthy = profile?.data?.profile?.healthy === true;

    const probe = requestCdn('GET', healthCheckPath, {
      responseCallback: http.expectedStatuses({ min: 100, max: 599 }),
    });
    const isCdnHealthy = getHeader(probe, 'X-Cache-Backend-Healthy') === 'true';
    const isStatusOk = probe.status === 200;

    if (isProfileHealthy && isCdnHealthy && isStatusOk) {
      consecutiveHealthy++;
      if (consecutiveHealthy >= stableSamples) {
        return { healthy: true, attempts: consecutiveHealthy };
      }
    } else {
      consecutiveHealthy = 0;
    }
    sleep(intervalSeconds);
  }
  fail(`health wait timed out`);
}
```

Day la mot **multi-layer health check** -- no dam bao:
- Control plane profile healthy (app-level)
- Varnish health probe healthy (CDN-level)
- HTTP status OK (transport-level)
- Stable (khong flapping)

---

## Phu luc G: TTL, grace, keep trong Varnish

### G.1 Ba truong thoi gian cua object

```text
+--------+------------------+------------------+
|  TTL   |      grace       |      keep        |
| (fresh)|  (stale window)  | (object ton tai) |
+--------+------------------+------------------+
0       TTL               TTL+grace         TTL+grace+keep

TTL:    Object con fresh -> HIT, khong goi origin
grace:  Object expired, co the serve stale:
        - Origin healthy -> background fetch + deliver stale
        - Origin unhealthy -> serve stale
keep:   Object expired + het grace, chi de phuc vu ongoing request
        -> Request moi: MISS bat buoc
```

### G.2 Cach set trong VCL

```vcl
sub vcl_backend_response {
    // TTL: thoi gian object fresh
    set beresp.ttl = 30s;

    // Grace: thoi gian serve stale (stale-if-error / stale-while-revalidate)
    set beresp.grace = 120s;

    // Keep: thoi gian object ton tai them (cho ongoing request)
    set beresp.keep = 10s;
}
```

### G.3 Anh huong den stale serving

| Truong | Gia tri | Anh huong |
| --- | --- | --- |
| `beresp.ttl` | 30s | Sau 30s, object expired -> can grace |
| `beresp.grace` | 120s | Trong 120s sau TTL, object duoc serve stale |
| `beresp.keep` | 0s | Sau TTL+grace, object bi xoa ngay |
| `beresp.keep` | 10s | Sau TTL+grace+10s, object bi xoa |

### G.4 LRU eviction

Neu cache day, Varnish se xoa object cu nhat (LRU - Least Recently Used). Object dang trong grace window co the bi xoa neu cache day. De tranh:
- Tang cache size (`-s malloc,2G`)
- Tang keep window
- Dung `beresp.keep` de bao ve object quan trong

---

## Phu luc H: Tong ket cac chi so quan trong

### H.1 Cac nguong thoi gian

| Chi so | Mac dinh | Toi thieu | Toi da | Toi uu |
| --- | --- | --- | --- | --- |
| `STALE_TTL_SECONDS` | 2 | 1 | `STALE_IF_ERROR - 5` | 5-30 (production) |
| `STALE_IF_ERROR_SECONDS` | 120 | 10 | 3600 | 120-600 |
| `STALE_POST_TTL_WAIT_SECONDS` | TTL+1 | TTL+1 | TTL+5 | TTL+1 |
| `STALE_PROBE_WAIT_SECONDS` | 4 | 2 | `STALE_IF_ERROR - POST_TTL_WAIT - 2` | 4-8 |
| Test duration | ~13s | ~5s | ~STALE_IF_ERROR | < 60s |

### H.2 Cac nguong origin count

| Gia tri | Y nghia | Ket luan |
| --- | --- | --- |
| 0 | Counter broken hoac object khong duoc cache | FAIL |
| 1 | Chi 1 MISS ban dau -> stale serving hoan hao | PASS |
| 2 | 1 MISS + 1 stale fetch (race) -> chap nhan duoc | PASS (neu co stale headers) |
| 3+ | CDN da goi origin nhieu lan -> stale serving khong bao ve origin | FAIL |

### H.3 Cac nguong response time

| Request type | Response time (toi uu) | Response time (chap nhan) | Response time (can dieu tra) |
| --- | --- | --- | --- |
| MISS (warm) | < 20ms | < 50ms | > 100ms |
| HIT (fresh) | < 2ms | < 5ms | > 10ms |
| HIT (stale) | < 2ms | < 5ms | > 10ms |
| Health probe | < 10ms | < 30ms | > 50ms |
