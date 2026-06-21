# Case 02: Campaign Ingress Spike — Ramping-Arrival-Rate Spike Đột Biến

> **Executor:** ramping-arrival-rate | **Peak Rate:** 40/s | **Pattern:** Spike đột biến
>
> Flash sale, campaign launch, promotion giờ vàng — traffic thấp trước spike, bùng nổ trong vài giây, rồi giảm dần.

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [2 yêu cầu cốt lõi](#2-2-yêu-cầu-cốt-lõi)
3. [Vì sao chọn ramping-arrival-rate?](#3-vì-sao-chọn-ramping-arrival-rate)
4. [Phân tích nguyên nhân gốc kỹ thuật (5)](#4-phân-tích-nguyên-nhân-gốc-kỹ-thuật-5)
5. [Identity model deep-dive](#5-identity-model-deep-dive)
6. [Phân tích open model với spike](#6-phân-tích-open-model-với-spike)
7. [Bảng service/API flow](#7-bảng-serviceapi-flow)
8. [Metrics & tags deep-dive](#8-metrics--tags-deep-dive)
9. [Pass criteria](#9-pass-criteria)
10. [Cách chạy](#10-cách-chạy)
11. [Phân tích output 5 bước](#11-phân-tích-output-5-bước)
12. [Dashboard 3-chart deep analysis](#12-dashboard-3-chart-deep-analysis)
13. [4 output→decision scenarios](#13-4-outputdecision-scenarios)
14. ["Nghịch lý" (4)](#14-nghịch-lý-4)
15. [Checklist](#15-checklist)
16. [4-5 variations](#16-4-5-variations)
17. [Anti-patterns (mở rộng)](#17-anti-patterns-mở-rộng)
18. [Reference](#18-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh kinh doanh

Một hệ thống e-commerce chuẩn bị cho chiến dịch **Flash Sale Tết** — sự kiện bán hàng lớn nhất năm. Marketing đã chạy quảng cáo suốt 2 tuần. Hàng trăm nghìn người dùng được thông báo đẩy (push notification) rằng "Flash Sale bắt đầu lúc 10:00:00". Kết quả:

- **09:59:50** — hệ thống gần như idle, vài request lẻ tẻ từ người dùng đang duyệt.
- **10:00:00** — push notification được gửi đồng loạt. Hàng chục nghìn người dùng click vào link cùng lúc.
- **10:00:03** — traffic đạt đỉnh. Trang chủ, danh sách sản phẩm flash sale, nút "Thêm vào giỏ" bị dồn dập truy cập.
- **10:00:15** — một số sản phẩm đã hết hàng (sold out), traffic bắt đầu giảm.
- **10:00:30** — traffic về mức bình thường nhưng vẫn cao hơn trước campaign do người dùng tiếp tục duyệt.

**Business question:** Hệ thống có chịu được cú spike này không? Cart add có fail không? Checkout có bị drop không?

### 1.2 Đặc điểm kỹ thuật của spike

Spike không giống như ramp-up từ từ. Nó có 3 pha rõ rệt:

| Pha | Thời gian | Đặc điểm | Rate range |
|-----|-----------|----------|------------|
| **Pre-spike** | 0-5s | Traffic nền thấp, người dùng đang đợi | 3 → 10/s |
| **Spike** | 5-15s | Push notification kích hoạt, traffic bùng nổ | 10 → 40/s |
| **Post-spike** | 15-25s | Traffic hạ nhiệt, sold-out bắt đầu xuất hiện | 40 → 8/s |
| **Cooldown** | 25-30s | Về gần mức nền, residual browsing | 8 → 3/s |

### 1.3 Tại sao case này quan trọng

Trong thực tế, đây là pattern gây chết hệ thống nhiều nhất:

- **Không phải sustained load** — server không có thời gian warm-up.
- **Cart add tại đỉnh spike** — write pressure đúng lúc hệ thống đang chịu read pressure cao nhất.
- **Cold start của VU pool** — nếu preAllocatedVUs không đủ, worker phải spawn mới ngay giữa spike.
- **Timeout cascade** — một request chậm kéo theo connection pool cạn, kéo theo nhiều request chậm hơn.

### 1.4 Mô hình hóa trong k6

Case này dùng `ramping-arrival-rate` để mô hình hóa chính xác curve 4 pha. Không dùng `ramping-vus` vì ta muốn kiểm soát **arrival rate**, không phải số VU. Không dùng `constant-arrival-rate` vì rate thay đổi theo thời gian.

```
Config gốc:
  executor: ramping-arrival-rate
  startRate: 3
  timeUnit: "1s"
  preAllocatedVUs: 8
  maxVUs: 50
  stages:
    - { duration: "5s",  target: 10 }   # Pre-spike ramp
    - { duration: "10s", target: 40 }   # SPIKE 
    - { duration: "10s", target: 8  }   # Post-spike cooldown
    - { duration: "5s",  target: 3  }   # Return to baseline
```

---

## 2. 2 yêu cầu cốt lõi

### 2.1 Yêu cầu 1: Sustain spike curve — không drop iteration

Hệ thống phải xử lý được TOÀN BỘ các iteration mà k6 schedule ra trong suốt 30 giây, đặc biệt là trong pha spike (10→40/s trong 10 giây).

**Tại sao đây là yêu cầu số 1:** Trong business thực tế, mỗi iteration = 1 user event (xem danh sách sản phẩm, thêm vào giỏ, xem chi tiết). Drop iteration = mất user = mất doanh thu. Trong flash sale, mỗi giây có thể trị giá hàng trăm triệu đồng.

**Cách đo:**
- `ramping_arrival_events_total` phải bằng tổng scheduled slots (~550).
- `ramping_arrival_events_failed` phải = 0.
- `dropped_iterations` trong output summary phải = 0.

**Ngưỡng pass:** 100% iteration được thực thi, 0 dropped.

### 2.2 Yêu cầu 2: Response time chấp nhận được tại đỉnh spike

Không chỉ "không drop", hệ thống còn phải respond trong thời gian chấp nhận được. Một iteration không bị drop nhưng response 10 giây thì cũng coi như thất bại — user đã bỏ đi từ lâu.

**Tại sao đây là yêu cầu số 2:** Trong spike, queue depth tăng. Nếu event loop bị tắc, response time sẽ tăng phi tuyến. User thực tế có timeout ~3-5 giây trên browser/app.

**Cách đo:**
- `ramping_arrival_event_duration_ms` — p95 phải < 500ms.
- `http_req_duration` — p95 phải < 300ms cho reads, < 500ms cho writes (cart add).
- Trend chart: response time KHÔNG được có "hockey stick" (tăng đột biến rồi đi ngang cao).

**Ngưỡng pass:** p95 event duration < 500ms, p95 cart add < 500ms, 0 timeout.

### 2.3 Mối quan hệ giữa 2 yêu cầu

Hai yêu cầu này không độc lập. Nếu response time tăng, iteration duration tăng → VU bị chiếm dụng lâu hơn → cần nhiều VU hơn để sustain cùng arrival rate → nếu maxVUs không đủ → drop iteration. Đây là vòng xoáy chết của spike test:

```
Response time tăng → W_effective tăng → required VUs tăng
    → nếu VU pool không đủ → queue đầy → drop iteration
    → thêm áp lực lên các VU còn lại → response time còn tăng nữa
```

---

## 3. Vì sao chọn ramping-arrival-rate?

### 3.1 Bảng so sánh executor

| Executor | Cơ chế | Phù hợp spike? | Lý do |
|----------|--------|----------------|-------|
| **ramping-arrival-rate** | Open model, rate thay đổi theo stages | **YES - Best fit** | Kiểm soát chính xác arrival rate curve, VU pool tự động scale |
| **ramping-vus** | Closed model, VUs thay đổi theo stages | NO | Không kiểm soát được arrival rate; spike có thể bị "nuốt" bởi VU tăng chậm |
| **constant-arrival-rate** | Open model, rate cố định | NO | Rate cố định 40/s không mô hình được pre/post-spike |
| **shared-iterations** | Closed model, chia đều iterations | NO | Không có yếu tố thời gian thực, không tạo được spike |
| **per-vu-iterations** | Closed model, mỗi VU chạy N iterations | NO | Không có arrival rate concept |
| **constant-vus** | Closed model, VUs cố định | NO | Rate phụ thuộc vào response time, không kiểm soát được |

### 3.2 Tại sao ramping-vus thất bại với spike

Ramping-vus hoạt động theo closed model: mỗi VU hoàn thành iteration rồi mới bắt đầu iteration mới. Arrival rate thực tế = `VUs / W_effective`. Khi bạn tăng VUs, arrival rate tăng gián tiếp.

Vấn đề: **Bạn không thể tạo ra spike 40/s chính xác bằng ramping-vus.** Vì:
- Nếu W_effective = 50ms, 40 VU tạo ra 40/0.05 = 800/s (quá cao).
- Nếu W_effective = 200ms, 40 VU tạo ra 40/0.2 = 200/s (vẫn quá cao).
- Để tạo 40/s với W_effective = 50ms, bạn cần 40 × 0.05 = 2 VU — nhưng 2 VU không tạo được "cảm giác" spike.
- Để tạo 40/s với W_effective = 500ms (lúc system chậm), bạn cần 40 × 0.5 = 20 VU — nhưng bạn không biết trước W_effective lúc system chậm.

**Kết luận:** ramping-vus không cho phép bạn set "tôi muốn 40 requests mỗi giây". Bạn set "tôi muốn N VUs", và arrival rate là hệ quả, không phải input.

### 3.3 Tại sao constant-arrival-rate không đủ

Constant-arrival-rate giữ rate cố định, phù hợp để test "bền" (sustain). Nhưng campaign spike có tính chất **transient** (tạm thời). Nếu bạn set rate = 40/s constant:
- Pre-spike phase bị over-test (đáng lẽ chỉ 3/s).
- Post-spike phase bị over-test (đáng lẽ chỉ 8/s rồi 3/s).
- Không test được behavior của VU pool khi scale UP rồi scale DOWN.
- Không test được capacity planning cho từng phase.

### 3.4 Ramping-arrival-rate — cơ chế chính xác

Ramping-arrival-rate cho phép bạn định nghĩa **arrival rate curve** — đây chính là thứ marketing tạo ra. Push notification → spike arrival curve. Bạn map chính xác curve đó vào stages của k6:

```
stages: [
  { duration: "5s",  target: 10 },   # Tương ứng: notification chưa gửi, traffic nền
  { duration: "10s", target: 40 },   # Tương ứng: notification gửi, user click đồng loạt
  { duration: "10s", target: 8  },   # Tương ứng: sold-out bắt đầu, traffic giảm
  { duration: "5s",  target: 3  }    # Tương ứng: residual browsing
]
```

K6 sẽ linear-ramp rate giữa các target, tạo ra đúng curve bạn muốn. VU pool tự động scale để đáp ứng rate đó (với `preAllocatedVUs` và `maxVUs` là giới hạn).

---

## 4. Phân tích nguyên nhân gốc kỹ thuật (5)

### 4.1 RC1: Spike stage quyết định VU requirement cho toàn bộ run

#### Phát biểu

Stage 2 (10→40/s trong 10 giây) là stage quyết định toàn bộ sizing của VU pool. Nếu VU pool không đủ cho 40/s, bạn sẽ thấy drop — không quan trọng các stage khác nhẹ đến đâu.

#### Công thức

```
required_vus_min = ceil(lambda_peak × W_effective)
```

Trong đó:
- `lambda_peak` = 40 (arrivals/giây tại đỉnh spike)
- `W_effective` = thời gian trung bình một iteration hoàn thành (bao gồm network latency, server processing, think time nếu có)

#### Bảng VU requirement theo W_effective

| W_effective | required_vus_min | Với preAllocatedVUs=8 | Với maxVUs=50 | Đánh giá |
|-------------|------------------|-----------------------|---------------|----------|
| 10ms | 1 | Dư thừa lớn | Dư thừa lớn | Hệ thống quá nhanh, 8 VU dư sức |
| 25ms | 1 | Dư thừa | Dư thừa | Vẫn rất an toàn |
| 50ms | 2 | Dư thừa | Dư thừa | An toàn |
| 100ms | 4 | Đủ | Dư thừa | An toàn, còn room |
| 150ms | 6 | Đủ | Dư thừa | An toàn |
| 200ms | 8 | Vừa đủ | Dư thừa | **Điểm tới hạn**: preAllocatedVUs vừa đủ |
| 250ms | 10 | Thiếu 2 VU | Còn room | Cần spawn thêm 2 VU unplanned |
| 300ms | 12 | Thiếu 4 VU | Còn room | Spawn storm nhẹ |
| 400ms | 16 | Thiếu 8 VU | Còn room | Spawn storm trung bình |
| 500ms | 20 | Thiếu 12 VU | Còn room | Spawn storm lớn, nguy cơ drop cao |
| 1000ms | 40 | Thiếu 32 VU | Gần chạm trần | Cực kỳ nguy hiểm, maxVUs gần cạn |
| 1500ms | 60 | Thiếu 52 VU | **Vượt maxVUs** | **Chắc chắn drop** — không đủ VU |

#### Phân tích sâu

Với preAllocatedVUs = 8, điểm tới hạn là W_effective ≈ 200ms. Dưới ngưỡng này, 8 VU xoay vòng đủ nhanh để xử lý 40 arrivals/s. Trên ngưỡng này, k6 phải spawn thêm VU.

**Spawning không miễn phí:**
- Mỗi VU mới cần khởi tạo JS runtime, setup kết nối, import modules.
- Thời gian spawn: 20-200ms tùy độ phức tạp của script.
- Trong thời gian spawn, arrival vẫn đến với rate 40/s — nếu không có VU nhận, iteration bị drop.

**Demo trace — Kịch bản W_effective = 400ms:**

```
t=0.0s: rate=3/s.   Cần ceil(3×0.4)=2 VU.  Có 8 preAllocated. Thoải mái.
t=5.0s: rate=10/s.  Cần ceil(10×0.4)=4 VU. Có 8. Thoải mái.
t=7.0s: rate=16/s.  Cần ceil(16×0.4)=7 VU. Có 8. Vẫn OK.
t=8.5s: rate=20.5/s.Cần ceil(20.5×0.4)=9 VU. Có 8 preAllocated.
        → K6 bắt đầu spawn VU thứ 9. Mất 100ms.
        → Trong 100ms đó, ~2 arrivals đến. 8 VU đang bận → drop 2.
t=9.0s: rate=22/s.  Cần ceil(22×0.4)=9 VU. VU thứ 9 đã sẵn sàng. Tạm ổn.
t=10.0s: rate=25/s. Cần ceil(25×0.4)=10 VU. Spawn VU thứ 10.
t=12.0s: rate=31/s. Cần ceil(31×0.4)=13 VU. Spawn thêm 3 VU.
t=15.0s: rate=40/s. Cần ceil(40×0.4)=16 VU. Cần spawn thêm 6 VU nữa.
         → Tổng VU = 16. Vẫn trong maxVUs=50. Nhưng spawn delay có thể gây drop.
```

**Key insight:** RC1 không chỉ là "cần bao nhiêu VU ở đỉnh", mà còn là "cần spawn BAO NHIÊU VU và spawn NHANH ĐẾN ĐÂU". preAllocatedVUs càng thấp, số VU cần spawn càng nhiều, rủi ro drop càng cao.

### 4.2 RC2: Unplanned VU spawn delay → drops tại rate transition

#### Phát biểu

Khi arrival rate tăng nhanh hơn tốc độ spawn VU, iteration bị drop ở các điểm chuyển tiếp rate. Đây là nguyên nhân số 1 gây drop trong ramping-arrival-rate.

#### Cơ chế spawn của k6

K6 có 2 loại VU:
- **Pre-allocated VUs:** Được khởi tạo từ đầu test, sẵn sàng ngay lập tức.
- **Unplanned VUs:** Được spawn khi preAllocatedVUs không đủ đáp ứng arrival rate.

Quy trình spawn unplanned VU:
1. K6 scheduler phát hiện: "arrival X đang đến nhưng không có VU rảnh".
2. K6 gửi yêu cầu spawn VU mới.
3. Go runtime tạo goroutine mới, JS runtime khởi tạo.
4. VU thực thi `setup()` phase (nếu có) hoặc bắt đầu iteration loop.
5. VU sẵn sàng nhận iteration.

**Thời gian spawn điển hình:**
- Script đơn giản (1 HTTP request, không import): 10-30ms.
- Script trung bình (import modules, setup metrics): 30-80ms.
- Script phức tạp (nhiều imports, k6/chaos, k6/browser): 80-200ms.

#### Phân tích định lượng

Trong stage 2 (10→40/s trong 10 giây), rate tăng `(40-10)/10 = 3` arrivals/s mỗi giây.

```
Increase per second = 3 arrivals/s²
Increase per 100ms   = 0.3 arrivals

Nếu spawn delay = 100ms:
  → Khi phát hiện thiếu VU, trong 100ms chờ spawn:
    → ~0.3 arrivals đến thêm (trên mức hiện tại)
    → Nếu tất cả VU hiện có đều bận, 0.3 arrival bị drop
    → Làm tròn: 1 drop mỗi 3 lần spawn

Nếu spawn delay = 200ms:
  → ~0.6 arrivals đến thêm
  → Khả năng drop cao hơn
```

Tuy nhiên, drop thực tế không chỉ là 0.3-0.6 mỗi lần spawn. Lý do:

1. **Burst effect:** Khi 1 arrival bị drop, scheduler có thể đã queue thêm vài arrival nữa trước khi phát hiện thiếu VU.
2. **Cascade:** Một drop làm VU bận thêm (xử lý error), kéo dài W_effective, làm tăng nhu cầu VU.
3. **Synchronization:** Nhiều VU có thể finish iteration cùng lúc, hoặc nhiều arrival đến cùng lúc — gây ra "đói VU" cục bộ dù tổng VU đủ.

#### Demo trace — Spawn delay gây drop

```
Time  | Rate   | VUs needed | VUs available | VUs spawning | Status
------|--------|------------|---------------|--------------|-------
5.0s  | 10.0/s | 5          | 8             | 0            | OK
6.0s  | 13.0/s | 7          | 8             | 0            | OK
7.0s  | 16.0/s | 8          | 8             | 0            | Tight
7.5s  | 17.5/s | 9          | 8             | 0→1          | Scheduler detects need
7.6s  | 17.8/s | 9          | 8             | 1 (spawning) | Arrival 17.8 đến, 8 VU bận
7.6s  | 17.8/s | 9          | 8             | 1 (spawning) | **DROP 1 iteration**
7.7s  | 18.1/s | 10         | 9 (new VU up) | 0→1          | New VU sẵn sàng, nhưng cần thêm 1 nữa
7.8s  | 18.4/s | 10         | 9             | 1 (spawning) | **DROP 1 iteration**
7.9s  | 18.7/s | 10         | 10 (new VU up)| 0            | Ổn định
```

**Key insight:** Drop xảy ra ở các "bậc thang" khi VU needed vượt qua VU available. Mỗi bậc thang = 1 đợt spawn. Số bậc thang = `ceil((VU_peak_needed - preAllocatedVUs) / 1)`.

### 4.3 RC3: Cart add writes tại đỉnh spike làm tăng W_effective

#### Phát biểu

Trong spike, 25% traffic là cart add (POST). Write operations thường chậm hơn read operations (database lock, inventory check, transaction commit). Khi write load tăng, W_effective tăng, đẩy nhu cầu VU lên cao hơn dự kiến.

#### Cơ chế

```
Read operation (product list, product detail):
  - Client → LB → API Gateway → Cache (Redis) → Response
  - Thời gian điển hình: 5-30ms (cache hit)
  - Không có lock, không có transaction

Write operation (cart add):
  - Client → LB → API Gateway → Cart Service → Inventory Check → DB Write → Response
  - Thời gian điển hình: 30-200ms
  - Có thể có: row-level lock, unique constraint check, transaction commit
  - Tại spike: nhiều user cùng add 1 sản phẩm hot → lock contention
```

#### Phân tích weighted W_effective

Với traffic mix: 55% read nhanh + 25% write + 20% read chi tiết:

```
W_read_list     = 20ms  (product list, cache hit)
W_read_detail   = 30ms  (product detail, có thể cache miss)
W_write_cart    = 100ms (cart add, bình thường)
W_write_cart_spike = 300ms (cart add, lúc spike, lock contention)

W_effective_normal = 0.55 × 20 + 0.25 × 100 + 0.20 × 30
                   = 11 + 25 + 6 = 42ms

W_effective_spike  = 0.55 × 20 + 0.25 × 300 + 0.20 × 30
                   = 11 + 75 + 6 = 92ms
```

**VU requirement thay đổi:**
- Với W_effective_normal = 42ms: ceil(40 × 0.042) = 2 VU. preAllocatedVUs=8 dư sức.
- Với W_effective_spike = 92ms: ceil(40 × 0.092) = 4 VU. preAllocatedVUs=8 dư sức.
- Nhưng nếu lock contention nghiêm trọng hơn, W_write_cart_spike = 500ms:
- W_effective = 0.55 × 20 + 0.25 × 500 + 0.20 × 30 = 11 + 125 + 6 = 142ms
- VU needed = ceil(40 × 0.142) = 6 VU. Vẫn trong preAllocatedVUs=8.
- Nếu W_write_cart_spike = 1000ms (timeout hoặc retry storm):
- W_effective = 0.55 × 20 + 0.25 × 1000 + 0.20 × 30 = 11 + 250 + 6 = 267ms
- VU needed = ceil(40 × 0.267) = 11 VU. **Vượt preAllocatedVUs, cần spawn 3 VU.**

#### Insight

Cart add tại spike là "kẻ hủy diệt thầm lặng". Nó không chiếm tỉ lệ traffic cao (chỉ 25%), nhưng W_effective của nó có thể cao gấp 5-20 lần read. Khi write chậm lại do lock contention, toàn bộ VU pool bị ảnh hưởng:

1. VU đang xử lý cart add bị "kẹt" lâu hơn.
2. Các arrival khác phải chờ VU khác (nếu còn) hoặc bị drop.
3. Nếu retry được enable, arrival thất bại được retry → thêm load lên hệ thống → write còn chậm hơn nữa.

### 4.4 RC4: preAllocatedVUs=8 quá thấp cho spike nếu event không đủ nhanh

#### Phát biểu

preAllocatedVUs=8 là con số "borderline". Nó đủ nếu mọi thứ hoàn hảo (event nhanh, không lock contention, spawn instantaneous). Nhưng trong thực tế, nó là điểm yếu khi bất kỳ yếu tố nào chệch khỏi lý tưởng.

#### Phân tích "8" dưới các góc nhìn

**Góc nhìn 1: Toán học thuần túy**
```
Với W_effective = 50ms:   cần 40 × 0.05 = 2 VU  → 8 dư 6
Với W_effective = 100ms:  cần 40 × 0.10 = 4 VU  → 8 dư 4
Với W_effective = 150ms:  cần 40 × 0.15 = 6 VU  → 8 dư 2
Với W_effective = 200ms:  cần 40 × 0.20 = 8 VU  → 8 vừa đủ (tight)
Với W_effective = 250ms:  cần 40 × 0.25 = 10 VU → 8 thiếu 2
```
→ Nếu script chạy nhanh (W_effective < 200ms), 8 là đủ.

**Góc nhìn 2: Spawn overhead**
```
Khi W_effective = 250ms, cần 10 VU.
8 preAllocated + 2 unplanned.
2 unplanned = 2 lần spawn.
Mỗi lần spawn = 50-150ms overhead + risk drop.
→ Nếu spawn đủ nhanh và không drop, vẫn pass.
→ Nhưng đây là "gamble" — hy vọng spawn nhanh hơn arrival.
```

**Góc nhìn 3: Margin of safety**
```
preAllocatedVUs=8  cho phép W_effective tối đa 200ms trước khi cần spawn.
Margin = (8 - 2) / 2 = 300% ở W_effective=50ms.
Margin = (8 - 4) / 4 = 100% ở W_effective=100ms.
Margin = (8 - 6) / 6 = 33%  ở W_effective=150ms.
Margin = 0% ở W_effective=200ms.
```

→ Không có margin cho spike-induced slowdown.

**Góc nhìn 4: So sánh với best practice**
```
Best practice cho production load test:
  preAllocatedVUs nên cover 150-200% expected demand.
  → Nếu expected demand = 8 VU (W_effective=200ms) → preAllocatedVUs nên là 12-16.
  → Case này set 8 là "aggressive" — cố tình test giới hạn.
```

#### Khi nào 8 là đủ

8 VU là đủ khi:
- W_effective < 200ms trong SUỐT quá trình test (kể cả lúc spike).
- Không có lock contention trên cart add.
- Network latency thấp và ổn định.
- Không có GC pause, không có CPU throttle.

#### Khi nào 8 gây drop

8 VU gây drop khi:
- Cart add chạm lock contention → W_effective tăng vọt.
- Server bắt đầu queue request → response time tăng → W_effective tăng.
- Spawn delay > 100ms và rate đang tăng nhanh.
- Có burst arrivals (nhiều arrival đến cùng millisecond do scheduler batching).

### 4.5 RC5: Rate giảm sau spike nhưng in-flight iterations vẫn tiêu thụ VU

#### Phát biểu

Sau đỉnh spike (t=15s), rate giảm từ 40/s xuống 8/s (trong 10s) rồi 3/s (trong 5s). Logic: "rate giảm → cần ít VU hơn → VU được giải phóng". Nhưng thực tế: **in-flight iterations vẫn đang chạy**, chiếm VU, và VU không được giải phóng ngay lập tức.

#### Cơ chế

Khi rate giảm, scheduler giảm tần suất schedule iteration mới. Nhưng những iteration đã được schedule và đang chạy (in-flight) sẽ tiếp tục cho đến khi hoàn thành. VU đang xử lý iteration không thể bị "thu hồi" giữa chừng.

```
Time  | Rate   | Active VUs | In-flight iterations | VUs truly available
------|--------|------------|----------------------|---------------------
15.0s | 40/s   | 16         | 16                   | 0
15.5s | 37/s   | 16         | 14                   | 2 (2 iterations finished)
16.0s | 34/s   | 16         | 12                   | 4
17.0s | 28/s   | 15         | 10                   | 5 (1 VU idle → GC)
20.0s | 16/s   | 12         | 6                    | 6
25.0s | 8/s    | 8          | 3                    | 5
```

#### Hậu quả

1. **VU pool chưa kịp co:** Dù rate đã giảm về 8/s ở t=25s, vẫn có thể còn 8+ VU active vì in-flight iterations chưa xong.
2. **Tài nguyên lãng phí:** VU vẫn chiếm memory, CPU, connection pool dù không cần thiết.
3. **Cooldown không hoàn toàn:** Phase "cooldown" (25-30s) vẫn có thể thấy VU count cao hơn mức cần thiết cho 3/s.
4. **Che giấu vấn đề:** Nếu bạn chỉ nhìn VU count chart, bạn có thể nghĩ "hệ thống vẫn đang hoạt động ở mức VU cao" — nhưng thực ra chỉ là in-flight tail.

#### Demo trace: In-flight tail

```
Stage 4 (25-30s): target = 3/s.
Expected VU: ceil(3 × 0.2) = 1 VU.
Actual VU at t=25s: 8 VU (6 in-flight từ stage 3).
Actual VU at t=27s: 4 VU (2 in-flight).
Actual VU at t=29s: 2 VU (1 in-flight).
Actual VU at t=30s: 1 VU (all done).

→ Suốt 5s của stage 4, VU count > expected.
→ Đây không phải bug, mà là hành vi bình thường của open model.
```

#### Insight

"Rate giảm" không có nghĩa là "hệ thống nhẹ ngay lập tức". Có một **tail latency** về mặt VU usage. Điều này quan trọng trong capacity planning: nếu bạn có multiple spike campaigns liên tiếp, in-flight tail của campaign trước có thể ảnh hưởng đến campaign sau.

---

## 5. Identity model deep-dive

### 5.1 Slot identity trong ramping-arrival-rate

Trong ramping-arrival-rate, mỗi iteration được định danh bởi **thời điểm schedule** (arrival time), không phải bởi VU thực thi nó. Đây là hệ quả của open model.

| Thuộc tính | Giá trị | Giải thích |
|------------|--------|------------|
| **Schedule time** | t_schedule | Thời điểm scheduler quyết định tạo iteration này, dựa trên rate curve |
| **Actual start time** | t_start ≥ t_schedule | Thời điểm iteration thực sự bắt đầu (có VU rảnh) |
| **VU assignment** | VU_id | Động, có thể là VU pre-allocated hoặc unplanned |
| **Iteration index** | i (0-based) | Thứ tự iteration trong toàn bộ test |
| **Stage** | stage_id (0-3) | Stage mà iteration được schedule |
| **Rate at schedule** | λ(t_schedule) | Arrival rate tại thời điểm schedule |

### 5.2 Bảng trace identity qua 4 stages

Dưới đây là trace của 20 iteration mẫu, thể hiện identity qua các stage:

| Iter # | t_schedule | Stage | Rate | t_start | VU | W (ms) | Event |
|--------|------------|-------|------|---------|-----|--------|-------|
| 0 | 0.00s | 0 (pre-spike) | 3.0/s | 0.00s | VU-1 | 45 | product_list |
| 1 | 0.33s | 0 | 3.3/s | 0.33s | VU-2 | 38 | product_list |
| 2 | 0.67s | 0 | 3.7/s | 0.67s | VU-3 | 52 | cart_add |
| 3 | 1.00s | 0 | 4.0/s | 1.00s | VU-1 | 41 | product_detail |
| 4 | 1.33s | 0 | 4.3/s | 1.33s | VU-2 | 36 | product_list |
| 5 | 1.67s | 0 | 4.7/s | 1.67s | VU-4 | 48 | product_list |
| 6 | 2.00s | 0 | 5.0/s | 2.00s | VU-3 | 55 | cart_add |
| 7 | 2.33s | 0 | 5.3/s | 2.33s | VU-1 | 42 | product_detail |
| 8 | 2.67s | 0 | 5.7/s | 2.67s | VU-2 | 39 | product_list |
| 9 | 3.00s | 0 | 6.0/s | 3.00s | VU-5 | 47 | product_list |
| 10 | 3.33s | 0 | 6.3/s | 3.33s | VU-4 | 60 | cart_add |
| ... | ... | ... | ... | ... | ... | ... | ... |
| 150 | 7.55s | 1 (spike) | 17.7/s | 7.55s | VU-7 | 95 | cart_add |
| 151 | 7.61s | 1 | 17.8/s | 7.63s | VU-9* | 88 | product_list |
| 152 | 7.67s | 1 | 18.0/s | 7.67s | VU-8 | 72 | product_detail |
| ... | ... | ... | ... | ... | ... | ... | ... |
| 400 | 15.00s | 1 (đỉnh) | 40.0/s | 15.02s | VU-16* | 210 | cart_add |
| 401 | 15.03s | 2 (post) | 39.7/s | 15.03s | VU-14 | 85 | product_list |
| ... | ... | ... | ... | ... | ... | ... | ... |
| 548 | 29.67s | 3 (cool) | 3.3/s | 29.67s | VU-2 | 43 | product_list |
| 549 | 30.00s | 3 | 3.0/s | 30.00s | VU-1 | 40 | product_detail |

> `*` = unplanned VU (spawned during test)

### 5.3 Thuộc tính của identity qua các stage

| Stage | Số slot scheduled | Tỉ lệ | VU requirement (W=100ms) | Đặc điểm identity |
|-------|-------------------|-------|--------------------------|-------------------|
| 0 (pre-spike) | ~32.5 | 5.9% | 1 | Low urgency, VU dư thừa |
| 1 (spike) | ~250 | 45.5% | 1→4 | High urgency, identity gắn với thời điểm schedule chính xác |
| 2 (post-spike) | ~240 | 43.6% | 4→1 | Decreasing urgency, in-flight tail |
| 3 (cooldown) | ~27.5 | 5.0% | 1 | Residual, VU đang co lại |

### 5.4 Ý nghĩa của slot identity trong spike analysis

Khi phân tích drop, bạn cần truy ngược từ thời điểm drop về stage và rate:

1. **Drop ở t=7.6s** → Đang ở stage 1 (spike), rate ~17.8/s. Đây là early spike drop → spawn delay.
2. **Drop ở t=14.5s** → Đang ở stage 1 (spike), rate ~38.5/s. Đây là peak spike drop → VU pool không đủ.
3. **Drop ở t=20.0s** → Đang ở stage 2 (post-spike), rate ~16/s. Đáng lẽ không drop ở rate này → có thể do in-flight từ spike vẫn chiếm VU.

Identity model cho phép bạn phân biệt các loại drop và map chúng về root cause.

---

## 6. Phân tích open model với spike

### 6.1 Mô hình toán học

Ramping-arrival-rate là **open model**: arrival rate được xác định trước, độc lập với system state.

```
λ(t) = arrival rate tại thời điểm t (arrivals/s)

Stage 0 (0-5s):    λ(t) = 3 + (10-3)/5 × t        = 3 + 1.4t
Stage 1 (5-15s):   λ(t) = 10 + (40-10)/10 × (t-5) = 10 + 3(t-5)
Stage 2 (15-25s):  λ(t) = 40 + (8-40)/10 × (t-15) = 40 - 3.2(t-15)
Stage 3 (25-30s):  λ(t) = 8 + (3-8)/5 × (t-25)    = 8 - 1.0(t-25)
```

### 6.2 Scheduled slots — tính toán chi tiết

Công thức: `scheduled_slots = duration × (rate_start + rate_end) / 2`

**Stage 0 (0-5s, 3→10/s):**
```
scheduled = 5 × (3 + 10) / 2 = 5 × 6.5 = 32.5 → ~33 iterations
Rate tăng: 1.4/s mỗi giây
```

**Stage 1 (5-15s, 10→40/s) — SPIKE:**
```
scheduled = 10 × (10 + 40) / 2 = 10 × 25 = 250 iterations
Rate tăng: 3.0/s mỗi giây
Đây là stage nặng nhất: 250 iterations trong 10 giây.
```

**Stage 2 (15-25s, 40→8/s) — POST-SPIKE:**
```
scheduled = 10 × (40 + 8) / 2 = 10 × 24 = 240 iterations
Rate giảm: 3.2/s mỗi giây
```

**Stage 3 (25-30s, 8→3/s) — COOLDOWN:**
```
scheduled = 5 × (8 + 3) / 2 = 5 × 5.5 = 27.5 → ~28 iterations
Rate giảm: 1.0/s mỗi giây
```

**Tổng scheduled slots:**
```
Total = 32.5 + 250 + 240 + 27.5 = 550 iterations trong 30s
Average rate = 550 / 30 = 18.33/s
Peak rate = 40/s (gấp 2.18 lần average)
```

### 6.3 Second-by-second rate trace

Bảng chi tiết rate từng giây trong toàn bộ 30 giây:

| t (s) | Stage | λ(t) (exact) | λ(t) (rounded) | Scheduled this second | Cumulative |
|-------|-------|-------------|----------------|----------------------|------------|
| 0.0 | 0 | 3.00 | 3 | 3.7 | 3.7 |
| 1.0 | 0 | 4.40 | 4 | 5.1 | 8.8 |
| 2.0 | 0 | 5.80 | 6 | 6.5 | 15.3 |
| 3.0 | 0 | 7.20 | 7 | 7.9 | 23.2 |
| 4.0 | 0 | 8.60 | 9 | 9.3 | 32.5 |
| 5.0 | 1 | 10.00 | 10 | 11.5 | 44.0 |
| 6.0 | 1 | 13.00 | 13 | 14.5 | 58.5 |
| 7.0 | 1 | 16.00 | 16 | 17.5 | 76.0 |
| 8.0 | 1 | 19.00 | 19 | 20.5 | 96.5 |
| 9.0 | 1 | 22.00 | 22 | 23.5 | 120.0 |
| 10.0 | 1 | 25.00 | 25 | 26.5 | 146.5 |
| 11.0 | 1 | 28.00 | 28 | 29.5 | 176.0 |
| 12.0 | 1 | 31.00 | 31 | 32.5 | 208.5 |
| 13.0 | 1 | 34.00 | 34 | 35.5 | 244.0 |
| 14.0 | 1 | 37.00 | 37 | 38.5 | 282.5 |
| 15.0 | 2 | 40.00 | 40 | 38.4 | 320.9 |
| 16.0 | 2 | 36.80 | 37 | 35.2 | 356.1 |
| 17.0 | 2 | 33.60 | 34 | 32.0 | 388.1 |
| 18.0 | 2 | 30.40 | 30 | 28.8 | 416.9 |
| 19.0 | 2 | 27.20 | 27 | 25.6 | 442.5 |
| 20.0 | 2 | 24.00 | 24 | 20.8 | 463.3 |
| 21.0 | 2 | 20.80 | 21 | 17.6 | 480.9 |
| 22.0 | 2 | 17.60 | 18 | 14.4 | 495.3 |
| 23.0 | 2 | 14.40 | 14 | 11.2 | 506.5 |
| 24.0 | 2 | 11.20 | 11 | 9.6 | 516.1 |
| 25.0 | 3 | 8.00 | 8 | 7.5 | 523.6 |
| 26.0 | 3 | 7.00 | 7 | 6.5 | 530.1 |
| 27.0 | 3 | 6.00 | 6 | 5.5 | 535.6 |
| 28.0 | 3 | 5.00 | 5 | 4.5 | 540.1 |
| 29.0 | 3 | 4.00 | 4 | 3.5 | 543.6 |
| 30.0 | 3 | 3.00 | 3 | — | ~550 |

### 6.4 Phân tích VU demand second-by-second

Giả định W_effective = 200ms:

| t (s) | λ(t) | VU_needed = ceil(λ × 0.2) | preAllocatedVUs | Unplanned needed | Status |
|-------|------|---------------------------|-----------------|------------------|--------|
| 0 | 3 | 1 | 8 | 0 | Thoải mái |
| 5 | 10 | 2 | 8 | 0 | Thoải mái |
| 7 | 16 | 4 | 8 | 0 | OK |
| 8 | 19 | 4 | 8 | 0 | OK |
| 9 | 22 | 5 | 8 | 0 | OK |
| 10 | 25 | 5 | 8 | 0 | OK |
| 11 | 28 | 6 | 8 | 0 | OK |
| 12 | 31 | 7 | 8 | 0 | OK |
| 13 | 34 | 7 | 8 | 0 | Tight |
| 14 | 37 | 8 | 8 | 0 | **Critical — vừa đủ** |
| 15 | 40 | 8 | 8 | 0 | **Critical — vừa đủ** |
| 16 | 37 | 8 | 8 | 0 | Tight |
| 17 | 34 | 7 | 8 | 0 | OK |
| 20 | 24 | 5 | 8 | 0 | OK |
| 25 | 8 | 2 | 8 | 0 | Thoải mái |
| 30 | 3 | 1 | 8 | 0 | Thoải mái |

→ Với W_effective = 200ms, preAllocatedVUs=8 vừa đủ, không cần unplanned VU nhưng không có margin.

Giả định W_effective = 300ms:

| t (s) | λ(t) | VU_needed = ceil(λ × 0.3) | preAllocatedVUs | Unplanned needed | Status |
|-------|------|---------------------------|-----------------|------------------|--------|
| 0 | 3 | 1 | 8 | 0 | Thoải mái |
| 5 | 10 | 3 | 8 | 0 | OK |
| 8 | 19 | 6 | 8 | 0 | OK |
| 10 | 25 | 8 | 8 | 0 | Tight |
| 11 | 28 | 9 | 8 | 1 | **Cần spawn 1 VU** |
| 12 | 31 | 10 | 8 | 2 | **Cần spawn 2 VU** |
| 13 | 34 | 11 | 8 | 3 | **Spawn storm** |
| 14 | 37 | 12 | 8 | 4 | **Spawn storm** |
| 15 | 40 | 12 | 8 | 4 | **Đỉnh: cần 12 VU** |
| 16 | 37 | 12 | 8 | 4 | Vẫn cần 12 |
| 17 | 34 | 11 | 8 | 3 | Bắt đầu giảm |
| 20 | 24 | 8 | 8 | 0 | Về mức preAllocated |
| 25 | 8 | 3 | 8 | 0 | Thoải mái |

→ Với W_effective = 300ms, cần đến 12 VU ở đỉnh → spawn 4 unplanned VU. Rủi ro drop cao.

### 6.5 Phân tích arrival pattern trong spike

Trong stage 1 (spike), mỗi giây rate tăng 3 arrivals/s. Điều này có nghĩa:

```
Giây 5-6:  rate 10→13,  schedule ~11.5 iterations → mỗi 87ms 1 iteration
Giây 7-8:  rate 16→19,  schedule ~17.5 iterations → mỗi 57ms 1 iteration
Giây 10-11: rate 25→28, schedule ~26.5 iterations → mỗi 38ms 1 iteration
Giây 14-15: rate 37→40, schedule ~38.5 iterations → mỗi 26ms 1 iteration
```

**Inter-arrival time tại các mốc quan trọng:**

| Rate | Inter-arrival time | Cảm nhận |
|------|-------------------|----------|
| 3/s | 333ms | Thưa, dễ xử lý |
| 10/s | 100ms | Bắt đầu dày |
| 20/s | 50ms | Dày, cần VU pool responsive |
| 30/s | 33ms | Rất dày |
| 40/s | 25ms | Cực dày — mỗi 25ms có 1 event mới |

### 6.6 Hành vi queue

Khi arrival rate > processing rate (VUs / W_effective), iteration được queue. K6 có internal queue cho arrival. Nếu queue đầy (hoặc VU pool không đủ sau khi queue hết capacity), iteration bị drop.

```
Queue depth tại thời điểm t:
  Q(t) = accumulated_arrivals(t) - completed_iterations(t)

Nếu Q(t) > 0 và tăng: hệ thống đang overload.
Nếu Q(t) > 0 và giảm: hệ thống đang phục hồi.
Nếu Q(t) = 0: hệ thống xử lý kịp.
```

Trong spike, Q(t) thường > 0 vì rate tăng nhanh hơn khả năng spawn VU. Sau spike, Q(t) giảm dần về 0 khi rate giảm và VU "bắt kịp".

---

## 7. Bảng service/API flow

### 7.1 Tổng quan flow

Mỗi iteration thực hiện **1 API call duy nhất**, chọn ngẫu nhiên theo trọng số (weighted random). Không có sleep/think time giữa các request — đây là "fire-and-measure" pattern.

### 7.2 Weighted branches

| Branch | Weight | Tỉ lệ | Method | Endpoint | Loại | W trung bình |
|--------|--------|-------|--------|----------|------|-------------|
| product_list | 55 | 55% | GET | `/api/sim/product/list?page=1&size=20` | Read | 15-30ms |
| cart_add | 25 | 25% | POST | `/api/sim/cart/add` (body: `{product_id, quantity}`) | Write | 50-300ms |
| product_detail | 20 | 20% | GET | `/api/sim/product/detail/{id}` | Read | 20-40ms |

### 7.3 Expected call counts per stage

| Stage | Scheduled slots | product_list (55%) | cart_add (25%) | product_detail (20%) |
|-------|-----------------|-------------------|----------------|---------------------|
| 0 (pre-spike) | 33 | ~18 | ~8 | ~7 |
| 1 (spike) | 250 | ~138 | ~63 | ~50 |
| 2 (post-spike) | 240 | ~132 | ~60 | ~48 |
| 3 (cooldown) | 28 | ~15 | ~7 | ~6 |
| **Total** | **~550** | **~303** | **~138** | **~110** |

### 7.4 Write pressure analysis

Cart add tại spike (stage 1) là mối quan tâm chính:

```
Stage 1: 63 cart add trong 10 giây → trung bình 6.3 cart add/s
Tại đỉnh (t=15s, rate=40/s): 40 × 0.25 = 10 cart add/s

Mỗi cart add:
  - Validate product_id + quantity
  - Check inventory (DB read)
  - Insert/update cart row (DB write, có thể lock)
  - Return cart state

Nếu dùng DB transaction:
  - Lock duration: 20-100ms tùy DB engine
  - 10 transactions/s → lock contention probability ~10%
  - Lock contention → retry → W tăng gấp đôi
```

### 7.5 API flow sequence diagram (mô tả text)

```
Iteration bắt đầu
  │
  ├─ Weighted random chọn branch
  │
  ├─ [55%] GET /api/sim/product/list
  │   └─ Cache lookup → Response
  │
  ├─ [25%] POST /api/sim/cart/add
  │   ├─ Validate input
  │   ├─ Check inventory (SELECT ... FOR UPDATE)
  │   ├─ Insert/Update cart_items
  │   ├─ COMMIT
  │   └─ Response với cart state
  │
  └─ [20%] GET /api/sim/product/detail/{id}
      ├─ Cache lookup (Redis)
      ├─ Cache miss → DB read
      └─ Response với product details
```

### 7.6 Expected response time breakdown

| Branch | DNS+Connect | TLS | Send | Wait (TTFB) | Receive | Total (p95) |
|--------|-------------|-----|------|-------------|---------|-------------|
| product_list | ~2ms | ~3ms | ~1ms | ~10-20ms | ~2ms | ~18-28ms |
| cart_add | ~2ms | ~3ms | ~1ms | ~40-250ms | ~3ms | ~49-259ms |
| product_detail | ~2ms | ~3ms | ~1ms | ~15-30ms | ~3ms | ~24-39ms |

---

## 8. Metrics & tags deep-dive

### 8.1 Custom metrics

| Metric name | Type | Description | Tag set |
|-------------|------|-------------|---------|
| `ramping_arrival_events_total` | Counter | Tổng số event (iteration) đã schedule | `case_id`, `business_case`, `stage` |
| `ramping_arrival_events_failed` | Counter | Số event thất bại (drop hoặc error) | `case_id`, `business_case`, `stage`, `error_type` |
| `ramping_arrival_api_calls_total` | Counter | Tổng số API call đã thực hiện | `case_id`, `business_case`, `endpoint`, `method` |
| `ramping_arrival_event_duration_ms` | Trend | Thời gian hoàn thành 1 event (từ schedule đến finish) | `case_id`, `business_case`, `branch` |

### 8.2 Tags chi tiết

**case_id:** `rar-02-campaign-ingress-spike`
- Dùng để lọc kết quả của riêng case này trong dashboard và report.

**business_case:** `campaign_ingress_spike`
- Dùng để nhóm các case cùng business pattern (có thể có nhiều cấu hình khác nhau cho cùng business case).

**stage:**
- `0` — Pre-spike (0-5s)
- `1` — Spike (5-15s)
- `2` — Post-spike (15-25s)
- `3` — Cooldown (25-30s)
- Giúp phân tích metric theo từng phase.

**branch:**
- `product_list`
- `cart_add`
- `product_detail`
- Giúp so sánh response time giữa các loại operation.

**error_type:**
- `drop` — iteration bị drop do không có VU
- `timeout` — request timeout
- `http_error` — HTTP status >= 400
- `connection_error` — không kết nối được

### 8.3 Built-in metrics cần quan sát

| Metric | Importance | Why |
|--------|-----------|-----|
| `http_req_duration` | CRITICAL | Response time tổng thể; p95 phải < 500ms |
| `http_req_failed` | CRITICAL | Tỉ lệ lỗi; phải = 0% |
| `http_reqs` | HIGH | Tổng số request; so sánh với scheduled slots |
| `vus` | HIGH | Số VU active; theo dõi spawn behavior |
| `vus_max` | HIGH | Số VU tối đa đạt được; so với maxVUs=50 |
| `dropped_iterations` | CRITICAL | Số iteration bị drop; phải = 0 |
| `iterations` | HIGH | Số iteration đã hoàn thành; so với scheduled |
| `iteration_duration` | MEDIUM | Thời gian iteration; so với event_duration |
| `data_sent` | LOW | Băng thông gửi đi |
| `data_received` | LOW | Băng thông nhận về |

### 8.4 Cách dùng metrics để chẩn đoán

| Triệu chứng | Metrics cần check | Chẩn đoán |
|-------------|-------------------|-----------|
| Có dropped_iterations > 0 | `dropped_iterations`, `vus`, `vus_max` | VU pool không đủ → tăng maxVUs hoặc preAllocatedVUs |
| http_req_duration p95 > 500ms | `http_req_duration` (filter by `branch=cart_add`), `http_req_duration` (filter by `stage=1`) | Cart add chậm trong spike → tối ưu DB |
| http_req_failed > 0% | `http_req_failed` (filter by `error_type`) | Timeout hoặc connection error → check network/server |
| vus_max chạm maxVUs=50 | `vus_max`, `vus` | Cần tăng maxVUs |
| iteration_duration >> event_duration | So sánh 2 metric | Queue time lớn → VU không đủ, iteration phải chờ |

### 8.5 Prometheus-style queries (giả định)

```
# Tổng event theo stage
sum(ramping_arrival_events_total{case_id="rar-02-campaign-ingress-spike"}) by (stage)

# Event failed theo error_type
sum(ramping_arrival_events_failed{case_id="rar-02-campaign-ingress-spike"}) by (error_type)

# API calls theo endpoint
sum(ramping_arrival_api_calls_total{case_id="rar-02-campaign-ingress-spike"}) by (endpoint)

# p95 event duration theo branch
histogram_quantile(0.95, sum(rate(ramping_arrival_event_duration_ms_bucket{case_id="rar-02-campaign-ingress-spike"}[30s])) by (le, branch))
```

---

## 9. Pass criteria

### 9.1 Primary pass criteria (bắt buộc)

| # | Criteria | Ngưỡng | Priority |
|---|----------|--------|----------|
| P1 | Zero dropped iterations | `dropped_iterations == 0` | BLOCKER |
| P2 | p95 event duration | < 500ms | CRITICAL |
| P3 | p95 http_req_duration (reads) | < 300ms | CRITICAL |
| P4 | p95 http_req_duration (cart_add) | < 500ms | CRITICAL |
| P5 | Zero HTTP errors | `http_req_failed < 0.1%` | CRITICAL |

### 9.2 Secondary pass criteria (nên đạt)

| # | Criteria | Ngưỡng | Priority |
|---|----------|--------|----------|
| S1 | vus_max không chạm maxVUs | `vus_max < 50` | HIGH |
| S2 | Tỉ lệ unplanned VUs / total VUs | < 30% | HIGH |
| S3 | p99 event duration | < 1000ms | MEDIUM |
| S4 | Response time không có "hockey stick" | Visual check trên chart | MEDIUM |
| S5 | Cart add success rate | > 99.5% | MEDIUM |

### 9.3 Nice-to-have

| # | Criteria | Ngưỡng | Priority |
|---|----------|--------|----------|
| N1 | p95 event duration tại stage 1 (spike) | < 400ms | LOW |
| N2 | Zero unplanned VU | preAllocatedVUs đủ cho toàn bộ test | LOW |
| N3 | VU count trở về preAllocatedVUs trong 5s sau spike | t=20s: VU ≤ 10 | LOW |

### 9.4 Cách tính pass/fail tổng hợp

```
PASS = P1 AND P2 AND P3 AND P4 AND P5
CONDITIONAL PASS = P1 AND (P2 OR P3 OR P4 fail nhưng P5 pass)
                   → Hệ thống xử lý được nhưng chậm
FAIL = P1 fail (có drop) OR P5 fail (có HTTP error)
```

### 9.5 Pass criteria map với business impact

| Criteria fail | Business impact | Mức độ nghiêm trọng |
|---------------|-----------------|---------------------|
| P1 fail (drop) | Mất user, mất doanh thu trực tiếp | SEVERE |
| P2 fail (chậm) | User experience kém, tỉ lệ bounce cao | HIGH |
| P4 fail (cart chậm) | Không thêm được vào giỏ → không mua được | CRITICAL (revenue) |
| P5 fail (error) | "Có lỗi xảy ra, vui lòng thử lại" → user bỏ đi | SEVERE |
| S2 fail (nhiều unplanned) | Hệ thống không ổn định, risky cho production | MEDIUM |

---

## 10. Cách chạy

### 10.1 Local run (cơ bản)

```bash
k6 run ramping-arrival-rate/rar-02-campaign-ingress-spike.js
```

Output sẽ hiển thị:
- Summary cuối cùng với các metric quan trọng
- Check failures (nếu có)
- Trends (p95, p99)

### 10.2 Local run với output JSON

```bash
k6 run ramping-arrival-rate/rar-02-campaign-ingress-spike.js \
  --out json=results-rar-02.json \
  --summary-export=summary-rar-02.json
```

### 10.3 Run với dashboard (Grafana + k6 Cloud)

```bash
k6 run ramping-arrival-rate/rar-02-campaign-ingress-spike.js \
  --out cloud \
  --tag case_id=rar-02-campaign-ingress-spike \
  --tag business_case=campaign_ingress_spike
```

Hoặc dùng local dashboard:

```bash
k6 run ramping-arrival-rate/rar-02-campaign-ingress-spike.js \
  --out statsd
```

### 10.4 Environment variable overrides

```bash
# Override target URL
k6 run ramping-arrival-rate/rar-02-campaign-ingress-spike.js \
  -e TARGET_URL=https://staging.example.com

# Override VU pool size
k6 run ramping-arrival-rate/rar-02-campaign-ingress-spike.js \
  -e PRE_ALLOCATED_VUS=16 \
  -e MAX_VUS=80

# Override spike height
k6 run ramping-arrival-rate/rar-02-campaign-ingress-spike.js \
  -e SPIKE_PEAK_RATE=60
```

### 10.5 Staged run (dev → staging → production)

```
Dev:     k6 run ... -e TARGET_URL=http://localhost:8080  -e MAX_VUS=20
Staging: k6 run ... -e TARGET_URL=https://staging...     -e MAX_VUS=50
Prod:    k6 run ... -e TARGET_URL=https://prod...        -e MAX_VUS=100
```

### 10.6 Run với gradual confidence building

```bash
# Bước 1: Test pre-spike phase trước (5s)
k6 run ... -e STAGES='[{"duration":"5s","target":10}]' -e MAX_VUS=10

# Bước 2: Thêm spike phase (15s)
k6 run ... -e STAGES='[{"duration":"5s","target":10},{"duration":"10s","target":40}]' -e MAX_VUS=30

# Bước 3: Full 30s test
k6 run ... -e MAX_VUS=50
```

---

## 11. Phân tích output 5 bước

### Bước 1: Kiểm tra tổng quan — Pass/Fail?

Đọc summary cuối cùng:

```
✓ checks...
  ✓ http_req_duration_p95 < 500ms
  ✓ no_dropped_iterations
  ✓ no_http_errors

✗ ramping_arrival_event_duration_p95 < 500ms
  (actual: 620ms)
```

→ Xác định ngay: Pass hay Fail? Những criteria nào fail?

### Bước 2: Phân tích dropped iterations

Nếu `dropped_iterations > 0`:

1. **Xác định thời điểm drop:** Dùng `--verbose` hoặc log để xem drop xảy ra lúc nào.
2. **Map về stage:**
   - Drop ở t=6-8s → spawn delay trong early spike
   - Drop ở t=12-15s → VU pool không đủ ở peak
   - Drop ở t=16-20s → in-flight tail từ peak
3. **Check VU count chart:** Tại thời điểm drop, `vus` so với `vus_max` thế nào?
   - `vus < maxVUs` nhưng vẫn drop → spawn không kịp (tăng preAllocatedVUs)
   - `vus == maxVUs` và drop → maxVUs là bottleneck (tăng maxVUs)

### Bước 3: Phân tích response time theo stage và branch

1. **Lọc http_req_duration theo stage:**
   ```
   Stage 0 (pre-spike):  p95 = 45ms   → Bình thường
   Stage 1 (spike):      p95 = 320ms  → Tăng nhưng chấp nhận được
   Stage 2 (post-spike): p95 = 180ms  → Đã giảm
   Stage 3 (cooldown):   p95 = 50ms   → Bình thường
   ```

2. **Lọc http_req_duration theo branch:**
   ```
   product_list:   p95 = 28ms   → Nhanh, cache hit
   cart_add:       p95 = 450ms  → Chậm, nhưng trong ngưỡng
   product_detail: p95 = 35ms   → Nhanh
   ```

3. **So sánh stage 1 vs các stage khác:**
   - Nếu stage 1 cao hơn hẳn (gấp 3-5 lần) → spike pressure thực sự
   - Nếu tất cả stage đều cao → vấn đề không phải spike, mà là baseline

### Bước 4: Phân tích VU behavior

1. **VU count chart:**
   ```
   Start:    8 VU (preAllocated)
   t=5-8s:   8 VU (vẫn trong preAllocated)
   t=9s:     9 VU (spawn unplanned đầu tiên)
   t=12s:    14 VU (spawn storm)
   t=15s:    16 VU (peak)
   t=16-20s: Giảm dần 16→10 VU
   t=25s:    9 VU
   t=30s:    8 VU (về preAllocated)
   ```

2. **Số unplanned VU:**
   ```
   Total VU peak = 16
   Unplanned = 16 - 8 = 8
   Tỉ lệ = 8/16 = 50%
   → Cao! Nên tăng preAllocatedVUs.
   ```

3. **VU churn (spawn/destroy cycle):**
   - Spawn quá nhiều → overhead
   - Destroy rồi spawn lại → lãng phí
   - Nên có preAllocatedVUs đủ lớn để tránh churn

### Bước 5: Ra quyết định

Dựa trên kết quả 4 bước trên, đưa ra một trong các quyết định:

| Kết quả | Quyết định |
|---------|-----------|
| Pass tất cả criteria | **GO** — Hệ thống sẵn sàng cho campaign |
| Pass P1-P5 nhưng S2 fail | **CONDITIONAL GO** — Tăng preAllocatedVUs trước production |
| P1 fail (có drop) + vus < maxVUs | **NO GO** — Tăng preAllocatedVUs, rerun |
| P1 fail + vus == maxVUs | **NO GO** — Tăng maxVUs, rerun |
| P4 fail (cart chậm) | **NO GO** — Tối ưu DB/cart service, rerun |
| P5 fail (HTTP error) | **NO GO** — Fix bug, rerun |

---

## 12. Dashboard 3-chart deep analysis

### 12.1 Chart 1: Response Time — theo dõi spike impact

**Mô tả chart:** Line chart hiển thị `http_req_duration` (p50, p95, p99) theo thời gian, overlay với arrival rate curve.

**Phân tích:**

```
Phase 1 (0-5s, pre-spike):
  - Response time phẳng, thấp (20-50ms)
  - p50, p95, p99 gần nhau → hệ thống ổn định
  - Không có queue, không có contention

Phase 2 (5-15s, SPIKE):
  - Tại t=5-7s: Response time bắt đầu tăng nhẹ (50→80ms)
  - Tại t=8-12s: p95 tăng rõ rệt (80→200ms)
  - Tại t=13-15s: p95 đạt đỉnh (200→350ms)
  - p99 có thể tách xa p95 → dấu hiệu của queue build-up
  - Dấu hiệu "hockey stick":
    * Nếu có: p95 tăng đột biến ở t=10-12s và giữ cao → hệ thống bão hòa
    * Nếu không có: p95 tăng từ từ theo rate → hệ thống còn capacity

Phase 3 (15-25s, post-spike):
  - Response time giảm dần
  - p95 giảm nhanh hơn p99 (p99 có "tail" dài hơn)
  - Đến t=20s: response time gần về baseline

Phase 4 (25-30s, cooldown):
  - Response time về baseline
  - Nếu response time vẫn cao → vấn đề không phải spike, mà là memory/GC
```

**Cách đọc chart để chẩn đoán:**

| Pattern | Chẩn đoán |
|---------|-----------|
| p95 tăng đột biến, p50 không đổi | Một số request chậm (lock contention) |
| p95 và p50 cùng tăng | Toàn bộ hệ thống chậm (overload) |
| p99 >> p95 (gap lớn) | Tail latency, queue build-up |
| Response time không giảm sau spike | Memory leak, connection pool cạn |
| Response time dao động mạnh | GC pause hoặc resource contention |

### 12.2 Chart 2: Execution Timeline — iter/s theo rate curve

**Mô tả chart:** Bar chart hoặc line chart hiển thị số iteration/s thực tế (execution rate) so với target rate curve.

**Phân tích:**

```
Target curve (lý thuyết):
  t=0-5s:   3→10/s
  t=5-15s:  10→40/s
  t=15-25s: 40→8/s
  t=25-30s: 8→3/s

Actual execution rate:
  - Nếu actual ≈ target: VU pool đủ, không drop
  - Nếu actual < target: có drop (iteration không được execute)
  - Nếu actual > target: impossible (không thể execute nhiều hơn schedule)
```

**Các pattern điển hình:**

| Pattern | Mô tả | Nguyên nhân |
|---------|-------|-------------|
| **Perfect match** | Actual = target suốt 30s | Hệ thống đủ capacity |
| **Spike gap** | Actual < target trong stage 1 (spike) | VU pool không đủ, drop xảy ra |
| **Spike lag** | Actual bị trễ ~1-2s so với target | Spawn delay, VU "bắt kịp" sau |
| **Post-spike overshoot** | Actual > target trong stage 2 | In-flight từ spike hoàn thành, tạo "burst" |
| **Early drop** | Actual < target từ t=7-8s | Spawn không kịp ngay từ đầu spike |

**Tính toán gap:**

```
Stage 1 expected: 250 iterations
Stage 1 actual:   230 iterations
Gap: 20 iterations dropped (8%)
→ 8% drop rate trong spike → không chấp nhận được
```

### 12.3 Chart 3: VUs vs iter/s — VU demand explodes at spike

**Mô tả chart:** Dual-axis chart: VU count (left axis) và arrival rate (right axis) theo thời gian.

**Phân tích:**

```
Pre-spike (0-5s):
  - VU count: 8 (flat, preAllocated)
  - Rate: 3→10/s
  - VUs/rate ratio: 8/3 = 2.67 → 8/10 = 0.8 (giảm)
  - Dư thừa VU

Spike (5-15s):
  - VU count: 8→16 (tăng gấp đôi)
  - Rate: 10→40/s (tăng gấp 4)
  - VUs/rate ratio: 8/10 = 0.8 → 16/40 = 0.4
  - VU tăng không theo kịp rate → áp lực tăng

Post-spike (15-25s):
  - VU count: 16→8 (giảm)
  - Rate: 40→8/s (giảm gấp 5)
  - VUs/rate ratio: 16/40 = 0.4 → 8/8 = 1.0
  - VU giảm chậm hơn rate → in-flight tail

Cooldown (25-30s):
  - VU count: 8→8 (flat)
  - Rate: 8→3/s
  - Dư thừa VU trở lại
```

**Các pattern quan trọng:**

1. **VU count "bậc thang":** Mỗi bậc = 1 unplanned VU được spawn. Khoảng cách giữa các bậc = spawn delay.
2. **VU count phẳng ở maxVUs:** Nếu VU count chạm maxVUs=50 và phẳng → bottleneck! Cần tăng maxVUs.
3. **VU count không giảm sau spike:** In-flight iterations kéo dài → có thể có slow requests.
4. **VU count dao động:** Spawn/destroy liên tục → preAllocatedVUs không đủ, system không ổn định.

**Tỉ lệ VU utilization:**

```
VU utilization = (active VUs xử lý iteration) / total VUs

Pre-spike:  utilization thấp (2/8 = 25%)
Spike peak: utilization cao (16/16 = 100% nếu tất cả bận)
Post-spike: utilization giảm dần
```

### 12.4 Tổng hợp insights từ 3 chart

| Insight | Chart 1 (RT) | Chart 2 (iter/s) | Chart 3 (VUs) |
|---------|-------------|-----------------|---------------|
| Hệ thống đủ capacity | RT thấp, phẳng | Actual = Target | VU count ổn định |
| Spawn delay | RT tăng nhẹ đầu spike | Actual < Target ở early spike | VU count tăng bậc thang |
| VU bottleneck | RT tăng mạnh | Actual << Target | VU count chạm maxVUs |
| Slow writes | RT của cart_add cao | Iter/s vẫn OK nhưng RT cao | VU count cao hơn dự kiến |
| Memory/GC issue | RT tăng sau spike | Iter/s OK | VU count không giảm |

---

## 13. 4 output→decision scenarios

### 13.1 Scenario A: Perfect Pass — Spike handled, 0 drops

**Output:**
```
dropped_iterations: 0
http_req_duration_p95: 120ms (reads), 280ms (cart_add)
ramping_arrival_event_duration_p95: 150ms
vus_max: 10
unplanned_vus: 2
http_req_failed: 0.00%
```

**Phân tích:**
- Hệ thống xử lý spike 40/s hoàn hảo.
- Chỉ cần 10 VU (8 preAllocated + 2 unplanned) cho toàn bộ test.
- Response time thấp ở mọi stage.
- Cart add không bị lock contention.

**Decision: GO**
- Hệ thống sẵn sàng cho campaign production.
- preAllocatedVUs=8 là đủ với W_effective hiện tại.
- Có thể xem xét tăng peak rate lên 60/s để test margin.

**Hành động tiếp theo:**
1. Deploy lên production.
2. Monitor thực tế trong campaign.
3. Chuẩn bị kế hoạch rollback nếu production khác test.

### 13.2 Scenario B: Drops at spike onset — Spawn delay

**Output:**
```
dropped_iterations: 12 (tập trung ở t=7-10s)
http_req_duration_p95: 180ms (reads), 350ms (cart_add)
ramping_arrival_event_duration_p95: 220ms
vus_max: 14
unplanned_vus: 6
http_req_failed: 0.00%
```

**Phân tích:**
- 12 iteration bị drop, tất cả trong khoảng t=7-10s (early spike).
- Đây là dấu hiệu kinh điển của spawn delay: VU pool không kịp expand khi rate bắt đầu tăng nhanh.
- Sau t=10s, không còn drop → VU pool đã đủ.
- vus_max=14, vẫn xa maxVUs=50 → maxVUs không phải vấn đề.
- Response time vẫn chấp nhận được.

**Decision: CONDITIONAL NO GO**
- Tăng preAllocatedVUs từ 8 lên 12-14.
- Rerun để xác nhận không còn drop.

**Hành động tiếp theo:**
1. Set `preAllocatedVUs = 14` (target: cover early spike demand).
2. Rerun test.
3. Nếu pass → GO.
4. Nếu vẫn drop → phân tích thêm (có thể script quá chậm).

**Tại sao preAllocatedVUs=14:**
```
Tại t=7s, rate=16/s, W_effective~200ms → cần ~4 VU
Tại t=8s, rate=19/s, cần 4 VU
Tại t=9s, rate=22/s, cần 5 VU
Tại t=10s, rate=25/s, cần 5 VU
Tại t=11s, rate=28/s, cần 6 VU
...
Tại t=15s, rate=40/s, cần 8 VU

→ preAllocatedVUs=8 vừa đủ ở peak nếu spawn instantaneous.
→ Nhưng spawn không instantaneous → cần margin.
→ 14 VU = 8 (base) + 6 (margin) → đủ cho cả early spike không cần spawn.
```

### 13.3 Scenario C: Drops throughout spike — VU pool ceiling

**Output:**
```
dropped_iterations: 85 (rải rác khắp t=8-15s)
http_req_duration_p95: 450ms (reads), 1200ms (cart_add)
ramping_arrival_event_duration_p95: 900ms
vus_max: 50 (CHẠM TRẦN)
unplanned_vus: 42
http_req_failed: 2.30%
```

**Phân tích:**
- 85 iteration bị drop (15.5% của 550).
- vus_max=50 chạm trần → maxVUs là bottleneck.
- Cart add p95=1200ms → write contention nghiêm trọng.
- Response time rất cao → hệ thống overload.
- 2.3% HTTP error → server bắt đầu trả lỗi.

**Decision: NO GO — Cần work ở cả 2 phía**
- **Phía k6:** Tăng maxVUs lên 80-100.
- **Phía application:** Tối ưu cart add (DB indexing, connection pooling, cache).
- **Phía infrastructure:** Scale up/out server.

**Hành động tiếp theo:**
1. Dev team tối ưu cart add endpoint (target: p95 < 200ms).
2. Infrastructure team tăng instance count hoặc instance size.
3. Tăng maxVUs lên 80.
4. Rerun test.
5. Nếu vẫn drop → tiếp tục tối ưu.

**Phân tích gốc rễ:**
```
85 drops trong 550 scheduled = 15.5% drop rate
Nguyên nhân chuỗi:
  1. Cart add chậm (1200ms) → W_effective tăng
  2. W_effective tăng → cần nhiều VU hơn
  3. VU tăng đến maxVUs=50 → không tăng được nữa
  4. Arrival vẫn đến với rate 40/s → drop
  5. Drop tăng load lên server (retry?) → cart add còn chậm hơn
```

### 13.4 Scenario D: Post-spike tail — Latency persists after rate drops

**Output:**
```
dropped_iterations: 0
http_req_duration_p95: 180ms (reads stage 1), 350ms (reads stage 2) ← LẠ!
http_req_duration_p95 (cart_add): 400ms (stage 1), 600ms (stage 2) ← LẠ!
ramping_arrival_event_duration_p95: 250ms (stage 1), 500ms (stage 2)
vus_max: 12
unplanned_vus: 4
http_req_failed: 0.00%
```

**Phân tích:**
- Không có drop → VU pool đủ.
- Nhưng response time trong stage 2 (post-spike, rate 40→8/s) CAO HƠN stage 1 (spike, rate 10→40/s).
- Đây là pattern "post-spike hangover":
  - Trong spike, server bị đẩy đến giới hạn.
  - Connection pool cạn, thread pool cạn, DB connection pool cạn.
  - GC được kích hoạt do memory pressure.
  - Khi rate giảm, server chưa kịp phục hồi.
  - Request trong stage 2 phải chờ tài nguyên được giải phóng.

**Decision: CONDITIONAL GO (với cảnh báo)**
- Hệ thống không drop request → user vẫn được phục vụ.
- Nhưng latency cao trong post-spike → user experience kém.
- Cần điều tra: connection pool sizing, GC tuning, memory leak?

**Hành động tiếp theo:**
1. Check server-side metrics trong stage 2:
   - Connection pool active/idle
   - GC pause time
   - Thread pool queue depth
   - DB connection pool wait time
2. Tuning:
   - Tăng connection pool size
   - Tối ưu GC (nếu là Java/Go)
   - Add circuit breaker để fail fast thay vì queue
3. Rerun để xác nhận cải thiện.

### 13.5 Decision tree tổng hợp

```
Test results
│
├─ Có drop?
│  ├─ YES → Drop tập trung ở đâu?
│  │   ├─ Early spike (t=6-10s) → Scenario B: tăng preAllocatedVUs
│  │   ├─ Throughout spike (t=8-15s) → Scenario C: tăng maxVUs + tối ưu app
│  │   └─ Post-spike (t=16-20s) → In-flight tail, tăng maxVUs
│  │
│  └─ NO → Response time OK?
│     ├─ YES (tất cả < ngưỡng) → Scenario A: GO
│     └─ NO → Chậm ở đâu?
│         ├─ Cart add → Tối ưu DB
│         ├─ Post-spike → Scenario D: connection pool/GC
│         └─ Đều → Overload, cần scale
```

---

## 14. "Nghịch lý" (4)

### 14.1 NL1: "Average rate 18.3/s nhưng phải size cho 40/s peak"

#### Nghịch lý

Một người mới có thể nhìn vào average rate = 18.3/s và nghĩ: "Hệ thống chỉ cần xử lý ~18 request/s, dễ mà." Nhưng thực tế, hệ thống phải được size cho **40/s peak**, không phải 18.3/s average.

#### Tại sao đây là nghịch lý

Trong steady-state load test, average rate là đủ để sizing. Nhưng với spike pattern, average rate là **sai số thống kê nguy hiểm**. 18.3/s average che giấu sự thật rằng trong 10 giây, hệ thống phải chịu 25-40/s.

#### Con số biết nói

```
Tổng iterations: 550 trong 30s → average 18.3/s
Iterations trong 10s spike: 250 → average 25/s trong spike
Iterations trong 5s cuối của spike (t=10-15s): ~163 → average 32.6/s
Peak instantaneous rate: 40/s

→ Nếu size cho 20/s, hệ thống sẽ drop ~40% iterations trong spike.
→ Nếu size cho 30/s, hệ thống sẽ drop ~15% iterations trong spike.
→ Phải size cho 40/s (gấp 2.18 lần average).
```

#### Bài học

**Không bao giờ dùng average rate để sizing cho spike test.** Luôn dùng peak rate. Công thức đúng:

```
capacity_required = peak_rate × W_effective × safety_factor
                  = 40 × 0.2 × 1.5 = 12 VU (không phải 18.3 × 0.2 = 4 VU)
```

### 14.2 NL2: "preAllocatedVUs=8 cho peak 40/s — nghe vô lý nhưng event nhanh thì hợp lý"

#### Nghịch lý

"40 request mỗi giây mà chỉ cần 8 VU? 1 VU xử lý 5 request/s sao?" — Nghe có vẻ phi lý với người quen closed model (ramping-vus, constant-vus), nơi mỗi VU chạy tuần tự.

#### Tại sao 8 VU có thể đủ cho 40/s

Trong open model, VU không "sở hữu" iteration. VU là worker xử lý iteration từ queue. Nếu mỗi iteration chỉ mất 100ms, 1 VU xử lý được 10 iteration/s. 8 VU × 10 iter/s = 80 iter/s capacity — dư sức cho 40/s.

```
Công thức: VU_capacity = VU_count / W_effective

8 VU, W_effective = 200ms: capacity = 8/0.2 = 40/s → vừa đủ
8 VU, W_effective = 150ms: capacity = 8/0.15 = 53/s → dư 33%
8 VU, W_effective = 100ms: capacity = 8/0.1 = 80/s → dư 100%
8 VU, W_effective = 50ms:  capacity = 8/0.05 = 160/s → dư 300%
```

#### Khi nào 8 VU là vô lý THỰC SỰ

```
8 VU, W_effective = 500ms:  capacity = 8/0.5 = 16/s → thiếu 24/s
8 VU, W_effective = 1000ms: capacity = 8/1.0 = 8/s → thiếu 32/s (drop 80%)
```

#### Bài học

preAllocatedVUs không phải là con số "1 VU cho N request/s". Nó phải được tính từ **W_effective thực tế**. Nếu event nhanh (W_effective < 200ms), 8 VU là quá đủ. Nếu event chậm (W_effective > 300ms), 8 VU là thảm họa.

### 14.3 NL3: "Spike 10→40/s trong 10s — tưởng từ từ nhưng mỗi giây tăng 3 arrivals"

#### Nghịch lý

"Tăng từ 10 lên 40 trong 10 giây" — nghe có vẻ từ từ (10 giây là dài). Nhưng mỗi giây, rate tăng thêm 3 arrivals. Điều này có nghĩa:

#### Phân tích second-by-second

```
Giây 0 của spike (t=5):   rate = 10/s  → mỗi 100ms 1 arrival
Giây 1 của spike (t=6):   rate = 13/s  → mỗi 77ms 1 arrival
Giây 2 của spike (t=7):   rate = 16/s  → mỗi 63ms 1 arrival
Giây 3 của spike (t=8):   rate = 19/s  → mỗi 53ms 1 arrival
Giây 4 của spike (t=9):   rate = 22/s  → mỗi 45ms 1 arrival
Giây 5 của spike (t=10):  rate = 25/s  → mỗi 40ms 1 arrival
...
Giây 10 của spike (t=15): rate = 40/s  → mỗi 25ms 1 arrival
```

Trong vòng 10 giây, inter-arrival time giảm từ 100ms xuống 25ms — **gấp 4 lần**. Đây không phải là "từ từ".

#### Tác động lên VU pool

```
Tại t=5:  cần ceil(10 × 0.2) = 2 VU
Tại t=7:  cần ceil(16 × 0.2) = 4 VU  (tăng 2 VU trong 2 giây)
Tại t=9:  cần ceil(22 × 0.2) = 5 VU  (tăng 1 VU trong 2 giây)
Tại t=11: cần ceil(28 × 0.2) = 6 VU  (tăng 1 VU trong 2 giây)
Tại t=13: cần ceil(34 × 0.2) = 7 VU  (tăng 1 VU trong 2 giây)
Tại t=15: cần ceil(40 × 0.2) = 8 VU  (tăng 1 VU trong 2 giây)

→ Nếu preAllocatedVUs=8, không cần spawn VU nào nếu W_effective=200ms.
→ Nhưng nếu W_effective=300ms:
  Tại t=11: cần ceil(28 × 0.3) = 9 VU → spawn 1
  Tại t=13: cần ceil(34 × 0.3) = 11 VU → spawn 2 nữa
  Tại t=15: cần ceil(40 × 0.3) = 12 VU → spawn 1 nữa
  → Tổng cộng spawn 4 VU trong 4 giây, mỗi giây 1 VU.
  → Nếu spawn delay > 1 giây → drop.
```

#### Bài học

"10 giây" trong spike test không phải là "dài". Với rate tăng 3/s mỗi giây, VU demand tăng nhanh và spawn system phải theo kịp. Đây là lý do preAllocatedVUs quan trọng: nó loại bỏ nhu cầu spawn trong giai đoạn rate tăng nhanh.

### 14.4 NL4: "Rate giảm về 3/s nhưng VU vẫn còn vài chục — worker pool chưa kịp co"

#### Nghịch lý

Ở cuối test (t=25-30s), rate chỉ còn 3/s — đáng lẽ 1 VU là đủ. Nhưng chart VU count vẫn hiển thị 8-10 VU. Tại sao?

#### Cơ chế

VU không bị destroy ngay khi rate giảm. Chúng bị destroy khi:
1. Không còn iteration nào trong queue.
2. VU đã idle một khoảng thời gian (graceful shutdown period).
3. Scheduler quyết định "tôi không cần VU này nữa".

Trong thực tế, khi rate giảm từ 40/s xuống 8/s rồi 3/s:
- Các iteration được schedule ở rate cao (stage 2) vẫn đang in-flight.
- VU đang xử lý các iteration đó không thể bị destroy.
- Khi iteration hoàn thành, VU quay lại pool.
- Nếu pool có nhiều VU hơn mức cần, scheduler sẽ destroy dần.

#### Timeline VU cooldown

```
t=15.0s: rate=40/s, 16 VU active, 16 in-flight
t=17.5s: rate=32/s, 16 VU active, 12 in-flight, 4 idle → destroy 1
t=20.0s: rate=24/s, 14 VU active, 8 in-flight, 6 idle → destroy 2
t=22.5s: rate=16/s, 11 VU active, 5 in-flight, 6 idle → destroy 2
t=25.0s: rate=8/s,  9 VU active, 3 in-flight, 6 idle → destroy 1
t=27.5s: rate=5/s,  8 VU active, 1 in-flight, 7 idle
t=30.0s: rate=3/s,  8 VU active, 0 in-flight, 8 idle
→ Vẫn 8 VU vì đó là preAllocatedVUs (không bị destroy).
```

#### Hậu quả thực tế

Trong production, VU pool "chưa kịp co" có thể gây ra:
1. **Lãng phí tài nguyên:** VU chiếm memory, connection pool.
2. **Che giấu vấn đề:** Chart VU count cao không có nghĩa hệ thống đang chịu tải cao.
3. **Cascade sang test tiếp theo:** Nếu chạy nhiều test liên tiếp không nghỉ, VU pool từ test trước ảnh hưởng test sau.

#### Bài học

Khi đọc VU count chart, luôn so sánh với arrival rate chart. VU count cao + rate thấp = in-flight tail, không phải overload. Đừng hoảng hốt khi thấy "VU vẫn cao" sau spike — đó là hành vi bình thường.

---

## 15. Checklist

### 15.1 Pre-flight checklist (trước khi chạy)

- [ ] **Script syntax valid:** Chạy `k6 inspect` hoặc `k6 run --dry-run` để kiểm tra lỗi cú pháp.
- [ ] **Target URL reachable:** `curl` hoặc `wget` đến TARGET_URL để xác nhận kết nối.
- [ ] **Environment variables set:** `TARGET_URL`, `PRE_ALLOCATED_VUS`, `MAX_VUS`, `SPIKE_PEAK_RATE` nếu có override.
- [ ] **Data setup:** Nếu script cần data (product IDs, user tokens), đảm bảo data đã được seed.
- [ ] **Monitoring ready:** Dashboard (Grafana) đã được cấu hình, metrics sink đã sẵn sàng.
- [ ] **Rate limit aware:** Không chạy test spike 40/s vào production thật nếu chưa có rate limit configuration.
- [ ] **Rollback plan:** Nếu test gây outage, có kế hoạch dừng test và rollback không?
- [ ] **Stakeholder notified:** Team dev, ops, business được thông báo về thời gian test.

### 15.2 Runtime checklist (trong khi chạy)

- [ ] **VU count monitor:** Theo dõi VU count realtime — nếu chạm maxVUs, chuẩn bị tăng hoặc dừng.
- [ ] **Drop alert:** Nếu thấy dropped_iterations > 0, ghi nhận thời điểm.
- [ ] **Error rate monitor:** Nếu http_req_failed > 1%, cân nhắc dừng test.
- [ ] **Server-side metrics:** CPU, memory, connection pool của server — nếu CPU > 90%, dừng test.
- [ ] **Latency monitor:** Nếu p95 vượt ngưỡng × 2, ghi nhận để phân tích sau.

### 15.3 Post-flight checklist (sau khi chạy)

- [ ] **Summary analysis:** Đọc full summary, xác định pass/fail.
- [ ] **Drop analysis:** Nếu có drop, xác định stage, rate, VU count tại thời điểm drop.
- [ ] **Response time analysis:** So sánh p95/p99 giữa các stage và branch.
- [ ] **VU behavior analysis:** Số unplanned VU, spawn/destroy pattern, max VU reached.
- [ ] **Cart add deep-dive:** Riêng branch cart_add — p95, error rate, pattern.
- [ ] **Compare with baseline:** Nếu đã có baseline (constant rate hoặc previous run), so sánh.
- [ ] **Document findings:** Ghi lại pass criteria, findings, và action items.
- [ ] **Share results:** Gửi report cho team.
- [ ] **Cleanup:** Xóa test data nếu cần, reset environment về trạng thái trước test.

### 15.4 Spike-specific checklist

- [ ] **Spike onset check:** Có drop nào trong 3 giây đầu của spike (t=5-8s) không? → Spawn delay.
- [ ] **Spike peak check:** Có drop nào ở đỉnh spike (t=13-15s) không? → VU pool ceiling.
- [ ] **Post-spike latency check:** Response time stage 2 có cao hơn stage 1 không? → Post-spike hangover.
- [ ] **Cart add spike check:** Cart add p95 trong stage 1 có vượt 500ms không? → Write contention.
- [ ] **VU churn check:** Số unplanned VU / total VU peak > 30%? → Tăng preAllocatedVUs.
- [ ] **Cooldown check:** VU count có về gần preAllocatedVUs trong stage 3 không? → In-flight tail size.
- [ ] **Rate curve fidelity:** Actual iter/s có bám sát target curve không? → Scheduler accuracy.

---

## 16. 4-5 variations

### 16.1 Variation 1: Tăng VU Pool Size (preAllocatedVUs)

**Mục tiêu:** Loại bỏ spawn delay, test xem spike có drop không khi đủ VU ngay từ đầu.

**Config:**
```
preAllocatedVUs: 16 (tăng từ 8)
maxVUs: 50 (giữ nguyên)
startRate: 3, timeUnit: 1s
stages: giữ nguyên
```

**Dự kiến:**
- Không còn drop do spawn delay.
- VU count flat ở 16 trong suốt test (không cần spawn thêm).
- maxVUs vẫn là 50 nhưng không bao giờ chạm.

**Câu hỏi test:** "Bao nhiêu preAllocatedVUs là đủ để loại bỏ spawn hoàn toàn?"

**Cách tìm:** Tăng dần preAllocatedVUs (8 → 12 → 16 → 20) cho đến khi unplanned VU = 0.

### 16.2 Variation 2: Tăng Spike Height (peak rate)

**Mục tiêu:** Test giới hạn thực sự của hệ thống — spike cao hơn nữa.

**Config:**
```
preAllocatedVUs: 16 (đã tăng từ var 1)
maxVUs: 80 (tăng từ 50)
stages:
  - { duration: "5s",  target: 10 }
  - { duration: "10s", target: 60 }   # SPIKE: 10→60/s (tăng từ 40)
  - { duration: "10s", target: 8  }
  - { duration: "5s",  target: 3  }
```

**Dự kiến:**
- Scheduled slots ≈ 5×(3+10)/2 + 10×(10+60)/2 + 10×(60+8)/2 + 5×(8+3)/2
  = 32.5 + 350 + 340 + 27.5 = 750 iterations (tăng 36% so với base)
- Peak rate: 60/s (tăng 50% so với base)
- VU requirement (W=200ms): ceil(60 × 0.2) = 12 VU (vẫn trong preAllocatedVUs=16)
- VU requirement (W=500ms): ceil(60 × 0.5) = 30 VU (cần 14 unplanned)

**Câu hỏi test:** "Hệ thống chịu được spike cao đến đâu trước khi drop?"

**Cách tìm:** Tăng dần peak rate (40 → 50 → 60 → 80 → 100) cho đến khi thấy drop hoặc response time vượt ngưỡng.

### 16.3 Variation 3: Rút ngắn Spike Duration (sharp spike)

**Mục tiêu:** Test spike "sốc" hơn — rate tăng nhanh hơn trong thời gian ngắn hơn.

**Config:**
```
preAllocatedVUs: 16
maxVUs: 80
stages:
  - { duration: "5s",  target: 10 }
  - { duration: "5s",  target: 40 }    # SPIKE: 10→40/s trong 5s (gấp đôi tốc độ!)
  - { duration: "15s", target: 8  }
  - { duration: "5s",  target: 3  }
```

**Dự kiến:**
- Rate tăng 6/s mỗi giây (gấp đôi base: 3/s).
- Scheduled slots spike: 5×(10+40)/2 = 125 (giảm một nửa).
- Nhưng áp lực spawn cao hơn: cần VU tăng nhanh gấp đôi.
- Risk drop cao hơn dù peak rate vẫn là 40/s.

**Câu hỏi test:** "Tốc độ tăng rate ảnh hưởng đến drop như thế nào?"

**So sánh:**
| Variation | Spike duration | Rate increase/s | Scheduled in spike | Spawn pressure |
|-----------|---------------|-----------------|-------------------|----------------|
| Base | 10s | 3/s | 250 | Trung bình |
| Var 3 | 5s | 6/s | 125 | **Cao gấp đôi** |

### 16.4 Variation 4: Thay đổi Traffic Mix (nặng write hơn)

**Mục tiêu:** Test scenario campaign mà user add-to-cart nhiều hơn (chiến dịch "săn deal").

**Config:**
```
preAllocatedVUs: 16
maxVUs: 80
stages: giữ nguyên base
Branch weights:
  - product_list: 35% (giảm từ 55%)
  - cart_add: 45% (tăng từ 25%)
  - product_detail: 20% (giữ nguyên)
```

**Dự kiến:**
- Cart add trong spike: 250 × 0.45 = ~113 (tăng từ ~63).
- Write pressure tăng 79%.
- W_effective cao hơn → VU requirement cao hơn.
- Risk: lock contention nặng hơn, response time tăng phi tuyến.

**Câu hỏi test:** "Hệ thống chịu được tỉ lệ write cao đến đâu trong spike?"

**So sánh:**
| Variation | Cart add % | Cart add trong spike | Write pressure |
|-----------|-----------|---------------------|----------------|
| Base | 25% | ~63 | Baseline |
| Var 4 | 45% | ~113 | **+79%** |

### 16.5 Variation 5: Multiple Spike Campaigns (double spike)

**Mục tiêu:** Test scenario 2 đợt flash sale liên tiếp (sáng 10h, chiều 15h).

**Config:**
```
preAllocatedVUs: 16
maxVUs: 100
stages:
  - { duration: "5s",  target: 10 }
  - { duration: "10s", target: 40 }    # Spike 1
  - { duration: "5s",  target: 5  }    # Nghỉ giữa
  - { duration: "10s", target: 40 }    # Spike 2
  - { duration: "10s", target: 8  }
  - { duration: "5s",  target: 3  }
```

**Dự kiến:**
- Tổng thời gian: 45s (dài hơn base 30s).
- Scheduled slots spike 1: 250, spike 2: ~225, tổng 2 spike: 475.
- Risk đặc biệt: in-flight tail từ spike 1 ảnh hưởng spike 2.
- Nếu spike 2 bắt đầu khi VU từ spike 1 chưa kịp co → VU demand spike 2 = VU residual + VU mới.

**Câu hỏi test:** "Hệ thống có phục hồi kịp giữa 2 spike không?"

**Timeline:**
```
t=0-5s:   Pre-spike 1
t=5-15s:  Spike 1 (10→40/s)
t=15-20s: Nghỉ (40→5/s) ← Chỉ 5 giây để phục hồi!
t=20-30s: Spike 2 (5→40/s)
t=30-40s: Post-spike 2
t=40-45s: Cooldown
```

---

## 17. Anti-patterns (mở rộng)

### 17.1 AP1: Dùng average rate để sizing

**Anti-pattern:**
```
"Average rate là 18.3/s, vậy mình set maxVUs = ceil(18.3 × 0.2) = 4 VU là đủ."
```

**Tại sao sai:** Average rate là 18.3/s nhưng peak rate là 40/s. Nếu chỉ có 4 VU, capacity = 4/0.2 = 20/s → drop 50% iterations trong spike.

**Cách đúng:** Luôn size cho peak rate: `maxVUs >= ceil(peak_rate × W_effective_max) × 1.3` (30% safety margin).

### 17.2 AP2: preAllocatedVUs = maxVUs

**Anti-pattern:**
```
preAllocatedVUs: 50
maxVUs: 50
```

**Tại sao sai:** Không có room cho unplanned VU nếu cần. Nếu W_effective tăng đột biến (lock contention), VU demand vượt 50 → drop ngay lập tức. Ngoài ra, allocate 50 VU từ đầu lãng phí tài nguyên.

**Cách đúng:** preAllocatedVUs nên đủ cho expected demand, maxVUs nên có margin:
```
preAllocatedVUs = ceil(peak_rate × W_effective_expected) × 1.2
maxVUs = ceil(peak_rate × W_effective_worst_case) × 1.5
```

### 17.3 AP3: Bỏ qua cart add performance

**Anti-pattern:**
```
"Cart add chỉ chiếm 25% traffic, không cần tối ưu quá."
```

**Tại sao sai:** 25% traffic nhưng cart add chậm gấp 5-10 lần read. Nó có thể chiếm 50-70% VU time trong spike. Nếu cart add chậm, nó kéo cả hệ thống xuống.

**Cách đúng:** Luôn test cart add riêng (100% cart add) để biết baseline, rồi mới test mix.

### 17.4 AP4: Không test với production-like data

**Anti-pattern:**
```
"Test trên staging với 100 sản phẩm, production có 1 triệu sản phẩm."
```

**Tại sao sai:** DB performance khác biệt rất lớn giữa 100 rows và 1 triệu rows. Index hoạt động khác, lock contention khác, cache hit rate khác.

**Cách đúng:** Staging nên có data volume tương đương production, hoặc ít nhất 50% volume.

### 17.5 AP5: Chỉ nhìn average response time

**Anti-pattern:**
```
"Average response time = 85ms → hệ thống ổn."
```

**Tại sao sai:** Average bị kéo xuống bởi các request nhanh. Trong spike, p99 có thể là 2000ms dù average chỉ 85ms. User gặp p99 sẽ bỏ đi.

**Cách đúng:** Luôn nhìn p95 và p99. p95 < 500ms, p99 < 1000ms.

### 17.6 AP6: Chạy test 1 lần rồi kết luận

**Anti-pattern:**
```
"Pass rồi → deploy thôi."
```

**Tại sao sai:** Performance test có tính stochastic (ngẫu nhiên). Một lần pass có thể do may mắn (cache warm, không có GC pause, network ổn định). Lần sau có thể fail.

**Cách đúng:** Chạy ít nhất 3 lần. Nếu 3 lần đều pass → confidence cao. Nếu 1/3 fail → điều tra.

### 17.7 AP7: Tăng maxVUs vô tội vạ

**Anti-pattern:**
```
"Có drop → tăng maxVUs lên 200."
```

**Tại sao sai:** Drop có thể không phải do thiếu VU mà do spawn delay (RC2) hoặc cart add quá chậm (RC3). Tăng maxVUs không giải quyết được gốc rễ. Hơn nữa, quá nhiều VU gây áp lực lên chính máy chạy k6 (CPU, memory).

**Cách đúng:** Chẩn đoán nguyên nhân drop trước khi tăng maxVUs.

### 17.8 AP8: Không test cooldown behavior

**Anti-pattern:**
```
"Chỉ quan tâm spike, không quan tâm post-spike."
```

**Tại sao sai:** Post-spike behavior quan trọng không kém spike. Nếu hệ thống không phục hồi được sau spike (memory leak, connection pool cạn), lần spike tiếp theo sẽ fail.

**Cách đúng:** Luôn kiểm tra response time và resource usage trong ít nhất 30 giây sau spike.

---

## 18. Reference

### 18.1 Related documentation

| Document | Path | Relation |
|----------|------|----------|
| Ramping-Arrival-Rate Executor Guide | `docs/executors/ramping-arrival-rate.md` | Cơ chế executor |
| Case 01 — Ramping-Arrival-Rate Basics | `docs/practice/ramping-arrival-rate/01_basics.md` | Case cơ bản, nên đọc trước case này |
| Open vs Closed Model | `docs/concepts/open-vs-closed-model.md` | Hiểu sâu về open model |
| VU Lifecycle & Iteration Counters | `docs/20260114_00_vu-lifecycle-and-iteration-counters.md` | Cách VU được spawn/destroy |
| Custom Metrics Guide | `docs/custom-metrics.md` | Cách tạo và dùng custom metrics |
| Dashboard Setup | `docs/dashboard-setup.md` | Cấu hình Grafana dashboard cho k6 |

### 18.2 Backend script reference

```
File: E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-campaign-ingress-spike.js
```

Script sử dụng helper pattern:

```js
import { buildRampingArrivalScenario } from './helpers/ramping-arrival-helper.js';

export const options = buildRampingArrivalScenario(
  'campaignIngressSpike',  // scenario name
  3,                        // startRate
  '1s',                     // timeUnit
  [                         // stages
    { duration: '5s', target: 10 },
    { duration: '10s', target: 40 },
    { duration: '10s', target: 8 },
    { duration: '5s', target: 3 },
  ],
  8,                        // preAllocatedVUs
  50,                       // maxVUs
  {                         // extra tags
    case_id: 'rar-02-campaign-ingress-spike',
    business_case: 'campaign_ingress_spike',
  }
);
```

### 18.3 Key formulas (quick reference)

```
# Scheduled slots per stage
slots = duration × (rate_start + rate_end) / 2

# VU requirement
required_vus = ceil(peak_rate × W_effective)

# VU capacity
capacity = VU_count / W_effective

# Inter-arrival time
t_interval = 1 / rate

# Rate at time t in linear ramp
λ(t) = rate_start + (rate_end - rate_start) × (t - stage_start) / duration

# Spawn pressure
spawn_count = max(0, required_vus_at_peak - preAllocatedVUs)
spawn_rate = spawn_count / spike_duration

# Drop risk
risk = f(spawn_pressure, spawn_delay, arrival_rate_increase_rate)
high_risk = spawn_pressure > 0.5 AND spawn_delay > 100ms
```

### 18.4 Configuration summary

| Parameter | Value | Notes |
|-----------|-------|-------|
| executor | ramping-arrival-rate | Open model với variable rate |
| startRate | 3 | Arrivals/giây ban đầu |
| timeUnit | 1s | Đơn vị thời gian của rate |
| stages | 4 stages, 30s total | Pre-spike → Spike → Post-spike → Cooldown |
| preAllocatedVUs | 8 | VU khởi tạo sẵn |
| maxVUs | 50 | Giới hạn VU pool |
| gracefulStop | default (30s) | Thời gian chờ iteration đang chạy hoàn thành |
| startTime | 0s | Bắt đầu ngay |
| gracefulRampDown | default | VU giảm từ từ |

### 18.5 Stage math summary

| Stage | Duration | Rate range | Avg rate | Scheduled slots | % Total |
|-------|----------|------------|----------|-----------------|---------|
| 0 (pre-spike) | 5s | 3 → 10/s | 6.5/s | 32.5 | 5.9% |
| 1 (spike) | 10s | 10 → 40/s | 25/s | 250 | 45.5% |
| 2 (post-spike) | 10s | 40 → 8/s | 24/s | 240 | 43.6% |
| 3 (cooldown) | 5s | 8 → 3/s | 5.5/s | 27.5 | 5.0% |
| **Total** | **30s** | **3 → 40 → 3** | **18.33/s** | **~550** | **100%** |

### 18.6 Quick decision matrix

| Vấn đề | Triệu chứng | Hành động |
|--------|-------------|-----------|
| Spawn delay drop | Drop in t=6-10s, vus < maxVUs | Tăng preAllocatedVUs |
| VU ceiling drop | Drop in t=12-15s, vus == maxVUs | Tăng maxVUs |
| Cart add slow | p95 cart_add > 500ms | Tối ưu DB, tăng connection pool |
| Post-spike hangover | RT stage 2 > stage 1 | Tăng connection pool, GC tuning |
| General overload | Drop everywhere, all metrics bad | Scale out server, tối ưu code |
| All pass | 0 drop, RT OK | GO — sẵn sàng production |

---

*Tài liệu này là một phần của series thực hành k6. Case tiếp theo: [Case 03 — Constant Arrival Rate với Mixed Workload](03_constant-arrival-rate-mixed.md).*
