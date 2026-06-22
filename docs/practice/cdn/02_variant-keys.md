# Case 02: variant cache keys -- cách ly nối dụng theo từng phân khúc người dùng

> **Case ID:** `cdn-02-variant-keys`
> **Script:** `02-variant-keys.js`
> **Layer:** CDN / Varnish
> **Proof:** Language/geo/device/AB/segment không bị leak variant -- cách ly tiết định giữa các phân khúc người dùng

## 1. tình huống thực tế

### E-commerce phục vụ nối dụng khac nhau theo phân khúc thị trường

Mot sản thương mại điện tử (e-commerce) phục vụ nhiêu phân khúc người dùng khac nhau
cùng lúc. cũng mot URL `/api/sim/products/1` (chỉ tiết sản phẩm), những nối dụng
tra ve thay đổi theo:

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

mới to hợp (language + geo + device + AB + segment) tạo ra mot **variant** riêng biệt.
variant này là kết quả kinh doanh thật sự -- không phải chỉ là "kỹ thuật cache".

### tại sao variant isolation là vấn đề đúng đắn (correctness), không phải hiệu năng

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

### hình dụng hệ thống thật

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

cũng mot request `GET /api/sim/products/1` đến Varnish, những:

- `Accept-Language: vi` + `X-Geo-Country: VN` + `X-Device-Class: mobile` -> variant A
- `Accept-Language: en` + `X-Geo-Country: US` + `X-Device-Class: desktop` -> variant B
- Hai variant phải là hai cache object độc lặp trọng Varnish

### ví dụ cụ thể ve hậu qua nếu variant bị leak

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

### cầu hỏi kinh doanh

```text
"Khi CDN cache noi dung cho mot phan khuc nguoi dung (vi du: VN mobile),
 no co bao dam rang phan khuc KHAC (US desktop) khong bao gio nhan duoc
 noi dung do khong?"

Day la cau hoi VE SU DUNG DAN. Khong phai ve HIT ratio.
Khong phai ve latency.
Khong phai ve throughput.

Day la: "CDN co phan biet duoc cac phan khuc nguoi dung khac nhau khong?"
```

### vì sao đầy là mot lớp CDN problem, không phải application problem

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

### trường hợp thật sự đã xảy ra (war story)

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

### các kich bản variant leakage thương gấp

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

### 5 chiếu variant độc lặp trọng cache key

CDN đáng được chứng minh cổ khá năng **cách ly variant** (variant isolation) trên
5 chiếu độc lặp:

```text
Chieu thu 1: LANGUAGE   (Accept-Language header)
Chieu thu 2: GEO        (X-Geo-Country header)
Chieu thu 3: DEVICE     (X-Device-Class header)
Chieu thu 4: AB         (X-Ab-Variant header)
Chieu thu 5: SEGMENT    (X-User-Segment header)
```

cũng URL + khac header = khac cache object. mới variant cổ mot **slot cache độc lặp**
với vòng đổi MISS -> HIT riêng.

### điều gì đáng được chứng minh

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

### tại sao đầy không phải là "kiểm tra HIT ratio"

```text
SAI: "Case nay kiem tra xem cache co hoat dong khong"
DUNG: "Case nay kiem tra xem cache co LAM DUNG khong"

HIT ratio cao la tot nhung:
  - HIT ratio 100% nhung variant bi leak -> THAM HOA
  - HIT ratio 0% nhung variant dung -> it nhat khong sai

Day la CORRECTNESS PROOF, khong phai PERFORMANCE BENCHMARK.
```

### mục tiêu kỹ thuật của case

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

### cách tiếp cận test: độc lặp từng chiếu mot

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

### hiểu đúng ve "cache slot"

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

## 3. vì sao test o CDN layer

### Application cổ thể sai, CDN cổ thể sai, status 200 không bao giờ nối len sự thật

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

### tại sao không thể trust status code

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

### tại sao phải test RIEENG CDN layer

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

### vì sao single-vụ

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

### các profile được test

```text
Profile                  Language  Geo  Device   AB          Segment
guestVNMobileControl     vi        VN   mobile   control     guest
guestVNMobileEnglish     en        VN   mobile   control     guest
guestUSMobileControl     vi        US   mobile   control     guest
guestVNDesktopControl    vi        VN   desktop  control     guest
guestVNMobileVariantA    vi        VN   mobile   variant-a   guest
returningVNMobileVariantA vi       VN   mobile   variant-a   returning
```

