# ms-02 -- Products service: read API contract

> **Case ID:** `ms-02-products-read-contract`
> **Script:** `../shared-iterations/si-01-catalog-audit.js`
> **Profile:** `full-no-cdn`
> **Workload:** shared-iterations, 8 VUs, 80 jobs
> **Proof:** Products service trả về đúng contract cho list và detail endpoints -- response envelope `{ success, data }`, tất cả product SKU đều reachable, sorting/pagination/facets hoạt động

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [Microservices capability được chứng minh](#2-microservices-capability-được-chứng-minh)
3. [Vì sao phải test ở Microservices layer](#3-vì-sao-phải-test-ở-microservices-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Products service API contract mechanism](#6-products-service-api-contract-mechanism)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / headers](#8-key-signals--headers)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output -> decision scenarios](#11-4-output---decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist trước khi chạy](#13-checklist-trước-khi-chạy)
14. [Variations với code mẫu](#14-variations-với-code-mẫu)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh nghiệp vụ

Sau deploy hoặc catalog sync, cần audit tất cả product SKU: kiểm tra list có trả về đủ sản phẩm với facets/sorting không, và detail có trả về đủ thông tin sản phẩm không. Products service là service đọc nhiều nhất trong toàn bộ hệ thống -- nó là primary origin cho CDN cache.

Hãy hình dung một nền tảng thương mại điện tử với 50,000 SKU. Mỗi ngày, team merchandising cập nhật giá, mô tả, hình ảnh cho hàng trăm sản phẩm qua hệ thống PIM (Product Information Management). Dữ liệu được đồng bộ sang products-service mỗi 15 phút. Sau mỗi lần sync, cần xác nhận:

- Tất cả sản phẩm đã sync đều xuất hiện trong danh sách (list endpoint)
- Mỗi sản phẩm có thể được truy xuất chi tiết (detail endpoint)
- Response tuân theo envelope chuẩn `{ success: true, data: ... }`
- Sorting, pagination, facets hoạt động qua query params
- Không có sản phẩm nào bị "mất tích" sau sync

```text
Catalog audit: mỗi job check 1 product -- list page chứa nó + detail page trả đúng
```

Nếu list endpoint trả về `success: false` hoặc `data` là null, toàn bộ storefront (trang chủ, danh mục, tìm kiếm) sẽ hiển thị lỗi -- đây là customer-facing failure nghiêm trọng nhất.

### 1.2 Tại sao products service quan trọng nhất trong 5 service

Products service không chỉ là service được gọi nhiều nhất -- nó còn là **primary origin cho CDN cache**. Điều này có nghĩa:

| Đặc điểm | Hệ quả |
| --- | --- |
| **Read volume cao nhất** | Chiếm ~53% tổng traffic trong production mix (theo case LB-05) |
| **CDN cache origin** | Mọi response từ products service đều có thể được Varnish cache. Nếu response sai, cache sẽ cache response sai và phục vụ cho hàng ngàn user sau đó |
| **Storefront dependency** | Trang chủ (homefeed), danh mục (categories), tìm kiếm (search), chi tiết sản phẩm (detail) -- tất cả đều phụ thuộc vào products service |
| **Downstream impact** | Nếu products service sai contract, cart service (cần product info để hiển thị giỏ hàng) và order service (cần product info cho order history) cũng bị ảnh hưởng |

Một lỗi contract trong products service có sức công phá lớn hơn bất kỳ service nào khác -- vì nó là entrypoint cho gần như mọi user journey.

### 1.3 Catalog audit pattern

Case này sử dụng **audit pattern**: thay vì gửi request ngẫu nhiên, mỗi job audit một product ID cụ thể. Pattern này khác với smoke test (ms-01) ở chỗ:

| Khía cạnh | Smoke test (ms-01) | Audit test (ms-02) |
| --- | --- | --- |
| **Mục tiêu** | Chứng minh routing đúng | Chứng minh contract đúng + data toàn vẹn |
| **Phạm vi** | 5 service, mỗi service vài request | 1 service (products), 80 jobs, mỗi job 2 calls |
| **Sample** | 20 request/service | 80 jobs x 2 calls = 160 API calls |
| **Data dependency** | Không quan tâm nội dung response | Kiểm tra `success=true`, `data` array/object populated |
| **Expected failure** | 0 (smoke -- fail là routing sai) | 0 (audit -- fail là data sai hoặc contract sai) |

Audit pattern đặc biệt phù hợp cho:
- **Post-deploy verification**: Sau khi deploy code mới, audit vài trăm SKU để đảm bảo không có regression
- **Post-sync verification**: Sau khi sync catalog từ PIM, audit sample SKU để đảm bảo data integrity
- **Periodic health check**: Chạy định kỳ mỗi giờ để phát hiện data degradation

### 1.4 Sáu endpoints của products service

Products service có 6 endpoints, mỗi endpoint phục vụ một use case khác nhau:

```text
GET /api/sim/products                 — list (có sort, filter, facets)
GET /api/sim/products/:id             — detail
GET /api/sim/products/search          — search (full-text)
GET /api/sim/products/categories      — category tree
GET /api/sim/products/homefeed        — personalized homefeed blocks
GET /api/sim/products/:id/recommendations — related products
```

Case này tập trung vào **list + detail** vì đó là 2 endpoint được gọi nhiều nhất và là CDN cache origin chính. Các endpoint khác được test trong executor suite cases (constant-vus storefront, constant-arrival-rate storefront RPS, v.v.).

#### Endpoint 1: List (`GET /api/sim/products`)

Đây là endpoint phức tạp nhất của products service. Query params:

| Param | Ví dụ | Ý nghĩa |
| --- | --- | --- |
| `limit` | `10` | Số lượng sản phẩm trả về mỗi trang |
| `sort` | `popular`, `price_asc`, `price_desc`, `newest` | Tiêu chí sắp xếp |
| `view` | `grid`, `list` | Chế độ hiển thị (grid có ảnh to, list có mô tả dài) |
| `include_facets` | `0`, `1` | Có bao gồm facet aggregations không (brand, price range, category) |
| `cpu_ms` | `2` | Mô phỏng CPU processing delay (ms) -- dùng trong test |
| `db_rows` | `4` | Mô phỏng số lượng database rows -- dùng trong test |
| `json_items` | `10` | Số lượng items trong response data array -- dùng trong test |

Response envelope:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Product Name",
      "price": 99.99,
      "thumbnail": "https://...",
      "rating": 4.5,
      "review_count": 128
    }
  ],
  "facets": {
    "brands": [...],
    "price_ranges": [...],
    "categories": [...]
  },
  "pagination": {
    "total": 500,
    "page": 1,
    "limit": 10
  }
}
```

#### Endpoint 2: Detail (`GET /api/sim/products/:id`)

Query params:

| Param | Ví dụ | Ý nghĩa |
| --- | --- | --- |
| `view` | `full`, `summary` | Mức độ chi tiết -- `full` trả về tất cả fields, `summary` chỉ trả về fields chính |
| `include_reviews` | `0`, `1` | Có bao gồm customer reviews không |
| `cpu_ms` | `2` | Mô phỏng CPU processing delay (ms) |
| `db_rows` | `2` | Mô phỏng số lượng database rows |

Response envelope:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Product Name",
    "description": "Full product description...",
    "price": 99.99,
    "original_price": 129.99,
    "discount_percent": 23,
    "images": ["https://...", "https://..."],
    "variants": [...],
    "specifications": {...},
    "rating": 4.5,
    "review_count": 128,
    "reviews": [...],
    "stock_status": "in_stock",
    "categories": [...],
    "related_ids": [2, 3, 5]
  }
}
```

### 1.5 Mối quan hệ với CDN caching

Products service là primary origin cho CDN cache. Điều này tạo ra một dependency chain:

```text
User -> CDN/Varnish -> (cache miss) -> Nginx -> products-service -> Postgres
                  |
                  +--> (cache hit) -> trả về cached response
```

Nếu products service trả về response sai contract (ví dụ: `success: false` hoặc thiếu field `data`), Varnish sẽ cache response sai đó. Tùy theo TTL configuration, response sai có thể được phục vụ cho hàng ngàn user trong nhiều phút trước khi cache expire hoặc bị purge.

Đây là lý do tại sao contract test cho products service phải được thực hiện **trước** khi bật CDN caching cho path `/api/sim/products`. Nếu contract chưa được verify, CDN cache sẽ khuếch đại lỗi lên hàng ngàn lần.

---

## 2. Microservices capability được chứng minh

### 2.1 Phát biểu capability

Case này chứng minh:

> **Products service trả về đúng API contract cho read path: list endpoint (có sorting, pagination, facets) và detail endpoint (có đầy đủ fields). Response envelope `{ success: true, data: ... }` nhất quán trên tất cả request. Mọi product SKU trong catalog đều có thể được truy xuất qua cả hai endpoint.**

Cụ thể hơn, case chứng minh 8 khả năng con:

1. **`GET /api/sim/products` trả về list với đúng envelope**: `{ success: true, data: [...] }` -- không có response nào có `success: false` hoặc `data` là null/undefined.

2. **`GET /api/sim/products/:id` trả về detail với đầy đủ fields**: `{ success: true, data: {...} }` -- `data` là object (không phải array), có các field cần thiết như `name`, `price`, `description`.

3. **Sorting hoạt động qua query params**: `sort=popular` trả về kết quả được sắp xếp đúng, không bị ignore.

4. **Pagination hoạt động**: `limit=10` trả về đúng số lượng items, response bao gồm `pagination` metadata.

5. **Facets hoạt động qua query params**: `include_facets=1` trả về facet aggregations (brands, price ranges, categories).

6. **Response header `X-Upstream-Service: products-service`**: Xác nhận request được route đúng đến products service (không phải fallback `app`).

7. **Service chịu được sustained read traffic**: 80 jobs x 2 calls = 160 API calls với 8 VUs đồng thời -- tất cả đều pass.

