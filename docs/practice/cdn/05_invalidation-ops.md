# Case 05: Manual Invalidation Ops

> **Case ID:** `cdn-05-invalidation-ops`
> **Script:** `05-invalidation-ops.js`
> **Layer:** CDN / Varnish
> **Proof:** purge, ban-url, and ban-tag invalidate expected objects
> **Primitives:** 3 — PURGE (exact object), BAN-URL (all variants of one URL), BAN-TAG (all objects with Surrogate-Key tag)
> **Pattern:** warmUntilHit --> invalidate --> verify MISS
> **Control path:** `:8088` (POST /ops/app/cdn/cache/purge | /ban-url | /ban-tag)
> **Public path:** `:80` (GET /api/cached | /api/sim/products/1 | /api/sim/products/1/recommendations)

---

## 1. Tinh huong thuc te

### Bai toan: cache da cu, content da moi

Mot san pham thay doi gia. Mot bai viet duoc chinh sua. Mot anh banner duoc cap
nhat. Content moi da duoc day len origin — nhung CDN van con giu ban cu trong
cache. Nguoi dung cuoi cung van nhin thay gia sai, bai viet loi, banner cu.

Day la tinh huong xay ra **hang ngay** trong moi he thong co CDN:

```text
Timeline cua mot su co "gia sai":
  t=0:   Product service update gia san pham #1 tu 500K -> 450K
         -> Origin da co gia moi: 450K

  t=1s:  User A mo app, request GET /api/sim/products/1
         -> CDN chua co cache -> MISS -> fetch tu origin -> cache lai
         -> User A thay gia 450K (DUNG)

  t=2s:  Cache TTL la 90s. Object duoc cache voi X-Cache: HIT.

  t=5s:  Marketing phat hien sai: gia giam KHONG PHAI 450K ma la 420K.
         -> Product service update lai: 420K
         -> Nhung CDN van con giu object cache 450K!

  t=6s:  User B mo app, request GET /api/sim/products/1
         -> CDN co cache -> HIT -> tra ve 450K
         -> User B thay gia 450K (SAI — dang le phai 420K)

  t=10s: User C mo app -> HIT -> van 450K (SAI)

  t=30s: User D mo app -> HIT -> van 450K (SAI)

  ... 90s troi qua, TTL het han ...

  t=95s: User E mo app -> MISS -> fetch tu origin -> 420K (DUNG)

  Ket luan: User B, C, D deu nhin thay gia sai trong ~90s.
           Neu 90s do la thoi diem flash sale -> thiet hai nghiem trong.
```

Cache la con dao hai luoi. No tang toc do, giam tai origin — nhung no cung la
nguyen nhan khien content cu ton tai qua lau sau khi origin da duoc cap nhat.
**Cache TTL cang dai, thoi gian "content sai" cang lau** neu khong co co che
invalidation.

### Ba primitive invalidation va khi nao dung cai nao

CDN layer cung cap **3 primitive invalidation**, moi cai cho mot muc dich
khac nhau:

```text
PRIMITIVE 1: PURGE — Xoa EXACT object (mot URL + mot variant)
  - Dung khi: chi mot URL cu the bi sai, va ban BAN BIET variant nao dang
    duoc cache (language, geo, device, AB variant).
  - Co che: Varnish purge xoa object trung khop CHINH XAC cache key.
  - Rui ro: Neu purge thieu variant headers -> co the purge sai object
    hoac khong purge duoc object dang duoc serve.
  - Vi du: "San pham #1 bi sai gia cho nguoi dung VN/mobile/control.
            Toi muon purge DUNG object do, khong anh huong gi khac."

PRIMITIVE 2: BAN-URL — Xoa TAT CA VARIANT cua mot URL
  - Dung khi: mot URL bi sai va CAN XOA TAT CA variant (tat ca
    language, tat ca geo, tat ca device, tat ca AB).
  - Co che: Varnish ban("req.url == " + url) — xoa toan bo object
    co cung URL, khong phan biet variant headers.
  - Rui ro: It rui ro ve "thieu variant" — day la diem MANH cua ban-url.
    Nhung neu co nhieu URL can xoa -> phai goi nhieu lan, khong kha mo.
  - Vi du: "San pham #1 bi sai CHUNG cho tat ca nguoi dung.
            Toi muon xoa toan bo variant cua no."

PRIMITIVE 3: BAN-TAG — Xoa TAT CA OBJECT co cung Surrogate-Key tag
  - Dung khi: mot thuc the (product, category, author) bi thay doi va
    TAT CA cac object lien quan deu can duoc invalidate.
  - Co che: Varnish ban("obj.http.Surrogate-Key ~ " + tag) — xoa
    toan bo object co Surrogate-Key chua tag do.
  - Rui ro: Phu thuoc vao origin dat Surrogate-Key DUNG. Neu origin
    khong set Surrogate-Key -> ban-tag vo nghia. Neu origin set sai
    tag -> ban-tag co the qua rong hoac qua hep.
  - Vi du: "San pham #1 thay doi -> can xoa detail (products/1),
            recommendations (products/1/recommendations), va search
            results co chua product-1. Tat ca deu co Surrogate-Key:
            product-1."

SO SANH NHANH:
  - PURGE:   chinh xac nhat, nhung can biet variant headers
  - BAN-URL: bao phu variant, nhung chi mot URL
  - BAN-TAG: bao phu nhieu URL cung tag, nhung phu thuoc Surrogate-Key
```

### Chon sai primitive = hậu qua thuc te

```text
SCENARIO A: Chon PURGE thay vi BAN-TAG
  -> Chi xoa duoc 1 object (vd: product detail)
  -> Recommendations, search results van con object cu
  -> User bam vao "san pham lien quan" -> thay content cu
  -> "Content sai" chi duoc sua mot phan

SCENARIO B: Chon BAN-URL thay vi PURGE
  -> Xoa tat ca variant cua URL do — ke ca nhung variant khong sai
  -> Origin phai tao lai TAT CA variant cho URL do
  -> Khong sai content, nhung ton tai nguyen khong can thiet

SCENARIO C: Chon BAN-TAG thay vi PURGE
  -> Tag "product-1" co the xoa detail + recommendations + search +
     homefeed neu tat ca deu duoc tag
  -> Nhung neu tag dat qua rong (vd: "products") -> xoa HANG LOAT
     object khong lien quan -> cache bi empty -> origin stampede

SCENARIO D: Chon BAN-URL thay vi BAN-TAG
  -> Phai goi ban-url cho TUNG URL: detail, recommendations, search,
     homefeed...
  -> Mat cong goi nhieu lan, co the quen mot URL
  -> BAN-TAG chi can MOT LAN cho tag "product-1"
```

Bai hoc cot loi: **khong co primitive nao la "tot nhat"**. Moi primitive co
mot muc dich rieng. Operator can hieu ro 3 primitive de chon dung cong cu
cho tung tinh huong cu the.

### Phan biet cac loai content change

Khong phai moi content change deu can invalidation. Phan biet dung loai
change se giup chon dung primitive va tranh invalidation khong can thiet:

```text
LOAI 1: DATA CHANGE — Thay doi du lieu goc (gia, mo ta, ton kho)
  -> Vi du: San pham #1 giam gia tu 500K -> 420K
  -> CACHE VI PHAM: Object cache chua gia 500K
  -> CAN INVALIDATION: Co — vi content da sai
  -> Dung primitive: PURGE hoac BAN-URL (neu tat ca variant bi anh huong)

LOAI 2: ASSOCIATION CHANGE — Thay doi moi quan he (san pham lien quan)
  -> Vi du: San pham #1 co them recommendations moi
  -> CACHE VI PHAM: Detail van dung, nhung recommendations da cu
  -> CAN INVALIDATION: Co — cho recommendations va search
  -> Dung primitive: BAN-TAG "product-1" (xoa ca detail neu can)

LOAI 3: METADATA CHANGE — Thay doi metadata (SEO title, meta desc)
  -> Vi du: SEO title cua product #1 thay doi
  -> CACHE VI PHAM: Neu metadata nam trong response body -> sai
  -> CAN INVALIDATION: Co — neu metadata anh huong den display
  -> Dung primitive: PURGE hoac BAN-URL

LOAI 4: COSMETIC CHANGE — Thay doi khong anh huong content (CSS, layout)
  -> Vi du: Nut "Mua ngay" chuyen tu xanh sang do
  -> CACHE VI PHAM: Chi neu CSS nam trong cached response
     Thuong CSS la asset rieng -> khong anh huong cache API
  -> CAN INVALIDATION: Khong — day la frontend deploy, khong phai
     content change
  -> Dung primitive: N/A

LOAI 5: INFRASTRUCTURE CHANGE — Thay doi backend, database, config
  -> Vi du: Migrate DB, them cache layer o app
  -> CACHE VI PHAM: Content van dung (fetch tu origin moi)
  -> CAN INVALIDATION: Khong — tru khi co content thay doi song song
  -> Dung primitive: N/A
```

### Day du mot incident thuc te: Flash sale + gia sai

```text
TINH HUONG: 10:00 AM — Flash sale bat dau

t=-30ph:  Content team upload gia sale:
          - San pham #1: 500K -> 350K (giam 30%)
          - San pham #2: 800K -> 560K (giam 30%)
          - San pham #3: 1.2M -> 840K (giam 30%)

t=-5ph:   CDN da cache nhieu object tu traffic organic
          -> MISS -> HIT (cac object da duoc cache)

t=0:      Flash sale BAT DAU
          -> Traffic tang dot ngot
          -> CDN serve HIT cho cac object DA CO trong cache
          -> KHONG CO VAN DE — cho den khi...

t=+2ph:   Marketing phat hien: San pham #1 gia SAI!
          -> Upload sai: 350K thay vi 300K (can giam 40%)
          -> Gia DUNG: 300K

          Content team update NGAY:
          -> Product service: PUT /products/1 { price: 300000 }
          -> Origin da co gia DUNG: 300K

          NHUNG CDN VAN CON OBJECT CU: 350K
          -> TTL con 88s (trong 90s)
          -> Moi request HIT tra ve 350K

t=+2ph30: KHACH HANG BAT DAU BAO LAI
          -> "Toi thay gia 350K nhung quang cao bao 300K?"
          -> Support nhan 50 complaints trong 30 giay

t=+3ph:   OPERATOR NHAN RA VAN DE
          -> Kiem tra origin: gia DUNG 300K
          -> Kiem tra CDN: van serve 350K (HIT)
          -> QUYET DINH: Invalidate!

          LUA CHON PRIMITIVE:
          A. PURGE /api/sim/products/1?
             -> Nhung variant nao bi anh huong?
             -> Neu chi variant VN/mobile bi upload sai -> chi can
                purge variant do
             -> Neu TAT CA variant deu sai -> nen dung ban-url

          B. BAN-URL /api/sim/products/1?
             -> Xoa tat ca variant -> don gian, an toan
             -> Nhieu nhat: origin nhan them 5-10 requests de
                cache lai cac variant -> khong dang ke

          C. BAN-TAG "product-1"?
             -> Xoa ca recommendations -> khong can thiet trong
                truong hop nay (recommendations khong chua gia)

          -> Chon B: ban-url (don gian, day du)

t=+3ph15: THUC HIEN INVALIDATION
          -> POST /ops/app/cdn/cache/ban-url
             Body: { url: "/api/sim/products/1" }
          -> Response: 200 "ban url added"

t=+3ph20: VERIFY — Request lai
          -> GET /api/sim/products/1 -> X-Cache: MISS -> 300K (DUNG!)
          -> Xac nhan: gia da dung

t=+5ph:   KHACH HANG TIEP TUC MUA HANG
          -> Thay gia 300K (DUNG)
          -> Khong con complaints moi

BAI HOC:
  1. Phan ung NHANH: 3 phut tu luc phat hien den luc fix
  2. Chon dung primitive: ban-url (don gian, day du)
  3. VERIFY sau invalidation: dam bao content moi duoc serve
  4. Neu KHONG CO invalidation -> khach hang thay gia sai trong 88s
     -> Hang ngan nguoi thay gia sai -> mat doanh thu, mat uy tin

NEU KHONG CO INVALIDATION MECHANISM:
  -> Phai doi 90s TTL het han
  -> Trong 90s: ~9000 requests (100 req/s)
  -> ~9000 nguoi thay gia sai
  -> Hoan toan khong chap nhan duoc cho mot flash sale
```

