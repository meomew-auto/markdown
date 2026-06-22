# Case 07: Cache response contract

> **Case ID:** `cdn-07-cache-contract`
> **Script:** `07-cache-contract.js`
> **Layer:** CDN / Varnish
> **Proof:** cache contract headers and 304 revalidation
> **Headers verified:** Cache-Control, CDN-Cache-Control, ETag, Vary, Surrogate-Key, Last-Modified
> **Paths:** `/api/sim/products/1` (dynamic cacheable), `/api/sim/products/homefeed`, `/api/sim/products/categories`

---

## 1. Tinh huong thuc te

### Response headers la HOP DONG giua origin va CDN

Moi response cacheable ma origin tra ve khong chi chua body (JSON, HTML, binary) --
no con chua mot **HOP DONG** (contract) nam trong cac response header. Hop dong nay
la loi hua tu origin den CDN (Varnish), noi rang:

```text
Origin noi voi CDN:
  "Day la object nay. Em duoc phep cache no trong N giay.
   De biet khi nao het han, em nhin vao header Cache-Control cua anh.
   Muon xac nhan object con dung khong, em dung ETag nay de hoi lai anh.
   Object nay thay doi theo ngon ngu (Accept-Language) va quoc gia (X-Geo-Country)
   -- em phai cache rieng cho tung combination.
   Khi anh bao em xoa object, em dung Surrogate-Key nay de tim."
```

Neu **BAT KY** header nao trong hop dong nay bi thieu hoac sai, CDN se:
- **Cache qua hung hang** (qua aggressive): serve stale data cho user, user thay
  sai san pham, sai gia, sai ngon ngu.
- **Hoac khong cache gi ca**: moi request deu phai ve origin, origin qua tai,
  CDN thanh "ong dan trong suot" vo dung.

### Nhung header nao lap thanh hop dong?

```text
BOX: 6 HEADER THANH PHAN CUA CACHE CONTRACT
==============================================================
 (1) Cache-Control        -- Thoi gian tuoi (freshness) cua object
                              trong shared cache (CDN) va browser.
                              Chua cac directive: public, s-maxage,
                              stale-while-revalidate, stale-if-error.

 (2) CDN-Cache-Control    -- TTL danh rieng cho CDN (Varnish).
                              Co the override Cache-Control neu
                              origin muon browser cache khac CDN.

 (3) ETag                 -- "Dau van tay" cua object. La mot
                              opaque string (hash) ma origin tao ra
                              tu noi dung. Dung de revalidation.

 (4) Vary                 -- Khai bao nhung request header nao
                              lam thay doi response. CDN dung no
                              de tao cache key variant.

 (5) Surrogate-Key        -- Tag de invalidate theo nhom.
                              Varnish dung no de ban-tag (xoa
                              tat ca object co cung tag).

 (6) Last-Modified        -- Timestamp lan cuoi object thay doi.
                              Validator thay the cho ETag.
==============================================================
```

### Vi sao goi la "contract"?

```text
"Contract" khong phai la ten goi hoa my. No la mot khai niem chinh xac:

  - Origin CAM KET (qua header): object nay tuoi trong X giay, ETag
    la Y, variant key la Z, tag la T.

  - CDN THUC THI (dua vao header): cache object X giay, khi het
    han dung ETag revalidate, isolate variant, invalidate theo tag.

  - Neu origin cam ket sai: CDN van cache -- nhung sai data.
    -> user thay sai, app logic bi pha vo.

  - Neu origin khong cam ket: CDN khong cache -- origin thoi.
    -> every request hit origin, khong co offload.

  - Neu origin cam ket dung nhung CDN khong ton trong:
    -> cache leak, variant cross-talk, stale data.

=> Validating cache contract la VALIDATING FOUNDATION cua CDN behavior.
   Day la buoc dau tien truoc khi validate bat ky CDN case nao khac:
   HIT/MISS, TTL expiry, stale serving, invalidation, coalescing.
```

### Tai sao contract headers de bi thieu hoac sai?

Trong thuc te, cac he thong backend thuong mac phai nhung sai song sau:

```text
Loi 1: Thieu Cache-Control tren response cacheable
  -> CDN mac dinh khong cache (hoac cache theo default TTL qua ngan)
  -> Origin nhan 100% traffic, CDN la "ong dan"

Loi 2: Cache-Control co private
  -> `Cache-Control: private, max-age=60`
  -> CDN khong cache (private = chi browser duoc cache)
  -> Moi request deu MISS -> origin overload

Loi 3: Thieu ETag
  -> Khong co co che revalidation
  -> Khi object het han, CDN phai fetch lai TOAN BO body tu origin
  -> Ton bang thong, tang latency

Loi 4: ETag khong on dinh
  -> ETag thay doi theo server timestamp thay vi content hash
  -> Cung noi dung, 2 instance tra 2 ETag khac nhau
  -> Revalidation luon that bai -> 200 thay vi 304

Loi 5: Thieu Surrogate-Key
  -> Khong the invalidate theo nhom (vd: xoa tat ca product category)
  -> Phai purge tung URL mot -> cham, ton tai nguyen

Loi 6: Vary thieu header quan trong
  -> User VN va user US dung chung cache object
  -> User VN thay gia VND, user US cung thay gia VND
  -> Cache leakage

Loi 7: Vary khai bao sai header
  -> Vary: User-Agent -> moi browser co cache object rieng
  -> Hit ratio giam tham hai vi phan manh cache
```

### Hien truong thuc te

```text
Tinh huong: 17:55 chieu thu 6 -- khach san sang mua sim cuoi tuan

  User A (VN, mobile, tieng Viet) mo app -> GET /api/sim/products/1
    Origin tra ve: status=200, body san pham, Cache-Control: public, s-maxage=60
    CDN cache: MISS -> HIT

  User B (US, desktop, tieng Anh) mo app -> GET /api/sim/products/1
    Neu Vary dung: CDN MISS (variant khac) -> fetch tu origin tieng Anh
    Neu Vary sai: CDN HIT -> serve object tieng Viet cho nguoi My
    -> User B thay "Ao so mi" thay vi "T-shirt"
    -> Khong mua hang -> lost revenue

  Admin cap nhat gia san pham -> POST /admin/products/1
    Neu Surrogate-Key co: ban-tag product-1 -> CDN xoa tat ca variant
    Neu Surrogate-Key khong co: purge tung URL variant mot
    -> mat 5-10 giay de purge het -> trong thoi gian do, user thay gia CU
    -> mua hang gia SAI -> operational nightmare

  Sau 60 giay: object het han (expired)
    Neu co ETag: CDN gui If-None-Match den origin
      Origin tra 304 (khong body) -> CDN cap nhat TTL, serve cached body
      -> BANG THONG TIET KIEM: chi ton ~200 byte headers thay vi 4KB body
    Neu khong co ETag: CDN phai fetch lai full body tu origin
      -> 4KB * 1000 requests = 4MB bang thong bi lang phi
```

### Cau hoi kinh doanh

```text
"Cache contract headers co day du va chinh xac de CDN co the:
   - Cache dung freshness window
   - Revalidate tiet kiem bang thong
   - Isolate variant dung cach
   - Invalidate theo tag nhanh chong
 khong?"
```

Day khong phai la "API co tra 200 khong". Day la cau hoi **contract**: origin
da dua ra mot tap hop loi hua qua header; CDN co du thong tin de thuc hien
dung cong viec cua no khong?

---

## 2. CDN capability duoc chung minh

Case nay chung minh **5 capabilities** cua CDN layer lien quan den cache contract:

### (a) Cache-Control va CDN-Cache-Control hien dien va dung

```text
Origin phai emit Cache-Control voi it nhat:
  - public: cho phep shared cache (CDN, proxy)
  - s-maxage=N: TTL cho shared cache
  - stale-while-revalidate=N: thoi gian serve stale trong khi revalidate
  - stale-if-error=N: thoi gian serve stale khi origin loi

CDN-Cache-Control la CDN-specific override:
  - max-age=N: TTL danh rieng cho CDN
  - stale-while-revalidate, stale-if-error tuong tu

Neu CDN-Cache-Control co mat, Varnish su dung no (ghi de Cache-Control).
Neu khong co, Varnish fallback ve Cache-Control.
```

### (b) ETag hien dien tren response cacheable

```text
ETag la "dau van tay" cua object. Origin tao ETag tu noi dung (hash),
khong phai tu timestamp server. ETag phai:
  - Co mat tren moi response cacheable
  - On dinh: cung noi dung -> cung ETag (ngay ca qua nhieu instance)
  - Unique: noi dung khac -> ETag khac
```

### (c) Vary header khai bao dung variant dimensions

```text
Vary khai bao nhung request header nao lam thay doi response.
CDN dung Vary de bien nhung header do thanh mot phan cua cache key.

Vi du: Vary: Accept-Language, X-Geo-Country
  -> CDN cache rieng cho VN+VI, VN+EN, US+EN, US+VI, ...
  -> Khong bi leakage giua cac variant
```

### (d) Surrogate-Key hien dien de invalidation theo nhom

```text
Surrogate-Key chua space-separated tags. Varnish dung tags nay de:
  - ban-tag: xoa tat ca object co cung tag
  - Invaildate theo nghiep vu: "xoa tat ca product-1" thay vi
    phai liet ke tung URL variant (product-1?lang=vi&geo=VN, ...)
```

### (e) 304 Not Modified hoat dong khi ETag khop

```text
Khi CDN co object da het han (expired) nhung con ETag:
  1. CDN gui If-None-Match: <etag> den origin
  2. Origin so sanh ETag:
     - Neu khop: tra 304 Not Modified (KHONG body)
     - Neu khong khop: tra 200 OK (co body moi + ETag moi)
  3. CDN cap nhat TTL, serve cached body cho client

Day la CHE DO TIET KIEM BANG THONG:
  - Origin chi tra headers (~200 bytes) thay vi full body (~4KB)
  - He so: 20x tiet kiem bang thong giua origin va CDN
```

---

## 3. Vi sao test o CDN layer

### Headers nay duoc SET boi origin nhung CONSUMED boi CDN

```text
DAY LA DIEM MAU CHOT:

  +------------------+     Cache-Control, ETag,     +------------------+
  |    ORIGIN (app)  | --- Vary, Surrogate-Key ---> |   CDN (Varnish)  |
  |  SET headers     |                              |  CONSUME headers |
  +------------------+                              +------------------+
         |                                                   |
         |                                                   |
    Test o app layer:                                  Test o CDN layer:
    "headers co duoc emit?"                            "headers co duoc Varnish
    CHI verify emission                                SU DUNG DUNG CACH?"
```

### Test o app layer thi duoc gi?

```text
Neu chi test thong qua Nginx (khong qua Varnish):
  -> Xac nhan duoc origin co emit headers
  -> Nhung KHONG biet Varnish co hieu va su dung headers do khong
  
  Vi du: Origin emit Cache-Control: public, s-maxage=60
         Nhung Varnish config sai -> van MISS moi request
         -> Test app layer PASS (headers co) nhung CDN behavior FAIL
```

### Test o CDN layer thi duoc gi?

