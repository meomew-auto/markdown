# Case 02: Variant cache keys -- Cach ly noi dung theo tung phan khuc nguoi dung

> **Case ID:** `cdn-02-variant-keys`
> **Script:** `02-variant-keys.js`
> **Layer:** CDN / Varnish
> **Proof:** Language/geo/device/AB/segment khong bi leak variant -- cach ly tiet dinh giua cac phan khuc nguoi dung

## 1. Tinh huong thuc te

### E-commerce phuc vu noi dung khac nhau theo phan khuc thi truong

Mot san thuong mai dien tu (e-commerce) phuc vu nhieu phan khuc nguoi dung khac nhau
cung luc. Cung mot URL `/api/sim/products/1` (chi tiet san pham), nhung noi dung
tra ve thay doi theo:

```text
Nguoi dung Viet Nam, mobile, tieng Viet:
  -> Ten san pham tieng Viet, gia hien thi VND, UI toi uu cho mobile

Nguoi dung My, desktop, tieng Anh:
  -> Ten san pham tieng Anh, gia hien thi USD, UI desktop day du

Nguoi dung Viet Nam, mobile, tham gia AB test variant-a:
  -> Giao dien variant A (co the la layout moi, mau moi, CTAs moi)

Nguoi dung quay lai (returning), da mua hang truoc:
  -> Homefeed ca nhan hoa: goi y san pham dua tren lich su mua hang
```

Moi to hop (language + geo + device + AB + segment) tao ra mot **variant** rieng biet.
Variant nay la ket qua kinh doanh that su -- khong phai chi la "ky thuat cache".

### Tai sao variant isolation la van de dung dan (correctness), khong phai hieu nang

```text
Dung dan (correctness):
  - Khach hang VN mobile xem san pham -> PHAI thay gia VND
  - Khach hang US desktop xem CUNG san pham -> PHAI thay gia USD
  - Neu CDN tra nham: khach VN thay gia USD -> mat long tin, roi bo gio hang
  - Neu CDN tra nham: khach US thay gia VND -> nghi day la scam site

Hieu nang (performance):
  - HIT ratio 99% la vo nghia neu 99% do sai audience
  - "Cache nhanh" khong phai la "cache dung"
  - Mot HIT cho sai audience la LOI NGHIEM TRONG, khong phai la performance win
```

### Hinh dung he thong that

```text
               +---------+
Client VN -----|         |          +----------+
  mobile       |         |--------->| Products |--- DB (gia VND, tieng Viet)
               | Varnish |          | Service  |
Client US -----|  CDN    |          +----------+
  desktop      |         |
               |         |          +----------+
Client VN -----|         |--------->| Cart     |--- DB (cart data)
  variant-a    +---------+          | Service  |
                                    +----------+
```

Cung mot request `GET /api/sim/products/1` den Varnish, nhung:

- `Accept-Language: vi` + `X-Geo-Country: VN` + `X-Device-Class: mobile` -> variant A
- `Accept-Language: en` + `X-Geo-Country: US` + `X-Device-Class: desktop` -> variant B
- Hai variant PHAI la hai cache object doc lap trong Varnish

### Vi du cu the ve hậu qua neu variant bi leak

```text
Tinh huong that: 9h sang, CDN da cache san pham #1 cho nguoi dung VN mobile.

  9:00:00 - User VN mobile request GET /api/sim/products/1
            -> Varnish MISS -> origin tra ve gia 500,000 VND, ten tieng Viet
            -> Varnish cache lai object nay

  9:00:05 - User US desktop request GET /api/sim/products/1
            -> Varnish HIT (SAI!) -> tra ve gia 500,000 VND cho user My
            -> User My thay "500,000" nghi la $500,000 -> hoang so -> roi di
            -> Mat sale, mat khach hang

  NGUYEN NHAN: Varnish khong dua X-Geo-Country va X-Device-Class vao cache key
  -> Chi cache theo URL -> variant VN mobile bi leak sang US desktop
```

### Cau hoi kinh doanh

```text
"Khi CDN cache noi dung cho mot phan khuc nguoi dung (vi du: VN mobile),
 no co bao dam rang phan khuc KHAC (US desktop) khong bao gio nhan duoc
 noi dung do khong?"

Day la cau hoi VE SU DUNG DAN. Khong phai ve HIT ratio.
Khong phai ve latency.
Khong phai ve throughput.

Day la: "CDN co phan biet duoc cac phan khuc nguoi dung khac nhau khong?"
```

### Vi sao day la mot lop CDN problem, khong phai application problem

```text
Nhieu team nghi rang: "Application tra dung noi dung -> CDN chi can cache lai."
Day la su nham lan giua DATA ORIGIN va CACHE LAYER.

Application tra DUNG noi dung cho tung audience:
  - Request: Accept-Language=vi, X-Geo-Country=VN -> application tra tieng Viet, gia VND
  - Request: Accept-Language=en, X-Geo-Country=US -> application tra tieng Anh, gia USD
  -> Application DUNG

CDN cache lai:
  - Neu CDN chi cache theo URL (thieu variant headers):
    + Lan 1: user VN -> MISS -> origin tra tieng Viet -> CDN cache
    + Lan 2: user US -> HIT (SAI!) -> nhan duoc tieng Viet
    -> CDN SAI

  - Application KHONG CO LOI trong tinh huong nay
  - Application da tra dung cho tung request
  - CDN da "rut gon" hai request khac nhau thanh mot cache object

-> Day la CDN LAYER PROBLEM.
-> Application co the test pass 100% nhung CDN van sai.
-> Can test CDN layer RIENG de phat hien.
```

### Truong hop that su da xay ra (war story)

```text
Nam 2023, mot e-commerce platform gap su co:

  - Ho trien khai CDN cho product detail API
  - Cache key chi gom: url + host
  - Application tra dung noi dung theo Accept-Language va X-Geo-Country
  - Sau 2 ngay: bao cao tu CS cho biet "user US thay gia VND"
  - Investigation:
    + User VN browser -> CDN MISS -> cache object tieng Viet, gia VND
    + User US browser -> CDN HIT -> serve SAME object -> sai audience
    + Application logs: khong co user US nao request -> CDN da serve tu cache
    + CDN HTTP logs: user US request co X-Cache=HIT -> confirmed
  - Root cause: VCL hash thieu Accept-Language va X-Geo-Country
  - Fix: them 2 dimensions vao vcl_hash -> problem resolved
  - Bai hoc: Application DUNG nhung CDN SAI -> monitoring chi thay 200 OK

-> Day LA LY DO case nay ton tai.
   Khong phai de test application.
   Khong phai de test latency.
   La de test CDN CACHE KEY DUNG.
```

### Cac kich ban variant leakage thuong gap

```text
Kich ban 1: SAI LANGUAGE
  - User A (vi) request -> MISS -> cache object "vi"
  - User B (en) request -> HIT (SAI) -> nhan object "vi"
  - Dau hieu: user thay ngon ngu sai

Kich ban 2: SAI GEO
  - User VN request -> MISS -> cache object VN (gia VND)
  - User US request -> HIT (SAI) -> nhan object VN
  - Dau hieu: user thay gia te (currency sai)
               hoac gia re bat thuong (user VN sang US)

Kich ban 3: SAI DEVICE
  - Mobile user request -> MISS -> cache object mobile layout
  - Desktop user request -> HIT (SAI) -> nhan mobile layout
  - Dau hieu: UI bi co, nut bam lech, trai nghiem te

Kich ban 4: SAI AB
  - Control group request -> MISS -> cache object control
  - Variant-a group request -> HIT (SAI) -> nhan control
  - Dau hieu: AB test bi "contaminated" -> ket qua AB test SAI
               -> quyet dinh kinh doanh dua tren du lieu sai

Kich ban 5: SAI SEGMENT
  - Guest request homefeed -> MISS -> cache object guest
  - Returning user request homefeed -> HIT (SAI) -> nhan guest content
  - Dau hieu: returning user khong thay personalized recommendations
               -> mat co hoi cross-sell/up-sell
```

## 2. CDN capability being proven

### 5 chieu variant doc lap trong cache key

CDN dang duoc chung minh co kha nang **cach ly variant** (variant isolation) tren
5 chieu doc lap:

```text
Chieu thu 1: LANGUAGE   (Accept-Language header)
Chieu thu 2: GEO        (X-Geo-Country header)
Chieu thu 3: DEVICE     (X-Device-Class header)
Chieu thu 4: AB         (X-Ab-Variant header)
Chieu thu 5: SEGMENT    (X-User-Segment header)
```

Cung URL + khac header = khac cache object. Moi variant co mot **slot cache doc lap**
voi vong doi MISS -> HIT rieng.

### Dieu gi dang duoc chung minh

```text
(a) SAME PROFILE -> SAME CACHE KEY -> HIT
    profile A -> MISS -> profile A -> HIT
    Cung profile request 2 lan lien tiep -> lan 2 phai la HIT

(b) DIFFERENT PROFILE -> DIFFERENT CACHE KEY -> MISS
    profile A -> MISS -> profile A -> HIT
    profile B -> MISS (KHONG duoc HIT tu A!)
    profile B -> HIT (sau khi da MISS)

(c) CROSS-VARIANT ISOLATION
    Sau khi warm ca A va B:
    - A van HIT (khong bi B ghi de)
    - B van HIT (khong bi A ghi de)
    - A khong bao gio thay noi dung cua B
```

### Tai sao day khong phai la "kiem tra HIT ratio"

```text
SAI: "Case nay kiem tra xem cache co hoat dong khong"
DUNG: "Case nay kiem tra xem cache co LAM DUNG khong"

HIT ratio cao la tot nhung:
  - HIT ratio 100% nhung variant bi leak -> THAM HOA
  - HIT ratio 0% nhung variant dung -> it nhat khong sai

Day la CORRECTNESS PROOF, khong phai PERFORMANCE BENCHMARK.
```

### Muc tieu ky thuat cua case

```text
Case nay tra loi 3 cau hoi ky thuat:

1. VCL hash CO bao gom TAT CA cac variant dimension can thiet khong?
   -> Moi dimension thay doi PHAI tao ra cache key khac
   -> Bang chung: variant_first = MISS

2. VCL normalization CO DUNG khong?
   -> "vi-VN;q=0.9" normalize thanh "vi"
   -> "VIETNAM" normalize thanh "VN" (fallback to default)
   -> "CellPhone" normalize thanh "desktop" (fallback to default)
   -> Bang chung: X-Cache-Key-* headers khop expected

3. Variant isolation CO TOAN DIEN khong?
   -> Tat ca 5 chieu deu duoc test doc lap
   -> Duong dan khac nhau (detail vs homefeed) co tap dimension khac nhau
   -> Bang chung: 5 test pairs deu pass MISS/HIT sequence
```