### Operator workflow lý tưởng

```text
1. AI PHAT HIEN content sai?
   -> Monitoring, customer report, marketing alert.

2. XAC DINH PHAM VI anh huong:
   -> Chi mot variant cu the? -> PURGE
   -> Tat ca variant cua mot URL? -> BAN-URL
   -> Nhieu URL cung mot thuc the? -> BAN-TAG (neu co Surrogate-Key)

3. THUC HIEN invalidation:
   -> Goi control API (khong phai public API)
   -> Nhan response 200 (chi la "lenh da duoc chap nhan")

4. VERIFY invalidation:
   -> Request lai public URL -> phai la MISS (khong phai HIT)
   -> Day la BUOC QUAN TRONG NHAT — khong duoc bo qua
   -> Neu van HIT -> purge/ban khong match cache key that su

5. GHI NHAN + BAO CAO:
   -> Primitive nao da dung? Thoi gian tu luc phat hien den luc fix?
   -> Co verify thanh cong khong?
   -> Neu fail -> root cause la gi?
   -> Log lai de toi uu quy trinh cho lan sau
```

---

## 2. CDN capability being proved

### Muc tieu chung

Case nay chung minh rang **ca 3 primitive invalidation deu hoat dong dung**:
chung thuc su xoa object khoi cache, khong chi tra ve HTTP 200 "da nhan lenh".

### Pattern chung minh

```text
BUOC 1: WARM — Dua object vao cache
  -> Request lan 1: MISS (fetch tu origin, cache lai)
  -> Request lan 2: HIT  (phuc vu tu cache)
  -> Xac nhan: object DA CO trong cache

BUOC 2: INVALIDATE — Goi lenh xoa
  -> Control API tra 200 (lenh da duoc Varnish chap nhan)
  -> Day moi chi la "control plane OK"

BUOC 3: VERIFY — Kiem tra object DA BI XOA THAT
  -> Request lai public URL
  -> PHAI la MISS (fetch lai tu origin)
  -> Neu van HIT -> INVALIDATION THAT BAI

Pattern: WARM (MISS->HIT) -> INVALIDATE -> VERIFY (MISS)
         ~~~~~~~~~~~~~~~~~                 ~~~~~~~~~~~~~
         Chung minh object                 Chung minh object
         DA CO trong cache                 DA BI XOA khoi cache
```

### 3 primitive duoc test trong case nay

| Primitive | Object duoc warm | Invalidation command | Object duoc verify |
|-----------|-----------------|---------------------|--------------------|
| PURGE | `/api/cached` (khong variant) | `purgeUrl(paths.cached)` | `/api/cached` -> MISS |
| BAN-URL | `/api/sim/products/1` (2 profiles) | `banUrl(paths.productDetail)` | Ca 2 profiles -> MISS |
| BAN-TAG | `/api/sim/products/1` + `/api/sim/products/1/recommendations` (cung tag `product-1`) | `banTag('product-1')` | Ca 2 endpoints -> MISS |

### Y nghia cua buoc WARM

Tai sao phai warm truoc khi invalidate?

```text
NEU KHONG WARM:
  -> Goi purge/ban ngay tu dau
  -> Sau do request -> MISS
  -> Nhung MISS do la do object CHUA BAO GIO CO trong cache!
  -> Khong the phan biet "invalidation thanh cong" vs "object chua tung cache"

NEU CO WARM:
  -> Warm chung minh object DA CO trong cache (MISS->HIT)
  -> Purge/ban
  -> Sau do request -> MISS
  -> MISS nay CHAC CHAN la do invalidation da xoa object
  -> Day la "before/after" proof
```

### Vi sao day la test LAYER CDN

Khong phai test "API purge co tra 200 khong". Day la test:

1. **Control path (ops)** tiep nhan lenh purge/ban/tag
2. **VCL logic** thuc thi dung hanh vi (purge exact key, ban match prefix/URL/tag)
3. **Data path (public)** phan anh ket qua: object da bi xoa that

Chi khi ca 3 deu dung -> case pass. Control API 200 mot minh la KHONG DU.

---

## 3. Vi sao test o CDN layer

### Control plane vs Data plane

He thong invalidation co 2 mat phang:

```text
CONTROL PLANE (:8088)                  DATA PLANE (:80)
~~~~~~~~~~~~~~~~~~~~~                  ~~~~~~~~~~~~~~~~
POST /ops/app/cdn/cache/purge          GET /api/sim/products/1
POST /ops/app/cdn/cache/ban-url        GET /api/sim/products/1/recommendations
POST /ops/app/cdn/cache/ban-tag        GET /api/cached
       |                                       |
       | (control API)                         | (public request)
       v                                       v
   Varnish nhan lenh                     Varnish serve content
   -> Goi ban() hoac purge               -> X-Cache: HIT hoac MISS
   -> Tra 200                            -> Tra response body
```

### Tai sao chi test control plane la KHONG DU

```text
BUG PATTERN 1: PURGE tra 200 nhung cache key khong match
  -> Control API: POST /ops/app/cdn/cache/purge { url: "/api/sim/products/1" }
  -> VCL: PURGE handler normalize_cache_variants roi goi return(purge)
  -> Nhung neu PURGE request KHONG CO variant headers -> cache key cua
     lenh purge KHAC voi cache key cua object da duoc cache (object cache
     co variant headers tu request goc)
  -> Varnish purge dung key ma no tinh -> nhung key do khong trung voi
     key cua object dang ton tai
  -> Control API tra 200 ("purged") -> nhung object VAN CON trong cache!
  -> Neu chi test control API -> PASS (200 OK)
  -> Neu test ca data plane -> public request van HIT -> FAIL

BUG PATTERN 2: BAN-TAG tra 200 nhung Surrogate-Key khong duoc set
  -> Control API: POST /ops/app/cdn/cache/ban-tag { tag: "product-1" }
  -> VCL: ban("obj.http.Surrogate-Key ~ product-1")
  -> Nhung origin KHONG set Surrogate-Key header trong response
  -> Varnish van chap nhan ban lenh, tra 200
  -> Nhung khong co object nao co Surrogate-Key: product-1
  -> Ban vo nghia!
  -> Neu chi test control API -> PASS (200 OK)
  -> Neu test ca data plane -> public request van HIT -> FAIL

BUG PATTERN 3: BAN-URL tra 200 nhung URL bi normalize khac nhau
  -> Control API: POST /ops/app/cdn/cache/ban-url { url: "/api/sim/products/1" }
  -> VCL: ban("req.url == " + "/api/sim/products/1")
  -> Nhung request goc co query params bi strip (tracking params) ->
     cache key la "/api/sim/products/1?color=red" sau khi strip -> van
     la "/api/sim/products/1"
  -> Ban URL match -> 200 -> nhung variant headers khac van duoc cache
  -> Neu chi test control API -> PASS
  -> Neu test data plane co variant khac -> van HIT -> FAIL
```

### Loi ich cua end-to-end verification

```text
Khong end-to-end:
  -> Operator goi purge, thay 200 -> "OK, xong roi"
  -> 5 phut sau user van bao content sai
  -> Operator: "Toi da purge roi ma!" -> debugging mat thoi gian

Co end-to-end:
  -> Test tu dong: warm -> invalidate -> verify MISS
  -> Neu verify MISS -> CHAC CHAN object da bi xoa
  -> Neu verify van HIT -> FAIL NGAY LAP TUC -> biet co van de
  -> Khong can user bao moi biet co loi
```

### Pham vi cua CDN-layer test

CDN-layer test khong test:

- Origin co update content dung khong (do app layer test)
- Database da duoc update chua (do DB layer test)
- User co thay content moi khong (do E2E test)

CDN-layer test CHI test:

- Sau khi goi purge/ban/tag -> object co bi xoa khoi cache that khong
- Day la contract cua CDN layer: "toi nhan lenh xoa -> toi xoa"

---

## 4. Topology & precondition

### Topology runtime

```text
                    CONTROL PATH (:8088)
                    ====================
                    POST /ops/app/cdn/cache/purge
                    POST /ops/app/cdn/cache/ban-url
                    POST /ops/app/cdn/cache/ban-tag
                           |
                           v
    +--------+      +----------+      +-------+      +-----------+
    |  k6    |----->|  Varnish |----->| Nginx |----->| app       |
    | client |      |  CDN     |      |       |      | services  |
    +--------+      +----------+      +-------+      +-----------+
         |               |
         |  PUBLIC PATH (:80)
         |  ===================
         +-> GET /api/cached
             GET /api/sim/products/1
             GET /api/sim/products/1/recommendations
```

- **Public path** (`:80`): k6 -> Varnish -> Nginx -> app services
  - Dung de warm object (dua vao cache)
  - Dung de verify sau invalidation (phai la MISS)
  - `X-Cache` header tren response cho biet HIT hay MISS

- **Control path** (`:8088`): k6 -> Varnish (truc tiep, khong qua Nginx)
  - Dung de goi lenh invalidation
  - Yeu cau `OPS_AUTH_TOKEN` (X-Ops-Token header)
  - Response 200 = Varnish da chap nhan ban/purge lenh

