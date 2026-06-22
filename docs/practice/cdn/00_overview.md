# Series thực hành: CDN / Varnish layer

## Mục đích series

Series này mở đầu phần **layer-level practice** -- giai đoạn sau khi bạn đã học xong các executor packs (constant-vus, ramping-vus, shared-iterations, constant-arrival-rate, ramping-arrival-rate, per-vu-iterations).

```text
Executor suite trả lời: traffic shape là gì?
Layer suite trả lời: layer nào đang được validate, và behavior/correctness của layer đó đúng chưa?
```

### Tại sao CDN testing quan trọng

CDN/Varnish là **layer đầu tiên** mà production traffic chạm vào. Mọi request từ Internet, trước khi đến được application server, đều phải đi qua edge cache. Nếu CDN có bug -- cache sai object, không invalidate kịp, bypass không đúng rule -- application có thể trả về dữ liệu sai audience, stale data được serve như fresh, hoặc private data của user A bị cache và serve cho user B.

Trong executor packs, bạn học cách tạo traffic shape và đọc counters/timing. Nhưng executor packs không trả lời được:

```text
- Object này có được cache không?
- Hai request khác variant có share chung cache object không?
- Sau khi purge/ban, object đã thực sự bị xóa khỏi cache chưa?
- Khi origin chết, CDN có serve stale object thay vì trả 503 không?
- Nhiều request đồng thời cùng cold key có gây stampede lên origin không?
```

**Series CDN này trả lời tất cả những câu hỏi đó.**

### Điều series này chứng minh mà executor series không chứng minh được

| Executor series chứng minh | CDN series chứng minh |
|---|---|
| Hệ thống chịu được X arrivals/s | Object đúng được cache với HIT sau MISS đầu tiên |
| Latency P95 dưới ngưỡng Y | Variant không bị leak giữa các audience khác nhau |
| Throughput đạt target Z | Auth/write traffic không bị cache nhầm |
| Không có dropped_iterations | Purge/ban thực sự xóa object khỏi cache |
| VU pressure còn headroom | Origin không bị stampede khi cold burst |

Nói ngắn gọn: **Executor = traffic shape + performance. CDN = cache correctness + data integrity.**

### Triết lý pass/fail của series này

Một case CDN **pass** khi:

```text
- Cache-state sequence (MISS -> HIT -> ...) đúng với contract
- Headers (X-Cache, X-Cache-Key-*, X-Cache-Stale, X-Negative-Cache) đúng giá trị
- Origin counters chứng minh offload/coalescing/stale thật (không phải chỉ claim)
- Control/event effects khớp với expected state transition
```

Một case CDN **không pass** khi:

```text
- Status code OK nhưng X-Cache sai (ví dụ: expected HIT nhưng nhận MISS)
- Purge/ban trả 200 nhưng request tiếp theo vẫn HIT
- Stale case trả 200 nhưng không có X-Cache-Stale header
- Coalescing case origin count cao hơn expected threshold
```

**Không đánh giá bằng status code đơn thuần.** Case 11 (negative caching) dùng 404 làm expected business outcome -- pass/fail dựa trên checks và headers, không dựa trên http_req_failed.

---

## Mental model: public edge path + control path

### Topology đầy đủ

Runtime đúng cho suite này là `TargetLayer=full`:

```text
                        ┌─────────────────────────────────────────┐
                        │              VARNISH CDN                │
                        │  (localhost:80)                         │
                        │                                         │
  ┌──────────┐   :80   │  ┌──────────┐    ┌──────┐    ┌───────┐ │
  │          │────────>│  │ vcl_recv │───>│ hash │───>│ cache │ │ │
  │   k6     │  public │  │  route   │    │store │    │ lookup│ │ │
  │  client  │  path   │  │  bypass  │    └──────┘    └───┬───┘ │ │
  │          │         │  └──────────┘                    │     │ │
  │          │         │       │                HIT ──────┤     │ │
  │          │         │       │ pass          MISS ──────┤     │ │
  │          │         │       │                          │     │ │
  └──────────┘         │       │         ┌────────────────┘     │ │
        │               │       │         │                      │ │
        │               │       │    ┌────▼─────┐               │ │
        │  :8088        │       │    │  NGINX   │               │ │
        │  control      │       │    │  (:80)   │               │ │
        │  path         │       │    └────┬─────┘               │ │
        │               │       │         │                      │ │
        │  :9091        │       │    ┌────▼──────────────────┐  │ │
        │  catalog      │       │    │  app/microservices    │  │ │
        │  events       │       │    │  - products-service   │  │ │
        │               │       │    │  - cart-service       │  │ │
        └───────────────┘       │    │  - search-service     │  │ │
                                │    └───────────────────────┘  │ │
                                └─────────────────────────────────┘
```

### Ba path -- ba mục đích khác nhau

**Path 1 -- Public edge (`localhost:80`):** Đây là path chính để chứng minh cache behavior. Tất cả traffic từ k6 đi qua path này đều vào Varnish, qua VCL routing, hash lookup, và nếu MISS thì forward đến Nginx rồi app. Đây là nơi bạn quan sát:

```text
- X-Cache: HIT hay MISS?
- X-Cache-Key-*: Cache key dimensions là gì?
- X-Cache-Stale, X-Cache-Backend-Healthy, X-Negative-Cache
- Response body và variant đúng audience không?
```

**Path 2 -- Control (`localhost:8088`):** Path này bypass Varnish hoàn toàn, đi thẳng đến app internal API. Dùng cho:

```text
- Purge/Ban object khỏi cache (invalidation)
- Đọc/ghi origin profile (healthy/unhealthy simulation)
- Đọc/reset origin request counters (evidence cho coalescing/stale/negative)
- Xác thực bằng OPS_AUTH_TOKEN
```

Tại sao control path cần bypass Varnish? Vì một số thao tác (force origin unhealthy) có thể làm Varnish không forward được request. Nếu control path đi qua Varnish, bạn không thể thay đổi origin state khi Varnish đang unhealthy.

**Path 3 -- Catalog events (`localhost:9091`):** Mock service mô phỏng event bus. Khi bạn POST event vào đây, internal handler xử lý và gọi CDN invalidation. Dùng riêng cho case 06. Path này tồn tại vì:

```text
- Mô phỏng flow thực tế: product update event -> app handler -> CDN invalidation
- Không phải manual purge; là event-driven invalidation
- Cần chứng minh event chain hoạt động end-to-end
```

### "TargetLayer=full" nghĩa là gì?

```text
TargetLayer=minimal  -> chỉ app, không có CDN (dùng cho executor packs)
TargetLayer=full     -> app + Varnish CDN + Nginx (dùng cho CDN series này)
```

Khi `TargetLayer=full`:
- Public traffic vào `:80` bắt buộc đi qua Varnish
- Control traffic vào `:8088` đi thẳng app
- Catalog events vào `:9091` đi mock event handler
- Varnish backend pointer trỏ đến Nginx, không trỏ trực tiếp app

Nếu bạn chạy CDN cases với `TargetLayer=minimal`, mọi request đều MISS vì không có cache layer -- kết quả không có ý nghĩa.

---

## Required topology and env

### Biến môi trường bắt buộc

```text
TargetLayer = full

BASE_URL                  = http://localhost:80
CONTROL_BASE_URL          = http://localhost:8088
CATALOG_EVENTS_BASE_URL   = http://localhost:9091
OPS_AUTH_TOKEN            = <ops-token>
```

### Ý nghĩa từng biến

**`BASE_URL`** (`http://localhost:80`): Public URL cho toàn bộ traffic cache-read. Tất cả request GET sản phẩm, search, homefeed, categories, recommendations đi qua URL này. Đây chính là URL mà production user thực sự gọi.

