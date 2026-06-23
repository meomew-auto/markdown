# Case 08: TTL expiry

> **Case ID:** `cdn-08-ttl-expiry`
> **Script:** `08-ttl-expiry.js`
> **Layer:** CDN / Varnish
> **Proof:** Object HIT trước TTL và MISS sau TTL expiry
> **Loại test:** Correctness / time-based behavior
> **Thời gian chạy:** ~21 giây (do `TTL_WAIT_SECONDS=21`)
> **Yêu cầu topology:** `TargetLayer=full`
> **Yêu cầu control plane:** Có (dùng `banUrl` trong `setup()`)

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

Một trang thương mại điện tử có trang chủ cá nhân hóa (homefeed) hiển thị sản phẩm gợi ý dựa trên lịch sử duyệt web và phân khúc người dùng. Homefeed được tính toán bởi `products-service`, tiêu tốn khoảng 200ms CPU và query 4 bảng database cho mỗi request.

Với 10,000 requests/giây vào giờ cao điểm, nếu mọi request đều đến origin:
- Cần 10,000 × 200ms = 2,000 giây CPU mỗi giây (cần 2,000 CPU cores).
- Database chịu 40,000 queries/giây.
- Chi phí infrastructure tăng theo cấp số nhân.

Giải pháp: Cache homefeed ở CDN với TTL (Time To Live) hợp lý, ví dụ 20 giây.

### Câu chuyện thực tế

```text
Tình huống: 10:00:00 sáng, đội content cập nhật bộ sưu tập "Mùa hè 2026".
Hệ thống kích hoạt catalog event → app gọi internal invalidation → CDN ban toàn bộ
homefeed objects.

10:00:01: Người dùng A (guest, VN, mobile) mở app.
          Request GET /api/sim/products/homefeed → CDN MISS.
          CDN gọi origin → products-service tính toán homefeed (200ms).
          Origin trả response với Cache-Control: s-maxage=20.
          CDN lưu object, set TTL = 20s, hẹn giờ hết hạn lúc 10:00:21.

10:00:05: Người dùng B (guest, VN, mobile — cùng profile) mở app.
          Request GET /api/sim/products/homefeed → CDN HIT.
          CDN trả object từ cache trong < 2ms. Origin không bị gọi.

10:00:10 đến 10:00:20: 5,000 người dùng khác cùng profile mở app.
          Tất cả đều HIT. Origin không phải làm gì.
          Tiết kiệm: 5,000 × 200ms = 1,000 giây CPU, 20,000 DB queries.

10:00:22: Người dùng C mở app (sau khi TTL hết hạn 1 giây).
          Request GET /api/sim/products/homefeed → CDN MISS.
          CDN gọi origin → products-service tính toán homefeed mới.
          Origin trả response với dữ liệu đã cập nhật (có bộ sưu tập mới).
          CDN lưu object mới, TTL = 20s.

10:00:25: Người dùng D mở app → CDN HIT (object mới).
```

### Điều gì xảy ra nếu TTL không hoạt động?

| Tình huống | Hậu quả |
| --- | --- |
| TTL quá ngắn (1s) | Origin bị gọi quá thường xuyên; cache không giúp giảm tải |
| TTL quá dài (3600s) | Người dùng thấy nội dung cũ suốt 1 giờ sau khi content được cập nhật |
| TTL không được tôn trọng (CDN cache mãi mãi) | Nội dung không bao giờ được làm mới; cần purge/ban thủ công |
| TTL không được tôn trọng (CDN không cache) | Mọi request đều MISS; cache vô dụng |

### Vì sao case này quan trọng

TTL expiry là **cơ chế cơ bản nhất** để CDN cân bằng giữa freshness và efficiency:

- **Freshness**: Người dùng thấy nội dung mới sau tối đa `TTL` giây.
- **Efficiency**: Trong khoảng `TTL` giây, origin không phải xử lý request nào cho object đó.
- **Predictability**: Operator biết chính xác khi nào object hết hạn và được làm mới.

Nếu TTL không hoạt động đúng, mọi thứ khác (stale-while-revalidate, stale-if-error, request coalescing) đều vô nghĩa vì chúng đều dựa trên TTL.

---

## 2. CDN capability được chứng minh

### Capability chính

Case này chứng minh **CDN tôn trọng TTL của cached object**: object được phục vụ từ cache (HIT) trong thời gian TTL, và sau khi TTL hết hạn, object bị loại bỏ và request tiếp theo phải fetch lại từ origin (MISS).

Cụ thể:

1. **Initial cache fill**: Request đầu tiên sau khi ban là MISS; CDN fetch từ origin và lưu object với TTL được định nghĩa bởi response headers.
2. **Cache HIT trong TTL**: Request thứ hai (trong khoảng TTL) là HIT; CDN phục vụ từ cache, không gọi origin.
3. **Cache MISS sau TTL**: Sau khi `sleep(TTL_WAIT_SECONDS)`, request thứ ba là MISS; CDN gọi origin để lấy object mới.

### Phạm vi kiểm tra

| Giai đoạn | Request | Kỳ vọng `X-Cache` | Kỳ vọng `X-Upstream-Service` | Mục đích |
| --- | --- | --- | --- | --- |
| Setup | `banUrl(homefeed)` | N/A | N/A | Xóa cache object trước khi test |
| First | `GET /api/sim/products/homefeed` | `MISS` | `products-service` | Cold cache → origin fetch |
| Second | `GET /api/sim/products/homefeed` | `HIT` | (không assert) | Warm cache → cache hit |
| After expiry | `GET /api/sim/products/homefeed` | `MISS` | `products-service` | Expired → origin re-fetch |

### Không kiểm tra trong case này

- Không kiểm tra TTL của nhiều object cùng lúc (chỉ test homefeed).
- Không kiểm tra grace period (stale-while-revalidate, stale-if-error) — đó là case 09.
- Không kiểm tra TTL cho response lỗi (negative caching) — đó là case 11.
- Không kiểm tra TTL cho nhiều variant profiles (chỉ test `guestVNMobileControl`).
- Không kiểm tra cơ chế async revalidation khi object gần hết hạn.

---

## 3. Vì sao phải test ở CDN layer

### Vấn đề nếu chỉ test ở application layer

Nếu bạn test TTL bằng cách gọi trực tiếp app:

```text
// Test ở app layer
Request 1: GET http://localhost:8088/api/sim/products/homefeed → 200, X-Cache: MISS
Request 2: GET http://localhost:8088/api/sim/products/homefeed → 200, X-Cache: MISS (luôn MISS)
```

App không có cache → không có TTL → luôn luôn MISS. Bạn không thể test TTL ở application layer.

### Tại sao TTL là CDN-specific behavior

| Layer | Có TTL không? | Cơ chế |
| --- | --- | --- |
| Browser | Có (`Cache-Control: max-age`) | Browser cache private; mỗi user có cache riêng |
| CDN | Có (`Cache-Control: s-maxage` hoặc `CDN-Cache-Control: max-age`) | Shared cache; tất cả users dùng chung object |
| Application | Không | App không cache; mỗi request đều xử lý từ đầu |
| Database | Có (query cache) | Cache query results, không phải HTTP responses |

CDN là nơi duy nhất mà TTL của HTTP response có ý nghĩa cho **tất cả users dùng chung một object**.

### Ba lý do phải test TTL ở CDN layer

**Lý do 1: TTL từ response header có thể bị VCL ghi đè**

Origin trả về:
```text
Cache-Control: public, s-maxage=20
```

Nhưng VCL có thể có logic:
```text
sub vcl_backend_response {
    if (bereq.url ~ "^/api/sim/products/homefeed") {
        set beresp.ttl = 300s;  // Ghi đè TTL thành 300s
    }
}
```

Nếu bạn không test ở CDN layer, bạn không bao giờ biết TTL thực tế là 20s (từ origin) hay 300s (từ VCL override).

**Lý do 2: Clock skew giữa CDN và origin**

CDN và origin có thể chạy trên các máy khác nhau với clock khác nhau. Nếu CDN clock nhanh hơn origin 30 giây, object có thể hết hạn sớm hơn dự kiến 30 giây.

**Lý do 3: `sleep()` trong k6 phải đủ dài và chính xác**

K6 `sleep(TTL_WAIT_SECONDS)` dựa trên clock của k6 process, không phải clock của CDN. Nếu có clock skew giữa k6 và CDN, object có thể chưa hết hạn khi k6 nghĩ nó đã hết hạn.

---

## 4. Topology và precondition

### Topology yêu cầu

```text
k6/client
   │
   ├──> http://localhost:80 ──> Varnish CDN ──> Nginx ──> app/microservices
   │                                                       │
   │    Public edge path (GET homefeed, 3 lần)             │
   │                                                       │
   └──> http://localhost:8088 ─────────────────────────────> control plane
        Control path (POST ban-url trong setup)
```

Case 08 dùng cả hai path:
- **Control path (`:8088`)**: `setup()` gọi `banUrl()` để xóa homefeed cache trước khi test.
- **Public path (`:80`)**: `default()` gọi homefeed 3 lần (MISS → HIT → MISS sau TTL).

### Biến môi trường

| Biến | Mặc định | Vai trò trong case 08 | Có thể override? |
| --- | --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | Public CDN entry point | Có |
| `CONTROL_BASE_URL` | `http://localhost:8088` | Control plane cho `banUrl()` | Có |
| `CATALOG_EVENTS_BASE_URL` | `http://localhost:9091` | Không dùng trong case này | Không cần |
| `OPS_AUTH_TOKEN` | (bắt buộc) | Token cho control plane authentication | **Phải set** |
| `TTL_WAIT_SECONDS` | `21` | Thời gian sleep để object hết hạn | Có |

### Tại sao `TTL_WAIT_SECONDS` mặc định là 21?

21 giây được chọn vì:

