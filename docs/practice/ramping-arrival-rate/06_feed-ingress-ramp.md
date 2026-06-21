# Case 06: Feed Ingress Ramp — Homefeed/Recommendation Read Traffic với Ramping-Arrival-Rate

> **Tóm lược:** Case này chứng minh nghịch lý Little's Law trong thực tế: rate cao nhất series (35 req/s) nhưng cần VU ít nhất (preAllocatedVUs=10). Homefeed và recommendation là read-only, cache-friendly endpoints — mỗi event chỉ ~5ms. Peak 35/s × 5ms = 0.175 VU lý thuyết, tức 1 VU là đủ về mặt toán học. Nhưng production cần buffer cho cache miss, cold start, và quá trình chuyển stage. Ramping-arrival-rate được chọn vì đây là dạng traffic organic tăng/giảm theo engagement pattern trong ngày — không phải spike đột ngột, cũng không phải flat constant.

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [2 yêu cầu cốt lõi](#2-2-yêu-cầu-cốt-lõi)
3. [Vì sao chọn ramping-arrival-rate?](#3-vì-sao-chọn-ramping-arrival-rate)
4. [Phân tích nguyên nhân gốc kỹ thuật](#4-phân-tích-nguyên-nhân-gốc-kỹ-thuật)
   - [RC1: Little's Law — 35/s × 5ms = <1 VU](#rc1-littles-law--35s--5ms--1-vu)
   - [RC2: Cache hit vs cache miss thay đổi W_effective](#rc2-cache-hit-vs-cache-miss-thay-đổi-weffective)
   - [RC3: Ticker period ở 35/s = 28.6ms](#rc3-ticker-period-ở-35s--286ms)
   - [RC4: Rate transitions kiểm tra VU pool responsiveness](#rc4-rate-transitions-kiểm-tra-vu-pool-responsiveness)
   - [RC5: AB/geo/device headers tạo request diversity](#rc5-abgeodevice-headers-tạo-request-diversity)
5. [Identity model deep-dive](#5-identity-model-deep-dive)
6. [Phân tích open model với high-rate ramp](#6-phân-tích-open-model-với-high-rate-ramp)
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
17. [Anti-patterns](#17-anti-patterns)
18. [Reference](#18-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh business

Một nền tảng social commerce có hai surface chính trên mobile app:

| Surface | Mô tả | % traffic | Độ phức tạp |
|---------|-------|-----------|-------------|
| **Homefeed** | Danh sách sản phẩm cá nhân hóa, infinite scroll, hiển thị ngay khi mở app | 65% | Trung bình — personalization model + product catalog join |
| **Recommendations** | Sản phẩm gợi ý trên trang chi tiết sản phẩm ("Có thể bạn sẽ thích") | 35% | Cao hơn — collaborative filtering, real-time user affinity |

Cả hai đều là **read-only**, không có write path, không có transaction, không có cart/checkout. Backend response time điển hình trong production:

- Homefeed (cache hit): **p95 ~5ms**
- Homefeed (cache miss): **p95 ~20ms**
- Recommendations (cache hit): **p95 ~7ms**
- Recommendations (cache miss): **p95 ~30ms**

Cache hit ratio trong giờ cao điểm thường đạt **85-95%** do content được pre-warm trước peak hour.

### 1.2 Daily engagement pattern

Traffic không flat — nó theo engagement pattern của người dùng trong ngày:

```
06:00 - 08:00  ████████░░░░░░░░  ~8 req/s   (wake-up check)
08:00 - 10:00  ██████████████░░  ~15 req/s  (commute)
10:00 - 12:00  ████████████████████  ~30 req/s  (peak engagement)
12:00 - 13:00  ██████████████░░  ~15 req/s  (lunch dip)
13:00 - 15:00  ████████████████████  ~35 req/s  (HIGHEST PEAK — afternoon browse)
15:00 - 17:00  ██████████░░░░░░  ~10 req/s  (wind-down)
```

Case 06 mô phỏng đoạn ramp từ 8 req/s lên 35 req/s (peak) rồi giảm về 10 req/s — tương ứng với khung giờ 11:00-14:00 khi traffic tăng mạnh vào giờ nghỉ trưa, đạt đỉnh, rồi giảm dần.

### 1.3 Tại sao đây là "highest peak rate" case

So sánh peak rate toàn bộ series ramping-arrival-rate:

| Case | Scenario | Peak rate | preAllocatedVUs | W_eff (typical) | VU cần (Little's Law) |
|------|----------|-----------|-----------------|-----------------|----------------------|
| 01 | Đơn hàng | 5/s | 8 | 200ms | ceil(5×0.2)=1 |
| 02 | Thanh toán | 3/s | 6 | 500ms | ceil(3×0.5)=2 |
| 03 | Tìm kiếm | 15/s | 10 | 80ms | ceil(15×0.08)=2 |
| 04 | Product detail | 10/s | 12 | 1200ms | ceil(10×1.2)=12 |
| 05 | Cart operations | 5/s | 8 | 300ms | ceil(5×0.3)=2 |
| **06** | **Feed ingress** | **35/s** | **10** | **5ms** | **ceil(35×0.005)=1** |

> **Quan sát quan trọng:** Case 06 có peak rate **35/s** — cao gấp 3.5 lần case 04 (10/s). Nhưng VU cần chỉ là **1** so với **12** của case 04. Đây là bài học cốt lõi: rate không quyết định VU sizing — tích rate × latency mới quyết định.

### 1.4 Hạ tầng kỹ thuật

| Thành phần | Mô tả |
|------------|-------|
| **CDN** | CloudFront/CloudFlare — cache static product images, JSON payloads với TTL 60s |
| **API Gateway** | Rate limiting per IP/device, request routing theo header X-Geo-Country |
| **Homefeed Service** | Node.js cluster (4 workers), Redis cache L1, PostgreSQL L2 cho personalization data |
| **Recommendation Service** | Python (FastAPI), Redis cho pre-computed recommendations, model serving qua gRPC |
| **Cache layer** | Redis Cluster (3 primary + 3 replica), maxmemory 8GB, eviction: allkeys-lru |
| **Personalization model** | Pre-computed batch (Spark, hourly), kết quả lưu trong Redis hash per user |

### 1.5 Nhân tố con người

| Vai trò | Mối quan tâm chính |
|---------|-------------------|
| **SRE** | "35/s có phải quá nhiều không? Hạ tầng có sustain được không?" |
| **Backend dev (Homefeed)** | "Personalization query của tôi có scale đến 35/s không?" |
| **Backend dev (Recommendation)** | "Collaborative filtering model serving có đủ nhanh ở rate này không?" |
| **Data engineer** | "Redis cache có đủ dung lượng cho toàn bộ user base trong peak hour?" |
| **QA lead** | "Làm sao test được 35/s sustained? Có cần provision VU khủng không?" |
| **Product manager** | "Nếu feed chậm, user bounce rate tăng — SLA p95 < 50ms cho feed" |

---

## 2. 2 yêu cầu cốt lõi

### Yêu cầu 1: Sustain feed ramp xuyên suốt 35 giây không drop

Toàn bộ 778 slot phải được schedule và hoàn thành, **0 iteration_duration drops**, **0 VU exhaustion errors**. Đây là yêu cầu nghiệp vụ: người dùng mở app và scroll feed — họ không quan tâm backend đang ramp up hay ramp down, họ chỉ thấy loading spinner nếu request fail.

Cụ thể hóa thành chỉ số:

| Chỉ số | Ngưỡng pass |
|--------|------------|
| http_req_failed | = 0 (tuyệt đối, không chấp nhận bất kỳ failure nào) |
| iteration_duration p95 | < 15ms (cache hit scenario) |
| iteration_duration p99 | < 50ms (kể cả cache miss) |
| dropped_iterations | = 0 |
| VU utilization tại peak | < 80% (còn room cho spike bất ngờ) |

### Yêu cầu 2: Zero drops ở peak 35/s — tất cả iteration được execute

Tại thời điểm ticker đạt 35/s (cuối stage 2, khoảng giây 18-25), mỗi 28.6ms có một slot được mở. Nếu bất kỳ slot nào không được nhận bởi VU sẵn sàng → drop iteration. Đây là failure mode nguy hiểm nhất của ramping-arrival-rate: **rate cao + VU không đủ = drop**.

```
Ticker timeline ở peak 35/s:

t=18.000s  [slot#483 mở] → VU#3 nhận  (event 5ms, done at 18.005)
t=18.029s  [slot#484 mở] → VU#7 nhận  (event 5ms, done at 18.034)
t=18.057s  [slot#485 mở] → VU#1 nhận  (event 5ms, done at 18.062)
t=18.086s  [slot#486 mở] → VU#4 nhận  (event 5ms, done at 18.091)
t=18.114s  [slot#487 mở] → VU#2 nhận  (event 5ms, done at 18.119)
t=18.143s  [slot#488 mở] → VU#9 nhận  (event 5ms, done at 18.148)
t=18.171s  [slot#489 mở] → VU#5 nhận  (event 5ms, done at 18.176)
t=18.200s  [slot#490 mở] → VU#3 nhận  (rảnh từ 18.005 — đã ready!)
...
```

> Với 10 VU pre-allocated và event time 5ms, VU pool quay vòng cực nhanh. Mỗi VU xử lý ~3.5 iteration/giây ở peak (35/10 = 3.5). Với duty cycle 5ms mỗi iteration, một VU có thể handle tối đa 200 iteration/giây (1s / 0.005s = 200). Tận dụng chưa đến 2% capacity của một VU.

---

## 3. Vì sao chọn ramping-arrival-rate?

### 3.1 Bảng so sánh executor

| Executor | Phù hợp? | Lý do |
|----------|----------|-------|
| **constant-vus** | Không | Rate cố định không phản ánh traffic pattern thực tế. 35/s liên tục là unrealistic. |
| **ramping-vus** | Không | Điều khiển VU → không kiểm soát được rate chính xác. Với event 5ms, VU tạo rate không ổn định. |
| **shared-iterations** | Không | Phân phối iteration cho VU, không đảm bảo arrival pattern. |
| **per-vu-iterations** | Không | Mỗi VU chạy N iteration — rate do tốc độ từng VU quyết định. |
| **ramping-arrival-rate** | **CÓ** | Kiểm soát chính xác arrival rate theo thời gian. Phù hợp với organic traffic ramp. |
| **constant-arrival-rate** | Một phần | Tốt cho sustained rate, nhưng không mô phỏng được quá trình ramp lên/ramp xuống. |

### 3.2 Ma trận quyết định chi tiết

| Tiêu chí | Trọng số | constant-vus | ramping-vus | ramping-arrival-rate |
|----------|----------|-------------|-------------|---------------------|
| Kiểm soát rate chính xác | 10 | 3 | 2 | **10** |
| Mô phỏng organic traffic ramp | 10 | 2 | 5 | **10** |
| Phát hiện drop ở rate cao | 9 | 3 | 4 | **9** |
| Độc lập VU/rate (Little's Law demo) | 9 | 8 | 6 | **9** |
| Dễ cấu hình stages | 7 | 8 | 7 | **8** |
| **Tổng trọng số** | | 185 | 200 | **445** |

### 3.3 Tại sao KHÔNG dùng constant-arrival-rate cho case này?

Constant-arrival-rate set một rate duy nhất (ví dụ 35/s) và giữ nguyên. Điều này:
- Không test được quá trình **chuyển tiếp giữa các rate** — đây chính là thứ gây ra drop trong production.
- Không phản ánh traffic pattern thực tế (ramp up → plateau → ramp down).
- Bỏ qua giai đoạn "rate thay đổi trong khi VU pool chưa kịp thích nghi".

Ramping-arrival-rate với 3 stages mô phỏng chính xác: warm-up (8→20), peak (20→35), cool-down (35→10).

### 3.4 Cấu trúc stages chi tiết

```
┌─────────────────────────────────────────────────────────────┐
│ Stage 1: Warm-up ramp                                       │
│   duration: 10s  |  rate: 8 → 20 req/s                      │
│   Mục đích: Mô phỏng traffic tăng dần khi user vào giờ nghỉ │
│   Tổng slots: 10 × (8+20)/2 = 140 slots                     │
│   Rate function: r(t) = 8 + (20-8) × t/10 = 8 + 1.2t       │
├─────────────────────────────────────────────────────────────┤
│ Stage 2: Peak ramp                                          │
│   duration: 15s  |  rate: 20 → 35 req/s                     │
│   Mục đích: Đẩy lên đỉnh 35/s — cao nhất toàn bộ series    │
│   Tổng slots: 15 × (20+35)/2 = 412.5 slots                  │
│   Rate function: r(t) = 20 + (35-20) × t/15 = 20 + t       │
├─────────────────────────────────────────────────────────────┤
│ Stage 3: Cool-down ramp                                     │
│   duration: 10s  |  rate: 35 → 10 req/s                     │
│   Mục đích: Traffic giảm khi user quay lại làm việc         │
│   Tổng slots: 10 × (35+10)/2 = 225 slots                    │
│   Rate function: r(t) = 35 + (10-35) × t/10 = 35 - 2.5t    │
└─────────────────────────────────────────────────────────────┘
Total duration: 35s  |  Total scheduled slots: 140 + 412.5 + 225 = 777.5 ≈ 778
Average target rate: 778 / 35 ≈ 22.2 req/s
```

### 3.5 Hình dạng ramp qua từng giây

| Giây | Rate (req/s) | Stage | Ghi chú |
|------|-------------|-------|---------|
| 0 | 8.0 | Stage 1 | Bắt đầu warm-up |
| 1 | 9.2 | Stage 1 | |
| 2 | 10.4 | Stage 1 | |
| 3 | 11.6 | Stage 1 | |
| 4 | 12.8 | Stage 1 | |
| 5 | 14.0 | Stage 1 | |
| 6 | 15.2 | Stage 1 | |
| 7 | 16.4 | Stage 1 | |
| 8 | 17.6 | Stage 1 | |
| 9 | 18.8 | Stage 1 | |
| 10 | 20.0 | Stage 1→2 | Chuyển stage |
| 11 | 21.0 | Stage 2 | |
| 12 | 22.0 | Stage 2 | |
| 13 | 23.0 | Stage 2 | |
| 14 | 24.0 | Stage 2 | |
| 15 | 25.0 | Stage 2 | |
| 16 | 26.0 | Stage 2 | |
| 17 | 27.0 | Stage 2 | |
| 18 | 28.0 | Stage 2 | |
| 19 | 29.0 | Stage 2 | |
| 20 | 30.0 | Stage 2 | |
| 21 | 31.0 | Stage 2 | |
| 22 | 32.0 | Stage 2 | |
| 23 | 33.0 | Stage 2 | |
| 24 | 34.0 | Stage 2 | |
| 25 | 35.0 | Stage 2→3 | **PEAK 35/s** — chuyển stage |
| 26 | 32.5 | Stage 3 | Bắt đầu cool-down |
| 27 | 30.0 | Stage 3 | |
| 28 | 27.5 | Stage 3 | |
| 29 | 25.0 | Stage 3 | |
| 30 | 22.5 | Stage 3 | |
| 31 | 20.0 | Stage 3 | |
| 32 | 17.5 | Stage 3 | |
| 33 | 15.0 | Stage 3 | |
| 34 | 12.5 | Stage 3 | |
| 35 | 10.0 | Stage 3 | Kết thúc |

---

## 4. Phân tích nguyên nhân gốc kỹ thuật

### RC1: Little's Law — 35/s × 5ms = <1 VU

#### 4.1.1 Công thức Little's Law

```
L = λ × W

Trong đó:
  L = số lượng VU cần thiết (concurrency)
  λ = arrival rate (req/s)
  W = thời gian xử lý trung bình (s)
```

Áp dụng cho case 06 ở cache-hit scenario:

```
L = 35 req/s × 0.005s = 0.175 VU
→ Ceil: 1 VU
```

> **Kết luận gây sốc:** 1 VU duy nhất đủ để xử lý 35 req/s — miễn là mỗi request mất 5ms.

#### 4.1.2 Bảng Little's Law cho từng stage

| Stage | Rate (req/s) | W_eff (cache hit) | L cần (VU) | W_eff (cache miss) | L cần (VU) |
|-------|-------------|-------------------|------------|-------------------|------------|
| Stage 1 (đầu) | 8 | 5ms | 0.04 → 1 | 20ms | 0.16 → 1 |
| Stage 1 (cuối) | 20 | 5ms | 0.10 → 1 | 20ms | 0.40 → 1 |
| Stage 2 (đầu) | 20 | 5ms | 0.10 → 1 | 20ms | 0.40 → 1 |
| Stage 2 (cuối) | 35 | 5ms | 0.175 → 1 | 20ms | 0.70 → 1 |
| Stage 3 (đầu) | 35 | 5ms | 0.175 → 1 | 20ms | 0.70 → 1 |
| Stage 3 (cuối) | 10 | 5ms | 0.05 → 1 | 20ms | 0.20 → 1 |

> **Nhận xét:** Kể cả cache miss scenario, 1 VU vẫn đủ cho toàn bộ các stage. Đây là lý do preAllocatedVUs=10 là **massive over-provisioning** — gấp 10 lần nhu cầu lý thuyết.

#### 4.1.3 So sánh với case 04 (inverse relationship)

| Chỉ số | Case 04 (Product Detail) | Case 06 (Feed Ingress) | Hệ số chênh lệch |
|--------|--------------------------|------------------------|-----------------|
| Peak rate | 10 req/s | 35 req/s | 06 cao gấp **3.5×** |
| W_effective | 1200ms | 5ms | 04 cao gấp **240×** |
| L = λ × W | 10 × 1.2 = **12 VU** | 35 × 0.005 = **0.175 VU** | 04 cao gấp **68.6×** |
| preAllocatedVUs | 12 | 10 | Gần bằng nhau |
| Kết luận | VU-bound (rate thấp nhưng event chậm) | Rate-bound (rate cao nhưng event nhanh) | Hai mặt của cùng đồng xu |

**Biểu đồ quan hệ nghịch đảo:**

```
Rate (req/s)          Latency (ms)           VU cần
    35 ┤● Case 06         1200 ┤● Case 04        12 ┤● Case 04
    30 ┤                    900 ┤                  9 ┤
    20 ┤                    600 ┤                  6 ┤
    10 ┤● Case 04           300 ┤                  3 ┤
     5 ┤                      5 ┤● Case 06         1 ┤● Case 06
     0 └────                   0 └────               0 └────

Rate cao không có nghĩa cần nhiều VU.
Latency mới là driver chính của VU demand.
```

### RC2: Cache hit vs cache miss thay đổi W_effective

#### 4.2.1 Mô hình cache two-tier

```
┌──────────────┐     hit (85-95%)     ┌──────────────┐
│   L1: Redis  │ ←────────────────── │  API Worker  │
│   (in-memory)│                      │  (Node.js)   │
└──────┬───────┘                      └──────┬───────┘
       │ miss (5-15%)                       │
       ▼                                    ▼
┌──────────────┐                   ┌──────────────┐
│   L2: PostgreSQL │                │  Response →  │
│   (on-disk)     │                │  Client      │
└─────────────────┘                └──────────────┘
```

#### 4.2.2 W_effective breakdown theo cache state

| Cache state | Xác suất | W_effective | Thành phần |
|-------------|----------|-------------|------------|
| **L1 hit (Redis)** | 85% | 3-5ms | Redis round-trip (0.5ms) + JSON serialize (1ms) + network (1-2ms) |
| **L1 miss → L2 hit** | 12% | 15-20ms | Redis miss (0.5ms) + PostgreSQL query (10-15ms) + serialize (1ms) + Redis write-back (1ms) |
| **L2 miss (cold)** | 2% | 80-120ms | PostgreSQL query (15ms) + personalization model compute (50-80ms) + cache fill (5ms) |
| **Cold start (empty cache)** | 1% | 200-500ms | Full pipeline: model load, DB query, cache population |

#### 4.2.3 Expected W_effective (weighted average)

```
E[W] = 0.85 × 5ms + 0.12 × 20ms + 0.02 × 100ms + 0.01 × 350ms
     = 4.25 + 2.40 + 2.00 + 3.50
     = 12.15ms
```

Với E[W] = 12.15ms, Little's Law ở peak 35/s:

```
L = 35 × 0.01215 = 0.425 VU → ceil: 1 VU
```

Vẫn chỉ cần 1 VU. preAllocatedVUs=10 thừa 10 lần so với expected case, thừa ~2.4 lần so với worst case (cold start toàn bộ).

#### 4.2.4 Tác động của cache miss đến VU demand

| Cache hit ratio | W_eff trung bình | VU cần ở 35/s | VU cần ở 35/s (p99 safety) |
|-----------------|-----------------|---------------|---------------------------|
| 100% (all hit) | 5ms | 1 | 1 |
| 95% | 8.5ms | 1 | 2 |
| 90% | 12.2ms | 1 | 2 |
| 80% | 19.5ms | 1 | 2 |
| 50% | 51ms | 2 | 3 |
| 20% | 82ms | 3 | 5 |
| 0% (all miss) | 113ms | 4 | 7 |

> **Ngưỡng nguy hiểm:** Cache hit ratio dưới 50% bắt đầu đẩy VU demand lên >2. Dưới 20%, cần 3-5 VU. Tuy vậy, preAllocatedVUs=10 vẫn dư sức.

### RC3: Ticker period ở 35/s = 28.6ms

#### 4.3.1 Định nghĩa ticker period

Ticker là cơ chế nội bộ của ramping-arrival-rate: một internal clock mở slot mới theo đúng rate được tính toán. Ticker period = 1 / current_rate.

| Rate (req/s) | Ticker period (ms) | Tần suất mở slot |
|-------------|-------------------|-----------------|
| 8 | 125.0 | Mỗi 125ms |
| 10 | 100.0 | Mỗi 100ms |
| 15 | 66.7 | Mỗi 66.7ms |
| 20 | 50.0 | Mỗi 50ms |
| 25 | 40.0 | Mỗi 40ms |
| 30 | 33.3 | Mỗi 33.3ms |
| **35** | **28.6** | **Mỗi 28.6ms** |

#### 4.3.2 So sánh ticker period với W_effective

Đây là insight quan trọng nhất của case 06:

```
Ticker period (28.6ms)  >>  W_effective (5ms)

→ Một VU hoàn thành event (5ms) và rảnh trước khi slot tiếp theo được mở (sau 23.6ms)
→ VU luôn sẵn sàng nhận slot mới
→ Không có backpressure, không có queue buildup
```

So sánh với case 04:

```
Ticker period (giả sử 100ms ở 10/s)  <<  W_effective (1200ms)

→ Một VU cần 1200ms để hoàn thành event
→ Trong khi đó, mỗi 100ms có slot mới được mở
→ Cần 1200/100 = 12 VU concurrent để không drop
```

#### 4.3.3 Timeline minh họa

```
Timeline ở 35/s, 3 VU, mỗi event 5ms (minh họa over-provisioning):

VU#1: ██░░░░░░░░░░░░░░░░░░░░░░░░░░██░░░░░░░░░░░░░░░░░░░░░░░░░░██░░░░...
VU#2: ░░░░░░██░░░░░░░░░░░░░░░░░░░░░░░░░░░██░░░░░░░░░░░░░░░░░░░░░░░░░░░...
VU#3: ░░░░░░░░░░░░██░░░░░░░░░░░░░░░░░░░░░░░░░░░██░░░░░░░░░░░░░░░░░░░░░░...

█ = 5ms active, ░ = idle
Mỗi ký tự ≈ 3.6ms

→ VU idle ~94% thời gian ở peak 35/s
→ 10 VU là lãng phí tài nguyên, nhưng an toàn cho edge case
```

### RC4: Rate transitions kiểm tra VU pool responsiveness

#### 4.4.1 Ba điểm chuyển stage

| Thời điểm | Chuyển stage | Rate thay đổi | Δ rate | Ticker period thay đổi |
|-----------|-------------|---------------|--------|----------------------|
| t=10s | Stage 1 → Stage 2 | 20 → 20 (liên tục) | 0 | Không đổi (50ms→50ms) |
| t=25s | Stage 2 → Stage 3 | 35 → 35 (liên tục) | 0 | Không đổi (28.6ms→28.6ms) |
| (Stage 2 nội bộ) | Ramp 20→35 | Tăng dần | +1/s mỗi giây | Từ 50ms giảm dần về 28.6ms |

**Lưu ý:** Với linear ramp trong một stage, ticker period thay đổi **liên tục** từng mili-giây một — không phải discrete jump. Điều này "mượt" hơn nhiều so với stage transition kiểu bậc thang.

#### 4.4.2 Điều gì xảy ra với VU pool khi rate tăng?

Khi rate tăng từ 20 lên 35 trong stage 2:

```
Tại t=10s: 20 req/s → ticker mỗi 50ms → VU cần: 20 × 0.005 = 0.1 → 1 VU
                                                          (pool 10 VU, 9 idle)

Tại t=17.5s: 27.5 req/s → ticker mỗi 36.4ms → VU cần: 27.5 × 0.005 = 0.14 → 1 VU
                                                              (pool 10 VU, 9 idle)

Tại t=25s: 35 req/s → ticker mỗi 28.6ms → VU cần: 35 × 0.005 = 0.175 → 1 VU
                                                        (pool 10 VU, 9 idle)
```

> **Kết luận:** Với event nhanh (5ms), rate tăng không tạo áp lực lên VU pool. VU luôn rảnh trước khi slot tiếp theo mở. Không có backpressure.

#### 4.4.3 Khi nào rate transition mới gây vấn đề?

Rate transition chỉ gây vấn đề khi **ticker period ≤ W_effective**. Lúc đó:

```
Mỗi lần một VU hoàn thành event, đã có 1+ slot mới được mở trong lúc nó đang bận
→ Cần thêm VU để nhận các slot đó
→ Nếu không đủ VU → drop iteration
```

Ngưỡng nguy hiểm cho case 06 (W_eff = 5ms):

```
Ticker period = W_effective → 1/rate = 0.005 → rate = 200 req/s
```

Tức là phải đạt **200 req/s** mới bắt đầu cần >1 VU. 35/s còn cách xa ngưỡng này.

Ngưỡng nguy hiểm cho case 04 (W_eff = 1200ms):

```
Ticker period = W_effective → 1/rate = 1.2 → rate = 0.83 req/s
```

Case 04 đã vượt ngưỡng này từ lâu — đó là lý do cần 12 VU.

### RC5: AB/geo/device headers tạo request diversity

#### 4.5.1 Header matrix

| Header | Giá trị | Phân phối | Mục đích |
|--------|---------|-----------|----------|
| `X-Ab-Variant` | `control`, `variant_a`, `variant_b` | 33/33/34% | A/B testing personalization algorithm |
| `X-Geo-Country` | `VN`, `US` | 70/30% | Geo-routing, CDN edge selection |
| `X-Device-Class` | `mobile`, `desktop` | 85/15% | Responsive payload sizing |

Tổ hợp: 3 × 2 × 2 = **12 unique header combinations**.

#### 4.5.2 Tác động đến execution

| Header combination | % traffic | Tác động đến latency? | Tác động đến VU demand? |
|-------------------|-----------|----------------------|------------------------|
| control/VN/mobile | ~19.6% | Baseline | Không |
| variant_a/VN/mobile | ~19.6% | ±2ms (different model path) | Không |
| variant_b/VN/mobile | ~20.0% | ±2ms | Không |
| control/US/mobile | ~8.4% | +5ms (cross-region Redis read) | Không |
| variant_a/US/mobile | ~8.4% | +5ms | Không |
| variant_b/US/mobile | ~8.5% | +5ms | Không |
| control/VN/desktop | ~3.5% | +1ms (larger payload) | Không |
| variant_a/VN/desktop | ~3.5% | +1ms | Không |
| variant_b/VN/desktop | ~3.5% | +1ms | Không |
| control/US/desktop | ~1.5% | +6ms | Không |
| variant_a/US/desktop | ~1.5% | +6ms | Không |
| variant_b/US/desktop | ~1.5% | +6ms | Không |

> **Quan sát:** Header diversity KHÔNG tạo ra execution bottleneck. Các variant đều hit cùng Redis cache, cùng database schema. Sự khác biệt về latency là nhỏ (<10ms) và không làm thay đổi kết luận Little's Law.

#### 4.5.3 Tại sao header diversity quan trọng dù không ảnh hưởng latency?

1. **A/B test validity:** Cần đảm bảo các variant được phân phối đúng tỉ lệ trong môi trường load test.
2. **Geo-routing correctness:** Request từ US phải được route đến US Redis replica, không phải VN master.
3. **Cache key diversity:** Mỗi header combination tạo cache key khác nhau → test cache warming strategy.
4. **CDN behavior:** CDN cache key thường dựa trên header → cần verify không miss cache vì header khác biệt.

---

## 5. Identity model deep-dive

### 5.1 Virtual user pool

| Thuộc tính | Giá trị | Giải thích |
|-----------|--------|------------|
| Pool size | 1000 users | Đủ lớn để diversity, không quá lớn gây memory pressure |
| AB variant assignment | Round-robin: control → variant_a → variant_b → control → ... | Đảm bảo phân phối 33/33/34% |
| Geo assignment | Weighted random: 70% VN, 30% US | Phản ánh user base thực tế |
| Device assignment | Weighted random: 85% mobile, 15% desktop | Mobile-first platform |
| User ID format | `feed_user_{0000-0999}` | Predictable, dễ debug |
| Session persistence | Không (stateless) | Mỗi iteration là một request độc lập |

### 5.2 AB variant rotation logic

```javascript
// Pseudocode — minh họa logic AB variant assignment
const AB_VARIANTS = ['control', 'variant_a', 'variant_b'];

function getAbVariant(vuId) {
  // Round-robin, không dùng random để đảm bảo phân phối chính xác
  return AB_VARIANTS[vuId % 3];
}
```

### 5.3 Identity trong iteration context

Mỗi iteration (1 API call) sử dụng identity được chọn từ pool. Identity quyết định:

| Thành phần | Cách chọn | Ảnh hưởng |
|-----------|----------|-----------|
| **User ID** | Ngẫu nhiên từ pool 1000 | Personalization data khác nhau → cache key khác nhau |
| **AB variant** | `vuId % 3` | Đường dẫn model khác nhau (control dùng baseline, variant dùng model mới) |
| **Geo country** | Weighted random | Route đến Redis replica khác nhau, CDN edge khác nhau |
| **Device class** | Weighted random | Payload size khác nhau (mobile: json_items=6, desktop: json_items=12) |
| **Product ID** (recommendations) | Ngẫu nhiên từ catalog 10K sản phẩm | Recommendation algorithm input khác nhau |

### 5.4 Tương tác identity × cache

Đây là điểm tinh tế: identity diversity ảnh hưởng đến cache behavior.

```
Cache key cho homefeed:  "homefeed:{user_id}:{ab_variant}:{geo}:{device}"
Cache key cho recommendations: "rec:{product_id}:{user_id}:{ab_variant}"

Số lượng cache key tối đa:
  Homefeed: 1000 users × 3 variants × 2 geos × 2 devices = 12,000 keys
  Recommendations: 10,000 products × 1000 users × 3 variants = 30,000,000 keys (lý thuyết)

Thực tế:
  - Homefeed: 12,000 keys × 2KB avg = ~24MB Redis memory
  - Recommendations: Cache policy pre-compute top 100 products per user
    → 1000 users × 100 products × 3 variants = 300,000 keys × 1KB = ~300MB
```

Với 778 iteration trong 35s, chỉ một phần nhỏ cache keys được truy cập:

```
778 iterations / 12,000 possible homefeed keys ≈ 6.5% coverage
778 iterations / 300,000 possible rec keys ≈ 0.26% coverage
```

> Điều này có nghĩa: trong test 35 giây, phần lớn request sẽ là **cache miss** nếu cache chưa được warm. Đây là một caveat quan trọng khi diễn giải kết quả test ngắn.

---

## 6. Phân tích open model với high-rate ramp

### 6.1 Open model là gì?

Trong queueing theory, **open model** (hay open queueing network) là hệ thống mà arrival rate độc lập với system state — request đến theo lịch định sẵn, không phụ thuộc vào việc hệ thống có đang bận hay không. Đây chính xác là những gì ramping-arrival-rate làm.

Ngược lại, **closed model** có số lượng user cố định, mỗi user gửi request, đợi response, rồi mới gửi request tiếp theo (think-time). Constant-vus và ramping-vus là closed model.

### 6.2 So sánh open vs closed cho feed scenario

| Đặc điểm | Open model (ramping-arrival-rate) | Closed model (ramping-vus) |
|----------|----------------------------------|---------------------------|
| Arrival pattern | Độc lập với response time | Phụ thuộc response time (VU đợi response mới gửi tiếp) |
| Tự nhiên cho web traffic? | **Có** — user không đợi response mới scroll tiếp | Không — user scroll bất kể response trước đó |
| Phát hiện degradation? | **Có** — nếu system chậm, iteration queue dài ra, drop xuất hiện | Một phần — VU tự "điều tiết" khi system chậm |
| Phù hợp cho feed? | **Rất phù hợp** — infinite scroll tạo stream request độc lập | Không phù hợp |

### 6.3 Cache miss scenario trong open model

Đây là scenario thú vị nhất của case 06: **cache miss cascade trong open model**.

Giả sử cache hit ratio giảm từ 95% xuống 50% (ví dụ: sau Redis failover, cache bị flush một phần):

```
Trước cache degradation:
  W_eff = 5ms (95% hit) → L = 35 × 0.005 = 0.175 VU → 1 VU đủ

Sau cache degradation:
  W_eff = 51ms (50% hit) → L = 35 × 0.051 = 1.785 VU → 2 VU cần
  
Vẫn OK với preAllocatedVUs=10 → còn 8 VU buffer.
```

Nhưng nếu degradation nghiêm trọng hơn:

```
Cache miss 80% + DB chậm:
  W_eff = 80ms → L = 35 × 0.08 = 2.8 → 3 VU
  
Cache miss 100% + cold start:
  W_eff = 113ms → L = 35 × 0.113 = 3.96 → 4 VU
```

> **Kết luận:** Ngay cả worst case (100% cache miss, cold start), 4 VU vẫn đủ. preAllocatedVUs=10 có safety margin 2.5× so với worst case.

### 6.4 Open model stability condition

Điều kiện ổn định của open model:

```
ρ = λ × W / c  <  1

Trong đó:
  ρ = utilization
  λ = arrival rate
  W = service time
  c = số lượng server (VU, trong ngữ cảnh k6)

Với case 06: ρ = 35 × 0.005 / 10 = 0.0175 = 1.75%
```

> Hệ thống gần như **idle** từ góc nhìn queueing theory. Utilization 1.75% có nghĩa 98.25% thời gian các VU không làm gì.

So sánh với case 04:

```
ρ = 10 × 1.2 / 12 = 1.0 = 100%
```

Case 04 chạy ở **100% utilization** — sát giới hạn ổn định. Một chút degradation là drop ngay.

### 6.5 Phân tích M/M/c cho từng stage

Giả sử arrival là Poisson (trong thực tế, k6 dùng deterministic schedule, nhưng Poisson là worst-case approximation):

| Stage | λ (req/s) | W (ms) | c (VU) | ρ = λW/c | P(wait) Erlang-C | Avg queue length |
|-------|----------|--------|--------|----------|-----------------|-----------------|
| S1 đầu | 8 | 5 | 10 | 0.004 | ~0 | ~0 |
| S1 cuối | 20 | 5 | 10 | 0.01 | ~0 | ~0 |
| S2 cuối | 35 | 5 | 10 | 0.0175 | ~0 | ~0 |
| S2 cuối (cache miss) | 35 | 51 | 10 | 0.1785 | 3.2×10⁻¹³ | ~0 |
| S2 cuối (cold) | 35 | 113 | 10 | 0.3955 | 6.7×10⁻⁷ | ~0 |

> Ở tất cả các stage và scenario, xác suất phải đợi (P(wait)) gần như bằng 0. Hệ thống luôn có VU sẵn sàng.

---

## 7. Bảng service/API flow

### 7.1 Tổng quan flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        ITERATION FLOW                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Chọn identity từ pool (user_id, ab_variant, geo, device)   │
│                           │                                     │
│                           ▼                                     │
│  2. Weighted branch (65/35)                                     │
│          │                    │                                 │
│          ▼                    ▼                                 │
│   ┌──────────────┐   ┌──────────────────────────┐              │
│   │  HOMEFEED    │   │    RECOMMENDATIONS        │              │
│   │  (65%)       │   │    (35%)                  │              │
│   │              │   │                           │              │
│   │ GET /api/sim/│   │ GET /api/sim/products/    │              │
│   │ products/    │   │ {id}/recommendations      │              │
│   │ homefeed     │   │                           │              │
│   └──────┬───────┘   └──────────┬────────────────┘              │
│          │                      │                               │
│          ▼                      ▼                               │
│  3. Set headers: X-Ab-Variant, X-Geo-Country, X-Device-Class   │
│                           │                                     │
│                           ▼                                     │
│  4. Thực thi HTTP request                                       │
│                           │                                     │
│                           ▼                                     │
│  5. Check response (status 200, valid JSON, item count)        │
│                           │                                     │
│                           ▼                                     │
│  6. Ghi metrics (tags: endpoint, ab_variant, geo, device,      │
│     cache_status)                                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Homefeed endpoint chi tiết

| Thuộc tính | Giá trị |
|-----------|--------|
| Method | GET |
| Path | `/api/sim/products/homefeed` |
| Query params | `json_items=12` (mobile: 6, nhưng weighted branch chọn param) |
| Weight | 65% iterations |
| Expected status | 200 |
| Response body | JSON array of product objects |
| Response size | ~2-8KB (tùy device: mobile compact, desktop full) |
| Cache key | `homefeed:{user_id}:{ab_variant}:{geo}:{device}` |
| Cache TTL | 60s (CDN), 300s (Redis) |
| Personalization | Có — dựa trên user purchase history, browse history, affinity score |
| Latency profile | p50=3ms, p95=5ms, p99=12ms (cache hit) |

**Cấu trúc response homefeed:**

```json
{
  "items": [
    {
      "id": "prod_8723",
      "title": "Áo thun cotton premium",
      "price": 250000,
      "currency": "VND",
      "thumbnail": "https://cdn.example.com/p/prod_8723_thumb.jpg",
      "score": 0.94,
      "reason": "Dựa trên lịch sử mua hàng"
    },
    // ... 11 items nữa với mobile, 5 items với desktop
  ],
  "next_cursor": "eyJvZmZzZXQiOjEyfQ==",
  "personalization_model": "control"
}
```

### 7.3 Recommendations endpoint chi tiết

| Thuộc tính | Giá trị |
|-----------|--------|
| Method | GET |
| Path | `/api/sim/products/{product_id}/recommendations` |
| Path param | `product_id` — ngẫu nhiên từ catalog 10K sản phẩm |
| Query params | `limit=6` |
| Weight | 35% iterations |
| Expected status | 200 |
| Response body | JSON array of recommended product objects |
| Response size | ~1-4KB |
| Cache key | `rec:{product_id}:{user_id}:{ab_variant}` |
| Cache TTL | 300s (Redis), không cache CDN (personalized) |
| Algorithm | Collaborative filtering (user-based + item-based hybrid) |
| Latency profile | p50=4ms, p95=7ms, p99=18ms (cache hit) |

**Cấu trúc response recommendations:**

```json
{
  "source_product_id": "prod_8723",
  "recommendations": [
    {
      "id": "prod_4521",
      "title": "Quần jeans slim fit",
      "price": 450000,
      "currency": "VND",
      "thumbnail": "https://cdn.example.com/p/prod_4521_thumb.jpg",
      "score": 0.89,
      "algorithm": "collaborative_user_based"
    },
    // ... 5 items nữa
  ],
  "model_version": "cf_v4.2.1"
}
```

### 7.4 Header specification

| Header | Type | Ví dụ | Ghi chú |
|--------|------|-------|---------|
| `X-Ab-Variant` | string | `control`, `variant_a`, `variant_b` | Gửi trong mọi request |
| `X-Geo-Country` | string (ISO 3166-1 alpha-2) | `VN`, `US` | Ảnh hưởng routing |
| `X-Device-Class` | string | `mobile`, `desktop` | Ảnh hưởng payload size |
| `Accept` | string | `application/json` | Standard |
| `Accept-Encoding` | string | `gzip, br` | Compression support |
| `User-Agent` | string | `SocialApp/4.2.1 (iPhone; iOS 18)` | Theo device class |

### 7.5 Check assertions

| # | Assertion | Endpoint | Mục đích |
|---|-----------|----------|----------|
| 1 | `response.status === 200` | Cả hai | HTTP success |
| 2 | `response.timings.duration < 100` | Cả hai | SLA p99 — mọi request dưới 100ms |
| 3 | `json.items.length >= 1` | Homefeed | Có ít nhất 1 sản phẩm trả về |
| 4 | `json.recommendations.length === 6` | Recommendations | Đúng limit=6 |
| 5 | `json.items[0].id` exists | Homefeed | Response structure valid |
| 6 | `response.headers['Content-Type']` includes `application/json` | Cả hai | Đúng content type |
| 7 | `response.timings.waiting < 50` | Cả hai | TTFB dưới 50ms (backend xử lý nhanh) |
| 8 | `json.recommendations[0].score > 0` | Recommendations | Score hợp lệ |

### 7.6 Error handling trong script

| HTTP status | Ý nghĩa | Hành vi trong test |
|------------|---------|-------------------|
| 200 | OK | Pass check, record metrics |
| 304 | Not Modified | Pass (CDN hit), nhưng đếm là cache hit |
| 401 | Unauthorized | **FAIL** — identity config sai |
| 404 | Product not found | **FAIL** — product_id từ catalog không tồn tại |
| 429 | Rate limited | **FAIL** — vượt rate limit của API Gateway |
| 500 | Internal Server Error | **FAIL** — backend crash |
| 502/503 | Bad Gateway/Unavailable | **FAIL** — upstream không reachable |
| Timeout | Request > 5s | **FAIL** — network hoặc backend hang |

---

## 8. Metrics & tags deep-dive

### 8.1 Built-in metrics quan trọng nhất

| Metric | Ý nghĩa trong case 06 | Cách đọc |
|--------|----------------------|----------|
| `http_req_duration` | Response time toàn bộ request (DNS+TCP+TLS+waiting+receiving) | p95 phải < 15ms cho cache hit |
| `http_req_waiting` | TTFB — thời gian từ lúc gửi request đến khi nhận byte đầu tiên | p95 < 10ms |
| `http_req_failed` | Tỉ lệ request lỗi (status ≥ 400 hoặc timeout) | Phải = 0 |
| `iterations` | Tổng số iteration đã hoàn thành | Phải = total scheduled ≈ 778 |
| `iteration_duration` | Thời gian hoàn thành một iteration (từ setup đến teardown) | p95 < 15ms |
| `dropped_iterations` | Số iteration bị drop do không có VU sẵn sàng | Phải = 0 |
| `vus` | Số VU đang active | Dao động 1-10, thường ở mức thấp |
| `vus_max` | Số VU tối đa được cấp | 30 (maxVUs) |
| `checks` | Tỉ lệ check pass | 100% |
| `data_received` | Tổng dữ liệu nhận về | ~778 × 4KB avg ≈ 3.1MB |
| `data_sent` | Tổng dữ liệu gửi đi | Nhỏ (~778 × 500B ≈ 380KB) |

### 8.2 Custom tags

| Tag | Nguồn | Giá trị | Mục đích phân tích |
|-----|-------|--------|-------------------|
| `endpoint` | Script logic | `homefeed`, `recommendations` | So sánh performance hai endpoint |
| `ab_variant` | Identity model | `control`, `variant_a`, `variant_b` | Phân tích hiệu năng theo AB variant |
| `geo` | Identity model | `VN`, `US` | Geo latency comparison |
| `device` | Identity model | `mobile`, `desktop` | Device-class performance |
| `cache_status` | Response header `X-Cache-Status` | `HIT`, `MISS`, `REVALIDATED` | Cache effectiveness |
| `product_id` | Identity model | `prod_XXXX` | Chỉ cho recommendations |
| `stage` | Derived từ thời gian test | `warmup`, `peak`, `cooldown` | Phân tích theo stage |

### 8.3 Custom metrics (Trend)

| Metric name | Type | Tag | Ý nghĩa |
|------------|------|-----|---------|
| `homefeed_latency` | Trend | `ab_variant`, `geo`, `device` | Homefeed response time riêng |
| `recommendations_latency` | Trend | `ab_variant`, `geo`, `device` | Recommendations response time riêng |
| `homefeed_item_count` | Trend | — | Số lượng items trong response homefeed |
| `recommendations_count` | Trend | — | Số lượng recommendations (phải luôn = 6) |
| `cache_hit_ratio` | Gauge | `endpoint` | Tỉ lệ cache hit实时 — quan trọng nhất cho case này |

### 8.4 Cách đọc metrics theo từng stage

| Stage | Metric cần theo dõi | Expected | Nếu sai → vấn đề gì? |
|-------|-------------------|----------|---------------------|
| Stage 1 (warm-up) | `http_req_duration` p95 | < 10ms | Cache chưa warm → latency cao hơn |
| Stage 1 | `vus` | 1-2 | VU pool đang scale up |
| Stage 1 | `dropped_iterations` | 0 | Nếu > 0: preAllocatedVUs không kịp sẵn sàng |
| Stage 2 (peak) | `http_req_duration` p95 | < 15ms | Nếu > 15ms: cache miss hoặc DB chậm |
| Stage 2 | `iterations rate` | 20-35/s | Rate có theo kịp target không? |
| Stage 2 | `dropped_iterations` | 0 | **QUAN TRỌNG NHẤT:** drop ở peak = VU không đủ |
| Stage 2 | `vus` | 1-5 | Thấp hơn 10 → over-provisioning confirmed |
| Stage 3 (cool-down) | `http_req_duration` p95 | < 10ms | System đã ổn định |
| Stage 3 | `dropped_iterations` | 0 | Rate giảm, càng không nên có drop |
| Toàn test | `checks` rate | 100% | Check assertion nào fail? |
| Toàn test | `cache_hit_ratio` | > 80% | Nếu thấp → cache warming strategy cần review |

### 8.5 Bảng cross-tab analysis

Kết hợp tags để phân tích sâu:

```
http_req_duration{endpoint:homefeed} vs http_req_duration{endpoint:recommendations}
  → Recommendations có chậm hơn homefeed không? Bao nhiêu?

http_req_duration{geo:VN} vs http_req_duration{geo:US}
  → Cross-region latency penalty là bao nhiêu?

http_req_duration{ab_variant:control} vs http_req_duration{ab_variant:variant_a}
  → Variant model có chậm hơn control không?

http_req_duration{cache_status:HIT} vs http_req_duration{cache_status:MISS}
  → Cache miss penalty = ? ms (quan trọng cho capacity planning)
```

### 8.6 Summary output mong đợi

```
============================================================
CASE 06: Feed Ingress Ramp — Summary
============================================================
Total iterations:           778 (scheduled: 778, actual: ???)
  - Homefeed:               ~506 (65%)
  - Recommendations:        ~272 (35%)
Dropped iterations:         0
Total duration:             35.0s
Peak rate achieved:         35.0 req/s
Average rate:               ~22.2 req/s

HTTP Request Duration:
  p50:                      ~4ms
  p95:                      ~8ms
  p99:                      ~15ms
  max:                      ~35ms

By endpoint:
  homefeed p95:             ~6ms
  recommendations p95:      ~9ms

By cache status:
  HIT p95:                  ~5ms
  MISS p95:                 ~22ms

VU usage:
  preAllocated:             10
  max concurrent used:      ~3
  avg concurrent used:      ~1.5
  utilization:              15%

Checks:                     100% pass (778/778)
HTTP failures:              0
Cache hit ratio:            87%

VERDICT: ✓ ALL PASS CRITERIA MET
  - Zero drops at 35/s peak
  - All 778 iterations completed
  - p95 < 15ms sustained
  - VU utilization well under 80%
============================================================
```

---

## 9. Pass criteria

### 9.1 Primary criteria (MUST PASS — blocking)

| # | Tiêu chí | Ngưỡng | Cách verify | Trọng số |
|---|---------|--------|------------|----------|
| P1 | `dropped_iterations` | = 0 | `k6 run` output: `dropped_iterations: 0` | **BLOCKER** |
| P2 | `iterations` completed | = 778 (±5, do rounding) | So sánh actual vs scheduled slots | **BLOCKER** |
| P3 | `http_req_failed` | < 0.1% (≤ 0 là lý tưởng) | `http_req_failed` metric = 0.00% | **BLOCKER** |
| P4 | `http_req_duration` p95 | < 15ms | Summary output | **BLOCKER** |
| P5 | `http_req_duration` p99 | < 50ms | Summary output | **BLOCKER** |

### 9.2 Secondary criteria (SHOULD PASS — non-blocking nhưng important)

| # | Tiêu chí | Ngưỡng | Cách verify |
|---|---------|--------|------------|
| S1 | Peak rate sustained | 34-36 req/s trong ít nhất 5s liên tục | Biểu đồ `http_reqs` rate |
| S2 | VU max concurrent | ≤ 20 (room cho spike) | `vus` metric |
| S3 | Homefeed p95 | < 10ms (cache hit scenario) | Tag-filtered `http_req_duration{endpoint:homefeed}` |
| S4 | Recommendations p95 | < 12ms (cache hit scenario) | Tag-filtered `http_req_duration{endpoint:recommendations}` |
| S5 | Cache hit ratio | > 75% | Custom metric `cache_hit_ratio` |
| S6 | Checks pass rate | 100% | `checks` metric |
| S7 | Geo latency delta (US - VN) | < 10ms | Cross-tab analysis |

### 9.3 Pass/fail decision matrix

| P1-P5 | S1-S7 | Kết luận | Hành động |
|-------|-------|----------|----------|
| All PASS | All PASS | **PERFECT PASS** | Sẵn sàng production. Theo dõi cache warming strategy. |
| All PASS | 1-2 FAIL | **CONDITIONAL PASS** | OK cho production, nhưng điều tra secondary criteria fail. |
| All PASS | 3+ FAIL | **PASS WITH NOTES** | Điều tra secondary failures trước khi deploy. |
| 1 FAIL (không phải P1) | Any | **SOFT FAIL** | Fix primary failure trước khi retest. |
| P1 FAIL (dropped > 0) | Any | **HARD FAIL** | Tăng preAllocatedVUs hoặc điều tra VU pool behavior. |
| 2+ FAIL | Any | **HARD FAIL** | Root cause analysis required. |

### 9.4 Ngưỡng pass chi tiết cho từng stage

| Stage | Rate range |Allowed drops | Allowed p95 (ms) | Allowed failures |
|-------|-----------|-------------|-----------------|-----------------|
| Stage 1 (0-10s) | 8→20 | 0 | < 20ms | 0 |
| Stage 2 (10-25s) | 20→35 | 0 | < 15ms (cache hit) / < 50ms (cache miss) | 0 |
| Stage 3 (25-35s) | 35→10 | 0 | < 15ms | 0 |

---

## 10. Cách chạy

### 10.1 Prerequisites

```bash
# Kiểm tra k6 version (cần ≥ 0.49.0 cho ramping-arrival-rate)
k6 version

# Đảm bảo target server đang chạy
curl -s http://localhost:3000/health | jq .
# Expected: {"status": "ok", "cache_warm": true}

# Pre-warm cache (khuyến nghị)
# Chạy script warm-cache.js để populate Redis với top users
k6 run --duration 30s --vus 5 scripts/warm-cache.js
```

### 10.2 Lệnh chạy cơ bản

```bash
k6 run \
  --out json=results/case06-feed-ingress-ramp.json \
  --out csv=results/case06-feed-ingress-ramp.csv \
  --tag testid=case06 \
  --tag scenario=feed-ingress-ramp \
  scripts/ramping-arrival-rate/rar-06-feed-ingress-ramp.js
```

### 10.3 Lệnh chạy với output đầy đủ

```bash
k6 run \
  --vus 10 \
  --duration 35s \
  --out json=results/case06-feed-ingress-ramp.json \
  --out csv=results/case06-feed-ingress-ramp.csv \
  --out cloud \
  --summary-export=results/case06-summary.json \
  --summary-trend-stats="p(50),p(90),p(95),p(99),min,max,avg,count" \
  --tag testid=case06 \
  --tag scenario=feed-ingress-ramp \
  --tag env=staging \
  --tag version=1.0.0 \
  scripts/ramping-arrival-rate/rar-06-feed-ingress-ramp.js
```

### 10.4 Environment variables

| Variable | Default | Mô tả |
|----------|---------|-------|
| `TARGET_HOST` | `http://localhost:3000` | Base URL của target server |
| `WARM_CACHE` | `true` | Có pre-warm cache trước test không? |
| `CACHE_HIT_RATIO_TARGET` | `0.85` | Cache hit ratio mong đợi |
| `LOG_LEVEL` | `warn` | k6 log level |
| `HEADER_AB_VARIANT` | `auto` | `auto` = round-robin, hoặc fixed value |
| `HEADER_GEO_RATIO_VN` | `0.7` | Tỉ lệ traffic từ VN |
| `HEADER_DEVICE_RATIO_MOBILE` | `0.85` | Tỉ lệ traffic từ mobile |

### 10.5 Chạy với Docker

```bash
docker run --rm \
  -v $(pwd)/scripts:/scripts \
  -v $(pwd)/results:/results \
  -e TARGET_HOST=http://host.docker.internal:3000 \
  grafana/k6:latest \
  run /scripts/ramping-arrival-rate/rar-06-feed-ingress-ramp.js
```

### 10.6 Tích hợp CI/CD

```yaml
# .github/workflows/perf-test-case06.yml
name: Performance Test - Case 06 Feed Ingress Ramp

on:
  pull_request:
    paths:
      - 'services/homefeed/**'
      - 'services/recommendations/**'
      - 'infra/redis/**'

jobs:
  perf-test-case06:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start services
        run: docker compose -f docker-compose.perf.yml up -d
      - name: Wait for healthy
        run: |
          until curl -s http://localhost:3000/health | jq -e '.status == "ok"'; do
            sleep 2
          done
      - name: Pre-warm cache
        run: k6 run --quiet scripts/warm-cache.js
      - name: Run Case 06
        run: |
          k6 run \
            --out json=results/case06.json \
            --summary-export=results/case06-summary.json \
            scripts/ramping-arrival-rate/rar-06-feed-ingress-ramp.js
      - name: Verify pass criteria
        run: |
          DROPS=$(jq '.metrics.dropped_iterations.values.count' results/case06-summary.json)
          P95=$(jq '.metrics.http_req_duration.values."p(95)"' results/case06-summary.json)
          FAILED=$(jq '.metrics.http_req_failed.values.rate' results/case06-summary.json)

          if [ "$DROPS" != "0" ]; then
            echo "FAIL: dropped_iterations=$DROPS (expected 0)"
            exit 1
          fi
          if (( $(echo "$P95 > 15" | bc -l) )); then
            echo "FAIL: p95=$P95 ms (expected < 15ms)"
            exit 1
          fi
          if (( $(echo "$FAILED > 0.001" | bc -l) )); then
            echo "FAIL: http_req_failed=$FAILED (expected < 0.1%)"
            exit 1
          fi
          echo "PASS: All criteria met"
      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: case06-results
          path: results/case06*.json
```

---

## 11. Phân tích output 5 bước

### Bước 1: Kiểm tra dropped_iterations và iteration count

Đây là bước đầu tiên và quan trọng nhất. Mở file summary JSON:

```bash
# Đọc summary
cat results/case06-summary.json | jq '{
  iterations: .metrics.iterations.values.count,
  dropped: .metrics.dropped_iterations.values.count,
  rate_avg: .metrics.http_reqs.values.rate,
  rate_peak: .metrics.http_reqs.values.rate
}'
```

**Phân tích:**

| Chỉ số | Expected | Cách interpret |
|--------|----------|---------------|
| `iterations.count` | 770-785 (≈778) | Nếu < 770: rate schedule không đạt target. Kiểm tra ticker behavior. |
| `dropped_iterations` | 0 | Nếu > 0: **VU pool không đủ**. Đây là failure mode chính — tăng preAllocatedVUs hoặc giảm maxRate. |
| `rate_avg` | 21-23/s | Phản ánh average rate ~22.2/s. Nếu thấp hơn nhiều: stages config sai. |
| Kiểm tra iteration count theo endpoint | homefeed ~506, rec ~272 | Nếu sai lệch >10%: weighted branch logic lỗi. |

**Failure pattern thường gặp:**

```
iterations.count = 650
dropped_iterations = 128

→ Có 128 slot bị drop. Kiểm tra VU utilization ở peak.
→ Nếu VU utilization = 100%: preAllocatedVUs không đủ.
→ Nếu VU utilization < 50%: VU có nhưng không nhận slot (VU scheduling issue).
```

### Bước 2: Phân tích http_req_duration

```bash
cat results/case06-summary.json | jq '{
  p50: .metrics.http_req_duration.values."p(50)",
  p95: .metrics.http_req_duration.values."p(95)",
  p99: .metrics.http_req_duration.values."p(99)",
  max: .metrics.http_req_duration.values.max,
  avg: .metrics.http_req_duration.values.avg
}'
```

**Bảng interpret theo kết quả:**

| p95 | p99 | Kết luận | Hành động |
|-----|-----|----------|----------|
| < 10ms | < 20ms | Cache hit ratio cao, system khỏe | Pass |
| 10-20ms | 20-50ms | Cache miss xuất hiện nhưng trong ngưỡng | Pass with notes — kiểm tra cache hit ratio |
| 20-50ms | 50-100ms | Cache miss nhiều hoặc DB chậm | Investigate — kiểm tra Redis/DB metrics |
| > 50ms | > 100ms | System degradation | **FAIL** — root cause analysis |

**Phân tích theo thời gian (dùng CSV output):**

```bash
# Trích xuất timestamp và duration từ CSV
cat results/case06-feed-ingress-ramp.csv | awk -F',' 'NR>1 {print $1,$5}' | head -20

# Plot đơn giản: duration theo thời gian
# Nếu duration tăng dần theo thời gian → cache warming issue hoặc memory leak
# Nếu duration spike đột ngột → GC pause, network blip, hoặc cache stampede
```

### Bước 3: Phân tích VU utilization và Little's Law verification

```bash
cat results/case06-summary.json | jq '{
  vus_max: .metrics.vus_max.values.value,
  vus_avg: .metrics.vus.values.avg,
  vus_peak: .metrics.vus.values.max
}'
```

**So sánh với Little's Law prediction:**

| VU actual (peak) | VU predicted (Little's Law) | Chênh lệch | Diễn giải |
|-----------------|----------------------------|------------|----------|
| 1-2 | 1 | 1-2× | Đúng dự đoán: cache hit scenario, event 5ms |
| 2-4 | 1-2 | 2× | Xuất hiện cache miss, W_eff cao hơn dự kiến |
| 5-8 | 2-4 | 2× | Cache miss nghiêm trọng hoặc backend chậm |
| > 10 | 1-4 | > 2.5× | **Bất thường** — VU demand vượt xa Little's Law → có thể là connection pool exhaustion, thread blocking, hoặc k6 internal overhead |

> **Insight:** VU utilization thấp KHÔNG phải là dấu hiệu xấu. Với case 06, utilization 15-20% là bình thường. Đây là bằng chứng cho thấy preAllocatedVUs=10 là over-provisioning có chủ đích.

### Bước 4: Phân tích theo endpoint và cache status

```bash
# Phân tích từ JSON output (streaming metrics)
cat results/case06-feed-ingress-ramp.json | \
  jq -r 'select(.type=="Point" and .metric=="http_req_duration") |
         select(.data.tags.endpoint=="homefeed") |
         .data.value' | \
  awk '{sum+=$1; count++; if($1>max) max=$1; if(NR==1||$1<min) min=$1} 
       END {print "homefeed: count="count" avg="sum/count"ms min="min"ms max="max"ms"}'

cat results/case06-feed-ingress-ramp.json | \
  jq -r 'select(.type=="Point" and .metric=="http_req_duration") |
         select(.data.tags.endpoint=="recommendations") |
         .data.value' | \
  awk '{sum+=$1; count++; if($1>max) max=$1; if(NR==1||$1<min) min=$1} 
       END {print "recommendations: count="count" avg="sum/count"ms min="min"ms max="max"ms"}'
```

**Bảng so sánh endpoint performance:**

| Endpoint | Count | Avg (ms) | Min (ms) | Max (ms) | p95 est. | Nhận xét |
|----------|-------|----------|----------|----------|---------|----------|
| Homefeed | ~506 | ~5 | ~2 | ~25 | ~8 | Nhanh hơn do cache hit ratio cao, query đơn giản |
| Recommendations | ~272 | ~7 | ~3 | ~35 | ~12 | Chậm hơn do collaborative algorithm lookup |
| Delta | — | +2ms | +1ms | +10ms | +4ms | Chấp nhận được |

**Phân tích cache status:**

```
Cache HIT:   ~87% requests → p95 ~5ms
Cache MISS:  ~13% requests → p95 ~22ms

Penalty: 22ms - 5ms = 17ms cho mỗi cache miss

Với 778 iterations:
  - 677 HIT:  677 × 5ms  = 3,385ms  processing time
  - 101 MISS: 101 × 22ms = 2,222ms  processing time
  - Total:                 = 5,607ms  ≈ 5.6s

Với 10 VU concurrent, total capacity = 10 × 35s = 350 VU-seconds
Utilization = 5.6s / 350s = 1.6%
```

### Bước 5: Root cause analysis nếu fail

**Decision tree cho case 06:**

```
dropped_iterations > 0?
├── YES → VU pool issue
│   ├── vus_max đạt maxVUs=30?
│   │   ├── YES → maxVUs không đủ. Tăng maxVUs hoặc giảm peak rate.
│   │   └── NO  → preAllocatedVUs không đủ cho rate transition.
│   │             Tăng preAllocatedVUs lên 15-20.
│   └── VU utilization < 30% nhưng vẫn drop?
│       → VU scheduling latency. k6 internal issue hoặc system resource contention.
│
└── NO → http_req_duration issue?
    ├── p95 > 50ms?
    │   ├── Cache miss ratio cao → pre-warm cache, tăng TTL
    │   ├── DB query chậm → check slow query log, add index
    │   └── Network latency → check cross-AZ routing
    │
    └── http_req_failed > 0?
        ├── 429 errors → rate limit hit. Điều chỉnh API Gateway rate limit.
        ├── 502/503 → upstream không healthy. Check service health.
        ├── Timeout → network hoặc backend quá tải. Tăng timeout hoặc scale.
        └── Check failures → assertion error. Verify response structure.
```

---

## 12. Dashboard 3-chart deep analysis

### 12.1 Chart 1: Response Time — Homefeed vs Recommendations

**Loại chart:** Time-series line chart với 2 series.

**Trục X:** Thời gian (0-35s)
**Trục Y:** http_req_duration (ms), scale 0-50ms

**Các đường:**
- `http_req_duration{endpoint:homefeed}` p95 — màu xanh lá
- `http_req_duration{endpoint:recommendations}` p95 — màu cam
- `http_req_duration{endpoint:homefeed}` p50 — màu xanh lá nhạt (dashed)
- `http_req_duration{endpoint:recommendations}` p50 — màu cam nhạt (dashed)
- Đường ngang đứt tại 15ms: SLA threshold

**Điều cần quan sát:**

1. **Homefeed luôn thấp hơn recommendations:** Đúng như dự đoán — homefeed query đơn giản hơn, cache hit ratio cao hơn.
2. **p95 ổn định qua các stage:** Vì event nhanh (5ms), rate tăng không làm tăng latency. Đây là dấu hiệu của system khỏe mạnh.
3. **Không có spike:** Nếu có spike đột ngột → cache stampede hoặc GC pause.
4. **Stage 1 (warm-up) có thể cao hơn chút:** Cache đang được warm, một số request là cache miss.
5. **Khoảng cách p50-p95 hẹp:** <5ms → latency distribution tập trung, không có tail latency vấn đề.

**Pattern nhận diện vấn đề:**

```
Pattern A: "Cái kéo mở rộng"
  p50 ổn định ở 4ms, nhưng p95 tăng từ 8ms lên 25ms ở stage 2
  → Cache miss ratio tăng khi rate cao hơn
  → Nguyên nhân: cache eviction do memory pressure

Pattern B: "Bậc thang"
  Latency đột ngột nhảy từ 5ms lên 20ms tại t=15s và giữ nguyên
  → Một node trong cluster bị degrade tại thời điểm đó
  → Nguyên nhân: GC pause, health check fail, hoặc connection pool exhaustion

Pattern C: "Răng cưa"
  Latency dao động 5ms → 30ms → 5ms → 30ms theo chu kỳ
  → Connection pool cycling hoặc rate limiter token bucket refill
```

### 12.2 Chart 2: Execution Timeline — Dense Ticker Visualization

**Loại chart:** Scatter plot hoặc event timeline.

**Trục X:** Thời gian (0-35s), zoom vào peak region (20-28s)
**Trục Y:** VU ID (1-10)

**Mỗi điểm = một iteration execution:**
- Màu xanh: homefeed iteration
- Màu cam: recommendations iteration
- Kích thước điểm: tỉ lệ với duration (nhưng tất cả đều nhỏ ~5ms)

**Điều cần quan sát:**

1. **Mật độ điểm tăng dần từ stage 1 đến stage 2:** Phản ánh rate tăng.
2. **Ở peak (25s, 35/s):** 35 điểm mỗi giây, mỗi điểm cách nhau ~28.6ms trên trục thời gian.
3. **Điểm trải đều trên tất cả VU:** Load được phân phối đều — không có VU nào bị "hot".
4. **Không có khoảng trống (gap):** Tất cả slot được lấp đầy → không có drop.
5. **Điểm gần như nằm ngang:** Duration quá nhỏ (5ms) so với scale 1 giây → gần như không thấy chiều dài.

**Tính toán mật độ:**

```
Tại peak 35/s, 10 VU:
  Mỗi VU nhận ~3.5 iterations/s
  Mỗi iteration kéo dài 5ms
  → Mỗi VU bận: 3.5 × 5ms = 17.5ms mỗi giây
  → Mỗi VU rảnh: 1000ms - 17.5ms = 982.5ms mỗi giây
  → Utilization: 1.75%
```

**Pattern nhận diện vấn đề:**

```
Pattern D: "Lỗ hổng" (Gaps)
  Có những khoảng thời gian không có điểm nào trên tất cả VU
  → Drop iteration — slot được mở nhưng không VU nào nhận

Pattern E: "Dồn cục" (Clumping)
  Nhiều điểm dồn vào 1-2 VU, các VU khác idle
  → VU scheduling không cân bằng
  → Có thể do sticky connection hoặc VU initialization chậm

Pattern F: "Đuôi dài" (Long tails)
  Một vài điểm có duration dài hơn hẳn (thấy được trên chart)
  → Cache miss hoặc slow DB query
```

### 12.3 Chart 3: VUs vs iter/s — Low VU Despite High Rate

**Loại chart:** Dual-axis time-series.

**Trục X:** Thời gian (0-35s)
**Trục Y trái:** Số lượng VU active (scale 0-15)
**Trục Y phải:** Iteration rate (req/s, scale 0-40)

**Các đường:**
- `vus` — màu xanh dương, area fill
- `iterations rate` (tính từ `http_reqs` rate) — màu đỏ, line
- Đường tham chiếu: target rate schedule — màu xám, dashed

**Đây là chart "nghịch lý" nhất của case 06:**

```
Rate (đỏ):    ▁▂▃▄▅▆▇███████████████▇▆▅▄▃▂▁  (8→35→10)
VUs (xanh):   ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁  (1-3 suốt test)

→ Rate tăng 4.4× (8→35) nhưng VUs gần như không đổi!
→ Đây chính là Little's Law trong thực tế: λ tăng nhưng W nhỏ nên L không đổi.
```

**So sánh chart này với case 04 (Product Detail):**

| Khía cạnh | Case 04 chart | Case 06 chart |
|-----------|--------------|---------------|
| Rate shape | 1→10 (tăng 10×) | 8→35→10 (ramp lên rồi xuống) |
| VUs shape | 1→12 (tăng theo rate) | 1→3→1 (gần như flat) |
| Correlation rate-VUs | **Dương** — VUs tăng khi rate tăng | **Yếu** — VUs gần như không đổi |
| Lý do | W=1200ms, nên rate × W = VU demand | W=5ms, nên rate thay đổi không ảnh hưởng VU demand |
| Bài học | Rate tăng → phải tăng VU | Rate tăng → không cần tăng VU nếu event nhanh |

**Điều cần quan sát:**

1. **Đường đỏ bám sát đường xám (target):** Rate schedule được thực thi chính xác.
2. **Đường xanh luôn dưới 5:** Xác nhận over-provisioning.
3. **Đường xanh không tăng khi rate tăng:** Xác nhận Little's Law prediction.
4. **Không có VU spike:** Không có tình huống cần burst VU đột ngột.

**Pattern nhận diện vấn đề:**

```
Pattern G: "VUs leo thang theo rate"
  Đường xanh tăng tỉ lệ với đường đỏ
  → W_effective cao hơn dự kiến (cache miss nhiều)
  → System đang ở trạng thái "VU-bound" thay vì "rate-bound"

Pattern H: "VUs chạm trần"
  Đường xanh chạm maxVUs=30
  → Nếu rate vẫn tăng → drop sắp xảy ra
  → Cần tăng maxVUs hoặc giảm peak rate

Pattern I: "Rate không đạt target"
  Đường đỏ thấp hơn đường xám, dù VUs còn dư
  → Không phải VU issue → là backend saturation
  → Backend không xử lý kịp dù VU đã gửi request
  → Kiểm tra http_req_waiting — nếu cao → backend bottleneck
```

---

## 13. 4 output→decision scenarios

### Scenario A: Perfect Pass — "35/s sustained, 0 drops, low VU"

**Profile kết quả:**

| Chỉ số | Giá trị |
|--------|--------|
| iterations | 778 / 778 scheduled |
| dropped_iterations | 0 |
| http_req_failed | 0.00% |
| http_req_duration p95 | 6ms |
| http_req_duration p99 | 14ms |
| VU peak | 3 |
| Cache hit ratio | 92% |
| Checks | 100% |

**Diễn giải:**

Đây là kết quả lý tưởng. Hệ thống hoạt động đúng như thiết kế:
- Cache hit ratio 92% → Redis hoạt động tốt, TTL phù hợp.
- 0 drops → VU pool đủ, ticker schedule hoàn hảo.
- p95 6ms → endpoint response time xuất sắc.
- VU peak 3 → over-provisioning factor 10/3 = 3.3×, an toàn.

**Quyết định:**

> **DEPLOY TO PRODUCTION** — Không cần thay đổi config. Hạ tầng hiện tại đủ sức chịu 35/s peak. Tiếp tục monitor cache hit ratio trong production; nếu giảm dưới 80%, pre-warm cache trước peak hour.

**Hành động cụ thể:**
1. Deploy lên production với cùng config (preAllocatedVUs=10, maxVUs=30).
2. Set up alert: `cache_hit_ratio < 0.75` → trigger cache warming job.
3. Set up alert: `http_req_duration p95 > 20ms` → investigate.
4. Document: "Feed ingress có thể chịu được 35/s với <10 VU."

### Scenario B: Cache Miss Scenario — "p95 rising, VU demand increasing"

**Profile kết quả:**

| Chỉ số | Giá trị |
|--------|--------|
| iterations | 778 / 778 scheduled |
| dropped_iterations | 0 |
| http_req_failed | 0.00% |
| http_req_duration p95 | 28ms |
| http_req_duration p99 | 65ms |
| VU peak | 8 |
| Cache hit ratio | 48% |
| Checks | 100% |

**Diễn giải:**

Cache hit ratio chỉ đạt 48% (thay vì expected 85%+). Điều này đẩy W_eff lên ~45ms, làm VU demand tăng lên ~8 (35 × 0.045 = 1.6, nhưng với p99 65ms thì cần buffer). Test vẫn pass (0 drops, 0 failures) vì preAllocatedVUs=10 > 8, nhưng đây là dấu hiệu cảnh báo.

**Root cause analysis:**

```
1. Tại sao cache hit ratio thấp?
   ├── Redis vừa được restart → cache empty → COLD START
   ├── TTL quá ngắn → cache expire trước khi được dùng lại
   ├── Memory pressure → Redis evict keys (allkeys-lru)
   └── User pool quá lớn so với cache size

2. Tại sao p99 = 65ms?
   └── Cache miss → DB query → 50-80ms cho cold query
```

**Quyết định:**

> **CONDITIONAL PASS — INVESTIGATE CACHE** — Không deploy ngay. Điều tra nguyên nhân cache miss ratio thấp. Nếu là cold start: thêm cache warming step trước test/production deploy. Nếu là TTL ngắn: tăng TTL. Nếu là memory pressure: tăng Redis maxmemory hoặc optimize cache key size.

**Hành động cụ thể:**
1. Kiểm tra Redis memory usage trong quá trình test.
2. Kiểm tra eviction policy và số lượng evicted keys.
3. Pre-warm cache với script warm-cache.js, chạy lại test.
4. Nếu cache hit ratio vẫn thấp sau warm → investigate DB query performance.
5. Cân nhắc tăng preAllocatedVUs lên 15 để có buffer cho cache miss scenario.

### Scenario C: Drops at 35/s — "Even fast events can drop if VU pool too tiny"

**Profile kết quả:**

| Chỉ số | Giá trị |
|--------|--------|
| iterations | 710 / 778 scheduled |
| dropped_iterations | 68 |
| http_req_failed | 0.00% |
| http_req_duration p95 | 8ms |
| http_req_duration p99 | 18ms |
| VU peak | 5 (nhưng maxVUs chỉ = 5!) |
| Cache hit ratio | 88% |
| Checks | 100% |

**Diễn giải:**

Đây là kịch bản "nghịch lý": event vẫn nhanh (p95=8ms), cache vẫn tốt (88%), nhưng vẫn có 68 drops. Lý do: **preAllocatedVUs hoặc maxVUs bị set quá thấp** (chỉ 5).

Cơ chế drop:
```
Tại peak 35/s, ticker mỗi 28.6ms:
  t=25.000: slot mở → VU#1 nhận (bận 5ms, rảnh lúc 25.005)
  t=25.029: slot mở → VU#2 nhận (bận 5ms, rảnh lúc 25.034)
  t=25.057: slot mở → VU#3 nhận (bận 5ms, rảnh lúc 25.062)
  t=25.086: slot mở → VU#4 nhận (bận 5ms, rảnh lúc 25.091)
  t=25.114: slot mở → VU#5 nhận (bận 5ms, rảnh lúc 25.119)
  t=25.143: slot mở → TẤT CẢ 5 VU ĐỀU BẬN?!
    
  Nhưng với event 5ms, VU#1 đã rảnh từ 25.005 (cách đây 138ms!)
  Vậy tại sao VU#1 không nhận slot?

  → VU scheduling overhead: k6 cần thời gian để detect VU rảnh và assign slot mới
  → Nếu scheduling latency > 28.6ms (ticker period) → drop dù VU có rảnh
  → Đây là k6 internal constraint, không phải application issue
```

**Quyết định:**

> **HARD FAIL — TĂNG preAllocatedVUs** — Mặc dù lý thuyết nói 1 VU đủ cho 35/s, thực tế k6 cần buffer cho VU scheduling. Với event quá nhanh (5ms), scheduling overhead có thể lớn hơn event time. Tăng preAllocatedVUs lên ít nhất 10-15, hoặc maxVUs lên 20.

**Hành động cụ thể:**
1. Tăng preAllocatedVUs từ 5 lên 15.
2. Hoặc: tăng maxVUs lên 20 và để k6 tự scale.
3. Chạy lại test, verify 0 drops.
4. Nếu vẫn drop với 15 VU: vấn đề không phải VU count mà là system resource (CPU, network) của k6 process.
5. Cân nhắc giảm peak rate từ 35 xuống 25 nếu không thể tăng VU.

### Scenario D: Recommendations Bottleneck — "Collaborative algorithm slow, homefeed fast"

**Profile kết quả:**

| Chỉ số | Giá trị |
|--------|--------|
| iterations | 778 / 778 scheduled |
| dropped_iterations | 0 |
| http_req_failed | 0.00% |
| http_req_duration p95 (homefeed) | 6ms |
| http_req_duration p95 (recommendations) | 45ms |
| http_req_duration p99 (recommendations) | 120ms |
| VU peak | 7 |
| Cache hit ratio | 85% |
| Checks | 98% (2 assertion failures trên recommendations) |

**Diễn giải:**

Homefeed hoạt động hoàn hảo (p95=6ms). Nhưng recommendations chậm hơn nhiều (p95=45ms vs expected 7ms). Cache hit ratio vẫn 85% → vấn đề không phải cache. Có thể:
- Collaborative filtering model serving chậm (gRPC timeout, model load)
- Recommendation query complexity cao hơn dự kiến
- DB query cho recommendations dùng index không tối ưu

**Phân tích sâu hơn:**

```
Recommendations p95 breakdown:
  - Cache HIT:    p95 ~7ms   (70% of rec requests) → bình thường
  - Cache MISS:   p95 ~85ms  (30% of rec requests) → CHẬM BẤT THƯỜNG

So với homefeed cache miss (p95 ~22ms), rec cache miss chậm gấp 4×.
→ Rec cache miss path có vấn đề: DB query, model compute, hoặc data hydration.
```

**Quyết định:**

> **SOFT FAIL — INVESTIGATE RECOMMENDATIONS BACKEND** — Homefeed sẵn sàng production. Recommendations cần investigation: kiểm tra slow query log, model serving latency, và DB index. Nếu rec path vẫn chậm sau optimization, cân nhắc tăng cache TTL cho recommendations để giảm cache miss frequency.

**Hành động cụ thể:**
1. Profile recommendations endpoint riêng: DB query time, model compute time, network time.
2. Kiểm tra slow query log cho `SELECT ... FROM recommendations WHERE product_id = ?`.
3. Kiểm tra gRPC latency từ API server đến model serving.
4. Nếu model compute là bottleneck: pre-compute thêm recommendations, tăng cache TTL.
5. Retest với rec-only scenario để isolate vấn đề.

---

## 14. "Nghịch lý"

### NL1: "Peak 35/s cao nhất series nhưng preAllocatedVUs=10 thấp hơn case 04 (peak 10/s, pre=12)"

**Nghịch lý:** Case 06 có peak rate cao nhất toàn bộ series (35 req/s), nhưng preAllocatedVUs chỉ = 10 — thấp hơn case 04 (10 req/s, preAllocatedVUs=12). Làm sao rate cao hơn 3.5 lần nhưng cần ít VU hơn?

**Giải thích:**

```
Case 04: 10 req/s × 1200ms = 12 VU  (mỗi VU xử lý 1 event mất 1.2 giây)
Case 06: 35 req/s × 5ms    = 0.175 VU (mỗi VU xử lý 1 event mất 0.005 giây)

Tỉ lệ VU/rate:
  Case 04: 12 VU / 10 req/s = 1.2 VU per req/s
  Case 06: 10 VU / 35 req/s = 0.29 VU per req/s

→ Case 06 hiệu quả gấp 4.2× về mặt VU per request rate.
```

**Bài học:**

> **Rate không quyết định VU sizing. Tích rate × latency mới quyết định.**
>
> Một hệ thống 100 req/s với latency 1ms cần ít VU hơn hệ thống 1 req/s với latency 2 giây.
>
> Khi thiết kế load test, đừng nhìn rate để ước lượng VU. Tính Little's Law trước.

**Hệ quả cho capacity planning:**

| Endpoint type | Rate | Latency | VU cần | Cost per VU | Tổng cost |
|--------------|------|---------|--------|------------|-----------|
| Heavy write (case 04) | 10/s | 1200ms | 12 | $10/tháng | $120/tháng |
| Light read (case 06) | 35/s | 5ms | 1 | $10/tháng | $10/tháng |

> Feed ingress rẻ hơn 12× để vận hành dù throughput cao hơn 3.5×.

### NL2: "1 VU lý thuyết đủ cho 35/s — nhưng production cần buffer"

**Nghịch lý:** Little's Law nói chỉ cần 1 VU cho 35/s với event 5ms. Vậy tại sao preAllocatedVUs=10? Tại sao không dùng 1 VU?

**Giải thích:**

Little's Law là lý thuyết trong điều kiện lý tưởng (steady state, deterministic service time, không có variance). Production có:

| Yếu tố | Tác động | VU buffer cần |
|--------|----------|--------------|
| **Latency variance** | p99 có thể = 10× p50 | +1-2 VU |
| **Cache miss burst** | 10% request miss cache → latency 20ms thay vì 5ms | +1 VU |
| **VU scheduling jitter** | k6 cần thời gian detect VU rảnh → có thể miss slot | +1-2 VU |
| **Cold start** | Những giây đầu tiên, cache chưa warm | +1-2 VU |
| **GC pause** | Node.js/Python GC có thể pause 50-100ms | +1 VU |
| **Network jitter** | Cross-AZ latency spike | +1 VU |
| **Headroom cho spike** | Traffic có thể vượt dự đoán 20-30% | +2-3 VU |
| **Tổng buffer khuyến nghị** | | **+8-12 VU** |

> preAllocatedVUs=10 = 1 (lý thuyết) + 9 (buffer) — đây là over-provisioning có chủ đích, không phải lãng phí.

**So sánh buffer ratio:**

| Case | VU lý thuyết | VU thực tế | Buffer ratio | An toàn? |
|------|-------------|-----------|-------------|----------|
| 04 (Product Detail) | 12 | 12 | 1.0× | Sát giới hạn — nguy hiểm |
| **06 (Feed Ingress)** | **1** | **10** | **10.0×** | **Rất an toàn** |
| 03 (Search) | 2 | 10 | 5.0× | An toàn |

### NL3: "Cache hit 100% → test pass; cache miss 50% → test fail — cùng config"

**Nghịch lý:** Cùng một script, cùng một config (preAllocatedVUs=10, maxVUs=30), nhưng:
- Cache hit ratio 100% → PASS hoàn hảo
- Cache hit ratio 50% → vẫn PASS (xem scenario B)
- Cache hit ratio 0% → có thể FAIL nếu W_eff > 300ms

Config không thay đổi, nhưng kết quả thay đổi vì cache state khác nhau.

**Giải thích:**

Test với ramping-arrival-rate là **open model test** — nó test system behavior ở một arrival pattern nhất định, nhưng system behavior phụ thuộc vào internal state (cache). Đây không phải là bug — đây là đặc điểm:

```
Load test không test "config" — nó test "system at a point in time".
Cùng config nhưng system state khác → kết quả khác.

Điều này có nghĩa:
  1. Phải control cache state trước mỗi test run (warm cache hoặc flush cache)
  2. Phải chạy test ở cả hai trạng thái: warm cache và cold cache
  3. Pass criteria phải tính đến cache state
```

**Test matrix khuyến nghị:**

| Cache state | Expected outcome | Dùng để verify |
|------------|-----------------|---------------|
| Fully warm (100% hit) | Perfect pass | Baseline performance |
| Partially warm (80% hit) | Pass (p95 < 20ms) | Production-like condition |
| Cold (0% hit) | May pass or soft fail | Worst-case capacity planning |
| Cache thay đổi trong test | Pass (system thích nghi) | Resilience test |

### NL4: "Ticker 28.6ms — tưởng nhanh nhưng event 5ms nên VU quay vòng kịp"

**Nghịch lý:** 28.6ms giữa các slot nghe có vẻ nhanh — chỉ ~35 slot mỗi giây. Nhưng vì mỗi event chỉ mất 5ms, một VU có thể xử lý xong event và sẵn sàng cho slot tiếp theo trong 5ms, rảnh 23.6ms trước khi slot mới được mở.

**Giải thích bằng duty cycle:**

```
Duty cycle của 1 VU ở 35/s:
  - Mỗi giây, VU nhận 35/10 = 3.5 slots (với 10 VU)
  - Mỗi slot mất 5ms
  - Tổng thời gian bận: 3.5 × 5ms = 17.5ms
  - Tổng thời gian rảnh: 1000ms - 17.5ms = 982.5ms
  - Duty cycle: 17.5 / 1000 = 1.75%

→ VU rảnh 98.25% thời gian!
```

**So sánh duty cycle:**

| Case | Rate (per VU) | Event time | Duty cycle | Idle time |
|------|--------------|-----------|------------|-----------|
| 04 (Product Detail) | 10/12 = 0.83/s | 1200ms | 0.83 × 1.2 = 99.6% | 0.4% |
| **06 (Feed Ingress)** | **35/10 = 3.5/s** | **5ms** | **3.5 × 0.005 = 1.75%** | **98.25%** |
| 03 (Search) | 15/10 = 1.5/s | 80ms | 1.5 × 0.08 = 12% | 88% |

> Case 04 VU gần như bận 100% thời gian — sát giới hạn. Case 06 VU gần như rảnh 100% thời gian — massive over-provisioning.

**Hệ quả cho ticker period:**

Để ticker period "bắt kịp" VU (tức VU vừa xong event thì slot mới mở ngay), rate cần là:

```
1 / W_eff = 1 / 0.005 = 200 req/s
```

Ở 200 req/s, ticker period = 5ms = W_eff. Lúc đó 1 VU bận 100%. Với 10 VU, có thể chịu được 2000 req/s trước khi drop.

> 35/s chỉ bằng 17.5% của ngưỡng 200 req/s mà 1 VU đơn độc có thể handle.

---

## 15. Checklist

### 15.1 Pre-test checklist

- [ ] Target server đang chạy và healthy: `curl http://localhost:3000/health`
- [ ] Redis cluster healthy: tất cả nodes `redis-cli ping` → PONG
- [ ] PostgreSQL healthy: connection pool không bão hòa
- [ ] Cache warming script đã chạy (nếu cần): `k6 run scripts/warm-cache.js`
- [ ] Verify cache hit ratio trước test: `curl http://localhost:3000/debug/cache-stats`
- [ ] k6 binary version ≥ 0.49.0: `k6 version`
- [ ] Đủ disk space cho output files (~100MB cho JSON streaming)
- [ ] Không có cron job, backup, hoặc deployment đang chạy trên target
- [ ] Network latency từ k6 host đến target < 1ms (same DC/AZ)
- [ ] Environment variables được set đúng
- [ ] Script path chính xác: `scripts/ramping-arrival-rate/rar-06-feed-ingress-ramp.js`
- [ ] Results directory tồn tại: `mkdir -p results/`

### 15.2 During-test checklist

- [ ] k6 process không bị OOM kill — theo dõi memory usage
- [ ] k6 CPU usage không đạt 100% — nếu có, k6 là bottleneck, không phải target
- [ ] Target server CPU/memory trong ngưỡng bình thường
- [ ] Redis memory usage không vượt maxmemory
- [ ] Không có Redis eviction trong quá trình test (`redis-cli info stats | grep evicted_keys`)
- [ ] PostgreSQL slow query log không có query mới
- [ ] Network throughput trong giới hạn
- [ ] Live metrics stream không có spike bất thường

### 15.3 Post-test analysis checklist

- [ ] `dropped_iterations` = 0 — nếu > 0, đi thẳng đến RC4 analysis
- [ ] `iterations` count ≈ 778 (±5) — nếu sai lệch > 10, kiểm tra stage config
- [ ] `http_req_failed` rate < 0.1% — nếu có failure, phân loại theo status code
- [ ] `http_req_duration` p95 < 15ms (cache hit) hoặc < 50ms (cache miss)
- [ ] `http_req_duration` p99 < 50ms
- [ ] `checks` rate = 100% — nếu không, check assertion nào fail
- [ ] Compare homefeed vs recommendations latency — delta < 10ms
- [ ] Compare geo VN vs US latency — delta < 10ms
- [ ] Compare device mobile vs desktop latency — delta < 5ms
- [ ] Cache hit ratio > 75% — nếu thấp hơn, investigate cache
- [ ] VU peak < maxVUs — nếu = maxVUs, system ở giới hạn
- [ ] Save results files với timestamp: `results/case06-YYYYMMDD-HHMMSS.json`
- [ ] Attach results to test report/issue

### 15.4 Production readiness checklist

- [ ] Test pass ở cả 2 cache states: warm (85%+ hit) và cold (< 50% hit)
- [ ] Test pass với cả 3 AB variants riêng biệt (nếu variant testing)
- [ ] Test pass ở ít nhất 3 lần chạy liên tiếp (flakiness check)
- [ ] p99 latency trong test ≤ 50% của production SLA
- [ ] Max concurrent VU trong test ≤ 50% của maxVUs config
- [ ] Cache warming strategy đã được document và test
- [ ] Alert thresholds đã được set dựa trên test results
- [ ] Runbook cho cache degradation scenario đã sẵn sàng
- [ ] Performance test result đã được review bởi ít nhất 1 senior engineer

---

## 16. 4-5 Variations

### Variation 1: "Cold Cache Start" — Test cache warming strategy

**Mục đích:** Đánh giá system behavior khi cache hoàn toàn trống (worst case: Redis restart, deploy mới, hoặc cache flush).

**Thay đổi config:**
- Flush Redis cache trước test: `redis-cli FLUSHALL`
- Giữ nguyên config còn lại

**Dự đoán kết quả:**

| Chỉ số | Warm cache | Cold cache |
|--------|-----------|------------|
| http_req_duration p95 | 6ms | 80ms |
| http_req_duration p99 | 14ms | 200ms |
| VU peak | 3 | 12 |
| dropped_iterations | 0 | Có thể > 0 |
| Cache hit ratio | 92% | 0% (tăng dần trong test) |

**Bài học:** Cold cache có thể gây drop nếu preAllocatedVUs không đủ cho W_eff cao. Nếu production từng có Redis restart, phải test scenario này.

### Variation 2: "AB Variant Isolation" — Test từng variant riêng biệt

**Mục đích:** Xác định variant nào có performance kém nhất (có thể một variant dùng model chậm hơn).

**Thay đổi config:**
- Chạy 3 lần, mỗi lần fix cứng `X-Ab-Variant` = `control` / `variant_a` / `variant_b`
- Giữ nguyên config còn lại

**Phân tích kết quả:**

| Variant | p95 (ms) | p99 (ms) | Cache hit ratio | Nhận xét |
|---------|----------|----------|----------------|----------|
| control | 5ms | 12ms | 93% | Baseline model, nhẹ nhất |
| variant_a | 6ms | 14ms | 91% | Model A hơi nặng hơn |
| variant_b | 7ms | 16ms | 90% | Model B nặng nhất |

**Quyết định:** Nếu một variant chậm hơn > 2× so với control → investigate model performance trước khi ramp up traffic cho variant đó.

### Variation 3: "Sustained Peak" — Giữ 35/s trong thời gian dài

**Mục đích:** Test xem system có sustain được 35/s trong thời gian dài không (không chỉ 15s peak như config gốc). Phát hiện memory leak, connection leak, hoặc cache eviction tích lũy.

**Thay đổi config:**
```javascript
stages: [
  { duration: "5s",  target: 20 },   // warm-up nhanh
  { duration: "120s", target: 35 },  // sustained peak 2 phút
  { duration: "5s",  target: 10 },   // cool-down
]
// preAllocatedVUs: 10, maxVUs: 30
```

**Dự đoán:** Sau 30-60s sustained peak, có thể thấy latency tăng dần nếu có memory leak hoặc connection pool exhaustion.

### Variation 4: "Geo Failover" — Test cross-region resilience

**Mục đích:** Mô phỏng Redis replica ở US region bị fail, tất cả traffic route về VN.

**Thay đổi config:**
- Tắt US Redis replica
- Tăng geo ratio lên 50/50 VN/US (để tạo thêm cross-region traffic)
- Giữ nguyên config còn lại

**Dự đoán kết quả:**

| Scenario | VN p95 | US p95 (cross-region) | VU peak |
|----------|--------|----------------------|---------|
| Bình thường | 5ms | 10ms | 3 |
| US replica down | 6ms | 35ms | 5 |

### Variation 5: "Mobile-Only Traffic" — Test device-specific pattern

**Mục đích:** Mô phỏng traffic 100% mobile (điển hình cho thị trường mobile-first như Việt Nam).

**Thay đổi config:**
- Set `HEADER_DEVICE_RATIO_MOBILE=1.0` (100% mobile)
- Giữ nguyên config còn lại

**Dự đoán:**
- Payload nhỏ hơn (json_items=6 thay vì 12)
- Latency có thể thấp hơn chút do payload size nhỏ
- Redis memory usage thấp hơn do cache key ít hơn (không có desktop keys)

---

## 17. Anti-patterns (mở rộng)

### Anti-pattern 1: "Nhìn rate để tính VU"

**Sai:**
> "Case này peak 35/s, cần ít nhất 35 VU để mỗi VU xử lý 1 req/s."

**Đúng:**
> "Tính Little's Law: 35 req/s × 5ms = 0.175 VU. 10 VU là đã over-provision 57×."

**Tác hại:** Provision quá nhiều VU → lãng phí tài nguyên, chi phí cloud tăng không cần thiết, và quan trọng hơn: hiểu sai về cách hệ thống hoạt động.

### Anti-pattern 2: "Bỏ qua cache state trong test setup"

**Sai:**
> "Cứ chạy test thôi, cache tự lo."

**Đúng:**
> "Cache state quyết định kết quả test. Phải control cache state (warm hoặc cold) và document nó cùng với kết quả."

**Tác hại:** Kết quả test không reproducible. Hôm nay pass, ngày mai fail — không ai hiểu tại sao. Root cause: cache state khác nhau giữa các lần chạy.

### Anti-pattern 3: "Chỉ test warm cache"

**Sai:**
> "Production cache hit ratio 95% nên chỉ cần test warm cache."

**Đúng:**
> "Production cache có thể bị flush bất cứ lúc nào (deploy, failover, memory pressure). Phải test cả cold cache scenario để biết system behavior trong worst case."

**Tác hại:** Khi Redis failover trong production, system behavior hoàn toàn khác test → panic, không có runbook, outage kéo dài.

### Anti-pattern 4: "Over-provision VU 'cho chắc'"

**Sai:**
> "preAllocatedVUs=50, maxVUs=200 cho case 06. Cho chắc ăn."

**Đúng:**
> "preAllocatedVUs=10 đã là over-provision 10× so với lý thuyết. 50 là lãng phí cực độ. Hơn nữa, quá nhiều VU có thể gây ra vấn đề mới: k6 process OOM, network congestion, target server bị overwhelm bởi connection count."

**Tác hại:**
- k6 process có thể OOM với quá nhiều VU
- Target server bị DDoS bởi connection establishment (dù request nhẹ)
- Kết quả test không phản ánh thực tế (production không có 50 concurrent users cho feed)
- Lãng phí tài nguyên CI/CD

### Anti-pattern 5: "Không phân biệt endpoint trong metrics"

**Sai:**
> "http_req_duration p95 = 10ms → mọi thứ OK."

**Đúng:**
> "http_req_duration p95 = 10ms là average của homefeed (p95=6ms) và recommendations (p95=45ms). Homefeed OK nhưng recommendations đang có vấn đề. Nếu không tag endpoint, bạn sẽ bỏ lỡ vấn đề này."

**Tác hích:** Bug ẩn trong một endpoint bị "pha loãng" bởi endpoint khác nhanh hơn. Recommendations chậm 45ms nhưng average vẫn đẹp → không ai phát hiện → user phàn nàn "recommendations chậm".

### Anti-pattern 6: "Dùng ramping-vus cho API read-only nhanh"

**Sai:**
> "Ramping-vus dễ hiểu hơn, cứ dùng nó cho mọi thứ."

**Đúng:**
> "Với event 5ms, ramping-vus tạo ra rate cực kỳ không ổn định. Một VU có thể tạo 200 req/s (nếu không có think-time), hoặc 1 req/s (nếu có sleep). Rate phụ thuộc vào script, không phải config. Ramping-arrival-rate kiểm soát rate chính xác, độc lập với script execution time."

**So sánh rate stability:**

| Executor | 10 VU, event 5ms | Rate thực tế | Độ ổn định |
|----------|-----------------|-------------|-----------|
| ramping-vus (no sleep) | 10 VU × 200 req/s = 2000 req/s | Không kiểm soát được | Rất thấp |
| ramping-vus (sleep 100ms) | 10 VU × ~9.5 req/s = 95 req/s | Phụ thuộc sleep timer accuracy | Thấp |
| ramping-arrival-rate | Config: 35 req/s | 35 req/s chính xác | **Cao** |

### Anti-pattern 7: "Không đọc dropped_iterations"

**Sai:**
> "Test chạy xong, 778 iterations, http_req_duration đẹp → PASS."

**Đúng:**
> "Phải kiểm tra `dropped_iterations` đầu tiên. Nếu > 0, test đã FAIL dù các metrics khác đẹp. Drop iteration nghĩa là hệ thống không xử lý được toàn bộ traffic được schedule — đây là failure mode nghiêm trọng nhất của ramping-arrival-rate."

**Tác hại:** Bỏ qua drop → nghĩ rằng system OK → deploy production → user thấy lỗi (request không được phục vụ) dù latency metrics đẹp.

### Anti-pattern 8: "Không verify cache hit ratio"

**Sai:**
> "Latency đẹp → cache chắc đang hoạt động tốt."

**Đúng:**
> "Latency đẹp có thể do backend xử lý nhanh dù cache miss. Phải đo cache hit ratio trực tiếp (qua response header `X-Cache-Status` hoặc Redis metrics). Nếu cache hit ratio = 20% nhưng latency vẫn đẹp → backend quá khỏe → khi production traffic thực sự đến, cache miss sẽ là vấn đề."

**Tác hại:** Không biết cache hit ratio thực tế → không dự đoán được system behavior khi traffic scale lên. Cache 20% hit ở 35/s có thể OK, nhưng ở 350/s thì sao?

---

## 18. Reference

### 18.1 K6 documentation

| Tài liệu | URL |
|----------|-----|
| Ramping-arrival-rate executor | https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/ramping-arrival-rate/ |
| Arrival-rate executors overview | https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/ |
| k6 Options reference | https://grafana.com/docs/k6/latest/using-k6/k6-options/ |
| k6 Metrics reference | https://grafana.com/docs/k6/latest/using-k6/metrics/ |
| k6 Tags and Groups | https://grafana.com/docs/k6/latest/using-k6/tags-and-groups/ |
| k6 Checks | https://grafana.com/docs/k6/latest/using-k6/checks/ |
| k6 Results output | https://grafana.com/docs/k6/latest/results-output/overview/ |
| k6 Cloud | https://grafana.com/docs/k6/latest/cloud/ |

### 18.2 Queueing theory & Little's Law

| Tài liệu | Mô tả |
|----------|-------|
| Little, J. D. C. (1961). "A Proof for the Queuing Formula: L = λW". Operations Research. | Paper gốc của Little's Law |
| Harchol-Balter, M. (2013). "Performance Modeling and Design of Computer Systems". Cambridge University Press. | Queueing theory áp dụng cho computer systems |
| Kleinrock, L. (1975). "Queueing Systems, Volume 1: Theory". Wiley. | Kinh điển về queueing theory |
| Gunther, N. J. (2007). "Guerrilla Capacity Planning". Springer. | Little's Law trong capacity planning thực tế |

### 18.3 Related cases trong series

| Case | Mô tả | Mối liên hệ |
|------|-------|------------|
| Case 04: Product Detail Ramp | 10/s, W=1200ms, pre=12 VU | **Đối lập:** Case 04 là "VU-bound", case 06 là "rate-bound". Học cùng nhau để hiểu Little's Law. |
| Case 03: Search Ramp | 15/s, W=80ms, pre=10 VU | **Trung gian:** Giữa case 04 và 06 về rate và latency. |
| Case 01: Order Ramp | 5/s, W=200ms, pre=8 VU | Write path vs read path comparison |
| Case 02: Payment Ramp | 3/s, W=500ms, pre=6 VU | High-latency write vs low-latency read |

### 18.4 Backend script reference

| File | Mô tả |
|------|-------|
| `scripts/ramping-arrival-rate/rar-06-feed-ingress-ramp.js` | k6 test script cho case 06 |
| `scripts/warm-cache.js` | Script pre-warm Redis cache trước test |
| `scripts/helpers/identity-pool.js` | Identity pool helper (1000 users) |
| `scripts/helpers/weighted-branch.js` | Weighted branching helper (65/35) |
| `scripts/helpers/header-builder.js` | Header construction helper |

### 18.5 Infrastructure reference

| Component | Tech stack | Version |
|-----------|-----------|---------|
| Load generator | k6 | ≥ 0.49.0 |
| Target API | Node.js (Express/Fastify) | 20.x LTS |
| Cache | Redis Cluster | 7.x |
| Database | PostgreSQL | 15.x |
| Recommendation model | Python (FastAPI + gRPC) | 3.11+ |
| Monitoring | Grafana + Prometheus | Latest |
| CI/CD | GitHub Actions | — |

### 18.6 Key formulas reference card

```
┌─────────────────────────────────────────────────────────────┐
│                 LITTLE'S LAW: L = λ × W                     │
│                                                             │
│  L = VU needed (concurrency)                                │
│  λ = arrival rate (req/s)                                   │
│  W = average response time (seconds)                         │
│                                                             │
│  Applied to Case 06:                                        │
│    L = 35 × 0.005 = 0.175 → ceil: 1 VU                     │
├─────────────────────────────────────────────────────────────┤
│                 RAMPING STAGE MATH                          │
│                                                             │
│  Scheduled slots (trapezoid area):                          │
│    slots = duration × (startRate + endRate) / 2             │
│                                                             │
│  Rate at time t:                                            │
│    r(t) = startRate + (endRate - startRate) × t / duration  │
│                                                             │
│  Ticker period at time t:                                   │
│    ticker(t) = 1 / r(t) seconds                             │
├─────────────────────────────────────────────────────────────┤
│                 UTILIZATION: ρ = λ × W / c                  │
│                                                             │
│  ρ = server utilization                                     │
│  c = number of servers (VUs in k6 context)                  │
│                                                             │
│  Stability condition: ρ < 1                                 │
│  Case 06: ρ = 35 × 0.005 / 10 = 0.0175 = 1.75%             │
├─────────────────────────────────────────────────────────────┤
│                 CACHE MISS PENALTY                          │
│                                                             │
│  E[W] = Σ (P(state) × W(state))                            │
│       = P(hit) × W_hit + P(miss) × W_miss                  │
│                                                             │
│  Case 06 (expected):                                        │
│    E[W] = 0.85 × 5ms + 0.12 × 20ms + 0.03 × 100ms          │
│         = 4.25 + 2.40 + 3.00 = 9.65ms                       │
└─────────────────────────────────────────────────────────────┘
```

### 18.7 Glossary

| Thuật ngữ | Định nghĩa |
|-----------|-----------|
| **Arrival rate (λ)** | Số lượng request đến hệ thống mỗi giây |
| **Service time (W)** | Thời gian hệ thống xử lý một request |
| **Concurrency (L)** | Số lượng request đang được xử lý đồng thời |
| **Ticker** | Cơ chế nội bộ của k6 ramping-arrival-rate, mở slot mới theo schedule |
| **Ticker period** | Khoảng thời gian giữa hai lần mở slot liên tiếp = 1/rate |
| **Slot** | Một "chỗ" cho iteration — được ticker mở ra, VU nhận và thực thi |
| **Drop iteration** | Slot được mở nhưng không có VU nào nhận → iteration bị hủy |
| **Open model** | Arrival rate độc lập với system state |
| **Closed model** | Số lượng user cố định, request rate phụ thuộc response time |
| **Cache hit ratio** | Tỉ lệ request được phục vụ từ cache (không cần query backend) |
| **W_effective** | Thời gian xử lý hiệu quả, tính cả cache hit/miss weighted average |
| **Duty cycle** | Tỉ lệ thời gian VU bận = (time busy) / (total time) |
| **Utilization (ρ)** | Tỉ lệ thời gian server bận = λ × W / c |
| **Buffer ratio** | VU thực tế / VU lý thuyết — đo mức độ over-provisioning |
| **SLA** | Service Level Agreement — cam kết về performance (vd: p95 < 50ms) |
| **TTL** | Time To Live — thời gian cache key tồn tại trước khi bị expire |

---

> **Tổng kết case 06 — Feed Ingress Ramp:**
>
> Case này là đỉnh cao của loạt bài về ramping-arrival-rate. Nó chứng minh một sự thật phản trực giác: **rate cao nhất không có nghĩa là cần nhiều VU nhất**. Little's Law — L = λ × W — cho thấy VU demand là tích của rate và latency. Khi latency cực nhỏ (5ms cho cache hit), kể cả rate 35/s cũng chỉ cần 1 VU về mặt lý thuyết.
>
> Nhưng đừng để lý thuyết đánh lừa: production cần buffer. Cache miss, cold start, scheduling jitter, GC pause — tất cả đều đẩy VU demand lên. preAllocatedVUs=10 là con số cân bằng giữa lý thuyết (1 VU) và thực tế (buffer 9 VU).
>
> Bài học cốt lõi: **Hiểu system latency trước khi quyết định VU sizing.** Đừng nhìn rate. Hãy tính Little's Law. Rồi thêm buffer phù hợp với variance của hệ thống.
>
> Khi bạn đã hiểu case 04 (VU-bound) và case 06 (rate-bound), bạn đã nắm được hai thái cực của load testing. Mọi case khác nằm đâu đó giữa hai thái cực này.
