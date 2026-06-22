# Case 11: Negative caching

> **Case ID:** `cdn-11-negative-caching`
> **Script:** `11-negative-caching.js`
> **Layer:** CDN / Varnish
> **Proof:** 404 có thể cache ngắn hạn đúng TTL

---

## 1. Tình huống thực tế

### 1.1. Bối cảnh kinh doanh

Một trang thương mại điện tử có hàng triệu sản phẩm. Người dùng thường xuyên truy cập vào các URL sản phẩm không tồn tại — có thể do:

- Sản phẩm đã bị xóa khỏi catalog nhưng link cũ vẫn còn trên mạng xã hội.
- Người dùng gõ sai slug sản phẩm trên thanh địa chỉ.
- Bot/crawler quét các URL pattern đoán mò (ví dụ: `/products/999999` khi chỉ có 1000 sản phẩm).
- Đối thủ hoặc kẻ xấu cố tình gửi request đến hàng loạt URL không tồn tại để gây tải lên origin.

Nếu mỗi request 404 đều phải đi xuyên qua CDN đến tận origin (ứng dụng + cơ sở dữ liệu), hậu quả là:

- **Tăng tải origin vô ích**: Mỗi 404 cần ít nhất một lần lookup database để xác nhận sản phẩm không tồn tại. Với hàng ngàn 404/giây, database bị quá tải vì những câu query vô nghĩa.
- **Tăng latency cho người dùng thật**: Tài nguyên origin bị chiếm dụng bởi request 404, người dùng thật đang xem sản phẩm hợp lệ bị chậm.
- **Tăng chi phí hạ tầng**: Phải scale app server và database lên để xử lý traffic không tạo ra doanh thu.
- **Rủi ro DoS không chủ ý**: Một chiến dịch marketing với link sai có thể vô tình DDoS chính origin của bạn.

**Giải pháp lý tưởng**: CDN nên cache cả response 404 trong một khoảng thời gian ngắn. Khi cùng một URL không tồn tại được request lặp lại, CDN trả về 404 từ cache mà không cần gọi origin.

### 1.2. "Negative caching" là gì?

Negative caching (cache phủ định) là kỹ thuật cache response lỗi có chủ ý — thường là HTTP 404 (Not Found), 410 (Gone), hoặc 403 (Forbidden) — với TTL ngắn hơn TTL của response thành công.

```text
Cache thông thường:        200 OK   -> cache TTL=300s
Negative caching:           404      -> cache TTL=5s
```

Khác biệt cốt lõi:

| Khía cạnh | Cache thông thường | Negative caching |
| --- | --- | --- |
| Status code được cache | 200, 304 | 404, 410, 403 |
| TTL điển hình | 60-3600s | 1-30s |
| Mục đích | Tăng tốc độ truy cập | Giảm tải origin cho request không hợp lệ |
| Header đánh dấu | `X-Cache: HIT` | `X-Cache: HIT` + `X-Negative-Cache: true` |
| Origin hit count | 1 (sau đó HIT) | 1 (sau đó HIT) |
| Rủi ro nếu TTL quá dài | Phục vụ stale content | Che giấu sản phẩm mới thêm vào |

### 1.3. Tại sao đây là vấn đề CDN layer, không phải application layer?

Application có thể tự implement cache 404 (dùng Redis, memory cache), nhưng:

- **Không hiệu quả bằng CDN**: Request vẫn phải đến application trước khi được cache. CDN chặn request ở edge, trước khi nó chạm vào hạ tầng ứng dụng.
- **Tốn tài nguyên ứng dụng**: Mỗi request 404 tiêu tốn một worker thread/promise trên app server.
- **Không tận dụng được edge capacity**: CDN đã có sẵn cơ chế cache object với TTL; thêm negative caching chỉ là mở rộng nhỏ của cơ chế này.
- **Khó scale**: Application cache thường là local hoặc shared (Redis), không có khả năng phục vụ ở edge toàn cầu như CDN.

### 1.4. Số liệu thực tế: Impact của việc không có negative caching

Giả sử một trang e-commerce với 10 triệu sản phẩm, mỗi ngày nhận 50 triệu request:

| Loại request | Tỉ lệ | Số request/ngày | Đến được origin? | Tải lên origin (requests) |
| --- | --- | --- | --- | --- |
| Product detail (có thật) | 60% | 30,000,000 | Có, nếu MISS | 1,500,000 (95% cache hit ratio) |
| Product detail (404) | 5% | 2,500,000 | Có, nếu không có negative cache | 2,500,000 (0% cache hit ratio) |
| Category listing | 15% | 7,500,000 | Có, nếu MISS | 375,000 (95% cache hit ratio) |
| Search | 10% | 5,000,000 | Có | 250,000 (95% cache hit ratio) |
| Khác | 10% | 5,000,000 | Tùy loại | ~250,000 |

**Không có negative caching**: 2,500,000 request 404 đến origin mỗi ngày — **nhiều hơn tất cả request product detail hợp lệ cộng lại**.

**Có negative caching (TTL 5 giây)**: Giả sử mỗi URL 404 được request trung bình 3 lần (user refresh + bot retry):
- 2,500,000 / 3 = ~833,000 URL 404 duy nhất
- Mỗi URL gọi origin 1 lần → 833,000 request
- **Tiết kiệm 1,667,000 request/ngày (giảm 67%)**

Với TTL 30 giây và traffic burst (như chiến dịch email), tỉ lệ tiết kiệm có thể lên đến 95-99%.

### 1.5. Các tình huống thực tế cần negative caching

**Tình huống A — Link sản phẩm sai trong email marketing**

```text
Email gửi 2 triệu người dùng với link:
https://shop.example.com/products/summer-sale-2025

Nhưng slug đúng là: summer-sale-2026

Kết quả: 2 triệu request 404 trong 5 phút đầu tiên.
Nếu không có negative caching: origin chết sau 30 giây.
Nếu có negative caching (TTL=5s): request đầu tiên đến origin (404),
   toàn bộ request còn lại trong 5 giây được CDN trả về từ cache.
   Tổng origin hit ≈ 60 (mỗi 5s gọi 1 lần × 5 phút).
```

**Tình huống B — Bot scraping tấn công pattern URL**

```text
Bot quét tuần tự:
/products/1, /products/2, /products/3, ..., /products/999999

Với 1 triệu request, 999,000 URL không tồn tại.
Không có negative cache: origin xử lý 999,000 query database vô ích.
Có negative cache (TTL=10s): origin chỉ xử lý số URL bot scan được trong 10s
   (vài nghìn thay vì cả triệu).
```

**Tình huống C — Microservice mất kết nối tạm thời**

```text
Product service down trong 10 giây.
CDN không thể forward request đến origin.
Nếu 404 đã từng được cache → CDN serve stale 404 thay vì error 503.
Người dùng thấy "Sản phẩm không tồn tại" (có thể sai) thay vì "Lỗi hệ thống" (luôn tệ).
Đây là trade-off: user experience bị ảnh hưởng nhẹ nhưng hệ thống không sập.
```

---

## 1b. Cơ chế negative caching trong HTTP spec và CDN

### 1b.1. HTTP status code nào nên được cache?

Theo HTTP caching spec (RFC 7234), response với status code sau **có thể** được cache:

| Status code | Mặc định cache được? | Heuristic TTL | Use case cho negative caching |
| --- | --- | --- | --- |
| 200 OK | Có | Dựa trên `Cache-Control` | Không phải negative caching |
| 203 Non-Authoritative | Có | Dựa trên `Cache-Control` | Không phải |
| 204 No Content | Có | Dựa trên `Cache-Control` | Không phải |
| 300 Multiple Choices | Có | Dựa trên `Cache-Control` | Không phải |
| 301 Moved Permanently | Có | Dựa trên `Cache-Control` | Có thể — cache redirect vĩnh viễn |
| 404 Not Found | Có (nếu có `Cache-Control`) | Cần explicit TTL | **Negative caching chính** |
| 405 Method Not Allowed | Có (nếu có `Cache-Control`) | Cần explicit TTL | Có thể |
| 410 Gone | Có (nếu có `Cache-Control`) | Cần explicit TTL | **Negative caching** (TTL dài hơn 404) |
| 414 URI Too Long | Có (nếu có `Cache-Control`) | Cần explicit TTL | Hiếm khi dùng |
| 501 Not Implemented | Có (nếu có `Cache-Control`) | Cần explicit TTL | Hiếm khi dùng |

**Quan trọng**: 404 chỉ được cache nếu response có header `Cache-Control` với directive `public` hoặc `s-maxage`. Nếu không có, CDN (theo spec) không được phép cache. Đây là lý do origin phải set `Cache-Control` header ngay cả cho response lỗi.

### 1b.2. Cách origin báo hiệu "hãy cache 404 này"