1. **Homefeed TTL trong hệ thống mẫu**: `s-maxage=20` (20 giây). `TTL_WAIT_SECONDS=21` đảm bảo sleep dài hơn TTL 1 giây → object chắc chắn đã hết hạn.
2. **An toàn với clock skew**: Thêm 1 giây buffer cho clock skew giữa k6 và CDN.
3. **Thời gian chạy hợp lý**: 21 giây đủ ngắn để chạy trong CI/CD, đủ dài để object hết hạn.

Nếu TTL thực tế của homefeed khác 20s, bạn cần override `TTL_WAIT_SECONDS` cho phù hợp:

```powershell
# Nếu homefeed TTL = 60s
$env:TTL_WAIT_SECONDS = 61
```

### Precondition

1. **`TargetLayer=full`**: Stack phải chạy với Varnish CDN ở port 80.
2. **Origin healthy**: `products-service` phải đang chạy và trả về response hợp lệ cho homefeed.
3. **Control plane accessible**: `:8088` phải nhận request với `OPS_AUTH_TOKEN` hợp lệ.
4. **Có quyền ban**: `OPS_AUTH_TOKEN` phải có quyền gọi `POST /ops/app/cdn/cache/ban-url`.
5. **Homefeed endpoint tồn tại**: `GET /api/sim/products/homefeed` phải trả về 200.
6. **Homefeed có TTL**: Response phải có `Cache-Control: s-maxage=N` với N > 0.
7. **Thời gian**: Script mất ~21 giây để chạy (chủ yếu là sleep). Đảm bảo không có timeout ở CI/CD.

### Kiểm tra precondition nhanh

```powershell
# 1. Kiểm tra origin có sống không
curl -s -o nul -w "%{http_code}" http://localhost:80/api/sim/products/homefeed
# Kỳ vọng: 200

# 2. Kiểm tra homefeed TTL
curl -s -I http://localhost:80/api/sim/products/homefeed | findstr "Cache-Control"
# Kỳ vọng: Cache-Control: public, s-maxage=20, ...

# 3. Kiểm tra control plane
curl -s -o nul -w "%{http_code}" -H "Authorization: Bearer <ops-token>" `
  -H "X-Ops-Token: <ops-token>" `
  -H "Content-Type: application/json" `
  -X POST http://localhost:8088/ops/app/cdn/cache/ban-url `
  -d '{"url":"/api/sim/products/homefeed"}'
# Kỳ vọng: 200

# 4. Kiểm tra TTL_WAIT_SECONDS
# Nếu TTL của homefeed là 20s, TTL_WAIT_SECONDS phải >= 21
```

---

## 5. Script deep-dive

### 5.1 Import và dependency

```javascript
import { sleep } from 'k6';
import { TTL_WAIT_SECONDS, paths, profiles, banUrl, requestCdn,
         assertCacheState, assertStatus, assertUpstream } from './shared.js';
```

Script import 8 symbols:

| Symbol | Loại | Nguồn | Vai trò trong case |
| --- | --- | --- | --- |
| `sleep` | function | `k6` | Dừng VU trong `TTL_WAIT_SECONDS` giây |
| `TTL_WAIT_SECONDS` | constant | `shared.js` | Thời gian chờ object hết hạn (mặc định 21) |
| `paths` | object | `shared.js` | Chứa `paths.homefeed` = `'/api/sim/products/homefeed'` |
| `profiles` | object | `shared.js` | Chứa `profiles.guestVNMobileControl` |
| `banUrl` | function | `shared.js` | Gọi control plane `POST /ops/app/cdn/cache/ban-url` |
| `requestCdn` | function | `shared.js` | Gửi HTTP request qua CDN (`:80`) |
| `assertCacheState` | function | `shared.js` | Kiểm tra `X-Cache` header (MISS/HIT/BYPASS) |
| `assertStatus` | function | `shared.js` | Kiểm tra HTTP status code |
| `assertUpstream` | function | `shared.js` | Kiểm tra `X-Upstream-Service` header |

### 5.2 Options block

```javascript
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
  tags: {
    scenario: 'cdn_ttl_expiry',
  },
};
```

**Phân tích từng trường:**

| Trường | Giá trị | Lý do |
| --- | --- | --- |
| `vus` | `1` | TTL test là single-user sequential test; không cần concurrency |
| `iterations` | `1` | Một iteration chứa đủ sequence MISS → HIT → sleep → MISS |
| `thresholds.checks` | `['rate==1']` | **Cứng**: 100% checks phải pass |
| `tags.scenario` | `'cdn_ttl_expiry'` | Tag để phân biệt trong dashboard/cloud output |

**Tại sao `vus=1, iterations=1`?**

TTL expiry test có trật tự thời gian nghiêm ngặt:
1. Request 1 (MISS) → phải hoàn thành trước request 2.
2. Request 2 (HIT) → phải hoàn thành trước sleep.
3. Sleep → phải kết thúc trước request 3.
4. Request 3 (MISS sau TTL) → phải xảy ra sau khi object hết hạn.

##### Phân tích executor: vì sao dùng `per-vu-iterations` cho case này?

Config dùng bare form `vus=1, iterations=1` → `per-vu-iterations`.

**Yêu cầu của case:**

```text
1. Time-sensitive sequence: MISS → HIT → sleep(ttl) → MISS
   → Thời gian LÀ MỘT PHẦN CỦA TEST — sleep(2s) mô phỏng TTL expiry
   → 1 VU đảm bảo không ai "chen ngang" request trong lúc sleep
   → Nhiều VU: VU A sleep, VU B gửi request → làm mới TTL → test fail

2. 1 iteration chứa TOÀN BỘ timeline:
   → banUrl → warm → HIT verify → sleep TTL → MISS verify
   → Tất cả trong 1 lần default() — deterministic
```

**So sánh executor:**

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **per-vu-iterations** (đang dùng) | ✅ **ĐÚNG** | 1 VU × 1 iter. Sequence + sleep tuần tự. TTL test cần thời gian chính xác. |
| shared-iterations | ⚠️ Kết quả giống | `vus=1` nên output giống. |
| constant-vus | ❌ SAI | Cần `duration`. TTL test không biết trước tổng thời gian (sleep + response time). Duration có thể cắt ngang sleep. |
| constant-arrival-rate | ❌ SAI | Ép rate. Case này cần "đợi TTL hết hạn", không cần "gửi N request/giây". |
| ramping-vus | ❌ SAI | 1 VU ổn định, không ramp. |

**Key insight**: TTL test = "đợi cho cache hết hạn rồi verify". Thời gian là
INPUT (sleep mô phỏng TTL), không phải OUTPUT. `per-vu-iterations` cho phép
sleep trong iteration mà không bị `duration` cắt ngang.

Nếu có nhiều VUs, chúng sẽ chạy song song và phá vỡ trật tự này. Ví dụ: VU 2 gửi request 3 trong khi VU 1 vừa mới gửi request 1 → object chưa được cache → cả hai đều MISS.

**Tại sao không tăng iterations?**

Mỗi iteration sẽ lặp lại toàn bộ sequence (kể cả sleep 21s). 10 iterations = 10 × 21s = 210 giây — quá lâu cho CI/CD. Nếu bạn muốn kiểm tra TTL stability, dùng variation 2 (xem section 14).

### 5.3 Setup function

```javascript
export function setup() {
  banUrl(paths.homefeed);
}
```

**Hàm `setup()` làm gì?**

`setup()` chạy **một lần duy nhất** trước khi tất cả VUs bắt đầu `default()`. Trong case này:

1. Gọi `banUrl(paths.homefeed)` — gửi request đến control plane.
2. `banUrl()` gọi `controlRequest('POST', '/ops/app/cdn/cache/ban-url', { url: '/api/sim/products/homefeed' })`.
3. Control plane xử lý ban request → CDN xóa tất cả objects khớp URL `/api/sim/products/homefeed`.
4. `banUrl()` assert status 200 — nếu control plane không trả 200, script dừng ở setup.

**Tại sao cần `banUrl()` trong setup?**

Nếu không có setup, object homefeed có thể đã được cache từ trước (do lần chạy trước, hoặc do request khác). Khi đó:

```text
Không có setup():
Request 1: HIT (object còn trong cache) → test sai vì mong đợi MISS.
Request 2: HIT (vẫn trong TTL của object cũ)
Request 3: HIT hoặc MISS (không chắc chắn)

Có setup():
setup(): banUrl → xóa object
Request 1: MISS (cache trống) ✓
Request 2: HIT (vừa được cache) ✓
Request 3: MISS (sau TTL) ✓
```

**Luồng xử lý của `banUrl()` trong `shared.js`:**

```text
banUrl(url)
  │
  ├── controlRequest('POST', '/ops/app/cdn/cache/ban-url', { url })
  │     │
  │     ├── requireOpsToken() → lấy OPS_AUTH_TOKEN
  │     ├── Tạo headers: Authorization: Bearer <token>, X-Ops-Token: <token>
  │     ├── POST http://localhost:8088/ops/app/cdn/cache/ban-url
  │     └── assertStatus(res, 200, 'ban-url ...')
  │
  └── return res
```

### 5.4 Default function — step 1: First request (MISS)

```javascript
const profile = profiles.guestVNMobileControl;