mới cập profile khac nhau dụng 1 chiếu -- các chiếu còn lại giu nguyen.
điều này chỗ phép chứng minh isolation theo từng chiếu MOT.

## 5. Script deep-dive

### cấu trúc tong thể

Script `02-variant-keys.js` cổ 2 phân chỉnh:

```text
1. Ham exerciseVariant(path, label, baseProfile, variantProfile, options)
   -> Thuc hien day du chung minh isolation cho 1 cap variant

2. Ham default (main)
   -> Goi exerciseVariant 5 lan, moi lan test 1 chieu variant
```

### Ham exerciseVariant -- chứng minh isolation chỗ 1 cập

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

### Chuoi assertion chỗ mới request

mới request (4 request / cập variant) deu bị kiểm tra:

```text
1. assertStatus           -> HTTP 200 (server tra loi thanh cong)
2. assertUpstream         -> upstream la 'products-service' (dung service xu ly)
3. assertCacheState       -> MISS hoac HIT (dung theo sequence)
4. assertCacheKeyHeaders  -> 5 X-Cache-Key-* headers khop expected
```

### 5 variant pairs được test trọng default function

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

### vì sao segment chỉ test trên homefeed path

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

### Tags đề trace back

mới request được gần tags cổ cấu trúc:

```text
{ case: 'language_base_first' }     -> base profile, lan 1, language test
{ case: 'language_variant_first' }  -> variant profile, lan 1, language test
{ case: 'geo_base_second' }         -> base profile, lan 2, geo test
{ case: 'segment_variant_second' }  -> variant profile, lan 2, segment test
...
```

Tags chỗ phép filter theo từng variant pair trọng dashboard và summary.

### Iterations tính toàn

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

### STAR SECTION -- đầy là troi tim của case này

Cache key là **identity của mot object trọng CDN**. nếu 2 request cổ cũng cache key,
chứng sẽ nhẵn cũng object tử cache. nếu khac cache key, chứng là 2 object độc lặp.

### VCL hash construction (tử default.vcl)

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

### mô hình khai niem

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

### Dimension 4: AB -- X-Ab-variant header

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

### Dimension nao ALWAYS trọng key, dimension nao CONDITIONAL

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

### X-Cache-Key-* response headers như verification

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

### Edge case: User-Agent fallback chỗ device detection

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

### Edge case: header cổ nhiêu giá trị (Accept-Language)

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

### tại sao whitelist quan trọng

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

## 7. variant isolation proof

### cấu trúc chứng minh

mới cập variant được chứng minh qua 4 bước (chỗ 1 path, sau khi bản-url):

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

### tại sao bước 3 là quan trọng nhất

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

### chứng minh độc lặp (independence), không chỉ khac biệt (differentiation)

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

### vì sao isolation quan trọng trọng thực tệ

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

### Cardinality của không giản variant

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

### Headers khac cận độc

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

### cách độc X-Cache-Key-* đề verify normalization

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

### bảng mapping normalization đầy đủ

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

### FAIL criteria -- cảnh báo đó

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

### Thresholds trọng script

```javascript
thresholds: {
  checks: ['rate==1'],  // 100% checks pass -- KHONG CHAP NHAN FAIL
}
```

## 10. cách chạy + output

### cách chạy

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

### Output chỉnh cận độc

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

### cách độc output console

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

### Scenario 1: TAT CA PASS -- Cache key dụng, isolation hoàn hao

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
nếu test FAIL, dụng quy trình này đề tim root cause:

bước 1: xác định DIMENSION NÀO FAIL
  - xem case tags: language, geo, device, ab_variant, segment
  - Dimension nao cổ check FAIL -> dimension đó là root cause
  - nếu nhiêu dimension fail -> cổ thể là VCL hash thiểu nhiêu hash_data()
  - nếu chỉ 1 dimension fail -> chỉ dimension đó cổ vấn đề

bước 2: xác định KIEU FAIL
  - variant_first = HIT? -> LEAKAGE (missing hash_data in VCL)
  - base_second = MISS? -> CACHE NOT WORKING (uncacheable, key instability)
  - X-Cache-Key-* mismatch? -> NORMALIZATION BUG (VCL vs shared.js mismatch)
  - Tat ca request MISS? -> BYPASS (auth, cookie, nó-cache header)

bước 3: INSPECT VCL chỗ DIMENSION FAIL
  - kiểm tra vcl_hash: cổ hash_data(req.http.X-Cache-<Dimension>) không?
  - kiểm tra normalize_cache_variants: cổ set X-Cache-<Dimension> không?
  - kiểm tra vcl_recv: normalize_cache_variants được gọi trước return(hash) không?
  - kiểm tra vcl_deliver: cổ set X-Cache-Key-<Dimension> response header không?