8. **Catalog audit toàn vẹn**: Tất cả 50 product ID (cycle 1-50) đều reachable qua cả list và detail. Không có sản phẩm nào bị "mất tích".

### 2.2 So sánh với ms-01 (Gateway routing smoke)

| Khía cạnh | ms-01 (Gateway routing) | ms-02 (Products read contract) |
| --- | --- | --- |
| **Phạm vi** | 5 service | 1 service (products) |
| **Độ sâu** | Rộng (5 service) nhưng nông (chỉ check status) | Hẹp (1 service) nhưng sâu (check status + envelope + data shape) |
| **Số API calls/job** | 1 call/job | 2 calls/job (list + detail) |
| **Sample size** | 20 jobs/service | 80 jobs (160 calls) |
| **Evidence** | `X-Upstream-Service` header | `X-Upstream-Service` + response body shape |
| **Mục tiêu** | "Route có đúng không?" | "Contract có đúng không?" |

ms-01 là prerequisite cho ms-02 -- nếu routing sai, contract test có thể pass hoặc fail vì lý do sai. ms-02 đi sâu vào nội dung response, không chỉ dừng ở status code.

---

## 3. Vì sao phải test ở Microservices layer

### 3.1 Read contract là nền tảng cho mọi thứ khác

```text
Nếu products list trả sai envelope -> CDN cache sẽ cache response sai
Nếu detail thiếu field -> homefeed và recommendations cũng sẽ sai
Nếu search trả về 0 results -> user không tìm thấy sản phẩm
```

Contract test cho read path là baseline rẻ nhất trong toàn bộ test suite. Nó không yêu cầu setup phức tạp (không cần authentication, không cần state, không cần cleanup). Một request GET đơn giản có thể phát hiện:

- Service không chạy (connection refused)
- Service chạy nhưng response sai format (success=false)
- Service chạy nhưng data rỗng (data=[])
- Service chạy nhưng thiếu field (data thiếu price)

Nếu contract test fail, đừng test gì khác cho đến khi fix xong. Mọi test khác (cart write, order transaction, stateful flow) đều phụ thuộc vào products service đọc đúng.

### 3.2 Đây không phải là vấn đề của CDN layer

CDN layer (cases 01-12) test xem response có được cache không, TTL có đúng không, stale-while-error có hoạt động không. Nhưng CDN không quan tâm đến nội dung response -- CDN cache bất cứ thứ gì origin trả về.

Nếu origin (products service) trả về response sai contract, CDN sẽ cache response sai đó và phục vụ cho user. CDN test không thể phát hiện lỗi contract -- nó chỉ có thể phát hiện lỗi caching behavior.

### 3.3 Đây không phải là vấn đề của Redis layer

Redis layer test idempotency và shared state trong order service. Products service là read-only -- nó không dùng Redis. Contract test cho products service không liên quan gì đến Redis.

Tuy nhiên, nếu products service contract sai, các Redis test vẫn có thể bị ảnh hưởng gián tiếp: order confirm cần đọc product info để validate đơn hàng, và nếu product info sai, order có thể bị reject với lý do sai.

### 3.4 Tại sao phải test 2 endpoints (list + detail) trong cùng một job

Mỗi job trong case này gọi cả list và detail cho cùng một product ID:

```javascript
const list = requestJson('GET', `${BASE_URL}/api/sim/products?limit=10&...`, ...);
const detail = requestJson('GET', `${BASE_URL}/api/sim/products/${job.productId}?view=full&...`, ...);
```

Thiết kế này có chủ đích:

| Lý do | Giải thích |
| --- | --- |
| **Cross-reference** | Product xuất hiện trong list phải có detail khớp -- nếu list có product ID=42 nhưng detail trả về 404, có vấn đề về data consistency |
| **Correlation detection** | Nếu list trả về success=true nhưng detail trả về success=false cho cùng một product, đó là bug code path riêng của detail endpoint |
| **Performance comparison** | List (nặng hơn vì `json_items=10`) vs detail (nhẹ hơn vì `db_rows=2`) -- so sánh latency giữa 2 endpoint |
| **Efficiency** | 80 jobs x 2 calls = 160 API calls, nhưng chỉ cần 80 iterations -- tiết kiệm thời gian test |

---

## 4. Topology và precondition

### 4.1 Topology

```text
k6 (8 VUs, shared-iterations, 80 jobs)
  |
  | Mỗi job gọi 2 API calls:
  |   1. GET /api/sim/products?limit=10&sort=popular&view=grid&include_facets=1&cpu_ms=2&db_rows=4&json_items=10
  |   2. GET /api/sim/products/{productId}?view=full&include_reviews=1&cpu_ms=2&db_rows=2
  v
Nginx :80 (API Gateway)
  |
  | /api/sim/products -> location /api/sim/products -> upstream products_service
  v
products-service:8084
  |
  | Query Postgres (simulated via db_rows param)
  | Trả về response với envelope { success, data }
  v
Response -> Nginx thêm X-Upstream-Service: products-service -> k6
```

### 4.2 Precondition

Trước khi chạy case này, các điều kiện sau phải được đáp ứng:

```powershell
# 1. ms-01 (Gateway routing smoke) đã PASS
#    -> Xác nhận Nginx route /api/sim/products đến đúng products-service

# 2. Stack đã được start với đúng topology
./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2

# 3. Biến môi trường BASE_URL trỏ đến Nginx public port
$env:BASE_URL = "http://localhost:80"

# 4. Xác nhận products-service đang chạy và có dữ liệu
curl -s http://localhost:80/api/sim/products?limit=1
# Kỳ vọng: 200 + JSON với success=true + data array có ít nhất 1 item

# 5. Xác nhận X-Upstream-Service
curl -s -I http://localhost:80/api/sim/products | findstr "X-Upstream-Service"
# Kỳ vọng: X-Upstream-Service: products-service

# 6. Xác nhận detail endpoint hoạt động
curl -s http://localhost:80/api/sim/products/1?view=full
# Kỳ vọng: 200 + JSON với success=true + data là object
```

### 4.3 Environment variables

| Biến | Default | Mô tả |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:80` | Public URL của Nginx API Gateway |
| `SI_01_VUS` | `8` | Số lượng Virtual Users trong worker pool |
| `SI_01_JOBS` | `80` | Tổng số job trong batch (iterations) |
| `SI_01_SLEEP_SECONDS` | `0` | Thời gian nghỉ giữa các job (mặc định 0) |

### 4.4 Lưu ý về topology

Case này dùng `full-no-cdn` giống như ms-01. Không dùng `full` (có CDN) vì:
- Varnish cache có thể cache response từ lần request trước
- `X-Cache: HIT` nghĩa là response đến từ cache, không phải từ products service
- Không thể verify contract mới nhất nếu response bị cache

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `si-01-catalog-audit.js` gồm 82 dòng, được tổ chức thành 4 phần chính:

```javascript
// (A) IMPORTS: 11 dòng
import {
  BASE_URL, buildJobs, buildSharedScenario, currentJob,
  envFloat, envInt, finishJob, requestJson, think,
} from './common.js';

// (B) CONFIGURATION: 3 dòng
const CASE_ID = 'si-01-catalog-audit';
const VUS = envInt('SI_01_VUS', 8);
const JOBS = envInt('SI_01_JOBS', 80);
const SLEEP_SECONDS = envFloat('SI_01_SLEEP_SECONDS', 0);

// (C) OPTIONS + SETUP: 20 dòng
export const options = { ... };
export function setup() { ... }

