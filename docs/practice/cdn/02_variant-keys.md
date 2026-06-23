# Case 02: Variant cache keys

> **Case ID:** `cdn-02-variant-keys` | **Script:** `02-variant-keys.js` | **Layer:** CDN / Varnish
> **Proof:** cache key split theo language/geo/device/AB/segment

---

## 1. Tình huống thực tế

### 1.1. Bối cảnh kinh doanh

Một trang thương mại điện tử toàn cầu phục vụ người dùng từ nhiều quốc gia, nói nhiều ngôn ngữ khác nhau, truy cập từ nhiều loại thiết bị. Cùng một URL `/api/sim/products/1` (trang chi tiết sản phẩm) có thể trả về nội dung khác nhau tùy vào:

- **Ngôn ngữ**: Người dùng Việt Nam thấy mô tả sản phẩm bằng tiếng Việt. Người dùng Mỹ thấy mô tả bằng tiếng Anh.
- **Quốc gia**: Cùng một sản phẩm, giá hiển thị là VND cho người dùng Việt Nam, USD cho người dùng Mỹ, SGD cho người dùng Singapore.
- **Thiết bị**: Trên mobile, giao diện rút gọn, hình ảnh kích thước nhỏ. Trên desktop, giao diện đầy đủ, hình ảnh độ phân giải cao.
- **A/B test**: Nhóm "control" thấy giao diện cũ. Nhóm "variant-a" thấy giao diện mới với layout khác và giá khuyến mãi khác.
- **Phân khúc người dùng (segment)**: Khách vãng lai (guest) thấy giá niêm yết. Khách hàng thân thiết (returning) thấy giá ưu đãi riêng trên homefeed. Khách VIP thấy ưu đãi độc quyền.

Nếu CDN không phân biệt được các biến thể này, **cache leakage** sẽ xảy ra: người dùng Việt Nam thấy giá USD, người dùng mobile thấy giao diện desktop bị vỡ layout, người dùng nhóm control vô tình thấy giao diện A/B test mới, hoặc khách vãng lai thấy giá ưu đãi dành cho khách VIP.

### 1.2. Cache leakage là gì

Cache leakage (rò rỉ cache) xảy ra khi một cached object được phục vụ cho một người dùng không đáng được nhận object đó. Trong ngữ cảnh CDN:

```text
Tình huống leakage điển hình:
  1. User A (VN, mobile, control) gọi GET /products/1 -> MISS, cache lưu object tiếng Việt
  2. User B (US, desktop, variant-a) gọi GET /products/1 -> HIT (SAI!)
     -> User B nhận object tiếng Việt thay vì tiếng Anh
```

Hậu quả của cache leakage:
- **Trải nghiệm người dùng kém**: Sai ngôn ngữ, sai đơn vị tiền tệ, sai giao diện
- **Lộ thông tin kinh doanh**: Đối thủ ở Mỹ có thể thấy giá VND ưu đãi bằng cách thay đổi header
- **Sai lệch dữ liệu A/B test**: Nhóm control thấy variant test -> dữ liệu analytics bị nhiễu
- **Lộ ưu đãi cá nhân**: Guest thấy giá VIP -> khách hàng thân thiết mất lý do để đăng nhập

### 1.3. Câu hỏi kiểm tra cốt lõi

> **Khi hai request đến cùng một URL nhưng khác nhau về language, geo, device, AB variant, hoặc user segment, CDN có tạo ra các cache object riêng biệt không? Và khi cùng variant gọi lại, CDN có trả HIT không?**

Case này trả lời câu hỏi đó qua 5 sub-proofs, mỗi sub-proof kiểm tra một dimension của cache key.

---

## 2. CDN capability được chứng minh

### 2.1. Năm capability chính

| # | Capability | Dimension | Mô tả | Sub-proof |
|---|-----------|-----------|-------|-----------|
| 1 | **Language key split** | `Accept-Language` | vi != en -> 2 object riêng | `exerciseVariant(..., 'language', guestVNMobileControl, guestVNMobileEnglish)` |
| 2 | **Geo key split** | `X-Geo-Country` | VN != US -> 2 object riêng | `exerciseVariant(..., 'geo', guestVNMobileControl, guestUSMobileControl)` |
| 3 | **Device key split** | `X-Device-Class` | mobile != desktop -> 2 object riêng | `exerciseVariant(..., 'device', guestVNMobileControl, guestVNDesktopControl)` |
| 4 | **AB variant key split** | `X-Ab-Variant` | control != variant-a -> 2 object riêng | `exerciseVariant(..., 'ab_variant', guestVNMobileControl, guestVNMobileVariantA)` |
| 5 | **Segment key split** | `X-User-Segment` | guest != returning -> 2 object riêng | `exerciseVariant(..., 'segment', guestVNMobileVariantA, returningVNMobileVariantA, { withSegment: true })` |

### 2.2. Pattern chung của mỗi sub-proof

Mỗi sub-proof theo cùng một pattern 4 bước:

```text
Với một dimension (vd: language):
  1. banUrl(path)              — Xóa sạch cache cho path
  2. base MISS -> base HIT     — Gọi với base variant (vd: vi), verify MISS rồi HIT
  3. variant MISS -> variant HIT — Gọi với variant khác (vd: en), verify MISS (không reuse base)
  4. Kết luận:                 — base và variant có cache key khác nhau
```

Pattern này chứng minh cả hai chiều:
- **Chiều phân tách (split)**: variant khác base -> MISS (không reuse cache của base)
- **Chiều gộp nhóm (grouping)**: cùng variant gọi lại -> HIT (reuse cache của chính nó)

### 2.3. Tầm quan trọng của capability này

Cache key correctness là **ranh giới giữa cache hoạt động đúng và cache gây hại**. Một CDN cache nhanh nhưng phục vụ sai người dùng còn tệ hơn là không cache.

Trong kiến trúc microservices, variant dimensions thường được quản lý ở tầng application (controller đọc header, gọi service khác nhau). Nhưng một khi đã có CDN ở front, CDN phải tham gia vào variant routing, nếu không object bị cache sai sẽ bypass toàn bộ application logic.

---

## 3. Vì sao phải test ở CDN layer

### 3.1. Application layer đã xử lý variant — vậy test CDN để làm gì?

Đây là câu hỏi phổ biến. Application layer (controller code) có logic phân biệt variant:

```text
Controller pseudo-code:
  if (request.header('Accept-Language') == 'vi') {
    return productService.getProductVietnamese(id);
  } else {
    return productService.getProductEnglish(id);
  }
```

Controller hoạt động đúng khi request đến được nó. Nhưng vấn đề là: **khi CDN cache object, request có thể không bao giờ đến controller**.

```text
Không có cache key variant:
  1. User VN (Accept-Language: vi) -> controller -> response tiếng Việt
     CDN cache object với key = "/api/sim/products/1"
  2. User US (Accept-Language: en) -> CDN HIT -> trả response tiếng Việt (SAI!)
     Request không bao giờ đến controller -> controller không có cơ hội sửa
```

Controller có logic đúng nhưng CDN cache sai key -> user vẫn thấy sai nội dung. **Đây là lý do phải test variant keys ở CDN layer.**

### 3.2. Sự khác biệt giữa test app và test CDN cho variant

| Khía cạnh | Test application layer | Test CDN layer |
|-----------|----------------------|----------------|
| **Cách test** | Gọi controller trực tiếp (không qua CDN) | Gọi qua CDN (:80) |
| **Cái được test** | Logic xử lý header của controller | Cache key construction của Varnish |
| **Header cần verify** | Response body (nội dung đúng ngôn ngữ) | `X-Cache-Key-*`, `X-Cache` (MISS/HIT sequence) |
| **Phát hiện leakage** | Không — app test không liên quan đến cache | Có — sequence MISS/HIT chứng minh cache isolation |
| **Môi trường** | Có thể chạy với `TargetLayer=app` | Bắt buộc `TargetLayer=full` |

### 3.3. Ví dụ cụ thể về lỗi chỉ CDN test mới bắt được

```text
Bug: Developer thêm response header "Vary: Accept-Language" nhưng quên
     cập nhật VCL hash.

App test:
  ✓ Controller trả đúng nội dung cho từng language
  ✓ Response có Vary: Accept-Language

CDN test (case này):
  ✗ en variant trả HIT (đáng lẽ MISS) -> cache key không có language dimension
  ✗ X-Cache-Key-Language không xuất hiện hoặc giá trị sai
```

### 3.4. Hậu quả production nếu không test

| Scenario | Hậu quả |
|----------|---------|
| Language leakage | Người dùng thấy nội dung sai ngôn ngữ -> tỷ lệ thoát trang tăng |
| Geo leakage | Hiển thị sai đơn vị tiền tệ -> không thể thanh toán -> mất doanh thu |
| Device leakage | Mobile thấy layout desktop -> không thao tác được -> mất chuyển đổi |
| AB leakage | Nhóm control thấy variant -> dữ liệu A/B test nhiễu -> quyết định sản phẩm sai |
| Segment leakage | Guest thấy giá VIP -> khách VIP thấy không được ưu đãi -> mất loyalty |

---

## 4. Topology và precondition

### 4.1. Sơ đồ topology

```text
                      PUBLIC PATH (port 80)
                      =====================
k6 client ──> http://localhost:80 ──> Varnish CDN ──> Nginx ──> products-service
                                          │                    (trả response khác nhau
                                          │ cache storage      theo variant headers)
                                          │
                      CONTROL PATH (port 8088)
                      =======================
k6 client ──> http://localhost:8088 ──> app control plane
                                          │
                                          └── POST /ops/app/cdn/cache/ban-url
```

### 4.2. Required topology

```text
requiredTargetLayer = full
BASE_URL              = http://localhost:80
CONTROL_BASE_URL      = http://localhost:8088
OPS_AUTH_TOKEN        = <ops-token>
```

Giống case 01, target layer phải là `full`. Không có đường tắt — variant key test yêu cầu Varnish thật.

### 4.3. Precondition đặc thù cho case này

Ngoài các precondition chung của CDN series, case này có thêm:

| # | Điều kiện | Lý do |
|---|-----------|-------|
| 1 | **Chạy single-VU (vus=1)** | Sequence MISS/HIT phải deterministic. Nhiều VUs có thể đảo thứ tự request -> base và variant gọi xen kẽ -> HIT/MISS không như expected |
| 2 | **Tăng iterations, không tăng VUs** | Nếu muốn nhiều sample hơn, set `VARIANT_KEYS_ITERATIONS` cao hơn thay vì tăng VUs |
| 3 | **5 dimensions phải được test riêng biệt** | Mỗi dimension (language, geo, device, AB, segment) có sub-proof riêng với banUrl trước mỗi sub-proof |
| 4 | **Segment dimension dùng endpoint khác** | 4 dimensions đầu dùng `productDetail`, dimension segment dùng `homefeed` vì segment chỉ được hash cho một số endpoint |
| 5 | **Origin phải trả response thực sự khác nhau** | Nếu origin trả cùng một response cho mọi variant, cache key test vẫn đúng về mặt kỹ thuật nhưng không chứng minh được business value |

### 4.4. Tại sao phải single-VU

