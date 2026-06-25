# res-03 — Container resource audit

> **Case ID:** `res-03-container-audit`
> **Script:** `../app/28-resource-container-audit.js`
> **Profile:** `full-no-cdn`, 1 VU, NO token
> **Proof:** Container-level resources (CPU %, RAM, network I/O, disk I/O) được report qua Docker stats. Audit xác nhận resource data available và hợp lệ.

---

## 1. Tình huống thực tế

Bạn muốn biết: "App container dùng bao nhiêu % CPU khi xử lý 8 req/s?" Nếu container metrics không available, bạn không thể correlation giữa traffic và resource usage.

## 2. Capability

- CPU % per container
- RAM MB per container
- Network I/O bytes
- Disk I/O bytes
- Container names và status

## 3. Pass/fail

```text
✅ resource_container_audit_failures = 0
✅ Container metrics present
✅ CPU/RAM values hợp lệ (> 0)
```

## 4. Dashboard Capacity tab

```text
http://localhost:13001/ → chọn run → tab Capacity:
  GET /v1/tests/:id/resources → history.points
  GET /v1/resources/live → realtime container snapshot
```

## 5. Cách chạy

```powershell
$env:RESOURCE_CONTAINER_RUN_ID = "res-03-test"
k6 run -o cloud ...28-resource-container-audit.js
```