// (D) EXEC FUNCTION: 40 dòng
export function catalogAudit(data) { ... }
```

### 5.2 Phân tích từng dòng -- Phần A: Imports

```javascript
import {
  BASE_URL,
  buildJobs,
  buildSharedScenario,
  currentJob,
  envFloat,
  envInt,
  finishJob,
  requestJson,
  think,
} from './common.js';
```

Cùng bộ imports như ms-01 -- tất cả shared-iterations scripts dùng chung `common.js`. Điều này đảm bảo consistency về cách gửi request, check status, ghi nhận metrics.

### 5.3 Phân tích từng dòng -- Phần B: Configuration

```javascript
const CASE_ID = 'si-01-catalog-audit';
```

`CASE_ID` được dùng làm tag `case_id` trong tất cả metrics. Phân biệt với `si-07-ci-verification-batch` (ms-01) và các case khác.

```javascript
const VUS = envInt('SI_01_VUS', 8);
```

Tại sao 8 VUs (không phải 10 như ms-01)?
- 80 jobs x 2 calls = 160 API calls -- nhiều hơn ms-01 (100 calls)
- Nhưng mỗi call nhẹ hơn (chỉ GET, không POST body)
- 8 VUs đủ để xử lý 80 jobs trong vài giây
- Có thể tăng lên nếu cần stress test

```javascript
const JOBS = envInt('SI_01_JOBS', 80);
```

80 jobs, mỗi job audit 1 product ID (cycle 1-50). Với 80 jobs:
- Mỗi product ID được audit ít nhất 1 lần (80/50 = 1.6, trung bình 1.6 lần/product)
- 50 product đầu tiên được audit 2 lần, 30 product sau được audit 1 lần
- Sample size đủ để phát hiện intermittent issue (nếu một product fail 1/2 lần)

```javascript
const SLEEP_SECONDS = envFloat('SI_01_SLEEP_SECONDS', 0);
```

Mặc định 0 -- audit càng nhanh càng tốt.

### 5.4 Phân tích từng dòng -- Phần C: Options và Scenarios

```javascript
export const options = {
  scenarios: {
    catalog_audit: buildSharedScenario('catalogAudit', VUS, JOBS, '8m', {
      case_id: CASE_ID,
      business_case: 'product_catalog_audit',
    }),
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    shared_jobs_total: [`count==${JOBS}`],
    shared_jobs_failed: ['count==0'],
  },
};
```

#### Phân tích `buildSharedScenario`

```javascript
buildSharedScenario('catalogAudit', 8, 80, '8m', {
  case_id: 'si-01-catalog-audit',
  business_case: 'product_catalog_audit',
})
```

Tạo ra:
```javascript
{
  executor: 'shared-iterations',
  exec: 'catalogAudit',
  vus: 8,
  iterations: 80,
  maxDuration: '8m',
  tags: {
    executor_family: 'shared_iterations',
    workload_shape: 'fixed_backlog',
    case_id: 'si-01-catalog-audit',
    business_case: 'product_catalog_audit',
  },
}
```

**Tại sao `maxDuration` là `'8m'` (8 phút)?**

80 jobs x 2 API calls = 160 HTTP requests. Với 8 VUs và không sleep, thời gian thực tế khoảng vài giây. `maxDuration: '8m'` là generous safety net -- nếu test kéo dài hơn 8 phút, có điều gì đó sai nghiêm trọng (products service treo, database query timeout, v.v.).

#### Phân tích thresholds

```javascript
thresholds: {
  checks: ['rate==1'],                            // (a)
  http_req_failed: ['rate==0'],                   // (b)
  shared_jobs_total: [`count==${JOBS}`],           // (c)
  shared_jobs_failed: ['count==0'],                // (d)
},
```

**(a) `checks: ['rate==1']`** -- 100% checks pass. Với 2 API calls/job, mỗi call tạo 1 check (status code) = 160 checks total. Tất cả phải pass.

**(b) `http_req_failed: ['rate==0']`** -- Không có HTTP failure. Khác với `shared_jobs_failed` (job fail = ít nhất 1 call fail), `http_req_failed` đo tỉ lệ request HTTP thất bại ở tầng transport (connection refused, timeout, DNS).

**(c) `shared_jobs_total: ['count==80']`** -- Tất cả 80 jobs phải được xử lý.

**(d) `shared_jobs_failed: ['count==0']`** -- Không job nào fail. Một job fail nếu `ok = false` -- nghĩa là ít nhất 1 trong 2 API calls trả về sai status.

#### Tại sao dùng `shared-iterations` cho catalog audit?

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **shared-iterations** (đang dùng) | **DUNG** | 80 jobs cố định (mỗi job = 1 product audit). Worker pool 8 VUs pick job. Mỗi job độc lập. Batch processing pattern. |
| constant-vus | SAI | Loop vô hạn -- không biết khi nào đủ 80 jobs |
| constant-arrival-rate | SAI | Ép rate -- audit không cần rate cố định |
| per-vu-iterations | SAI | Phân phối đều iteration/VU -- không linh hoạt như shared pool |

**Key insight**: Catalog audit là batch processing problem. Có N sản phẩm cần audit (N=80 jobs), mỗi sản phẩm cần 2 API calls. Worker pool xử lý càng nhanh càng tốt. `shared-iterations` là executor tự nhiên cho pattern này.

### 5.5 Phân tích từng dòng -- Phần D: Setup function

```javascript
export function setup() {
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `catalog-audit-${index + 1}`,
      productId: (index % 50) + 1,
    })),
  };
}
```

#### Cấu trúc job đơn giản

Mỗi job chỉ có 2 fields:
- `id`: `catalog-audit-1`, `catalog-audit-2`, ..., `catalog-audit-80`
- `productId`: 1-50, cycle mỗi 50 jobs

Job đơn giản hơn ms-01 vì:
- Không cần `type` field -- tất cả job đều làm cùng một việc (audit list + detail)
- Không cần `orderId` hay `idemKey` -- products service là read-only, không cần idempotency
- Chỉ cần `productId` -- xác định sản phẩm nào được audit

#### Tại sao productId cycle 1-50?

```javascript
productId: (index % 50) + 1,
```

- 50 product IDs đại diện cho catalog size vừa phải
- Cycle nghĩa là mỗi product được audit ít nhất 1 lần, một số được audit 2 lần
- Đủ đa dạng để test rằng service xử lý được nhiều ID khác nhau
- Dễ dàng tăng lên 200 để audit catalog lớn hơn

### 5.6 Phân tích từng dòng -- Phần E: Exec function

```javascript
export function catalogAudit(data) {
  const started = Date.now();
  const job = currentJob(data);
  let ok = true;

  const list = requestJson(
    'GET',
    `${BASE_URL}/api/sim/products?limit=10&sort=popular&view=grid&include_facets=1&cpu_ms=2&db_rows=4&json_items=10`,
    null,
    {
      caseId: CASE_ID,
      service: 'products-service',
      operation: 'catalog_list_audit',
      endpoint: 'GET /api/sim/products',
      jobId: job.id,
    },
  );
  ok = ok && list.ok;

  const detail = requestJson(
    'GET',
    `${BASE_URL}/api/sim/products/${job.productId}?view=full&include_reviews=1&cpu_ms=2&db_rows=2`,
    null,
    {
      caseId: CASE_ID,
      service: 'products-service',
      operation: 'catalog_detail_audit',
      endpoint: 'GET /api/sim/products/:id',
      jobId: job.id,
    },
  );
  ok = ok && detail.ok;

  finishJob(started, ok, {
    caseId: CASE_ID,
    service: 'products-service',
    operation: 'catalog_audit_job',
    jobId: job.id,
  });
  think(SLEEP_SECONDS, { caseId: CASE_ID, operation: 'worker_pause' });
}
```

#### Phân tích call 1: List audit

```javascript
const list = requestJson(
  'GET',
  `${BASE_URL}/api/sim/products?limit=10&sort=popular&view=grid&include_facets=1&cpu_ms=2&db_rows=4&json_items=10`,
  null,
  {
    caseId: CASE_ID,
    service: 'products-service',
    operation: 'catalog_list_audit',
    endpoint: 'GET /api/sim/products',
    jobId: job.id,
  },
);
```

Phân tích query params:

| Param | Giá trị | Ý nghĩa trong test |
| --- | --- | --- |
| `limit` | `10` | Mỗi trang 10 sản phẩm -- đủ để chứa product đang audit (nếu product ID trong top 10 của sort) |
| `sort` | `popular` | Sắp xếp theo độ phổ biến -- test rằng sort param được tôn trọng |
| `view` | `grid` | Grid view -- test rằng view mode ảnh hưởng đến response fields |
| `include_facets` | `1` | Bao gồm facets -- test rằng facet aggregation hoạt động |
| `cpu_ms` | `2` | Mô phỏng 2ms CPU delay -- realistic processing time |
| `db_rows` | `4` | Mô phỏng 4 database rows -- query scan 4 rows |
| `json_items` | `10` | Response chứa 10 items -- mô phỏng response size thực tế |

Tags:
- `service: 'products-service'` -- tất cả request đến cùng một service
- `operation: 'catalog_list_audit'` -- phân biệt list vs detail trong metrics
- `endpoint: 'GET /api/sim/products'` -- URL pattern không có dynamic segment
- `jobId: job.id` -- trace ngược về job

#### Phân tích call 2: Detail audit

```javascript
const detail = requestJson(
  'GET',
  `${BASE_URL}/api/sim/products/${job.productId}?view=full&include_reviews=1&cpu_ms=2&db_rows=2`,
  null,
  {
    caseId: CASE_ID,
    service: 'products-service',
    operation: 'catalog_detail_audit',
    endpoint: 'GET /api/sim/products/:id',
    jobId: job.id,
  },
);
```

Phân tích query params:

| Param | Giá trị | Ý nghĩa trong test |
| --- | --- | --- |
| `view` | `full` | Full detail view -- trả về tất cả fields của sản phẩm |
| `include_reviews` | `1` | Bao gồm customer reviews -- test rằng review data được join đúng |
| `cpu_ms` | `2` | Mô phỏng 2ms CPU delay |
| `db_rows` | `2` | Mô phỏng 2 database rows (product + reviews join) |

Tags:
- `service: 'products-service'` -- cùng service
- `operation: 'catalog_detail_audit'` -- phân biệt với list
- `endpoint: 'GET /api/sim/products/:id'` -- URL pattern với `:id` placeholder

#### Aggregation logic

```javascript
let ok = true;
ok = ok && list.ok;     // ok = list.ok
ok = ok && detail.ok;   // ok = list.ok && detail.ok
```

Dùng short-circuit AND: nếu list fail, `ok = false`, và detail vẫn được gọi (vì không có `if (ok)` bảo vệ). Điều này quan trọng -- ta muốn biết cả list VÀ detail có fail không, không dừng sớm.

#### finishJob với service tag

```javascript
finishJob(started, ok, {
  caseId: CASE_ID,
  service: 'products-service',
  operation: 'catalog_audit_job',
  jobId: job.id,
});
```

Khác với ms-01 (dùng `service: 'mixed-services'`), case này dùng `service: 'products-service'` vì tất cả request đến cùng một service. Điều này giúp dashboard group tất cả jobs của case này dưới cùng một service label.

### 5.7 Tại sao script không check response body?

Script hiện tại **không** parse JSON body và không check `success` field hay `data` structure. Check duy nhất là status code (200). Tại sao?

1. **Minimal smoke test**: Case này được thiết kế như smoke test cho contract -- status 200 là proxy đủ tốt cho "contract đúng" trong CI/CD pipeline nhanh.

2. **Body parsing overhead**: `response.json()` trong k6 parse toàn bộ JSON body, tốn CPU và memory. Với 160 API calls, tổng overhead có thể đáng kể.

3. **Separation of concerns**: Verification body shape kỹ lưỡng hơn được thực hiện trong Variation 2 (thêm body check) hoặc trong ms-06 (stateful flow test đầy đủ hơn).

4. **Trust in server-side validation**: Products service được thiết kế để trả về 200 chỉ khi success=true. Status code là contract-level signal.

Tuy nhiên, để chắc chắn 100%, nên thêm body check (xem Variation 2).

### 5.8 Custom metrics

Case này dùng chung custom metrics từ `common.js` (giống ms-01):

| Metric | Expected value | Ý nghĩa trong case này |
| --- | --- | --- |
| `shared_jobs_total` | `count == 80` | 80 catalog audit jobs đã hoàn thành |
| `shared_jobs_failed` | `count == 0` | Không có job nào fail (cả list và detail đều pass) |
| `shared_job_duration_ms` | avg ~ 30-50ms | Thời gian audit 1 product (2 API calls + overhead) |
| `shared_api_calls_total` | `count == 160` | 80 jobs x 2 calls = 160 API calls |
| `shared_sleep_seconds` | `count == 0` | Không sleep (SLEEP_SECONDS=0) |

---

## 6. Products service API contract mechanism

### 6.1 Response envelope `{ success, data }`

Tất cả response từ products service tuân theo envelope chuẩn:

```json
{
  "success": true,
  "data": "..."
}
```

Đây là pattern phổ biến trong microservices:
- `success: true/false` -- boolean cho biết request có thành công không
- `data` -- payload thực tế (có thể là array, object, hoặc null nếu success=false)
- Không có `error` field khi success=true; khi success=false, có thêm `error` object với `code` và `message`

**Tại sao dùng envelope thay vì trả trực tiếp data?**

| Lý do | Giải thích |
| --- | --- |
| **Consistency** | Mọi response có cùng structure -- client code chỉ cần check `success` trước khi đọc `data` |
| **Error handling** | Khi `success=false`, `data` có thể là null, và `error` object cung cấp thông tin lỗi |
| **Gateway compatibility** | API Gateway (Nginx) có thể log/alert dựa trên `success` field mà không cần parse business-specific structure |
| **Versioning** | Có thể thêm fields mới vào envelope (vd: `meta`, `pagination`) mà không break client cũ |

### 6.2 List endpoint contract

```
GET /api/sim/products?limit=10&sort=popular&view=grid&include_facets=1&cpu_ms=2&db_rows=4&json_items=10
```

Request:
- Method: `GET`
- No request body
- Query params tùy chọn (limit, sort, view, include_facets, và các simulation params)

Expected response (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Product 1",
      "price": 29.99,
      "thumbnail": "/images/product-1.jpg",
      "rating": 4.2,
      "review_count": 56
    }
    // ... 9 more items (json_items=10)
  ],
  "pagination": {
    "total": 500,
    "page": 1,
    "limit": 10,
    "total_pages": 50
  },
  "facets": {
    "brands": [
      { "name": "Brand A", "count": 120 },
      { "name": "Brand B", "count": 85 }
    ],
    "price_ranges": [
      { "min": 0, "max": 25, "count": 150 },
      { "min": 25, "max": 50, "count": 200 }
    ],
    "categories": [
      { "id": 1, "name": "Category 1", "count": 300 }
    ]
  }
}
```