Đây là điểm khác biệt quan trọng so với case 01 (dùng 4 VUs). Case 02 cần deterministic sequence:

```text
ĐÚNG (single VU, tuần tự):
  banUrl -> base MISS -> base HIT -> variant MISS -> variant HIT
  Kết quả: deterministic, dễ verify

SAI (4 VUs, song song):
  VU1: base request   -> có thể HIT nếu VU2 MISS trước
  VU2: variant request -> có thể MISS hoặc HIT tùy timing
  Kết quả: non-deterministic, không thể assert sequence
```

Script ghi rõ comment: `// Keep this single-VU to preserve deterministic MISS/HIT sequencing per variant.`

---

## 5. Script deep-dive

### 5.1. Tổng quan cấu trúc

Script `02-variant-keys.js` có cấu trúc khác biệt so với case 01 ở chỗ **không có setup() function**. Thay vào đó, toàn bộ logic nằm trong `default` function và một helper function `exerciseVariant()`.

```text
02-variant-keys.js
├── Imports & environment knobs (dòng 1-2)
├── options block (dòng 6-17)
├── exerciseVariant() helper (dòng 18-57)
└── default function (dòng 59-65)
```

### 5.2. Phần 1: Imports và environment knobs

```javascript
import { envInt } from '../shared/common.js';
import { paths, profiles, expectedCacheKey, banUrl, requestCdn, assertCacheKeyHeaders, assertCacheState, assertStatus, assertUpstream } from './shared.js';

const VARIANT_KEYS_ITERATIONS = envInt('VARIANT_KEYS_ITERATIONS', 24);
```

**Phân tích:**

| Dòng | Thành phần | Mục đích |
|------|-----------|----------|
| 2 | Imports từ `shared.js` | Đầy đủ assertion helpers: `assertCacheKeyHeaders`, `assertCacheState`, `assertStatus`, `assertUpstream` |
| 4 | `VARIANT_KEYS_ITERATIONS` | Tổng số iteration, default `24`. Mỗi iteration chạy tất cả 5 sub-proofs -> tổng cộng mỗi sub-proof chạy 24 lần |

**Tại sao default là 24 iterations:**

5 sub-proofs, mỗi sub-proof có 4 requests (base MISS, base HIT, variant MISS, variant HIT) = 20 requests mỗi iteration. 24 iterations = 480 requests. Đủ để phát hiện intermittent cache key issue.

### 5.3. Phần 2: options block

```javascript
export const options = {
  // Keep this single-VU to preserve deterministic MISS/HIT sequencing per variant.
  vus: 1,
  iterations: VARIANT_KEYS_ITERATIONS,
  thresholds: {
    checks: ['rate==1'],
  },
  tags: {
    scenario: 'cdn_variant_keys',
  },
};
```

**Khác biệt so với case 01:**

| Field | Case 01 | Case 02 | Lý do |
|-------|---------|---------|-------|
| `vus` | `4` | `1` | Deterministic sequence |
| `duration` | `'18s'` | (không có) | Dùng `iterations` thay vì `duration` |
| `iterations` | (không có) | `24` | Mỗi iteration = 1 lần chạy đủ 5 sub-proofs |
| `thresholds.http_req_failed` | `['rate==0']` | (không có) | Case 02 không set threshold này (vẫn nên pass 100%) |

**Tại sao dùng `iterations` thay vì `duration`:**

Với `vus: 1`, mỗi VU chạy tuần tự. `iterations: 24` nghĩa là default function chạy đúng 24 lần rồi dừng. Điều này cho ra số lượng request chính xác và deterministic, phù hợp với correctness test. `duration` phù hợp hơn cho sustained load test (như case 01).

##### Phân tích executor: vì sao dùng `shared-iterations` cho case này?

Config hiện tại dùng bare form `vus` + `iterations` — k6 tự động chọn
`shared-iterations`. Đây là lựa chọn ĐÚNG cho CDN variant-keys. Phân tích vì sao:

**Yêu cầu của case CDN variant-keys:**

```text
1. Deterministic sequence: Mỗi sub-proof cần chuỗi chính xác
   banUrl → base MISS → base HIT → variant MISS → variant HIT
   → Trình tự request QUYẾT ĐỊNH kết quả test
   → KHÔNG phải: "gửi request liên tục trong X giây"
   → KHÔNG phải: "mỗi VU chạy đúng N lần riêng"

2. Single-VU bắt buộc: 1 VU duy nhất chạy tuần tự
   → Nhiều VU sẽ đảo thứ tự request giữa base và variant
   → VU1 gửi base, VU2 gửi variant → không biết ai MISS trước
   → Mô hình "một người kiểm tra từng bước một"

3. Số iteration CỐ ĐỊNH:
   → Cần chạy đúng 24 lần, mỗi lần = 1 vòng đủ 5 sub-proofs
   → Tổng request = 24 × 25 = 600 request (xác định trước)
   → Không phụ thuộc vào response time hay tốc độ mạng
```

**So sánh executor cho case này:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **shared-iterations** (đang dùng) | ✅ **ĐÚNG** | Tổng iteration CỐ ĐỊNH (24). Mỗi iteration chạy tuần tự toàn bộ 5 sub-proofs. Số request deterministic. 1 VU đảm bảo trình tự không bị đảo. |
| constant-vus | ❌ SAI | Cần duration cố định. Case này không biết trước thời gian — 1 iteration mất ~400ms, 24 iteration mất ~9.6s, nhưng đây là OUTPUT không phải INPUT. `duration='10s'` có thể cắt ngang iteration đang chạy dở → sequence MISS/HIT bị đứt. |
| constant-arrival-rate | ❌ SAI | Ép rate cố định. Case này KHÔNG cần rate — mỗi request phải đợi request trước hoàn thành để đọc cache state. Thêm `preAllocatedVUs`, `maxVUs` là complexity vô ích. |
| per-vu-iterations | ⚠️ Được nhưng dư thừa | Với `vus: 1`, `per-vu-iterations` cho kết quả GIỐNG HỆT `shared-iterations`. Nhưng ý nghĩa semantic khác: `per-vu-iterations` ngụ ý "mỗi VU có workload riêng", trong khi case này là "1 tác vụ chung, 1 người làm". Dùng `shared-iterations` phản ánh đúng ý định hơn. |
| ramping-vus | ❌ SAI | Cần thay đổi VU theo stage. Case này chỉ cần VU ỔN ĐỊNH = 1. Thêm stage là vô nghĩa — có thể gây ra lúc có 2+ VU làm hỏng sequence. |

**Tóm tắt luồng quyết định:**

```text
Cần số iteration CỐ ĐỊNH (không phải thời gian)?
  ├── YES → Cần deterministic sequence (trình tự quan trọng)?
  │           ├── YES → shared-iterations, vus=1
  │           │         (mỗi iteration = 1 lần chạy đủ kịch bản)
  │           └── NO  → shared-iterations hoặc per-vu-iterations
  └── NO  → Cần sustained traffic trong khoảng thời gian?
              ├── YES → constant-vus (hoặc constant-arrival-rate nếu cần rate chính xác)
              └── NO  → xem lại yêu cầu

CDN variant-keys: "24 iteration cố định, sequence deterministic, 1 VU" → shared-iterations ✓
```

> **Ghi nhớ**: CDN variant-keys test quan tâm "cache key có split đúng cho từng
> dimension không?", không quan tâm "chạy được bao nhiêu request mỗi giây?".
> Số iteration (24) được chọn để có đủ sample phát hiện intermittent cache key
> issue, không phải để tạo load. Mỗi iteration là một lần chứng minh độc lập
> — iteration càng nhiều, confidence càng cao.
> → Dùng shared-iterations với vus=1, đọc `checks` sau run để biết tỷ lệ pass.

### 5.4. Phần 3: exerciseVariant() helper

Đây là trái tim của script. Một function tổng quát chạy pattern 4 bước cho mỗi dimension:

```javascript
function exerciseVariant(path, label, baseProfile, variantProfile, options = {}) {
  banUrl(path);

  const baseExpected = expectedCacheKey(baseProfile);
  const variantExpected = expectedCacheKey(variantProfile);

  const baseFirst = requestCdn('GET', path, {
    profile: baseProfile,
    tags: { case: `${label}_base_first` },
  });
  assertStatus(baseFirst, 200, `${label} base first`);
  assertUpstream(baseFirst, 'products-service', `${label} base first`);
  assertCacheState(baseFirst, 'MISS', `${label} base first`);
  assertCacheKeyHeaders(baseFirst, baseExpected, `${label} base first`, options);

  const baseSecond = requestCdn('GET', path, {
    profile: baseProfile,
    tags: { case: `${label}_base_second` },
  });
  assertStatus(baseSecond, 200, `${label} base second`);
  assertCacheState(baseSecond, 'HIT', `${label} base second`);
  assertCacheKeyHeaders(baseSecond, baseExpected, `${label} base second`, options);

  const variantFirst = requestCdn('GET', path, {
    profile: variantProfile,
    tags: { case: `${label}_variant_first` },
  });
  assertStatus(variantFirst, 200, `${label} variant first`);
  assertUpstream(variantFirst, 'products-service', `${label} variant first`);
  assertCacheState(variantFirst, 'MISS', `${label} variant first`);
  assertCacheKeyHeaders(variantFirst, variantExpected, `${label} variant first`, options);

  const variantSecond = requestCdn('GET', path, {
    profile: variantProfile,
    tags: { case: `${label}_variant_second` },
  });
  assertStatus(variantSecond, 200, `${label} variant second`);
  assertCacheState(variantSecond, 'HIT', `${label} variant second`);
  assertCacheKeyHeaders(variantSecond, variantExpected, `${label} variant second`, options);
}
```

**Phân tích tham số của `exerciseVariant`:**

| Tham số | Mô tả | Ví dụ (language) |
|---------|-------|-----------------|
| `path` | URL path cần test | `paths.productDetail` = `/api/sim/products/1` |
| `label` | Tên dimension, dùng để tạo tag | `'language'` -> tag `language_base_first` |
| `baseProfile` | Profile của base variant | `profiles.guestVNMobileControl` (vi) |
| `variantProfile` | Profile của variant cần so sánh | `profiles.guestVNMobileEnglish` (en) |
| `options` | Tùy chọn cho `assertCacheKeyHeaders` | `{ withSegment: true }` cho segment test |

**Trace execution của `exerciseVariant` cho language dimension:**

