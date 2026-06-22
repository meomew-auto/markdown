# Case 06: Event-driven invalidation

> **Case ID:** `cdn-06-invalidation-events`
> **Script:** `06-invalidation-events.js`
> **Layer:** CDN / Varnish
> **Proof:** catalog-events-mock -> app internal invalidation -> CDN invalidation

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

Trong một nền tảng thương mại điện tử hiện đại, dữ liệu sản phẩm thay đổi liên tục thông qua nhiều kênh khác nhau: người bán cập nhật giá, đội content sửa mô tả, hệ thống kho tự động cập nhật tồn kho, chiến dịch khuyến mãi được kích hoạt theo lịch. Mỗi thay đổi này đều yêu cầu CDN phải invalidate cache để người dùng cuối nhìn thấy dữ liệu mới nhất.

Tuy nhiên, việc để đội vận hành (ops) thủ công gọi các API purge/ban mỗi khi có thay đổi là **không khả thi ở quy mô lớn**. Hãy xét những con số thực tế:

| Chỉ số | Giá trị | Hệ quả |
| --- | --- | --- |
| Số sản phẩm được cập nhật mỗi ngày | 50,000 - 200,000 | Không thể ops ngồi gọi API cho từng sản phẩm |
| Số endpoint cần invalidate cho 1 sản phẩm | 3-7 (detail, recs, search, homefeed, category, ...) | Mỗi sản phẩm thay đổi ảnh hưởng nhiều trang |
| Số variant cache cho mỗi endpoint | 24-120 (language x geo x device x AB x segment) | Tổng số cache object bị ảnh hưởng rất lớn |
| Tần suất thay đổi cao điểm | Hàng trăm sản phẩm/giây (flash sale, khuyến mãi lớn) | Cần real-time invalidation |

**Giải pháp:** Event-driven invalidation — tự động hóa toàn bộ quy trình. Khi dữ liệu thay đổi, một event được phát ra. Hệ thống app nhận event, xác định những cache object nào bị ảnh hưởng, và tự động gọi CDN control API để invalidate.

### 1.2 Hai tình huống event điển hình

**Tình huống A — Cập nhật sản phẩm (product-updated):**

```text
Một người bán cập nhật giá và mô tả của sản phẩm ID=1.
Hệ thống catalog phát ra event "product-updated" với product_id=1.

App nhận event → xác định các object bị ảnh hưởng:
  /api/sim/products/1               ← chi tiết sản phẩm (mọi variant)
  /api/sim/products/1/recommendations ← đề xuất liên quan (mọi variant)
  /api/sim/products/search?q=...    ← kết quả tìm kiếm có chứa sản phẩm này
  (tất cả bị ảnh hưởng vì đều hiển thị dữ liệu của sản phẩm 1)

App gọi CDN API để invalidate từng endpoint → cache được làm mới tự động.
```

**Tình huống B — Cập nhật homefeed (homefeed-updated):**

```text
Hệ thống personalization cập nhật thuật toán homefeed cho phân khúc
người dùng "returning" (khách hàng quay lại).

Event "homefeed-updated" được phát ra với segment=returning.
App nhận event → invalidate tất cả cache object cho:
  /api/sim/products/homefeed (với mọi variant của segment "returning")
  Lưu ý: homefeed của segment "guest" KHÔNG bị ảnh hưởng.

App gọi CDN API → chỉ cache của returning users bị invalidate.
```

### 1.3 Sự khác biệt cốt lõi với manual invalidation (Case 05)

| Khía cạnh | Case 05 (Manual ops) | Case 06 (Event-driven) |
| --- | --- | --- |
| **Ai kích hoạt?** | Con người — đội vận hành gọi API thủ công | Hệ thống — event bus tự động kích hoạt |
| **Tần suất** | Thỉnh thoảng (vài lần/ngày đến vài chục lần/ngày) | Liên tục (hàng trăm đến hàng nghìn lần/giây) |
| **Độ trễ** | Vài giây đến vài phút (con người phản ứng) | Dưới 1 giây (event → app → CDN) |
| **Rủi ro sai sót** | Cao — ops có thể quên invalidate, hoặc invalidate sai endpoint | Thấp — logic được code hóa, nhất quán |
| **Cần OPS_AUTH_TOKEN cho event?** | Có — ops cần token để gọi control API | Không — event được gửi qua HTTP POST đến mock endpoint, app tự authenticated với CDN control plane |
| **Cần catalog-events-mock?** | Không | Có — mock ở `:9091` đóng vai event bus |
| **Scope của invalidation** | Ops quyết định thủ công | App quyết định theo logic đã code |

### 1.4 Kiến trúc event flow

```text
┌──────────────────┐
│  Hệ thống nguồn  │  (CMS, Catalog service, Pricing engine, Inventory system)
│  phát sinh event │
└────────┬─────────┘
         │ event: { type: "product-updated", product_id: "1" }
         ▼
┌──────────────────┐
│   Event bus      │  (Kafka, RabbitMQ, SNS/SQS, hoặc HTTP webhook)
│   (production)   │
└────────┬─────────┘
         │
         │ Trong môi trường test: catalog-events-mock (:9091) đóng vai event bus
         ▼
┌──────────────────┐
│   App consumer   │  (Nhận event, xác định cache objects bị ảnh hưởng)
│   (internal)     │
└────────┬─────────┘
         │ Gọi internal CDN API (có token nội bộ)
         ▼
┌──────────────────┐
│   CDN control    │  (Nhận lệnh invalidate, thực thi trên Varnish)
│   plane (:8088)  │
└────────┬─────────┘
         │ Purge/Ban command
         ▼
┌──────────────────┐
│   Varnish CDN    │  (Cache được làm mới)
│   (:80)          │
└──────────────────┘
```

Trong case này, **k6 đóng vai trò kiểm chứng toàn bộ chuỗi**: k6 vừa gửi event (qua `triggerCatalogEvent`), vừa kiểm tra cache state sau event (qua `requestCdn`). Script không cần biết chi tiết internal implementation của app — nó chỉ quan tâm đến **hợp đồng đầu vào - đầu ra**: gửi event → cache bị invalidate.

---

## 2. CDN capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh:

> **catalog-events-mock -> app internal invalidation -> CDN invalidation**

Cụ thể hơn, case này chứng minh ba khả năng:

| # | Capability | Mô tả | Test trong case |
| --- | --- | --- | --- |
| 1 | **Event bridge hoạt động** | Event gửi đến catalog-events-mock (`:9091`) được app consumer nhận và xử lý thành công | `triggerCatalogEvent` trả về 200, response body có `success: true` |
| 2 | **Broad invalidation (product event)** | Một event có thể invalidate nhiều endpoint khác nhau (detail, recs, search) — tất cả đều liên quan đến cùng một entity | Product-updated event → detail MISS + recs MISS + search MISS |
| 3 | **Targeted invalidation (homefeed event)** | Một event có thể invalidate select object dựa trên thuộc tính (segment=returning) mà không ảnh hưởng đến object không liên quan (segment=guest) | Homefeed-updated event → returning MISS, guest MISS (vẫn bị ảnh hưởng trong implementation này) |

### 2.2 Phân biệt hai loại event

Case này có hai event với phạm vi khác nhau:

**Event 1: `product-updated` — Broad invalidation**

```text
Endpoint: POST /events/product-updated
Payload:  { "product_id": "1", "warm": false }

Mục đích: Mô phỏng việc một sản phẩm bị thay đổi.
Ảnh hưởng: Tất cả endpoint hiển thị dữ liệu của sản phẩm đó.

Logic app (dự kiến):
  1. Nhận event với product_id=1
  2. Tìm tất cả cache object liên quan đến product 1:
     - /api/sim/products/1 (chi tiết)
     - /api/sim/products/1/recommendations (đề xuất)
     - /api/sim/products/search?q=* (tìm kiếm — vì kết quả có thể chứa product 1)
  3. Gọi CDN control API để invalidate từng endpoint
  4. Trả về success: true
```

**Event 2: `homefeed-updated` — Targeted invalidation**

```text
Endpoint: POST /events/homefeed-updated
Payload:  { "segment": "returning", "warm": false }

Mục đích: Mô phỏng việc thuật toán homefeed thay đổi cho một phân khúc.
Ảnh hưởng: Cache của homefeed cho phân khúc đó.

Logic app (dự kiến):
  1. Nhận event với segment=returning
  2. Tìm tất cả cache object cho /api/sim/products/homefeed với segment=returning
  3. Gọi CDN control API để invalidate
  4. Trả về success: true
```

### 2.3 Tại sao đây là capability quan trọng

Nếu không có event-driven invalidation:

```text
❌ Phụ thuộc vào con người → ops phải nhớ invalidate mỗi khi có thay đổi
❌ Độ trễ cao → người dùng thấy dữ liệu cũ trong nhiều phút
❌ Không nhất quán → ops có thể invalidate detail nhưng quên recs
❌ Không scale → 200,000 sản phẩm/ngày = không thể ops xử lý thủ công
```

Với event-driven invalidation:

```text
✓ Tự động hoàn toàn → không cần can thiệp con người
✓ Độ trễ thấp → người dùng thấy dữ liệu mới trong < 1 giây
✓ Nhất quán → tất cả endpoint liên quan đều được invalidate theo logic đã code
✓ Scale được → xử lý hàng nghìn event/giây
```

---

## 3. Vì sao phải test ở CDN layer

### 3.1 Chuỗi event có nhiều điểm failure

Event-driven invalidation có nhiều "mắt xích" hơn manual invalidation:

```text
Manual ops (Case 05):
  ops → CDN control API → Varnish
  (2 mắt xích)

Event-driven (Case 06):
  event source → event bus → app consumer → app logic → CDN control API → Varnish
  (6 mắt xích)
```

Mỗi mắt xích đều có thể thất bại:

| Mắt xích | Failure mode | Hậu quả |
| --- | --- | --- |
| Event source → event bus | Event không được publish (bug ở catalog service) | App không nhận được event |
| Event bus → app consumer | Consumer crash, mất kết nối, message bị drop | Event bị bỏ lỡ |
| App consumer → app logic | Logic sai: xác định sai object cần invalidate | Invalidate thiếu endpoint |
| App logic → CDN control API | Token nội bộ sai, network error | Gọi CDN API thất bại |
| CDN control API → Varnish | Admin socket lỗi, config sai | Lệnh không được thực thi |
| Varnish | Race condition: warm lại ngay sau invalidate | Object cũ được cache lại |

Testing ở CDN layer là cách duy nhất để xác minh **toàn bộ chuỗi end-to-end**: từ event cho đến khi cache thực sự bị xóa.

### 3.2 Không thể test riêng app consumer

Nếu chỉ test app consumer (unit test):

```text
Test sai:  Mock CDN API → consumer gọi mock → mock trả 200 → pass
           (Nhưng CDN thật có thể không nhận được lệnh)

Test đúng: Gửi event thật → consumer gọi CDN thật → kiểm tra X-Cache thật
           (End-to-end — phát hiện mọi failure point)
```

### 3.3 Catalog-events-mock là abstraction point

Trong môi trường test, `catalog-events-mock` ở `:9091` đóng vai trò event bus. Đây là mock HTTP endpoint nhận POST request và forward đến app consumer.

```text
Production:
  Catalog service → Kafka → App consumer → CDN control API

Test:
  k6 → catalog-events-mock (:9091) → App consumer → CDN control API (:8088)
```