- **Event path** (`:9091`): khong su dung trong case nay

### Precondition

Truoc khi chay case, can dam bao:

1. **Target layer = full** (Varnish + Nginx + app deu running)

2. **OPS_AUTH_TOKEN** phai duoc set:
   ```powershell
   $env:OPS_AUTH_TOKEN = "<ops-token>"
   ```
   Token nay duoc su dung trong ca X-Ops-Token header (VCL check)
   va Authorization header (Nginx check). Thieu token -> 401.

3. **Test paths duoc clear** truoc khi test:
   Script tu dong goi `purgeUrl` va `banUrl` trong `setup()` de xoa sach
   cac path se duoc test, dam bao khong co object cu ton tai tu truoc.

4. **Origin healthy**: Varnish backend probe phai bao healthy
   (`X-Cache-Backend-Healthy: true`)

5. **Chay tuan tu**: Khong chay song song voi cac CDN case khac
   (shared cache state)

### Env knobs

```text
BASE_URL              = http://localhost:80
CONTROL_BASE_URL      = http://localhost:8088
OPS_AUTH_TOKEN        = <token> (REQUIRED)
```

Case nay khong can TTL_WAIT_SECONDS hay cac knobs dac biet khac.

---

## 5. Script deep-dive

### Cau truc tong the

```javascript
// 05-invalidation-ops.js — 97 lines
// 1 VU, 1 iteration (chay tuan tu, khong can concurrency)

options: { vus: 1, iterations: 1, thresholds: { checks: ['rate==1'] } }

setup()     // clear test paths
default()   // 3 test blocks: PURGE, BAN-URL, BAN-TAG
```

### Helper: warmUntilHit()

```javascript
function warmUntilHit(path, profile, label) {
  // Request 1: MISS — day la lan fetch tu origin
  const first = requestCdn('GET', path, { profile, tags: ... });
  assertStatus(first, 200, ...);       // origin tra 200
  assertUpstream(first, 'products-service', ...); // dung service xu ly
  assertCacheState(first, 'MISS', ...); // CHUA co trong cache

  // Request 2: HIT — object da duoc cache tu request 1
  const second = requestCdn('GET', path, { profile, tags: ... });
  assertStatus(second, 200, ...);       // van tra 200
  assertCacheState(second, 'HIT', ...); // BAY GIO da co trong cache
}
```

Pattern nay duoc dung 4 lan trong script:
- 2 lan cho BAN-URL (warm productDetail voi 2 profiles)
- 2 lan cho BAN-TAG (warm productDetail + recommendations)

Y nghia cua `assertUpstream(first, 'products-service', ...)`:
Xac nhan request MISS thuc su di qua origin (products-service),
khong phai la truong hop bypass hay loi. Chi khi da qua origin
va duoc cache thi HIT moi co y nghia.

### setup(): Clear test paths

```javascript
export function setup() {
  purgeUrl(paths.cached);         // Xoa /api/cached
  banUrl(paths.productDetail);    // Xoa /api/sim/products/1
  banUrl(paths.recommendations);  // Xoa /api/sim/products/1/recommendations
}
```

- `purgeUrl` goi POST /ops/app/cdn/cache/purge qua control path
- `banUrl` goi POST /ops/app/cdn/cache/ban-url qua control path
- Cac lenh nay khong duoc assert trong setup — chi don dep
- Neu co object cu ton tai tu lan chay truoc -> bi xoa sach

Tai sao dung `banUrl` cho productDetail va recommendations thay vi `purgeUrl`?
Vi `banUrl` xoa TAT CA variant, dam bao khong con variant nao sot lai.
`purgeUrl` khong co profile argument -> chi purge object khong co variant
headers, co the bo sot variant da cache tu lan chay truoc.

### Block 1: PURGE test

```javascript
// PURGE test: /api/cached (khong co variant headers)
// Day la path don gian nhat — khong can profile

// Warm: dua object vao cache
const cachedFirst = requestCdn('GET', paths.cached, { tags: ... });
assertStatus(cachedFirst, 200, 'cached first');
assertCacheState(cachedFirst, 'MISS', 'cached first');

const cachedSecond = requestCdn('GET', paths.cached, { tags: ... });
assertStatus(cachedSecond, 200, 'cached second');
assertCacheState(cachedSecond, 'HIT', 'cached second');
// -> Da chung minh object co trong cache

// Invalidate: purge exact URL
purgeUrl(paths.cached);
// -> POST /ops/app/cdn/cache/purge { url: "/api/cached" }
// -> VCL: return(purge) -> vcl_purge -> synth(200, "purged")

// Verify: request lai -> phai MISS
const cachedAfterPurge = requestCdn('GET', paths.cached, { tags: ... });
assertStatus(cachedAfterPurge, 200, 'cached after purge');
assertCacheState(cachedAfterPurge, 'MISS', 'cached after purge');
// -> MISS chung minh object da bi xoa khoi cache
```

Diem dac biet cua block nay:
- Path `/api/cached` la path don gian, khong co variant headers trong cache key
- VCL cung khong goi `normalize_cache_variants` cho path nay -> cache key chi
  la `req.url + host`
- PURGE khong can gui variant headers vi khong co variant de phan biet
- Day la truong hop don gian nhat cua PURGE

### Block 2: BAN-URL test

```javascript
// BAN-URL test: /api/sim/products/1
// Test VOI 2 PROFILES KHAC NHAU de chung minh ban-url xoa TAT CA variant

const guest = profiles.guestVNMobileControl;
// { vi, VN, mobile, control, guest }

const variantA = profiles.guestVNMobileVariantA;
// { vi, VN, mobile, variant-a, guest }

// Warm product detail voi CA 2 profiles
warmUntilHit(paths.productDetail, guest, 'guest_variant');
warmUntilHit(paths.productDetail, variantA, 'variant_a');
// -> Co 2 variant cua /api/sim/products/1 trong cache
//    variant 1: language=vi, geo=VN, device=mobile, ab=control
//    variant 2: language=vi, geo=VN, device=mobile, ab=variant-a

// Invalidate: ban-url
banUrl(paths.productDetail);
// -> POST /ops/app/cdn/cache/ban-url { url: "/api/sim/products/1" }
// -> VCL: ban("req.url == /api/sim/products/1")
// -> Xoa TAT CA object co cung URL nay

// Verify: ca 2 profiles deu MISS
const guestAfterBanUrl = requestCdn('GET', paths.productDetail, {
  profile: guest, tags: ... });
assertStatus(guestAfterBanUrl, 200, 'guest after ban-url');
assertCacheState(guestAfterBanUrl, 'MISS', 'guest after ban-url');

const variantAfterBanUrl = requestCdn('GET', paths.productDetail, {
  profile: variantA, tags: ... });
assertStatus(variantAfterBanUrl, 200, 'variant after ban-url');
assertCacheState(variantAfterBanUrl, 'MISS', 'variant after ban-url');
// -> CA 2 deu MISS -> CHUNG MINH ban-url XOA TAT CA VARIANT
```

Diem dac biet cua block nay:
- Day la minh chung QUAN TRONG: ban-url xoa TAT CA variant, khong chi variant
  duoc dung de goi lenh ban
- Neu chi verify 1 profile -> co the ban-url chi xoa variant do, con variant
  kia van HIT -> khong du manh
- Verify CA 2 profiles -> chung minh ban-url that su la "xoa URL, bo qua variant"

Tai sao KHONG dung PURGE cho block nay?
- PURGE can biet variant headers de purge dung key
- Neu purge thieu variant headers -> co the purge sai key hoac khong purge duoc
- BAN-URL don gian hon: khong can biet variant, chi can biet URL

### Block 3: BAN-TAG test

```javascript
// BAN-TAG test: 2 endpoints cung tag "product-1"
// Test chung minh ban-tag xoa TAT CA object co cung Surrogate-Key

// Clear truoc de co clean state
banUrl(paths.productDetail);
banUrl(paths.recommendations);

// Warm ca 2 endpoints voi cung 1 profile
warmUntilHit(paths.productDetail, guest, 'detail_for_tag');
warmUntilHit(paths.recommendations, guest, 'recs_for_tag');
// -> Ca 2 deu duoc cache
//    /api/sim/products/1               co Surrogate-Key: product-1
//    /api/sim/products/1/recommendations co Surrogate-Key: product-1

// Invalidate: ban-tag "product-1"
banTag('product-1');
// -> POST /ops/app/cdn/cache/ban-tag { tag: "product-1" }
// -> VCL: ban("obj.http.Surrogate-Key ~ product-1")
// -> Xoa TAT CA object co Surrogate-Key chua "product-1"

// Verify: ca 2 endpoints deu MISS
const detailAfterTag = requestCdn('GET', paths.productDetail, {
  profile: guest, tags: ... });
assertStatus(detailAfterTag, 200, 'detail after ban-tag');
assertCacheState(detailAfterTag, 'MISS', 'detail after ban-tag');

const recsAfterTag = requestCdn('GET', paths.recommendations, {
  profile: guest, tags: ... });
assertStatus(recsAfterTag, 200, 'recs after ban-tag');
assertCacheState(recsAfterTag, 'MISS', 'recs after ban-tag');
// -> CA 2 deu MISS -> CHUNG MINH ban-tag XOA TAT CA OBJECT CUNG TAG
```

Diem dac biet cua block nay:
- Day la block MANH NHAT: mot lenh ban-tag xoa nhieu URL khac nhau
- 2 endpoint hoan toan khac nhau (detail + recommendations)
- Nhung cung chung mot Surrogate-Key "product-1"
- Ban-tag thanh cong -> ca 2 deu MISS
- Neu 1 trong 2 van HIT -> co nghia endpoint do KHONG CO Surrogate-Key
  "product-1" -> origin khong set dung tag

Tai sao can `banUrl` truoc khi warm cho block BAN-TAG?
Block 2 da cache productDetail. Block 3 can clean state de warm lai.
Neu khong clean -> warmUntilHit co the thay HIT ngay lan dau tien (vi
van con cache tu block 2) -> assertCacheState MISS se fail.

### Thu tu thuc thi

```text
setup():
  purgeUrl(/api/cached)
  banUrl(/api/sim/products/1)
  banUrl(/api/sim/products/1/recommendations)

default():
  === BLOCK 1: PURGE ===
  warm /api/cached (MISS->HIT)
  purgeUrl(/api/cached)
  verify /api/cached -> MISS

  === BLOCK 2: BAN-URL ===
  warm /api/sim/products/1 voi guest   (MISS->HIT)
  warm /api/sim/products/1 voi variantA (MISS->HIT)
  banUrl(/api/sim/products/1)
  verify /api/sim/products/1 voi guest   -> MISS
  verify /api/sim/products/1 voi variantA -> MISS

  === BLOCK 3: BAN-TAG ===
  banUrl(/api/sim/products/1)           // clear tu block 2
  banUrl(/api/sim/products/1/recommendations)
  warm /api/sim/products/1               (MISS->HIT)
  warm /api/sim/products/1/recommendations (MISS->HIT)
  banTag('product-1')
  verify /api/sim/products/1               -> MISS
  verify /api/sim/products/1/recommendations -> MISS
```