```http
HTTP/1.1 404 Not Found
Cache-Control: public, s-maxage=5, stale-while-revalidate=10
Content-Type: application/json
X-Negative-Cache: true

{"error": "not_found", "message": "Product does not exist"}
```

Phân tích từng header:

| Header | Giá trị | Ý nghĩa với CDN |
| --- | --- | --- |
| `Cache-Control: public` | Cho phép shared cache | CDN được phép lưu response này |
| `s-maxage=5` | TTL 5 giây cho shared cache | Object hết hạn sau 5 giây |
| `stale-while-revalidate=10` | Cho phép serve stale 10 giây khi revalidating | Nếu origin chậm, vẫn serve stale |
| `X-Negative-Cache: true` | Custom header đánh dấu | Client/test biết đây là intentional negative cache |

### 1b.3. Tại sao không cache quá lâu?

Có một sự đánh đổi (trade-off) giữa bảo vệ origin và freshness:

```text
TTL quá ngắn (1-2s):  Ít bảo vệ origin, burst vẫn穿透 CDN
TTL vừa phải  (5-10s): Cân bằng tốt — bảo vệ origin, freshness chấp nhận được
TTL dài       (30-60s): Bảo vệ origin tốt, nhưng sản phẩm mới bị 404 giả
TTL quá dài   (>120s):  Nguy hiểm — sản phẩm vừa thêm vào bị "biến mất" nhiều phút
```

Công thức đề xuất cho TTL negative cache:

```text
TTL_negative = min(
    TTL_positive * 0.1,     // 10% của TTL object thật
    30,                     // tối đa 30 giây
    thời_gian_trung_bình_giữa_các_lần_cập_nhật_catalog
)
```

Ví dụ:
- Product detail TTL = 300s → negative TTL = min(30, 30, 600) = 30s
- Homefeed TTL = 20s → negative TTL = min(2, 30, 60) = 2s
- Static asset TTL = 3600s → negative TTL = min(360, 30, ∞) = 30s

---

## 2. CDN capability được chứng minh

### 2.1. Tuyên bố năng lực (capability statement)

```text
CDN có khả năng cache response 404 trong một khoảng TTL ngắn,
và response 404 được phục vụ từ cache (HIT) mà không gọi origin
cho đến khi TTL hết hạn.
```

### 2.2. Chứng minh cụ thể

Case này chứng minh ba điều:

1. **404 được cache**: Request thứ hai đến cùng URL không tồn tại trả về `X-Cache: HIT` và `X-Negative-Cache: true`.
2. **Origin chỉ bị gọi một lần trong TTL**: Dùng control endpoint `/ops/app/cdn/origin/request-counts` để đếm số lần origin bị gọi cho URL đó. Trước khi TTL hết hạn, count phải bằng 1.
3. **TTL hết hạn đúng**: Sau khi `sleep(NEGATIVE_WAIT_SECONDS)`, request tiếp theo phải MISS và đi qua origin, làm tăng origin count lên 2.

### 2.3. Tại sao capability này quan trọng trong hệ thống thật

Nếu không có negative caching, một cuộc tấn công "random URL scanning" có thể làm sập origin chỉ với vài trăm request/giây đến các URL không tồn tại. Với negative caching, 99% các request 404 lặp lại được phục vụ từ edge.

---

## 3. Vì sao phải test ở CDN layer

### 3.1. Ba lý do không thể test ở application layer

1. **Application không thấy bức tranh đầy đủ**: App chỉ biết nó trả về 404; app không biết liệu CDN có cache 404 đó hay không. Để biết CDN có cache, bạn phải test từ phía client đi qua CDN.

2. **Header `X-Cache` và `X-Negative-Cache` là CDN-specific**: Application không set các header này. Chúng được Varnish/CDN thêm vào response trước khi trả về client. Nếu test trực tiếp app (qua port `:8088`), bạn sẽ không bao giờ thấy `X-Cache: HIT`.

3. **Origin request count là evidence không thể có ở app layer**: Control endpoint `/ops/app/cdn/origin/request-counts` theo dõi request từ CDN đến origin, không phải từ client đến app. Đây là góc nhìn từ phía CDN, chỉ có thể quan sát được khi test ở CDN layer.

### 3.2. So sánh với test executor

| Khía cạnh | Executor test | CDN layer test |
| --- | --- | --- |
| Mục tiêu | "Traffic shape có đúng không?" | "Cache contract có đúng không?" |
| Evidence chính | Throughput, latency, iteration | Header sequence, cache state, origin count |
| Status code quan trọng | Thường expect 200 | 404 là expected outcome |
| Cần control plane? | Không | Có (reset origin profile, đếm origin request) |
| Pass khi | Thresholds đạt | Checks 100% + origin count đúng |

### 3.3. Điều gì xảy ra nếu bỏ qua test này

- **Production surprise**: Tưởng CDN đã cache 404, nhưng thực tế CDN bypass cache cho 404 (một số CDN config mặc định không cache 4xx).
- **Origin quá tải**: Chiến dịch marketing với link lỗi làm origin 100% CPU vì hàng trăm nghìn 404/giờ.
- **VCL sai không bị phát hiện**: VCL có thể có rule vô tình bypass cache cho `status >= 400`.

---

## 4. Topology và precondition

### 4.1. Topology bắt buộc

```text
k6 client -> http://localhost:80  -> Varnish CDN -> Nginx -> app/microservices
             public edge path       cache layer     reverse    origin
                                   + add headers   proxy

k6 client -> http://localhost:8088 -> Nginx control path
             control/direct         (ops endpoints, origin counters)

k6 client -> http://localhost:9091 -> catalog-events mock
             event path              (không dùng trong case này)
```

**Yêu cầu cứng**:
- `TargetLayer=full` — phải chạy full stack với Varnish ở giữa.
- `BASE_URL=http://localhost:80` — mọi request public phải qua port 80.
- `CONTROL_BASE_URL=http://localhost:8088` — dùng để reset origin profile và đọc origin request counts.
- `OPS_AUTH_TOKEN` — token xác thực cho control endpoint.

### 4.2. Precondition chi tiết

Trước khi chạy case, các điều kiện sau phải được đảm bảo:

| # | Điều kiện | Cách kiểm tra | Expected |
| --- | --- | --- | --- |
| 1 | Full stack đang chạy | `curl http://localhost:80/health` | 200 |
| 2 | Control path khả dụng | `curl http://localhost:8088/health` | 200 |
| 3 | Origin đang healthy | `GET /ops/app/cdn/origin/profile` | `healthy: true` |
| 4 | Token ops hợp lệ | Control request có Authorization header | 200 |
| 5 | Chưa có object trong cache cho URL test | `ban-url` dynamic path trước khi test | 200 |
| 6 | Origin request count đã reset | `POST /ops/app/cdn/origin/request-counts/reset` | 200 |

### 4.3. Cơ chế tạo URL không tồn tại

Case này dùng `buildCachedMissingPath` từ `shared.js` để tạo URL:

```javascript
// shared.js:208-210
export function buildCachedMissingPath(key, params = {}) {
  return `${paths.cachedMissingPrefix}/${encodeURIComponent(String(key))}${buildQueryString(params)}`;
}
```

Kết quả URL có dạng:
```text
/api/cached/missing/missing-1782128576823?ttl_seconds=5
```

Trong đó:
- `missing-1782128576823` là key động dựa trên `Date.now()`, đảm bảo mỗi lần chạy dùng URL mới, không bị ảnh hưởng bởi cache cũ.
- `ttl_seconds=5` báo cho origin biết TTL mong muốn cho object này (cả positive và negative).

**Quan trọng**: URL này được thiết kế để origin **luôn trả về 404**. Đây không phải lỗi, mà là expected behavior. Origin app có một route handler cho `/api/cached/missing/*` luôn trả về 404 với header `X-Negative-Cache: true` và `Cache-Control` cho phép CDN cache response này.

---

## 5. Script deep-dive

### 5.1. Cấu trúc tổng quan

```javascript
// 11-negative-caching.js — cấu trúc 3 pha: setup → default → teardown

import { sleep } from 'k6';
import { envFloat, envInt } from '../shared/common.js';
import {
  buildCachedMissingPath,  // tạo URL không tồn tại
  banUrl,                  // xóa cache object nếu có
  requestCdn,              // gửi request qua CDN public path
  assertCacheState,        // kiểm tra X-Cache header
  assertHeaderEquals,      // kiểm tra giá trị header
  assertStatus,            // kiểm tra HTTP status code
  getOriginRequestCounts,  // đọc origin counter
  findOriginRequestCount,  // tìm count cho path cụ thể
  resetOriginProfile,      // reset origin về healthy
  resetOriginRequestCounts,// reset origin counter
} from './shared.js';
```

### 5.2. Env knobs