```text
exerciseVariant('/api/sim/products/1', 'language',
                guestVNMobileControl, guestVNMobileEnglish)

Input profiles:
  base:    guestVNMobileControl  -> { Accept-Language: vi, Geo: VN, Device: mobile, AB: control }
  variant: guestVNMobileEnglish  -> { Accept-Language: en, Geo: VN, Device: mobile, AB: control }
  Khác biệt DUY NHẤT: Accept-Language (vi vs en)

Expected cache keys:
  base:    { language: vi, geo: VN, device: mobile, ab: control }
  variant: { language: en, geo: VN, device: mobile, ab: control }
  Khác biệt DUY NHẤT: language (vi vs en)

Step-by-step execution:
┌─────────────────────────────────────────────────────────────┐
│ BƯỚC 0: banUrl                                             │
│   POST :8088/ops/app/cdn/cache/ban-url                     │
│   { "url": "/api/sim/products/1" }                         │
│   -> Xóa mọi object cho path này khỏi cache                │
├─────────────────────────────────────────────────────────────┤
│ BƯỚC 1: baseFirst                                         │
│   GET :80/api/sim/products/1                               │
│   Headers: Accept-Language: vi, Geo: VN, Device: mobile,   │
│            AB: control, Segment: guest                     │
│                                                             │
│   Assertions:                                               │
│   ✓ status 200                                              │
│   ✓ upstream = products-service                             │
│   ✓ X-Cache = MISS             ← key: base lần đầu -> MISS │
│   ✓ X-Cache-Key-Language = vi                               │
│   ✓ X-Cache-Key-Geo = VN                                    │
│   ✓ X-Cache-Key-Device = mobile                             │
│   ✓ X-Cache-Key-AB = control                                │
│                                                             │
│   Kết quả: Object {vi, VN, mobile, control} được cache     │
├─────────────────────────────────────────────────────────────┤
│ BƯỚC 2: baseSecond                                        │
│   GET :80/api/sim/products/1                               │
│   Headers: GIỐNG HỆT baseFirst                            │
│                                                             │
│   Assertions:                                               │
│   ✓ status 200                                              │
│   ✓ X-Cache = HIT               ← key: base lần 2 -> HIT  │
│   ✓ X-Cache-Key-Language = vi                               │
│   ✓ X-Cache-Key-Geo = VN                                    │
│   ✓ X-Cache-Key-Device = mobile                             │
│   ✓ X-Cache-Key-AB = control                                │
│                                                             │
│   Kết quả: Object {vi, VN, mobile, control} được reuse     │
├─────────────────────────────────────────────────────────────┤
│ BƯỚC 3: variantFirst                                      │
│   GET :80/api/sim/products/1                               │
│   Headers: Accept-Language: en, Geo: VN, Device: mobile,   │
│            AB: control, Segment: guest                     │
│   KHÁC base: Accept-Language = en (thay vì vi)              │
│                                                             │
│   Assertions:                                               │
│   ✓ status 200                                              │
│   ✓ upstream = products-service                             │
│   ✓ X-Cache = MISS             ← KEY: variant -> MISS      │
│   ✓ X-Cache-Key-Language = en                               │
│   ✓ X-Cache-Key-Geo = VN                                    │
│   ✓ X-Cache-Key-Device = mobile                             │
│   ✓ X-Cache-Key-AB = control                                │
│                                                             │
│   Kết quả: Object {en, VN, mobile, control} được cache     │
│   (KHÔNG reuse object {vi, VN, mobile, control})           │
│   -> CHỨNG MINH: language dimension hoạt động               │
├─────────────────────────────────────────────────────────────┤
│ BƯỚC 4: variantSecond                                     │
│   GET :80/api/sim/products/1                               │
│   Headers: GIỐNG HỆT variantFirst                         │
│                                                             │
│   Assertions:                                               │
│   ✓ status 200                                              │
│   ✓ X-Cache = HIT               ← key: variant lần 2-> HIT│
│   ✓ X-Cache-Key-Language = en                               │
│   ✓ X-Cache-Key-Geo = VN                                    │
│   ✓ X-Cache-Key-Device = mobile                             │
│   ✓ X-Cache-Key-AB = control                                │
│                                                             │
│   Kết quả: Object {en, VN, mobile, control} được reuse     │
└─────────────────────────────────────────────────────────────┘
```

**Tại sao `variantFirst` phải MISS:**

Nếu `variantFirst` trả HIT, điều đó có nghĩa là CDN đã reuse object của `base` cho `variant`. Cache key của hai request này khác nhau ở dimension language (`vi` vs `en`), nhưng CDN đã không tính language vào cache key -> cache leakage.

Đây là assertion quan trọng nhất của toàn bộ case: **variant khác base -> phải MISS**.

### 5.5. Phần 4: default function

```javascript
export default function () {
  exerciseVariant(paths.productDetail, 'language', profiles.guestVNMobileControl, profiles.guestVNMobileEnglish);
  exerciseVariant(paths.productDetail, 'geo', profiles.guestVNMobileControl, profiles.guestUSMobileControl);
  exerciseVariant(paths.productDetail, 'device', profiles.guestVNMobileControl, profiles.guestVNDesktopControl);
  exerciseVariant(paths.productDetail, 'ab_variant', profiles.guestVNMobileControl, profiles.guestVNMobileVariantA);
  exerciseVariant(paths.homefeed, 'segment', profiles.guestVNMobileVariantA, profiles.returningVNMobileVariantA, { withSegment: true });
}
```

**Phân tích từng lời gọi:**

### Sub-proof 1: Language dimension

```javascript
exerciseVariant(
  paths.productDetail,              // /api/sim/products/1
  'language',                       // label
  profiles.guestVNMobileControl,    // base: vi
  profiles.guestVNMobileEnglish     // variant: en
);
```

| Thuộc tính | Base (guestVNMobileControl) | Variant (guestVNMobileEnglish) |
|-----------|---------------------------|-------------------------------|
| Accept-Language | `vi` | `en` |
| X-Geo-Country | `VN` | `VN` |
| X-Device-Class | `mobile` | `mobile` |
| X-Ab-Variant | `control` | `control` |
| X-User-Segment | `guest` | `guest` |

**Điểm khác biệt duy nhất:** `Accept-Language: vi` vs `Accept-Language: en`

**Điều cần chứng minh:** CDN tạo 2 object riêng cho tiếng Việt và tiếng Anh, dù tất cả các dimension khác giống hệt nhau.

### Sub-proof 2: Geo dimension

```javascript
exerciseVariant(
  paths.productDetail,
  'geo',
  profiles.guestVNMobileControl,    // base: VN
  profiles.guestUSMobileControl     // variant: US
);
```

| Thuộc tính | Base (guestVNMobileControl) | Variant (guestUSMobileControl) |
|-----------|---------------------------|-------------------------------|
| Accept-Language | `vi` | `vi` |
| X-Geo-Country | `VN` | `US` |
| X-Device-Class | `mobile` | `mobile` |
| X-Ab-Variant | `control` | `control` |
| X-User-Segment | `guest` | `guest` |

**Điểm khác biệt duy nhất:** `X-Geo-Country: VN` vs `X-Geo-Country: US`

**Điều cần chứng minh:** CDN tạo 2 object riêng cho Việt Nam và Mỹ. Người dùng Mỹ thấy giá USD, không phải VND.

### Sub-proof 3: Device dimension

```javascript
exerciseVariant(
  paths.productDetail,
  'device',
  profiles.guestVNMobileControl,     // base: mobile
  profiles.guestVNDesktopControl     // variant: desktop
);
```

| Thuộc tính | Base (guestVNMobileControl) | Variant (guestVNDesktopControl) |
|-----------|---------------------------|--------------------------------|
| Accept-Language | `vi` | `vi` |
| X-Geo-Country | `VN` | `VN` |
| X-Device-Class | `mobile` | `desktop` |
| X-Ab-Variant | `control` | `control` |
| X-User-Segment | `guest` | `guest` |

**Điểm khác biệt duy nhất:** `X-Device-Class: mobile` vs `X-Device-Class: desktop`

**Điều cần chứng minh:** CDN tạo 2 object riêng cho mobile và desktop. Người dùng mobile không thấy giao diện desktop.

### Sub-proof 4: AB variant dimension

```javascript
exerciseVariant(
  paths.productDetail,
  'ab_variant',
  profiles.guestVNMobileControl,      // base: control
  profiles.guestVNMobileVariantA      // variant: variant-a
);
```

| Thuộc tính | Base (guestVNMobileControl) | Variant (guestVNMobileVariantA) |
|-----------|---------------------------|-------------------------------|
| Accept-Language | `vi` | `vi` |
| X-Geo-Country | `VN` | `VN` |
| X-Device-Class | `mobile` | `mobile` |
| X-Ab-Variant | `control` | `variant-a` |
| X-User-Segment | `guest` | `guest` |

**Điểm khác biệt duy nhất:** `X-Ab-Variant: control` vs `X-Ab-Variant: variant-a`

**Điều cần chứng minh:** CDN tạo 2 object riêng cho nhóm control và nhóm A/B test. Dữ liệu analytics không bị nhiễu.

### Sub-proof 5: Segment dimension

```javascript
exerciseVariant(
  paths.homefeed,                      // /api/sim/products/homefeed (KHÔNG phải productDetail)
  'segment',
  profiles.guestVNMobileVariantA,      // base: guest
  profiles.returningVNMobileVariantA,  // variant: returning
  { withSegment: true }                // BẬT segment dimension trong assertion
);
```

| Thuộc tính | Base (guestVNMobileVariantA) | Variant (returningVNMobileVariantA) |
|-----------|---------------------------|-----------------------------------|
| Accept-Language | `vi` | `vi` |
| X-Geo-Country | `VN` | `VN` |
| X-Device-Class | `mobile` | `mobile` |
| X-Ab-Variant | `variant-a` | `variant-a` |
| X-User-Segment | `guest` | `returning` |

**Điểm khác biệt duy nhất:** `X-User-Segment: guest` vs `X-User-Segment: returning`

**Khác biệt quan trọng so với 4 sub-proof trên:**

1. **Endpoint khác**: `paths.homefeed` (`/api/sim/products/homefeed`) thay vì `paths.productDetail`. Segment dimension chỉ được hash cho một số endpoint như homefeed, recommendations — không phải mọi endpoint.
2. **options `{ withSegment: true }`**: Tham số này báo cho `assertCacheKeyHeaders` kiểm tra cả `X-Cache-Key-Segment` header (mặc định là `false` cho 4 sub-proof trên).
3. **Cả base và variant đều dùng `variant-a`**: Để đảm bảo chỉ có segment là khác biệt, không có dimension nào khác.

### 5.6. Cơ chế `options` trong `assertCacheKeyHeaders`

Hàm `assertCacheKeyHeaders` trong `shared.js` có tham số `options` để kiểm soát dimension nào được assert:

```javascript
export function assertCacheKeyHeaders(res, expected, label, options = {}) {
  const withDevice = options.withDevice !== false;   // default: true
  const withAB = options.withAB !== false;           // default: true
  const withSegment = options.withSegment === true;  // default: false (!)
  check(res, {
    [`${label} cache language ${expected.language}`]: (r) => getHeader(r, 'X-Cache-Key-Language') === expected.language,
    [`${label} cache geo ${expected.geo}`]: (r) => getHeader(r, 'X-Cache-Key-Geo') === expected.geo,
    [`${label} cache device ${expected.device}`]: (r) => !withDevice || getHeader(r, 'X-Cache-Key-Device') === expected.device,
    [`${label} cache ab ${expected.ab}`]: (r) => !withAB || getHeader(r, 'X-Cache-Key-AB') === expected.ab,
    [`${label} cache segment ${expected.segment}`]: (r) => !withSegment || getHeader(r, 'X-Cache-Key-Segment') === expected.segment,
  });
}
```

**Bảng logic assertion:**

