# obs-03 -- SLO exception under protected capacity

> **Case ID:** `obs-03-pressure-slo-exception`
> **Script:** `load-target/k6/app/29-nonk8s-prod-approx.js`
> **Profile:** `full-no-cdn`, 4 VUs, constant-vus, `cpu_throttle` mode, NO token
> **Proof:** Under CPU/memory pressure, service returns 429. Learner phan biet expected backpressure voi actual failure.

---

## 1. Tinh huong thuc te

He thong dang chay duoi CPU ap luc cao (`cpu_ms=35` + `retain_memory_kb=16384`). Products service bat dau tra ve HTTP 429 (Too Many Requests). Dashboard show:

```text
http_req_failed_rate: 89%
Non-200 responses: 823/923 requests
```

Nhin qua, day la incident nghiem trong -- availability chi ~11%. Nhung:

```text
Day co phai la incident can page on-call luc 3h sang?
Hay la backpressure co chu dich de bao ve service khoi crash?
Hay la capacity signal -- can scale them instance?
```

## 2. Capability

Case nay day learner phan biet 3 loai response trong production:

| Response type | Y nghia | Hanh dong |
| --- | --- | --- |
| **200 OK** | Service xu ly thanh cong | Binh thuong |
| **429 Too Many Requests** | Service tu bao ve, tu choi request de tranh qua tai | Capacity signal -- can scale, khong phai incident |
| **5xx Server Error** | Service that bai that su | Incident -- can page on-call |

**SLO exception framework:**

```text
Green SLO ≠ always green
  → Có những tình huống "red metrics" là expected behavior
  → 429 là service nói "tôi đang tự bảo vệ" -- khác với 500 là "tôi đang chết"
  → SLO exception = ghi nhận backpressure, không tính vào failure SLO
```

## 3. Pass/fail

```text
✅ nonk8s_prod_approx_failures = 0           ← không có actual failure
✅ nonk8s_prod_approx_success_200 > 0        ← service vẫn alive, vẫn xử lý được request
✅ nonk8s_prod_approx_tolerated_errors > 0    ← 429 được ghi nhận là tolerated, không phải failure
⚠️ http_req_failed_rate ~ 89%                ← cao, nhưng expected trong cpu_throttle mode
```

**Quan trong:** `http_req_failed` cao khong co nghia la "system broken." Trong `cpu_throttle` mode, script cau hinh `expectedStatuses: [200, 429]` -- 429 la expected, khong phai failure that su.

## 4. Cach chay

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

$env:NONK8S_MODE = "cpu_throttle"
$env:NONK8S_RUN_ID = "fe-obs-pressure"
$env:NONK8S_VUS = "4"
$env:NONK8S_DURATION_SECONDS = "16"
$env:NONK8S_PRODUCTS_CPU_MS = "35"
$env:NONK8S_RETAIN_MEMORY_KB = "16384"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/29-nonk8s-prod-approx.js
```

### Cac mode khac (tham khao)

```powershell
# Memory pressure -- memory tang cao, quan sat GC behavior
$env:NONK8S_MODE = "memory_pressure"

# Disk pressure -- disk I/O cao, quan sat OS buffering
$env:NONK8S_MODE = "disk_pressure"