```javascript
const NEGATIVE_TTL_SECONDS = envInt('NEGATIVE_TTL_SECONDS', 5);
const NEGATIVE_WAIT_SECONDS = envFloat('NEGATIVE_WAIT_SECONDS', NEGATIVE_TTL_SECONDS + 1);
```

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `NEGATIVE_TTL_SECONDS` | `5` | TTL cho negative cache object (giây) |
| `NEGATIVE_WAIT_SECONDS` | `6` (`5 + 1`) | Thời gian chờ trước khi kiểm tra expiry. Mặc định = TTL + 1 để đảm bảo object đã hết hạn. |

Có thể override qua environment:
```powershell
$env:NEGATIVE_TTL_SECONDS = "3"
$env:NEGATIVE_WAIT_SECONDS = "4"
```

**Lưu ý về `NEGATIVE_WAIT_SECONDS`**: Giá trị mặc định là `NEGATIVE_TTL_SECONDS + 1` để đảm bảo object đã thực sự hết hạn. Nếu đặt bằng đúng TTL, có thể gặp race condition: CDN vẫn coi object là fresh trong cùng một giây. Thêm 1 giây buffer tránh false negative.

### 5.3. Options

```javascript
export const options = {
  vus: 1,              // đơn VU — tuần tự, không song song
  iterations: 1,       // một iteration duy nhất
  thresholds: {
    checks: ['rate==1'], // 100% checks phải pass
  },
  tags: {
    scenario: 'cdn_negative_caching',
  },
};
```

**Tại sao single VU + single iteration?**
- Đây là correctness proof, không phải load test.
- Cần sequence tuần tự chính xác: first → second → wait → after-expiry.
- Mọi race condition (request đến cùng lúc) sẽ làm hỏng evidence.
- Origin request count phải tăng chính xác 1 → 2; concurrent request sẽ làm count không xác định.

### 5.4. Pha setup()

```javascript
export function setup() {
  const path = buildCachedMissingPath(`missing-${Date.now()}`, {
    ttl_seconds: NEGATIVE_TTL_SECONDS,
  });

  resetOriginProfile();
  resetOriginRequestCounts();
  banUrl(path);

  return { path };
}
```

Phân tích từng dòng:

| Dòng | Hành động | Ý nghĩa |
| --- | --- | --- |
| `buildCachedMissingPath(...)` | Tạo URL `/api/cached/missing/missing-<timestamp>?ttl_seconds=5` | Mỗi lần chạy có URL riêng, tránh cache pollution |
| `resetOriginProfile()` | `POST /ops/app/cdn/origin/reset` | Đảm bảo origin healthy trước test |
| `resetOriginRequestCounts()` | `POST /ops/app/cdn/origin/request-counts/reset` | Reset counter về 0 |
| `banUrl(path)` | `POST /ops/app/cdn/cache/ban-url` | Xóa object khỏi cache nếu tồn tại từ lần chạy trước |
| `return { path }` | Trả về data cho default function | Truyền path vào iteration |

**Tại sao dùng `Date.now()` thay vì UUID?**
- `Date.now()` đủ uniqueness trong phạm vi test (không ai chạy 2 test cùng millisecond).
- UUID không cần thiết — path đã được encode qua `encodeURIComponent`.
- Timestamp giúp dễ debug: biết chính xác thời điểm path được tạo.

### 5.5. Pha default() — phần 1: First và second request

```javascript
export default function (data) {
  const path = data.path;

  // --- FIRST REQUEST ---
  const first = requestCdn('GET', path, {
    tags: { case: 'negative_first' },
  });
  assertStatus(first, 404, 'negative first');
  assertCacheState(first, 'MISS', 'negative first');
  assertHeaderEquals(first, 'X-Negative-Cache', 'true', 'negative first');

  // --- SECOND REQUEST ---
  const second = requestCdn('GET', path, {
    tags: { case: 'negative_second' },
  });
  assertStatus(second, 404, 'negative second');
  assertCacheState(second, 'HIT', 'negative second');
  assertHeaderEquals(second, 'X-Negative-Cache', 'true', 'negative second');
```

Phân tích sequence:

| Request | Tag | Assertion | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- |
| First | `negative_first` | Status | `404` | Origin xác nhận object không tồn tại |
| First | `negative_first` | Cache state | `MISS` | Object chưa có trong cache |
| First | `negative_first` | `X-Negative-Cache` | `true` | Origin/CDN đánh dấu đây là negative cache object |
| Second | `negative_second` | Status | `404` | CDN trả về 404 giống origin |
| Second | `negative_second` | Cache state | `HIT` | CDN cache response 404 này |
| Second | `negative_second` | `X-Negative-Cache` | `true` | Header được bảo toàn qua cache |

**Tại sao first assertion là `404` chứ không phải `200`?**
Đây là điểm khác biệt quan trọng nhất giữa negative caching test và các case khác. Trong case 01-10, status 200 là expected. Trong case 11, **404 là expected business outcome**. Nếu bạn dùng mindset "mọi response phải 200", bạn sẽ hiểu sai case này.

### 5.6. Pha default() — phần 2: Origin count trước expiry

```javascript
  let counts = getOriginRequestCounts();
  let requestCount = findOriginRequestCount(counts, path);
  if (requestCount !== 1) {
    throw new Error(
      `expected negative cached path ${path} to hit origin once before expiry, got ${requestCount}`
    );
  }
```

Ba assertion này dùng `throw` thay vì `check` vì đây là evidence không thể bỏ qua:

| Logic | Giá trị mong đợi | Ý nghĩa |
| --- | --- | --- |
| `getOriginRequestCounts()` | Response JSON chứa `data.counts[]` | Đọc toàn bộ origin counter |
| `findOriginRequestCount(counts, path)` | `1` | Origin bị gọi đúng 1 lần cho path này |
| Nếu không bằng 1 | `throw Error` | Fail toàn bộ test (không chỉ fail check) |

**Tại sao dùng `throw` thay vì `check` cho origin count?**
- `check` ghi nhận fail nhưng không dừng script. Nếu origin count sai, toàn bộ case không có ý nghĩa — nên fail ngay.
- `throw` tạo error message mô tả chính xác giá trị thực tế và giá trị mong đợi, giúp debug nhanh.

### 5.7. Pha default() — phần 3: Sau expiry

```javascript
  sleep(NEGATIVE_WAIT_SECONDS);

  const afterExpiry = requestCdn('GET', path, {
    tags: { case: 'negative_after_expiry' },
  });
  assertStatus(afterExpiry, 404, 'negative after expiry');
  assertCacheState(afterExpiry, 'MISS', 'negative after expiry');

  counts = getOriginRequestCounts();
  requestCount = findOriginRequestCount(counts, path);
  if (requestCount !== 2) {
    throw new Error(
      `expected negative cached path ${path} to hit origin twice after expiry, got ${requestCount}`
    );
  }
}
```

| Hành động | Expected | Ý nghĩa |
| --- | --- | --- |
| `sleep(NEGATIVE_WAIT_SECONDS)` | Block 6 giây | Chờ object hết TTL |
| Request `afterExpiry` | Status `404`, Cache `MISS` | Object đã hết hạn, CDN phải hỏi lại origin |
| Origin count lần 2 | `2` | Origin bị gọi thêm lần nữa sau expiry |

**Điểm tinh tế**: `afterExpiry` vẫn trả về 404 (vì object thực sự không tồn tại), nhưng cache state là MISS. Điều này chứng minh TTL đã hết hạn chính xác — nếu object vẫn HIT, nghĩa là TTL chưa hết hoặc VCL ignore TTL.

### 5.8. Pha teardown()

```javascript
export function teardown() {
  resetOriginProfile();
  resetOriginRequestCounts();
}
```

- Luôn reset origin profile về healthy — tránh ảnh hưởng case sau.
- Reset origin request counts — clean state cho case tiếp theo.
- Không cần `banUrl` vì object đã tự expire.

---

## 6. VCL deep-dive

### 6.1. VCL là gì và vai trò trong negative caching

VCL (Varnish Configuration Language) là ngôn ngữ cấu hình của Varnish CDN. Nó định nghĩa:
- Request nào được cache.
- Response nào được cache (kể cả status code nào).
- TTL cho từng loại object.
- Cách tính cache key.

Trong case negative caching, VCL cần:

1. **Không bỏ qua response 404**: Mặc định, nhiều CDN config không cache 4xx/5xx. VCL phải cho phép cache 404.
2. **Tôn trọng TTL từ origin**: Object 404 có `Cache-Control: s-maxage=5` — VCL phải dùng giá trị này.
3. **Thêm header `X-Cache` và `X-Negative-Cache`**: Để client/test biết object được cache và đó là negative cache.

### 6.2. VCL pseudocode cho negative caching