| Dimension | `withDevice=true` (default) | `withSegment=true` |
|-----------|---------------------------|-------------------|
| Language | Luôn assert | Luôn assert |
| Geo | Luôn assert | Luôn assert |
| Device | Assert | Assert |
| AB | Assert | Assert |
| Segment | **Không assert** | **Assert** |

Lý do segment mặc định không được assert: không phải mọi endpoint đều hash segment vào cache key. Với product detail, segment không nằm trong cache key (guest và returning share cùng cache object cho product detail — đó là behavior đúng). Với homefeed, segment được hash.

---

## 6. Cache key model / VCL deep-dive

### 6.1. Full cache key structure

Cache key trong hệ thống này gồm các thành phần:

```text
Cache Key = hash(
    req.url (path + normalized query)
    + X-Cache-Key-Language   (normalized từ Accept-Language)
    + X-Cache-Key-Geo        (normalized từ X-Geo-Country)
    + X-Cache-Key-Device     (normalized từ X-Device-Class)
    + X-Cache-Key-AB         (normalized từ X-Ab-Variant)
    + X-Cache-Key-Segment    (normalized từ X-User-Segment, CHỈ cho một số endpoint)
)
```

### 6.2. Decision flowchart: segment có được hash không?

```text
Request đến Varnish
  │
  ├─ Path match "/api/sim/products/homefeed" ?
  │   ├─ YES -> Hash X-Cache-Key-Segment vào cache key
  │   └─ NO  -> Tiếp tục
  │
  ├─ Path match "/api/sim/products/*/recommendations" ?
  │   ├─ YES -> Hash X-Cache-Key-Segment vào cache key
  │   └─ NO  -> Tiếp tục
  │
  └─ Các path khác (product detail, search, categories, ...)
      -> KHÔNG hash X-Cache-Key-Segment
```

### 6.3. VCL pseudo-code

```vcl
sub vcl_recv {
    // Normalize Accept-Language
    if (req.http.Accept-Language ~ "^vi") {
        set req.http.X-Cache-Key-Language = "vi";
    } elsif (req.http.Accept-Language ~ "^en") {
        set req.http.X-Cache-Key-Language = "en";
    } elsif (req.http.Accept-Language ~ "^ja") {
        set req.http.X-Cache-Key-Language = "ja";
    } else {
        set req.http.X-Cache-Key-Language = "en";
    }

    // Normalize X-Geo-Country
    if (req.http.X-Geo-Country ~ "^(US|SG|JP)$") {
        set req.http.X-Cache-Key-Geo = req.http.X-Geo-Country;
    } else {
        set req.http.X-Cache-Key-Geo = "VN";
    }

    // Normalize X-Device-Class
    if (req.http.X-Device-Class ~ "^(mobile|tablet|desktop)$") {
        set req.http.X-Cache-Key-Device = req.http.X-Device-Class;
    } else {
        set req.http.X-Cache-Key-Device = "desktop";
    }

    // Normalize X-Ab-Variant
    if (req.http.X-Ab-Variant ~ "^(variant-a|variant-b)$") {
        set req.http.X-Cache-Key-AB = req.http.X-Ab-Variant;
    } else {
        set req.http.X-Cache-Key-AB = "control";
    }

    // Normalize X-User-Segment (chỉ set nếu có header)
    if (req.http.X-User-Segment ~ "^(new_user|returning|vip)$") {
        set req.http.X-Cache-Key-Segment = req.http.X-User-Segment;
    } elsif (req.http.X-User-Segment) {
        set req.http.X-Cache-Key-Segment = "guest";
    }
}

sub vcl_hash {
    hash_data(req.url);
    hash_data(req.http.X-Cache-Key-Language);
    hash_data(req.http.X-Cache-Key-Geo);
    hash_data(req.http.X-Cache-Key-Device);
    hash_data(req.http.X-Cache-Key-AB);

    // Segment dimension — chỉ cho một số path
    if (req.url ~ "^/api/sim/products/homefeed" ||
        req.url ~ "^/api/sim/products/\d+/recommendations") {
        if (req.http.X-Cache-Key-Segment) {
            hash_data(req.http.X-Cache-Key-Segment);
        }
    }
}
```

### 6.4. Normalization rules — bảng đầy đủ

#### Language normalization

| Input `Accept-Language` | Output `X-Cache-Key-Language` | Ghi chú |
|------------------------|------------------------------|---------|
| `vi` | `vi` | |
| `vi-VN` | `vi` | Cắt 2 ký tự đầu |
| `vi-VN,vi;q=0.9,en;q=0.8` | `vi` | Lấy language đầu tiên |
| `en` | `en` | |
| `en-US,en;q=0.9` | `en` | |
| `ja` | `ja` | |
| `ja-JP` | `ja` | |
| `fr` | `en` | Fallback — không nằm trong danh sách `[vi, en, ja]` |
| `fr-FR` | `en` | Fallback |
| (không có header) | `en` | Default |
| ` ` (whitespace only) | `en` | Trim + default |

#### Geo normalization

| Input `X-Geo-Country` | Output `X-Cache-Key-Geo` | Ghi chú |
|----------------------|--------------------------|---------|
| `VN` | `VN` | |
| `vn` | `VN` | Uppercase normalization |
| `US` | `US` | |
| `SG` | `SG` | |
| `JP` | `JP` | |
| `UK` | `VN` | Fallback — không nằm trong danh sách `[VN, US, SG, JP]`? Thực ra VN là default |
| `DE` | `VN` | Fallback về VN |
| (không có header) | `VN` | Default |
| ` ` (whitespace) | `VN` | Trim + default |

#### Device normalization

| Input `X-Device-Class` | Output `X-Cache-Key-Device` | Ghi chú |
|-----------------------|----------------------------|---------|
| `mobile` | `mobile` | |
| `Mobile` | `mobile` | Lowercase |
| `tablet` | `tablet` | |
| `desktop` | `desktop` | |
| `phone` | `desktop` | Fallback — không nằm trong danh sách |
| `smarttv` | `desktop` | Fallback |
| (không có header) | `desktop` | Default |

#### AB variant normalization

| Input `X-Ab-Variant` | Output `X-Cache-Key-AB` | Ghi chú |
|---------------------|------------------------|---------|
| `control` | `control` | |
| `Control` | `control` | Lowercase |
| `variant-a` | `variant-a` | |
| `variant-b` | `variant-b` | |
| `variant-c` | `control` | Fallback — không nằm trong danh sách |
| `test` | `control` | Fallback |
| (không có header) | `control` | Default |

#### Segment normalization

| Input `X-User-Segment` | Output `X-Cache-Key-Segment` | Ghi chú |
|-----------------------|-----------------------------|---------|
| `guest` | `guest` | |
| `new_user` | `new_user` | |
| `returning` | `returning` | |
| `vip` | `vip` | |
| `premium` | `guest` | Fallback — không nằm trong danh sách |
| (không có header) | `guest` | Default |
| `GUEST` | `guest` | Lowercase |

### 6.5. Ma trận kết hợp — cách đọc cache key

Với 5 dimensions, tổ hợp tối đa lý thuyết:

```text
Language (3) × Geo (4) × Device (3) × AB (3) × Segment (4) = 432 tổ hợp
```

Trong thực tế, không phải mọi tổ hợp đều tồn tại và không phải mọi endpoint đều hash segment. Với product detail (không hash segment): 3 × 4 × 3 × 3 = 108 cache objects tiềm năng cho cùng một URL.

---

## 7. Request sequence flow

### 7.1. Timeline một iteration đầy đủ

```text
ITERATION 1 (trong 24 iterations)
═══════════════════════════════════════════════════════════════

┌─ SUB-PROOF 1: LANGUAGE ─────────────────────────────────┐
│ T+0.00s  banUrl /api/sim/products/1                     │
│ T+0.05s  GET (vi)  -> MISS, cache key {vi, VN, m, ctrl} │
│ T+0.10s  GET (vi)  -> HIT                              │
│ T+0.15s  GET (en)  -> MISS, cache key {en, VN, m, ctrl} │
│ T+0.20s  GET (en)  -> HIT                              │
│          → Language split VERIFIED                      │
└──────────────────────────────────────────────────────────┘

┌─ SUB-PROOF 2: GEO ─────────────────────────────────────┐
│ T+0.25s  banUrl /api/sim/products/1                     │
│ T+0.30s  GET (VN)  -> MISS, cache key {vi, VN, m, ctrl} │
│ T+0.35s  GET (VN)  -> HIT                              │
│ T+0.40s  GET (US)  -> MISS, cache key {vi, US, m, ctrl} │
│ T+0.45s  GET (US)  -> HIT                              │
│          → Geo split VERIFIED                           │
└──────────────────────────────────────────────────────────┘

┌─ SUB-PROOF 3: DEVICE ──────────────────────────────────┐
│ T+0.50s  banUrl /api/sim/products/1                     │
│ T+0.55s  GET (mobile)  -> MISS, key {vi, VN, mob, ctrl} │
│ T+0.60s  GET (mobile)  -> HIT                           │
│ T+0.65s  GET (desktop) -> MISS, key {vi, VN, dsk, ctrl} │
│ T+0.70s  GET (desktop) -> HIT                           │
│          → Device split VERIFIED                        │
└──────────────────────────────────────────────────────────┘

┌─ SUB-PROOF 4: AB VARIANT ──────────────────────────────┐
│ T+0.75s  banUrl /api/sim/products/1                     │
│ T+0.80s  GET (control)   -> MISS, key {vi,VN,m,ctrl}    │
│ T+0.85s  GET (control)   -> HIT                         │
│ T+0.90s  GET (variant-a) -> MISS, key {vi,VN,m,var-a}   │
│ T+0.95s  GET (variant-a) -> HIT                         │
│          → AB variant split VERIFIED                    │
└──────────────────────────────────────────────────────────┘

┌─ SUB-PROOF 5: SEGMENT (homefeed endpoint) ─────────────┐
│ T+1.00s  banUrl /api/sim/products/homefeed              │
│ T+1.05s  GET (guest)     -> MISS, key {vi,VN,m,var-a,g} │
│ T+1.10s  GET (guest)     -> HIT                         │
│ T+1.15s  GET (returning) -> MISS, key {vi,VN,m,var-a,r} │
│ T+1.20s  GET (returning) -> HIT                         │
│          → Segment split VERIFIED                       │
└──────────────────────────────────────────────────────────┘

Tổng: 1.2 giây cho 1 iteration, 20 HTTP requests + 5 control requests
```

### 7.2. State machine của cache object cho một dimension

```text
CHO MỘT PATH (vd: /api/sim/products/1)
═══════════════════════════════════════

Sau banUrl:
  Cache rỗng — không có object nào

Sau baseFirst (vi):
  ┌────────────────────────────┐
  │ Object A: key={vi,VN,m,ct} │  ← MISS, mới tạo
  └────────────────────────────┘

Sau baseSecond (vi):
  ┌────────────────────────────┐
  │ Object A: key={vi,VN,m,ct} │  ← HIT, reuse
  └────────────────────────────┘

Sau variantFirst (en):
  ┌────────────────────────────┐
  │ Object A: key={vi,VN,m,ct} │  ← vẫn tồn tại
  ├────────────────────────────┤
  │ Object B: key={en,VN,m,ct} │  ← MISS, mới tạo (KEY KHÁC A)
  └────────────────────────────┘

Sau variantSecond (en):
  ┌────────────────────────────┐
  │ Object A: key={vi,VN,m,ct} │  ← vẫn tồn tại
  ├────────────────────────────┤
  │ Object B: key={en,VN,m,ct} │  ← HIT, reuse
  └────────────────────────────┘

KẾT LUẬN: 2 object riêng biệt cho 2 language variants ✓
```