bước 4: số SANH VCL NORMALIZE VS SHARED.JS
  - VCL regex: cổ extract dụng không?
  - VCL whitelist: cổ khop shared.js whitelist không?
  - VCL default: cổ khop shared.js default không?
  - Case-sensitivity: uppercase vs lowercase cổ đóng nhất không?

bước 5: RUN SINGLE-PAIR đề VERIFY FIX
  - sau khi fix VCL: reload Varnish
  - chạy test chỉ với dimension bị fail
  - nếu pass -> chạy full 5-pair test
  - nếu vấn fail -> quay lại bước 3
```

### Cach doc VCL debug headers

```text
ngoài X-Cache-Key-*, Varnish còn tra ve các debug headers huu ích:

  X-Cache: HIT hoac MISS
    -> xác định object được serve tử cache hay fetch tử origin

  X-Cache-Hits: số lần object đã được hit
    -> >= 1 nếu HIT, = 0 nếu MISS
    -> HIT ratio per object (không phải global)

  X-Served-By: varnish
    -> xác nhận response di qua Varnish

  X-Cache-Age: số giây object đã năm trọng cache
    -> phân biệt "HIT mới" vs "HIT cũ"
    -> Age < TTL -> object còn fresh

  X-Cache-Stale: true (nếu cổ)
    -> Object hết TTL những được serve vì origin unhealthy
    -> không lien quan đến variant keys những cổ thể xuat hiển
```

### Phan biet LEAKAGE vs FRAGMENTATION

```text
LEAKAGE (variant collisions):
  - 2 profile KHAC NHAU -> cũng cache key -> cũng object
  - Bieu hiển: variant_first = HIT (sai!)
  - nguyên nhân: VCL hash thiểu dimension
  - Fix: thêm hash_data vào vcl_hash
  - Hậu qua: nguy hiểm -- sai audience

FRAGMENTATION (unnecessary cache slots):
  - 2 request GIONG NHAU những KHAC cache key -> 2 object
  - Bieu hiển: base_second = MISS (sai!)
  - nguyên nhân: Cache key chưa data hay thay đổi (timestamp, session ID)
    HOAC normalization không ổn định
  - Fix: bố data hay thay đổi ra khói cache key, cải thiện normalize
  - Hậu qua: ít nguy hiểm những lang phi cache memory, HIT ratio thấp

Case này chứ yêu TEST LEAKAGE (variant_first must MISS).
Fragmentation thương được test trọng case 04 (query normalization).
```

### Scenario 2: VARIANT LEAKAGE DETECTED -- Cung cache key cho profile khac nhau

```text
OUTPUT (ví dụ LEAKAGE LANGUAGE):
  language_base_first:  200 MISS language=vì
  language_base_second: 200 HIT  language=vì
  language_variant_first: 200 HIT  language=vì  <-- lợi! phải là MISS
  language_variant_second: 200 HIT language=vì  <-- vấn HIT (những sai variant!)

phân tích:
  - variant_first request tra HIT thay vì MISS
  - X-Cache-Key-Language = "vì" (đáng lẻ phải là "en" chỗ variant)
  - nghỉa là: VCL hash không sử dụng language dimension
  - Base (vì) và variant (en) dụng chứng cache object

nguyên nhân GOC:
  - VCL vcl_hash không cổ hash_data(req.http.X-Cache-Language)
  - Hoac: X-Cache-Language không được set trọng normalize_cache_variants
  - Hoac: normalize_cache_variants không được gọi trước khi hash

DECISION:
  -> FAIL -- không thể deploy
  -> Fix: thêm hash_data(req.http.X-Cache-Language) vào vcl_hash
  -> Rerun: toàn bố 5 variant pairs phải pass
  -> kiểm tra: tat ca các path products deu hash language

ROOT CAUSE CHECKLIST:
  [ ] vcl_hash cổ hash_data(req.http.X-Cache-Language) không?
  [ ] normalize_cache_variants được gọi trước return(hash) không?
  [ ] X-Cache-Language được set trọng normalize_cache_variants không?
  [ ] regex trich xuat language cổ dụng không?
```

### Scenario 3: ALWAYS MISS -- Object khong bao gio duoc cache

```text
OUTPUT (ví dụ):
  language_base_first:  200 MISS
  language_base_second: 200 MISS  <-- lợi! phải là HIT
  language_variant_first: 200 MISS
  language_variant_second: 200 MISS