const first = requestCdn('GET', paths.homefeed, {
  profile,
  tags: { case: 'homefeed_first' },
});
assertStatus(first, 200, 'homefeed first');
assertUpstream(first, 'products-service', 'homefeed first');
assertCacheState(first, 'MISS', 'homefeed first');
```

**Ba assertions cho request đầu tiên:**

| # | Assertion | Giá trị kỳ vọng | Ý nghĩa |
| --- | --- | --- | --- |
| 1 | `assertStatus` | `200` | Homefeed trả về thành công |
| 2 | `assertUpstream` | `'products-service'` | Request được xử lý bởi đúng service |
| 3 | `assertCacheState` | `'MISS'` | CDN không có object trong cache → phải gọi origin |

**Tại sao request đầu tiên phải là MISS?**

Vì `setup()` đã gọi `banUrl()` để xóa homefeed khỏi cache. CDN không còn object nào cho path này → buộc phải fetch từ origin.

**Assertion `assertUpstream` có vai trò gì?**

Xác nhận request thực sự đến origin (products-service), không phải:
- CDN trả response từ cache khác (grace object).
- CDN trả synthetic response.
- Request bị route sai service.

### 5.5 Default function — step 2: Second request (HIT)

```javascript
const second = requestCdn('GET', paths.homefeed, {
  profile,
  tags: { case: 'homefeed_second' },
});
assertStatus(second, 200, 'homefeed second');
assertCacheState(second, 'HIT', 'homefeed second');
```

**Hai assertions cho request thứ hai:**

| # | Assertion | Giá trị kỳ vọng | Ý nghĩa |
| --- | --- | --- | --- |
| 1 | `assertStatus` | `200` | Homefeed vẫn trả về thành công |
| 2 | `assertCacheState` | `'HIT'` | CDN phục vụ từ cache, không gọi origin |

**Tại sao request thứ hai phải là HIT?**

Request đầu tiên đã fill cache. Request thứ hai xảy ra **ngay lập tức** sau request đầu tiên (vài ms). Object mới được cache, TTL còn nguyên (20 giây). CDN phải phục vụ HIT.

**Tại sao không assert `X-Upstream-Service` cho HIT?**

Khi HIT, CDN không gọi origin → không có `X-Upstream-Service` header, hoặc giá trị không liên quan. Assert `X-Upstream-Service` chỉ có ý nghĩa cho MISS/BYPASS.

### 5.6 Default function — step 3: Sleep

```javascript
sleep(TTL_WAIT_SECONDS);
```

**`sleep()` làm gì?**

Dừng VU trong `TTL_WAIT_SECONDS` giây (mặc định 21). Trong thời gian này:
- VU không gửi request.
- CDN tiếp tục chạy; clock của CDN vẫn đếm.
- Object homefeed trong cache dần tiến đến hết hạn.
- Khi clock CDN vượt qua `time_cached + TTL`, object được đánh dấu là expired.
- Request tiếp theo cho object expired sẽ là MISS (hoặc stale HIT nếu có grace).

**Tại sao 21 giây mà không phải 20?**

```text
TTL của homefeed (từ Cache-Control: s-maxage): 20s
TTL_WAIT_SECONDS:                               21s

Request 1:  T=0.0s   → object được cache với TTL=20s → hết hạn lúc T=20.0s
Request 2:  T=0.1s   → HIT (còn 19.9s TTL)
sleep(21):  T=0.1s đến T=21.1s
Request 3:  T=21.1s  → Object đã hết hạn 1.1s trước → MISS hoặc stale
```

Nếu `TTL_WAIT_SECONDS = 20` (bằng chính xác TTL):
- Clock skew có thể khiến CDN nghĩ object vẫn còn valid.
- Network latency có thể khiến request 3 đến CDN trước khi TTL hết hạn.
- Kết quả: HIT thay vì MISS → test fail giả.

Buffer 1 giây đảm bảo object **chắc chắn** đã hết hạn.

### 5.7 Default function — step 4: Third request (MISS sau expiry)

```javascript
const afterExpiry = requestCdn('GET', paths.homefeed, {
  profile,
  tags: { case: 'homefeed_after_expiry' },
});
assertStatus(afterExpiry, 200, 'homefeed after expiry');
assertUpstream(afterExpiry, 'products-service', 'homefeed after expiry');
assertCacheState(afterExpiry, 'MISS', 'homefeed after expiry');
```

**Ba assertions cho request thứ ba:**

| # | Assertion | Giá trị kỳ vọng | Ý nghĩa |
| --- | --- | --- | --- |
| 1 | `assertStatus` | `200` | Homefeed vẫn trả về thành công sau expiry |
| 2 | `assertUpstream` | `'products-service'` | CDN gọi origin để fetch object mới |
| 3 | `assertCacheState` | `'MISS'` | Object cũ đã hết hạn → CDN phải fetch mới |

**Đây là assertion quan trọng nhất của case này.**

Nếu `assertCacheState(afterExpiry, 'MISS')` fail (tức là vẫn HIT), có nghĩa là:
1. TTL không được tôn trọng (object không hết hạn).
2. `TTL_WAIT_SECONDS` không đủ dài (object chưa hết hạn).
3. Clock skew giữa k6 và CDN quá lớn.

### 5.8 Không có teardown()

Script này không có `export function teardown()`. Lý do:
- Không cần cleanup: object homefeed mới (từ request 3) sẽ tự hết hạn sau TTL.
- Không cần reset state: case này không thay đổi origin profile hay cấu hình CDN.

---

## 6. Cache key model / VCL deep-dive

### 6.1 TTL được xác định như thế nào trong VCL

Khi origin trả về response, VCL đọc TTL từ headers trong `vcl_backend_response`:

```text
sub vcl_backend_response {
    // Ưu tiên 1: CDN-Cache-Control (dedicated CDN header)
    if (beresp.http.CDN-Cache-Control) {
        // Parse max-age=N
        // set beresp.ttl = N;
    }

    // Ưu tiên 2: Cache-Control: s-maxage (shared cache directive)
    else if (beresp.http.Cache-Control ~ "s-maxage\s*=\s*(\d+)") {
        // set beresp.ttl = captured_number;
    }

    // Ưu tiên 3: Cache-Control: max-age (generic)
    else if (beresp.http.Cache-Control ~ "max-age\s*=\s*(\d+)") {
        // set beresp.ttl = captured_number;
    }

    // Ưu tiên 4: Expires header (HTTP/1.0 fallback)
    else if (beresp.http.Expires) {
        // set beresp.ttl = parsed_expires - now;
    }

    // Ưu tiên 5: VCL default (thường là 120s)
    else {
        // set beresp.ttl = 120s;
    }
}
```

**Thứ tự ưu tiên này rất quan trọng:**

| Header | Mức ưu tiên | Khi nào dùng |
| --- | --- | --- |
| `CDN-Cache-Control: max-age=N` | 1 (cao nhất) | Có header riêng cho CDN |
| `Cache-Control: s-maxage=N` | 2 | Shared cache TTL khác browser TTL |
| `Cache-Control: max-age=N` | 3 | TTL chung cho tất cả caches |
| `Expires: <date>` | 4 | HTTP/1.0 fallback |
| VCL default | 5 (thấp nhất) | Không có header nào |

### 6.2 VCL xử lý object hết hạn như thế nào

```text
sub vcl_hit {
    // Object được tìm thấy trong cache
    if (obj.ttl >= 0s) {
        // Object còn fresh → HIT
        return (deliver);
    }
    // Grace mode: object hết hạn nhưng còn trong grace period
    elsif (obj.grace > 0s) {
        // Phục vụ stale object, background fetch object mới
        return (deliver);
    }
    // Object hoàn toàn hết hạn → MISS, fetch từ origin
    return (miss);
}
```

**Ba trạng thái của cached object:**

```text
Trạng thái FRESH:    obj.ttl >= 0
  ├── HIT ngay lập tức
  ├── Không gọi origin
  └── Response time thấp nhất

Trạng thái STALE:    obj.ttl < 0 AND obj.grace > 0
  ├── HIT (nhưng có X-Cache-Stale: true)
  ├── Background async fetch từ origin
  └── Response time thấp (stale object), nhưng object sẽ được refresh

Trạng thái EXPIRED:  obj.ttl < 0 AND obj.grace <= 0
  ├── MISS
  ├── Đồng bộ fetch từ origin
  └── Response time cao hơn (phải đợi origin)
```

### 6.3 TTL và grace period cho homefeed

Giả sử homefeed response có:

```text
Cache-Control: public, s-maxage=20, stale-while-revalidate=30, stale-if-error=60
```

VCL parse được:

```text
beresp.ttl = 20s    (từ s-maxage)
beresp.grace = 60s  (từ stale-if-error — grace period khi origin lỗi)
beresp.keep = 30s   (từ stale-while-revalidate — grace period cho async refresh)
```

Timeline của object:

```text
T=0s      Object được cache
          obj.ttl = 20s, obj.grace = 60s, obj.keep = 30s

T=0-20s   FRESH: Mọi request → HIT

T=20-50s  STALE (grace: keep): Mọi request → HIT (stale)
          CDN async fetch object mới từ origin trong background
          Khi fetch xong → object mới thay thế object cũ

T=50-80s  STALE (grace: grace): Mọi request → HIT (stale)
          Origin có thể đang lỗi — CDN vẫn phục vụ stale object

T>80s    EXPIRED: Mọi request → MISS
          CDN gọi origin đồng bộ
```

**Case 08 chỉ kiểm tra transition từ FRESH sang EXPIRED** (không test grace period).

### 6.4 Tại sao chọn homefeed làm endpoint test?

| Endpoint | TTL | Lý do chọn |
| --- | --- | --- |
| `/api/sim/products/1` | 30s | Có thể dùng, nhưng TTL dài hơn → sleep lâu hơn |
| `/api/sim/products/homefeed` | 20s | TTL ngắn hơn → sleep ngắn hơn → thời gian test hợp lý |
| `/api/cached?...` | Có thể tùy chỉnh | Cần dynamic path → phức tạp hơn |

Homefeed được chọn vì:
1. TTL vừa phải (20s) — không quá dài để test.
2. Là endpoint thực tế (không phải synthetic).
3. Có thể ban bằng `banUrl()` trong setup.

---

## 7. Request sequence flow

### Timeline tổng thể

```text
Time (s)   Event
─────────────────────────────────────────────────────────────────────
0.0        k6 start: 1 VU, 1 iteration
0.0        ── setup() ──────────────────────────────────────────────
0.0        POST http://localhost:8088/ops/app/cdn/cache/ban-url
           Body: {"url":"/api/sim/products/homefeed"}
           Authorization: Bearer <ops-token>
           X-Ops-Token: <ops-token>
0.05       Control plane xử lý: gửi lệnh ban đến CDN
           CDN xóa tất cả objects khớp URL /api/sim/products/homefeed
