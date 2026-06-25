# obs-01 -- Trace & request correlation

> **Case ID:** `obs-01-trace-correlation`
> **Script:** `load-target/k6/app/24-order-service-trace-correlation.js`
> **Profile:** `full-no-cdn`, 1 VU, 1 iteration, **CẦN OPS_AUTH_TOKEN**
> **Proof:** Request ID → Trace ID → Operation → Service → Resource evidence chain hoàn chỉnh

---

## 1. Tinh huong thuc te

Mot production incident bat dau tu mot order request bi loi hoac cham. Team can:

```text
"Request POST /api/sim/orders/ORD-123/confirm bi slow -- nhung request nao? operation nao?
 service nao bi anh huong? upstream dependency nao gay ra? container resource luc do ra sao?"
```

Khong co trace correlation, ban chi thay mot con so percentile. Co trace correlation, ban thay toan bo chuoi bang chung.

## 2. Capability

Case nay chay 3 operations tren order-service, moi operation co trace identifiers day du:

| Flow | Method | Operation | Expected |
| --- | --- | --- | --- |
| `order_confirm` | POST | `/api/sim/orders/:id/confirm` | 200, trace ids match, order_id preserved |
| `order_status` | GET | `/api/sim/orders/:id` | 200, trace ids match, xac nhan order ton tai |
| `payment_webhook` | POST | `/api/sim/orders/webhooks/payment` | 200, trace ids match |

Moi request gui kem:
- `X-Trace-ID`: Dinh danh trace duy nhat cho request nay
- `X-Request-ID`: Dinh danh request duy nhat
- `X-Test-Run-ID`: Dinh danh test run (de cross-reference voi dashboard)
- `X-Test-Scenario`: Scenario name
- `Idempotency-Key` (cho confirm operation)

Server response tra ve:
- Response headers: `X-Request-ID`, `X-Trace-ID`, `X-Test-Run-ID`, `X-Test-Scenario`
- Response body: `trace.request_id`, `trace.trace_id`, `trace.run_id`, `trace.scenario`, `trace.order_id`, `trace.idempotency_key`

**Correlation chain:**

```text
X-Request-ID (request header)
    → X-Request-ID (response header)     ← server nhan va echo lai
    → trace.request_id (response body)   ← body xac nhan cung request_id
    → trace.trace_id (response body)     ← trace duy nhat cho operation nay
    → trace.order_id (response body)     ← business entity
    → trace.run_id (response body)       ← cross-reference dashboard run ID
```

## 3. Pass/fail

```text
✅ order_trace_correlation_check_failures = 0
✅ checks rate = 100%
✅ http_req_failed = 0%
✅ Moi flow (confirm, status, webhook) co day du trace identifiers
✅ Response header request id == body trace.request_id
✅ Response header trace id == expected trace id
✅ Body trace.order_id duoc preserve qua cac operation
✅ Body trace.idempotency_key duoc preserve (confirm flow)
```

## 4. Cach chay

```powershell
# Source OPS_AUTH_TOKEN tu container (KHONG in ra)
$env:OPS_AUTH_TOKEN = docker exec k6-metrics-server printenv OPS_AUTH_TOKEN 2>$null

# Xac nhan token da set
if (-not $env:OPS_AUTH_TOKEN) {
  Write-Host "ERROR: OPS_AUTH_TOKEN not set. Run: docker exec k6-metrics-server printenv OPS_AUTH_TOKEN"
  exit 1
}

$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:ORDER_TRACE_CORRELATION_RUN_ID = "fe-obs-trace"
$env:ORDER_TRACE_CORRELATION_SCENARIO = "order_trace_correlation"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/24-order-service-trace-correlation.js
```

## 5. Dashboard

Sau khi chay, mo `http://localhost:13001/` → chon run → tab **Requests**:

### Trace Correlation panel
- Bang hien thi moi request voi: `X-Trace-ID`, `X-Request-ID`, `flow`, `status`, `duration`
- Click vao mot request de xem response body: `trace.request_id`, `trace.trace_id`, `trace.order_id`
- Xac nhan trace_id trong response header == trace_id trong response body

### Expected dashboard panels
1. **Request ID / Trace ID table** -- moi request kem trace identifiers
2. **Operation latency and status breakdown** -- confirm, status, webhook duration
3. **Upstream instance/service evidence** -- `target_service: order-service`, `target_flow: trace_correlation`
4. **Resource samples around request timestamps** -- CPU/memory tai thoi diem request

### Pre-built dashboard queries
- Filter theo `target_service=order-service` de xem tat ca order requests
- Filter theo `flow=order_confirm` de isolate confirm operation
- Filter theo `X-Trace-ID` value de trace mot request duy nhat qua cac panel

## 6. Real validation

**Run #148** (2026-06-24) -- smoke test:

| Metric | Value | Verdict |
| --- | ---: | --- |
| `order_trace_correlation_check_failures` | 0 | ✅ |
| `checks rate` | 100% | ✅ |
| `http_req_failed` | 0% | ✅ |
| Total requests | 3 (confirm + status + webhook) | ✅ |
| Confirm: trace_id match header↔body | pass | ✅ |
| Confirm: order_id preserved | pass | ✅ |
| Confirm: idempotency_key preserved | pass | ✅ |
| Status: trace_id match header↔body | pass | ✅ |
| Webhook: trace_id match header↔body | pass | ✅ |

**Lesson:** Mot request khong chi la mot con so percentile. No phai map nguoc ve operation, service instance, dependency, va resource evidence. Correlation chain hoan chinh la foundation cho moi SLO decision.

## 7. Troubleshooting

| Van de | Nguyen nhan | Cach fix |
| --- | --- | --- |
| `confirm_header_trace_id` fail | `OPS_AUTH_TOKEN` khong duoc set | `docker exec k6-metrics-server printenv OPS_AUTH_TOKEN` |
| `body_request_id` fail | Response body khong parse duoc | Kiem tra response status != 200, xem response body raw |
| `body_trace_id` fail | Trace ID mismatch giua header va body | Kiem tra server co echo dung X-Trace-ID khong |
| `body_order_id` fail | Order ID khong duoc preserve | Kiem tra URL path order_id co match khong |