**`CONTROL_BASE_URL`** (`http://localhost:8088`): Internal control-plane URL. Dùng cho purge, ban, origin profile management, origin counter monitoring. URL này đi thẳng vào app, không qua Varnish. Việc tách port riêng cho control plane đảm bảo control operations vẫn hoạt động ngay cả khi Varnish đang unhealthy.

**`CATALOG_EVENTS_BASE_URL`** (`http://localhost:9091`): Mock event bus URL. Chỉ dùng trong case 06 để mô phỏng event-driven invalidation. Nhận POST request mô phỏng product-updated và homefeed-updated events.

**`OPS_AUTH_TOKEN`**: Token xác thực cho toàn bộ control-plane operations. **Không commit token thật vào docs/report.** Đây là target control token, không phải learner metrics token (`K6_CLOUD_TOKEN`).

### Cách lấy OPS_AUTH_TOKEN

Token này được inject bởi platform, không phải giá trị mà learner tự tạo:

```text
Local single-student mode:
  OPS_AUTH_TOKEN = <local-student-target-token>
  CDN_OPS_TOKEN (trong target stack) phải mirror giá trị này

Shared hosted mode:
  Token được inject server-side trong run worker
  KHÔNG expose một global token cho tất cả learner

Frontend rule:
  KHÔNG yêu cầu learner nhập OPS_AUTH_TOKEN thủ công
  FE hoặc backend runner phải tự động inject vào k6 process
```

Trong shared.js, helper có fallback compatibility: nếu `OPS_AUTH_TOKEN` không được set, helper thử đọc `OPS_TOKEN`. Nhưng contract chính của docs là `OPS_AUTH_TOKEN`.

### Khởi động stack đúng

```powershell
# Từ thư mục load-target:
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full -ScaleApp 2
```

Sau khi stack up, xác nhận:

```text
- localhost:80 có response (qua Varnish)
- localhost:8088 có response (control plane)
- localhost:9091 có response (catalog events mock)
- X-Cache header xuất hiện trong response từ :80
```

### Env vars cho từng case (default)

Các case có thể được tinh chỉnh qua biến môi trường. Đây là bảng tổng hợp mặc định:

| Biến | Case | Default | Ý nghĩa |
|---|---|---|---|
| `HIT_SMOKE_VUS` | 01 | 4 | Số VU sustained cho smoke test |
| `HIT_SMOKE_DURATION` | 01 | 18s | Thời gian sustained |
| `HIT_SMOKE_SLEEP_SECONDS` | 01 | 0.025 | Sleep giữa các iteration |
| `VARIANT_KEYS_ITERATIONS` | 02 | 24 | Số lần lặp variant proof |
| `TTL_WAIT_SECONDS` | 08 | 21 | Thời gian chờ TTL expire |
| `STALE_TTL_SECONDS` | 09 | 2 | TTL của object stale test |
| `STALE_IF_ERROR_SECONDS` | 09 | 120 | Grace period khi origin lỗi |
| `STALE_POST_TTL_WAIT_SECONDS` | 09 | 3 | Chờ sau TTL trước khi probe |
| `COALESCE_CONCURRENCY` | 10 | 12 | Số request đồng thời cold burst |
| `COALESCE_ORIGIN_DELAY_MS` | 10 | 800 | Delay giả lập origin chậm |
| `COALESCE_TTL_SECONDS` | 10 | 30 | TTL cho object coalesce test |
| `NEGATIVE_TTL_SECONDS` | 11 | 5 | TTL cho negative cache |
| `NEGATIVE_WAIT_SECONDS` | 11 | 7 | Thời gian chờ expiry |

---

## CDN concepts primer

Đây là phần quan trọng nhất cho người mới bắt đầu. Mỗi concept được giải thích bằng tiếng Việt đơn giản, kèm ví dụ cụ thể, và liên kết đến case chứng minh.

### 1. Cache key -- danh tính của object trong CDN

Cache key là "chứng minh thư" của một object trong cache. Hai request chỉ share chung cache object nếu cache key của chúng giống hệt nhau.

Cache key được tạo từ:
- **URL đã normalize** (sau khi loại bỏ tracking params và sort query string)
- **Host header**
- **Variant headers đã normalize**: Language, Geo, Device, AB variant (và Segment cho homefeed)

Ví dụ: Request A (`?q=shoe&utm_source=fb`) và request B (`?q=shoe`) có cache key giống hệt nhau vì `utm_source` bị strip. Request C (`?q=shoe&sort=price`) có cache key KHÁC vì `sort` là business param.

> **Case chứng minh:** 01 (cache key cơ bản), 02 (variant dimensions), 04 (query normalization)

### 2. HIT / MISS / BYPASS / STALE / PASS -- các trạng thái cache

**HIT:** Object tồn tại trong cache và còn fresh (trong TTL). CDN trả object từ cache, không gọi origin. Đây là trạng thái mong muốn cho mọi cacheable read. Header: `X-Cache: HIT`.

**MISS:** Object không tồn tại trong cache, hoặc đã expired và bị evict. CDN forward request đến origin, cache response (nếu cacheable), rồi trả về client. Header: `X-Cache: MISS`.

**BYPASS (not HIT):** Request bị cấm cache vì lý do business/security. CDN forward thẳng đến origin, không cache response. Các lý do bypass:
- Có `Authorization` header (authenticated request)
- Có `Cookie` header (session-bound request)
- Client gửi `Cache-Control: no-cache`
- Method không phải GET/HEAD (POST, PUT, DELETE)
- URL chứa `_nocache` hoặc `cache_bust` parameter
- Response có `Set-Cookie` hoặc `Cache-Control: private/no-store`

Header: `X-Cache: MISS` (nhưng object không được cache -- request tiếp theo vẫn MISS).

**STALE:** Object đã hết TTL nhưng vẫn được serve vì origin đang unhealthy. CDN dùng `stale-if-error` hoặc grace period để bảo vệ user khỏi origin failure. Header: `X-Cache: HIT` + `X-Cache-Stale: true`.

**PASS:** VCL quyết định không cache request này. Khác BYPASS ở chỗ PASS là quyết định của VCL, còn BYPASS là khái niệm chung. Trong VCL này, `return (pass)` được dùng khi request có auth/cookie/no-cache.

> **Case chứng minh:** 01 (HIT/MISS cơ bản), 03 (BYPASS rules), 08 (TTL -> MISS), 09 (STALE serving)

### 3. TTL / s-maxage / stale-if-error -- vòng đời freshness

Mỗi object trong cache có một TTL (time-to-live) -- thời gian object được coi là "fresh".

```text
[─── TTL (fresh) ───][─── Grace (stale) ───][─── Keep (revalidate) ───]
     HIT ngay              HIT + X-Cache-Stale      Conditional request
     không gọi origin      nếu origin unhealthy     đến origin nếu có
```

**s-maxage:** Giá trị `Cache-Control: s-maxage=N` từ origin. Đây là shared-cache TTL -- áp dụng cho CDN, không phải browser. Browser dùng `max-age`.

**stale-if-error:** `Cache-Control: stale-if-error=N`. Nếu origin lỗi (5xx, timeout, unhealthy probe) sau khi TTL hết, CDN được phép serve stale object trong N giây.

**Grace period (Varnish):** `beresp.grace = 120s` trong VCL. Tương tự `stale-if-error` nhưng là cơ chế của Varnish, áp dụng khi backend probe báo unhealthy.

**Keep period (Varnish):** `beresp.keep = 600s`. Object được giữ lại sau TTL+grace để phục vụ conditional request (If-None-Match / If-Modified-Since).

**TTL mặc định trong VCL này:**