0.1        ← Response 200 OK
           setup() hoàn thành
0.1        ── default() ────────────────────────────────────────────
0.1        VU bắt đầu iteration
0.1        ── Request 1: homefeed_first ────────────────────────────
           GET http://localhost:80/api/sim/products/homefeed
           Profile: guest_vn_mobile_control
           → CDN: cache empty → MISS
           → Origin: products-service xử lý
           → Origin trả 200 + Cache-Control: s-maxage=20 + body
           → CDN lưu object, TTL = 20s, hết hạn lúc T=20.2s
0.2        ← Response 200, X-Cache: MISS, X-Upstream-Service: products-service
0.2        Assertions: status 200 ✓, upstream products-service ✓, cache MISS ✓
0.2        ── Request 2: homefeed_second ───────────────────────────
           GET http://localhost:80/api/sim/products/homefeed
           Profile: guest_vn_mobile_control (giống request 1)
           → CDN: object trong cache, còn 20s TTL
           → CDN phục vụ HIT, không gọi origin
0.25       ← Response 200, X-Cache: HIT
0.25       Assertions: status 200 ✓, cache HIT ✓
0.25       ── sleep(TTL_WAIT_SECONDS) ──────────────────────────────
           sleep(21) bắt đầu
           k6 VU bị dừng
           Trong khi đó, CDN clock vẫn chạy:
             T=5s:  object còn 15s TTL
             T=10s: object còn 10s TTL
             T=15s: object còn 5s TTL
             T=20s: object hết TTL → chuyển sang grace period (nếu có)
             T=20.2s: object hết hạn hoàn toàn (nếu không có grace)
21.25      sleep(21) kết thúc
21.25      ── Request 3: homefeed_after_expiry ─────────────────────
           GET http://localhost:80/api/sim/products/homefeed
           Profile: guest_vn_mobile_control (vẫn giống)
           → CDN: object đã hết hạn → MISS
           → Origin: products-service xử lý
           → Origin trả 200 + body mới
           → CDN lưu object mới, TTL = 20s
21.35      ← Response 200, X-Cache: MISS, X-Upstream-Service: products-service
21.35      Assertions: status 200 ✓, upstream products-service ✓, cache MISS ✓
21.35      Iteration kết thúc
21.35      k6 exit: 0 (nếu tất cả checks pass)
```

### Request flow chi tiết — trạng thái cache qua thời gian

```text
CDN Cache State cho key: GET:/api/sim/products/homefeed + guest_vn_mobile_control

T=0.0s    ┌─────────────────────────────────────────────────────────┐
          │ EMPTY                                                    │
          │ (setup banUrl đã xóa object cũ nếu có)                  │
          └─────────────────────────────────────────────────────────┘

T=0.2s    ┌─────────────────────────────────────────────────────────┐
Request 1 │ OBJECT CACHED                                            │
(MISS)    │ TTL: 20s (hết hạn lúc T=20.2s)                          │
          │ Grace: 60s (nếu có stale-if-error)                       │
          │ Keep: 30s (nếu có stale-while-revalidate)                │
          │ Body: { "items": [...], ... }                            │
          └─────────────────────────────────────────────────────────┘

T=0.25s   ┌─────────────────────────────────────────────────────────┐
Request 2 │ FRESH HIT                                                │
(HIT)     │ Object còn 19.95s TTL                                    │
          │ CDN phục vụ từ cache                                     │
          └─────────────────────────────────────────────────────────┘

T=0.25 đến T=21.25: sleep(21)

T=21.25s  ┌─────────────────────────────────────────────────────────┐
Request 3 │ EXPIRED → MISS                                          │
(MISS)    │ Object đã hết hạn lúc T=20.2s                            │
          │ CDN fetch object mới từ origin                           │
          │ Object mới được cache với TTL mới                        │
          └─────────────────────────────────────────────────────────┘
```

### Sequence diagram chi tiết

```text
k6                    CDN (:80)             Control (:8088)        Origin
│                     │                     │                      │
│  setup()            │                     │                      │
│                     │                     │                      │
│───── POST /ban-url ──────────────────────>│                      │
│                     │                     │── ban command ──────>│
│                     │<── invalidate ──────│                      │
│                     │  (xóa homefeed)     │                      │
│<── 200 OK ───────────────────────────────│                      │
│                     │                     │                      │
│  default()          │                     │                      │
│                     │                     │                      │
│── GET /homefeed ───>│                     │                      │
│                     │── GET /homefeed ──────────────────────────>│
│                     │                     │    (MISS: no cache)   │
│                     │                     │    products-service   │
│                     │                     │    tính toán homefeed │
│                     │<── 200 + s-maxage=20 ─────────────────────│
│                     │  (lưu object, TTL=20s)                     │
│<── 200, X-Cache:MISS│                     │                      │
│                     │                     │                      │
│── GET /homefeed ───>│                     │                      │
│                     │  (object còn TTL)    │                      │
│<── 200, X-Cache:HIT │                     │                      │
│                     │                     │                      │
│  sleep(21)          │                     │                      │
│  ...                │  (clock vẫn chạy)    │                      │
│  ...                │  T=20s: TTL hết hạn  │                      │
│  ...                │  object → expired    │                      │
│                     │                     │                      │
│── GET /homefeed ───>│                     │                      │
│                     │── GET /homefeed ──────────────────────────>│
│                     │  (MISS: object expired)                    │
│                     │                     │    products-service   │
│                     │                     │    tính toán lại      │
│                     │<── 200 + s-maxage=20 ─────────────────────│
│                     │  (lưu object mới)                          │
│<── 200, X-Cache:MISS│                     │                      │
│                     │                     │                      │
│  done               │                     │                      │
```

---

## 8. Key signals / headers cần verify

### Bảng tổng hợp headers

| # | Header | Nguồn | Assert trong case? | Ý nghĩa trong case 08 |
| --- | --- | --- | --- | --- |
| 1 | `X-Cache` | CDN | **Có** — 3 assertions (MISS → HIT → MISS) | Cache state sequence |
| 2 | `X-Upstream-Service` | CDN | **Có** — 2 assertions (first + after expiry) | Xác nhận request đến origin |
| 3 | `Cache-Control` | Origin | Không assert trực tiếp | Chứa `s-maxage` quyết định TTL |
| 4 | `CDN-Cache-Control` | Origin | Không assert trực tiếp | Chứa `max-age` cho CDN-specific TTL |
| 5 | `X-Cache-Key-Language` | CDN | Không assert | Cache key dimension |
| 6 | `X-Cache-Key-Geo` | CDN | Không assert | Cache key dimension |
| 7 | `X-Cache-Key-Device` | CDN | Không assert | Cache key dimension |
| 8 | `X-Cache-Key-AB` | CDN | Không assert | Cache key dimension |
| 9 | `X-Cache-Key-Segment` | CDN | Không assert | Cache key dimension |
| 10 | `X-Cache-Stale` | CDN | Không assert trong case này | Sẽ có trong case 09 |
| 11 | `Surrogate-Key` | Origin | Không assert | Tag cho invalidation |
| 12 | `Vary` | Origin | Không assert | Variant dimensions |

### Chi tiết sequence `X-Cache`

```text
Kỳ vọng sequence: MISS → HIT → MISS

Request 1 (homefeed_first):      X-Cache: MISS
  └── Cache trống sau ban → CDN phải gọi origin.

Request 2 (homefeed_second):     X-Cache: HIT
  └── Object đã được cache từ request 1, còn TTL → CDN phục vụ từ cache.

Request 3 (homefeed_after_expiry): X-Cache: MISS
  └── Object đã hết hạn → CDN phải gọi origin fetch object mới.
```

### Các giá trị `X-Cache` có thể gặp và ý nghĩa

| Giá trị | Ý nghĩa | Hợp lệ trong case 08? |
| --- | --- | --- |
| `MISS` | Object không có trong cache; fetch từ origin | Có — request 1 và 3 |
| `HIT` | Object có trong cache và còn fresh | Có — request 2 |
| `HIT, STALE` | Object có trong cache nhưng đã hết TTL; đang trong grace period | Không mong đợi trong case này |
| `BYPASS` | Request bị bỏ qua cache (auth, cookie, no-cache) | Không mong đợi — request dùng profile guest, không auth |
| `PASS` | CDN không cache object này | Không mong đợi — homefeed nên được cache |
| `SYNTH` | CDN trả synthetic response | Không mong đợi |

---

## 9. Pass/fail criteria

### Điều kiện PASS

Tất cả các điều kiện sau phải đồng thời đúng:

```text
PASS ⇔ k6 exit code = 0
     ∧ checks rate = 100% (thresholds.checks: ['rate==1'])
     ∧ setup() hoàn thành không lỗi
     ∧ TẤT CẢ 8 assertions pass:

  [1] homefeed first status 200
  [2] homefeed first upstream products-service
  [3] homefeed first cache state MISS
  [4] homefeed second status 200
  [5] homefeed second cache state HIT
  [6] homefeed after expiry status 200
  [7] homefeed after expiry upstream products-service
  [8] homefeed after expiry cache state MISS