Contract rules cho list endpoint:
1. `success` phải là `true`
2. `data` phải là array
3. `data` array phải có ít nhất 1 item (không empty trừ khi catalog thực sự rỗng)
4. Mỗi item trong `data` phải có ít nhất `id`, `name`, `price`
5. `pagination` object phải có `total`, `page`, `limit`
6. Nếu `include_facets=1`, response phải có `facets` object
7. `X-Upstream-Service` header phải là `products-service`

### 6.3 Detail endpoint contract

```
GET /api/sim/products/{productId}?view=full&include_reviews=1&cpu_ms=2&db_rows=2
```

Request:
- Method: `GET`
- Path parameter: `productId` (integer, 1-based)
- Query params: view, include_reviews, và simulation params

Expected response (200 OK):
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Product 1",
    "description": "Full product description with HTML...",
    "price": 29.99,
    "original_price": 39.99,
    "discount_percent": 25,
    "images": [
      "https://cdn.example.com/products/1/main.jpg",
      "https://cdn.example.com/products/1/alt.jpg"
    ],
    "thumbnail": "/images/product-1.jpg",
    "rating": 4.2,
    "review_count": 56,
    "reviews": [
      {
        "id": 101,
        "user": "user_1",
        "rating": 5,
        "comment": "Great product!",
        "created_at": "2024-01-15T10:30:00Z"
      }
    ],
    "specifications": {
      "weight": "1.5 kg",
      "dimensions": "30 x 20 x 10 cm",
      "material": "Aluminum"
    },
    "variants": [
      { "sku": "SKU-1-BLUE", "color": "Blue", "price": 29.99, "stock": 50 },
      { "sku": "SKU-1-RED", "color": "Red", "price": 29.99, "stock": 30 }
    ],
    "stock_status": "in_stock",
    "categories": [
      { "id": 1, "name": "Category 1" },
      { "id": 3, "name": "Category 3" }
    ],
    "related_ids": [2, 5, 8]
  }
}
```

Contract rules cho detail endpoint:
1. `success` phải là `true`
2. `data` phải là object (không phải array)
3. `data.id` phải khớp với `productId` trong request path
4. `data` phải có ít nhất `id`, `name`, `description`, `price`
5. Nếu `include_reviews=1`, `data.reviews` phải là array
6. Nếu `view=full`, tất cả fields phải có mặt
7. `X-Upstream-Service` header phải là `products-service`

### 6.4 Simulation params và realistic behavior

Products service sử dụng simulation params để mô phỏng behavior thực tế:

| Param | Mô phỏng | Production equivalent |
| --- | --- | --- |
| `cpu_ms=2` | 2ms CPU processing | Thời gian xử lý business logic (transform, format, aggregate) |
| `db_rows=4` | Query scan 4 rows | Database query trả về 4 rows (có thể là 4 sản phẩm trong list) |
| `db_writes=1` | 1 database write (chỉ cho POST/PATCH) | Insert/update order, cart |
| `json_items=10` | Response chứa 10 items | List page trả về 10 sản phẩm |
| `gzip_kb=1` | Response được nén gzip 1KB | Realistic response size với gzip compression |

Các params này không ảnh hưởng đến business logic -- chúng chỉ thêm delay và data size để test realistic performance.

### 6.5 Relationship với các endpoint khác

Mặc dù case này chỉ test list + detail, 4 endpoint còn lại có mối quan hệ chặt chẽ:

```text
list (GET /products)
  |
  +-- user click vào sản phẩm -> detail (GET /products/:id)
  |     |
  |     +-- xem sản phẩm liên quan -> recommendations (GET /products/:id/recommendations)
  |
  +-- user gõ tìm kiếm -> search (GET /products/search?q=...)
  |
  +-- user duyệt danh mục -> categories (GET /products/categories)
  
  +-- user vào trang chủ -> homefeed (GET /products/homefeed)
```

Tất cả các path trên đều bắt đầu từ list hoặc detail. Nếu 2 endpoint này sai contract, 4 endpoint còn lại cũng có khả năng sai (vì dùng chung data layer và response format).

---

## 7. Request sequence flow

### 7.1 Timeline của một catalog audit job

```text
Time (ms)  |  Step
-----------|-------------------------------------------------------
0          |  VU pick job từ shared pool (data.jobs[iterationInTest])
0          |  currentJob(data) -> job = { id, productId }
0          |  ok = true
0.1        |  requestJson('GET', '/api/sim/products?limit=10&...') -> list call
0.1-10     |  Nginx parse URL, match location /api/sim/products
1-15       |  products-service: query catalog, apply sort/facets, build response
10-25      |  Nginx nhận response, thêm X-Upstream-Service, trả về k6
25         |  k6 nhận list response
25-26      |  requestJson check: status == 200 -> list.ok = true/false
26         |  ok = true && list.ok
26.1       |  requestJson('GET', '/api/sim/products/{productId}?view=full&...') -> detail call
26.1-36    |  Nginx parse URL, match location /api/sim/products
27-40      |  products-service: query product by ID, join reviews, build response
36-50      |  Nginx nhận response, thêm X-Upstream-Service, trả về k6
50         |  k6 nhận detail response
50-51      |  requestJson check: status == 200 -> detail.ok = true/false
51         |  ok = ok && detail.ok
51         |  finishJob(started, ok, tags) -> increment counters
51         |  think(0) -> no-op
51         |  Worker quay lại pool, pick job tiếp theo
```

### 7.2 Sequence diagram: list call

```text
CLIENT (k6 VU)                  NGINX                       PRODUCTS-SERVICE
    |                             |                              |
    |-- GET /api/sim/products -> |                              |
    |   ?limit=10&sort=popular   |                              |
    |   &view=grid               |                              |
    |   &include_facets=1        |                              |
    |   &cpu_ms=2&db_rows=4      |                              |
    |   &json_items=10           |                              |
    |                             |                              |
    |                             |-- parse URL: /api/sim/products
    |                             |-- match location:            |
    |                             |   /api/sim/products          |
    |                             |   -> products_service        |
    |                             |                              |
    |                             |-- GET /api/sim/products ---> |
    |                             |   X-Upstream-Service:        |
    |                             |     products-service         |
    |                             |                              |
    |                             |         (xử lý: query DB,    |
    |                             |          sort by popular,    |
    |                             |          build facets,       |
    |                             |          format response)    |
    |                             |                              |
    |                             |<-- 200 OK ------------------ |
    |                             |   { success, data,           |
    |                             |     pagination, facets }     |
    |                             |                              |
    |                             |-- thêm:                      |
    |                             |   X-Upstream-Service:        |
    |                             |     products-service         |
    |                             |                              |
    |<-- 200 OK ----------------- |                              |
    |   X-Upstream-Service:      |                              |
    |     products-service       |                              |
    |   Body: { success, data }  |                              |
    |                             |                              |
    |-- check: "catalog_list_audit status 200" ✓                  |