phân tích:
  - Tat ca request deu MISS -> cache không hoạt động
  - cổ thể vì: object không được cache (uncacheable)
  - Hoac: cache key thay đổi giữa các request (key instability)

nguyên nhân cổ thể:
  1. backend tra Cache-control: nó-store hoac private -> VCL set uncacheable
  2. backend tra Set-Cookie -> VCL set uncacheable
  3. Cache key bao gom session-specific data (ví dụ: user token, session ID)
     -> mới request cổ cache key khac nhau -> không bao giờ HIT
  4. Normalization random (ví dụ: timestamp trọng cache key)
  5. TTL = 0s -> object bị expire ngay lập tức
  6. req.http.Cookie hiển điện -> VCL pass (bypass cache)

DECISION:
  -> FAIL -- cache không hoạt động
  -> kiểm tra VCL vcl_backend_response: cổ set uncacheable true không?
  -> kiểm tra backend response headers: Cache-control, Set-Cookie
  -> kiểm tra VCL vcl_recv: cổ header nao trigger return(pass) không?
  -> kiểm tra TTL fallback: beresp.ttl cổ > 0s không?

ROOT CAUSE CHECKLIST:
  [ ] backend cổ tra Cache-control: public không?
  [ ] backend cổ tra Set-Cookie không? (nếu cổ -> uncacheable)
  [ ] req.http.Cookie cổ được gửi kem không? (nếu cổ -> bypass)
  [ ] Cache key cổ chưa user-specific data không? (session, token)
  [ ] TTL được set > 0s? (kiểm tra VCL fallback)
```

### Scenario 4: WRONG NORMALIZATION -- Cache key dung nhung gia tri sai

```text
OUTPUT (ví dụ GEO NORMALIZATION sai):
  geo_base_first:  X-Cache-Key-Geo = "vn"  <-- lợi! Expected "VN"
  Expected:        geo = "VN"
  Actual:          geo = "vn"

phân tích:
  - Cache key cổ dimension geo -> HIT/MISS sequence dụng
  - những giá trị bị sai: "vn" thay vì "VN" -> không match expected
  - nguyên nhân: VCL normalize không uppercase, hoac JS normalize sai
  - Hậu qua nhe hon leakage những vấn gay cache fragmentation:
    nếu mot hệ thống gửi "VN" và hệ thống khac gửi "vn"
    -> 2 object khac nhau chỗ cũng quốc giả -> lang phi cache

nguyên nhân cổ thể:
  1. VCL dụng std.tolower() thay vì uppercase chỗ geo
  2. VCL không áp dụng normalization chỗ geo (giu nguyen input)
  3. Shared.js normalizeGeo sai whitelist hoac case
  4. Mismatch giữa VCL normalization và expectedCacheKey

DECISION:
  -> FAIL (checks fail vì expectedCacheKey không khop)
  -> Fix normalization logic trọng VCL HOAC shared.js
  -> đảm bảo VCL normalization === shared.js normalize*()
  -> Rerun: expectedCacheKey phải khop headers thực tệ

ROOT CAUSE CHECKLIST:
  [ ] VCL normalize cổ uppercased geo? (VN, US, SG, JP)
  [ ] VCL normalize cổ lowercased language? (vì, en, ja)
  [ ] VCL normalize cổ lowercased device? (mobile, desktop, tablet)
  [ ] shared.js normalize*() functions match VCL 1:1?
  [ ] expectedCacheKey() cổ tính toàn dụng không?
```

## 12. Nghich ly -- nhung su that gay ngac nhien

### Nghich ly 1: "Cache key variations NHAN so luong object -- cardinality explosion"

```text
sai: "thêm cache key dimension đề linh hoạt hon -> tốt hon"

sự thật:
  mới dimension thêm vào cache key -> nhẵn số lượng object cổ thể cache

  ví dụ: chỉ cổ language (3 values):
    /api/sim/products/1 -> 3 cache objects

  thêm geo (4 values):
    3 x 4 = 12 cache objects

  thêm device (3 values):
    3 x 4 x 3 = 36 cache objects

  thêm AB (3 values):
    3 x 4 x 3 x 3 = 108 cache objects

  thêm segment (4 values):
    3 x 4 x 3 x 3 x 4 = 432 cache objects / URL

  nếu cổ 1000 URLs, 300 cache objects/URL:
    300,000 cache objects trọng Varnish memory!

  -> mới dimension tầng cache size theo cập số nhẵn
  -> cận cân nhắc: dimension nao thực sự cận thiết?
  -> "Cache key tối thiểu, đủ dụng" tốt hon "cache key đầy đủ nhất cổ thể"
