# ext-01 — Payment gateway health, slow path and circuit breaker

> **Case ID:** `ext-01-payment-checkout-matrix`
> **Script:** `../app/02-payment-checkout-matrix.js`
> **Profile:** `full-no-cdn`, requires `OPS_AUTH_TOKEN`
> **Proof:** Payment gateway behavior spectrum: healthy → slow → down → circuit OPEN → half-open → CLOSED. **502 intentional — không judge fail bằng status.**

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Black Friday 23:45. Payment gateway bắt đầu chậm (p95 latency 3s). Đến 23:52, gateway hoàn toàn down. Team on-call nhận alert: "Checkout failure rate 40%". Họ kiểm tra circuit breaker — circuit đã OPEN, chặn mọi request đến payment gateway để bảo vệ hệ thống khỏi cascading failure.

Đây là kịch bản thực tế nhất trong external dependency layer. Case này mô phỏng **toàn bộ spectrum** của payment gateway behavior.

### 1.2 Payment gateway spectrum

```text
HEALTHY  → SLOW     → DOWN     → CIRCUIT OPEN → HALF-OPEN → CLOSED
200 OK    200 OK     502        502 (short)     200/502     200 OK
~120ms    ~500ms     immediate  no external     test call   normal
```

---

## 2. External capability được chứng minh

1. **Healthy payment**: `payment_mode=http`, `payment_code=200`, `payment_attempts=1`
2. **Slow payment**: `bottleneck=external_ms`, latency tăng nhưng vẫn 200
3. **Payment down**: 502 + `dependency.payment_code` — fail có metadata
4. **Circuit breaker**: Sau N lần fail → circuit OPEN → short-circuit (không gọi external)
5. **Half-open recovery**: Circuit tự chuyển half-open → test request → nếu OK → CLOSED

---

## 3. Flow chính

```text
1. POST /api/sim/checkout?external_ms=120 (healthy) → 200, payment_attempts=1
2. POST /api/sim/checkout?external_ms=500 (slow) → 200, bottleneck=external_ms
3. POST /api/sim/checkout?external_fail_rate=100 (down) → 502, payment_code != 200
4. Lặp N lần fail → circuit OPEN
5. GET /ops/order/payment/circuit → verify state=OPEN
6. POST checkout → 502 immediate (short-circuit, không gọi external)
7. Chờ OPEN_WAIT_SECONDS → circuit → HALF-OPEN
8. POST checkout (test request) → nếu OK → CLOSED
```

---

## 4. Key signals

| Phase | Status | Signal |
| --- | --- | --- |
| Healthy | 200 | `payment_mode=http`, `payment_code=200`, `payment_attempts=1` |
| Slow | 200 | `bottleneck=external_ms` |
| Down | **502** | `dependency.payment_code` non-200 |
| Circuit OPEN | **502** | Short-circuit, `payment_attempts=0` |
| Half-open | 200/502 | Test request |
| Closed | 200 | Normal operation restored |

---

## 5. Pass/fail

```text
✅ Healthy: 200, payment_attempts=1
✅ Slow: 200, bottleneck=external_ms
✅ Down: 502 (EXPECTED!), payment_code != 200
✅ Circuit OPEN: 502 short-circuit
✅ Half-open → CLOSED: recovery
❌ KHÔNG judge fail vì 502 trong down/circuit phase
```

---

## 6. Cách chạy

```powershell
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
$env:PAYMENT_CHECKOUT_CONTROL_BASE_URL = "http://localhost:80"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/02-payment-checkout-matrix.js
```

---

## 7. Variations

- `PAYMENT_MATRIX_EXTERNAL_MS=50` — test fast payment
- `PAYMENT_MATRIX_FAILURE_CALLS=5` — cần nhiều fail hơn để OPEN circuit
- `PAYMENT_MATRIX_OPEN_WAIT_SECONDS=10` — circuit OPEN lâu hơn

---

## 8. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Judge fail vì 502** | 502 là expected trong down/circuit phase |
| **Không check circuit state** | Không biết circuit breaker có hoạt động không |
| **Không verify payment_attempts** | Không biết retry có hoạt động không |

---

## 9. Real validation data

(TBD — sẽ chạy sau)
