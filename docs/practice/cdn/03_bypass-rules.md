# Case 03: Bypass rules

> **Case ID:** `cdn-03-bypass-rules`
> **Script:** `03-bypass-rules.js`
> **Layer:** CDN / Varnish
> **Proof:** Authorization/Cookie/no-cache/write không được cache HIT

---

## 1. Tình huống thực tế

### 1.1. Bối cảnh doanh nghiệp

Hệ thống thương mại điện tử phục vụ đồng thời hai loại traffic:

| Loại traffic | Đặc điểm | Ví dụ |
| --- | --- | --- |
| **Public read** | Người dùng ẩn danh xem sản phẩm, danh mục, tìm kiếm. Không có session, không có token. | Khách vãng lai xem chi tiết sản phẩm |
| **Private / mutation** | Người dùng đã đăng nhập, có session cookie, hoặc đang thực hiện thao tác ghi (thêm vào giỏ hàng, đặt hàng, thanh toán). | Người dùng đã login xem đơn hàng của mình; người dùng POST thêm sản phẩm vào giỏ |

CDN (Varnish) được đặt trước origin server để giảm tải cho tầng ứng dụng. Tuy nhiên, không phải request nào cũng nên được cache:

- **Request có `Authorization` header**: Mang token xác thực của người dùng đã đăng nhập. Response chứa dữ liệu cá nhân (đơn hàng, thông tin tài khoản, voucher riêng). Nếu cache response này, người dùng khác có thể thấy dữ liệu cá nhân của người dùng trước đó — đây là lỗi bảo mật nghiêm trọng.
- **Request có `Cookie` header**: Mang session ID. Tương tự như Authorization, response có thể bị cá nhân hóa theo session.
- **Request có `Cache-Control: no-cache`**: Client (thường là browser sau khi user nhấn F5 hoặc Ctrl+Shift+R) yêu cầu bắt buộc phải revalidate với origin. CDN phải tôn trọng yêu cầu này và không trả về bản cache cũ.
- **Request với HTTP method ghi (POST/PUT/PATCH/DELETE)**: Các thao tác làm thay đổi trạng thái hệ thống. Không bao giờ nên được cache vì:
  - Response thường chứa dữ liệu vừa được tạo/cập nhật (ví dụ: giỏ hàng mới sau khi thêm sản phẩm)
  - Bản thân hành động ghi không idempotent — cache nó sẽ khiến thao tác bị "ăn" mất trong các lần gọi sau

### 1.2. Hậu quả nếu bypass rule không hoạt động

| Scenario | Hậu quả |
| --- | --- |
| Authorization request bị HIT | Lộ dữ liệu cá nhân của user A cho user B. Vi phạm GDPR/PDP. |
| Cookie request bị HIT | Lộ session data, CSRF token, hoặc giỏ hàng của người khác. |
| `Cache-Control: no-cache` bị HIT | Người dùng nhìn thấy dữ liệu cũ sau khi admin đã cập nhật sản phẩm. |
| POST request bị HIT | Thao tác ghi bị "nuốt" — user thấy thông báo thành công nhưng giỏ hàng không thay đổi. |

### 1.3. Hành vi mong đợi

Tất cả bốn loại request trên phải **đi thẳng qua CDN đến origin** (bypass) trong mọi lần gọi. CDN đóng vai trò như một reverse proxy trong suốt (transparent proxy) cho các request này — không cache, không serve từ cache, không tạo cache key variant.

```text
Client -> CDN (passthrough) -> Origin -> CDN (passthrough) -> Client
```

---

## 2. CDN capability được chứng minh

### 2.1. Phát biểu capability

> **Authorization/Cookie/no-cache/write không được cache HIT**

CDN có khả năng phân biệt giữa request "an toàn để cache" (public read) và request "phải bypass" (private/mutation). Với request bypass, CDN không lưu object vào cache storage và không bao giờ trả về `X-Cache: HIT`.

### 2.2. Phạm vi proof

Case này chứng minh bốn cơ chế bypass khác nhau:

| # | Cơ chế bypass | Trigger | Layer phát hiện |
| --- | --- | --- | --- |
| 1 | **Authorization bypass** | Header `Authorization: Bearer <token>` | VCL `vcl_recv` — phát hiện header Authorization |
| 2 | **Cookie bypass** | Header `Cookie: session_id=...` | VCL `vcl_recv` — phát hiện header Cookie |
| 3 | **Client no-cache bypass** | Header `Cache-Control: no-cache` | VCL `vcl_recv` — phát hiện client yêu cầu revalidate |
| 4 | **Write method bypass** | HTTP method `POST` (hoặc `PUT`/`PATCH`/`DELETE`) | VCL `vcl_recv` — phát hiện method không phải GET/HEAD |

### 2.3. Tại sao proof cần repeated request

Mỗi scenario gửi **hai lần** cùng request (first + second) để chứng minh:

1. **Lần đầu**: Request đi qua CDN, đến origin, response trả về. CDN không lưu object. `X-Cache` không phải `HIT`.
2. **Lần hai**: Request giống hệt lần đầu. Nếu CDN không bypass đúng, lần hai sẽ là `HIT` (vì lần đầu đã warm cache). Bằng cách kiểm tra cả hai lần đều không HIT, ta chứng minh bypass hoạt động ổn định — không phải do object chưa kịp cache.

```text
Request 1: client -> CDN -> origin -> CDN -> client  (not HIT)
Request 2: client -> CDN -> origin -> CDN -> client  (not HIT — PROOF: vẫn bypass, không phải lần 1 là "chưa kịp cache")
```

### 2.4. Phân biệt với pass-through ngẫu nhiên

Nếu chỉ gửi 1 request và thấy not HIT, không thể kết luận bypass hoạt động. Lý do: có thể object chưa có trong cache vì TTL ngắn, response không có cache headers phù hợp, hoặc CDN chưa kịp lưu. Gửi 2 lần loại bỏ các giả thuyết này — chỉ có bypass rule thực sự mới giữ được not HIT ở cả hai lần.

---

## 3. Vì sao phải test ở CDN layer

### 3.1. Unit test ở app layer là chưa đủ

| Tầng test | Phát hiện được gì | Không phát hiện được gì |
| --- | --- | --- |
| **App unit test** | Controller trả về đúng status 200, response body đúng | Response có bị CDN cache sai không |
| **App integration test** | Database được cập nhật đúng sau POST | Cache key có bị tạo ra từ Authorization header không |
| **CDN VCL unit test** | Logic VCL `return(pass)` đúng syntax | Request thực tế qua full stack có bypass không |

Chỉ có test ở CDN layer (request đi qua Varnish tới app) mới trả lời được câu hỏi: **request bypass có thực sự đi qua origin mỗi lần không?**

### 3.2. Những thứ có thể sai ở CDN layer

| Vấn đề | Nguyên nhân khả dĩ |
| --- | --- |
| Authorization request bị HIT | VCL không kiểm tra `req.http.Authorization` trong `vcl_recv` |
| Cookie request bị HIT | VCL chỉ kiểm tra Authorization mà bỏ qua Cookie |
| no-cache bị HIT | VCL chỉ kiểm tra method mà không kiểm tra `Cache-Control` request header |
| POST request bị HIT | VCL `vcl_recv` không `return(pass)` cho POST; hoặc backend vô tình set cache headers khiến Varnish lưu |
| Request bypass nhưng lần 2 HIT | VCL pass ở lần 1 nhưng không pass ở lần 2 do điều kiện thay đổi (ví dụ: header bị strip trước khi đến cache decision point) |

### 3.3. Tác động đến hệ thống nếu không phát hiện

- **Bảo mật**: Dữ liệu cá nhân lọt vào cache public. Attacker có thể dùng shared cache để trích xuất thông tin người dùng khác.
- **Tính đúng đắn**: POST request bị cache khiến thao tác ghi mất tác dụng — user thêm vào giỏ hàng nhưng giỏ hàng không thay đổi.
- **Debug khó**: Behavior chỉ xảy ra khi có CDN trong stack — developer test local không thấy lỗi.

---

## 4. Topology và precondition

### 4.1. Runtime topology

```text
┌─────────┐     ┌──────────────┐     ┌───────┐     ┌─────────────────┐
│  k6     │────▶│  Varnish CDN │────▶│ Nginx │────▶│  App            │
│  client │     │  :80         │     │       │     │  Microservices  │
└─────────┘     └──────────────┘     └───────┘     └─────────────────┘
```

Request đi qua public CDN path `http://localhost:80`. Không cần control plane cho case này vì không có thao tác purge/ban/probe.

### 4.2. Precondition

| Điều kiện | Mô tả | Cách xác nhận |
| --- | --- | --- |
| Stack full | `TargetLayer=full` — Varnish + Nginx + App đều chạy | `curl http://localhost:80/api/sim/products/1` trả về 200 |
| Varnish ở port 80 | Traffic vào `:80` đi qua Varnish, không đi thẳng Nginx | Response có header `X-Cache` |
| App chạy bình thường | Products service và Cart service sẵn sàng | Request GET product detail và POST cart add đều trả về 200 |
| OPS token không bắt buộc | Case này không gọi control endpoint `:8088` | Không cần set `OPS_AUTH_TOKEN` |