---

## 6. Invalidation primitives deep-dive

Day la phan QUAN TRONG NHAT cua case nay. Hieu ro 3 primitive la hieu ro
toan bo cach CDN quan ly invalidation.

### Primitive 1: PURGE — Xoa exact object

**HTTP method:** `PURGE` (khong phai GET/POST/DELETE — day la method
dac biet cua Varnish)

**Control path call:**
```javascript
purgeUrl(url, profile = null)
// -> POST /ops/app/cdn/cache/purge
// -> Body: { url: "/api/cached", headers?: { "Accept-Language": "vi", ... } }
// -> Headers: Authorization: Bearer <token>, X-Ops-Token: <token>
```

**VCL handling:**
```vcl
# vcl_recv — PURGE block
if (req.method == "PURGE") {
    // 1. Xac thuc token
    if (req.http.X-Ops-Token != "__CDN_OPS_TOKEN__") {
        return (synth(401, "unauthorized"));
    }

    // 2. White-list path
    if (req.url !~ "^/(api/cached|api/sim/products)") {
        return (synth(403, "forbidden path"));
    }

    // 3. Normalize variant headers (chi cho /api/sim/products)
    if (req.url ~ "^/api/sim/products($|/|\\?)") {
        call normalize_cache_variants;
    }

    // 4. Xoa object co cache key match chinh xac
    return (purge);
}

# vcl_purge — response sau khi purge
sub vcl_purge {
    return (synth(200, "purged"));
}
```

**Co che cache key cua PURGE:**
```text
Varnish tinh cache key CHO LENH PURGE giong nhu tinh cache key cho
request GET thong thuong. Dieu nay co nghia:

1. Neu path la /api/sim/products/*:
   -> VCL goi normalize_cache_variants
   -> Cache key bao gom: url + variant headers (language, geo, device, AB)
   -> PURGE se xoa DUNG object co variant headers KHO P

2. Neu path la /api/cached:
   -> VCL KHONG goi normalize_cache_variants
   -> Cache key chi bao gom: url + host
   -> PURGE se xoa DUNG object voi url do

3. NEU PURGE request KHONG CO variant headers (cho /api/sim/products/*):
   -> normalize_cache_variants van chay -> set default values
      (language=en, geo=VN, device=desktop, ab=control)
   -> PURGE se xoa object co variant MAC DINH
   -> NHUNG object thuc te duoc cache VOI variant KHAC (vd: vi, VN, mobile, variant-a)
   -> Cache key KHONG match -> PURGE KHONG CO TAC DUNG!
```

**Khi nao dung PURGE:**
- Ban BAN BIET chinh xac variant nao dang duoc cache
- Muon xoa MOT variant cu the, khong anh huong variant khac
- Vi du: chi co nguoi dung VN/mobile/variant-a bi loi, variant control
  khong bi loi -> chi purge variant-a

**Khi nao KHONG nen dung PURGE:**
- Khong biet variant nao dang duoc cache
- Muon xoa tat ca variant cua mot URL (dung BAN-URL thay vi)
- Co nhieu URL can xoa (dung BAN-TAG thay vi)

### Primitive 2: BAN — Xoa theo dieu kien

**HTTP method:** `BAN` (method dac biet cua Varnish)

BAN la primitive TONG QUAT HON PURGE. Thay vi xoa exact key, BAN them mot
"ban lurker expression" vao ban list. Varnish se match expression nay voi
TUNG REQUEST DEN, va xoa object neu expression match.

Co 3 bien the cua BAN:

#### 2a: BAN-URL — Xoa exact URL, tat ca variant

**Control path call:**
```javascript
banUrl(url)
// -> POST /ops/app/cdn/cache/ban-url
// -> Body: { url: "/api/sim/products/1" }
// -> Headers: X-Ops-Token, Authorization
```

**VCL handling:**
```vcl
if (req.method == "BAN") {
    if (req.http.X-Ban-URL) {
        // Validate URL format
        if (req.http.X-Ban-URL !~ "^/[A-Za-z0-9/_?&=.-]+$") {
            return (synth(400, "invalid X-Ban-URL"));
        }
        // BAN exact URL match
        ban("req.url == " + req.http.X-Ban-URL);
        return (synth(200, "ban url added"));
    }
}
```

**Co che:**
```text
ban("req.url == /api/sim/products/1")

Bieu thuc nay duoc luu trong ban list. Khi mot request moi den,
Varnish kiem tra TUNG expression trong ban list:
  - Neu "req.url == /api/sim/products/1" -> TRUE -> xoa object
  - Neu "req.url == /api/sim/products/2" -> FALSE -> giu object

BAN-URL match CHINH XAC URL, khong quan tam variant headers.
 -> Xoa TAT CA variant cua URL do.
 -> Day la diem MANH nhat cua ban-url.
```

**Khi nao dung BAN-URL:**
- Content sai anh huong den TAT CA nguoi dung (tat ca variant)
- Muon xoa mot URL nhung khong biet nhung variant nao dang duoc cache
- Don gian, khong can biet variant headers

**Khi nao KHONG nen dung BAN-URL:**
- Chi mot variant bi loi -> dung PURGE de tranh xoa ca variant tot
- Nhieu URL can xoa -> dung BAN-TAG (neu co tag) hoac BAN-PREFIX

#### 2b: BAN-PREFIX — Xoa theo URL prefix

**Control path call:**
```javascript
banPrefix(prefix)
// -> POST /ops/app/cdn/cache/ban
// -> Body: { prefix: "/api/sim/products/" }
// -> Headers: X-Ops-Token, Authorization
```

**VCL handling:**
```vcl
if (req.method == "BAN") {
    // ... X-Ban-URL va X-Ban-Tag check truoc ...
    if (!req.http.X-Ban-Prefix) {
        return (synth(400, "missing X-Ban-Prefix or X-Ban-Tag"));
    }
    if (req.http.X-Ban-Prefix !~ "^/[A-Za-z0-9/_-]+$") {
        return (synth(400, "invalid X-Ban-Prefix"));
    }
    ban("req.url ~ ^" + req.http.X-Ban-Prefix);
    return (synth(200, "ban added"));
}
```

**Co che:**
```text
ban("req.url ~ ^/api/sim/products/")

Bieu thuc nay match TAT CA URL bat dau bang "/api/sim/products/":
  /api/sim/products/1               -> MATCH -> xoa
  /api/sim/products/2               -> MATCH -> xoa
  /api/sim/products/categories      -> MATCH -> xoa
  /api/sim/products/search?q=shoe   -> MATCH -> xoa
  /api/sim/products/homefeed        -> MATCH -> xoa
  /api/cached                       -> KHONG MATCH -> giu
```

**Khi nao dung BAN-PREFIX:**
- Muon xoa toan bo mot "namespace" URL (vd: tat ca products)
- Khong co Surrogate-Key hoac tag khong du tin cay
- Can xoa nhieu URL cung mot prefix

**Canh bao:** BAN-PREFIX co the QUA RONG. Neu ban prefix "/api/" ->
xoa TOAN BO cache. Luon can than voi prefix.

#### 2c: BAN-TAG — Xoa theo Surrogate-Key tag

**Control path call:**
```javascript
banTag(tag)
// -> POST /ops/app/cdn/cache/ban-tag
// -> Body: { tag: "product-1" }
// -> Headers: X-Ops-Token, Authorization
```

**VCL handling:**
```vcl
if (req.method == "BAN") {
    if (req.http.X-Ban-Tag) {
        if (req.http.X-Ban-Tag !~ "^[A-Za-z0-9:_-]+$") {
            return (synth(400, "invalid X-Ban-Tag"));
        }
        ban("obj.http.Surrogate-Key ~ " + req.http.X-Ban-Tag);
        return (synth(200, "ban tag added"));
    }
}
```

**Co che:**
```text
ban("obj.http.Surrogate-Key ~ product-1")

Bieu thuc nay match TAT CA object co Surrogate-Key response header
CHUA tag "product-1":
  - Neu origin tra: Surrogate-Key: product-1 -> MATCH -> xoa
  - Neu origin tra: Surrogate-Key: product-1 category-shoes -> MATCH -> xoa
  - Neu origin tra: Surrogate-Key: product-2 -> KHONG MATCH -> giu
  - Neu origin KHONG set Surrogate-Key -> KHONG MATCH -> giu (day la bug!)
```

**~ la regex match, khong phai string equality:**
```text
"product-1" ~ "product-1"        -> TRUE
"product-1" ~ "product-1 cat-1"  -> TRUE (chua "product-1")
"product-1" ~ "product-10"       -> TRUE (!) — "product-1" nam trong "product-10"
```

Can than voi ten tag: "product-1" se match "product-10".
Tag nen co format ro rang nhu `product:1` hoac `product-00001`.

### So sanh 3 primitive

```text
+------------------+----------------+------------------+------------------+
|                  | PURGE          | BAN-URL          | BAN-TAG          |
+------------------+----------------+------------------+------------------+
| Pham vi          | 1 object       | 1 URL, all       | All objects with |
|                  | (exact cache   | variants         | matching tag     |
|                  | key)           |                  |                  |
+------------------+----------------+------------------+------------------+
| Can variant?     | CO             | KHONG            | KHONG            |
+------------------+----------------+------------------+------------------+
| Can Surrogate-   | KHONG          | KHONG            | CO               |
| Key?             |                |                  |                  |
+------------------+----------------+------------------+------------------+
| Toc do           | Nhanh (xoa     | Nhanh (add to    | Nhanh (add to    |
|                  | ngay lap tuc)  | ban list)        | ban list)        |
+------------------+----------------+------------------+------------------+
| Rui ro           | Purge sai key  | Qua hep (1 URL)  | Tag sai hoac     |
|                  | (khong match)  | neu can nhieu    | thieu -> vo      |
|                  |                | URL              | nghia            |
+------------------+----------------+------------------+------------------+
| Dung khi         | Biet chinh xac | URL bi sai cho   | Thuc the bi thay |
|                  | variant can    | tat ca nguoi     | doi, nhieu URL   |
|                  | xoa            | dung             | cung tag         |
+------------------+----------------+------------------+------------------+
| KHONG dung khi   | Khong biet     | Chi 1 variant    | Khong co Surr-   |
|                  | variant        | bi sai           | Key hoac tag     |
|                  | headers        |                  | sai              |
+------------------+----------------+------------------+------------------+
```