```vcl
# vcl_backend_response — xử lý response từ origin trước khi lưu vào cache

sub vcl_backend_response {
    # Cho phép cache response 404 trong thời gian ngắn
    if (beresp.status == 404) {
        # Đánh dấu đây là negative cache object
        set beresp.http.X-Negative-Cache = "true";

        # Nếu origin không set TTL, dùng default ngắn
        if (beresp.ttl <= 0s) {
            set beresp.ttl = 5s;
        }

        # Đảm bảo object được cache (không pass)
        set beresp.uncacheable = false;

        # Grace mode: cho phép serve stale nếu cần
        set beresp.grace = 10s;
    }

    # Với response thành công, giữ TTL từ origin
    if (beresp.status == 200) {
        set beresp.http.X-Negative-Cache = "false";
        # TTL từ Cache-Control header của origin được dùng tự động
    }
}
```

```vcl
# vcl_deliver — xử lý response trước khi gửi cho client

sub vcl_deliver {
    # Thêm header cache state cho client biết
    if (obj.hits > 0) {
        set resp.http.X-Cache = "HIT";
    } else {
        set resp.http.X-Cache = "MISS";
    }

    # Giữ nguyên X-Negative-Cache từ backend response
    # (đã set ở vcl_backend_response)
}
```

### 6.3. Những điểm VCL dễ sai

| Lỗi VCL phổ biến | Hậu quả | Cách phát hiện |
| --- | --- | --- |
| `if (beresp.status >= 400) { return (pass); }` | 404 không bao giờ được cache | Request thứ hai vẫn MISS |
| Không set `beresp.uncacheable = false` cho 404 | Varnish tự động pass non-200 | X-Cache luôn là MISS hoặc không có |
| `set beresp.ttl = 0s` cho 404 | Object bị cache 0 giây = không cache | Không có HIT |
| Return `(pass)` thay vì `(deliver)` trong `vcl_recv` cho URL missing | Request không vào cache pipeline | X-Cache không xuất hiện |
| Không set `beresp.grace` cho 404 | Không có stale protection cho 404 | Case 09-style stale test fail cho 404 |

### 6.4. Debug VCL cho negative caching

Các header cần theo dõi khi debug VCL:

```text
X-Cache              → HIT/MISS — object có trong cache không?
X-Negative-Cache     → true/false — đây có phải negative cache object?
Age                  → số giây object đã ở trong cache
Cache-Control        → TTL và policy từ origin
X-Varnish            → Varnish request ID (có thể có nhiều nếu restart)
```

Dùng `varnishlog` để xem chi tiết từng request:
```bash
varnishlog -g request -q "ReqUrl ~ 'missing'" | grep -E "ReqURL|Status|TTL|Hit|X-Cache"
```

### 6.5. VCL toàn diện cho negative caching (production-ready)

Dưới đây là VCL đầy đủ hơn, xử lý nhiều edge case cho negative caching:

```vcl
# vcl_recv — xử lý request đầu vào
sub vcl_recv {
    # Không cache request có method viết (POST/PUT/PATCH/DELETE)
    if (req.method != "GET" && req.method != "HEAD") {
        return (pass);
    }

    # Không cache request có Authorization hoặc Cookie
    if (req.http.Authorization || req.http.Cookie) {
        return (pass);
    }

    # Xóa cookie khỏi request để tăng cache hit ratio
    unset req.http.Cookie;

    return (hash);
}

# vcl_backend_response — xử lý response từ origin
sub vcl_backend_response {
    # --- Negative caching: cho phép cache các status code lỗi có chủ ý ---

    # 404 Not Found — tài nguyên không tồn tại
    if (beresp.status == 404) {
        set beresp.http.X-Negative-Cache = "true";

        # Dùng TTL từ Cache-Control của origin nếu có
        # Nếu origin không set, dùng default 5 giây
        if (beresp.ttl <= 0s) {
            set beresp.ttl = 5s;
        }

        # Giới hạn TTL tối đa cho negative cache: 60 giây
        if (beresp.ttl > 60s) {
            set beresp.ttl = 60s;
        }

        set beresp.uncacheable = false;
        set beresp.grace = 10s;
        set beresp.keep = 30s;
    }

    # 410 Gone — tài nguyên đã bị xóa vĩnh viễn
    if (beresp.status == 410) {
        set beresp.http.X-Negative-Cache = "true";

        if (beresp.ttl <= 0s) {
            set beresp.ttl = 30s;  # TTL dài hơn vì object sẽ không quay lại
        }

        set beresp.uncacheable = false;
        set beresp.grace = 1m;
    }

    # 301/302 redirect — cache redirect response
    if (beresp.status == 301 || beresp.status == 302) {
        if (beresp.ttl <= 0s) {
            set beresp.ttl = 60s;
        }
        set beresp.uncacheable = false;
    }

    # --- Positive caching ---
    if (beresp.status == 200) {
        set beresp.http.X-Negative-Cache = "false";

        # Đảm bảo TTL hợp lý
        if (beresp.ttl <= 0s) {
            set beresp.ttl = 120s;
        }

        set beresp.grace = 1m;
        set beresp.keep = 10m;
    }

    # --- Không cache các status code còn lại ---
    if (beresp.status >= 500) {
        set beresp.uncacheable = true;
        set beresp.ttl = 0s;
    }

    return (deliver);
}

# vcl_deliver — thêm diagnostic headers
sub vcl_deliver {
    if (obj.hits > 0) {
        set resp.http.X-Cache = "HIT";
        set resp.http.X-Cache-Hits = obj.hits;
    } else {
        set resp.http.X-Cache = "MISS";
    }

    # Thêm header debug
    set resp.http.X-Cache-TTL = obj.ttl;
    set resp.http.X-Cache-Age = obj.age;
    set resp.http.X-Cache-Grace = obj.grace;

    # Xóa header nội bộ không muốn client thấy
    unset resp.http.X-Varnish;
    unset resp.http.Via;

    return (deliver);
}
```

### 6.6. Giải thích từng subroutine trong VCL production

**`vcl_recv`**:
- `return(pass)` cho non-GET/HEAD: bảo đảm write request không bị cache.
- `return(pass)` cho request có auth/cookie: private request không share cache.
- `unset req.http.Cookie`: tăng hit ratio — cookie làm thay đổi cache key.

**`vcl_backend_response`** — xử lý theo status code:
- **404**: TTL từ origin, max 60s, grace 10s.
- **410**: TTL mặc định 30s (dài hơn 404 vì object sẽ không quay lại).
- **301/302**: TTL mặc định 60s.
- **200**: TTL từ origin, mặc định 120s.
- **5xx**: KHÔNG cache (`uncacheable=true`).

**`vcl_deliver`**:
- Set `X-Cache`, `X-Cache-Hits`, `X-Cache-TTL`, `X-Cache-Age`.
- Xóa internal headers để không leak thông tin hạ tầng.

### 6.7. Kiểm tra VCL đúng qua manual curl

Trước khi chạy k6, có thể verify VCL bằng curl thủ công:

```powershell
# Bước 1: Ban URL để đảm bảo cache trống
curl.exe -X POST http://localhost:8088/ops/app/cdn/cache/ban-url `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer <token>" `
  -d '{"url":"/api/cached/missing/test-vcl-verify?ttl_seconds=5"}'

# Bước 2: Request lần 1 — mong đợi MISS
curl.exe -i http://localhost:80/api/cached/missing/test-vcl-verify?ttl_seconds=5
# Expected: HTTP/1.1 404, X-Cache: MISS, X-Negative-Cache: true

# Bước 3: Request lần 2 (ngay lập tức) — mong đợi HIT
curl.exe -i http://localhost:80/api/cached/missing/test-vcl-verify?ttl_seconds=5
# Expected: HTTP/1.1 404, X-Cache: HIT, X-Negative-Cache: true

# Bước 4: Đợi 6 giây, request lại — mong đợi MISS
Start-Sleep -Seconds 6
curl.exe -i http://localhost:80/api/cached/missing/test-vcl-verify?ttl_seconds=5
# Expected: HTTP/1.1 404, X-Cache: MISS, X-Negative-Cache: true
```

Nếu curl cho kết quả đúng, k6 test gần như chắc chắn sẽ pass. Nếu curl sai, cần fix VCL trước khi chạy k6.

---

## 7. Request sequence flow

### 7.1. Sequence diagram

```text
Time (seconds):  0     1     2     3     4     5     6     7
                 |     |     |     |     |     |     |     |
Client:          F-----S                               A-----
                 |     |                               |
CDN Cache:       [MISS][HIT]...................[expire].[MISS]
                 |     |                               |
Origin:          [404] |                               [404]
                       | (không gọi origin)            |
