# res-04 — Non-K8s production approximation

> **Case ID:** `res-04-nonk8s-prod-approx`
> **Script:** `../app/29-nonk8s-prod-approx.js`
> **Profile:** `full-no-cdn`, constant-vus, NO token
> **Modes:** `cpu_throttle`, `memory_pressure`, `disk_pressure`, `oom_threshold`

---

## 1. Tình huống thực tế

Local Docker không có cgroup throttling như K8s. Case này **xấp xỉ** production behavior bằng cách đẩy resource knobs lên cao và quan sát system response.

## 2. 4 modes

| Mode | VUs | Duration | Mô phỏng |
| --- | ---: | ---: | --- |
| `cpu_throttle` | 4 | 16s | CPU bão hòa — `cpu_ms=35` |
| `memory_pressure` | 4 | 16s | Memory tăng — `retain_memory_kb=16384` |
| `disk_pressure` | 4 | 12s | Disk I/O — `disk_kb=2048` |
| `oom_threshold` | 1 | iterations | Memory leo thang đến OOM |

## 3. Pass/fail

```text
✅ nonk8s_prod_approx_failures = 0
✅ success_200 > 0 (có request thành công)
✅ tolerated_errors: accepted trong pressure modes
```

## 4. Caveat

Đây là **xấp xỉ** — không có cgroup, không có K8s scheduler. Kết quả chỉ ra behavior pattern, không phải con số tuyệt đối cho production K8s.

## 6. Real validation

### Mode: cpu_throttle — Run #132 ⚠️
- 923 reqs, 4 VUs, 1123/1946 checks (58%), 89.17% http_req_failed
- **All failures: `products_cpu_throttle_status_429`**
- Server correctly returns 429 under CPU+memory pressure (cpu_ms=35, retain_memory_kb=16384)
- This is LEGITIMATE self-protection behavior, not a bug
- **Lesson:** Under pressure, the service rate-limits via 429 instead of crashing

### Mode: disk_pressure — Run #134 ✅
- 752 reqs, 4 VUs, 2256/2256 checks (100%), 0% http_req_failed
- avg=12.98ms, p95=30.46ms, p99=44.72ms
- Disk I/O at 2048KB per request handled cleanly by OS buffering

### Caveat
cpu_throttle mode exposes a script threshold issue: `expectedStatuses()` should include 429 (like OOM mode includes 502/503/504). Currently 429 is treated as failure even though it's the expected system response under pressure.

## 7. Cách chạy

```powershell
$env:NONK8S_MODE = "cpu_throttle"
$env:NONK8S_VUS = "4"
$env:NONK8S_DURATION_SECONDS = "16"
k6 run -o cloud ...29-nonk8s-prod-approx.js
```