| URL pattern | TTL mặc định |
|---|---|
| `/api/cached/*` | 60s |
| `/api/sim/products/categories` | 300s |
| `/api/sim/products/search` | 45s |
| `/api/sim/products/homefeed` | 20s |
| `/api/sim/products/:id/recommendations` | 45s |
| `/api/sim/products/:id` | 90s |
| `/api/sim/products` | 60s |

> **Case chứng minh:** 07 (cache contract headers), 08 (TTL expiry), 09 (stale serving)

### 4. Purge / Ban URL / Ban-prefix / Ban-tag -- bốn vũ khí invalidation

Khi nội dung thay đổi, object cũ trong cache phải bị xóa. Có bốn cách:

**Purge:** Xóa MỘT object cụ thể -- exact URL + host. Nhanh nhất, chính xác nhất. Nếu object có variant (nhiều cache key cho cùng URL), purge với profile headers sẽ xóa đúng variant đó.

```
POST /ops/app/cdn/cache/purge  { url: "/api/sim/products/1", headers: {...} }
```

**Ban URL:** Xóa TẤT CẢ variant của một URL. Dùng regex matching trên `req.url`. Chậm hơn purge nhưng bao quát hơn.

```
POST /ops/app/cdn/cache/ban-url  { url: "/api/sim/products/1" }
```

**Ban-prefix:** Xóa toàn bộ object có URL khớp prefix. Dùng để xóa cả nhóm endpoint (ví dụ: toàn bộ `/api/sim/products/`).

```
POST /ops/app/cdn/cache/ban  { prefix: "/api/sim/products/" }
```

**Ban-tag:** Xóa object theo `Surrogate-Key` tag. Một object có thể có nhiều tag (ví dụ: `product-1`, `category-shoes`, `homefeed`). Khi ban tag `product-1`, tất cả object có tag đó (product detail + recommendations + search results chứa product đó) đều bị xóa. Đây là cách mạnh nhất và linh hoạt nhất.

```
POST /ops/app/cdn/cache/ban-tag  { tag: "product-1" }
```

> **Case chứng minh:** 05 (manual invalidation ops -- purge, ban-url, ban-tag), 06 (event-driven invalidation dùng ban-tag)

### 5. Revalidation / ETag / 304 -- conditional request

Khi client (hoặc CDN upstream) có bản copy của object kèm ETag hoặc Last-Modified, nó có thể hỏi origin: "object có thay đổi không?" bằng cách gửi:

```
If-None-Match: "abc123"    (ETag-based)
If-Modified-Since: Tue, ... (Last-Modified-based)
```

Nếu object không thay đổi, origin trả `304 Not Modified` -- không cần gửi lại body. Nếu thay đổi, origin trả `200` với object mới.

Revalidation là cơ chế tiết kiệm bandwidth: khi object hết TTL nhưng vẫn trong keep period, CDN gửi conditional request đến origin thay vì fetch full.

> **Case chứng minh:** 07 (cache contract + 304)

### 6. Request coalescing / collapsed forwarding -- chống thundering herd

Khi một object cold (chưa có trong cache) nhận nhiều request đồng thời, nếu mỗi request đều forward đến origin, origin có thể bị stampede.

**Request coalescing:** CDN chỉ forward MỘT request đầu tiên đến origin. Các request sau (cùng cache key) bị "xếp hàng" chờ request đầu tiên hoàn thành, rồi tất cả cùng nhận response từ cache.

```text
12 concurrent requests cho cold key
  -> 1 request đến origin
  -> 11 request xếp hàng chờ
  -> Tất cả 12 request trả về, follow-up HIT
  -> Origin count: 1 (không phải 12)
```

Đây là cơ chế bảo vệ origin quan trọng nhất của CDN.

> **Case chứng minh:** 10 (coalescing với origin count verification)

### 7. Negative caching -- cache cả response lỗi kỳ vọng

Không phải chỉ 200 mới được cache. Các response lỗi **expected** như 404 (not found), 410 (gone) cũng nên được cache trong một cửa sổ ngắn để giảm tải origin.

```text
Request 1: GET /api/cached/missing/xyz -> 404 MISS (origin hit)
Request 2: GET /api/cached/missing/xyz -> 404 HIT  (served from cache)
Request 3: (sau TTL)                   -> 404 MISS (origin hit again)
```

Trong VCL này, 404/410 được cache với TTL ngắn và có header `X-Negative-Cache: true`.

> **Case chứng minh:** 11 (negative caching cycle)

### 8. Cache key dimensions cụ thể trong suite này

Suite này có 5 cache key dimensions, mỗi dimension được normalize trong VCL:

| Dimension | Header gốc | Normalize rule | Header trả về |
|---|---|---|---|
| Language | `Accept-Language` | Lấy 2 ký tự đầu, lowercase. Chỉ chấp nhận `vi/en/ja`; fallback `en` | `X-Cache-Key-Language` |
| Geo | `X-Geo-Country` | Chỉ chấp nhận `SG/US/JP`; fallback `VN` | `X-Cache-Key-Geo` |
| Device | `X-Device-Class` hoặc `User-Agent` | Chuẩn hóa về `mobile/tablet/desktop` | `X-Cache-Key-Device` |
| AB | `X-Ab-Variant` | Chỉ chấp nhận `variant-a/variant-b`; fallback `control` | `X-Cache-Key-AB` |
| Segment | `X-User-Segment` | Chỉ chấp nhận `new_user/returning/vip`; fallback `guest` | `X-Cache-Key-Segment` |

**Dimension nào áp dụng cho endpoint nào?**

| Endpoint | Language | Geo | Device | AB | Segment |
|---|---|---|---|---|---|
| `/api/sim/products/:id` | x | x | x | x | |
| `/api/sim/products` | x | x | x | x | |
| `/api/sim/products/search` | x | x | x | x | |
| `/api/sim/products/categories` | x | x | | | |
| `/api/sim/products/homefeed` | x | x | x | x | x |
| `/api/sim/products/:id/recommendations` | x | x | x | x | |
| `/api/cached/*` | | | | | |

Lưu ý: `Segment` **chỉ** được include trong cache key của `homefeed`, không phải tất cả endpoint. Điều này phản ánh business reality: homefeed cá nhân hóa theo user segment, còn product detail thì không.

> **Case chứng minh:** 02 (variant keys cho product detail, homefeed segment)

---

## Varnish VCL overview

File VCL (`default.vcl`) là "bộ não" của CDN. Đây là walkthrough giản lược, tập trung vào business logic, không phải syntax VCL.

### Backend declaration

```text
backend default {
  .host = "nginx"   // Varnish forward request đến Nginx container
  .port = "80"
  .probe = { .url = "/health/cdn-origin", .interval = 1s, .window = 3, .threshold = 2 }
}
```

Health probe check mỗi 1 giây. Cần 2/3 probe gần nhất thành công để backend được coi là healthy. Đây là cơ sở cho stale serving (case 09).

### `normalize_cache_variants` -- subroutine chuẩn hóa variant

Được gọi trước khi hash. Logic:
1. Parse `Accept-Language`, chỉ lấy 2 ký tự đầu. Nếu không phải `vi/en/ja` -> fallback `en`
2. Parse `X-Geo-Country`, chỉ chấp nhận `SG/US/JP` -> fallback `VN`
3. Parse `X-Device-Class` hoặc fallback User-Agent parsing -> normalize về `mobile/tablet/desktop`
4. Parse `X-Ab-Variant` -> chỉ chấp nhận `variant-a/variant-b`, fallback `control`
5. Parse `X-User-Segment` -> chỉ chấp nhận `new_user/returning/vip`, fallback `guest`

**Business rationale:** Cache key normalization ngăn cache fragmentation. Nếu không normalize, mỗi biến thể nhỏ của User-Agent hoặc Accept-Language sẽ tạo object riêng, làm cache hit ratio tụt và memory tăng.