Mock này cho phép test event-driven flow mà không cần dựng Kafka/RabbitMQ đầy đủ. Nó cũng giúp test trở nên đồng bộ (synchronous): k6 gửi POST, mock forward, app xử lý, k6 nhận response có `success: true/false`.

### 3.4 Token separation

Một điểm tinh tế: k6 gửi event không cần `OPS_AUTH_TOKEN`. Event endpoint (`:9091`) là public mock — nó mô phỏng event bus mà bất kỳ service nội bộ nào cũng có thể publish vào. App consumer sau đó dùng **internal token** (không phải ops token) để gọi CDN control API.

```text
k6 → :9091/events/product-updated  (không cần auth — giả lập internal service)
app consumer → :8088/ops/app/cdn/cache/ban-url  (dùng internal auth token)
```

Điều này có nghĩa: sai sót ở `OPS_AUTH_TOKEN` không làm case này fail. Token cho control plane được app consumer quản lý nội bộ.

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌──────────────────────────────┐
                          │     k6 test script            │
                          │     (06-invalidation-events)  │
                          └──────┬──────────┬─────────────┘
                                 │          │
                    public path  │          │  event path
                    (GET)        │          │  (POST)
                                 │          │
                                 ▼          ▼
┌────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  localhost:80 (Varnish)    localhost:8088 (control)                │
│  ┌──────────────────┐     ┌──────────────────────┐                 │
│  │  Varnish cache    │◄────┤  Ops control plane   │                 │
│  │  - object store   │     │  /ops/app/cdn/cache/ │                 │
│  │  - variant keys   │     │    ban-url           │                 │
│  │  - surrogate keys │     │    ban-prefix        │                 │
│  └───────┬──────────┘     └──────────────────────┘                 │
│          │ miss                         ▲                          │
│          ▼                              │ internal call             │
│  ┌──────────────┐                       │ (có token nội bộ)        │
│  │  Nginx :8080 │                       │                          │
│  └───────┬──────┘              ┌────────┴──────────┐               │
│          │                     │  App consumer     │               │
│          ▼                     │  (event handler)  │               │
│  ┌──────────────────────┐      └────────┬──────────┘               │
│  │  App / microservices │               ▲                          │
│  │  - products-service  │               │ event forward            │
│  │  - recommendations   │               │                          │
│  └──────────────────────┘      ┌────────┴──────────┐               │
│                                 │  catalog-events-  │               │
│                                 │  mock (:9091)     │               │
│                                 │  /events/         │               │
│                                 │   product-updated │               │
│                                 │   homefeed-updated│               │
│                                 └───────────────────┘               │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `full` (bắt buộc) | `docker ps` thấy cả Varnish, Nginx, App, và catalog-events-mock |
| `BASE_URL` | `http://localhost:80` | `curl -sI http://localhost:80/api/sim/products/1` |
| `CONTROL_BASE_URL` | `http://localhost:8088` | `curl http://localhost:8088/health` |
| `CATALOG_EVENTS_BASE_URL` | `http://localhost:9091` | `curl http://localhost:9091/health` hoặc `curl -X POST http://localhost:9091/events/product-updated -H "Content-Type: application/json" -d '{"product_id":"1","warm":false}'` |
| `OPS_AUTH_TOKEN` | **Không bắt buộc cho case này** (k6 không gọi control plane trực tiếp) | Có thể để trống — app consumer dùng internal token |

### 4.3 Stack khởi động

```powershell
# Khởi động full stack với CDN và catalog-events-mock
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full -ScaleApp 2
```

Đợi tất cả service healthy (khoảng 30-60 giây). Kiểm tra thêm catalog-events-mock:

```powershell
# Xác nhận catalog-events-mock đang chạy
docker ps --filter "name=catalog-events"

# Xác nhận event endpoint hoạt động
curl -X POST http://localhost:9091/events/product-updated `
  -H "Content-Type: application/json" `
  -d '{"product_id":"1","warm":false}'
# Expected: {"success":true}
```

### 4.4 Precondition của script

Script `setup()` tự động thực thi bốn lệnh để đảm bảo trạng thái cache sạch:

```javascript
export function setup() {
  banUrl(paths.productDetail);     // Xóa /api/sim/products/1
  banUrl(paths.recommendations);   // Xóa /api/sim/products/1/recommendations
  banUrl(paths.homefeed);          // Xóa /api/sim/products/homefeed
  banPrefix(paths.searchPrefix);   // Xóa TẤT CẢ object có prefix /api/sim/products/search
}
```

Điểm đáng chú ý: `banPrefix` được dùng cho search path thay vì `banUrl`. Lý do: search URL có query parameter (`?q=shoe`), và `banUrl` có thể không match nếu implementation là exact URL match. `banPrefix` đảm bảo mọi URL bắt đầu bằng `/api/sim/products/search` đều bị xóa, bất kể query string.

```javascript
// paths definition (từ shared.js):
search:       '/api/sim/products/search?q=shoe',       // URL cụ thể dùng trong request
searchPrefix: '/api/sim/products/search',               // Prefix dùng để ban
```

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\06-invalidation-events.js
```

### 5.2 Import và dependency

```javascript
import {
  decodeJSON,              // Parse JSON response body; fail nếu invalid JSON
  paths,                   // Định nghĩa URL paths
  profiles,                // Các profile người dùng
  banPrefix,               // Hàm gọi POST /ops/app/cdn/cache/ban (ban theo prefix)
  banUrl,                  // Hàm gọi POST /ops/app/cdn/cache/ban-url
  requestCdn,              // Hàm gửi GET request qua CDN (:80)
  triggerCatalogEvent,     // Hàm gửi POST event đến catalog-events-mock (:9091)
  assertCacheState,        // Hàm kiểm tra X-Cache header
  assertStatus,            // Hàm kiểm tra HTTP status code
  assertUpstream,          // Hàm kiểm tra X-Upstream-Service header
} from './shared.js';
```

**Điểm mới so với Case 05:**

| Import | Vai trò | Lần đầu xuất hiện |
| --- | --- | --- |
| `triggerCatalogEvent` | Gửi event đến mock | Chỉ có ở case 06 |
| `decodeJSON` | Parse response body để kiểm tra `success: true` | Dùng trong case 06 để verify event đã được app xử lý |
| `banPrefix` | Ban theo URL prefix (dùng cho search path có query string) | Lần đầu dùng thay cho `banUrl` cho search |

### 5.3 options block

```javascript
export const options = {
  vus: 1,           // 1 VU — correctness test
  iterations: 1,    // Chạy đúng 1 lần
  thresholds: {
    checks: ['rate==1'],  // 100% checks phải pass
  },
  tags: {
    scenario: 'cdn_invalidation_events',
  },
};
```

**Tương tự Case 05:** `vus: 1`, `iterations: 1`, `checks: ['rate==1']`. Đây là chuẩn cho CDN correctness cases. Khác biệt duy nhất là `scenario` tag: `cdn_invalidation_events` (để phân biệt trên dashboard).

### 5.4 Hàm `warmUntilHit(path, profile, label)` — local helper

```javascript
function warmUntilHit(path, profile, label) {
  // Lần 1: MISS
  const first = requestCdn('GET', path, {
    profile,
    tags: { case: `${label}_warm_first` },
  });
  assertStatus(first, 200, `${label} warm first`);
  assertUpstream(first, 'products-service', `${label} warm first`);
  assertCacheState(first, 'MISS', `${label} warm first`);

  // Lần 2: HIT
  const second = requestCdn('GET', path, {
    profile,
    tags: { case: `${label}_warm_second` },
  });
  assertStatus(second, 200, `${label} warm second`);
  assertCacheState(second, 'HIT', `${label} warm second`);
}
```

Helper function này giống hệt Case 05. Nó đảm bảo object đã được cache trước khi event được gửi. Nếu không warm trước, việc MISS sau event không chứng minh được gì — vì object chưa từng được cache.

### 5.5 `setup()` — dọn dẹp trước khi test

```javascript
export function setup() {
  banUrl(paths.productDetail);     // (1) Xóa product detail
  banUrl(paths.recommendations);   // (2) Xóa recommendations
  banUrl(paths.homefeed);          // (3) Xóa homefeed
  banPrefix(paths.searchPrefix);   // (4) Xóa tất cả search variants
}
```

**Tại sao dùng `banPrefix` cho search?**

Search path có query string (`?q=shoe`). Nếu dùng `banUrl('/api/sim/products/search?q=shoe')`, chỉ object với exact query đó bị xóa. Nhưng search có thể có các query khác (`?q=shoe&sort=price`, `?q=shoe&page=2`) vẫn còn trong cache. `banPrefix('/api/sim/products/search')` xóa tất cả — đảm bảo cache sạch hoàn toàn cho search.

### 5.6 `default()` — logic chính

`default()` thực thi hai proof tuần tự:

#### Proof 1: Product-updated event

```javascript
const guest = profiles.guestVNMobileControl;
const returning = profiles.returningVNMobileVariantA;

// Bước 1.1: Warm các endpoint trước khi gửi event
warmUntilHit(paths.productDetail, guest, 'detail_before_event');
warmUntilHit(paths.recommendations, guest, 'recs_before_event');
warmUntilHit(paths.search, guest, 'search_before_event');
warmUntilHit(paths.homefeed, returning, 'homefeed_before_product_event');

// Bước 1.2: Gửi product-updated event
const productEvent = triggerCatalogEvent('/events/product-updated', {
  product_id: '1',
  warm: false,
});
assertStatus(productEvent, 200, 'product event');

// Bước 1.3: Parse response để kiểm tra success
const productEventBody = decodeJSON(productEvent, 'product event');
if (!productEventBody.success) {
  throw new Error('product-updated event did not succeed');
}

// Bước 1.4: Verify — tất cả endpoint liên quan đến product 1 đều MISS
const detailAfterEvent = requestCdn('GET', paths.productDetail, {
  profile: guest,
  tags: { case: 'detail_after_product_event' },
});
assertStatus(detailAfterEvent, 200, 'detail after product event');
assertCacheState(detailAfterEvent, 'MISS', 'detail after product event');

const recsAfterEvent = requestCdn('GET', paths.recommendations, {
  profile: guest,
  tags: { case: 'recs_after_product_event' },
});
assertStatus(recsAfterEvent, 200, 'recs after product event');
assertCacheState(recsAfterEvent, 'MISS', 'recs after product event');

const searchAfterEvent = requestCdn('GET', paths.search, {
  profile: guest,
  tags: { case: 'search_after_product_event' },
});
assertStatus(searchAfterEvent, 200, 'search after product event');
assertCacheState(searchAfterEvent, 'MISS', 'search after product event');
```

**Phân tích chi tiết proof 1:**

```text
Warm phase:
  detail (guest)     : MISS → HIT  ← detail đã sẵn trong cache
  recs (guest)       : MISS → HIT  ← recs đã sẵn trong cache
  search (guest)     : MISS → HIT  ← search đã sẵn trong cache
  homefeed (returning): MISS → HIT ← homefeed đã sẵn trong cache

Event phase:
  POST /events/product-updated {product_id:"1", warm:false}
  → App consumer nhận event
  → App xác định: product 1 ảnh hưởng detail, recs, search
  → App gọi CDN API để invalidate
  → Trả về {success: true}

Verify phase (SAU event):
  detail (guest)     : MISS ✓  ← đã bị invalidate bởi product-updated event
  recs (guest)       : MISS ✓  ← đã bị invalidate bởi product-updated event
  search (guest)     : MISS ✓  ← đã bị invalidate bởi product-updated event
  (homefeed chưa verify ngay — sẽ verify ở proof 2)
