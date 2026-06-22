# Case 08: TTL Expiry -- Hết Hạn Thời Gian Sống Của Object Cache

> **Case ID:** `cdn-08-ttl-expiry`
> **Script:** `08-ttl-expiry.js`
> **Layer:** CDN / Varnish
> **Proof:** `MISS -> HIT -> wait TTL -> MISS -> HIT` -- chứng minh object hết TTL phải về origin fetch lại
> **VUs:** 1 | **Iterations:** 1 | **Thời gian chạy:** ~22-25 giây (phụ thuộc TTL_WAIT_SECONDS)

---

## 1. Tình huống thực tế

### 1.1. Mọi object cache đều có "ngày hết hạn"

Khi bạn mua một hộp sữa tươi, trên bao bì có ghi "HSD: 25/06/2026". Trước
ngày đó, sữa vẫn uống được. Sau ngày đó, sữa hết hạn -- bạn phải mua hộp mới.

Cache của CDN hoạt động giống hệt như vậy:

```text
Object được lưu vào cache ở t=0, TTL=20s:
  t=0s:    object MỚI (fresh)        -- HIT
  t=5s:    object VẪN fresh          -- HIT
  t=19s:   object VẪN fresh          -- HIT
  t=20s:   object HẾT HẠN (stale)    -- thời khắc chuyển giao
  t=20.1s: request tiếp theo -> MISS  -- phải về origin lấy object mới
  t=20.5s: object MỚI được cache     -- HIT cho đến TTL tiếp theo
```

TTL (Time-To-Live) là thông số nền tảng nhất của mọi hệ thống cache. Nó quyết
định: **bao lâu thì object trong cache được coi là "còn tươi"**. Khi object
còn tươi, request được phục vụ trực tiếp từ cache mà không cần chạm vào
origin. Khi object hết tươi, request tiếp theo phải về origin để lấy bản
copy mới.

### 1.2. Bài toán đánh đổi cốt lõi của TTL

Chọn TTL là một quyết định kỹ thuật có hậu quả kinh doanh trực tiếp:

```text
TTL QUÁ NGẮN:                     TTL QUÁ DÀI:
  object hết hạn nhanh               object ở cache lâu
  -> nhiều request MISS              -> ít MISS, origin nhàn
  -> origin bị quá tải               -> NHƯNG: user có thể thấy data cũ
  -> latency tăng vì về origin       -> thay đổi giá không hiển thị kịp
  -> cost origin infrastructure      -> hết hàng nhưng cache vẫn hiện "còn"
     tăng cao                           -> khách đặt hàng rồi bị cancel

Ví dụ thực tế:
  Homefeed TTL=5s:  origin chịu 1 request mỗi 5 giây cho mỗi variant
                    -> 12 req/phút/variant -> 60 req/phút cho 5 variant
                    -> origin OK, nhưng CDN hit ratio thấp

  Homefeed TTL=300s: origin chịu 1 request mỗi 5 phút cho mỗi variant
                    -> 0.2 req/phút/variant -> origin rất nhàn
                    -> NHƯNG: user thấy homefeed "đơ" 5 phút sau khi
                       admin cập nhật sản phẩm mới
                    -> flash sale bắt đầu, cache vẫn hiển thị giá cũ
```

Đây là tradeoff kinh điển giữa **freshness** (độ tươi của dữ liệu) và
**offload** (giảm tải cho origin). Không có con số ma thuật nào đúng cho
mọi trường hợp.

### 1.3. Homefeed: case study về TTL quyết định trải nghiệm

Homefeed (`/api/sim/products/homefeed`) là API quan trọng bậc nhất -- nó là
màn hình đầu tiên user nhìn thấy khi mở app. Đặc điểm:

```text
Tần suất truy cập:        CỰC CAO -- mọi user mở app đều gọi
Số lượng variant cache:   5 (language x geo x device x ab x segment)
Tần suất cập nhật nội dung: trung bình (vài phút/lần)
Hậu quả nếu data cũ:       user thấy sản phẩm sai, giá sai, khuyến mãi hết hạn
Hậu quả nếu origin quá tải: app load chậm, user thoát app
```

Varnish được cấu hình với TTL mặc định **20 giây** cho homefeed:

```text
VCL: vcl_backend_response, line 241-243:
  } elseif (bereq.url ~ "^/api/sim/products/homefeed($|\\?)") {
      set beresp.ttl = 20s;
  }
```

Con số 20s được chọn vì:
- Đủ ngắn để admin cập nhật nội dung hiển thị trong vòng <1 phút
- Đủ dài để hấp thụ phần lớn traffic (với 1000 req/s, chỉ ~1 req/20s về origin cho mỗi variant)
- Grace 120s: nếu origin chết, vẫn serve object cũ tối đa 2 phút

### 1.4. Điều gì xảy ra khi TTL KHÔNG hoạt động?

```text
Tình huống 1: TTL hiệu quả = vô hạn (object không bao giờ hết hạn)
  - Admin cập nhật sản phẩm mới lúc 10:00
  - Lúc 10:05, user vẫn thấy homefeed cũ (không có sản phẩm mới)
  - Lúc 10:30, user vẫn thấy homefeed cũ
  - Lý do: Cache-Control header bị ghi đè, hoặc Varnish không tôn trọng TTL
  - Hậu quả: data stale vĩnh viễn, ban-url thủ công mới fix được

Tình huống 2: TTL = 0 (object không bao giờ được cache)
  - Mọi request đều MISS
  - Origin chịu toàn bộ traffic
  - CDN thành proxy trong suốt, không có tác dụng cache
  - Hậu quả: origin quá tải khi traffic tăng

Tình huống 3: TTL không ổn định (lúc 10s, lúc 60s)
  - Object bị evict sớm do memory pressure
  - Hoặc response từ origin có Cache-Control không nhất quán
  - Hậu quả: hit ratio dao động, khó dự đoán origin load
```

### 1.6. Hậu quả kinh doanh khi TTL bị cấu hình sai

TTL không phải là thông số kỹ thuật thuần túy. Khi TTL sai, business bị
ảnh hưởng trực tiếp:

```text
TÌNH HUỐNG KINH DOANH 1: FLASH SALE -- TTL quá dài
  - 09:55: Admin set up flash sale, cập nhật giá sản phẩm trong CMS
  - 09:58: CDN cache homefeed (TTL=300s, hết hạn lúc 10:03)
  - 10:00: Flash sale BẮT ĐẦU
  - 10:00:05: User A mở app -> request homefeed -> HIT (cache từ 09:58)
           -> HOME FEED KHÔNG HIỂN THỊ FLASH SALE
  - 10:00:10: User B mở app -> cũng HIT -> cũng không thấy flash sale
  - 10:00:30: User C mở app -> HIT -> không thấy
  - 10:03:00: Cache hết hạn -> user D mới thấy flash sale
  - HẬU QUẢ: 3 phút đầu của flash sale = 0 conversion từ organic traffic
             Mất ~20% doanh thu dự kiến của đợt sale

TÌNH HUỐNG KINH DOANH 2: HẾT HÀNG -- TTL quá dài
  - 14:00: Sản phẩm X còn 5 cái, hiển thị trên homefeed
  - 14:01: CDN cache homefeed (TTL=120s, hết hạn lúc 14:03)
  - 14:01:30: 5 khách đặt hàng -> hết hàng
  - 14:02:00: User F mở app -> request homefeed -> HIT (cache từ 14:01)
           -> VẪN HIỂN THỊ sản phẩm X là "còn hàng"
  - 14:02:10: User F bấm mua -> vào product detail -> HIT (cache cũ)
           -> Vẫn hiển thị "thêm vào giỏ"
  - 14:02:20: User F add to cart -> request POST -> MISS (qua CDN)
           -> Backend trả về: "sản phẩm hết hàng"
  - User F: "Tao thấy còn hàng mà sao không cho mua???"
  - HẬU QUẢ: Customer complaint, trust erosion, potential chargeback

TÌNH HUỐNG KINH DOANH 3: SỬA GIÁ KHẨN CẤP -- TTL quá ngắn cũng không đủ
  - 11:00: Admin phát hiện giá sai (100K thay vì 1M)
  - 11:01: Admin sửa giá trong CMS, ban-url CDN
  - 11:01:05: Cache sạch -> request mới -> MISS -> fetch giá đúng
  - NHƯNG: Nếu TTL=1s mà không có ban-url:
    - 1000 req/s -> 1000 MISS/s (vì TTL=1s, object hết hạn liên tục)
    - Origin bị quá tải -> timeout -> 503
    - User thấy lỗi thay vì thấy giá đúng
  - HẬU QUẢ: Dù admin đã sửa, user vẫn không mua được vì origin sập
```

### 1.7. TTL trong bối cảnh multi-layer caching

```text
HTTP request journey qua các tầng cache:

  Browser Cache  -- max-age (thường dài: 60-300s)
       |
       v (nếu browser cache miss hoặc hết hạn)
  CDN Cache      -- s-maxage (thường trung bình: 10-60s)
       |            + CDN-Cache-Control (dành riêng cho CDN)
       v (nếu CDN cache miss hoặc hết hạn)
  App Cache       -- internal cache (vd: Redis TTL)
       |
       v (nếu app cache miss)
  Database        -- source of truth

Mỗi tầng có TTL riêng, phục vụ mục đích riêng:
  - Browser: giảm network request, tăng UX (load tức thì)
  - CDN:     giảm origin load, giảm latency địa lý, chịu tải scale-out
  - App:     giảm DB load, tăng response time

Khi TTL CDN bị sai:
  - Nếu CDN TTL > Browser TTL: browser miss -> CDN HIT -> user vẫn thấy data cũ
    Dù browser đã cố refresh
  - Nếu CDN TTL = 0: mọi request thành CDN MISS -> CDN thành proxy trong suốt
    Mất toàn bộ lợi ích của CDN
```

### 1.5. Tại sao cần test TTL expiry?

Không thể "đọc config" rồi kết luận TTL hoạt động đúng. Cần chứng minh bằng
thực nghiệm:

```text
Đọc config:        "Varnish set beresp.ttl = 20s" -> TTL=20s TRÊN GIẤY
Thực tế có thể:    app trả về Cache-Control: s-maxage=60 -> TTL=60s THỰC TẾ
                   (Varnish ưu tiên s-maxage từ origin hơn default VCL)
Hoặc:              object bị evict sau 2s do memory đầy
                   -> TTL thực tế = 2s, không phải 20s

Test mới trả lời:  object CÓ thực sự sống đúng 20s không?
                   Sau 20s, object CÓ thực sự hết hạn không?
                   Sau khi hết hạn, request mới CÓ tạo object mới không?
```

---

## 2. CDN capability being proved -- Năng lực CDN được chứng minh

### 2.1. Vòng đời TTL đầy đủ

Case này chứng minh **vòng đời hoàn chỉnh** của một object cache qua các giai
đoạn freshness:

```text
TRẠNG THÁI 1: COLD -- chưa có object trong cache
  Request đầu tiên -> MISS -> Varnish fetch từ origin
  -> Object được lưu vào cache với TTL=N giây
  -> X-Cache: MISS, X-Cache-Age: 0

TRẠNG THÁI 2: FRESH -- object còn trong TTL
  Request thứ hai (t < TTL) -> HIT -> Varnish trả object từ cache
  -> X-Cache: HIT, X-Cache-Age: t (số giây object đã sống)
  -> ĐIỀU KIỆN CẦN: phải là HIT. Nếu không phải HIT, cache không hoạt động.

TRẠNG THÁI 3: EXPIRED -- object vượt quá TTL
  Chờ TTL+1 giây để ĐẢM BẢO object đã hết hạn
  Request thứ ba (t > TTL) -> MISS -> Varnish fetch từ origin bản mới
  -> X-Cache: MISS, X-Cache-Age: 0 (object mới)
  -> ĐIỀU KIỆN ĐỦ: MISS sau TTL chứng minh TTL thực sự có hiệu lực

TRẠNG THÁI 4: RE-FRESH -- object mới được cache
  Request thứ tư (sau MISS) -> HIT -> object mới đã vào cache
  -> X-Cache: HIT
  -> ĐIỀU KIỆN HOÀN CHỈNH: object mới cũng phải cache được
```

### 2.2. Điều làm case này đặc biệt: REAL TIME WAITING

Hầu hết các CDN case khác (01-hit-smoke, 02-variant-keys, 05-invalidation-ops)
chỉ cần vài request liên tiếp trong <1 giây để chứng minh behavior. Case 08
là một trong số ít case **bắt buộc phải dùng sleep() với thời gian thực**:

```text
So sánh:
  Case 01 (hit-smoke):        MISS -> HIT         (0.1s)
  Case 05 (invalidation):     HIT -> ban -> MISS  (0.5s)
  Case 08 (ttl-expiry):       HIT -> sleep(21s) -> MISS  (21+ giây)

Tại sao bắt buộc phải đợi?
  - Không có API nào để "tua nhanh thời gian" của Varnish
  - Không thể giả lập TTL hết hạn nếu không đợi thật
  - Đây là bản chất của TTL: nó là một TIMING CONTRACT
  - Muốn chứng minh contract đúng -> phải để thời gian trôi qua thật
```

### 2.3. Phân biệt với invalidation chủ động

```text
TTL Expiry (case này):            Invalidation (case 05/06):
  Không ai chạm vào cache           Có lệnh PURGE/BAN từ control plane
  Thời gian tự trôi                  Hành động chủ động xóa object
  Object tự hết hạn                  Object bị xóa cưỡng bức
  Cơ chế thụ động                    Cơ chế chủ động
  Chứng minh: TTL config đúng        Chứng minh: ban/purge hoạt động
```

Cả hai đều dẫn đến MISS, nhưng cơ chế khác nhau hoàn toàn. Một hệ thống có
thể ban/purge hoạt động tốt nhưng TTL không hoạt động (object không tự hết
hạn). Case 08 là case DUY NHẤT trong bộ CDN kiểm tra cơ chế thụ động này.

---

## 3. Vì sao test ở CDN layer

### 3.1. App tuyên bố -- CDN thực thi

Application có thể set Cache-Control header trong response:

```text
App trả về:
  HTTP/1.1 200 OK
  Cache-Control: public, s-maxage=20

App ĐANG NÓI: "Object này nên được cache shared cache trong 20 giây"

Nhưng app không phải là người thực thi cache. App chỉ là người đưa ra
KHUYẾN NGHỊ. Chính CDN/Varnish mới là người QUYẾT ĐỊNH:
  - Có cache object này không?
  - Cache trong bao lâu?
  - Có tôn trọng s-maxage không?
  - Hay ghi đè bằng giá trị khác?
```

### 3.2. Những thứ CHỈ test được ở CDN layer

| Khía cạnh | Test ở app layer | Test ở CDN layer |
| --- | --- | --- |
| Cache-Control header có mặt trong response | Có -- check response header | Có |
| Object có được cache thật không | KHÔNG -- app không biết Varnish có cache không | CÓ -- X-Cache: HIT là bằng chứng |
| Object sống đúng TTL không | KHÔNG -- app không quản lý cache TTL | CÓ -- đợi TTL rồi request lại |
| Object có bị evict sớm không | KHÔNG | CÓ |
| Grace/stale behavior | KHÔNG | CÓ |
| Cache key isolation có đúng không | KHÔNG | CÓ |
| Timing chính xác của TTL | KHÔNG | CÓ |

### 3.3. Timing-dependent behavior không thể test ở tầng thấp hơn

```text
Test ở app layer:
  - Gọi API, check status 200, check response body đúng
  - KHÔNG THỂ kiểm tra: sau 20s object còn HIT không?
  - Vì app không có khái niệm "cache HIT/MISS"

Test ở CDN layer:
  - Gọi qua Varnish, đọc X-Cache header
  - Đợi > TTL giây
  - Gọi lại, kiểm tra X-Cache chuyển từ HIT sang MISS
  - Đây là PROOF thực nghiệm, không phải suy diễn từ config

Kết luận: Bất kỳ test nào liên quan đến THỜI GIAN SỐNG của object cache
đều PHẢI chạy ở CDN layer. App layer mù với khái niệm cache timing.
```

### 3.4. CDN là "người gác cổng" của freshness contract

```text
                      CDN Edge
User ----request----> [Varnish] ----MISS----> Origin (App)
                      |    |
                      |    +-- object cache (TTL=20s, grace=120s)
                      |
                      +-- Quyết định: HIT hay MISS?
                      +-- Quyết định: object còn tươi không?
                      +-- Quyết định: có serve stale không?

Contract: "Tôi (CDN) cam kết object này sẽ được cache trong 20 giây,
          sau đó sẽ về origin fetch bản mới. Nếu origin chết, tôi
          sẽ serve stale trong tối đa 120 giây."

Case 08 kiểm tra dòng thứ hai của contract này.
```

---

## 4. Topology và precondition

### 4.1. Runtime path

```text
PUBLIC PATH (chứng minh cache behavior):
  k6 -> http://localhost:80 -> Varnish -> Nginx -> products-service
  |
  +-- Test request đi qua Varnish để đọc X-Cache (HIT/MISS)

CONTROL PATH (chuẩn bị trạng thái ban đầu):
  k6 -> http://localhost:8088 -> control plane -> Varnish BAN
  |
  +-- Dùng để ban-url homefeed, đảm bảo COLD START

EVENT PATH:
  http://localhost:9091 -> catalog-events mock
  |
  +-- Không dùng trong case này (TTL là cơ chế thụ động)
```

### 4.2. Các thành phần tham gia

```text
k6 script (08-ttl-expiry.js)
  |
  +-- setup():     banUrl(paths.homefeed) qua CONTROL path
  +-- default():   requestCdn() qua PUBLIC path
  |                sleep(TTL_WAIT_SECONDS)
  |                requestCdn() qua PUBLIC path
  |
  +-- Assertions:  assertCacheState(first,  'MISS')
                   assertCacheState(second, 'HIT')
                   assertCacheState(afterExpiry, 'MISS')
```

### 4.3. Điều kiện tiên quyết

```text
1. TOPOLOGY: TargetLayer = full
   - Varnish đang chạy và khỏe mạnh
   - Nginx + products-service khỏe mạnh
   - Control plane (:8088) khả dụng

2. TRẠNG THÁI BAN ĐẦU:
   - Homefeed object bị xóa khỏi cache (qua ban-url trong setup)
   - HOẶC: object chưa từng tồn tại (cache lạnh)
   - Mục tiêu: đảm bảo request đầu tiên là COLD MISS

3. THAM SỐ THỜI GIAN:
   - TTL_WAIT_SECONDS > TTL thực tế của object
   - Với homefeed, Varnish set TTL=20s
   - TTL_WAIT_SECONDS mặc định = 21s (20s + 1s buffer)
   - Nếu TTL_WAIT_SECONDS <= 20s: object chưa hết hạn -> test SAI

4. KHÔNG CÓ CAN THIỆP SONG SONG:
   - Không chạy case CDN khác đồng thời (dùng chung cache)
   - Không có ai ban/purge homefeed giữa chừng
   - Không có ai request homefeed với header khác (tạo variant mới)
```

### 4.4. TTL_WAIT_SECONDS -- tham số quyết định

```text
TTL_WAIT_SECONDS = envFloat('TTL_WAIT_SECONDS', 21)

Default = 21s vì:
  - Varnish TTL cho homefeed = 20s
  - 21s = 20s + 1s BUFFER = đảm bảo object đã hết hạn
  - 1s buffer bù cho: network latency, k6 sleep jitter, clock skew

Nếu thay đổi TTL của object (qua Cache-Control header từ app):
  -> phải cập nhật TTL_WAIT_SECONDS tương ứng
  -> TTL_WAIT_SECONDS = TTL_mới + buffer (tối thiểu 1s)

Nếu TTL_WAIT_SECONDS quá ngắn:
  -> object chưa kịp hết hạn -> assertCacheState(afterExpiry, 'MISS') FAIL
  -> kết quả: vẫn HIT, test fail không phải do code sai mà do config sai
```

---

## 5. Script deep-dive

### 5.1. Toàn cảnh script (47 dòng -- ngắn nhất bộ CDN)

Script `08-ttl-expiry.js` là script ngắn nhất trong toàn bộ CDN suite, nhưng
mang sức nặng logic lớn nhất vì nó có yếu tố **thời gian thực**:

```text
Cấu trúc script:
  imports:      sleep (k6), shared helpers
  options:      vus=1, iterations=1, checks rate=1
  setup():      ban-url homefeed -> COLD START
  default():    4 request + 1 sleep -> MISS->HIT->sleep->MISS sequence
```

Điểm đặc biệt:
- **VUs=1, iterations=1**: Đây là single-run precise test, không phải load test
- **checks rate=1**: MỌI check đều phải pass (không chấp nhận sai sót)
- **Thời gian chạy ~22-25s**: Phần lớn thời gian là sleep()

### 5.2. setup() -- Chuẩn bị cold start

```javascript
export function setup() {
  banUrl(paths.homefeed);
}
```

Mục đích: Đảm bảo cache LẠNH trước khi test bắt đầu.

```text
Logic:
  - Gửi POST đến control path: /ops/app/cdn/cache/ban-url
  - Payload: { url: "/api/sim/products/homefeed" }
  - Varnish nhận BAN request -> thêm ban rule: "req.url == /api/sim/products/homefeed"
  - Object khớp ban rule bị đánh dấu invalid -> request tiếp theo sẽ MISS
  - Nếu không có dòng này, object có thể đã có trong cache từ lần chạy trước
    -> request đầu tiên sẽ là HIT thay vì MISS -> test sai từ bước 1

Tại sao dùng ban-url thay vì purge?
  - Purge: xóa chính xác 1 object cache (yêu cầu hash key đúng)
  - Ban-url: thêm rule cấm, mọi request khớp URL sẽ MISS lần đầu
  - Ban-url an toàn hơn vì không phụ thuộc cache key calculation
```

### 5.3. Bước 1 -- Request đầu tiên: COLD MISS

```javascript
const first = requestCdn('GET', paths.homefeed, {
  profile,
  tags: { case: 'homefeed_first' },
});
assertStatus(first, 200, 'homefeed first');
assertUpstream(first, 'products-service', 'homefeed first');
assertCacheState(first, 'MISS', 'homefeed first');
```

```text
Điều xảy ra trong Varnish:
  1. k6 gửi GET /api/sim/products/homefeed qua port 80
  2. Varnish lookup cache: không tìm thấy object (vừa bị ban)
  3. Varnish forward request đến Nginx -> products-service
  4. Origin trả về 200 OK với Cache-Control: s-maxage=20
  5. Varnish lưu object vào cache: ttl=20s, grace=120s, keep=600s
  6. Varnish trả response cho k6 với X-Cache: MISS

Assertions kiểm tra:
  - Status phải là 200
  - Upstream phải là products-service (xác nhận request ĐÃ đến origin)
  - X-Cache phải là MISS (xác nhận object CHƯA có trong cache)
```

### 5.4. Bước 2 -- Request thứ hai: FRESH HIT

```javascript
const second = requestCdn('GET', paths.homefeed, {
  profile,
  tags: { case: 'homefeed_second' },
});
assertStatus(second, 200, 'homefeed second');
assertCacheState(second, 'HIT', 'homefeed second');
```

```text
Điều xảy ra trong Varnish:
  1. Request thứ hai đến, thời gian < 1s sau request đầu
  2. Varnish lookup cache: TÌM THẤY object (vừa lưu ở bước 1)
  3. Object còn tươi: obj.ttl > 0s, chưa hết hạn (mới <1s tuổi)
  4. Varnish trả object từ cache, KHÔNG forward đến origin
  5. X-Cache: HIT, X-Cache-Hits: 1 (hoặc cao hơn nếu có request khác)

Đây là bằng chứng quan trọng:
  - Object ĐÃ được cache thành công
  - Chỉ mất 1 MISS để warm cache
  - Từ giây phút này, mọi request giống hệt sẽ là HIT (trong 20s tới)

LƯU Ý: Không assert Upstream ở bước này vì HIT không tạo upstream request
```

### 5.5. Bước 3 -- SLEEP: Chờ TTL hết hạn

```javascript
sleep(TTL_WAIT_SECONDS);  // mặc định 21 giây
```

```text
ĐÂY LÀ DÒNG CODE QUAN TRỌNG NHẤT CỦA TOÀN BỘ SCRIPT.

Tại sao phải sleep()?
  - Không có cách nào "tua nhanh" đồng hồ của Varnish
  - TTL là cơ chế dựa trên THỜI GIAN THỰC
  - Muốn chứng minh object hết hạn -> phải ĐỢI THẬT

Điều xảy ra trong 21 giây này:
  - k6 thread bị block (không làm gì)
  - Varnish vẫn chạy bình thường
  - Object trong cache đang "già đi":
    t=0s:  obj.ttl = 20s   (vừa được cache)
    t=5s:  obj.ttl = 15s   (còn 15s)
    t=10s: obj.ttl = 10s   (còn 10s)
    t=15s: obj.ttl = 5s    (còn 5s)
    t=19s: obj.ttl = 1s    (sắp hết hạn)
    t=20s: obj.ttl = 0s    (HẾT HẠN -- nhưng vẫn còn trong cache nhờ grace)
    t=21s: obj.ttl = -1s   (đã hết hạn 1 giây)
           -> request tiếp theo: vcl_hit kiểm tra obj.ttl >= 0s -> FALSE
           -> return(pass) -> MISS
```

### 5.6. Bước 4 -- Request sau TTL: EXPIRED MISS

```javascript
const afterExpiry = requestCdn('GET', paths.homefeed, {
  profile,
  tags: { case: 'homefeed_after_expiry' },
});
assertStatus(afterExpiry, 200, 'homefeed after expiry');
assertUpstream(afterExpiry, 'products-service', 'homefeed after expiry');
assertCacheState(afterExpiry, 'MISS', 'homefeed after expiry');
```

```text
Điều xảy ra trong Varnish:
  1. Varnish lookup cache: TÌM THẤY object (vẫn còn nhờ grace/keep)
  2. vcl_hit: obj.ttl = -1s -> KHÔNG thỏa obj.ttl >= 0s
  3. Backend healthy -> không serve stale
  4. return(pass) -> forward request đến origin
  5. Origin trả về object mới -> Varnish cache lại với TTL=20s mới
  6. X-Cache: MISS

ĐÂY LÀ PROOF: TTL thực sự có hiệu lực.
  - Object cũ đã hết hạn sau 20s
  - Request mới buộc phải về origin (MISS)
  - Object mới được cache với TTL mới

Assertions kiểm tra:
  - Status vẫn 200 (origin vẫn hoạt động)
  - Upstream = products-service (đã forward đến origin)
  - X-Cache = MISS (object cũ hết hạn, object mới được fetch)
```

### 5.7. Sơ đồ dòng thời gian đầy đủ

```text
TIMELINE:
t=-1s    setup(): banUrl(homefeed) -> xóa object nếu có
t=0s     request #1 -> MISS -> object A được cache (TTL_A=20s)
t=0.1s   request #2 -> HIT  -> object A còn tươi
         ...
         [sleep 21 giây -- object A đang già đi]
         ...
t=21.1s  request #3 -> MISS -> object A hết hạn
                                -> Varnish fetch object B từ origin
                                -> object B được cache (TTL_B=20s)
t=21.2s  (nếu có request #4) -> HIT -> object B còn tươi

KẾT QUẢ MONG ĐỢI:
  X-Cache sequence: MISS -> HIT -> MISS
  Đây là chuỗi duy nhất chứng minh TTL hoạt động đúng.
```

---

## 6. TTL model deep-dive -- THE STAR SECTION

### 6.1. Cache-Control: Ngôn ngữ freshness của HTTP

HTTP Cache-Control là cơ chế chuẩn để origin (app) giao tiếp freshness
contract với cache trung gian (CDN). Các directive quan trọng:

```text
Cache-Control: public, max-age=60, s-maxage=20

  public:         "Object này cache được bởi mọi cache" (cả browser và CDN)
  private:        "Chỉ browser được cache, CDN không được"
  no-store:       "Không ai được cache"
  no-cache:       "Cache được nhưng phải revalidate trước khi dùng"

  max-age=60:     "Browser cache object này 60 giây"
                  -> CDN CÓ THỂ dùng max-age nếu không có s-maxage
                  -> NHƯNG: max-age chủ yếu cho browser

  s-maxage=20:    "SHARED cache (CDN) cache object này 20 giây"
                  -> GHI ĐÈ max-age cho shared cache
                  -> Đây là directive QUAN TRỌNG NHẤT cho CDN

  stale-while-revalidate=120: "Được phép serve stale 120s trong khi
                               async refresh object mới từ origin"
  stale-if-error=300: "Được phép serve stale 300s nếu origin lỗi"
```

### 6.2. Hệ thống phân cấp: s-maxage vs max-age vs CDN-Cache-Control

```text
ĐỘ ƯU TIÊN KHI TÍNH TTL CHO CDN (Varnish):

1. CDN-Cache-Control: s-maxage=N    <-- CAO NHẤT: header dành riêng cho CDN
   |
   +-- Nếu response có header này, Varnish DÙNG NÓ trước tất cả
   +-- Đây là cách app "nói chuyện riêng" với CDN mà không ảnh hưởng browser
   +-- Ví dụ: CDN-Cache-Control: s-maxage=30
       -> CDN cache 30s, browser vẫn theo Cache-Control: max-age=60

2. Cache-Control: s-maxage=N         <-- THỨ HAI: cho shared cache nói chung
   |
   +-- Nếu không có CDN-Cache-Control, Varnish dùng s-maxage từ Cache-Control
   +-- s-maxage ghi đè max-age cho CDN

3. Cache-Control: max-age=N          <-- THỨ BA: fallback cho mọi cache
   |
   +-- Nếu không có s-maxage, Varnish dùng max-age

4. Expires header (deprecated)       <-- THỨ TƯ: HTTP/1.0 fallback
   |
   +-- Tính TTL = Expires - Date

5. VCL default TTL                   <-- THẤP NHẤT: hardcoded trong VCL
   |
   +-- Chỉ dùng khi origin KHÔNG set bất kỳ header nào ở trên
   +-- Với homefeed: set beresp.ttl = 20s (dòng 243 default.vcl)
```

### 6.3. Cách Varnish tính TTL -- beresp.ttl

Trong `vcl_backend_response`, Varnish tính TTL cho object theo logic sau:

```text
Mặc định (trước khi VCL can thiệp):
  beresp.ttl được tính tự động từ response headers của origin:
    1. CDN-Cache-Control: s-maxage=N  -> beresp.ttl = N
    2. Cache-Control: s-maxage=N       -> beresp.ttl = N
    3. Cache-Control: max-age=N        -> beresp.ttl = N
    4. Expires                         -> beresp.ttl = Expires - Date
    5. Không có gì                     -> beresp.ttl = default_ttl (120s)

Sau đó, VCL CÓ THỂ ghi đè:
  if (beresp.ttl <= 0s) {
      // Origin không set TTL, hoặc set TTL <= 0
      // VCL set default TTL dựa trên URL pattern
  }

HOME FEED CỤ THỂ:
  Nếu app trả về Cache-Control: s-maxage=60:
    -> beresp.ttl = 60s (từ header, không vào nhánh default)
    -> VCL không ghi đè vì beresp.ttl > 0s
  Nếu app KHÔNG trả về Cache-Control:
    -> beresp.ttl = 120s (Varnish default)
    -> NHƯNG VCL ghi đè: if (beresp.ttl <= 0s) -> FALSE (120s > 0s)
    -> Thực ra check là "if (beresp.ttl <= 0s)" chỉ trigger khi <=0
    -> Vậy nếu app không set header, TTL = 120s chứ không phải 20s!

ĐIỂM TINH TẾ: VCL default `set beresp.ttl = 20s` chỉ được áp dụng khi
beresp.ttl <= 0s. Nếu app set s-maxage, VCL default không có tác dụng.
Đây là lý do test TTL expiry quan trọng: nó xác minh TTL THỰC TẾ, không
phải TTL TRONG CONFIG.
```

### 6.4. Ba giai đoạn trong vòng đời object cache

```text
GIAI ĐOẠN 1: FRESH (obj.ttl > 0s)
  obj.ttl = 20s (t=0s)
  obj.ttl = 15s (t=5s)
  obj.ttl = 1s  (t=19s)
  obj.ttl = 0s  (t=20s) -- ranh giới fresh/stale
  |
  +-- vcl_hit: obj.ttl >= 0s -> deliver (HIT)
  +-- Object được trả về với X-Cache: HIT
  +-- Age header tăng dần theo thời gian object đã sống

GIAI ĐOẠN 2: GRACE (obj.ttl + obj.grace > 0s, obj.ttl <= 0s)
  obj.ttl = -1s,  obj.grace = 120s -> obj.ttl + obj.grace = 119s > 0
  obj.ttl = -50s, obj.grace = 120s -> obj.ttl + obj.grace = 70s > 0
  obj.ttl = -120s, obj.grace = 120s -> obj.ttl + obj.grace = 0s -- hết grace
  |
  +-- vcl_hit: obj.ttl >= 0s -> FALSE
  +-- KIỂM TRA: !std.healthy(backend) && obj.ttl + obj.grace > 0s
  +-- Nếu backend UNHEALTHY: serve stale (X-Cache-Stale: true)
  +-- Nếu backend HEALTHY (như case này): return(pass) -> MISS
  +-- Đây là cơ chế "stale-while-revalidate" ở tầng CDN

GIAI ĐOẠN 3: KEEP (obj.ttl + obj.keep > 0s, obj.ttl + obj.grace <= 0s)
  obj.ttl = -130s, obj.grace = 120s, obj.keep = 600s
  -> obj.ttl + obj.grace = -10s (hết grace)
  -> obj.ttl + obj.keep = 470s > 0
  |
  +-- Varnish KHÔNG serve object này cho request
  +-- Nhưng VẪN GIỮ trong cache để:
      - Conditional request (If-Modified-Since, If-None-Match)
      - Có thể trả 304 Not Modified nếu object không thay đổi
  +-- Khi obj.ttl + obj.keep <= 0: object bị xóa khỏi cache hoàn toàn
```

### 6.5. Sơ đồ trực quan vòng đời object cache

```text
         obj.ttl              obj.grace            obj.keep
    |<--- 20s --->|<-------- 120s -------->|<-------- 600s --------->|
    |             |                        |                          |
t=0 tạo object   t=20 hết ttl             t=140 hết grace           t=740 xóa object
    |             |                        |                          |
    |   FRESH     |       GRACE            |          KEEP            |
    |   HIT       |  serve nếu backend     |  chỉ 304, không serve    |
    |             |  unhealthy             |  đầy đủ                  |
    |             |  (stale-while-error)   |                          |
    |             |  nếu healthy -> MISS   |                          |
    |             |                        |                          |
    X-Cache: HIT  X-Cache-Stale: true      (object "vô hình" với      |
                  (chỉ khi unhealthy)       request thông thường)     |
```

### 6.6. Grace mode và stale-while-revalidate

Grace mode là tính năng quan trọng cho high availability:

```text
Scenario: Origin chết khi object vừa hết TTL

Không có grace:
  t=21s: object hết TTL -> request đến -> Varnish forward -> origin timeout
  -> user thấy lỗi 503
  -> MỌI request tiếp theo cũng 503

Có grace (grace=120s):
  t=21s: object hết TTL -> request đến
  -> vcl_hit: obj.ttl >= 0s? FALSE (ttl=-1s)
  -> std.healthy(backend)? FALSE (origin đang chết)
  -> obj.ttl + obj.grace > 0s? TRUE (-1 + 120 = 119 > 0)
  -> set X-Cache-Stale: true
  -> return(deliver) -- serve object cũ thay vì báo lỗi
  -> user VẪN THẤY dữ liệu (dù hơi cũ), thay vì màn hình lỗi

Đây là "stale-while-revalidate" ở tầng CDN:
  - Origin chết -> serve stale (chấp nhận data cũ còn hơn không có gì)
  - Origin sống lại -> request tiếp theo MISS -> fetch object mới
  - Case 09 (stale-while-error) sẽ test kỹ hơn grace mode này
```

### 6.7. VCL TTL handling -- phân tích từng dòng

```text
# default.vcl -- vcl_backend_response

# Dòng 205-209: Lỗi 5xx -> không cache
if (beresp.status >= 500) {
    set beresp.ttl = 0s;
    set beresp.uncacheable = true;
}

# Dòng 211-218: 404/410 -> negative cache (TTL tối thiểu 15s nếu chưa set)
if (beresp.status == 404 || beresp.status == 410) {
    if (beresp.ttl <= 0s) {
        set beresp.ttl = 15s;
    }
    set beresp.grace = 30s;
    set beresp.keep = 120s;
}

# Dòng 221-225: Response có Set-Cookie -> không cache
if (beresp.http.Set-Cookie) {
    set beresp.ttl = 0s;
    set beresp.uncacheable = true;
}

# Dòng 227-231: Cache-Control: no-store|private -> không cache
if (beresp.http.Cache-Control ~ "(?i)no-store|private") {
    set beresp.ttl = 0s;
    set beresp.uncacheable = true;
}

# Dòng 234-250: DEFAULT TTLs khi origin KHÔNG set header cache
if (beresp.ttl <= 0s) {
    # ... các URL pattern với TTL khác nhau
    # homefeed: set beresp.ttl = 20s;  <-- DEFAULT
}

# Dòng 252-258: Nếu object được cache -> set grace và keep
if (beresp.ttl > 0s) {
    set beresp.grace = 120s;
    set beresp.keep = 600s;
} else {
    set beresp.uncacheable = true;
}
```

### 6.8. VCL hit -- quyết định cuối cùng: HIT hay MISS

```text
# default.vcl -- vcl_hit

sub vcl_hit {
    # TRƯỜNG HỢP 1: Object còn tươi (ttl >= 0)
    if (obj.ttl >= 0s) {
        return (deliver);  # -> HIT
    }

    # TRƯỜNG HỢP 2: Object hết tươi NHƯNG backend không khỏe
    # -> serve stale (grace mode)
    if (!std.healthy(req.backend_hint) && obj.ttl + obj.grace > 0s) {
        set req.http.X-Cache-Stale = "true";
        return (deliver);  # -> HIT (stale)
    }

    # TRƯỜNG HỢP 3: Object hết tươi, backend khỏe
    # -> pass (về origin fetch object mới)
    return (pass);  # -> MISS
}
```

Với case 08:
- Backend luôn healthy (precondition)
- Sau 21s: obj.ttl = -1s -> không thỏa trường hợp 1
- Backend healthy -> không thỏa trường hợp 2
- return(pass) -> trường hợp 3 -> MISS
- Object mới được fetch và cache -> HIT cho đến TTL tiếp theo

---

## 7. Timing precision caveats -- Những cạm bẫy về độ chính xác thời gian

### 7.1. sleep() trong k6 không phải đồng hồ nguyên tử

```text
k6 sleep(TTL_WAIT_SECONDS) HOẠT ĐỘNG NHƯ THẾ NÀO:

1. k6 gọi sleep(21) -> VU thread bị block 21 giây
2. Hệ điều hành scheduler có thể KHÔNG đánh thức thread ĐÚNG 21.000s
3. Thời gian thực tế có thể là 21.001s hoặc 21.050s
4. Sau khi thức dậy, request phải đi qua network stack -> thêm vài ms

Độ trễ tích lũy:
  sleep(21) drift:      ~0-50ms
  DNS resolution:       ~0-5ms (thường đã cached)
  TCP connection:       ~0-1ms (keep-alive, localhost)
  Varnish processing:   ~0-5ms
  Tổng cộng:            ~0-61ms delay sau sleep

Với TTL=20s và sleep(21s):
  Thời gian thực tế từ lúc cache đến lúc request sau sleep:
  = 21s (sleep) + 0-61ms (overhead)
  = 21.000s - 21.061s
  -> Object đã hết hạn ít nhất 1 giây -> AN TOÀN
```

### 7.2. Tại sao TTL_WAIT_SECONDS = TTL + 1, không phải TTL + 0.1?