### Cach tiep can test: doc lap tung chieu mot

```text
TAI SAO KHONG TEST TAT CA CHIEU CUNG LUC?

Neu test A (vi/VN/mobile/control) vs B (en/US/desktop/variant-b) cung luc:
  -> Neu fail: KHONG BIET dimension nao gay ra
  -> Phai test lai tung chieu mot deolates root cause

Thay vao do, test TUNG CHIEU MOT:
  A (vi/VN/mobile/control) vs B (en/VN/mobile/control) -> chi khac LANGUAGE
  A (vi/VN/mobile/control) vs C (vi/US/mobile/control) -> chi khac GEO
  A (vi/VN/mobile/control) vs D (vi/VN/desktop/control) -> chi khac DEVICE
  A (vi/VN/mobile/control) vs E (vi/VN/mobile/variant-a) -> chi khac AB
  E (vi/VN/mobile/variant-a) vs F (vi/VN/mobile/variant-a) (returning) -> chi khac SEGMENT

-> Moi test pair CHI THAY DOI MOT CHIEU -> RO RANG root cause neu fail
-> Day la PHUONG PHAP KHOA HOC: isolate variable, test independently
```

### Hieu dung ve "cache slot"

```text
Mot "cache slot" la khong gian luu tru cho 1 cache key trong Varnish.

Vi du: /api/sim/products/1 voi 108 variant combinations co the:
  -> 108 cache slots (neu tat ca deu duoc request)
  -> Moi slot doc lap, co TTL rieng, co the bi evict rieng
  -> Slot A (vi/VN/mobile/control) KHONG lien quan gi den slot B (en/VN/mobile/control)

Khi ban-url duoc goi:
  -> Xoa TAT CA cac slot cho URL do (khong phan biet variant)
  -> Day la precondition de bat dau test tu trang thai sach

Khi slot A MISS -> fetch tu origin -> object duoc luu vao slot A
  -> Slot B khong bi anh huong (van MISS neu duoc request)
  -> Slot C khong bi anh huong
```

## 3. Vi sao test o CDN layer

### Application co the sai, CDN co the sai, status 200 khong bao gio noi len su that

```text
CA HAI LOP DEU CO THE GAY RA VARIANT LEAKAGE:

Application layer:
  - Header parsing bug: app doc sai Accept-Language -> tra sai noi dung
  - Business logic bug: app khong phan biet geo -> tra gia sai currency
  - Fail silent: tra 200 OK nhung sai audience

CDN layer:
  - Cache key misconfiguration: VCL thieu mot variant header trong vcl_hash
  - Normalization bug: "VIETNAM" khong duoc normalize -> khong match voi "VN"
  - Fail silent: HIT object sai audience, tra 200 OK

CA HAI FAILURE MODE DEU:
  -> HTTP 200 OK (monitoring chi thay "green")
  -> Response body day du, JSON valid (schema validation pass)
  -> Khong co error log, khong co exception
  -> NGUY HIEM: monitoring thong thuong KHONG the phat hien
```

### Tai sao khong the trust status code

```text
Monitoring truyen thong:
  - Health check: GET /health -> 200 -> green
  - Synthetic check: GET /api/sim/products/1 -> 200 -> green
  -> Nhung khong ai kiem tra "noi dung tra ve co dung cho audience nay khong?"

CDN layer test:
  - KHONG CHI check status 200
  - CON check cache-key headers -> dam bao variant dung
  - CON check MISS/HIT sequence -> dam bao khong leak
  - CON cross-reference expectation (expectedCacheKey) vs actual (headers)
```

### Tai sao phai test RIEENG CDN layer

```text
Neu chi test application: khong phat hien duoc VCL misconfiguration
Neu chi test CDN voi synthetic: khong phat hien duoc variant leakage
Neu chi dung status code monitoring: khong phat hien duoc CA HAI

-> Can test CDN layer RIENG VOI VARIANT HEADERS CO CHU DICH
-> Tao cac profile khac nhau, verify cache-key headers cho TUNG profile
-> Verify MISS/HIT sequence cho TUNG CAP variant
```

## 4. Topology & precondition

### Runtime path

```text
Public path:   http://localhost:80 -> Varnish -> Nginx -> app/products-service
Control path:  http://localhost:8088 -- ban-url setup
Event path:    http://localhost:9091 -- khong dung trong case nay
```

### Precondition

```text
1. TargetLayer = full
2. Varnish dang chay, backend healthy (xac nhan qua /health)
3. OPS_AUTH_TOKEN da duoc set (can cho ban-url)
4. Script chay single-VU: VUs=1 de bao dam deterministic MISS/HIT sequence
5. Khong co concurrency -- concurrency lam blur thu tu MISS -> HIT
6. Tat ca test path duoc ban-url TRUOC khi test variant pair
7. Profile headers duoc gan DUNG voi expectedCacheKey trong shared.js
```

### Vi sao single-VU

```text
Sequence can duoc deterministic:
  ban-url -> profile A (MISS) -> profile A (HIT)
         -> profile B (MISS) -> profile B (HIT)

Neu 2 VU cung chay:
  VU-1: profile A -> MISS (dang write vao cache)
  VU-2: profile A -> co the MISS hoac HIT (tuy timing)
  -> Khong deterministic -> khong the assertion

Single-VU dam bao: moi request chay TUAN TU, cache state CO THE DU DOAN.
```

### Cac profile duoc test

```text
Profile                  Language  Geo  Device   AB          Segment
guestVNMobileControl     vi        VN   mobile   control     guest
guestVNMobileEnglish     en        VN   mobile   control     guest
guestUSMobileControl     vi        US   mobile   control     guest
guestVNDesktopControl    vi        VN   desktop  control     guest
guestVNMobileVariantA    vi        VN   mobile   variant-a   guest
returningVNMobileVariantA vi       VN   mobile   variant-a   returning
```

Moi cap profile khac nhau DUNG 1 CHIEU -- cac chieu con lai giu nguyen.
Dieu nay cho phep chung minh isolation THEO TUNG CHIEU MOT.

## 5. Script deep-dive

### Cau truc tong the

Script `02-variant-keys.js` co 2 phan chinh:

```text
1. Ham exerciseVariant(path, label, baseProfile, variantProfile, options)
   -> Thuc hien day du chung minh isolation cho 1 cap variant

2. Ham default (main)
   -> Goi exerciseVariant 5 lan, moi lan test 1 chieu variant
```

### Ham exerciseVariant -- chung minh isolation cho 1 cap

```javascript
function exerciseVariant(path, label, baseProfile, variantProfile, options = {}) {
  // Buoc 0: Xoa cache cho path de bat dau tu trang thai sach
  banUrl(path);

  // Buoc 1: Tinh expected cache key cho ca 2 profile
  const baseExpected = expectedCacheKey(baseProfile);
  const variantExpected = expectedCacheKey(variantProfile);

  // Buoc 2: Request base profile lan 1 -> PHAI LA MISS
  const baseFirst = requestCdn('GET', path, {
    profile: baseProfile,
    tags: { case: `${label}_base_first` },
  });
  assertStatus(baseFirst, 200, `${label} base first`);
  assertUpstream(baseFirst, 'products-service', `${label} base first`);
  assertCacheState(baseFirst, 'MISS', `${label} base first`);
  assertCacheKeyHeaders(baseFirst, baseExpected, `${label} base first`, options);

  // Buoc 3: Request base profile lan 2 -> PHAI LA HIT
  const baseSecond = requestCdn('GET', path, {
    profile: baseProfile,
    tags: { case: `${label}_base_second` },
  });
  assertStatus(baseSecond, 200, `${label} base second`);
  assertCacheState(baseSecond, 'HIT', `${label} base second`);
  assertCacheKeyHeaders(baseSecond, baseExpected, `${label} base second`, options);

  // Buoc 4: Request variant profile lan 1 -> PHAI LA MISS (KHONG duoc HIT tu base)
  const variantFirst = requestCdn('GET', path, {
    profile: variantProfile,
    tags: { case: `${label}_variant_first` },
  });
  assertStatus(variantFirst, 200, `${label} variant first`);
  assertUpstream(variantFirst, 'products-service', `${label} variant first`);
  assertCacheState(variantFirst, 'MISS', `${label} variant first`);
  assertCacheKeyHeaders(variantFirst, variantExpected, `${label} variant first`, options);

  // Buoc 5: Request variant profile lan 2 -> PHAI LA HIT
  const variantSecond = requestCdn('GET', path, {
    profile: variantProfile,
    tags: { case: `${label}_variant_second` },
  });
  assertStatus(variantSecond, 200, `${label} variant second`);
  assertCacheState(variantSecond, 'HIT', `${label} variant second`);
  assertCacheKeyHeaders(variantSecond, variantExpected, `${label} variant second`, options);
}
```

### Chuoi assertion cho MOI request

Moi request (4 request / cap variant) deu bi kiem tra:

```text
1. assertStatus           -> HTTP 200 (server tra loi thanh cong)
2. assertUpstream         -> upstream la 'products-service' (dung service xu ly)
3. assertCacheState       -> MISS hoac HIT (dung theo sequence)
4. assertCacheKeyHeaders  -> 5 X-Cache-Key-* headers khop expected
```

### 5 variant pairs duoc test trong default function

```javascript
export default function () {
  // (a) LANGUAGE:  vi vs en tren cung VN mobile control guest
  exerciseVariant(paths.productDetail, 'language',
    profiles.guestVNMobileControl, profiles.guestVNMobileEnglish);

  // (b) GEO:       VN vs US tren cung vi mobile control guest
  exerciseVariant(paths.productDetail, 'geo',
    profiles.guestVNMobileControl, profiles.guestUSMobileControl);

  // (c) DEVICE:    mobile vs desktop tren cung vi VN control guest
  exerciseVariant(paths.productDetail, 'device',
    profiles.guestVNMobileControl, profiles.guestVNDesktopControl);

  // (d) AB:        control vs variant-a tren cung vi VN mobile guest
  exerciseVariant(paths.productDetail, 'ab_variant',
    profiles.guestVNMobileControl, profiles.guestVNMobileVariantA);

  // (e) SEGMENT:   guest vs returning tren cung vi VN mobile variant-a
  //     NOTE: chi test tren path homefeed (vi segment chi nam trong
  //     cache key cua homefeed, khong co trong product detail)
  exerciseVariant(paths.homefeed, 'segment',
    profiles.guestVNMobileVariantA, profiles.returningVNMobileVariantA,
    { withSegment: true });
}
```