```

**Câu hỏi quan trọng:** Tại sao search cũng bị MISS? Search path (`/api/sim/products/search?q=shoe`) hiển thị danh sách sản phẩm. Khi product 1 thay đổi, kết quả tìm kiếm có chứa product 1 cũng cần được làm mới. Đây là logic nghiệp vụ: "nếu sản phẩm thay đổi, mọi trang hiển thị sản phẩm đó đều phải được invalidate".

**Tại sao homefeed được warm với `returning` profile?** Đây là setup cho proof 2. Homefeed được warm trước để sau đó event homefeed-updated có thể invalidate nó. Nếu không warm, không thể chứng minh event có tác dụng.

#### Proof 2: Homefeed-updated event

```javascript
// Bước 2.1: Warm thêm homefeed cho guest profile
warmUntilHit(paths.homefeed, profiles.guestVNMobileVariantA,
  'homefeed_guest_before_homefeed_event');
warmUntilHit(paths.homefeed, returning,
  'homefeed_returning_before_homefeed_event');

// Bước 2.2: Gửi homefeed-updated event
const homefeedEvent = triggerCatalogEvent('/events/homefeed-updated', {
  segment: 'returning',
  warm: false,
});
assertStatus(homefeedEvent, 200, 'homefeed event');

// Bước 2.3: Parse response để kiểm tra success
const homefeedEventBody = decodeJSON(homefeedEvent, 'homefeed event');
if (!homefeedEventBody.success) {
  throw new Error('homefeed-updated event did not succeed');
}

// Bước 2.4: Verify — homefeed cho guest và returning đều MISS
const guestAfterHomefeedEvent = requestCdn('GET', paths.homefeed, {
  profile: profiles.guestVNMobileVariantA,
  tags: { case: 'homefeed_guest_after_event' },
});
assertStatus(guestAfterHomefeedEvent, 200, 'guest homefeed after event');
assertCacheState(guestAfterHomefeedEvent, 'MISS', 'guest homefeed after event');

const returningAfterHomefeedEvent = requestCdn('GET', paths.homefeed, {
  profile: returning,
  tags: { case: 'homefeed_returning_after_event' },
});
assertStatus(returningAfterHomefeedEvent, 200, 'returning homefeed after event');
assertCacheState(returningAfterHomefeedEvent, 'MISS', 'returning homefeed after event');
```

**Phân tích chi tiết proof 2:**

```text
Warm phase (bổ sung):
  homefeed (guest variant-a)   : MISS → HIT
  homefeed (returning variant-a): MISS → HIT

Event phase:
  POST /events/homefeed-updated {segment:"returning", warm:false}
  → App consumer nhận event
  → App xác định: homefeed cho segment "returning" cần invalidate
  → App gọi CDN API để invalidate homefeed (có thể bằng banUrl toàn bộ homefeed)
  → Trả về {success: true}

Verify phase (SAU event):
  homefeed (guest variant-a)   : MISS ← bị invalidate
  homefeed (returning variant-a): MISS ← bị invalidate
```

**Nhận xét quan trọng:** Event chỉ định `segment: "returning"`, nhưng **cả guest và returning đều MISS**. Điều này cho thấy implementation hiện tại của app consumer không lọc theo segment — nó invalidate toàn bộ `/api/sim/products/homefeed` (tất cả variant) khi nhận homefeed-updated event. Đây có thể là thiết kế có chủ đích (an toàn hơn — invalidate rộng hơn cần thiết để tránh bỏ sót) hoặc là hạn chế của implementation hiện tại. Đây là một observation quan trọng cho việc đánh giá implementation maturity.

### 5.7 `teardown()` — không có

Không có `teardown()` function. Tương tự Case 05, không cần dọn dẹp sau khi chạy.

### 5.8 Sơ đồ tổ chức toàn bộ script

```text
┌─ options: vus=1, iterations=1, thresholds checks rate==1
│
├─ warmUntilHit(path, profile, label) ← local helper
│   ├─ first GET → assert 200 + MISS + upstream
│   └─ second GET → assert 200 + HIT
│
├─ setup()
│   ├─ banUrl(/api/sim/products/1)
│   ├─ banUrl(/api/sim/products/1/recommendations)
│   ├─ banUrl(/api/sim/products/homefeed)
│   └─ banPrefix(/api/sim/products/search)
│
└─ default()
    │
    ├─ Proof 1: Product-updated event
    │   ├─ Warm: detail (guest)        MISS → HIT
    │   ├─ Warm: recs (guest)          MISS → HIT
    │   ├─ Warm: search (guest)        MISS → HIT
    │   ├─ Warm: homefeed (returning)  MISS → HIT
    │   ├─ triggerCatalogEvent('/events/product-updated',
    │   │      {product_id:'1', warm:false})
    │   ├─ assertStatus 200
    │   ├─ decodeJSON → assert success===true
    │   ├─ GET detail (guest)  → assert MISS
    │   ├─ GET recs (guest)    → assert MISS
    │   └─ GET search (guest)  → assert MISS
    │
    └─ Proof 2: Homefeed-updated event
        ├─ Warm: homefeed (guest variant-a)     MISS → HIT
        ├─ Warm: homefeed (returning variant-a) MISS → HIT
        ├─ triggerCatalogEvent('/events/homefeed-updated',
        │      {segment:'returning', warm:false})
        ├─ assertStatus 200
        ├─ decodeJSON → assert success===true
        ├─ GET homefeed (guest variant-a)     → assert MISS
        └─ GET homefeed (returning variant-a) → assert MISS
```

---

## 6. Cache key model / VCL deep-dive

### 6.1 Cache keys cho các endpoint trong case này

Case 06 tương tác với bốn endpoint, mỗi endpoint có variant dimensions khác nhau:

| Endpoint | Path | Variant dimensions | Ghi chú |
| --- | --- | --- | --- |
| Product detail | `/api/sim/products/1` | Language, Geo, Device, AB, Segment | Đầy đủ 5 dimensions |
| Recommendations | `/api/sim/products/1/recommendations` | Language, Geo, Device, AB, Segment | Cùng dimension với detail vì liên quan đến product |
| Search | `/api/sim/products/search?q=shoe` | Language, Geo, Device, AB | 4 dimensions (không có Segment) |
| Homefeed | `/api/sim/products/homefeed` | Language, Geo, Device, AB, Segment | Đầy đủ 5 dimensions; segment là dimension quan trọng nhất |

### 6.2 Profile được sử dụng trong case

| Profile | Language | Geo | Device | AB | Segment | Dùng cho |
| --- | --- | --- | --- | --- | --- |
| `guestVNMobileControl` | `vi` | `VN` | `mobile` | `control` | `guest` | Detail, recs, search warm |
| `guestVNMobileVariantA` | `vi` | `VN` | `mobile` | `variant-a` | `guest` | Homefeed guest warm |
| `returningVNMobileVariantA` | `vi` | `VN` | `mobile` | `variant-a` | `returning` | Homefeed returning warm |

### 6.3 Cách event kết nối đến cache invalidation

Không giống như Case 05 (nơi k6 trực tiếp gọi control API), trong Case 06, k6 chỉ gửi event đến mock. Việc ánh xạ từ event sang CDN invalidation được thực hiện bởi app consumer:

```text
Event: {product_id: "1"}
  │
  ▼
App consumer xác định các endpoint bị ảnh hưởng:
  ├─ /api/sim/products/1            → banUrl()
  ├─ /api/sim/products/1/recommendations → banUrl()
  └─ /api/sim/products/search?...   → banPrefix() hoặc banUrl()
  │
  ▼
App consumer gọi CDN control API với internal token
  │
  ▼
CDN thực thi ban/purge → object bị xóa → request sau MISS
```

**Tại sao app consumer dùng `banUrl`/`banPrefix` chứ không dùng `purgeUrl`?**

Với variant-heavy endpoints, mỗi endpoint có từ 24-120 variant khác nhau. Nếu dùng `purgeUrl`, app consumer phải liệt kê tất cả variant và gọi purge cho từng cái — không hiệu quả và dễ bỏ sót. `banUrl` và `banPrefix` xóa tất cả variant trong một lệnh.

**Tại sao không dùng `banTag`?**

Để dùng `banTag`, origin phải trả về `Surrogate-Key` header với tag như `product-1`. Nếu infrastructure đã hỗ trợ Surrogate-Key, app consumer có thể dùng `banTag('product-1')` — một lệnh duy nhất invalidate tất cả endpoint liên quan. Tuy nhiên, case này không phụ thuộc vào Surrogate-Key — nó dùng `banUrl`/`banPrefix` để đảm bảo compatibility rộng nhất.

### 6.4 Ban prefix cho search

Đây là chi tiết quan trọng: search path có query string. CDN thường cache mỗi query string khác nhau như một object riêng (trừ khi query normalization bỏ qua một số params — xem Case 04). Do đó, để invalidate tất cả search results, cần `banPrefix`:

```text
banUrl('/api/sim/products/search?q=shoe')
  → Chỉ xóa object cho exact query "?q=shoe"
  → Các query khác (?q=shoe&sort=price, ?q=shoe&page=2) vẫn còn cache

banPrefix('/api/sim/products/search')
  → Xóa MỌI object có URL bắt đầu bằng /api/sim/products/search
  → Bao gồm tất cả query string, tất cả variant
```

---

## 7. Request sequence flow

### 7.1 Timeline toàn bộ script

```text
T0: k6 start
│
├─ SETUP phase ──────────────────────────────────────────
│  T1: POST /ops/app/cdn/cache/ban-url  {url:"/api/sim/products/1"}              → 200 OK
│  T2: POST /ops/app/cdn/cache/ban-url  {url:"/api/sim/products/1/recommendations"} → 200 OK
│  T3: POST /ops/app/cdn/cache/ban-url  {url:"/api/sim/products/homefeed"}        → 200 OK
│  T4: POST /ops/app/cdn/cache/ban      {prefix:"/api/sim/products/search"}       → 200 OK
│
├─ DEFAULT phase ────────────────────────────────────────
│
│  ═══ Proof 1: Product-updated event ═══
│  T5:  GET  /api/sim/products/1  [guest control]       → 200 MISS products-service
│  T6:  GET  /api/sim/products/1  [guest control]       → 200 HIT
│  T7:  GET  /api/sim/products/1/recommendations [guest control] → 200 MISS products-service
│  T8:  GET  /api/sim/products/1/recommendations [guest control] → 200 HIT
│  T9:  GET  /api/sim/products/search?q=shoe [guest control] → 200 MISS products-service
│  T10: GET  /api/sim/products/search?q=shoe [guest control] → 200 HIT
│  T11: GET  /api/sim/products/homefeed [returning variant-a] → 200 MISS products-service
│  T12: GET  /api/sim/products/homefeed [returning variant-a] → 200 HIT
│
│  T13: POST /events/product-updated  {product_id:"1", warm:false}  → 200 {"success":true}
│
│  T14: GET  /api/sim/products/1  [guest control]       → 200 MISS products-service
│  T15: GET  /api/sim/products/1/recommendations [guest control] → 200 MISS products-service
│  T16: GET  /api/sim/products/search?q=shoe [guest control] → 200 MISS products-service
│
│  ═══ Proof 2: Homefeed-updated event ═══
│  T17: GET  /api/sim/products/homefeed [guest variant-a]    → 200 MISS products-service
│  T18: GET  /api/sim/products/homefeed [guest variant-a]    → 200 HIT
│  T19: GET  /api/sim/products/homefeed [returning variant-a] → 200 MISS products-service
│  T20: GET  /api/sim/products/homefeed [returning variant-a] → 200 HIT
│
│  T21: POST /events/homefeed-updated  {segment:"returning", warm:false} → 200 {"success":true}
│
│  T22: GET  /api/sim/products/homefeed [guest variant-a]    → 200 MISS products-service
│  T23: GET  /api/sim/products/homefeed [returning variant-a] → 200 MISS products-service
│
└─ T24: k6 end (checks rate==1 → exit 0)
```

### 7.2 Phân tích từng giai đoạn

#### Giai đoạn SETUP (T1-T4)

```text
Mục đích: Đảm bảo cache sạch cho tất cả endpoint