```text
Nếu dùng TTL_WAIT_SECONDS = 20.1 (TTL + 0.1s):

  Rủi ro 1: sleep drift
    - sleep(20.1) thực tế có thể chỉ ngủ 20.05s
    - Object TTL=20s, mới hết hạn 0.05s
    - Varnish clock có thể lệch vài ms -> object CHƯA hết hạn
    - -> request vẫn HIT -> test FAIL false negative

  Rủi ro 2: Network timing
    - Request đầu tiên mất 5ms để cache object (t=0.005s object được cache)
    - Request thứ hai mất 3ms để lookup (t=0.008s)
    - sleep(20.1) bắt đầu từ t=0.008s
    - Kết thúc sleep: t=20.108s
    - Object được cache lúc t=0.005s, TTL=20s -> hết hạn lúc t=20.005s
    - Request lúc t=20.108s -> object đã hết hạn 0.103s -> OK
    - NHƯNG: nếu sleep bị drift -50ms, network thêm 50ms
    - -> request đến lúc t=20.058s -> object mới hết hạn 0.053s
    - Vẫn OK, nhưng margin RẤT MỎNG

  Rủi ro 3: Clock skew giữa Varnish và k6
    - k6 chạy trên máy host, Varnish trong container
    - Đồng hồ có thể lệch vài ms đến vài chục ms
    - Varnish dùng clock CỦA NÓ để tính obj.ttl
    - Nếu Varnish clock chậm hơn k6 clock 50ms:
      k6 nghĩ đã qua 20.1s, nhưng Varnish nghĩ mới qua 20.05s
      -> object chưa hết hạn trong mắt Varnish -> HIT -> FAIL

Kết luận: TTL_WAIT_SECONDS = TTL + 1s là buffer AN TOÀN.
1 giây dư ra không ảnh hưởng đến tính đúng đắn của test
(chỉ làm test chạy lâu hơn 1 giây), nhưng LOẠI BỎ mọi race condition.
```

### 7.3. Varnish xử lý sub-second TTL như thế nào?

```text
Varnish TTL có độ phân giải đến giây (s), không phải ms.

set beresp.ttl = 0.5s;  -> Varnish làm tròn? Xử lý ra sao?

Thực tế: Varnish hỗ trợ sub-second TTL qua:
  set beresp.ttl = 500ms;  (dùng ms)
  set beresp.ttl = 0.5s;   (dùng giây thập phân)

Tuy nhiên, độ chính xác thực tế bị giới hạn bởi:
  - Varnish internal timer resolution (~10ms)
  - OS scheduler granularity
  - Không nên dựa vào TTL < 1s cho logic nghiệp vụ

Với TTL rất ngắn (< 1s), race condition giữa sleep và TTL là rất cao.
Khuyến nghị: luôn dùng TTL >= 5s cho các test loại này.
```

### 7.4. Race condition: object chưa kịp cache đã hết hạn?

```text
Tình huống giả định:
  - TTL=1s, TTL_WAIT_SECONDS=2
  - Request #1 (MISS) -> Varnish fetch từ origin (mất 800ms)
  - Object được cache lúc t=0.8s
  - Request #2 (HIT) lúc t=0.9s -> HIT
  - sleep(2s) từ t=0.9s -> thức dậy lúc t=2.9s
  - Object hết hạn lúc t=1.8s -> MISS khi request lúc t=2.9s -> OK

Rủi ro:
  - Nếu origin chậm (fetch mất 1.5s)
  - Object được cache lúc t=1.5s, TTL=1s -> hết hạn lúc t=2.5s
  - Request #2 lúc t=1.6s -> VẪN LÀ MISS (vì chưa có object nào fetch xong)
  - Hoặc: object được cache nhưng TTL quá ngắn để test

Bài học: TTL cần đủ dài để:
  1. Cho phép ít nhất 1 HIT sau MISS (xác nhận cache hoạt động)
  2. Có margin an toàn cho sleep drift
  -> TTL >= 10s là an toàn cho loại test này
```

---

## 8. Key signals -- Các tín hiệu quan trọng

### 8.1. X-Cache -- tín hiệu chính

```text
X-Cache header là kết quả ĐẦU RA của toàn bộ logic Varnish:

  X-Cache: MISS  -> object không có trong cache, hoặc đã hết hạn
  X-Cache: HIT   -> object có trong cache và còn tươi

Nguồn (từ default.vcl vcl_deliver):
  if (obj.hits > 0) {
      set resp.http.X-Cache = "HIT";
      set resp.http.X-Cache-Hits = obj.hits;  // số lần object được hit
  } else {
      set resp.http.X-Cache = "MISS";
  }

obj.hits là counter trong Varnish:
  - = 0 khi object vừa được fetch từ origin (MISS)
  - > 0 khi object đã phục vụ ít nhất 1 request từ cache (HIT)
  - TĂNG DẦN theo mỗi lần HIT

Với case 08:
  Request #1: obj.hits = 0 -> X-Cache: MISS
  Request #2: obj.hits = 1 -> X-Cache: HIT, X-Cache-Hits: 1
  Request #3 (sau sleep): obj.hits = 0 (object mới) -> X-Cache: MISS
```

### 8.2. X-Cache-Age -- tuổi của object

```text
X-Cache-Age = Age header từ response
  = thời gian (giây) object đã sống trong cache

Request #2 (trước sleep):
  X-Cache-Age: 0 hoặc 1  (mới cache, <1s tuổi)

Nếu có request #4 ngay sau MISS:
  X-Cache-Age: 0  (object mới, vừa cache lại)

Age header hữu ích để:
  - Xác nhận object thực sự đến từ cache (Age > 0)
  - Debug: Age > TTL nghĩa là object đã quá hạn nhưng vẫn được serve
    -> có thể đang trong grace mode
```

### 8.3. X-Upstream-Service -- xác nhận request đến origin

```text
X-Upstream-Service: products-service

Header này được set bởi Nginx/app, cho biết microservice nào đã xử lý request.

Request #1 (MISS): phải có header này (request đã đến origin)
Request #2 (HIT):  KHÔNG có header này (request được cache serve, không đến origin)
Request #3 (MISS): phải có header này (request đã đến origin sau khi TTL hết hạn)

Nếu request HIT mà vẫn có X-Upstream-Service -> anomaly:
  - Có thể Varnish pass thay vì deliver từ cache
  - Hoặc header được Varnish cache lại từ response cũ
```

### 8.4. Cache key headers -- đảm bảo đúng variant

```text
X-Cache-Key-Language: vi
X-Cache-Key-Geo: VN
X-Cache-Key-Device: mobile
X-Cache-Key-AB: control
X-Cache-Key-Segment: guest

Đây là cache key cho variant đang test (guest_vn_mobile_control).
Mỗi variant khác nhau có key khác nhau -> object cache riêng biệt -> TTL riêng.

Quan trọng: Nếu request với header khác (vd: X-Device-Class: desktop)
-> cache key khác -> object khác -> TTL độc lập -> không ảnh hưởng test.
```

---

## 9. Pass/fail criteria -- Tiêu chí đánh giá

### 9.1. Điều kiện PASS

```text
PASS khi TẤT CẢ các điều kiện sau đồng thời đúng:

[P1] k6 exit code = 0 (tất cả checks pass)
[P2] Sequence X-Cache: MISS -> HIT -> MISS
[P3] Request đầu tiên: X-Cache=MISS, X-Upstream-Service=products-service
[P4] Request thứ hai: X-Cache=HIT (chứng minh object đã vào cache)
[P5] Request sau sleep: X-Cache=MISS (chứng minh object đã hết hạn)
[P6] TTL_WAIT_SECONDS > TTL thực tế của object
[P7] Backend healthy trong suốt quá trình test
[P8] Không có request nào bị timeout hoặc lỗi network
```

### 9.2. Điều kiện FAIL

```text
FAIL khi MỘT TRONG các điều kiện sau xảy ra:

[F1] Request thứ hai không phải HIT:
     -> Object không vào cache hoặc bị evict ngay lập tức
     -> Cache key không ổn định (mỗi request tạo key khác nhau)
     -> Response có Cache-Control: no-store hoặc private

[F2] Request sau sleep vẫn HIT:
     -> Object không hết hạn (TTL dài hơn dự kiến)
     -> TTL_WAIT_SECONDS quá ngắn (<= TTL thực tế)
     -> Origin trả về s-maxage lớn hơn VCL default
     -> Varnish đang serve stale dù backend healthy (cấu hình sai)

[F3] Request sau sleep là HIT nhưng X-Cache-Stale=true:
     -> Backend bị đánh dấu unhealthy -> Varnish vào grace mode
     -> Không phải fail của TTL, nhưng là fail của precondition (backend healthy)
     -> Cần kiểm tra backend health probe

[F4] Request đầu tiên là HIT (không phải MISS):
     -> Ban-url trong setup() không hoạt động
     -> Object đã có sẵn trong cache từ lần chạy trước
     -> Cần kiểm tra control path authentication

[F5] Bất kỳ request nào status != 200:
     -> Origin hoặc network có vấn đề
     -> Không liên quan đến TTL, cần fix infrastructure trước

[F6] checks rate < 1:
     -> Một hoặc nhiều assertion fail
     -> k6 báo cáo chi tiết assertion nào fail trong output
```

### 9.3. Điều kiện INCONCLUSIVE

```text
INCONCLUSIVE (không kết luận được) khi:

[I1] Network intermittent trong lúc sleep:
     -> Không thể xác định HIT/MISS là do TTL hay do network
     -> Rerun test

[I2] Có can thiệp thủ công trong lúc test chạy:
     -> Ai đó purge/ban object giữa chừng
     -> Rerun test với điều kiện cô lập

[I3] Clock skew nghiêm trọng (> 1s) giữa Varnish và k6:
     -> sleep() và TTL không đồng bộ
     -> Cần sync clock (NTP) trước khi test
```

---

## 10. Cách chạy và đọc output

### 10.1. Lệnh chạy

```powershell
cd E:/Projects/k6/k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
./scripts/run-cdn-capabilities.ps1 -Scenarios 08-ttl-expiry
```

### 10.2. Tùy chỉnh thời gian chờ

```powershell
# Mặc định: 21 giây (TTL 20s + 1s buffer)
$env:TTL_WAIT_SECONDS = "21"

# Nếu object TTL=30s (do app set Cache-Control: s-maxage=30):
$env:TTL_WAIT_SECONDS = "31"

# Smoke test: TTL=10s cho object cached-path
# (cần script variant dùng buildCachedPath)
$env:TTL_WAIT_SECONDS = "11"
```