```

### Nghich ly 2: "Them cache key dimension de an toan hon -- nhung moi dimension tang cache size"

```text
sai: "cũ thêm hết các header vào cache key chỗ chắc. sau này cận thị đã cổ sản."

sự thật:
  mới dimension:
    - tầng bố nhờ cache (RAM)
    - tầng CPU hash computation
    - tầng số lượng MISS (vì ít overlap giữa audience)
    - Giam HIT ratio (vì cache bị fragment qua nhiêu)

  ví dụ: thêm X-User-ID vào cache key (mới user cổ cache riêng)
    -> 1 million users -> 1 million cache objects / URL
    -> HIT ratio ~ 0% (vì user hiem khi request lại cũng URL)
    -> Cache vô dụng

  -> chỉ thêm dimension khi cổ sử KHAC biệt nối dụng thật sự
  -> nếu nối dụng giong nhau giữa các phân khúc -> dụng chứng cache key
  -> "Cache key dụng" tốt hon "cache key nhiêu"
```

### Nghich ly 3: "HIT ratio 99% la tot -- nhung HIT co the la sai audience"

```text
sai: "HIT ratio cao -> cache hoạt động tốt -> PASS"

sự thật (như đã lặp lại trọng case này):
  HIT ratio 99% cổ thể là:
    - 99% request được serve tử cache -> nhanh
    - những 50% trọng số đó cổ thể sai audience

  ví dụ:
    - 1000 requests: 990 HIT, 10 MISS -> HIT ratio 99%
    - những 500 HIT là user US desktop nhẵn nối dụng VN mobile
    -> HIT ratio 99% những 50% sai -> THAM HOA

  -> Case này không quan tam đến HIT ratio
  -> Case này quan tam đến: HIT cổ dụng PROFILE không?
  -> Mot HIT sai audience = 1 bug, không phải 1 win
```

### Nghich ly 4: "Normalization lam mat thong tin -- nhung giam cache fragmentation"

```text
sai: "Normalize 'vì-VN;q=0.9,en;q=0.8' thành 'vì' -> mặt thống tin ve preference"

sự thật:
  Normalization là cổ chứ đích đề giam fragmentation:

  không normalize:
    "vì-VN;q=0.9"            -> cache key chưa raw string
    "vì-VN;q=0.9,en;q=0.8"   -> cache key KHAC (cổ thêm en fallback)
    "vì"                      -> cache key KHAC (thiểu quality)
    -> 3 cache objects chỗ cũng ngôn ngữ "vì"!

  cổ normalize:
    "vì-VN;q=0.9"            -> "vì"
    "vì-VN;q=0.9,en;q=0.8"   -> "vì"
    "vì"                      -> "vì"
    -> 1 cache object chỗ cũng ngôn ngữ -> HIT ratio cao hon

  -> Normalization là BAT bước đề giam fragmentation
  -> không normalize = MINE FIELD của cache key collision
```

### Nghich ly 5: "Segment chi co trong homefeed -- tai sao khong co trong products detail?"

```text
sự thật:
  đầy là quyết định thiết kế cổ chứ đích:

  Products detail:
    - nối dụng sản phẩm (giả, ten, mô tả) phụ thuộc language + geo + device + AB
    - không phụ thuộc segment (guest vs returning xem cũng sản phẩm)
    -> Segment không cận trọng cache key -> tiết kiệm cache slots

  Homefeed:
    - nối dụng cá nhân hóa (recommendations) phụ thuộc segment
    - Returning user thay "gợi ý dựa trên lịch sử mùa hàng"
    - Guest user thay "sản phẩm phổ biến"
    -> Segment cận trọng cache key -> tránh leak gợi ý cá nhân

  Categories:
    - Danh mức sản phẩm chỉ phụ thuộc language + geo
    - không phụ thuộc device (mobile vs desktop xem cũng danh mức)
    - không phụ thuộc AB (variant không đổi danh mức)
    -> chỉ language + geo trọng cache key -> tiết kiệm cache slots

  -> mới PATH cổ tap dimension tối thiểu cận thiết
  -> "Cache key tối thiểu, đủ dụng" được áp dụng TRIET đề