```text
Test qua Varnish (:80) xac nhan DUOC:
  1. Headers ton tai tren response client nhan duoc
     (Varnish co the strip, modify, hoac khong forward headers)
  2. 304 revalidation hoat dong: CDN gui If-None-Match, origin tra 304,
     CDN forward 304 cho client (hoac 200 voi cached body)
  3. Cache behavior dung: sau request dau, request thu 2 la HIT
     (chung to CDN da su dung Cache-Control de cache)
  4. Vary isolation: request voi header variant khac -> MISS
     (chung to CDN da su dung Vary de isolate)
  5. Invalidation hoat dong: ban-tag dan den MISS tiep theo
     (chung to CDN da su dung Surrogate-Key de tim object)
```

### 304 revalidation flow -- tai sao PHAI test o CDN layer?

```text
304 revalidation la flow MA CHI CDN LAYER MOI CO THE KIEM TRA DUOC:

  Client -> CDN -> Origin
     |        |        |
     |  1. Object trong cache nhung da het han (expired)
     |        |
     |  2. CDN gui request den origin voi:
     |     If-None-Match: "abc123"  (ETag cua object cu)
     |        |        |
     |        |  3. Origin so sanh ETag:
     |        |     -> Khop: tra 304 Not Modified (KHONG body)
     |        |     -> Khong khop: tra 200 OK (body moi)
     |        |
     |  4. CDN nhan 304 -> cap nhat TTL, dung lai cached body
     |
     |  5. Client nhan 200 OK (body tu CDN cache)
     |
     => TOAN BO flow nay DIEN RA GIUA CDN VA ORIGIN
        Client test truc tiep origin KHONG BAO GIO thay 304
```

### Hanh vi Varnish cu the voi tung header

```text
Cache-Control: public, s-maxage=60, stale-while-revalidate=30, stale-if-error=120
  -> Varnish: cache object, TTL=60s. Sau 60s object expired.
     Trong 30s tiep theo: serve stale + async revalidate.
     Neu origin loi trong 120s sau TTL: serve stale.

CDN-Cache-Control: max-age=120, stale-while-revalidate=60
  -> Varnish: ghi de Cache-Control, TTL=120s.
     Dung khi origin muon CDN cache lau hon browser.

ETag: "abc123"
  -> Varnish: luu ETag cung voi object.
     Khi revalidate: gui If-None-Match: "abc123"
     Khi nhan 304: keep current body, update TTL

Vary: Accept-Language, X-Geo-Country
  -> Varnish: hash(Vary headers) -> variant key.
     Cache key = hash(path) + hash(variant dimensions)

Surrogate-Key: product-1 catalog-homefeed
  -> Varnish: register object vao 2 tag groups.
     Khi ban-tag "product-1": xoa tat ca object co tag nay
```

---

## 4. Topology & precondition

### Runtime topology

```text
                    PUBLIC PATH (edge)
                    ==================
  k6  ----HTTP-->  :80 (Varnish CDN)  -->  :8080 (Nginx)  -->  app
                    |                                      |
                    |  Cache-Control, CDN-Cache-Control    |
                    |  ETag, Last-Modified                  |
                    |  Vary, Surrogate-Key                  |
                    |                                      |
                    +-- cache object, revalidate, isolate --+


                   CONTROL PATH (direct)
                   =====================
  k6  ----HTTP-->  :8088  -->  app (ops endpoints)


                   EVENT PATH (catalog events mock)
                   ================================
  k6  ----HTTP-->  :9091  -->  catalog-events mock
```

### Path cho case nay

```text
PUBLIC PATH (dung de validate cache contract):
  http://localhost:80/api/sim/products/1        -- product detail (primary)
  http://localhost:80/api/sim/products/homefeed -- homefeed
  http://localhost:80/api/sim/products/categories -- categories

CONTROL PATH (dung de reset cache state neu can):
  http://localhost:8088/ops/app/cdn/cache/purge
  http://localhost:8088/ops/app/cdn/cache/ban-tag

EVENT PATH: khong su dung trong case nay
```

### Precondition

```text
1. TargetLayer = full (CDN + Nginx + app)
2. Public requests PHAI di qua Varnish (khong duoc di thang Nginx)
3. OPS_AUTH_TOKEN phai duoc set (cho control path purge/ban neu can)
4. Origin health: tat ca upstream services phai healthy
5. Khong co cache warming truoc -- test tu tao MISS va 304
```

### Tai sao precondition quan trong?

```text
Neu public request di thang Nginx (khong qua Varnish):
  -> Khong co X-Cache header
  -> Khong co CDN behavior (HIT/MISS/304 revalidation)
  -> Test PASS nhung khong validate duoc gi

Neu origin khong healthy:
  -> Cache-Control headers van co the emit
  -> Nhung 304 revalidation co the fail vi origin khong xu ly duoc
  -> False negative
```

---

## 5. Script deep-dive

### Tong quan script

Script `07-cache-contract.js` la execution don (1 VU, 1 iteration) thuc hien
3 nhom kiem tra:

```text
PHASE 1: PRODUCT DETAIL CONTRACT (headers co ban)
  -> GET /api/sim/products/1 voi guest VN mobile profile
  -> Check: Cache-Control, CDN-Cache-Control, ETag,
            Last-Modified, Surrogate-Key, Vary

PHASE 2: 304 REVALIDATION
  -> Lay ETag tu response dau
  -> GET lai voi If-None-Match + Cache-Control: no-cache
  -> Expect: 304 Not Modified

PHASE 3: HOMEFEED + CATEGORIES CONTRACT
  -> GET /api/sim/products/homefeed: check Surrogate-Key tags
  -> GET /api/sim/products/categories: check Vary dimensions
```

### Import va config

```javascript
import {
  decodeJSON, getHeader, paths, profiles,
  requestCdn, assertHeaderContains,
  assertHeaderPresent, assertStatus
} from './shared.js';

export const options = {
  vus: 1,           // 1 VU duy nhat
  iterations: 1,    // chay 1 lan
  thresholds: {
    checks: ['rate==1'],  // 100% checks phai pass
  },
  tags: {
    scenario: 'cdn_cache_contract',
  },
};
```

**Giai thich config**:
- `vus: 1, iterations: 1`: Day la functional validation, khong phai load test.
  Chi can 1 lan goi de xac nhan contract.
- `checks: ['rate==1']`: Threshold cung -- moi check deu phai pass.
  Chi 1 check fail la test FAIL.

### PHASE 1: Product detail contract

```javascript
const detail = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'detail_contract' },
});

// 1. Status code
assertStatus(detail, 200, 'detail contract');

// 2. Cache-Control: phai co mat + chua cac directive bat buoc
assertHeaderPresent(detail, 'Cache-Control', 'detail contract');
assertHeaderContains(detail, 'Cache-Control', 'public', 'detail contract');
assertHeaderContains(detail, 'Cache-Control', 's-maxage=', 'detail contract');
assertHeaderContains(detail, 'Cache-Control', 'stale-while-revalidate=', 'detail contract');
assertHeaderContains(detail, 'Cache-Control', 'stale-if-error=', 'detail contract');

// 3. CDN-Cache-Control: phai co mat + chua cac directive bat buoc
assertHeaderPresent(detail, 'CDN-Cache-Control', 'detail contract');
assertHeaderContains(detail, 'CDN-Cache-Control', 'max-age=', 'detail contract');
assertHeaderContains(detail, 'CDN-Cache-Control', 'stale-while-revalidate=', 'detail contract');
assertHeaderContains(detail, 'CDN-Cache-Control', 'stale-if-error=', 'detail contract');

// 4. Validator headers
assertHeaderPresent(detail, 'ETag', 'detail contract');
assertHeaderPresent(detail, 'Last-Modified', 'detail contract');

// 5. Invalidation header
assertHeaderPresent(detail, 'Surrogate-Key', 'detail contract');
assertHeaderContains(detail, 'Surrogate-Key', 'product-1', 'detail contract');

// 6. Variant header
assertHeaderPresent(detail, 'Vary', 'detail contract');
```

**Phan tich tung assertion**:

```text
Cache-Control: public, s-maxage=...
  - `public`: Bat buoc. Khong co -> CDN khong cache.
  - `s-maxage=N`: Bat buoc. Khong co -> CDN khong biet cache bao lau.
  - `stale-while-revalidate=N`: Bat buoc. Khong co -> khong co grace period.
  - `stale-if-error=N`: Bat buoc. Khong co -> origin loi -> CDN serve 503.

CDN-Cache-Control: max-age=...
  - `max-age=N`: Bat buoc. TTL rieng cho CDN.
  - `stale-while-revalidate=N`: Bat buoc.
  - `stale-if-error=N`: Bat buoc.

ETag: W/"abc123" hoac "abc123"
  - Bat buoc. Khong co -> khong the revalidate.

Last-Modified: Wed, 21 Oct 2015 07:28:00 GMT
  - Bat buoc. Validator du phong.

Surrogate-Key: ... product-1 ...
  - Bat buoc. Khong co -> khong the ban-tag.
  - Phai chua it nhat product-{id}.

Vary: ...
  - Bat buoc. Khong co -> khong co variant isolation.
```

### PHASE 2: 304 Revalidation

```javascript
const detailETag = getHeader(detail, 'ETag');
if (!detailETag) {
  throw new Error('detail contract missing ETag');
}

const revalidated = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  headers: {
    'Cache-Control': 'no-cache',
    'If-None-Match': detailETag,
  },
  tags: { case: 'detail_revalidate' },
});
assertStatus(revalidated, 304, 'detail revalidation');
```

**Phan tich**:

```text
1. Lay ETag tu response dau tien: detailETag = getHeader(detail, 'ETag')
   Neu khong co ETag: throw ngay lap tuc -> test FAIL

2. Gui request thu 2 voi:
   - Cache-Control: no-cache
     -> Bao CDN: "dung serve object tu cache, phai revalidate voi origin"
   - If-None-Match: <etag>
     -> Bao origin: "toi co object voi ETag nay, neu con dung thi tra 304"

3. Expect: status 304 Not Modified
   - Origin xac nhan: object khong thay doi
   - CDN cap nhat TTL cua cached object
   - Client nhan 304 (khong body, khong ton bang thong)

4. Neu origin tra 200 (thay vi 304):
   -> ETag da thay doi (noi dung moi) HOAC revalidation khong duoc ho tro
   -> Test FAIL: "304 revalidation khong hoat dong"
```

### PHASE 3: Homefeed + Categories contract

```javascript
// HOMEFEED
const homefeed = requestCdn('GET', paths.homefeed, {
  profile: profiles.returningVNMobileVariantA,
  tags: { case: 'homefeed_contract' },
});
assertStatus(homefeed, 200, 'homefeed contract');
assertHeaderContains(homefeed, 'Surrogate-Key', 'catalog-homefeed', 'homefeed contract');
assertHeaderContains(homefeed, 'Surrogate-Key', 'segment-returning', 'homefeed contract');

// CATEGORIES
const categories = requestCdn('GET', paths.categories, {
  profile: profiles.guestUSDesktopControl,
  tags: { case: 'categories_contract' },
});
assertStatus(categories, 200, 'categories contract');
assertHeaderContains(categories, 'Vary', 'Accept-Language', 'categories contract');
assertHeaderContains(categories, 'Vary', 'X-Geo-Country', 'categories contract');

const categoriesBody = decodeJSON(categories, 'categories contract');
if (!categoriesBody.success) {
  throw new Error('categories contract request returned unsuccessful body');
}
```

