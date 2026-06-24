# db-01 — Order DB delay and recovery

> **Case ID:** `db-01-order-db-delay-recovery`
> **Script:** `../app/07-production-mix-order-db-recovery.js`
> **Profile:** `full-no-cdn`
> **Workload:** 1 VU, 1 iteration (sequential), requires `OPS_AUTH_TOKEN`
> **Proof:** DB delay injected qua control plane → latency tăng observable trong `performance.breakdown.db_ms` → reset → recovery

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

11:00 AM thứ Sáu. Team infrastructure thông báo: "Postgres instance sắp được nâng cấp lên version mới. Trong quá trình failover sang replica, ứng dụng có thể thấy latency tăng 30-50ms trong vài giây." Làm sao để xác nhận ứng dụng **vẫn hoạt động đúng** dù DB chậm, và **recover hoàn toàn** sau khi failover xong?

Case này mô phỏng chính xác tình huống đó: inject controlled delay vào Postgres, verify latency tăng đúng như dự kiến, rồi reset và verify recovery.

### 1.2 Đây là controlled experiment — không phải chaos

Khác với chaos engineering (bắn random failure vào production), đây là **controlled experiment**:
- **Biết trước** delay bao nhiêu ms (35ms default)
- **Biết trước** delta latency expected (160ms)
- **Có control plane** để reset về trạng thái sạch
- **Sequential** (1 VU, 1 iteration) — dễ đọc, dễ debug

---

## 2. DB capability được chứng minh

1. **Delay injection hoạt động**: `PUT /ops/order/db/profile` với `postgres_delay_ms=35` → response xác nhận profile đã set.
2. **Latency phản ánh delay**: `performance.breakdown.db_ms` tăng trong delay phase so với baseline.
3. **Write path vẫn đúng**: Checkout và confirm vẫn success dù DB chậm.
4. **Recovery sau reset**: `POST /ops/order/db/reset` → latency trở về mức chấp nhận được.

---

## 3. Vì sao phải test ở DB layer?

CDN, LB, Microservices, Redis đều không thể:
- Inject DB delay có kiểm soát
- Đọc `db_ms`/`db_write_ms` từ performance payload
- Xác nhận DB delay ảnh hưởng đúng các API dùng DB
- Xác nhận recovery sau reset

---

## 4. Topology

```text
Script: ../app/07-production-mix-order-db-recovery.js
Executor: 1 VU, 1 iteration (sequential)
Topology: full-no-cdn
Requires: OPS_AUTH_TOKEN
```

---

## 5. Flow chính

```text
Phase 1 — Baseline:
  1. GET /ops/order/db/profile → đọc current profile (baseline)
  2. Gọi các API bị ảnh hưởng (order_status, checkout, order_confirm, payment_webhook)
     → Record baseline latency
  3. Gọi các API không bị ảnh hưởng (products, cart, report)
     → Verify không bị tác động

Phase 2 — Delay:
  4. PUT /ops/order/db/profile { postgres_delay_ms: 35 }
  5. Gọi lại các API bị ảnh hưởng
     → Expect: db_ms tăng, latency tăng > baseline + DELAY_DELTA_MS
  6. Gọi lại các API không bị ảnh hưởng
     → Expect: latency không tăng quá UNAFFECTED_TOLERANCE_MS

Phase 3 — Recovery:
  7. POST /ops/order/db/reset
  8. Gọi lại các API bị ảnh hưởng
     → Expect: latency giảm, < delay_phase_latency - RECOVERY_DELTA_MS
```

---

## 6. Key signals

| Signal | Phase | Expected |
| --- | --- | --- |
| `performance.breakdown.db_ms` | Delay | Tăng so với baseline |
| `performance.breakdown.db_write_ms` | Delay | Tăng so với baseline |
| `prod_mix_order_db_degraded_observed` | Delay | > 0 |
| `prod_mix_order_db_recovered_observed` | Recovery | > 0 |
| `prod_mix_order_db_check_failures` | All | 0 |
| API không bị ảnh hưởng | Delay | Latency không tăng đáng kể |

---

## 7. Pass/fail criteria

```text
✅ prod_mix_order_db_check_failures = 0
✅ Delay phase: db_ms observable > baseline
✅ Recovery phase: latency < delay phase
✅ Unaffected APIs: latency không degraded
✅ Profile postgres_delay_ms = 0 sau reset
```

---

## 8. Cách chạy

```powershell
$env:BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_DELAY_MS = "35"
$env:PROD_MIX_ORDER_DB_DELAY_DELTA_MS = "160"
$env:PROD_MIX_ORDER_DB_RECOVERY_DELTA_MS = "120"
# OPS_AUTH_TOKEN từ container
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN

k6 run E:/Projects/k6/k6-metrics-server/load-target/k6/app/07-production-mix-order-db-recovery.js
```

---

## 9. Variations

- **Tăng delay**: `PROD_MIX_ORDER_DB_DELAY_MS=80` — test extreme delay
- **Giảm recovery tolerance**: `PROD_MIX_ORDER_DB_RECOVERY_TOLERANCE_MS=50` — strict hơn
- **Thay đổi delta**: `PROD_MIX_ORDER_DB_DELAY_DELTA_MS=100` — chấp nhận ít latency increase hơn

---

## 10. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Không đọc `db_ms`** | Không biết delay có thực sự ảnh hưởng DB không |
| **Chỉ nhìn status code** | Tất cả đều 200 — delay không làm fail request |
| **Không verify unaffected APIs** | Bỏ sót delay ảnh hưởng sai scope |
| **Không reset sau test** | DB profile còn delay → các test sau bị nhiễu |