### Vi sao segment chi test tren homefeed path

```text
Trong VCL vcl_hash:

  /api/sim/products/:id -> hash language + geo + device + AB
                           (KHONG hash segment)

  /api/sim/products/homefeed -> hash language + geo + device + AB + SEGMENT

  /api/sim/products/categories -> hash language + geo
                                  (KHONG hash device, AB, segment)

-> Moi path co mot tap variant dimension KHAC NHAU trong cache key
-> Phai chon path phu hop voi dimension dang test
-> Segment chi co y nghia cache key tren homefeed
```

### Tags de trace back

Moi request duoc gan tags co cau truc:

```text
{ case: 'language_base_first' }     -> base profile, lan 1, language test
{ case: 'language_variant_first' }  -> variant profile, lan 1, language test
{ case: 'geo_base_second' }         -> base profile, lan 2, geo test
{ case: 'segment_variant_second' }  -> variant profile, lan 2, segment test
...
```

Tags cho phep filter theo tung variant pair trong dashboard va summary.

### Iterations tinh toan

```text
Moi exerciseVariant goi 4 request (base_first + base_second + variant_first + variant_second)
5 variant pairs x 4 requests = 20 requests cho 1 vong lap

VARIANT_KEYS_ITERATIONS = 24 (mac dinh)
-> 24 x 5 x 4 = 480 requests total (neu iterations = 24)
   Nhung thuc te: 24 nghia la 24 VONG duyet qua default function
   Moi vong = 5 pairs x 4 requests = 20 requests
   Total: 24 x 20 = 480 requests
```

## 6. Cache key model deep-dive

### STAR SECTION -- Day la troi tim cua case nay

Cache key la **identity cua mot object trong CDN**. Neu 2 request co cung cache key,
chung se nhan cung object tu cache. Neu khac cache key, chung la 2 object doc lap.

### VCL hash construction (tu default.vcl)

```text
sub vcl_hash {
    hash_data(req.url);                          // (1) URL (da normalize query params)
    if (req.http.host) {
        hash_data(req.http.host);                // (2) Host header
    }

    if (req.url ~ "^/api/sim/products/categories") {
        hash_data(req.http.X-Cache-Language);    // (3a) Chi language + geo
        hash_data(req.http.X-Cache-Geo-Country);
    }
    elseif (req.url ~ "^/api/sim/products/homefeed") {
        hash_data(req.http.X-Cache-Language);    // (3b) Language + geo + device + AB + SEGMENT
        hash_data(req.http.X-Cache-Geo-Country);
        hash_data(req.http.X-Cache-Device-Class);
        hash_data(req.http.X-Cache-AB-Variant);
        hash_data(req.http.X-Cache-User-Segment);
    }
    elseif (req.url ~ "^/api/sim/products($|/|\\?)") {
        hash_data(req.http.X-Cache-Language);    // (3c) Language + geo + device + AB (KHONG segment)
        hash_data(req.http.X-Cache-Geo-Country);
        hash_data(req.http.X-Cache-Device-Class);
        hash_data(req.http.X-Cache-AB-Variant);
    }
}
```

### Mo hinh khai niem

```text
Cache key = req.url + "|" + host + "|" + [dimensions theo path]

Vi du /api/sim/products/1:
  Cache key = "/api/sim/products/1|localhost|vi|VN|mobile|control"

Vi du /api/sim/products/homefeed:
  Cache key = "/api/sim/products/homefeed|localhost|vi|VN|mobile|variant-a|guest"

Vi du /api/sim/products/categories:
  Cache key = "/api/sim/products/categories|localhost|vi|VN"
```

### Dimension 1: LANGUAGE -- Accept-Language header

```text
VCL normalization (sub normalize_cache_variants):

  if (req.http.Accept-Language) {
    // Trich xuat 2 ky tu dau tien cua Accept-Language
    // "vi-VN;q=0.9, en;q=0.8" -> trich ra "vi" -> lowercase -> "vi"
    set req.http.X-Cache-Language = std.tolower(
      regsub(req.http.Accept-Language, "^\\s*([A-Za-z]{2}).*$", "\1")
    );
  } else {
    set req.http.X-Cache-Language = "en";  // default
  }

  // Validate: chi chap nhan vi, en, ja
  if (req.http.X-Cache-Language !~ "^(vi|en|ja)$") {
    set req.http.X-Cache-Language = "en";  // fallback to en
  }

Normalization rules:
  INPUT                    -> X-Cache-Language (gia tri cache key)
  "vi-VN;q=0.9,en;q=0.8"  -> "vi"
  "en-US,en;q=0.9"         -> "en"
  "ja;q=0.8"               -> "ja"
  "fr-FR,fr;q=0.8"         -> "en"  (fallback: fr khong nam trong whitelist)
  (absent)                 -> "en"  (default)
  "VI"                     -> "vi"  (lowercase)

Shared.js expectedCacheKey:
  language = ((headers['Accept-Language'] || 'en').trim().slice(0, 2).toLowerCase() || 'en');
  // Validate: chi ['vi', 'en', 'ja']; fallback = 'en'
```

### Dimension 2: GEO -- X-Geo-Country header

```text
VCL normalization:

  if (req.http.X-Geo-Country ~ "^(?i:SG)$") {
    set req.http.X-Cache-Geo-Country = "SG";
  } elseif (req.http.X-Geo-Country ~ "^(?i:US)$") {
    set req.http.X-Cache-Geo-Country = "US";
  } elseif (req.http.X-Geo-Country ~ "^(?i:JP)$") {
    set req.http.X-Cache-Geo-Country = "JP";
  } else {
    set req.http.X-Cache-Geo-Country = "VN";  // default
  }

Normalization rules:
  INPUT        -> X-Cache-Geo-Country
  "VN"         -> "VN"
  "vn"         -> "VN"  (uppercase)
  "US"         -> "US"
  "us"         -> "US"
  "SG"         -> "SG"
  "JP"         -> "JP"
  "FR"         -> "VN"  (default: khong nam trong whitelist)
  "VIETNAM"    -> "VN"  (default: khong match policy)
  (absent)     -> "VN"  (default)

Shared.js normalizeGeo:
  - Trim + uppercase
  - Whitelist: SG, US, JP -> giu nguyen
  - Con lai -> "VN" (default country)
```

### Dimension 3: DEVICE -- X-Device-Class header

```text
VCL normalization:

  if (req.http.X-Device-Class ~ "^(?i:mobile)$") {
    set req.http.X-Cache-Device-Class = "mobile";
  } elseif (req.http.X-Device-Class ~ "^(?i:tablet)$") {
    set req.http.X-Cache-Device-Class = "tablet";
  } elseif (req.http.X-Device-Class ~ "^(?i:desktop)$") {
    set req.http.X-Cache-Device-Class = "desktop";
  } elseif (req.http.User-Agent ~ "(?i)(ipad|tablet)") {
    set req.http.X-Cache-Device-Class = "tablet";   // detect tu UA
  } elseif (req.http.User-Agent ~ "(?i)(mobile|iphone|android)") {
    set req.http.X-Cache-Device-Class = "mobile";   // detect tu UA
  } else {
    set req.http.X-Cache-Device-Class = "desktop";  // default
  }

Normalization rules:
  INPUT        -> X-Cache-Device-Class
  "mobile"     -> "mobile"
  "MOBILE"     -> "mobile"   (lowercase)
  "desktop"    -> "desktop"
  "tablet"     -> "tablet"
  "cellphone"  -> "desktop"  (default: khong nam trong whitelist)
  (absent)     -> "desktop"  (default) HOAC detect tu User-Agent

  USER-AGENT FALLBACK (khi khong co X-Device-Class):
  UA chua "ipad|tablet"         -> "tablet"
  UA chua "mobile|iphone|android" -> "mobile"
  Con lai                        -> "desktop"

Shared.js normalizeDevice:
  - Trim + lowercase
  - Whitelist: mobile, tablet, desktop -> giu nguyen
  - Con lai -> "desktop"
```

### Dimension 4: AB -- X-Ab-Variant header

```text
VCL normalization:

  if (req.http.X-Ab-Variant ~ "^(?i:variant-a)$") {
    set req.http.X-Cache-AB-Variant = "variant-a";
  } elseif (req.http.X-Ab-Variant ~ "^(?i:variant-b)$") {
    set req.http.X-Cache-AB-Variant = "variant-b";
  } else {
    set req.http.X-Cache-AB-Variant = "control";  // default
  }

Normalization rules:
  INPUT            -> X-Cache-AB-Variant
  "variant-a"      -> "variant-a"
  "Variant-A"      -> "variant-a"  (lowercase)
  "variant-b"      -> "variant-b"
  "control"        -> "control"
  "experiment-xyz" -> "control"    (default: khong nam trong whitelist)
  (absent)         -> "control"    (default)

Shared.js normalizeAB:
  - Trim + lowercase
  - Whitelist: variant-a, variant-b -> giu nguyen
  - Con lai -> "control"
```

### Dimension 5: SEGMENT -- X-User-Segment header

```text
VCL normalization:

  if (req.http.X-User-Segment ~ "^(?i:new_user)$") {
    set req.http.X-Cache-User-Segment = "new_user";
  } elseif (req.http.X-User-Segment ~ "^(?i:returning)$") {
    set req.http.X-Cache-User-Segment = "returning";
  } elseif (req.http.X-User-Segment ~ "^(?i:vip)$") {
    set req.http.X-Cache-User-Segment = "vip";
  } else {
    set req.http.X-Cache-User-Segment = "guest";  // default
  }

Normalization rules:
  INPUT          -> X-Cache-User-Segment
  "guest"        -> "guest"
  "GUEST"        -> "guest"     (lowercase)
  "new_user"     -> "new_user"
  "returning"    -> "returning"
  "vip"          -> "vip"
  "premium"      -> "guest"     (default: khong nam trong whitelist)
  (absent)       -> "guest"     (default)

Shared.js normalizeSegment:
  - Trim + lowercase
  - Whitelist: new_user, returning, vip -> giu nguyen
  - Con lai -> "guest"
```