### 10.3. Tại sao test này chạy LÂU?

```text
Thời gian chạy ~22-25 giây, trong đó:
  - setup():     ~0.5s  (ban-url request)
  - request #1:  ~0.2s  (MISS, fetch từ origin)
  - request #2:  ~0.05s (HIT, cực nhanh)
  - sleep(21s):  21.0s  (ĐÂY LÀ PHẦN CHIẾM THỜI GIAN)
  - request #3:  ~0.2s  (MISS, fetch lại từ origin)
  - Tổng:        ~22s

So sánh với case khác:
  Case 01 (hit-smoke):      <1s
  Case 02 (variant-keys):   ~2s
  Case 05 (invalidation):   ~1s
  Case 08 (ttl-expiry):     ~22s  <-- LÂU NHẤT

Đây là CÁI GIÁ của timing-dependent test. Không thể chạy nhanh hơn vì
bản chất của test là CHỜ THỜI GIAN THẬT.
```

### 10.4. Diễn giải output

```text
KẾT QUẢ PASS (mong đợi):

  running (00:22.0s), 1/1 VUs, 3 complete and 0 interrupted iterations
  default   [--------------------------------------] 1 VUs  00:22.0s/00:22.0s

  ✓ homefeed first status 200
  ✓ homefeed first upstream products-service
  ✓ homefeed first cache state MISS
  ✓ homefeed second status 200
  ✓ homefeed second cache state HIT
  ✓ homefeed after expiry status 200
  ✓ homefeed after expiry upstream products-service
  ✓ homefeed after expiry cache state MISS

  checks.........................: 100.00% ✓ 8   ✗ 0
  http_req_duration.............: avg=XXXms ...

KẾT QUẢ FAIL (ví dụ: TTL không hết hạn):

  ✗ homefeed after expiry cache state MISS
    ↳  93% — / 1 ✗ (expecting HIT to equal MISS)

  Giải thích: request sau sleep vẫn trả về HIT, nghĩa là:
    - TTL thực tế > TTL_WAIT_SECONDS
    - Object chưa hết hạn sau 21s
    -> Kiểm tra Cache-Control header từ origin
    -> Có thể origin set s-maxage=60 (cao hơn VCL default 20s)
```

### 10.5. Timeline visualization trong output

```text
Nếu k6 chạy với --verbose, bạn sẽ thấy timeline:

  INFO[0000] setup: banUrl /api/sim/products/homefeed
  INFO[0000] request #1: GET /api/sim/products/homefeed
  INFO[0000]   -> 200 MISS (fetch from origin)
  INFO[0000] request #2: GET /api/sim/products/homefeed
  INFO[0000]   -> 200 HIT (served from cache, age=0s)
  INFO[0000] sleeping for 21 seconds...
  INFO[0021] woke up after 21s
  INFO[0021] request #3: GET /api/sim/products/homefeed
  INFO[0021]   -> 200 MISS (TTL expired, fetch from origin)
  INFO[0021] test complete: MISS->HIT->MISS sequence confirmed
```

---

## 11. 4 output -> decision scenarios -- Bốn kịch bản kết quả và quyết định

### 11.1. Scenario A: PASS hoàn hảo -- MISS -> HIT -> MISS

```text
KẾT QUẢ:
  Request #1: X-Cache=MISS
  Request #2: X-Cache=HIT
  Request #3: X-Cache=MISS (sau sleep)
  Tất cả checks pass, exit code = 0

KẾT LUẬN:
  TTL đang hoạt động ĐÚNG. Object được cache, sống đúng TTL, hết hạn
  đúng thời điểm, và được cache lại sau khi fetch từ origin.

QUYẾT ĐỊNH:
  ✅ Triển khai lên production.
  ✅ TTL=20s cho homefeed là phù hợp (cân bằng freshness/offload).
  ✅ Ghi nhận TTL hiện tại vào runbook để so sánh sau này.

THEO DÕI THÊM:
  - Monitor origin request count trong production để xác nhận offload
  - Nếu origin load tăng -> cân nhắc tăng TTL
  - Nếu user report data cũ -> cân nhắc giảm TTL
```

### 11.2. Scenario B: HIT sau TTL+wait -- TTL dài hơn dự kiến

```text
KẾT QUẢ:
  Request #1: X-Cache=MISS ✅
  Request #2: X-Cache=HIT ✅
  Request #3: X-Cache=HIT ❌ (mong đợi MISS)
  TTL_WAIT_SECONDS=21, nhưng object vẫn HIT

NGUYÊN NHÂN KHẢ DĨ (theo thứ tự xác suất):

1. Origin đang set Cache-Control: s-maxage > 20:
   -> App trả về Cache-Control: s-maxage=60
   -> Varnish tôn trọng s-maxage từ origin -> TTL=60s
   -> VCL default 20s không có tác dụng (beresp.ttl > 0s)
   -> TTL thực tế = 60s >> TTL_WAIT_SECONDS=21s
   -> Cách xác nhận: curl response, đọc Cache-Control header
   -> Cách fix: HOẶC sửa app (giảm s-maxage) HOẶC TTL_WAIT_SECONDS=61

2. CDN-Cache-Control ghi đè:
   -> Origin hoặc intermediate proxy set CDN-Cache-Control: s-maxage=120
   -> CDN-Cache-Control ưu tiên cao hơn Cache-Control
   -> TTL thực tế = 120s
   -> Cách fix: kiểm tra full response header chain

3. VCL set TTL dựa trên pattern SAI:
   -> URL không khớp pattern homefeed -> nhánh TTL khác được áp dụng
   -> Hoặc: có logic VCL khác ghi đè TTL sau default
   -> Cách fix: thêm log VCL hoặc dùng varnishlog để trace

4. Grace mode + backend unhealthy:
   -> Backend bị đánh dấu unhealthy (dù tưởng là healthy)
   -> Varnish serve stale với X-Cache-Stale=true
   -> Nhưng X-Cache vẫn là HIT (vì obj.hits > 0)
   -> Cách xác nhận: kiểm tra X-Cache-Backend-Healthy header
   -> Cách fix: khôi phục backend health, kiểm tra health probe

QUYẾT ĐỊNH:
  ⚠️ KHÔNG triển khai cho đến khi hiểu rõ TTL thực tế.
  ⚠️ Nếu TTL=60s là chủ ý -> cập nhật TTL_WAIT_SECONDS=61 và rerun.
  ⚠️ Nếu TTL=60s là ngoài ý muốn -> sửa app hoặc VCL.
  ⚠️ Ghi lại TTL THỰC TẾ (từ response header) vào report, không ghi TTL config.
```

### 11.3. Scenario C: MISS trước TTL -- TTL ngắn hơn dự kiến hoặc object bị evict

```text
KẾT QUẢ:
  Request #1: X-Cache=MISS ✅
  Request #2: X-Cache=HIT ✅
  ...chưa đến TTL, request thêm...
  Request #N (t < TTL): X-Cache=MISS ❌ (mong đợi HIT)

NGUYÊN NHÂN KHẢ DĨ:

1. Object bị evict khỏi cache do MEMORY PRESSURE:
   -> Varnish cache storage đầy
   -> Object bị đẩy ra dù chưa hết TTL
   -> Đây không phải lỗi TTL, là lỗi CAPACITY
   -> Cách xác nhận: kiểm tra Varnish storage usage (varnishstat)
   -> Cách fix: tăng storage (malloc/file), hoặc giảm số lượng object cache

2. Cache key thay đổi giữa các request:
   -> Request #2 dùng profile khác với request #1/#N
   -> Mỗi profile tạo cache key khác nhau -> object cache khác nhau
   -> Request #N tạo key MỚI -> MISS (cold cho key đó)
   -> Cách fix: kiểm tra profile nhất quán giữa các request

3. Có BAN/PURGE xảy ra giữa chừng:
   -> Một process khác (hoặc test case khác) ban/purge homefeed
   -> Cách fix: đảm bảo cô lập test, không chạy song song

4. VCL pass rule được trigger:
   -> Request có header đặc biệt (Authorization, Cookie) -> pass
   -> Hoặc URL có _nocache parameter -> pass
   -> Cách fix: kiểm tra request headers, đảm bảo không có header bypass

QUYẾT ĐỊNH:
  ⚠️ Xác định nguyên nhân gốc rễ (evict vs key change vs pass)
  ⚠️ Nếu memory pressure -> tăng cache storage TRƯỚC KHI triển khai
  ⚠️ Nếu key instability -> fix cache key logic
  ⚠️ Nếu pass rule -> sửa request hoặc VCL rule
```

### 11.4. Scenario D: HIT -> HIT -> HIT luôn -- TTL hiệu quả = vô hạn

```text
KẾT QUẢ:
  Request #1: X-Cache=MISS ✅
  Request #2: X-Cache=HIT ✅
  Request #3 (sau 21s): X-Cache=HIT ❌
  Request #4 (sau 60s): X-Cache=HIT ❌
  Request #5 (sau 300s): X-Cache=HIT ❌

  -> Object KHÔNG BAO GIỜ hết hạn

NGUYÊN NHÂN:

1. Cache-Control: s-maxage bị thiếu hoặc bằng 0 nhưng VCL ghi đè:
   -> App trả về Cache-Control: public (không có s-maxage)
   -> VCL: beresp.ttl <= 0s? CÓ THỂ (tùy Varnish version)
   -> VCL default: set beresp.ttl = 20s -> TTL=20s -> VẪN hoạt động
   -> KHÔNG PHẢI nguyên nhân chính

2. obj.ttl không giảm theo thời gian (Varnish bug hoặc config):
   -> Rất hiếm, thường do Varnish version cũ có bug
   -> Cách fix: upgrade Varnish

3. Mỗi request vô tình refresh object:
   -> Có cơ chế background fetch hoặc async refresh
   -> Mỗi request trigger async refresh -> object luôn mới
   -> Cách fix: kiểm tra VCL xem có return(restart) hoặc return(miss) không

4. Test không request cùng một object:
   -> Request #3 dùng URL hơi khác -> cache key khác -> MISS
   -> Nhưng nếu HIT, có thể do cache key COLLISION
   -> Rất hiếm

QUYẾT ĐỊNH:
  🚫 NGHIÊM TRỌNG. Không triển khai khi chưa fix.
  🚫 TTL vô hạn = data stale vô hạn = user thấy data cũ mãi mãi.
  🚫 Cần debug Varnish behavior với varnishlog.
  🚫 Kiểm tra: obj.ttl có được set đúng không? Có bị reset ở đâu không?
  🚫 Kiểm tra: có background process nào liên tục fetch object này không?
```

