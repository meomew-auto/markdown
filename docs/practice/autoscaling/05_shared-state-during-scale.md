# as-05 — Shared state during scale

> **Case ID:** `as-05-shared-state-during-scale`
> **Script:** `../app/25-order-service-autoscale-controller.js`
> **Proof:** Nhiều replica → idempotency/webhook/cart/order state vẫn toàn vẹn qua Redis/Postgres. Replica count không thay thế distributed state.

---

## 1. Tình huống thực tế

"Scale order-service lên 3 replica. 2 user vô tình gửi cùng 1 order confirm request. 2 request đến 2 replica khác nhau. Nếu không có Redis shared state → order bị xử lý 2 lần → double charge."

---

## 2. Scale ngang = state phải shared

```text
                    ┌─────────────┐
                    │    Redis     │  ← SHARED STATE
                    │ idempotency  │     TẤT CẢ replica đọc/ghi cùng 1 Redis
                    │ cart session │
                    │ webhook dedup│
                    └─────────────┘
                          ↑
          ┌───────────────┼───────────────┐
          │               │               │
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │ order-1  │    │ order-2  │    │ order-3  │
    │          │    │          │    │          │
    └──────────┘    └──────────┘    └──────────┘
          ↑               ↑               ↑
          └───────────────┼───────────────┘
                          │
                      k6 traffic (2 VUs gửi CÙNG idempotency key)

Nếu KHÔNG có Redis: mỗi replica có state riêng → duplicate
Nếu CÓ Redis:        SET idempotency:<key> NX → atomic → chỉ 1 replica claim được
```

---

## 3. Hotkey idempotency test

```text
hotkeyOrderId = "ORD-AUTOSCALE-HOTKEY-<runId>"        ← CỐ ĐỊNH
hotkeyIdempotencyKey = "idem-autoscale-hotkey-<runId>" ← CỐ ĐỊNH

2 VUs × 30s:
  Mỗi iteration gửi POST /api/sim/orders/{SAME_ID}/confirm
  Với idempotency_key GIỐNG HỆT NHAU
  Nginx LB round-robin → đến các replica khác nhau

Redis (shared state):
  SET idempotency:autoscale-hotkey-<runId> NX
    → Replica đầu tiên: key chưa tồn tại → SET thành công → "fresh"
    → Các replica sau: key đã tồn tại → SET thất bại → "reuse"
    → Kết quả: order CHỈ được confirm 1 lần
```

---

## 4. Pass/fail

```text
✅ order_autoscale_hotkey_fresh_count <= MAX_FRESH (chỉ 1 lần claim thành công)
✅ order_autoscale_hotkey_reuse_count > 0 (các replica khác thấy duplicate)
✅ order_autoscale_check_failures = 0
✅ order_autoscale_trace_failures = 0
✅ Trace ID preserved xuyên suốt các replica
✅ Run ID, Scenario, Order ID, Idempotency Key đều preserved
```

---

## 5. Kết quả thực tế (Run #165)

```text
order_autoscale_hotkey_fresh_count: 1     ← CHỈ 1 replica claim được
order_autoscale_hotkey_reuse_count: 55    ← 55 lần phát hiện duplicate → từ chối đúng
order_autoscale_high_success: 1023        ← request mới (không duplicate) vẫn xử lý BT
order_autoscale_low_success: 40
order_autoscale_trace_failures: 0         ← trace không bị mất qua các replica
```

---

## 6. Cách chạy

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:K6_METRICS_TOKEN = "student-token-1234567890"
.\scripts\run-compose-autoscale-lab.ps1 `
  -BaseUrl http://localhost:18080 `
  -MetricsBaseUrl http://localhost:13001
```

---

## 7. State types cần shared khi scale ngang

| State type | Storage | Tại sao cần shared |
| --- | --- | --- |
| **Idempotency key** | Redis SET NX | Ngăn duplicate confirm |
| **Cart session** | Redis HASH | Cart của user phải nhất quán dù request đến replica nào |
| **Webhook dedup** | Redis SET + TTL | Webhook có thể retry → phải dedup |
| **Order state** | Postgres | Order đã confirm → tất cả replica thấy cùng 1 row |
| **Circuit breaker** | Redis (nếu có) | Trạng thái CB phải shared giữa các replica |

---

## 8. Bài học

- **Replica count ≠ state management**: Có 10 replica cũng không thay thế được 1 Redis. State phải nằm ngoài container.
- **Scale càng nhiều → rủi ro duplicate càng cao**: Xác suất 2 request giống nhau đến 2 replica khác nhau tăng theo số replica.
- **Atomic operation là bắt buộc**: `SET NX` (Redis) hoặc `INSERT ... ON CONFLICT` (Postgres) — không được dùng check-then-set.
- **Distributed state là nền tảng của scale ngang**: Không có Redis/Postgres, scale ngang không thể hoạt động đúng.