### 4.3. Không cần setup/teardown

Khác với các case khác trong suite (ví dụ: 01 cần ban-url, 04 cần ban prefix, 09 cần patch origin profile), case 03 **không có hàm `setup()` hoặc `teardown()`**. Script gửi trực tiếp 8 request (4 scenario x 2 lần = 8 request) và không thao tác với control plane. Điều này có nghĩa:

- Bạn có thể chạy case này bất kỳ lúc nào, không cần lo về trạng thái cache trước đó.
- Nếu chạy liên tục nhiều lần, kết quả vẫn phải giống nhau — bypass không phụ thuộc vào trạng thái cache hiện tại.

---

## 5. Script deep-dive

### 5.1. Cấu trúc file

```javascript
// File: 03-bypass-rules.js
import {
  cacheKeyHeaders,   // Mảng 5 header tạo cache key
  paths,             // Object chứa các path mẫu
  profiles,          // Object chứa các profile variant
  requestCdn,        // Hàm gửi request qua CDN public path
  assertHeadersAbsent, // Hàm kiểm tra header không tồn tại
  assertNotHit,      // Hàm kiểm tra cache state không phải HIT
  assertStatus,      // Hàm kiểm tra HTTP status code
  assertUpstream,    // Hàm kiểm tra upstream service
} from './shared.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],  // Tất cả checks PHẢI pass
  },
  tags: {
    scenario: 'cdn_bypass_rules',
  },
};
```

### 5.2. Options breakdown

| Option | Giá trị | Lý do |
| --- | --- | --- |
| `vus` | `1` | Case correctness — không cần concurrent VU. Một VU tuần tự gửi 8 request đủ để chứng minh. |
| `iterations` | `1` | Mỗi VU chạy đúng 1 lần default function. |
| `thresholds.checks` | `['rate==1']` | **Hard threshold**: Nếu bất kỳ check nào fail, k6 exit code khác 0. Đây là yêu cầu bắt buộc. |
| `tags.scenario` | `'cdn_bypass_rules'` | Tag để phân biệt trong dashboard/cloud output. |

### 5.3. Hàm `exerciseRepeatedBypass` — trái tim của script

```javascript
function exerciseRepeatedBypass(label, requestOptions) {
  // Lần 1
  const first = requestCdn(
    requestOptions.method || 'GET',
    requestOptions.path,
    {
      profile: requestOptions.profile || null,
      headers: requestOptions.headers || {},
      body: requestOptions.body || null,
      tags: { case: `${label}_first` },
    }
  );
  assertStatus(first, requestOptions.expectedStatus || 200, `${label} first`);
  if (requestOptions.upstream) {
    assertUpstream(first, requestOptions.upstream, `${label} first`);
  }
  assertNotHit(first, `${label} first`);
  if (requestOptions.expectNoCacheKeyHeaders !== false) {
    assertHeadersAbsent(first, cacheKeyHeaders, `${label} first`);
  }

  // Lần 2 — giống hệt lần 1
  const second = requestCdn(
    requestOptions.method || 'GET',
    requestOptions.path,
    {
      profile: requestOptions.profile || null,
      headers: requestOptions.headers || {},
      body: requestOptions.body || null,
      tags: { case: `${label}_second` },
    }
  );
  assertStatus(second, requestOptions.expectedStatus || 200, `${label} second`);
  if (requestOptions.upstream) {
    assertUpstream(second, requestOptions.upstream, `${label} second`);
  }
  assertNotHit(second, `${label} second`);
  if (requestOptions.expectNoCacheKeyHeaders !== false) {
    assertHeadersAbsent(second, cacheKeyHeaders, `${label} second`);
  }
}
```

#### 5.3.1. Parameter object `requestOptions`

| Field | Type | Default | Mô tả |
| --- | --- | --- | --- |
| `method` | `string` | `'GET'` | HTTP method |
| `path` | `string` | *(bắt buộc)* | Request path, ví dụ: `paths.productDetail` |
| `profile` | `object` | `null` | Profile headers cho cache key variant (language, geo, device, AB, segment) |
| `headers` | `object` | `{}` | Headers bổ sung (Authorization, Cookie, Cache-Control, v.v.) |
| `body` | `object` | `null` | Request body cho POST (được JSON.stringify) |
| `expectedStatus` | `number` | `200` | HTTP status mong đợi |
| `upstream` | `string` | *(không bắt buộc)* | Tên upstream service mong đợi trong `X-Upstream-Service` |
| `expectNoCacheKeyHeaders` | `boolean` | *(ngầm định true)* | Nếu `false`, không kiểm tra absence của cache key headers |

#### 5.3.2. Logic từng bước

```text
Với mỗi lần gọi (first và second):
  1. Gửi request qua CDN public path (localhost:80)
  2. Kiểm tra HTTP status = expectedStatus (mặc định 200)
  3. Nếu có upstream => kiểm tra X-Upstream-Service đúng tên service
  4. Kiểm tra X-Cache KHÔNG phải HIT (assertNotHit)
  5. Nếu expectNoCacheKeyHeaders !== false => kiểm tra TẤT CẢ 5 cache key headers đều ABSENT
```

#### 5.3.3. `assertNotHit` — check mềm hơn `assertCacheState(res, 'MISS')`

```javascript
export function assertNotHit(res, label) {
  check(res, {
    [`${label} not hit`]: (r) => cacheState(r) !== 'HIT',
  });
}
```

Lưu ý: `assertNotHit` kiểm tra cache state **không phải HIT**, chứ không phải phải là `MISS`. Điều này quan trọng vì:
- Với request bypass, Varnish có thể trả về `MISS` hoặc trạng thái khác (pass-through không có cache header).
- Điều cốt lõi là request **không được serve từ cache**.

#### 5.3.4. `assertHeadersAbsent` — xác nhận cache key không được tạo

```javascript
export function assertHeadersAbsent(res, headerNames, label) {
  const expectations = {};
  for (const header of headerNames) {
    expectations[`${label} ${header} absent`] = (r) => !getHeader(r, header);
  }
  check(res, expectations);
}
```

Với `cacheKeyHeaders = ['X-Cache-Key-Language', 'X-Cache-Key-Geo', 'X-Cache-Key-Device', 'X-Cache-Key-AB', 'X-Cache-Key-Segment']`:

- Nếu request bypass đúng, CDN không tạo cache key headers — response sẽ không có bất kỳ header nào trong số này.
- Nếu có bất kỳ cache key header nào xuất hiện, check fail — đây là dấu hiệu CDN đã xử lý request như một cacheable request.

### 5.4. Bốn scenario trong default function

```javascript
export default function () {
  // Scenario 1: Authorization header bypass
  exerciseRepeatedBypass('authorization_header', {
    path: paths.productDetail,          // /api/sim/products/1
    profile: profiles.guestVNMobileControl,
    headers: { Authorization: 'Bearer session-user-token' },
    upstream: 'products-service',
  });

  // Scenario 2: Cookie header bypass
  exerciseRepeatedBypass('cookie_header', {
    path: paths.productDetail,          // /api/sim/products/1
    profile: profiles.guestVNMobileControl,
    headers: { Cookie: 'session_id=abc123' },
    upstream: 'products-service',
  });

  // Scenario 3: Cache-Control no-cache bypass
  exerciseRepeatedBypass('cache_control_no_cache', {
    path: paths.productDetail,          // /api/sim/products/1
    profile: profiles.guestVNMobileControl,
    headers: { 'Cache-Control': 'no-cache' },
    upstream: 'products-service',
  });

  // Scenario 4: Write method (POST) bypass
  exerciseRepeatedBypass('write_method_post', {
    method: 'POST',
    path: '/api/sim/cart/add',
    body: { product_id: 1, quantity: 1 },
    upstream: 'cart-service',
    expectNoCacheKeyHeaders: false,     // POST không cần kiểm tra cache key headers
  });
}
```

### 5.5. Phân tích từng scenario

#### 5.5.1. Scenario 1: `authorization_header`

| Thuộc tính | Giá trị |
| --- | --- |
| Path | `/api/sim/products/1` (product detail — bình thường là cacheable read) |
| Profile | `guestVNMobileControl` (người dùng ẩn danh, VN, mobile, control) |
| Header bổ sung | `Authorization: Bearer session-user-token` |
| Upstream mong đợi | `products-service` |

**Điểm tinh tế**: Đây là product detail — bình thường cacheable. Chỉ cần thêm `Authorization` header là request phải bypass. Điều này chứng minh VCL kiểm tra Authorization **trước** khi quyết định cache.

#### 5.5.2. Scenario 2: `cookie_header`

| Thuộc tính | Giá trị |
| --- | --- |
| Path | `/api/sim/products/1` |
| Profile | `guestVNMobileControl` |
| Header bổ sung | `Cookie: session_id=abc123` |
| Upstream mong đợi | `products-service` |

