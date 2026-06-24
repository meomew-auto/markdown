# ms-03 — Cart service: write API contract

## 1. Business scenario

Một batch job dọn dẹp cart cũ (stale cart cleanup): đọc cart summary, cập nhật quantity, xóa items hết hạn. Cart service là nơi lưu trạng thái tạm trước khi checkout — nó phải hỗ trợ đủ 4 HTTP methods và state phải survive qua nhiều operations.

```text
Cart cleanup job: add item → view cart → update quantity → remove item
```

## 2. Capability được test

Case này chứng minh:

- `POST /api/sim/cart/add` thêm item vào cart, trả về success;
- `GET /api/sim/cart` xem cart, trả về items list;
- `PATCH /api/sim/cart/items/:item_id` cập nhật quantity;
- `DELETE /api/sim/cart/items/:item_id` xóa item;
- Cart state survive qua nhiều operations trong cùng session;
- `X-Upstream-Service: cart-service` trên mọi response.

## 3. Script và executor

```text
Script: ../shared-iterations/si-04-cart-cleanup.js
Executor: shared-iterations
Default VUs: 8
Default jobs: 90
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

## 4. Env knobs

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_04_VUS = "8"
$env:SI_04_JOBS = "90"
$env:SI_04_SLEEP_SECONDS = "0"
```

## 5. Flow chính

```text
Setup tạo 90 jobs

Mỗi job:
  1. POST /api/sim/cart/add
     → add item với product_id và quantity
  2. GET /api/sim/cart
     → verify item xuất hiện trong cart
  3. PATCH /api/sim/cart/items/{item_id}
     → update quantity
  4. DELETE /api/sim/cart/items/{item_id}
     → remove item, cart empty
```

## 6. Evidence phải đọc

| Evidence | Expected |
| --- | --- |
| `checks` | 100% |
| `http_req_failed` | 0.00% |
| `shared_jobs_total` | 90 |
| `shared_jobs_failed` | 0 |
| `X-Upstream-Service` | `cart-service` trên mọi response |
| Cart add response | `success: true`, item được thêm |
| Cart view response | `success: true`, `data.items` chứa item vừa thêm |
| Cart update response | `success: true`, quantity thay đổi |
| Cart remove response | `success: true`, item bị xóa |

## 7. Cart service — full API surface

```text
POST   /api/sim/cart/add              — thêm item
GET    /api/sim/cart                   — xem cart
GET    /api/sim/cart/summary           — cart summary (item count, total)
PATCH  /api/sim/cart/items/:item_id    — cập nhật quantity
DELETE /api/sim/cart/items/:item_id    — xóa item
```

Cart service là write-heavy: mọi operation đều thay đổi state. Không như products service (pure read), cart service cần authentication và state persistence.

## 8. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| Cart add thất bại | Authentication thiếu hoặc service không nhận request |
| Cart view không thấy item vừa thêm | State không persist — có thể là in-memory per-instance thay vì shared |
| Update sai quantity | Logic bug |
| Remove không hoạt động | DELETE method không được route đúng |
| `X-Upstream-Service` không phải `cart-service` | Routing sai — có thể request đến app fallback |

## 9. Dashboard/chart reading

Chart nên đọc:

- `shared_jobs_total` = 90, `shared_jobs_failed` = 0;
- checks rate 100%;
- 4 HTTP methods phân bố đều: POST, GET, PATCH, DELETE;
- `X-Upstream-Service` = `cart-service` 100%.

Cart operations thường nhanh (vài ms) vì không có external call. Nếu latency cao bất thường, có thể Redis/DB chậm.

## 10. Production lesson

Cart là "temporary state" — không quan trọng bằng order (money path), nhưng là UX chính. Nếu cart không giữ được state, user mất context mua sắm và bounce. Case này dạy cách verify toàn bộ CRUD surface của một stateful service trước khi test các flow phức tạp hơn (checkout, payment).