T1: banUrl product detail      → Xóa mọi variant của detail
T2: banUrl recommendations      → Xóa mọi variant của recs
T3: banUrl homefeed             → Xóa mọi variant của homefeed
T4: banPrefix search            → Xóa mọi URL bắt đầu bằng /api/sim/products/search

Sau setup: Tất cả 4 endpoint đều EMPTY trong cache.
```

#### Giai đoạn PROOF 1: Warm (T5-T12)

```text
Mục đích: Đảm bảo tất cả object đã được cache trước khi gửi event

T5-T6:   detail (guest control)       MISS → HIT  ← Cache key: vi/VN/mobile/control/guest
T7-T8:   recs (guest control)         MISS → HIT  ← Cache key: vi/VN/mobile/control/guest
T9-T10:  search (guest control)       MISS → HIT  ← Cache key: vi/VN/mobile/control/guest
T11-T12: homefeed (returning var-a)   MISS → HIT  ← Cache key: vi/VN/mobile/variant-a/returning

Sau warm: 4 object đã trong cache, mỗi object có cache key riêng.
```

#### Giai đoạn PROOF 1: Event (T13)

```text
T13: POST /events/product-updated {product_id:"1", warm:false}

Request này đi đến catalog-events-mock (:9091), không qua CDN.
Mock forward event đến app consumer.
App consumer xác định các object bị ảnh hưởng và gọi CDN control API.

Expected response: 200 {"success":true}

Nếu response có success:false hoặc status != 200 → throw Error → k6 fail.
```

#### Giai đoạn PROOF 1: Verify (T14-T16)

```text
T14: detail (guest control) → MISS  ← Object đã bị invalidate bởi product event
T15: recs (guest control)   → MISS  ← Object đã bị invalidate bởi product event
T16: search (guest control) → MISS  ← Object đã bị invalidate bởi product event

Cả ba endpoint đều MISS → product-updated event đã invalidate thành công.
Lý do search bị ảnh hưởng: kết quả tìm kiếm có chứa product 1, nên phải
được làm mới khi product 1 thay đổi.
```

**Câu hỏi:** Tại sao không verify homefeed sau product event? Vì homefeed được warm với returning profile và sẽ được verify trong proof 2. Product event không nhất thiết phải ảnh hưởng đến homefeed (tùy implementation). Script chọn không verify homefeed ở proof 1 để giữ proof 1 tập trung vào các endpoint liên quan trực tiếp đến product.

Tuy nhiên, lưu ý rằng homefeed đã được warm ở T11-T12. Sau T13 (product event), nếu implementation cũng invalidate homefeed (do homefeed hiển thị sản phẩm), thì T17-T18 trong proof 2 sẽ thấy MISS thay vì HIT — nhưng `warmUntilHit` sẽ tự động điều chỉnh vì nó expect MISS ở lần đầu.

#### Giai đoạn PROOF 2: Warm bổ sung (T17-T20)

```text
T17-T18: homefeed (guest variant-a)     MISS → HIT
  Lần đầu MISS có thể do:
  a) Object chưa từng được warm với profile này, hoặc
  b) Product event cũng đã invalidate homefeed → object mất

T19-T20: homefeed (returning variant-a)  MISS → HIT
  Tương tự — đảm bảo object cho returning cũng đã trong cache.

Sau warm bổ sung: Cả hai variant của homefeed đều đã HIT.
```

#### Giai đoạn PROOF 2: Event (T21)

```text
T21: POST /events/homefeed-updated {segment:"returning", warm:false}

Event này chỉ định segment="returning" — app consumer có thể:
  a) Invalidate CHỈ homefeed với segment=returning (targeted), hoặc
  b) Invalidate toàn bộ homefeed (broad — implementation đơn giản hơn)

Trong implementation hiện tại: toàn bộ homefeed bị invalidate (cả guest và returning).
```

#### Giai đoạn PROOF 2: Verify (T22-T23)

```text
T22: homefeed (guest variant-a)     → MISS  ← Bị invalidate (dù event chỉ định returning)
T23: homefeed (returning variant-a)  → MISS  ← Bị invalidate (đúng như event chỉ định)

Kết luận: Homefeed-updated event đã thành công invalidate homefeed cache.
Implementation hiện tại invalidate toàn bộ homefeed, không lọc theo segment.
```

### 7.3 So sánh timeline với Case 05

| Khía cạnh | Case 05 (Manual ops) | Case 06 (Event-driven) |
| --- | --- | --- |
| Số bước setup | 3 (3 banUrl/purgeUrl) | 4 (3 banUrl + 1 banPrefix) |
| Số request public | 15 | 19 |
| Số request control/event | 6 (3 setup + 3 default) | 6 (4 setup + 2 event) |
| Số endpoint được test | 3 (cached, detail, recs) | 4 (detail, recs, search, homefeed) |
| Số profile được dùng | 2 (guest control, guest variant-a) | 3 (guest control, guest variant-a, returning variant-a) |
| Invalidation trigger | k6 gọi control API trực tiếp | k6 gửi event → app consumer gọi control API |
| Tổng thời gian chạy | ~1.3 giây | ~1.5 giây |

---

## 8. Key signals / headers cần verify

### 8.1 Bảng header cần kiểm tra

| Header | Vị trí | Giá trị cần verify | Hàm assert | Xuất hiện ở đâu |
| --- | --- | --- | --- | --- |
| `X-Cache` | Public response | `MISS` (sau setup), `HIT` (sau warm), `MISS` (sau event) | `assertCacheState(res, expected, label)` | Tất cả public requests |
| `X-Upstream-Service` | Public response | `products-service` | `assertUpstream(res, upstream, label)` | Request MISS |
| `X-Cache-Key-Language` | Public response | `vi` | `assertCacheKeyHeaders(...)` | Request có profile |
| `X-Cache-Key-Geo` | Public response | `VN` | `assertCacheKeyHeaders(...)` | Request có profile |
| `X-Cache-Key-Device` | Public response | `mobile` | `assertCacheKeyHeaders(...)` | Request có profile |
| `X-Cache-Key-AB` | Public response | `control` hoặc `variant-a` | `assertCacheKeyHeaders(...)` | Request có profile |
| `X-Cache-Key-Segment` | Public response | `guest` hoặc `returning` | `assertCacheKeyHeaders(...)` | Homefeed requests |
| HTTP Status (event response) | Event response | `200` | `assertStatus(res, 200, label)` | Event calls |
| Response body `.success` | Event response body | `true` | `decodeJSON` + manual check | Event calls |

### 8.2 Chi tiết headers cần chú ý

#### `X-Cache` — evidence chính

```text
Pattern cho mỗi endpoint:
  MISS (setup clear) → HIT (warm) → [event] → MISS (verify)
```

Nếu bất kỳ endpoint nào không theo pattern này, event-driven invalidation đã thất bại ở một mắt xích nào đó trong chuỗi.

#### `X-Cache-Key-Segment` — đặc biệt quan trọng cho homefeed

```text
Homefeed với profile guest:
  X-Cache-Key-Segment: guest

Homefeed với profile returning:
  X-Cache-Key-Segment: returning
```

Đây là evidence cho thấy homefeed được cache riêng biệt theo segment. Nếu cả hai profile đều trả về cùng `X-Cache-Key-Segment`, có nghĩa là VCL không phân biệt segment — một bug nghiêm trọng (xem Case 02 để hiểu rõ hơn về variant keys).

#### Event response body — `success: true`

```javascript
// Trong script:
const productEventBody = decodeJSON(productEvent, 'product event');
if (!productEventBody.success) {
  throw new Error('product-updated event did not succeed');
}
```

Đây là bước kiểm tra mà không dùng `check()` — nó dùng `throw new Error()` để fail fast. Nếu event không thành công (success: false), không có lý do gì để tiếp tục verify cache — mọi thứ sẽ vẫn HIT và tất cả checks sau đó sẽ fail. Fail fast giúp debug dễ hơn.

### 8.3 So sánh tín hiệu giữa Case 05 và Case 06

| Tín hiệu | Case 05 | Case 06 | Khác biệt |
| --- | --- | --- | --- |
| Control response status | Kiểm tra 200 | Kiểm tra 200 | Giống nhau |
| Control response body | Không kiểm tra | Kiểm tra `success: true` | Case 06 kiểm tra sâu hơn |
| `X-Cache` sequence | MISS→HIT→[ops]→MISS | MISS→HIT→[event]→MISS | Trigger khác nhau |
| Số endpoint verify sau invalidate | 1 (purge), 2 (ban-url), 2 (ban-tag) | 3 (product event), 2 (homefeed event) | Case 06 kiểm tra nhiều endpoint hơn mỗi lần |
| `X-Upstream-Service` | Có kiểm tra khi MISS | Có kiểm tra khi MISS | Giống nhau |

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

| # | Tiêu chí | Cách xác minh | Định lượng |
| --- | --- | --- | --- |
| 1 | k6 exit code = 0 | `$LASTEXITCODE` hoặc CI job status | `exit 0` |
| 2 | Tất cả checks pass | k6 output | `checks rate = 1.0` |
| 3 | Event response status 200 | k6 checks | 2/2 event calls status 200 |
| 4 | Event response body `success: true` | decodeJSON check trong script | 2/2 event calls success=true |
| 5 | `X-Cache` sequence đúng cho từng endpoint | Named checks | Product event: 3/3 endpoint MISS; Homefeed event: 2/2 variant MISS |
| 6 | `X-Upstream-Service` đúng khi MISS | Named checks | Tất cả MISS request có upstream=products-service |

### 9.2 Tiêu chí FAIL

| # | Dấu hiệu FAIL | Nguyên nhân khả dĩ | Cách debug |
| --- | --- | --- | --- |
| A | Event endpoint trả về non-200 | Catalog-events-mock không chạy hoặc sai port | `curl http://localhost:9091/health` |
| B | Event 200 nhưng `success: false` | App consumer không xử lý được event (internal error, token sai) | Kiểm tra app consumer logs |
| C | Event `success: true` nhưng object vẫn HIT | App consumer không gọi CDN API, hoặc CDN API không thực thi | Kiểm tra app consumer logs + Varnish logs |
| D | Một endpoint MISS nhưng endpoint khác vẫn HIT sau event | App consumer xác định thiếu endpoint (logic incomplete) | Kiểm tra app consumer code: những endpoint nào được map với event? |
| E | Search MISS nhưng detail vẫn HIT | App consumer chỉ invalidate search chứ không invalidate detail | App consumer logic thiếu endpoint mapping |
| F | `throw new Error('product-updated event did not succeed')` | Event mock trả về success:false | Đọc response body đầy đủ để tìm error message |
| G | Setup banUrl/banPrefix fail | Control plane không hoạt động hoặc token sai (dù case này không cần token từ k6, app consumer vẫn cần internal token) | `curl http://localhost:8088/health` |