### Dimension nao ALWAYS trong key, dimension nao CONDITIONAL

```text
CONDITIONAL DIMENSIONS -- chi co mat trong cache key neu path PHAI CO:

Path                              Dimensions in cache key
/api/sim/products                 url + host + language + geo + device + AB
/api/sim/products/:id             url + host + language + geo + device + AB
/api/sim/products/search          url + host + language + geo + device + AB
/api/sim/products/:id/recommendations url + host + language + geo + device + AB
/api/sim/products/categories      url + host + language + geo          (KHONG device, AB, segment)
/api/sim/products/homefeed        url + host + language + geo + device + AB + SEGMENT
/api/cached                       url + host                           (KHONG variant headers)

ALWAYS:
  - req.url (da query-sort va strip tracking params)
  - req.http.host

CONDITIONAL:
  - language: luon co trong /api/sim/products/*
  - geo: luon co trong /api/sim/products/*
  - device: co trong products, detail, search, recommendations, homefeed; KHONG co trong categories
  - AB: co trong products, detail, search, recommendations, homefeed; KHONG co trong categories
  - segment: CHI co trong homefeed
```

### X-Cache-Key-* response headers nhu verification

```text
VCL vcl_deliver echo lai normalized values nhu response headers:

  sub vcl_deliver {
    if (req.url ~ "^/api/sim/products($|/|\\?)") {
      set resp.http.X-Cache-Key-Language = req.http.X-Cache-Language;
      set resp.http.X-Cache-Key-Geo = req.http.X-Cache-Geo-Country;
      if (req.url !~ "^/api/sim/products/categories($|\\?)") {
        set resp.http.X-Cache-Key-Device = req.http.X-Cache-Device-Class;
        set resp.http.X-Cache-Key-AB = req.http.X-Cache-AB-Variant;
      }
      if (req.url ~ "^/api/sim/products/homefeed($|\\?)") {
        set resp.http.X-Cache-Key-Segment = req.http.X-Cache-User-Segment;
      }
    }
  }

Cac header nay cho phep k6 script VERIFY:
  - CDN da normalize header dung chua?
  - Cache key duoc tinh toan dung voi expected?
  - KHONG CAN inspect internal Varnish state
```

### Edge case: header absent -- default values

```text
Khi header KHONG duoc gui, VCL se dung default:

  Accept-Language absent:
    -> X-Cache-Language = "en"
    -> Day la "tieng Anh la ngon ngu mac dinh"

  X-Geo-Country absent:
    -> X-Cache-Geo-Country = "VN"
    -> Day la "Viet Nam la quoc gia mac dinh"

  X-Device-Class absent:
    -> Detect tu User-Agent neu co the
    -> Cuoi cung default "desktop"

  X-Ab-Variant absent:
    -> X-Cache-AB-Variant = "control"
    -> "Khong tham gia AB test = nhom control"

  X-User-Segment absent:
    -> X-Cache-User-Segment = "guest"
    -> "Khong xac dinh duoc segment = guest"

Default values CO CHU DICH:
  - Dam bao cache key LUON CO GIA TRI (khong bao gio undefined)
  - Dam bao fallback an toan (default audience)
  - Tranh cache key thay doi giua cac request thieu header
```

### Edge case: User-Agent fallback cho device detection

```text
Khi X-Device-Class absent nhung User-Agent co mat:

  VCL device detection tu User-Agent:
    UA chua "ipad" hoac "tablet"        -> "tablet"
    UA chua "mobile", "iphone", "android" -> "mobile"
    Con lai                               -> "desktop"

  Luu y: DAY LA LOP DETECTION BO SUNG
  - Khong thay the cho X-Device-Class
  - Chi dung lam fallback
  - X-Device-Class (neu co) LUON duoc uu tien
  - User-Agent detection co the sai (user agent spoofing)
  - Trong production: X-Device-Class nen duoc set boi CDN/app dua tren
    phan tich User-Agent that su, khong phai VCL

  Vi du:
    Request: User-Agent chua "iPhone" -> "mobile" (dung)
    Request: User-Agent chua "Mozilla/5.0" -> "desktop" (mac dinh)
    Request: X-Device-Class=tablet + User-Agent chua iPhone -> "tablet" (uu tien header)
```

### Edge case: header co nhieu gia tri (Accept-Language)

```text
Accept-Language co the chua nhieu ngon ngu voi quality values:

  "vi-VN,vi;q=0.9,en;q=0.8,ja;q=0.5"
  -> VCL regex: ^\s*([A-Za-z]{2}).*$
  -> Trich xuat: "vi" (2 ky tu dau tien)
  -> Quality values bi bo qua
  -> Chi quan tam den PRIMARY language (uu tien cao nhat)

  "en-US,en;q=0.9"
  -> Trich xuat: "en"

  "fr-FR,fr;q=0.8,en;q=0.5"
  -> Trich xuat: "fr"
  -> Sau validate: "fr" khong trong whitelist -> "en"
  -> Nguoi dung Phap nhan duoc noi dung tieng Anh
  -> Co the DUNG hoac KHONG DUNG tuy vao business requirement
  -> Neu can ho tro tieng Phap -> them "fr" vao whitelist
```

### Tai sao whitelist quan trong

```text
WHITELIST HUU HAN GIA TRI:

  Language: chi "vi", "en", "ja" -> 3 values
  Geo: chi "VN", "US", "SG", "JP" -> 4 values
  Device: chi "mobile", "tablet", "desktop" -> 3 values
  AB: chi "control", "variant-a", "variant-b" -> 3 values
  Segment: chi "guest", "new_user", "returning", "vip" -> 4 values

LY DO:
  1. Tranh cardinality explosion: neu cho phep BAT KY gia tri nao
     -> so luong cache objects khong the kiem soat
  2. Tranh cache poisoning: attacker gui header gia tri doc
     -> tao ra cache objects doc, day cache objects hop le
  3. Tranh fragmentation: "vietnam", "Viet Nam", "vn", "VN", "VIETNAM"
     -> tat ca nên map ve 1 gia tri duy nhat
  4. Dam bao predictability: expectedCacheKey CO THE predict duoc
     -> assertion co the kiem tra DUNG

NEU can them gia tri moi:
  1. Them vao VCL whitelist
  2. Them vao shared.js normalize function
  3. Them vao test profile
  4. Test isolation cho gia tri moi
```

## 7. Variant isolation proof

### Cau truc chung minh

Moi cap variant duoc chung minh qua 4 buoc (cho 1 path, sau khi ban-url):

```text
BUOC 1: WARM BASE VARIANT
  Request: GET /path + baseProfile headers
  Expected: MISS (lan dau tien), X-Cache-Key-* = baseExpected
  Y nghia: Base variant duoc fetch tu origin va cache lai

BUOC 2: VERIFY BASE HIT
  Request: GET /path + baseProfile headers (cung het nhu buoc 1)
  Expected: HIT, X-Cache-Key-* = baseExpected
  Y nghia: Base variant da duoc cache, request lai -> HIT

BUOC 3: VERIFY VARIANT ISOLATION (BUOC QUAN TRONG NHAT)
  Request: GET /path + variantProfile headers (KHAC base)
  Expected: MISS, X-Cache-Key-* = variantExpected (KHAC baseExpected)
  Y nghia: Variant profile khong duoc HIT tu base -> CHUNG MINH ISOLATION

BUOC 4: WARM & VERIFY VARIANT HIT
  Request: GET /path + variantProfile headers (cung het nhu buoc 3)
  Expected: HIT, X-Cache-Key-* = variantExpected
  Y nghia: Variant da duoc cache doc lap, request lai -> HIT
```

### Tai sao buoc 3 la quan trong nhat

```text
Buoc 3 la "linh hon" cua toan bo case:

  Neu buoc 3 la HIT (thay vi MISS):
    -> Varnish da dung cache key cua base cho variant
    -> Base va variant DUNG CHUNG cache object
    -> LEAKAGE CONFIRMED

  Neu buoc 3 la MISS:
    -> Varnish da tao cache key RIENG cho variant
    -> Base va variant la 2 cache object DOC LAP
    -> ISOLATION CONFIRMED
```

### Chung minh doc lap (independence), khong chi khac biet (differentiation)

```text
DIFFERENTIATION (yeu hon):
  Chi can base co MISS, variant co MISS -> key khac nhau
  Nhung khong chung minh duoc base KHONG BI OVERWRITE

ISOLATION (manh hon):
  - Warm base -> HIT
  - Request variant -> MISS
  - Warm variant -> HIT
  - Request base LAN NUA -> PHAI VAN LA HIT (base khong bi variant overwrite)
  - Request variant LAN NUA -> PHAI VAN LA HIT (variant khong bi base overwrite)
```

### Vi sao isolation quan trong trong thuc te

```text
Tinh huong: Traffic den tu ca VN mobile VA US desktop CUNG LUC

Neu chi co differentiation (khong isolation):
  Thoi gian t=0: VN mobile request -> MISS -> cache object A
  Thoi gian t=1: VN mobile request -> HIT (object A)
  Thoi gian t=2: US desktop request -> MISS -> cache object B
  Thoi gian t=3: VN mobile request -> co the MISS (object A bi evict)
                 hoac HIT (object A van con)

Neu co isolation:
  Thoi gian t=0: VN mobile request -> MISS -> cache object A
  Thoi gian t=1: VN mobile request -> HIT (object A)
  Thoi gian t=2: US desktop request -> MISS -> cache object B (DOC LAP)
  Thoi gian t=3: VN mobile request -> HIT (object A VAN TON TAI)
  Thoi gian t=4: US desktop request -> HIT (object B VAN TON TAI)

ISOLATION dam bao: object A khong bi anh huong boi object B va nguoc lai
```

### Cardinality cua khong gian variant

```text
So luong variant toi da co the ton tai:

  Language: 3 (vi, en, ja)
  Geo:      4 (VN, US, SG, JP -- whitelist)
  Device:   3 (mobile, tablet, desktop)
  AB:       3 (control, variant-a, variant-b)
  Segment:  4 (guest, new_user, returning, vip)

  Khong co segment (products detail):
    3 x 4 x 3 x 3 = 108 variants / URL

  Co segment (homefeed):
    3 x 4 x 3 x 3 x 4 = 432 variants / URL

Day la UPPER BOUND khi tat ca combination deu duoc request.
Thuc te: chi mot so combination co traffic -> so luong thap hon.
```

## 8. Key signals/headers

### 5 X-Cache-Key-* response headers