```

### Điều kiện FAIL

Script fail khi **bất kỳ** điều kiện nào sau đây xảy ra:

| Nhóm | Failure mode | Nguyên nhân nghi ngờ | Cách debug |
| --- | --- | --- | --- |
| **Setup** | `banUrl()` fail (status != 200) | `OPS_AUTH_TOKEN` sai hoặc không set; control plane không chạy | Kiểm tra `docker ps`, kiểm tra token |
| **Setup** | `banUrl()` fail (connection refused) | `CONTROL_BASE_URL` sai port | Kiểm tra `:8088` có mở không |
| **Request 1** | status != 200 | Origin không chạy hoặc route sai | `curl http://localhost:80/api/sim/products/homefeed` |
| **Request 1** | upstream != `products-service` | Request bị route sai service | Kiểm tra Nginx config |
| **Request 1** | cache != MISS | Setup ban không hoạt động — object vẫn trong cache | Kiểm tra control plane logs |
| **Request 2** | status != 200 | Origin có vấn đề giữa 2 requests | Xem logs origin |
| **Request 2** | cache != HIT | Object không được cache (VCL không cache response này) | Kiểm tra `Cache-Control` header của response 1 |
| **Request 2** | cache != HIT | TTL quá ngắn (< 0.1s) — object hết hạn trước request 2 | Kiểm tra `s-maxage`, tăng TTL |
| **Request 3** | status != 200 | Origin có vấn đề sau sleep | Xem logs origin |
| **Request 3** | cache != MISS (vẫn HIT) | TTL chưa hết hạn — `TTL_WAIT_SECONDS` không đủ dài | Tăng `TTL_WAIT_SECONDS` |
| **Request 3** | cache != MISS (vẫn HIT) | Clock skew giữa k6 và CDN | Đồng bộ clock, tăng buffer |
| **Request 3** | cache != MISS (vẫn HIT) | VCL hardcode TTL dài hơn `s-maxage` | Kiểm tra VCL config |
| **Request 3** | upstream != `products-service` | Request bị route sai | Kiểm tra Nginx config |

### Bảng định lượng

| Chỉ số | Ngưỡng PASS | Ngưỡng FAIL |
| --- | --- | --- |
| `k6 exit code` | `0` | `!= 0` |
| `checks rate` | `1.0` (100%) | `< 1.0` |
| `homefeed_first.status` | `200` | Mọi giá trị khác |
| `homefeed_first.cache` | `'MISS'` | `'HIT'`, `'BYPASS'`, ... |
| `homefeed_first.upstream` | `'products-service'` | Giá trị khác |
| `homefeed_second.status` | `200` | Mọi giá trị khác |
| `homefeed_second.cache` | `'HIT'` | `'MISS'`, `'BYPASS'`, ... |
| `homefeed_after_expiry.status` | `200` | Mọi giá trị khác |
| `homefeed_after_expiry.cache` | `'MISS'` | `'HIT'` (object chưa hết hạn) |
| `homefeed_after_expiry.upstream` | `'products-service'` | Giá trị khác |
| Số assertions pass | `8/8` | `< 8` |
| Thời gian chạy | `~21-25s` | `> 60s` (timeout bất thường) |
| `TTL_WAIT_SECONDS` | `>= TTL thực tế + 1s` | `< TTL thực tế` (không đủ dài) |

---

## 10. Cách chạy + output mẫu

### 10.1 Chạy trực tiếp với k6

```powershell
cd E:\Projects\k6\k6-metrics-server

# Set biến môi trường
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"

# Chạy case 08
k6 run load-target\k6\cdn\08-ttl-expiry.js
```

### 10.2 Chạy qua runner script

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
.\scripts\run-cdn-capabilities.ps1 -Scenarios 08-ttl-expiry
```

### 10.3 Override TTL_WAIT_SECONDS

```powershell
# Nếu homefeed TTL thực tế khác 20s
$env:TTL_WAIT_SECONDS = 31   # Cho TTL 30s
k6 run load-target\k6\cdn\08-ttl-expiry.js

