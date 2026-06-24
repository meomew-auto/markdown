# db-03 — Order DB fault and recovery

> **Case ID:** `db-03-order-db-fault-recovery`
> **Script:** `../app/10-production-mix-order-db-fault-recovery.js`
> **Profile:** `full-no-cdn`, requires `OPS_AUTH_TOKEN`
> **Proof:** DB fault mode injected → 5xx intentional trong fault window → reset → recovery về 200

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

3:00 AM. Hệ thống monitoring báo: "Postgres không phản hồi — connection timeout". Order service bắt đầu trả về 502/503. Team on-call được page. Họ nhanh chóng failover sang replica. Câu hỏi: **order service có thực sự fail đúng cách khi DB chết không?** Và **sau khi DB recover, service có tự động hoạt động lại không?**

Case này mô phỏng: inject DB fault mode (`tcp_reset` hoặc `dns_fail`), verify service fail **đúng contract**, rồi reset và verify recovery.

### 1.2 Fault mode — không phải lúc nào cũng 5xx

```text
dns_fail:   DB hostname không resolve được → connection error → 5xx
tcp_reset:  DB connection bị reset → query fail → 5xx
```

**Quan trọng**: 5xx trong fault window là **EXPECTED**. Không judge fail case này bằng `http_req_failed`.

---

## 2. DB capability được chứng minh

1. **Fault injection hoạt động**: `PUT /ops/order/db/profile` với `postgres_fault_mode`.
2. **Fail contract đúng**: Affected APIs trả về 5xx, unaffected APIs vẫn 200.
3. **Recovery sau reset**: Tất cả APIs trở về 200.
4. **Payment-sensitive APIs được bảo vệ**: Không tạo side effect trong fault window.

---

## 3. Flow chính

```text
Phase 1 — Baseline:  verify no fault, all 200
Phase 2 — Fault:     inject tcp_reset → affected 5xx, unaffected 200
Phase 3 — Recovery:  reset → all 200, fault mode cleared
```

---

## 4. Key signals

| Signal | Expected |
| --- | --- |
| `prod_mix_order_db_fault_check_failures` | 0 |
| Affected APIs trong fault window | 5xx (expected!) |
| Affected APIs sau recovery | 200 |
| Unaffected APIs | 200 (mọi phase) |

---

## 5. Pass/fail

```text
✅ faultCheckFailures = 0 (script tính cả fail contract là pass)
✅ Fault window có 5xx → fault mode hoạt động
✅ Recovery: tất cả 200
❌ KHÔNG judge bằng http_req_failed
```

---

## 6. Cách chạy

```powershell
$env:BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_FAULT_CONTROL_BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_FAULT_MODE = "tcp_reset"
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/10-production-mix-order-db-fault-recovery.js
```

---

## 7. Variations

- `dns_fail` mode: `PROD_MIX_ORDER_DB_FAULT_MODE=dns_fail`
- Strict recovery: `PROD_MIX_ORDER_DB_FAULT_RECOVERY_TOLERANCE_MS=100`

---

## 8. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Judge fail vì `http_req_failed > 0`** | Bỏ lỡ evidence fault mode hoạt động |
| **Không verify unaffected APIs** | Không biết fault scope |
| **Không reset sau test** | Mọi test sau fail vì DB còn fault |
