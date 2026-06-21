# Case 03: Login Wave Ingress

> **Executor:** ramping-arrival-rate | **Peak Rate:** 28/s | **Total Iterations (lý thuyết):** ~723 | **Thời lượng:** 45s
> **Trọng tâm:** Auth validation wave — login đồng loạt đầu giờ làm việc, mixed read/write operations, weighted branches.

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [2 yêu cầu cốt lõi](#2-2-yêu-cầu-cốt-lõi)
3. [Vì sao chọn ramping-arrival-rate?](#3-vì-sao-chọn-ramping-arrival-rate)
4. [Phân tích nguyên nhân gốc kỹ thuật](#4-phân-tích-nguyên-nhân-gốc-kỹ-thuật)
5. [Identity model deep-dive](#5-identity-model-deep-dive)
6. [Phân tích open model với wave](#6-phân-tích-open-model-với-wave)
7. [Bảng service/API flow](#7-bảng-serviceapi-flow)
8. [Metrics & tags deep-dive](#8-metrics--tags-deep-dive)
9. [Pass criteria](#9-pass-criteria)
10. [Cách chạy](#10-cách-chạy)
11. [Phân tích output 5 bước](#11-phân-tích-output-5-bước)
12. [Dashboard 3-chart deep analysis](#12-dashboard-3-chart-deep-analysis)
13. [4 output→decision scenarios](#13-4-outputdecision-scenarios)
14. ["Nghịch lý"](#14-nghịch-lý)
15. [Checklist](#15-checklist)
16. [4-5 variations](#16-4-5-variations)
17. [Anti-patterns (mở rộng)](#17-anti-patterns-mở-rộng)
18. [Reference](#18-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh doanh nghiệp

Một tổ chức có **hàng nghìn nhân viên** bắt đầu ngày làm việc lúc **8:00 AM**. Trong khoảng thời gian từ 7:55 đến 8:40, hệ thống authentication trải qua một **login wave** — làn sóng đăng nhập đồng loạt:

- **7:55 – 8:10 (15 giây đầu trong bài test, time scale nén):** Nhân viên bắt đầu đến văn phòng, mở laptop, kết nối VPN. Traffic auth bắt đầu tăng từ mức nền thấp (2 req/s) lên mức trung bình (15 req/s). Đây là giai đoạn **ramp-up buổi sáng**.
- **8:10 – 8:30 (20 giây tiếp theo):** Cao điểm login. Số lượng nhân viên đăng nhập đồng thời tăng mạnh. Traffic auth leo từ 15 req/s lên **28 req/s** — đây là **peak của wave**. Gateway và BFF (Backend For Frontend) gửi token validation requests liên tục.
- **8:30 – 8:40 (10 giây cuối):** Session đã ổn định. Hầu hết nhân viên đã đăng nhập xong, traffic auth giảm dần từ 28 req/s xuống còn 5 req/s (mức nền duy trì session).

**Time scale note:** Trong thực tế, login wave kéo dài 30-45 phút. Bài test nén thời gian xuống 45 giây để có thể chạy nhanh trong CI/CD nhưng vẫn bảo toàn hình dạng wave và tỉ lệ tương đối giữa các giai đoạn.

### 1.2 Tại sao đây là vấn đề kỹ thuật quan trọng?

Auth service là **critical path dependency** — nếu nó chết, toàn bộ hệ thống ngừng hoạt động:

| Hậu quả | Mô tả | Impact |
|---------|------|--------|
| **Login failure cascade** | User không login được → retry → tăng load gấp đôi → auth service càng quá tải | P0 — toàn bộ tổ chức không làm việc được |
| **Token validation timeout** | Các service khác gọi `/auth/me` để validate token → timeout → request chain đứt | P1 — service mesh degradation |
| **Session establishment failure** | Không tạo được session → user bị logout liên tục → IT helpdesk overload | P2 — productivity loss |
| **Write contention** | Login/refresh là POST với DB write → row-level lock contention → latency spike | P2 — degraded UX |

### 1.3 So sánh với các case trước

So với các case ramping-arrival-rate đã phân tích:

| Case | Peak Rate | Pattern | Đặc thù |
|------|-----------|---------|---------|
| **01-smooth-ramp** | 30/s | Tuyến tính, đơn giản | Rate tăng đều, single operation |
| **02-gateway-spike** | 30/s | Spike đột ngột | Rate nhảy gấp từ 5→30/s |
| **03-login-wave-ingress** | 28/s | Wave (tăng-giảm) | Mixed operations, weighted branches, auth-specific |

Case 03 khác biệt ở chỗ: (a) wave shape có cả ramp-up, peak plateau (ngầm), và ramp-down; (b) **3 loại operation khác nhau** với tỉ lệ có trọng số; (c) auth domain mang đặc thù riêng về latency profile và resource consumption.

### 1.4 Mô hình nghiệp vụ auth wave

```
Rate (req/s)
  30 |                          .-- peak zone --.
     |                        .'                  '.
  25 |                      .'                      '.
     |                    .'                          '.
  20 |                  .'                              '.
     |                .'                                  '.
  15 |              .'                                      '.
     |            .'                                          '.
  10 |          .'                                              '.
     |        .'                                                  '.
   5 |      .'                                                      '.
     |    .'                                                          '.
   0 +---+----------+---------------------+----------+--------------+----
     0s          15s                    35s        45s            time
     |-- Stage 1 --|------ Stage 2 ------|-- Stage 3 --|
     | 2→15/s      |   15→28/s           |  28→5/s     |
     | ramp-up     |   sustained climb   |  ramp-down  |
```

**Đặc điểm wave shape:**
- Không có plateau phẳng — rate liên tục thay đổi qua từng stage
- Stage 2 là "sustained climb" — rate tiếp tục tăng trong suốt 20s, không giữ nguyên
- Tổng diện tích dưới curve (total iterations) ≈ 723

---

## 2. 2 yêu cầu cốt lõi

### 2.1 Yêu cầu 1: Sustain auth wave không drop

Hệ thống phải **xử lý toàn bộ login wave** mà không có bất kỳ iteration nào bị drop. Cụ thể:

- **`dropped_iterations = 0`** — toàn bộ 723 iteration được lên lịch phải được thực thi thành công
- Auth service phải duy trì response thành công trong suốt wave, kể cả tại peak 28/s
- Không có hiện tượng `connection refused`, `socket hang up`, hoặc timeout do quá tải

**Tại sao khó:** Wave shape có giai đoạn tăng nhanh (15→28/s trong 20s) đòi hỏi VU pool phải mở rộng kịp thời. Nếu VU allocation không theo kịp rate tăng, iteration sẽ bị queued quá lâu hoặc bị drop.

### 2.2 Yêu cầu 2: Zero drops tại peak 28/s với mixed operations

Tại peak 28/s, auth service phải xử lý đồng thời 3 loại operation:

| Operation | Weight | Requests/s tại peak | Loại | Latency kỳ vọng |
|-----------|--------|--------------------|------|-----------------|
| `GET /api/sim/auth/me` | 75% | 21.0 req/s | Read-only | ~5ms |
| `POST /api/sim/auth/login` | 15% | 4.2 req/s | Write | ~20ms |
| `POST /api/sim/auth/refresh` | 10% | 2.8 req/s | Write | ~10ms |

**Implication:** Dù 75% request là read-only, 25% là write với latency cao hơn 2-4x. Weighted average latency ảnh hưởng đến **W_effective** (effective wait time), từ đó ảnh hưởng đến số VUs cần thiết.

```
W_effective = 0.75 × 5ms + 0.15 × 20ms + 0.10 × 10ms
            = 3.75ms + 3.0ms + 1.0ms
            = 7.75ms (weighted average)

So sánh: Nếu 100% /me (read-only), W_effective = 5ms
         → 55% cao hơn do write operations
```

### 2.3 Bảng tổng hợp yêu cầu

| Yêu cầu | Metric | Target | Criticality |
|---------|--------|--------|-------------|
| REQ-01 | `dropped_iterations` | = 0 | P0 |
| REQ-02 | `http_req_failed` | = 0 (tất cả operations) | P0 |
| REQ-03 | `http_req_duration (p95)` | < 100ms (tất cả operations) | P1 |
| REQ-04 | `http_req_duration (p95)` cho `/me` | < 50ms | P1 |
| REQ-05 | `http_req_duration (p95)` cho `/login` | < 200ms | P2 |
| REQ-06 | `vus` tại peak | <= 35 (maxVUs) | P2 |
| REQ-07 | `iterations` thực tế | ≈ 723 ± 10% | P2 |
| REQ-08 | `login_failure_rate` | = 0% | P0 |

---

## 3. Vì sao chọn ramping-arrival-rate?

### 3.1 Bảng so sánh tất cả executors

| Executor | Model | Rate control | Phù hợp? | Lý do |
|----------|-------|-------------|----------|-------|
| **ramping-arrival-rate** | Open | ✅ Rate được kiểm soát theo stage | **CHỌN** | Wave shape tự nhiên, rate thay đổi theo thời gian, không bị throttle bởi VU availability |
| ramping-vus | Closed | ❌ Rate phụ thuộc vào VU và latency | Không phù hợp | Wave shape bị biến dạng do iteration pacing trong mỗi VU |
| constant-arrival-rate | Open | ✅ Rate cố định | Không phù hợp | Rate cố định không mô phỏng được wave tăng-giảm |
| constant-vus | Closed | ❌ Rate do hệ thống quyết định | Không phù hợp | Không kiểm soát được rate, không tạo được wave shape |
| shared-iterations | Closed | ❌ Iteration được chia đều | Không phù hợp | Không có khái niệm rate, không có wave concept |
| per-vu-iterations | Closed | ❌ Mỗi VU chạy N iterations | Không phù hợp | Không kiểm soát được arrival pattern |
| externally-controlled | External | ✅ Rate được điều khiển từ ngoài | Overkill | Cần external controller, phức tạp không cần thiết cho case này |

### 3.2 Tại sao ramping-arrival-rate là lựa chọn đúng?

**Lý do 1 — Wave shape tự nhiên:** Ramping-arrival-rate cho phép định nghĩa rate thay đổi theo thời gian qua `stages`. Mỗi stage có `duration` và `target`, executor tự động nội suy tuyến tính rate từ target của stage trước đến target của stage hiện tại. Đây chính xác là thứ ta cần để mô phỏng login wave.

**Lý do 2 — Open model không bị self-throttle:** Trong open model, iteration được lên lịch độc lập với việc iteration trước đã hoàn thành chưa. Điều này mô phỏng chính xác thực tế: user không đợi người khác login xong mới login.

**Lý do 3 — Tách biệt rate và VU:** Rate được kiểm soát bởi scheduler, VU chỉ là worker pool. Điều này cho phép phân tích độc lập: "28/s có đạt được không?" (rate) và "35 VUs có đủ cho 28/s không?" (capacity).

**Lý do 4 — Iteration count dự đoán được:** Với mỗi stage, số iteration lý thuyết = diện tích hình thang dưới rate curve. Điều này cho phép estimate chính xác số lượng token validation sẽ được thực hiện, quan trọng cho capacity planning.

### 3.3 So sánh ramping-arrival-rate vs ramping-vus cho auth wave

Đây là so sánh quan trọng vì wave shape có thể implement bằng cả hai executor:

| Khía cạnh | ramping-arrival-rate | ramping-vus |
|-----------|---------------------|-------------|
| **Cách tạo wave** | Định nghĩa rate target qua stages | Định nghĩa VU count qua stages |
| **Rate thực tế** | Bám sát target rate (open model) | Phụ thuộc vào latency của system under test |
| **Tính tất định** | Cao — 723 iterations (lý thuyết) | Thấp — iteration count phụ thuộc vào response time |
| **Phát hiện bottleneck** | Iteration drop hoặc latency tăng | VU tăng nhưng rate không tăng |
| **Mô phỏng user behavior** | Chính xác — user đến độc lập | Không chính xác — user đợi người trước hoàn thành |
| **Auth wave fit** | ✅ Tốt | ❌ Không phù hợp |

**Kết luận:** Ramping-arrival-rate là lựa chọn **duy nhất phù hợp** cho auth wave vì nó mô phỏng đúng bản chất độc lập của user login events.

---

## 4. Phân tích nguyên nhân gốc kỹ thuật

### 4.1 RC1: Wave shape → peak rate sizing, không phải average

**Root cause statement:** Khi thiết kế capacity cho auth service, sai lầm phổ biến là dùng **average rate** (16.1/s) thay vì **peak rate** (28/s). Peak rate quyết định số VUs cần thiết, không phải average.

**Stage math chi tiết:**

```
Stage 1: startRate=2, target=15, duration=15s
  - Rate tại t=0s:  2.0/s
  - Rate tại t=15s: 15.0/s
  - Hàm rate: r1(t) = 2 + (15-2)×(t/15) = 2 + 13t/15
  - Diện tích: ∫(0→15) (2 + 13t/15) dt = [2t + 13t²/30]₀¹⁵
             = 2×15 + 13×225/30 = 30 + 97.5 = 127.5 iterations

Stage 2: startRate=15 (kế thừa từ stage 1), target=28, duration=20s
  - Rate tại t=15s: 15.0/s
  - Rate tại t=35s: 28.0/s
  - Hàm rate: r2(t) = 15 + (28-15)×((t-15)/20) = 15 + 13(t-15)/20
  - Diện tích: ∫(15→35) (15 + 13(t-15)/20) dt
             = [15t + 13(t-15)²/40]₁₅³⁵
             = 15×35 + 13×400/40 - 15×15 - 0
             = 525 + 130 - 225 = 430.0 iterations

Stage 3: startRate=28 (kế thừa từ stage 2), target=5, duration=10s
  - Rate tại t=35s: 28.0/s
  - Rate tại t=45s: 5.0/s
  - Hàm rate: r3(t) = 28 + (5-28)×((t-35)/10) = 28 - 23(t-35)/10
  - Diện tích: ∫(35→45) (28 - 23(t-35)/10) dt
             = [28t - 23(t-35)²/20]₃₅⁴⁵
             = 28×45 - 23×100/20 - 28×35 + 0
             = 1260 - 115 - 980 = 165.0 iterations

Tổng iterations (lý thuyết) = 127.5 + 430 + 165 = 722.5 ≈ 723
```

**Peak rate implication cho VU sizing:**

```
VUs cần thiết (theo Little's Law):
  VUs_min ≈ ceil(peak_rate × W_effective)

Với W_effective = 7.75ms (từ RC5):
  VUs_min ≈ ceil(28 × 0.00775) = ceil(0.217) = 1 VU (!)

Điều này nghe có vẻ quá thấp, nhưng đó là lý thuyết với latency lý tưởng.
Thực tế cần margin cho:
  - Network jitter (thêm 2-5ms)
  - Connection establishment (thêm 1-3ms)
  - Auth service internal queue (thêm 2-10ms khi tải cao)
  - TCP/TLS overhead (thêm 1-2ms)

W_thực_tế ≈ 7.75 + 5 + 3 + 10 + 2 = 27.75ms (worst case estimate)
VUs_thực_tế ≈ ceil(28 × 0.02775) = ceil(0.777) → vẫn dưới 1 VU

Nhưng đây là sequential model. Thực tế với concurrency:
  VUs cần ≈ ceil(peak_rate × W) × safety_factor
  Với safety_factor = 1.5-2.0 cho auth wave (biến động latency):
  VUs ≈ ceil(28 × 0.02775) × 1.5 ≈ 2 VUs (quá thấp)

→ Có vẻ như 10 preAllocatedVUs và 35 maxVUs là DƯ THỪA?
   KHÔNG. Lý do: latency thực tế có thể cao hơn nhiều khi auth service
   chịu write pressure từ login/refresh. Xem RC2.
```

**Bảng per-second rate trace qua wave climb (selected timestamps):**

| Time (s) | Stage | Rate (req/s) | Cumulative iterations (lý thuyết) | Delta từ giây trước |
|----------|-------|-------------|----------------------------------|---------------------|
| 0 | 1 | 2.0 | 0.0 | — |
| 1 | 1 | 2.87 | 2.4 | 2.4 |
| 2 | 1 | 3.73 | 5.7 | 3.3 |
| 3 | 1 | 4.60 | 9.9 | 4.2 |
| 4 | 1 | 5.47 | 14.9 | 5.0 |
| 5 | 1 | 6.33 | 20.8 | 5.9 |
| 6 | 1 | 7.20 | 27.6 | 6.8 |
| 7 | 1 | 8.07 | 35.2 | 7.6 |
| 8 | 1 | 8.93 | 43.7 | 8.5 |
| 9 | 1 | 9.80 | 53.1 | 9.4 |
| 10 | 1 | 10.67 | 63.3 | 10.2 |
| 11 | 1 | 11.53 | 74.4 | 11.1 |
| 12 | 1 | 12.40 | 86.4 | 12.0 |
| 13 | 1 | 13.27 | 99.2 | 12.8 |
| 14 | 1 | 14.13 | 112.9 | 13.7 |
| 15 | 2 | 15.00 → 15.65 | 127.5 | 14.6 |
| 16 | 2 | 16.30 | 143.4 | 15.9 |
| 17 | 2 | 16.95 | 160.0 | 16.6 |
| 18 | 2 | 17.60 | 177.3 | 17.3 |
| 19 | 2 | 18.25 | 195.2 | 17.9 |
| 20 | 2 | 18.90 | 213.8 | 18.6 |
| 21 | 2 | 19.55 | 233.0 | 19.2 |
| 22 | 2 | 20.20 | 252.9 | 19.9 |
| 23 | 2 | 20.85 | 273.4 | 20.5 |
| 24 | 2 | 21.50 | 294.6 | 21.2 |
| 25 | 2 | 22.15 | 316.4 | 21.8 |
| 26 | 2 | 22.80 | 338.9 | 22.5 |
| 27 | 2 | 23.45 | 362.0 | 23.1 |
| 28 | 2 | 24.10 | 385.8 | 23.8 |
| 29 | 2 | 24.75 | 410.2 | 24.4 |
| 30 | 2 | 25.40 | 435.3 | 25.1 |
| 31 | 2 | 26.05 | 461.0 | 25.7 |
| 32 | 2 | 26.70 | 487.4 | 26.4 |
| 33 | 2 | 27.35 | 514.4 | 27.0 |
| 34 | 2 | 28.00 (peak-1s) | 542.1 | 27.7 |
| 35 | 3 | 28.00 → 25.70 | 557.5 | 28.0 |
| 36 | 3 | 23.00 | 581.9 | 24.4 |
| 37 | 3 | 20.30 | 603.5 | 21.6 |
| 38 | 3 | 17.60 | 622.5 | 19.0 |
| 39 | 3 | 14.90 | 638.7 | 16.2 |
| 40 | 3 | 12.20 | 652.3 | 13.6 |
| 41 | 3 | 9.50 | 663.1 | 10.8 |
| 42 | 3 | 6.80 | 671.3 | 8.2 |
| 43 | 3 | 5.00 (target) | 677.2 | 5.9 |
| 44 | 3 | 5.00 | 682.2 | 5.0 |
| 45 | 3 | 5.00 | 687.2 | 5.0 |

> **Note:** Bảng trace trên là xấp xỉ tuyến tính. Thực tế, arrival rate được scheduler nội suy tuyến tính liên tục giữa các target. Rate tại mỗi giây là giá trị trung bình trong giây đó. Cumulative iterations có thể khác biệt nhỏ do cơ chế làm tròn của scheduler.

### 4.2 RC2: Auth write operations (login/refresh) tạo W_effective cao hơn tại peak

**Root cause statement:** Login (POST) và refresh (POST) là write operations — chúng ghi vào database (session table, refresh token table). Tại peak 28/s, dù login chỉ chiếm 15% (4.2 req/s) và refresh 10% (2.8 req/s), write pressure có thể tạo latency spike do:

1. **Database write contention:** Nhiều login đồng thời → row-level lock trên session table → queue trong DB
2. **BCrypt/Argon2 hash:** Login yêu cầu verify password hash → CPU-intensive operation
3. **Token generation:** JWT signing hoặc opaque token generation → crypto operation
4. **Write-ahead logging:** DB WAL flush mỗi write → I/O pressure

**Latency profile breakdown theo operation:**

| Operation | CPU | Memory | DB Read | DB Write | Network | Latency (p50) | Latency (p95) | Latency (p99) |
|-----------|-----|--------|---------|----------|---------|---------------|---------------|---------------|
| `/me` (GET, read) | Thấp | Thấp | 1 (token lookup) | 0 | 1 round-trip | 3ms | 8ms | 15ms |
| `/login` (POST, write) | Cao (hash) | Trung bình | 1 (user lookup) | 2 (session + refresh token) | 1 round-trip | 15ms | 35ms | 80ms |
| `/refresh` (POST, write) | Trung bình | Thấp | 1 (token lookup) | 2 (rotate refresh + new access) | 1 round-trip | 8ms | 18ms | 40ms |

**W_effective recalculation với p95 latency (worst-case planning):**

```
W_effective_p95 = 0.75 × 8ms + 0.15 × 35ms + 0.10 × 18ms
                = 6.0ms + 5.25ms + 1.8ms
                = 13.05ms

VUs_min_p95 = ceil(28 × 0.01305) = ceil(0.365) = 1 VU (lý thuyết)

Nhưng với safety factor 2.0 và margin 10ms cho network + queue:
W_planning = 13.05 + 10 = 23.05ms
VUs_planning = ceil(28 × 0.02305) × 2.0 = ceil(0.645) × 2.0 = 2 VUs
```

**Tại sao con số VUs tính ra thấp?** Vì latency của auth operations giả định trong bài test là **simulated** với độ trễ thấp (môi trường test cục bộ). Trong production, latency có thể cao hơn 10-50x do:
- Network latency giữa các service
- Database ở xa (cross-AZ)
- Connection pool saturation
- Cold start của lambda/container

**PreAllocatedVUs=10 và maxVUs=35 là buffer an toàn.** Với W thực tế production có thể lên đến 200-500ms, ta cần:

```
VUs_production = ceil(28 × 0.300) = ceil(8.4) = 9 VUs
Với maxVUs=35, có thể handle W lên đến 35/28 = 1.25s
→ Đủ buffer cho hầu hết tình huống.
```

### 4.3 RC3: Spawn timing — VU pool phải mở rộng trong lúc 15→28/s climb

**Root cause statement:** Ramping-arrival-rate scheduler lên lịch iteration dựa trên target rate. Nếu VU pool không có sẵn VU khi iteration được lên lịch, iteration sẽ bị **queued** hoặc **dropped**. Giai đoạn nguy hiểm nhất là Stage 2 khi rate tăng từ 15→28/s trong 20s.

**Timeline VU demand:**

```
Giai đoạn          | Rate range | VUs cần (W=23ms) | VUs cần (W=100ms) | VUs cần (W=300ms)
-------------------|------------|-------------------|--------------------|-------------------
Stage 1 (2→15/s)   | 2-15/s    | 1                 | 2                  | 5
Stage 2 (15→28/s)  | 15-28/s   | 1                 | 3                  | 9
Stage 3 (28→5/s)   | 28-5/s    | 1                 | 3→1                | 9→2
```

**Critical period: t=15s đến t=35s (Stage 2)**
- Rate tăng 13/s trong 20s → mỗi giây tăng 0.65 req/s
- VU demand tăng dần khi rate tăng
- `preAllocatedVUs=10` đảm bảo 10 VUs sẵn sàng ngay từ đầu → không cần spawn thêm trong hầu hết trường hợp
- `maxVUs=35` cho phép mở rộng lên đến 35 VUs nếu latency thực tế cao hơn dự kiến

**Spawn timing diagram:**

```
VUs active
  35 |                                    .....maxVUs ceiling
     |                                  ..
  30 |                                ..
     |                              ..
  25 |                            ..
     |                          ..
  20 |                        ..
     |                      ..
  15 |                    ..
     |                  ..
  10 |................--------------------------------------  preAllocatedVUs
     |
   5 |
     |
   0 +---+----------+---------------------+----------+-----+
     0s          15s                    35s        45s

  --- : VUs pre-allocated (available immediately)
  ... : VUs dynamically spawned if needed (up to maxVUs)
```

**Điều gì xảy ra nếu VU allocation chậm hơn rate increase?**

| Tình huống | Triệu chứng | Root cause | Fix |
|-----------|-------------|------------|-----|
| VU pool cạn kiệt | `dropped_iterations > 0` | maxVUs quá thấp hoặc spawn quá chậm | Tăng maxVUs hoặc preAllocatedVUs |
| Iteration queued lâu | `iteration_duration (p95)` tăng đột biến | VU đang bận, iteration phải đợi | Tăng maxVUs hoặc giảm rate target |
| CPU saturation | `http_req_duration` tăng, VUs đạt max | System under test bottleneck | Scale up auth service, không phải VUs |

### 4.4 RC4: Ramp-down — in-flight iterations sau peak

**Root cause statement:** Khi rate giảm từ 28/s xuống 5/s trong Stage 3 (10s), các iteration đã được lên lịch nhưng chưa hoàn thành vẫn tiếp tục chạy. Điều này tạo ra **in-flight iteration tail** — số iteration thực tế trong Stage 3 có thể cao hơn lý thuyết.

**In-flight iteration calculation:**

```
Tại t=35s (bắt đầu Stage 3):
  - Rate hiện tại: 28/s
  - Iteration đang in-flight ≈ rate × W_effective = 28 × 0.023 = 0.64 → ~1 iteration
  - Nhưng thực tế có thể có queue do scheduler batch → 2-5 iterations

Tại t=35s đến t=38s (3s đầu ramp-down):
  - Rate vẫn cao (28→21.1/s)
  - Mỗi giây scheduled ~21-28 iterations
  - Các iteration này có W_effective ≈ 23ms
  - Chúng hoàn thành trong khoảng t=35.023 đến t=38.023

→ "Tail" iteration hoàn thành sau khi test kết thúc là bình thường
→ Số iteration thực tế trong Stage 3 hơi cao hơn 165 (lý thuyết)
```

**Phân tích ramp-down behavior:**

```
Rate (req/s)          Actual iterations completing
  30 |                   /|\
     |                  / | \
  25 |                 /  |  \_____ in-flight tail
     |                /   |         (iterations hoàn thành
  20 |               /    |          sau khi rate đã giảm)
     |              /     |
  15 |             /      |
     |            /       |
  10 |           /        |
     |          /         |
   5 |         /          |
     |        /           |
   0 +-------+------------+-------------------
     0s     35s          45s    45.1s   45.2s

  Scheduled rate (solid line) vs actual completion rate (dashed)
```

**Hệ quả thực tế:**

| Metric | Lý thuyết | Thực tế (có in-flight tail) | Sai khác |
|--------|-----------|---------------------------|----------|
| Iterations Stage 3 | 165 | 168-175 | +2-6% |
| Tổng iterations | 723 | 725-733 | +0.3-1.4% |
| `iteration_duration` cuối test | N/A | Có thể có vài iteration >1s | Do queue + late scheduling |

**Cách xử lý:**
- `gracefulStop`: Cho phép in-flight iterations hoàn thành (không drop)
- `gracefulRampDown`: Giảm rate từ từ thay vì cắt đột ngột
- Đọc `iterations` metric thực tế thay vì so sánh cứng với 723

### 4.5 RC5: Diff latency profiles — `/me` fast, login slow — weighted W_effective

**Root cause statement:** Auth service có 3 endpoint với latency profile khác nhau rõ rệt. Khi tính toán capacity, dùng **uniform latency** sẽ dẫn đến underestimate VU requirement. Cần dùng **weighted average latency** dựa trên traffic mix thực tế.

**Latency profile matrix (simulated environment):**

| Endpoint | Method | Weight | p50 (ms) | p95 (ms) | p99 (ms) | CPU profile | DB ops | Notes |
|----------|--------|--------|----------|----------|----------|-------------|--------|-------|
| `/api/sim/auth/me` | GET | 0.75 | 3 | 8 | 15 | I/O bound | 1 SELECT | Token validation, stateless |
| `/api/sim/auth/login` | POST | 0.15 | 15 | 35 | 80 | CPU bound | 1 SELECT + 2 INSERT | Password verify + session create |
| `/api/sim/auth/refresh` | POST | 0.10 | 8 | 18 | 40 | Mixed | 1 SELECT + 2 UPDATE | Token rotation |
| **Weighted avg** | | | **5.55** | **13.05** | **28.25** | | | |

**Công thức tổng quát weighted W_effective:**

```
W_effective = Σ (weight_i × latency_i) cho i = 1..n

Với latency metric:
  - Planning (lạc quan): dùng p50
  - Planning (an toàn): dùng p95
  - Stress test: dùng p99

W_eff_p50 = 0.75×3 + 0.15×15 + 0.10×8 = 2.25 + 2.25 + 0.80 = 5.30ms
W_eff_p95 = 0.75×8 + 0.15×35 + 0.10×18 = 6.00 + 5.25 + 1.80 = 13.05ms
W_eff_p99 = 0.75×15 + 0.15×80 + 0.10×40 = 11.25 + 12.0 + 4.0 = 27.25ms
```

**VU requirement theo từng latency percentile:**

| Latency percentile | W_effective | VUs_min (28/s) | VUs với safety=2.0 | VUs với safety=3.0 |
|--------------------|-------------|----------------|---------------------|---------------------|
| p50 | 5.30ms | 1 | 1 | 1 |
| p95 | 13.05ms | 1 | 1 | 2 |
| p99 | 27.25ms | 1 | 2 | 3 |

**Kết luận RC5:** Với latency thấp trong môi trường simulated, VU requirement rất thấp. `preAllocatedVUs=10` và `maxVUs=35` là generous margin cho phép test chạy ổn định và sẵn sàng cho production-like latency (có thể lên đến 200-500ms).

**Worked example — production latency scenario:**

```
Giả sử production latency (cross-AZ, DB remote):
  /me:     p95 = 50ms
  /login:  p95 = 200ms (hash + DB write cross-AZ)
  /refresh: p95 = 100ms

W_eff_prod = 0.75×50 + 0.15×200 + 0.10×100
           = 37.5 + 30.0 + 10.0
           = 77.5ms

VUs_prod = ceil(28 × 0.0775) = ceil(2.17) = 3 VUs (lý thuyết)
VUs_prod_safe = ceil(28 × 0.0775) × 2.5 = 6 VUs (với safety margin)

→ Với maxVUs=35, hệ thống có capacity gấp ~6 lần so với cần thiết
→ Có thể tăng rate target lên 28×(35/6) ≈ 163/s nếu auth service scale được
```

---

## 5. Identity model deep-dive

### 5.1 Auth user identity trong bài test

Auth domain có **identity model** khác biệt so với các domain khác. Trong case này, identity là **authenticated user** với các thuộc tính:

| Thuộc tính | Mô tả | Cách tạo trong test | Impact |
|-----------|-------|-------------------|--------|
| **User ID** | Unique identifier của user | UUID hoặc sequential ID từ pool | Mỗi user có session riêng |
| **Access Token** | JWT hoặc opaque token | Được cấp sau login, dùng cho `/me` | Token validation overhead |
| **Refresh Token** | Long-lived token để rotate | Được cấp cùng access token, dùng cho `/refresh` | Token rotation logic |
| **Session State** | Trạng thái session trong DB | Được tạo khi login, update khi refresh | Write pressure |
| **Role/Permissions** | RBAC claims trong token | Có thể được embed trong token payload | Token size ảnh hưởng latency |

### 5.2 Token lifecycle trong wave

```
[User mở app]
     |
     v
[POST /login] ─────────────────────────────────────┐
     |                                              │
     |-- (1) Verify credentials (hash check)        │
     |-- (2) CREATE session row in DB               │
     |-- (3) GENERATE access token (JWT sign)       │ Login Flow
     |-- (4) GENERATE refresh token                 │ (15% traffic)
     |-- (5) RETURN {access_token, refresh_token}   │
     |                                              │
     v                                              │
[App gọi API với access_token]                       │
     |                                              │
     v                                              │
[GET /me] ──────────────────────────────────────────┤
     |                                              │ Auth Validation
     |-- (1) VERIFY token signature                 │ (75% traffic)
     |-- (2) CHECK expiration                       │
     |-- (3) RETURN user info                       │
     |                                              │
     v                                              │
[Khi access_token hết hạn]                           │
     |                                              │
     v                                              │
[POST /refresh] ────────────────────────────────────┘
     |                                              Token Rotation
     |-- (1) VALIDATE refresh token                 (10% traffic)
     |-- (2) ROTATE refresh token (update DB)
     |-- (3) ISSUE new access token
     |-- (4) RETURN {new_access_token, new_refresh_token}
```

### 5.3 Identity distribution trong wave

Trong login wave, phân phối identity events không đều:

| Giai đoạn | Dominant operation | Lý do |
|-----------|-------------------|-------|
| **Stage 1 (ramp-up)** | Login (POST) chiếm tỉ lệ cao hơn 15% | User mới đến → cần login trước |
| **Stage 2 (peak)** | `/me` (GET) chiếm ưu thế | Đã login → app gọi API thường xuyên |
| **Stage 3 (ramp-down)** | `/me` (GET) + refresh (POST) | Token sắp hết hạn với early arrivers |

**Modulation của weights theo thời gian (thực tế):**

```
Stage 1: Login bias
  - /me: 60%, /login: 25%, /refresh: 15%
  - Lý do: User mới cần login, refresh token cũ cũng cần rotate

Stage 2: Steady state bias
  - /me: 75%, /login: 15%, /refresh: 10%
  - Lý do: Đa số đã login, app hoạt động bình thường

Stage 3: Refresh bias
  - /me: 70%, /login: 10%, /refresh: 20%
  - Lý do: Một số token hết hạn, cần refresh; ít user mới login
```

> **Note:** Trong config của case này, weights được giữ cố định 75/15/10 để đơn giản hóa. Trong thực tế, có thể dùng `scenario.weights` hoặc custom logic trong script để modulate weights theo stage. Đây là một variation tiềm năng (xem Section 16).

### 5.4 Token patterns và test data

| Pattern | Mô tả | Data strategy |
|---------|-------|--------------|
| **Valid access token** | Token chưa hết hạn, signature đúng | Pre-generate hoặc lấy từ login response |
| **Expired access token** | Token hết hạn → trigger refresh | Set TTL ngắn trong test |
| **Revoked refresh token** | Refresh token bị revoke → force re-login | Edge case, có thể là variation |
| **Concurrent sessions** | Cùng user login từ nhiều thiết bị | Multiple VUs dùng chung user ID |

---

## 6. Phân tích open model với wave

### 6.1 Open model recap

Trong **open model** (ramping-arrival-rate), iteration arrival được kiểm soát bởi scheduler, không phụ thuộc vào việc iteration trước đã hoàn thành chưa:

```
Scheduler: "Tại thời điểm t, cần tạo N iteration mới với rate r(t)"
       │
       ▼
┌──────────────────────────────────────────────┐
│              Iteration Queue                  │
│  [iter_1] [iter_2] [iter_3] ... [iter_N]     │
└──────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│              VU Pool (Worker Pool)            │
│  [VU_1: busy] [VU_2: idle] ... [VU_M: busy]  │
└──────────────────────────────────────────────┘
       │
       ▼
  Nếu VU idle có sẵn → pick iteration từ queue → execute
  Nếu tất cả VU busy → iteration chờ trong queue
  Nếu queue full hoặc timeout → iteration bị DROP
```

**Đặc điểm quan trọng của open model trong auth wave:**
- Iteration được tạo ra với rate r(t) **bất kể** system under test có đáp ứng kịp không
- Nếu auth service chậm, iteration vẫn được tạo → queue dài ra → latency tăng
- Đây là **stress test thực sự** — nó mô phỏng user không đợi nhau

### 6.2 Step-by-step qua từng stage

#### Stage 1: Ramp-up (0s → 15s, 2/s → 15/s)

```
Timeline (mỗi giây):

t=0.0:  Scheduler bắt đầu, rate=2/s
        → 2 iteration được scheduled trong giây đầu tiên
        → VU pool có sẵn 10 VUs (preAllocatedVUs)
        → Mỗi iteration được pick ngay, execute, hoàn thành trong ~8ms

t=1.0:  Rate=2.87/s → ~3 iterations
t=2.0:  Rate=3.73/s → ~4 iterations
...
t=14.0: Rate=14.13/s → ~14 iterations
t=15.0: Rate=15.0/s → ~15 iterations

Trạng thái cuối Stage 1:
  - ~127 iterations đã được scheduled
  - ~127 iterations đã hoàn thành
  - 0 dropped iterations
  - VUs: 1-2 active (do W_effective thấp)
  - Auth service: chưa có dấu hiệu stress
```

#### Stage 2: Sustained climb (15s → 35s, 15/s → 28/s)

```
t=15.0: Rate=15.0/s → bắt đầu Stage 2
        Rate bắt đầu tăng từ 15/s

t=20.0: Rate=18.25/s → ~18 iterations/s
        Auth service vẫn ổn, latency chưa tăng

t=25.0: Rate=22.15/s → ~22 iterations/s
        Đây là lúc write pressure bắt đầu tích lũy:
        - 15% của 22/s = 3.3 login/s → mỗi login ghi 2 rows
        - 10% của 22/s = 2.2 refresh/s → mỗi refresh update 2 rows
        - Tổng DB writes/s = 3.3×2 + 2.2×2 = 6.6 + 4.4 = 11 writes/s
        - Nếu auth service dùng SQLite hoặc single DB, write contention bắt đầu

t=30.0: Rate=25.40/s → ~25 iterations/s
        DB writes/s = 25.4 × (0.15×2 + 0.10×2) = 25.4 × 0.5 = 12.7 writes/s
        Latency có thể bắt đầu tăng nhẹ (p95 từ 8ms → 12ms cho /me)

t=34.0: Rate=28.0/s → PEAK
        ~28 iterations/s
        DB writes/s = 28 × 0.5 = 14 writes/s
        Đây là stress point:
        - Nếu auth service xử lý được: latency ổn định, 0 drops
        - Nếu auth service bottleneck: latency tăng → iteration queue dài → potential drops

t=35.0: Kết thúc Stage 2
        ~430 iterations đã được scheduled trong stage này
        Tổng ~557 iterations từ đầu test
```

**Write pressure analysis tại peak:**

| Metric | Giá trị tại peak (28/s) | Ghi chú |
|--------|------------------------|---------|
| `/me` requests/s | 21.0 | Read-only, không write DB |
| `/login` requests/s | 4.2 | 2 DB writes mỗi request → 8.4 writes/s |
| `/refresh` requests/s | 2.8 | 2 DB writes mỗi request → 5.6 writes/s |
| **Total DB writes/s** | **14.0** | Đây là write amplification factor |
| **Read/write ratio** | 21:14 = **1.5:1** | Cao hơn vẻ ngoài (tưởng 75:25 = 3:1) |

> **Key insight:** Dù chỉ 25% requests là POST, write amplification khiến mỗi POST tạo 2 DB writes → tỉ lệ read:write thực tế là 21:14 = 1.5:1, không phải 3:1. Đây là lý do auth service có thể bị write-bound dù traffic read-dominant.

#### Stage 3: Ramp-down (35s → 45s, 28/s → 5/s)

```
t=35.0: Rate=28/s → bắt đầu giảm
        Scheduler giảm rate xuống 25.7/s trong giây đầu của stage

t=36.0: Rate=23.0/s
t=37.0: Rate=20.3/s
t=38.0: Rate=17.6/s
t=39.0: Rate=14.9/s
t=40.0: Rate=12.2/s
t=41.0: Rate=9.5/s
t=42.0: Rate=6.8/s
t=43.0: Rate=5.0/s → đạt target
t=44.0: Rate=5.0/s (giữ ổn định)
t=45.0: Rate=5.0/s → test kết thúc

Trạng thái cuối Stage 3:
  - ~165 iterations được scheduled trong stage này
  - Có thể có 2-5 iterations "in-flight" hoàn thành sau t=45s
  - Tổng iterations thực tế: 720-730
```

### 6.3 Queue dynamics trong open model wave

```
Queue length (số iteration đang chờ VU)
  5 |                          .
    |                        .   .
  4 |                      .       .
    |                    .           .
  3 |                  .               .
    |                .                   .
  2 |              .                       .
    |            .                           .
  1 |          .                               .
    |        .                                   .
  0 |.......                                       .......
    +---+----------+---------------------+----------+-----+
    0s          15s                    35s        45s

  Queue tăng khi: arrival rate > completion rate (= VUs / W_effective)
  Queue giảm khi: arrival rate < completion rate
```

**Khi nào queue build-up nguy hiểm?**

```
Completion rate = số VUs khả dụng / W_effective

Với 10 preAllocatedVUs và W_effective = 13.05ms:
  Max completion rate = 10 / 0.01305 ≈ 766/s → vượt xa peak 28/s

Với 10 VUs và W_effective = 200ms (production worst case):
  Max completion rate = 10 / 0.200 = 50/s → vẫn > 28/s

Với 5 VUs và W_effective = 200ms:
  Max completion rate = 5 / 0.200 = 25/s → < 28/s peak → QUEUE BUILD-UP!
```

### 6.4 Bảng tổng hợp stage dynamics

| Stage | Duration | Rate range | Iterations (lý thuyết) | Avg rate | Write pressure (writes/s) | Queue risk |
|-------|----------|------------|----------------------|----------|--------------------------|------------|
| 1 | 15s | 2→15/s | 127.5 | 8.5/s | 0.6→4.5 | Thấp |
| 2 | 20s | 15→28/s | 430.0 | 21.5/s | 4.5→14.0 | Trung bình-cao |
| 3 | 10s | 28→5/s | 165.0 | 16.5/s | 14.0→2.5 | Giảm dần |
| **Tổng** | **45s** | | **722.5** | **16.1/s** | | |

---

## 7. Bảng service/API flow

### 7.1 Service topology

```
                       ┌──────────────────┐
                       │   Load Balancer  │
                       │   (nginx/ALB)    │
                       └────────┬─────────┘
                                │
                  ┌─────────────┼─────────────┐
                  │             │             │
                  v             v             v
          ┌──────────┐  ┌──────────┐  ┌──────────┐
          │ Auth Svc  │  │ Auth Svc  │  │ Auth Svc  │
          │ Instance 1│  │ Instance 2│  │ Instance 3│
          └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
                │              │              │
                └──────────────┼──────────────┘
                               │
                               v
                      ┌────────────────┐
                      │   Auth DB      │
                      │ (PostgreSQL/   │
                      │  MySQL/SQLite) │
                      └────────────────┘
```

### 7.2 API endpoint catalog

| # | Endpoint | Method | Weight | Mục đích | Request body | Response body | Auth required |
|---|----------|--------|--------|----------|-------------|---------------|---------------|
| 1 | `/api/sim/auth/me` | GET | 75% | Validate access token + lấy user info | (none — token in header) | `{id, email, roles, exp}` | Bearer token |
| 2 | `/api/sim/auth/login` | POST | 15% | Xác thực credentials + cấp token | `{email, password}` | `{access_token, refresh_token, expires_in}` | None (login) |
| 3 | `/api/sim/auth/refresh` | POST | 10% | Rotate refresh token + cấp access token mới | `{refresh_token}` | `{access_token, refresh_token, expires_in}` | Refresh token |

### 7.3 Weighted branch execution flow

```
Iteration bắt đầu
       │
       ▼
┌─────────────────────────────┐
│  Random weight selection    │
│  (75% /me | 15% login |     │
│   10% refresh)              │
└────────────┬────────────────┘
             │
     ┌───────┼────────┐
     │       │        │
     v       v        v
  75%        15%      10%
┌──────┐ ┌──────┐ ┌────────┐
│ /me  │ │/login│ │/refresh│
│ GET  │ │ POST │ │ POST   │
└──┬───┘ └──┬───┘ └───┬────┘
   │        │          │
   │        │          │
   v        v          v
┌──────────────────────────┐
│  Collect custom metrics  │
│  ramping_arrival_events_*│
└──────────────────────────┘
```

### 7.4 Request/Response examples

**GET /api/sim/auth/me:**
```http
GET /api/sim/auth/me HTTP/1.1
Host: localhost:3080
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Accept: application/json

Response 200:
{
  "id": "usr_a1b2c3d4",
  "email": "user@example.com",
  "roles": ["employee"],
  "exp": 1719000000
}
```

**POST /api/sim/auth/login:**
```http
POST /api/sim/auth/login HTTP/1.1
Host: localhost:3080
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "test_password_123"
}

Response 200:
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "rft_a1b2c3d4e5f6...",
  "expires_in": 3600
}
```

**POST /api/sim/auth/refresh:**
```http
POST /api/sim/auth/refresh HTTP/1.1
Host: localhost:3080
Content-Type: application/json

{
  "refresh_token": "rft_a1b2c3d4e5f6..."
}

Response 200:
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "rft_new_x1y2z3...",
  "expires_in": 3600
}
```

### 7.5 DB operations per endpoint

| Endpoint | DB Reads | DB Writes | Tables touched | Index used |
|----------|----------|-----------|----------------|------------|
| `/me` | 1 (SELECT token) | 0 | `access_tokens` | `token_hash_idx` |
| `/login` | 1 (SELECT user) | 2 (INSERT session + INSERT refresh_token) | `users`, `sessions`, `refresh_tokens` | `email_idx`, `user_id_idx` |
| `/refresh` | 1 (SELECT refresh_token) | 2 (UPDATE refresh_token + INSERT access_token) | `refresh_tokens`, `access_tokens` | `token_hash_idx` |

### 7.6 Custom metrics mapping

| Custom metric | Mapped to | Loại | Tag |
|---------------|-----------|------|-----|
| `ramping_arrival_events_total` | Tổng số iteration đã thực thi | Counter | `operation`, `stage` |
| `ramping_arrival_events_rate` | Iteration rate thực tế | Gauge | `operation` |
| `ramping_arrival_events_duration` | Thời gian mỗi iteration | Trend | `operation`, `stage` |
| `ramping_arrival_events_dropped` | Số iteration bị drop | Counter | `reason` |
| `ramping_arrival_events_vus` | Số VUs đang active | Gauge | |

---

## 8. Metrics & tags deep-dive

### 8.1 Built-in metrics cần theo dõi

| Metric | Type | Ý nghĩa trong auth wave | Ngưỡng cảnh báo |
|--------|------|------------------------|-----------------|
| `http_req_duration` | Trend | Latency của từng HTTP request, phân biệt theo endpoint | p95 > 100ms |
| `http_req_failed` | Rate | Tỉ lệ request thất bại (4xx, 5xx, timeout) | > 0% |
| `http_reqs` | Counter | Tổng số request đã gửi | So sánh với expected iterations |
| `iterations` | Counter | Tổng số iteration đã hoàn thành | ≈ 723 |
| `vus` | Gauge | Số VU đang active tại mỗi thời điểm | ≤ 35 |
| `vus_max` | Gauge | Số VU tối đa đã được sử dụng | ≤ 35 |
| `dropped_iterations` | Counter | Số iteration bị scheduler drop | = 0 |
| `iteration_duration` | Trend | Thời gian hoàn thành mỗi iteration (từ schedule đến done) | p95 < 200ms |
| `data_sent` | Counter | Tổng dữ liệu gửi đi | Monitoring bandwidth |
| `data_received` | Counter | Tổng dữ liệu nhận về | Monitoring bandwidth |
| `checks` | Rate | Tỉ lệ checks passed | 100% |

### 8.2 Tag strategy cho auth operations

```
http_req_duration được tag với:
  - method: GET | POST
  - url: /api/sim/auth/me | /api/sim/auth/login | /api/sim/auth/refresh
  - status: 200 | 201 | 400 | 401 | 500
  - expected_response: true | false
  - scenario: loginWaveIngress
  - group: auth::me | auth::login | auth::refresh

Phân tích theo tag:
  - http_req_duration{url="/api/sim/auth/login"} → login latency riêng
  - http_req_duration{url="/api/sim/auth/me"} → token validation latency riêng
  - http_req_failed{url="/api/sim/auth/login"} → login failure rate
```

### 8.3 Custom metrics deep-dive

**`ramping_arrival_events_total`** — tổng số auth events:
```
Phân rã:
  ramping_arrival_events_total{operation="me"}      ≈ 723 × 0.75 = 542
  ramping_arrival_events_total{operation="login"}   ≈ 723 × 0.15 = 108
  ramping_arrival_events_total{operation="refresh"} ≈ 723 × 0.10 = 72

Kiểm tra tỉ lệ:
  actual_me_pct = me_count / total_count
  → Nếu lệch >5% so với 75%, weight distribution có vấn đề
```

**`ramping_arrival_events_rate`** — rate thực tế theo thời gian:
```
So sánh với target rate từ stages:
  Stage 1: actual rate vs 2→15/s → có bám sát không?
  Stage 2: actual rate vs 15→28/s → có đạt peak 28/s không?
  Stage 3: actual rate vs 28→5/s → ramp-down có mượt không?

Nếu actual rate < target rate → bottleneck ở VU pool hoặc system under test
```

**`ramping_arrival_events_duration`** — end-to-end iteration time:
```
Bao gồm:
  - Thời gian đợi VU (queue time)
  - Thời gian execute HTTP request
  - Thời gian xử lý response + checks

p95 nên < 200ms cho hầu hết iteration
Nếu p95 > 500ms → VU pool đang quá tải hoặc auth service chậm
```

### 8.4 Bảng metrics-to-decision mapping

| Metric pattern | Interpretation | Action |
|----------------|----------------|--------|
| `dropped_iterations > 0` | VU pool không đủ cho rate | Tăng `maxVUs` |
| `http_req_duration{p95}` tăng dần trong Stage 2 | Auth service đang bị stress tích lũy | Scale auth service hoặc giảm peak rate |
| `http_req_failed{url=~/.*login/} > 0` | Login endpoint bottleneck | Kiểm tra DB write capacity, hash performance |
| `vus` luôn ở mức thấp (<5) | VU pool dư thừa, có thể giảm preAllocatedVUs | Tối ưu resource usage |
| `iteration_duration{p95}` >> `http_req_duration{p95}` | Queue time lớn — VU pool không theo kịp | Tăng maxVUs hoặc preAllocatedVUs |
| `ramping_arrival_events_total` << 723 | Iteration bị drop hoặc scheduler không đạt target rate | Kiểm tra `dropped_iterations`, điều chỉnh stages |

### 8.5 PromQL queries hữu ích (khi dùng Prometheus remote write)

```promql
# Rate thực tế (iterations/s)
rate(k6_iterations_total{scenario="loginWaveIngress"}[5s])

# Dropped iteration rate
rate(k6_dropped_iterations_total{scenario="loginWaveIngress"}[5s])

# Latency phân theo endpoint
histogram_quantile(0.95, rate(k6_http_req_duration_seconds_bucket{scenario="loginWaveIngress"}[30s]))

# Login failure rate
rate(k6_http_req_failed_total{scenario="loginWaveIngress", url=~".*login"}[5s])

# VU utilization
k6_vus{scenario="loginWaveIngress"} / k6_vus_max{scenario="loginWaveIngress"}

# Queue depth estimation
rate(k6_iteration_duration_seconds_sum[5s]) / rate(k6_iteration_duration_seconds_count[5s])
  - rate(k6_http_req_duration_seconds_sum[5s]) / rate(k6_http_req_duration_seconds_count[5s])
```

---

## 9. Pass criteria

### 9.1 Bảng pass criteria chi tiết

| # | Criteria | Metric | Condition | Severity | Auto-check |
|---|----------|--------|-----------|----------|------------|
| P1 | Không drop iteration | `dropped_iterations` | `== 0` | **P0 — Block release** | ✅ thresholds |
| P2 | Không request failure | `http_req_failed` | `== 0` (tất cả endpoint) | **P0 — Block release** | ✅ thresholds |
| P3 | Login không lỗi | `http_req_failed{url=~/.*login/}` | `== 0` | **P0 — Block release** | ✅ thresholds |
| P4 | Peak rate đạt được | `ramping_arrival_events_rate` | `>= 27/s` tại peak | **P1 — Must fix** | ✅ custom metric |
| P5 | Latency /me acceptable | `http_req_duration{url=~/.*me/}` p95 | `< 50ms` | **P1 — Must fix** | ✅ thresholds |
| P6 | Latency login acceptable | `http_req_duration{url=~/.*login/}` p95 | `< 200ms` | **P2 — Should fix** | ✅ thresholds |
| P7 | Latency refresh acceptable | `http_req_duration{url=~/.*refresh/}` p95 | `< 100ms` | **P2 — Should fix** | ✅ thresholds |
| P8 | VU không vượt max | `vus_max` | `<= 35` | **P2 — Should fix** | ✅ thresholds |
| P9 | Iteration count gần expected | `iterations` | `>= 680 AND <= 760` (±6%) | **P2 — Should fix** | ✅ thresholds |
| P10 | Response time nhất quán | `http_req_duration` stddev | Không spike >3x baseline | **P2 — Should fix** | Manual review |
| P11 | Weight distribution đúng | custom metrics tỉ lệ | `/me`: 70-80%, `/login`: 12-18%, `/refresh`: 7-13% | **P2 — Should fix** | Manual review |
| P12 | Không memory leak | Memory trend | Không tăng liên tục trong 45s | **P3 — Nice to have** | Manual review |

### 9.2 Pass criteria tổng hợp

```
PASS ALL:
  ✅ P1-P12 tất cả đều pass
  → Auth service sẵn sàng cho login wave production

PASS CRITICAL:
  ✅ P1, P2, P3, P4, P5 pass
  ⚠️ P6-P12 có cảnh báo
  → Có thể release với caveat, cần investigation follow-up

FAIL:
  ❌ Bất kỳ P1, P2, P3 nào fail
  → BLOCK release, cần fix trước khi deploy

WARNING:
  ⚠️ P4 fail (peak rate không đạt)
  → Kiểm tra VU pool size, auth service capacity
  ⚠️ P9 fail (iteration count sai)
  → OK nếu dropped_iterations = 0 (do scheduler precision)
```

### 9.3 Thresholds configuration (JSON)

```json
{
  "thresholds": {
    "http_req_failed": ["rate == 0"],
    "http_req_failed{url:''}": ["rate == 0"],
    "dropped_iterations": ["count == 0"],
    "http_req_duration{url:''}": ["p(95) < 100"],
    "http_req_duration{url:'/api/sim/auth/me'}": ["p(95) < 50"],
    "http_req_duration{url:'/api/sim/auth/login'}": ["p(95) < 200"],
    "http_req_duration{url:'/api/sim/auth/refresh'}": ["p(95) < 100"],
    "vus_max": ["value <= 35"],
    "iterations": ["count >= 680", "count <= 760"]
  }
}
```

---

## 10. Cách chạy

### 10.1 Chạy local cơ bản

```bash
# Chạy với k6 binary
k6 run script.js

# Chạy với output summary
k6 run script.js --summary-export=results-03-login-wave.json

# Chạy với verbose logging để debug
k6 run script.js --verbose

# Chạy với tag để lọc kết quả
k6 run script.js --tag scenario=loginWaveIngress --tag env=local
```

### 10.2 Chạy với environment variables override

```bash
# Override peak rate
k6 run script.js -e PEAK_RATE=28

# Override stage durations
k6 run script.js -e STAGE1_DURATION=15s -e STAGE2_DURATION=20s -e STAGE3_DURATION=10s

# Override VU pool
k6 run script.js -e PRE_ALLOCATED_VUS=10 -e MAX_VUS=35

# Override weight distribution
k6 run script.js -e WEIGHT_ME=0.75 -e WEIGHT_LOGIN=0.15 -e WEIGHT_REFRESH=0.10

# Override target host
k6 run script.js -e TARGET_HOST=http://localhost:3080
```

### 10.3 Chạy với dashboard (k6 Web Dashboard)

```bash
# Chạy với web dashboard (built-in k6 v0.49+)
k6 run script.js --web-dashboard

# Chạy với dashboard export
k6 run script.js --web-dashboard --web-dashboard-period=1s

# Dashboard mặc định mở tại http://localhost:5665
# Xem real-time: response time, VUs, iterations/s, checks
```

### 10.4 Chạy với output lên external services

```bash
# InfluxDB + Grafana
k6 run script.js --out influxdb=http://localhost:8086/k6

# Prometheus remote write
k6 run script.js --out experimental-prometheus-rw \
  --tag scenario=loginWaveIngress

# Cloud output (Grafana Cloud k6)
k6 cloud script.js

# CSV output (dùng extension)
k6 run script.js --out csv=results-03.csv

# JSON output (dùng extension)
k6 run script.js --out json=results-03.json
```

### 10.5 Chạy trong CI/CD pipeline

```yaml
# GitHub Actions example
perf-test-auth-wave:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: grafana/setup-k6-action@v1
    - name: Start services
      run: docker compose up -d auth-service auth-db
    - name: Wait for healthy
      run: |
        until curl -s http://localhost:3080/health; do sleep 1; done
    - name: Run login wave test
      run: |
        k6 run script.js \
          --summary-export=results.json \
          --tag ci=true \
          --tag branch=${{ github.ref_name }}
    - name: Check thresholds
      run: |
        python -c "
        import json
        with open('results.json') as f:
            data = json.load(f)
        metrics = data.get('metrics', {})
        failed = metrics.get('dropped_iterations', {}).get('values', {}).get('count', 0)
        if failed > 0:
            print(f'FAIL: {failed} dropped iterations')
            exit(1)
        print('PASS: 0 dropped iterations')
        "
    - name: Upload results
      uses: actions/upload-artifact@v4
      with:
        name: perf-results-login-wave
        path: results.json
```

### 10.6 Docker run

```bash
# Build image (nếu cần)
docker build -t k6-auth-wave -f Dockerfile .

# Chạy trong Docker
docker run --rm \
  --network host \
  -v $(pwd)/results:/results \
  k6-auth-wave run \
  --summary-export=/results/03-login-wave.json \
  /scripts/script.js
```

---

## 11. Phân tích output 5 bước

### 11.1 Bước 1: Kiểm tra dropped_iterations và tổng iterations

**Mục tiêu:** Xác nhận không có iteration nào bị drop.

```
Kết quả mong đợi:
  dropped_iterations: 0
  iterations: 720-730 (gần 723 lý thuyết)

Phân tích:
  - Nếu dropped_iterations > 0:
    → VU pool không đủ, tăng maxVUs hoặc giảm peak rate
    → Kiểm tra xem drop xảy ra ở stage nào (theo thời gian)
    → Nếu drop ở Stage 2: VU pool mở rộng không kịp
    → Nếu drop ở Stage 3: có thể do gracefulStop setting

  - Nếu iterations < 680:
    → Scheduler không đạt target rate, có thể do:
      - maxVUs quá thấp → iteration queued quá lâu → timeout
      - Auth service quá chậm → iteration kéo dài → VU không giải phóng
      - Network issue → connection timeout

  - Nếu iterations > 760:
    → In-flight tail lớn (bình thường, không đáng lo)
    → Hoặc stages tính sai (kiểm tra lại stage math)
```

**Checklist Bước 1:**
- [ ] `dropped_iterations == 0`
- [ ] `iterations` trong khoảng 680-760
- [ ] `iterations` không lệch quá 10% so với 723
- [ ] Ghi nhận số iteration chính xác để so sánh với các lần chạy sau

### 11.2 Bước 2: Phân tích http_req_duration theo endpoint

**Mục tiêu:** Xác nhận latency của từng endpoint nằm trong ngưỡng, phát hiện bottleneck ở endpoint cụ thể.

```
Phân tích theo từng URL:

1. /api/sim/auth/me (75% traffic):
   - p50: kỳ vọng < 5ms
   - p95: kỳ vọng < 50ms
   - p99: kỳ vọng < 100ms
   - Nếu p95 > 50ms: token validation chậm → kiểm tra DB index, cache hit rate
   - Nếu p50 normal nhưng p99 spike: GC pause hoặc connection pool exhaustion

2. /api/sim/auth/login (15% traffic):
   - p50: kỳ vọng < 20ms
   - p95: kỳ vọng < 200ms
   - p99: kỳ vọng < 500ms
   - Nếu p95 > 200ms: password hash quá chậm hoặc DB write bottleneck
   - Nếu failure rate > 0: kiểm tra DB constraints, unique key violations

3. /api/sim/auth/refresh (10% traffic):
   - p50: kỳ vọng < 10ms
   - p95: kỳ vọng < 100ms
   - p99: kỳ vọng < 300ms
   - Nếu p95 > 100ms: token rotation chậm → kiểm tra DB update performance

So sánh giữa các stage:
  - Stage 1 (ramp-up): latency nên thấp và ổn định
  - Stage 2 (peak): latency có thể tăng 10-20% → chấp nhận được
  - Stage 3 (ramp-down): latency nên giảm trở lại
  - Nếu latency tiếp tục tăng trong Stage 3 → resource leak hoặc DB chưa kịp hồi phục
```

**Latency acceptance matrix:**

| Endpoint | p50 OK | p95 OK | p99 OK | Warning | Critical |
|----------|--------|--------|--------|---------|----------|
| `/me` | < 10ms | < 50ms | < 100ms | p95 50-80ms | p95 > 80ms |
| `/login` | < 30ms | < 200ms | < 500ms | p95 200-350ms | p95 > 350ms |
| `/refresh` | < 20ms | < 100ms | < 300ms | p95 100-180ms | p95 > 180ms |

### 11.3 Bước 3: Kiểm tra http_req_failed breakdown

**Mục tiêu:** Xác nhận 0 failures, hoặc nếu có failure thì xác định root cause.

```
Phân tích failure theo chiều:

1. Theo endpoint:
   http_req_failed{url="/api/sim/auth/me"}      → nên = 0
   http_req_failed{url="/api/sim/auth/login"}    → nên = 0
   http_req_failed{url="/api/sim/auth/refresh"}  → nên = 0

2. Theo status code:
   - 4xx: vấn đề ở phía client (sai credentials, token hết hạn)
   - 5xx: vấn đề ở auth service (internal error, DB connection)
   - 0 (no response): timeout hoặc connection refused

3. Theo thời gian:
   - Failure xuất hiện ở Stage 2 (peak): quá tải → scale auth service
   - Failure rải rác đều: bug hoặc data issue
   - Failure tập trung cuối test: gracefulStop issue

4. Theo error message:
   - "connection refused": auth service không listening
   - "socket hang up": auth service crash hoặc kill connection
   - "timeout": request kéo dài quá timeout setting
   - "dial tcp": DNS hoặc network issue
```

**Failure root cause map:**

| Status | Error | Likely root cause | Fix |
|--------|-------|-------------------|-----|
| 401 | Unauthorized | Token hết hạn hoặc sai format | Kiểm tra token generation logic |
| 429 | Rate limit | Auth service rate limiting | Tăng rate limit hoặc giảm test rate |
| 500 | Internal server error | Bug trong auth service khi tải cao | Debug với stack trace |
| 502 | Bad gateway | Auth service crash/OOM | Tăng resource, fix memory leak |
| 503 | Service unavailable | DB connection pool exhausted | Tăng DB pool size |
| 0 | Timeout | Request > timeout | Tăng timeout hoặc fix latency |
| 0 | Connection refused | Auth service không chạy | Start service, check port |

### 11.4 Bước 4: Phân tích VU behavior và iteration_duration

**Mục tiêu:** Hiểu VU utilization, queue dynamics, và iteration lifecycle.

```
VU metrics:

1. vus (gauge theo thời gian):
   - Stage 1: 1-3 VUs active (rate thấp, latency thấp)
   - Stage 2: 1-5 VUs active (rate cao hơn nhưng latency vẫn thấp)
   - Stage 3: 1-3 VUs active (rate giảm dần)
   - vus_max: giá trị peak VUs đã dùng → nên < 10 (với latency thấp)

   Nếu vus luôn ở 1: VU pool dư thừa nhiều
   Nếu vus đạt maxVUs=35: VU pool quá nhỏ hoặc latency quá cao

2. iteration_duration breakdown:
   - p50: kỳ vọng < 20ms (gần bằng http_req_duration)
   - p95: kỳ vọng < 100ms
   - p99: kỳ vọng < 300ms

   Nếu iteration_duration >> http_req_duration:
   → Queue time lớn — VU pool bottleneck
   → Tính queue_time = iteration_duration - http_req_duration
   → Nếu queue_time > 50ms: cần thêm VUs

3. VU utilization:
   VU_utilization = vus trung bình / maxVUs
   - Nếu < 20%: quá nhiều VUs dự phòng → có thể giảm maxVUs
   - Nếu > 80%: VU pool gần max → rủi ro
   - Nếu = 100%: VU pool đã bão hòa → iteration phải đợi
```

**Iteration lifecycle timing:**

```
[Schedule] → [Wait in queue] → [Pick by VU] → [Execute HTTP] → [Check] → [Done]
    |              |                  |               |            |         |
    t0          t1-t0             t2-t1           t3-t2        t4-t3      t4
              (queue_time)     (调度 delay)    (http_req)    (checks)

iteration_duration = t4 - t0
http_req_duration = t3 - t2
queue_time ≈ iteration_duration - http_req_duration (xấp xỉ)
```

### 11.5 Bước 5: Kiểm tra weight distribution và custom metrics

**Mục tiêu:** Xác nhận traffic được phân phối đúng theo weights, custom metrics hoạt động.

```
1. Weight distribution verification:

   Từ http_reqs breakdown:
   - me_count = http_reqs{url="/api/sim/auth/me"}
   - login_count = http_reqs{url="/api/sim/auth/login"}
   - refresh_count = http_reqs{url="/api/sim/auth/refresh"}
   - total = me_count + login_count + refresh_count

   Tỉ lệ thực tế:
   - me_pct = me_count / total → nên ≈ 73-77%
   - login_pct = login_count / total → nên ≈ 13-17%
   - refresh_pct = refresh_count / total → nên ≈ 8-12%

   Nếu lệch >5%: weight function có vấn đề (dùng Math.random() không đúng cách)

2. Custom metrics:

   ramping_arrival_events_total:
   - Tổng = iterations (phải khớp)
   - Breakdown theo operation → khớp với http_reqs breakdown

   ramping_arrival_events_rate:
   - Plot rate theo thời gian → so sánh với wave shape mong đợi
   - Stage 1: rate tăng từ 2→15/s
   - Stage 2: rate tăng từ 15→28/s
   - Stage 3: rate giảm từ 28→5/s
   - Nếu rate không bám sát target → scheduler issue hoặc VU bottleneck

   ramping_arrival_events_duration:
   - So sánh với http_req_duration (nên gần bằng)
   - Nếu cao hơn đáng kể → queue time trong iteration

3. Cross-metric correlation:

   | Check | Metric A | Metric B | Relationship |
   |-------|----------|----------|-------------|
   | C1 | `iterations` | `http_reqs` | iterations == http_reqs (mỗi iteration = 1 request) |
   | C2 | `ramping_arrival_events_total` | `iterations` | phải khớp |
   | C3 | `http_req_duration avg` | `iteration_duration avg` | iteration_duration >= http_req_duration |
   | C4 | `http_reqs{/me}` / `http_reqs` | 0.75 | ±5% |
```

---

## 12. Dashboard 3-chart deep analysis

### 12.1 Chart 1: Response Time — drill by me/login/refresh

**Chart type:** Line chart, time-series, multi-series (phân theo endpoint)

**Hiển thị:**
- Trục X: thời gian (0-45s)
- Trục Y: response time (ms), thang log hoặc linear
- Series:
  - `http_req_duration{p95}` cho `/me` (màu xanh lá — read operation)
  - `http_req_duration{p95}` cho `/login` (màu cam — write operation)
  - `http_req_duration{p95}` cho `/refresh` (màu vàng — mixed operation)
  - `http_req_duration{avg}` overall (màu xám đứt nét — reference)

**Phân tích mong đợi:**

```
Stage 1 (0-15s):      Stage 2 (15-35s):       Stage 3 (35-45s):
  /me:    3-5ms         /me:    5-10ms           /me:    5→3ms
  /login: 15-20ms       /login: 20-35ms          /login: 35→15ms
  /refresh: 8-12ms      /refresh: 12-20ms        /refresh: 20→8ms

Patterns cần chú ý:
  - /me latency không bị ảnh hưởng bởi login spike → read path độc lập ✓
  - /login latency tăng ở Stage 2 → write contention ở DB ✓ (bình thường)
  - /refresh latency tăng cùng /login → dùng chung DB connection pool
  - Nếu /me latency cũng tăng theo /login → resource sharing problem (CPU, DB pool)
```

**Anomaly detection:**

| Pattern | Dấu hiệu | Interpretation |
|---------|---------|----------------|
| **All-spike** | Cả 3 endpoint cùng spike | Global resource exhaustion (CPU 100%, DB pool maxed) |
| **Login-only spike** | Chỉ /login tăng | DB write bottleneck (INSERT contention) |
| **Staircase** | Latency tăng từng bậc | DB connection pool từng bước cạn kiệt |
| **Sawtooth** | Latency oscillate | GC pause hoặc connection pool recycle |
| **Me-follows-login** | /me latency tương quan với /login | Shared resource (cùng DB pool cho read và write) |

### 12.2 Chart 2: Execution Timeline — wave shape visualization

**Chart type:** Area chart hoặc line chart với fill

**Hiển thị:**
- Trục X: thời gian (0-45s)
- Trục Y trái: Iterations/s (rate)
- Trục Y phải: Cumulative iterations
- Series:
  - Target rate (đường đứt nét, calculated từ stage math) — màu xanh
  - Actual iteration rate (đường liền) — màu xanh đậm
  - Cumulative iterations (area fill) — màu xanh nhạt
  - Dropped iterations (nếu có, màu đỏ, scale phóng to)

**Phân tích theo stage:**

```
Stage 1 (0-15s):
  - Target: đường thẳng 2→15/s
  - Actual: nên bám sát target (±1 req/s)
  - Cumulative: tăng dần, độ dốc tăng (rate tăng → tích lũy nhanh hơn)
  - Sau 15s: cumulative ≈ 120-130 iterations

Stage 2 (15-35s):
  - Target: đường thẳng 15→28/s
  - Actual: nên bám sát target (±2 req/s)
  - Cumulative: tiếp tục tăng, độ dốc cao nhất trong test
  - Sau 35s: cumulative ≈ 550-565 iterations
  - Nếu actual rate bị "phẳng" tại một mức nào đó → ceiling của VU pool

Stage 3 (35-45s):
  - Target: đường thẳng 28→5/s
  - Actual: nên bám sát target, nhưng có thể "lag" 1-2s do in-flight iterations
  - Cumulative: độ dốc giảm dần → tiệm cận ngang
  - Sau 45s: cumulative ≈ 720-730 iterations
```

**Deviation analysis:**

| Deviation | Biểu hiện | Nguyên nhân |
|-----------|----------|-------------|
| **Actual < Target (Stage 2)** | Actual rate plateau ở 20/s dù target 28/s | VU pool exhausted hoặc auth service bottleneck |
| **Actual > Target (Stage 3)** | Rate giảm chậm hơn target | In-flight iteration tail, gracefulRampDown chưa đủ nhanh |
| **Jitter lớn** | Actual rate dao động mạnh | Scheduler precision issue với rate thấp (Stage 1) |
| **Gap mở rộng** | Actual ngày càng xa target | Vấn đề tích lũy (DB chậm dần, memory leak) |
| **Spike đột ngột** | Actual rate spike > target | Burst scheduling hoặc timer issue |

### 12.3 Chart 3: VUs vs iter/s — capacity analysis

**Chart type:** Dual-axis line chart

**Hiển thị:**
- Trục Y trái: Số VUs đang active
- Trục Y phải: Iterations/s
- Trục X: thời gian (0-45s)
- Series:
  - `vus` (màu tím) — active VUs
  - `iterations/s` (màu xanh) — actual iteration rate
  - `vus_max` reference line (màu đỏ đứt nét) — ceiling

**Phân tích mối quan hệ VUs ↔ iter/s:**

```
Normal behavior:
  - iter/s tăng → VUs tăng (theo Little's Law)
  - VUs thay đổi mượt mà, không nhảy bậc
  - vus luôn << maxVUs (35)
  - iter/s curve ≈ target rate curve

Relationship formula:
  iter/s ≈ vus / W_effective
  → Nếu W_effective không đổi, iter/s tỉ lệ thuận với vus
  → Nếu cả vus và iter/s đều tăng: bình thường
  → Nếu vus tăng nhưng iter/s không tăng: W_effective tăng (system chậm đi)

Anomaly patterns:
  - VUs plateau ở maxVUs trong khi iter/s < target:
    → "VU-bound": cần tăng maxVUs
  - VUs và iter/s cùng plateau:
    → "System-bound": auth service đạt capacity limit
  - VUs tăng đột biến:
    → Spike trong latency → W_effective tăng đột ngột
  - VUs = 1 suốt test:
    → W_effective quá thấp → có thể giảm preAllocatedVUs
```

**Bảng VU efficiency:**

| Metric | Công thức | Mong đợi | Warning |
|--------|-----------|----------|---------|
| Iterations per VU | `iterations / vus_max` | > 70 | < 30 (VU không hiệu quả) |
| VU utilization | `avg(vus) / maxVUs` | < 30% | > 80% |
| Rate per VU | `peak_rate / vus_max` | > 2.8/s | < 1/s (VU quá nhiều) |
| Queue ratio | `(iteration_duration - http_req_duration) / http_req_duration` | < 0.5 | > 2.0 (queue time dominates) |

---

## 13. 4 output→decision scenarios

### 13.1 Scenario A: Perfect pass — wave sustained, 0 drops

**Output signature:**
```
dropped_iterations: 0
http_req_failed: 0%
http_req_duration p95: /me=8ms, /login=35ms, /refresh=18ms
vus_max: 3
iterations: 725
Target rate achieved: ✅ 28/s
Weight distribution: ✅ 74.2% / 15.4% / 10.4%
```

**Diagnosis:**
Auth service xử lý login wave hoàn hảo. Latency thấp và ổn định qua tất cả stage. VU pool dư thừa (3/35 = 8.6% utilization). Write pressure không ảnh hưởng đến read path.

**Decision:** ✅ **READY FOR PRODUCTION**

**Follow-up actions:**
1. Ghi nhận latency baseline để so sánh với production
2. Có thể giảm `preAllocatedVUs` từ 10 xuống 5 để tiết kiệm resource (không cần thiết cho test cục bộ)
3. Tăng peak rate để tìm capacity limit thực sự (variation 1)
4. Schedule periodic re-run với production-like latency injection

**Confidence:** Cao. Tất cả P0, P1 criteria pass.

### 13.2 Scenario B: Drops at peak — VU pool quá nhỏ cho 28/s với auth write mix

**Output signature:**
```
dropped_iterations: 47 (tập trung ở t=25-35s)
http_req_failed: 0% (chỉ drop, không fail)
http_req_duration p95: /me=120ms, /login=450ms, /refresh=250ms
vus_max: 10 (đạt max)
iterations: 678
Target rate achieved: ❌ Chỉ đạt 22/s max
Weight distribution: ✅ 74.8% / 14.9% / 10.3%
```

**Diagnosis:**
VU pool quá nhỏ (`maxVUs=10`) so với latency thực tế. Tại peak, W_effective ≈ 120ms → VUs cần = ceil(28 × 0.120) = ceil(3.36) = 4. Nhưng thực tế VUs đã dùng hết 10 mà vẫn không đủ → có bottleneck ở auth service, không chỉ VU pool. Latency tăng khiến W_effective tăng → VU demand tăng → vòng xoáy.

**Root cause chain:**
```
Auth service chậm → W_effective tăng → VU demand tăng
    → VU pool cạn kiệt → iteration queued → queue timeout
    → dropped_iterations
```

**Decision:** ❌ **BLOCK RELEASE**

**Required fixes (theo thứ tự ưu tiên):**
1. **Điều tra auth service bottleneck:** Tại sao latency tăng ở tải 22/s? DB write performance? CPU?
2. **Tăng maxVUs:** Lên ít nhất 20-25 (gấp đôi)
3. **Kiểm tra DB indexes:** Đảm bảo `sessions` và `refresh_tokens` table có index phù hợp
4. **Connection pool sizing:** Có thể DB connection pool quá nhỏ (mặc định 10 connections)
5. **Re-run sau khi fix** và xác nhận 0 drops

**Expected after fix:**
```
dropped_iterations: 0
vus_max: 4-6
http_req_duration p95: /me=8ms, /login=35ms, /refresh=18ms
iterations: 723
```

### 13.3 Scenario C: Login failures at peak — POST endpoint bottleneck

**Output signature:**
```
dropped_iterations: 0
http_req_failed: 2.3% (CHỈ ở /api/sim/auth/login, Stage 2)
http_req_duration p95: /me=8ms, /login=1500ms, /refresh=20ms
http_req_failed{/login} status: 500 (Internal Server Error)
vus_max: 5
iterations: 719
Target rate achieved: ✅ 28/s
Weight distribution: ✅
```

**Diagnosis:**
Login endpoint bị bottleneck riêng biệt, không ảnh hưởng đến `/me` và `/refresh`. Đây là dấu hiệu của **DB write contention** hoặc **password hashing bottleneck**. `/login` latency p95 = 1500ms gợi ý timeout đang được hit.

**Chi tiết investigation:**

| Hypothesis | Evidence cần tìm | Tool |
|-----------|-----------------|------|
| DB write lock contention | `FOR UPDATE` wait events trong DB logs | DB slow query log |
| Password hash CPU bound | CPU 100% trên auth service | `top`, profiler |
| Connection pool exhausted | "connection not available" trong app logs | App log |
| Unique constraint violation | Duplicate session key → retry loop | App log + DB constraints |

**Decision:** ❌ **BLOCK RELEASE**

**Required fixes:**
1. **Profile login endpoint:** Xác định chính xác bottleneck (DB write vs CPU hash)
2. **Nếu DB write:** Tối ưu INSERT (batch insert, async write, hoặc dùng write-through cache)
3. **Nếu CPU hash:** Dùng bcrypt cost factor thấp hơn cho test, hoặc offload hash sang queue
4. **Tăng DB connection pool** cho auth service
5. **Thêm circuit breaker** cho login endpoint để tránh cascade failure

**Re-test focus:** Login p95 < 200ms tại peak 28/s, 0 failures.

### 13.4 Scenario D: Slow ramp-down — VUs linger sau khi rate drops

**Output signature:**
```
dropped_iterations: 0
http_req_failed: 0%
http_req_duration p95: /me=8ms, /login=35ms, /refresh=18ms
vus: 3 (t=35s) → 3 (t=40s) → 2 (t=45s) → 1 (t=50s)
iterations: 738 (cao hơn 723)
Target rate achieved: ✅ 28/s (nhưng rate giảm chậm sau peak)
Weight distribution: ✅
```

**Diagnosis:**
Tất cả criteria pass, nhưng ramp-down chậm hơn dự kiến. Sau khi test kết thúc (t=45s), vẫn còn VUs active và iteration hoàn thành. Đây là **in-flight iteration tail** — bình thường với open model.

**Phân tích chi tiết:**
```
Expected iterations Stage 3: 165
Actual iterations sau t=35s: 180 (cao hơn 15 iterations)
→ 15 iterations là "tail" từ Stage 2 vẫn đang chạy khi bước vào Stage 3

Nguyên nhân:
  - Tại t=34.9s, scheduler vẫn tạo iteration với rate ~28/s
  - Những iteration này có W ≈ 13ms → hoàn thành lúc t=34.913s
  - Nhưng một số có latency cao hơn → hoàn thành lúc t=35.2s - 35.5s
  - Chúng được tính vào Stage 3 timeline
```

**Decision:** ✅ **PASS with observation** (không block release)

**Optional tuning:**
1. Giảm `gracefulRampDown` time nếu muốn ramp-down nhanh hơn
2. Chấp nhận in-flight tail như behavior bình thường của open model
3. Nếu cần iteration count chính xác, dùng `maxDuration` để cắt cứng

**Note:** Scenario D không phải là failure — nó là đặc tính của open model. Chỉ cần awareness khi đọc metrics.

---

## 14. "Nghịch lý"

### 14.1 NL1: "Peak 28/s nhưng 75% là /me read → weighted W thấp hơn tưởng"

**Nghịch lý:** Thoạt nhìn, 28 req/s nghe có vẻ là tải cao. Nhưng với 75% traffic là `/me` (read-only, latency ~5ms), weighted latency chỉ 13ms (p95). Điều này khiến auth wave **dễ pass** hơn so với tưởng tượng.

**Giải thích:**

```
Nếu 100% traffic là /login (write, p95=35ms):
  W_effective = 35ms
  VUs cần = ceil(28 × 0.035) = 1 VU
  DB writes/s = 28 × 2 = 56 writes/s ← Áp lực write rất cao

Thực tế với 75/15/10 mix:
  W_effective = 13ms
  VUs cần = ceil(28 × 0.013) = 1 VU
  DB writes/s = 28 × (0.15×2 + 0.10×2) = 28 × 0.5 = 14 writes/s ← Thấp hơn 4x

→ Auth wave dễ hơn 4 lần so với "toàn bộ là login"
→ Nhưng vẫn cần test vì đây là realistic traffic mix
```

**Hệ quả cho capacity planning:**

| Scenario | W_effective | VUs (lý thuyết) | DB writes/s | Độ khó |
|----------|-------------|-----------------|-------------|--------|
| 100% /me (read-only) | 8ms | 1 | 0 | Rất dễ |
| **75/15/10 mix (thực tế)** | **13ms** | **1** | **14** | **Dễ-Trung bình** |
| 50/30/20 mix (write-heavy) | 18ms | 1 | 28 | Trung bình |
| 100% /login (write-only) | 35ms | 1 | 56 | Khó |

**Kết luận:** Với latency simulated thấp, auth wave case này chủ yếu test **write pressure pattern**, không phải raw throughput. Giá trị thực của test nằm ở việc xác nhận DB write path chịu được 14 writes/s liên tục.

### 14.2 NL2: "Login rate 15% của 28/s = 4.2 login/s — ít nhưng write cost cao"

**Nghịch lý:** Chỉ 4.2 login requests mỗi giây tại peak, nhưng mỗi login tạo 2 DB writes + 1 password hash verify → cost cao gấp 5-10 lần so với 1 request `/me`.

**Phân tích cost per operation:**

| Operation | CPU (relative) | DB reads | DB writes | Network | Total cost (relative) |
|-----------|---------------|----------|-----------|---------|----------------------|
| `/me` | 1x | 1 | 0 | 1x | **1x** (baseline) |
| `/login` | 10x (hash) | 1 | 2 | 1x | **8-10x** |
| `/refresh` | 3x | 1 | 2 | 1x | **4-5x** |

**Cost-weighted traffic calculation:**

```
Tại peak 28/s:
  75% × 21 req/s × 1x = 21 cost units/s (từ /me)
  15% × 4.2 req/s × 9x = 37.8 cost units/s (từ /login)
  10% × 2.8 req/s × 4.5x = 12.6 cost units/s (từ /refresh)

  Total cost = 21 + 37.8 + 12.6 = 71.4 cost units/s

  Trong đó:
    /me đóng góp 21/71.4 = 29.4% cost (dù 75% requests!)
    /login đóng góp 37.8/71.4 = 52.9% cost (dù chỉ 15% requests!)

→ 15% requests tạo ra 53% system load!
→ Login là cost driver chính, không phải /me
```

**Hệ quả thực tế:**
- Tối ưu login performance có impact lớn hơn tối ưu `/me` (dù `/me` nhiều requests hơn)
- Nếu login latency tăng 2x → system load tăng ~50%
- Nếu `/me` latency tăng 2x → system load chỉ tăng ~30%
- Cần focus monitoring vào login endpoint, không phải `/me`

### 14.3 NL3: "Ramping-arrival-rate wave vs ramping-vus wave: cùng shape, khác model"

**Nghịch lý:** Cả hai executor đều có thể tạo wave shape (tăng-giảm theo thời gian), nhưng cơ chế hoàn toàn khác nhau. Cùng một target (28/s peak), kết quả test có thể khác biệt rất lớn.

**So sánh behavior:**

| Khía cạnh | ramping-arrival-rate (open) | ramping-vus (closed) |
|-----------|---------------------------|---------------------|
| **Cách tạo wave** | Rate target → scheduler tạo iteration | VU count target → mỗi VU tự loop |
| **Rate khi system chậm** | Vẫn cố gắng đạt target rate → queue build-up → drop | Rate giảm tự nhiên (VUs bận lâu hơn → ít iteration/s hơn) |
| **Rate khi system nhanh** | Bám sát target rate | Rate tăng (VUs hoàn thành nhanh → nhiều iteration/s hơn) |
| **Phát hiện bottleneck** | Qua `dropped_iterations` hoặc latency spike | Qua "rate ceiling" — dù tăng VUs, rate không tăng |
| **Tính chất** | **Stress test** — áp lực không đổi | **Soak test** — áp lực thích nghi với system |

**Worked example — cùng "wave" nhưng khác model:**

```
Giả sử auth service có capacity limit 20 req/s:

ramping-arrival-rate (target 28/s):
  → Scheduler tạo 28 iteration/s
  → Auth service chỉ xử lý được 20/s
  → 8 iteration/s bị queued
  → Queue dài ra → vượt timeout → DROPPED
  → Kết quả: dropped_iterations > 0, test FAIL
  → Phát hiện: Auth service không đủ capacity cho 28/s

ramping-vus (target 30 VUs, mỗi VU loop):
  → 30 VUs chạy, mỗi VU gửi request, đợi response, gửi tiếp
  → Auth service xử lý 20 req/s
  → Mỗi VU mất 50ms cho 1 iteration (do system queue)
  → Rate = 30 VUs / 0.050s = 600 req/s?! → Thực tế bị giới hạn bởi system
  → Rate thực ≈ 20 req/s (system limit)
  → Kết quả: 0 dropped, rate = 20/s (thấp hơn target nhưng không fail)
  → Phát hiện: Rate không tăng khi tăng VUs → system bottleneck
```

**Tại sao chọn open model cho auth wave:**
- User login là independent events → open model chính xác hơn
- Cần biết auth service có chịu được 28/s không → open model cho câu trả lời rõ ràng
- Closed model "che giấu" bottleneck bằng cách giảm rate tự nhiên
- Trong production, user không tự động giảm login rate khi system chậm — họ retry và làm tình hình tệ hơn

### 14.4 NL4: "PreAllocatedVUs=10 nhưng chỉ dùng 1-3 VUs — lãng phí hay an toàn?"

**Nghịch lý:** Với latency thấp (13ms), chỉ cần 1 VU cho 28/s. Nhưng config có `preAllocatedVUs=10` và `maxVUs=35`. Đây là over-provisioning có chủ đích hay lãng phí?

**Phân tích:**

```
Lý do cần buffer VUs:

1. Latency không cố định:
   - p95 = 13ms, nhưng p99 có thể lên 27ms
   - Nếu tất cả request đồng loạt hit p99: VUs cần = ceil(28 × 0.027) = 1 (vẫn thấp)
   - Nhưng với margin 5x: VUs cần ≈ 5

2. Connection setup overhead:
   - Mỗi VU mở 1 HTTP connection
   - Connection establishment mất 1-5ms
   - Nếu 1 VU xử lý 28 iterations/s, mỗi iteration phải < 35ms
   - Với connection reuse, 1 VU có thể xử lý được
   - Nhưng nếu không reuse connection → cần nhiều VUs hơn

3. Burst handling:
   - Scheduler có thể tạo burst iterations (vài iteration trong cùng 1ms)
   - Nếu chỉ có 1 VU, burst iterations phải đợi → latency spike
   - Với 10 VUs, burst được absorb ngay

4. Production parity:
   - Test environment: latency 5-20ms
   - Production: latency 50-200ms (network + DB cross-AZ)
   - Với production latency: cần 6-9 VUs
   - PreAllocatedVUs=10 đảm bảo test có thể chạy trong production-like env
```

**Kết luận:** `preAllocatedVUs=10` không lãng phí — nó là **buffer an toàn** cho phép test hoạt động trong nhiều môi trường khác nhau. Trong môi trường simulated cục bộ, VUs dư thừa không gây hại (chúng idle, không tiêu tốn CPU đáng kể). Trong production-like environment, chúng trở nên cần thiết.

---

## 15. Checklist

### 15.1 Pre-flight checklist (trước khi chạy)

- [ ] **Auth service đang chạy:** Xác nhận `curl http://localhost:3080/health` trả về 200
- [ ] **Auth DB đã migrate:** Schema up-to-date, indexes đã tạo
- [ ] **Test data đã seed:** User accounts có sẵn (email + password cho login)
- [ ] **Environment variables:** `TARGET_HOST`, `PEAK_RATE`, weights đã set (nếu override)
- [ ] **Network connectivity:** k6 machine có thể reach auth service (không firewall block)
- [ ] **Resource monitoring:** Đã setup monitoring cho auth service (CPU, memory, DB connections)
- [ ] **k6 version:** >= v0.49.0 (hỗ trợ `ramping-arrival-rate` và `--web-dashboard`)
- [ ] **Script syntax:** `k6 inspect script.js` không lỗi
- [ ] **Thresholds đã review:** Đảm bảo threshold values phù hợp với environment
- [ ] **Output directory:** Đã tạo thư mục cho results (nếu export)

### 15.2 Runtime checklist (trong khi chạy)

- [ ] **Dashboard mở:** `http://localhost:5665` hiển thị real-time metrics
- [ ] **Stage transition check:**
  - [ ] t=15s: Rate đã đạt ~15/s? VUs đang hoạt động?
  - [ ] t=35s: Rate đã đạt ~28/s? Có dropped iterations không?
  - [ ] t=45s: Rate đã giảm về ~5/s? Test kết thúc đúng?
- [ ] **No error spike:** `http_req_failed` vẫn = 0 trong suốt test
- [ ] **Latency stable:** `http_req_duration` p95 không spike đột ngột
- [ ] **VU count:** `vus` không chạm `maxVUs` (trừ khi cố ý)
- [ ] **Auth service health:** CPU, memory, DB connections trong giới hạn
- [ ] **No crash:** Auth service không restart hoặc crash trong test

### 15.3 Post-run analysis checklist

- [ ] **P0 criteria (BLOCK if fail):**
  - [ ] `dropped_iterations == 0`
  - [ ] `http_req_failed == 0`
  - [ ] `http_req_failed{url=~/.*login/} == 0`
- [ ] **P1 criteria (MUST fix if fail):**
  - [ ] Peak rate >= 27/s
  - [ ] `/me` p95 < 50ms (hoặc threshold đã set)
- [ ] **P2 criteria (SHOULD fix if fail):**
  - [ ] `/login` p95 < 200ms
  - [ ] `/refresh` p95 < 100ms
  - [ ] Iterations trong khoảng 680-760
  - [ ] `vus_max` <= 35
  - [ ] Weight distribution ±5% của target
- [ ] **Manual review:**
  - [ ] Response time chart — pattern có bình thường không?
  - [ ] Execution timeline — actual rate có bám target không?
  - [ ] VUs vs iter/s — relationship có hợp lý không?
  - [ ] Custom metrics — `ramping_arrival_events_*` có consistent không?
- [ ] **Documentation:**
  - [ ] Ghi lại kết quả (iterations, latency p95, vus_max, dropped)
  - [ ] So sánh với baseline (nếu có)
  - [ ] Flag bất thường (nếu có)

### 15.4 CI/CD integration checklist

- [ ] **Threshold file:** Đã define thresholds trong script hoặc separate config
- [ ] **Exit code:** k6 trả về non-zero exit code khi threshold fail
- [ ] **Artifact upload:** Results JSON được upload lên CI artifact store
- [ ] **Notification:** Alert khi test fail (Slack, email, PagerDuty)
- [ ] **Baseline comparison:** So sánh với lần chạy trước (regression detection)
- [ ] **Cleanup:** Auth service và DB được cleanup sau test (nếu là ephemeral env)

---

## 16. 4-5 variations

### 16.1 Variation 1: Tăng peak rate để tìm capacity limit

**Mục tiêu:** Xác định auth service capacity ceiling — rate tối đa hệ thống có thể xử lý trước khi xuất hiện drops hoặc failures.

**Thay đổi:**
```
Thay vì peak 28/s → thử các peak: 40/s, 50/s, 75/s, 100/s

Điều chỉnh stages:
  startRate: 2, timeUnit: 1s
  stages: [
    {duration: "15s", target: 20},
    {duration: "20s", target: 50},   // peak 50/s
    {duration: "10s", target: 5}
  ]
  preAllocatedVUs: 20, maxVUs: 80
```

**Phân tích:**
```
Với mỗi peak rate, ghi nhận:
  - dropped_iterations (rate bắt đầu có drop)
  - http_req_duration p95 (rate bắt đầu có latency spike)
  - vus_max (VU usage tương ứng)
  - DB writes/s tại peak

Vẽ capacity curve:
  Peak rate (X) vs http_req_duration p95 (Y)
  → Điểm uốn (knee) là capacity limit

Expected findings:
  - Với latency simulated: capacity limit có thể > 100/s
  - Với production-like latency: capacity limit có thể 30-50/s
  - Bottleneck có thể shift từ VU-bound sang DB-bound ở rate cao
```

### 16.2 Variation 2: Weight sweep — thay đổi read/write ratio

**Mục tiêu:** Hiểu impact của write ratio lên system load.

**Thay đổi:**
```
Chạy 3 scenario với weights khác nhau:

A. Read-heavy (baseline):
   /me: 75%, /login: 15%, /refresh: 10%

B. Balanced:
   /me: 50%, /login: 30%, /refresh: 20%

C. Write-heavy:
   /me: 30%, /login: 50%, /refresh: 20%

D. Extreme write:
   /me: 10%, /login: 70%, /refresh: 20%
```

**Phân tích so sánh:**

| Metric | Scenario A | Scenario B | Scenario C | Scenario D |
|--------|-----------|-----------|-----------|-----------|
| Weighted W_eff (p95) | 13ms | 20ms | 27ms | 31ms |
| DB writes/s (peak) | 14 | 28 | 42 | 50 |
| Expected VUs | 1 | 1-2 | 2 | 2-3 |
| /login p95 | 35ms | 35-50ms | 50-80ms | 80-120ms |
| Risk of failure | Thấp | Trung bình | Cao | Rất cao |

**Key insight từ variation này:** Write ratio tăng từ 25% lên 70% làm DB writes/s tăng 3.6x (14→50), trong khi tổng requests/s vẫn là 28. Đây là lý do auth service dễ bị write-bound.

### 16.3 Variation 3: Time-distorted wave — morning rush hour thực tế

**Mục tiêu:** Mô phỏng chính xác hơn login pattern buổi sáng với thời gian thực (không nén).

**Thay đổi:**
```
Thời lượng test: 45 phút (thay vì 45 giây)

startRate: 0.1, timeUnit: 1s  (nền thấp)
stages: [
  {duration: "15m", target: 15},   // ramp-up 15 phút
  {duration: "20m", target: 28},   // peak hour 20 phút
  {duration: "10m", target: 5}     // ramp-down 10 phút
]
preAllocatedVUs: 20, maxVUs: 50

Tổng iterations: 723 × 60 = 43,380
```

**Phân tích:**
```
Khác biệt so với 45s test:
  - DB có thời gian tích lũy write pressure (WAL, vacuum, cache eviction)
  - Memory leak (nếu có) sẽ biểu hiện rõ sau 10-15 phút
  - Connection pool có thể gặp "connection age" issues
  - Token expiration thực tế (access token hết hạn sau 15-60 phút)

Monitoring thêm:
  - DB disk I/O (WAL writes)
  - Memory trend của auth service
  - DB connection pool stats (active, idle, waiting)
  - GC pause time (nếu auth service dùng Java/Go)
```

### 16.4 Variation 4: Multi-wave — sáng và chiều

**Mục tiêu:** Mô phỏng 2 login wave trong ngày (morning + after-lunch).

**Thay đổi:**
```
startRate: 2, timeUnit: 1s
stages: [
  // Morning wave
  {duration: "10s", target: 15},
  {duration: "15s", target: 28},
  {duration: "8s", target: 5},
  // Lunch break (low traffic)
  {duration: "10s", target: 3},
  // Afternoon wave (smaller)
  {duration: "8s", target: 12},
  {duration: "10s", target: 20},
  {duration: "5s", target: 5}
]
preAllocatedVUs: 15, maxVUs: 40

Tổng thời lượng: 66s
```

**Phân tích:**
```
So sánh 2 wave:
  - Morning wave: peak 28/s, iterations ~400
  - Afternoon wave: peak 20/s, iterations ~150

Quan sát:
  - Auth service có recovery hoàn toàn giữa 2 wave không?
  - DB connection pool có leak không? (connections tăng sau wave 1, không giảm)
  - Memory có tăng阶梯 không?
  - Cache hit rate có cải thiện ở wave 2 không? (warm cache)
```

### 16.5 Variation 5: Token expiration during wave

**Mục tiêu:** Mô phỏng access token hết hạn trong lúc wave đang diễn ra → tăng refresh rate đột biến.

**Thay đổi:**
```
Thay vì weights cố định, weights thay đổi theo thời gian:

Stage 1: weights giống baseline
Stage 2 (peak): tăng refresh weight từ 10% → 25% (token từ Stage 1 hết hạn)
Stage 3: refresh tiếp tục cao trước khi giảm

Implement bằng cách:
  - Dùng thời gian test để modulate weights trong script
  - Hoặc dùng nhiều scenario với timing khác nhau
```

**Phân tích:**
```
Refresh spike trong Stage 2:
  - Refresh weight: 10% → 25%
  - DB writes/s từ refresh: 5.6 → 14 writes/s (tăng 2.5x)
  - Tổng DB writes/s: 14 (baseline) → 22.4 (với refresh spike)
  - W_effective tăng do refresh latency cao hơn /me

Đây là "hidden wave within the wave":
  - Bề ngoài: rate vẫn 28/s
  - Bên trong: operation mix thay đổi → cost profile thay đổi
  - Auth service có thể pass wave 1 nhưng fail wave 1 + refresh spike
```

---

## 17. Anti-patterns (mở rộng)

### 17.1 Anti-pattern 1: Dùng average rate để size VU pool

**Sai lầm:**
```
"Average rate = 723 / 45s = 16.1/s. Với W=13ms, chỉ cần ceil(16.1 × 0.013) = 1 VU."
→ Set maxVUs = 2
→ Test fail với dropped_iterations tại peak
```

**Tại sao sai:** Average rate che giấu peak. Tại t=34s, rate là 28/s (gấp 1.74x average). VU pool phải được size cho **peak rate**, không phải average.

**Cách đúng:**
```
VUs cần = ceil(peak_rate × W_effective) × safety_factor
        = ceil(28 × W_effective) × 1.5-3.0

Với W_effective = 13ms: VUs = ceil(28 × 0.013) × 2 = 2
Với W_effective = 100ms: VUs = ceil(28 × 0.100) × 2 = 6
Với W_effective = 300ms: VUs = ceil(28 × 0.300) × 2 = 18

→ maxVUs nên >= 2x giá trị tính toán để có buffer
```

### 17.2 Anti-pattern 2: Quên mất write amplification

**Sai lầm:**
```
"Chỉ 25% requests là POST → DB write load = 28 × 0.25 = 7 writes/s"
→ Thiết kế DB pool cho 10 writes/s
→ Performance degradation ở peak
```

**Tại sao sai:** Mỗi login tạo 2 DB writes (session + refresh token). Mỗi refresh tạo 2 DB writes (rotate refresh + new access). Tổng DB writes/s = 28 × (0.15×2 + 0.10×2) = 14 writes/s, **gấp đôi** so với estimate naive.

**Cách đúng:**
```
Tính write amplification per operation:
  /me:      0 writes
  /login:   2 writes (INSERT session, INSERT refresh_token)
  /refresh: 2 writes (UPDATE refresh_token, INSERT access_token)

Total writes/s = rate × Σ(weight_i × writes_per_operation_i)
               = 28 × (0.75×0 + 0.15×2 + 0.10×2)
               = 28 × 0.5
               = 14 writes/s

→ Thiết kế DB pool cho ít nhất 20 writes/s (có margin)
```

### 17.3 Anti-pattern 3: Dùng ramping-vus cho auth wave

**Sai lầm:**
```
"Dùng ramping-vus với VU stages mirror rate target:
 stages: [target=15, target=28, target=5]"
→ Nghĩ rằng VU count = rate
→ Kết quả: rate không đạt 28/s, hoặc rate vượt xa 28/s
```

**Tại sao sai:** Trong ramping-vus (closed model), rate = VUs / iteration_duration. Rate không được kiểm soát trực tiếp. Nếu system nhanh, rate có thể vượt target. Nếu system chậm, rate thấp hơn target. Không có cách nào guarantee rate = target.

**Cách đúng:** Dùng ramping-arrival-rate khi cần kiểm soát rate. Dùng ramping-vus khi cần kiểm soát concurrent users.

### 17.4 Anti-pattern 4: Không set gracePeriod và gracefulStop

**Sai lầm:**
```
Không set gracefulStop hoặc set = 0s
→ Test kết thúc đột ngột ở t=45s
→ In-flight iterations bị kill → false positive "dropped_iterations"
→ Hoặc test treo vì VU không được cleanup
```

**Tại sao sai:** Open model có thể có iteration in-flight khi test kết thúc. Nếu không có gracefulStop, những iteration này bị drop (không phải do system bottleneck mà do test kết thúc). Điều này tạo false positive.

**Cách đúng:**
```javascript
export const options = {
  scenarios: {
    loginWaveIngress: {
      executor: 'ramping-arrival-rate',
      // ...
      gracefulStop: '5s',    // Cho phép in-flight iterations hoàn thành trong 5s
      gracefulRampDown: '2s', // Giảm rate từ từ khi test gần kết thúc
    }
  }
};
```

### 17.5 Anti-pattern 5: Dùng single VU connection cho toàn bộ test

**Sai lầm:**
```
preAllocatedVUs: 1, maxVUs: 1
→ 1 VU xử lý tất cả 723 iterations
→ HTTP connection không được reuse đúng cách
→ Latency cao hơn thực tế do connection setup overhead
```

**Tại sao sai:** Mặc dù lý thuyết 1 VU có thể xử lý 28/s với W=13ms, thực tế HTTP connection có overhead: TCP handshake, TLS negotiation (mỗi connection mới). Nếu VU phải mở connection mới cho mỗi iteration, overhead này có thể lớn hơn chính request time.

**Cách đúng:** Dùng ít nhất 3-5 VUs (preAllocatedVUs=5) để có connection pool, cho phép connection reuse và HTTP keep-alive hoạt động hiệu quả.

### 17.6 Anti-pattern 6: Bỏ qua warm-up period

**Sai lầm:**
```
Bắt đầu test với rate=2/s ngay lập tức, không có warm-up
→ Những iteration đầu tiên có latency cao hơn (cold start)
→ p95 bị skew bởi cold start iterations
→ Kết luận sai về latency
```

**Tại sao sai:** Auth service có thể có cold start (JIT compilation, cache warm-up, DB connection pool initialization). Những request đầu tiên thường chậm hơn đáng kể.

**Cách đúng:**
```javascript
// Option 1: Thêm warm-up stage
stages: [
  { duration: '5s', target: 2 },   // Warm-up (rate thấp, ổn định)
  { duration: '15s', target: 15 },  // Ramp-up thực sự
  // ...
]

// Option 2: Loại bỏ N giây đầu khỏi analysis
// (trong post-processing script)
```

### 17.7 Anti-pattern 7: So sánh iteration count tuyệt đối với lý thuyết

**Sai lầm:**
```
"Lý thuyết tính được 723 iterations, nhưng thực tế chạy ra 731"
→ Kết luận: "Có gì đó sai, test không chính xác"
→ Điều chỉnh stages để đạt chính xác 723
```

**Tại sao sai:** Iteration count lý thuyết là xấp xỉ. Scheduler có precision giới hạn (thường là millisecond). In-flight tail thêm vài iterations. Sự khác biệt 1-2% là hoàn toàn bình thường.

**Cách đúng:** Chấp nhận iteration count trong khoảng ±5-10% của lý thuyết. Focus vào `dropped_iterations = 0`, không phải iteration count chính xác.

---

## 18. Reference

### 18.1 Internal references

| Document | Path | Relevance |
|----------|------|-----------|
| **Case 01: Smooth Ramp** | `docs/practice/ramping-arrival-rate/01-smooth-ramp.md` | Rate ramp-up cơ bản, single operation |
| **Case 02: Gateway Spike** | `docs/practice/ramping-arrival-rate/02-gateway-spike.md` | Spike pattern, comparison point |
| **Ramping-Arrival-Rate Quick Index** | `docs/20260514_01_per-vu-iterations-quick-index.md` | Executor overview |
| **Shared Iterations Quick Index** | `docs/20260515_01_shared-iterations-quick-index.md` | Comparison: closed vs open model |
| **Executor from Simplest** | `docs/20260513_00_executor-from-simplest.md` | Executor selection guide |
| **Options, Defaults and Shortcuts** | `docs/20260115_01_options-defaults-and-shortcuts.md` | Config reference |
| **VU Lifecycle and Iteration Counters** | `docs/20260114_00_vu-lifecycle-and-iteration-counters.md` | VU mechanics |

### 18.2 k6 official documentation

| Resource | URL | Topic |
|----------|-----|-------|
| **Ramping Arrival Rate** | https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/ramping-arrival-rate/ | Executor config, stages, rate control |
| **Open vs Closed Models** | https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/ | Model comparison |
| **Thresholds** | https://grafana.com/docs/k6/latest/using-k6/thresholds/ | Pass/fail criteria |
| **Tags and Groups** | https://grafana.com/docs/k6/latest/using-k6/tags-and-groups/ | Metric organization |
| **Web Dashboard** | https://grafana.com/docs/k6/latest/results-output/web-dashboard/ | Real-time visualization |
| **Custom Metrics** | https://grafana.com/docs/k6/latest/using-k6/metrics/create-custom-metrics/ | Trend, Counter, Gauge, Rate |

### 18.3 Academic & industry references

| Reference | Topic | Key concept |
|-----------|-------|-------------|
| **Little's Law** (Little, 1961) | Queueing theory | L = λ × W (VUs = arrival_rate × response_time) |
| **The Tail at Scale** (Dean & Barroso, 2013) | Latency variability | p99 latency dominates user experience |
| **Auth0 Architecture** | Token-based auth at scale | JWT validation, refresh token rotation |
| **OWASP Authentication Cheat Sheet** | Auth security best practices | Password hashing (bcrypt cost factor) |
| **PostgreSQL Write Performance** | DB write optimization | WAL, connection pooling, index strategy |

### 18.4 Quick reference card

```
┌─────────────────────────────────────────────────────────────┐
│           CASE 03: LOGIN WAVE INGRESS — QUICK CARD          │
├─────────────────────────────────────────────────────────────┤
│ Executor:        ramping-arrival-rate                       │
│ Peak Rate:       28/s                                        │
│ Duration:        45s                                         │
│ Est. Iterations: 723                                         │
│ preAllocatedVUs: 10                  maxVUs: 35              │
├─────────────────────────────────────────────────────────────┤
│ Traffic Mix:                                                 │
│   GET  /api/sim/auth/me         75%  (read-only, ~5ms)      │
│   POST /api/sim/auth/login      15%  (write, ~20ms)         │
│   POST /api/sim/auth/refresh    10%  (write, ~10ms)         │
├─────────────────────────────────────────────────────────────┤
│ Stages:                                                      │
│   Stage 1: 2→15/s  in 15s   (ramp-up, 127.5 iterations)     │
│   Stage 2: 15→28/s in 20s   (peak, 430 iterations)          │
│   Stage 3: 28→5/s  in 10s   (ramp-down, 165 iterations)     │
├─────────────────────────────────────────────────────────────┤
│ P0 Criteria:                                                 │
│   ✓ dropped_iterations = 0                                   │
│   ✓ http_req_failed = 0                                      │
│   ✓ http_req_failed{login} = 0                               │
├─────────────────────────────────────────────────────────────┤
│ Key Metrics:                                                 │
│   W_effective (weighted): 13.05ms (p95)                     │
│   DB writes/s at peak: 14                                    │
│   VU utilization: ~10-30% (generous buffer)                  │
├─────────────────────────────────────────────────────────────┤
│ Watch Out For:                                               │
│   ⚠ DB write contention (login + refresh writes)           │
│   ⚠ VU pool exhaustion if latency >> expected               │
│   ⚠ False dropped_iterations from missing gracefulStop      │
│   ⚠ In-flight tail inflating Stage 3 iterations             │
└─────────────────────────────────────────────────────────────┘
```

### 18.5 Config reference (hoàn chỉnh)

```javascript
// Hypothetical script structure for reference
import { buildRampingArrivalScenario } from './helpers/scenario-builder.js';
import { authOperations } from './helpers/auth-operations.js';

export const options = {
  scenarios: {
    loginWaveIngress: buildRampingArrivalScenario('loginWaveIngress', {
      executor: 'ramping-arrival-rate',
      startRate: 2,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 35,
      stages: [
        { duration: '15s', target: 15 },
        { duration: '20s', target: 28 },
        { duration: '10s', target: 5 },
      ],
      gracefulStop: '5s',
      gracefulRampDown: '2s',
    }),
  },
  thresholds: {
    'http_req_failed': ['rate == 0'],
    'dropped_iterations': ['count == 0'],
    'http_req_duration{url:\'/api/sim/auth/me\'}': ['p(95) < 50'],
    'http_req_duration{url:\'/api/sim/auth/login\'}': ['p(95) < 200'],
    'http_req_duration{url:\'/api/sim/auth/refresh\'}': ['p(95) < 100'],
    'vus_max': ['value <= 35'],
  },
  tags: {
    scenario: 'loginWaveIngress',
    service: 'auth',
    environment: __ENV.ENVIRONMENT || 'local',
  },
};

// Weighted endpoint selection
const WEIGHTS = {
  me: __ENV.WEIGHT_ME ? parseFloat(__ENV.WEIGHT_ME) : 0.75,
  login: __ENV.WEIGHT_LOGIN ? parseFloat(__ENV.WEIGHT_LOGIN) : 0.15,
  refresh: __ENV.WEIGHT_REFRESH ? parseFloat(__ENV.WEIGHT_REFRESH) : 0.10,
};

function selectOperation() {
  const rand = Math.random();
  if (rand < WEIGHTS.me) return 'me';
  if (rand < WEIGHTS.me + WEIGHTS.login) return 'login';
  return 'refresh';
}

export default function () {
  const operation = selectOperation();

  switch (operation) {
    case 'me':
      authOperations.validateToken();
      break;
    case 'login':
      authOperations.login();
      break;
    case 'refresh':
      authOperations.refreshToken();
      break;
  }
}
```

### 18.6 Glossary

| Thuật ngữ | Định nghĩa |
|-----------|-----------|
| **Auth Wave** | Làn sóng authentication request tăng-giảm theo thời gian, điển hình vào đầu giờ làm việc |
| **Write Amplification** | Hiện tượng mỗi logical write operation tạo ra nhiều physical DB writes |
| **W_effective** | Weighted average latency, tính theo traffic mix thực tế (không phải uniform) |
| **In-flight Tail** | Các iteration đã được scheduled nhưng chưa hoàn thành khi test kết thúc |
| **Open Model** | Arrival rate được kiểm soát độc lập với completion rate |
| **Closed Model** | Số concurrent users cố định, rate phụ thuộc vào system response time |
| **VU Pool** | Tập hợp các Virtual Users sẵn sàng thực thi iteration |
| **Queue Time** | Thời gian iteration đợi VU khả dụng |
| **Token Rotation** | Process refresh token cũ và issue token mới (bảo mật) |
| **Scheduler Precision** | Độ chính xác của k6 scheduler trong việc duy trì target rate |

---

> **Document version:** 1.0 | **Last updated:** 2026-06-21 | **Author:** k6 Performance Team
> **Backend script reference:** `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-03-login-wave-ingress.js`
> **Tags:** `ramping-arrival-rate`, `auth`, `login-wave`, `weighted-operations`, `write-amplification`, `open-model`
