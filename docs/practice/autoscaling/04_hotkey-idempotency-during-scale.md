# as-04 — Hotkey and idempotency during autoscale

> **Case ID:** `as-04-hotkey-state-during-scale`
> **Script:** `../app/25-order-service-autoscale-controller.js`
> **Proof:** Cùng 1 idempotency key gửi đến nhiều replica → Redis đảm bảo không duplicate. Replica count không thay thế distributed state.

---

## 1. Tình huống thực tế

"2 VUs gửi CÙNG order_id + idempotency_key đến 2 replica khác nhau của order-service. Nếu không có Redis shared state, cả 2 replica sẽ xử lý đơn hàng 2 lần → double charge."

## 2. Hotkey scenario

```text
hotkeyOrderId = "ORD-AUTOSCALE-HOTKEY-<runId>"       ← CỐ ĐỊNH
hotkeyIdempotencyKey = "idem-autoscale-hotkey-<runId>" ← CỐ ĐỊNH

2 VUs × 30s:
  Mỗi iteration gửi POST /api/sim/orders/{SAME_ORDER_ID}/confirm
  Với idempotency_key GIỐNG NHAU
  Qua Nginx LB → đến 2 order-service replica khác nhau

Redis check:
  SET idempotency:<key> NX → chỉ 1 replica được "fresh"
  Các replica còn lại → "reuse" (đã thấy key này)
```

## 3. Pass/fail

```text
✅ order_autoscale_hotkey_fresh_count <= MAX_FRESH (chỉ claim được 1 lần)
✅ order_autoscale_hotkey_reuse_count > 0 (các replica khác thấy duplicate)
✅ order_autoscale_check_failures = 0
✅ Không có double confirm (Redis atomicity proven)
```

## 4. Kết quả thực tế (Run #165)

```text
order_autoscale_hotkey_fresh_count: 1     ← chỉ 1 replica claim được
order_autoscale_hotkey_reuse_count: 55    ← 55 lần thấy duplicate → từ chối đúng
order_autoscale_high_success: 1023        ← request mới vẫn xử lý bình thường
order_autoscale_low_success: 40
```

## 5. Cách chạy

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:K6_METRICS_TOKEN = "student-token-1234567890"
.\scripts\run-compose-autoscale-lab.ps1 `
  -BaseUrl http://localhost:18080 `
  -MetricsBaseUrl http://localhost:13001
```

## 6. Điều tra trong dashboard

1. tab Overview → `order_autoscale_hotkey_fresh_count` = 1
2. tab Overview → `order_autoscale_hotkey_reuse_count` > 0
3. Console log → tìm `idempotency` → thấy "fresh" và "reuse"
4. Kiểm tra Redis: `KEYS idempotency:*` → chỉ có 1 key

## 7. Bài học

- **Replica không thay thế distributed state**: Dù có 3 replica, vẫn cần Redis để đảm bảo exactly-once.
- **Autoscale tăng rủi ro duplicate**: Càng nhiều replica, xác suất 2 request giống nhau đến 2 replica khác nhau càng cao.
- **Idempotency key là contract**: Client PHẢI gửi idempotency key. Server PHẢI check atomic trong Redis. Đây là pattern production quan trọng.