### `vcl_recv` -- request routing (quan trọng nhất)

Đây là nơi mọi quyết định routing được đưa ra. Thứ tự xử lý:

**1. PURGE method:** Yêu cầu `X-Ops-Token` khớp. Chỉ cho phép purge path `/api/cached/*` và `/api/sim/products/*`. Nếu purge product, gọi normalize_cache_variants để purge đúng variant.

**2. BAN method:** Yêu cầu `X-Ops-Token` khớp. Ba chế độ:
- `X-Ban-URL`: ban exact URL
- `X-Ban-Tag`: ban theo Surrogate-Key tag
- `X-Ban-Prefix`: ban theo prefix (regex trên req.url)

**3. Method check:** Chỉ GET và HEAD được cache. POST/PUT/DELETE -> pass.

**4. Path bypass:** `/health`, `/metrics`, `/nginx-status`, `/ops/` -> pass.

**5. Cache bust bypass:** URL có `_nocache` hoặc `cache_bust` parameter -> pass.

**6. Client signal bypass:** `Cache-Control: no-cache`, `Authorization`, `Cookie` -> pass.

**7. Query normalization:** Strip `utm_*`, `fbclid`, `gclid` parameters. Sort query string parameters. Việc này đảm bảo `?q=shoe&utm=fb` và `?q=shoe` có cùng cache key.

**8. Route to hash:** `/api/cached/*` -> hash (no cache key variants). `/api/sim/products/*` -> normalize_cache_variants rồi hash.

**9. Default:** pass (không cache).

### `vcl_hash` -- cache key construction

Thêm vào hash:
- `req.url` (đã normalize)
- `req.http.host`
- Variant headers tùy theo URL pattern:
  - `/api/sim/products/categories` -> Language + Geo
  - `/api/sim/products/homefeed` -> Language + Geo + Device + AB + Segment (đầy đủ nhất)
  - `/api/sim/products/*` (default) -> Language + Geo + Device + AB

### `vcl_hit` -- xử lý khi object có trong cache

```text
if obj.ttl >= 0s:
  -> deliver (HIT, object fresh)
else if backend unhealthy AND obj.ttl + grace > 0s:
  -> deliver WITH X-Cache-Stale=true (stale serving)
else:
  -> pass (object expired, fetch from origin)
```

Đây là logic bảo vệ availability: nếu origin chết, user vẫn nhận được stale object thay vì lỗi.

### `vcl_backend_response` -- xử lý response từ origin

**1. 5xx errors:** TTL = 0, đánh dấu uncacheable. Không cache server errors.

**2. 404/410:** Nếu không có TTL từ origin, set TTL = 15s. Set grace = 30s, keep = 120s. Set `X-Negative-Cache: true`.

**3. Set-Cookie response:** TTL = 0, uncacheable. Không cache response có session data.

**4. `Cache-Control: no-store/private`:** TTL = 0, uncacheable.

**5. Fallback TTLs:** Nếu origin không set TTL, VCL gán TTL mặc định theo URL pattern (xem bảng ở trên).

**6. Nếu cacheable (TTL > 0):** Set grace = 120s, keep = 600s.

### `vcl_deliver` -- response header injection

```text
obj.hits > 0 -> X-Cache: HIT, X-Cache-Hits: <count>
obj.hits = 0 -> X-Cache: MISS

backend healthy -> X-Cache-Backend-Healthy: true
backend unhealthy -> X-Cache-Backend-Healthy: false

backend unhealthy + obj.hits > 0 -> X-Cache-Stale: true (temporary header)

URL là /api/sim/products/* -> inject X-Cache-Key-Language, X-Cache-Key-Geo
  + X-Cache-Key-Device, X-Cache-Key-AB (trừ categories)
  + X-Cache-Key-Segment (chỉ homefeed)
```

---

## Key headers/signals reference

Bảng tham chiếu đầy đủ tất cả CDN headers. Mỗi header kèm nguồn gốc (ai set), ý nghĩa business, giá trị có thể, và case chứng minh.

### Response headers (Varnish -> client)

| Header | Set by | Ý nghĩa | Giá trị | Case |
|---|---|---|---|---|
| `X-Cache` | `vcl_deliver` | Trạng thái cache của object | `HIT`, `MISS` | 01, 02, 04, 05, 06, 08, 09, 10, 11 |
| `X-Cache-Hits` | `vcl_deliver` | Số lần object này được hit từ cache | integer | 01 |
| `X-Cache-Age` | `vcl_deliver` | Thời gian object đã ở trong cache (seconds), mirror `Age` | integer | 08 |
| `X-Upstream-Service` | origin app | Service nào đã tạo response | `products-service`, `cart-service`, ... | 01, 03 |
| `X-Cache-Key-Language` | `vcl_deliver` | Language dimension trong cache key | `vi`, `en`, `ja` | 02, 07 |
| `X-Cache-Key-Geo` | `vcl_deliver` | Geo dimension trong cache key | `VN`, `US`, `SG`, `JP` | 02, 07 |
| `X-Cache-Key-Device` | `vcl_deliver` | Device dimension trong cache key | `mobile`, `tablet`, `desktop` | 02, 07 |
| `X-Cache-Key-AB` | `vcl_deliver` | AB variant dimension trong cache key | `control`, `variant-a`, `variant-b` | 02, 07 |
| `X-Cache-Key-Segment` | `vcl_deliver` | User segment dimension (chỉ homefeed) | `guest`, `new_user`, `returning`, `vip` | 02, 07 |
| `Cache-Control` | origin app | Freshness directive cho browser/CDN | `public, max-age=N, s-maxage=N` | 07 |
| `CDN-Cache-Control` | origin app | Freshness directive riêng cho CDN | `s-maxage=N, stale-if-error=N` | 07 |
| `ETag` | origin app | Entity tag cho revalidation | `"abc123"` | 07 |
| `Last-Modified` | origin app | Timestamp cho revalidation | HTTP date | 07 |
| `Surrogate-Key` | origin app | Tag cho ban-tag invalidation | `product-1 category-shoes homefeed` | 05, 06, 07 |
| `Vary` | origin app | Những header nào tạo variant | `Accept-Language, X-Geo-Country, ...` | 07 |
| `X-Cache-Stale` | `vcl_deliver` | Object đang được serve stale (origin unhealthy) | `true` (absent khi không stale) | 09 |
| `X-Cache-Backend-Healthy` | `vcl_deliver` | Trạng thái health của backend probe | `true`, `false` | 09 |
| `X-Negative-Cache` | `vcl_backend_response` | Response này được negative-cache (404/410) | `true` (absent với response khác) | 11 |
| `X-Served-By` | `vcl_deliver` | Xác nhận response đi qua Varnish | `varnish` | all |

### Request headers (client -> Varnish) -- cache key input

| Header | Dùng bởi | Ý nghĩa | Case |
|---|---|---|---|
| `Accept-Language` | `normalize_cache_variants` | Input cho Language dimension | 02 |
| `X-Geo-Country` | `normalize_cache_variants` | Input cho Geo dimension | 02 |
| `X-Device-Class` | `normalize_cache_variants` | Input cho Device dimension (ưu tiên hơn User-Agent) | 02 |
| `X-Ab-Variant` | `normalize_cache_variants` | Input cho AB dimension | 02 |
| `X-User-Segment` | `normalize_cache_variants` | Input cho Segment dimension (chỉ homefeed) | 02 |
| `Authorization` | `vcl_recv` | Kích hoạt bypass | 03 |
| `Cookie` | `vcl_recv` | Kích hoạt bypass | 03 |
| `Cache-Control: no-cache` | `vcl_recv` | Kích hoạt bypass | 03 |

### Control/Meta headers (internal)