```

### 7.3 Sequence diagram: detail call

```text
CLIENT (k6 VU)                  NGINX                       PRODUCTS-SERVICE
    |                             |                              |
    |-- GET /api/sim/products/5->|                              |
    |   ?view=full               |                              |
    |   &include_reviews=1       |                              |
    |   &cpu_ms=2&db_rows=2      |                              |
    |                             |                              |
    |                             |-- parse URL:                 |
    |                             |   /api/sim/products/5        |
    |                             |-- match location:            |
    |                             |   /api/sim/products (prefix) |
    |                             |   -> products_service        |
    |                             |                              |
    |                             |-- GET /api/sim/products/5 -> |
    |                             |   X-Upstream-Service:        |
    |                             |     products-service         |
    |                             |                              |
    |                             |         (xử lý: query        |
    |                             |          product ID=5,       |
    |                             |          join reviews,       |
    |                             |          format response)    |
    |                             |                              |
    |                             |<-- 200 OK ------------------ |
    |                             |   { success, data: {...} }   |
    |                             |                              |
    |<-- 200 OK ----------------- |                              |
    |   X-Upstream-Service:      |                              |
    |     products-service       |                              |
    |   Body: { success, data }  |                              |
    |                             |                              |
    |-- check: "catalog_detail_audit status 200" ✓                |
```

### 7.4 Concurrency model

```text
80 jobs, 8 VUs, mỗi job 2 sequential API calls:

VU-1: |--job-1 (list->detail)--|--job-9 (list->detail)--|--job-17--|...
VU-2: |--job-2 (list->detail)--|--job-10 (list->detail)-|--job-18--|...
VU-3: |--job-3 (list->detail)--|--job-11 (list->detail)-|--job-19--|...
VU-4: |--job-4 (list->detail)--|--job-12 (list->detail)-|--job-20--|...
VU-5: |--job-5 (list->detail)--|--job-13 (list->detail)-|--job-21--|...
VU-6: |--job-6 (list->detail)--|--job-14 (list->detail)-|--job-22--|...
VU-7: |--job-7 (list->detail)--|--job-15 (list->detail)-|--job-23--|...
VU-8: |--job-8 (list->detail)--|--job-16 (list->detail)-|--job-24--|...

Trung bình mỗi VU xử lý 10 jobs (80/8).
Mỗi job: 2 API calls sequential (list trước, detail sau).
```

Đặc điểm quan trọng:
- Trong mỗi job, 2 API calls là **sequential** (list xong mới detail) -- vì `ok = list.ok && detail.ok` yêu cầu list hoàn thành trước
- Giữa các job, calls là **concurrent** -- 8 VUs gửi request đồng thời đến products service
- Products service phải xử lý được concurrent read requests -- đây là điều kiện cơ bản cho read-heavy service

---

## 8. Key signals / headers

### 8.1 Bảng signals cần verify

| Signal | Vị trí | Expected value | Ý nghĩa | Hậu quả nếu sai |
| --- | --- | --- | --- | --- |
| `status` | Response status line | `200` | HTTP OK -- request được xử lý thành công | Status != 200 = service không xử lý được request |
| `X-Upstream-Service` | Response header | `products-service` | Xác nhận Nginx đã route đến đúng service | Sai = routing bug (dù status có thể vẫn 200 từ fallback) |
| `Content-Type` | Response header | `application/json` | Response body là JSON | Sai = service trả về format không mong đợi (vd: HTML error page) |
| `success` | Response JSON body | `true` | Business-level success flag | `false` = service gap hoặc business logic error |
| `data` | Response JSON body | Array (list) hoặc Object (detail) | Payload thực tế | null/undefined = contract violation nghiêm trọng |
| `data[0].id` | Response JSON body (list) | Integer, khớp với product ID | Product ID trong list item | Thiếu = response thiếu field bắt buộc |
| `data.id` | Response JSON body (detail) | Integer, khớp với `productId` request | Product ID trong detail | Không khớp = ID mapping sai |
| `pagination` | Response JSON body (list) | Object với `total`, `page`, `limit` | Pagination metadata | Thiếu = client không thể hiển thị pagination |
| `shared_jobs_total` | k6 custom metric | `count == 80` | Tất cả jobs đã hoàn thành | < 80 = có job bị bỏ sót |
| `shared_jobs_failed` | k6 custom metric | `count == 0` | Không có job nào thất bại | > 0 = một số product audit fail |

### 8.2 Signal relationship map

```text
status = 200                 ──┬── (A) HTTP-level success
                                │
X-Upstream-Service =           │
  products-service         ────┼── (B) Routing đúng
                                │
success = true             ────┼── (C) Business-level success
                                │
data populated             ────┼── (D) Payload hợp lệ
                                │
shared_jobs_failed = 0     ────┴── (E) Toàn bộ batch pass

Tất cả 5 signal (A+B+C+D+E) cùng đúng -> Products read contract được chứng minh
Signal (A) đúng nhưng (C) sai -> status code không đủ để chứng minh contract
```

### 8.3 Tại sao `success` field quan trọng hơn status code

HTTP status code 200 chỉ nói rằng "server xử lý được request và trả về response". Nhưng response đó có thể chứa `success: false` -- nghĩa là business logic failed (ví dụ: product không tồn tại, database query error, dependency timeout).

```json
// Status 200, nhưng business logic fail
{
  "success": false,
  "error": {
    "code": "PRODUCT_NOT_FOUND",
    "message": "Product with ID 99999 does not exist"
  }
}
```

Nếu client chỉ check status code, nó sẽ parse `data` và gặp null/undefined -> crash. Check `success` field là defense-in-depth: HTTP layer + business layer.

---

## 9. Pass/fail criteria

### 9.1 PASS criteria

Tất cả các điều kiện sau đồng thời đúng:

| # | Tiêu chí | Cách kiểm tra |
| --- | --- | --- |
| P1 | Tất cả checks pass (rate=1) | Threshold `checks: ['rate==1']` |
| P2 | HTTP failure rate = 0% | Threshold `http_req_failed: ['rate==0']` |
| P3 | Tất cả 80 jobs hoàn thành | Threshold `shared_jobs_total: ['count==80']` |
| P4 | Không có job nào thất bại | Threshold `shared_jobs_failed: ['count==0']` |
| P5 | List endpoint trả về 200 | Check tự động trong `requestJson()` |
| P6 | Detail endpoint trả về 200 | Check tự động trong `requestJson()` |
| P7 | `X-Upstream-Service` = `products-service` trên mọi response | Manual verification qua dashboard |
| P8 | Response body list có `success: true`, `data` là array | Manual verification qua curl hoặc Variation 2 |
| P9 | Response body detail có `success: true`, `data` là object | Manual verification qua curl hoặc Variation 2 |

### 9.2 FAIL criteria

| # | Dấu hiệu | Diagnostic | Nguyên nhân khả dĩ |
| --- | --- | --- | --- |
| F1 | `shared_jobs_failed > 0` | Xem operation nào fail (`catalog_list_audit` hay `catalog_detail_audit`) | List hoặc detail endpoint trả về sai status |
| F2 | List trả về status != 200 | Kiểm tra response body | Products service không xử lý được list query -- có thể do sai query params |
| F3 | Detail trả về status != 200 cho một số product ID | Kiểm tra product ID cụ thể | Product ID không tồn tại hoặc DB query fail |
| F4 | `success: false` trong response body | Đọc `error.code` và `error.message` | Business logic error -- DB error, dependency timeout, data corruption |
| F5 | `data` là null/undefined | Kiểm tra response format | Response envelope sai -- thiếu `data` field |
| F6 | `X-Upstream-Service` không phải `products-service` | Kiểm tra Nginx config | Routing sai -- request không đến products service |
| F7 | List trả về 0 items | Kiểm tra DB seeding | Catalog có thể empty hoặc query filter sai |
| F8 | Detail trả về sai product (id không khớp) | So sánh request productId với response data.id | ID mapping sai trong service code |
| F9 | `shared_jobs_total < 80` | Kiểm tra `maxDuration` | Test bị timeout -- products service quá chậm |

---

## 10. Cách chạy + output mẫu

### 10.1 Default run (8 VUs, 80 jobs, catalog audit)

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_01_VUS = "8"
$env:SI_01_JOBS = "80"
$env:SI_01_SLEEP_SECONDS = "0"

k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js
```

Output mẫu (pass):

```text
     script: si-01-catalog-audit.js
     scenarios: catalog_audit (shared-iterations, 8 VUs, 80 iterations)

     ✓ catalog_list_audit status 200
     ✓ catalog_detail_audit status 200

     checks.....................: 100.00% ✓ 160   ✗ 0
     http_req_failed............: 0.00%   ✓ 160   ✗ 0
     http_req_duration..........: avg=22ms min=6ms med=18ms max=55ms p(90)=35ms p(95)=42ms
     http_reqs..................: 160
     shared_jobs_total.........: 80
     shared_jobs_failed........: 0
     shared_api_calls_total....: 160
     shared_job_duration_ms....: avg=48ms min=15ms med=42ms max=95ms
     iterations.................: 80
     vus........................: 8

     Exit: 0
```

Phân tích output này:
- **Exit 0**: Tất cả thresholds pass.
- **checks 100%**: 160/160 checks pass (80 jobs x 2 calls).
- **http_req_failed 0%**: Không có HTTP failure nào.
- **http_reqs = 160**: Chính xác 80 jobs x 2 calls = 160 requests.
- **shared_jobs_total = 80**: Tất cả 80 jobs đã hoàn thành.
- **shared_job_duration_ms avg=48ms**: Mỗi job (2 sequential API calls) mất trung bình 48ms.
- **shared_api_calls_total = 160**: 160 API calls đã được gửi.

### 10.2 Tuned run (debug mode)

```powershell
$env:SI_01_VUS = "2"
$env:SI_01_JOBS = "10"
$env:SI_01_SLEEP_SECONDS = "0.1"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js
```

Giảm xuống 2 VUs và 10 jobs để:
- Dễ dàng quan sát output từng dòng
- Mỗi job 2 calls = 20 checks total
- `SLEEP_SECONDS=0.1` thêm 100ms delay để tránh rate limit