### 7.3. Điều gì xảy ra nếu cache key thiếu dimension?

```text
GIẢ SỬ: VCL không hash Accept-Language (BUG)

Sau banUrl:
  Cache rỗng

Sau baseFirst (vi):
  ┌──────────────────────────────┐
  │ Object X: key={VN,m,ct}      │  ← MISS, cache KHÔNG có language
  └──────────────────────────────┘

Sau baseSecond (vi):
  ┌──────────────────────────────┐
  │ Object X: key={VN,m,ct}      │  ← HIT (đúng)
  └──────────────────────────────┘

Sau variantFirst (en):
  ┌──────────────────────────────┐
  │ Object X: key={VN,m,ct}      │  ← HIT (SAI! Lẽ ra phải MISS)
  └──────────────────────────────┘
  → CASE FAIL: variantFirst expected MISS but got HIT
  → Nguyên nhân: cache key thiếu language dimension
  → Hậu quả: User en nhận response tiếng Việt
```

---

## 8. Key signals / headers cần verify

### 8.1. Bảng tổng hợp headers cho từng sub-proof

#### Sub-proof 1: Language

| Header | Base (vi) expected | Variant (en) expected | Asserted? |
|--------|-------------------|----------------------|-----------|
| `X-Cache` | MISS -> HIT | MISS -> HIT | YES |
| `X-Cache-Key-Language` | `vi` | `en` | YES |
| `X-Cache-Key-Geo` | `VN` | `VN` | YES |
| `X-Cache-Key-Device` | `mobile` | `mobile` | YES |
| `X-Cache-Key-AB` | `control` | `control` | YES |
| `X-Cache-Key-Segment` | (không assert) | (không assert) | NO |

#### Sub-proof 2: Geo

| Header | Base (VN) expected | Variant (US) expected | Asserted? |
|--------|-------------------|----------------------|-----------|
| `X-Cache` | MISS -> HIT | MISS -> HIT | YES |
| `X-Cache-Key-Language` | `vi` | `vi` | YES |
| `X-Cache-Key-Geo` | `VN` | `US` | YES |
| `X-Cache-Key-Device` | `mobile` | `mobile` | YES |
| `X-Cache-Key-AB` | `control` | `control` | YES |
| `X-Cache-Key-Segment` | (không assert) | (không assert) | NO |

#### Sub-proof 3: Device

| Header | Base (mobile) expected | Variant (desktop) expected | Asserted? |
|--------|----------------------|--------------------------|-----------|
| `X-Cache` | MISS -> HIT | MISS -> HIT | YES |
| `X-Cache-Key-Language` | `vi` | `vi` | YES |
| `X-Cache-Key-Geo` | `VN` | `VN` | YES |
| `X-Cache-Key-Device` | `mobile` | `desktop` | YES |
| `X-Cache-Key-AB` | `control` | `control` | YES |
| `X-Cache-Key-Segment` | (không assert) | (không assert) | NO |

#### Sub-proof 4: AB variant

| Header | Base (control) expected | Variant (variant-a) expected | Asserted? |
|--------|----------------------|----------------------------|-----------|
| `X-Cache` | MISS -> HIT | MISS -> HIT | YES |
| `X-Cache-Key-Language` | `vi` | `vi` | YES |
| `X-Cache-Key-Geo` | `VN` | `VN` | YES |
| `X-Cache-Key-Device` | `mobile` | `mobile` | YES |
| `X-Cache-Key-AB` | `control` | `variant-a` | YES |
| `X-Cache-Key-Segment` | (không assert) | (không assert) | NO |

#### Sub-proof 5: Segment (homefeed)

| Header | Base (guest) expected | Variant (returning) expected | Asserted? |
|--------|---------------------|----------------------------|-----------|
| `X-Cache` | MISS -> HIT | MISS -> HIT | YES |
| `X-Cache-Key-Language` | `vi` | `vi` | YES |
| `X-Cache-Key-Geo` | `VN` | `VN` | YES |
| `X-Cache-Key-Device` | `mobile` | `mobile` | YES |
| `X-Cache-Key-AB` | `variant-a` | `variant-a` | YES |
| `X-Cache-Key-Segment` | `guest` | `returning` | YES |

### 8.2. Cách đọc `X-Cache-Key-*` để chẩn đoán leakage

```text
SCENARIO: User Mỹ (en-US, desktop) thấy giá VND

Debug steps:
  1. Gọi GET /api/sim/products/1 với header của user Mỹ
  2. Đọc response headers:

     Case A — Không có leakage:
       X-Cache-Key-Language: en
       X-Cache-Key-Geo: US
       X-Cache-Key-Device: desktop
       X-Cache: MISS (nếu lần đầu) hoặc HIT (nếu đã warm)
       -> Cache key đúng, vấn đề ở application layer

     Case B — Leakage do thiếu dimension:
       X-Cache-Key-Language: vi      ← SAI! Lẽ ra phải là en
       X-Cache-Key-Geo: VN           ← SAI! Lẽ ra phải là US
       X-Cache: HIT
       -> Cache key thiếu language và geo -> đang reuse object sai

     Case C — Leakage do normalization sai:
       X-Cache-Key-Language: en
       X-Cache-Key-Geo: US
       Nhưng response body vẫn là tiếng Việt
       -> Application layer không xử lý variant headers
```

---

## 9. Pass/fail criteria

### 9.1. Điều kiện PASS

| # | Điều kiện | Sub-proof | Cách verify |
|---|-----------|-----------|-------------|
| 1 | k6 exit code = 0 | Tất cả | Shell |
| 2 | Threshold `checks: rate==1` pass | Tất cả | k6 output |
| 3 | **Language**: baseFirst MISS, baseSecond HIT, variantFirst MISS, variantSecond HIT | Language | Check logs |
| 4 | **Language**: `X-Cache-Key-Language` = `vi` cho base, `en` cho variant | Language | Check logs |
| 5 | **Geo**: baseFirst MISS, baseSecond HIT, variantFirst MISS, variantSecond HIT | Geo | Check logs |
| 6 | **Geo**: `X-Cache-Key-Geo` = `VN` cho base, `US` cho variant | Geo | Check logs |
| 7 | **Device**: baseFirst MISS, baseSecond HIT, variantFirst MISS, variantSecond HIT | Device | Check logs |
| 8 | **Device**: `X-Cache-Key-Device` = `mobile` cho base, `desktop` cho variant | Device | Check logs |
| 9 | **AB**: baseFirst MISS, baseSecond HIT, variantFirst MISS, variantSecond HIT | AB | Check logs |
| 10 | **AB**: `X-Cache-Key-AB` = `control` cho base, `variant-a` cho variant | AB | Check logs |
| 11 | **Segment**: baseFirst MISS, baseSecond HIT, variantFirst MISS, variantSecond HIT | Segment | Check logs |
| 12 | **Segment**: `X-Cache-Key-Segment` = `guest` cho base, `returning` cho variant | Segment | Check logs |
| 13 | Tất cả 24 iterations pass | Tất cả | Check logs không có fail |
| 14 | Mỗi sub-proof variantFirst luôn MISS (không bao giờ HIT) | Tất cả | Quan trọng nhất |

### 9.2. Điều kiện FAIL

#### FAIL-1: Variant trả HIT thay vì MISS

```text
language_variant_first: expected MISS but got HIT
```

Đây là **fail nghiêm trọng nhất** — cache key thiếu dimension.

**Chẩn đoán:**

| Bước | Hành động |
|------|-----------|
| 1 | Đọc `X-Cache-Key-*` headers của variantFirst |
| 2 | So sánh với `X-Cache-Key-*` của baseSecond |
| 3 | Nếu giống hệt -> VCL không hash dimension này |
| 4 | Nếu khác nhưng vẫn HIT -> VCL hash sai giá trị |
| 5 | Kiểm tra VCL `vcl_hash` — dimension có được `hash_data` không? |

#### FAIL-2: Base lần 2 không HIT

```text
language_base_second: expected HIT but got MISS
```

**Nguyên nhân có thể:**
- TTL quá ngắn, object expire giữa baseFirst và baseSecond
- Có background process invalidate object
- Cache storage eviction

#### FAIL-3: Cache key headers sai

```text
language_base_first: X-Cache-Key-Language expected vi but got en
```

**Nguyên nhân có thể:**
- VCL normalization không khớp với `expectedCacheKey()` helper
- Header bị ghi đè bởi middleware trước VCL
- Có logic đặc biệt cho path này trong VCL

#### FAIL-4: Segment test fail dù 4 test kia pass

```text
segment_variant_first: expected MISS but got HIT
```

**Nguyên nhân đặc thù:**
- Homefeed endpoint không hash segment (VCL rule chỉ áp dụng cho product detail)
- `withSegment: true` nhưng VCL không set `X-Cache-Key-Segment` header

#### FAIL-5: Intermittent fail (một vài iteration fail)

```text
Iteration 1-5: all pass
Iteration 6:   language_variant_first fail (HIT instead of MISS)
Iteration 7-24: all pass
```

**Nguyên nhân có thể:**
- Timing issue: banUrl chưa hoàn tất trước khi gọi baseFirst
- Cache vẫn còn object từ iteration trước do banUrl async
- Network latency spike làm request đến sai thứ tự

**Cách fix:**
- Thêm sleep ngắn sau `banUrl()`
- Kiểm tra banUrl response: status phải là 200
- Tăng timeout cho control request

---

## 10. Cách chạy + output mẫu

### 10.1. Lệnh chạy

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scripts\run-cdn-capabilities.ps1 -Scenarios 02-variant-keys
```

Hoặc chạy trực tiếp:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:OPS_AUTH_TOKEN = "<ops-token>"
k6 run load-target/k6/cdn/02-variant-keys.js
```

Với custom iterations:

```powershell
$env:VARIANT_KEYS_ITERATIONS = 10
k6 run load-target/k6/cdn/02-variant-keys.js
```

### 10.2. Output mẫu — k6 console (1 iteration)