| Header | Dùng ở đâu | Ý nghĩa |
|---|---|---|
| `X-Ops-Token` | PURGE, BAN requests | Xác thực control-plane operations |
| `X-Ban-URL` | BAN requests | Chỉ định exact URL để ban |
| `X-Ban-Tag` | BAN requests | Chỉ định Surrogate-Key tag để ban |
| `X-Ban-Prefix` | BAN requests | Chỉ định URL prefix để ban |

### Origin counter endpoints -- evidence cho cases 09/10/11

Đây là cơ chế quan trọng nhất để chứng minh offload/coalescing/stale là **thật**, không phải chỉ dựa trên header claim:

```text
GET  /ops/app/cdn/origin/request-counts
     -> { data: { counts: [{ request_key: "...", count: N }] } }

POST /ops/app/cdn/origin/request-counts/reset
     -> reset tất cả counters về 0
```

Mỗi lần origin nhận request từ Varnish forward, counter của `request_key` tương ứng tăng 1. Bằng cách đọc counter trước và sau test:

```text
- Case 09: origin count cho key = 1 (chỉ fetch lần đầu, sau đó serve stale)
- Case 10: origin count cho key <= 2 (coalescing limit)
- Case 11: origin count = 1 trước TTL, = 2 sau TTL expiry
```

---

## Case inventory

Bảng tổng hợp đầy đủ 11 case. Mỗi case có ID, script, capability proof, key evidence headers, độ khó, và suggested order.

| # | Case ID | Script | Capability proof | Key evidence | Độ khó | Order |
|---|---|---|---|---|---|---|
| 01 | `cdn-01-hit-smoke` | `01-hit-smoke.js` | Product detail `MISS -> HIT`, sustained HIT qua nhiều VU | `X-Cache`, `X-Upstream-Service`, `X-Cache-Hits` | Cơ bản | 1 |
| 02 | `cdn-02-variant-keys` | `02-variant-keys.js` | Language/geo/device/AB/segment không leak variant; mỗi variant có MISS/HIT riêng | `X-Cache-Key-*`, per-variant sequence | Trung bình | 2 |
| 03 | `cdn-03-bypass-rules` | `03-bypass-rules.js` | Auth/cookie/no-cache/write traffic bypass cache; không object nào bị cache nhầm | Not `HIT`, `X-Upstream-Service` | Cơ bản | 3 |
| 04 | `cdn-04-query-normalization` | `04-query-normalization.js` | Tracking params không fragment cache; business params tạo key riêng | Canonical/tracking/business query sequence | Trung bình | 4 |
| 05 | `cdn-05-invalidation-ops` | `05-invalidation-ops.js` | Purge (exact), ban-url (all variants), ban-tag (surrogate key) invalidate đúng object | Warm `HIT` -> invalidate -> `MISS` | Trung bình | 5 |
| 06 | `cdn-06-invalidation-events` | `06-invalidation-events.js` | Catalog events (product-updated, homefeed-updated) invalidate qua internal handler | Event status + next public `MISS` | Trung bình | 6 |
| 07 | `cdn-07-cache-contract` | `07-cache-contract.js` | Cache contract headers đầy đủ và 304 revalidation | `Cache-Control`, `ETag`, `Surrogate-Key`, `Vary`, 304 response | Trung bình | 7 |
| 08 | `cdn-08-ttl-expiry` | `08-ttl-expiry.js` | Object `MISS -> HIT -> wait TTL -> MISS` | `X-Cache` before/after TTL wait | Trung bình | 8 |
| 09 | `cdn-09-stale-while-error` | `09-stale-while-error.js` | Serve stale object khi origin unhealthy sau TTL | `X-Cache-Stale=true`, `X-Cache-Backend-Healthy=false`, origin count = 1 | Nâng cao | 9 |
| 10 | `cdn-10-request-coalescing` | `10-request-coalescing.js` | Cold burst 12 requests collapse thành <= 2 origin hits | Follow-up `HIT`, origin count `<= 2` | Nâng cao | 10 |
| 11 | `cdn-11-negative-caching` | `11-negative-caching.js` | 404 được negative-cache trong TTL ngắn, origin count tăng đúng sau expiry | `404 MISS -> 404 HIT -> wait -> 404 MISS`, `X-Negative-Cache=true`, count `1 then 2` | Nâng cao | 11 |

### Chi tiết từng case

**Case 01 -- `cdn-01-hit-smoke`:** Case nền tảng. Setup ban product URL, request GET đầu tiên chứng minh `MISS` + `X-Upstream-Service: products-service`. Request thứ hai chứng minh `HIT`. Sau đó sustained traffic 4 VU trong 18s để xác nhận HIT ổn định. Đây là case "hello world" của CDN.

**Case 02 -- `cdn-02-variant-keys`:** Chứng minh 5 cache key dimensions hoạt động độc lập. Với mỗi variant (language khác, geo khác, device khác, AB khác), sequence phải là `base MISS -> base HIT -> variant MISS -> variant HIT`. Homefeed thêm `X-Cache-Key-Segment`. Giữ `VUs=1` -- tăng iterations nếu cần sample, không tăng VU vì concurrency làm nhiễu sequence.

**Case 03 -- `cdn-03-bypass-rules`:** Bốn pattern bypass: Authorization header, Cookie header, Cache-Control: no-cache, POST method. Tất cả phải NOT HIT (nghĩa là MISS hoặc trạng thái không cache). Đây là case bảo vệ data privacy.

**Case 04 -- `cdn-04-query-normalization`:** Search endpoint `?q=shoe` được warm. Sau đó request với tracking params (`?q=shoe&utm_source=lesson&fbclid=abc&gclid=paid`) phải HIT (chứng minh tracking params bị ignore). Request với business param (`?q=shoe&sort=price`) phải MISS riêng.

**Case 05 -- `cdn-05-invalidation-ops`:** Ba operation: purge (exact URL, exact variant), ban-url (all variants của URL), ban-tag (theo Surrogate-Key). Mỗi operation: warm HIT, gọi control operation, verify request tiếp theo MISS. Kiểm tra đúng object bị invalidate, object khác không bị ảnh hưởng.

**Case 06 -- `cdn-06-invalidation-events`:** POST event `product-updated` đến catalog-events mock. Handler nhận event, gọi internal app endpoint, app ban tag tương ứng. Verify: product detail, recommendations, search, homefeed bị invalidate (vì chúng share Surrogate-Key tag). POST `homefeed-updated` để test riêng homefeed invalidation.

**Case 07 -- `cdn-07-cache-contract`:** Verify origin trả về đầy đủ cache contract headers: `Cache-Control`, `CDN-Cache-Control`, `ETag`, `Last-Modified`, `Surrogate-Key`, `Vary`. Sau đó gửi conditional request với `If-None-Match` (dùng ETag từ response đầu) và verify `304 Not Modified`. Categories và homefeed cũng được kiểm tra cho `Surrogate-Key` + `Vary`.

**Case 08 -- `cdn-08-ttl-expiry`:** Ban homefeed URL, warm object (MISS -> HIT). Chờ `TTL_WAIT_SECONDS` (default 21s, homefeed TTL là 20s). Request tiếp theo phải MISS (object đã expired). Đây là case chứng minh TTL transition -- đơn giản nhưng cần chờ.

**Case 09 -- `cdn-09-stale-while-error`:** Setup object với TTL ngắn (2s). Sau khi object expired, force origin unhealthy qua control API (PATCH origin profile để trả 503). Chờ probe detect unhealthy. Request tiếp theo phải trả HIT với `X-Cache-Stale=true` và `X-Cache-Backend-Healthy=false`. Origin count cho key phải = 1 (chỉ fetch lần đầu). Sau đó restore origin, verify system recover.