### 10.3 Large catalog audit mode

```powershell
$env:SI_01_VUS = "16"
$env:SI_01_JOBS = "500"
$env:SI_01_SLEEP_SECONDS = "0"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js
```

Tăng lên 500 jobs với 16 VUs để audit catalog lớn hơn. Lưu ý: productId cycle vẫn là 1-50 (theo code trong setup), nên mỗi product sẽ được audit 10 lần. Để audit catalog lớn hơn, cần sửa `(index % 50)` thành `(index % catalogSize)` trong setup.

### 10.4 Cách đọc kết quả trên dashboard

Trên Grafana dashboard:
1. Mở dashboard `Microservices Capability Cases`.
2. Filter theo `case_id=si-01-catalog-audit`.
3. Xem panel "Jobs by service" -- `products-service` bar phải hiển thị 80 jobs.
4. Xem panel "API calls by endpoint" -- 2 endpoint: `GET /api/sim/products` (80 calls) và `GET /api/sim/products/:id` (80 calls).
5. Xem panel "Latency by endpoint" -- detail thường nhẹ hơn list (vì `db_rows=2` vs `db_rows=4`).
6. Xem panel "HTTP Status distribution" -- tất cả phải là 200.

---

## 11. 4 output -> decision scenarios

### Scenario A: Tất cả pass, exit 0

```text
Exit: 0
Checks: 100%
HTTP failed: 0%
shared_jobs_total: 80
shared_jobs_failed: 0
```

**Kết luận**: Products service contract hoàn hảo. List và detail endpoints hoạt động đúng, tất cả product ID reachable, response envelope nhất quán. CDN cache có thể được bật an toàn cho path `/api/sim/products`.

**Hành động**: Tiếp tục sang ms-03 (cart write contract) hoặc ms-04 (order transaction contract).

### Scenario B: Detail fail cho product ID cụ thể

```text
Exit: 99
Checks: ~98.75% (158/160 pass, 2 fail)
HTTP failed: 0%
shared_jobs_total: 80
shared_jobs_failed: 2
2 jobs fail, đều ở catalog_detail_audit với cùng productId=42
```

**Kết luận**: Product ID 42 không thể truy xuất qua detail endpoint. Có thể do data corruption (thiếu record trong DB), ID mapping bug, hoặc business rule (product bị soft-delete nhưng list vẫn hiển thị).

**Hành động**:
1. Gọi thủ công: `curl -s http://localhost:80/api/sim/products/42?view=full`
2. Kiểm tra response -- nếu `success: false`, đọc `error.code`
3. Kiểm tra database: `SELECT * FROM products WHERE id = 42`
4. Nếu product không tồn tại trong DB nhưng list vẫn trả về -> data sync issue
5. Nếu product tồn tại nhưng detail fail -> code bug trong detail endpoint

### Scenario C: List trả về 0 items

```text
Exit: 0 (checks pass vì status vẫn 200)
Checks: 100% (tất cả status 200)
Manual check: list response có success=true nhưng data=[]
```

**Kết luận**: Catalog empty hoặc query params quá restrictive. Với `sort=popular` và `limit=10`, nếu DB có dữ liệu, list phải trả về ít nhất 1 item.

**Hành động**:
1. Kiểm tra DB seeding: `docker exec <db-container> psql -c "SELECT count(*) FROM products"`
2. Nếu count = 0, chạy seed script
3. Nếu count > 0, thử query không có filter: `curl -s http://localhost:80/api/sim/products?limit=10`
4. So sánh kết quả -- nếu không có filter trả về data còn có filter trả về rỗng, query params đang lọc sai

### Scenario D: HTTP failure cao (connection refused)

```text
Exit: 99
Checks: ~50%
HTTP failed: > 10%
http_req_failed cao, phân bố đều
```

**Kết luận**: Products service không chạy hoặc không reachable.

**Hành động**:
1. Kiểm tra container: `docker ps -a | findstr products`
2. Nếu container không chạy: `docker start <products-container>`
3. Nếu container chạy nhưng không phản hồi: `docker logs <products-container>`
4. Kiểm tra Nginx upstream config -- có thể trỏ sai port hoặc container name
5. Restart stack: `./scripts/stack.ps1 -Stack target -Action down; ./scripts/stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2`

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "Read contract đơn giản nên không cần test"

Read contract (GET request) có vẻ đơn giản -- không có state, không có side effect, không có transaction. Nhưng chính vì đơn giản mà người ta thường bỏ qua test, và hậu quả lại nghiêm trọng nhất:

**Sự thật**: Read contract là nền tảng cho mọi thứ khác. Nếu products list trả sai envelope, CDN cache sẽ cache response sai. Nếu detail thiếu field, homefeed và recommendations cũng sẽ sai. Contract test cho read path là baseline rẻ nhất -- nếu nó fail, đừng test gì khác cho đến khi fix xong.

### 12.2 Nghịch lý 2: "Status 200 nghĩa là mọi thứ OK"

Đây là assumption nguy hiểm nhất. Status 200 chỉ xác nhận HTTP layer hoạt động, không xác nhận business logic đúng.

**Sự thật**:
```json
// Status 200, nhưng business logic fail
{ "success": false, "error": { "code": "DB_ERROR" } }

// Status 200, nhưng data sai
{ "success": true, "data": null }

// Status 200, nhưng từ sai service (fallback app)
HTTP/1.1 200 OK
X-Upstream-Service: app
```

Cả 3 trường hợp trên đều có status 200 nhưng đều là fail. Check `success` field và `X-Upstream-Service` header là bắt buộc để phân biệt.

### 12.3 Nghịch lý 3: "Audit 50 product ID trong môi trường dev là đủ"

50 product IDs có vẻ ít so với production catalog 50,000 SKU. Nhưng mục tiêu của audit test không phải là coverage 100% catalog -- mà là chứng minh contract đúng.

**Sự thật**: Nếu contract đúng cho 50 product IDs, khả năng rất cao nó đúng cho tất cả (vì code path giống nhau). Ngược lại, nếu contract sai, nó sẽ fail ngay ở product ID đầu tiên. 50 IDs là sample size hợp lý để cân bằng giữa test duration và confidence.

### 12.4 Nghịch lý 4: "Products service là read-only nên không cần test concurrent load"

Dù là read-only, concurrent read requests có thể gây ra:
- Database connection pool exhaustion
- Query timeout dưới tải
- Memory pressure từ việc build nhiều response đồng thời
- Race condition trong cache layer (nếu service có internal cache)

**Sự thật**: 8 VUs đồng thời gửi 2 requests mỗi job = tối đa 16 concurrent requests đến products service. Đây là con số khiêm tốn nhưng đủ để phát hiện các vấn đề cơ bản về concurrency.

### 12.5 Nghịch lý 5: "Không cần test cả list và detail vì chúng dùng chung data layer"

List và detail có thể dùng chung data layer (cùng database, cùng ORM), nhưng code path khác nhau:
- List: query nhiều rows, aggregate facets, sort by different criteria
- Detail: query 1 row, join reviews, format full response

**Sự thật**: Một thay đổi trong data layer (vd: thêm field mới, thay đổi index) có thể làm list pass nhưng detail fail (hoặc ngược lại). Test cả 2 endpoint là cần thiết để cover cả 2 code paths.

---

## 13. Checklist trước khi chạy

### 13.1 Stack readiness

- [ ] ms-01 (Gateway routing smoke) đã PASS
- [ ] Stack đã được start với `-TargetLayer full-no-cdn -ScaleApp 2`
- [ ] `docker ps` cho thấy products-service container đang running
- [ ] `curl http://localhost:80/api/sim/products?limit=1` trả về 200 + JSON

### 13.2 Environment variables

- [ ] `$env:BASE_URL = "http://localhost:80"` đã được set
- [ ] `$env:SI_01_VUS = "8"` (hoặc giá trị tùy chỉnh)
- [ ] `$env:SI_01_JOBS = "80"` (hoặc giá trị tùy chỉnh)
- [ ] `$env:SI_01_SLEEP_SECONDS = "0"` (mặc định)

### 13.3 Products service health check

- [ ] `curl -s http://localhost:80/api/sim/products?limit=5` -> 200 + `X-Upstream-Service: products-service` + JSON với `success: true`, `data` là array
- [ ] `curl -s http://localhost:80/api/sim/products/1?view=full` -> 200 + JSON với `success: true`, `data` là object có `id`, `name`, `price`
- [ ] `curl -s http://localhost:80/api/sim/products/25?view=summary` -> 200 (test product ID trong khoảng 1-50)
- [ ] `curl -s http://localhost:80/api/sim/products/50?view=full&include_reviews=1` -> 200 + `data.reviews` là array

### 13.4 k6 installation

- [ ] `k6 version` hoạt động
- [ ] Script path: `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js` tồn tại
- [ ] `common.js` có mặt trong cùng thư mục

### 13.5 Test strategy

- [ ] Xác định mục tiêu: catalog audit (default) hay debug (tuned)?
- [ ] Nếu là audit: dùng 8 VUs, 80 jobs, kỳ vọng exit 0
- [ ] Nếu là debug: dùng 2 VUs, 10 jobs, SLEEP_SECONDS=0.1

---

## 14. Variations với code mẫu

### Variation 1: Audit toàn bộ 6 endpoints (không chỉ list + detail)