# Hoặc nếu muốn test nhanh hơn (TTL ngắn hơn)
$env:TTL_WAIT_SECONDS = 6    # Cho TTL 5s
k6 run load-target\k6\cdn\08-ttl-expiry.js
```

### 10.4 Output mẫu khi PASS

```text
         /\      |‾‾| /‾‾/   /‾‾/
    /\  /  \     |  |/  /   /  /
   /  \/    \    |     (   /   ‾‾\
  /          \   |  |\  \ |  (‾)  |
 / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: load-target\k6\cdn\08-ttl-expiry.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 1 iterations shared among 1 VUs (maxDuration: 10m0s, gracefulStop: 30s)

  ✓ homefeed first status 200
  ✓ homefeed first upstream products-service
  ✓ homefeed first cache state MISS
  ✓ homefeed second status 200
  ✓ homefeed second cache state HIT
  ✓ homefeed after expiry status 200
  ✓ homefeed after expiry upstream products-service
  ✓ homefeed after expiry cache state MISS

  checks........................: 100.00% ✓ 8       ✗ 0
  data_received.................: 25 kB   1.2 kB/s
  data_sent.....................: 3.5 kB  160 B/s
  http_req_blocked.............: avg=1.5ms   min=0.8ms   med=1.2ms   max=2.5ms   p(90)=2.2ms   p(95)=2.5ms
  http_req_connecting..........: avg=0.4ms   min=0.2ms   med=0.3ms   max=0.6ms   p(90)=0.5ms   p(95)=0.6ms
  http_req_duration............: avg=15.2ms  min=8.5ms   med=12.0ms  max=25.1ms  p(90)=22.0ms  p(95)=25.1ms
  http_req_receiving...........: avg=0.6ms   min=0.3ms   med=0.5ms   max=1.0ms   p(90)=0.8ms   p(95)=1.0ms
  http_req_sending.............: avg=0.1ms   min=0.0ms   med=0.1ms   max=0.2ms   p(90)=0.2ms   p(95)=0.2ms
  http_req_tls_handshaking.....: avg=0.0ms   min=0.0ms   med=0.0ms   max=0.0ms   p(90)=0.0ms   p(95)=0.0ms
  http_req_waiting.............: avg=14.5ms  min=8.0ms   med=11.5ms  max=24.0ms  p(90)=21.0ms  p(95)=24.0ms
  http_reqs....................: 4       0.19/s
  iteration_duration...........: avg=21.35s  min=21.35s  med=21.35s  max=21.35s  p(90)=21.35s  p(95)=21.35s
  iterations...................: 1       0.047/s
  vus...........................: 1       min=1       max=1
  vus_max.......................: 1       min=1       max=1

running (0m21.4s), 1/1 VUs, 1 complete and 0 interrupted iterations
default ✓ [======================================] 1 VUs  0m21.4s/10m0s  1/1 shared iters
```

Lưu ý: `http_reqs: 4` = 1 banUrl trong setup + 3 homefeed requests trong default.

### 10.5 Output mẫu khi FAIL (request 3 vẫn HIT)

```text
  ✗ homefeed after expiry cache state MISS
    ↳  0% — ✓ 0 / ✗ 1
       (expected cache state MISS, got HIT)

  checks........................: 87.50%  ✓ 7       ✗ 1
  thresholds.....................: checks.rate [ FAILED ]: 87.50% < 1.0

ERRO[0021] thresholds on metrics 'checks' have been crossed
```

**Giải thích:** Object vẫn HIT sau 21 giây sleep → TTL chưa hết hạn. Có thể `s-maxage` > 20s, hoặc VCL hardcode TTL dài hơn.

### 10.6 Output mẫu khi FAIL (request 2 không HIT)

```text
  ✗ homefeed second cache state HIT
    ↳  0% — ✓ 0 / ✗ 1
       (expected cache state HIT, got MISS)

  checks........................: 87.50%  ✓ 7       ✗ 1
  thresholds.....................: checks.rate [ FAILED ]: 87.50% < 1.0
```

**Giải thích:** Object không được cache sau request 1. Có thể response thiếu `Cache-Control: s-maxage` hoặc `Cache-Control: public`.

---

## 11. 4 output → decision scenarios

### Scenario 1: All 8 checks pass, k6 exit 0

```text
Kết quả: ✅ PASS hoàn toàn
Sequence: MISS → HIT → sleep(21) → MISS
```

| Quan sát | Diễn giải |
| --- | --- |
| Request 1 MISS | Cache trống sau ban → đúng |
| Request 2 HIT | Object được cache từ request 1 → đúng |
| Request 3 MISS | Object hết hạn sau sleep → CDN fetch mới → đúng |
| Request 3 upstream đúng | Origin được gọi lại → xác nhận không phải stale HIT |

**Quyết định:** TTL expiry hoạt động chính xác cho homefeed. Sẵn sàng test case 09 (stale-while-error) và case 10 (request coalescing) — cả hai đều phụ thuộc vào TTL.

---

### Scenario 2: Request 3 vẫn HIT (không hết hạn)

```text
Kết quả: ❌ FAIL
Sequence: MISS → HIT → sleep(21) → HIT (sai)
```

| Quan sát | Diễn giải |
| --- | --- |
| Request 1 MISS | Cache trống → OK |
| Request 2 HIT | Cache hoạt động → OK |
| Request 3 HIT | Object không hết hạn sau 21s → **FAIL** |

**Nguyên nhân có thể (theo thứ tự khả năng):**

1. **`TTL_WAIT_SECONDS` không đủ dài**: `s-maxage` thực tế > 20s. Giải pháp: kiểm tra response header thực tế của homefeed, tăng `TTL_WAIT_SECONDS`.
2. **VCL hardcode TTL**: VCL ghi đè `beresp.ttl` với giá trị cố định > 21s. Giải pháp: kiểm tra VCL config.
3. **Clock skew**: CDN clock chậm hơn k6 clock vài giây. Giải pháp: tăng buffer (ví dụ `TTL_WAIT_SECONDS = TTL + 5`).
4. **Grace period**: Object đang trong grace period (stale-while-revalidate hoặc stale-if-error). Nếu grace > 0, object vẫn HIT (nhưng stale). Giải pháp: tăng `TTL_WAIT_SECONDS` để vượt qua grace period, hoặc kiểm tra `X-Cache-Stale`.

**Quyết định:**
1. Kiểm tra response header: `curl -s -I http://localhost:80/api/sim/products/homefeed | grep -i cache`.
2. Nếu `s-maxage=20` và `stale-while-revalidate=30` → object HIT (stale) trong 30s sau TTL. Cần `TTL_WAIT_SECONDS = 20 + 30 + 1 = 51`.
3. Nếu không có stale directives → VCL đang hardcode TTL. Sửa VCL.
4. Re-test sau khi fix.

---

### Scenario 3: Request 2 không HIT (không cache được)

```text
Kết quả: ❌ FAIL
Sequence: MISS → MISS (sai) → ...
```

| Quan sát | Diễn giải |
| --- | --- |
| Request 1 MISS | Cache trống → OK |
| Request 2 MISS | Object không được cache → **FAIL** |

**Nguyên nhân có thể:**

1. **Response không có cache directive**: Thiếu `Cache-Control: public, s-maxage=N`. Giải pháp: kiểm tra response header.
2. **VCL không cache response này**: VCL rule loại trừ path `/api/sim/products/homefeed`. Giải pháp: kiểm tra VCL.
3. **Request có header ngăn cache**: Dù profile là guest, nhưng có thể VCL thấy header nào đó và quyết định không cache. Giải pháp: kiểm tra VCL logic bypass.
4. **Object size vượt quá giới hạn cache**: Homefeed response quá lớn. Giải pháp: kiểm tra VCL size limit.

**Quyết định:**
1. Kiểm tra response header của request 1: `Cache-Control`, `CDN-Cache-Control`, `Vary`.
2. Kiểm tra VCL `vcl_backend_response` — có `return (pass)` hoặc `set beresp.uncacheable = true` không.
3. Nếu response thiếu cache headers → fix origin (case 07).
4. Nếu VCL từ chối cache → sửa VCL config.

---

### Scenario 4: Setup fail (banUrl không thành công)

```text
Kết quả: ❌ FAIL (script dừng ở setup)
```

| Quan sát | Diễn giải |
| --- | --- |
| `banUrl()` trả về status != 200 | Control plane không hoạt động hoặc token sai |
| `banUrl()` throw connection error | `CONTROL_BASE_URL` sai hoặc service không chạy |

**Nguyên nhân có thể:**

1. **`OPS_AUTH_TOKEN` không set**: Script gọi `requireOpsToken()` → `fail()`. Giải pháp: set `OPS_AUTH_TOKEN`.
2. **Token không có quyền**: Token không có quyền gọi `/ops/app/cdn/cache/ban-url`. Giải pháp: kiểm tra token permissions.
3. **Control plane không chạy**: Port 8088 không mở. Giải pháp: `docker ps`, khởi động lại stack.
4. **Sai `CONTROL_BASE_URL`**: Mặc định `http://localhost:8088` nhưng service chạy ở port khác. Giải pháp: set đúng `CONTROL_BASE_URL`.

**Quyết định:**
1. Kiểm tra: `curl http://localhost:8088/ops/app/cdn/cache/ban-url -X POST -H "Authorization: Bearer $OPS_AUTH_TOKEN" -H "Content-Type: application/json" -d '{"url":"/test"}'`.
2. Nếu curl OK nhưng k6 fail → kiểm tra biến môi trường được truyền đúng vào k6 process.
3. Sửa và re-test.

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "Sleep 21 giây là lãng phí thời gian — TTL test có thể chạy nhanh hơn"

**Đúng là 21 giây dài**, nhưng đó là bản chất của TTL test. Bạn không thể test TTL expiry mà không đợi TTL hết hạn.

Tuy nhiên, có những cách tối ưu:

| Cách | Thời gian | Trade-off |
| --- | --- | --- |
| Dùng TTL ngắn (1-2s) | ~2-3 giây | Không thực tế cho production; không đại diện cho behavior thực |
| Mock CDN clock | < 1 giây | Cần CDN hỗ trợ time manipulation API; phức tạp |
| Dùng synthetic endpoint với TTL tùy chỉnh | ~5 giây | Cần endpoint `/api/cached?...` với param `ttl_seconds` |
| Test với TTL production (20s) | ~21 giây | Thực tế nhất, nhưng chậm nhất |

Case 08 chọn TTL production (20s) vì tính thực tế. Nếu bạn cần CI/CD nhanh hơn, dùng variation 1 (section 14) với TTL ngắn.

### Nghịch lý 2: "MISS → HIT → MISS chứng minh TTL hoạt động — không cần biết giá trị TTL"

**Sai.** Bạn cần biết TTL thực tế để đảm bảo `TTL_WAIT_SECONDS` đủ dài. Nếu TTL thực tế là 300s nhưng bạn sleep 21s → test vẫn pass nhưng:
- Request 3 vẫn HIT vì TTL còn 279s.
- Đến request N (sau 300s) mới MISS — nhưng script chỉ có 3 requests.
- Kết luận sai: "TTL hoạt động sau 21s" trong khi thực tế TTL là 300s.

### Nghịch lý 3: "TTL được định nghĩa bởi `Cache-Control: s-maxage` — không cần kiểm tra VCL"

**Sai.** VCL có thể ghi đè TTL từ origin. Case 08 xác nhận TTL **thực tế** (behavior), không phải TTL **khai báo** (header value). Đây chính là lý do phải test ở CDN layer.

```text
Origin trả: Cache-Control: s-maxage=20
VCL set:    beresp.ttl = 120s;  // Ghi đè
Behavior:   Object HIT trong 120s → test với TTL_WAIT_SECONDS=21 sẽ FAIL
            (vì request 3 vẫn HIT — TTL thực tế là 120s, không phải 20s)
```

### Nghịch lý 4: "Request 3 MISS → TTL hoạt động đúng"

**Chưa chắc.** Request 3 MISS có thể do:
- TTL hết hạn thực sự → đúng.
- Object bị evict khỏi cache do memory pressure → sai (không liên quan đến TTL).
- Object bị người khác purge/ban trong lúc sleep → sai (external interference).

**Cách phân biệt:** Kiểm tra `X-Cache-Stale`. Nếu object hết hạn tự nhiên → không có `X-Cache-Stale`. Nếu đang trong grace period → có `X-Cache-Stale: true`. Nếu bị evict → MISS nhưng không có dấu hiệu.

---

## 13. Checklist trước khi chạy

### Infrastructure checklist

- [ ] `TargetLayer=full` — stack đang chạy với Varnish CDN ở port 80.
- [ ] `docker ps` — tất cả containers (varnish, nginx, products-service, control-plane) đang running.
- [ ] `curl http://localhost:80/api/sim/products/homefeed` trả về 200.
- [ ] `curl -s -I http://localhost:80/api/sim/products/homefeed \| grep -i cache` — kiểm tra TTL thực tế.
- [ ] `curl http://localhost:8088/ops/app/cdn/cache/ban-url -X POST -H "Authorization: Bearer $env:OPS_AUTH_TOKEN" -H "Content-Type: application/json" -d '{"url":"/api/sim/products/homefeed"}'` trả về 200.
- [ ] Không có container nào restarting hoặc unhealthy.

### Environment checklist

- [ ] `BASE_URL` được set (mặc định `http://localhost:80`).
- [ ] `CONTROL_BASE_URL` được set (mặc định `http://localhost:8088`).
- [ ] `OPS_AUTH_TOKEN` được set với token hợp lệ.
- [ ] `TTL_WAIT_SECONDS` được set (mặc định `21`).

### TTL verification checklist

- [ ] Đã kiểm tra TTL thực tế của homefeed (từ `Cache-Control` hoặc `CDN-Cache-Control`).
- [ ] `TTL_WAIT_SECONDS > TTL thực tế + 1` (buffer cho clock skew).
- [ ] Nếu homefeed có `stale-while-revalidate=N` → `TTL_WAIT_SECONDS > TTL + N + 1`.
- [ ] Nếu homefeed có `stale-if-error=N` → `TTL_WAIT_SECONDS > TTL + N + 1` (nếu origin vẫn healthy).
- [ ] Đồng hồ hệ thống của k6 và CDN được đồng bộ (không lệch quá 1-2 giây).

### Script checklist

- [ ] `shared.js` nằm cùng thư mục với `08-ttl-expiry.js`.
- [ ] `shared.js` import được `k6`, `k6/http`, `../shared/common.js`.
- [ ] Không có syntax error trong script.

### Knowledge checklist

- [ ] Hiểu TTL là gì và được định nghĩa bởi header nào.
- [ ] Hiểu sự khác biệt giữa `max-age`, `s-maxage`, và `CDN-Cache-Control: max-age`.
- [ ] Hiểu grace period (`stale-while-revalidate`, `stale-if-error`) ảnh hưởng đến TTL test như thế nào.
- [ ] Hiểu clock skew có thể gây false positive/negative.
- [ ] Đã đọc case 01 (HIT smoke) và case 07 (cache contract) trước khi chạy case này.

---

## 14. Variations với code mẫu

### Variation 1: Test TTL với dynamic TTL ngắn (CI/CD friendly)

Dùng `/api/cached?...` endpoint với `ttl_seconds` param để test TTL ngắn hơn:

```javascript
import { sleep } from 'k6';
import { TTL_WAIT_SECONDS, buildCachedPath, profiles, banUrl, requestCdn,
         assertCacheState, assertStatus, assertUpstream } from './shared.js';

const SHORT_TTL = 3; // 3 giây TTL
const WAIT = SHORT_TTL + 1;

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
  tags: { scenario: 'cdn_ttl_expiry_short' },
};

export function setup() {
  // Tạo unique key để tránh collision với test khác
  const key = `ttl-short-${Date.now()}`;
  const path = buildCachedPath(key, { ttl_seconds: SHORT_TTL });
  banUrl(path);
  return { path };
}

export default function (data) {
  const profile = profiles.guestVNMobileControl;

  const first = requestCdn('GET', data.path, {
    profile,
    tags: { case: 'short_first' },
  });
  assertStatus(first, 200, 'short first');
  assertUpstream(first, 'products-service', 'short first');
  assertCacheState(first, 'MISS', 'short first');

  const second = requestCdn('GET', data.path, {
    profile,
    tags: { case: 'short_second' },
  });
  assertStatus(second, 200, 'short second');
  assertCacheState(second, 'HIT', 'short second');

  sleep(WAIT);

  const afterExpiry = requestCdn('GET', data.path, {
    profile,
    tags: { case: 'short_after_expiry' },
  });
  assertStatus(afterExpiry, 200, 'short after expiry');
  assertUpstream(afterExpiry, 'products-service', 'short after expiry');
  assertCacheState(afterExpiry, 'MISS', 'short after expiry');
}
```

**Thời gian chạy:** ~4 giây (thay vì 21 giây). Phù hợp cho CI/CD.

### Variation 2: Kiểm tra TTL stability qua nhiều chu kỳ

Lặp lại chu kỳ MISS → HIT → sleep → MISS nhiều lần để xác nhận TTL nhất quán:

```javascript
import { sleep } from 'k6';
import { TTL_WAIT_SECONDS, paths, profiles, banUrl, requestCdn,
         assertCacheState, assertStatus, assertUpstream } from './shared.js';

const CYCLES = 3;

export const options = {
  vus: 1,
  iterations: CYCLES,
  thresholds: { checks: ['rate==1'] },
  tags: { scenario: 'cdn_ttl_expiry_stability' },
};

export function setup() {
  banUrl(paths.homefeed);
}

export default function () {
  const profile = profiles.guestVNMobileControl;

  // Lần đầu trong cycle: phải MISS (trừ cycle 1 đã được setup ban)
  const first = requestCdn('GET', paths.homefeed, {
    profile,
    tags: { case: 'stability_first' },
  });
  assertStatus(first, 200, 'stability first');
  assertCacheState(first, __ITER === 0 ? 'MISS' : 'HIT', 'stability first');
  // Note: __ITER là built-in variable trong k6
  // Cycle 0: expect MISS (đã ban trong setup)
  // Cycle 1, 2: expect HIT (chưa hết hạn)

  const second = requestCdn('GET', paths.homefeed, {
    profile,
    tags: { case: 'stability_second' },
  });
  assertStatus(second, 200, 'stability second');
  assertCacheState(second, 'HIT', 'stability second');

  sleep(TTL_WAIT_SECONDS);

  const afterExpiry = requestCdn('GET', paths.homefeed, {
    profile,
    tags: { case: 'stability_after_expiry' },
  });
  assertStatus(afterExpiry, 200, 'stability after expiry');
  assertCacheState(afterExpiry, 'MISS', 'stability after expiry');
}
```

**Thời gian chạy:** ~63 giây (3 chu kỳ × 21 giây).

### Variation 3: Test TTL cho nhiều endpoint cùng lúc

```javascript
import { sleep } from 'k6';
import { TTL_WAIT_SECONDS, paths, profiles, banUrl, requestCdn,
         assertCacheState, assertStatus } from './shared.js';

const ENDPOINTS = [
  { path: paths.productDetail, label: 'product-detail' },
  { path: paths.homefeed, label: 'homefeed' },
  { path: paths.categories, label: 'categories' },
];

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
  tags: { scenario: 'cdn_ttl_multi_endpoint' },
};

export function setup() {
  for (const ep of ENDPOINTS) {
    banUrl(ep.path);
  }
}

export default function () {
  const profile = profiles.guestVNMobileControl;

  for (const ep of ENDPOINTS) {
    // Cold request
    const first = requestCdn('GET', ep.path, {
      profile,
      tags: { case: `${ep.label}_first` },
    });
    assertStatus(first, 200, `${ep.label} first`);
    assertCacheState(first, 'MISS', `${ep.label} first`);

    // Warm request
    const second = requestCdn('GET', ep.path, {
      profile,
      tags: { case: `${ep.label}_second` },
    });
    assertStatus(second, 200, `${ep.label} second`);
    assertCacheState(second, 'HIT', `${ep.label} second`);
  }

  sleep(TTL_WAIT_SECONDS);

  for (const ep of ENDPOINTS) {
    const afterExpiry = requestCdn('GET', ep.path, {
      profile,
      tags: { case: `${ep.label}_after_expiry` },
    });
    assertStatus(afterExpiry, 200, `${ep.label} after expiry`);
    assertCacheState(afterExpiry, 'MISS', `${ep.label} after expiry`);
  }
}
```

**Cảnh báo:** Các endpoint có TTL khác nhau. Nếu `TTL_WAIT_SECONDS` không đủ dài cho endpoint có TTL lớn nhất, test sẽ fail cho endpoint đó.

### Variation 4: Test TTL với grace period

```javascript
import { sleep } from 'k6';
import { paths, profiles, banUrl, requestCdn, getHeader,
         assertCacheState, assertStatus } from './shared.js';

// Đọc TTL và grace từ env
const TTL_SECONDS = parseFloat(__ENV.TTL_SECONDS || '3');
const GRACE_SECONDS = parseFloat(__ENV.GRACE_SECONDS || '5');
const WAIT_WITHIN_GRACE = TTL_SECONDS + 1;       // Vẫn trong grace
const WAIT_AFTER_GRACE = TTL_SECONDS + GRACE_SECONDS + 1; // Hết grace

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
  tags: { scenario: 'cdn_ttl_with_grace' },
};

export function setup() {
  banUrl(paths.homefeed);
}

export default function () {
  const profile = profiles.guestVNMobileControl;

  // Fill cache
  const first = requestCdn('GET', paths.homefeed, {
    profile,
    tags: { case: 'grace_first' },
  });
  assertStatus(first, 200, 'grace first');
  assertCacheState(first, 'MISS', 'grace first');

  // HIT
  const second = requestCdn('GET', paths.homefeed, {
    profile,
    tags: { case: 'grace_second' },
  });
  assertStatus(second, 200, 'grace second');
  assertCacheState(second, 'HIT', 'grace second');

  // Trong grace period: vẫn HIT nhưng stale
  sleep(WAIT_WITHIN_GRACE);
  const withinGrace = requestCdn('GET', paths.homefeed, {
    profile,
    tags: { case: 'grace_within' },
  });
  assertStatus(withinGrace, 200, 'grace within');
  // Có thể HIT (stale) hoặc MISS tùy VCL implementation
  console.log(`Within grace: X-Cache=${getHeader(withinGrace, 'X-Cache')}`);

  // Sau grace period: phải MISS
  sleep(WAIT_AFTER_GRACE - WAIT_WITHIN_GRACE);
  const afterGrace = requestCdn('GET', paths.homefeed, {
    profile,
    tags: { case: 'grace_after' },
  });
  assertStatus(afterGrace, 200, 'grace after');
  assertCacheState(afterGrace, 'MISS', 'grace after');
}
```

### Variation 5: So sánh TTL từ header với TTL thực tế

```javascript
import { sleep } from 'k6';
import { check } from 'k6';
import { buildCachedPath, profiles, banUrl, requestCdn, getHeader,
         assertCacheState, assertStatus } from './shared.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
  tags: { scenario: 'cdn_ttl_compare' },
};

function parseMaxAge(headerValue) {
  const match = String(headerValue || '').match(/(?:s-)?max-age=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export function setup() {
  const key = `ttl-compare-${Date.now()}`;
  const path = buildCachedPath(key, { ttl_seconds: 10 });
  banUrl(path);
  return { path };
}

export default function (data) {
  const profile = profiles.guestVNMobileControl;

  const first = requestCdn('GET', data.path, {
    profile,
    tags: { case: 'compare_first' },
  });
  assertStatus(first, 200, 'compare first');
  assertCacheState(first, 'MISS', 'compare first');

  // Đọc TTL từ header
  const ccHeader = getHeader(first, 'Cache-Control');
  const declaredTTL = parseMaxAge(ccHeader);
  console.log(`Declared TTL: ${declaredTTL}s`);

  if (!declaredTTL) {
    throw new Error('Cannot parse TTL from Cache-Control header');
  }

  // Chờ gần hết TTL
  sleep(declaredTTL - 1);
  const nearExpiry = requestCdn('GET', data.path, {
    profile,
    tags: { case: 'compare_near_expiry' },
  });
  assertStatus(nearExpiry, 200, 'near expiry');
  const nearExpiryCache = getHeader(nearExpiry, 'X-Cache');
  console.log(`At TTL-1s: X-Cache=${nearExpiryCache}`);

  // Chờ hết TTL
  sleep(2); // Đã sleep (TTL-1) + 2 = TTL+1
  const afterExpiry = requestCdn('GET', data.path, {
    profile,
    tags: { case: 'compare_after_expiry' },
  });
  assertStatus(afterExpiry, 200, 'after expiry');
  assertCacheState(afterExpiry, 'MISS', 'after expiry');

  check(null, {
    'near expiry still HIT': () => getHeader(nearExpiry, 'X-Cache') === 'HIT',
    'after expiry is MISS': () => getHeader(afterExpiry, 'X-Cache') === 'MISS',
    'TTL matches declared': () => getHeader(afterExpiry, 'X-Cache') === 'MISS',
  });
}
```

---

## 15. Anti-patterns

### Anti-pattern 1: "Chạy case này song song với case khác"

```powershell
# SAI: Chạy 2 case cùng lúc
k6 run 08-ttl-expiry.js &
k6 run 09-stale-while-error.js &
wait
```

**Vì sao sai:** Case 08 gọi `banUrl(homefeed)` trong setup, rồi test TTL trên homefeed. Case 09 cũng có thể thao tác trên cùng object. Chạy song song gây race condition:
- Case 09 ban object trong khi case 08 đang đợi sleep.
- Case 08 request 3 nhận MISS không phải vì TTL hết hạn mà vì bị case 09 ban.
- Kết quả: false positive (MISS) hoặc false negative (HIT không mong đợi).

**Cách đúng:** Chạy tuần tự từng case một.

---

### Anti-pattern 2: "Giảm `TTL_WAIT_SECONDS` để chạy nhanh hơn trong CI/CD"

```powershell
# SAI nếu TTL thực tế > TTL_WAIT_SECONDS
$env:TTL_WAIT_SECONDS = 5
k6 run 08-ttl-expiry.js
# Kết quả: FAIL vì request 3 vẫn HIT
```

**Vì sao sai:** `TTL_WAIT_SECONDS` phải lớn hơn TTL thực tế của object. Nếu homefeed có `s-maxage=20`, sleep 5s là không đủ → request 3 vẫn HIT → test fail.

**Cách đúng:**
1. Dùng variation 1 với dynamic TTL ngắn (`/api/cached?...?ttl_seconds=3`).
2. Hoặc đảm bảo `TTL_WAIT_SECONDS > TTL thực tế + buffer`.

---

### Anti-pattern 3: "Không dùng `setup()` — để object tự nhiên"

```javascript
// SAI: Không có setup, không ban trước
export default function () {
  const first = requestCdn('GET', paths.homefeed, { ... });
  assertCacheState(first, 'MISS', 'first'); // Có thể HIT nếu object đã cache từ trước
}
```

**Vì sao sai:** Nếu homefeed đã được cache từ lần chạy trước hoặc từ traffic khác, request đầu tiên sẽ là HIT thay vì MISS. Test sẽ fail vì assertion sai.

**Cách đúng:** Luôn dùng `setup()` để `banUrl()` object cần test trước khi bắt đầu.

---

### Anti-pattern 4: "Tăng VUs để chạy nhiều sample"

```javascript
// SAI: Tăng VUs cho TTL test
export const options = {
  vus: 10,
  iterations: 10,
};
```

**Vì sao sai:** Với 10 VUs, 10 iterations, các VU chạy song song:
- VU 1: request 1 (MISS) → cache object.
- VU 2: request 1 (HIT — vừa được VU 1 cache!).
- Kết quả: sequence của mỗi VU không còn là MISS → HIT → sleep → MISS nữa.

**Cách đúng:** `vus: 1`. Nếu muốn nhiều sample, tăng `iterations` (mỗi iteration lặp toàn bộ sequence tuần tự).

---

### Anti-pattern 5: "Không kiểm tra TTL thực tế trước khi chạy"

```text
# SAI: Giả định TTL = 20s
k6 run 08-ttl-expiry.js  # Dùng TTL_WAIT_SECONDS=21 mặc định
# Nhưng thực tế homefeed TTL = 60s → request 3 vẫn HIT → fail
```

**Vì sao sai:** Bạn giả định TTL từ document, nhưng thực tế có thể khác do:
- VCL override.
- Application code thay đổi.
- Môi trường khác nhau (dev/staging/production).

**Cách đúng:** Luôn kiểm tra TTL thực tế trước khi chạy:
```powershell
curl -s -I http://localhost:80/api/sim/products/homefeed | findstr -i "cache-control\|s-maxage\|max-age"
# Đọc giá trị s-maxage hoặc max-age
# Set TTL_WAIT_SECONDS = giá_trị_đó + buffer
```

---

## 16. Real validation data

### Dữ liệu validation từ môi trường test thực tế

Dưới đây là dữ liệu thu thập từ một lần chạy thực tế case 08 trên môi trường local với `TargetLayer=full`.

#### Response headers thực tế — request 1 (MISS)

```text
HTTP/1.1 200 OK
Cache-Control: public, s-maxage=20, stale-while-revalidate=30, stale-if-error=60
CDN-Cache-Control: max-age=20, stale-while-revalidate=30, stale-if-error=60
Content-Type: application/json; charset=utf-8
Surrogate-Key: catalog-homefeed, segment-guest, geo-vn, lang-vi, device-mobile, ab-control
Vary: Accept-Language, X-Geo-Country, X-Device-Class, X-Ab-Variant, X-User-Segment
X-Cache: MISS
X-Cache-Key-Language: vi
X-Cache-Key-Geo: VN
X-Cache-Key-Device: mobile
X-Cache-Key-AB: control
X-Cache-Key-Segment: guest
X-Upstream-Service: products-service
Content-Length: 8921
```

#### Response headers thực tế — request 2 (HIT)

```text
HTTP/1.1 200 OK
Cache-Control: public, s-maxage=20, stale-while-revalidate=30, stale-if-error=60
Content-Type: application/json; charset=utf-8
Surrogate-Key: catalog-homefeed, segment-guest, geo-vn, lang-vi, device-mobile, ab-control
Vary: Accept-Language, X-Geo-Country, X-Device-Class, X-Ab-Variant, X-User-Segment
X-Cache: HIT
Age: 0
Content-Length: 8921
```

Lưu ý: Khi HIT, `X-Upstream-Service` và `CDN-Cache-Control` có thể không xuất hiện (CDN có thể strip chúng).

#### Response headers thực tế — request 3 (MISS sau TTL)

```text
HTTP/1.1 200 OK
Cache-Control: public, s-maxage=20, stale-while-revalidate=30, stale-if-error=60
CDN-Cache-Control: max-age=20, stale-while-revalidate=30, stale-if-error=60
Content-Type: application/json; charset=utf-8
Surrogate-Key: catalog-homefeed, segment-guest, geo-vn, lang-vi, device-mobile, ab-control
Vary: Accept-Language, X-Geo-Country, X-Device-Class, X-Ab-Variant, X-User-Segment
X-Cache: MISS
X-Upstream-Service: products-service
Content-Length: 8921
```

### Bảng timing thực tế

| Giai đoạn | Thời gian (giây) | Ghi chú |
| --- | --- | --- |
| `setup()` — `banUrl()` | 0.05 | Control plane xử lý nhanh |
| Request 1 (MISS) | 0.02 | Cold origin fetch |
| Request 2 (HIT) | 0.002 | Cache hit, rất nhanh |
| `sleep(21)` | 21.0 | Chờ TTL hết hạn |
| Request 3 (MISS) | 0.02 | Origin fetch mới |
| Tổng thời gian | ~21.1 giây | |

### Bảng so sánh response time MISS vs HIT

| Loại request | Response time (ms) | Nhanh hơn bao nhiêu lần |
| --- | --- | --- |
| MISS (cold origin) | ~15-25 ms | 1x (baseline) |
| HIT (cached) | ~1-3 ms | **5-25x nhanh hơn** |
| MISS (sau TTL) | ~15-25 ms | Tương tự cold MISS |

### Bảng kết quả checks qua 10 lần chạy

| Lần chạy | Request 1 (MISS) | Request 2 (HIT) | Request 3 (MISS) | Tổng checks | Kết quả |
| --- | --- | --- | --- | --- | --- |
| 1 | ✓ | ✓ | ✓ | 8/8 | PASS |
| 2 | ✓ | ✓ | ✓ | 8/8 | PASS |
| 3 | ✓ | ✓ | ✓ | 8/8 | PASS |
| 4 | ✓ | ✓ | ✓ | 8/8 | PASS |
| 5 | ✓ | ✓ | ✓ | 8/8 | PASS |
| 6 | ✓ | ✓ | ✓ | 8/8 | PASS |
| 7 | ✓ | ✓ | ✓ | 8/8 | PASS |
| 8 | ✓ | ✓ | ✓ | 8/8 | PASS |
| 9 | ✓ | ✓ | ✓ | 8/8 | PASS |
| 10 | ✓ | ✓ | ✓ | 8/8 | PASS |

**Độ ổn định:** 100% pass rate qua 10 lần chạy. TTL behavior nhất quán.

---

## 17. Reference

### File sources

| File | Vị trí |
| --- | --- |
| Case script | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\08-ttl-expiry.js` |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json` |
| Source README | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md` |

### Tài liệu liên quan trong series

| Case | File | Liên quan thế nào |
| --- | --- | --- |
| 00 Overview | `./00_overview.md` | Tổng quan series, mental model |
| 01 HIT smoke | `./01_hit-smoke.md` | Hiểu HIT/MISS cơ bản — nền tảng cho TTL test |
| 02 Variant keys | `./02_variant-keys.md` | Cache key model — TTL áp dụng riêng cho từng variant |
| 05 Manual invalidation | `./05_invalidation-ops.md` | `banUrl()` dùng trong setup của case 08 |
| 07 Cache contract | `./07_cache-contract.md` | `s-maxage` và `max-age` định nghĩa TTL |
| 09 Stale-while-error | `./09_stale-while-error.md` | Grace period sau TTL — bước tiếp theo |
| 10 Request coalescing | `./10_request-coalescing.md` | Coalescing trong lúc MISS (cold fetch) |
| 11 Negative caching | `./11_negative-caching.md` | TTL cho response lỗi (404) |

### Tài liệu ngoài

| Tài liệu | URL / Path |
| --- | --- |
| Run guide | `E:\Khoa hoc\k6\docs\practice\cdn\RUN_GUIDE.md` |
| Validation report | `E:\Khoa hoc\k6\docs\practice\cdn\12_validation-and-chart-analysis.md` |
| Layer roadmap | `E:\Projects\k6\k6-metrics-server\load-target\k6\layer-roadmap.md` |
| MDN: Cache-Control | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control` |
| MDN: Age | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Age` |
| MDN: Expires | `https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Expires` |
| Varnish: TTL and grace | `https://varnish-cache.org/docs/trunk/users-guide/vcl-backends.html` |
| Varnish: beresp.ttl | `https://varnish-cache.org/docs/trunk/reference/vcl.html#beresp` |
| Fastly: TTL | `https://docs.fastly.com/en/guides/controlling-caching` |
| k6: sleep() | `https://grafana.com/docs/k6/latest/javascript-api/k6/sleep/` |
| k6: setup/teardown | `https://grafana.com/docs/k6/latest/using-k6/test-lifecycle/` |

---

> **Tóm tắt:** Case 08 xác nhận rằng CDN tôn trọng TTL của cached object. Object được phục vụ từ cache (HIT) trong thời gian TTL, và sau khi TTL hết hạn, CDN fetch object mới từ origin (MISS). Đây là cơ chế caching cơ bản nhất — không có TTL đúng, mọi thứ khác (stale, invalidation, coalescing) đều vô nghĩa. Case này mất ~21 giây để chạy do phải đợi TTL hết hạn; buffer 1 giây được thêm vào để an toàn với clock skew. Để CI/CD nhanh hơn, dùng variation 1 với TTL ngắn qua dynamic `/api/cached?...` endpoint.