---

## 12. Nghịch lý và misconceptions -- Những hiểu lầm phổ biến

### 12.1. "TTL càng dài càng tốt"

```text
SAI.

Lý do: TTL dài = HIT ratio cao = origin nhàn = latency thấp -> NHƯNG:

1. DATA STALE RISK:
   TTL=300s: admin cập nhật giá flash sale lúc 10:00:00
             user request lúc 10:00:01 -> HIT (object cache từ 09:58, giá cũ)
             user thấy giá cũ trong 5 phút
             -> đặt hàng với giá cũ -> lỗi khi thanh toán
             -> refund, complaint, mất niềm tin

2. INVALIDATION DELAY:
   Khi cần update gấp (hết hàng, lỗi giá), admin phải:
   - Cập nhật origin
   - Ban/purge CDN
   - Đợi object mới được cache
   TTL càng dài -> user càng dễ bị kẹt với object cũ trước khi ban có hiệu lực

3. CACHE POLLUTION:
   Object cũ chiếm chỗ trong cache, object mới không có chỗ
   -> hit ratio cho object MỚI thấp
   -> cache hoạt động kém hiệu quả

NGUYÊN TẮC: TTL nên BẰNG khoảng thời gian tối đa bạn chấp nhận
          user thấy data cũ. Không dài hơn.
```

### 12.2. "TTL ngắn mới an toàn"

```text
SAI.

Lý do: TTL ngắn = data luôn fresh -> NHƯNG:

1. ORIGIN OVERLOAD:
   TTL=1s: 1000 req/s từ user
           -> 1 MISS/s cho mỗi variant
           -> 5 MISS/s cho 5 variant
           -> Mỗi MISS = 1 request đến origin
           -> Origin chịu load gần như toàn bộ
           -> CDN gần như vô dụng

2. CASCADING FAILURE:
   Nếu origin hơi chậm (p99=200ms):
   -> 5 MISS/s x 200ms = 1 concurrent connection -> OK
   Nhưng nếu traffic spike (5000 req/s):
   -> 25 MISS/s x 200ms = 5 concurrent connections -> căng
   -> Nếu origin bắt đầu timeout:
      -> Grace mode kích hoạt -> serve stale
      -> Nhưng grace cũng có giới hạn (120s)
      -> Sau 120s: mọi request lỗi

NGUYÊN TẮC: TTL nên BẰNG khoảng thời gian origin có thể chịu được
          MISS rate. Công thức:
          TTL_min = (peak_req_s / max_origin_req_s) * số_variant
          Ví dụ: peak=1000/s, origin chịu được 50/s, 5 variant
                -> TTL_min = (1000/50) * 5 = 100s
```

### 12.3. "s-maxage và max-age giống nhau"

```text
SAI.

max-age:   DÀNH CHO BROWSER CACHE (private cache)
           Browser dùng max-age để quyết định cache local bao lâu
           CDN CÓ THỂ dùng max-age nếu không có s-maxage

s-maxage:  DÀNH CHO SHARED CACHE (CDN, proxy cache)
           GHI ĐÈ max-age cho shared cache
           Browser BỎ QUA s-maxage

Ví dụ:
  Cache-Control: max-age=300, s-maxage=20

  Browser: cache 300 giây (dùng max-age)
  CDN:     cache 20 giây  (dùng s-maxage)

  -> User load trang lần 2: browser cache -> không request gì -> siêu nhanh
  -> User khác load trang: request đến CDN -> CDN cache 20s
  -> Sau 20s: CDN MISS -> origin fetch -> object mới cho CDN
  -> Browser vẫn dùng cache cũ 300s -> chỉ request lại CDN sau 300s

Tai sao phải phân biệt?
  - Browser cache có thể dài hơn (user cá nhân, chấp nhận data cũ hơn)
  - CDN cache nên ngắn hơn (shared, nhiều user, cần freshness cao hơn)
  - Tách biệt cho phép tinh chỉnh riêng từng tầng cache
```

### 12.4. "Varnish luôn dùng TTL trong VCL"

```text
SAI.

VCL default TTL (`set beresp.ttl = 20s`) CHỈ được dùng khi:
  - Origin KHÔNG set Cache-Control header nào
  - HOẶC origin set Cache-Control nhưng không có max-age/s-maxage
  - HOẶC Cache-Control bị VCL ghi đè (hiếm)

Thực tế: nếu app trả về `Cache-Control: s-maxage=60`, Varnish
sẽ set beresp.ttl = 60s TỰ ĐỘNG trước khi VCL chạy. Đoạn code
`if (beresp.ttl <= 0s)` sẽ không trigger vì beresp.ttl = 60s > 0s.

Đây là lý do test TTL expiry QUAN TRỌNG: nó reveal TTL THỰC TẾ,
không phải TTL TRONG CONFIG.
```

### 12.5. "Grace mode chỉ dùng khi origin unhealthy"

```text
ĐÚNG, nhưng cần hiểu rõ "unhealthy" là gì.

Varnish health probe:
  - Định kỳ gửi request đến /health/cdn-origin
  - Nếu fail >= (window - threshold + 1) lần -> backend unhealthy
  - VD: window=3, threshold=2 -> fail 2/3 lần -> unhealthy

Khi backend unhealthy:
  - Mọi request HIT có obj.ttl + obj.grace > 0s -> serve stale
  - Mọi request MISS -> lỗi (không có object để serve)

Khi backend healthy TRỞ LẠI:
  - Request HIT với obj.ttl >= 0s -> HIT bình thường
  - Request HIT với obj.ttl < 0s (stale) -> MISS (về origin fetch mới)
  - Không còn serve stale nữa

Case 08 yêu cầu backend HEALTHY -> grace mode không kích hoạt.
Case 09 (stale-while-error) test grace mode khi backend UNHEALTHY.
```

---

## 13. Checklist -- Danh sách kiểm tra trước khi chạy

```text
TRƯỚC KHI CHẠY CASE 08:

[ ] Backend healthy: kiểm tra Varnish health probe
    -> curl http://localhost:80/health/cdn-origin
    -> X-Cache-Backend-Healthy: true

[ ] Xác định TTL thực tế của object:
    -> curl -sI http://localhost:80/api/sim/products/homefeed \
       -H 'Accept-Language: vi' -H 'X-Geo-Country: VN' \
       -H 'X-Device-Class: mobile' -H 'X-Ab-Variant: control' \
       -H 'X-User-Segment: guest'
    -> Đọc Cache-Control: s-maxage=?
    -> Nếu không có s-maxage: TTL = VCL default (20s)

[ ] TTL_WAIT_SECONDS > TTL thực tế + 1:
    -> Mặc định: TTL_WAIT_SECONDS=21, TTL=20 -> OK
    -> Nếu TTL=60: cần TTL_WAIT_SECONDS=61

[ ] Control path hoạt động:
    -> curl -X POST http://localhost:8088/ops/app/cdn/cache/ban-url \
       -H 'Authorization: Bearer <token>' \
       -H 'Content-Type: application/json' \
       -d '{"url":"/api/sim/products/homefeed"}'
    -> Status 200 -> OK

[ ] Không có test case CDN nào khác đang chạy:
    -> Các case CDN chia sẻ cache -> chạy song song = nhiễu
    -> Chạy case 08 MỘT MÌNH

[ ] OPS_AUTH_TOKEN được set:
    -> echo $env:OPS_AUTH_TOKEN -> có giá trị

[ ] Network ổn định (localhost, nhưng vẫn kiểm tra):
    -> ping localhost -> <1ms

TRONG KHI CHẠY:

[ ] Theo dõi output: đảm bảo sleep(21) không bị skip
[ ] Không chạm vào hệ thống (không ban/purge thủ công)
[ ] Không restart Varnish hoặc origin

SAU KHI CHẠY:

[ ] Xác nhận exit code = 0
[ ] Đọc sequence X-Cache: MISS -> HIT -> MISS
[ ] Ghi lại TTL_WAIT_SECONDS đã dùng
[ ] Ghi lại thời gian thực tế của test
[ ] Nếu FAIL: đọc nguyên nhân từ section 11
```

---

## 14. Variations -- Các biến thể mở rộng

### 14.1. Variation 1: TTL siêu ngắn (1 giây) -- Smoke test nhanh

```text
MỤC ĐÍCH: Smoke test TTL hoạt động mà không cần chờ 21s.

CÁCH LÀM:
  - Dùng buildCachedPath để tạo path mới với TTL tùy chỉnh
  - `buildCachedPath('ttl-smoke-1s', { ttl_seconds: 1 })`
  - Request #1: MISS
  - Request #2: HIT (ngay lập tức)
  - sleep(2)
  - Request #3: MISS

CODE MẪU:
  const path = buildCachedPath('ttl-smoke-1s', { ttl_seconds: 1 });
  // first: MISS, second: HIT, sleep(2), third: MISS

LƯU Ý:
  - TTL=1s RẤT NHẠY với timing drift (xem section 7)
  - Có thể bị race condition -> flaky test
  - Chỉ dùng cho smoke, không dùng cho validation chính thức
  - Nếu fail -> không kết luận được ngay -> dùng variation 14.4 thay thế
```

### 14.2. Variation 2: TTL dài (300 giây) -- Verify long-lived cache

```text
MỤC ĐÍCH: Xác nhận object cache sống được với TTL dài.

CÁCH LÀM:
  - Dùng path có Cache-Control: s-maxage=300
  - Hoặc config VCL default TTL lớn hơn
  - Request #1: MISS
  - Request #2: HIT (sau 10s) -> vẫn HIT
  - Request #3: HIT (sau 100s) -> vẫn HIT
  - Request #4: HIT (sau 250s) -> vẫn HIT
  - sleep(301)
  - Request #5: MISS

LƯU Ý:
  - Test này mất 5+ phút
  - Không nên set làm default test (quá chậm cho CI)
  - Dùng cho manual validation hoặc nightly test
  - Cần đảm bảo không ai invalidate object trong 5 phút
```