```

## 13. Checklist

### Pre-run (truoc khi chay)

```text
[ ] Varnish đáng chạy: curl http://localhost:80/health -> 200 OK
[ ] backend healthy: curl http://localhost:8088/ops/app/cdn/origin/profile -> healthy: true
[ ] OPS_AUTH_TOKEN đã set: $env:OPS_AUTH_TOKEN cổ giá trị
[ ] k6 installed: k6 version >= v2.0.0
[ ] Script tốn tại: ls E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/02-variant-keys.js
[ ] Shared.js tốn tại: ls E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js
[ ] đường dẫn test path hoạt động: curl http://localhost:80/api/sim/products/1 -> 200
[ ] Homefeed path hoạt động: curl http://localhost:80/api/sim/products/homefeed -> 200
[ ] control path hoạt động: curl http://localhost:8088/ops/app/cdn/cache/bản-url (POST)
[ ] Tat ca profiles trọng shared.js cổ đủ 5 headers
[ ] VCL sub vcl_hash chưa hash_data chỗ các dimension dụng như expected
[ ] không cổ test data cũ trọng cache (restart Varnish nếu cận)
```

### During-run (trong khi chay)

```text
[ ] Console output hiển thị checks chỗ từng variant pair
[ ] "language" pair: 4 checks groups (base_first, base_second, variant_first, variant_second)
[ ] "geo" pair: 4 checks groups
[ ] "device" pair: 4 checks groups
[ ] "ab_variant" pair: 4 checks groups
[ ] "segment" pair: 4 checks groups (trên homefeed path)
[ ] Tat ca variant_first deu MISS
[ ] Tat ca variant_second deu HIT
[ ] Tat ca base_second deu HIT
[ ] không cổ check FAIL nao xuat hiển
[ ] không cổ vụ exception hoac script error
```

### Post-run (sau khi chay)

```text
[ ] Exit code = 0 (k6)
[ ] Checks rate = 1 (100%)
[ ] checks_passes = expected (480 với iterations=24)
[ ] checks_fails = 0
[ ] Tat ca case tags deu cổ dữ liệu:
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
// thêm profile mới vào shared.js:
profiles.guestVNMobileVND: {
  name: 'guest_vn_mobile_vnd',
  headers: {
    'Accept-Language': 'vì',
    'X-Geo-Country': 'VN',
    'X-Device-Class': 'mobile',
    'X-Ab-variant': 'control',
    'X-User-Segment': 'guest',
    'X-Payment-Currency': 'VND',
  },
},
profiles.guestVNMobileUSD: {
  name: 'guest_vn_mobile_usd',
  headers: {
    'Accept-Language': 'vì',
    'X-Geo-Country': 'VN',
    'X-Device-Class': 'mobile',
    'X-Ab-variant': 'control',
    'X-User-Segment': 'guest',
    'X-Payment-Currency': 'USD',
  },
},

// thêm expectedCacheKey currency:
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

// thêm test pair mới trọng default function:
exerciseVariant(paths.productDetail, 'currency',
  profiles.guestVNMobileVND, profiles.guestVNMobileUSD);

// VCL: thêm hash_data(req.http.X-Cache-Currency) trọng vcl_hash
// VCL: thêm normalize currency trọng normalize_cache_variants
```

```text
ý nghỉa:
  - chứng minh cổ thể mở rộng cache key chỗ từng DIMENSION MOT
  - mới dimension thêm vào -> test isolation độc lặp
  - không test tat ca dimension cùng lúc (sẽ khỏ xác định root cause nếu fail)
  - mới dimension cận cổ:
    1. Profile headers
    2. Normalization function (shared.js)
    3. VCL normalization (normalize_cache_variants)
    4. VCL hash_data (vcl_hash)
    5. cập test pair (exerciseVariant)
    6. X-Cache-Key-Currency response header (vcl_deliver)
```

### Variation 2: It chieu variant hon (chi language + geo)

**Muc dich**: Khi cache key chi co mot vai chieu, chung minh isolation don gian hon.

```javascript
// Profile chỉ cận language + geo:
profiles.viVN: {
  headers: {
    'Accept-Language': 'vì',
    'X-Geo-Country': 'VN',
  },
},
profiles.enUS: {
  headers: {
    'Accept-Language': 'en',
    'X-Geo-Country': 'US',
  },
},

// Test chỉ 1 pair:
exerciseVariant(paths.productDetail, 'lang_geo', profiles.viVN, profiles.enUS);
```

```text
ý nghỉa:
  - ít dimension -> ít cache objects -> HIT ratio cao hon
  - những mặt khá năng phân biệt device, AB, segment
  - phù hợp chỗ những service không cận device/AB/segment
  - vấn phải test isolation chỗ những dimension còn lại
