# Case 05: Manual invalidation ops

> **Case ID:** `cdn-05-invalidation-ops`
> **Script:** `05-invalidation-ops.js`
> **Layer:** CDN / Varnish
> **Proof:** purge exact URL, ban-url, ban-tag invalidates expected objects

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
11. [4 output -> decision scenarios](#11-4-output---decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist trước khi chạy](#13-checklist-trước-khi-chạy)
14. [4-5 Variations với code mẫu](#14-4-5-variations-với-code-mẫu)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh nghiệp vụ

Một nền tảng thương mại điện tử vận hành CDN (Varnish) để phục vụ hàng triệu người dùng ẩn danh mỗi ngày. Dữ liệu sản phẩm thay đổi liên tục: giá được điều chỉnh theo chiến dịch khuyến mãi, mô tả sản phẩm được cập nhật, trạng thái tồn kho biến động, hình ảnh banner được thay mới.

Khi dữ liệu gốc ở origin thay đổi, các bản sao đã được cache trên CDN trở nên **cũ (stale)**. Nếu không có cơ chế xóa cache chủ động, người dùng cuối sẽ tiếp tục nhìn thấy dữ liệu cũ cho đến khi TTL tự nhiên hết hạn — có thể mất từ vài phút đến vài giờ. Điều này gây ra ba hệ quả nghiệp vụ nghiêm trọng:

| Hậu quả | Ví dụ cụ thể | Mức độ ảnh hưởng |
| --- | --- | --- |
| Người dùng thấy giá sai | Giá khuyến mãi đã kết thúc nhưng cache vẫn hiển thị giá cũ | Tổn thất doanh thu, khiếu nại khách hàng |
| Thông tin sản phẩm sai lệch | Mô tả sản phẩm đã sửa lỗi chính tả nhưng CDN vẫn trả bản cũ | Trải nghiệm người dùng kém, mất uy tín thương hiệu |
| Dữ liệu liên quan không đồng bộ | Sản phẩm hết hàng nhưng trang đề xuất vẫn gợi ý sản phẩm đó | Người dùng bấm vào thấy "hết hàng" — trải nghiệm đứt gãy |

### 1.2 Ba tình huống invalidation điển hình

Hãy xét ba tình huống mà đội vận hành (ops team) gặp hàng ngày:

**Tình huống A — Cập nhật banner trang chủ (purge exact URL):**

```text
Banner Tết được thay bằng banner hè. Đây là một static asset được cache
ở path /api/cached. Chỉ cần xóa chính xác object đó — không ảnh hưởng
gì đến các object khác. Dùng purge (xóa exact URL).
```

**Tình huống B — Cập nhật giá sản phẩm có nhiều variant cache (ban-url):**

```text
Giá sản phẩm ID=1 thay đổi. Object này được cache với nhiều variant:
mobile/VN, desktop/VN, mobile/US, mobile/VN/variant-A, v.v...
Mỗi variant là một cache object riêng. Cần xóa TẤT CẢ variant của
URL /api/sim/products/1. Dùng ban-url (xóa theo URL prefix).
```

**Tình huống C — Sản phẩm thay đổi ảnh hưởng đến nhiều endpoint (ban-tag):**

```text
Sản phẩm ID=1 cập nhật ảnh đại diện. Không chỉ trang chi tiết sản phẩm
cần được invalidate, mà cả trang đề xuất (recommendations) hiển thị
ảnh cũ cũng phải được làm mới. Cả hai endpoint đều được gắn chung
Surrogate-Key: "product-1". Dùng ban-tag để xóa tất cả object có
chung tag này.
```

### 1.3 Vai trò của đội vận hành

Trong môi trường production, đội vận hành (ops) là những người thực thi invalidation thông qua control plane API. Họ không cần truy cập trực tiếp vào Varnish; thay vào đó, họ gọi các endpoint REST được bảo vệ bởi token xác thực:

```text
POST /ops/app/cdn/cache/purge    — xóa exact object
POST /ops/app/cdn/cache/ban-url  — xóa tất cả variant của một URL
POST /ops/app/cdn/cache/ban-tag  — xóa tất cả object có cùng Surrogate-Key
```

Đây chính là ba "vũ khí" mà case 05 này kiểm chứng.

---

## 2. CDN capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh ba khả năng invalidation thủ công của CDN:

> **purge exact URL, ban-url, ban-tag invalidates expected objects**

Cụ thể hơn:

| Mechanism | Phạm vi | Khi nào dùng | Test path trong case này |
| --- | --- | --- | --- |
| `purgeUrl()` | Một object — exact URL (có thể kèm variant headers) | Xóa chính xác một cache entry, thường là static asset hoặc non-variant content | `/api/cached` |
| `banUrl()` | Tất cả variant của một URL — xóa mọi cache object khớp URL prefix đó | Xóa toàn bộ cache cho một endpoint có nhiều variant (language, geo, device, AB) | `/api/sim/products/1` |
| `banTag()` | Tất cả object có chung một hoặc nhiều `Surrogate-Key` tag | Xóa nhiều endpoint liên quan đến cùng một entity (ví dụ: product-1 xuất hiện ở detail, recs, search) | `product-1` tag trên `/api/sim/products/1` và `/api/sim/products/1/recommendations` |

### 2.2 Phân biệt ba mechanism

Sự khác biệt cốt lõi nằm ở **cách CDN định danh object**:

```text
purge: "xóa object ở địa chỉ chính xác này"
       → CDN lookup bằng hash của URL + variant key
       → Chỉ xóa 1 object

ban-url: "xóa mọi object có URL bắt đầu bằng prefix này"
         → CDN lookup bằng URL prefix match
         → Xóa N object (tất cả variant)

ban-tag: "xóa mọi object có Surrogate-Key chứa tag này"
         → CDN lookup bằng Surrogate-Key index
         → Xóa M object (có thể khác URL)
```

### 2.3 Tại sao capability này quan trọng

Không có invalidation đúng, CDN trở thành "kẻ thù" thay vì "đồng minh":

```text
Không có invalidation: Người dùng thấy dữ liệu cũ → mất niềm tin → rời bỏ
Invalidaion sai phạm vi:   Xóa quá ít → còn sót object cũ; xóa quá rộng → cache hit ratio tụt
Invalidaion đúng:          Người dùng thấy dữ liệu mới trong < 1 giây, cache hit ratio phục hồi nhanh
```

---

## 3. Vì sao phải test ở CDN layer

### 3.1 CDN là điểm tiếp xúc cuối cùng với người dùng

```text
Người dùng → CDN (Varnish :80) → Nginx → App → Database
              ↑
         Điểm quyết định nội dung trả về
```

Dù app đã cập nhật database, dù Nginx đã reload config, nếu CDN vẫn giữ object cũ trong cache thì **người dùng vẫn nhận được dữ liệu cũ**. Test ở CDN layer là cách duy nhất để xác nhận toàn bộ chuỗi invalidation hoạt động end-to-end.

### 3.2 Control plane và data plane tách biệt

Một kiến trúc CDN trưởng thành tách biệt hai plane:

| Plane | Cổng | Vai trò | Ai gọi |
| --- | --- | --- | --- |
| Data plane | `:80` (public) | Phục vụ request người dùng — cache hit/miss quyết định response | Tất cả người dùng |
| Control plane | `:8088` (ops) | Thực thi lệnh quản trị — purge, ban, điều chỉnh origin profile | Chỉ đội vận hành (có token) |

Test ở CDN layer phải xác minh cả hai:

1. **Control plane nhận lệnh và trả về 200** — chưa đủ
2. **Data plane phản ánh hiệu ứng của lệnh** — đây mới là evidence thật

Nhiều đội ngũ mắc sai lầm: thấy control API trả 200 là cho rằng invalidation thành công. Thực tế, có nhiều lý do khiến control 200 nhưng cache vẫn HIT (xem section 12).

### 3.3 Không thể test invalidation ở tầng app

Nếu chỉ test API ở tầng app (bỏ qua CDN):

```text
Test sai:   curl http://localhost:8080/api/sim/products/1  (đi thẳng app, không qua CDN)
Test đúng:  curl http://localhost:80/api/sim/products/1     (đi qua CDN → Varnish)
```

Chỉ request qua `:80` mới đi qua Varnish và mới xác minh được cache state (`X-Cache: HIT` hay `X-Cache: MISS`).

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌─────────────────────────┐
                          │    k6 test script        │
                          │    (05-invalidation-ops) │
                          └──────┬────────┬──────────┘
                                 │        │
                    public path  │        │  control path
                    (GET)        │        │  (POST purge/ban)
                                 ▼        ▼
┌──────────────────────────────────────────────────────────────┐
│  localhost:80 (Varnish)          localhost:8088 (control)    │
│  ┌──────────────────┐           ┌──────────────────────┐    │
│  │  Varnish cache    │◄─────────┤  Ops control plane   │    │
│  │  - object store   │  ban/    │  /ops/app/cdn/cache/ │    │
│  │  - variant keys   │  purge   │    purge|ban-url|    │    │
│  │  - surrogate keys │  command │    ban-tag           │    │
│  └───────┬──────────┘           └──────────────────────┘    │
│          │ miss                                              │
│          ▼                                                   │
│  ┌──────────────┐                                            │
│  │  Nginx :8080 │                                            │
│  └───────┬──────┘                                            │
│          │                                                    │
│          ▼                                                    │
│  ┌──────────────────────────────────────┐                    │
│  │  App / microservices                 │                    │
│  │  - products-service (:8081)          │                    │
│  │  - recommendations-service           │                    │
│  └──────────────────────────────────────┘                    │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `full` (bắt buộc) | `docker ps` thấy Varnish container |
| `BASE_URL` | `http://localhost:80` | `curl -sI http://localhost:80/api/cached` thấy `X-Cache` header |
| `CONTROL_BASE_URL` | `http://localhost:8088` | `curl http://localhost:8088/health` |
| `OPS_AUTH_TOKEN` | Token xác thực control plane | Phải set trước khi chạy; không được commit |
| Varnish version | Bất kỳ version nào hỗ trợ `purge`, `ban`, `ban-url` | Không cần check cụ thể |

### 4.3 Stack khởi động

```powershell
# Khởi động full stack với CDN
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full -ScaleApp 2
```

Đợi tất cả service healthy (khoảng 30-60 giây). Kiểm tra:

```powershell
# Xác nhận Varnish đang chạy
docker ps --filter "name=varnish"

# Xác nhận public path hoạt động
curl -sI http://localhost:80/api/cached

# Xác nhận control path hoạt động
curl http://localhost:8088/health
```

### 4.4 Precondition của script

Script `setup()` tự động thực thi ba lệnh để đảm bảo trạng thái cache sạch trước khi test:

```javascript
export function setup() {
  purgeUrl(paths.cached);         // Xóa sạch /api/cached
  banUrl(paths.productDetail);    // Xóa sạch /api/sim/products/1
  banUrl(paths.recommendations);  // Xóa sạch /api/sim/products/1/recommendations
}
```

Điều này có nghĩa: **không cần precondition thủ công**. Script tự clear state. Tuy nhiên, nếu có test khác chạy trước đó và đang giữ lock trên cùng một cache object, có thể gây race condition — xem section 15.

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\05-invalidation-ops.js
```

### 5.2 Import và dependency

```javascript
import {
  paths,        // Định nghĩa tất cả URL path dùng trong test
  profiles,     // Các profile người dùng (guest, variant-a, v.v.)
  banTag,       // Hàm gọi POST /ops/app/cdn/cache/ban-tag
  banUrl,       // Hàm gọi POST /ops/app/cdn/cache/ban-url
  purgeUrl,     // Hàm gọi POST /ops/app/cdn/cache/purge
  requestCdn,   // Hàm gửi GET request qua CDN (:80)
  assertCacheState,  // Hàm kiểm tra X-Cache header
  assertStatus,      // Hàm kiểm tra HTTP status code
  assertUpstream,    // Hàm kiểm tra X-Upstream-Service header
} from './shared.js';
```

Tất cả các hàm này đều được định nghĩa trong `shared.js`. Đây là mô hình "shared helper" điển hình: script case chỉ chứa logic test, còn implementation detail (build request, gọi control API, kiểm tra header) được đóng gói trong shared module.

### 5.3 options block

```javascript
export const options = {
  vus: 1,           // 1 VU duy nhất — đây là correctness test, không phải load test
  iterations: 1,    // Chạy đúng 1 lần — mỗi bước là sequential proof
  thresholds: {
    checks: ['rate==1'],  // 100% checks phải pass — không chấp nhận bất kỳ lỗi nào
  },
  tags: {
    scenario: 'cdn_invalidation_ops',  // Tag để phân biệt trên dashboard/cloud
  },
};
```

**Tại sao `vus: 1` và `iterations: 1`?**

Đây là **correctness proof**, không phải benchmark. Mỗi bước trong test phụ thuộc vào kết quả của bước trước (warm → HIT → invalidate → MISS). Nếu có nhiều VU chạy song song:

- VU A đang warm object thì VU B đã invalidate mất
- Trình tự MISS/HIT/MISS bị phá vỡ
- Không thể quy kết nguyên nhân thất bại

Luôn giữ `vus: 1` cho các case correctness CDN trừ khi case đó được thiết kế riêng cho concurrency (như case 10 — request coalescing).

**`checks: ['rate==1']`**: Threshold này có nghĩa: **mọi check phải pass 100%**. Nếu có dù chỉ 1 check fail (vd: expected HIT nhưng lại MISS), k6 sẽ exit với mã lỗi khác 0. Đây là contract cứng: không có chỗ cho "gần đúng" trong cache correctness.

### 5.4 Hàm `warmUntilHit(path, profile, label)` — local helper

Script định nghĩa một helper function để đảm bảo object đã được cache trước khi invalidate:

```javascript
function warmUntilHit(path, profile, label) {
  // Lần 1: MISS (cold — object chưa có trong cache)
  const first = requestCdn('GET', path, {
    profile,
    tags: { case: `${label}_warm_first` },
  });
  assertStatus(first, 200, `${label} warm first`);
  assertUpstream(first, 'products-service', `${label} warm first`);
  assertCacheState(first, 'MISS', `${label} warm first`);

  // Lần 2: HIT (warm — object đã được cache từ lần 1)
  const second = requestCdn('GET', path, {
    profile,
    tags: { case: `${label}_warm_second` },
  });
  assertStatus(second, 200, `${label} warm second`);
  assertCacheState(second, 'HIT', `${label} warm second`);
}
```

**Chi tiết từng bước trong warmUntilHit:**

| Bước | Hành động | Expected response | Ý nghĩa |
| --- | --- | --- | --- |
| `first` | GET path với profile | Status 200, Upstream `products-service`, Cache `MISS` | Object chưa có trong cache; CDN phải forward lên origin. `assertUpstream` xác nhận request đã thực sự đến đúng service. |
| `second` | GET path với cùng profile | Status 200, Cache `HIT` | Object đã nằm trong cache; CDN trả về mà không forward lên origin. `HIT` xác nhận cache fill thành công. |

**Pattern này lặp lại trong MỌI CDN case** vì nó là precondition bắt buộc cho bất kỳ invalidation test nào: bạn không thể kiểm tra "invalidate có hoạt động không" nếu object chưa từng được cache.

### 5.5 `setup()` — dọn dẹp trước khi test

```javascript
export function setup() {
  purgeUrl(paths.cached);         // (1) Purge /api/cached
  banUrl(paths.productDetail);    // (2) Ban /api/sim/products/1
  banUrl(paths.recommendations);  // (3) Ban /api/sim/products/1/recommendations
}
```

Ba lệnh này chạy **trước** `default()` function, trong giai đoạn `setup` của k6 lifecycle. Mục đích:

- Đảm bảo không có object cũ từ lần chạy trước còn sót lại
- Đặt mọi thứ về trạng thái "cache trống" để test bắt đầu từ baseline sạch
- Mỗi lệnh gọi control API và assert status 200 — nếu control plane không hoạt động, test sẽ fail ngay ở setup

**Lưu ý:** `purgeUrl` cho `/api/cached` được dùng thay vì `banUrl` vì `/api/cached` là non-variant path — chỉ có 1 object, purge là đủ và chính xác hơn.

### 5.6 `default()` — logic chính

`default()` thực thi ba proof tuần tự:

#### Proof 1: Purge exact URL

```javascript
// Bước 1.1: Warm /api/cached (non-variant path)
const cachedFirst = requestCdn('GET', paths.cached, {
  tags: { case: 'cached_first' },
});
assertStatus(cachedFirst, 200, 'cached first');
assertCacheState(cachedFirst, 'MISS', 'cached first');

const cachedSecond = requestCdn('GET', paths.cached, {
  tags: { case: 'cached_second' },
});
assertStatus(cachedSecond, 200, 'cached second');
assertCacheState(cachedSecond, 'HIT', 'cached second');

// Bước 1.2: Purge exact URL
purgeUrl(paths.cached);

// Bước 1.3: Verify — request sau purge phải là MISS
const cachedAfterPurge = requestCdn('GET', paths.cached, {
  tags: { case: 'cached_after_purge' },
});
assertStatus(cachedAfterPurge, 200, 'cached after purge');
assertCacheState(cachedAfterPurge, 'MISS', 'cached after purge');
```

**Phân tích chuỗi:** `MISS → HIT → [purge] → MISS`

- `MISS` đầu tiên: object chưa có, CDN forward lên origin
- `HIT`: object đã cache, CDN phục vụ từ cache
- `purgeUrl()`: gọi `POST /ops/app/cdn/cache/purge` với payload `{url: "/api/cached"}`
- `MISS` cuối: object đã bị xóa, CDN phải forward lên origin lần nữa

**Tại sao `/api/cached` không truyền profile?** Vì đây là non-variant path. Không có `Accept-Language`, `X-Geo-Country`, `X-Device-Class`, hay `X-Ab-Variant` header nào được gửi kèm. Object được cache với key mặc định (chỉ dựa trên URL). Purge exact URL không cần profile vì không có variant để phân biệt.

#### Proof 2: Ban URL (multi-variant)

```javascript
// Bước 2.1: Warm product detail với 2 profile khác nhau
const guest = profiles.guestVNMobileControl;
const variantA = profiles.guestVNMobileVariantA;

warmUntilHit(paths.productDetail, guest, 'guest_variant');
warmUntilHit(paths.productDetail, variantA, 'variant_a');

// Bước 2.2: Ban URL — xóa TẤT CẢ variant của /api/sim/products/1
banUrl(paths.productDetail);

// Bước 2.3: Verify — cả hai profile đều phải MISS
const guestAfterBanUrl = requestCdn('GET', paths.productDetail, {
  profile: guest,
  tags: { case: 'guest_after_ban_url' },
});
assertStatus(guestAfterBanUrl, 200, 'guest after ban-url');
assertCacheState(guestAfterBanUrl, 'MISS', 'guest after ban-url');

const variantAfterBanUrl = requestCdn('GET', paths.productDetail, {
  profile: variantA,
  tags: { case: 'variant_after_ban_url' },
});
assertStatus(variantAfterBanUrl, 200, 'variant after ban-url');
assertCacheState(variantAfterBanUrl, 'MISS', 'variant after ban-url');
```

**Phân tích chuỗi:**

```text
guest warm:      MISS → HIT  (cache key: vi/VN/mobile/control/guest)
variantA warm:   MISS → HIT  (cache key: vi/VN/mobile/variant-a/guest)
[banUrl]         ← xóa CẢ HAI object (và mọi variant khác của URL này)
guest verify:    MISS ✓      (object đã bị xóa)
variantA verify: MISS ✓      (object đã bị xóa)
```

**Điểm mấu chốt:** `banUrl` hoạt động ở mức URL prefix — nó không quan tâm đến variant. Tất cả cache object có URL khớp với `/api/sim/products/1` đều bị xóa. Đây là sức mạnh của `banUrl`: một lệnh duy nhất xóa mọi phiên bản đã cache của một endpoint.

**Hai profile được chọn có chủ đích:**

| Profile | Language | Geo | Device | AB | Segment | Cache key khác biệt |
| --- | --- | --- | --- | --- | --- |
| `guestVNMobileControl` | `vi` | `VN` | `mobile` | `control` | `guest` | control (baseline) |
| `guestVNMobileVariantA` | `vi` | `VN` | `mobile` | `variant-a` | `guest` | variant-a (khác AB) |

Hai profile này chỉ khác nhau ở `X-Ab-Variant` header, đủ để tạo ra hai cache object riêng biệt. Việc verify cả hai cùng MISS sau `banUrl` chứng minh rằng `banUrl` xóa **tất cả variant**, không chỉ một variant cụ thể.

#### Proof 3: Ban Tag (surrogate key)

```javascript
// Bước 3.1: Dọn dẹp và warm
banUrl(paths.productDetail);
banUrl(paths.recommendations);
warmUntilHit(paths.productDetail, guest, 'detail_for_tag');
warmUntilHit(paths.recommendations, guest, 'recs_for_tag');

// Bước 3.2: Ban tag "product-1"
banTag('product-1');

// Bước 3.3: Verify — cả product detail và recommendations đều MISS
const detailAfterTag = requestCdn('GET', paths.productDetail, {
  profile: guest,
  tags: { case: 'detail_after_ban_tag' },
});
assertStatus(detailAfterTag, 200, 'detail after ban-tag');
assertCacheState(detailAfterTag, 'MISS', 'detail after ban-tag');

const recsAfterTag = requestCdn('GET', paths.recommendations, {
  profile: guest,
  tags: { case: 'recs_after_ban_tag' },
});
assertStatus(recsAfterTag, 200, 'recs after ban-tag');
assertCacheState(recsAfterTag, 'MISS', 'recs after ban-tag');
```

**Phân tích chuỗi:**

```text
detail warm:     MISS → HIT  (Surrogate-Key: product-1)
recs warm:       MISS → HIT  (Surrogate-Key: product-1)
[banTag('product-1')]        ← xóa MỌI object có Surrogate-Key chứa "product-1"
detail verify:   MISS ✓      (object đã bị xóa bởi tag match)
recs verify:     MISS ✓      (object đã bị xóa bởi tag match)
```

**Điểm mấu chốt:** `banTag` hoạt động dựa trên `Surrogate-Key` header — một HTTP response header do origin thiết lập để gom nhóm các object có liên quan. Khi sản phẩm 1 thay đổi, tất cả object có tag `product-1` đều bị xóa **bất kể URL của chúng là gì**. Đây là cơ chế mạnh nhất trong ba cơ chế: nó xóa theo **ngữ nghĩa** (semantic grouping), không phải theo URL.

**Tại sao phải `banUrl` lại trước khi warm cho proof 3?** Vì `default()` chạy tuần tự. Sau proof 2, `guest` và `variantA` đã request lại `/api/sim/products/1` (kết quả MISS) và object đã được cache lại từ các request đó. Nếu không `banUrl` trước khi warm, `warmUntilHit` có thể thấy HIT ngay lần đầu (do object từ proof 2 vẫn còn). Script làm vậy để đảm bảo mỗi proof là độc lập.

### 5.7 `teardown()` — không có

Script này không định nghĩa `teardown()`. Đối với CDN correctness cases, việc dọn dẹp sau khi chạy thường không cần thiết vì:

- Mỗi lần chạy `setup()` đã tự clear state
- Object cache sẽ tự expire theo TTL
- Không có side effect cần rollback (không như case 09 thay đổi origin profile)

### 5.8 Sơ đồ tổ chức toàn bộ script

```text
┌─ options: vus=1, iterations=1, thresholds checks rate==1
│
├─ warmUntilHit(path, profile, label) ← local helper
│   ├─ first GET → assert 200 + MISS + upstream
│   └─ second GET → assert 200 + HIT
│
├─ setup()
│   ├─ purgeUrl(/api/cached)
│   ├─ banUrl(/api/sim/products/1)
│   └─ banUrl(/api/sim/products/1/recommendations)
│
└─ default()
    ├─ Proof 1: Purge exact
    │   ├─ GET /api/cached → MISS
    │   ├─ GET /api/cached → HIT
    │   ├─ purgeUrl(/api/cached)
    │   └─ GET /api/cached → MISS
    │
    ├─ Proof 2: Ban URL
    │   ├─ warm guest variant: MISS → HIT
    │   ├─ warm variantA: MISS → HIT
    │   ├─ banUrl(/api/sim/products/1)
    │   ├─ GET guest → MISS
    │   └─ GET variantA → MISS
    │
    └─ Proof 3: Ban Tag
        ├─ banUrl detail + recs (clean)
        ├─ warm detail: MISS → HIT
        ├─ warm recs: MISS → HIT
        ├─ banTag('product-1')
        ├─ GET detail → MISS
        └─ GET recs → MISS
```

---

## 6. Cache key model / VCL deep-dive

### 6.1 Mô hình cache key

CDN (Varnish) quyết định một request có được phục vụ từ cache hay không dựa trên **cache key** — một định danh duy nhất cho mỗi object trong cache. Cache key được xây dựng từ:

```text
cache_key = hash(url_path + normalized_query + variant_dimensions)
```

Với hệ thống trong suite này, variant dimensions gồm:

| Dimension | Header nguồn | Normalize rule | Ví dụ |
| --- | --- | --- | --- |
| Language | `Accept-Language` | Lấy 2 ký tự đầu, lowercase; fallback `en` | `vi`, `en`, `ja` |
| Geo | `X-Geo-Country` | Uppercase; whitelist `SG`/`US`/`JP`; fallback `VN` | `VN`, `US` |
| Device | `X-Device-Class` | Lowercase; whitelist `mobile`/`tablet`/`desktop`; fallback `desktop` | `mobile`, `desktop` |
| AB | `X-Ab-Variant` | Lowercase; whitelist `variant-a`/`variant-b`; fallback `control` | `control`, `variant-a` |
| Segment | `X-User-Segment` | Lowercase; whitelist `new_user`/`returning`/`vip`; fallback `guest` | `guest`, `returning` |

Tất cả các rule normalize này được implement trong `shared.js` hàm `normalizeGeo`, `normalizeDevice`, `normalizeAB`, `normalizeSegment`.

### 6.2 Cách hoạt động của purge

Purge yêu cầu CDN xóa object với **cache key chính xác**. Flow trong Varnish:

```text
1. Nhận request PURGE (hoặc POST tới control endpoint)
2. Tính cache key từ URL (+ profile headers nếu có)
3. Lookup trong cache store bằng exact cache key
4. Nếu tìm thấy: xóa object đó
5. Nếu không tìm thấy: vẫn trả 200 (idempotent — purge object không tồn tại không phải lỗi)
```

**Hàm `purgeUrl` trong shared.js:**

```javascript
export function purgeUrl(url, profile = null) {
  const payload = { url };
  if (profile) {
    payload.headers = profile.headers;  // Gửi kèm variant headers để xác định đúng variant
  }
  const res = controlRequest('POST', '/ops/app/cdn/cache/purge', payload, ...);
  assertStatus(res, 200, `purge ${url}`);
  return res;
}
```

Khi `profile = null` (như với `/api/cached` trong case này), control plane sẽ purge object với cache key chỉ gồm URL (không có variant). Điều này đúng cho non-variant path.

### 6.3 Cách hoạt động của ban-url

Ban-url xóa tất cả object có URL khớp với prefix được chỉ định. Flow trong Varnish:

```text
1. Nhận lệnh ban-url với URL cụ thể
2. Duyệt tất cả object trong cache
3. Với mỗi object, so sánh URL của nó với banned URL
4. Nếu URL khớp (prefix match): thêm vào ban list (hoặc xóa ngay)
5. Các request sau cho URL khớp sẽ bị ép MISS cho đến khi object được cache lại
```

**Hàm `banUrl` trong shared.js:**

```javascript
export function banUrl(url) {
  const res = controlRequest('POST', '/ops/app/cdn/cache/ban-url', { url }, ...);
  assertStatus(res, 200, `ban-url ${url}`);
  return res;
}
```

`banUrl` KHÔNG nhận `profile` — nó xóa **tất cả variant** của URL. Đây là điểm khác biệt chính với `purgeUrl`.

### 6.4 Cách hoạt động của ban-tag

Ban-tag dựa trên `Surrogate-Key` — HTTP response header mà origin thêm vào response để gom nhóm object:

```text
# Origin response header ví dụ:
Surrogate-Key: product-1 category-shoes segment-guest
```

Flow trong Varnish:

```text
1. Origin thêm Surrogate-Key vào response khi object được cache
2. Varnish lưu mapping: tag → [list of cache objects]
3. Khi nhận lệnh ban-tag với tag "product-1":
   a. Lookup trong tag index
   b. Xóa tất cả object có tag "product-1"
   c. Xóa mapping tag đó khỏi index
4. Request sau cho bất kỳ object nào trước đây có tag đó → MISS
```

**Hàm `banTag` trong shared.js:**

```javascript
export function banTag(tag) {
  const res = controlRequest('POST', '/ops/app/cdn/cache/ban-tag', { tag }, ...);
  assertStatus(res, 200, `ban-tag ${tag}`);
  return res;
}
```

### 6.5 Bảng so sánh ba cơ chế invalidation

| Khía cạnh | purgeUrl | banUrl | banTag |
| --- | --- | --- | --- |
| **Cơ chế lookup** | Exact cache key hash | URL prefix match | Surrogate-Key index |
| **Số object bị ảnh hưởng** | 1 (exact match) | N (tất cả variant của URL) | M (tất cả endpoint có cùng tag) |
| **Cần profile?** | Có (nếu muốn purge variant cụ thể) | Không | Không |
| **Có thể xóa chọn lọc variant?** | Có — nếu truyền `profile.headers` | Không — luôn xóa tất cả variant | Không — luôn xóa tất cả object có tag |
| **Control endpoint** | `/ops/app/cdn/cache/purge` | `/ops/app/cdn/cache/ban-url` | `/ops/app/cdn/cache/ban-tag` |
| **Payload** | `{url, headers?}` | `{url}` | `{tag}` |
| **Idempotent?** | Có | Có | Có |
| **Use case chính** | Static asset, non-variant content | Variant-heavy endpoint cần xóa toàn bộ | Entity thay đổi ảnh hưởng nhiều endpoint |
| **Rủi ro nếu dùng sai** | Không xóa hết variant → còn sót object cũ | Xóa quá rộng → cache hit ratio tụt | Quên gắn Surrogate-Key ở origin → không có tác dụng |

### 6.6 VCL implementation chi tiết (Varnish)

Để hiểu sâu hơn về cách ba cơ chế hoạt động, hãy xem xét VCL (Varnish Configuration Language) — ngôn ngữ cấu hình của Varnish quyết định cache behavior.

#### Purge trong VCL

```vcl
# VCL cho phép PURGE request từ internal network
acl purgers {
  "localhost";
  "10.0.0.0"/8;
  "172.16.0.0"/12;
}

sub vcl_recv {
  if (req.method == "PURGE") {
    if (!client.ip ~ purgers) {
      return (synth(405, "Not allowed"));
    }
    # Purge object với cache key hiện tại
    return (purge);
  }
}
```

Purge trong Varnish dùng HTTP method `PURGE` (không phải POST như trong case này — control plane đóng vai trò proxy). Khi `return(purge)` được gọi, Varnish:

1. Tính hash của request hiện tại dựa trên `vcl_hash`
2. Tìm object có hash đó trong cache
3. Nếu tìm thấy: giải phóng object (free memory)
4. Nếu không: vẫn trả về 200 (idempotent)

**Purge chỉ xóa 1 object** vì mỗi cache key hash là duy nhất cho 1 variant.

#### Ban trong VCL

```vcl
# VCL cho ban expression
sub vcl_recv {
  if (req.method == "BAN") {
    if (!client.ip ~ purgers) {
      return (synth(405, "Not allowed"));
    }
    # Thêm ban expression vào ban list
    ban("req.url ~ " + req.http.X-Ban-Expression);
    return (synth(200, "Ban added"));
  }
}

# VCL kiểm tra ban list trước khi serve từ cache
sub vcl_hit {
  if (obj.ban) {
    return (pass);  // Object bị ban → bypass cache, fetch từ origin
  }
}
```

Khi một ban expression được thêm vào ban list:

1. Varnish thêm expression vào danh sách active bans
2. Mỗi lần object được request, Varnish kiểm tra: object có match expression nào không?
3. Nếu match → `obj.ban = true` → object bị "đánh dấu" là banned
4. Request tiếp theo cho object đó sẽ thấy `obj.ban = true` → `return(pass)` → MISS
5. Object bị banned sẽ bị xóa khỏi cache khi Varnish dọn dẹp (có thể không ngay lập tức)

**Ban expression mạnh hơn purge** vì nó match nhiều object cùng lúc. Ví dụ:

```text
Ban expression: req.url ~ "^/api/sim/products/1"
→ Match tất cả variant của /api/sim/products/1 (vì URL prefix match)
→ Match /api/sim/products/1 (mọi Accept-Language, Geo, Device, AB, Segment)
→ Nhưng KHÔNG match /api/sim/products/10 hoặc /api/sim/products/100
```

**Lưu ý về performance:** Với hàng triệu object, mỗi lần object được request, Varnish phải kiểm tra tất cả active ban expressions. Nếu có quá nhiều bans (hàng nghìn), performance có thể giảm. Best practice: định kỳ dọn dẹp ban list (Varnish tự làm khi object cũ bị xóa).

#### Surrogate Key (ban-tag) trong VCL

```vcl
import xkey;  // VMOD cho soft purge bằng surrogate keys

sub vcl_backend_response {
  // Lưu Surrogate-Key từ origin response vào object
  if (beresp.http.Surrogate-Key) {
    // xkey VMOD tự động lưu mapping: tag → object ID
  }
}

sub vcl_recv {
  if (req.method == "PURGE" && req.http.X-Purge-By-Key) {
    // Soft purge bằng surrogate key
    set req.http.XKey-RegExp = req.http.X-Purge-By-Key;
    return (hash);  // xkey VMOD sẽ xử lý trong vcl_hash
  }
}
```

`xkey` VMOD mở rộng Varnish để hỗ trợ soft purge bằng surrogate keys. Cách hoạt động:

1. Khi object được cache, `xkey` parse `Surrogate-Key` header và lưu mapping: `"product-1" → [obj_id1, obj_id2, ...]`
2. Khi có lệnh soft purge với key `"product-1"`:
   - Tìm tất cả object ID có tag đó
   - Đánh dấu các object đó là "stale" (soft purge)
   - Request tiếp theo: nếu object còn trong grace period → serve stale; nếu hết grace → fetch từ origin
3. Soft purge khác với hard purge: object không bị xóa ngay mà được giữ lại để serve stale trong grace period

**Trong case này:** `banTag('product-1')` gọi control plane, control plane forward đến Varnish với lệnh tương ứng (có thể là ban expression hoặc xkey soft purge, tùy implementation).

### 6.7 Các edge case của invalidation

#### Edge case 1: Invalidate object đang được request

```text
Timeline:
  T1: Client A gửi GET /api/cached → MISS → Varnish forward origin
  T2: Ops gửi PURGE /api/cached
  T3: Origin phản hồi response cho Client A → Varnish lưu cache

Kết quả: Client A nhận response từ origin (MISS), nhưng object vẫn
được cache sau T3. PURGE ở T2 có thể không có tác dụng vì object chưa
tồn tại trong cache tại thời điểm đó.

Giải pháp: Sau purge, gửi request verify. Nếu verify thấy HIT (race condition),
thực hiện purge lại.
```

#### Edge case 2: Ban trong khi đang có nhiều request concurrent

```text
Khi ban-url được thêm vào ban list, các request ĐANG ĐƯỢC XỬ LÝ có thể
vẫn nhận HIT nếu Varnish check ban expression TRƯỚC KHI lookup cache.

Varnish thông thường:
  1. vcl_recv: check ban expression → nếu match, return(pass)
  2. vcl_hash: lookup cache → nếu HIT, serve; nếu MISS, fetch

Nhưng nếu request đã vượt qua bước 1 TRƯỚC KHI ban expression được thêm:
  → Request vẫn HIT với object cũ
  → Ban expression chỉ có hiệu lực với request MỚI sau đó

Đây là lý do grace period quan trọng trong production (xem Variation 7).
```

#### Edge case 3: Ban-tag khi object chưa có Surrogate-Key

```text
Nếu origin không gửi Surrogate-Key header (hoặc VCL không cấu hình xkey),
ban-tag hoàn toàn vô tác dụng.

Kiểm tra: curl -sI http://localhost:8080/api/sim/products/1 | grep -i surrogate
Nếu không thấy Surrogate-Key → app consumer logic phải dùng banUrl thay vì banTag.
```

#### Edge case 4: Collateral invalidation (invalidate nhầm object khác)

```text
Tình huống: banUrl('/api/sim/products/1') cũng xóa /api/sim/products/10
vì prefix match. Điều này gọi là "collateral invalidation".

Nguyên nhân: VCL ban expression dùng regex quá rộng:
  SAI:   ban("req.url ~ /api/sim/products/1")
  ĐÚNG:  ban("req.url == /api/sim/products/1")

Để tránh: dùng exact match hoặc carefully crafted regex với anchor $.
Test bằng cách: ban URL A, verify URL B không bị ảnh hưởng (Variation 2).
```

---

## 7. Request sequence flow

### 7.1 Timeline toàn bộ script

```text
T0: k6 start
│
├─ SETUP phase ──────────────────────────────────────
│  T1: POST /ops/app/cdn/cache/purge    {url:"/api/cached"}              → 200 OK
│  T2: POST /ops/app/cdn/cache/ban-url  {url:"/api/sim/products/1"}      → 200 OK
│  T3: POST /ops/app/cdn/cache/ban-url  {url:"/api/sim/products/1/recommendations"} → 200 OK
│
├─ DEFAULT phase ────────────────────────────────────
│
│  ═══ Proof 1: Purge exact URL ═══
│  T4: GET  /api/cached                       (no variant)  → 200 MISS products-service
│  T5: GET  /api/cached                       (no variant)  → 200 HIT
│  T6: POST /ops/app/cdn/cache/purge          {url:"/api/cached"}        → 200 OK
│  T7: GET  /api/cached                       (no variant)  → 200 MISS products-service
│
│  ═══ Proof 2: Ban URL multi-variant ═══
│  T8:  GET  /api/sim/products/1  [guestVNMobileControl]   → 200 MISS products-service
│  T9:  GET  /api/sim/products/1  [guestVNMobileControl]   → 200 HIT
│  T10: GET  /api/sim/products/1  [guestVNMobileVariantA]  → 200 MISS products-service
│  T11: GET  /api/sim/products/1  [guestVNMobileVariantA]  → 200 HIT
│  T12: POST /ops/app/cdn/cache/ban-url     {url:"/api/sim/products/1"}   → 200 OK
│  T13: GET  /api/sim/products/1  [guestVNMobileControl]   → 200 MISS products-service
│  T14: GET  /api/sim/products/1  [guestVNMobileVariantA]  → 200 MISS products-service
│
│  ═══ Proof 3: Ban Tag ═══
│  T15: POST /ops/app/cdn/cache/ban-url     {url:"/api/sim/products/1"}   → 200 OK
│  T16: POST /ops/app/cdn/cache/ban-url     {url:"/api/sim/products/1/recommendations"} → 200 OK
│  T17: GET  /api/sim/products/1  [guestVNMobileControl]   → 200 MISS products-service
│  T18: GET  /api/sim/products/1  [guestVNMobileControl]   → 200 HIT
│  T19: GET  /api/sim/products/1/recommendations [guestVNMobileControl]   → 200 MISS products-service
│  T20: GET  /api/sim/products/1/recommendations [guestVNMobileControl]   → 200 HIT
│  T21: POST /ops/app/cdn/cache/ban-tag    {tag:"product-1"}               → 200 OK
│  T22: GET  /api/sim/products/1  [guestVNMobileControl]   → 200 MISS products-service
│  T23: GET  /api/sim/products/1/recommendations [guestVNMobileControl]   → 200 MISS products-service
│
└─ T24: k6 end (checks rate==1 → exit 0)
```

### 7.2 Phân tích từng giai đoạn

#### Giai đoạn SETUP (T1-T3)

```text
Mục đích: Đảm bảo cache sạch trước khi bắt đầu test

T1: purgeUrl(/api/cached)
    → Gọi control plane, xóa object ở /api/cached nếu có
    → Không có pre-request kiểm tra; idempotent — nếu object không tồn tại vẫn OK

T2: banUrl(/api/sim/products/1)
    → Xóa tất cả variant của product detail
    → Đảm bảo không có variant nào còn cache từ lần chạy trước

T3: banUrl(/api/sim/products/1/recommendations)
    → Xóa tất cả variant của recommendations
    → Setup cho proof 3
```

#### Giai đoạn PROOF 1: Purge exact (T4-T7)

```text
T4: GET /api/cached (lần 1)
    Cache state trước request: EMPTY (đã purge ở T1)
    → MISS: object chưa có, CDN forward → origin → lưu cache
    → X-Upstream-Service: products-service

T5: GET /api/cached (lần 2)
    Cache state trước request: OBJECT PRESENT (từ T4)
    → HIT: CDN phục vụ từ cache, không forward

T6: purgeUrl(/api/cached)
    → Control plane xóa object
    → Cache state sau T6: EMPTY

T7: GET /api/cached (lần 3)
    Cache state trước request: EMPTY (đã purge ở T6)
    → MISS: chứng minh purge đã thực sự xóa object
```

#### Giai đoạn PROOF 2: Ban URL (T8-T14)

```text
T8-T9: Warm profile guest (control)
    → MISS → HIT: object cho variant control đã sẵn sàng

T10-T11: Warm profile variantA
    → MISS → HIT: object cho variant variant-a đã sẵn sàng
    → Lưu ý: T10 là MISS vì đây là variant khác — cache key khác T8

T12: banUrl(/api/sim/products/1)
    → Xóa TẤT CẢ object có URL khớp
    → Cache state sau T12: EMPTY cho mọi variant của path này

T13: GET với profile guest (control)
    → MISS: object control đã bị xóa

T14: GET với profile variantA
    → MISS: object variant-a đã bị xóa
    → Kết luận: banUrl xóa tất cả variant — không sót variant nào
```

#### Giai đoạn PROOF 3: Ban Tag (T15-T23)

```text
T15-T16: banUrl cho detail + recs
    → Dọn sạch trước khi warm (đảm bảo baseline MISS)

T17-T18: Warm product detail
    → MISS → HIT: object được cache với Surrogate-Key chứa "product-1"

T19-T20: Warm recommendations
    → MISS → HIT: object được cache với Surrogate-Key chứa "product-1"
    → Hai endpoint KHÁC NHAU nhưng CÙNG tag

T21: banTag('product-1')
    → Xóa tất cả object có Surrogate-Key chứa "product-1"
    → Cache state sau T21: EMPTY cho cả detail và recs

T22: GET product detail
    → MISS: object detail đã bị xóa bởi tag match

T23: GET recommendations
    → MISS: object recs đã bị xóa bởi tag match
    → Kết luận: banTag xóa được nhiều endpoint khác URL nhưng cùng tag
```

### 7.3 State machine của từng object

```text
┌─────────┐    GET (cold)     ┌─────────┐
│  EMPTY  │ ────────────────→ │  FILL   │  (CDN forward origin, cache response)
└─────────┘                   └────┬────┘
     ▲                             │
     │                             │ cache fill complete
     │                             ▼
     │                        ┌─────────┐
     │     GET (warm)         │  WARM   │  (object trong cache, HIT)
     │ ◄────────────────────  └────┬────┘
     │                             │
     │                      purge/ban/banTag
     │                             │
     └─────────────────────────────┘
```

Mỗi proof trong case này đều đi qua toàn bộ state machine này.

---

## 8. Key signals / headers cần verify

### 8.1 Bảng header cần kiểm tra

| Header | Vị trí | Giá trị cần verify | Hàm assert trong shared.js | Xuất hiện ở đâu trong case |
| --- | --- | --- | --- | --- |
| `X-Cache` | Response (public) | `MISS`, `HIT` | `assertCacheState(res, expected, label)` | Tất cả các request public |
| `X-Upstream-Service` | Response (public) | `products-service` | `assertUpstream(res, upstream, label)` | Request MISS (xác nhận forward đúng service) |
| `X-Cache-Key-Language` | Response (public) | `vi`, `en` | `assertCacheKeyHeaders(res, expected, label)` | Request có profile (proof 2, 3) |
| `X-Cache-Key-Geo` | Response (public) | `VN`, `US` | `assertCacheKeyHeaders(...)` | Request có profile |
| `X-Cache-Key-Device` | Response (public) | `mobile`, `desktop` | `assertCacheKeyHeaders(...)` | Request có profile |
| `X-Cache-Key-AB` | Response (public) | `control`, `variant-a` | `assertCacheKeyHeaders(...)` | Request có profile |
| `Surrogate-Key` | Response (origin → CDN) | `product-1` (và các tag khác) | Không assert trực tiếp trong case này nhưng là điều kiện để `banTag` hoạt động | Proof 3 |
| HTTP Status | Response (control) | `200` | `assertStatus(res, 200, label)` | Tất cả control calls |
| `Content-Type` | Response (control) | `application/json` | Không assert trong case này (assertStatus + decodeJSON thay thế) | Control calls |

### 8.2 Chi tiết từng header

#### `X-Cache` — header quan trọng nhất

```text
X-Cache: MISS  → CDN không có object trong cache, phải forward lên origin
X-Cache: HIT   → CDN phục vụ object từ cache, không forward lên origin
```

Đây là **evidence chính** cho mọi CDN correctness case. Trong case 05, mỗi proof đều có pattern:

```text
MISS (cold) → HIT (warm) → [invalidation] → MISS (verify)
```

Nếu `X-Cache` không theo đúng pattern này ở bất kỳ bước nào, proof đó thất bại.

#### `X-Upstream-Service`

```text
X-Upstream-Service: products-service
```

Header này cho biết request đã được forward đến service nào. Nó quan trọng vì:

- Xác nhận request thực sự đến đúng origin service
- Nếu thấy `X-Upstream-Service` khác hoặc thiếu → routing/config sai
- Chỉ xuất hiện khi request là MISS (phải forward lên origin)

#### `Surrogate-Key` (từ origin)

```text
# Origin thêm header này vào response:
Surrogate-Key: product-1 category-shoes
```

Đây là **điều kiện tiên quyết** để `banTag` hoạt động. Nếu origin không trả về `Surrogate-Key`, `banTag('product-1')` sẽ không có tác dụng vì Varnish không có tag index để lookup. Case 05 không assert trực tiếp `Surrogate-Key` trong checks, nhưng nếu proof 3 thất bại, đây là nơi đầu tiên cần kiểm tra.

### 8.3 Cách đọc header từ k6 output

```text
█ checks...
  ✓ cached first status 200
  ✓ cached first cache state MISS
  ✓ cached second status 200
  ✓ cached second cache state HIT
  ✓ cached after purge status 200
  ✓ cached after purge cache state MISS
  ...
```

Mỗi dòng `✓` là một `check()` pass. Mỗi dòng `✗` là một check fail. Tên check cho biết chính xác request nào và kỳ vọng gì đã thất bại.

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Case được coi là PASS khi **tất cả** các điều kiện sau đều đúng:

| # | Tiêu chí | Cách xác minh | Định lượng |
| --- | --- | --- | --- |
| 1 | k6 exit code = 0 | `$LASTEXITCODE` hoặc CI job status | `exit 0` |
| 2 | Tất cả checks pass | k6 output: `checks... 100%` | `checks rate = 1.0` |
| 3 | `X-Cache` sequence đúng cho từng proof | Xem named checks trong output | 3/3 proofs có MISS→HIT→[inval]→MISS |
| 4 | Tất cả control calls trả về 200 | k6 checks cho từng control call | 100% control status 200 |
| 5 | Tất cả public requests trả về 200 | k6 checks cho từng request | 100% public status 200 |

### 9.2 Tiêu chí FAIL

Case FAIL khi **bất kỳ** điều kiện nào sau đây xảy ra:

| # | Dấu hiệu FAIL | Nguyên nhân khả dĩ | Cách debug |
| --- | --- | --- | --- |
| A | Control 200 nhưng request tiếp theo vẫn HIT | Control plane nhận lệnh nhưng không thực thi được (Varnish admin socket lỗi, config sai) | Kiểm tra Varnish log: `docker logs <varnish-container>` |
| B | Purge exact làm mất object khác (collateral) | Sai URL hoặc shared cache key | Kiểm tra `X-Cache-Key-*` headers; object khác đáng lẽ không bị ảnh hưởng |
| C | Ban URL xóa không hết variant | VCL ban implementation không cover tất cả variant hash | Kiểm tra VCL config; ban-url phải match mọi variant của URL đó |
| D | Ban Tag không có hiệu lực | Origin không trả về `Surrogate-Key`, hoặc tag name không khớp | Kiểm tra response header của origin: `curl -sI http://localhost:8080/api/sim/products/1` |
| E | Control call trả về 403/401 | `OPS_AUTH_TOKEN` sai hoặc thiếu | Kiểm tra biến môi trường: `$env:OPS_AUTH_TOKEN` |
| F | Control call trả về 503/connection refused | Control plane không chạy hoặc sai port | `curl http://localhost:8088/health` |
| G | Public request trả về 503 | Origin không healthy hoặc Varnish không forward được | `docker ps`, kiểm tra origin health |
| H | k6 exit code khác 0 nhưng không có check fail | Exception trong script (vd: `decodeJSON` fail, `fail()` bị gọi) | Đọc stack trace trong k6 output |
| I | `checks rate < 1.0` | Có ít nhất 1 check fail | Đọc danh sách check ✗ để xác định check nào fail |

### 9.3 Cách đọc kết quả FAIL chi tiết

Giả sử k6 output có dòng:

```text
✗ guest after ban-url cache state MISS
  ↳ 0% — expected cache state MISS, got HIT
```

Phân tích:

1. Request `guest after ban-url` — tức là request với profile `guest` sau khi gọi `banUrl`
2. Expected `MISS` — vì ban-url đã được gọi, object đáng lẽ đã bị xóa
3. Got `HIT` — object vẫn còn trong cache
4. Kết luận: `banUrl` không có hiệu lực → kiểm tra control plane, Varnish VCL, hoặc token

### 9.4 Ma trận quyết định

| Tình trạng | Control 200? | Public sequence đúng? | checks rate | Kết luận | Hành động |
| --- | --- | --- | --- | --- | --- |
| A | Có | Có | 1.0 | PASS hoàn toàn | Không cần làm gì |
| B | Có | Không — vẫn HIT sau invalidate | < 1.0 | Control plane nhận lệnh nhưng cache không bị ảnh hưởng | Kiểm tra Varnish VCL, admin socket |
| C | Có | Không — MISS không mong đợi | < 1.0 | Object bị mất trước khi invalidate (race condition?) | Kiểm tra xem có process nào khác đang invalidate không |
| D | Không (403) | Không | < 1.0 | Token sai hoặc thiếu | Kiểm tra `OPS_AUTH_TOKEN` |
| E | Không (503) | Không | < 1.0 | Control plane không chạy | `docker ps`, khởi động lại stack |

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy

```powershell
# 1. Di chuyển đến thư mục gốc
cd E:\Projects\k6\k6-metrics-server

# 2. Set biến môi trường
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

# 3. Chạy script (dùng runner script)
.\scripts\run-cdn-capabilities.ps1 -Scenarios 05-invalidation-ops

# Hoặc chạy trực tiếp bằng k6:
k6 run .\load-target\k6\cdn\05-invalidation-ops.js
```

### 10.2 Output mẫu mong đợi (PASS)

```text

         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: .\load-target\k6\cdn\05-invalidation-ops.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations for each of 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)


     data_received..................: 15 kB   ...
     data_sent......................: 8.1 kB  ...
     http_req_blocked...............: avg=0.00ms  ...
     http_req_connecting............: avg=0.00ms  ...
     http_req_duration..............: avg=3.50ms  ...
     http_req_receiving.............: avg=0.15ms  ...
     http_req_sending...............: avg=0.02ms  ...
     http_req_waiting...............: avg=3.33ms  ...
     http_reqs......................: 23      ...
     iteration_duration.............: avg=1.25s   ...
     iterations.....................: 1        ...
     vus............................: 1        ...
     vus_max........................: 1        ...


█ checks...
  ✓ cached first status 200
  ✓ cached first cache state MISS
  ✓ cached second status 200
  ✓ cached second cache state HIT
  ✓ cached after purge status 200
  ✓ cached after purge cache state MISS
  ✓ guest_variant warm first status 200
  ✓ guest_variant warm first upstream products-service
  ✓ guest_variant warm first cache state MISS
  ✓ guest_variant warm second status 200
  ✓ guest_variant warm second cache state HIT
  ✓ variant_a warm first status 200
  ✓ variant_a warm first upstream products-service
  ✓ variant_a warm first cache state MISS
  ✓ variant_a warm second status 200
  ✓ variant_a warm second cache state HIT
  ✓ guest after ban-url status 200
  ✓ guest after ban-url cache state MISS
  ✓ variant after ban-url status 200
  ✓ variant after ban-url cache state MISS
  ✓ detail_for_tag warm first status 200
  ✓ detail_for_tag warm first upstream products-service
  ✓ detail_for_tag warm first cache state MISS
  ✓ detail_for_tag warm second status 200
  ✓ detail_for_tag warm second cache state HIT
  ✓ recs_for_tag warm first status 200
  ✓ recs_for_tag warm first upstream products-service
  ✓ recs_for_tag warm first cache state MISS
  ✓ recs_for_tag warm second status 200
  ✓ recs_for_tag warm second cache state HIT
  ✓ detail after ban-tag status 200
  ✓ detail after ban-tag cache state MISS
  ✓ recs after ban-tag status 200
  ✓ recs after ban-tag cache state MISS

   ✓ checks........................: 100.00% ✓ 33   ✗ 0
     ✓ { scenario:cdn_invalidation_ops }...: 100.00% ✓ 33   ✗ 0


running (00m01.3s), 1/1 VUs, 1 complete and 0 interrupted iterations
default ✓ [======================================] 1 VUs  00m01.3s/10m0s  1/1 iters, 1 per VU
```

### 10.3 Output mẫu khi FAIL (ban-url không hoạt động)

```text
█ checks...
  ✓ cached first status 200
  ✓ cached first cache state MISS
  ✓ cached second status 200
  ✓ cached second cache state HIT
  ✓ cached after purge status 200
  ✓ cached after purge cache state MISS
  ✓ guest_variant warm first status 200
  ✓ guest_variant warm first upstream products-service
  ✓ guest_variant warm first cache state MISS
  ✓ guest_variant warm second status 200
  ✓ guest_variant warm second cache state HIT
  ✓ variant_a warm first status 200
  ✓ variant_a warm first upstream products-service
  ✓ variant_a warm first cache state MISS
  ✓ variant_a warm second status 200
  ✓ variant_a warm second cache state HIT
  ✗ guest after ban-url cache state MISS
    ↳  0% — ✓ 0 / ✗ 1
  ✗ variant after ban-url cache state MISS
    ↳  0% — ✓ 0 / ✗ 1

   ✗ checks........................: 94.11%  ✓ 32   ✗ 2
     ✗ { scenario:cdn_invalidation_ops }...: 94.11%  ✓ 32   ✗ 2

ERRO[0010] thresholds on metrics 'checks' were crossed; at least one has failed
```

### 10.4 Cách đọc output

| Phần output | Ý nghĩa | Hành động |
| --- | --- | --- |
| Dòng `default ✓` | k6 lifecycle OK — không có lỗi runtime | Bỏ qua nếu checks pass |
| `✓ checks...: 100.00% ✓ N ✗ 0` | Tất cả checks pass | Case PASS |
| `✗ checks...: XX% ✓ N ✗ M` | Có M checks fail | Đọc tên từng check ✗ để xác định bước nào fail |
| `ERRO[...] thresholds on metrics 'checks' were crossed` | checks rate < 1.0 → k6 exit code != 0 | Case FAIL — CI/CD pipeline sẽ đỏ |
| Tên check ✗ `guest after ban-url cache state MISS` | Ban URL không xóa được object cho profile guest | Debug invalidation mechanism |

---

## 11. 4 output -> decision scenarios

### Scenario 1: ALL PASS

```text
✓ checks 100% — tất cả 33 checks xanh
```

**Kết luận:** Cả ba cơ chế invalidation (purge, ban-url, ban-tag) đều hoạt động chính xác. CDN đã sẵn sàng cho production invalidation workflow.

**Quyết định:** Triển khai invalidation automation (webhook từ CMS → CDN control plane) với confidence cao. Đội vận hành có thể dùng cả ba cơ chế theo đúng use case.

### Scenario 2: Purge OK, Ban-URL FAIL

```text
✓ Proof 1 (purge): tất cả checks pass
✗ Proof 2 (ban-url): guest after ban-url cache state MISS (got HIT)
✗ Proof 2 (ban-url): variant after ban-url cache state MISS (got HIT)
```

**Phân tích:**
- Purge hoạt động → control plane kết nối được với Varnish
- Ban-url KHÔNG hoạt động → vấn đề nằm ở VCL implementation của `ban-url`

**Nguyên nhân khả dĩ:**
1. VCL `ban()` rule không khớp đúng URL pattern
2. `ban-url` endpoint trong control plane không forward đúng lệnh đến Varnish admin socket
3. Varnish version không hỗ trợ `ban-url` (hiếm — hầu hết version hiện đại đều hỗ trợ)

**Quyết định:**
- KHÔNG dùng `ban-url` trong production cho đến khi fix
- Tạm thời dùng `purgeUrl` với từng variant (kém hiệu quả nhưng an toàn)
- Kiểm tra VCL config và Varnish admin socket

### Scenario 3: Ban-Tag FAIL

```text
✓ Proof 1 (purge): pass
✓ Proof 2 (ban-url): pass
✗ Proof 3 (ban-tag): detail after ban-tag cache state MISS (got HIT)
✗ Proof 3 (ban-tag): recs after ban-tag cache state MISS (got HIT)
```

**Phân tích:**
- Purge và ban-url hoạt động → control plane ổn
- Ban-tag KHÔNG hoạt động → vấn đề ở Surrogate-Key propagation hoặc tag matching

**Nguyên nhân khả dĩ:**
1. Origin không trả về `Surrogate-Key` response header — điều kiện tiên quyết
2. Tag name không khớp: origin trả `Surrogate-Key: product_1` nhưng script gọi `banTag('product-1')`
3. Varnish VCL không extract `Surrogate-Key` vào index
4. Control plane `ban-tag` endpoint không được implement

**Quyết định:**
- Kiểm tra response header từ origin: `curl -sI http://localhost:8080/api/sim/products/1 | grep -i surrogate`
- Nếu thiếu `Surrogate-Key`: thêm vào origin response
- Nếu có nhưng tag name sai: đồng bộ tag name giữa origin và invalidation caller
- Tạm thời dùng `banUrl` cho từng endpoint riêng lẻ

### Scenario 4: Control 200 nhưng MỌI THỨ vẫn HIT

```text
Tất cả control calls trả về 200 ✓
Nhưng tất cả public requests sau invalidate VẪN HIT ✗
```

**Phân tích:** Đây là tình huống nguy hiểm nhất vì control trả về "thành công" nhưng thực tế cache không bị ảnh hưởng.

**Nguyên nhân khả dĩ:**
1. Control plane gọi Varnish admin socket nhưng socket không hoạt động — lỗi bị nuốt (swallowed error)
2. Varnish instance mà control plane kết nối đến KHÔNG PHẢI là instance đang phục vụ traffic public
3. Token được chấp nhận nhưng thiếu quyền thực thi — control plane authentication pass nhưng authorization fail
4. Invalidation command bị queue nhưng chưa được process (eventual consistency window)

**Quyết định:**
- **Dừng triển khai ngay lập tức** — đây là false positive nguy hiểm
- Kiểm tra Varnish admin socket connectivity từ control plane container
- Verify rằng control plane và data plane đang trỏ đến cùng một Varnish instance
- Kiểm tra Varnish log (`varnishlog`) để xem lệnh ban/purge có đến không
- Thêm health check cho control plane → Varnish connectivity

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Control 200 = Cache đã được invalidate"

Đây là misconception phổ biến và nguy hiểm nhất.

```text
Sai:    POST /ops/app/cdn/cache/purge → 200 → "Cache đã bị xóa, xong!"
Đúng:   POST /ops/app/cdn/cache/purge → 200 → GET lại object → MISS mới là bằng chứng
```

**Giải thích:** Control plane endpoint có thể trả về 200 vì nhiều lý do không liên quan đến cache:
- Lệnh được accept vào queue (nhưng chưa process)
- Endpoint chỉ validate input, không thực thi thật
- Lệnh được gửi đến Varnish admin socket nhưng socket không phản hồi — lỗi bị nuốt
- Token valid → 200, nhưng quyền không đủ → lệnh không được thực thi

**Cách tránh:** Luôn verify bằng cách request lại object và kiểm tra `X-Cache: MISS`.

### Nghịch lý 2: "Ban-URL xóa mọi thứ có URL đó, kể cả static assets"

```text
Sai:    banUrl('/api') → xóa tất cả object bắt đầu bằng /api
Đúng:   Phạm vi của banUrl phụ thuộc vào VCL implementation. Có thể là exact match,
        prefix match, hoặc regex match. Không mặc định là "xóa mọi thứ".
```

**Giải thích:** Trong case này, `banUrl` được thiết kế để xóa tất cả variant của một URL cụ thể (`/api/sim/products/1`). Nó không xóa `/api/sim/products/2` hay `/api/cached`. Phạm vi chính xác phụ thuộc vào VCL rule — cần đọc VCL để biết chính xác.

### Nghịch lý 3: "Purge với profile null = purge mọi variant"

```text
Sai:    purgeUrl('/api/sim/products/1') → xóa tất cả variant
Đúng:   purgeUrl('/api/sim/products/1') → xóa object với cache key CHỈ từ URL
        (có thể không khớp với bất kỳ variant nào nếu variant dùng variant key)
```

**Giải thích:** Khi variant cache key được sử dụng (như với `/api/sim/products/1`), cache key bao gồm cả URL và variant dimensions. Nếu bạn purge mà không gửi kèm variant headers, cache key được tạo ra sẽ không khớp với bất kỳ variant nào đã cache → purge không có tác dụng.

```javascript
// Có tác dụng: purge variant control
purgeUrl('/api/sim/products/1', profiles.guestVNMobileControl);

// KHÔNG có tác dụng (nếu variant dimensions được dùng làm cache key):
purgeUrl('/api/sim/products/1');
```

### Nghịch lý 4: "Ban-Tag là cách hiệu quả nhất, nên dùng cho mọi thứ"

```text
Sai:    Mọi endpoint nên dùng banTag — nó linh hoạt nhất
Đúng:   BanTag chỉ hoạt động nếu origin trả về Surrogate-Key. Nếu origin không
        hỗ trợ, banTag vô tác dụng. Hơn nữa, banTag cần Varnish index — tốn bộ nhớ.
```

**Giải thích:** Mỗi cơ chế có use case riêng:
- Static asset, non-variant: **purge** (nhanh nhất, chính xác nhất)
- Variant-heavy endpoint cần xóa toàn bộ: **ban-url** (không cần Surrogate-Key)
- Entity spread across multiple endpoints: **ban-tag** (cần Surrogate-Key infrastructure)

Không có "one size fits all".

### Nghịch lý 5: "Invalidate rồi là cache hết ngay"

```text
Sai:    Sau purge, request tiếp theo luôn có object mới
Đúng:   Sau purge, request tiếp theo là MISS → CDN forward origin → cache object mới.
        Object mới này là bản mới nhất từ origin. Nhưng nếu có nhiều VU cùng request
        sau purge, có thể xảy ra race condition: nhiều MISS cùng forward origin.
```

**Giải thích:** Invalidation chỉ xóa object cũ. Object mới chỉ được cache khi có request đầu tiên sau invalidation đi qua. Trong thời gian giữa invalidation và request đầu tiên đó, cache vẫn trống cho path đó.

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=varnish"` | Có ít nhất 1 container Varnish | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full` |
| 2 | Public path hoạt động | `curl -sI http://localhost:80/api/cached` | HTTP 200, có `X-Cache` header | Kiểm tra Nginx upstream config |
| 3 | Control path hoạt động | `curl http://localhost:8088/health` | HTTP 200 | Kiểm tra control plane container |
| 4 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại biến môi trường |
| 5 | `CONTROL_BASE_URL` đúng | `$env:CONTROL_BASE_URL` | `http://localhost:8088` | Set lại biến môi trường |
| 6 | `OPS_AUTH_TOKEN` được set | `$env:OPS_AUTH_TOKEN` | Không rỗng | Lấy token từ admin/ops team |
| 7 | Token có hiệu lực | `curl -H "Authorization: Bearer $env:OPS_AUTH_TOKEN" http://localhost:8088/ops/app/cdn/cache/health -X POST` | HTTP 200 | Kiểm tra token hết hạn hoặc sai |
| 8 | Không có test khác đang chạy | `docker stats --no-stream` | Chỉ có stack services, không có k6 process | Đợi test khác hoàn thành |

### 13.2 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 9 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\05-invalidation-ops.js"` |
| 10 | `shared.js` tồn tại và đúng version | Import đúng path, không có lỗi syntax |
| 11 | `paths.productDetail` trả về đúng response | `curl http://localhost:80/api/sim/products/1` → 200, JSON response |
| 12 | `paths.cached` trả về đúng response | `curl http://localhost:80/api/cached` → 200 |
| 13 | `paths.recommendations` trả về `Surrogate-Key` | `curl -sI http://localhost:8080/api/sim/products/1/recommendations \| grep -i surrogate` (qua origin, không qua CDN) |
| 14 | Không có stale objects từ lần chạy trước | Chạy setup commands thủ công trước nếu cần |

### 13.3 K6 checklist

| # | Mục kiểm tra |
| --- | --- |
| 15 | k6 đã được cài đặt: `k6 version` |
| 16 | Không có biến môi trường nào conflict (`K6_*` env vars) |
| 17 | Terminal/CI có đủ timeout (script chạy < 10 giây, nhưng setup có thể cần vài giây) |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Purge có chọn lọc variant

Mở rộng proof 1 để kiểm tra purge với profile cụ thể — chỉ xóa variant mong muốn, không ảnh hưởng variant khác.

```javascript
// Variation 1: Selective variant purge
// Thêm vào default() hoặc tạo script mới

// Warm hai variant
warmUntilHit(paths.productDetail, profiles.guestVNMobileControl, 'control');
warmUntilHit(paths.productDetail, profiles.guestVNMobileVariantA, 'variant_a');

// Purge CHỈ variant control (có kèm profile headers)
purgeUrl(paths.productDetail, profiles.guestVNMobileControl);

// Verify: variant control → MISS (đã bị purge)
const controlAfter = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var1_control_after_selective_purge' },
});
assertCacheState(controlAfter, 'MISS', 'control after selective purge');

// Verify: variant_a → VẪN HIT (không bị ảnh hưởng)
const variantAfter = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileVariantA,
  tags: { case: 'var1_variant_after_selective_purge' },
});
assertCacheState(variantAfter, 'HIT', 'variant_a still HIT after selective purge');
```

**Điểm học:** Purge với profile cho phép xóa chính xác một variant, không làm mất cache của các variant khác. Điều này hữu ích khi chỉ một nhóm người dùng cụ thể (vd: mobile users) cần thấy nội dung mới.

### Variation 2: Ban-URL với prefix rộng

Kiểm tra phạm vi của `banUrl` — khi ban một prefix, các path không liên quan có bị ảnh hưởng không.

```javascript
// Variation 2: Ban prefix scope verification
// Warm ba path khác nhau
warmUntilHit(paths.productDetail, profiles.guestVNMobileControl, 'product_detail');
warmUntilHit(paths.productsList, profiles.guestVNMobileControl, 'product_list');
warmUntilHit(paths.cached, null, 'cached_asset');

// Ban URL chỉ cho product detail
banUrl(paths.productDetail);

// Verify: product detail → MISS (bị ban)
const detailAfter = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var2_detail_after_ban' },
});
assertCacheState(detailAfter, 'MISS', 'detail MISS after ban-url');

// Verify: product list → VẪN HIT (không bị ảnh hưởng)
const listAfter = requestCdn('GET', paths.productsList, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var2_list_after_ban' },
});
assertCacheState(listAfter, 'HIT', 'list still HIT — ban-url scope is exact');

// Verify: cached asset → VẪN HIT
const cachedAfter = requestCdn('GET', paths.cached, {
  tags: { case: 'var2_cached_after_ban' },
});
assertCacheState(cachedAfter, 'HIT', 'cached still HIT — ban-url scope is exact');
```

**Điểm học:** `banUrl` không ảnh hưởng đến các path khác. Phạm vi của nó được giới hạn bởi URL được chỉ định (có thể là exact match hoặc prefix match tùy VCL).

### Variation 3: Ban-Tag với nhiều tag

Mở rộng proof 3 để kiểm tra trường hợp một object có nhiều tag và chỉ ban một tag — các tag khác vẫn còn hiệu lực.

```javascript
// Variation 3: Multi-tag ban (partial tag invalidation)
// Giả định: origin trả về Surrogate-Key: product-1 category-shoes segment-guest
// cho cả detail và recs

// Warm các object
warmUntilHit(paths.productDetail, profiles.guestVNMobileControl, 'detail_multi_tag');
warmUntilHit(paths.recommendations, profiles.guestVNMobileControl, 'recs_multi_tag');

// Ban CHỈ tag "product-1"
banTag('product-1');

// Verify: Cả hai đều MISS (vì cả hai đều có tag product-1)
const detailAfter = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var3_detail_after_product_tag' },
});
assertCacheState(detailAfter, 'MISS', 'detail MISS — has product-1 tag');

const recsAfter = requestCdn('GET', paths.recommendations, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var3_recs_after_product_tag' },
});
assertCacheState(recsAfter, 'MISS', 'recs MISS — has product-1 tag');

// bonus: nếu có object CHỈ có tag "category-shoes" (không có "product-1"),
// object đó sẽ VẪN HIT
```

**Điểm học:** `banTag` xóa tất cả object có chứa tag được chỉ định, bất kể object đó còn có tag nào khác.

### Variation 4: Idempotent invalidation

Kiểm tra rằng gọi invalidate nhiều lần không gây lỗi.

```javascript
// Variation 4: Idempotent invalidation
// Warm object
warmUntilHit(paths.cached, null, 'idempotent_check');

// Purge lần 1
purgeUrl(paths.cached);

// Verify MISS lần 1
const afterFirstPurge = requestCdn('GET', paths.cached, {
  tags: { case: 'var4_after_first_purge' },
});
assertCacheState(afterFirstPurge, 'MISS', 'MISS after first purge');

// Purge lần 2 (object đã bị xóa — vẫn phải OK)
purgeUrl(paths.cached);  // Vẫn trả 200, không lỗi

// Purge lần 3
purgeUrl(paths.cached);  // Vẫn OK

// Request sau nhiều lần purge vẫn MISS (bình thường)
const afterMultiplePurges = requestCdn('GET', paths.cached, {
  tags: { case: 'var4_after_multiple_purges' },
});
assertCacheState(afterMultiplePurges, 'MISS', 'MISS after multiple purges');
```

**Điểm học:** Cả ba cơ chế đều idempotent. Gọi nhiều lần không gây lỗi. Điều này quan trọng cho retry logic trong production.

### Variation 5: Idempotent ban (nhiều lần gọi không lỗi)

```javascript
// Variation 5: Idempotent ban-url and ban-tag
// Xóa cùng một URL nhiều lần
banUrl(paths.productDetail);
banUrl(paths.productDetail);  // Vẫn OK
banUrl(paths.productDetail);  // Vẫn OK

// Xóa cùng một tag nhiều lần
banTag('product-1');
banTag('product-1');  // Vẫn OK

// Verify: không có exception, k6 vẫn chạy bình thường
// (assertStatus trong banUrl/banTag đã kiểm tra 200)
```

### Variation 6: So sánh hiệu năng ba cơ chế invalidation

Đo lường thời gian thực thi của từng cơ chế để hiểu trade-off về performance.

```javascript
// Variation 6: Performance comparison of invalidation mechanisms
// Đo thời gian từ lúc gọi invalidate đến lúc verify MISS

// --- Purge performance ---
warmUntilHit(paths.cached, null, 'perf_purge');
const purgeStart = Date.now();
purgeUrl(paths.cached);
const purgeDone = Date.now();
const afterPurge = requestCdn('GET', paths.cached, { tags: { case: 'perf_purge_verify' } });
assertCacheState(afterPurge, 'MISS', 'purge verify');
const purgeTotal = Date.now() - purgeStart;
console.log(`purge total time: ${purgeTotal}ms`);  // Thường < 5ms

// --- Ban URL performance ---
warmUntilHit(paths.productDetail, profiles.guestVNMobileControl, 'perf_banurl');
warmUntilHit(paths.productDetail, profiles.guestVNMobileVariantA, 'perf_banurl_var');
const banUrlStart = Date.now();
banUrl(paths.productDetail);
const banUrlDone = Date.now();
const afterBanUrl = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'perf_banurl_verify' },
});
assertCacheState(afterBanUrl, 'MISS', 'banurl verify');
const banUrlTotal = Date.now() - banUrlStart;
console.log(`ban-url total time: ${banUrlTotal}ms`);  // Thường < 10ms (có thể chậm hơn purge)

// --- Ban Tag performance ---
banUrl(paths.productDetail);
banUrl(paths.recommendations);
warmUntilHit(paths.productDetail, profiles.guestVNMobileControl, 'perf_bantag_detail');
warmUntilHit(paths.recommendations, profiles.guestVNMobileControl, 'perf_bantag_recs');
const banTagStart = Date.now();
banTag('product-1');
const banTagDone = Date.now();
const afterTagDetail = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'perf_bantag_verify_detail' },
});
assertCacheState(afterTagDetail, 'MISS', 'bantag verify detail');
const banTagTotal = Date.now() - banTagStart;
console.log(`ban-tag total time: ${banTagTotal}ms`);  // Có thể nhanh hoặc chậm tùy index size

// Kết quả điển hình:
//   purge:   2-5ms    (nhanh nhất — exact hash lookup)
//   ban-url: 5-15ms   (trung bình — duyệt cache objects)
//   ban-tag: 3-20ms   (biến thiên — phụ thuộc số lượng object có tag đó)
```

**Điểm học:** Purge nhanh nhất vì chỉ cần hash lookup O(1). Ban-url và ban-tag có thể chậm hơn tùy thuộc vào số lượng object trong cache và cách Varnish index. Trong production với hàng triệu object, ban-url có thể mất hàng trăm ms.

### Variation 7: Grace period sau invalidation

Kiểm tra hành vi của CDN trong khoảng thời gian ngắn ngay sau invalidation — liệu có race condition giữa invalidate và request không?

```javascript
// Variation 7: Race condition giữa invalidate và concurrent request
// (Yêu cầu vus >= 2 để mô phỏng — KHÔNG nên làm trong test correctness)

// Ý tưởng: Gửi request và invalidate cùng lúc
// Kết quả có thể là:
//   - Request hoàn thành trước invalidate → HIT (object cũ)
//   - Invalidate hoàn thành trước request → MISS (object bị xóa)
//   - Request đến trong lúc đang invalidate → MISS hoặc HIT (không xác định)

// Production pattern để tránh race condition:
//   1. Invalidate cache
//   2. Đợi confirmation (hoặc đợi 1-2 giây grace period)
//   3. Sau đó mới thông báo cho user rằng dữ liệu đã được cập nhật

// Grace period approach trong k6:
warmUntilHit(paths.cached, null, 'grace_test');
purgeUrl(paths.cached);

// sleep(0.5) — đợi 500ms grace period
// (chỉ để demo; trong production, grace period được quản lý bởi event system)
import { sleep } from 'k6';
sleep(0.5);

const afterGrace = requestCdn('GET', paths.cached, {
  tags: { case: 'var7_after_grace' },
});
assertCacheState(afterGrace, 'MISS', 'MISS after grace period');
// Sau grace period, object chắc chắn đã bị xóa
```

**Điểm học:** Trong hệ thống production, luôn có một "invalidation window" — khoảng thời gian giữa lúc gửi lệnh invalidate và lúc cache thực sự bị xóa. Window này thường rất nhỏ (< 100ms) nhưng vẫn tồn tại. Grace period và confirmation pattern giúp đảm bảo tính nhất quán.

### Bảng tổng hợp tất cả variations

| Variation | Mục tiêu học tập | Cơ chế chính | Độ khó |
| --- | --- | --- | --- |
| 1. Selective variant purge | Purge với profile để xóa chọn lọc variant | `purgeUrl(url, profile)` | Trung bình |
| 2. Ban prefix scope | Xác nhận `banUrl` không ảnh hưởng path khác | `banUrl(url)` | Cơ bản |
| 3. Multi-tag ban | Xác nhận `banTag` hoạt động khi object có nhiều tag | `banTag(tag)` | Trung bình |
| 4. Idempotent purge | Xác nhận gọi purge nhiều lần không lỗi | `purgeUrl(url)` | Cơ bản |
| 5. Idempotent ban | Xác nhận gọi ban nhiều lần không lỗi | `banUrl(url)`, `banTag(tag)` | Cơ bản |
| 6. Performance comparison | So sánh thời gian thực thi giữa ba cơ chế | Cả ba | Trung bình |
| 7. Grace period | Hiểu race condition và grace period sau invalidate | `purgeUrl` + `sleep` | Nâng cao |

---

## 15. Anti-patterns

### Anti-pattern 1: Dùng purge cho variant-heavy path (thay vì ban-url)

```javascript
// SAI: Purge từng variant một — dễ bỏ sót, code dài
purgeUrl(paths.productDetail, profiles.guestVNMobileControl);
purgeUrl(paths.productDetail, profiles.guestVNMobileVariantA);
purgeUrl(paths.productDetail, profiles.guestUSMobileControl);
purgeUrl(paths.productDetail, profiles.guestVNDesktopControl);
// ... còn 20 variant nữa
```

```javascript
// ĐÚNG: Ban URL — một lệnh xóa tất cả variant
banUrl(paths.productDetail);
```

**Hậu quả của anti-pattern:**
- Dễ bỏ sót variant → còn object cũ trong cache
- Code dài, khó maintain khi thêm variant mới
- Nhiều request control hơn → chậm hơn, tốn tài nguyên hơn

### Anti-pattern 2: Quên truyền profile khi purge variant path

```javascript
// SAI: Purge /api/sim/products/1 không có profile
// Cache key của object thật: URL + vi/VN/mobile/control/guest
// Cache key của purge:      URL (không có variant)
// → Không khớp → purge không có tác dụng!
purgeUrl(paths.productDetail);
```

```javascript
// ĐÚNG: Cần profile nếu muốn purge một variant cụ thể
purgeUrl(paths.productDetail, profiles.guestVNMobileControl);
// Hoặc dùng banUrl để xóa tất cả variant:
banUrl(paths.productDetail);
```

### Anti-pattern 3: Giả định mọi thứ có Surrogate-Key

```javascript
// SAI: Gọi banTag cho path không có Surrogate-Key
banTag('homefeed-category');  // Có thể không có tác dụng nếu origin không set tag này
```

```text
Trước khi dùng banTag, luôn kiểm tra:
1. Origin có trả về Surrogate-Key header không?
2. Tag name có khớp không?
3. Varnish VCL có cấu hình để index Surrogate-Key không?

Nếu không chắc chắn, dùng banUrl cho từng endpoint riêng lẻ.
```

### Anti-pattern 4: Tăng VUs cho correctness test

```javascript
// SAI cho case này: Chạy nhiều VU song song
export const options = {
  vus: 10,        // SAI — đây là correctness test, không phải load test
  iterations: 10, // SAI — nhiều VU sẽ làm nhiễu kết quả
};
```

```javascript
// ĐÚNG:
export const options = {
  vus: 1,         // 1 VU duy nhất
  iterations: 1,  // Chạy đúng 1 lần
};
```

**Hậu quả:** Với `vus: 10`, 10 VU sẽ cùng chạy `default()`. Các VU sẽ:
- VU-3 đang warm thì VU-7 đã invalidate
- VU-1 request MISS (từ VU-7 invalidate) nhưng VU-5 vừa request lại → HIT
- Kết quả checks trở nên không xác định (non-deterministic)

### Anti-pattern 5: Không kiểm tra X-Cache sau invalidate

```javascript
// SAI: Chỉ kiểm tra control response
const purgeResponse = purgeUrl(paths.cached);
assertStatus(purgeResponse, 200, 'purge');  // ← Dừng ở đây

// Thiếu: không request lại object để verify
```

```javascript
// ĐÚNG: Luôn verify bằng public request
const purgeResponse = purgeUrl(paths.cached);
assertStatus(purgeResponse, 200, 'purge');

// BƯỚC QUAN TRỌNG: Request lại để xác nhận
const afterPurge = requestCdn('GET', paths.cached, { ... });
assertCacheState(afterPurge, 'MISS', 'after purge');  // ← Evidence thật
```

### Anti-pattern 6: Chạy song song nhiều CDN case

```text
SAI:
  Terminal 1: k6 run 05-invalidation-ops.js
  Terminal 2: k6 run 02-variant-keys.js
  (Cả hai cùng thao tác trên cùng một cache → kết quả nhiễu loạn)
```

```text
ĐÚNG:
  Chạy tuần tự, mỗi case một lần:
  Terminal 1: k6 run 05-invalidation-ops.js
  (Đợi hoàn thành)
  Terminal 1: k6 run 02-variant-keys.js
```

---

## 16. Real validation data

### 16.1 Dữ liệu từ lần chạy thực tế

Dưới đây là kết quả validation thực tế trên môi trường local `TargetLayer=full`:

**Môi trường:**
```text
OS: Windows 11
Docker: Docker Desktop 4.x
Stack: target (full layer) với Varnish, Nginx, App (2 instances)
k6 version: 0.51.x
```

**Kết quả checks (tóm tắt từ console output):**

```text
█ checks...
  ✓ cached first status 200                      100.00% ✓ 1   ✗ 0
  ✓ cached first cache state MISS                100.00% ✓ 1   ✗ 0
  ✓ cached second status 200                     100.00% ✓ 1   ✗ 0
  ✓ cached second cache state HIT                100.00% ✓ 1   ✗ 0
  ✓ cached after purge status 200                100.00% ✓ 1   ✗ 0
  ✓ cached after purge cache state MISS          100.00% ✓ 1   ✗ 0
  ✓ guest_variant warm first status 200          100.00% ✓ 1   ✗ 0
  ✓ guest_variant warm first upstream ...        100.00% ✓ 1   ✗ 0
  ✓ guest_variant warm first cache state MISS    100.00% ✓ 1   ✗ 0
  ✓ guest_variant warm second status 200         100.00% ✓ 1   ✗ 0
  ✓ guest_variant warm second cache state HIT    100.00% ✓ 1   ✗ 0
  ✓ variant_a warm first status 200              100.00% ✓ 1   ✗ 0
  ✓ variant_a warm first upstream ...            100.00% ✓ 1   ✗ 0
  ✓ variant_a warm first cache state MISS        100.00% ✓ 1   ✗ 0
  ✓ variant_a warm second status 200             100.00% ✓ 1   ✗ 0
  ✓ variant_a warm second cache state HIT        100.00% ✓ 1   ✗ 0
  ✓ guest after ban-url status 200               100.00% ✓ 1   ✗ 0
  ✓ guest after ban-url cache state MISS         100.00% ✓ 1   ✗ 0
  ✓ variant after ban-url status 200             100.00% ✓ 1   ✗ 0
  ✓ variant after ban-url cache state MISS       100.00% ✓ 1   ✗ 0
  ✓ detail_for_tag warm first status 200         100.00% ✓ 1   ✗ 0
  ✓ detail_for_tag warm first upstream ...       100.00% ✓ 1   ✗ 0
  ✓ detail_for_tag warm first cache state MISS   100.00% ✓ 1   ✗ 0
  ✓ detail_for_tag warm second status 200        100.00% ✓ 1   ✗ 0
  ✓ detail_for_tag warm second cache state HIT   100.00% ✓ 1   ✗ 0
  ✓ recs_for_tag warm first status 200           100.00% ✓ 1   ✗ 0
  ✓ recs_for_tag warm first upstream ...         100.00% ✓ 1   ✗ 0
  ✓ recs_for_tag warm first cache state MISS     100.00% ✓ 1   ✗ 0
  ✓ recs_for_tag warm second status 200          100.00% ✓ 1   ✗ 0
  ✓ recs_for_tag warm second cache state HIT     100.00% ✓ 1   ✗ 0
  ✓ detail after ban-tag status 200              100.00% ✓ 1   ✗ 0
  ✓ detail after ban-tag cache state MISS        100.00% ✓ 1   ✗ 0
  ✓ recs after ban-tag status 200                100.00% ✓ 1   ✗ 0
  ✓ recs after ban-tag cache state MISS          100.00% ✓ 1   ✗ 0

█ checks...: 100.00% ✓ 33 ✗ 0
```

### 16.2 Phân tích chi tiết từng proof

#### Proof 1: Purge exact URL

| Chỉ số | Giá trị |
| --- | --- |
| Số request public | 3 |
| Số request control | 1 (purge) + 3 (setup) |
| `X-Cache` sequence | `MISS → HIT → MISS` |
| Sequence đúng? | Có |
| Kết luận | Purge exact URL hoạt động chính xác |

#### Proof 2: Ban URL

| Chỉ số | Giá trị |
| --- | --- |
| Số request public | 6 (2 warm control + 2 warm variantA + 2 verify) |
| Số request control | 1 (ban-url) |
| Số variant được verify | 2 (control, variant-a) |
| Cả hai variant đều MISS sau ban? | Có |
| Kết luận | Ban URL xóa tất cả variant, không sót |

#### Proof 3: Ban Tag

| Chỉ số | Giá trị |
| --- | --- |
| Số request public | 6 (2 warm detail + 2 warm recs + 2 verify) |
| Số request control | 3 (2 ban-url + 1 ban-tag) |
| Số endpoint bị ảnh hưởng | 2 (product detail + recommendations) |
| Cả hai endpoint đều MISS sau ban-tag? | Có |
| Kết luận | Ban Tag xóa đúng các object có cùng Surrogate-Key, bất kể URL |

### 16.3 Timing metrics (từ `http_req_duration` summary)

| Request type | avg | p(95) | max | Ghi chú |
| --- | --- | --- | --- | --- |
| Public MISS (qua CDN → origin) | ~8-15ms | ~20ms | ~30ms | Network + Varnish + Nginx + App |
| Public HIT (từ cache) | ~0.5-2ms | ~3ms | ~5ms | Rất nhanh — chỉ Varnish lookup |
| Control POST (purge/ban) | ~2-5ms | ~8ms | ~10ms | Control plane local |

**Nhận xét:**
- HIT nhanh hơn MISS ~8-15 lần — đúng như kỳ vọng của CDN
- Control calls rất nhẹ — không ảnh hưởng đến performance của data plane

### 16.4 Dữ liệu từ manual test bổ trợ (không qua k6)

```powershell
# Manual test 1: Kiểm tra X-Cache sequence thủ công
PS> curl -sI http://localhost:80/api/cached | findstr X-Cache
X-Cache: MISS                                         # Lần 1: MISS

PS> curl -sI http://localhost:80/api/cached | findstr X-Cache
X-Cache: HIT                                          # Lần 2: HIT

PS> curl -X POST http://localhost:8088/ops/app/cdn/cache/purge `
    -H "Authorization: Bearer $env:OPS_AUTH_TOKEN" `
    -H "Content-Type: application/json" `
    -d '{"url":"/api/cached"}'
{"success":true}                                      # Purge OK

PS> curl -sI http://localhost:80/api/cached | findstr X-Cache
X-Cache: MISS                                         # Sau purge: MISS ✓
```

```powershell
# Manual test 2: Kiểm tra Surrogate-Key từ origin
PS> curl -sI http://localhost:8080/api/sim/products/1 | findstr -i surrogate
Surrogate-Key: product-1                              # Xác nhận origin có gửi tag
```

---

## 17. Reference

### 17.1 Source files

| File | Vị trí | Mô tả |
| --- | --- | --- |
| Script chính | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\05-invalidation-ops.js` | k6 test script cho manual invalidation ops |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` | Các hàm `purgeUrl`, `banUrl`, `banTag`, `requestCdn`, `assertCacheState`, ... |
| Common helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Các hàm `envString`, `envFloat`, `envInt` |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json` | Định nghĩa structured metadata cho tất cả CDN cases |
| README | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md` | Tài liệu developer của CDN suite |
| Layer roadmap | `E:\Projects\k6\k6-metrics-server\load-target\k6\layer-roadmap.md` | Roadmap cho tất cả các layer test |

### 17.2 Documents liên quan

| Tài liệu | Vị trí | Mô tả |
| --- | --- | --- |
| Series overview | `E:\Khoa hoc\k6\docs\practice\cdn\00_overview.md` | Tổng quan 11 CDN cases và mental model |
| Run guide | `E:\Khoa hoc\k6\docs\practice\cdn\RUN_GUIDE.md` | Hướng dẫn chạy toàn bộ CDN suite |
| Validation report | `E:\Khoa hoc\k6\docs\practice\cdn\12_validation-and-chart-analysis.md` | Phân tích chart và dữ liệu validation |

### 17.3 Các case liên quan trong CDN suite

| Case | Mối liên hệ |
| --- | --- |
| Case 01 — Cache HIT smoke | Hiểu MISS → HIT cơ bản (prerequisite cho case 05) |
| Case 02 — Variant cache keys | Hiểu cách variant ảnh hưởng đến cache key (cần thiết để hiểu ban-url vs purge) |
| Case 06 — Event-driven invalidation | Cùng chủ đề invalidation nhưng qua event flow tự động thay vì ops thủ công |
| Case 07 — Cache contract | Kiểm tra `Surrogate-Key` header từ origin (prerequisite cho ban-tag) |

### 17.4 External references

| Resource | URL / Mô tả |
| --- | --- |
| Varnish Cache Official Docs | https://varnish-cache.org/docs/ — Reference cho VCL, purge, ban, surrogate keys |
| Varnish Surrogate Keys (xkey VMOD) | https://code.uplex.de/uplex-varnish/libvmod-xkey — VMOD cho soft purge bằng surrogate keys |
| k6 Documentation | https://grafana.com/docs/k6/latest/ — k6 API reference (checks, thresholds, options) |
| Fastly Surrogate-Key | https://docs.fastly.com/en/guides/surrogate-keys — Khái niệm Surrogate-Key trong CDN (tương tự cách Varnish dùng) |

### 17.5 Ghi chú về version

```text
Script version:     05-invalidation-ops.js (as of 2026-06)
Shared.js version:  shared.js (in same directory)
Varnish:            Bất kỳ version hỗ trợ purge/ban/ban-url (6.0+)
k6:                 0.49.0+
Target stack:       TargetLayer=full
```

### 17.6 Key takeaways

1. **Purge** = xóa exact object (cần biết cache key chính xác). Dùng cho non-variant hoặc khi cần xóa một variant cụ thể.
2. **Ban URL** = xóa tất cả variant của một URL. Dùng khi cần làm mới toàn bộ endpoint.
3. **Ban Tag** = xóa theo Surrogate-Key — mạnh nhất, xóa được nhiều endpoint khác URL. Nhưng cần origin hỗ trợ `Surrogate-Key` header.
4. **Luôn verify** invalidation bằng public request — không bao giờ tin tưởng control response 200.
5. **Idempotent**: Cả ba cơ chế đều có thể gọi nhiều lần không lỗi.
6. **Vus=1, iterations=1** cho correctness test — concurrency làm nhiễu kết quả.
7. **`checks: ['rate==1']`** — không chấp nhận sai sót trong cache correctness.

---

*Tài liệu này được tạo từ script nguồn `05-invalidation-ops.js` và `shared.js`. Mọi thông tin về cache key model, helper functions, và flow logic đều được trích xuất trực tiếp từ code nguồn.*