---

## 7. Surrogate-Key model

### Surrogate-Key la gi?

Surrogate-Key la mot HTTP response header duoc **origin** (backend app)
set de gan "tags" cho object duoc cache. Varnish luu Surrogate-Key cung
voi object trong cache (`obj.http.Surrogate-Key`).

```text
Origin response:
  HTTP/1.1 200 OK
  Content-Type: application/json
  Surrogate-Key: product-1 category-shoes homefeed-trending
  Cache-Control: public, s-maxage=90

Varnish cache storage:
  obj = {
    url: "/api/sim/products/1",
    ttl: 90s,
    response: { body: ..., headers: { ..., "Surrogate-Key": "product-1 category-shoes" } }
  }
```

### Cach origin set Surrogate-Key

```text
1. PRODUCT DETAIL (/api/sim/products/{id}):
   Surrogate-Key: product-{id}
   Vi du: product-1, product-42, product-999

2. PRODUCT RECOMMENDATIONS (/api/sim/products/{id}/recommendations):
   Surrogate-Key: product-{id}
   Vi du: product-1 (cung tag voi detail)

3. CATEGORY LIST (/api/sim/products/categories):
   Surrogate-Key: category-{slug}
   Vi du: category-shoes, category-shirts

4. SEARCH RESULTS (/api/sim/products/search?q=...):
   Surrogate-Key: search-{query_hash} product-{id1} product-{id2} ...
   Vi du: search-abc123 product-1 product-5 product-9

5. HOMEFEED (/api/sim/products/homefeed):
   Surrogate-Key: homefeed product-{id1} product-{id2} ...
   Vi du: homefeed product-1 product-3 product-7
```

### Moi quan he giua object va tag

```text
Object A: /api/sim/products/1
  Surrogate-Key: product-1
  -> Tag: "product-1"

Object B: /api/sim/products/1/recommendations
  Surrogate-Key: product-1
  -> Tag: "product-1"

Object C: /api/sim/products/search?q=shoe
  Surrogate-Key: search-shoe product-1 product-5
  -> Tags: "search-shoe", "product-1", "product-5"

Object D: /api/sim/products/homefeed
  Surrogate-Key: homefeed product-1 product-3 product-7
  -> Tags: "homefeed", "product-1", "product-3", "product-7"

KHI BAN-TAG "product-1":
  -> Object A bi xoa (detail)
  -> Object B bi xoa (recommendations)
  -> Object C bi xoa (search — vi search results chua product-1)
  -> Object D bi xoa (homefeed — vi homefeed chua product-1)
  -> TAT CA object lien quan den product-1 deu bi xoa
```

### Tai sao tag-based invalidation la manh nhat

```text
NEU KHONG CO SURROGATE-KEY:
  De xoa product-1, operator phai:
  1. Ban-url /api/sim/products/1
  2. Ban-url /api/sim/products/1/recommendations
  3. Ban-url /api/sim/products/search?q=shoe (doi hoi biet search query)
  4. Ban-url /api/sim/products/search?q=sneaker
  5. Ban-url /api/sim/products/homefeed
  6. ... va tat ca search query khac co chua product-1
  -> KHONG KHA THI!

CO SURROGATE-KEY:
  Chi can: banTag("product-1")
  -> TAT CA object co tag "product-1" bi xoa
  -> Khong can biet URL nao chua product-1
  -> Khong can biet search query nao co product-1
  -> DUNG MOT LENH!
```

### Canh bao ve Surrogate-Key

```text
1. Origin PHAI set Surrogate-Key header.
   Neu origin khong set -> ban-tag VO NGHIA.

2. Tag PHAI duoc dat DUNG.
   Neu product-1 bi set thanh "product-2" -> ban-tag "product-1"
   khong co tac dung.
   Neu tag dat qua rong ("products") -> ban-tag se xoa QUA NHIEU.

3. Tag format PHAI ro rang.
   "product-1" match ca "product-10" (regex ~)
   Nen dung "product:1" hoac "p-00001" de tranh ambiguity.

4. Surrogate-Key validation LA MOT PHAN CUA TEST.
   Case 05 verify ca detail VA recommendations sau ban-tag.
   Neu 1 trong 2 van HIT -> origin khong set dung tag -> bug.
```

---

## 8. Request sequence flow

### Flow 1: PURGE — chi tiet tung buoc

```text
+------+                    +----------+                 +-------+
|  k6  |                    | Varnish  |                 | Nginx |
+------+                    +----------+                 +-------+
   |                             |                           |
   |  WARM PHASE                 |                           |
   |                             |                           |
   |-- GET /api/cached -------->|                           |
   |                             |-- [no cache] ----------->|
   |                             |<-- 200 OK ---------------|
   |                             |-- [store in cache]       |
   |<-- 200, X-Cache: MISS -----|                           |
   |                             |                           |
   |-- GET /api/cached -------->|                           |
   |                             |-- [cache hit!]            |
   |<-- 200, X-Cache: HIT ------|                           |
   |                             |                           |
   |  INVALIDATION PHASE         |                           |
   |                             |                           |
   |-- PURGE /api/cached ------>|                           |
   |   X-Ops-Token: <token>     |                           |
   |                             |-- [auth check OK]         |
   |                             |-- [return(purge)]         |
   |                             |-- [object removed]        |
   |<-- 200 "purged" -----------|                           |
   |                             |                           |
   |  VERIFICATION PHASE         |                           |
   |                             |                           |
   |-- GET /api/cached -------->|                           |
   |                             |-- [cache empty!] ------->|
   |                             |<-- 200 OK ---------------|
   |                             |-- [store in cache]        |
   |<-- 200, X-Cache: MISS -----|                           |
   |                             |                           |
```

### Flow 2: BAN-URL — nhieu variant

```text
+------+                    +----------+
|  k6  |                    | Varnish  |
+------+                    +----------+
   |                             |
   |  WARM: profile guest        |
   |  (vi, VN, mobile, control)  |
   |-- GET /api/sim/products/1 ->|
   |   with variant headers      |
   |<-- 200, X-Cache: MISS -----|
   |-- GET /api/sim/products/1 ->|
   |<-- 200, X-Cache: HIT ------|     <- Da cache variant guest
   |                             |
   |  WARM: profile variantA     |
   |  (vi, VN, mobile, var-a)   |
   |-- GET /api/sim/products/1 ->|
   |   with DIFFERENT headers    |
   |<-- 200, X-Cache: MISS -----|     <- Cache key khac -> MISS
   |-- GET /api/sim/products/1 ->|
   |<-- 200, X-Cache: HIT ------|     <- Da cache variant variantA
   |                             |
   |  INVALIDATION               |
   |-- BAN /ops/.../ban-url --->|
   |   X-Ban-URL: /api/sim/...  |
   |   X-Ops-Token: <token>     |
   |                             |-- [ban("req.url == ...")]
   |<-- 200 "ban url added" ----|
   |                             |
   |  VERIFY: profile guest      |
   |-- GET /api/sim/products/1 ->|
   |   with guest headers        |
   |<-- 200, X-Cache: MISS -----|     <- Da bi xoa!
   |                             |
   |  VERIFY: profile variantA   |
   |-- GET /api/sim/products/1 ->|
   |   with variantA headers     |
   |<-- 200, X-Cache: MISS -----|     <- Cung bi xoa!
   |                             |
   |  => BAN-URL xoa CA 2 variant
```

### Flow 3: BAN-TAG — nhieu endpoint

```text
+------+                    +----------+
|  k6  |                    | Varnish  |
+------+                    +----------+
   |                             |
   |  CLEANUP                    |
   |-- BAN URL product detail -->|
   |-- BAN URL recommendations ->|
   |                             |
   |  WARM: product detail       |
   |-- GET /api/sim/products/1 ->|
   |<-- 200, X-Cache: MISS -----|
   |-- GET /api/sim/products/1 ->|
   |<-- 200, X-Cache: HIT ------|     <- Surrogate-Key: product-1
   |                             |
   |  WARM: recommendations      |
   |-- GET /api/sim/products/1  |
   |    /recommendations ------->|
   |<-- 200, X-Cache: MISS -----|
   |-- GET /api/sim/products/1  |
   |    /recommendations ------->|
   |<-- 200, X-Cache: HIT ------|     <- Surrogate-Key: product-1
   |                             |
   |  INVALIDATION               |
   |-- BAN /ops/.../ban-tag --->|
   |   X-Ban-Tag: product-1     |
   |   X-Ops-Token: <token>     |
   |                             |-- [ban("obj.http.Surrogate-Key ~ product-1")]
   |<-- 200 "ban tag added" ----|
   |                             |
   |  VERIFY: product detail     |
   |-- GET /api/sim/products/1 ->|
   |<-- 200, X-Cache: MISS -----|     <- Da bi xoa!
   |                             |
   |  VERIFY: recommendations    |
   |-- GET .../recommendations ->|
   |<-- 200, X-Cache: MISS -----|     <- Cung bi xoa!
   |                             |
   |  => BAN-TAG xoa CA 2 endpoint
   |     VI cung Surrogate-Key
```

### Tong ket request count

```text
PURGE test:
  - Public requests:  3 (warm x2 + verify x1)
  - Control requests: 1 (purgeUrl)

BAN-URL test:
  - Public requests:  6 (warm x4 + verify x2)
  - Control requests: 1 (banUrl)

BAN-TAG test:
  - Public requests:  6 (warm x4 + verify x2)
  - Control requests: 3 (banUrl x2 cleanup + banTag x1)

setup():
  - Control requests: 3 (purgeUrl x1 + banUrl x2)

TOTAL:
  - Public requests:  15
  - Control requests: 8
  - Total:            23 requests
```

---

## 9. Key signals/headers

### X-Cache — header quan trong nhat

```text
X-Cache: HIT
  -> Object duoc phuc vu tu cache
  -> Day la "trang thai binh thuong" cua CDN
  -> Neu thay HIT sau khi invalidate -> FAIL

X-Cache: MISS
  -> Object KHONG co trong cache, phai fetch tu origin
  -> Sau WARM: MISS la buoc dau cua "MISS->HIT"
  -> Sau INVALIDATE: MISS la minh chung object da bi xoa

X-Cache-Hits: <N>
  -> So lan object da duoc serve tu cache (obj.hits)
  -> Chi co khi X-Cache: HIT
  -> HIT cang cao -> cache cang hieu qua
```

### Control API response status