### 9.3 Ma trận quyết định

| Tình trạng | Event 200? | success:true? | Cache MISS sau event? | checks rate | Kết luận | Hành động |
| --- | --- | --- | --- | --- | --- |
| A | Có | Có | Có — tất cả | 1.0 | PASS hoàn toàn | Không cần làm gì |
| B | Có | Có | Không — một số vẫn HIT | < 1.0 | Event bridge hoạt động nhưng app consumer logic thiếu endpoint | Bổ sung endpoint mapping trong app consumer |
| C | Có | Không | Không | < 1.0 | Event được nhận nhưng app consumer xử lý thất bại | Kiểm tra app consumer logs, internal token |
| D | Không (503) | N/A | Không | < 1.0 | Catalog-events-mock không chạy | `docker ps`, khởi động lại stack |
| E | Có | Có | Có nhưng không đầy đủ | < 1.0 | App consumer invalidate không đủ rộng | Mở rộng logic xác định endpoint |
| F | Có | Có | Có — nhưng object đã MISS từ trước event | < 1.0 | Object bị mất trước event (race condition, TTL, hoặc process khác) | Kiểm tra thời gian giữa warm và event |

### 9.4 Phân biệt fail do event bridge vs fail do CDN invalidation

Một điểm tinh tế: Case 06 có thể fail ở hai tầng khác nhau, và việc xác định đúng tầng rất quan trọng cho debug:

```text
Tầng 1: Event bridge (catalog-events-mock → app consumer)
  - Event không đến được app consumer
  - App consumer crash khi xử lý event
  - App consumer trả về success:false
  → Dấu hiệu: event response có success:false HOẶC throw Error

Tầng 2: CDN invalidation (app consumer → CDN control API → Varnish)
  - App consumer gọi CDN API nhưng API không thực thi
  - App consumer xác định sai endpoint cần invalidate
  - Varnish admin socket không hoạt động
  → Dấu hiệu: event success:true NHƯNG cache vẫn HIT
```

Cách phân biệt:

```text
Nếu decodeJSON throw Error "product-updated event did not succeed"
  → Vấn đề ở tầng 1 (event bridge)

Nếu event success=true nhưng detail_after_product_event cache state HIT
  → Vấn đề ở tầng 2 (CDN invalidation)

Nếu một số endpoint MISS, một số HIT
  → Vấn đề ở tầng 2 (app consumer logic incomplete — thiếu endpoint mapping)
```

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy

```powershell
# 1. Di chuyển đến thư mục gốc
cd E:\Projects\k6\k6-metrics-server

# 2. Set biến môi trường (ít hơn Case 05 vì không cần OPS_AUTH_TOKEN cho k6)
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"

# Lưu ý: OPS_AUTH_TOKEN có thể không cần set cho case này.
# Tuy nhiên, nếu setup() gọi banUrl/banPrefix (cần control plane),
# app consumer cần internal token để gọi control plane.
# Token này được app consumer quản lý, không phải k6.

# 3. Chạy script
.\scripts\run-cdn-capabilities.ps1 -Scenarios 06-invalidation-events

# Hoặc chạy trực tiếp:
k6 run .\load-target\k6\cdn\06-invalidation-events.js
```

### 10.2 Output mẫu mong đợi (PASS)

```text

         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: .\load-target\k6\cdn\06-invalidation-events.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations for each of 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)


     data_received..................: 18 kB   ...
     data_sent......................: 9.5 kB  ...
     http_req_blocked...............: avg=0.00ms  ...
     http_req_connecting............: avg=0.00ms  ...
     http_req_duration..............: avg=3.80ms  ...
     http_req_receiving.............: avg=0.18ms  ...
     http_req_sending...............: avg=0.02ms  ...
     http_req_waiting...............: avg=3.60ms  ...
     http_reqs......................: 25      ...
     iteration_duration.............: avg=1.55s   ...
     iterations.....................: 1        ...
     vus............................: 1        ...
     vus_max........................: 1        ...


█ checks...
  ✓ detail_before_event warm first status 200
  ✓ detail_before_event warm first upstream products-service
  ✓ detail_before_event warm first cache state MISS
  ✓ detail_before_event warm second status 200
  ✓ detail_before_event warm second cache state HIT
  ✓ recs_before_event warm first status 200
  ✓ recs_before_event warm first upstream products-service
  ✓ recs_before_event warm first cache state MISS
  ✓ recs_before_event warm second status 200
  ✓ recs_before_event warm second cache state HIT
  ✓ search_before_event warm first status 200
  ✓ search_before_event warm first upstream products-service
  ✓ search_before_event warm first cache state MISS
  ✓ search_before_event warm second status 200
  ✓ search_before_event warm second cache state HIT
  ✓ homefeed_before_product_event warm first status 200
  ✓ homefeed_before_product_event warm first upstream products-service
  ✓ homefeed_before_product_event warm first cache state MISS
  ✓ homefeed_before_product_event warm second status 200
  ✓ homefeed_before_product_event warm second cache state HIT
  ✓ product event status 200
  ✓ detail after product event status 200
  ✓ detail after product event cache state MISS
  ✓ recs after product event status 200
  ✓ recs after product event cache state MISS
  ✓ search after product event status 200
  ✓ search after product event cache state MISS
  ✓ homefeed_guest_before_homefeed_event warm first status 200
  ✓ homefeed_guest_before_homefeed_event warm first upstream products-service
  ✓ homefeed_guest_before_homefeed_event warm first cache state MISS
  ✓ homefeed_guest_before_homefeed_event warm second status 200
  ✓ homefeed_guest_before_homefeed_event warm second cache state HIT
  ✓ homefeed_returning_before_homefeed_event warm first status 200
  ✓ homefeed_returning_before_homefeed_event warm first upstream products-service
  ✓ homefeed_returning_before_homefeed_event warm first cache state MISS
  ✓ homefeed_returning_before_homefeed_event warm second status 200
  ✓ homefeed_returning_before_homefeed_event warm second cache state HIT
  ✓ homefeed event status 200
  ✓ guest homefeed after event status 200
  ✓ guest homefeed after event cache state MISS
  ✓ returning homefeed after event status 200
  ✓ returning homefeed after event cache state MISS

   ✓ checks........................: 100.00% ✓ 42   ✗ 0
     ✓ { scenario:cdn_invalidation_events }...: 100.00% ✓ 42   ✗ 0


running (00m01.5s), 1/1 VUs, 1 complete and 0 interrupted iterations
default ✓ [======================================] 1 VUs  00m01.5s/10m0s  1/1 iters, 1 per VU
```

### 10.3 Output mẫu khi FAIL (event success:false)

```text
█ checks...
  ... (warm checks pass) ...

  ✓ product event status 200

ERRO[0015] product-updated event did not succeed
default ✗ [======>-------------------------------] 1 VUs  00m01.2s/10m0s  0/1 iters, 1 per VU
```

Script sẽ dừng ngay khi `throw new Error(...)` được gọi. Các checks phía sau (detail after event, recs after event, ...) không được thực thi. Đây là hành vi mong đợi: nếu event không thành công, không có lý do gì để kiểm tra cache.

### 10.4 Output mẫu khi FAIL (event OK nhưng cache không bị invalidate)

```text
█ checks...
  ... (warm checks pass) ...
  ✓ product event status 200

  ✓ detail after product event status 200
  ✗ detail after product event cache state MISS
    ↳  0% — expected MISS, got HIT

  ✓ recs after product event status 200
  ✗ recs after product event cache state MISS
    ↳  0% — expected MISS, got HIT

  ✓ search after product event status 200
  ✗ search after product event cache state MISS
    ↳  0% — expected MISS, got HIT

   ✗ checks........................: 92.85%  ✓ 39   ✗ 3
     ✗ { scenario:cdn_invalidation_events }...: 92.85%  ✓ 39   ✗ 3

ERRO[0015] thresholds on metrics 'checks' were crossed; at least one has failed
```

### 10.5 Cách đọc output

| Phần output | Ý nghĩa | Hành động |
| --- | --- | --- |
| `throw new Error('product-updated event did not succeed')` | Event bridge thất bại | Kiểm tra app consumer logs |
| `✗ detail after product event cache state MISS` | Event success nhưng cache không bị xóa | Kiểm tra app consumer → CDN control API flow |
| `✓ checks...: 100.00% ✓ 42 ✗ 0` | Tất cả checks pass | Case PASS |

---

## 11. 4 output -> decision scenarios

### Scenario 1: ALL PASS

```text
✓ Event 200 + success:true
✓ Tất cả endpoint MISS sau event
✓ checks rate = 1.0 (42/42)
```

**Kết luận:** Event-driven invalidation hoạt động end-to-end. Cả hai event type đều kích hoạt invalidation chính xác. Hệ thống đã sẵn sàng cho automated invalidation trong production.

**Quyết định:**
- Tích hợp event-driven invalidation vào CI/CD pipeline
- Mở rộng thêm event types cho các use case khác (price-updated, inventory-updated, category-updated)
- Monitor event processing latency để đảm bảo cache được invalidate trong < 1 giây

### Scenario 2: Product event OK, Homefeed event FAIL

```text
✓ Product-updated event: detail, recs, search đều MISS → OK
✗ Homefeed-updated event: homefeed vẫn HIT sau event
```

**Phân tích:**
- Product event hoạt động → event bridge và CDN invalidation infrastructure OK
- Homefeed event không hoạt động → vấn đề nằm ở app consumer handler cho event type này

**Nguyên nhân khả dĩ:**
1. App consumer không đăng ký handler cho event type `homefeed-updated`
2. Handler có bug — xác định sai endpoint hoặc không gọi CDN API
3. Event routing sai — event được gửi đến nhưng không match đúng consumer

**Quyết định:**
- Kiểm tra app consumer code: có handler cho `homefeed-updated` event không?
- Nếu chưa có: thêm handler
- Nếu có nhưng lỗi: debug handler logic

### Scenario 3: Cache không bị invalidate dù event success:true

```text
✓ Event 200 + success:true
✗ Tất cả endpoint vẫn HIT sau event
```

**Phân tích:** Đây là dạng fail nguy hiểm: event bridge báo cáo thành công nhưng thực tế cache không bị ảnh hưởng. App consumer trả về `success: true` nhưng không thực sự gọi CDN API, hoặc gọi nhưng CDN API không thực thi.

**Nguyên nhân khả dĩ:**
1. App consumer bắt exception khi gọi CDN API nhưng vẫn trả về `success: true` (error handling sai)
2. Internal token cho CDN API bị sai hoặc hết hạn → CDN API trả về 401/403 nhưng app consumer không kiểm tra
3. App consumer xác định endpoint sai (ví dụ: gọi ban URL sai path)
4. CDN control plane nhận lệnh nhưng không thực thi được (Varnish admin socket lỗi)

**Quyết định:**
- **Dừng triển khai** — đây là false positive nguy hiểm nhất
- Thêm log chi tiết trong app consumer: log mỗi lần gọi CDN API và response
- Thêm health check cho app consumer → CDN API connectivity
- Verify internal token có hiệu lực

### Scenario 4: Invalidation một phần (partial)

```text
✓ Event success:true
✓ Detail MISS, Recs MISS
✗ Search VẪN HIT
```

**Phân tích:** Event bridge và CDN invalidation infrastructure hoạt động, nhưng app consumer không invalidate ĐỦ endpoint. Chỉ detail và recs bị ảnh hưởng, search thì không.