```

### Variation 3: Custom header khong duoc normalize

**Muc dich**: Khi header khong nam trong whitelist normalize, test fallback behavior.

```javascript
profiles.unknownLanguage: {
  headers: {
    'Accept-Language': 'fr',   // French -- không trọng whitelist
    'X-Geo-Country': 'VN',
    'X-Device-Class': 'mobile',
    'X-Ab-variant': 'control',
    'X-User-Segment': 'guest',
  },
},

// expectedCacheKey sẽ normalizes 'fr' -> 'en' (fallback)
// khi test với guestVNMobileControl (language='vì'):
// guestVNMobileEnglish (language='en') vs unknownLanguage (language='fr'->'en')
// -> Ca 2 deu "en" -> cũng cache object -> HIT

// những: guestVNMobileControl (language='vì') vs unknownLanguage (language='en')
// -> Khac cache object -> MISS
```

```text
ý nghỉa:
  - Fallback behavior: giá trị không được whitelist -> default
  - nhiêu header value khac nhau cổ thể map ve cũng normalized value
  - ví dụ: "fr", "đề", "zh", (absent) deu -> "en"
  -> chỉ cận 1 test pair đề xác nhận fallback hoạt động
```

### Variation 4: High cardinality stress test

**Muc dich**: Tao nhieu profile ngau nhien de dam bao cache key khong bi collision.

```javascript
// tạo 50 profiles ngẫu nhiên:
const randomProfiles = [];
for (let i = 0; i < 50; i++) {
  randomProfiles.push({
    name: `random_${i}`,
    headers: {
      'Accept-Language': ['vì', 'en', 'ja'][i % 3],
      'X-Geo-Country': ['VN', 'US', 'SG', 'JP'][i % 4],
      'X-Device-Class': ['mobile', 'desktop', 'tablet'][i % 3],
      'X-Ab-variant': ['control', 'variant-a'][i % 2],
      'X-User-Segment': ['guest', 'new_user', 'returning'][i % 3],
    },
  });
}

// Test isolation giữa các cập ngẫu nhiên:
for (let i = 0; i < randomProfiles.length - 1; i++) {
  exerciseVariant(paths.productDetail, `random_${i}`,
    randomProfiles[i], randomProfiles[i + 1]);
}
```

```text
ý nghỉa:
  - High cardinality: 50+ profiles -> nhiêu cache objects
  - đảm bảo không cổ hash collision (2 profiles khac nhau -> cũng key)
  - Stress test Varnish memory: nhiêu cache objects tốn tại cùng lúc
  - phát hiện key collision sớm (trước khi production cổ nhiêu variants)

lữu ý:
  - Test này cổ thể cận nhiêu vụ hon đề đảm bảo performance
  - những vấn giu single-vụ chỗ isolation proof (tuan tử)
  - tầng TTL_WAIT_SECONDS đề đảm bảo object không bị expire giữa các request
```

### Variation 5: Smoke test -- chi 1 pair nhanh

**Muc dich**: Xac nhan nhanh cache key hoat dong ma khong can test het 5 chieu.

```javascript
// Giam VARIANT_KEYS_ITERATIONS xuong 1:
$env:VARIANT_KEYS_ITERATIONS = "1"

// Hoac: script chỉ test 1 pair:
export default function () {
  // chỉ test language isolation
  exerciseVariant(paths.productDetail, 'language',
    profiles.guestVNMobileControl, profiles.guestVNMobileEnglish);
}
```

```text
ý nghỉa:
  - Smoke test < 10 giây (4 requests total)
  - dụng trọng CI/CD pipeline: mới commit -> chạy smoke
  - chỉ test 1 chiếu -> phát hiện regression nhanh
  - nếu smoke pass -> tin tương VCL hash vận dụng
  - nếu smoke fail -> full 5-pair test đề xác định root cause
```

## 15. Anti-patterns

### Anti-pattern 1: Session cookie trong cache key

```text
sai: hash_data(req.http.Cookie) trọng vcl_hash

vì SAO sai:
  - Cookie chưa session ID -> mới user cổ 1 cache key riêng
  - 1 million users -> 1 million cache objects chỗ cũng URL
  - HIT ratio ~ 0% -> cache vô dụng
  - tốn RAM không lỗ (million objects)
  - không phải là "cache chỗ người dùng" -> đầy là "origin chỗ từng người dùng"

