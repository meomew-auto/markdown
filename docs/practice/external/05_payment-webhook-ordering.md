# ext-05 — Payment webhook ordering and stale regression protection

> **Case ID:** `ext-05-payment-webhook-ordering`
> **Script:** `../app/14-payment-webhook-ordering.js`
> **Profile:** `full-no-cdn`, NO `OPS_AUTH_TOKEN`
> **Proof:** Payment provider gửi `payment.captured` (paid) → sau đó gửi `payment.failed` (stale, out-of-order). Hệ thống **từ chối hạ cấp** trạng thái từ paid xuống failed. `payment_regression_ignored=true`.

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Một order đã được thanh toán thành công (payment.captured). 2 phút sau, provider gửi một event `payment.failed` cũ (từ lần thử thanh toán đầu tiên bị timeout). Event này đến **sai thứ tự** — lẽ ra phải đến trước `payment.captured`.

Nếu hệ thống áp dụng event này, order sẽ chuyển từ **paid → failed** — khách hàng đã trả tiền nhưng order bị đánh dấu thất bại. Đây là catastrophic bug.

### 1.2 State machine protection

```text
Trạng thái hiện tại: PAID (từ payment.captured)
Event đến:           payment.failed (stale, out-of-order)

Hệ thống PHẢI:
  ✅ Giữ nguyên trạng thái PAID
  ✅ Báo payment_regression_ignored=true
  ✅ Acknowledge event (200 OK — provider không cần biết ta đã ignore)
```

---

## 2. External capability được chứng minh

1. **Captured event**: Apply thành công, `payment_status=paid`
2. **Stale failed event**: Bị ignore, `payment_regression_ignored=true`, `payment_state_reused=true`
3. **State preserved**: `payment_state_updated_at` không thay đổi sau stale event
4. **Monotonic state machine**: Payment state chỉ đi lên (unpaid → paid), không đi xuống

---

## 3. Key signals

| Event | Status | regression_ignored | state preserved |
| --- | --- | --- | --- |
| payment.captured | 200 | false | state → paid |
| payment.failed (stale) | 200 | **true** ← proof | **paid** (không đổi!) |

---

## 4. Pass/fail

```text
✅ Captured: payment_status=paid, regression_ignored=false
✅ Stale failed: payment_regression_ignored=true ← critical proof
✅ Status check: payment_status vẫn = paid
✅ Stale duration bounded (xử lý nhanh — không gọi external)
```

---

## 5. Cách chạy

```powershell
$env:BASE_URL = "http://localhost:80"
$env:PAYMENT_WEBHOOK_ORDERING_CAPTURE_EVENT_TYPE = "payment.captured"
$env:PAYMENT_WEBHOOK_ORDERING_STALE_EVENT_TYPE = "payment.failed"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/14-payment-webhook-ordering.js
```

---

## 6. Real validation data

(TBD)