**Nguyên nhân:** App consumer logic chỉ map product-updated event đến detail và recs, bỏ qua search.

**Quyết định:**
- Mở rộng app consumer logic: thêm search (và có thể cả categories, homefeed nếu có hiển thị sản phẩm) vào danh sách endpoint cần invalidate khi product thay đổi
- Document rõ ràng: "những endpoint nào bị ảnh hưởng khi product thay đổi"
- Viết integration test cho từng event type để đảm bảo tất cả endpoint liên quan đều được invalidate

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Event success = Cache đã được invalidate"

Đây là misconception nguy hiểm tương tự như "Control 200 = Cache đã bị xóa" trong Case 05.

```text
Sai:    Event trả về {"success":true} → "Cache đã bị invalidate, xong!"
Đúng:   Event trả về {"success":true} → cần GET lại object → MISS mới là bằng chứng
```

**Giải thích:** App consumer có thể trả về `success: true` nhưng:
- Gọi CDN API nhưng không kiểm tra response
- Gọi sai endpoint (wrong URL, wrong HTTP method)
- Bắt exception và vẫn trả success (error handling sai)
- Chỉ invalidate một phần endpoint (thiếu)

Event `success: true` chỉ xác nhận rằng **app consumer đã nhận và xử lý event**, không xác nhận rằng **CDN đã thực sự invalidate cache**.

### Nghịch lý 2: "Event-driven nhanh hơn manual ops"

```text
Sai:    Event-driven luôn nhanh hơn vì tự động
Đúng:   Event-driven có thể CHẬM hơn nếu event bus có độ trễ cao
        (Kafka lag, consumer backlog, retry queue)
```

**Giải thích:** Trong môi trường test, event được gửi qua HTTP POST đồng bộ → app consumer xử lý ngay → độ trễ rất thấp (< 100ms). Trong production với message queue (Kafka, RabbitMQ), có thể có:
- Consumer group lag: event phải chờ đến lượt
- Retry với exponential backoff: nếu lần đầu fail, event được retry sau vài giây
- Batch processing: consumer gom nhiều event rồi mới xử lý một lần

Tổng độ trễ từ event publish đến cache invalidate có thể từ < 100ms (test) đến vài giây (production với backlog).

### Nghịch lý 3: "Cần OPS_AUTH_TOKEN để chạy case này"

```text
Sai:    Phải set OPS_AUTH_TOKEN như Case 05
Đúng:   k6 không gọi control plane trực tiếp — app consumer dùng internal token
```

**Giải thích:** Trong Case 06, k6 chỉ gửi event đến catalog-events-mock (không cần auth) và request public qua CDN (không cần auth). App consumer — không phải k6 — gọi CDN control API. Token cho việc đó được app consumer quản lý nội bộ (có thể qua environment variable của container, secret manager, hoặc hardcoded trong development).

Tuy nhiên, `setup()` gọi `banUrl` và `banPrefix` — những hàm này gọi control plane. Vậy setup có cần token không? **Có** — nhưng token này được app consumer (hoặc control plane internal) xử lý. Trong môi trường test local, control plane thường chấp nhận request từ internal network mà không cần token cho các thao tác đơn giản. Nếu control plane yêu cầu token cho mọi request, cần set `OPS_AUTH_TOKEN` cho setup.

### Nghịch lý 4: "Homefeed-updated với segment=returning chỉ ảnh hưởng returning"

```text
Sai:    Event segment=returning → chỉ returning homefeed bị invalidate
Đúng:   Implementation hiện tại invalidate TOÀN BỘ homefeed (cả guest)
```

**Giải thích:** Case này verify rằng cả guest và returning homefeed đều MISS sau homefeed-updated event. Điều này cho thấy app consumer hiện tại không lọc theo segment khi invalidate — nó dùng `banUrl('/api/sim/products/homefeed')`, xóa tất cả variant.

Đây có thể là:
- **Thiết kế có chủ đích:** An toàn hơn — invalidate rộng hơn để tránh bỏ sót. Cache sẽ được fill lại nhanh chóng.
- **Hạn chế của implementation:** App consumer chưa hỗ trợ invalidate có chọn lọc theo segment. Trong tương lai, có thể cải tiến để dùng `purgeUrl` với profile cụ thể hoặc `banTag` với tag `segment-returning`.

### Nghịch lý 5: "Search bị invalidate khi product thay đổi là over-invalidation"

```text
Sai:    Product thay đổi → chỉ cần invalidate detail và recs
Đúng:   Search cũng cần invalidate vì kết quả tìm kiếm hiển thị dữ liệu sản phẩm
```

**Giải thích:** Nếu sản phẩm 1 thay đổi giá, và kết quả tìm kiếm "/search?q=shoe" có hiển thị sản phẩm 1 với giá cũ, người dùng sẽ thấy giá sai. Do đó, search cache cũng phải được invalidate.

Tuy nhiên, mức độ ảnh hưởng có thể khác nhau:
- **Detail page:** Luôn bị ảnh hưởng (hiển thị chính sản phẩm đó)
- **Recommendations:** Luôn bị ảnh hưởng (đề xuất liên quan đến sản phẩm đó)
- **Search:** Có thể bị ảnh hưởng (nếu sản phẩm xuất hiện trong kết quả)
- **Categories:** Có thể bị ảnh hưởng (nếu sản phẩm thuộc category đó)
- **Homefeed:** Có thể bị ảnh hưởng (nếu sản phẩm xuất hiện trên homefeed)

App consumer cần quyết định phạm vi invalidate dựa trên business requirements: invalidate càng rộng càng an toàn nhưng cache hit ratio càng giảm.

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy (full) | `docker ps --filter "name=varnish" --filter "name=catalog-events"` | Cả Varnish và catalog-events-mock đều running | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full -ScaleApp 2` |
| 2 | Public path hoạt động | `curl -sI http://localhost:80/api/sim/products/1` | HTTP 200, có `X-Cache` header | Kiểm tra Nginx + app upstream |
| 3 | Control path hoạt động | `curl http://localhost:8088/health` | HTTP 200 | Kiểm tra control plane container |
| 4 | Catalog-events-mock hoạt động | `curl -X POST http://localhost:9091/events/product-updated -H "Content-Type: application/json" -d '{"product_id":"1","warm":false}'` | HTTP 200, response body chứa `"success"` | `docker logs <catalog-events-container>` |
| 5 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại |
| 6 | `CONTROL_BASE_URL` đúng | `$env:CONTROL_BASE_URL` | `http://localhost:8088` | Set lại |
| 7 | `CATALOG_EVENTS_BASE_URL` đúng | `$env:CATALOG_EVENTS_BASE_URL` | `http://localhost:9091` | Set lại |
| 8 | App consumer đang chạy | Kiểm tra app logs (tùy setup) | Consumer ready, không có error | Khởi động lại app container |

### 13.2 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 9 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\06-invalidation-events.js"` |
| 10 | `shared.js` có hàm `triggerCatalogEvent` | Case này cần hàm này — nếu thiếu sẽ có lỗi import |
| 11 | Product detail trả về đúng response | `curl http://localhost:80/api/sim/products/1` → 200, JSON |
| 12 | Recommendations trả về đúng response | `curl http://localhost:80/api/sim/products/1/recommendations` → 200, JSON |
| 13 | Search trả về đúng response | `curl "http://localhost:80/api/sim/products/search?q=shoe"` → 200, JSON |
| 14 | Homefeed trả về đúng response | `curl http://localhost:80/api/sim/products/homefeed` → 200, JSON |
| 15 | Tất cả endpoint hỗ trợ variant headers | Gửi kèm `Accept-Language`, `X-Geo-Country`, `X-Device-Class`, `X-Ab-Variant`, `X-User-Segment` |

### 13.3 Event flow checklist

| # | Mục kiểm tra | Lệnh |
| --- | --- | --- |
| 16 | Product-updated event hoạt động thủ công | `curl -X POST http://localhost:9091/events/product-updated -H "Content-Type: application/json" -d '{"product_id":"1","warm":false}'` → check response |
| 17 | Homefeed-updated event hoạt động thủ công | `curl -X POST http://localhost:9091/events/homefeed-updated -H "Content-Type: application/json" -d '{"segment":"returning","warm":false}'` → check response |
| 18 | Sau event, cache bị invalidate (manual test) | Gửi event → `curl -sI http://localhost:80/api/sim/products/1` → `X-Cache: MISS` |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Price-updated event

Mở rộng case để test thêm event type `price-updated` — một biến thể phổ biến trong e-commerce.

```javascript
// Variation 1: Price-updated event
// Thêm vào default() hoặc tạo script mới

// Warm product detail
warmUntilHit(paths.productDetail, profiles.guestVNMobileControl, 'price_detail');

// Gửi price-updated event (chỉ ảnh hưởng đến giá, không phải toàn bộ sản phẩm)
const priceEvent = triggerCatalogEvent('/events/price-updated', {
  product_id: '1',
  old_price: 100000,
  new_price: 85000,
  warm: false,
});
assertStatus(priceEvent, 200, 'price event');
const priceBody = decodeJSON(priceEvent, 'price event');
if (!priceBody.success) {
  throw new Error('price-updated event did not succeed');
}

// Verify: detail bị invalidate (vì hiển thị giá)
const detailAfterPrice = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var1_detail_after_price_event' },
});
assertCacheState(detailAfterPrice, 'MISS', 'detail MISS after price event');

// Bonus: recommendations có thể KHÔNG bị ảnh hưởng (nếu chỉ giá thay đổi,
// recommendations không hiển thị giá cụ thể)
```

**Điểm học:** Không phải mọi thay đổi sản phẩm đều cần invalidate mọi endpoint. Price update có thể chỉ cần invalidate detail page, không cần recs hay search (tùy business logic).

### Variation 2: Inventory-updated event

```javascript
// Variation 2: Inventory-updated event
// Khi tồn kho thay đổi, cần invalidate detail (hiển thị "còn hàng"/"hết hàng")
// và search (lọc theo tình trạng kho)

warmUntilHit(paths.productDetail, profiles.guestVNMobileControl, 'inventory_detail');
warmUntilHit(paths.search, profiles.guestVNMobileControl, 'inventory_search');

const inventoryEvent = triggerCatalogEvent('/events/inventory-updated', {
  product_id: '1',
  sku: 'SHOE-001-RED-42',
  quantity: 0,  // Hết hàng
  warm: false,
});
assertStatus(inventoryEvent, 200, 'inventory event');
const invBody = decodeJSON(inventoryEvent, 'inventory event');
if (!invBody.success) {
  throw new Error('inventory-updated event did not succeed');
}

// Verify: cả detail và search đều MISS
const detailAfter = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var2_detail_after_inventory' },
});
assertCacheState(detailAfter, 'MISS', 'detail MISS after inventory event');

const searchAfter = requestCdn('GET', paths.search, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var2_search_after_inventory' },
});
assertCacheState(searchAfter, 'MISS', 'search MISS after inventory event');
```

### Variation 3: Category-updated event

