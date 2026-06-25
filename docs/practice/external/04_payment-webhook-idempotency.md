# ext-04 — Payment webhook idempotency

> **Case ID:** `ext-04-payment-webhook-idempotency`
> **Script:** `../app/13-payment-webhook-idempotency.js`
> **Profile:** `full-no-cdn`, NO `OPS_AUTH_TOKEN`
> **Proof:** Payment provider gửi same webhook event 2 lần → lần 1 apply (fresh, `db_write_ms` present), lần 2 dedupe (reuse, `db_write_ms` cleared). Webhook idempotency bảo vệ khỏi duplicate side effect.

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Payment provider (Stripe, PayPal, Adyen) xử lý thanh toán thành công, gửi webhook `payment.captured` đến hệ thống của bạn. Do network retry ở phía provider, **cùng một event được gửi 2 lần**. Nếu hệ thống không dedupe, order sẽ bị apply payment 2 lần — dẫn đến sai số dư, duplicate transaction record.

Đây là vấn đề **rất phổ biến** với webhook. Provider đảm bảo "at-least-once delivery" — không đảm bảo "exactly-once". Phía bạn phải tự implement idempotency.

### 1.2 Webhook idempotency pattern

```text
Lần 1: webhook_duplicate=false, db_write_ms > 0  ← Fresh: apply payment
Lần 2: webhook_duplicate=true,  db_write_ms = 0  ← Duplicate: dedupe, NO DB write
Lần 3: event_id mới → fresh (apply cho order khác)
```

---

## 2. External capability được chứng minh

1. **First webhook**: Apply thành công, `webhook_duplicate=false`, `db_write_ms` present
2. **Duplicate webhook**: Deduped, `webhook_duplicate=true`, `db_write_ms` CLEARED
3. **New event**: Apply độc lập, không bị ảnh hưởng bởi duplicate trước đó
4. **Acknowledged**: Cả first và duplicate đều `acknowledged=true` (provider nhận 200)

---

## 3. Key signals

| Event | webhook_duplicate | db_write_ms | acknowledged |
| --- | --- | --- | --- |
| First (event_id=A) | **false** | > 0 | true |
| Duplicate (event_id=A) | **true** | **0** ← key proof | true |
| New (event_id=B) | false | > 0 | true |

---

## 4. Pass/fail

```text
✅ First: webhook_duplicate=false, db_write_ms > 0
✅ Duplicate: webhook_duplicate=true, db_write_ms = 0 ← dedupe proof
✅ New event: webhook_duplicate=false (apply độc lập)
✅ Duplicate duration << first duration
```

---

## 5. Cách chạy

```powershell
$env:BASE_URL = "http://localhost:80"
$env:PAYMENT_WEBHOOK_EVENT_TYPE = "payment.captured"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/13-payment-webhook-idempotency.js
```

---

## 6. Real validation data

(TBD)