```text
200 "purged"         -> PURGE thanh cong (Varnish da xoa object)
200 "ban url added"  -> BAN-URL lenh da duoc them vao ban list
200 "ban tag added"  -> BAN-TAG lenh da duoc them vao ban list
200 "ban added"      -> BAN-PREFIX lenh da duoc them vao ban list
401 "unauthorized"   -> Thieu hoac sai OPS_AUTH_TOKEN
403 "forbidden path" -> Path khong duoc phep purge
400 "invalid ..."    -> Sai format X-Ban-URL/X-Ban-Tag/X-Ban-Prefix
```

### Surrogate-Key (tren cached response)

```text
Surrogate-Key: product-1
  -> Response header tu origin, duoc Varnish luu cung object
  -> KHONG phai header tra ve cho client (thuong bi strip)
  -> Dung de ban-tag match
```

### X-Cache-Key-* headers

```text
X-Cache-Key-Language: vi
X-Cache-Key-Geo: VN
X-Cache-Key-Device: mobile
X-Cache-Key-AB: control
X-Cache-Key-Segment: guest
  -> Cho biet variant headers da duoc dung de tinh cache key
  -> Quan trong de debug: PURGE co match dung variant khong?
  -> Neu purge thieu variant -> X-Cache-Key-* cua purge khac
     voi X-Cache-Key-* cua object cache -> khong match
```

### X-Upstream-Service

```text
X-Upstream-Service: products-service
  -> Cho biet backend service nao da xu ly request
  -> Dung de verify request MISS thuc su di qua origin
  -> Neu X-Upstream-Service khong dung -> co the da bi route sai
```

---

## 10. Pass/fail criteria

### PASS conditions

```text
TONG THE:
  - k6 exits 0 (tat ca checks pass)

PURGE:
  [P1] warm /api/cached: first=MISS, second=HIT
  [P2] purgeUrl returns 200
  [P3] after purge: X-Cache: MISS

BAN-URL:
  [P4] warm productDetail guest: first=MISS, second=HIT
  [P5] warm productDetail variantA: first=MISS, second=HIT
  [P6] banUrl returns 200
  [P7] after ban-url guest: X-Cache: MISS
  [P8] after ban-url variantA: X-Cache: MISS
       -> CA 2 variant deu bi xoa

BAN-TAG:
  [P9]  warm productDetail (tag): first=MISS, second=HIT
  [P10] warm recommendations (tag): first=MISS, second=HIT
  [P11] banTag('product-1') returns 200
  [P12] after ban-tag productDetail: X-Cache: MISS
  [P13] after ban-tag recommendations: X-Cache: MISS
        -> CA 2 endpoints deu bi xoa
```

### FAIL conditions

```text
FAIL-1: PURGE returns 200 but next request still HIT
  -> PURGE cache key khong match object cache key
  -> Nguyen nhan: PURGE request khong co variant headers
     (doi voi /api/sim/products/*) hoac URL bi normalize khac
  -> Fix: dam bao PURGE request co variant headers giong request goc
     hoac dung BAN-URL thay vi PURGE

FAIL-2: BAN-URL returns 200 but some variants still HIT
  -> Ban expression ("req.url == ...") match nhung variant headers
     lam cho cache key khac -> Varnish khong the match?
     (Thuc te: ban match request luc request den, khong match object)
  -> Nguyen nhan: co the VCL ban expression khong duoc thuc thi dung
     hoac ban list bi clear
  -> Fix: kiem tra VCL ban handling, restart Varnish neu can

FAIL-3: BAN-TAG returns 200 but detail still HIT
  -> Object khong co Surrogate-Key header
  -> Nguyen nhan: origin khong set Surrogate-Key trong response
  -> Fix: kiem tra origin code, dam bao set Surrogate-Key header

FAIL-4: BAN-TAG returns 200 but recommendations still HIT
  -> Recommendations khong co Surrogate-Key, hoac co tag khac
  -> Nguyen nhan: recommendations endpoint khong set Surrogate-Key
     hoac set sai tag
  -> Fix: dam bao recommendations cung co Surrogate-Key: product-1

FAIL-5: Control returns 401
  -> Thieu hoac sai OPS_AUTH_TOKEN
  -> Fix: set $env:OPS_AUTH_TOKEN dung gia tri

FAIL-6: Control returns 403
  -> Path khong duoc phep purge (VCL white-list)
  -> Fix: kiem tra VCL PURGE handler, them path vao white-list neu can

FAIL-7: Warm first request khong phai MISS
  -> Object da co trong cache tu truoc (khong clean setup)
  -> Fix: dam bao setup() da clear path, hoac chay Varnish restart

FAIL-8: Warm second request khong phai HIT
  -> Object khong duoc cache sau MISS
  -> Nguyen nhan: VCL pass (auth, cookie, no-cache) hoac origin
     tra Set-Cookie / private / no-store
  -> Fix: kiem tra VCL recv logic, xem request co bi pass khong
```

---

## 11. Cach chay + output

### Dieu kien tien quyet

```powershell
# 1. CDN runtime dang chay (TargetLayer=full)
# 2. Tat ca services healthy
# 3. Co OPS_AUTH_TOKEN
```

### Lenh chay

```powershell
cd E:/Projects/k6/k6-metrics-server

$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

./scripts/run-cdn-capabilities.ps1 -Scenarios 05-invalidation-ops
```

### Output thanh cong (PASS)

```text
  execution: local
     script: .../05-invalidation-ops.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration

  data_received..............: ... kB
  data_sent..................: ... kB
  http_req_duration..........: avg=... min=... med=... max=...
  http_reqs..................: 23 (15 public + 8 control)
  iterations.................: 1
  vus........................: 1
  vus_max....................: 1

  ✓ cached first status 200
  ✓ cached first cache state MISS
  ✓ cached second status 200
  ✓ cached second cache state HIT
  ✓ cached after purge status 200
  ✓ cached after purge cache state MISS
  ✓ guest_variant_warm_first status 200
  ✓ guest_variant_warm_first upstream products-service
  ✓ guest_variant_warm_first cache state MISS
  ✓ guest_variant_warm_second status 200
  ✓ guest_variant_warm_second cache state HIT
  ✓ variant_a_warm_first status 200
  ✓ variant_a_warm_first upstream products-service
  ✓ variant_a_warm_first cache state MISS
  ✓ variant_a_warm_second status 200
  ✓ variant_a_warm_second cache state HIT
  ✓ guest after ban-url status 200
  ✓ guest after ban-url cache state MISS
  ✓ variant after ban-url status 200
  ✓ variant after ban-url cache state MISS
  ✓ detail_for_tag_warm_first status 200
  ✓ detail_for_tag_warm_first upstream products-service
  ✓ detail_for_tag_warm_first cache state MISS
  ✓ detail_for_tag_warm_second status 200
  ✓ detail_for_tag_warm_second cache state HIT
  ✓ recs_for_tag_warm_first status 200
  ✓ recs_for_tag_warm_first upstream products-service
  ✓ recs_for_tag_warm_first cache state MISS
  ✓ recs_for_tag_warm_second status 200
  ✓ recs_for_tag_warm_second cache state HIT
  ✓ detail after ban-tag status 200
  ✓ detail after ban-tag cache state MISS
  ✓ recs after ban-tag status 200
  ✓ recs after ban-tag cache state MISS
  ✓ purge /api/cached status 200
  ✓ ban-url /api/sim/products/1 status 200
  ✓ ban-tag product-1 status 200

  checks....................: 100.00% ✓ 36   ✗ 0
```

### Output that bai (FAIL) — vi du

```text
  ✗ cached after purge cache state MISS
    -> Thuc te la HIT -> PURGE khong xoa duoc object

  ✗ guest after ban-url cache state MISS
    -> Thuc te la HIT -> BAN-URL khong xoa duoc variant guest

  ✗ recs after ban-tag cache state MISS
    -> Thuc te la HIT -> recommendations khong co Surrogate-Key
```

### Cach doc output

1. **Kiem tra checks:** Tat ca 36 checks phai pass (100.00%)
2. **Kiem tra warm blocks:** Tat ca warm_first = MISS, warm_second = HIT
   Neu warm da fail -> cac buoc sau khong co y nghia
3. **Kiem tra verify blocks:** Tat ca "after purge/ban-url/ban-tag" = MISS
   Neu bat ky cai nao van HIT -> FAIL
4. **Kiem tra control calls:** Tat ca purge/ban-url/ban-tag = 200
   Neu 401/403 -> kiem tra token hoac config

---

## 12. 4 output -> decision scenarios

### Scenario 1: ALL PASS — He thong invalidation hoat dong dung

```text
TAT CA 36 checks PASS.

Dien giai:
  -> Ca 3 primitive (purge, ban-url, ban-tag) deu hoat dong dung.
  -> PURGE xoa dung exact object.
  -> BAN-URL xoa dung tat ca variant cua URL.
  -> BAN-TAG xoa dung tat ca object cung Surrogate-Key.
  -> VCL logic dung, origin set Surrogate-Key dung.

Hanh dong:
  -> He thong invalidation SAN SANG CHO PRODUCTION.
  -> Operator co the tu tin su dung ca 3 primitive.
  -> Tiep tuc chay case nay trong CI/CD de phong regression.
  -> DAM BAO case nay chay TRUOC MOI LAN DEPLOY VCL thay doi.
```

### Scenario 2: PURGE returns 200 but next request still HIT

```text
✓ purge /api/cached status 200
✗ cached after purge cache state MISS  -> thuc te la HIT

Dien giai:
  -> Control API bao "purged" (200) nhung object van con trong cache.
  -> Day la PATTERN NGUY HIEM NHAT: operator tuong da purge xong,
     nhung thuc te khong. Content sai van duoc serve.

Nguyen nhan kha nang:
  A. PURGE request khong co variant headers -> cache key cua lenh
     purge khac voi cache key cua object duoc cache.
     -> Xay ra khi path co variant (vd: /api/sim/products/*)
        nhung PURGE khong gui kem variant headers.

  B. URL khong match do query params bi normalize khac nhau.
     -> PURGE goi: /api/cached?key=abc
        Object cache: /api/cached (query params da bi strip)
     -> Cache key khac -> purge khong match.

  C. VCL PURGE handler khong goi normalize_cache_variants trong khi
     vcl_hash co su dung variant headers -> key tinh trong purge
     khac voi key tinh trong hash.

Hanh dong:
  -> Kiem tra VCL: PURGE handler co goi normalize_cache_variants khong?
  -> Kiem tra URL normalize: PURGE request URL co giong URL cache khong?
  -> Can nhac dung BAN-URL thay vi PURGE neu khong chac chan ve variant.
  -> THEM TEST: purge voi nhieu variant khac nhau de dam bao.
```

### Scenario 3: BAN-TAG misses related objects — Surrogate-Key khong duoc set