**Phan tich**:

```text
HOMEFEED:
  - Surrogate-Key phai chua `catalog-homefeed`: tag de invalidation
    khi catalog thay doi.
  - Surrogate-Key phai chua `segment-{segment}`: tag de invalidation
    theo user segment (returning, new_user, guest).
  -> 1 ban-tag "catalog-homefeed" xoa toan bo homefeed cache.
  -> 1 ban-tag "segment-returning" xoa homefeed cho returning users.

CATEGORIES:
  - Vary phai chua `Accept-Language`: vi categories list khac nhau
    theo ngon ngu (ten danh muc tieng Viet vs tieng Anh).
  - Vary phai chua `X-Geo-Country`: vi categories khac nhau theo
    quoc gia (san pham available o VN vs US).
  - Response body phai co success=true.
```

---

## 6. Cache contract headers deep-dive

Day la phan **QUAN TRONG NHAT** cua case nay. Moi header la mot dieu khoan
trong hop dong giua origin va CDN. Hieu SAI mot header -> trien khai SAI
toan bo cache strategy.

### 6.1 Cache-Control

```text
BOX: Cache-Control
================================================================
Muc dich:        Khai bao policy cache cho browser VA shared cache
                 (CDN, proxy).
Vi tri:          Response header (origin -> CDN -> client)
Cu phap:         Cache-Control: <directive>, <directive>, ...
Ai set:          Origin (app)
Ai consume:      Browser, CDN (Varnish), intermediate proxies
================================================================
```

**Cac directive quan trong cho CDN**:

```text
+------------------+--------------------------------------------------+
| Directive        | Y nghia doi voi CDN                              |
+------------------+--------------------------------------------------+
| public           | Cho phep SHARED CACHE (CDN, proxy).               |
|                  | Khong co -> CDN khong duoc cache.                 |
|                  | Day la directive SO 1 quyet dinh CDN co cache     |
|                  | hay khong.                                        |
+------------------+--------------------------------------------------+
| private          | CHI browser duoc cache. CDN PHAI bypass.          |
|                  | Dung cho response theo user cu the (auth).        |
|                  | NGUY HIEM: neu de private tren response public    |
|                  | -> CDN khong cache -> origin overload.            |
+------------------+--------------------------------------------------+
| s-maxage=N       | TTL cho SHARED CACHE (CDN).                        |
|                  | Ghi de max-age cho CDN.                            |
|                  | VD: s-maxage=60 -> CDN cache 60 giay.              |
|                  | Neu khong co s-maxage: CDN fallback max-age.      |
+------------------+--------------------------------------------------+
| max-age=N        | TTL cho BROWSER (private cache).                   |
|                  | CDN su dung s-maxage (neu co), khong thi max-age.  |
+------------------+--------------------------------------------------+
| stale-while-     | Thoi gian CDN duoc serve STALE trong khi           |
| revalidate=N     | REVALIDATE ASYNC voi origin.                       |
|                  | VD: s-maxage=60, stale-while-revalidate=30        |
|                  | -> Tu giay 61 den 90: serve cached + async fetch   |
+------------------+--------------------------------------------------+
| stale-if-error=N | Thoi gian CDN duoc serve STALE khi origin LOI.     |
|                  | VD: stale-if-error=120                            |
|                  | -> Tu giay 61 den 180: neu origin error, serve     |
|                  |    stale thay vi 503.                              |
|                  | DAY LA TINH NANG PHONG THU QUAN TRONG.            |
+------------------+--------------------------------------------------+
| no-cache         | Client muon REVALIDATE TRUOC KHI DUNG.             |
|                  | CDN phai gui conditional request den origin.       |
|                  | Day la "revalidate always", KHONG PHAI "khong      |
|                  | cache". Object van duoc cache, nhung moi lan       |
|                  | serve deu phai hoi origin.                         |
+------------------+--------------------------------------------------+
| no-store         | KHONG DUOC CACHE (ca browser lan CDN).             |
|                  | Response bi xoa ngay sau khi gui.                  |
+------------------+--------------------------------------------------+
| must-revalidate  | Khi object het han, CDN PHAI revalidate.           |
|                  | Khong duoc serve stale (tru khi stale-if-error).   |
+------------------+--------------------------------------------------+
```

**Cach Varnish xu ly Cache-Control**:

```text
1. Varnish parse Cache-Control header.
2. Xac dinh TTL:
   - Neu co s-maxage -> TTL = s-maxage
   - Neu co max-age (khong s-maxage) -> TTL = max-age
   - Neu khong co ca hai -> TTL = default_ttl (VCL)
3. Xac dinh co duoc cache khong:
   - Neu co private -> KHONG CACHE
   - Neu co no-store -> KHONG CACHE
   - Neu co public -> DUOC CACHE
   - Neu khong co ca private lan public -> depend on VCL default
4. Xac dinh stale policy:
   - stale-while-revalidate -> grace period (keep trong khi fetch)
   - stale-if-error -> keep khi backend unhealthy

Trong VCL code:
  set beresp.ttl = <s-maxage hoac max-age>;
  set beresp.grace = <stale-if-error>;
  set beresp.keep = <stale-while-revalidate>;
```

### 6.2 CDN-Cache-Control

```text
BOX: CDN-Cache-Control
================================================================
Muc dich:        Override Cache-Control DANH RIENG cho CDN.
                 Origin muon browser cache ngat, CDN cache lau?
                 -> CDN-Cache-Control.
Vi tri:          Response header (origin -> CDN -> client)
                 Co the bi CDN strip (khong forward cho client).
Cu phap:         CDN-Cache-Control: <directive>, ...
Ai set:          Origin (app)
Ai consume:      CDN (Varnish) -- uu tien hon Cache-Control
================================================================
```

**Tai sao can CDN-Cache-Control rieng?**

```text
Tinh huong: Origin muon:
  - Browser cache 5s (max-age=5) de phan hoi nhanh cho user repeat
  - CDN cache 600s (s-maxage=600) de offload origin

  Chi voi Cache-Control:
    Cache-Control: public, max-age=5, s-maxage=600
    -> Browser hieu: max-age=5 -> OK
    -> CDN hieu: s-maxage=600 -> OK
    -> Nhung responses da duoc dinh nghia ky trong HTTP spec

  Truong hop phuc tap hon:
    Origin muon browser KHONG DUOC CACHE nhung CDN DUOC CACHE
    Cache-Control: private, no-store  (cho browser)
    CDN-Cache-Control: max-age=600    (cho CDN)
    -> Browser: khong cache
    -> CDN: cache 600s

  Day la separation of concerns:
    - Cache-Control: target browser + generic proxy
    - CDN-Cache-Control: target CDN specifically
```

**Cac directive trong CDN-Cache-Control**:

```text
+------------------+--------------------------------------------------+
| Directive        | Y nghia doi voi CDN                              |
+------------------+--------------------------------------------------+
| max-age=N        | TTL cho CDN. Ghi de Cache-Control s-maxage.      |
+------------------+--------------------------------------------------+
| stale-while-     | Ghi de Cache-Control stale-while-revalidate.      |
| revalidate=N     |                                                    |
+------------------+--------------------------------------------------+
| stale-if-error=N | Ghi de Cache-Control stale-if-error.              |
+------------------+--------------------------------------------------+
| no-cache         | CDN phai revalidate truoc khi serve.              |
+------------------+--------------------------------------------------+
| no-store         | CDN khong duoc cache.                             |
+------------------+--------------------------------------------------+
```

**Cach Varnish xu ly CDN-Cache-Control**:

```text
Varnish (voi built-in VCL hoac custom VCL) xu ly nhu sau:

1. Kiem tra CDN-Cache-Control truoc.
2. Neu co -> su dung no de set TTL, grace, keep.
3. Neu khong co -> fallback ve Cache-Control.
4. Khong forward CDN-Cache-Control cho client (tuy VCL).

VCL snippet dien hinh:
  if (beresp.http.CDN-Cache-Control) {
    // Parse CDN-Cache-Control, set beresp.ttl, etc.
  } else if (beresp.http.Cache-Control) {
    // Fallback to Cache-Control
  }
```

### 6.3 ETag

```text
BOX: ETag (Entity Tag)
================================================================
Muc dich:        Validator DANH TINH cho object. Origin tao ra
                 tu NOI DUNG cua response body.
Vi tri:          Response header (origin -> CDN -> client)
Cu phap:         ETag: "abc123" (strong)
                 ETag: W/"abc123" (weak)
Ai set:          Origin (app)
Ai consume:      CDN (revalidation), Browser (conditional GET)
================================================================
```

**Strong vs Weak ETag**:

```text
Strong ETag:  ETag: "abc123"
  - Thay doi khi VA CHI KHI byte-by-byte body thay doi.
  - Dung cho byte-range requests.
  - Origin dam bao: cung ETag -> tuyet doi giong nhau.

Weak ETag:    ETag: W/"abc123"
  - Thay doi khi NOI DUNG NGHIA thay doi
    (metadata nhu cache timestamp co the thay doi nhung content giong).
  - Dung cho semantic equivalence.
  - Origin dam bao: cung ETag -> ngu dung tuong duong.

VD: Cung san pham, 2 request:
  Response 1: { name: "Ao", price: 100, _cache_ts: 1234567890 }
  Response 2: { name: "Ao", price: 100, _cache_ts: 1234567891 }
  
  Neu dung strong ETag hash toan bo body: ETag khac (vi _cache_ts)
  Neu dung weak ETag hash content chinh: ETag giong (name, price giong)
```

**ETag trong CDN flow**:

```text
Lan 1: Client -> CDN -> Origin
  Origin: 200 OK, body: {...}, ETag: "abc123"
  CDN: Cache body + ETag, TTL=60s

Lan 2a (TTL con): Client -> CDN
  CDN: HIT, serve cached body, ETag: "abc123"

Lan 2b (TTL het, revalidate): Client -> CDN -> Origin
  CDN: If-None-Match: "abc123"
  Origin: "abc123" van dung -> 304 Not Modified
  CDN: Update TTL, serve cached body

Lan 2c (TTL het, object thay doi): Client -> CDN -> Origin
  CDN: If-None-Match: "abc123"
  Origin: object da thay doi (ETag: "xyz789") -> 200 OK, body moi
  CDN: Cache body moi + ETag moi, serve body moi
```

**Cach origin tao ETag dung cach**:

```text
GOOD: ETag = hash(noi dung response body)
  -> Cung noi dung -> cung ETag
  -> Khac noi dung -> khac ETag
  -> On dinh qua nhieu instance (cung hash algorithm)

BAD: ETag = server_timestamp + instance_id
  -> Cung noi dung, khac instance -> khac ETag
  -> Revalidation luon fail
  -> Every request -> 200 (full body) thay vi 304

BAD: ETag = random UUID moi request
  -> Moi request -> ETag moi
  -> Revalidation khong bao gio pass
  -> 304 khong bao gio xay ra
```

### 6.4 Vary

```text
BOX: Vary
================================================================
Muc dich:        Khai bao NHUNG REQUEST HEADER NAO lam thay
                 doi response content.
Vi tri:          Response header (origin -> CDN -> client)
Cu phap:         Vary: Accept-Language, X-Geo-Country
Ai set:          Origin (app)
Ai consume:      CDN (cache key variant), Browser (cache isolation)
================================================================
```