```text
Header                   Y nghia                          Vi du gia tri
X-Cache-Key-Language     Ngon ngu da normalize            "vi", "en", "ja"
X-Cache-Key-Geo          Quoc gia da normalize            "VN", "US", "SG", "JP"
X-Cache-Key-Device       Thiet bi da normalize            "mobile", "desktop", "tablet"
X-Cache-Key-AB           AB variant da normalize          "control", "variant-a", "variant-b"
X-Cache-Key-Segment      User segment da normalize        "guest", "new_user", "returning", "vip"
                         (CHI co tren homefeed path)
```

### Headers khac can doc

```text
Header               Y nghia                            Gia tri can doc
X-Cache              Trang thai cache                   "HIT" hoac "MISS"
X-Cache-Hits         So lan object da duoc hit          so nguyen, >=1
X-Upstream-Service   Service nao da xu ly request       "products-service"
X-Served-By          CDN nao da serve                   "varnish"
Cache-Control        Cache directive tu origin          "public, s-maxage=90"
CDN-Cache-Control    Cache directive tu CDN             (neu co override)
Age                  Thoi gian object da trong cache    so giay
```

### Cach doc X-Cache-Key-* de verify normalization

```text
Vi du: Varnish normalize X-Geo-Country tu "VIETNAM" thanh "VN"

Request header:  X-Geo-Country: VIETNAM
VCL normalize:   "VIETNAM" khong match SG/US/JP -> default "VN"
Response header: X-Cache-Key-Geo: VN

-> Neu script expected normalizeGeo("VIETNAM") = "VN" -> MATCH -> PASS

Vi du sai normalization:
  Request header:  X-Geo-Country: VIETNAM
  VCL normalize:   Bug -> "VIETNAM" (khong normalize)
  Response header: X-Cache-Key-Geo: VIETNAM
  -> Script expected "VN", actual "VIETNAM" -> MISMATCH -> FAIL
```

### Bang mapping normalization day du

```text
DIMENSION: LANGUAGE (Accept-Language)
  Input                  Normalized       Note
  "vi"                   "vi"             Viet Nam
  "vi-VN;q=0.9"          "vi"             Trich 2 ky tu dau
  "en"                   "en"             English
  "en-US,en;q=0.9"       "en"             Trich 2 ky tu dau
  "ja"                   "ja"             Japanese
  "fr"                   "en"             Fallback (khong trong whitelist)
  "" (absent)            "en"             Default
  "zh"                   "en"             Fallback

DIMENSION: GEO (X-Geo-Country)
  Input                  Normalized       Note
  "VN"                   "VN"             Viet Nam
  "vn"                   "VN"             Case-insensitive -> uppercase
  "US"                   "US"             United States
  "SG"                   "SG"             Singapore
  "JP"                   "JP"             Japan
  "FR"                   "VN"             Default (khong trong whitelist)
  "VIETNAM"              "VN"             Default (khong match exact)
  "" (absent)            "VN"             Default

DIMENSION: DEVICE (X-Device-Class)
  Input                  Normalized       Note
  "mobile"               "mobile"         Mobile device
  "MOBILE"               "mobile"         Case-insensitive -> lowercase
  "desktop"              "desktop"        Desktop device
  "tablet"               "tablet"         Tablet device
  "cellphone"            "desktop"        Default (khong trong whitelist)
  "" (absent)            "desktop"        Default

DIMENSION: AB (X-Ab-Variant)
  Input                  Normalized       Note
  "control"              "control"        Default experience
  "variant-a"            "variant-a"      Experiment A
  "Variant-A"            "variant-a"      Case-insensitive -> lowercase
  "variant-b"            "variant-b"      Experiment B
  "experiment-xyz"       "control"        Default (khong trong whitelist)
  "" (absent)            "control"        Default

DIMENSION: SEGMENT (X-User-Segment)
  Input                  Normalized       Note
  "guest"                "guest"          Nguoi dung chua dang nhap
  "GUEST"                "guest"          Case-insensitive -> lowercase
  "new_user"             "new_user"       Nguoi dung moi dang ky
  "returning"            "returning"      Nguoi dung quay lai
  "vip"                  "vip"            Khach hang VIP
  "premium"              "guest"          Default (khong trong whitelist)
  "" (absent)            "guest"          Default
```

## 9. Pass/fail criteria

### PASS criteria

```text
1. k6 exit code = 0 (tat ca checks deu pass)

2. MOI CAP VARIANT deu:
   a) Base first = MISS       (warm base)
   b) Base second = HIT       (verify base cache)
   c) Variant first = MISS    (CHUNG MINH ISOLATION -- day la KEY)
   d) Variant second = HIT    (verify variant cache)

3. MOI REQUEST deu:
   a) Status = 200
   b) Upstream = 'products-service'
   c) Cache-Key-* headers khớp expectedCacheKey(profile)

4. KHONG co variant nao HIT ngay lan dau tien (vi pham isolation)
```

### FAIL criteria -- canh bao do

```text
FAIL-1: VARIANT LEAKAGE (nghiem trong nhat)
  Bieu hien: variant_first request -> HIT (thay vi MISS)
  Y nghia: variant profile da dung cache object cua base profile
  Nguyen nhan: VCL hash thieu mot variant dimension
  Hậu qua: Nguoi dung nhan noi dung SAI -> mat doanh thu

FAIL-2: ALWAYS MISS (khong co cache)
  Bieu hien: base_second_request -> MISS (thay vi HIT)
  Y nghia: Object khong duoc cache hoac cache key khong on dinh
  Nguyen nhan: Cache-Control: no-store, Set-Cookie, hoac key instability
  Hậu qua: Cache vo dung -> origin bi qua tai

FAIL-3: CACHE KEY MISMATCH (sai normalization)
  Bieu hien: X-Cache-Key-Language = "VI" nhung expected = "vi"
  Y nghia: Normalization logic sai (case-sensitivity, fallback)
  Nguyen nhan: Bug trong VCL normalize_cache_variants
  Hậu qua: Co the khong match voi expected -> cache fragmentation

FAIL-4: WRONG UPSTREAM (routing sai)
  Bieu hien: X-Upstream-Service = "cart-service" (thay vi "products-service")
  Y nghia: Request bi route sai -> sai service xu ly
  Nguyen nhan: Nginx routing config sai
  Hậu qua: Noi dung tra ve khong dung

FAIL-5: NON-DETERMINISTIC (concurrency noise)
  Bieu hien: Ket qua MISS/HIT khong on dinh giua cac run
  Y nghia: Concurrency hoac shared state lam nhiễu proof
  Nguyen nhan: Nhieu VU cung chay, khong ban-url truoc, TTL qua ngan
  Hậu qua: Khong the assertion -> test khong co gia tri
```

### Thresholds trong script

```javascript
thresholds: {
  checks: ['rate==1'],  // 100% checks pass -- KHONG CHAP NHAN FAIL
}
```

## 10. Cach chay + output

### Cach chay

```powershell
# Step 1: Set environment variables
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

# Step 2: Verify prerequisites
curl http://localhost:80/health
# Expected: 200 OK

curl -H "Authorization: Bearer <ops-token>" http://localhost:8088/ops/app/cdn/origin/profile
# Expected: { "data": { "profile": { "healthy": true } } }

# Step 3: Run the scenario
./scripts/run-cdn-capabilities.ps1 -Scenarios 02-variant-keys

# Hoac chay truc tiep k6:
k6 run `
  -e BASE_URL=http://localhost:80 `
  -e CONTROL_BASE_URL=http://localhost:8088 `
  -e CATALOG_EVENTS_BASE_URL=http://localhost:9091 `
  -e OPS_AUTH_TOKEN=<ops-token> `
  E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/02-variant-keys.js

# Step 4: Override iterations (neu can nhieu samples hon)
$env:VARIANT_KEYS_ITERATIONS = "48"
./scripts/run-cdn-capabilities.ps1 -Scenarios 02-variant-keys
```

### Output chinh can doc

```text
K6 CONSOLE OUTPUT:

  run: (0/1) ... scenarios: (100.00%) 1 VUs, 24 iterations
  checks: 100%  ✓ language_base_first status 200
                 ✓ language_base_first cache state MISS
                 ✓ language_base_first cache language vi
                 ✓ language_base_first cache geo VN
                 ...

CRITICAL PATTERNS TO WATCH:
  1. Khong co check nao FAIL
  2. Tat ca "variant_first" requests deu co "cache state MISS"
  3. Tat ca "variant_second" requests deu co "cache state HIT"
  4. Tat ca "base_second" requests deu co "cache state HIT"
  5. X-Cache-Key-* headers khop expectedCacheKey cho tung profile
```

### Cach doc output console

```text
Tim cac pattern nay trong output:

PATTERN PASS (kỳ vong):
  language_base_first  ... MISS ... language=vi geo=VN device=mobile ab=control
  language_base_second ... HIT  ... language=vi geo=VN device=mobile ab=control
  language_variant_first ... MISS ... language=en geo=VN device=mobile ab=control
  language_variant_second ... HIT  ... language=en geo=VN device=mobile ab=control

PATTERN FAIL - LEAKAGE:
  language_variant_first ... HIT ... language=en geo=VN ...
  ^^^ DAY LA LOI! variant_first phai la MISS, khong duoc HIT tu base

PATTERN FAIL - KEY MISMATCH:
  language_base_first ... cache language vi ... expected: vi ... FAIL
  ^^^ Co the normalization sai hoac VCL khong normalize
```

## 11. 4 output -> decision scenarios

### Scenario 1: TAT CA PASS -- Cache key dung, isolation hoan hao

```text
OUTPUT:
  checks = 100%
  Tat ca base_first = MISS, base_second = HIT
  Tat ca variant_first = MISS, variant_second = HIT
  X-Cache-Key-* khop expected cho tat ca profiles

DECISION:
  -> CDN cache key da bao gom day du 5 variant dimensions
  -> Variant isolation duoc chung minh cho TUNG CHIEU
  -> CO THE trusted de serve nhieu audience cung luc
  -> PASS -- san sang cho production

CANH BAO (du pass):
  -> Day chi chung minh cho NHUNG DIMENSION DA TEST
  -> Neu them dimension moi (vd: X-Payment-Currency) -> can test lai
  -> So luong request thap -> chi la proof-of-concept, khong phai load test

### Diagnostic workflow khi gap fail

```text
Neu test FAIL, dung quy trinh nay de tim root cause:

