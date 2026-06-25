# res-01 — Resource model correctness

> **Case ID:** `res-01-resource-correctness`
> **Script:** `../app/26-resource-correctness-benchmark.js`
> **Profile:** `full-no-cdn`, 1 VU, NO token needed
> **Proof:** Mọi API knobs (`cpu_ms`, `db_rows`, `db_writes`, `memory_kb`) map chính xác vào `performance.resource_model` và `performance.breakdown`. Trust foundation cho toàn bộ resource layer.

---

## 1. Tình huống thực tế

Trước khi dùng resource metrics cho capacity planning, cần xác nhận: **khi gọi API với `?cpu_ms=8&db_rows=120`, response có report đúng `resource_model.cpu_target_ms=8` và `resource_model.db_rows=120` không?** Nếu contract này sai, mọi phân tích resource sau đó là rác.

## 2. Capability

- `GET /api/sim/products?cpu_ms=8&db_rows=120` → `resource_model` matches
- `POST /api/sim/checkout?db_writes=6&disk_kb=64` → `resource_model` matches
- `GET /api/sim/auth/me?cpu_ms=2&memory_kb=512` → auth resource model
- Tất cả 6 service families được test

## 3. Pass/fail

```text
✅ resource_correctness_failures = 0
✅ checks rate = 100%
✅ http_req_failed = 0%
✅ Mọi resource_model field khớp query param
✅ breakdown fields present (cpu_ms, db_ms, db_write_ms...)
```

## 4. Cách chạy

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RESOURCE_CORRECTNESS_RUN_ID = "res-01-test"
k6 run -o cloud ...26-resource-correctness-benchmark.js
```

## 5. Real validation

**Run #129** (2026-06-25): 355/355 checks (100%), 0 failures, 28 reqs, avg=6.37ms, p95=15.2ms, 0% http_req_failed.

Verified:
- products light/heavy: `resource_model.cpu_target_ms=8`, `db_rows=40/120` ✅
- auth/me: `resource_model.memory_kb=512` ✅
- cart add/summary: `resource_model.db_writes` matches ✅
- checkout: `resource_model.disk_kb=64`, `external_target_ms` present ✅
- report: `resource_model.gzip_kb=256` ✅
- 23 unique endpoint groups — full API surface coverage