**Vary la cache key dimension**:

```text
Khong co Vary:
  Request 1: Accept-Language: vi -> response tieng Viet
  Request 2: Accept-Language: en -> CDN HIT -> serve tieng Viet
  -> User My thay tieng Viet -> cache leakage!

Co Vary: Accept-Language:
  Request 1: Accept-Language: vi -> CDN MISS -> cache v1
  Request 2: Accept-Language: en -> CDN MISS -> cache v2
  Request 3: Accept-Language: vi -> CDN HIT (v1) -> tieng Viet
  -> Moi variant co cache object rieng -> khong leakage!
```

**Cach CDN su dung Vary**:

```text
1. CDN doc Vary header tu origin response.
2. CDN tach ten cac request header tu Vary (phan cach boi ", ").
3. CDN hash gia tri cac request header do -> variant hash.
4. Cache key = hash(path + query) + variant hash.
5. Moi combination cua Vary headers -> cache object rieng.

Vi du:
  Vary: Accept-Language, X-Geo-Country
  Request: Accept-Language: vi, X-Geo-Country: VN
  -> Variant hash = hash("vi" + "VN")

  Request: Accept-Language: en, X-Geo-Country: VN
  -> Variant hash = hash("en" + "VN")
  -> KHAC variant hash -> MISS -> cache object rieng
```

**Cac Vary dimension trong case nay**:

```text
Product detail: Vary: Accept-Language, X-Geo-Country, X-Device-Class,
                      X-Ab-Variant, X-User-Segment
  -> 2 languages * 2 countries * 2 devices * 2 AB * 2 segments
  -> Toi da 32 variant cung 1 product URL
  -> Moi variant cach ly TOT

Categories: Vary: Accept-Language, X-Geo-Country
  -> 2 languages * 2 countries = 4 variant
  -> Categories service tra Vary headers nao no thuc su dung

Homefeed: Vary: Accept-Language, X-Geo-Country, X-Device-Class,
                X-Ab-Variant, X-User-Segment
  -> Day du 5 dimension cho personalization
```

### 6.5 Surrogate-Key

```text
BOX: Surrogate-Key
================================================================
Muc dich:        Gan TAG cho object de INVALIDATION THEO NHOM.
                 Mot object co the co nhieu tag (space-separated).
Vi tri:          Response header (origin -> CDN)
                 THUONG BI CDN STRIP (khong forward cho client).
Cu phap:         Surrogate-Key: product-1 catalog-homefeed segment-guest
Ai set:          Origin (app)
Ai consume:      CDN (Varnish) -- ban-tag operation
================================================================
```

**Surrogate-Key khac gi voi purge/ban URL?**

```text
Purge URL: xoa CHINH XAC 1 object theo URL
  VD: purge /api/sim/products/1?lang=vi&geo=VN
  -> Xoa DUNG 1 variant cua product 1
  -> Can purge 32 lan de xoa het all variants (neu co 32 variant)

Ban URL prefix: xoa tat ca object co URL bat dau bang prefix
  VD: ban /api/sim/products/1
  -> Xoa tat ca 32 variant
  -> Nhung cung xoa cac URL KHAC bat dau bang /api/sim/products/1
     (vd: /api/sim/products/10, /api/sim/products/1/recommendations)
  -> Co the xoa NHAM object khac

Ban tag (Surrogate-Key): xoa tat ca object co tag
  VD: ban-tag product-1
  -> Xoa TAT CA variant cua product 1 (32 variant)
  -> KHONG xoa product 10 (tag: product-10)
  -> CHINH XAC, AN TOAN, NHANH
```

**Cach Varnish xu ly Surrogate-Key**:

```text
1. Origin emit Surrogate-Key: product-1 catalog-homefeed segment-guest
2. Varnish (voi xkey VMOD) doc Surrogate-Key header.
3. Varnish register object vao hash table cua tung tag:
   - Tag "product-1" -> [cache_key_1]
   - Tag "catalog-homefeed" -> [cache_key_1]
   - Tag "segment-guest" -> [cache_key_1]
4. Sau khi register, Varnish THUONG STRIP Surrogate-Key header
   (khong forward den client).
5. Khi admin goi ban-tag "product-1":
   - Varnish tim tag "product-1" trong hash table
   - Lay danh sach cache keys: [cache_key_1]
   - Xoa (invalidate) tat ca object do
   - Request tiep theo -> MISS -> fetch tu origin

Day la co che INVALIDATION MANH ME NHAT cua Varnish.
```

**Thiet ke Surrogate-Key cho cac endpoint**:

```text
Product detail:
  Surrogate-Key: product-{id} catalog-products segment-{segment}
  -> product-1: xoa khi product 1 thay doi
  -> catalog-products: xoa khi catalog thay doi
  -> segment-guest: xoa khi guest cache policy thay doi

Homefeed:
  Surrogate-Key: catalog-homefeed segment-{segment}
  -> catalog-homefeed: xoa khi homefeed catalog update
  -> segment-returning: xoa cho returning users (neu can)

Categories:
  Surrogate-Key: catalog-categories
  -> catalog-categories: xoa khi category tree thay doi
```

### 6.6 Last-Modified

```text
BOX: Last-Modified
================================================================
Muc dich:        Timestamp lan cuoi object thay doi.
                 Validator THAY THE cho ETag (kem chinh xac hon).
Vi tri:          Response header (origin -> CDN -> client)
Cu phap:         Last-Modified: <http-date>
                 VD: Last-Modified: Wed, 21 Oct 2025 07:28:00 GMT
Ai set:          Origin (app)
Ai consume:      CDN, Browser (If-Modified-Since)
================================================================
```

**Last-Modified vs ETag**:

```text
+------------------+-----------------------------------+-----------------------------------+
| Tieu chi         | ETag                              | Last-Modified                     |
+------------------+-----------------------------------+-----------------------------------+
| Do chinh xac     | CHINH XAC byte-by-byte            | Do chinh xac 1 GIay               |
|                  | (strong) hoac semantic (weak)      | (HTTP-date chi co second-level)   |
+------------------+-----------------------------------+-----------------------------------+
| Do on dinh       | Phu thuoc cach origin hash        | Dua vao file timestamp hoac       |
|                  | (nen la content hash)             | record updated_at                 |
+------------------+-----------------------------------+-----------------------------------+
| Cross-instance   | ON DINH neu dung content hash     | KHONG ON DINH neu server khac    |
|                  |                                   | dong ho                            |
+------------------+-----------------------------------+-----------------------------------+
| Conditional hdr  | If-None-Match                     | If-Modified-Since                 |
+------------------+-----------------------------------+-----------------------------------+
| Uu tien         | ETag duoc uu tien (HTTP spec)     | Neu co ETag, Last-Modified        |
|                  |                                   | la validator DU PHONG              |
+------------------+-----------------------------------+-----------------------------------+
```

**Trong Varnish**: Varnish uu tien ETag cho revalidation. Neu khong co ETag,
Varnish su dung Last-Modified voi If-Modified-Since.

---

## 7. 304 Revalidation deep-dive

### Tai sao 304 la "che do tiet kiem bang thong"?

```text
So sanh 2 scenario:

SCENARIO A: KHONG co revalidation (khong ETag)
  Object het han -> CDN luon fetch full body tu origin
  Moi request MISS: origin tra 200 OK + ~4KB body
  1000 requests = 4MB bang thong origin->CDN

SCENARIO B: CO revalidation (co ETag)
  Object het han -> CDN gui If-None-Match
  Origin tra 304 Not Modified (KHONG body)
  Moi revalidation: origin tra ~200 bytes headers
  1000 revalidations = ~200KB bang thong origin->CDN

=> TIET KIEM 95% bang thong giua origin va CDN
```

### Full 304 flow (tung buoc)

```text
BUOC 0: TRANG THAI BAN DAU
  CDN cache: object voi body, ETag="abc123", TTL=60s, expired=false

BUOC 1: TTL HET HAN (t > 60s)
  CDN cache: same object, expired=true
  (Object van con trong cache, nhung da "stale")

BUOC 2: CLIENT REQUEST DEN
  Client: GET /api/sim/products/1
          Host: localhost:80
          Accept-Language: vi
          X-Geo-Country: VN

BUOC 3: CDN XU LY
  CDN tim object trong cache:
    - Co object voi key tuong ung
    - Nhung expired=true
  CDN QUYET DINH: revalidate (khong serve stale ngay)
  CDN gui request den origin:

    GET /api/sim/products/1 HTTP/1.1
    Host: backend:8080
    Accept-Language: vi
    X-Geo-Country: VN
    If-None-Match: "abc123"       <-- ETag cua cached object

BUOC 4: ORIGIN XU LY
  Origin nhan request:
    - Tinh toan ETag cho response hien tai: "abc123"
    - So sanh voi If-None-Match: khop!
  Origin QUYET DINH: body khong thay doi -> 304

    HTTP/1.1 304 Not Modified
    Cache-Control: public, s-maxage=60, stale-while-revalidate=30, stale-if-error=120
    ETag: "abc123"                <-- CUNG etag
    Date: Sun, 22 Jun 2026 10:00:00 GMT

    (KHONG CO BODY)

BUOC 5: CDN CAP NHAT
  CDN nhan 304:
    - Cap nhat TTL: set lai 60s (tu Cache-Control header moi)
    - Cap nhat expired=false
    - GIU NGUYEN cached body (body khong thay doi)

BUOC 6: CDN RESPONSE CHO CLIENT
  CDN tra ve client:

    HTTP/1.1 200 OK               <-- CDN tra 200 (khong phai 304)
    Cache-Control: public, s-maxage=60, ...
    ETag: "abc123"
    X-Cache: HIT                  <-- Day la HIT (tu cache)
    Content-Length: 4096
    ...

    {body tu CDN cache}           <-- Khong ton bang thong origin

=> CLIENT LUON THAY 200 (hoac 304 tuy VCL config)
   CDN+ORIGIN DA TIET KIEM 95% BANG THONG
```

### Code trace trong script

```javascript
// === REQUEST 1: Lay ETag ===
const detail = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'detail_contract' },
});
// Response: 200 OK, ETag: "abc123", X-Cache: MISS

const detailETag = getHeader(detail, 'ETag');
// detailETag = "abc123"

// === REQUEST 2: Revalidate voi ETag ===
const revalidated = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  headers: {
    'Cache-Control': 'no-cache',   // -- (1) bao CDN "phai revalidate"
    'If-None-Match': detailETag,   // -- (2) bao origin "toi co ETag nay"
  },
  tags: { case: 'detail_revalidate' },
});
// Response: 304 Not Modified

assertStatus(revalidated, 304, 'detail revalidation');
```

**Giai thich 2 header trong request 2**:

```text
(1) Cache-Control: no-cache
    Client bao CDN: "Dung serve tu cache, hay hoi origin truoc."
    CDN hieu: day la conditional request, can revalidate.
    Neu KHONG CO header nay: CDN co the serve STALE (neu trong
    grace period) ma khong thuc su hoi origin -> 304 khong xay ra.

(2) If-None-Match: "abc123"
    Client (qua CDN) bao origin: "Toi da co object voi ETag 'abc123'.
    Neu no con dung, tra 304. Neu no sai, tra 200 voi body moi."
    Origin so sanh ETag hien tai cua object voi "abc123":
      - Khop -> 304
      - Khong khop -> 200
```