BUOC 1: XAC DINH DIMENSION NÀO FAIL
  - Xem case tags: language, geo, device, ab_variant, segment
  - Dimension nao co check FAIL -> dimension do la root cause
  - Neu NHIEU dimension fail -> co the la VCL hash thieu NHIEU hash_data()
  - Neu CHI 1 dimension fail -> chi dimension do co van de

BUOC 2: XAC DINH KIEU FAIL
  - variant_first = HIT? -> LEAKAGE (missing hash_data in VCL)
  - base_second = MISS? -> CACHE NOT WORKING (uncacheable, key instability)
  - X-Cache-Key-* mismatch? -> NORMALIZATION BUG (VCL vs shared.js mismatch)
  - Tat ca request MISS? -> BYPASS (auth, cookie, no-cache header)

BUOC 3: INSPECT VCL CHO DIMENSION FAIL
  - Kiem tra vcl_hash: co hash_data(req.http.X-Cache-<Dimension>) khong?
  - Kiem tra normalize_cache_variants: co set X-Cache-<Dimension> khong?
  - Kiem tra vcl_recv: normalize_cache_variants duoc goi TRUOC return(hash) khong?
  - Kiem tra vcl_deliver: co set X-Cache-Key-<Dimension> response header khong?

BUOC 4: SO SANH VCL NORMALIZE VS SHARED.JS
  - VCL regex: co extract dung khong?
  - VCL whitelist: co khop shared.js whitelist khong?
  - VCL default: co khop shared.js default khong?
  - Case-sensitivity: uppercase vs lowercase co dong nhat khong?

BUOC 5: RUN SINGLE-PAIR DE VERIFY FIX
  - Sau khi fix VCL: reload Varnish
  - Chay test chi voi dimension bi fail
  - Neu pass -> chay full 5-pair test
  - Neu van fail -> quay lai buoc 3
```

### Cach doc VCL debug headers

```text
Ngoai X-Cache-Key-*, Varnish con tra ve cac debug headers huu ich:

  X-Cache: HIT hoac MISS
    -> Xac dinh object duoc serve tu cache hay fetch tu origin

  X-Cache-Hits: so lan object da duoc hit
    -> >= 1 neu HIT, = 0 neu MISS
    -> HIT ratio per object (khong phai global)

  X-Served-By: varnish
    -> Xac nhan response di qua Varnish

  X-Cache-Age: so giay object da nam trong cache
    -> Phan biet "HIT moi" vs "HIT cu"
    -> Age < TTL -> object con fresh

  X-Cache-Stale: true (neu co)
    -> Object het TTL nhung duoc serve vi origin unhealthy
    -> Khong lien quan den variant keys nhung co the xuat hien
```

### Phan biet LEAKAGE vs FRAGMENTATION

```text
LEAKAGE (variant collisions):
  - 2 profile KHAC NHAU -> CUNG cache key -> CUNG object
  - Bieu hien: variant_first = HIT (sai!)
  - Nguyen nhan: VCL hash THIEU dimension
  - Fix: THEM hash_data vao vcl_hash
  - Hậu qua: NGUY HIEM -- sai audience

FRAGMENTATION (unnecessary cache slots):
  - 2 request GIONG NHAU nhung KHAC cache key -> 2 object
  - Bieu hien: base_second = MISS (sai!)
  - Nguyen nhan: Cache key chua data hay thay doi (timestamp, session ID)
    HOAC normalization KHONG on dinh
  - Fix: BO data hay thay doi ra khoi cache key, cai thien normalize
  - Hậu qua: IT NGUY HIEM nhung lang phi cache memory, HIT ratio thap

Case nay CHU YEU TEST LEAKAGE (variant_first must MISS).
Fragmentation thuong duoc test trong case 04 (query normalization).
```

### Scenario 2: VARIANT LEAKAGE DETECTED -- Cung cache key cho profile khac nhau

```text
OUTPUT (VI DU LEAKAGE LANGUAGE):
  language_base_first:  200 MISS language=vi
  language_base_second: 200 HIT  language=vi
  language_variant_first: 200 HIT  language=vi  <-- LOI! Phai la MISS
  language_variant_second: 200 HIT language=vi  <-- Van HIT (nhung sai variant!)

PHAN TICH:
  - variant_first request tra HIT thay vi MISS
  - X-Cache-Key-Language = "vi" (dang le phai la "en" cho variant)
  - Nghia la: VCL hash KHONG su dung language dimension
  - Base (vi) va variant (en) DUNG CHUNG cache object

NGUYEN NHAN GOC:
  - VCL vcl_hash khong co hash_data(req.http.X-Cache-Language)
  - Hoac: X-Cache-Language khong duoc set trong normalize_cache_variants
  - Hoac: normalize_cache_variants khong duoc goi truoc khi hash

DECISION:
  -> FAIL -- KHONG the deploy
  -> Fix: them hash_data(req.http.X-Cache-Language) vao vcl_hash
  -> Rerun: toan bo 5 variant pairs phai pass
  -> Kiem tra: tat ca cac path products deu hash language

ROOT CAUSE CHECKLIST:
  [ ] vcl_hash co hash_data(req.http.X-Cache-Language) khong?
  [ ] normalize_cache_variants duoc goi TRUOC return(hash) khong?
  [ ] X-Cache-Language duoc set TRONG normalize_cache_variants khong?
  [ ] regex trich xuat language co DUNG khong?
```

### Scenario 3: ALWAYS MISS -- Object khong bao gio duoc cache

```text
OUTPUT (VI DU):
  language_base_first:  200 MISS
  language_base_second: 200 MISS  <-- LOI! Phai la HIT
  language_variant_first: 200 MISS
  language_variant_second: 200 MISS

PHAN TICH:
  - Tat ca request deu MISS -> cache khong hoat dong
  - Co the vi: object khong duoc cache (uncacheable)
  - Hoac: cache key thay doi giua cac request (key instability)

NGUYEN NHAN CO THE:
  1. Backend tra Cache-Control: no-store hoac private -> VCL set uncacheable
  2. Backend tra Set-Cookie -> VCL set uncacheable
  3. Cache key bao gom session-specific data (vi du: user token, session ID)
     -> Moi request co cache key khac nhau -> khong bao gio HIT
  4. Normalization random (vi du: timestamp trong cache key)
  5. TTL = 0s -> object bi expire ngay lap tuc
  6. req.http.Cookie hien dien -> VCL pass (bypass cache)

DECISION:
  -> FAIL -- cache khong hoat dong
  -> Kiem tra VCL vcl_backend_response: co set uncacheable true khong?
  -> Kiem tra backend response headers: Cache-Control, Set-Cookie
  -> Kiem tra VCL vcl_recv: co header nao trigger return(pass) khong?
  -> Kiem tra TTL fallback: beresp.ttl co > 0s khong?

ROOT CAUSE CHECKLIST:
  [ ] Backend co tra Cache-Control: public khong?
  [ ] Backend co tra Set-Cookie khong? (neu co -> uncacheable)
  [ ] req.http.Cookie co duoc gui kem khong? (neu co -> bypass)
  [ ] Cache key co chua user-specific data khong? (session, token)
  [ ] TTL duoc set > 0s? (kiem tra VCL fallback)
```

### Scenario 4: WRONG NORMALIZATION -- Cache key dung nhung gia tri sai

```text
OUTPUT (VI DU GEO NORMALIZATION SAI):
  geo_base_first:  X-Cache-Key-Geo = "vn"  <-- LOI! Expected "VN"
  Expected:        geo = "VN"
  Actual:          geo = "vn"

PHAN TICH:
  - Cache key co dimension geo -> HIT/MISS sequence DUNG
  - NHUNG gia tri bi sai: "vn" thay vi "VN" -> khong match expected
  - Nguyen nhan: VCL normalize khong uppercase, hoac JS normalize sai
  - Hậu qua nhe hon leakage nhung van gay cache fragmentation:
    Neu mot he thong gui "VN" va he thong khac gui "vn"
    -> 2 object khac nhau cho cung quoc gia -> lang phi cache

NGUYEN NHAN CO THE:
  1. VCL dung std.tolower() thay vi uppercase cho geo
  2. VCL khong ap dung normalization cho geo (giu nguyen input)
  3. Shared.js normalizeGeo sai whitelist hoac case
  4. Mismatch giua VCL normalization va expectedCacheKey

DECISION:
  -> FAIL (checks fail vi expectedCacheKey khong khop)
  -> Fix normalization logic trong VCL HOAC shared.js
  -> DAM BAO VCL normalization === shared.js normalize*()
  -> Rerun: expectedCacheKey phai khop headers thuc te

ROOT CAUSE CHECKLIST:
  [ ] VCL normalize co uppercased geo? (VN, US, SG, JP)
  [ ] VCL normalize co lowercased language? (vi, en, ja)
  [ ] VCL normalize co lowercased device? (mobile, desktop, tablet)
  [ ] shared.js normalize*() functions match VCL 1:1?
  [ ] expectedCacheKey() co tinh toan dung khong?
```

## 12. Nghich ly -- nhung su that gay ngac nhien

### Nghich ly 1: "Cache key variations NHAN so luong object -- cardinality explosion"

```text
SAI: "Them cache key dimension de linh hoat hon -> tot hon"

SU THAT:
  Moi dimension them vao cache key -> NHAN so luong object co the cache

  Vi du: Chi co language (3 values):
    /api/sim/products/1 -> 3 cache objects

  Them geo (4 values):
    3 x 4 = 12 cache objects

  Them device (3 values):
    3 x 4 x 3 = 36 cache objects

  Them AB (3 values):
    3 x 4 x 3 x 3 = 108 cache objects

  Them segment (4 values):
    3 x 4 x 3 x 3 x 4 = 432 cache objects / URL

  Neu co 1000 URLs, 300 cache objects/URL:
    300,000 cache objects trong Varnish memory!

  -> Moi dimension tang cache size THEO CAP SO NHAN
  -> Can can nhac: dimension nao THUC SU can thiet?
  -> "Cache key toi thieu, du dung" tot hon "cache key day du nhat co the"
```

### Nghich ly 2: "Them cache key dimension de an toan hon -- nhung moi dimension tang cache size"

```text
SAI: "Cu them het cac header vao cache key cho CHAC. Sau nay can thi da co san."