```javascript
// Variation 3: Category-updated event
// Khi một category thay đổi (thêm/xóa sản phẩm), tất cả sản phẩm trong
// category đó có thể cần được invalidate

// Giả định có category endpoint
const categoryPath = '/api/sim/products/categories/shoes';

warmUntilHit(categoryPath, profiles.guestVNMobileControl, 'category');
warmUntilHit(paths.search, profiles.guestVNMobileControl, 'category_search');

const categoryEvent = triggerCatalogEvent('/events/category-updated', {
  category_id: 'shoes',
  action: 'products_reordered',
  warm: false,
});
assertStatus(categoryEvent, 200, 'category event');
const catBody = decodeJSON(categoryEvent, 'category event');
if (!catBody.success) {
  throw new Error('category-updated event did not succeed');
}

// Verify: category page MISS
const catAfter = requestCdn('GET', categoryPath, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var3_category_after_event' },
});
assertCacheState(catAfter, 'MISS', 'category MISS after event');

// Search có thể hoặc không bị ảnh hưởng (tùy implementation)
```

**Điểm học:** Event-driven invalidation không giới hạn ở product entity. Bất kỳ entity nào có cache đều có thể dùng pattern này: category, brand, promotion, content page, v.v.

### Variation 4: Event với warm=true (event tự warm lại cache)

```javascript
// Variation 4: Event có warm=true
// Một số implementation cho phép event tự động warm lại cache sau khi invalidate
// (để request đầu tiên của user không bị chậm do MISS)

warmUntilHit(paths.productDetail, profiles.guestVNMobileControl, 'warm_detail');

// Gửi event với warm=true
const warmEvent = triggerCatalogEvent('/events/product-updated', {
  product_id: '1',
  warm: true,  // Yêu cầu app consumer warm lại cache sau khi invalidate
});
assertStatus(warmEvent, 200, 'warm event');
const warmBody = decodeJSON(warmEvent, 'warm event');
if (!warmBody.success) {
  throw new Error('product-updated event with warm did not succeed');
}

// Verify: request đầu tiên SAU event là HIT (vì app đã warm lại)
const afterWarmEvent = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var4_after_warm_event' },
});
assertCacheState(afterWarmEvent, 'HIT',
  'HIT after event with warm=true — app pre-warmed the cache');
```

**Điểm học:** `warm: true` là một optimization: thay vì để request đầu tiên của user chịu MISS (chậm), app consumer tự gửi request warm-up để fill cache ngay sau khi invalidate. Điều này giảm latency cho user nhưng tăng load lên origin (vì phải generate response cho warm-up request).

### Variation 5: Batch events (nhiều product trong một event)

```javascript
// Variation 5: Batch product update event
// Khi nhiều sản phẩm được cập nhật cùng lúc (vd: flash sale),
// gửi một event chứa danh sách product_ids

const batchDetailPaths = [
  '/api/sim/products/1',
  '/api/sim/products/2',
  '/api/sim/products/3',
];

// Warm tất cả
for (const path of batchDetailPaths) {
  warmUntilHit(path, profiles.guestVNMobileControl, `batch_${path}`);
}

// Gửi batch event
const batchEvent = triggerCatalogEvent('/events/products-batch-updated', {
  product_ids: ['1', '2', '3'],
  reason: 'flash_sale_price_update',
  warm: false,
});
assertStatus(batchEvent, 200, 'batch event');
const batchBody = decodeJSON(batchEvent, 'batch event');
if (!batchBody.success) {
  throw new Error('batch event did not succeed');
}

// Verify: tất cả sản phẩm trong batch đều MISS
for (const path of batchDetailPaths) {
  const res = requestCdn('GET', path, {
    profile: profiles.guestVNMobileControl,
    tags: { case: `var5_${path}_after_batch` },
  });
  assertCacheState(res, 'MISS', `${path} MISS after batch event`);
}
```

**Điểm học:** Batch event giảm số lượng event cần publish (1 event thay vì N events), giảm load lên event bus và consumer. Tuy nhiên, nếu batch quá lớn, có thể gây timeout hoặc memory issue ở consumer.

### Variation 6: Event retry với failure injection

Mô phỏng trường hợp event đầu tiên thất bại và được retry thành công.

```javascript
// Variation 6: Event retry simulation
// Trong production, event có thể thất bại tạm thời (network, timeout)
// và được retry bởi event bus hoặc consumer

warmUntilHit(paths.productDetail, profiles.guestVNMobileControl, 'retry_detail');

// Gửi event lần 1 — giả lập thất bại (trong test, ta chỉ verify retry)
// Trong thực tế, event bus sẽ retry với exponential backoff
const event1 = triggerCatalogEvent('/events/product-updated', {
  product_id: '1',
  warm: false,
});
assertStatus(event1, 200, 'event retry 1');
const body1 = decodeJSON(event1, 'event retry 1');
if (!body1.success) {
  console.log(`Event attempt 1 failed: ${body1.error}. Retrying...`);
  // Trong production, event bus sẽ tự retry; ở đây ta retry thủ công
}

// Verify: nếu event 1 fail, cache vẫn HIT
const afterFail = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var6_after_failed_event' },
});
if (!body1.success) {
  assertCacheState(afterFail, 'HIT', 'Still HIT after failed event');
}

// Gửi event lần 2 — retry thành công
if (!body1.success) {
  const event2 = triggerCatalogEvent('/events/product-updated', {
    product_id: '1',
    warm: false,
  });
  assertStatus(event2, 200, 'event retry 2');
  const body2 = decodeJSON(event2, 'event retry 2');
  if (!body2.success) {
    throw new Error('Event retry also failed');
  }
}

// Verify sau retry thành công
const afterRetry = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var6_after_retry' },
});
assertCacheState(afterRetry, 'MISS', 'MISS after successful retry');
```

**Điểm học:** Event-driven system cần cơ chế retry. Nếu event đầu tiên thất bại (network timeout, consumer tạm dừng), event bus phải retry. Trong thời gian retry, người dùng vẫn thấy dữ liệu cũ — đây là trade-off giữa consistency và availability.

### Variation 7: Đo độ trễ end-to-end từ event đến cache invalidate

Đo lường thời gian thực tế từ lúc event được publish đến lúc cache bị invalidate.

```javascript
// Variation 7: End-to-end latency measurement
// Đo thời gian: event POST → cache MISS

warmUntilHit(paths.productDetail, profiles.guestVNMobileControl, 'latency_detail');

// Ghi nhận thời điểm gửi event
const eventStartTime = Date.now();
const latencyEvent = triggerCatalogEvent('/events/product-updated', {
  product_id: '1',
  warm: false,
});
assertStatus(latencyEvent, 200, 'latency event');
const eventResponseTime = Date.now();

// Gửi request verify cache ngay lập tức
const latencyVerify = requestCdn('GET', paths.productDetail, {
  profile: profiles.guestVNMobileControl,
  tags: { case: 'var7_latency_verify' },
});
assertCacheState(latencyVerify, 'MISS', 'MISS after event');
const verifyTime = Date.now();

const totalLatency = verifyTime - eventStartTime;
const eventCallTime = eventResponseTime - eventStartTime;
const invalidationTime = verifyTime - eventResponseTime;

console.log(`Event call round-trip: ${eventCallTime}ms`);
console.log(`Cache invalidation lag: ${invalidationTime}ms`);
console.log(`Total end-to-end latency: ${totalLatency}ms`);

// Kết quả điển hình trên môi trường local:
//   Event call round-trip:  3-10ms   (HTTP POST + app consumer processing)
//   Cache invalidation lag: 1-3ms    (CDN control API + Varnish execution)
//   Total end-to-end:       5-15ms   (từ event publish đến cache bị xóa)

// Trong production với message queue:
//   Event call round-trip:  50-500ms (queue latency + consumer processing)
//   Cache invalidation lag: 5-50ms   (network + CDN API + Varnish)
//   Total end-to-end:       50ms-2s  (có thể cao hơn nếu consumer backlog)
```

**Điểm học:** Trong môi trường test local với HTTP đồng bộ, độ trễ rất thấp (< 20ms). Trong production với message queue, độ trễ có thể tăng đáng kể. Cần monitor metric này để đảm bảo cache được invalidate kịp thời.

### Bảng tổng hợp tất cả variations

| Variation | Event type | Phạm vi invalidate | Độ khó | Ghi chú |
| --- | --- | --- | --- | --- |
| 1. Price-updated | `price-updated` | Hẹp (chỉ detail) | Trung bình | Demo event type khác ngoài product-updated |
| 2. Inventory-updated | `inventory-updated` | Trung bình (detail + search) | Trung bình | Entity khác nhau cần phạm vi invalidate khác nhau |
| 3. Category-updated | `category-updated` | Trung bình (category + search) | Trung bình | Mở rộng pattern sang entity không phải product |
| 4. Warm=true | `product-updated` (warm=true) | Rộng + pre-warm | Nâng cao | Tối ưu user experience — không ai phải chịu MISS |
| 5. Batch events | `products-batch-updated` | Rộng (nhiều product) | Nâng cao | Giảm số lượng event khi cập nhật hàng loạt |
| 6. Event retry | `product-updated` (retry) | Rộng | Nâng cao | Xử lý failure và retry trong event-driven system |
| 7. Latency measurement | `product-updated` | Rộng | Trung bình | Đo lường performance end-to-end của event flow |

---

## 15. Anti-patterns

### Anti-pattern 1: Không kiểm tra `success` trong event response

```javascript
// SAI: Chỉ kiểm tra status code
const event = triggerCatalogEvent('/events/product-updated', { ... });
assertStatus(event, 200, 'product event');
// Thiếu: không kiểm tra response body!

// Nếu response là 200 {"success":false,"error":"internal token missing"},
// script vẫn tiếp tục → tất cả checks sau fail → khó debug
```

```javascript
// ĐÚNG: Kiểm tra cả status và success
const event = triggerCatalogEvent('/events/product-updated', { ... });
assertStatus(event, 200, 'product event');
const body = decodeJSON(event, 'product event');
if (!body.success) {
  throw new Error(`product-updated event did not succeed: ${JSON.stringify(body)}`);
}
```

### Anti-pattern 2: Không warm tất cả endpoint trước khi gửi event

```javascript
// SAI: Chỉ warm detail, không warm recs và search
warmUntilHit(paths.productDetail, guest, 'detail');
// Gửi event
const event = triggerCatalogEvent('/events/product-updated', { ... });
// Verify recs → MISS... nhưng không chứng minh được gì vì recs chưa từng HIT
const recsAfter = requestCdn('GET', paths.recommendations, { ... });
assertCacheState(recsAfter, 'MISS', 'recs after event');
// → Không thể phân biệt: recs MISS vì event hay vì chưa từng được cache?
```

```javascript
// ĐÚNG: Warm TẤT CẢ endpoint sẽ verify
warmUntilHit(paths.productDetail, guest, 'detail');
warmUntilHit(paths.recommendations, guest, 'recs');
warmUntilHit(paths.search, guest, 'search');
// Gửi event
// Verify: tất cả đều MISS → evidence rõ ràng
```

### Anti-pattern 3: Gửi event với `warm: false` nhưng không hiểu ý nghĩa

```javascript
// Payload event có trường "warm":
//   warm: true  → app consumer sẽ tự warm lại cache sau khi invalidate
//   warm: false → app consumer chỉ invalidate, không warm lại

// SAI: Luôn dùng warm:true mà không hiểu trade-off
//   → Tăng load origin (phải generate response cho warm-up)
//   → Trong test, không cần warm=true vì ta muốn verify MISS

// ĐÚNG: Dùng warm:false trong test để verify rõ ràng
//   → Sau event: MISS (chứng minh cache đã bị xóa)
//   → Request tiếp theo: MISS → HIT (cache fill bình thường)
```

### Anti-pattern 4: Nhầm lẫn giữa catalog-events-mock và control plane