### Cac truong hop 304 khong xay ra

```text
Truong hop 1: ETag khong on dinh
  -> Moi request origin tra ETag khac nhau (du cung noi dung)
  -> If-None-Match luon khong khop -> luon 200
  -> Giong nhu khong co revalidation

Truong hop 2: Origin khong ho tro If-None-Match
  -> Origin bo qua If-None-Match, luon tra 200
  -> CDN van cache, nhung khong tiet kiem duoc bang thong

Truong hop 3: CDN khong forward If-None-Match
  -> CDN config sai, strip If-None-Match header
  -> Origin khong bao gio nhan conditional request -> luon 200

Truong hop 4: Cache-Control: no-cache thieu
  -> CDN serve stale ma khong revalidate
  -> Khong gui request den origin -> 304 khong xay ra
  -> Client nhan 200 tu cache (stale) thay vi 304

Truong hop 5: Object da bi xoa khoi CDN cache
  -> Khong con object de revalidate
  -> CDN phai fetch FULL tu origin -> 200 (MISS)
  -> Neu object bi evict (LRU) truoc khi TTL het -> mat co hoi 304
```

### 304 trong CDN khac gi 304 trong browser?

```text
Browser nhan 304:
  - Browser tu cap nhat cached object TTL
  - Browser hien thi cached content
  - User khong thay gi khac

CDN nhan 304:
  - CDN cap nhat TTL trong cache storage
  - CDN serve cached body cho TAT CA client tiep theo
  - 1 request revalidation -> loi ich cho HANG NGAN request sau

=> 304 o CDN layer co Y NGHIA NHAN LEN:
   Origin chi ton ~200 bytes headers cho 1 revalidation,
   nhung tiet kiem duoc ~4KB body * N request tiep theo.
```

---

## 8. Key signals

### Response headers can quan sat

```text
+------------------------+----------+-------------------------------------------+
| Header                 | Source   | Y nghia                                   |
+------------------------+----------+-------------------------------------------+
| X-Cache                | Varnish  | HIT / MISS / BYPASS: cache status          |
+------------------------+----------+-------------------------------------------+
| Cache-Control          | Origin   | Policy cho browser + CDN                  |
+------------------------+----------+-------------------------------------------+
| CDN-Cache-Control      | Origin   | Policy rieng cho CDN                       |
+------------------------+----------+-------------------------------------------+
| ETag                   | Origin   | Validator danh tinh cho body              |
+------------------------+----------+-------------------------------------------+
| Last-Modified          | Origin   | Validator thoi gian (du phong)             |
+------------------------+----------+-------------------------------------------+
| Surrogate-Key          | Origin   | Tag de ban-tag invalidation               |
+------------------------+----------+-------------------------------------------+
| Vary                   | Origin   | Variant isolation dimensions              |
+------------------------+----------+-------------------------------------------+
| X-Cache-Key-Language   | Varnish  | Language dimension trong cache key         |
+------------------------+----------+-------------------------------------------+
| X-Cache-Key-Geo        | Varnish  | Geo dimension trong cache key             |
+------------------------+----------+-------------------------------------------+
| X-Cache-Key-Device     | Varnish  | Device dimension trong cache key           |
+------------------------+----------+-------------------------------------------+
| X-Cache-Key-AB         | Varnish  | AB variant dimension trong cache key       |
+------------------------+----------+-------------------------------------------+
| X-Cache-Key-Segment    | Varnish  | Segment dimension trong cache key          |
+------------------------+----------+-------------------------------------------+
```

### Expected values

```text
PRODUCT DETAIL (/api/sim/products/1):

  Cache-Control:        public, s-maxage=<N>, stale-while-revalidate=<N>,
                        stale-if-error=<N>
  CDN-Cache-Control:    max-age=<N>, stale-while-revalidate=<N>,
                        stale-if-error=<N>
  ETag:                 W/"<hash>" hoac "<hash>"
  Last-Modified:        <http-date>
  Surrogate-Key:        ... product-1 ... (phai chua product-{id})
  Vary:                 <danh sach request headers cach nhau boi ", ">

HOMEFEED (/api/sim/products/homefeed):

  Surrogate-Key:        ... catalog-homefeed ... segment-returning ...

CATEGORIES (/api/sim/products/categories):

  Vary:                 ... Accept-Language ... X-Geo-Country ...

304 REVALIDATION:

  Status:               304 Not Modified
  Body:                 empty (0 bytes hoac rat nho)
  ETag:                 GIONG voi ETag request 1
```

### 200 vs 304 distinction

```text
+------------------+-----------------------------------+-----------------------------------+
| Signal           | 200 OK (first request)            | 304 Not Modified (revalidation) |
+------------------+-----------------------------------+-----------------------------------+
| Body             | Co body (JSON, ~4KB)              | KHONG body (0 bytes)              |
+------------------+-----------------------------------+-----------------------------------+
| ETag             | Co (validator cho tuong lai)      | Co (cung gia tri)                 |
+------------------+-----------------------------------+-----------------------------------+
| Cache-Control    | Co (policy day du)                | Co (policy day du)                |
+------------------+-----------------------------------+-----------------------------------+
| X-Cache          | MISS                              | Khong co (CDN internal)           |
+------------------+-----------------------------------+-----------------------------------+
| Y nghia         | Object moi duoc fetch             | Object KHONG thay doi              |
+------------------+-----------------------------------+-----------------------------------+
| Bang thong      | Ton ~4KB origin -> CDN            | Ton ~200 bytes origin -> CDN      |
+------------------+-----------------------------------+-----------------------------------+
```

### Cache-Control directive map

```text
Response tu cacheable endpoint PHAI co:

  Cache-Control:
    [x] public
    [x] s-maxage=N
    [x] stale-while-revalidate=N
    [x] stale-if-error=N

  CDN-Cache-Control:
    [x] max-age=N
    [x] stale-while-revalidate=N
    [x] stale-if-error=N

  Validator (it nhat 1):
    [x] ETag
    [x] Last-Modified

  Invalidation:
    [x] Surrogate-Key (khong empty)

  Variant isolation:
    [x] Vary (khong empty, chua cac header dung)
```

---

## 9. Pass/fail criteria

### PASS khi

```text
1. TAT CA checks deu pass (checks rate = 1 theo threshold).

2. TAT CA required headers hien dien:
   - Product detail: Cache-Control, CDN-Cache-Control, ETag,
     Last-Modified, Surrogate-Key, Vary
   - Homefeed: Surrogate-Key chua catalog-homefeed, segment-returning
   - Categories: Vary chua Accept-Language, X-Geo-Country

3. Cache-Control chua cac directive bat buoc:
   - public (cho phep CDN cache)
   - s-maxage=N (TTL cho shared cache)
   - stale-while-revalidate=N (grace period khi revalidate)
   - stale-if-error=N (grace period khi origin loi)

4. CDN-Cache-Control chua cac directive bat buoc:
   - max-age=N (CDN-specific TTL)
   - stale-while-revalidate=N
   - stale-if-error=N

5. ETag hien dien VA ON DINH:
   - Response 1 co ETag
   - Response 2 (revalidate) co CUNG ETag

6. 304 revalidation hoat dong:
   - Gui If-None-Match voi ETag tu response 1
   - Nhan duoc 304 Not Modified

7. Surrogate-Key chua tag theo dung convention:
   - Product detail: chua product-{id}
   - Homefeed: chua catalog-homefeed, segment-{segment}

8. Homefeed response success = true.

9. Categories response success = true.
```

### FAIL khi

```text
HEADER THIEU:

  [FAIL] Thieu Cache-Control -> CDN khong biet cache bao lau
  [FAIL] Thieu CDN-Cache-Control -> CDN khong co TTL rieng
  [FAIL] Thieu ETag -> khong the revalidate
  [FAIL] Thieu Last-Modified -> khong co validator du phong
  [FAIL] Thieu Surrogate-Key -> khong the ban-tag invalidate
  [FAIL] Thieu Vary -> khong co variant isolation

DIRECTIVE THIEU:

  [FAIL] Cache-Control khong co public -> CDN co the khong cache
  [FAIL] Cache-Control co private -> CDN KHONG DUOC cache
  [FAIL] Cache-Control khong co s-maxage -> CDN khong biet TTL
  [FAIL] Cache-Control khong co stale-while-revalidate
  [FAIL] Cache-Control khong co stale-if-error

304 REVALIDATION FAIL:

  [FAIL] ETag co nhung 304 khong xay ra (tra 200)
         -> ETag khong on dinh hoac origin khong ho tro If-None-Match
  [FAIL] ETag thay doi giua 2 request (du cung noi dung)
         -> ETag hash bi sai (timestamp-based)

SURROGATE-KEY SAI:

  [FAIL] Surrogate-Key empty
  [FAIL] Surrogate-Key khong chua product-{id} (voi product detail)
  [FAIL] Surrogate-Key khong chua catalog-homefeed (voi homefeed)

RESPONSE BODY SAI:

  [FAIL] categories response success=false
  [FAIL] homefeed response khong parse duoc JSON
```

---

## 10. Cach chay + output

### Cach chay

```powershell
# Tu working directory cua project
cd E:/Projects/k6/k6-metrics-server

# Set env vars
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

# Chay script
./scripts/run-cdn-capabilities.ps1 -Scenarios 07-cache-contract
```

Hoac chay truc tiep bang k6:

```powershell
k6 run `
  -e BASE_URL=http://localhost:80 `
  -e CONTROL_BASE_URL=http://localhost:8088 `
  -e CATALOG_EVENTS_BASE_URL=http://localhost:9091 `
  -e OPS_AUTH_TOKEN=<ops-token> `
  load-target/k6/cdn/07-cache-contract.js
```

### Output mong doi (PASS)

```text
  execution: local
     script: load-target/k6/cdn/07-cache-contract.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations shared among 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)

  ✓ detail contract status 200
  ✓ detail contract Cache-Control present
  ✓ detail contract Cache-Control has public
  ✓ detail contract Cache-Control has s-maxage=
  ✓ detail contract Cache-Control has stale-while-revalidate=
  ✓ detail contract Cache-Control has stale-if-error=
  ✓ detail contract CDN-Cache-Control present
  ✓ detail contract CDN-Cache-Control has max-age=
  ✓ detail contract CDN-Cache-Control has stale-while-revalidate=
  ✓ detail contract CDN-Cache-Control has stale-if-error=
  ✓ detail contract ETag present
  ✓ detail contract Last-Modified present
  ✓ detail contract Surrogate-Key present
  ✓ detail contract Surrogate-Key has product-1
  ✓ detail contract Vary present
  ✓ detail revalidation status 304
  ✓ homefeed contract status 200
  ✓ homefeed contract Surrogate-Key has catalog-homefeed
  ✓ homefeed contract Surrogate-Key has segment-returning
  ✓ categories contract status 200
  ✓ categories contract Vary has Accept-Language
  ✓ categories contract Vary has X-Geo-Country

  checks.........................: 100.00% ✓ 22       ✗ 0
  data_received..................: 15 kB   1.1 kB/s
  data_sent......................: 2.4 kB  172 B/s
  http_req_duration.............: avg=45.2ms  min=23.1ms med=38.7ms max=89.3ms p(95)=78.2ms
  http_req_blocked..............: avg=1.2ms   min=0.1ms  med=0.3ms  max=5.2ms  p(95)=4.1ms
  http_req_connecting...........: avg=0.8ms   min=0.0ms  med=0.2ms  max=3.1ms  p(95)=2.8ms
  http_reqs.....................: 4       0.286/s
  iteration_duration............: avg=302.5ms min=302.5ms med=302.5ms max=302.5ms p(95)=302.5ms
  iterations....................: 1       0.071/s
  vus............................: 1       min=1 max=1
  vus_max........................: 1       min=1 max=1

running (00m14.0s), 1/1 VUs, 1 complete and 0 interrupted iterations
default ✓ [======================================] 1 VUs  00m14.0s/10m0s  1/1 shared iters
```