Origin Count:    1     1     1     1     1     1      2
```

Trong đó:
- `F` = First request (negative_first)
- `S` = Second request (negative_second)
- `A` = After expiry request (negative_after_expiry)
- `[MISS]` = Cache MISS, origin được gọi
- `[HIT]` = Cache HIT, không gọi origin
- `[expire]` = Object hết TTL tại giây thứ 5

### 7.2. Bảng chi tiết từng request

| # | Tag | Thời điểm | Method | Path | Status | X-Cache | X-Negative-Cache | Origin hit? | Origin count |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `negative_first` | t=0s | GET | `/api/cached/missing/missing-<ts>?ttl_seconds=5` | 404 | MISS | true | Yes | 1 |
| 2 | `negative_second` | t<1s | GET | (cùng path) | 404 | HIT | true | No | 1 |
| 3 | sleep | t=1→6s | — | — | — | — | — | — | 1 |
| 4 | `negative_after_expiry` | t=6s | GET | (cùng path) | 404 | MISS | true | Yes | 2 |

### 7.3. Control plane requests

Ngoài 3 request chính, script còn gửi các control request:

| # | Phase | Method | Path | Expected | Count in output |
| --- | --- | --- | --- | --- | --- |
| C1 | setup | POST | `/ops/app/cdn/origin/reset` | 200 | 1 |
| C2 | setup | POST | `/ops/app/cdn/origin/request-counts/reset` | 200 | 1 |
| C3 | setup | POST | `/ops/app/cdn/cache/ban-url` | 200 | 1 |
| C4 | default | GET | `/ops/app/cdn/origin/request-counts` | 200 | 2 |
| C5 | teardown | POST | `/ops/app/cdn/origin/reset` | 200 | 1 |
| C6 | teardown | POST | `/ops/app/cdn/origin/request-counts/reset` | 200 | 1 |

Tổng: 10 HTTP requests cho một lần chạy hoàn chỉnh.

### 7.4. Phân tích timeline

```text
Setup phase (trước default):
  t=-2s: resetOriginProfile()
  t=-2s: resetOriginRequestCounts()
  t=-2s: banUrl(path)

Default phase:
  t=0s:  GET path → 404 MISS (origin request count → 1)
  t=0s:  GET path → 404 HIT  (origin request count vẫn 1)
  t=0s:  GET origin/request-counts → check count = 1
  t=1s:  sleep(6) — chờ TTL hết hạn
  t=6s:  GET path → 404 MISS (origin request count → 2)
  t=6s:  GET origin/request-counts → check count = 2

Teardown phase:
  t=7s:  resetOriginProfile()
  t=7s:  resetOriginRequestCounts()
```

---

## 8. Key signals / headers

### 8.1. Headers chính

| Header | Nguồn | Giá trị trong case này | Ý nghĩa |
| --- | --- | --- | --- |
| `X-Cache` | Varnish (VCL `vcl_deliver`) | `MISS` → `HIT` → `MISS` | Object có trong cache không |
| `X-Negative-Cache` | Origin (echo qua Varnish) | `true` | Đây là negative cache object |
| `Cache-Control` | Origin | `public, s-maxage=5` | TTL cho shared cache |
| `Age` | Varnish | `0` (MISS), `0-5` (HIT) | Số giây object đã ở trong cache |
| `X-Cache-Key-Language` | Varnish | `vi` | Cache key dimension: ngôn ngữ |
| `X-Cache-Key-Geo` | Varnish | `VN` | Cache key dimension: quốc gia |
| `X-Cache-Key-Device` | Varnish | `desktop` | Cache key dimension: thiết bị |
| `X-Cache-Key-AB` | Varnish | `control` | Cache key dimension: A/B variant |
| `Content-Type` | Origin | `application/json` | Body là JSON |
| `X-Varnish` | Varnish | VD: `32770 32769` | Varnish request ID nội bộ |

### 8.2. Cách đọc header sequence

```text
Kỳ vọng đúng:
  Request 1: X-Cache=MISS, X-Negative-Cache=true, Status=404
  Request 2: X-Cache=HIT,  X-Negative-Cache=true, Status=404
  Request 3: X-Cache=MISS, X-Negative-Cache=true, Status=404

Kỳ vọng sai (cần điều tra):
  Request 2: X-Cache=MISS           → 404 không được cache
  Request 2: X-Cache=HIT, Status=200 → sai object được cache
  Request 3: X-Cache=HIT            → TTL chưa hết hạn (có thể NEGATIVE_WAIT_SECONDS chưa đủ)
  Request 3: X-Cache=HIT, Status=200 → object bị thay thế bởi response khác
```

### 8.3. Origin request count payload

API `GET /ops/app/cdn/origin/request-counts` trả về JSON:

```json
{
  "success": true,
  "data": {
    "counts": [
      {
        "request_key": "/api/cached/missing/missing-1782128576823?ttl_seconds=5",
        "count": 1,
        "last_request_at": "2026-06-22T11:42:03Z"
      },
      {
        "request_key": "/ops/app/cdn/origin/request-counts",
        "count": 2,
        "last_request_at": "2026-06-22T11:42:04Z"
      }
    ]
  }
}
```

Giải thích:
- `request_key` = path được request lên origin.
- `count` = số lần CDN đã forward request này đến origin.
- `last_request_at` = thời điểm request cuối cùng.

**Lưu ý**: Mỗi lần gọi `GET .../origin/request-counts` cũng được tính là một origin request. Vì vậy `count` cho path counts endpoint sẽ tăng dần. Đây là lý do `findOriginRequestCount` chỉ tìm theo `request_key` của path cần test.

---

## 9. Pass/fail criteria

### 9.1. Tiêu chí PASS

```text
✅ k6 exit code = 0
✅ checks rate = 100% (tất cả 15 checks pass)
✅ http_req_failed rate không cần = 0 (vì 404 là expected HTTP failure)
✅ X-Cache sequence: MISS → HIT → MISS
✅ X-Negative-Cache: true cho cả ba request
✅ Origin request count = 1 trước expiry
✅ Origin request count = 2 sau expiry
✅ Không có error log từ k6 (ngoài threshold warning nếu có)
```

### 9.2. Tiêu chí FAIL

```text
❌ k6 exit code != 0
❌ Bất kỳ check nào fail (checks rate < 100%)
❌ Request đầu tiên không phải 404 → origin trả về status khác
❌ Request đầu tiên X-Cache = HIT → object đã có trong cache từ trước
❌ Request thứ hai X-Cache = MISS → CDN không cache 404
❌ Origin count ≠ 1 trước expiry → origin bị gọi sai số lần
❌ Sau expiry X-Cache = HIT → TTL không hết hạn
❌ Origin count ≠ 2 sau expiry → origin không được gọi hoặc bị gọi quá nhiều
```

### 9.3. Bảng pass/fail matrix

| Kịch bản | First status | First cache | Second cache | After expiry cache | Origin count (trước/sau) | Kết luận |
| --- | --- | --- | --- | --- | --- | --- |
| A | 404 | MISS | HIT | MISS | 1/2 | PASS |
| B | 404 | MISS | MISS | MISS | 2/3 | FAIL: CDN không cache 404 |
| C | 404 | MISS | HIT | HIT | 1/1 | FAIL: TTL không hết hạn |
| D | 404 | HIT | HIT | MISS | 0/1 | FAIL: cache không được clean trước test |
| E | 200 | MISS | HIT | MISS | 1/2 | FAIL: URL trả về sai status |
| F | 404 | MISS | HIT | MISS | 0/1 | FAIL: origin counter sai hoặc không đếm |

### 9.4. Cách đọc pass/fail từ k6 output thực tế

Từ file `11-negative-caching-rerun.txt` (PASS):

```text
█ THRESHOLDS
  checks
  ✓ 'rate==1' rate=100.00%

█ TOTAL RESULTS
  checks_total.......: 15      2.488271/s
  checks_succeeded...: 100.00% 15 out of 15
  checks_failed......: 0.00%   0 out of 15

  ✓ reset origin profile status 200
  ✓ reset origin request counts status 200
  ✓ ban-url ... status 200
  ✓ negative first status 404
  ✓ negative first cache state MISS
  ✓ negative first X-Negative-Cache equals true
  ✓ negative second status 404
  ✓ negative second cache state HIT
  ✓ negative second X-Negative-Cache equals true
  ✓ origin request counts status 200
  ✓ negative after expiry status 404
  ✓ negative after expiry cache state MISS

  http_req_failed................: 30.00% 3 out of 10
```

**Quan trọng**: `http_req_failed = 30.00%` (3/10 request HTTP fail). Đây là expected — 3 request trả về 404 được k6 đếm là HTTP failure. KHÔNG dùng `http_req_failed: ['rate==0']` làm threshold cho case này.

---

## 10. Cách chạy + output mẫu

### 10.1. Cách chạy qua PowerShell runner

```powershell
cd E:\Projects\k6\k6-metrics-server

$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