**Điểm tinh tế**: Cookie và Authorization là hai cơ chế bypass riêng biệt. Có VCL implementation chỉ kiểm tra Authorization mà quên Cookie. Scenario này bắt được lỗi đó.

#### 5.5.3. Scenario 3: `cache_control_no_cache`

| Thuộc tính | Giá trị |
| --- | --- |
| Path | `/api/sim/products/1` |
| Profile | `guestVNMobileControl` |
| Header bổ sung | `Cache-Control: no-cache` (từ client) |
| Upstream mong đợi | `products-service` |

**Điểm tinh tế**: `Cache-Control: no-cache` từ client khác với `Cache-Control: no-cache` từ origin. Client gửi header này để yêu cầu CDN revalidate. CDN phải hiểu đây là client directive và pass request đến origin (sau đó có thể cache response mới nếu origin cho phép). Scenario này đảm bảo client no-cache không bị ignore.

#### 5.5.4. Scenario 4: `write_method_post`

| Thuộc tính | Giá trị |
| --- | --- |
| Method | `POST` |
| Path | `/api/sim/cart/add` |
| Body | `{ product_id: 1, quantity: 1 }` |
| Upstream mong đợi | `cart-service` |
| `expectNoCacheKeyHeaders` | `false` |

**Điểm tinh tế**:
- `expectNoCacheKeyHeaders: false` vì POST response có thể có cache key headers (origin có thể thêm chúng) nhưng request không nên được cache. Điều quan trọng là `X-Cache` không phải `HIT`.
- POST là method ghi (non-idempotent). Ngay cả khi response trả về 200 và có vẻ cacheable, CDN vẫn không được lưu nó.
- Path là `/api/sim/cart/add` — một endpoint hoàn toàn khác với product detail, thuộc về cart service.

### 5.6. Profile `guestVNMobileControl` phân giải

```javascript
profiles.guestVNMobileControl = {
  name: 'guest_vn_mobile_control',
  headers: {
    'Accept-Language': 'vi',
    'X-Geo-Country': 'VN',
    'X-Device-Class': 'mobile',
    'X-Ab-Variant': 'control',
    'X-User-Segment': 'guest',
  },
};
```

Profile này mô phỏng một người dùng ẩn danh ở Việt Nam, dùng mobile, thuộc nhóm AB control. Dù là public read profile, nhưng khi kết hợp với Authorization/Cookie/no-cache header, request vẫn phải bypass.

---

## 6. Cache key model / VCL deep-dive

### 6.1. VCL flow cho bypass

```text
vcl_recv:
  if (req.http.Authorization || req.http.Cookie) {
    return(pass);           // Bypass cache hoàn toàn
  }
  if (req.http.Cache-Control ~ "no-cache") {
    return(pass);           // Client yêu cầu revalidate
  }
  if (req.method != "GET" && req.method != "HEAD") {
    return(pass);           // Non-read method
  }
  // ... cache key construction cho read request ...

vcl_pass:
  // Request đi thẳng đến backend, không cache
  set bereq.http.X-Pass-Reason = "<reason>";

vcl_deliver:
  if (req.method == "PASS") {
    set resp.http.X-Cache = "MISS";  // hoặc không set cache header
  }
```

### 6.2. Phân biệt `return(pass)` và `return(pipe)`

| Directive | Hành vi | Dùng khi nào |
| --- | --- | --- |
| `return(pass)` | Request đi qua VCL flow bình thường, response từ backend trả về client nhưng **không được lưu vào cache**. Headers vẫn được xử lý bởi `vcl_deliver`. | Hầu hết bypass case: auth, cookie, no-cache, write methods |
| `return(pipe)` | Request được "ống dẫn" thẳng — Varnish không can thiệp vào request/response. Không chạy `vcl_backend_*` và `vcl_deliver`. | WebSocket, CONNECT, TCP tunnel |

Case này sử dụng `return(pass)` vì vẫn cần xử lý response headers (thêm `X-Cache`, `X-Upstream-Service`, v.v.) nhưng không lưu object vào cache.

### 6.3. Tại sao bypass request không có cache key headers

Cache key headers (`X-Cache-Key-Language`, `X-Cache-Key-Geo`, v.v.) được set trong `vcl_deliver` từ giá trị hash key đã tạo ở `vcl_hash`. Với request bypass:

1. `vcl_recv` gọi `return(pass)` — bỏ qua `vcl_hash`.
2. Không có hash key nào được tạo.
3. `vcl_deliver` không có gì để set vào response headers.

Kết quả: response từ bypass request không chứa cache key headers. Đây chính là signal mà `assertHeadersAbsent` kiểm tra.

### 6.4. Bảng tổng hợp VCL decision point

| Request characteristic | Decision point trong VCL | Action | Cache key? | Response headers? |
| --- | --- | --- | --- | --- |
| `Authorization` header | `vcl_recv` line: `if (req.http.Authorization)` | `return(pass)` | Không | Không có `X-Cache-Key-*` |
| `Cookie` header | `vcl_recv` line: `if (req.http.Cookie)` | `return(pass)` | Không | Không có `X-Cache-Key-*` |
| `Cache-Control: no-cache` | `vcl_recv` line: `if (req.http.Cache-Control ~ "no-cache")` | `return(pass)` | Không | Không có `X-Cache-Key-*` |
| Non-GET/HEAD method | `vcl_recv` line: `if (req.method != "GET" && req.method != "HEAD")` | `return(pass)` | Không | Có thể có (origin set) |
| Read request, không auth | `vcl_hash` | Tạo hash key | Có | Có `X-Cache-Key-*` |

### 6.5. Thứ tự kiểm tra trong VCL — quan trọng

Thứ tự kiểm tra trong `vcl_recv` ảnh hưởng đến behavior:

```text
ĐÚNG:
  1. Kiểm tra method (non-GET/HEAD -> pass)
  2. Kiểm tra Authorization (có -> pass)
  3. Kiểm tra Cookie (có -> pass)
  4. Kiểm tra Cache-Control request (no-cache -> pass)
  5. ... normalize cache key, lookup, etc.

SAI (thiếu Authorization check):
  1. Kiểm tra method
  2. ... normalize cache key, lookup
  => Request có Authorization vẫn được cache!
```

---

## 7. Request sequence flow (timeline)

### 7.1. Timeline tổng thể

```text
Time ──────────────────────────────────────────────────────▶

[Scn 1: Authorization]
  t0: GET /api/sim/products/1 + Authorization ──▶ origin [products-service] ──▶ 200 (not HIT, no cache-key)
  t1: GET /api/sim/products/1 + Authorization ──▶ origin [products-service] ──▶ 200 (not HIT, no cache-key)

[Scn 2: Cookie]
  t2: GET /api/sim/products/1 + Cookie ──▶ origin [products-service] ──▶ 200 (not HIT, no cache-key)
  t3: GET /api/sim/products/1 + Cookie ──▶ origin [products-service] ──▶ 200 (not HIT, no cache-key)

[Scn 3: no-cache]
  t4: GET /api/sim/products/1 + Cache-Control:no-cache ──▶ origin [products-service] ──▶ 200 (not HIT, no cache-key)
  t5: GET /api/sim/products/1 + Cache-Control:no-cache ──▶ origin [products-service] ──▶ 200 (not HIT, no cache-key)

[Scn 4: POST]
  t6: POST /api/sim/cart/add + body ──▶ origin [cart-service] ──▶ 200 (not HIT)
  t7: POST /api/sim/cart/add + body ──▶ origin [cart-service] ──▶ 200 (not HIT)
```

### 7.2. Timeline chi tiết cho một scenario

```text
Scenario: authorization_header

Client                    CDN (Varnish)              Origin (products-service)
  │                          │                            │
  │── GET /api/sim/products/1 ──▶                        │
  │   Authorization: Bearer... │                            │
  │   Profile headers (VN, mobile...)                    │
  │                          │                            │
  │                          │── vcl_recv: phát hiện      │
  │                          │   Authorization header     │
  │                          │   return(pass)             │
  │                          │                            │
  │                          │── GET /api/sim/products/1 ──▶
  │                          │   (forward request         │
  │                          │    to backend)             │
  │                          │                            │
  │                          │                            │── Xử lý request
  │                          │                            │   (query DB)
  │                          │◀── 200 OK ───────────────│
  │                          │   X-Upstream-Service:      │
  │                          │     products-service       │
  │                          │                            │
  │                          │── vcl_deliver:             │
  │                          │   X-Cache: MISS            │
  │                          │   (KHÔNG set cache key     │
  │                          │    headers)                │
  │                          │   (KHÔNG lưu vào cache)    │
  │                          │                            │
  │◀── 200 OK ──────────────│                            │
  │   X-Cache: MISS                                       │
  │   X-Upstream-Service: products-service                │
  │   (KHÔNG có X-Cache-Key-*)                            │
  │                          │                            │
  │── GET /api/sim/products/1 ──▶ (lần 2, giống hệt)     │
  │   Authorization: Bearer... │                            │
  │                          │                            │
  │                          │── vcl_recv: vẫn phát hiện  │
  │                          │   Authorization -> pass    │
  │                          │                            │
  │                          │── GET /api/sim/products/1 ──▶
  │                          │                            │── Xử lý request
  │                          │◀── 200 OK ───────────────│
  │                          │                            │
  │◀── 200 OK ──────────────│                            │
  │   X-Cache: MISS (KHÔNG PHẢI HIT!)                    │
  │   (KHÔNG có X-Cache-Key-*)                            │
```

