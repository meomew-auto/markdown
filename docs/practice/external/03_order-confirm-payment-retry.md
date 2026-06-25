# ext-03 — Order confirm payment retry

> **Case ID:** `ext-03-order-confirm-payment-retry`
> **Script:** `../app/12-order-confirm-payment-retry.js`
> **Profile:** `full-no-cdn`, requires `OPS_AUTH_TOKEN`
> **Proof:** Order confirm → payment-mock fail lần đầu → retry success → `payment_attempts >= 2`. Idempotency key preserved. Circuit không bị OPEN sai.

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Khách hàng nhấn "Đặt mua". Order confirm gọi payment gateway. Lần đầu timeout (network flap). Hệ thống retry — lần 2 thành công. Khách hàng thấy "Thanh toán thành công".

Nếu không có retry: khách hàng thấy lỗi, tưởng chưa bị charge, nhấn lại → duplicate charge.

### 1.2 Retry contract

```text
Baseline:    payment_attempts=1, duration ~200ms
Transient:   fail first (1 lần), retry success, payment_attempts >= 2, duration ~320ms
Recovered:   payment_attempts=1, duration ~200ms (bình thường trở lại)
```

---

## 2. Key signals

| Phase | payment_attempts | Duration | Idempotency |
| --- | --- | --- | --- |
| Baseline | 1 | ~200ms | key preserved |
| Transient | **≥ 2** | ~320ms (có retry overhead) | key preserved |
| Recovered | 1 | ~200ms | key preserved |

---

## 3. Cách chạy

```powershell
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
$env:ORDER_CONFIRM_RETRY_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_CONFIRM_RETRY_FAIL_FIRST_N = "1"
$env:ORDER_CONFIRM_RETRY_MIN_ATTEMPTS = "2"

k6 run -o cloud ...12-order-confirm-payment-retry.js
```

---

## 4. Variations

- `ORDER_CONFIRM_RETRY_FAIL_FIRST_N=2` — fail 2 lần trước khi success
- `ORDER_CONFIRM_RETRY_EXTERNAL_MS=500` — test với external chậm