```text

          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: load-target/k6/cdn/02-variant-keys.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations for each of 1 VUs (maxDuration: 10m0s, exec: default, gracefulStop: 30s)

  █ default

  ✓ language base first status 200
  ✓ language base first upstream products-service
  ✓ language base first cache state MISS
  ✓ language base first cache language vi
  ✓ language base first cache geo VN
  ✓ language base first cache device mobile
  ✓ language base first cache ab control

  ✓ language base second status 200
  ✓ language base second cache state HIT
  ✓ language base second cache language vi
  ✓ language base second cache geo VN
  ✓ language base second cache device mobile
  ✓ language base second cache ab control

  ✓ language variant first status 200
  ✓ language variant first upstream products-service
  ✓ language variant first cache state MISS
  ✓ language variant first cache language en
  ✓ language variant first cache geo VN
  ✓ language variant first cache device mobile
  ✓ language variant first cache ab control

  ✓ language variant second status 200
  ✓ language variant second cache state HIT
  ✓ language variant second cache language en
  ✓ language variant second cache geo VN
  ✓ language variant second cache device mobile
  ✓ language variant second cache ab control

  ... (geo, device, ab_variant sub-proofs tương tự) ...

  ✓ segment base first status 200
  ✓ segment base first upstream products-service
  ✓ segment base first cache state MISS
  ✓ segment base first cache segment guest

  ✓ segment base second cache state HIT
  ✓ segment base second cache segment guest

  ✓ segment variant first status 200
  ✓ segment variant first upstream products-service
  ✓ segment variant first cache state MISS
  ✓ segment variant first cache segment returning

  ✓ segment variant second cache state HIT
  ✓ segment variant second cache segment returning

     ✓ checks.........................: 100.00% ✓ 1840       ✗ 0

  running (00m00.4s), 0/1 VUs, 1 complete and 0 interrupted iterations
  default ✓ [======================================] 1 VUs  00m00.4s/10m0s  1/1 shared iters
```

### 10.3. Output mẫu — 24 iterations

```text
running (00m08.7s), 0/1 VUs, 24 complete and 0 interrupted iterations

✓ checks.........................: 100.00% ✓ 44160      ✗ 0

Total requests: 24 iterations × 25 requests = 600 requests
  - 120 control requests (ban-url × 5 sub-proofs × 24 iterations)
  - 480 public requests (4 requests × 5 sub-proofs × 24 iterations)

All checks passed: 44,160 / 44,160
Exit code: 0
```

### 10.4. Cách đọc output cho variant test

1. **Tìm dòng `variant first cache state MISS`**: Đây là dòng quan trọng nhất. Nếu có dòng `variant first cache state HIT` thay vì MISS -> cache key bug.
2. **So sánh cache key headers giữa base và variant**: Mỗi cặp (base second, variant first) phải có ít nhất 1 cache key header khác nhau.
3. **Tìm pattern fail**: Nếu fail luôn ở cùng một dimension -> VCL bug ở dimension đó. Nếu fail ngẫu nhiên -> timing/race condition.

---

## 11. Bốn output -> decision scenarios

### 11.1. Scenario A: Pass thật (True Positive)

```text
Kết quả:
  ✓ k6 exit 0
  ✓ checks 100%
  ✓ 5/5 sub-proofs: base MISS->HIT, variant MISS->HIT
  ✓ Cache key headers khác nhau giữa base và variant cho mỗi dimension

Kết luận: Cache key model hoạt động đúng cho tất cả 5 dimensions.
         CDN tạo object riêng cho từng variant và reuse đúng object cho cùng variant.

Hành động: Chuyển sang case 03 (bypass rules).
```

### 11.2. Scenario B: Fail thật (True Negative)

```text
Kết quả:
  ✗ k6 exit 1
  ✗ language: variantFirst = HIT (expected MISS)
  ✓ geo, device, AB, segment: pass

Kết luận: Language dimension không được hash vào cache key.
         User en sẽ nhận cached response của user vi.

Hành động:
  1. Kiểm tra VCL vcl_hash: có hash_data(req.http.X-Cache-Key-Language) không?
  2. Kiểm tra VCL vcl_recv: X-Cache-Key-Language có được set trước vcl_hash không?
  3. Nếu VCL đúng, kiểm tra xem có VCL khác override không
  4. Deploy fix và chạy lại case
```

### 11.3. Scenario C: Pass giả (False Positive)

```text
Kết quả:
  ✓ k6 exit 0
  ✓ checks 100%
  ✓ variantFirst = MISS cho tất cả dimensions

Nhưng thực tế:
  - Origin luôn trả response giống hệt cho mọi variant
  - VariantFirst MISS không phải vì cache key khác, mà vì object bị evict
  - Hoặc: banUrl async chưa hoàn tất, baseFirst cũng MISS do cache rỗng thật

Cách phát hiện:
  - So sánh response body của base và variant: nếu giống hệt -> origin không phân biệt variant
  - Chạy thêm 1 variantThird request: nếu HIT -> cache key đúng, nếu lại MISS -> eviction
  - Kiểm tra TTL: nếu quá ngắn (<1s), có thể object expire trước khi variantFirst chạy

Phòng tránh:
  - Thêm variantThird request để verify HIT cho variant
  - Verify response body khác nhau giữa các variant
  - Đảm bảo origin thực sự trả response khác nhau
```

### 11.4. Scenario D: Fail giả (False Negative)

```text
Kết quả:
  ✗ k6 exit 1
  ✗ segment: variantFirst = HIT (expected MISS)

Nhưng thực tế:
  - Homefeed endpoint không hash segment (đúng spec)
  - Test script kỳ vọng segment được hash cho homefeed, nhưng spec nói ngược lại
  - Hoặc: banUrl fail (ops token sai) -> object cũ vẫn trong cache -> variantFirst HIT

Cách phát hiện:
  - Đọc spec/design doc: segment có được hash cho homefeed không?
  - Kiểm tra banUrl response status
  - Dùng origin request count để xác nhận: nếu count không tăng -> vẫn HIT object cũ

Phòng tránh:
  - Verify banUrl response trước khi continue
  - Document rõ dimension nào được hash cho endpoint nào
  - Assert banUrl status = 200
```

---

## 12. Nghịch lý / misconceptions

### 12.1. "Chỉ cần test 1 dimension — các dimension khác hoạt động tương tự"

**SAI.** Mỗi dimension có VCL implementation riêng:

- Language: normalize từ `Accept-Language` (header chuẩn HTTP)
- Geo: normalize từ `X-Geo-Country` (custom header)
- Device: normalize từ `X-Device-Class` (custom header)
- AB: normalize từ `X-Ab-Variant` (custom header)
- Segment: normalize từ `X-User-Segment` (custom header) + điều kiện path

Mỗi dimension có thể có bug riêng. Language có thể hoạt động (vì được test nhiều) nhưng segment có thể fail (vì phức tạp hơn với điều kiện path).

### 12.2. "Thêm Vary header vào response là đủ — không cần hash trong VCL"

**SAI.** `Vary` header có tác dụng với browser cache và intermediate proxy, nhưng Varnish cần explicit `hash_data()` trong `vcl_hash`.

```text
Browser cache:
  Response: Vary: Accept-Language
  -> Browser cache key = URL + Accept-Language

Varnish cache:
  VCL: hash_data(req.http.X-Cache-Key-Language)
  -> Varnish cache key = URL + X-Cache-Key-Language
  (Vary header KHÔNG tự động được thêm vào hash)
```

`Vary` và `hash_data` là hai cơ chế độc lập. Cần cả hai.

### 12.3. "Tất cả endpoint đều hash tất cả dimensions"

**SAI.** Segment dimension là ví dụ điển hình: nó chỉ được hash cho homefeed và recommendations, không phải product detail.

Lý do: Segment-sensitive data (như giá ưu đãi cá nhân) thường chỉ xuất hiện trên homefeed và recommendation — nơi hiển thị giá được cá nhân hóa. Product detail thường hiển thị giá niêm yết (giống nhau cho mọi segment).

Nếu hash segment cho mọi endpoint:
- Cache bị fragment không cần thiết (guest, returning, new_user, vip -> 4 object cho cùng một product detail)
- Cache hit ratio giảm
- Tốn cache storage

### 12.4. "Có thể test nhiều dimension cùng lúc — nhanh hơn"

**SAI cho correctness test.** Mỗi sub-proof cần isolation:

```text
SAI — Test language và geo cùng lúc:
  exerciseVariant(path, 'language_and_geo',
    guestVNMobileControl,       // {vi, VN, mobile, control}
    guestUSDesktopControl       // {en, US, desktop, control}
  );
  -> Khác biệt 3 dimensions cùng lúc
  -> Nếu variantFirst MISS, không biết dimension nào gây ra
  -> Không xác định được root cause

ĐÚNG — Test từng dimension riêng biệt:
  exerciseVariant(path, 'language', guestVNMobileControl, guestVNMobileEnglish);
  exerciseVariant(path, 'geo', guestVNMobileControl, guestUSMobileControl);
  exerciseVariant(path, 'device', guestVNMobileControl, guestVNDesktopControl);
  -> Mỗi test chỉ thay đổi 1 dimension
  -> Nếu fail, biết chính xác dimension nào
```

### 12.5. "Cache key dimensions là cố định — không cần test lại sau mỗi deploy"

**SAI.** Cache key model có thể thay đổi khi:

1. **Thêm dimension mới** (vd: thêm `X-Cache-Key-Partner` cho B2B)
2. **Sửa normalization rule** (vd: thêm `ko` vào danh sách ngôn ngữ)
3. **Thay đổi endpoint applicability** (vd: segment giờ được hash cho search)
4. **Upgrade Varnish version** — behavior của VCL có thể thay đổi
5. **Thêm middleware** trước Varnish có thể strip hoặc modify variant headers

Chạy case này trong CI pipeline mỗi khi có thay đổi VCL hoặc header normalization.

---

## 13. Checklist trước khi chạy

### 13.1. Infrastructure checklist

| # | Mục kiểm tra | Lệnh | Expected |
|---|-------------|------|----------|
| 1 | Varnish running | `curl -I http://localhost:80/api/sim/products/homefeed` | Có `X-Cache` header |
| 2 | Control plane running | `curl http://localhost:8088/ops/app/cdn/origin/profile` | JSON response |
| 3 | OPS_AUTH_TOKEN valid | Control API trả 200 | Không 401/403 |
| 4 | Origin phân biệt variant | Gọi cùng URL với 2 bộ header khác nhau | Response body khác nhau |

### 13.2. Environment checklist

| # | Mục kiểm tra | Giá trị | Ghi chú |
|---|-------------|---------|---------|
| 1 | `BASE_URL` | `http://localhost:80` | |
| 2 | `CONTROL_BASE_URL` | `http://localhost:8088` | |
| 3 | `OPS_AUTH_TOKEN` | Token hợp lệ | |
| 4 | `VARIANT_KEYS_ITERATIONS` | (không set, dùng default 24) | Tăng nếu cần thêm sample |
| 5 | Không process k6 nào khác | `Get-Process k6` | |
| 6 | Cache rỗng trước khi chạy | Chạy ban-url thủ công | |

### 13.3. VCL checklist (trước khi debug)

| # | Mục kiểm tra | Trong file VCL |
|---|-------------|---------------|
| 1 | `vcl_recv` có normalize đủ 5 dimensions? | Tìm `X-Cache-Key-Language`, `X-Cache-Key-Geo`, `X-Cache-Key-Device`, `X-Cache-Key-AB`, `X-Cache-Key-Segment` |
| 2 | `vcl_hash` có hash tất cả dimensions? | Tìm `hash_data(req.http.X-Cache-Key-...)` |
| 3 | Segment có điều kiện path không? | Tìm `if (req.url ~ "...")` trước `hash_data(X-Cache-Key-Segment)` |
| 4 | Normalization có khớp `shared.js`? | So sánh logic VCL với `normalizeLanguage`, `normalizeGeo`, ... |