dụng: Traffic cổ Cookie -> bypass cache (return(pass))
  Hoac: strip cookie trước khi hash (chỉ hash public content)
```

### Anti-pattern 2: Khong normalize header values truoc khi hash

```text
sai: hash_data(req.http.Accept-Language) -- dụng raw header

vì SAO sai:
  - "vì-VN;q=0.9" và "vì" là hai cache key KHAC nhau
  - những cũng là tiếng Việt -> cũng nối dụng
  -> Cache fragmentation: nhiêu object giong nhau những key khac
  -> HIT ratio thấp đó fragmentation

dụng: normalize trước khi hash:
  set req.http.X-Cache-Language = normalize(req.http.Accept-Language)
  hash_data(req.http.X-Cache-Language)
```

### Anti-pattern 3: Quen Vary header khi dung cache key variant

```text
sai: CDN hash variant headers những không set Vary header

vì SAO sai:
  - Vary header bao chỗ browser/proxy biệt: "nối dụng thay đổi theo header X"
  - Browser cache cũng phải phân biệt variant
  - nếu không Vary: browser cổ thể cache variant A và serve chỗ request B
  -> LEAKAGE O BROWSER LAYER (không phải CDN layer)

dụng: backend tra Vary: Accept-Language, X-Geo-Country, ...
  Hoac: VCL set Vary header trọng vcl_deliver
```

### Anti-pattern 4: Dung session ID hoac user ID thay vi segment

```text
sai: dụng X-User-ID trọng cache key đề cá nhân hóa nối dụng

vì SAO sai:
  - mới user cổ cache object riêng -> HIT ratio 0%
  - không scale: 1M users = 1M cache objects / URL
  - không phải là CACHE -- đầy là origin serve

dụng: Gom user thành SEGMENT (guest, returning, vip, new_user)
  - Segment cổ ý nghỉa kinh doanh -> nối dụng khac biệt thật sự
  - số segment nhờ (4-10) -> cache vấn scale
  - cá nhân hóa thật sự -> dụng AJAX/ESI edge-side include
```

### Anti-pattern 5: Bo qua test segment vi "no chi la 1 chieu nho"

```text
sai: "Segment chỉ là 1 trọng 5 chiếu -> không cận test ky"

vì SAO sai:
  - Segment cổ thể là chiếu quan trọng nhất chỗ business
  - Homefeed là entry point chỉnh -> segment leakage o đầy là THAM HOA
  - Returning user thay guest content -> mặt personalization -> rời đi
  - VIP user thay guest content -> mặt ưu dài -> phân nó

dụng: Test segment đầy đủ, bao gom:
  - guest vs returning
  - guest vs vip
  - guest vs new_user
  - đảm bảo homefeed cổ segment trọng cache key (VCL vcl_hash)
```

### Anti-pattern 6: Khong test categories rieng biet

```text
sai: "Categories tương tử products -> không cận test riêng"

vì SAO sai:
  - Categories chỉ hash language + geo (không device, AB, segment)
  - nếu device thay đổi -> categories ko cận MISS -> vấn HIT dụng
  - nếu test sai: dụng categories path đề test device isolation -> FAIL sai

dụng: hiểu rõ dimension nao cổ trọng cache key chỗ từng PATH:
  - /api/sim/products/categories -> chỉ language + geo
  - /api/sim/products/:id -> language + geo + device + AB
  - /api/sim/products/homefeed -> language + geo + device + AB + segment
  -> Test dimension phải hợp với PATH
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
PASS -- variant isolation được chứng minh chỗ ca 5 chiếu:

  - LANGUAGE:  vì vs en -> cache objects độc lặp -> PASS
  - GEO:       VN vs US -> cache objects độc lặp -> PASS
  - DEVICE:    mobile vs desktop -> cache objects độc lặp -> PASS
  - AB:        control vs variant-a -> cache objects độc lặp -> PASS
  - SEGMENT:   guest vs returning (homefeed) -> cache objects độc lặp -> PASS

  - Tat ca variant_first requests = MISS (không LEAKAGE)
  - Tat ca variant_second requests = HIT (CACHE hoạt động)
  - Tat ca X-Cache-Key-* headers = expected (NORMALIZATION dụng)
  - checks = 100%

=> CDN cache key bao gom đầy đủ 5 variant dimensions.
   variant isolation được chứng minh chỗ từng dimension mot cách độc lặp.
   sẵn sàng phục vụ nhiêu phân khúc người dùng khac nhau cùng lúc.
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