**Case 10 -- `cdn-10-request-coalescing`:** Tạo cold key với origin delay 800ms. Gửi 12 request đồng thời đến cold key đó. Tất cả 12 request phải thành công (200), follow-up request HIT. Origin count cho key đó phải <= 2 (không phải 12). Đây là case chống stampede.

**Case 11 -- `cdn-11-negative-caching`:** Request một path không tồn tại. Response đầu: `404 MISS` với `X-Negative-Cache=true`. Request hai: `404 HIT` (từ cache). Chờ hết negative TTL (5s) + buffer (7s). Request ba: `404 MISS`. Origin count: 1 (trước TTL), 2 (sau TTL).

---

## Coverage matrix

Bảng này cho biết CDN capability nào được cover bởi case nào. Dùng để tra cứu nhanh khi bạn muốn kiểm tra một khía cạnh cụ thể.

| Capability | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Basic caching (MISS->HIT) | x | x | | | | | | x | x | x | x |
| Variant isolation | | x | | | | | | | | | |
| Auth/write bypass | | | x | | | | | | | | |
| Query normalization | | | | x | | | | | | | |
| Manual invalidation (purge) | | | | | x | | | | | | |
| Manual invalidation (ban-url) | x | x | | x | x | | | x | | | |
| Manual invalidation (ban-tag) | | | | | x | | | | | | |
| Event-driven invalidation | | | | | | x | | | | | |
| Cache contract headers | | | | | | | x | | | | |
| 304 revalidation | | | | | | | x | | | | |
| TTL expiry | | | | | | | | x | | | |
| Stale serving | | | | | | | | | x | | |
| Origin health control | | | | | | | | | x | | |
| Request coalescing | | | | | | | | | | x | |
| Negative caching | | | | | | | | | | | x |
| Origin count evidence | | | | | | | | | x | x | x |
| Multi-endpoint coverage | | | x | | x | x | x | x | | | |
| Control-plane auth | x | x | | x | x | | | x | x | x | x |

### Pattern coverage theo business pattern

| Business pattern | Case |
|---|---|
| Cacheable read (sản phẩm, danh sách) | 01 |
| Personalized read (variant cache key) | 02, 08 (homefeed) |
| Query-based read (search với params) | 04 |
| Write bypass (cart, mutation) | 03 |
| Manual invalidation (ops tooling) | 05 |
| Event-driven invalidation (catalog events) | 06 |
| Cache contract response (headers chuẩn) | 07 |
| TTL lifecycle (freshness window) | 08 |
| Stale serving (availability protection) | 09 |
| Request coalescing (origin protection) | 10 |
| Negative caching (error offload) | 11 |

---

## Shared helpers reference

Tất cả helper function nằm trong `shared.js`. Đây là bảng tham chiếu cho developer muốn hiểu hoặc mở rộng suite.

### Profiles (7 profiles định nghĩa sẵn)

| Profile name | Language | Geo | Device | AB | Segment | Cache key dimensions |
|---|---|---|---|---|---|---|
| `guestVNMobileControl` | `vi` | VN | mobile | control | guest | language+geo+device+ab |
| `guestVNMobileEnglish` | `en` | VN | mobile | control | guest | language khác biệt |
| `guestUSMobileControl` | `vi` | US | mobile | control | guest | geo khác biệt |
| `guestVNDesktopControl` | `vi` | VN | desktop | control | guest | device khác biệt |
| `guestVNMobileVariantA` | `vi` | VN | mobile | variant-a | guest | ab khác biệt |
| `returningVNMobileVariantA` | `vi` | VN | mobile | variant-a | returning | segment khác biệt |
| `guestUSDesktopControl` | `en` | US | desktop | control | guest | language+geo+device+ab khác biệt |

Mỗi profile có property `name` (human-readable) và `headers` (object để spread vào request).

### Request helpers

**`sendRequest(method, baseUrl, path, options)`:** Hàm nền tảng. Tự động build headers từ profile, thêm extra headers, xử lý body (JSON stringify). Hỗ trợ `responseCallback` cho expected status.

**`requestCdn(method, path, options)`:** Alias của `sendRequest` với `baseUrl = CDN_BASE_URL`. Dùng cho public edge path. Đây là hàm gọi nhiều nhất trong tất cả case.

**`controlRequest(method, path, payload, tags)`:** Request đến control plane (`:8088`). Tự động thêm `Authorization: Bearer <token>` và `X-Ops-Token`. Yêu cầu `OPS_AUTH_TOKEN` đã được set -- nếu không, `requireOpsToken()` sẽ gọi `fail()`.

**`buildHeaders(profile, extra)`:** Merge profile headers với extra headers, thêm `Accept: application/json`.

**`expectedCacheKey(profile)`:** Tính expected cache key dựa trên profile headers. Dùng cùng logic normalize như VCL: language lấy 2 ký tự, geo normalize về VN/US/SG/JP, device normalize về mobile/tablet/desktop, ab normalize về control/variant-a/variant-b, segment normalize về guest/new_user/returning/vip.

### Path builders

**`buildCachedPath(key, params)`:** Tạo path `/api/cached?key=<key>&ttl_seconds=N&origin_delay_ms=N`. Dùng cho các case cần custom TTL và delay (09, 10, health probe).

**`buildCachedMissingPath(key, params)`:** Tạo path `/api/cached/missing/<key>`. Dùng cho negative caching (case 11).

### Invalidation helpers

**`purgeUrl(url, profile)`:** Gửi PURGE request qua control plane. Nếu có profile, gửi kèm headers để purge đúng variant.

**`banUrl(url)`:** Gửi BAN request với `X-Ban-URL` header. Xóa tất cả variant của URL.

**`banPrefix(prefix)`:** Gửi BAN request với `X-Ban-Prefix` header. Xóa tất cả object có URL match prefix.

**`banTag(tag)`:** Gửi BAN request với `X-Ban-Tag` header. Xóa tất cả object có Surrogate-Key chứa tag.

### Catalog events helper

**`triggerCatalogEvent(path, payload)`:** POST event đến catalog-events mock (`:9091`). Dùng trong case 06 để gửi `product-updated` và `homefeed-updated` events.

### Origin profile management

**`getOriginProfile()`:** Đọc origin profile hiện tại qua control plane. Trả về `{ healthy: bool, status: int, ... }`.

**`setOriginProfile(patch)`:** PATCH origin profile để thay đổi behavior (ví dụ: force unhealthy với status 503). Dùng trong case 09.

**`resetOriginProfile()`:** Reset origin profile về default (healthy). Dùng để cleanup sau case 09.

**`waitOriginHealthy(options)`:** Poll origin profile và CDN health probe cho đến khi origin healthy trở lại. Configurable: `timeoutSeconds`, `intervalSeconds`, `stableSamples`. Dùng trong case 09 để chờ recovery.

### Origin request counter helpers

**`getOriginRequestCounts()`:** Lấy tất cả origin request counters. Trả về `{ data: { counts: [...] } }`.

**`resetOriginRequestCounts()`:** Reset tất cả counters về 0.

**`findOriginRequestCount(payload, requestKey)`:** Tìm count của một `requestKey` cụ thể trong payload từ `getOriginRequestCounts()`. Trả về `0` nếu không tìm thấy.

### Assertion helpers

**`cacheState(res)`:** Extract `X-Cache` header và uppercase. Trả về `"HIT"`, `"MISS"`, hoặc empty string.

**`getHeader(res, headerName)`:** Case-insensitive header lookup. An toàn khi response null hoặc không có headers.

**`assertStatus(res, expected, label)`:** Check `res.status === expected`.

**`assertCacheState(res, expected, label)`:** Check `X-Cache === expected`.

