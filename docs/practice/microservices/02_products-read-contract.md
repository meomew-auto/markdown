# ms-02 — Products service: read API contract

## 1. Business scenario

Sau deploy hoặc catalog sync, cần audit tất cả product SKU: kiểm tra list có trả về đủ sản phẩm với facets/sorting không, và detail có trả về đủ thông tin sản phẩm không. Products service là service đọc nhiều nhất — nó là primary origin cho CDN cache.

```text
Catalog audit: mỗi job check 1 product — list page chứa nó + detail page trả đúng
```

## 2. Capability được test

Case này chứng minh:

- `GET /api/sim/products` trả về list với đúng envelope `{ success: true, data: [...] }`;
- `GET /api/sim/products/:id` trả về detail với đầy đủ fields;
- Sorting, pagination, facets hoạt động qua query params;
- Response header `X-Upstream-Service: products-service`;
- Service chịu được sustained read traffic.

## 3. Script và executor

```text
Script: ../shared-iterations/si-01-catalog-audit.js
Executor: shared-iterations
Default VUs: 8
Default jobs: 80
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

Shared-iterations phù hợp vì đây là batch audit job — mỗi worker pick job tiếp theo từ backlog, không cần state giữa các job.

## 4. Env knobs

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_01_VUS = "8"
$env:SI_01_JOBS = "80"
$env:SI_01_SLEEP_SECONDS = "0"
```

## 5. Flow chính

```text
Setup tạo 80 jobs, mỗi job có productId cố định

Mỗi job:
  1. GET /api/sim/products?limit=10&sort=popular&view=grid&include_facets=1&cpu_ms=2&db_rows=4&json_items=10
     → expect status 200, success=true, data array
  2. GET /api/sim/products/{productId}?view=full&include_reviews=1&cpu_ms=2&db_rows=2
     → expect status 200, success=true, data object với product detail
```

## 6. Evidence phải đọc

| Evidence | Expected |
| --- | --- |
| `checks` | 100% |
| `http_req_failed` | 0.00% |
| `shared_jobs_total` | 80 |
| `shared_jobs_failed` | 0 |
| `X-Upstream-Service` | `products-service` trên mọi response |
| List response body | `success: true`, `data` là array |
| Detail response body | `success: true`, `data` là object có product fields |

## 7. Products service — endpoints đầy đủ

Products service có 6 endpoints:

```text
GET /api/sim/products                — list (có sort, filter, facets)
GET /api/sim/products/:id            — detail
GET /api/sim/products/search         — search (full-text)
GET /api/sim/products/categories     — category tree
GET /api/sim/products/homefeed       — personalized homefeed blocks
GET /api/sim/products/:id/recommendations — related products
```

Case này tập trung vào list + detail vì đó là 2 endpoint được gọi nhiều nhất và là CDN cache origin chính. Các endpoint khác được test trong executor suite cases (constant-vus storefront, constant-arrival-rate storefront RPS, v.v.).

## 8. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| `success: false` | Service contract violation — có thể là DB error hoặc bug code |
| `data` là null/undefined | Response envelope sai |
| `X-Upstream-Service` không phải `products-service` | Routing sai |
| List trả về 0 items | Có thể DB empty hoặc query filter sai |
| Detail trả về sai product | ID mapping sai |

## 9. Dashboard/chart reading

Chart nên đọc:

- `shared_jobs_total` = 80, `shared_jobs_failed` = 0;
- checks rate 100%;
- `X-Upstream-Service` = `products-service` 100%;
- Latency split: list (nặng hơn vì json_items=10) vs detail (nhẹ hơn).

Products service là read-only — không có side effect, không cần theo dõi duplicate hay race condition.

## 10. Production lesson

Read contract tưởng đơn giản nhưng là nền tảng cho mọi thứ khác. Nếu products list trả sai envelope, CDN cache sẽ cache response sai. Nếu detail thiếu field, homefeed và recommendations cũng sẽ sai. Contract test cho read path là baseline rẻ nhất — nếu nó fail, đừng test gì khác cho đến khi fix xong.
