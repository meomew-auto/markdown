# ms-01 — Gateway routing smoke

## 1. Business scenario

Trước khi test bất kỳ service contract nào, cần chứng minh Nginx route đúng URL prefix đến đúng microservice. Case này gửi request đến tất cả 5 service và kiểm tra header `X-Upstream-Service` trên từng response.

```text
/products       → X-Upstream-Service: products-service
/products/:id   → X-Upstream-Service: products-service
/cart/add       → X-Upstream-Service: cart-service
/orders/:id     → X-Upstream-Service: order-service
/report/jobs    → X-Upstream-Service: report-service
```

Nếu bất kỳ request nào rơi vào `X-Upstream-Service: app` (fallback), routing sai.

## 2. Capability được test

Case này chứng minh:

- Nginx location block khớp đúng URL prefix;
- Mỗi prefix route đến đúng upstream block;
- `X-Upstream-Service` header được set đúng cho từng service;
- Không có request nào rơi vào fallback `location /`;
- Tất cả 5 service đều alive và trả về response hợp lệ.

## 3. Script và executor

```text
Script: ../shared-iterations/si-07-ci-verification-batch.js
Executor: shared-iterations
Default VUs: 10
Default jobs: 100
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

Case này dùng shared-iterations vì mỗi iteration là một job độc lập, worker pool xử lý backlog job bao phủ đều 5 service.

## 4. Env knobs

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_07_VUS = "10"
$env:SI_07_JOBS = "100"
$env:SI_07_SLEEP_SECONDS = "0"
```

## 5. Flow chính

```text
Setup tạo 100 jobs, mỗi job có type:
  - product_list (GET /api/sim/products)
  - product_detail (GET /api/sim/products/:id)
  - cart_add (POST /api/sim/cart/add)
  - order_confirm (POST /api/sim/orders/:id/confirm)
  - report_generate (POST /api/sim/report/jobs)

Runtime: worker pool 10 VUs xử lý 100 jobs
Mỗi job gọi 1-2 API calls đến service tương ứng
```

## 6. Evidence phải đọc

| Evidence | Expected |
| --- | --- |
| `checks` | 100% |
| `http_req_failed` | 0.00% |
| `shared_jobs_total` | 100 |
| `shared_jobs_failed` | 0 |
| `X-Upstream-Service` | "products-service", "cart-service", "order-service", hoặc "report-service" — không bao giờ là "app" |
| Status code | 200 hoặc 202 (report job create) |

## 7. Vì sao X-Upstream-Service quan trọng?

Không có header này, bạn không thể phân biệt được request được xử lý bởi service nào. Status 200 từ `app` fallback trông giống hệt status 200 từ `order-service`. `X-Upstream-Service` là bằng chứng duy nhất cho routing correctness trong toàn bộ microservices layer.

Header này được set bởi Nginx `add_header X-Upstream-Service "service-name" always;` trong mỗi location block — không phải bởi application code.

## 8. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| `X-Upstream-Service: app` | Route sai — request rơi vào fallback thay vì microservice |
| Thiếu `X-Upstream-Service` | Nginx config sai hoặc request không qua Nginx |
| `shared_jobs_failed > 0` | Có service không reachable hoặc trả lỗi |
| Status code sai | Service contract violation cơ bản |
| Chỉ thấy 1-2 service thay vì 5 | Một số service down hoặc Nginx upstream config sai |

## 9. Dashboard/chart reading

Chart nên đọc:

- `shared_jobs_total` và `shared_jobs_failed`;
- distribution của job type (5 loại đều nhau);
- checks rate 100%;
- `X-Upstream-Service` header values distribution.

Không cần đọc latency chart cho case này — mục tiêu là routing correctness, không phải performance.

## 10. Production lesson

API gateway routing tưởng đơn giản nhưng là single point of failure cho toàn bộ microservices. Một location block sai, một upstream misconfigured, hoặc một service không registered — và traffic rơi vào fallback handler âm thầm. Case này dạy cách chứng minh routing đúng trước khi test bất kỳ thứ gì khác.