.\scripts\run-cdn-capabilities.ps1 -Scenarios 11-negative-caching
```

### 10.2. Cách chạy trực tiếp bằng k6

```powershell
cd E:\Projects\k6\k6-metrics-server\load-target

$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

k6 run .\k6\cdn\11-negative-caching.js
```

### 10.3. Output mẫu — PASS (rerun thành công)

```text
         /\      Grafana   /‾‾/
    /\  /  \     |\  __   /  /
   /  \/    \    | |/ /  /   ‾‾\
  /          \   |   (  |  (‾)  |
 / __________ \  |_|\_\  \_____/

     execution: local
        script: E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\11-negative-caching.js
        output: -

     scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration
              * default: 1 iterations shared among 1 VUs

  █ THRESHOLDS
    checks
    ✓ 'rate==1' rate=100.00%

  █ TOTAL RESULTS
    checks_total.......: 15      2.488271/s
    checks_succeeded...: 100.00% 15 out of 15
    checks_failed......: 0.00%   0 out of 15

    ✓ reset origin profile status 200
    ✓ reset origin request counts status 200
    ✓ ban-url /api/cached/missing/missing-1782128576823?ttl_seconds=5 status 200
    ✓ negative first status 404
    ✓ negative first cache state MISS
    ✓ negative first X-Negative-Cache equals true
    ✓ negative second status 404
    ✓ negative second cache state HIT
    ✓ negative second X-Negative-Cache equals true
    ✓ origin request counts status 200
    ✓ negative after expiry status 404
    ✓ negative after expiry cache state MISS

    HTTP
    http_req_duration..............: avg=1.34ms min=514.59µs med=1.11ms max=3.52ms
    http_req_failed................: 30.00% 3 out of 10
    http_reqs......................: 10     1.658847/s

    EXECUTION
    iteration_duration.............: avg=6s     min=6s       med=6s     max=6s
    iterations.....................: 1      0.165885/s

running (00m06.0s), 0/1 VUs, 1 complete and 0 interrupted iterations
default ✓ [ 100% ] 1 VUs  00m06.0s/10m0s  1/1 shared iters
```

Các điểm quan trọng trong output:
- `iteration_duration = 6s`: đúng bằng `NEGATIVE_WAIT_SECONDS` (mặc định 6).
- `http_req_failed = 30.00%`: 3/10 request HTTP fail (3 response 404).
- `checks_succeeded = 15/15`: tất cả check pass.
- Không có error log — không có `throw` nào bị trigger.

### 10.4. Output mẫu — FAIL (lần chạy đầu)

```text
time="2026-06-22T18:42:02+07:00" level=error msg="Error: expected negative
cached path /api/cached/missing/missing-1782128522093?ttl_seconds=5 to hit
origin once before expiry, got 0\n\tat default (...)" executor=shared-iterations

  █ THRESHOLDS
    checks
    ✗ 'rate==1' rate=58.33%

  █ TOTAL RESULTS
    checks_total.......: 12     556.268919/s
    checks_succeeded...: 58.33% 7 out of 12
    checks_failed......: 41.66% 5 out of 12

    ✓ reset origin profile status 200
    ✓ reset origin request counts status 200
    ✓ ban-url ... status 200
    ✗ negative first status 404          ← first request không trả về 404
    ✓ negative first cache state MISS
    ✗ negative first X-Negative-Cache equals true  ← header không có
    ✗ negative second status 404         ← second request cũng không 404
    ✗ negative second cache state HIT
    ✗ negative second X-Negative-Cache equals true
    ✓ origin request counts status 200
```

Phân tích fail:
- First request không trả về 404, dẫn đến hàng loạt check fail.
- `origin count = 0`: origin chưa từng nhận request cho path này.
- Nguyên nhân có thể: ứng dụng chưa start kịp, route `/api/cached/missing` chưa registered, hoặc CDN đang pass request đến sai backend.

---

## 11. Bốn output → decision scenarios

### 11.1. Scenario A: PASS hoàn hảo

```text
checks: 100% (15/15)
http_req_failed: 30% (3/10)
X-Cache sequence: MISS → HIT → MISS
Origin count: 1 → 2
```

**Quyết định**: CDN negative caching hoạt động đúng. Deploy lên production an toàn. Có thể tự tin giảm tải origin cho 404 traffic.

### 11.2. Scenario B: 404 không được cache

```text
checks: ~70% fail
X-Cache sequence: MISS → MISS → MISS
X-Negative-Cache: true (hoặc absent)
Origin count: 1 → 2 → 3
```

**Quyết định**: VCL không cache 404. Cần kiểm tra:
- `vcl_backend_response` có xử lý `beresp.status == 404` không?
- Có rule nào `return(pass)` cho status >= 400 không?
- `beresp.uncacheable` có bị set `true` cho 404 không?

**Impact**: Origin sẽ bị mọi request 404 đánh vào. Cần fix VCL trước khi deploy.

### 11.3. Scenario C: TTL không hết hạn

```text
checks: ~90% pass (fail at after_expiry)
X-Cache sequence: MISS → HIT → HIT (vẫn HIT sau sleep)
Origin count: 1 → 1 (không tăng)
```

**Quyết định**: TTL được set quá dài hoặc VCL ghi đè TTL. Cần kiểm tra:
- `NEGATIVE_TTL_SECONDS` có được set đúng không?
- `NEGATIVE_WAIT_SECONDS` có > TTL không?
- VCL có set `beresp.ttl = 300s` cứng cho mọi response không?

**Impact**: Sản phẩm mới được thêm vào nhưng CDN vẫn trả 404 trong thời gian dài. User không thấy sản phẩm mới. Tệ hơn nếu TTL dài và quản lý sản phẩm thêm hàng loạt.

### 11.4. Scenario D: Origin counter không hoạt động

```text
checks: 100% pass (các check cache/status)
Origin count: 0 (hoặc null)
```

**Quyết định**: Control endpoint `/ops/app/cdn/origin/request-counts` không hoạt động. Không thể verify evidence định lượng. Cần kiểm tra:
- Control path `:8088` có đúng không?
- Token `OPS_AUTH_TOKEN` có hợp lệ không?
- Endpoint có được implement trong bản build hiện tại không?

**Impact**: Không thể phân biệt "cache HIT thật" và "cache HIT do miss count". Cần fix control plane trước.

### 11.5. Bảng tóm tắt 4 scenario

| Scenario | Check rate | Pattern | Root cause | Action |
| --- | --- | --- | --- | --- |
| A | 100% | MISS→HIT→MISS, count=1→2 | Hoàn hảo | Deploy |
| B | ~30% | MISS→MISS→MISS, count>2 | VCL không cache 404 | Fix VCL |
| C | ~90% | MISS→HIT→HIT, count=1→1 | TTL quá dài | Giảm TTL hoặc fix VCL |
| D | ~70% | Cache OK, count=0 | Control plane lỗi | Fix control endpoint |

---

## 12. Nghịch lý / misconceptions

### 12.1. Nghịch lý 1: "404 là lỗi, test phải trả về 200 mới pass"

Đây là misconception phổ biến nhất. Trong executor test (constant-vus, ramping-vus), `http_req_failed` threshold thường được set `rate<0.01` — nghĩa là hầu như không có request lỗi. Nhưng trong CDN negative caching test:

- **404 là expected business outcome**. Object không tồn tại, nên response 404 là chính xác.
- **Pass/fail được quyết định bởi checks, không phải HTTP status**.
- **`http_req_failed` 30% là bình thường** cho case này.

Nếu bạn dùng mindset executor và set `http_req_failed: ['rate==0']` cho case 11, threshold sẽ fail ngay cả khi mọi thứ hoạt động đúng.

### 12.2. Nghịch lý 2: "Cache HIT cho 404 là dấu hiệu lỗi"

Khi thấy `X-Cache: HIT` + `Status: 404`, developer thường nghĩ "cache đã cache nhầm response lỗi". Nhưng trong negative caching, đây là **hành vi mong muốn** — CDN đã cache 404 để bảo vệ origin.

Điểm phân biệt: `X-Negative-Cache: true` xác nhận đây là intentional negative cache, không phải cache nhầm.

### 12.3. Nghịch lý 3: "TTL ngắn (5 giây) thì cache có ý nghĩa gì?"

5 giây nghe có vẻ ngắn, nhưng với traffic pattern thực tế:
- Một bot quét 1000 URL/giây → trong 5 giây, mỗi URL bị gọi 5 lần → cache giảm 80% origin hit.
- Một user refresh trang 404 2-3 lần → tất cả refresh đều HIT.
- Một chiến dịch email với 1 triệu người nhận click link sai trong 5 giây đầu → toàn bộ traffic được cache.

TTL 5 giây là đủ dài để hấp thụ burst traffic, nhưng đủ ngắn để sản phẩm mới thêm vào không bị 404 giả quá lâu.

### 12.4. Misconception 4: "Origin không nên trả 404 cho missing path — nên trả 200 với empty body"

Một số team thích trả về 200 với `{ "data": null }` cho resource không tồn tại thay vì 404. Điều này **phá hỏng negative caching** vì:
- CDN cache 200 với TTL dài → khó phân biệt object không tồn tại với object rỗng.
- Search engine index 200 empty page → SEO issue.
- Client không biết resource có tồn tại không nếu chỉ nhìn status code.
- RESTful convention: 404 = Not Found, không nên lạm dụng 200.

### 12.5. Misconception 5: "Chỉ cần test một lần, nếu pass là xong"

Negative caching là behavior phụ thuộc thời gian (TTL). Một lần pass không đảm bảo:
- TTL luôn được tôn trọng (có thể bị network latency hoặc clock skew làm sai).
- Cache không bị evict sớm (memory pressure có thể đẩy object ra trước TTL).
- Behavior nhất quán với TTL khác nhau.

Nên test ít nhất 2 lần với TTL khác nhau (ví dụ: 2s và 10s).

---

## 13. Checklist

### 13.1. Pre-run checklist

```text
[ ] Full stack đã start: docker compose ps → tất cả service running
[ ] TargetLayer=full: check-target-routing.ps1 pass
[ ] Port 80 khả dụng: curl http://localhost:80/health → 200
[ ] Port 8088 khả dụng: curl http://localhost:8088/health → 200
[ ] Origin healthy: GET /ops/app/cdn/origin/profile → healthy=true
[ ] OPS_AUTH_TOKEN đã set và hợp lệ
[ ] Không có script nào khác đang chạy (cache/control state dùng chung)
[ ] NEGATIVE_TTL_SECONDS đã set (nếu muốn khác default 5s)
[ ] NEGATIVE_WAIT_SECONDS > NEGATIVE_TTL_SECONDS
```

### 13.2. Runtime checklist

```text
[ ] k6 không crash hoặc timeout
[ ] iteration_duration ≈ NEGATIVE_WAIT_SECONDS
[ ] Checks rate hiển thị trong output
[ ] Không có error log (không có "level=error")
[ ] Tất cả check có tag "negative" đều pass
```

### 13.3. Post-run checklist

```text
[ ] k6 exit code = 0
[ ] checks rate = 100% (15/15)
[ ] negative first: status=404, X-Cache=MISS, X-Negative-Cache=true
[ ] negative second: status=404, X-Cache=HIT, X-Negative-Cache=true
[ ] Trước expiry: origin count = 1
[ ] negative after expiry: status=404, X-Cache=MISS
[ ] Sau expiry: origin count = 2
[ ] http_req_failed = 30% (±3/10) — expected
[ ] Không ảnh hưởng case sau (teardown đã reset)
```

### 13.4. Debug checklist (nếu fail)

```text
[ ] Kiểm tra first request có thực sự đến origin không: log origin app
[ ] Kiểm tra VCL có chặn cache cho 404 không: varnishlog
[ ] Kiểm tra TTL thực tế object nhận được: varnishlog | grep TTL
[ ] Kiểm tra port 80 có thực sự đi qua Varnish không (không bypass trực tiếp app)
[ ] Kiểm tra token ops có hết hạn không
[ ] Kiểm tra origin counter có reset đúng không (chạy curl trực tiếp)
[ ] Thử tăng NEGATIVE_WAIT_SECONDS lên TTL + 3
```

---

## 14. Variations với code

### 14.1. Variation 1: TTL ngắn hơn

```powershell
$env:NEGATIVE_TTL_SECONDS = "2"
$env:NEGATIVE_WAIT_SECONDS = "3"
```

Mục đích: Kiểm tra TTL rất ngắn có hoạt động không. Object hết hạn sau 2 giây.

**Kỳ vọng**: Sequence giống hệt, nhưng `iteration_duration` chỉ ~3s thay vì 6s.

**Rủi ro**: Nếu TTL quá ngắn (1s), clock skew giữa k6 và Varnish có thể gây false negative. Không nên test với TTL < 2s.

### 14.2. Variation 2: TTL dài hơn

```powershell
$env:NEGATIVE_TTL_SECONDS = "30"
$env:NEGATIVE_WAIT_SECONDS = "31"
```

Mục đích: Xác nhận TTL dài vẫn hoạt động đúng. Hữu ích cho resource ít thay đổi (ví dụ: trang policy, trang lỗi tùy chỉnh).

**Kỳ vọng**: Sequence giống hệt, iteration duration ~31s.

**Lưu ý**: Không nên để TTL quá dài cho production negative cache — nếu sản phẩm mới thêm vào, user sẽ thấy 404 trong 30 giây.

### 14.3. Variation 3: Multiple URLs cùng TTL

```javascript
// Sửa script để test nhiều URL cùng lúc
export default function (data) {
  const paths = [
    buildCachedMissingPath(`batch-a-${Date.now()}`, { ttl_seconds: NEGATIVE_TTL_SECONDS }),
    buildCachedMissingPath(`batch-b-${Date.now()}`, { ttl_seconds: NEGATIVE_TTL_SECONDS }),
    buildCachedMissingPath(`batch-c-${Date.now()}`, { ttl_seconds: NEGATIVE_TTL_SECONDS }),
  ];

  for (const path of paths) {
    const first = requestCdn('GET', path, { tags: { case: 'multi_first' } });
    assertStatus(first, 404, 'multi first');
    assertCacheState(first, 'MISS', 'multi first');

    const second = requestCdn('GET', path, { tags: { case: 'multi_second' } });
    assertStatus(second, 404, 'multi second');
    assertCacheState(second, 'HIT', 'multi second');
  }

  const counts = getOriginRequestCounts();
  for (const path of paths) {
    const count = findOriginRequestCount(counts, path);
    if (count !== 1) {
      throw new Error(`path ${path}: expected count 1, got ${count}`);
    }
  }
}
```

Mục đích: Xác nhận nhiều negative cache object không ảnh hưởng lẫn nhau.

### 14.4. Variation 4: Response 410 Gone thay vì 404

```javascript
// Sửa origin handler để trả về 410 Gone cho một số path
// (yêu cầu sửa application code, không chỉ sửa test script)

const first = requestCdn('GET', gonePath, { tags: { case: 'gone_first' } });
assertStatus(first, 410, 'gone first');
// Vẫn mong đợi X-Cache: MISS -> HIT -> MISS
```

Mục đích: Kiểm tra xem VCL có cache các status code khác ngoài 404 không.

**Lưu ý**: 410 Gone khác 404 — 410 nghĩa là "đã từng tồn tại nhưng bị xóa vĩnh viễn". Search engine xử lý 410 khác 404. Nếu CDN cache 410, TTL có thể dài hơn.

### 14.5. Variation 5: Negative caching với burst concurrent

```javascript
export const options = {
  vus: 10,           // 10 VU đồng thời
  iterations: 10,    // mỗi VU 1 iteration
  thresholds: {
    checks: ['rate==1'],
  },
};

export default function (data) {
  const path = data.path;

  const res = requestCdn('GET', path, {
    tags: { case: 'negative_burst' },
  });

  // Tất cả request sau request đầu tiên nên HIT
  // (nhưng concurrent có thể có race condition)
  // Origin count vẫn nên = 1 (coalescing cho 404)
}
```

Mục đích: Kết hợp test negative caching + request coalescing cho response 404.

---

## 15. Anti-patterns

### 15.1. Anti-pattern 1: Set `http_req_failed: ['rate==0']` cho case này

```javascript
// SAI — không dùng threshold này cho case 11
export const options = {
  thresholds: {
    http_req_failed: ['rate==0'],  // Sẽ fail vì 404 là HTTP failure
  },
};
```

**Tại sao sai**: 3/10 request trả về 404. k6 đếm response có status >= 400 là HTTP failure. Threshold `rate==0` sẽ luôn fail.

**Cách đúng**: Không set `http_req_failed` threshold, hoặc set `['rate<0.5']` nếu muốn có threshold mềm.

### 15.2. Anti-pattern 2: Dùng `assertStatus(first, 200, ...)` vì thói quen

```javascript
// SAI — case này expect 404, không phải 200
assertStatus(first, 200, 'negative first');  // Check này sẽ fail
```

**Tại sao sai**: Copy-paste từ case khác mà không đọc logic. Case 11 expect **404** cho mọi public request.

### 15.3. Anti-pattern 3: Dùng chung path cho nhiều lần chạy

```javascript
// SAI — path cố định, lần chạy thứ 2 sẽ HIT từ cache cũ
const path = '/api/cached/missing/fixed-path-123';
```

**Tại sao sai**: Lần chạy thứ 2 trở đi, object có thể vẫn còn trong cache (nếu TTL chưa hết hạn) hoặc origin counter đã có count từ lần trước. Luôn dùng path động với `Date.now()`.

### 15.4. Anti-pattern 4: Không verify origin count

```javascript
// SAI — chỉ check cache state, không check origin count
const second = requestCdn('GET', path, ...);
assertCacheState(second, 'HIT', 'negative second');
// Thiếu: getOriginRequestCounts() + findOriginRequestCount()
```

**Tại sao sai**: `X-Cache: HIT` có thể là HIT từ một object khác (cache key collision), hoặc HIT do CDN trả về stale. Origin count là evidence cuối cùng chứng minh origin chỉ bị gọi 1 lần.

### 15.5. Anti-pattern 5: Set `NEGATIVE_WAIT_SECONDS = NEGATIVE_TTL_SECONDS`

```javascript
// SAI — buffer không đủ, có thể race condition
const NEGATIVE_WAIT_SECONDS = envFloat('NEGATIVE_WAIT_SECONDS', NEGATIVE_TTL_SECONDS);
```

**Tại sao sai**: Nếu TTL là 5.0s và bạn sleep 5.0s, có thể request thứ ba đến ngay khi object vừa hết hạn (cùng một giây). Varnish có thể vẫn coi object là fresh do clock granularity. Luôn thêm ít nhất 1 giây buffer.

### 15.6. Anti-pattern 6: Không reset origin profile trước test

```javascript
// SAI — origin có thể unhealthy từ case trước (case 09)
export function setup() {
  const path = buildCachedMissingPath(...);
  banUrl(path);
  // Thiếu: resetOriginProfile()
  // Thiếu: resetOriginRequestCounts()
  return { path };
}
```

**Tại sao sai**: Sau case 09 (stale-while-error), origin bị set unhealthy. Case 11 cần origin healthy để nhận request. Thiếu `resetOriginProfile()` khiến first request có thể không đến được origin.

---

## 16. Real validation data

### 16.1. Kết quả chạy thực tế — PASS

**Ngày chạy**: 2026-06-22
**Script**: `11-negative-caching.js`
**Môi trường**: `TargetLayer=full`, Windows 11, Docker Desktop

```text
Kết quả:
  Exit code: 0
  Checks: 15/15 (100%)
  HTTP requests: 10 (3 failed = 30% — expected)
  Iteration duration: 6s

  Check breakdown:
    ✓ reset origin profile status 200
    ✓ reset origin request counts status 200
    ✓ ban-url /api/cached/missing/missing-1782128576823?ttl_seconds=5 status 200
    ✓ negative first status 404
    ✓ negative first cache state MISS
    ✓ negative first X-Negative-Cache equals true
    ✓ negative second status 404
    ✓ negative second cache state HIT
    ✓ negative second X-Negative-Cache equals true
    ✓ origin request counts status 200
    ✓ negative after expiry status 404
    ✓ negative after expiry cache state MISS

  HTTP metrics:
    http_req_duration: avg=1.34ms, min=514.59µs, med=1.11ms, max=3.52ms
    http_req_failed: 30.00% (3/10)

  Execution:
    iteration_duration: avg=6s
```

### 16.2. Kết quả chạy thực tế — FAIL (lần đầu tiên)

**Ngày chạy**: 2026-06-22 (trước lần rerun)
**Nguyên nhân fail**: Ứng dụng chưa khởi tạo kịp handler cho route `/api/cached/missing/*`. First request không trả về 404 (có thể nhận được 500 hoặc connection refused), dẫn đến:
- `negative first status 404`: FAIL
- `negative first X-Negative-Cache equals true`: FAIL
- `negative second status 404`: FAIL
- `negative second cache state HIT`: FAIL
- `negative second X-Negative-Cache equals true`: FAIL
- Origin request count = 0

```text
  Checks: 7/12 (58.33%)
  HTTP requests: 8 (2 failed = 25%)
  Error: expected negative cached path ... to hit origin once before expiry, got 0
```

**Bài học**: Pre-run checklist cần có bước xác nhận tất cả application route đã sẵn sàng. Không chỉ check health endpoint, cần probe cả route sẽ dùng trong test.

### 16.3. Phân tích số liệu

| Chỉ số | Lần fail | Lần pass | Nhận xét |
| --- | --- | --- | --- |
| Checks | 7/12 (58%) | 15/15 (100%) | PASS gấp đôi số check vì chạy hết flow |
| HTTP requests | 8 | 10 | FAIL dừng sớm (throw Error ở origin count check) |
| http_req_failed | 25% (2/8) | 30% (3/10) | Cả hai đều có HTTP fail do 404 |
| http_req_duration (avg) | 1.09ms | 1.34ms | Tương đương |
| iteration_duration | 4.02ms | 6s | FAIL dừng sớm; PASS mất 6s do sleep |

### 16.4. So sánh với case 08 (TTL expiry) và case 09 (stale)

| Khía cạnh | Case 08 (TTL) | Case 09 (Stale) | Case 11 (Negative) |
| --- | --- | --- | --- |
| Object type | 200 OK | 200 OK | 404 Not Found |
| TTL | ~20s | 2s | 5s |
| Sequence | MISS→HIT→(wait)→MISS | MISS→HIT→(wait)→HIT(stale) | MISS→HIT→(wait)→MISS |
| Origin count | 1→2 | 1→1 (stale không gọi origin) | 1→2 |
| Special header | — | X-Cache-Stale, X-Cache-Backend-Healthy | X-Negative-Cache |
| http_req_failed | 0% | 0% | 30% — khác biệt quan trọng |
| Cần unhealthy origin? | Không | Có | Không |

---

## 17. Reference

### 17.1. Source files

| File | Đường dẫn | Mô tả |
| --- | --- | --- |
| Script chính | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\11-negative-caching.js` | k6 test script |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` | Hàm helper dùng chung |
| Common utilities | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | envInt, envFloat, envString |
| Run results (PASS) | `E:\Khoa hoc\k6\.claude-cdn-case-outputs\11-negative-caching-rerun.txt` | Output thực tế pass |
| Run results (FAIL) | `E:\Khoa hoc\k6\.claude-cdn-case-outputs\11-negative-caching.txt` | Output lần fail đầu |

### 17.2. Tài liệu liên quan

| Tài liệu | Đường dẫn | Nội dung |
| --- | --- | --- |
| Overview | `./00_overview.md` | Tổng quan series CDN |
| Run guide | `./RUN_GUIDE.md` | Hướng dẫn chạy tất cả case |
| Validation report | `./12_validation-and-chart-analysis.md` | Tổng hợp kết quả 11 case |
| Case 08: TTL expiry | `./08_ttl-expiry.md` | Case liên quan: cơ chế TTL |
| Case 09: Stale | `./09_stale-while-error.md` | Case liên quan: stale serving |
| Source README | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md` | README từ source |

### 17.3. Tài liệu tham khảo ngoài

| Tài liệu | URL / Mô tả |
| --- | --- |
| Varnish docs: Cache TTL | https://varnish-cache.org/docs/ — `beresp.ttl` và cache policy |
| Varnish docs: VCL backend response | https://varnish-cache.org/docs/ — `vcl_backend_response` |
| HTTP spec: 404 Not Found | RFC 7231, Section 6.5.4 |
| Fastly: Negative caching | https://docs.fastly.com/en/guides/negative-caching |
| Cloudflare: Cache 404 | https://developers.cloudflare.com/cache/ — default cache behavior |

### 17.4. Ghi chú về phiên bản

```text
Script version: current (as of 2026-06-22)
k6 version: latest (used with shared-iterations executor)
Target layer: full (Varnish CDN enabled)
Control API version: /ops/app/cdn/* endpoints
```

### 17.5. Liên hệ với các case khác trong series

```text
Case 01 (HIT smoke)       → Cùng cơ chế MISS→HIT, nhưng với 200
Case 08 (TTL expiry)      → Cùng cơ chế TTL expiry, nhưng với 200
Case 09 (Stale)           → Cùng dùng origin counter, nhưng cho stale serving
Case 10 (Coalescing)      → Cùng dùng origin counter, nhưng cho concurrent burst

Case 11 là case duy nhất trong series expect status 404.
Case 11 là case duy nhất KHÔNG nên set http_req_failed threshold.
```

---

> **Tổng kết**: Negative caching là một capability tưởng chừng đơn giản nhưng cực kỳ quan trọng trong hệ thống thực tế. Nó bảo vệ origin khỏi traffic vô ích, giảm chi phí hạ tầng, và đảm bảo người dùng thật không bị ảnh hưởng bởi request không hợp lệ. Case này chứng minh CDN có thể cache 404, tôn trọng TTL, và expire đúng thời điểm — ba yếu tố tạo nên một negative caching implementation đúng đắn.