```javascript
import {
  BASE_URL, buildJobs, buildSharedScenario, currentJob,
  envFloat, envInt, finishJob, requestJson, think,
} from './common.js';

const CASE_ID = 'si-01-full-audit';
const VUS = envInt('SI_01_VUS', 8);
const JOBS = envInt('SI_01_JOBS', 80);
const SLEEP_SECONDS = envFloat('SI_01_SLEEP_SECONDS', 0);

export const options = {
  scenarios: {
    full_audit: buildSharedScenario('fullAudit', VUS, JOBS, '10m', {
      case_id: CASE_ID,
      business_case: 'full_product_contract_audit',
    }),
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    shared_jobs_total: [`count==${JOBS}`],
    shared_jobs_failed: ['count==0'],
  },
};

export function setup() {
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `full-audit-${index + 1}`,
      productId: (index % 50) + 1,
    })),
  };
}

export function fullAudit(data) {
  const started = Date.now();
  const job = currentJob(data);
  let ok = true;

  // 1. List
  const list = requestJson('GET',
    `${BASE_URL}/api/sim/products?limit=10&sort=popular&view=grid&include_facets=1&cpu_ms=1&db_rows=2&json_items=10`,
    null, { caseId: CASE_ID, service: 'products-service', operation: 'audit_list', endpoint: 'GET /api/sim/products', jobId: job.id });
  ok = ok && list.ok;

  // 2. Detail
  const detail = requestJson('GET',
    `${BASE_URL}/api/sim/products/${job.productId}?view=full&include_reviews=1&cpu_ms=1&db_rows=1`,
    null, { caseId: CASE_ID, service: 'products-service', operation: 'audit_detail', endpoint: 'GET /api/sim/products/:id', jobId: job.id });
  ok = ok && detail.ok;

  // 3. Search
  const search = requestJson('GET',
    `${BASE_URL}/api/sim/products/search?q=shoe&limit=5&cpu_ms=1&db_rows=2`,
    null, { caseId: CASE_ID, service: 'products-service', operation: 'audit_search', endpoint: 'GET /api/sim/products/search', jobId: job.id });
  ok = ok && search.ok;

  // 4. Categories
  const categories = requestJson('GET',
    `${BASE_URL}/api/sim/products/categories?cpu_ms=1&db_rows=1`,
    null, { caseId: CASE_ID, service: 'products-service', operation: 'audit_categories', endpoint: 'GET /api/sim/products/categories', jobId: job.id });
  ok = ok && categories.ok;

  // 5. Homefeed
  const homefeed = requestJson('GET',
    `${BASE_URL}/api/sim/products/homefeed?cpu_ms=1&db_rows=2&json_items=6`,
    null, { caseId: CASE_ID, service: 'products-service', operation: 'audit_homefeed', endpoint: 'GET /api/sim/products/homefeed', jobId: job.id });
  ok = ok && homefeed.ok;

  // 6. Recommendations
  const recommendations = requestJson('GET',
    `${BASE_URL}/api/sim/products/${job.productId}/recommendations?limit=4&cpu_ms=1&db_rows=1`,
    null, { caseId: CASE_ID, service: 'products-service', operation: 'audit_recommendations', endpoint: 'GET /api/sim/products/:id/recommendations', jobId: job.id });
  ok = ok && recommendations.ok;

  finishJob(started, ok, {
    caseId: CASE_ID, service: 'products-service', operation: 'full_audit_job', jobId: job.id,
  });
  think(SLEEP_SECONDS, { caseId: CASE_ID, operation: 'worker_pause' });
}
```

**Mục đích**: Audit toàn bộ 6 endpoints của products service trong một job duy nhất. Mỗi job gọi 6 API calls (thay vì 2) -- tăng coverage nhưng cũng tăng thời gian chạy. Phù hợp cho comprehensive contract test sau deploy lớn.

### Variation 2: Thêm body check (`success` field và `data` structure)

```javascript
import { check } from 'k6';

export function catalogAuditWithBodyCheck(data) {
  const started = Date.now();
  const job = currentJob(data);
  let ok = true;

  // List call với body check
  const listRes = requestJson('GET',
    `${BASE_URL}/api/sim/products?limit=10&sort=popular&view=grid&include_facets=1&cpu_ms=2&db_rows=4&json_items=10`,
    null, { caseId: CASE_ID, service: 'products-service', operation: 'catalog_list_audit', endpoint: 'GET /api/sim/products', jobId: job.id });

  if (listRes.ok) {
    const body = listRes.response.json();
    const bodyOk = check(listRes.response, {
      'list success is true': () => body.success === true,
      'list data is array': () => Array.isArray(body.data),
      'list data not empty': () => body.data.length > 0,
      'list pagination exists': () => body.hasOwnProperty('pagination'),
      'list facets exists': () => body.hasOwnProperty('facets'),
    });
    if (!bodyOk) listRes.ok = false;
  }
  ok = ok && listRes.ok;

  // Detail call với body check
  const detailRes = requestJson('GET',
    `${BASE_URL}/api/sim/products/${job.productId}?view=full&include_reviews=1&cpu_ms=2&db_rows=2`,
    null, { caseId: CASE_ID, service: 'products-service', operation: 'catalog_detail_audit', endpoint: 'GET /api/sim/products/:id', jobId: job.id });

  if (detailRes.ok) {
    const body = detailRes.response.json();
    const bodyOk = check(detailRes.response, {
      'detail success is true': () => body.success === true,
      'detail data is object': () => typeof body.data === 'object' && body.data !== null && !Array.isArray(body.data),
      'detail data has id': () => body.data.hasOwnProperty('id'),
      'detail data has name': () => body.data.hasOwnProperty('name'),
      'detail data has price': () => body.data.hasOwnProperty('price'),
      'detail data has description': () => body.data.hasOwnProperty('description'),
      'detail data has reviews': () => body.data.hasOwnProperty('reviews'),
    });
    if (!bodyOk) detailRes.ok = false;
  }
  ok = ok && detailRes.ok;

  finishJob(started, ok, {
    caseId: CASE_ID, service: 'products-service', operation: 'catalog_audit_with_body_job', jobId: job.id,
  });
}
```

**Mục đích**: Không chỉ check status code, mà còn check response body structure. Phát hiện contract violation như `success: false`, `data` null, thiếu field bắt buộc -- những thứ mà status code 200 không phát hiện được.

### Variation 3: Audit với dynamic catalog size

```javascript
const CATALOG_SIZE = envInt('CATALOG_SIZE', 50);

export function setup() {
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `catalog-audit-${index + 1}`,
      productId: (index % CATALOG_SIZE) + 1,  // Dynamic từ env
    })),
  };
}
```

**Mục đích**: Cho phép audit catalog với kích thước tùy chỉnh qua biến môi trường `CATALOG_SIZE`. Hữu ích khi test với catalog lớn hơn (vd: 500 sản phẩm) mà không cần sửa code.

### Variation 4: So sánh dữ liệu list vs detail (cross-reference)

```javascript
export function catalogAuditCrossRef(data) {
  const started = Date.now();
  const job = currentJob(data);
  let ok = true;

  const list = requestJson('GET',
    `${BASE_URL}/api/sim/products?limit=50&sort=id_asc&cpu_ms=1&db_rows=1&json_items=50`,
    null, { caseId: CASE_ID, service: 'products-service', operation: 'list_all', endpoint: 'GET /api/sim/products', jobId: job.id });

  const detail = requestJson('GET',
    `${BASE_URL}/api/sim/products/${job.productId}?view=full&cpu_ms=1&db_rows=1`,
    null, { caseId: CASE_ID, service: 'products-service', operation: 'detail_one', endpoint: 'GET /api/sim/products/:id', jobId: job.id });

  if (list.ok && detail.ok) {
    const listBody = list.response.json();
    const detailBody = detail.response.json();

    // Tìm product trong list
    const productInList = listBody.data.find(p => p.id === job.productId);

    const crossRefOk = check(null, {
      'product exists in list': () => productInList !== undefined,
      'product name matches': () => productInList && detailBody.data &&
        productInList.name === detailBody.data.name,
      'product price matches': () => productInList && detailBody.data &&
        productInList.price === detailBody.data.price,
    });
    if (!crossRefOk) ok = false;
  }

  finishJob(started, ok, {
    caseId: CASE_ID, service: 'products-service', operation: 'cross_ref_job', jobId: job.id,
  });
}
```

**Mục đích**: Không chỉ check từng endpoint độc lập, mà còn cross-reference dữ liệu giữa list và detail. Nếu list có product ID=42 với name="A" nhưng detail trả về name="B", có data inconsistency.

### Variation 5: Performance profiling (so sánh list vs detail latency)

```javascript
import { Trend } from 'k6/metrics';

const listLatency = new Trend('list_latency_ms', true);
const detailLatency = new Trend('detail_latency_ms', true);

export function catalogAuditProfiled(data) {
  const job = currentJob(data);
  let ok = true;

  const listRes = requestJson('GET', `${BASE_URL}/api/sim/products?limit=10&cpu_ms=2&db_rows=4&json_items=10`, ...);
  listLatency.add(listRes.durationMs);
  ok = ok && listRes.ok;

  const detailRes = requestJson('GET', `${BASE_URL}/api/sim/products/${job.productId}?view=full&cpu_ms=2&db_rows=2`, ...);
  detailLatency.add(detailRes.durationMs);
  ok = ok && detailRes.ok;

  finishJob(started, ok, ...);
}
```

**Mục đích**: Tách biệt latency metrics cho list và detail. Cho phép so sánh performance giữa 2 endpoint -- list thường chậm hơn (nhiều rows, facets aggregation), detail thường nhanh hơn (single row query).

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Chỉ test list, bỏ qua detail

```text
SAI: "List pass thì detail cũng pass -- chúng dùng chung data layer."
```

**Vấn đề**: List và detail có code path khác nhau. List query nhiều rows + aggregate facets; detail query 1 row + join reviews. Một thay đổi SQL query cho detail (vd: thêm JOIN condition sai) có thể làm detail fail trong khi list vẫn pass.

**Cách đúng**: Luôn test cả 2 endpoint. Chúng là 2 code path độc lập với 2 SQL query khác nhau.

### 15.2 Anti-pattern 2: Không check response body

```text
SAI: Thấy status 200 -> kết luận "contract đúng".
```