### Output khi FAIL

```text
  ✗ detail contract status 200
    ↳  0% — ✓ 0 / ✗ 1

  ✗ detail contract Cache-Control present
    ↳  0% — ✓ 0 / ✗ 1

  ✗ detail contract Cache-Control has public
    ↳  0% — ✓ 0 / ✗ 1

  ... (cac checks khac cung fail neu headers thieu)

  checks.........................: 0.00%  ✓ 0        ✗ 22
```

### Cach doc output

```text
1. NHIN DAU TIEN vao checks: 100% ✓ 22 ✗ 0 -> PASS
   Hoac: 0% ✓ 0 ✗ 22 -> FAIL

2. Neu FAIL: tim check FAIL DAU TIEN.
   Day la ROOT CAUSE.
   VD: "detail contract Cache-Control present" fail
   -> Origin KHONG emit Cache-Control
   -> CAC CHECK SAU (has public, has s-maxage) cung fail theo
   -> Khong can fix tung check, chi can fix ROOT CAUSE la origin emit Cache-Control

3. Neu PASS nhung muon INSPECT response headers:
   -> Dung --http-debug="full" de xem toan bo headers
   -> Hoac them console.log trong script

4. Neu 304 revalidation FAIL:
   -> Kiem tra ETag co thay doi khong (console.log ca 2 ETag)
   -> Kiem tra origin log: co If-None-Match header khong?
   -> Kiem tra VCL: co forward If-None-Match khong?
```

---

## 11. 4 output-to-decision scenarios

### Scenario 1: MISSING Cache-Control -- CDN khong cache

```text
OUTPUT:
  ✗ detail contract Cache-Control present
  ✗ detail contract Cache-Control has public
  ✗ detail contract Cache-Control has s-maxage=
  ...
  Tat ca checks lien quan den Cache-Control deu FAIL.

ROOT CAUSE:
  Origin handler khong emit Cache-Control header.
  Hoac middleware/framework da strip Cache-Control.

CDN BEHAVIOR:
  Varnish khong co Cache-Control -> khong biet TTL.
  > Neu VCL default TTL = 0s -> KHONG CACHE
  > Neu VCL default TTL = 120s -> cache 120s (nhung khong duoc kiem soat)
  > KHONG CO stale-while-revalidate, stale-if-error
  > Moi request deu MISS -> origin nhan 100% traffic

DECISION:
  KHONG DUOC DEPLOY RA PRODUCTION.
  Origin PHAI emit Cache-Control voi:
    - public
    - s-maxage=N (dinh ro TTL)
    - stale-while-revalidate=N
    - stale-if-error=N

FIX:
  Them applySimpleCDNCacheHeaders(c, ttl, staleIfError) vao handler.
  Hoac set header thu cong trong handler code.
```

### Scenario 2: ETag MISSING -- khong revalidation

```text
OUTPUT:
  ✓ detail contract Cache-Control present
  ✓ detail contract CDN-Cache-Control present
  ✗ detail contract ETag present               <-- FAIL
  ✗ detail revalidation status 304             <-- Auto FAIL (khong co ETag)

ROOT CAUSE:
  Origin khong tao ETag cho response.
  Co the do framework khong tu dong tao ETag,
  hoac middleware da strip ETag header.

CDN BEHAVIOR:
  Object van duoc cache (co Cache-Control).
  Nhung khi het han -> CDN KHONG THE revalidate.
  CDN phai fetch full body tu origin (200 OK).
  > Bang thong origin -> CDN tang 20x.
  > Latency tang (phai cho full body transfer).

DECISION:
  CO THE DEPLOY (van con CDN cache).
  NHUNG CAN FIX SOM:
    - Moi TTL expiry -> full body fetch -> lang phi bang thong.
    - Khi traffic cao -> origin lai bi qua tai.

FIX:
  Them ETag middleware vao framework.
  Hoac manual set ETag header = hash(response body).
  Dam bao ETag ON DINH qua cac instance.
```

### Scenario 3: 304 NEVER RETURNED -- origin luon tra full body

```text
OUTPUT:
  ✓ detail contract ETag present
  ✗ detail revalidation status 304            <-- FAIL (tra 200 thay vi 304)

ROOT CAUSE (3 kha nang):
  1. ETag khong on dinh: moi request tra ETag khac
     -> Origin dung server timestamp + instance ID de tao ETag
     -> If-None-Match khong bao gio khop -> luon 200

  2. Origin khong ho tro If-None-Match
     -> Origin bo qua conditional header, luon tra 200 + body
     -> ETag co nhung chi de "trang tri"

  3. CDN khong forward If-None-Match
     -> VCL strip hoac khong them If-None-Match khi revalidate
     -> Origin khong bao gio nhan conditional request

CDN BEHAVIOR:
  Object van duoc cache.
  Khi het han -> fetch full body -> BANG THONG BI LANG PHI.
  Moi TTL cycle, origin phai gui full body (co the 4KB-100KB).
  Neu 1000 requests/cycle -> ton ~4-100MB bang thong khong can thiet.

DECISION:
  KHONG DUOC DEPLOY (neu ETag da co nhung 304 khong hoat dong).
  Day la dau hieu cua ETag IMPLEMENTATION SAI.
  Neu ETag dung, 304 PHAI hoat dong.

DEBUG:
  console.log("ETag request 1:", detailETag);
  console.log("ETag request 2:", getHeader(revalidated, 'ETag'));
  -> Neu 2 ETag KHAC nhau: ETag hash sai -> fix hash algorithm
  -> Neu 2 ETag GIONG nhau nhung van 200:
     -> Kiem tra origin log: co If-None-Match?
     -> Kiem tra VCL: co gui If-None-Match den backend?
     -> Kiem tra CDN: co forward If-None-Match tu client?
```

### Scenario 4: Surrogate-Key MISSING -- khong the ban-tag

```text
OUTPUT:
  ✓ detail contract Cache-Control present
  ✓ detail contract ETag present
  ✓ detail revalidation status 304
  ✗ detail contract Surrogate-Key present      <-- FAIL

ROOT CAUSE:
  Origin handler khong gan Surrogate-Key header.
  Hoac Surrogate-Key empty (chi chua whitespace).

CDN BEHAVIOR:
  Object van duoc cache BINH THUONG.
  Nhung KHONG THE BAN-TAG:
    - Admin muon xoa tat ca variant cua product 1
    -> Khong co tag "product-1" -> khong the ban-tag
    -> Phai purge tung URL variant (32 lan)
    -> Hoac ban URL prefix (co the xoa nham product 10, 11, ...)
  > Invalidation CHAM, TON TAI NGUYEN, DE SAI.

DECISION:
  CO THE DEPLOY (van co cache, van co revalidation).
  NHUNG PHAI FIX TRUOC KHI CAN INVALIDATION NHANH.
  Neu app co yeu cau "cap nhat gia ngay lap tuc" -> CAN Surrogate-Key.

FIX:
  Them Surrogate-Key header vao response:
    - Product detail: Surrogate-Key: product-{id} catalog-products segment-{segment}
    - Homefeed: Surrogate-Key: catalog-homefeed segment-{segment}
    - Categories: Surrogate-Key: catalog-categories
  Dam bao tag naming convention nhat quan.
```

---

## 12. Nghich ly / misconceptions

### Misconception 1: "304 nghia la loi"

```text
NHIEU NGUOI HIEN LAM: 304 la status error.

THUC TE: 304 Not Modified la MOT TRONG NHUNG STATUS THANH CONG
QUAN TRONG NHAT trong HTTP caching.

  - 200 OK: "Day la object. Toi gui ca body."
  - 304 Not Modified: "Object cua anh van con tot. Toi KHONG gui body."

304 la DAU HIEU CUA MOT HE THONG CACHE HOAT DONG DUNG:
  - ETag hoat dong
  - If-None-Match duoc ho tro
  - Origin dung conditional logic
  - Bang thong duoc tiet kiem

NEU TEST TRA VE 200 KHI MONG DOI 304 -> FAIL.
NEU TEST TRA VE 304 KHI MONG DOI 304 -> PASS.

304 khong bao gio la "loi". No la "toi uu hoa".
```

### Misconception 2: "Cache-Control la du, khong can CDN-Cache-Control"

```text
NHIEU NGUOI NGHI: "Cache-Control da co s-maxage roi,
CDN hieu s-maxage, can gi CDN-Cache-Control nua?"

THUC TE: CDN-Cache-Control co vai tro KHAC BIET:

  1. Separation of concerns:
     Cache-Control: target browser + generic proxy
     CDN-Cache-Control: target CDN specifically

  2. Different TTL strategies:
     Browser can cache 5s (fast repeat view)
     CDN cache 600s (offload origin)
     -> Khong the bieu dien bang 1 Cache-Control header
        (s-maxage ghi de max-age nhung browser van dung max-age)

  3. Private browser, public CDN:
     Cache-Control: private, max-age=300   (browser cache 5m)
     CDN-Cache-Control: max-age=3600       (CDN cache 1h)
     -> Origin muon browser private cache nhung CDN public cache

  4. CDN-specific directives:
     Mot so CDN ho tro directive rieng (vd: CDN-Cache-Control: no-cdn)
     Khong the dien ta bang Cache-Control chuan.

=> CDN-Cache-Control KHONG PHAI "optional nice-to-have".
   No la MOT PHAN CUA CONTRACT HOAN CHINH.
```

### Misconception 3: "ETag thay doi moi request la binh thuong"

```text
NHIEU NGUOI NGHI: "ETag la random string, moi request khac la OK."

THUC TE: ETag PHAI ON DINH cho cung noi dung.

Neu ETag thay doi moi request:
  -> Moi revalidation deu that bai (If-None-Match khong khop)
  -> Origin LUON tra 200 (full body) thay vi 304
  -> Bang thong BI LANG PHI
  -> ETag thanh VO DUNG

ETag DUNG:
  ETag = hash(JSON.stringify(response_body))
  -> Cung body -> cung hash -> cung ETag
  -> Khac body -> khac hash -> khac ETag
  -> On dinh qua moi request, moi instance

Neu khong the hash body (performance):
  ETag = hash(content_version + content_updated_at)
  -> Cung version + cung timestamp -> cung ETag
  -> Khi content update -> version thay doi -> ETag khac
```

### Misconception 4: "Vary la khong quan trong, khong can kiem tra"