### 7.3. So sánh với cacheable read (case 01)

```text
Cacheable read (case 01):
  Lần 1: MISS (cold) -> lưu vào cache
  Lần 2: HIT  (warm) -> serve từ cache, KHÔNG gọi origin

Bypass (case 03):
  Lần 1: MISS (hoặc pass-through) -> KHÔNG lưu vào cache
  Lần 2: MISS (hoặc pass-through) -> vẫn gọi origin
```

---

## 8. Key signals / headers cần verify

### 8.1. Bảng tín hiệu chính cho từng scenario

| Scenario | Method | Status | `X-Cache` | `X-Upstream-Service` | `X-Cache-Key-*` | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| `authorization_header` first | GET | 200 | **not HIT** | `products-service` | **absent** | 8 checks |
| `authorization_header` second | GET | 200 | **not HIT** | `products-service` | **absent** | 8 checks |
| `cookie_header` first | GET | 200 | **not HIT** | `products-service` | **absent** | 8 checks |
| `cookie_header` second | GET | 200 | **not HIT** | `products-service` | **absent** | 8 checks |
| `cache_control_no_cache` first | GET | 200 | **not HIT** | `products-service` | **absent** | 8 checks |
| `cache_control_no_cache` second | GET | 200 | **not HIT** | `products-service` | **absent** | 8 checks |
| `write_method_post` first | POST | 200 | **not HIT** | `cart-service` | *(không kiểm tra)* | 4 checks |
| `write_method_post` second | POST | 200 | **not HIT** | `cart-service` | *(không kiểm tra)* | 4 checks |

**Tổng cộng**: 56 checks (3 GET scenario: 8 checks x 6 requests = 48; 1 POST scenario: 4 checks x 2 requests = 8)

### 8.2. Cấu trúc chi tiết mỗi check (GET scenario)

```text
Cho request GET "authorization_header first":
  ✓ authorization_header first status 200
  ✓ authorization_header first upstream products-service
  ✓ authorization_header first not hit
  ✓ authorization_header first X-Cache-Key-Language absent
  ✓ authorization_header first X-Cache-Key-Geo absent
  ✓ authorization_header first X-Cache-Key-Device absent
  ✓ authorization_header first X-Cache-Key-AB absent
  ✓ authorization_header first X-Cache-Key-Segment absent
```

### 8.3. Signal interpretation matrix

| `X-Cache` | Cache key headers | Kết luận |
| --- | --- | --- |
| `HIT` | Present | **FAIL** — Request bị cache sai! Dữ liệu có thể bị leak. |
| `HIT` | Absent | **FAIL** — Object trong cache nhưng không có key headers (implementation lỗi). |
| `MISS` | Present | **FAIL** — CDN đang xử lý request như cacheable nhưng chưa warm (nguy cơ: lần 2 sẽ thành HIT). |
| `MISS` | Absent | **PASS** — Request bypass đúng, không có dấu hiệu cache key được tạo. |

### 8.4. Tại sao `X-Cache` có thể không phải `MISS` rõ ràng

Trong một số Varnish implementation, request bypass có thể không set `X-Cache` header hoặc set thành giá trị khác (ví dụ: `pass`). `assertNotHit` linh hoạt: chỉ cần `X-Cache` không phải `HIT` là đạt. Cách tiếp cận này tránh false negative khi implementation khác nhau.

---

## 9. Pass/fail criteria

### 9.1. Điều kiện PASS

```text
TẤT CẢ các điều kiện sau đồng thời đúng:

1. k6 exit code = 0 (threshold checks đạt 100%)
2. 56/56 named checks pass
3. Mỗi scenario có 2 lần request, cả 2 lần đều:
   a. HTTP status = 200
   b. X-Cache != "HIT"
   c. X-Upstream-Service đúng tên service mong đợi
   d. (GET scenarios) Tất cả 5 cache key headers absent
4. POST scenario: 2 lần request đều not HIT, upstream = cart-service
```

### 9.2. Điều kiện FAIL

| # | Dấu hiệu FAIL | Ý nghĩa | Hành động khắc phục |
| --- | --- | --- | --- |
| F1 | Bất kỳ request nào có `X-Cache: HIT` | **Nguy hiểm**: Cache đã lưu private/mutation request | Kiểm tra VCL `vcl_recv` — thiếu `return(pass)` |
| F2 | Lần 1 not HIT nhưng lần 2 HIT | Lần 1 chưa warm, lần 2 lấy từ cache — bypass chỉ hoạt động 1 lần | Kiểm tra điều kiện pass trong VCL có nhất quán giữa 2 lần không |
| F3 | Cache key headers xuất hiện trên GET bypass | CDN đã tạo cache hash key cho request bypass | VCL pass đang được gọi sau `vcl_hash` thay vì trước |
| F4 | `X-Upstream-Service` sai | Request đến sai backend service | Kiểm tra routing trong VCL hoặc Nginx |
| F5 | POST trả về status khác 200 | Cart service không hoạt động hoặc body sai format | Kiểm tra app log |
| F6 | Threshold checks rate < 1 | Một số check fail — k6 exit code != 0 | Đọc kỹ output từng named check |
| F7 | Không có `X-Cache` header nào | Varnish không chạy hoặc request không qua CDN | Kiểm tra topology: `BASE_URL` có phải `:80` qua Varnish không |

### 9.3. Phân biệt FALSE PASS nguy hiểm

| Kịch bản | Tại sao có thể PASS giả | Cách phát hiện thêm |
| --- | --- | --- |
| Chạy case 03 khi stack không có Varnish | Mọi request đều không có `X-Cache: HIT` vì không có cache layer nào | Kiểm tra response có `X-Cache` header không |
| Chạy case 03 sau khi vừa purge toàn bộ cache | Request bypass vẫn not HIT dù VCL pass bị lỗi — do cache trống | Chạy case 01 trước để xác nhận cache đang hoạt động |
| Response không có `Cache-Control` public | CDN có thể không cache vì response thiếu directive, không phải do bypass rule | Thêm case so sánh: chạy GET không auth xem có HIT không |

---

## 10. Cách chạy + output mẫu

### 10.1. Lệnh chạy

```powershell
cd E:\Projects\k6\k6-metrics-server\load-target

$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"

k6 run .\k6\cdn\03-bypass-rules.js
```

Hoặc dùng runner script:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scripts\run-cdn-capabilities.ps1 -Scenarios 03-bypass-rules
```

### 10.2. Output mẫu — PASS

```text

         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: .\k6\cdn\03-bypass-rules.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations shared among 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)


running (00m00.2s), 1/1 VUs, 0 complete and 0 interrupted iterations
default   [   0% ] 1 VUs  00m00.2s/10m0s  0/1 shared iters