**`assertNotHit(res, label)`:** Check `X-Cache !== HIT`. Dùng trong case 03 (bypass).

**`assertUpstream(res, upstream, label)`:** Check `X-Upstream-Service === upstream`.

**`assertCacheKeyHeaders(res, expected, label, options)`:** Check từng `X-Cache-Key-*` header khớp với expected cache key. Options: `withDevice` (default true), `withAB` (default true), `withSegment` (default false -- chỉ true cho homefeed).

**`assertHeadersAbsent(res, headerNames, label)`:** Check các header KHÔNG xuất hiện.

**`assertHeaderPresent(res, headerName, label)`:** Check header CÓ xuất hiện.

**`assertHeaderContains(res, headerName, fragment, label)`:** Check header value chứa fragment.

**`assertHeaderEquals(res, headerName, expected, label)`:** Check header value bằng chính xác expected.

**`decodeJSON(res, label)`:** Parse JSON body. Gọi `fail()` nếu parse thất bại.

---

## Common invalid-result patterns

Bảng mở rộng các antipattern phổ biến, hậu quả, và cách khắc phục.

| Pattern | Vì sao nguy hiểm | Hậu quả nếu bỏ qua | Cách đọc đúng |
|---|---|---|---|
| Status 200 nhưng `X-Cache` sai | App trả OK nhưng CDN contract fail. Object có thể không được cache hoặc cache sai variant. | Data leak: user B nhận data của user A | Luôn kiểm tra HIT/MISS/BYPASS/stale sequence. Không bao giờ chỉ check status code. |
| Hit ratio cao nhưng variant leakage | Cache nhanh nhưng serve sai audience. Ví dụ: guest US nhận content tiếng Việt của guest VN. | Customer-facing bug: sai ngôn ngữ, sai giá, sai khuyến mãi | Kiểm tra `X-Cache-Key-*` và response variant. Case 02 dùng để phát hiện pattern này. |
| Purge/ban trả 200 nhưng next request vẫn `HIT` | Control plane báo thành công nhưng object vẫn trong cache. Có thể do sai token, sai path, hoặc VCL bug. | Content cũ vẫn được serve sau khi admin tưởng đã invalidate | Warm -> invalidate -> request lại phải `MISS`. Nếu vẫn HIT, kiểm tra token và path. |
| Expected 404 bị coi là fail | Negative caching dùng 404 làm expected business outcome. Nếu threshold `http_req_failed` được set cứng, case 11 sẽ bị false positive. | Bỏ sót negative caching bug; false alert trong monitoring | Case 11 pass bằng checks, headers (`X-Negative-Cache`), và origin counts. Đọc `http_req_failed` trong context. |
| Stale case pass vì status 200 | 200 có thể là origin mới (object re-fetched) hoặc stale. Nếu không check headers, bạn không biết stale có thực sự hoạt động không. | Tưởng CDN bảo vệ availability nhưng thực tế origin vẫn bị đánh khi unhealthy | Cần `X-Cache-Stale=true` + `X-Cache-Backend-Healthy=false` + origin count không tăng. |
| Coalescing: tất cả 200 nhưng origin count cao | User thấy OK nhưng origin bị stampede. 12 request -> 12 origin hits thay vì 1-2. | Origin quá tải khi cold burst; CDN không bảo vệ được origin | Case 10 phải chứng minh origin count `<= 2`. Không chỉ check status. |
| Chạy cases song song | Shared cache/control state làm nhiễu proof. Purge của case A có thể xóa object của case B. | Kết quả không reproducible; khó debug | Chạy tuần tự từng case. Reset origin counters giữa các run nếu cần. |
| Tăng VU cho case correctness (02) | Concurrent VU cùng purge/request cùng URL làm loạn sequence `base MISS -> base HIT -> variant MISS -> variant HIT` | Sequence không deterministic; test flaky | Case 02 giữ `VUs=1`. Tăng `VARIANT_KEYS_ITERATIONS` nếu cần sample. |
| Không đọc origin counter evidence | Claim "stale worked" hoặc "coalescing worked" chỉ dựa trên header nhưng không verify bằng counter | False confidence: header có thể đúng nhưng số lần gọi origin không khớp | Luôn dùng `getOriginRequestCounts()` làm evidence khách quan cho case 09/10/11. |
| Chạy với `TargetLayer=minimal` | Không có Varnish -> mọi request đều MISS -> mọi assertion về HIT fail | Toàn bộ suite fail không có lý do rõ ràng | Luôn khởi động với `-TargetLayer full`. Verify `X-Served-By: varnish` có trong response. |

---

## Suggested learning order with rationale

### Lộ trình chuẩn (cho mọi learner)

```text
GIAI ĐOẠN 1: NỀN TẢNG (case 01-04) — "Cache đúng hay chưa?"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. cdn-01-hit-smoke (~10 phút)
   Học: cold MISS -> HIT, sustained HIT, đọc X-Cache.
   Tại sao đầu tiên: Đây là "hello world" của CDN. Bạn cần hiểu MISS vs HIT
   trước khi học bất kỳ khái niệm nào khác.

2. cdn-02-variant-keys (~15 phút)
   Học: cache key dimensions, variant isolation, không leak variant.
   Tại sao thứ 2: Sau khi hiểu HIT/MISS, câu hỏi tiếp theo là "làm sao CDN
   phân biệt các audience khác nhau?" Case này trả lời câu hỏi đó.

3. cdn-03-bypass-rules (~10 phút)
   Học: auth/cookie/no-cache/write bypass.
   Tại sao thứ 3: Sau khi biết cái gì ĐƯỢC cache, bạn cần biết cái gì KHÔNG
   ĐƯỢC cache. Đây là case bảo vệ data privacy.

4. cdn-04-query-normalization (~10 phút)
   Học: tracking params bị ignore, business params tạo key riêng.
   Tại sao thứ 4: Sau khi hiểu cache key từ header, bạn cần hiểu cache key từ
   URL/query string. Case này hoàn thiện bức tranh về cache key construction.

GIAI ĐOẠN 2: INVALIDATION (case 05-06) — "Làm sao xóa cache?"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

5. cdn-05-invalidation-ops (~15 phút)
   Học: purge exact, ban-url (all variants), ban-tag (surrogate key).
   Tại sao thứ 5 trước 6: Manual invalidation là cơ chế cơ bản nhất.
   Bạn cần hiểu purge/ban hoạt động thế nào trước khi học event-driven.

6. cdn-06-invalidation-events (~15 phút)
   Học: event -> app internal handler -> CDN invalidation.
   Tại sao thứ 6: Đây là automated version của case 05. Sau khi hiểu manual
   ops, bạn học cách automation qua event bus.

GIAI ĐOẠN 3: CONTRACT & LIFECYCLE (case 07-08) — "Cache sống bao lâu?"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

7. cdn-07-cache-contract (~10 phút)
   Học: cache headers chuẩn, ETag, Last-Modified, 304 revalidation.
   Tại sao thứ 7: Sau khi biết cache và invalidate, bạn cần hiểu object
   metadata -- headers nào kiểm soát freshness, revalidation, tagging.

8. cdn-08-ttl-expiry (~25 phút, có sleep)
   Học: object hết TTL -> MISS.
   Tại sao thứ 8: Đây là case đơn giản nhất về vòng đời object. Chờ 21s
   là phần khó chịu duy nhất.

GIAI ĐOẠN 4: NÂNG CAO (case 09-11) — "CDN bảo vệ origin như thế nào?"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

9. cdn-09-stale-while-error (~30 phút, timing-dependent)
   Học: serve stale khi origin unhealthy, origin count evidence.
   Tại sao thứ 9: Case phức tạp nhất về timing -- cần chờ TTL, force unhealthy,
   chờ probe, verify stale, restore. Cần hiểu cả VCL, health probe, và control
   plane. Đây là case "availability protection."

10. cdn-10-request-coalescing (~20 phút, concurrency-dependent)
    Học: cold burst -> collapsed forwarding, origin count <= 2.
    Tại sao thứ 10: Case chứng minh CDN bảo vệ origin khỏi stampede. Cần
    concurrency và origin delay để tạo điều kiện test.

11. cdn-11-negative-caching (~20 phút, timing-dependent)
    Học: 404 được cache ngắn, origin count tăng đúng sau expiry.
    Tại sao cuối cùng: Case "bonus" -- không phải CDN nào cũng hỗ trợ
    negative caching. Nhưng đây là pattern quan trọng trong production.
```