```text
✓ ban-tag product-1 status 200
✓ detail after ban-tag cache state MISS
✗ recs after ban-tag cache state MISS  -> thuc te la HIT

Dien giai:
  -> BAN-TAG chi xoa duoc product detail, khong xoa duoc recommendations.
  -> Recommendations van con cached -> user xem recommendations thay
     content cu (sai).

Nguyen nhan kha nang:
  A. Origin cho recommendations KHONG SET Surrogate-Key header.
     -> Varnish khong co obj.http.Surrogate-Key de match.
     -> Ban tag vo nghia voi endpoint nay.

  B. Origin set Surrogate-Key nhung SAI GIA TRI.
     -> Detail: Surrogate-Key: product-1
        Recommendations: Surrogate-Key: recommendations (sai — dang le
        phai la "product-1" hoac it nhat bao gom "product-1")

  C. Surrogate-Key bi strip boi mot proxy/load balancer nao do
     truoc khi den Varnish.

Hanh dong:
  -> Kiem tra origin code: recommendations endpoint co set
     Surrogate-Key header khong?
  -> Kiem tra gia tri Surrogate-Key: co chua "product-1" khong?
  -> Kiem tra proxy/load balancer config: co strip header nao khong?
  -> Debug: dung Varnish log (varnishlog) de xem obj.http.Surrogate-Key.
  -> Neu khong the fix origin ngay -> tam thoi dung BAN-URL cho
     recommendations rieng.
```

### Scenario 4: BAN-URL too broad — xoa nhieu hon du kien

```text
Tat ca checks PASS (tat ca deu MISS sau ban-url).

Nhung...
  -> Neu ban-url "/api/sim/products/1" thuc te da xoa ca
     /api/sim/products/1 va /api/sim/products/1/recommendations
     (vi recommendations URL cung bat dau bang "/api/sim/products/1")?

  -> HOAC: operator vo tinh ban-url "/api/sim/products" (thieu "/1")
     -> Xoa TOAN BO products cache: detail tat ca products, categories,
        search results, homefeed...

Dien giai:
  -> Ban-url KHONG co hien tuong "xoa recommendations" nhu tren
     (vi BAN-URL dung "==" khong phai prefix match).
  -> NHUNG neu operator goi SAI URL -> hậu qua co the nghiem trong.
  -> Dac biet BAN-PREFIX co the rat rong neu prefix qua ngan.

Hanh dong:
  -> LUON VERIFY URL truoc khi goi ban-url.
  -> Can nhac: nen dung BAN-TAG cho cac truong hop nhieu URL cung
     thuc the — vua an toan vua day du.
  -> Them guard: control API nen validate URL khong qua ngan
     (vd: khong cho phep ban-url "/" hoac "/api").
  -> Alert khi so luong object bi xoa vuot nguong (neu co monitoring).
```

---

## 13. Nghich lý / misconceptions

### Misconception 1: "Purge xong la xong"

```text
SUY NGHI SAI: "Toi goi purge API, no tra 200 -> object da bi xoa."

THUC TE:
  -> 200 chi co nghia: Varnish da chap nhan lenh purge.
  -> KHONG dam bao: object da THUC SU bi xoa khoi cache.
  -> Ly do: cache key cua lenh purge co the KHAC cache key cua object.
  -> Phai VERIFY: request lai public URL -> phai MISS.

HE QUA NEU TIN SAI:
  -> Operator purge, thay 200 -> bao "OK, da fix".
  -> Content sai van duoc serve trong TTL con lai.
  -> User bao loi, operator noi "toi da purge roi" -> mat uy tin.
  -> Debug mat thoi gian vi khong ai ngo "purge 200 nhung khong xoa".
```

### Misconception 2: "BAN-URL xoa tat ca variants" — DUNG, va do la DIEM MANH

```text
SUY NGHI: "Ban-url xoa tat ca variant -> co the xoa qua nhieu."

THUC TE: DUNG — nhung DAY LA TINH NANG, KHONG PHAI BUG.
  -> Khi content sai anh huong den TAT CA nguoi dung -> CAN xoa
     tat ca variant.
  -> Ban-url chinh la cong cu cho tinh huong do.
  -> Neu chi can xoa 1 variant -> dung PURGE.

CHIEN LUOC DUNG:
  -> Xac dinh pham vi anh huong TRUOC khi chon primitive.
  -> Tat ca variant bi loi? -> BAN-URL.
  -> Chi 1 variant bi loi? -> PURGE (voi variant headers dung).
  -> Nhieu URL bi loi (cung thuc the)? -> BAN-TAG (neu co tag).
```

### Misconception 3: "BAN-TAG la an toan nhat"

```text
SUY NGHI SAI: "Ban-tag chi xoa dung nhung object co tag -> khong
 bao gio xoa qua rong."

THUC TE:
  -> BAN-TAG chi an toan NEU SURROGATE-KEY DUOC SET DUNG.
  -> Neu tag dat qua rong (vd: "products" cho TAT CA products) ->
     ban-tag se xoa TOAN BO products cache.
  -> Neu tag bi misspell -> ban-tag khong co tac dung.
  -> Neu origin KHONG set Surrogate-Key -> ban-tag VO NGHIA.

HE QUA:
  -> Operator nghi "minh da ban-tag product-1, xong roi".
  -> Nhung recommendations khong co Surrogate-Key -> van HIT.
  -> Content sai van duoc serve o recommendations.
  -> Den khi user bao moi biet -> da muon.
```

### Misconception 4: "Invalidation can duoc verify bang control API status"

```text
SUY NGHI SAI: "Control API tra 200 la du — khong can verify data plane."

THUC TE:
  -> Control API chi verify "lenh da duoc chap nhan".
  -> KHONG verify "object da bi xoa khoi cache".

UNG HO BANG SO LIEU:
  -> Case 05 verify 3 primitive bang 6 public requests sau invalidation.
  -> Moi public request la mot "end-to-end check".
  -> Chi can 1 trong 6 request la HIT -> FAIL.
  -> Control API 200 nhung verify FAIL -> tim ra BUG THUC SU.

BAI HOC:
  -> LUON verify bang data plane request.
  -> Pattern: warm -> invalidate -> verify MISS.
  -> Day la "gold standard" cua CDN invalidation testing.
```

### Misconception 5: "Cache TTL ngan -> khong can invalidation"

```text
SUY NGHI SAI: "TTL 15s -> content sai ton tai toi da 15s -> chap nhan duoc."

THUC TE:
  -> 15s trong thoi diem flash sale = HANG NGAN request sai.
  -> Neu 1000 req/s -> 15s = 15,000 nguoi nhin thay gia sai.
  -> Mat doanh thu, mat uy tin — khong chap nhan duoc.
  -> Invalidation la BAT BUOC, khong phu thuoc TTL.

BAI HOC:
  -> TTL ngan GIAM thoi gian content sai, nhung khong LOAI BO.
  -> Invalidation la cach DUY NHAT dam bao content moi duoc serve
     NGAY LAP TUC sau khi origin cap nhat.
```

---

## 14. Checklist

### Pre-run checklist

```text
[ ] TargetLayer = full (Varnish + Nginx + app deu running)
[ ] OPS_AUTH_TOKEN duoc set
[ ] CONTROL_BASE_URL = http://localhost:8088
[ ] BASE_URL = http://localhost:80
[ ] Khong co CDN case nao khac dang chay song song
[ ] Varnish health probe bao healthy
[ ] Origin healthy, products-service responding
[ ] Neu chay lai: Varnish cache da duoc reset hoac setup se clear
```

### Runtime checklist — doc output

```text
[ ] k6 exit code = 0
[ ] checks rate = 100% (36/36)
[ ] PURGE warm: MISS -> HIT
[ ] PURGE after: MISS
[ ] BAN-URL warm guest: MISS -> HIT
[ ] BAN-URL warm variantA: MISS -> HIT
[ ] BAN-URL after guest: MISS
[ ] BAN-URL after variantA: MISS
[ ] BAN-TAG warm detail: MISS -> HIT
[ ] BAN-TAG warm recs: MISS -> HIT
[ ] BAN-TAG after detail: MISS
[ ] BAN-TAG after recs: MISS
```

### Post-run checklist

```text
[ ] Neu FAIL: xac dinh primitive nao fail (purge/ban-url/ban-tag)
[ ] Neu FAIL: kiem tra VCL PURGE handler + vcl_purge
[ ] Neu FAIL: kiem tra VCL BAN handler + ban expression
[ ] Neu FAIL: kiem tra origin Surrogate-Key header
[ ] Document findings vao report
[ ] Neu can: rerun sau khi fix
```

---

## 15. 4-5 variations

### Variation 1: PURGE with explicit variant headers

```text
Muc tieu: Kiem tra PURGE co chinh xac variant isolation khong
  (chi xoa variant duoc chi dinh, khong xoa variant khac)

Thiet ke:
  1. Warm /api/sim/products/1 voi guest (control variant)
  2. Warm /api/sim/products/1 voi variantA
  3. PurgeUrl CHI VOI guest headers:
     purgeUrl(paths.productDetail, profiles.guestVNMobileControl)
  4. Verify guest -> MISS (da bi purge)
  5. Verify variantA -> HIT (KHONG bi purge)

Y nghia:
  -> Chung minh PURGE chi xoa DUNG variant duoc chi dinh
  -> Khong anh huong den variant khac
  -> Day la diem MANH cua PURGE: targeted invalidation

Canh bao:
  -> Neu step 5 la MISS -> PURGE da xoa QUÁ NHIỀU -> VCL issue
  -> Co the VCL PURGE handler KHONG goi normalize_cache_variants
     -> purge xoa object KHONG variant -> tat ca variant bi anh huong
```

### Variation 2: BAN-PREFIX (broader than ban-url)

```text
Muc tieu: Kiem tra BAN-PREFIX xoa nhieu URL cung prefix

Thiet ke:
  1. Warm /api/sim/products/1
  2. Warm /api/sim/products/2
  3. Warm /api/sim/products/categories
  4. BanPrefix("/api/sim/products/")
  5. Verify TAT CA 3 endpoints -> MISS
  6. Verify /api/cached -> van HIT (khong nam trong prefix)

Y nghia:
  -> Chung minh ban-prefix xoa TOAN BO URL match prefix
  -> Khong anh huong den path khong match
  -> Huu ich cho: "toan bo products catalogue bi update"

Canh bao:
  -> Ban prefix qua rong (vd: "/api/") -> TOAN BO cache bi xoa
  -> Origin stampede khi tat ca request cung tro lai MISS
  -> Nen co guard: gioi han prefix toi thieu (vd: it nhat 2 segment)
```

### Variation 3: Tag-based invalidation with MULTIPLE tags