```text
NHIEU NGUOI NGHI: "Vary chi la metadata, khong anh huong den logic."

THUC TE: Vary la DIMENSION CUA CACHE KEY.
Neu Vary SAI -> CACHE LEAKAGE NGUY HIEM.

Vi du thuc te:
  App tra Vary: Accept-Language cho product detail.
  User VN request -> cache object tieng Viet.
  User US request:
    - Neu Vary DUNG: MISS -> fetch tieng Anh -> DUNG.
    - Neu Vary THIEU: HIT -> serve tieng Viet -> SAI.
      User My thay "Ao so mi" thay vi "T-shirt".
      -> Khong hieu -> khong mua -> lost revenue.

  App khong tra Vary nhung thuc te co variant theo Header:
    -> CDN cache object DAU TIEN duoc fetch
    -> Tat ca user sau deu HIT object do
    -> User VN -> MISS -> cache tieng Viet
    -> User US -> HIT -> nhan tieng Viet
    -> User VN (mobile) -> HIT -> nhan tieng Viet (? dung)
    -> User VN (desktop) -> HIT -> nhan mobile layout

  => Vary SAI = DATA CORRUPTION trong CDN.
     Day la bug NGUY HIEM vi no IM LANG:
     - Tat ca status 200 (khong co error)
     - Tat ca user deu nhan response (khong co 5xx)
     - Nhung NOI DUNG SAI -> business impact rat lon
```

### Misconception 5: "Surrogate-Key la optional, purge URL la du"

```text
NHIEU NGUOI NGHI: "Can invalidate thi purge URL. Can gi Surrogate-Key?"

THUC TE: Purge URL chi hoat dong voi SO IT variant.

Vi du: Product detail co 5 variant dimensions, 2-3 gia tri moi dimension.
  -> Tong variant: 2*2*2*2*2 = 32 variant cho CUNG 1 product.
  -> Neu dung purge URL: PHAI LIET KE VA PURGE TUNG VARIANT.
     Neu thieu 1 variant -> user van thay cached object CU.
  -> Neu dung ban-tag product-1: 1 LAN XOA DU 32 VARIANT.
     Khong lo thieu, khong mat thoi gian liet ke.

Ngoai ra:
  - Surrogate-Key cho phep INVALIDATION THEO BUSINESS LOGIC:
    "Xoa tat ca homefeed cho returning users" -> ban-tag segment-returning
    "Xoa tat ca categories" -> ban-tag catalog-categories
  - Purge URL chi xoa THEO URL PATTERN (thuan ky thuat, khong business)
```

---

## 13. Checklist

### Truoc khi chay test

```text
[ ] TargetLayer = full (CDN + Nginx + app)
[ ] Tat ca upstream services healthy
[ ] OPS_AUTH_TOKEN duoc set
[ ] BASE_URL = http://localhost:80 (di qua Varnish)
[ ] CONTROL_BASE_URL = http://localhost:8088
[ ] CATALOG_EVENTS_BASE_URL = http://localhost:9091
[ ] Khong co cache warming truoc (cache sach hoac cold)
```

### Kiem tra headers

```text
PRODUCT DETAIL:
[ ] Cache-Control present
[ ] Cache-Control chua: public
[ ] Cache-Control chua: s-maxage=N (N > 0)
[ ] Cache-Control chua: stale-while-revalidate=N (N > 0)
[ ] Cache-Control chua: stale-if-error=N (N > 0)
[ ] CDN-Cache-Control present
[ ] CDN-Cache-Control chua: max-age=N (N > 0)
[ ] CDN-Cache-Control chua: stale-while-revalidate=N
[ ] CDN-Cache-Control chua: stale-if-error=N
[ ] ETag present
[ ] Last-Modified present
[ ] Surrogate-Key present + not empty
[ ] Surrogate-Key chua: product-{id}
[ ] Vary present + not empty
[ ] Vary chua cac dimension dung (Accept-Language, X-Geo-Country, ...)

HOMEFEED:
[ ] Status 200
[ ] Surrogate-Key chua: catalog-homefeed
[ ] Surrogate-Key chua: segment-{segment}
[ ] Body parse duoc JSON, success=true

CATEGORIES:
[ ] Status 200
[ ] Vary chua: Accept-Language
[ ] Vary chua: X-Geo-Country
[ ] Body parse duoc JSON, success=true
```

### Kiem tra 304 revalidation

```text
[ ] Response 1 (200) co ETag
[ ] ETag khong empty
[ ] Response 2 (voi If-None-Match) co status 304
[ ] ETag response 2 == ETag response 1
[ ] Response 2 KHONG co body (hoac body rat nho)
```

### Sau khi test pass

```text
[ ] Checks rate = 1 (100%)
[ ] Tat ca thresholds pass
[ ] Khong co exception nao
[ ] Http errors = 0 (304 KHONG PHAI ERROR)
[ ] Neu co them kiem tra, tat ca deu pass
```

---

## 14. Variations

### Variation 1: Different TTL values

```text
Muc dich: Kiem tra origin co the emit TTL khac nhau cho
          cac endpoint khac nhau.

Thay doi: Thay vi chi test 1 TTL value, test nhieu endpoint
          voi TTL khac nhau.

Vi du script mo rong:
  // Product detail: TTL 60s
  assertHeaderContains(detail, 'Cache-Control', 's-maxage=60', 'product ttl');

  // Homefeed: TTL 30s (thay doi nhanh hon)
  const homefeed = requestCdn('GET', paths.homefeed, {
    profile: profiles.returningVNMobileVariantA,
  });
  assertHeaderContains(homefeed, 'Cache-Control', 's-maxage=30', 'homefeed ttl');

  // Categories: TTL 300s (it thay doi)
  const categories = requestCdn('GET', paths.categories, {
    profile: profiles.guestUSDesktopControl,
  });
  assertHeaderContains(categories, 'Cache-Control', 's-maxage=300', 'categories ttl');

Y nghia:
  - Moi endpoint co TTL phu hop voi BUSINESS REQUIREMENTS.
  - Product thay doi gia thuong xuyen -> TTL ngan.
  - Categories it thay doi -> TTL dai.
  - Neu TTL giong nhau cho tat ca -> co the la "copy-paste config",
    khong phai "designed per endpoint".
```

### Variation 2: CDN-Cache-Control override

```text
Muc dich: Kiem tra CDN-Cache-Control co TTL KHAC voi Cache-Control.
          Day la tinh nang quan trong cho CDN-specific TTL.

Thay doi: Assert CDN-Cache-Control max-age != Cache-Control s-maxage.

Vi du script mo rong:
  const cacheControl = getHeader(detail, 'Cache-Control');
  const cdnCacheControl = getHeader(detail, 'CDN-Cache-Control');

  // Extract s-maxage tu Cache-Control
  const sMaxAgeMatch = cacheControl.match(/s-maxage=(\d+)/);
  const sMaxAge = sMaxAgeMatch ? parseInt(sMaxAgeMatch[1]) : 0;

  // Extract max-age tu CDN-Cache-Control
  const cdnMaxAgeMatch = cdnCacheControl.match(/max-age=(\d+)/);
  const cdnMaxAge = cdnMaxAgeMatch ? parseInt(cdnMaxAgeMatch[1]) : 0;

  // CDN-Cache-Control max-age co the >= Cache-Control s-maxage
  if (cdnMaxAge < sMaxAge) {
    throw new Error(
      `CDN-Cache-Control max-age=${cdnMaxAge} < Cache-Control s-maxage=${sMaxAge}. ` +
      `CDN nen cache LAU HON hoac BANG browser, khong duoc ngan hon.`
    );
  }

  console.log(
    `CDN TTL: ${cdnMaxAge}s (from CDN-Cache-Control), ` +
    `Browser shared TTL: ${sMaxAge}s (from Cache-Control)`
  );

Y nghia:
  - CDN-Cache-Control cho phep CDN cache lau hon browser.
  - Neu CDN cache NGAN hon browser -> khong toi uu.
  - Day la validation ve "separation of concerns" cua 2 header.
```

### Variation 3: Weak vs Strong ETag

```text
Muc dich: Kiem tra loai ETag (weak W/"..." hay strong "...")
          va dam bao no ON DINH.

Thay doi: Assert ETag format va do on dinh qua 2 request.

Vi du script mo rong:
  const etag1 = getHeader(detail, 'ETag');
  // Kiem tra format: weak hay strong
  const isWeak = etag1.startsWith('W/"');
  const isStrong = etag1.startsWith('"');

  if (!isWeak && !isStrong) {
    throw new Error(`ETag format invalid: ${etag1}`);
  }

  console.log(`ETag type: ${isWeak ? 'WEAK' : 'STRONG'}`);

  // Request 2: phai co CUNG ETag
  const revalidated = requestCdn('GET', paths.productDetail, {
    profile: profiles.guestVNMobileControl,
    headers: {
      'Cache-Control': 'no-cache',
      'If-None-Match': etag1,
    },
    tags: { case: 'detail_revalidate_etag' },
  });

  if (revalidated.status === 304) {
    const etag2 = getHeader(revalidated, 'ETag');
    if (etag1 !== etag2) {
      throw new Error(
        `ETag changed during 304 revalidation: "${etag1}" -> "${etag2}"`
      );
    }
    console.log(`ETag stable: ${etag1}`);
  }

Y nghia:
  - Weak ETag (W/...) chap nhan semantic equivalence.
  - Strong ETag ("...") yeu cau byte-by-byte identity.
  - Neu khong co prefix W/ -> strong ETag.
  - ETag phai ON DINH: cung noi dung -> cung ETag.
```

### Variation 4: Multiple Vary dimensions

```text
Muc dich: Kiem tra Vary header chua DAY DU cac dimension
          ma origin thuc su dung.

Thay doi: Assert Vary chua TAT CA cac header ma origin variant hoa.

Vi du script mo rong:
  const vary = getHeader(detail, 'Vary');
  const varyHeaders = vary.split(',').map(h => h.trim());

  const requiredDimensions = [
    'Accept-Language',
    'X-Geo-Country',
    'X-Device-Class',
    'X-Ab-Variant',
    'X-User-Segment',
  ];

  for (const dim of requiredDimensions) {
    if (!varyHeaders.includes(dim)) {
      console.warn(
        `WARNING: Vary missing dimension "${dim}". ` +
        `Requests with different ${dim} may share cache objects.`
      );
    }
  }

  // Nguoc lai: Vary khong nen chua dimension KHONG SU DUNG
  if (varyHeaders.includes('User-Agent')) {
    console.warn(
      `WARNING: Vary includes User-Agent. ` +
      `This will cause excessive cache fragmentation.`
    );
  }

Y nghia:
  - Vary THIEU dimension -> cache leakage.
  - Vary THUA dimension -> cache fragmentation, HIT ratio giam.
  - Vary phai CHINH XAC: chi chua nhung header origin thuc su variant hoa.
```

### Variation 5: Smoke (minimal contract)