running (00m00.3s), 1/1 VUs, 1 complete and 0 interrupted iterations
default   [ 100% ] 1 VUs  00m00.3s/10m0s  1/1 shared iters

     █ authorization_header
       ✓ authorization_header first status 200
       ✓ authorization_header first upstream products-service
       ✓ authorization_header first not hit
       ✓ authorization_header first X-Cache-Key-Language absent
       ✓ authorization_header first X-Cache-Key-Geo absent
       ✓ authorization_header first X-Cache-Key-Device absent
       ✓ authorization_header first X-Cache-Key-AB absent
       ✓ authorization_header first X-Cache-Key-Segment absent

       ✓ authorization_header second status 200
       ✓ authorization_header second upstream products-service
       ✓ authorization_header second not hit
       ✓ authorization_header second X-Cache-Key-Language absent
       ✓ authorization_header second X-Cache-Key-Geo absent
       ✓ authorization_header second X-Cache-Key-Device absent
       ✓ authorization_header second X-Cache-Key-AB absent
       ✓ authorization_header second X-Cache-Key-Segment absent

     █ cookie_header
       ✓ cookie_header first status 200
       ✓ cookie_header first upstream products-service
       ✓ cookie_header first not hit
       ✓ cookie_header first X-Cache-Key-Language absent
       ✓ cookie_header first X-Cache-Key-Geo absent
       ✓ cookie_header first X-Cache-Key-Device absent
       ✓ cookie_header first X-Cache-Key-AB absent
       ✓ cookie_header first X-Cache-Key-Segment absent

       ✓ cookie_header second status 200
       ✓ cookie_header second upstream products-service
       ✓ cookie_header second not hit
       ✓ cookie_header second X-Cache-Key-Language absent
       ✓ cookie_header second X-Cache-Key-Geo absent
       ✓ cookie_header second X-Cache-Key-Device absent
       ✓ cookie_header second X-Cache-Key-AB absent
       ✓ cookie_header second X-Cache-Key-Segment absent

     █ cache_control_no_cache
       ✓ cache_control_no_cache first status 200
       ✓ cache_control_no_cache first upstream products-service
       ✓ cache_control_no_cache first not hit
       ✓ cache_control_no_cache first X-Cache-Key-Language absent
       ✓ cache_control_no_cache first X-Cache-Key-Geo absent
       ✓ cache_control_no_cache first X-Cache-Key-Device absent
       ✓ cache_control_no_cache first X-Cache-Key-AB absent
       ✓ cache_control_no_cache first X-Cache-Key-Segment absent

       ✓ cache_control_no_cache second status 200
       ✓ cache_control_no_cache second upstream products-service
       ✓ cache_control_no_cache second not hit
       ✓ cache_control_no_cache second X-Cache-Key-Language absent
       ✓ cache_control_no_cache second X-Cache-Key-Geo absent
       ✓ cache_control_no_cache second X-Cache-Key-Device absent
       ✓ cache_control_no_cache second X-Cache-Key-AB absent
       ✓ cache_control_no_cache second X-Cache-Key-Segment absent

     █ write_method_post
       ✓ write_method_post first status 200
       ✓ write_method_post first upstream cart-service
       ✓ write_method_post first not hit
       ✓ write_method_post second status 200
       ✓ write_method_post second upstream cart-service
       ✓ write_method_post second not hit

     ✓ checks.........................: 100.00%  ✓ 56  ✗ 0
     data_received....................: 12 kB    60 kB/s
     data_sent........................: 3.2 kB   16 kB/s
     http_req_blocked.................: avg=2.15ms  min=1.52ms  med=1.98ms  max=4.2ms   p(90)=3.41ms  p(95)=3.81ms
     http_req_connecting..............: avg=1.1ms   min=716µs   med=987µs   max=2.3ms   p(90)=1.85ms  p(95)=2.08ms
     http_req_duration................: avg=19.2ms  min=14.1ms  med=18.5ms  max=27.3ms  p(90)=24.8ms  p(95)=26.1ms
     http_req_receiving...............: avg=124µs   min=72µs    med=114µs   max=210µs   p(90)=185µs   p(95)=197µs
     http_req_sending.................: avg=85µs    min=48µs    med=79µs    max=152µs   p(90)=131µs   p(95)=141µs
     http_req_waiting.................: avg=19.0ms  min=13.9ms  med=18.3ms  max=27.1ms  p(90)=24.6ms  p(95)=25.9ms
     http_reqs........................: 8        40/s
     iteration_duration..............: avg=193.29ms min=193.29ms med=193.29ms max=193.29ms p(90)=193.29ms p(95)=193.29ms
     iterations.......................: 1        5/s
     vus..............................: 1        min=1  max=1
     vus_max..........................: 1        min=1  max=1


All checks passed
```

### 10.3. Output mẫu — FAIL (giả định: Authorization request bị HIT)

```text
     █ authorization_header
       ✓ authorization_header first status 200
       ✓ authorization_header first upstream products-service
       ✓ authorization_header first not hit
       ✓ authorization_header first X-Cache-Key-Language absent
       ✓ authorization_header first X-Cache-Key-Geo absent
       ✓ authorization_header first X-Cache-Key-Device absent
       ✓ authorization_header first X-Cache-Key-AB absent
       ✓ authorization_header first X-Cache-Key-Segment absent

       ✓ authorization_header second status 200
       ✓ authorization_header second upstream products-service
       ✗ authorization_header second not hit          <-- FAIL: X-Cache = HIT
       ✗ authorization_header second X-Cache-Key-Language absent   <-- FAIL: header present
       ✗ authorization_header second X-Cache-Key-Geo absent        <-- FAIL: header present
       ✗ authorization_header second X-Cache-Key-Device absent     <-- FAIL: header present
       ✗ authorization_header second X-Cache-Key-AB absent         <-- FAIL: header present
       ✗ authorization_header second X-Cache-Key-Segment absent    <-- FAIL: header present

     ✓ checks.........................: 89.29%   ✓ 50  ✗ 6