**Vấn đề**: Status 200 có thể đi kèm với `success: false` hoặc `data: null`. Status code là HTTP-level signal, không phải business-level signal.

**Cách đúng**: Thêm body check (Variation 2) hoặc ít nhất manual verification bằng curl cho một vài request.

### 15.3 Anti-pattern 3: Dùng `productId` ngẫu nhiên thay vì cycle

```text
SAI: productId = Math.floor(Math.random() * 1000) + 1 -- có thể generate ID không tồn tại.
```

**Vấn đề**: Với random ID, bạn không biết ID nào tồn tại trong DB. Nếu detail fail vì ID không tồn tại, đó không phải là contract violation -- đó là expected behavior. Nhưng bạn không thể phân biệt giữa "ID không tồn tại" và "contract sai".

**Cách đúng**: Dùng cycle qua known range (1-50) hoặc query list trước để lấy danh sách ID có thật.

### 15.4 Anti-pattern 4: Bỏ qua `include_facets` và `include_reviews`

```text
SAI: Chỉ test list với limit=10, không test facets. Chỉ test detail với view=summary, không test reviews.
```

**Vấn đề**: Facets và reviews là 2 tính năng quan trọng của products service. Nếu facets query bị lỗi (vd: sai SQL JOIN), list vẫn trả về 200 với data array -- nhưng facets object sẽ trống hoặc sai.

**Cách đúng**: Test với `include_facets=1` cho list và `include_reviews=1` cho detail.

### 15.5 Anti-pattern 5: Chạy audit với SLEEP_SECONDS > 0 trong CI/CD

```text
SAI: $env:SI_01_SLEEP_SECONDS = "0.5" -- mỗi job nghỉ 0.5 giây.
```

**Vấn đề**: 80 jobs x 0.5s = 40 giây chỉ riêng sleep. CI/CD pipeline bị chậm không cần thiết.

**Cách đúng**: `SLEEP_SECONDS=0` cho CI/CD. Chỉ set > 0 khi debug.

### 15.6 Anti-pattern 6: Không verify sau khi CDN được bật

```text
SAI: Chạy ms-02 pass -> bật CDN cache cho /api/sim/products -> không chạy lại ms-02.
```

**Vấn đề**: Sau khi bật CDN, topology thay đổi. Request có thể được cache và không đến products service. Bạn cần verify rằng contract vẫn đúng khi CDN cache response -- và CDN cache response đúng contract.

**Cách đúng**: Chạy ms-02 với topology `full-no-cdn` (không CDN) để verify contract gốc. Sau đó chạy CDN cache cases với topology `full` (có CDN) để verify cache behavior.

---

## 16. Real validation data

### 16.1 Default catalog audit run (8 VUs, 80 jobs)

```text
     script: si-01-catalog-audit.js
     scenarios: catalog_audit
     executor: shared-iterations
     vus: 8
     iterations: 80

     ✓ catalog_list_audit status 200
     ✓ catalog_detail_audit status 200

     checks.....................: 100.00% ✓ 160   ✗ 0
     http_req_failed............: 0.00%   ✓ 160   ✗ 0
     http_req_duration..........: avg=22ms min=6ms med=18ms max=55ms p(90)=35ms p(95)=42ms
     http_reqs..................: 160
     shared_jobs_total.........: 80
     shared_jobs_failed........: 0
     shared_api_calls_total....: 160
     shared_job_duration_ms....: avg=48ms min=15ms med=42ms max=95ms p(90)=72ms p(95)=82ms
     iterations.................: 80
     vus........................: 8

     Exit: 0
```

**Phân tích**:
- 160/160 checks pass (80 jobs x 2 calls)
- p95 latency = 42ms cho từng API call -- nhanh, phù hợp với cpu_ms=2
- shared_job_duration_ms avg=48ms -- mỗi job (2 sequential calls) mất ~48ms
- p95 job duration = 82ms -- ngay cả job chậm nhất cũng dưới 100ms
- 8 VUs xử lý 80 jobs hiệu quả

### 16.2 Manual verification response body bằng curl

```powershell
# Verify list endpoint
$listResponse = Invoke-RestMethod -Uri "http://localhost:80/api/sim/products?limit=10&sort=popular&view=grid&include_facets=1&cpu_ms=2&db_rows=4&json_items=10"
Write-Host "List success: $($listResponse.success)"
Write-Host "List data type: $($listResponse.data.GetType().Name)"
Write-Host "List data count: $($listResponse.data.Count)"
Write-Host "List has pagination: $($null -ne $listResponse.pagination)"
Write-Host "List has facets: $($null -ne $listResponse.facets)"

# Verify detail endpoint
$detailResponse = Invoke-RestMethod -Uri "http://localhost:80/api/sim/products/1?view=full&include_reviews=1&cpu_ms=2&db_rows=2"
Write-Host "Detail success: $($detailResponse.success)"
Write-Host "Detail data type: $($detailResponse.data.GetType().Name)"
Write-Host "Detail product id: $($detailResponse.data.id)"
Write-Host "Detail product name: $($detailResponse.data.name)"
Write-Host "Detail product price: $($detailResponse.data.price)"
Write-Host "Detail has reviews: $($null -ne $detailResponse.data.reviews)"
```

Output kỳ vọng:
```text
List success: True
List data type: Object[] (array)
List data count: 10
List has pagination: True
List has facets: True
Detail success: True
Detail data type: PSCustomObject (object)
Detail product id: 1
Detail product name: Product 1
Detail product price: 29.99
Detail has reviews: True
```

### 16.3 Phân tích per-endpoint latency

Từ dashboard, với 80 jobs:

| Endpoint | Calls | Avg latency | p95 latency | Notes |
| --- | --- | --- | --- | --- |
| `GET /api/sim/products` (list) | 80 | ~28ms | ~42ms | Nặng hơn vì `json_items=10` + facets query |
| `GET /api/sim/products/:id` (detail) | 80 | ~16ms | ~28ms | Nhẹ hơn vì `db_rows=2` + single row query |

List chậm hơn detail ~1.5-1.7x -- phù hợp với expectation (list query 4 rows + build facets + format 10 items; detail query 2 rows + format 1 object).

### 16.4 Phân tích phân phối product ID được audit

Với 80 jobs, productId cycle 1-50:

| Product ID range | Số lần audit | Jobs |
| --- | --- | --- |
| 1-30 | 2 lần | Jobs 0-29 (first cycle) + Jobs 50-79 (second cycle, 30 jobs) |
| 31-50 | 1 lần | Jobs 30-49 (first cycle) |

Tổng cộng: 80 jobs = (30 x 2) + (20 x 1) = 60 + 20 = 80 audits.

---

## 17. Reference

### 17.1 Các file liên quan

| File | Vai trò |
| --- | --- |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\si-01-catalog-audit.js` | Script chính của case |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\shared-iterations\common.js` | Shared library: `requestJson()`, `buildJobs()`, `currentJob()`, `finishJob()`, `buildSharedScenario()`, `think()` |
| `E:\Projects\k6\k6-metrics-server\load-target\k6\microservices\case-catalog.json` | Catalog định nghĩa tất cả microservices cases, expected signals |
| `E:\Projects\k6\k6-metrics-server\load-target\nginx\nginx.conf` | Nginx configuration với location `/api/sim/products` route đến `products_service` |
| `E:\Khoa hoc\k6\docs\practice\microservices\00_overview.md` | Tổng quan Microservices layer, mental model, 5 services |

### 17.2 Các case liên quan trong series

| Case | Mối liên hệ |
| --- | --- |
| [ms-01 -- Gateway routing smoke](./01_gateway-routing-smoke.md) | Prerequisite -- xác nhận Nginx route `/api/sim/products` đến đúng service trước khi test contract |
| [ms-03 -- Cart write contract](./03_cart-write-contract.md) | Cart service cần product info để hiển thị giỏ hàng -- nếu products contract sai, cart cũng bị ảnh hưởng |
| [ms-04 -- Order transaction contract](./04_order-transaction-contract.md) | Order service cần product info để validate đơn hàng |
| [ms-05 -- Report async contract](./05_report-async-contract.md) | Report service aggregate data từ products service |
| [ms-06 -- Stateful business flow](./06_stateful-business-flow.md) | Flow browse products -> add to cart -> checkout -- products service là bước đầu tiên |
| [ms-07 -- Service health](./07_service-health-dependencies.md) | Products service health check bao gồm Postgres dependency |

### 17.3 Tài liệu tổng quan

| File | Nội dung |
| --- | --- |
| [00_overview.md](./00_overview.md) | Tổng quan Microservices layer, 7 capability proofs, evidence model, learning order |
| [01_gateway-routing-smoke.md](./01_gateway-routing-smoke.md) | Case trước đó -- routing smoke test cho tất cả 5 service |
| [../lb/04_origin-cacheable-read.md](../lb/04_origin-cacheable-read.md) | LB case tương đương -- test products-service read dưới concurrent load |
| [../RUN_GUIDE.md](../RUN_GUIDE.md) | Hướng dẫn chạy toàn bộ test suite |

### 17.4 Kiến thức nền

| Chủ đề | Tài liệu tham khảo |
| --- | --- |
| k6 shared-iterations executor | [k6.io: shared-iterations](https://k6.io/docs/using-k6/scenarios/executors/shared-iterations/) |
| k6 check reference | [k6.io: checks](https://k6.io/docs/using-k6/checks/) |
| k6 custom metrics (Counter, Trend) | [k6.io: custom metrics](https://k6.io/docs/using-k6/metrics/create-custom-metrics/) |
| REST API envelope pattern | [Google API Design: response format](https://cloud.google.com/apis/design/standard_methods) |
| API contract testing | [martinfowler.com: contract testing](https://martinfowler.com/bliki/ContractTest.html) |
| CDN cache origin | [Cloudflare: cache behavior](https://developers.cloudflare.com/cache/) |
| Nginx reverse proxy | [nginx.org: reverse proxy](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/) |