---

## 14. Variations với code

### 14.1. Variation 1: Test với tất cả giá trị của một dimension

Test mọi ngôn ngữ được hỗ trợ (vi, en, ja):

```javascript
function exerciseAllLanguages(path) {
  const profiles = [
    { name: 'vietnamese', profile: profiles.guestVNMobileControl, expectedLang: 'vi' },
    { name: 'english', profile: profiles.guestVNMobileEnglish, expectedLang: 'en' },
    // Thêm profile cho tiếng Nhật
    { name: 'japanese', profile: {
      name: 'guest_vn_mobile_japanese',
      headers: {
        'Accept-Language': 'ja',
        'X-Geo-Country': 'VN',
        'X-Device-Class': 'mobile',
        'X-Ab-Variant': 'control',
        'X-User-Segment': 'guest',
      }
    }, expectedLang: 'ja' },
  ];

  banUrl(path);

  // Warm từng language -> tất cả đều MISS lần đầu
  for (const { name, profile, expectedLang } of profiles) {
    const first = requestCdn('GET', path, { profile, tags: { case: `lang_${name}_first` } });
    assertCacheState(first, 'MISS', `${name} first`);
    assertCacheKeyHeaders(first, { language: expectedLang, geo: 'VN', device: 'mobile', ab: 'control' }, name);

    const second = requestCdn('GET', path, { profile, tags: { case: `lang_${name}_second` } });
    assertCacheState(second, 'HIT', `${name} second`);
  }

  // Verify: 3 languages -> 3 objects riêng biệt trong cache
  console.log('All 3 languages have separate cache objects ✓');
}
```

### 14.2. Variation 2: Cross-dimension combination test

Test rằng tổ hợp 2 dimensions tạo ra 4 object riêng biệt:

```javascript
function exerciseLanguageGeoMatrix(path) {
  banUrl(path);

  const combinations = [
    { label: 'vi_VN', profile: profiles.guestVNMobileControl, lang: 'vi', geo: 'VN' },
    { label: 'vi_US', profile: profiles.guestUSMobileControl, lang: 'vi', geo: 'US' },
    // en_VN
    { label: 'en_VN', profile: {
      name: 'en_vn_mobile',
      headers: { 'Accept-Language': 'en', 'X-Geo-Country': 'VN', 'X-Device-Class': 'mobile', 'X-Ab-Variant': 'control', 'X-User-Segment': 'guest' }
    }, lang: 'en', geo: 'VN' },
    // en_US
    { label: 'en_US', profile: profiles.guestUSDesktopControl, lang: 'en', geo: 'US' },
  ];

  for (const combo of combinations) {
    const first = requestCdn('GET', path, { profile: combo.profile, tags: { case: `${combo.label}_first` } });
    assertCacheState(first, 'MISS', `${combo.label} first`);
    assertCacheKeyHeaders(first, { language: combo.lang, geo: combo.geo, device: 'mobile', ab: 'control' }, combo.label);

    const second = requestCdn('GET', path, { profile: combo.profile, tags: { case: `${combo.label}_second` } });
    assertCacheState(second, 'HIT', `${combo.label} second`);
  }

  console.log('2x2 matrix: all 4 combinations have separate cache objects ✓');
}
```

### 14.3. Variation 3: Verify response body khác nhau giữa variants

```javascript
function exerciseVariantWithBodyCheck(path, label, baseProfile, variantProfile, options = {}) {
  banUrl(path);

  const baseFirst = requestCdn('GET', path, { profile: baseProfile });
  const baseBody = baseFirst.body;

  const variantFirst = requestCdn('GET', path, { profile: variantProfile });

  // Ngoài việc assert MISS/HIT, còn assert body khác nhau
  if (baseBody === variantFirst.body) {
    console.warn(`WARNING: ${label} — base and variant have IDENTICAL response bodies`);
    console.warn(`  This means origin does not differentiate by ${label}`);
    console.warn(`  Cache key test passes, but business value is not proven`);
  } else {
    console.log(`✓ ${label} — base and variant have different response bodies`);
  }

  // ... tiếp tục HIT assertions ...
}
```

### 14.4. Variation 4: Test thêm dimension "tablet"

```javascript
// Thêm profile tablet vào shared.js hoặc inline
const guestVNTabletControl = {
  name: 'guest_vn_tablet_control',
  headers: {
    'Accept-Language': 'vi',
    'X-Geo-Country': 'VN',
    'X-Device-Class': 'tablet',
    'X-Ab-Variant': 'control',
    'X-User-Segment': 'guest',
  },
};

// Trong default function:
exerciseVariant(
  paths.productDetail,
  'device_tablet',
  profiles.guestVNMobileControl,   // base: mobile
  guestVNTabletControl              // variant: tablet
);
// Verify: mobile và tablet có cache key khác nhau (device dimension)
```

### 14.5. Variation 5: Negative test — cố tình gửi header sai

```javascript
// Test rằng header không hợp lệ bị normalize về default
function exerciseNormalizationFallback(path) {
  banUrl(path);

  // Profile với header không chuẩn
  const weirdProfile = {
    name: 'weird_headers',
    headers: {
      'Accept-Language': 'xx',        // Không hỗ trợ -> expected en
      'X-Geo-Country': 'MARS',       // Không hỗ trợ -> expected VN
      'X-Device-Class': 'fridge',     // Không hỗ trợ -> expected desktop
      'X-Ab-Variant': 'experiment',  // Không hỗ trợ -> expected control
      'X-User-Segment': 'alien',     // Không hỗ trợ -> expected guest
    },
  };

  const first = requestCdn('GET', path, { profile: weirdProfile });
  assertCacheState(first, 'MISS', 'weird first');

  // Assert tất cả normalized về default
  assertCacheKeyHeaders(first, {
    language: 'en',
    geo: 'VN',
    device: 'desktop',
    ab: 'control',
    segment: 'guest',
  }, 'weird normalization', { withSegment: true });

  console.log('✓ Header normalization fallback works correctly');
}
```

---

## 15. Anti-patterns

### 15.1. Anti-pattern 1: Tăng VUs để chạy nhanh hơn

```javascript
// SAI
export const options = {
  vus: 4,  // multiple VUs
  iterations: 24,
};
```

**Vấn đề:** Với 4 VUs, 4 iteration chạy song song. Mỗi iteration gọi `exerciseVariant` 5 lần, mỗi lần có `banUrl`. Các VUs sẽ banUrl object của nhau -> sequence MISS/HIT bị phá vỡ.

**Cách đúng:** Giữ `vus: 1`. Nếu muốn nhiều sample hơn, tăng `VARIANT_KEYS_ITERATIONS`.

### 15.2. Anti-pattern 2: Gộp chung setup cho tất cả sub-proofs

```javascript
// SAI — một lần banUrl cho tất cả
export default function () {
  banUrl(paths.productDetail);  // Chỉ clear một lần

  exerciseVariantWithoutBan(paths.productDetail, 'language', ...);
  exerciseVariantWithoutBan(paths.productDetail, 'geo', ...);
  // ...
}
```

**Vấn đề:** Sau sub-proof language, cache đã có 2 object (vi và en). Khi chạy sub-proof geo, base (VN) có thể HIT object vi từ sub-proof trước -> variantFirst (US) có thể MISS nhưng không phải do geo dimension mà do US chưa có object. Kết quả vẫn "pass" nhưng proof không sạch.

**Cách đúng:** Mỗi `exerciseVariant` tự gọi `banUrl(path)` ở đầu — đảm bảo cache sạch cho từng sub-proof.

### 15.3. Anti-pattern 3: So sánh response time thay vì X-Cache headers

```javascript
// SAI
if (variantFirst.timings.duration < 10) {
  console.log('Probably HIT — cache key may be leaking');
}
```

**Vấn đề:** Response time không phải là evidence của cache state. Một MISS có thể nhanh (origin gần, response nhỏ) và một HIT có thể chậm (disk cache, swap). Chỉ `X-Cache` header là authoritative.

### 15.4. Anti-pattern 4: Không assert upstream cho variantFirst

```javascript
// SAI — chỉ assert cache state
assertCacheState(variantFirst, 'MISS', 'variant first');
// Thiếu: assertUpstream(variantFirst, 'products-service', 'variant first');
```

**Vấn đề:** Nếu variantFirst MISS nhưng upstream = `error-service` hoặc sai service, response có thể không phải từ đúng origin. Cache key có thể đúng nhưng request routing sai.

### 15.5. Anti-pattern 5: Dùng `sleep` để "đợi cache ổn định"

```javascript
// SAI
banUrl(path);
sleep(5);  // "Đợi cache ổn định"
const first = requestCdn(...);
```

**Vấn đề:**
- `banUrl` là synchronous HTTP request — khi response về 200, object đã bị xóa
- Sleep 5 giây không có tác dụng gì ngoài làm chậm test
- Nếu banUrl mất >5 giây để có hiệu lực, đó là bug của control plane, không phải thứ để workaround bằng sleep

**Cách đúng:** Assert `banUrl` response status = 200, sau đó gọi tiếp ngay không cần sleep.

### 15.6. Anti-pattern 6: Chỉ test 2 giá trị (vd: vi/en) cho một dimension có 3+ giá trị

```javascript
// SAI — chỉ test vi vs en, bỏ qua ja
exerciseVariant(path, 'language', profiles.guestVNMobileControl, profiles.guestVNMobileEnglish);
// Thiếu: test với tiếng Nhật
```

**Vấn đề:** Nếu VCL hash language nhưng normalization chỉ recognize `vi` và `en`, còn `ja` bị fallback về `en` -> user tiếng Nhật nhận nội dung tiếng Anh. Test 2 giá trị không phát hiện được bug normalization.

**Cách đúng:** Test tất cả các giá trị được hỗ trợ trong normalization (vi, en, ja).

### 15.7. Anti-pattern 7: Dùng profile với quá nhiều khác biệt

```javascript
// SAI — 3 dimension khác nhau giữa base và variant
const base = profiles.guestVNMobileControl;     // {vi, VN, mobile, control}
const variant = profiles.guestUSDesktopControl;  // {en, US, desktop, control}
exerciseVariant(path, 'multi', base, variant);
```

**Vấn đề:** Khi variantFirst MISS, bạn không biết dimension nào (language, geo, hay device) khiến cache key khác nhau. Khi variantFirst HIT (cache leak), bạn không biết dimension nào bị thiếu.

**Cách đúng:** Mỗi sub-proof chỉ thay đổi đúng 1 dimension. Tất cả các dimension khác giữ nguyên.

### 15.8. Anti-pattern 8: Bỏ qua options `{ withSegment: true }` cho segment test

```javascript
// SAI — assertCacheKeyHeaders không check segment
exerciseVariant(paths.homefeed, 'segment',
  profiles.guestVNMobileVariantA,
  profiles.returningVNMobileVariantA);
// Thiếu: { withSegment: true }
```

**Vấn đề:** Segment dimension vẫn được test (sequence MISS/HIT), nhưng `X-Cache-Key-Segment` header không được assert. Nếu sequence đúng nhưng header sai, bug không bị phát hiện.

**Cách đúng:** Luôn pass `{ withSegment: true }` khi test segment dimension.