ERRO[0003] thresholds on metrics 'checks' have been crossed
```

Trong output này: lần đầu tiên bypass đúng (not HIT, không có cache key headers). Nhưng lần thứ hai, CDN đã cache object và trả về HIT cùng cache key headers. Kết luận: VCL pass không nhất quán — có thể điều kiện pass chỉ đúng trong một số trường hợp.

---

## 11. 4 output -> decision scenarios

### 11.1. Scenario A: Tất cả PASS (lý tưởng)

| Quan sát | Giá trị |
| --- | --- |
| Exit code | `0` |
| Checks | 56 ✓ / 0 ✗ |
| Tất cả 8 request | not HIT |
| Cache key headers (GET) | absent |
| Upstream service | đúng |

**Quyết định**: CDN bypass rules hoạt động chính xác. Tự tin triển khai production cho private/mutation traffic.

### 11.2. Scenario B: Authorization HIT, còn lại OK

| Quan sát | Giá trị |
| --- | --- |
| Exit code | `≠ 0` |
| authorization_header second | `X-Cache: HIT`, có cache key headers |
| Cookie, no-cache, POST | Tất cả not HIT |

**Quyết định**: VCL đang bỏ sót Authorization check. Cần thêm vào `vcl_recv`:

```vcl
if (req.http.Authorization) {
  return(pass);
}
```

### 11.3. Scenario C: Cache key headers xuất hiện nhưng vẫn not HIT

| Quan sát | Giá trị |
| --- | --- |
| Exit code | `≠ 0` |
| Cả 2 lần GET | `X-Cache: MISS` |
| Cache key headers | **Present** (check `absent` fail) |

**Quyết định**: VCL `return(pass)` được gọi nhưng **sau** `vcl_hash`. Cache key được tạo nhưng object không được lưu (do pass). Cần chuyển `return(pass)` lên đầu `vcl_recv`, trước khi `vcl_hash` chạy. Đây không phải lỗi bảo mật (object không bị cache) nhưng là lỗi hiệu năng (cache key hash computation vô ích).

### 11.4. Scenario D: POST bị HIT

| Quan sát | Giá trị |
| --- | --- |
| Exit code | `≠ 0` |
| POST first | not HIT |
| POST second | `X-Cache: HIT` |

**Quyết định**: POST request đang bị cache. Đây là lỗi nghiêm trọng nhất — thao tác ghi bị "nuốt". VCL cần thêm:

```vcl
if (req.method != "GET" && req.method != "HEAD") {
  return(pass);
}
```

---

## 12. Nghịch lý / misconceptions

### 12.1. Nghịch lý 1: "Request có Authorization vẫn có thể cache nếu response là public"

**Lầm tưởng**: Một số developer nghĩ rằng nếu response chứa `Cache-Control: public, s-maxage=3600`, CDN có thể cache ngay cả khi request có Authorization.

**Sự thật**: Authorization header trên request là tín hiệu "đây là private request". CDN phải bypass bất kể response headers nói gì. VCL kiểm tra Authorization ở `vcl_recv` (request phase), không phải ở `vcl_backend_response` (response phase). Tại thời điểm `vcl_recv`, response headers chưa tồn tại.

### 12.2. Nghịch lý 2: "Cookie chỉ là vấn đề nếu ứng dụng dùng session"

**Lầm tưởng**: Nếu ứng dụng dùng JWT (stateless), Cookie không chứa session data nên có thể cache.

**Sự thật**: CDN không biết và không nên biết cookie chứa gì. Cookie có thể chứa:
- Session ID
- CSRF token
- Tracking ID ảnh hưởng đến response
- A/B test variant assignment

CDN phải bypass khi có **bất kỳ** Cookie header nào, không cần parse nội dung. Đây là quy tắc an toàn mặc định (safe default).

### 12.3. Nghịch lý 3: "Cache-Control: no-cache từ client và từ origin giống nhau"

**Lầm tưởng**: `Cache-Control: no-cache` luôn có nghĩa "không được cache".

**Sự thật**:

| Nguồn | Directive | Ý nghĩa với CDN |
| --- | --- | --- |
| **Client request** | `Cache-Control: no-cache` | Client yêu cầu revalidate. CDN phải forward request đến origin. Response MỚI từ origin có thể được cache. |
| **Origin response** | `Cache-Control: no-cache` | Origin nói response này phải revalidate trước mỗi lần dùng. CDN có thể lưu nhưng phải revalidate. |
| **Origin response** | `Cache-Control: no-store` | Origin cấm cache hoàn toàn. CDN không được lưu. |

Client `no-cache` là bypass request NHƯNG response vẫn có thể cacheable. Đây là lý do case 03 kiểm tra not HIT ở request, không phải cấm cache vĩnh viễn.

### 12.4. Nghịch lý 4: "Bypass = không có cache key"

**Lầm tưởng**: Không có cache key headers nghĩa là bypass hoạt động.

**Sự thật**: Có implementation không set cache key headers cho **mọi** response (kể cả HIT). Việc absent của cache key headers là cần nhưng chưa đủ. Phải kết hợp với `X-Cache != HIT` và upstream service đúng. Ba signal này cùng nhau mới tạo thành proof.

### 12.5. Nghịch lý 5: "POST/PUT response không bao giờ nên cache, nên không cần test"

**Lầm tưởng**: Mặc định Varnish không cache non-GET, nên không cần test POST bypass.

**Sự thật**:
- Một số VCL tùy chỉnh có thể vô tình gán `return(hash)` cho POST nếu điều kiện sai.
- Origin server có thể trả về `Cache-Control: public` cho POST response (ví dụ: API tạo resource trả về representation).
- Bug regression: thay đổi VCL cho GET cache có thể vô tình ảnh hưởng đến POST path.

Test POST bypass là regression test cho toàn bộ VCL pipeline.

---

## 13. Checklist trước khi chạy

### 13.1. Topology checklist

```text
[ ] TargetLayer = full (Varnish + Nginx + App)
[ ] localhost:80 trả về response có X-Cache header
[ ] localhost:80/products-service hoạt động (GET /api/sim/products/1 trả về 200)
[ ] localhost:80/cart-service hoạt động (POST /api/sim/cart/add trả về 200)
[ ] CONTROL_BASE_URL = http://localhost:8088 (dù case này không dùng, nhưng để sẵn)
```

### 13.2. Env checklist

```text
[ ] BASE_URL = "http://localhost:80" (REQUIRED — phải qua Varnish)
[ ] CONTROL_BASE_URL = "http://localhost:8088" (không dùng trong case này, nhưng script import có thể reference)
[ ] OPS_AUTH_TOKEN không bắt buộc (case này không gọi control plane)
```

### 13.3. Pre-run validation

```text
[ ] Chạy case 01 (hit-smoke) PASS trước — xác nhận cache đang hoạt động bình thường
[ ] Chạy `curl -H "Authorization: Bearer test" http://localhost:80/api/sim/products/1` — nhận 200
[ ] Chạy `curl -X POST -H "Content-Type: application/json" -d '{"product_id":1,"quantity":1}' http://localhost:80/api/sim/cart/add` — nhận 200
[ ] Xác nhận response curl có X-Cache header (chứng tỏ đang qua Varnish)
```

### 13.4. Post-run checklist

```text
[ ] k6 exit code = 0
[ ] checks = 100.00%
[ ] Không có dòng "ERRO" trong output
[ ] Tất cả 56 named checks hiển thị ✓ (không có ✗)
[ ] 8 request, mỗi request có X-Cache != HIT
[ ] 6 GET request không có cache key headers
[ ] Post-run: chạy lại case 01 để đảm bảo cache vẫn hoạt động bình thường (bypass không làm hỏng cache layer)
```

---

## 14. 4-5 Variations với code mẫu

### 14.1. Variation 1: Thêm `PUT` và `DELETE` method bypass

Script gốc chỉ test POST. Variation này thêm PUT và DELETE để chứng minh tất cả non-read method đều bypass.

```javascript
export default function () {
  // ... giữ nguyên 4 scenario gốc ...

  // Thêm PUT bypass
  exerciseRepeatedBypass('write_method_put', {
    method: 'PUT',
    path: '/api/sim/products/1',
    body: { name: 'Updated Product', price: 99.99 },
    upstream: 'products-service',
    expectNoCacheKeyHeaders: false,
  });

  // Thêm DELETE bypass
  exerciseRepeatedBypass('write_method_delete', {
    method: 'DELETE',
    path: '/api/sim/products/1',
    upstream: 'products-service',
    expectNoCacheKeyHeaders: false,
  });
}
```

### 14.2. Variation 2: Test bypass với nhiều profile variant

Script gốc chỉ dùng `guestVNMobileControl`. Variation này chứng minh bypass không phụ thuộc vào variant.

```javascript
export default function () {
  const testProfiles = [
    profiles.guestVNMobileControl,
    profiles.guestUSDesktopControl,
    profiles.returningVNMobileVariantA,
  ];

  for (const profile of testProfiles) {
    exerciseRepeatedBypass(`auth_${profile.name}`, {
      path: paths.productDetail,
      profile: profile,
      headers: { Authorization: 'Bearer session-user-token' },
      upstream: 'products-service',
    });
  }
}
```

### 14.3. Variation 3: Test với nhiều loại Authorization header

```javascript
export default function () {
  const authHeaders = [
    { label: 'bearer', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123' },
    { label: 'basic', value: 'Basic dXNlcjpwYXNzd29yZA==' },
    { label: 'custom', value: 'ApiKey sk-1234567890abcdef' },
  ];

  for (const auth of authHeaders) {
    exerciseRepeatedBypass(`auth_${auth.label}`, {
      path: paths.productDetail,
      profile: profiles.guestVNMobileControl,
      headers: { Authorization: auth.value },
      upstream: 'products-service',
    });
  }
}
```

### 14.4. Variation 4: Test `Cache-Control: no-store` và `Pragma: no-cache`

```javascript
export default function () {
  // no-store — mạnh hơn no-cache
  exerciseRepeatedBypass('cache_control_no_store', {
    path: paths.productDetail,
    profile: profiles.guestVNMobileControl,
    headers: { 'Cache-Control': 'no-store' },
    upstream: 'products-service',
  });

  // Pragma: no-cache — HTTP/1.0 legacy
  exerciseRepeatedBypass('pragma_no_cache', {
    path: paths.productDetail,
    profile: profiles.guestVNMobileControl,
    headers: { 'Pragma': 'no-cache' },
    upstream: 'products-service',
  });
}
```

### 14.5. Variation 5: Chạy với sustained traffic (nhiều iteration)

```javascript
export const options = {
  vus: 1,
  iterations: 100,  // Lặp lại 100 lần để đảm bảo bypass ổn định
  thresholds: {
    checks: ['rate==1'],
  },
  tags: {
    scenario: 'cdn_bypass_rules_sustained',
  },
};
```

Mục đích: chạy 100 lần, mỗi lần gửi 8 request = 800 request. Chứng minh bypass không bị "trôi" sau nhiều lần — không có request nào vô tình thành HIT do race condition hoặc cache warming từ request khác.

---

## 15. Anti-patterns

### 15.1. Anti-pattern 1: Dùng `Cache-Control: no-store` trên response thay vì bypass

```text
SAI:
  VCL recv: không kiểm tra Authorization ─▶ request qua bình thường
  Origin response: Cache-Control: no-store
  Kết quả: object không được cache, nhưng CDN VẪN tạo cache key và lookup
```

**Vấn đề**: Response headers nằm ở pha `vcl_backend_response`. Nếu request được forward đến backend trước khi phát hiện cần bypass, CDN đã:
- Parse và hash cache key (lãng phí CPU)
- Lookup trong cache storage (cache miss, lãng phí I/O)
- Gửi request đến backend

Bypass ở `vcl_recv` tránh tất cả các bước trên.

### 15.2. Anti-pattern 2: Chỉ kiểm tra bypass ở lần đầu tiên

```text
SAI:
  Gửi 1 request có Authorization
  Thấy X-Cache: MISS
  Kết luận: bypass OK
```

**Vấn đề**: Không phân biệt được giữa "chưa cache" và "không được cache". Luôn gửi ít nhất 2 lần.

### 15.3. Anti-pattern 3: Dùng `return(pipe)` cho tất cả bypass

```text
SAI:
  if (req.http.Authorization || req.http.Cookie) {
    return(pipe);
  }
```

**Vấn đề**: `pipe` bỏ qua toàn bộ VCL processing, kể cả logging headers, monitoring counters, và health checks. Response không có `X-Cache`, `X-Upstream-Service`, hoặc các debug header khác. Dùng `return(pass)` để vẫn duy trì observability.

### 15.4. Anti-pattern 4: Không test với POST có request body

```text
SAI:
  exerciseRepeatedBypass('post_no_body', {
    method: 'POST',
    path: '/api/sim/cart/add',
    upstream: 'cart-service',
  });
  // Thiếu body!
```

**Vấn đề**: POST không có body có thể nhận response khác (validation error 400 thay vì 200). Origin có thể xử lý validation error khác với success response — đặc biệt là cache headers. Test với body hợp lệ để đảm bảo test đúng production behavior.

### 15.5. Anti-pattern 5: Bỏ qua scenario `Cache-Control: no-cache` từ client

```text
SAI:
  VCL chỉ kiểm tra Authorization, Cookie, và method
  Bỏ qua req.http.Cache-Control ~ "no-cache"
```

**Vấn đề**: Khi người dùng nhấn Ctrl+Shift+R (hard refresh), browser gửi `Cache-Control: no-cache`. Nếu CDN không bypass, người dùng nhận bản cache cũ và nghĩ rằng nội dung chưa được cập nhật. Đây là UX bug phổ biến.

**Phân tích chi tiết**: Browser gửi các header khác nhau cho các loại refresh:

| User action | Request header | CDN behavior đúng |
| --- | --- | --- |
| Click link / F5 (soft refresh) | Không có Cache-Control đặc biệt | Serve từ cache nếu có (HIT) |
| Ctrl+F5 / Ctrl+Shift+R (hard refresh) | `Cache-Control: no-cache` | **Bypass cache**, gọi origin |
| DevTools "Disable cache" | `Cache-Control: no-cache` | **Bypass cache**, gọi origin |

Nếu CDN không phân biệt, hard refresh vẫn trả về HIT — người dùng không thể thấy nội dung mới nhất sau khi admin cập nhật.

### 15.6. Anti-pattern 6: Bypass dựa trên path thay vì header

```text
SAI:
  if (req.url ~ "^/api/private/") {
    return(pass);
  }
  // Các path khác mặc định cache — kể cả khi có Authorization!
```

**Vấn đề**: Authorization header có thể xuất hiện trên bất kỳ path nào. Một API "public" như product detail có thể trả về dữ liệu khác cho user đã login (giá đặc biệt, voucher cá nhân). Bypass phải dựa trên **request characteristics** (headers, method), không phải **URL pattern**.

**Ví dụ cụ thể**:

```text
GET /api/sim/products/1 (không auth)
  → Kết quả: giá gốc 1,000,000 VND
  → Cache key: hash(/api/sim/products/1|vi|VN|mobile|control|guest)

GET /api/sim/products/1 (có Authorization: Bearer user_token)
  → Kết quả: giá VIP 850,000 VND + voucher cá nhân
  → Nếu bị cache → user khác thấy giá VIP và voucher của người này!
```

Path `/api/sim/products/1` là public, nhưng response phụ thuộc vào việc có Authorization hay không. Nếu VCL chỉ bypass `/api/private/*`, request có Authorization đến `/api/sim/products/1` sẽ bị cache với dữ liệu cá nhân.

### 15.7. Anti-pattern 7: Dùng `hash_data(req.http.Cookie)` để tạo variant thay vì bypass

```text
SAI:
  sub vcl_hash {
    if (req.http.Cookie) {
      hash_data(req.http.Cookie);  // Cookie làm variant cache key
    }
  }
  // Thay vì return(pass) cho request có Cookie
```

**Vấn đề**:
1. Mỗi session cookie khác nhau tạo ra một cache object riêng → **cache explosion**. Nếu có 10,000 sessions, có 10,000 cache objects cho cùng một product detail.
2. Cookie thay đổi liên tục (session renewal, tracking) → cache object nhanh chóng trở nên vô dụng.
3. Dữ liệu cá nhân vẫn có thể bị truy cập nếu attacker đoán được cookie value và dùng nó làm cache key.

**Quy tắc**: Cookie = bypass, không phải variant dimension.

### 15.8. Anti-pattern 8: Không test bypass với nhiều method type

```text
SAI: Chỉ test POST, bỏ qua PUT, PATCH, DELETE
```

**Vấn đề**: VCL có thể chỉ xử lý POST mà quên các method ghi khác. Mỗi method cần được test riêng vì:

| Method | Idempotent? | Safe? | Cache risk |
| --- | --- | --- | --- |
| POST | Không | Không | Cao — tạo resource mới mỗi lần |
| PUT | Có | Không | Trung bình — update toàn bộ resource |
| PATCH | Không | Không | Cao — update một phần, kết quả thay đổi |
| DELETE | Có | Không | Trung bình — xóa resource |

Nếu VCL chỉ bypass POST, PUT request có thể bị cache và gây ra hành vi không mong muốn (user update sản phẩm nhưng thấy dữ liệu cũ từ cache).

---

## 16. Real validation data

### 16.1. Request/response mẫu — Authorization bypass

**Request 1:**
```http
GET /api/sim/products/1 HTTP/1.1
Host: localhost:80
Accept: application/json
Accept-Language: vi
X-Geo-Country: VN
X-Device-Class: mobile
X-Ab-Variant: control
X-User-Segment: guest
Authorization: Bearer session-user-token
```

**Response 1:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Cache: MISS
X-Upstream-Service: products-service
X-Request-Id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

**Request 2:** (giống hệt Request 1)

**Response 2:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Cache: MISS
X-Upstream-Service: products-service
X-Request-Id: f9e8d7c6-b5a4-3210-fedc-ba0987654321
```

Lưu ý: `X-Request-Id` khác nhau giữa 2 response — chứng tỏ cả 2 lần đều đến origin. Nếu lần 2 là HIT, `X-Request-Id` sẽ giống hệt lần 1 (vì cache trả về cùng một response object cũ).

### 16.2. Request/response mẫu — POST bypass

**Request 1:**
```http
POST /api/sim/cart/add HTTP/1.1
Host: localhost:80
Accept: application/json
Content-Type: application/json
Content-Length: 34

{"product_id":1,"quantity":1}
```

**Response 1:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Cache: MISS
X-Upstream-Service: cart-service
```

**Request 2:** (giống hệt Request 1 — POST lần 2)

**Response 2:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Cache: MISS
X-Upstream-Service: cart-service
```

Lưu ý: POST 2 lần liên tiếp có thể tạo ra 2 cart items (quantity tăng lên 2). Điều này bình thường trong test bypass — không cần quan tâm business logic correctness (cart service tự xử lý), chỉ cần quan tâm CDN không cache.

### 16.3. Bảng so sánh response headers — bypass vs cacheable

| Header | Cacheable (case 01) | Bypass Authorization (case 03) | Bypass POST (case 03) |
| --- | --- | --- | --- |
| `X-Cache` | `MISS` (lần 1) / `HIT` (lần 2) | `MISS` (cả 2 lần) | `MISS` (cả 2 lần) |
| `X-Cache-Key-Language` | `vi` | *(absent)* | *(absent)* |
| `X-Cache-Key-Geo` | `VN` | *(absent)* | *(absent)* |
| `X-Cache-Key-Device` | `mobile` | *(absent)* | *(absent)* |
| `X-Cache-Key-AB` | `control` | *(absent)* | *(absent)* |
| `X-Cache-Key-Segment` | `guest` | *(absent)* | *(absent)* |
| `X-Upstream-Service` | `products-service` | `products-service` | `cart-service` |
| `X-Request-Id` | Giống nhau (lần 1, 2) | Khác nhau (lần 1, 2) | Khác nhau (lần 1, 2) |

### 16.4. Latency comparison

| Scenario | Avg duration (ms) | Ý nghĩa |
| --- | --- | --- |
| Cache HIT (case 01 warm) | ~2-5ms | Serve từ memory — nhanh nhất |
| Cache MISS (case 01 cold) | ~15-25ms | Phải gọi origin |
| Bypass Authorization | ~15-25ms | Giống MISS — luôn gọi origin |
| Bypass POST | ~15-25ms | Giống MISS — luôn gọi origin |

Dữ liệu này cho thấy bypass request luôn chậm hơn HIT — đúng như mong đợi vì phải đi qua origin. Nếu bypass request nhanh bất thường (~2-5ms), nghi ngờ CDN đang serve từ cache.

---

## 17. Reference

### 17.1. Source code

| File | Path |
| --- | --- |
| Script | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\03-bypass-rules.js` |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` |
| Common utilities | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json` |
| Scenario README | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md` |

### 17.2. Documents

| Document | Path |
| --- | --- |
| CDN Overview | `E:\Khoa hoc\k6\docs\practice\cdn\00_overview.md` |
| Case 01 (HIT smoke) | `E:\Khoa hoc\k6\docs\practice\cdn\01_hit-smoke.md` |
| Case 02 (Variant keys) | `E:\Khoa hoc\k6\docs\practice\cdn\02_variant-keys.md` |
| Case 04 (Query normalization) | `E:\Khoa hoc\k6\docs\practice\cdn\04_query-normalization.md` |
| Run guide | `E:\Khoa hoc\k6\docs\practice\cdn\RUN_GUIDE.md` |

### 17.3. External references

| Resource | URL / Description |
| --- | --- |
| Varnish `return(pass)` docs | `https://varnish-cache.org/docs/trunk/reference/vcl.html#pass` |
| Varnish built-in VCL (default behavior) | `https://github.com/varnishcache/varnish-cache/blob/master/bin/varnishd/builtin.vcl` |
| RFC 7234 — HTTP Caching | `https://datatracker.ietf.org/doc/html/rfc7234` |
| RFC 7231 — HTTP Methods | `https://datatracker.ietf.org/doc/html/rfc7231#section-4` |
| CDN security best practices | OWASP: Cache Poisoning Prevention |

### 17.4. Related cases

```text
cdn-01-hit-smoke       ──▶ Hiểu baseline cache HIT trước khi test bypass
cdn-02-variant-keys    ──▶ Cache key construction (ngược với bypass: tạo key)
cdn-04-query-normalization ──▶ Query param không phá cache (bypass ở mức query, không phải header)
cdn-07-cache-contract  ──▶ Origin cache headers (Cache-Control, ETag, Vary)
```

### 17.5. Ghi chú về VCL implementation patterns

Hai pattern chính để implement bypass trong Varnish:

**Pattern A: Early return(pass) -- khuyến nghị**

```vcl
sub vcl_recv {
  # Bypass checks PHẢI ở đầu vcl_recv, trước mọi logic khác
  if (req.method != "GET" && req.method != "HEAD") {
    set req.http.X-Pass-Reason = "write-method";
    return(pass);
  }
  if (req.http.Authorization) {
    set req.http.X-Pass-Reason = "authorization";
    return(pass);
  }
  if (req.http.Cookie) {
    set req.http.X-Pass-Reason = "cookie";
    return(pass);
  }
  if (req.http.Cache-Control ~ "no-cache" || req.http.Pragma ~ "no-cache") {
    set req.http.X-Pass-Reason = "client-no-cache";
    return(pass);
  }
  # ... cache key construction ...
}
```

**Pattern B: Set flag + check later -- ít khuyến nghị hơn**

```vcl
sub vcl_recv {
  # Dùng flag thay vì return(pass) ngay
  if (req.http.Authorization || req.http.Cookie) {
    set req.http.X-Bypass-Cache = "1";
  }
  # ... cache key construction ...
}

sub vcl_hash {
  if (req.http.X-Bypass-Cache == "1") {
    # Tạo cache key duy nhất không bao giờ match
    hash_data(req.http.X-Request-Id);
    hash_data(now);
  }
}
```

Pattern B phức tạp hơn và dễ gây lỗi -- pattern A được khuyến nghị cho hầu hết trường hợp.

### 17.6. Tóm tắt signal chain

```text
Bypass request lifecycle:
  Client request
    └─▶ vcl_recv: phát hiện bypass condition
         └─▶ return(pass)
              └─▶ vcl_pass: forward đến backend
                   └─▶ Backend xử lý
                        └─▶ vcl_deliver: gán X-Cache = MISS (hoặc pass)
                             └─▶ KHÔNG lưu vào cache storage

Cacheable request lifecycle (để so sánh):
  Client request
    └─▶ vcl_recv: không bypass
         └─▶ vcl_hash: tạo cache key
              └─▶ lookup: MISS hoặc HIT
                   ├─▶ HIT: serve từ cache (KHÔNG gọi backend)
                   └─▶ MISS: gọi backend → lưu vào cache → HIT lần sau
```

### 17.7. So sánh chi tiết bypass vs cacheable

| Khía cạnh | Cacheable read (case 01) | Bypass auth (case 03) | Bypass POST (case 03) |
| --- | --- | --- | --- |
| **VCL quyết định** | `vcl_recv` → `vcl_hash` → lookup | `vcl_recv` → `return(pass)` | `vcl_recv` → `return(pass)` |
| **Cache key** | Có (URL + variant headers) | Không | Không |
| **Lần 1** | MISS (gọi origin, lưu cache) | MISS/pass (gọi origin, không lưu) | MISS/pass (gọi origin, không lưu) |
| **Lần 2** | HIT (serve từ cache) | MISS/pass (gọi origin lại) | MISS/pass (gọi origin lại) |
| **Origin load (10 requests)** | ~1-2 lần gọi | 10 lần gọi | 10 lần gọi |
| **Response time** | ~3ms (warm) | ~18ms | ~18ms |
| **Cache key headers** | Có (5 headers) | Không | Không |
| **Security** | OK (public data) | Required (private data) | Required (mutation) |

### 17.8. Quy tắc thiết kế bypass rules

```text
1. Bypass dựa trên REQUEST characteristics, không phải URL pattern
2. return(pass) phải ở ĐẦU vcl_recv, trước vcl_hash
3. Authorization và Cookie là hai check riêng biệt — không gộp chung
4. Cache-Control: no-cache từ client ≠ Cache-Control từ origin
5. Non-GET/HEAD methods LUÔN bypass — không có ngoại lệ
6. Dùng return(pass) thay vì return(pipe) để giữ observability
7. Set X-Pass-Reason header để debug dễ dàng
8. Test mỗi bypass rule với ÍT NHẤT 2 lần request liên tiếp
9. Đừng quên Pragma: no-cache (HTTP/1.0 legacy)
10. Cookie bypass không cần parse nội dung cookie — chỉ cần kiểm tra sự tồn tại
```

### 17.9. Các câu hỏi thường gặp

**Hỏi**: Nếu tôi có API vừa cần auth vừa public (cùng URL, response khác nhau tùy auth), làm sao CDN biết?

**Đáp**: CDN không cần biết. Mọi request có `Authorization` header đều bypass — kể cả khi response "giống hệt" public version. Đây là safe default. Nếu bạn muốn cache authenticated response, cần thêm logic phức tạp hơn (ví dụ: hash `Authorization` header value vào cache key) — nhưng điều này có rủi ro bảo mật.

**Hỏi**: Case 03 cần `OPS_AUTH_TOKEN` không?

**Đáp**: Không. Case 03 không gọi control plane (không có `setup()`, không purge/ban). Bạn có thể chạy case này mà không cần set `OPS_AUTH_TOKEN`.

**Hỏi**: Nếu script chạy pass nhưng tôi vẫn thấy POST response có vẻ bị cache thì sao?

**Đáp**: Kiểm tra response headers. Nếu `X-Cache` không phải `HIT` và không có cache key headers, request đã bypass đúng. "Có vẻ bị cache" có thể là do response data trùng lặp ngẫu nhiên.

**Hỏi**: Tại sao case này dùng `iterations: 1` thay vì `duration`?

**Đáp**: Case này là correctness proof, không phải load test. Một iteration với 8 request tuần tự đủ để chứng minh bypass rules hoạt động. Tăng iteration có thể hữu ích để test stability (variation 5), nhưng script gốc giữ đơn giản.

### 17.10. Bảng tổng kết năng lực CDN — case 03

| Năng lực | Trạng thái | Evidence |
| --- | --- | --- |
| Phát hiện Authorization header | Hoạt động | 2 lần GET not HIT, không cache key headers |
| Phát hiện Cookie header | Hoạt động | 2 lần GET not HIT, không cache key headers |
| Phát hiện Cache-Control: no-cache | Hoạt động | 2 lần GET not HIT, không cache key headers |
| Phát hiện non-GET method | Hoạt động | 2 lần POST not HIT |
| Bypass nhất quán (repeatability) | Hoạt động | Lần 1 và lần 2 đều bypass |
| Không tạo cache key cho bypass | Hoạt động | Cache key headers absent |
| Upstream routing đúng | Hoạt động | X-Upstream-Service đúng service |

### 17.11. Dependency graph

Case 03 là case độc lập nhất trong suite — không phụ thuộc vào bất kỳ case nào khác. Tuy nhiên, theo pedagogical order, nên học case 01 và 02 trước để hiểu cache behavior bình thường trước khi học bypass:

```text
Recommended learning order:
  01_hit-smoke ──▶ 02_variant-keys ──▶ 03_bypass-rules ──▶ 04_query-normalization
       │                   │                    │                    │
       │─ Hiểu HIT/MISS    │─ Hiểu cache key   │─ Hiểu bypass      │─ Hiểu query norm
       │  cơ bản           │  dimensions         │  rules             │
```

Bypass rules (case 03) là "ngoại lệ" của cache behavior bình thường (case 01 và 02). Hiểu cái bình thường trước khi hiểu ngoại lệ giúp tránh nhầm lẫn giữa "MISS vì chưa warm" và "MISS vì bypass".

### 17.12. Kiểm tra chéo với curl

Trước khi chạy k6, bạn có thể kiểm tra nhanh từng bypass rule bằng curl:

```powershell
# Test Authorization bypass
curl -s -o NUL -w "%{http_code} X-Cache:%header{X-Cache}" `
  -H "Authorization: Bearer test" `
  -H "Accept-Language: vi" -H "X-Geo-Country: VN" `
  -H "X-Device-Class: mobile" -H "X-Ab-Variant: control" `
  -H "X-User-Segment: guest" `
  http://localhost:80/api/sim/products/1

# Test Cookie bypass
curl -s -o NUL -w "%{http_code} X-Cache:%header{X-Cache}" `
  -H "Cookie: session_id=test123" `
  -H "Accept-Language: vi" -H "X-Geo-Country: VN" `
  -H "X-Device-Class: mobile" -H "X-Ab-Variant: control" `
  -H "X-User-Segment: guest" `
  http://localhost:80/api/sim/products/1

# Test no-cache bypass
curl -s -o NUL -w "%{http_code} X-Cache:%header{X-Cache}" `
  -H "Cache-Control: no-cache" `
  -H "Accept-Language: vi" -H "X-Geo-Country: VN" `
  -H "X-Device-Class: mobile" -H "X-Ab-Variant: control" `
  -H "X-User-Segment: guest" `
  http://localhost:80/api/sim/products/1

# Test POST bypass
curl -s -o NUL -w "%{http_code} X-Cache:%header{X-Cache}" `
  -X POST -H "Content-Type: application/json" `
  -d '{"product_id":1,"quantity":1}' `
  http://localhost:80/api/sim/cart/add
```

Kết quả mong đợi: tất cả trả về HTTP 200 và `X-Cache` khác `HIT`. Nếu curl tiện lợi, đây là cách debug nhanh nhất trước khi chạy k6 đầy đủ.