### 14.3. Variation 3: CDN-Cache-Control override -- Xác minh độ ưu tiên

```text
MỤC ĐÍCH: Chứng minh CDN-Cache-Control ghi đè Cache-Control.

CÁCH LÀM:
  - Dùng buildCachedPath với response trả về CẢ HAI header:
    Cache-Control: max-age=300, s-maxage=300
    CDN-Cache-Control: s-maxage=10
  - Request #1: MISS
  - Request #2: HIT
  - sleep(11) (chỉ cần > CDN-Cache-Control TTL)
  - Request #3: MISS

CODE MẪU:
  const path = buildCachedPath('cdn-cc-override', {
    ttl_seconds: 10,  // CDN-Cache-Control takes precedence
    origin_cc_max_age: 300,  // Cache-Control (bị ghi đè)
  });

KẾT QUẢ MONG ĐỢI:
  - Sau 11s: MISS (tuân theo CDN-Cache-Control: s-maxage=10)
  - Nếu tuân theo Cache-Control: max-age=300 -> vẫn HIT sau 11s -> FAIL

ĐIỀU NÀY CHỨNG MINH:
  - CDN-Cache-Control có độ ưu tiên cao nhất
  - App có thể set TTL riêng cho CDN mà không ảnh hưởng browser
```

### 14.4. Variation 4: Grace period testing -- Object được serve stale

```text
MỤC ĐÍCH: Xác minh grace period hoạt động khi origin unhealthy.

CÁCH LÀM (kết hợp với case 09):
  - Warm cache -> HIT
  - Đánh dấu origin unhealthy (qua control path)
  - Đợi TTL hết hạn
  - Request: object đã hết TTL, backend unhealthy
  - KẾT QUẢ MONG ĐỢI: HIT + X-Cache-Stale: true
  - Khôi phục origin healthy
  - Request tiếp theo: MISS (fetch object mới)

LƯU Ý:
  - Đây là test cho CASE 09, không phải case 08
  - Nhưng quan trọng để hiểu đầy đủ TTL lifecycle
  - Case 08 chỉ test phần "backend healthy -> không serve stale"
```

### 14.5. Variation 5: Multi-variant TTL isolation

```text
MỤC ĐÍCH: Xác minh mỗi cache variant có TTL ĐỘC LẬP.

CÁCH LÀM:
  - Warm cache cho variant A (mobile, VN) -> HIT
  - Warm cache cho variant B (desktop, VN) -> HIT (cache key khác)
  - Đợi TTL_WAIT_SECONDS (21s)
  - Request variant A: MISS (đã hết TTL)
  - Request variant B: cũng MISS (vì cùng thời điểm cache)
  - HOẶC: warm variant B SAU variant A 10s
  - Sau 21s: variant A MISS, variant B HIT (chưa hết TTL)

ĐIỀU NÀY CHỨNG MINH:
  - Mỗi variant có TTL riêng
  - TTL của variant A không ảnh hưởng variant B
  - Cache key isolation hoạt động đúng ở tầng timing
```

---

## 15. Anti-patterns -- Những sai lầm thường gặp

### 15.1. Không đợi đủ lâu -- TTL chưa thực sự hết hạn

```text
SAI LẦM:
  TTL_WAIT_SECONDS = 20 trong khi object TTL = 20s
  -> sleep(20) kết thúc, request ngay lập tức
  -> Varnish clock: object vừa chạm TTL 0s
  -> obj.ttl >= 0s? CÓ (0 >= 0 -> TRUE)
  -> Varnish deliver từ cache -> HIT -> test FAIL

TẠI SAO SAI:
  obj.ttl >= 0s là ĐIỀU KIỆN HIT trong vcl_hit.
  Tại t=20.000s, obj.ttl = 0s -> VẪN thỏa mãn >= 0s -> HIT.
  Phải đợi t > 20s (obj.ttl < 0s) mới MISS.

CÁCH ĐÚNG:
  TTL_WAIT_SECONDS = TTL + 1 (hoặc ít nhất TTL + 0.001)
  Với TTL=20s: dùng TTL_WAIT_SECONDS=21
  Với TTL=1s:  dùng TTL_WAIT_SECONDS=2
```

### 15.2. Set TTL khác nhau trong các response path khác nhau

```text
SAI LẦM:
  App trả về Cache-Control: s-maxage=20 cho homefeed của guest
  App trả về Cache-Control: s-maxage=60 cho homefeed của returning user
  -> Cùng URL, khác user segment -> cache key khác -> TTL khác nhau
  -> Test với profile guest: TTL=20s, TTL_WAIT_SECONDS=21 -> OK
  -> Test với profile returning: TTL=60s, TTL_WAIT_SECONDS=21 -> FAIL
     (vì 21s < 60s, object chưa hết hạn)

CÁCH ĐÚNG:
  - Nhất quán TTL cho cùng một resource type (homefeed)
  - Nếu bắt buộc khác nhau: document rõ ràng
  - Test TỪNG variant với TTL_WAIT_SECONDS tương ứng
```

### 15.3. Quên rằng CDN-Cache-Control có precedence cao nhất

```text
SAI LẦM:
  Developer set Cache-Control: s-maxage=20 trong app
  Nhưng infrastructure team set CDN-Cache-Control: s-maxage=120 ở
  lớp CDN configuration (hoặc reverse proxy trước Varnish)
  -> TTL hiệu quả = 120s, không phải 20s
  -> Test với TTL_WAIT_SECONDS=21 -> vẫn HIT -> FAIL

CÁCH ĐÚNG:
  - Luôn kiểm tra TOÀN BỘ response header (không chỉ Cache-Control)
  - Tìm CDN-Cache-Control header
  - Nếu có nhiều layer giữa app và Varnish -> trace header propagation
```

### 15.4. Chạy case 08 song song với case CDN khác

```text
SAI LẦM:
  Chạy case 08 (ttl-expiry) cùng lúc với case 05 (invalidation)
  -> Case 05 ban-url homefeed trong lúc case 08 đang sleep
  -> Request sau sleep của case 08: MISS
     (KHÔNG PHẢI do TTL hết hạn, mà do bị ban)
  -> Test vẫn "pass" nhưng vì SAI LÝ DO

HOẶC:
  Chạy case 08 cùng case 01 (hit-smoke)
  -> Case 01 gửi request đến homefeed trong lúc case 08 sleep
  -> obj.hits tăng -> X-Cache-Hits cao bất thường
  -> Không ảnh hưởng kết quả chính, nhưng gây nhầm lẫn khi debug

CÁCH ĐÚNG:
  - Chạy tuần tự từng case CDN
  - Hoặc: mỗi case dùng cache key riêng biệt (không chia sẻ)
```

### 15.5. Không kiểm tra response status trước khi check cache state

```text
SAI LẦM:
  assertCacheState(response, 'MISS', 'label');
  // Nhưng response status = 503 (origin lỗi)
  // X-Cache header có thể không tồn tại hoặc sai

CÁCH ĐÚNG:
  assertStatus(response, 200, 'label');          // Kiểm tra status TRƯỚC
  assertCacheState(response, 'MISS', 'label');    // RỒI MỚI kiểm cache
  // Script chuẩn đã làm đúng thứ tự này
```

---

## 16. Real validation data -- Dữ liệu xác nhận thực tế

### 16.1. Dữ liệu từ lần chạy thực tế

```text
CASE: cdn-08-ttl-expiry
DATE: 2026-06-15
ENV:  TargetLayer=full, Varnish 7.x, localhost
CONFIG:
  TTL_WAIT_SECONDS = 21
  Varnish homefeed TTL = 20s (default VCL)
  Profile: guest_vn_mobile_control

RAW RESULTS:
  Request #1 (t=0.0s):
    Status: 200
    X-Cache: MISS
    X-Upstream-Service: products-service
    X-Cache-Key-Language: vi
    X-Cache-Key-Geo: VN
    X-Cache-Key-Device: mobile
    X-Cache-Key-AB: control
    X-Cache-Key-Segment: guest

  Request #2 (t=0.1s):
    Status: 200
    X-Cache: HIT
    X-Cache-Hits: 1
    X-Cache-Age: 0

  [sleep 21 seconds]

  Request #3 (t=21.2s):
    Status: 200
    X-Cache: MISS
    X-Upstream-Service: products-service
    X-Cache-Age: 0

CHECKS: 8/8 PASS
EXIT CODE: 0
CONCLUSION: PASS -- TTL expiry confirmed for homefeed (20s TTL, 21s wait)
```

### 16.2. Key metrics ghi nhận

```text
http_req_duration:
  Request #1 (MISS): ~50ms (phải fetch từ origin)
  Request #2 (HIT):  ~3ms  (từ cache, nhanh hơn ~16x)
  Request #3 (MISS): ~45ms (phải fetch từ origin sau TTL)

Tốc độ HIT vs MISS:
  MISS latency trung bình: ~48ms (bao gồm origin processing)
  HIT latency trung bình:  ~3ms (chỉ Varnish processing)
  -> Cache offload giảm latency ~94% cho end user
  -> Với 1000 req/s: tiết kiệm ~45ms x 1000 = 45 giây processing mỗi giây
     (nếu tất cả đều là HIT)
```

---

## 17. Reference

- **Run guide:** `E:/Khoa hoc/k6/docs/practice/cdn/RUN_GUIDE.md`
- **Overview:** `E:/Khoa hoc/k6/docs/practice/cdn/00_overview.md`
- **Source script:** `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/08-ttl-expiry.js`
- **Shared helpers:** `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/shared.js`
- **Varnish VCL:** `E:/Projects/k6/k6-metrics-server/load-target/varnish/default.vcl`
- **Case catalog:** `E:/Projects/k6/k6-metrics-server/load-target/k6/cdn/case-catalog.json`
- **Ramping-arrival-rate gold standard:** `E:/Khoa hoc/k6/docs/practice/ramping-arrival-rate/01_daily-ingress-curve.md`
- **Varnish docs -- TTL and grace:** https://varnish-cache.org/docs/7.0/users-guide/vcl-grace.html
- **HTTP Cache-Control spec:** https://httpwg.org/specs/rfc9111.html
- **CDN-Cache-Control spec:** https://httpwg.org/specs/rfc9213.html