---

## 15b. Troubleshooting guide

### 15b.1. Sơ đồ chẩn đoán nhanh

```text
Case 02 fail
  │
  ├─ Tất cả 5 sub-proofs fail?
  │   ├─ k6 không chạy được -> Kiểm tra import paths, env vars
  │   └─ banUrl fail toàn bộ -> OPS_AUTH_TOKEN sai hoặc control plane down
  │
  ├─ Một sub-proof fail, các sub-proof khác pass?
  │   │
  │   ├─ Language fail?
  │   │   ├─ variantFirst HIT -> Accept-Language không được hash
  │   │   ├─ X-Cache-Key-Language sai -> VCL normalization bug
  │   │   └─ baseSecond MISS -> TTL quá ngắn hoặc eviction
  │   │
  │   ├─ Geo fail?
  │   │   ├─ variantFirst HIT -> X-Geo-Country không được hash
  │   │   └─ X-Cache-Key-Geo sai (vd: US thành VN) -> normalization fallback
  │   │
  │   ├─ Device fail?
  │   │   ├─ variantFirst HIT -> X-Device-Class không được hash
  │   │   └─ X-Cache-Key-Device sai -> normalization sai (vd: tablet thành desktop)
  │   │
  │   ├─ AB variant fail?
  │   │   ├─ variantFirst HIT -> X-Ab-Variant không được hash
  │   │   └─ X-Cache-Key-AB sai -> variant không được recognize
  │   │
  │   └─ Segment fail?
  │       ├─ variantFirst HIT -> Homefeed không hash segment (có thể đúng spec!)
  │       ├─ X-Cache-Key-Segment không xuất hiện -> VCL không set header
  │       └─ baseSecond MISS -> Homefeed TTL đặc biệt ngắn
  │
  └─ Intermittent fail (một vài iteration fail)?
      ├─ banUrl chưa hoàn tất -> thêm small delay sau banUrl
      ├─ Network latency spike -> tăng timeout
      └─ Có process khác truy cập cùng path -> chạy isolated
```

### 15b.2. Lệnh chẩn đoán thủ công cho từng dimension

```powershell
# Kiểm tra Language dimension
curl -v http://localhost:80/api/sim/products/1 `
  -H "Accept-Language: vi" `
  -H "X-Geo-Country: VN" `
  -H "X-Device-Class: mobile" `
  -H "X-Ab-Variant: control" 2>&1 | Select-String "X-Cache"

# Gọi lại với language khác
curl -v http://localhost:80/api/sim/products/1 `
  -H "Accept-Language: en" `
  -H "X-Geo-Country: VN" `
  -H "X-Device-Class: mobile" `
  -H "X-Ab-Variant: control" 2>&1 | Select-String "X-Cache"

# Nếu lần 2 trả HIT -> leak! Language không được hash.

# Kiểm tra Geo dimension
curl -v http://localhost:80/api/sim/products/1 `
  -H "Accept-Language: vi" `
  -H "X-Geo-Country: US" `
  -H "X-Device-Class: mobile" `
  -H "X-Ab-Variant: control" 2>&1 | Select-String "X-Cache-Key-Geo"

# Kiểm tra Segment dimension (homefeed)
curl -v http://localhost:80/api/sim/products/homefeed `
  -H "Accept-Language: vi" `
  -H "X-Geo-Country: VN" `
  -H "X-Device-Class: mobile" `
  -H "X-Ab-Variant: variant-a" `
  -H "X-User-Segment: returning" 2>&1 | Select-String "X-Cache-Key-Segment"
```

### 15b.3. Bảng symptom và root cause cho variant keys

| Symptom | Root cause phổ biến | Cách fix |
|---------|--------------------|----------|
| variantFirst HIT thay vì MISS | Dimension không được hash trong `vcl_hash` | Thêm `hash_data(req.http.X-Cache-Key-XXX)` vào VCL |
| baseSecond MISS thay vì HIT | TTL quá ngắn, object expire giữa 2 request | Kiểm tra `s-maxage` từ origin, tăng TTL |
| `X-Cache-Key-Language` = `en` dù gửi `Accept-Language: vi` | VCL normalization sai | Kiểm tra regex/if-else trong `vcl_recv` |
| `X-Cache-Key-Geo` = `VN` dù gửi `X-Geo-Country: US` | Geo không nằm trong whitelist normalization | Thêm `US` vào danh sách whitelist trong VCL |
| `X-Cache-Key-Segment` không xuất hiện | VCL không set header cho path này | Kiểm tra điều kiện path trong `vcl_recv` |
| 4 dimensions pass, segment fail | Homefeed spec không hash segment -> expected behavior | Xác nhận spec: segment có được hash cho homefeed không? |

### 15b.4. Cách cô lập một dimension để debug

Nếu case 02 fail, debug từng dimension một cách cô lập:

```powershell
# Chỉ chạy 1 iteration, thêm --verbose để xem từng request
k6 run --verbose load-target/k6/cdn/02-variant-keys.js --iterations 1 2>&1 | Select-String "X-Cache|check|MISS|HIT"
```

Hoặc tạo script tạm chỉ test dimension đang fail:

```javascript
// debug-language.js — chỉ test language dimension
import { paths, profiles, banUrl, requestCdn, assertCacheState } from './shared.js';

export default function () {
  banUrl(paths.productDetail);

  const vi1 = requestCdn('GET', paths.productDetail, { profile: profiles.guestVNMobileControl });
  console.log(`vi first:  status=${vi1.status}  cache=${vi1.headers['X-Cache']}`);

  const vi2 = requestCdn('GET', paths.productDetail, { profile: profiles.guestVNMobileControl });
  console.log(`vi second: status=${vi2.status}  cache=${vi2.headers['X-Cache']}`);

  const en1 = requestCdn('GET', paths.productDetail, { profile: profiles.guestVNMobileEnglish });
  console.log(`en first:  status=${en1.status}  cache=${en1.headers['X-Cache']}`);

  // Nếu en1 = HIT -> cache leak!
}
```

### 16.1. Môi trường test

| Thuộc tính | Giá trị |
|-----------|--------|
| Thời gian chạy | 2026-06 |
| Target version | `full` stack local |
| Varnish version | (theo deployment) |
| OS | Windows 11 |
| k6 version | 0.52+ |

### 16.2. Kết quả chạy thực tế

```text
Scenario: cdn-02-variant-keys
  VUs:           1
  Iterations:    24
  Checks pass:   44,160 / 44,160 (100%)
  Exit code:     0

Per-dimension results (aggregated over 24 iterations):
┌────────────┬──────────────────────────────────────────────────────┐
│ Dimension  │ Sequence                                              │
├────────────┼──────────────────────────────────────────────────────┤
│ language   │ vi: MISS→HIT  |  en: MISS→HIT  |  Keys differ ✓      │
│ geo        │ VN: MISS→HIT  |  US: MISS→HIT  |  Keys differ ✓      │
│ device     │ mob: MISS→HIT |  dsk: MISS→HIT |  Keys differ ✓      │
│ ab_variant │ ctrl: MISS→HIT|  var-a: MISS→HIT| Keys differ ✓      │
│ segment    │ guest: MISS→HIT| ret: MISS→HIT |  Keys differ ✓      │
└────────────┴──────────────────────────────────────────────────────┘

Timing (trung bình 1 iteration):
  - 25 requests / iteration
  - ~400ms / iteration
  - 24 iterations: ~9.6 giây tổng cộng
```

### 16.3. Những điều cần lưu ý từ kết quả thực tế

1. **Mỗi iteration chạy rất nhanh** (~400ms cho 25 requests): Request qua localhost, không có network latency. Trong môi trường CI hoặc remote, thời gian có thể cao hơn.
2. **Sequence MISS/HIT luôn deterministic với VUs=1**: Không có race condition, không có request nào bị đảo thứ tự.
3. **BanUrl giữa các sub-proofs đảm bảo isolation**: Object từ sub-proof language không bao giờ "rò rỉ" sang sub-proof geo.
4. **Segment dimension với homefeed endpoint**: Xác nhận rằng segment được hash riêng cho homefeed, không bị ảnh hưởng bởi 4 sub-proofs trên productDetail.

---

## 17. Reference

### 17.1. Source files

| File | Path | Vai trò |
|------|------|---------|
| Script chính | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\02-variant-keys.js` | Test case script |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` | CDN helper library — chứa `profiles`, `expectedCacheKey`, `assertCacheKeyHeaders` |
| Common helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Env variable helpers |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json` | Case registry |
| CDN README | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md` | Source documentation |
| Layer roadmap | `E:\Projects\k6\k6-metrics-server\load-target\k6\layer-roadmap.md` | Layer-level overview |

### 17.2. Related docs

| Document | Path | Liên quan |
|----------|------|-----------|
| Series overview | `E:\Khoa hoc\k6\docs\practice\cdn\00_overview.md` | Tổng quan 11 CDN cases |
| Case 01 | `E:\Khoa hoc\k6\docs\practice\cdn\01_hit-smoke.md` | Case trước — nền tảng cache HIT |
| Case 03 | `E:\Khoa hoc\k6\docs\practice\cdn\03_bypass-rules.md` | Case tiếp theo — bypass rules |
| Run guide | `E:\Khoa hoc\k6\RUN_GUIDE.md` | Hướng dẫn chạy chung |
| Validation report | `E:\Khoa hoc\k6\docs\practice\cdn\12_validation-and-chart-analysis.md` | Tổng hợp validation |

### 17.3. Key concepts reference

| Concept | Case liên quan | Mô tả ngắn |
|---------|---------------|------------|
| Cache HIT/MISS | Case 01 | Nền tảng cache serving |
| Variant keys | Case 02 (này) | Phân biệt cache theo dimensions |
| Language key | Case 02 | `Accept-Language` -> `X-Cache-Key-Language` |
| Geo key | Case 02 | `X-Geo-Country` -> `X-Cache-Key-Geo` |
| Device key | Case 02 | `X-Device-Class` -> `X-Cache-Key-Device` |
| AB variant key | Case 02 | `X-Ab-Variant` -> `X-Cache-Key-AB` |
| Segment key | Case 02 | `X-User-Segment` -> `X-Cache-Key-Segment` |
| Cache normalization | Case 02 + Case 04 | Chuẩn hóa giá trị header trước khi hash |
| Bypass rules | Case 03 | Auth/Cookie/no-cache bypass |
| Query normalization | Case 04 | Tracking params vs business params |

### 17.4. Dimensions và endpoint matrix

| Dimension | Header gốc | Cache key header | Product Detail | Homefeed | Search | Recommendations |
|-----------|-----------|-----------------|---------------|----------|--------|----------------|
| Language | `Accept-Language` | `X-Cache-Key-Language` | YES | YES | YES | YES |
| Geo | `X-Geo-Country` | `X-Cache-Key-Geo` | YES | YES | YES | YES |
| Device | `X-Device-Class` | `X-Cache-Key-Device` | YES | YES | YES | YES |
| AB | `X-Ab-Variant` | `X-Cache-Key-AB` | YES | YES | YES | YES |
| Segment | `X-User-Segment` | `X-Cache-Key-Segment` | NO | YES | NO | YES |