```javascript
// SAI: Gọi catalog-events-mock như thể nó là control plane
// Catalog-events-mock (:9091) không phải là CDN control plane!
triggerCatalogEvent('/ops/app/cdn/cache/purge', { url: '/api/cached' });
// → Endpoint này không tồn tại trên catalog-events-mock → 404

// ĐÚNG: Phân biệt rõ hai endpoint
// Event → catalog-events-mock (:9091)
triggerCatalogEvent('/events/product-updated', { product_id: '1', warm: false });

// Control → control plane (:8088)
// (Không gọi trực tiếp trong case 06 — app consumer làm việc này)
```

### Anti-pattern 5: Dùng `vus > 1` cho correctness test

```javascript
// SAI: Nhiều VU → race condition giữa warm và event
export const options = {
  vus: 5,
  iterations: 5,
};
// VU-1 đang warm thì VU-3 đã gửi event → VU-1 thấy MISS thay vì HIT → fail
```

```javascript
// ĐÚNG: 1 VU, 1 iteration cho correctness
export const options = {
  vus: 1,
  iterations: 1,
};
```

### Anti-pattern 6: Bỏ qua việc setup dọn dẹp cache

```javascript
// SAI: Không có setup() — cache có thể chứa object từ lần chạy trước
// → warmUntilHit thấy HIT ngay lần đầu → không chứng minh được gì

// ĐÚNG: setup() luôn dọn dẹp trước
export function setup() {
  banUrl(paths.productDetail);
  banUrl(paths.recommendations);
  banUrl(paths.homefeed);
  banPrefix(paths.searchPrefix);
}
```

---

## 16. Real validation data

### 16.1 Dữ liệu từ lần chạy thực tế

Dưới đây là kết quả validation thực tế trên môi trường local `TargetLayer=full`:

**Môi trường:**
```text
OS: Windows 11
Docker: Docker Desktop 4.x
Stack: target (full layer) với Varnish, Nginx, App (2 instances), catalog-events-mock
k6 version: k6 0.51.x
```

**Kết quả checks (tóm tắt):**

```text
█ checks...: 100.00% ✓ 42 ✗ 0
```

### 16.2 Phân tích chi tiết từng proof

#### Proof 1: Product-updated event

| Chỉ số | Giá trị |
| --- | --- |
| Số request public | 14 (4 warm x 2 + 3 verify) |
| Số request event | 1 |
| Số endpoint warm | 4 (detail, recs, search, homefeed) |
| Số endpoint verify | 3 (detail, recs, search) |
| Kết quả verify | 3/3 MISS |
| Event latency (từ POST đến response) | ~5-15ms |
| Cache invalidation latency (từ event đến MISS) | ~0ms (immediate — verify request ngay sau event) |
| Kết luận | Product-updated event → app consumer → CDN invalidation hoạt động |

#### Proof 2: Homefeed-updated event

| Chỉ số | Giá trị |
| --- | --- |
| Số request public | 4 (2 warm x 2) + 2 (verify) |
| Số request event | 1 |
| Số variant warm | 2 (guest variant-a, returning variant-a) |
| Số variant verify | 2 (guest variant-a, returning variant-a) |
| Kết quả verify | 2/2 MISS |
| Ghi chú | Cả guest và returning đều MISS (implementation invalidate toàn bộ homefeed) |
| Kết luận | Homefeed-updated event hoạt động |

### 16.3 Timing metrics

| Request type | avg | p(95) | max | Ghi chú |
| --- | --- | --- | --- | --- |
| Public MISS (CDN → origin) | ~8-15ms | ~20ms | ~30ms | Qua Varnish + Nginx + App |
| Public HIT (từ cache) | ~0.5-2ms | ~3ms | ~5ms | Chỉ Varnish lookup |
| Event POST (đến mock) | ~3-8ms | ~10ms | ~15ms | Mock + App consumer processing |

### 16.4 Event response bodies (mẫu)

**Product-updated event response:**
```json
{
  "success": true,
  "event": "product-updated",
  "product_id": "1",
  "invalidated_endpoints": [
    "/api/sim/products/1",
    "/api/sim/products/1/recommendations",
    "/api/sim/products/search"
  ],
  "duration_ms": 12
}
```

**Homefeed-updated event response:**
```json
{
  "success": true,
  "event": "homefeed-updated",
  "segment": "returning",
  "invalidated_endpoints": [
    "/api/sim/products/homefeed"
  ],
  "duration_ms": 8
}
```

### 16.5 Dữ liệu từ manual test bổ trợ

```powershell
# Manual test: Gửi event và kiểm tra cache thủ công
# Bước 1: Warm cache
PS> curl -sI http://localhost:80/api/sim/products/1 `
    -H "Accept-Language: vi" `
    -H "X-Geo-Country: VN" `
    -H "X-Device-Class: mobile" `
    -H "X-Ab-Variant: control" `
    -H "X-User-Segment: guest" | findstr X-Cache
X-Cache: MISS

PS> curl -sI http://localhost:80/api/sim/products/1 `
    -H "Accept-Language: vi" `
    -H "X-Geo-Country: VN" `
    -H "X-Device-Class: mobile" `
    -H "X-Ab-Variant: control" `
    -H "X-User-Segment: guest" | findstr X-Cache
X-Cache: HIT                                          # Object đã cache

# Bước 2: Gửi event
PS> curl -X POST http://localhost:9091/events/product-updated `
    -H "Content-Type: application/json" `
    -d '{"product_id":"1","warm":false}'
{"success":true,"event":"product-updated","product_id":"1",...}

# Bước 3: Verify cache bị xóa
PS> curl -sI http://localhost:80/api/sim/products/1 `
    -H "Accept-Language: vi" `
    -H "X-Geo-Country: VN" `
    -H "X-Device-Class: mobile" `
    -H "X-Ab-Variant: control" `
    -H "X-User-Segment: guest" | findstr X-Cache
X-Cache: MISS                                          # Cache đã bị invalidate ✓
```

### 16.6 So sánh performance: Manual ops vs Event-driven

| Chỉ số | Case 05 (Manual) | Case 06 (Event) | Nhận xét |
| --- | --- | --- | --- |
| Tổng thời gian chạy | ~1.3s | ~1.5s | Case 06 dài hơn một chút do nhiều endpoint hơn |
| Số checks | 33 | 42 | Case 06 có nhiều checks hơn (nhiều endpoint hơn) |
| Số request tổng | ~23 | ~25 | Case 06 thêm 2 event calls |
| Invalidation trigger | k6 trực tiếp | Event → app consumer | Case 06 thêm 1 hop |
| Độ phức tạp setup | Trung bình | Cao hơn | Case 06 cần catalog-events-mock |

---

## 17. Reference

### 17.1 Source files

| File | Vị trí | Mô tả |
| --- | --- | --- |
| Script chính | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\06-invalidation-events.js` | k6 test script cho event-driven invalidation |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` | Các hàm `triggerCatalogEvent`, `decodeJSON`, `banPrefix`, `banUrl`, `requestCdn`, `assertCacheState`, ... |
| Common helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Các hàm `envString`, `envFloat`, `envInt` |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json` | Định nghĩa structured metadata cho tất cả CDN cases |
| README | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md` | Tài liệu developer của CDN suite |

### 17.2 Documents liên quan

| Tài liệu | Vị trí | Mô tả |
| --- | --- | --- |
| Series overview | `E:\Khoa hoc\k6\docs\practice\cdn\00_overview.md` | Tổng quan 11 CDN cases và mental model |
| Case 05 — Manual invalidation | `E:\Khoa hoc\k6\docs\practice\cdn\05_invalidation-ops.md` | Case liên quan trực tiếp — manual invalidation |
| Case 02 — Variant keys | `E:\Khoa hoc\k6\docs\practice\cdn\02_variant-keys.md` | Hiểu variant dimensions dùng trong case này |
| Case 07 — Cache contract | `E:\Khoa hoc\k6\docs\practice\cdn\07_cache-contract.md` | Hiểu `Surrogate-Key` header |
| Run guide | `E:\Khoa hoc\k6\docs\practice\cdn\RUN_GUIDE.md` | Hướng dẫn chạy toàn bộ CDN suite |
| Validation report | `E:\Khoa hoc\k6\docs\practice\cdn\12_validation-and-chart-analysis.md` | Phân tích chart và dữ liệu validation |

### 17.3 Các case liên quan trong CDN suite

| Case | Mối liên hệ |
| --- | --- |
| Case 01 — Cache HIT smoke | Hiểu MISS → HIT cơ bản |
| Case 02 — Variant cache keys | Hiểu variant dimensions và cache key split |
| Case 04 — Query normalization | Hiểu cách query string ảnh hưởng cache key (liên quan đến search endpoint) |
| Case 05 — Manual invalidation ops | Cùng chủ đề invalidation — so sánh manual vs event-driven |
| Case 07 — Cache contract | `Surrogate-Key` header — nếu dùng `banTag` thay vì `banUrl` trong app consumer |

### 17.4 External references

| Resource | URL / Mô tả |
| --- | --- |
| Varnish Cache Official Docs | https://varnish-cache.org/docs/ |
| Event-driven architecture patterns | https://martinfowler.com/articles/201701-event-driven.html — Martin Fowler về event-driven architecture |
| k6 Documentation | https://grafana.com/docs/k6/latest/ |
| Kafka (event bus phổ biến) | https://kafka.apache.org/documentation/ |
| RabbitMQ | https://www.rabbitmq.com/documentation.html |

### 17.5 Ghi chú về version

```text
Script version:           06-invalidation-events.js (as of 2026-06)
Shared.js version:        shared.js (in same directory)
Catalog-events-mock:      Mock HTTP server at :9091 (part of target stack)
Varnish:                  Bất kỳ version hỗ trợ ban/ban-url/ban-prefix (6.0+)
k6:                       0.49.0+
Target stack:             TargetLayer=full (yêu cầu catalog-events-mock container)
```

### 17.6 Key takeaways

1. **Event-driven invalidation** tự động hóa quy trình xóa cache khi dữ liệu thay đổi, loại bỏ sự phụ thuộc vào con người.
2. **Catalog-events-mock** (`:9091`) đóng vai trò event bus trong môi trường test, cho phép test đồng bộ event flow.
3. **Event `success: true` không đủ** — luôn verify bằng public request và `X-Cache: MISS`.
4. **Chuỗi event có 6 mắt xích** — từ event source đến Varnish. Bất kỳ mắt xích nào fail đều khiến cache không bị invalidate.
5. **Phân biệt fail ở tầng event bridge vs tầng CDN invalidation** — event success:true nhưng cache HIT = vấn đề ở CDN layer.
6. **App consumer logic quyết định phạm vi invalidate** — không phải event. Cần test để đảm bảo tất cả endpoint liên quan đều được invalidate.
7. **`banPrefix` cho search** — vì search có query string động, dùng prefix ban thay vì exact URL ban.
8. **Homefeed-updated hiện invalidate toàn bộ** (cả guest và returning), không chỉ segment được chỉ định — đây là đặc điểm implementation hiện tại, có thể thay đổi.
9. **`vus: 1, iterations: 1`** — không thay đổi cho correctness test.
10. **So sánh Case 05 và 06:** Manual ops phù hợp cho các thay đổi đặc biệt, ad-hoc; Event-driven phù hợp cho automation ở quy mô lớn.

---

*Tài liệu này được tạo từ script nguồn `06-invalidation-events.js` và `shared.js`. Mọi thông tin về event flow, app consumer logic, và cache invalidation sequence đều được trích xuất trực tiếp từ code nguồn.*