SU THAT:
  Moi dimension:
    - Tang bo nho cache (RAM)
    - Tang CPU hash computation
    - Tang so luong MISS (vi it overlap giua audience)
    - Giam HIT ratio (vi cache bi fragment qua nhieu)

  Vi du: them X-User-ID vao cache key (MOI user co cache rieng)
    -> 1 million users -> 1 million cache objects / URL
    -> HIT ratio ~ 0% (vi user hiem khi request lai cung URL)
    -> Cache VO DUNG

  -> Chi them dimension khi CO SU KHAC BIET NOI DUNG THAT SU
  -> Neu noi dung giong nhau giua cac phan khuc -> DUNG chung cache key
  -> "Cache key dung" tot hon "cache key nhieu"
```

### Nghich ly 3: "HIT ratio 99% la tot -- nhung HIT co the la sai audience"

```text
SAI: "HIT ratio cao -> cache hoat dong tot -> PASS"

SU THAT (nhu da lap lai trong case nay):
  HIT ratio 99% co the la:
    - 99% request duoc serve tu cache -> NHANH
    - NHUNG 50% trong so do co the SAI AUDIENCE

  Vi du:
    - 1000 requests: 990 HIT, 10 MISS -> HIT ratio 99%
    - Nhung 500 HIT la user US desktop nhan noi dung VN mobile
    -> HIT ratio 99% NHUNG 50% SAI -> THAM HOA

  -> Case nay KHONG quan tam den HIT ratio
  -> Case nay quan tam den: HIT co DUNG PROFILE khong?
  -> Mot HIT sai audience = 1 bug, khong phai 1 win
```

### Nghich ly 4: "Normalization lam mat thong tin -- nhung giam cache fragmentation"

```text
SAI: "Normalize 'vi-VN;q=0.9,en;q=0.8' thanh 'vi' -> mat thong tin ve preference"

SU THAT:
  Normalization LA CO CHU DICH de giam fragmentation:

  Khong normalize:
    "vi-VN;q=0.9"            -> cache key chua raw string
    "vi-VN;q=0.9,en;q=0.8"   -> cache key KHAC (co them en fallback)
    "vi"                      -> cache key KHAC (thieu quality)
    -> 3 cache objects cho CUNG ngon ngu "vi"!

  Co normalize:
    "vi-VN;q=0.9"            -> "vi"
    "vi-VN;q=0.9,en;q=0.8"   -> "vi"
    "vi"                      -> "vi"
    -> 1 cache object cho CUNG ngon ngu -> HIT ratio cao hon

  -> Normalization la BAT BUOC de giam fragmentation
  -> Khong normalize = MINE FIELD cua cache key collision
```

### Nghich ly 5: "Segment chi co trong homefeed -- tai sao khong co trong products detail?"

```text
SU THAT:
  Day la QUYET DINH THIET KE CO CHU DICH:

  Products detail:
    - Noi dung san pham (gia, ten, mo ta) phu thuoc language + geo + device + AB
    - KHONG phu thuoc segment (guest vs returning xem CUNG san pham)
    -> Segment KHONG can trong cache key -> TIET KIEM cache slots

  Homefeed:
    - Noi dung ca nhan hoa (recommendations) phu thuoc segment
    - Returning user thay "goi y dua tren lich su mua hang"
    - Guest user thay "san pham pho bien"
    -> Segment CAN trong cache key -> tranh leak goi y ca nhan

  Categories:
    - Danh muc san pham chi phu thuoc language + geo
    - KHONG phu thuoc device (mobile vs desktop xem CUNG danh muc)
    - KHONG phu thuoc AB (variant khong doi danh muc)
    -> Chi language + geo trong cache key -> TIET KIEM cache slots

  -> Moi PATH co tap dimension TOI THIEU CAN THIET
  -> "Cache key toi thieu, du dung" duoc ap dung TRIET DE
```

## 13. Checklist

### Pre-run (truoc khi chay)

```text
[ ] Varnish dang chay: curl http://localhost:80/health -> 200 OK
[ ] Backend healthy: curl http://localhost:8088/ops/app/cdn/origin/profile -> healthy: true
[ ] OPS_AUTH_TOKEN da set: $env:OPS_AUTH_TOKEN co gia tri
[ ] k6 installed: k6 version >= v2.0.0
[ ] Script ton tai: ls E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/02-variant-keys.js
[ ] Shared.js ton tai: ls E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js
[ ] Duong dan test path hoat dong: curl http://localhost:80/api/sim/products/1 -> 200
[ ] Homefeed path hoat dong: curl http://localhost:80/api/sim/products/homefeed -> 200
[ ] Control path hoat dong: curl http://localhost:8088/ops/app/cdn/cache/ban-url (POST)
[ ] Tat ca profiles trong shared.js co du 5 headers
[ ] VCL sub vcl_hash chua hash_data cho cac dimension dung nhu expected
[ ] Khong co test data cu trong cache (restart Varnish neu can)
```

### During-run (trong khi chay)

```text
[ ] Console output hien thi checks cho tung variant pair
[ ] "language" pair: 4 checks groups (base_first, base_second, variant_first, variant_second)
[ ] "geo" pair: 4 checks groups
[ ] "device" pair: 4 checks groups
[ ] "ab_variant" pair: 4 checks groups
[ ] "segment" pair: 4 checks groups (tren homefeed path)
[ ] Tat ca variant_first deu MISS
[ ] Tat ca variant_second deu HIT
[ ] Tat ca base_second deu HIT
[ ] Khong co check FAIL nao xuat hien
[ ] Khong co VU exception hoac script error
```

### Post-run (sau khi chay)

```text
[ ] Exit code = 0 (k6)
[ ] Checks rate = 1 (100%)
[ ] checks_passes = expected (480 voi iterations=24)
[ ] checks_fails = 0
[ ] Tat ca case tags deu co du lieu:
    [ ] language_base_first, language_base_second, language_variant_first, language_variant_second
    [ ] geo_base_first, geo_base_second, geo_variant_first, geo_variant_second
    [ ] device_base_first, device_base_second, device_variant_first, device_variant_second
    [ ] ab_variant_base_first, ab_variant_base_second, ab_variant_first, ab_variant_second
    [ ] segment_base_first, segment_base_second, segment_variant_first, segment_variant_second
[ ] Summary khop expected iterations (24 x 5 x 4 = 480 requests)
```

## 14. 5 Variations -- thay doi config de thay variant behavior

### Variation 1: Test nhieu chieu variant hon (them X-Payment-Currency)

**Muc dich**: Khi he thong can them mot variant dimension moi (currency), chung minh
isolation cho dimension moi nay.

```javascript
// Them profile moi vao shared.js:
profiles.guestVNMobileVND: {
  name: 'guest_vn_mobile_vnd',
  headers: {
    'Accept-Language': 'vi',
    'X-Geo-Country': 'VN',
    'X-Device-Class': 'mobile',
    'X-Ab-Variant': 'control',
    'X-User-Segment': 'guest',
    'X-Payment-Currency': 'VND',
  },
},
profiles.guestVNMobileUSD: {
  name: 'guest_vn_mobile_usd',
  headers: {
    'Accept-Language': 'vi',
    'X-Geo-Country': 'VN',
    'X-Device-Class': 'mobile',
    'X-Ab-Variant': 'control',
    'X-User-Segment': 'guest',
    'X-Payment-Currency': 'USD',
  },
},

// Them expectedCacheKey currency:
function expectedCacheKey(profile) {
  // ... existing ...
  return {
    // ... existing ...
    currency: normalizeCurrency(headers['X-Payment-Currency']),
  };
}

function normalizeCurrency(value) {
  const curr = String(value || '').trim().toUpperCase();
  if (curr === 'VND' || curr === 'USD' || curr === 'SGD' || curr === 'JPY') {
    return curr;
  }
  return 'VND';
}

// Them test pair moi trong default function:
exerciseVariant(paths.productDetail, 'currency',
  profiles.guestVNMobileVND, profiles.guestVNMobileUSD);

// VCL: them hash_data(req.http.X-Cache-Currency) trong vcl_hash
// VCL: them normalize currency trong normalize_cache_variants
```

```text
Y NGHIA:
  - Chung minh co the mo rong cache key CHO TUNG DIMENSION MOT
  - Moi dimension them vao -> test isolation doc lap
  - Khong test tat ca dimension cung luc (se kho xac dinh root cause neu fail)
  - Moi dimension CAN CO:
    1. Profile headers
    2. Normalization function (shared.js)
    3. VCL normalization (normalize_cache_variants)
    4. VCL hash_data (vcl_hash)
    5. Cap test pair (exerciseVariant)
    6. X-Cache-Key-Currency response header (vcl_deliver)
```

### Variation 2: It chieu variant hon (chi language + geo)

**Muc dich**: Khi cache key chi co mot vai chieu, chung minh isolation don gian hon.

```javascript
// Profile chi can language + geo:
profiles.viVN: {
  headers: {
    'Accept-Language': 'vi',
    'X-Geo-Country': 'VN',
  },
},
profiles.enUS: {
  headers: {
    'Accept-Language': 'en',
    'X-Geo-Country': 'US',
  },
},

// Test chi 1 pair:
exerciseVariant(paths.productDetail, 'lang_geo', profiles.viVN, profiles.enUS);
```

```text
Y NGHIA:
  - It dimension -> it cache objects -> HIT ratio cao hon
  - Nhung mat kha nang phan biet device, AB, segment
  - Phu hop cho nhung service KHONG can device/AB/segment
  - Van phai test isolation cho nhung dimension CON LAI
```

### Variation 3: Custom header khong duoc normalize

**Muc dich**: Khi header khong nam trong whitelist normalize, test fallback behavior.

```javascript
profiles.unknownLanguage: {
  headers: {
    'Accept-Language': 'fr',   // French -- KHONG trong whitelist
    'X-Geo-Country': 'VN',
    'X-Device-Class': 'mobile',
    'X-Ab-Variant': 'control',
    'X-User-Segment': 'guest',
  },
},

// expectedCacheKey se normalizes 'fr' -> 'en' (fallback)
// Khi test voi guestVNMobileControl (language='vi'):
// guestVNMobileEnglish (language='en') vs unknownLanguage (language='fr'->'en')
// -> Ca 2 deu "en" -> CUNG cache object -> HIT

// Nhung: guestVNMobileControl (language='vi') vs unknownLanguage (language='en')
// -> Khac cache object -> MISS
```

```text
Y NGHIA:
  - Fallback behavior: gia tri khong duoc whitelist -> default
  - Nhieu header value khac nhau co the map ve CUNG normalized value
  - Vi du: "fr", "de", "zh", (absent) deu -> "en"
  -> Chi can 1 test pair de xac nhan fallback hoat dong
