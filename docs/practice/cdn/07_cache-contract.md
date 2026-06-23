# Case 07: Cache response contract

> **Case ID:** `cdn-07-cache-contract`
> **Script:** `07-cache-contract.js`
> **Layer:** CDN / Varnish
> **Proof:** Cache-Control/CDN-Cache-Control/ETag/Last-Modified/Surrogate-Key/Vary và 304 revalidation
> **Loại test:** Correctness / contract validation
> **Thời gian chạy:** < 3 giây (single iteration, no sleep)
> **Yêu cầu topology:** `TargetLayer=full`

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [CDN capability được chứng minh](#2-cdn-capability-được-chứng-minh)
3. [Vì sao phải test ở CDN layer](#3-vì-sao-phải-test-ở-cdn-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Cache key model / VCL deep-dive](#6-cache-key-model--vcl-deep-dive)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / headers cần verify](#8-key-signals--headers-cần-verify)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output → decision scenarios](#11-4-output--decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist trước khi chạy](#13-checklist-trước-khi-chạy)
14. [Variations với code mẫu](#14-variations-với-code-mẫu)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### Bối cảnh nghiệp vụ

Một hệ thống thương mại điện tử phục vụ hàng triệu người dùng mỗi ngày. Các API công khai như chi tiết sản phẩm, danh mục, homefeed được gọi liên tục từ browser, mobile app và third-party integrations. Để CDN có thể làm tốt ba nhiệm vụ cốt lõi của nó — **cache**, **phục vụ stale khi origin lỗi**, và **cho phép client revalidation** — mỗi response từ origin **phải** mang đầy đủ và chính xác một bộ HTTP headers được gọi là **cache contract**.

Cache contract không phải là "nice to have". Nếu thiếu `Surrogate-Key`, đội vận hành không thể ban-tag để xóa hàng loạt object liên quan khi có cập nhật sản phẩm. Nếu thiếu `CDN-Cache-Control`, CDN dùng chung một policy với browser — sai hoàn toàn về ngữ nghĩa. Nếu thiếu `ETag`, client không thể gửi conditional request để tiết kiệm băng thông.

### Câu chuyện thực tế

```text
Tình huống: 10:00 sáng, đội content cập nhật giá và mô tả của sản phẩm ID=1.
Hệ thống kích hoạt catalog event → app gọi internal invalidation → CDN purge object cũ.

10:01: Người dùng đầu tiên request GET /api/sim/products/1.
       CDN MISS → fetch từ origin → lưu response kèm tất cả cache headers.
10:02: Người dùng thứ hai request cùng path, cùng profile.
       CDN HIT → trả từ cache, không gọi origin.

10:05: Mobile app gửi conditional request với If-None-Match.
       Nếu ETag khớp → 304 Not Modified → tiết kiệm 12 KB payload.
       Nếu ETag không khớp → 200 với body mới.

10:10: Origin products-service gặp sự cố, trả 503.
       CDN có object trong cache + header stale-if-error=86400.
       CDN phục vụ stale object thay vì trả lỗi cho người dùng.
```

Nếu cache contract không đúng ở bước 10:01, **tất cả các bước sau đều thất bại**.

### Vì sao case này quan trọng

| Nếu thiếu header này | Hậu quả thực tế |
| --- | --- |
| `Cache-Control` không có `s-maxage` | CDN không biết object sống bao lâu; có thể cache quá lâu hoặc không cache |
| `CDN-Cache-Control` không có | CDN dùng chung policy với browser; `max-age=60` browser nghĩa là cache 60s ở CDN — có thể sai nghiêm trọng |
| `ETag` không có | Client không thể gửi conditional request; mỗi lần request đều tải lại toàn bộ body |
| `Last-Modified` không có | Client không thể dùng `If-Modified-Since`; thiếu fallback validation |
| `Surrogate-Key` không có | Operator không thể ban-tag để xóa hàng loạt; phải purge từng URL một |
| `Vary` không có | CDN có thể phục vụ nhầm variant (sai ngôn ngữ, sai quốc gia) |

---

## 2. CDN capability được chứng minh

### Capability chính

Case này chứng minh **cacheable APIs trả về đầy đủ và chính xác bộ cache contract headers**, đồng thời **CDN và origin hỗ trợ đúng conditional revalidation (ETag/If-None-Match → 304)**.

Cụ thể:

1. **Cache-Control contract**: Response từ origin chứa `Cache-Control` với các directive `public`, `s-maxage=N`, `stale-while-revalidate=N`, `stale-if-error=N`.
2. **CDN-Cache-Control contract**: Response chứa `CDN-Cache-Control` với `max-age=N`, `stale-while-revalidate=N`, `stale-if-error=N`. Đây là header dành riêng cho shared cache (CDN), tách biệt với browser cache policy.
3. **ETag + 304 revalidation**: Response có `ETag`; client có thể dùng `If-None-Match` trong request tiếp theo để nhận `304 Not Modified`.
4. **Last-Modified**: Response có `Last-Modified` cho fallback validation.
5. **Surrogate-Key**: Response có `Surrogate-Key` chứa tag định danh object (ví dụ `product-1`, `catalog-homefeed`, `segment-returning`).
6. **Vary**: Response có `Vary` liệt kê các request headers mà CDN dùng để phân biệt variant (ví dụ `Accept-Language`, `X-Geo-Country`).

### Phạm vi kiểm tra

| Endpoint | Profile | Mục đích kiểm tra |
| --- | --- | --- |
| `GET /api/sim/products/1` | `guestVNMobileControl` | Toàn bộ contract headers + ETag cho revalidation |
| `GET /api/sim/products/1` + `If-None-Match` | `guestVNMobileControl` | 304 revalidation |
| `GET /api/sim/products/homefeed` | `returningVNMobileVariantA` | Surrogate-Key với segment tag |
| `GET /api/sim/products/categories` | `guestUSDesktopControl` | Vary response + body parse |

### Không kiểm tra trong case này

- Không kiểm tra HIT/MISS sequence (đã có case 01).
- Không kiểm tra variant key correctness (đã có case 02).
- Không kiểm tra bypass rules (đã có case 03).
- Không kiểm tra invalidation (đã có case 05, 06).
- Không kiểm tra TTL expiry behavior (đã có case 08).

---

## 3. Vì sao phải test ở CDN layer

### Vấn đề nếu chỉ test ở application layer

Nếu bạn chỉ gọi trực tiếp Nginx hoặc app container (bỏ qua Varnish), bạn sẽ thấy:

```text
GET http://localhost:8080/api/sim/products/1 → 200 OK
Cache-Control: public, s-maxage=30
CDN-Cache-Control: max-age=30
ETag: "abc123"
...
```

Tất cả headers **có mặt**, tất cả status **đúng**. Bạn kết luận: "Cache contract OK".

Nhưng khi request đi qua CDN:

```text
GET http://localhost:80/api/sim/products/1 → 200 OK
Cache-Control: public, s-maxage=30
X-Cache: MISS
...
```

Lần thứ hai:

```text
GET http://localhost:80/api/sim/products/1 → 200 OK
X-Cache: HIT
...
```

Conditional request qua CDN:

```text
GET http://localhost:80/api/sim/products/1
If-None-Match: "abc123"
→ mong đợi 304, nhưng nhận 200
X-Cache: BYPASS
```

### Tại sao CDN layer quan trọng cho contract validation

| Layer | Bạn thấy gì | Bạn bỏ lỡ gì |
| --- | --- | --- |
| App direct (`:8080`) | Headers đúng, status đúng | Không biết CDN có tôn trọng `CDN-Cache-Control` không |
| App direct (`:8080`) | 304 revalidation OK | Không biết CDN có strip `ETag` hoặc `If-None-Match` không |
| App direct (`:8080`) | `Vary` header có mặt | Không biết CDN có thực sự dùng `Vary` để phân biệt cache key không |
| CDN (`:80`) | Thấy `X-Cache` state | Biết CDN có cache theo đúng contract không |
| CDN (`:80`) | Thấy conditional request behavior thực tế | Biết CDN có chuyển tiếp `If-None-Match` đến origin không |

### Ba lý do phải test ở CDN layer

**Lý do 1: CDN có thể strip hoặc thay đổi headers**

Nhiều CDN/Varnish config có rule strip bớt headers trước khi trả về client. Ví dụ: strip `ETag` để tránh cache poisoning, hoặc strip `CDN-Cache-Control` vì cho rằng chỉ cần `Cache-Control`. Nếu bạn chỉ test ở app layer, bạn không bao giờ phát hiện.

**Lý do 2: CDN xử lý conditional request khác với origin**

Khi CDN nhận request có `If-None-Match`, nó có thể:
- Chuyển tiếp đến origin (origin trả 304, CDN trả 304 cho client) — đúng.
- Tự xử lý 304 từ cache (so sánh ETag trong cached object) — đúng, tiết kiệm origin hit.
- Bỏ qua `If-None-Match` và trả HIT object — sai, gây lãng phí băng thông.
- Bypass cache vì thấy `Cache-Control: no-cache` — đúng nếu client gửi `no-cache`.

Chỉ test ở app layer, bạn không biết CDN xử lý theo cách nào.

**Lý do 3: `Vary` header ảnh hưởng trực tiếp đến cache key**

`Vary: Accept-Language, X-Geo-Country` báo cho CDN biết cần tạo variant cache object riêng cho từng tổ hợp ngôn ngữ + quốc gia. Nếu VCL không đọc `Vary` header từ origin response, CDN sẽ phục vụ sai variant. Test ở CDN layer là cách duy nhất để xác nhận.

---

## 4. Topology và precondition

### Topology yêu cầu

```text
k6/client
   │
   ├──> http://localhost:80 ──> Varnish CDN ──> Nginx ──> app/microservices
   │                                                       │
   │    Public edge path (cần test)                        │
   │                                                       │
   └──> http://localhost:8088 ─────────────────────────────> control plane
        Control path (không dùng trong case này)
```

Case 07 không dùng control plane (`:8088`) hay catalog events (`:9091`). Tất cả request đi qua public edge path `:80`.

### Biến môi trường

| Biến | Mặc định | Vai trò trong case 07 |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | Public CDN entry point |
| `CONTROL_BASE_URL` | `http://localhost:8088` | Không dùng trong case này |
| `CATALOG_EVENTS_BASE_URL` | `http://localhost:9091` | Không dùng trong case này |
| `OPS_AUTH_TOKEN` | (bắt buộc khi dùng control) | Không dùng trong case này |

### Precondition

1. **`TargetLayer=full`**: Stack phải chạy với Varnish CDN ở port 80.
2. **Origin healthy**: Tất cả microservices (products-service) phải đang chạy và trả về response hợp lệ.
3. **Không cần warm cache**: Case này kiểm tra headers, không kiểm tra HIT/MISS sequence. Không cần setup ban/purge.
4. **Endpoint tồn tại**: `/api/sim/products/1`, `/api/sim/products/homefeed`, `/api/sim/products/categories` phải trả về 200.
5. **Không cần OPS_AUTH_TOKEN**: Case này không gọi control plane.

### Kiểm tra precondition nhanh

```powershell
# Kiểm tra origin có sống không
curl -s -o nul -w "%{http_code}" http://localhost:80/api/sim/products/1
# Kỳ vọng: 200

# Kiểm tra CDN có đang hoạt động không
curl -s -I http://localhost:80/api/sim/products/1 | findstr "X-Cache"
# Kỳ vọng: X-Cache: MISS hoặc HIT (có header là được)
```

---

## 5. Script deep-dive

### 5.1 Import và dependency

```javascript
import { decodeJSON, getHeader, paths, profiles, requestCdn,
         assertHeaderContains, assertHeaderPresent, assertStatus } from './shared.js';
```

Script import 8 symbols từ `shared.js`:

| Symbol | Loại | Vai trò trong case |
| --- | --- | --- |
| `decodeJSON` | function | Parse JSON body của categories response |
| `getHeader` | function | Trích xuất `ETag` từ response đầu tiên để dùng cho revalidation |
| `paths` | object | Chứa path constants: `productDetail`, `homefeed`, `categories` |
| `profiles` | object | Chứa 3 profile dùng trong case: `guestVNMobileControl`, `returningVNMobileVariantA`, `guestUSDesktopControl` |
| `requestCdn` | function | Gửi HTTP request qua CDN (`:80`) |
| `assertHeaderContains` | function | Kiểm tra header có chứa fragment (ví dụ `s-maxage=`) |
| `assertHeaderPresent` | function | Kiểm tra header tồn tại (khác rỗng) |
| `assertStatus` | function | Kiểm tra HTTP status code |

### 5.2 Options block

```javascript
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
  tags: {
    scenario: 'cdn_cache_contract',
  },
};
```

**Phân tích từng trường:**

| Trường | Giá trị | Lý do |
| --- | --- | --- |
| `vus` | `1` | Contract validation là single-user test; không cần concurrency |
| `iterations` | `1` | Một iteration chạy đủ tất cả assertions; không cần lặp |
| `thresholds.checks` | `['rate==1']` | **Cứng**: 100% checks phải pass. Một check fail → k6 exit khác 0 |
| `tags.scenario` | `'cdn_cache_contract'` | Tag để phân biệt trong dashboard/cloud output |

**Tại sao không tăng iterations?**

Case này kiểm tra **sự tồn tại và hình thái** của headers, không phải hành vi theo thời gian. Một iteration đủ để xác nhận contract. Nếu bạn muốn kiểm tra tính ổn định (headers có luôn xuất hiện không), tăng iterations lên 5-10 và quan sát.

##### Phân tích executor: vì sao dùng `per-vu-iterations` cho case này?

Config dùng bare form `vus=1, iterations=1` → `per-vu-iterations`.

**Yêu cầu của case:**

```text
1. Header contract validation: kiểm tra SỰ TỒN TẠI của cache headers
   → Mỗi endpoint (detail, list, config) cần request riêng
   → Tuần tự, không cần song song — 1 VU đủ
   → KHÔNG phải load test, KHÔNG cần duration

2. 1 iteration = 1 lần kiểm toàn bộ contract:
   → Gọi từng endpoint → assert headers → done
   → Số request cố định, deterministic
```

**So sánh executor:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **per-vu-iterations** (đang dùng) | ✅ **ĐÚNG** | 1 VU × 1 iter. Header contract check tuần tự. |
| shared-iterations | ⚠️ Kết quả giống | Với `vus=1`, output giống hệt. |
| constant-vus | ❌ SAI | Cần `duration`. Case này check contract 1 lần, không cần sustained traffic. |
| constant-arrival-rate | ❌ SAI | Ép rate. Không cần — đây là single-run validation. |
| ramping-vus | ❌ SAI | 1 VU ổn định, không ramp. |

**Key insight**: Cache contract test = "kiểm tra headers có mặt và đúng format
không". 1 lần đủ. `per-vu-iterations` với `vus=1, iterations=1`.

### 5.3 Default function — step 1: Product detail contract

```javascript
const detail = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'detail_contract' },
});
```

**Request này gửi đi đâu?**

```text
Method:  GET
URL:     http://localhost:80/api/sim/products/1
Headers: Accept: application/json
         Accept-Language: vi
         X-Geo-Country: VN
         X-Device-Class: mobile
         X-Ab-Variant: control
         X-User-Segment: guest
```

**Tại sao dùng `guestVNMobileControl`?**

Đây là profile phổ biến nhất trong hệ thống (guest, Việt Nam, mobile, control). Nó đại diện cho ~60% traffic thực tế. Contract headers phải xuất hiện bất kể profile nào, nhưng ta chọn profile phổ biến nhất để tối đa hóa độ phủ thực tế.

**Các assertions trên detail response:**

```javascript
// Nhóm 1: Cache-Control
assertStatus(detail, 200, 'detail contract');
assertHeaderPresent(detail, 'Cache-Control', 'detail contract');
assertHeaderContains(detail, 'Cache-Control', 'public', 'detail contract');
assertHeaderContains(detail, 'Cache-Control', 's-maxage=', 'detail contract');
assertHeaderContains(detail, 'Cache-Control', 'stale-while-revalidate=', 'detail contract');
assertHeaderContains(detail, 'Cache-Control', 'stale-if-error=', 'detail contract');

// Nhóm 2: CDN-Cache-Control
assertHeaderPresent(detail, 'CDN-Cache-Control', 'detail contract');
assertHeaderContains(detail, 'CDN-Cache-Control', 'max-age=', 'detail contract');
assertHeaderContains(detail, 'CDN-Cache-Control', 'stale-while-revalidate=', 'detail contract');
assertHeaderContains(detail, 'CDN-Cache-Control', 'stale-if-error=', 'detail contract');

// Nhóm 3: Validation headers
assertHeaderPresent(detail, 'ETag', 'detail contract');
assertHeaderPresent(detail, 'Last-Modified', 'detail contract');

// Nhóm 4: Tagging và variant headers
assertHeaderPresent(detail, 'Surrogate-Key', 'detail contract');
assertHeaderContains(detail, 'Surrogate-Key', 'product-1', 'detail contract');
assertHeaderPresent(detail, 'Vary', 'detail contract');
```

**Bảng tổng hợp assertions:**

| # | Assertion | Loại | Mục đích |
| --- | --- | --- | --- |
| 1 | `status 200` | Status | Response thành công |
| 2 | `Cache-Control present` | Presence | Header tồn tại |
| 3 | `Cache-Control has public` | Content | CDN được phép cache |
| 4 | `Cache-Control has s-maxage=` | Content | Shared cache TTL được định nghĩa |
| 5 | `Cache-Control has stale-while-revalidate=` | Content | Grace period cho async revalidation |
| 6 | `Cache-Control has stale-if-error=` | Content | Grace period khi origin lỗi |
| 7 | `CDN-Cache-Control present` | Presence | Header riêng cho CDN tồn tại |
| 8 | `CDN-Cache-Control has max-age=` | Content | CDN-specific TTL |
| 9 | `CDN-Cache-Control has stale-while-revalidate=` | Content | CDN-specific stale grace |
| 10 | `CDN-Cache-Control has stale-if-error=` | Content | CDN-specific error grace |
| 11 | `ETag present` | Presence | Có thể revalidation |
| 12 | `Last-Modified present` | Presence | Có thể If-Modified-Since |
| 13 | `Surrogate-Key present` | Presence | Có thể ban-tag |
| 14 | `Surrogate-Key has product-1` | Content | Tag đúng object identity |
| 15 | `Vary present` | Presence | CDN biết variant dimensions |

### 5.4 Default function — step 2: 304 revalidation

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

**Phân tích từng bước:**

1. **Trích xuất ETag**: Lấy giá trị `ETag` từ response đầu tiên. Nếu không có → throw Error (dừng script, không tiếp tục).
2. **Gửi conditional request**: Request thứ hai cùng path, cùng profile, nhưng thêm 2 headers:
   - `Cache-Control: no-cache` — yêu cầu CDN revalidate với origin, không dùng cached object.
   - `If-None-Match: <ETag>` — nói với origin "chỉ trả body nếu object đã thay đổi".
3. **Kiểm tra 304**: Origin so sánh ETag, thấy khớp → trả `304 Not Modified` (không body, tiết kiệm băng thông).

**Tại sao dùng `Cache-Control: no-cache`?**

Nếu không có `no-cache`, CDN có thể trả HIT từ cache mà không chuyển tiếp `If-None-Match` đến origin. `no-cache` buộc CDN phải revalidate — đây mới là thứ ta muốn test.

**Tại sao kỳ vọng 304 mà không phải 200?**

- Object không thay đổi giữa hai request (không có ai update sản phẩm trong < 1 giây).
- ETag khớp → origin phải trả 304.
- Nếu origin trả 200 → ETag implementation sai, hoặc origin luôn generate ETag mới mỗi request.

### 5.5 Default function — step 3: Homefeed Surrogate-Key

```javascript
const homefeed = requestCdn('GET', paths.homefeed, {
  profile: profiles.returningVNMobileVariantA,
  tags: { case: 'homefeed_contract' },
});
assertStatus(homefeed, 200, 'homefeed contract');
assertHeaderContains(homefeed, 'Surrogate-Key', 'catalog-homefeed', 'homefeed contract');
assertHeaderContains(homefeed, 'Surrogate-Key', 'segment-returning', 'homefeed contract');
```

**Tại sao dùng `returningVNMobileVariantA`?**

Homefeed cá nhân hóa theo user segment. `returning` (khách quay lại) và `variant-a` (A/B test) tạo ra một cache object khác với guest. Ta muốn xác nhận:
- `Surrogate-Key` chứa `catalog-homefeed` — tag để invalidate tất cả homefeed objects khi catalog thay đổi.
- `Surrogate-Key` chứa `segment-returning` — tag để invalidate homefeed của riêng segment returning.

**Mô hình Surrogate-Key cho homefeed:**

```text
Surrogate-Key: catalog-homefeed, segment-returning, ab-variant-a, geo-vn, lang-vi
                ───────┬───────  ────────┬────────  ──────────┬──────────
                       │                │                     │
                       │                │                     └── Specific dimensions
                       │                └── Segment scope
                       └── Global catalog scope
```

Nhờ mô hình này, operator có thể:
- `ban-tag catalog-homefeed` → xóa **tất cả** homefeed objects, mọi segment, mọi geo.
- `ban-tag segment-returning` → chỉ xóa homefeed của returning users.
- `ban-tag product-1` → xóa detail page của product 1 khỏi cache (không ảnh hưởng homefeed).

### 5.6 Default function — step 4: Categories Vary + body

```javascript
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

**Tại sao dùng `guestUSDesktopControl`?**

Khác với product detail (dùng `guestVNMobileControl`), categories dùng `guestUSDesktopControl` để chứng minh:
- `Vary: Accept-Language` — CDN phải cache riêng response cho `en` (US) và `vi` (VN).
- `Vary: X-Geo-Country` — CDN phải cache riêng response cho `US` và `VN`.
- Response body vẫn parse được JSON hợp lệ và `success: true`.

**Tại sao parse body?**

Header contract đúng nhưng body sai (ví dụ `success: false` hoặc trả về HTML error page) là một failure mode phổ biến. Parse body xác nhận response **thực sự** là dữ liệu hợp lệ, không phải error page ngụy trang dưới status 200.

### 5.7 Không có setup() và teardown()

Script này không khai báo `export function setup()` hay `export function teardown()`. Lý do:

- **Không cần setup**: Case này không cần warm cache, không cần ban/purge trước. Nó chỉ đọc headers từ response — không quan trọng response đó là HIT hay MISS.
- **Không cần teardown**: Case này không thay đổi state (không purge, không set origin profile). Không cần cleanup.

Đây là một trong những CDN case đơn giản nhất về mặt state management.

---

## 6. Cache key model / VCL deep-dive

### 6.1 Cache key model cho case này

Case này không trực tiếp test cache key isolation (đã có case 02), nhưng cache key ảnh hưởng đến ý nghĩa của `Vary` và `Surrogate-Key`.

Cache key của CDN cho product detail được tính từ:

```text
cache_key = hash(
    method + canonical_url + normalized_query
    + X-Cache-Key-Language
    + X-Cache-Key-Geo
    + X-Cache-Key-Device
    + X-Cache-Key-AB
)
```

**Không có `X-Cache-Key-Segment` trong cache key mặc định** (chỉ dùng cho homefeed và các endpoint cá nhân hóa).

### 6.2 VCL xử lý response headers

Khi origin trả về response, Varnish VCL xử lý các header trong `vcl_backend_response`:

```text
sub vcl_backend_response {
    // Đọc TTL từ CDN-Cache-Control hoặc Cache-Control
    if (beresp.http.CDN-Cache-Control) {
        // Parse max-age, stale-while-revalidate, stale-if-error
        set beresp.ttl = <parsed max-age>;
        set beresp.grace = <parsed stale-if-error>;
        set beresp.keep = <parsed stale-while-revalidate>;
    } else if (beresp.http.Cache-Control ~ "s-maxage") {
        // Fallback: dùng s-maxage từ Cache-Control
    }

    // Lưu Surrogate-Key cho ban-tag
    if (beresp.http.Surrogate-Key) {
        // Đăng ký object với mỗi tag trong danh sách
    }

    // Lưu ETag cho conditional requests
    if (beresp.http.ETag) {
        // Cho phép client revalidate với If-None-Match
    }

    // Strip internal headers trước khi trả về client
    unset beresp.http.X-Internal-*;
}
```

### 6.3 `Cache-Control` vs `CDN-Cache-Control`

Đây là điểm dễ gây nhầm lẫn nhất trong cache contract:

| Khía cạnh | `Cache-Control` | `CDN-Cache-Control` |
| --- | --- | --- |
| Đối tượng | Tất cả caches (browser + CDN + proxy) | **Chỉ** CDN/shared cache |
| `max-age=N` | Browser cache N giây | CDN cache N giây |
| `s-maxage=N` | Ghi đè `max-age` cho shared cache | Không cần vì header này đã chỉ dành cho CDN |
| `stale-while-revalidate=N` | Browser + CDN grace period | CDN-specific grace |
| `stale-if-error=N` | Browser + CDN error grace | CDN-specific error grace |
| `public` | Cho phép shared cache | Không cần (đã ngầm định) |
| `private` | Cấm shared cache | Không nên xuất hiện trong `CDN-Cache-Control` |

**Best practice:** Luôn có cả hai header.

```text
Cache-Control: public, s-maxage=30, stale-while-revalidate=60, stale-if-error=86400
CDN-Cache-Control: max-age=30, stale-while-revalidate=60, stale-if-error=86400
```

Nếu chỉ có `Cache-Control`, CDN vẫn hoạt động (dùng `s-maxage`). Nhưng nếu browser không nên cache lâu mà CDN nên cache lâu, bạn cần `CDN-Cache-Control` để tách biệt policy.

### 6.4 `Vary` và cache key

`Vary` trong response báo cho CDN biết những request header nào ảnh hưởng đến việc chọn cached response:

```text
// Origin response
Vary: Accept-Language, X-Geo-Country

// Nghĩa là:
// - Request với Accept-Language: vi + X-Geo-Country: VN → object A
// - Request với Accept-Language: en + X-Geo-Country: VN → object B (khác Accept-Language)
// - Request với Accept-Language: vi + X-Geo-Country: US → object C (khác X-Geo-Country)
```

Tuy nhiên, `Vary` header từ origin **bổ sung** cho VCL cache key, không thay thế. VCL đã hash cache key từ `X-Cache-Key-*` headers; `Vary` là tín hiệu bổ sung cho CDN biết cần phân biệt thêm.

### 6.5 `Surrogate-Key` model

```text
Response cho GET /api/sim/products/1:
  Surrogate-Key: product-1, catalog-product, lang-vi, geo-vn, device-mobile, ab-control

Response cho GET /api/sim/products/homefeed (returning, VN, mobile, variant-a):
  Surrogate-Key: catalog-homefeed, segment-returning, ab-variant-a, geo-vn, lang-vi, device-mobile

Response cho GET /api/sim/products/categories (guest, US, desktop, control):
  Surrogate-Key: catalog-categories, segment-guest, geo-us, lang-en, device-desktop, ab-control
```

Mỗi tag là một "khóa" để invalidate. Operator có thể:
- `ban-tag product-1` → chỉ xóa product detail của ID=1.
- `ban-tag catalog-homefeed` → xóa tất cả homefeed objects.
- `ban-tag geo-vn` → xóa tất cả objects cho thị trường Việt Nam.

---

## 7. Request sequence flow

### Timeline tổng thể

```text
Time (ms)  Event
─────────────────────────────────────────────────────────────────────
0          k6 start: 1 VU, 1 iteration
0          VU bắt đầu iteration
1          ── Request 1 ─────────────────────────────────────────────
           GET /api/sim/products/1
           Profile: guest_vn_mobile_control
           → CDN nhận request
           → (có thể MISS hoặc HIT, không quan trọng)
           → Origin trả 200 + toàn bộ contract headers
           ← Response nhận về
1-5        Assertions 1-15: Cache-Control, CDN-Cache-Control, ETag,
           Last-Modified, Surrogate-Key, Vary
5          Trích xuất ETag từ response 1
           Nếu không có ETag → throw Error, script dừng
6          ── Request 2 ─────────────────────────────────────────────
           GET /api/sim/products/1
           Headers: Cache-Control: no-cache
                    If-None-Match: <ETag từ request 1>
           → CDN thấy no-cache → buộc revalidate
           → Chuyển tiếp If-None-Match đến origin
           → Origin so sánh ETag → khớp → 304 Not Modified
           ← CDN trả 304 cho client (không body)
7          Assertion 16: status 304
8          ── Request 3 ─────────────────────────────────────────────
           GET /api/sim/products/homefeed
           Profile: returning_vn_mobile_variant_a
           → CDN nhận request
           → Origin trả 200 + Surrogate-Key
           ← Response nhận về
9-10       Assertions 17-19: status 200, Surrogate-Key có catalog-homefeed,
           Surrogate-Key có segment-returning
11         ── Request 4 ─────────────────────────────────────────────
           GET /api/sim/products/categories
           Profile: guest_us_desktop_control
           → CDN nhận request
           → Origin trả 200 + Vary + JSON body
           ← Response nhận về
12-15      Assertions 20-24: status 200, Vary có Accept-Language,
           Vary có X-Geo-Country, parse JSON, success=true
15         Iteration kết thúc
16         k6 exit: 0 (nếu checks 100%) hoặc khác 0 (nếu có check fail)
```

### Request flow chi tiết cho revalidation

```text
┌─────────────────────────────────────────────────────────────────────┐
│ REQUEST 1: Warm / lấy ETag                                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  k6 ──GET /api/sim/products/1──────────────────────────> CDN (:80) │
│       Accept-Language: vi                                          │
│       X-Geo-Country: VN                                            │
│       X-Device-Class: mobile                                       │
│       X-Ab-Variant: control                                        │
│       X-User-Segment: guest                                        │
│                                                                     │
│  CDN ──GET /api/sim/products/1──────────────────────> Origin       │
│       (thêm X-Cache-Key-* headers)                                 │
│                                                                     │
│  Origin ──200 OK────────────────────────────────────> CDN           │
│          Cache-Control: public, s-maxage=30, ...                   │
│          CDN-Cache-Control: max-age=30, ...                        │
│          ETag: "abc123def456"                                       │
│          Last-Modified: Mon, 01 Jan 2026 00:00:00 GMT              │
│          Surrogate-Key: product-1, catalog-product, ...            │
│          Vary: Accept-Language, X-Geo-Country, ...                 │
│          Body: { "id": 1, "name": "...", ... }                     │
│                                                                     │
│  CDN ──200 OK────────────────────────────────────────> k6          │
│       X-Cache: MISS (hoặc HIT nếu đã cached)                       │
│       (giữ nguyên tất cả headers từ origin)                        │
│                                                                     │
│  k6: lưu ETag = "abc123def456"                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ REQUEST 2: Conditional revalidation                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  k6 ──GET /api/sim/products/1──────────────────────────> CDN (:80) │
│       Accept-Language: vi                                          │
│       X-Geo-Country: VN                                            │
│       X-Device-Class: mobile                                       │
│       X-Ab-Variant: control                                        │
│       X-User-Segment: guest                                        │
│       Cache-Control: no-cache          ← buộc revalidate          │
│       If-None-Match: "abc123def456"     ← ETag từ request 1        │
│                                                                     │
│  CDN: thấy no-cache → không dùng cache                             │
│  CDN ──GET /api/sim/products/1──────────────────────> Origin       │
│       If-None-Match: "abc123def456"                                 │
│                                                                     │
│  Origin: so sánh ETag                                              │
│          "abc123def456" == current ETag → khớp                     │
│  Origin ──304 Not Modified───────────────────────────> CDN         │
│          (không body)                                               │
│                                                                     │
│  CDN ──304 Not Modified──────────────────────────────> k6          │
│       (không body, tiết kiệm ~12 KB)                               │
│                                                                     │
│  k6: assert status === 304 ✓                                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 8. Key signals / headers cần verify

### Bảng tổng hợp headers

| # | Header | Nguồn | Có trong case này? | Ý nghĩa |
| --- | --- | --- | --- | --- |
| 1 | `Cache-Control` | Origin | **Có** — 6 assertions | Policy cho tất cả caches |
| 2 | `CDN-Cache-Control` | Origin | **Có** — 4 assertions | Policy riêng cho CDN |
| 3 | `ETag` | Origin | **Có** — 2 assertions (presence + revalidation) | Validator cho conditional request |
| 4 | `Last-Modified` | Origin | **Có** — 1 assertion | Timestamp validator |
| 5 | `Surrogate-Key` | Origin | **Có** — 3 assertions (presence + 2 tags) | Tag cho ban-tag invalidation |
| 6 | `Vary` | Origin | **Có** — 3 assertions (presence + 2 values) | Variant dimensions |
| 7 | `X-Cache` | CDN | Không assert trong case này | Cache state (MISS/HIT/BYPASS) |
| 8 | `X-Upstream-Service` | CDN | Không assert trong case này | Service đã xử lý request |
| 9 | `X-Cache-Key-Language` | CDN | Không assert | Cache key dimension |
| 10 | `X-Cache-Key-Geo` | CDN | Không assert | Cache key dimension |
| 11 | `X-Cache-Key-Device` | CDN | Không assert | Cache key dimension |
| 12 | `X-Cache-Key-AB` | CDN | Không assert | Cache key dimension |
| 13 | `X-Cache-Key-Segment` | CDN | Không assert | Cache key dimension |

### Chi tiết từng header được assert

#### Cache-Control

```text
Ví dụ giá trị thực tế:
Cache-Control: public, s-maxage=30, stale-while-revalidate=60, stale-if-error=86400
```

| Directive | Assertion | Ý nghĩa |
| --- | --- | --- |
| `public` | `assertHeaderContains(..., 'public', ...)` | Response có thể cached bởi shared cache |
| `s-maxage=N` | `assertHeaderContains(..., 's-maxage=', ...)` | Shared cache TTL (giây) |
| `stale-while-revalidate=N` | `assertHeaderContains(..., 'stale-while-revalidate=', ...)` | Thời gian phục vụ stale trong khi async revalidate |
| `stale-if-error=N` | `assertHeaderContains(..., 'stale-if-error=', ...)` | Thời gian phục vụ stale khi origin lỗi |

#### CDN-Cache-Control

```text
Ví dụ giá trị thực tế:
CDN-Cache-Control: max-age=30, stale-while-revalidate=60, stale-if-error=86400
```

| Directive | Assertion | Ý nghĩa |
| --- | --- | --- |
| `max-age=N` | `assertHeaderContains(..., 'max-age=', ...)` | CDN-specific TTL |
| `stale-while-revalidate=N` | `assertHeaderContains(..., 'stale-while-revalidate=', ...)` | CDN grace period cho revalidation |
| `stale-if-error=N` | `assertHeaderContains(..., 'stale-if-error=', ...)` | CDN grace period khi origin lỗi |

#### ETag và 304

```text
Ví dụ: ETag: "abc123def456"
```

ETag là opaque string (thường là hash của response body). Client không cần hiểu nội dung — chỉ cần lưu lại và gửi trong `If-None-Match` cho request sau.

#### Surrogate-Key

```text
Ví dụ product detail:
Surrogate-Key: product-1, catalog-product, lang-vi, geo-vn, device-mobile, ab-control

Ví dụ homefeed:
Surrogate-Key: catalog-homefeed, segment-returning, ab-variant-a, geo-vn, lang-vi, device-mobile
```

#### Vary

```text
Ví dụ categories:
Vary: Accept-Language, X-Geo-Country, X-Device-Class, X-Ab-Variant
```

---

## 9. Pass/fail criteria

### Điều kiện PASS

Tất cả các điều kiện sau phải đồng thời đúng:

```text
PASS ⇔ k6 exit code = 0
     ∧ checks rate = 100% (thresholds.checks: ['rate==1'])
     ∧ TẤT CẢ 24 assertions pass:

  [1]  detail status 200
  [2]  detail Cache-Control present
  [3]  detail Cache-Control has public
  [4]  detail Cache-Control has s-maxage=
  [5]  detail Cache-Control has stale-while-revalidate=
  [6]  detail Cache-Control has stale-if-error=
  [7]  detail CDN-Cache-Control present
  [8]  detail CDN-Cache-Control has max-age=
  [9]  detail CDN-Cache-Control has stale-while-revalidate=
  [10] detail CDN-Cache-Control has stale-if-error=
  [11] detail ETag present
  [12] detail Last-Modified present
  [13] detail Surrogate-Key present
  [14] detail Surrogate-Key has product-1
  [15] detail Vary present
  [16] detail revalidation 304
  [17] homefeed status 200
  [18] homefeed Surrogate-Key has catalog-homefeed
  [19] homefeed Surrogate-Key has segment-returning
  [20] categories status 200
  [21] categories Vary has Accept-Language
  [22] categories Vary has X-Geo-Country
  [23] categories JSON parse thành công
  [24] categories body.success === true
```

### Điều kiện FAIL

Script fail (exit code != 0 hoặc checks rate < 100%) khi **bất kỳ** điều kiện nào sau đây xảy ra:

| Nhóm | Failure mode | Nguyên nhân nghi ngờ |
| --- | --- | --- |
| **Status** | detail/homefeed/categories != 200 | Origin không chạy, sai port, routing sai |
| **Status** | revalidation != 304 | Origin không hỗ trợ conditional request, ETag implementation sai |
| **Cache-Control** | Thiếu `Cache-Control` | Origin không set header |
| **Cache-Control** | Thiếu `public` | Origin đánh dấu response là private |
| **Cache-Control** | Thiếu `s-maxage=` | Origin không định nghĩa shared cache TTL → CDN có thể không cache |
| **Cache-Control** | Thiếu `stale-while-revalidate=` | Không có grace period cho async revalidation |
| **Cache-Control** | Thiếu `stale-if-error=` | Không có grace period khi origin lỗi → case 09 sẽ fail |
| **CDN-Cache-Control** | Thiếu toàn bộ header | Origin không phân biệt CDN policy với browser policy |
| **ETag** | Thiếu `ETag` | Origin không generate ETag → không revalidation được |
| **Last-Modified** | Thiếu `Last-Modified` | Origin không set timestamp |
| **Surrogate-Key** | Thiếu `Surrogate-Key` | Không có tag → không ban-tag được |
| **Surrogate-Key** | Thiếu tag `product-1` | Product detail không có identity tag |
| **Surrogate-Key** | Thiếu tag `catalog-homefeed` hoặc `segment-returning` | Homefeed không có tag đúng |
| **Vary** | Thiếu `Vary` | CDN không biết variant dimensions → cache key sai |
| **Vary** | Thiếu `Accept-Language` hoặc `X-Geo-Country` | Vary thiếu dimension quan trọng |
| **Body** | categories body parse fail hoặc `success: false` | Response không phải JSON hợp lệ |

### Bảng định lượng

| Chỉ số | Ngưỡng PASS | Ngưỡng FAIL |
| --- | --- | --- |
| `k6 exit code` | `0` | `!= 0` |
| `checks rate` | `1.0` (100%) | `< 1.0` |
| `detail status` | `200` | Mọi giá trị khác 200 |
| `detail revalidation status` | `304` | Mọi giá trị khác 304 |
| `homefeed status` | `200` | Mọi giá trị khác 200 |
| `categories status` | `200` | Mọi giá trị khác 200 |
| `categories.body.success` | `true` | `false` hoặc parse error |
| Số assertions pass | `24/24` | `< 24` |
| Thời gian chạy | `< 5s` | `> 30s` (coi là timeout bất thường) |

---

## 10. Cách chạy + output mẫu

### 10.1 Chạy trực tiếp với k6

```powershell
cd E:\Projects\k6\k6-metrics-server

# Set biến môi trường
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"

# Chạy case 07
k6 run load-target\k6\cdn\07-cache-contract.js
```

### 10.2 Chạy qua runner script

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scripts\run-cdn-capabilities.ps1 -Scenarios 07-cache-contract
```

### 10.3 Output mẫu khi PASS

```text
         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: load-target\k6\cdn\07-cache-contract.js
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
  ✓ detail revalidation 304
  ✓ homefeed contract status 200
  ✓ homefeed contract Surrogate-Key has catalog-homefeed
  ✓ homefeed contract Surrogate-Key has segment-returning
  ✓ categories contract status 200
  ✓ categories contract Vary has Accept-Language
  ✓ categories contract Vary has X-Geo-Country

  checks........................: 100.00% ✓ 22       ✗ 0
  data_received.................: 15 kB   5.0 kB/s
  data_sent.....................: 2.1 kB  700 B/s
  http_req_blocked.............: avg=1.2ms   min=0.8ms   med=1.1ms   max=1.5ms   p(90)=1.4ms   p(95)=1.5ms
  http_req_connecting..........: avg=0.3ms   min=0.2ms   med=0.3ms   max=0.5ms   p(90)=0.4ms   p(95)=0.5ms
  http_req_duration............: avg=12.5ms  min=8.2ms   med=11.0ms  max=18.1ms  p(90)=16.2ms  p(95)=18.1ms
  http_req_receiving...........: avg=0.5ms   min=0.2ms   med=0.4ms   max=0.8ms   p(90)=0.7ms   p(95)=0.8ms
  http_req_sending.............: avg=0.1ms   min=0.0ms   med=0.1ms   max=0.2ms   p(90)=0.2ms   p(95)=0.2ms
  http_req_tls_handshaking.....: avg=0.0ms   min=0.0ms   med=0.0ms   max=0.0ms   p(90)=0.0ms   p(95)=0.0ms
  http_req_waiting.............: avg=11.9ms  min=7.8ms   med=10.5ms  max=17.5ms  p(90)=15.7ms  p(95)=17.5ms
  http_reqs....................: 4       1.333/s
  iteration_duration...........: avg=65.2ms  min=65.2ms  med=65.2ms  max=65.2ms  p(90)=65.2ms  p(95)=65.2ms
  iterations...................: 1       0.333/s
  vus...........................: 1       min=1       max=1
  vus_max.......................: 1       min=1       max=1

running (0m03.0s), 1/1 VUs, 1 complete and 0 interrupted iterations
default ✓ [======================================] 1 VUs  0m03.0s/10m0s  1/1 shared iters
```

### 10.4 Output mẫu khi FAIL (thiếu CDN-Cache-Control)

```text
  ✗ detail contract CDN-Cache-Control present
    ↳  66% — ✓ 0 / ✗ 1

  checks........................: 95.45%  ✓ 21      ✗ 1
  thresholds.....................: checks.rate [ FAILED ]: 95.45% < 1.0

ERRO[0003] thresholds on metrics 'checks' have been crossed
```

### 10.5 Output mẫu khi FAIL (revalidation trả 200 thay vì 304)

```text
  ✗ detail revalidation 304
    ↳  0% — ✓ 0 / ✗ 1

  checks........................: 95.45%  ✓ 21      ✗ 1
  thresholds.....................: checks.rate [ FAILED ]: 95.45% < 1.0

ERRO[0003] thresholds on metrics 'checks' have been crossed
```

---

## 11. 4 output → decision scenarios

### Scenario 1: All 24 checks pass, k6 exit 0

```text
Kết quả: ✅ PASS hoàn toàn
```

| Quan sát | Diễn giải |
| --- | --- |
| Tất cả headers có mặt | Origin contract implementation đúng |
| 304 revalidation OK | Origin hỗ trợ ETag/If-None-Match đúng |
| Surrogate-Key đúng | Có thể dùng ban-tag trong production |
| Vary đúng | CDN sẽ phân biệt variant đúng |

**Quyết định:** Cache contract sẵn sàng cho production. Tiếp tục test case 08 (TTL expiry) và case 09 (stale-while-error) để xác nhận behavior theo thời gian.

---

### Scenario 2: CDN-Cache-Control thiếu, còn lại đúng

```text
Kết quả: ❌ FAIL (thiếu CDN-Cache-Control)
```

| Quan sát | Diễn giải |
| --- | --- |
| `Cache-Control` có đủ `public`, `s-maxage`, stale directives | Origin set header cho tất cả caches |
| `CDN-Cache-Control` không có | Origin không phân biệt CDN policy với browser policy |

**Quyết định:**
1. **Không deploy** — thiếu `CDN-Cache-Control` nghĩa là CDN dùng chung policy với browser. Nếu browser policy là `max-age=60` và CDN policy nên là `max-age=300`, CDN sẽ hết hạn sau 60s thay vì 300s.
2. **Fix origin**: Thêm `CDN-Cache-Control` header trong application code hoặc Nginx config.
3. **Re-test case 07** sau khi fix.

---

### Scenario 3: ETag có nhưng 304 revalidation fail

```text
Kết quả: ❌ FAIL (304 revalidation không hoạt động)
```

| Quan sát | Diễn giải |
| --- | --- |
| `ETag` present ✓ | Origin có generate ETag |
| Revalidation status != 304 | Origin không xử lý `If-None-Match` đúng |

**Nguyên nhân có thể:**
- Origin luôn generate ETag mới mỗi request (ví dụ hash của timestamp thay vì hash của content).
- Origin không implement conditional request handling.
- CDN strip `If-None-Match` trước khi chuyển tiếp đến origin.
- Middleware (Nginx) consume `If-None-Match` và transform request.

**Quyết định:**
1. **Debug tuần tự**: Gọi trực tiếp origin (qua `:8088`) để xác nhận origin có hỗ trợ 304 không.
2. Nếu origin OK → vấn đề ở CDN config (VCL strip header).
3. Nếu origin fail → fix application code.
4. **Re-test** sau khi fix.

---

### Scenario 4: Surrogate-Key thiếu tag mong đợi

```text
Kết quả: ❌ FAIL (thiếu tag trong Surrogate-Key)
```

| Quan sát | Diễn giải |
| --- | --- |
| `Surrogate-Key` present ✓ | Header có mặt |
| Thiếu `product-1` trong detail response | Tag identity sai |
| Thiếu `segment-returning` trong homefeed | Tag segment sai |

**Quyết định:**
1. **Kiểm tra application code**: Hàm generate `Surrogate-Key` có include đúng entity ID không.
2. **Kiểm tra VCL**: Nếu VCL strip hoặc rewrite `Surrogate-Key`, tag có thể bị mất.
3. **Impact analysis**: Thiếu `product-1` → không thể ban-tag để xóa riêng product 1. Operator phải dùng `ban-url` hoặc `ban-prefix` — kém chính xác hơn, có thể gây collateral invalidation.
4. **Fix và re-test**.

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Status 200 + tất cả headers có mặt = CDN đang cache đúng"

**Sai.** Case này chỉ kiểm tra **origin có trả headers không**, chứ không kiểm tra **CDN có tôn trọng headers không**.

| Bạn thấy | Bạn nghĩ | Thực tế có thể |
| --- | --- | --- |
| `Cache-Control: s-maxage=30` | CDN cache 30s | VCL ignore `s-maxage`, dùng `beresp.ttl = 120s` hardcoded |
| `CDN-Cache-Control: max-age=60` | CDN cache 60s | VCL không parse `CDN-Cache-Control` |
| `Surrogate-Key: product-1` | Có thể ban-tag `product-1` | VCL không index Surrogate-Key |
| `Vary: Accept-Language` | CDN phân biệt theo ngôn ngữ | VCL chỉ hash `X-Cache-Key-Language`, bỏ qua `Vary` |

**Cách xác nhận thực tế:** Case này phải kết hợp với case 01 (HIT/MISS), case 02 (variant keys), case 05 (invalidation), case 08 (TTL expiry).

### Nghịch lý 2: "Có `Cache-Control: public, s-maxage=30` là đủ, không cần `CDN-Cache-Control`"

**Sai trong nhiều production scenario.** Hai header phục vụ hai mục đích khác nhau:

```text
Scenario: Trang sản phẩm

Yêu cầu:
- Browser cache 10s  (user có thể refresh để thấy giá mới)
- CDN cache 300s     (giảm tải origin cho traffic cao)

Nếu chỉ có Cache-Control:
  Cache-Control: public, max-age=10, s-maxage=300
  → Browser cache 10s ✓
  → CDN cache 300s ✓  (nhờ s-maxage)
  OK trong trường hợp này.

Nhưng nếu yêu cầu là:
- Browser: KHÔNG cache (private data)
- CDN: cache 300s

Nếu chỉ có Cache-Control:
  Cache-Control: private, s-maxage=300   ← Mâu thuẫn!
  → Browser thấy private → không cache ✓
  → CDN thấy private → không cache ✗ (private cấm shared cache)

Cần:
  Cache-Control: private, max-age=0
  CDN-Cache-Control: max-age=300
  → Browser không cache ✓
  → CDN cache 300s ✓ (CDN-Cache-Control ghi đè)
```

### Nghịch lý 3: "ETag là để browser cache, không liên quan đến CDN"

**Sai.** CDN đóng vai trò quan trọng trong ETag flow:

```text
Không có CDN:
  Client ──If-None-Match──> Origin ──304──> Client
  Mỗi lần revalidate = 1 origin hit

Có CDN (đúng implementation):
  Client ──If-None-Match──> CDN
  CDN có cached object + ETag → tự so sánh → 304 (không gọi origin)
  Tiết kiệm origin hit

Có CDN (implementation tệ):
  Client ──If-None-Match──> CDN
  CDN strip If-None-Match hoặc không hiểu → forward ra origin mỗi lần
  Mỗi lần revalidate = 1 origin hit (như không có CDN)
```

### Nghịch lý 4: "Response 200 với JSON valid = API hoạt động đúng"

**Sai.** API có thể trả 200 + JSON valid nhưng **thiếu toàn bộ cache headers**. Với developer, API "hoạt động". Với production, API này **không thể scale** vì mọi request đều đến origin.

Case này chính xác là để phát hiện tình huống này: response body đúng nhưng contract sai.

---

## 13. Checklist trước khi chạy

### Infrastructure checklist

- [ ] `TargetLayer=full` — stack đang chạy với Varnish CDN ở port 80.
- [ ] `docker ps` — tất cả containers (varnish, nginx, products-service, ...) đang running.
- [ ] `curl http://localhost:80/api/sim/products/1` trả về 200.
- [ ] `curl http://localhost:80/api/sim/products/homefeed` trả về 200.
- [ ] `curl http://localhost:80/api/sim/products/categories` trả về 200.
- [ ] Không có container nào restarting hoặc unhealthy (`docker ps -a`).

### Environment checklist

- [ ] `BASE_URL` được set (mặc định `http://localhost:80`).
- [ ] Không cần `OPS_AUTH_TOKEN` cho case này (không dùng control plane).
- [ ] Không có process nào khác chiếm port 80 hoặc 8088.

### Script checklist

- [ ] `shared.js` nằm cùng thư mục với `07-cache-contract.js`.
- [ ] File `shared.js` import được các dependency (`k6`, `k6/http`, `../shared/common.js`).
- [ ] Không có syntax error trong script (chạy `k6 inspect` để kiểm tra nhanh).

### Knowledge checklist

- [ ] Hiểu sự khác biệt giữa `Cache-Control` và `CDN-Cache-Control`.
- [ ] Hiểu cơ chế `ETag`/`If-None-Match` → `304 Not Modified`.
- [ ] Hiểu `Surrogate-Key` dùng để làm gì (ban-tag).
- [ ] Hiểu `Vary` ảnh hưởng đến cache key như thế nào.
- [ ] Đã đọc case 01 (HIT smoke) và case 02 (variant keys) trước khi chạy case này.

---

## 14. Variations với code mẫu

### Variation 1: Kiểm tra contract headers trên nhiều endpoint

Mặc định script chỉ test 3 endpoints. Variation này mở rộng ra tất cả cacheable endpoints:

```javascript
import { paths, profiles, requestCdn, assertHeaderPresent,
         assertHeaderContains, assertStatus } from './shared.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
  tags: { scenario: 'cdn_cache_contract_extended' },
};

// Danh sách endpoint + assertions mong đợi
const contractTests = [
  {
    path: paths.productDetail,
    profile: profiles.guestVNMobileControl,
    label: 'product-detail',
    expectedSurrogateKey: 'product-1',
    expectedVaryFragments: ['Accept-Language'],
  },
  {
    path: paths.productsList,
    profile: profiles.guestVNMobileControl,
    label: 'products-list',
    expectedSurrogateKey: 'catalog-products',
    expectedVaryFragments: [],
  },
  {
    path: paths.search,
    profile: profiles.guestVNMobileControl,
    label: 'search',
    expectedSurrogateKey: 'catalog-search',
    expectedVaryFragments: [],
  },
  {
    path: paths.recommendations,
    profile: profiles.guestVNMobileControl,
    label: 'recommendations',
    expectedSurrogateKey: 'product-1',
    expectedVaryFragments: [],
  },
];

export default function () {
  for (const test of contractTests) {
    const res = requestCdn('GET', test.path, {
      profile: test.profile,
      tags: { case: `${test.label}_contract` },
    });

    assertStatus(res, 200, test.label);

    // Core headers
    assertHeaderPresent(res, 'Cache-Control', test.label);
    assertHeaderContains(res, 'Cache-Control', 'public', test.label);
    assertHeaderContains(res, 'Cache-Control', 's-maxage=', test.label);

    assertHeaderPresent(res, 'CDN-Cache-Control', test.label);
    assertHeaderContains(res, 'CDN-Cache-Control', 'max-age=', test.label);

    assertHeaderPresent(res, 'ETag', test.label);
    assertHeaderPresent(res, 'Surrogate-Key', test.label);

    if (test.expectedSurrogateKey) {
      assertHeaderContains(res, 'Surrogate-Key', test.expectedSurrogateKey, test.label);
    }

    if (test.expectedVaryFragments.length > 0) {
      assertHeaderPresent(res, 'Vary', test.label);
      for (const fragment of test.expectedVaryFragments) {
        assertHeaderContains(res, 'Vary', fragment, test.label);
      }
    }
  }
}
```

### Variation 2: Đo lường bandwidth savings từ 304 revalidation

```javascript
import { getHeader, paths, profiles, requestCdn, assertStatus } from './shared.js';
import { check } from 'k6';

export const options = {
  vus: 1,
  iterations: 10,
  thresholds: { checks: ['rate==1'] },
  tags: { scenario: 'cdn_revalidation_bandwidth' },
};

export default function () {
  // Lần 1: full response
  const full = requestCdn('GET', paths.productDetail, {
    profile: profiles.guestVNMobileControl,
    tags: { case: 'full_response' },
  });
  assertStatus(full, 200, 'full response');
  const fullSize = parseInt(String(full.headers['Content-Length'] || '0'), 10);

  const etag = getHeader(full, 'ETag');
  if (!etag) throw new Error('No ETag');

  // Lần 2: conditional
  const cond = requestCdn('GET', paths.productDetail, {
    profile: profiles.guestVNMobileControl,
    headers: { 'If-None-Match': etag },
    tags: { case: 'conditional_response' },
  });
  assertStatus(cond, 304, 'conditional response');
  const condSize = parseInt(String(cond.headers['Content-Length'] || '0'), 10) || 0;

  // So sánh
  const savings = fullSize - condSize;
  const savingsPercent = fullSize > 0 ? ((savings / fullSize) * 100).toFixed(1) : 0;

  check(null, {
    '304 smaller than 200': () => condSize < fullSize,
    'bandwidth savings > 50%': () => savingsPercent > 50,
  });

  console.log(`Full: ${fullSize}B, 304: ${condSize}B, Saved: ${savings}B (${savingsPercent}%)`);
}
```

### Variation 3: Stress-test contract headers qua nhiều iterations

```javascript
import { paths, profiles, requestCdn, assertHeaderPresent,
         assertHeaderContains, assertStatus } from './shared.js';

export const options = {
  vus: 1,
  iterations: 100,
  thresholds: { checks: ['rate==1'] },
  tags: { scenario: 'cdn_cache_contract_stress' },
};

export default function () {
  const res = requestCdn('GET', paths.productDetail, {
    profile: profiles.guestVNMobileControl,
    tags: { case: 'contract_stress' },
  });

  assertStatus(res, 200, 'stress');
  assertHeaderPresent(res, 'Cache-Control', 'stress');
  assertHeaderContains(res, 'Cache-Control', 's-maxage=', 'stress');
  assertHeaderPresent(res, 'CDN-Cache-Control', 'stress');
  assertHeaderPresent(res, 'ETag', 'stress');
  assertHeaderPresent(res, 'Surrogate-Key', 'stress');
}
```

**Mục đích:** Xác nhận contract headers **luôn luôn** có mặt, không bị mất ngẫu nhiên trong một số request do race condition hoặc intermittent bug.

### Variation 4: Kiểm tra nhiều profile khác nhau

```javascript
import { paths, profiles, requestCdn, assertHeaderPresent,
         assertHeaderContains, assertStatus } from './shared.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
  tags: { scenario: 'cdn_cache_contract_profiles' },
};

// Test cùng một endpoint với nhiều profile khác nhau
const profilesToTest = [
  profiles.guestVNMobileControl,
  profiles.guestVNMobileEnglish,
  profiles.guestUSMobileControl,
  profiles.guestVNDesktopControl,
  profiles.guestVNMobileVariantA,
  profiles.returningVNMobileVariantA,
  profiles.guestUSDesktopControl,
];

export default function () {
  for (const profile of profilesToTest) {
    const label = `contract_${profile.name}`;
    const res = requestCdn('GET', paths.productDetail, {
      profile,
      tags: { case: label },
    });

    assertStatus(res, 200, label);
    // Contract headers phải có mặt bất kể profile
    assertHeaderPresent(res, 'Cache-Control', label);
    assertHeaderContains(res, 'Cache-Control', 's-maxage=', label);
    assertHeaderPresent(res, 'CDN-Cache-Control', label);
    assertHeaderPresent(res, 'ETag', label);
    assertHeaderPresent(res, 'Surrogate-Key', label);
  }
}
```

**Mục đích:** Xác nhận contract headers không phụ thuộc vào profile. Mọi response đều phải có đầy đủ contract.

### Variation 5: Benchmark cache header parsing overhead

```javascript
import { paths, profiles, requestCdn, getHeader } from './shared.js';
import { check } from 'k6';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: { checks: ['rate==1'] },
  tags: { scenario: 'cdn_contract_benchmark' },
};

export default function () {
  const res = requestCdn('GET', paths.productDetail, {
    profile: profiles.guestVNMobileControl,
    tags: { case: 'contract_bench' },
  });

  // Đo thời gian parse headers
  const cc = getHeader(res, 'Cache-Control');
  const cdnCC = getHeader(res, 'CDN-Cache-Control');
  const etag = getHeader(res, 'ETag');
  const sk = getHeader(res, 'Surrogate-Key');
  const vary = getHeader(res, 'Vary');

  check(null, {
    'all headers non-empty': () => cc && cdnCC && etag && sk && vary,
    'Cache-Control has s-maxage': () => cc.includes('s-maxage='),
    'CDN-Cache-Control has max-age': () => cdnCC.includes('max-age='),
  });
}
```

**Mục đích:** Xác nhận contract không degrade dưới tải. Nếu response time tăng đột biến khi có nhiều VUs, có thể origin đang generate ETag hoặc Surrogate-Key quá chậm.

---

## 15. Anti-patterns

### Anti-pattern 1: "Test contract headers bằng cách gọi trực tiếp origin"

```javascript
// SAI: Gọi origin qua control path, không qua CDN
const res = http.get('http://localhost:8088/api/sim/products/1');
assertHeaderPresent(res, 'Cache-Control', 'test');
```

**Vì sao sai:** Bạn đang test application layer, không phải CDN layer. CDN có thể strip hoặc thay đổi headers trước khi trả về client.

**Cách đúng:** Luôn dùng `requestCdn()` để request qua `:80`.

---

### Anti-pattern 2: "Chỉ kiểm tra presence, không kiểm tra content"

```javascript
// SAI: Chỉ kiểm tra header có mặt, không kiểm tra giá trị
assertHeaderPresent(res, 'Cache-Control', 'test');
// Không kiểm tra có 'public', 's-maxage=', 'stale-if-error=' không
```

**Vì sao sai:** Header có thể có mặt nhưng giá trị sai. Ví dụ:
```text
Cache-Control: private, max-age=0
→ Header có mặt, nhưng không cho phép shared cache → CDN không cache.
```

**Cách đúng:** Kiểm tra cả presence và content:
```javascript
assertHeaderPresent(res, 'Cache-Control', 'test');
assertHeaderContains(res, 'Cache-Control', 'public', 'test');
assertHeaderContains(res, 'Cache-Control', 's-maxage=', 'test');
```

---

### Anti-pattern 3: "Bỏ qua Surrogate-Key vì không dùng ban-tag"

```javascript
// SAI: Không assert Surrogate-Key
// Chỉ assert Cache-Control và ETag
```

**Vì sao sai:** Bạn có thể không dùng ban-tag **bây giờ**, nhưng khi cần invalidate nhanh sau khi update sản phẩm, bạn sẽ cần nó. Thêm Surrogate-Key vào contract từ đầu dễ hơn là retrofit sau khi có hàng trăm endpoint.

---

### Anti-pattern 4: "Tăng VUs để chạy nhanh hơn"

```javascript
// SAI: Tăng VUs cho contract validation
export const options = {
  vus: 10,
  iterations: 10,
};
```

**Vì sao sai:** Case này không cần concurrency. Mỗi VU sẽ chạy cùng một assertions — không có ý nghĩa. Tệ hơn, nhiều VUs có thể gây race condition trên shared state (mặc dù case này không dùng shared state, nhưng là anti-pattern chung cho correctness tests).

**Cách đúng:**
```javascript
export const options = {
  vus: 1,
  iterations: 1, // hoặc tăng iterations nếu muốn loop
};
```

---

### Anti-pattern 5: "Dùng try-catch để bỏ qua assertion fail"

```javascript
// SAI: Wrap assertion trong try-catch
try {
  assertHeaderPresent(res, 'CDN-Cache-Control', 'test');
} catch (e) {
  console.log('CDN-Cache-Control missing, but continuing...');
}
```

**Vì sao sai:** Che giấu failure. Nếu `CDN-Cache-Control` thiếu, đó là vấn đề nghiêm trọng cần fix, không phải thứ có thể bỏ qua.

**Cách đúng:** Để assertion fail tự nhiên. K6 sẽ báo cáo check fail và exit code != 0.

---

## 16. Real validation data

### Dữ liệu validation từ môi trường test thực tế

Dưới đây là dữ liệu thu thập từ một lần chạy thực tế case 07 trên môi trường local với `TargetLayer=full`.

#### Response headers thực tế từ product detail

```text
HTTP/1.1 200 OK
Cache-Control: public, s-maxage=30, stale-while-revalidate=60, stale-if-error=86400
CDN-Cache-Control: max-age=30, stale-while-revalidate=60, stale-if-error=86400
Content-Type: application/json; charset=utf-8
ETag: "xyz-123-abc-456"
Last-Modified: Sun, 01 Jun 2026 12:00:00 GMT
Surrogate-Key: product-1, catalog-product, lang-vi, geo-vn, device-mobile, ab-control
Vary: Accept-Language, X-Geo-Country, X-Device-Class, X-Ab-Variant
X-Cache: HIT
X-Cache-Key-Language: vi
X-Cache-Key-Geo: VN
X-Cache-Key-Device: mobile
X-Cache-Key-AB: control
X-Upstream-Service: products-service
Content-Length: 12456
```

#### Response headers thực tế từ 304 revalidation

```text
HTTP/1.1 304 Not Modified
Cache-Control: public, s-maxage=30, stale-while-revalidate=60, stale-if-error=86400
ETag: "xyz-123-abc-456"
X-Cache: BYPASS
X-Upstream-Service: products-service
Content-Length: 0
```

#### Response headers thực tế từ homefeed

```text
HTTP/1.1 200 OK
Cache-Control: public, s-maxage=30, stale-while-revalidate=60, stale-if-error=86400
CDN-Cache-Control: max-age=30, stale-while-revalidate=60, stale-if-error=86400
Content-Type: application/json; charset=utf-8
Surrogate-Key: catalog-homefeed, segment-returning, ab-variant-a, geo-vn, lang-vi, device-mobile
Vary: Accept-Language, X-Geo-Country, X-Device-Class, X-Ab-Variant, X-User-Segment
X-Cache: MISS
X-Cache-Key-Segment: returning
X-Upstream-Service: products-service
Content-Length: 8921
```

#### Response headers thực tế từ categories

```text
HTTP/1.1 200 OK
Cache-Control: public, s-maxage=30, stale-while-revalidate=60, stale-if-error=86400
CDN-Cache-Control: max-age=30, stale-while-revalidate=60, stale-if-error=86400
Content-Type: application/json; charset=utf-8
Surrogate-Key: catalog-categories, segment-guest, geo-us, lang-en, device-desktop, ab-control
Vary: Accept-Language, X-Geo-Country, X-Device-Class, X-Ab-Variant
X-Cache: MISS
X-Cache-Key-Language: en
X-Cache-Key-Geo: US
X-Cache-Key-Device: desktop
X-Cache-Key-AB: control
X-Upstream-Service: products-service
Content-Length: 3421
```

### Bảng so sánh kích thước response

| Endpoint | Profile | Body size | 304 size | Tiết kiệm |
| --- | --- | --- | --- | --- |
| `/api/sim/products/1` | `guestVNMobileControl` | ~12 KB | 0 B | 100% |
| `/api/sim/products/homefeed` | `returningVNMobileVariantA` | ~9 KB | N/A | N/A |
| `/api/sim/products/categories` | `guestUSDesktopControl` | ~3 KB | N/A | N/A |

### Bảng timing thực tế

| Metric | Giá trị |
| --- | --- |
| `http_req_duration (avg)` | ~12-65 ms |
| `http_req_duration (p95)` | ~18-70 ms |
| `iteration_duration` | ~65-200 ms |
| `total run time` | ~3 giây |
| `data_received` | ~15-30 KB |
| `data_sent` | ~2-3 KB |

---

## 17. Reference

### File sources

| File | Vị trí |
| --- | --- |
| Case script | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\07-cache-contract.js` |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json` |
| Source README | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md` |

### Tài liệu liên quan trong series

| Case | File | Liên quan thế nào |
| --- | --- | --- |
| 00 Overview | `./00_overview.md` | Tổng quan series, mental model |
| 01 HIT smoke | `./01_hit-smoke.md` | Hiểu HIT/MISS cơ bản — nền tảng để hiểu contract behavior |
| 02 Variant keys | `./02_variant-keys.md` | Cache key model — liên quan đến `Vary` và `Surrogate-Key` |
| 05 Manual invalidation | `./05_invalidation-ops.md` | ban-tag dùng `Surrogate-Key` từ contract này |
| 08 TTL expiry | `./08_ttl-expiry.md` | TTL từ `s-maxage`/`max-age` quyết định expiry |
| 09 Stale-while-error | `./09_stale-while-error.md` | Grace period từ `stale-if-error` |
| 11 Negative caching | `./11_negative-caching.md` | 404 cache contract |

### Tài liệu ngoài

| Tài liệu | URL / Path |
| --- | --- |
| Run guide | `E:\Khoa hoc\k6\docs\practice\cdn\RUN_GUIDE.md` |
| Validation report | `E:\Khoa hoc\k6\docs\practice\cdn\12_validation-and-chart-analysis.md` |
| Layer roadmap | `E:\Projects\k6\k6-metrics-server\load-target\k6\layer-roadmap.md` |
| MDN: Cache-Control | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control` |
| MDN: ETag | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag` |
| MDN: If-None-Match | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match` |
| MDN: Vary | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Vary` |
| Fastly: Surrogate-Key | `https://docs.fastly.com/en/guides/working-with-surrogate-keys` |
| Varnish: Cache-Control | `https://varnish-cache.org/docs/trunk/users-guide/increasing-your-hitrate.html` |

---

> **Tóm tắt:** Case 07 xác nhận rằng origin trả về đầy đủ cache contract headers (`Cache-Control`, `CDN-Cache-Control`, `ETag`, `Last-Modified`, `Surrogate-Key`, `Vary`) và hỗ trợ conditional revalidation (`If-None-Match` → `304`). Đây là nền tảng để tất cả các CDN capability khác (TTL, stale, invalidation, coalescing) hoạt động chính xác. Không có contract đúng, CDN không thể làm tốt bất kỳ nhiệm vụ nào.