```text
Muc tieu: Kiem tra ban-tag voi nhieu tag cung luc (complex invalidation)

Thiet ke:
  1. Warm products/1 (tag: product-1 category-shoes)
  2. Warm products/2 (tag: product-2 category-shoes)
  3. Warm products/categories (tag: category-shoes)
  4. BanTag("category-shoes")
  5. Verify TAT CA 3 endpoints -> MISS
     (vi tat ca deu co "category-shoes" trong Surrogate-Key)
  6. Verify /api/cached -> van HIT

Y nghia:
  -> Chung minh ban-tag hoat dong voi tag "shared"
  -> "category-shoes" xoa TAT CA object lien quan den category shoes
  -> Huu ich cho: "category shoes duoc restructure"

Canh bao:
  -> Mot object co the co nhieu tag trong Surrogate-Key
  -> Ban-tag match NEU BAT KY tag nao match (regex ~)
  -> "category-shoes" ~ "category-shoes product-1" -> TRUE
```

### Variation 4: Invalidation during HIGH TRAFFIC

```text
Muc tieu: Kiem tra invalidation khong gay loi khi traffic cao

Thiet ke:
  1. Chay 10 VUs constant request GET /api/sim/products/1
     (tao traffic nen)
  2. Trong khi traffic dang chay:
     a. Warm object (se co HIT do traffic da cache)
     b. Purge URL
     c. Verify sau purge -> MISS
  3. Kiem tra KHONG CO 5xx errors trong suot qua trinh
  4. Kiem tra MISS dau tien sau purge KHONG BI loi

Y nghia:
  -> Production invalidation thuong xay ra khi traffic van dang chay
  -> Can dam bao invalidation khong gay loi (503, 502)
  -> Varnish xu ly purge/ban dong bo trong request handling
     -> purge khong anh huong den cac request khac

Canh bao:
  -> Sau purge, request tiep theo la MISS -> origin nhan them load
  -> Neu origin yeu -> MISS co the gay timeout -> 503
  -> Day la van de cua ORIGIN, khong phai cua CDN
```

### Variation 5: Smoke test — chi 1 primitive

```text
Muc tieu: Quick smoke test chi voi PURGE

Thiet ke:
  1. options: vus=1, iterations=1
  2. Chi test PURGE: warm /api/cached -> purge -> verify MISS
  3. Bo qua BAN-URL va BAN-TAG

Su dung:
  -> CI pipeline can test nhanh (<5s)
  -> Sau khi VCL thay doi -> test PURGE handler ngay
  -> Neu PURGE fail -> khong can test BAN-URL/BAN-TAG -> fix PURGE truoc

Y nghia:
  -> Smoke test don gian, nhanh
  -> PURGE la primitive CO BAN NHAT -> neu PURGE fail, BAN cung
     co the fail (vi chung VCL handler)
  -> Khong thay the full case, chi la quick check
```

---

## 16. Anti-patterns

### Anti-pattern 1: Purge khong co variant headers (cho path co variant)

```text
SAI:
  purgeUrl("/api/sim/products/1")
  // Khong profile argument -> khong gui variant headers

DUNG:
  purgeUrl("/api/sim/products/1", profiles.guestVNMobileControl)
  // Co profile -> gui dung variant headers

LY DO:
  -> /api/sim/products/* co variant trong cache key
  -> PURGE request can variant headers de tinh DUNG cache key
  -> Thieu variant -> purge MAC DINH variant (en, VN, desktop, control)
  -> Neu object cache co variant KHAC -> PURGE KHONG MATCH -> vo nghia
```

### Anti-pattern 2: Trusting control API status alone

```text
SAI:
  const res = purgeUrl(paths.cached);
  // res.status === 200 -> "OK, xong roi"
  // KHONG verify public request

DUNG:
  purgeUrl(paths.cached);            // control call
  const verify = requestCdn('GET', paths.cached, ...); // public request
  assertCacheState(verify, 'MISS', 'after purge');     // verify

LY DO:
  -> Control 200 = "lenh da duoc chap nhan"
  -> Public MISS = "object da bi xoa THAT"
  -> Hai thu KHONG tuong duong
```

### Anti-pattern 3: BAN-URL for tag-based invalidation (too narrow or too broad)

```text
SAI:
  // Can xoa tat ca object lien quan den product-1
  banUrl("/api/sim/products/1");                 // chi xoa detail
  // Con recommendations, search, homefeed -> van con cache
  // HOAC:
  banPrefix("/api/sim/products/");               // xoa QUA NHIEU
  // Xoa ca products khac, categories, search, homefeed
  // -> Cache empty -> origin stampede

DUNG:
  banTag("product-1");
  // Chi xoa dung object co Surrogate-Key: product-1
  // Neu origin set tag dung -> xoa DU TAT CA object lien quan

LY DO:
  -> BAN-URL chi match URL -> khong biet "nhung URL nao lien quan"
  -> BAN-TAG dung Surrogate-Key -> "nhung object nao co tag product-1"
  -> Tag-based la cach DUY NHAT de invalidation theo thuc the
```

### Anti-pattern 4: Khong verify cross-variant cho ban-url

```text
SAI:
  warmUntilHit(paths.productDetail, guest, 'guest');
  banUrl(paths.productDetail);
  // Chi verify guest sau ban-url
  const after = requestCdn('GET', paths.productDetail, { profile: guest });
  assertCacheState(after, 'MISS', 'after ban-url');
  // Nhung KHONG verify variantA

DUNG:
  warmUntilHit(paths.productDetail, guest, 'guest');
  warmUntilHit(paths.productDetail, variantA, 'variantA');
  banUrl(paths.productDetail);
  // Verify CA 2
  const afterGuest = requestCdn('GET', paths.productDetail, { profile: guest });
  assertCacheState(afterGuest, 'MISS', 'after ban-url guest');
  const afterVarA = requestCdn('GET', paths.productDetail, { profile: variantA });
  assertCacheState(afterVarA, 'MISS', 'after ban-url variantA');

LY DO:
  -> BAN-URL claim: "xoa TAT CA variant cua URL"
  -> Neu chi verify 1 variant -> khong chung minh duoc claim
  -> Verify 2+ variant -> chung minh claim DUNG
```

### Anti-pattern 5: Khong verify cross-endpoint cho ban-tag

```text
SAI:
  warmUntilHit(paths.productDetail, guest, 'detail');
  banTag('product-1');
  // Chi verify productDetail
  const after = requestCdn('GET', paths.productDetail, { profile: guest });
  assertCacheState(after, 'MISS', 'after ban-tag');
  // Nhung KHONG verify recommendations

DUNG:
  warmUntilHit(paths.productDetail, guest, 'detail');
  warmUntilHit(paths.recommendations, guest, 'recs');
  banTag('product-1');
  // Verify CA 2
  const afterDetail = requestCdn(...);
  assertCacheState(afterDetail, 'MISS', 'after ban-tag detail');
  const afterRecs = requestCdn(...);
  assertCacheState(afterRecs, 'MISS', 'after ban-tag recs');

LY DO:
  -> BAN-TAG claim: "xoa TAT CA object co Surrogate-Key match"
  -> Neu chi verify 1 endpoint -> khong chung minh "tat ca object"
  -> Verify nhieu endpoint -> chung minh Surrogate-Key duoc set
     DONG BO tren tat ca endpoint
```

---

## 17. Real validation data

### Expected validation results (PASS)

```text
Case ID: cdn-05-invalidation-ops
Script: 05-invalidation-ops.js (97 lines)
Test date: (dien ngay chay thuc te)

PURGE primitive:
  warm /api/cached:              [MISS -> HIT] PASS
  purge control API:             [200] PASS
  verify after purge:            [MISS] PASS

BAN-URL primitive:
  warm detail (guest):           [MISS -> HIT] PASS
  warm detail (variantA):        [MISS -> HIT] PASS
  ban-url control API:           [200] PASS
  verify after ban-url (guest):  [MISS] PASS
  verify after ban-url (varA):   [MISS] PASS

BAN-TAG primitive:
  warm detail (tag):             [MISS -> HIT] PASS
  warm recommendations (tag):    [MISS -> HIT] PASS
  ban-tag control API:           [200] PASS
  verify after ban-tag (detail): [MISS] PASS
  verify after ban-tag (recs):   [MISS] PASS

Overall: 36/36 checks PASS
k6 exit code: 0

Key observations:
  - PURGE co che exact-key match hoat dong dung
  - BAN-URL cross-variant invalidation hoat dong dung
  - BAN-TAG cross-endpoint invalidation hoat dong dung
  - Origin set Surrogate-Key header dung cho ca detail va recommendations
  - Control API luon tra 200 truoc khi verify (khong co false negative)
```

### Expected validation data for FAIL scenarios

```text
FAIL MODE 1: PURGE key mismatch
  warm /api/cached:              [MISS -> HIT] PASS
  purge control API:             [200] PASS
  verify after purge:            [HIT] FAIL <-- van con trong cache!
  Root cause: PURGE request URL khong match cache key

FAIL MODE 2: BAN-TAG missing Surrogate-Key
  warm detail (tag):             [MISS -> HIT] PASS
  warm recommendations (tag):    [MISS -> HIT] PASS
  ban-tag control API:           [200] PASS
  verify after ban-tag (detail): [MISS] PASS
  verify after ban-tag (recs):   [HIT] FAIL <-- recs van con!
  Root cause: recommendations endpoint khong set Surrogate-Key

FAIL MODE 3: Control unauthorized
  purge control API:             [401] FAIL
  Root cause: OPS_AUTH_TOKEN khong duoc set hoac sai
```

---

## 18. Reference

- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/05-invalidation-ops.js`
- Shared helpers: `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js`
- VCL invalidation logic: `E:/Projects/k6/k6-metrics-server/load-target/varnish/default.vcl`
  - PURGE handler: lines 78-89 (`vcl_recv`), line 260-262 (`vcl_purge`)
  - BAN handler: lines 92-118 (`vcl_recv`)
  - BAN-URL: `ban("req.url == " + req.http.X-Ban-URL)` at line 100
  - BAN-TAG: `ban("obj.http.Surrogate-Key ~ " + req.http.X-Ban-Tag)` at line 107
  - BAN-PREFIX: `ban("req.url ~ ^" + req.http.X-Ban-Prefix)` at line 116
  - Cache key normalization: lines 21-72 (`normalize_cache_variants`)
  - Cache key construction: lines 167-188 (`vcl_hash`)
- Series overview: `./00_overview.md`
- Gold standard format: `../ramping-arrival-rate/01_daily-ingress-curve.md`
- Run guide: `./RUN_GUIDE.md`
- Varnish documentation: https://varnish-cache.org/docs/
- Surrogate-Key specification: https://www.fastly.com/documentation/guides/concepts/edge-state/cache/surrogate-keys