### Lộ trình rút gọn (cho người đã có kinh nghiệm CDN)

```text
1. 01-hit-smoke (xác nhận setup đúng)
2. 02-variant-keys (cache key)
3. 05-invalidation-ops (invalidation cơ bản)
4. 09-stale-while-error (stale serving)
5. 10-request-coalescing (coalescing)
```

### Lộ trình cho developer (focus correctness)

```text
1. 01-hit-smoke
2. 02-variant-keys
3. 03-bypass-rules
4. 07-cache-contract
5. 04-query-normalization
```

### Lộ trình cho SRE/Ops (focus availability & operations)

```text
1. 01-hit-smoke
2. 05-invalidation-ops
3. 06-invalidation-events
4. 08-ttl-expiry
5. 09-stale-while-error
6. 10-request-coalescing
7. 11-negative-caching
```

### Tại sao không học theo thứ tự case number là đủ?

Case number phản ánh thứ tự development, không phải thứ tự học tối ưu:

- **02 trước 03:** Bạn cần hiểu variant isolation trước khi học bypass, vì bypass behavior có thể khác nhau tùy variant context.
- **05 trước 06:** Manual invalidation là foundation cho event-driven -- nếu không hiểu purge/ban hoạt động thế nào, bạn không thể debug event-driven invalidation.
- **08 trước 09:** Bạn cần hiểu TTL expiry cơ bản trước khi học stale serving, vì stale serving chỉ xảy ra SAU KHI object đã expired.
- **09/10/11 là advanced không chỉ vì độ khó, mà vì timing-dependent:** Các case này có sleep, concurrency requirement, và origin state manipulation -- dễ bị flaky nếu setup không chuẩn.

---

## How this series differs from executor series

Series CDN này khác executor series ở MỤC TIÊU, PHƯƠNG PHÁP, và TIÊU CHÍ PASS/FAIL.

### Bảng so sánh

| Khía cạnh | Executor series | CDN series |
|---|---|---|
| **Mục tiêu chính** | Chứng minh hệ thống chịu được traffic shape | Chứng minh CDN cache behavior đúng contract |
| **Câu hỏi trả lời** | "Hệ thống chịu X arrivals/s không?" | "Object này được cache chưa? Invalidate đúng chưa? Variant có leak không?" |
| **Metric chính** | `iterations`, `http_reqs`, `dropped_iterations`, `http_req_duration` | `X-Cache` sequence, `X-Cache-Key-*` headers, origin request counts |
| **Pattern kiểm tra** | Counters + timing thresholds | State sequences + header assertions + origin evidence |
| **Pass khi** | Thresholds met (dropped=0, latency < X, checks > Y%) | Cache contract met (sequence đúng, headers đúng, counters khớp) |
| **Fail khi** | Dropped iterations, high latency, failed checks | Status OK nhưng X-Cache sai, purge không hiệu quả, origin count không khớp |
| **Concurrency** | Thường cần nhiều VU để tạo load | Case correctness: 1 VU. Case coalescing: cần burst concurrency |
| **Timing dependency** | Thấp (chủ yếu quan tâm latency) | Cao (case 08/09/11 cần sleep và wait) |
| **State manipulation** | Không (chỉ tạo traffic) | Cần (purge object, force origin unhealthy, reset counters) |
| **Target layer** | `minimal` (chỉ app) | `full` (app + Varnish + Nginx) |
| **Evidence type** | Số liệu thống kê (mean, P95, rate) | Chuỗi trạng thái (MISS->HIT->...) + counters |

### Điểm tương đồng

```text
- Cả hai đều dùng k6 làm test engine
- Cả hai đều có shared helpers, case catalog, run guide, validation doc
- Cả hai đều chạy local với Docker target stack
- Cả hai đều có thể push metrics lên dashboard
```

### Tư duy chuyển tiếp từ executor sang CDN

Khi bạn đã quen với executor series, đây là mindset shift cần thiết:

```text
Executor mindset:               CDN mindset:
──────────────────────────       ──────────────────────────
"Bao nhiêu request?"             "Request nào HIT, request nào MISS?"
"Latency bao nhiêu ms?"          "Cache key của request này là gì?"
"Có bị drop không?"              "Object có bị invalidate chưa?"
"VU có đủ không?"                "Origin có bị gọi không?"
"Số lượng có đạt không?"         "Trạng thái có đúng sequence không?"
```

Nói ngắn gọn: **Executor series dạy bạn tạo áp lực. CDN series dạy bạn xác minh hệ thống phản ứng đúng với áp lực đó ở layer đầu tiên.**

---

## Reference

### Docs trong series này

- **Run guide:** `./RUN_GUIDE.md` -- Cách chạy từng case, env vars, dashboard checklist, troubleshooting
- **Validation + chart analysis:** `./12_validation-and-chart-analysis.md` -- Phân tích kết quả chạy thực tế với dashboard charts

### Source code & catalog

- **Source scripts:** `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\*.js`
- **Shared helpers:** `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js`
- **Case catalog:** `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json`
- **Source README:** `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\README.md`
- **Layer roadmap:** `E:\Projects\k6\k6-metrics-server\load-target\k6\layer-roadmap.md`

### VCL & infrastructure

- **Varnish VCL:** `E:\Projects\k6\k6-metrics-server\load-target\varnish\default.vcl`
- **Stack script:** `E:\Projects\k6\k6-metrics-server\load-target\scripts\stack.ps1`

### Executor series overviews (context)

- **Constant-arrival-rate:** `docs/practice/constant-arrival-rate/00_overview.md`
- **Ramping-arrival-rate:** `docs/practice/ramping-arrival-rate/00_overview.md`
- **Constant-vus:** `docs/practice/constant-vus/00_overview.md`
- **Ramping-vus:** `docs/practice/ramping-vus/00_overview.md`
- **Shared-iterations:** `docs/practice/shared-iterations/00_overview.md`
- **Per-vu-iterations:** `docs/practice/per-vu-iterations/00_overview.md`

### Quick-index docs (tham số/công thức)

- **VU lifecycle:** `docs/20260114_00_vu-lifecycle-and-iteration-counters.md`
- **Constant-VUS executor:** `docs/20260115_00_constant-vus-executor.md`
- **Options/defaults/shortcuts:** `docs/20260115_01_options-defaults-and-shortcuts.md`
- **Executor from simplest:** `docs/20260513_00_executor-from-simplest.md`
- **Per-VU iterations:** `docs/20260514_01_per-vu-iterations-quick-index.md`
- **Shared iterations:** `docs/20260515_01_shared-iterations-quick-index.md`
- **Constant arrival rate:** `docs/20260517_01_constant-arrival-rate-quick-index.md`
- **Ramping arrival rate:** `docs/20260518_01_ramping-arrival-rate-quick-index.md`

---

> **File này là INDEX và MAP cho toàn bộ CDN series.** Đọc kỹ trước khi làm bất kỳ case nào. Khi bạn gặp vấn đề trong một case cụ thể, quay lại đây để tra cứu concept, header, hoặc helper liên quan.