# OOM threshold -- memory leo thang den khi OOM
$env:NONK8S_MODE = "oom_threshold"
```

## 5. The SLO exception framework

Khi gap "red metrics," learner ap dung framework 3 buoc:

### Buoc 1: Xac dinh loai response

| Status | Count | La gi? |
| --- | ---: | --- |
| 200 | ~77 | Service van xu ly duoc |
| 429 | ~844 | Service tu bao ve |
| 5xx | 0 | Khong co actual crash |

→ **Ket luan:** Khong phai incident. Day la backpressure.

### Buoc 2: Doc capacity signals

- `nonk8s_prod_approx_tolerated_errors = 844` -- day la expected, script da cau hinh `expectedStatuses: [200, 429]`
- `nonk8s_prod_approx_success_200 > 0` -- service van alive, khong bi crash
- `nonk8s_prod_approx_failures = 0` -- khong co actual failure (5xx, connection refused, timeout)
- Resource chart: CPU saturation tuong ung voi 429 spike

→ **Ket luan:** Service dang tu gioi han de bao ve chinh no. Backpressure hoat dong dung.

### Buoc 3: Ra SLO decision

| SLO | Verdict | Rationale |
| --- | --- | --- |
| SLO-1 Availability | **Exception** | 89% failed rate nhung la 429 expected, khong tinh vao SLO failure |
| SLO-2 Latency p95 | **Exception** | 429 responses co latency thap (tu choi nhanh), khong phai slow processing |
| SLO-3 Capacity | **Signal** | 429 = capacity boundary signal. Can scale them instance hoac giam CPU per request |
| SLO-4 Resource | **Warn** | CPU/Memory dang cao, day la expected trong cpu_throttle mode |

**Tong SLO decision:** Khong phai incident. Day la **capacity planning signal** -- he thong dang hoat dong dung, backpressure dang bao ve service. Can xem xet scale instance hoac toi uu CPU per request.

## 6. Dashboard

Sau khi chay, mo `http://localhost:13001/` → chon run → tab **Production**:

### SLI Cards panel (che do dac biet)
- SLO-1 (Availability): Hien thi ca `http_req_failed_rate` (89%) va `nonk8s_prod_approx_tolerated_errors` (844). Label: "Expected backpressure -- not a failure."
- SLO-2 (Latency): 429 responses co latency rat thap (sub-ms reject). 200 responses van trong SLO.
- SLO-3 (Capacity): Show 429 nhu "protected capacity" -- service tu gioi han thay vi crash.
- SLO-4 (Resource): CPU chart side-by-side voi 429 timeline de thay moi tuong quan.

### Status Breakdown panel
- Pie chart: 200 (xanh) vs 429 (cam -- labeled "backpressure") vs errors (do)
- Trong cpu_throttle: cam chiem da so, xanh la minority, do = 0

### Resource panel
- CPU %: saturation cao (gan 100%) tuong ung voi 429 spike
- Memory: tang do `retain_memory_kb=16384`, khong giai phong (by design)
- Lesson: CPU saturation → 429 responses. Day la causal chain.

## 7. Real validation

**Run #139** (res-04 cpu_throttle mode, 2026-06-25):

| Metric | Value | Y nghia |
| --- | ---: | --- |
| Total requests | 923 | |
| 200 OK | ~77 | Service van alive |
| 429 | ~844 | Backpressure hoat dong |
| 5xx | 0 | Khong crash |
| `nonk8s_prod_approx_failures` | 0 | Khong actual failure |
| `nonk8s_prod_approx_tolerated_errors` | 844 | Tat ca 429 deu duoc tolerate |
| `nonk8s_prod_approx_success_200` | 77 | Co request thanh cong |
| Threshold: `nonk8s_prod_approx_tolerated_errors >= 0` | ✅ pass | Threshold chap nhan tolerated errors |

**Lesson:** 429 responses khong phai la incident. Day la service tu bao ve -- backpressure mechanism hoat dong dung. SLO exception framework cho phep ghi nhan "red metrics" nhu la expected behavior khi co ly do chinh dang (capacity protection).

## 8. Learner exercise

Sau khi chay, learner tu tra loi cac cau hoi:

1. **Doc status breakdown**: Co bao nhieu 200? Bao nhieu 429? Co 5xx khong?
2. **Xac dinh loai response**: 429 la expected backpressure hay actual failure?
3. **Doc resource chart**: CPU saturation co tuong ung voi 429 spike khong?
4. **Ap dung SLO exception framework**: 3 buoc → ket luan gi?
5. **Ra decision**: Day co phai la incident can page on-call khong? Hay la capacity planning signal?
6. **Hanh dong tiep theo**: Neu day la production, ban se lam gi? (scale? optimize? accept?)

## 9. So sanh voi green path (obs-02)

| Khia canh | obs-02 Green | obs-03 Pressure |
| --- | --- | --- |
| http_req_failed_rate | 0% | ~89% |
| Y nghia cua "failed" | Khong co loi | Backpressure co chu dich |
| SLO decision | GREEN | EXCEPTION (capacity signal) |
| Hanh dong | Tiep tuc monitor | Xem xet scale/optimize |
| 429 count | 0 | ~844 (expected) |