```text
Muc dich: Chi kiem tra CAC HEADER TOI THIEU de CDN hoat dong.
          Version rut gon, chay nhanh (1 giay).

Thay doi: Chi assert Cache-Control, ETag, status 200.
          Bo qua Surrogate-Key, Vary, homefeed, categories.

Vi du script:
  export default function () {
    const detail = requestCdn('GET', paths.productDetail, {
      profile: profiles.guestVNMobileControl,
      tags: { case: 'cache_contract_smoke' },
    });

    assertStatus(detail, 200, 'product detail');
    assertHeaderPresent(detail, 'Cache-Control', 'product detail');
    assertHeaderContains(detail, 'Cache-Control', 'public', 'product detail');
    assertHeaderContains(detail, 'Cache-Control', 's-maxage=', 'product detail');
    assertHeaderPresent(detail, 'ETag', 'product detail');

    const etag = getHeader(detail, 'ETag');
    if (!etag) throw new Error('missing ETag');

    const revalidated = requestCdn('GET', paths.productDetail, {
      profile: profiles.guestVNMobileControl,
      headers: {
        'Cache-Control': 'no-cache',
        'If-None-Match': etag,
      },
      tags: { case: 'smoke_revalidate' },
    });
    assertStatus(revalidated, 304, 'revalidation');
  }

Y nghia:
  - CI pipeline: chay nhanh, chi kiem tra contract toi thieu.
  - Neu smoke fail -> khong can chay full test.
  - Full test (22 checks) chay trong staging hoac nightly.
```

---

## 15. Anti-patterns

### Anti-pattern 1: Cache-Control: private tren response public

```text
Sai:
  GET /api/sim/products/1 (public, khong auth)
  Response: Cache-Control: private, max-age=60

Hau qua:
  CDN doc "private" -> KHONG DUOC CACHE.
  Moi request deu MISS -> origin nhan 100% traffic.
  Neu traffic 1000 req/s -> origin can xu ly 1000 req/s.

Cach phat hien:
  Test nay se FAIL: assertHeaderContains(detail, 'Cache-Control', 'public')
  Hoac Cache-Control co "private" -> FAIL.

Fix:
  Doi thanh Cache-Control: public, s-maxage=60, ...
  Private CHI DUNG cho response theo user cu the (auth, profile).
```

### Anti-pattern 2: Surrogate-Key empty hoac missing

```text
Sai:
  GET /api/sim/products/1
  Response: Surrogate-Key: (empty)
  Hoac khong co Surrogate-Key header.

Hau qua:
  Khong the ban-tag invalidate.
  Admin muon xoa product 1 -> phai purge tung URL variant (32 lan).
  Hoac ban prefix -> co the xoa nham product 10, 11, ...

Cach phat hien:
  Test nay se FAIL: assertHeaderPresent(detail, 'Surrogate-Key')

Fix:
  Them Surrogate-Key voi danh sach tag cach nhau boi space:
  Surrogate-Key: product-1 catalog-products segment-guest
```

### Anti-pattern 3: ETag dua tren server timestamp

```text
Sai:
  // Golang handler
  c.Header("ETag", fmt.Sprintf(`"%d-%s"`, time.Now().UnixMilli(), instanceID))

Hau qua:
  Moi request -> ETag khac nhau (vi timestamp thay doi).
  If-None-Match khong bao gio khop -> luon 200 (thay vi 304).
  Revalidation vo dung.

Cach phat hien:
  Test 304 revalidation FAIL (tra 200 thay vi 304).
  console.log ETag 2 request -> khac nhau.

Fix:
  ETag = hash cua response body:
  c.Header("ETag", fmt.Sprintf(`"%x"`, md5.Sum(responseBody)))
  Hoac ETag = content_version + content_updated_at:
  c.Header("ETag", fmt.Sprintf("W/\"%s-%d\"", product.Version, product.UpdatedAt.Unix()))
  Mien la ON DINH cho cung noi dung.
```

### Anti-pattern 4: Vary khai bao User-Agent

```text
Sai:
  GET /api/sim/products/1
  Response: Vary: User-Agent

Hau qua:
  Moi browser type -> cache object rieng.
  Chrome 120, Chrome 121, Firefox 130, Safari 17, Edge, Opera...
  -> 100+ variant cho CUNG 1 product.
  -> HIT ratio GIAM THAM HAI.
  -> Cache storage BIEN THANH "phan manh".

Cach phat hien:
  Vary co chua "User-Agent".
  Neu co check cache fragmentation script -> HIT ratio thap.

Fix:
  Dung X-Device-Class thay vi User-Agent.
  Vary: X-Device-Class (mobile, tablet, desktop) -> chi 3 variant.
  Hoac dung X-Client-Type neu can phan biet native app vs browser.
```

### Anti-pattern 5: Cache-Control directives bi strip boi middleware

```text
Sai:
  Origin handler set Cache-Control dung.
  Nhung middleware/framework security strip bot header.
  Client (qua CDN) nhan response KHONG CO Cache-Control.

Hau qua:
  CDN khong thay Cache-Control -> khong cache (hoac cache sai TTL).
  Kho debug vi handler code DUNG nhung response THIEU.

Cach phat hien:
  Dung --http-debug="full" de xem response headers.
  So sanh response khi goi truc tiep origin (:8080) vs qua CDN (:80).
  Neu origin co Cache-Control nhung CDN response thieu -> middleware strip.

Fix:
  Kiem tra security header middleware (Helmet, CSP).
  Kiem tra reverse proxy strip header config.
  Whitelist Cache-Control, CDN-Cache-Control, ETag, Surrogate-Key, Vary.
```

### Anti-pattern 6: ETag thay doi theo instance

```text
Sai:
  ETag = md5(JSON.stringify(data) + instanceID + serverStartTime)

Hau qua:
  Cung data, khac instance -> ETag khac.
  CDN revalidate den instance 1 -> 200 (vi instance 2 co ETag khac).
  Hoac worse: instance 1 -> 304, instance 2 -> 200 (neu CDN sticky thay doi).
  Revalidation KHONG TIN CAY.

Cach phat hien:
  Goi nhieu request, kiem tra ETag co on dinh khong.
  Neu co nhieu ETag cho cung response -> FAIL.

Fix:
  ETag CHI DUA VAO NOI DUNG:
  ETag = md5(JSON.stringify(responseData))
  Khong them instance-specific data.
  Khong them timestamp (tru khi timestamp la content_version).
```

---

## 16. Real validation data

### Test execution data

```text
Case ID:     cdn-07-cache-contract
Script:      07-cache-contract.js
Profile:     guest VN mobile (product detail)
             returning VN mobile variant-a (homefeed)
             guest US desktop (categories)

Timing:
  Total duration:       ~14s (1 iteration, sequential)
  Request count:        4 (detail, revalidate, homefeed, categories)
  Expected checks pass: 22/22 = 100%

Network:
  detail:      200 OK, body ~4KB, headers ~500B
  revalidate:  304 Not Modified, body 0B, headers ~300B
  homefeed:    200 OK, body ~8KB, headers ~500B
  categories:  200 OK, body ~12KB, headers ~500B

Bandwidth savings (estimated):
  Without 304: 4KB * 1000 req = 4MB origin->CDN per TTL cycle
  With 304:    300B * 1000 req = 300KB origin->CDN per TTL cycle
  Savings:     ~92%

Headers emitted by origin (Go handler):
  applySimpleCDNCacheHeaders(c, ttlSeconds, staleIfErrorSeconds, surrogateKeys...)
  -> Cache-Control: public, max-age=<N>, s-maxage=<N>, stale-if-error=<N>
  -> CDN-Cache-Control: max-age=<N>, stale-if-error=<N>
  -> Surrogate-Key: <tag1> <tag2> ... <tagN>

Go handler source:
  E:/Projects/k6/k6-metrics-server/load-target/handlers/cdn_cached_endpoints.go
  Function: applySimpleCDNCacheHeaders
```

### Expected vs actual (PASS scenario)

```text
+--------------------------------+--------------------------+----------+
| Check                          | Expected                 | Status   |
+--------------------------------+--------------------------+----------+
| detail status                  | 200                      | PASS     |
| detail Cache-Control present   | true (header exists)     | PASS     |
| detail Cache-Control public    | chua "public"            | PASS     |
| detail Cache-Control s-maxage  | chua "s-maxage="         | PASS     |
| detail Cache-Control swr       | chua "stale-while-re..." | PASS     |
| detail Cache-Control sie       | chua "stale-if-error="   | PASS     |
| detail CDN-Cache-Control       | true                     | PASS     |
| detail CDN-Cache max-age       | chua "max-age="          | PASS     |
| detail CDN-Cache swr           | chua "stale-while-re..." | PASS     |
| detail CDN-Cache sie           | chua "stale-if-error="   | PASS     |
| detail ETag                    | true                     | PASS     |
| detail Last-Modified           | true                     | PASS     |
| detail Surrogate-Key           | true                     | PASS     |
| detail Surrogate-Key tag       | chua "product-1"         | PASS     |
| detail Vary                    | true                     | PASS     |
| revalidate status              | 304                      | PASS     |
| homefeed status                | 200                      | PASS     |
| homefeed Surrogate-Key         | chua "catalog-homefeed"  | PASS     |
| homefeed Surrogate-Key segment | chua "segment-returning" | PASS     |
| categories status              | 200                      | PASS     |
| categories Vary Lang           | chua "Accept-Language"   | PASS     |
| categories Vary Geo            | chua "X-Geo-Country"     | PASS     |
+--------------------------------+--------------------------+----------+
All checks: 22/22 PASS (100%)
```

---

## 17. Reference

### File paths

```text
Script:        E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/07-cache-contract.js
Shared:        E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js
Go handler:    E:/Projects/k6/k6-metrics-server/load-target/handlers/cdn_cached_endpoints.go
Run script:    E:/Projects/k6/k6-metrics-server/scripts/run-cdn-capabilities.ps1
Overview:      E:/Khoa hoc/k6/docs/practice/cdn/00_overview.md
Case catalog:  E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/case-catalog.json
Source README: E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md
Run guide:     ./RUN_GUIDE.md
```

### Related cases

```text
01-hit-smoke           -- HIT/MISS behavior (su dung contract headers de cache)
05-invalidation-ops    -- Purge/ban-tag (su dung Surrogate-Key)
08-ttl-expiry          -- TTL expiry (su dung Cache-Control s-maxage)
09-stale-while-error   -- Stale serving (su dung stale-while-revalidate, stale-if-error)
10-request-coalescing  -- Request coalescing (su dung cache key tu Vary)
```

### HTTP spec references

```text
Cache-Control:     RFC 7234, Section 5.2
                   https://httpwg.org/specs/rfc7234.html#header.cache-control

ETag:              RFC 7232, Section 2.3
                   https://httpwg.org/specs/rfc7232.html#header.etag

If-None-Match:     RFC 7232, Section 3.2
                   https://httpwg.org/specs/rfc7232.html#header.if-none-match

304 Not Modified:  RFC 7232, Section 4.1
                   https://httpwg.org/specs/rfc7232.html#status.304

Vary:              RFC 7231, Section 7.1.4
                   https://httpwg.org/specs/rfc7231.html#header.vary

CDN-Cache-Control: RFC 9213 (Targeted HTTP Cache Control)
                   https://www.rfc-editor.org/rfc/rfc9213.html

Surrogate-Key:     Fastly/Varnish convention (khong co RFC chinh thuc)
                   https://docs.varnish-software.com/varnish-cache-plus/vmods/xkey/
```

### Varnish references

```text
VCL built-in:      https://github.com/varnishcache/varnish-cache/blob/master/bin/varnishd/builtin.vcl
XKey VMOD:         https://docs.varnish-software.com/varnish-cache-plus/vmods/xkey/
Cache-Control VCL: set beresp.ttl, set beresp.grace, set beresp.keep
```