```

### Variation 4: High cardinality stress test

**Muc dich**: Tao nhieu profile ngau nhien de dam bao cache key khong bi collision.

```javascript
// Tao 50 profiles ngau nhien:
const randomProfiles = [];
for (let i = 0; i < 50; i++) {
  randomProfiles.push({
    name: `random_${i}`,
    headers: {
      'Accept-Language': ['vi', 'en', 'ja'][i % 3],
      'X-Geo-Country': ['VN', 'US', 'SG', 'JP'][i % 4],
      'X-Device-Class': ['mobile', 'desktop', 'tablet'][i % 3],
      'X-Ab-Variant': ['control', 'variant-a'][i % 2],
      'X-User-Segment': ['guest', 'new_user', 'returning'][i % 3],
    },
  });
}

// Test isolation giua cac cap ngau nhien:
for (let i = 0; i < randomProfiles.length - 1; i++) {
  exerciseVariant(paths.productDetail, `random_${i}`,
    randomProfiles[i], randomProfiles[i + 1]);
}
```

```text
Y NGHIA:
  - High cardinality: 50+ profiles -> nhieu cache objects
  - Dam bao khong co hash collision (2 profiles khac nhau -> cung key)
  - Stress test Varnish memory: nhieu cache objects ton tai cung luc
  - Phat hien key collision som (truoc khi production co nhieu variants)

LUU Y:
  - Test nay CO THE can nhieu VU hon de dam bao performance
  - Nhung van giu single-VU cho isolation proof (tuan tu)
  - Tang TTL_WAIT_SECONDS de dam bao object khong bi expire giua cac request
```

### Variation 5: Smoke test -- chi 1 pair nhanh

**Muc dich**: Xac nhan nhanh cache key hoat dong ma khong can test het 5 chieu.

```javascript
// Giam VARIANT_KEYS_ITERATIONS xuong 1:
$env:VARIANT_KEYS_ITERATIONS = "1"

// Hoac: script chi test 1 pair:
export default function () {
  // Chi test language isolation
  exerciseVariant(paths.productDetail, 'language',
    profiles.guestVNMobileControl, profiles.guestVNMobileEnglish);
}
```

```text
Y NGHIA:
  - Smoke test < 10 giay (4 requests total)
  - Dung trong CI/CD pipeline: moi commit -> chay smoke
  - Chi test 1 chieu -> phat hien regression nhanh
  - Neu smoke pass -> tin tuong VCL hash van dung
  - Neu smoke fail -> full 5-pair test de xac dinh root cause
```

## 15. Anti-patterns

### Anti-pattern 1: Session cookie trong cache key

```text
SAI: hash_data(req.http.Cookie) trong vcl_hash

VI SAO SAI:
  - Cookie chua session ID -> moi user co 1 cache key rieng
  - 1 million users -> 1 million cache objects cho CUNG URL
  - HIT ratio ~ 0% -> cache VO DUNG
  - Ton RAM khong lo (million objects)
  - KHONG PHAI LA "cache cho nguoi dung" -> day la "origin cho tung nguoi dung"

DUNG: Traffic co Cookie -> bypass cache (return(pass))
  Hoac: strip cookie truoc khi hash (chi hash public content)
```

### Anti-pattern 2: Khong normalize header values truoc khi hash

```text
SAI: hash_data(req.http.Accept-Language) -- dung raw header

VI SAO SAI:
  - "vi-VN;q=0.9" va "vi" la hai cache key KHAC nhau
  - Nhung cung la tieng Viet -> CUNG noi dung
  -> Cache fragmentation: nhieu object giong nhau nhung key khac
  -> HIT ratio thap do fragmentation

DUNG: normalize truoc khi hash:
  set req.http.X-Cache-Language = normalize(req.http.Accept-Language)
  hash_data(req.http.X-Cache-Language)
```

### Anti-pattern 3: Quen Vary header khi dung cache key variant

```text
SAI: CDN hash variant headers nhung KHONG set Vary header

VI SAO SAI:
  - Vary header bao cho browser/proxy biet: "noi dung thay doi theo header X"
  - Browser cache cung phai phan biet variant
  - Neu khong Vary: browser co the cache variant A va serve cho request B
  -> LEAKAGE O BROWSER LAYER (khong phai CDN layer)

DUNG: Backend tra Vary: Accept-Language, X-Geo-Country, ...
  Hoac: VCL set Vary header trong vcl_deliver
```

### Anti-pattern 4: Dung session ID hoac user ID thay vi segment

```text
SAI: Dung X-User-ID trong cache key de ca nhan hoa noi dung

VI SAO SAI:
  - Moi user co cache object rieng -> HIT ratio 0%
  - Khong scale: 1M users = 1M cache objects / URL
  - KHONG PHAI LA CACHE -- day la origin serve

DUNG: Gom user thanh SEGMENT (guest, returning, vip, new_user)
  - Segment co Y NGHIA KINH DOANH -> noi dung khac biet THAT SU
  - So segment nho (4-10) -> cache van scale
  - Ca nhan hoa that su -> dung AJAX/ESI edge-side include
```

### Anti-pattern 5: Bo qua test segment vi "no chi la 1 chieu nho"

```text
SAI: "Segment chi la 1 trong 5 chieu -> khong can test ky"

VI SAO SAI:
  - Segment CO THE la chieu QUAN TRONG NHAT cho business
  - Homefeed la entry point chinh -> segment leakage o day la THAM HOA
  - Returning user thay guest content -> mat personalization -> roi di
  - VIP user thay guest content -> mat uu dai -> phan no

DUNG: Test segment day du, bao gom:
  - guest vs returning
  - guest vs vip
  - guest vs new_user
  - DAM BAO homefeed co segment trong cache key (VCL vcl_hash)
```

### Anti-pattern 6: Khong test categories rieng biet

```text
SAI: "Categories tuong tu products -> khong can test rieng"

VI SAO SAI:
  - Categories chi hash language + geo (KHONG device, AB, segment)
  - Neu device thay doi -> categories ko can MISS -> van HIT DUNG
  - Neu test sai: dung categories path de test device isolation -> FAIL SAI

DUNG: Hieu RO dimension nao co trong cache key cho TUNG PATH:
  - /api/sim/products/categories -> chi language + geo
  - /api/sim/products/:id -> language + geo + device + AB
  - /api/sim/products/homefeed -> language + geo + device + AB + segment
  -> Test dimension PHAI HOP VOI PATH
```

## 16. Real validation data

### Run 2026-06-21 -- local validation

```text
Run ID:      cdn-02-variant-keys#1
Script:      02-variant-keys.js
Exit code:   0
Date:        2026-06-21
Target:      http://localhost:80
Profile:     guestVNMobileControl, guestVNMobileEnglish, guestUSMobileControl,
             guestVNDesktopControl, guestVNMobileVariantA, returningVNMobileVariantA
```

### Summary chinh

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes` / `checks_fails` | `480 / 0` |
| `iterations` | `24` |
| `http_reqs` | `480` |
| `vus_max` | `1` |
| `http_req_failed_rate` | `0` |

### Variant pair breakdown

| Variant pair | Path | Base first | Base second | Variant first | Variant second | Result |
| --- | --- | --- | --- | --- | --- | --- |
| language | /api/sim/products/1 | MISS | HIT | MISS | HIT | PASS |
| geo | /api/sim/products/1 | MISS | HIT | MISS | HIT | PASS |
| device | /api/sim/products/1 | MISS | HIT | MISS | HIT | PASS |
| ab_variant | /api/sim/products/1 | MISS | HIT | MISS | HIT | PASS |
| segment | /api/sim/products/homefeed | MISS | HIT | MISS | HIT | PASS |

### Cache key header verification

| Profile | Language | Geo | Device | AB | Segment |
| --- | --- | --- | --- | --- | --- |
| guestVNMobileControl | vi | VN | mobile | control | -- |
| guestVNMobileEnglish | en | VN | mobile | control | -- |
| guestUSMobileControl | vi | US | mobile | control | -- |
| guestVNDesktopControl | vi | VN | desktop | control | -- |
| guestVNMobileVariantA | vi | VN | mobile | variant-a | -- |
| returningVNMobileVariantA | vi | VN | mobile | variant-a | returning |

### Verdict

```text
PASS -- Variant isolation duoc chung minh cho ca 5 chieu:

  - LANGUAGE:  vi vs en -> cache objects DOC LAP -> PASS
  - GEO:       VN vs US -> cache objects DOC LAP -> PASS
  - DEVICE:    mobile vs desktop -> cache objects DOC LAP -> PASS
  - AB:        control vs variant-a -> cache objects DOC LAP -> PASS
  - SEGMENT:   guest vs returning (homefeed) -> cache objects DOC LAP -> PASS

  - Tat ca variant_first requests = MISS (KHONG LEAKAGE)
  - Tat ca variant_second requests = HIT (CACHE HOAT DONG)
  - Tat ca X-Cache-Key-* headers = expected (NORMALIZATION DUNG)
  - checks = 100%

=> CDN cache key bao gom day du 5 variant dimensions.
   Variant isolation duoc chung minh cho TUNG dimension mot cach doc lap.
   San sang phuc vu nhieu phan khuc nguoi dung khac nhau cung luc.
```

## Reference

### Trong cung series

| Doc | Noi dung |
| --- | --- |
| `00_overview.md` | Tong quan CDN layer series, topology, mental model |
| `01_hit-smoke.md` | HIT/MISS co ban cho product detail |
| `03_bypass-rules.md` | Auth/cookie/no-cache/write traffic bypass cache |
| `04_query-normalization.md` | Tracking params khong fragment cache |
| `05_invalidation-ops.md` | Purge, ban-url, ban-tag |
| `06_invalidation-events.md` | Catalog event-driven invalidation |
| `07_cache-contract.md` | Cache contract headers + 304 revalidation |
| `08_ttl-expiry.md` | TTL transition: MISS -> HIT -> wait -> MISS |

### Source code

| File | Noi dung |
| --- | --- |
| `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/02-variant-keys.js` | Script chinh case nay |
| `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js` | Shared helpers, profiles, expectedCacheKey |
| `E:/Projects/k6/k6-metrics-server/load-target/varnish/default.vcl` | VCL config (cache key, normalization, bypass) |
| `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/README.md` | Source README |
| `E:/Projects/k6/k6-metrics-server/scripts/run-cdn-capabilities.ps1` | PowerShell run script |
